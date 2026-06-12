//! Column definition for the data model.

use serde::{Deserialize, Serialize};

use crate::types::DataType;

/// A column definition within a table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Column {
    name: String,
    data_type: DataType,
    nullable: bool,
    /// Optional resolution expression for when this column is used as a lookup
    /// (post-aggregation) instead of a GROUP BY column.
    ///
    /// When a column appears as a lookup in a query, the join back to the
    /// dimension table may produce multiple rows per key (1:many). This
    /// expression controls how those multiple values are resolved into a
    /// single value. Uses the same expression syntax as measures.
    ///
    /// Examples: `"MIN(col)"`, `"IF(DISTINCTCOUNT(col) > 1, \"*\", MIN(col))"`
    ///
    /// If `None`, the model-level `default_lookup_resolution` is used when
    /// set (it references the lookup column via the `__column` placeholder).
    /// Otherwise the built-in fallback applies: for `String` columns,
    /// SELECTEDVALUE-style semantics
    /// (`CASE WHEN COUNT(DISTINCT col) = 1 THEN MIN(col) ELSE '#' END`);
    /// for all other column types, `MIN(col)`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    lookup_resolution: Option<String>,
    /// Optional column name used for sorting this column's values.
    ///
    /// When this column appears in a GROUP BY or on a pivot table axis,
    /// results should be ordered by the sort-by column instead of by this
    /// column's own values. Both columns must belong to the same table.
    ///
    /// Classic example: a "MonthName" column sorted by a "MonthNumber" column
    /// so that month names appear in calendar order rather than alphabetical.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sort_by_column: Option<String>,
}

impl Column {
    /// Create a new column definition.
    pub fn new(name: impl Into<String>, data_type: DataType) -> Self {
        Self {
            name: name.into(),
            data_type,
            nullable: true,
            lookup_resolution: None,
            sort_by_column: None,
        }
    }

    /// Create a non-nullable column.
    pub fn non_nullable(name: impl Into<String>, data_type: DataType) -> Self {
        Self {
            name: name.into(),
            data_type,
            nullable: false,
            lookup_resolution: None,
            sort_by_column: None,
        }
    }

    /// Set the lookup resolution expression for this column.
    ///
    /// When this column is used as a lookup (post-aggregation) in a query,
    /// this expression controls how 1:many values are resolved.
    /// Uses the same expression syntax as measures.
    pub fn with_lookup_resolution(mut self, expr: impl Into<String>) -> Self {
        self.lookup_resolution = Some(expr.into());
        self
    }

    /// Returns the lookup resolution expression, if set.
    pub fn lookup_resolution(&self) -> Option<&str> {
        self.lookup_resolution.as_deref()
    }

    /// Set the sort-by column for this column.
    ///
    /// When this column appears in a GROUP BY or on a pivot table axis,
    /// results should be ordered by the named column instead. Both columns
    /// must belong to the same table (validated at model build time).
    pub fn with_sort_by(mut self, column: impl Into<String>) -> Self {
        self.sort_by_column = Some(column.into());
        self
    }

    /// Returns the sort-by column name, if set.
    pub fn sort_by_column(&self) -> Option<&str> {
        self.sort_by_column.as_deref()
    }

    /// Returns the column name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the column data type.
    pub fn data_type(&self) -> &DataType {
        &self.data_type
    }

    /// Returns whether this column accepts null values.
    pub fn nullable(&self) -> bool {
        self.nullable
    }
}
