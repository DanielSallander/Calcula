//! FILENAME: core/pivot-engine/src/calculated.rs
//! Simple expression evaluator for calculated fields and calculated items.
//!
//! Supports: field/item name references, +, -, *, /, parentheses, numeric literals.
//! Field names are matched case-insensitively against a provided lookup map.

use std::collections::HashMap;

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
                        // Unquoted identifier
                        let mut name = String::new();
                        while let Some(c) = self.peek_char() {
                            if c.is_alphanumeric() || c == '_' || c == ' ' {
                                // Allow spaces in unquoted names (greedy),
                                // but trim trailing spaces
                                name.push(c);
                                self.next_char();
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

    /// primary = NUMBER | IDENT | '(' expr ')'
    fn parse_primary(&mut self) -> Result<CalcExpr, String> {
        match self.advance() {
            Token::Number(n) => Ok(CalcExpr::Number(n)),
            Token::Ident(name) => Ok(CalcExpr::Reference(name)),
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
/// For calculated fields: names map to aggregated value field values.
/// For calculated items: names map to sibling item aggregated values.
pub fn evaluate_calc_expr(
    expr: &CalcExpr,
    values: &HashMap<String, f64>,
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
            let l = evaluate_calc_expr(left, values)?;
            let r = evaluate_calc_expr(right, values)?;
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
            let v = evaluate_calc_expr(inner, values)?;
            Ok(-v)
        }
    }
}

/// Convenience: parse and evaluate in one call.
pub fn eval_calc_formula(
    formula: &str,
    values: &HashMap<String, f64>,
) -> Result<f64, String> {
    let expr = parse_calc_formula(formula)?;
    evaluate_calc_expr(&expr, values)
}

/// Extracts all field/item name references from a formula.
pub fn extract_references(formula: &str) -> Result<Vec<String>, String> {
    let expr = parse_calc_formula(formula)?;
    let mut refs = Vec::new();
    collect_refs(&expr, &mut refs);
    Ok(refs)
}

fn collect_refs(expr: &CalcExpr, refs: &mut Vec<String>) {
    match expr {
        CalcExpr::Number(_) => {}
        CalcExpr::Reference(name) => refs.push(name.clone()),
        CalcExpr::BinOp { left, right, .. } => {
            collect_refs(left, refs);
            collect_refs(right, refs);
        }
        CalcExpr::Negate(inner) => collect_refs(inner, refs),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simple_arithmetic() {
        let mut values = HashMap::new();
        values.insert("Revenue".to_string(), 1000.0);
        values.insert("Cost".to_string(), 600.0);

        assert_eq!(eval_calc_formula("Revenue - Cost", &values).unwrap(), 400.0);
        assert_eq!(eval_calc_formula("Revenue * 0.1", &values).unwrap(), 100.0);
        assert_eq!(eval_calc_formula("(Revenue - Cost) / Revenue", &values).unwrap(), 0.4);
    }

    #[test]
    fn test_quoted_names() {
        let mut values = HashMap::new();
        values.insert("Total Sales".to_string(), 500.0);
        values.insert("Returns".to_string(), 50.0);

        assert_eq!(eval_calc_formula("'Total Sales' - Returns", &values).unwrap(), 450.0);
    }

    #[test]
    fn test_case_insensitive() {
        let mut values = HashMap::new();
        values.insert("Sales".to_string(), 100.0);

        assert_eq!(eval_calc_formula("sales * 2", &values).unwrap(), 200.0);
    }

    #[test]
    fn test_division_by_zero() {
        let mut values = HashMap::new();
        values.insert("A".to_string(), 10.0);
        values.insert("B".to_string(), 0.0);

        let result = eval_calc_formula("A / B", &values).unwrap();
        assert!(result.is_nan());
    }

    #[test]
    fn test_extract_references() {
        let refs = extract_references("Revenue - Cost + Tax * 0.5").unwrap();
        assert_eq!(refs, vec!["Revenue", "Cost", "Tax"]);
    }
}
