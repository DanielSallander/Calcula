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
            return format!(
                "{}.{}",
                quote_ident_double(schema),
                quote_ident_double(table)
            );
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

/// The WHEN condition of a `CASE` the engine runs on DataFusion, spelled so a
/// NULL condition is FALSE: `COALESCE(c, FALSE)`.
///
/// SQL takes a `CASE` branch only when its condition is TRUE, and so does
/// DAX's `IF` (a BLANK compared with a value is never TRUE). DataFusion 44
/// does not, in one shape: `CASE WHEN c THEN col END` -- one WHEN, a bare
/// column, no ELSE (or `ELSE NULL`, which the planner drops) -- runs its
/// `case_column_or_null` fast path, `nullif(col, not(c))`, and a NULL `c`
/// makes that `nullif(col, NULL)`, which is `col`
/// (datafusion-physical-expr 44.0.0, `expressions/case.rs`). So every
/// conditional aggregate `AGG(CASE WHEN keep THEN col END)` also aggregated
/// the rows whose KEEP condition is NULL -- a BLANK attribute, an unmatched
/// dimension row -- and `COUNT(CASE WHEN cat = 'Bikes' THEN amount END)`
/// over `(Bikes, 10), (Bikes, NULL), (NULL, 7)` answered 2.
///
/// `COALESCE(c, FALSE)` is never NULL, so every evaluation path agrees. Not
/// `(c) IS TRUE`: DataFusion 44 types `IS TRUE` non-nullable in the logical
/// plan but nullable in the physical one, and a query that uses one twice
/// (a DISTINCTCOUNT's two arms, two measures under one KEEP) fails with
/// "Physical input schema should be the same as the one converted from
/// logical input schema" once common-subexpression elimination shares it.
/// COALESCE's nullability is one function in both plans.
///
/// `is_predicate` says the condition is already boolean (a comparison,
/// AND/OR/NOT, IS NULL, IN, ...); otherwise it is cast to BOOLEAN first, as
/// `CASE` itself casts a non-boolean WHEN (COALESCE would not coerce a number
/// and `FALSE` to one type). PostgreSQL and SQL Server evaluate `CASE`
/// correctly, so source dialects never call this: their pushed SQL keeps the
/// bare condition.
pub fn null_is_false_condition(condition_sql: &str, is_predicate: bool) -> String {
    if is_predicate {
        format!("COALESCE({condition_sql}, FALSE)")
    } else {
        format!("COALESCE(CAST({condition_sql} AS BOOLEAN), FALSE)")
    }
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
