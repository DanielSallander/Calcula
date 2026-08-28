//! Pipeline validation: parse and check every expression, then derive.
//!
//! # Why the expression check is an allowlist
//!
//! A transformation step runs over **one table's rows, before the table joins
//! the model**. There is no filter context, no relationship to traverse, no
//! other table to aggregate. Most of the expression language is therefore
//! meaningless here, and some of it (a measure reference, a `QUERY`) would
//! recurse into machinery that does not exist yet at refresh time.
//!
//! [`ensure_row_level`] lists the node kinds a step **may** contain and
//! rejects everything else — so a variant added to
//! [`Expression`](crate::compute::expression::Expression) later is rejected by
//! default rather than silently admitted into a context it was never designed
//! for. That is the same fail-closed posture the rest of the engine takes.

use crate::compute::expression::{child_expressions, Expression};
use crate::compute::parser::parse_refresh_filter;
use crate::error::{EngineError, EngineResult};
use crate::model::Column;
use crate::transform::schema::{derive_step_schema, transform_error};
use crate::transform::TransformStep;
use crate::types::DataType;

/// Parse a step's expression source and check that it is a row-level
/// expression over this table's columns.
///
/// Returns the parsed tree so callers (type inference, the evaluator) do not
/// parse twice.
///
/// # Errors
///
/// [`EngineError::InvalidTransform`] carrying the step index for a syntax
/// error, a non-row-level construct, or a reference to a column this step's
/// input does not have.
pub(crate) fn parse_row_expression(
    table: &str,
    step_index: usize,
    input: &[Column],
    source: &str,
) -> EngineResult<Expression> {
    if source.trim().is_empty() {
        return Err(transform_error(
            table,
            step_index,
            "the expression is empty",
        ));
    }

    // The CONDITION grammar, not the measure-expression grammar: it accepts a
    // top-level comparison (`amount > 0`) as well as a plain value expression
    // (`amount - cost`), and a step needs both — `filterRows` is a condition,
    // and `addColumn` may legitimately compute a boolean flag column.
    let parsed = parse_refresh_filter(source).map_err(|error| match error {
        EngineError::ParseError { position, message } => transform_error(
            table,
            step_index,
            format!(
                "could not parse the expression at position {position}: {}",
                // The shared condition parser words its errors for its original
                // caller; say "expression" so the message fits where it shows.
                message.replace("refresh filter", "expression")
            ),
        ),
        other => transform_error(table, step_index, other.to_string()),
    })?;

    // `[Name]` means a COLUMN here, before the allowlist sees it.
    //
    // A leading bracket is a measure reference everywhere else in this language
    // (`parser::grammar`, `parse_atom` routes `[` to `parse_measure_ref`), so
    // without this `LEFT([status], 3)` parses as `LEFT(MeasureRef("status"), 3)`
    // and is refused — while `LEFT(status, 3)` works. That is the spelling an
    // author reaches for first: our own CLI reference taught the bracketed form
    // for a year before anyone noticed the engine refused it.
    //
    // Resolving rather than teaching the prohibition is safe HERE and only
    // here: a step runs before its table joins the model, so there is no filter
    // context and no measure to be confused with. A bracketed name that is NOT
    // a column of this step's input is left untouched and still fails as a
    // measure reference a moment later — so this widens what parses, never what
    // is allowed.
    let parsed = resolve_bracketed_columns(&parsed, input);

    // A `MeasureRef` that SURVIVED resolution is, in a transform context, far
    // more often a mistyped COLUMN than a genuine measure attempt — the author
    // typed `[nope]` next to columns they spelled with the same brackets. The
    // generic allowlist refusal would say "measure reference", which is true
    // and useless for the typo; name the columns instead, and mention measures
    // second.
    if let Some(name) = find_measure_ref(&parsed) {
        let available = input
            .iter()
            .map(Column::name)
            .collect::<Vec<_>>()
            .join(", ");
        return Err(transform_error(
            table,
            step_index,
            format!(
                "'[{name}]' is not a column of this step — its columns are: {available}. \
                 (A measure cannot be used here either: measures are evaluated over the \
                 finished model, not while a table is being built.)"
            ),
        ));
    }

    ensure_row_level(table, step_index, &parsed)?;
    ensure_columns_exist(table, step_index, input, &parsed)?;
    Ok(parsed)
}

/// The first `MeasureRef` anywhere in the tree, if any survived resolution.
fn find_measure_ref(expression: &Expression) -> Option<&str> {
    if let Expression::MeasureRef(name) = expression {
        return Some(name);
    }
    child_expressions(expression)
        .into_iter()
        .find_map(find_measure_ref)
}

/// Rewrite every `MeasureRef` naming a column of `input` into a `ColumnRef`.
///
/// Pure and data-free: the substitution environment is built from the step's
/// input SCHEMA, so this cannot make schema derivation depend on values.
///
/// Reuses [`Expression::substitute_measure_refs`], which already recurses
/// through every non-leaf variant the allowlist admits — writing a second
/// walker here would be a second thing to keep in step with the enum.
fn resolve_bracketed_columns(expression: &Expression, input: &[Column]) -> Expression {
    let env: std::collections::HashMap<String, Expression> = input
        .iter()
        .map(|column| {
            (
                column.name().to_string(),
                Expression::ColumnRef(column.name().to_string()),
            )
        })
        .collect();
    expression.substitute_measure_refs(&env)
}

/// Reject any construct that is not a per-row computation over this table.
fn ensure_row_level(table: &str, step_index: usize, expression: &Expression) -> EngineResult<()> {
    // Name the three mistakes people actually make, before the generic
    // rejection — "SUM(amount) is an aggregation" is a far more useful
    // message than "unsupported construct".
    let specific: Option<&str> = match expression {
        Expression::Aggregate { .. } => Some(
            "an aggregation. A step computes one value per row; to aggregate, \
             use a groupBy step (or define a measure on the finished table)",
        ),
        Expression::MeasureRef(_) => Some(
            "a measure reference. Measures are evaluated over the finished \
             model, not while a table is being built",
        ),
        Expression::Query { .. } => Some("a QUERY expression, which produces a table, not a value"),
        Expression::TableRef(_) => Some("a table reference, which is not a per-row value"),
        _ => None,
    };
    if let Some(reason) = specific {
        return Err(transform_error(
            table,
            step_index,
            format!("the expression contains {reason}"),
        ));
    }

    let allowed = matches!(
        expression,
        Expression::ColumnRef(_)
            | Expression::QualifiedColumnRef { .. }
            | Expression::LiteralFloat(_)
            | Expression::LiteralInt(_)
            | Expression::LiteralString(_)
            | Expression::LiteralBool(_)
            | Expression::LiteralDate(_)
            | Expression::Blank
            | Expression::BinaryOp { .. }
            | Expression::Comparison { .. }
            | Expression::And(_, _)
            | Expression::Or(_, _)
            | Expression::Not(_)
            | Expression::Xor(_, _)
            | Expression::If { .. }
            | Expression::Switch { .. }
            | Expression::Coalesce(_)
            | Expression::NullIf { .. }
            | Expression::SafeDivide { .. }
            | Expression::IsBlank(_)
            | Expression::IfError { .. }
            | Expression::Greatest(_)
            | Expression::Least(_)
            | Expression::InList { .. }
            | Expression::ScalarFunc { .. }
            | Expression::TextFunc { .. }
            | Expression::DateTimeFunc { .. }
            | Expression::Call { .. }
    );
    if !allowed {
        return Err(transform_error(
            table,
            step_index,
            "the expression uses a construct that is not available in a \
             transformation step. A step computes per-row values over this \
             table's own columns: arithmetic, comparisons, IF/SWITCH, text, \
             date and math functions, and script functions",
        ));
    }

    for child in child_expressions(expression) {
        ensure_row_level(table, step_index, child)?;
    }
    Ok(())
}

/// Check every column reference against the step's input schema.
fn ensure_columns_exist(
    table: &str,
    step_index: usize,
    input: &[Column],
    expression: &Expression,
) -> EngineResult<()> {
    let known = |name: &str| input.iter().any(|c| c.name() == name);
    let available = || {
        input
            .iter()
            .map(|c| c.name())
            .collect::<Vec<_>>()
            .join(", ")
    };

    // Qualified references are checked FIRST. `column_references` reports a
    // qualified reference's bare column name too, so checking that list first
    // would answer `Products[price]` with "unknown column 'price'" — true, but
    // it hides the real mistake, which is naming another table at all.
    for (qualifier, column) in expression.qualified_column_references() {
        if !qualifier.eq_ignore_ascii_case(table) {
            return Err(transform_error(
                table,
                step_index,
                format!(
                    "the expression references '{qualifier}[{column}]', but a \
                     transformation step can only use this table's own columns"
                ),
            ));
        }
        if !known(column) {
            return Err(transform_error(
                table,
                step_index,
                format!(
                    "the expression references unknown column '{column}' (available: {})",
                    available()
                ),
            ));
        }
    }

    for name in expression.column_references() {
        if !known(name) {
            return Err(transform_error(
                table,
                step_index,
                format!(
                    "the expression references unknown column '{name}' (available: {})",
                    available()
                ),
            ));
        }
    }
    Ok(())
}

/// Validate a whole pipeline against a source schema and return the schema it
/// produces.
///
/// This is the single entry point model validation calls. It checks each step
/// in order against the schema as it stands at that point — so a step that
/// references a column an earlier step removed fails at the step that uses
/// it, naming that step.
///
/// # Errors
///
/// The first step that fails, as [`EngineError::InvalidTransform`] carrying
/// that step's index.
pub fn validate_steps(
    table: &str,
    source_columns: &[Column],
    steps: &[TransformStep],
) -> EngineResult<Vec<Column>> {
    if source_columns.is_empty() && !steps.is_empty() {
        return Err(transform_error(
            table,
            0,
            "the table has no recorded source columns, so its transformation \
             steps cannot be checked — re-import or refresh the source schema",
        ));
    }

    let mut columns = source_columns.to_vec();
    for (index, step) in steps.iter().enumerate() {
        // Expression steps are checked against the schema at THIS point.
        // `addColumn` is checked inside derivation (its type inference needs
        // the parsed tree); `filterRows` has no derivation work, so its
        // condition is checked here.
        if let TransformStep::FilterRows { condition } = step {
            let parsed = parse_row_expression(table, index, &columns, condition)?;
            if let Some(inferred) = crate::transform::infer::infer_parsed_type(&parsed, &columns) {
                if inferred != DataType::Boolean {
                    return Err(transform_error(
                        table,
                        index,
                        format!(
                            "a filterRows condition must be true or false, but this \
                             expression produces {inferred:?}"
                        ),
                    ));
                }
            }
        }
        columns = derive_step_schema(table, index, &columns, step)?;
    }
    Ok(columns)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transform::parts::ColumnRename;
    use crate::transform::test_support::{names, source_schema};

    fn check(source: &str) -> EngineResult<Expression> {
        parse_row_expression("Sales", 0, &source_schema(), source)
    }

    #[test]
    fn a_row_level_expression_is_accepted() {
        assert!(check("amount - cost").is_ok());
        assert!(check("IF(amount > 0, \"pos\", \"neg\")").is_ok());
        assert!(check("UPPER(TRIM(status))").is_ok());
        assert!(check("YEAR(order_date)").is_ok());
    }

    #[test]
    fn both_a_condition_and_a_plain_value_expression_parse() {
        // A step needs both grammars from one entry point: `filterRows` is a
        // top-level comparison, and `addColumn` is usually a value expression
        // (but may compute a boolean flag). The measure-expression grammar
        // rejects a top-level comparison, which is why this uses the
        // condition parser.
        assert!(
            check("amount > 0").is_ok(),
            "a top-level comparison must parse"
        );
        assert!(
            check("amount - cost").is_ok(),
            "a plain value expression must parse"
        );
        // Note the spelling: this language's lexer has no `&&` — logical AND
        // is the `AND` keyword (or `AND(a, b)`).
        assert!(
            check("amount > 0 AND status <> \"cancelled\"").is_ok(),
            "combined conditions must parse"
        );
    }

    #[test]
    fn a_trailing_token_error_does_not_mention_refresh_filters() {
        // The condition parser is shared with incremental refresh and words
        // its errors for that caller; a transform step must not leak it.
        let err = check("amount > 0 nonsense").unwrap_err();
        let message = err.to_string();
        assert!(!message.contains("refresh filter"), "got {message}");
        assert!(message.contains("expression"), "got {message}");
    }

    #[test]
    fn an_aggregation_is_rejected_by_name() {
        let err = check("SUM(amount)").unwrap_err();
        assert!(err.to_string().contains("aggregation"), "got {err}");
        assert!(
            err.to_string().contains("groupBy"),
            "must point at the fix: {err}"
        );
    }

    #[test]
    fn a_nested_aggregation_is_rejected_too() {
        // The allowlist recurses, so an aggregate buried in an IF is caught.
        let err = check("IF(amount > 0, SUM(amount), 0)").unwrap_err();
        assert!(err.to_string().contains("aggregation"), "got {err}");
    }

    #[test]
    fn a_measure_reference_is_rejected() {
        let err = check("[Revenue]").unwrap_err();
        assert!(err.to_string().contains("measure"), "got {err}");
    }

    #[test]
    fn a_bracketed_name_resolves_to_a_column_of_this_step() {
        // THE spelling an author reaches for first. A leading `[` is a measure
        // reference everywhere else in this language, so before bracket
        // resolution `LEFT([status], 3)` was refused while `LEFT(status, 3)`
        // worked — and our own CLI reference taught the refused form.
        for expression in [
            "[amount] > 0",
            "LEFT([status], 3)",
            "UPPER(TRIM([status]))",
            "IF(ISBLANK([status]), \"none\", UPPER([status]))",
            "[amount] - [cost]",
        ] {
            assert!(
                parse_row_expression("Sales", 0, &source_schema(), expression).is_ok(),
                "{expression} must resolve its bracketed columns"
            );
        }
    }

    #[test]
    fn all_three_spellings_of_a_column_agree() {
        // Bare, bracketed and qualified must parse to the SAME tree, or the
        // three surfaces that write them would mean different things.
        let bare = parse_row_expression("Sales", 0, &source_schema(), "LEFT(status, 3)").unwrap();
        let bracketed =
            parse_row_expression("Sales", 0, &source_schema(), "LEFT([status], 3)").unwrap();
        assert_eq!(
            format!("{bare:?}"),
            format!("{bracketed:?}"),
            "a bracketed column must resolve to exactly the bare column's node"
        );
        assert!(
            parse_row_expression("Sales", 0, &source_schema(), "LEFT(Sales[status], 3)").is_ok(),
            "the qualified spelling keeps working"
        );
    }

    #[test]
    fn a_bracketed_name_that_is_not_a_column_is_still_a_measure_reference() {
        // The half that keeps this fail-closed. Resolution widens what PARSES,
        // never what is ALLOWED: a bracketed name absent from the step's input
        // is left as a measure reference and refused by the allowlist, with the
        // message that names measures.
        let err = check("[Revenue] > 0").unwrap_err();
        assert!(err.to_string().contains("measure"), "got {err}");

        // Including when nested inside a function that would otherwise hide it.
        let err = check("LEFT([Revenue], 3)").unwrap_err();
        assert!(err.to_string().contains("measure"), "got {err}");
    }

    #[test]
    fn resolution_reaches_every_nesting_the_allowlist_admits() {
        // `substitute_measure_refs` recurses by hand, and its trailing
        // `_ => self.clone()` arm is NOT compiler-enforced the way
        // `child_expressions` is. So a variant that stops recursing would
        // silently leave a MeasureRef inside — and the step would fail with a
        // message about measures for an expression that names only columns.
        for expression in [
            "IF([amount] > 0, UPPER([status]), LOWER([status]))",
            // SWITCH matches a VALUE against cases. The spreadsheet
            // `SWITCH(TRUE(), cond, ...)` idiom does not parse here — SWITCH's
            // grammar calls `parse_expression`, which does not accept a
            // comparison — so the condition-ladder spelling is `IF` nesting.
            "SWITCH([status], \"open\", 1, \"closed\", 2, 0)",
            "COALESCE([status], [region], \"none\")",
            "DIVIDE([amount], [cost], 0)",
            "IFERROR(LEFT([status], 3), \"?\")",
            "GREATEST([amount], [cost])",
            // The IN list takes BRACES, not parentheses.
            "[status] IN {\"a\", \"b\"}",
            "NOT(ISBLANK([status]))",
            "[amount] > 0 AND [cost] > 0 OR NOT([amount] > 100)",
            "CONCATENATE(UPPER(TRIM([status])), LEFT([region], 2))",
            // The interval is a KEYWORD, not a string.
            "DATEDIFF([order_date], TODAY(), DAY)",
            "NULLIF([amount], [cost])",
        ] {
            let outcome = parse_row_expression("Sales", 0, &source_schema(), expression);
            assert!(
                outcome.is_ok(),
                "resolution did not reach into {expression}: {:?}",
                outcome.err()
            );
        }
    }

    #[test]
    fn the_unbracketed_spellings_keep_working() {
        // Nothing was taken away: bare and qualified names are unchanged.
        for expression in [
            "LEFT(status, 3)",
            "LEFT(Sales[status], 3)",
            "UPPER(TRIM(status))",
            "SUBSTITUTE(status, \"-\", \"\")",
            "IF(amount > 0, \"pos\", \"neg\")",
            "ROUND(amount * 1.25, 2)",
        ] {
            assert!(
                parse_row_expression("Sales", 0, &source_schema(), expression).is_ok(),
                "{expression} must keep parsing"
            );
        }
    }

    #[test]
    fn an_unknown_column_is_rejected_with_the_available_list() {
        let err = check("nope + 1").unwrap_err();
        assert!(err.to_string().contains("nope"), "got {err}");
        assert!(err.to_string().contains("amount"), "got {err}");
    }

    #[test]
    fn a_qualified_reference_to_this_table_is_accepted() {
        assert!(parse_row_expression("Sales", 0, &source_schema(), "Sales[amount] * 2").is_ok());
    }

    #[test]
    fn a_qualified_reference_to_another_table_is_rejected() {
        let err =
            parse_row_expression("Sales", 0, &source_schema(), "Products[price] * 2").unwrap_err();
        assert!(err.to_string().contains("own columns"), "got {err}");
    }

    #[test]
    fn a_syntax_error_reports_a_position() {
        let err = check("amount +").unwrap_err();
        assert!(err.to_string().contains("position"), "got {err}");
    }

    #[test]
    fn an_empty_expression_is_rejected() {
        let err = check("   ").unwrap_err();
        assert!(err.to_string().contains("empty"), "got {err}");
    }

    #[test]
    fn a_script_function_call_stays_reachable() {
        // Rhai UDFs are the escape hatch for logic the step catalog cannot
        // express, so `Call` must remain on the allowlist.
        assert!(check("my_udf(amount, 2)").is_ok());
    }

    #[test]
    fn validate_steps_returns_the_derived_schema() {
        let steps = vec![
            TransformStep::FilterRows {
                condition: "amount > 0".into(),
            },
            TransformStep::RenameColumns {
                renames: vec![ColumnRename::new("amount", "net")],
            },
        ];
        let derived = validate_steps("Sales", &source_schema(), &steps).unwrap();
        assert!(names(&derived).contains(&"net"));
    }

    #[test]
    fn a_non_boolean_filter_condition_is_rejected() {
        let steps = vec![TransformStep::FilterRows {
            condition: "amount".into(),
        }];
        let err = validate_steps("Sales", &source_schema(), &steps).unwrap_err();
        assert!(err.to_string().contains("true or false"), "got {err}");
    }

    #[test]
    fn a_step_referencing_a_column_an_earlier_step_removed_names_that_step() {
        let steps = vec![
            TransformStep::RemoveColumns {
                columns: vec!["cost".into()],
            },
            TransformStep::AddColumn {
                name: "margin".into(),
                expression: "amount - cost".into(),
                data_type: None,
            },
        ];
        let err = validate_steps("Sales", &source_schema(), &steps).unwrap_err();
        match err {
            EngineError::InvalidTransform { step_index, .. } => assert_eq!(step_index, 1),
            other => panic!("expected InvalidTransform, got {other:?}"),
        }
    }

    #[test]
    fn steps_without_recorded_source_columns_are_rejected() {
        let steps = vec![TransformStep::RemoveColumns {
            columns: vec!["cost".into()],
        }];
        let err = validate_steps("Sales", &[], &steps).unwrap_err();
        assert!(err.to_string().contains("source columns"), "got {err}");
    }

    #[test]
    fn an_empty_pipeline_over_no_source_columns_is_fine() {
        // A table with no pipeline is an ordinary table; it must not be
        // dragged into transformation validation at all.
        assert!(validate_steps("Sales", &[], &[]).unwrap().is_empty());
    }
}
