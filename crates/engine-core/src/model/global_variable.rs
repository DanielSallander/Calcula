//! Calculated tables: model-level named QUERY expressions reusable across
//! measures (user-facing term: "Calculated Table"; this struct keeps its
//! historical name).
//!
//! A calculated table stores a named table-producing `QUERY(...)` expression
//! at the data model level. Measures reference its output columns directly,
//! and the expression is evaluated dynamically in the referencing query's
//! filter context:
//! ```text
//! GlobalVariable { name: "city_sales", table: "fact_sales",
//!     expression: QUERY(SUM(fact_sales[linetotal]) AS Amount BY dim_customer[city]) }
//!
//! AVG(city_sales[Amount])   -- referenced via QualifiedColumnRef
//! ```
//!
//! Only `Query` expressions are valid; the model builder and [`parse_global`]
//! (crate::compute::parser::parse_global) reject anything else. Scalar
//! globals were removed 2026-07-11: a reusable scalar is a (hidden) measure
//! (see Calcula's docs/design/calculated-tables.md).

use serde::{Deserialize, Serialize};

use crate::compute::expression::Expression;

/// A model-level named `QUERY(...)` expression reusable across measures
/// (a "calculated table").
///
/// Referenced as `name[column]`; expanded into referencing measures as a VAR
/// binding in an implicit `Block` before evaluation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobalVariable {
    /// Unique name for this calculated table.
    name: String,
    /// The fact table this calculated table operates on.
    table: String,
    /// The table-producing `Query` expression. Non-`Query` expressions are
    /// representable here (it is plain data) but rejected by validation.
    expression: Expression,
}

impl GlobalVariable {
    /// Create a new calculated table.
    pub fn new(name: impl Into<String>, table: impl Into<String>, expression: Expression) -> Self {
        Self {
            name: name.into(),
            table: table.into(),
            expression,
        }
    }

    /// Returns the calculated table's name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the fact table this calculated table operates on.
    pub fn table(&self) -> &str {
        &self.table
    }

    /// Returns the expression.
    pub fn expression(&self) -> &Expression {
        &self.expression
    }

    /// Returns `true` if the expression is a table-producing `Query` — the
    /// only valid form; validation rejects anything else.
    pub fn is_query(&self) -> bool {
        matches!(self.expression, Expression::Query { .. })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute::aggregate::AggregateOp;

    #[test]
    fn non_query_expression_is_representable_but_flagged() {
        // The struct is plain data — a non-Query expression can be held, but
        // is_query() is false and the model builder rejects it.
        let expr = Expression::Aggregate {
            operation: AggregateOp::Sum,
            operand: Box::new(Expression::ColumnRef("linetotal".into())),
        };
        let gv = GlobalVariable::new("total_revenue", "fact_sales", expr.clone());

        assert_eq!(gv.name(), "total_revenue");
        assert_eq!(gv.table(), "fact_sales");
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
        let expr = Expression::Query {
            aggregates: vec![(
                Expression::Aggregate {
                    operation: AggregateOp::Sum,
                    operand: Box::new(Expression::ColumnRef("amount".into())),
                },
                "Amt".into(),
            )],
            group_by: vec![("dim".into(), "city".into())],
        };
        let gv = GlobalVariable::new("rev", "sales", expr);

        let json = serde_json::to_string(&gv).unwrap();
        let restored: GlobalVariable = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.name(), "rev");
        assert_eq!(restored.table(), "sales");
        assert!(restored.is_query());
    }
}
