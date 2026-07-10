//! Boundary-based evaluation of compound expressions whose sub-expressions
//! carry independent context operations, combined with unsafe
//! (many-to-many / non-equi) GROUP BY dimensions.

use arrow::compute::concat_batches;
use arrow::record_batch::RecordBatch;
use datafusion::prelude::SessionContext;

use crate::compute::context::{
    format_filter_value, ContextResolver, EvaluationContext, ResolvedFilter,
};
use crate::compute::expression::Expression;
use crate::compute::sql_util::{df_table_name, quote_ident_double};
use crate::error::EngineResult;
use crate::types::TableColumn;

use super::MeasureEngine;

impl<'a> MeasureEngine<'a> {
    /// Compound expression evaluation with boundary approach for unsafe dims.
    ///
    /// For compound expressions (SafeDivide, BinaryOp, etc.) where sub-expressions
    /// have independent context ops (KEEP, CLEAR), each sub-aggregate is resolved
    /// and evaluated independently via the boundary approach. Results are combined
    /// via FULL OUTER JOIN, and the compound arithmetic is applied in a final SQL.
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn evaluate_grouped_compound_boundary(
        &self,
        measure_name: &str,
        expr: &Expression,
        fact_table: &str,
        group_by: &[TableColumn],
        outer_filters: &[ResolvedFilter],
    ) -> EngineResult<RecordBatch> {
        let resolver = ContextResolver::new(self.model);

        // Collect all tables we might need.
        let mut all_tables: Vec<String> = vec![fact_table.to_string()];
        for tc in group_by {
            if !all_tables.iter().any(|t| t == &tc.table) {
                all_tables.push(tc.table.clone());
            }
        }
        // Also register tables from filters and context ops.
        // We'll resolve sub-expressions later; pre-register all model tables
        // that have relationships to the fact table to ensure they're available.
        for rel in self.model.relationships() {
            let dim = if rel.from_table() == fact_table {
                rel.to_table()
            } else if rel.to_table() == fact_table {
                rel.from_table()
            } else {
                continue;
            };
            if !all_tables.iter().any(|t| t == dim) {
                all_tables.push(dim.to_string());
            }
        }

        let ctx = self.session_context();

        // Register all needed tables.
        for table_name in &all_tables {
            let batch = self.get_table_batch(table_name).await?;
            let df_name = df_table_name(&table_name);
            // Avoid re-registering.
            if ctx.table(&df_name).await.is_err() {
                ctx.register_batch(&df_name, batch)?;
            }
        }

        // Extract leaf sub-aggregates from the compound expression.
        // Each leaf is resolved independently via the context resolver.
        let mut sub_results: Vec<String> = Vec::new(); // table names for sub-results
        let mut sub_aliases: Vec<String> = Vec::new(); // alias for measure column in each sub-result
        let mut counter = 0usize;

        // Recursively decompose and evaluate sub-aggregates.
        let result_sql = self
            .decompose_and_evaluate(
                expr,
                fact_table,
                group_by,
                outer_filters,
                &resolver,
                &ctx,
                &mut sub_results,
                &mut sub_aliases,
                &mut counter,
            )
            .await?;

        if sub_results.is_empty() {
            // No sub-aggregates — shouldn't happen for compound expressions.
            return Err(crate::error::EngineError::InvalidData(
                "No sub-aggregates found in compound expression".into(),
            ));
        }

        // Build a combining query.
        // Start from the first sub-result table.
        let first_table = &sub_results[0];
        let group_cols: Vec<String> = group_by
            .iter()
            .map(|tc| quote_ident_double(&tc.column))
            .collect();

        let mut from_clause = first_table.clone();
        for sub_table in &sub_results[1..] {
            if group_cols.is_empty() {
                from_clause.push_str(&format!(" CROSS JOIN {sub_table}"));
            } else {
                let join_conds: Vec<String> = group_cols
                    .iter()
                    .map(|c| format!("{first_table}.{c} = {sub_table}.{c}"))
                    .collect();
                from_clause.push_str(&format!(
                    " FULL OUTER JOIN {sub_table} ON {}",
                    join_conds.join(" AND ")
                ));
            }
        }

        let mut select_parts: Vec<String> = group_cols
            .iter()
            .map(|c| format!("{first_table}.{c}"))
            .collect();
        select_parts.push(format!(
            "{result_sql} AS {}",
            quote_ident_double(measure_name)
        ));

        let combine_sql = format!("SELECT {} FROM {}", select_parts.join(", "), from_clause);

        let df = ctx.sql(&combine_sql).await?;
        let batches = df.collect().await?;

        if batches.is_empty() {
            return Ok(RecordBatch::new_empty(arrow::datatypes::SchemaRef::new(
                arrow::datatypes::Schema::empty(),
            )));
        }

        let schema = batches[0].schema();
        let combined = concat_batches(&schema, &batches)?;
        Ok(combined)
    }

    /// Recursively decompose a compound expression, evaluating each leaf
    /// aggregate via the boundary approach and returning a SQL fragment
    /// that references the sub-result columns.
    #[allow(clippy::too_many_arguments)]
    fn decompose_and_evaluate<'b>(
        &'b self,
        expr: &'b Expression,
        fact_table: &'b str,
        group_by: &'b [TableColumn],
        outer_filters: &'b [ResolvedFilter],
        resolver: &'b ContextResolver<'_>,
        ctx: &'b SessionContext,
        sub_results: &'b mut Vec<String>,
        sub_aliases: &'b mut Vec<String>,
        counter: &'b mut usize,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = EngineResult<String>> + 'b>> {
        Box::pin(async move {
            match expr {
                Expression::BinaryOp { left, op, right } => {
                    let l = self
                        .decompose_and_evaluate(
                            left,
                            fact_table,
                            group_by,
                            outer_filters,
                            resolver,
                            ctx,
                            sub_results,
                            sub_aliases,
                            counter,
                        )
                        .await?;
                    let r = self
                        .decompose_and_evaluate(
                            right,
                            fact_table,
                            group_by,
                            outer_filters,
                            resolver,
                            ctx,
                            sub_results,
                            sub_aliases,
                            counter,
                        )
                        .await?;
                    Ok(format!("({l} {} {r})", op.as_sql()))
                }
                Expression::SafeDivide {
                    numerator,
                    denominator,
                    alternate,
                } => {
                    let n = self
                        .decompose_and_evaluate(
                            numerator,
                            fact_table,
                            group_by,
                            outer_filters,
                            resolver,
                            ctx,
                            sub_results,
                            sub_aliases,
                            counter,
                        )
                        .await?;
                    let d = self
                        .decompose_and_evaluate(
                            denominator,
                            fact_table,
                            group_by,
                            outer_filters,
                            resolver,
                            ctx,
                            sub_results,
                            sub_aliases,
                            counter,
                        )
                        .await?;
                    let alt = if let Some(a) = alternate {
                        self.decompose_and_evaluate(
                            a,
                            fact_table,
                            group_by,
                            outer_filters,
                            resolver,
                            ctx,
                            sub_results,
                            sub_aliases,
                            counter,
                        )
                        .await?
                    } else {
                        "NULL".to_string()
                    };
                    Ok(format!(
                        "CASE WHEN {d} = 0 THEN {alt} ELSE CAST({n} AS DOUBLE) / {d} END"
                    ))
                }
                Expression::If {
                    condition,
                    then_expr,
                    else_expr,
                } => {
                    let c = self
                        .decompose_and_evaluate(
                            condition,
                            fact_table,
                            group_by,
                            outer_filters,
                            resolver,
                            ctx,
                            sub_results,
                            sub_aliases,
                            counter,
                        )
                        .await?;
                    let t = self
                        .decompose_and_evaluate(
                            then_expr,
                            fact_table,
                            group_by,
                            outer_filters,
                            resolver,
                            ctx,
                            sub_results,
                            sub_aliases,
                            counter,
                        )
                        .await?;
                    let e = self
                        .decompose_and_evaluate(
                            else_expr,
                            fact_table,
                            group_by,
                            outer_filters,
                            resolver,
                            ctx,
                            sub_results,
                            sub_aliases,
                            counter,
                        )
                        .await?;
                    Ok(format!("CASE WHEN {c} THEN {t} ELSE {e} END"))
                }
                Expression::ScalarFunc { function, args } => {
                    let mut evaluated_args = Vec::new();
                    for arg in args {
                        let a = self
                            .decompose_and_evaluate(
                                arg,
                                fact_table,
                                group_by,
                                outer_filters,
                                resolver,
                                ctx,
                                sub_results,
                                sub_aliases,
                                counter,
                            )
                            .await?;
                        evaluated_args.push(a);
                    }
                    Ok(function.to_sql_strs(&evaluated_args))
                }
                Expression::Coalesce(exprs) => {
                    let mut evaluated = Vec::new();
                    for e in exprs {
                        let a = self
                            .decompose_and_evaluate(
                                e,
                                fact_table,
                                group_by,
                                outer_filters,
                                resolver,
                                ctx,
                                sub_results,
                                sub_aliases,
                                counter,
                            )
                            .await?;
                        evaluated.push(a);
                    }
                    Ok(format!("COALESCE({})", evaluated.join(", ")))
                }

                // Leaf: an expression that may have context ops (KEEP/CLEAR/etc.)
                // or a plain aggregate. Resolve independently, evaluate via boundary.
                _ if expr.has_aggregate() || expr.has_context_ops() => {
                    let idx = *counter;
                    *counter += 1;
                    let sub_alias = format!("__sub_{idx}");
                    let sub_table = format!("__sub_tbl_{idx}");

                    // Resolve this sub-expression independently.
                    let (stripped, eval_ctx) = resolver.resolve(expr)?;
                    let effective = eval_ctx.effective_filters(outer_filters);

                    // Evaluate via boundary approach.
                    let batch = self
                        .evaluate_sub_aggregate_boundary(
                            &sub_alias, &stripped, fact_table, group_by, &effective, &eval_ctx,
                            ctx, idx,
                        )
                        .await?;

                    if batch.num_rows() > 0 {
                        ctx.register_batch(&sub_table, batch)?;
                    } else {
                        // Register an empty batch with the expected schema.
                        ctx.register_batch(&sub_table, batch)?;
                    }

                    sub_results.push(sub_table.clone());
                    sub_aliases.push(sub_alias.clone());

                    Ok(format!("{sub_table}.\"{sub_alias}\""))
                }

                // Literals and non-aggregate expressions: render as SQL directly.
                _ => expr.to_sql_string(),
            }
        })
    }

    /// Evaluate a single sub-aggregate using the boundary approach.
    /// Returns a RecordBatch with GROUP BY columns + the aggregate column.
    #[allow(clippy::too_many_arguments)]
    async fn evaluate_sub_aggregate_boundary(
        &self,
        alias: &str,
        stripped_expr: &Expression,
        fact_table: &str,
        group_by: &[TableColumn],
        effective: &[ResolvedFilter],
        eval_ctx: &EvaluationContext,
        ctx: &SessionContext,
        idx: usize,
    ) -> EngineResult<RecordBatch> {
        let fact_lower = df_table_name(&fact_table);

        // Find the unsafe dim in GROUP BY.
        let mut unsafe_dim: Option<(&str, &crate::model::relationship::Relationship)> = None;
        for tc in group_by {
            if tc.table == fact_table {
                continue;
            }
            let rel = self.model.find_relationship(fact_table, &tc.table)?;
            if !rel.is_safe_for_direct_join() {
                unsafe_dim = Some((&tc.table, rel));
                break;
            }
        }

        let (unsafe_dim_name, rel) = match unsafe_dim {
            Some(ud) => ud,
            None => {
                // No unsafe dim — evaluate normally with JOINs.
                return self
                    .evaluate_sub_aggregate_safe(
                        alias,
                        stripped_expr,
                        fact_table,
                        group_by,
                        effective,
                        eval_ctx,
                        ctx,
                    )
                    .await;
            }
        };

        let dim_lower = df_table_name(&unsafe_dim_name);
        let fact_is_from = rel.from_table() == fact_table;

        // Step 1: Compute boundary values per group from the unsafe dim.
        let bounds_name = format!("__bounds_{idx}");
        let mut bounds_select: Vec<String> = Vec::new();
        let mut bounds_group: Vec<String> = Vec::new();
        let mut where_conditions: Vec<String> = Vec::new();

        for tc in group_by {
            if tc.table.eq_ignore_ascii_case(unsafe_dim_name) {
                let qualified = format!("{dim_lower}.{}", quote_ident_double(&tc.column));
                bounds_select.push(qualified.clone());
                bounds_group.push(qualified);
            }
        }

        for (ci, cond) in rel.conditions().iter().enumerate() {
            let dim_col = if fact_is_from {
                cond.to_column()
            } else {
                cond.from_column()
            };
            let fact_col = if fact_is_from {
                cond.from_column()
            } else {
                cond.to_column()
            };
            let boundary_agg = cond.operator().boundary_aggregate();
            let boundary_alias = format!("__b_{ci}");
            bounds_select.push(format!(
                "{boundary_agg}({dim_lower}.{}) AS \"{boundary_alias}\"",
                quote_ident_double(dim_col)
            ));

            let op = cond.operator().as_sql();
            where_conditions.push(format!(
                "{fact_lower}.{} {op} {bounds_name}.\"{boundary_alias}\"",
                quote_ident_double(fact_col)
            ));
        }

        let bounds_sql = format!(
            "SELECT {} FROM {} GROUP BY {}",
            bounds_select.join(", "),
            dim_lower,
            bounds_group.join(", ")
        );

        let bounds_df = ctx.sql(&bounds_sql).await?;
        let bounds_batches = bounds_df.collect().await?;

        if bounds_batches.is_empty() {
            return Ok(RecordBatch::new_empty(arrow::datatypes::SchemaRef::new(
                arrow::datatypes::Schema::empty(),
            )));
        }

        let bounds_schema = bounds_batches[0].schema();
        let bounds_combined = concat_batches(&bounds_schema, &bounds_batches)?;
        ctx.register_batch(&bounds_name, bounds_combined)?;

        // Step 2: CROSS JOIN fact × bounds + safe dim JOINs.
        let mut main_select: Vec<String> = Vec::new();
        let mut main_group: Vec<String> = Vec::new();

        for tc in group_by {
            if tc.table.eq_ignore_ascii_case(unsafe_dim_name) {
                let qualified = format!("{bounds_name}.{}", quote_ident_double(&tc.column));
                main_select.push(qualified.clone());
                main_group.push(qualified);
            } else if tc.table == fact_table {
                let qualified = format!("{fact_lower}.{}", quote_ident_double(&tc.column));
                main_select.push(qualified.clone());
                main_group.push(qualified);
            } else {
                let tbl = df_table_name(&tc.table);
                let qualified = format!("{tbl}.{}", quote_ident_double(&tc.column));
                main_select.push(qualified.clone());
                main_group.push(qualified);
            }
        }

        let expr_sql = stripped_expr.to_sql_string()?;
        main_select.push(format!("{expr_sql} AS {}", quote_ident_double(alias)));

        let mut main_from = format!("{fact_lower} CROSS JOIN {bounds_name}");

        // Join safe dims (for GROUP BY + for filters).
        let mut main_joined = std::collections::HashSet::new();
        main_joined.insert(fact_lower.clone());
        main_joined.insert(bounds_name.clone());

        let mut tables_to_join: Vec<String> = Vec::new();
        for tc in group_by {
            if tc.table != fact_table
                && !tc.table.eq_ignore_ascii_case(unsafe_dim_name)
                && !tables_to_join.contains(&tc.table)
            {
                tables_to_join.push(tc.table.clone());
            }
        }
        for f in effective {
            if f.table != fact_table
                && !f.table.eq_ignore_ascii_case(unsafe_dim_name)
                && !tables_to_join.contains(&f.table)
            {
                tables_to_join.push(f.table.clone());
            }
        }

        for table_name in &tables_to_join {
            let tbl = df_table_name(&table_name);
            if main_joined.contains(&tbl) {
                continue;
            }
            if let Ok(safe_rel) = self.model.find_relationship(fact_table, table_name) {
                let left_is_from = safe_rel.from_table() == fact_table;
                let on_clause = safe_rel.build_on_clause(&fact_lower, &tbl, left_is_from);
                main_from.push_str(&format!(" JOIN {tbl} ON {on_clause}"));
                main_joined.insert(tbl);
            }
        }

        // WHERE: boundary conditions + effective filters (all tables).
        let context_filters: Vec<String> = effective
            .iter()
            .filter(|f| !f.table.eq_ignore_ascii_case(unsafe_dim_name))
            .map(|f| {
                let tbl = if f.table == fact_table {
                    fact_lower.clone()
                } else {
                    df_table_name(&f.table)
                };
                let op = f.operator.as_sql();
                let val = format_filter_value(&f.table, &f.column, &f.value, self.model);
                format!("{tbl}.{} {op} {val}", quote_ident_double(&f.column))
            })
            .collect();

        let mut all_where = where_conditions;
        all_where.extend(context_filters);

        let main_sql = format!(
            "SELECT {} FROM {} WHERE {} GROUP BY {}",
            main_select.join(", "),
            main_from,
            all_where.join(" AND "),
            main_group.join(", ")
        );

        let main_df = ctx.sql(&main_sql).await?;
        let main_batches = main_df.collect().await?;

        if main_batches.is_empty() {
            return Ok(RecordBatch::new_empty(arrow::datatypes::SchemaRef::new(
                arrow::datatypes::Schema::empty(),
            )));
        }

        let schema = main_batches[0].schema();
        let combined = concat_batches(&schema, &main_batches)?;
        Ok(combined)
    }

    /// Evaluate a sub-aggregate with only safe dims (standard JOIN approach).
    #[allow(clippy::too_many_arguments)]
    async fn evaluate_sub_aggregate_safe(
        &self,
        alias: &str,
        stripped_expr: &Expression,
        fact_table: &str,
        group_by: &[TableColumn],
        effective: &[ResolvedFilter],
        eval_ctx: &EvaluationContext,
        ctx: &SessionContext,
    ) -> EngineResult<RecordBatch> {
        let fact_lower = df_table_name(&fact_table);

        let mut select_parts: Vec<String> = Vec::new();
        let mut group_parts: Vec<String> = Vec::new();

        for tc in group_by {
            let tbl = df_table_name(&tc.table);
            let qualified = format!("{tbl}.{}", quote_ident_double(&tc.column));
            select_parts.push(qualified.clone());
            group_parts.push(qualified);
        }

        let expr_sql = stripped_expr.to_sql_string()?;
        select_parts.push(format!("{expr_sql} AS {}", quote_ident_double(alias)));

        let mut sql = format!("SELECT {} FROM {fact_lower}", select_parts.join(", "));

        let mut joined = std::collections::HashSet::new();
        joined.insert(fact_lower.clone());

        // Join all needed tables.
        let mut tables_to_join: Vec<String> = Vec::new();
        for tc in group_by {
            if tc.table != fact_table && !tables_to_join.contains(&tc.table) {
                tables_to_join.push(tc.table.clone());
            }
        }
        for f in effective {
            if f.table != fact_table && !tables_to_join.contains(&f.table) {
                tables_to_join.push(f.table.clone());
            }
        }

        for table_name in &tables_to_join {
            let tbl = df_table_name(&table_name);
            if joined.contains(&tbl) {
                continue;
            }
            if let Ok(rel) = eval_ctx.resolve_relationship(self.model, fact_table, table_name) {
                let left_is_from = rel.from_table() == fact_table;
                let on_clause = rel.build_on_clause(&fact_lower, &tbl, left_is_from);
                sql.push_str(&format!(" JOIN {tbl} ON {on_clause}"));
                joined.insert(tbl);
            }
        }

        // WHERE clause.
        let where_parts: Vec<String> = effective
            .iter()
            .map(|f| {
                let tbl = if f.table == fact_table {
                    fact_lower.clone()
                } else {
                    df_table_name(&f.table)
                };
                let op = f.operator.as_sql();
                let val = format_filter_value(&f.table, &f.column, &f.value, self.model);
                format!("{tbl}.{} {op} {val}", quote_ident_double(&f.column))
            })
            .collect();

        if !where_parts.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&where_parts.join(" AND "));
        }

        if !group_parts.is_empty() {
            sql.push_str(" GROUP BY ");
            sql.push_str(&group_parts.join(", "));
        }

        let df = ctx.sql(&sql).await?;
        let batches = df.collect().await?;

        if batches.is_empty() {
            return Ok(RecordBatch::new_empty(arrow::datatypes::SchemaRef::new(
                arrow::datatypes::Schema::empty(),
            )));
        }

        let schema = batches[0].schema();
        let combined = concat_batches(&schema, &batches)?;
        Ok(combined)
    }
}
