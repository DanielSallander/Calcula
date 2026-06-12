//! Grouped measure evaluation, including the pre-aggregate (boundary) path
//! for unsafe (many-to-many / non-equi) GROUP BY dimensions.

use arrow::compute::concat_batches;
use arrow::record_batch::RecordBatch;
use datafusion::prelude::SessionContext;

use crate::compute::context::{
    format_filter_value, ContextResolver, EvaluationContext, ResolvedFilter,
};
use crate::compute::expression::{expand_global_variables, expand_measure_refs, Expression};
use crate::compute::sql_util::quote_ident_double;
use crate::error::EngineResult;
use crate::types::TableColumn;

use super::MeasureEngine;

impl<'a> MeasureEngine<'a> {
    /// Evaluate a measure grouped by one or more columns.
    ///
    /// Group-by columns may reference the measure's own table or dimension
    /// tables connected via relationships in the data model.
    pub async fn evaluate_grouped(
        &self,
        measure_name: &str,
        group_by: &[TableColumn],
    ) -> EngineResult<RecordBatch> {
        self.evaluate_grouped_with_outer_filters(measure_name, group_by, &[])
            .await
    }

    /// Evaluate a measure grouped by columns, with outer (query-level) filters.
    pub async fn evaluate_grouped_with_outer_filters(
        &self,
        measure_name: &str,
        group_by: &[TableColumn],
        outer_filters: &[ResolvedFilter],
    ) -> EngineResult<RecordBatch> {
        let measure = self.model.measure(measure_name)?;

        // Expand measure references, then global variable references.
        let ref_expanded = expand_measure_refs(measure.expression(), self.model)?;
        let expanded = expand_global_variables(&ref_expanded, self.model);

        // Infer fact table after expansion (MeasureRef measures have empty cached_table).
        let fact_table_owned;
        let fact_table = if measure.table().is_empty() {
            fact_table_owned =
                crate::compute::expression::infer_fact_table(&expanded).ok_or_else(|| {
                    crate::error::EngineError::InvalidData(format!(
                        "cannot infer fact table for measure '{measure_name}'"
                    ))
                })?;
            &fact_table_owned
        } else {
            measure.table()
        };

        // Detect compound expressions with independent context ops combined
        // with unsafe GROUP BY dims. These need per-sub-expression evaluation.
        let has_unsafe_group_by_dim = group_by.iter().any(|tc| {
            tc.table != fact_table
                && self
                    .model
                    .find_relationship(fact_table, &tc.table)
                    .map(|rel| !rel.is_safe_for_direct_join())
                    .unwrap_or(false)
        });

        let is_compound_with_context = expanded.has_context_ops()
            && matches!(
                &expanded,
                Expression::BinaryOp { .. }
                    | Expression::SafeDivide { .. }
                    | Expression::ScalarFunc { .. }
                    | Expression::Coalesce(_)
                    | Expression::If { .. }
            );

        if has_unsafe_group_by_dim && is_compound_with_context {
            return self
                .evaluate_grouped_compound_boundary(
                    measure_name,
                    &expanded,
                    fact_table,
                    group_by,
                    outer_filters,
                )
                .await;
        }

        // Resolve context operations.
        let resolver = ContextResolver::new(self.model);
        let (stripped_expr, eval_ctx) = resolver.resolve(&expanded)?;
        let effective = eval_ctx.effective_filters(outer_filters);

        // Two-stage evaluation for measures with QUERY bindings.
        if stripped_expr.has_query_bindings() {
            return self
                .evaluate_query_block_grouped(
                    measure_name,
                    &stripped_expr,
                    fact_table,
                    group_by,
                    &effective,
                )
                .await;
        }

        // Determine which tables are involved (from group-by + filters).
        let group_by_tables: std::collections::HashSet<&str> =
            group_by.iter().map(|tc| tc.table.as_str()).collect();

        let mut tables_needed: Vec<&str> = vec![fact_table];
        for tc in group_by {
            if tc.table != fact_table && !tables_needed.contains(&tc.table.as_str()) {
                tables_needed.push(&tc.table);
            }
        }
        for f in &effective {
            if f.table != fact_table && !tables_needed.contains(&f.table.as_str()) {
                tables_needed.push(&f.table);
            }
        }

        let ctx = self.session_context();

        // Register all needed tables (with calculated columns materialized).
        for table_name in &tables_needed {
            let batch = self.get_table_batch(table_name).await?;
            let df_name = table_name.to_lowercase();
            ctx.register_batch(&df_name, batch)?;
        }

        let fact_lower = fact_table.to_lowercase();

        // Classify dimension tables by join safety.
        let mut unsafe_group_by: Vec<&TableColumn> = Vec::new();
        let mut exists_tables: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut exists_parts: Vec<String> = Vec::new();

        for table_name in &tables_needed {
            if *table_name == fact_table {
                continue;
            }
            let rel = eval_ctx.resolve_relationship(self.model, fact_table, table_name)?;
            if rel.is_safe_for_direct_join() {
                continue; // Will use direct JOIN below.
            }

            let has_group_by_cols = group_by_tables.contains(table_name);
            if has_group_by_cols {
                // Track unsafe GROUP BY dims for pre-aggregation.
                for tc in group_by {
                    if tc.table.as_str() == *table_name {
                        unsafe_group_by.push(tc);
                    }
                }
            } else {
                // Filter-only unsafe dim: use EXISTS.
                let fact_is_from = rel.from_table() == fact_table;
                let dim_filters: Vec<String> = effective
                    .iter()
                    .filter(|f| f.table.as_str() == *table_name)
                    .map(|f| {
                        let op = f.operator.as_sql();
                        let val = format_filter_value(&f.table, &f.column, &f.value, self.model);
                        format!("__d.{} {op} {val}", quote_ident_double(&f.column))
                    })
                    .collect();
                let dim_lower = table_name.to_lowercase();
                if let Some(boundary) =
                    rel.build_boundary_clause(&fact_lower, &dim_lower, fact_is_from, &dim_filters)
                {
                    exists_parts.push(boundary);
                } else {
                    let exists = rel.build_exists_clause(
                        &fact_lower,
                        &dim_lower,
                        fact_is_from,
                        &dim_filters,
                    );
                    exists_parts.push(exists);
                }
                exists_tables.insert(dim_lower);
            }
        }

        // If there are unsafe GROUP BY dims, use pre-aggregate approach.
        if !unsafe_group_by.is_empty() {
            return self
                .evaluate_grouped_pre_aggregate(
                    measure_name,
                    &stripped_expr,
                    fact_table,
                    group_by,
                    &effective,
                    &eval_ctx,
                    &ctx,
                )
                .await;
        }

        // Build SELECT: group_by columns + measure expression
        let mut select_parts: Vec<String> = Vec::new();
        let mut group_parts: Vec<String> = Vec::new();

        for tc in group_by {
            let tbl = tc.table.to_lowercase();
            let qualified = format!("{tbl}.{}", quote_ident_double(&tc.column));
            select_parts.push(qualified.clone());
            group_parts.push(qualified);
        }

        let expr_sql = stripped_expr.to_sql_string()?;
        select_parts.push(format!(
            "{expr_sql} AS {}",
            quote_ident_double(measure.name())
        ));

        let select_clause = select_parts.join(", ");
        let mut sql = format!("SELECT {select_clause} FROM {fact_lower}");

        // Add JOINs for safe dimension tables only.
        let mut joined = std::collections::HashSet::new();
        joined.insert(fact_lower.clone());
        joined.extend(exists_tables.iter().cloned());

        for table_name in &tables_needed {
            let dim_lower = table_name.to_lowercase();
            if joined.contains(&dim_lower) {
                continue;
            }

            let rel = eval_ctx.resolve_relationship(self.model, fact_table, table_name)?;
            let left_is_from = rel.from_table() == fact_table;
            let on_clause = rel.build_on_clause(&fact_lower, &dim_lower, left_is_from);
            sql.push_str(&format!(" JOIN {dim_lower} ON {on_clause}"));
            joined.insert(dim_lower);
        }

        // WHERE clause: exclude filters on tables handled by EXISTS.
        let where_parts: Vec<String> = effective
            .iter()
            .filter(|f| !exists_tables.contains(&f.table.to_lowercase()))
            .map(|f| {
                let tbl = if f.table == fact_table {
                    fact_lower.clone()
                } else {
                    f.table.to_lowercase()
                };
                let op = f.operator.as_sql();
                let val = format_filter_value(&f.table, &f.column, &f.value, self.model);
                format!("{tbl}.{} {op} {val}", quote_ident_double(&f.column))
            })
            .collect();
        let in_conditions = self
            .build_in_filter_sql(&ctx, &eval_ctx.in_filters, fact_table, &mut joined)
            .await?;

        let mut all_where = where_parts;
        all_where.extend(in_conditions);
        all_where.extend(exists_parts);

        if !all_where.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&all_where.join(" AND "));
        }

        // GROUP BY
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

    /// Boundary-based grouped evaluation for unsafe (ManyToMany, non-equi) dimensions.
    ///
    /// For non-equi relationships, the DAX semantics are: for each GROUP BY
    /// group, include fact rows that match ANY dimension row in that group.
    /// This translates to computing boundary values (MAX/MIN) per group,
    /// then filtering fact rows against those boundaries via CROSS JOIN.
    #[allow(clippy::too_many_arguments)]
    async fn evaluate_grouped_pre_aggregate(
        &self,
        measure_name: &str,
        stripped_expr: &crate::compute::expression::Expression,
        fact_table: &str,
        group_by: &[TableColumn],
        effective: &[ResolvedFilter],
        eval_ctx: &EvaluationContext,
        ctx: &SessionContext,
    ) -> EngineResult<RecordBatch> {
        let fact_lower = fact_table.to_lowercase();

        // Identify the unsafe dim and its relationship.
        let mut unsafe_dim: Option<(&str, &crate::model::relationship::Relationship)> = None;
        for tc in group_by {
            if tc.table == fact_table {
                continue;
            }
            let rel = eval_ctx.resolve_relationship(self.model, fact_table, &tc.table)?;
            if !rel.is_safe_for_direct_join() {
                unsafe_dim = Some((&tc.table, rel));
                break;
            }
        }

        let (unsafe_dim_name, rel) = unsafe_dim.ok_or_else(|| {
            crate::error::EngineError::InvalidData(
                "Expected unsafe dimension for pre-aggregate".into(),
            )
        })?;
        let dim_lower = unsafe_dim_name.to_lowercase();
        let fact_is_from = rel.from_table() == fact_table;

        // --- Step 1: Compute boundary values per GROUP BY group ---
        let mut bounds_select: Vec<String> = Vec::new();
        let mut bounds_group: Vec<String> = Vec::new();
        let mut where_conditions: Vec<String> = Vec::new();

        // Only include unsafe dim columns in the bounds query.
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
                "{fact_lower}.{} {op} __bounds.\"{boundary_alias}\"",
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
        ctx.register_batch("__bounds", bounds_combined)?;

        // --- Step 2: CROSS JOIN fact × bounds, filter by boundary ---
        // Also JOIN safe dims for their GROUP BY columns.
        let mut main_select: Vec<String> = Vec::new();
        let mut main_group: Vec<String> = Vec::new();

        for tc in group_by {
            if tc.table.eq_ignore_ascii_case(unsafe_dim_name) {
                // Unsafe dim columns come from __bounds.
                let qualified = format!("__bounds.{}", quote_ident_double(&tc.column));
                main_select.push(qualified.clone());
                main_group.push(qualified);
            } else if tc.table == fact_table {
                let qualified = format!("{fact_lower}.{}", quote_ident_double(&tc.column));
                main_select.push(qualified.clone());
                main_group.push(qualified);
            } else {
                // Safe dim columns come from their joined table.
                let tbl = tc.table.to_lowercase();
                let qualified = format!("{tbl}.{}", quote_ident_double(&tc.column));
                main_select.push(qualified.clone());
                main_group.push(qualified);
            }
        }

        // Measure aggregate.
        let expr_sql = stripped_expr.to_sql_string()?;
        main_select.push(format!(
            "{expr_sql} AS {}",
            quote_ident_double(measure_name)
        ));

        let mut main_from = format!("{fact_lower} CROSS JOIN __bounds");

        // Join safe dims (from GROUP BY + from effective filters).
        let mut main_joined = std::collections::HashSet::new();
        main_joined.insert(fact_lower.clone());
        main_joined.insert("__bounds".to_string());

        // Collect all tables that need JOINing: GROUP BY dims + filter dims.
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
            let tbl = table_name.to_lowercase();
            if main_joined.contains(&tbl) {
                continue;
            }
            if let Ok(safe_rel) = eval_ctx.resolve_relationship(self.model, fact_table, table_name)
            {
                let left_is_from = safe_rel.from_table() == fact_table;
                let on_clause = safe_rel.build_on_clause(&fact_lower, &tbl, left_is_from);
                main_from.push_str(&format!(" JOIN {tbl} ON {on_clause}"));
                main_joined.insert(tbl);
            }
        }

        // WHERE: boundary conditions + ALL effective filters (fact + dim tables).
        let context_filters: Vec<String> = effective
            .iter()
            .filter(|f| !f.table.eq_ignore_ascii_case(unsafe_dim_name))
            .map(|f| {
                let tbl = if f.table == fact_table {
                    fact_lower.clone()
                } else {
                    f.table.to_lowercase()
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
}

#[cfg(test)]
mod tests {
    use datafusion::common::ScalarValue;

    use super::super::test_fixtures::{
        periods_table, populated_store, sales_table, single_table_model, star_schema_model,
        store_with_periods,
    };
    use super::MeasureEngine;
    use crate::compute::measure::sum_measure;
    use crate::model::relationship::{JoinCondition, JoinOperator, Relationship};
    use crate::types::TableColumn;

    #[tokio::test]
    async fn evaluate_grouped_same_table() {
        let model = single_table_model();
        let store = populated_store();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine
            .evaluate_grouped("TotalAmount", &[TableColumn::new("Sales", "product_id")])
            .await
            .unwrap();

        // Two groups: product_id 101 (50+20=70), product_id 102 (30)
        assert_eq!(result.num_columns(), 2);
        assert_eq!(result.num_rows(), 2);
    }

    #[tokio::test]
    async fn evaluate_grouped_star_schema() {
        let model = star_schema_model();
        let store = populated_store();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine
            .evaluate_grouped("TotalAmount", &[TableColumn::new("Products", "category")])
            .await
            .unwrap();

        // Category A: product 101 → 50+20=70, Category B: product 102 → 30
        assert_eq!(result.num_columns(), 2);
        assert_eq!(result.num_rows(), 2);
    }

    #[tokio::test]
    async fn grouped_pre_aggregate_sum_non_equi() {
        use crate::model::schema::DataModel;

        let model = DataModel::builder()
            .add_table(sales_table())
            .add_table(periods_table())
            .add_relationship(Relationship::many_to_many(
                "Sales_Periods",
                "Sales",
                "Periods",
                vec![
                    JoinCondition::new("product_id", "start_id", JoinOperator::GreaterThanOrEqual),
                    JoinCondition::new("product_id", "end_id", JoinOperator::LessThanOrEqual),
                ],
            ))
            .add_measure(sum_measure("Revenue", "Sales", "amount"))
            .build()
            .unwrap();

        let store = store_with_periods();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine
            .evaluate_grouped(
                "Revenue",
                &[TableColumn {
                    table: "Periods".to_string(),
                    column: "period_name".to_string(),
                }],
            )
            .await
            .unwrap();

        assert_eq!(result.num_rows(), 2);

        let names: Vec<&str> = (0..result.num_rows())
            .map(|i| {
                result
                    .column(0)
                    .as_any()
                    .downcast_ref::<arrow::array::StringArray>()
                    .unwrap()
                    .value(i)
            })
            .collect();

        let sums: Vec<f64> = (0..result.num_rows())
            .map(|i| {
                let col = result.column(1);
                ScalarValue::try_from_array(col, i)
                    .ok()
                    .and_then(|s| match s {
                        ScalarValue::Float64(v) => v,
                        _ => None,
                    })
                    .unwrap_or(0.0)
            })
            .collect();

        for (name, total) in names.iter().zip(sums.iter()) {
            match *name {
                // P1 covers 101..=102: pid 101 (10+30=40) + pid 102 (20) = 60
                "P1" => assert!(
                    (*total - 60.0).abs() < 0.01,
                    "P1 expected 60.0, got {total}"
                ),
                // P2 covers 102..=103: pid 102 (20) + pid 103 (15) = 35
                "P2" => assert!(
                    (*total - 35.0).abs() < 0.01,
                    "P2 expected 35.0, got {total}"
                ),
                other => panic!("Unexpected period: {other}"),
            }
        }
    }
}
