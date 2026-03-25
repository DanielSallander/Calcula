//! Named context definitions for reusable filter configurations.
//!
//! A context is a named, composable set of filter operations that can be
//! applied to measure expressions via `using()`. Contexts enable reuse
//! of common filter patterns across multiple measures.

use serde::{Deserialize, Serialize};

use crate::compute::expression::{FilterPredicate, InPredicate};

/// A target for clearing filters from the evaluation context.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClearTarget {
    /// Clear filters on a specific column.
    Column {
        /// Table name.
        table: String,
        /// Column name.
        column: String,
    },
    /// Clear all filters on a table.
    Table(String),
}

/// A single operation within a context definition.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ContextOp {
    /// Add filter conditions (AND with existing context).
    Keep(Vec<FilterPredicate>),
    /// Remove filters on specific dimensions (both sources).
    Clear(Vec<ClearTarget>),
    /// Remove all filters (both sources).
    Reset,
    /// Remove inner (group-by) filters on specific dimensions.
    ClearInner(Vec<ClearTarget>),
    /// Remove outer (query-level) filters on specific dimensions.
    ClearOuter(Vec<ClearTarget>),
    /// Remove all inner (group-by) filters.
    ResetInner,
    /// Remove all outer (query-level) filters.
    ResetOuter,
    /// Apply IN-membership filters.
    KeepIn(Vec<InPredicate>),
    /// Inherit all operations from another named context.
    Inherit(String),
}

/// A named, reusable context definition.
///
/// Contexts are defined at the model level and referenced in measure
/// expressions via `using(expr, context_name)`.
///
/// # Example
///
/// ```
/// use engine_core::model::context::{ContextDefinition, ContextOp, ClearTarget};
/// use engine_core::compute::{FilterPredicate, ComparisonOp};
///
/// let ctx = ContextDefinition::new(
///     "bikes_2024",
///     vec![
///         ContextOp::Keep(vec![
///             FilterPredicate::new("Calendar", "Year", ComparisonOp::Equal, "2024"),
///             FilterPredicate::new("Products", "Category", ComparisonOp::Equal, "Bikes"),
///         ]),
///     ],
/// );
/// assert_eq!(ctx.name(), "bikes_2024");
/// assert_eq!(ctx.operations().len(), 1);
/// ```
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContextDefinition {
    name: String,
    operations: Vec<ContextOp>,
}

impl ContextDefinition {
    /// Create a new context definition.
    pub fn new(name: impl Into<String>, operations: Vec<ContextOp>) -> Self {
        Self {
            name: name.into(),
            operations,
        }
    }

    /// Returns the context name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the context operations.
    pub fn operations(&self) -> &[ContextOp] {
        &self.operations
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute::expression::ComparisonOp;

    #[test]
    fn context_definition_creation() {
        let ctx = ContextDefinition::new(
            "test_ctx",
            vec![
                ContextOp::Keep(vec![FilterPredicate::new(
                    "Sales",
                    "Region",
                    ComparisonOp::Equal,
                    "US",
                )]),
                ContextOp::Clear(vec![ClearTarget::Column {
                    table: "Calendar".into(),
                    column: "Year".into(),
                }]),
            ],
        );
        assert_eq!(ctx.name(), "test_ctx");
        assert_eq!(ctx.operations().len(), 2);
    }

    #[test]
    fn context_with_inherit() {
        let ctx = ContextDefinition::new(
            "derived",
            vec![
                ContextOp::Inherit("base_ctx".into()),
                ContextOp::Keep(vec![FilterPredicate::new(
                    "Products",
                    "Category",
                    ComparisonOp::Equal,
                    "Bikes",
                )]),
            ],
        );
        assert_eq!(ctx.operations().len(), 2);
    }

    #[test]
    fn context_serialization_roundtrip() {
        let ctx = ContextDefinition::new(
            "ctx_2024",
            vec![ContextOp::Keep(vec![FilterPredicate::new(
                "Calendar",
                "Year",
                ComparisonOp::Equal,
                "2024",
            )])],
        );
        let json = serde_json::to_string(&ctx).unwrap();
        let deserialized: ContextDefinition = serde_json::from_str(&json).unwrap();
        assert_eq!(ctx, deserialized);
    }

    #[test]
    fn context_with_reset() {
        let ctx = ContextDefinition::new("no_filters", vec![ContextOp::Reset]);
        assert_eq!(ctx.operations().len(), 1);
        assert_eq!(ctx.operations()[0], ContextOp::Reset);
    }
}
