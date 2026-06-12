//! Identifier validation and the model-level lookup-resolution placeholder.

use crate::compute::expression::Expression;
use crate::error::{EngineError, EngineResult};

/// Characters rejected in model identifiers.
///
/// These can break out of quoted SQL identifiers (`"`, `[`, `]`, `'`, `;`)
/// or escape file/path contexts (`\`, `/`). Names with inner spaces, single
/// dots, unicode letters, or parentheses remain legal — BI models
/// legitimately use names like "Sales Amount".
const FORBIDDEN_IDENTIFIER_CHARS: [char; 7] = ['"', '[', ']', '\'', ';', '\\', '/'];

/// Validate a model identifier (table, column, calculated-column, or
/// measure name) before it can reach SQL generation or file naming.
///
/// Rejects names that are empty/whitespace-only, have leading or trailing
/// whitespace, contain control characters, contain any of
/// [`FORBIDDEN_IDENTIFIER_CHARS`], or contain the path-traversal sequence
/// `..`.
///
/// Also used by `Expression::validate()` for table references embedded in
/// expression trees, which are rendered as raw (unquoted) SQL qualifiers.
pub(crate) fn validate_identifier(name: &str, kind: &str) -> EngineResult<()> {
    let invalid = |reason: String| EngineError::InvalidIdentifier {
        name: name.to_string(),
        reason,
    };
    if name.trim().is_empty() {
        return Err(invalid(format!(
            "{kind} name must not be empty or whitespace-only"
        )));
    }
    if name != name.trim() {
        return Err(invalid(format!(
            "{kind} name must not have leading or trailing whitespace"
        )));
    }
    if name.contains("..") {
        return Err(invalid(format!(
            "{kind} name must not contain the sequence '..'"
        )));
    }
    for c in name.chars() {
        if c < '\u{20}' || c == '\u{7f}' {
            return Err(invalid(format!(
                "{kind} name must not contain control characters"
            )));
        }
        if FORBIDDEN_IDENTIFIER_CHARS.contains(&c) {
            return Err(invalid(format!("{kind} name must not contain '{c}'")));
        }
    }
    Ok(())
}

/// Maximum length in characters of short presentation-metadata strings
/// (`display_name` on tables and columns, `format_string` on measures).
pub(crate) const MAX_METADATA_NAME_CHARS: usize = 256;

/// Maximum length in characters of `description` presentation metadata.
pub(crate) const MAX_METADATA_DESCRIPTION_CHARS: usize = 1024;

/// Validate one presentation-metadata string field.
///
/// Presentation metadata (display names, descriptions, format strings) is
/// host-interpreted: the engine never parses its content, so validation is
/// deliberately minimal — a length cap so corrupt or hostile model files
/// cannot smuggle unbounded payloads through metadata, plus (for display
/// names) a non-empty requirement, since an empty-but-present display name
/// would render model objects as blank entries in host field lists.
pub(crate) fn validate_metadata_text(
    entity: &str,
    field: &str,
    value: &str,
    max_chars: usize,
    reject_empty: bool,
) -> EngineResult<()> {
    let invalid = |reason: String| EngineError::InvalidMetadata {
        entity: entity.to_string(),
        field: field.to_string(),
        reason,
    };
    if reject_empty && value.trim().is_empty() {
        return Err(invalid(
            "must not be empty or whitespace-only when present".to_string(),
        ));
    }
    let chars = value.chars().count();
    if chars > max_chars {
        return Err(invalid(format!(
            "must be at most {max_chars} characters (got {chars})"
        )));
    }
    Ok(())
}

/// Reserved placeholder identifier for the model-level default lookup
/// resolution expression
/// ([`DataModelBuilder::default_lookup_resolution`]).
///
/// In the default expression, the bare identifier `__column`
/// (case-insensitive) stands for the lookup column the expression is being
/// applied to. It is rewritten to the actual column at query time via
/// [`apply_lookup_placeholder`].
pub const LOOKUP_COLUMN_PLACEHOLDER: &str = "__column";

/// Rewrite the [`LOOKUP_COLUMN_PLACEHOLDER`] in a parsed model-level default
/// lookup resolution expression to a reference to `column_name`.
///
/// The placeholder must appear as a bare identifier — a table-qualified
/// `dim[__column]` cannot be rewritten and is rejected. An expression that
/// does not reference the placeholder at all is also rejected: it would
/// silently resolve the same hard-coded column for every lookup it is
/// applied to.
pub fn apply_lookup_placeholder(
    expression: &Expression,
    column_name: &str,
) -> EngineResult<Expression> {
    // Collect the exact spellings used for the placeholder: the comparison
    // is case-insensitive, but substitution matches names exactly.
    let spellings: Vec<String> = expression
        .column_references()
        .iter()
        .filter(|r| r.eq_ignore_ascii_case(LOOKUP_COLUMN_PLACEHOLDER))
        .map(|r| (*r).to_string())
        .collect();
    if spellings.is_empty() {
        return Err(EngineError::InvalidLookup {
            table: "(model)".to_string(),
            column: "default_lookup_resolution".to_string(),
            reason: format!(
                "expression must reference the lookup column via the \
                 '{LOOKUP_COLUMN_PLACEHOLDER}' placeholder, \
                 e.g. \"MAX({LOOKUP_COLUMN_PLACEHOLDER})\""
            ),
        });
    }

    let env: std::collections::HashMap<String, Expression> = spellings
        .into_iter()
        .map(|s| (s, Expression::ColumnRef(column_name.to_string())))
        .collect();
    let rewritten = expression.substitute_vars(&env);

    // A table-qualified placeholder (`dim[__column]`) is not substituted by
    // `substitute_vars` — reject it instead of silently rendering a
    // reference to a non-existent "__column" column.
    if rewritten
        .column_references()
        .iter()
        .any(|r| r.eq_ignore_ascii_case(LOOKUP_COLUMN_PLACEHOLDER))
    {
        return Err(EngineError::InvalidLookup {
            table: "(model)".to_string(),
            column: "default_lookup_resolution".to_string(),
            reason: format!(
                "the '{LOOKUP_COLUMN_PLACEHOLDER}' placeholder must be a bare \
                 identifier (not table-qualified)"
            ),
        });
    }
    Ok(rewritten)
}

#[cfg(test)]
mod tests {
    use super::super::test_fixtures::sales_table;
    use super::*;
    use crate::model::calculated_column::CalculatedColumn;
    use crate::model::column::Column;
    use crate::model::schema::DataModel;
    use crate::model::table::Table;
    use crate::types::DataType;

    #[test]
    fn apply_lookup_placeholder_rewrites_case_insensitively() {
        let parsed = crate::compute::parser::parse_measure_expression("MAX(__COLUMN)").unwrap();
        let rewritten = apply_lookup_placeholder(&parsed, "category_name").unwrap();
        assert_eq!(rewritten.column_references(), vec!["category_name"]);
    }

    #[test]
    fn build_rejects_table_name_with_double_quote() {
        let table = Table::new("evil\"t", vec![Column::new("a", DataType::Int32)]).unwrap();
        let result = DataModel::builder().add_table(table).build();
        assert!(matches!(
            result,
            Err(EngineError::InvalidIdentifier { ref name, .. }) if name == "evil\"t"
        ));
    }

    #[test]
    fn build_rejects_column_name_with_bracket() {
        let table = Table::new("t", vec![Column::new("c]x", DataType::Int32)]).unwrap();
        let result = DataModel::builder().add_table(table).build();
        assert!(matches!(
            result,
            Err(EngineError::InvalidIdentifier { ref name, .. }) if name == "c]x"
        ));
    }

    #[test]
    fn build_rejects_table_name_with_traversal_sequence() {
        let table = Table::new("..\\x", vec![Column::new("a", DataType::Int32)]).unwrap();
        let result = DataModel::builder().add_table(table).build();
        assert!(matches!(result, Err(EngineError::InvalidIdentifier { .. })));
    }

    #[test]
    fn build_rejects_empty_and_whitespace_table_names() {
        for bad in ["", "   ", " Sales", "Sales ", "\tSales"] {
            let table = Table::new(bad, vec![Column::new("a", DataType::Int32)]).unwrap();
            let result = DataModel::builder().add_table(table).build();
            assert!(
                matches!(result, Err(EngineError::InvalidIdentifier { .. })),
                "expected rejection of table name {bad:?}"
            );
        }
    }

    #[test]
    fn build_rejects_table_name_with_control_character() {
        let table = Table::new("Sa\x07les", vec![Column::new("a", DataType::Int32)]).unwrap();
        let result = DataModel::builder().add_table(table).build();
        assert!(matches!(result, Err(EngineError::InvalidIdentifier { .. })));
    }

    #[test]
    fn build_rejects_measure_name_with_quote() {
        // Measure names are interpolated into SQL as quoted aliases
        // (`... AS "name"`), so they must obey the same rules.
        let model = DataModel::builder()
            .add_table(sales_table())
            .add_measure(crate::compute::measure::sum_measure(
                "Rev\"enue",
                "Sales",
                "amount",
            ))
            .build();
        assert!(matches!(
            model,
            Err(EngineError::InvalidIdentifier { ref name, .. }) if name == "Rev\"enue"
        ));
    }

    #[test]
    fn build_rejects_calculated_column_name_with_semicolon() {
        let cc = CalculatedColumn::new(
            "margin;drop",
            "Sales",
            crate::compute::expression::Expression::ColumnRef("amount".to_string()),
            DataType::Float64,
        );
        let result = DataModel::builder()
            .add_table(sales_table())
            .add_calculated_column(cc)
            .build();
        assert!(matches!(
            result,
            Err(EngineError::InvalidIdentifier { ref name, .. }) if name == "margin;drop"
        ));
    }

    #[test]
    fn build_accepts_legitimate_bi_names() {
        // Spaces, single dots, unicode letters, parentheses, and hyphens are
        // all legal in BI model names.
        let table = Table::new(
            "Sales Amount",
            vec![
                Column::new("Unit Price (USD)", DataType::Float64),
                Column::new("Försäljning", DataType::Float64),
                Column::new("v1.2 metric", DataType::Float64),
                Column::new("net-amount", DataType::Float64),
            ],
        )
        .unwrap();
        let result = DataModel::builder()
            .add_table(table)
            .add_table(Table::new("fact_sales", vec![Column::new("id", DataType::Int64)]).unwrap())
            .build();
        assert!(result.is_ok());
    }
}
