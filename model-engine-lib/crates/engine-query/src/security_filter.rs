//! The ONE conversion of a row-level-security (RLS) role predicate into the
//! fetch filter that enforces it -- deliberately separate from every path a
//! measure's KEEP takes.
//!
//! # BLANK stays strict (owner decision BUG-0759, 2026-11-06)
//!
//! A role filter never admits a row whose column is BLANK unless it names
//! BLANK: `t[TenantId] = 0`, `<> 5`, `< 1` and `t[Code] = ""` all EXCLUDE the
//! rows whose value is BLANK. This is a deliberate, documented difference
//! from Power BI, where a role's DAX filter compares BLANK as 0 / "" ("All
//! comparison operators except == treat BLANK as equal to number 0, empty
//! string "", DATE(1899, 12, 30), or FALSE", Microsoft, *DAX operators*), so
//! `[TenantId] = 0` would also show the BLANK-tenant rows. A security filter
//! must never WIDEN what a role sees because a key is missing.
//!
//! # Why it is a separate path
//!
//! [`FilterPredicate`] is shared data: a KEEP's simple predicate and a role's
//! filter have the same shape. But they never share a renderer:
//!
//! - A KEEP predicate is resolved by `ContextResolver` into a
//!   `ResolvedFilter` and rendered by `engine_core::compute::context::
//!   format_filter_value` inside a measure's conditional aggregate, next to
//!   the DAX comparison rules of `engine_core::compute::dax_semantics`. A
//!   future change that gives KEEP DAX's BLANK-as-0 reading belongs THERE.
//! - A role predicate is converted HERE into a connector [`FilterCondition`]
//!   (`column op value`) placed on the fetch of the predicate's own table --
//!   a sealed pre-aggregation filter that no context operation can see
//!   (`planner::pushdown::security`). Every source renders a
//!   `FilterCondition` as a plain SQL comparison (`"col" = 0`, `"col"::text =
//!   $1`), under which `NULL op x` is never TRUE.
//!
//! Every RLS conversion in the workspace -- the planner's sealed filters, the
//! executor's defense-in-depth re-seal, the multi-role union of the `bi-engine`
//! facade -- calls [`role_filter_condition`]; nothing here reads
//! `dax_semantics`. Pinned end to end by `bi-engine`'s
//! `rls_blank_strict_tests` (cached, grouped, multi-fact, drill-through and
//! pushed-SQL routes) and by the tests below.

use engine_connectors::{FilterCondition, FilterOperator};
use engine_core::compute::expression::{ComparisonOp, FilterPredicate};
use engine_core::model::Relationship;

/// Does a role restriction on one table of `rel` restrict the rows of the
/// other? THE one gate, shared by the planner (`planner::pushdown::security`
/// `rls_relevance`, which decides whether a role-filtered table must be
/// pulled into the query or the query refused) and the executor (the
/// fetch's key propagation, `executor::pipeline::local_aggregation`), and by
/// the drill-through (`executor::pipeline::detail`, the third consumer, which
/// turns a role on a related dimension into an IN restriction on the detail
/// table's rows and refuses any other shape), so the halves of RLS
/// enforcement cannot drift apart: if they disagreed, a role would either
/// over-restrict or -- far worse -- LEAK.
///
/// It holds for every relationship the executor can turn into a row
/// restriction -- one single-column equality -- in EITHER direction,
/// whatever the relationship's cross-filter direction. A role filter is
/// sealed security, not a slicer: a role on the many side (`Sales[cat] =
/// "A"`) restricts the one side (`COUNTROWS(Product)` counts only the
/// products the role's sales reach) even when the relationship filters in a
/// single direction. Owner decision 2026-11-06 (BUG-0759, "RLS stays
/// strict"): a security filter never WIDENS what a role sees, a deliberate
/// difference from Power BI, whose single-direction RLS would count every
/// product unless "Apply security filter in both directions" is set. An
/// ordinary slicer follows the cross-filter direction instead
/// (`pre_aggregate::filter_reaches_fact`, wave 4); the executor applies that
/// rule to a fetch's slicers and this one to its role restriction.
pub fn role_restriction_propagates(rel: &Relationship) -> bool {
    rel.conditions().len() == 1 && rel.is_equi_only()
}

/// The connector operator of a role predicate's comparison. Total: every
/// [`ComparisonOp`] has its [`FilterOperator`], so a role always pushes down
/// faithfully.
pub fn role_filter_operator(op: ComparisonOp) -> FilterOperator {
    match op {
        ComparisonOp::Equal => FilterOperator::Equal,
        ComparisonOp::NotEqual => FilterOperator::NotEqual,
        ComparisonOp::GreaterThan => FilterOperator::GreaterThan,
        ComparisonOp::GreaterThanOrEqual => FilterOperator::GreaterThanOrEqual,
        ComparisonOp::LessThan => FilterOperator::LessThan,
        ComparisonOp::LessThanOrEqual => FilterOperator::LessThanOrEqual,
    }
}

/// Convert one role [`FilterPredicate`] into the fetch [`FilterCondition`]
/// that enforces it on the predicate's own table: `column op value`, with
/// BLANK STRICT (a BLANK value never satisfies it; see the module docs).
///
/// The [`FilterCondition`] is table-agnostic; the caller places it on the
/// fetch of [`FilterPredicate::table`]. A DYNAMIC predicate (USERNAME() /
/// CUSTOMDATA()) must already be substituted to its concrete identity: the
/// facade does that, and the executor's entry guard fails closed on one that
/// is not.
pub fn role_filter_condition(predicate: &FilterPredicate) -> FilterCondition {
    FilterCondition::new(
        predicate.column.clone(),
        role_filter_operator(predicate.operator),
        predicate.value.clone(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A role predicate becomes exactly `column op value` -- the plain
    /// comparison every source renders strictly (pinned for the pushed SQL by
    /// engine-connectors' `a_pushed_scalar_filter_never_admits_a_blank_value`,
    /// and for the in-memory sources by `in_memory_connector`'s
    /// `a_scalar_filter_never_admits_a_blank_value`).
    #[test]
    fn a_role_predicate_becomes_its_own_plain_comparison() {
        for (op, value, want) in [
            (ComparisonOp::Equal, "0", FilterOperator::Equal),
            (ComparisonOp::NotEqual, "5", FilterOperator::NotEqual),
            (ComparisonOp::LessThan, "1", FilterOperator::LessThan),
            (ComparisonOp::Equal, "", FilterOperator::Equal),
        ] {
            let condition =
                role_filter_condition(&FilterPredicate::new("Sales", "tenant", op, value));
            assert_eq!(condition.column, "tenant");
            assert_eq!(condition.value, value);
            assert_eq!(condition.operator, want);
            assert_eq!(condition.kind, FilterCondition::new("t", want, value).kind);
        }
    }
}
