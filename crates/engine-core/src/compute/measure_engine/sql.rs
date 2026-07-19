//! Shared SQL assembly helpers: WHERE clauses, cross-table JOIN/EXISTS
//! registration, IN-membership subqueries, and table batch access.

use arrow::record_batch::RecordBatch;
use datafusion::common::ScalarValue;
use datafusion::prelude::SessionContext;

use crate::compute::context::{
    format_filter_value, EvaluationContext, ResolvedFilter, ResolvedInFilter,
};
use crate::compute::evaluate::materialize_calculated_columns_with_udfs;
use crate::compute::sql_util::{df_table_name, quote_ident_double};
use crate::error::EngineResult;

use super::MeasureEngine;

impl<'a> MeasureEngine<'a> {
    /// Build a WHERE clause from resolved filters.
    pub(super) fn build_where_clause(
        &self,
        filters: &[ResolvedFilter],
        fact_table: &str,
    ) -> String {
        let conditions: Vec<String> = filters
            .iter()
            .map(|f| {
                let tbl = if f.table == fact_table {
                    "t".to_string()
                } else {
                    df_table_name(&f.table)
                };
                let op = f.operator.as_sql();
                let val = format_filter_value(&f.table, &f.column, &f.value, self.model);
                format!("{tbl}.{} {op} {val}", quote_ident_double(&f.column))
            })
            .collect();
        conditions.join(" AND ")
    }

    /// Register dimension tables needed for cross-table filters.
    ///
    /// Returns a list of `(dim_table_lowercase, join_clause)` for each dimension
    /// table that needs to be joined.
    /// Register dimension tables for cross-table filters and return join/exists info.
    ///
    /// Returns tuples of `(dim_table_lower, sql_clause, is_safe)`:
    /// - `is_safe = true`: the sql_clause is an ON clause for a direct JOIN.
    /// - `is_safe = false`: the sql_clause is an EXISTS subquery for a semi-join.
    pub(super) async fn register_cross_table_data(
        &self,
        session: &SessionContext,
        fact_table: &str,
        filters: &[ResolvedFilter],
        eval_ctx: &EvaluationContext,
    ) -> EngineResult<Vec<(String, String, bool)>> {
        let mut joins = Vec::new();
        let mut registered = std::collections::HashSet::new();
        registered.insert(fact_table.to_string());

        for filter in filters {
            if filter.table == fact_table || registered.contains(&filter.table) {
                continue;
            }

            // Find relationship between fact table and filter's table,
            // respecting USERELATIONSHIP overrides.
            let rel = eval_ctx.resolve_relationship(self.model, fact_table, &filter.table)?;
            let dim_lower = df_table_name(&filter.table);
            let fact_is_from = rel.from_table() == fact_table;

            if rel.is_safe_for_direct_join() {
                // Safe: register dim table and emit a JOIN ON clause.
                let batch = self.get_table_batch(&filter.table).await?;
                session.register_batch(&dim_lower, batch)?;

                let join_clause = rel.build_on_clause("t", &dim_lower, fact_is_from);
                joins.push((dim_lower.clone(), join_clause, true));
            } else {
                // Unsafe: register dim table and emit an EXISTS subquery.
                // Collect all filters targeting this dimension table.
                let dim_filters: Vec<String> = filters
                    .iter()
                    .filter(|f| f.table == filter.table)
                    .map(|f| {
                        let op = f.operator.as_sql();
                        let val = format_filter_value(&f.table, &f.column, &f.value, self.model);
                        format!("__d.{} {op} {val}", quote_ident_double(&f.column))
                    })
                    .collect();

                let batch = self.get_table_batch(&filter.table).await?;
                session.register_batch(&dim_lower, batch)?;

                let clause = if let Some(boundary) =
                    rel.build_boundary_clause("t", &dim_lower, fact_is_from, &dim_filters)
                {
                    boundary
                } else {
                    rel.build_exists_clause("t", &dim_lower, fact_is_from, &dim_filters)
                };
                joins.push((dim_lower.clone(), clause, false));
            }
            registered.insert(filter.table.clone());
        }

        Ok(joins)
    }

    /// Register tables and build SQL conditions for IN-membership filters.
    ///
    /// Returns SQL condition strings like:
    /// `t."col" IN (SELECT var_tbl."var_col" FROM var_tbl WHERE ...)`
    pub(super) async fn build_in_filter_sql(
        &self,
        session: &SessionContext,
        in_filters: &[ResolvedInFilter],
        fact_table: &str,
        registered: &mut std::collections::HashSet<String>,
    ) -> EngineResult<Vec<String>> {
        let mut conditions = Vec::new();

        for inf in in_filters {
            let var_lower = format!("var_{}", df_table_name(&inf.var_base_table));

            // Register the variable's base table if not already registered.
            if !registered.contains(&var_lower) {
                let batch = self.get_table_batch(&inf.var_base_table).await?;
                session.register_batch(&var_lower, batch)?;
                registered.insert(var_lower.clone());
            }

            // Build the subquery: SELECT var_tbl."col" FROM var_tbl WHERE <filters>
            let mut subquery = format!(
                "SELECT {var_lower}.{} FROM {var_lower}",
                quote_ident_double(&inf.var_column)
            );

            let mut where_parts: Vec<String> = inf
                .var_filters
                .iter()
                .map(|f| {
                    let op = f.operator.as_sql();
                    let val = format_filter_value(&f.table, &f.column, &f.value, self.model);
                    format!("{var_lower}.{} {op} {val}", quote_ident_double(&f.column))
                })
                .collect();
            // NOT IN with a NULL in the subquery set is never true in SQL —
            // one NULL set member would silently empty the whole result.
            // Excluding NULL set members restores anti-join semantics (they
            // can never match a fact value anyway).
            if inf.negated {
                where_parts.push(format!(
                    "{var_lower}.{} IS NOT NULL",
                    quote_ident_double(&inf.var_column)
                ));
            }
            if !where_parts.is_empty() {
                subquery.push_str(" WHERE ");
                subquery.push_str(&where_parts.join(" AND "));
            }

            // Build the IN / NOT IN condition referencing the fact table
            let fact_prefix = if fact_table == inf.table {
                "t".to_string()
            } else {
                df_table_name(&inf.table)
            };
            let keyword = if inf.negated { "NOT IN" } else { "IN" };
            conditions.push(format!(
                "{fact_prefix}.{} {keyword} ({subquery})",
                quote_ident_double(&inf.column)
            ));
        }

        Ok(conditions)
    }

    /// Get a RecordBatch for a table with calculated columns materialized.
    pub(super) async fn get_table_batch(&self, table_name: &str) -> EngineResult<RecordBatch> {
        let table_data = self.store.table_data(table_name)?;
        let batch = table_data.to_record_batch()?;

        // Materialize any calculated columns for this table. Cross-table
        // (RELATED / LOOKUPVALUE) columns need JOINs and are materialized by
        // the query pipeline's joined pass — the single-batch path skips
        // them (a measure reaching one through THIS path fails closed with
        // column-not-found rather than a wrong number).
        let calc_cols: Vec<_> = self
            .model
            .calculated_columns_for_table(table_name)
            .into_iter()
            .filter(|cc| !cc.is_cross_table())
            .cloned()
            .collect();

        if calc_cols.is_empty() {
            Ok(batch)
        } else {
            materialize_calculated_columns_with_udfs(&batch, &calc_cols, self.udfs()).await
        }
    }
}

pub(super) fn extract_scalar(batches: &[RecordBatch]) -> EngineResult<ScalarValue> {
    if batches.is_empty() || batches[0].num_rows() == 0 {
        return Ok(ScalarValue::Null);
    }
    let col = batches[0].column(0);
    let scalar = ScalarValue::try_from_array(col, 0)?;
    Ok(scalar)
}
