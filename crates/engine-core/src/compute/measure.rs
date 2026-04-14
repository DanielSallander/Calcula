//! Measure definitions — named aggregation expressions over the data model.
//!
//! Measures are the primary computation unit in the engine. Each measure
//! is an expression tree that must contain at least one aggregate node.
//! Simple measures like `SUM(amount)` can be pushed down to data sources;
//! complex expression measures like `SUM(price * qty)` or
//! `SUM(revenue) / COUNT(orders)` are computed locally.

use serde::{Deserialize, Serialize};

use crate::compute::aggregate::AggregateOp;
use crate::compute::expression::{self as expr, infer_fact_table, Expression};

/// A named measure: a reusable aggregation expression over a table.
///
/// Measures are defined as expression trees that contain aggregate nodes.
/// The simplest form is `AGG(column)`, but measures can also be
/// expressions over aggregates like `SUM(price * quantity)` or
/// `SUM(revenue) / COUNT(orders)`.
///
/// The fact table is inferred from the expression's qualified column
/// references (e.g. `Sales[amount]`). A cached copy is stored at
/// construction time for efficient `&str` access.
#[derive(Debug, Clone, Serialize)]
pub struct Measure {
    name: String,
    expression: Expression,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    group: Option<String>,
    /// Fact table inferred from the expression's qualified column refs.
    #[serde(skip)]
    cached_table: String,
}

impl<'de> Deserialize<'de> for Measure {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Fields {
            name: String,
            expression: Expression,
            #[serde(default)]
            group: Option<String>,
        }
        let f = Fields::deserialize(deserializer)?;
        let cached_table = infer_fact_table(&f.expression).unwrap_or_default();
        Ok(Measure {
            name: f.name,
            expression: f.expression,
            group: f.group,
            cached_table,
        })
    }
}

impl Measure {
    /// Create a new measure from an expression.
    ///
    /// The fact table is inferred from the expression's qualified column
    /// references. Use `table[column]` syntax in expressions so the table
    /// can be determined automatically.
    pub fn new(name: impl Into<String>, expression: Expression) -> Self {
        let cached_table = infer_fact_table(&expression).unwrap_or_default();
        Self {
            name: name.into(),
            expression,
            group: None,
            cached_table,
        }
    }

    /// Create a simple aggregate measure: `AGG(table[column])`.
    ///
    /// Builds a qualified column reference internally so the fact table
    /// is embedded in the expression.
    pub fn simple(
        name: impl Into<String>,
        table: impl Into<String>,
        column: impl Into<String>,
        operation: AggregateOp,
    ) -> Self {
        let t = table.into();
        let c = column.into();
        Self::new(name, expr::agg(operation, expr::qualified_col(&t, &c)))
    }

    /// Set the measure group.
    pub fn with_group(mut self, group: impl Into<String>) -> Self {
        self.group = Some(group.into());
        self
    }

    /// Returns the measure name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the table this measure operates on.
    ///
    /// Inferred from qualified column references in the expression at
    /// construction time.
    pub fn table(&self) -> &str {
        &self.cached_table
    }

    /// Returns the expression tree.
    pub fn expression(&self) -> &Expression {
        &self.expression
    }

    /// Returns the measure group name, if any.
    pub fn group(&self) -> Option<&str> {
        self.group.as_deref()
    }

    /// Returns `true` if this is a simple `AGG(column)` measure that can
    /// be pushed down to a data source.
    pub fn is_simple_aggregate(&self) -> bool {
        self.expression.is_simple_aggregate()
    }

    /// If this is a simple aggregate, returns the column name.
    ///
    /// For backward compatibility with code that expects `measure.column()`.
    pub fn simple_column(&self) -> Option<&str> {
        self.expression.as_simple_aggregate().map(|(_, col)| col)
    }

    /// If this is a simple aggregate, returns the aggregation operation.
    ///
    /// For backward compatibility with code that expects `measure.operation()`.
    pub fn simple_operation(&self) -> Option<AggregateOp> {
        self.expression.as_simple_aggregate().map(|(op, _)| op)
    }

    /// Returns all column names referenced by this measure's expression.
    pub fn column_references(&self) -> Vec<&str> {
        self.expression.column_references()
    }
}

/// A named group of related measures.
///
/// Measure groups are organizational — they do not affect computation.
/// They allow host applications to present measures in logical categories.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeasureGroup {
    name: String,
    description: Option<String>,
}

impl MeasureGroup {
    /// Create a new measure group.
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            description: None,
        }
    }

    /// Create a measure group with a description.
    pub fn with_description(name: impl Into<String>, description: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            description: Some(description.into()),
        }
    }

    /// Returns the group name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the description, if any.
    pub fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }
}

// --- Convenience constructors ---

/// Create a SUM measure.
pub fn sum_measure(
    name: impl Into<String>,
    table: impl Into<String>,
    column: impl Into<String>,
) -> Measure {
    Measure::simple(name, table, column, AggregateOp::Sum)
}

/// Create a COUNT measure.
pub fn count_measure(
    name: impl Into<String>,
    table: impl Into<String>,
    column: impl Into<String>,
) -> Measure {
    Measure::simple(name, table, column, AggregateOp::Count)
}

/// Create an AVERAGE measure.
pub fn average_measure(
    name: impl Into<String>,
    table: impl Into<String>,
    column: impl Into<String>,
) -> Measure {
    Measure::simple(name, table, column, AggregateOp::Average)
}

/// Create a DISTINCT COUNT measure.
pub fn distinct_count_measure(
    name: impl Into<String>,
    table: impl Into<String>,
    column: impl Into<String>,
) -> Measure {
    Measure::simple(name, table, column, AggregateOp::DistinctCount)
}

/// Create a measure from an arbitrary expression.
///
/// The expression should contain at least one `Aggregate` node and
/// use qualified column references (`table[column]`) so the fact table
/// can be inferred.
pub fn expression_measure(name: impl Into<String>, expression: Expression) -> Measure {
    Measure::new(name, expression)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sum_measure_is_simple_aggregate() {
        let m = sum_measure("Total", "Sales", "amount");
        assert!(m.is_simple_aggregate());
        assert_eq!(m.simple_column(), Some("amount"));
        assert_eq!(m.simple_operation(), Some(AggregateOp::Sum));
        assert_eq!(m.table(), "Sales");
    }

    #[test]
    fn expression_measure_is_not_simple() {
        let m = expression_measure(
            "Revenue",
            expr::agg(
                AggregateOp::Sum,
                expr::qualified_col("Sales", "price")
                    .multiply(expr::qualified_col("Sales", "quantity")),
            ),
        );
        assert!(!m.is_simple_aggregate());
        assert_eq!(m.simple_column(), None);
        assert_eq!(m.simple_operation(), None);
        assert_eq!(m.table(), "Sales");
    }

    #[test]
    fn ratio_measure_is_not_simple() {
        let m = expression_measure(
            "AvgOrder",
            expr::agg(AggregateOp::Sum, expr::qualified_col("Sales", "amount"))
                .divide(expr::agg(AggregateOp::Count, expr::qualified_col("Sales", "id"))),
        );
        assert!(!m.is_simple_aggregate());
        assert_eq!(m.column_references(), vec!["amount", "id"]);
        assert_eq!(m.table(), "Sales");
    }

    #[test]
    fn measure_with_group() {
        let m = sum_measure("Total", "Sales", "amount").with_group("Financial");
        assert_eq!(m.group(), Some("Financial"));
    }

    #[test]
    fn measure_without_group() {
        let m = sum_measure("Total", "Sales", "amount");
        assert_eq!(m.group(), None);
    }

    #[test]
    fn column_references_for_simple_measure() {
        let m = sum_measure("Total", "Sales", "amount");
        assert_eq!(m.column_references(), vec!["amount"]);
    }

    #[test]
    fn column_references_for_expression_measure() {
        let m = expression_measure(
            "Revenue",
            expr::agg(
                AggregateOp::Sum,
                expr::qualified_col("Sales", "price")
                    .multiply(expr::qualified_col("Sales", "quantity")),
            ),
        );
        assert_eq!(m.column_references(), vec!["price", "quantity"]);
    }

    #[test]
    fn serialize_roundtrip() {
        let m = sum_measure("Total", "Sales", "amount");
        let json = serde_json::to_string(&m).unwrap();
        let restored: Measure = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.name(), "Total");
        assert_eq!(restored.table(), "Sales");
        assert!(restored.is_simple_aggregate());
    }
}
