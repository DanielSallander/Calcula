//! The declarative step catalog.
//!
//! A [`TransformStep`] is one entry in a table's **applied steps** pipeline:
//! a named, inspectable operation that turns the rows a connector returned
//! into the rows the model table declares. Steps are data, not code — they
//! serialize into the model file, render in a step list, and are re-evaluated
//! from scratch on every refresh.

use serde::{Deserialize, Serialize};

use crate::compute::aggregate::AggregateOp;
use crate::transform::parts::{
    CastErrorPolicy, ColumnRename, GroupAggregate, RowRange, SortKey, TextOp, TypeChange,
};
use crate::types::DataType;

/// One applied step in a table's transformation pipeline.
///
/// # Serialization
///
/// Internally tagged on `type`, with `camelCase` variant names and field
/// names — e.g.
///
/// ```json
/// { "type": "filterRows", "condition": "status <> \"cancelled\"" }
/// ```
///
/// The tag is additive-friendly: a future step is a new tag, and an engine
/// that does not know it fails the load loudly (rather than silently dropping
/// a step and producing a table that looks refreshed but is not filtered).
/// That is why a pipeline raises the model's format version.
///
/// # Expressions are text
///
/// [`FilterRows`](Self::FilterRows) and [`AddColumn`](Self::AddColumn) carry
/// the author's expression **source**, parsed and validated at model-build
/// time and at evaluation. See [`crate::transform::parts`] for why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TransformStep {
    /// Drop the named columns, keeping every other column in place.
    RemoveColumns {
        /// The columns to drop.
        columns: Vec<String>,
    },

    /// Keep only the named columns, **in the order given** (so this also
    /// reorders).
    SelectColumns {
        /// The columns to keep, in output order.
        columns: Vec<String>,
    },

    /// Rename columns in place, preserving their position and type.
    RenameColumns {
        /// The renames to apply, in order.
        renames: Vec<ColumnRename>,
    },

    /// Cast columns to new types.
    ChangeType {
        /// The per-column casts to apply.
        changes: Vec<TypeChange>,
        /// What to do with a value that cannot be represented in the target
        /// type. Defaults to [`CastErrorPolicy::Fail`].
        #[serde(default, skip_serializing_if = "is_default_cast_policy")]
        on_error: CastErrorPolicy,
    },

    /// Keep only the rows for which a boolean row-level expression is true.
    ///
    /// Rows where the condition evaluates to null are **dropped** (SQL
    /// `WHERE` semantics).
    FilterRows {
        /// Row-level boolean expression source over this table's columns.
        condition: String,
    },

    /// Append a computed column evaluated per row.
    AddColumn {
        /// The name of the new column.
        name: String,
        /// Row-level expression source over this table's columns.
        expression: String,
        /// The column's declared type. When absent the type is inferred from
        /// the expression; a step whose type cannot be inferred is rejected
        /// at validation with a request to declare one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data_type: Option<DataType>,
    },

    /// Rewrite one existing column with a row-level expression, in place.
    ///
    /// The formula counterpart of [`AddColumn`](Self::AddColumn): same
    /// expression language, same allowlist, but it REPLACES a column instead of
    /// appending one — keeping its position and its presentation metadata,
    /// which an add-then-drop-then-rename cannot.
    ///
    /// The expression reads the column's value BEFORE this step, so
    /// `net = [net] - [discount]` means what it appears to, and two such steps
    /// compose. The result is always nullable: a row-level expression can
    /// produce null from null inputs.
    TransformColumn {
        /// The existing column to rewrite.
        column: String,
        /// Row-level expression source over this table's columns.
        expression: String,
        /// The column's new declared type. When absent the type is inferred
        /// from the expression — and it is the INFERRED type, never the
        /// column's old one: `LEFT(qty, 3)` over an integer column produces
        /// text, and keeping the old type would cast the answer away.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data_type: Option<DataType>,
    },

    /// Split one text column into `parts` columns on a literal delimiter.
    ///
    /// Output columns are named `"{column}.1"` … `"{column}.{parts}"`. A part
    /// with no corresponding text is null.
    SplitColumn {
        /// The `String` column to split.
        column: String,
        /// The literal delimiter (not a regular expression).
        delimiter: String,
        /// How many output columns to produce.
        parts: u32,
        /// Keep the original column in addition to the parts.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        keep_original: bool,
    },

    /// Replace values within one column.
    ReplaceValues {
        /// The column to rewrite.
        column: String,
        /// The text to look for.
        find: String,
        /// The replacement text.
        replace: String,
        /// Match the entire value rather than a substring. Substring mode is
        /// `String`-only; whole-value mode works on any type whose literals
        /// parse from `find`/`replace`.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        match_entire_value: bool,
    },

    /// Apply a text operation to one or more `String` columns in place.
    TextTransform {
        /// The `String` columns to rewrite.
        columns: Vec<String>,
        /// The operation to apply.
        operation: TextOp,
    },

    /// Replace nulls with the nearest non-null value above, per column.
    FillDown {
        /// The columns to fill.
        columns: Vec<String>,
    },

    /// Keep the first row of each group of duplicates.
    RemoveDuplicates {
        /// The columns that define duplication. Empty means every column.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        columns: Vec<String>,
    },

    /// Order rows by one or more sort keys.
    Sort {
        /// The sort keys, most significant first.
        by: Vec<SortKey>,
    },

    /// Collapse rows into one row per distinct combination of `group_by`
    /// values, computing `aggregates` over each group.
    ///
    /// The output schema is exactly the `group_by` columns followed by the
    /// aggregate aliases — every other column is dropped.
    GroupBy {
        /// The grouping columns, in output order.
        group_by: Vec<String>,
        /// The aggregate output columns.
        aggregates: Vec<GroupAggregate>,
    },

    /// Keep only the rows in a positional range.
    KeepRows {
        /// The range to keep.
        range: RowRange,
    },

    /// Drop the rows in a positional range.
    RemoveRows {
        /// The range to drop.
        range: RowRange,
    },

    /// Turn the named columns into two columns — an attribute-name column and
    /// a value column — repeating every other column per unpivoted pair.
    Unpivot {
        /// The columns to unpivot.
        columns: Vec<String>,
        /// Name of the output column holding the source column's name.
        name_column: String,
        /// Name of the output column holding the source column's value.
        value_column: String,
    },

    /// Turn distinct values of `name_column` into columns, aggregating
    /// `value_column` within each remaining-column group.
    ///
    /// `value_names` is **declared**, not discovered: the output schema of a
    /// step must be derivable without reading data, so hosts sample a preview
    /// and write the distinct values into the step. Values present at refresh
    /// but absent from `value_names` are dropped; declared values absent from
    /// the data produce an all-null column.
    Pivot {
        /// The column whose distinct values become output columns.
        name_column: String,
        /// The column aggregated into each output column.
        value_column: String,
        /// The aggregation applied within each cell.
        aggregate: AggregateOp,
        /// The declared distinct values, in output-column order.
        value_names: Vec<String>,
    },
}

/// serde `skip_serializing_if` helper: omit a default cast-error policy.
fn is_default_cast_policy(policy: &CastErrorPolicy) -> bool {
    *policy == CastErrorPolicy::default()
}

impl TransformStep {
    /// The step's serialized tag (e.g. `"filterRows"`).
    ///
    /// Used in diagnostics and in host step lists, so it stays in lockstep
    /// with the serde `rename_all` by construction.
    pub fn type_name(&self) -> &'static str {
        match self {
            TransformStep::RemoveColumns { .. } => "removeColumns",
            TransformStep::SelectColumns { .. } => "selectColumns",
            TransformStep::RenameColumns { .. } => "renameColumns",
            TransformStep::ChangeType { .. } => "changeType",
            TransformStep::FilterRows { .. } => "filterRows",
            TransformStep::AddColumn { .. } => "addColumn",
            TransformStep::TransformColumn { .. } => "transformColumn",
            TransformStep::SplitColumn { .. } => "splitColumn",
            TransformStep::ReplaceValues { .. } => "replaceValues",
            TransformStep::TextTransform { .. } => "textTransform",
            TransformStep::FillDown { .. } => "fillDown",
            TransformStep::RemoveDuplicates { .. } => "removeDuplicates",
            TransformStep::Sort { .. } => "sort",
            TransformStep::GroupBy { .. } => "groupBy",
            TransformStep::KeepRows { .. } => "keepRows",
            TransformStep::RemoveRows { .. } => "removeRows",
            TransformStep::Unpivot { .. } => "unpivot",
            TransformStep::Pivot { .. } => "pivot",
        }
    }

    /// The expression sources this step carries, if any.
    ///
    /// Lets callers (validation, lineage, host "which steps mention column X?"
    /// queries) reach every expression without matching on each variant.
    pub fn expression_sources(&self) -> Vec<&str> {
        match self {
            TransformStep::FilterRows { condition } => vec![condition.as_str()],
            TransformStep::AddColumn { expression, .. } => vec![expression.as_str()],
            TransformStep::TransformColumn { expression, .. } => vec![expression.as_str()],
            _ => Vec::new(),
        }
    }

    /// Returns `true` if this step can change the number of rows.
    ///
    /// Hosts use this to warn that a row-limited preview of the step is an
    /// approximation of the full refresh.
    pub fn changes_row_count(&self) -> bool {
        matches!(
            self,
            TransformStep::FilterRows { .. }
                | TransformStep::RemoveDuplicates { .. }
                | TransformStep::GroupBy { .. }
                | TransformStep::KeepRows { .. }
                | TransformStep::RemoveRows { .. }
                | TransformStep::Unpivot { .. }
                | TransformStep::Pivot { .. }
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn type_name_matches_the_serialized_tag() {
        // Every variant's `type_name()` must equal the serde tag, or host
        // diagnostics would name a step the host cannot match to its editor.
        let steps = crate::transform::test_support::one_of_every_step();
        for step in &steps {
            let value = serde_json::to_value(step).unwrap();
            let tag = value["type"].as_str().unwrap();
            assert_eq!(tag, step.type_name(), "tag/type_name drift for {step:?}");
        }
    }

    #[test]
    fn expression_sources_reaches_both_expression_steps() {
        let filter = TransformStep::FilterRows {
            condition: "amount > 0".into(),
        };
        assert_eq!(filter.expression_sources(), vec!["amount > 0"]);

        let add = TransformStep::AddColumn {
            name: "margin".into(),
            expression: "amount - cost".into(),
            data_type: None,
        };
        assert_eq!(add.expression_sources(), vec!["amount - cost"]);

        let sort = TransformStep::Sort {
            by: vec![SortKey::ascending("amount")],
        };
        assert!(sort.expression_sources().is_empty());
    }

    #[test]
    fn row_count_changing_steps_are_flagged() {
        assert!(TransformStep::FilterRows {
            condition: "x".into()
        }
        .changes_row_count());
        assert!(TransformStep::GroupBy {
            group_by: vec!["region".into()],
            aggregates: vec![],
        }
        .changes_row_count());
        assert!(!TransformStep::RemoveColumns {
            columns: vec!["x".into()]
        }
        .changes_row_count());
        assert!(!TransformStep::Sort {
            by: vec![SortKey::ascending("x")]
        }
        .changes_row_count());
    }

    #[test]
    fn change_type_omits_a_default_error_policy() {
        let step = TransformStep::ChangeType {
            changes: vec![TypeChange::new("qty", DataType::Int64)],
            on_error: CastErrorPolicy::Fail,
        };
        let json = serde_json::to_string(&step).unwrap();
        assert!(!json.contains("onError"), "got {json}");

        let step = TransformStep::ChangeType {
            changes: vec![TypeChange::new("qty", DataType::Int64)],
            on_error: CastErrorPolicy::Null,
        };
        let json = serde_json::to_string(&step).unwrap();
        assert!(json.contains("\"onError\":\"null\""), "got {json}");
    }

    #[test]
    fn field_names_serialize_as_camel_case() {
        let step = TransformStep::Unpivot {
            columns: vec!["jan".into(), "feb".into()],
            name_column: "month".into(),
            value_column: "amount".into(),
        };
        let json = serde_json::to_string(&step).unwrap();
        assert!(json.contains("\"nameColumn\""), "got {json}");
        assert!(json.contains("\"valueColumn\""), "got {json}");
        assert!(!json.contains("name_column"), "got {json}");
    }
}
