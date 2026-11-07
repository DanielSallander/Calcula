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
//!   cell_or_range  --> cell_ref (":" (cell_ref | sheet_prefix cell_ref | NAME))?
//!                    | NAME ":" cell_ref          (the range operator with a
//!                                                  LET / LAMBDA name half)
//!                    | table_ref ":" reference    (Table1[a]:Table1[c])
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

        let mut expr = self.parse_expression()?;

        // Ensure we consumed all tokens
        if self.current_token != Token::EOF {
            return Err(ParseError::new(format!(
                "Unexpected token after expression: {:?}",
                self.current_token
            )));
        }

        respell_bound_names(&mut expr);
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
                // An ERROR LITERAL, which a deleted sheet's reference begins
                // with: Excel [LIVE] shows `=#REF!A1:A2 #REF!A1:B1` for an
                // intersection whose sheet was deleted, and accepts `=#REF! A1`.
                // Only ever reached after a complete operand, where an error
                // literal was a parse error before.
                | Token::ErrorLiteral(_)
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
        let operand = self.parse_index_access_chain(operand)?;
        self.parse_range_operator_chain(operand)
    }

    /// Excel's RANGE OPERATOR after an operand that did not take the `:`
    /// itself (BUG-0737): a function-call half (`INDEX(A1:A5,2):A4`, 9), a
    /// range continued (`A1:A3:A4`, 10), a parenthesised cell (`(A1):A3`).
    /// [LIVE, Excel 16, lane formula p1.json / p2.json.] Each was a parse
    /// error, so the typed formula was kept as text. Which functions may be a
    /// half is an ENTRY rule (`refuse_value_range_halves`); the evaluator spans
    /// the references the halves are (`Evaluator::eval_reference_span`).
    fn parse_range_operator_chain(&mut self, mut left: Expression) -> ParseResult<Expression> {
        while self.current_token == Token::Colon
            && matches!(
                left,
                Expression::FunctionCall { .. }
                    | Expression::Range { .. }
                    | Expression::CellRef { .. }
                    | Expression::ImplicitIntersection { .. }
            )
        {
            self.advance(); // ':'
            let right = self.parse_primary()?;
            let right = self.parse_index_access_chain(right)?;
            left = Expression::Range {
                sheet: None,
                start: Box::new(left),
                end: Box::new(right),
                ref_site_id: RefSiteId::ZERO,
            };
        }
        Ok(left)
    }

    /// The END half of `start:` when it is no plain cell (BUG-0737): a
    /// function call (`A1:INDEX(A1:A5,3)` 6, `A1:OFFSET(A1,2,0)` 6,
    /// `A1:LAMBDA(x,x)(A3)` 6), a parenthesised expression (`A1:(A3)` 6) or
    /// an implicit intersection (`A1:@A3` 6) [LIVE, Excel 16, lane formula
    /// p1.json / p2.json]; `None` when the current token begins none of these
    /// (the caller reads a cell). `name` is the identifier already consumed,
    /// when the end began with one.
    fn parse_range_operand_half(&mut self, name: Option<&str>) -> ParseResult<Option<Expression>> {
        let half = match (name, &self.current_token) {
            // A CALL: the `(` right after the name, and a name that is a
            // function -- `A1:A3 (A2:C2)` is the range A1:A3 intersected with
            // A2:C2, never a call of `A3`.
            (Some(name), Token::LParen)
                if !self.lexer.last_token_had_leading_whitespace()
                    && !(is_cell_spelling(name) && matches!(BuiltinFunction::from_name(name), BuiltinFunction::Custom(_))) =>
            {
                self.parse_function_call(name.to_string())?
            }
            (None, Token::LParen) | (None, Token::At) => self.parse_primary()?,
            _ => return Ok(None),
        };
        Ok(Some(self.parse_index_access_chain(half)?))
    }

    /// The START half of a range whose end is no plain cell: the cell the
    /// identifier spells, or -- letters alone, which are no cell -- a name.
    fn range_start_half(&self, identifier: &str, col_absolute: bool, sheet: &Option<String>) -> ParseResult<Expression> {
        if identifier.chars().all(|c| c.is_ascii_alphabetic()) && sheet.is_none() && !col_absolute {
            return Ok(Expression::NamedRef { name: identifier.to_string(), ref_site_id: RefSiteId::ZERO });
        }
        let (col, row) = self.split_cell_reference(identifier)?;
        Ok(Expression::CellRef { sheet: None, col, row, col_absolute, row_absolute: false, ref_site_id: RefSiteId::ZERO })
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
                        // `a#` -- a LET / LAMBDA name (or a defined name) bound to
                        // a spill anchor (BUG-0646) [LIVE, Excel 16:
                        // `=LET(a,E5,SUM(a#))` 6 with E5 = SEQUENCE(3), and
                        // `=LET(a,SEQUENCE(3),SUM(a#))` #VALUE!].
                        Expression::CellRef { .. } | Expression::NamedRef { .. } => {
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
                // `#REF!A1`: a reference whose SHEET was deleted (Excel keeps the
                // cell part and writes `#REF!` where the sheet was; see
                // `ast::REF_ERROR_SHEET`). Only with NOTHING between the two --
                // `#REF! A1` is Excel's intersection of the error and A1 -- and
                // only before something a sheet reference can start with. No
                // formula that parsed before means anything else now: an error
                // literal directly followed by a reference was a parse error.
                if lit == "#REF!"
                    && !self.lexer.last_token_had_leading_whitespace()
                    && matches!(self.current_token, Token::Identifier(_) | Token::Dollar | Token::Number(_))
                {
                    return self.parse_sheet_reference(crate::ast::REF_ERROR_SHEET.to_string());
                }
                Ok(Expression::Literal(Value::Error(lit)))
            }

            // Quoted identifier - sheet reference or 3D sheet range reference
            Token::QuotedIdentifier(name) => {
                self.advance();
                // A NAME SPELLED LIKE A CELL, quoted the way Excel's formula bar
                // shows one (`='D1'+LET(A1,5,A1)`, `=SUM('D1':'D2',..)`) and
                // the renderer writes it (`engine::ast_render`): the name, and a
                // range of two of them. [LIVE, Excel 16, rev-parse probe B.]
                if self.current_token != Token::Exclamation && is_cell_spelling(&name) {
                    let start = Expression::NamedRef { name, ref_site_id: RefSiteId::ZERO };
                    if self.current_token != Token::Colon {
                        return Ok(start);
                    }
                    self.advance(); // ':'
                    // The other half: a quoted name, or a bare one in scope
                    // (`'D1':X1` under `LET(X1,..)`), which the R1C1 fallback
                    // reads as the name it is.
                    let end = match self.current_token.clone() {
                        Token::QuotedIdentifier(end_name) if is_cell_spelling(&end_name) => {
                            Expression::NamedRef { name: end_name, ref_site_id: RefSiteId::ZERO }
                        }
                        Token::Identifier(end_name) if is_cell_spelling(&end_name) => {
                            let (col, row) = self.split_cell_reference(&end_name)?;
                            Expression::CellRef {
                                sheet: None,
                                col,
                                row,
                                col_absolute: false,
                                row_absolute: false,
                                ref_site_id: RefSiteId::ZERO,
                            }
                        }
                        other => {
                            return Err(ParseError::new(format!("Unexpected {:?} after ':' and a quoted name", other)));
                        }
                    };
                    self.advance();
                    return Ok(Expression::Range {
                        sheet: None,
                        start: Box::new(start),
                        end: Box::new(end),
                        ref_site_id: RefSiteId::ZERO,
                    });
                }
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
                // The TYPED spelling, read before `advance` lexes the next
                // token: a bare name keeps it until `respell_bound_names`
                // decides (a LET / LAMBDA name keeps it, any other name is
                // folded back to the lexer's spelling).
                let spelling = self.lexer.last_identifier_spelling().to_string();
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
                    let table = self.parse_table_reference(name)?;
                    // `Table1[Col]:Table1[Col]` -- the range operator between two
                    // structured references (BUG-0646) [LIVE, Excel 16:
                    // `=SUM(Table1[Col]:Table1[Col])` 20, `Table4[p]:Table4[q]`
                    // 110]. The host resolves each half to its range and the
                    // evaluator spans the two.
                    if self.current_token == Token::Colon {
                        self.advance();
                        let end = self.parse_range_operand_end()?;
                        return Ok(Expression::Range {
                            sheet: None,
                            start: Box::new(table),
                            end: Box::new(end),
                            ref_site_id: RefSiteId::ZERO,
                        });
                    }
                    return Ok(table);
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
                                // Both names are lexer output, already folded
                                // one character for one (never `to_uppercase`,
                                // which expands `ß` to `SS`); folding again
                                // is the identity and keeps that invariant
                                // local.
                                return Ok(Expression::Sheet3DRef {
                                    start_sheet: identity::sheet_name_key(&name),
                                    end_sheet: identity::sheet_name_key(&end_name),
                                    reference: Box::new(inner),
                                    ref_site_id: RefSiteId::ZERO,
                                });
                            }
                            // No `!`: the range operator between a NAME and the
                            // reference after it (lane legacystats). [LIVE, Excel
                            // 16] `=SUM(R1C4:R2C4)` is `SUM($D$1:$D$2)` = 30 --
                            // two R1C1 names, which `resolve_r1c1_names` turns
                            // into the cells they are at entry -- and
                            // `=LET(A1,5,SUM(R1C4:D2))` #NAME? (a name half no
                            // binder names). This used to be a parse error, so
                            // the typed formula was kept as text.
                            let end = if Self::is_valid_cell_ref_identifier(&end_name)
                                && end_name.chars().any(|c| c.is_ascii_digit())
                            {
                                let (col, row) = self.split_cell_reference(&end_name)?;
                                Expression::CellRef {
                                    sheet: None,
                                    col,
                                    row,
                                    col_absolute: false,
                                    row_absolute: false,
                                    ref_site_id: RefSiteId::ZERO,
                                }
                            } else {
                                Expression::NamedRef { name: end_name, ref_site_id: RefSiteId::ZERO }
                            };
                            return Ok(Expression::Range {
                                sheet: None,
                                start: Box::new(Expression::NamedRef { name, ref_site_id: RefSiteId::ZERO }),
                                end: Box::new(end),
                                ref_site_id: RefSiteId::ZERO,
                            });
                        }
                        return Err(ParseError::new(format!(
                            "Unexpected ':' after '{}'", name
                        )));
                    }
                    return Ok(Expression::NamedRef { name: typed_name_spelling(&name, spelling), ref_site_id: RefSiteId::ZERO });
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
                    return Ok(Expression::NamedRef { name: typed_name_spelling(&name, spelling), ref_site_id: RefSiteId::ZERO });
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

            // `Sheet2!'A1'` -- the SHEET's name spelled like a cell, quoted as
            // Excel's formula bar shows it (BUG-0739 [LIVE, lane formula
            // p1.json: `=LET(A1,2,Sheet2!A1)` shows `=LET(A1,2,Sheet2!'A1')`,
            // #NAME?]): the range of that name with itself, the shape
            // `apply_r1c1_fallback` gives the bare spelling.
            Token::QuotedIdentifier(name) if is_cell_spelling(&name) => {
                self.advance();
                let half = Expression::NamedRef { name, ref_site_id: RefSiteId::ZERO };
                Ok(Expression::Range {
                    sheet: Some(sheet_name),
                    start: Box::new(half.clone()),
                    end: Box::new(half),
                    ref_site_id: RefSiteId::ZERO,
                })
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

                // `Sheet1!C$3` / `Sheet1!R$3` are the A1 column C or R with an
                // absolute row, never R1C1's `C` / `R` (W2 names lane:
                // 'Unexpected token after expression: Dollar') [LIVE, Excel 16,
                // lane formfix p1.json: `=Sheet1!C$3` 300, `=Sheet1!R$3` 0].
                if self.current_token != Token::Dollar
                    && is_qualified_r1c1_spelling(&name, self.current_token == Token::Colon)
                {
                    return self.parse_qualified_r1c1(Some(sheet_name), name);
                }
                if self.current_token == Token::Colon {
                    self.parse_range_or_column_ref(Some(sheet_name), name, false)
                } else if self.current_token != Token::Dollar && is_qualified_name_spelling(&name) {
                    // `Sheet1!Rate` -- the NAME `Rate` as Sheet1 sees it
                    // (BUG-0744/0749): held as the range of the name with
                    // itself behind the sheet, the shape `Sheet2!'A1'` takes,
                    // and resolved by the host in that sheet's scope.
                    Ok(qualified_name(sheet_name, name))
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

            // `Sheet1:Sheet2!'A1'` -- a cell-shaped NAME behind the span,
            // quoted as Excel shows it (BUG-0739 [LIVE, lane formula p1.json:
            // `=LET(A1,2,SUM(Sheet1:Sheet2!A1))` shows `..Sheet2!'A1'))`]).
            Token::QuotedIdentifier(name) if is_cell_spelling(&name) => {
                self.advance();
                Ok(Expression::NamedRef { name, ref_site_id: RefSiteId::ZERO })
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

                if self.current_token != Token::Dollar
                    && is_qualified_r1c1_spelling(&name, self.current_token == Token::Colon)
                {
                    return self.parse_qualified_r1c1(None, name);
                }
                // `Sheet1:Sheet2!Rate`: a NAME behind a 3-D span, which Excel
                // takes and answers #NAME? [LIVE, lane formfix p1.json J290].
                if self.current_token != Token::Colon
                    && self.current_token != Token::Dollar
                    && is_qualified_name_spelling(&name)
                {
                    return Ok(Expression::NamedRef { name, ref_site_id: RefSiteId::ZERO });
                }
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

    /// An R1C1 reference AFTER A SHEET QUALIFIER (`Sheet2!RC`, `Sheet2!R1C1`,
    /// `Sheet2!R[-1]C[-9]`, `Sheet2!C`, `Sheet2!R1C1:R2C1`, and the inner
    /// reference of `Sheet1:Sheet2!RC`), held as a range of R1C1 NAMES --
    /// the one name with itself for a single reference -- which
    /// [`resolve_r1c1_names`] turns into the reference at entry, as it does
    /// the unqualified `RC` (lane formd, NEW-r1c1-sheet-qualified).
    ///
    /// [LIVE, Excel 16, lane formd, SCRATCH/formd/p1.json, p2.json, typed
    /// into column J] `=Sheet2!RC` in J1858 is `=Sheet2!J1858`, `=Sheet2!R1C1`
    /// `=Sheet2!$A$1`, `=Sheet2!R[-1]C[-9]` in J1874 `=Sheet2!A1873`,
    /// `=Sheet2!R2C` `=Sheet2!J$2`, `=SUM(Sheet2!C[-9])` `=SUM(Sheet2!A:A)`,
    /// `=SUM(Sheet2!R)` in J1938 `=SUM(Sheet2!1938:1938)`,
    /// `=SUM(Sheet2!R1C1:R2C1)` `=SUM(Sheet2!$A$1:$A$2)`, `='Sheet2'!RC`,
    /// `=Sheet2!rc` alike, and `=SUM(Sheet1:Sheet2!RC)` in J2018
    /// `=SUM(Sheet1:Sheet2!J2018)`. Calcula refused every one as a parse
    /// error, so the typed formula was kept as text. (`=SUM(Sheet2!RC:Sheet2!RC)`,
    /// which Excel shows `SUM(Sheet2!J906:Sheet2!J906)`, is the same one cell
    /// here and is shown `SUM(Sheet2!J906)`.)
    fn parse_qualified_r1c1(&mut self, sheet: Option<String>, name: String) -> ParseResult<Expression> {
        let start = Expression::NamedRef { name: name.clone(), ref_site_id: RefSiteId::ZERO };
        if self.current_token != Token::Colon {
            return Ok(Expression::Range {
                sheet,
                start: Box::new(start.clone()),
                end: Box::new(start),
                ref_site_id: RefSiteId::ZERO,
            });
        }
        self.advance(); // ':'
        let mut end_name = match self.current_token.clone() {
            Token::Identifier(end_name) => end_name,
            other => {
                return Err(ParseError::new(format!("Expected a reference after '{}:', found {:?}", name, other)));
            }
        };
        self.advance();
        // `Sheet2!RC:Sheet2!RC`: the second half repeats the qualifier.
        let mut end_sheet: Option<String> = None;
        if self.current_token == Token::Exclamation {
            self.advance();
            end_sheet = Some(end_name);
            end_name = match self.current_token.clone() {
                Token::Identifier(n) => n,
                other => return Err(ParseError::new(format!("Expected a reference after '!', found {:?}", other))),
            };
            self.advance();
        }
        let end = if is_cell_spelling(&end_name) {
            let (col, row) = self.split_cell_reference(&end_name)?;
            Expression::CellRef { sheet: end_sheet, col, row, col_absolute: false, row_absolute: false, ref_site_id: RefSiteId::ZERO }
        } else {
            Expression::NamedRef { name: end_name, ref_site_id: RefSiteId::ZERO }
        };
        Ok(Expression::Range { sheet, start: Box::new(start), end: Box::new(end), ref_site_id: RefSiteId::ZERO })
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

    /// The second half of `Sheet1!A1:Sheet1!A3` after its `!`: ONE cell, which
    /// keeps its own qualifier so the formula bar shows both, as Excel's does.
    /// The range's own sheet decides where it reads; the evaluator answers
    /// `#VALUE!` when the two name different sheets.
    fn parse_qualified_range_end(&mut self, end_sheet: String) -> ParseResult<Expression> {
        match self.parse_reference_only()? {
            Expression::CellRef { sheet: None, col, row, col_absolute, row_absolute, ref_site_id } => {
                Ok(Expression::CellRef { sheet: Some(end_sheet), col, row, col_absolute, row_absolute, ref_site_id })
            }
            other => Err(ParseError::new(format!(
                "Expected a cell after '{}!' in a range, found {:?}",
                end_sheet, other
            ))),
        }
    }

    /// `Range { sheet, start, end }` from a start cell's parts and a built end.
    fn cell_range(
        sheet: Option<String>,
        (col, row, col_absolute, row_absolute): (String, u32, bool, bool),
        end: Expression,
    ) -> Expression {
        Expression::Range {
            sheet,
            start: Box::new(Expression::CellRef {
                sheet: None,
                col,
                row,
                col_absolute,
                row_absolute,
                ref_site_id: RefSiteId::ZERO,
            }),
            end: Box::new(end),
            ref_site_id: RefSiteId::ZERO,
        }
    }

    /// One reference after the `:` that follows a structured reference
    /// (`Table1[Col]:Table1[Col]`): another structured reference, a sheet-
    /// qualified reference, a cell, or a name.
    fn parse_range_operand_end(&mut self) -> ParseResult<Expression> {
        match self.current_token.clone() {
            Token::Identifier(name) => {
                self.advance();
                if self.current_token == Token::LBracket {
                    return self.parse_table_reference(name);
                }
                if self.current_token == Token::Exclamation {
                    self.advance();
                    return self.parse_sheet_reference(name);
                }
                let col_only = name.chars().all(|c| c.is_ascii_alphabetic());
                if !col_only && Self::is_valid_cell_ref_identifier(&name) {
                    return self.parse_cell_ref(None, name, false, false);
                }
                Ok(Expression::NamedRef { name, ref_site_id: RefSiteId::ZERO })
            }
            Token::QuotedIdentifier(name) => {
                self.advance();
                self.expect(Token::Exclamation)?;
                self.parse_sheet_reference(name)
            }
            Token::Dollar => {
                self.advance();
                self.parse_absolute_reference(None)
            }
            Token::LBracket => self.parse_table_reference(String::new()),
            other => Err(ParseError::new(format!(
                "Expected a reference after ':', found {:?}",
                other
            ))),
        }
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

        // `A1:(A3)`, `A1:@A3` -- an end that is no identifier (BUG-0737).
        if !end_col_absolute {
            if let Some(end) = self.parse_range_operand_half(None)? {
                let start = self.range_start_half(&start_identifier, start_col_absolute, &sheet)?;
                return Ok(Expression::Range { sheet, start: Box::new(start), end: Box::new(end), ref_site_id: RefSiteId::ZERO });
            }
        }

        // Expect another identifier for the end
        let end_identifier = match self.current_token.clone() {
            Token::Identifier(name) => {
                self.advance();
                name
            }
            // `Sheet1!A1:'My Sheet'!A3` -- a quoted second qualifier, after a
            // qualified first half or an unqualified one (`A1:'Sheet1'!A3`,
            // shown `A1:Sheet1!A3` [LIVE, lane formula p1.json]).
            Token::QuotedIdentifier(name) if !end_col_absolute => {
                self.advance();
                // `J881:'D5'` -- a NAME spelled like a cell, quoted as Excel's
                // formula bar shows it (BUG-0739 [LIVE, lane formd p2.json:
                // `=SUM(R[-1]C:D5)` shows `=SUM(J881:'D5')`]).
                if self.current_token != Token::Exclamation && is_cell_spelling(&name) {
                    let start = self.range_start_half(&start_identifier, start_col_absolute, &sheet)?;
                    let end = Expression::NamedRef { name, ref_site_id: RefSiteId::ZERO };
                    return Ok(Expression::Range { sheet, start: Box::new(start), end: Box::new(end), ref_site_id: RefSiteId::ZERO });
                }
                self.expect(Token::Exclamation)?;
                let end = self.parse_qualified_range_end(name)?;
                let (start_col, start_row) = self.split_cell_reference(&start_identifier)?;
                return Ok(Self::cell_range(sheet, (start_col, start_row, start_col_absolute, false), end));
            }
            _ => {
                return Err(ParseError::new(
                    "Expected identifier after ':' in range/column reference",
                ))
            }
        };

        // `A1:INDEX(A1:A5,3)` -- a function-call end (BUG-0737).
        if !end_col_absolute {
            if let Some(end) = self.parse_range_operand_half(Some(&end_identifier))? {
                let start = self.range_start_half(&start_identifier, start_col_absolute, &sheet)?;
                return Ok(Expression::Range { sheet, start: Box::new(start), end: Box::new(end), ref_site_id: RefSiteId::ZERO });
            }
        }

        // `Sheet1!A1:Sheet1!A3` -- the second half carries its own qualifier
        // (BUG-0646). [LIVE, Excel 16] it is the range when both halves name
        // one sheet (7 in `=LET(a,1,SUM(Sheet1!A1:Sheet1!A3)+a)`), `#VALUE!`
        // for two sheets, and the formula bar keeps both qualifiers. An
        // UNQUALIFIED first half is the formula's own sheet (BUG-0737):
        // [LIVE, lane formula p1.json] `=SUM(A1:Sheet1!A3)` in Sheet1 is 6,
        // `=SUM(A1:Sheet2!A3)` #VALUE!, `=ROWS(A1:Sheet1!A3)` 3.
        if self.current_token == Token::Exclamation && !end_col_absolute
            && !start_identifier.chars().all(|c| c.is_ascii_alphabetic())
        {
            self.advance();
            let end = self.parse_qualified_range_end(end_identifier)?;
            let (start_col, start_row) = self.split_cell_reference(&start_identifier)?;
            return Ok(Self::cell_range(sheet, (start_col, start_row, start_col_absolute, false), end));
        }

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
                    start_sheet: identity::sheet_name_key(&start_identifier),
                    end_sheet: identity::sheet_name_key(&end_identifier),
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
        } else if sheet.is_none() && start_is_col_only && !start_col_absolute && !end_is_col_only {
            // `a:C3` -- letters alone are no cell, so the first half is a NAME
            // and the `:` the range operator between it and the cell (BUG-0646).
            // [LIVE, Excel 16] `=LET(a,B2,SUM(a:C3))` is 550 (B2:C3) and
            // `=SUM(A:C3)` with no binder is #NAME?.
            let (end_col, end_row) = self.split_cell_reference(&end_identifier)?;
            Ok(Expression::Range {
                sheet: None,
                start: Box::new(Expression::NamedRef { name: start_identifier, ref_site_id: RefSiteId::ZERO }),
                end: Box::new(Expression::CellRef {
                    sheet: None,
                    col: end_col,
                    row: end_row,
                    col_absolute: end_col_absolute,
                    row_absolute: false,
                    ref_site_id: RefSiteId::ZERO,
                }),
                ref_site_id: RefSiteId::ZERO,
            })
        } else if sheet.is_none() && !start_is_col_only && end_is_col_only && !end_has_dollar_row && !end_col_absolute {
            // `A1:b` -- the mirror image: a cell, then a NAME [LIVE:
            // `=LET(b,A3,SUM(A1:b))` is 6, `=SUM(A1:B)` #NAME?].
            let (start_col, start_row) = self.split_cell_reference(&start_identifier)?;
            Ok(Expression::Range {
                sheet: None,
                start: Box::new(Expression::CellRef {
                    sheet: None,
                    col: start_col,
                    row: start_row,
                    col_absolute: start_col_absolute,
                    row_absolute: false,
                    ref_site_id: RefSiteId::ZERO,
                }),
                end: Box::new(Expression::NamedRef { name: end_identifier, ref_site_id: RefSiteId::ZERO }),
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

        // `$A$1:(A3)`, `$A$1:@A3` (BUG-0737, see `parse_range_or_column_ref`).
        let start_cell = |col: &str| Expression::CellRef {
            sheet: None,
            col: col.to_uppercase(),
            row: start_row,
            col_absolute: start_col_absolute,
            row_absolute: start_row_absolute,
            ref_site_id: RefSiteId::ZERO,
        };
        if !end_col_absolute {
            if let Some(end) = self.parse_range_operand_half(None)? {
                return Ok(Expression::Range { sheet, start: Box::new(start_cell(&start_col)), end: Box::new(end), ref_site_id: RefSiteId::ZERO });
            }
        }

        let end_identifier = match self.current_token.clone() {
            Token::Identifier(name) => {
                self.advance();
                name
            }
            // `Sheet1!$A$1:'My Sheet'!$A$3` -- a quoted second qualifier, as
            // after an unqualified first half (`$A$1:'Sheet1'!A3`).
            Token::QuotedIdentifier(name) if !end_col_absolute => {
                self.advance();
                // `$D1961:'D5'` -- a quoted cell-shaped NAME (BUG-0739 [LIVE,
                // lane formd p1.json: `=SUM(R[-1]C4:D5)` shows
                // `=SUM($D1961:'D5')`]).
                if self.current_token != Token::Exclamation && is_cell_spelling(&name) {
                    let end = Expression::NamedRef { name, ref_site_id: RefSiteId::ZERO };
                    return Ok(Expression::Range { sheet, start: Box::new(start_cell(&start_col)), end: Box::new(end), ref_site_id: RefSiteId::ZERO });
                }
                self.expect(Token::Exclamation)?;
                let end = self.parse_qualified_range_end(name)?;
                return Ok(Self::cell_range(
                    sheet,
                    (start_col.to_uppercase(), start_row, start_col_absolute, start_row_absolute),
                    end,
                ));
            }
            _ => {
                return Err(ParseError::new("Expected cell reference after ':'"));
            }
        };

        // `$A$1:INDEX(A1:A5,3)` -- a function-call end (BUG-0737).
        if !end_col_absolute {
            if let Some(end) = self.parse_range_operand_half(Some(&end_identifier))? {
                return Ok(Expression::Range { sheet, start: Box::new(start_cell(&start_col)), end: Box::new(end), ref_site_id: RefSiteId::ZERO });
            }
        }

        // `Sheet1!$A$1:Sheet1!$A$3` -- see `parse_range_or_column_ref`; an
        // unqualified first half too (`$A$1:Sheet1!A3`, BUG-0737).
        if self.current_token == Token::Exclamation && !end_col_absolute {
            self.advance();
            let end = self.parse_qualified_range_end(end_identifier)?;
            return Ok(Self::cell_range(
                sheet,
                (start_col.to_uppercase(), start_row, start_col_absolute, start_row_absolute),
                end,
            ));
        }

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

        // `SINGLE(x)` IS `@x`: Excel's name for the implicit-intersection
        // operator, which its formula bar shows as `@` [LIVE, Excel 16, lane
        // formfix p1.json: `=SUM(A1:SINGLE(A3))` is 6, shown `=SUM(A1:@A3)`,
        // and both are filed `_xlfn.SINGLE(A3)`]. Calcula had no SINGLE
        // (#NAME?).
        if let BuiltinFunction::Custom(custom) = &func {
            if custom.eq_ignore_ascii_case("SINGLE") && args.len() == 1 {
                let operand = args.pop().expect("one argument");
                return Ok(Expression::ImplicitIntersection { operand: Box::new(operand) });
            }
        }

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
    let mut expr = parser.parse()?;
    apply_r1c1_fallback(&mut expr);
    bind_parameter_column_ranges(&mut expr, &mut Vec::new());
    // The column-range rewrite builds name halves from column letters
    // (`SUM(B:B)` under `LET(b,..)` is `SUM(b:b)`), so spell them too.
    respell_bound_names(&mut expr);
    Ok(expr)
}

/// The checks Excel makes when a formula is TYPED and that a stored formula is
/// not put through again on load: the arity of a built-in called beside a
/// LET / LAMBDA name of its own spelling (BUG-0648, see
/// [`refuse_shadowed_builtin_arity`]), the arity of every other built-in call
/// (BUG-0738, `crate::excel_arity::refuse_builtin_arity`), and the spellings
/// a formula read in R1C1 cannot hold ([`refuse_unspellable_in_r1c1`]). The
/// cell-entry ladder
/// (`engine::typed_entry`) calls this after [`parse`]; a refusal is what a
/// parse error is there -- the typed text is kept as text.
pub fn check_entered_formula(expr: &Expression) -> ParseResult<()> {
    refuse_duplicate_bindings(expr)?;
    refuse_shadowed_builtin_arity(expr, &mut Vec::new())?;
    crate::excel_arity::refuse_builtin_arity(expr)?;
    refuse_value_range_halves(expr)?;
    refuse_unspellable_in_r1c1(expr)?;
    refuse_bound_r1c1_offsets(expr)?;
    refuse_deleted_sheet_references(expr)
}

/// ONE LET MAY NOT DECLARE A NAME TWICE, NOR ONE LAMBDA A PARAMETER TWICE,
/// and "twice" is by the DEFINED-NAME rule (`identity::defined_name_key`),
/// under which case and `ß` / `SS` / `ẞ` do not tell two names apart
/// (NEW-let-duplicate-case). [LIVE, Excel 16, lane namese,
/// SCRATCH/namese/p1.txt, p2.txt] refused with 0x800A03EC:
/// `=LET(ab,1,AB,2,ab+aB)`, `=LET(a,1,a,2,a)`, `=LET(a,1,A,2,a)`,
/// `=LET(Straße,1,STRASSE,2,STRASSE)`, `=LET(straße,1,STRAẞE,2,1)`,
/// `=LAMBDA(ab,AB,ab)(1,2)`, `=LAMBDA(a,b,A,1)`, `=LAMBDA(x,x,1)`,
/// `=LAMBDA(Straße,STRAẞE,1)`, `=LAMBDA(Straße,STRASSE,1)` and (p4)
/// `=LET(Pæresalg,1,PAERESALG,2,1)`, `=LAMBDA(Pæresalg,PAERESALG,1)` -- while
/// `=LET(Pæresalg,1,PAERESALG)` is #NAME?. A name rebound by a NESTED LET or LAMBDA is not a
/// duplicate (`=LET(x,1,LET(X,2,x))` is 2, `=LAMBDA(x,LET(X,2,x))(1)` 2), and
/// the duplicate rule is not the lookup rule: `=LAMBDA(Straße,STRASSE)(1)` is
/// #NAME?, a lookup that does not find the parameter. Calcula took all of the
/// refused ones and let the later binding win. An ENTRY check: a stored
/// formula keeps its text on load.
fn refuse_duplicate_bindings(expr: &Expression) -> ParseResult<()> {
    let mut seen: Vec<String> = Vec::new();
    for slot in binder_slots(expr) {
        let spelling = match slot {
            Expression::NamedRef { name, .. } => Some(name.clone()),
            other => optional_parameter_name(other).map(str::to_string).or_else(|| plain_cell_spelling(other)),
        };
        if let Some(spelling) = spelling {
            let key = identity::defined_name_key(&spelling);
            if seen.contains(&key) {
                let what = match expr {
                    Expression::FunctionCall { func: BuiltinFunction::Lambda, .. } => "LAMBDA parameter",
                    _ => "LET name",
                };
                return Err(ParseError::new(format!("The {} '{}' is declared more than once", what, spelling)));
            }
            seen.push(key);
        }
    }
    for sub in sub_expressions(expr) {
        refuse_duplicate_bindings(sub)?;
    }
    Ok(())
}

/// A range operator with a HALF that is a call of a function returning VALUES,
/// never a reference, is a formula Excel will not take (BUG-0737). [LIVE,
/// Excel 16, lane formula p2.json] typed: `A1:INDEX(..)`, `A1:OFFSET(..)`,
/// `A1:INDIRECT(..)`, `A1:IF(..)`, `A1:CHOOSE(..)`, `A1:XLOOKUP(..)`,
/// `A1:IFS(..)`, `A1:SWITCH(..)`, `A1:LET(..)`, `A1:TAKE(..)`, `A1:DROP(..)`,
/// `A1:TRIMRANGE(..)`, `A1:LAMBDA(x,x)(A3)`; refused (0x800A03EC):
/// `A1:SUM(A3)`, `A1:MAX(A3)`, `A1:CHOOSECOLS(..)`, `A1:CHOOSEROWS(..)`,
/// `A1:FILTER(..)`, `A1:SORT(..)`, `A1:IFERROR(..)`, `A1:IFNA(..)`,
/// `A1:XMATCH(..)`, `A1:VLOOKUP(..)`, `A1:ADDRESS(..)`, `A1:ROW(..)`,
/// `A1:VSTACK(..)`, `A1:HSTACK(..)`, `A1:EXPAND(..)`, `A1:UNIQUE(..)`,
/// `A1:TOCOL(..)`, `A1:WRAPROWS(..)`, `A1:T(..)`, `A1:N(..)`. A call of an
/// unknown name (a LAMBDA invocation, a defined LAMBDA) may return a
/// reference and is taken. An ENTRY check: a stored formula keeps its text.
fn refuse_value_range_halves(expr: &Expression) -> ParseResult<()> {
    fn returns_reference(func: &BuiltinFunction) -> bool {
        matches!(
            func,
            BuiltinFunction::Index
                | BuiltinFunction::Offset
                | BuiltinFunction::Indirect
                | BuiltinFunction::If
                | BuiltinFunction::Choose
                | BuiltinFunction::XLookup
                | BuiltinFunction::Ifs
                | BuiltinFunction::Switch
                | BuiltinFunction::Let
                | BuiltinFunction::Take
                | BuiltinFunction::Drop
                | BuiltinFunction::TrimRange
                | BuiltinFunction::Custom(_)
        )
    }
    if let Expression::Range { start, end, .. } = expr {
        for half in [start.as_ref(), end.as_ref()] {
            if let Expression::FunctionCall { func, .. } = half {
                if !returns_reference(func) {
                    return Err(ParseError::new(format!(
                        "There's a problem with this formula. {}() returns a value, not a reference, so it cannot be one half of a range (':').",
                        func.to_canonical_name()
                    )));
                }
            }
        }
    }
    for sub in sub_expressions(expr) {
        refuse_value_range_halves(sub)?;
    }
    Ok(())
}

/// A reference into a DELETED sheet (`#REF!A1`, `ast::REF_ERROR_SHEET`) is
/// what a sheet deletion leaves behind, never something to type: [LIVE]
/// Excel 16 (lane formd, SCRATCH/formd/p1.json) refuses `=#REF!A1`,
/// `=#REF!A1+1` and `=SUM(#REF!A1:B2)` with 0x800A03EC, and takes the bare
/// error `=#REF!`, `=#REF!+1` and `=SUM(#REF!)`. Calcula accepted all six. A
/// stored one still loads (this is an ENTRY check) and survives F2 + Enter
/// (`engine::typed_entry::reentered_formula`), as it does in Excel.
fn refuse_deleted_sheet_references(expr: &Expression) -> ParseResult<()> {
    let sheet = match expr {
        Expression::CellRef { sheet, .. }
        | Expression::Range { sheet, .. }
        | Expression::ColumnRef { sheet, .. }
        | Expression::RowRef { sheet, .. } => sheet.as_deref(),
        _ => None,
    };
    if sheet == Some(crate::ast::REF_ERROR_SHEET) {
        return Err(ParseError::new(
            "A reference to a deleted sheet (#REF!) cannot be typed; enter the reference again",
        ));
    }
    for sub in sub_expressions(expr) {
        refuse_deleted_sheet_references(sub)?;
    }
    Ok(())
}

/// An R1C1 relative reference beyond the sheet, or one whose head is a LET /
/// LAMBDA name of the same formula, is a formula Excel will not take:
/// [LIVE] Excel 16 (lane formc)
/// refuses `=LET(c,5,c[1])`, `=LET(rc,5,rc[-1])`, `=LAMBDA(c,c[1])(5)` and
/// `=LET(R,5,R[-1]C4)`, while `=LET(x,1,x+RC[-6])` is D's cell of this row.
fn refuse_bound_r1c1_offsets(expr: &Expression) -> ParseResult<()> {
    fn binders(expr: &Expression, out: &mut Vec<String>) {
        for slot in binder_slots(expr) {
            if let Expression::NamedRef { name, .. } = slot {
                out.push(name.to_ascii_uppercase());
            } else if let Some(name) = optional_parameter_name(slot) {
                out.push(name.to_ascii_uppercase());
            }
        }
        for sub in sub_expressions(expr) {
            binders(sub, out);
        }
    }
    fn offsets<'e>(expr: &'e Expression, out: &mut Vec<&'e str>) {
        if let Expression::NamedRef { name, .. } = expr {
            if name.contains('[') {
                out.push(name.as_str());
            }
        }
        for sub in sub_expressions(expr) {
            offsets(sub, out);
        }
    }
    let mut found = Vec::new();
    offsets(expr, &mut found);
    if found.is_empty() {
        return Ok(());
    }
    let mut bound = Vec::new();
    binders(expr, &mut bound);
    for name in found {
        // An offset no smaller than the sheet ([LIVE] `=R[-1048577]C*1`,
        // `=RC[16384]*1` refused; `R[-1048575]C` is accepted and wraps).
        if bracket_r1c1_reference(&name.to_ascii_uppercase(), 0, 0).is_none() {
            return Err(ParseError::new(format!("'{}' is no R1C1 reference this sheet can hold", name)));
        }
        let head: String = name.chars().take_while(|c| c.is_ascii_alphabetic()).collect::<String>().to_ascii_uppercase();
        if bound.contains(&head) {
            return Err(ParseError::new(format!(
                "'{}' is an R1C1 reference, and '{}' is a LET or LAMBDA name of this formula",
                name, head
            )));
        }
    }
    Ok(())
}

/// EXCEL'S R1C1 FALLBACK (lane legacystats, 2026-11-05).
///
/// A LET name or LAMBDA parameter spelled like a plain cell (`A1`, `zz1`,
/// `XFD1048576`) is no name in A1 notation, so Excel reads the formula that
/// declares one in R1C1 notation -- ALL of it, not only the binder's scope.
/// There a plain cell spelling is a NAME: the declared one is the binding,
/// any other one no name that exists. [LIVE, Excel 16, legacystats probes 2
/// and 4 (SCRATCH/legacystats/p2.json, p4.json), formulas typed into column J:
/// `=LAMBDA(A1,A1)(B1)` is #NAME? (Excel's formula bar shows `('B1')`),
/// `=LET(A1,5,A1+1)` 6, `=LET(A1,5,D1+1)` #NAME?, `=LET(A1,5,A1)+D1` #NAME?,
/// `=LET(A1,5,SUM(D1:D2))` #NAME?, `=LET(A1,5,D:D)` #NAME? (`D:(D)`, two
/// names), `=LET(A1,5,IFERROR(D1,"err"))` "err", `=LET(x,5,x+D1)` 15 (nothing
/// cell-shaped declared), `=LET(AAAA1,5,AAAA1+1)` 6 (no cell, no fallback).]
/// Calcula read the binder as a cell reference, which no LET binds: every one
/// of these was #VALUE!.
///
/// What this rewrites, at PARSE time so that a stored formula reads the same
/// on every load (the text keeps the user's spelling):
///
/// * every binder and every plain unqualified cell (`D1`) becomes a
///   `NamedRef` of that spelling -- the binding where one is in scope, an
///   unknown name (#NAME?) where none is; a range of them (`D1:D2`, also
///   behind a sheet) a range of names, and a plain column range (`D:D`) too;
/// * an R1C1 spelling the A1 lexer read as a cell -- `R2` (row 2), `C4`
///   (column 4), `RC4` (this row, column 4) -- becomes a `NamedRef` as well,
///   which [`resolve_r1c1_names`] turns into Excel's reference at entry
///   (`=LET(A1,5,SUM(C4))` is the sum of column D, `=LET(A1,5,RC4)` in J27 is
///   D27 [LIVE]), as it already does `R1C4` and `RC`;
/// * a reference with a `$` or a row range is left as it is: Excel refuses
///   to TYPE one in such a formula ([`refuse_unspellable_in_r1c1`]), so one in
///   a stored formula is the A1 form [`resolve_r1c1_names`] wrote at entry
///   (`R1C4` is stored `$D$1`), and it means that reference on load.
///
/// * a sheet-qualified single cell (`Sheet2!A1`) is that sheet's name, the
///   range of the name with itself, and the three-dimensional
///   `Sheet1:Sheet2!A1` the 3-D span of the name: both #NAME? [LIVE] (lane
///   formc).
///
/// The pass also runs for a formula that holds an unbound R1C1-only spelling
/// (`=R[-1]C+D5`, [`holds_unbound_r1c1_name`], BUG-0739). Such a formula has
/// no R1C1 spelling left once entry resolved it (`J825+D5`), so its stored
/// text quotes the names (`J825+'D5'`, `engine::ast_render::render_formula_raw`)
/// and the parser reads `'D5'`, `X1:'D5'`, `Sheet2!'D5'` and
/// `Sheet1:Sheet2!'D5'` back as the names they are.
///
/// NOT DONE: in a formula that DECLARES a cell-shaped name, a fully RELATIVE
/// R1C1 reference (`RC`, `C`, `RC[-1]`) is stored in its A1 form (`J20`),
/// which the next load -- this pass again -- reads as a name. Telling the two
/// apart there needs the binders quoted in the stored text too, with this
/// pass keyed to a BARE binder, and the host's text shifters and the .xlsx
/// writer taught the quoted form.
fn apply_r1c1_fallback(expr: &mut Expression) {
    if declares_cell_shaped_name(expr) || holds_unbound_r1c1_name(expr) {
        r1c1_fallback_walk(expr, &mut Vec::new());
    }
}

/// Whether `expr` holds an R1C1 spelling that is no A1 cell and that no
/// LET / LAMBDA of the formula binds (`RC`, `R[-1]C`, `RC[-9]`, `R1C1`, a
/// bare `C` / `R`): Excel cannot read such a formula in A1 notation and reads
/// ALL of it in R1C1 instead, where a plain cell spelling is a NAME
/// (BUG-0739). [LIVE, Excel 16, lane formd p2.json and lane formula p1.json,
/// typed into column J] `=R[-1]C+D5` in J1074 is `=J1073+'D5'`, #NAME?;
/// `=R1C1+D5` `=$A$1+'D5'`; `=SUM(R[-1]C:D5)` `=SUM(J881:'D5')`;
/// `=R[-1]C+A1:A2` `=J945+'A1':'A2'`; `=R[-1]C+Sheet2!D5`
/// `=J857+Sheet2!'D5'`; and `=RC[-9]+RC4` is `=A1090+$D1090` -- `RC4`, the
/// A1 cell in column RC, is R1C1's column 4 of the row there. Calcula read
/// each plain cell as the cell it spells.
pub fn holds_unbound_r1c1_name(expr: &Expression) -> bool {
    fn walk(expr: &Expression, bound: &mut Vec<String>) -> bool {
        match expr {
            Expression::NamedRef { name, .. } => {
                let upper = name.to_ascii_uppercase();
                !is_cell_spelling(name)
                    && !bound.iter().any(|b| *b == upper)
                    && r1c1_reference(&upper, 0, 0).is_some()
            }
            Expression::FunctionCall { func: BuiltinFunction::Let, args, .. } if args.len() >= 3 => {
                // A LET name is in scope after its own value.
                let depth = bound.len();
                let last = args.len() - 1;
                let mut found = false;
                let mut pending: Option<String> = None;
                for (i, arg) in args.iter().enumerate() {
                    if i < last && i % 2 == 0 {
                        pending = match arg {
                            Expression::NamedRef { name, .. } => Some(name.to_ascii_uppercase()),
                            _ => None,
                        };
                    } else {
                        if walk(arg, bound) {
                            found = true;
                            break;
                        }
                        bound.extend(pending.take());
                    }
                }
                bound.truncate(depth);
                found
            }
            Expression::FunctionCall { func: BuiltinFunction::Lambda, args, .. } if !args.is_empty() => {
                let depth = bound.len();
                let last = args.len() - 1;
                for arg in &args[..last] {
                    if let Expression::NamedRef { name, .. } = arg {
                        bound.push(name.to_ascii_uppercase());
                    } else if let Some(name) = optional_parameter_name(arg) {
                        bound.push(name.to_ascii_uppercase());
                    }
                }
                let found = walk(&args[last], bound);
                bound.truncate(depth);
                found
            }
            other => sub_expressions(other).into_iter().any(|sub| walk(sub, bound)),
        }
    }
    walk(expr, &mut Vec::new())
}

/// A plain unqualified relative cell reference (`A1`, never `$A$1` or
/// `Sheet2!A1`) and its spelling.
fn plain_cell_spelling(expr: &Expression) -> Option<String> {
    match expr {
        Expression::CellRef { sheet: None, col, row, col_absolute: false, row_absolute: false, .. } => {
            Some(format!("{}{}", col, row))
        }
        _ => None,
    }
}

/// Every direct sub-expression of `expr`.
pub(crate) fn sub_expressions(expr: &Expression) -> Vec<&Expression> {
    match expr {
        Expression::FunctionCall { args, .. } => args.iter().collect(),
        Expression::Range { start, end, .. } => vec![start.as_ref(), end.as_ref()],
        Expression::BinaryOp { left, right, .. } => vec![left.as_ref(), right.as_ref()],
        Expression::UnaryOp { operand, .. } | Expression::ImplicitIntersection { operand } => vec![operand.as_ref()],
        Expression::IndexAccess { target, index } => vec![target.as_ref(), index.as_ref()],
        Expression::ArrayLiteral { rows } => rows.iter().flatten().collect(),
        Expression::ListLiteral { elements } => elements.iter().collect(),
        Expression::DictLiteral { entries } => entries.iter().flat_map(|(k, v)| [k, v]).collect(),
        Expression::SpillRef { cell, .. } => vec![cell.as_ref()],
        Expression::Sheet3DRef { reference, .. } => vec![reference.as_ref()],
        Expression::Literal(_)
        | Expression::CellRef { .. }
        | Expression::ColumnRef { .. }
        | Expression::RowRef { .. }
        | Expression::NamedRef { .. }
        | Expression::TableRef { .. } => Vec::new(),
    }
}

/// The binder slots of a LET (`name1`, `name2`, ...) or a LAMBDA (every
/// parameter), or none for any other expression.
fn binder_slots(expr: &Expression) -> Vec<&Expression> {
    match expr {
        Expression::FunctionCall { func: BuiltinFunction::Let, args, .. } if args.len() >= 3 => {
            args[..args.len() - 1].iter().step_by(2).collect()
        }
        Expression::FunctionCall { func: BuiltinFunction::Lambda, args, .. } if !args.is_empty() => {
            args[..args.len() - 1].iter().collect()
        }
        _ => Vec::new(),
    }
}

/// The name of an OPTIONAL LAMBDA parameter, `[x]` -- which the parser reads
/// as a structured reference with no table -- or `None`. [LIVE, Excel 16,
/// lane formfix p1.json: `=LAMBDA([A1],A1)(5)` is 5, filed
/// `_xlfn.LAMBDA(_xlop.A1,_xlpm.A1)(5)`.]
pub fn optional_parameter_name(slot: &Expression) -> Option<&str> {
    match slot {
        Expression::TableRef { table_name, specifier: crate::ast::TableSpecifier::Column(name), .. }
            if table_name.is_empty() =>
        {
            Some(name.as_str())
        }
        _ => None,
    }
}

/// Whether a LET / LAMBDA anywhere in `expr` declares a cell-shaped name --
/// read as a cell by the lexer, or (in a tree this pass already rewrote) a
/// `NamedRef` spelled like one, or an OPTIONAL parameter spelled like one
/// (`[A1]`). Public for the host's text shifters
/// (`commands::structure`), which must hold every name such a formula reads
/// out of a fill or a structural shift, as Excel leaves them.
///
/// An optional parameter counts like any other (W2 xlsx lane): [LIVE, Excel
/// 16, lane formfix p1.json] `=LAMBDA([A1],SUM(A1:A3))(B1)` is shown
/// `=LAMBDA([A1],SUM(A1:'A3'))('B1')` and filed
/// `_xlfn.LAMBDA(_xlop.A1,SUM(_xlpm.A1:_xlnm.A3))(_xlnm.B1)`, #NAME?, and
/// `=LAMBDA([A1],B1)(5)` is `=LAMBDA([A1],'B1')(5)`, #NAME?.
pub fn declares_cell_shaped_name(expr: &Expression) -> bool {
    binder_slots(expr).into_iter().any(|slot| match slot {
        Expression::NamedRef { name, .. } => is_cell_spelling(name),
        other => match optional_parameter_name(other) {
            Some(name) => is_cell_spelling(name),
            None => plain_cell_spelling(other).is_some(),
        },
    }) || sub_expressions(expr).into_iter().any(declares_cell_shaped_name)
}

/// `A1` .. `XFD1048576`: the spellings the A1 lexer reads as one cell.
pub fn is_cell_spelling(name: &str) -> bool {
    let letters = name.chars().take_while(|c| c.is_ascii_alphabetic()).count();
    let digits = &name[letters..];
    if !(1..=3).contains(&letters) || digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    let col = name[..letters].chars().fold(0u32, |n, c| n * 26 + (c.to_ascii_uppercase() as u32 - 'A' as u32 + 1));
    let row = digits.parse::<u64>().unwrap_or(0);
    col <= 16_384 && (1..=1_048_576).contains(&row)
}

/// Whether a cell spelling is ALSO an R1C1 reference -- `R<n>`, `C<n>`,
/// `RC<n>` -- which R1C1 notation reads as a row, a column or a cell.
fn is_r1c1_cell_spelling(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    let letters: String = upper.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
    matches!(letters.as_str(), "R" | "C" | "RC") && upper.len() > letters.len()
}

/// Whether an identifier after a sheet qualifier is an R1C1 reference and no
/// A1 one (`Parser::parse_qualified_r1c1`): `RC`, `R`, `C`, `R2C`, `R1C1`,
/// `R[-1]C[-9]` -- never `C1` or `RC4`, which are A1 cells, and never the
/// bare letters of an A1 column range (`Sheet2!RC:RC` is column RC, [LIVE]
/// `=SUM(Sheet2!RC:RC)` 0).
fn is_qualified_r1c1_spelling(name: &str, followed_by_colon: bool) -> bool {
    if is_cell_spelling(name) {
        return false;
    }
    let upper = name.to_ascii_uppercase();
    if followed_by_colon && upper.chars().all(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    r1c1_reference(&upper, 0, 0).is_some()
}

fn named(name: String) -> Expression {
    Expression::NamedRef { name, ref_site_id: RefSiteId::ZERO }
}

/// Whether an identifier after `Sheet!` is a defined NAME rather than a
/// reference: no A1 cell, no R1C1 reference, and a spelling Excel takes as a
/// name (`identity::is_valid_defined_name`). `Sheet1!Rate` [LIVE, Excel 16,
/// lane formfix p1.json: on Sheet2 `=Sheet1!Dup` is Sheet1's own Dup (2),
/// `=Sheet1!Glob` the workbook's Glob (7), `=Sheet1!LocTwo` -- a name only
/// Sheet2 has -- #NAME?, `=Sheet1!Nope` #NAME?].
fn is_qualified_name_spelling(name: &str) -> bool {
    !is_cell_spelling(name)
        && r1c1_reference(&name.to_ascii_uppercase(), 0, 0).is_none()
        && identity::is_valid_defined_name(name)
}

/// `Sheet1!Rate`, the defined name `Rate` read in Sheet1's scope: the range
/// of the name with itself behind the sheet (the shape `Sheet2!'A1'` has).
/// See [`qualified_name_parts`].
fn qualified_name(sheet: String, name: String) -> Expression {
    let half = Expression::NamedRef { name, ref_site_id: RefSiteId::ZERO };
    Expression::Range {
        sheet: Some(sheet),
        start: Box::new(half.clone()),
        end: Box::new(half),
        ref_site_id: RefSiteId::ZERO,
    }
}

/// The sheet and the name of a SHEET-QUALIFIED NAME (`Sheet1!Rate`), or
/// `None` for any other expression (BUG-0744/0749).
///
/// Excel reads `Sheet1!Rate` as the name `Rate` in Sheet1's scope: Sheet1's
/// own `Rate`, else the workbook's [LIVE, Excel 16, lane formfix p1.json:
/// `=Sheet1!Dup` on Sheet2 is 2, `=Sheet2!Dup` on Sheet1 -- Sheet2 holding no
/// Dup -- the workbook's 1, shown `Book1!Dup`], never a LET / LAMBDA binding
/// (`=LET(Dup,9,Sheet1!Dup)` is 2). The parser holds it as the range of the
/// name with itself behind the sheet; a cell-shaped spelling there
/// (`Sheet2!'A1'`, a formula read in R1C1) is the same node, and no defined
/// name can be spelled like a cell, so it resolves to nothing (#NAME?).
pub fn qualified_name_parts(expr: &Expression) -> Option<(&str, &str)> {
    match expr {
        Expression::Range { sheet: Some(sheet), start, end, .. } => match (start.as_ref(), end.as_ref()) {
            (Expression::NamedRef { name: a, .. }, Expression::NamedRef { name: b, .. }) if a == b => {
                Some((sheet.as_str(), a.as_str()))
            }
            _ => None,
        },
        _ => None,
    }
}

/// The spelling a bare NAME token keeps until [`respell_bound_names`]: the
/// typed one, when it is this token's (the lexer folds it to `folded`).
fn typed_name_spelling(folded: &str, typed: String) -> String {
    let refolded: String = typed.chars().map(crate::lexer::fold_identifier_char).collect();
    if refolded == folded {
        typed
    } else {
        folded.to_string()
    }
}

/// A LET NAME OR LAMBDA PARAMETER IS SHOWN AS IT WAS DECLARED, AND EVERY USE
/// OF IT IN ITS SCOPE IS RESPELLED TO THAT DECLARATION (lane formd,
/// NEW-let-param-case).
///
/// [LIVE, Excel 16, lane formd, SCRATCH/formd/p1.json, `Range.Formula2` read
/// back] `=LET(Abc,1,ABC+abc)` is `=LET(Abc,1,Abc+Abc)`, `=LAMBDA(X,x*2)(5)`
/// `=LAMBDA(X,X*2)(5)`, `=LET(myVal,2,MYVAL*myval)` `=LET(myVal,2,myVal*myVal)`,
/// `=LET(x,1,LET(X,2,x))` `=LET(x,1,LET(X,2,X))` (the inner declaration
/// shadows), `=LAMBDA(Total,LET(total,Total*2,TOTAL))(3)`
/// `=LAMBDA(Total,LET(total,Total*2,total))(3)` (a LET value does not see its
/// own name), `=LET(x,1,y,LAMBDA(X,X+x),y(5))` `..,y(5))` (a call of a bound
/// name too), `=LET(äb,1,ÄB)` `=LET(äb,1,äb)`, and `=LET(Straße,1,STRASSE)`
/// keeps `STRASSE`, which is no use of `Straße` (#NAME?): names compare one
/// character for one under Excel's case table (`identity::sheet_name_key`),
/// never with `to_uppercase`, which expands `ß`. Calcula's lexer folds every
/// identifier, so all of these came back upper-cased (`=LAMBDA(X,X*2)(5)` for
/// `=LAMBDA(x,x*2)(5)`).
///
/// Every OTHER bare name -- a defined name, a table, an R1C1 reference -- is
/// folded to the lexer's spelling exactly as before, so nothing that compares
/// such a name sees a change.
pub(crate) fn respell_bound_names(expr: &mut Expression) {
    respell_walk(expr, &mut Vec::new());
}

fn respell_walk(expr: &mut Expression, scope: &mut Vec<(String, String)>) {
    let bound = |scope: &[(String, String)], name: &str| -> Option<String> {
        let key = identity::sheet_name_key(name);
        scope.iter().rev().find(|(k, _)| *k == key).map(|(_, spelling)| spelling.clone())
    };
    match expr {
        Expression::NamedRef { name, .. } => {
            *name = bound(scope, name).unwrap_or_else(|| name.chars().map(crate::lexer::fold_identifier_char).collect());
        }
        Expression::FunctionCall { func: BuiltinFunction::Let, args, .. } if args.len() >= 3 => {
            let depth = scope.len();
            let last = args.len() - 1;
            let mut pending: Option<(String, String)> = None;
            for (i, arg) in args.iter_mut().enumerate() {
                if i == last {
                    respell_walk(arg, scope);
                } else if i % 2 == 0 {
                    // The declaration keeps its own spelling.
                    pending = match arg {
                        Expression::NamedRef { name, .. } => Some((identity::sheet_name_key(name), name.clone())),
                        _ => None,
                    };
                } else {
                    respell_walk(arg, scope);
                    scope.extend(pending.take());
                }
            }
            scope.truncate(depth);
        }
        Expression::FunctionCall { func: BuiltinFunction::Lambda, args, .. } if !args.is_empty() => {
            let depth = scope.len();
            let last = args.len() - 1;
            for arg in &args[..last] {
                if let Expression::NamedRef { name, .. } = arg {
                    scope.push((identity::sheet_name_key(name), name.clone()));
                }
            }
            respell_walk(&mut args[last], scope);
            scope.truncate(depth);
        }
        Expression::FunctionCall { func, args, .. } => {
            if let BuiltinFunction::Custom(name) = func {
                if let Some(spelling) = bound(scope, name) {
                    *name = spelling;
                }
            }
            for arg in args {
                respell_walk(arg, scope);
            }
        }
        Expression::Range { start, end, .. } => {
            respell_walk(start, scope);
            respell_walk(end, scope);
        }
        Expression::BinaryOp { left, right, .. } => {
            respell_walk(left, scope);
            respell_walk(right, scope);
        }
        Expression::UnaryOp { operand, .. } | Expression::ImplicitIntersection { operand } => {
            respell_walk(operand, scope);
        }
        Expression::IndexAccess { target, index } => {
            respell_walk(target, scope);
            respell_walk(index, scope);
        }
        Expression::ArrayLiteral { rows } => {
            for elem in rows.iter_mut().flatten() {
                respell_walk(elem, scope);
            }
        }
        Expression::ListLiteral { elements } => {
            for elem in elements {
                respell_walk(elem, scope);
            }
        }
        Expression::DictLiteral { entries } => {
            for (key, value) in entries {
                respell_walk(key, scope);
                respell_walk(value, scope);
            }
        }
        Expression::SpillRef { cell, .. } => respell_walk(cell, scope),
        Expression::Sheet3DRef { reference, .. } => respell_walk(reference, scope),
        Expression::Literal(_)
        | Expression::CellRef { .. }
        | Expression::ColumnRef { .. }
        | Expression::RowRef { .. }
        | Expression::TableRef { .. } => {}
    }
}

/// The formula with every range HALF that is a LET name -- or the parameter
/// of a LAMBDA called inline -- bound to a plain reference replaced by that
/// reference, for PRECEDENT extraction (BUG-0737); `None` when it has none.
///
/// `=LET(a,B2,SUM(a:C3))` reads the whole RECTANGLE B2:C3 [LIVE, Excel 16:
/// 550], so an edit of B3 or C2 must recalculate it -- but an extractor that
/// knows no LET scope sees only B2 (the LET value) and C3 (the cell half), and
/// the interior never reached the dependency graph. Likewise
/// `=LAMBDA(b,SUM(A1:b))(A3)` reads A1:A3 [LIVE: 6]. The tree the EVALUATOR
/// reads is left alone (it resolves the name through its scope); only the
/// copy handed to the extractor is rewritten, and only where a name half's
/// binding is statically a reference (a cell, a range of cells, a whole
/// column or row, or another such name).
pub fn bind_range_name_halves(expr: &Expression) -> Option<Expression> {
    if !has_named_range_half(expr) {
        return None;
    }
    let mut copy = expr.clone();
    let changed = bind_halves_walk(&mut copy, &mut Vec::new());
    changed.then_some(copy)
}

/// Whether some range in `expr` has a NAME half (the cheap pre-check of
/// [`bind_range_name_halves`]).
fn has_named_range_half(expr: &Expression) -> bool {
    if let Expression::Range { start, end, .. } = expr {
        if matches!(start.as_ref(), Expression::NamedRef { .. }) || matches!(end.as_ref(), Expression::NamedRef { .. }) {
            return true;
        }
    }
    sub_expressions(expr).into_iter().any(has_named_range_half)
}

/// The reference a binding's VALUE statically is, with the names in `scope`.
fn static_reference(value: &Expression, scope: &[(String, Option<Expression>)]) -> Option<Expression> {
    match value {
        Expression::CellRef { .. } | Expression::ColumnRef { .. } | Expression::RowRef { .. } => Some(value.clone()),
        Expression::Range { start, end, .. }
            if matches!(start.as_ref(), Expression::CellRef { .. }) && matches!(end.as_ref(), Expression::CellRef { .. }) =>
        {
            Some(value.clone())
        }
        Expression::NamedRef { name, .. } => {
            let key = identity::sheet_name_key(name);
            scope.iter().rev().find(|(k, _)| *k == key).and_then(|(_, r)| r.clone())
        }
        _ => None,
    }
}

/// The rewrite of [`bind_range_name_halves`]; returns whether it changed
/// anything. `scope` holds each binder in scope and the reference it is.
fn bind_halves_walk(expr: &mut Expression, scope: &mut Vec<(String, Option<Expression>)>) -> bool {
    let lookup = |scope: &[(String, Option<Expression>)], name: &str| -> Option<Expression> {
        let key = identity::sheet_name_key(name);
        scope.iter().rev().find(|(k, _)| *k == key).and_then(|(_, r)| r.clone())
    };
    match expr {
        Expression::FunctionCall { func: BuiltinFunction::Let, args, .. } if args.len() >= 3 => {
            let depth = scope.len();
            let last = args.len() - 1;
            let mut changed = false;
            let mut pending: Option<String> = None;
            for (i, arg) in args.iter_mut().enumerate() {
                if i == last {
                    changed |= bind_halves_walk(arg, scope);
                } else if i % 2 == 0 {
                    pending = match arg {
                        Expression::NamedRef { name, .. } => Some(identity::sheet_name_key(name)),
                        _ => None,
                    };
                } else {
                    changed |= bind_halves_walk(arg, scope);
                    let reference = static_reference(arg, scope);
                    if let Some(key) = pending.take() {
                        scope.push((key, reference));
                    }
                }
            }
            scope.truncate(depth);
            changed
        }
        // `LAMBDA(b, body)(A3)`: the parameters are the call's arguments.
        Expression::FunctionCall { func: BuiltinFunction::Custom(marker), args, .. }
            if marker == "__INVOKE__"
                && matches!(args.first(), Some(Expression::FunctionCall { func: BuiltinFunction::Lambda, .. })) =>
        {
            let mut changed = false;
            for arg in args.iter_mut().skip(1) {
                changed |= bind_halves_walk(arg, scope);
            }
            let references: Vec<Option<Expression>> = args[1..].iter().map(|a| static_reference(a, scope)).collect();
            if let Some(Expression::FunctionCall { args: lambda, .. }) = args.first_mut() {
                if let Some((body, params)) = lambda.split_last_mut() {
                    let depth = scope.len();
                    for (i, param) in params.iter().enumerate() {
                        if let Expression::NamedRef { name, .. } = param {
                            scope.push((identity::sheet_name_key(name), references.get(i).cloned().flatten()));
                        }
                    }
                    changed |= bind_halves_walk(body, scope);
                    scope.truncate(depth);
                }
            }
            changed
        }
        Expression::FunctionCall { func: BuiltinFunction::Lambda, args, .. } if !args.is_empty() => {
            let depth = scope.len();
            let last = args.len() - 1;
            for param in &args[..last] {
                if let Expression::NamedRef { name, .. } = param {
                    scope.push((identity::sheet_name_key(name), None));
                }
            }
            let changed = bind_halves_walk(&mut args[last], scope);
            scope.truncate(depth);
            changed
        }
        Expression::Range { sheet, start, end, .. } => {
            // Behind a sheet a name half is that SHEET's name, never a LET /
            // LAMBDA binding (`Sheet2!A1` in a formula read in R1C1).
            let qualified = sheet.is_some();
            let mut changed = false;
            for half in [start, end] {
                if let Expression::NamedRef { name, .. } = half.as_ref() {
                    if let Some(reference) = lookup(scope, name).filter(|_| !qualified) {
                        **half = reference;
                        changed = true;
                        continue;
                    }
                }
                changed |= bind_halves_walk(half, scope);
            }
            changed
        }
        Expression::FunctionCall { args, .. } => {
            let mut changed = false;
            for arg in args {
                changed |= bind_halves_walk(arg, scope);
            }
            changed
        }
        Expression::BinaryOp { left, right, .. } => {
            let a = bind_halves_walk(left, scope);
            let b = bind_halves_walk(right, scope);
            a || b
        }
        Expression::UnaryOp { operand, .. } | Expression::ImplicitIntersection { operand } => bind_halves_walk(operand, scope),
        Expression::IndexAccess { target, index } => {
            let a = bind_halves_walk(target, scope);
            let b = bind_halves_walk(index, scope);
            a || b
        }
        Expression::ArrayLiteral { rows } => {
            let mut changed = false;
            for elem in rows.iter_mut().flatten() {
                changed |= bind_halves_walk(elem, scope);
            }
            changed
        }
        Expression::ListLiteral { elements } => {
            let mut changed = false;
            for elem in elements {
                changed |= bind_halves_walk(elem, scope);
            }
            changed
        }
        Expression::DictLiteral { entries } => {
            let mut changed = false;
            for (key, value) in entries {
                changed |= bind_halves_walk(key, scope);
                changed |= bind_halves_walk(value, scope);
            }
            changed
        }
        Expression::SpillRef { cell, .. } => bind_halves_walk(cell, scope),
        Expression::Sheet3DRef { reference, .. } => bind_halves_walk(reference, scope),
        Expression::Literal(_)
        | Expression::CellRef { .. }
        | Expression::ColumnRef { .. }
        | Expression::RowRef { .. }
        | Expression::NamedRef { .. }
        | Expression::TableRef { .. } => false,
    }
}

/// The rewrite of [`apply_r1c1_fallback`]. `bound` holds the binders in scope;
/// a LET value sees only the names bound before it.
fn r1c1_fallback_walk(expr: &mut Expression, bound: &mut Vec<String>) {
    if let Some(spelling) = plain_cell_spelling(expr) {
        *expr = named(spelling);
        return;
    }
    match expr {
        Expression::FunctionCall { func: BuiltinFunction::Let, args, .. } if args.len() >= 3 => {
            let depth = bound.len();
            let last = args.len() - 1;
            let mut pending: Option<String> = None;
            for (i, arg) in args.iter_mut().enumerate() {
                if i == last {
                    r1c1_fallback_walk(arg, bound);
                } else if i % 2 == 0 {
                    if let Some(spelling) = plain_cell_spelling(arg) {
                        *arg = named(spelling);
                    }
                    pending = match arg {
                        Expression::NamedRef { name, .. } => Some(name.to_ascii_uppercase()),
                        _ => None,
                    };
                } else {
                    r1c1_fallback_walk(arg, bound);
                    bound.extend(pending.take());
                }
            }
            bound.truncate(depth);
        }
        Expression::FunctionCall { func: BuiltinFunction::Lambda, args, .. } if !args.is_empty() => {
            let depth = bound.len();
            let last = args.len() - 1;
            for arg in &mut args[..last] {
                if let Some(spelling) = plain_cell_spelling(arg) {
                    *arg = named(spelling);
                }
                if let Expression::NamedRef { name, .. } = arg {
                    bound.push(name.to_ascii_uppercase());
                } else if let Some(name) = optional_parameter_name(arg) {
                    bound.push(name.to_ascii_uppercase());
                }
            }
            r1c1_fallback_walk(&mut args[last], bound);
            bound.truncate(depth);
        }
        Expression::FunctionCall { args, .. } => {
            for arg in args {
                r1c1_fallback_walk(arg, bound);
            }
        }
        // `D:D` is the range operator between two names in R1C1 (Excel's file
        // spells it `D:(D)`); `$D:$D` is the column (see the doc above).
        Expression::ColumnRef { sheet, start_col, end_col, start_absolute: false, end_absolute: false, .. } => {
            let sheet = sheet.take();
            let start = std::mem::take(start_col);
            let end = std::mem::take(end_col);
            *expr = Expression::Range {
                sheet,
                start: Box::new(named(start)),
                end: Box::new(named(end)),
                ref_site_id: RefSiteId::ZERO,
            };
        }
        Expression::Range { start, end, .. } => {
            r1c1_fallback_walk(start, bound);
            r1c1_fallback_walk(end, bound);
        }
        Expression::BinaryOp { left, right, .. } => {
            r1c1_fallback_walk(left, bound);
            r1c1_fallback_walk(right, bound);
        }
        Expression::UnaryOp { operand, .. } | Expression::ImplicitIntersection { operand } => {
            r1c1_fallback_walk(operand, bound);
        }
        Expression::IndexAccess { target, index } => {
            r1c1_fallback_walk(target, bound);
            r1c1_fallback_walk(index, bound);
        }
        Expression::ArrayLiteral { rows } => {
            for elem in rows.iter_mut().flatten() {
                r1c1_fallback_walk(elem, bound);
            }
        }
        Expression::ListLiteral { elements } => {
            for elem in elements {
                r1c1_fallback_walk(elem, bound);
            }
        }
        Expression::DictLiteral { entries } => {
            for (key, value) in entries {
                r1c1_fallback_walk(key, bound);
                r1c1_fallback_walk(value, bound);
            }
        }
        Expression::SpillRef { cell, .. } => r1c1_fallback_walk(cell, bound),
        // `Sheet2!A1` -- a plain cell spelling behind ONE sheet -- is that
        // sheet's NAME `A1`, which no workbook can define: [LIVE] Excel 16
        // `=LET(A1,2,Sheet2!A1)` is #NAME? (formula bar `Sheet2!'A1'`, even
        // with A1 bound), `=LET(A1,2,Sheet2!A1+A1)` #NAME?, `ISREF(..)` FALSE.
        // Kept as the range of that name with itself, which `eval_range`
        // answers #NAME? behind a sheet and the renderer writes back as
        // `Sheet2!A1` (lane formc).
        Expression::CellRef { sheet: Some(_), col_absolute: false, row_absolute: false, .. } => {
            if let Expression::CellRef { sheet, col, row, .. } = expr {
                let spelling = format!("{}{}", col, row);
                let sheet = sheet.take();
                *expr = Expression::Range {
                    sheet,
                    start: Box::new(named(spelling.clone())),
                    end: Box::new(named(spelling)),
                    ref_site_id: RefSiteId::ZERO,
                };
            }
        }
        // `Sheet1:Sheet2!A1`: the 3-D span of a name, [LIVE] #NAME? too
        // (`=LET(A1,2,SUM(Sheet1:Sheet2!A1))`, formula bar `'A1'`).
        Expression::Sheet3DRef { reference, .. } => {
            if let Some(spelling) = plain_cell_spelling(reference) {
                **reference = named(spelling);
            } else if let Expression::Range { start, end, .. } = reference.as_mut() {
                for half in [start, end] {
                    if let Some(spelling) = plain_cell_spelling(half) {
                        **half = named(spelling);
                    }
                }
            }
        }
        Expression::Literal(_)
        | Expression::CellRef { .. }
        | Expression::ColumnRef { .. }
        | Expression::RowRef { .. }
        | Expression::NamedRef { .. }
        | Expression::TableRef { .. } => {}
    }
}

/// What a formula read in R1C1 ([`apply_r1c1_fallback`]) cannot hold, which
/// Excel therefore refuses to TYPE [LIVE, Excel 16, legacystats probes 2 and 4]:
/// a reference with a `$` (`=LET(A1,5,$D$1)`, `A$1`, `$A1`), a row range
/// (`=LET(A1,5,1:1)`), and a binder that is itself an R1C1 reference
/// (`=LAMBDA(R2,R2)(3)`, `=LET(C3,1,C3)`, `=LET(RC4,1,RC4)`: row 2, column 3,
/// this row's column 4). Entry only: a stored formula holds the `$` form
/// [`resolve_r1c1_names`] wrote for an R1C1 reference, and still loads.
fn refuse_unspellable_in_r1c1(expr: &Expression) -> ParseResult<()> {
    // Read in R1C1 because it declares a cell-shaped name -- or because it
    // holds an R1C1-only spelling (BUG-0739 [LIVE, lane formd p2.json:
    // `=R[-1]C+$D$5` and `=R[-1]C+SUM(1:1)` refused, 0x800A03EC]).
    if !declares_cell_shaped_name(expr) && !holds_unbound_r1c1_name(expr) {
        return Ok(());
    }
    fn walk(expr: &Expression) -> ParseResult<()> {
        let refuse = |what: &str| {
            Err(ParseError::new(format!(
                "{} cannot be used in a formula Excel reads in R1C1 notation (one that declares a LET or LAMBDA name spelled like a cell, or holds an R1C1 reference such as RC or R[-1]C)",
                what
            )))
        };
        match expr {
            Expression::CellRef { col_absolute, row_absolute, .. } if *col_absolute || *row_absolute => {
                return refuse("A reference with '$'");
            }
            Expression::ColumnRef { start_absolute, end_absolute, .. } if *start_absolute || *end_absolute => {
                return refuse("A reference with '$'");
            }
            Expression::RowRef { .. } => return refuse("A row range"),
            _ => {}
        }
        for slot in binder_slots(expr) {
            if let Expression::NamedRef { name, .. } = slot {
                if is_cell_spelling(name) && is_r1c1_cell_spelling(name) {
                    return refuse(&format!("The name '{}' (an R1C1 reference)", name));
                }
            }
        }
        for sub in sub_expressions(expr) {
            walk(sub)?;
        }
        Ok(())
    }
    walk(expr)
}

/// The arity a built-in function accepts, `(fewest, most)` (`None`: no limit),
/// from its catalog syntax string -- the one source of truth the function
/// dialog reads (`SUM(number1, [number2], ...)` is one or more,
/// `ROUND(number, num_digits)` exactly two, `PI()` none). `None` for a name the
/// catalog does not list.
pub fn builtin_arity(name: &str) -> Option<(usize, Option<usize>)> {
    static TABLE: std::sync::OnceLock<std::collections::HashMap<String, (usize, Option<usize>)>> =
        std::sync::OnceLock::new();
    let table = TABLE.get_or_init(|| {
        BuiltinFunction::all_catalog_entries()
            .into_iter()
            .filter(|meta| !meta.is_alias)
            .filter_map(|meta| Some((meta.name.to_ascii_uppercase(), syntax_arity(meta.syntax)?)))
            .collect()
    });
    table.get(&name.to_ascii_uppercase()).copied()
}

/// `(fewest, most)` arguments of a catalog syntax string (see [`builtin_arity`]).
fn syntax_arity(syntax: &str) -> Option<(usize, Option<usize>)> {
    let inner = syntax.get(syntax.find('(')? + 1..syntax.rfind(')')?)?.trim();
    if inner.is_empty() {
        return Some((0, Some(0)));
    }
    let mut pieces = Vec::new();
    let (mut depth, mut start) = (0usize, 0usize);
    for (at, c) in inner.char_indices() {
        match c {
            '[' => depth += 1,
            ']' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => {
                pieces.push(inner[start..at].trim());
                start = at + 1;
            }
            _ => {}
        }
    }
    pieces.push(inner[start..].trim());
    let fewest = pieces.iter().filter(|p| !p.starts_with('[') && !p.contains("...")).count();
    let most = (!pieces.iter().any(|p| p.contains("..."))).then_some(pieces.len());
    Some((fewest, most))
}

/// A BUILT-IN CALLED BESIDE A LET / LAMBDA NAME OF ITS OWN SPELLING IS THE
/// BUILT-IN, AND A REFUSED ARITY IS A FORMULA EXCEL DOES NOT ACCEPT (BUG-0648).
///
/// [LIVE, Excel 16, parser lane probe and rev18x pass1] `=LET(abs,LAMBDA(x,
/// x+1),abs(-3))` is stored `ABS(-3)` and answers 3, and
/// `=LET(round,LAMBDA(x,x*2),round(3.14159,1))` is `ROUND(..)` = 3.1 -- the
/// call is the built-in (`BuiltinFunction::from_name`, as here). With an arity
/// the built-in refuses -- `LET(abs,LAMBDA(x,y,x+y),abs(1,2))`,
/// `LET(pi,LAMBDA(x,x*2),pi(3))`, `LET(round,LAMBDA(x,x*2),round(3))`,
/// `LET(max,LAMBDA(x,x),max())` -- Excel refuses the formula at entry. Calcula
/// accepted each and evaluated the built-in with the refused arity, and the
/// .xlsx export had to fall back to the value. Refused at ENTRY
/// ([`check_entered_formula`]), with the reason -- not by [`parse`], so a
/// workbook that already holds such a formula still opens with it (and the
/// export keeps its value-only fallback for it).
///
/// The SHADOWED call is checked here, ahead of the general check that refuses
/// a plain `ABS(1,2)` too (BUG-0738, `crate::excel_arity::refuse_builtin_arity`),
/// only so that its message can name the binder; both read Excel's arity from
/// ONE rule, `crate::excel_arity::excel_refuses_arity` -- never the catalog's
/// syntax strings alone, which understate `GCD`, `MAP`, `BYROW`, `INDEX`,
/// `SUMIFS`, `IFS`, `SORTBY`, `GETPIVOTDATA` (see the xlsx export's live table).
fn refuse_shadowed_builtin_arity(expr: &Expression, bound: &mut Vec<String>) -> ParseResult<()> {
    match expr {
        Expression::FunctionCall { func: BuiltinFunction::Let, args, .. } if args.len() >= 3 => {
            let depth = bound.len();
            let last = args.len() - 1;
            let mut pending: Option<String> = None;
            let mut outcome = Ok(());
            for (i, arg) in args.iter().enumerate() {
                if i == last {
                    outcome = refuse_shadowed_builtin_arity(arg, bound);
                } else if i % 2 == 0 {
                    pending = match arg {
                        Expression::NamedRef { name, .. } => Some(name.to_ascii_uppercase()),
                        _ => None,
                    };
                } else {
                    outcome = refuse_shadowed_builtin_arity(arg, bound);
                    bound.extend(pending.take());
                }
                if outcome.is_err() {
                    break;
                }
            }
            bound.truncate(depth);
            outcome
        }
        Expression::FunctionCall { func: BuiltinFunction::Lambda, args, .. } if !args.is_empty() => {
            let depth = bound.len();
            let last = args.len() - 1;
            for arg in &args[..last] {
                if let Expression::NamedRef { name, .. } = arg {
                    bound.push(name.to_ascii_uppercase());
                }
            }
            let outcome = refuse_shadowed_builtin_arity(&args[last], bound);
            bound.truncate(depth);
            outcome
        }
        Expression::FunctionCall { func, args, .. } => {
            // A Calcula-only builtin (LPAD, POW, ...) is no function of Excel's
            // to refuse at: a binder of its name takes the call over
            // (`yields_to_user_definitions`), so `=LET(POW,LAMBDA(x,x+1),POW(2))`
            // is that LAMBDA's call (lane formc).
            if !matches!(func, BuiltinFunction::Custom(_)) && !func.yields_to_user_definitions() {
                let name = func.to_canonical_name();
                if bound.iter().any(|b| b.eq_ignore_ascii_case(name)) {
                    if let Some((fewest, most)) = builtin_arity(name) {
                        let given = args.len();
                        if crate::excel_arity::excel_refuses_arity(name, given) {
                            let takes = match most {
                                Some(most) if most == fewest => format!("{}", fewest),
                                Some(most) => format!("{} to {}", fewest, most),
                                None => format!("at least {}", fewest),
                            };
                            return Err(ParseError::new(format!(
                                "{}() takes {} argument(s) and was given {}: a call named like a built-in function is that function, even beside a LET or LAMBDA name '{}'",
                                name, takes, given, name
                            )));
                        }
                    }
                }
            }
            for arg in args {
                refuse_shadowed_builtin_arity(arg, bound)?;
            }
            Ok(())
        }
        Expression::Range { start, end, .. } => {
            refuse_shadowed_builtin_arity(start, bound)?;
            refuse_shadowed_builtin_arity(end, bound)
        }
        Expression::BinaryOp { left, right, .. } => {
            refuse_shadowed_builtin_arity(left, bound)?;
            refuse_shadowed_builtin_arity(right, bound)
        }
        Expression::UnaryOp { operand, .. } | Expression::ImplicitIntersection { operand } => {
            refuse_shadowed_builtin_arity(operand, bound)
        }
        Expression::IndexAccess { target, index } => {
            refuse_shadowed_builtin_arity(target, bound)?;
            refuse_shadowed_builtin_arity(index, bound)
        }
        Expression::ArrayLiteral { rows } => {
            for elem in rows.iter().flatten() {
                refuse_shadowed_builtin_arity(elem, bound)?;
            }
            Ok(())
        }
        Expression::ListLiteral { elements } => {
            for elem in elements {
                refuse_shadowed_builtin_arity(elem, bound)?;
            }
            Ok(())
        }
        Expression::DictLiteral { entries } => {
            for (key, value) in entries {
                refuse_shadowed_builtin_arity(key, bound)?;
                refuse_shadowed_builtin_arity(value, bound)?;
            }
            Ok(())
        }
        Expression::SpillRef { cell, .. } => refuse_shadowed_builtin_arity(cell, bound),
        Expression::Sheet3DRef { reference, .. } => refuse_shadowed_builtin_arity(reference, bound),
        Expression::Literal(_)
        | Expression::CellRef { .. }
        | Expression::ColumnRef { .. }
        | Expression::RowRef { .. }
        | Expression::NamedRef { .. }
        | Expression::TableRef { .. } => Ok(()),
    }
}

/// INSIDE A LET OR A LAMBDA, A BARE `B:B` WHOSE LETTERS ARE A PARAMETER'S NAME
/// IS THAT PARAMETER'S RANGE, NOT THE COLUMN -- Excel reads the `:` as the
/// range operator between two names. [LIVE, Excel 16, round 18, COM:
/// `=LET(b,2,SUM(B:B)*b)` shows #VALUE! and is stored `SUM(b:b)`;
/// `=LET(b,A1:A3,SUM(B:B))` is 60 (A1:A3); `=LET(b,2,SUM(B:D))` is #NAME? (once
/// the first letter is a name the other is a name too, and no name D exists); `=LAMBDA(b,SUM(B:B))(2)`
/// is #VALUE!; `$B:$B`, `Sheet1!B:B`, and `B:B` under `LET(x,..)` stay the
/// column (12).] Calcula's lexer reads `B:B` as a column whatever binds `b`,
/// so the same text summed column B. Rewritten here, once, at parse time --
/// the same point Excel decides it (its file spelling is `_xlpm.b:_xlpm.b`) --
/// into `Range { NamedRef, NamedRef }`, which the evaluator resolves against
/// the binding (`Evaluator::eval_bound_name_range`) and which carries no
/// column-B dependency, as Excel's carries none. `bound` holds the uppercased
/// parameter names in scope; a LET value sees only the names bound before it.
///
/// ONLY THE FIRST HALF DECIDES. [LIVE, Excel 16, round 19/20: with A1:C5 =
/// 1..5, 10..50, 100..500, `=LET(b,2,SUM(A:B))` is 165 and
/// `=LET(c,2,SUM(A:C)*c)` is 3330 -- columns, though the SECOND half names a
/// parameter -- while `=LET(a,1,SUM(A:D)+a)` is #NAME? (stored `a:D`).] Excel
/// reads the first letters as a name only when a binder names them, and then
/// reads the second half as a name as well (or, for a bare `C` / `R`, as R1C1's
/// own column / row -- see `Evaluator::eval_bound_name_range`).
pub(crate) fn bind_parameter_column_ranges(expr: &mut Expression, bound: &mut Vec<String>) {
    let is_bound = |bound: &[String], letters: &str| bound.iter().any(|b| b.eq_ignore_ascii_case(letters));
    match expr {
        Expression::ColumnRef { sheet: None, start_col, end_col, start_absolute: false, end_absolute: false, .. }
            if is_bound(bound, start_col) =>
        {
            let start = std::mem::take(start_col);
            let end = std::mem::take(end_col);
            *expr = Expression::Range {
                sheet: None,
                start: Box::new(Expression::NamedRef { name: start, ref_site_id: Default::default() }),
                end: Box::new(Expression::NamedRef { name: end, ref_site_id: Default::default() }),
                ref_site_id: Default::default(),
            };
        }
        Expression::FunctionCall { func: BuiltinFunction::Let, args, .. } if args.len() >= 3 => {
            let depth = bound.len();
            let last = args.len() - 1;
            let mut pending: Option<String> = None;
            for (i, arg) in args.iter_mut().enumerate() {
                if i == last {
                    bind_parameter_column_ranges(arg, bound);
                } else if i % 2 == 0 {
                    // The name slot. It is bound for every LATER value and the
                    // calculation -- not for its own value.
                    pending = match arg {
                        Expression::NamedRef { name, .. } => Some(name.to_ascii_uppercase()),
                        _ => None,
                    };
                } else {
                    bind_parameter_column_ranges(arg, bound);
                    bound.extend(pending.take());
                }
            }
            bound.truncate(depth);
        }
        Expression::FunctionCall { func: BuiltinFunction::Lambda, args, .. } if !args.is_empty() => {
            let depth = bound.len();
            let last = args.len() - 1;
            for arg in &args[..last] {
                if let Expression::NamedRef { name, .. } = arg {
                    bound.push(name.to_ascii_uppercase());
                }
            }
            bind_parameter_column_ranges(&mut args[last], bound);
            bound.truncate(depth);
        }
        Expression::FunctionCall { args, .. } => {
            for arg in args {
                bind_parameter_column_ranges(arg, bound);
            }
        }
        Expression::Range { start, end, .. } => {
            bind_parameter_column_ranges(start, bound);
            bind_parameter_column_ranges(end, bound);
        }
        Expression::BinaryOp { left, right, .. } => {
            bind_parameter_column_ranges(left, bound);
            bind_parameter_column_ranges(right, bound);
        }
        Expression::UnaryOp { operand, .. } | Expression::ImplicitIntersection { operand } => {
            bind_parameter_column_ranges(operand, bound);
        }
        Expression::IndexAccess { target, index } => {
            bind_parameter_column_ranges(target, bound);
            bind_parameter_column_ranges(index, bound);
        }
        Expression::ArrayLiteral { rows } => {
            for elem in rows.iter_mut().flatten() {
                bind_parameter_column_ranges(elem, bound);
            }
        }
        Expression::ListLiteral { elements } => {
            for elem in elements {
                bind_parameter_column_ranges(elem, bound);
            }
        }
        Expression::DictLiteral { entries } => {
            for (key, value) in entries {
                bind_parameter_column_ranges(key, bound);
                bind_parameter_column_ranges(value, bound);
            }
        }
        Expression::SpillRef { cell, .. } => bind_parameter_column_ranges(cell, bound),
        // A 3D span's inner reference is qualified by its sheets: never a name.
        Expression::Literal(_)
        | Expression::CellRef { .. }
        | Expression::ColumnRef { .. }
        | Expression::RowRef { .. }
        | Expression::NamedRef { .. }
        | Expression::Sheet3DRef { .. }
        | Expression::TableRef { .. } => {}
    }
}

/// Replaces every bare name in `expr` that no LET name or LAMBDA parameter of
/// the formula binds where it stands, and that `replace` has a tree for.
/// Returns whether anything was replaced. Binder slots are never offered, a
/// LET name binds from the value after its own onwards, and a binding is
/// matched by the per-character fold (`identity::sheet_name_key`) the
/// evaluator looks bindings up by. The cell of a spill reference (`a#`) is
/// left to `bind_spill_anchor_names`.
///
/// The host's bare-table rule (NEW-bare-table-name) is the caller: a bare
/// `Tbl` naming a table is the whole table, `=LET(Tbl,5,Tbl)` is 5 [LIVE,
/// Excel 16, lane namese, SCRATCH/namese/p1.txt].
pub fn replace_unbound_names(expr: &mut Expression, replace: &dyn Fn(&str) -> Option<Expression>) -> bool {
    replace_unbound_walk(expr, replace, &mut Vec::new())
}

/// Whether [`replace_unbound_names`] would replace anything: a read-only gate.
pub fn any_unbound_name(expr: &Expression, wanted: &dyn Fn(&str) -> bool) -> bool {
    fn walk(expr: &Expression, wanted: &dyn Fn(&str) -> bool, bound: &mut Vec<String>) -> bool {
        match expr {
            Expression::NamedRef { name, .. } => {
                !bound.contains(&identity::sheet_name_key(name)) && wanted(name)
            }
            Expression::SpillRef { .. } => false,
            Expression::FunctionCall { func: BuiltinFunction::Let, args, .. } if args.len() >= 3 && args.len() % 2 == 1 => {
                let depth = bound.len();
                let last = args.len() - 1;
                let mut hit = false;
                for (i, arg) in args.iter().enumerate() {
                    if i < last && i % 2 == 0 {
                        continue;
                    }
                    if walk(arg, wanted, bound) {
                        hit = true;
                        break;
                    }
                    if i < last {
                        if let Expression::NamedRef { name, .. } = &args[i - 1] {
                            bound.push(identity::sheet_name_key(name));
                        }
                    }
                }
                bound.truncate(depth);
                hit
            }
            Expression::FunctionCall { func: BuiltinFunction::Lambda, args, .. } if !args.is_empty() => {
                let depth = bound.len();
                let last = args.len() - 1;
                for p in &args[..last] {
                    if let Expression::NamedRef { name, .. } = p {
                        bound.push(identity::sheet_name_key(name));
                    }
                }
                let hit = walk(&args[last], wanted, bound);
                bound.truncate(depth);
                hit
            }
            other => sub_expressions(other).into_iter().any(|sub| walk(sub, wanted, bound)),
        }
    }
    walk(expr, wanted, &mut Vec::new())
}

fn replace_unbound_walk(expr: &mut Expression, replace: &dyn Fn(&str) -> Option<Expression>, bound: &mut Vec<String>) -> bool {
    match expr {
        Expression::NamedRef { name, .. } => {
            if bound.contains(&identity::sheet_name_key(name)) {
                return false;
            }
            match replace(name) {
                Some(tree) => {
                    *expr = tree;
                    true
                }
                None => false,
            }
        }
        Expression::FunctionCall { func: BuiltinFunction::Let, args, .. } if args.len() >= 3 && args.len() % 2 == 1 => {
            let depth = bound.len();
            let last = args.len() - 1;
            let mut changed = false;
            let mut pending: Option<String> = None;
            for (i, arg) in args.iter_mut().enumerate() {
                if i < last && i % 2 == 0 {
                    pending = match arg {
                        Expression::NamedRef { name, .. } => Some(identity::sheet_name_key(name)),
                        _ => None,
                    };
                    continue;
                }
                changed |= replace_unbound_walk(arg, replace, bound);
                if i < last {
                    bound.extend(pending.take());
                }
            }
            bound.truncate(depth);
            changed
        }
        Expression::FunctionCall { func: BuiltinFunction::Lambda, args, .. } if !args.is_empty() => {
            let depth = bound.len();
            let last = args.len() - 1;
            for p in &args[..last] {
                if let Expression::NamedRef { name, .. } = p {
                    bound.push(identity::sheet_name_key(name));
                }
            }
            let changed = replace_unbound_walk(&mut args[last], replace, bound);
            bound.truncate(depth);
            changed
        }
        Expression::FunctionCall { args, .. } => {
            let mut changed = false;
            for arg in args {
                changed |= replace_unbound_walk(arg, replace, bound);
            }
            changed
        }
        Expression::Range { start, end, .. } => {
            let a = replace_unbound_walk(start, replace, bound);
            let b = replace_unbound_walk(end, replace, bound);
            a || b
        }
        Expression::BinaryOp { left, right, .. } => {
            let a = replace_unbound_walk(left, replace, bound);
            let b = replace_unbound_walk(right, replace, bound);
            a || b
        }
        Expression::UnaryOp { operand, .. } | Expression::ImplicitIntersection { operand } => {
            replace_unbound_walk(operand, replace, bound)
        }
        Expression::IndexAccess { target, index } => {
            let a = replace_unbound_walk(target, replace, bound);
            let b = replace_unbound_walk(index, replace, bound);
            a || b
        }
        Expression::ArrayLiteral { rows } => {
            let mut changed = false;
            for elem in rows.iter_mut().flatten() {
                changed |= replace_unbound_walk(elem, replace, bound);
            }
            changed
        }
        Expression::ListLiteral { elements } => {
            let mut changed = false;
            for elem in elements {
                changed |= replace_unbound_walk(elem, replace, bound);
            }
            changed
        }
        Expression::DictLiteral { entries } => {
            let mut changed = false;
            for (key, value) in entries {
                changed |= replace_unbound_walk(key, replace, bound);
                changed |= replace_unbound_walk(value, replace, bound);
            }
            changed
        }
        // A 3D span's inner reference is qualified by its sheets: never a name.
        Expression::SpillRef { .. }
        | Expression::Sheet3DRef { .. }
        | Expression::Literal(_)
        | Expression::CellRef { .. }
        | Expression::ColumnRef { .. }
        | Expression::RowRef { .. }
        | Expression::TableRef { .. } => false,
    }
}

/// A DEFINED NAME'S RELATIVE REFERENCES ARE OFFSETS FROM A1, applied at the
/// cell that USES the name (lane formd, NEW-relative-name-anchor). Rewrites
/// `expr` -- a name's `refers_to`, in the A1-relative form Excel writes to
/// the file -- into what it means at (`row`, `col`), 0-based: every relative
/// row moves down by `row` and every relative column right by `col`, wrapping
/// round the sheet as Excel's offsets do; an absolute part stays.
///
/// [LIVE, Excel 16, lane formd, SCRATCH/formd/names.ps1 -> n1.txt]
/// `Names.Add("rel","=Sheet1!A1")` is saved `<definedName name="rel">Sheet1!A1`,
/// its R1C1 text is `=Sheet1!RC` -- the cell it is USED in -- and it reads back
/// `=Sheet1!J10` with J10 active: `=ROW(rel)*1000+COLUMN(rel)` in J11 is 11010,
/// `=rel` in J10 0 (circular), `relmix` `=Sheet1!$A1` in J12 1201 ($A12),
/// `relrng` `Sheet1!A1:B2` is J14:K15 from J14 and `SUM(Sheet1!A1:A2)` moves
/// alike; from another sheet the reference stays on Sheet1. Calcula spliced
/// the text as it stands, so `=Sheet1!A1` meant A1 from every cell -- and its
/// .xlsx export, carrying the same text, opened in Excel as the cell itself.
///
/// The host splices a name's tree into the formula that uses it
/// (`resolve_names_in_ast`); this is the step that tree needs before it is
/// spliced.
pub fn anchor_name_references(expr: &mut Expression, row: u32, col: u32) {
    const ROWS: u64 = 1_048_576;
    const COLS: u64 = 16_384;
    let wrap = |index: u32, by: u32, size: u64| -> u32 { ((u64::from(index.saturating_sub(1)) + u64::from(by)) % size + 1) as u32 };
    let letters = |n: u32| {
        let mut out = String::new();
        let mut n = n;
        while n > 0 {
            n -= 1;
            out.insert(0, (b'A' + (n % 26) as u8) as char);
            n /= 26;
        }
        out
    };
    let move_col = |c: &mut String| {
        let n = Parser::col_letters_to_number(c);
        if (1..=COLS as u32).contains(&n) {
            *c = letters(wrap(n, col, COLS));
        }
    };
    match expr {
        Expression::CellRef { col: c, row: r, col_absolute, row_absolute, .. } => {
            if !*row_absolute {
                *r = wrap(*r, row, ROWS);
            }
            if !*col_absolute {
                move_col(c);
            }
        }
        Expression::ColumnRef { start_col, end_col, start_absolute, end_absolute, .. } => {
            if !*start_absolute {
                move_col(start_col);
            }
            if !*end_absolute {
                move_col(end_col);
            }
        }
        Expression::RowRef { start_row, end_row, start_absolute, end_absolute, .. } => {
            if !*start_absolute {
                *start_row = wrap(*start_row, row, ROWS);
            }
            if !*end_absolute {
                *end_row = wrap(*end_row, row, ROWS);
            }
        }
        Expression::Range { start, end, .. } => {
            anchor_name_references(start, row, col);
            anchor_name_references(end, row, col);
        }
        Expression::Sheet3DRef { reference, .. } => anchor_name_references(reference, row, col),
        Expression::FunctionCall { args, .. } => {
            for arg in args {
                anchor_name_references(arg, row, col);
            }
        }
        Expression::BinaryOp { left, right, .. } => {
            anchor_name_references(left, row, col);
            anchor_name_references(right, row, col);
        }
        Expression::UnaryOp { operand, .. } | Expression::ImplicitIntersection { operand } => {
            anchor_name_references(operand, row, col);
        }
        Expression::IndexAccess { target, index } => {
            anchor_name_references(target, row, col);
            anchor_name_references(index, row, col);
        }
        Expression::ArrayLiteral { rows } => {
            for elem in rows.iter_mut().flatten() {
                anchor_name_references(elem, row, col);
            }
        }
        Expression::ListLiteral { elements } => {
            for elem in elements {
                anchor_name_references(elem, row, col);
            }
        }
        Expression::DictLiteral { entries } => {
            for (key, value) in entries {
                anchor_name_references(key, row, col);
                anchor_name_references(value, row, col);
            }
        }
        Expression::SpillRef { cell, .. } => anchor_name_references(cell, row, col),
        Expression::Literal(_) | Expression::NamedRef { .. } | Expression::TableRef { .. } => {}
    }
}

/// A BARE `C`, `R`, `RC`, `R2C` OR `R1C1` IS AN R1C1 REFERENCE IN EXCEL, EVEN
/// IN A1 MODE, relative to the cell the formula is entered in (BUG-0649).
///
/// [LIVE, Excel 16, parser lane probe, formulas typed into column J]
/// `=LET(a,1,a+C)` in J45 is stored `=LET(a,1,a+J:J)`, `=LET(a,1,a+R)` in J46
/// `=LET(a,1,a+46:46)`, `=C+1` `=J:J+1`, `=SUM(C)` `=SUM(J:J)`, `=R*0` in J52
/// `=52:52*0`, `=RC*0` in J53 `=J53*0`, `=R2C*0` `=J$2*0`, `=R1C1*0` `=$A$1*0`,
/// and `=LAMBDA(x,x+C)(1)` `=LAMBDA(x,x+J:J)(1)`. A LET name or LAMBDA
/// parameter of that spelling is the binding instead: `=LET(c,5,c+C)` is 10,
/// `=LET(C,1,C)` 1. Calcula read each as an undefined name (#NAME?).
///
/// The rewrite is Excel's own and happens where Excel's does, AT ENTRY: the
/// formula keeps the A1 reference from then on (it moves when copied, and the
/// formula bar shows it). `row` / `col` are the entry cell, 0-based.
/// `is_defined` names a workbook name the rewrite must leave alone: Excel
/// refuses to define these spellings, but a workbook may already hold one.
/// The halves of a range operator are left to `Evaluator::eval_bound_name_range`.
pub fn resolve_r1c1_names(expr: &mut Expression, row: u32, col: u32, is_defined: &dyn Fn(&str) -> bool) {
    r1c1_walk(expr, row, col, is_defined, &mut Vec::new());
}

/// The A1 reference an R1C1 name WITH A RELATIVE OFFSET (`R[-1]C4`, `RC[-6]`,
/// `C[1]`, `R[2]`, `R1C[2]`, `R[-1]C[-6]`) means at (row, col), 0-based: a
/// bracket is an offset from the entry cell, a number an absolute index,
/// nothing this row / column.
///
/// [LIVE] Excel 16 (lane formc, SCRATCH/formc/p1.json, p2.json, p3.json), in
/// A1 mode: `=R[-1]C4*1` in J254 is `=$D253*1`, `=RC[-6]*1` in J82 `=D82*1`,
/// `=SUM(C[-6])` `=SUM(D:D)`, `=SUM(R[-2]:R[-1])` in J94 `=SUM(92:93)`,
/// `=LET(A1,5,R1C[-6])` in J245 `=LET(A1,5,D$1)`. An offset WRAPS round the
/// sheet (`=ROW(R[-500]C)` in J444 is 1048520, `=COLUMN(RC[-20])` in J446
/// 16374) but must be smaller than the sheet (`R[-1048577]C`, `RC[16384]`
/// refused).
fn bracket_r1c1_reference(upper: &str, row: u32, col: u32) -> Option<Expression> {
    // (absolute, 1-based index) of one axis, or None when the axis is absent.
    fn axis<'s>(s: &'s str, letter: char, here: u32, size: i64) -> Option<(Option<(bool, u32)>, &'s str)> {
        let Some(after) = s.strip_prefix(letter) else { return Some((None, s)) };
        if let Some(inside) = after.strip_prefix('[') {
            let close = inside.find(']')?;
            let offset: i64 = inside[..close].trim_start_matches('+').parse().ok()?;
            if offset.abs() >= size {
                return None;
            }
            let index = (i64::from(here) + offset).rem_euclid(size) + 1;
            return Some((Some((false, index as u32)), &inside[close + 1..]));
        }
        let digits = after.chars().take_while(char::is_ascii_digit).count();
        if digits == 0 {
            return Some((Some((false, here + 1)), after));
        }
        let index: i64 = after[..digits].parse().ok()?;
        if !(1..=size).contains(&index) {
            return None;
        }
        Some((Some((true, index as u32)), &after[digits..]))
    }
    if !upper.contains('[') {
        return None;
    }
    let (r, rest) = axis(upper, 'R', row, 1_048_576)?;
    let (c, rest) = axis(rest, 'C', col, 16_384)?;
    if !rest.is_empty() {
        return None;
    }
    let letters = |c: u32| {
        let mut out = String::new();
        let mut n = c;
        while n > 0 {
            n -= 1;
            out.insert(0, (b'A' + (n % 26) as u8) as char);
            n /= 26;
        }
        out
    };
    match (r, c) {
        (Some((row_absolute, r)), Some((col_absolute, c))) => Some(Expression::CellRef {
            sheet: None,
            col: letters(c),
            row: r,
            col_absolute,
            row_absolute,
            ref_site_id: RefSiteId::ZERO,
        }),
        (Some((absolute, r)), None) => Some(Expression::RowRef {
            sheet: None,
            start_row: r,
            end_row: r,
            start_absolute: absolute,
            end_absolute: absolute,
            ref_site_id: RefSiteId::ZERO,
        }),
        (None, Some((absolute, c))) => Some(Expression::ColumnRef {
            sheet: None,
            start_col: letters(c),
            end_col: letters(c),
            start_absolute: absolute,
            end_absolute: absolute,
            ref_site_id: RefSiteId::ZERO,
        }),
        (None, None) => None,
    }
}

/// The A1 reference an R1C1-shaped bare name means at (row, col), 0-based.
fn r1c1_reference(name: &str, row: u32, col: u32) -> Option<Expression> {
    let upper = name.to_ascii_uppercase();
    if upper.contains('[') {
        return bracket_r1c1_reference(&upper, row, col);
    }
    let letters = |c: u32| {
        let mut out = String::new();
        let mut n = c + 1;
        while n > 0 {
            n -= 1;
            out.insert(0, (b'A' + (n % 26) as u8) as char);
            n /= 26;
        }
        out
    };
    let cell = |c: u32, r: u32, col_absolute: bool, row_absolute: bool| Expression::CellRef {
        sheet: None,
        col: letters(c),
        row: r,
        col_absolute,
        row_absolute,
        ref_site_id: RefSiteId::ZERO,
    };
    match upper.as_str() {
        "C" => {
            return Some(Expression::ColumnRef {
                sheet: None,
                start_col: letters(col),
                end_col: letters(col),
                start_absolute: false,
                end_absolute: false,
                ref_site_id: RefSiteId::ZERO,
            })
        }
        "R" => {
            return Some(Expression::RowRef {
                sheet: None,
                start_row: row + 1,
                end_row: row + 1,
                start_absolute: false,
                end_absolute: false,
                ref_site_id: RefSiteId::ZERO,
            })
        }
        "RC" => return Some(cell(col, row + 1, false, false)),
        _ => {}
    }
    // `R<n>`, `C<n>` and `RC<n>`: row n, column n, and column n of this row.
    // The A1 lexer reads each of these as a CELL (column R / C / RC), so a
    // name of this spelling exists only in a formula read in R1C1, which
    // `apply_r1c1_fallback` made a name ([LIVE, Excel 16, lane legacystats]
    // `=LET(A1,5,SUM(C4))` is the sum of $D:$D, `=LET(A1,5,SUM(R2))` of
    // $2:$2, `=LET(A1,5,RC4)` in J27 is $D27).
    let number_after = |prefix: &str| -> Option<u32> {
        let digits = upper.strip_prefix(prefix)?;
        (!digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())).then(|| digits.parse().ok()).flatten()
    };
    if let Some(c) = number_after("RC") {
        return (1..=16_384).contains(&c).then(|| cell(c - 1, row + 1, true, false));
    }
    if let Some(r) = number_after("R") {
        return (1..=1_048_576).contains(&r).then(|| Expression::RowRef {
            sheet: None,
            start_row: r,
            end_row: r,
            start_absolute: true,
            end_absolute: true,
            ref_site_id: RefSiteId::ZERO,
        });
    }
    if let Some(c) = number_after("C") {
        return (1..=16_384).contains(&c).then(|| Expression::ColumnRef {
            sheet: None,
            start_col: letters(c - 1),
            end_col: letters(c - 1),
            start_absolute: true,
            end_absolute: true,
            ref_site_id: RefSiteId::ZERO,
        });
    }
    // `R<n>C` and `R<n>C<m>`: absolute row, and an absolute column when given.
    let rest = upper.strip_prefix('R')?;
    let digits = rest.chars().take_while(char::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let r: u32 = rest[..digits].parse().ok()?;
    let after = rest[digits..].strip_prefix('C')?;
    if !(1..=1_048_576).contains(&r) {
        return None;
    }
    if after.is_empty() {
        return Some(cell(col, r, false, true));
    }
    if !after.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let c: u32 = after.parse().ok()?;
    if !(1..=16_384).contains(&c) {
        return None;
    }
    Some(cell(c - 1, r, true, true))
}

fn r1c1_walk(expr: &mut Expression, row: u32, col: u32, is_defined: &dyn Fn(&str) -> bool, bound: &mut Vec<String>) {
    match expr {
        Expression::NamedRef { name, .. } => {
            if bound.iter().any(|b| b.eq_ignore_ascii_case(name)) || is_defined(name) {
                return;
            }
            if let Some(reference) = r1c1_reference(name, row, col) {
                *expr = reference;
            }
        }
        Expression::FunctionCall { func: BuiltinFunction::Let, args, .. } if args.len() >= 3 => {
            let depth = bound.len();
            let last = args.len() - 1;
            let mut pending: Option<String> = None;
            for (i, arg) in args.iter_mut().enumerate() {
                if i == last {
                    r1c1_walk(arg, row, col, is_defined, bound);
                } else if i % 2 == 0 {
                    pending = match arg {
                        Expression::NamedRef { name, .. } => Some(name.clone()),
                        _ => None,
                    };
                } else {
                    r1c1_walk(arg, row, col, is_defined, bound);
                    bound.extend(pending.take());
                }
            }
            bound.truncate(depth);
        }
        Expression::FunctionCall { func: BuiltinFunction::Lambda, args, .. } if !args.is_empty() => {
            let depth = bound.len();
            let last = args.len() - 1;
            for arg in &args[..last] {
                if let Expression::NamedRef { name, .. } = arg {
                    bound.push(name.clone());
                }
            }
            r1c1_walk(&mut args[last], row, col, is_defined, bound);
            bound.truncate(depth);
        }
        Expression::FunctionCall { args, .. } => {
            for arg in args {
                r1c1_walk(arg, row, col, is_defined, bound);
            }
        }
        // `a:C` is the range operator between two NAMES; its second half is
        // R1C1's line only at evaluation (`eval_bound_name_range`). Two halves
        // that are BOTH R1C1 references no binder names are the reference they
        // span ([LIVE, Excel 16, lane legacystats] `=SUM(R1C4:R2C4)` is
        // `SUM($D$1:$D$2)` = 30, `=LET(A1,5,SUM(C4:C5))` `SUM($D:$E)`,
        // `=LET(A1,5,SUM(R1:R2))` `SUM($1:$2)`); with one name half
        // (`R1C4:D2`) Excel's answer is the name's #NAME?, which the range of
        // names already gives.
        Expression::Range { sheet, start, end, .. } => {
            let resolvable = |half: &Expression| match half {
                Expression::NamedRef { name, .. } => {
                    if bound.iter().any(|b| b.eq_ignore_ascii_case(name)) || is_defined(name) {
                        None
                    } else {
                        r1c1_reference(name, row, col)
                    }
                }
                _ => None,
            };
            if let (Some(a), Some(b)) = (resolvable(start.as_ref()), resolvable(end.as_ref())) {
                let sheet = sheet.take();
                *expr = match (a, b) {
                    (
                        Expression::ColumnRef { start_col, start_absolute, .. },
                        Expression::ColumnRef { end_col, end_absolute, .. },
                    ) => Expression::ColumnRef { sheet, start_col, end_col, start_absolute, end_absolute, ref_site_id: RefSiteId::ZERO },
                    (
                        Expression::RowRef { start_row, start_absolute, .. },
                        Expression::RowRef { end_row, end_absolute, .. },
                    ) => Expression::RowRef { sheet, start_row, end_row, start_absolute, end_absolute, ref_site_id: RefSiteId::ZERO },
                    // `Sheet2!RC` is held as the range of the R1C1 name with
                    // itself (`Parser::parse_qualified_r1c1`); one cell is
                    // that cell, on that sheet.
                    (
                        Expression::CellRef { col, row, col_absolute, row_absolute, .. },
                        Expression::CellRef { col: end_col, row: end_row, col_absolute: end_ca, row_absolute: end_ra, .. },
                    ) if sheet.is_some() && col == end_col && row == end_row && col_absolute == end_ca && row_absolute == end_ra => {
                        Expression::CellRef { sheet, col, row, col_absolute, row_absolute, ref_site_id: RefSiteId::ZERO }
                    }
                    (a, b) => Expression::Range { sheet, start: Box::new(a), end: Box::new(b), ref_site_id: RefSiteId::ZERO },
                };
                return;
            }
            // One half an R1C1 CELL (`R[-1]C`, `R1C4`) beside a name is that
            // cell, as Excel shows it (BUG-0739 [LIVE, lane formd p1/p2:
            // `=SUM(R[-1]C:D5)` is `=SUM(J881:'D5')`, `=SUM(R[-1]C4:D5)`
            // `=SUM($D1961:'D5')`]); a bare `C` / `R` half stays the name
            // half `a:C` evaluation reads as R1C1's line.
            for half in [start.as_mut(), end.as_mut()] {
                match half {
                    Expression::NamedRef { name, .. } => {
                        if !bound.iter().any(|b| b.eq_ignore_ascii_case(name)) && !is_defined(name) {
                            if let Some(cell @ Expression::CellRef { .. }) = r1c1_reference(name, row, col) {
                                *half = cell;
                            }
                        }
                    }
                    _ => r1c1_walk(half, row, col, is_defined, bound),
                }
            }
        }
        Expression::BinaryOp { left, right, .. } => {
            r1c1_walk(left, row, col, is_defined, bound);
            r1c1_walk(right, row, col, is_defined, bound);
        }
        Expression::UnaryOp { operand, .. } | Expression::ImplicitIntersection { operand } => {
            r1c1_walk(operand, row, col, is_defined, bound);
        }
        // R1C1's RELATIVE offsets (`C[1]`, `RC[-1]`, `R[-1]C4`) are one
        // identifier each (lexer, lane formc) and resolve in the `NamedRef`
        // arm; an index after a name is Calcula's own list subscript, and
        // rewriting the target alone would make it index into a column.
        Expression::IndexAccess { target, index } => {
            if !matches!(target.as_ref(), Expression::NamedRef { .. }) {
                r1c1_walk(target, row, col, is_defined, bound);
            }
            r1c1_walk(index, row, col, is_defined, bound);
        }
        Expression::ArrayLiteral { rows } => {
            for elem in rows.iter_mut().flatten() {
                r1c1_walk(elem, row, col, is_defined, bound);
            }
        }
        Expression::ListLiteral { elements } => {
            for elem in elements {
                r1c1_walk(elem, row, col, is_defined, bound);
            }
        }
        Expression::DictLiteral { entries } => {
            for (key, value) in entries {
                r1c1_walk(key, row, col, is_defined, bound);
                r1c1_walk(value, row, col, is_defined, bound);
            }
        }
        // `Sheet1:Sheet2!RC`: the R1C1 reference inside a 3-D span (lane
        // formd; [LIVE] `=SUM(Sheet1:Sheet2!RC)` in J2018 is
        // `SUM(Sheet1:Sheet2!J2018)`, `..!R1C1` `..!$A$1`).
        Expression::Sheet3DRef { reference, .. } => {
            r1c1_walk(reference, row, col, is_defined, bound);
            if let Expression::Range { sheet: None, start, end, .. } = reference.as_ref() {
                if matches!(start.as_ref(), Expression::CellRef { .. }) && start == end {
                    let one = start.as_ref().clone();
                    **reference = one;
                }
            }
        }
        // `name#` spills a name; an R1C1 name there is not Excel's spelling.
        Expression::SpillRef { .. }
        | Expression::Literal(_)
        | Expression::CellRef { .. }
        | Expression::ColumnRef { .. }
        | Expression::RowRef { .. }
        | Expression::TableRef { .. } => {}
    }
}

/// `a#` WHERE `a` IS BOUND TO A CELL IS THAT CELL's SPILL (BUG-0646).
///
/// [LIVE, Excel 16, parser lane probe, E5 = `=SEQUENCE(3)`]
/// `=LET(a,E5,SUM(a#))` is 6, `=LET(a,E5,ROWS(a#))` 3 and
/// `=LAMBDA(a,ROWS(a#))(E5)` 3, while `=LET(a,SEQUENCE(3),SUM(a#))` is
/// #VALUE!. The spill map lives in the host, which resolves `E5#` against it
/// before evaluation (`resolve_spill_refs_in_ast`); a NAME half is invisible to
/// that pass. So the host calls this first, on the tree it is about to
/// evaluate (never the stored one, which keeps `a#` as typed): every `name#`
/// whose LET name, or whose parameter of a LAMBDA invoked right there, is
/// bound to a plain cell reference becomes `cell#`. A name bound to anything
/// else is left for the evaluator, which answers #VALUE! / #NAME?.
pub fn bind_spill_anchor_names(expr: &mut Expression) {
    spill_anchor_walk(expr, &mut Vec::new());
}

/// The cell a LET value or LAMBDA argument IS, if it is one: a cell reference,
/// or a name already bound to one.
fn spill_anchor_of(expr: &Expression, scope: &[(String, Option<Expression>)]) -> Option<Expression> {
    match expr {
        Expression::CellRef { .. } => Some(expr.clone()),
        Expression::NamedRef { name, .. } => {
            let key = name.to_ascii_uppercase();
            scope.iter().rev().find(|(n, _)| *n == key).and_then(|(_, cell)| cell.clone())
        }
        _ => None,
    }
}

fn spill_anchor_walk(expr: &mut Expression, scope: &mut Vec<(String, Option<Expression>)>) {
    match expr {
        Expression::SpillRef { cell, .. } => {
            if let Expression::NamedRef { .. } = cell.as_ref() {
                if let Some(anchor) = spill_anchor_of(cell, scope) {
                    **cell = anchor;
                }
            } else {
                spill_anchor_walk(cell, scope);
            }
        }
        Expression::FunctionCall { func: BuiltinFunction::Let, args, .. } if args.len() >= 3 => {
            let depth = scope.len();
            let last = args.len() - 1;
            let mut pending: Option<String> = None;
            for (i, arg) in args.iter_mut().enumerate() {
                if i == last {
                    spill_anchor_walk(arg, scope);
                } else if i % 2 == 0 {
                    pending = match arg {
                        Expression::NamedRef { name, .. } => Some(name.to_ascii_uppercase()),
                        _ => None,
                    };
                } else {
                    spill_anchor_walk(arg, scope);
                    if let Some(name) = pending.take() {
                        let anchor = spill_anchor_of(arg, scope);
                        scope.push((name, anchor));
                    }
                }
            }
            scope.truncate(depth);
        }
        // A LAMBDA on its own: its parameters hide any outer binding.
        Expression::FunctionCall { func: BuiltinFunction::Lambda, args, .. } if !args.is_empty() => {
            lambda_walk(args, &[], scope);
        }
        // `LAMBDA(..)(args)` and a named one's `__INVOKE__("F", lambda, args)`:
        // each parameter is bound to its argument.
        Expression::FunctionCall { func: BuiltinFunction::Custom(name), args, .. } if name == "__INVOKE__" => {
            let lambda_at = args.iter().take(2).position(|a| {
                matches!(a, Expression::FunctionCall { func: BuiltinFunction::Lambda, args, .. } if !args.is_empty())
            });
            match lambda_at {
                Some(at) => {
                    let (head, call_args) = args.split_at_mut(at + 1);
                    for arg in call_args.iter_mut() {
                        spill_anchor_walk(arg, scope);
                    }
                    let anchors: Vec<Option<Expression>> = call_args.iter().map(|a| spill_anchor_of(a, scope)).collect();
                    if let Expression::FunctionCall { args: lambda_args, .. } = &mut head[at] {
                        lambda_walk(lambda_args, &anchors, scope);
                    }
                }
                None => {
                    for arg in args.iter_mut() {
                        spill_anchor_walk(arg, scope);
                    }
                }
            }
        }
        Expression::FunctionCall { args, .. } => {
            for arg in args {
                spill_anchor_walk(arg, scope);
            }
        }
        Expression::Range { start, end, .. } => {
            spill_anchor_walk(start, scope);
            spill_anchor_walk(end, scope);
        }
        Expression::BinaryOp { left, right, .. } => {
            spill_anchor_walk(left, scope);
            spill_anchor_walk(right, scope);
        }
        Expression::UnaryOp { operand, .. } | Expression::ImplicitIntersection { operand } => {
            spill_anchor_walk(operand, scope);
        }
        Expression::IndexAccess { target, index } => {
            spill_anchor_walk(target, scope);
            spill_anchor_walk(index, scope);
        }
        Expression::ArrayLiteral { rows } => {
            for elem in rows.iter_mut().flatten() {
                spill_anchor_walk(elem, scope);
            }
        }
        Expression::ListLiteral { elements } => {
            for elem in elements {
                spill_anchor_walk(elem, scope);
            }
        }
        Expression::DictLiteral { entries } => {
            for (key, value) in entries {
                spill_anchor_walk(key, scope);
                spill_anchor_walk(value, scope);
            }
        }
        Expression::Sheet3DRef { reference, .. } => spill_anchor_walk(reference, scope),
        Expression::Literal(_)
        | Expression::CellRef { .. }
        | Expression::ColumnRef { .. }
        | Expression::RowRef { .. }
        | Expression::NamedRef { .. }
        | Expression::TableRef { .. } => {}
    }
}

/// A LAMBDA's parameters in scope over its body, the i-th bound to `anchors[i]`
/// (none: a parameter that merely hides an outer name).
fn lambda_walk(args: &mut [Expression], anchors: &[Option<Expression>], scope: &mut Vec<(String, Option<Expression>)>) {
    let depth = scope.len();
    let last = args.len() - 1;
    for (i, param) in args[..last].iter().enumerate() {
        if let Expression::NamedRef { name, .. } = param {
            scope.push((name.to_ascii_uppercase(), anchors.get(i).cloned().flatten()));
        }
    }
    spill_anchor_walk(&mut args[last], scope);
    scope.truncate(depth);
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
    // `Tbl[]` (or `Tbl[ ]`) is the WHOLE TABLE -- its data body, as the bare
    // name `Tbl` is: [LIVE, Excel 16, lane formd, SCRATCH/formd/p1.json, table
    // Tbl of 3 rows x 2 columns] `=ROWS(Tbl[])` 3, `=SUM(Tbl[])` 9,
    // `=COLUMNS(Tbl[])` 2, `=Tbl[]` and `=ABS(Tbl[])` spill 3x2, `=SUM(Tbl[ ])`
    // 9; Excel's file text keeps `Tbl[]`, its formula bar shows `Tbl`.
    // Calcula refused the empty brackets, so the typed formula was kept as
    // text. Held as `TableSpecifier::Whole` -- the region `[#Data]` reads, but
    // shown as the bare name and stored as `Tbl[]`, since Excel keeps
    // `Tbl[#Data]` as typed [LIVE, lane namese, SCRATCH/namese/p1.txt].
    if trimmed.is_empty() {
        return Ok(TableSpecifier::Whole);
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

    // SPECIAL ITEMS FIRST, then an optional column or column span: Excel's
    // `[[#Headers],[#Data]]`, `[[#Data],[#Totals],[p]]`, `[[#Headers],[p]:[q]]`
    // (BUG-0643). Every LEADING part that begins with an unescaped `#` is a
    // special item -- the second one included, which this reader used to take
    // as a column NAMED `#Data`.
    let leading_specials = inners
        .iter()
        .enumerate()
        .take_while(|(i, inner)| inner.trim_start().starts_with('#') && (*i == 0 || seps[i - 1] == ','))
        .count();
    if leading_specials >= 1 && (leading_specials >= 2 || inners.len() >= 3) {
        return parse_specials_then_columns(body, &inners, &seps, leading_specials);
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

/// A nested specifier that opens with special items: one or two of them, then
/// nothing, one column, or one `[a]:[b]` span (see `parse_nested_specifier`).
///
/// [LIVE, Excel 16, parser lane probe] the two pairs Excel accepts are
/// `#Headers`+`#Data` and `#Data`+`#Totals`, in either order (it stores the
/// pair in that order); `[[#Headers],[#Totals]]` and `[[#All],[#Data]]` are
/// refused at entry, so they are refused here. `#This Row` before a column or
/// span is the this-row form, as in `parse_nested_specifier`.
fn parse_specials_then_columns(
    body: &str,
    inners: &[String],
    seps: &[char],
    specials: usize,
) -> ParseResult<TableSpecifier> {
    let unsupported = || ParseError::new(format!("Unsupported structured reference: [{}]", body));
    let mut items = Vec::with_capacity(specials);
    for inner in &inners[..specials] {
        items.push(parse_special_region(&inner.trim()[1..])?);
    }
    let region = match items.as_slice() {
        [one] => one.clone(),
        [a, b] => match (a, b) {
            (TableSpecifier::Headers, TableSpecifier::DataRows)
            | (TableSpecifier::DataRows, TableSpecifier::Headers) => TableSpecifier::HeadersAndData,
            (TableSpecifier::DataRows, TableSpecifier::Totals)
            | (TableSpecifier::Totals, TableSpecifier::DataRows) => TableSpecifier::DataAndTotals,
            _ => {
                return Err(ParseError::new(format!(
                    "These special items cannot be combined in one structured reference: [{}]",
                    body
                )))
            }
        },
        _ => return Err(unsupported()),
    };
    let this_row = matches!(&region, TableSpecifier::ThisRow(name) if name.is_empty());
    let columns = &inners[specials..];
    let column_seps = &seps[specials.saturating_sub(1)..];
    match (columns.len(), column_seps) {
        (0, _) => Ok(region),
        (1, [',']) => {
            let col = column_name(columns[0].trim())?;
            if this_row {
                return Ok(TableSpecifier::ThisRow(col));
            }
            Ok(TableSpecifier::SpecialColumn(Box::new(region), col))
        }
        (2, [',', ':']) => {
            let a = strip_this_row_marker(&columns[0])?;
            let b = strip_this_row_marker(&columns[1])?;
            if this_row {
                return Ok(TableSpecifier::ThisRowRange(a, b));
            }
            Ok(TableSpecifier::SpecialColumnRange(Box::new(region), a, b))
        }
        _ => Err(unsupported()),
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

    /// NEW-relative-name-anchor [LIVE, Excel 16, lane formd n1.txt]: a name's
    /// relative reference is an offset from A1, taken at the cell that uses it.
    #[test]
    fn a_names_relative_references_are_taken_at_the_using_cell() {
        let at = |refers_to: &str, row: u32, col: u32| {
            let mut ast = parse(refers_to).expect("parses");
            anchor_name_references(&mut ast, row, col);
            ast
        };
        // `rel` = Sheet1!A1 (R1C1 `RC`): the using cell itself; from J11
        // ROW*1000+COLUMN is 11010.
        assert_eq!(at("=Sheet1!A1", 9, 9), parse("=Sheet1!J10").unwrap());
        assert_eq!(at("=Sheet1!A1", 10, 9), parse("=Sheet1!J11").unwrap());
        // `relmix` = Sheet1!$A1 from J12 is $A12 (1201).
        assert_eq!(at("=Sheet1!$A1", 11, 9), parse("=Sheet1!$A12").unwrap());
        // `relrng` from J14 is J14:K15, `relsum` moves inside its function.
        assert_eq!(at("=Sheet1!A1:B2", 13, 9), parse("=Sheet1!J14:K15").unwrap());
        assert_eq!(at("=SUM(Sheet1!A1:A2)", 14, 9), parse("=SUM(Sheet1!J15:J16)").unwrap());
        // Absolute parts stay; whole columns and rows move on their own axis.
        assert_eq!(at("=Sheet1!$B$3", 40, 40), parse("=Sheet1!$B$3").unwrap());
        assert_eq!(at("=SUM(Sheet1!A:A)", 7, 9), parse("=SUM(Sheet1!J:J)").unwrap());
        assert_eq!(at("=SUM(Sheet1!1:1)", 4, 9), parse("=SUM(Sheet1!5:5)").unwrap());
        // An offset WRAPS round the sheet: XFD1048576 is "one up, one left".
        assert_eq!(at("=Sheet1!XFD1048576", 1, 1), parse("=Sheet1!A1").unwrap());
        assert_eq!(at("=Sheet1!XFD1048576", 0, 0), parse("=Sheet1!XFD1048576").unwrap());
    }

    /// W2 (names lane): `Sheet1!C$3` and `Sheet1!R$3` are A1 cells with an
    /// absolute row [LIVE, Excel 16, lane formfix p1.json: 300 and 0]; they
    /// failed with 'Unexpected token after expression: Dollar' because `C` /
    /// `R` were taken as R1C1 first. BUG-0744/0749: `Sheet1!Dup` is Sheet1's
    /// NAME Dup [LIVE: on Sheet2 `=Sheet1!Dup` is 2].
    #[test]
    fn a_qualified_mixed_reference_on_c_or_r_and_a_qualified_name_parse() {
        let cell = |f: &str| match parse(f).unwrap_or_else(|e| panic!("{f} must parse: {e}")) {
            Expression::CellRef { sheet, col, row, col_absolute, row_absolute, .. } => {
                (sheet.unwrap_or_default().to_ascii_uppercase(), col, row, col_absolute, row_absolute)
            }
            other => panic!("{f} is no cell: {other:?}"),
        };
        assert_eq!(cell("=Sheet1!C$3"), ("SHEET1".to_string(), "C".to_string(), 3, false, true));
        assert_eq!(cell("=Sheet1!R$3"), ("SHEET1".to_string(), "R".to_string(), 3, false, true));
        assert_eq!(cell("='My Sheet'!C$3"), ("MY SHEET".to_string(), "C".to_string(), 3, false, true));
        for f in ["=SUM(Sheet1!C$1:C$3)", "=SUM(Sheet1!R$1:R$3)", "=SUM(Sheet1:Sheet2!C$3)", "=Sheet1!C$3+1"] {
            assert!(parse(f).is_ok(), "{f} must parse");
        }
        // The R1C1 spellings behind a sheet are still R1C1.
        for f in ["=Sheet1!RC", "=Sheet1!C", "=SUM(Sheet1!R)", "=Sheet1!R1C1"] {
            assert!(parse(f).is_ok(), "{f} must still parse");
        }
        // A qualified NAME, with the sheet it is read in.
        for (f, sheet, name) in [
            ("=Sheet1!Dup", "SHEET1", "DUP"),
            ("='Sheet 2'!Rate_1", "SHEET 2", "RATE_1"),
            ("=Sheet1!my.name", "SHEET1", "MY.NAME"),
        ] {
            let ast = parse(f).unwrap_or_else(|e| panic!("{f} must parse: {e}"));
            let (s, n) = qualified_name_parts(&ast).unwrap_or_else(|| panic!("{f} is no qualified name: {ast:?}"));
            assert_eq!((s.to_ascii_uppercase().as_str(), n.to_ascii_uppercase().as_str()), (sheet, name), "{f}");
        }
        let sum = parse("=SUM(Sheet1!RngN)+Sheet2!Dup").expect("parses");
        assert!(format!("{sum:?}").matches("NamedRef").count() == 4, "{sum:?}");
        // A cell, a column range and a range are still references.
        assert!(qualified_name_parts(&parse("=Sheet1!A1").unwrap()).is_none());
        assert!(qualified_name_parts(&parse("=Sheet1!A1:B2").unwrap()).is_none());
        assert!(qualified_name_parts(&parse("=Sheet1!D:D").unwrap()).is_none());
    }

    /// BUG-0649: the R1C1 rewrite, at J5 (row 4, col 9, 0-based).
    #[test]
    fn a_bare_r1c1_name_becomes_the_entry_cells_a1_reference() {
        let at_j5 = |formula: &str| {
            let mut ast = parse(formula).expect("parses");
            resolve_r1c1_names(&mut ast, 4, 9, &|_| false);
            crate::ast::Expression::clone(&ast)
        };
        assert_eq!(at_j5("=LET(a,1,a+C)"), parse("=LET(a,1,a+J:J)").unwrap());
        assert_eq!(at_j5("=LET(a,1,a+R)"), parse("=LET(a,1,a+5:5)").unwrap());
        assert_eq!(at_j5("=C+1"), parse("=J:J+1").unwrap());
        assert_eq!(at_j5("=RC*0"), parse("=J5*0").unwrap());
        assert_eq!(at_j5("=R2C*0"), parse("=J$2*0").unwrap());
        assert_eq!(at_j5("=R1C1*0"), parse("=$A$1*0").unwrap());
        assert_eq!(at_j5("=LAMBDA(x,x+C)(1)"), parse("=LAMBDA(x,x+J:J)(1)").unwrap());
        // A binder of that spelling is the binding; a defined name is a name.
        assert_eq!(at_j5("=LET(c,5,c+C)"), parse("=LET(c,5,c+C)").unwrap());
        assert_eq!(at_j5("=LAMBDA(r,r+R)(2)"), parse("=LAMBDA(r,r+R)(2)").unwrap());
        let mut defined = parse("=RC+1").unwrap();
        resolve_r1c1_names(&mut defined, 4, 9, &|name| name.eq_ignore_ascii_case("RC"));
        assert_eq!(defined, parse("=RC+1").unwrap());
        // Not R1C1 names: a cell (RC1 is column RC), an ordinary name, and a
        // range operator's name half (left to the evaluator).
        assert_eq!(at_j5("=RC1+Rate"), parse("=RC1+Rate").unwrap());
        assert_eq!(at_j5("=LET(a,1,SUM(A:C)+a)"), parse("=LET(a,1,SUM(A:C)+a)").unwrap());
    }

    /// BUG-0648: the entry check refuses a shadowed built-in's refused arity.
    #[test]
    fn a_shadowed_built_in_with_a_refused_arity_fails_the_entry_check() {
        for refused in [
            "=LET(abs,LAMBDA(x,y,x+y),abs(1,2))",
            "=LET(pi,LAMBDA(x,x*2),pi(3))",
            "=LET(round,LAMBDA(x,x*2),round(3))",
            "=LET(max,LAMBDA(x,x),max())",
            "=LET(f,LAMBDA(abs,abs(1,2)),f(3))",
        ] {
            let ast = parse(refused).unwrap_or_else(|e| panic!("{refused} still parses (it loads): {e}"));
            assert!(check_entered_formula(&ast).is_err(), "{refused} must fail the entry check");
        }
        // (`=ABS(1,2)` was ACCEPTED here, pinning the plain call as outside this
        // check; BUG-0738 refuses it too, as Excel does -- see
        // `a_plain_built_in_with_an_arity_excel_refuses_fails_the_entry_check`.)
        for accepted in [
            "=LET(abs,LAMBDA(x,x+1),abs(-3))",
            "=LET(round,LAMBDA(x,x*2),round(3.14159,1))",
            "=LET(if,LAMBDA(x,x*3),if(2,3))",
            "=LET(sum,LAMBDA(x,x*2),sum(3))",
            // The catalog understates GCD; Excel's rule does not refuse it.
            "=LET(gcd,LAMBDA(x,x),gcd(4))",
        ] {
            assert!(check_entered_formula(&parse(accepted).unwrap()).is_ok(), "{accepted}");
        }
        assert_eq!(builtin_arity("ROUND"), Some((2, Some(2))));
        assert_eq!(builtin_arity("pi"), Some((0, Some(0))));
        assert_eq!(builtin_arity("SUM"), Some((1, None)));
    }

    /// BUG-0737: the copy of a formula the precedent extractor reads has each
    /// range half that is a LET name -- or an inline LAMBDA's parameter --
    /// bound to a plain reference replaced by it, so the span's interior is a
    /// precedent; a formula with no such half is not copied at all.
    #[test]
    fn a_bound_name_half_is_its_reference_for_the_precedents() {
        let bound = |formula: &str| bind_range_name_halves(&parse(formula).expect("parses"));
        let cell = |col: &str, row: u32| Expression::CellRef {
            sheet: None,
            col: col.to_string(),
            row,
            col_absolute: false,
            row_absolute: false,
            ref_site_id: RefSiteId::ZERO,
        };
        let range = |a: Expression, b: Expression| Expression::Range {
            sheet: None,
            start: Box::new(a),
            end: Box::new(b),
            ref_site_id: RefSiteId::ZERO,
        };
        let holds = |tree: &Expression, wanted: &Expression| {
            fn walk(e: &Expression, wanted: &Expression) -> bool {
                e == wanted || sub_expressions(e).into_iter().any(|s| walk(s, wanted))
            }
            walk(tree, wanted)
        };
        let let_span = bound("=LET(a,B2,SUM(a:C3))").expect("a:C3 has a bound name half");
        assert!(holds(&let_span, &range(cell("B", 2), cell("C", 3))), "{let_span:?}");
        let lambda_span = bound("=LAMBDA(b,SUM(A1:b))(A3)").expect("A1:b has a bound parameter half");
        assert!(holds(&lambda_span, &range(cell("A", 1), cell("A", 3))), "{lambda_span:?}");
        // A name bound to a VALUE, an unbound name, and no name half at all.
        assert!(bound("=LET(a,1,SUM(a:C3))").is_none());
        assert!(bound("=SUM(A1:A3)").is_none());
        // Behind a sheet a name half is the sheet's name, never the binding
        // (A1 IS bound to a reference here, `$B$2`).
        assert!(bound("=LET(A1,$B$2,Sheet2!A1)").is_none());
    }

    /// BUG-0739: the quoted spellings of a cell-shaped NAME the formula bar and
    /// the stored text use read back as that name -- as a range end, behind a
    /// sheet and behind a 3-D span -- and an R1C1-only spelling makes every
    /// plain cell of the formula a name.
    #[test]
    fn a_quoted_cell_shaped_name_reads_back_everywhere_the_renderer_writes_it() {
        let named = |name: &str| Expression::NamedRef { name: name.to_string(), ref_site_id: RefSiteId::ZERO };
        match parse("=SUM(J881:'D5')").expect("parses") {
            Expression::FunctionCall { args, .. } => match &args[0] {
                Expression::Range { end, .. } => assert_eq!(end.as_ref(), &named("D5")),
                other => panic!("{other:?}"),
            },
            other => panic!("{other:?}"),
        }
        match parse("=$D50:'D5'").expect("parses") {
            Expression::Range { end, .. } => assert_eq!(end.as_ref(), &named("D5")),
            other => panic!("{other:?}"),
        }
        match parse("=Sheet2!'A1'").expect("parses") {
            Expression::Range { sheet: Some(_), start, end, .. } => {
                assert_eq!(start.as_ref(), &named("A1"));
                assert_eq!(end.as_ref(), &named("A1"));
            }
            other => panic!("{other:?}"),
        }
        match parse("=SUM(Sheet1:Sheet2!'A1')").expect("parses") {
            Expression::FunctionCall { args, .. } => match &args[0] {
                Expression::Sheet3DRef { reference, .. } => assert_eq!(reference.as_ref(), &named("A1")),
                other => panic!("{other:?}"),
            },
            other => panic!("{other:?}"),
        }
        // `=R[-1]C+D5`: D5 is a name once the formula is read in R1C1.
        match parse("=R[-1]C+D5").expect("parses") {
            Expression::BinaryOp { right, .. } => assert_eq!(right.as_ref(), &named("D5")),
            other => panic!("{other:?}"),
        }
        // CONTROL: without an R1C1 spelling, D5 is the cell.
        assert!(matches!(parse("=A1+D5").expect("parses"), Expression::BinaryOp { right, .. } if matches!(right.as_ref(), Expression::CellRef { .. })));
    }

    /// BUG-0738: a PLAIN built-in called with an argument count Excel refuses
    /// to type fails the entry check, with Excel's message, while it still
    /// parses (a stored one loads). [LIVE, Excel 16, lane formula p4.json:
    /// each refused with 0x800A03EC in a cell; the messages are Excel's own,
    /// `Names.Add` p2.json / p3.json.] Calcula-only functions and unknown
    /// names are never refused.
    #[test]
    fn a_plain_built_in_with_an_arity_excel_refuses_fails_the_entry_check() {
        let too_many = "You've entered too many arguments for this function.";
        let too_few = "You've entered too few arguments for this function.";
        let problem = "There's a problem with this formula.";
        for (refused, message) in [
            ("=ABS(1,2)", too_many),
            ("=ROUND(1,2,3)", too_many),
            ("=IF(1,2,3,4)", too_many),
            ("=IFERROR(1,2,3)", too_many),
            ("=ROUND(1)", too_few),
            ("=MID(\"a\",1)", too_few),
            ("=IFS(1,2,3)", too_few),
            ("=SWITCH(1)", too_few),
            ("=CHOOSE(1)", too_few),
            ("=LET(x,1)", too_few),
            ("=IFERROR(1)", too_few),
            ("=PI(1)", problem),
            ("=IF()", problem),
            ("=SUM()", problem),
            ("=LAMBDA()", problem),
            ("=SUMIFS(A1:A5,B1:B5)", problem),
            ("=ROUND(A1)", problem),
            ("=ROUND(1+A1)", problem),
            ("=1+ABS(1,2)", too_many),
            ("=SUM(1,ROUND(1))", too_few),
            // Excel's CALL, which Calcula does not have: one argument or more.
            ("=CALL()", problem),
        ] {
            let ast = parse(refused).unwrap_or_else(|e| panic!("{refused} still parses (it loads): {e}"));
            match check_entered_formula(&ast) {
                Err(e) => assert!(
                    e.message.starts_with(message),
                    "{refused}: Excel says {message:?}, Calcula {:?}",
                    e.message
                ),
                Ok(()) => panic!("{refused} must fail the entry check, as Excel refuses it"),
            }
        }
        for accepted in [
            "=ABS(1)",
            "=ROUND(1,2)",
            "=IF(1,2)",
            "=IFS(1,2,3,4)",
            "=GCD(4)",
            "=LCM(4)",
            "=INDEX(A1:A5,1,1,1)",
            "=MAP(A1:A3,A1:A3,LAMBDA(a,b,a))",
            "=BYROW(A1:A3)",
            "=SORTBY(A1:A3,A1:A3,1,A1:A3,1)",
            "=LET(x,1,x)",
            "=PI()",
            // Calcula's own functions and unknown names: never refused.
            "=LPAD(\"a\")",
            "=POW(2,3,4)",
            "=COLLECT(1,2,3,4)",
            "=myFunction(1,2,3,4,5)",
            "=LAMBDA(x,x)(1,2)",
            "=CALL(\"a\")",
        ] {
            let ast = parse(accepted).unwrap_or_else(|e| panic!("{accepted}: {e}"));
            assert!(check_entered_formula(&ast).is_ok(), "{accepted} is typed by Excel: {:?}", check_entered_formula(&ast));
        }
    }

    /// BUG-0646: `a#` with `a` bound to a cell becomes `cell#` in the tree the
    /// host evaluates; shadowing and non-cell bindings are left alone.
    #[test]
    fn a_spill_of_a_name_bound_to_a_cell_becomes_that_cells_spill() {
        let bound = |formula: &str| {
            let mut ast = parse(formula).expect("parses");
            bind_spill_anchor_names(&mut ast);
            ast
        };
        assert_eq!(bound("=LET(a,E5,SUM(a#))"), parse("=LET(a,E5,SUM(E5#))").unwrap());
        assert_eq!(bound("=LAMBDA(a,ROWS(a#))(E5)"), parse("=LAMBDA(a,ROWS(E5#))(E5)").unwrap());
        assert_eq!(bound("=LET(a,E5,b,a,SUM(b#))"), parse("=LET(a,E5,b,a,SUM(E5#))").unwrap());
        assert_eq!(bound("=LET(a,SEQUENCE(3),SUM(a#))"), parse("=LET(a,SEQUENCE(3),SUM(a#))").unwrap());
        assert_eq!(bound("=LET(a,E5,LET(a,1,SUM(a#)))"), parse("=LET(a,E5,LET(a,1,SUM(a#)))").unwrap());
        assert_eq!(bound("=LET(a,E5,LAMBDA(a,a#)(2))"), parse("=LET(a,E5,LAMBDA(a,a#)(2))").unwrap());
    }

    /// BUG-0646: the shapes that used to be parse errors.
    #[test]
    fn the_range_operator_accepts_a_name_half_a_table_pair_and_a_second_qualifier() {
        for formula in [
            "=LET(a,B2,SUM(a:C3))",
            "=LET(b,A3,SUM(A1:b))",
            "=LET(a,SEQUENCE(3),SUM(a#))",
            "=LET(Col,1,SUM(Table1[Col]:Table1[Col])+Col)",
            "=LET(a,1,SUM(Sheet1!A1:Sheet1!A3)+a)",
            "=SUM(Sheet1!$A$1:'My Sheet'!$A$3)",
            "=ROWS(Table1[[#Headers],[#Data]]:Table1[Col])",
            // A second qualifier after an UNQUALIFIED first half (BUG-0737):
            // this was asserted a parse error; [LIVE, Excel 16, lane formula
            // p1.json] `=SUM(A1:Sheet1!A3)` is 6 in Sheet1.
            "=SUM(A1:Sheet1!A3)",
            "=SUM(A1:'Sheet1'!A3)",
            "=SUM($A$1:Sheet1!A3)",
        ] {
            assert!(parse(formula).is_ok(), "{formula}: {:?}", parse(formula));
        }
    }

    /// BUG-0643. A SECOND special item is a special item. `[[#Headers],[#Data]]`
    /// was `SpecialColumn(Headers, "#Data")` -- a COLUMN named `#Data`, which no
    /// table has, so Calcula answered #NAME? where Excel answers the header row
    /// plus the body [LIVE, Excel 16: ROWS(Table1[[#Headers],[#Data]]) = 6 over
    /// a 5-row table], and the export wrote `['#Data]`, which Excel reads as a
    /// column and shows #REF!.
    #[test]
    fn a_second_special_item_is_a_special_item_not_a_column() {
        assert_eq!(specifier_of("=Table3[[#Headers],[#Data]]"), TableSpecifier::HeadersAndData);
        assert_eq!(specifier_of("=Table3[[#Data],[#Totals]]"), TableSpecifier::DataAndTotals);
        assert_eq!(specifier_of("=Table3[[#Data],[#Headers]]"), TableSpecifier::HeadersAndData);
        assert_eq!(specifier_of("=Table3[[#Totals],[#Data]]"), TableSpecifier::DataAndTotals);
        assert_eq!(
            specifier_of("=Table3[[#Headers],[#Data],['#n]]"),
            TableSpecifier::SpecialColumn(Box::new(TableSpecifier::HeadersAndData), "#n".to_string())
        );
        assert_eq!(
            specifier_of("=Table4[[#Data],[#Totals],[p]]"),
            TableSpecifier::SpecialColumn(Box::new(TableSpecifier::DataAndTotals), "p".to_string())
        );
        assert_eq!(
            specifier_of("=Table4[[#Headers],[#Data],[p]:[q]]"),
            TableSpecifier::SpecialColumnRange(Box::new(TableSpecifier::HeadersAndData), "p".to_string(), "q".to_string())
        );
        assert_eq!(
            specifier_of("=Table4[[#Headers],[p]:[q]]"),
            TableSpecifier::SpecialColumnRange(Box::new(TableSpecifier::Headers), "p".to_string(), "q".to_string())
        );
        assert_eq!(
            specifier_of("=Table4[[#This Row],[p]:[q]]"),
            TableSpecifier::ThisRowRange("p".to_string(), "q".to_string())
        );
        // [LIVE] refused at entry: no region answers these pairs.
        assert!(parse("=Table1[[#Headers],[#Totals]]").is_err());
        assert!(parse("=Table4[[#All],[#Data]]").is_err());
        assert!(parse("=Table4[[#This Row],[#Data]]").is_err());
        // Control: one special item and a column is still `SpecialColumn`.
        assert_eq!(
            specifier_of("=Table1[[#Headers],[Amount]]"),
            TableSpecifier::SpecialColumn(Box::new(TableSpecifier::Headers), "Amount".to_string())
        );
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
        // `Table1[]` IS a spelling -- of the whole data body, [LIVE] Excel 16
        // (lane formd: `=ROWS(Tbl[])` 3) -- and so it is NOT the empty-name
        // marker: it parses to the WHOLE table (shown bare, read as `[#Data]`).
        for empty in ["=Table1[]", "=Table1[ ]"] {
            match parse(empty).expect("the whole table parses") {
                Expression::TableRef { specifier, .. } => assert_eq!(specifier, TableSpecifier::Whole, "{}", empty),
                other => panic!("{} parsed as {:?}", empty, other),
            }
        }
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

    fn entered(formula: &str) -> ParseResult<()> {
        check_entered_formula(&parse(formula).expect("parses"))
    }

    /// NEW-let-duplicate-case. [LIVE, Excel 16, lane namese, SCRATCH/namese/
    /// p1.txt + p2.txt] a LET name or LAMBDA parameter declared twice -- by
    /// case, or by `ß` / `SS` / `ẞ` -- is refused at entry; a NESTED rebinding
    /// is not a duplicate.
    #[test]
    fn a_name_declared_twice_by_one_let_or_lambda_is_refused_at_entry() {
        for refused in [
            "=LET(ab,1,AB,2,ab+aB)",
            "=LET(a,1,a,2,a)",
            "=LET(a,1,A,2,a)",
            "=LET(Straße,1,STRASSE,2,STRASSE)",
            "=LET(straße,1,STRAẞE,2,1)",
            "=LAMBDA(ab,AB,ab)(1,2)",
            "=LAMBDA(a,b,A,1)",
            "=LAMBDA(x,x,1)",
            "=LAMBDA(Straße,STRAẞE,1)",
            // [LIVE, lane namese p4] the defined-name rule, not the lookup rule.
            "=LAMBDA(Straße,STRASSE,1)",
            "=LET(Pæresalg,1,PAERESALG,2,1)",
            "=LAMBDA(Pæresalg,PAERESALG,1)",
            "=SUM(1,LET(q,1,Q,2,q))",
        ] {
            assert!(entered(refused).is_err(), "Excel refuses {} at entry", refused);
            // A LOADED formula keeps its text: the parse itself still succeeds.
            assert!(parse(refused).is_ok(), "{} must still load", refused);
        }
        for kept in [
            "=LET(x,1,LET(X,2,x))",
            "=LAMBDA(x,LET(X,2,x))(1)",
            "=LET(x,1,y,LAMBDA(X,X),y(3))",
            "=LET(a,1,b,2,A+B)",
            "=LAMBDA(x,y,x+y)(1,2)",
            "=LET(Straße,1,Straße)",
        ] {
            assert!(entered(kept).is_ok(), "Excel takes {}: {:?}", kept, entered(kept));
        }
    }

    /// The scoped walk behind the host's bare-table rule: a binder slot is never
    /// offered, a LET name binds from the next value on, a LAMBDA parameter in
    /// its body, by the per-character fold.
    #[test]
    fn replace_unbound_names_respects_let_and_lambda_scope() {
        let tbl = |name: &str| (identity::sheet_name_key(name) == "TBL").then(|| Expression::Literal(Value::Number(7.0)));
        let wanted = |name: &str| identity::sheet_name_key(name) == "TBL";
        for (formula, replaced) in [
            ("=ROWS(Tbl)", true),
            ("=LET(Tbl,5,Tbl)", false),
            ("=LET(Tbl,5,1)", false),
            ("=LET(a,Tbl,Tbl,2,a)", true),
            ("=LAMBDA(tbl,tbl)(1)", false),
            ("=LAMBDA(x,x+Tbl)(1)", true),
            ("=LET(x,1,x)", false),
        ] {
            let mut tree = parse(formula).unwrap();
            assert_eq!(any_unbound_name(&tree, &wanted), replaced, "gate: {}", formula);
            assert_eq!(replace_unbound_names(&mut tree, &tbl), replaced, "{}", formula);
        }
        // `LET(a,Tbl,Tbl,2,a)`: the first VALUE is outside the second binding.
        let mut tree = parse("=LET(a,Tbl,Tbl,2,a)").unwrap();
        replace_unbound_names(&mut tree, &tbl);
        match tree {
            Expression::FunctionCall { args, .. } => {
                assert_eq!(args[1], Expression::Literal(Value::Number(7.0)));
                assert!(matches!(&args[2], Expression::NamedRef { .. }), "a binder slot was replaced");
            }
            other => panic!("{other:?}"),
        }
    }
}