//! Instrumented query planning with execution plan metadata.
//!
//! Provides [`PushdownPlanner::plan_explained`], which wraps the standard
//! planning logic and produces a [`PlanNode`] describing the pushdown
//! decision and its reasoning.

use std::time::Instant;

use engine_core::compute::plan::{PlanNode, PlanOperation, PlanValue};
use engine_core::model::DataModel;

use crate::error::QueryResult;
use crate::planner::pushdown::QueryPlan;
use crate::planner::PushdownPlanner;
use crate::registry::SourceRegistry;
use crate::request::QueryRequest;

impl PushdownPlanner {
    /// Plan a query and produce an execution plan node describing the decision.
    ///
    /// This wraps [`PushdownPlanner::plan`] with timing and metadata collection.
    /// The returned [`PlanNode`] describes which pushdown strategy was chosen
    /// and why.
    pub fn plan_explained(
        request: &QueryRequest,
        model: &DataModel,
        registry: &SourceRegistry,
    ) -> QueryResult<(QueryPlan, PlanNode)> {
        let start = Instant::now();
        let plan = Self::plan(request, model, registry)?;
        let elapsed = start.elapsed();

        // Reconstruct decision reasoning from the plan and request.
        let mut node = PlanNode::new(PlanOperation::PushdownDecision, "Pushdown Analysis")
            .with_duration(elapsed);

        // Collect measure info.
        let measure_names: Vec<String> = request.measures.clone();
        node.add_property("measures", PlanValue::List(measure_names));

        match &plan {
            QueryPlan::PushedAggregation {
                source_table,
                request: fetch,
            } => {
                node.add_property("decision", PlanValue::Text("PushedAggregation".into()));
                node.add_property(
                    "reason",
                    PlanValue::Text(format!(
                        "Single table with simple aggregates: {source_table}"
                    )),
                );
                node.add_property(
                    "tables_involved",
                    PlanValue::List(vec![source_table.clone()]),
                );
                node.add_property("all_simple", PlanValue::Bool(true));
                node.add_property("has_context_ops", PlanValue::Bool(false));

                if let Some(schema) = &fetch.schema {
                    node.add_property("source_schema", PlanValue::Text(schema.clone()));
                }
                node.add_property("source_table", PlanValue::Text(fetch.table.clone()));
                node.add_property(
                    "aggregates_count",
                    PlanValue::Number(fetch.aggregates.len() as f64),
                );
                node.add_property(
                    "filters_pushed",
                    PlanValue::Number(fetch.filters.len() as f64),
                );
            }
            QueryPlan::LocalAggregation {
                fetches,
                measures,
                group_by,
                lookup_specs,
            } => {
                node.add_property("decision", PlanValue::Text("LocalAggregation".into()));

                // Determine the reason for local aggregation.
                let table_names: Vec<String> =
                    fetches.iter().map(|(name, _)| name.clone()).collect();
                let all_simple = measures.iter().all(|m| m.is_simple_aggregate());
                let any_context_ops = measures.iter().any(|m| m.expression().has_context_ops());

                let reason = if table_names.len() > 1 {
                    format!("Multiple tables: {}", table_names.join(", "))
                } else if any_context_ops {
                    "Measure has context operations (keep/clear/reset/etc.)".into()
                } else if !all_simple {
                    "Measure has complex expression (not a simple aggregate)".into()
                } else {
                    "Local aggregation required".into()
                };

                node.add_property("reason", PlanValue::Text(reason));
                node.add_property("tables_involved", PlanValue::List(table_names));
                node.add_property("all_simple", PlanValue::Bool(all_simple));
                node.add_property("has_context_ops", PlanValue::Bool(any_context_ops));
                node.add_property("fetches_planned", PlanValue::Number(fetches.len() as f64));

                // Report context filters pushed to source fetches.
                let context_pushed: Vec<String> = fetches
                    .iter()
                    .flat_map(|(name, req)| {
                        req.filters.iter().map(move |f| {
                            format!("{}.{} {} {}", name, f.column, f.operator.as_sql(), f.value)
                        })
                    })
                    .collect();
                if !context_pushed.is_empty() {
                    node.add_property("context_filters_pushed", PlanValue::List(context_pushed));
                }

                if !group_by.is_empty() {
                    let group_cols: Vec<String> = group_by
                        .iter()
                        .map(|c| format!("{}.{}", c.table, c.column))
                        .collect();
                    node.add_property("group_by", PlanValue::List(group_cols));
                }

                if !lookup_specs.is_empty() {
                    let lookup_desc: Vec<String> = lookup_specs
                        .iter()
                        .map(|s| {
                            format!(
                                "{}.{} (key: {}.{}, resolution: {})",
                                s.table, s.column, s.table, s.key_column, s.resolution_sql
                            )
                        })
                        .collect();
                    node.add_property("lookup_specs", PlanValue::List(lookup_desc));
                }
            }
        }

        Ok((plan, node))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::SourceBinding;
    use crate::request::ColumnRef;
    use engine_core::compute::aggregate::AggregateOp;
    use engine_core::compute::expression::{self as expr, ComparisonOp, FilterPredicate};
    use engine_core::compute::measure::{expression_measure, sum_measure};
    use engine_core::model::{Column, Relationship, Table};
    use engine_core::types::DataType;

    fn single_table_model() -> DataModel {
        let sales = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("amount", DataType::Float64),
                Column::new("region", DataType::String),
            ],
        )
        .unwrap();

        DataModel::builder()
            .add_table(sales)
            .add_measure(sum_measure("TotalAmount", "Sales", "amount"))
            .build()
            .unwrap()
    }

    fn star_schema_model() -> DataModel {
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
        .unwrap();

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
    }

    fn mock_registry(tables: &[&str]) -> SourceRegistry {
        let mut registry = SourceRegistry::new();
        for table in tables {
            registry.bind(
                *table,
                0,
                SourceBinding::new("public", table.to_lowercase()),
            );
        }
        registry
    }

    #[test]
    fn explain_pushed_plan_has_correct_properties() {
        let model = single_table_model();
        let registry = mock_registry(&["Sales"]);
        let request = QueryRequest {
            measures: vec!["TotalAmount".into()],
            group_by: vec![],
            filters: vec![],
            lookups: vec![],
        };

        let (plan, node) = PushdownPlanner::plan_explained(&request, &model, &registry).unwrap();

        assert!(matches!(plan, QueryPlan::PushedAggregation { .. }));
        assert_eq!(node.operation, PlanOperation::PushdownDecision);

        let decision = node
            .properties
            .iter()
            .find(|p| p.key == "decision")
            .unwrap();
        assert_eq!(decision.value, PlanValue::Text("PushedAggregation".into()));

        let simple = node
            .properties
            .iter()
            .find(|p| p.key == "all_simple")
            .unwrap();
        assert_eq!(simple.value, PlanValue::Bool(true));

        assert!(node.duration.ms >= 0.0);
    }

    #[test]
    fn explain_local_plan_shows_reason() {
        let model = star_schema_model();
        let registry = mock_registry(&["Sales", "Products"]);
        let request = QueryRequest {
            measures: vec!["TotalAmount".into()],
            group_by: vec![ColumnRef::new("Products", "category")],
            filters: vec![],
            lookups: vec![],
        };

        let (plan, node) = PushdownPlanner::plan_explained(&request, &model, &registry).unwrap();

        assert!(matches!(plan, QueryPlan::LocalAggregation { .. }));

        let reason = node.properties.iter().find(|p| p.key == "reason").unwrap();
        match &reason.value {
            PlanValue::Text(s) => assert!(s.contains("Multiple tables")),
            other => panic!("Expected Text, got {other:?}"),
        }

        let tables = node
            .properties
            .iter()
            .find(|p| p.key == "tables_involved")
            .unwrap();
        match &tables.value {
            PlanValue::List(v) => assert_eq!(v.len(), 2),
            other => panic!("Expected List, got {other:?}"),
        }
    }

    #[test]
    fn explain_context_ops_in_reason() {
        let sales = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("amount", DataType::Float64),
                Column::new("region", DataType::String),
            ],
        )
        .unwrap();

        let model = DataModel::builder()
            .add_table(sales)
            .add_measure(expression_measure(
                "US_Revenue",
                "Sales",
                expr::agg(
                    AggregateOp::Sum,
                    expr::keep(
                        expr::col("amount"),
                        vec![FilterPredicate::new(
                            "Sales",
                            "region",
                            ComparisonOp::Equal,
                            "US",
                        )],
                    ),
                ),
            ))
            .build()
            .unwrap();

        let registry = mock_registry(&["Sales"]);
        let request = QueryRequest {
            measures: vec!["US_Revenue".into()],
            group_by: vec![],
            filters: vec![],
            lookups: vec![],
        };

        let (_plan, node) = PushdownPlanner::plan_explained(&request, &model, &registry).unwrap();

        let reason = node.properties.iter().find(|p| p.key == "reason").unwrap();
        match &reason.value {
            PlanValue::Text(s) => assert!(s.contains("context operations")),
            other => panic!("Expected Text, got {other:?}"),
        }

        let ctx_ops = node
            .properties
            .iter()
            .find(|p| p.key == "has_context_ops")
            .unwrap();
        assert_eq!(ctx_ops.value, PlanValue::Bool(true));
    }
}
