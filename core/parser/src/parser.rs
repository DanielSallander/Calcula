//! FILENAME: core/parser/src/parser.rs
//! PURPOSE: Recursive descent parser that converts a stream of Tokens into an AST.
//! CONTEXT: This is the second stage of the parsing pipeline. It takes tokens
//! from the Lexer and builds an Expression tree that can be evaluated.
//!
//! GRAMMAR (complete with sheet references and absolute markers):
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
//!   cell_or_range  --> cell_ref (":" cell_ref)?
//!   cell_ref       --> "$"? COLUMN "$"? ROW
//!   column_ref     --> "$"? COLUMN ":" "$"? COLUMN
//!   row_ref        --> "$"? NUMBER ":" "$"? NUMBER
//!   function_call  --> IDENTIFIER "(" arguments? ")"
//!   arguments      --> expression ("," expression)*
//!   table_ref      --> IDENTIFIER "[" table_spec "]" | "[" table_spec "]"
//!   table_spec     --> "@" column_name | "#" special | column_name | nested_spec
//!   column_name    --> IDENTIFIER | "[" IDENTIFIER "]"

use crate::ast::{BinaryOperator, BuiltinFunction, Expression, TableSpecifier, UnaryOperator, Value};
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
            // Dollar sign - start of absolute reference like $A1 or $1:$5
            Token::Dollar => {
                self.advance();
                self.parse_absolute_reference(None)
            }

            // Number literal - could also be start of row reference (e.g., 1:5)
            Token::Number(n) => {
                self.advance();

                // Check if this is a row reference (number followed by ':')
                if self.current_token == Token::Colon {
                    return self.parse_row_reference(None, n, false);
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
            // function call, sheet reference prefix, table reference, or named reference
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

                // Check if it's a structured table reference (followed by '[')
                if self.current_token == Token::LBracket {
                    return self.parse_table_reference(name);
                }

                // Check if this identifier could be part of a valid cell reference.
                // Names containing _, ., \, or with column part beyond XFD (16384)
                // are treated as named references (defined names).
                if !Self::is_valid_cell_ref_identifier(&name) {
                    return Ok(Expression::NamedRef { name });
                }

                // From here, the identifier has a valid column/cell pattern.

                // Check if it's a range or column reference (followed by ':')
                if self.current_token == Token::Colon {
                    return self.parse_range_or_column_ref(None, name, false);
                }

                // Handle column-only identifier followed by $ (absolute row marker).
                // This covers patterns like D$2, AA$100 where the lexer splits the
                // reference into Identifier("D"), Dollar, Number(2) because $ is not
                // alphanumeric and stops identifier scanning.
                let is_col_only = name.chars().all(|c| c.is_ascii_alphabetic());
                if is_col_only && self.current_token == Token::Dollar {
                    self.advance(); // consume $
                    if let Token::Number(n) = self.current_token.clone() {
                        self.advance();
                        let row = n as u32;
                        if row == 0 {
                            return Err(ParseError::new("Row number must be >= 1"));
                        }
                        // Check for range continuation like D$2:D6
                        if self.current_token == Token::Colon {
                            return self.parse_range_continuation(
                                None, name, row, false, true,
                            );
                        }
                        return Ok(Expression::CellRef {
                            sheet: None,
                            col: name.to_uppercase(),
                            row,
                            col_absolute: false,
                            row_absolute: true,
                        });
                    }
                    return Err(ParseError::new(format!(
                        "Expected row number after $, found {:?}",
                        self.current_token
                    )));
                }

                // If identifier is column-only (no digits) and not followed by : or $,
                // it cannot be a cell reference. Treat as a named reference.
                // Examples: =REVENUE + 1, =A (where A is a defined name)
                if is_col_only {
                    return Ok(Expression::NamedRef { name });
                }

                // Otherwise it's a simple cell reference (letters + digits like A1, AA100)
                self.parse_cell_ref(None, name, false, false)
            }

            // Standalone structured reference: [@Column] (implies current table)
            Token::LBracket => {
                return self.parse_table_reference(String::new());
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

    /// Parses a reference that starts with $ (absolute marker).
    fn parse_absolute_reference(&mut self, sheet: Option<String>) -> ParseResult<Expression> {
        match self.current_token.clone() {
            // $A1 or $A:$B (column is absolute)
            Token::Identifier(name) => {
                self.advance();
                
                // Check if this is a column-only reference (no digits in name)
                let is_col_only = name.chars().all(|c| c.is_ascii_alphabetic());
                
                if self.current_token == Token::Colon {
                    // Could be $A:B, $A$1:B2, etc.
                    return self.parse_range_or_column_ref(sheet, name, true);
                }
                
                if is_col_only {
                    // Check for $A$1 pattern ($ followed by number)
                    if self.current_token == Token::Dollar {
                        self.advance();
                        // Expect row number
                        if let Token::Number(row) = self.current_token.clone() {
                            self.advance();
                            let row = row as u32;
                            if row == 0 {
                                return Err(ParseError::new("Row number must be >= 1"));
                            }
                            
                            // Check for range
                            if self.current_token == Token::Colon {
                                return self.parse_range_continuation(sheet, name, row, true, true);
                            }
                            
                            return Ok(Expression::CellRef {
                                sheet,
                                col: name.to_uppercase(),
                                row,
                                col_absolute: true,
                                row_absolute: true,
                            });
                        } else {
                            return Err(ParseError::new("Expected row number after $"));
                        }
                    }
                    
                    // $A without row - could be column reference $A:B
                    if self.current_token == Token::Colon {
                        return self.parse_column_ref_continuation(sheet, name, true);
                    }
                    
                    return Err(ParseError::new(format!(
                        "Expected row number or ':' after ${}",
                        name
                    )));
                }
                
                // Has digits, so it's like $A1 (col absolute, row not)
                self.parse_cell_ref(sheet, name, true, false)
            }
            
            // $1:$5 (row reference with absolute start)
            Token::Number(n) => {
                self.advance();
                if self.current_token == Token::Colon {
                    return self.parse_row_reference(sheet, n, true);
                }
                Err(ParseError::new("Expected ':' after absolute row number"))
            }
            
            _ => Err(ParseError::new(format!(
                "Expected identifier or number after $, found {:?}",
                self.current_token
            ))),
        }
    }

    /// Parses a reference after a sheet prefix (SheetName!).
    /// Handles cell refs, ranges, column refs, and row refs with sheet context.
    fn parse_sheet_reference(&mut self, sheet_name: String) -> ParseResult<Expression> {
        match self.current_token.clone() {
            // $ - absolute reference
            Token::Dollar => {
                self.advance();
                self.parse_absolute_reference(Some(sheet_name))
            }
            
            // Number - must be a row reference like Sheet1!1:5
            Token::Number(n) => {
                self.advance();
                if self.current_token == Token::Colon {
                    self.parse_row_reference(Some(sheet_name), n, false)
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
                    self.parse_range_or_column_ref(Some(sheet_name), name, false)
                } else {
                    // FIX: Handle column-only identifier followed by $ (absolute row marker)
                    // e.g., Sheet1!D$2
                    let is_col_only = name.chars().all(|c| c.is_ascii_alphabetic());
                    if is_col_only && self.current_token == Token::Dollar {
                        self.advance(); // consume $
                        if let Token::Number(n) = self.current_token.clone() {
                            self.advance();
                            let row = n as u32;
                            if row == 0 {
                                return Err(ParseError::new("Row number must be >= 1"));
                            }
                            if self.current_token == Token::Colon {
                                return self.parse_range_continuation(
                                    Some(sheet_name), name, row, false, true,
                                );
                            }
                            return Ok(Expression::CellRef {
                                sheet: Some(sheet_name),
                                col: name.to_uppercase(),
                                row,
                                col_absolute: false,
                                row_absolute: true,
                            });
                        }
                        return Err(ParseError::new(format!(
                            "Expected row number after $, found {:?}",
                            self.current_token
                        )));
                    }
                    self.parse_cell_ref(Some(sheet_name), name, false, false)
                }
            }

            _ => Err(ParseError::new(format!(
                "Expected cell reference after '!', found {:?}",
                self.current_token
            ))),
        }
    }

    /// Parses a cell reference from an identifier string like "A1" or "AA100".
    fn parse_cell_ref(
        &self, 
        sheet: Option<String>, 
        identifier: String,
        col_absolute: bool,
        row_absolute: bool,
    ) -> ParseResult<Expression> {
        let (col, row) = self.split_cell_reference(&identifier)?;
        Ok(Expression::CellRef { 
            sheet, 
            col, 
            row,
            col_absolute,
            row_absolute,
        })
    }

    /// Parses a range or column reference after seeing "IDENTIFIER :".
    fn parse_range_or_column_ref(
        &mut self,
        sheet: Option<String>,
        start_identifier: String,
        start_col_absolute: bool,
    ) -> ParseResult<Expression> {
        // Consume the ':'
        self.advance();

        // Check for absolute marker on end
        let end_col_absolute = if self.current_token == Token::Dollar {
            self.advance();
            true
        } else {
            false
        };

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

        // FIX: Check if end identifier is column-only but followed by $ (absolute row marker).
        // In that case it's a cell reference like D$6, not a column reference like D:D.
        // Without this check, parse_range_or_column_ref treats "D" as column-only
        // and tries to create a ColumnRef, or split_cell_reference("D") fails with
        // "Cell reference missing row".
        let end_has_dollar_row = end_is_col_only && self.current_token == Token::Dollar;

        if start_is_col_only && end_is_col_only && !end_has_dollar_row {
            // Column reference like A:B or $A:$B
            Ok(Expression::ColumnRef {
                sheet,
                start_col: start_identifier.to_uppercase(),
                end_col: end_identifier.to_uppercase(),
                start_absolute: start_col_absolute,
                end_absolute: end_col_absolute,
            })
        } else {
            // Cell range like A1:B10 or D2:D$6
            let (start_col, start_row) = self.split_cell_reference(&start_identifier)?;

            // FIX: Handle end identifier being column-only with $row pattern.
            // e.g., in D2:D$6, the end "D" has no row digits -- the row comes
            // from the Dollar + Number tokens that follow.
            let (end_col, end_row, end_row_absolute) = if end_is_col_only {
                if self.current_token == Token::Dollar {
                    self.advance();
                    if let Token::Number(n) = self.current_token.clone() {
                        self.advance();
                        (end_identifier.to_uppercase(), n as u32, true)
                    } else {
                        return Err(ParseError::new(
                            "Expected row number after $ in range end",
                        ));
                    }
                } else {
                    return Err(ParseError::new(format!(
                        "Cell reference missing row: {}",
                        end_identifier
                    )));
                }
            } else {
                let (col, row) = self.split_cell_reference(&end_identifier)?;
                (col, row, false)
            };

            Ok(Expression::Range {
                sheet,
                start: Box::new(Expression::CellRef {
                    sheet: None,
                    col: start_col,
                    row: start_row,
                    col_absolute: start_col_absolute,
                    row_absolute: false,
                }),
                end: Box::new(Expression::CellRef {
                    sheet: None,
                    col: end_col,
                    row: end_row,
                    col_absolute: end_col_absolute,
                    row_absolute: end_row_absolute,
                }),
            })
        }
    }

    /// Parses continuation of a range after we have the start cell.
    fn parse_range_continuation(
        &mut self,
        sheet: Option<String>,
        start_col: String,
        start_row: u32,
        start_col_absolute: bool,
        start_row_absolute: bool,
    ) -> ParseResult<Expression> {
        // Consume the ':'
        self.advance();

        // Parse end cell with potential absolute markers
        let end_col_absolute = if self.current_token == Token::Dollar {
            self.advance();
            true
        } else {
            false
        };

        let end_identifier = match self.current_token.clone() {
            Token::Identifier(name) => {
                self.advance();
                name
            }
            _ => {
                return Err(ParseError::new("Expected cell reference after ':'"));
            }
        };

        // Check for $row pattern
        let end_row_absolute = if self.current_token == Token::Dollar {
            self.advance();
            true
        } else {
            false
        };

        // If end_row_absolute, we need to get the row number
        let (end_col, end_row) = if end_row_absolute {
            // Pattern like B$10 - identifier is just column
            if let Token::Number(n) = self.current_token.clone() {
                self.advance();
                (end_identifier.to_uppercase(), n as u32)
            } else {
                return Err(ParseError::new("Expected row number after $"));
            }
        } else {
            self.split_cell_reference(&end_identifier)?
        };

        Ok(Expression::Range {
            sheet,
            start: Box::new(Expression::CellRef {
                sheet: None,
                col: start_col.to_uppercase(),
                row: start_row,
                col_absolute: start_col_absolute,
                row_absolute: start_row_absolute,
            }),
            end: Box::new(Expression::CellRef {
                sheet: None,
                col: end_col,
                row: end_row,
                col_absolute: end_col_absolute,
                row_absolute: end_row_absolute,
            }),
        })
    }

    /// Parses column reference continuation like $A:B or $A:$B
    fn parse_column_ref_continuation(
        &mut self,
        sheet: Option<String>,
        start_col: String,
        start_absolute: bool,
    ) -> ParseResult<Expression> {
        // Consume the ':'
        self.advance();

        let end_absolute = if self.current_token == Token::Dollar {
            self.advance();
            true
        } else {
            false
        };

        let end_col = match self.current_token.clone() {
            Token::Identifier(name) => {
                self.advance();
                name
            }
            _ => {
                return Err(ParseError::new("Expected column after ':'"));
            }
        };

        // Verify it's column-only
        if !end_col.chars().all(|c| c.is_ascii_alphabetic()) {
            return Err(ParseError::new("Expected column letter in column reference"));
        }

        Ok(Expression::ColumnRef {
            sheet,
            start_col: start_col.to_uppercase(),
            end_col: end_col.to_uppercase(),
            start_absolute,
            end_absolute,
        })
    }

    /// Parses a row reference after seeing "NUMBER :".
    fn parse_row_reference(
        &mut self,
        sheet: Option<String>,
        start_num: f64,
        start_absolute: bool,
    ) -> ParseResult<Expression> {
        // Consume the ':'
        self.advance();

        // Check for absolute marker on end row
        let end_absolute = if self.current_token == Token::Dollar {
            self.advance();
            true
        } else {
            false
        };

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
            start_absolute,
            end_absolute,
        })
    }

    /// Parses a function call like SUM(A1, A2, 10).
    /// Resolves the function name to a BuiltinFunction enum at parse time.
    fn parse_function_call(&mut self, name: String) -> ParseResult<Expression> {
        // Resolve function name to enum ONCE at parse time (not every evaluation)
        let func = BuiltinFunction::from_name(&name);

        // Consume the '('
        self.advance();

        let mut args = Vec::new();

        // Handle empty argument list
        if self.current_token == Token::RParen {
            self.advance();
            return Ok(Expression::FunctionCall { func, args });
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

        Ok(Expression::FunctionCall { func, args })
    }

    // ========================================================================
    // STRUCTURED TABLE REFERENCE PARSING
    // ========================================================================

    /// Parses a structured table reference.
    /// Called when we see `Identifier [` or standalone `[`.
    ///
    /// Supported syntax:
    ///   Table1[Column]           -> Column specifier
    ///   Table1[@Column]          -> This-row column
    ///   Table1[#All]             -> All rows
    ///   Table1[#Data]            -> Data rows only
    ///   Table1[#Headers]         -> Header row
    ///   Table1[#Totals]          -> Totals row
    ///   Table1[[#Headers],[Col]] -> Special + column combo
    ///   [@Column]                -> This-row (table inferred from context)
    ///   [Column]                 -> Column (table inferred from context)
    fn parse_table_reference(&mut self, table_name: String) -> ParseResult<Expression> {
        // Consume the '['
        self.expect(Token::LBracket)?;

        let specifier = self.parse_table_specifier()?;

        // Consume the closing ']'
        self.expect(Token::RBracket)?;

        Ok(Expression::TableRef {
            table_name,
            specifier,
        })
    }

    /// Parses the content inside brackets for a table reference.
    fn parse_table_specifier(&mut self) -> ParseResult<TableSpecifier> {
        // Check for @ prefix (this-row reference)
        if self.current_token == Token::At {
            self.advance();
            return self.parse_this_row_specifier();
        }

        // Check for # prefix (special specifier like #All, #Data, etc.)
        // The # character is not a token, so it will appear as part of an identifier
        // or we need to handle it specially. Actually in our lexer # is an Illegal char.
        // Let's check for [#All] pattern: the lexer sees # as Illegal('#').
        // Instead, we handle this by checking for LBracket (nested brackets).
        if self.current_token == Token::LBracket {
            // Nested bracket: could be [[#Specifier],[Column]] or [[Col1]:[Col2]]
            return self.parse_nested_bracket_specifier();
        }

        // Check for Illegal('#') which starts special specifiers
        if let Token::Illegal('#') = self.current_token {
            self.advance();
            return self.parse_special_specifier();
        }

        // Plain column reference: [ColumnName]
        let col_name = self.parse_bracket_content()?;

        // Check if followed by ] : [ for column range
        if self.current_token == Token::RBracket {
            // Peek ahead: is this ] followed by : [ for a range?
            // No, the ] will be consumed by the caller. Just return the column.
            return Ok(TableSpecifier::Column(col_name));
        }

        // Check for comma (special + column combo like [#Headers],[Col])
        if self.current_token == Token::Comma {
            // Shouldn't get here for plain column, but handle gracefully
            return Ok(TableSpecifier::Column(col_name));
        }

        Ok(TableSpecifier::Column(col_name))
    }

    /// Parses a this-row specifier after @ has been consumed.
    fn parse_this_row_specifier(&mut self) -> ParseResult<TableSpecifier> {
        // After @, we could have:
        //   @Column      -> ThisRow("Column")
        //   @[Column]    -> ThisRow("Column")  (bracketed form)

        if self.current_token == Token::LBracket {
            // Bracketed form: @[Column]
            self.advance(); // consume [
            let col_name = self.parse_bracket_content()?;
            self.expect(Token::RBracket)?; // consume inner ]

            // Check for range: @[Col1]:@[Col2] or @[Col1]:[Col2]
            if self.current_token == Token::Colon {
                self.advance();
                let end_col = self.parse_range_end_column()?;
                return Ok(TableSpecifier::ThisRowRange(col_name, end_col));
            }

            return Ok(TableSpecifier::ThisRow(col_name));
        }

        // Unbracketed form: @ColumnName (identifier follows)
        if let Token::Identifier(name) = self.current_token.clone() {
            self.advance();

            // Check for range: @Col1:@Col2
            if self.current_token == Token::Colon {
                self.advance();
                let end_col = self.parse_range_end_column()?;
                return Ok(TableSpecifier::ThisRowRange(name, end_col));
            }

            return Ok(TableSpecifier::ThisRow(name));
        }

        Err(ParseError::new("Expected column name after '@' in table reference"))
    }

    /// Parses the end column of a column range after ':' has been consumed.
    /// Handles @[Col], @Col, [Col], and bare Col forms.
    fn parse_range_end_column(&mut self) -> ParseResult<String> {
        // @[Col] or @Col
        if self.current_token == Token::At {
            self.advance();
        }

        if self.current_token == Token::LBracket {
            self.advance();
            let name = self.parse_bracket_content()?;
            self.expect(Token::RBracket)?;
            return Ok(name);
        }

        if let Token::Identifier(name) = self.current_token.clone() {
            self.advance();
            return Ok(name);
        }

        Err(ParseError::new("Expected column name in table range reference"))
    }

    /// Parses nested bracket specifiers like [[#Headers],[Col]] or [[Col1]:[Col2]].
    fn parse_nested_bracket_specifier(&mut self) -> ParseResult<TableSpecifier> {
        self.advance(); // consume outer [

        // Check for #specifier inside
        if let Token::Illegal('#') = self.current_token {
            self.advance();
            let special = self.parse_special_specifier()?;
            self.expect(Token::RBracket)?; // close the [#...]

            // Check for comma followed by column
            if self.current_token == Token::Comma {
                self.advance();
                // Expect [ColumnName]
                self.expect(Token::LBracket)?;
                let col_name = self.parse_bracket_content()?;
                self.expect(Token::RBracket)?;
                return Ok(TableSpecifier::SpecialColumn(Box::new(special), col_name));
            }

            // Just a special specifier in nested brackets
            return Ok(special);
        }

        // Column range: [Col1]:[Col2]
        let col1 = self.parse_bracket_content()?;
        self.expect(Token::RBracket)?; // close [Col1]

        if self.current_token == Token::Colon {
            self.advance();
            self.expect(Token::LBracket)?;
            let col2 = self.parse_bracket_content()?;
            self.expect(Token::RBracket)?;
            return Ok(TableSpecifier::ColumnRange(col1, col2));
        }

        // Single column in nested brackets (unusual but valid)
        Ok(TableSpecifier::Column(col1))
    }

    /// Parses a special specifier keyword after '#' has been consumed.
    fn parse_special_specifier(&mut self) -> ParseResult<TableSpecifier> {
        // The text after # should be an identifier: All, Data, Headers, Totals, This Row
        if let Token::Identifier(name) = self.current_token.clone() {
            self.advance();
            match name.to_uppercase().as_str() {
                "ALL" => Ok(TableSpecifier::AllRows),
                "DATA" => Ok(TableSpecifier::DataRows),
                "HEADERS" => Ok(TableSpecifier::Headers),
                "TOTALS" => Ok(TableSpecifier::Totals),
                "THIS" => {
                    // Expect "Row" to follow for "#This Row"
                    if let Token::Identifier(row_word) = self.current_token.clone() {
                        if row_word.to_uppercase() == "ROW" {
                            self.advance();
                            // #This Row is equivalent to this-row with no column
                            // In practice it's used in combination: [#This Row],[Column]
                            // We'll treat it similarly to a this-row marker
                            return Ok(TableSpecifier::DataRows); // Placeholder - resolved at use site
                        }
                    }
                    Err(ParseError::new("Expected 'Row' after '#This' in table reference"))
                }
                _ => Err(ParseError::new(format!(
                    "Unknown table specifier: #{}",
                    name
                ))),
            }
        } else {
            Err(ParseError::new("Expected specifier name after '#'"))
        }
    }

    /// Reads bracket content as a string until we hit ']', ',', or ':'.
    /// This handles column names that may contain spaces or special characters.
    fn parse_bracket_content(&mut self) -> ParseResult<String> {
        let mut content = String::new();

        loop {
            match &self.current_token {
                Token::RBracket | Token::Comma | Token::Colon => break,
                Token::EOF => {
                    return Err(ParseError::new("Unexpected end of input in table reference"));
                }
                Token::Identifier(s) => {
                    if !content.is_empty() {
                        content.push(' ');
                    }
                    content.push_str(s);
                    self.advance();
                }
                Token::Number(n) => {
                    if !content.is_empty() {
                        content.push(' ');
                    }
                    // Format integer numbers without decimal point
                    if *n == (*n as i64) as f64 {
                        content.push_str(&format!("{}", *n as i64));
                    } else {
                        content.push_str(&format!("{}", n));
                    }
                    self.advance();
                }
                Token::String(s) => {
                    if !content.is_empty() {
                        content.push(' ');
                    }
                    content.push_str(s);
                    self.advance();
                }
                // Consume other tokens as part of the column name
                Token::Plus => { content.push('+'); self.advance(); }
                Token::Minus => { content.push('-'); self.advance(); }
                Token::Asterisk => { content.push('*'); self.advance(); }
                Token::Slash => { content.push('/'); self.advance(); }
                Token::Ampersand => { content.push('&'); self.advance(); }
                Token::Dollar => { content.push('$'); self.advance(); }
                Token::Exclamation => { content.push('!'); self.advance(); }
                _ => {
                    // Unknown token in bracket content — stop
                    break;
                }
            }
        }

        if content.is_empty() {
            return Err(ParseError::new("Empty column name in table reference"));
        }

        Ok(content)
    }

    /// Checks whether an identifier could be part of a valid cell reference.
    /// Returns false for names that contain non-alphanumeric characters
    /// (underscores, periods, backslashes) or have a column part beyond XFD (16384).
    /// Column-only identifiers (all letters) with a valid column are considered
    /// valid because they might be part of a column reference (A:B) or followed
    /// by a $ row marker (D$2) — handled by subsequent logic in parse_primary.
    fn is_valid_cell_ref_identifier(name: &str) -> bool {
        // Names with non-alphanumeric characters are always defined names
        if !name.chars().all(|c| c.is_ascii_alphanumeric()) {
            return false;
        }

        // Split into letter prefix and digit suffix
        let col_part: String = name.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
        let rest: &str = &name[col_part.len()..];

        // Must start with at least one letter
        if col_part.is_empty() {
            return false;
        }

        // If there are non-digit characters after the digit part, not a valid cell ref
        // (e.g., "Q1SALES" has letters after digits)
        if !rest.is_empty() && !rest.chars().all(|c| c.is_ascii_digit()) {
            return false;
        }

        // Check column part is within Excel's range (A=1 to XFD=16384)
        let col_num = Self::col_letters_to_number(&col_part);
        if col_num > 16384 {
            return false;
        }

        // If column-only (no digits), it could be a column reference handled later
        if rest.is_empty() {
            return true;
        }

        // Check row part is within Excel's range (1 to 1048576)
        if let Ok(row) = rest.parse::<u32>() {
            row >= 1 && row <= 1048576
        } else {
            false
        }
    }

    /// Converts column letters to a 1-based column number.
    /// A=1, B=2, ..., Z=26, AA=27, AB=28, ..., XFD=16384
    /// Returns u32::MAX on overflow (any 4+ letter column exceeds 16384 anyway).
    fn col_letters_to_number(letters: &str) -> u32 {
        let mut result: u32 = 0;
        for ch in letters.chars() {
            let val = (ch.to_ascii_uppercase() as u32) - ('A' as u32) + 1;
            result = match result.checked_mul(26).and_then(|r| r.checked_add(val)) {
                Some(r) => r,
                None => return u32::MAX,
            };
        }
        result
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