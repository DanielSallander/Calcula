//! Expression AST for calculated columns and measure definitions.
//!
//! Expressions can represent row-level computations (for calculated columns)
//! or aggregate computations (for measures). The same `Expression` type
//! serves both purposes — calculated columns use expressions without
//! `Aggregate` nodes, while measures use expressions that contain them.

use serde::{Deserialize, Serialize};

use crate::compute::aggregate::AggregateOp;
use crate::error::{EngineError, EngineResult};
use crate::model::context::ClearTarget;
use crate::model::schema::validate_identifier;

mod builders;
mod case_when;
mod format;
mod functions;
mod globals;
mod inspect;
mod lineage;
mod measure_refs;
mod predicates;
mod render;
#[cfg(test)]
mod serde_tests;
mod sql;
mod text;
mod transform;
mod validate;
mod walkers;

pub use builders::{
    agg, and, blank, block, block_with_globals, call, clear, clear_except, clear_inner,
    clear_outer, closing_balance, coalesce, col, compare, count_rows, dates_in_period, datetime_fn,
    expr_literal_from_arrow, expr_literal_from_scalar, first_value, has_one_value, if_error,
    if_expr, index_expr, is_blank, is_in_scope, iterate, keep, keep_conditions, keep_in, keep_vars,
    lit, lit_bool, lit_int, lit_str, not, offset_expr, opening_balance, or, percentile,
    period_shift, qualified_col, query_expr, reset, reset_inner, reset_outer, safe_divide,
    scalar_fn, selected_value, switch, table_ref, text_fn, to_date, traverse, use_relationship,
    using, window_expr, xor,
};
pub use format::{expression_to_formula, measure_to_formula};
pub use functions::{DateTimeFunction, ScalarFunction};
pub(crate) use functions::{
    DATEADD_INTERVALS, DATEDIFF_INTERVALS, DATE_TRUNC_INTERVALS, LAST_DAY_INTERVALS,
};
pub use globals::expand_global_variables;
pub use lineage::{extract_dependencies, ExpressionDependencies};
pub use measure_refs::{expand_measure_refs, has_measure_ref, infer_fact_table};
pub use predicates::{ComparisonOp, DynamicValue, FilterPredicate, InPredicate, RelationshipPath};
pub use render::{
    BareQualifier, ColumnQualifier, DataFusionDialect, Dialect, LowercaseTableQualifier,
    MultiTableQualifier, PostgresDialect, SqlRenderer, TableAliasQualifier,
};
pub use text::TextFunction;
pub use transform::resolve_is_in_scope;
pub use validate::is_valid_call_name;
pub(crate) use validate::validate_call_name;

/// Arithmetic operators for binary expressions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ArithmeticOp {
    /// Addition (`+`).
    Add,
    /// Subtraction (`-`).
    Subtract,
    /// Multiplication (`*`).
    Multiply,
    /// Division (`/`).
    Divide,
}

impl ArithmeticOp {
    /// Returns the SQL operator string.
    pub fn as_sql(&self) -> &'static str {
        match self {
            Self::Add => "+",
            Self::Subtract => "-",
            Self::Multiply => "*",
            Self::Divide => "/",
        }
    }
}

/// Ranking window functions that have no inner expression.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RankFunction {
    /// `ROW_NUMBER()` — sequential row number.
    RowNumber,
    /// `RANK()` — rank with gaps on ties.
    Rank,
    /// `DENSE_RANK()` — rank without gaps on ties.
    DenseRank,
}

impl std::fmt::Display for RankFunction {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RowNumber => write!(f, "ROW_NUMBER"),
            Self::Rank => write!(f, "RANK"),
            Self::DenseRank => write!(f, "DENSE_RANK"),
        }
    }
}

/// Window frame boundary type (DAX-inspired).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BoundaryType {
    /// Relative to current row: 0 = current, negative = before, positive = after.
    Rel,
    /// Absolute position: 1-based from start, negative from end.
    Abs,
}

/// Calendar granularity for time-intelligence expressions.
///
/// Used by [`Expression::ToDate`] (`YTD`/`QTD`/`MTD`) and
/// [`Expression::PeriodShift`] (`PRIORYEAR`/`PRIORPERIOD`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DateGranularity {
    /// Year-level: `YTD`, `PRIORYEAR`, `PRIORPERIOD(…, "YEAR")`.
    Year,
    /// Quarter-level: `QTD`, `PRIORPERIOD(…, "QUARTER")`.
    Quarter,
    /// Month-level: `MTD`, `PRIORPERIOD(…, "MONTH")`.
    Month,
}

impl std::fmt::Display for DateGranularity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Year => write!(f, "Year"),
            Self::Quarter => write!(f, "Quarter"),
            Self::Month => write!(f, "Month"),
        }
    }
}

/// Defines window frame boundaries for WINDOW expressions.
///
/// Uses DAX-inspired conventions:
/// - `WindowFrame { from: 1, from_type: Abs, to: 0, to_type: Rel }` = unbounded preceding to current row
/// - `WindowFrame { from: -2, from_type: Rel, to: 0, to_type: Rel }` = 2 preceding to current row
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowFrame {
    /// Start boundary value.
    pub from: i64,
    /// How to interpret `from`.
    pub from_type: BoundaryType,
    /// End boundary value.
    pub to: i64,
    /// How to interpret `to`.
    pub to_type: BoundaryType,
}

/// An expression tree for computations over table columns.
///
/// Expressions can be:
/// - **Row-level** (no `Aggregate` nodes): used for calculated columns.
/// - **Aggregate** (contains `Aggregate` nodes): used for measure definitions.
///
/// # Examples
///
/// ```
/// use engine_core::compute::expression::{self as expr, Expression};
/// use engine_core::compute::aggregate::AggregateOp;
///
/// // Simple: SUM(amount)
/// let sum_amount = expr::agg(AggregateOp::Sum, expr::col("amount"));
///
/// // Expression measure: SUM(price * quantity)
/// let revenue = expr::agg(
///     AggregateOp::Sum,
///     expr::col("price").multiply(expr::col("quantity")),
/// );
///
/// // Ratio: SUM(amount) / COUNT(id)
/// let avg_order = expr::agg(AggregateOp::Sum, expr::col("amount"))
///     .divide(expr::agg(AggregateOp::Count, expr::col("id")));
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Expression {
    /// Reference to a column by name.
    ColumnRef(String),
    /// A literal floating-point value.
    LiteralFloat(f64),
    /// A literal integer value.
    LiteralInt(i64),
    /// A literal date value, stored as a Date32 day count (days since the Unix
    /// epoch) and rendered as `CAST(<days> AS DATE)`.
    ///
    /// There is no date-typed literal in authored expressions (dates appear as
    /// columns, not constants); this variant exists so a date-typed scalar
    /// resolved at query time — e.g. the as-of date of a context-driven
    /// calculated column — can be substituted as a literal that compares
    /// correctly against a `Date32` column without relying on string→date
    /// coercion. It is produced transiently during evaluation and never
    /// persisted in a model file.
    LiteralDate(i32),
    /// Binary arithmetic: `left op right`.
    BinaryOp {
        /// Left operand.
        left: Box<Expression>,
        /// Arithmetic operator.
        op: ArithmeticOp,
        /// Right operand.
        right: Box<Expression>,
    },
    /// An aggregate function applied to an operand expression.
    Aggregate {
        /// The aggregation operation.
        operation: AggregateOp,
        /// The expression to aggregate.
        operand: Box<Expression>,
    },
    /// Add filter conditions to the evaluation context.
    ///
    /// `keep(expr, filters...)` — all filters AND with the current context.
    Keep {
        /// The inner expression to evaluate in the filtered context.
        expr: Box<Expression>,
        /// Simple filter conditions: `table[column] op literal_value`.
        filters: Vec<FilterPredicate>,
        /// Table variable names whose filters should be applied.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        variables: Vec<String>,
        /// Expression-based filter conditions (boolean expressions).
        ///
        /// Unlike `filters` which only support `column op literal`, these
        /// support arbitrary boolean expressions like `dim[price] > dim[cost] * 1.5`.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        conditions: Vec<Expression>,
        /// IN-membership filter predicates from `col IN var[col]` syntax.
        ///
        /// Merged from the former KEEPIN function — these are now part of KEEP.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        in_predicates: Vec<InPredicate>,
    },
    /// Remove filters on specific dimensions from the evaluation context.
    ///
    /// `clear(expr, targets...)` — removes outer filters on specified columns/tables.
    Clear {
        /// The inner expression to evaluate with filters removed.
        expr: Box<Expression>,
        /// Dimensions to clear.
        targets: Vec<ClearTarget>,
    },
    /// Remove ALL filters from the evaluation context.
    ///
    /// `reset(expr)` — evaluates the inner expression against the full unfiltered data.
    Reset {
        /// The inner expression to evaluate without any filters.
        expr: Box<Expression>,
    },
    /// Force explicit relationship traversal.
    ///
    /// `traverse(expr, path)` — overrides model-level propagation for this evaluation.
    Traverse {
        /// The inner expression.
        expr: Box<Expression>,
        /// Relationship path to traverse.
        path: RelationshipPath,
    },
    /// Apply a named context definition.
    ///
    /// `using(expr, context_name)` — applies a pre-defined context's operations.
    Using {
        /// The inner expression.
        expr: Box<Expression>,
        /// Name of the context definition to apply.
        context_name: String,
    },
    /// Activate an inactive relationship for the inner expression's evaluation.
    ///
    /// `use_relationship(expr, "rel_name")` — within this expression, the named
    /// (inactive) relationship is used instead of the default active one between
    /// the same table pair.
    UseRelationship {
        /// The inner expression to evaluate with the overridden relationship.
        expr: Box<Expression>,
        /// Name of the relationship to activate.
        relationship_name: String,
    },
    /// Clear only inner (group-by) filters on specific dimensions.
    ///
    /// `clear_inner(expr, targets...)` — removes group-by context filters,
    /// leaving query-level (slicer) filters intact.
    ClearInner {
        /// The inner expression to evaluate with inner filters removed.
        expr: Box<Expression>,
        /// Dimensions to clear from inner context.
        targets: Vec<ClearTarget>,
    },
    /// Clear only outer (query-level) filters on specific dimensions.
    ///
    /// `clear_outer(expr, targets...)` — removes slicer/page filters,
    /// leaving group-by context filters intact.
    ClearOuter {
        /// The inner expression to evaluate with outer filters removed.
        expr: Box<Expression>,
        /// Dimensions to clear from outer context.
        targets: Vec<ClearTarget>,
    },
    /// Remove ALL inner (group-by) filters from the evaluation context.
    ///
    /// `reset_inner(expr)` — removes group-by filters, keeps query-level filters.
    ResetInner {
        /// The inner expression to evaluate without group-by filters.
        expr: Box<Expression>,
    },
    /// Remove ALL outer (query-level) filters from the evaluation context.
    ///
    /// `reset_outer(expr)` — removes slicer/page filters, keeps group-by filters.
    ResetOuter {
        /// The inner expression to evaluate without query-level filters.
        expr: Box<Expression>,
    },
    /// Reference to another measure by name.
    ///
    /// `[MeasureName]` — expanded before evaluation by replacing with the
    /// referenced measure's expression tree. Must be expanded via
    /// `expand_measure_refs()` before context resolution or SQL generation.
    MeasureRef(String),
    /// Reference to a table or table variable.
    ///
    /// Used as a target in `keep()` to apply a table variable's filters.
    TableRef(String),
    /// Qualified column reference: `table_or_var.column`.
    ///
    /// Carries table/variable context for resolution. When `table_or_var`
    /// matches a table variable, the ContextResolver resolves it to the
    /// base table and adds accumulated filters.
    QualifiedColumnRef {
        /// Table name or table variable name.
        table_or_var: String,
        /// Column name.
        column: String,
    },
    /// Apply IN-membership filters to the evaluation context.
    ///
    /// `keep_in(expr, predicates...)` — filters fact table rows to those
    /// where a column's values appear in a table variable's column.
    KeepIn {
        /// The inner expression to evaluate with IN filters applied.
        expr: Box<Expression>,
        /// IN-membership predicates.
        predicates: Vec<InPredicate>,
    },
    /// A block expression with named bindings and a result.
    ///
    /// ```text
    /// {
    ///     actual = sum(Sales.Amount)
    ///     total = sum(reset(Sales.Amount))
    ///     return actual / total
    /// }
    /// ```
    Block {
        /// Named intermediate values.
        bindings: Vec<(String, Expression)>,
        /// Query-scoped variables (`GVAR`): each is evaluated **once per query
        /// context** — against the query's outer filter/slicer context (and
        /// active RLS role) but **without** the group-by/row axis — and
        /// substituted as a literal everywhere it is referenced, at the facade,
        /// before planning. Empty for an ordinary `VAR` block.
        ///
        /// A `Block` reaching context resolution or SQL rendering with a
        /// non-empty `query_scoped_bindings` is an internal error (like an
        /// unexpanded [`MeasureRef`](Expression::MeasureRef)): the facade
        /// resolves and empties this list first.
        ///
        /// NOTE: this is unrelated to the model-level
        /// [`GlobalVariable`](crate::model::global_variable::GlobalVariable)
        /// feature (see [`expand_global_variables`]), which is inlined
        /// statically and re-evaluated per row — the opposite semantics.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        query_scoped_bindings: Vec<(String, Expression)>,
        /// The result expression (may reference binding names).
        result: Box<Expression>,
    },

    // --- New expression types ---
    /// A literal string value.
    LiteralString(String),

    /// Comparison: `left op right` — evaluates to boolean.
    Comparison {
        /// Left operand.
        left: Box<Expression>,
        /// Comparison operator.
        op: ComparisonOp,
        /// Right operand.
        right: Box<Expression>,
    },

    /// Logical AND: `left && right` or `AND(left, right)`.
    And(Box<Expression>, Box<Expression>),

    /// Logical OR: `left || right` or `OR(left, right)`.
    Or(Box<Expression>, Box<Expression>),

    /// Logical NOT: `!expr` or `NOT(expr)`.
    Not(Box<Expression>),

    /// Logical XOR: exclusive or.
    ///
    /// `XOR(left, right)` — true when exactly one operand is true.
    /// SQL: `((left) AND NOT (right)) OR (NOT (left) AND (right))`.
    Xor(Box<Expression>, Box<Expression>),

    /// Boolean literal: `TRUE()` or `FALSE()`.
    LiteralBool(bool),

    /// Conditional: `IF(condition, then_expr, else_expr)`.
    If {
        /// Boolean condition.
        condition: Box<Expression>,
        /// Value when condition is true.
        then_expr: Box<Expression>,
        /// Value when condition is false.
        else_expr: Box<Expression>,
    },

    /// Multi-branch conditional: `SWITCH(expr, val1, result1, ..., default)`.
    Switch {
        /// Expression to test.
        expr: Box<Expression>,
        /// Value-result pairs.
        cases: Vec<(Expression, Expression)>,
        /// Default result when no case matches.
        default: Option<Box<Expression>>,
    },

    /// Safe division: `DIVIDE(numerator, denominator [, alternate])`.
    ///
    /// Returns `alternate` (or NULL) when `denominator` is zero.
    SafeDivide {
        /// Numerator.
        numerator: Box<Expression>,
        /// Denominator.
        denominator: Box<Expression>,
        /// Alternate result when dividing by zero (defaults to NULL/BLANK).
        alternate: Option<Box<Expression>>,
    },

    /// NULL literal: `BLANK()`.
    Blank,

    /// NULL test: `ISBLANK(expr)` — evaluates to boolean.
    IsBlank(Box<Expression>),

    /// First non-null value: `COALESCE(expr1, expr2, ...)`.
    Coalesce(Vec<Expression>),

    /// Scalar function call: `ABS(x)`, `ROUND(x, n)`, etc.
    ScalarFunc {
        /// The scalar function.
        function: ScalarFunction,
        /// Function arguments.
        args: Vec<Expression>,
    },

    /// Text function call: `UPPER(text)`, `LEFT(text, n)`, etc.
    TextFunc {
        /// The text function.
        function: TextFunction,
        /// Function arguments.
        args: Vec<Expression>,
    },

    /// Intermediate grouped aggregation that produces a table.
    ///
    /// Used inside VAR bindings for two-stage aggregation:
    /// ```text
    /// VAR monthly = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_date[year], dim_date[month])
    /// RETURN AVG(monthly[revenue])
    /// ```
    ///
    /// The result is materialized as a RecordBatch and registered in DataFusion.
    /// The RETURN expression then aggregates over the intermediate table.
    Query {
        /// Aggregate expressions with output aliases: `(expression, alias)`.
        aggregates: Vec<(Expression, String)>,
        /// Group-by columns as `(table, column)` pairs.
        /// These are automatically included in the output table.
        group_by: Vec<(String, String)>,
    },

    /// Check if a column has exactly one distinct value in the current context.
    ///
    /// `HASONEVALUE(table[column])` — evaluates to boolean.
    /// SQL: `(COUNT(DISTINCT col) = 1)`.
    HasOneValue {
        /// The column expression to check.
        column: Box<Expression>,
    },

    /// Return the single value if there's exactly one, otherwise alternate.
    ///
    /// `SELECTEDVALUE(table[column] [, alternate])` — returns the column value
    /// when there's exactly one distinct value in context, otherwise returns
    /// the alternate (or BLANK).
    /// SQL: `CASE WHEN COUNT(DISTINCT col) = 1 THEN MIN(col) ELSE alternate END`.
    SelectedValue {
        /// The column expression to check.
        column: Box<Expression>,
        /// Alternate value when multiple distinct values exist. Defaults to NULL/BLANK.
        alternate: Option<Box<Expression>>,
    },

    /// Return the first value of a column ordered by another expression.
    ///
    /// `FIRST(table[column], ORDER BY table[sort_col])` — returns the first
    /// value according to the specified ordering.
    /// SQL: `FIRST_VALUE(col ORDER BY sort_col)`.
    FirstValue {
        /// The column to retrieve.
        column: Box<Expression>,
        /// The expression to order by.
        order_by: Box<Expression>,
    },

    /// Window function: aggregate over a sliding frame of pre-aggregated rows.
    ///
    /// ```text
    /// WINDOW(SUM(fact[amount]), SUM, ORDERBY(dim_date[date]), ROWS(1, ABS, 0, REL))
    /// ```
    ///
    /// Two-stage evaluation: the inner measure is materialized grouped by
    /// ORDER BY + PARTITION BY columns, then the window aggregate is applied.
    ///
    /// **The window `function` is applied over the per-period values of
    /// `inner`, not over the underlying fact rows.** This is the defining
    /// semantics of the primitive and is exactly what a time-series window
    /// wants: e.g. `WINDOW(SUM(fact[amount]), AVG, ORDERBY(d[month]),
    /// ROWS(-2, REL, 0, REL))` is a 3-month moving average *of the monthly
    /// totals* (each month weighted equally) — correct and intended. Be aware,
    /// though, that `WINDOW(AVG(fact[x]), AVG, ...)` is the *mean of the monthly
    /// averages*, which differs from the row-level average over the window when
    /// periods have unequal row counts. To get a true row-level windowed
    /// average, window `SUM` and `COUNT` separately and divide
    /// (`WINDOW(SUM(x), SUM, ...) / WINDOW(COUNT(x), SUM, ...)`). The
    /// single-aggregate time-intelligence sugar (`YTD`/`QTD`/`MTD`) rejects
    /// `AVERAGE` for this reason because it has no explicit outer function to
    /// disambiguate; the `WINDOW` primitive accepts it because the two
    /// aggregates are stated explicitly.
    Window {
        /// The inner measure expression to evaluate per-row before windowing.
        inner: Box<Expression>,
        /// The window aggregation function (SUM, AVG, MIN, MAX, COUNT).
        function: AggregateOp,
        /// ORDER BY columns as `(table, column)` pairs.
        order_by: Vec<(String, String)>,
        /// PARTITION BY columns as `(table, column)` pairs. Empty = single partition.
        partition_by: Vec<(String, String)>,
        /// Window frame boundaries. Default (None) = unbounded preceding to current row.
        frame: Option<WindowFrame>,
    },

    /// Get measure value at a relative offset from the current row.
    ///
    /// ```text
    /// OFFSET(SUM(fact[amount]), -1, ORDERBY(dim_date[month]))
    /// ```
    ///
    /// Returns the measure value at `delta` rows from current (negative = before,
    /// positive = after). Returns NULL if out of bounds.
    Offset {
        /// The inner measure expression.
        inner: Box<Expression>,
        /// Offset from current row.
        delta: i64,
        /// ORDER BY columns as `(table, column)` pairs.
        order_by: Vec<(String, String)>,
        /// PARTITION BY columns as `(table, column)` pairs.
        partition_by: Vec<(String, String)>,
    },

    /// Time-intelligence running aggregate: `YTD`/`QTD`/`MTD`.
    ///
    /// ```text
    /// YTD(SUM(fact[amount]))
    /// ```
    ///
    /// Query-axis semantics (v1): this is sugar that is **lowered** to an
    /// [`Expression::Window`] running aggregate at planning/execution time,
    /// using the model's marked date table
    /// (`DataModelBuilder::mark_date_table`) and the query's group_by axis.
    /// It is never rendered to SQL directly — a `ToDate` node reaching a
    /// renderer is an internal error. Lowering requires the date table's
    /// anchor role column(s) (Year; Year+Quarter for QTD; Year+Month for
    /// MTD) plus at least one finer date-role column in the query's
    /// group_by, and the inner expression must be a single
    /// SUM/COUNT/COUNTROWS/MIN/MAX aggregate; violations produce
    /// [`EngineError::TimeIntelligence`] — never silently wrong numbers.
    ToDate {
        /// The inner measure expression to accumulate to-date.
        expr: Box<Expression>,
        /// The reset granularity: Year = YTD, Quarter = QTD, Month = MTD.
        granularity: DateGranularity,
    },

    /// Time-intelligence period shift: `PRIORYEAR` / `PRIORPERIOD` /
    /// `PARALLELPERIOD`.
    ///
    /// ```text
    /// PRIORYEAR(SUM(fact[amount]))          // PeriodShift(-1, Year)
    /// PRIORPERIOD(SUM(fact[amount]), -2, "QUARTER")
    /// PARALLELPERIOD(SUM(fact[amount]), -1, "MONTH")
    /// ```
    ///
    /// In the **filter-context** path (no date column on the axis) this shifts
    /// the whole current date window back `offset` periods (Year/Quarter/Month);
    /// for a context spanning exactly one period that equals "the prior period".
    /// `PARALLELPERIOD` is a synonym that makes the whole-window-shift intent
    /// explicit. (DAX `DATEADD` is the scalar single-date function here, not this
    /// node.)
    ///
    /// Query-axis semantics (v1): lowered to an [`Expression::Offset`]
    /// (SQL `LAG`/`LEAD`) along the date table's anchor columns present in
    /// the query's group_by. The shift is **positional** along the sorted
    /// distinct axis values present in the result, so it requires a
    /// **contiguous** axis at the shift granularity. If a period is missing
    /// from the data (and therefore absent from the axis), a positional shift
    /// would read the nearest earlier present period instead of the true prior
    /// period — a wrong number; the executor detects this gap and fails closed
    /// with [`EngineError::TimeIntelligence`] rather than returning it. (A
    /// fully value-based shift that returns NULL for an absent prior period is
    /// a planned enhancement.) Never rendered to SQL directly; missing
    /// prerequisites also produce [`EngineError::TimeIntelligence`].
    PeriodShift {
        /// The inner measure expression to read at the shifted period.
        expr: Box<Expression>,
        /// Periods to shift: negative = earlier, positive = later.
        offset: i64,
        /// The granularity of the shift.
        granularity: DateGranularity,
    },

    /// Time-intelligence trailing window: `DATESINPERIOD` — the inner aggregate
    /// over a window of `intervals` periods ending at the current context's
    /// as-of date.
    ///
    /// ```text
    /// DATESINPERIOD(SUM(fact[amount]), -12, "MONTH")   // trailing 12 months
    /// ```
    ///
    /// `intervals` is signed (negative = trailing/backward, the common case);
    /// the magnitude is the number of `granularity` periods in the window. The
    /// window is half-open `[as_of + 1 day − |intervals| periods, as_of + 1 day)`
    /// so the as-of date is included.
    ///
    /// **Filter-context only (v1):** evaluated by probing the as-of date from the
    /// current date context and installing a concrete `DateKey` range (the same
    /// machinery as filter-context `YTD`). It is **not** supported with a date
    /// column on the group-by axis (a per-row moving window) — that fails closed
    /// with [`EngineError::TimeIntelligence`]. Requires a Gregorian calendar
    /// date table. Never rendered to SQL directly.
    DatesInPeriod {
        /// The inner measure expression to aggregate over the window.
        expr: Box<Expression>,
        /// Signed number of `granularity` periods in the window (negative =
        /// trailing).
        intervals: i64,
        /// The window's period unit.
        granularity: DateGranularity,
    },

    /// Semi-additive balance: the inner measure evaluated at a **single date
    /// boundary** of the current date context — `CLOSINGBALANCE` (the last date)
    /// or `OPENINGBALANCE` (the first date).
    ///
    /// ```text
    /// CLOSINGBALANCE(SUM(fact[on_hand]))   // inventory at the period end
    /// OPENINGBALANCE(SUM(fact[on_hand]))   // inventory at the period start
    /// ```
    ///
    /// This is the canonical pattern for non-additive-over-time stock measures
    /// (inventory, account balance, headcount): summing across days is wrong, so
    /// the value is pinned to the boundary day instead.
    ///
    /// **Filter-context only (v1):** evaluated by probing the last (closing) /
    /// first (opening) `DateKey` of the current date context and installing a
    /// single-day `DateKey = boundary` filter (the same machinery as
    /// filter-context `YTD` / `DATESINPERIOD`). It is **not** supported with a
    /// date column on the group-by axis, fails closed on a non-Gregorian
    /// calendar, and is never rendered to SQL directly.
    SemiAdditiveBalance {
        /// The inner measure to evaluate at the boundary date.
        expr: Box<Expression>,
        /// `true` = `OPENINGBALANCE` (first date in context); `false` =
        /// `CLOSINGBALANCE` (last date in context).
        opening: bool,
    },

    /// Get measure value at an absolute position within a partition.
    ///
    /// ```text
    /// INDEX(SUM(fact[amount]), 1, ORDERBY(dim_date[month]))
    /// ```
    ///
    /// Position is 1-based from start (positive) or from end (negative, -1 = last).
    /// Returns NULL if out of bounds.
    Index {
        /// The inner measure expression.
        inner: Box<Expression>,
        /// Absolute position (1-based positive, or negative from end).
        position: i64,
        /// ORDER BY columns as `(table, column)` pairs.
        order_by: Vec<(String, String)>,
        /// PARTITION BY columns as `(table, column)` pairs.
        partition_by: Vec<(String, String)>,
    },

    /// IN-list membership test: `expr IN (value1, value2, ...)`.
    ///
    /// Used inside KEEP conditions to filter by a set of literal values:
    /// ```text
    /// KEEP(dim, dim_product[color] IN {"Blue", "Red", "Black"})
    /// ```
    InList {
        /// The expression to test (typically a column reference).
        expr: Box<Expression>,
        /// The set of values to test against.
        values: Vec<Expression>,
    },

    /// Date/time function call: `YEAR(date)`, `MONTH(date)`, `DATEDIFF(...)`, etc.
    DateTimeFunc {
        /// The date/time function.
        function: DateTimeFunction,
        /// Function arguments.
        args: Vec<Expression>,
    },

    /// Error handling: `IFERROR(expr, alternate)`.
    ///
    /// Returns `alternate` when `expr` evaluates to NULL/error.
    /// SQL: `COALESCE(expr, alternate)`.
    IfError {
        /// The expression to evaluate.
        expr: Box<Expression>,
        /// The alternate value when expr is NULL/error.
        alternate: Box<Expression>,
    },

    /// Scope check: `ISINSCOPE(table[column])`.
    ///
    /// Returns TRUE if the specified column is in the current GROUP BY context.
    /// Must be resolved before SQL generation by replacing with `LiteralBool`.
    IsInScope {
        /// Table name.
        table: String,
        /// Column name.
        column: String,
    },

    /// Clear all filters on a table EXCEPT specified columns.
    ///
    /// `CLEAREXCEPT(expr, table, col1, col2, ...)` — like CLEAR(table) but
    /// preserves filters on the listed columns.
    ClearExcept {
        /// The inner expression.
        expr: Box<Expression>,
        /// The table to clear filters from.
        table: String,
        /// Columns whose filters should be preserved.
        except_columns: Vec<String>,
    },

    /// Iterator expression: `ITERATE(table, expr)`.
    ///
    /// Declares row-context iteration over a table. The expression is evaluated
    /// per-row and typically wrapped in an aggregate: `SUM(ITERATE(t, t[a] * t[b]))`.
    /// In SQL, this is transparent — the expression is rendered directly.
    Iterate {
        /// The table to iterate over.
        table: String,
        /// The per-row expression.
        expression: Box<Expression>,
    },

    /// Percentile aggregation: `PERCENTILE(column, k)`.
    ///
    /// Returns the k-th percentile (0.0–1.0) of the column values.
    ///
    /// **Approximate.** This is always evaluated locally via DataFusion's
    /// `approx_percentile_cont` (a t-digest approximation), never pushed to a
    /// source — even when the source (e.g. PostgreSQL) could compute an exact
    /// `PERCENTILE_CONT`. The pushdown planner forces it local so the result is
    /// consistent regardless of query topology; pushing it would make the same
    /// measure return an exact value on a single source and an approximation
    /// whenever a cross-source join or in-memory table forced local execution.
    /// Host applications should treat the result as approximate. (DataFusion 44
    /// ships no exact non-median percentile aggregate.)
    Percentile {
        /// The expression to aggregate.
        operand: Box<Expression>,
        /// The percentile value (0.0 to 1.0), typically a literal float.
        percentile: Box<Expression>,
    },

    // --- Group 3: Conditional functions ---
    /// Maximum of multiple values: `GREATEST(a, b, ...)`.
    /// SQL: `GREATEST(a, b, ...)`.
    Greatest(Vec<Expression>),

    /// Minimum of multiple values: `LEAST(a, b, ...)`.
    /// SQL: `LEAST(a, b, ...)`.
    Least(Vec<Expression>),

    /// Return NULL if two values are equal: `NULLIF(a, b)`.
    /// SQL: `NULLIF(a, b)`.
    NullIf {
        /// The expression to return (if not equal to value).
        expr: Box<Expression>,
        /// The comparison value.
        value: Box<Expression>,
    },

    // --- Group 4: Aggregation functions ---
    /// Conditional count: `COUNT_IF(condition)` or `COUNTIF(condition)`.
    /// Counts rows where the condition is true.
    /// SQL: `SUM(CASE WHEN cond THEN 1 ELSE 0 END)`.
    CountIf {
        /// Boolean condition expression.
        condition: Box<Expression>,
    },

    /// Concatenate strings within a group: `LISTAGG(column, delimiter)`.
    /// SQL: `STRING_AGG(col, delimiter)`.
    ListAgg {
        /// The column/expression to concatenate.
        column: Box<Expression>,
        /// The delimiter between values.
        delimiter: Box<Expression>,
    },

    /// Value at the row with the maximum of another column: `MAX_BY(value, sort_col)`.
    /// SQL: uses a subquery or window function approach.
    MaxBy {
        /// The value to retrieve.
        value: Box<Expression>,
        /// The column to maximize.
        sort_by: Box<Expression>,
    },

    /// Value at the row with the minimum of another column: `MIN_BY(value, sort_col)`.
    /// SQL: uses a subquery or window function approach.
    MinBy {
        /// The value to retrieve.
        value: Box<Expression>,
        /// The column to minimize.
        sort_by: Box<Expression>,
    },

    // --- Group 5: Window ranking functions ---
    /// Ranking window function: `ROW_NUMBER(...)`, `RANK(...)`, `DENSE_RANK(...)`.
    ///
    /// Unlike `Window` which wraps an aggregate, these produce ordinal values
    /// based on ordering and partitioning alone.
    RankWindow {
        /// The ranking function to apply.
        function: RankFunction,
        /// ORDER BY columns as `(table, column)` pairs.
        order_by: Vec<(String, String)>,
        /// PARTITION BY columns as `(table, column)` pairs.
        partition_by: Vec<(String, String)>,
    },

    /// Call to a host-registered scalar UDF: `name(arg1, arg2, ...)`.
    ///
    /// The function itself is not part of the engine — it must be registered
    /// by the host application through a
    /// [`UdfRegistry`](crate::compute::udf::UdfRegistry) before any query
    /// referencing it executes. The call is row-level (never an aggregate);
    /// aggregates may appear in its arguments or wrap it
    /// (`SUM(double(t[amount]))`).
    ///
    /// UDF calls never push down to source SQL — they force local
    /// aggregation and render only in the DataFusion dialect, where the
    /// name is emitted lowercased to match DataFusion's case-insensitive
    /// (lowercase-normalizing) function resolution.
    ///
    /// **Security:** the name is spliced into SQL without quoting, so
    /// [`Expression::validate`] rejects any name that does not match
    /// `^[A-Za-z_][A-Za-z0-9_]{0,63}$`; the renderer re-checks the same rule
    /// (fail closed for expressions deserialized from untrusted model files).
    Call {
        /// The function name as written in the measure / model file.
        name: String,
        /// Argument expressions, in call order.
        args: Vec<Expression>,
    },

    /// `SELECTEDMEASURE()` — the placeholder for the measure a calculation
    /// item is currently being applied to.
    ///
    /// This is a unit placeholder, legal **only** inside a calculation item's
    /// expression (see
    /// [`CalculationItem`](crate::model::CalculationItem)). When a calculation
    /// group is applied to a measure, every `SelectedMeasure` node in the
    /// item's expression is replaced with the target measure's expression tree
    /// (see [`Expression::substitute_selected_measure`]).
    ///
    /// It must never reach SQL generation or context resolution unsubstituted:
    /// the SQL renderers reject it (exactly as they reject an unexpanded
    /// [`MeasureRef`](Expression::MeasureRef)), [`Expression::validate`]
    /// rejects it for ordinary measures and calculated columns (only
    /// [`Expression::validate_calc_item`] permits it), and the pushdown
    /// planner treats it as unpushable so it can never be pushed to a source.
    SelectedMeasure,
}
