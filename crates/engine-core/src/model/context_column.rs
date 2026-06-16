//! Context-driven calculated columns — groupable attributes computed per query.
//!
//! A [`ContextColumn`] looks like a [`CalculatedColumn`](super::CalculatedColumn):
//! it is defined over a single table and produces a row-level value. The
//! difference is that its expression may reference a **scalar measure** (an
//! [`Expression::MeasureRef`]), which is resolved to a single value *per query*
//! from the query's filter context and then substituted as a literal. The
//! column is therefore a function of both the row and the query — a "dynamic
//! segmentation" axis whose buckets re-derive from the slicers.
//!
//! Example: a payment-status flag that is `Paid` or `Open` relative to an
//! as-of date taken from the date slicer —
//!
//! ```text
//! PaymentStatus = IF(Invoice[paid_date] <= [AsOfDate], "Paid", "Open")
//! ```
//!
//! where `[AsOfDate] = MAX(Calendar[date])` resolves under the query filters.
//!
//! The scalar is resolved **only from the filters**, never from the grouping
//! the column itself defines (it is evaluated ungrouped over the filtered
//! source), so the definition can never be circular. The expression must be
//! row-level apart from its measure references: aggregates and context
//! operations outside a `MeasureRef` are rejected at model build time. See the
//! `DataModelBuilder` validation step and the host-integration changelog for
//! the full v1 contract.

use serde::{Deserialize, Serialize};

use crate::compute::expression::Expression;
use crate::types::DataType;

/// A groupable column whose row-level value is computed per query from a
/// scalar measure resolved against the query's filter context.
///
/// Unlike a [`CalculatedColumn`](super::CalculatedColumn) — which is row-local
/// and refresh-static and may not reference measures — a `ContextColumn`'s
/// expression may contain [`Expression::MeasureRef`] nodes that resolve to one
/// scalar per query. After that substitution the column is an ordinary
/// row-level expression and is rendered as a `GROUP BY` key.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextColumn {
    /// Name of the column (unique within the model; must not collide with a
    /// physical or calculated column on its table).
    name: String,
    /// The table this column is defined on. The column groups rows of this
    /// table; the row-level part of its expression references this table's
    /// columns.
    table: String,
    /// The row-level expression. May contain [`Expression::MeasureRef`] nodes
    /// (each resolved to a scalar per query) but no aggregates or context
    /// operations outside those references.
    expression: Expression,
    /// The resulting data type (the type of the column's per-row value).
    data_type: DataType,
    /// Optional host-facing description, surfaced in result-column metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
}

impl ContextColumn {
    /// Create a new context-driven calculated column.
    ///
    /// Validation (row-level expression, existing measure/column references,
    /// no name collision) is performed by the `DataModelBuilder` at build time.
    pub fn new(
        name: impl Into<String>,
        table: impl Into<String>,
        expression: Expression,
        data_type: DataType,
    ) -> Self {
        Self {
            name: name.into(),
            table: table.into(),
            expression,
            data_type,
            description: None,
        }
    }

    /// Set the column's host-facing description.
    #[must_use]
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Returns the column name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the table this column is defined on.
    pub fn table(&self) -> &str {
        &self.table
    }

    /// Returns the row-level expression (with unresolved measure references).
    pub fn expression(&self) -> &Expression {
        &self.expression
    }

    /// Returns the data type of the computed column.
    pub fn data_type(&self) -> &DataType {
        &self.data_type
    }

    /// Returns the optional description.
    pub fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute::aggregate::AggregateOp;
    use crate::compute::expression::{
        agg, compare, if_expr, keep, lit_str, qualified_col, ComparisonOp, FilterPredicate,
    };
    use crate::compute::measure::{sum_measure, Measure};
    use crate::error::EngineError;
    use crate::model::{Column, DataModel, Relationship, Table};
    use crate::types::DataType;

    /// A model with `Invoice(paid_date, amount)` + `Calendar(date)`, a
    /// `Revenue` measure and an `AsOfDate = MAX(Calendar[date])` measure, plus
    /// the given context columns.
    fn model_with_context_columns(
        cols: Vec<ContextColumn>,
    ) -> crate::error::EngineResult<DataModel> {
        let mut b = DataModel::builder()
            .add_table(
                Table::new(
                    "Invoice",
                    vec![
                        Column::new("paid_date", DataType::Date),
                        Column::new("amount", DataType::Float64),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new("Calendar", vec![Column::new("date", DataType::Date)]).unwrap(),
            )
            .add_measure(sum_measure("Revenue", "Invoice", "amount"))
            .add_measure(Measure::new(
                "AsOfDate",
                agg(AggregateOp::Max, qualified_col("Calendar", "date")),
            ));
        for c in cols {
            b = b.add_context_column(c);
        }
        b.build()
    }

    /// `IF(Invoice[paid_date] <= [AsOfDate], "Paid", "Open")`.
    fn payment_status_expr() -> Expression {
        if_expr(
            compare(
                qualified_col("Invoice", "paid_date"),
                ComparisonOp::LessThanOrEqual,
                Expression::MeasureRef("AsOfDate".into()),
            ),
            lit_str("Paid"),
            lit_str("Open"),
        )
    }

    #[test]
    fn valid_context_column_is_accepted_and_accessible() {
        let cc = ContextColumn::new(
            "PaymentStatus",
            "Invoice",
            payment_status_expr(),
            DataType::String,
        )
        .with_description("Paid/Open as of the slicer date");
        let model = model_with_context_columns(vec![cc]).unwrap();
        assert_eq!(model.context_columns().len(), 1);
        let c = model.context_column("PaymentStatus").unwrap();
        assert_eq!(c.table(), "Invoice");
        assert_eq!(c.description(), Some("Paid/Open as of the slicer date"));
        assert_eq!(model.context_columns_for_table("Invoice").len(), 1);
        assert_eq!(model.context_columns_for_table("Calendar").len(), 0);
        assert!(model.context_column("missing").is_none());
    }

    #[test]
    fn bare_aggregate_is_rejected() {
        // An aggregate directly in the column (not inside a measure) is not
        // row-level.
        let cc = ContextColumn::new(
            "Total",
            "Invoice",
            agg(AggregateOp::Sum, qualified_col("Invoice", "amount")),
            DataType::Float64,
        );
        let err = model_with_context_columns(vec![cc]).unwrap_err();
        assert!(
            matches!(err, EngineError::InvalidContextColumn { .. }),
            "got: {err:?}"
        );
    }

    #[test]
    fn context_operation_is_rejected() {
        let cc = ContextColumn::new(
            "Flag",
            "Invoice",
            keep(
                qualified_col("Invoice", "amount"),
                vec![FilterPredicate::new(
                    "Invoice",
                    "amount",
                    ComparisonOp::GreaterThan,
                    "0",
                )],
            ),
            DataType::Float64,
        );
        let err = model_with_context_columns(vec![cc]).unwrap_err();
        assert!(
            matches!(err, EngineError::InvalidContextColumn { .. }),
            "got: {err:?}"
        );
    }

    #[test]
    fn unknown_measure_reference_is_rejected() {
        let cc = ContextColumn::new(
            "Flag",
            "Invoice",
            if_expr(
                compare(
                    qualified_col("Invoice", "paid_date"),
                    ComparisonOp::LessThanOrEqual,
                    Expression::MeasureRef("Nope".into()),
                ),
                lit_str("Paid"),
                lit_str("Open"),
            ),
            DataType::String,
        );
        let err = model_with_context_columns(vec![cc]).unwrap_err();
        assert!(
            matches!(err, EngineError::InvalidContextColumn { .. }),
            "got: {err:?}"
        );
    }

    #[test]
    fn name_collision_with_physical_column_is_rejected() {
        let cc = ContextColumn::new("amount", "Invoice", payment_status_expr(), DataType::String);
        let err = model_with_context_columns(vec![cc]).unwrap_err();
        assert!(
            matches!(err, EngineError::InvalidContextColumn { .. }),
            "got: {err:?}"
        );
    }

    #[test]
    fn unknown_column_reference_is_rejected() {
        let cc = ContextColumn::new(
            "Flag",
            "Invoice",
            if_expr(
                compare(
                    qualified_col("Invoice", "nonexistent"),
                    ComparisonOp::LessThanOrEqual,
                    Expression::MeasureRef("AsOfDate".into()),
                ),
                lit_str("Paid"),
                lit_str("Open"),
            ),
            DataType::String,
        );
        let err = model_with_context_columns(vec![cc]).unwrap_err();
        assert!(
            matches!(err, EngineError::ExpressionColumnNotFound { .. }),
            "got: {err:?}"
        );
    }

    #[test]
    fn duplicate_context_column_name_is_rejected() {
        let a =
            ContextColumn::new("PaymentStatus", "Invoice", payment_status_expr(), DataType::String);
        let b =
            ContextColumn::new("PaymentStatus", "Invoice", payment_status_expr(), DataType::String);
        let err = model_with_context_columns(vec![a, b]).unwrap_err();
        assert!(matches!(err, EngineError::DuplicateName(_)), "got: {err:?}");
    }

    #[test]
    fn cross_table_qualified_reference_is_rejected() {
        // The row-level expression may reference only the host table's columns.
        // A reference to another table (here Calendar) is rejected in v1.
        let cc = ContextColumn::new(
            "Flag",
            "Invoice",
            if_expr(
                compare(
                    qualified_col("Calendar", "date"),
                    ComparisonOp::LessThanOrEqual,
                    Expression::MeasureRef("AsOfDate".into()),
                ),
                lit_str("Paid"),
                lit_str("Open"),
            ),
            DataType::String,
        );
        let err = model_with_context_columns(vec![cc]).unwrap_err();
        assert!(
            matches!(err, EngineError::InvalidContextColumn { .. }),
            "got: {err:?}"
        );
    }

    /// Invoice (paid_date, amount, customer_id) -> Customer (id, tier)
    /// ManyToOne, plus a disconnected Calendar (date), a Revenue + AsOfDate
    /// measure, and the given context columns.
    fn model_with_customer(cols: Vec<ContextColumn>) -> crate::error::EngineResult<DataModel> {
        let mut b = DataModel::builder()
            .add_table(
                Table::new(
                    "Invoice",
                    vec![
                        Column::new("paid_date", DataType::Date),
                        Column::new("amount", DataType::Float64),
                        Column::new("customer_id", DataType::Int64),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "Customer",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("tier", DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new("Calendar", vec![Column::new("date", DataType::Date)]).unwrap(),
            )
            .add_relationship(Relationship::many_to_one(
                "Invoice_Customer",
                "Invoice",
                "customer_id",
                "Customer",
                "id",
            ))
            .add_measure(sum_measure("Revenue", "Invoice", "amount"))
            .add_measure(Measure::new(
                "AsOfDate",
                agg(AggregateOp::Max, qualified_col("Calendar", "date")),
            ));
        for c in cols {
            b = b.add_context_column(c);
        }
        b.build()
    }

    /// `IF(Invoice[paid_date] <= [AsOfDate], Customer[tier], "Unpaid")`.
    fn paid_tier_expr() -> Expression {
        if_expr(
            compare(
                qualified_col("Invoice", "paid_date"),
                ComparisonOp::LessThanOrEqual,
                Expression::MeasureRef("AsOfDate".into()),
            ),
            qualified_col("Customer", "tier"),
            lit_str("Unpaid"),
        )
    }

    #[test]
    fn safe_cross_table_reference_is_accepted() {
        // Invoice (many) -> Customer (one): a context column on Invoice may
        // reference Customer[tier]; the join cannot inflate the fact.
        let cc = ContextColumn::new("PaidTier", "Invoice", paid_tier_expr(), DataType::String);
        let model = model_with_customer(vec![cc]);
        assert!(model.is_ok(), "got: {:?}", model.err());
    }

    #[test]
    fn unsafe_cross_table_reference_is_rejected() {
        // A context column on Customer (the ONE side) referencing Invoice (the
        // MANY side) would fan out — rejected.
        let cc = ContextColumn::new(
            "Bad",
            "Customer",
            if_expr(
                compare(
                    qualified_col("Invoice", "amount"),
                    ComparisonOp::GreaterThan,
                    Expression::LiteralFloat(0.0),
                ),
                lit_str("Has"),
                lit_str("None"),
            ),
            DataType::String,
        );
        let err = model_with_customer(vec![cc]).unwrap_err();
        assert!(
            matches!(err, EngineError::InvalidContextColumn { .. }),
            "got: {err:?}"
        );
    }

    #[test]
    fn context_column_may_reference_another_on_same_table() {
        // PaidFlag references the PaymentStatus context column — build accepts
        // it (a dependency, inlined at query time), not rejected as unknown.
        let a =
            ContextColumn::new("PaymentStatus", "Invoice", payment_status_expr(), DataType::String);
        let b = ContextColumn::new(
            "PaidFlag",
            "Invoice",
            if_expr(
                compare(
                    qualified_col("Invoice", "PaymentStatus"),
                    ComparisonOp::Equal,
                    lit_str("Paid"),
                ),
                lit_str("Y"),
                lit_str("N"),
            ),
            DataType::String,
        );
        let model = model_with_context_columns(vec![a, b]);
        assert!(model.is_ok(), "got: {:?}", model.err());
    }

    #[test]
    fn inline_context_column_refs_flattens_dependency() {
        let a =
            ContextColumn::new("PaymentStatus", "Invoice", payment_status_expr(), DataType::String);
        let b = ContextColumn::new(
            "PaidFlag",
            "Invoice",
            if_expr(
                compare(
                    qualified_col("Invoice", "PaymentStatus"),
                    ComparisonOp::Equal,
                    lit_str("Paid"),
                ),
                lit_str("Y"),
                lit_str("N"),
            ),
            DataType::String,
        );
        let model = model_with_context_columns(vec![a, b]).unwrap();
        let inlined = model
            .inline_context_column_refs(
                "Invoice",
                model.context_column("PaidFlag").unwrap().expression(),
                &mut vec!["paidflag".into()],
            )
            .unwrap();
        let cols = inlined.column_references();
        // The reference to PaymentStatus is gone; its physical input remains.
        assert!(cols.iter().any(|c| c.eq_ignore_ascii_case("paid_date")));
        assert!(!cols.iter().any(|c| c.eq_ignore_ascii_case("PaymentStatus")));
        // The referenced measure surfaces transitively.
        assert!(inlined
            .measure_references()
            .iter()
            .any(|m| m.eq_ignore_ascii_case("AsOfDate")));
    }

    #[test]
    fn case_insensitive_context_column_lookup() {
        let cc = ContextColumn::new(
            "PaymentStatus",
            "Invoice",
            payment_status_expr(),
            DataType::String,
        );
        let model = model_with_context_columns(vec![cc]).unwrap();
        // Resolvable regardless of the case used by the caller.
        assert!(model.context_column("paymentstatus").is_some());
        assert!(model.context_column("PAYMENTSTATUS").is_some());
        assert_eq!(model.context_columns_for_table("invoice").len(), 1);
    }
}
