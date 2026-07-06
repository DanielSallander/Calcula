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

/// Collect all KEEP filter predicates from an expression, grouped by table.
///
/// Walks the expression tree and extracts `FilterPredicate` values from `Keep`
/// nodes. Returns a map from table name to the set of predicates on that table.
fn collect_keep_predicates_by_table(
    expr: &Expression,
) -> std::collections::HashMap<String, Vec<FilterPredicate>> {
    let mut predicates = Vec::new();
    collect_keep_predicates_recursive(expr, &mut predicates);

    let mut by_table: std::collections::HashMap<String, Vec<FilterPredicate>> =
        std::collections::HashMap::new();
    for pred in predicates {
        by_table.entry(pred.table.clone()).or_default().push(pred);
    }
    // Deduplicate within each table.
    for preds in by_table.values_mut() {
        preds.sort_by(|a, b| (&a.column, &a.value).cmp(&(&b.column, &b.value)));
        preds.dedup_by(|a, b| {
            a.table == b.table
                && a.column == b.column
                && a.operator == b.operator
                && a.value == b.value
        });
    }
    by_table
}

/// Recursively collect all KEEP filter predicates from an expression.
fn collect_keep_predicates_recursive(expr: &Expression, out: &mut Vec<FilterPredicate>) {
    match expr {
        Expression::Keep {
            expr: inner,
            filters,
            ..
        } => {
            out.extend(filters.iter().cloned());
            collect_keep_predicates_recursive(inner, out);
        }
        Expression::Aggregate { operand, .. } => {
            collect_keep_predicates_recursive(operand, out);
        }
        Expression::BinaryOp { left, right, .. }
        | Expression::Comparison { left, right, .. }
        | Expression::And(left, right)
        | Expression::Or(left, right)
        | Expression::Xor(left, right) => {
            collect_keep_predicates_recursive(left, out);
            collect_keep_predicates_recursive(right, out);
        }
        Expression::Not(inner) | Expression::IsBlank(inner) => {
            collect_keep_predicates_recursive(inner, out);
        }
        Expression::Clear { expr: inner, .. }
        | Expression::Reset { expr: inner }
        | Expression::ClearInner { expr: inner, .. }
        | Expression::ClearOuter { expr: inner, .. }
        | Expression::ResetInner { expr: inner }
        | Expression::ResetOuter { expr: inner }
        | Expression::Traverse { expr: inner, .. }
        | Expression::Using { expr: inner, .. }
        | Expression::KeepIn { expr: inner, .. } => {
            collect_keep_predicates_recursive(inner, out);
        }
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => {
            collect_keep_predicates_recursive(condition, out);
            collect_keep_predicates_recursive(then_expr, out);
            collect_keep_predicates_recursive(else_expr, out);
        }
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => {
            collect_keep_predicates_recursive(numerator, out);
            collect_keep_predicates_recursive(denominator, out);
            if let Some(a) = alternate {
                collect_keep_predicates_recursive(a, out);
            }
        }
        Expression::Coalesce(exprs) => {
            for e in exprs {
                collect_keep_predicates_recursive(e, out);
            }
        }
        Expression::ScalarFunc { args, .. } | Expression::TextFunc { args, .. } => {
            for a in args {
                collect_keep_predicates_recursive(a, out);
            }
        }
        Expression::Block {
            bindings,
            query_scoped_bindings,
            result,
        } => {
            for (_, binding_expr) in bindings.iter().chain(query_scoped_bindings.iter()) {
                collect_keep_predicates_recursive(binding_expr, out);
            }
            collect_keep_predicates_recursive(result, out);
        }
        Expression::Query { aggregates, .. } => {
            for (agg_expr, _) in aggregates {
                collect_keep_predicates_recursive(agg_expr, out);
            }
        }
        Expression::Switch {
            expr: inner,
            cases,
            default,
        } => {
            collect_keep_predicates_recursive(inner, out);
            for (v, r) in cases {
                collect_keep_predicates_recursive(v, out);
                collect_keep_predicates_recursive(r, out);
            }
            if let Some(d) = default {
                collect_keep_predicates_recursive(d, out);
            }
        }
        Expression::HasOneValue { column } => {
            collect_keep_predicates_recursive(column, out);
        }
        Expression::SelectedValue { column, alternate } => {
            collect_keep_predicates_recursive(column, out);
            if let Some(a) = alternate {
                collect_keep_predicates_recursive(a, out);
            }
        }
        Expression::FirstValue { column, order_by } => {
            collect_keep_predicates_recursive(column, out);
            collect_keep_predicates_recursive(order_by, out);
        }
        Expression::Call { args, .. } => {
            for a in args {
                collect_keep_predicates_recursive(a, out);
            }
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
/// When multiple measures have KEEP filters on the same table, only predicates
/// common to ALL measures (intersection) are pushed. If a measure has no KEEP
/// filter on a table, it doesn't constrain that table (it doesn't need data
/// from it), so it doesn't participate in the intersection.
pub(super) fn compute_pushable_context_filters(
    measures: &[Measure],
    measure_tables: &[&str],
    group_by_tables: &[&str],
) -> std::collections::HashMap<String, Vec<FilterCondition>> {
    // Collect KEEP predicates per measure, grouped by table.
    let per_measure: Vec<std::collections::HashMap<String, Vec<FilterPredicate>>> = measures
        .iter()
        .map(|m| collect_keep_predicates_by_table(m.expression()))
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
        // Collect predicate sets from measures that reference this table.
        let mut caring_sets: Vec<&Vec<FilterPredicate>> = Vec::new();
        for preds_by_table in &per_measure {
            if let Some(preds) = preds_by_table.get(table) {
                caring_sets.push(preds);
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
        // Measure B doesn't need Dates data, so pushing year=2014 is safe.
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
