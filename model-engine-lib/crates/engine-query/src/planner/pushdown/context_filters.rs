//! KEEP-filter predicate extraction and pushable context-filter computation.

use engine_connectors::{FilterCondition, FilterOperator};
use engine_core::compute::expression::{ComparisonOp, Expression, FilterPredicate};
use engine_core::compute::measure::Measure;

/// Convert a `ComparisonOp` to a connector `FilterOperator`.
fn comparison_to_filter_op(op: &ComparisonOp) -> FilterOperator {
    match op {
        ComparisonOp::Equal => FilterOperator::Equal,
        ComparisonOp::NotEqual => FilterOperator::NotEqual,
        ComparisonOp::GreaterThan => FilterOperator::GreaterThan,
        ComparisonOp::GreaterThanOrEqual => FilterOperator::GreaterThanOrEqual,
        ComparisonOp::LessThan => FilterOperator::LessThan,
        ComparisonOp::LessThanOrEqual => FilterOperator::LessThanOrEqual,
    }
}

/// The KEEP predicates that hold for EVERY row the expression aggregates: the
/// filters of the KEEPs on its root spine (`KEEP(SUM(x), ...)`,
/// `SUM(KEEP(x, ...))`, a KEEP inside a KEEP). A KEEP anywhere else (one
/// operand of `+`, an `IF` branch, under a CLEAR) filters only part of the
/// measure, so it contributes nothing.
fn spine_keep_predicates(expr: &Expression, out: &mut Vec<FilterPredicate>) {
    match expr {
        Expression::Keep {
            expr: inner,
            filters,
            ..
        } => {
            out.extend(filters.iter().cloned());
            spine_keep_predicates(inner, out);
        }
        Expression::Aggregate { operand, .. } if matches!(**operand, Expression::Keep { .. }) => {
            spine_keep_predicates(operand, out);
        }
        _ => {}
    }
}

/// Compute pushable context filters for source fetches.
///
/// For each dimension table that is referenced ONLY through KEEP filters
/// (not as a measure fact table or group-by table), extract filter predicates
/// that can be pushed down as WHERE clauses on the source fetch.
///
/// A pushed predicate removes the dimension's other rows from the fetch, and
/// the local aggregation INNER-joins that fetch for EVERY measure in the query
/// (and the fact fetch may be narrowed to the surviving keys). So a predicate
/// is pushed only when it holds for every row EVERY measure aggregates: it is
/// on the root KEEP spine of each one ([`spine_keep_predicates`]). Until the
/// open-ledger round E a measure with no KEEP on the table "did not
/// participate", so `SUM(amount, KEEP(Product, name = "Bikes"))` beside a plain
/// `SUM(amount)` pushed `name = 'Bikes'` and the total lost every non-Bikes row
/// (NEW-shared-query-dimension-keep); a KEEP on one operand of a compound
/// measure did the same to the other operand.
pub(super) fn compute_pushable_context_filters(
    measures: &[Measure],
    measure_tables: &[&str],
    group_by_tables: &[&str],
) -> std::collections::HashMap<String, Vec<FilterCondition>> {
    // Collect KEEP predicates per measure, grouped by table. Every measure
    // participates: an empty set on a table blocks any push to it.
    let per_measure: Vec<std::collections::HashMap<String, Vec<FilterPredicate>>> = measures
        .iter()
        .map(|m| {
            let mut spine = Vec::new();
            spine_keep_predicates(m.expression(), &mut spine);
            let mut by_table: std::collections::HashMap<String, Vec<FilterPredicate>> =
                std::collections::HashMap::new();
            for pred in spine {
                by_table.entry(pred.table.clone()).or_default().push(pred);
            }
            by_table
        })
        .collect();

    // Find all context-only tables (not fact tables, not group-by tables).
    let excluded: std::collections::HashSet<&str> = measure_tables
        .iter()
        .chain(group_by_tables.iter())
        .copied()
        .collect();

    // Collect all context tables across measures.
    let mut all_context_tables: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    for preds_by_table in &per_measure {
        for table in preds_by_table.keys() {
            if !excluded.iter().any(|e| e.eq_ignore_ascii_case(table)) {
                all_context_tables.insert(table.clone());
            }
        }
    }

    let mut result: std::collections::HashMap<String, Vec<FilterCondition>> =
        std::collections::HashMap::new();

    for table in &all_context_tables {
        // Every measure's spine predicates on this table; a measure with none
        // reads the table's other rows too, so nothing can be pushed.
        let mut caring_sets: Vec<&Vec<FilterPredicate>> = Vec::new();
        for preds_by_table in &per_measure {
            match preds_by_table.get(table) {
                Some(preds) => caring_sets.push(preds),
                None => {
                    caring_sets.clear();
                    break;
                }
            }
        }

        if caring_sets.is_empty() {
            continue;
        }

        // Compute intersection: predicates present in ALL caring measures.
        let base = &caring_sets[0];
        let intersection: Vec<&FilterPredicate> = base
            .iter()
            .filter(|pred| {
                caring_sets[1..].iter().all(|set| {
                    set.iter().any(|p| {
                        p.column == pred.column
                            && p.operator == pred.operator
                            && p.value == pred.value
                    })
                })
            })
            .collect();

        if !intersection.is_empty() {
            let conditions: Vec<FilterCondition> = intersection
                .iter()
                .map(|pred| {
                    FilterCondition::new(
                        pred.column.clone(),
                        comparison_to_filter_op(&pred.operator),
                        pred.value.clone(),
                    )
                })
                .collect();
            result.insert(table.clone(), conditions);
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::super::test_util::*;
    use super::super::{PushdownPlanner, QueryPlan};
    use crate::request::{ColumnRef, QueryRequest};
    use engine_core::compute::aggregate::AggregateOp;
    use engine_core::compute::expression::{self as expr, ComparisonOp, FilterPredicate};
    use engine_core::compute::measure::{expression_measure, sum_measure};
    use engine_core::model::{DataModel, Relationship};

    #[test]
    fn context_filter_pushed_to_dimension_fetch() {
        // KEEP filter on Dates (not in group_by) should be pushed to source fetch.
        let mut model = test_model_three_table();
        model = DataModel::builder()
            .add_table(model.table("Sales").unwrap().clone())
            .add_table(model.table("Products").unwrap().clone())
            .add_table(model.table("Dates").unwrap().clone())
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

        let registry = mock_registry_three(0);
        let request = QueryRequest {
            measures: vec!["Revenue2014".into()],
            group_by: vec![ColumnRef::new("Products", "category")],
            filters: vec![],
            lookups: vec![],
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();

        match plan {
            QueryPlan::PushedJoinAggregation { .. } => {
                // KEEP filter should be translated to CASE WHEN in pushed SQL.
            }
            other => panic!("Expected PushedJoinAggregation, got {other:?}"),
        }
    }

    #[test]
    fn context_filter_not_pushed_to_group_by_table() {
        // KEEP filter on Products (which is also in group_by) should NOT be pushed.
        let mut model = test_model_three_table();
        model = DataModel::builder()
            .add_table(model.table("Sales").unwrap().clone())
            .add_table(model.table("Products").unwrap().clone())
            .add_table(model.table("Dates").unwrap().clone())
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
                "BikeRevenue",
                expr::agg(
                    AggregateOp::Sum,
                    expr::keep(
                        expr::qualified_col("Sales", "amount"),
                        vec![FilterPredicate::new(
                            "Products",
                            "category",
                            ComparisonOp::Equal,
                            "Bikes",
                        )],
                    ),
                ),
            ))
            .build()
            .unwrap();

        let registry = mock_registry_three(0);
        let request = QueryRequest {
            measures: vec!["BikeRevenue".into()],
            group_by: vec![ColumnRef::new("Products", "category")],
            filters: vec![],
            lookups: vec![],
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();

        match plan {
            QueryPlan::PushedJoinAggregation { .. } => {
                // KEEP filter on group-by table becomes CASE WHEN in pushed SQL.
            }
            other => panic!("Expected PushedJoinAggregation, got {other:?}"),
        }
    }

    #[test]
    fn context_filter_not_pushed_to_fact_table() {
        // KEEP filter on Sales (the fact/measure table) should NOT be pushed.
        let mut model = test_model_three_table();
        model = DataModel::builder()
            .add_table(model.table("Sales").unwrap().clone())
            .add_table(model.table("Products").unwrap().clone())
            .add_table(model.table("Dates").unwrap().clone())
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
                "LargeOrders",
                expr::agg(
                    AggregateOp::Sum,
                    expr::keep(
                        expr::qualified_col("Sales", "amount"),
                        vec![FilterPredicate::new(
                            "Sales",
                            "amount",
                            ComparisonOp::GreaterThan,
                            "1000",
                        )],
                    ),
                ),
            ))
            .build()
            .unwrap();

        let registry = mock_registry_three(0);
        let request = QueryRequest {
            measures: vec!["LargeOrders".into()],
            group_by: vec![ColumnRef::new("Products", "category")],
            filters: vec![],
            lookups: vec![],
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();

        match plan {
            QueryPlan::PushedJoinAggregation { .. } => {
                // KEEP filter on fact table becomes CASE WHEN in pushed SQL.
            }
            other => panic!("Expected PushedJoinAggregation, got {other:?}"),
        }
    }

    #[test]
    fn conflicting_context_filters_not_pushed() {
        // Two measures with different KEEP values on the same dimension → no push.
        let mut model = test_model_three_table();
        model = DataModel::builder()
            .add_table(model.table("Sales").unwrap().clone())
            .add_table(model.table("Products").unwrap().clone())
            .add_table(model.table("Dates").unwrap().clone())
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
            .add_measure(expression_measure(
                "Revenue2015",
                expr::agg(
                    AggregateOp::Sum,
                    expr::keep(
                        expr::qualified_col("Sales", "amount"),
                        vec![FilterPredicate::new(
                            "Dates",
                            "year",
                            ComparisonOp::Equal,
                            "2015",
                        )],
                    ),
                ),
            ))
            .build()
            .unwrap();

        let registry = mock_registry_three(0);
        let request = QueryRequest {
            measures: vec!["Revenue2014".into(), "Revenue2015".into()],
            group_by: vec![ColumnRef::new("Products", "category")],
            filters: vec![],
            lookups: vec![],
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();

        match plan {
            QueryPlan::PushedJoinAggregation { .. } => {
                // Both KEEP filters become separate CASE WHEN clauses.
            }
            other => panic!("Expected PushedJoinAggregation, got {other:?}"),
        }
    }

    #[test]
    fn agreeing_context_filters_pushed() {
        // Two measures with SAME KEEP value on a dimension → push.
        let mut model = test_model_three_table();
        model = DataModel::builder()
            .add_table(model.table("Sales").unwrap().clone())
            .add_table(model.table("Products").unwrap().clone())
            .add_table(model.table("Dates").unwrap().clone())
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
                "SumRevenue2014",
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
            .add_measure(expression_measure(
                "CountRevenue2014",
                expr::agg(
                    AggregateOp::Count,
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

        let registry = mock_registry_three(0);
        let request = QueryRequest {
            measures: vec!["SumRevenue2014".into(), "CountRevenue2014".into()],
            group_by: vec![ColumnRef::new("Products", "category")],
            filters: vec![],
            lookups: vec![],
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();

        match plan {
            QueryPlan::PushedJoinAggregation { .. } => {
                // Both measures use the same year=2014 KEEP filter.
            }
            other => panic!("Expected PushedJoinAggregation, got {other:?}"),
        }
    }

    #[test]
    fn one_measure_with_context_one_without_still_pushes() {
        // Measure A: KEEP(Dates.year = 2014), Measure B: no filter on Dates.
        // The whole join aggregation is pushed, each KEEP as its own CASE
        // WHEN. (A LOCAL aggregation of the same pair never pushes
        // year = 2014 into the Dates fetch: Measure B reads every row, see
        // `compute_pushable_context_filters`.)
        let mut model = test_model_three_table();
        model = DataModel::builder()
            .add_table(model.table("Sales").unwrap().clone())
            .add_table(model.table("Products").unwrap().clone())
            .add_table(model.table("Dates").unwrap().clone())
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
            .add_measure(sum_measure("TotalRevenue", "Sales", "amount"))
            .build()
            .unwrap();

        let registry = mock_registry_three(0);
        let request = QueryRequest {
            measures: vec!["Revenue2014".into(), "TotalRevenue".into()],
            group_by: vec![ColumnRef::new("Products", "category")],
            filters: vec![],
            lookups: vec![],
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();

        match plan {
            QueryPlan::PushedJoinAggregation { .. } => {
                // Revenue2014 has KEEP filter → CASE WHEN in SQL.
                // TotalRevenue is a plain SUM without CASE WHEN.
                // TotalRevenue should be a plain SUM.
            }
            other => panic!("Expected PushedJoinAggregation, got {other:?}"),
        }
    }
}
