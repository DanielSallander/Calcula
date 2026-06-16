//! Column projection computation for `LocalAggregation` source fetches.

use engine_core::compute::expression::{expand_global_variables, expand_measure_refs};
use engine_core::compute::measure::Measure;
use engine_core::model::DataModel;

use crate::request::QueryRequest;

use super::collector::{ProjectionCollector, TableProjections};
use super::LookupSpec;

/// Compute the per-table column projection for `LocalAggregation` fetches.
///
/// The required set for each fetched table is the union of:
/// 1. columns referenced by every measure expression (expanded the same way
///    the execution pipeline expands them before SQL generation), including
///    KEEP/CLEAR/IN/context/window/QUERY references;
/// 2. group-by columns (plus their declared sort-by columns);
/// 3. query filter columns (mirroring the per-table filter heuristic);
/// 4. join-key columns of every relationship — active or inactive, since
///    USERELATIONSHIP can activate inactive ones — whose endpoints are both
///    fetched (this also covers IN-filter propagation key extraction);
/// 5. physical inputs of every calculated column on the table;
/// 6. lookup key/value columns and resolution-expression references.
///
/// Tables served from the in-memory cache always fall back (they are not
/// fetched from a source), as does any table whose requirements cannot be
/// statically determined.
pub(super) fn compute_table_projections(
    request: &QueryRequest,
    model: &DataModel,
    measures: &[Measure],
    fetch_tables: &[String],
    lookup_specs: &[LookupSpec],
    cached_tables: &std::collections::HashSet<String>,
) -> TableProjections {
    let mut collector = ProjectionCollector::new(model, fetch_tables);

    // Tables served from the in-memory cache are never fetched from a source;
    // projection does not apply to them.
    for table_name in fetch_tables {
        let in_memory = model.table(table_name).is_ok_and(|t| t.is_in_memory());
        if in_memory || cached_tables.contains(table_name) {
            collector.mark_fallback(
                table_name,
                "served from in-memory cache (not fetched from source)",
            );
        }
    }

    // 1. Columns referenced by measure expressions.
    for measure in measures {
        match expand_measure_refs(measure.expression(), model) {
            Ok(ref_expanded) => {
                let expanded = expand_global_variables(&ref_expanded, model);
                let analyzed = Measure::new(measure.name(), expanded);
                collector.walk(analyzed.expression());
            }
            Err(e) => {
                collector.set_global_fallback(format!(
                    "measure '{}': reference expansion failed: {e}",
                    measure.name()
                ));
            }
        }
        if collector.global_fallback.is_some() {
            break;
        }
    }

    // 2. Group-by columns plus their declared sort-by columns. A context-driven
    //    calculated column is NOT a physical source column: skip its name and
    //    instead fetch the physical inputs of its row-level expression (its
    //    scalar measure's columns are already covered by the measure walk in
    //    step 1, since the planner passes those measures here).
    for col_ref in &request.group_by {
        if let Some(cc) = model
            .context_column(&col_ref.column)
            .filter(|cc| cc.table().eq_ignore_ascii_case(&col_ref.table))
        {
            // Inline any references to other context columns first so the
            // transitive physical inputs are fetched (and the non-physical
            // referenced-column names are not). A cycle is caught at plan time
            // before projection; fall back to the raw expression defensively.
            let expr = model
                .inline_context_column_refs(
                    cc.table(),
                    cc.expression(),
                    &mut vec![cc.name().to_lowercase()],
                )
                .unwrap_or_else(|_| cc.expression().clone());
            for c in expr.column_references() {
                collector.add(cc.table(), c);
            }
            for (t, c) in expr.qualified_column_references() {
                collector.add(t, c);
            }
            continue;
        }
        collector.add(&col_ref.table, &col_ref.column);
        if let Ok(table) = model.table(&col_ref.table) {
            if let Ok(sort_col) = table.sort_column_for(&col_ref.column) {
                if sort_col != col_ref.column {
                    let sort_col = sort_col.to_string();
                    collector.add(&col_ref.table, &sort_col);
                }
            }
        }
    }

    // 3. Query filter columns (mirrors the per-table filter heuristic used
    //    when building fetches).
    for filter in &request.filters {
        for table_name in fetch_tables {
            let has_column = model
                .table(table_name)
                .ok()
                .and_then(|t| t.column(&filter.column).ok())
                .is_some();
            if has_column {
                collector.add(table_name, &filter.column);
            }
        }
    }

    // 4. Relationship join keys between fetched tables.
    {
        let fetched_lower: std::collections::HashSet<String> =
            fetch_tables.iter().map(|t| t.to_lowercase()).collect();
        for rel in model.relationships() {
            if fetched_lower.contains(&rel.from_table().to_lowercase())
                && fetched_lower.contains(&rel.to_table().to_lowercase())
            {
                collector.add_relationship_conditions(rel);
            }
        }
    }

    // 5. Calculated-column inputs.
    for table_name in fetch_tables {
        collector.add_calculated_inputs(table_name);
    }

    // 6. Lookup key, value, and resolution columns.
    for spec in lookup_specs {
        collector.add(&spec.table, &spec.key_column);
        collector.add(&spec.table, &spec.column);
        collector.add_lookup_resolution_columns(spec);
    }

    collector.finish()
}

#[cfg(test)]
mod tests {
    use super::super::test_util::*;
    use super::super::PushdownPlanner;
    use super::*;
    use crate::registry::{SourceBinding, SourceRegistry};
    use crate::request::ColumnRef;
    use engine_connectors::{FilterCondition, FilterOperator};
    use engine_core::compute::aggregate::AggregateOp;
    use engine_core::compute::expression::{
        self as expr, ComparisonOp, Expression, FilterPredicate,
    };
    use engine_core::compute::measure::{expression_measure, sum_measure};
    use engine_core::model::{Column, Relationship, Table};
    use engine_core::types::DataType;

    #[test]
    fn local_aggregation_projects_measure_and_join_key_columns() {
        let model = test_model_star_schema();
        let registry = make_cross_source_registry();

        let request = QueryRequest {
            measures: vec!["TotalAmount".into()],
            group_by: vec![ColumnRef::new("Products", "category")],
            filters: vec![],
            lookups: vec![],
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();

        // Sales: measure column + fact-side join key. The unused "id" column
        // must NOT be fetched.
        assert_eq!(
            fetch_for(&plan, "Sales").columns,
            vec!["amount".to_string(), "product_id".to_string()]
        );
        // Products: group-by column + dimension-side join key.
        assert_eq!(
            fetch_for(&plan, "Products").columns,
            vec!["category".to_string(), "id".to_string()]
        );
    }

    #[test]
    fn projection_includes_keep_filter_columns() {
        // KEEP filter on a context-only dimension (Dates): its filter column
        // and join key must be fetched; the unused "month" column must not.
        let sales = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("product_id", DataType::Int64),
                Column::new("date_id", DataType::Int64),
                Column::new("amount", DataType::Float64),
            ],
        )
        .unwrap();
        let products = Table::new(
            "Products",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("category", DataType::String),
            ],
        )
        .unwrap();
        let dates = Table::new(
            "Dates",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("year", DataType::Int32),
                Column::new("month", DataType::Int32),
            ],
        )
        .unwrap();

        let model = DataModel::builder()
            .add_table(sales)
            .add_table(products)
            .add_table(dates)
            .add_relationship(Relationship::many_to_one(
                "Sales_Products",
                "Sales",
                "product_id",
                "Products",
                "id",
            ))
            .add_relationship(Relationship::many_to_one(
                "Sales_Dates",
                "Sales",
                "date_id",
                "Dates",
                "id",
            ))
            .add_measure(expression_measure(
                "Revenue2014",
                expr::agg(
                    AggregateOp::Sum,
                    expr::keep(
                        expr::qualified_col("Sales", "amount"),
                        vec![FilterPredicate::new(
                            "Dates",
                            "year",
                            ComparisonOp::Equal,
                            "2014",
                        )],
                    ),
                ),
            ))
            .build()
            .unwrap();

        // Dates on a different connector forces local aggregation.
        let mut registry = SourceRegistry::new();
        registry.bind("Sales", 0, SourceBinding::new("dbo", "sales"));
        registry.bind("Products", 0, SourceBinding::new("dbo", "products"));
        registry.bind("Dates", 1, SourceBinding::new("dbo", "dates"));

        let request = QueryRequest {
            measures: vec!["Revenue2014".into()],
            group_by: vec![ColumnRef::new("Products", "category")],
            filters: vec![],
            lookups: vec![],
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();

        assert_eq!(
            fetch_for(&plan, "Dates").columns,
            vec!["id".to_string(), "year".to_string()]
        );
        assert_eq!(
            fetch_for(&plan, "Sales").columns,
            vec![
                "amount".to_string(),
                "date_id".to_string(),
                "product_id".to_string()
            ]
        );
        assert_eq!(
            fetch_for(&plan, "Products").columns,
            vec!["category".to_string(), "id".to_string()]
        );
    }

    #[test]
    fn projection_includes_query_binding_columns_for_countrows_result() {
        // Regression: QUERY-in-VAR bindings feed the two-stage
        // materialization SQL, so their aggregate and group-by columns must
        // be fetched even when the RETURN expression only references the
        // intermediate table (COUNTROWS(monthly) — a bare TableRef that
        // collects nothing itself).
        let sales = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("date_id", DataType::Int64),
                Column::new("amount", DataType::Float64),
            ],
        )
        .unwrap();
        let dates = Table::new(
            "Dates",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("year", DataType::Int32),
                Column::new("month", DataType::Int32),
                Column::new("day", DataType::Int32),
            ],
        )
        .unwrap();

        let month_count = engine_core::compute::parser::parse_measure_expression(
            "VAR monthly = QUERY(SUM(Sales[amount]) AS revenue BY Dates[year], Dates[month]) \
             RETURN COUNTROWS(monthly)",
        )
        .unwrap();

        let model = DataModel::builder()
            .add_table(sales)
            .add_table(dates)
            .add_relationship(Relationship::many_to_one(
                "Sales_Dates",
                "Sales",
                "date_id",
                "Dates",
                "id",
            ))
            .add_measure(expression_measure("MonthCount", month_count))
            .build()
            .unwrap();

        let mut registry = SourceRegistry::new();
        registry.bind("Sales", 0, SourceBinding::new("dbo", "sales"));
        registry.bind("Dates", 0, SourceBinding::new("dbo", "dates"));

        let request = QueryRequest {
            measures: vec!["MonthCount".into()],
            group_by: vec![],
            filters: vec![],
            lookups: vec![],
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();

        // The QUERY's aggregate column and join key must be fetched on Sales;
        // its group-by columns (plus join key) on Dates. The unused "day"
        // column must not be fetched.
        assert_eq!(
            fetch_for(&plan, "Sales").columns,
            vec!["amount".to_string(), "date_id".to_string()]
        );
        assert_eq!(
            fetch_for(&plan, "Dates").columns,
            vec!["id".to_string(), "month".to_string(), "year".to_string()]
        );
    }

    #[test]
    fn projection_includes_calculated_column_inputs_not_calc_name() {
        use engine_core::model::CalculatedColumn;

        let sales = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("product_id", DataType::Int64),
                Column::new("price", DataType::Float64),
                Column::new("quantity", DataType::Float64),
            ],
        )
        .unwrap();
        let products = Table::new(
            "Products",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("category", DataType::String),
            ],
        )
        .unwrap();

        let model = DataModel::builder()
            .add_table(sales)
            .add_table(products)
            .add_relationship(Relationship::many_to_one(
                "Sales_Products",
                "Sales",
                "product_id",
                "Products",
                "id",
            ))
            .add_calculated_column(CalculatedColumn::new(
                "line_total",
                "Sales",
                expr::col("price").multiply(expr::col("quantity")),
                DataType::Float64,
            ))
            .add_measure(sum_measure("TotalRevenue", "Sales", "line_total"))
            .build()
            .unwrap();

        let registry = make_cross_source_registry();
        let request = QueryRequest {
            measures: vec!["TotalRevenue".into()],
            group_by: vec![ColumnRef::new("Products", "category")],
            filters: vec![],
            lookups: vec![],
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();

        // The calculated column's physical inputs are fetched; the calculated
        // column itself does not exist at the source and must not be requested.
        let sales_columns = &fetch_for(&plan, "Sales").columns;
        assert_eq!(
            sales_columns,
            &vec![
                "price".to_string(),
                "product_id".to_string(),
                "quantity".to_string()
            ]
        );
        assert!(!sales_columns.contains(&"line_total".to_string()));
    }

    #[test]
    fn projection_includes_lookup_key_value_and_resolution_columns() {
        use crate::request::LookupColumn;

        let products = Table::new(
            "Products",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("category_id", DataType::Int32),
                Column::new("category_name", DataType::String)
                    .with_lookup_resolution("FIRST(category_name, ORDER BY sort_order)"),
                Column::new("sort_order", DataType::Int32),
                Column::new("unused", DataType::String),
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

        // Lookups force local aggregation even on a single source.
        let mut registry = SourceRegistry::new();
        registry.bind("Sales", 0, SourceBinding::new("dbo", "sales"));
        registry.bind("Products", 0, SourceBinding::new("dbo", "products"));

        let request = QueryRequest {
            measures: vec!["Revenue".into()],
            group_by: vec![ColumnRef::new("Products", "category_id")],
            filters: vec![],
            lookups: vec![LookupColumn::new("Products", "category_name")],
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();

        // Key (group-by inferred), value, resolution reference (sort_order),
        // and join key — but not "unused".
        assert_eq!(
            fetch_for(&plan, "Products").columns,
            vec![
                "category_id".to_string(),
                "category_name".to_string(),
                "id".to_string(),
                "sort_order".to_string()
            ]
        );
        assert_eq!(
            fetch_for(&plan, "Sales").columns,
            vec!["amount".to_string(), "product_id".to_string()]
        );
    }

    #[test]
    fn projection_includes_group_by_sort_column() {
        let sales = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("product_id", DataType::Int64),
                Column::new("amount", DataType::Float64),
            ],
        )
        .unwrap();
        let products = Table::new(
            "Products",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("category", DataType::String).with_sort_by("category_sort"),
                Column::new("category_sort", DataType::Int32),
            ],
        )
        .unwrap();

        let model = DataModel::builder()
            .add_table(sales)
            .add_table(products)
            .add_relationship(Relationship::many_to_one(
                "Sales_Products",
                "Sales",
                "product_id",
                "Products",
                "id",
            ))
            .add_measure(sum_measure("TotalAmount", "Sales", "amount"))
            .build()
            .unwrap();

        let registry = make_cross_source_registry();
        let request = QueryRequest {
            measures: vec!["TotalAmount".into()],
            group_by: vec![ColumnRef::new("Products", "category")],
            filters: vec![],
            lookups: vec![],
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();

        assert_eq!(
            fetch_for(&plan, "Products").columns,
            vec![
                "category".to_string(),
                "category_sort".to_string(),
                "id".to_string()
            ]
        );
    }

    #[test]
    fn projection_includes_query_filter_columns() {
        let model = test_model_star_schema();
        let registry = make_cross_source_registry();

        let request = QueryRequest {
            measures: vec!["TotalAmount".into()],
            group_by: vec![ColumnRef::new("Products", "category")],
            filters: vec![FilterCondition::new("id", FilterOperator::Equal, "42")],
            lookups: vec![],
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();

        // "id" exists in both tables; the filter heuristic applies it to both,
        // so both projections include it.
        assert_eq!(
            fetch_for(&plan, "Sales").columns,
            vec![
                "amount".to_string(),
                "id".to_string(),
                "product_id".to_string()
            ]
        );
        assert_eq!(
            fetch_for(&plan, "Products").columns,
            vec!["category".to_string(), "id".to_string()]
        );
    }

    #[test]
    fn unanalyzable_reference_falls_back_to_full_fetch() {
        // `DataModelBuilder::build()` rejects measures referencing unknown
        // columns, so an unattributable reference cannot enter a validated
        // model. Exercise the safety valve directly with a hand-built
        // measure (e.g. a model that bypassed validation).
        let model = test_model_star_schema();

        let weird = expression_measure(
            "Weird",
            expr::agg(
                AggregateOp::Sum,
                expr::qualified_col("Sales", "amount")
                    .multiply(Expression::ColumnRef("mystery_col".into())),
            ),
        );

        let request = QueryRequest {
            measures: vec!["Weird".into()],
            group_by: vec![ColumnRef::new("Products", "category")],
            filters: vec![],
            lookups: vec![],
            ..Default::default()
        };

        let fetch_tables = vec!["Sales".to_string(), "Products".to_string()];
        let projections = compute_table_projections(
            &request,
            &model,
            &[weird],
            &fetch_tables,
            &[],
            &std::collections::HashSet::new(),
        );

        // "mystery_col" cannot be attributed to any fetched table → projection
        // is disabled entirely; both fetches fall back to SELECT *.
        assert!(projections.columns_for("Sales").is_empty());
        assert!(projections.columns_for("Products").is_empty());

        let diagnostics = projections.into_diagnostics();
        assert_eq!(diagnostics.fallbacks.len(), 1);
        assert_eq!(diagnostics.fallbacks[0].0, "*");
        assert!(
            diagnostics.fallbacks[0].1.contains("mystery_col"),
            "got: {}",
            diagnostics.fallbacks[0].1
        );
    }

    #[test]
    fn context_column_forces_local_and_projects_physical_inputs() {
        use engine_core::compute::measure::expression_measure;
        use engine_core::model::ContextColumn;

        let invoice = Table::new(
            "Invoice",
            vec![
                Column::new("paid_date", DataType::Date),
                Column::new("amount", DataType::Float64),
            ],
        )
        .unwrap();
        // Disconnected as-of reference table (no relationship to Invoice).
        let calendar = Table::new(
            "Calendar",
            vec![
                Column::new("date", DataType::Date),
                Column::new("period", DataType::Int32),
            ],
        )
        .unwrap();

        let payment_status = expr::if_expr(
            expr::compare(
                expr::qualified_col("Invoice", "paid_date"),
                ComparisonOp::LessThanOrEqual,
                Expression::MeasureRef("AsOfDate".into()),
            ),
            expr::lit_str("Paid"),
            expr::lit_str("Open"),
        );

        let model = DataModel::builder()
            .add_table(invoice)
            .add_table(calendar)
            .add_measure(sum_measure("Revenue", "Invoice", "amount"))
            .add_measure(expression_measure(
                "AsOfDate",
                expr::agg(AggregateOp::Max, expr::qualified_col("Calendar", "date")),
            ))
            .add_context_column(ContextColumn::new(
                "PaymentStatus",
                "Invoice",
                payment_status,
                DataType::String,
            ))
            .build()
            .unwrap();

        let mut registry = SourceRegistry::new();
        registry.bind("Invoice", 0, SourceBinding::new("dbo", "invoice"));
        registry.bind("Calendar", 0, SourceBinding::new("dbo", "calendar"));

        let request = QueryRequest {
            measures: vec!["Revenue".into()],
            group_by: vec![ColumnRef::new("Invoice", "PaymentStatus")],
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();

        // A context column on the axis forces LocalAggregation.
        let fetches = match &plan {
            crate::planner::QueryPlan::LocalAggregation { fetches, .. } => fetches,
            other => panic!("expected LocalAggregation, got {other:?}"),
        };

        // Invoice fetches the context column's physical input + the measure
        // column — NOT the non-physical "PaymentStatus".
        assert_eq!(
            fetch_for(&plan, "Invoice").columns,
            vec!["amount".to_string(), "paid_date".to_string()]
        );
        assert!(!fetch_for(&plan, "Invoice")
            .columns
            .contains(&"PaymentStatus".to_string()));

        // The scalar measure's source table is fetched with its scalar column.
        assert!(
            fetches.iter().any(|(t, _)| t == "Calendar"),
            "Calendar (scalar source) must be fetched"
        );
        assert_eq!(
            fetch_for(&plan, "Calendar").columns,
            vec!["date".to_string()]
        );
    }

    #[test]
    fn in_memory_table_is_not_projected() {
        use engine_core::model::StorageMode;

        let sales = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("product_id", DataType::Int64),
                Column::new("amount", DataType::Float64),
            ],
        )
        .unwrap();
        let products = Table::new(
            "Products",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("category", DataType::String),
            ],
        )
        .unwrap()
        .with_storage_mode(StorageMode::InMemory);

        let model = DataModel::builder()
            .add_table(sales)
            .add_table(products)
            .add_relationship(Relationship::many_to_one(
                "Sales_Products",
                "Sales",
                "product_id",
                "Products",
                "id",
            ))
            .add_measure(sum_measure("TotalAmount", "Sales", "amount"))
            .build()
            .unwrap();

        let registry = mock_registry_star(0);
        let request = QueryRequest {
            measures: vec!["TotalAmount".into()],
            group_by: vec![ColumnRef::new("Products", "category")],
            filters: vec![],
            lookups: vec![],
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();

        // The in-memory table is served from cache — no projection.
        assert!(fetch_for(&plan, "Products").columns.is_empty());
        // The connector-fetched fact table is still projected.
        assert_eq!(
            fetch_for(&plan, "Sales").columns,
            vec!["amount".to_string(), "product_id".to_string()]
        );
    }

    #[test]
    fn plan_explained_reports_projected_columns_and_fallbacks() {
        // Projected case.
        let model = test_model_star_schema();
        let registry = make_cross_source_registry();
        let request = QueryRequest {
            measures: vec!["TotalAmount".into()],
            group_by: vec![ColumnRef::new("Products", "category")],
            filters: vec![],
            lookups: vec![],
            ..Default::default()
        };

        let (_plan, node) =
            PushdownPlanner::plan_explained(&request, &model, &registry, &[]).unwrap();
        let projected = node
            .properties
            .iter()
            .find(|p| p.key == "projected_columns")
            .expect("projected_columns property");
        match &projected.value {
            engine_core::compute::plan::PlanValue::List(entries) => {
                assert!(
                    entries.iter().any(|e| e == "Sales: 2 column(s)"),
                    "got: {entries:?}"
                );
                assert!(
                    entries.iter().any(|e| e == "Products: 2 column(s)"),
                    "got: {entries:?}"
                );
            }
            other => panic!("Expected List, got {other:?}"),
        }

        // Fallback case: an in-memory table is served from cache, so it is
        // fetched without projection and the reason is reported.
        let fallback_model = {
            use engine_core::model::StorageMode;
            let sales = model.table("Sales").unwrap().clone();
            let products = model
                .table("Products")
                .unwrap()
                .clone()
                .with_storage_mode(StorageMode::InMemory);
            DataModel::builder()
                .add_table(sales)
                .add_table(products)
                .add_relationship(Relationship::many_to_one(
                    "Sales_Products",
                    "Sales",
                    "product_id",
                    "Products",
                    "id",
                ))
                .add_measure(sum_measure("TotalAmount", "Sales", "amount"))
                .build()
                .unwrap()
        };
        let request = QueryRequest {
            measures: vec!["TotalAmount".into()],
            group_by: vec![ColumnRef::new("Products", "category")],
            filters: vec![],
            lookups: vec![],
            ..Default::default()
        };

        let (_plan, node) =
            PushdownPlanner::plan_explained(&request, &fallback_model, &registry, &[]).unwrap();
        let fallbacks = node
            .properties
            .iter()
            .find(|p| p.key == "projection_fallbacks")
            .expect("projection_fallbacks property");
        match &fallbacks.value {
            engine_core::compute::plan::PlanValue::List(entries) => {
                assert!(
                    entries
                        .iter()
                        .any(|e| e.starts_with("Products: ") && e.contains("in-memory cache")),
                    "got: {entries:?}"
                );
            }
            other => panic!("Expected List, got {other:?}"),
        }
    }
}
