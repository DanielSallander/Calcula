//! Schema-derivation rules for the column-shaping steps.
//!
//! Each function here answers one question: *given this input schema, what
//! columns does this step produce?* None of them read data.

use crate::error::EngineResult;
use crate::model::Column;
use crate::transform::infer::infer_expression_type;
use crate::transform::literal::validate_typed_literal;
use crate::transform::parts::{CastErrorPolicy, ColumnRename, TextOp, TypeChange};
use crate::transform::schema::{require_absent, require_column, require_unique, transform_error};
use crate::types::DataType;

/// Fail unless `column` is a `String` column — the precondition of every text
/// step, checked here so the message names the step instead of surfacing as a
/// DataFusion type error mid-refresh.
fn require_text_column(
    table: &str,
    step_index: usize,
    columns: &[Column],
    name: &str,
    what: &str,
) -> EngineResult<()> {
    let column = require_column(table, step_index, columns, name)?;
    if column.data_type() != &DataType::String {
        return Err(transform_error(
            table,
            step_index,
            format!(
                "{what} needs a text column, but '{name}' is {:?} — cast it with a changeType step first",
                column.data_type()
            ),
        ));
    }
    Ok(())
}

/// `removeColumns`: drop the named columns, keeping the rest in place.
pub(crate) fn remove_columns(
    table: &str,
    step_index: usize,
    input: &[Column],
    columns: &[String],
) -> EngineResult<Vec<Column>> {
    if columns.is_empty() {
        return Err(transform_error(table, step_index, "no columns named"));
    }
    require_unique(table, step_index, columns, "column")?;
    for name in columns {
        require_column(table, step_index, input, name)?;
    }
    Ok(input
        .iter()
        .filter(|c| !columns.iter().any(|n| n == c.name()))
        .cloned()
        .collect())
}

/// `selectColumns`: keep only the named columns, in the order given.
pub(crate) fn select_columns(
    table: &str,
    step_index: usize,
    input: &[Column],
    columns: &[String],
) -> EngineResult<Vec<Column>> {
    if columns.is_empty() {
        return Err(transform_error(table, step_index, "no columns named"));
    }
    require_unique(table, step_index, columns, "column")?;
    columns
        .iter()
        .map(|name| require_column(table, step_index, input, name).cloned())
        .collect()
}

/// `renameColumns`: rename in place, preserving position, type, and metadata.
///
/// Renames apply **in order**, so a swap (`a`→`tmp`, `b`→`a`, `tmp`→`b`) works
/// and each `from` is resolved against the schema as it stands at that point.
pub(crate) fn rename_columns(
    table: &str,
    step_index: usize,
    input: &[Column],
    renames: &[ColumnRename],
) -> EngineResult<Vec<Column>> {
    if renames.is_empty() {
        return Err(transform_error(table, step_index, "no renames given"));
    }
    let mut output = input.to_vec();
    for rename in renames {
        if rename.to.is_empty() {
            return Err(transform_error(
                table,
                step_index,
                format!("cannot rename '{}' to an empty name", rename.from),
            ));
        }
        let position = output
            .iter()
            .position(|c| c.name() == rename.from)
            .ok_or_else(|| {
                transform_error(
                    table,
                    step_index,
                    format!("unknown column '{}'", rename.from),
                )
            })?;
        if rename.from != rename.to {
            require_absent(table, step_index, &output, &rename.to)?;
        }
        output[position] = output[position].clone().with_name(&rename.to);
    }
    Ok(output)
}

/// `changeType`: cast columns, widening to nullable under the null-on-error
/// policy because that policy can itself introduce nulls.
pub(crate) fn change_type(
    table: &str,
    step_index: usize,
    input: &[Column],
    changes: &[TypeChange],
    on_error: CastErrorPolicy,
) -> EngineResult<Vec<Column>> {
    if changes.is_empty() {
        return Err(transform_error(table, step_index, "no type changes given"));
    }
    let names: Vec<String> = changes.iter().map(|c| c.column.clone()).collect();
    require_unique(table, step_index, &names, "column")?;

    let mut output = input.to_vec();
    for change in changes {
        let position = output
            .iter()
            .position(|c| c.name() == change.column)
            .ok_or_else(|| {
                transform_error(
                    table,
                    step_index,
                    format!("unknown column '{}'", change.column),
                )
            })?;
        let from = output[position].data_type().clone();
        if !arrow::compute::can_cast_types(&from.to_arrow(), &change.new_type.to_arrow()) {
            return Err(transform_error(
                table,
                step_index,
                format!(
                    "cannot cast column '{}' from {:?} to {:?}",
                    change.column, from, change.new_type
                ),
            ));
        }
        let mut column = output[position]
            .clone()
            .with_data_type(change.new_type.clone());
        if on_error == CastErrorPolicy::Null {
            column = column.with_nullable(true);
        }
        output[position] = column;
    }
    Ok(output)
}

/// `addColumn`: append one computed column.
///
/// The column is always nullable — a row-level expression can produce null
/// from null inputs, whatever its type.
pub(crate) fn add_column(
    table: &str,
    step_index: usize,
    input: &[Column],
    name: &str,
    expression: &str,
    declared_type: Option<&DataType>,
) -> EngineResult<Vec<Column>> {
    if name.is_empty() {
        return Err(transform_error(table, step_index, "column name is empty"));
    }
    require_absent(table, step_index, input, name)?;

    let data_type = match declared_type {
        Some(declared) => declared.clone(),
        None => infer_expression_type(table, step_index, input, expression)?.ok_or_else(|| {
            transform_error(
                table,
                step_index,
                format!(
                    "cannot infer the type of column '{name}' from its expression — \
                     set an explicit data type on the step"
                ),
            )
        })?,
    };

    let mut output = input.to_vec();
    output.push(Column::new(name, data_type));
    Ok(output)
}

/// `splitColumn`: replace a text column with `parts` text columns named
/// `"{column}.1"` … `"{column}.{parts}"`, in the original's position.
pub(crate) fn split_column(
    table: &str,
    step_index: usize,
    input: &[Column],
    column: &str,
    delimiter: &str,
    parts: u32,
    keep_original: bool,
) -> EngineResult<Vec<Column>> {
    require_text_column(table, step_index, input, column, "splitColumn")?;
    if delimiter.is_empty() {
        return Err(transform_error(table, step_index, "delimiter is empty"));
    }
    if parts < 1 {
        return Err(transform_error(
            table,
            step_index,
            "parts must be at least 1",
        ));
    }
    // A pathological `parts` would blow up the schema; the cap is arbitrary
    // but far beyond any real split, and it keeps a typo from producing a
    // thousand-column table.
    const MAX_PARTS: u32 = 64;
    if parts > MAX_PARTS {
        return Err(transform_error(
            table,
            step_index,
            format!("parts must be at most {MAX_PARTS} (got {parts})"),
        ));
    }

    let position = input
        .iter()
        .position(|c| c.name() == column)
        .expect("presence checked by require_text_column above");

    let new_names: Vec<String> = (1..=parts).map(|i| format!("{column}.{i}")).collect();
    for name in &new_names {
        if input
            .iter()
            .any(|c| c.name() == name && !(keep_original && c.name() == column))
        {
            return Err(transform_error(
                table,
                step_index,
                format!("split would overwrite existing column '{name}'"),
            ));
        }
    }

    let mut output: Vec<Column> = Vec::with_capacity(input.len() + parts as usize);
    output.extend_from_slice(&input[..position]);
    if keep_original {
        output.push(input[position].clone());
    }
    for name in new_names {
        output.push(Column::new(name, DataType::String));
    }
    output.extend_from_slice(&input[position + 1..]);
    Ok(output)
}

/// `replaceValues`: rewrite values within one column. Schema is unchanged;
/// the rule exists to check the column and the mode's precondition.
pub(crate) fn replace_values(
    table: &str,
    step_index: usize,
    input: &[Column],
    column: &str,
    find: &str,
    replace: &str,
    match_entire_value: bool,
) -> EngineResult<Vec<Column>> {
    if match_entire_value {
        // Whole-value replacement compares against a typed literal, so the
        // text has to BE a value of the column's type. Checking it here — at
        // edit time, with no data — is also what keeps the evaluator from ever
        // interpolating author text into a generated statement on trust.
        let target = require_column(table, step_index, input, column)?;
        for (text, role) in [(find, "value to find"), (replace, "replacement")] {
            validate_typed_literal(text, target.data_type()).map_err(|reason| {
                transform_error(
                    table,
                    step_index,
                    format!("{role} for column '{column}': {reason}"),
                )
            })?;
        }
    } else {
        require_text_column(table, step_index, input, column, "substring replaceValues")?;
        if find.is_empty() {
            return Err(transform_error(
                table,
                step_index,
                "the text to find is empty",
            ));
        }
    }
    Ok(input.to_vec())
}

/// `textTransform`: trim/clean/upper/lower over text columns. Schema unchanged.
pub(crate) fn text_transform(
    table: &str,
    step_index: usize,
    input: &[Column],
    columns: &[String],
    operation: TextOp,
) -> EngineResult<Vec<Column>> {
    if columns.is_empty() {
        return Err(transform_error(table, step_index, "no columns named"));
    }
    require_unique(table, step_index, columns, "column")?;
    for name in columns {
        require_text_column(
            table,
            step_index,
            input,
            name,
            &format!("textTransform ({})", operation.as_str()),
        )?;
    }
    Ok(input.to_vec())
}

/// `fillDown`: carry the last non-null value down. Schema unchanged.
pub(crate) fn fill_down(
    table: &str,
    step_index: usize,
    input: &[Column],
    columns: &[String],
) -> EngineResult<Vec<Column>> {
    if columns.is_empty() {
        return Err(transform_error(table, step_index, "no columns named"));
    }
    require_unique(table, step_index, columns, "column")?;
    for name in columns {
        require_column(table, step_index, input, name)?;
    }
    Ok(input.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transform::schema::derive_step_schema;
    use crate::transform::test_support::{cols, names, source_schema};
    use crate::transform::TransformStep;

    fn derive(input: &[Column], step: &TransformStep) -> EngineResult<Vec<Column>> {
        derive_step_schema("Sales", 0, input, step)
    }

    #[test]
    fn remove_columns_keeps_the_rest_in_order() {
        let out = derive(
            &source_schema(),
            &TransformStep::RemoveColumns {
                columns: vec!["cost".into(), "status".into()],
            },
        )
        .unwrap();
        assert_eq!(names(&out), vec!["id", "region", "amount", "order_date"]);
    }

    #[test]
    fn select_columns_reorders_to_the_given_order() {
        let out = derive(
            &source_schema(),
            &TransformStep::SelectColumns {
                columns: vec!["amount".into(), "id".into()],
            },
        )
        .unwrap();
        assert_eq!(names(&out), vec!["amount", "id"]);
    }

    #[test]
    fn select_columns_rejects_a_repeat() {
        let err = derive(
            &source_schema(),
            &TransformStep::SelectColumns {
                columns: vec!["id".into(), "id".into()],
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("duplicate"), "got {err}");
    }

    #[test]
    fn rename_preserves_position_type_and_metadata() {
        let input = vec![
            Column::non_nullable("id", DataType::Int64).with_display_name("Id"),
            Column::new("amount", DataType::Float64),
        ];
        let out = derive(
            &input,
            &TransformStep::RenameColumns {
                renames: vec![ColumnRename::new("id", "key")],
            },
        )
        .unwrap();
        assert_eq!(names(&out), vec!["key", "amount"]);
        assert_eq!(out[0].data_type(), &DataType::Int64);
        assert!(!out[0].nullable());
        assert_eq!(out[0].display_name(), Some("Id"));
    }

    #[test]
    fn sequential_renames_can_swap_two_columns() {
        let input = cols(&[("a", DataType::Int64), ("b", DataType::String)]);
        let out = derive(
            &input,
            &TransformStep::RenameColumns {
                renames: vec![
                    ColumnRename::new("a", "tmp"),
                    ColumnRename::new("b", "a"),
                    ColumnRename::new("tmp", "b"),
                ],
            },
        )
        .unwrap();
        assert_eq!(names(&out), vec!["b", "a"]);
        // The types travelled with the columns, not the names.
        assert_eq!(out[0].data_type(), &DataType::Int64);
        assert_eq!(out[1].data_type(), &DataType::String);
    }

    #[test]
    fn rename_onto_an_existing_name_is_rejected() {
        let err = derive(
            &source_schema(),
            &TransformStep::RenameColumns {
                renames: vec![ColumnRename::new("amount", "cost")],
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("already exists"), "got {err}");
    }

    #[test]
    fn change_type_retypes_in_place() {
        let out = derive(
            &source_schema(),
            &TransformStep::ChangeType {
                changes: vec![TypeChange::new("amount", DataType::Decimal(18, 2))],
                on_error: CastErrorPolicy::Fail,
            },
        )
        .unwrap();
        let amount = out.iter().find(|c| c.name() == "amount").unwrap();
        assert_eq!(amount.data_type(), &DataType::Decimal(18, 2));
    }

    #[test]
    fn null_on_error_cast_widens_the_column_to_nullable() {
        let input = vec![Column::non_nullable("qty", DataType::String)];
        let out = derive(
            &input,
            &TransformStep::ChangeType {
                changes: vec![TypeChange::new("qty", DataType::Int64)],
                on_error: CastErrorPolicy::Null,
            },
        )
        .unwrap();
        assert!(
            out[0].nullable(),
            "a null-on-error cast can introduce nulls, so the column must widen"
        );
    }

    #[test]
    fn failing_cast_policy_leaves_nullability_alone() {
        let input = vec![Column::non_nullable("qty", DataType::String)];
        let out = derive(
            &input,
            &TransformStep::ChangeType {
                changes: vec![TypeChange::new("qty", DataType::Int64)],
                on_error: CastErrorPolicy::Fail,
            },
        )
        .unwrap();
        assert!(!out[0].nullable());
    }

    #[test]
    fn impossible_cast_is_rejected_statically() {
        let input = cols(&[("flag", DataType::Boolean)]);
        let err = derive(
            &input,
            &TransformStep::ChangeType {
                changes: vec![TypeChange::new("flag", DataType::Date)],
                on_error: CastErrorPolicy::Fail,
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("cannot cast"), "got {err}");
    }

    #[test]
    fn add_column_appends_a_nullable_column_with_the_declared_type() {
        let out = derive(
            &source_schema(),
            &TransformStep::AddColumn {
                name: "margin".into(),
                expression: "amount - cost".into(),
                data_type: Some(DataType::Float64),
            },
        )
        .unwrap();
        let added = out.last().unwrap();
        assert_eq!(added.name(), "margin");
        assert_eq!(added.data_type(), &DataType::Float64);
        assert!(added.nullable());
    }

    #[test]
    fn add_column_onto_an_existing_name_is_rejected() {
        let err = derive(
            &source_schema(),
            &TransformStep::AddColumn {
                name: "amount".into(),
                expression: "1".into(),
                data_type: Some(DataType::Int64),
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("already exists"), "got {err}");
    }

    #[test]
    fn split_replaces_the_original_in_its_position() {
        let input = cols(&[
            ("id", DataType::Int64),
            ("customer", DataType::String),
            ("amount", DataType::Float64),
        ]);
        let out = derive(
            &input,
            &TransformStep::SplitColumn {
                column: "customer".into(),
                delimiter: " ".into(),
                parts: 2,
                keep_original: false,
            },
        )
        .unwrap();
        assert_eq!(
            names(&out),
            vec!["id", "customer.1", "customer.2", "amount"]
        );
        assert_eq!(out[1].data_type(), &DataType::String);
    }

    #[test]
    fn split_can_keep_the_original() {
        let input = cols(&[("customer", DataType::String)]);
        let out = derive(
            &input,
            &TransformStep::SplitColumn {
                column: "customer".into(),
                delimiter: " ".into(),
                parts: 2,
                keep_original: true,
            },
        )
        .unwrap();
        assert_eq!(names(&out), vec!["customer", "customer.1", "customer.2"]);
    }

    #[test]
    fn split_of_a_non_text_column_is_rejected() {
        let err = derive(
            &source_schema(),
            &TransformStep::SplitColumn {
                column: "amount".into(),
                delimiter: " ".into(),
                parts: 2,
                keep_original: false,
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("text column"), "got {err}");
    }

    #[test]
    fn split_rejects_an_empty_delimiter_and_absurd_part_counts() {
        let input = cols(&[("customer", DataType::String)]);
        assert!(derive(
            &input,
            &TransformStep::SplitColumn {
                column: "customer".into(),
                delimiter: String::new(),
                parts: 2,
                keep_original: false,
            }
        )
        .is_err());
        assert!(derive(
            &input,
            &TransformStep::SplitColumn {
                column: "customer".into(),
                delimiter: ",".into(),
                parts: 5000,
                keep_original: false,
            }
        )
        .is_err());
    }

    #[test]
    fn value_and_text_steps_leave_the_schema_untouched() {
        let input = source_schema();
        for step in [
            TransformStep::ReplaceValues {
                column: "status".into(),
                find: "old".into(),
                replace: "new".into(),
                match_entire_value: false,
            },
            TransformStep::TextTransform {
                columns: vec!["status".into(), "region".into()],
                operation: TextOp::Trim,
            },
            TransformStep::FillDown {
                columns: vec!["region".into()],
            },
        ] {
            let out = derive(&input, &step).unwrap();
            assert_eq!(
                names(&out),
                names(&input),
                "step {} changed the schema",
                step.type_name()
            );
        }
    }

    #[test]
    fn whole_value_replace_is_allowed_on_a_non_text_column() {
        let out = derive(
            &source_schema(),
            &TransformStep::ReplaceValues {
                column: "amount".into(),
                find: "0".into(),
                replace: "1".into(),
                match_entire_value: true,
            },
        )
        .unwrap();
        assert_eq!(names(&out), names(&source_schema()));
    }

    #[test]
    fn whole_value_replace_refuses_text_that_is_not_a_value_of_the_column_type() {
        // REGRESSION: the evaluator renders a numeric/boolean literal BARE, so
        // text that is not a number used to be interpolated straight into the
        // generated statement. Refusing it here is what stops that at the door,
        // and gives the author a message while they are still editing.
        for find in ["0 OR 1=1", "abc", "1; DROP TABLE t", "--"] {
            let err = derive(
                &source_schema(),
                &TransformStep::ReplaceValues {
                    column: "amount".into(),
                    find: find.into(),
                    replace: "1".into(),
                    match_entire_value: true,
                },
            )
            .unwrap_err();
            assert!(
                err.to_string().contains("value to find"),
                "'{find}' must be refused by name; got {err}"
            );
        }

        // The replacement half is checked too, not just the needle.
        let err = derive(
            &source_schema(),
            &TransformStep::ReplaceValues {
                column: "amount".into(),
                find: "1".into(),
                replace: "0); DROP TABLE t; --".into(),
                match_entire_value: true,
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("replacement"), "got {err}");
    }

    #[test]
    fn substring_replace_on_a_non_text_column_is_rejected() {
        let err = derive(
            &source_schema(),
            &TransformStep::ReplaceValues {
                column: "amount".into(),
                find: "0".into(),
                replace: "1".into(),
                match_entire_value: false,
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("text column"), "got {err}");
    }
}
