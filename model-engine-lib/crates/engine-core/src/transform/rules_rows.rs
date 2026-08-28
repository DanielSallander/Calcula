//! Schema-derivation rules for the row-shaping and reshaping steps.

use crate::compute::aggregate::AggregateOp;
use crate::error::EngineResult;
use crate::model::Column;
use crate::transform::infer::infer_parsed_type;
use crate::transform::parts::{GroupAggregate, RowRange, SortKey};
use crate::transform::schema::{require_column, require_unique, transform_error};
use crate::transform::validate::parse_row_expression;
use crate::types::DataType;

/// Returns `true` for the types an arithmetic aggregate accepts.
fn is_numeric(data_type: &DataType) -> bool {
    matches!(
        data_type,
        DataType::Int32 | DataType::Int64 | DataType::Float64 | DataType::Decimal(_, _)
    )
}

/// The type an aggregate produces over an input column type, or `None` when
/// the combination is not supported.
///
/// `SUM` over a `Decimal` widens to `Float64` rather than trying to derive a
/// result precision: a transform pipeline's job is shaping, and a model author
/// who needs exact decimal totals should keep the column `Decimal` and
/// aggregate in a measure, where the engine's decimal handling applies.
pub(crate) fn aggregate_output_type(
    operation: AggregateOp,
    input: Option<&DataType>,
) -> Option<DataType> {
    match operation {
        AggregateOp::Count | AggregateOp::CountRows | AggregateOp::DistinctCount => {
            Some(DataType::Int64)
        }
        AggregateOp::Sum => match input? {
            DataType::Int32 | DataType::Int64 => Some(DataType::Int64),
            DataType::Float64 | DataType::Decimal(_, _) => Some(DataType::Float64),
            _ => None,
        },
        AggregateOp::Average
        | AggregateOp::Median
        | AggregateOp::StdevSample
        | AggregateOp::StdevPop
        | AggregateOp::VarSample
        | AggregateOp::VarPop => {
            if is_numeric(input?) {
                Some(DataType::Float64)
            } else {
                None
            }
        }
        AggregateOp::Min | AggregateOp::Max | AggregateOp::AnyValue => Some(input?.clone()),
        // MODE has no portable DataFusion spelling in the version this engine
        // targets. Rejecting it is better than emitting SQL that fails at
        // refresh, far from the step that caused it.
        AggregateOp::Mode => None,
    }
}

/// `filterRows`: schema unchanged. The condition itself is checked by
/// [`validate_steps`](crate::transform::validate_steps), which has the parser.
pub(crate) fn filter_rows(
    _table: &str,
    _step_index: usize,
    input: &[Column],
    _condition: &str,
) -> EngineResult<Vec<Column>> {
    Ok(input.to_vec())
}

/// `removeDuplicates`: schema unchanged; the subset must exist.
pub(crate) fn remove_duplicates(
    table: &str,
    step_index: usize,
    input: &[Column],
    columns: &[String],
) -> EngineResult<Vec<Column>> {
    require_unique(table, step_index, columns, "column")?;
    for name in columns {
        require_column(table, step_index, input, name)?;
    }
    Ok(input.to_vec())
}

/// `sort`: schema unchanged; every key must exist.
pub(crate) fn sort(
    table: &str,
    step_index: usize,
    input: &[Column],
    by: &[SortKey],
) -> EngineResult<Vec<Column>> {
    if by.is_empty() {
        return Err(transform_error(table, step_index, "no sort keys given"));
    }
    let names: Vec<String> = by.iter().map(|k| k.column.clone()).collect();
    require_unique(table, step_index, &names, "sort key")?;
    for key in by {
        require_column(table, step_index, input, &key.column)?;
    }
    Ok(input.to_vec())
}

/// `groupBy`: the grouping columns followed by the aggregate aliases.
///
/// Every other column is dropped — that is the point of the step, and saying
/// so in the schema is what lets validation catch a measure that still refers
/// to a column the pipeline collapsed away.
pub(crate) fn group_by(
    table: &str,
    step_index: usize,
    input: &[Column],
    group_by: &[String],
    aggregates: &[GroupAggregate],
) -> EngineResult<Vec<Column>> {
    if group_by.is_empty() && aggregates.is_empty() {
        return Err(transform_error(
            table,
            step_index,
            "a groupBy step needs at least one grouping column or aggregate",
        ));
    }
    require_unique(table, step_index, group_by, "grouping column")?;

    let mut output: Vec<Column> = Vec::with_capacity(group_by.len() + aggregates.len());
    for name in group_by {
        output.push(require_column(table, step_index, input, name)?.clone());
    }

    let aliases: Vec<String> = aggregates.iter().map(|a| a.alias.clone()).collect();
    require_unique(table, step_index, &aliases, "aggregate alias")?;

    for aggregate in aggregates {
        if aggregate.alias.is_empty() {
            return Err(transform_error(
                table,
                step_index,
                format!("aggregate {} has no output name", aggregate.function),
            ));
        }
        if output.iter().any(|c| c.name() == aggregate.alias) {
            return Err(transform_error(
                table,
                step_index,
                format!(
                    "aggregate output '{}' collides with a grouping column",
                    aggregate.alias
                ),
            ));
        }

        let input_type = match (&aggregate.expression, aggregate.function) {
            // COUNTROWS counts rows; an operand — column or formula — is a
            // contradiction, not a detail to ignore.
            (Some(_), AggregateOp::CountRows) => {
                return Err(transform_error(
                    table,
                    step_index,
                    format!(
                        "aggregate '{}': COUNTROWS counts rows and takes no formula — use \
                         COUNT over a formula that is BLANK() for the rows to skip",
                        aggregate.alias
                    ),
                ));
            }
            (Some(expression), _) => {
                if !aggregate.column.is_empty() {
                    return Err(transform_error(
                        table,
                        step_index,
                        format!(
                            "aggregate '{}' names both a column and a formula — give one or \
                             the other",
                            aggregate.alias
                        ),
                    ));
                }
                // The SUMIF shape. The formula goes through the SAME row-level
                // parse as filterRows/addColumn — allowlist, bracket
                // resolution, column existence — so it can never itself
                // aggregate. Its INFERRED type stands in for the column type:
                // there is no name to look a type up by, and the cast decision
                // downstream must not guess.
                let parsed = parse_row_expression(table, step_index, input, expression)?;
                Some(infer_parsed_type(&parsed, input).ok_or_else(|| {
                    transform_error(
                        table,
                        step_index,
                        format!(
                            "cannot infer the type of aggregate '{}' from its formula — make \
                             its branches the same type (a BLANK() branch adopts the other \
                             branch's), or aggregate a typed column added by an earlier step",
                            aggregate.alias
                        ),
                    )
                })?)
            }
            (None, AggregateOp::CountRows) => None,
            (None, _) => Some(
                require_column(table, step_index, input, &aggregate.column)?
                    .data_type()
                    .clone(),
            ),
        };
        let output_type = aggregate_output_type(aggregate.function, input_type.as_ref())
            .ok_or_else(|| {
                transform_error(
                    table,
                    step_index,
                    match (&input_type, &aggregate.expression) {
                        (Some(t), Some(_)) => format!(
                            "{} is not supported over aggregate '{}''s formula, whose type \
                             is {:?}",
                            aggregate.function, aggregate.alias, t
                        ),
                        (Some(t), None) => format!(
                            "{} is not supported over column '{}' of type {:?}",
                            aggregate.function, aggregate.column, t
                        ),
                        (None, _) => format!("{} is not supported here", aggregate.function),
                    },
                )
            })?;
        // Aggregates over an empty group produce null, so every aggregate
        // output is nullable regardless of its input's nullability.
        output.push(Column::new(&aggregate.alias, output_type));
    }
    Ok(output)
}

/// `keepRows` / `removeRows`: schema unchanged; the range must be meaningful.
pub(crate) fn row_range(
    table: &str,
    step_index: usize,
    input: &[Column],
    range: &RowRange,
) -> EngineResult<Vec<Column>> {
    if range.requested_count() == 0 {
        return Err(transform_error(
            table,
            step_index,
            "row count must be at least 1",
        ));
    }
    Ok(input.to_vec())
}

/// `unpivot`: the kept columns, then the attribute-name and value columns.
pub(crate) fn unpivot(
    table: &str,
    step_index: usize,
    input: &[Column],
    columns: &[String],
    name_column: &str,
    value_column: &str,
) -> EngineResult<Vec<Column>> {
    if columns.is_empty() {
        return Err(transform_error(table, step_index, "no columns to unpivot"));
    }
    require_unique(table, step_index, columns, "column")?;
    if name_column.is_empty() || value_column.is_empty() {
        return Err(transform_error(
            table,
            step_index,
            "the attribute-name and value columns must both be named",
        ));
    }
    if name_column == value_column {
        return Err(transform_error(
            table,
            step_index,
            format!("the attribute-name and value columns are both '{name_column}'"),
        ));
    }

    let mut unpivoted_types = Vec::with_capacity(columns.len());
    for name in columns {
        unpivoted_types.push(
            require_column(table, step_index, input, name)?
                .data_type()
                .clone(),
        );
    }

    // One value column has to hold every unpivoted column's values: keep the
    // shared type when they agree, otherwise fall back to text (every type
    // casts to text, so this never fails at refresh).
    let value_type = if unpivoted_types.windows(2).all(|w| w[0] == w[1]) {
        unpivoted_types[0].clone()
    } else {
        DataType::String
    };

    let kept: Vec<Column> = input
        .iter()
        .filter(|c| !columns.iter().any(|n| n == c.name()))
        .cloned()
        .collect();
    for reserved in [name_column, value_column] {
        if kept.iter().any(|c| c.name() == reserved) {
            return Err(transform_error(
                table,
                step_index,
                format!("column '{reserved}' already exists and is not being unpivoted"),
            ));
        }
    }

    let mut output = kept;
    output.push(Column::non_nullable(name_column, DataType::String));
    output.push(Column::new(value_column, value_type));
    Ok(output)
}

/// `pivot`: the remaining columns, then one column per declared value name.
pub(crate) fn pivot(
    table: &str,
    step_index: usize,
    input: &[Column],
    name_column: &str,
    value_column: &str,
    aggregate: AggregateOp,
    value_names: &[String],
) -> EngineResult<Vec<Column>> {
    if name_column == value_column {
        return Err(transform_error(
            table,
            step_index,
            format!("the name and value columns are both '{name_column}'"),
        ));
    }
    let name_col = require_column(table, step_index, input, name_column)?;
    if name_col.data_type() != &DataType::String {
        return Err(transform_error(
            table,
            step_index,
            format!(
                "pivot needs a text column for the new column names, but '{name_column}' is {:?}",
                name_col.data_type()
            ),
        ));
    }
    let value_type = require_column(table, step_index, input, value_column)?
        .data_type()
        .clone();

    if value_names.is_empty() {
        return Err(transform_error(
            table,
            step_index,
            "no value names declared — a pivot step's output columns must be declared, \
             not discovered from the data",
        ));
    }
    require_unique(table, step_index, value_names, "value name")?;

    let output_type = aggregate_output_type(aggregate, Some(&value_type)).ok_or_else(|| {
        transform_error(
            table,
            step_index,
            format!(
                "{aggregate} is not supported over column '{value_column}' of type {value_type:?}"
            ),
        )
    })?;

    let mut output: Vec<Column> = input
        .iter()
        .filter(|c| c.name() != name_column && c.name() != value_column)
        .cloned()
        .collect();

    for value_name in value_names {
        if value_name.is_empty() {
            return Err(transform_error(table, step_index, "a value name is empty"));
        }
        if output.iter().any(|c| c.name() == value_name) {
            return Err(transform_error(
                table,
                step_index,
                format!("pivot output '{value_name}' collides with an existing column"),
            ));
        }
        output.push(Column::new(value_name, output_type.clone()));
    }
    Ok(output)
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
    fn row_filtering_steps_leave_the_schema_untouched() {
        let input = source_schema();
        for step in [
            TransformStep::FilterRows {
                condition: "amount > 0".into(),
            },
            TransformStep::RemoveDuplicates {
                columns: vec!["id".into()],
            },
            TransformStep::Sort {
                by: vec![SortKey::descending("amount")],
            },
            TransformStep::KeepRows {
                range: RowRange::FirstN { count: 10 },
            },
            TransformStep::RemoveRows {
                range: RowRange::LastN { count: 2 },
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
    fn remove_duplicates_over_every_column_needs_no_subset() {
        let out = derive(
            &source_schema(),
            &TransformStep::RemoveDuplicates { columns: vec![] },
        )
        .unwrap();
        assert_eq!(names(&out), names(&source_schema()));
    }

    #[test]
    fn a_zero_row_range_is_rejected() {
        let err = derive(
            &source_schema(),
            &TransformStep::KeepRows {
                range: RowRange::FirstN { count: 0 },
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("at least 1"), "got {err}");
    }

    #[test]
    fn group_by_outputs_keys_then_aggregates_and_drops_the_rest() {
        let out = derive(
            &source_schema(),
            &TransformStep::GroupBy {
                group_by: vec!["region".into()],
                aggregates: vec![
                    GroupAggregate::new("amount", AggregateOp::Sum, "total"),
                    GroupAggregate::count_rows("orders"),
                ],
            },
        )
        .unwrap();
        assert_eq!(names(&out), vec!["region", "total", "orders"]);
        assert_eq!(out[1].data_type(), &DataType::Float64);
        assert_eq!(out[2].data_type(), &DataType::Int64);
        assert!(
            out[1].nullable(),
            "an aggregate over an empty group is null"
        );
    }

    #[test]
    fn a_formula_aggregate_types_from_its_inferred_operand() {
        // The SUMIF shape. The operand has no column name, so the cast and
        // output-type decisions run off the formula's INFERRED type — here
        // `IF(..., [amount], BLANK())` infers Float64, so Sum declares Float64.
        let out = derive(
            &source_schema(),
            &TransformStep::GroupBy {
                group_by: vec!["region".into()],
                aggregates: vec![GroupAggregate::formula(
                    AggregateOp::Sum,
                    "open_total",
                    "IF([status] = \"open\", [amount], BLANK())",
                )],
            },
        )
        .unwrap();
        assert_eq!(names(&out), vec!["region", "open_total"]);
        assert_eq!(out[1].data_type(), &DataType::Float64);
        assert!(out[1].nullable());
    }

    #[test]
    fn a_formula_aggregate_with_both_column_and_formula_is_refused() {
        let mut aggregate =
            GroupAggregate::formula(AggregateOp::Sum, "t", "IF([amount] > 0, [amount], BLANK())");
        aggregate.column = "amount".into();
        let err = derive(
            &source_schema(),
            &TransformStep::GroupBy {
                group_by: vec!["region".into()],
                aggregates: vec![aggregate],
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("one or the other"), "got {err}");
    }

    #[test]
    fn countrows_with_a_formula_is_refused_and_points_at_count() {
        let err = derive(
            &source_schema(),
            &TransformStep::GroupBy {
                group_by: vec!["region".into()],
                aggregates: vec![GroupAggregate::formula(
                    AggregateOp::CountRows,
                    "n",
                    "IF([amount] > 0, 1, BLANK())",
                )],
            },
        )
        .unwrap_err();
        assert!(
            err.to_string().contains("COUNT over a formula"),
            "got {err}"
        );
    }

    #[test]
    fn a_formula_aggregate_cannot_itself_aggregate() {
        // The fail-closed allowlist runs on the operand formula too, so
        // nesting an aggregate inside an aggregate is refused by name rather
        // than reaching SQL generation.
        let err = derive(
            &source_schema(),
            &TransformStep::GroupBy {
                group_by: vec!["region".into()],
                aggregates: vec![GroupAggregate::formula(
                    AggregateOp::Sum,
                    "t",
                    "SUM(amount) * 2",
                )],
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("aggregation"), "got {err}");
    }

    #[test]
    fn a_formula_naming_an_unknown_column_is_refused_by_name() {
        let err = derive(
            &source_schema(),
            &TransformStep::GroupBy {
                group_by: vec!["region".into()],
                aggregates: vec![GroupAggregate::formula(
                    AggregateOp::Sum,
                    "t",
                    "IF([nope] > 0, [amount], BLANK())",
                )],
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("nope"), "got {err}");
    }

    #[test]
    fn an_untypeable_formula_asks_for_typed_branches() {
        let err = derive(
            &source_schema(),
            &TransformStep::GroupBy {
                group_by: vec!["region".into()],
                aggregates: vec![GroupAggregate::formula(
                    AggregateOp::Sum,
                    "t",
                    "IF([amount] > 0, \"x\", 1)",
                )],
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("branches"), "got {err}");
    }

    #[test]
    fn group_by_keeps_the_key_column_type() {
        let out = derive(
            &source_schema(),
            &TransformStep::GroupBy {
                group_by: vec!["order_date".into()],
                aggregates: vec![GroupAggregate::count_rows("n")],
            },
        )
        .unwrap();
        assert_eq!(out[0].data_type(), &DataType::Date);
    }

    #[test]
    fn sum_over_integers_stays_integral() {
        let input = cols(&[("region", DataType::String), ("qty", DataType::Int32)]);
        let out = derive(
            &input,
            &TransformStep::GroupBy {
                group_by: vec!["region".into()],
                aggregates: vec![GroupAggregate::new("qty", AggregateOp::Sum, "total_qty")],
            },
        )
        .unwrap();
        assert_eq!(out[1].data_type(), &DataType::Int64);
    }

    #[test]
    fn min_and_max_preserve_the_input_type() {
        let out = derive(
            &source_schema(),
            &TransformStep::GroupBy {
                group_by: vec!["region".into()],
                aggregates: vec![GroupAggregate::new(
                    "order_date",
                    AggregateOp::Max,
                    "latest",
                )],
            },
        )
        .unwrap();
        assert_eq!(out[1].data_type(), &DataType::Date);
    }

    #[test]
    fn summing_a_text_column_is_rejected() {
        let err = derive(
            &source_schema(),
            &TransformStep::GroupBy {
                group_by: vec!["region".into()],
                aggregates: vec![GroupAggregate::new("status", AggregateOp::Sum, "x")],
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("not supported"), "got {err}");
    }

    #[test]
    fn counting_a_text_column_is_fine() {
        let out = derive(
            &source_schema(),
            &TransformStep::GroupBy {
                group_by: vec!["region".into()],
                aggregates: vec![GroupAggregate::new(
                    "status",
                    AggregateOp::DistinctCount,
                    "statuses",
                )],
            },
        )
        .unwrap();
        assert_eq!(out[1].data_type(), &DataType::Int64);
    }

    #[test]
    fn mode_is_rejected_rather_than_emitting_sql_that_fails_at_refresh() {
        let err = derive(
            &source_schema(),
            &TransformStep::GroupBy {
                group_by: vec!["region".into()],
                aggregates: vec![GroupAggregate::new("status", AggregateOp::Mode, "common")],
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("not supported"), "got {err}");
    }

    #[test]
    fn an_aggregate_alias_colliding_with_a_key_is_rejected() {
        let err = derive(
            &source_schema(),
            &TransformStep::GroupBy {
                group_by: vec!["region".into()],
                aggregates: vec![GroupAggregate::new("amount", AggregateOp::Sum, "region")],
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("collides"), "got {err}");
    }

    #[test]
    fn unpivot_keeps_other_columns_and_appends_name_and_value() {
        let input = cols(&[
            ("product", DataType::String),
            ("jan", DataType::Float64),
            ("feb", DataType::Float64),
        ]);
        let out = derive(
            &input,
            &TransformStep::Unpivot {
                columns: vec!["jan".into(), "feb".into()],
                name_column: "month".into(),
                value_column: "amount".into(),
            },
        )
        .unwrap();
        assert_eq!(names(&out), vec!["product", "month", "amount"]);
        assert_eq!(out[1].data_type(), &DataType::String);
        assert!(!out[1].nullable(), "the attribute name is always written");
        assert_eq!(out[2].data_type(), &DataType::Float64);
    }

    #[test]
    fn unpivot_of_mixed_types_falls_back_to_text() {
        let input = cols(&[
            ("id", DataType::Int64),
            ("qty", DataType::Int64),
            ("note", DataType::String),
        ]);
        let out = derive(
            &input,
            &TransformStep::Unpivot {
                columns: vec!["qty".into(), "note".into()],
                name_column: "attribute".into(),
                value_column: "value".into(),
            },
        )
        .unwrap();
        assert_eq!(out[2].data_type(), &DataType::String);
    }

    #[test]
    fn unpivot_onto_a_surviving_column_name_is_rejected() {
        let input = cols(&[
            ("month", DataType::String),
            ("jan", DataType::Float64),
            ("feb", DataType::Float64),
        ]);
        let err = derive(
            &input,
            &TransformStep::Unpivot {
                columns: vec!["jan".into(), "feb".into()],
                name_column: "month".into(),
                value_column: "amount".into(),
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("already exists"), "got {err}");
    }

    #[test]
    fn pivot_produces_one_column_per_declared_value() {
        let input = cols(&[
            ("region", DataType::String),
            ("quarter", DataType::String),
            ("amount", DataType::Float64),
        ]);
        let out = derive(
            &input,
            &TransformStep::Pivot {
                name_column: "quarter".into(),
                value_column: "amount".into(),
                aggregate: AggregateOp::Sum,
                value_names: vec!["Q1".into(), "Q2".into()],
            },
        )
        .unwrap();
        assert_eq!(names(&out), vec!["region", "Q1", "Q2"]);
        assert_eq!(out[1].data_type(), &DataType::Float64);
    }

    #[test]
    fn pivot_without_declared_values_is_rejected() {
        let input = cols(&[
            ("region", DataType::String),
            ("quarter", DataType::String),
            ("amount", DataType::Float64),
        ]);
        let err = derive(
            &input,
            &TransformStep::Pivot {
                name_column: "quarter".into(),
                value_column: "amount".into(),
                aggregate: AggregateOp::Sum,
                value_names: vec![],
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("declared"), "got {err}");
    }

    #[test]
    fn pivot_needs_a_text_name_column() {
        let input = cols(&[
            ("region", DataType::String),
            ("year", DataType::Int64),
            ("amount", DataType::Float64),
        ]);
        let err = derive(
            &input,
            &TransformStep::Pivot {
                name_column: "year".into(),
                value_column: "amount".into(),
                aggregate: AggregateOp::Sum,
                value_names: vec!["2024".into()],
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("text column"), "got {err}");
    }

    #[test]
    fn aggregate_output_type_table() {
        use AggregateOp::*;
        assert_eq!(
            aggregate_output_type(Sum, Some(&DataType::Decimal(18, 2))),
            Some(DataType::Float64)
        );
        assert_eq!(
            aggregate_output_type(Average, Some(&DataType::Int64)),
            Some(DataType::Float64)
        );
        assert_eq!(
            aggregate_output_type(CountRows, None),
            Some(DataType::Int64)
        );
        assert_eq!(
            aggregate_output_type(Min, Some(&DataType::String)),
            Some(DataType::String)
        );
        assert_eq!(
            aggregate_output_type(Average, Some(&DataType::String)),
            None
        );
        assert_eq!(aggregate_output_type(Sum, Some(&DataType::Boolean)), None);
        assert_eq!(aggregate_output_type(Mode, Some(&DataType::String)), None);
        // A value aggregate with no operand cannot be typed.
        assert_eq!(aggregate_output_type(Sum, None), None);
    }
}
