//! ORDER BY / LIMIT and ROLLUP totals validation and pushed-ordering helpers.

use engine_core::compute::measure::Measure;
use engine_core::model::DataModel;

use crate::error::{QueryError, QueryResult};
use crate::request::{ColumnRef, OrderByClause, OrderTarget, QueryRequest, TotalsMode};

use super::collector::{lookup_model_table, resolve_physical_column};

/// Validate the request's [`TotalsMode`] constraints.
///
/// ROLLUP totals are rejected with lookup columns (the post-aggregation
/// lookup JOIN + re-GROUP-BY does not preserve subtotal levels) and with
/// more than 31 group-by columns (the `__grouping_id` bitmask is `Int32`).
/// Measure-shape restrictions (window measures, QUERY-in-VAR, multiple fact
/// tables, unsafe group-by relationships) are only detectable during
/// execution and are enforced by the executor.
pub(super) fn validate_totals(request: &QueryRequest) -> QueryResult<()> {
    if request.totals == TotalsMode::None {
        return Ok(());
    }
    if !request.lookups.is_empty() {
        return Err(QueryError::InvalidQuery(
            "totals (TotalsMode::Rollup) is not supported with lookup columns yet".into(),
        ));
    }
    if request.group_by.len() > 31 {
        return Err(QueryError::InvalidQuery(format!(
            "totals (TotalsMode::Rollup) supports at most 31 group_by columns \
             (the __grouping_id bitmask is Int32), got {}",
            request.group_by.len()
        )));
    }
    Ok(())
}

/// Validate the request's ORDER BY targets.
///
/// Each [`OrderTarget::Column`] must reference one of the `group_by` columns
/// and each [`OrderTarget::Measure`] one of the requested `measures`
/// (case-insensitive). `limit` needs no validation — any value including
/// `Some(0)` (empty result) is allowed.
pub(super) fn validate_order_by(request: &QueryRequest) -> QueryResult<()> {
    for clause in &request.order_by {
        match &clause.target {
            OrderTarget::Column(col) => {
                let in_group_by = request.group_by.iter().any(|g| {
                    g.table.eq_ignore_ascii_case(&col.table)
                        && g.column.eq_ignore_ascii_case(&col.column)
                });
                if !in_group_by {
                    return Err(QueryError::InvalidQuery(format!(
                        "ORDER BY column '{}.{}' must be one of the group_by columns",
                        col.table, col.column
                    )));
                }
            }
            OrderTarget::Measure(name) => {
                let in_measures = request
                    .measures
                    .iter()
                    .any(|m| m.eq_ignore_ascii_case(name));
                if !in_measures {
                    return Err(QueryError::InvalidQuery(format!(
                        "ORDER BY measure '{name}' must be one of the requested measures"
                    )));
                }
            }
        }
    }
    Ok(())
}

/// Compute the effective ORDER BY clauses for a request, canonicalizing
/// targets: column targets adopt the exact spelling of the matching
/// `group_by` entry and measure targets the resolved measure's name, so the
/// rendered SQL identifiers match the SELECT list exactly.
pub(super) fn canonical_effective_order(
    request: &QueryRequest,
    measures: &[Measure],
) -> Vec<OrderByClause> {
    request
        .effective_order_by()
        .into_iter()
        .map(|mut clause| {
            match &mut clause.target {
                OrderTarget::Column(col) => {
                    if let Some(canonical) = request.group_by.iter().find(|g| {
                        g.table.eq_ignore_ascii_case(&col.table)
                            && g.column.eq_ignore_ascii_case(&col.column)
                    }) {
                        *col = canonical.clone();
                    }
                }
                OrderTarget::Measure(name) => {
                    if let Some(measure) = measures
                        .iter()
                        .find(|m| m.name().eq_ignore_ascii_case(name))
                    {
                        *name = measure.name().to_string();
                    }
                }
            }
            clause
        })
        .collect()
}

/// Outcome of model `sort_by_column` resolution for an order-by column.
enum SortSubstitution {
    /// No substitution — order by the column itself.
    None,
    /// Substitute with this physical sort column (rendered as `MIN(col)`).
    Physical(String),
    /// A sort column is declared but is not a physical source column
    /// (e.g. a calculated column) — not expressible in pushed SQL.
    NotPushable,
}

/// Resolve the model `sort_by_column` substitution for an order-by column.
fn resolve_sort_substitution(model: &DataModel, col: &ColumnRef) -> SortSubstitution {
    let Some(table) = lookup_model_table(model, &col.table) else {
        return SortSubstitution::None;
    };
    let Ok(sort_col) = table.sort_column_for(&col.column) else {
        return SortSubstitution::None;
    };
    if sort_col.eq_ignore_ascii_case(&col.column) {
        return SortSubstitution::None;
    }
    if let Some(physical) = resolve_physical_column(table, sort_col) {
        SortSubstitution::Physical(physical.to_string())
    } else {
        SortSubstitution::NotPushable
    }
}

/// True when any effective order-by column requires sort-by-column
/// substitution (its model `sort_by_column` differs from the column itself).
pub(super) fn order_requires_sort_substitution(
    order_by: &[OrderByClause],
    model: &DataModel,
) -> bool {
    order_by.iter().any(|clause| match &clause.target {
        OrderTarget::Column(col) => !matches!(
            resolve_sort_substitution(model, col),
            SortSubstitution::None
        ),
        OrderTarget::Measure(_) => false,
    })
}

/// Build the connector-level ORDER BY entries for a pushed single-table
/// aggregation.
///
/// Sort-by-column substitution renders as `MIN(sort_col)` — the sort column
/// lives on the same (single) table but is not part of the GROUP BY clause,
/// so it must be aggregated; `MIN` is exact under the model's 1:1
/// display-value-to-sort-value assumption. Measure targets render as the
/// aggregate's output alias.
///
/// Returns `None` when an entry is not expressible at the source (the sort
/// column is not a physical source column); the planner then falls back to
/// local aggregation.
pub(super) fn build_pushed_order_by(
    order_by: &[OrderByClause],
    model: &DataModel,
) -> Option<Vec<engine_connectors::OrderByExpr>> {
    use engine_connectors::{OrderByExpr, OrderByTarget};

    let mut entries = Vec::with_capacity(order_by.len());
    for clause in order_by {
        let target = match &clause.target {
            OrderTarget::Column(col) => match resolve_sort_substitution(model, col) {
                SortSubstitution::None => OrderByTarget::Column(col.column.clone()),
                SortSubstitution::Physical(sort_col) => OrderByTarget::MinColumn(sort_col),
                SortSubstitution::NotPushable => return None,
            },
            OrderTarget::Measure(name) => OrderByTarget::Alias(name.clone()),
        };
        entries.push(OrderByExpr {
            target,
            descending: clause.descending,
        });
    }
    Some(entries)
}

#[cfg(test)]
mod tests {
    use super::super::test_util::*;
    use super::super::{PushdownPlanner, QueryPlan};
    use super::*;
    use crate::registry::{SourceBinding, SourceRegistry};
    use engine_core::compute::measure::sum_measure;
    use engine_core::model::{Column, Relationship, Table};
    use engine_core::types::DataType;

    // --- ORDER BY / LIMIT planning ---

    /// Single-table model whose `month_name` column sorts by `month_number`.
    fn test_model_with_sort_by() -> DataModel {
        let sales = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("amount", DataType::Float64),
                Column::new("month_name", DataType::String).with_sort_by("month_number"),
                Column::new("month_number", DataType::Int32),
            ],
        )
        .unwrap();

        DataModel::builder()
            .add_table(sales)
            .add_measure(sum_measure("TotalAmount", "Sales", "amount"))
            .build()
            .unwrap()
    }

    /// Star schema whose dimension `category` column sorts by `id`.
    fn test_model_star_schema_with_sort_by() -> DataModel {
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
                Column::new("category", DataType::String).with_sort_by("id"),
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

    #[test]
    fn order_by_column_not_in_group_by_is_rejected() {
        let model = test_model_single_table();
        let registry = mock_registry_single(0);

        let request = QueryRequest {
            measures: vec!["TotalAmount".into()],
            order_by: vec![crate::request::OrderByClause::column("Sales", "region")],
            ..Default::default()
        };

        let err = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap_err();
        match err {
            QueryError::InvalidQuery(msg) => {
                assert!(msg.contains("must be one of the group_by columns"), "{msg}");
            }
            other => panic!("Expected InvalidQuery, got {other:?}"),
        }
    }

    #[test]
    fn order_by_unknown_measure_is_rejected() {
        let model = test_model_single_table();
        let registry = mock_registry_single(0);

        let request = QueryRequest {
            measures: vec!["TotalAmount".into()],
            group_by: vec![ColumnRef::new("Sales", "region")],
            order_by: vec![crate::request::OrderByClause::measure_desc("Nope")],
            ..Default::default()
        };

        let err = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap_err();
        match err {
            QueryError::InvalidQuery(msg) => {
                assert!(
                    msg.contains("must be one of the requested measures"),
                    "{msg}"
                );
            }
            other => panic!("Expected InvalidQuery, got {other:?}"),
        }
    }

    #[test]
    fn pushed_plan_carries_order_by_and_limit() {
        use engine_connectors::{OrderByExpr, OrderByTarget};

        let model = test_model_single_table();
        let registry = mock_registry_single(0);

        let request = QueryRequest {
            measures: vec!["TotalAmount".into()],
            group_by: vec![ColumnRef::new("Sales", "region")],
            order_by: vec![crate::request::OrderByClause::measure_desc("TotalAmount")],
            limit: Some(5),
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();
        match plan {
            QueryPlan::PushedAggregation { request: fetch, .. } => {
                assert_eq!(
                    fetch.order_by,
                    vec![OrderByExpr {
                        target: OrderByTarget::Alias("TotalAmount".into()),
                        descending: true,
                    }]
                );
                assert_eq!(fetch.limit, Some(5));
            }
            other => panic!("Expected PushedAggregation, got {other:?}"),
        }
    }

    #[test]
    fn pushed_plan_defaults_order_to_group_by_columns() {
        use engine_connectors::{OrderByExpr, OrderByTarget};

        let model = test_model_single_table();
        let registry = mock_registry_single(0);

        let request = QueryRequest {
            measures: vec!["TotalAmount".into()],
            group_by: vec![ColumnRef::new("Sales", "region")],
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();
        match plan {
            QueryPlan::PushedAggregation { request: fetch, .. } => {
                assert_eq!(
                    fetch.order_by,
                    vec![OrderByExpr {
                        target: OrderByTarget::Column("region".into()),
                        descending: false,
                    }]
                );
                assert_eq!(fetch.limit, None);
            }
            other => panic!("Expected PushedAggregation, got {other:?}"),
        }
    }

    #[test]
    fn pushed_plan_substitutes_sort_by_column_as_min() {
        use engine_connectors::{OrderByExpr, OrderByTarget};

        let model = test_model_with_sort_by();
        let registry = mock_registry_single(0);

        let request = QueryRequest {
            measures: vec!["TotalAmount".into()],
            group_by: vec![ColumnRef::new("Sales", "month_name")],
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();
        match plan {
            QueryPlan::PushedAggregation { request: fetch, .. } => {
                assert_eq!(
                    fetch.order_by,
                    vec![OrderByExpr {
                        target: OrderByTarget::MinColumn("month_number".into()),
                        descending: false,
                    }]
                );
            }
            other => panic!("Expected PushedAggregation, got {other:?}"),
        }
    }

    /// Group-by on a dimension column whose ordering needs sort-by
    /// substitution: the pushed join result cannot carry the sort column,
    /// so the planner falls back to local aggregation.
    #[test]
    fn pushed_join_falls_back_to_local_when_sort_substitution_needed() {
        let model = test_model_star_schema_with_sort_by();
        let registry = mock_registry_star(0);

        let request = QueryRequest {
            measures: vec!["TotalAmount".into()],
            group_by: vec![ColumnRef::new("Products", "category")],
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();
        match plan {
            QueryPlan::LocalAggregation {
                order_by, limit, ..
            } => {
                assert_eq!(order_by.len(), 1);
                assert_eq!(
                    order_by[0],
                    crate::request::OrderByClause::column("Products", "category")
                );
                assert_eq!(limit, None);
            }
            other => panic!("Expected LocalAggregation, got {other:?}"),
        }

        // Sanity: grouping by a column without sort-by keeps the pushed join.
        let request = QueryRequest {
            measures: vec!["TotalAmount".into()],
            group_by: vec![ColumnRef::new("Products", "id")],
            ..Default::default()
        };
        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();
        assert!(matches!(plan, QueryPlan::PushedJoinAggregation { .. }));
    }

    #[test]
    fn pushed_join_plan_carries_order_by_and_limit() {
        let model = test_model_star_schema();
        let registry = mock_registry_star(0);

        let request = QueryRequest {
            measures: vec!["TotalAmount".into()],
            group_by: vec![ColumnRef::new("Products", "category")],
            order_by: vec![crate::request::OrderByClause::measure_desc("TotalAmount")],
            limit: Some(10),
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();
        match plan {
            QueryPlan::PushedJoinAggregation {
                order_by, limit, ..
            } => {
                assert_eq!(
                    order_by,
                    vec![crate::request::OrderByClause::measure_desc("TotalAmount")]
                );
                assert_eq!(limit, Some(10));
            }
            other => panic!("Expected PushedJoinAggregation, got {other:?}"),
        }
    }

    #[test]
    fn local_plan_carries_effective_order_and_limit() {
        let model = test_model_star_schema();
        let registry = make_cross_source_registry();

        let request = QueryRequest {
            measures: vec!["TotalAmount".into()],
            group_by: vec![ColumnRef::new("Products", "category")],
            limit: Some(3),
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();
        match plan {
            QueryPlan::LocalAggregation {
                order_by, limit, ..
            } => {
                // Default ordering derived from group_by, ascending.
                assert_eq!(
                    order_by,
                    vec![crate::request::OrderByClause::column(
                        "Products", "category"
                    )]
                );
                assert_eq!(limit, Some(3));
            }
            other => panic!("Expected LocalAggregation, got {other:?}"),
        }
    }

    /// ORDER BY targets are canonicalized to the group-by / measure spelling
    /// so SQL identifiers match the SELECT list.
    #[test]
    fn order_targets_are_canonicalized_to_request_spelling() {
        use engine_connectors::{OrderByExpr, OrderByTarget};

        let model = test_model_single_table();
        let registry = mock_registry_single(0);

        let request = QueryRequest {
            measures: vec!["TotalAmount".into()],
            group_by: vec![ColumnRef::new("Sales", "region")],
            order_by: vec![
                crate::request::OrderByClause::column("SALES", "REGION"),
                crate::request::OrderByClause::measure_desc("totalamount"),
            ],
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();
        match plan {
            QueryPlan::PushedAggregation { request: fetch, .. } => {
                assert_eq!(
                    fetch.order_by,
                    vec![
                        OrderByExpr {
                            target: OrderByTarget::Column("region".into()),
                            descending: false,
                        },
                        OrderByExpr {
                            target: OrderByTarget::Alias("TotalAmount".into()),
                            descending: true,
                        },
                    ]
                );
            }
            other => panic!("Expected PushedAggregation, got {other:?}"),
        }
    }

    // --- ROLLUP totals planning ---

    /// Single-table simple aggregates + totals: the ROLLUP is pushed to the
    /// source via the fetch request (no fallback to local aggregation).
    #[test]
    fn pushed_plan_carries_rollup_totals() {
        let model = test_model_single_table();
        let registry = mock_registry_single(0);

        let request = QueryRequest {
            measures: vec!["TotalAmount".into()],
            group_by: vec![ColumnRef::new("Sales", "region")],
            totals: crate::request::TotalsMode::Rollup,
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();
        match plan {
            QueryPlan::PushedAggregation { request: fetch, .. } => {
                assert!(fetch.rollup_totals);
                assert_eq!(fetch.group_by, vec!["region".to_string()]);
            }
            other => panic!("Expected PushedAggregation, got {other:?}"),
        }

        // Without totals the fetch request does not ask for ROLLUP.
        let request = QueryRequest {
            measures: vec!["TotalAmount".into()],
            group_by: vec![ColumnRef::new("Sales", "region")],
            ..Default::default()
        };
        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();
        match plan {
            QueryPlan::PushedAggregation { request: fetch, .. } => {
                assert!(!fetch.rollup_totals);
            }
            other => panic!("Expected PushedAggregation, got {other:?}"),
        }
    }

    /// The pushed join request cannot express ROLLUP — totals force the
    /// star-schema same-source plan back to local aggregation (which renders
    /// ROLLUP into the local DataFusion SQL), mirroring the order-by
    /// sort-substitution fallback.
    #[test]
    fn pushed_join_falls_back_to_local_when_totals_requested() {
        let model = test_model_star_schema();
        let registry = mock_registry_star(0);

        let base = QueryRequest {
            measures: vec!["TotalAmount".into()],
            group_by: vec![ColumnRef::new("Products", "category")],
            ..Default::default()
        };

        // Sanity: without totals this request pushes the join.
        let plan = PushdownPlanner::plan(&base, &model, &registry, &[]).unwrap();
        assert!(matches!(plan, QueryPlan::PushedJoinAggregation { .. }));

        let request = QueryRequest {
            totals: crate::request::TotalsMode::Rollup,
            ..base
        };
        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();
        match plan {
            QueryPlan::LocalAggregation { totals, .. } => {
                assert_eq!(totals, crate::request::TotalsMode::Rollup);
            }
            other => panic!("Expected LocalAggregation, got {other:?}"),
        }
    }

    #[test]
    fn totals_with_lookups_rejected() {
        let model = test_model_single_table();
        let registry = mock_registry_single(0);

        let request = QueryRequest {
            measures: vec!["TotalAmount".into()],
            group_by: vec![ColumnRef::new("Sales", "region")],
            lookups: vec![crate::request::LookupColumn::new("Sales", "region")],
            totals: crate::request::TotalsMode::Rollup,
            ..Default::default()
        };

        let err = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap_err();
        match err {
            QueryError::InvalidQuery(msg) => {
                assert!(msg.contains("lookup columns"), "unexpected message: {msg}");
            }
            other => panic!("Expected InvalidQuery, got {other:?}"),
        }
    }

    /// The `__grouping_id` bitmask is `Int32` — more than 31 group-by
    /// columns cannot be represented and are rejected at planning time.
    #[test]
    fn totals_with_more_than_31_group_by_columns_rejected() {
        let mut columns = vec![Column::new("amount", DataType::Float64)];
        for i in 0..32 {
            columns.push(Column::new(format!("dim{i}"), DataType::String));
        }
        let model = DataModel::builder()
            .add_table(Table::new("Wide", columns).unwrap())
            .add_measure(sum_measure("Total", "Wide", "amount"))
            .build()
            .unwrap();
        let mut registry = SourceRegistry::new();
        registry.bind("Wide", 0, SourceBinding::new("public", "wide"));

        let request = QueryRequest {
            measures: vec!["Total".into()],
            group_by: (0..32)
                .map(|i| ColumnRef::new("Wide", format!("dim{i}")))
                .collect(),
            totals: crate::request::TotalsMode::Rollup,
            ..Default::default()
        };

        let err = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap_err();
        match err {
            QueryError::InvalidQuery(msg) => {
                assert!(msg.contains("31"), "unexpected message: {msg}");
            }
            other => panic!("Expected InvalidQuery, got {other:?}"),
        }
    }
}
