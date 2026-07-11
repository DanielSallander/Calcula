//! Calculated columns — virtual columns computed from expressions.
//!
//! A calculated column is defined over a single table and produces a new
//! column by evaluating an expression row-by-row. The expression must not
//! contain aggregate nodes (those belong in measures).

use serde::{Deserialize, Serialize};

use crate::compute::expression::Expression;
use crate::types::DataType;

/// A virtual column computed from an expression over existing columns.
///
/// Calculated columns are defined in the data model and materialized on
/// demand when a measure or query references them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalculatedColumn {
    /// Name of the virtual column.
    name: String,
    /// The table this calculated column belongs to.
    table: String,
    /// The expression to compute (must be row-level — no aggregates).
    expression: Expression,
    /// The resulting data type.
    data_type: DataType,
}

impl CalculatedColumn {
    /// Create a new calculated column definition.
    ///
    /// The expression must not contain aggregate nodes. Validation is
    /// performed by the `DataModelBuilder` at build time.
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
        }
    }

    /// Returns the column name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the table this column belongs to.
    pub fn table(&self) -> &str {
        &self.table
    }

    /// Returns the expression.
    pub fn expression(&self) -> &Expression {
        &self.expression
    }

    /// Returns the data type of the computed column.
    pub fn data_type(&self) -> &DataType {
        &self.data_type
    }

    /// Returns `true` when the row expression reads OTHER tables —
    /// RELATED-style qualified references to a related table or
    /// `LOOKUPVALUE` targets. Such columns need JOINs to materialize and are
    /// handled by the query pipeline's joined second pass; the single-batch
    /// materializer skips them.
    pub fn is_cross_table(&self) -> bool {
        !self.expression.lookup_values().is_empty()
            || self
                .expression
                .qualified_column_references()
                .iter()
                .any(|(t, _)| !t.eq_ignore_ascii_case(&self.table))
    }
}
