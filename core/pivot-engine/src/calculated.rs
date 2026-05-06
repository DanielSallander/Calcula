//! FILENAME: core/pivot-engine/src/calculated.rs
//! Expression evaluator for calculated fields with Visual Calculation support.
//!
//! Supports:
//! - Arithmetic: +, -, *, /, parentheses, numeric literals, unary negation
//! - Field references: bare, 'quoted', [bracketed]
//! - Visual Calculation functions:
//!   - Window: RUNNINGSUM, MOVINGAVERAGE, PREVIOUS, NEXT, FIRST, LAST
//!   - Hierarchy: COLLAPSE, COLLAPSEALL, EXPAND, EXPANDALL
//! - Reset parameter: NONE, HIGHESTPARENT, LOWESTPARENT, field name, or integer

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

    /// A reference to a named field or item (resolved at evaluation time).
    Reference(String),

    /// Binary operation: left op right.
    BinOp {
        op: CalcOp,
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

    /// Column field names by depth (for field-level reset on column axis).
    pub(crate) col_field_names_by_depth: &'a [String],
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
    Plus,
    Minus,
    Star,
    Slash,
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
                    '(' => { self.next_char(); tokens.push(Token::LParen); }
                    ')' => { self.next_char(); tokens.push(Token::RParen); }
                    ',' => { self.next_char(); tokens.push(Token::Comma); }
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
                        let mut name = String::new();
                        while let Some(c) = self.peek_char() {
                            if c.is_alphanumeric() || c == '_' {
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

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}

impl Parser {
    fn new(tokens: Vec<Token>) -> Self {
        Parser { tokens, pos: 0 }
    }

    fn peek(&self) -> &Token {
        self.tokens.get(self.pos).unwrap_or(&Token::Eof)
    }

    fn advance(&mut self) -> Token {
        let tok = self.tokens.get(self.pos).cloned().unwrap_or(Token::Eof);
        self.pos += 1;
        tok
    }

    /// expr = term (('+' | '-') term)*
    fn parse_expr(&mut self) -> Result<CalcExpr, String> {
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

    /// term = unary (('*' | '/') unary)*
    fn parse_term(&mut self) -> Result<CalcExpr, String> {
        let mut left = self.parse_unary()?;
        loop {
            match self.peek() {
                Token::Star => {
                    self.advance();
                    let right = self.parse_unary()?;
                    left = CalcExpr::BinOp { op: CalcOp::Mul, left: Box::new(left), right: Box::new(right) };
                }
                Token::Slash => {
                    self.advance();
                    let right = self.parse_unary()?;
                    left = CalcExpr::BinOp { op: CalcOp::Div, left: Box::new(left), right: Box::new(right) };
                }
                _ => break,
            }
        }
        Ok(left)
    }

    /// unary = '-' unary | primary
    fn parse_unary(&mut self) -> Result<CalcExpr, String> {
        if matches!(self.peek(), Token::Minus) {
            self.advance();
            let inner = self.parse_unary()?;
            return Ok(CalcExpr::Negate(Box::new(inner)));
        }
        self.parse_primary()
    }

    /// primary = NUMBER | IDENT ['(' arg_list ')'] | '(' expr ')'
    fn parse_primary(&mut self) -> Result<CalcExpr, String> {
        match self.advance() {
            Token::Number(n) => Ok(CalcExpr::Number(n)),
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
pub fn evaluate_calc_expr(
    expr: &CalcExpr,
    values: &HashMap<String, f64>,
    ctx: Option<&VisualCalcContext>,
) -> Result<f64, String> {
    match expr {
        CalcExpr::Number(n) => Ok(*n),
        CalcExpr::Reference(name) => {
            // Case-insensitive lookup
            let name_lower = name.to_lowercase();
            for (key, val) in values {
                if key.to_lowercase() == name_lower {
                    return Ok(*val);
                }
            }
            Err(format!("Unknown field or item: '{}'", name))
        }
        CalcExpr::BinOp { op, left, right } => {
            let l = evaluate_calc_expr(left, values, ctx)?;
            let r = evaluate_calc_expr(right, values, ctx)?;
            Ok(match op {
                CalcOp::Add => l + r,
                CalcOp::Sub => l - r,
                CalcOp::Mul => l * r,
                CalcOp::Div => {
                    if r == 0.0 { f64::NAN } else { l / r }
                }
            })
        }
        CalcExpr::Negate(inner) => {
            let v = evaluate_calc_expr(inner, values, ctx)?;
            Ok(-v)
        }
        CalcExpr::FunctionCall { name, args } => {
            evaluate_function(name, args, values, ctx)
        }
    }
}

/// Convenience: parse and evaluate in one call (without visual calc context).
pub fn eval_calc_formula(
    formula: &str,
    values: &HashMap<String, f64>,
) -> Result<f64, String> {
    let expr = parse_calc_formula(formula)?;
    evaluate_calc_expr(&expr, values, None)
}

/// Convenience: parse and evaluate with visual calc context.
pub(crate) fn eval_calc_formula_with_ctx(
    formula: &str,
    values: &HashMap<String, f64>,
    ctx: &VisualCalcContext,
) -> Result<f64, String> {
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
        CalcExpr::Number(_) | CalcExpr::Reference(_) => false,
        CalcExpr::BinOp { left, right, .. } => {
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
) -> Result<f64, String> {
    let upper = name.to_uppercase();

    // Non-visual-calc functions could go here in the future (e.g., IF, ABS, MAX, MIN).
    // For now, all recognized functions require a visual calc context.

    let ctx = ctx.ok_or_else(|| {
        format!("Function '{}' requires a visual calculation context (only available in pivot calculated fields)", name)
    })?;

    match upper.as_str() {
        "RUNNINGSUM" => eval_runningsum(args, values, ctx),
        "MOVINGAVERAGE" => eval_movingaverage(args, values, ctx),
        "PREVIOUS" => eval_previous(args, values, ctx),
        "NEXT" => eval_next(args, values, ctx),
        "FIRST" => eval_first(args, values, ctx),
        "LAST" => eval_last(args, values, ctx),
        "PARENT" | "COLLAPSE" => eval_collapse(args, values, ctx),
        "GRANDTOTAL" | "COLLAPSEALL" => eval_collapseall(args, values, ctx),
        "CHILDREN" | "EXPAND" => eval_expand(args, values, ctx),
        "LEAVES" | "EXPANDALL" => eval_expandall(args, values, ctx),
        "RANGE" => eval_range(args, values, ctx),
        "ISATLEVEL" => eval_isatlevel(args, values, ctx),
        "LOOKUP" => eval_lookup(args, values, ctx, false),
        "LOOKUPWITHTOTALS" => eval_lookup(args, values, ctx, true),
        _ => Err(format!("Unknown function: '{}'", name)),
    }
}

// ============================================================================
// HELPER: FIELD VALUE LOOKUP
// ============================================================================

/// Resolve the first argument (a field expression) to a field name string.
/// Supports both `Reference("[Sales]")` and evaluable expressions.
fn resolve_field_value(
    expr: &CalcExpr,
    row_idx: usize,
    ctx: &VisualCalcContext,
) -> f64 {
    if let CalcExpr::Reference(name) = expr {
        lookup_field_in_row(name, row_idx, ctx)
    } else {
        // Evaluate the expression in the context of the given row
        let row_values = ctx.row_values.get(row_idx).cloned().unwrap_or_default();
        let child_ctx = VisualCalcContext {
            current_row_idx: row_idx,
            row_items: ctx.row_items,
            row_values: ctx.row_values,
            field_names_by_depth: ctx.field_names_by_depth,
            col_ctx: None,
        };
        evaluate_calc_expr(expr, &row_values, Some(&child_ctx)).unwrap_or(f64::NAN)
    }
}

/// Lookup a field value in a specific row (case-insensitive).
fn lookup_field_in_row(name: &str, row_idx: usize, ctx: &VisualCalcContext) -> f64 {
    if let Some(row_values) = ctx.row_values.get(row_idx) {
        let name_lower = name.to_lowercase();
        for (key, val) in row_values {
            if key.to_lowercase() == name_lower {
                return *val;
            }
        }
    }
    f64::NAN
}

/// Lookup a field value in a specific column (case-insensitive).
fn lookup_field_in_col(name: &str, col_idx: usize, col_ctx: &ColumnAxisContext) -> f64 {
    if let Some(col_values) = col_ctx.col_values.get(col_idx) {
        let name_lower = name.to_lowercase();
        for (key, val) in col_values {
            if key.to_lowercase() == name_lower {
                return *val;
            }
        }
    }
    f64::NAN
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

/// Resolve a field value on the appropriate axis.
fn resolve_field_on_axis(
    expr: &CalcExpr,
    idx: usize,
    axis: AxisMode,
    ctx: &VisualCalcContext,
) -> f64 {
    match axis {
        AxisMode::Rows => resolve_field_value(expr, idx, ctx),
        AxisMode::Columns => {
            if let Some(ref col_ctx) = ctx.col_ctx {
                if let CalcExpr::Reference(name) = expr {
                    lookup_field_in_col(name, idx, col_ctx)
                } else {
                    f64::NAN // Complex expressions on column axis not yet supported
                }
            } else {
                f64::NAN
            }
        }
    }
}

/// Get visible rows/columns for the appropriate axis partition.
fn get_partition_items_for_axis(
    axis: AxisMode,
    ctx: &VisualCalcContext,
    reset: &ResetMode,
) -> (Vec<usize>, usize) {
    match axis {
        AxisMode::Rows => {
            let visible = get_partition_visible_rows(ctx.current_row_idx, ctx, reset);
            let current = ctx.current_row_idx;
            (visible, current)
        }
        AxisMode::Columns => {
            if let Some(ref col_ctx) = ctx.col_ctx {
                // For columns, collect non-subtotal/grand-total column items
                let visible: Vec<usize> = col_ctx.col_items.iter().enumerate()
                    .filter(|(_, item)| !item.is_subtotal && !item.is_grand_total)
                    .map(|(i, _)| i)
                    .collect();
                let current = col_ctx.current_col_idx;
                (visible, current)
            } else {
                (vec![0], 0)
            }
        }
    }
}

// ============================================================================
// HELPER: RESET / PARTITION
// ============================================================================

/// Resolve a reset argument to a ResetMode.
fn resolve_reset(arg: Option<&CalcExpr>, ctx: &VisualCalcContext) -> ResetMode {
    let arg = match arg {
        Some(a) => a,
        None => return ResetMode::None,
    };
    match arg {
        CalcExpr::Number(n) => {
            let n = *n as i32;
            if n == 0 {
                ResetMode::None
            } else if n == 1 {
                ResetMode::HighestParent
            } else if n == -1 {
                ResetMode::LowestParent
            } else if n > 0 {
                ResetMode::DepthLevel((n - 1).min(ctx.field_names_by_depth.len() as i32 - 1).max(0) as usize)
            } else {
                // Negative: relative mode. -1 = immediate parent, -2 = grandparent, etc.
                let current_depth = ctx.row_items[ctx.current_row_idx].depth;
                let target = current_depth as i32 + n; // n is negative
                ResetMode::DepthLevel(target.max(0) as usize)
            }
        }
        CalcExpr::Reference(name) => {
            match name.to_uppercase().as_str() {
                "NONE" => ResetMode::None,
                "HIGHESTPARENT" => ResetMode::HighestParent,
                "LOWESTPARENT" => ResetMode::LowestParent,
                _ => {
                    // Field name → find depth
                    let name_lower = name.to_lowercase();
                    for (depth, field_name) in ctx.field_names_by_depth.iter().enumerate() {
                        if field_name.to_lowercase() == name_lower {
                            return ResetMode::DepthLevel(depth);
                        }
                    }
                    ResetMode::None
                }
            }
        }
        _ => ResetMode::None,
    }
}

/// Get visible (non-subtotal, non-grand-total) data rows within a partition.
/// Returns indices into row_items.
fn get_partition_visible_rows(
    current_row_idx: usize,
    ctx: &VisualCalcContext,
    reset: &ResetMode,
) -> Vec<usize> {
    let current = &ctx.row_items[current_row_idx];
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

    // Get the group key at the reset depth for the current row
    let partition_key: Option<Vec<crate::cache::ValueId>> = reset_depth.map(|rd| {
        let gv = &current.group_values;
        gv.iter().take(rd + 1).copied().collect()
    });

    // Collect visible rows that belong to the same partition
    let mut result = Vec::new();
    for (i, item) in ctx.row_items.iter().enumerate() {
        // Skip subtotals and grand totals
        if item.is_subtotal || item.is_grand_total {
            continue;
        }

        // Check partition membership
        if let Some(ref pk) = partition_key {
            let item_key: Vec<crate::cache::ValueId> = item.group_values.iter()
                .take(pk.len())
                .copied()
                .collect();
            if item_key != *pk {
                continue;
            }
        }

        // Only include rows at the same depth or deeper (leaf-level data rows)
        // For window functions, we want rows at the same hierarchy level
        if item.depth >= current_depth || reset_depth.is_none() || item.depth == current_depth {
            result.push(i);
        }
    }

    // If we got no results (edge case), at least include current row
    if result.is_empty() {
        result.push(current_row_idx);
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

/// RUNNINGSUM(field, [reset])
fn eval_runningsum(
    args: &[CalcExpr],
    _values: &HashMap<String, f64>,
    ctx: &VisualCalcContext,
) -> Result<f64, String> {
    if args.is_empty() {
        return Err("RUNNINGSUM requires at least 1 argument".to_string());
    }
    let (axis, trim) = resolve_axis_from_args(args);
    let effective_args = &args[..args.len() - trim];
    let field_expr = &effective_args[0];
    let reset = resolve_reset(effective_args.get(1), ctx);

    let (visible, current) = get_partition_items_for_axis(axis, ctx, &reset);
    let pos = find_current_position(current, &visible);
    let end = match pos {
        Some(p) => p + 1,
        None => return Ok(f64::NAN),
    };

    let mut sum = 0.0;
    for &idx in &visible[..end] {
        sum += resolve_field_on_axis(field_expr, idx, axis, ctx);
    }
    Ok(sum)
}

/// MOVINGAVERAGE(field, window, [reset])
fn eval_movingaverage(
    args: &[CalcExpr],
    values: &HashMap<String, f64>,
    ctx: &VisualCalcContext,
) -> Result<f64, String> {
    if args.len() < 2 {
        return Err("MOVINGAVERAGE requires at least 2 arguments: (field, window)".to_string());
    }
    let (axis, trim) = resolve_axis_from_args(args);
    let effective_args = &args[..args.len() - trim];
    let field_expr = &effective_args[0];
    let window = evaluate_calc_expr(&effective_args[1], values, Some(ctx))?.round() as usize;
    if window == 0 {
        return Err("MOVINGAVERAGE window size must be > 0".to_string());
    }
    let reset = resolve_reset(effective_args.get(2), ctx);
    let (visible, current) = get_partition_items_for_axis(axis, ctx, &reset);

    let pos = match find_current_position(current, &visible) {
        Some(p) => p,
        None => return Ok(f64::NAN),
    };

    let start = if pos + 1 >= window { pos + 1 - window } else { 0 };
    let count = pos + 1 - start;
    let mut sum = 0.0;
    for &idx in &visible[start..=pos] {
        sum += resolve_field_on_axis(field_expr, idx, axis, ctx);
    }
    Ok(sum / count as f64)
}

/// PREVIOUS(field, [steps], [reset/axis])
fn eval_previous(
    args: &[CalcExpr],
    values: &HashMap<String, f64>,
    ctx: &VisualCalcContext,
) -> Result<f64, String> {
    if args.is_empty() {
        return Err("PREVIOUS requires at least 1 argument".to_string());
    }
    let (axis, trim) = resolve_axis_from_args(args);
    let effective_args = &args[..args.len() - trim];
    let field_expr = &effective_args[0];
    let steps = if effective_args.len() >= 2 {
        evaluate_calc_expr(&effective_args[1], values, Some(ctx))?.round() as usize
    } else {
        1
    };
    let reset = resolve_reset(effective_args.get(2), ctx);
    let (visible, current) = get_partition_items_for_axis(axis, ctx, &reset);

    let pos = match find_current_position(current, &visible) {
        Some(p) => p,
        None => return Ok(f64::NAN),
    };

    if pos < steps {
        return Ok(f64::NAN);
    }

    let target_idx = visible[pos - steps];
    Ok(resolve_field_on_axis(field_expr, target_idx, axis, ctx))
}

/// NEXT(field, [steps], [reset/axis])
fn eval_next(
    args: &[CalcExpr],
    values: &HashMap<String, f64>,
    ctx: &VisualCalcContext,
) -> Result<f64, String> {
    if args.is_empty() {
        return Err("NEXT requires at least 1 argument".to_string());
    }
    let (axis, trim) = resolve_axis_from_args(args);
    let effective_args = &args[..args.len() - trim];
    let field_expr = &effective_args[0];
    let steps = if effective_args.len() >= 2 {
        evaluate_calc_expr(&effective_args[1], values, Some(ctx))?.round() as usize
    } else {
        1
    };
    let reset = resolve_reset(effective_args.get(2), ctx);
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
    Ok(resolve_field_on_axis(field_expr, target_idx, axis, ctx))
}

/// FIRST(field, [reset/axis])
fn eval_first(
    args: &[CalcExpr],
    _values: &HashMap<String, f64>,
    ctx: &VisualCalcContext,
) -> Result<f64, String> {
    if args.is_empty() {
        return Err("FIRST requires at least 1 argument".to_string());
    }
    let (axis, trim) = resolve_axis_from_args(args);
    let effective_args = &args[..args.len() - trim];
    let field_expr = &effective_args[0];
    let reset = resolve_reset(effective_args.get(1), ctx);
    let (visible, _current) = get_partition_items_for_axis(axis, ctx, &reset);

    if visible.is_empty() {
        return Ok(f64::NAN);
    }
    Ok(resolve_field_on_axis(field_expr, visible[0], axis, ctx))
}

/// LAST(field, [reset/axis])
fn eval_last(
    args: &[CalcExpr],
    _values: &HashMap<String, f64>,
    ctx: &VisualCalcContext,
) -> Result<f64, String> {
    if args.is_empty() {
        return Err("LAST requires at least 1 argument".to_string());
    }
    let (axis, trim) = resolve_axis_from_args(args);
    let effective_args = &args[..args.len() - trim];
    let field_expr = &effective_args[0];
    let reset = resolve_reset(effective_args.get(1), ctx);
    let (visible, _current) = get_partition_items_for_axis(axis, ctx, &reset);

    if visible.is_empty() {
        return Ok(f64::NAN);
    }
    Ok(resolve_field_on_axis(field_expr, *visible.last().unwrap(), axis, ctx))
}

// ============================================================================
// HIERARCHY FUNCTIONS
// ============================================================================

/// COLLAPSE(field) — value at parent level
fn eval_collapse(
    args: &[CalcExpr],
    values: &HashMap<String, f64>,
    ctx: &VisualCalcContext,
) -> Result<f64, String> {
    if args.is_empty() {
        return Err("PARENT requires at least 1 argument".to_string());
    }
    let field_expr = &args[0];

    // Optional second argument: number of levels to go up (default 1)
    let levels = if args.len() >= 2 {
        evaluate_calc_expr(&args[1], values, Some(ctx))?.round() as usize
    } else {
        1
    };

    // Walk up the parent chain `levels` times
    let mut idx = ctx.current_row_idx;
    for _ in 0..levels {
        let item = &ctx.row_items[idx];
        if item.parent_index < 0 || item.is_grand_total {
            // Reached root — return grand total
            return eval_collapseall(args, values, ctx);
        }
        idx = item.parent_index as usize;
    }

    Ok(resolve_field_value(field_expr, idx, ctx))
}

/// COLLAPSEALL(field) — value at grand total level
fn eval_collapseall(
    args: &[CalcExpr],
    _values: &HashMap<String, f64>,
    ctx: &VisualCalcContext,
) -> Result<f64, String> {
    if args.is_empty() {
        return Err("COLLAPSEALL requires 1 argument".to_string());
    }
    let field_expr = &args[0];

    // Find the grand total row
    for (i, item) in ctx.row_items.iter().enumerate() {
        if item.is_grand_total {
            return Ok(resolve_field_value(field_expr, i, ctx));
        }
    }

    // No grand total row found — return NaN
    Ok(f64::NAN)
}

/// EXPAND(expr) — average of expression evaluated at each direct child
fn eval_expand(
    args: &[CalcExpr],
    values: &HashMap<String, f64>,
    ctx: &VisualCalcContext,
) -> Result<f64, String> {
    if args.is_empty() {
        return Err("EXPAND requires 1 argument".to_string());
    }
    let expr = &args[0];

    // Find direct children
    let children: Vec<usize> = ctx.row_items.iter().enumerate()
        .filter(|(_, item)| {
            item.parent_index == ctx.current_row_idx as i32
            && !item.is_subtotal
        })
        .map(|(i, _)| i)
        .collect();

    if children.is_empty() {
        // Leaf node — evaluate with current values
        return evaluate_calc_expr(expr, values, Some(ctx));
    }

    let mut sum = 0.0;
    for &child_idx in &children {
        sum += resolve_field_value(expr, child_idx, ctx);
    }
    Ok(sum / children.len() as f64)
}

/// EXPANDALL(expr) — average of expression evaluated at leaf level
fn eval_expandall(
    args: &[CalcExpr],
    values: &HashMap<String, f64>,
    ctx: &VisualCalcContext,
) -> Result<f64, String> {
    if args.is_empty() {
        return Err("EXPANDALL requires 1 argument".to_string());
    }
    let expr = &args[0];

    // Find all leaf descendants
    let leaves: Vec<usize> = ctx.row_items.iter().enumerate()
        .filter(|(i, item)| {
            !item.has_children
            && !item.is_subtotal
            && !item.is_grand_total
            && is_descendant_of(*i, ctx.current_row_idx, ctx.row_items)
        })
        .map(|(i, _)| i)
        .collect();

    if leaves.is_empty() {
        // Already at leaf — evaluate with current values
        return evaluate_calc_expr(expr, values, Some(ctx));
    }

    let mut sum = 0.0;
    for &leaf_idx in &leaves {
        sum += resolve_field_value(expr, leaf_idx, ctx);
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

/// RANGE(offset_or_size) — returns a slice of rows as an "axis reference".
/// Typically used with AVERAGEX: AVERAGEX(RANGE(3), [Sales])
/// For simplicity, RANGE(n) returns the average of the field's values over
/// n rows centered on (or up to) the current row.
/// RANGE(start, end) returns the average from relative offset start to end.
fn eval_range(
    args: &[CalcExpr],
    values: &HashMap<String, f64>,
    ctx: &VisualCalcContext,
) -> Result<f64, String> {
    if args.is_empty() {
        return Err("RANGE requires at least 1 argument: RANGE(size) or RANGE(start, end)".to_string());
    }

    // RANGE can be used in two ways:
    // 1. RANGE(size) — last N rows up to current (like a window)
    // 2. RANGE(start, end) — relative offsets from current position
    let visible = get_partition_visible_rows(ctx.current_row_idx, ctx, &ResetMode::None);
    let pos = match find_current_position(ctx.current_row_idx, &visible) {
        Some(p) => p,
        None => return Ok(f64::NAN),
    };

    let (range_start, range_end) = if args.len() >= 2 {
        // RANGE(start, end) — relative offsets
        let start_offset = evaluate_calc_expr(&args[0], values, Some(ctx))?.round() as i32;
        let end_offset = evaluate_calc_expr(&args[1], values, Some(ctx))?.round() as i32;
        let s = (pos as i32 + start_offset).max(0) as usize;
        let e = ((pos as i32 + end_offset).max(0) as usize).min(visible.len() - 1);
        (s, e)
    } else {
        // RANGE(size) — last N rows ending at current
        let size = evaluate_calc_expr(&args[0], values, Some(ctx))?.round() as usize;
        let s = if pos + 1 >= size { pos + 1 - size } else { 0 };
        (s, pos)
    };

    // Return the count of rows in the range (useful with division for averages)
    // In practice, RANGE is most useful when combined with other expressions.
    // For standalone use, return the count so RANGE(3) in arithmetic context = 3.
    Ok((range_end - range_start + 1) as f64)
}

/// ISATLEVEL(field_name) — returns 1.0 if the specified field is present at the
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
        _ => return Err("ISATLEVEL argument must be a field name reference".to_string()),
    };

    let current = &ctx.row_items[ctx.current_row_idx];

    // Check if the named field corresponds to the current row's depth
    let field_lower = field_name.to_lowercase();
    for (depth, name) in ctx.field_names_by_depth.iter().enumerate() {
        if name.to_lowercase() == field_lower {
            // The field is at this depth. Check if current row is at or below this depth.
            // A row is "at" a field's level if its depth matches the field's depth.
            if current.depth == depth {
                return Ok(1.0);
            } else {
                return Ok(0.0);
            }
        }
    }

    // Field not found in row fields — return 0
    Ok(0.0)
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
    values: &HashMap<String, f64>,
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
            _ => return Err("LOOKUP field argument must be a field name".to_string()),
        };

        // Value can be a string reference or a number
        let match_value = match &args[i + 1] {
            CalcExpr::Reference(name) => name.clone(),
            CalcExpr::Number(n) => {
                // Format number for matching (trim trailing zeros)
                let s = format!("{}", n);
                s
            }
            _ => return Err("LOOKUP value argument must be a value or field name".to_string()),
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
            let field_lower = field_name.to_lowercase();
            let mut field_depth: Option<usize> = None;
            for (d, name) in ctx.field_names_by_depth.iter().enumerate() {
                if name.to_lowercase() == field_lower {
                    field_depth = Some(d);
                    break;
                }
            }

            if let Some(depth) = field_depth {
                // Get the label for this item at the target depth.
                // If the item is at or below the target depth, walk up to find the ancestor label.
                let ancestor_label = get_label_at_depth(row_idx, depth, ctx);
                let match_lower = match_value.to_lowercase();
                if ancestor_label.to_lowercase() != match_lower {
                    all_match = false;
                    break;
                }
            } else {
                // Field not found in row fields — check value fields
                if let Some(row_values) = ctx.row_values.get(row_idx) {
                    let val_lower = field_lower.clone();
                    let found = row_values.iter().any(|(k, v)| {
                        k.to_lowercase() == val_lower && format!("{}", v) == *match_value
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
            return Ok(resolve_field_value(expr, row_idx, ctx));
        }
    }

    // No matching row found
    Ok(f64::NAN)
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
// AXIS RESOLUTION
// ============================================================================

/// Resolve axis parameter from function arguments.
/// Checks the last argument for ROWS/COLUMNS keyword.
fn _resolve_axis(args: &[CalcExpr]) -> AxisMode {
    if let Some(last) = args.last() {
        if let CalcExpr::Reference(name) = last {
            match name.to_uppercase().as_str() {
                "ROWS" => return AxisMode::Rows,
                "COLUMNS" => return AxisMode::Columns,
                _ => {}
            }
        }
    }
    AxisMode::Rows // Default
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

fn collect_refs(expr: &CalcExpr, refs: &mut Vec<String>) {
    match expr {
        CalcExpr::Number(_) => {}
        CalcExpr::Reference(name) => refs.push(name.clone()),
        CalcExpr::BinOp { left, right, .. } => {
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

    #[test]
    fn test_simple_arithmetic() {
        let mut values = HashMap::new();
        values.insert("Revenue".to_string(), 1000.0);
        values.insert("Cost".to_string(), 600.0);

        let expr = parse_calc_formula("Revenue - Cost").unwrap();
        assert_eq!(evaluate_calc_expr(&expr, &values, None).unwrap(), 400.0);

        let expr = parse_calc_formula("Revenue * 0.1").unwrap();
        assert_eq!(evaluate_calc_expr(&expr, &values, None).unwrap(), 100.0);

        let expr = parse_calc_formula("(Revenue - Cost) / Revenue").unwrap();
        assert_eq!(evaluate_calc_expr(&expr, &values, None).unwrap(), 0.4);
    }

    #[test]
    fn test_quoted_names() {
        let mut values = HashMap::new();
        values.insert("Total Sales".to_string(), 500.0);
        values.insert("Returns".to_string(), 50.0);

        let expr = parse_calc_formula("'Total Sales' - Returns").unwrap();
        assert_eq!(evaluate_calc_expr(&expr, &values, None).unwrap(), 450.0);
    }

    #[test]
    fn test_case_insensitive() {
        let mut values = HashMap::new();
        values.insert("Sales".to_string(), 100.0);

        let expr = parse_calc_formula("sales * 2").unwrap();
        assert_eq!(evaluate_calc_expr(&expr, &values, None).unwrap(), 200.0);
    }

    #[test]
    fn test_division_by_zero() {
        let mut values = HashMap::new();
        values.insert("A".to_string(), 10.0);
        values.insert("B".to_string(), 0.0);

        let expr = parse_calc_formula("A / B").unwrap();
        let result = evaluate_calc_expr(&expr, &values, None).unwrap();
        assert!(result.is_nan());
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
    }
}
