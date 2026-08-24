//! FILENAME: core/parser/src/lexer.rs
//! PURPOSE: Scans a raw formula string and produces a stream of Tokens.
//! CONTEXT: This is the first stage of the parsing pipeline. It handles
//! whitespace skipping, number parsing, string literals, quoted identifiers
//! for sheet names, and multi-character operators like <= and <>.
//!
//! SUPPORTED OPERATORS:
//! - Single char: + - * / ^ & ( ) , : = < > ! $
//! - Multi char: <= >= <>
//! - Quoted identifiers: 'Sheet Name'

use crate::token::Token;
use std::iter::Peekable;
use std::str::Chars;

pub struct Lexer<'a> {
    input: Peekable<Chars<'a>>,
    /// Whether the token most recently returned by `next_token` had whitespace
    /// in front of it.
    ///
    /// WHY A FLAG AND NOT A `Token::Whitespace`. Excel's INTERSECTION operator is
    /// a SPACE between two references (`=SUM(A1:A5 A3:C3)`), so the parser has to
    /// know that a space was there — but `skip_whitespace` had already consumed it
    /// and emitted nothing, making it unrecoverable. A token variant would be the
    /// obvious fix and is the wrong one: every other rule in this grammar is
    /// whitespace-insensitive, so a real token would have to be skipped explicitly
    /// at dozens of sites and would break the moment one was missed. A flag leaves
    /// the token stream exactly as it was and adds the one bit the parser needs.
    had_leading_ws: bool,
    /// Which sides of the colons seen so far carried Excel's trim-reference
    /// dot: bit 0 = leading (`A1.:B10`), bit 1 = trailing (`A1:.B10`).
    ///
    /// A FLAG FOR THE SAME REASON `had_leading_ws` IS ONE, only more so. The
    /// dot is not an operand and not an operator with its own precedence -- it
    /// is a modifier on the `:` it touches. Giving it a token variant would
    /// mean auditing every one of the parser's twenty-one `== Token::Colon`
    /// comparisons and every range-building function behind them, and a single
    /// miss is a formula that stops parsing. Swallowing the dots here leaves
    /// the token stream byte-identical to what those sites already handle, and
    /// the parser reads this one field at the single point where a reference
    /// atom is finished.
    ///
    /// It ACCUMULATES rather than describing the last colon: `take_trim_flags`
    /// clears it, and the parser saves and restores it around each atom so a
    /// nested range cannot leak its dots to the expression containing it.
    trim_flags: u8,
}

/// Every error literal a formula may contain, longest first.
///
/// LONGEST FIRST IS LOAD-BEARING: `#NUM!` and `#NULL!` both begin `#NU`, and
/// `#N/A` begins `#N` like both of them. A shortest-first scan would match
/// `#N/A`'s prefix inside neither, but it WOULD stop at `#NUM!` while
/// reading `#NUMBER`-like text; ordering by length removes the question.
///
/// Calcula's own four (`#CIRCULAR!`, `#CONFLICT!`, `#BLOCKED!`, `#LIMIT!`)
/// are here as well as Excel's eight: they can appear in a cell, so a
/// formula that names one must round-trip rather than fail to parse. The
/// canonical spellings live in `CellError::as_literal` in the engine crate —
/// which this crate cannot depend on (the dependency runs the other way), so
/// `errorLiteralsMatchTheEngine` in the engine's own tests diffs the two.
/// `TRIMRANGE`'s trim code for the leading edge -- the dot BEFORE the colon.
pub const TRIM_LEADING: u8 = 1;
/// `TRIMRANGE`'s trim code for the trailing edge -- the dot AFTER the colon.
pub const TRIM_TRAILING: u8 = 2;

pub const ERROR_LITERALS: [&str; 12] = [
    "#CIRCULAR!", "#CONFLICT!", "#BLOCKED!", "#DIV/0!", "#VALUE!", "#SPILL!", "#LIMIT!",
    "#NAME?", "#NULL!", "#REF!", "#NUM!", "#N/A",
];

impl<'a> Lexer<'a> {
    pub fn new(input: &'a str) -> Self {
        Lexer {
            input: input.chars().peekable(),
            had_leading_ws: false,
            trim_flags: 0,
        }
    }

    /// Returns the trim-reference dots seen since the last call and clears
    /// them. See `trim_flags`.
    pub fn take_trim_flags(&mut self) -> u8 {
        std::mem::take(&mut self.trim_flags)
    }

    /// Restores a previously taken set of flags, so an atom can put back what
    /// the expression around it had accumulated.
    pub fn restore_trim_flags(&mut self, flags: u8) {
        self.trim_flags |= flags;
    }

    /// Advances the lexer and returns the next token.
    pub fn next_token(&mut self) -> Token {
        self.had_leading_ws = self.skip_whitespace();

        match self.input.next() {
            Some('+') => Token::Plus,
            Some('-') => Token::Minus,
            Some('*') => Token::Asterisk,
            Some('/') => Token::Slash,
            Some('^') => Token::Caret,
            Some('&') => Token::Ampersand,
            Some('(') => Token::LParen,
            Some(')') => Token::RParen,
            Some(',') => Token::Comma,
            Some(':') => {
                if self.input.peek() == Some(&'.') {
                    self.input.next();
                    self.trim_flags |= TRIM_TRAILING;
                }
                Token::Colon
            }
            Some('!') => Token::Exclamation,
            Some('$') => Token::Dollar,
            Some('@') => Token::At,
            // `#` is BOTH the postfix spill operator (`A1#`) and the first
            // character of every ERROR LITERAL (`#REF!`, `#N/A`, ...). The two
            // are told apart by what follows: a known error name makes it a
            // literal, anything else stays the spill operator. The lookahead
            // consumes nothing unless it succeeds, so `A1#` is unaffected.
            Some('#') => match self.peek_error_literal() {
                Some(lit) => {
                    for _ in 0..lit.chars().count() - 1 {
                        self.input.next();
                    }
                    Token::ErrorLiteral(lit)
                }
                None => Token::Hash,
            },
            Some('[') => Token::LBracket,
            Some(']') => Token::RBracket,
            Some('{') => Token::LBrace,
            Some('}') => Token::RBrace,
            Some('%') => Token::Percent,
            Some(';') => Token::Semicolon,

            // Handle = and potentially other operators starting with =
            Some('=') => Token::Equals,

            // Handle < and potentially <= or <>
            Some('<') => self.read_less_than_operator(),

            // Handle > and potentially >=
            Some('>') => self.read_greater_than_operator(),

            // Handle double quotes for strings
            Some('"') => self.read_string(),

            // Handle single quotes for sheet names with spaces
            Some('\'') => self.read_quoted_identifier(),

            // Excel's trim-reference operator. It has to be decided here,
            // before the number rule below, because `.5` is a number and `.`
            // on its own is an operator -- the digit is the whole difference.
            //
            // A dot that really is the operator is followed by the `:` it
            // modifies, so both are consumed together and the colon is handed
            // to the parser unchanged. A dot with no colon behind it is a
            // `Token::Dot` that no production accepts, which is the intent: it
            // is a typo, and it should say so rather than parse as something.
            Some('.') if !matches!(self.input.peek(), Some(c) if c.is_ascii_digit()) => {
                if self.input.peek() == Some(&':') {
                    self.input.next();
                    self.trim_flags |= TRIM_LEADING;
                    if self.input.peek() == Some(&'.') {
                        self.input.next();
                        self.trim_flags |= TRIM_TRAILING;
                    }
                    Token::Colon
                } else {
                    Token::Dot
                }
            }

            // Handle Numbers (starts with digit or dot)
            Some(ch) if ch.is_ascii_digit() || ch == '.' => self.read_number(ch),

            // Handle Identifiers (starts with letter)
            Some(ch) if is_letter(ch) => self.read_identifier(ch),

            // End of input
            None => Token::EOF,

            // Unknown character
            Some(ch) => Token::Illegal(ch),
        }
    }

    /// The RAW TEXT of a structured-reference bracket body, consumed through
    /// its matching `]`, or `None` if end of input arrives first.
    ///
    /// CALLED WHEN THE PARSER'S CURRENT TOKEN IS THE OPENING `[`, which is the
    /// one moment the body is still readable as the user typed it: the
    /// character stream sits immediately after that `[`, and the next
    /// `next_token` would uppercase, split and re-spell what follows. A column
    /// name is DATA -- `Cost (USD)`, `Sales%`, `Profit-Loss`, `A:B` are all
    /// legal Excel column names -- and reading it as tokens either mangled it
    /// (a space appearing inside `Profit-Loss`) or refused it outright.
    ///
    /// The `'` escape is honoured HERE and not merely later, because it decides
    /// where the body ENDS: in `[Cost '[USD']]` the escaped `]` must not close
    /// the reference. The escape characters are left in the returned text so the
    /// specifier reader can still tell a structural `,` `:` `[` `]` from one
    /// that is part of a name; they are removed only at the leaves.
    pub fn scan_bracket_body(&mut self) -> Option<String> {
        let mut out = String::new();
        let mut depth = 0usize;
        loop {
            let ch = self.input.next()?;
            match ch {
                '\'' => {
                    out.push(ch);
                    out.push(self.input.next()?);
                }
                '[' => {
                    depth += 1;
                    out.push(ch);
                }
                ']' => {
                    if depth == 0 {
                        return Some(out);
                    }
                    depth -= 1;
                    out.push(ch);
                }
                _ => out.push(ch),
            }
        }
    }

    /// Consumes whitespace and reports whether there was any.
    fn skip_whitespace(&mut self) -> bool {
        let mut saw_any = false;
        while let Some(&ch) = self.input.peek() {
            if !ch.is_whitespace() {
                break;
            }
            saw_any = true;
            self.input.next();
        }
        saw_any
    }

    /// True when the token most recently returned by [`Lexer::next_token`] was
    /// preceded by whitespace. The parser reads this to recognise Excel's space
    /// INTERSECTION operator, which is otherwise indistinguishable from two
    /// adjacent operands.
    pub fn last_token_had_leading_whitespace(&self) -> bool {
        self.had_leading_ws
    }

    /// Handles operators starting with '<': <, <=, <>
    fn read_less_than_operator(&mut self) -> Token {
        match self.input.peek() {
            Some('=') => {
                self.input.next();
                Token::LessEqual
            }
            Some('>') => {
                self.input.next();
                Token::NotEqual
            }
            _ => Token::LessThan,
        }
    }

    /// Handles operators starting with '>': >, >=
    fn read_greater_than_operator(&mut self) -> Token {
        match self.input.peek() {
            Some('=') => {
                self.input.next();
                Token::GreaterEqual
            }
            _ => Token::GreaterThan,
        }
    }

    fn read_string(&mut self) -> Token {
        let mut result = String::new();
        // Consume chars until an UNDOUBLED quote or EOF.
        while let Some(&ch) = self.input.peek() {
            if ch == '"' {
                self.input.next();
                // `""` is one literal quote, exactly as `read_quoted_identifier`
                // treats `''`. Without this a text literal could not contain a
                // quote at all, and any value that did carry one rendered to
                // formula text that would not lex back.
                if self.input.peek() == Some(&'"') {
                    result.push('"');
                    self.input.next();
                    continue;
                }
                return Token::String(result);
            }
            result.push(ch);
            self.input.next();
        }
        // EOF WITH NO CLOSING QUOTE IS A REFUSAL, not a string.
        //
        // Returning `Token::String(result)` here -- what this did -- made `="abc`
        // parse and EVALUATE to the text `abc`. Nothing anywhere reported that a
        // quote was missing, so the cheapest possible typo produced a cell that
        // looked deliberate. `read_quoted_identifier` below still has the same
        // shape for sheet names and is a separate call.
        Token::UnterminatedString
    }

    /// Reads a quoted identifier (sheet name with spaces): 'Sheet Name'
    fn read_quoted_identifier(&mut self) -> Token {
        let mut result = String::new();
        while let Some(&ch) = self.input.peek() {
            if ch == '\'' {
                // Check for escaped single quote ('')
                self.input.next();
                if self.input.peek() == Some(&'\'') {
                    // Escaped quote - add one quote and continue
                    result.push('\'');
                    self.input.next();
                } else {
                    // End of quoted identifier
                    return Token::QuotedIdentifier(result);
                }
            } else {
                result.push(ch);
                self.input.next();
            }
        }
        // If we hit EOF without closing quote, return what we have
        Token::QuotedIdentifier(result)
    }

    fn read_number(&mut self, first_char: char) -> Token {
        let mut number_str = String::from(first_char);
        let mut has_dot = first_char == '.';

        while let Some(&ch) = self.input.peek() {
            if ch.is_ascii_digit() {
                number_str.push(ch);
                self.input.next();
            } else if ch == '.' && !has_dot {
                has_dot = true;
                number_str.push(ch);
                self.input.next();
            } else {
                break;
            }
        }

        // SCIENTIFIC NOTATION. Excel reads `=1E3` as 1000, `=2.5E2+1` as 251 and
        // `=1E-3` as 0.001. Without this the lexer produced Number(1) followed by
        // Identifier("E3") -- two tokens with no operator between them, so the
        // parse failed and `update_cell` stored the user's text AS TEXT. A cell
        // holding the string "=1E3" with no error anywhere is the silent class
        // this register keeps cataloguing, and it was reachable by typing a
        // number the way half of science writes one. (The bare cell entry `1E3`
        // was always 1000 -- it is the FORMULA lexer that could not read it.)
        //
        // COMMIT-ONLY-IF-VALID. `E` is also the start of a column name, so the
        // exponent is accepted only when an optional sign is followed by at
        // least one digit. The lookahead runs on a CLONE of the iterator and the
        // real one is advanced only on success, so `=1E`, `=1E+` and `=1EUR`
        // consume nothing and still lex as they did before.
        if let Some(exponent) = self.peek_exponent() {
            for _ in 0..exponent.chars().count() {
                self.input.next();
            }
            number_str.push_str(&exponent);
        }

        if let Ok(n) = number_str.parse::<f64>() {
            Token::Number(n)
        } else {
            // Fallback if parsing fails (e.g. just ".")
            Token::Illegal(first_char)
        }
    }



    /// The error literal starting at the `#` just consumed, or `None`.
    /// Consumes nothing; the caller advances past it on success.
    ///
    /// Case-insensitive, because a user types `#n/a` and Excel accepts it — the
    /// returned string is the CANONICAL spelling, so the AST never carries the
    /// user's casing and the renderer needs no normalisation of its own.
    fn peek_error_literal(&self) -> Option<String> {
        let mut ahead = String::from("#");
        let mut look = self.input.clone();
        // The longest literal is 10 characters including the '#'.
        for _ in 0..9 {
            match look.next() {
                Some(c) => ahead.push(c.to_ascii_uppercase()),
                None => break,
            }
        }
        ERROR_LITERALS
            .iter()
            .find(|lit| ahead.starts_with(*lit))
            .map(|lit| (*lit).to_string())
    }

    /// The exponent suffix (`E3`, `e+10`, `E-3`) starting at the current
    /// position, or `None` when what follows is not one. Consumes nothing.
    fn peek_exponent(&self) -> Option<String> {
        let mut look = self.input.clone();
        let marker = match look.next() {
            Some(c @ ('e' | 'E')) => c,
            _ => return None,
        };
        let mut suffix = String::from(marker);
        match look.peek() {
            Some(&c @ ('+' | '-')) => {
                suffix.push(c);
                look.next();
            }
            _ => {}
        }
        // At least one digit, or this is a column name and not an exponent.
        match look.peek() {
            Some(&c) if c.is_ascii_digit() => {}
            _ => return None,
        }
        while let Some(&c) = look.peek() {
            if c.is_ascii_digit() {
                suffix.push(c);
                look.next();
            } else {
                break;
            }
        }
        Some(suffix)
    }

    fn read_identifier(&mut self, first_char: char) -> Token {
        let mut ident = String::from(first_char);

        while let Some(&ch) = self.input.peek() {
            if is_letter(ch) || ch.is_ascii_digit() {
                ident.push(ch);
                self.input.next();
            } else if ch == '.' {
                // '.' continues a defined name like "Q1.Sales" -- but ONLY when
                // something name-like follows it. A trailing dot is the
                // trim-reference operator (`A1.:B10`), and swallowing it into
                // the identifier here would hide the operator from the parser
                // where it could never be recovered.
                let mut look = self.input.clone();
                look.next();
                match look.peek() {
                    Some(&next) if is_letter(next) || next.is_ascii_digit() => {
                        ident.push(ch);
                        self.input.next();
                    }
                    _ => break,
                }
            } else {
                break;
            }
        }

        match ident.to_uppercase().as_str() {
            "TRUE" => Token::Boolean(true),
            "FALSE" => Token::Boolean(false),
            _ => Token::Identifier(ident.to_uppercase()), // Normalize to UPPERCASE
        }
    }
}

/// Returns true if `ch` can start an identifier.
/// Supports: ASCII letters, underscore (for names like _private),
/// and backslash (for Excel-style names like \TaxRate).
fn is_letter(ch: char) -> bool {
    ch.is_ascii_alphabetic() || ch == '_' || ch == '\\'
}