//! FILENAME: core/parser/src/token.rs
//! PURPOSE: Token definitions for the formula lexer.
//! CONTEXT: Tokens are the atomic units produced by the lexer and consumed by the parser.

/// Tokens recognized by the formula lexer.
#[derive(Debug, PartialEq, Clone)]
pub enum Token {
    // Literals
    Number(f64),
    String(String),
    Boolean(bool),
    Identifier(String),
    /// Quoted identifier for sheet names with spaces: 'Sheet Name'
    QuotedIdentifier(String),

    // Operators
    Plus,
    Minus,
    Asterisk,
    Slash,
    Caret,
    Ampersand,
    Equals,
    NotEqual,
    LessThan,
    GreaterThan,
    LessEqual,
    GreaterEqual,

    // Delimiters
    LParen,
    RParen,
    Comma,
    Colon,
    /// Sheet reference separator: !
    Exclamation,
    /// Absolute reference marker: $
    Dollar,

    // Special
    EOF,
    Illegal(char),
}

impl std::fmt::Display for Token {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Token::Number(n) => write!(f, "{}", n),
            Token::String(s) => write!(f, "\"{}\"", s),
            Token::Boolean(b) => write!(f, "{}", if *b { "TRUE" } else { "FALSE" }),
            Token::Identifier(s) => write!(f, "{}", s),
            Token::QuotedIdentifier(s) => write!(f, "'{}'", s),
            Token::Plus => write!(f, "+"),
            Token::Minus => write!(f, "-"),
            Token::Asterisk => write!(f, "*"),
            Token::Slash => write!(f, "/"),
            Token::Caret => write!(f, "^"),
            Token::Ampersand => write!(f, "&"),
            Token::Equals => write!(f, "="),
            Token::NotEqual => write!(f, "<>"),
            Token::LessThan => write!(f, "<"),
            Token::GreaterThan => write!(f, ">"),
            Token::LessEqual => write!(f, "<="),
            Token::GreaterEqual => write!(f, ">="),
            Token::LParen => write!(f, "("),
            Token::RParen => write!(f, ")"),
            Token::Comma => write!(f, ","),
            Token::Colon => write!(f, ":"),
            Token::Exclamation => write!(f, "!"),
            Token::Dollar => write!(f, "$"),
            Token::EOF => write!(f, "EOF"),
            Token::Illegal(c) => write!(f, "ILLEGAL({})", c),
        }
    }
}