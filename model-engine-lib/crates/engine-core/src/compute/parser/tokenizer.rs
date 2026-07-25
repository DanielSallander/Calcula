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
    /// `->` (relationship-path arrow inside a `TRAVERSE(expr, a -> b -> c)`
    /// path). Recognized before `-` so binary subtraction is unaffected.
    Arrow,
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
                // The content of a `[...]` reference is a single column / measure
                // NAME that may contain spaces or punctuation (e.g. `[Total Sales]`,
                // `[Order Date]`). Capture it verbatim (trimmed) as ONE identifier
                // so the parser — which reads exactly one Ident between the
                // brackets — receives the whole name. Operators in filters live
                // outside the brackets (`[col] = 1`), so this never over-captures.
                let name_start = i;
                while i < len && chars[i] != ']' {
                    i += 1;
                }
                let name: String = chars[name_start..i]
                    .iter()
                    .collect::<String>()
                    .trim()
                    .to_string();
                if !name.is_empty() {
                    tokens.push((Token::Ident(name), byte_at(name_start)));
                }
                // The closing `]` is emitted by the `]` arm on the next iteration.
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
            // `->` relationship-path arrow, checked before bare `-` so binary
            // subtraction (`a - b`) is unaffected.
            '-' if i + 1 < len && chars[i + 1] == '>' => {
                tokens.push((Token::Arrow, tok_start));
                i += 2;
            }
            '-' => {
                tokens.push((Token::Minus, tok_start));
                i += 1;
            }
            '*' => {
                tokens.push((Token::Star, tok_start));
                i += 1;
            }
            // Block comment `/* ... */` — skipped entirely so measures can be
            // documented inline. An unterminated comment runs to end of input.
            '/' if i + 1 < len && chars[i + 1] == '*' => {
                i += 2;
                while i + 1 < len && !(chars[i] == '*' && chars[i + 1] == '/') {
                    i += 1;
                }
                i = if i + 1 < len { i + 2 } else { len };
            }
            // Line comment `// ...` — skipped to the end of the line.
            '/' if i + 1 < len && chars[i + 1] == '/' => {
                i += 2;
                while i < len && chars[i] != '\n' {
                    i += 1;
                }
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
                // Identifier. A `.` is consumed ONLY as an internal separator
                // (schema-qualified table names like `BI.fact_sales`) — never a
                // leading or trailing dot — so decimal literals (`1.5`, `.5`)
                // and stray dots keep their meaning.
                let start = i;
                while i < len {
                    let ch = chars[i];
                    let dot_continues = ch == '.'
                        && i + 1 < len
                        && (chars[i + 1].is_alphanumeric() || chars[i + 1] == '_');
                    if ch.is_alphanumeric() || ch == '_' || dot_continues {
                        i += 1;
                    } else {
                        break;
                    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn idents(input: &str) -> Vec<String> {
        tokenize(input)
            .unwrap()
            .into_iter()
            .filter_map(|(t, _)| match t {
                Token::Ident(s) => Some(s),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn schema_qualified_table_name_is_one_identifier() {
        // A model table named `BI.fact_sales` must tokenize as a single ident so
        // measures like SUM(BI.fact_sales[linetotal]) parse.
        assert_eq!(
            idents("SUM(BI.fact_sales[linetotal])"),
            vec!["SUM", "BI.fact_sales", "linetotal"]
        );
    }

    #[test]
    fn bracketed_name_with_spaces_is_one_identifier() {
        // A measure named "Total Sales" must reference as [Total Sales]; the
        // bracket content is one name even with spaces.
        assert_eq!(idents("[Total Sales] + 1000"), vec!["Total Sales"]);
        // Schema-qualified table + spaced column together.
        assert_eq!(
            idents("SUM(BI.fact_sales[Order Date])"),
            vec!["SUM", "BI.fact_sales", "Order Date"]
        );
    }

    #[test]
    fn decimals_and_trailing_dots_are_unaffected() {
        let toks = tokenize("1.5 + .25 + Sales[x]").unwrap();
        let nums: Vec<f64> = toks
            .iter()
            .filter_map(|(t, _)| match t {
                Token::Number(n) => Some(*n),
                _ => None,
            })
            .collect();
        assert_eq!(nums, vec![1.5, 0.25]);
        assert!(idents("1.5 + .25 + Sales[x]").contains(&"Sales".to_string()));
    }
}
