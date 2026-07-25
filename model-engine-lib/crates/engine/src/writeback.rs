//! Host data feeds and projection for writeback columns.
//!
//! A [`WritebackColumn`](engine_core::model::WritebackColumn) synthesizes two
//! `is_writeback_store` tables at model build (see `engine-core`'s
//! `reconcile_writeback_model`): the append-only HISTORY table and the
//! one-row-per-key CURRENT table the generated lookup column reads. Their
//! data never comes from a connector — the HOST feeds the history (its
//! submission stores, governance, and transport live host-side) through
//! [`Engine::set_writeback_data`], the exact analogue of
//! [`Engine::store_calculated_table_snapshot`] for calculated tables, and the
//! engine derives the CURRENT store from it per the column's projection
//! policy ([`Engine::project_writeback_current`]).

use std::collections::HashMap;
use std::sync::Arc;

use arrow::record_batch::RecordBatch;
use tokio_util::sync::CancellationToken;

use crate::{
    ColumnRef, Engine, EngineError, EngineResult, Measure, QueryRequest, WritebackColumnKind,
    WritebackProjection,
};

/// Which synthesized store table of a writeback column a feed targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WritebackSlot {
    /// The append-only submission history (`__wb_{id}_hist`): key columns +
    /// value + submitter_id + submitter_name + submitted_at + state.
    History,
    /// The projected display values (`__wb_{id}`): key columns + value, at
    /// most one row per key (the host's projection policy decides which).
    Current,
}

impl Engine {
    /// Resolve a writeback column id + slot to the synthesized store table's
    /// model name, verifying the column exists and the table is a store.
    fn writeback_slot_table(
        &self,
        writeback_id: &str,
        slot: WritebackSlot,
    ) -> EngineResult<String> {
        let wb = self
            .model
            .writeback_columns()
            .iter()
            .find(|w| w.id() == writeback_id)
            .ok_or_else(|| {
                EngineError::InvalidData(format!(
                    "no writeback column with id '{writeback_id}' in the model"
                ))
            })?;
        let name = match slot {
            WritebackSlot::History => wb.history_table_name(),
            WritebackSlot::Current => wb.current_table_name(),
        };
        // The store table is synthesized whenever the definition exists, so a
        // miss here means the model was mutated without reconcile — fail loud.
        let table = self.model.table(&name)?;
        if !table.is_writeback_store() {
            return Err(EngineError::InvalidData(format!(
                "table '{name}' is not a writeback store — the model is inconsistent"
            )));
        }
        Ok(name)
    }

    /// The Arrow schema a [`set_writeback_data`](Self::set_writeback_data)
    /// batch must match for one writeback column + slot. Hosts build their
    /// feed batches against this so column order/type drift is impossible.
    pub fn writeback_slot_schema(
        &self,
        writeback_id: &str,
        slot: WritebackSlot,
    ) -> EngineResult<arrow::datatypes::Schema> {
        let name = self.writeback_slot_table(writeback_id, slot)?;
        Ok(self.model.table(&name)?.to_arrow_schema())
    }

    /// Replace one writeback store table's data with a host-computed batch.
    ///
    /// The batch's column names must match the synthesized store schema
    /// exactly (same check as calculated-table snapshots — a mismatch is
    /// rejected so the store never serves rows its declared columns no longer
    /// match). An empty batch (or zero rows) clears the store to an empty
    /// table. Routes through the same optimize/store/query-cache-invalidate
    /// path as a connector refresh, so dependent queries and the generated
    /// lookup column pick the new data up immediately.
    pub fn set_writeback_data(
        &mut self,
        writeback_id: &str,
        slot: WritebackSlot,
        batch: RecordBatch,
    ) -> EngineResult<()> {
        let name = self.writeback_slot_table(writeback_id, slot)?;
        let declared: Vec<String> = self
            .model
            .table(&name)?
            .columns()
            .iter()
            .map(|c| c.name().to_string())
            .collect();
        let supplied: Vec<String> = batch
            .schema()
            .fields()
            .iter()
            .map(|f| f.name().to_string())
            .collect();
        if supplied != declared {
            return Err(EngineError::InvalidData(format!(
                "writeback feed for '{name}' has columns {supplied:?} but the store declares \
                 {declared:?} — build the batch against Engine::writeback_slot_schema"
            )));
        }
        let batches = if batch.num_rows() == 0 {
            Vec::new()
        } else {
            vec![batch]
        };
        self.store_refreshed_table(&name, batches).map(|_| ())
    }

    /// Recompute one writeback column's CURRENT store from its HISTORY store
    /// per the column's projection policy:
    ///
    /// - `Latest` — latest applicable entry per key (by `submitted_at`, ISO
    ///   string order): `state` in `submitted`/`approved` for a History
    ///   column, `approved` only for MasterData. A winning entry with a NULL
    ///   `value` (a cleared cell) removes the key.
    /// - `Blank` — like `Latest`, but restricted to entries at/after
    ///   `session_floor` (the host's "this session" boundary, ISO timestamp)
    ///   so in-session edits show while a reload starts blank. `None` clears
    ///   the current store entirely.
    /// - `Expression(text)` — the designer's aggregation expression evaluated
    ///   per key over the history via the ordinary query pipeline. The text
    ///   references the history table as `history[...]` (rewritten to the
    ///   synthesized table name before parsing), e.g. `MAX(history[value])`
    ///   or `AVERAGEX(history, history[value])` — whatever the measure
    ///   grammar supports. `session_floor` is ignored (the expression sees
    ///   the full history).
    ///
    /// An uncached history store counts as empty. The result replaces the
    /// current store through the same optimize/store/invalidate path as any
    /// refresh, so the generated lookup column picks it up immediately.
    pub async fn project_writeback_current(
        &mut self,
        writeback_id: &str,
        session_floor: Option<&str>,
    ) -> EngineResult<()> {
        let wb = self
            .model
            .writeback_columns()
            .iter()
            .find(|w| w.id() == writeback_id)
            .ok_or_else(|| {
                EngineError::InvalidData(format!(
                    "no writeback column with id '{writeback_id}' in the model"
                ))
            })?
            .clone();
        let hist_name = wb.history_table_name();
        let cur_name = wb.current_table_name();
        if self.cache.get(&hist_name).is_none() {
            self.store_refreshed_table(&hist_name, Vec::new())?;
        }

        match wb.projection().clone() {
            WritebackProjection::Blank => {
                let batches = match session_floor {
                    None => Vec::new(),
                    Some(floor) => self.latest_per_key(&wb, &hist_name, &cur_name, Some(floor))?,
                };
                self.store_refreshed_table(&cur_name, batches).map(|_| ())
            }
            WritebackProjection::Latest => {
                let batches = self.latest_per_key(&wb, &hist_name, &cur_name, None)?;
                self.store_refreshed_table(&cur_name, batches).map(|_| ())
            }
            WritebackProjection::Expression(text) => {
                self.project_writeback_expression(&wb, &hist_name, &cur_name, &text)
                    .await
            }
        }
    }

    /// Latest-per-key projection over the cached history batch, computed in
    /// Rust (the history is small — one row per submission). Returns the
    /// batches for the current store (empty = no applicable entries).
    fn latest_per_key(
        &self,
        wb: &crate::WritebackColumn,
        hist_name: &str,
        cur_name: &str,
        floor: Option<&str>,
    ) -> EngineResult<Vec<RecordBatch>> {
        use arrow::array::StringArray;
        use arrow::util::display::array_value_to_string;

        let Some(hist) = self.cache.get(hist_name) else {
            return Ok(Vec::new());
        };
        if hist.num_rows() == 0 {
            return Ok(Vec::new());
        }
        let schema = hist.schema();
        let idx_of = |name: &str| {
            schema
                .index_of(name)
                .map_err(|_| EngineError::InvalidData(format!("history store lacks '{name}'")))
        };
        let value_i = idx_of("value")?;
        let submitted_i = idx_of("submitted_at")?;
        let state_i = idx_of("state")?;
        let key_is: Vec<usize> = wb
            .key_columns()
            .iter()
            .map(|k| idx_of(k))
            .collect::<EngineResult<_>>()?;

        // `state`/`submitted_at` may be dictionary-encoded after batch
        // optimization — render both via the generic display path.
        let state_of = |row: usize| -> String {
            let col = hist.column(state_i);
            if let Some(s) = col.as_any().downcast_ref::<StringArray>() {
                s.value(row).to_string()
            } else {
                array_value_to_string(col, row).unwrap_or_default()
            }
        };
        let submitted_of = |row: usize| -> String {
            let col = hist.column(submitted_i);
            if let Some(s) = col.as_any().downcast_ref::<StringArray>() {
                s.value(row).to_string()
            } else {
                array_value_to_string(col, row).unwrap_or_default()
            }
        };

        // Winner per composite key: max submitted_at among applicable states
        // (ties resolve to the LATER row — feed order is append order).
        let mut winner: HashMap<String, usize> = HashMap::new();
        let mut winner_stamp: HashMap<String, String> = HashMap::new();
        for row in 0..hist.num_rows() {
            let state = state_of(row);
            let applicable = match wb.kind() {
                WritebackColumnKind::MasterData => state == "approved",
                WritebackColumnKind::History => state == "submitted" || state == "approved",
            };
            if !applicable {
                continue;
            }
            let stamp = submitted_of(row);
            if let Some(floor) = floor {
                if stamp.as_str() < floor {
                    continue;
                }
            }
            let mut key = String::new();
            for &ki in &key_is {
                key.push_str(&array_value_to_string(hist.column(ki), row).unwrap_or_default());
                key.push('\u{1f}');
            }
            match winner_stamp.get(&key) {
                Some(best) if best.as_str() > stamp.as_str() => {}
                _ => {
                    winner_stamp.insert(key.clone(), stamp);
                    winner.insert(key, row);
                }
            }
        }

        // Keep winners whose value is present (a NULL winner = cleared key).
        let mut rows: Vec<u64> = winner
            .into_values()
            .filter(|&row| hist.column(value_i).is_valid(row))
            .map(|r| r as u64)
            .collect();
        rows.sort_unstable();
        if rows.is_empty() {
            return Ok(Vec::new());
        }

        let indices = arrow::array::UInt64Array::from(rows);
        let target = Arc::new(self.model.table(cur_name)?.to_arrow_schema());
        let mut columns = Vec::with_capacity(target.fields().len());
        for field in target.fields() {
            let src_i = idx_of(field.name())?;
            let taken = arrow::compute::take(hist.column(src_i), &indices, None)
                .map_err(|e| EngineError::InvalidData(e.to_string()))?;
            let cast = arrow::compute::cast(&taken, field.data_type())
                .map_err(|e| EngineError::InvalidData(e.to_string()))?;
            columns.push(cast);
        }
        let batch = RecordBatch::try_new(target, columns)
            .map_err(|e| EngineError::InvalidData(e.to_string()))?;
        Ok(vec![batch])
    }

    /// Expression projection: run the designer's aggregation expression per
    /// key over the history table through the ordinary query pipeline (same
    /// overlay-measure mechanism as calculated-table materialization) and
    /// store the conformed result as the current store.
    async fn project_writeback_expression(
        &mut self,
        wb: &crate::WritebackColumn,
        hist_name: &str,
        cur_name: &str,
        text: &str,
    ) -> EngineResult<()> {
        let fail = |reason: String| {
            EngineError::InvalidData(format!(
                "writeback column '{}' expression projection: {reason}",
                wb.name()
            ))
        };

        // The designer references the history table as `history[...]`;
        // rewrite (case-insensitive) to the synthesized name before parsing.
        let rewritten = rewrite_history_refs(text, hist_name);
        let expression = crate::parse_measure_expression(&rewritten)
            .map_err(|e| fail(format!("cannot parse expression: {e}")))?;

        let measure_name = format!("__wb_project__{}", wb.id());
        let overlay = self
            .model
            .with_overlay_measures(vec![Measure::new(&measure_name, expression)])
            .map_err(|e| fail(e.to_string()))?;

        let request = QueryRequest {
            measures: vec![measure_name.clone()],
            group_by: wb
                .key_columns()
                .iter()
                .map(|k| ColumnRef::new(hist_name.to_string(), k.clone()))
                .collect(),
            ..Default::default()
        };
        let batches = self
            .plan_and_execute(&request, &request, &overlay, &[], &CancellationToken::new())
            .await
            .map_err(|e| fail(e.to_string()))?;

        // Conform to the current store's declared schema: key columns by
        // name, the measure result as `value` (cast to the declared type).
        let target = Arc::new(self.model.table(cur_name)?.to_arrow_schema());
        let mut conformed = Vec::with_capacity(batches.len());
        for batch in &batches {
            if batch.num_rows() == 0 {
                continue;
            }
            let mut columns = Vec::with_capacity(target.fields().len());
            for field in target.fields() {
                let source_name = if field.name() == "value" {
                    measure_name.as_str()
                } else {
                    field.name().as_str()
                };
                let index = batch
                    .schema()
                    .index_of(source_name)
                    .map_err(|_| fail(format!("result is missing column '{source_name}'")))?;
                let cast = arrow::compute::cast(batch.column(index), field.data_type())
                    .map_err(|e| fail(format!("cannot cast '{source_name}': {e}")))?;
                columns.push(cast);
            }
            conformed.push(
                RecordBatch::try_new(Arc::clone(&target), columns)
                    .map_err(|e| fail(e.to_string()))?,
            );
        }
        self.store_refreshed_table(cur_name, conformed).map(|_| ())
    }
}

/// Case-insensitively rewrite `history[` table references to the synthesized
/// history-table name, and the bare table argument `history` in table-valued
/// positions (`history,` / `history)`) likewise — so designer expressions
/// like `MAX(history[value])` or `COUNTROWS(history)` are stable across the
/// internal naming scheme.
fn rewrite_history_refs(text: &str, hist_name: &str) -> String {
    let mut out = String::with_capacity(text.len() + 16);
    let bytes = text.as_bytes();
    let lower = text.to_ascii_lowercase();
    let needle = "history";
    let mut i = 0;
    while i < text.len() {
        if lower[i..].starts_with(needle) {
            // A word boundary on both sides makes it the history identifier.
            let before_ok = i == 0
                || !(bytes[i - 1].is_ascii_alphanumeric()
                    || bytes[i - 1] == b'_'
                    || bytes[i - 1] == b'[');
            let end = i + needle.len();
            let after_ok =
                end >= text.len() || !(bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_');
            if before_ok && after_ok {
                out.push_str(hist_name);
                i = end;
                continue;
            }
        }
        let ch = &text[i..].chars().next().unwrap();
        out.push(*ch);
        i += ch.len_utf8();
    }
    out
}

#[cfg(test)]
mod rewrite_tests {
    use super::rewrite_history_refs;

    #[test]
    fn rewrites_word_boundary_only() {
        assert_eq!(
            rewrite_history_refs("MAX(history[value])", "__wb_x_hist"),
            "MAX(__wb_x_hist[value])"
        );
        assert_eq!(
            rewrite_history_refs("COUNTROWS(History)", "__wb_x_hist"),
            "COUNTROWS(__wb_x_hist)"
        );
        // Not a standalone identifier: untouched.
        assert_eq!(
            rewrite_history_refs("MAX(order_history[v])", "__wb_x_hist"),
            "MAX(order_history[v])"
        );
        assert_eq!(
            rewrite_history_refs("MAX(historyx[v])", "__wb_x_hist"),
            "MAX(historyx[v])"
        );
    }
}
