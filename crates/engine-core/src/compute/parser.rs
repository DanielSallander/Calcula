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
//! ```
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

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Token {
    /// An identifier (table name, function name, etc.)
    Ident(String),
    /// A numeric literal (integer or float)
    Number(f64),
    /// A string literal (quoted with double quotes)
    StringLit(String),
    /// `[`
    LBracket,
    /// `]`
    RBracket,
    /// `(`
    LParen,
    /// `)`
    RParen,
    /// `,`
    Comma,
    /// `+`
    Plus,
    /// `-`
    Minus,
    /// `*`
    Star,
    /// `/`
    Slash,
    /// `=`
    Eq,
    /// `!=`
    Neq,
    /// `>`
    Gt,
    /// `>=`
    Gte,
    /// `<`
    Lt,
    /// `<=`
    Lte,
    /// `{`
    LBrace,
    /// `}`
    RBrace,
}

fn tokenize(input: &str) -> EngineResult<Vec<Token>> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = input.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        let c = chars[i];

        // Skip whitespace.
        if c.is_whitespace() {
            i += 1;
            continue;
        }

        match c {
            '[' => {
                tokens.push(Token::LBracket);
                i += 1;
            }
            ']' => {
                tokens.push(Token::RBracket);
                i += 1;
            }
            '(' => {
                tokens.push(Token::LParen);
                i += 1;
            }
            ')' => {
                tokens.push(Token::RParen);
                i += 1;
            }
            ',' => {
                tokens.push(Token::Comma);
                i += 1;
            }
            '{' => {
                tokens.push(Token::LBrace);
                i += 1;
            }
            '}' => {
                tokens.push(Token::RBrace);
                i += 1;
            }
            '+' => {
                tokens.push(Token::Plus);
                i += 1;
            }
            '-' => {
                tokens.push(Token::Minus);
                i += 1;
            }
            '*' => {
                tokens.push(Token::Star);
                i += 1;
            }
            '/' => {
                tokens.push(Token::Slash);
                i += 1;
            }
            '=' => {
                tokens.push(Token::Eq);
                i += 1;
            }
            '!' if i + 1 < len && chars[i + 1] == '=' => {
                tokens.push(Token::Neq);
                i += 2;
            }
            '>' if i + 1 < len && chars[i + 1] == '=' => {
                tokens.push(Token::Gte);
                i += 2;
            }
            '>' => {
                tokens.push(Token::Gt);
                i += 1;
            }
            '<' if i + 1 < len && chars[i + 1] == '=' => {
                tokens.push(Token::Lte);
                i += 2;
            }
            '<' => {
                tokens.push(Token::Lt);
                i += 1;
            }
            '"' => {
                // String literal.
                i += 1;
                let start = i;
                while i < len && chars[i] != '"' {
                    i += 1;
                }
                if i >= len {
                    return Err(EngineError::InvalidData(
                        "unterminated string literal".into(),
                    ));
                }
                let s: String = chars[start..i].iter().collect();
                tokens.push(Token::StringLit(s));
                i += 1; // skip closing quote
            }
            _ if c.is_ascii_digit() || c == '.' => {
                // Number literal.
                let start = i;
                while i < len && (chars[i].is_ascii_digit() || chars[i] == '.') {
                    i += 1;
                }
                let num_str: String = chars[start..i].iter().collect();
                let val: f64 = num_str
                    .parse()
                    .map_err(|_| EngineError::InvalidData(format!("invalid number: {num_str}")))?;
                tokens.push(Token::Number(val));
            }
            _ if c.is_alphanumeric() || c == '_' => {
                // Identifier.
                let start = i;
                while i < len && (chars[i].is_alphanumeric() || chars[i] == '_') {
                    i += 1;
                }
                let ident: String = chars[start..i].iter().collect();
                tokens.push(Token::Ident(ident));
            }
            _ => {
                return Err(EngineError::InvalidData(format!(
                    "unexpected character: '{c}'"
                )));
            }
        }
    }

    Ok(tokens)
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}

impl Parser {
    fn new(tokens: Vec<Token>) -> Self {
        Self { tokens, pos: 0 }
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }

    fn advance(&mut self) -> EngineResult<&Token> {
        if self.pos >= self.tokens.len() {
            return Err(EngineError::InvalidData(
                "unexpected end of expression".into(),
            ));
        }
        let tok = &self.tokens[self.pos];
        self.pos += 1;
        Ok(tok)
    }

    fn expect(&mut self, expected: &Token) -> EngineResult<()> {
        let tok = self.advance()?.clone();
        if &tok != expected {
            return Err(EngineError::InvalidData(format!(
                "expected {expected:?}, got {tok:?}"
            )));
        }
        Ok(())
    }

    fn at_end(&self) -> bool {
        self.pos >= self.tokens.len()
    }

    /// Parse a full expression (top level): handles `+`, `-` (additive).
    fn parse_expression(&mut self) -> EngineResult<Expression> {
        let mut left = self.parse_term()?;

        while let Some(tok) = self.peek() {
            match tok {
                Token::Plus => {
                    self.advance()?;
                    let right = self.parse_term()?;
                    left = left.add(right);
                }
                Token::Minus => {
                    self.advance()?;
                    let right = self.parse_term()?;
                    left = left.subtract(right);
                }
                _ => break,
            }
        }

        Ok(left)
    }

    /// Parse a term: handles `*`, `/` (multiplicative).
    fn parse_term(&mut self) -> EngineResult<Expression> {
        let mut left = self.parse_atom()?;

        while let Some(tok) = self.peek() {
            match tok {
                Token::Star => {
                    self.advance()?;
                    let right = self.parse_atom()?;
                    left = left.multiply(right);
                }
                Token::Slash => {
                    self.advance()?;
                    let right = self.parse_atom()?;
                    left = left.divide(right);
                }
                _ => break,
            }
        }

        Ok(left)
    }

    /// Parse an atom: number, string, parenthesized expression, column ref, or function call.
    fn parse_atom(&mut self) -> EngineResult<Expression> {
        match self.peek().cloned() {
            Some(Token::Number(n)) => {
                self.advance()?;
                // Decide int vs float.
                if n.fract() == 0.0 && n.abs() < i64::MAX as f64 {
                    Ok(expr::lit_int(n as i64))
                } else {
                    Ok(expr::lit(n))
                }
            }
            Some(Token::StringLit(s)) => {
                self.advance()?;
                Ok(expr::lit_str(s))
            }
            Some(Token::LParen) => {
                self.advance()?;
                let inner = self.parse_expression()?;
                self.expect(&Token::RParen)?;
                Ok(inner)
            }
            Some(Token::Ident(_)) => self.parse_ident_or_call(),
            Some(Token::LBracket) => self.parse_measure_ref(),
            Some(tok) => Err(EngineError::InvalidData(format!(
                "unexpected token: {tok:?}"
            ))),
            None => Err(EngineError::InvalidData(
                "unexpected end of expression".into(),
            )),
        }
    }

    /// Parse an identifier which could be:
    /// - A function call: `SUM(...)`, `KEEP(...)`, etc.
    /// - A column reference: `table[column]`
    fn parse_ident_or_call(&mut self) -> EngineResult<Expression> {
        let ident = match self.advance()?.clone() {
            Token::Ident(s) => s,
            tok => {
                return Err(EngineError::InvalidData(format!(
                    "expected identifier, got {tok:?}"
                )));
            }
        };

        let upper = ident.to_uppercase();

        // Check for function call: ident followed by `(`.
        if self.peek() == Some(&Token::LParen) {
            return self.parse_function_call(&ident, &upper);
        }

        // Check for column reference: ident followed by `[`.
        if self.peek() == Some(&Token::LBracket) {
            return self.parse_column_ref(&ident);
        }

        // Bare TRUE / FALSE — boolean literals without parentheses.
        if upper == "TRUE" {
            return Ok(expr::lit_bool(true));
        }
        if upper == "FALSE" {
            return Ok(expr::lit_bool(false));
        }

        // Bare identifier — treat as column name (unqualified).
        Ok(expr::col(&ident))
    }

    /// Parse `table[column]`.
    fn parse_column_ref(&mut self, table: &str) -> EngineResult<Expression> {
        self.expect(&Token::LBracket)?;
        let column = match self.advance()?.clone() {
            Token::Ident(s) => s,
            tok => {
                return Err(EngineError::InvalidData(format!(
                    "expected column name, got {tok:?}"
                )));
            }
        };
        self.expect(&Token::RBracket)?;
        Ok(expr::qualified_col(table, &column))
    }

    /// Parse a function call: aggregate, context op, scalar, conditional, etc.
    fn parse_function_call(&mut self, name: &str, upper: &str) -> EngineResult<Expression> {
        self.expect(&Token::LParen)?;

        match upper {
            "SUM" | "COUNT" | "AVG" | "AVERAGE" | "MIN" | "MAX" | "DISTINCTCOUNT" | "MEDIAN"
            | "STDEV" | "STDEVP" | "VARIANCE" | "VARIANCEP" => self.parse_aggregate_call(upper),
            "COUNTROWS" => self.parse_countrows_call(),
            "KEEP" => self.parse_keep_call(),
            "CLEAR" => self.parse_clear_call(),
            "RESET" => self.parse_reset_call(),
            "CLEAR_INNER" | "CLEARINNER" => self.parse_clear_inner_call(),
            "CLEAR_OUTER" | "CLEAROUTER" => self.parse_clear_outer_call(),
            "RESET_INNER" | "RESETINNER" => self.parse_reset_inner_call(),
            "RESET_OUTER" | "RESETOUTER" => self.parse_reset_outer_call(),
            "USING" => self.parse_using_call(),
            "USERELATIONSHIP" => self.parse_use_relationship_call(),
            // Logical functions (function-call syntax)
            "AND" => self.parse_and_call(),
            "OR" => self.parse_or_call(),
            "NOT" => self.parse_not_call(),
            "TRUE" => self.parse_true_call(),
            "FALSE" => self.parse_false_call(),
            "XOR" => self.parse_xor_call(),
            // Conditional / null handling
            "IF" => self.parse_if_call(),
            "SWITCH" => self.parse_switch_call(),
            "DIVIDE" => self.parse_divide_call(),
            "BLANK" => self.parse_blank_call(),
            "ISBLANK" => self.parse_isblank_call(),
            "COALESCE" => self.parse_coalesce_call(),
            // Table-producing query
            "QUERY" => self.parse_query_call(),
            // Window functions
            "WINDOW" => self.parse_window_call(),
            "OFFSET" => self.parse_offset_call(),
            "INDEX" => self.parse_index_call(),
            // Value inspection functions
            "HASONEVALUE" => self.parse_hasonevalue_call(),
            "SELECTEDVALUE" => self.parse_selectedvalue_call(),
            "FIRST" => self.parse_first_call(),
            // Scalar math functions
            "ABS" => self.parse_scalar_call(ScalarFunction::Abs, 1),
            "ROUND" => self.parse_scalar_call(ScalarFunction::Round, 2),
            "ROUNDUP" => self.parse_scalar_call(ScalarFunction::RoundUp, 2),
            "ROUNDDOWN" => self.parse_scalar_call(ScalarFunction::RoundDown, 2),
            "INT" => self.parse_scalar_call(ScalarFunction::Int, 1),
            "TRUNC" => self.parse_scalar_call(ScalarFunction::Trunc, 1),
            "CEILING" => self.parse_scalar_call(ScalarFunction::Ceiling, 1),
            "FLOOR" => self.parse_scalar_call(ScalarFunction::Floor, 1),
            "MOD" => self.parse_scalar_call(ScalarFunction::Mod, 2),
            "POWER" => self.parse_scalar_call(ScalarFunction::Power, 2),
            "SQRT" => self.parse_scalar_call(ScalarFunction::Sqrt, 1),
            "LN" => self.parse_scalar_call(ScalarFunction::Ln, 1),
            "LOG10" => self.parse_scalar_call(ScalarFunction::Log10, 1),
            "SIGN" => self.parse_scalar_call(ScalarFunction::Sign, 1),
            "EXP" => self.parse_scalar_call(ScalarFunction::Exp, 1),
            "LOG" => self.parse_scalar_call(ScalarFunction::Log, 1),
            "PI" => self.parse_scalar_call(ScalarFunction::Pi, 0),
            // Date/time functions
            "YEAR" => self.parse_datetime_call(DateTimeFunction::Year, 1),
            "MONTH" => self.parse_datetime_call(DateTimeFunction::Month, 1),
            "DAY" => self.parse_datetime_call(DateTimeFunction::Day, 1),
            "QUARTER" => self.parse_datetime_call(DateTimeFunction::Quarter, 1),
            "DATE" => self.parse_datetime_call(DateTimeFunction::Date, 3),
            "DATEDIFF" => self.parse_datediff_call(),
            "TODAY" => self.parse_datetime_call(DateTimeFunction::Today, 0),
            "NOW" => self.parse_datetime_call(DateTimeFunction::Now, 0),
            // Error handling
            "IFERROR" => self.parse_iferror_call(),
            // Scope check
            "ISINSCOPE" => self.parse_isinscope_call(),
            // Context operations
            "CLEAREXCEPT" | "CLEAR_EXCEPT" => self.parse_clearexcept_call(),
            // Iterator
            "ITERATE" => self.parse_iterate_call(),
            // Percentile
            "PERCENTILE" => self.parse_percentile_call(),
            // Text functions
            "CONCATENATE" => self.parse_text_call(TextFunction::Concatenate, 1),
            "COMBINEVALUES" => self.parse_text_call(TextFunction::CombineValues, 2),
            "EXACT" => self.parse_text_call(TextFunction::Exact, 2),
            "FIND" => self.parse_text_call(TextFunction::Find, 2),
            "FIXED" => self.parse_text_call(TextFunction::Fixed, 1),
            "LEFT" => self.parse_text_call(TextFunction::Left, 1),
            "LEN" => self.parse_text_call(TextFunction::Len, 1),
            "LOWER" => self.parse_text_call(TextFunction::Lower, 1),
            "MID" => self.parse_text_call(TextFunction::Mid, 3),
            "REPLACE" => self.parse_text_call(TextFunction::Replace, 4),
            "REPT" => self.parse_text_call(TextFunction::Rept, 2),
            "RIGHT" => self.parse_text_call(TextFunction::Right, 1),
            "SEARCH" => self.parse_text_call(TextFunction::Search, 2),
            "SUBSTITUTE" => self.parse_text_call(TextFunction::Substitute, 3),
            "TRIM" => self.parse_text_call(TextFunction::Trim, 1),
            "UNICHAR" => self.parse_text_call(TextFunction::Unichar, 1),
            "UNICODE" => self.parse_text_call(TextFunction::Unicode, 1),
            "UPPER" => self.parse_text_call(TextFunction::Upper, 1),
            "VALUE" => self.parse_text_call(TextFunction::Value, 1),
            "LTRIM" => self.parse_text_call(TextFunction::Ltrim, 1),
            "RTRIM" => self.parse_text_call(TextFunction::Rtrim, 1),
            "LPAD" => self.parse_text_call(TextFunction::Lpad, 2),
            "RPAD" => self.parse_text_call(TextFunction::Rpad, 2),
            "REVERSE" => self.parse_text_call(TextFunction::Reverse, 1),
            "SPLIT" => self.parse_text_call(TextFunction::Split, 3),
            "FORMAT" => self.parse_text_call(TextFunction::Format, 2),
            _ => Err(EngineError::InvalidData(format!(
                "unknown function: {name}"
            ))),
        }
    }

    /// Parse aggregate: `SUM(operand)` or `SUM(operand, context_op)`.
    fn parse_aggregate_call(&mut self, func_upper: &str) -> EngineResult<Expression> {
        let op = match func_upper {
            "SUM" => AggregateOp::Sum,
            "COUNT" => AggregateOp::Count,
            "AVG" | "AVERAGE" => AggregateOp::Average,
            "MIN" => AggregateOp::Min,
            "MAX" => AggregateOp::Max,
            "DISTINCTCOUNT" => AggregateOp::DistinctCount,
            "MEDIAN" => AggregateOp::Median,
            "STDEV" => AggregateOp::StdevSample,
            "STDEVP" => AggregateOp::StdevPop,
            "VARIANCE" => AggregateOp::VarSample,
            "VARIANCEP" => AggregateOp::VarPop,
            _ => unreachable!(),
        };

        // Parse the operand expression (could be `table[col]` or arithmetic like `table[a] * table[b]`).
        let operand = self.parse_expression()?;

        // Check for optional context arguments (variables and/or context ops).
        // Supports multiple comma-separated args:
        //   SUM(t[x], bikes)                     — bare variable name
        //   SUM(t[x], bikes, year_2024)           — multiple variables
        //   SUM(t[x], KEEP(dim, dim[y] = 2024))   — explicit context op
        //   SUM(t[x], bikes, KEEP(dim, dim[y] = 2024)) — mixed
        if self.peek() == Some(&Token::Comma) {
            let mut result = expr::agg(op, operand);
            while self.peek() == Some(&Token::Comma) {
                self.advance()?; // consume comma
                let context_arg = self.parse_context_arg()?;
                result = wrap_context_op(result, context_arg)?;
            }
            self.expect(&Token::RParen)?;
            Ok(result)
        } else {
            self.expect(&Token::RParen)?;
            Ok(expr::agg(op, operand))
        }
    }

    /// Parse a context argument inside an aggregate call.
    ///
    /// This can be:
    /// - A bare identifier (table variable name): `bikes` → `TableRef("bikes")`
    /// - A context function call: `KEEP(...)`, `CLEAR(...)`, `RESET(...)`, etc.
    fn parse_context_arg(&mut self) -> EngineResult<Expression> {
        match self.peek().cloned() {
            Some(Token::Ident(ref name)) => {
                let upper = name.to_uppercase();
                // If followed by `(`, it's a function call (KEEP, CLEAR, etc.)
                // Check by looking at position + 1.
                let is_func = matches!(
                    upper.as_str(),
                    "KEEP"
                        | "CLEAR"
                        | "CLEAR_INNER"
                        | "CLEAR_OUTER"
                        | "CLEAREXCEPT"
                        | "CLEAR_EXCEPT"
                        | "RESET"
                        | "RESET_INNER"
                        | "RESET_OUTER"
                        | "USING"
                        | "USERELATIONSHIP"
                );
                if is_func {
                    // Delegate to the normal atom parser which handles function calls.
                    self.parse_atom()
                } else {
                    // Bare identifier — table variable reference.
                    let name = name.clone();
                    self.advance()?; // consume identifier
                    Ok(expr::table_ref(name))
                }
            }
            Some(tok) => Err(EngineError::InvalidData(format!(
                "expected variable name or context function, got {tok:?}"
            ))),
            None => Err(EngineError::InvalidData(
                "unexpected end of expression after comma in aggregate".into(),
            )),
        }
    }

    /// Parse `KEEP(table, table[col] = value, ...)`.
    /// Parse a boolean condition: `expr op expr` with optional AND/OR.
    ///
    /// This extends `parse_expression` with comparison and logical operators,
    /// used for KEEP condition arguments.
    fn parse_condition(&mut self) -> EngineResult<Expression> {
        let left = self.parse_expression()?;

        // Check for IN keyword: `table[col] IN {val1, val2}` or `table[col] IN var[col]`.
        if matches!(self.peek().cloned(), Some(Token::Ident(ref s)) if s.eq_ignore_ascii_case("IN"))
        {
            self.advance()?; // consume IN
            return self.parse_in_rhs(left);
        }

        // Check for comparison operator.
        let op = match self.peek() {
            Some(Token::Eq) => Some(ComparisonOp::Equal),
            Some(Token::Neq) => Some(ComparisonOp::NotEqual),
            Some(Token::Gt) => Some(ComparisonOp::GreaterThan),
            Some(Token::Gte) => Some(ComparisonOp::GreaterThanOrEqual),
            Some(Token::Lt) => Some(ComparisonOp::LessThan),
            Some(Token::Lte) => Some(ComparisonOp::LessThanOrEqual),
            _ => None,
        };

        if let Some(op) = op {
            self.advance()?; // consume operator
            let right = self.parse_expression()?;
            let comparison = Expression::Comparison {
                left: Box::new(left),
                op,
                right: Box::new(right),
            };

            // Check for AND/OR chaining.
            match self.peek().cloned() {
                Some(Token::Ident(ref s)) if s.eq_ignore_ascii_case("AND") => {
                    self.advance()?;
                    let right_cond = self.parse_condition()?;
                    Ok(Expression::And(Box::new(comparison), Box::new(right_cond)))
                }
                Some(Token::Ident(ref s)) if s.eq_ignore_ascii_case("OR") => {
                    self.advance()?;
                    let right_cond = self.parse_condition()?;
                    Ok(Expression::Or(Box::new(comparison), Box::new(right_cond)))
                }
                _ => Ok(comparison),
            }
        } else {
            Ok(left)
        }
    }

    /// Parse the right-hand side of an IN expression.
    ///
    /// Two forms:
    /// - `{val1, val2, ...}` → InList expression (literal value set)
    /// - `var[col]` → InPredicate (membership in table variable)
    fn parse_in_rhs(&mut self, left: Expression) -> EngineResult<Expression> {
        if self.peek() == Some(&Token::LBrace) {
            // Literal value list: {val1, val2, ...}
            self.advance()?; // consume {
            let mut values = Vec::new();
            loop {
                let val = self.parse_expression()?;
                values.push(val);
                if self.peek() == Some(&Token::Comma) {
                    self.advance()?;
                } else {
                    break;
                }
            }
            self.expect(&Token::RBrace)?;

            if values.is_empty() {
                return Err(EngineError::InvalidData(
                    "IN list must contain at least one value".into(),
                ));
            }

            Ok(Expression::InList {
                expr: Box::new(left),
                values,
            })
        } else {
            // Variable reference: var[col]
            // Left must be QualifiedColumnRef.
            let (table, column) = match &left {
                Expression::QualifiedColumnRef {
                    table_or_var,
                    column,
                } => (table_or_var.clone(), column.clone()),
                _ => {
                    return Err(EngineError::InvalidData(
                        "IN with variable requires table[column] on both sides".into(),
                    ));
                }
            };

            let var_name = match self.advance()?.clone() {
                Token::Ident(s) => s,
                tok => {
                    return Err(EngineError::InvalidData(format!(
                        "IN: expected variable name, got {tok:?}"
                    )));
                }
            };
            self.expect(&Token::LBracket)?;
            let var_column = match self.advance()?.clone() {
                Token::Ident(s) => s,
                tok => {
                    return Err(EngineError::InvalidData(format!(
                        "IN: expected column name, got {tok:?}"
                    )));
                }
            };
            self.expect(&Token::RBracket)?;

            use crate::compute::expression::InPredicate;

            // Return a special marker that parse_keep_call will collect.
            Ok(Expression::KeepIn {
                expr: Box::new(expr::lit_int(0)), // placeholder
                predicates: vec![InPredicate::new(table, column, var_name, var_column)],
            })
        }
    }

    fn parse_keep_call(&mut self) -> EngineResult<Expression> {
        // First argument: table name (ignored as dimension target, filters carry table info).
        let _dim_table = match self.advance()?.clone() {
            Token::Ident(s) => s,
            tok => {
                return Err(EngineError::InvalidData(format!(
                    "KEEP: expected table name, got {tok:?}"
                )));
            }
        };

        let mut filters = Vec::new();
        let mut conditions = Vec::new();
        let mut in_preds = Vec::new();

        while self.peek() == Some(&Token::Comma) {
            self.advance()?; // consume comma

            // Parse as a full condition expression (handles comparisons and IN).
            let condition_expr = self.parse_condition()?;

            // Route the parsed condition to the right bucket:
            // - Simple Comparison(QualifiedColumnRef, op, literal) → FilterPredicate
            // - KeepIn (from IN var[col] syntax) → in_predicates
            // - Everything else (InList, complex comparison) → conditions
            if let Expression::KeepIn { predicates, .. } = condition_expr {
                in_preds.extend(predicates);
            } else if let Some(pred) = try_as_filter_predicate(&condition_expr) {
                filters.push(pred);
            } else {
                conditions.push(condition_expr);
            }
        }

        self.expect(&Token::RParen)?;

        // Return a sentinel expression that carry_context_op will unwrap.
        Ok(Expression::Keep {
            expr: Box::new(expr::lit_int(0)), // placeholder
            filters,
            variables: Vec::new(),
            conditions,
            in_predicates: in_preds,
        })
    }

    /// Parse `CLEAR(table)` or `CLEAR(table[column])`.
    fn parse_clear_call(&mut self) -> EngineResult<Expression> {
        let targets = self.parse_clear_targets()?;
        self.expect(&Token::RParen)?;
        Ok(Expression::Clear {
            expr: Box::new(expr::lit_int(0)), // placeholder
            targets,
        })
    }

    /// Parse `CLEAR_INNER(table)` or `CLEAR_INNER(table[column])`.
    fn parse_clear_inner_call(&mut self) -> EngineResult<Expression> {
        let targets = self.parse_clear_targets()?;
        self.expect(&Token::RParen)?;
        Ok(Expression::ClearInner {
            expr: Box::new(expr::lit_int(0)),
            targets,
        })
    }

    /// Parse `CLEAR_OUTER(table)` or `CLEAR_OUTER(table[column])`.
    fn parse_clear_outer_call(&mut self) -> EngineResult<Expression> {
        let targets = self.parse_clear_targets()?;
        self.expect(&Token::RParen)?;
        Ok(Expression::ClearOuter {
            expr: Box::new(expr::lit_int(0)),
            targets,
        })
    }

    /// Parse RESET() — no arguments.
    fn parse_reset_call(&mut self) -> EngineResult<Expression> {
        self.expect(&Token::RParen)?;
        Ok(Expression::Reset {
            expr: Box::new(expr::lit_int(0)),
        })
    }

    /// Parse RESET_INNER() — no arguments.
    fn parse_reset_inner_call(&mut self) -> EngineResult<Expression> {
        self.expect(&Token::RParen)?;
        Ok(Expression::ResetInner {
            expr: Box::new(expr::lit_int(0)),
        })
    }

    /// Parse RESET_OUTER() — no arguments.
    fn parse_reset_outer_call(&mut self) -> EngineResult<Expression> {
        self.expect(&Token::RParen)?;
        Ok(Expression::ResetOuter {
            expr: Box::new(expr::lit_int(0)),
        })
    }

    /// Parse USING(context_name).
    fn parse_using_call(&mut self) -> EngineResult<Expression> {
        let name = match self.advance()?.clone() {
            Token::Ident(s) => s,
            tok => {
                return Err(EngineError::InvalidData(format!(
                    "USING: expected context name, got {tok:?}"
                )));
            }
        };
        self.expect(&Token::RParen)?;
        Ok(Expression::Using {
            expr: Box::new(expr::lit_int(0)), // placeholder
            context_name: name,
        })
    }

    /// Parse `[MeasureName]` or `[MeasureName](context_args...)`.
    ///
    /// A lone `[name]` without a preceding table identifier is a measure reference.
    /// Optional parenthesized context args wrap the reference with context operations.
    fn parse_measure_ref(&mut self) -> EngineResult<Expression> {
        self.advance()?; // consume [
        let name = match self.advance()?.clone() {
            Token::Ident(s) => s,
            tok => {
                return Err(EngineError::InvalidData(format!(
                    "expected measure name inside [], got {tok:?}"
                )));
            }
        };
        self.expect(&Token::RBracket)?;

        let mut result = Expression::MeasureRef(name);

        // Optional context arguments: [MeasureName](KEEP(...), USERELATIONSHIP("rel"), ...)
        if self.peek() == Some(&Token::LParen) {
            self.advance()?; // consume (
            loop {
                let context_arg = self.parse_context_arg()?;
                result = wrap_context_op(result, context_arg)?;
                if self.peek() != Some(&Token::Comma) {
                    break;
                }
                self.advance()?; // consume comma
            }
            self.expect(&Token::RParen)?;
        }

        Ok(result)
    }

    /// Parse `USERELATIONSHIP(expr, "relationship_name")` or
    /// `USERELATIONSHIP("relationship_name")` (as context arg in aggregates).
    fn parse_use_relationship_call(&mut self) -> EngineResult<Expression> {
        // First argument: could be a string literal (relationship name when used
        // as context arg) or a full expression (when used as standalone wrapper).
        let first = match self.peek().cloned() {
            Some(Token::StringLit(_)) => {
                // USERELATIONSHIP("rel_name") — context argument form
                let rel_name = match self.advance()?.clone() {
                    Token::StringLit(s) => s,
                    _ => unreachable!(),
                };
                self.expect(&Token::RParen)?;
                return Ok(Expression::UseRelationship {
                    expr: Box::new(expr::lit_int(0)), // placeholder, replaced by wrap_context_op
                    relationship_name: rel_name,
                });
            }
            _ => self.parse_expression()?,
        };
        // USERELATIONSHIP(expr, "rel_name") — standalone wrapper form
        self.expect(&Token::Comma)?;
        let rel_name = match self.advance()?.clone() {
            Token::StringLit(s) => s,
            tok => {
                return Err(EngineError::InvalidData(format!(
                    "USERELATIONSHIP: expected string literal for relationship name, got {tok:?}"
                )));
            }
        };
        self.expect(&Token::RParen)?;
        Ok(expr::use_relationship(first, rel_name))
    }

    /// Parse one or more clear targets (table or table[column]), comma-separated.
    fn parse_clear_targets(&mut self) -> EngineResult<Vec<ClearTarget>> {
        let mut targets = Vec::new();
        loop {
            let table = match self.advance()?.clone() {
                Token::Ident(s) => s,
                tok => {
                    return Err(EngineError::InvalidData(format!(
                        "CLEAR: expected table name, got {tok:?}"
                    )));
                }
            };

            if self.peek() == Some(&Token::LBracket) {
                self.advance()?;
                let col = match self.advance()?.clone() {
                    Token::Ident(s) => s,
                    tok => {
                        return Err(EngineError::InvalidData(format!(
                            "CLEAR: expected column name, got {tok:?}"
                        )));
                    }
                };
                self.expect(&Token::RBracket)?;
                targets.push(ClearTarget::Column { table, column: col });
            } else {
                targets.push(ClearTarget::Table(table));
            }

            if self.peek() != Some(&Token::Comma) {
                break;
            }
            // Peek ahead: is the next comma followed by another clear target or is it
            // part of the outer context? We only consume if there's an ident after comma.
            if self.pos + 1 < self.tokens.len() {
                if let Token::Ident(_) = &self.tokens[self.pos + 1] {
                    self.advance()?; // consume comma
                } else {
                    break;
                }
            } else {
                break;
            }
        }
        Ok(targets)
    }

    /// Parse `table[column] op value`.
    fn parse_filter_predicate(&mut self) -> EngineResult<FilterPredicate> {
        let table = match self.advance()?.clone() {
            Token::Ident(s) => s,
            tok => {
                return Err(EngineError::InvalidData(format!(
                    "filter: expected table name, got {tok:?}"
                )));
            }
        };
        self.expect(&Token::LBracket)?;
        let column = match self.advance()?.clone() {
            Token::Ident(s) => s,
            tok => {
                return Err(EngineError::InvalidData(format!(
                    "filter: expected column name, got {tok:?}"
                )));
            }
        };
        self.expect(&Token::RBracket)?;

        let operator = match self.advance()?.clone() {
            Token::Eq => ComparisonOp::Equal,
            Token::Neq => ComparisonOp::NotEqual,
            Token::Gt => ComparisonOp::GreaterThan,
            Token::Gte => ComparisonOp::GreaterThanOrEqual,
            Token::Lt => ComparisonOp::LessThan,
            Token::Lte => ComparisonOp::LessThanOrEqual,
            tok => {
                return Err(EngineError::InvalidData(format!(
                    "filter: expected comparison operator, got {tok:?}"
                )));
            }
        };

        let value = match self.advance()?.clone() {
            Token::Number(n) => {
                // Format without trailing .0 for integers.
                if n.fract() == 0.0 && n.abs() < i64::MAX as f64 {
                    format!("{}", n as i64)
                } else {
                    format!("{n}")
                }
            }
            Token::StringLit(s) => s,
            Token::Ident(s) => s,
            tok => {
                return Err(EngineError::InvalidData(format!(
                    "filter: expected value, got {tok:?}"
                )));
            }
        };

        Ok(FilterPredicate::new(table, column, operator, value))
    }

    /// Parse `COUNTROWS(table)`.
    fn parse_countrows_call(&mut self) -> EngineResult<Expression> {
        // COUNTROWS takes a table name argument.
        let table = match self.advance()?.clone() {
            Token::Ident(s) => s,
            tok => {
                return Err(EngineError::InvalidData(format!(
                    "COUNTROWS: expected table name, got {tok:?}"
                )));
            }
        };

        // Check for optional context operation argument.
        if self.peek() == Some(&Token::Comma) {
            self.advance()?; // consume comma
            let context_op = self.parse_atom()?;
            self.expect(&Token::RParen)?;
            let cr = Expression::Aggregate {
                operation: AggregateOp::CountRows,
                operand: Box::new(Expression::TableRef(table)),
            };
            Ok(wrap_context_op(cr, context_op)?)
        } else {
            self.expect(&Token::RParen)?;
            Ok(Expression::Aggregate {
                operation: AggregateOp::CountRows,
                operand: Box::new(Expression::TableRef(table)),
            })
        }
    }

    /// Parse `IF(condition, then_value, else_value)`.
    fn parse_if_call(&mut self) -> EngineResult<Expression> {
        let condition = self.parse_comparison_expr()?;
        self.expect(&Token::Comma)?;
        let then_expr = self.parse_expression()?;
        self.expect(&Token::Comma)?;
        let else_expr = self.parse_expression()?;
        self.expect(&Token::RParen)?;
        Ok(expr::if_expr(condition, then_expr, else_expr))
    }

    /// Parse a comparison expression (for IF conditions).
    ///
    /// Supports: `expr op expr`, `expr op expr && expr op expr`, `expr op expr || expr op expr`.
    fn parse_comparison_expr(&mut self) -> EngineResult<Expression> {
        let mut left = self.parse_comparison_term()?;

        while let Some(tok) = self.peek() {
            match tok {
                Token::Ident(s) if s.to_uppercase() == "AND" => {
                    self.advance()?;
                    let right = self.parse_comparison_term()?;
                    left = expr::and(left, right);
                }
                Token::Ident(s) if s.to_uppercase() == "OR" => {
                    self.advance()?;
                    let right = self.parse_comparison_term()?;
                    left = expr::or(left, right);
                }
                _ => break,
            }
        }

        Ok(left)
    }

    /// Parse a single comparison: `expr op expr` or a boolean function like `ISBLANK(...)`.
    fn parse_comparison_term(&mut self) -> EngineResult<Expression> {
        let left = self.parse_expression()?;

        // Check for comparison operator.
        if let Some(tok) = self.peek() {
            let op = match tok {
                Token::Eq => Some(ComparisonOp::Equal),
                Token::Neq => Some(ComparisonOp::NotEqual),
                Token::Gt => Some(ComparisonOp::GreaterThan),
                Token::Gte => Some(ComparisonOp::GreaterThanOrEqual),
                Token::Lt => Some(ComparisonOp::LessThan),
                Token::Lte => Some(ComparisonOp::LessThanOrEqual),
                _ => None,
            };
            if let Some(comp_op) = op {
                self.advance()?;
                let right = self.parse_expression()?;
                return Ok(expr::compare(left, comp_op, right));
            }
        }

        // No comparison operator — return as-is (e.g., ISBLANK(...) as boolean).
        Ok(left)
    }

    /// Parse `SWITCH(expr, val1, result1, val2, result2, ..., [default])`.
    fn parse_switch_call(&mut self) -> EngineResult<Expression> {
        let switch_expr = self.parse_expression()?;
        let mut cases = Vec::new();
        let mut default = None;

        while self.peek() == Some(&Token::Comma) {
            self.advance()?; // consume comma

            // Could be the next case value or the default.
            let val = self.parse_expression()?;

            if self.peek() == Some(&Token::Comma) {
                self.advance()?; // consume comma
                let result = self.parse_expression()?;
                cases.push((val, result));
            } else {
                // Last unpaired value is the default.
                default = Some(val);
            }
        }

        self.expect(&Token::RParen)?;
        Ok(expr::switch(switch_expr, cases, default))
    }

    /// Parse `DIVIDE(numerator, denominator [, alternate])`.
    fn parse_divide_call(&mut self) -> EngineResult<Expression> {
        let numerator = self.parse_expression()?;
        self.expect(&Token::Comma)?;
        let denominator = self.parse_expression()?;

        let alternate = if self.peek() == Some(&Token::Comma) {
            self.advance()?;
            Some(self.parse_expression()?)
        } else {
            None
        };

        self.expect(&Token::RParen)?;
        Ok(expr::safe_divide(numerator, denominator, alternate))
    }

    /// Parse `BLANK()` — no arguments.
    fn parse_blank_call(&mut self) -> EngineResult<Expression> {
        self.expect(&Token::RParen)?;
        Ok(Expression::Blank)
    }

    /// Parse `ISBLANK(expr)`.
    fn parse_isblank_call(&mut self) -> EngineResult<Expression> {
        let inner = self.parse_expression()?;
        self.expect(&Token::RParen)?;
        Ok(expr::is_blank(inner))
    }

    /// Parse `COALESCE(expr1, expr2, ...)`.
    fn parse_coalesce_call(&mut self) -> EngineResult<Expression> {
        let mut exprs = vec![self.parse_expression()?];
        while self.peek() == Some(&Token::Comma) {
            self.advance()?;
            exprs.push(self.parse_expression()?);
        }
        self.expect(&Token::RParen)?;
        Ok(expr::coalesce(exprs))
    }

    /// Parse a QUERY call for two-stage aggregation:
    /// `QUERY(SUM(fact[amount]) AS revenue, COUNT(fact[id]) AS orders BY dim[year], dim[month])`
    ///
    /// Grammar:
    /// ```text
    /// QUERY( agg_expr AS alias [, agg_expr AS alias]* BY table[col] [, table[col]]* )
    /// ```
    fn parse_query_call(&mut self) -> EngineResult<Expression> {
        let mut aggregates = Vec::new();

        // Parse aggregate expressions until we hit the BY keyword.
        loop {
            let agg_expr = self.parse_expression()?;

            // Expect AS keyword (parsed as an identifier).
            match self.peek().cloned() {
                Some(Token::Ident(ref s)) if s.eq_ignore_ascii_case("AS") => {
                    self.advance()?;
                }
                other => {
                    return Err(EngineError::InvalidData(format!(
                        "expected 'AS' after aggregate expression in QUERY, got {other:?}"
                    )));
                }
            }

            // Parse the alias name.
            let alias = match self.advance()?.clone() {
                Token::Ident(s) => s,
                tok => {
                    return Err(EngineError::InvalidData(format!(
                        "expected alias name after AS in QUERY, got {tok:?}"
                    )));
                }
            };

            aggregates.push((agg_expr, alias));

            // Check for BY keyword or comma (more aggregates).
            match self.peek().cloned() {
                Some(Token::Ident(ref s)) if s.eq_ignore_ascii_case("BY") => {
                    self.advance()?; // consume BY
                    break;
                }
                Some(Token::Comma) => {
                    self.advance()?; // consume comma, continue parsing aggregates
                }
                other => {
                    return Err(EngineError::InvalidData(format!(
                        "expected ',' or 'BY' after aggregate alias in QUERY, got {other:?}"
                    )));
                }
            }
        }

        // Parse group-by columns: table[column] pairs.
        let mut group_by = Vec::new();
        loop {
            let table = match self.advance()?.clone() {
                Token::Ident(s) => s,
                tok => {
                    return Err(EngineError::InvalidData(format!(
                        "expected table name in QUERY BY clause, got {tok:?}"
                    )));
                }
            };
            self.expect(&Token::LBracket)?;
            let column = match self.advance()?.clone() {
                Token::Ident(s) => s,
                tok => {
                    return Err(EngineError::InvalidData(format!(
                        "expected column name in QUERY BY clause, got {tok:?}"
                    )));
                }
            };
            self.expect(&Token::RBracket)?;
            group_by.push((table, column));

            // Check for comma (more columns) or closing paren.
            if self.peek() == Some(&Token::Comma) {
                self.advance()?;
            } else {
                break;
            }
        }

        self.expect(&Token::RParen)?;

        if aggregates.is_empty() {
            return Err(EngineError::InvalidData(
                "QUERY requires at least one aggregate expression".into(),
            ));
        }
        if group_by.is_empty() {
            return Err(EngineError::InvalidData(
                "QUERY requires at least one BY column".into(),
            ));
        }

        Ok(expr::query_expr(aggregates, group_by))
    }

    /// Parse `table[column]` pairs for ORDERBY/PARTITIONBY clauses.
    fn parse_table_column_pairs(&mut self) -> EngineResult<Vec<(String, String)>> {
        let mut pairs = Vec::new();
        loop {
            let table = match self.advance()?.clone() {
                Token::Ident(s) => s,
                tok => {
                    return Err(EngineError::InvalidData(format!(
                        "expected table name, got {tok:?}"
                    )));
                }
            };
            self.expect(&Token::LBracket)?;
            let column = match self.advance()?.clone() {
                Token::Ident(s) => s,
                tok => {
                    return Err(EngineError::InvalidData(format!(
                        "expected column name, got {tok:?}"
                    )));
                }
            };
            self.expect(&Token::RBracket)?;
            pairs.push((table, column));

            if self.peek() == Some(&Token::Comma) {
                self.advance()?;
            } else {
                break;
            }
        }
        Ok(pairs)
    }

    /// Parse `ORDERBY(table[col], ...)` clause.
    fn parse_orderby_clause(&mut self) -> EngineResult<Vec<(String, String)>> {
        self.expect(&Token::LParen)?;
        let pairs = self.parse_table_column_pairs()?;
        self.expect(&Token::RParen)?;
        if pairs.is_empty() {
            return Err(EngineError::InvalidData(
                "ORDERBY requires at least one column".into(),
            ));
        }
        Ok(pairs)
    }

    /// Parse `PARTITIONBY(table[col], ...)` clause.
    fn parse_partitionby_clause(&mut self) -> EngineResult<Vec<(String, String)>> {
        self.expect(&Token::LParen)?;
        let pairs = self.parse_table_column_pairs()?;
        self.expect(&Token::RParen)?;
        if pairs.is_empty() {
            return Err(EngineError::InvalidData(
                "PARTITIONBY requires at least one column".into(),
            ));
        }
        Ok(pairs)
    }

    /// Parse `ROWS(from, from_type, to, to_type)` frame specification.
    fn parse_rows_clause(&mut self) -> EngineResult<WindowFrame> {
        use crate::compute::expression::BoundaryType;

        self.expect(&Token::LParen)?;

        // Parse `from` (integer).
        let from = match self.advance()?.clone() {
            Token::Number(v) => v as i64,
            Token::Minus => {
                let v = match self.advance()?.clone() {
                    Token::Number(v) => v as i64,
                    tok => {
                        return Err(EngineError::InvalidData(format!(
                            "expected integer after '-' in ROWS, got {tok:?}"
                        )));
                    }
                };
                -v
            }
            tok => {
                return Err(EngineError::InvalidData(format!(
                    "expected integer for ROWS from, got {tok:?}"
                )));
            }
        };

        self.expect(&Token::Comma)?;

        // Parse `from_type` (REL or ABS).
        let from_type = match self.advance()?.clone() {
            Token::Ident(ref s) if s.eq_ignore_ascii_case("REL") => BoundaryType::Rel,
            Token::Ident(ref s) if s.eq_ignore_ascii_case("ABS") => BoundaryType::Abs,
            tok => {
                return Err(EngineError::InvalidData(format!(
                    "expected REL or ABS for ROWS from_type, got {tok:?}"
                )));
            }
        };

        self.expect(&Token::Comma)?;

        // Parse `to` (integer).
        let to = match self.advance()?.clone() {
            Token::Number(v) => v as i64,
            Token::Minus => {
                let v = match self.advance()?.clone() {
                    Token::Number(v) => v as i64,
                    tok => {
                        return Err(EngineError::InvalidData(format!(
                            "expected integer after '-' in ROWS, got {tok:?}"
                        )));
                    }
                };
                -v
            }
            tok => {
                return Err(EngineError::InvalidData(format!(
                    "expected integer for ROWS to, got {tok:?}"
                )));
            }
        };

        self.expect(&Token::Comma)?;

        // Parse `to_type` (REL or ABS).
        let to_type = match self.advance()?.clone() {
            Token::Ident(ref s) if s.eq_ignore_ascii_case("REL") => BoundaryType::Rel,
            Token::Ident(ref s) if s.eq_ignore_ascii_case("ABS") => BoundaryType::Abs,
            tok => {
                return Err(EngineError::InvalidData(format!(
                    "expected REL or ABS for ROWS to_type, got {tok:?}"
                )));
            }
        };

        self.expect(&Token::RParen)?;

        Ok(WindowFrame {
            from,
            from_type,
            to,
            to_type,
        })
    }

    /// Parse `WINDOW(inner, agg_func, ORDERBY(...), [PARTITIONBY(...)], [ROWS(...)])`.
    fn parse_window_call(&mut self) -> EngineResult<Expression> {
        // Parse inner measure expression.
        let inner = self.parse_expression()?;
        self.expect(&Token::Comma)?;

        // Parse window aggregate function name.
        let func = match self.advance()?.clone() {
            Token::Ident(ref s) => match s.to_uppercase().as_str() {
                "SUM" => AggregateOp::Sum,
                "AVG" | "AVERAGE" => AggregateOp::Average,
                "MIN" => AggregateOp::Min,
                "MAX" => AggregateOp::Max,
                "COUNT" => AggregateOp::Count,
                other => {
                    return Err(EngineError::InvalidData(format!(
                        "unsupported window aggregate function: {other}"
                    )));
                }
            },
            tok => {
                return Err(EngineError::InvalidData(format!(
                    "expected aggregate function name in WINDOW, got {tok:?}"
                )));
            }
        };

        self.expect(&Token::Comma)?;

        // Expect ORDERBY keyword.
        match self.advance()?.clone() {
            Token::Ident(ref s) if s.eq_ignore_ascii_case("ORDERBY") => {}
            tok => {
                return Err(EngineError::InvalidData(format!(
                    "expected ORDERBY in WINDOW, got {tok:?}"
                )));
            }
        }
        let order_by = self.parse_orderby_clause()?;

        // Optional PARTITIONBY and ROWS clauses.
        let mut partition_by = Vec::new();
        let mut frame = None;

        while self.peek() == Some(&Token::Comma) {
            self.advance()?; // consume comma
            match self.peek().cloned() {
                Some(Token::Ident(ref s)) if s.eq_ignore_ascii_case("PARTITIONBY") => {
                    self.advance()?;
                    partition_by = self.parse_partitionby_clause()?;
                }
                Some(Token::Ident(ref s)) if s.eq_ignore_ascii_case("ROWS") => {
                    self.advance()?;
                    frame = Some(self.parse_rows_clause()?);
                }
                other => {
                    return Err(EngineError::InvalidData(format!(
                        "expected PARTITIONBY or ROWS in WINDOW, got {other:?}"
                    )));
                }
            }
        }

        self.expect(&Token::RParen)?;

        Ok(expr::window_expr(
            inner,
            func,
            order_by,
            partition_by,
            frame,
        ))
    }

    /// Parse `OFFSET(inner, delta, ORDERBY(...), [PARTITIONBY(...)])`.
    fn parse_offset_call(&mut self) -> EngineResult<Expression> {
        let inner = self.parse_expression()?;
        self.expect(&Token::Comma)?;

        // Parse delta (integer, possibly negative).
        let delta = match self.advance()?.clone() {
            Token::Number(v) => v as i64,
            Token::Minus => {
                let v = match self.advance()?.clone() {
                    Token::Number(v) => v as i64,
                    tok => {
                        return Err(EngineError::InvalidData(format!(
                            "expected integer after '-' in OFFSET delta, got {tok:?}"
                        )));
                    }
                };
                -v
            }
            tok => {
                return Err(EngineError::InvalidData(format!(
                    "expected integer for OFFSET delta, got {tok:?}"
                )));
            }
        };

        self.expect(&Token::Comma)?;

        // Expect ORDERBY.
        match self.advance()?.clone() {
            Token::Ident(ref s) if s.eq_ignore_ascii_case("ORDERBY") => {}
            tok => {
                return Err(EngineError::InvalidData(format!(
                    "expected ORDERBY in OFFSET, got {tok:?}"
                )));
            }
        }
        let order_by = self.parse_orderby_clause()?;

        // Optional PARTITIONBY.
        let mut partition_by = Vec::new();
        if self.peek() == Some(&Token::Comma) {
            self.advance()?;
            match self.advance()?.clone() {
                Token::Ident(ref s) if s.eq_ignore_ascii_case("PARTITIONBY") => {
                    partition_by = self.parse_partitionby_clause()?;
                }
                tok => {
                    return Err(EngineError::InvalidData(format!(
                        "expected PARTITIONBY in OFFSET, got {tok:?}"
                    )));
                }
            }
        }

        self.expect(&Token::RParen)?;

        Ok(expr::offset_expr(inner, delta, order_by, partition_by))
    }

    /// Parse `INDEX(inner, position, ORDERBY(...), [PARTITIONBY(...)])`.
    fn parse_index_call(&mut self) -> EngineResult<Expression> {
        let inner = self.parse_expression()?;
        self.expect(&Token::Comma)?;

        // Parse position (integer, possibly negative).
        let position = match self.advance()?.clone() {
            Token::Number(v) => v as i64,
            Token::Minus => {
                let v = match self.advance()?.clone() {
                    Token::Number(v) => v as i64,
                    tok => {
                        return Err(EngineError::InvalidData(format!(
                            "expected integer after '-' in INDEX position, got {tok:?}"
                        )));
                    }
                };
                -v
            }
            tok => {
                return Err(EngineError::InvalidData(format!(
                    "expected integer for INDEX position, got {tok:?}"
                )));
            }
        };

        self.expect(&Token::Comma)?;

        // Expect ORDERBY.
        match self.advance()?.clone() {
            Token::Ident(ref s) if s.eq_ignore_ascii_case("ORDERBY") => {}
            tok => {
                return Err(EngineError::InvalidData(format!(
                    "expected ORDERBY in INDEX, got {tok:?}"
                )));
            }
        }
        let order_by = self.parse_orderby_clause()?;

        // Optional PARTITIONBY.
        let mut partition_by = Vec::new();
        if self.peek() == Some(&Token::Comma) {
            self.advance()?;
            match self.advance()?.clone() {
                Token::Ident(ref s) if s.eq_ignore_ascii_case("PARTITIONBY") => {
                    partition_by = self.parse_partitionby_clause()?;
                }
                tok => {
                    return Err(EngineError::InvalidData(format!(
                        "expected PARTITIONBY in INDEX, got {tok:?}"
                    )));
                }
            }
        }

        self.expect(&Token::RParen)?;

        Ok(expr::index_expr(inner, position, order_by, partition_by))
    }

    /// Parse `HASONEVALUE(table[column])`.
    fn parse_hasonevalue_call(&mut self) -> EngineResult<Expression> {
        let column = self.parse_expression()?;
        self.expect(&Token::RParen)?;
        Ok(expr::has_one_value(column))
    }

    /// Parse `SELECTEDVALUE(table[column] [, alternate])`.
    fn parse_selectedvalue_call(&mut self) -> EngineResult<Expression> {
        let column = self.parse_expression()?;
        let alternate = if self.peek() == Some(&Token::Comma) {
            self.advance()?;
            Some(self.parse_expression()?)
        } else {
            None
        };
        self.expect(&Token::RParen)?;
        Ok(expr::selected_value(column, alternate))
    }

    /// Parse `FIRST(table[column], ORDER BY table[sort_col])`.
    ///
    /// Simplified from DAX: no axis, no reset, no blanks parameter.
    /// Syntax: `FIRST(column_expr, ORDER BY order_expr)` or `FIRST(column_expr, order_expr)`.
    fn parse_first_call(&mut self) -> EngineResult<Expression> {
        let column = self.parse_expression()?;

        if self.peek() != Some(&Token::Comma) {
            return Err(EngineError::InvalidData(
                "FIRST requires two arguments: FIRST(column, ORDER BY sort_column)".into(),
            ));
        }
        self.advance()?; // consume comma

        // Optional ORDER BY keywords (skip if present).
        if let Some(Token::Ident(kw)) = self.peek() {
            if kw.eq_ignore_ascii_case("ORDER") {
                self.advance()?; // consume ORDER
                if let Some(Token::Ident(by)) = self.peek() {
                    if by.eq_ignore_ascii_case("BY") {
                        self.advance()?; // consume BY
                    }
                }
            }
        }

        let order_by = self.parse_expression()?;
        self.expect(&Token::RParen)?;
        Ok(expr::first_value(column, order_by))
    }

    /// Parse `AND(left, right)` — function-call syntax for logical AND.
    fn parse_and_call(&mut self) -> EngineResult<Expression> {
        let left = self.parse_comparison_expr()?;
        self.expect(&Token::Comma)?;
        let right = self.parse_comparison_expr()?;
        self.expect(&Token::RParen)?;
        Ok(expr::and(left, right))
    }

    /// Parse `OR(left, right)` — function-call syntax for logical OR.
    fn parse_or_call(&mut self) -> EngineResult<Expression> {
        let left = self.parse_comparison_expr()?;
        self.expect(&Token::Comma)?;
        let right = self.parse_comparison_expr()?;
        self.expect(&Token::RParen)?;
        Ok(expr::or(left, right))
    }

    /// Parse `NOT(expr)` — function-call syntax for logical NOT.
    fn parse_not_call(&mut self) -> EngineResult<Expression> {
        let inner = self.parse_comparison_expr()?;
        self.expect(&Token::RParen)?;
        Ok(expr::not(inner))
    }

    /// Parse `TRUE()` — boolean literal true.
    fn parse_true_call(&mut self) -> EngineResult<Expression> {
        self.expect(&Token::RParen)?;
        Ok(expr::lit_bool(true))
    }

    /// Parse `FALSE()` — boolean literal false.
    fn parse_false_call(&mut self) -> EngineResult<Expression> {
        self.expect(&Token::RParen)?;
        Ok(expr::lit_bool(false))
    }

    /// Parse `XOR(left, right)` — logical exclusive OR.
    fn parse_xor_call(&mut self) -> EngineResult<Expression> {
        let left = self.parse_comparison_expr()?;
        self.expect(&Token::Comma)?;
        let right = self.parse_comparison_expr()?;
        self.expect(&Token::RParen)?;
        Ok(expr::xor(left, right))
    }

    /// Parse a scalar function call with `min_args` required and optional extra args.
    fn parse_scalar_call(
        &mut self,
        function: ScalarFunction,
        min_args: usize,
    ) -> EngineResult<Expression> {
        // Handle zero-arg functions like PI()
        if min_args == 0 && self.peek() == Some(&Token::RParen) {
            self.advance()?; // consume RParen
            return Ok(expr::scalar_fn(function, vec![]));
        }
        let mut args = vec![self.parse_expression()?];
        while self.peek() == Some(&Token::Comma) {
            self.advance()?;
            args.push(self.parse_expression()?);
        }
        if args.len() < min_args {
            return Err(EngineError::InvalidData(format!(
                "{function}: expected at least {min_args} arguments, got {}",
                args.len()
            )));
        }
        self.expect(&Token::RParen)?;
        Ok(expr::scalar_fn(function, args))
    }

    /// Parse a text function call with `min_args` required and optional extra args.
    fn parse_text_call(
        &mut self,
        function: TextFunction,
        min_args: usize,
    ) -> EngineResult<Expression> {
        let mut args = vec![self.parse_expression()?];
        while self.peek() == Some(&Token::Comma) {
            self.advance()?;
            args.push(self.parse_expression()?);
        }
        if args.len() < min_args {
            return Err(EngineError::InvalidData(format!(
                "{function}: expected at least {min_args} arguments, got {}",
                args.len()
            )));
        }
        self.expect(&Token::RParen)?;
        Ok(expr::text_fn(function, args))
    }

    /// Parse a date/time function call with `min_args` required and optional extra args.
    fn parse_datetime_call(
        &mut self,
        function: DateTimeFunction,
        min_args: usize,
    ) -> EngineResult<Expression> {
        if min_args == 0 {
            // Zero-arg functions like TODAY(), NOW()
            self.expect(&Token::RParen)?;
            return Ok(expr::datetime_fn(function, vec![]));
        }
        let mut args = vec![self.parse_expression()?];
        while self.peek() == Some(&Token::Comma) {
            self.advance()?;
            args.push(self.parse_expression()?);
        }
        if args.len() < min_args {
            return Err(EngineError::InvalidData(format!(
                "{function}: expected at least {min_args} arguments, got {}",
                args.len()
            )));
        }
        self.expect(&Token::RParen)?;
        Ok(expr::datetime_fn(function, args))
    }

    /// Parse `DATEDIFF(start, end, interval)` where interval is DAY/MONTH/YEAR/QUARTER.
    fn parse_datediff_call(&mut self) -> EngineResult<Expression> {
        let start = self.parse_expression()?;
        self.expect(&Token::Comma)?;
        let end = self.parse_expression()?;
        self.expect(&Token::Comma)?;
        // The interval is an identifier keyword: DAY, MONTH, YEAR, QUARTER
        let interval = match self.advance()?.clone() {
            Token::Ident(s) => {
                let upper = s.to_uppercase();
                match upper.as_str() {
                    "DAY" | "MONTH" | "YEAR" | "QUARTER" | "HOUR" | "MINUTE" | "SECOND" => upper,
                    _ => {
                        return Err(EngineError::InvalidData(format!(
                            "DATEDIFF: invalid interval '{s}', expected DAY, MONTH, YEAR, or QUARTER"
                        )));
                    }
                }
            }
            tok => {
                return Err(EngineError::InvalidData(format!(
                    "DATEDIFF: expected interval (DAY/MONTH/YEAR/QUARTER), got {tok:?}"
                )));
            }
        };
        self.expect(&Token::RParen)?;
        Ok(expr::datetime_fn(
            DateTimeFunction::DateDiff,
            vec![start, end, Expression::LiteralString(interval)],
        ))
    }

    /// Parse `IFERROR(expr, alternate)`.
    fn parse_iferror_call(&mut self) -> EngineResult<Expression> {
        let inner = self.parse_expression()?;
        self.expect(&Token::Comma)?;
        let alternate = self.parse_expression()?;
        self.expect(&Token::RParen)?;
        Ok(expr::if_error(inner, alternate))
    }

    /// Parse `ISINSCOPE(table[column])`.
    fn parse_isinscope_call(&mut self) -> EngineResult<Expression> {
        let table = match self.advance()?.clone() {
            Token::Ident(s) => s,
            tok => {
                return Err(EngineError::InvalidData(format!(
                    "ISINSCOPE: expected table name, got {tok:?}"
                )));
            }
        };
        self.expect(&Token::LBracket)?;
        let column = match self.advance()?.clone() {
            Token::Ident(s) => s,
            tok => {
                return Err(EngineError::InvalidData(format!(
                    "ISINSCOPE: expected column name, got {tok:?}"
                )));
            }
        };
        self.expect(&Token::RBracket)?;
        self.expect(&Token::RParen)?;
        Ok(expr::is_in_scope(table, column))
    }

    /// Parse `CLEAREXCEPT(table, col1, col2, ...)` as a context argument.
    ///
    /// Returns a placeholder ClearExcept wrapping Blank — the actual inner
    /// expression is set by `wrap_context_op`.
    fn parse_clearexcept_call(&mut self) -> EngineResult<Expression> {
        let table = match self.advance()?.clone() {
            Token::Ident(s) => s,
            tok => {
                return Err(EngineError::InvalidData(format!(
                    "CLEAREXCEPT: expected table name, got {tok:?}"
                )));
            }
        };
        let mut except_columns = Vec::new();
        while self.peek() == Some(&Token::Comma) {
            self.advance()?; // consume comma
                             // Expect table[column] or just column identifier
            let col_name = match self.advance()?.clone() {
                Token::Ident(s) => {
                    // Could be table[col] or just col
                    if self.peek() == Some(&Token::LBracket) {
                        self.advance()?; // consume [
                        let col = match self.advance()?.clone() {
                            Token::Ident(c) => c,
                            tok => {
                                return Err(EngineError::InvalidData(format!(
                                    "CLEAREXCEPT: expected column name, got {tok:?}"
                                )));
                            }
                        };
                        self.expect(&Token::RBracket)?;
                        col
                    } else {
                        s
                    }
                }
                tok => {
                    return Err(EngineError::InvalidData(format!(
                        "CLEAREXCEPT: expected column reference, got {tok:?}"
                    )));
                }
            };
            except_columns.push(col_name);
        }
        self.expect(&Token::RParen)?;
        Ok(Expression::ClearExcept {
            expr: Box::new(Expression::Blank),
            table,
            except_columns,
        })
    }

    /// Parse `ITERATE(table, expression)`.
    fn parse_iterate_call(&mut self) -> EngineResult<Expression> {
        let table = match self.advance()?.clone() {
            Token::Ident(s) => s,
            tok => {
                return Err(EngineError::InvalidData(format!(
                    "ITERATE: expected table name, got {tok:?}"
                )));
            }
        };
        self.expect(&Token::Comma)?;
        let expression = self.parse_expression()?;
        self.expect(&Token::RParen)?;
        Ok(expr::iterate(table, expression))
    }

    /// Parse `PERCENTILE(operand, k [, context_ops...])`.
    fn parse_percentile_call(&mut self) -> EngineResult<Expression> {
        let operand = self.parse_expression()?;
        self.expect(&Token::Comma)?;
        let percentile = self.parse_expression()?;
        // Check for optional context arguments
        let mut result = expr::percentile(operand, percentile);
        while self.peek() == Some(&Token::Comma) {
            self.advance()?;
            let context_arg = self.parse_context_arg()?;
            result = wrap_context_op(result, context_arg)?;
        }
        self.expect(&Token::RParen)?;
        Ok(result)
    }
}

/// Wrap an aggregate expression with a context operation.
///
/// The context op was parsed as a placeholder Expression; here we extract
/// the context info and apply it to the real aggregate expression.
fn wrap_context_op(aggregate: Expression, context_op: Expression) -> EngineResult<Expression> {
    match context_op {
        Expression::Keep {
            filters,
            variables,
            conditions,
            in_predicates,
            ..
        } => Ok(Expression::Keep {
            expr: Box::new(aggregate),
            filters,
            variables,
            conditions,
            in_predicates,
        }),
        Expression::TableRef(name) => Ok(expr::keep_vars(aggregate, vec![name])),
        Expression::Clear { targets, .. } => Ok(expr::clear(aggregate, targets)),
        Expression::Reset { .. } => Ok(expr::reset(aggregate)),
        Expression::ClearInner { targets, .. } => Ok(expr::clear_inner(aggregate, targets)),
        Expression::ClearOuter { targets, .. } => Ok(expr::clear_outer(aggregate, targets)),
        Expression::ResetInner { .. } => Ok(expr::reset_inner(aggregate)),
        Expression::ResetOuter { .. } => Ok(expr::reset_outer(aggregate)),
        Expression::Using { context_name, .. } => Ok(expr::using(aggregate, context_name)),
        Expression::UseRelationship {
            relationship_name, ..
        } => Ok(expr::use_relationship(aggregate, relationship_name)),
        Expression::ClearExcept {
            table,
            except_columns,
            ..
        } => Ok(expr::clear_except(aggregate, table, except_columns)),
        _ => Err(EngineError::InvalidData(
            "expected context operation (KEEP, CLEAR, RESET, USING, USERELATIONSHIP, etc.)".into(),
        )),
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Parse a measure expression from text into an `Expression` tree.
///
/// # Syntax
///
/// ```text
/// SUM(table[column])
/// SUM(table[column], KEEP(dim, dim[year] = 2024))
/// SUM(table[a]) / COUNT(table[b])
/// SUM(table[price] * table[quantity])
/// ```
///
/// # Errors
///
/// Returns `EngineError::InvalidData` for syntax errors.
///
/// # Example
///
/// ```
/// use engine_core::compute::parser::parse_measure_expression;
///
/// let expr = parse_measure_expression("SUM(fact_sales[linetotal])").unwrap();
/// ```
/// Try to downgrade a Comparison expression to a simple FilterPredicate.
///
/// Returns `Some(FilterPredicate)` if the expression is `QualifiedColumnRef op literal`,
/// which is the common case for KEEP filters. Otherwise returns `None`,
/// indicating the expression should be stored as a condition.
fn try_as_filter_predicate(expr: &Expression) -> Option<FilterPredicate> {
    if let Expression::Comparison { left, op, right } = expr {
        // Left must be a QualifiedColumnRef (table[column]).
        let (table, column) = match left.as_ref() {
            Expression::QualifiedColumnRef {
                table_or_var,
                column,
            } => (table_or_var.clone(), column.clone()),
            _ => return None,
        };

        // Right must be a literal value.
        let value = match right.as_ref() {
            Expression::LiteralFloat(v) => {
                if v.fract() == 0.0 && v.abs() < i64::MAX as f64 {
                    format!("{}", *v as i64)
                } else {
                    format!("{v}")
                }
            }
            Expression::LiteralInt(v) => format!("{v}"),
            Expression::LiteralString(s) => s.clone(),
            Expression::ColumnRef(s) => s.clone(), // bare identifier as value
            _ => return None,
        };

        Some(FilterPredicate::new(table, column, *op, value))
    } else {
        None
    }
}

pub fn parse_measure_expression(input: &str) -> EngineResult<Expression> {
    let tokens = tokenize(input)?;
    if tokens.is_empty() {
        return Err(EngineError::InvalidData("empty expression".into()));
    }
    let mut parser = Parser::new(tokens);

    // Check for VAR/RETURN block syntax.
    if parser.peek_is_var() {
        let expr = parser.parse_var_return_block()?;
        if !parser.at_end() {
            return Err(EngineError::InvalidData(format!(
                "unexpected token after RETURN expression: {:?}",
                parser.peek()
            )));
        }
        return Ok(expr);
    }

    let expr = parser.parse_expression()?;
    if !parser.at_end() {
        return Err(EngineError::InvalidData(format!(
            "unexpected token after expression: {:?}",
            parser.peek()
        )));
    }
    Ok(expr)
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
        return Err(EngineError::InvalidData(
            "cannot infer fact table — use table[column] syntax".into(),
        ));
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
        return Err(EngineError::InvalidData("empty expression".into()));
    }
    let mut parser = Parser::new(tokens);

    // Expect: KEEP ( source, filters... )
    match parser.advance()? {
        Token::Ident(name) if name.to_uppercase() == "KEEP" => {}
        tok => {
            return Err(EngineError::InvalidData(format!(
                "expected KEEP(...), got {tok:?}"
            )));
        }
    }
    parser.expect(&Token::LParen)?;

    // Source table or variable name.
    let source = match parser.advance()?.clone() {
        Token::Ident(s) => s,
        tok => {
            return Err(EngineError::InvalidData(format!(
                "KEEP: expected source table name, got {tok:?}"
            )));
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
        return Err(EngineError::InvalidData(format!(
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
        return Err(EngineError::InvalidData("empty context definition".into()));
    }
    let mut parser = Parser::new(tokens);
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
        return Err(EngineError::InvalidData(format!(
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

impl Parser {
    /// Parse a single context operation (KEEP, CLEAR, RESET, or bare name).
    fn parse_context_op(&mut self) -> EngineResult<ContextOp> {
        let name = match self.peek().cloned() {
            Some(Token::Ident(s)) => s,
            other => {
                return Err(EngineError::InvalidData(format!(
                    "expected context operation or name, got {other:?}"
                )));
            }
        };

        let upper = name.to_uppercase();
        match upper.as_str() {
            "KEEP" => {
                self.advance()?;
                self.expect(&Token::LParen)?;
                // First arg: table name (for grouping; filters carry actual table info).
                let _dim_table = match self.advance()?.clone() {
                    Token::Ident(s) => s,
                    tok => {
                        return Err(EngineError::InvalidData(format!(
                            "KEEP: expected table name, got {tok:?}"
                        )));
                    }
                };
                let mut filters = Vec::new();
                while self.peek() == Some(&Token::Comma) {
                    self.advance()?;
                    let filter = self.parse_filter_predicate()?;
                    filters.push(filter);
                }
                self.expect(&Token::RParen)?;
                Ok(ContextOp::Keep(filters))
            }
            "CLEAR" => {
                self.advance()?;
                self.expect(&Token::LParen)?;
                let targets = self.parse_clear_targets()?;
                self.expect(&Token::RParen)?;
                Ok(ContextOp::Clear(targets))
            }
            "CLEAR_INNER" | "CLEARINNER" => {
                self.advance()?;
                self.expect(&Token::LParen)?;
                let targets = self.parse_clear_targets()?;
                self.expect(&Token::RParen)?;
                Ok(ContextOp::ClearInner(targets))
            }
            "CLEAR_OUTER" | "CLEAROUTER" => {
                self.advance()?;
                self.expect(&Token::LParen)?;
                let targets = self.parse_clear_targets()?;
                self.expect(&Token::RParen)?;
                Ok(ContextOp::ClearOuter(targets))
            }
            "RESET" => {
                self.advance()?;
                self.expect(&Token::LParen)?;
                self.expect(&Token::RParen)?;
                Ok(ContextOp::Reset)
            }
            "RESET_INNER" | "RESETINNER" => {
                self.advance()?;
                self.expect(&Token::LParen)?;
                self.expect(&Token::RParen)?;
                Ok(ContextOp::ResetInner)
            }
            "RESET_OUTER" | "RESETOUTER" => {
                self.advance()?;
                self.expect(&Token::LParen)?;
                self.expect(&Token::RParen)?;
                Ok(ContextOp::ResetOuter)
            }
            "USERELATIONSHIP" => {
                self.advance()?;
                self.expect(&Token::LParen)?;
                let rel_name = match self.advance()?.clone() {
                    Token::StringLit(s) => s,
                    tok => {
                        return Err(EngineError::InvalidData(format!(
                            "USERELATIONSHIP: expected string literal, got {tok:?}"
                        )));
                    }
                };
                self.expect(&Token::RParen)?;
                Ok(ContextOp::UseRelationship(rel_name))
            }
            _ => {
                // Bare name — inherit from another context.
                self.advance()?;
                Ok(ContextOp::Inherit(name))
            }
        }
    }

    /// Check if the current token is `VAR` (case-insensitive).
    fn peek_is_var(&self) -> bool {
        matches!(self.peek(), Some(Token::Ident(s)) if s.to_uppercase() == "VAR")
    }

    /// Check if the current token is `RETURN` (case-insensitive).
    fn peek_is_return(&self) -> bool {
        matches!(self.peek(), Some(Token::Ident(s)) if s.to_uppercase() == "RETURN")
    }

    /// Parse a VAR/RETURN block:
    ///
    /// ```text
    /// VAR name = expression
    /// VAR name = expression
    /// RETURN result_expression
    /// ```
    ///
    /// Produces `Expression::Block { bindings, result }`.
    fn parse_var_return_block(&mut self) -> EngineResult<Expression> {
        let mut bindings = Vec::new();

        while self.peek_is_var() {
            self.advance()?; // consume VAR

            // Variable name.
            let var_name = match self.advance()?.clone() {
                Token::Ident(s) => {
                    let upper = s.to_uppercase();
                    if upper == "VAR" || upper == "RETURN" {
                        return Err(EngineError::InvalidData(format!(
                            "'{s}' is a reserved keyword and cannot be used as a variable name"
                        )));
                    }
                    s
                }
                tok => {
                    return Err(EngineError::InvalidData(format!(
                        "VAR: expected variable name, got {tok:?}"
                    )));
                }
            };

            // Expect `=`.
            self.expect(&Token::Eq)?;

            // Parse the binding expression.
            let binding_expr = self.parse_expression()?;
            bindings.push((var_name, binding_expr));
        }

        if bindings.is_empty() {
            return Err(EngineError::InvalidData(
                "VAR block must have at least one VAR declaration".into(),
            ));
        }

        // Expect RETURN.
        if !self.peek_is_return() {
            return Err(EngineError::InvalidData(format!(
                "expected RETURN after VAR declarations, got {:?}",
                self.peek()
            )));
        }
        self.advance()?; // consume RETURN

        let result = self.parse_expression()?;

        Ok(expr::block(bindings, result))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_simple_sum() {
        let expr = parse_measure_expression("SUM(Sales[amount])").unwrap();
        assert!(expr.has_aggregate());
        assert_eq!(expr.to_sql_string(), "SUM(\"amount\")");
    }

    #[test]
    fn parse_simple_count() {
        let expr = parse_measure_expression("COUNT(Sales[id])").unwrap();
        assert_eq!(expr.to_sql_string(), "COUNT(\"id\")");
    }

    #[test]
    fn parse_distinctcount() {
        let expr = parse_measure_expression("DISTINCTCOUNT(Sales[product_id])").unwrap();
        assert_eq!(expr.to_sql_string(), "COUNT(DISTINCT \"product_id\")");
    }

    #[test]
    fn parse_avg() {
        let expr = parse_measure_expression("AVG(Sales[price])").unwrap();
        assert_eq!(expr.to_sql_string(), "AVG(\"price\")");
    }

    #[test]
    fn parse_arithmetic_aggregates() {
        let expr = parse_measure_expression("SUM(Sales[amount]) / COUNT(Sales[id])").unwrap();
        assert_eq!(expr.to_sql_string(), "(SUM(\"amount\") / COUNT(\"id\"))");
    }

    #[test]
    fn parse_addition_subtraction() {
        let expr =
            parse_measure_expression("SUM(Sales[a]) + SUM(Sales[b]) - SUM(Sales[c])").unwrap();
        let sql = expr.to_sql_string();
        assert!(sql.contains("SUM(\"a\")"));
        assert!(sql.contains("SUM(\"b\")"));
        assert!(sql.contains("SUM(\"c\")"));
    }

    #[test]
    fn parse_parenthesized_arithmetic() {
        let expr = parse_measure_expression("(SUM(Sales[a]) + SUM(Sales[b])) * 100").unwrap();
        let sql = expr.to_sql_string();
        assert!(sql.contains("100"));
    }

    #[test]
    fn parse_aggregate_over_arithmetic() {
        let expr = parse_measure_expression("SUM(Sales[price] * Sales[quantity])").unwrap();
        assert!(expr.has_aggregate());
    }

    #[tokio::test]
    async fn case_when_sql_with_arithmetic_in_aggregate() {
        use arrow::array::{Float64Array, Int32Array};
        use arrow::datatypes::{DataType, Field, Schema};
        use arrow::record_batch::RecordBatch;
        use datafusion::prelude::SessionContext;
        use std::sync::Arc;

        let input = "DIVIDE(SUM(fact_sales[unitprice] * fact_sales[orderqty]), SUM(fact_sales[orderqty]), 0)";
        let expr = parse_measure_expression(input).unwrap();

        let schema = Arc::new(Schema::new(vec![
            Field::new("unitprice", DataType::Float64, false),
            Field::new("orderqty", DataType::Float64, false),
            Field::new("categoryid", DataType::Int32, false),
        ]));
        let batch = RecordBatch::try_new(
            schema,
            vec![
                Arc::new(Float64Array::from(vec![10.0, 20.0, 30.0])),
                Arc::new(Float64Array::from(vec![1.0, 2.0, 3.0])),
                Arc::new(Int32Array::from(vec![1, 1, 2])),
            ],
        )
        .unwrap();

        let dim_schema = Arc::new(Schema::new(vec![
            Field::new("categoryid", DataType::Int32, false),
            Field::new("categoryname", DataType::Utf8, false),
        ]));
        let dim_batch = RecordBatch::try_new(
            dim_schema,
            vec![
                Arc::new(Int32Array::from(vec![1, 2])),
                Arc::new(arrow::array::StringArray::from(vec!["Bikes", "Parts"])),
            ],
        )
        .unwrap();

        let ctx = SessionContext::new();
        ctx.register_batch("fact_sales", batch).unwrap();
        ctx.register_batch("dim_category", dim_batch).unwrap();

        // to_case_when_sql must qualify columns inside arithmetic operands.
        let case_sql =
            expr.to_case_when_sql("dim_category.\"categoryname\" = 'Bikes'", "fact_sales");
        assert!(
            case_sql.contains("fact_sales.\"unitprice\" * fact_sales.\"orderqty\""),
            "columns inside arithmetic should be individually qualified, got: {case_sql}"
        );

        let sql = format!(
            "SELECT dim_category.\"categoryname\", {case_sql} AS result FROM fact_sales \
             JOIN dim_category ON fact_sales.\"categoryid\" = dim_category.\"categoryid\" \
             GROUP BY dim_category.\"categoryname\""
        );
        ctx.sql(&sql).await.unwrap().collect().await.unwrap();
    }

    #[test]
    fn parse_keep_context() {
        let expr = parse_measure_expression(
            "SUM(fact_sales[linetotal], KEEP(dim_date, dim_date[year] = 2014))",
        )
        .unwrap();
        assert!(expr.has_context_ops());
        assert!(expr.has_aggregate());
    }

    #[test]
    fn parse_keep_multiple_filters() {
        let expr = parse_measure_expression(
            "SUM(Sales[amount], KEEP(dim, dim[year] = 2024, dim[month] = 1))",
        )
        .unwrap();
        assert!(expr.has_context_ops());
        // Verify filters are captured.
        if let Expression::Keep { filters, .. } = &expr {
            assert_eq!(filters.len(), 2);
            assert_eq!(filters[0].table, "dim");
            assert_eq!(filters[0].column, "year");
            assert_eq!(filters[0].value, "2024");
            assert_eq!(filters[1].column, "month");
            assert_eq!(filters[1].value, "1");
        } else {
            panic!("expected Keep expression");
        }
    }

    #[test]
    fn parse_keep_with_string_value() {
        let expr = parse_measure_expression(
            r#"SUM(Sales[amount], KEEP(Products, Products[color] = "Red"))"#,
        )
        .unwrap();
        if let Expression::Keep { filters, .. } = &expr {
            assert_eq!(filters[0].value, "Red");
        } else {
            panic!("expected Keep expression");
        }
    }

    #[test]
    fn parse_keep_with_comparison_operators() {
        let expr =
            parse_measure_expression("SUM(Sales[amount], KEEP(dim, dim[year] >= 2020))").unwrap();
        if let Expression::Keep { filters, .. } = &expr {
            assert_eq!(filters[0].operator, ComparisonOp::GreaterThanOrEqual);
        } else {
            panic!("expected Keep expression");
        }
    }

    #[test]
    fn parse_clear_table() {
        let expr = parse_measure_expression("SUM(Sales[amount], CLEAR(Calendar))").unwrap();
        assert!(expr.has_context_ops());
        if let Expression::Clear { targets, .. } = &expr {
            assert_eq!(targets.len(), 1);
            assert!(matches!(&targets[0], ClearTarget::Table(t) if t == "Calendar"));
        } else {
            panic!("expected Clear expression");
        }
    }

    #[test]
    fn parse_clear_column() {
        let expr = parse_measure_expression("SUM(Sales[amount], CLEAR(Calendar[year]))").unwrap();
        if let Expression::Clear { targets, .. } = &expr {
            assert_eq!(targets.len(), 1);
            assert!(
                matches!(&targets[0], ClearTarget::Column { table, column } if table == "Calendar" && column == "year")
            );
        } else {
            panic!("expected Clear expression");
        }
    }

    #[test]
    fn parse_reset() {
        let expr = parse_measure_expression("SUM(Sales[amount], RESET())").unwrap();
        assert!(expr.has_context_ops());
        if let Expression::Reset { .. } = &expr {
            // ok
        } else {
            panic!("expected Reset expression");
        }
    }

    #[test]
    fn parse_using() {
        let expr = parse_measure_expression("SUM(Sales[amount], USING(bikes_2024))").unwrap();
        if let Expression::Using { context_name, .. } = &expr {
            assert_eq!(context_name, "bikes_2024");
        } else {
            panic!("expected Using expression");
        }
    }

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
    fn parse_numeric_literal() {
        let expr = parse_measure_expression("SUM(Sales[a]) * 100").unwrap();
        let sql = expr.to_sql_string();
        assert!(sql.contains("100"));
    }

    #[test]
    fn parse_float_literal() {
        let expr = parse_measure_expression("SUM(Sales[a]) * 1.5").unwrap();
        let sql = expr.to_sql_string();
        assert!(sql.contains("1.5"));
    }

    #[test]
    fn empty_input_returns_error() {
        assert!(parse_measure_expression("").is_err());
    }

    #[test]
    fn unknown_function_returns_error() {
        assert!(parse_measure_expression("BOGUS(Sales[a])").is_err());
    }

    #[test]
    fn unterminated_bracket_returns_error() {
        assert!(parse_measure_expression("SUM(Sales[amount)").is_err());
    }

    #[test]
    fn context_filter_tables_from_parsed_keep() {
        let expr = parse_measure_expression(
            "SUM(fact_sales[linetotal], KEEP(dim_date, dim_date[year] = 2014))",
        )
        .unwrap();
        let tables = expr.context_filter_tables();
        assert!(tables.contains(&"dim_date"));
    }

    // --- New function parsing tests ---

    #[test]
    fn parse_if_simple() {
        let expr =
            parse_measure_expression(r#"IF(SUM(Sales[amount]) > 1000, "High", "Low")"#).unwrap();
        assert_eq!(
            expr.to_sql_string(),
            "CASE WHEN (SUM(\"amount\") > 1000) THEN 'High' ELSE 'Low' END"
        );
        assert!(expr.has_aggregate());
    }

    #[test]
    fn parse_if_with_numeric_result() {
        let expr = parse_measure_expression("IF(SUM(S[a]) > 0, SUM(S[a]), 0)").unwrap();
        let sql = expr.to_sql_string();
        assert!(sql.starts_with("CASE WHEN"));
        assert!(sql.contains("SUM(\"a\")"));
    }

    #[test]
    fn parse_if_with_isblank() {
        let expr = parse_measure_expression(r#"IF(ISBLANK(SUM(S[a])), 0, SUM(S[a]))"#).unwrap();
        let sql = expr.to_sql_string();
        assert!(sql.contains("IS NULL"));
    }

    #[test]
    fn parse_switch() {
        let expr = parse_measure_expression(
            r#"SWITCH(SUM(S[status]), 1, "Active", 2, "Inactive", "Unknown")"#,
        )
        .unwrap();
        let sql = expr.to_sql_string();
        assert!(sql.contains("CASE SUM(\"status\")"));
        assert!(sql.contains("WHEN 1 THEN 'Active'"));
        assert!(sql.contains("WHEN 2 THEN 'Inactive'"));
        assert!(sql.contains("ELSE 'Unknown'"));
    }

    #[test]
    fn parse_divide() {
        let expr = parse_measure_expression("DIVIDE(SUM(S[revenue]), COUNT(S[orders]))").unwrap();
        let sql = expr.to_sql_string();
        assert!(sql.contains("CASE WHEN"));
        assert!(sql.contains("= 0"));
        assert!(sql.contains("CAST(SUM(\"revenue\") AS DOUBLE) / COUNT(\"orders\")"));
    }

    #[test]
    fn parse_divide_with_alternate() {
        let expr = parse_measure_expression("DIVIDE(SUM(S[a]), SUM(S[b]), 0)").unwrap();
        let sql = expr.to_sql_string();
        assert!(sql.contains("THEN 0 ELSE"));
    }

    #[test]
    fn parse_blank() {
        let expr = parse_measure_expression("BLANK()").unwrap();
        assert_eq!(expr.to_sql_string(), "NULL");
    }

    #[test]
    fn parse_isblank() {
        let expr = parse_measure_expression("ISBLANK(SUM(S[x]))").unwrap();
        assert_eq!(expr.to_sql_string(), "(SUM(\"x\") IS NULL)");
    }

    #[test]
    fn parse_coalesce() {
        let expr = parse_measure_expression("COALESCE(SUM(S[a]), 0)").unwrap();
        assert_eq!(expr.to_sql_string(), "COALESCE(SUM(\"a\"), 0)");
    }

    #[test]
    fn parse_coalesce_multiple() {
        let expr = parse_measure_expression("COALESCE(SUM(S[a]), SUM(S[b]), 0)").unwrap();
        assert_eq!(expr.to_sql_string(), "COALESCE(SUM(\"a\"), SUM(\"b\"), 0)");
    }

    #[test]
    fn parse_countrows() {
        let expr = parse_measure_expression("COUNTROWS(Sales)").unwrap();
        assert_eq!(expr.to_sql_string(), "COUNT(*)");
        assert!(expr.has_aggregate());
        assert!(expr.is_simple_aggregate());
    }

    #[test]
    fn parse_countrows_infer_table() {
        let expr = parse_measure("COUNTROWS(fact_sales)").unwrap();
        assert_eq!(infer_fact_table(&expr), Some("fact_sales".to_string()));
    }

    #[test]
    fn parse_abs() {
        let expr = parse_measure_expression("ABS(SUM(S[diff]))").unwrap();
        assert_eq!(expr.to_sql_string(), "ABS(SUM(\"diff\"))");
    }

    #[test]
    fn parse_round() {
        let expr = parse_measure_expression("ROUND(SUM(S[price]), 2)").unwrap();
        assert_eq!(expr.to_sql_string(), "ROUND(SUM(\"price\"), 2)");
    }

    #[test]
    fn parse_int() {
        let expr = parse_measure_expression("INT(SUM(S[value]))").unwrap();
        assert_eq!(expr.to_sql_string(), "FLOOR(SUM(\"value\"))");
    }

    #[test]
    fn parse_sqrt() {
        let expr = parse_measure_expression("SQRT(SUM(S[x]))").unwrap();
        assert_eq!(expr.to_sql_string(), "SQRT(SUM(\"x\"))");
    }

    #[test]
    fn parse_power() {
        let expr = parse_measure_expression("POWER(SUM(S[x]), 2)").unwrap();
        assert_eq!(expr.to_sql_string(), "POWER(SUM(\"x\"), 2)");
    }

    #[test]
    fn parse_nested_new_functions() {
        // ROUND(DIVIDE(SUM(S[a]), COUNT(S[b])), 2)
        let expr = parse_measure_expression("ROUND(DIVIDE(SUM(S[a]), COUNT(S[b])), 2)").unwrap();
        let sql = expr.to_sql_string();
        assert!(sql.starts_with("ROUND("));
        assert!(sql.contains("CASE WHEN"));
    }

    #[test]
    fn parse_if_with_divide() {
        let expr =
            parse_measure_expression("IF(COUNT(S[b]) > 0, DIVIDE(SUM(S[a]), COUNT(S[b])), 0)")
                .unwrap();
        let sql = expr.to_sql_string();
        assert!(sql.starts_with("CASE WHEN"));
        assert!(sql.contains("COUNT(\"b\") > 0"));
    }

    #[test]
    fn parse_countrows_infer_from_table_ref() {
        // COUNTROWS uses TableRef — infer_fact_table should find it
        let expr = parse_measure_expression("COUNTROWS(fact_sales)").unwrap();
        if let Expression::Aggregate { operand, .. } = &expr {
            assert!(matches!(operand.as_ref(), Expression::TableRef(t) if t == "fact_sales"));
        } else {
            panic!("expected Aggregate");
        }
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

    // --- Bare variable name as context argument ---

    #[test]
    fn parse_aggregate_with_bare_variable() {
        let expr = parse_measure_expression("SUM(fact_sales[linetotal], bikes)").unwrap();
        assert!(expr.has_context_ops());
        assert!(expr.has_aggregate());
        if let Expression::Keep {
            variables, filters, ..
        } = &expr
        {
            assert_eq!(variables.len(), 1);
            assert_eq!(variables[0], "bikes");
            assert!(filters.is_empty());
        } else {
            panic!("expected Keep expression wrapping aggregate, got {expr:?}");
        }
    }

    #[test]
    fn parse_aggregate_with_multiple_bare_variables() {
        let expr =
            parse_measure_expression("SUM(fact_sales[linetotal], bikes, year_2024)").unwrap();
        assert!(expr.has_context_ops());
        // Outer Keep should have year_2024, inner Keep should have bikes.
        if let Expression::Keep {
            variables,
            expr: inner,
            ..
        } = &expr
        {
            assert_eq!(variables, &["year_2024"]);
            if let Expression::Keep {
                variables: inner_vars,
                ..
            } = inner.as_ref()
            {
                assert_eq!(inner_vars, &["bikes"]);
            } else {
                panic!("expected nested Keep for first variable");
            }
        } else {
            panic!("expected Keep expression");
        }
    }

    #[test]
    fn parse_aggregate_with_variable_and_keep() {
        let expr = parse_measure_expression(
            r#"SUM(fact_sales[linetotal], bikes, KEEP(dim_date, dim_date[year] = 2024))"#,
        )
        .unwrap();
        assert!(expr.has_context_ops());
        // Outer should be Keep with explicit filters (from KEEP(...)).
        if let Expression::Keep {
            filters,
            variables,
            expr: inner,
            ..
        } = &expr
        {
            assert_eq!(filters.len(), 1);
            assert_eq!(filters[0].column, "year");
            assert!(variables.is_empty());
            // Inner should be Keep with variable "bikes".
            if let Expression::Keep {
                variables: inner_vars,
                ..
            } = inner.as_ref()
            {
                assert_eq!(inner_vars, &["bikes"]);
            } else {
                panic!("expected nested Keep for variable");
            }
        } else {
            panic!("expected Keep expression");
        }
    }

    // --- parse_context tests ---

    #[test]
    fn parse_context_single_keep() {
        let ctx = parse_context(
            "ctx_bikes",
            r#"KEEP(dim_product, dim_product[categoryname] = "Bikes")"#,
        )
        .unwrap();
        assert_eq!(ctx.name(), "ctx_bikes");
        assert_eq!(ctx.operations().len(), 1);
        match &ctx.operations()[0] {
            ContextOp::Keep(filters) => {
                assert_eq!(filters.len(), 1);
                assert_eq!(filters[0].table, "dim_product");
                assert_eq!(filters[0].column, "categoryname");
                assert_eq!(filters[0].value, "Bikes");
            }
            _ => panic!("expected Keep"),
        }
    }

    #[test]
    fn parse_context_multiple_keeps() {
        let ctx = parse_context(
            "ctx_bikes_2024",
            r#"KEEP(dim_product, dim_product[categoryname] = "Bikes"), KEEP(dim_date, dim_date[year] = 2024)"#,
        )
        .unwrap();
        assert_eq!(ctx.name(), "ctx_bikes_2024");
        assert_eq!(ctx.operations().len(), 2);
        assert!(matches!(&ctx.operations()[0], ContextOp::Keep(_)));
        assert!(matches!(&ctx.operations()[1], ContextOp::Keep(_)));
    }

    #[test]
    fn parse_context_inherit_and_keep() {
        let ctx = parse_context(
            "ctx_derived",
            r#"ctx_base, KEEP(dim_date, dim_date[year] = 2024)"#,
        )
        .unwrap();
        assert_eq!(ctx.operations().len(), 2);
        assert_eq!(ctx.operations()[0], ContextOp::Inherit("ctx_base".into()));
        assert!(matches!(&ctx.operations()[1], ContextOp::Keep(_)));
    }

    #[test]
    fn parse_context_clear() {
        let ctx = parse_context("all_time", "CLEAR(dim_date)").unwrap();
        assert_eq!(ctx.operations().len(), 1);
        match &ctx.operations()[0] {
            ContextOp::Clear(targets) => {
                assert_eq!(targets.len(), 1);
                assert!(matches!(&targets[0], ClearTarget::Table(t) if t == "dim_date"));
            }
            _ => panic!("expected Clear"),
        }
    }

    #[test]
    fn parse_context_clear_column() {
        let ctx = parse_context("no_year", "CLEAR(dim_date[year])").unwrap();
        match &ctx.operations()[0] {
            ContextOp::Clear(targets) => {
                assert!(matches!(
                    &targets[0],
                    ClearTarget::Column { table, column } if table == "dim_date" && column == "year"
                ));
            }
            _ => panic!("expected Clear"),
        }
    }

    #[test]
    fn parse_context_reset() {
        let ctx = parse_context("no_filters", "RESET()").unwrap();
        assert_eq!(ctx.operations().len(), 1);
        assert_eq!(ctx.operations()[0], ContextOp::Reset);
    }

    #[test]
    fn parse_context_clear_inner_outer() {
        let ctx = parse_context("test", "CLEAR_INNER(dim_date), CLEAR_OUTER(dim_product)").unwrap();
        assert_eq!(ctx.operations().len(), 2);
        assert!(matches!(&ctx.operations()[0], ContextOp::ClearInner(_)));
        assert!(matches!(&ctx.operations()[1], ContextOp::ClearOuter(_)));
    }

    #[test]
    fn parse_context_reset_inner_outer() {
        let ctx = parse_context("test", "RESET_INNER(), RESET_OUTER()").unwrap();
        assert_eq!(ctx.operations().len(), 2);
        assert_eq!(ctx.operations()[0], ContextOp::ResetInner);
        assert_eq!(ctx.operations()[1], ContextOp::ResetOuter);
    }

    #[test]
    fn parse_context_multiple_inherits() {
        let ctx = parse_context("combined", "ctx_bikes, ctx_2024").unwrap();
        assert_eq!(ctx.operations().len(), 2);
        assert_eq!(ctx.operations()[0], ContextOp::Inherit("ctx_bikes".into()));
        assert_eq!(ctx.operations()[1], ContextOp::Inherit("ctx_2024".into()));
    }

    #[test]
    fn parse_context_empty_input_fails() {
        assert!(parse_context("empty", "").is_err());
    }

    #[test]
    fn parse_context_keep_multiple_filters() {
        let ctx = parse_context(
            "road_bikes",
            r#"KEEP(dim_product, dim_product[categoryname] = "Bikes", dim_product[subcategoryname] = "Road Bikes")"#,
        )
        .unwrap();
        match &ctx.operations()[0] {
            ContextOp::Keep(filters) => {
                assert_eq!(filters.len(), 2);
                assert_eq!(filters[0].column, "categoryname");
                assert_eq!(filters[1].column, "subcategoryname");
            }
            _ => panic!("expected Keep"),
        }
    }

    // --- VAR/RETURN parser tests ---

    #[test]
    fn parse_var_return_simple() {
        let expr = parse_measure_expression("VAR total = SUM(Sales[amount]) RETURN total").unwrap();
        match &expr {
            Expression::Block { bindings, result } => {
                assert_eq!(bindings.len(), 1);
                assert_eq!(bindings[0].0, "total");
                assert!(bindings[0].1.has_aggregate());
                assert!(matches!(result.as_ref(), Expression::ColumnRef(name) if name == "total"));
            }
            _ => panic!("expected Block, got {expr:?}"),
        }
    }

    #[test]
    fn parse_var_return_multiple_bindings() {
        let expr = parse_measure_expression(
            "VAR revenue = SUM(Sales[amount]) VAR cost = SUM(Sales[cost]) RETURN revenue - cost",
        )
        .unwrap();
        match &expr {
            Expression::Block { bindings, result } => {
                assert_eq!(bindings.len(), 2);
                assert_eq!(bindings[0].0, "revenue");
                assert_eq!(bindings[1].0, "cost");
                assert!(matches!(result.as_ref(), Expression::BinaryOp { .. }));
            }
            _ => panic!("expected Block"),
        }
    }

    #[test]
    fn parse_var_return_with_divide() {
        let expr = parse_measure_expression(
            "VAR total = SUM(Sales[amount]) VAR cnt = COUNT(Sales[id]) RETURN DIVIDE(total, cnt)",
        )
        .unwrap();
        match &expr {
            Expression::Block { bindings, result } => {
                assert_eq!(bindings.len(), 2);
                assert!(matches!(result.as_ref(), Expression::SafeDivide { .. }));
            }
            _ => panic!("expected Block"),
        }
    }

    #[test]
    fn parse_var_return_inline_sql() {
        let expr = parse_measure_expression(
            "VAR total = SUM(Sales[amount]) VAR cnt = COUNT(Sales[id]) RETURN total / cnt",
        )
        .unwrap();
        // After inlining, should produce valid SQL.
        let sql = expr.to_sql_string();
        assert!(sql.contains("SUM"));
        assert!(sql.contains("COUNT"));
        assert!(sql.contains("/"));
    }

    #[test]
    fn parse_var_return_chained_references() {
        // B references A.
        let expr =
            parse_measure_expression("VAR a = SUM(Sales[amount]) VAR b = a * 2 RETURN b + 1")
                .unwrap();
        let sql = expr.to_sql_string();
        // After inlining: (SUM("amount") * 2) + 1
        assert!(sql.contains("SUM"));
        assert!(sql.contains("* 2"));
    }

    #[test]
    fn parse_var_return_with_context_ops() {
        let expr = parse_measure_expression(
            r#"VAR bikes = SUM(Sales[amount], KEEP(Products, Products[category] = "Bikes")) VAR total = SUM(Sales[amount]) RETURN DIVIDE(bikes, total)"#,
        )
        .unwrap();
        match &expr {
            Expression::Block { bindings, .. } => {
                assert_eq!(bindings.len(), 2);
                // First binding should have context ops.
                assert!(bindings[0].1.has_context_ops());
                // Second binding should not.
                assert!(!bindings[1].1.has_context_ops());
            }
            _ => panic!("expected Block"),
        }
    }

    #[test]
    fn parse_var_return_case_insensitive() {
        let expr =
            parse_measure_expression("var total = SUM(Sales[amount]) return total * 2").unwrap();
        assert!(matches!(expr, Expression::Block { .. }));
    }

    #[test]
    fn parse_var_return_infer_table() {
        let expr = parse_measure("VAR total = SUM(Sales[amount]) RETURN total").unwrap();
        assert_eq!(infer_fact_table(&expr), Some("Sales".to_string()));
    }

    #[test]
    fn parse_var_without_return_fails() {
        let result = parse_measure_expression("VAR total = SUM(Sales[amount])");
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("RETURN"));
    }

    #[test]
    fn parse_var_reserved_name_fails() {
        let result = parse_measure_expression("VAR RETURN = SUM(Sales[amount]) RETURN RETURN");
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("reserved"));
    }

    #[test]
    fn parse_var_return_with_scalar_functions() {
        let expr = parse_measure_expression(
            "VAR avg = DIVIDE(SUM(Sales[amount]), COUNT(Sales[id])) RETURN ROUND(avg, 2)",
        )
        .unwrap();
        let sql = expr.to_sql_string();
        assert!(sql.contains("ROUND"));
        assert!(sql.contains("SUM"));
    }

    // --- QUERY parser tests ---

    #[test]
    fn parse_query_simple() {
        let expr = parse_measure_expression(
            "VAR tbl = QUERY(SUM(Sales[amount]) AS revenue BY Date[year]) RETURN AVG(tbl[revenue])",
        )
        .unwrap();
        if let Expression::Block { bindings, result } = &expr {
            assert_eq!(bindings.len(), 1);
            assert_eq!(bindings[0].0, "tbl");
            if let Expression::Query {
                aggregates,
                group_by,
            } = &bindings[0].1
            {
                assert_eq!(aggregates.len(), 1);
                assert_eq!(aggregates[0].1, "revenue");
                assert_eq!(group_by.len(), 1);
                assert_eq!(group_by[0], ("Date".to_string(), "year".to_string()));
            } else {
                panic!("expected Query expression");
            }
            // Result should be AVG(tbl[revenue])
            assert!(result.has_aggregate());
        } else {
            panic!("expected Block expression");
        }
    }

    #[test]
    fn parse_query_multiple_aggregates() {
        let expr = parse_measure_expression(
            "VAR tbl = QUERY(SUM(Sales[amount]) AS rev, COUNT(Sales[id]) AS cnt BY Date[year]) RETURN DIVIDE(AVG(tbl[rev]), AVG(tbl[cnt]))",
        )
        .unwrap();
        if let Expression::Block { bindings, .. } = &expr {
            if let Expression::Query {
                aggregates,
                group_by,
            } = &bindings[0].1
            {
                assert_eq!(aggregates.len(), 2);
                assert_eq!(aggregates[0].1, "rev");
                assert_eq!(aggregates[1].1, "cnt");
                assert_eq!(group_by.len(), 1);
            } else {
                panic!("expected Query expression");
            }
        } else {
            panic!("expected Block expression");
        }
    }

    #[test]
    fn parse_query_multiple_group_by() {
        let expr = parse_measure_expression(
            "VAR monthly = QUERY(SUM(Sales[amount]) AS revenue BY Date[year], Date[month]) RETURN AVG(monthly[revenue])",
        )
        .unwrap();
        if let Expression::Block { bindings, .. } = &expr {
            if let Expression::Query { group_by, .. } = &bindings[0].1 {
                assert_eq!(group_by.len(), 2);
                assert_eq!(group_by[0], ("Date".to_string(), "year".to_string()));
                assert_eq!(group_by[1], ("Date".to_string(), "month".to_string()));
            } else {
                panic!("expected Query expression");
            }
        } else {
            panic!("expected Block expression");
        }
    }

    #[test]
    fn parse_query_case_insensitive() {
        // AS and BY should be case-insensitive
        let expr = parse_measure_expression(
            "VAR t = query(SUM(Sales[amount]) as revenue by Date[year]) RETURN AVG(t[revenue])",
        )
        .unwrap();
        assert!(matches!(&expr, Expression::Block { .. }));
    }

    #[test]
    fn parse_query_missing_as_fails() {
        let result = parse_measure_expression(
            "VAR t = QUERY(SUM(Sales[amount]) revenue BY Date[year]) RETURN AVG(t[revenue])",
        );
        assert!(result.is_err());
    }

    #[test]
    fn parse_query_missing_by_fails() {
        let result = parse_measure_expression(
            "VAR t = QUERY(SUM(Sales[amount]) AS revenue) RETURN AVG(t[revenue])",
        );
        assert!(result.is_err());
    }

    #[test]
    fn parse_query_infer_table() {
        // parse_measure should infer the fact table from the QUERY's aggregate
        let expr = parse_measure(
            "VAR tbl = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_date[year]) RETURN AVG(tbl[revenue])",
        )
        .unwrap();
        assert_eq!(infer_fact_table(&expr), Some("fact_sales".to_string()));
    }

    #[test]
    fn parse_query_has_query_bindings() {
        let expr = parse_measure_expression(
            "VAR tbl = QUERY(SUM(Sales[amount]) AS revenue BY Date[year]) RETURN AVG(tbl[revenue])",
        )
        .unwrap();
        assert!(expr.has_query_bindings());
    }

    #[test]
    fn parse_query_is_query_detection() {
        let q = expr::query_expr(
            vec![(
                expr::agg(AggregateOp::Sum, expr::col("amount")),
                "total".into(),
            )],
            vec![("Date".into(), "year".into())],
        );
        assert!(q.is_query());
        assert!(!expr::col("x").is_query());
    }

    #[test]
    fn parse_hasonevalue() {
        let expr = parse_measure_expression("HASONEVALUE(Products[category])").unwrap();
        assert_eq!(expr.to_sql_string(), "(COUNT(DISTINCT \"category\") = 1)");
    }

    #[test]
    fn parse_selectedvalue_no_alternate() {
        let expr = parse_measure_expression("SELECTEDVALUE(Products[category])").unwrap();
        assert_eq!(
            expr.to_sql_string(),
            "CASE WHEN COUNT(DISTINCT \"category\") = 1 THEN MIN(\"category\") ELSE NULL END"
        );
    }

    #[test]
    fn parse_selectedvalue_with_alternate() {
        let expr =
            parse_measure_expression("SELECTEDVALUE(Products[category], \"Multiple\")").unwrap();
        assert_eq!(
            expr.to_sql_string(),
            "CASE WHEN COUNT(DISTINCT \"category\") = 1 THEN MIN(\"category\") ELSE 'Multiple' END"
        );
    }

    #[test]
    fn parse_first_with_order_by() {
        let expr = parse_measure_expression("FIRST(Products[name], ORDER BY Products[sort_order])")
            .unwrap();
        assert_eq!(
            expr.to_sql_string(),
            "FIRST_VALUE(\"name\" ORDER BY \"sort_order\")"
        );
    }

    #[test]
    fn parse_first_without_order_by_keywords() {
        let expr = parse_measure_expression("FIRST(Products[name], Products[sort_order])").unwrap();
        assert_eq!(
            expr.to_sql_string(),
            "FIRST_VALUE(\"name\" ORDER BY \"sort_order\")"
        );
    }

    #[test]
    fn parse_hasonevalue_in_if() {
        let expr = parse_measure_expression(
            "IF(HASONEVALUE(Calendar[year]), SELECTEDVALUE(Calendar[year]), \"All\")",
        )
        .unwrap();
        let sql = expr.to_sql_string();
        assert!(sql.starts_with("CASE WHEN"));
        assert!(sql.contains("COUNT(DISTINCT \"year\") = 1"));
    }

    #[test]
    fn parse_selectedvalue_with_blank() {
        let expr = parse_measure_expression("SELECTEDVALUE(Calendar[year], BLANK())").unwrap();
        assert_eq!(
            expr.to_sql_string(),
            "CASE WHEN COUNT(DISTINCT \"year\") = 1 THEN MIN(\"year\") ELSE NULL END"
        );
    }

    // --- Logical function tests ---

    #[test]
    fn parse_and_function() {
        let expr = parse_measure_expression("IF(AND(SUM(t[a]) > 0, SUM(t[b]) > 0), 1, 0)").unwrap();
        let sql = expr.to_sql_string();
        assert!(sql.contains("AND"));
        assert!(sql.contains("SUM(\"a\") > 0"));
        assert!(sql.contains("SUM(\"b\") > 0"));
    }

    #[test]
    fn parse_or_function() {
        let expr =
            parse_measure_expression("IF(OR(SUM(t[a]) > 100, SUM(t[b]) > 100), 1, 0)").unwrap();
        let sql = expr.to_sql_string();
        assert!(sql.contains("OR"));
    }

    #[test]
    fn parse_not_function() {
        let expr = parse_measure_expression("IF(NOT(SUM(t[a]) = 0), 1, 0)").unwrap();
        let sql = expr.to_sql_string();
        assert!(sql.contains("NOT"));
    }

    #[test]
    fn parse_true_false_function() {
        let expr = parse_measure_expression("IF(SUM(t[a]) > 0, TRUE(), FALSE())").unwrap();
        let sql = expr.to_sql_string();
        assert!(sql.contains("TRUE"));
        assert!(sql.contains("FALSE"));
    }

    #[test]
    fn parse_true_false_bare() {
        let expr = parse_measure_expression("IF(SUM(t[a]) > 0, TRUE, FALSE)").unwrap();
        let sql = expr.to_sql_string();
        assert!(sql.contains("TRUE"));
        assert!(sql.contains("FALSE"));
    }

    #[test]
    fn parse_xor_function() {
        let expr = parse_measure_expression("IF(XOR(SUM(t[a]) > 0, SUM(t[b]) > 0), 1, 0)").unwrap();
        let sql = expr.to_sql_string();
        // XOR renders as (A AND NOT B) OR (NOT A AND B)
        assert!(sql.contains("AND NOT"));
    }

    #[test]
    fn parse_nested_logical_functions() {
        let expr = parse_measure_expression(
            "IF(AND(OR(SUM(t[a]) > 0, SUM(t[b]) > 0), NOT(SUM(t[c]) = 0)), 1, 0)",
        )
        .unwrap();
        let sql = expr.to_sql_string();
        assert!(sql.contains("AND"));
        assert!(sql.contains("OR"));
        assert!(sql.contains("NOT"));
    }

    // --- Text function parser tests ---

    #[test]
    fn parse_upper() {
        let expr = parse_measure_expression("UPPER(t[name])").unwrap();
        assert_eq!(expr.to_sql_string(), "UPPER(\"name\")");
    }

    #[test]
    fn parse_lower() {
        let expr = parse_measure_expression("LOWER(t[name])").unwrap();
        assert_eq!(expr.to_sql_string(), "LOWER(\"name\")");
    }

    #[test]
    fn parse_trim() {
        let expr = parse_measure_expression("TRIM(t[name])").unwrap();
        assert_eq!(expr.to_sql_string(), "TRIM(\"name\")");
    }

    #[test]
    fn parse_len() {
        let expr = parse_measure_expression("LEN(t[name])").unwrap();
        assert_eq!(expr.to_sql_string(), "LENGTH(\"name\")");
    }

    #[test]
    fn parse_left_right() {
        let expr = parse_measure_expression("LEFT(t[name], 3)").unwrap();
        assert_eq!(expr.to_sql_string(), "LEFT(\"name\", 3)");

        let expr = parse_measure_expression("RIGHT(t[name], 2)").unwrap();
        assert_eq!(expr.to_sql_string(), "RIGHT(\"name\", 2)");
    }

    #[test]
    fn parse_mid() {
        let expr = parse_measure_expression("MID(t[name], 2, 4)").unwrap();
        assert_eq!(expr.to_sql_string(), "SUBSTRING(\"name\" FROM 2 FOR 4)");
    }

    #[test]
    fn parse_concatenate_variadic() {
        let expr = parse_measure_expression("CONCATENATE(t[first], \" \", t[last])").unwrap();
        let sql = expr.to_sql_string();
        assert_eq!(sql, "CONCAT(\"first\", ' ', \"last\")");
    }

    #[test]
    fn parse_combinevalues() {
        let expr = parse_measure_expression("COMBINEVALUES(\"-\", t[a], t[b], t[c])").unwrap();
        assert_eq!(expr.to_sql_string(), "CONCAT_WS('-', \"a\", \"b\", \"c\")");
    }

    #[test]
    fn parse_find() {
        let expr = parse_measure_expression("FIND(\"x\", t[text])").unwrap();
        assert_eq!(expr.to_sql_string(), "STRPOS(\"text\", 'x')");
    }

    #[test]
    fn parse_search() {
        let expr = parse_measure_expression("SEARCH(\"x\", t[text])").unwrap();
        assert_eq!(expr.to_sql_string(), "STRPOS(LOWER(\"text\"), LOWER('x'))");
    }

    #[test]
    fn parse_substitute() {
        let expr = parse_measure_expression("SUBSTITUTE(t[text], \"old\", \"new\")").unwrap();
        assert_eq!(expr.to_sql_string(), "REPLACE(\"text\", 'old', 'new')");
    }

    #[test]
    fn parse_replace() {
        let expr = parse_measure_expression("REPLACE(t[text], 3, 2, \"XX\")").unwrap();
        assert_eq!(
            expr.to_sql_string(),
            "OVERLAY(\"text\" PLACING 'XX' FROM 3 FOR 2)"
        );
    }

    #[test]
    fn parse_rept() {
        let expr = parse_measure_expression("REPT(\"ab\", 3)").unwrap();
        assert_eq!(expr.to_sql_string(), "REPEAT('ab', 3)");
    }

    #[test]
    fn parse_exact() {
        let expr = parse_measure_expression("EXACT(t[a], t[b])").unwrap();
        assert_eq!(expr.to_sql_string(), "(\"a\" = \"b\")");
    }

    #[test]
    fn parse_value() {
        let expr = parse_measure_expression("VALUE(t[price_text])").unwrap();
        assert_eq!(expr.to_sql_string(), "CAST(\"price_text\" AS DOUBLE)");
    }

    #[test]
    fn parse_fixed() {
        let expr = parse_measure_expression("FIXED(SUM(t[amount]), 2)").unwrap();
        assert_eq!(
            expr.to_sql_string(),
            "CAST(ROUND(SUM(\"amount\"), 2) AS VARCHAR)"
        );
    }

    #[test]
    fn parse_unichar_unicode() {
        let expr = parse_measure_expression("UNICHAR(65)").unwrap();
        assert_eq!(expr.to_sql_string(), "CHR(65)");

        let expr = parse_measure_expression("UNICODE(\"A\")").unwrap();
        assert_eq!(expr.to_sql_string(), "ASCII('A')");
    }

    #[test]
    fn parse_ltrim_rtrim() {
        let expr = parse_measure_expression("LTRIM(t[name])").unwrap();
        assert_eq!(expr.to_sql_string(), "LTRIM(\"name\")");
        let expr = parse_measure_expression("LTRIM(t[name], \"0#\")").unwrap();
        assert_eq!(expr.to_sql_string(), "LTRIM(\"name\", '0#')");
        let expr = parse_measure_expression("RTRIM(t[price], \"0.\")").unwrap();
        assert_eq!(expr.to_sql_string(), "RTRIM(\"price\", '0.')");
    }

    #[test]
    fn parse_lpad_rpad() {
        let expr = parse_measure_expression("LPAD(t[id], 5, \"0\")").unwrap();
        assert_eq!(expr.to_sql_string(), "LPAD(\"id\", 5, '0')");
        let expr = parse_measure_expression("RPAD(t[code], 10)").unwrap();
        assert_eq!(expr.to_sql_string(), "RPAD(\"code\", 10)");
    }

    #[test]
    fn parse_reverse() {
        let expr = parse_measure_expression("REVERSE(t[name])").unwrap();
        assert_eq!(expr.to_sql_string(), "REVERSE(\"name\")");
    }

    #[test]
    fn parse_split() {
        let expr = parse_measure_expression("SPLIT(t[path], \"/\", 2)").unwrap();
        assert_eq!(expr.to_sql_string(), "SPLIT_PART(\"path\", '/', 2)");
    }

    #[test]
    fn parse_text_in_if() {
        let expr =
            parse_measure_expression("IF(LEN(t[name]) > 10, LEFT(t[name], 10), t[name])").unwrap();
        let sql = expr.to_sql_string();
        assert!(sql.contains("LENGTH"));
        assert!(sql.contains("LEFT"));
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

    // --- Measure reference tests ---

    #[test]
    fn parse_bare_measure_ref() {
        let expr = parse_measure_expression("[TotalSales]").unwrap();
        assert!(matches!(expr, Expression::MeasureRef(ref name) if name == "TotalSales"));
    }

    #[test]
    fn parse_measure_ref_with_keep() {
        let expr = parse_measure_expression("[TotalSales](KEEP(dim, dim[year] = 2014))").unwrap();
        assert!(matches!(expr, Expression::Keep { .. }));
        if let Expression::Keep { expr: inner, .. } = &expr {
            assert!(matches!(**inner, Expression::MeasureRef(ref n) if n == "TotalSales"));
        }
    }

    #[test]
    fn parse_measure_ref_with_userelationship() {
        let expr = parse_measure_expression("[TotalSales](USERELATIONSHIP(\"Sales_Dates_Ship\"))")
            .unwrap();
        assert!(matches!(expr, Expression::UseRelationship { .. }));
        if let Expression::UseRelationship {
            expr: inner,
            relationship_name,
        } = &expr
        {
            assert!(matches!(**inner, Expression::MeasureRef(ref n) if n == "TotalSales"));
            assert_eq!(relationship_name, "Sales_Dates_Ship");
        }
    }

    #[test]
    fn parse_measure_ref_with_multiple_context_ops() {
        let expr = parse_measure_expression(
            "[TotalSales](USERELATIONSHIP(\"rel\"), KEEP(dim, dim[y] = 2024))",
        )
        .unwrap();
        // Outer should be Keep (last context arg wraps outermost)
        assert!(matches!(expr, Expression::Keep { .. }));
        if let Expression::Keep { expr: inner, .. } = &expr {
            // Inner should be UseRelationship
            assert!(matches!(**inner, Expression::UseRelationship { .. }));
        }
    }

    #[test]
    fn parse_measure_ref_in_arithmetic() {
        let expr = parse_measure_expression("[A] + [B]").unwrap();
        assert!(matches!(expr, Expression::BinaryOp { .. }));
        if let Expression::BinaryOp { left, right, .. } = &expr {
            assert!(matches!(**left, Expression::MeasureRef(ref n) if n == "A"));
            assert!(matches!(**right, Expression::MeasureRef(ref n) if n == "B"));
        }
    }

    // --- Window function parser tests ---

    #[test]
    fn parse_window_basic() {
        let expr =
            parse_measure_expression("WINDOW(SUM(fact[amount]), SUM, ORDERBY(dim_date[month]))")
                .unwrap();
        if let Expression::Window {
            inner,
            function,
            order_by,
            partition_by,
            frame,
        } = &expr
        {
            assert!(matches!(**inner, Expression::Aggregate { .. }));
            assert_eq!(*function, AggregateOp::Sum);
            assert_eq!(order_by, &[("dim_date".to_string(), "month".to_string())]);
            assert!(partition_by.is_empty());
            assert!(frame.is_none());
        } else {
            panic!("expected Window, got {expr:?}");
        }
    }

    #[test]
    fn parse_window_with_partitionby() {
        let expr = parse_measure_expression(
            "WINDOW(SUM(fact[amount]), AVG, ORDERBY(dim_date[month]), PARTITIONBY(dim_date[year]))",
        )
        .unwrap();
        if let Expression::Window {
            function,
            order_by,
            partition_by,
            ..
        } = &expr
        {
            assert_eq!(*function, AggregateOp::Average);
            assert_eq!(order_by.len(), 1);
            assert_eq!(
                partition_by,
                &[("dim_date".to_string(), "year".to_string())]
            );
        } else {
            panic!("expected Window");
        }
    }

    #[test]
    fn parse_window_with_rows() {
        let expr = parse_measure_expression(
            "WINDOW(SUM(fact[amount]), AVG, ORDERBY(dim[month]), ROWS(-2, REL, 0, REL))",
        )
        .unwrap();
        if let Expression::Window { frame, .. } = &expr {
            let f = frame.as_ref().expect("frame should be present");
            assert_eq!(f.from, -2);
            assert_eq!(f.from_type, crate::compute::expression::BoundaryType::Rel);
            assert_eq!(f.to, 0);
            assert_eq!(f.to_type, crate::compute::expression::BoundaryType::Rel);
        } else {
            panic!("expected Window");
        }
    }

    #[test]
    fn parse_window_with_partitionby_and_rows() {
        let expr = parse_measure_expression(
            "WINDOW(SUM(fact[x]), SUM, ORDERBY(d[m]), PARTITIONBY(d[y]), ROWS(1, ABS, 0, REL))",
        )
        .unwrap();
        if let Expression::Window {
            partition_by,
            frame,
            ..
        } = &expr
        {
            assert_eq!(partition_by.len(), 1);
            let f = frame.as_ref().unwrap();
            assert_eq!(f.from, 1);
            assert_eq!(f.from_type, crate::compute::expression::BoundaryType::Abs);
        } else {
            panic!("expected Window");
        }
    }

    #[test]
    fn parse_offset_basic() {
        let expr =
            parse_measure_expression("OFFSET(SUM(fact[amount]), -1, ORDERBY(dim_date[month]))")
                .unwrap();
        if let Expression::Offset {
            delta,
            order_by,
            partition_by,
            ..
        } = &expr
        {
            assert_eq!(*delta, -1);
            assert_eq!(order_by.len(), 1);
            assert!(partition_by.is_empty());
        } else {
            panic!("expected Offset, got {expr:?}");
        }
    }

    #[test]
    fn parse_offset_with_partitionby() {
        let expr =
            parse_measure_expression("OFFSET(SUM(fact[x]), -1, ORDERBY(d[m]), PARTITIONBY(d[y]))")
                .unwrap();
        if let Expression::Offset {
            delta,
            partition_by,
            ..
        } = &expr
        {
            assert_eq!(*delta, -1);
            assert_eq!(partition_by.len(), 1);
        } else {
            panic!("expected Offset");
        }
    }

    #[test]
    fn parse_offset_positive_delta() {
        let expr = parse_measure_expression("OFFSET(SUM(fact[x]), 2, ORDERBY(d[m]))").unwrap();
        if let Expression::Offset { delta, .. } = &expr {
            assert_eq!(*delta, 2);
        } else {
            panic!("expected Offset");
        }
    }

    #[test]
    fn parse_index_basic() {
        let expr =
            parse_measure_expression("INDEX(SUM(fact[amount]), 1, ORDERBY(dim_date[month]))")
                .unwrap();
        if let Expression::Index {
            position,
            order_by,
            partition_by,
            ..
        } = &expr
        {
            assert_eq!(*position, 1);
            assert_eq!(order_by.len(), 1);
            assert!(partition_by.is_empty());
        } else {
            panic!("expected Index, got {expr:?}");
        }
    }

    #[test]
    fn parse_index_negative_position() {
        let expr = parse_measure_expression("INDEX(SUM(fact[x]), -1, ORDERBY(d[m]))").unwrap();
        if let Expression::Index { position, .. } = &expr {
            assert_eq!(*position, -1);
        } else {
            panic!("expected Index");
        }
    }

    #[test]
    fn parse_index_with_partitionby() {
        let expr =
            parse_measure_expression("INDEX(SUM(fact[x]), 1, ORDERBY(d[m]), PARTITIONBY(d[y]))")
                .unwrap();
        if let Expression::Index { partition_by, .. } = &expr {
            assert_eq!(partition_by.len(), 1);
        } else {
            panic!("expected Index");
        }
    }

    #[test]
    fn parse_window_multiple_orderby_cols() {
        let expr = parse_measure_expression("WINDOW(SUM(f[x]), SUM, ORDERBY(d[y], d[m]))").unwrap();
        if let Expression::Window { order_by, .. } = &expr {
            assert_eq!(order_by.len(), 2);
            assert_eq!(order_by[0], ("d".to_string(), "y".to_string()));
            assert_eq!(order_by[1], ("d".to_string(), "m".to_string()));
        } else {
            panic!("expected Window");
        }
    }

    // --- KEEP expression condition tests ---

    #[test]
    fn parse_keep_simple_filter_still_works() {
        // Existing simple filter syntax should still produce FilterPredicate.
        let expr =
            parse_measure_expression("SUM(fact[amount], KEEP(dim, dim[year] = 2024))").unwrap();
        if let Expression::Keep {
            filters,
            conditions,
            ..
        } = &expr
        {
            assert_eq!(filters.len(), 1);
            assert_eq!(filters[0].column, "year");
            assert_eq!(filters[0].value, "2024");
            assert!(conditions.is_empty());
        } else {
            panic!("expected Keep, got {expr:?}");
        }
    }

    #[test]
    fn parse_keep_expression_condition_column_vs_column() {
        let expr = parse_measure_expression("SUM(fact[amount], KEEP(dim, dim[price] > dim[cost]))")
            .unwrap();
        if let Expression::Keep {
            filters,
            conditions,
            ..
        } = &expr
        {
            // dim[price] > dim[cost] has an expression on the right, not a literal
            assert!(filters.is_empty());
            assert_eq!(conditions.len(), 1);
            assert!(matches!(&conditions[0], Expression::Comparison { .. }));
        } else {
            panic!("expected Keep, got {expr:?}");
        }
    }

    #[test]
    fn parse_keep_expression_condition_with_arithmetic() {
        let expr =
            parse_measure_expression("SUM(fact[amount], KEEP(dim, dim[price] > dim[cost] * 1.5))")
                .unwrap();
        if let Expression::Keep {
            filters,
            conditions,
            ..
        } = &expr
        {
            assert!(filters.is_empty());
            assert_eq!(conditions.len(), 1);
        } else {
            panic!("expected Keep");
        }
    }

    #[test]
    fn parse_keep_mixed_simple_and_expression() {
        let expr =
            parse_measure_expression("SUM(fact[x], KEEP(d, d[year] = 2024, d[price] > d[cost]))")
                .unwrap();
        if let Expression::Keep {
            filters,
            conditions,
            ..
        } = &expr
        {
            // d[year] = 2024 → FilterPredicate (literal on right)
            assert_eq!(filters.len(), 1);
            assert_eq!(filters[0].column, "year");
            // d[price] > d[cost] → expression condition
            assert_eq!(conditions.len(), 1);
        } else {
            panic!("expected Keep");
        }
    }

    #[test]
    fn parse_keep_string_filter_still_works() {
        let expr =
            parse_measure_expression("SUM(fact[x], KEEP(dim, dim[name] = \"Bikes\"))").unwrap();
        if let Expression::Keep {
            filters,
            conditions,
            ..
        } = &expr
        {
            assert_eq!(filters.len(), 1);
            assert_eq!(filters[0].value, "Bikes");
            assert!(conditions.is_empty());
        } else {
            panic!("expected Keep");
        }
    }

    // --- KEEP with IN operator tests ---

    #[test]
    fn parse_keep_in_literal_list() {
        let expr = parse_measure_expression(
            "SUM(fact[amount], KEEP(dim, dim[color] IN {\"Blue\", \"Red\", \"Black\"}))",
        )
        .unwrap();
        if let Expression::Keep { conditions, .. } = &expr {
            assert_eq!(conditions.len(), 1);
            if let Expression::InList {
                expr: inner,
                values,
            } = &conditions[0]
            {
                assert!(matches!(**inner, Expression::QualifiedColumnRef { .. }));
                assert_eq!(values.len(), 3);
            } else {
                panic!("expected InList condition, got {:?}", conditions[0]);
            }
        } else {
            panic!("expected Keep, got {expr:?}");
        }
    }

    #[test]
    fn parse_keep_in_numeric_list() {
        let expr =
            parse_measure_expression("SUM(fact[x], KEEP(dim, dim[year] IN {2020, 2021, 2022}))")
                .unwrap();
        if let Expression::Keep { conditions, .. } = &expr {
            assert_eq!(conditions.len(), 1);
            if let Expression::InList { values, .. } = &conditions[0] {
                assert_eq!(values.len(), 3);
            } else {
                panic!("expected InList");
            }
        } else {
            panic!("expected Keep");
        }
    }

    #[test]
    fn parse_keep_in_variable() {
        let expr = parse_measure_expression(
            "SUM(fact[amount], KEEP(dim, fact[product_id] IN premium[id]))",
        )
        .unwrap();
        if let Expression::Keep { in_predicates, .. } = &expr {
            assert_eq!(in_predicates.len(), 1);
            assert_eq!(in_predicates[0].table, "fact");
            assert_eq!(in_predicates[0].column, "product_id");
            assert_eq!(in_predicates[0].var_name, "premium");
            assert_eq!(in_predicates[0].var_column, "id");
        } else {
            panic!("expected Keep with in_predicates, got {expr:?}");
        }
    }

    #[test]
    fn parse_keep_mixed_filter_and_in_list() {
        let expr = parse_measure_expression(
            "SUM(fact[x], KEEP(d, d[year] = 2024, d[color] IN {\"Blue\", \"Red\"}))",
        )
        .unwrap();
        if let Expression::Keep {
            filters,
            conditions,
            ..
        } = &expr
        {
            assert_eq!(filters.len(), 1);
            assert_eq!(filters[0].column, "year");
            assert_eq!(conditions.len(), 1);
            assert!(matches!(&conditions[0], Expression::InList { .. }));
        } else {
            panic!("expected Keep");
        }
    }

    #[test]
    fn parse_keep_in_list_sql_rendering() {
        let inlist = Expression::InList {
            expr: Box::new(expr::qualified_col("dim", "color")),
            values: vec![
                Expression::LiteralString("Blue".into()),
                Expression::LiteralString("Red".into()),
            ],
        };
        assert_eq!(inlist.to_sql_string(), "\"color\" IN ('Blue', 'Red')");
    }
}
