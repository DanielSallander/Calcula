//! Pure schema derivation: fold a pipeline over an input schema.
//!
//! Every step's output schema is a function of its **input schema alone** —
//! no data is read. That is the property that lets the model editor show the
//! resulting columns while the user is still typing, lets
//! [`DataModel::validate`](crate::model::DataModel::validate) check that a
//! table's declared columns actually match what its pipeline produces, and
//! lets a refresh conform the fetched batch to a schema decided offline.
//!
//! It is also why the catalog has no `promoteHeaders` step and why
//! [`Pivot`](crate::transform::TransformStep::Pivot) takes **declared**
//! value names: both would otherwise need to read rows to know their output
//! columns.

use crate::error::{EngineError, EngineResult};
use crate::model::Column;
use crate::transform::catalog::TableSchemas;
use crate::transform::rules_columns;
use crate::transform::rules_rows;
use crate::transform::TransformStep;

/// Build the typed error every derivation and validation failure uses.
///
/// The step index is part of the contract: hosts anchor the message to a row
/// in the step list, so a reason without an index is not actionable.
pub(crate) fn transform_error(
    table: &str,
    step_index: usize,
    reason: impl Into<String>,
) -> EngineError {
    EngineError::InvalidTransform {
        table: table.to_string(),
        step_index,
        reason: reason.into(),
    }
}

/// Look up a column by name, or fail with a step-anchored error naming the
/// columns that *are* available (the single most useful thing to show someone
/// whose source drifted).
pub(crate) fn require_column<'a>(
    table: &str,
    step_index: usize,
    columns: &'a [Column],
    name: &str,
) -> EngineResult<&'a Column> {
    columns.iter().find(|c| c.name() == name).ok_or_else(|| {
        let available = columns
            .iter()
            .map(|c| c.name())
            .collect::<Vec<_>>()
            .join(", ");
        transform_error(
            table,
            step_index,
            format!("unknown column '{name}' (available: {available})"),
        )
    })
}

/// Fail unless `name` is free in `columns`.
pub(crate) fn require_absent(
    table: &str,
    step_index: usize,
    columns: &[Column],
    name: &str,
) -> EngineResult<()> {
    if columns.iter().any(|c| c.name() == name) {
        return Err(transform_error(
            table,
            step_index,
            format!("column '{name}' already exists"),
        ));
    }
    Ok(())
}

/// Fail if `names` contains a repeat, naming the first one.
pub(crate) fn require_unique(
    table: &str,
    step_index: usize,
    names: &[String],
    what: &str,
) -> EngineResult<()> {
    let mut seen = std::collections::HashSet::new();
    for name in names {
        if !seen.insert(name.as_str()) {
            return Err(transform_error(
                table,
                step_index,
                format!("duplicate {what} '{name}'"),
            ));
        }
    }
    Ok(())
}

/// Fold one step over an input schema, returning the resulting schema.
///
/// Pure — reads no data. `table` and `step_index` are carried only so that a
/// failure names the step the host must highlight.
///
/// # Errors
///
/// [`EngineError::InvalidTransform`] when the step cannot apply to this
/// schema: an unknown column, a name collision, a type the step does not
/// accept, or an expression whose type cannot be inferred.
pub fn derive_step_schema(
    table: &str,
    step_index: usize,
    input: &[Column],
    step: &TransformStep,
    schemas: &dyn TableSchemas,
) -> EngineResult<Vec<Column>> {
    let output = match step {
        TransformStep::RemoveColumns { columns } => {
            rules_columns::remove_columns(table, step_index, input, columns)?
        }
        TransformStep::SelectColumns { columns } => {
            rules_columns::select_columns(table, step_index, input, columns)?
        }
        TransformStep::RenameColumns { renames } => {
            rules_columns::rename_columns(table, step_index, input, renames)?
        }
        TransformStep::ChangeType { changes, on_error } => {
            rules_columns::change_type(table, step_index, input, changes, *on_error)?
        }
        TransformStep::AddColumn {
            name,
            expression,
            data_type,
        } => rules_columns::add_column(
            table,
            step_index,
            input,
            name,
            expression,
            data_type.as_ref(),
        )?,
        TransformStep::TransformColumn {
            column,
            expression,
            data_type,
        } => rules_columns::transform_column(
            table,
            step_index,
            input,
            column,
            expression,
            data_type.as_ref(),
        )?,
        TransformStep::LookupColumn {
            table: target,
            keys,
            takes,
        } => rules_columns::lookup_column(table, step_index, input, target, keys, takes, schemas)?,
        TransformStep::SplitColumn {
            column,
            delimiter,
            parts,
            keep_original,
        } => rules_columns::split_column(
            table,
            step_index,
            input,
            column,
            delimiter,
            *parts,
            *keep_original,
        )?,
        TransformStep::ReplaceValues {
            column,
            find,
            replace,
            match_entire_value,
        } => rules_columns::replace_values(
            table,
            step_index,
            input,
            column,
            find,
            replace,
            *match_entire_value,
        )?,
        TransformStep::TextTransform { columns, operation } => {
            rules_columns::text_transform(table, step_index, input, columns, *operation)?
        }
        TransformStep::FillDown { columns } => {
            rules_columns::fill_down(table, step_index, input, columns)?
        }

        TransformStep::FilterRows { condition } => {
            rules_rows::filter_rows(table, step_index, input, condition)?
        }
        TransformStep::RemoveDuplicates { columns } => {
            rules_rows::remove_duplicates(table, step_index, input, columns)?
        }
        TransformStep::Sort { by } => rules_rows::sort(table, step_index, input, by)?,
        TransformStep::GroupBy {
            group_by,
            aggregates,
        } => rules_rows::group_by(table, step_index, input, group_by, aggregates)?,
        TransformStep::KeepRows { range } | TransformStep::RemoveRows { range } => {
            rules_rows::row_range(table, step_index, input, range)?
        }
        TransformStep::Unpivot {
            columns,
            name_column,
            value_column,
        } => rules_rows::unpivot(table, step_index, input, columns, name_column, value_column)?,
        TransformStep::Pivot {
            name_column,
            value_column,
            aggregate,
            value_names,
        } => rules_rows::pivot(
            table,
            step_index,
            input,
            name_column,
            value_column,
            *aggregate,
            value_names,
        )?,
    };

    // A pipeline that produces no columns cannot describe a table, and every
    // downstream consumer (Arrow schema, cache, query planner) would fail far
    // from the cause. Catch it here, where the step is still named.
    if output.is_empty() {
        return Err(transform_error(
            table,
            step_index,
            "step would leave the table with no columns",
        ));
    }
    Ok(output)
}

/// Fold a whole pipeline over the source schema.
///
/// This is the function that answers "what columns does this table have?" for
/// a transformed table: the source's introspected columns in,
/// the model table's declared columns out.
///
/// # Errors
///
/// The first step that cannot apply, as [`EngineError::InvalidTransform`]
/// carrying that step's index.
pub fn derive_pipeline_schema(
    table: &str,
    source_columns: &[Column],
    steps: &[TransformStep],
    schemas: &dyn TableSchemas,
) -> EngineResult<Vec<Column>> {
    let mut columns = source_columns.to_vec();
    for (index, step) in steps.iter().enumerate() {
        columns = derive_step_schema(table, index, &columns, step, schemas)?;
    }
    Ok(columns)
}

/// Compare two schemas by the properties that make a table's data readable:
/// name, type, and nullability, in order. Presentation metadata is ignored.
///
/// Used by model validation to assert that a transformed table's **declared**
/// columns are exactly what its pipeline derives — the invariant that stops a
/// model file from claiming a shape its refresh will never produce.
pub fn schemas_match(left: &[Column], right: &[Column]) -> bool {
    left.len() == right.len()
        && left.iter().zip(right).all(|(a, b)| {
            a.name() == b.name() && a.data_type() == b.data_type() && a.nullable() == b.nullable()
        })
}

/// Render a schema as `name:Type` pairs for error messages.
pub(crate) fn describe_schema(columns: &[Column]) -> String {
    columns
        .iter()
        .map(|c| format!("{}:{:?}", c.name(), c.data_type()))
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transform::test_support::{cols, source_schema};
    use crate::types::DataType;

    #[test]
    fn empty_pipeline_returns_the_source_schema() {
        let source = source_schema();
        let derived =
            derive_pipeline_schema("Sales", &source, &[], &crate::transform::NoOtherTables)
                .unwrap();
        assert!(schemas_match(&source, &derived));
    }

    #[test]
    fn pipeline_folds_steps_in_order() {
        let source = source_schema();
        let steps = vec![
            TransformStep::RemoveColumns {
                columns: vec!["cost".into()],
            },
            TransformStep::RenameColumns {
                renames: vec![crate::transform::ColumnRename::new("amount", "net")],
            },
        ];
        let derived =
            derive_pipeline_schema("Sales", &source, &steps, &crate::transform::NoOtherTables)
                .unwrap();
        let names: Vec<&str> = derived.iter().map(|c| c.name()).collect();
        assert_eq!(names, vec!["id", "region", "status", "net", "order_date"]);
    }

    #[test]
    fn pipeline_error_carries_the_failing_step_index() {
        let source = source_schema();
        let steps = vec![
            TransformStep::RemoveColumns {
                columns: vec!["cost".into()],
            },
            TransformStep::RemoveColumns {
                columns: vec!["cost".into()], // already gone
            },
        ];
        let err =
            derive_pipeline_schema("Sales", &source, &steps, &crate::transform::NoOtherTables)
                .unwrap_err();
        match err {
            EngineError::InvalidTransform {
                table, step_index, ..
            } => {
                assert_eq!(table, "Sales");
                assert_eq!(step_index, 1, "must name the SECOND step");
            }
            other => panic!("expected InvalidTransform, got {other:?}"),
        }
    }

    #[test]
    fn unknown_column_error_lists_the_available_columns() {
        let source = source_schema();
        let steps = vec![TransformStep::RemoveColumns {
            columns: vec!["nope".into()],
        }];
        let err =
            derive_pipeline_schema("Sales", &source, &steps, &crate::transform::NoOtherTables)
                .unwrap_err();
        let message = err.to_string();
        assert!(message.contains("nope"), "got {message}");
        assert!(
            message.contains("region"),
            "must list what IS there: {message}"
        );
    }

    #[test]
    fn a_step_that_removes_every_column_is_rejected() {
        let input = cols(&[("a", DataType::Int64)]);
        let step = TransformStep::RemoveColumns {
            columns: vec!["a".into()],
        };
        let err = derive_step_schema("T", 0, &input, &step, &crate::transform::NoOtherTables)
            .unwrap_err();
        assert!(err.to_string().contains("no columns"), "got {err}");
    }

    #[test]
    fn schemas_match_ignores_presentation_metadata() {
        let plain = cols(&[("a", DataType::Int64)]);
        let decorated = vec![plain[0].clone().with_display_name("A").hidden()];
        assert!(schemas_match(&plain, &decorated));
    }

    #[test]
    fn schemas_match_is_sensitive_to_name_type_nullability_and_order() {
        let base = cols(&[("a", DataType::Int64), ("b", DataType::String)]);
        assert!(!schemas_match(&base, &cols(&[("a", DataType::Int64)])));
        assert!(!schemas_match(
            &base,
            &cols(&[("a", DataType::Int64), ("c", DataType::String)])
        ));
        assert!(!schemas_match(
            &base,
            &cols(&[("a", DataType::Int32), ("b", DataType::String)])
        ));
        assert!(!schemas_match(
            &base,
            &cols(&[("b", DataType::String), ("a", DataType::Int64)])
        ));
        let non_nullable = vec![base[0].clone().with_nullable(false), base[1].clone()];
        assert!(!schemas_match(&base, &non_nullable));
    }
}
