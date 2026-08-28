//! Operand types carried by [`TransformStep`](super::TransformStep) variants.
//!
//! These are deliberately small, `Eq`-comparable value types: a transformation
//! pipeline is compared field-by-field when the model editor decides whether a
//! table's definition changed, and it is hashed into the table's cache identity
//! (see [`Table::schema_hash`](crate::model::Table::schema_hash)). Expressions
//! are therefore carried as **source text**, never as a parsed
//! [`Expression`](crate::compute::expression::Expression) — the same choice
//! [`IncrementalRefresh`](crate::model::IncrementalRefresh) makes, and for the
//! same reasons: the author's text round-trips exactly, and the model stays
//! `Eq`.

use serde::{Deserialize, Serialize};

use crate::compute::aggregate::AggregateOp;
use crate::types::DataType;

/// Rename one column, as carried by
/// [`TransformStep::RenameColumns`](super::TransformStep::RenameColumns).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnRename {
    /// The existing column name.
    pub from: String,
    /// The new column name.
    pub to: String,
}

impl ColumnRename {
    /// Create a rename of `from` to `to`.
    pub fn new(from: impl Into<String>, to: impl Into<String>) -> Self {
        Self {
            from: from.into(),
            to: to.into(),
        }
    }
}

/// One key pair of a [`LookupColumn`](super::TransformStep::LookupColumn)
/// step: a column of THIS table matched against a column of the target.
///
/// Several pairs are ANDed, which is how a composite key is expressed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupKey {
    /// The column on the table being transformed.
    pub host: String,
    /// The column on the target table it must equal.
    pub target: String,
}

impl LookupKey {
    /// Match `host` against `target`.
    pub fn new(host: impl Into<String>, target: impl Into<String>) -> Self {
        Self {
            host: host.into(),
            target: target.into(),
        }
    }
}

/// One column a [`LookupColumn`](super::TransformStep::LookupColumn) step
/// brings back from the target table.
///
/// Several takes ride ONE join — pulling three columns from a dimension costs
/// one pass over it, not three.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupTake {
    /// The column to read from the target table.
    pub column: String,
    /// The name it lands under on this table. Absent means "the same name",
    /// which is the common case and so is not written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_name: Option<String>,
}

impl LookupTake {
    /// Take `column` under its own name.
    pub fn new(column: impl Into<String>) -> Self {
        Self {
            column: column.into(),
            output_name: None,
        }
    }

    /// Take `column` and rename it to `output_name`.
    pub fn renamed(column: impl Into<String>, output_name: impl Into<String>) -> Self {
        Self {
            column: column.into(),
            output_name: Some(output_name.into()),
        }
    }

    /// The name this take produces on the host table.
    pub fn output(&self) -> &str {
        self.output_name.as_deref().unwrap_or(&self.column)
    }
}

/// Re-type one column, as carried by
/// [`TransformStep::ChangeType`](super::TransformStep::ChangeType).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeChange {
    /// The column to cast.
    pub column: String,
    /// The type to cast it to.
    pub new_type: DataType,
}

impl TypeChange {
    /// Create a type change for `column` to `new_type`.
    pub fn new(column: impl Into<String>, new_type: DataType) -> Self {
        Self {
            column: column.into(),
            new_type,
        }
    }
}

/// What a [`ChangeType`](super::TransformStep::ChangeType) step does with a
/// value that cannot be represented in the target type.
///
/// The default is [`Fail`](CastErrorPolicy::Fail): a refresh that cannot
/// honour the declared schema stops loudly rather than silently substituting
/// nulls for data the user believes was loaded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CastErrorPolicy {
    /// Fail the whole step (and therefore the refresh) on the first
    /// unconvertible value.
    #[default]
    Fail,
    /// Replace unconvertible values with null. Forces the resulting column
    /// nullable, whatever it was before.
    Null,
}

/// Per-column text operation applied by
/// [`TransformStep::TextTransform`](super::TransformStep::TextTransform).
///
/// Every operation is value-preserving in type — a `String` column stays a
/// `String` column — so the step never changes the output schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextOp {
    /// Remove leading and trailing whitespace.
    Trim,
    /// Remove non-printable control characters (`U+0000`–`U+001F`, `U+007F`).
    Clean,
    /// Convert to upper case.
    Upper,
    /// Convert to lower case.
    Lower,
}

impl TextOp {
    /// The operation's name as it appears in diagnostics.
    pub fn as_str(&self) -> &'static str {
        match self {
            TextOp::Trim => "trim",
            TextOp::Clean => "clean",
            TextOp::Upper => "upper",
            TextOp::Lower => "lower",
        }
    }
}

/// One sort key of a [`Sort`](super::TransformStep::Sort) step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortKey {
    /// The column to sort by.
    pub column: String,
    /// Sort descending instead of ascending.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub descending: bool,
}

impl SortKey {
    /// Create an ascending sort key.
    pub fn ascending(column: impl Into<String>) -> Self {
        Self {
            column: column.into(),
            descending: false,
        }
    }

    /// Create a descending sort key.
    pub fn descending(column: impl Into<String>) -> Self {
        Self {
            column: column.into(),
            descending: true,
        }
    }
}

/// A contiguous row range for
/// [`KeepRows`](super::TransformStep::KeepRows) /
/// [`RemoveRows`](super::TransformStep::RemoveRows).
///
/// Ranges address the pipeline's row order **at that step** — which is
/// deterministic only if a [`Sort`](super::TransformStep::Sort) step precedes
/// them, or the source itself returns rows in a stable order. Hosts should say
/// so in their step editors.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RowRange {
    /// The first `count` rows.
    FirstN {
        /// How many rows.
        count: u64,
    },
    /// The last `count` rows.
    LastN {
        /// How many rows.
        count: u64,
    },
    /// `count` rows starting at zero-based `offset`.
    Range {
        /// Zero-based index of the first row.
        offset: u64,
        /// How many rows.
        count: u64,
    },
}

impl RowRange {
    /// Resolve this range against a concrete row count, returning the
    /// zero-based `(offset, length)` of the addressed rows, clamped to the
    /// available rows. An out-of-bounds range resolves to a length of zero.
    pub fn resolve(&self, num_rows: u64) -> (u64, u64) {
        match self {
            RowRange::FirstN { count } => (0, (*count).min(num_rows)),
            RowRange::LastN { count } => {
                let take = (*count).min(num_rows);
                (num_rows - take, take)
            }
            RowRange::Range { offset, count } => {
                if *offset >= num_rows {
                    (num_rows, 0)
                } else {
                    (*offset, (*count).min(num_rows - *offset))
                }
            }
        }
    }

    /// The row count this range asks for, before clamping.
    pub fn requested_count(&self) -> u64 {
        match self {
            RowRange::FirstN { count } | RowRange::LastN { count } => *count,
            RowRange::Range { count, .. } => *count,
        }
    }
}

/// One aggregate output column of a
/// [`GroupBy`](super::TransformStep::GroupBy) step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupAggregate {
    /// The input column to aggregate. Ignored (and may be empty) for
    /// [`AggregateOp::CountRows`], which counts rows rather than values —
    /// and empty when [`expression`](Self::expression) carries a formula
    /// instead.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub column: String,
    /// The aggregation to apply.
    pub function: AggregateOp,
    /// The name of the output column.
    pub alias: String,
    /// A row-level formula to aggregate instead of a plain column — the
    /// SUMIF shape: `Sum` over `IF([status] = "open", [amount], BLANK())`.
    ///
    /// Exactly one of `column` and `expression` is given (neither for
    /// `CountRows`). The formula goes through the same fail-closed row-level
    /// parse as `filterRows`/`addColumn`, so it can never itself aggregate,
    /// and its INFERRED type stands in for the column type everywhere one is
    /// needed. Additive serde: a model written without this field reads
    /// unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expression: Option<String>,
}

impl GroupAggregate {
    /// Create an aggregate of `column` under `alias`.
    pub fn new(column: impl Into<String>, function: AggregateOp, alias: impl Into<String>) -> Self {
        Self {
            column: column.into(),
            function,
            alias: alias.into(),
            expression: None,
        }
    }

    /// Create a `COUNTROWS()` aggregate under `alias` (no input column).
    pub fn count_rows(alias: impl Into<String>) -> Self {
        Self {
            column: String::new(),
            function: AggregateOp::CountRows,
            alias: alias.into(),
            expression: None,
        }
    }

    /// Create an aggregate of a row-level `expression` under `alias` — the
    /// SUMIF shape.
    pub fn formula(
        function: AggregateOp,
        alias: impl Into<String>,
        expression: impl Into<String>,
    ) -> Self {
        Self {
            column: String::new(),
            function,
            alias: alias.into(),
            expression: Some(expression.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cast_error_policy_defaults_to_fail() {
        assert_eq!(CastErrorPolicy::default(), CastErrorPolicy::Fail);
    }

    #[test]
    fn row_range_first_n_clamps_to_available_rows() {
        assert_eq!(RowRange::FirstN { count: 3 }.resolve(10), (0, 3));
        assert_eq!(RowRange::FirstN { count: 30 }.resolve(10), (0, 10));
        assert_eq!(RowRange::FirstN { count: 0 }.resolve(10), (0, 0));
    }

    #[test]
    fn row_range_last_n_offsets_from_the_end() {
        assert_eq!(RowRange::LastN { count: 3 }.resolve(10), (7, 3));
        assert_eq!(RowRange::LastN { count: 30 }.resolve(10), (0, 10));
        assert_eq!(RowRange::LastN { count: 0 }.resolve(10), (10, 0));
    }

    #[test]
    fn row_range_range_clamps_offset_and_count() {
        assert_eq!(
            RowRange::Range {
                offset: 2,
                count: 5
            }
            .resolve(10),
            (2, 5)
        );
        assert_eq!(
            RowRange::Range {
                offset: 8,
                count: 5
            }
            .resolve(10),
            (8, 2)
        );
        // An offset past the end yields an empty selection, not a panic.
        assert_eq!(
            RowRange::Range {
                offset: 20,
                count: 5
            }
            .resolve(10),
            (10, 0)
        );
    }

    #[test]
    fn row_range_resolves_against_an_empty_batch() {
        for range in [
            RowRange::FirstN { count: 5 },
            RowRange::LastN { count: 5 },
            RowRange::Range {
                offset: 0,
                count: 5,
            },
        ] {
            assert_eq!(range.resolve(0), (0, 0), "range {range:?} over zero rows");
        }
    }

    #[test]
    fn row_range_reports_its_requested_count() {
        assert_eq!(RowRange::FirstN { count: 7 }.requested_count(), 7);
        assert_eq!(RowRange::LastN { count: 7 }.requested_count(), 7);
        assert_eq!(
            RowRange::Range {
                offset: 3,
                count: 7
            }
            .requested_count(),
            7
        );
    }

    #[test]
    fn row_range_serde_round_trip_is_kind_tagged() {
        let range = RowRange::Range {
            offset: 2,
            count: 5,
        };
        let json = serde_json::to_string(&range).unwrap();
        assert!(json.contains("\"kind\":\"range\""), "got {json}");
        let restored: RowRange = serde_json::from_str(&json).unwrap();
        assert_eq!(range, restored);
    }

    #[test]
    fn sort_key_omits_default_ascending_in_json() {
        let json = serde_json::to_string(&SortKey::ascending("amount")).unwrap();
        assert!(!json.contains("descending"), "got {json}");
        let json = serde_json::to_string(&SortKey::descending("amount")).unwrap();
        assert!(json.contains("\"descending\":true"), "got {json}");
    }

    #[test]
    fn group_aggregate_count_rows_carries_no_column() {
        let agg = GroupAggregate::count_rows("Rows");
        assert!(agg.column.is_empty());
        assert_eq!(agg.function, AggregateOp::CountRows);
        let json = serde_json::to_string(&agg).unwrap();
        assert!(!json.contains("\"column\""), "got {json}");
    }

    #[test]
    fn text_op_names_are_stable() {
        assert_eq!(TextOp::Trim.as_str(), "trim");
        assert_eq!(TextOp::Clean.as_str(), "clean");
        assert_eq!(TextOp::Upper.as_str(), "upper");
        assert_eq!(TextOp::Lower.as_str(), "lower");
    }
}
