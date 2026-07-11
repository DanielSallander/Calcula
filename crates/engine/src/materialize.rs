//! Materialization of calculated tables.
//!
//! A model calculated table (engine struct: `GlobalVariable`) with
//! `dynamic == false` is backed by a real, derived model [`Table`] (marked
//! `is_calculated`, synthesized at model build/mutation time from the QUERY's
//! inferred output schema). This module produces its DATA: the QUERY is
//! evaluated over the **unfiltered** model — no slicers, no group axis beyond
//! the QUERY's own BY columns, and **no RLS role** (there is no user at
//! refresh time; role filters may instead target the derived table like any
//! table) — and the result is stored as the table's in-memory batch.
//!
//! Execution reuses the ordinary query machinery end to end: each QUERY
//! aggregate becomes an ephemeral overlay measure (same overlay mechanism as
//! calculation groups), the BY columns become the group-by axis, and
//! `plan_and_execute` runs the normal plan → fetch → evaluate pipeline
//! (joins, relationship navigation, pushdown included). The result batches
//! are then conformed to the derived table's declared schema — columns
//! renamed to the QUERY aliases and cast to the inferred types — and stored
//! through the same optimize/sort/cache path as a connector refresh.

use std::sync::Arc;

use arrow::record_batch::RecordBatch;
use engine_core::model::global_variable::GlobalVariable;
use tokio_util::sync::CancellationToken;

use crate::{
    ColumnRef, Engine, EngineError, EngineResult, Expression, Measure, OptimizationStats,
    QueryRequest,
};

impl Engine {
    /// Evaluate a materialized calculated table's QUERY over the model and
    /// store the result as the derived table's in-memory data.
    ///
    /// The tables the QUERY reads from must be queryable first (cached for
    /// `InMemory` tables, connected for `DirectQuery`) — [`refresh_stale`]
    /// (Self::refresh_stale) orders this automatically. Errors if `name` is
    /// not a calculated table or is dynamic (dynamic calculated tables are
    /// evaluated per query and never materialized).
    pub async fn materialize_calculated_table(&mut self, name: &str) -> EngineResult<()> {
        self.materialize_calculated_table_inner(name).await.map(|_| ())
    }

    /// Materialize every materialized calculated table, in dependency order
    /// (model table order — the builder appends each derived table after the
    /// tables it reads from). Returns the names materialized. Fails fast on
    /// the first error; [`refresh_stale`](Self::refresh_stale) is the
    /// failure-accumulating alternative.
    pub async fn materialize_calculated_tables(&mut self) -> EngineResult<Vec<String>> {
        let names: Vec<String> = self
            .model
            .tables()
            .iter()
            .filter(|t| t.is_calculated())
            .map(|t| t.name().to_string())
            .collect();
        for name in &names {
            self.materialize_calculated_table_inner(name).await?;
        }
        Ok(names)
    }

    /// Restore a materialized calculated table's data from a SNAPSHOT batch —
    /// e.g. one carried inside a `.calp` package — instead of evaluating its
    /// QUERY (which may be impossible on a subscriber without source access).
    /// The batch is stored through the same optimize/sort/cache path as a
    /// refresh; a later `refresh_stale`/materialization simply replaces it.
    pub fn store_calculated_table_snapshot(
        &mut self,
        name: &str,
        batch: RecordBatch,
    ) -> EngineResult<()> {
        let table = self.model.table(name)?;
        if !table.is_calculated() {
            return Err(EngineError::MaterializationFailed {
                name: name.to_string(),
                reason: "not a calculated table — snapshots can only restore derived tables"
                    .to_string(),
            });
        }
        self.store_refreshed_table(name, vec![batch]).map(|_| ())
    }

    pub(crate) async fn materialize_calculated_table_inner(
        &mut self,
        name: &str,
    ) -> EngineResult<OptimizationStats> {
        let gv: GlobalVariable = self.model.global_variable(name)?.clone();
        if gv.is_dynamic() {
            return Err(EngineError::MaterializationFailed {
                name: name.to_string(),
                reason: "the calculated table is dynamic (evaluated per query); only \
                         materialized (Dynamic = no) calculated tables can be materialized"
                    .to_string(),
            });
        }

        // Generated calendar: build the rows directly — no query needed. The
        // derived table (synthesized at build) declares the fixed schema.
        if let Some(spec) = gv.calendar() {
            let schema = Arc::new(self.model.table(name)?.to_arrow_schema());
            let batch = build_calendar_batch(spec, schema).map_err(|reason| {
                EngineError::MaterializationFailed {
                    name: name.to_string(),
                    reason,
                }
            })?;
            return self.store_refreshed_table(name, vec![batch]);
        }

        let Expression::Query {
            aggregates,
            group_by,
        } = gv.expression().clone()
        else {
            return Err(EngineError::MaterializationFailed {
                name: name.to_string(),
                reason: "not a QUERY(...) expression".to_string(),
            });
        };

        // One ephemeral overlay measure per QUERY aggregate (the overlay is a
        // model clone — self.model is untouched). The synthetic names only
        // live inside this request.
        let mut synthetic = Vec::new();
        let mut column_sources: Vec<(String, String)> = Vec::new(); // (target col, result col)
        for (table, column) in &group_by {
            let _ = table;
            column_sources.push((column.clone(), column.clone()));
        }
        for (i, (expr, alias)) in aggregates.iter().enumerate() {
            let measure_name = format!("__materialize__{name}__{i}");
            synthetic.push(Measure::new(&measure_name, expr.clone()));
            column_sources.push((alias.clone(), measure_name.clone()));
        }
        // The DISTINCT form has no aggregates: inject a hidden COUNTROWS so
        // the grouped query executes; the conform step below drops it
        // (column_sources lists only the BY columns).
        if aggregates.is_empty() {
            let Some((first_table, _)) = group_by.first() else {
                return Err(EngineError::MaterializationFailed {
                    name: name.to_string(),
                    reason: "QUERY(DISTINCT ...) has no columns".to_string(),
                });
            };
            synthetic.push(Measure::new(
                format!("__materialize__{name}__distinct"),
                Expression::Aggregate {
                    operation: crate::AggregateOp::CountRows,
                    operand: Box::new(Expression::TableRef(first_table.clone())),
                },
            ));
        }
        let measure_names: Vec<String> = synthetic.iter().map(|m| m.name().to_string()).collect();
        let overlay = self
            .model
            .with_overlay_measures(synthetic)
            .map_err(|e| EngineError::MaterializationFailed {
                name: name.to_string(),
                reason: e.to_string(),
            })?;

        let request = QueryRequest {
            measures: measure_names,
            group_by: group_by
                .iter()
                .map(|(table, column)| ColumnRef::new(table.clone(), column.clone()))
                .collect(),
            ..Default::default()
        };

        // No role filters: materialization sees the unfiltered model (same
        // posture as Power BI calculated tables — RLS applies to the derived
        // table at query time, not at refresh).
        let batches = self
            .plan_and_execute(&request, &request, &overlay, &[], &CancellationToken::new())
            .await
            .map_err(|e| EngineError::MaterializationFailed {
                name: name.to_string(),
                reason: e.to_string(),
            })?;

        // Conform to the derived table's declared schema: select result
        // columns by name, cast to the inferred types, rename to the aliases.
        let target_schema = Arc::new(self.model.table(name)?.to_arrow_schema());
        let mut conformed = Vec::with_capacity(batches.len());
        for batch in &batches {
            let mut columns = Vec::with_capacity(target_schema.fields().len());
            for (field, (_, result_name)) in target_schema.fields().iter().zip(&column_sources) {
                let index = batch.schema().index_of(result_name).map_err(|_| {
                    EngineError::MaterializationFailed {
                        name: name.to_string(),
                        reason: format!(
                            "result is missing expected column '{result_name}' (have: {:?})",
                            batch
                                .schema()
                                .fields()
                                .iter()
                                .map(|f| f.name().clone())
                                .collect::<Vec<_>>()
                        ),
                    }
                })?;
                let cast = arrow::compute::cast(batch.column(index), field.data_type()).map_err(
                    |e| EngineError::MaterializationFailed {
                        name: name.to_string(),
                        reason: format!(
                            "cannot cast result column '{result_name}' to declared type \
                             {:?}: {e}",
                            field.data_type()
                        ),
                    },
                )?;
                columns.push(cast);
            }
            conformed.push(
                RecordBatch::try_new(Arc::clone(&target_schema), columns).map_err(|e| {
                    EngineError::MaterializationFailed {
                        name: name.to_string(),
                        reason: e.to_string(),
                    }
                })?,
            );
        }

        self.store_refreshed_table(name, conformed)
    }
}

const MONTH_NAMES: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

/// Generate a `CALENDAR(start, end)` batch: one row per day, with the fixed
/// calendar schema (declared by the derived table synthesized at build) —
/// date, year, quarter, month, month_name, day, day_of_week (ISO, 1 = Monday).
fn build_calendar_batch(
    spec: &engine_core::model::global_variable::CalendarSpec,
    schema: Arc<arrow::datatypes::Schema>,
) -> Result<RecordBatch, String> {
    use arrow::array::{Date32Array, Int64Array, StringArray};
    use engine_core::model::global_variable::civil_from_days;

    spec.validate()?;
    let (start, end) = spec
        .day_range()
        .ok_or_else(|| "calendar dates failed to parse".to_string())?;

    let len = (end - start + 1) as usize;
    let mut dates = Vec::with_capacity(len);
    let mut years = Vec::with_capacity(len);
    let mut quarters = Vec::with_capacity(len);
    let mut months = Vec::with_capacity(len);
    let mut month_names = Vec::with_capacity(len);
    let mut days = Vec::with_capacity(len);
    let mut weekdays = Vec::with_capacity(len);
    for d in start..=end {
        let (year, month, day) = civil_from_days(d);
        dates.push(d as i32);
        years.push(year);
        quarters.push(i64::from((month - 1) / 3 + 1));
        months.push(i64::from(month));
        month_names.push(MONTH_NAMES[(month - 1) as usize]);
        days.push(i64::from(day));
        // 1970-01-01 (day 0) was a Thursday; ISO weekday Monday = 1.
        weekdays.push((d + 3).rem_euclid(7) + 1);
    }

    RecordBatch::try_new(
        schema,
        vec![
            Arc::new(Date32Array::from(dates)),
            Arc::new(Int64Array::from(years)),
            Arc::new(Int64Array::from(quarters)),
            Arc::new(Int64Array::from(months)),
            Arc::new(StringArray::from(month_names)),
            Arc::new(Int64Array::from(days)),
            Arc::new(Int64Array::from(weekdays)),
        ],
    )
    .map_err(|e| e.to_string())
}
