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
    /// When set, this column is a GENERATED parent-child path
    /// (`PATH(t[id], t[parent])`): a `|`-separated root-first id chain per
    /// row, computed in Rust during materialization (a recursive walk that
    /// row-level SQL cannot express). The `expression` then holds a
    /// placeholder `Blank`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    path: Option<PathSpec>,
    /// When set, this column is machinery GENERATED from another model entity
    /// (the value is that entity's id — today: a writeback column). Generated
    /// columns are re-synthesized idempotently at model build, excluded from
    /// editor listings, and never user-deletable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    generated_by: Option<String>,
}

/// The id/parent columns of a `PATH(...)` calculated column. Both must be
/// physical columns on the host table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathSpec {
    /// The row-identifier column.
    pub id_column: String,
    /// The parent-identifier column (NULL = root).
    pub parent_column: String,
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
            path: None,
            generated_by: None,
        }
    }

    /// Create a generated parent-child PATH column (`PATH(t[id], t[parent])`).
    /// Always `String`-typed; computed in Rust during materialization.
    pub fn new_path(
        name: impl Into<String>,
        table: impl Into<String>,
        id_column: impl Into<String>,
        parent_column: impl Into<String>,
    ) -> Self {
        Self {
            name: name.into(),
            table: table.into(),
            expression: Expression::Blank,
            data_type: DataType::String,
            path: Some(PathSpec {
                id_column: id_column.into(),
                parent_column: parent_column.into(),
            }),
            generated_by: None,
        }
    }

    /// Mark this column as machinery generated from another model entity
    /// (see the `generated_by` field).
    pub fn with_generated_by(mut self, entity_id: impl Into<String>) -> Self {
        self.generated_by = Some(entity_id.into());
        self
    }

    /// The id of the model entity this column was generated from, when it is
    /// synthesized machinery (today: a writeback column's id).
    pub fn generated_by(&self) -> Option<&str> {
        self.generated_by.as_deref()
    }

    /// The PATH spec, when this is a generated parent-child path column.
    pub fn path(&self) -> Option<&PathSpec> {
        self.path.as_ref()
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
