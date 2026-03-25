//! Global variables: model-level named expressions reusable across measures.
//!
//! A global variable stores a named expression (scalar or table-producing)
//! at the data model level. Measures can reference global variables directly,
//! enabling expression reuse without duplicating VAR/RETURN blocks.
//!
//! # Examples
//!
//! **Scalar global** — reusable aggregate sub-expression:
//! ```text
//! GlobalVariable { name: "total_revenue", table: "fact_sales",
//!     expression: SUM(fact_sales[linetotal]) }
//! ```
//!
//! **Table global** — reusable QUERY expression:
//! ```text
//! GlobalVariable { name: "city_sales", table: "fact_sales",
//!     expression: QUERY(SUM(fact_sales[linetotal]) AS Amount BY dim_customer[city]) }
//! ```
//!
//! Measures reference these directly:
//! ```text
//! AVG(city_sales[Amount])          -- table global via QualifiedColumnRef
//! total_revenue / COUNTROWS(...)   -- scalar global via ColumnRef
//! ```

use serde::{Deserialize, Serialize};

use crate::compute::expression::Expression;

/// A model-level named expression that can be reused across measures.
///
/// Global variables are expanded into measure expressions before evaluation.
/// Scalar globals are substituted inline; table (QUERY) globals are injected
/// as VAR bindings in an implicit `Block`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobalVariable {
    /// Unique name for this global variable.
    name: String,
    /// The fact table this variable operates on.
    table: String,
    /// The expression — can be a scalar aggregate or a `Query` (table-producing).
    expression: Expression,
}

impl GlobalVariable {
    /// Create a new global variable.
    pub fn new(name: impl Into<String>, table: impl Into<String>, expression: Expression) -> Self {
        Self {
            name: name.into(),
            table: table.into(),
            expression,
        }
    }

    /// Returns the variable name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the fact table this variable operates on.
    pub fn table(&self) -> &str {
        &self.table
    }

    /// Returns the expression.
    pub fn expression(&self) -> &Expression {
        &self.expression
    }

    /// Returns `true` if this is a table-producing (QUERY) variable.
    pub fn is_query(&self) -> bool {
        matches!(self.expression, Expression::Query { .. })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute::aggregate::AggregateOp;

    #[test]
    fn scalar_global_variable() {
        let expr = Expression::Aggregate {
            operation: AggregateOp::Sum,
            operand: Box::new(Expression::ColumnRef("linetotal".into())),
        };
        let gv = GlobalVariable::new("total_revenue", "fact_sales", expr.clone());

        assert_eq!(gv.name(), "total_revenue");
        assert_eq!(gv.table(), "fact_sales");
        assert!(matches!(gv.expression(), Expression::Aggregate { .. }));
        assert!(!gv.is_query());
    }

    #[test]
    fn query_global_variable() {
        let expr = Expression::Query {
            aggregates: vec![(
                Expression::Aggregate {
                    operation: AggregateOp::Sum,
                    operand: Box::new(Expression::ColumnRef("linetotal".into())),
                },
                "Amount".into(),
            )],
            group_by: vec![("dim_customer".into(), "city".into())],
        };
        let gv = GlobalVariable::new("city_sales", "fact_sales", expr);

        assert!(gv.is_query());
    }

    #[test]
    fn serde_roundtrip() {
        let expr = Expression::Aggregate {
            operation: AggregateOp::Sum,
            operand: Box::new(Expression::ColumnRef("amount".into())),
        };
        let gv = GlobalVariable::new("rev", "sales", expr);

        let json = serde_json::to_string(&gv).unwrap();
        let restored: GlobalVariable = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.name(), "rev");
        assert_eq!(restored.table(), "sales");
        assert!(!restored.is_query());
    }
}
