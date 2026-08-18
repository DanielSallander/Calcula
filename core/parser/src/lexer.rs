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
}

impl<'a> Lexer<'a> {
    pub fn new(input: &'a str) -> Self {
        Lexer {
            input: input.chars().peekable(),
            had_leading_ws: false,
        }
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
            Some(':') => Token::Colon,
            Some('!') => Token::Exclamation,
            Some('$') => Token::Dollar,
            Some('@') => Token::At,
            Some('#') => Token::Hash,
            Some('[') => Token::LBracket,
            Some(']') => Token::RBracket,
            Some('{') => Token::LBrace,
            Some('}') => Token::RBrace,

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
        // If we hit EOF without closing quote, return what we have.
        Token::String(result)
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
            // Allow letters, digits, and '.' as continuation characters.
            // '.' supports defined names like "Q1.Sales".
            if is_letter(ch) || ch.is_ascii_digit() || ch == '.' {
                ident.push(ch);
                self.input.next();
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