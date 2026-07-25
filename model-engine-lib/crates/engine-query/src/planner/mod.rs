//! Query planning: pushdown decisions and query plan generation.

pub mod explain;
pub mod pushdown;

pub use pushdown::{
    effective_group_by, HierarchyLevelSpec, HierarchySpec, LookupSpec, PushdownPlanner, QueryPlan,
};

// RLS helpers shared with the executor's drillthrough path so it enforces the
// identical relevance / fail-closed check and seals the identical role
// conditions as the aggregation planner.
pub(crate) use pushdown::{rls_relevance, role_conditions_for_table};
