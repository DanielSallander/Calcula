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
}

impl<'a> Lexer<'a> {
    pub fn new(input: &'a str) -> Self {
        Lexer {
            input: input.chars().peekable(),
        }
    }

    /// Advances the lexer and returns the next token.
    pub fn next_token(&mut self) -> Token {
        self.skip_whitespace();

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
            Some('[') => Token::LBracket,
            Some(']') => Token::RBracket,

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

    fn skip_whitespace(&mut self) {
        while let Some(&ch) = self.input.peek() {
            if !ch.is_whitespace() {
                break;
            }
            self.input.next();
        }
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
        // Consume chars until we hit another quote or EOF
        while let Some(&ch) = self.input.peek() {
            if ch == '"' {
                self.input.next(); // Consume the closing quote
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

        if let Ok(n) = number_str.parse::<f64>() {
            Token::Number(n)
        } else {
            // Fallback if parsing fails (e.g. just ".")
            Token::Illegal(first_char)
        }
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