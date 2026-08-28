//! Static type inference for `addColumn` expressions.
//!
//! Schema derivation must name a type for a computed column without reading
//! data. This module infers one where the expression makes it obvious, and
//! returns `None` where it does not — in which case the step must declare a
//! type explicitly. `None` is the safe answer: it asks the author a question
//! instead of guessing a type the refresh will then have to cast away.
//!
//! Where a choice exists the inference **widens** (an arithmetic result over
//! integers infers `Float64` if either side is fractional; a rounding function
//! infers `Float64`), because the refresh conforms the computed column to the
//! declared type and a widening cast is lossless while a narrowing one is not.

use crate::compute::expression::{
    ArithmeticOp, DateTimeFunction, Expression, ScalarFunction, TextFunction,
};
use crate::model::Column;
use crate::types::DataType;

/// Infer the result type of an already-parsed row-level expression.
///
/// The only entry point. There used to be a source-text sibling
/// (`infer_expression_type`) that parsed and then inferred, and it was the ONLY
/// route from an `addColumn` expression to the parser — so declaring a type on
/// the step skipped validation entirely. Both column rules now parse
/// unconditionally and hand the tree here, which closes that hole and pays for
/// one parse instead of two.
///
/// Returns `None` when the expression is well-formed but its type cannot be
/// determined statically — the caller turns that into a request for an
/// explicit type.
pub(crate) fn infer_parsed_type(expression: &Expression, input: &[Column]) -> Option<DataType> {
    infer(expression, input)
}

/// Look up a column's type in the step's input schema.
fn column_type(input: &[Column], name: &str) -> Option<DataType> {
    input
        .iter()
        .find(|c| c.name() == name)
        .map(|c| c.data_type().clone())
}

/// Returns `true` for the integral types.
fn is_integral(data_type: &DataType) -> bool {
    matches!(data_type, DataType::Int32 | DataType::Int64)
}

/// The wider of two inferred types, or `None` if they cannot be reconciled.
///
/// Reconciliation is deliberately narrow: identical types, integer widening,
/// and integer-with-fractional. Anything else (a branch returning text and a
/// branch returning a number) asks the author to declare the type.
fn widen(left: Option<DataType>, right: Option<DataType>) -> Option<DataType> {
    match (left?, right?) {
        (a, b) if a == b => Some(a),
        (a, b) if is_integral(&a) && is_integral(&b) => Some(DataType::Int64),
        (a, b)
            if (is_integral(&a)
                || a == DataType::Float64
                || matches!(a, DataType::Decimal(_, _)))
                && (is_integral(&b)
                    || b == DataType::Float64
                    || matches!(b, DataType::Decimal(_, _))) =>
        {
            Some(DataType::Float64)
        }
        _ => None,
    }
}

/// Infer the result type of a parsed row-level expression.
fn infer(expression: &Expression, input: &[Column]) -> Option<DataType> {
    match expression {
        Expression::ColumnRef(name) => column_type(input, name),
        Expression::QualifiedColumnRef { column, .. } => column_type(input, column),

        Expression::LiteralInt(_) => Some(DataType::Int64),
        Expression::LiteralFloat(_) => Some(DataType::Float64),
        Expression::LiteralString(_) => Some(DataType::String),
        Expression::LiteralBool(_) => Some(DataType::Boolean),
        Expression::LiteralDate(_) => Some(DataType::Date),
        // BLANK() alone is untyped — a column of nothing but nulls needs a
        // declared type to be meaningful.
        Expression::Blank => None,

        Expression::BinaryOp { left, op, right } => match op {
            // Division always produces a fractional result.
            ArithmeticOp::Divide => Some(DataType::Float64),
            _ => widen(infer(left, input), infer(right, input)),
        },
        Expression::SafeDivide { .. } => Some(DataType::Float64),

        Expression::Comparison { .. }
        | Expression::And(_, _)
        | Expression::Or(_, _)
        | Expression::Not(_)
        | Expression::Xor(_, _)
        | Expression::IsBlank(_)
        | Expression::InList { .. } => Some(DataType::Boolean),

        Expression::If {
            then_expr,
            else_expr,
            ..
        } => widen(infer(then_expr, input), infer(else_expr, input)),
        Expression::Switch { cases, default, .. } => {
            let mut inferred: Option<DataType> = None;
            let mut first = true;
            for (_, result) in cases {
                let branch = infer(result, input)?;
                inferred = if first {
                    first = false;
                    Some(branch)
                } else {
                    widen(inferred, Some(branch))
                };
            }
            match default {
                Some(default) => widen(inferred, infer(default, input)),
                None => inferred,
            }
        }
        Expression::Coalesce(args) | Expression::Greatest(args) | Expression::Least(args) => {
            let mut iter = args.iter();
            let mut inferred = Some(infer(iter.next()?, input)?);
            for arg in iter {
                inferred = widen(inferred, infer(arg, input));
            }
            inferred
        }
        Expression::NullIf { expr, .. } => infer(expr, input),
        Expression::IfError { expr, alternate } => {
            widen(infer(expr, input), infer(alternate, input))
        }

        Expression::ScalarFunc { function, args } => infer_scalar(*function, args, input),
        Expression::TextFunc { function, .. } => infer_text(*function),
        Expression::DateTimeFunc { function, .. } => infer_datetime(*function),

        // A UDF's return type is declared on the script function, not here,
        // and every remaining node kind is rejected before inference runs.
        _ => None,
    }
}

/// Math functions. Rounding and transcendental functions infer `Float64`
/// because that is what DataFusion returns; an author who wants an integer
/// column declares one.
fn infer_scalar(
    function: ScalarFunction,
    args: &[Expression],
    input: &[Column],
) -> Option<DataType> {
    match function {
        ScalarFunction::Int | ScalarFunction::Sign => Some(DataType::Int64),
        // ABS preserves its operand's numeric type.
        ScalarFunction::Abs => match infer(args.first()?, input)? {
            t if is_integral(&t) => Some(DataType::Int64),
            _ => Some(DataType::Float64),
        },
        ScalarFunction::Round
        | ScalarFunction::RoundUp
        | ScalarFunction::RoundDown
        | ScalarFunction::Trunc
        | ScalarFunction::Ceiling
        | ScalarFunction::Floor
        | ScalarFunction::Mod
        | ScalarFunction::Power
        | ScalarFunction::Sqrt
        | ScalarFunction::Ln
        | ScalarFunction::Log10
        | ScalarFunction::Log
        | ScalarFunction::Exp
        | ScalarFunction::Pi => Some(DataType::Float64),
    }
}

/// Text functions, by what they return.
fn infer_text(function: TextFunction) -> Option<DataType> {
    match function {
        TextFunction::Len
        | TextFunction::Find
        | TextFunction::Search
        | TextFunction::Unicode
        | TextFunction::PathLength => Some(DataType::Int64),

        TextFunction::Exact
        | TextFunction::Contains
        | TextFunction::StartsWith
        | TextFunction::EndsWith => Some(DataType::Boolean),

        TextFunction::Value => Some(DataType::Float64),

        TextFunction::Concatenate
        | TextFunction::CombineValues
        | TextFunction::Fixed
        | TextFunction::Left
        | TextFunction::Lower
        | TextFunction::Mid
        | TextFunction::Replace
        | TextFunction::Rept
        | TextFunction::Right
        | TextFunction::Substitute
        | TextFunction::Trim
        | TextFunction::Unichar
        | TextFunction::Upper
        | TextFunction::Ltrim
        | TextFunction::Rtrim
        | TextFunction::Lpad
        | TextFunction::Rpad
        | TextFunction::Reverse
        | TextFunction::PathItem
        | TextFunction::Split
        | TextFunction::Format
        | TextFunction::InitCap => Some(DataType::String),
    }
}

/// Date/time functions, by what they return. `DateTrunc` is deliberately
/// un-inferred: its result follows its operand (a truncated timestamp is a
/// timestamp), so the author declares it.
fn infer_datetime(function: DateTimeFunction) -> Option<DataType> {
    match function {
        DateTimeFunction::Year
        | DateTimeFunction::Month
        | DateTimeFunction::Day
        | DateTimeFunction::Quarter
        | DateTimeFunction::DayOfWeek
        | DateTimeFunction::DayOfYear
        | DateTimeFunction::WeekNum
        | DateTimeFunction::DateDiff
        | DateTimeFunction::MonthsBetween => Some(DataType::Int64),

        DateTimeFunction::DayName | DateTimeFunction::MonthName => Some(DataType::String),

        DateTimeFunction::Date
        | DateTimeFunction::Today
        | DateTimeFunction::DateAdd
        | DateTimeFunction::LastDay
        | DateTimeFunction::EoMonth => Some(DataType::Date),

        DateTimeFunction::Now => Some(DataType::Timestamp),

        DateTimeFunction::DateTrunc => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transform::test_support::source_schema;
    use crate::transform::validate::parse_row_expression;

    /// Parse then infer, the way both column rules now do.
    fn infer_source(expression: &str) -> Option<DataType> {
        let parsed = parse_row_expression("Sales", 0, &source_schema(), expression).unwrap();
        infer_parsed_type(&parsed, &source_schema())
    }

    #[test]
    fn column_reference_takes_the_columns_type() {
        assert_eq!(infer_source("amount"), Some(DataType::Float64));
        assert_eq!(infer_source("status"), Some(DataType::String));
        assert_eq!(infer_source("order_date"), Some(DataType::Date));
    }

    #[test]
    fn literals_infer_their_own_type() {
        assert_eq!(infer_source("1"), Some(DataType::Int64));
        assert_eq!(infer_source("1.5"), Some(DataType::Float64));
        assert_eq!(infer_source("\"x\""), Some(DataType::String));
        assert_eq!(infer_source("TRUE()"), Some(DataType::Boolean));
    }

    #[test]
    fn arithmetic_widens_to_the_fractional_side() {
        assert_eq!(infer_source("amount - cost"), Some(DataType::Float64));
        assert_eq!(infer_source("id + 1"), Some(DataType::Int64));
        // Division is always fractional, even over two integers.
        assert_eq!(infer_source("id / 2"), Some(DataType::Float64));
    }

    #[test]
    fn comparisons_and_logic_infer_boolean() {
        assert_eq!(infer_source("amount > 0"), Some(DataType::Boolean));
        assert_eq!(
            infer_source("amount > 0 AND status = \"open\""),
            Some(DataType::Boolean)
        );
        assert_eq!(infer_source("ISBLANK(region)"), Some(DataType::Boolean));
    }

    #[test]
    fn conditionals_reconcile_their_branches() {
        assert_eq!(
            infer_source("IF(amount > 0, \"pos\", \"neg\")"),
            Some(DataType::String)
        );
        assert_eq!(
            infer_source("IF(amount > 0, amount, 0)"),
            Some(DataType::Float64)
        );
    }

    #[test]
    fn irreconcilable_branches_ask_for_an_explicit_type() {
        // A text branch and a numeric branch have no safe common type.
        assert_eq!(infer_source("IF(amount > 0, \"pos\", 1)"), None);
    }

    #[test]
    fn a_bare_blank_has_no_inferable_type() {
        assert_eq!(infer_source("BLANK()"), None);
    }

    #[test]
    fn text_functions_infer_by_what_they_return() {
        assert_eq!(infer_source("UPPER(status)"), Some(DataType::String));
        assert_eq!(infer_source("LEN(status)"), Some(DataType::Int64));
    }

    #[test]
    fn date_functions_infer_by_what_they_return() {
        assert_eq!(infer_source("YEAR(order_date)"), Some(DataType::Int64));
        assert_eq!(infer_source("TODAY()"), Some(DataType::Date));
    }

    #[test]
    fn coalesce_reconciles_its_arguments() {
        assert_eq!(
            infer_source("COALESCE(region, status)"),
            Some(DataType::String)
        );
        assert_eq!(infer_source("COALESCE(amount, 0)"), Some(DataType::Float64));
    }

    #[test]
    fn a_udf_call_is_not_inferred() {
        // The UDF's declared return type lives on the script function, so a
        // step using one must declare its column type.
        assert_eq!(infer_source("my_udf(amount)"), None);
    }

    #[test]
    fn widen_reconciles_only_compatible_types() {
        assert_eq!(
            widen(Some(DataType::Int32), Some(DataType::Int64)),
            Some(DataType::Int64)
        );
        assert_eq!(
            widen(Some(DataType::Int64), Some(DataType::Float64)),
            Some(DataType::Float64)
        );
        assert_eq!(widen(Some(DataType::String), Some(DataType::Int64)), None);
        assert_eq!(widen(Some(DataType::Boolean), Some(DataType::Date)), None);
        assert_eq!(widen(None, Some(DataType::Int64)), None);
    }
}
