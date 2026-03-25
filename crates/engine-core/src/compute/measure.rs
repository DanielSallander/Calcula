//! Measure definitions — named aggregation expressions over the data model.
//!
//! Measures are the primary computation unit in the engine. Each measure
//! is an expression tree that must contain at least one aggregate node.
//! Simple measures like `SUM(amount)` can be pushed down to data sources;
//! complex expression measures like `SUM(price * qty)` or
//! `SUM(revenue) / COUNT(orders)` are computed locally.

use serde::{Deserialize, Serialize};

use crate::compute::aggregate::AggregateOp;
use crate::compute::expression::{self as expr, Expression};

/// A named measure: a reusable aggregation expression over a table.
///
/// Measures are defined as expression trees that contain aggregate nodes.
/// The simplest form is `AGG(column)`, but measures can also be
/// expressions over aggregates like `SUM(price * quantity)` or
/// `SUM(revenue) / COUNT(orders)`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Measure {
    name: String,
    table: String,
    expression: Expression,
    group: Option<String>,
}

impl Measure {
    /// Create a new measure from an expression.
    pub fn new(name: impl Into<String>, table: impl Into<String>, expression: Expression) -> Self {
        Self {
            name: name.into(),
            table: table.into(),
            expression,
            group: None,
        }
    }

    /// Create a simple aggregate measure: `AGG(column)`.
    pub fn simple(
        name: impl Into<String>,
        table: impl Into<String>,
        column: impl Into<String>,
        operation: AggregateOp,
    ) -> Self {
        Self::new(name, table, expr::agg(operation, expr::col(&column.into())))
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
    pub fn table(&self) -> &str {
        &self.table
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
/// The expression should contain at least one `Aggregate` node.
pub fn expression_measure(
    name: impl Into<String>,
    table: impl Into<String>,
    expression: Expression,
) -> Measure {
    Measure::new(name, table, expression)
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
    }

    #[test]
    fn expression_measure_is_not_simple() {
        let m = expression_measure(
            "Revenue",
            "Sales",
            expr::agg(
                AggregateOp::Sum,
                expr::col("price").multiply(expr::col("quantity")),
            ),
        );
        assert!(!m.is_simple_aggregate());
        assert_eq!(m.simple_column(), None);
        assert_eq!(m.simple_operation(), None);
    }

    #[test]
    fn ratio_measure_is_not_simple() {
        let m = expression_measure(
            "AvgOrder",
            "Sales",
            expr::agg(AggregateOp::Sum, expr::col("amount"))
                .divide(expr::agg(AggregateOp::Count, expr::col("id"))),
        );
        assert!(!m.is_simple_aggregate());
        assert_eq!(m.column_references(), vec!["amount", "id"]);
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
            "Sales",
            expr::agg(
                AggregateOp::Sum,
                expr::col("price").multiply(expr::col("quantity")),
            ),
        );
        assert_eq!(m.column_references(), vec!["price", "quantity"]);
    }
}
