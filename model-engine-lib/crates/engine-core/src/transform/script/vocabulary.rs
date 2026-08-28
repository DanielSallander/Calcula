//! The script's word list: which options each step tag accepts, which serde
//! field each writes, and how every enum is spelled.
//!
//! This table is the **single** declaration of the surface vocabulary. The
//! renderer emits from it, the parser reads against it, the host serves it to
//! the editor for completion and highlighting, and
//! `every_serialized_field_has_a_spelling` diffs it against what the enum
//! actually serializes — so a field added to a step without a spelling here
//! fails a test that names the field, rather than being silently dropped by a
//! renderer arm that destructured with `..`.
//!
//! Value spellings are the **engine's serde spellings**, not prettier
//! alternatives, because the alternative is a second dialect: `DataType` and
//! `AggregateOp` carry no `rename_all` and stay PascalCase (`Int64`, `Sum`),
//! while `TextOp` and `CastErrorPolicy` do and stay lowercase (`trim`, `fail`).
//! Aliases exist for what the shipped CLI already accepts; the renderer never
//! emits one.

use crate::compute::aggregate::AggregateOp;
use crate::transform::parts::{CastErrorPolicy, TextOp};
use crate::types::DataType;

/// One option a step statement accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OptionSpec {
    /// The canonical spelling, which the renderer emits.
    pub key: &'static str,
    /// The serde field on the step that this option writes. Several options
    /// may write one field (a repeatable option builds a `Vec`).
    pub json_field: &'static str,
    /// Whether the option may appear more than once, each occurrence appending
    /// one entry (`rename=`, `cast=`, `agg=`).
    pub repeatable: bool,
    /// Whether omitting the option is legal.
    pub optional: bool,
    /// One line for completion and help.
    pub help: &'static str,
}

/// Everything the script grammar knows about one step tag.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StepVocabulary {
    /// The step's serde tag, which is also the statement's first word.
    pub tag: &'static str,
    /// The options it accepts, in render order.
    pub options: &'static [OptionSpec],
    /// Whether the statement ends in a free-standing `= <expression>` tail.
    pub takes_expression: bool,
    /// The serde field the expression tail writes, when it takes one.
    pub expression_field: &'static str,
    /// One line describing the step, for completion and hover.
    pub help: &'static str,
}

/// The whole surface vocabulary, for a host that drives an editor with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScriptVocabulary {
    /// Every step tag, in catalog order.
    pub steps: &'static [StepVocabulary],
    /// Every `DataType` spelling a `dataType=`/`cast=` accepts, canonical form.
    pub data_types: &'static [&'static str],
    /// Every `AggregateOp` spelling, canonical form.
    pub aggregates: &'static [&'static str],
    /// Every `TextOp` spelling.
    pub text_operations: &'static [&'static str],
    /// Every `CastErrorPolicy` spelling.
    pub cast_error_policies: &'static [&'static str],
    /// The `range=` kinds.
    pub row_range_kinds: &'static [&'static str],
    /// The option accepted on every step to place it in the list, which the
    /// renderer never emits because order carries the position.
    pub placement_option: &'static str,
}

macro_rules! opt {
    ($key:literal -> $field:literal, $help:literal) => {
        OptionSpec {
            key: $key,
            json_field: $field,
            repeatable: false,
            optional: false,
            help: $help,
        }
    };
    (optional $key:literal -> $field:literal, $help:literal) => {
        OptionSpec {
            key: $key,
            json_field: $field,
            repeatable: false,
            optional: true,
            help: $help,
        }
    };
    (repeatable $key:literal -> $field:literal, $help:literal) => {
        OptionSpec {
            key: $key,
            json_field: $field,
            repeatable: true,
            optional: true,
            help: $help,
        }
    };
}

const REMOVE_COLUMNS: &[OptionSpec] =
    &[opt!(optional "columns" -> "columns", "the columns to drop")];
const SELECT_COLUMNS: &[OptionSpec] =
    &[opt!(optional "columns" -> "columns", "the columns to keep, in output order")];
const RENAME_COLUMNS: &[OptionSpec] =
    &[opt!(repeatable "rename" -> "renames", "one rename, written from:to")];
const CHANGE_TYPE: &[OptionSpec] = &[
    opt!(repeatable "cast" -> "changes", "one cast, written column:Type"),
    opt!(optional "onError" -> "onError", "fail (default) or null for a value that will not convert"),
];
const ADD_COLUMN: &[OptionSpec] = &[
    opt!("name" -> "name", "the new column's name"),
    opt!(optional "dataType" -> "dataType", "declared type; omit to infer from the expression"),
];
const TRANSFORM_COLUMN: &[OptionSpec] = &[
    opt!("column" -> "column", "the existing column to rewrite"),
    opt!(optional "dataType" -> "dataType", "declared type; omit to infer from the expression"),
];
const SPLIT_COLUMN: &[OptionSpec] = &[
    opt!("column" -> "column", "the text column to split"),
    opt!("delimiter" -> "delimiter", "the literal delimiter, not a pattern"),
    opt!("parts" -> "parts", "how many output columns"),
    opt!(optional "keepOriginal" -> "keepOriginal", "keep the source column too"),
];
const REPLACE_VALUES: &[OptionSpec] = &[
    opt!("column" -> "column", "the column to rewrite"),
    opt!("find" -> "find", "the text to look for"),
    opt!(optional "replace" -> "replace", "the replacement; omit to remove"),
    opt!(optional "matchEntireValue" -> "matchEntireValue", "match the whole value, not a substring"),
];
const TEXT_TRANSFORM: &[OptionSpec] = &[
    opt!(optional "columns" -> "columns", "the text columns to rewrite"),
    opt!("operation" -> "operation", "trim, clean, upper or lower"),
];
const FILL_DOWN: &[OptionSpec] =
    &[opt!(optional "columns" -> "columns", "the columns whose nulls take the value above")];
const REMOVE_DUPLICATES: &[OptionSpec] = &[opt!(
    optional "columns" -> "columns",
    "the columns that define a duplicate; omit for every column"
)];
const SORT: &[OptionSpec] = &[opt!(
    optional "by" -> "by",
    "sort keys, most significant first: Column, -Column or Column:desc"
)];
const GROUP_BY: &[OptionSpec] = &[
    opt!(optional "groupBy" -> "groupBy", "the grouping columns, in output order"),
    opt!(repeatable "agg" -> "aggregates", "one aggregate, written Function:column:alias"),
];
const ROW_RANGE: &[OptionSpec] =
    &[opt!("range" -> "range", "first:N, last:N or range:OFFSET:COUNT")];
const UNPIVOT: &[OptionSpec] = &[
    opt!(optional "columns" -> "columns", "the columns to unpivot"),
    opt!("nameColumn" -> "nameColumn", "output column holding the source column's name"),
    opt!("valueColumn" -> "valueColumn", "output column holding the value"),
];
const PIVOT: &[OptionSpec] = &[
    opt!("nameColumn" -> "nameColumn", "the column whose values become columns"),
    opt!("valueColumn" -> "valueColumn", "the column aggregated into each cell"),
    opt!("aggregate" -> "aggregate", "the aggregation applied within each cell"),
    opt!(
        optional "valueNames" -> "valueNames",
        "the declared distinct values, in output-column order"
    ),
];
const NO_OPTIONS: &[OptionSpec] = &[];

/// Every step tag, in the order the catalog declares them.
pub(crate) const STEPS: &[StepVocabulary] = &[
    StepVocabulary {
        tag: "removeColumns",
        options: REMOVE_COLUMNS,
        takes_expression: false,
        expression_field: "",
        help: "drop the named columns",
    },
    StepVocabulary {
        tag: "selectColumns",
        options: SELECT_COLUMNS,
        takes_expression: false,
        expression_field: "",
        help: "keep only the named columns, in the order given",
    },
    StepVocabulary {
        tag: "renameColumns",
        options: RENAME_COLUMNS,
        takes_expression: false,
        expression_field: "",
        help: "rename columns in place",
    },
    StepVocabulary {
        tag: "changeType",
        options: CHANGE_TYPE,
        takes_expression: false,
        expression_field: "",
        help: "cast columns to new types",
    },
    StepVocabulary {
        tag: "filterRows",
        options: NO_OPTIONS,
        takes_expression: true,
        expression_field: "condition",
        help: "keep the rows a row-level condition accepts",
    },
    StepVocabulary {
        tag: "addColumn",
        options: ADD_COLUMN,
        takes_expression: true,
        expression_field: "expression",
        help: "append a computed column",
    },
    StepVocabulary {
        tag: "transformColumn",
        options: TRANSFORM_COLUMN,
        takes_expression: true,
        expression_field: "expression",
        help: "rewrite an existing column with a formula, in place",
    },
    StepVocabulary {
        tag: "splitColumn",
        options: SPLIT_COLUMN,
        takes_expression: false,
        expression_field: "",
        help: "split one text column on a delimiter",
    },
    StepVocabulary {
        tag: "replaceValues",
        options: REPLACE_VALUES,
        takes_expression: false,
        expression_field: "",
        help: "replace values within one column",
    },
    StepVocabulary {
        tag: "textTransform",
        options: TEXT_TRANSFORM,
        takes_expression: false,
        expression_field: "",
        help: "trim, clean, upper or lower a text column",
    },
    StepVocabulary {
        tag: "fillDown",
        options: FILL_DOWN,
        takes_expression: false,
        expression_field: "",
        help: "replace nulls with the nearest value above",
    },
    StepVocabulary {
        tag: "removeDuplicates",
        options: REMOVE_DUPLICATES,
        takes_expression: false,
        expression_field: "",
        help: "keep the first row of each group of duplicates",
    },
    StepVocabulary {
        tag: "sort",
        options: SORT,
        takes_expression: false,
        expression_field: "",
        help: "order rows by one or more keys",
    },
    StepVocabulary {
        tag: "groupBy",
        options: GROUP_BY,
        takes_expression: false,
        expression_field: "",
        help: "collapse rows to one per group, with aggregates",
    },
    StepVocabulary {
        tag: "keepRows",
        options: ROW_RANGE,
        takes_expression: false,
        expression_field: "",
        help: "keep only the rows in a positional range",
    },
    StepVocabulary {
        tag: "removeRows",
        options: ROW_RANGE,
        takes_expression: false,
        expression_field: "",
        help: "drop the rows in a positional range",
    },
    StepVocabulary {
        tag: "unpivot",
        options: UNPIVOT,
        takes_expression: false,
        expression_field: "",
        help: "turn the named columns into name/value pairs",
    },
    StepVocabulary {
        tag: "pivot",
        options: PIVOT,
        takes_expression: false,
        expression_field: "",
        help: "turn distinct values into columns",
    },
];

/// The option accepted on every step to place it in the list. It is part of the
/// *editing* grammar, not of a step: the script renders steps in order, so the
/// position is carried by the order and this is never emitted.
pub(crate) const PLACEMENT_OPTION: &str = "at";

/// The vocabulary a host serves to its editor for completion and highlighting.
///
/// Served rather than restated: a local copy in the front end is a second
/// declaration of the same table, which is the drift this module exists to end.
pub fn script_vocabulary() -> ScriptVocabulary {
    ScriptVocabulary {
        steps: STEPS,
        data_types: DATA_TYPE_NAMES,
        aggregates: AGGREGATE_NAMES,
        text_operations: TEXT_OP_NAMES,
        cast_error_policies: CAST_ERROR_POLICY_NAMES,
        row_range_kinds: ROW_RANGE_KINDS,
        placement_option: PLACEMENT_OPTION,
    }
}

/// Look up a step tag, accepting the shipped CLI's alternative spellings.
pub(crate) fn step_by_tag(word: &str) -> Option<&'static StepVocabulary> {
    let lowered = word.to_ascii_lowercase();
    if let Some(found) = STEPS.iter().find(|s| s.tag.to_ascii_lowercase() == lowered) {
        return Some(found);
    }
    let canonical = match lowered.as_str() {
        "renamecolumn" => "renameColumns",
        "removecolumn" => "removeColumns",
        "selectcolumn" | "keepcolumns" => "selectColumns",
        "changetypes" | "casttype" => "changeType",
        "filter" | "filterrow" => "filterRows",
        "split" => "splitColumn",
        "transformcolumns" | "changecolumn" | "setcolumn" => "transformColumn",
        "replace" => "replaceValues",
        "text" => "textTransform",
        "dedupe" | "distinct" => "removeDuplicates",
        "group" => "groupBy",
        "keeprow" => "keepRows",
        "removerow" => "removeRows",
        _ => return None,
    };
    STEPS.iter().find(|s| s.tag == canonical)
}

/// Resolve an option key against a step, case-insensitively and through the
/// shipped CLI's abbreviations. Returns the canonical spec.
pub(crate) fn option_for(step: &StepVocabulary, key: &str) -> Option<&'static OptionSpec> {
    let lowered = key.to_ascii_lowercase();
    if let Some(found) = step
        .options
        .iter()
        .find(|o| o.key.to_ascii_lowercase() == lowered)
    {
        return Some(found);
    }
    // The CLI's shipped lowercase truncations, kept parseable so a script the
    // command line produced still reads. The renderer never emits one.
    let canonical = match (step.tag, lowered.as_str()) {
        ("replaceValues", "matchentire") => "matchEntireValue",
        ("pivot", "values") => "valueNames",
        ("addColumn", "type") => "dataType",
        ("renameColumns", "renames") => "rename",
        ("changeType", "changes") => "cast",
        ("groupBy", "aggregates") => "agg",
        _ => return None,
    };
    step.options.iter().find(|o| o.key == canonical)
}

/// Canonical `DataType` spellings, in help order. `Decimal` is parameterized
/// and is spelled `Decimal(precision,scale)`.
pub(crate) const DATA_TYPE_NAMES: &[&str] = &[
    "String",
    "Int32",
    "Int64",
    "Float64",
    "Decimal(18,2)",
    "Boolean",
    "Date",
    "Timestamp",
];

/// Render a `DataType` in its serde spelling.
pub(crate) fn render_data_type(data_type: &DataType) -> String {
    match data_type {
        DataType::Int32 => "Int32".to_string(),
        DataType::Int64 => "Int64".to_string(),
        DataType::Float64 => "Float64".to_string(),
        DataType::Decimal(precision, scale) => format!("Decimal({precision},{scale})"),
        DataType::String => "String".to_string(),
        DataType::Boolean => "Boolean".to_string(),
        DataType::Date => "Date".to_string(),
        DataType::Timestamp => "Timestamp".to_string(),
    }
}

/// Parse a `DataType`, accepting the engine spelling and the CLI's aliases.
pub(crate) fn parse_data_type(word: &str) -> Option<DataType> {
    let trimmed = word.trim();
    if let Some(rest) = strip_call(trimmed, "decimal") {
        let (precision, scale) = rest.split_once(',')?;
        return Some(DataType::Decimal(
            precision.trim().parse().ok()?,
            scale.trim().parse().ok()?,
        ));
    }
    match trimmed.to_ascii_lowercase().as_str() {
        "string" | "text" | "varchar" => Some(DataType::String),
        "int32" => Some(DataType::Int32),
        "int" | "int64" | "integer" | "whole" => Some(DataType::Int64),
        "float" | "float64" | "double" | "number" | "decimalnumber" => Some(DataType::Float64),
        "boolean" | "bool" => Some(DataType::Boolean),
        "date" => Some(DataType::Date),
        "timestamp" | "datetime" => Some(DataType::Timestamp),
        _ => None,
    }
}

/// `Decimal(18,2)` -> `18,2` when the head matches `name`, case-insensitively.
fn strip_call<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    let open = text.find('(')?;
    if !text.ends_with(')') || !text[..open].trim().eq_ignore_ascii_case(name) {
        return None;
    }
    Some(&text[open + 1..text.len() - 1])
}

/// Canonical `AggregateOp` spellings, in declaration order.
pub(crate) const AGGREGATE_NAMES: &[&str] = &[
    "Sum",
    "Count",
    "Average",
    "Min",
    "Max",
    "DistinctCount",
    "CountRows",
    "Median",
    "StdevSample",
    "StdevPop",
    "VarSample",
    "VarPop",
    "AnyValue",
    "Mode",
];

/// Render an `AggregateOp` in its serde spelling.
///
/// Deliberately not `Display`, which renders SQL (`Average` displays as `AVG`)
/// and would produce a script the parser could not read back.
pub(crate) fn render_aggregate(op: &AggregateOp) -> &'static str {
    match op {
        AggregateOp::Sum => "Sum",
        AggregateOp::Count => "Count",
        AggregateOp::Average => "Average",
        AggregateOp::Min => "Min",
        AggregateOp::Max => "Max",
        AggregateOp::DistinctCount => "DistinctCount",
        AggregateOp::CountRows => "CountRows",
        AggregateOp::Median => "Median",
        AggregateOp::StdevSample => "StdevSample",
        AggregateOp::StdevPop => "StdevPop",
        AggregateOp::VarSample => "VarSample",
        AggregateOp::VarPop => "VarPop",
        AggregateOp::AnyValue => "AnyValue",
        AggregateOp::Mode => "Mode",
    }
}

/// Parse an `AggregateOp`, accepting the CLI's aliases.
pub(crate) fn parse_aggregate(word: &str) -> Option<AggregateOp> {
    match word.trim().to_ascii_lowercase().as_str() {
        "sum" => Some(AggregateOp::Sum),
        "count" => Some(AggregateOp::Count),
        "average" | "avg" | "mean" => Some(AggregateOp::Average),
        "min" => Some(AggregateOp::Min),
        "max" => Some(AggregateOp::Max),
        "distinctcount" | "countdistinct" => Some(AggregateOp::DistinctCount),
        "countrows" | "rows" => Some(AggregateOp::CountRows),
        "median" => Some(AggregateOp::Median),
        "stdevsample" | "stdev" => Some(AggregateOp::StdevSample),
        "stdevpop" => Some(AggregateOp::StdevPop),
        "varsample" | "variance" | "var" => Some(AggregateOp::VarSample),
        "varpop" => Some(AggregateOp::VarPop),
        "anyvalue" => Some(AggregateOp::AnyValue),
        "mode" => Some(AggregateOp::Mode),
        _ => None,
    }
}

/// Canonical `TextOp` spellings.
pub(crate) const TEXT_OP_NAMES: &[&str] = &["trim", "clean", "upper", "lower"];

/// Parse a `TextOp`. Rendering goes through [`TextOp::as_str`], which already
/// returns the serde spelling.
pub(crate) fn parse_text_op(word: &str) -> Option<TextOp> {
    match word.trim().to_ascii_lowercase().as_str() {
        "trim" => Some(TextOp::Trim),
        "clean" => Some(TextOp::Clean),
        "upper" | "uppercase" => Some(TextOp::Upper),
        "lower" | "lowercase" => Some(TextOp::Lower),
        _ => None,
    }
}

/// Canonical `CastErrorPolicy` spellings.
pub(crate) const CAST_ERROR_POLICY_NAMES: &[&str] = &["fail", "null"];

/// Render a `CastErrorPolicy` in its serde spelling.
pub(crate) fn render_cast_error_policy(policy: &CastErrorPolicy) -> &'static str {
    match policy {
        CastErrorPolicy::Fail => "fail",
        CastErrorPolicy::Null => "null",
    }
}

/// Parse a `CastErrorPolicy`.
pub(crate) fn parse_cast_error_policy(word: &str) -> Option<CastErrorPolicy> {
    match word.trim().to_ascii_lowercase().as_str() {
        "fail" | "error" => Some(CastErrorPolicy::Fail),
        "null" | "blank" => Some(CastErrorPolicy::Null),
        _ => None,
    }
}

/// The `range=` kinds, in the spelling the renderer emits.
pub(crate) const ROW_RANGE_KINDS: &[&str] = &["first", "last", "range"];
