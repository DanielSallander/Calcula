//! Named context definitions for reusable filter configurations.
//!
//! A context is a named, composable set of filter operations that can be
//! applied to measure expressions via `using()`. Contexts enable reuse
//! of common filter patterns across multiple measures.

use serde::{Deserialize, Serialize};

use crate::compute::expression::{DynamicValue, FilterPredicate, InPredicate};

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
    /// Activate an inactive relationship for this context's scope.
    UseRelationship(String),
}

/// Render a filter value as expression text: bare if it round-trips through
/// the tokenizer as a number, quoted otherwise. (String literals have no
/// escape syntax, so a value containing `"` cannot be expressed — the caller's
/// parse-back validation surfaces that case.)
fn value_to_text(value: &str) -> String {
    match value.parse::<f64>() {
        Ok(n) if n.is_finite() => {
            // Mirror the parser's normalization (integers without ".0").
            let canonical = if n.fract() == 0.0 && n.abs() < i64::MAX as f64 {
                format!("{}", n as i64)
            } else {
                format!("{n}")
            };
            if canonical == value {
                canonical
            } else {
                format!("\"{value}\"")
            }
        }
        _ => format!("\"{value}\""),
    }
}

fn filter_to_text(f: &FilterPredicate) -> String {
    let rhs = match f.dynamic {
        Some(DynamicValue::Username) => "USERNAME()".to_string(),
        Some(DynamicValue::CustomData) => "CUSTOMDATA()".to_string(),
        None => value_to_text(&f.value),
    };
    format!("{}[{}] {} {}", f.table, f.column, f.operator.as_sql(), rhs)
}

fn in_predicate_to_text(p: &InPredicate) -> String {
    format!(
        "{}[{}] {} {}[{}]",
        p.table,
        p.column,
        if p.negated { "NOT IN" } else { "IN" },
        p.var_name,
        p.var_column
    )
}

fn clear_targets_to_text(targets: &[ClearTarget]) -> String {
    targets
        .iter()
        .map(|t| match t {
            ClearTarget::Column { table, column } => format!("{table}[{column}]"),
            ClearTarget::Table(table) => table.clone(),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

impl ContextOp {
    /// Render this operation in the `CONTEXT` expression syntax accepted by
    /// [`parse_context`](crate::compute::parser::parse_context). Returns
    /// `None` for operations with no textual form (an empty KEEP/CLEAR is a
    /// no-op and is dropped from the rendered definition).
    pub fn to_text(&self) -> Option<String> {
        match self {
            ContextOp::Keep(filters) => {
                let first = filters.first()?;
                let parts: Vec<String> = filters.iter().map(filter_to_text).collect();
                Some(format!("KEEP({}, {})", first.table, parts.join(", ")))
            }
            ContextOp::KeepIn(preds) => {
                let first = preds.first()?;
                let parts: Vec<String> = preds.iter().map(in_predicate_to_text).collect();
                Some(format!("KEEP({}, {})", first.table, parts.join(", ")))
            }
            ContextOp::Clear(targets) => (!targets.is_empty())
                .then(|| format!("CLEAR({})", clear_targets_to_text(targets))),
            ContextOp::ClearInner(targets) => (!targets.is_empty())
                .then(|| format!("CLEAR_INNER({})", clear_targets_to_text(targets))),
            ContextOp::ClearOuter(targets) => (!targets.is_empty())
                .then(|| format!("CLEAR_OUTER({})", clear_targets_to_text(targets))),
            ContextOp::Reset => Some("RESET()".to_string()),
            ContextOp::ResetInner => Some("RESET_INNER()".to_string()),
            ContextOp::ResetOuter => Some("RESET_OUTER()".to_string()),
            ContextOp::Inherit(name) => Some(name.clone()),
            ContextOp::UseRelationship(name) => Some(format!("USERELATIONSHIP(\"{name}\")")),
        }
    }
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

    /// Render the definition body in the `CONTEXT` expression syntax — the
    /// canonical text form accepted back by
    /// [`parse_context`](crate::compute::parser::parse_context). Operations
    /// with no textual form (empty KEEP/CLEAR no-ops) are dropped.
    pub fn to_text(&self) -> String {
        self.operations
            .iter()
            .filter_map(ContextOp::to_text)
            .collect::<Vec<_>>()
            .join(", ")
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
