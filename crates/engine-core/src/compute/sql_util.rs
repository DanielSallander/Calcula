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

/// Quote a (possibly dotted) model table name as a DataFusion table REFERENCE.
///
/// The local pipeline registers a single-dotted model name (`BI.fact_sales`,
/// from imports that named tables `"<schema>.<table>"`) as a schema-qualified
/// DataFusion table, so a quoted reference must quote each part separately:
/// `bi.fact_sales` → `"bi"."fact_sales"` (a single quoted ident
/// `"bi.fact_sales"` would name a table that no longer exists). A dot-free
/// name quotes whole, exactly like [`quote_ident_double`].
pub fn quote_table_ref_double(name: &str) -> String {
    let mut parts = name.split('.');
    if let (Some(schema), Some(table), None) = (parts.next(), parts.next(), parts.next()) {
        if !schema.is_empty() && !table.is_empty() {
            return format!("{}.{}", quote_ident_double(schema), quote_ident_double(table));
        }
    }
    quote_ident_double(name)
}

/// The DataFusion registration/reference name for a model table.
///
/// The local compute path registers in-memory batches under this name and
/// interpolates it (unquoted) into DataFusion SQL, so it must be a plain
/// identifier. Model table names may be DOTTED — imports historically named
/// tables `"<schema>.<table>"` (e.g. `BI.fact_sales`), and DataFusion would
/// parse the unquoted dot as a `schema.table` qualification and fail with
/// "table 'datafusion.bi.fact_sales' not found". Lowercase + dots mapped to
/// underscores keeps registration and every SQL reference in agreement.
/// (Theoretical collision: distinct model tables `bi.fact` and `bi_fact`
/// would map to the same name — model names come from imports where that
/// pair cannot arise.)
pub fn df_table_name(name: &str) -> String {
    name.to_lowercase().replace('.', "_")
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
    fn df_table_name_maps_dotted_names_to_plain_identifiers() {
        assert_eq!(df_table_name("BI.fact_sales"), "bi_fact_sales");
        assert_eq!(df_table_name("dim_product"), "dim_product");
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
