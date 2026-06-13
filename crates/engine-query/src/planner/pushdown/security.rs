//! Row-level security (RLS) enforcement helpers for the pushdown planner.
//!
//! The active security role resolves to a set of [`FilterPredicate`]s, each
//! carrying its target table. These are applied as a **sealed
//! pre-aggregation filter**: the planner injects them into the source query /
//! cached-batch scan of every table they target, *before* any measure-context
//! machinery runs. Because they never pass through `ContextResolver`, no
//! context operation (`RESET` / `CLEAR` / ALL-style) can recover the excluded
//! rows — those manipulate post-fetch measure context over an already
//! restricted universe.
//!
//! A role that filters a **dimension** also restricts a related **fact**
//! table even when the dimension is not otherwise in the query (Power BI
//! semantics). The planner achieves this by pulling the role-filtered
//! dimension into the fetch set and routing the query through the
//! relationship-aware [`LocalAggregation`](super::QueryPlan::LocalAggregation)
//! path, whose two-phase IN-propagation turns the filtered dimension's
//! surviving join keys into an IN filter on the fact — so only permitted fact
//! rows survive. The price is that an RLS-active query that touches a
//! role-filtered table forgoes the single-table / pushed-join fast paths;
//! correctness is worth one extra fetch.

use std::collections::{HashSet, VecDeque};

use engine_connectors::{FilterCondition, FilterOperator};
use engine_core::compute::expression::{ComparisonOp, FilterPredicate};
use engine_core::error::EngineError;
use engine_core::model::DataModel;

/// Map an engine-core [`ComparisonOp`] to a connector [`FilterOperator`].
///
/// Total: every `ComparisonOp` variant has a `FilterOperator` counterpart, so
/// role predicates always push down faithfully.
pub(super) fn comparison_to_filter_operator(op: ComparisonOp) -> FilterOperator {
    match op {
        ComparisonOp::Equal => FilterOperator::Equal,
        ComparisonOp::NotEqual => FilterOperator::NotEqual,
        ComparisonOp::GreaterThan => FilterOperator::GreaterThan,
        ComparisonOp::GreaterThanOrEqual => FilterOperator::GreaterThanOrEqual,
        ComparisonOp::LessThan => FilterOperator::LessThan,
        ComparisonOp::LessThanOrEqual => FilterOperator::LessThanOrEqual,
    }
}

/// Convert one role [`FilterPredicate`] into a connector [`FilterCondition`].
///
/// The [`FilterCondition`] is table-agnostic (column / op / value); callers
/// place it on the fetch of the predicate's own [`FilterPredicate::table`].
pub(super) fn predicate_to_condition(predicate: &FilterPredicate) -> FilterCondition {
    FilterCondition {
        column: predicate.column.clone(),
        operator: comparison_to_filter_operator(predicate.operator),
        value: predicate.value.clone(),
    }
}

/// Collect the role's [`FilterCondition`]s that target a specific table.
///
/// Returns an empty vec when the role filters nothing on `table_name`.
pub(crate) fn role_conditions_for_table(
    role_filters: &[FilterPredicate],
    table_name: &str,
) -> Vec<FilterCondition> {
    role_filters
        .iter()
        .filter(|p| p.table == table_name)
        .map(predicate_to_condition)
        .collect()
}

/// The distinct set of tables the active role filters.
pub(super) fn role_filtered_tables(role_filters: &[FilterPredicate]) -> HashSet<String> {
    role_filters.iter().map(|p| p.table.clone()).collect()
}

/// Is `dim` restrictable on `fact` by the single mechanism the executor
/// implements — a **single-hop, active, single-column equi** relationship?
///
/// This MUST agree exactly with the IN-propagation gate in
/// `executor/pipeline/local_aggregation.rs` (`rel.conditions().len() == 1 &&
/// rel.is_equi_only()` over an *active* relationship found by
/// [`DataModel::find_relationship`]). The relevance check and the executor's
/// propagation are the two halves of one contract: if they disagree, RLS
/// either over-restricts (an enforcement we never apply) or — far worse —
/// under-restricts (a leak). Keep them in lockstep.
fn fact_restrictable_by_dimension(model: &DataModel, fact: &str, dim: &str) -> bool {
    model
        .find_relationship(fact, dim)
        .map(|rel| rel.conditions().len() == 1 && rel.is_equi_only())
        .unwrap_or(false)
}

/// Is `target` reachable from `start` over the relationship graph, treating
/// every relationship (active OR inactive) as an undirected edge?
///
/// Used to decide whether a role-filtered table *could* restrict a queried
/// fact at all. If it is reachable but not via the one enforceable shape
/// ([`fact_restrictable_by_dimension`]), enforcement fails closed.
fn reachable(model: &DataModel, start: &str, target: &str) -> bool {
    if start.eq_ignore_ascii_case(target) {
        return true;
    }
    let mut seen: HashSet<String> = HashSet::new();
    seen.insert(start.to_string());
    let mut queue: VecDeque<String> = VecDeque::new();
    queue.push_back(start.to_string());
    while let Some(node) = queue.pop_front() {
        for rel in model.relationships() {
            let neighbor = if rel.from_table() == node {
                Some(rel.to_table())
            } else if rel.to_table() == node {
                Some(rel.from_table())
            } else {
                None
            };
            if let Some(n) = neighbor {
                if n == target {
                    return true;
                }
                if seen.insert(n.to_string()) {
                    queue.push_back(n.to_string());
                }
            }
        }
    }
    false
}

/// Decide whether RLS is **relevant** to this query and which role-filtered
/// tables must be pulled into the fetch set — failing **closed** when a
/// relevant restriction cannot be enforced.
///
/// RLS is relevant when the active role filters a table that either
/// participates directly in the query (`query_tables`) or could restrict one
/// of the query's measure (fact) tables through the relationship graph.
///
/// Returns `(relevant, extra_tables)` where `extra_tables` are role-filtered
/// dimensions not already in `query_tables` that must be fetched (and thus
/// filtered) so their restriction reaches the fact via single-hop
/// IN-propagation. When `relevant` is `false` the role does not touch this
/// query and enforcement is a no-op.
///
/// **Security contract (fail closed):** if a role-filtered table is *reachable*
/// from a queried fact (so it would restrict that fact's rows) but not through
/// the one enforceable shape — a single-hop, active, single-column equi
/// relationship — this returns
/// [`EngineError::RowLevelSecurityNotEnforceable`] and the query is refused.
/// Refusing is mandatory: a non-equi / many-to-many / composite-key /
/// inactive / multi-hop (snowflake) relationship would otherwise pull the
/// dimension in, force local execution, and then silently leave the fact
/// unrestricted (a data leak). A role-filtered table that is in the query is
/// always enforceable — its predicates are sealed onto its own fetch and the
/// in-statement join restricts the fact.
pub(crate) fn rls_relevance(
    role_filters: &[FilterPredicate],
    query_tables: &HashSet<String>,
    measure_tables: &[&str],
    model: &DataModel,
) -> Result<(bool, Vec<String>), EngineError> {
    if role_filters.is_empty() {
        return Ok((false, Vec::new()));
    }

    let filtered = role_filtered_tables(role_filters);
    let mut relevant = false;
    let mut extra: Vec<String> = Vec::new();
    let mut seen_extra: HashSet<String> = HashSet::new();

    for table in &filtered {
        if query_tables.contains(table) {
            // The role filters a table already in the query — its predicates
            // are injected onto that table's own fetch and the in-statement
            // join restricts the fact. Always enforceable.
            relevant = true;
            continue;
        }
        // The role filters a table NOT in the query. For every queried fact it
        // could restrict, the restriction must be enforceable — otherwise we
        // must refuse the query rather than leak.
        let mut pulled_in = false;
        for &fact in measure_tables {
            if !reachable(model, fact, table) {
                // This role-filtered table cannot restrict this fact at all.
                continue;
            }
            if fact_restrictable_by_dimension(model, fact, table) {
                // Enforceable: pull the dimension in; the executor's two-phase
                // IN-propagation restricts the fact to permitted join keys.
                relevant = true;
                pulled_in = true;
            } else {
                // Reachable (so it WOULD restrict this fact) but not via the
                // one enforceable shape — fail closed.
                let reason = format!(
                    "it is related to queried fact table '{fact}' only through a relationship \
                     the engine cannot turn into a row restriction (non-equi, many-to-many, \
                     composite-key, inactive, or multi-hop/snowflake). Row-level security v1 \
                     enforces only a single-hop active single-column equi relationship; refusing \
                     the query to avoid returning unauthorized rows"
                );
                return Err(EngineError::RowLevelSecurityNotEnforceable {
                    table: table.clone(),
                    reason,
                });
            }
        }
        if pulled_in && seen_extra.insert(table.clone()) {
            extra.push(table.clone());
        }
        // A role-filtered table unreachable from any queried fact restricts
        // nothing this query can observe — skip it (no false disqualification,
        // no false rejection).
    }

    Ok((relevant, extra))
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine_core::model::{
        Cardinality, Column, JoinCondition, JoinOperator, Relationship, Table,
    };
    use engine_core::types::DataType;

    fn star_model() -> DataModel {
        let fact = Table::new(
            "Sales",
            vec![
                Column::new("geo_id", DataType::Int64),
                Column::new("amount", DataType::Float64),
            ],
        )
        .unwrap();
        let geo = Table::new(
            "Geography",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("region", DataType::String),
            ],
        )
        .unwrap();
        // An unrelated dimension to prove irrelevance.
        let cal = Table::new("Calendar", vec![Column::new("year", DataType::Int32)]).unwrap();
        DataModel::builder()
            .add_table(fact)
            .add_table(geo)
            .add_table(cal)
            .add_relationship(Relationship::many_to_one(
                "Sales_Geo",
                "Sales",
                "geo_id",
                "Geography",
                "id",
            ))
            .build()
            .unwrap()
    }

    fn west_filter() -> Vec<FilterPredicate> {
        vec![FilterPredicate::new(
            "Geography",
            "region",
            ComparisonOp::Equal,
            "West",
        )]
    }

    #[test]
    fn op_mapping_is_total() {
        assert_eq!(
            comparison_to_filter_operator(ComparisonOp::Equal),
            FilterOperator::Equal
        );
        assert_eq!(
            comparison_to_filter_operator(ComparisonOp::NotEqual),
            FilterOperator::NotEqual
        );
        assert_eq!(
            comparison_to_filter_operator(ComparisonOp::LessThanOrEqual),
            FilterOperator::LessThanOrEqual
        );
    }

    #[test]
    fn conditions_for_table_filters_by_table() {
        let role = west_filter();
        let geo = role_conditions_for_table(&role, "Geography");
        assert_eq!(geo.len(), 1);
        assert_eq!(geo[0].column, "region");
        assert_eq!(geo[0].value, "West");
        assert!(role_conditions_for_table(&role, "Sales").is_empty());
    }

    #[test]
    fn dimension_role_is_relevant_and_pulls_dimension_in() {
        let model = star_model();
        let role = west_filter();
        // Query touches only the fact (Sales); Geography not in query.
        let query_tables: HashSet<String> = ["Sales".to_string()].into_iter().collect();
        let (relevant, extra) = rls_relevance(&role, &query_tables, &["Sales"], &model).unwrap();
        assert!(
            relevant,
            "dimension RLS related to the fact must be relevant"
        );
        assert_eq!(extra, vec!["Geography".to_string()]);
    }

    #[test]
    fn dimension_role_already_in_query_needs_no_extra_fetch() {
        let model = star_model();
        let role = west_filter();
        let query_tables: HashSet<String> = ["Sales".to_string(), "Geography".to_string()]
            .into_iter()
            .collect();
        let (relevant, extra) = rls_relevance(&role, &query_tables, &["Sales"], &model).unwrap();
        assert!(relevant);
        assert!(extra.is_empty(), "Geography already fetched");
    }

    #[test]
    fn unrelated_role_table_is_irrelevant() {
        let model = star_model();
        // Role filters Calendar, which has NO relationship to Sales.
        let role = vec![FilterPredicate::new(
            "Calendar",
            "year",
            ComparisonOp::Equal,
            "2024",
        )];
        let query_tables: HashSet<String> = ["Sales".to_string()].into_iter().collect();
        let (relevant, extra) = rls_relevance(&role, &query_tables, &["Sales"], &model).unwrap();
        assert!(!relevant, "a role table unrelated to the query is a no-op");
        assert!(extra.is_empty());
    }

    #[test]
    fn no_role_is_irrelevant() {
        let model = star_model();
        let query_tables: HashSet<String> = ["Sales".to_string()].into_iter().collect();
        let (relevant, extra) = rls_relevance(&[], &query_tables, &["Sales"], &model).unwrap();
        assert!(!relevant);
        assert!(extra.is_empty());
    }

    // --- Fail-closed: relevant-but-unenforceable role restrictions ---

    fn composite_key_model() -> DataModel {
        let fact = Table::new(
            "Sales",
            vec![
                Column::new("geo_a", DataType::Int64),
                Column::new("geo_b", DataType::Int64),
                Column::new("amount", DataType::Float64),
            ],
        )
        .unwrap();
        let geo = Table::new(
            "Geography",
            vec![
                Column::new("a", DataType::Int64),
                Column::new("b", DataType::Int64),
                Column::new("region", DataType::String),
            ],
        )
        .unwrap();
        DataModel::builder()
            .add_table(fact)
            .add_table(geo)
            .add_relationship(Relationship::with_conditions(
                "Sales_Geo",
                "Sales",
                "Geography",
                vec![
                    JoinCondition::equal("geo_a", "a"),
                    JoinCondition::equal("geo_b", "b"),
                ],
                Cardinality::ManyToOne,
            ))
            .build()
            .unwrap()
    }

    #[test]
    fn composite_key_dimension_role_fails_closed() {
        // Two-condition (composite) equi relationship: IN-propagation skips it,
        // so a dimension role over it must be REFUSED, not silently leaked.
        let model = composite_key_model();
        let role = west_filter();
        let query_tables: HashSet<String> = ["Sales".to_string()].into_iter().collect();
        let err = rls_relevance(&role, &query_tables, &["Sales"], &model).unwrap_err();
        assert!(
            matches!(err, EngineError::RowLevelSecurityNotEnforceable { .. }),
            "composite-key dimension RLS must fail closed, got {err:?}"
        );
    }

    #[test]
    fn many_to_many_dimension_role_fails_closed() {
        let fact = Table::new(
            "Sales",
            vec![
                Column::new("order_date", DataType::Int64),
                Column::new("amount", DataType::Float64),
            ],
        )
        .unwrap();
        let periods = Table::new(
            "Periods",
            vec![
                Column::new("start", DataType::Int64),
                Column::new("end", DataType::Int64),
                Column::new("region", DataType::String),
            ],
        )
        .unwrap();
        // Non-equi, multi-condition, many-to-many BETWEEN relationship.
        let model = DataModel::builder()
            .add_table(fact)
            .add_table(periods)
            .add_relationship(Relationship::with_conditions(
                "Sales_Periods",
                "Sales",
                "Periods",
                vec![
                    JoinCondition::new("order_date", "start", JoinOperator::GreaterThanOrEqual),
                    JoinCondition::new("order_date", "end", JoinOperator::LessThanOrEqual),
                ],
                Cardinality::ManyToMany,
            ))
            .build()
            .unwrap();
        let role = vec![FilterPredicate::new(
            "Periods",
            "region",
            ComparisonOp::Equal,
            "West",
        )];
        let query_tables: HashSet<String> = ["Sales".to_string()].into_iter().collect();
        let err = rls_relevance(&role, &query_tables, &["Sales"], &model).unwrap_err();
        assert!(matches!(
            err,
            EngineError::RowLevelSecurityNotEnforceable { .. }
        ));
    }

    #[test]
    fn inactive_only_dimension_role_fails_closed() {
        // Geography reaches Sales ONLY through an inactive relationship:
        // find_relationship (active-only) misses it, but it IS reachable, so
        // enforcement must fail closed rather than silently no-op.
        let fact = Table::new(
            "Sales",
            vec![
                Column::new("geo_id", DataType::Int64),
                Column::new("amount", DataType::Float64),
            ],
        )
        .unwrap();
        let geo = Table::new(
            "Geography",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("region", DataType::String),
            ],
        )
        .unwrap();
        let model = DataModel::builder()
            .add_table(fact)
            .add_table(geo)
            .add_relationship(
                Relationship::many_to_one("Sales_Geo", "Sales", "geo_id", "Geography", "id")
                    .with_active(false),
            )
            .build()
            .unwrap();
        let role = west_filter();
        let query_tables: HashSet<String> = ["Sales".to_string()].into_iter().collect();
        let err = rls_relevance(&role, &query_tables, &["Sales"], &model).unwrap_err();
        assert!(matches!(
            err,
            EngineError::RowLevelSecurityNotEnforceable { .. }
        ));
    }

    #[test]
    fn snowflake_two_hop_dimension_role_fails_closed() {
        // Sales -> Geography -> Region. Role filters Region (two hops). The
        // engine's one-round propagation cannot enforce it → fail closed
        // instead of silently running the fact unrestricted.
        let fact = Table::new(
            "Sales",
            vec![
                Column::new("geo_id", DataType::Int64),
                Column::new("amount", DataType::Float64),
            ],
        )
        .unwrap();
        let geo = Table::new(
            "Geography",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("region_id", DataType::Int64),
            ],
        )
        .unwrap();
        let region = Table::new(
            "Region",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("name", DataType::String),
            ],
        )
        .unwrap();
        let model = DataModel::builder()
            .add_table(fact)
            .add_table(geo)
            .add_table(region)
            .add_relationship(Relationship::many_to_one(
                "Sales_Geo",
                "Sales",
                "geo_id",
                "Geography",
                "id",
            ))
            .add_relationship(Relationship::many_to_one(
                "Geo_Region",
                "Geography",
                "region_id",
                "Region",
                "id",
            ))
            .build()
            .unwrap();
        let role = vec![FilterPredicate::new(
            "Region",
            "name",
            ComparisonOp::Equal,
            "West",
        )];
        let query_tables: HashSet<String> = ["Sales".to_string()].into_iter().collect();
        let err = rls_relevance(&role, &query_tables, &["Sales"], &model).unwrap_err();
        assert!(
            matches!(err, EngineError::RowLevelSecurityNotEnforceable { .. }),
            "two-hop snowflake dimension RLS must fail closed, got {err:?}"
        );
    }

    #[test]
    fn snowflake_role_in_query_is_enforceable() {
        // Same snowflake, but Region IS in the query: its predicates seal onto
        // its own fetch and the in-statement join restricts — no error.
        let fact = Table::new(
            "Sales",
            vec![
                Column::new("geo_id", DataType::Int64),
                Column::new("amount", DataType::Float64),
            ],
        )
        .unwrap();
        let geo = Table::new(
            "Geography",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("region_id", DataType::Int64),
            ],
        )
        .unwrap();
        let region = Table::new(
            "Region",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("name", DataType::String),
            ],
        )
        .unwrap();
        let model = DataModel::builder()
            .add_table(fact)
            .add_table(geo)
            .add_table(region)
            .add_relationship(Relationship::many_to_one(
                "Sales_Geo",
                "Sales",
                "geo_id",
                "Geography",
                "id",
            ))
            .add_relationship(Relationship::many_to_one(
                "Geo_Region",
                "Geography",
                "region_id",
                "Region",
                "id",
            ))
            .build()
            .unwrap();
        let role = vec![FilterPredicate::new(
            "Region",
            "name",
            ComparisonOp::Equal,
            "West",
        )];
        let query_tables: HashSet<String> = [
            "Sales".to_string(),
            "Geography".to_string(),
            "Region".to_string(),
        ]
        .into_iter()
        .collect();
        let (relevant, extra) = rls_relevance(&role, &query_tables, &["Sales"], &model).unwrap();
        assert!(relevant);
        assert!(extra.is_empty(), "Region already in the query");
    }
}
