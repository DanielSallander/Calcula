//! Tokenizer for the applied-steps script.
//!
//! Two passes, in this order, because the second depends on the first:
//!
//! 1. **Statements.** A statement begins on a line whose first character is not
//!    whitespace; a line that *does* begin with whitespace continues the
//!    statement above it. That is the rule the shipped Model Editor CLI already
//!    uses for multi-line DAX (`_shared/cli/lex.ts`), reused rather than
//!    invented so a user who knows one surface knows the other. It also removes
//!    any need for a statement terminator, and therefore for an escape
//!    convention on the one field that feeds the fail-closed expression
//!    allowlist.
//! 2. **Tokens.** Within a statement, everything after a *free-standing* `=`
//!    (one with whitespace before it) is the raw expression tail and is never
//!    tokenized — an author's `filterRows` condition reaches the model
//!    expression parser byte-for-byte as written.
//!
//! # The one-space marker
//!
//! A continuation line is emitted with exactly one extra leading space and read
//! back by stripping exactly one leading whitespace character. So a stored
//! condition of `status <> "x"\n  AND amount > 0` renders with three leading
//! spaces on its second line and parses back to two — exactly, in both
//! directions, with no escaping. A whitespace-only continuation line is how an
//! empty line inside an expression survives; a *zero-length* line never
//! continues anything, so blank lines stay free to separate statements.

use super::ScriptError;

/// What a token is. Values (`Word`/`Quoted`/`Bracketed`) carry decoded text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TokenKind {
    /// A bare run: `columns`, `Int64`, `Decimal(18,2)`, `-margin`, `region.1`.
    Word,
    /// A `"…"` string. `text` is the decoded value.
    Quoted,
    /// A `[…]` name. `text` is the decoded value.
    Bracketed,
    /// `,` — separates the elements of a list value.
    Comma,
    /// `:` — separates the atoms of a composite element.
    Colon,
    /// `=` glued to the preceding word: an option assignment.
    Assign,
}

/// One lexed token, with the position a diagnostic points at.
#[derive(Debug, Clone)]
pub(crate) struct Token {
    pub kind: TokenKind,
    pub text: String,
    /// 1-based physical line.
    pub line: usize,
    /// 1-based column.
    pub column: usize,
    /// Whether whitespace (including a line break) preceded this token. This is
    /// what lets an option's value run end at the right place without a
    /// terminator: `nameColumn=month valueColumn=x` splits, `columns=a, b`
    /// does not.
    pub preceded_by_space: bool,
}

/// One statement: a step tag, its options, and an optional expression tail.
#[derive(Debug, Clone)]
pub(crate) struct Statement {
    /// 1-based physical line the statement starts on.
    pub line: usize,
    pub tokens: Vec<Token>,
    /// The raw text after a free-standing `=`, if the statement had one.
    pub expr: Option<String>,
    /// 1-based position of the first character of the expression tail.
    pub expr_line: usize,
    pub expr_column: usize,
}

/// One physical line of a statement, already dedented by the marker space.
struct PhysicalLine {
    /// 1-based physical line number in the original source.
    number: usize,
    /// The line's text; for a continuation, with one leading whitespace
    /// character removed.
    text: String,
    /// How many characters were removed from the front (0 or 1), so a column
    /// can be reported against the ORIGINAL text.
    dedented: usize,
}

/// True for a line that starts a comment. Only column zero counts: an indented
/// `//` is a continuation, which matters because a DAX expression may contain
/// one.
fn is_comment(line: &str) -> bool {
    line.starts_with("//") || line.starts_with('#')
}

/// Group source text into statements, dropping blank lines and column-zero
/// comments and attaching indented lines to the statement above.
fn split_statements(source: &str) -> Result<Vec<Vec<PhysicalLine>>, ScriptError> {
    let mut out: Vec<Vec<PhysicalLine>> = Vec::new();
    for (index, raw) in source.split('\n').enumerate() {
        let number = index + 1;
        // Tolerate CRLF and lone CR without making the caller normalize first:
        // a script arrives from an editor buffer, a clipboard, or a file.
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        let starts_indented = raw.starts_with(' ') || raw.starts_with('\t');

        if starts_indented {
            match out.last_mut() {
                Some(statement) => {
                    let mut chars = raw.chars();
                    chars.next();
                    statement.push(PhysicalLine {
                        number,
                        text: chars.as_str().to_string(),
                        dedented: 1,
                    });
                }
                // A line of nothing but spaces with no step above it is a blank
                // line someone's editor left behind, not an orphan continuation.
                None if raw.trim().is_empty() => {}
                None => {
                    return Err(ScriptError::at(
                        "an indented line continues the step above it, but there is no step above \
                         this one — remove the leading spaces to start a step here",
                        number,
                        1,
                    ));
                }
            }
            continue;
        }

        if raw.trim().is_empty() || is_comment(raw) {
            // Blank lines separate statements; a column-zero comment ends the
            // statement above it, which is what makes commenting a step out
            // work while the buffer is open.
            continue;
        }

        out.push(vec![PhysicalLine {
            number,
            text: raw.to_string(),
            dedented: 0,
        }]);
    }
    Ok(out)
}

/// Lex a whole script into statements.
pub(crate) fn lex_script(source: &str) -> Result<Vec<Statement>, ScriptError> {
    split_statements(source)?
        .into_iter()
        .map(|lines| lex_statement_lines(&lines))
        .collect()
}

/// Lex a single statement supplied without surrounding script structure (the
/// Model Editor CLI's `transform … add <statement>` path).
pub(crate) fn lex_one_statement(source: &str) -> Result<Statement, ScriptError> {
    let mut statements = split_statements(source)?;
    match statements.len() {
        1 => lex_statement_lines(&statements.remove(0)),
        0 => Err(ScriptError::at("expected a transformation step", 1, 1)),
        _ => {
            let second = &statements[1][0];
            Err(ScriptError::at(
                "expected one transformation step, but a second one starts here — indent a line \
                 to continue the step above it",
                second.number,
                1,
            ))
        }
    }
}

/// The characters that end a bare word.
fn is_word_stop(ch: char) -> bool {
    ch.is_whitespace() || matches!(ch, '"' | '[' | ']' | ',' | ':' | '=')
}

fn lex_statement_lines(lines: &[PhysicalLine]) -> Result<Statement, ScriptError> {
    let mut tokens: Vec<Token> = Vec::new();
    let start_line = lines[0].number;

    for (line_index, line) in lines.iter().enumerate() {
        let chars: Vec<char> = line.text.chars().collect();
        let mut i = 0usize;
        // A new physical line is whitespace as far as token adjacency goes.
        let mut pending_space = line_index > 0;

        // Column in the ORIGINAL source text, 1-based.
        let column_at = |offset: usize| offset + line.dedented + 1;

        while i < chars.len() {
            let ch = chars[i];
            if ch.is_whitespace() {
                pending_space = true;
                i += 1;
                continue;
            }
            let start = i;
            let preceded_by_space = pending_space;
            pending_space = false;

            match ch {
                ',' | ':' => {
                    tokens.push(Token {
                        kind: if ch == ',' {
                            TokenKind::Comma
                        } else {
                            TokenKind::Colon
                        },
                        text: ch.to_string(),
                        line: line.number,
                        column: column_at(start),
                        preceded_by_space,
                    });
                    i += 1;
                }
                '=' => {
                    let glued = !preceded_by_space
                        && tokens.last().is_some_and(|t| t.kind == TokenKind::Word);
                    if glued {
                        tokens.push(Token {
                            kind: TokenKind::Assign,
                            text: "=".to_string(),
                            line: line.number,
                            column: column_at(start),
                            preceded_by_space,
                        });
                        i += 1;
                        continue;
                    }
                    // Free-standing `=`: the rest of the statement is the raw
                    // expression tail. Exactly one following space is the
                    // separator, so a condition whose first line is indented
                    // survives verbatim.
                    let mut rest: String = chars[i + 1..].iter().collect();
                    let expr_column = if rest.starts_with(' ') {
                        rest.remove(0);
                        column_at(start) + 2
                    } else {
                        column_at(start) + 1
                    };
                    let mut expr = rest;
                    // Trailing whitespace-only continuation lines are dropped:
                    // a blank line someone left between two steps would
                    // otherwise be absorbed into the condition above it and
                    // report the pipeline as edited. The cost is that an
                    // expression stored with a trailing newline comes back
                    // without one; an INTERNAL blank line, which is what makes
                    // multi-line DAX readable, is preserved exactly.
                    let mut tail = &lines[line_index + 1..];
                    while let Some((last, rest)) = tail.split_last() {
                        if last.text.trim().is_empty() {
                            tail = rest;
                        } else {
                            break;
                        }
                    }
                    for continuation in tail {
                        expr.push('\n');
                        expr.push_str(&continuation.text);
                    }
                    return Ok(Statement {
                        line: start_line,
                        tokens,
                        expr: Some(expr),
                        expr_line: line.number,
                        expr_column,
                    });
                }
                ']' => {
                    return Err(ScriptError::at(
                        "unexpected ']' — a [name] must be opened before it is closed",
                        line.number,
                        column_at(start),
                    ));
                }
                '"' => {
                    let (text, next) = read_quoted(&chars, i, line, column_at(start))?;
                    i = next;
                    tokens.push(Token {
                        kind: TokenKind::Quoted,
                        text,
                        line: line.number,
                        column: column_at(start),
                        preceded_by_space,
                    });
                }
                '[' => {
                    let (text, next) = read_bracketed(&chars, i, line, column_at(start))?;
                    i = next;
                    tokens.push(Token {
                        kind: TokenKind::Bracketed,
                        text,
                        line: line.number,
                        column: column_at(start),
                        preceded_by_space,
                    });
                }
                _ => {
                    let (text, next) = read_word(&chars, i, line, column_at(start))?;
                    i = next;
                    tokens.push(Token {
                        kind: TokenKind::Word,
                        text,
                        line: line.number,
                        column: column_at(start),
                        preceded_by_space,
                    });
                }
            }
        }
    }

    Ok(Statement {
        line: start_line,
        tokens,
        expr: None,
        expr_line: start_line,
        expr_column: 1,
    })
}

/// Read a `"…"` string. `""` is a literal quote (the DAX/Excel convention the
/// CLI already uses); `\n` `\r` `\t` `\\` `\"` are the only backslash escapes,
/// and an unknown one is refused rather than silently passed through — an
/// escape set that quietly accepts anything is how two spellings of the same
/// character get baked into a corpus.
fn read_quoted(
    chars: &[char],
    start: usize,
    line: &PhysicalLine,
    column: usize,
) -> Result<(String, usize), ScriptError> {
    let mut out = String::new();
    let mut i = start + 1;
    while i < chars.len() {
        match chars[i] {
            '"' if chars.get(i + 1) == Some(&'"') => {
                out.push('"');
                i += 2;
            }
            '"' => return Ok((out, i + 1)),
            '\\' => {
                let next = chars.get(i + 1).copied().ok_or_else(|| {
                    ScriptError::at(
                        "a string ends with a lone '\\' — write '\\\\' for a backslash",
                        line.number,
                        i + line.dedented + 1,
                    )
                })?;
                let decoded = match next {
                    'n' => '\n',
                    'r' => '\r',
                    't' => '\t',
                    '\\' => '\\',
                    '"' => '"',
                    other => {
                        return Err(ScriptError::at(
                            format!(
                                "unknown escape '\\{other}' — the escapes are \\n \\r \\t \\\\ \
                                 and \\\" (a literal quote may also be written \"\")"
                            ),
                            line.number,
                            i + line.dedented + 1,
                        ));
                    }
                };
                out.push(decoded);
                i += 2;
            }
            ch => {
                out.push(ch);
                i += 1;
            }
        }
    }
    Err(ScriptError::at(
        "unterminated \"…\" string",
        line.number,
        column,
    ))
}

/// Read a `[…]` name, with `]]` for a literal `]` — accepted for familiarity
/// with the CLI and DAX, never emitted by the renderer.
fn read_bracketed(
    chars: &[char],
    start: usize,
    line: &PhysicalLine,
    column: usize,
) -> Result<(String, usize), ScriptError> {
    let mut out = String::new();
    let mut i = start + 1;
    while i < chars.len() {
        match chars[i] {
            ']' if chars.get(i + 1) == Some(&']') => {
                out.push(']');
                i += 2;
            }
            ']' => return Ok((out, i + 1)),
            ch => {
                out.push(ch);
                i += 1;
            }
        }
    }
    Err(ScriptError::at(
        "unterminated [ … ] name",
        line.number,
        column,
    ))
}

/// Read a bare word. A balanced `(…)` run is part of the word, which is what
/// lets `Decimal(18,2)` be one token despite the comma inside it.
fn read_word(
    chars: &[char],
    start: usize,
    line: &PhysicalLine,
    column: usize,
) -> Result<(String, usize), ScriptError> {
    let mut out = String::new();
    let mut i = start;
    while i < chars.len() {
        let ch = chars[i];
        if ch == '(' {
            let mut depth = 0usize;
            while i < chars.len() {
                let inner = chars[i];
                if inner == '(' {
                    depth += 1;
                } else if inner == ')' {
                    depth -= 1;
                }
                out.push(inner);
                i += 1;
                if depth == 0 {
                    break;
                }
            }
            if depth != 0 {
                return Err(ScriptError::at(
                    "unbalanced '(' — a type such as Decimal(18,2) must close its bracket",
                    line.number,
                    column,
                ));
            }
            continue;
        }
        if is_word_stop(ch) {
            break;
        }
        out.push(ch);
        i += 1;
    }
    if out.is_empty() {
        return Err(ScriptError::at(
            format!("unexpected character '{}'", chars[start]),
            line.number,
            column,
        ));
    }
    Ok((out, i))
}
