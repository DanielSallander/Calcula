//! Shared SQL quoting helpers used by every SQL-generating code path.
//!
//! All SQL in the engine is assembled as strings (DataFusion local SQL plus
//! connector-generated source SQL). Filter values originate from query
//! requests and measure text, and identifiers (table/column/measure names)
//! originate from model files — both cross a trust boundary, since model
//! files are shared between users. Any value or identifier interpolated into
//! SQL **must** be routed through these helpers so that embedded quote
//! characters cannot terminate the literal/identifier early and smuggle in
//! additional SQL.
//!
//! These helpers exist so that every call site escapes the same way; before
//! they were introduced, escaping logic was duplicated (and disagreed)
//! across crates.

/// Quote a string as a SQL single-quoted literal.
///
/// Embedded single quotes are doubled (`O'Brien` → `'O''Brien'`), which is
/// the standard SQL escape understood by PostgreSQL, SQL Server, and
/// DataFusion. Without this, a value like `x'); DROP TABLE t; --` would
/// terminate the literal and inject statements.
pub fn sql_quote_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Quote an identifier with double quotes (PostgreSQL and DataFusion dialects).
///
/// Embedded double quotes are doubled (`evil"name` → `"evil""name"`).
/// Without this, an identifier from a model file could close the quoted
/// identifier early and inject arbitrary SQL into the statement.
pub fn quote_ident_double(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Quote an identifier with square brackets (SQL Server dialect).
///
/// Embedded closing brackets are doubled (`evil]name` → `[evil]]name]`).
/// Without this, an identifier from a model file could close the bracketed
/// identifier early and inject arbitrary T-SQL into the statement.
pub fn quote_ident_bracket(name: &str) -> String {
    format!("[{}]", name.replace(']', "]]"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sql_quote_literal_plain_value() {
        assert_eq!(sql_quote_literal("Bikes"), "'Bikes'");
    }

    #[test]
    fn sql_quote_literal_doubles_embedded_quote() {
        assert_eq!(sql_quote_literal("O'Brien"), "'O''Brien'");
    }

    #[test]
    fn sql_quote_literal_neutralizes_injection_payload() {
        let rendered = sql_quote_literal("x'); DROP TABLE t; --");
        assert_eq!(rendered, "'x''); DROP TABLE t; --'");
        // The single quote is doubled, so the literal cannot be terminated early.
        assert!(rendered.contains("''"));
        assert!(!rendered.contains("x');"));
    }

    #[test]
    fn quote_ident_double_plain_name() {
        assert_eq!(quote_ident_double("amount"), "\"amount\"");
    }

    #[test]
    fn quote_ident_double_doubles_embedded_quote() {
        assert_eq!(quote_ident_double("evil\"name"), "\"evil\"\"name\"");
    }

    #[test]
    fn quote_ident_bracket_plain_name() {
        assert_eq!(quote_ident_bracket("amount"), "[amount]");
    }

    #[test]
    fn quote_ident_bracket_doubles_embedded_bracket() {
        assert_eq!(quote_ident_bracket("evil]name"), "[evil]]name]");
    }
}
