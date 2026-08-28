//! Text to steps.
//!
//! The parser checks **syntax only**. Every semantic rule — that `parts` is at
//! most 64, that an aggregate alias is unique, that `Mode` has no portable
//! spelling, that a filter is row-level — stays where it already lives, in
//! `rules_columns`/`rules_rows`/`validate`. That split is load-bearing in two
//! directions:
//!
//! * A script must never be able to reach a rule the step editor cannot. One
//!   validation path for every authoring surface is the property that makes the
//!   pipeline safe to accept from a `.calp` package.
//! * The renderer is total over the enum, so the parser must be too. If parsing
//!   refused a step that renders — `AggregateOp::Mode` is exactly such a step,
//!   legal to deserialize and rejected only at schema derivation — the renderer
//!   would emit text its own parser could not read. It renders, re-parses
//!   identically, and fails later on that step's own index, with the reason.
//!
//! # Tolerant in, canonical out
//!
//! Option keys match case-insensitively, the shipped command line's
//! abbreviations are accepted, `[bracketed]` names parse beside `"quoted"` ones,
//! and legacy single-rename / single-cast shapes are understood. None of it is
//! ever emitted: `render(parse(text)) == text` is not a property of this module,
//! and `parse(render(steps)) == steps` is.

use crate::compute::aggregate::AggregateOp;
use crate::transform::parts::{
    CastErrorPolicy, ColumnRename, GroupAggregate, RowRange, SortKey, TypeChange,
};
use crate::transform::TransformStep;
use crate::types::DataType;

use super::lex::{lex_one_statement, lex_script, Statement, Token, TokenKind};
use super::vocabulary::{
    option_for, parse_aggregate, parse_cast_error_policy, parse_data_type, parse_text_op,
    step_by_tag, StepVocabulary, PLACEMENT_OPTION,
};
use super::ScriptError;

/// A parsed statement together with where the author asked to put it.
///
/// `at` is part of the *editing* grammar rather than of a step: a script
/// carries position in the order of its statements, so the renderer never emits
/// it. The command line's `transform … add … at=3` does need it, which is why
/// one parser understands it rather than two parsers existing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlacedStep {
    /// The step the statement describes.
    pub step: TransformStep,
    /// A 1-based position, if the statement named one.
    pub at: Option<u32>,
}

/// Parse a whole applied-steps script into a pipeline.
///
/// An empty script (or one holding only comments and blank lines) is a valid
/// empty pipeline — which is how a pipeline is cleared from the script pane.
pub fn parse_script(source: &str) -> Result<Vec<TransformStep>, ScriptError> {
    lex_script(source)?
        .iter()
        .map(|statement| build_step(statement).map(|placed| placed.step))
        .collect()
}

/// Parse exactly one statement, as the command line's `transform … add` supplies
/// it. Any `at=` the statement carried is discarded; see [`parse_placed_statement`].
pub fn parse_statement(source: &str) -> Result<TransformStep, ScriptError> {
    parse_placed_statement(source).map(|placed| placed.step)
}

/// Parse exactly one statement, keeping any `at=` placement it named.
pub fn parse_placed_statement(source: &str) -> Result<PlacedStep, ScriptError> {
    build_step(&lex_one_statement(source)?)
}

// ---------------------------------------------------------------------------
// Value model
// ---------------------------------------------------------------------------

/// One atom of a value: a name, a number, a keyword, or an empty slot.
#[derive(Debug, Clone)]
struct Atom {
    text: String,
    /// Whether the atom was written quoted or bracketed. A quoted atom is a
    /// literal, so a leading `-` in it is part of the name rather than a sort
    /// direction.
    literal: bool,
    line: usize,
    column: usize,
}

/// One comma-separated element, itself a colon-separated run of atoms.
#[derive(Debug, Clone)]
struct Element {
    atoms: Vec<Atom>,
}

/// One option's value: a comma-separated list of elements.
#[derive(Debug, Clone)]
struct Value {
    elements: Vec<Element>,
    line: usize,
    column: usize,
}

/// One `key=value` occurrence read from a statement.
#[derive(Debug, Clone)]
struct RawOption {
    key: String,
    value: Value,
    line: usize,
    column: usize,
}

// ---------------------------------------------------------------------------
// Statement -> step
// ---------------------------------------------------------------------------

fn build_step(statement: &Statement) -> Result<PlacedStep, ScriptError> {
    let head = statement
        .tokens
        .first()
        .ok_or_else(|| ScriptError::at("expected a transformation step", statement.line, 1))?;
    if head.kind != TokenKind::Word {
        return Err(ScriptError::at(
            "a step starts with its name, such as filterRows or renameColumns",
            head.line,
            head.column,
        ));
    }
    let step_vocab = step_by_tag(&head.text)
        .ok_or_else(|| ScriptError::at(unknown_step_message(&head.text), head.line, head.column))?;

    let (mut options, at) = read_options(statement, step_vocab)?;
    normalize_legacy_shapes(step_vocab, &mut options)?;
    check_options(statement, step_vocab, &options)?;

    let expression = expression_of(statement, step_vocab)?;
    let step = assemble(step_vocab, &options, expression, statement)?;
    Ok(PlacedStep { step, at })
}

fn unknown_step_message(word: &str) -> String {
    // Name the near miss when there is one: the catalog is small and the
    // difference is usually a tense or a plural.
    let lowered = word.to_ascii_lowercase();
    let near = super::vocabulary::STEPS
        .iter()
        .find(|s| s.tag.to_ascii_lowercase().starts_with(&lowered))
        .or_else(|| {
            super::vocabulary::STEPS
                .iter()
                .find(|s| lowered.starts_with(&s.tag.to_ascii_lowercase()))
        });
    let catalog = super::vocabulary::STEPS
        .iter()
        .map(|s| s.tag)
        .collect::<Vec<_>>()
        .join(", ");
    match near {
        Some(step) => format!(
            "'{word}' is not a transformation step — did you mean {}? The steps are: {catalog}",
            step.tag
        ),
        None => match unsupported_hint(&lowered) {
            Some(hint) => hint,
            None => format!("'{word}' is not a transformation step. The steps are: {catalog}"),
        },
    }
}

/// Steps a Power Query user will reach for that this catalog deliberately does
/// not have. A bespoke refusal naming the reason beats "unknown step" — the
/// absence is a design decision, and the user should learn which one.
fn unsupported_hint(lowered: &str) -> Option<String> {
    let reason = match lowered {
        "promoteheaders" | "useheaders" | "firstrowasheader" => {
            "promoteHeaders is not a step: a step's output columns must be derivable without \
             reading rows, and the promoted names live in the data. Rename the columns with \
             renameColumns instead, or ask the source for a header row"
        }
        "merge" | "mergetable" | "join" => {
            "merging two tables is not yet a step. Until it is, join in the source query of a \
             SQL import, or build a calculated table"
        }
        "append" | "appendtable" | "union" => {
            "appending two tables is not yet a step. Until it is, union in the source query of a \
             SQL import, or build a calculated table"
        }
        "addindex" | "indexcolumn" | "rownumber" => {
            "an index column is not a step: its values depend on row order, which a pipeline does \
             not guarantee unless a sort step precedes it"
        }
        "transpose" => {
            "transposing is not a step: the output columns would come from the data rather than \
             from the schema. unpivot and pivot cover the reshaping that can be declared"
        }
        _ => return None,
    };
    Some(reason.to_string())
}

/// Read every `key=value` from a statement, pulling out the placement option.
fn read_options(
    statement: &Statement,
    step: &StepVocabulary,
) -> Result<(Vec<RawOption>, Option<u32>), ScriptError> {
    let tokens = &statement.tokens;
    let mut options = Vec::new();
    let mut at: Option<u32> = None;
    let mut i = 1usize;

    while i < tokens.len() {
        let key_token = &tokens[i];
        if key_token.kind != TokenKind::Word {
            return Err(ScriptError::at(
                format!(
                    "expected an option such as {}, but found '{}'",
                    example_option(step),
                    key_token.text
                ),
                key_token.line,
                key_token.column,
            ));
        }
        let assign = tokens.get(i + 1);
        if assign.map(|t| t.kind) != Some(TokenKind::Assign) {
            return Err(ScriptError::at(
                format!(
                    "'{}' is missing its value — options are written key=value, for example {}",
                    key_token.text,
                    example_option(step)
                ),
                key_token.line,
                key_token.column,
            ));
        }
        let (value, next) = read_value(tokens, i + 2, key_token)?;
        i = next;

        if key_token.text.eq_ignore_ascii_case(PLACEMENT_OPTION) {
            at = Some(read_placement(&value)?);
            continue;
        }
        options.push(RawOption {
            key: key_token.text.clone(),
            value,
            line: key_token.line,
            column: key_token.column,
        });
    }
    Ok((options, at))
}

fn example_option(step: &StepVocabulary) -> String {
    match step.options.first() {
        Some(option) => format!("{}=…", option.key),
        None if step.takes_expression => "= <expression>".to_string(),
        None => "no options".to_string(),
    }
}

/// Read one option's value run. The run ends at the first value token that does
/// not follow a separator — which is what lets `nameColumn=month valueColumn=x`
/// split without a terminator character.
fn read_value(tokens: &[Token], start: usize, key: &Token) -> Result<(Value, usize), ScriptError> {
    let mut elements: Vec<Element> = vec![Element { atoms: Vec::new() }];
    let mut i = start;
    let mut expecting_atom = true;
    let (line, column) = tokens
        .get(start)
        .map(|t| (t.line, t.column))
        .unwrap_or((key.line, key.column));

    loop {
        let Some(token) = tokens.get(i) else { break };
        match token.kind {
            TokenKind::Comma | TokenKind::Colon if !expecting_atom => {
                if token.kind == TokenKind::Comma {
                    elements.push(Element { atoms: Vec::new() });
                } // a colon just opens the next atom slot of this element
                expecting_atom = true;
                i += 1;
            }
            TokenKind::Comma | TokenKind::Colon => {
                // Two separators in a row: the slot between them is empty, which
                // is how `agg=CountRows::orders` names no input column.
                push_atom(
                    &mut elements,
                    Atom {
                        text: String::new(),
                        literal: false,
                        line: token.line,
                        column: token.column,
                    },
                );
                expecting_atom = false;
            }
            TokenKind::Assign => break,
            _ if expecting_atom => {
                push_atom(
                    &mut elements,
                    Atom {
                        text: token.text.clone(),
                        literal: token.kind != TokenKind::Word,
                        line: token.line,
                        column: token.column,
                    },
                );
                expecting_atom = false;
                i += 1;
            }
            _ => {
                if !token.preceded_by_space {
                    return Err(ScriptError::at(
                        format!(
                            "'{}' runs straight into the value before it — separate list entries \
                             with a comma, or quote the whole value",
                            token.text
                        ),
                        token.line,
                        token.column,
                    ));
                }
                break;
            }
        }
    }

    if expecting_atom {
        // A trailing separator leaves one empty slot, which is a real (empty)
        // entry rather than something to silently drop.
        if let Some(last) = tokens.get(i.saturating_sub(1)) {
            push_atom(
                &mut elements,
                Atom {
                    text: String::new(),
                    literal: false,
                    line: last.line,
                    column: last.column,
                },
            );
        }
    }
    if elements.len() == 1 && elements[0].atoms.is_empty() {
        elements.clear();
    }
    Ok((
        Value {
            elements,
            line,
            column,
        },
        i,
    ))
}

fn push_atom(elements: &mut [Element], atom: Atom) {
    if let Some(last) = elements.last_mut() {
        last.atoms.push(atom);
    }
}

fn read_placement(value: &Value) -> Result<u32, ScriptError> {
    let atom = value.single_atom("at")?;
    atom.text.trim().parse::<u32>().map_err(|_| {
        ScriptError::at(
            format!("at= takes a 1-based step position, not '{}'", atom.text),
            atom.line,
            atom.column,
        )
    })
}

// ---------------------------------------------------------------------------
// Legacy shapes and option checking
// ---------------------------------------------------------------------------

/// Rewrite the command line's single-rename and single-cast spellings into the
/// canonical repeatable form, so the builders below see one shape.
fn normalize_legacy_shapes(
    step: &StepVocabulary,
    options: &mut Vec<RawOption>,
) -> Result<(), ScriptError> {
    match step.tag {
        "renameColumns" => {
            let from = take_option(options, "column");
            let to = take_option(options, "newname");
            match (from, to) {
                (Some(from), Some(to)) => {
                    let from_atom = from.value.single_atom("column")?.clone();
                    let to_atom = to.value.single_atom("newname")?.clone();
                    options.push(RawOption {
                        key: "rename".to_string(),
                        value: Value {
                            elements: vec![Element {
                                atoms: vec![from_atom, to_atom],
                            }],
                            line: from.line,
                            column: from.column,
                        },
                        line: from.line,
                        column: from.column,
                    });
                }
                (Some(orphan), None) | (None, Some(orphan)) => {
                    return Err(ScriptError::at(
                        "a rename needs both a column and its new name — write \
                         rename=oldName:newName",
                        orphan.line,
                        orphan.column,
                    ));
                }
                (None, None) => {}
            }
        }
        "changeType" => {
            let single = take_option(options, "column");
            let many = take_option(options, "columns");
            let target = take_option(options, "type");
            let anchor = single
                .as_ref()
                .or(many.as_ref())
                .or(target.as_ref())
                .map(|o| (o.line, o.column));
            let mut columns: Vec<Atom> = Vec::new();
            if let Some(one) = &single {
                columns.push(one.value.single_atom("column")?.clone());
            }
            if let Some(list) = &many {
                for element in &list.value.elements {
                    columns.push(element.only_atom("columns")?.clone());
                }
            }
            if columns.is_empty() && target.is_none() {
                return Ok(());
            }
            let Some(target) = target else {
                let (line, column) = anchor.unwrap_or((0, 0));
                return Err(ScriptError::at(
                    "a cast needs the type to cast to — write cast=column:Int64",
                    line,
                    column,
                ));
            };
            let type_atom = target.value.single_atom("type")?.clone();
            if columns.is_empty() {
                return Err(ScriptError::at(
                    "a cast needs the column to cast — write cast=column:Int64",
                    target.line,
                    target.column,
                ));
            }
            for column in columns {
                let (line, column_pos) = (column.line, column.column);
                options.push(RawOption {
                    key: "cast".to_string(),
                    value: Value {
                        elements: vec![Element {
                            atoms: vec![column, type_atom.clone()],
                        }],
                        line,
                        column: column_pos,
                    },
                    line,
                    column: column_pos,
                });
            }
        }
        _ => {}
    }
    Ok(())
}

fn take_option(options: &mut Vec<RawOption>, key: &str) -> Option<RawOption> {
    let index = options
        .iter()
        .position(|o| o.key.eq_ignore_ascii_case(key))?;
    Some(options.remove(index))
}

/// Refuse an option that means nothing to this step, and a repeat of one that
/// may only appear once. Without the first check a `filterRows` statement would
/// silently swallow `column=`.
fn check_options(
    statement: &Statement,
    step: &StepVocabulary,
    options: &[RawOption],
) -> Result<(), ScriptError> {
    let mut seen: Vec<&'static str> = Vec::new();
    for option in options {
        let Some(spec) = option_for(step, &option.key) else {
            let accepted = if step.options.is_empty() {
                if step.takes_expression {
                    "it takes only an '= <expression>'".to_string()
                } else {
                    "it takes no options".to_string()
                }
            } else {
                format!(
                    "it accepts: {}",
                    step.options
                        .iter()
                        .map(|o| format!("{}=", o.key))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            };
            return Err(ScriptError::at(
                format!(
                    "'{}=' does not apply to a {} step — {accepted}",
                    option.key, step.tag
                ),
                option.line,
                option.column,
            ));
        };
        if !spec.repeatable && seen.contains(&spec.key) {
            return Err(ScriptError::at(
                format!("'{}=' is given more than once", spec.key),
                option.line,
                option.column,
            ));
        }
        seen.push(spec.key);
    }
    for spec in step.options {
        if spec.optional || seen.contains(&spec.key) {
            continue;
        }
        return Err(ScriptError::at(
            format!("a {} step needs {}= ({})", step.tag, spec.key, spec.help),
            statement.line,
            1,
        ));
    }
    Ok(())
}

fn expression_of(
    statement: &Statement,
    step: &StepVocabulary,
) -> Result<Option<String>, ScriptError> {
    match (&statement.expr, step.takes_expression) {
        (Some(expression), true) => Ok(Some(expression.clone())),
        (None, true) => Err(ScriptError::at(
            format!(
                "a {} step needs '= <expression>' after its options",
                step.tag
            ),
            statement.line,
            1,
        )),
        (Some(_), false) => Err(ScriptError::at(
            format!(
                "a {} step takes no '= <expression>' — only filterRows and addColumn do",
                step.tag
            ),
            statement.expr_line,
            statement.expr_column,
        )),
        (None, false) => Ok(None),
    }
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

impl Value {
    /// The single atom of a single-element value.
    fn single_atom(&self, key: &str) -> Result<&Atom, ScriptError> {
        let element = match self.elements.len() {
            1 => &self.elements[0],
            0 => {
                return Err(ScriptError::at(
                    format!("{key}= has no value"),
                    self.line,
                    self.column,
                ))
            }
            _ => {
                return Err(ScriptError::at(
                    format!("{key}= takes a single value, not a list"),
                    self.line,
                    self.column,
                ))
            }
        };
        element.only_atom(key)
    }

    /// Every element as a single atom — a plain list of names.
    fn name_list(&self, key: &str) -> Result<Vec<String>, ScriptError> {
        self.elements
            .iter()
            .map(|element| element.only_atom(key).map(|atom| atom.text.clone()))
            .collect()
    }
}

impl Element {
    fn only_atom(&self, key: &str) -> Result<&Atom, ScriptError> {
        match self.atoms.len() {
            1 => Ok(&self.atoms[0]),
            0 => Err(ScriptError::at(format!("{key}= has an empty entry"), 0, 0)),
            _ => {
                let extra = &self.atoms[1];
                Err(ScriptError::at(
                    format!("{key}= takes plain names here, but this entry has a ':' in it"),
                    extra.line,
                    extra.column,
                ))
            }
        }
    }

    fn atom_at(&self, index: usize, what: &str) -> Result<&Atom, ScriptError> {
        self.atoms.get(index).ok_or_else(|| {
            let anchor = self.atoms.last();
            ScriptError::at(
                format!("expected {what} here"),
                anchor.map(|a| a.line).unwrap_or(0),
                anchor.map(|a| a.column).unwrap_or(0),
            )
        })
    }
}

fn find<'a>(options: &'a [RawOption], key: &str) -> Option<&'a RawOption> {
    options.iter().find(|o| o.key.eq_ignore_ascii_case(key))
}

/// Every occurrence of a repeatable option, in the order they were written.
fn find_all<'a>(options: &'a [RawOption], keys: &[&str]) -> Vec<&'a RawOption> {
    options
        .iter()
        .filter(|o| keys.iter().any(|k| o.key.eq_ignore_ascii_case(k)))
        .collect()
}

fn names(options: &[RawOption], keys: &[&str]) -> Result<Vec<String>, ScriptError> {
    match find_all(options, keys).first() {
        Some(option) => option.value.name_list(&option.key),
        None => Ok(Vec::new()),
    }
}

fn text(options: &[RawOption], key: &str) -> Result<String, ScriptError> {
    match find(options, key) {
        Some(option) => Ok(option.value.single_atom(key)?.text.clone()),
        None => Ok(String::new()),
    }
}

fn flag(options: &[RawOption], keys: &[&str]) -> Result<bool, ScriptError> {
    let Some(option) = find_all(options, keys).first().copied() else {
        return Ok(false);
    };
    let atom = option.value.single_atom(&option.key)?;
    match atom.text.trim().to_ascii_lowercase().as_str() {
        "true" | "yes" | "1" | "on" => Ok(true),
        "false" | "no" | "0" | "off" => Ok(false),
        other => Err(ScriptError::at(
            format!("{}= takes true or false, not '{other}'", option.key),
            atom.line,
            atom.column,
        )),
    }
}

fn integer(options: &[RawOption], key: &str) -> Result<u64, ScriptError> {
    let Some(option) = find(options, key) else {
        return Ok(0);
    };
    let atom = option.value.single_atom(key)?;
    atom.text.trim().parse::<u64>().map_err(|_| {
        ScriptError::at(
            format!("{key}= takes a whole number, not '{}'", atom.text),
            atom.line,
            atom.column,
        )
    })
}

fn data_type_of(atom: &Atom) -> Result<DataType, ScriptError> {
    parse_data_type(&atom.text).ok_or_else(|| {
        ScriptError::at(
            format!(
                "'{}' is not a column type — the types are {}",
                atom.text,
                super::vocabulary::DATA_TYPE_NAMES.join(", ")
            ),
            atom.line,
            atom.column,
        )
    })
}

fn aggregate_of(atom: &Atom) -> Result<AggregateOp, ScriptError> {
    parse_aggregate(&atom.text).ok_or_else(|| {
        ScriptError::at(
            format!(
                "'{}' is not an aggregate — they are {}",
                atom.text,
                super::vocabulary::AGGREGATE_NAMES.join(", ")
            ),
            atom.line,
            atom.column,
        )
    })
}

fn sort_key_of(element: &Element) -> Result<SortKey, ScriptError> {
    let column = element.atom_at(0, "a column to sort by")?;
    let descending = match element.atoms.get(1) {
        Some(direction) => match direction.text.trim().to_ascii_lowercase().as_str() {
            "desc" | "descending" => true,
            "asc" | "ascending" => false,
            other => {
                return Err(ScriptError::at(
                    format!("'{other}' is not a sort direction — write asc or desc"),
                    direction.line,
                    direction.column,
                ))
            }
        },
        None => false,
    };
    if element.atoms.len() > 2 {
        let extra = &element.atoms[2];
        return Err(ScriptError::at(
            "a sort key is a column, optionally followed by :asc or :desc",
            extra.line,
            extra.column,
        ));
    }
    // A leading '-' means descending only on an UNQUOTED name; a column whose
    // own name starts with '-' is never bare, so it always arrives quoted and
    // keeps its dash.
    if !column.literal {
        if let Some(rest) = column.text.strip_prefix('-') {
            return Ok(SortKey {
                column: rest.to_string(),
                descending: true,
            });
        }
        if let Some(rest) = column.text.strip_prefix('+') {
            return Ok(SortKey {
                column: rest.to_string(),
                descending,
            });
        }
    }
    Ok(SortKey {
        column: column.text.clone(),
        descending,
    })
}

fn row_range_of(option: &RawOption) -> Result<RowRange, ScriptError> {
    let element = match option.value.elements.len() {
        1 => &option.value.elements[0],
        _ => {
            return Err(ScriptError::at(
                "range= takes one range: first:N, last:N or range:OFFSET:COUNT",
                option.value.line,
                option.value.column,
            ))
        }
    };
    let kind = element.atom_at(0, "first, last or range")?;
    let number = |atom: &Atom| -> Result<u64, ScriptError> {
        atom.text.trim().parse::<u64>().map_err(|_| {
            ScriptError::at(
                format!("'{}' is not a whole number of rows", atom.text),
                atom.line,
                atom.column,
            )
        })
    };
    match kind.text.trim().to_ascii_lowercase().as_str() {
        "first" | "firstn" => Ok(RowRange::FirstN {
            count: number(element.atom_at(1, "a row count, as in first:100")?)?,
        }),
        "last" | "lastn" => Ok(RowRange::LastN {
            count: number(element.atom_at(1, "a row count, as in last:100")?)?,
        }),
        "range" => Ok(RowRange::Range {
            offset: number(element.atom_at(1, "an offset, as in range:10:100")?)?,
            count: number(element.atom_at(2, "a row count, as in range:10:100")?)?,
        }),
        other => Err(ScriptError::at(
            format!("'{other}' is not a range — write first:N, last:N or range:OFFSET:COUNT"),
            kind.line,
            kind.column,
        )),
    }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

fn assemble(
    step: &StepVocabulary,
    options: &[RawOption],
    expression: Option<String>,
    statement: &Statement,
) -> Result<TransformStep, ScriptError> {
    let step = match step.tag {
        "removeColumns" => TransformStep::RemoveColumns {
            columns: names(options, &["columns"])?,
        },
        "selectColumns" => TransformStep::SelectColumns {
            columns: names(options, &["columns"])?,
        },
        "renameColumns" => TransformStep::RenameColumns {
            renames: find_all(options, &["rename", "renames"])
                .iter()
                .flat_map(|option| option.value.elements.iter())
                .map(|element| {
                    Ok(ColumnRename::new(
                        element.atom_at(0, "the column to rename")?.text.clone(),
                        element
                            .atom_at(1, "the new name, as in rename=old:new")?
                            .text
                            .clone(),
                    ))
                })
                .collect::<Result<Vec<_>, ScriptError>>()?,
        },
        "changeType" => TransformStep::ChangeType {
            changes: find_all(options, &["cast", "changes"])
                .iter()
                .flat_map(|option| option.value.elements.iter())
                .map(|element| {
                    Ok(TypeChange::new(
                        element.atom_at(0, "the column to cast")?.text.clone(),
                        data_type_of(element.atom_at(1, "a type, as in cast=qty:Int64")?)?,
                    ))
                })
                .collect::<Result<Vec<_>, ScriptError>>()?,
            on_error: match find(options, "onError") {
                Some(option) => {
                    let atom = option.value.single_atom("onError")?;
                    parse_cast_error_policy(&atom.text).ok_or_else(|| {
                        ScriptError::at(
                            format!("onError= takes fail or null, not '{}'", atom.text),
                            atom.line,
                            atom.column,
                        )
                    })?
                }
                None => CastErrorPolicy::default(),
            },
        },
        "filterRows" => TransformStep::FilterRows {
            condition: expression.unwrap_or_default(),
        },
        "addColumn" => TransformStep::AddColumn {
            name: text(options, "name")?,
            expression: expression.unwrap_or_default(),
            data_type: match find_all(options, &["dataType", "type"]).first() {
                Some(option) => Some(data_type_of(option.value.single_atom(&option.key)?)?),
                None => None,
            },
        },
        "transformColumn" => TransformStep::TransformColumn {
            column: text(options, "column")?,
            expression: expression.unwrap_or_default(),
            data_type: match find_all(options, &["dataType", "type"]).first() {
                Some(option) => Some(data_type_of(option.value.single_atom(&option.key)?)?),
                None => None,
            },
        },
        "splitColumn" => TransformStep::SplitColumn {
            column: text(options, "column")?,
            delimiter: text(options, "delimiter")?,
            parts: u32::try_from(integer(options, "parts")?).map_err(|_| {
                ScriptError::at(
                    "parts= is too large to be a column count",
                    statement.line,
                    1,
                )
            })?,
            keep_original: flag(options, &["keepOriginal"])?,
        },
        "replaceValues" => TransformStep::ReplaceValues {
            column: text(options, "column")?,
            find: text(options, "find")?,
            replace: text(options, "replace")?,
            match_entire_value: flag(options, &["matchEntireValue", "matchentire"])?,
        },
        "textTransform" => TransformStep::TextTransform {
            columns: names(options, &["columns"])?,
            operation: {
                let option = find(options, "operation").ok_or_else(|| {
                    ScriptError::at(
                        "a textTransform step needs operation=trim, clean, upper or lower",
                        statement.line,
                        1,
                    )
                })?;
                let atom = option.value.single_atom("operation")?;
                parse_text_op(&atom.text).ok_or_else(|| {
                    ScriptError::at(
                        format!(
                            "'{}' is not a text operation — they are {}",
                            atom.text,
                            super::vocabulary::TEXT_OP_NAMES.join(", ")
                        ),
                        atom.line,
                        atom.column,
                    )
                })?
            },
        },
        "fillDown" => TransformStep::FillDown {
            columns: names(options, &["columns"])?,
        },
        "removeDuplicates" => TransformStep::RemoveDuplicates {
            columns: names(options, &["columns"])?,
        },
        "sort" => TransformStep::Sort {
            by: match find(options, "by") {
                Some(option) => option
                    .value
                    .elements
                    .iter()
                    .map(sort_key_of)
                    .collect::<Result<Vec<_>, ScriptError>>()?,
                None => Vec::new(),
            },
        },
        "groupBy" => TransformStep::GroupBy {
            group_by: names(options, &["groupBy"])?,
            aggregates: {
                // ONE pass over the options in the order they were WRITTEN. A
                // pipeline mixing `agg=` and `aggFormula=` carries its
                // aggregate order in that interleaving — collecting each key
                // separately would silently reorder the output columns, and
                // `parse(render(s)) == s` would be the first casualty.
                let mut aggregates = Vec::new();
                for option in find_all(options, &["agg", "aggregates", "aggFormula"]) {
                    let is_formula = option.key.eq_ignore_ascii_case("aggFormula");
                    for element in &option.value.elements {
                        if is_formula {
                            aggregates.push(GroupAggregate {
                                function: aggregate_of(element.atom_at(
                                    0,
                                    "an aggregate, as in aggFormula=Sum:\"IF(...)\":total",
                                )?)?,
                                column: String::new(),
                                expression: Some(
                                    element
                                        .atom_at(
                                            1,
                                            "the formula, quoted, as in \
                                             aggFormula=Sum:\"IF(...)\":total",
                                        )?
                                        .text
                                        .clone(),
                                ),
                                alias: element
                                    .atom_at(
                                        2,
                                        "the output column name, as in \
                                         aggFormula=Sum:\"IF(...)\":total",
                                    )?
                                    .text
                                    .clone(),
                            });
                        } else {
                            aggregates.push(GroupAggregate {
                                function: aggregate_of(
                                    element
                                        .atom_at(0, "an aggregate, as in agg=Sum:amount:total")?,
                                )?,
                                column: element
                                    .atom_at(1, "the column to aggregate (empty for CountRows)")?
                                    .text
                                    .clone(),
                                expression: None,
                                alias: element
                                    .atom_at(
                                        2,
                                        "the output column name, as in agg=Sum:amount:total",
                                    )?
                                    .text
                                    .clone(),
                            });
                        }
                    }
                }
                aggregates
            },
        },
        "keepRows" => TransformStep::KeepRows {
            range: row_range_of(find(options, "range").ok_or_else(|| {
                ScriptError::at(
                    "a keepRows step needs range=first:N, last:N or range:OFFSET:COUNT",
                    statement.line,
                    1,
                )
            })?)?,
        },
        "removeRows" => TransformStep::RemoveRows {
            range: row_range_of(find(options, "range").ok_or_else(|| {
                ScriptError::at(
                    "a removeRows step needs range=first:N, last:N or range:OFFSET:COUNT",
                    statement.line,
                    1,
                )
            })?)?,
        },
        "unpivot" => TransformStep::Unpivot {
            columns: names(options, &["columns"])?,
            name_column: text(options, "nameColumn")?,
            value_column: text(options, "valueColumn")?,
        },
        "pivot" => TransformStep::Pivot {
            name_column: text(options, "nameColumn")?,
            value_column: text(options, "valueColumn")?,
            aggregate: {
                let option = find(options, "aggregate").ok_or_else(|| {
                    ScriptError::at(
                        "a pivot step needs aggregate=Sum (or another aggregate)",
                        statement.line,
                        1,
                    )
                })?;
                aggregate_of(option.value.single_atom("aggregate")?)?
            },
            value_names: names(options, &["valueNames", "values"])?,
        },
        other => {
            // Unreachable while `step_by_tag` and this match are built from the
            // same table; stated as an error rather than a panic because
            // engine-core does not panic in library code.
            return Err(ScriptError::at(
                format!("'{other}' has no builder"),
                statement.line,
                1,
            ));
        }
    };
    Ok(step)
}
