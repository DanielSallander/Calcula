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
    }
}
