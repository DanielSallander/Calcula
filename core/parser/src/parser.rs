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
use identity::RefSiteId;

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
        let mut left = self.parse_power()?;

        loop {
            let op = match &self.current_token {
                Token::Asterisk => BinaryOperator::Multiply,
                Token::Slash => BinaryOperator::Divide,
                _ => break,
            };

            self.advance();
            let right = self.parse_power()?;

            left = Expression::BinaryOp {
                left: Box::new(left),
                op,
                right: Box::new(right),
            };
        }

        Ok(left)
    }

    /// Parses power/exponentiation expressions (^).
    ///
    /// LEFT-associative, and it did not used to be. Excel folds equal-priority
    /// operators left to right with no exception for `^`, so `=2^3^2` is
    /// `(2^3)^2` = 64; recursing into the unary level for the right operand
    /// made it `2^(3^2)` = 512. Right-associativity is the mathematical
    /// convention and the wrong answer here.
    ///
    /// Its OPERANDS are the unary level, which is one rank TIGHTER — so `=-2^2`
    /// raises the already-negated -2 and answers 4, as Excel does. (Both of
    /// these were pinned by passing tests asserting the other answer; the tests
    /// moved with the code.)
    fn parse_power(&mut self) -> ParseResult<Expression> {
        let mut left = self.parse_unary()?;

        while self.current_token == Token::Caret {
            self.advance();
            let right = self.parse_unary()?;

            left = Expression::BinaryOp {
                left: Box::new(left),
                op: BinaryOperator::Power,
                right: Box::new(right),
            };
        }

        Ok(left)
    }

    /// Parses prefix expressions: negation `-x` and Lotus-compatibility `+x`.
    ///
    /// Right-recursive, so `--x` nests as `Negate(Negate(x))` — the DOUBLE
    /// UNARY idiom — and mixed runs like `=-+-5` parse.
    fn parse_unary(&mut self) -> ParseResult<Expression> {
        let op = match self.current_token {
            Token::Minus => Some(UnaryOperator::Negate),
            // `=+A1`. Excel accepts a leading plus everywhere a value is
            // expected, because typing `+` to start a formula is a habit it
            // inherited from Lotus 1-2-3 and never dropped. Without this arm the
            // token fell through to `parse_primary` and every `=+...` formula —
            // including ones imported verbatim from a real .xlsx — was a parse
            // error stored as `#VALUE!`.
            Token::Plus => Some(UnaryOperator::Plus),
            _ => None,
        };

        if let Some(op) = op {
            self.advance();
            let operand = self.parse_unary()?;
            return Ok(Expression::UnaryOp {
                op,
                operand: Box::new(operand),
            });
        }

        self.parse_percent()
    }

    /// Parses the POSTFIX percent operator: `=50%`, `=A1%`, `=(B1-C1)%`.
    ///
    /// A real operator rather than number-literal syntax, which is why it lives
    /// at its own precedence level instead of inside the lexer's number reader:
    /// Excel applies it to any expression, so `=SUM(A1:A9)%` and `=(1+1)%` are
    /// both legal. Repeats fold, so `=50%%` is 0.005.
    fn parse_percent(&mut self) -> ParseResult<Expression> {
        let mut expr = self.parse_intersection()?;

        while self.current_token == Token::Percent {
            self.advance();
            expr = Expression::UnaryOp {
                op: UnaryOperator::Percent,
                operand: Box::new(expr),
            };
        }

        Ok(expr)
    }

    /// Excel's INTERSECTION operator: a SPACE between two references.
    ///
    /// ONE LEVEL TIGHTER THAN POWER, because Excel's reference operators bind
    /// before arithmetic.
    ///
    /// `=SUM(A1:A5 A3:C3)` is the overlap (A3); a NON-overlapping pair is the only
    /// thing in Excel that produces `#NULL!` — which is why Calcula could never
    /// produce that error: it did not parse the operator at all. `=A1:A5 C1:C5` was
    /// a hard parse error surfacing as `#VALUE!` with NO dependency edges, so the
    /// cell also never recalculated.
    ///
    /// The lexer discards whitespace, so "was there a space here" is not in the
    /// token stream at all; `last_token_had_leading_whitespace` is the single bit it
    /// now keeps for this. Requiring it is what stops two merely-adjacent operands
    /// from intersecting and changing what existing formulas mean.
    fn parse_intersection(&mut self) -> ParseResult<Expression> {
        let mut left = self.parse_intersection_operand()?;

        // Left-associative, like every other binary level in this parser.
        while self.at_intersection_operand() {
            let right = self.parse_intersection_operand()?;
            left = Expression::BinaryOp {
                left: Box::new(left),
                op: BinaryOperator::Intersect,
                right: Box::new(right),
            };
        }

        Ok(left)
    }

    /// True when the CURRENT token could begin a second reference operand AND had
    /// whitespace in front of it.
    ///
    /// Both halves are load-bearing. Without the token check, `A1 +B1` would try to
    /// intersect with `+`; without the whitespace check, any two adjacent operands
    /// would intersect.
    fn at_intersection_operand(&self) -> bool {
        if !self.lexer.last_token_had_leading_whitespace() {
            return false;
        }
        matches!(
            self.current_token,
            Token::Identifier(_)
                | Token::QuotedIdentifier(_)
                | Token::Dollar
                // A PARENTHESISED operand. `=SUM((A1:A3) (A2:C2))` is Excel's
                // own spelling and was a hard parse error ("Expected RParen,
                // found LParen") while the identical unparenthesised
                // `=SUM(A1:A3 A2:C2)` answered 2 -- so a user who grouped the
                // operands to make the formula readable got their text stored
                // as TEXT. Parentheses are transparent in this AST (the LParen
                // arm returns the inner expression), so the operand that
                // reaches `reference_rect` is the same Range either way.
                | Token::LParen
                // A ROW reference begins with a NUMBER (`2:2`), so this is
                // required for `A:A 2:2` to parse at all.
                //
                // NAMED DIVERGENCE, accepted: it also makes `=A1 2` parse, and
                // evaluate to #NULL! because a bare number is not a reference
                // (`reference_rect` returns None). Excel rejects that at entry
                // with a syntax error instead. Single-token lookahead cannot tell
                // `2` from `2:2` here, and the alternative — dropping Number —
                // loses whole-row intersection, which is a real Excel feature.
                // An invalid formula giving #NULL! rather than a syntax error is
                // the cheaper of the two wrongs.
                | Token::Number(_)
        )
    }

    /// ONE operand of an intersection, with its subscripts and invocations.
    ///
    /// `parse_index_access_chain` must run PER OPERAND rather than once over the
    /// whole intersection: it handles `expr[index]` and LAMBDA invocation
    /// `myLambda(10)`, so attaching it to the intersection RESULT would change what
    /// `=A1[0] B1` and every existing subscript formula mean.
    fn parse_intersection_operand(&mut self) -> ParseResult<Expression> {
        let operand = self.parse_primary()?;
        self.parse_index_access_chain(operand)
    }

    /// Parses zero or more trailing [index] subscript accesses and (args) invocations.
    /// Only applies to expressions where subscript/invocation makes sense
    /// (CellRef, FunctionCall, NamedRef, IndexAccess).
    /// This avoids conflicts with TableRef which handles its own [ ] syntax.
    fn parse_index_access_chain(&mut self, expr: Expression) -> ParseResult<Expression> {
        let mut result = expr;
        loop {
            match &self.current_token {
                // Subscript access: expr[index]
                Token::LBracket => {
                    match &result {
                        Expression::CellRef { .. }
                        | Expression::FunctionCall { .. }
                        | Expression::NamedRef { .. }
                        | Expression::IndexAccess { .. }
                        | Expression::ListLiteral { .. }
                        | Expression::DictLiteral { .. } => {
                            self.advance(); // consume '['
                            let index = self.parse_expression()?;
                            self.expect(Token::RBracket)?;
                            result = Expression::IndexAccess {
                                target: Box::new(result),
                                index: Box::new(index),
                            };
                        }
                        _ => break,
                    }
                }
                // Invocation: expr(args) — for calling LAMBDA results
                // Only allow after FunctionCall (e.g., LAMBDA(x, x+1)(10))
                // or NamedRef (e.g., myLambda(10))
                Token::LParen => {
                    match &result {
                        Expression::FunctionCall { .. } => {
                            // Parse the invocation arguments
                            self.advance(); // consume '('
                            let mut call_args = vec![result];
                            if self.current_token != Token::RParen {
                                call_args.push(self.parse_expression()?);
                                while self.current_token == Token::Comma {
                                    self.advance();
                                    call_args.push(self.parse_expression()?);
                                }
                            }
                            self.expect(Token::RParen)?;
                            result = Expression::FunctionCall {
                                func: BuiltinFunction::Custom("__INVOKE__".to_string()),
                                args: call_args,
                                ref_site_id: RefSiteId::ZERO,
                            };
                        }
                        _ => break,
                    }
                }
                // Spill range operator: CellRef# references the entire spill range
                Token::Hash => {
                    match &result {
                        Expression::CellRef { .. } => {
                            self.advance(); // consume '#'
                            result = Expression::SpillRef {
                                cell: Box::new(result),
                                ref_site_id: RefSiteId::ZERO,
                            };
                        }
                        _ => break,
                    }
                }
                _ => break,
            }
        }
        Ok(result)
    }

    /// Parses primary expressions (literals, cell refs, function calls, parentheses).
    /// Parses one atom, then applies Excel's trim-reference operator to it.
    ///
    /// The `.` in `A1:.B10` is documented by Microsoft as shorthand for
    /// `TRIMRANGE`, and that is exactly how it is represented here: the dotted
    /// range lowers to the function call, so `Expression::Range` grows no trim
    /// fields, nothing downstream of the parser learns a second spelling for
    /// the same idea, and the two features cannot drift apart because there is
    /// only one of them.
    ///
    /// The flags are saved and restored around the atom rather than merely
    /// cleared, so that a dotted range nested inside another atom -- an
    /// argument, a parenthesised sub-expression -- is trimmed itself and does
    /// not silently trim its parent as well.
    fn parse_primary(&mut self) -> ParseResult<Expression> {
        let outer = self.lexer.take_trim_flags();
        let expr = self.parse_primary_atom();
        let code = self.lexer.take_trim_flags();
        self.lexer.restore_trim_flags(outer);
        let expr = expr?;
        if code == 0 {
            return Ok(expr);
        }
        let axis = Expression::Literal(Value::Number(f64::from(code)));
        Ok(Expression::FunctionCall {
            func: BuiltinFunction::TrimRange,
            args: vec![expr, axis.clone(), axis],
            ref_site_id: RefSiteId::ZERO,
        })
    }

    fn parse_primary_atom(&mut self) -> ParseResult<Expression> {
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

            // A `"` with no closing `"`. Named here rather than left to the
            // catch-all so the user is told which character is missing instead
            // of "Unexpected token".
            Token::UnterminatedString => Err(ParseError::new(
                "Unterminated text: a closing '\"' is missing",
            )),

            // Boolean literal
            Token::Boolean(b) => {
                self.advance();
                Ok(Expression::Literal(Value::Boolean(b)))
            }

            // ERROR LITERAL: `=#REF!`, `={1,#N/A}`, `=IF(A1,#N/A,0)`.
            //
            // Excel accepts these anywhere a value is accepted, and Calcula could
            // not parse one at all — which mattered beyond the typing case: the
            // copy/fill shifters need to WRITE `#REF!` in place of a reference
            // that leaves the sheet (they clamped instead, silently re-pointing
            // the formula at surviving data), and text no parser accepts would
            // have turned the whole formula into a #VALUE! cell carrying no
            // dependency edges at all.
            Token::ErrorLiteral(lit) => {
                self.advance();
                Ok(Expression::Literal(Value::Error(lit)))
            }

            // Quoted identifier - sheet reference or 3D sheet range reference
            Token::QuotedIdentifier(name) => {
                self.advance();
                self.expect(Token::Exclamation)?;

                // EXTERNAL WORKBOOK: refuse before the 3-D split can misread it.
                //
                // MUST COME FIRST. `'C:\Reports\[Book.xlsx]Sheet1'!A1` contains a
                // colon -- the DRIVE LETTER's -- so the 3-D branch below split it
                // into start sheet "C" and end sheet "\Reports\[Book.xlsx]Sheet1"
                // and built a `Sheet3DRef` that then EVALUATED. A workbook link
                // Calcula cannot follow came back as a NUMBER computed from
                // whatever local sheets happened to sit in that name range: a
                // wrong answer wearing no error at all.
                if let Some(reason) = external_workbook_reason(&name) {
                    return Err(ParseError::new(format!(
                        "External workbook references are not supported: '{}' ({})",
                        name, reason
                    )));
                }

                // Check for 3D reference: if the quoted identifier contains ':'
                // it is a sheet range like 'Jan:Dec'!A1 or 'Jan 2023:Dec 2023'!A1
                if let Some(colon_pos) = name.find(':') {
                    let start_sheet = name[..colon_pos].to_string();
                    let end_sheet = name[colon_pos + 1..].to_string();
                    let inner = self.parse_reference_only()?;
                    return Ok(Expression::Sheet3DRef {
                        start_sheet,
                        end_sheet,
                        reference: Box::new(inner),
                        ref_site_id: RefSiteId::ZERO,
                    });
                }

                // Single sheet reference (existing behavior)
                self.parse_sheet_reference(name)
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
                    // Before returning NamedRef, check for 3D reference pattern:
                    // Sheet1:Sheet3!ref (unquoted sheet names that aren't valid cell refs)
                    if self.current_token == Token::Colon {
                        self.advance(); // consume ':'
                        if let Token::Identifier(end_name) = self.current_token.clone() {
                            self.advance(); // consume end sheet name
                            if self.current_token == Token::Exclamation {
                                self.advance(); // consume '!'
                                let inner = self.parse_reference_only()?;
                                return Ok(Expression::Sheet3DRef {
                                    start_sheet: name.to_uppercase(),
                                    end_sheet: end_name.to_uppercase(),
                                    reference: Box::new(inner),
                                    ref_site_id: RefSiteId::ZERO,
                                });
                            }
                            return Err(ParseError::new(format!(
                                "Expected '!' after sheet range '{}:{}'", name, end_name
                            )));
                        }
                        return Err(ParseError::new(format!(
                            "Unexpected ':' after '{}'", name
                        )));
                    }
                    return Ok(Expression::NamedRef { name, ref_site_id: RefSiteId::ZERO });
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
                            ref_site_id: RefSiteId::ZERO,
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
                    return Ok(Expression::NamedRef { name, ref_site_id: RefSiteId::ZERO });
                }

                // Otherwise it's a simple cell reference (letters + digits like A1, AA100)
                self.parse_cell_ref(None, name, false, false)
            }

            // @ operator: implicit intersection or standalone structured reference
            Token::At => {
                self.advance();
                // If followed by a bracket, it's a structured reference [@Column]
                if self.current_token == Token::LBracket {
                    return self.parse_table_reference(String::new());
                }
                // Otherwise it's the implicit intersection operator: @A1:A10
                let operand = self.parse_primary()?;
                return Ok(Expression::ImplicitIntersection {
                    operand: Box::new(operand),
                });
            }

            // Standalone structured reference: [Column] (implies current table)
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

            // Curly braces: Excel's ARRAY CONSTANT {1,2;3,4}, or Calcula's dict
            // literal {"a": 1, "b": 2}.
            //
            // WHICH ONE IS DECIDED BY A COLON after the first element, and the
            // two can never be confused: Excel's array constants hold literals
            // only, and `:` inside braces has no meaning there at all.
            //
            // Braces used to build a Python-style LIST — a contained value that
            // does not spill. Excel's meaning wins the syntax (a spreadsheet
            // that reads `={1;2;3}` as anything but a 3-row array is broken for
            // its users), and `COLLECT(…)` is the list's remaining spelling.
            Token::LBrace => {
                self.advance();

                // `={}` — REFUSED, the way Excel refuses it.
                //
                // It used to produce the empty LIST, a leftover from when `{}`
                // was Calcula's list spelling. Once `{…}` became Excel's ARRAY
                // CONSTANT that reading became a trap: `={}` looks like an
                // array to the person typing it, an empty rectangle has no
                // shape to spill, and every array-shaped consumer then had to
                // cope with a zero-length value that Excel can never hand it.
                // `COLLECT()` is the empty list's remaining spelling and says
                // what it means.
                if self.current_token == Token::RBrace {
                    return Err(ParseError::new(
                        "Empty array constant '{}' is not allowed; an array must have at least one value",
                    ));
                }

                // Parse first element
                let first = self.parse_expression()?;

                // If colon follows → dict mode
                if self.current_token == Token::Colon {
                    self.advance();
                    let first_value = self.parse_expression()?;
                    let mut entries = vec![(first, first_value)];

                    while self.current_token == Token::Comma {
                        self.advance();
                        // Allow trailing comma before }
                        if self.current_token == Token::RBrace {
                            break;
                        }
                        let key = self.parse_expression()?;
                        self.expect(Token::Colon)?;
                        let value = self.parse_expression()?;
                        entries.push((key, value));
                    }

                    self.expect(Token::RBrace)?;
                    Ok(Expression::DictLiteral { entries })
                } else {
                    // ARRAY CONSTANT. `,` separates COLUMNS within a row and
                    // `;` starts a new ROW — the invariant (en-US) spelling,
                    // which is the only one that reaches the parser.
                    let mut rows: Vec<Vec<Expression>> = Vec::new();
                    let mut row: Vec<Expression> = vec![first];

                    loop {
                        match self.current_token {
                            Token::Comma => {
                                self.advance();
                                // A trailing separator before `}` ends the
                                // constant rather than adding a blank cell —
                                // the same tolerance the list literal had.
                                if self.current_token == Token::RBrace {
                                    break;
                                }
                                row.push(self.parse_expression()?);
                            }
                            Token::Semicolon => {
                                self.advance();
                                if self.current_token == Token::RBrace {
                                    break;
                                }
                                rows.push(std::mem::take(&mut row));
                                row.push(self.parse_expression()?);
                            }
                            _ => break,
                        }
                    }
                    rows.push(row);

                    self.expect(Token::RBrace)?;

                    // RECTANGULARITY. Excel refuses a ragged constant at entry
                    // ("the formula you typed contains an error") rather than
                    // padding it, because a ragged array has no honest shape and
                    // every consumer downstream would have to invent one.
                    let width = rows[0].len();
                    if rows.iter().any(|r| r.len() != width) {
                        return Err(ParseError::new(
                            "An array constant must be rectangular: every row needs the same number of values",
                        ));
                    }

                    Ok(Expression::ArrayLiteral { rows })
                }
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
                                ref_site_id: RefSiteId::ZERO,
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
                                ref_site_id: RefSiteId::ZERO,
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

    /// Parses a reference after a sheet prefix (or 3D sheet range prefix) has been consumed.
    /// Returns CellRef, Range, ColumnRef, or RowRef with sheet=None.
    /// This is the same logic as parse_sheet_reference but always uses sheet=None,
    /// since the sheet context is provided by the caller (e.g., Sheet3DRef wrapper).
    fn parse_reference_only(&mut self) -> ParseResult<Expression> {
        match self.current_token.clone() {
            // $ - absolute reference
            Token::Dollar => {
                self.advance();
                self.parse_absolute_reference(None)
            }

            // Number - must be a row reference like 1:5
            Token::Number(n) => {
                self.advance();
                if self.current_token == Token::Colon {
                    self.parse_row_reference(None, n, false)
                } else {
                    Err(ParseError::new(
                        "Expected ':' after row number in reference",
                    ))
                }
            }

            // Identifier - cell ref, range, or column ref
            Token::Identifier(name) => {
                self.advance();

                if self.current_token == Token::Colon {
                    self.parse_range_or_column_ref(None, name, false)
                } else {
                    // Handle column-only identifier followed by $ (absolute row marker)
                    // e.g., D$2
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
                                    None, name, row, false, true,
                                );
                            }
                            return Ok(Expression::CellRef {
                                sheet: None,
                                col: name.to_uppercase(),
                                row,
                                col_absolute: false,
                                row_absolute: true,
                                ref_site_id: RefSiteId::ZERO,
                            });
                        }
                        return Err(ParseError::new(format!(
                            "Expected row number after $, found {:?}",
                            self.current_token
                        )));
                    }
                    self.parse_cell_ref(None, name, false, false)
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
            ref_site_id: RefSiteId::ZERO,
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
            // Check for 3D reference: Sheet1:Sheet2!ref
            // If the next token is '!', this is a 3D sheet range, not a column reference.
            if self.current_token == Token::Exclamation {
                self.advance(); // consume !
                let inner = self.parse_reference_only()?;
                return Ok(Expression::Sheet3DRef {
                    start_sheet: start_identifier.to_uppercase(),
                    end_sheet: end_identifier.to_uppercase(),
                    reference: Box::new(inner),
                    ref_site_id: RefSiteId::ZERO,
                });
            }

            // Column reference like A:B or $A:$B
            Ok(Expression::ColumnRef {
                sheet,
                start_col: start_identifier.to_uppercase(),
                end_col: end_identifier.to_uppercase(),
                start_absolute: start_col_absolute,
                end_absolute: end_col_absolute,
                ref_site_id: RefSiteId::ZERO,
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
                    ref_site_id: RefSiteId::ZERO,
                }),
                end: Box::new(Expression::CellRef {
                    sheet: None,
                    col: end_col,
                    row: end_row,
                    col_absolute: end_col_absolute,
                    row_absolute: end_row_absolute,
                    ref_site_id: RefSiteId::ZERO,
                }),
                ref_site_id: RefSiteId::ZERO,
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
                ref_site_id: RefSiteId::ZERO,
            }),
            end: Box::new(Expression::CellRef {
                sheet: None,
                col: end_col,
                row: end_row,
                col_absolute: end_col_absolute,
                row_absolute: end_row_absolute,
                ref_site_id: RefSiteId::ZERO,
            }),
            ref_site_id: RefSiteId::ZERO,
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
            ref_site_id: RefSiteId::ZERO,
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
            ref_site_id: RefSiteId::ZERO,
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
            return Ok(Expression::FunctionCall { func, args, ref_site_id: RefSiteId::ZERO });
        }

        // Parse first argument
        args.push(self.parse_argument()?);

        // Parse remaining arguments separated by commas
        while self.current_token == Token::Comma {
            self.advance();
            args.push(self.parse_argument()?);
        }

        // Expect closing ')'
        self.expect(Token::RParen)?;

        Ok(Expression::FunctionCall { func, args, ref_site_id: RefSiteId::ZERO })
    }

    /// ONE argument of a call, which in Excel is allowed to be NOTHING.
    ///
    /// `=IF(TRUE,,5)`, `=XLOOKUP(x,a,b,,2)` and `=VLOOKUP(x,t,2,)` are everyday
    /// spreadsheet text and were refused AT ENTRY -- so `update_cell` stored the
    /// user's formula as literal TEXT, the cell showed the formula back at them,
    /// and nothing said why.
    ///
    /// THE SLOT IS FILLED, NEVER SKIPPED. Returning early without pushing would
    /// change the ARITY: `=VLOOKUP(x,t,2,)` (empty 4th argument = exact match)
    /// would arrive at the evaluator as the three-argument `=VLOOKUP(x,t,2)`,
    /// which means APPROXIMATE match -- the same formula answering with a
    /// different row and no error to show for it.
    ///
    /// The caller has already dealt with the genuinely empty list `=SUM()`
    /// before the first call gets here, so a lone `Blank` argument is not a
    /// shape this grammar can produce (there is no text for it in Excel either).
    fn parse_argument(&mut self) -> ParseResult<Expression> {
        // An argument position that begins with the delimiter that ENDS an
        // argument is an omitted one -- `,` for a following slot, `)` for the
        // last. Nothing is consumed here; the caller's loop eats the delimiter.
        if matches!(self.current_token, Token::Comma | Token::RParen) {
            return Ok(Expression::Literal(Value::Blank));
        }
        self.parse_expression()
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
    ///   Table1[#This Row]        -> This-row, no column (ThisRow(""))
    ///   Table1[[#This Row],[Col]] -> This-row column: the LONG spelling of [@Col]
    ///   [@Column]                -> This-row (table inferred from context)
    ///   [Column]                 -> Column (table inferred from context)
    fn parse_table_reference(&mut self, table_name: String) -> ParseResult<Expression> {
        // THE BRACKET BODY IS SCANNED AS RAW TEXT, NOT AS TOKENS.
        //
        // `current_token` is the `[`, which means the LEXER's character stream
        // sits exactly one character past it -- the only moment at which the
        // body can still be read verbatim. One token later it is too late: the
        // lexer has already uppercased an identifier, split `Cost (USD)` at the
        // paren, and turned `Sales%` into a name plus an operator.
        if self.current_token != Token::LBracket {
            return Err(ParseError::new(format!(
                "Expected [ to start a structured reference, found {:?}",
                self.current_token
            )));
        }
        let body = self.lexer.scan_bracket_body().ok_or_else(|| {
            ParseError::new("Unterminated structured reference: a closing ']' is missing")
        })?;
        // The scan consumed the matching `]`, so this is the token AFTER it.
        self.advance();

        let specifier = parse_specifier_body(&body)?;

        Ok(Expression::TableRef {
            table_name,
            specifier,
            ref_site_id: RefSiteId::ZERO,
        })
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

/// Why a quoted `'...'!` prefix is an EXTERNAL WORKBOOK link rather than a
/// sheet (or a 3-D sheet range), or `None` when it is an ordinary sheet name.
///
/// A GUARD, NOT A FEATURE. Calcula has no external-link resolution and this
/// function deliberately builds none: it exists so the shapes that mean "another
/// file" are REFUSED with a sentence the user can act on, instead of being
/// mistaken for something local.
///
/// The discriminators are exactly the characters Excel FORBIDS in a worksheet
/// name -- `[ ] \ /` -- so no legitimate sheet can be caught by them. That
/// matters most for the colon: `'Jan:Dec'!A1` is a real 3-D range and must keep
/// working, while `'C:\Reports\[Q3.xlsx]Sheet1'!A1` was being split on the DRIVE
/// LETTER's colon into the sheet range `C` .. `\Reports\[Q3.xlsx]Sheet1` and
/// evaluated over whatever local sheets fell in it.
fn external_workbook_reason(name: &str) -> Option<&'static str> {
    if name.contains('[') || name.contains(']') {
        return Some("[workbook.xlsx] names another file");
    }
    if name.contains('\\') || name.contains('/') {
        return Some("it is a file path");
    }
    None
}

// ---------------------------------------------------------------------------
// STRUCTURED-REFERENCE BRACKET BODIES
//
// A BRACKET BODY IS DATA, NOT A TOKEN STREAM. The body used to be re-assembled
// from whatever the lexer happened to make of it, and that lost information no
// later stage could recover:
//
//   * `Sales[Profit-Loss]` came back as the column `PROFIT- LOSS` -- a SPACE
//     inserted into the middle of a name, because the joiner put one between
//     every pair of tokens and `-` arrived as its own token.
//   * `Sales[Sales%]`, `Sales[Cost (USD)]` and `Sales[A:B]` did not parse AT
//     ALL: `%`, `(` and `:` are operators to a lexer, so the reader stopped and
//     the caller's `expect(RBracket)` failed. A column name is the user's own
//     text, typed once in the header row; a spreadsheet that refuses to
//     reference the column it let them name is refusing its own data.
//   * every name was UPPERCASED, so the formula bar showed `Sales[AMOUNT]`
//     back to a user who typed `Sales[Amount]`. The lookup is
//     case-insensitive (`Table::get_column_index` lower-cases both sides), so
//     nothing was gained by it.
//
// This file's own history is the argument for opacity: Calcula's audit found a
// table column name shaped like a cell address being REWRITTEN by the
// reference shifters. Bracket contents are treated the way a string literal is
// -- scanned as characters, understood only where the grammar genuinely has
// structure.
//
// WHERE THE GRAMMAR IS STILL STRUCTURE, and it is exactly Excel's: a body that
// BEGINS with `[` is the nested form (`[[#Headers],[Amount]]`,
// `[[a]:[b]]`), one that begins with `#` is a special region, one that begins
// with `@` is this-row. Anything else is a column name, verbatim -- which is
// what makes `Sales[A:B]` the column literally named "A:B" rather than a
// range, exactly as in Excel, where a range must be written `Sales[[A]:[B]]`.
//
// Excel's escape is a leading `'` on the character it protects, which is how a
// name carries a `[`, `]`, `#`, `@` or `'` at all. The escapes survive the
// split and are removed only at the leaves, so an escaped delimiter can never
// be mistaken for a real one.
// ---------------------------------------------------------------------------

/// Reads one structured-reference bracket body into a `TableSpecifier`.
fn parse_specifier_body(body: &str) -> ParseResult<TableSpecifier> {
    // The OUTER whitespace is trimmed, the inner is not. `Sales[ Amount ]` has
    // always worked (the token joiner discarded whitespace outright) and must
    // keep working, while `Sales[Cost of Goods]` must keep every space it has.
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err(ParseError::new("Empty column name in table reference"));
    }

    match trimmed.chars().next().unwrap() {
        '[' => parse_nested_specifier(trimmed),
        '#' => parse_special_region(&trimmed[1..]),
        '@' => {
            let rest = trimmed[1..].trim_start();
            if rest.is_empty() {
                // `[@]` is not a spelling of anything. The EMPTY column name is
                // reserved for the bare `[#This Row]`, and it only works as a
                // marker while nothing else can forge it.
                return Err(ParseError::new("Empty column name after '@' in table reference"));
            }
            if rest.starts_with('[') {
                // `[@[Amount]]`, `[@[a]:[b]]` -- the bracketed this-row forms.
                return this_row_from_parts(rest);
            }
            Ok(TableSpecifier::ThisRow(column_name(rest)?))
        }
        // A COLUMN NAME, taken whole. No split on `:` here: that is what makes
        // `Sales[A:B]` the column named "A:B".
        _ => Ok(TableSpecifier::Column(column_name(trimmed)?)),
    }
}

/// The nested form: one or more `[...]` parts joined by a structural `,` or `:`.
fn parse_nested_specifier(body: &str) -> ParseResult<TableSpecifier> {
    let (parts, seps) = split_specifier_parts(body);
    let mut inners = Vec::with_capacity(parts.len());
    for p in &parts {
        inners.push(bracket_inner(p)?);
    }

    match (inners.len(), seps.first()) {
        // `[[Amount]]`, `[[#This Row]]`, `[[@Amount]]` -- one part, which means
        // the same thing it would mean without the extra brackets.
        (1, None) => parse_specifier_body(&inners[0]),

        // `[[a]:[b]]` is a column span; `[[@a]:[@b]]` is that span on THIS row.
        // The `@` is optional on either side -- Excel writes it on both, but
        // `[[@a]:[b]]` names the same cells, so one is enough to decide.
        (2, Some(':')) => {
            let this_row = inners[0].trim_start().starts_with('@')
                || inners[1].trim_start().starts_with('@');
            let a = strip_this_row_marker(&inners[0])?;
            let b = strip_this_row_marker(&inners[1])?;
            if this_row {
                Ok(TableSpecifier::ThisRowRange(a, b))
            } else {
                Ok(TableSpecifier::ColumnRange(a, b))
            }
        }

        // `[[#Headers],[Amount]]` -- a region and a column.
        (2, Some(',')) => {
            let special = parse_specifier_body(&inners[0])?;
            let col = column_name(inners[1].trim())?;
            // `[[#This Row],[Amount]]` IS `[@Amount]`: it names ONE cell, not a
            // region-plus-column pair. Wrapping it in `SpecialColumn` is what
            // once made the two spellings of one reference answer with
            // different numbers.
            if let TableSpecifier::ThisRow(_) = special {
                return Ok(TableSpecifier::ThisRow(col));
            }
            Ok(TableSpecifier::SpecialColumn(Box::new(special), col))
        }

        _ => Err(ParseError::new(format!(
            "Unsupported structured reference: [{}]",
            body
        ))),
    }
}

/// The `@`-prefixed bracketed forms: `@[Amount]` and `@[a]:[b]`.
fn this_row_from_parts(rest: &str) -> ParseResult<TableSpecifier> {
    let (parts, seps) = split_specifier_parts(rest);
    let mut inners = Vec::with_capacity(parts.len());
    for p in &parts {
        inners.push(bracket_inner(p)?);
    }
    match (inners.len(), seps.first()) {
        (1, None) => Ok(TableSpecifier::ThisRow(column_name(inners[0].trim())?)),
        (2, Some(':')) => Ok(TableSpecifier::ThisRowRange(
            strip_this_row_marker(&inners[0])?,
            strip_this_row_marker(&inners[1])?,
        )),
        _ => Err(ParseError::new(format!(
            "Unsupported this-row reference: [@{}]",
            rest
        ))),
    }
}

/// `#All`, `#Data`, `#Headers`, `#Totals`, `#This Row` -- keyword text, so this
/// one place is NOT opaque. Case- and space-insensitive, as Excel's are.
fn parse_special_region(rest: &str) -> ParseResult<TableSpecifier> {
    let key: String = rest
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_uppercase();
    match key.as_str() {
        "ALL" => Ok(TableSpecifier::AllRows),
        "DATA" => Ok(TableSpecifier::DataRows),
        "HEADERS" => Ok(TableSpecifier::Headers),
        "TOTALS" => Ok(TableSpecifier::Totals),
        // `#This Row` IS the this-row marker and carries NO column of its own.
        // The column, when there is one, follows the comma in
        // `[[#This Row],[Amount]]`. The empty name is what tells this apart
        // from `[#Data]`, which is the only thing the renderer could spell it
        // with before it had an arm of its own.
        "THIS ROW" => Ok(TableSpecifier::ThisRow(String::new())),
        "" => Err(ParseError::new("Expected specifier name after '#'")),
        _ => Err(ParseError::new(format!("Unknown table specifier: #{}", rest))),
    }
}

/// The text between one part's own `[` and `]`.
fn bracket_inner(part: &str) -> ParseResult<String> {
    let p = part.trim();
    if p.len() >= 2 && p.starts_with('[') && p.ends_with(']') {
        return Ok(p[1..p.len() - 1].to_string());
    }
    Err(ParseError::new(format!(
        "Expected a bracketed column name in a structured reference, found '{}'",
        p
    )))
}

/// One end of a span, with its optional `@` this-row marker removed.
///
/// The marker is tested on the ESCAPED text and stripped before unescaping, so
/// a column genuinely named `@Total` -- written `['@Total]` -- keeps its `@`.
fn strip_this_row_marker(inner: &str) -> ParseResult<String> {
    let t = inner.trim();
    let name = t.strip_prefix('@').unwrap_or(t);
    column_name(name.trim())
}

/// A leaf column name: escapes removed, and never empty.
fn column_name(raw: &str) -> ParseResult<String> {
    let name = unescape_bracket_text(raw);
    if name.is_empty() {
        return Err(ParseError::new("Empty column name in table reference"));
    }
    Ok(name)
}

/// Splits a bracket body on the `,` and `:` that are STRUCTURE -- at bracket
/// depth 0 and not escaped. Returns the parts and the separators between them.
fn split_specifier_parts(body: &str) -> (Vec<String>, Vec<char>) {
    let mut parts = Vec::new();
    let mut seps = Vec::new();
    let mut current = String::new();
    let mut depth = 0usize;
    let mut chars = body.chars();
    while let Some(ch) = chars.next() {
        match ch {
            '\'' => {
                current.push(ch);
                if let Some(esc) = chars.next() {
                    current.push(esc);
                }
            }
            '[' => {
                depth += 1;
                current.push(ch);
            }
            ']' => {
                depth = depth.saturating_sub(1);
                current.push(ch);
            }
            ',' | ':' if depth == 0 => {
                seps.push(ch);
                parts.push(std::mem::take(&mut current));
            }
            _ => current.push(ch),
        }
    }
    parts.push(current);
    (parts, seps)
}

/// Removes Excel's `'` escapes. A trailing lone `'` is kept as itself rather
/// than dropped, so no name can be unescaped into nothing.
fn unescape_bracket_text(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(ch) = chars.next() {
        if ch == '\'' {
            match chars.next() {
                Some(next) => out.push(next),
                None => out.push('\''),
            }
        } else {
            out.push(ch);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Tests
//
// The crate's suite lives in `tests.rs`; these sit next to the grammar they
// pin because they are about ONE production -- the structured-reference
// bracket grammar -- and each names the property it holds.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// The specifier of a formula that is nothing but a table reference.
    fn specifier_of(formula: &str) -> TableSpecifier {
        match parse(formula).unwrap_or_else(|e| panic!("{} does not parse: {}", formula, e)) {
            Expression::TableRef { specifier, .. } => specifier,
            other => panic!("{} is not a table reference: {:?}", formula, other),
        }
    }

    /// `[[#This Row],[Col]]` AND `[@Col]` ARE ONE REFERENCE, SO ONE SPECIFIER.
    ///
    /// The long spelling produced `SpecialColumn(DataRows, "AMOUNT")`, which the
    /// resolver expands to the whole data COLUMN. So `=Table1[[#This Row],[Amount]]`
    /// and `=Table1[@Amount]` -- the same reference typed two ways -- answered
    /// with different numbers, and neither reported anything: the wrong one is a
    /// perfectly valid range over every data row.
    #[test]
    fn long_this_row_spelling_is_the_same_specifier_as_the_at_sign() {
        assert_eq!(
            specifier_of("=Table1[[#This Row],[Amount]]"),
            specifier_of("=Table1[@Amount]"),
            "the two spellings of one reference disagree"
        );
        // Named outright, so the test still fails if BOTH spellings drift.
        assert_eq!(
            specifier_of("=Table1[[#This Row],[Amount]]"),
            TableSpecifier::ThisRow("Amount".to_string())
        );
    }

    /// The bare `[#This Row]` is the formula's row, not the whole data body.
    ///
    /// It was aliased to `DataRows` -- indistinguishable, from that point on,
    /// from the user having typed `[#Data]`. That is what the renderer then
    /// wrote back into the formula bar and into every save.
    #[test]
    fn bare_this_row_is_not_the_data_body() {
        assert_eq!(
            specifier_of("=Table1[#This Row]"),
            TableSpecifier::ThisRow(String::new())
        );
        assert_ne!(specifier_of("=Table1[#This Row]"), TableSpecifier::DataRows);
    }

    /// `Table1[[#This Row]]` -- the same marker inside the nested-bracket form,
    /// which is a different code path from the bare one.
    #[test]
    fn nested_bare_this_row_is_this_row_too() {
        assert_eq!(
            specifier_of("=Table1[[#This Row]]"),
            TableSpecifier::ThisRow(String::new())
        );
    }

    /// Specifier keywords are case-insensitive, as Excel's are.
    #[test]
    fn this_row_ignores_case() {
        assert_eq!(
            specifier_of("=Table1[[#THIS ROW],[Amount]]"),
            TableSpecifier::ThisRow("Amount".to_string())
        );
        assert_eq!(
            specifier_of("=Table1[#this row]"),
            TableSpecifier::ThisRow(String::new())
        );
    }

    /// The this-row arm must not swallow the OTHER special-plus-column pairs:
    /// those stay `SpecialColumn`, which is a region, not a single cell.
    #[test]
    fn other_special_column_pairs_are_untouched() {
        for (formula, special) in [
            ("=Table1[[#Data],[Amount]]", TableSpecifier::DataRows),
            ("=Table1[[#Headers],[Amount]]", TableSpecifier::Headers),
            ("=Table1[[#Totals],[Amount]]", TableSpecifier::Totals),
            ("=Table1[[#All],[Amount]]", TableSpecifier::AllRows),
        ] {
            assert_eq!(
                specifier_of(formula),
                TableSpecifier::SpecialColumn(Box::new(special), "Amount".to_string()),
                "{} changed shape",
                formula
            );
        }
    }

    /// NOTHING BUT `#This Row` MAY PRODUCE AN EMPTY COLUMN NAME.
    ///
    /// The empty name is the marker that separates the bare `[#This Row]` from
    /// every other this-row reference, in the AST and in the renderer. It only
    /// works while it is unforgeable, so the two spellings that could otherwise
    /// reach it have to stay parse errors.
    #[test]
    fn an_empty_column_name_has_no_other_spelling() {
        assert!(parse("=Table1[@]").is_err(), "[@] must not parse");
        assert!(parse("=Table1[]").is_err(), "[] must not parse");
    }

    /// A COLUMN NAME IS THE USER'S OWN TEXT, and comes back exactly as typed.
    ///
    /// The body used to be re-assembled from tokens, which lost information no
    /// later stage could recover. Each row below is a real failure mode of
    /// that: `Profit-Loss` gained a SPACE in the middle (the joiner put one
    /// between every pair of tokens), and `Sales%`, `Cost (USD)` and `A:B` did
    /// not parse AT ALL, because `%`, `(` and `:` are operators to a lexer. A
    /// spreadsheet that refuses to reference the column it let the user name is
    /// refusing its own data.
    ///
    /// `A:B` is the sharpest of them: opacity is what makes it the column
    /// literally named "A:B" rather than a range, which is exactly Excel's
    /// rule -- a column span must be written `Sales[[A]:[B]]`.
    #[test]
    fn a_column_name_is_taken_verbatim() {
        for name in [
            "Sales%",
            "Cost (USD)",
            "Profit-Loss",
            "A:B",
            "Q1 Sales",
            "Amount $",
            "Cost/Unit",
            "Rate*2",
            "Sales+Tax",
            "A1",
            "50%",
            "Delta<Target",
        ] {
            assert_eq!(
                specifier_of(&format!("=Table1[{}]", name)),
                TableSpecifier::Column(name.to_string()),
                "the column name `{}` did not survive",
                name
            );
        }
    }

    /// THE CASE THE USER TYPED SURVIVES.
    ///
    /// Every name used to arrive uppercased, because the LEXER uppercases bare
    /// identifiers -- so the formula bar showed `Sales[AMOUNT]` back to someone
    /// who typed `Sales[Amount]`. Nothing was gained by it: the lookup
    /// (`Table::get_column_index`) lower-cases both sides, so it was never
    /// case-sensitive in the first place.
    #[test]
    fn a_column_name_keeps_its_case() {
        assert_eq!(
            specifier_of("=Table1[Amount]"),
            TableSpecifier::Column("Amount".to_string())
        );
        assert_ne!(
            specifier_of("=Table1[Amount]"),
            TableSpecifier::Column("AMOUNT".to_string())
        );
        // The this-row and range forms read their names through the same leaf,
        // so all three must agree or the renderer would re-spell some of them.
        assert_eq!(
            specifier_of("=Table1[@Amount]"),
            TableSpecifier::ThisRow("Amount".to_string())
        );
        assert_eq!(
            specifier_of("=Table1[[Amount]:[Tax]]"),
            TableSpecifier::ColumnRange("Amount".to_string(), "Tax".to_string())
        );
    }

    /// The SPECIFIER KEYWORDS are the one part of a bracket body that is NOT
    /// opaque, and they stay case-insensitive as Excel's are. This is the
    /// counterweight to the test above: names keep their case, keywords do not
    /// have one.
    #[test]
    fn specifier_keywords_are_still_case_insensitive() {
        assert_eq!(specifier_of("=Table1[#all]"), TableSpecifier::AllRows);
        assert_eq!(specifier_of("=Table1[#DATA]"), TableSpecifier::DataRows);
        assert_eq!(specifier_of("=Table1[#Headers]"), TableSpecifier::Headers);
        assert_eq!(specifier_of("=Table1[#totals]"), TableSpecifier::Totals);
        // ...and an UNKNOWN one is still an error, so the match is not a
        // catch-all that would swallow `[#Datta]`.
        assert!(parse("=Table1[#Datta]").is_err(), "an unknown region must be refused");
    }

    /// EXCEL'S `'` ESCAPE lets a column name carry the very characters that
    /// select the structural forms.
    ///
    /// The escape has to be honoured while the body is still being SCANNED, not
    /// merely when the name is read: in `[Cost '[USD']]` it decides where the
    /// reference ENDS, and an escaped `]` that closed the bracket would leave
    /// the rest of the formula to be parsed as something else entirely.
    #[test]
    fn the_apostrophe_escape_protects_a_name() {
        assert_eq!(
            specifier_of("=Table1[Cost '[USD']]"),
            TableSpecifier::Column("Cost [USD]".to_string())
        );
        // A leading `#` or `@` would otherwise SELECT a form rather than name a
        // column, which is the whole reason Excel gives them an escape.
        assert_eq!(
            specifier_of("=Table1['#Rank]"),
            TableSpecifier::Column("#Rank".to_string())
        );
        assert_eq!(
            specifier_of("=Table1['@Owner]"),
            TableSpecifier::Column("@Owner".to_string())
        );
        // CONTROLS: unescaped, those same two characters still select their
        // forms. Without this pair the test would pass on a parser that had
        // simply stopped treating `#` and `@` as special.
        assert_eq!(specifier_of("=Table1[#Data]"), TableSpecifier::DataRows);
        assert_eq!(
            specifier_of("=Table1[@Rank]"),
            TableSpecifier::ThisRow("Rank".to_string())
        );
    }

    /// The structural forms are decided by the FIRST character of the body,
    /// exactly as in Excel, and each still produces what it always did.
    #[test]
    fn the_structural_forms_are_unchanged() {
        assert_eq!(
            specifier_of("=Table1[[#Headers],[Amount]]"),
            TableSpecifier::SpecialColumn(Box::new(TableSpecifier::Headers), "Amount".to_string())
        );
        assert_eq!(
            specifier_of("=Table1[[Amount]:[Tax]]"),
            TableSpecifier::ColumnRange("Amount".to_string(), "Tax".to_string())
        );
        assert_eq!(
            specifier_of("=Table1[[@Amount]:[@Tax]]"),
            TableSpecifier::ThisRowRange("Amount".to_string(), "Tax".to_string())
        );
        // The trailing `@` is optional -- Excel writes it on both ends, but one
        // is enough to say the span is on this row.
        assert_eq!(
            specifier_of("=Table1[[@Amount]:[Tax]]"),
            TableSpecifier::ThisRowRange("Amount".to_string(), "Tax".to_string())
        );
        assert_eq!(
            specifier_of("=Table1[@[Amount]]"),
            TableSpecifier::ThisRow("Amount".to_string())
        );
    }

    /// THE OUTER WHITESPACE IS TRIMMED AND THE INNER IS NOT.
    ///
    /// `Table1[ Amount ]` has always worked (the token joiner discarded
    /// whitespace outright) and must keep working now that the body is read as
    /// characters; a name with spaces INSIDE it keeps every one of them.
    #[test]
    fn outer_whitespace_is_trimmed_inner_whitespace_is_kept() {
        assert_eq!(
            specifier_of("=Table1[ Amount ]"),
            TableSpecifier::Column("Amount".to_string())
        );
        assert_eq!(
            specifier_of("=Table1[Cost of Goods]"),
            TableSpecifier::Column("Cost of Goods".to_string())
        );
        assert_eq!(
            specifier_of("=Table1[[#Headers], [Amount]]"),
            TableSpecifier::SpecialColumn(Box::new(TableSpecifier::Headers), "Amount".to_string())
        );
    }

    /// A bracket body that never closes is a REFUSAL. The raw scan runs to end
    /// of input, so this is the one new way it can fail, and it must say which
    /// character is missing rather than reporting some later token.
    #[test]
    fn an_unterminated_bracket_body_is_refused() {
        assert!(parse("=Table1[Amount").is_err());
        assert!(parse("=Table1[[#Headers],[Amount]").is_err());
        // An escaped `]` does not close the body -- that is what the escape is
        // FOR, and it is why an unterminated name can run to the end at all.
        assert!(parse("=Table1[Cost ']").is_err());
    }

    /// The reference must END at its own bracket, so the rest of the formula is
    /// still parsed. A raw scan that ran past the matching `]` would swallow
    /// arguments, operators, or the whole remainder of the formula in silence.
    #[test]
    fn the_scan_stops_at_the_matching_bracket() {
        match parse("=SUM(Table1[Amount],1)").expect("parses") {
            Expression::FunctionCall { args, .. } => {
                assert_eq!(args.len(), 2, "the scan ate the second argument");
                assert!(matches!(args[0], Expression::TableRef { .. }));
                assert_eq!(args[1], Expression::Literal(Value::Number(1.0)));
            }
            other => panic!("{other:?}"),
        }
        match parse("=Table1[Amount]+1").expect("parses") {
            Expression::BinaryOp { op, .. } => assert_eq!(op, BinaryOperator::Add),
            other => panic!("the `+1` was swallowed: {other:?}"),
        }
        // The NESTED form's inner brackets must not be mistaken for the end.
        assert!(parse("=SUM(Table1[[#Headers],[Amount]],1)").is_ok());
    }
}