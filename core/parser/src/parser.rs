//! FILENAME: core/parser/src/parser.rs
//! PURPOSE: Recursive descent parser that converts a stream of Tokens into an AST.
//! CONTEXT: This is the second stage of the parsing pipeline. It takes tokens
//! from the Lexer and builds an Expression tree that can be evaluated.
//!
//! GRAMMAR (complete with sheet references):
//!   expression     --> comparison
//!   comparison     --> concatenation ( ("=" | "<>" | "<" | ">" | "<=" | ">=") concatenation )*
//!   concatenation  --> additive ( "&" additive )*
//!   additive       --> multiplicative ( ("+" | "-") multiplicative )*
//!   multiplicative --> unary ( ("*" | "/") unary )*
//!   unary          --> "-" unary | power
//!   power          --> primary ( "^" unary )?
//!   primary        --> NUMBER | STRING | BOOLEAN | reference | function_call | "(" expression ")"
//!   reference      --> [sheet_prefix] (cell_or_range | column_ref | row_ref)
//!   sheet_prefix   --> (IDENTIFIER | QUOTED_IDENTIFIER) "!"
//!   cell_or_range  --> IDENTIFIER (":" IDENTIFIER)?
//!   column_ref     --> IDENTIFIER ":" IDENTIFIER   // where both are column-only (e.g., A:B)
//!   row_ref        --> NUMBER ":" NUMBER           // where both are row-only (e.g., 1:5)
//!   function_call  --> IDENTIFIER "(" arguments? ")"
//!   arguments      --> expression ("," expression)*

use crate::ast::{BinaryOperator, Expression, UnaryOperator, Value};
use crate::lexer::Lexer;
use crate::token::Token;

/// Parser errors with descriptive messages.
#[derive(Debug, PartialEq, Clone)]
pub struct ParseError {
    pub message: String,
}

impl ParseError {
    pub fn new(message: impl Into<String>) -> Self {
        ParseError {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Parse error: {}", self.message)
    }
}

impl std::error::Error for ParseError {}

pub type ParseResult<T> = Result<T, ParseError>;

/// The Parser struct holds the lexer and current token state.
pub struct Parser<'a> {
    lexer: Lexer<'a>,
    current_token: Token,
    /// Track if we've consumed the leading '=' to distinguish formula mode
    #[allow(dead_code)]
    is_formula_mode: bool,
}

impl<'a> Parser<'a> {
    /// Creates a new parser from an input string.
    /// Automatically advances to the first token.
    pub fn new(input: &'a str) -> Self {
        let mut lexer = Lexer::new(input);
        let current_token = lexer.next_token();
        Parser {
            lexer,
            current_token,
            is_formula_mode: false,
        }
    }

    /// Parses the entire input and returns the AST.
    /// Handles the optional leading '=' that indicates a formula.
    pub fn parse(&mut self) -> ParseResult<Expression> {
        // Skip the leading '=' if present (formula indicator)
        if self.current_token == Token::Equals {
            self.is_formula_mode = true;
            self.advance();
        }

        // Handle empty formula
        if self.current_token == Token::EOF {
            return Err(ParseError::new("Empty expression"));
        }

        let expr = self.parse_expression()?;

        // Ensure we consumed all tokens
        if self.current_token != Token::EOF {
            return Err(ParseError::new(format!(
                "Unexpected token after expression: {:?}",
                self.current_token
            )));
        }

        Ok(expr)
    }

    /// Advances to the next token.
    fn advance(&mut self) {
        self.current_token = self.lexer.next_token();
    }

    /// Checks if the current token matches the expected token.
    /// If it matches, advances and returns Ok. Otherwise returns an error.
    fn expect(&mut self, expected: Token) -> ParseResult<()> {
        if self.current_token == expected {
            self.advance();
            Ok(())
        } else {
            Err(ParseError::new(format!(
                "Expected {:?}, found {:?}",
                expected, self.current_token
            )))
        }
    }

    /// Entry point for expression parsing.
    fn parse_expression(&mut self) -> ParseResult<Expression> {
        self.parse_comparison()
    }

    /// Parses comparison expressions (=, <>, <, >, <=, >=).
    fn parse_comparison(&mut self) -> ParseResult<Expression> {
        let mut left = self.parse_concatenation()?;

        loop {
            let op = match &self.current_token {
                Token::Equals => BinaryOperator::Equal,
                Token::NotEqual => BinaryOperator::NotEqual,
                Token::LessThan => BinaryOperator::LessThan,
                Token::GreaterThan => BinaryOperator::GreaterThan,
                Token::LessEqual => BinaryOperator::LessEqual,
                Token::GreaterEqual => BinaryOperator::GreaterEqual,
                _ => break,
            };

            self.advance();
            let right = self.parse_concatenation()?;

            left = Expression::BinaryOp {
                left: Box::new(left),
                op,
                right: Box::new(right),
            };
        }

        Ok(left)
    }

    /// Parses concatenation expressions (&).
    fn parse_concatenation(&mut self) -> ParseResult<Expression> {
        let mut left = self.parse_additive()?;

        while self.current_token == Token::Ampersand {
            self.advance();
            let right = self.parse_additive()?;

            left = Expression::BinaryOp {
                left: Box::new(left),
                op: BinaryOperator::Concat,
                right: Box::new(right),
            };
        }

        Ok(left)
    }

    /// Parses additive expressions (+ and -).
    fn parse_additive(&mut self) -> ParseResult<Expression> {
        let mut left = self.parse_multiplicative()?;

        loop {
            let op = match &self.current_token {
                Token::Plus => BinaryOperator::Add,
                Token::Minus => BinaryOperator::Subtract,
                _ => break,
            };

            self.advance();
            let right = self.parse_multiplicative()?;

            left = Expression::BinaryOp {
                left: Box::new(left),
                op,
                right: Box::new(right),
            };
        }

        Ok(left)
    }

    /// Parses multiplicative expressions (* and /).
    fn parse_multiplicative(&mut self) -> ParseResult<Expression> {
        let mut left = self.parse_unary()?;

        loop {
            let op = match &self.current_token {
                Token::Asterisk => BinaryOperator::Multiply,
                Token::Slash => BinaryOperator::Divide,
                _ => break,
            };

            self.advance();
            let right = self.parse_unary()?;

            left = Expression::BinaryOp {
                left: Box::new(left),
                op,
                right: Box::new(right),
            };
        }

        Ok(left)
    }

    /// Parses unary expressions (negation).
    fn parse_unary(&mut self) -> ParseResult<Expression> {
        if self.current_token == Token::Minus {
            self.advance();
            let operand = self.parse_unary()?;
            return Ok(Expression::UnaryOp {
                op: UnaryOperator::Negate,
                operand: Box::new(operand),
            });
        }

        self.parse_power()
    }

    /// Parses power/exponentiation expressions (^).
    fn parse_power(&mut self) -> ParseResult<Expression> {
        let left = self.parse_primary()?;

        if self.current_token == Token::Caret {
            self.advance();
            let right = self.parse_unary()?;

            return Ok(Expression::BinaryOp {
                left: Box::new(left),
                op: BinaryOperator::Power,
                right: Box::new(right),
            });
        }

        Ok(left)
    }

    /// Parses primary expressions (literals, cell refs, function calls, parentheses).
    fn parse_primary(&mut self) -> ParseResult<Expression> {
        match self.current_token.clone() {
            // Number literal - could also be start of row reference (e.g., 1:5)
            Token::Number(n) => {
                self.advance();

                // Check if this is a row reference (number followed by ':')
                if self.current_token == Token::Colon {
                    return self.parse_row_reference(None, n);
                }

                Ok(Expression::Literal(Value::Number(n)))
            }

            // String literal
            Token::String(s) => {
                self.advance();
                Ok(Expression::Literal(Value::String(s)))
            }

            // Boolean literal
            Token::Boolean(b) => {
                self.advance();
                Ok(Expression::Literal(Value::Boolean(b)))
            }

            // Quoted identifier - must be a sheet reference
            Token::QuotedIdentifier(sheet_name) => {
                self.advance();
                self.expect(Token::Exclamation)?;
                self.parse_sheet_reference(sheet_name)
            }

            // Identifier: could be a cell reference, range, column reference, 
            // function call, or sheet reference prefix
            Token::Identifier(name) => {
                self.advance();

                // Check if it's a sheet reference (followed by '!')
                if self.current_token == Token::Exclamation {
                    self.advance();
                    return self.parse_sheet_reference(name);
                }

                // Check if it's a function call (followed by '(')
                if self.current_token == Token::LParen {
                    return self.parse_function_call(name);
                }

                // Check if it's a range or column reference (followed by ':')
                if self.current_token == Token::Colon {
                    return self.parse_range_or_column_ref(None, name);
                }

                // Otherwise it's a simple cell reference
                self.parse_cell_ref(None, name)
            }

            // Parenthesized expression
            Token::LParen => {
                self.advance();
                let expr = self.parse_expression()?;
                self.expect(Token::RParen)?;
                Ok(expr)
            }

            // Error cases
            Token::EOF => Err(ParseError::new("Unexpected end of expression")),

            Token::Illegal(ch) => Err(ParseError::new(format!("Illegal character: {}", ch))),

            token => Err(ParseError::new(format!("Unexpected token: {:?}", token))),
        }
    }

    /// Parses a reference after a sheet prefix (SheetName!).
    /// Handles cell refs, ranges, column refs, and row refs with sheet context.
    fn parse_sheet_reference(&mut self, sheet_name: String) -> ParseResult<Expression> {
        match self.current_token.clone() {
            // Number - must be a row reference like Sheet1!1:5
            Token::Number(n) => {
                self.advance();
                if self.current_token == Token::Colon {
                    self.parse_row_reference(Some(sheet_name), n)
                } else {
                    Err(ParseError::new(
                        "Expected ':' after row number in sheet reference",
                    ))
                }
            }

            // Identifier - cell ref, range, or column ref
            Token::Identifier(name) => {
                self.advance();

                if self.current_token == Token::Colon {
                    self.parse_range_or_column_ref(Some(sheet_name), name)
                } else {
                    self.parse_cell_ref(Some(sheet_name), name)
                }
            }

            _ => Err(ParseError::new(format!(
                "Expected cell reference after '!', found {:?}",
                self.current_token
            ))),
        }
    }

    /// Parses a cell reference from an identifier string like "A1" or "AA100".
    fn parse_cell_ref(&self, sheet: Option<String>, identifier: String) -> ParseResult<Expression> {
        let (col, row) = self.split_cell_reference(&identifier)?;
        Ok(Expression::CellRef { sheet, col, row })
    }

    /// Parses a range or column reference after seeing "IDENTIFIER :".
    fn parse_range_or_column_ref(
        &mut self,
        sheet: Option<String>,
        start_identifier: String,
    ) -> ParseResult<Expression> {
        // Consume the ':'
        self.advance();

        // Expect another identifier for the end
        let end_identifier = match self.current_token.clone() {
            Token::Identifier(name) => {
                self.advance();
                name
            }
            _ => {
                return Err(ParseError::new(
                    "Expected identifier after ':' in range/column reference",
                ))
            }
        };

        // Determine if this is a column reference or cell range
        let start_is_col_only = start_identifier.chars().all(|c| c.is_ascii_alphabetic());
        let end_is_col_only = end_identifier.chars().all(|c| c.is_ascii_alphabetic());

        if start_is_col_only && end_is_col_only {
            // Column reference like A:B or A:A
            Ok(Expression::ColumnRef {
                sheet,
                start_col: start_identifier.to_uppercase(),
                end_col: end_identifier.to_uppercase(),
            })
        } else {
            // Cell range like A1:B10
            let (start_col, start_row) = self.split_cell_reference(&start_identifier)?;
            let (end_col, end_row) = self.split_cell_reference(&end_identifier)?;

            Ok(Expression::Range {
                sheet,
                start: Box::new(Expression::CellRef {
                    sheet: None, // Sheet is on the Range, not individual cells
                    col: start_col,
                    row: start_row,
                }),
                end: Box::new(Expression::CellRef {
                    sheet: None,
                    col: end_col,
                    row: end_row,
                }),
            })
        }
    }

    /// Parses a row reference after seeing "NUMBER :".
    fn parse_row_reference(
        &mut self,
        sheet: Option<String>,
        start_num: f64,
    ) -> ParseResult<Expression> {
        // Consume the ':'
        self.advance();

        // Expect another number for the end row
        let end_num = match self.current_token.clone() {
            Token::Number(n) => {
                self.advance();
                n
            }
            _ => {
                return Err(ParseError::new(
                    "Expected number after ':' in row reference",
                ))
            }
        };

        let start_row = start_num as u32;
        let end_row = end_num as u32;

        if start_row == 0 || end_row == 0 {
            return Err(ParseError::new("Row numbers must be >= 1"));
        }

        Ok(Expression::RowRef {
            sheet,
            start_row,
            end_row,
        })
    }

    /// Parses a function call like SUM(A1, A2, 10).
    fn parse_function_call(&mut self, name: String) -> ParseResult<Expression> {
        // Consume the '('
        self.advance();

        let mut args = Vec::new();

        // Handle empty argument list
        if self.current_token == Token::RParen {
            self.advance();
            return Ok(Expression::FunctionCall { name, args });
        }

        // Parse first argument
        args.push(self.parse_expression()?);

        // Parse remaining arguments separated by commas
        while self.current_token == Token::Comma {
            self.advance();
            args.push(self.parse_expression()?);
        }

        // Expect closing ')'
        self.expect(Token::RParen)?;

        Ok(Expression::FunctionCall { name, args })
    }

    /// Splits a cell reference string like "A1" or "AA100" into column and row parts.
    fn split_cell_reference(&self, identifier: &str) -> ParseResult<(String, u32)> {
        let mut col = String::new();
        let mut row_str = String::new();

        for ch in identifier.chars() {
            if ch.is_ascii_alphabetic() {
                if !row_str.is_empty() {
                    return Err(ParseError::new(format!(
                        "Invalid cell reference: {}",
                        identifier
                    )));
                }
                col.push(ch);
            } else if ch.is_ascii_digit() {
                row_str.push(ch);
            } else {
                return Err(ParseError::new(format!(
                    "Invalid character in cell reference: {}",
                    ch
                )));
            }
        }

        if col.is_empty() {
            return Err(ParseError::new(format!(
                "Cell reference missing column: {}",
                identifier
            )));
        }

        if row_str.is_empty() {
            return Err(ParseError::new(format!(
                "Cell reference missing row: {}",
                identifier
            )));
        }

        let row: u32 = row_str.parse().map_err(|_| {
            ParseError::new(format!(
                "Invalid row number in cell reference: {}",
                identifier
            ))
        })?;

        if row == 0 {
            return Err(ParseError::new(format!(
                "Row number must be >= 1: {}",
                identifier
            )));
        }

        Ok((col.to_uppercase(), row))
    }
}

/// Convenience function to parse a formula string directly.
pub fn parse(input: &str) -> ParseResult<Expression> {
    let mut parser = Parser::new(input);
    parser.parse()
}