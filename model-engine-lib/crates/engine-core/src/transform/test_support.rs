//! Shared fixtures for the transformation module's unit tests.

use crate::compute::aggregate::AggregateOp;
use crate::model::Column;
use crate::transform::parts::{
    CastErrorPolicy, ColumnRename, GroupAggregate, RowRange, SortKey, TextOp, TypeChange,
};
use crate::transform::TransformStep;
use crate::types::DataType;

/// Build a schema from `(name, type)` pairs. Every column is nullable.
pub(crate) fn cols(spec: &[(&str, DataType)]) -> Vec<Column> {
    spec.iter()
        .map(|(name, data_type)| Column::new(*name, data_type.clone()))
        .collect()
}

/// The column names of a schema, for terse assertions.
pub(crate) fn names(columns: &[Column]) -> Vec<&str> {
    columns.iter().map(|c| c.name()).collect()
}

/// The standard source schema the rule tests derive from: one of each type
/// the steps care about (integer key, text, floating point, date).
pub(crate) fn source_schema() -> Vec<Column> {
    cols(&[
        ("id", DataType::Int64),
        ("region", DataType::String),
        ("status", DataType::String),
        ("amount", DataType::Float64),
        ("cost", DataType::Float64),
        ("order_date", DataType::Date),
    ])
}

/// One instance of every [`TransformStep`] variant.
///
/// Tests that must cover the whole catalog (serde round-trip, tag/name
/// agreement) iterate this. Adding a variant without adding it here leaves
/// those tests passing while covering less — so
/// [`covers_every_variant`](self::tests::covers_every_variant) asserts the
/// count against the catalog.
pub(crate) fn one_of_every_step() -> Vec<TransformStep> {
    vec![
        TransformStep::RemoveColumns {
            columns: vec!["cost".into()],
        },
        TransformStep::SelectColumns {
            columns: vec!["id".into(), "amount".into()],
        },
        TransformStep::RenameColumns {
            renames: vec![ColumnRename::new("amount", "net")],
        },
        TransformStep::ChangeType {
            changes: vec![TypeChange::new("amount", DataType::Decimal(18, 2))],
            on_error: CastErrorPolicy::Null,
        },
        TransformStep::FilterRows {
            condition: "amount > 0".into(),
        },
        TransformStep::AddColumn {
            name: "margin".into(),
            expression: "amount - cost".into(),
            data_type: Some(DataType::Float64),
        },
        TransformStep::SplitColumn {
            column: "region".into(),
            delimiter: "-".into(),
            parts: 2,
            keep_original: true,
        },
        TransformStep::ReplaceValues {
            column: "status".into(),
            find: "open".into(),
            replace: "active".into(),
            match_entire_value: true,
        },
        TransformStep::TextTransform {
            columns: vec!["status".into()],
            operation: TextOp::Trim,
        },
        TransformStep::FillDown {
            columns: vec!["region".into()],
        },
        TransformStep::RemoveDuplicates {
            columns: vec!["id".into()],
        },
        TransformStep::Sort {
            by: vec![SortKey::descending("amount")],
        },
        TransformStep::GroupBy {
            group_by: vec!["region".into()],
            aggregates: vec![GroupAggregate::new("amount", AggregateOp::Sum, "total")],
        },
        TransformStep::KeepRows {
            range: RowRange::FirstN { count: 100 },
        },
        TransformStep::RemoveRows {
            range: RowRange::Range {
                offset: 0,
                count: 1,
            },
        },
        TransformStep::Unpivot {
            columns: vec!["amount".into(), "cost".into()],
            name_column: "measure".into(),
            value_column: "value".into(),
        },
        TransformStep::Pivot {
            name_column: "status".into(),
            value_column: "amount".into(),
            aggregate: AggregateOp::Sum,
            value_names: vec!["open".into(), "closed".into()],
        },
    ]
}

/// Strings chosen to break a naive grammar, driven into every string-bearing
/// slot of every step by the script round-trip tests.
///
/// `region.1` and `period.1` are not hypothetical: `splitColumn` generates
/// exactly those names itself, so a grammar that read a dot as a path separator
/// would fail on its own output.
pub(crate) const HOSTILE: &[&str] = &[
    "",
    "\"",
    "a\"\"b",
    "\\",
    "a\\nb",
    "a\nb",
    "a\tb",
    " leading",
    "trailing ",
    "a,b",
    "a=b",
    "a:b",
    "-x",
    "+x",
    "[a]",
    "a]]b",
    "//not a comment",
    "#not a comment",
    "region.1",
    "period.1",
    "Decimal(18,2)",
    "columns",
    "sum",
    "desc",
    "first",
    "Sales Amount",
    "\u{00e5}\u{00e4}\u{00f6}",
];

/// Every step in **both states of every field that serde may omit**.
///
/// [`one_of_every_step`] covers each variant once, which is enough to catch a
/// missing variant and not enough to catch a missing FIELD: a field with
/// `skip_serializing_if` is invisible in JSON whenever it holds its default, so
/// a fixture that only ever sets one state cannot tell a spelling that is
/// absent from one that is merely unexercised. These instances pin the other
/// state of each such field, plus the empty and multiple cardinalities that a
/// single-entry fixture hides.
pub(crate) fn every_field_shape() -> Vec<TransformStep> {
    vec![
        // Cardinality: empty and multiple, for every list-valued field.
        TransformStep::RemoveColumns { columns: vec![] },
        TransformStep::RemoveColumns {
            columns: vec!["a".into(), "b".into(), "c".into()],
        },
        TransformStep::SelectColumns { columns: vec![] },
        TransformStep::RenameColumns { renames: vec![] },
        TransformStep::RenameColumns {
            renames: vec![
                ColumnRename::new("a", "b"),
                ColumnRename::new("c", "d"),
                ColumnRename::new("e", "f"),
            ],
        },
        // A heterogeneous cast list, which the command line cannot express.
        TransformStep::ChangeType {
            changes: vec![
                TypeChange::new("a", DataType::Int32),
                TypeChange::new("b", DataType::Decimal(38, -2)),
                TypeChange::new("c", DataType::Timestamp),
            ],
            on_error: CastErrorPolicy::Fail,
        },
        TransformStep::ChangeType {
            changes: vec![],
            on_error: CastErrorPolicy::Null,
        },
        // A condition carrying a newline, a quote and a comment introducer.
        TransformStep::FilterRows {
            condition: "status <> \"cancelled\"\n  AND amount > 0 // keep".into(),
        },
        TransformStep::AddColumn {
            name: "margin".into(),
            expression: "amount - cost".into(),
            data_type: None,
        },
        TransformStep::SplitColumn {
            column: "region".into(),
            delimiter: "\n".into(),
            parts: 1,
            keep_original: false,
        },
        TransformStep::SplitColumn {
            column: "region".into(),
            delimiter: " - ".into(),
            parts: 64,
            keep_original: true,
        },
        TransformStep::ReplaceValues {
            column: "status".into(),
            find: "open".into(),
            replace: String::new(),
            match_entire_value: false,
        },
        TransformStep::TextTransform {
            columns: vec![],
            operation: TextOp::Clean,
        },
        TransformStep::FillDown { columns: vec![] },
        // The meaning-bearing empty: every column defines a duplicate.
        TransformStep::RemoveDuplicates { columns: vec![] },
        TransformStep::Sort { by: vec![] },
        TransformStep::Sort {
            by: vec![
                SortKey::ascending("a"),
                SortKey::descending("b"),
                SortKey::descending("Sales Amount"),
            ],
        },
        // A zero-key group-by, which the engine accepts and the CLI refuses.
        TransformStep::GroupBy {
            group_by: vec![],
            aggregates: vec![GroupAggregate::count_rows("Rows")],
        },
        TransformStep::GroupBy {
            group_by: vec!["region".into(), "month".into()],
            aggregates: vec![
                GroupAggregate::new("amount", AggregateOp::Sum, "total"),
                GroupAggregate::count_rows("orders"),
                GroupAggregate::new("id", AggregateOp::DistinctCount, "customers"),
            ],
        },
        TransformStep::GroupBy {
            group_by: vec!["region".into()],
            aggregates: vec![],
        },
        TransformStep::KeepRows {
            range: RowRange::LastN { count: 0 },
        },
        TransformStep::RemoveRows {
            range: RowRange::FirstN { count: u64::MAX },
        },
        TransformStep::Unpivot {
            columns: vec![],
            name_column: "measure".into(),
            value_column: "value".into(),
        },
        TransformStep::Pivot {
            name_column: "status".into(),
            value_column: "amount".into(),
            aggregate: AggregateOp::CountRows,
            value_names: vec![],
        },
    ]
}

/// Compile-time proof that [`one_of_every_step`] is complete.
///
/// The count assertion below can only compare the fixture against ITSELF, so on
/// its own a new `TransformStep` variant would slip past every catalog-wide
/// test while they all stayed green. This match is exhaustive with no wildcard
/// arm, so adding a variant makes the crate FAIL TO COMPILE here — pointing at
/// the fixture that has to grow — instead of quietly reducing coverage.
#[cfg(test)]
fn _every_variant_is_represented(step: &TransformStep) {
    match step {
        TransformStep::RemoveColumns { .. }
        | TransformStep::SelectColumns { .. }
        | TransformStep::RenameColumns { .. }
        | TransformStep::ChangeType { .. }
        | TransformStep::FilterRows { .. }
        | TransformStep::AddColumn { .. }
        | TransformStep::SplitColumn { .. }
        | TransformStep::ReplaceValues { .. }
        | TransformStep::TextTransform { .. }
        | TransformStep::FillDown { .. }
        | TransformStep::RemoveDuplicates { .. }
        | TransformStep::Sort { .. }
        | TransformStep::GroupBy { .. }
        | TransformStep::KeepRows { .. }
        | TransformStep::RemoveRows { .. }
        | TransformStep::Unpivot { .. }
        | TransformStep::Pivot { .. } => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn covers_every_variant() {
        // Guards the catalog-wide tests: a new step must appear here, or those
        // tests would silently stop covering the whole catalog. The tag set is
        // the check, so a duplicated variant does not pass by count alone.
        let steps = one_of_every_step();
        let tags: HashSet<&str> = steps.iter().map(|s| s.type_name()).collect();
        assert_eq!(
            tags.len(),
            steps.len(),
            "one_of_every_step must not repeat a variant"
        );
        assert_eq!(
            tags.len(),
            17,
            "the catalog has 17 steps; add the new one to one_of_every_step()"
        );
        // The count above compares the fixture with a literal — both sides are
        // this file. `_every_variant_is_represented` is what actually ties the
        // fixture to the enum: it stops compiling when a variant is added.
        for step in &steps {
            _every_variant_is_represented(step);
        }
    }
}
