//! Steps to text.
//!
//! The renderer is one exhaustive `match` over [`TransformStep`] in which **no
//! arm destructures with `..`**. That is deliberate and is the module's primary
//! drift guard on two axes at once: an 18th *variant* fails to compile here, and
//! a new *field* on an existing variant fails to compile here too, because a
//! total destructuring names every field. A renderer arm written `Sort { by, .. }`
//! would compile forever while silently dropping whatever was added beside `by` —
//! a step that reads back subtly different from the one that was saved, which is
//! a data-integrity defect rather than a cosmetic one.
//!
//! Defaults are **omitted**, mirroring the step enum's `skip_serializing_if`
//! exactly, so the text says what the JSON says. An omitted `columns=` on
//! `removeDuplicates` is a meaning (every column), not an absence.

use crate::transform::parts::{CastErrorPolicy, RowRange, SortKey};
use crate::transform::TransformStep;

use super::vocabulary::{render_aggregate, render_cast_error_policy, render_data_type};

/// How wide a single-line statement may be before its options are broken onto
/// their own lines. Chosen to keep a statement readable in a side-by-side diff.
const WRAP_COLUMN: usize = 80;

/// The indent a continuation line carries, on top of the one marker space the
/// parser strips.
const INDENT: &str = "  ";

/// Render a whole pipeline as an applied-steps script.
///
/// Statements are separated by a blank line and appear in pipeline order — the
/// order *is* the meaning, so moving a statement moves the step. The result
/// always parses back to exactly the steps it was given; see
/// [`parse_script`](super::parse_script) for the direction that is not
/// guaranteed.
pub fn render_script(steps: &[TransformStep]) -> String {
    steps
        .iter()
        .map(render_statement)
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Render one step as one statement, which may span several lines.
pub fn render_statement(step: &TransformStep) -> String {
    let (options, expression) = statement_parts(step);
    let tag = step.type_name();

    // Repeatable options always break, so a pipeline diff shows one changed
    // rename or cast as one changed line rather than one changed long line.
    let force_break = repeatable_count(step) > 1;
    let single = assemble_single_line(tag, &options, expression.as_deref());
    // Only the FIRST line decides the wrap: a multi-line condition already
    // reads well inline, and breaking on its total length would push every
    // `filterRows` onto a lonely `=` line for no gain.
    let first_line_width = single.split('\n').next().unwrap_or("").chars().count();
    if !force_break && first_line_width <= WRAP_COLUMN {
        return single;
    }

    let mut out = String::from(tag);
    for option in &options {
        out.push('\n');
        out.push_str(INDENT);
        out.push_str(option);
    }
    if let Some(expression) = expression {
        out.push('\n');
        out.push_str(INDENT);
        out.push_str("= ");
        out.push_str(&indent_expression_tail(&expression));
    }
    out
}

fn assemble_single_line(tag: &str, options: &[String], expression: Option<&str>) -> String {
    let mut out = String::from(tag);
    for option in options {
        out.push(' ');
        out.push_str(option);
    }
    if let Some(expression) = expression {
        out.push_str(" = ");
        out.push_str(&indent_expression_tail(expression));
    }
    out
}

/// Prefix every line after the first with exactly one space, which is what makes
/// it a continuation the parser will strip back off. A stored blank line becomes
/// a line holding one space — still a continuation, where a zero-length line
/// would have ended the statement.
fn indent_expression_tail(expression: &str) -> String {
    let mut lines = expression.split('\n');
    let mut out = String::from(lines.next().unwrap_or(""));
    for line in lines {
        out.push('\n');
        out.push(' ');
        out.push_str(line);
    }
    out
}

/// How many occurrences of a repeatable option this step will render.
fn repeatable_count(step: &TransformStep) -> usize {
    match step {
        TransformStep::RenameColumns { renames } => renames.len(),
        TransformStep::ChangeType { changes, .. } => changes.len(),
        TransformStep::GroupBy { aggregates, .. } => aggregates.len(),
        TransformStep::LookupColumn { keys, takes, .. } => keys.len() + takes.len(),
        _ => 0,
    }
}

/// The rendered `key=value` options and the expression tail for one step.
///
/// EXHAUSTIVE AND TOTAL: every arm names every field. Do not add `..`.
fn statement_parts(step: &TransformStep) -> (Vec<String>, Option<String>) {
    match step {
        TransformStep::RemoveColumns { columns } => (vec_opt("columns", columns), None),
        TransformStep::SelectColumns { columns } => (vec_opt("columns", columns), None),
        TransformStep::RenameColumns { renames } => (
            renames
                .iter()
                .map(|r| format!("rename={}:{}", name(&r.from), name(&r.to)))
                .collect(),
            None,
        ),
        TransformStep::ChangeType { changes, on_error } => {
            let mut options: Vec<String> = changes
                .iter()
                .map(|c| format!("cast={}:{}", name(&c.column), render_data_type(&c.new_type)))
                .collect();
            if *on_error != CastErrorPolicy::default() {
                options.push(format!("onError={}", render_cast_error_policy(on_error)));
            }
            (options, None)
        }
        TransformStep::FilterRows { condition } => (Vec::new(), Some(condition.clone())),
        TransformStep::AddColumn {
            name: column_name,
            expression,
            data_type,
        } => {
            let mut options = vec![format!("name={}", name(column_name))];
            if let Some(data_type) = data_type {
                options.push(format!("dataType={}", render_data_type(data_type)));
            }
            (options, Some(expression.clone()))
        }
        TransformStep::TransformColumn {
            column,
            expression,
            data_type,
        } => {
            let mut options = vec![format!("column={}", name(column))];
            if let Some(data_type) = data_type {
                options.push(format!("dataType={}", render_data_type(data_type)));
            }
            (options, Some(expression.clone()))
        }
        TransformStep::LookupColumn {
            table: target,
            keys,
            takes,
        } => {
            let mut options = vec![format!("table={}", name(target))];
            for key in keys {
                options.push(format!("on={}:{}", name(&key.host), name(&key.target)));
            }
            for take in takes {
                // `take=col` when the name is kept, `take=col:newName` when it
                // is not — mirroring serde, which omits an absent outputName.
                options.push(match &take.output_name {
                    Some(output) => format!("take={}:{}", name(&take.column), name(output)),
                    None => format!("take={}", name(&take.column)),
                });
            }
            (options, None)
        }
        TransformStep::SplitColumn {
            column,
            delimiter,
            parts,
            keep_original,
        } => {
            let mut options = vec![
                format!("column={}", name(column)),
                format!("delimiter={}", quote(delimiter)),
                format!("parts={parts}"),
            ];
            if *keep_original {
                options.push("keepOriginal=true".to_string());
            }
            (options, None)
        }
        TransformStep::ReplaceValues {
            column,
            find,
            replace,
            match_entire_value,
        } => {
            let mut options = vec![
                format!("column={}", name(column)),
                format!("find={}", quote(find)),
                format!("replace={}", quote(replace)),
            ];
            if *match_entire_value {
                options.push("matchEntireValue=true".to_string());
            }
            (options, None)
        }
        TransformStep::TextTransform { columns, operation } => {
            let mut options = vec_opt("columns", columns);
            options.push(format!("operation={}", operation.as_str()));
            (options, None)
        }
        TransformStep::FillDown { columns } => (vec_opt("columns", columns), None),
        TransformStep::RemoveDuplicates { columns } => (vec_opt("columns", columns), None),
        TransformStep::Sort { by } => (
            if by.is_empty() {
                Vec::new()
            } else {
                vec![format!(
                    "by={}",
                    by.iter().map(render_sort_key).collect::<Vec<_>>().join(",")
                )]
            },
            None,
        ),
        TransformStep::GroupBy {
            group_by,
            aggregates,
        } => {
            let mut options = vec_opt("groupBy", group_by);
            for aggregate in aggregates {
                match &aggregate.expression {
                    // The SUMIF shape: the operand slot carries a QUOTED
                    // formula under its own key. Same three-atom shape as
                    // `agg=` (function : operand : alias), so the two read as
                    // one family; quoting is what lets the formula hold
                    // commas, colons and its own string literals.
                    Some(expression) => options.push(format!(
                        "aggFormula={}:{}:{}",
                        render_aggregate(&aggregate.function),
                        quote(expression),
                        name(&aggregate.alias)
                    )),
                    // A `CountRows` aggregate carries no input column, and the
                    // empty slot is written as nothing between the two colons —
                    // `agg=CountRows::orders` — matching what the command line
                    // already accepts. An empty atom and an empty string are
                    // the same value, so this still round-trips.
                    None => options.push(format!(
                        "agg={}:{}:{}",
                        render_aggregate(&aggregate.function),
                        name_or_empty(&aggregate.column),
                        name(&aggregate.alias)
                    )),
                }
            }
            (options, None)
        }
        TransformStep::KeepRows { range } => (vec![format!("range={}", render_range(range))], None),
        TransformStep::RemoveRows { range } => {
            (vec![format!("range={}", render_range(range))], None)
        }
        TransformStep::Unpivot {
            columns,
            name_column,
            value_column,
        } => {
            let mut options = vec_opt("columns", columns);
            options.push(format!("nameColumn={}", name(name_column)));
            options.push(format!("valueColumn={}", name(value_column)));
            (options, None)
        }
        TransformStep::Pivot {
            name_column,
            value_column,
            aggregate,
            value_names,
        } => {
            let mut options = vec![
                format!("nameColumn={}", name(name_column)),
                format!("valueColumn={}", name(value_column)),
                format!("aggregate={}", render_aggregate(aggregate)),
            ];
            options.extend(vec_opt("valueNames", value_names));
            (options, None)
        }
    }
}

/// A list option, omitted entirely when the list is empty — an empty list and
/// an absent option must mean the same thing, or the round trip breaks.
fn vec_opt(key: &str, values: &[String]) -> Vec<String> {
    if values.is_empty() {
        return Vec::new();
    }
    vec![format!(
        "{key}={}",
        values.iter().map(|v| name(v)).collect::<Vec<_>>().join(",")
    )]
}

fn render_sort_key(key: &SortKey) -> String {
    // The compact `-column` form only works when the column renders bare; a
    // column that needs quoting takes the explicit `:desc` suffix instead, and
    // a column whose own name starts with '-' is never bare, so the two can
    // never be confused.
    match (key.descending, is_bare(&key.column)) {
        (false, _) => name(&key.column),
        (true, true) => format!("-{}", key.column),
        (true, false) => format!("{}:desc", quote(&key.column)),
    }
}

fn render_range(range: &RowRange) -> String {
    match range {
        RowRange::FirstN { count } => format!("first:{count}"),
        RowRange::LastN { count } => format!("last:{count}"),
        RowRange::Range { offset, count } => format!("range:{offset}:{count}"),
    }
}

/// Render an identifier, leaving an empty one as an empty slot rather than as
/// `""`. Only used where an empty atom is the established spelling.
fn name_or_empty(text: &str) -> String {
    if text.is_empty() {
        String::new()
    } else {
        name(text)
    }
}

/// Render an identifier: bare when it can be, quoted otherwise.
pub(crate) fn name(text: &str) -> String {
    if is_bare(text) {
        text.to_string()
    } else {
        quote(text)
    }
}

/// Whether a value can be written without quotes.
///
/// Dots are allowed **inside** a bare name because `splitColumn` generates
/// `region.1` itself — a grammar that read a dot as a path separator would fail
/// on its own output.
pub(crate) fn is_bare(text: &str) -> bool {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() || first == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
}

/// Render a `"…"` string. A literal quote is doubled (the convention the model
/// tokenizer and the CLI already use); the only backslash escapes emitted are
/// the four that cannot survive as themselves inside a line-oriented grammar.
pub(crate) fn quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\"\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}
