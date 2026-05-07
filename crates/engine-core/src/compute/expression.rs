//! Expression AST for calculated columns and measure definitions.
//!
//! Expressions can represent row-level computations (for calculated columns)
//! or aggregate computations (for measures). The same `Expression` type
//! serves both purposes — calculated columns use expressions without
//! `Aggregate` nodes, while measures use expressions that contain them.

use serde::{Deserialize, Serialize};

use crate::compute::aggregate::AggregateOp;
use crate::model::context::ClearTarget;

/// Comparison operators for filter predicates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ComparisonOp {
    /// `=`
    Equal,
    /// `!=`
    NotEqual,
    /// `>`
    GreaterThan,
    /// `>=`
    GreaterThanOrEqual,
    /// `<`
    LessThan,
    /// `<=`
    LessThanOrEqual,
}

impl ComparisonOp {
    /// Returns the SQL operator string.
    pub fn as_sql(&self) -> &'static str {
        match self {
            Self::Equal => "=",
            Self::NotEqual => "!=",
            Self::GreaterThan => ">",
            Self::GreaterThanOrEqual => ">=",
            Self::LessThan => "<",
            Self::LessThanOrEqual => "<=",
        }
    }
}

/// A filter predicate: `Table.Column op value`.
///
/// Used inside `keep()` to add filter conditions to the evaluation context.
/// Column references are always fully qualified with `Table.Column`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FilterPredicate {
    /// Table name.
    pub table: String,
    /// Column name.
    pub column: String,
    /// Comparison operator.
    pub operator: ComparisonOp,
    /// Value to compare against (string representation).
    pub value: String,
}

impl FilterPredicate {
    /// Create a new filter predicate.
    pub fn new(
        table: impl Into<String>,
        column: impl Into<String>,
        operator: ComparisonOp,
        value: impl Into<String>,
    ) -> Self {
        Self {
            table: table.into(),
            column: column.into(),
            operator,
            value: value.into(),
        }
    }
}

/// A path through relationships for explicit traversal.
///
/// Represents a chain of table names: `Sales -> Products` or
/// `Sales -> Warehouse -> Products`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelationshipPath {
    /// Ordered list of table names forming the traversal path.
    pub hops: Vec<String>,
}

impl RelationshipPath {
    /// Create a path from table names.
    pub fn new(hops: Vec<impl Into<String>>) -> Self {
        Self {
            hops: hops.into_iter().map(Into::into).collect(),
        }
    }
}

/// An IN-membership predicate: `table.column IN var_name.var_column`.
///
/// Tests whether values in `table.column` are members of the set defined
/// by `var_column` in the table variable `var_name`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InPredicate {
    /// Table containing the column to test.
    pub table: String,
    /// Column to test for membership.
    pub column: String,
    /// Table variable providing the set.
    pub var_name: String,
    /// Column in the variable defining the set values.
    pub var_column: String,
}

impl InPredicate {
    /// Create a new IN predicate.
    pub fn new(
        table: impl Into<String>,
        column: impl Into<String>,
        var_name: impl Into<String>,
        var_column: impl Into<String>,
    ) -> Self {
        Self {
            table: table.into(),
            column: column.into(),
            var_name: var_name.into(),
            var_column: var_column.into(),
        }
    }
}

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

/// Scalar math functions for use in expressions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ScalarFunction {
    /// Absolute value: `ABS(x)`.
    Abs,
    /// Round to N decimal places: `ROUND(x, n)`.
    Round,
    /// Round up (away from zero): `ROUNDUP(x, n)`.
    RoundUp,
    /// Round down (toward zero): `ROUNDDOWN(x, n)`.
    RoundDown,
    /// Truncate to integer: `INT(x)` (equivalent to `FLOOR`).
    Int,
    /// Truncate fractional part: `TRUNC(x [, n])`.
    Trunc,
    /// Round up to nearest multiple: `CEILING(x, significance)`.
    Ceiling,
    /// Round down to nearest multiple: `FLOOR(x, significance)`.
    Floor,
    /// Modulo: `MOD(x, y)`.
    Mod,
    /// Power: `POWER(x, y)`.
    Power,
    /// Square root: `SQRT(x)`.
    Sqrt,
    /// Natural logarithm: `LN(x)`.
    Ln,
    /// Base-10 logarithm: `LOG10(x)`.
    Log10,
    /// Sign: `SIGN(x)`.
    Sign,
    /// Exponential: `EXP(x)` — e^x.
    Exp,
    /// Logarithm with custom base: `LOG(x, base)`.
    Log,
    /// Pi constant: `PI()` — returns 3.14159...
    Pi,
}

/// Date/time functions for use in expressions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DateTimeFunction {
    /// Extract year from date: `YEAR(date)`.
    Year,
    /// Extract month from date: `MONTH(date)`.
    Month,
    /// Extract day from date: `DAY(date)`.
    Day,
    /// Extract quarter from date: `QUARTER(date)`.
    Quarter,
    /// Construct a date from parts: `DATE(year, month, day)`.
    Date,
    /// Difference between dates: `DATEDIFF(start, end, interval_string)`.
    /// Interval is passed as a `LiteralString`: `"DAY"`, `"MONTH"`, `"YEAR"`, `"QUARTER"`.
    DateDiff,
    /// Current date: `TODAY()`.
    Today,
    /// Current date and time: `NOW()`.
    Now,
}

impl ScalarFunction {
    /// Render as a SQL function call with the given arguments.
    pub fn to_sql(&self, args: &[Expression]) -> String {
        let strs: Vec<String> = args.iter().map(|a| a.to_sql_string()).collect();
        self.to_sql_strs(&strs)
    }

    /// Render as a SQL function call with pre-rendered string arguments.
    pub fn to_sql_strs(&self, args: &[String]) -> String {
        match self {
            Self::Abs => format!("ABS({})", args[0]),
            Self::Round => {
                let digits = args.get(1).map(|s| s.as_str()).unwrap_or("0");
                format!("ROUND({}, {digits})", args[0])
            }
            Self::RoundUp => {
                let digits = args.get(1).map(|s| s.as_str()).unwrap_or("0");
                format!("ROUND({}, {digits})", args[0])
            }
            Self::RoundDown => {
                let digits = args.get(1).map(|s| s.as_str()).unwrap_or("0");
                format!("TRUNC({}, {digits})", args[0])
            }
            Self::Int => format!("FLOOR({})", args[0]),
            Self::Trunc => {
                let digits = args.get(1).map(|s| s.as_str()).unwrap_or("0");
                format!("TRUNC({}, {digits})", args[0])
            }
            Self::Ceiling => {
                let sig = args.get(1).map(|s| s.as_str()).unwrap_or("1");
                format!("CEILING({} / {sig}) * {sig}", args[0])
            }
            Self::Floor => {
                let sig = args.get(1).map(|s| s.as_str()).unwrap_or("1");
                format!("FLOOR({} / {sig}) * {sig}", args[0])
            }
            Self::Mod => format!("({} % {})", args[0], args[1]),
            Self::Power => format!("POWER({}, {})", args[0], args[1]),
            Self::Sqrt => format!("SQRT({})", args[0]),
            Self::Ln => format!("LN({})", args[0]),
            Self::Log10 => format!("LOG10({})", args[0]),
            Self::Sign => format!("signum({})", args[0]),
            Self::Exp => format!("EXP({})", args[0]),
            Self::Log => {
                let base = args.get(1).map(|s| s.as_str()).unwrap_or("10");
                format!("LOG({}, {})", args[0], base)
            }
            Self::Pi => "PI()".to_string(),
        }
    }
}

impl std::fmt::Display for ScalarFunction {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Abs => write!(f, "ABS"),
            Self::Round => write!(f, "ROUND"),
            Self::RoundUp => write!(f, "ROUNDUP"),
            Self::RoundDown => write!(f, "ROUNDDOWN"),
            Self::Int => write!(f, "INT"),
            Self::Trunc => write!(f, "TRUNC"),
            Self::Ceiling => write!(f, "CEILING"),
            Self::Floor => write!(f, "FLOOR"),
            Self::Mod => write!(f, "MOD"),
            Self::Power => write!(f, "POWER"),
            Self::Sqrt => write!(f, "SQRT"),
            Self::Ln => write!(f, "LN"),
            Self::Log10 => write!(f, "LOG10"),
            Self::Sign => write!(f, "SIGN"),
            Self::Exp => write!(f, "EXP"),
            Self::Log => write!(f, "LOG"),
            Self::Pi => write!(f, "PI"),
        }
    }
}

impl DateTimeFunction {
    /// Render as a SQL function call with the given arguments.
    pub fn to_sql(&self, args: &[Expression]) -> String {
        let strs: Vec<String> = args.iter().map(|a| a.to_sql_string()).collect();
        self.to_sql_strs(&strs)
    }

    /// Render as a SQL function call with pre-rendered string arguments.
    pub fn to_sql_strs(&self, args: &[String]) -> String {
        match self {
            Self::Year => format!("date_part('year', {})", args[0]),
            Self::Month => format!("date_part('month', {})", args[0]),
            Self::Day => format!("date_part('day', {})", args[0]),
            Self::Quarter => format!("date_part('quarter', {})", args[0]),
            Self::Date => format!("make_date({}, {}, {})", args[0], args[1], args[2]),
            Self::DateDiff => {
                // Third arg is the interval string literal (e.g. 'DAY').
                // Strip surrounding quotes if present for matching.
                let interval_raw = args
                    .get(2)
                    .map(|s| s.trim_matches('\'').to_uppercase())
                    .unwrap_or_else(|| "DAY".to_string());
                let start = &args[0];
                let end = &args[1];
                match interval_raw.as_str() {
                    "DAY" => {
                        format!("CAST(CAST({end} AS DATE) - CAST({start} AS DATE) AS INTEGER)")
                    }
                    "MONTH" => format!(
                        "CAST((date_part('year', {end}) - date_part('year', {start})) * 12 \
                         + date_part('month', {end}) - date_part('month', {start}) AS INTEGER)"
                    ),
                    "YEAR" => format!(
                        "CAST(date_part('year', {end}) - date_part('year', {start}) AS INTEGER)"
                    ),
                    "QUARTER" => format!(
                        "CAST((date_part('year', {end}) - date_part('year', {start})) * 4 \
                         + date_part('quarter', {end}) - date_part('quarter', {start}) AS INTEGER)"
                    ),
                    _ => format!("CAST(CAST({end} AS DATE) - CAST({start} AS DATE) AS INTEGER)"),
                }
            }
            Self::Today => "CURRENT_DATE".to_string(),
            Self::Now => "NOW()".to_string(),
        }
    }
}

impl std::fmt::Display for DateTimeFunction {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Year => write!(f, "YEAR"),
            Self::Month => write!(f, "MONTH"),
            Self::Day => write!(f, "DAY"),
            Self::Quarter => write!(f, "QUARTER"),
            Self::Date => write!(f, "DATE"),
            Self::DateDiff => write!(f, "DATEDIFF"),
            Self::Today => write!(f, "TODAY"),
            Self::Now => write!(f, "NOW"),
        }
    }
}

/// Text functions for use in expressions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TextFunction {
    /// Concatenate text strings: `CONCATENATE(text1, text2, ...)`.
    /// Extended from DAX to accept arbitrary number of arguments.
    Concatenate,
    /// Combine values with a delimiter: `COMBINEVALUES(delimiter, text1, text2, ...)`.
    CombineValues,
    /// Case-sensitive comparison: `EXACT(text1, text2)`.
    Exact,
    /// Find position (case-sensitive): `FIND(find_text, within_text [, start_pos])`.
    /// Returns 1-based position or error if not found.
    Find,
    /// Round number and format as text: `FIXED(number [, decimals [, no_commas]])`.
    Fixed,
    /// Left substring: `LEFT(text [, num_chars])`.
    Left,
    /// String length: `LEN(text)`.
    Len,
    /// Convert to lowercase: `LOWER(text)`.
    Lower,
    /// Substring from middle: `MID(text, start_pos, num_chars)`.
    Mid,
    /// Replace by position: `REPLACE(old_text, start_pos, num_chars, new_text)`.
    Replace,
    /// Repeat text: `REPT(text, number_times)`.
    Rept,
    /// Right substring: `RIGHT(text [, num_chars])`.
    Right,
    /// Find position (case-insensitive): `SEARCH(find_text, within_text [, start_pos])`.
    Search,
    /// Replace occurrences of text: `SUBSTITUTE(text, old_text, new_text [, instance_num])`.
    Substitute,
    /// Remove leading/trailing spaces: `TRIM(text)`.
    Trim,
    /// Unicode character from code point: `UNICHAR(number)`.
    Unichar,
    /// Unicode code point of first character: `UNICODE(text)`.
    Unicode,
    /// Convert to uppercase: `UPPER(text)`.
    Upper,
    /// Convert text to number: `VALUE(text)`.
    Value,
    /// Remove leading characters: `LTRIM(text [, characters])`.
    /// Snowflake extension. Default removes spaces.
    Ltrim,
    /// Remove trailing characters: `RTRIM(text [, characters])`.
    /// Snowflake extension. Default removes spaces.
    Rtrim,
    /// Left-pad to length: `LPAD(text, length [, pad])`.
    /// Snowflake extension. Default pads with spaces.
    Lpad,
    /// Right-pad to length: `RPAD(text, length [, pad])`.
    /// Snowflake extension. Default pads with spaces.
    Rpad,
    /// Reverse a string: `REVERSE(text)`.
    /// Snowflake extension.
    Reverse,
    /// Extract part of a delimited string: `SPLIT(text, delimiter, part_number)`.
    /// Maps to SQL `SPLIT_PART`. Part number is 1-based. Snowflake extension.
    Split,
    /// Format a value as text: `FORMAT(value, format_string)`.
    /// Maps to SQL `TO_CHAR(value, format)` for dates, `CAST` for numbers.
    Format,
}

impl TextFunction {
    /// Render as a SQL function call with the given arguments.
    pub fn to_sql(&self, args: &[Expression]) -> String {
        let strs: Vec<String> = args.iter().map(|a| a.to_sql_string()).collect();
        self.to_sql_strs(&strs)
    }

    /// Render as a SQL function call with pre-rendered string arguments.
    pub fn to_sql_strs(&self, args: &[String]) -> String {
        match self {
            Self::Concatenate => {
                format!("CONCAT({})", args.join(", "))
            }
            Self::CombineValues => {
                // First arg is delimiter, rest are values.
                if args.len() < 2 {
                    return "''".to_string();
                }
                let delimiter = &args[0];
                let values = &args[1..];
                // CONCAT_WS(delimiter, val1, val2, ...)
                format!("CONCAT_WS({delimiter}, {})", values.join(", "))
            }
            Self::Exact => {
                // Case-sensitive comparison: returns boolean.
                format!("({} = {})", args[0], args[1])
            }
            Self::Find => {
                // STRPOS(within_text, find_text) — 1-based.
                // With optional start_pos, use STRPOS on substring.
                if args.len() >= 3 {
                    // STRPOS(SUBSTRING(within FROM start), find) + start - 1
                    format!(
                        "(STRPOS(SUBSTRING({} FROM {}), {}) + {} - 1)",
                        args[1], args[2], args[0], args[2]
                    )
                } else {
                    format!("STRPOS({}, {})", args[1], args[0])
                }
            }
            Self::Fixed => {
                // CAST(ROUND(number, decimals) AS VARCHAR)
                let decimals = args.get(1).map(|s| s.as_str()).unwrap_or("2");
                format!("CAST(ROUND({}, {decimals}) AS VARCHAR)", args[0])
            }
            Self::Left => {
                let n = args.get(1).map(|s| s.as_str()).unwrap_or("1");
                format!("LEFT({}, {n})", args[0])
            }
            Self::Len => format!("LENGTH({})", args[0]),
            Self::Lower => format!("LOWER({})", args[0]),
            Self::Mid => {
                // SUBSTRING(text FROM start FOR length)
                format!("SUBSTRING({} FROM {} FOR {})", args[0], args[1], args[2])
            }
            Self::Replace => {
                // OVERLAY(old_text PLACING new_text FROM start FOR num_chars)
                format!(
                    "OVERLAY({} PLACING {} FROM {} FOR {})",
                    args[0], args[3], args[1], args[2]
                )
            }
            Self::Rept => format!("REPEAT({}, {})", args[0], args[1]),
            Self::Right => {
                let n = args.get(1).map(|s| s.as_str()).unwrap_or("1");
                format!("RIGHT({}, {n})", args[0])
            }
            Self::Search => {
                // Case-insensitive: STRPOS(LOWER(within), LOWER(find))
                if args.len() >= 3 {
                    format!(
                        "(STRPOS(LOWER(SUBSTRING({} FROM {})), LOWER({})) + {} - 1)",
                        args[1], args[2], args[0], args[2]
                    )
                } else {
                    format!("STRPOS(LOWER({}), LOWER({}))", args[1], args[0])
                }
            }
            Self::Substitute => {
                // REPLACE(text, old_text, new_text) — SQL standard.
                // instance_num is ignored (replaces all, like SQL REPLACE).
                format!("REPLACE({}, {}, {})", args[0], args[1], args[2])
            }
            Self::Trim => format!("TRIM({})", args[0]),
            Self::Unichar => format!("CHR({})", args[0]),
            Self::Unicode => format!("ASCII({})", args[0]),
            Self::Upper => format!("UPPER({})", args[0]),
            Self::Value => format!("CAST({} AS DOUBLE)", args[0]),
            Self::Ltrim => {
                if args.len() >= 2 {
                    format!("LTRIM({}, {})", args[0], args[1])
                } else {
                    format!("LTRIM({})", args[0])
                }
            }
            Self::Rtrim => {
                if args.len() >= 2 {
                    format!("RTRIM({}, {})", args[0], args[1])
                } else {
                    format!("RTRIM({})", args[0])
                }
            }
            Self::Lpad => {
                if args.len() >= 3 {
                    format!("LPAD({}, {}, {})", args[0], args[1], args[2])
                } else {
                    format!("LPAD({}, {})", args[0], args[1])
                }
            }
            Self::Rpad => {
                if args.len() >= 3 {
                    format!("RPAD({}, {}, {})", args[0], args[1], args[2])
                } else {
                    format!("RPAD({}, {})", args[0], args[1])
                }
            }
            Self::Reverse => format!("REVERSE({})", args[0]),
            Self::Split => {
                format!("SPLIT_PART({}, {}, {})", args[0], args[1], args[2])
            }
            Self::Format => {
                // TO_CHAR works in DataFusion for date formatting.
                // For numbers, falls back to CAST.
                format!("TO_CHAR({}, {})", args[0], args[1])
            }
        }
    }
}

impl std::fmt::Display for TextFunction {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Concatenate => write!(f, "CONCATENATE"),
            Self::CombineValues => write!(f, "COMBINEVALUES"),
            Self::Exact => write!(f, "EXACT"),
            Self::Find => write!(f, "FIND"),
            Self::Fixed => write!(f, "FIXED"),
            Self::Left => write!(f, "LEFT"),
            Self::Len => write!(f, "LEN"),
            Self::Lower => write!(f, "LOWER"),
            Self::Mid => write!(f, "MID"),
            Self::Replace => write!(f, "REPLACE"),
            Self::Rept => write!(f, "REPT"),
            Self::Right => write!(f, "RIGHT"),
            Self::Search => write!(f, "SEARCH"),
            Self::Substitute => write!(f, "SUBSTITUTE"),
            Self::Trim => write!(f, "TRIM"),
            Self::Unichar => write!(f, "UNICHAR"),
            Self::Unicode => write!(f, "UNICODE"),
            Self::Upper => write!(f, "UPPER"),
            Self::Value => write!(f, "VALUE"),
            Self::Ltrim => write!(f, "LTRIM"),
            Self::Rtrim => write!(f, "RTRIM"),
            Self::Lpad => write!(f, "LPAD"),
            Self::Rpad => write!(f, "RPAD"),
            Self::Reverse => write!(f, "REVERSE"),
            Self::Split => write!(f, "SPLIT"),
            Self::Format => write!(f, "FORMAT"),
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
    /// SQL: `approx_percentile_cont(col, k)`.
    Percentile {
        /// The expression to aggregate.
        operand: Box<Expression>,
        /// The percentile value (0.0 to 1.0), typically a literal float.
        percentile: Box<Expression>,
    },
}

impl Expression {
    /// Returns all column names referenced by this expression.
    pub fn column_references(&self) -> Vec<&str> {
        let mut refs = Vec::new();
        self.collect_column_refs(&mut refs);
        refs.sort_unstable();
        refs.dedup();
        refs
    }

    fn collect_column_refs<'a>(&'a self, refs: &mut Vec<&'a str>) {
        match self {
            Expression::ColumnRef(name) => refs.push(name),
            Expression::QualifiedColumnRef { column, .. } => refs.push(column),
            Expression::TableRef(_)
            | Expression::MeasureRef(_)
            | Expression::LiteralFloat(_)
            | Expression::LiteralInt(_)
            | Expression::LiteralString(_)
            | Expression::LiteralBool(_)
            | Expression::Blank => {}
            Expression::BinaryOp { left, right, .. }
            | Expression::Comparison { left, right, .. }
            | Expression::And(left, right)
            | Expression::Or(left, right)
            | Expression::Xor(left, right) => {
                left.collect_column_refs(refs);
                right.collect_column_refs(refs);
            }
            Expression::Aggregate { operand, .. } => {
                operand.collect_column_refs(refs);
            }
            Expression::Not(inner) | Expression::IsBlank(inner) => {
                inner.collect_column_refs(refs);
            }
            Expression::Keep { expr, .. }
            | Expression::Clear { expr, .. }
            | Expression::Reset { expr }
            | Expression::ClearInner { expr, .. }
            | Expression::ClearOuter { expr, .. }
            | Expression::ResetInner { expr }
            | Expression::ResetOuter { expr }
            | Expression::Traverse { expr, .. }
            | Expression::Using { expr, .. }
            | Expression::UseRelationship { expr, .. }
            | Expression::KeepIn { expr, .. } => {
                expr.collect_column_refs(refs);
            }
            Expression::Block { bindings, result } => {
                // Collect refs from binding expressions and result, but exclude
                // VAR binding names since those are local variables, not real columns.
                let binding_names: Vec<&str> =
                    bindings.iter().map(|(name, _)| name.as_str()).collect();

                // Collect column names produced by Query bindings (aliases +
                // group-by columns) — these are intermediate table columns,
                // not physical column references from the data model.
                let mut query_output_cols: Vec<&str> = Vec::new();
                for (_, binding_expr) in bindings {
                    if let Expression::Query {
                        aggregates,
                        group_by,
                    } = binding_expr
                    {
                        for (_, alias) in aggregates {
                            query_output_cols.push(alias.as_str());
                        }
                        for (_, col) in group_by {
                            query_output_cols.push(col.as_str());
                        }
                    }
                }

                for (_, binding_expr) in bindings {
                    let mut binding_refs = Vec::new();
                    binding_expr.collect_column_refs(&mut binding_refs);
                    for r in binding_refs {
                        if !binding_names.contains(&r) && !query_output_cols.contains(&r) {
                            refs.push(r);
                        }
                    }
                }
                let mut result_refs = Vec::new();
                result.collect_column_refs(&mut result_refs);
                for r in result_refs {
                    if !binding_names.contains(&r) && !query_output_cols.contains(&r) {
                        refs.push(r);
                    }
                }
            }
            Expression::If {
                condition,
                then_expr,
                else_expr,
            } => {
                condition.collect_column_refs(refs);
                then_expr.collect_column_refs(refs);
                else_expr.collect_column_refs(refs);
            }
            Expression::Switch {
                expr,
                cases,
                default,
            } => {
                expr.collect_column_refs(refs);
                for (val, result) in cases {
                    val.collect_column_refs(refs);
                    result.collect_column_refs(refs);
                }
                if let Some(d) = default {
                    d.collect_column_refs(refs);
                }
            }
            Expression::SafeDivide {
                numerator,
                denominator,
                alternate,
            } => {
                numerator.collect_column_refs(refs);
                denominator.collect_column_refs(refs);
                if let Some(alt) = alternate {
                    alt.collect_column_refs(refs);
                }
            }
            Expression::Coalesce(exprs) => {
                for e in exprs {
                    e.collect_column_refs(refs);
                }
            }
            Expression::ScalarFunc { args, .. }
            | Expression::TextFunc { args, .. }
            | Expression::DateTimeFunc { args, .. } => {
                for arg in args {
                    arg.collect_column_refs(refs);
                }
            }
            Expression::IfError { expr, alternate } => {
                expr.collect_column_refs(refs);
                alternate.collect_column_refs(refs);
            }
            Expression::IsInScope { .. } => {}
            Expression::ClearExcept { expr, .. }
            | Expression::Iterate {
                expression: expr, ..
            } => {
                expr.collect_column_refs(refs);
            }
            Expression::Percentile {
                operand,
                percentile,
            } => {
                operand.collect_column_refs(refs);
                percentile.collect_column_refs(refs);
            }
            Expression::Query { aggregates, .. } => {
                // Only collect refs from aggregate expressions. Group-by
                // columns are structural (table, column) pairs referencing
                // other tables — they are not column refs of the fact table.
                for (expr, _) in aggregates {
                    expr.collect_column_refs(refs);
                }
            }
            Expression::HasOneValue { column } => column.collect_column_refs(refs),
            Expression::SelectedValue { column, alternate } => {
                column.collect_column_refs(refs);
                if let Some(alt) = alternate {
                    alt.collect_column_refs(refs);
                }
            }
            Expression::FirstValue { column, order_by } => {
                column.collect_column_refs(refs);
                order_by.collect_column_refs(refs);
            }
            Expression::Window { inner, .. }
            | Expression::Offset { inner, .. }
            | Expression::Index { inner, .. } => {
                // Only collect refs from the inner measure expression.
                // order_by/partition_by are structural (table, column) pairs,
                // not column refs of the fact table.
                inner.collect_column_refs(refs);
            }
            Expression::InList { expr, values } => {
                expr.collect_column_refs(refs);
                for v in values {
                    v.collect_column_refs(refs);
                }
            }
        }
    }

    /// Returns `true` if this expression contains any `Aggregate` nodes.
    pub fn has_aggregate(&self) -> bool {
        match self {
            Expression::ColumnRef(_)
            | Expression::QualifiedColumnRef { .. }
            | Expression::TableRef(_)
            | Expression::MeasureRef(_)
            | Expression::LiteralFloat(_)
            | Expression::LiteralInt(_)
            | Expression::LiteralString(_)
            | Expression::LiteralBool(_)
            | Expression::Blank => false,
            Expression::BinaryOp { left, right, .. }
            | Expression::Comparison { left, right, .. }
            | Expression::And(left, right)
            | Expression::Or(left, right)
            | Expression::Xor(left, right) => left.has_aggregate() || right.has_aggregate(),
            Expression::Not(inner) | Expression::IsBlank(inner) => inner.has_aggregate(),
            Expression::Aggregate { .. } => true,
            Expression::Keep { expr, .. }
            | Expression::Clear { expr, .. }
            | Expression::Reset { expr }
            | Expression::ClearInner { expr, .. }
            | Expression::ClearOuter { expr, .. }
            | Expression::ResetInner { expr }
            | Expression::ResetOuter { expr }
            | Expression::Traverse { expr, .. }
            | Expression::Using { expr, .. }
            | Expression::UseRelationship { expr, .. }
            | Expression::KeepIn { expr, .. } => expr.has_aggregate(),
            Expression::Block { bindings, result } => {
                bindings.iter().any(|(_, e)| e.has_aggregate()) || result.has_aggregate()
            }
            Expression::If {
                condition,
                then_expr,
                else_expr,
            } => {
                condition.has_aggregate() || then_expr.has_aggregate() || else_expr.has_aggregate()
            }
            Expression::Switch {
                expr,
                cases,
                default,
            } => {
                expr.has_aggregate()
                    || cases
                        .iter()
                        .any(|(v, r)| v.has_aggregate() || r.has_aggregate())
                    || default.as_ref().is_some_and(|d| d.has_aggregate())
            }
            Expression::SafeDivide {
                numerator,
                denominator,
                alternate,
            } => {
                numerator.has_aggregate()
                    || denominator.has_aggregate()
                    || alternate.as_ref().is_some_and(|a| a.has_aggregate())
            }
            Expression::Coalesce(exprs) => exprs.iter().any(|e| e.has_aggregate()),
            Expression::ScalarFunc { args, .. }
            | Expression::TextFunc { args, .. }
            | Expression::DateTimeFunc { args, .. } => args.iter().any(|a| a.has_aggregate()),
            Expression::IfError { expr, alternate } => {
                expr.has_aggregate() || alternate.has_aggregate()
            }
            Expression::IsInScope { .. } => false,
            Expression::ClearExcept { expr, .. } => expr.has_aggregate(),
            Expression::Iterate { expression, .. } => expression.has_aggregate(),
            Expression::Percentile { .. } => true,
            Expression::Query { .. } => true,
            // These functions contain implicit aggregates.
            Expression::HasOneValue { .. }
            | Expression::SelectedValue { .. }
            | Expression::FirstValue { .. } => true,
            // Window functions contain implicit aggregates (two-stage).
            Expression::Window { .. } | Expression::Offset { .. } | Expression::Index { .. } => {
                true
            }
            Expression::InList { expr, values } => {
                expr.has_aggregate() || values.iter().any(|v| v.has_aggregate())
            }
        }
    }

    /// Returns `true` if this expression contains any context manipulation nodes
    /// (`Keep`, `Clear`, `Reset`, `Traverse`, `Using`, or `Block`).
    pub fn has_context_ops(&self) -> bool {
        match self {
            Expression::ColumnRef(_)
            | Expression::QualifiedColumnRef { .. }
            | Expression::TableRef(_)
            | Expression::MeasureRef(_)
            | Expression::LiteralFloat(_)
            | Expression::LiteralInt(_)
            | Expression::LiteralString(_)
            | Expression::LiteralBool(_)
            | Expression::Blank => false,
            Expression::BinaryOp { left, right, .. }
            | Expression::Comparison { left, right, .. }
            | Expression::And(left, right)
            | Expression::Or(left, right)
            | Expression::Xor(left, right) => left.has_context_ops() || right.has_context_ops(),
            Expression::Not(inner) | Expression::IsBlank(inner) => inner.has_context_ops(),
            Expression::Aggregate { operand, .. } => operand.has_context_ops(),
            Expression::Keep { .. }
            | Expression::Clear { .. }
            | Expression::Reset { .. }
            | Expression::ClearInner { .. }
            | Expression::ClearOuter { .. }
            | Expression::ResetInner { .. }
            | Expression::ResetOuter { .. }
            | Expression::Traverse { .. }
            | Expression::Using { .. }
            | Expression::UseRelationship { .. }
            | Expression::KeepIn { .. } => true,
            Expression::Block { bindings, result } => {
                bindings.iter().any(|(_, expr)| expr.has_context_ops()) || result.has_context_ops()
            }
            Expression::If {
                condition,
                then_expr,
                else_expr,
            } => {
                condition.has_context_ops()
                    || then_expr.has_context_ops()
                    || else_expr.has_context_ops()
            }
            Expression::Switch {
                expr,
                cases,
                default,
            } => {
                expr.has_context_ops()
                    || cases
                        .iter()
                        .any(|(v, r)| v.has_context_ops() || r.has_context_ops())
                    || default.as_ref().is_some_and(|d| d.has_context_ops())
            }
            Expression::SafeDivide {
                numerator,
                denominator,
                alternate,
            } => {
                numerator.has_context_ops()
                    || denominator.has_context_ops()
                    || alternate.as_ref().is_some_and(|a| a.has_context_ops())
            }
            Expression::Coalesce(exprs) => exprs.iter().any(|e| e.has_context_ops()),
            Expression::ScalarFunc { args, .. }
            | Expression::TextFunc { args, .. }
            | Expression::DateTimeFunc { args, .. } => args.iter().any(|a| a.has_context_ops()),
            Expression::IfError { expr, alternate } => {
                expr.has_context_ops() || alternate.has_context_ops()
            }
            Expression::IsInScope { .. } => false,
            Expression::ClearExcept { .. } => true,
            Expression::Iterate { expression, .. } => expression.has_context_ops(),
            Expression::Percentile {
                operand,
                percentile,
            } => operand.has_context_ops() || percentile.has_context_ops(),
            Expression::Query { aggregates, .. } => {
                aggregates.iter().any(|(e, _)| e.has_context_ops())
            }
            Expression::HasOneValue { column } => column.has_context_ops(),
            Expression::SelectedValue { column, alternate } => {
                column.has_context_ops() || alternate.as_ref().is_some_and(|a| a.has_context_ops())
            }
            Expression::FirstValue { column, order_by } => {
                column.has_context_ops() || order_by.has_context_ops()
            }
            Expression::Window { inner, .. }
            | Expression::Offset { inner, .. }
            | Expression::Index { inner, .. } => inner.has_context_ops(),
            Expression::InList { expr, values } => {
                expr.has_context_ops() || values.iter().any(|v| v.has_context_ops())
            }
        }
    }

    /// Returns all table names referenced by context operation filters (KEEP, KeepIn).
    ///
    /// This is used by the query planner to determine which tables need to
    /// be fetched for local aggregation when measures contain context ops.
    pub fn context_filter_tables(&self) -> Vec<&str> {
        let mut tables = Vec::new();
        self.collect_context_filter_tables(&mut tables);
        tables
    }

    fn collect_context_filter_tables<'a>(&'a self, tables: &mut Vec<&'a str>) {
        match self {
            Expression::ColumnRef(_)
            | Expression::QualifiedColumnRef { .. }
            | Expression::TableRef(_)
            | Expression::MeasureRef(_)
            | Expression::LiteralFloat(_)
            | Expression::LiteralInt(_)
            | Expression::LiteralString(_)
            | Expression::LiteralBool(_)
            | Expression::Blank => {}
            Expression::BinaryOp { left, right, .. }
            | Expression::Comparison { left, right, .. }
            | Expression::And(left, right)
            | Expression::Or(left, right)
            | Expression::Xor(left, right) => {
                left.collect_context_filter_tables(tables);
                right.collect_context_filter_tables(tables);
            }
            Expression::Not(inner) | Expression::IsBlank(inner) => {
                inner.collect_context_filter_tables(tables);
            }
            Expression::Aggregate { operand, .. } => {
                operand.collect_context_filter_tables(tables);
            }
            Expression::Keep {
                expr,
                filters,
                variables,
                conditions,
                in_predicates,
            } => {
                for f in filters {
                    tables.push(&f.table);
                }
                // Variable tables are resolved at context-resolution time,
                // not tracked here — they add filters dynamically.
                let _ = variables;
                // Expression conditions may reference dimension tables via
                // QualifiedColumnRef — collect those too.
                for cond in conditions {
                    cond.collect_context_filter_tables(tables);
                }
                for p in in_predicates {
                    tables.push(&p.table);
                }
                expr.collect_context_filter_tables(tables);
            }
            Expression::KeepIn { expr, predicates } => {
                for p in predicates {
                    tables.push(&p.table);
                }
                expr.collect_context_filter_tables(tables);
            }
            Expression::Clear { expr, .. }
            | Expression::Reset { expr }
            | Expression::ClearInner { expr, .. }
            | Expression::ClearOuter { expr, .. }
            | Expression::ResetInner { expr }
            | Expression::ResetOuter { expr }
            | Expression::Traverse { expr, .. }
            | Expression::Using { expr, .. }
            | Expression::UseRelationship { expr, .. } => {
                expr.collect_context_filter_tables(tables);
            }
            Expression::Block { bindings, result } => {
                for (_, binding_expr) in bindings {
                    binding_expr.collect_context_filter_tables(tables);
                }
                result.collect_context_filter_tables(tables);
            }
            Expression::If {
                condition,
                then_expr,
                else_expr,
            } => {
                condition.collect_context_filter_tables(tables);
                then_expr.collect_context_filter_tables(tables);
                else_expr.collect_context_filter_tables(tables);
            }
            Expression::Switch {
                expr,
                cases,
                default,
            } => {
                expr.collect_context_filter_tables(tables);
                for (v, r) in cases {
                    v.collect_context_filter_tables(tables);
                    r.collect_context_filter_tables(tables);
                }
                if let Some(d) = default {
                    d.collect_context_filter_tables(tables);
                }
            }
            Expression::SafeDivide {
                numerator,
                denominator,
                alternate,
            } => {
                numerator.collect_context_filter_tables(tables);
                denominator.collect_context_filter_tables(tables);
                if let Some(alt) = alternate {
                    alt.collect_context_filter_tables(tables);
                }
            }
            Expression::Coalesce(exprs) => {
                for e in exprs {
                    e.collect_context_filter_tables(tables);
                }
            }
            Expression::ScalarFunc { args, .. }
            | Expression::TextFunc { args, .. }
            | Expression::DateTimeFunc { args, .. } => {
                for arg in args {
                    arg.collect_context_filter_tables(tables);
                }
            }
            Expression::IfError { expr, alternate } => {
                expr.collect_context_filter_tables(tables);
                alternate.collect_context_filter_tables(tables);
            }
            Expression::IsInScope { .. } => {}
            Expression::ClearExcept { expr, .. } => {
                expr.collect_context_filter_tables(tables);
            }
            Expression::Iterate { expression, .. } => {
                expression.collect_context_filter_tables(tables);
            }
            Expression::Percentile {
                operand,
                percentile,
            } => {
                operand.collect_context_filter_tables(tables);
                percentile.collect_context_filter_tables(tables);
            }
            Expression::Query {
                aggregates,
                group_by,
            } => {
                for (expr, _) in aggregates {
                    expr.collect_context_filter_tables(tables);
                }
                for (table, _) in group_by {
                    tables.push(table);
                }
            }
            Expression::HasOneValue { column } => column.collect_context_filter_tables(tables),
            Expression::SelectedValue { column, alternate } => {
                column.collect_context_filter_tables(tables);
                if let Some(alt) = alternate {
                    alt.collect_context_filter_tables(tables);
                }
            }
            Expression::FirstValue { column, order_by } => {
                column.collect_context_filter_tables(tables);
                order_by.collect_context_filter_tables(tables);
            }
            Expression::Window {
                inner,
                order_by,
                partition_by,
                ..
            }
            | Expression::Offset {
                inner,
                order_by,
                partition_by,
                ..
            }
            | Expression::Index {
                inner,
                order_by,
                partition_by,
                ..
            } => {
                inner.collect_context_filter_tables(tables);
                for (table, _) in order_by {
                    tables.push(table);
                }
                for (table, _) in partition_by {
                    tables.push(table);
                }
            }
            Expression::InList { expr, values } => {
                expr.collect_context_filter_tables(tables);
                for v in values {
                    v.collect_context_filter_tables(tables);
                }
            }
        }
    }

    /// Returns `true` if this expression is a simple `AGG(column)` pattern.
    ///
    /// This is the pattern that can be pushed down to data sources.
    /// Matches both unqualified `ColumnRef` and qualified `QualifiedColumnRef`
    /// (e.g., from `parse_measure("SUM(table[col])")`).
    pub fn is_simple_aggregate(&self) -> bool {
        if let Expression::Aggregate { operation, operand } = self {
            if *operation == AggregateOp::CountRows {
                return true;
            }
            matches!(
                operand.as_ref(),
                Expression::ColumnRef(_) | Expression::QualifiedColumnRef { .. }
            )
        } else {
            false
        }
    }

    /// If this is a simple aggregate, returns `(operation, column_name)`.
    ///
    /// For `CountRows`, returns `("*")` as the column name since it has no column.
    pub fn as_simple_aggregate(&self) -> Option<(AggregateOp, &str)> {
        if let Expression::Aggregate { operation, operand } = self {
            if *operation == AggregateOp::CountRows {
                return Some((AggregateOp::CountRows, "*"));
            }
            match operand.as_ref() {
                Expression::ColumnRef(col) => return Some((*operation, col)),
                Expression::QualifiedColumnRef { column, .. } => return Some((*operation, column)),
                _ => {}
            }
        }
        None
    }

    /// Substitute variable references (`ColumnRef(name)`) with their bound
    /// expressions. Used by `Block` (VAR/RETURN) to inline bindings before
    /// SQL generation.
    pub fn substitute_vars(
        &self,
        env: &std::collections::HashMap<String, Expression>,
    ) -> Expression {
        match self {
            Expression::ColumnRef(name) => {
                if let Some(replacement) = env.get(name) {
                    replacement.clone()
                } else {
                    self.clone()
                }
            }
            Expression::BinaryOp { left, op, right } => Expression::BinaryOp {
                left: Box::new(left.substitute_vars(env)),
                op: *op,
                right: Box::new(right.substitute_vars(env)),
            },
            Expression::Aggregate { operation, operand } => Expression::Aggregate {
                operation: *operation,
                operand: Box::new(operand.substitute_vars(env)),
            },
            Expression::SafeDivide {
                numerator,
                denominator,
                alternate,
            } => Expression::SafeDivide {
                numerator: Box::new(numerator.substitute_vars(env)),
                denominator: Box::new(denominator.substitute_vars(env)),
                alternate: alternate.as_ref().map(|a| Box::new(a.substitute_vars(env))),
            },
            Expression::ScalarFunc { function, args } => Expression::ScalarFunc {
                function: *function,
                args: args.iter().map(|a| a.substitute_vars(env)).collect(),
            },
            Expression::TextFunc { function, args } => Expression::TextFunc {
                function: *function,
                args: args.iter().map(|a| a.substitute_vars(env)).collect(),
            },
            Expression::DateTimeFunc { function, args } => Expression::DateTimeFunc {
                function: *function,
                args: args.iter().map(|a| a.substitute_vars(env)).collect(),
            },
            Expression::IfError { expr, alternate } => Expression::IfError {
                expr: Box::new(expr.substitute_vars(env)),
                alternate: Box::new(alternate.substitute_vars(env)),
            },
            Expression::IsInScope { table, column } => Expression::IsInScope {
                table: table.clone(),
                column: column.clone(),
            },
            Expression::ClearExcept {
                expr,
                table,
                except_columns,
            } => Expression::ClearExcept {
                expr: Box::new(expr.substitute_vars(env)),
                table: table.clone(),
                except_columns: except_columns.clone(),
            },
            Expression::Iterate { table, expression } => Expression::Iterate {
                table: table.clone(),
                expression: Box::new(expression.substitute_vars(env)),
            },
            Expression::Percentile {
                operand,
                percentile,
            } => Expression::Percentile {
                operand: Box::new(operand.substitute_vars(env)),
                percentile: Box::new(percentile.substitute_vars(env)),
            },
            Expression::Coalesce(exprs) => {
                Expression::Coalesce(exprs.iter().map(|e| e.substitute_vars(env)).collect())
            }
            Expression::If {
                condition,
                then_expr,
                else_expr,
            } => Expression::If {
                condition: Box::new(condition.substitute_vars(env)),
                then_expr: Box::new(then_expr.substitute_vars(env)),
                else_expr: Box::new(else_expr.substitute_vars(env)),
            },
            Expression::IsBlank(inner) => Expression::IsBlank(Box::new(inner.substitute_vars(env))),
            Expression::Not(inner) => Expression::Not(Box::new(inner.substitute_vars(env))),
            Expression::Comparison { left, op, right } => Expression::Comparison {
                left: Box::new(left.substitute_vars(env)),
                op: *op,
                right: Box::new(right.substitute_vars(env)),
            },
            Expression::And(left, right) => Expression::And(
                Box::new(left.substitute_vars(env)),
                Box::new(right.substitute_vars(env)),
            ),
            Expression::Or(left, right) => Expression::Or(
                Box::new(left.substitute_vars(env)),
                Box::new(right.substitute_vars(env)),
            ),
            Expression::Xor(left, right) => Expression::Xor(
                Box::new(left.substitute_vars(env)),
                Box::new(right.substitute_vars(env)),
            ),
            Expression::Switch {
                expr,
                cases,
                default,
            } => Expression::Switch {
                expr: Box::new(expr.substitute_vars(env)),
                cases: cases
                    .iter()
                    .map(|(v, r)| (v.substitute_vars(env), r.substitute_vars(env)))
                    .collect(),
                default: default.as_ref().map(|d| Box::new(d.substitute_vars(env))),
            },
            Expression::Block { bindings, result } => {
                // Recursively inline inner blocks too.
                let mut inner_env = env.clone();
                let mut new_bindings = Vec::new();
                for (name, binding_expr) in bindings {
                    let resolved = binding_expr.substitute_vars(&inner_env);
                    inner_env.insert(name.clone(), resolved.clone());
                    new_bindings.push((name.clone(), resolved));
                }
                Expression::Block {
                    bindings: new_bindings,
                    result: Box::new(result.substitute_vars(&inner_env)),
                }
            }
            Expression::Query {
                aggregates,
                group_by,
            } => Expression::Query {
                aggregates: aggregates
                    .iter()
                    .map(|(e, alias)| (e.substitute_vars(env), alias.clone()))
                    .collect(),
                group_by: group_by.clone(),
            },
            Expression::HasOneValue { column } => Expression::HasOneValue {
                column: Box::new(column.substitute_vars(env)),
            },
            Expression::SelectedValue { column, alternate } => Expression::SelectedValue {
                column: Box::new(column.substitute_vars(env)),
                alternate: alternate.as_ref().map(|a| Box::new(a.substitute_vars(env))),
            },
            Expression::FirstValue { column, order_by } => Expression::FirstValue {
                column: Box::new(column.substitute_vars(env)),
                order_by: Box::new(order_by.substitute_vars(env)),
            },
            Expression::Window {
                inner,
                function,
                order_by,
                partition_by,
                frame,
            } => Expression::Window {
                inner: Box::new(inner.substitute_vars(env)),
                function: *function,
                order_by: order_by.clone(),
                partition_by: partition_by.clone(),
                frame: frame.clone(),
            },
            Expression::Offset {
                inner,
                delta,
                order_by,
                partition_by,
            } => Expression::Offset {
                inner: Box::new(inner.substitute_vars(env)),
                delta: *delta,
                order_by: order_by.clone(),
                partition_by: partition_by.clone(),
            },
            Expression::Index {
                inner,
                position,
                order_by,
                partition_by,
            } => Expression::Index {
                inner: Box::new(inner.substitute_vars(env)),
                position: *position,
                order_by: order_by.clone(),
                partition_by: partition_by.clone(),
            },
            // Context operations: recurse into inner expression.
            Expression::Keep {
                expr,
                filters,
                variables,
                conditions,
                in_predicates,
            } => Expression::Keep {
                expr: Box::new(expr.substitute_vars(env)),
                filters: filters.clone(),
                variables: variables.clone(),
                conditions: conditions.iter().map(|c| c.substitute_vars(env)).collect(),
                in_predicates: in_predicates.clone(),
            },
            Expression::Clear { expr, targets } => Expression::Clear {
                expr: Box::new(expr.substitute_vars(env)),
                targets: targets.clone(),
            },
            Expression::Reset { expr } => Expression::Reset {
                expr: Box::new(expr.substitute_vars(env)),
            },
            Expression::ClearInner { expr, targets } => Expression::ClearInner {
                expr: Box::new(expr.substitute_vars(env)),
                targets: targets.clone(),
            },
            Expression::ClearOuter { expr, targets } => Expression::ClearOuter {
                expr: Box::new(expr.substitute_vars(env)),
                targets: targets.clone(),
            },
            Expression::ResetInner { expr } => Expression::ResetInner {
                expr: Box::new(expr.substitute_vars(env)),
            },
            Expression::ResetOuter { expr } => Expression::ResetOuter {
                expr: Box::new(expr.substitute_vars(env)),
            },
            Expression::Traverse { expr, path } => Expression::Traverse {
                expr: Box::new(expr.substitute_vars(env)),
                path: path.clone(),
            },
            Expression::Using { expr, context_name } => Expression::Using {
                expr: Box::new(expr.substitute_vars(env)),
                context_name: context_name.clone(),
            },
            Expression::UseRelationship {
                expr,
                relationship_name,
            } => Expression::UseRelationship {
                expr: Box::new(expr.substitute_vars(env)),
                relationship_name: relationship_name.clone(),
            },
            Expression::KeepIn { expr, predicates } => Expression::KeepIn {
                expr: Box::new(expr.substitute_vars(env)),
                predicates: predicates.clone(),
            },
            Expression::InList { expr, values } => Expression::InList {
                expr: Box::new(expr.substitute_vars(env)),
                values: values.iter().map(|v| v.substitute_vars(env)).collect(),
            },
            // Leaf expressions that don't contain ColumnRef — return as-is.
            _ => self.clone(),
        }
    }

    /// Inline all VAR bindings into the result expression of a Block,
    /// returning the fully expanded expression. Non-Block expressions
    /// are returned unchanged.
    ///
    /// Query bindings are skipped — they produce tables that must be
    /// materialized, not inlined as scalar expressions.
    pub fn inline_bindings(&self) -> Expression {
        match self {
            Expression::Block { bindings, result } => {
                let mut env = std::collections::HashMap::new();
                for (name, binding_expr) in bindings {
                    // Skip Query/Window/Offset/Index bindings — they produce tables, not scalars.
                    if matches!(
                        binding_expr,
                        Expression::Query { .. }
                            | Expression::Window { .. }
                            | Expression::Offset { .. }
                            | Expression::Index { .. }
                    ) {
                        continue;
                    }
                    let resolved = binding_expr.substitute_vars(&env);
                    env.insert(name.clone(), resolved);
                }
                result.substitute_vars(&env)
            }
            _ => self.clone(),
        }
    }

    /// Returns `true` if this is a `Query` expression.
    pub fn is_query(&self) -> bool {
        matches!(self, Expression::Query { .. })
    }

    /// Returns `true` if this is a `Block` with at least one `Query` binding.
    pub fn has_query_bindings(&self) -> bool {
        match self {
            Expression::Block { bindings, .. } => bindings.iter().any(|(_, e)| e.is_query()),
            _ => false,
        }
    }

    /// Returns `true` if this expression is a `Window`, `Offset`, or `Index` expression.
    pub fn is_window(&self) -> bool {
        matches!(
            self,
            Expression::Window { .. } | Expression::Offset { .. } | Expression::Index { .. }
        )
    }

    /// Returns `true` if this expression contains any window function nodes.
    pub fn has_window(&self) -> bool {
        match self {
            Expression::Window { .. } | Expression::Offset { .. } | Expression::Index { .. } => {
                true
            }
            Expression::BinaryOp { left, right, .. }
            | Expression::Comparison { left, right, .. }
            | Expression::And(left, right)
            | Expression::Or(left, right)
            | Expression::Xor(left, right) => left.has_window() || right.has_window(),
            Expression::Not(inner) | Expression::IsBlank(inner) => inner.has_window(),
            Expression::Aggregate { operand, .. } => operand.has_window(),
            Expression::Keep { expr, .. }
            | Expression::Clear { expr, .. }
            | Expression::Reset { expr }
            | Expression::ClearInner { expr, .. }
            | Expression::ClearOuter { expr, .. }
            | Expression::ResetInner { expr }
            | Expression::ResetOuter { expr }
            | Expression::Traverse { expr, .. }
            | Expression::Using { expr, .. }
            | Expression::UseRelationship { expr, .. }
            | Expression::KeepIn { expr, .. } => expr.has_window(),
            Expression::Block { bindings, result } => {
                bindings.iter().any(|(_, e)| e.has_window()) || result.has_window()
            }
            Expression::If {
                condition,
                then_expr,
                else_expr,
            } => condition.has_window() || then_expr.has_window() || else_expr.has_window(),
            Expression::SafeDivide {
                numerator,
                denominator,
                alternate,
            } => {
                numerator.has_window()
                    || denominator.has_window()
                    || alternate.as_ref().is_some_and(|a| a.has_window())
            }
            Expression::Coalesce(exprs) => exprs.iter().any(|e| e.has_window()),
            Expression::ScalarFunc { args, .. }
            | Expression::TextFunc { args, .. }
            | Expression::DateTimeFunc { args, .. } => args.iter().any(|a| a.has_window()),
            Expression::IfError { expr, alternate } => expr.has_window() || alternate.has_window(),
            Expression::ClearExcept { expr, .. }
            | Expression::Iterate {
                expression: expr, ..
            } => expr.has_window(),
            Expression::Percentile {
                operand,
                percentile,
            } => operand.has_window() || percentile.has_window(),
            _ => false,
        }
    }

    /// Render this expression as a SQL string fragment.
    ///
    /// Column names are double-quoted. Aggregate functions are rendered
    /// as `FUNC(operand)`. `DistinctCount` renders as `COUNT(DISTINCT operand)`.
    pub fn to_sql_string(&self) -> String {
        match self {
            Expression::ColumnRef(name) => format!("\"{name}\""),
            Expression::QualifiedColumnRef { column, .. } => format!("\"{column}\""),
            Expression::TableRef(_) => String::new(),
            Expression::MeasureRef(name) => {
                panic!("MeasureRef '{name}' must be expanded before SQL generation")
            }
            Expression::LiteralFloat(v) => format!("{v}"),
            Expression::LiteralInt(v) => format!("{v}"),
            Expression::LiteralBool(b) => {
                if *b {
                    "TRUE".to_string()
                } else {
                    "FALSE".to_string()
                }
            }
            Expression::LiteralString(s) => format!("'{}'", s.replace('\'', "''")),
            Expression::BinaryOp { left, op, right } => {
                let left_sql = left.to_sql_string();
                let right_sql = right.to_sql_string();
                format!("({left_sql} {} {right_sql})", op.as_sql())
            }
            Expression::Aggregate { operation, operand } => match operation {
                AggregateOp::DistinctCount => {
                    let operand_sql = operand.to_sql_string();
                    format!("COUNT(DISTINCT {operand_sql})")
                }
                AggregateOp::CountRows => "COUNT(*)".to_string(),
                _ => {
                    let operand_sql = operand.to_sql_string();
                    format!("{operation}({operand_sql})")
                }
            },
            // Context manipulation nodes render as their inner expression's SQL.
            // Context operations are resolved by the ContextResolver before SQL
            // generation — these just pass through.
            Expression::Keep { expr, .. }
            | Expression::Clear { expr, .. }
            | Expression::Reset { expr }
            | Expression::ClearInner { expr, .. }
            | Expression::ClearOuter { expr, .. }
            | Expression::ResetInner { expr }
            | Expression::ResetOuter { expr }
            | Expression::Traverse { expr, .. }
            | Expression::Using { expr, .. }
            | Expression::UseRelationship { expr, .. }
            | Expression::KeepIn { expr, .. } => expr.to_sql_string(),
            Expression::Block { .. } => self.inline_bindings().to_sql_string(),
            Expression::Blank => "NULL".to_string(),
            Expression::IsBlank(inner) => {
                format!("({} IS NULL)", inner.to_sql_string())
            }
            Expression::Comparison { left, op, right } => {
                format!(
                    "({} {} {})",
                    left.to_sql_string(),
                    op.as_sql(),
                    right.to_sql_string()
                )
            }
            Expression::And(left, right) => {
                format!("({} AND {})", left.to_sql_string(), right.to_sql_string())
            }
            Expression::Or(left, right) => {
                format!("({} OR {})", left.to_sql_string(), right.to_sql_string())
            }
            Expression::Not(inner) => {
                format!("(NOT {})", inner.to_sql_string())
            }
            Expression::Xor(left, right) => {
                let l = left.to_sql_string();
                let r = right.to_sql_string();
                format!("(({l} AND NOT {r}) OR (NOT {l} AND {r}))")
            }
            Expression::If {
                condition,
                then_expr,
                else_expr,
            } => {
                format!(
                    "CASE WHEN {} THEN {} ELSE {} END",
                    condition.to_sql_string(),
                    then_expr.to_sql_string(),
                    else_expr.to_sql_string()
                )
            }
            Expression::Switch {
                expr,
                cases,
                default,
            } => {
                let mut sql = format!("CASE {}", expr.to_sql_string());
                for (val, result) in cases {
                    sql.push_str(&format!(
                        " WHEN {} THEN {}",
                        val.to_sql_string(),
                        result.to_sql_string()
                    ));
                }
                if let Some(d) = default {
                    sql.push_str(&format!(" ELSE {}", d.to_sql_string()));
                }
                sql.push_str(" END");
                sql
            }
            Expression::SafeDivide {
                numerator,
                denominator,
                alternate,
            } => {
                let alt = alternate
                    .as_ref()
                    .map(|a| a.to_sql_string())
                    .unwrap_or_else(|| "NULL".to_string());
                format!(
                    "CASE WHEN {} = 0 THEN {} ELSE (CAST({} AS DOUBLE) / {}) END",
                    denominator.to_sql_string(),
                    alt,
                    numerator.to_sql_string(),
                    denominator.to_sql_string()
                )
            }
            Expression::Coalesce(exprs) => {
                let args: Vec<String> = exprs.iter().map(|e| e.to_sql_string()).collect();
                format!("COALESCE({})", args.join(", "))
            }
            Expression::ScalarFunc { function, args } => function.to_sql(args),
            Expression::TextFunc { function, args } => function.to_sql(args),
            Expression::DateTimeFunc { function, args } => function.to_sql(args),
            Expression::IfError { expr, alternate } => {
                format!(
                    "COALESCE({}, {})",
                    expr.to_sql_string(),
                    alternate.to_sql_string()
                )
            }
            Expression::IsInScope { .. } => {
                // Should be resolved before SQL generation. Default to TRUE.
                "TRUE".to_string()
            }
            Expression::ClearExcept { expr, .. } => expr.to_sql_string(),
            Expression::Iterate { expression, .. } => expression.to_sql_string(),
            Expression::Percentile {
                operand,
                percentile,
            } => {
                format!(
                    "approx_percentile_cont({}, {})",
                    operand.to_sql_string(),
                    percentile.to_sql_string()
                )
            }
            Expression::Query { .. } => {
                // Query expressions produce tables and must be materialized,
                // not rendered inline. This should not be reached in normal flow.
                "/* QUERY: must be materialized */".to_string()
            }
            Expression::HasOneValue { column } => {
                format!("(COUNT(DISTINCT {}) = 1)", column.to_sql_string())
            }
            Expression::SelectedValue { column, alternate } => {
                let col_sql = column.to_sql_string();
                let alt = alternate
                    .as_ref()
                    .map(|a| a.to_sql_string())
                    .unwrap_or_else(|| "NULL".to_string());
                format!(
                    "CASE WHEN COUNT(DISTINCT {col_sql}) = 1 THEN MIN({col_sql}) ELSE {alt} END"
                )
            }
            Expression::FirstValue { column, order_by } => {
                format!(
                    "FIRST_VALUE({} ORDER BY {})",
                    column.to_sql_string(),
                    order_by.to_sql_string()
                )
            }
            Expression::Window { .. } | Expression::Offset { .. } | Expression::Index { .. } => {
                // Window expressions produce tables and must be materialized,
                // not rendered inline. This should not be reached in normal flow.
                "/* WINDOW: must be materialized */".to_string()
            }
            Expression::InList { expr, values } => {
                let expr_sql = expr.to_sql_string();
                let vals: Vec<String> = values.iter().map(|v| v.to_sql_string()).collect();
                format!("{expr_sql} IN ({})", vals.join(", "))
            }
        }
    }

    /// Render this expression as SQL with the aggregate operand wrapped in CASE WHEN.
    ///
    /// Used when a measure has per-measure context filters (KEEP) that must be
    /// scoped to the aggregate rather than applied as a global WHERE clause.
    ///
    /// For `SUM(col)` with condition `dim_date."year" = 2014`, produces:
    /// `SUM(CASE WHEN dim_date."year" = 2014 THEN col END)`.
    ///
    /// The `fact_table` parameter is the lowercase fact table name used to
    /// qualify column references in the operand.
    pub fn to_case_when_sql(&self, condition: &str, fact_table: &str) -> String {
        match self {
            Expression::Aggregate { operation, operand } => {
                let qualified = qualify_operand_sql(operand, fact_table);
                let case_expr = format!("CASE WHEN {condition} THEN {qualified} END");
                match operation {
                    AggregateOp::DistinctCount => {
                        format!("COUNT(DISTINCT {case_expr})")
                    }
                    AggregateOp::Count => {
                        // For COUNT, count non-null CASE results.
                        format!("COUNT({case_expr})")
                    }
                    AggregateOp::CountRows => {
                        // COUNT(*) with condition → SUM(CASE WHEN condition THEN 1 END)
                        format!("SUM(CASE WHEN {condition} THEN 1 END)")
                    }
                    _ => format!("{operation}({case_expr})"),
                }
            }
            // Compound expressions: recurse into sub-expressions so CASE WHEN
            // is applied to each leaf aggregate independently.
            Expression::BinaryOp { left, op, right } => {
                let l = left.to_case_when_sql(condition, fact_table);
                let r = right.to_case_when_sql(condition, fact_table);
                format!("({l} {} {r})", op.as_sql())
            }
            Expression::SafeDivide {
                numerator,
                denominator,
                alternate,
            } => {
                let n = numerator.to_case_when_sql(condition, fact_table);
                let d = denominator.to_case_when_sql(condition, fact_table);
                let alt = alternate
                    .as_ref()
                    .map(|a| a.to_case_when_sql(condition, fact_table))
                    .unwrap_or_else(|| "NULL".to_string());
                format!("CASE WHEN {d} = 0 THEN {alt} ELSE CAST({n} AS DOUBLE) / {d} END")
            }
            Expression::ScalarFunc { function, args } => {
                let mapped: Vec<String> = args
                    .iter()
                    .map(|a| a.to_case_when_sql(condition, fact_table))
                    .collect();
                function.to_sql_strs(&mapped)
            }
            Expression::TextFunc { function, args } => {
                let mapped: Vec<String> = args
                    .iter()
                    .map(|a| a.to_case_when_sql(condition, fact_table))
                    .collect();
                function.to_sql_strs(&mapped)
            }
            Expression::DateTimeFunc { function, args } => {
                let mapped: Vec<String> = args
                    .iter()
                    .map(|a| a.to_case_when_sql(condition, fact_table))
                    .collect();
                function.to_sql_strs(&mapped)
            }
            Expression::IfError { expr, alternate } => {
                let e = expr.to_case_when_sql(condition, fact_table);
                let a = alternate.to_case_when_sql(condition, fact_table);
                format!("COALESCE({e}, {a})")
            }
            Expression::ClearExcept { expr, .. } => expr.to_case_when_sql(condition, fact_table),
            Expression::Iterate { expression, .. } => {
                expression.to_case_when_sql(condition, fact_table)
            }
            Expression::Percentile {
                operand,
                percentile,
            } => {
                let qualified = qualify_operand_sql(operand, fact_table);
                let case_expr = format!("CASE WHEN {condition} THEN {qualified} END");
                let p = percentile.to_sql_string();
                format!("approx_percentile_cont({case_expr}, {p})")
            }
            Expression::Coalesce(exprs) => {
                let mapped: Vec<String> = exprs
                    .iter()
                    .map(|e| e.to_case_when_sql(condition, fact_table))
                    .collect();
                format!("COALESCE({})", mapped.join(", "))
            }
            Expression::If {
                condition: cond_expr,
                then_expr,
                else_expr,
            } => {
                let c = cond_expr.to_case_when_sql(condition, fact_table);
                let t = then_expr.to_case_when_sql(condition, fact_table);
                let e = else_expr.to_case_when_sql(condition, fact_table);
                format!("CASE WHEN {c} THEN {t} ELSE {e} END")
            }
            Expression::IsBlank(inner) => {
                let i = inner.to_case_when_sql(condition, fact_table);
                format!("({i} IS NULL)")
            }
            Expression::Not(inner) => {
                let i = inner.to_case_when_sql(condition, fact_table);
                format!("(NOT {i})")
            }
            Expression::Xor(left, right) => {
                let l = left.to_case_when_sql(condition, fact_table);
                let r = right.to_case_when_sql(condition, fact_table);
                format!("(({l} AND NOT {r}) OR (NOT {l} AND {r}))")
            }
            Expression::Block { .. } => self
                .inline_bindings()
                .to_case_when_sql(condition, fact_table),
            Expression::HasOneValue { column } => {
                let col_sql = column.to_sql_string();
                let qualified = if !col_sql.contains('.') {
                    format!("{fact_table}.{col_sql}")
                } else {
                    col_sql
                };
                let case_expr = format!("CASE WHEN {condition} THEN {qualified} END");
                format!("(COUNT(DISTINCT {case_expr}) = 1)")
            }
            Expression::SelectedValue { column, alternate } => {
                let col_sql = column.to_sql_string();
                let qualified = if !col_sql.contains('.') {
                    format!("{fact_table}.{col_sql}")
                } else {
                    col_sql
                };
                let case_expr = format!("CASE WHEN {condition} THEN {qualified} END");
                let alt = alternate
                    .as_ref()
                    .map(|a| a.to_case_when_sql(condition, fact_table))
                    .unwrap_or_else(|| "NULL".to_string());
                format!(
                    "CASE WHEN COUNT(DISTINCT {case_expr}) = 1 THEN MIN({case_expr}) ELSE {alt} END"
                )
            }
            Expression::FirstValue { column, order_by } => {
                let col_sql = column.to_sql_string();
                let qualified_col = if !col_sql.contains('.') {
                    format!("{fact_table}.{col_sql}")
                } else {
                    col_sql
                };
                let order_sql = order_by.to_sql_string();
                let qualified_order = if !order_sql.contains('.') {
                    format!("{fact_table}.{order_sql}")
                } else {
                    order_sql
                };
                let case_col = format!("CASE WHEN {condition} THEN {qualified_col} END");
                let case_order = format!("CASE WHEN {condition} THEN {qualified_order} END");
                format!("FIRST_VALUE({case_col} ORDER BY {case_order})")
            }
            Expression::Window { .. } | Expression::Offset { .. } | Expression::Index { .. } => {
                "/* WINDOW: must be materialized */".to_string()
            }
            Expression::InList { .. } => self.to_sql_string(),
            // For leaf expressions (literals, column refs, etc.), fall back to regular SQL.
            _ => self.to_sql_string(),
        }
    }

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

// --- Builder helpers ---

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

/// Resolve `IsInScope` nodes by replacing them with `LiteralBool` based on
/// whether the referenced column is in the provided group-by list.
pub fn resolve_is_in_scope(expr: &Expression, group_by: &[(String, String)]) -> Expression {
    match expr {
        Expression::IsInScope { table, column } => {
            let in_scope = group_by.iter().any(|(t, c)| t == table && c == column);
            Expression::LiteralBool(in_scope)
        }
        Expression::BinaryOp { left, op, right } => Expression::BinaryOp {
            left: Box::new(resolve_is_in_scope(left, group_by)),
            op: *op,
            right: Box::new(resolve_is_in_scope(right, group_by)),
        },
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => Expression::If {
            condition: Box::new(resolve_is_in_scope(condition, group_by)),
            then_expr: Box::new(resolve_is_in_scope(then_expr, group_by)),
            else_expr: Box::new(resolve_is_in_scope(else_expr, group_by)),
        },
        Expression::Switch {
            expr: e,
            cases,
            default,
        } => Expression::Switch {
            expr: Box::new(resolve_is_in_scope(e, group_by)),
            cases: cases
                .iter()
                .map(|(v, r)| {
                    (
                        resolve_is_in_scope(v, group_by),
                        resolve_is_in_scope(r, group_by),
                    )
                })
                .collect(),
            default: default
                .as_ref()
                .map(|d| Box::new(resolve_is_in_scope(d, group_by))),
        },
        Expression::And(l, r) => Expression::And(
            Box::new(resolve_is_in_scope(l, group_by)),
            Box::new(resolve_is_in_scope(r, group_by)),
        ),
        Expression::Or(l, r) => Expression::Or(
            Box::new(resolve_is_in_scope(l, group_by)),
            Box::new(resolve_is_in_scope(r, group_by)),
        ),
        Expression::Not(inner) => Expression::Not(Box::new(resolve_is_in_scope(inner, group_by))),
        // All other nodes: return as-is (IsInScope is typically only in conditions)
        _ => expr.clone(),
    }
}

/// Expand global variable references in an expression.
///
/// This function performs two kinds of substitution:
///
/// - **Scalar globals**: A `ColumnRef(name)` matching a scalar global variable
///   is replaced with the global's expression inline.
/// - **Table (QUERY) globals**: A `QualifiedColumnRef { table_or_var, .. }` matching
///   a QUERY global variable causes the entire expression to be wrapped in a
///   `Block` with the QUERY expression as a binding. Multiple distinct QUERY globals
///   each get their own binding.
///
/// The function is idempotent: if no global references are found, the expression
/// is returned unchanged (cloned).
/// Returns `true` if the expression tree contains any `MeasureRef` nodes.
pub fn has_measure_ref(expr: &Expression) -> bool {
    match expr {
        Expression::MeasureRef(_) => true,
        Expression::BinaryOp { left, right, .. }
        | Expression::Comparison { left, right, .. }
        | Expression::And(left, right)
        | Expression::Or(left, right)
        | Expression::Xor(left, right) => has_measure_ref(left) || has_measure_ref(right),
        Expression::Not(inner) | Expression::IsBlank(inner) => has_measure_ref(inner),
        Expression::Aggregate { operand, .. } => has_measure_ref(operand),
        Expression::Keep { expr, .. }
        | Expression::Clear { expr, .. }
        | Expression::Reset { expr }
        | Expression::ClearInner { expr, .. }
        | Expression::ClearOuter { expr, .. }
        | Expression::ResetInner { expr }
        | Expression::ResetOuter { expr }
        | Expression::Traverse { expr, .. }
        | Expression::Using { expr, .. }
        | Expression::UseRelationship { expr, .. }
        | Expression::KeepIn { expr, .. } => has_measure_ref(expr),
        Expression::Block { bindings, result } => {
            bindings.iter().any(|(_, e)| has_measure_ref(e)) || has_measure_ref(result)
        }
        Expression::Window { inner, .. }
        | Expression::Offset { inner, .. }
        | Expression::Index { inner, .. } => has_measure_ref(inner),
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => {
            has_measure_ref(numerator)
                || has_measure_ref(denominator)
                || alternate.as_ref().is_some_and(|a| has_measure_ref(a))
        }
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => has_measure_ref(condition) || has_measure_ref(then_expr) || has_measure_ref(else_expr),
        Expression::Switch {
            expr,
            cases,
            default,
        } => {
            has_measure_ref(expr)
                || cases
                    .iter()
                    .any(|(v, r)| has_measure_ref(v) || has_measure_ref(r))
                || default.as_ref().is_some_and(|d| has_measure_ref(d))
        }
        Expression::Coalesce(exprs) => exprs.iter().any(has_measure_ref),
        Expression::ScalarFunc { args, .. }
        | Expression::TextFunc { args, .. }
        | Expression::DateTimeFunc { args, .. } => args.iter().any(has_measure_ref),
        Expression::IfError { expr, alternate } => {
            has_measure_ref(expr) || has_measure_ref(alternate)
        }
        Expression::ClearExcept { expr, .. }
        | Expression::Iterate {
            expression: expr, ..
        } => has_measure_ref(expr),
        Expression::Percentile {
            operand,
            percentile,
        } => has_measure_ref(operand) || has_measure_ref(percentile),
        Expression::InList { expr, values } => {
            has_measure_ref(expr) || values.iter().any(has_measure_ref)
        }
        Expression::Query { aggregates, .. } => aggregates.iter().any(|(e, _)| has_measure_ref(e)),
        Expression::HasOneValue { column } | Expression::FirstValue { column, .. } => {
            has_measure_ref(column)
        }
        Expression::SelectedValue { column, alternate } => {
            has_measure_ref(column) || alternate.as_ref().is_some_and(|a| has_measure_ref(a))
        }
        _ => false,
    }
}

/// Expand all `MeasureRef` nodes by inlining the referenced measure's expression.
///
/// Detects circular references (A -> B -> A) and returns an error with the
/// full chain in the message. Should be called BEFORE `expand_global_variables`.
pub fn expand_measure_refs(
    expr: &Expression,
    model: &crate::model::schema::DataModel,
) -> crate::error::EngineResult<Expression> {
    let mut visited = Vec::new();
    expand_measure_refs_inner(expr, model, &mut visited)
}

fn expand_measure_refs_inner(
    expr: &Expression,
    model: &crate::model::schema::DataModel,
    visited: &mut Vec<String>,
) -> crate::error::EngineResult<Expression> {
    match expr {
        Expression::MeasureRef(name) => {
            if visited.contains(name) {
                visited.push(name.clone());
                let chain = visited.join(" -> ");
                return Err(crate::error::EngineError::InvalidData(format!(
                    "circular measure reference: {chain}"
                )));
            }
            visited.push(name.clone());
            let measure = model.measure(name)?;
            let expanded = expand_measure_refs_inner(measure.expression(), model, visited)?;
            visited.pop();
            Ok(expanded)
        }
        // Context wrappers: recurse into inner expr.
        Expression::Keep {
            expr: inner,
            filters,
            variables,
            conditions,
            in_predicates,
        } => Ok(Expression::Keep {
            expr: Box::new(expand_measure_refs_inner(inner, model, visited)?),
            filters: filters.clone(),
            variables: variables.clone(),
            conditions: conditions
                .iter()
                .map(|c| expand_measure_refs_inner(c, model, visited))
                .collect::<crate::error::EngineResult<Vec<_>>>()?,
            in_predicates: in_predicates.clone(),
        }),
        Expression::Clear {
            expr: inner,
            targets,
        } => Ok(Expression::Clear {
            expr: Box::new(expand_measure_refs_inner(inner, model, visited)?),
            targets: targets.clone(),
        }),
        Expression::Reset { expr: inner } => Ok(Expression::Reset {
            expr: Box::new(expand_measure_refs_inner(inner, model, visited)?),
        }),
        Expression::Traverse { expr: inner, path } => Ok(Expression::Traverse {
            expr: Box::new(expand_measure_refs_inner(inner, model, visited)?),
            path: path.clone(),
        }),
        Expression::Using {
            expr: inner,
            context_name,
        } => Ok(Expression::Using {
            expr: Box::new(expand_measure_refs_inner(inner, model, visited)?),
            context_name: context_name.clone(),
        }),
        Expression::UseRelationship {
            expr: inner,
            relationship_name,
        } => Ok(Expression::UseRelationship {
            expr: Box::new(expand_measure_refs_inner(inner, model, visited)?),
            relationship_name: relationship_name.clone(),
        }),
        Expression::ClearInner {
            expr: inner,
            targets,
        } => Ok(Expression::ClearInner {
            expr: Box::new(expand_measure_refs_inner(inner, model, visited)?),
            targets: targets.clone(),
        }),
        Expression::ClearOuter {
            expr: inner,
            targets,
        } => Ok(Expression::ClearOuter {
            expr: Box::new(expand_measure_refs_inner(inner, model, visited)?),
            targets: targets.clone(),
        }),
        Expression::ResetInner { expr: inner } => Ok(Expression::ResetInner {
            expr: Box::new(expand_measure_refs_inner(inner, model, visited)?),
        }),
        Expression::ResetOuter { expr: inner } => Ok(Expression::ResetOuter {
            expr: Box::new(expand_measure_refs_inner(inner, model, visited)?),
        }),
        Expression::KeepIn {
            expr: inner,
            predicates,
        } => Ok(Expression::KeepIn {
            expr: Box::new(expand_measure_refs_inner(inner, model, visited)?),
            predicates: predicates.clone(),
        }),
        // Compound expressions: recurse into children.
        Expression::BinaryOp { left, op, right } => Ok(Expression::BinaryOp {
            left: Box::new(expand_measure_refs_inner(left, model, visited)?),
            op: *op,
            right: Box::new(expand_measure_refs_inner(right, model, visited)?),
        }),
        Expression::Aggregate { operation, operand } => Ok(Expression::Aggregate {
            operation: *operation,
            operand: Box::new(expand_measure_refs_inner(operand, model, visited)?),
        }),
        Expression::Block { bindings, result } => {
            let expanded_bindings = bindings
                .iter()
                .map(|(name, e)| Ok((name.clone(), expand_measure_refs_inner(e, model, visited)?)))
                .collect::<crate::error::EngineResult<Vec<_>>>()?;
            Ok(Expression::Block {
                bindings: expanded_bindings,
                result: Box::new(expand_measure_refs_inner(result, model, visited)?),
            })
        }
        Expression::Window {
            inner,
            function,
            order_by,
            partition_by,
            frame,
        } => Ok(Expression::Window {
            inner: Box::new(expand_measure_refs_inner(inner, model, visited)?),
            function: *function,
            order_by: order_by.clone(),
            partition_by: partition_by.clone(),
            frame: frame.clone(),
        }),
        Expression::Offset {
            inner,
            delta,
            order_by,
            partition_by,
        } => Ok(Expression::Offset {
            inner: Box::new(expand_measure_refs_inner(inner, model, visited)?),
            delta: *delta,
            order_by: order_by.clone(),
            partition_by: partition_by.clone(),
        }),
        Expression::Index {
            inner,
            position,
            order_by,
            partition_by,
        } => Ok(Expression::Index {
            inner: Box::new(expand_measure_refs_inner(inner, model, visited)?),
            position: *position,
            order_by: order_by.clone(),
            partition_by: partition_by.clone(),
        }),
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => Ok(Expression::SafeDivide {
            numerator: Box::new(expand_measure_refs_inner(numerator, model, visited)?),
            denominator: Box::new(expand_measure_refs_inner(denominator, model, visited)?),
            alternate: alternate
                .as_ref()
                .map(|a| expand_measure_refs_inner(a, model, visited))
                .transpose()?
                .map(Box::new),
        }),
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => Ok(Expression::If {
            condition: Box::new(expand_measure_refs_inner(condition, model, visited)?),
            then_expr: Box::new(expand_measure_refs_inner(then_expr, model, visited)?),
            else_expr: Box::new(expand_measure_refs_inner(else_expr, model, visited)?),
        }),
        Expression::Switch {
            expr: switch_expr,
            cases,
            default,
        } => {
            let expanded_cases = cases
                .iter()
                .map(|(v, r)| {
                    Ok((
                        expand_measure_refs_inner(v, model, visited)?,
                        expand_measure_refs_inner(r, model, visited)?,
                    ))
                })
                .collect::<crate::error::EngineResult<Vec<_>>>()?;
            Ok(Expression::Switch {
                expr: Box::new(expand_measure_refs_inner(switch_expr, model, visited)?),
                cases: expanded_cases,
                default: default
                    .as_ref()
                    .map(|d| expand_measure_refs_inner(d, model, visited))
                    .transpose()?
                    .map(Box::new),
            })
        }
        Expression::Coalesce(exprs) => Ok(Expression::Coalesce(
            exprs
                .iter()
                .map(|e| expand_measure_refs_inner(e, model, visited))
                .collect::<crate::error::EngineResult<Vec<_>>>()?,
        )),
        Expression::ScalarFunc { function, args } => Ok(Expression::ScalarFunc {
            function: *function,
            args: args
                .iter()
                .map(|a| expand_measure_refs_inner(a, model, visited))
                .collect::<crate::error::EngineResult<Vec<_>>>()?,
        }),
        Expression::TextFunc { function, args } => Ok(Expression::TextFunc {
            function: *function,
            args: args
                .iter()
                .map(|a| expand_measure_refs_inner(a, model, visited))
                .collect::<crate::error::EngineResult<Vec<_>>>()?,
        }),
        Expression::DateTimeFunc { function, args } => Ok(Expression::DateTimeFunc {
            function: *function,
            args: args
                .iter()
                .map(|a| expand_measure_refs_inner(a, model, visited))
                .collect::<crate::error::EngineResult<Vec<_>>>()?,
        }),
        Expression::IfError { expr, alternate } => Ok(Expression::IfError {
            expr: Box::new(expand_measure_refs_inner(expr, model, visited)?),
            alternate: Box::new(expand_measure_refs_inner(alternate, model, visited)?),
        }),
        Expression::ClearExcept {
            expr,
            table,
            except_columns,
        } => Ok(Expression::ClearExcept {
            expr: Box::new(expand_measure_refs_inner(expr, model, visited)?),
            table: table.clone(),
            except_columns: except_columns.clone(),
        }),
        Expression::Iterate { table, expression } => Ok(Expression::Iterate {
            table: table.clone(),
            expression: Box::new(expand_measure_refs_inner(expression, model, visited)?),
        }),
        Expression::Percentile {
            operand,
            percentile,
        } => Ok(Expression::Percentile {
            operand: Box::new(expand_measure_refs_inner(operand, model, visited)?),
            percentile: Box::new(expand_measure_refs_inner(percentile, model, visited)?),
        }),
        Expression::Comparison { left, op, right } => Ok(Expression::Comparison {
            left: Box::new(expand_measure_refs_inner(left, model, visited)?),
            op: *op,
            right: Box::new(expand_measure_refs_inner(right, model, visited)?),
        }),
        Expression::And(left, right) => Ok(Expression::And(
            Box::new(expand_measure_refs_inner(left, model, visited)?),
            Box::new(expand_measure_refs_inner(right, model, visited)?),
        )),
        Expression::Or(left, right) => Ok(Expression::Or(
            Box::new(expand_measure_refs_inner(left, model, visited)?),
            Box::new(expand_measure_refs_inner(right, model, visited)?),
        )),
        Expression::Xor(left, right) => Ok(Expression::Xor(
            Box::new(expand_measure_refs_inner(left, model, visited)?),
            Box::new(expand_measure_refs_inner(right, model, visited)?),
        )),
        Expression::Not(inner) => Ok(Expression::Not(Box::new(expand_measure_refs_inner(
            inner, model, visited,
        )?))),
        Expression::IsBlank(inner) => Ok(Expression::IsBlank(Box::new(expand_measure_refs_inner(
            inner, model, visited,
        )?))),
        Expression::InList {
            expr: inner,
            values,
        } => Ok(Expression::InList {
            expr: Box::new(expand_measure_refs_inner(inner, model, visited)?),
            values: values
                .iter()
                .map(|v| expand_measure_refs_inner(v, model, visited))
                .collect::<crate::error::EngineResult<Vec<_>>>()?,
        }),
        // Leaf nodes and anything without MeasureRef pass through unchanged.
        _ => Ok(expr.clone()),
    }
}

pub fn expand_global_variables(
    expr: &Expression,
    model: &crate::model::schema::DataModel,
) -> Expression {
    // First pass: collect all QUERY global names referenced via QualifiedColumnRef.
    let mut query_globals = std::collections::HashSet::new();
    collect_query_global_refs(expr, model, &mut query_globals);

    // Expand scalar globals recursively.
    let expanded = expand_scalar_globals(expr, model);

    // If any QUERY globals were referenced, wrap in a Block with those bindings.
    if query_globals.is_empty() {
        expanded
    } else {
        // If the expression is already a Block, merge QUERY bindings into it.
        match expanded {
            Expression::Block { bindings, result } => {
                let mut all_bindings = Vec::new();
                for name in &query_globals {
                    // Only add if not already bound in the existing block.
                    if !bindings.iter().any(|(n, _)| n == name) {
                        let gv = model
                            .global_variable(name)
                            .expect("global variable must exist — was found in collect pass");
                        all_bindings.push((name.clone(), gv.expression().clone()));
                    }
                }
                all_bindings.extend(bindings);
                Expression::Block {
                    bindings: all_bindings,
                    result,
                }
            }
            other => {
                let bindings: Vec<(String, Expression)> = query_globals
                    .iter()
                    .map(|name| {
                        let gv = model
                            .global_variable(name)
                            .expect("global variable must exist — was found in collect pass");
                        (name.clone(), gv.expression().clone())
                    })
                    .collect();
                Expression::Block {
                    bindings,
                    result: Box::new(other),
                }
            }
        }
    }
}

/// Recursively collect names of QUERY global variables referenced via QualifiedColumnRef.
fn collect_query_global_refs(
    expr: &Expression,
    model: &crate::model::schema::DataModel,
    found: &mut std::collections::HashSet<String>,
) {
    match expr {
        Expression::QualifiedColumnRef { table_or_var, .. } => {
            if let Ok(gv) = model.global_variable(table_or_var) {
                if gv.is_query() {
                    found.insert(table_or_var.clone());
                }
            }
        }
        Expression::ColumnRef(_)
        | Expression::LiteralFloat(_)
        | Expression::LiteralInt(_)
        | Expression::LiteralString(_)
        | Expression::LiteralBool(_)
        | Expression::Blank
        | Expression::TableRef(_)
        | Expression::MeasureRef(_) => {}
        Expression::BinaryOp { left, right, .. }
        | Expression::Comparison { left, right, .. }
        | Expression::And(left, right)
        | Expression::Or(left, right)
        | Expression::Xor(left, right) => {
            collect_query_global_refs(left, model, found);
            collect_query_global_refs(right, model, found);
        }
        Expression::Aggregate { operand, .. } => {
            collect_query_global_refs(operand, model, found);
        }
        Expression::Not(inner)
        | Expression::IsBlank(inner)
        | Expression::HasOneValue { column: inner }
        | Expression::Reset { expr: inner }
        | Expression::ResetInner { expr: inner }
        | Expression::ResetOuter { expr: inner } => {
            collect_query_global_refs(inner, model, found);
        }
        Expression::Keep { expr, .. }
        | Expression::Clear { expr, .. }
        | Expression::Traverse { expr, .. }
        | Expression::Using { expr, .. }
        | Expression::UseRelationship { expr, .. }
        | Expression::ClearInner { expr, .. }
        | Expression::ClearOuter { expr, .. }
        | Expression::KeepIn { expr, .. } => {
            collect_query_global_refs(expr, model, found);
        }
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => {
            collect_query_global_refs(condition, model, found);
            collect_query_global_refs(then_expr, model, found);
            collect_query_global_refs(else_expr, model, found);
        }
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => {
            collect_query_global_refs(numerator, model, found);
            collect_query_global_refs(denominator, model, found);
            if let Some(alt) = alternate {
                collect_query_global_refs(alt, model, found);
            }
        }
        Expression::Switch {
            expr,
            cases,
            default,
        } => {
            collect_query_global_refs(expr, model, found);
            for (val, result) in cases {
                collect_query_global_refs(val, model, found);
                collect_query_global_refs(result, model, found);
            }
            if let Some(def) = default {
                collect_query_global_refs(def, model, found);
            }
        }
        Expression::Coalesce(exprs) => {
            for e in exprs {
                collect_query_global_refs(e, model, found);
            }
        }
        Expression::ScalarFunc { args, .. }
        | Expression::TextFunc { args, .. }
        | Expression::DateTimeFunc { args, .. } => {
            for arg in args {
                collect_query_global_refs(arg, model, found);
            }
        }
        Expression::IfError { expr, alternate } => {
            collect_query_global_refs(expr, model, found);
            collect_query_global_refs(alternate, model, found);
        }
        Expression::IsInScope { .. } => {}
        Expression::ClearExcept { expr, .. }
        | Expression::Iterate {
            expression: expr, ..
        } => {
            collect_query_global_refs(expr, model, found);
        }
        Expression::Percentile {
            operand,
            percentile,
        } => {
            collect_query_global_refs(operand, model, found);
            collect_query_global_refs(percentile, model, found);
        }
        Expression::Block { bindings, result } => {
            for (_, binding_expr) in bindings {
                collect_query_global_refs(binding_expr, model, found);
            }
            collect_query_global_refs(result, model, found);
        }
        Expression::Query { aggregates, .. } => {
            for (agg_expr, _) in aggregates {
                collect_query_global_refs(agg_expr, model, found);
            }
        }
        Expression::SelectedValue { column, alternate } => {
            collect_query_global_refs(column, model, found);
            if let Some(alt) = alternate {
                collect_query_global_refs(alt, model, found);
            }
        }
        Expression::FirstValue { column, order_by } => {
            collect_query_global_refs(column, model, found);
            collect_query_global_refs(order_by, model, found);
        }
        Expression::Window { inner, .. }
        | Expression::Offset { inner, .. }
        | Expression::Index { inner, .. } => {
            collect_query_global_refs(inner, model, found);
        }
        Expression::InList { expr, values } => {
            collect_query_global_refs(expr, model, found);
            for v in values {
                collect_query_global_refs(v, model, found);
            }
        }
    }
}

/// Recursively replace scalar global ColumnRef(name) with the global's expression.
fn expand_scalar_globals(expr: &Expression, model: &crate::model::schema::DataModel) -> Expression {
    match expr {
        Expression::ColumnRef(name) => {
            if let Ok(gv) = model.global_variable(name) {
                if !gv.is_query() {
                    return gv.expression().clone();
                }
            }
            expr.clone()
        }
        Expression::BinaryOp { left, op, right } => Expression::BinaryOp {
            left: Box::new(expand_scalar_globals(left, model)),
            op: *op,
            right: Box::new(expand_scalar_globals(right, model)),
        },
        Expression::Aggregate { operation, operand } => Expression::Aggregate {
            operation: *operation,
            operand: Box::new(expand_scalar_globals(operand, model)),
        },
        Expression::Keep {
            expr: inner,
            filters,
            variables,
            conditions,
            in_predicates,
        } => Expression::Keep {
            expr: Box::new(expand_scalar_globals(inner, model)),
            filters: filters.clone(),
            variables: variables.clone(),
            conditions: conditions
                .iter()
                .map(|c| expand_scalar_globals(c, model))
                .collect(),
            in_predicates: in_predicates.clone(),
        },
        Expression::Clear {
            expr: inner,
            targets,
        } => Expression::Clear {
            expr: Box::new(expand_scalar_globals(inner, model)),
            targets: targets.clone(),
        },
        Expression::Reset { expr: inner } => Expression::Reset {
            expr: Box::new(expand_scalar_globals(inner, model)),
        },
        Expression::Traverse { expr: inner, path } => Expression::Traverse {
            expr: Box::new(expand_scalar_globals(inner, model)),
            path: path.clone(),
        },
        Expression::Using {
            expr: inner,
            context_name,
        } => Expression::Using {
            expr: Box::new(expand_scalar_globals(inner, model)),
            context_name: context_name.clone(),
        },
        Expression::UseRelationship {
            expr: inner,
            relationship_name,
        } => Expression::UseRelationship {
            expr: Box::new(expand_scalar_globals(inner, model)),
            relationship_name: relationship_name.clone(),
        },
        Expression::ClearInner {
            expr: inner,
            targets,
        } => Expression::ClearInner {
            expr: Box::new(expand_scalar_globals(inner, model)),
            targets: targets.clone(),
        },
        Expression::ClearOuter {
            expr: inner,
            targets,
        } => Expression::ClearOuter {
            expr: Box::new(expand_scalar_globals(inner, model)),
            targets: targets.clone(),
        },
        Expression::ResetInner { expr: inner } => Expression::ResetInner {
            expr: Box::new(expand_scalar_globals(inner, model)),
        },
        Expression::ResetOuter { expr: inner } => Expression::ResetOuter {
            expr: Box::new(expand_scalar_globals(inner, model)),
        },
        Expression::KeepIn {
            expr: inner,
            predicates,
        } => Expression::KeepIn {
            expr: Box::new(expand_scalar_globals(inner, model)),
            predicates: predicates.clone(),
        },
        Expression::Block { bindings, result } => {
            let expanded_bindings = bindings
                .iter()
                .map(|(name, binding_expr)| {
                    (name.clone(), expand_scalar_globals(binding_expr, model))
                })
                .collect();
            Expression::Block {
                bindings: expanded_bindings,
                result: Box::new(expand_scalar_globals(result, model)),
            }
        }
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => Expression::If {
            condition: Box::new(expand_scalar_globals(condition, model)),
            then_expr: Box::new(expand_scalar_globals(then_expr, model)),
            else_expr: Box::new(expand_scalar_globals(else_expr, model)),
        },
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => Expression::SafeDivide {
            numerator: Box::new(expand_scalar_globals(numerator, model)),
            denominator: Box::new(expand_scalar_globals(denominator, model)),
            alternate: alternate
                .as_ref()
                .map(|a| Box::new(expand_scalar_globals(a, model))),
        },
        Expression::Comparison { left, op, right } => Expression::Comparison {
            left: Box::new(expand_scalar_globals(left, model)),
            op: *op,
            right: Box::new(expand_scalar_globals(right, model)),
        },
        Expression::And(left, right) => Expression::And(
            Box::new(expand_scalar_globals(left, model)),
            Box::new(expand_scalar_globals(right, model)),
        ),
        Expression::Or(left, right) => Expression::Or(
            Box::new(expand_scalar_globals(left, model)),
            Box::new(expand_scalar_globals(right, model)),
        ),
        Expression::Not(inner) => Expression::Not(Box::new(expand_scalar_globals(inner, model))),
        Expression::Xor(left, right) => Expression::Xor(
            Box::new(expand_scalar_globals(left, model)),
            Box::new(expand_scalar_globals(right, model)),
        ),
        Expression::IsBlank(inner) => {
            Expression::IsBlank(Box::new(expand_scalar_globals(inner, model)))
        }
        Expression::Switch {
            expr: inner,
            cases,
            default,
        } => Expression::Switch {
            expr: Box::new(expand_scalar_globals(inner, model)),
            cases: cases
                .iter()
                .map(|(v, r)| {
                    (
                        expand_scalar_globals(v, model),
                        expand_scalar_globals(r, model),
                    )
                })
                .collect(),
            default: default
                .as_ref()
                .map(|d| Box::new(expand_scalar_globals(d, model))),
        },
        Expression::Coalesce(exprs) => Expression::Coalesce(
            exprs
                .iter()
                .map(|e| expand_scalar_globals(e, model))
                .collect(),
        ),
        Expression::ScalarFunc { function, args } => Expression::ScalarFunc {
            function: *function,
            args: args
                .iter()
                .map(|a| expand_scalar_globals(a, model))
                .collect(),
        },
        Expression::TextFunc { function, args } => Expression::TextFunc {
            function: *function,
            args: args
                .iter()
                .map(|a| expand_scalar_globals(a, model))
                .collect(),
        },
        Expression::DateTimeFunc { function, args } => Expression::DateTimeFunc {
            function: *function,
            args: args
                .iter()
                .map(|a| expand_scalar_globals(a, model))
                .collect(),
        },
        Expression::IfError { expr, alternate } => Expression::IfError {
            expr: Box::new(expand_scalar_globals(expr, model)),
            alternate: Box::new(expand_scalar_globals(alternate, model)),
        },
        Expression::IsInScope { table, column } => Expression::IsInScope {
            table: table.clone(),
            column: column.clone(),
        },
        Expression::ClearExcept {
            expr,
            table,
            except_columns,
        } => Expression::ClearExcept {
            expr: Box::new(expand_scalar_globals(expr, model)),
            table: table.clone(),
            except_columns: except_columns.clone(),
        },
        Expression::Iterate { table, expression } => Expression::Iterate {
            table: table.clone(),
            expression: Box::new(expand_scalar_globals(expression, model)),
        },
        Expression::Percentile {
            operand,
            percentile,
        } => Expression::Percentile {
            operand: Box::new(expand_scalar_globals(operand, model)),
            percentile: Box::new(expand_scalar_globals(percentile, model)),
        },
        Expression::HasOneValue { column } => Expression::HasOneValue {
            column: Box::new(expand_scalar_globals(column, model)),
        },
        Expression::SelectedValue { column, alternate } => Expression::SelectedValue {
            column: Box::new(expand_scalar_globals(column, model)),
            alternate: alternate
                .as_ref()
                .map(|a| Box::new(expand_scalar_globals(a, model))),
        },
        Expression::FirstValue { column, order_by } => Expression::FirstValue {
            column: Box::new(expand_scalar_globals(column, model)),
            order_by: Box::new(expand_scalar_globals(order_by, model)),
        },
        Expression::Window {
            inner,
            function,
            order_by,
            partition_by,
            frame,
        } => Expression::Window {
            inner: Box::new(expand_scalar_globals(inner, model)),
            function: *function,
            order_by: order_by.clone(),
            partition_by: partition_by.clone(),
            frame: frame.clone(),
        },
        Expression::Offset {
            inner,
            delta,
            order_by,
            partition_by,
        } => Expression::Offset {
            inner: Box::new(expand_scalar_globals(inner, model)),
            delta: *delta,
            order_by: order_by.clone(),
            partition_by: partition_by.clone(),
        },
        Expression::Index {
            inner,
            position,
            order_by,
            partition_by,
        } => Expression::Index {
            inner: Box::new(expand_scalar_globals(inner, model)),
            position: *position,
            order_by: order_by.clone(),
            partition_by: partition_by.clone(),
        },
        Expression::InList { expr, values } => Expression::InList {
            expr: Box::new(expand_scalar_globals(expr, model)),
            values: values
                .iter()
                .map(|v| expand_scalar_globals(v, model))
                .collect(),
        },
        // Leaves that don't contain sub-expressions or ColumnRef.
        Expression::LiteralFloat(_)
        | Expression::LiteralInt(_)
        | Expression::LiteralString(_)
        | Expression::LiteralBool(_)
        | Expression::Blank
        | Expression::TableRef(_)
        | Expression::MeasureRef(_)
        | Expression::QualifiedColumnRef { .. }
        | Expression::Query { .. } => expr.clone(),
    }
}

/// Qualify column references in an aggregate operand expression with the fact table name.
///
/// For simple column references (`"col"`), prepends `fact_table."col"`.
/// For compound expressions (e.g., `"price" * "qty"`), qualifies each leaf
/// column reference individually so the result is `fact_table."price" * fact_table."qty"`.
fn qualify_operand_sql(operand: &Expression, fact_table: &str) -> String {
    match operand {
        Expression::ColumnRef(name) => format!("{fact_table}.\"{name}\""),
        Expression::QualifiedColumnRef {
            table_or_var,
            column,
            ..
        } => {
            let tbl = table_or_var.to_lowercase();
            format!("{tbl}.\"{column}\"")
        }
        Expression::BinaryOp { left, op, right } => {
            let l = qualify_operand_sql(left, fact_table);
            let r = qualify_operand_sql(right, fact_table);
            format!("({l} {} {r})", op.as_sql())
        }
        Expression::ScalarFunc { function, args } => {
            let mapped: Vec<String> = args
                .iter()
                .map(|a| qualify_operand_sql(a, fact_table))
                .collect();
            function.to_sql_strs(&mapped)
        }
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => {
            let c = qualify_operand_sql(condition, fact_table);
            let t = qualify_operand_sql(then_expr, fact_table);
            let e = qualify_operand_sql(else_expr, fact_table);
            format!("CASE WHEN {c} THEN {t} ELSE {e} END")
        }
        // For literals and other leaf nodes, just use to_sql_string (no qualification needed).
        _ => operand.to_sql_string(),
    }
}

/// Walk the expression tree to find the first qualified column reference's table.
///
/// Returns `Some(table_name)` if a `QualifiedColumnRef` or `TableRef` is found
/// anywhere in the expression tree. Used by `Measure` to infer which fact table
/// the measure operates on, removing the need for a stored `table` field.
pub fn infer_fact_table(expr: &Expression) -> Option<String> {
    match expr {
        Expression::QualifiedColumnRef { table_or_var, .. } => Some(table_or_var.clone()),
        Expression::TableRef(name) => Some(name.clone()),
        Expression::Aggregate { operand, .. } => infer_fact_table(operand),
        Expression::BinaryOp { left, right, .. }
        | Expression::Comparison { left, right, .. }
        | Expression::And(left, right)
        | Expression::Or(left, right)
        | Expression::Xor(left, right) => {
            infer_fact_table(left).or_else(|| infer_fact_table(right))
        }
        Expression::Not(inner) | Expression::IsBlank(inner) => infer_fact_table(inner),
        Expression::Keep { expr, .. }
        | Expression::Clear { expr, .. }
        | Expression::Reset { expr }
        | Expression::ClearInner { expr, .. }
        | Expression::ClearOuter { expr, .. }
        | Expression::ResetInner { expr }
        | Expression::ResetOuter { expr }
        | Expression::Traverse { expr, .. }
        | Expression::Using { expr, .. }
        | Expression::UseRelationship { expr, .. }
        | Expression::KeepIn { expr, .. } => infer_fact_table(expr),
        Expression::Block { bindings, result } => {
            for (_, e) in bindings {
                if let Some(t) = infer_fact_table(e) {
                    return Some(t);
                }
            }
            infer_fact_table(result)
        }
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => infer_fact_table(condition)
            .or_else(|| infer_fact_table(then_expr))
            .or_else(|| infer_fact_table(else_expr)),
        Expression::Switch {
            expr,
            cases,
            default,
        } => {
            if let Some(t) = infer_fact_table(expr) {
                return Some(t);
            }
            for (v, r) in cases {
                if let Some(t) = infer_fact_table(v).or_else(|| infer_fact_table(r)) {
                    return Some(t);
                }
            }
            default.as_ref().and_then(|d| infer_fact_table(d))
        }
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => infer_fact_table(numerator)
            .or_else(|| infer_fact_table(denominator))
            .or_else(|| alternate.as_ref().and_then(|a| infer_fact_table(a))),
        Expression::Coalesce(exprs) => exprs.iter().find_map(infer_fact_table),
        Expression::ScalarFunc { args, .. } | Expression::TextFunc { args, .. } => {
            args.iter().find_map(infer_fact_table)
        }
        Expression::Query {
            aggregates,
            group_by,
        } => aggregates
            .iter()
            .find_map(|(e, _)| infer_fact_table(e))
            .or_else(|| group_by.first().map(|(table, _)| table.clone())),
        Expression::HasOneValue { column } => infer_fact_table(column),
        Expression::SelectedValue { column, alternate } => infer_fact_table(column)
            .or_else(|| alternate.as_ref().and_then(|a| infer_fact_table(a))),
        Expression::FirstValue { column, order_by } => {
            infer_fact_table(column).or_else(|| infer_fact_table(order_by))
        }
        Expression::Window {
            inner, order_by, ..
        }
        | Expression::Offset {
            inner, order_by, ..
        }
        | Expression::Index {
            inner, order_by, ..
        } => infer_fact_table(inner).or_else(|| order_by.first().map(|(table, _)| table.clone())),
        Expression::InList { expr, values } => {
            infer_fact_table(expr).or_else(|| values.iter().find_map(infer_fact_table))
        }
        Expression::Iterate { table, expression } => {
            Some(table.clone()).or_else(|| infer_fact_table(expression))
        }
        Expression::Percentile { operand, percentile } => {
            infer_fact_table(operand).or_else(|| infer_fact_table(percentile))
        }
        Expression::ClearExcept { expr, .. } => infer_fact_table(expr),
        Expression::IfError { expr, alternate } => {
            infer_fact_table(expr).or_else(|| infer_fact_table(alternate))
        }
        Expression::DateTimeFunc { args, .. } => args.iter().find_map(infer_fact_table),
        Expression::IsInScope { .. } => None,
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn column_ref_sql() {
        let expr = col("amount");
        assert_eq!(expr.to_sql_string(), "\"amount\"");
    }

    #[test]
    fn literal_sql() {
        assert_eq!(lit(3.25).to_sql_string(), "3.25");
        assert_eq!(lit_int(42).to_sql_string(), "42");
    }

    #[test]
    fn binary_op_sql() {
        let expr = col("price").multiply(col("quantity"));
        assert_eq!(expr.to_sql_string(), "(\"price\" * \"quantity\")");
    }

    #[test]
    fn nested_binary_ops_sql() {
        // (revenue - cost) / quantity
        let expr = col("revenue").subtract(col("cost")).divide(col("quantity"));
        assert_eq!(
            expr.to_sql_string(),
            "((\"revenue\" - \"cost\") / \"quantity\")"
        );
    }

    #[test]
    fn simple_aggregate_sql() {
        let expr = agg(AggregateOp::Sum, col("amount"));
        assert_eq!(expr.to_sql_string(), "SUM(\"amount\")");
    }

    #[test]
    fn expression_aggregate_sql() {
        let expr = agg(AggregateOp::Sum, col("price").multiply(col("quantity")));
        assert_eq!(expr.to_sql_string(), "SUM((\"price\" * \"quantity\"))");
    }

    #[test]
    fn ratio_measure_sql() {
        let expr = agg(AggregateOp::Sum, col("amount")).divide(agg(AggregateOp::Count, col("id")));
        assert_eq!(expr.to_sql_string(), "(SUM(\"amount\") / COUNT(\"id\"))");
    }

    #[test]
    fn distinct_count_sql() {
        let expr = agg(AggregateOp::DistinctCount, col("product_id"));
        assert_eq!(expr.to_sql_string(), "COUNT(DISTINCT \"product_id\")");
    }

    #[test]
    fn column_references_simple() {
        let expr = col("amount");
        assert_eq!(expr.column_references(), vec!["amount"]);
    }

    #[test]
    fn column_references_binary() {
        let expr = col("price").multiply(col("quantity"));
        assert_eq!(expr.column_references(), vec!["price", "quantity"]);
    }

    #[test]
    fn column_references_nested() {
        let expr = agg(AggregateOp::Sum, col("revenue").subtract(col("cost")));
        assert_eq!(expr.column_references(), vec!["cost", "revenue"]);
    }

    #[test]
    fn column_references_deduplicated() {
        // SUM(amount) / COUNT(amount)
        let expr =
            agg(AggregateOp::Sum, col("amount")).divide(agg(AggregateOp::Count, col("amount")));
        assert_eq!(expr.column_references(), vec!["amount"]);
    }

    #[test]
    fn column_references_literal_only() {
        let expr = lit(100.0);
        assert!(expr.column_references().is_empty());
    }

    #[test]
    fn has_aggregate_detection() {
        assert!(!col("x").has_aggregate());
        assert!(!lit(1.0).has_aggregate());
        assert!(!col("a").add(col("b")).has_aggregate());
        assert!(agg(AggregateOp::Sum, col("x")).has_aggregate());
        assert!(agg(AggregateOp::Sum, col("x"))
            .divide(agg(AggregateOp::Count, col("y")))
            .has_aggregate());
    }

    #[test]
    fn is_simple_aggregate_detection() {
        assert!(agg(AggregateOp::Sum, col("amount")).is_simple_aggregate());
        assert!(agg(AggregateOp::DistinctCount, col("id")).is_simple_aggregate());
        // QualifiedColumnRef is also simple
        assert!(agg(AggregateOp::Sum, qualified_col("sales", "amount")).is_simple_aggregate());
        assert!(
            agg(AggregateOp::DistinctCount, qualified_col("orders", "id")).is_simple_aggregate()
        );
        // Not simple: aggregate over expression
        assert!(!agg(AggregateOp::Sum, col("price").multiply(col("qty"))).is_simple_aggregate());
        // Not simple: ratio
        assert!(!agg(AggregateOp::Sum, col("a"))
            .divide(agg(AggregateOp::Count, col("b")))
            .is_simple_aggregate());
        // Not an aggregate at all
        assert!(!col("x").is_simple_aggregate());
        assert!(!qualified_col("t", "x").is_simple_aggregate());
    }

    #[test]
    fn as_simple_aggregate_extraction() {
        let expr = agg(AggregateOp::Sum, col("amount"));
        let (op, column) = expr.as_simple_aggregate().unwrap();
        assert_eq!(op, AggregateOp::Sum);
        assert_eq!(column, "amount");

        // QualifiedColumnRef extracts the column name
        let expr2 = agg(AggregateOp::Sum, qualified_col("sales", "price"));
        let (op2, col2) = expr2.as_simple_aggregate().unwrap();
        assert_eq!(op2, AggregateOp::Sum);
        assert_eq!(col2, "price");

        // Complex expression returns None
        let complex = agg(AggregateOp::Sum, col("a").add(col("b")));
        assert!(complex.as_simple_aggregate().is_none());
    }

    // --- Context manipulation tests ---

    #[test]
    fn keep_expression_sql_passes_through() {
        let expr = keep(
            col("amount"),
            vec![FilterPredicate::new(
                "Sales",
                "Region",
                ComparisonOp::Equal,
                "US",
            )],
        );
        // SQL rendering passes through to inner expression
        assert_eq!(expr.to_sql_string(), "\"amount\"");
    }

    #[test]
    fn keep_with_aggregate_sql() {
        let expr = agg(
            AggregateOp::Sum,
            keep(
                col("amount"),
                vec![FilterPredicate::new(
                    "Calendar",
                    "Year",
                    ComparisonOp::Equal,
                    "2024",
                )],
            ),
        );
        assert_eq!(expr.to_sql_string(), "SUM(\"amount\")");
    }

    #[test]
    fn clear_expression_sql_passes_through() {
        let expr = clear(
            col("amount"),
            vec![ClearTarget::Column {
                table: "Sales".into(),
                column: "Region".into(),
            }],
        );
        assert_eq!(expr.to_sql_string(), "\"amount\"");
    }

    #[test]
    fn reset_expression_sql_passes_through() {
        let expr = reset(col("amount"));
        assert_eq!(expr.to_sql_string(), "\"amount\"");
    }

    #[test]
    fn traverse_expression_sql_passes_through() {
        let expr = traverse(
            col("amount"),
            RelationshipPath::new(vec!["Sales", "Products"]),
        );
        assert_eq!(expr.to_sql_string(), "\"amount\"");
    }

    #[test]
    fn using_expression_sql_passes_through() {
        let expr = using(col("amount"), "ctx_2024");
        assert_eq!(expr.to_sql_string(), "\"amount\"");
    }

    #[test]
    fn block_expression_sql_inlines_bindings() {
        let expr = block(
            vec![
                ("actual".into(), agg(AggregateOp::Sum, col("amount"))),
                ("total".into(), agg(AggregateOp::Sum, col("amount"))),
            ],
            col("actual").divide(col("total")),
        );
        // Bindings are inlined: actual → SUM("amount"), total → SUM("amount")
        assert_eq!(expr.to_sql_string(), "(SUM(\"amount\") / SUM(\"amount\"))");
    }

    #[test]
    fn has_context_ops_detection() {
        assert!(!col("x").has_context_ops());
        assert!(!agg(AggregateOp::Sum, col("x")).has_context_ops());
        assert!(keep(col("x"), vec![]).has_context_ops());
        assert!(clear(col("x"), vec![]).has_context_ops());
        assert!(reset(col("x")).has_context_ops());
        assert!(using(col("x"), "ctx").has_context_ops());
        assert!(traverse(col("x"), RelationshipPath::new(vec!["A", "B"])).has_context_ops());
        // Nested inside aggregate
        assert!(agg(AggregateOp::Sum, keep(col("x"), vec![])).has_context_ops());
    }

    #[test]
    fn has_aggregate_through_context_ops() {
        let expr = keep(agg(AggregateOp::Sum, col("amount")), vec![]);
        assert!(expr.has_aggregate());

        let expr2 = reset(col("amount"));
        assert!(!expr2.has_aggregate());
    }

    #[test]
    fn column_references_through_context_ops() {
        let expr = keep(
            col("amount"),
            vec![FilterPredicate::new(
                "Sales",
                "Region",
                ComparisonOp::Equal,
                "US",
            )],
        );
        assert_eq!(expr.column_references(), vec!["amount"]);
    }

    #[test]
    fn block_column_references() {
        let expr = block(
            vec![("x".into(), col("price").multiply(col("qty")))],
            col("x"),
        );
        let refs = expr.column_references();
        assert!(refs.contains(&"price"));
        assert!(refs.contains(&"qty"));
        // "x" is a VAR binding name, not a real column — it should be excluded.
        assert!(!refs.contains(&"x"));
    }

    #[test]
    fn filter_predicate_creation() {
        let fp = FilterPredicate::new("Sales", "Region", ComparisonOp::GreaterThan, "100");
        assert_eq!(fp.table, "Sales");
        assert_eq!(fp.column, "Region");
        assert_eq!(fp.operator, ComparisonOp::GreaterThan);
        assert_eq!(fp.value, "100");
    }

    #[test]
    fn comparison_op_sql() {
        assert_eq!(ComparisonOp::Equal.as_sql(), "=");
        assert_eq!(ComparisonOp::NotEqual.as_sql(), "!=");
        assert_eq!(ComparisonOp::GreaterThan.as_sql(), ">");
        assert_eq!(ComparisonOp::GreaterThanOrEqual.as_sql(), ">=");
        assert_eq!(ComparisonOp::LessThan.as_sql(), "<");
        assert_eq!(ComparisonOp::LessThanOrEqual.as_sql(), "<=");
    }

    #[test]
    fn relationship_path_creation() {
        let path = RelationshipPath::new(vec!["Sales", "Products"]);
        assert_eq!(path.hops, vec!["Sales", "Products"]);
    }

    #[test]
    fn nested_context_ops() {
        // keep(clear(expr, Region), Year = 2024) — the "override" pattern
        let expr = keep(
            clear(
                col("amount"),
                vec![ClearTarget::Column {
                    table: "Calendar".into(),
                    column: "Year".into(),
                }],
            ),
            vec![FilterPredicate::new(
                "Calendar",
                "Year",
                ComparisonOp::Equal,
                "2024",
            )],
        );
        assert!(expr.has_context_ops());
        assert!(!expr.has_aggregate());
        assert_eq!(expr.to_sql_string(), "\"amount\"");
    }

    // --- Table variable expression tests ---

    #[test]
    fn table_ref_sql_empty() {
        let expr = table_ref("premium");
        assert_eq!(expr.to_sql_string(), "");
    }

    #[test]
    fn qualified_column_ref_sql() {
        let expr = qualified_col("Products", "category");
        assert_eq!(expr.to_sql_string(), "\"category\"");
    }

    #[test]
    fn qualified_column_ref_column_references() {
        let expr = qualified_col("premium", "category");
        assert_eq!(expr.column_references(), vec!["category"]);
    }

    #[test]
    fn table_ref_no_column_references() {
        let expr = table_ref("premium");
        assert!(expr.column_references().is_empty());
    }

    #[test]
    fn qualified_column_ref_no_context_ops() {
        assert!(!qualified_col("X", "y").has_context_ops());
        assert!(!table_ref("X").has_context_ops());
    }

    #[test]
    fn qualified_column_ref_serialization_roundtrip() {
        let expr = qualified_col("premium", "amount");
        let json = serde_json::to_string(&expr).unwrap();
        let deserialized: Expression = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.to_sql_string(), "\"amount\"");
    }

    #[test]
    fn table_ref_serialization_roundtrip() {
        let expr = table_ref("premium");
        let json = serde_json::to_string(&expr).unwrap();
        let deserialized: Expression = serde_json::from_str(&json).unwrap();
        assert!(matches!(deserialized, Expression::TableRef(ref n) if n == "premium"));
    }

    // --- IN operator tests ---

    #[test]
    fn in_predicate_creation() {
        let pred = InPredicate::new("Sales", "product_id", "premium", "id");
        assert_eq!(pred.table, "Sales");
        assert_eq!(pred.column, "product_id");
        assert_eq!(pred.var_name, "premium");
        assert_eq!(pred.var_column, "id");
    }

    #[test]
    fn keep_in_has_context_ops() {
        let expr = keep_in(col("amount"), vec![InPredicate::new("S", "c", "v", "c2")]);
        assert!(expr.has_context_ops());
    }

    #[test]
    fn keep_in_sql_passes_through() {
        let expr = keep_in(col("amount"), vec![InPredicate::new("S", "c", "v", "c2")]);
        assert_eq!(expr.to_sql_string(), "\"amount\"");
    }

    #[test]
    fn keep_in_serialization_roundtrip() {
        let expr = keep_in(
            agg(AggregateOp::Sum, col("amount")),
            vec![InPredicate::new("Sales", "product_id", "premium", "id")],
        );
        let json = serde_json::to_string(&expr).unwrap();
        let deserialized: Expression = serde_json::from_str(&json).unwrap();
        assert!(deserialized.has_context_ops());
        assert!(deserialized.has_aggregate());
        assert_eq!(deserialized.to_sql_string(), "SUM(\"amount\")");
    }

    #[test]
    fn context_expression_serialization_roundtrip() {
        let expr = agg(
            AggregateOp::Sum,
            keep(
                col("amount"),
                vec![FilterPredicate::new(
                    "Calendar",
                    "Year",
                    ComparisonOp::Equal,
                    "2024",
                )],
            ),
        );
        let json = serde_json::to_string(&expr).unwrap();
        let deserialized: Expression = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.to_sql_string(), "SUM(\"amount\")");
        assert!(deserialized.has_context_ops());
        assert!(deserialized.has_aggregate());
    }

    // --- New expression type tests ---

    #[test]
    fn literal_string_sql() {
        assert_eq!(lit_str("hello").to_sql_string(), "'hello'");
        // Escaped single quotes
        assert_eq!(lit_str("it's").to_sql_string(), "'it''s'");
    }

    #[test]
    fn blank_sql() {
        assert_eq!(blank().to_sql_string(), "NULL");
    }

    #[test]
    fn is_blank_sql() {
        let expr = is_blank(col("amount"));
        assert_eq!(expr.to_sql_string(), "(\"amount\" IS NULL)");
    }

    #[test]
    fn comparison_sql() {
        let expr = compare(col("amount"), ComparisonOp::GreaterThan, lit_int(100));
        assert_eq!(expr.to_sql_string(), "(\"amount\" > 100)");
    }

    #[test]
    fn and_or_not_sql() {
        let a = compare(col("x"), ComparisonOp::GreaterThan, lit_int(0));
        let b = compare(col("y"), ComparisonOp::LessThan, lit_int(10));
        assert_eq!(
            and(a.clone(), b.clone()).to_sql_string(),
            "((\"x\" > 0) AND (\"y\" < 10))"
        );
        assert_eq!(
            or(a.clone(), b.clone()).to_sql_string(),
            "((\"x\" > 0) OR (\"y\" < 10))"
        );
        assert_eq!(not(a).to_sql_string(), "(NOT (\"x\" > 0))");
    }

    #[test]
    fn if_expr_sql() {
        let expr = if_expr(
            compare(
                agg(AggregateOp::Sum, col("amount")),
                ComparisonOp::GreaterThan,
                lit_int(1000),
            ),
            lit_str("High"),
            lit_str("Low"),
        );
        assert_eq!(
            expr.to_sql_string(),
            "CASE WHEN (SUM(\"amount\") > 1000) THEN 'High' ELSE 'Low' END"
        );
    }

    #[test]
    fn if_expr_has_aggregate() {
        let expr = if_expr(
            compare(
                agg(AggregateOp::Sum, col("a")),
                ComparisonOp::GreaterThan,
                lit_int(0),
            ),
            agg(AggregateOp::Sum, col("a")),
            lit_int(0),
        );
        assert!(expr.has_aggregate());
    }

    #[test]
    fn switch_sql() {
        let expr = switch(
            col("status"),
            vec![
                (lit_int(1), lit_str("Active")),
                (lit_int(2), lit_str("Inactive")),
            ],
            Some(lit_str("Unknown")),
        );
        assert_eq!(
            expr.to_sql_string(),
            "CASE \"status\" WHEN 1 THEN 'Active' WHEN 2 THEN 'Inactive' ELSE 'Unknown' END"
        );
    }

    #[test]
    fn switch_without_default_sql() {
        let expr = switch(col("status"), vec![(lit_int(1), lit_str("Active"))], None);
        assert_eq!(
            expr.to_sql_string(),
            "CASE \"status\" WHEN 1 THEN 'Active' END"
        );
    }

    #[test]
    fn safe_divide_sql() {
        let expr = safe_divide(
            agg(AggregateOp::Sum, col("revenue")),
            agg(AggregateOp::Count, col("orders")),
            None,
        );
        assert_eq!(
            expr.to_sql_string(),
            "CASE WHEN COUNT(\"orders\") = 0 THEN NULL ELSE (CAST(SUM(\"revenue\") AS DOUBLE) / COUNT(\"orders\")) END"
        );
    }

    #[test]
    fn safe_divide_with_alternate_sql() {
        let expr = safe_divide(col("a"), col("b"), Some(lit_int(0)));
        assert_eq!(
            expr.to_sql_string(),
            "CASE WHEN \"b\" = 0 THEN 0 ELSE (CAST(\"a\" AS DOUBLE) / \"b\") END"
        );
    }

    #[test]
    fn coalesce_sql() {
        let expr = coalesce(vec![col("a"), col("b"), lit_int(0)]);
        assert_eq!(expr.to_sql_string(), "COALESCE(\"a\", \"b\", 0)");
    }

    #[test]
    fn scalar_abs_sql() {
        let expr = scalar_fn(ScalarFunction::Abs, vec![col("value")]);
        assert_eq!(expr.to_sql_string(), "ABS(\"value\")");
    }

    #[test]
    fn scalar_round_sql() {
        let expr = scalar_fn(ScalarFunction::Round, vec![col("price"), lit_int(2)]);
        assert_eq!(expr.to_sql_string(), "ROUND(\"price\", 2)");
    }

    #[test]
    fn scalar_int_sql() {
        let expr = scalar_fn(ScalarFunction::Int, vec![col("value")]);
        assert_eq!(expr.to_sql_string(), "FLOOR(\"value\")");
    }

    #[test]
    fn scalar_sqrt_sql() {
        let expr = scalar_fn(ScalarFunction::Sqrt, vec![col("value")]);
        assert_eq!(expr.to_sql_string(), "SQRT(\"value\")");
    }

    #[test]
    fn scalar_mod_sql() {
        let expr = scalar_fn(ScalarFunction::Mod, vec![col("a"), col("b")]);
        assert_eq!(expr.to_sql_string(), "(\"a\" % \"b\")");
    }

    #[test]
    fn count_rows_sql() {
        let expr = count_rows();
        assert_eq!(expr.to_sql_string(), "COUNT(*)");
        assert!(expr.is_simple_aggregate());
    }

    #[test]
    fn count_rows_as_simple_aggregate() {
        let expr = count_rows();
        let (op, col_name) = expr.as_simple_aggregate().unwrap();
        assert_eq!(op, AggregateOp::CountRows);
        assert_eq!(col_name, "*");
    }

    #[test]
    fn new_exprs_column_references() {
        let expr = if_expr(
            compare(col("status"), ComparisonOp::Equal, lit_int(1)),
            col("revenue"),
            col("cost"),
        );
        let refs = expr.column_references();
        assert!(refs.contains(&"status"));
        assert!(refs.contains(&"revenue"));
        assert!(refs.contains(&"cost"));
    }

    #[test]
    fn new_exprs_no_context_ops() {
        assert!(!if_expr(
            compare(col("x"), ComparisonOp::Equal, lit_int(1)),
            lit_int(1),
            lit_int(0),
        )
        .has_context_ops());
        assert!(!safe_divide(col("a"), col("b"), None).has_context_ops());
        assert!(!coalesce(vec![col("a"), lit_int(0)]).has_context_ops());
        assert!(!scalar_fn(ScalarFunction::Abs, vec![col("x")]).has_context_ops());
        assert!(!blank().has_context_ops());
        assert!(!is_blank(col("x")).has_context_ops());
    }

    #[test]
    fn new_exprs_serialization_roundtrip() {
        let exprs = vec![
            if_expr(
                compare(col("x"), ComparisonOp::GreaterThan, lit_int(0)),
                lit_str("pos"),
                lit_str("neg"),
            ),
            safe_divide(col("a"), col("b"), Some(lit_int(0))),
            coalesce(vec![col("a"), col("b")]),
            blank(),
            is_blank(col("x")),
            scalar_fn(ScalarFunction::Round, vec![col("price"), lit_int(2)]),
            count_rows(),
        ];
        for expr in exprs {
            let json = serde_json::to_string(&expr).unwrap();
            let deser: Expression = serde_json::from_str(&json).unwrap();
            assert_eq!(deser.to_sql_string(), expr.to_sql_string());
        }
    }

    // --- Block / VAR inline substitution tests ---

    #[test]
    fn block_inline_simple() {
        // VAR total = SUM(amount) RETURN total * 2
        let expr = block(
            vec![("total".into(), agg(AggregateOp::Sum, col("amount")))],
            col("total").multiply(lit_int(2)),
        );
        let sql = expr.to_sql_string();
        assert_eq!(sql, "(SUM(\"amount\") * 2)");
    }

    #[test]
    fn block_inline_chained() {
        // VAR a = SUM(x) VAR b = a * 2 RETURN b + 1
        let expr = block(
            vec![
                ("a".into(), agg(AggregateOp::Sum, col("x"))),
                ("b".into(), col("a").multiply(lit_int(2))),
            ],
            col("b").add(lit_int(1)),
        );
        let sql = expr.to_sql_string();
        assert_eq!(sql, "((SUM(\"x\") * 2) + 1)");
    }

    #[test]
    fn block_inline_with_divide() {
        // VAR rev = SUM(amount) VAR cnt = COUNT(id) RETURN DIVIDE(rev, cnt)
        let expr = block(
            vec![
                ("rev".into(), agg(AggregateOp::Sum, col("amount"))),
                ("cnt".into(), agg(AggregateOp::Count, col("id"))),
            ],
            safe_divide(col("rev"), col("cnt"), None),
        );
        let sql = expr.to_sql_string();
        assert_eq!(
            sql,
            "CASE WHEN COUNT(\"id\") = 0 THEN NULL ELSE (CAST(SUM(\"amount\") AS DOUBLE) / COUNT(\"id\")) END"
        );
    }

    #[test]
    fn block_inline_preserves_non_var_columns() {
        // VAR total = SUM(amount) RETURN total / real_column
        let expr = block(
            vec![("total".into(), agg(AggregateOp::Sum, col("amount")))],
            col("total").divide(col("real_column")),
        );
        let sql = expr.to_sql_string();
        // "total" substituted, "real_column" preserved as column ref
        assert_eq!(sql, "(SUM(\"amount\") / \"real_column\")");
    }

    #[test]
    fn block_inline_case_when() {
        // VAR total = SUM(amount) RETURN total * 2
        let expr = block(
            vec![("total".into(), agg(AggregateOp::Sum, col("amount")))],
            col("total").multiply(lit_int(2)),
        );
        let sql = expr.to_case_when_sql("f.\"region\" = 'US'", "f");
        // CASE WHEN should be applied to the aggregate inside the inlined expression.
        assert!(sql.contains("SUM(CASE WHEN"));
        assert!(sql.contains("* 2"));
    }

    #[test]
    fn block_without_context_ops_returns_false() {
        let expr = block(
            vec![("total".into(), agg(AggregateOp::Sum, col("amount")))],
            col("total"),
        );
        assert!(!expr.has_context_ops());
    }

    #[test]
    fn block_with_context_ops_returns_true() {
        use crate::model::ClearTarget;
        let clear_expr = Expression::Clear {
            expr: Box::new(agg(AggregateOp::Sum, col("amount"))),
            targets: vec![ClearTarget::Table("dim".to_string())],
        };
        let expr = block(vec![("total".into(), clear_expr)], col("total"));
        assert!(expr.has_context_ops());
    }

    #[test]
    fn block_serialization_roundtrip() {
        let expr = block(
            vec![
                ("rev".into(), agg(AggregateOp::Sum, col("amount"))),
                ("cnt".into(), agg(AggregateOp::Count, col("id"))),
            ],
            safe_divide(col("rev"), col("cnt"), None),
        );
        let json = serde_json::to_string(&expr).unwrap();
        let deser: Expression = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.to_sql_string(), expr.to_sql_string());
    }

    #[test]
    fn has_one_value_sql() {
        let expr = has_one_value(col("region"));
        assert_eq!(expr.to_sql_string(), "(COUNT(DISTINCT \"region\") = 1)");
    }

    #[test]
    fn selected_value_sql_no_alternate() {
        let expr = selected_value(col("region"), None);
        assert_eq!(
            expr.to_sql_string(),
            "CASE WHEN COUNT(DISTINCT \"region\") = 1 THEN MIN(\"region\") ELSE NULL END"
        );
    }

    #[test]
    fn selected_value_sql_with_alternate() {
        let expr = selected_value(col("region"), Some(lit_str("Multiple")));
        assert_eq!(
            expr.to_sql_string(),
            "CASE WHEN COUNT(DISTINCT \"region\") = 1 THEN MIN(\"region\") ELSE 'Multiple' END"
        );
    }

    #[test]
    fn first_value_sql() {
        let expr = first_value(col("name"), col("sort_order"));
        assert_eq!(
            expr.to_sql_string(),
            "FIRST_VALUE(\"name\" ORDER BY \"sort_order\")"
        );
    }

    #[test]
    fn has_one_value_has_aggregate() {
        let expr = has_one_value(col("region"));
        assert!(expr.has_aggregate());
    }

    #[test]
    fn selected_value_has_aggregate() {
        let expr = selected_value(col("region"), None);
        assert!(expr.has_aggregate());
    }

    #[test]
    fn first_value_has_aggregate() {
        let expr = first_value(col("name"), col("sort_order"));
        assert!(expr.has_aggregate());
    }

    #[test]
    fn has_one_value_serialization_roundtrip() {
        let expr = has_one_value(col("region"));
        let json = serde_json::to_string(&expr).unwrap();
        let deser: Expression = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.to_sql_string(), expr.to_sql_string());
    }

    #[test]
    fn selected_value_serialization_roundtrip() {
        let expr = selected_value(col("region"), Some(lit_str("Multiple")));
        let json = serde_json::to_string(&expr).unwrap();
        let deser: Expression = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.to_sql_string(), expr.to_sql_string());
    }

    #[test]
    fn first_value_serialization_roundtrip() {
        let expr = first_value(col("name"), col("sort_order"));
        let json = serde_json::to_string(&expr).unwrap();
        let deser: Expression = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.to_sql_string(), expr.to_sql_string());
    }

    // --- Logical function tests ---

    #[test]
    fn literal_bool_sql() {
        assert_eq!(lit_bool(true).to_sql_string(), "TRUE");
        assert_eq!(lit_bool(false).to_sql_string(), "FALSE");
    }

    #[test]
    fn literal_bool_no_aggregate() {
        assert!(!lit_bool(true).has_aggregate());
        assert!(!lit_bool(false).has_aggregate());
    }

    #[test]
    fn literal_bool_no_context_ops() {
        assert!(!lit_bool(true).has_context_ops());
    }

    #[test]
    fn literal_bool_no_column_refs() {
        assert!(lit_bool(true).column_references().is_empty());
    }

    #[test]
    fn literal_bool_serialization_roundtrip() {
        let expr = lit_bool(true);
        let json = serde_json::to_string(&expr).unwrap();
        let deser: Expression = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.to_sql_string(), "TRUE");

        let expr2 = lit_bool(false);
        let json2 = serde_json::to_string(&expr2).unwrap();
        let deser2: Expression = serde_json::from_str(&json2).unwrap();
        assert_eq!(deser2.to_sql_string(), "FALSE");
    }

    #[test]
    fn xor_sql() {
        let a = compare(col("x"), ComparisonOp::GreaterThan, lit_int(0));
        let b = compare(col("y"), ComparisonOp::LessThan, lit_int(10));
        assert_eq!(
            xor(a, b).to_sql_string(),
            "(((\"x\" > 0) AND NOT (\"y\" < 10)) OR (NOT (\"x\" > 0) AND (\"y\" < 10)))"
        );
    }

    #[test]
    fn xor_has_aggregate() {
        let expr = xor(
            agg(AggregateOp::Sum, col("a")),
            agg(AggregateOp::Count, col("b")),
        );
        assert!(expr.has_aggregate());
    }

    #[test]
    fn xor_column_references() {
        let expr = xor(col("a"), col("b"));
        let refs = expr.column_references();
        assert!(refs.contains(&"a"));
        assert!(refs.contains(&"b"));
    }

    #[test]
    fn xor_no_context_ops() {
        assert!(!xor(col("a"), col("b")).has_context_ops());
    }

    #[test]
    fn xor_serialization_roundtrip() {
        let expr = xor(lit_bool(true), lit_bool(false));
        let json = serde_json::to_string(&expr).unwrap();
        let deser: Expression = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.to_sql_string(), expr.to_sql_string());
    }

    // --- Text function tests ---

    #[test]
    fn text_concatenate_sql() {
        let expr = text_fn(
            TextFunction::Concatenate,
            vec![col("a"), col("b"), col("c")],
        );
        assert_eq!(expr.to_sql_string(), "CONCAT(\"a\", \"b\", \"c\")");
    }

    #[test]
    fn text_combinevalues_sql() {
        let expr = text_fn(
            TextFunction::CombineValues,
            vec![lit_str("-"), col("a"), col("b")],
        );
        assert_eq!(expr.to_sql_string(), "CONCAT_WS('-', \"a\", \"b\")");
    }

    #[test]
    fn text_exact_sql() {
        let expr = text_fn(TextFunction::Exact, vec![col("a"), col("b")]);
        assert_eq!(expr.to_sql_string(), "(\"a\" = \"b\")");
    }

    #[test]
    fn text_find_sql() {
        let expr = text_fn(TextFunction::Find, vec![lit_str("x"), col("text")]);
        assert_eq!(expr.to_sql_string(), "STRPOS(\"text\", 'x')");
    }

    #[test]
    fn text_find_with_start_sql() {
        let expr = text_fn(
            TextFunction::Find,
            vec![lit_str("x"), col("text"), lit_int(5)],
        );
        assert_eq!(
            expr.to_sql_string(),
            "(STRPOS(SUBSTRING(\"text\" FROM 5), 'x') + 5 - 1)"
        );
    }

    #[test]
    fn text_left_sql() {
        let expr = text_fn(TextFunction::Left, vec![col("name"), lit_int(3)]);
        assert_eq!(expr.to_sql_string(), "LEFT(\"name\", 3)");
    }

    #[test]
    fn text_len_sql() {
        let expr = text_fn(TextFunction::Len, vec![col("name")]);
        assert_eq!(expr.to_sql_string(), "LENGTH(\"name\")");
    }

    #[test]
    fn text_lower_upper_sql() {
        assert_eq!(
            text_fn(TextFunction::Lower, vec![col("name")]).to_sql_string(),
            "LOWER(\"name\")"
        );
        assert_eq!(
            text_fn(TextFunction::Upper, vec![col("name")]).to_sql_string(),
            "UPPER(\"name\")"
        );
    }

    #[test]
    fn text_mid_sql() {
        let expr = text_fn(TextFunction::Mid, vec![col("text"), lit_int(2), lit_int(4)]);
        assert_eq!(expr.to_sql_string(), "SUBSTRING(\"text\" FROM 2 FOR 4)");
    }

    #[test]
    fn text_replace_sql() {
        let expr = text_fn(
            TextFunction::Replace,
            vec![col("text"), lit_int(3), lit_int(2), lit_str("XX")],
        );
        assert_eq!(
            expr.to_sql_string(),
            "OVERLAY(\"text\" PLACING 'XX' FROM 3 FOR 2)"
        );
    }

    #[test]
    fn text_rept_sql() {
        let expr = text_fn(TextFunction::Rept, vec![lit_str("ab"), lit_int(3)]);
        assert_eq!(expr.to_sql_string(), "REPEAT('ab', 3)");
    }

    #[test]
    fn text_right_sql() {
        let expr = text_fn(TextFunction::Right, vec![col("name"), lit_int(2)]);
        assert_eq!(expr.to_sql_string(), "RIGHT(\"name\", 2)");
    }

    #[test]
    fn text_search_sql() {
        let expr = text_fn(TextFunction::Search, vec![lit_str("X"), col("text")]);
        assert_eq!(expr.to_sql_string(), "STRPOS(LOWER(\"text\"), LOWER('X'))");
    }

    #[test]
    fn text_substitute_sql() {
        let expr = text_fn(
            TextFunction::Substitute,
            vec![col("text"), lit_str("old"), lit_str("new")],
        );
        assert_eq!(expr.to_sql_string(), "REPLACE(\"text\", 'old', 'new')");
    }

    #[test]
    fn text_trim_sql() {
        let expr = text_fn(TextFunction::Trim, vec![col("name")]);
        assert_eq!(expr.to_sql_string(), "TRIM(\"name\")");
    }

    #[test]
    fn text_unichar_sql() {
        let expr = text_fn(TextFunction::Unichar, vec![lit_int(65)]);
        assert_eq!(expr.to_sql_string(), "CHR(65)");
    }

    #[test]
    fn text_unicode_sql() {
        let expr = text_fn(TextFunction::Unicode, vec![lit_str("A")]);
        assert_eq!(expr.to_sql_string(), "ASCII('A')");
    }

    #[test]
    fn text_value_sql() {
        let expr = text_fn(TextFunction::Value, vec![col("price_text")]);
        assert_eq!(expr.to_sql_string(), "CAST(\"price_text\" AS DOUBLE)");
    }

    #[test]
    fn text_fixed_sql() {
        let expr = text_fn(TextFunction::Fixed, vec![col("amount"), lit_int(2)]);
        assert_eq!(
            expr.to_sql_string(),
            "CAST(ROUND(\"amount\", 2) AS VARCHAR)"
        );
    }

    #[test]
    fn text_ltrim_sql() {
        let expr = text_fn(TextFunction::Ltrim, vec![col("name")]);
        assert_eq!(expr.to_sql_string(), "LTRIM(\"name\")");
        let expr = text_fn(TextFunction::Ltrim, vec![col("name"), lit_str("0#")]);
        assert_eq!(expr.to_sql_string(), "LTRIM(\"name\", '0#')");
    }

    #[test]
    fn text_rtrim_sql() {
        let expr = text_fn(TextFunction::Rtrim, vec![col("price")]);
        assert_eq!(expr.to_sql_string(), "RTRIM(\"price\")");
        let expr = text_fn(TextFunction::Rtrim, vec![col("price"), lit_str("0.")]);
        assert_eq!(expr.to_sql_string(), "RTRIM(\"price\", '0.')");
    }

    #[test]
    fn text_lpad_sql() {
        let expr = text_fn(TextFunction::Lpad, vec![col("id"), lit_int(5)]);
        assert_eq!(expr.to_sql_string(), "LPAD(\"id\", 5)");
        let expr = text_fn(
            TextFunction::Lpad,
            vec![col("id"), lit_int(5), lit_str("0")],
        );
        assert_eq!(expr.to_sql_string(), "LPAD(\"id\", 5, '0')");
    }

    #[test]
    fn text_rpad_sql() {
        let expr = text_fn(TextFunction::Rpad, vec![col("code"), lit_int(10)]);
        assert_eq!(expr.to_sql_string(), "RPAD(\"code\", 10)");
        let expr = text_fn(
            TextFunction::Rpad,
            vec![col("code"), lit_int(10), lit_str("*")],
        );
        assert_eq!(expr.to_sql_string(), "RPAD(\"code\", 10, '*')");
    }

    #[test]
    fn text_reverse_sql() {
        let expr = text_fn(TextFunction::Reverse, vec![col("text")]);
        assert_eq!(expr.to_sql_string(), "REVERSE(\"text\")");
    }

    #[test]
    fn text_split_sql() {
        let expr = text_fn(
            TextFunction::Split,
            vec![col("path"), lit_str("/"), lit_int(2)],
        );
        assert_eq!(expr.to_sql_string(), "SPLIT_PART(\"path\", '/', 2)");
    }

    #[test]
    fn text_func_no_aggregate() {
        assert!(!text_fn(TextFunction::Upper, vec![col("x")]).has_aggregate());
    }

    #[test]
    fn text_func_no_context_ops() {
        assert!(!text_fn(TextFunction::Lower, vec![col("x")]).has_context_ops());
    }

    #[test]
    fn text_func_column_refs() {
        let expr = text_fn(TextFunction::Concatenate, vec![col("a"), col("b")]);
        let refs = expr.column_references();
        assert!(refs.contains(&"a"));
        assert!(refs.contains(&"b"));
    }

    #[test]
    fn text_func_serialization_roundtrip() {
        let exprs = vec![
            text_fn(TextFunction::Upper, vec![col("name")]),
            text_fn(
                TextFunction::Concatenate,
                vec![col("a"), col("b"), col("c")],
            ),
            text_fn(TextFunction::Mid, vec![col("x"), lit_int(1), lit_int(3)]),
            text_fn(TextFunction::Value, vec![lit_str("42")]),
        ];
        for expr in exprs {
            let json = serde_json::to_string(&expr).unwrap();
            let deser: Expression = serde_json::from_str(&json).unwrap();
            assert_eq!(deser.to_sql_string(), expr.to_sql_string());
        }
    }

    // --- Global variable expansion tests ---

    fn make_model_with_globals() -> crate::model::schema::DataModel {
        use crate::compute::aggregate::AggregateOp;
        use crate::model::column::Column;
        use crate::model::global_variable::GlobalVariable;
        use crate::model::table::Table;
        use crate::types::DataType;

        let fact = Table::new(
            "fact_sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("linetotal", DataType::Float64),
                Column::new("customer_id", DataType::Int64),
            ],
        )
        .unwrap();

        let dim = Table::new(
            "dim_customer",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("city", DataType::String),
            ],
        )
        .unwrap();

        // Scalar global: SUM(fact_sales[linetotal])
        let scalar_gv = GlobalVariable::new(
            "total_revenue",
            "fact_sales",
            Expression::Aggregate {
                operation: AggregateOp::Sum,
                operand: Box::new(col("linetotal")),
            },
        );

        // Table global: QUERY(SUM(fact_sales[linetotal]) AS Amount BY dim_customer[city])
        let query_gv = GlobalVariable::new(
            "city_sales",
            "fact_sales",
            Expression::Query {
                aggregates: vec![(
                    Expression::Aggregate {
                        operation: AggregateOp::Sum,
                        operand: Box::new(col("linetotal")),
                    },
                    "Amount".into(),
                )],
                group_by: vec![("dim_customer".into(), "city".into())],
            },
        );

        crate::model::schema::DataModel::builder()
            .add_table(fact)
            .add_table(dim)
            .add_global_variable(scalar_gv)
            .add_global_variable(query_gv)
            .build()
            .unwrap()
    }

    #[test]
    fn expand_scalar_global_substitutes_inline() {
        let model = make_model_with_globals();
        // total_revenue should be replaced with SUM(linetotal)
        let expr = col("total_revenue");
        let expanded = expand_global_variables(&expr, &model);

        assert!(matches!(expanded, Expression::Aggregate { .. }));
        assert_eq!(expanded.to_sql_string(), "SUM(\"linetotal\")");
    }

    #[test]
    fn expand_scalar_global_in_arithmetic() {
        let model = make_model_with_globals();
        // total_revenue / 100
        let expr = col("total_revenue").divide(lit(100.0));
        let expanded = expand_global_variables(&expr, &model);

        assert_eq!(expanded.to_sql_string(), "(SUM(\"linetotal\") / 100)");
    }

    #[test]
    fn expand_query_global_wraps_in_block() {
        use crate::compute::aggregate::AggregateOp;
        let model = make_model_with_globals();

        // AVG(city_sales[Amount]) — references QUERY global via QualifiedColumnRef
        let expr = Expression::Aggregate {
            operation: AggregateOp::Average,
            operand: Box::new(Expression::QualifiedColumnRef {
                table_or_var: "city_sales".into(),
                column: "Amount".into(),
            }),
        };
        let expanded = expand_global_variables(&expr, &model);

        // Should be wrapped in a Block with the QUERY binding.
        match &expanded {
            Expression::Block { bindings, result } => {
                assert_eq!(bindings.len(), 1);
                assert_eq!(bindings[0].0, "city_sales");
                assert!(matches!(bindings[0].1, Expression::Query { .. }));
                assert!(matches!(result.as_ref(), Expression::Aggregate { .. }));
            }
            other => panic!("Expected Block, got {other:?}"),
        }
    }

    #[test]
    fn expand_no_globals_returns_unchanged() {
        let model = make_model_with_globals();
        // Expression with no global references.
        let expr = col("linetotal");
        let expanded = expand_global_variables(&expr, &model);
        assert_eq!(expanded.to_sql_string(), expr.to_sql_string());
    }

    #[test]
    fn expand_noop_when_model_has_no_globals() {
        use crate::model::column::Column;
        use crate::model::table::Table;
        use crate::types::DataType;

        let model = crate::model::schema::DataModel::builder()
            .add_table(Table::new("T", vec![Column::new("x", DataType::Int64)]).unwrap())
            .build()
            .unwrap();

        let expr = col("x");
        let expanded = expand_global_variables(&expr, &model);
        assert_eq!(expanded.to_sql_string(), expr.to_sql_string());
    }

    #[test]
    fn expand_existing_block_merges_query_bindings() {
        use crate::compute::aggregate::AggregateOp;
        let model = make_model_with_globals();

        // Existing block with a scalar VAR, referencing a QUERY global in result.
        let expr = Expression::Block {
            bindings: vec![("factor".into(), lit(2.0))],
            result: Box::new(Expression::Aggregate {
                operation: AggregateOp::Average,
                operand: Box::new(Expression::QualifiedColumnRef {
                    table_or_var: "city_sales".into(),
                    column: "Amount".into(),
                }),
            }),
        };
        let expanded = expand_global_variables(&expr, &model);

        match &expanded {
            Expression::Block { bindings, .. } => {
                // Should have city_sales QUERY binding + original factor binding.
                assert_eq!(bindings.len(), 2);
                let names: Vec<&str> = bindings.iter().map(|(n, _)| n.as_str()).collect();
                assert!(names.contains(&"city_sales"));
                assert!(names.contains(&"factor"));
            }
            other => panic!("Expected Block, got {other:?}"),
        }
    }

    // --- MeasureRef expansion tests ---

    #[test]
    fn expand_measure_ref_simple() {
        use crate::compute::aggregate::AggregateOp;
        use crate::compute::measure::Measure;
        use crate::model::column::Column;
        use crate::model::schema::DataModel;
        use crate::model::table::Table;
        use crate::types::DataType;

        let table = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("amount", DataType::Float64),
            ],
        )
        .unwrap();

        let total = Measure::new(
            "TotalSales",
            agg(AggregateOp::Sum, qualified_col("Sales", "amount")),
        );

        let ref_measure = Measure::new("RefMeasure", Expression::MeasureRef("TotalSales".into()));

        let model = DataModel::builder()
            .add_table(table)
            .add_measure(total)
            .add_measure(ref_measure)
            .build()
            .unwrap();

        let expr = model.measure("RefMeasure").unwrap().expression();
        let expanded = expand_measure_refs(expr, &model).unwrap();
        assert!(matches!(expanded, Expression::Aggregate { .. }));
    }

    #[test]
    fn expand_measure_ref_with_context() {
        use crate::compute::aggregate::AggregateOp;
        use crate::compute::measure::Measure;
        use crate::model::column::Column;
        use crate::model::schema::DataModel;
        use crate::model::table::Table;
        use crate::types::DataType;

        let table = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("amount", DataType::Float64),
            ],
        )
        .unwrap();

        let total = Measure::new(
            "TotalSales",
            agg(AggregateOp::Sum, qualified_col("Sales", "amount")),
        );

        // [TotalSales](USERELATIONSHIP("some_rel")) → UseRelationship wrapping expanded expr
        let ref_expr = use_relationship(Expression::MeasureRef("TotalSales".into()), "some_rel");
        let ref_measure = Measure::new("ShipSales", ref_expr);

        let model = DataModel::builder()
            .add_table(table)
            .add_measure(total)
            .add_measure(ref_measure)
            .build()
            .unwrap();

        let expr = model.measure("ShipSales").unwrap().expression();
        let expanded = expand_measure_refs(expr, &model).unwrap();
        // Should be UseRelationship { expr: Aggregate { Sum, ... }, ... }
        assert!(matches!(expanded, Expression::UseRelationship { .. }));
        if let Expression::UseRelationship { expr: inner, .. } = &expanded {
            assert!(matches!(**inner, Expression::Aggregate { .. }));
        }
    }

    #[test]
    fn expand_measure_ref_circular_detected() {
        use crate::compute::measure::Measure;
        use crate::model::column::Column;
        use crate::model::schema::DataModel;
        use crate::model::table::Table;
        use crate::types::DataType;

        let table = Table::new("T", vec![Column::new("x", DataType::Int64)]).unwrap();
        let m_a = Measure::new("A", Expression::MeasureRef("B".into()));
        let m_b = Measure::new("B", Expression::MeasureRef("A".into()));

        let result = DataModel::builder()
            .add_table(table)
            .add_measure(m_a)
            .add_measure(m_b)
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("circular"));
    }

    #[test]
    fn expand_measure_ref_missing_target() {
        use crate::compute::measure::Measure;
        use crate::model::column::Column;
        use crate::model::schema::DataModel;
        use crate::model::table::Table;
        use crate::types::DataType;

        let table = Table::new("T", vec![Column::new("x", DataType::Int64)]).unwrap();
        let m = Measure::new("A", Expression::MeasureRef("NonExistent".into()));

        let result = DataModel::builder().add_table(table).add_measure(m).build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("NonExistent"));
    }

    #[test]
    fn expand_measure_ref_chained() {
        use crate::compute::aggregate::AggregateOp;
        use crate::compute::measure::Measure;
        use crate::model::column::Column;
        use crate::model::schema::DataModel;
        use crate::model::table::Table;
        use crate::types::DataType;

        let table = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("amount", DataType::Float64),
            ],
        )
        .unwrap();

        let base = Measure::new(
            "Base",
            agg(AggregateOp::Sum, qualified_col("Sales", "amount")),
        );
        // Mid references Base
        let mid = Measure::new("Mid", Expression::MeasureRef("Base".into()));
        // Top references Mid
        let top = Measure::new("Top", Expression::MeasureRef("Mid".into()));

        let model = DataModel::builder()
            .add_table(table)
            .add_measure(base)
            .add_measure(mid)
            .add_measure(top)
            .build()
            .unwrap();

        let expanded =
            expand_measure_refs(model.measure("Top").unwrap().expression(), &model).unwrap();
        // Should fully expand to SUM(Sales.amount)
        assert!(matches!(expanded, Expression::Aggregate { .. }));
    }

    // --- Window expression tests ---

    #[test]
    fn window_has_aggregate() {
        let w = window_expr(
            agg(AggregateOp::Sum, qualified_col("fact", "amount")),
            AggregateOp::Sum,
            vec![("dim_date".into(), "month".into())],
            vec![],
            None,
        );
        assert!(w.has_aggregate());
        assert!(w.has_window());
        assert!(w.is_window());
    }

    #[test]
    fn window_not_simple_aggregate() {
        let w = window_expr(
            agg(AggregateOp::Sum, qualified_col("fact", "amount")),
            AggregateOp::Sum,
            vec![("dim_date".into(), "month".into())],
            vec![],
            None,
        );
        assert!(!w.is_simple_aggregate());
    }

    #[test]
    fn window_column_refs() {
        let w = window_expr(
            agg(AggregateOp::Sum, qualified_col("fact", "amount")),
            AggregateOp::Sum,
            vec![("dim_date".into(), "month".into())],
            vec![],
            None,
        );
        let refs = w.column_references();
        assert_eq!(refs, vec!["amount"]);
    }

    #[test]
    fn offset_basic() {
        let o = offset_expr(
            agg(AggregateOp::Sum, qualified_col("fact", "amount")),
            -1,
            vec![("dim".into(), "month".into())],
            vec![],
        );
        assert!(o.has_aggregate());
        assert!(o.has_window());
        assert!(o.is_window());
        assert!(!o.is_simple_aggregate());
    }

    #[test]
    fn index_basic() {
        let i = index_expr(
            agg(AggregateOp::Sum, qualified_col("fact", "amount")),
            1,
            vec![("dim".into(), "month".into())],
            vec![],
        );
        assert!(i.has_aggregate());
        assert!(i.has_window());
        assert!(i.is_window());
    }

    #[test]
    fn window_to_sql_placeholder() {
        let w = window_expr(
            agg(AggregateOp::Sum, qualified_col("fact", "amount")),
            AggregateOp::Sum,
            vec![("dim_date".into(), "month".into())],
            vec![],
            None,
        );
        assert!(w.to_sql_string().contains("WINDOW"));
    }

    #[test]
    fn window_context_filter_tables() {
        let w = window_expr(
            agg(AggregateOp::Sum, qualified_col("fact", "amount")),
            AggregateOp::Sum,
            vec![("dim_date".into(), "month".into())],
            vec![("dim_product".into(), "category".into())],
            None,
        );
        let tables = w.context_filter_tables();
        assert!(tables.contains(&"dim_date"));
        assert!(tables.contains(&"dim_product"));
    }

    #[test]
    fn window_infer_fact_table() {
        let w = window_expr(
            agg(AggregateOp::Sum, qualified_col("fact_sales", "amount")),
            AggregateOp::Sum,
            vec![("dim_date".into(), "month".into())],
            vec![],
            None,
        );
        assert_eq!(infer_fact_table(&w), Some("fact_sales".into()));
    }

    #[test]
    fn window_serialization_roundtrip() {
        let w = window_expr(
            agg(AggregateOp::Sum, qualified_col("fact", "amount")),
            AggregateOp::Sum,
            vec![("dim_date".into(), "month".into())],
            vec![("dim_product".into(), "cat".into())],
            Some(WindowFrame {
                from: -2,
                from_type: BoundaryType::Rel,
                to: 0,
                to_type: BoundaryType::Rel,
            }),
        );
        let json = serde_json::to_string(&w).unwrap();
        let deserialized: Expression = serde_json::from_str(&json).unwrap();
        if let Expression::Window {
            function,
            order_by,
            partition_by,
            frame,
            ..
        } = &deserialized
        {
            assert_eq!(*function, AggregateOp::Sum);
            assert_eq!(order_by.len(), 1);
            assert_eq!(partition_by.len(), 1);
            let f = frame.as_ref().unwrap();
            assert_eq!(f.from, -2);
        } else {
            panic!("expected Window after deserialization");
        }
    }
}
