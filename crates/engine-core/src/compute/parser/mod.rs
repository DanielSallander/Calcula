//! Measure expression parser — parses DAX-like text syntax into `Expression` trees.
//!
//! # Syntax
//!
//! ```text
//! // Column references
//! table[column]
//!
//! // Aggregation functions
//! SUM(table[column])
//! COUNT(table[column])
//! AVG(table[column])
//! MIN(table[column])
//! MAX(table[column])
//! DISTINCTCOUNT(table[column])
//!
//! // Arithmetic on aggregates
//! SUM(table[a]) / COUNT(table[b])
//! SUM(table[a]) + SUM(table[b])
//! (SUM(table[a]) - SUM(table[b])) * 100
//!
//! // Aggregation over arithmetic expressions
//! SUM(table[price] * table[quantity])
//!
//! // Context operations (additional arguments to aggregate)
//! SUM(table[amount], KEEP(dim, dim[year] = 2024))
//! SUM(table[amount], KEEP(dim, dim[year] = 2024, dim[month] = 1))
//! SUM(table[amount], CLEAR(dim))
//! SUM(table[amount], CLEAR(dim[column]))
//! SUM(table[amount], RESET())
//!
//! // Bare table variable names as context arguments
//! SUM(table[amount], bikes)
//! SUM(table[amount], bikes, year_2024)
//! SUM(table[amount], bikes, KEEP(dim, dim[year] = 2024))
//!
//! // Numeric literals
//! 42
//! 3.14
//!
//! // Host-registered UDF calls: any unrecognized name matching
//! // [A-Za-z_][A-Za-z0-9_]{0,63} parses as Expression::Call
//! MYFUNC(table[column], 2)
//! ```
//!
//! # Unknown function names
//!
//! Names the parser does not recognize as built-ins parse as UDF calls
//! ([`Expression::Call`]) when they match the call-identifier rule. This
//! means a typo in a built-in name (`SUMM(...)`) no longer fails at parse
//! time — it surfaces as an "unknown function or unregistered UDF" error at
//! validation / query time instead. Malformed names still produce a
//! positioned parse error.
//!
//! # Example
//!
//! ```
//! use engine_core::compute::parser::parse_measure_expression;
//!
//! let expr = parse_measure_expression("SUM(fact_sales[linetotal])").unwrap();
//! ```

use crate::compute::aggregate::AggregateOp;
use crate::compute::expression::{
    self as expr, infer_fact_table, ComparisonOp, DateTimeFunction, Expression, FilterPredicate,
    ScalarFunction, TextFunction, WindowFrame,
};
use crate::error::{EngineError, EngineResult};
use crate::model::context::{ClearTarget, ContextDefinition, ContextOp};
use crate::model::global_variable::GlobalVariable;

mod aggregates;
mod blocks;
mod conditions;
mod context;
mod functions;
mod grammar;
mod logic;
mod scope;
mod time;
mod tokenizer;
mod window;

use self::tokenizer::{tokenize, Token};

/// Maximum nesting depth for expression parsing.
///
/// Generous for real-world measures (which rarely nest beyond a dozen levels)
/// while staying far below native stack exhaustion. Without this limit, a
/// hostile model file (e.g. a `lookup_resolution` string of ~100k nested
/// parentheses, parsed lazily at query time) would overflow the stack and
/// abort the host process.
const MAX_PARSE_DEPTH: usize = 128;

struct Parser {
    tokens: Vec<Token>,
    /// Byte offset into the input text where each token starts (parallel to
    /// `tokens`). Used for error reporting.
    positions: Vec<usize>,
    /// Total byte length of the input text; reported as the position of
    /// end-of-input errors.
    input_len: usize,
    pos: usize,
    /// Current recursion depth, guarded by [`MAX_PARSE_DEPTH`].
    ///
    /// Each `Parser` is constructed fresh per input string, so the depth
    /// always starts at zero for every parse.
    depth: usize,
}

impl Parser {
    fn new(spanned_tokens: Vec<(Token, usize)>, input_len: usize) -> Self {
        let (tokens, positions) = spanned_tokens.into_iter().unzip();
        Self {
            tokens,
            positions,
            input_len,
            pos: 0,
            depth: 0,
        }
    }

    /// Byte offset of the token at `index`, or the input length when the
    /// index is past the last token (end-of-input).
    fn offset_at(&self, index: usize) -> usize {
        self.positions.get(index).copied().unwrap_or(self.input_len)
    }

    /// Build a [`EngineError::ParseError`] positioned at the current
    /// (next unconsumed) token, or at the end of the input when all tokens
    /// have been consumed.
    fn parse_err(&self, message: impl Into<String>) -> EngineError {
        EngineError::ParseError {
            position: self.offset_at(self.pos),
            message: message.into(),
        }
    }

    /// Build a [`EngineError::ParseError`] positioned at the most recently
    /// consumed token. Used when the offending token has already been
    /// consumed by `advance()`.
    fn parse_err_prev(&self, message: impl Into<String>) -> EngineError {
        EngineError::ParseError {
            position: self.offset_at(self.pos.saturating_sub(1)),
            message: message.into(),
        }
    }

    /// Increment the recursion depth, failing once nesting exceeds
    /// [`MAX_PARSE_DEPTH`].
    ///
    /// Called on entry to every parser function that can recurse back into
    /// itself: `parse_atom` (all grammar nesting — parenthesized expressions,
    /// function-call arguments, IF/SWITCH arms, context arguments, VAR/RETURN
    /// bindings and QUERY aggregates all re-enter through it) and
    /// `parse_condition` (direct self-recursion on AND/OR chains). Guarding
    /// these two choke points bounds native stack usage for arbitrary input.
    fn enter_recursion(&mut self) -> EngineResult<()> {
        if self.depth >= MAX_PARSE_DEPTH {
            return Err(self.parse_err(format!(
                "expression nesting too deep (max {MAX_PARSE_DEPTH} levels)"
            )));
        }
        self.depth += 1;
        Ok(())
    }

    /// Decrement the recursion depth on exit from a guarded parser function.
    fn exit_recursion(&mut self) {
        self.depth = self.depth.saturating_sub(1);
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }

    fn advance(&mut self) -> EngineResult<&Token> {
        if self.pos >= self.tokens.len() {
            return Err(self.parse_err("unexpected end of expression"));
        }
        let tok = &self.tokens[self.pos];
        self.pos += 1;
        Ok(tok)
    }

    fn expect(&mut self, expected: &Token) -> EngineResult<()> {
        let tok = self.advance()?.clone();
        if &tok != expected {
            return Err(self.parse_err_prev(format!("expected {expected:?}, got {tok:?}")));
        }
        Ok(())
    }

    fn at_end(&self) -> bool {
        self.pos >= self.tokens.len()
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

pub fn parse_measure_expression(input: &str) -> EngineResult<Expression> {
    let tokens = tokenize(input)?;
    if tokens.is_empty() {
        return Err(EngineError::ParseError {
            position: 0,
            message: "empty expression".into(),
        });
    }
    let mut parser = Parser::new(tokens, input.len());

    // Check for VAR/RETURN block syntax.
    if parser.peek_is_var() {
        let expr = parser.parse_var_return_block()?;
        if !parser.at_end() {
            return Err(parser.parse_err(format!(
                "unexpected token after RETURN expression: {:?}",
                parser.peek()
            )));
        }
        return Ok(expr);
    }

    let expr = parser.parse_expression()?;
    if !parser.at_end() {
        return Err(parser.parse_err(format!(
            "unexpected token after expression: {:?}",
            parser.peek()
        )));
    }
    Ok(expr)
}

/// Returns `true` when `name` (case-insensitively) is the name of a built-in
/// expression-language function — i.e. one the grammar dispatches to a
/// concrete [`Expression`] variant rather than emitting an
/// [`Expression::Call`](crate::compute::expression::Expression::Call) UDF call.
///
/// This is the authoritative built-in-name list: it mirrors the dispatch
/// `match` in `grammar::parse_function_call`, including every alias
/// (`COUNT_IF`/`COUNTIF`, `DATE_TRUNC`/`DATETRUNC`, …). It exists so that
/// model-level validation can reject a script function whose name shadows a
/// built-in — such a script would be dead code (the parser would always
/// dispatch the built-in before ever emitting a `Call` to it).
///
/// # Example
///
/// ```
/// use engine_core::compute::parser::is_builtin_function_name;
///
/// assert!(is_builtin_function_name("SUM"));
/// assert!(is_builtin_function_name("sum")); // case-insensitive
/// assert!(is_builtin_function_name("count_if")); // alias
/// assert!(!is_builtin_function_name("my_custom_fn"));
/// ```
pub fn is_builtin_function_name(name: &str) -> bool {
    // Kept in lock-step with the dispatch in
    // `grammar::Parser::parse_function_call`. Whenever a built-in is added
    // there, add its name(s) here so a colliding script is rejected.
    const BUILTINS: &[&str] = &[
        // Aggregates
        "SUM",
        "COUNT",
        "AVG",
        "AVERAGE",
        "MIN",
        "MAX",
        "DISTINCTCOUNT",
        "MEDIAN",
        "STDEV",
        "STDEVP",
        "VARIANCE",
        "VARIANCEP",
        "COUNTROWS",
        "COUNTIF",
        "COUNT_IF",
        "ANY_VALUE",
        "ANYVALUE",
        "MODE",
        "LISTAGG",
        "STRING_AGG",
        "MAX_BY",
        "MAXBY",
        "MIN_BY",
        "MINBY",
        // Context operations
        "KEEP",
        "CLEAR",
        "RESET",
        "CLEAR_INNER",
        "CLEARINNER",
        "CLEAR_OUTER",
        "CLEAROUTER",
        "RESET_INNER",
        "RESETINNER",
        "RESET_OUTER",
        "RESETOUTER",
        "USING",
        "USERELATIONSHIP",
        "CLEAREXCEPT",
        "CLEAR_EXCEPT",
        "ITERATE",
        // Logical
        "AND",
        "OR",
        "NOT",
        "TRUE",
        "FALSE",
        "XOR",
        // Conditional / null handling
        "IF",
        "SWITCH",
        "DIVIDE",
        "BLANK",
        "ISBLANK",
        "COALESCE",
        "GREATEST",
        "LEAST",
        "NULLIF",
        "IFERROR",
        // Table-producing / windowing
        "QUERY",
        "WINDOW",
        "OFFSET",
        "INDEX",
        "ROW_NUMBER",
        "ROWNUMBER",
        "RANK",
        "DENSE_RANK",
        "DENSERANK",
        // Time intelligence
        "YTD",
        "QTD",
        "MTD",
        "PRIORYEAR",
        "SAMEPERIODLASTYEAR",
        "PRIORPERIOD",
        // Value inspection
        "HASONEVALUE",
        "SELECTEDVALUE",
        "SELECTEDMEASURE",
        "FIRST",
        "ISINSCOPE",
        "PERCENTILE",
        // Scalar math
        "ABS",
        "ROUND",
        "ROUNDUP",
        "ROUNDDOWN",
        "INT",
        "TRUNC",
        "CEILING",
        "FLOOR",
        "MOD",
        "POWER",
        "SQRT",
        "LN",
        "LOG10",
        "SIGN",
        "EXP",
        "LOG",
        "PI",
        // Date/time
        "YEAR",
        "MONTH",
        "DAY",
        "QUARTER",
        "DATE",
        "DATEDIFF",
        "TODAY",
        "NOW",
        "DATEADD",
        "DATE_TRUNC",
        "DATETRUNC",
        "LAST_DAY",
        "LASTDAY",
        "EOMONTH",
        "DAYOFWEEK",
        "DAYOFYEAR",
        "WEEKNUM",
        "DAYNAME",
        "MONTHNAME",
        "MONTHS_BETWEEN",
        "MONTHSBETWEEN",
        // Text
        "CONCATENATE",
        "COMBINEVALUES",
        "EXACT",
        "FIND",
        "FIXED",
        "LEFT",
        "LEN",
        "LOWER",
        "MID",
        "REPLACE",
        "REPT",
        "RIGHT",
        "SEARCH",
        "SUBSTITUTE",
        "TRIM",
        "UNICHAR",
        "UNICODE",
        "UPPER",
        "VALUE",
        "LTRIM",
        "RTRIM",
        "LPAD",
        "RPAD",
        "REVERSE",
        "SPLIT",
        "FORMAT",
        "CONTAINS",
        "STARTSWITH",
        "ENDSWITH",
        "INITCAP",
    ];
    let upper = name.to_uppercase();
    BUILTINS.contains(&upper.as_str())
}

/// Parse a measure expression and infer the fact table from qualified column references.
///
/// Returns the parsed expression. Validates that a fact table can be inferred
/// from qualified column references; returns an error if not.
///
/// # Example
///
/// ```
/// use engine_core::compute::parser::parse_measure;
/// use engine_core::compute::expression::infer_fact_table;
///
/// let expr = parse_measure("SUM(fact_sales[linetotal])").unwrap();
/// assert_eq!(infer_fact_table(&expr), Some("fact_sales".to_string()));
/// ```
pub fn parse_measure(input: &str) -> EngineResult<Expression> {
    let expression = parse_measure_expression(input)?;
    if infer_fact_table(&expression).is_none() {
        return Err(EngineError::ParseError {
            position: 0,
            message: "cannot infer fact table — use table[column] syntax".into(),
        });
    }
    Ok(expression)
}

/// Parse a table variable definition from a `KEEP(source, filter, ...)` expression.
///
/// Returns `(source_table_or_variable, filters)`. The result can be used directly
/// to create a [`TableVariable`](crate::model::table_variable::TableVariable).
///
/// # Syntax
///
/// ```text
/// KEEP(dim_product, dim_product[categoryname] = "Bikes")
/// KEEP(bikes, dim_product[productline] = "R")
/// ```
///
/// # Example
///
/// ```
/// use engine_core::compute::parser::parse_table_variable;
///
/// let (source, filters) = parse_table_variable(
///     r#"KEEP(dim_product, dim_product[categoryname] = "Bikes")"#,
/// ).unwrap();
/// assert_eq!(source, "dim_product");
/// assert_eq!(filters.len(), 1);
/// assert_eq!(filters[0].column, "categoryname");
/// assert_eq!(filters[0].value, "Bikes");
/// ```
pub fn parse_table_variable(input: &str) -> EngineResult<(String, Vec<FilterPredicate>)> {
    let tokens = tokenize(input)?;
    if tokens.is_empty() {
        return Err(EngineError::ParseError {
            position: 0,
            message: "empty expression".into(),
        });
    }
    let mut parser = Parser::new(tokens, input.len());

    // Expect: KEEP ( source, filters... )
    match parser.advance()?.clone() {
        Token::Ident(ref name) if name.to_uppercase() == "KEEP" => {}
        tok => {
            return Err(parser.parse_err_prev(format!("expected KEEP(...), got {tok:?}")));
        }
    }
    parser.expect(&Token::LParen)?;

    // Source table or variable name.
    let source = match parser.advance()?.clone() {
        Token::Ident(s) => s,
        tok => {
            return Err(
                parser.parse_err_prev(format!("KEEP: expected source table name, got {tok:?}"))
            );
        }
    };

    // Parse filter predicates.
    let mut filters = Vec::new();
    while parser.peek() == Some(&Token::Comma) {
        parser.advance()?; // consume comma
        let filter = parser.parse_filter_predicate()?;
        filters.push(filter);
    }

    parser.expect(&Token::RParen)?;

    if !parser.at_end() {
        return Err(parser.parse_err(format!(
            "unexpected token after KEEP expression: {:?}",
            parser.peek()
        )));
    }

    Ok((source, filters))
}

/// Parse a named context definition from a text expression.
///
/// The input is the body after `CONTEXT name =`. It consists of
/// comma-separated context operations:
///
/// - `KEEP(table, filter1, filter2, ...)` — add filter predicates
/// - `CLEAR(table)` / `CLEAR(table[column])` — remove filters on dimensions
/// - `CLEAR_INNER(...)` / `CLEAR_OUTER(...)` — source-specific clear
/// - `RESET()` — remove all filters
/// - `RESET_INNER()` / `RESET_OUTER()` — source-specific reset
/// - bare name — inherit from another named context
///
/// # Example
///
/// ```
/// use engine_core::compute::parser::parse_context;
///
/// let ctx = parse_context(
///     "ctx_bikes",
///     r#"KEEP(dim_product, dim_product[categoryname] = "Bikes")"#,
/// ).unwrap();
/// assert_eq!(ctx.name(), "ctx_bikes");
/// assert_eq!(ctx.operations().len(), 1);
/// ```
///
/// Composed context with inheritance:
///
/// ```
/// use engine_core::compute::parser::parse_context;
///
/// let ctx = parse_context(
///     "ctx_bikes_2024",
///     r#"ctx_bikes, KEEP(dim_date, dim_date[year] = 2024)"#,
/// ).unwrap();
/// assert_eq!(ctx.name(), "ctx_bikes_2024");
/// assert_eq!(ctx.operations().len(), 2);
/// ```
pub fn parse_context(name: &str, input: &str) -> EngineResult<ContextDefinition> {
    let tokens = tokenize(input)?;
    if tokens.is_empty() {
        return Err(EngineError::ParseError {
            position: 0,
            message: "empty context definition".into(),
        });
    }
    let mut parser = Parser::new(tokens, input.len());
    let mut ops = Vec::new();

    loop {
        let op = parser.parse_context_op()?;
        ops.push(op);
        if parser.peek() != Some(&Token::Comma) {
            break;
        }
        parser.advance()?; // consume comma
    }

    if !parser.at_end() {
        return Err(parser.parse_err(format!(
            "unexpected token in context definition: {:?}",
            parser.peek()
        )));
    }

    Ok(ContextDefinition::new(name, ops))
}

/// Parse a global variable definition from a text expression.
///
/// The `name` and `table` are provided by the caller (typically from a UI form).
/// The `input` is the expression text, parsed using the same grammar as
/// `parse_measure_expression`.
///
/// # Examples
///
/// ```rust
/// use engine_core::compute::parser::parse_global;
///
/// // Scalar global:
/// let gv = parse_global("total_revenue", "fact_sales",
///     "SUM(fact_sales[linetotal])").unwrap();
/// assert!(!gv.is_query());
///
/// // Table (QUERY) global:
/// let gv = parse_global("city_sales", "fact_sales",
///     "QUERY(SUM(fact_sales[linetotal]) AS Amount BY dim_customer[city])").unwrap();
/// assert!(gv.is_query());
/// ```
pub fn parse_global(name: &str, table: &str, input: &str) -> EngineResult<GlobalVariable> {
    let expression = parse_measure_expression(input)?;
    Ok(GlobalVariable::new(name, table, expression))
}

/// Parse an incremental-refresh filter condition into a boolean
/// [`Expression`] tree.
///
/// Unlike [`parse_measure_expression`], this enters the parser through the
/// condition grammar, so top-level comparisons (`status <> "closed"`) and
/// `AND`/`OR` chains parse without being wrapped in a `KEEP`. The result is a
/// boolean expression tree (a [`Comparison`](Expression::Comparison), or an
/// [`And`](Expression::And) / [`Or`](Expression::Or) of comparisons).
///
/// This only handles the *syntax*; the semantic restriction to an
/// AND-of-simple-comparisons over constant-foldable right-hand sides is
/// enforced by the model builder and the incremental-refresh planner (see
/// [`crate::compute::incremental`]).
///
/// # Example
///
/// ```
/// use engine_core::compute::parser::parse_refresh_filter;
///
/// let expr = parse_refresh_filter("order_date >= DATEADD(TODAY(), -7, \"DAY\")").unwrap();
/// assert!(matches!(expr, engine_core::compute::expression::Expression::Comparison { .. }));
/// ```
pub fn parse_refresh_filter(input: &str) -> EngineResult<Expression> {
    let tokens = tokenize(input)?;
    if tokens.is_empty() {
        return Err(EngineError::ParseError {
            position: 0,
            message: "empty refresh filter".into(),
        });
    }
    let mut parser = Parser::new(tokens, input.len());
    let expr = parser.parse_condition()?;
    if !parser.at_end() {
        return Err(parser.parse_err(format!(
            "unexpected token after refresh filter: {:?}",
            parser.peek()
        )));
    }
    Ok(expr)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_measure_infers_table() {
        let expr = parse_measure("SUM(fact_sales[linetotal])").unwrap();
        assert_eq!(infer_fact_table(&expr), Some("fact_sales".to_string()));
    }

    #[test]
    fn parse_measure_infers_from_ratio() {
        let expr = parse_measure("SUM(Sales[amount]) / COUNT(Sales[id])").unwrap();
        assert_eq!(infer_fact_table(&expr), Some("Sales".to_string()));
    }

    #[test]
    fn empty_input_returns_error() {
        assert!(parse_measure_expression("").is_err());
    }

    // --- Table variable parsing tests ---

    #[test]
    fn parse_table_variable_simple() {
        let (source, filters) =
            parse_table_variable(r#"KEEP(dim_product, dim_product[categoryname] = "Bikes")"#)
                .unwrap();
        assert_eq!(source, "dim_product");
        assert_eq!(filters.len(), 1);
        assert_eq!(filters[0].table, "dim_product");
        assert_eq!(filters[0].column, "categoryname");
        assert_eq!(filters[0].operator, ComparisonOp::Equal);
        assert_eq!(filters[0].value, "Bikes");
    }

    #[test]
    fn parse_table_variable_composable() {
        let (source, filters) =
            parse_table_variable(r#"KEEP(bikes, dim_product[productline] = "R")"#).unwrap();
        assert_eq!(source, "bikes");
        assert_eq!(filters.len(), 1);
        assert_eq!(filters[0].column, "productline");
    }

    #[test]
    fn parse_table_variable_multiple_filters() {
        let (source, filters) = parse_table_variable(
            r#"KEEP(dim_product, dim_product[categoryname] = "Bikes", dim_product[color] = "Red")"#,
        )
        .unwrap();
        assert_eq!(source, "dim_product");
        assert_eq!(filters.len(), 2);
        assert_eq!(filters[0].column, "categoryname");
        assert_eq!(filters[1].column, "color");
    }

    #[test]
    fn parse_table_variable_no_filters() {
        let (source, filters) = parse_table_variable("KEEP(dim_product)").unwrap();
        assert_eq!(source, "dim_product");
        assert!(filters.is_empty());
    }

    #[test]
    fn parse_table_variable_comparison_ops() {
        let (source, filters) =
            parse_table_variable("KEEP(dim_product, dim_product[listprice] > 1000)").unwrap();
        assert_eq!(source, "dim_product");
        assert_eq!(filters[0].operator, ComparisonOp::GreaterThan);
        assert_eq!(filters[0].value, "1000");
    }

    #[test]
    fn parse_table_variable_rejects_non_keep() {
        let err = parse_table_variable("SUM(Sales[amount])");
        assert!(err.is_err());
    }

    #[test]
    fn parse_table_variable_rejects_trailing_tokens() {
        let err = parse_table_variable(r#"KEEP(dim_product, dim_product[cat] = "X") + 1"#);
        assert!(err.is_err());
    }

    // --- parse_global tests ---

    #[test]
    fn parse_global_scalar() {
        let gv = parse_global("rev", "fact_sales", "SUM(fact_sales[linetotal])").unwrap();
        assert_eq!(gv.name(), "rev");
        assert_eq!(gv.table(), "fact_sales");
        assert!(!gv.is_query());
    }

    #[test]
    fn parse_global_query() {
        let gv = parse_global(
            "city_sales",
            "fact_sales",
            "QUERY(SUM(fact_sales[linetotal]) AS Amount BY dim_customer[city])",
        )
        .unwrap();
        assert_eq!(gv.name(), "city_sales");
        assert!(gv.is_query());
    }

    #[test]
    fn parse_global_var_return() {
        let gv = parse_global(
            "pct",
            "fact_sales",
            "VAR total = SUM(fact_sales[linetotal]) RETURN total / COUNTROWS(fact_sales)",
        )
        .unwrap();
        assert_eq!(gv.name(), "pct");
        assert!(!gv.is_query());
    }

    #[test]
    fn parse_global_invalid_expression() {
        let result = parse_global("bad", "t", "INVALID(((");
        assert!(result.is_err());
    }

    // -----------------------------------------------------------------------
    // ParseError variant and position reporting
    // -----------------------------------------------------------------------

    #[test]
    fn syntax_error_returns_parse_error_variant() {
        let err = parse_measure_expression("SUM(t[col] +").unwrap_err();
        assert!(
            matches!(err, EngineError::ParseError { .. }),
            "expected ParseError, got {err:?}"
        );
    }

    #[test]
    fn truncated_expression_reports_position_at_end_of_input() {
        let input = "SUM(t[col] +";
        let err = parse_measure_expression(input).unwrap_err();
        match err {
            EngineError::ParseError { position, message } => {
                assert_eq!(position, input.len());
                assert!(message.contains("unexpected end of expression"));
            }
            other => panic!("expected ParseError, got {other:?}"),
        }
    }

    #[test]
    fn unknown_function_reports_position_of_function_name() {
        // A malformed (non-ASCII) function name cannot be a UDF call — it
        // must keep the positioned "unknown function" parse error. (Names
        // matching the identifier rule parse as `Expression::Call` instead.)
        let input = "1 + BÖGUS(t[a])";
        let err = parse_measure_expression(input).unwrap_err();
        match err {
            EngineError::ParseError { position, message } => {
                assert_eq!(position, 4, "position should point at 'BÖGUS'");
                assert!(message.contains("unknown function: BÖGUS"));
            }
            other => panic!("expected ParseError, got {other:?}"),
        }
    }

    #[test]
    fn unexpected_character_reports_its_position() {
        let input = "SUM(t[a]) ; 1";
        let err = parse_measure_expression(input).unwrap_err();
        match err {
            EngineError::ParseError { position, message } => {
                assert_eq!(position, 10, "position should point at ';'");
                assert!(message.contains("unexpected character"));
            }
            other => panic!("expected ParseError, got {other:?}"),
        }
    }

    #[test]
    fn unterminated_string_reports_opening_quote_position() {
        let input = "SUM(t[a]) + \"abc";
        let err = parse_measure_expression(input).unwrap_err();
        match err {
            EngineError::ParseError { position, message } => {
                assert_eq!(position, 12, "position should point at the opening quote");
                assert!(message.contains("unterminated string literal"));
            }
            other => panic!("expected ParseError, got {other:?}"),
        }
    }

    #[test]
    fn token_mismatch_reports_offending_token_position() {
        let input = "SUM(t[a] 5)";
        let err = parse_measure_expression(input).unwrap_err();
        match err {
            EngineError::ParseError { position, .. } => {
                assert_eq!(position, 9, "position should point at the stray '5'");
            }
            other => panic!("expected ParseError, got {other:?}"),
        }
    }

    #[test]
    fn trailing_tokens_report_position_of_first_extra_token() {
        let input = "SUM(t[a]) 42";
        let err = parse_measure_expression(input).unwrap_err();
        match err {
            EngineError::ParseError { position, message } => {
                assert_eq!(position, 10, "position should point at '42'");
                assert!(message.contains("unexpected token after expression"));
            }
            other => panic!("expected ParseError, got {other:?}"),
        }
    }

    #[test]
    fn position_is_byte_offset_for_multibyte_input() {
        // 'å' is 2 bytes in UTF-8, so the ';' sits at byte offset 9 even
        // though it is the 9th character (char index 8).
        let input = "SUM(å[a];";
        let err = parse_measure_expression(input).unwrap_err();
        match err {
            EngineError::ParseError { position, message } => {
                assert_eq!(
                    position, 9,
                    "position must be a byte offset, not a char index"
                );
                assert!(message.contains("unexpected character"));
            }
            other => panic!("expected ParseError, got {other:?}"),
        }
    }

    #[test]
    fn empty_input_reports_parse_error_at_position_zero() {
        let err = parse_measure_expression("").unwrap_err();
        match err {
            EngineError::ParseError { position, message } => {
                assert_eq!(position, 0);
                assert!(message.contains("empty expression"));
            }
            other => panic!("expected ParseError, got {other:?}"),
        }
    }

    #[test]
    fn reserved_var_name_reports_parse_error_variant() {
        let err =
            parse_measure_expression("VAR RETURN = SUM(Sales[amount]) RETURN RETURN").unwrap_err();
        assert!(
            matches!(err, EngineError::ParseError { .. }),
            "expected ParseError, got {err:?}"
        );
    }

    #[test]
    fn depth_guard_reports_parse_error_variant() {
        let n = 100_000;
        let input = format!("{}1{}", "(".repeat(n), ")".repeat(n));
        let err = parse_measure_expression(&input).unwrap_err();
        assert!(
            matches!(err, EngineError::ParseError { .. }),
            "expected ParseError, got {err:?}"
        );
    }
}
