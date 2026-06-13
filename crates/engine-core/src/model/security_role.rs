//! Named security roles for client-side row-level security (RLS).
//!
//! A [`SecurityRole`] is authored content that travels in the model file. It
//! names a set of per-table row filters; a host activates **one** role on the
//! engine after authenticating the user, and every query the engine then runs
//! is restricted to the rows that role's filters permit.
//!
//! # Semantics
//!
//! A role carries a list of [`FilterPredicate`]s, each targeting a specific
//! `table.column`. The predicates **AND together**: a row of a filtered table
//! is visible only if it satisfies *every* predicate the role declares on that
//! table. Tables a role does not mention are unrestricted by the role.
//!
//! The restriction is applied as a **sealed pre-aggregation filter** by the
//! query planner and executor — it is layered onto the source query / cached
//! scan *before* any measure-context machinery runs, so context operations
//! (`RESET` / `CLEAR` / ALL-style) cannot recover excluded rows. A role that
//! filters a dimension also restricts a related fact table even when that
//! dimension is not otherwise in the query (Power BI semantics).
//!
//! # Honest limitations (v1)
//!
//! Client-side RLS in an embedded library is **advisory**: it constrains
//! queries that go *through* this engine. A host holding direct source
//! credentials can bypass it, so the source database's own grants remain the
//! real authority. In addition, v1:
//!
//! - activates a **single** role at a time (multi-role union is deferred);
//! - supports only static `column op value` predicates, AND-combined (no
//!   OR / IN-list, and no dynamic `USERNAME()`-style identity filters);
//! - enforces a dimension restriction on a fact only over a **single-hop,
//!   active, single-column equi** relationship (the shape the executor can
//!   turn into a fact restriction).
//!
//! Crucially, v1 **fails closed**: if a role filters a dimension that could
//! restrict a queried fact but reaches it only through a relationship the
//! engine cannot enforce — non-equi / many-to-many / composite-key / inactive
//! / multi-hop (snowflake) — the query is **refused**
//! ([`EngineError::RowLevelSecurityNotEnforceable`](crate::error::EngineError::RowLevelSecurityNotEnforceable))
//! rather than run with an under-restricted (data-leaking) result. A role on a
//! table that is *in* the query, or unrelated to it, is always handled (sealed
//! onto that table's own fetch, or ignored).

use serde::{Deserialize, Serialize};

use crate::compute::expression::{ComparisonOp, FilterPredicate};
use crate::error::EngineResult;
use crate::model::schema::validate_identifier;

/// A named security role: a set of per-table row filters that, when active,
/// restrict every query to the rows the role permits.
///
/// The role's [`FilterPredicate`]s **AND together** per table: a row is
/// visible only if it satisfies every predicate the role declares on that
/// row's table. See the [module documentation](self) for the full semantics
/// and the honest v1 limitations.
///
/// # Example
///
/// ```
/// use engine_core::model::SecurityRole;
/// use engine_core::compute::expression::ComparisonOp;
///
/// let west = SecurityRole::new("WestOnly")
///     .with_filter("Geography", "region", ComparisonOp::Equal, "West");
/// assert_eq!(west.name(), "WestOnly");
/// assert_eq!(west.table_filters().len(), 1);
/// ```
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SecurityRole {
    /// The role's unique name (the key a host activates).
    name: String,
    /// Per-table row filters. Predicates AND together within a table; a row
    /// of a filtered table is visible only if it satisfies all of them.
    table_filters: Vec<FilterPredicate>,
}

impl SecurityRole {
    /// Create a new security role with no filters yet.
    ///
    /// Add filters with [`with_filter`](Self::with_filter), or build the role
    /// from a ready-made list with [`with_filters`](Self::with_filters).
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            table_filters: Vec::new(),
        }
    }

    /// Add a single row filter `table.column op value` to the role.
    ///
    /// Filters accumulate and AND together: a row of `table` is visible only
    /// if it satisfies this predicate and every other predicate the role
    /// declares on the same table.
    pub fn with_filter(
        mut self,
        table: impl Into<String>,
        column: impl Into<String>,
        operator: ComparisonOp,
        value: impl Into<String>,
    ) -> Self {
        self.table_filters
            .push(FilterPredicate::new(table, column, operator, value));
        self
    }

    /// Replace the role's filters with the given list.
    ///
    /// Equivalent to constructing the role and adding each predicate; useful
    /// when the predicates are produced programmatically.
    pub fn with_filters(mut self, filters: Vec<FilterPredicate>) -> Self {
        self.table_filters = filters;
        self
    }

    /// The role's name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The role's per-table row filters (AND-combined within each table).
    pub fn table_filters(&self) -> &[FilterPredicate] {
        &self.table_filters
    }

    /// Validate the role for safe use.
    ///
    /// Checks that the role name is a legal model identifier (it is surfaced
    /// in errors and used as a cache-key component) and that every filter
    /// predicate validates for safe SQL rendering. This does **not** check
    /// that the referenced tables and columns exist — that resolution against
    /// the surrounding model happens in [`DataModelBuilder::build`].
    ///
    /// [`DataModelBuilder::build`]: crate::model::DataModelBuilder::build
    pub fn validate(&self) -> EngineResult<()> {
        validate_identifier(&self.name, "security role")?;
        for filter in &self.table_filters {
            filter.validate()?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_role_has_name_and_no_filters() {
        let role = SecurityRole::new("Analyst");
        assert_eq!(role.name(), "Analyst");
        assert!(role.table_filters().is_empty());
    }

    #[test]
    fn with_filter_accumulates_predicates() {
        let role = SecurityRole::new("WestOnly")
            .with_filter("Geography", "region", ComparisonOp::Equal, "West")
            .with_filter("Sales", "amount", ComparisonOp::GreaterThan, "0");
        assert_eq!(role.table_filters().len(), 2);
        assert_eq!(role.table_filters()[0].table, "Geography");
        assert_eq!(role.table_filters()[0].column, "region");
        assert_eq!(role.table_filters()[0].operator, ComparisonOp::Equal);
        assert_eq!(role.table_filters()[0].value, "West");
    }

    #[test]
    fn with_filters_replaces_the_list() {
        let role = SecurityRole::new("R").with_filters(vec![FilterPredicate::new(
            "T",
            "c",
            ComparisonOp::Equal,
            "v",
        )]);
        assert_eq!(role.table_filters().len(), 1);
    }

    #[test]
    fn validate_accepts_well_formed_role() {
        let role = SecurityRole::new("WestOnly").with_filter(
            "Geography",
            "region",
            ComparisonOp::Equal,
            "West",
        );
        assert!(role.validate().is_ok());
    }

    #[test]
    fn validate_rejects_bad_role_name() {
        let role = SecurityRole::new("bad\"name");
        assert!(role.validate().is_err());
    }

    #[test]
    fn validate_rejects_unsafe_filter_table() {
        // A table name with a quote breaks raw SQL qualification; the
        // predicate's own validate() must reject it.
        let role = SecurityRole::new("R").with_filter("evil\"table", "c", ComparisonOp::Equal, "v");
        assert!(role.validate().is_err());
    }

    #[test]
    fn serde_round_trip_preserves_role() {
        let role = SecurityRole::new("WestOnly")
            .with_filter("Geography", "region", ComparisonOp::Equal, "West")
            .with_filter("Geography", "active", ComparisonOp::Equal, "true");
        let json = serde_json::to_string(&role).unwrap();
        let back: SecurityRole = serde_json::from_str(&json).unwrap();
        assert_eq!(role, back);
    }
}
