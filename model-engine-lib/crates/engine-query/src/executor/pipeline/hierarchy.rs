//! Hierarchy ragged-behavior execution: level-transform SQL for the local
//! aggregation statement and the post-aggregation HideMembers filter.
//!
//! See the planner-side `planner::pushdown::hierarchy` module docs for the
//! full ragged-behavior contract. Summary of what executes here:
//!
//! - Stopper values are normalized to NULL via `NULLIF` before grouping
//!   (every behavior).
//! - **RepeatParent** groups on `COALESCE(level_i, …, level_0)`.
//! - **ShowAsLeaf** fills interior gaps like RepeatParent but leaves
//!   trailing blanks NULL (the branch ends at its deepest real level within
//!   the queried depth).
//! - **HideMembers** filters result rows whose value at any included level
//!   is NULL — applied post-aggregation at the Arrow level, with ROLLUP
//!   subtotal rows exempt for the levels they roll up (`__grouping_id`).

use arrow::array::{Array, BooleanArray, Int32Array};
use arrow::compute::{filter_record_batch, is_not_null, or};
use arrow::record_batch::RecordBatch;

use engine_core::compute::sql_util::quote_ident_double;
use engine_core::model::RaggedBehavior;

use crate::error::{QueryError, QueryResult};
use crate::planner::HierarchySpec;
use crate::request::{ColumnRef, GROUPING_ID_COLUMN};

/// Typed error for query shapes that do not support ragged-hierarchy
/// transforms yet (mirrors `totals_unsupported`).
///
/// Erroring is deliberate: the specialized two-stage paths assemble their
/// results outside the main SQL statement, so silently skipping the
/// transforms would return raw (untransformed/unfiltered) level values.
pub(super) fn hierarchy_unsupported(what: &str) -> QueryError {
    QueryError::InvalidQuery(format!(
        "hierarchy ragged behavior (HideMembers/RepeatParent/ShowAsLeaf or stopper \
         values) is not supported with {what} yet"
    ))
}

/// SQL for a level value with its stopper normalized to NULL.
fn nullified_sql(spec: &HierarchySpec, index: usize, table_lower: &str) -> String {
    let level = &spec.levels[index];
    let col = format!("{table_lower}.{}", quote_ident_double(&level.column));
    match &level.stopper_value {
        Some(stopper) => format!("NULLIF({col}, '{}')", stopper.replace('\'', "''")),
        None => col,
    }
}

/// SQL expression for the displayed (and grouped) value of an included
/// hierarchy level, per the model's ragged behavior.
fn level_display_sql(spec: &HierarchySpec, index: usize, table_lower: &str) -> String {
    let nullified = nullified_sql(spec, index, table_lower);
    match spec.behavior {
        // No filling; stopper normalization only. HideMembers groups on the
        // raw (nullified) value — the filtering happens post-aggregation.
        RaggedBehavior::ShowBlanks | RaggedBehavior::HideMembers => nullified,
        // Fill every blank with the nearest non-blank parent.
        RaggedBehavior::RepeatParent => {
            if index == 0 {
                nullified
            } else {
                let chain: Vec<String> = (0..=index)
                    .rev()
                    .map(|i| nullified_sql(spec, i, table_lower))
                    .collect();
                format!("COALESCE({})", chain.join(", "))
            }
        }
        // Fill interior gaps (a real value exists deeper within the queried
        // depth), leave trailing blanks NULL.
        RaggedBehavior::ShowAsLeaf => {
            let last = spec.levels.len() - 1;
            if index == 0 || index == last {
                // Top level is required; the deepest included level has no
                // deeper level within the depth, so a blank is trailing.
                nullified
            } else {
                let deeper: Vec<String> = (index + 1..=last)
                    .map(|i| nullified_sql(spec, i, table_lower))
                    .collect();
                let parents: Vec<String> = (0..index)
                    .rev()
                    .map(|i| nullified_sql(spec, i, table_lower))
                    .collect();
                format!(
                    "CASE WHEN {nullified} IS NOT NULL THEN {nullified} \
                     WHEN COALESCE({}) IS NOT NULL THEN COALESCE({}) \
                     ELSE NULL END",
                    deeper.join(", "),
                    parents.join(", ")
                )
            }
        }
    }
}

/// The transformed SQL for a group-by column that is an included hierarchy
/// level, or `None` when the column is not a level or no transform is
/// needed (the plain qualified column works).
///
/// `spec` should already be filtered to hierarchies that need local
/// transforms ([`HierarchySpec::needs_local`]).
pub(super) fn hierarchy_display_sql(spec: &HierarchySpec, dim: &ColumnRef) -> Option<String> {
    let index = spec.level_index_of(&dim.table, &dim.column)?;
    let table_lower = spec.table.to_lowercase();
    let sql = level_display_sql(spec, index, &table_lower);
    // Plain column (ShowBlanks/HideMembers without a stopper): no rewrite.
    if sql == format!("{table_lower}.{}", quote_ident_double(&dim.column)) {
        None
    } else {
        Some(sql)
    }
}

/// Apply the HideMembers post-aggregation filter: drop result rows whose
/// value at any included level is NULL (stoppers were already normalized to
/// NULL at group time).
///
/// Level columns are located positionally — group-by output columns lead
/// the SELECT list, so level `p` of the plan's `group_by` is result column
/// `p`. Under ROLLUP, subtotal rows are exempt for rolled-up levels: a row
/// is kept when the level's `__grouping_id` bit is set (the NULL means
/// "aggregated away", not "blank member"). Totals therefore aggregate over
/// all underlying data; hiding is presentation-only.
pub(super) fn apply_hide_members_filter(
    batches: Vec<RecordBatch>,
    spec: &HierarchySpec,
    group_by: &[ColumnRef],
    rollup: bool,
) -> QueryResult<Vec<RecordBatch>> {
    // Positions of the hierarchy level columns within the group-by list
    // (== their result-column indices and their grouping-id bit indices).
    let level_positions: Vec<usize> = group_by
        .iter()
        .enumerate()
        .filter(|(_, col)| spec.level_index_of(&col.table, &col.column).is_some())
        .map(|(i, _)| i)
        .collect();
    if level_positions.is_empty() {
        return Ok(batches);
    }

    let mut out = Vec::with_capacity(batches.len());
    for batch in batches {
        if batch.num_rows() == 0 {
            out.push(batch);
            continue;
        }

        let grouping_ids: Option<&Int32Array> = if rollup {
            let idx = batch.schema().index_of(GROUPING_ID_COLUMN).map_err(|_| {
                QueryError::InvalidQuery(format!(
                    "ROLLUP result is missing the {GROUPING_ID_COLUMN} column"
                ))
            })?;
            let ids = batch
                .column(idx)
                .as_any()
                .downcast_ref::<Int32Array>()
                .ok_or_else(|| {
                    QueryError::InvalidQuery(format!(
                        "{GROUPING_ID_COLUMN} column has an unexpected type"
                    ))
                })?;
            Some(ids)
        } else {
            None
        };

        let mut keep: Option<BooleanArray> = None;
        for &pos in &level_positions {
            let mut level_keep = is_not_null(batch.column(pos))?;
            if let Some(ids) = grouping_ids {
                // Exempt rows where this level is rolled up (bit set).
                let bit = 1i32 << pos;
                let rolled_up = BooleanArray::from_iter(
                    (0..ids.len()).map(|i| Some(!ids.is_null(i) && (ids.value(i) & bit) != 0)),
                );
                level_keep = or(&level_keep, &rolled_up)?;
            }
            keep = Some(match keep {
                Some(existing) => arrow::compute::and(&existing, &level_keep)?,
                None => level_keep,
            });
        }

        // `level_positions` is non-empty, so `keep` is always Some here.
        let mask = keep.expect("at least one hierarchy level column");
        out.push(filter_record_batch(&batch, &mask)?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::planner::HierarchyLevelSpec;

    fn spec(behavior: RaggedBehavior, stoppers: &[Option<&str>]) -> HierarchySpec {
        let columns = ["country", "state", "city"];
        HierarchySpec {
            name: "Geo".into(),
            table: "Sales".into(),
            depth: stoppers.len(),
            behavior,
            levels: stoppers
                .iter()
                .enumerate()
                .map(|(i, s)| HierarchyLevelSpec {
                    column: columns[i].into(),
                    stopper_value: s.map(str::to_string),
                })
                .collect(),
        }
    }

    #[test]
    fn show_blanks_without_stopper_needs_no_rewrite() {
        let spec = spec(RaggedBehavior::ShowBlanks, &[None, None]);
        assert_eq!(
            hierarchy_display_sql(&spec, &ColumnRef::new("Sales", "state")),
            None
        );
    }

    #[test]
    fn stopper_is_nullified_under_show_blanks() {
        let spec = spec(RaggedBehavior::ShowBlanks, &[None, Some("#")]);
        assert_eq!(
            hierarchy_display_sql(&spec, &ColumnRef::new("Sales", "state")),
            Some("NULLIF(sales.\"state\", '#')".into())
        );
    }

    #[test]
    fn repeat_parent_coalesces_parent_chain() {
        let spec = spec(RaggedBehavior::RepeatParent, &[None, None, None]);
        assert_eq!(
            hierarchy_display_sql(&spec, &ColumnRef::new("Sales", "city")),
            Some("COALESCE(sales.\"city\", sales.\"state\", sales.\"country\")".into())
        );
        // Top level is required — never rewritten.
        assert_eq!(
            hierarchy_display_sql(&spec, &ColumnRef::new("Sales", "country")),
            None
        );
    }

    #[test]
    fn show_as_leaf_fills_interior_keeps_trailing() {
        let spec = spec(RaggedBehavior::ShowAsLeaf, &[None, None, None]);
        // Middle level: interior fill when a deeper value exists.
        assert_eq!(
            hierarchy_display_sql(&spec, &ColumnRef::new("Sales", "state")),
            Some(
                "CASE WHEN sales.\"state\" IS NOT NULL THEN sales.\"state\" \
                 WHEN COALESCE(sales.\"city\") IS NOT NULL THEN COALESCE(sales.\"country\") \
                 ELSE NULL END"
                    .into()
            )
        );
        // Deepest level: trailing blanks stay NULL — no rewrite (no stopper).
        assert_eq!(
            hierarchy_display_sql(&spec, &ColumnRef::new("Sales", "city")),
            None
        );
    }

    #[test]
    fn stopper_escapes_single_quotes() {
        let spec = spec(RaggedBehavior::ShowBlanks, &[None, Some("n/a's")]);
        assert_eq!(
            hierarchy_display_sql(&spec, &ColumnRef::new("Sales", "state")),
            Some("NULLIF(sales.\"state\", 'n/a''s')".into())
        );
    }

    #[test]
    fn non_level_column_is_untouched() {
        let spec = spec(RaggedBehavior::RepeatParent, &[None, None]);
        assert_eq!(
            hierarchy_display_sql(&spec, &ColumnRef::new("Sales", "region")),
            None
        );
        assert_eq!(
            hierarchy_display_sql(&spec, &ColumnRef::new("Other", "state")),
            None
        );
    }
}
