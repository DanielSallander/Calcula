//! Tokenizer for the measure expression language.

use super::*;

#[derive(Debug, Clone, PartialEq)]
pub(super) enum Token {
    /// An identifier (table name, function name, etc.)
    Ident(String),
    /// A numeric literal (integer or float)
    Number(f64),
    /// A string literal (quoted with double quotes)
    StringLit(String),
    /// `[`
    LBracket,
    /// `]`
    RBracket,
    /// `(`
    LParen,
    /// `)`
    RParen,
    /// `,`
    Comma,
    /// `+`
    Plus,
    /// `-`
    Minus,
    /// `*`
    Star,
    /// `/`
    Slash,
    /// `=`
    Eq,
    /// `!=`
    Neq,
    /// `>`
    Gt,
    /// `>=`
    Gte,
    /// `<`
    Lt,
    /// `<=`
    Lte,
    /// `{`
    LBrace,
    /// `}`
    RBrace,
}

/// Tokenize the input into `(token, byte_offset)` pairs, where the offset is
/// the byte position of the token's first character in `input`.
pub(super) fn tokenize(input: &str) -> EngineResult<Vec<(Token, usize)>> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = input.chars().collect();
    // Byte offset of each char index, for reporting positions in the
    // original input text (multi-byte UTF-8 chars make char index != byte
    // offset).
    let byte_offsets: Vec<usize> = input.char_indices().map(|(b, _)| b).collect();
    let byte_at = |char_idx: usize| byte_offsets.get(char_idx).copied().unwrap_or(input.len());
    let len = chars.len();
    let mut i = 0;

    while i < len {
        let c = chars[i];

        // Skip whitespace.
        if c.is_whitespace() {
            i += 1;
            continue;
        }

        // Byte offset where the current token starts.
        let tok_start = byte_at(i);

        match c {
            '[' => {
                tokens.push((Token::LBracket, tok_start));
                i += 1;
            }
            ']' => {
                tokens.push((Token::RBracket, tok_start));
                i += 1;
            }
            '(' => {
                tokens.push((Token::LParen, tok_start));
                i += 1;
            }
            ')' => {
                tokens.push((Token::RParen, tok_start));
                i += 1;
            }
            ',' => {
                tokens.push((Token::Comma, tok_start));
                i += 1;
            }
            '{' => {
                tokens.push((Token::LBrace, tok_start));
                i += 1;
            }
            '}' => {
                tokens.push((Token::RBrace, tok_start));
                i += 1;
            }
            '+' => {
                tokens.push((Token::Plus, tok_start));
                i += 1;
            }
            '-' => {
                tokens.push((Token::Minus, tok_start));
                i += 1;
            }
            '*' => {
                tokens.push((Token::Star, tok_start));
                i += 1;
            }
            '/' => {
                tokens.push((Token::Slash, tok_start));
                i += 1;
            }
            '=' => {
                tokens.push((Token::Eq, tok_start));
                i += 1;
            }
            '!' if i + 1 < len && chars[i + 1] == '=' => {
                tokens.push((Token::Neq, tok_start));
                i += 2;
            }
            // SQL-style inequality `<>` (an alias for `!=`). Checked before the
            // bare `<` / `<=` arms so the two characters are consumed together.
            '<' if i + 1 < len && chars[i + 1] == '>' => {
                tokens.push((Token::Neq, tok_start));
                i += 2;
            }
            '>' if i + 1 < len && chars[i + 1] == '=' => {
                tokens.push((Token::Gte, tok_start));
                i += 2;
            }
            '>' => {
                tokens.push((Token::Gt, tok_start));
                i += 1;
            }
            '<' if i + 1 < len && chars[i + 1] == '=' => {
                tokens.push((Token::Lte, tok_start));
                i += 2;
            }
            '<' => {
                tokens.push((Token::Lt, tok_start));
                i += 1;
            }
            '"' => {
                // String literal.
                i += 1;
                let start = i;
                while i < len && chars[i] != '"' {
                    i += 1;
                }
                if i >= len {
                    return Err(EngineError::ParseError {
                        position: tok_start,
                        message: "unterminated string literal".into(),
                    });
                }
                let s: String = chars[start..i].iter().collect();
                tokens.push((Token::StringLit(s), tok_start));
                i += 1; // skip closing quote
            }
            _ if c.is_ascii_digit() || c == '.' => {
                // Number literal.
                let start = i;
                while i < len && (chars[i].is_ascii_digit() || chars[i] == '.') {
                    i += 1;
                }
                let num_str: String = chars[start..i].iter().collect();
                let val: f64 = num_str.parse().map_err(|_| EngineError::ParseError {
                    position: tok_start,
                    message: format!("invalid number: {num_str}"),
                })?;
                tokens.push((Token::Number(val), tok_start));
            }
            _ if c.is_alphanumeric() || c == '_' => {
                // Identifier.
                let start = i;
                while i < len && (chars[i].is_alphanumeric() || chars[i] == '_') {
                    i += 1;
                }
                let ident: String = chars[start..i].iter().collect();
                tokens.push((Token::Ident(ident), tok_start));
            }
            _ => {
                return Err(EngineError::ParseError {
                    position: tok_start,
                    message: format!("unexpected character: '{c}'"),
                });
            }
        }
    }

    Ok(tokens)
}
