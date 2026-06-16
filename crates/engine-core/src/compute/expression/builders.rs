//! Helper constructors for building expression trees.

use super::*;

impl Expression {
    /// Create a binary addition: `self + other`.
    #[allow(clippy::should_implement_trait)]
    pub fn add(self, other: Expression) -> Expression {
        Expression::BinaryOp {
            left: Box::new(self),
            op: ArithmeticOp::Add,
            right: Box::new(other),
        }
    }

    /// Create a binary subtraction: `self - other`.
    pub fn subtract(self, other: Expression) -> Expression {
        Expression::BinaryOp {
            left: Box::new(self),
            op: ArithmeticOp::Subtract,
            right: Box::new(other),
        }
    }

    /// Create a binary multiplication: `self * other`.
    pub fn multiply(self, other: Expression) -> Expression {
        Expression::BinaryOp {
            left: Box::new(self),
            op: ArithmeticOp::Multiply,
            right: Box::new(other),
        }
    }

    /// Create a binary division: `self / other`.
    pub fn divide(self, other: Expression) -> Expression {
        Expression::BinaryOp {
            left: Box::new(self),
            op: ArithmeticOp::Divide,
            right: Box::new(other),
        }
    }
}

/// Create a column reference expression.
pub fn col(name: &str) -> Expression {
    Expression::ColumnRef(name.to_string())
}

/// Create a floating-point literal expression.
pub fn lit(value: f64) -> Expression {
    Expression::LiteralFloat(value)
}

/// Create an integer literal expression.
pub fn lit_int(value: i64) -> Expression {
    Expression::LiteralInt(value)
}

/// Create an aggregate expression.
pub fn agg(operation: AggregateOp, operand: Expression) -> Expression {
    Expression::Aggregate {
        operation,
        operand: Box::new(operand),
    }
}

/// Create a `keep()` expression — add filter conditions to the context.
pub fn keep(expr: Expression, filters: Vec<FilterPredicate>) -> Expression {
    Expression::Keep {
        expr: Box::new(expr),
        filters,
        variables: Vec::new(),
        conditions: Vec::new(),
        in_predicates: Vec::new(),
    }
}

/// Create a `keep()` expression with table variable references.
///
/// Each variable name is resolved at context-resolution time to add
/// the variable's accumulated filters to the evaluation context.
pub fn keep_vars(expr: Expression, variables: Vec<String>) -> Expression {
    Expression::Keep {
        expr: Box::new(expr),
        filters: Vec::new(),
        variables,
        conditions: Vec::new(),
        in_predicates: Vec::new(),
    }
}

/// Create a `keep()` expression with expression-based conditions.
///
/// Each condition is an arbitrary boolean expression (e.g., a Comparison).
pub fn keep_conditions(expr: Expression, conditions: Vec<Expression>) -> Expression {
    Expression::Keep {
        expr: Box::new(expr),
        filters: Vec::new(),
        variables: Vec::new(),
        conditions,
        in_predicates: Vec::new(),
    }
}

/// Create a `clear()` expression — remove filters on specific dimensions.
pub fn clear(expr: Expression, targets: Vec<ClearTarget>) -> Expression {
    Expression::Clear {
        expr: Box::new(expr),
        targets,
    }
}

/// Create a `reset()` expression — remove ALL filters from context.
pub fn reset(expr: Expression) -> Expression {
    Expression::Reset {
        expr: Box::new(expr),
    }
}

/// Create a `clear_inner()` expression — remove inner (group-by) filters on specific dimensions.
pub fn clear_inner(expr: Expression, targets: Vec<ClearTarget>) -> Expression {
    Expression::ClearInner {
        expr: Box::new(expr),
        targets,
    }
}

/// Create a `clear_outer()` expression — remove outer (query-level) filters on specific dimensions.
pub fn clear_outer(expr: Expression, targets: Vec<ClearTarget>) -> Expression {
    Expression::ClearOuter {
        expr: Box::new(expr),
        targets,
    }
}

/// Create a `reset_inner()` expression — remove ALL inner (group-by) filters.
pub fn reset_inner(expr: Expression) -> Expression {
    Expression::ResetInner {
        expr: Box::new(expr),
    }
}

/// Create a `reset_outer()` expression — remove ALL outer (query-level) filters.
pub fn reset_outer(expr: Expression) -> Expression {
    Expression::ResetOuter {
        expr: Box::new(expr),
    }
}

/// Create a `traverse()` expression — force explicit relationship traversal.
pub fn traverse(expr: Expression, path: RelationshipPath) -> Expression {
    Expression::Traverse {
        expr: Box::new(expr),
        path,
    }
}

/// Create a `using()` expression — apply a named context.
pub fn using(expr: Expression, context_name: impl Into<String>) -> Expression {
    Expression::Using {
        expr: Box::new(expr),
        context_name: context_name.into(),
    }
}

/// Create a `use_relationship()` expression — activate an inactive relationship.
pub fn use_relationship(expr: Expression, relationship_name: impl Into<String>) -> Expression {
    Expression::UseRelationship {
        expr: Box::new(expr),
        relationship_name: relationship_name.into(),
    }
}

/// Create a `keep_in()` expression — apply IN-membership filters.
pub fn keep_in(expr: Expression, predicates: Vec<InPredicate>) -> Expression {
    Expression::KeepIn {
        expr: Box::new(expr),
        predicates,
    }
}

/// Create a table reference expression.
pub fn table_ref(name: impl Into<String>) -> Expression {
    Expression::TableRef(name.into())
}

/// Create a qualified column reference: `table_or_var.column`.
pub fn qualified_col(table_or_var: impl Into<String>, column: impl Into<String>) -> Expression {
    Expression::QualifiedColumnRef {
        table_or_var: table_or_var.into(),
        column: column.into(),
    }
}

/// Create a block expression with named bindings and a result.
pub fn block(bindings: Vec<(String, Expression)>, result: Expression) -> Expression {
    Expression::Block {
        bindings,
        result: Box::new(result),
    }
}

/// Create a query expression for two-stage aggregation.
///
/// `aggregates` is a list of `(expression, alias)` pairs.
/// `group_by` is a list of `(table, column)` pairs.
pub fn query_expr(
    aggregates: Vec<(Expression, String)>,
    group_by: Vec<(String, String)>,
) -> Expression {
    Expression::Query {
        aggregates,
        group_by,
    }
}

/// Create a string literal expression.
pub fn lit_str(value: impl Into<String>) -> Expression {
    Expression::LiteralString(value.into())
}

/// Create a BLANK (null) expression.
pub fn blank() -> Expression {
    Expression::Blank
}

/// Create an ISBLANK expression — tests if value is null.
pub fn is_blank(expr: Expression) -> Expression {
    Expression::IsBlank(Box::new(expr))
}

/// Create a comparison expression.
pub fn compare(left: Expression, op: ComparisonOp, right: Expression) -> Expression {
    Expression::Comparison {
        left: Box::new(left),
        op,
        right: Box::new(right),
    }
}

/// Create a logical AND expression.
pub fn and(left: Expression, right: Expression) -> Expression {
    Expression::And(Box::new(left), Box::new(right))
}

/// Create a logical OR expression.
pub fn or(left: Expression, right: Expression) -> Expression {
    Expression::Or(Box::new(left), Box::new(right))
}

/// Create a logical NOT expression.
pub fn not(expr: Expression) -> Expression {
    Expression::Not(Box::new(expr))
}

/// Create a logical XOR expression.
pub fn xor(left: Expression, right: Expression) -> Expression {
    Expression::Xor(Box::new(left), Box::new(right))
}

/// Create a boolean literal expression: `TRUE` or `FALSE`.
pub fn lit_bool(value: bool) -> Expression {
    Expression::LiteralBool(value)
}

/// Create an IF expression: `IF(condition, then_expr, else_expr)`.
pub fn if_expr(condition: Expression, then_expr: Expression, else_expr: Expression) -> Expression {
    Expression::If {
        condition: Box::new(condition),
        then_expr: Box::new(then_expr),
        else_expr: Box::new(else_expr),
    }
}

/// Create a SWITCH expression: `SWITCH(expr, [(val, result), ...], default)`.
pub fn switch(
    expr: Expression,
    cases: Vec<(Expression, Expression)>,
    default: Option<Expression>,
) -> Expression {
    Expression::Switch {
        expr: Box::new(expr),
        cases,
        default: default.map(Box::new),
    }
}

/// Create a safe DIVIDE expression: `DIVIDE(numerator, denominator [, alternate])`.
pub fn safe_divide(
    numerator: Expression,
    denominator: Expression,
    alternate: Option<Expression>,
) -> Expression {
    Expression::SafeDivide {
        numerator: Box::new(numerator),
        denominator: Box::new(denominator),
        alternate: alternate.map(Box::new),
    }
}

/// Create a COALESCE expression: first non-null value.
pub fn coalesce(exprs: Vec<Expression>) -> Expression {
    Expression::Coalesce(exprs)
}

/// Create a call to a host-registered scalar UDF.
///
/// The name must satisfy [`Expression::validate`]'s call-name rule
/// (`^[A-Za-z_][A-Za-z0-9_]{0,63}$`); validation happens at model build /
/// render time, not here.
pub fn call(name: &str, args: Vec<Expression>) -> Expression {
    Expression::Call {
        name: name.to_string(),
        args,
    }
}

/// Create a scalar function call.
pub fn scalar_fn(function: ScalarFunction, args: Vec<Expression>) -> Expression {
    Expression::ScalarFunc { function, args }
}

/// Create a text function call.
pub fn text_fn(function: TextFunction, args: Vec<Expression>) -> Expression {
    Expression::TextFunc { function, args }
}

/// Create a COUNTROWS aggregate expression.
pub fn count_rows() -> Expression {
    Expression::Aggregate {
        operation: AggregateOp::CountRows,
        operand: Box::new(Expression::Blank), // operand unused for CountRows
    }
}

/// Create a HASONEVALUE expression: `HASONEVALUE(column)`.
///
/// Returns true if there's exactly one distinct value of the column in the
/// current filter context.
pub fn has_one_value(column: Expression) -> Expression {
    Expression::HasOneValue {
        column: Box::new(column),
    }
}

/// Create a SELECTEDVALUE expression: `SELECTEDVALUE(column [, alternate])`.
///
/// Returns the single column value if there's exactly one distinct value
/// in context, otherwise returns alternate (or BLANK).
pub fn selected_value(column: Expression, alternate: Option<Expression>) -> Expression {
    Expression::SelectedValue {
        column: Box::new(column),
        alternate: alternate.map(Box::new),
    }
}

/// Create a FIRST expression: `FIRST(column, ORDER BY order_by)`.
///
/// Returns the first value of column ordered by order_by expression.
pub fn first_value(column: Expression, order_by: Expression) -> Expression {
    Expression::FirstValue {
        column: Box::new(column),
        order_by: Box::new(order_by),
    }
}

/// Create a WINDOW expression: aggregate over a sliding frame.
pub fn window_expr(
    inner: Expression,
    function: AggregateOp,
    order_by: Vec<(String, String)>,
    partition_by: Vec<(String, String)>,
    frame: Option<WindowFrame>,
) -> Expression {
    Expression::Window {
        inner: Box::new(inner),
        function,
        order_by,
        partition_by,
        frame,
    }
}

/// Create an OFFSET expression: value at relative position.
pub fn offset_expr(
    inner: Expression,
    delta: i64,
    order_by: Vec<(String, String)>,
    partition_by: Vec<(String, String)>,
) -> Expression {
    Expression::Offset {
        inner: Box::new(inner),
        delta,
        order_by,
        partition_by,
    }
}

/// Create a to-date expression: `YTD`/`QTD`/`MTD` running aggregate.
///
/// Lowered to a [`Expression::Window`] running aggregate against the
/// model's date table at planning/execution time.
pub fn to_date(expr: Expression, granularity: DateGranularity) -> Expression {
    Expression::ToDate {
        expr: Box::new(expr),
        granularity,
    }
}

/// Create a period-shift expression: `PRIORYEAR` / `PRIORPERIOD`.
///
/// Lowered to an [`Expression::Offset`] along the date table's axis at
/// planning/execution time. Negative offsets shift to earlier periods.
pub fn period_shift(expr: Expression, offset: i64, granularity: DateGranularity) -> Expression {
    Expression::PeriodShift {
        expr: Box::new(expr),
        offset,
        granularity,
    }
}

/// Create a `DATESINPERIOD` trailing-window expression.
///
/// `intervals` is a (typically negative) count of `granularity` periods in a
/// trailing window ending at the current context's as-of date.
pub fn dates_in_period(
    expr: Expression,
    intervals: i64,
    granularity: DateGranularity,
) -> Expression {
    Expression::DatesInPeriod {
        expr: Box::new(expr),
        intervals,
        granularity,
    }
}

/// Create a `CLOSINGBALANCE` semi-additive balance (the inner measure at the
/// **last** date of the current context).
pub fn closing_balance(expr: Expression) -> Expression {
    Expression::SemiAdditiveBalance {
        expr: Box::new(expr),
        opening: false,
    }
}

/// Create an `OPENINGBALANCE` semi-additive balance (the inner measure at the
/// **first** date of the current context).
pub fn opening_balance(expr: Expression) -> Expression {
    Expression::SemiAdditiveBalance {
        expr: Box::new(expr),
        opening: true,
    }
}

/// Create an INDEX expression: value at absolute position.
pub fn index_expr(
    inner: Expression,
    position: i64,
    order_by: Vec<(String, String)>,
    partition_by: Vec<(String, String)>,
) -> Expression {
    Expression::Index {
        inner: Box::new(inner),
        position,
        order_by,
        partition_by,
    }
}

/// Create a date/time function call.
pub fn datetime_fn(function: DateTimeFunction, args: Vec<Expression>) -> Expression {
    Expression::DateTimeFunc { function, args }
}

/// Create an IFERROR expression: `IFERROR(expr, alternate)`.
pub fn if_error(expr: Expression, alternate: Expression) -> Expression {
    Expression::IfError {
        expr: Box::new(expr),
        alternate: Box::new(alternate),
    }
}

/// Create an ISINSCOPE expression: `ISINSCOPE(table[column])`.
pub fn is_in_scope(table: impl Into<String>, column: impl Into<String>) -> Expression {
    Expression::IsInScope {
        table: table.into(),
        column: column.into(),
    }
}

/// Create a CLEAREXCEPT expression — clear all filters on table except specified columns.
pub fn clear_except(
    expr: Expression,
    table: impl Into<String>,
    except_columns: Vec<String>,
) -> Expression {
    Expression::ClearExcept {
        expr: Box::new(expr),
        table: table.into(),
        except_columns,
    }
}

/// Create an ITERATE expression — declare row-context iteration over a table.
pub fn iterate(table: impl Into<String>, expression: Expression) -> Expression {
    Expression::Iterate {
        table: table.into(),
        expression: Box::new(expression),
    }
}

/// Create a PERCENTILE expression: `PERCENTILE(operand, k)`.
pub fn percentile(operand: Expression, percentile_value: Expression) -> Expression {
    Expression::Percentile {
        operand: Box::new(operand),
        percentile: Box::new(percentile_value),
    }
}

/// Convert a resolved [`ScalarValue`](datafusion::common::ScalarValue) into a
/// literal [`Expression`] for substitution into a row-level expression.
///
/// Used by context-driven calculated columns: the column's scalar measure
/// (e.g. `[AsOfDate] = MAX(dim_date[date])`) is evaluated once per query, then
/// the resolved value is converted here and substituted in place of the
/// `MeasureRef` (see [`Expression::substitute_measure_refs`]).
///
/// A `NULL` scalar maps to [`Expression::Blank`]; the caller decides whether a
/// blank context scalar is acceptable. A date maps to [`Expression::LiteralDate`]
/// so the comparison stays `Date32`-typed.
///
/// # Errors
///
/// Returns [`EngineError::InvalidExpression`](crate::error::EngineError::InvalidExpression)
/// for scalar types not supported as a context scalar in this version
/// (timestamps, intervals, lists, structs, …) — fail closed rather than coerce
/// a value that could compare wrongly.
pub fn expr_literal_from_scalar(
    scalar: &datafusion::common::ScalarValue,
) -> crate::error::EngineResult<Expression> {
    use datafusion::common::ScalarValue as SV;
    Ok(match scalar {
        SV::Null => Expression::Blank,
        SV::Boolean(None)
        | SV::Float64(None)
        | SV::Float32(None)
        | SV::Int64(None)
        | SV::Int32(None)
        | SV::Int16(None)
        | SV::Int8(None)
        | SV::UInt64(None)
        | SV::UInt32(None)
        | SV::UInt16(None)
        | SV::UInt8(None)
        | SV::Utf8(None)
        | SV::LargeUtf8(None)
        | SV::Date32(None)
        | SV::Date64(None)
        | SV::Decimal128(None, _, _) => Expression::Blank,
        SV::Boolean(Some(b)) => Expression::LiteralBool(*b),
        SV::Float64(Some(v)) => Expression::LiteralFloat(*v),
        SV::Float32(Some(v)) => Expression::LiteralFloat(f64::from(*v)),
        SV::Int64(Some(v)) => Expression::LiteralInt(*v),
        SV::Int32(Some(v)) => Expression::LiteralInt(i64::from(*v)),
        SV::Int16(Some(v)) => Expression::LiteralInt(i64::from(*v)),
        SV::Int8(Some(v)) => Expression::LiteralInt(i64::from(*v)),
        SV::UInt64(Some(v)) => Expression::LiteralInt(i64::try_from(*v).map_err(|_| {
            crate::error::EngineError::InvalidExpression(format!(
                "context scalar {v} exceeds the i64 range"
            ))
        })?),
        SV::UInt32(Some(v)) => Expression::LiteralInt(i64::from(*v)),
        SV::UInt16(Some(v)) => Expression::LiteralInt(i64::from(*v)),
        SV::UInt8(Some(v)) => Expression::LiteralInt(i64::from(*v)),
        SV::Utf8(Some(s)) | SV::LargeUtf8(Some(s)) => Expression::LiteralString(s.clone()),
        SV::Date32(Some(d)) => Expression::LiteralDate(*d),
        // Date64 is milliseconds since the epoch; reduce to whole days.
        SV::Date64(Some(ms)) => Expression::LiteralDate(
            i32::try_from(ms.div_euclid(86_400_000)).map_err(|_| {
                crate::error::EngineError::InvalidExpression(format!(
                    "context scalar date {ms} is out of the Date32 range"
                ))
            })?,
        ),
        SV::Decimal128(Some(v), _precision, scale) => {
            // Render as a float for comparison. Precision beyond f64 is lost;
            // acceptable for a threshold comparison, documented for the host.
            Expression::LiteralFloat(*v as f64 / 10f64.powi(i32::from(*scale)))
        }
        other => {
            return Err(crate::error::EngineError::InvalidExpression(format!(
                "a context-driven calculated column scalar resolved to an unsupported type \
                 ({other:?}); supported types are boolean, integer, float, decimal, string, and \
                 date"
            )));
        }
    })
}

/// Convert a single cell of an Arrow array into a literal [`Expression`].
///
/// A thin wrapper over [`expr_literal_from_scalar`] for callers that hold an
/// Arrow array (e.g. a host without a DataFusion dependency reading the result
/// of an inner scalar query) rather than a `ScalarValue`. Same type support and
/// errors as [`expr_literal_from_scalar`].
///
/// # Errors
///
/// Propagates the Arrow→scalar extraction error, and errors on an unsupported
/// scalar type (see [`expr_literal_from_scalar`]).
pub fn expr_literal_from_arrow(
    array: &dyn arrow::array::Array,
    row: usize,
) -> crate::error::EngineResult<Expression> {
    let scalar = datafusion::common::ScalarValue::try_from_array(array, row)?;
    expr_literal_from_scalar(&scalar)
}
