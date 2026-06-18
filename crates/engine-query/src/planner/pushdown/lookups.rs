//! Lookup-column resolution: key inference and resolution-expression SQL.

use engine_core::compute::expression::{
    DataFusionDialect, Expression, SqlRenderer, TableAliasQualifier,
};
use engine_core::compute::parser::parse_measure_expression;
use engine_core::compute::sql_util::quote_ident_double;
use engine_core::model::schema::apply_lookup_placeholder;
use engine_core::model::DataModel;
use engine_core::types::DataType;

use crate::error::{QueryError, QueryResult};
use crate::request::ColumnRef;

use super::LookupSpec;

/// Resolve lookup columns into `LookupSpec`s with pre-rendered SQL.
///
/// For each `LookupColumn`:
/// - Validates the table and column exist in the model.
/// - Auto-infers the key column from `group_by` if not specified.
/// - Builds the resolution SQL using the first match in the chain:
///   1. the column's own `lookup_resolution` expression;
///   2. the model-level `default_lookup_resolution`, with the `__column`
///      placeholder rewritten to the lookup column;
///   3. the built-in fallback — SELECTEDVALUE-style semantics
///      (`CASE WHEN COUNT(DISTINCT col) = 1 THEN MIN(col) ELSE '#' END`)
///      for `String` columns, plain `MIN(col)` for all other types.
/// - Returns a `LookupSpec` with the SQL fragment for the post-aggregation step.
pub(super) fn resolve_lookups(
    lookups: &[crate::request::LookupColumn],
    group_by: &[ColumnRef],
    model: &DataModel,
) -> QueryResult<Vec<LookupSpec>> {
    let mut specs = Vec::new();

    for lookup in lookups {
        // Validate table exists.
        let table = model
            .table(&lookup.table)
            .map_err(|_| QueryError::InvalidQuery(format!("Table '{}' not found", lookup.table)))?;

        // Validate column exists.
        let col = table.column(&lookup.column).map_err(|_| {
            QueryError::InvalidQuery(format!(
                "Column '{}' not found in table '{}'",
                lookup.column, lookup.table
            ))
        })?;

        // Determine key column.
        let key_column = match &lookup.key_column {
            Some(key) => {
                // Validate explicit key exists.
                table.column(key).map_err(|_| {
                    QueryError::InvalidQuery(format!(
                        "Key column '{}' not found in table '{}'",
                        key, lookup.table
                    ))
                })?;
                // Validate key is in group_by.
                let in_group_by = group_by
                    .iter()
                    .any(|g| g.table == lookup.table && g.column == *key);
                if !in_group_by {
                    return Err(QueryError::InvalidQuery(format!(
                        "Key column '{}.{}' for lookup '{}.{}' must be in group_by",
                        lookup.table, key, lookup.table, lookup.column
                    )));
                }
                key.clone()
            }
            None => {
                // Auto-infer: find group_by columns from the same table.
                let candidates: Vec<&ColumnRef> = group_by
                    .iter()
                    .filter(|g| g.table == lookup.table)
                    .collect();

                match candidates.len() {
                    0 => {
                        return Err(QueryError::InvalidQuery(format!(
                            "No group_by column from table '{}' to use as key for lookup '{}.{}'",
                            lookup.table, lookup.table, lookup.column
                        )));
                    }
                    1 => candidates[0].column.clone(),
                    _ => {
                        let names: Vec<&str> =
                            candidates.iter().map(|c| c.column.as_str()).collect();
                        return Err(QueryError::InvalidQuery(format!(
                            "Multiple group_by columns from table '{}': [{}]. \
                             Specify key_column explicitly for lookup '{}.{}'",
                            lookup.table,
                            names.join(", "),
                            lookup.table,
                            lookup.column
                        )));
                    }
                }
            }
        };

        // Build resolution SQL: per-column expression → model default
        // (with `__column` placeholder) → built-in fallback.
        let table_alias = lookup.table.to_lowercase();
        let col_name = &lookup.column;
        let resolution_sql = match col.lookup_resolution() {
            Some(expr_text) => render_resolution_sql(expr_text, &table_alias, col_name)?,
            None => match model.default_lookup_resolution() {
                Some(default_expr) => {
                    render_default_resolution_sql(default_expr, &table_alias, col_name)?
                }
                None => built_in_resolution_sql(&table_alias, col_name, col.data_type()),
            },
        };

        specs.push(LookupSpec {
            table: lookup.table.clone(),
            column: lookup.column.clone(),
            key_column,
            resolution_sql,
        });
    }

    Ok(specs)
}

/// Render a resolution expression to SQL by parsing it through the expression
/// parser, qualifying column references with the table alias, and rendering
/// the result as SQL.
///
/// This supports the full expression language including VAR/RETURN blocks,
/// IF/SWITCH, HASONEVALUE, SELECTEDVALUE, FIRST, and all scalar functions.
///
/// Column references (bare names) in the expression are qualified with the
/// table alias: `col` → `table."col"`.
fn render_resolution_sql(
    expr_text: &str,
    table_alias: &str,
    column_name: &str,
) -> QueryResult<String> {
    // Parse the expression through the full parser.
    let parsed = parse_measure_expression(expr_text).map_err(|e| {
        QueryError::InvalidQuery(format!(
            "Invalid lookup_resolution expression for column '{}': {}",
            column_name, e
        ))
    })?;

    // Render to SQL with column refs qualified by the table alias.
    qualified_sql(&parsed, table_alias)
}

/// Render the model-level default lookup resolution for a specific column.
///
/// The model default is column-generic: the reserved bare identifier
/// `__column` (case-insensitive) stands for the lookup column it is applied
/// to. The expression is parsed, every placeholder reference is rewritten to
/// the actual column, and the result is rendered with the dimension table
/// alias. Defaults that omit the placeholder (or table-qualify it) are
/// rejected — `DataModelBuilder::build()` enforces the same rule, so this
/// only fires for models that bypassed validation.
fn render_default_resolution_sql(
    default_expr: &str,
    table_alias: &str,
    column_name: &str,
) -> QueryResult<String> {
    let parsed = parse_measure_expression(default_expr).map_err(|e| {
        QueryError::InvalidQuery(format!("Invalid default_lookup_resolution expression: {e}"))
    })?;
    let rewritten = apply_lookup_placeholder(&parsed, column_name)?;
    qualified_sql(&rewritten, table_alias)
}

/// Built-in lookup resolution fallback (no per-column expression, no model
/// default).
///
/// `String` columns get SELECTEDVALUE-style semantics: the actual value when
/// the group maps to exactly one distinct value, `'#'` when ambiguous. All
/// other data types keep plain `MIN(col)` — mixing `MIN(col)` with the
/// string literal `'#'` in one CASE would give the branches incompatible
/// types.
fn built_in_resolution_sql(table_alias: &str, column_name: &str, data_type: &DataType) -> String {
    let col = quote_ident_double(column_name);
    if matches!(data_type, DataType::String) {
        format!(
            "CASE WHEN COUNT(DISTINCT {table_alias}.{col}) = 1 \
             THEN MIN({table_alias}.{col}) ELSE '#' END"
        )
    } else {
        format!("MIN({table_alias}.{col})")
    }
}

/// Render an expression to SQL, qualifying every column reference with the
/// table alias.
///
/// `ColumnRef("col")` → `table."col"` instead of just `"col"`.
/// This is used for lookup resolution SQL where column references must be
/// prefixed with the dimension table alias. Delegates to the unified
/// [`SqlRenderer`] (DataFusion dialect, [`TableAliasQualifier`]).
///
/// Returns an error if the expression contains nodes that cannot be rendered
/// as scalar SQL (see [`Expression::to_sql_string`]).
fn qualified_sql(expr: &Expression, table_alias: &str) -> QueryResult<String> {
    let qualifier = TableAliasQualifier { alias: table_alias };
    Ok(SqlRenderer::new(DataFusionDialect, &qualifier).render(expr)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine_core::compute::measure::sum_measure;
    use engine_core::model::{Column, Relationship, Table};

    // --- resolve_lookups tests ---

    fn lookup_model() -> DataModel {
        let products = Table::new(
            "Products",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("category_id", DataType::Int32),
                Column::new("category_name", DataType::String),
                Column::new("subcategory", DataType::String),
                Column::new("weight", DataType::Float64),
            ],
        )
        .unwrap();

        let sales = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("product_id", DataType::Int64),
                Column::new("amount", DataType::Float64),
            ],
        )
        .unwrap();

        DataModel::builder()
            .add_table(products)
            .add_table(sales)
            .add_relationship(Relationship::many_to_one(
                "Sales_Products",
                "Sales",
                "product_id",
                "Products",
                "id",
            ))
            .add_measure(sum_measure("Revenue", "Sales", "amount"))
            .build()
            .unwrap()
    }

    #[test]
    fn resolve_lookups_auto_infers_key() {
        use crate::request::LookupColumn;
        let model = lookup_model();
        let group_by = vec![ColumnRef::new("Products", "category_id")];
        let lookups = vec![LookupColumn::new("Products", "category_name")];
        let specs = resolve_lookups(&lookups, &group_by, &model).unwrap();

        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].column, "category_name");
        assert_eq!(specs[0].key_column, "category_id");
        // Default: SELECTEDVALUE semantics — return value when unique, '#' when ambiguous.
        assert!(specs[0].resolution_sql.contains("COUNT(DISTINCT"));
        assert!(specs[0].resolution_sql.contains("MIN("));
        assert!(specs[0].resolution_sql.contains("'#'"));
    }

    #[test]
    fn resolve_lookups_explicit_key() {
        use crate::request::LookupColumn;
        let model = lookup_model();
        let group_by = vec![
            ColumnRef::new("Products", "category_id"),
            ColumnRef::new("Products", "subcategory"),
        ];
        let lookups = vec![LookupColumn::with_key(
            "Products",
            "category_name",
            "category_id",
        )];
        let specs = resolve_lookups(&lookups, &group_by, &model).unwrap();

        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].key_column, "category_id");
    }

    #[test]
    fn resolve_lookups_errors_on_ambiguous_key() {
        use crate::request::LookupColumn;
        let model = lookup_model();
        let group_by = vec![
            ColumnRef::new("Products", "category_id"),
            ColumnRef::new("Products", "subcategory"),
        ];
        let lookups = vec![LookupColumn::new("Products", "category_name")];
        let result = resolve_lookups(&lookups, &group_by, &model);

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Multiple group_by columns"));
    }

    #[test]
    fn resolve_lookups_errors_on_no_key() {
        use crate::request::LookupColumn;
        let model = lookup_model();
        // group_by has no Products columns
        let group_by = vec![ColumnRef::new("Sales", "product_id")];
        let lookups = vec![LookupColumn::new("Products", "category_name")];
        let result = resolve_lookups(&lookups, &group_by, &model);

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("No group_by column"));
    }

    #[test]
    fn resolve_lookups_default_resolution_is_selectedvalue() {
        use crate::request::LookupColumn;
        let model = lookup_model();
        let group_by = vec![ColumnRef::new("Products", "category_id")];
        let lookups = vec![LookupColumn::new("Products", "category_name")];
        let specs = resolve_lookups(&lookups, &group_by, &model).unwrap();

        // String column default:
        // CASE WHEN COUNT(DISTINCT col) = 1 THEN MIN(col) ELSE '#' END
        let sql = &specs[0].resolution_sql;
        assert_eq!(
            sql,
            "CASE WHEN COUNT(DISTINCT products.\"category_name\") = 1 \
             THEN MIN(products.\"category_name\") ELSE '#' END"
        );
    }

    #[test]
    fn resolve_lookups_non_string_column_gets_min_fallback() {
        use crate::request::LookupColumn;
        let model = lookup_model();
        let group_by = vec![ColumnRef::new("Products", "category_id")];
        let lookups = vec![LookupColumn::new("Products", "weight")];
        let specs = resolve_lookups(&lookups, &group_by, &model).unwrap();

        // Non-string columns must NOT get the '#' CASE branch — MIN(float)
        // and '#' would have incompatible types.
        assert_eq!(specs[0].resolution_sql, "MIN(products.\"weight\")");
    }

    #[test]
    fn resolve_lookups_model_default_resolution() {
        use crate::request::LookupColumn;

        let products = Table::new(
            "Products",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("category_id", DataType::Int32),
                Column::new("category_name", DataType::String),
            ],
        )
        .unwrap();

        let model = DataModel::builder()
            .add_table(products)
            .default_lookup_resolution("MAX(__column)")
            .build()
            .unwrap();

        let group_by = vec![ColumnRef::new("Products", "category_id")];
        let lookups = vec![LookupColumn::new("Products", "category_name")];
        let specs = resolve_lookups(&lookups, &group_by, &model).unwrap();

        // Model default overrides the built-in fallback; the `__column`
        // placeholder is rewritten to the actual lookup column.
        assert_eq!(specs[0].resolution_sql, "MAX(products.\"category_name\")");
    }

    #[test]
    fn resolve_lookups_model_default_applies_to_each_column() {
        use crate::request::LookupColumn;
        let model = {
            let products = Table::new(
                "Products",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("category_id", DataType::Int32),
                    Column::new("category_name", DataType::String),
                    Column::new("subcategory", DataType::String),
                ],
            )
            .unwrap();
            DataModel::builder()
                .add_table(products)
                .default_lookup_resolution("MAX(__column)")
                .build()
                .unwrap()
        };

        let group_by = vec![ColumnRef::new("Products", "category_id")];
        let lookups = vec![
            LookupColumn::new("Products", "category_name"),
            LookupColumn::new("Products", "subcategory"),
        ];
        let specs = resolve_lookups(&lookups, &group_by, &model).unwrap();

        // Each lookup resolves ITS OWN column — the placeholder must not
        // pin the default to one hard-coded column.
        assert_eq!(specs[0].resolution_sql, "MAX(products.\"category_name\")");
        assert_eq!(specs[1].resolution_sql, "MAX(products.\"subcategory\")");
    }

    #[test]
    fn model_default_without_placeholder_rejected_at_build() {
        let products = Table::new(
            "Products",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("category_name", DataType::String),
            ],
        )
        .unwrap();

        let result = DataModel::builder()
            .add_table(products)
            .default_lookup_resolution("MAX(category_name)")
            .build();

        let err = result.unwrap_err().to_string();
        assert!(err.contains("__column"), "got: {err}");
    }

    #[test]
    fn invalid_model_default_rejected_at_build() {
        let products = Table::new("Products", vec![Column::new("id", DataType::Int64)]).unwrap();

        let result = DataModel::builder()
            .add_table(products)
            .default_lookup_resolution("MAX(")
            .build();

        let err = result.unwrap_err().to_string();
        assert!(err.contains("does not parse"), "got: {err}");
    }

    #[test]
    fn resolve_lookups_column_overrides_model_default() {
        use crate::request::LookupColumn;

        let products = Table::new(
            "Products",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("category_id", DataType::Int32),
                Column::new("category_name", DataType::String)
                    .with_lookup_resolution("FIRST(category_name, ORDER BY id)"),
            ],
        )
        .unwrap();

        let model = DataModel::builder()
            .add_table(products)
            .default_lookup_resolution("MAX(__column)")
            .build()
            .unwrap();

        let group_by = vec![ColumnRef::new("Products", "category_id")];
        let lookups = vec![LookupColumn::new("Products", "category_name")];
        let specs = resolve_lookups(&lookups, &group_by, &model).unwrap();

        // Per-column resolution wins over model default.
        assert!(specs[0].resolution_sql.contains("FIRST_VALUE"));
    }

    #[test]
    fn resolve_lookups_custom_resolution() {
        use crate::request::LookupColumn;

        let products = Table::new(
            "Products",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("category_id", DataType::Int32),
                Column::new("category_name", DataType::String)
                    .with_lookup_resolution("MAX(category_name)"),
            ],
        )
        .unwrap();

        let sales = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("product_id", DataType::Int64),
                Column::new("amount", DataType::Float64),
            ],
        )
        .unwrap();

        let model = DataModel::builder()
            .add_table(products)
            .add_table(sales)
            .add_relationship(Relationship::many_to_one(
                "Sales_Products",
                "Sales",
                "product_id",
                "Products",
                "id",
            ))
            .add_measure(sum_measure("Revenue", "Sales", "amount"))
            .build()
            .unwrap();

        let group_by = vec![ColumnRef::new("Products", "category_id")];
        let lookups = vec![LookupColumn::new("Products", "category_name")];
        let specs = resolve_lookups(&lookups, &group_by, &model).unwrap();

        assert_eq!(specs[0].resolution_sql, "MAX(products.\"category_name\")");
    }

    #[test]
    fn resolve_lookups_empty_is_noop() {
        let model = lookup_model();
        let group_by = vec![ColumnRef::new("Products", "category_id")];
        let specs = resolve_lookups(&[], &group_by, &model).unwrap();
        assert!(specs.is_empty());
    }

    #[test]
    fn render_resolution_hasonevalue() {
        let sql = render_resolution_sql(
            "IF(HASONEVALUE(category_name), SELECTEDVALUE(category_name), \"*\")",
            "products",
            "category_name",
        )
        .unwrap();
        assert!(sql.contains("COUNT(DISTINCT products.\"category_name\")"));
        assert!(sql.contains("'*'"));
    }

    #[test]
    fn render_resolution_selectedvalue() {
        let sql = render_resolution_sql(
            "SELECTEDVALUE(category_name, \"Multiple\")",
            "products",
            "category_name",
        )
        .unwrap();
        assert!(sql.contains("COUNT(DISTINCT products.\"category_name\")"));
        assert!(sql.contains("'Multiple'"));
    }

    #[test]
    fn render_resolution_first() {
        let sql =
            render_resolution_sql("FIRST(name, ORDER BY sort_order)", "products", "name").unwrap();
        assert_eq!(
            sql,
            "FIRST_VALUE(products.\"name\" ORDER BY products.\"sort_order\")"
        );
    }

    #[test]
    fn render_resolution_var_return() {
        let sql = render_resolution_sql(
            "VAR cnt = DISTINCTCOUNT(name) RETURN IF(cnt > 1, \"*\", MIN(name))",
            "products",
            "name",
        )
        .unwrap();
        // After inlining: IF(DISTINCTCOUNT(name) > 1, "*", MIN(name))
        assert!(sql.contains("COUNT(DISTINCT products.\"name\")"));
        assert!(sql.contains("MIN(products.\"name\")"));
    }

    #[test]
    fn render_resolution_complex_pinned() {
        // Equivalence oracle for the unified renderer migration: VAR/RETURN +
        // IF + comparison + aggregates + a literal with an embedded quote.
        // Pinned from the pre-unification implementation — must never change.
        let sql = render_resolution_sql(
            "VAR cnt = DISTINCTCOUNT(category_name) \
             RETURN IF(cnt > 1, \"*'s\", MIN(category_name))",
            "products",
            "category_name",
        )
        .unwrap();
        assert_eq!(
            sql,
            "CASE WHEN (COUNT(DISTINCT products.\"category_name\") > 1) \
             THEN '*''s' ELSE MIN(products.\"category_name\") END"
        );
    }

    #[test]
    fn render_resolution_simple_min() {
        let sql = render_resolution_sql("MIN(category_name)", "products", "category_name").unwrap();
        assert_eq!(sql, "MIN(products.\"category_name\")");
    }

    #[test]
    fn render_resolution_simple_max() {
        let sql = render_resolution_sql("MAX(category_name)", "products", "category_name").unwrap();
        assert_eq!(sql, "MAX(products.\"category_name\")");
    }
}
