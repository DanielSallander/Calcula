//! FILENAME: core/pivot-engine/src/calculated.rs
//! Expression evaluator for calculated fields with Visual Calculation support.
//!
//! Supports:
//! - Arithmetic: +, -, *, /, parentheses, numeric literals, unary negation
//! - String literals ("...") and text concatenation (&)
//! - Comparison operators: >, <, >=, <=, =, <> (yield booleans)
//! - Transformation functions (post-aggregation, no visual context required):
//!   - Conditional: IF, SWITCH
//!   - Boolean: AND, OR, NOT
//!   - Scalar math: ABS, ROUND, MIN, MAX, CEILING, FLOOR, SQRT, MOD, INT, SIGN, POWER
//!   - Text: CONCAT, LEFT, RIGHT, LEN, MID, UPPER, LOWER, TRIM, TEXT
//! - Field references: bare, 'quoted', [bracketed]
//! - Visual Calculation functions:
//!   - Window: RUNNINGSUM, MOVINGAVERAGE, PREVIOUS, NEXT, FIRST, LAST
//!   - Hierarchy: COLLAPSE, COLLAPSEALL, EXPAND, EXPANDALL
//! - Reset parameter: NONE, HIGHESTPARENT, LOWESTPARENT, field name, or integer
//!
//! Expressions evaluate to a polymorphic [`CalcValue`] (number/text/bool/blank/error)
//! so that IF/SWITCH and text functions can return labels, not just numbers. Field
//! references and visual-calc functions remain numeric.

use std::cmp::Ordering;
use std::collections::HashMap;
use crate::engine::FlatAxisItem;

// ============================================================================
// AST
// ============================================================================

/// A node in the expression tree.
#[derive(Debug, Clone)]
pub enum CalcExpr {
    /// A numeric literal (e.g., 100, 3.14).
    Number(f64),

    /// A string literal (e.g., "High"). Written with double quotes in the DSL,
    /// distinct from 'single-quoted' field names.
    Str(String),

    /// A reference to a named field or item (resolved at evaluation time).
    Reference(String),

    /// Binary operation: left op right.
    BinOp {
        op: CalcOp,
        left: Box<CalcExpr>,
        right: Box<CalcExpr>,
    },

    /// Comparison: left op right, yields a boolean.
    Compare {
        op: CmpOp,
        left: Box<CalcExpr>,
        right: Box<CalcExpr>,
    },

    /// Unary negation.
    Negate(Box<CalcExpr>),

    /// Function call: RUNNINGSUM([Sales], HIGHESTPARENT)
    FunctionCall {
        name: String,
        args: Vec<CalcExpr>,
    },
}

/// Binary operators.
#[derive(Debug, Clone, Copy)]
pub enum CalcOp {
    Add,
    Sub,
    Mul,
    Div,
    /// Exponentiation (`^`), right-associative; unary minus binds tighter.
    Pow,
    /// Text concatenation (`&`).
    Concat,
}

/// Comparison operators.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CmpOp {
    Gt,
    Lt,
    Ge,
    Le,
    Eq,
    Ne,
}

// ============================================================================
// CALC VALUE (polymorphic result of an expression)
// ============================================================================

/// A value produced by evaluating a calculated-field expression.
///
/// Post-aggregation CALC used to be pure `f64`; transformation functions such as
/// IF/SWITCH and the text functions can now yield text and booleans, so evaluation
/// carries a tagged value. `Error` holds a spreadsheet-style error CODE WITHOUT the
/// leading `#` (e.g. `"DIV/0!"`); the `#` is added when it reaches the cell layer,
/// matching the existing `PivotCellValue::Error` convention.
#[derive(Debug, Clone, PartialEq)]
pub enum CalcValue {
    Number(f64),
    Text(String),
    Bool(bool),
    Blank,
    Error(String),
}

impl CalcValue {
    /// Coerce to a number for arithmetic/comparison (Excel/DAX-like):
    /// bool -> 1/0, blank -> 0, numeric text -> parsed, else `Err("VALUE!")`.
    /// An existing `Error` propagates its own code.
    pub fn as_number(&self) -> Result<f64, String> {
        match self {
            CalcValue::Number(n) => Ok(*n),
            CalcValue::Bool(b) => Ok(if *b { 1.0 } else { 0.0 }),
            CalcValue::Blank => Ok(0.0),
            CalcValue::Text(s) => s.trim().parse::<f64>().map_err(|_| "VALUE!".to_string()),
            CalcValue::Error(e) => Err(e.clone()),
        }
    }

    /// Coerce to display text. Numbers trim trailing zeros; bools -> TRUE/FALSE.
    pub fn as_text(&self) -> String {
        match self {
            // Round to 10 decimals before display so float artifacts
            // (0.1 + 0.2 -> 0.30000000000000004) don't leak into labels.
            CalcValue::Number(n) => {
                if n.fract() == 0.0 || !n.is_finite() {
                    format!("{}", n)
                } else {
                    let s = format!("{:.10}", n);
                    let s = s.trim_end_matches('0').trim_end_matches('.');
                    s.to_string()
                }
            }
            CalcValue::Text(s) => s.clone(),
            CalcValue::Bool(b) => if *b { "TRUE".to_string() } else { "FALSE".to_string() },
            CalcValue::Blank => String::new(),
            CalcValue::Error(e) => format!("#{}", e),
        }
    }

    /// Truthiness for IF/AND/OR/NOT conditions.
    pub fn truthy(&self) -> bool {
        match self {
            CalcValue::Number(n) => *n != 0.0 && !n.is_nan(),
            CalcValue::Bool(b) => *b,
            CalcValue::Text(s) => !s.is_empty(),
            CalcValue::Blank => false,
            CalcValue::Error(_) => false,
        }
    }

    /// True if this is an `Error` value (used for short-circuit propagation).
    pub fn is_error(&self) -> bool {
        matches!(self, CalcValue::Error(_))
    }
}

// ============================================================================
// VISUAL CALC CONTEXT
// ============================================================================

/// Context for evaluating visual calculation functions.
/// Provides access to other rows' and columns' values and the axis hierarchy.
pub(crate) struct VisualCalcContext<'a> {
    /// Index of the current row in row_items.
    pub(crate) current_row_idx: usize,

    /// All flattened row items (for hierarchy traversal and partition detection).
    pub(crate) row_items: &'a [FlatAxisItem],

    /// Pre-computed value maps for every row: row_values[row_idx][field_name] = f64.
    pub(crate) row_values: &'a [HashMap<String, f64>],

    /// Row field names by depth (for field-level reset resolution).
    pub(crate) field_names_by_depth: &'a [String],

    /// Grand-total value map, computed even when the grand-total row is
    /// hidden, so GRANDTOTAL/PARENT-at-top work regardless of layout.
    pub(crate) grand_total_values: Option<&'a HashMap<String, f64>>,

    /// Column axis context (for COLUMNS axis mode).
    /// When present, enables window functions to traverse columns.
    pub(crate) col_ctx: Option<ColumnAxisContext<'a>>,
}

/// Column axis context for COLUMNS-direction window functions.
pub(crate) struct ColumnAxisContext<'a> {
    /// Index of the current column in col_items.
    pub(crate) current_col_idx: usize,

    /// All flattened column items.
    pub(crate) col_items: &'a [FlatAxisItem],

    /// Pre-computed value maps for every column at the current row:
    /// col_values[col_idx][field_name] = f64.
    pub(crate) col_values: &'a [HashMap<String, f64>],

    /// Column field names by depth (for field-level reset on the COLUMNS axis).
    pub(crate) field_names_by_depth: &'a [String],
}

/// Axis direction for window functions.
#[derive(Debug, Clone, Copy, PartialEq)]
enum AxisMode {
    Rows,
    Columns,
}

/// Reset mode for window functions.
#[derive(Debug, Clone)]
enum ResetMode {
    /// No reset — entire axis is one partition.
    None,
    /// Reset at the highest (outermost) group level.
    HighestParent,
    /// Reset at the immediate parent level.
    LowestParent,
    /// Reset at a specific depth level.
    DepthLevel(usize),
}

// ============================================================================
// TOKENIZER
// ============================================================================

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Number(f64),
    Ident(String),
    /// Double-quoted string literal ("High").
    Str(String),
    Plus,
    Minus,
    Star,
    Slash,
    /// Exponentiation operator (^).
    Caret,
    /// Text concatenation operator (&).
    Amp,
    Gt,
    Lt,
    Ge,
    Le,
    Eq,
    Ne,
    LParen,
    RParen,
    Comma,
    Eof,
}

struct Tokenizer {
    chars: Vec<char>,
    pos: usize,
}

impl Tokenizer {
    fn new(input: &str) -> Self {
        Tokenizer {
            chars: input.chars().collect(),
            pos: 0,
        }
    }

    fn peek_char(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn next_char(&mut self) -> Option<char> {
        let ch = self.chars.get(self.pos).copied();
        if ch.is_some() {
            self.pos += 1;
        }
        ch
    }

    fn skip_whitespace(&mut self) {
        while let Some(ch) = self.peek_char() {
            if ch.is_whitespace() {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn tokenize(&mut self) -> Result<Vec<Token>, String> {
        let mut tokens = Vec::new();

        loop {
            self.skip_whitespace();
            match self.peek_char() {
                None => {
                    tokens.push(Token::Eof);
                    return Ok(tokens);
                }
                Some(ch) => match ch {
                    '+' => { self.next_char(); tokens.push(Token::Plus); }
                    '-' => { self.next_char(); tokens.push(Token::Minus); }
                    '*' => { self.next_char(); tokens.push(Token::Star); }
                    '/' => { self.next_char(); tokens.push(Token::Slash); }
                    '^' => { self.next_char(); tokens.push(Token::Caret); }
                    '&' => { self.next_char(); tokens.push(Token::Amp); }
                    '(' => { self.next_char(); tokens.push(Token::LParen); }
                    ')' => { self.next_char(); tokens.push(Token::RParen); }
                    ',' => { self.next_char(); tokens.push(Token::Comma); }
                    '=' => { self.next_char(); tokens.push(Token::Eq); }
                    '>' => {
                        self.next_char();
                        if self.peek_char() == Some('=') {
                            self.next_char();
                            tokens.push(Token::Ge);
                        } else {
                            tokens.push(Token::Gt);
                        }
                    }
                    '<' => {
                        self.next_char();
                        match self.peek_char() {
                            Some('=') => { self.next_char(); tokens.push(Token::Le); }
                            Some('>') => { self.next_char(); tokens.push(Token::Ne); }
                            _ => tokens.push(Token::Lt),
                        }
                    }
                    '"' => {
                        // Double-quoted string literal: "High". Distinct from the
                        // single-quoted field-name form below. A doubled quote ("")
                        // inside the literal is an escaped literal quote (Excel style).
                        self.next_char(); // skip opening quote
                        let mut s = String::new();
                        loop {
                            match self.next_char() {
                                Some('"') => {
                                    if self.peek_char() == Some('"') {
                                        self.next_char();
                                        s.push('"');
                                    } else {
                                        break;
                                    }
                                }
                                Some(c) => s.push(c),
                                None => return Err("Unterminated string literal".to_string()),
                            }
                        }
                        tokens.push(Token::Str(s));
                    }
                    '\'' => {
                        // Quoted identifier: 'Field Name With Spaces'
                        self.next_char(); // skip opening quote
                        let mut name = String::new();
                        loop {
                            match self.next_char() {
                                Some('\'') => break,
                                Some(c) => name.push(c),
                                None => return Err("Unterminated quoted field name".to_string()),
                            }
                        }
                        tokens.push(Token::Ident(name));
                    }
                    '[' => {
                        // Bracket identifier: [MeasureName] (BI model measures)
                        self.next_char(); // skip opening bracket
                        let mut name = String::new();
                        loop {
                            match self.next_char() {
                                Some(']') => break,
                                Some(c) => name.push(c),
                                None => return Err("Unterminated bracket field name".to_string()),
                            }
                        }
                        // Store with brackets so it matches BI value field names like "[TotalSales]"
                        tokens.push(Token::Ident(format!("[{}]", name)));
                    }
                    c if c.is_ascii_digit() || c == '.' => {
                        let mut num_str = String::new();
                        while let Some(c) = self.peek_char() {
                            if c.is_ascii_digit() || c == '.' {
                                num_str.push(c);
                                self.next_char();
                            } else {
                                break;
                            }
                        }
                        let val = num_str.parse::<f64>()
                            .map_err(|_| format!("Invalid number: {}", num_str))?;
                        tokens.push(Token::Number(val));
                    }
                    c if c.is_alphanumeric() || c == '_' => {
                        // Unquoted identifier — but DON'T greedily consume spaces
                        // if followed by '(' (function call) or ',' (argument separator).
                        // '.' is an identifier character so BI "table.column" field
                        // names tokenize as a single reference.
                        let mut name = String::new();
                        while let Some(c) = self.peek_char() {
                            if c.is_alphanumeric() || c == '_' || c == '.' {
                                name.push(c);
                                self.next_char();
                            } else if c == ' ' {
                                // Peek ahead: if next non-space is alphanumeric, include the space
                                // (allows "Total Sales" as a field name). But stop if next
                                // non-space is an operator, paren, or comma.
                                let rest = &self.chars[self.pos..];
                                let next_non_space = rest.iter().skip(1).find(|&&c| c != ' ');
                                if let Some(&nc) = next_non_space {
                                    if nc.is_alphanumeric() || nc == '_' {
                                        name.push(c);
                                        self.next_char();
                                    } else {
                                        break;
                                    }
                                } else {
                                    break;
                                }
                            } else {
                                break;
                            }
                        }
                        tokens.push(Token::Ident(name.trim_end().to_string()));
                    }
                    _ => {
                        return Err(format!("Unexpected character: '{}'", ch));
                    }
                }
            }
        }
    }
}

// ============================================================================
// PARSER (Recursive Descent)
// ============================================================================

/// Maximum nesting depth for user formulas. The parser and evaluator are
/// recursive; this bound turns hostile/pathological nesting into a clean
/// error instead of a stack overflow (which would abort the process).
const MAX_PARSE_DEPTH: usize = 256;

/// Maximum formula length in characters. Besides sanity, this bounds the
/// depth of left-leaning operator chains (a+a+a+...) which recurse in the
/// evaluator even though the parser builds them iteratively.
const MAX_FORMULA_LEN: usize = 4096;

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
    depth: usize,
}

impl Parser {
    fn new(tokens: Vec<Token>) -> Self {
        Parser { tokens, pos: 0, depth: 0 }
    }

    fn peek(&self) -> &Token {
        self.tokens.get(self.pos).unwrap_or(&Token::Eof)
    }

    fn advance(&mut self) -> Token {
        let tok = self.tokens.get(self.pos).cloned().unwrap_or(Token::Eof);
        self.pos += 1;
        tok
    }

    /// Guard for the recursive-descent entry points.
    fn enter(&mut self) -> Result<(), String> {
        self.depth += 1;
        if self.depth > MAX_PARSE_DEPTH {
            return Err(format!("Formula is nested too deeply (max {} levels)", MAX_PARSE_DEPTH));
        }
        Ok(())
    }

    /// expr = comparison
    ///
    /// Precedence (loosest to tightest):
    ///   comparison  (>, <, >=, <=, =, <>)
    ///   concat      (&)
    ///   additive    (+, -)
    ///   term        (*, /)
    ///   power       (^, right-associative)
    ///   unary       (-)
    ///   primary
    fn parse_expr(&mut self) -> Result<CalcExpr, String> {
        self.enter()?;
        let result = self.parse_comparison();
        self.depth -= 1;
        result
    }

    /// comparison = concat ((cmp_op) concat)?  — non-chaining.
    fn parse_comparison(&mut self) -> Result<CalcExpr, String> {
        let left = self.parse_concat()?;
        let op = match self.peek() {
            Token::Gt => CmpOp::Gt,
            Token::Lt => CmpOp::Lt,
            Token::Ge => CmpOp::Ge,
            Token::Le => CmpOp::Le,
            Token::Eq => CmpOp::Eq,
            Token::Ne => CmpOp::Ne,
            _ => return Ok(left),
        };
        self.advance();
        let right = self.parse_concat()?;
        Ok(CalcExpr::Compare { op, left: Box::new(left), right: Box::new(right) })
    }

    /// concat = additive (('&') additive)*
    fn parse_concat(&mut self) -> Result<CalcExpr, String> {
        let mut left = self.parse_additive()?;
        while matches!(self.peek(), Token::Amp) {
            self.advance();
            let right = self.parse_additive()?;
            left = CalcExpr::BinOp { op: CalcOp::Concat, left: Box::new(left), right: Box::new(right) };
        }
        Ok(left)
    }

    /// additive = term (('+' | '-') term)*
    fn parse_additive(&mut self) -> Result<CalcExpr, String> {
        let mut left = self.parse_term()?;
        loop {
            match self.peek() {
                Token::Plus => {
                    self.advance();
                    let right = self.parse_term()?;
                    left = CalcExpr::BinOp { op: CalcOp::Add, left: Box::new(left), right: Box::new(right) };
                }
                Token::Minus => {
                    self.advance();
                    let right = self.parse_term()?;
                    left = CalcExpr::BinOp { op: CalcOp::Sub, left: Box::new(left), right: Box::new(right) };
                }
                _ => break,
            }
        }
        Ok(left)
    }

    /// term = power (('*' | '/') power)*
    fn parse_term(&mut self) -> Result<CalcExpr, String> {
        let mut left = self.parse_power()?;
        loop {
            match self.peek() {
                Token::Star => {
                    self.advance();
                    let right = self.parse_power()?;
                    left = CalcExpr::BinOp { op: CalcOp::Mul, left: Box::new(left), right: Box::new(right) };
                }
                Token::Slash => {
                    self.advance();
                    let right = self.parse_power()?;
                    left = CalcExpr::BinOp { op: CalcOp::Div, left: Box::new(left), right: Box::new(right) };
                }
                _ => break,
            }
        }
        Ok(left)
    }

    /// power = unary ('^' power)?  — right-associative; unary minus binds
    /// tighter than '^' (Excel semantics: -2^2 = 4).
    fn parse_power(&mut self) -> Result<CalcExpr, String> {
        self.enter()?;
        let result = (|| {
            let base = self.parse_unary()?;
            if matches!(self.peek(), Token::Caret) {
                self.advance();
                let exp = self.parse_power()?;
                return Ok(CalcExpr::BinOp { op: CalcOp::Pow, left: Box::new(base), right: Box::new(exp) });
            }
            Ok(base)
        })();
        self.depth -= 1;
        result
    }

    /// unary = '-' unary | primary
    fn parse_unary(&mut self) -> Result<CalcExpr, String> {
        self.enter()?;
        let result = (|| {
            if matches!(self.peek(), Token::Minus) {
                self.advance();
                let inner = self.parse_unary()?;
                return Ok(CalcExpr::Negate(Box::new(inner)));
            }
            self.parse_primary()
        })();
        self.depth -= 1;
        result
    }

    /// primary = NUMBER | STRING | IDENT ['(' arg_list ')'] | '(' expr ')'
    fn parse_primary(&mut self) -> Result<CalcExpr, String> {
        match self.advance() {
            Token::Number(n) => Ok(CalcExpr::Number(n)),
            Token::Str(s) => Ok(CalcExpr::Str(s)),
            Token::Ident(name) => {
                // Check if this is a function call: IDENT '('
                if matches!(self.peek(), Token::LParen) {
                    self.advance(); // consume '('
                    let args = self.parse_arg_list()?;
                    if !matches!(self.advance(), Token::RParen) {
                        return Err(format!("Expected ')' after arguments in function '{}'", name));
                    }
                    Ok(CalcExpr::FunctionCall { name, args })
                } else {
                    Ok(CalcExpr::Reference(name))
                }
            }
            Token::LParen => {
                let expr = self.parse_expr()?;
                if !matches!(self.advance(), Token::RParen) {
                    return Err("Expected closing parenthesis".to_string());
                }
                Ok(expr)
            }
            tok => Err(format!("Unexpected token: {:?}", tok)),
        }
    }

    /// arg_list = expr (',' expr)* | empty
    fn parse_arg_list(&mut self) -> Result<Vec<CalcExpr>, String> {
        if matches!(self.peek(), Token::RParen) {
            return Ok(Vec::new()); // empty arg list
        }
        let mut args = vec![self.parse_expr()?];
        while matches!(self.peek(), Token::Comma) {
            self.advance(); // consume ','
            args.push(self.parse_expr()?);
        }
        Ok(args)
    }
}

// ============================================================================
// PUBLIC API
// ============================================================================

/// Parses a calculated field/item formula string into an expression tree.
pub fn parse_calc_formula(formula: &str) -> Result<CalcExpr, String> {
    if formula.chars().count() > MAX_FORMULA_LEN {
        return Err(format!("Formula is too long (max {} characters)", MAX_FORMULA_LEN));
    }
    let mut tokenizer = Tokenizer::new(formula);
    let tokens = tokenizer.tokenize()?;
    let mut parser = Parser::new(tokens);
    let expr = parser.parse_expr()?;
    if !matches!(parser.peek(), Token::Eof) {
        return Err(format!("Unexpected token after expression: {:?}", parser.peek()));
    }
    Ok(expr)
}

/// Evaluates a parsed expression tree given a name-to-value lookup map.
/// If `ctx` is provided, visual calculation functions (RUNNINGSUM, COLLAPSE, etc.)
/// are available. If `ctx` is None, those functions return an error.
pub(crate) fn evaluate_calc_expr(
    expr: &CalcExpr,
    values: &HashMap<String, f64>,
    ctx: Option<&VisualCalcContext>,
) -> Result<CalcValue, String> {
    match expr {
        CalcExpr::Number(n) => Ok(CalcValue::Number(*n)),
        CalcExpr::Str(s) => Ok(CalcValue::Text(s.clone())),
        CalcExpr::Reference(name) => {
            // Case-insensitive lookup. Field references always resolve to aggregated
            // numeric measures; an unknown reference is a hard error (loud failure),
            // distinct from a runtime CalcValue::Error.
            match lookup_value_ci(values, name) {
                Some(v) => Ok(CalcValue::Number(v)),
                None => Err(format!("Unknown field or item: '{}'", name)),
            }
        }
        CalcExpr::BinOp { op, left, right } => {
            let l = evaluate_calc_expr(left, values, ctx)?;
            if l.is_error() { return Ok(l); }
            let r = evaluate_calc_expr(right, values, ctx)?;
            if r.is_error() { return Ok(r); }
            if let CalcOp::Concat = op {
                return Ok(CalcValue::Text(format!("{}{}", l.as_text(), r.as_text())));
            }
            let ln = match l.as_number() { Ok(n) => n, Err(e) => return Ok(CalcValue::Error(e)) };
            let rn = match r.as_number() { Ok(n) => n, Err(e) => return Ok(CalcValue::Error(e)) };
            Ok(match op {
                CalcOp::Add => CalcValue::Number(ln + rn),
                CalcOp::Sub => CalcValue::Number(ln - rn),
                CalcOp::Mul => CalcValue::Number(ln * rn),
                CalcOp::Div => {
                    if rn == 0.0 { CalcValue::Error("DIV/0!".to_string()) } else { CalcValue::Number(ln / rn) }
                }
                CalcOp::Pow => {
                    let p = ln.powf(rn);
                    if p.is_nan() { CalcValue::Error("NUM!".to_string()) } else { CalcValue::Number(p) }
                }
                CalcOp::Concat => unreachable!("Concat handled above"),
            })
        }
        CalcExpr::Compare { op, left, right } => {
            let l = evaluate_calc_expr(left, values, ctx)?;
            if l.is_error() { return Ok(l); }
            let r = evaluate_calc_expr(right, values, ctx)?;
            if r.is_error() { return Ok(r); }
            Ok(CalcValue::Bool(compare_values(&l, &r, *op)))
        }
        CalcExpr::Negate(inner) => {
            let v = evaluate_calc_expr(inner, values, ctx)?;
            if v.is_error() { return Ok(v); }
            match v.as_number() {
                Ok(n) => Ok(CalcValue::Number(-n)),
                Err(e) => Ok(CalcValue::Error(e)),
            }
        }
        CalcExpr::FunctionCall { name, args } => {
            evaluate_function(name, args, values, ctx)
        }
    }
}

/// Compare two values. Numeric if both coerce to numbers; otherwise case-insensitive
/// text. (Blank coerces to 0 numerically and "" textually, so it compares equal to
/// both 0 and the empty string.)
fn compare_values(l: &CalcValue, r: &CalcValue, op: CmpOp) -> bool {
    let ord = match (l.as_number(), r.as_number()) {
        (Ok(a), Ok(b)) => a.partial_cmp(&b),
        _ => Some(l.as_text().to_lowercase().cmp(&r.as_text().to_lowercase())),
    };
    match ord {
        Some(o) => match op {
            CmpOp::Gt => o == Ordering::Greater,
            CmpOp::Lt => o == Ordering::Less,
            CmpOp::Ge => o != Ordering::Less,
            CmpOp::Le => o != Ordering::Greater,
            CmpOp::Eq => o == Ordering::Equal,
            CmpOp::Ne => o != Ordering::Equal,
        },
        // Only reached for NaN operands; treat as unequal.
        None => matches!(op, CmpOp::Ne),
    }
}

/// Convenience: parse and evaluate in one call (without visual calc context).
pub fn eval_calc_formula(
    formula: &str,
    values: &HashMap<String, f64>,
) -> Result<CalcValue, String> {
    let expr = parse_calc_formula(formula)?;
    evaluate_calc_expr(&expr, values, None)
}

/// Convenience: parse and evaluate with visual calc context.
pub(crate) fn eval_calc_formula_with_ctx(
    formula: &str,
    values: &HashMap<String, f64>,
    ctx: &VisualCalcContext,
) -> Result<CalcValue, String> {
    let expr = parse_calc_formula(formula)?;
    evaluate_calc_expr(&expr, values, Some(ctx))
}

/// Extracts all field/item name references from a formula.
pub fn extract_references(formula: &str) -> Result<Vec<String>, String> {
    let expr = parse_calc_formula(formula)?;
    let mut refs = Vec::new();
    collect_refs(&expr, &mut refs);
    Ok(refs)
}

/// Returns true if the expression contains any visual calculation function calls.
pub(crate) fn uses_visual_calc_functions(expr: &CalcExpr) -> bool {
    match expr {
        CalcExpr::Number(_) | CalcExpr::Str(_) | CalcExpr::Reference(_) => false,
        CalcExpr::BinOp { left, right, .. } | CalcExpr::Compare { left, right, .. } => {
            uses_visual_calc_functions(left) || uses_visual_calc_functions(right)
        }
        CalcExpr::Negate(inner) => uses_visual_calc_functions(inner),
        CalcExpr::FunctionCall { name, args } => {
            is_visual_calc_function(name) || args.iter().any(uses_visual_calc_functions)
        }
    }
}

// ============================================================================
// FUNCTION DISPATCH
// ============================================================================

/// Known visual calculation function names.
fn is_visual_calc_function(name: &str) -> bool {
    matches!(
        name.to_uppercase().as_str(),
        "RUNNINGSUM" | "MOVINGAVERAGE" | "PREVIOUS" | "NEXT" | "FIRST" | "LAST"
        | "PARENT" | "GRANDTOTAL" | "CHILDREN" | "LEAVES"
        | "RANGE" | "ISATLEVEL" | "LOOKUP" | "LOOKUPWITHTOTALS"
        // Legacy aliases
        | "COLLAPSE" | "COLLAPSEALL" | "EXPAND" | "EXPANDALL"
    )
}

/// Evaluate a function call.
fn evaluate_function(
    name: &str,
    args: &[CalcExpr],
    values: &HashMap<String, f64>,
    ctx: Option<&VisualCalcContext>,
) -> Result<CalcValue, String> {
    let upper = name.to_uppercase();

    // Transformation functions (post-aggregation, no visual context required).
    match upper.as_str() {
        "IF" => return eval_if(args, values, ctx),
        "SWITCH" => return eval_switch(args, values, ctx),
        "AND" => return eval_and(args, values, ctx),
        "OR" => return eval_or(args, values, ctx),
        "NOT" => return eval_not(args, values, ctx),
        "ABS" | "ROUND" | "MIN" | "MAX" | "CEILING" | "FLOOR"
        | "SQRT" | "MOD" | "INT" | "SIGN" | "POWER" => {
            return eval_math(&upper, args, values, ctx);
        }
        "CONCAT" | "CONCATENATE" | "LEFT" | "RIGHT" | "LEN" | "MID"
        | "UPPER" | "LOWER" | "TRIM" | "TEXT" => {
            return eval_text(&upper, args, values, ctx);
        }
        _ => {}
    }

    // Anything else must be a known visual-calc function; report typos as
    // unknown functions instead of the misleading "requires a context" error.
    if !is_visual_calc_function(&upper) {
        return Err(format!("Unknown function: '{}'", name));
    }

    // Visual-calc functions require a pivot context and are always numeric.
    let ctx = ctx.ok_or_else(|| {
        format!("Function '{}' requires a visual calculation context (only available in pivot calculated fields)", name)
    })?;

    let n = match upper.as_str() {
        "RUNNINGSUM" => eval_runningsum(args, values, ctx)?,
        "MOVINGAVERAGE" => eval_movingaverage(args, values, ctx)?,
        "PREVIOUS" => eval_previous(args, values, ctx)?,
        "NEXT" => eval_next(args, values, ctx)?,
        "FIRST" => eval_first(args, values, ctx)?,
        "LAST" => eval_last(args, values, ctx)?,
        "PARENT" | "COLLAPSE" => eval_collapse(args, values, ctx)?,
        "GRANDTOTAL" | "COLLAPSEALL" => eval_collapseall(args, values, ctx)?,
        "CHILDREN" | "EXPAND" => eval_expand(args, values, ctx)?,
        "LEAVES" | "EXPANDALL" => eval_expandall(args, values, ctx)?,
        "RANGE" => eval_range(args, values, ctx)?,
        "ISATLEVEL" => eval_isatlevel(args, values, ctx)?,
        "LOOKUP" => eval_lookup(args, values, ctx, false)?,
        "LOOKUPWITHTOTALS" => eval_lookup(args, values, ctx, true)?,
        _ => return Err(format!("Unknown function: '{}'", name)),
    };
    Ok(CalcValue::Number(n))
}

// ============================================================================
// TRANSFORMATION FUNCTIONS (post-aggregation, context-free)
// ============================================================================

/// Evaluate every argument to a CalcValue (hard errors propagate via `?`).
fn eval_args(
    args: &[CalcExpr],
    values: &HashMap<String, f64>,
    ctx: Option<&VisualCalcContext>,
) -> Result<Vec<CalcValue>, String> {
    args.iter().map(|a| evaluate_calc_expr(a, values, ctx)).collect()
}

/// Coerce a list of values to numbers. `Err` carries the propagating error value.
fn to_numbers(vals: &[CalcValue]) -> Result<Vec<f64>, CalcValue> {
    vals.iter()
        .map(|v| v.as_number().map_err(CalcValue::Error))
        .collect()
}

/// IF(condition, then, [else])
fn eval_if(
    args: &[CalcExpr],
    values: &HashMap<String, f64>,
    ctx: Option<&VisualCalcContext>,
) -> Result<CalcValue, String> {
    if args.len() < 2 || args.len() > 3 {
        return Err("IF requires (condition, then_value, [else_value])".to_string());
    }
    let cond = evaluate_calc_expr(&args[0], values, ctx)?;
    if cond.is_error() { return Ok(cond); }
    // Lazy: only the taken branch is evaluated, so text/heavy branches are cheap.
    if cond.truthy() {
        evaluate_calc_expr(&args[1], values, ctx)
    } else if args.len() == 3 {
        evaluate_calc_expr(&args[2], values, ctx)
    } else {
        Ok(CalcValue::Blank)
    }
}

/// SWITCH(expr, value1, result1, [value2, result2, ...], [default])
fn eval_switch(
    args: &[CalcExpr],
    values: &HashMap<String, f64>,
    ctx: Option<&VisualCalcContext>,
) -> Result<CalcValue, String> {
    if args.len() < 3 {
        return Err("SWITCH requires (expr, value1, result1, [value2, result2, ...], [default])".to_string());
    }
    let subject = evaluate_calc_expr(&args[0], values, ctx)?;
    if subject.is_error() { return Ok(subject); }
    let mut i = 1;
    while i + 1 < args.len() {
        let candidate = evaluate_calc_expr(&args[i], values, ctx)?;
        if candidate.is_error() { return Ok(candidate); }
        if compare_values(&subject, &candidate, CmpOp::Eq) {
            return evaluate_calc_expr(&args[i + 1], values, ctx);
        }
        i += 2;
    }
    // A trailing odd argument is the default.
    if i < args.len() {
        return evaluate_calc_expr(&args[i], values, ctx);
    }
    Ok(CalcValue::Blank)
}

/// AND(a, b, ...) — true if every argument is truthy.
/// All arguments are evaluated so errors propagate (documented rule);
/// no short-circuit swallowing of a later argument's error.
fn eval_and(
    args: &[CalcExpr],
    values: &HashMap<String, f64>,
    ctx: Option<&VisualCalcContext>,
) -> Result<CalcValue, String> {
    if args.is_empty() {
        return Err("AND requires at least 1 argument".to_string());
    }
    let vals = eval_args(args, values, ctx)?;
    if let Some(err) = vals.iter().find(|v| v.is_error()) {
        return Ok(err.clone());
    }
    Ok(CalcValue::Bool(vals.iter().all(|v| v.truthy())))
}

/// OR(a, b, ...) — true if any argument is truthy.
/// All arguments are evaluated so errors propagate (documented rule).
fn eval_or(
    args: &[CalcExpr],
    values: &HashMap<String, f64>,
    ctx: Option<&VisualCalcContext>,
) -> Result<CalcValue, String> {
    if args.is_empty() {
        return Err("OR requires at least 1 argument".to_string());
    }
    let vals = eval_args(args, values, ctx)?;
    if let Some(err) = vals.iter().find(|v| v.is_error()) {
        return Ok(err.clone());
    }
    Ok(CalcValue::Bool(vals.iter().any(|v| v.truthy())))
}

/// NOT(x) — boolean negation.
fn eval_not(
    args: &[CalcExpr],
    values: &HashMap<String, f64>,
    ctx: Option<&VisualCalcContext>,
) -> Result<CalcValue, String> {
    if args.len() != 1 {
        return Err("NOT requires exactly 1 argument".to_string());
    }
    let v = evaluate_calc_expr(&args[0], values, ctx)?;
    if v.is_error() { return Ok(v); }
    Ok(CalcValue::Bool(!v.truthy()))
}

/// Scalar math functions.
fn eval_math(
    name: &str,
    args: &[CalcExpr],
    values: &HashMap<String, f64>,
    ctx: Option<&VisualCalcContext>,
) -> Result<CalcValue, String> {
    let vals = eval_args(args, values, ctx)?;
    let nums = match to_numbers(&vals) { Ok(n) => n, Err(ev) => return Ok(ev) };

    // Arity helper.
    let need = |min: usize, max: usize| -> Result<(), String> {
        if nums.len() < min || nums.len() > max {
            Err(format!("{} expects {}..={} arguments, got {}", name, min, max, nums.len()))
        } else {
            Ok(())
        }
    };

    Ok(match name {
        "ABS" => { need(1, 1)?; CalcValue::Number(nums[0].abs()) }
        "INT" => { need(1, 1)?; CalcValue::Number(nums[0].floor()) }
        "SIGN" => {
            need(1, 1)?;
            let s = if nums[0] > 0.0 { 1.0 } else if nums[0] < 0.0 { -1.0 } else { 0.0 };
            CalcValue::Number(s)
        }
        "SQRT" => {
            need(1, 1)?;
            if nums[0] < 0.0 { CalcValue::Error("NUM!".to_string()) } else { CalcValue::Number(nums[0].sqrt()) }
        }
        "ROUND" => {
            need(2, 2)?;
            let factor = 10f64.powi(nums[1] as i32);
            CalcValue::Number((nums[0] * factor).round() / factor)
        }
        "MOD" => {
            need(2, 2)?;
            if nums[1] == 0.0 {
                CalcValue::Error("DIV/0!".to_string())
            } else {
                // Excel MOD: result takes the divisor's sign.
                CalcValue::Number(nums[0] - nums[1] * (nums[0] / nums[1]).floor())
            }
        }
        "POWER" => { need(2, 2)?; CalcValue::Number(nums[0].powf(nums[1])) }
        "MIN" => {
            need(1, usize::MAX)?;
            CalcValue::Number(nums.iter().cloned().fold(f64::INFINITY, f64::min))
        }
        "MAX" => {
            need(1, usize::MAX)?;
            CalcValue::Number(nums.iter().cloned().fold(f64::NEG_INFINITY, f64::max))
        }
        "CEILING" => {
            need(1, 2)?;
            let sig = if nums.len() == 2 { nums[1] } else { 1.0 };
            if sig == 0.0 { CalcValue::Number(0.0) } else { CalcValue::Number((nums[0] / sig).ceil() * sig) }
        }
        "FLOOR" => {
            need(1, 2)?;
            let sig = if nums.len() == 2 { nums[1] } else { 1.0 };
            if sig == 0.0 { CalcValue::Error("DIV/0!".to_string()) } else { CalcValue::Number((nums[0] / sig).floor() * sig) }
        }
        _ => return Err(format!("Unknown math function: '{}'", name)),
    })
}

/// Text functions.
fn eval_text(
    name: &str,
    args: &[CalcExpr],
    values: &HashMap<String, f64>,
    ctx: Option<&VisualCalcContext>,
) -> Result<CalcValue, String> {
    let vals = eval_args(args, values, ctx)?;
    if let Some(err) = vals.iter().find(|v| v.is_error()) {
        return Ok(err.clone());
    }

    // Coerce an argument to a usize count (for LEFT/RIGHT/MID), propagating errors.
    let count_arg = |v: &CalcValue| -> Result<usize, CalcValue> {
        v.as_number().map(|n| n.max(0.0) as usize).map_err(CalcValue::Error)
    };

    Ok(match name {
        "CONCAT" | "CONCATENATE" => {
            if vals.is_empty() { return Err("CONCAT requires at least 1 argument".to_string()); }
            CalcValue::Text(vals.iter().map(|v| v.as_text()).collect())
        }
        "LEN" => {
            if vals.len() != 1 { return Err("LEN requires exactly 1 argument".to_string()); }
            CalcValue::Number(vals[0].as_text().chars().count() as f64)
        }
        "UPPER" => {
            if vals.len() != 1 { return Err("UPPER requires exactly 1 argument".to_string()); }
            CalcValue::Text(vals[0].as_text().to_uppercase())
        }
        "LOWER" => {
            if vals.len() != 1 { return Err("LOWER requires exactly 1 argument".to_string()); }
            CalcValue::Text(vals[0].as_text().to_lowercase())
        }
        "TRIM" => {
            if vals.len() != 1 { return Err("TRIM requires exactly 1 argument".to_string()); }
            CalcValue::Text(vals[0].as_text().trim().to_string())
        }
        "LEFT" => {
            if vals.is_empty() || vals.len() > 2 { return Err("LEFT requires (text, [count])".to_string()); }
            let text = vals[0].as_text();
            let n = if vals.len() == 2 { match count_arg(&vals[1]) { Ok(n) => n, Err(e) => return Ok(e) } } else { 1 };
            CalcValue::Text(text.chars().take(n).collect())
        }
        "RIGHT" => {
            if vals.is_empty() || vals.len() > 2 { return Err("RIGHT requires (text, [count])".to_string()); }
            let text = vals[0].as_text();
            let n = if vals.len() == 2 { match count_arg(&vals[1]) { Ok(n) => n, Err(e) => return Ok(e) } } else { 1 };
            let chars: Vec<char> = text.chars().collect();
            let start = chars.len().saturating_sub(n);
            CalcValue::Text(chars[start..].iter().collect())
        }
        "MID" => {
            if vals.len() != 3 { return Err("MID requires (text, start, count)".to_string()); }
            let text = vals[0].as_text();
            let start = match count_arg(&vals[1]) { Ok(n) => n, Err(e) => return Ok(e) };
            let len = match count_arg(&vals[2]) { Ok(n) => n, Err(e) => return Ok(e) };
            // Excel MID is 1-based; start of 0 or 1 both begin at the first char.
            let skip = start.saturating_sub(1);
            CalcValue::Text(text.chars().skip(skip).take(len).collect())
        }
        "TEXT" => {
            if vals.len() != 2 { return Err("TEXT requires (value, format)".to_string()); }
            let fmt = vals[1].as_text();
            match vals[0].as_number() {
                Ok(n) => CalcValue::Text(apply_text_format(n, &fmt)),
                Err(_) => CalcValue::Text(vals[0].as_text()),
            }
        }
        _ => return Err(format!("Unknown text function: '{}'", name)),
    })
}

/// A minimal numeric formatter for TEXT(value, format). Supports the common cases:
/// a fixed number of decimals (counted from the fractional part of the pattern),
/// an optional trailing `%` (scales by 100), and thousands grouping when the
/// integer part of the pattern contains a comma. Full number-format support is a
/// follow-up; unrecognized patterns fall back to the plain number text.
fn apply_text_format(value: f64, fmt: &str) -> String {
    if fmt.trim().is_empty() {
        return format!("{}", value);
    }
    let is_percent = fmt.contains('%');
    let group = {
        // A comma before the decimal point (or anywhere in the integer part) means grouping.
        let int_part = fmt.split('.').next().unwrap_or("");
        int_part.contains(',')
    };
    let scaled = if is_percent { value * 100.0 } else { value };

    // Decimals = count of digit placeholders after the '.' in the pattern.
    let decimals = match fmt.split_once('.') {
        Some((_, frac)) => frac.chars().filter(|c| *c == '0' || *c == '#').count(),
        None => 0,
    };

    let mut body = format!("{:.*}", decimals, scaled.abs());
    if group {
        body = group_thousands(&body);
    }
    let sign = if scaled.is_sign_negative() && scaled != 0.0 { "-" } else { "" };
    let suffix = if is_percent { "%" } else { "" };
    format!("{}{}{}", sign, body, suffix)
}

/// Insert thousands separators into the integer part of a non-negative decimal string.
fn group_thousands(s: &str) -> String {
    let (int_part, frac_part) = match s.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (s, None),
    };
    let bytes: Vec<char> = int_part.chars().collect();
    let mut grouped = String::new();
    for (i, ch) in bytes.iter().enumerate() {
        if i > 0 && (bytes.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(*ch);
    }
    match frac_part {
        Some(f) => format!("{}.{}", grouped, f),
        None => grouped,
    }
}

// ============================================================================
// HELPER: FIELD VALUE LOOKUP
// ============================================================================

/// Strip a surrounding `[...]` from a reference name so bracketed and bare
/// spellings of the same field compare equal (`[Sales]` vs `Sales`).
fn normalize_ref(name: &str) -> &str {
    let t = name.trim();
    if t.len() >= 2 && t.starts_with('[') && t.ends_with(']') {
        &t[1..t.len() - 1]
    } else {
        t
    }
}

/// Case-insensitive name comparison with bracket normalization on both sides.
fn ref_names_match(a: &str, b: &str) -> bool {
    normalize_ref(a).eq_ignore_ascii_case(normalize_ref(b))
        || a.to_lowercase() == b.to_lowercase()
}

/// Case-insensitive value lookup with a bracket-stripping fallback so that
/// `[Sales]` resolves a plain `Sales` key (grid pivots) and a bare `Sales`
/// resolves a `[Sales]` key (BI pivots).
fn lookup_value_ci(values: &HashMap<String, f64>, name: &str) -> Option<f64> {
    let target = name.to_lowercase();
    for (key, val) in values {
        if key.to_lowercase() == target {
            return Some(*val);
        }
    }
    let target = normalize_ref(name).to_lowercase();
    for (key, val) in values {
        if normalize_ref(key).to_lowercase() == target {
            return Some(*val);
        }
    }
    None
}

/// Resolve the first argument (a field expression) at a specific row.
/// Supports both `Reference("[Sales]")` and evaluable expressions.
/// Unknown field names and nested evaluation errors are hard errors —
/// they must not silently poison a window as NaN.
fn resolve_field_value(
    expr: &CalcExpr,
    row_idx: usize,
    ctx: &VisualCalcContext,
) -> Result<f64, String> {
    if let CalcExpr::Reference(name) = expr {
        ctx.row_values
            .get(row_idx)
            .and_then(|rv| lookup_value_ci(rv, name))
            .ok_or_else(|| format!("Unknown field or item: '{}'", name))
    } else {
        // Evaluate the expression in the context of the given row
        let row_values = ctx.row_values.get(row_idx).cloned().unwrap_or_default();
        let child_ctx = VisualCalcContext {
            current_row_idx: row_idx,
            row_items: ctx.row_items,
            row_values: ctx.row_values,
            field_names_by_depth: ctx.field_names_by_depth,
            grand_total_values: ctx.grand_total_values,
            col_ctx: None,
        };
        evaluate_calc_expr(expr, &row_values, Some(&child_ctx))?.as_number()
    }
}

/// Resolve axis from the last argument. Returns the axis mode and how many
/// args to trim (0 if no axis specified, 1 if the last arg was an axis keyword).
fn resolve_axis_from_args(args: &[CalcExpr]) -> (AxisMode, usize) {
    if let Some(CalcExpr::Reference(name)) = args.last() {
        match name.to_uppercase().as_str() {
            "ROWS" => return (AxisMode::Rows, 1),
            "COLUMNS" => return (AxisMode::Columns, 1),
            _ => {}
        }
    }
    (AxisMode::Rows, 0)
}

/// Split window-function arguments: trims a trailing ROWS/COLUMNS axis keyword
/// and validates the required argument count against what REMAINS, so an axis
/// keyword can never silently consume a required positional argument.
fn window_args<'a>(
    name: &str,
    args: &'a [CalcExpr],
    min_args: usize,
) -> Result<(&'a [CalcExpr], AxisMode), String> {
    let (axis, trim) = resolve_axis_from_args(args);
    let effective = &args[..args.len() - trim];
    if effective.len() < min_args {
        return Err(format!(
            "{} requires at least {} argument{} (the trailing ROWS/COLUMNS axis keyword does not count)",
            name,
            min_args,
            if min_args == 1 { "" } else { "s" },
        ));
    }
    Ok((effective, axis))
}

/// Resolve a field value on the appropriate axis.
fn resolve_field_on_axis(
    expr: &CalcExpr,
    idx: usize,
    axis: AxisMode,
    ctx: &VisualCalcContext,
) -> Result<f64, String> {
    match axis {
        AxisMode::Rows => resolve_field_value(expr, idx, ctx),
        AxisMode::Columns => {
            let col_ctx = ctx
                .col_ctx
                .as_ref()
                .ok_or_else(|| "The COLUMNS axis requires column fields in the pivot".to_string())?;
            if let CalcExpr::Reference(name) = expr {
                col_ctx
                    .col_values
                    .get(idx)
                    .and_then(|cv| lookup_value_ci(cv, name))
                    .ok_or_else(|| format!("Unknown field or item: '{}'", name))
            } else {
                Err("Only direct field references are supported with the COLUMNS axis".to_string())
            }
        }
    }
}

/// Get visible items and the current position for the requested axis partition.
fn get_partition_items_for_axis(
    axis: AxisMode,
    ctx: &VisualCalcContext,
    reset: &ResetMode,
) -> (Vec<usize>, usize) {
    match axis {
        AxisMode::Rows => {
            let visible = get_partition_visible_rows(ctx.current_row_idx, ctx, reset);
            (visible, ctx.current_row_idx)
        }
        AxisMode::Columns => {
            let Some(col_ctx) = ctx.col_ctx.as_ref() else {
                return (Vec::new(), 0);
            };
            let visible = partition_items(
                col_ctx.col_items,
                col_ctx.current_col_idx,
                reset,
            );
            (visible, col_ctx.current_col_idx)
        }
    }
}

// ============================================================================
// HELPER: RESET / PARTITION
// ============================================================================

/// Resolve a reset argument to a ResetMode. Strict: a misspelled keyword or an
/// unknown field name is an error, never a silent no-reset.
fn resolve_reset(
    arg: Option<&CalcExpr>,
    ctx: &VisualCalcContext,
    axis: AxisMode,
) -> Result<ResetMode, String> {
    let arg = match arg {
        Some(a) => a,
        None => return Ok(ResetMode::None),
    };

    // Field names and current depth belong to the axis being traversed.
    let empty: &[String] = &[];
    let (field_names, current_depth): (&[String], usize) = match axis {
        AxisMode::Rows => (
            ctx.field_names_by_depth,
            ctx.row_items.get(ctx.current_row_idx).map(|i| i.depth).unwrap_or(0),
        ),
        AxisMode::Columns => match ctx.col_ctx.as_ref() {
            Some(cc) => (
                cc.field_names_by_depth,
                cc.col_items.get(cc.current_col_idx).map(|i| i.depth).unwrap_or(0),
            ),
            None => (empty, 0),
        },
    };

    // A negative literal parses as Negate(Number); flatten before matching.
    let numeric: Option<f64> = match arg {
        CalcExpr::Number(n) => Some(*n),
        CalcExpr::Negate(inner) => match &**inner {
            CalcExpr::Number(n) => Some(-*n),
            _ => None,
        },
        _ => None,
    };

    if let Some(n) = numeric {
        let n = n as i32;
        return if n == 0 {
            Ok(ResetMode::None)
        } else if n == 1 {
            Ok(ResetMode::HighestParent)
        } else if n == -1 {
            Ok(ResetMode::LowestParent)
        } else if n > 0 {
            let level = (n - 1) as usize;
            if !field_names.is_empty() && level >= field_names.len() {
                Err(format!(
                    "Reset level {} exceeds the {} field(s) on the axis",
                    n,
                    field_names.len()
                ))
            } else {
                Ok(ResetMode::DepthLevel(level))
            }
        } else {
            // Negative: relative mode. -2 = two levels above the current row, etc.
            let target = current_depth as i32 + n; // n is negative
            Ok(ResetMode::DepthLevel(target.max(0) as usize))
        };
    }

    match arg {
        CalcExpr::Reference(name) => {
            match name.to_uppercase().as_str() {
                "NONE" => Ok(ResetMode::None),
                "HIGHESTPARENT" => Ok(ResetMode::HighestParent),
                "LOWESTPARENT" => Ok(ResetMode::LowestParent),
                "ROWS" | "COLUMNS" => Err(format!(
                    "'{}' is an axis keyword and must be the last argument",
                    name
                )),
                _ => {
                    // Field name -> find its depth on the axis
                    for (depth, field_name) in field_names.iter().enumerate() {
                        if ref_names_match(field_name, name) {
                            return Ok(ResetMode::DepthLevel(depth));
                        }
                    }
                    Err(format!(
                        "Unknown reset '{}': expected NONE, HIGHESTPARENT, LOWESTPARENT, a level number, or a field on the axis",
                        name
                    ))
                }
            }
        }
        _ => Err("Invalid reset argument: expected NONE, HIGHESTPARENT, LOWESTPARENT, a level number, or a field name".to_string()),
    }
}

/// Get visible (non-subtotal, non-grand-total) data rows within a partition.
/// Returns indices into row_items. The window is always restricted to rows at
/// the SAME hierarchy depth as the current row — parent group rows carry their
/// children's aggregate, so mixing depths would double-count.
fn get_partition_visible_rows(
    current_row_idx: usize,
    ctx: &VisualCalcContext,
    reset: &ResetMode,
) -> Vec<usize> {
    partition_items(ctx.row_items, current_row_idx, reset)
}

/// Shared partition logic for both axes: same-depth siblings of the current
/// item, optionally restricted to the reset partition. Subtotal and grand
/// total items are never part of a window; when the current item is itself a
/// total (or out of range), the result will not contain it and window
/// functions return NaN via the position lookup.
fn partition_items(
    items: &[FlatAxisItem],
    current_idx: usize,
    reset: &ResetMode,
) -> Vec<usize> {
    let Some(current) = items.get(current_idx) else {
        return Vec::new();
    };
    let current_depth = current.depth;

    // Determine the reset depth
    let reset_depth: Option<usize> = match reset {
        ResetMode::None => None,
        ResetMode::HighestParent => Some(0),
        ResetMode::LowestParent => {
            if current_depth > 0 { Some(current_depth - 1) } else { None }
        }
        ResetMode::DepthLevel(d) => Some(*d),
    };

    // Get the group key at the reset depth for the current item
    let partition_key: Option<Vec<crate::cache::ValueId>> = reset_depth.map(|rd| {
        current.group_values.iter().take(rd + 1).copied().collect()
    });

    let mut result = Vec::new();
    for (i, item) in items.iter().enumerate() {
        if item.is_subtotal || item.is_grand_total {
            continue;
        }
        if item.depth != current_depth {
            continue;
        }
        if let Some(ref pk) = partition_key {
            let item_key: Vec<crate::cache::ValueId> = item.group_values.iter()
                .take(pk.len())
                .copied()
                .collect();
            if item_key != *pk {
                continue;
            }
        }
        result.push(i);
    }

    result
}

/// Find the position of current_row_idx in a visible_rows list.
fn find_current_position(current_row_idx: usize, visible_rows: &[usize]) -> Option<usize> {
    visible_rows.iter().position(|&i| i == current_row_idx)
}

// ============================================================================
// WINDOW FUNCTIONS
// ============================================================================

/// Resolve the optional steps/reset arguments of PREVIOUS/NEXT.
/// `(field, [steps], [reset])` — but the docs also allow the reset directly
/// in the steps slot (`PREVIOUS([Sales], HIGHESTPARENT)`): a bare identifier
/// there is treated as the reset, a numeric expression as the step count.
fn steps_and_reset<'a>(
    name: &str,
    effective_args: &'a [CalcExpr],
    values: &HashMap<String, f64>,
    ctx: &VisualCalcContext,
) -> Result<(usize, Option<&'a CalcExpr>), String> {
    match effective_args.get(1) {
        None => Ok((1, None)),
        Some(CalcExpr::Reference(_)) => {
            if effective_args.len() > 2 {
                return Err(format!(
                    "{}: a reset in the 2nd position cannot be followed by more arguments — use {}(field, steps, reset)",
                    name, name
                ));
            }
            Ok((1, effective_args.get(1)))
        }
        Some(expr) => {
            let n = evaluate_calc_expr(expr, values, Some(ctx))?.as_number()?;
            if n < 0.0 {
                return Err(format!("{} steps must be >= 0", name));
            }
            Ok((n.round() as usize, effective_args.get(2)))
        }
    }
}

/// RUNNINGSUM(field, [reset], [axis])
fn eval_runningsum(
    args: &[CalcExpr],
    _values: &HashMap<String, f64>,
    ctx: &VisualCalcContext,
) -> Result<f64, String> {
    let (effective_args, axis) = window_args("RUNNINGSUM", args, 1)?;
    let field_expr = &effective_args[0];
    let reset = resolve_reset(effective_args.get(1), ctx, axis)?;

    let (visible, current) = get_partition_items_for_axis(axis, ctx, &reset);
    let end = match find_current_position(current, &visible) {
        Some(p) => p + 1,
        None => return Ok(f64::NAN),
    };

    let mut sum = 0.0;
    for &idx in &visible[..end] {
        sum += resolve_field_on_axis(field_expr, idx, axis, ctx)?;
    }
    Ok(sum)
}

/// MOVINGAVERAGE(field, window, [reset], [axis])
fn eval_movingaverage(
    args: &[CalcExpr],
    values: &HashMap<String, f64>,
    ctx: &VisualCalcContext,
) -> Result<f64, String> {
    let (effective_args, axis) = window_args("MOVINGAVERAGE", args, 2)?;
    let field_expr = &effective_args[0];
    if let CalcExpr::Reference(r) = &effective_args[1] {
        if matches!(r.to_uppercase().as_str(), "NONE" | "HIGHESTPARENT" | "LOWESTPARENT") {
            return Err("MOVINGAVERAGE requires a window size as its 2nd argument: MOVINGAVERAGE(field, window, [reset])".to_string());
        }
    }
    let window = evaluate_calc_expr(&effective_args[1], values, Some(ctx))?.as_number()?.round() as i64;
    if window <= 0 {
        return Err("MOVINGAVERAGE window size must be > 0".to_string());
    }
    let window = window as usize;
    let reset = resolve_reset(effective_args.get(2), ctx, axis)?;
    let (visible, current) = get_partition_items_for_axis(axis, ctx, &reset);

    let pos = match find_current_position(current, &visible) {
        Some(p) => p,
        None => return Ok(f64::NAN),
    };

    let start = if pos + 1 >= window { pos + 1 - window } else { 0 };
    let count = pos + 1 - start;
    let mut sum = 0.0;
    for &idx in &visible[start..=pos] {
        sum += resolve_field_on_axis(field_expr, idx, axis, ctx)?;
    }
    Ok(sum / count as f64)
}

/// PREVIOUS(field, [steps], [reset], [axis])
fn eval_previous(
    args: &[CalcExpr],
    values: &HashMap<String, f64>,
    ctx: &VisualCalcContext,
) -> Result<f64, String> {
    let (effective_args, axis) = window_args("PREVIOUS", args, 1)?;
    let field_expr = &effective_args[0];
    let (steps, reset_arg) = steps_and_reset("PREVIOUS", effective_args, values, ctx)?;
    let reset = resolve_reset(reset_arg, ctx, axis)?;
    let (visible, current) = get_partition_items_for_axis(axis, ctx, &reset);

    let pos = match find_current_position(current, &visible) {
        Some(p) => p,
        None => return Ok(f64::NAN),
    };

    if pos < steps {
        return Ok(f64::NAN);
    }

    let target_idx = visible[pos - steps];
    resolve_field_on_axis(field_expr, target_idx, axis, ctx)
}

/// NEXT(field, [steps], [reset], [axis])
fn eval_next(
    args: &[CalcExpr],
    values: &HashMap<String, f64>,
    ctx: &VisualCalcContext,
) -> Result<f64, String> {
    let (effective_args, axis) = window_args("NEXT", args, 1)?;
    let field_expr = &effective_args[0];
    let (steps, reset_arg) = steps_and_reset("NEXT", effective_args, values, ctx)?;
    let reset = resolve_reset(reset_arg, ctx, axis)?;
    let (visible, current) = get_partition_items_for_axis(axis, ctx, &reset);

    let pos = match find_current_position(current, &visible) {
        Some(p) => p,
        None => return Ok(f64::NAN),
    };

    let target = pos + steps;
    if target >= visible.len() {
        return Ok(f64::NAN);
    }

    let target_idx = visible[target];
    resolve_field_on_axis(field_expr, target_idx, axis, ctx)
}

/// FIRST(field, [reset], [axis])
fn eval_first(
    args: &[CalcExpr],
    _values: &HashMap<String, f64>,
    ctx: &VisualCalcContext,
) -> Result<f64, String> {
    let (effective_args, axis) = window_args("FIRST", args, 1)?;
    let field_expr = &effective_args[0];
    let reset = resolve_reset(effective_args.get(1), ctx, axis)?;
    let (visible, current) = get_partition_items_for_axis(axis, ctx, &reset);

    // NaN on subtotal/grand-total rows (current is never part of a window there).
    if find_current_position(current, &visible).is_none() {
        return Ok(f64::NAN);
    }
    resolve_field_on_axis(field_expr, visible[0], axis, ctx)
}

/// LAST(field, [reset], [axis])
fn eval_last(
    args: &[CalcExpr],
    _values: &HashMap<String, f64>,
    ctx: &VisualCalcContext,
) -> Result<f64, String> {
    let (effective_args, axis) = window_args("LAST", args, 1)?;
    let field_expr = &effective_args[0];
    let reset = resolve_reset(effective_args.get(1), ctx, axis)?;
    let (visible, current) = get_partition_items_for_axis(axis, ctx, &reset);

    // NaN on subtotal/grand-total rows (current is never part of a window there).
    if find_current_position(current, &visible).is_none() {
        return Ok(f64::NAN);
    }
    resolve_field_on_axis(field_expr, *visible.last().unwrap(), axis, ctx)
}

// ============================================================================
// HIERARCHY FUNCTIONS
// ============================================================================

/// Resolve `expr` at the grand-total level. Prefers the visible grand-total
/// row; falls back to the always-computed grand-total value map so hiding
/// grand totals in the layout does not break percent-of-total calculations.
fn resolve_at_grand_total(expr: &CalcExpr, ctx: &VisualCalcContext) -> Result<f64, String> {
    if let Some(i) = ctx.row_items.iter().position(|it| it.is_grand_total) {
        return resolve_field_value(expr, i, ctx);
    }
    if let Some(gt) = ctx.grand_total_values {
        if let CalcExpr::Reference(name) = expr {
            return lookup_value_ci(gt, name)
                .ok_or_else(|| format!("Unknown field or item: '{}'", name));
        }
        // No grand-total row to anchor visual functions on; evaluate the
        // expression context-free against the grand-total values.
        return evaluate_calc_expr(expr, gt, None)?.as_number();
    }
    Ok(f64::NAN)
}

/// PARENT/COLLAPSE(field, [levels]) — value at a parent level
fn eval_collapse(
    args: &[CalcExpr],
    values: &HashMap<String, f64>,
    ctx: &VisualCalcContext,
) -> Result<f64, String> {
    if args.is_empty() {
        return Err("PARENT requires at least 1 argument".to_string());
    }
    let field_expr = &args[0];

    let Some(current) = ctx.row_items.get(ctx.current_row_idx) else {
        return Ok(f64::NAN);
    };
    // The grand-total row has no parent.
    if current.is_grand_total {
        return Ok(f64::NAN);
    }

    // Optional second argument: number of levels to go up (default 1)
    let levels = if args.len() >= 2 {
        let n = evaluate_calc_expr(&args[1], values, Some(ctx))?.as_number()?;
        if n < 1.0 {
            return Err("PARENT levels must be >= 1".to_string());
        }
        n.round() as usize
    } else {
        1
    };

    // Walk up the parent chain `levels` times
    let mut idx = ctx.current_row_idx;
    for _ in 0..levels {
        let item = &ctx.row_items[idx];
        if item.parent_index < 0 {
            // Above the top level — the parent is the grand total.
            return resolve_at_grand_total(field_expr, ctx);
        }
        let parent = item.parent_index as usize;
        if parent >= ctx.row_items.len() {
            return Ok(f64::NAN);
        }
        idx = parent;
    }

    resolve_field_value(field_expr, idx, ctx)
}

/// GRANDTOTAL/COLLAPSEALL(field) — value at grand total level
fn eval_collapseall(
    args: &[CalcExpr],
    _values: &HashMap<String, f64>,
    ctx: &VisualCalcContext,
) -> Result<f64, String> {
    if args.is_empty() {
        return Err("GRANDTOTAL requires 1 argument".to_string());
    }
    resolve_at_grand_total(&args[0], ctx)
}

/// CHILDREN/EXPAND(expr) — average of expression evaluated at each direct child
fn eval_expand(
    args: &[CalcExpr],
    _values: &HashMap<String, f64>,
    ctx: &VisualCalcContext,
) -> Result<f64, String> {
    if args.is_empty() {
        return Err("CHILDREN requires 1 argument".to_string());
    }
    let expr = &args[0];

    let Some(current) = ctx.row_items.get(ctx.current_row_idx) else {
        return Ok(f64::NAN);
    };

    // Find direct children. The grand total's direct children are the
    // top-level data rows (their parent_index is -1).
    let children: Vec<usize> = ctx.row_items.iter().enumerate()
        .filter(|(_, item)| {
            !item.is_subtotal
                && !item.is_grand_total
                && if current.is_grand_total {
                    item.depth == 0 && item.parent_index < 0
                } else {
                    item.parent_index == ctx.current_row_idx as i32
                }
        })
        .map(|(i, _)| i)
        .collect();

    if children.is_empty() {
        // Leaf node — evaluate at the current row
        return resolve_field_value(expr, ctx.current_row_idx, ctx);
    }

    let mut sum = 0.0;
    for &child_idx in &children {
        sum += resolve_field_value(expr, child_idx, ctx)?;
    }
    Ok(sum / children.len() as f64)
}

/// LEAVES/EXPANDALL(expr) — average of expression evaluated at leaf level
fn eval_expandall(
    args: &[CalcExpr],
    _values: &HashMap<String, f64>,
    ctx: &VisualCalcContext,
) -> Result<f64, String> {
    if args.is_empty() {
        return Err("LEAVES requires 1 argument".to_string());
    }
    let expr = &args[0];

    let Some(current) = ctx.row_items.get(ctx.current_row_idx) else {
        return Ok(f64::NAN);
    };

    // Find all leaf descendants. At the grand-total row every leaf data row
    // is a descendant (documented: average across ALL leaf rows).
    let leaves: Vec<usize> = ctx.row_items.iter().enumerate()
        .filter(|(i, item)| {
            !item.has_children
                && !item.is_subtotal
                && !item.is_grand_total
                && (current.is_grand_total
                    || is_descendant_of(*i, ctx.current_row_idx, ctx.row_items))
        })
        .map(|(i, _)| i)
        .collect();

    if leaves.is_empty() {
        // Already at leaf — evaluate at the current row
        return resolve_field_value(expr, ctx.current_row_idx, ctx);
    }

    let mut sum = 0.0;
    for &leaf_idx in &leaves {
        sum += resolve_field_value(expr, leaf_idx, ctx)?;
    }
    Ok(sum / leaves.len() as f64)
}

/// Check if `candidate` is a descendant of `ancestor` by walking parent_index.
fn is_descendant_of(candidate: usize, ancestor: usize, row_items: &[FlatAxisItem]) -> bool {
    if candidate == ancestor {
        return true; // Self counts as descendant for leaf case
    }
    let mut idx = candidate;
    loop {
        let parent = row_items[idx].parent_index;
        if parent < 0 {
            return false;
        }
        let parent_idx = parent as usize;
        if parent_idx == ancestor {
            return true;
        }
        if parent_idx >= idx {
            return false; // Prevent infinite loops
        }
        idx = parent_idx;
    }
}

// ============================================================================
// RANGE AND ISATLEVEL FUNCTIONS
// ============================================================================

/// RANGE(size) / RANGE(start, end) — returns the COUNT of rows that fall in
/// the requested window slice after clamping to the axis bounds. A building
/// block for custom window arithmetic; on subtotal/grand-total rows it
/// returns NaN like the other window functions.
fn eval_range(
    args: &[CalcExpr],
    values: &HashMap<String, f64>,
    ctx: &VisualCalcContext,
) -> Result<f64, String> {
    if args.is_empty() {
        return Err("RANGE requires at least 1 argument: RANGE(size) or RANGE(start, end)".to_string());
    }

    let visible = get_partition_visible_rows(ctx.current_row_idx, ctx, &ResetMode::None);
    let pos = match find_current_position(ctx.current_row_idx, &visible) {
        Some(p) => p as i64,
        None => return Ok(f64::NAN),
    };
    let last = visible.len() as i64 - 1;

    let (lo, hi) = if args.len() >= 2 {
        // RANGE(start, end) — relative offsets from the current position
        let start_offset = evaluate_calc_expr(&args[0], values, Some(ctx))?.as_number()?.round() as i64;
        let end_offset = evaluate_calc_expr(&args[1], values, Some(ctx))?.as_number()?.round() as i64;
        if start_offset > end_offset {
            return Err("RANGE start offset must be <= end offset".to_string());
        }
        (pos + start_offset, pos + end_offset)
    } else {
        // RANGE(size) — last N rows ending at the current row
        let size = evaluate_calc_expr(&args[0], values, Some(ctx))?.as_number()?.round() as i64;
        if size < 0 {
            return Err("RANGE size must be >= 0".to_string());
        }
        if size == 0 {
            return Ok(0.0);
        }
        (pos - (size - 1), pos)
    };

    // Clamp to the axis and count what actually exists.
    let lo = lo.max(0);
    let hi = hi.min(last);
    Ok(((hi - lo + 1).max(0)) as f64)
}

/// ISATLEVEL(field_name) — returns 1.0 if the specified row field is at the
/// current hierarchy level, 0.0 otherwise. Useful for conditional calculations
/// that should only apply at certain grouping levels.
fn eval_isatlevel(
    args: &[CalcExpr],
    _values: &HashMap<String, f64>,
    ctx: &VisualCalcContext,
) -> Result<f64, String> {
    if args.is_empty() {
        return Err("ISATLEVEL requires 1 argument: the field name".to_string());
    }

    let field_name = match &args[0] {
        CalcExpr::Reference(name) => name.clone(),
        CalcExpr::Str(name) => name.clone(),
        _ => return Err("ISATLEVEL argument must be a field name reference".to_string()),
    };

    let Some(current) = ctx.row_items.get(ctx.current_row_idx) else {
        return Ok(0.0);
    };
    // The grand-total row is not "at" any field's level.
    if current.is_grand_total {
        return Ok(0.0);
    }

    // Check if the named field corresponds to the current row's depth
    for (depth, name) in ctx.field_names_by_depth.iter().enumerate() {
        if ref_names_match(name, &field_name) {
            return Ok(if current.depth == depth { 1.0 } else { 0.0 });
        }
    }

    // A misspelled field must not silently disable the calculation.
    Err(format!("ISATLEVEL: unknown row field '{}'", field_name))
}

// ============================================================================
// LOOKUP FUNCTIONS
// ============================================================================

/// LOOKUP(expr, field1, value1, [field2, value2, ...])
/// LOOKUPWITHTOTALS(expr, field1, value1, [field2, value2, ...])
///
/// Find a row where field1=value1 (and field2=value2 etc.) and evaluate expr there.
/// LOOKUP skips subtotal/grand total rows; LOOKUPWITHTOTALS includes them.
fn eval_lookup(
    args: &[CalcExpr],
    _values: &HashMap<String, f64>,
    ctx: &VisualCalcContext,
    include_totals: bool,
) -> Result<f64, String> {
    if args.len() < 3 || args.len() % 2 == 0 {
        return Err("LOOKUP requires: (expr, field1, value1, [field2, value2, ...])".to_string());
    }

    let expr = &args[0];

    // Collect field/value match pairs from remaining args
    let mut match_criteria: Vec<(String, String)> = Vec::new();
    let mut i = 1;
    while i + 1 < args.len() {
        let field_name = match &args[i] {
            CalcExpr::Reference(name) => name.clone(),
            CalcExpr::Str(name) => name.clone(),
            _ => return Err("LOOKUP field argument must be a field name".to_string()),
        };

        // Value can be a quoted string, a bare identifier, or a number
        // (negative numbers parse as Negate(Number)).
        let match_value = match &args[i + 1] {
            CalcExpr::Str(s) => s.clone(),
            CalcExpr::Reference(name) => normalize_ref(name).to_string(),
            CalcExpr::Number(n) => format!("{}", n),
            CalcExpr::Negate(inner) => match &**inner {
                CalcExpr::Number(n) => format!("{}", -n),
                _ => return Err("LOOKUP value argument must be a value, text, or field name".to_string()),
            },
            _ => return Err("LOOKUP value argument must be a value, text, or field name".to_string()),
        };

        match_criteria.push((field_name, match_value));
        i += 2;
    }

    // Search through rows for a matching row
    for (row_idx, item) in ctx.row_items.iter().enumerate() {
        // Skip subtotals/grand totals unless include_totals
        if !include_totals && (item.is_subtotal || item.is_grand_total) {
            continue;
        }

        // Check if this row matches all criteria
        let mut all_match = true;
        for (field_name, match_value) in &match_criteria {
            // The field_name should correspond to a row field at some depth.
            // Check the item's label at the appropriate depth.
            let mut field_depth: Option<usize> = None;
            for (d, name) in ctx.field_names_by_depth.iter().enumerate() {
                if ref_names_match(name, field_name) {
                    field_depth = Some(d);
                    break;
                }
            }

            if let Some(depth) = field_depth {
                // Get the label for this item at the target depth.
                // If the item is at or below the target depth, walk up to find the ancestor label.
                let ancestor_label = get_label_at_depth(row_idx, depth, ctx);
                if !text_values_match(&ancestor_label, match_value) {
                    all_match = false;
                    break;
                }
            } else {
                // Field not found in row fields — check value fields
                if let Some(row_values) = ctx.row_values.get(row_idx) {
                    let found = row_values.iter().any(|(k, v)| {
                        ref_names_match(k, field_name)
                            && text_values_match(&format!("{}", v), match_value)
                    });
                    if !found {
                        all_match = false;
                        break;
                    }
                } else {
                    all_match = false;
                    break;
                }
            }
        }

        if all_match {
            // Found matching row — evaluate expr in that row's context
            return resolve_field_value(expr, row_idx, ctx);
        }
    }

    // No matching row found
    Ok(f64::NAN)
}

/// Compare a row label/value against a LOOKUP match value: numeric when both
/// parse as numbers (so "2024.0" matches "2024"), else case-insensitive text.
fn text_values_match(actual: &str, expected: &str) -> bool {
    if let (Ok(a), Ok(b)) = (actual.trim().parse::<f64>(), expected.trim().parse::<f64>()) {
        return a == b;
    }
    actual.trim().eq_ignore_ascii_case(expected.trim())
}

/// Get the label of a row item at a specific depth by walking up the parent chain.
fn get_label_at_depth(row_idx: usize, target_depth: usize, ctx: &VisualCalcContext) -> String {
    let mut idx = row_idx;
    loop {
        let item = &ctx.row_items[idx];
        if item.depth == target_depth {
            return item.label.clone();
        }
        if item.depth < target_depth || item.parent_index < 0 {
            // Can't reach the target depth
            return String::new();
        }
        let parent = item.parent_index as usize;
        if parent >= idx {
            return String::new(); // Prevent infinite loop
        }
        idx = parent;
    }
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

fn collect_refs(expr: &CalcExpr, refs: &mut Vec<String>) {
    match expr {
        CalcExpr::Number(_) | CalcExpr::Str(_) => {}
        CalcExpr::Reference(name) => refs.push(name.clone()),
        CalcExpr::BinOp { left, right, .. } | CalcExpr::Compare { left, right, .. } => {
            collect_refs(left, refs);
            collect_refs(right, refs);
        }
        CalcExpr::Negate(inner) => collect_refs(inner, refs),
        CalcExpr::FunctionCall { args, .. } => {
            for arg in args {
                collect_refs(arg, refs);
            }
        }
    }
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Evaluate a context-free formula to a number (panics on error/non-numeric).
    fn eval_num(formula: &str, values: &HashMap<String, f64>) -> f64 {
        eval_calc_formula(formula, values).unwrap().as_number().unwrap()
    }

    /// Evaluate a context-free formula to a CalcValue.
    fn eval(formula: &str, values: &HashMap<String, f64>) -> CalcValue {
        eval_calc_formula(formula, values).unwrap()
    }

    #[test]
    fn test_simple_arithmetic() {
        let mut values = HashMap::new();
        values.insert("Revenue".to_string(), 1000.0);
        values.insert("Cost".to_string(), 600.0);

        assert_eq!(eval_num("Revenue - Cost", &values), 400.0);
        assert_eq!(eval_num("Revenue * 0.1", &values), 100.0);
        assert_eq!(eval_num("(Revenue - Cost) / Revenue", &values), 0.4);
    }

    #[test]
    fn test_quoted_names() {
        let mut values = HashMap::new();
        values.insert("Total Sales".to_string(), 500.0);
        values.insert("Returns".to_string(), 50.0);

        assert_eq!(eval_num("'Total Sales' - Returns", &values), 450.0);
    }

    #[test]
    fn test_case_insensitive() {
        let mut values = HashMap::new();
        values.insert("Sales".to_string(), 100.0);

        assert_eq!(eval_num("sales * 2", &values), 200.0);
    }

    #[test]
    fn test_division_by_zero() {
        let mut values = HashMap::new();
        values.insert("A".to_string(), 10.0);
        values.insert("B".to_string(), 0.0);

        // Division by zero now yields a spreadsheet-style error value (was NaN).
        assert_eq!(eval("A / B", &values), CalcValue::Error("DIV/0!".to_string()));
    }

    #[test]
    fn test_extract_references() {
        let refs = extract_references("Revenue - Cost + Tax * 0.5").unwrap();
        assert_eq!(refs, vec!["Revenue", "Cost", "Tax"]);
    }

    #[test]
    fn test_parse_function_call() {
        let expr = parse_calc_formula("RUNNINGSUM([Sales])").unwrap();
        match expr {
            CalcExpr::FunctionCall { name, args } => {
                assert_eq!(name, "RUNNINGSUM");
                assert_eq!(args.len(), 1);
                match &args[0] {
                    CalcExpr::Reference(r) => assert_eq!(r, "[Sales]"),
                    _ => panic!("Expected Reference"),
                }
            }
            _ => panic!("Expected FunctionCall"),
        }
    }

    #[test]
    fn test_parse_function_with_multiple_args() {
        let expr = parse_calc_formula("MOVINGAVERAGE([Sales], 3, HIGHESTPARENT)").unwrap();
        match expr {
            CalcExpr::FunctionCall { name, args } => {
                assert_eq!(name, "MOVINGAVERAGE");
                assert_eq!(args.len(), 3);
            }
            _ => panic!("Expected FunctionCall"),
        }
    }

    #[test]
    fn test_parse_function_in_expression() {
        let expr = parse_calc_formula("[Sales] - PREVIOUS([Sales])").unwrap();
        match expr {
            CalcExpr::BinOp { op: CalcOp::Sub, left, right } => {
                assert!(matches!(*left, CalcExpr::Reference(_)));
                assert!(matches!(*right, CalcExpr::FunctionCall { .. }));
            }
            _ => panic!("Expected BinOp"),
        }
    }

    #[test]
    fn test_function_without_context_errors() {
        let values = HashMap::new();
        let expr = parse_calc_formula("RUNNINGSUM([Sales])").unwrap();
        let result = evaluate_calc_expr(&expr, &values, None);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("visual calculation context"));
    }

    #[test]
    fn test_uses_visual_calc_functions() {
        let expr1 = parse_calc_formula("[Sales] + 100").unwrap();
        assert!(!uses_visual_calc_functions(&expr1));

        let expr2 = parse_calc_formula("RUNNINGSUM([Sales])").unwrap();
        assert!(uses_visual_calc_functions(&expr2));

        let expr3 = parse_calc_formula("[Sales] / COLLAPSEALL([Sales])").unwrap();
        assert!(uses_visual_calc_functions(&expr3));

        // Transformation functions are NOT visual-calc (they need no context).
        let expr4 = parse_calc_formula("IF([Sales] > 1000, \"High\", \"Low\")").unwrap();
        assert!(!uses_visual_calc_functions(&expr4));
    }

    // ------------------------------------------------------------------
    // Transformation function tests
    // ------------------------------------------------------------------

    fn sales(v: f64) -> HashMap<String, f64> {
        let mut m = HashMap::new();
        m.insert("Sales".to_string(), v);
        m
    }

    #[test]
    fn test_tokenize_string_and_comparison_ops() {
        // Double-quoted string literal parses to a Str node.
        let expr = parse_calc_formula("\"High\"").unwrap();
        assert!(matches!(expr, CalcExpr::Str(ref s) if s == "High"));

        // Two-char comparison ops.
        assert!(matches!(parse_calc_formula("1 >= 2").unwrap(), CalcExpr::Compare { op: CmpOp::Ge, .. }));
        assert!(matches!(parse_calc_formula("1 <= 2").unwrap(), CalcExpr::Compare { op: CmpOp::Le, .. }));
        assert!(matches!(parse_calc_formula("1 <> 2").unwrap(), CalcExpr::Compare { op: CmpOp::Ne, .. }));
    }

    #[test]
    fn test_comparison_precedence() {
        // Comparison binds looser than arithmetic: parses as [Sales] > (100 + 50).
        let expr = parse_calc_formula("Sales > 100 + 50").unwrap();
        match expr {
            CalcExpr::Compare { op: CmpOp::Gt, left, right } => {
                assert!(matches!(*left, CalcExpr::Reference(_)));
                assert!(matches!(*right, CalcExpr::BinOp { op: CalcOp::Add, .. }));
            }
            _ => panic!("Expected a comparison at the top"),
        }
    }

    #[test]
    fn test_if_returns_text() {
        assert_eq!(eval("IF(Sales > 1000, \"High\", \"Low\")", &sales(1500.0)), CalcValue::Text("High".to_string()));
        assert_eq!(eval("IF(Sales > 1000, \"High\", \"Low\")", &sales(500.0)), CalcValue::Text("Low".to_string()));
        // Two-arg form: false condition yields blank.
        assert_eq!(eval("IF(Sales > 1000, \"High\")", &sales(500.0)), CalcValue::Blank);
    }

    #[test]
    fn test_if_numeric_and_nested() {
        assert_eq!(eval_num("IF(Sales >= 100, Sales * 2, 0)", &sales(100.0)), 200.0);
        // Nested IF.
        let v = eval("IF(Sales > 1000, \"A\", IF(Sales > 500, \"B\", \"C\"))", &sales(700.0));
        assert_eq!(v, CalcValue::Text("B".to_string()));
    }

    #[test]
    fn test_switch() {
        let mut m = HashMap::new();
        m.insert("Region".to_string(), 2.0);
        // Numeric switch with default.
        assert_eq!(eval_num("SWITCH(Region, 1, 10, 2, 20, 99)", &m), 20.0);
        // Falls to default.
        m.insert("Region".to_string(), 7.0);
        assert_eq!(eval_num("SWITCH(Region, 1, 10, 2, 20, 99)", &m), 99.0);
        // No match, no default -> blank.
        assert_eq!(eval("SWITCH(Region, 1, 10, 2, 20)", &m), CalcValue::Blank);
    }

    #[test]
    fn test_boolean_logic() {
        assert_eq!(eval("AND(Sales > 100, Sales < 1000)", &sales(500.0)), CalcValue::Bool(true));
        assert_eq!(eval("AND(Sales > 100, Sales < 1000)", &sales(50.0)), CalcValue::Bool(false));
        assert_eq!(eval("OR(Sales > 1000, Sales < 100)", &sales(50.0)), CalcValue::Bool(true));
        assert_eq!(eval("NOT(Sales > 1000)", &sales(50.0)), CalcValue::Bool(true));
    }

    #[test]
    fn test_comparison_operators() {
        assert_eq!(eval("Sales = 100", &sales(100.0)), CalcValue::Bool(true));
        assert_eq!(eval("Sales <> 100", &sales(100.0)), CalcValue::Bool(false));
        // Text comparison (case-insensitive).
        let mut m = HashMap::new();
        m.insert("X".to_string(), 0.0);
        assert_eq!(eval("\"abc\" = \"ABC\"", &m), CalcValue::Bool(true));
    }

    #[test]
    fn test_scalar_math() {
        let m = sales(0.0);
        assert_eq!(eval_num("ABS(0 - 5)", &m), 5.0);
        assert_eq!(eval_num("ROUND(3.14159, 2)", &m), 3.14);
        assert_eq!(eval_num("MIN(3, 1, 2)", &m), 1.0);
        assert_eq!(eval_num("MAX(3, 1, 2)", &m), 3.0);
        assert_eq!(eval_num("MOD(7, 3)", &m), 1.0);
        assert_eq!(eval_num("INT(3.9)", &m), 3.0);
        assert_eq!(eval_num("SIGN(0 - 2)", &m), -1.0);
        assert_eq!(eval_num("SQRT(9)", &m), 3.0);
        assert_eq!(eval_num("POWER(2, 10)", &m), 1024.0);
        assert_eq!(eval_num("CEILING(4.2, 1)", &m), 5.0);
        assert_eq!(eval_num("FLOOR(4.8, 1)", &m), 4.0);
        // SQRT of a negative is a NUM! error.
        assert_eq!(eval("SQRT(0 - 1)", &m), CalcValue::Error("NUM!".to_string()));
    }

    #[test]
    fn test_text_functions() {
        let mut m = HashMap::new();
        m.insert("Class".to_string(), 0.0);
        assert_eq!(eval("CONCAT(\"a\", \"-\", \"b\")", &m), CalcValue::Text("a-b".to_string()));
        assert_eq!(eval("\"a\" & \"b\" & \"c\"", &m), CalcValue::Text("abc".to_string()));
        assert_eq!(eval("UPPER(\"abc\")", &m), CalcValue::Text("ABC".to_string()));
        assert_eq!(eval("LOWER(\"ABC\")", &m), CalcValue::Text("abc".to_string()));
        assert_eq!(eval("TRIM(\"  hi  \")", &m), CalcValue::Text("hi".to_string()));
        assert_eq!(eval("LEFT(\"hello\", 2)", &m), CalcValue::Text("he".to_string()));
        assert_eq!(eval("RIGHT(\"hello\", 2)", &m), CalcValue::Text("lo".to_string()));
        assert_eq!(eval("MID(\"hello\", 2, 3)", &m), CalcValue::Text("ell".to_string()));
        assert_eq!(eval_num("LEN(\"hello\")", &m), 5.0);
        // Number concatenation coerces to text.
        assert_eq!(eval("\"$\" & 100", &m), CalcValue::Text("$100".to_string()));
    }

    #[test]
    fn test_text_format() {
        let m = sales(0.0);
        assert_eq!(eval("TEXT(3.14159, \"0.00\")", &m), CalcValue::Text("3.14".to_string()));
        assert_eq!(eval("TEXT(0.1234, \"0.0%\")", &m), CalcValue::Text("12.3%".to_string()));
        assert_eq!(eval("TEXT(1234567, \"#,##0\")", &m), CalcValue::Text("1,234,567".to_string()));
    }

    #[test]
    fn test_error_propagation() {
        let mut m = HashMap::new();
        m.insert("A".to_string(), 10.0);
        m.insert("B".to_string(), 0.0);
        // A div-by-zero inside an arithmetic chain propagates.
        assert_eq!(eval("(A / B) + 1", &m), CalcValue::Error("DIV/0!".to_string()));
        // IF short-circuits: the untaken branch's error does not surface.
        assert_eq!(eval("IF(A > 5, \"ok\", A / B)", &m), CalcValue::Text("ok".to_string()));
        // Arithmetic on non-numeric text is a VALUE! error.
        assert_eq!(eval("\"abc\" + 1", &m), CalcValue::Error("VALUE!".to_string()));
    }

    #[test]
    fn test_unknown_field_is_hard_error() {
        let m = sales(100.0);
        // Unknown field references remain a loud hard error (not a CalcValue::Error).
        assert!(eval_calc_formula("Nonexistent + 1", &m).is_err());
    }

    // ------------------------------------------------------------------
    // Parser robustness
    // ------------------------------------------------------------------

    #[test]
    fn test_dotted_bi_field_names_tokenize() {
        let refs = extract_references("dim_date.year + 1").unwrap();
        assert_eq!(refs, vec!["dim_date.year"]);
        // Inside function arguments too.
        assert!(parse_calc_formula("RUNNINGSUM([Sales], dim_date.year)").is_ok());
    }

    #[test]
    fn test_string_escape_doubled_quote() {
        let mut m = HashMap::new();
        m.insert("X".to_string(), 0.0);
        assert_eq!(
            eval("\"He said \"\"hi\"\"\"", &m),
            CalcValue::Text("He said \"hi\"".to_string())
        );
    }

    #[test]
    fn test_power_operator() {
        let m = sales(0.0);
        assert_eq!(eval_num("2^10", &m), 1024.0);
        // Right-associative: 2^3^2 = 2^(3^2) = 512.
        assert_eq!(eval_num("2^3^2", &m), 512.0);
        // Unary minus binds tighter than '^' (Excel): -2^2 = 4.
        assert_eq!(eval_num("-2^2", &m), 4.0);
        // '^' binds tighter than '*': 2*3^2 = 18.
        assert_eq!(eval_num("2*3^2", &m), 18.0);
    }

    #[test]
    fn test_depth_and_length_caps() {
        let m = sales(0.0);
        // Deep nesting errors cleanly instead of overflowing the stack.
        let deep = format!("{}1{}", "(".repeat(400), ")".repeat(400));
        let err = eval_calc_formula(&deep, &m).unwrap_err();
        assert!(err.contains("nested too deeply"), "got: {}", err);
        // Oversized formulas are rejected up front.
        let long = format!("1{}", "+1".repeat(4096));
        let err = eval_calc_formula(&long, &m).unwrap_err();
        assert!(err.contains("too long"), "got: {}", err);
    }

    #[test]
    fn test_unknown_function_message() {
        let m = sales(0.0);
        let err = eval_calc_formula("FOOBAR(1)", &m).unwrap_err();
        assert!(err.contains("Unknown function"), "got: {}", err);
        assert!(!err.contains("visual calculation context"), "got: {}", err);
    }

    #[test]
    fn test_and_or_propagate_errors() {
        let mut m = HashMap::new();
        m.insert("A".to_string(), 10.0);
        m.insert("B".to_string(), 0.0);
        // The error in a later argument surfaces even though the first
        // argument already decides the boolean result.
        assert_eq!(eval("AND(A > 100, A / B)", &m), CalcValue::Error("DIV/0!".to_string()));
        assert_eq!(eval("OR(A > 5, A / B)", &m), CalcValue::Error("DIV/0!".to_string()));
    }

    #[test]
    fn test_text_coercion_hides_float_artifacts() {
        let m = sales(0.0);
        assert_eq!(eval("\"\" & (0.1 + 0.2)", &m), CalcValue::Text("0.3".to_string()));
    }

    #[test]
    fn test_bracket_reference_resolves_bare_key() {
        // Grid pivots store plain source-field keys ("Sales"); the docs'
        // bracket syntax must still resolve them.
        let m = sales(100.0);
        assert_eq!(eval_num("[Sales] * 2", &m), 200.0);
        // And vice versa: a bare name resolves a bracketed key (BI pivots).
        let mut bi = HashMap::new();
        bi.insert("[TotalSales]".to_string(), 50.0);
        assert_eq!(eval_num("TotalSales + 1", &bi), 51.0);
    }

    #[test]
    fn test_transform_edge_cases() {
        let m = sales(0.0);
        assert_eq!(eval("MOD(7, 0)", &m), CalcValue::Error("DIV/0!".to_string()));
        assert_eq!(eval_num("FLOOR(4.8)", &m), 4.0); // default significance 1
        assert_eq!(eval_num("CEILING(4.2)", &m), 5.0);
        assert_eq!(eval("LEFT(\"hello\")", &m), CalcValue::Text("h".to_string()));
        assert_eq!(eval("RIGHT(\"hello\")", &m), CalcValue::Text("o".to_string()));
        assert_eq!(eval_num("MOD(0 - 7, 3)", &m), 2.0); // divisor's sign (Excel)
    }

    // ------------------------------------------------------------------
    // Visual calculation fixture (Year/Quarter hierarchy per the docs)
    // ------------------------------------------------------------------

    use crate::cache::{ValueId, VALUE_ID_EMPTY};

    /// Fixture mirroring the documentation examples:
    /// ROWS: Year, Quarter — 2024: Q1=100 Q2=150 Q3=200 Q4=180 (630),
    /// 2025: Q1=120 Q2=160 (280), grand total 910. Parent (year) rows are
    /// regular data rows carrying the year aggregate, exactly as the engine
    /// flattens them.
    struct VcFixture {
        items: Vec<FlatAxisItem>,
        values: Vec<HashMap<String, f64>>,
        names: Vec<String>,
        grand_total: HashMap<String, f64>,
        include_grand_total_row: bool,
    }

    fn axis_item(
        label: &str,
        depth: usize,
        parent: i32,
        gv: Vec<ValueId>,
        has_children: bool,
        is_grand_total: bool,
    ) -> FlatAxisItem {
        FlatAxisItem {
            group_values: gv,
            label: label.to_string(),
            depth,
            is_subtotal: false,
            is_grand_total,
            has_children,
            is_collapsed: false,
            parent_index: parent,
            field_indices: vec![0, 1],
            attribute_labels: Vec::new(),
        }
    }

    fn sales_map(v: f64) -> HashMap<String, f64> {
        let mut m = HashMap::new();
        m.insert("Sales".to_string(), v);
        m
    }

    impl VcFixture {
        fn new() -> Self {
            // ValueIds: years 10/11, quarters 1..=4.
            let e = VALUE_ID_EMPTY;
            let items = vec![
                axis_item("2024", 0, -1, vec![10, e], true, false), // 0: 630
                axis_item("Q1", 1, 0, vec![10, 1], false, false),   // 1: 100
                axis_item("Q2", 1, 0, vec![10, 2], false, false),   // 2: 150
                axis_item("Q3", 1, 0, vec![10, 3], false, false),   // 3: 200
                axis_item("Q4", 1, 0, vec![10, 4], false, false),   // 4: 180
                axis_item("2025", 0, -1, vec![11, e], true, false), // 5: 280
                axis_item("Q1", 1, 5, vec![11, 1], false, false),   // 6: 120
                axis_item("Q2", 1, 5, vec![11, 2], false, false),   // 7: 160
                axis_item("Grand Total", 0, -1, vec![e, e], false, true), // 8: 910
            ];
            let values = vec![630.0, 100.0, 150.0, 200.0, 180.0, 280.0, 120.0, 160.0, 910.0]
                .into_iter()
                .map(sales_map)
                .collect();
            VcFixture {
                items,
                values,
                names: vec!["Year".to_string(), "Quarter".to_string()],
                grand_total: sales_map(910.0),
                include_grand_total_row: true,
            }
        }

        /// Same fixture with the grand-total row hidden (layout option).
        fn without_grand_total_row() -> Self {
            let mut f = Self::new();
            f.items.pop();
            f.values.pop();
            f.include_grand_total_row = false;
            f
        }

        fn eval(&self, row: usize, formula: &str) -> Result<f64, String> {
            let ctx = VisualCalcContext {
                current_row_idx: row,
                row_items: &self.items,
                row_values: &self.values,
                field_names_by_depth: &self.names,
                grand_total_values: Some(&self.grand_total),
                col_ctx: None,
            };
            eval_calc_formula_with_ctx(formula, &self.values[row], &ctx)
                .and_then(|v| v.as_number())
        }

        fn eval_ok(&self, row: usize, formula: &str) -> f64 {
            self.eval(row, formula).unwrap()
        }
    }

    fn assert_close(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < 1e-9,
            "expected {}, got {}",
            expected,
            actual
        );
    }

    // ------------------------------------------------------------------
    // Window functions (documented behavior)
    // ------------------------------------------------------------------

    #[test]
    fn test_runningsum_stays_on_one_hierarchy_level() {
        let f = VcFixture::new();
        // Quarter-level running sum must NOT include the year parent rows.
        assert_close(f.eval_ok(1, "RUNNINGSUM([Sales])"), 100.0);
        assert_close(f.eval_ok(2, "RUNNINGSUM([Sales])"), 250.0);
        assert_close(f.eval_ok(3, "RUNNINGSUM([Sales])"), 450.0);
        assert_close(f.eval_ok(4, "RUNNINGSUM([Sales])"), 630.0);
        // Continues across years with no reset (docs table).
        assert_close(f.eval_ok(6, "RUNNINGSUM([Sales])"), 750.0);
        assert_close(f.eval_ok(7, "RUNNINGSUM([Sales])"), 910.0);
        // Year rows get their own year-level window.
        assert_close(f.eval_ok(0, "RUNNINGSUM([Sales])"), 630.0);
        assert_close(f.eval_ok(5, "RUNNINGSUM([Sales])"), 910.0);
        // Grand total row: NaN (excluded from windows).
        assert!(f.eval_ok(8, "RUNNINGSUM([Sales])").is_nan());
    }

    #[test]
    fn test_runningsum_reset_variants() {
        let f = VcFixture::new();
        // HIGHESTPARENT restarts at each year (docs table).
        assert_close(f.eval_ok(6, "RUNNINGSUM([Sales], HIGHESTPARENT)"), 120.0);
        assert_close(f.eval_ok(7, "RUNNINGSUM([Sales], HIGHESTPARENT)"), 280.0);
        // Numeric aliases: 1 = HIGHESTPARENT, -1 = LOWESTPARENT.
        assert_close(f.eval_ok(7, "RUNNINGSUM([Sales], 1)"), 280.0);
        assert_close(f.eval_ok(7, "RUNNINGSUM([Sales], -1)"), 280.0);
        // Field-name reset (Year == level 1 here).
        assert_close(f.eval_ok(7, "RUNNINGSUM([Sales], Year)"), 280.0);
        // Level number beyond the axis errors.
        assert!(f.eval(7, "RUNNINGSUM([Sales], 3)").is_err());
    }

    #[test]
    fn test_misspelled_reset_is_an_error_not_silence() {
        let f = VcFixture::new();
        let err = f.eval(7, "RUNNINGSUM([Sales], HIGHESTPRAENT)").unwrap_err();
        assert!(err.contains("Unknown reset"), "got: {}", err);
    }

    #[test]
    fn test_axis_keyword_cannot_consume_required_args() {
        let f = VcFixture::new();
        // These used to panic with index-out-of-bounds.
        assert!(f.eval(1, "RUNNINGSUM(ROWS)").is_err());
        assert!(f.eval(1, "MOVINGAVERAGE([Sales], COLUMNS)").is_err());
        assert!(f.eval(1, "PREVIOUS(COLUMNS)").is_err());
        assert!(f.eval(1, "FIRST(ROWS)").is_err());
        assert!(f.eval(1, "LAST(COLUMNS)").is_err());
        assert!(f.eval(1, "NEXT(ROWS)").is_err());
    }

    #[test]
    fn test_movingaverage_documented_window() {
        let f = VcFixture::new();
        // Window covers the current row and up to (window-1) preceding rows.
        assert_close(f.eval_ok(1, "MOVINGAVERAGE([Sales], 3)"), 100.0);
        assert_close(f.eval_ok(2, "MOVINGAVERAGE([Sales], 3)"), 125.0);
        assert_close(f.eval_ok(3, "MOVINGAVERAGE([Sales], 3)"), 150.0);
        assert_close(f.eval_ok(4, "MOVINGAVERAGE([Sales], 3)"), (150.0 + 200.0 + 180.0) / 3.0);
        // Reset restarts the window at the year boundary.
        assert_close(f.eval_ok(6, "MOVINGAVERAGE([Sales], 3, HIGHESTPARENT)"), 120.0);
        // A reset keyword in the window slot is a clear error.
        assert!(f.eval(2, "MOVINGAVERAGE([Sales], HIGHESTPARENT)").is_err());
        assert!(f.eval(2, "MOVINGAVERAGE([Sales], 0)").is_err());
    }

    #[test]
    fn test_previous_next_steps_and_reset() {
        let f = VcFixture::new();
        assert!(f.eval_ok(1, "PREVIOUS([Sales])").is_nan()); // first row
        assert_close(f.eval_ok(2, "PREVIOUS([Sales])"), 100.0);
        // Continues across the year boundary with no reset.
        assert_close(f.eval_ok(6, "PREVIOUS([Sales])"), 180.0);
        // Documented shorthand: reset directly in the steps slot.
        assert!(f.eval_ok(6, "PREVIOUS([Sales], HIGHESTPARENT)").is_nan());
        assert_close(f.eval_ok(7, "PREVIOUS([Sales], HIGHESTPARENT)"), 120.0);
        // Explicit steps.
        assert_close(f.eval_ok(3, "PREVIOUS([Sales], 2)"), 100.0);
        // Steps + reset together.
        assert!(f.eval_ok(7, "PREVIOUS([Sales], 2, HIGHESTPARENT)").is_nan());
        // NEXT mirrors PREVIOUS.
        assert_close(f.eval_ok(1, "NEXT([Sales])"), 150.0);
        assert!(f.eval_ok(7, "NEXT([Sales])").is_nan()); // last row
        assert!(f.eval_ok(4, "NEXT([Sales], HIGHESTPARENT)").is_nan()); // last in year
        // Year rows traverse the year-level window.
        assert_close(f.eval_ok(0, "NEXT([Sales])"), 280.0);
    }

    #[test]
    fn test_first_last() {
        let f = VcFixture::new();
        assert_close(f.eval_ok(4, "FIRST([Sales])"), 100.0);
        assert_close(f.eval_ok(1, "LAST([Sales])"), 160.0);
        assert_close(f.eval_ok(6, "FIRST([Sales], HIGHESTPARENT)"), 120.0);
        assert_close(f.eval_ok(6, "LAST([Sales], HIGHESTPARENT)"), 160.0);
        // Subtotal/grand-total rows are not part of any window: NaN.
        assert!(f.eval_ok(8, "FIRST([Sales])").is_nan());
        assert!(f.eval_ok(8, "LAST([Sales])").is_nan());
    }

    #[test]
    fn test_unknown_measure_inside_window_errors() {
        let f = VcFixture::new();
        assert!(f.eval(1, "RUNNINGSUM([Salez])").is_err());
    }

    // ------------------------------------------------------------------
    // Hierarchy functions (documented behavior)
    // ------------------------------------------------------------------

    #[test]
    fn test_parent_documented_semantics() {
        let f = VcFixture::new();
        // Quarter -> year value.
        assert_close(f.eval_ok(1, "PARENT([Sales])"), 630.0);
        assert_close(f.eval_ok(7, "PARENT([Sales])"), 280.0);
        // Top level -> grand total.
        assert_close(f.eval_ok(0, "PARENT([Sales])"), 910.0);
        // Grand-total row -> NaN.
        assert!(f.eval_ok(8, "PARENT([Sales])").is_nan());
        // Levels parameter: two levels up from a quarter is the grand total.
        assert_close(f.eval_ok(1, "PARENT([Sales], 2)"), 910.0);
        // Percent-of-parent composes.
        assert_close(f.eval_ok(1, "[Sales] / PARENT([Sales])"), 100.0 / 630.0);
    }

    #[test]
    fn test_grandtotal_works_without_visible_grand_total_row() {
        let visible = VcFixture::new();
        assert_close(visible.eval_ok(1, "GRANDTOTAL([Sales])"), 910.0);
        // Hiding the grand-total row must not break percent-of-total.
        let hidden = VcFixture::without_grand_total_row();
        assert_close(hidden.eval_ok(1, "GRANDTOTAL([Sales])"), 910.0);
        assert_close(hidden.eval_ok(0, "PARENT([Sales])"), 910.0);
    }

    #[test]
    fn test_children_documented_semantics() {
        let f = VcFixture::new();
        // Year row: average of its quarters.
        assert_close(f.eval_ok(0, "CHILDREN([Sales])"), 157.5);
        assert_close(f.eval_ok(5, "CHILDREN([Sales])"), 140.0);
        // Leaf: own value.
        assert_close(f.eval_ok(3, "CHILDREN([Sales])"), 200.0);
        // Grand total: average of the top-level rows.
        assert_close(f.eval_ok(8, "CHILDREN([Sales])"), 455.0);
    }

    #[test]
    fn test_leaves_documented_semantics() {
        let f = VcFixture::new();
        // Year row: average of its leaf quarters.
        assert_close(f.eval_ok(0, "LEAVES([Sales])"), 157.5);
        // Leaf: own value.
        assert_close(f.eval_ok(6, "LEAVES([Sales])"), 120.0);
        // Grand total: average across ALL leaf rows (docs table).
        assert_close(
            f.eval_ok(8, "LEAVES([Sales])"),
            (100.0 + 150.0 + 200.0 + 180.0 + 120.0 + 160.0) / 6.0,
        );
    }

    // ------------------------------------------------------------------
    // Utility + lookup functions
    // ------------------------------------------------------------------

    #[test]
    fn test_isatlevel() {
        let f = VcFixture::new();
        assert_close(f.eval_ok(0, "ISATLEVEL(Year)"), 1.0);
        assert_close(f.eval_ok(1, "ISATLEVEL(Year)"), 0.0);
        assert_close(f.eval_ok(1, "ISATLEVEL(Quarter)"), 1.0);
        // The grand-total row is not at any field's level.
        assert_close(f.eval_ok(8, "ISATLEVEL(Year)"), 0.0);
        // A misspelled field errors instead of silently returning 0.
        assert!(f.eval(1, "ISATLEVEL(Quartr)").is_err());
    }

    #[test]
    fn test_range_clamps_and_errors() {
        let f = VcFixture::new();
        // Quarter-level axis has 6 rows; idx 1 is position 0, idx 4 position 3.
        assert_close(f.eval_ok(1, "RANGE(3)"), 1.0); // clamped at partition start
        assert_close(f.eval_ok(4, "RANGE(3)"), 3.0);
        assert_close(f.eval_ok(4, "RANGE(-2, 0)"), 3.0);
        assert_close(f.eval_ok(4, "RANGE(0, 2)"), 3.0);
        // Past the end of the axis: counts what exists.
        assert_close(f.eval_ok(7, "RANGE(1, 2)"), 0.0);
        assert_close(f.eval_ok(7, "RANGE(0, 2)"), 1.0);
        // Degenerate inputs are explicit errors / zero, never a panic.
        assert_close(f.eval_ok(4, "RANGE(0)"), 0.0);
        assert!(f.eval(4, "RANGE(-1)").is_err());
        assert!(f.eval(4, "RANGE(2, 0)").is_err());
        // Totals rows: NaN like other window functions.
        assert!(f.eval_ok(8, "RANGE(3)").is_nan());
    }

    #[test]
    fn test_lookup_documented_semantics() {
        let f = VcFixture::new();
        // First matching row wins.
        assert_close(f.eval_ok(1, "LOOKUP([Sales], Quarter, \"Q1\")"), 100.0);
        // Case-insensitive text match.
        assert_close(f.eval_ok(1, "LOOKUP([Sales], Quarter, \"q2\")"), 150.0);
        // Bare identifiers still work as match values.
        assert_close(f.eval_ok(1, "LOOKUP([Sales], Quarter, Q3)"), 200.0);
        // Numbers match numeric labels.
        assert_close(f.eval_ok(1, "LOOKUP([Sales], Year, 2025)"), 280.0);
        // Multiple AND-combined criteria.
        assert_close(f.eval_ok(1, "LOOKUP([Sales], Year, 2025, Quarter, \"Q2\")"), 160.0);
        // No match -> NaN.
        assert!(f.eval_ok(1, "LOOKUP([Sales], Quarter, \"Q9\")").is_nan());
        // LOOKUP skips totals; LOOKUPWITHTOTALS can address them.
        assert!(f.eval_ok(1, "LOOKUP([Sales], Year, \"Grand Total\")").is_nan());
        assert_close(
            f.eval_ok(1, "LOOKUPWITHTOTALS([Sales], Year, \"Grand Total\")"),
            910.0,
        );
    }
}
