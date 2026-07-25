//! Scalar (ungrouped) measure evaluation.

use crate::compute::aggregate::AggregateResult;
use crate::compute::context::{ContextResolver, ResolvedFilter};
use crate::compute::expression::{expand_global_variables, expand_measure_refs};
use crate::compute::sql_util::{df_table_name, quote_ident_double};
use crate::error::EngineResult;

use super::sql::extract_scalar;
use super::MeasureEngine;

impl<'a> MeasureEngine<'a> {
    /// Evaluate a single measure with outer (query-level) filters.
    ///
    /// Context operations in the measure expression (`keep`, `clear`, `reset`)
    /// are resolved against the outer filters. For example, `reset()` removes
    /// all outer filters, while `keep()` adds additional filters.
    pub async fn evaluate_with_outer_filters(
        &self,
        measure_name: &str,
        outer_filters: &[ResolvedFilter],
    ) -> EngineResult<AggregateResult> {
        let measure = self.model.measure(measure_name)?;

        // Expand measure references, then global variable references.
        let ref_expanded = expand_measure_refs(measure.expression(), self.model)?;
        let expanded = expand_global_variables(&ref_expanded, self.model);

        // Query-scoped (GVAR) variables are resolved once per query at the
        // Engine facade; the in-memory MeasureEngine has no facade to run the
        // inner scalar query, so it fails closed rather than mis-evaluate a
        // GVAR as a per-row VAR.
        if expanded.has_query_scoped_bindings() {
            return Err(crate::error::EngineError::InvalidExpression(format!(
                "measure '{measure_name}' uses a query-scoped (GVAR) variable, which requires \
                 the query-engine facade (Engine::query) and is not supported by the in-memory \
                 MeasureEngine"
            )));
        }

        // Infer fact table after expansion (MeasureRef measures have empty cached_table).
        let table_name_owned;
        let table_name = if measure.table().is_empty() {
            table_name_owned =
                crate::compute::expression::infer_fact_table(&expanded).ok_or_else(|| {
                    crate::error::EngineError::InvalidData(format!(
                        "cannot infer fact table for measure '{measure_name}'"
                    ))
                })?;
            &table_name_owned
        } else {
            measure.table()
        };

        // Resolve context operations from the expression.
        let resolver = ContextResolver::new(self.model);
        let (stripped_expr, eval_ctx) = resolver.resolve(&expanded)?;
        let effective = eval_ctx.effective_filters(outer_filters);

        // Two-stage evaluation for measures with QUERY bindings.
        if stripped_expr.has_query_bindings() {
            return self
                .evaluate_query_block(measure_name, &stripped_expr, table_name, &effective)
                .await;
        }

        // Get table data and materialize calculated columns if needed.
        let batch = self.get_table_batch(table_name).await?;

        let ctx = self.session_context();
        ctx.register_batch("t", batch)?;

        // Register dimension tables if we have cross-table filters.
        // For unsafe relationships (ManyToMany, non-equi), use EXISTS
        // subquery instead of JOIN to prevent row explosion.
        let cross_table_filters = self
            .register_cross_table_data(&ctx, table_name, &effective, &eval_ctx)
            .await?;

        let expr_sql = stripped_expr.to_sql_string()?;
        let mut sql = format!(
            "SELECT {expr_sql} AS {} FROM t",
            quote_ident_double(measure.name())
        );

        // Classify cross-table filters into direct JOINs and EXISTS subqueries.
        let mut exists_parts: Vec<String> = Vec::new();
        let mut exists_tables: std::collections::HashSet<String> = std::collections::HashSet::new();
        for (dim_lower, join_clause, is_safe) in &cross_table_filters {
            if *is_safe {
                sql.push_str(&format!(" JOIN {dim_lower} ON {join_clause}"));
            } else {
                // Unsafe: use EXISTS subquery instead of JOIN.
                // The EXISTS clause already contains the dim filters.
                exists_parts.push(join_clause.clone());
                exists_tables.insert(dim_lower.clone());
            }
        }

        // Build WHERE clause from resolved filters, excluding filters on tables
        // handled by EXISTS (those filters are already embedded in the EXISTS clause).
        let safe_filters: Vec<ResolvedFilter> = effective
            .iter()
            .filter(|f| !exists_tables.contains(&df_table_name(&f.table)))
            .cloned()
            .collect();
        let where_clause = self.build_where_clause(&safe_filters, table_name);
        let mut registered = std::collections::HashSet::new();
        registered.insert("t".to_string());
        let in_conditions = self
            .build_in_filter_sql(&ctx, &eval_ctx.in_filters, table_name, &mut registered)
            .await?;

        let mut all_where: Vec<String> = Vec::new();
        if !where_clause.is_empty() {
            all_where.push(where_clause);
        }
        all_where.extend(in_conditions);
        all_where.extend(exists_parts);

        if !all_where.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&all_where.join(" AND "));
        }

        let df = ctx.sql(&sql).await?;
        let batches = df.collect().await?;

        let scalar = extract_scalar(&batches)?;
        Ok(AggregateResult {
            operation: measure
                .simple_operation()
                .unwrap_or(crate::compute::aggregate::AggregateOp::Sum),
            column: measure.name().to_string(),
            value: scalar,
        })
    }
}

#[cfg(test)]
mod tests {
    use datafusion::common::ScalarValue;

    use super::super::test_fixtures::{
        periods_table, populated_store, products_table, sales_table, single_table_model,
        store_with_periods,
    };
    use super::MeasureEngine;
    use crate::compute::aggregate::AggregateOp;
    use crate::compute::context::ResolvedFilter;
    use crate::compute::expression::{self as expr, ComparisonOp};
    use crate::compute::measure::{expression_measure, sum_measure};
    use crate::model::calculated_column::CalculatedColumn;
    use crate::model::column::Column;
    use crate::model::relationship::{JoinCondition, JoinOperator, Relationship};
    use crate::model::schema::DataModel;
    use crate::model::table::Table;
    use crate::store::ColumnStore;
    use crate::types::{DataType, Value};

    #[tokio::test]
    async fn evaluate_sum_scalar() {
        let model = single_table_model();
        let store = populated_store();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("TotalAmount").await.unwrap();
        assert_eq!(result.as_f64(), Some(100.0)); // 50 + 30 + 20
    }

    #[tokio::test]
    async fn evaluate_count_scalar() {
        let model = single_table_model();
        let store = populated_store();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("OrderCount").await.unwrap();
        // COUNT returns Int64 or UInt64 depending on DataFusion version
        let count_val = match &result.value {
            ScalarValue::Int64(Some(n)) => *n,
            ScalarValue::UInt64(Some(n)) => *n as i64,
            other => panic!("Unexpected scalar type: {other:?}"),
        };
        assert_eq!(count_val, 3);
    }

    #[tokio::test]
    async fn evaluate_distinct_count_scalar() {
        let model = single_table_model();
        let store = populated_store();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("UniqueProducts").await.unwrap();
        let count_val = match &result.value {
            ScalarValue::Int64(Some(n)) => *n,
            ScalarValue::UInt64(Some(n)) => *n as i64,
            other => panic!("Unexpected scalar type: {other:?}"),
        };
        assert_eq!(count_val, 2); // product_id 101, 102
    }

    #[tokio::test]
    async fn evaluate_expression_measure() {
        let model = single_table_model();
        let store = populated_store();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("Revenue").await.unwrap();
        // SUM(price * quantity) = (10*5) + (15*2) + (20*1) = 50 + 30 + 20 = 100
        assert_eq!(result.as_f64(), Some(100.0));
    }

    #[tokio::test]
    async fn evaluate_ratio_measure() {
        let model = single_table_model();
        let store = populated_store();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("AvgOrderValue").await.unwrap();
        // SUM(amount) / COUNT(id) = 100.0 / 3 ≈ 33.33
        let val = result.as_f64().unwrap();
        assert!((val - 100.0 / 3.0).abs() < 0.01);
    }

    // --- Context-aware evaluation tests ---

    fn store_with_regions() -> ColumnStore {
        let mut store = ColumnStore::new();
        let sales = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("product_id", DataType::Int64),
                Column::new("amount", DataType::Float64),
                Column::new("region", DataType::String),
            ],
        )
        .unwrap();
        store.register_table(sales).unwrap();
        store.register_table(products_table()).unwrap();

        store
            .insert_rows(
                "Sales",
                vec![
                    vec![
                        Value::Int64(1),
                        Value::Int64(101),
                        Value::Float64(50.0),
                        Value::String("US".into()),
                    ],
                    vec![
                        Value::Int64(2),
                        Value::Int64(102),
                        Value::Float64(30.0),
                        Value::String("EU".into()),
                    ],
                    vec![
                        Value::Int64(3),
                        Value::Int64(101),
                        Value::Float64(20.0),
                        Value::String("US".into()),
                    ],
                ],
            )
            .unwrap();

        store
            .insert_rows(
                "Products",
                vec![
                    vec![
                        Value::Int64(101),
                        Value::String("Widget".into()),
                        Value::String("A".into()),
                    ],
                    vec![
                        Value::Int64(102),
                        Value::String("Gadget".into()),
                        Value::String("B".into()),
                    ],
                ],
            )
            .unwrap();

        store
    }

    fn context_aware_model() -> DataModel {
        use crate::compute::expression::{ComparisonOp, FilterPredicate};
        use crate::model::context::{ContextDefinition, ContextOp};

        let sales = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("product_id", DataType::Int64),
                Column::new("amount", DataType::Float64),
                Column::new("region", DataType::String),
            ],
        )
        .unwrap();

        DataModel::builder()
            .add_table(sales)
            .add_table(products_table())
            .add_relationship(Relationship::many_to_one(
                "Sales_Products",
                "Sales",
                "product_id",
                "Products",
                "id",
            ))
            // Measure with keep(): sum only US
            .add_measure(expression_measure(
                "US_Revenue",
                expr::agg(
                    AggregateOp::Sum,
                    expr::keep(
                        expr::qualified_col("Sales", "amount"),
                        vec![FilterPredicate::new(
                            "Sales",
                            "region",
                            ComparisonOp::Equal,
                            "US",
                        )],
                    ),
                ),
            ))
            // Measure with reset(): always total
            .add_measure(expression_measure(
                "TotalAll",
                expr::agg(
                    AggregateOp::Sum,
                    expr::reset(expr::qualified_col("Sales", "amount")),
                ),
            ))
            // Plain measure for comparison
            .add_measure(sum_measure("Revenue", "Sales", "amount"))
            // Measure with cross-table keep
            .add_measure(expression_measure(
                "CategoryA_Revenue",
                expr::agg(
                    AggregateOp::Sum,
                    expr::keep(
                        expr::qualified_col("Sales", "amount"),
                        vec![FilterPredicate::new(
                            "Products",
                            "category",
                            ComparisonOp::Equal,
                            "A",
                        )],
                    ),
                ),
            ))
            // Named context measure
            .add_context(ContextDefinition::new(
                "ctx_us",
                vec![ContextOp::Keep(vec![FilterPredicate::new(
                    "Sales",
                    "region",
                    ComparisonOp::Equal,
                    "US",
                )])],
            ))
            .add_measure(expression_measure(
                "US_Revenue_Via_Context",
                expr::agg(
                    AggregateOp::Sum,
                    expr::using(expr::qualified_col("Sales", "amount"), "ctx_us"),
                ),
            ))
            .build()
            .unwrap()
    }

    #[tokio::test]
    async fn evaluate_measure_with_keep_filter() {
        let model = context_aware_model();
        let store = store_with_regions();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("US_Revenue").await.unwrap();
        // Only US rows: 50 + 20 = 70
        assert_eq!(result.as_f64(), Some(70.0));
    }

    #[tokio::test]
    async fn evaluate_measure_with_reset_ignores_outer() {
        use crate::compute::expression::ComparisonOp;
        let model = context_aware_model();
        let store = store_with_regions();
        let engine = MeasureEngine::new(&model, &store);

        // Evaluate with outer filter (region=EU)
        let outer = vec![ResolvedFilter::new(
            "Sales",
            "region",
            ComparisonOp::Equal,
            "EU",
        )];

        // TotalAll has reset() — should ignore outer filter
        let result = engine
            .evaluate_with_outer_filters("TotalAll", &outer)
            .await
            .unwrap();
        assert_eq!(result.as_f64(), Some(100.0)); // All rows: 50+30+20

        // Revenue (no reset) — should respect outer filter
        let result = engine
            .evaluate_with_outer_filters("Revenue", &outer)
            .await
            .unwrap();
        assert_eq!(result.as_f64(), Some(30.0)); // Only EU: 30
    }

    #[tokio::test]
    async fn evaluate_measure_with_cross_table_filter() {
        let model = context_aware_model();
        let store = store_with_regions();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("CategoryA_Revenue").await.unwrap();
        // Category A = product 101 → Sales rows with product_id=101: 50+20=70
        assert_eq!(result.as_f64(), Some(70.0));
    }

    #[tokio::test]
    async fn evaluate_measure_with_named_context() {
        let model = context_aware_model();
        let store = store_with_regions();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("US_Revenue_Via_Context").await.unwrap();
        // ctx_us applies region=US filter → 50+20=70
        assert_eq!(result.as_f64(), Some(70.0));
    }

    #[tokio::test]
    async fn evaluate_with_in_filter() {
        use crate::compute::expression::{ComparisonOp, FilterPredicate, InPredicate};
        use crate::model::table_variable::TableVariable;

        // Products: 101=Widget(A), 102=Gadget(B)
        // Sales: row1(product_id=101, amount=50), row2(product_id=102, amount=30),
        //        row3(product_id=101, amount=20)
        // Variable "premium" = Products WHERE category = "A" → only product 101
        // Measure: SUM(keep_in(amount, Sales.product_id IN premium.id))
        // Expected: 50 + 20 = 70 (only sales for product 101)

        let model = DataModel::builder()
            .add_table(sales_table())
            .add_table(products_table())
            .add_relationship(Relationship::many_to_one(
                "Sales_Products",
                "Sales",
                "product_id",
                "Products",
                "id",
            ))
            .add_table_variable(TableVariable::new(
                "premium",
                "Products",
                vec![FilterPredicate::new(
                    "Products",
                    "category",
                    ComparisonOp::Equal,
                    "A",
                )],
            ))
            .add_measure(crate::compute::measure::Measure::new(
                "PremiumRevenue",
                expr::agg(
                    AggregateOp::Sum,
                    expr::keep_in(
                        expr::qualified_col("Sales", "amount"),
                        vec![InPredicate::new("Sales", "product_id", "premium", "id")],
                    ),
                ),
            ))
            .build()
            .unwrap();

        let store = populated_store();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("PremiumRevenue").await.unwrap();
        assert_eq!(result.as_f64(), Some(70.0));
    }

    #[tokio::test]
    async fn evaluate_in_filter_with_composed_variable() {
        use crate::compute::expression::{ComparisonOp, FilterPredicate, InPredicate};
        use crate::model::table_variable::TableVariable;

        // "premium" = Products WHERE category = "A" → product 101 (Widget)
        // "named_premium" = premium WHERE name != "" → still product 101
        // Measure: SUM(keep_in(amount, Sales.product_id IN named_premium.id))
        // Expected: 50 + 20 = 70

        let model = DataModel::builder()
            .add_table(sales_table())
            .add_table(products_table())
            .add_relationship(Relationship::many_to_one(
                "Sales_Products",
                "Sales",
                "product_id",
                "Products",
                "id",
            ))
            .add_table_variable(TableVariable::new(
                "premium",
                "Products",
                vec![FilterPredicate::new(
                    "Products",
                    "category",
                    ComparisonOp::Equal,
                    "A",
                )],
            ))
            .add_table_variable(TableVariable::new(
                "named_premium",
                "premium",
                vec![FilterPredicate::new(
                    "Products",
                    "name",
                    ComparisonOp::NotEqual,
                    "",
                )],
            ))
            .add_measure(crate::compute::measure::Measure::new(
                "NamedPremiumRevenue",
                expr::agg(
                    AggregateOp::Sum,
                    expr::keep_in(
                        expr::qualified_col("Sales", "amount"),
                        vec![InPredicate::new(
                            "Sales",
                            "product_id",
                            "named_premium",
                            "id",
                        )],
                    ),
                ),
            ))
            .build()
            .unwrap();

        let store = populated_store();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("NamedPremiumRevenue").await.unwrap();
        assert_eq!(result.as_f64(), Some(70.0));
    }

    #[tokio::test]
    async fn evaluate_with_calculated_column() {
        let model = DataModel::builder()
            .add_table(sales_table())
            .add_calculated_column(CalculatedColumn::new(
                "line_total",
                "Sales",
                expr::col("price").multiply(expr::col("quantity")),
                DataType::Float64,
            ))
            .add_measure(sum_measure("TotalRevenue", "Sales", "line_total"))
            .build()
            .unwrap();

        let store = populated_store();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("TotalRevenue").await.unwrap();
        // SUM(price*quantity) = 50 + 30 + 20 = 100
        assert_eq!(result.as_f64(), Some(100.0));
    }

    #[tokio::test]
    async fn scalar_semi_join_filter_non_equi() {
        use crate::compute::context::ResolvedFilter;
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

        // Filter to period "P2" (covers 102..=103).
        // Without semi-join, the JOIN would duplicate sales for pid=102.
        // With semi-join: SUM of sales where product_id matches any P2 row.
        // Matching sales: pid=102 (20) + pid=103 (15) = 35
        let result = engine
            .evaluate_with_outer_filters(
                "Revenue",
                &[ResolvedFilter {
                    table: "Periods".to_string(),
                    column: "period_name".to_string(),
                    operator: ComparisonOp::Equal,
                    value: "P2".to_string(),
                    source: crate::compute::context::FilterSource::Query,
                }],
            )
            .await
            .unwrap();

        assert!(
            (result.as_f64().unwrap() - 35.0).abs() < 0.01,
            "Expected 35.0, got {:?}",
            result.as_f64()
        );
    }
}
