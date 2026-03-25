//! Query request types — the user-facing description of what to compute.

use engine_connectors::FilterCondition;

/// A reference to a specific column in a table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColumnRef {
    /// Table name as it appears in the data model.
    pub table: String,
    /// Column name.
    pub column: String,
}

impl ColumnRef {
    /// Create a new column reference.
    pub fn new(table: impl Into<String>, column: impl Into<String>) -> Self {
        Self {
            table: table.into(),
            column: column.into(),
        }
    }
}

/// A column to look up post-aggregation instead of grouping by.
///
/// When a query uses lookup columns, they are not included in the GROUP BY
/// clause. Instead, after aggregation, the engine joins back to the dimension
/// table and resolves the lookup column using the column's resolution
/// expression (or `MIN(column)` by default).
#[derive(Debug, Clone)]
pub struct LookupColumn {
    /// Table name containing the lookup column.
    pub table: String,
    /// Column name to look up.
    pub column: String,
    /// Key column to join on. If `None`, auto-inferred from `group_by`
    /// columns in the same table (must be exactly one).
    pub key_column: Option<String>,
}

impl LookupColumn {
    /// Create a new lookup column with auto-inferred key.
    pub fn new(table: impl Into<String>, column: impl Into<String>) -> Self {
        Self {
            table: table.into(),
            column: column.into(),
            key_column: None,
        }
    }

    /// Create a new lookup column with an explicit key column.
    pub fn with_key(
        table: impl Into<String>,
        column: impl Into<String>,
        key_column: impl Into<String>,
    ) -> Self {
        Self {
            table: table.into(),
            column: column.into(),
            key_column: Some(key_column.into()),
        }
    }
}

/// A request to compute measures, optionally grouped by dimensions and filtered.
///
/// This is the primary input to the query planner. Measures and dimensions
/// reference names defined in the `DataModel`.
#[derive(Debug, Clone)]
pub struct QueryRequest {
    /// Measure names to compute (must exist in the `DataModel`).
    pub measures: Vec<String>,
    /// Dimension columns to group by.
    pub group_by: Vec<ColumnRef>,
    /// Filter conditions to apply.
    pub filters: Vec<FilterCondition>,
    /// Columns to look up post-aggregation instead of grouping by.
    ///
    /// These columns are NOT in `group_by`. After aggregation, the engine
    /// joins back to the dimension table and resolves each lookup column
    /// using its resolution expression (from the model) or `MIN(column)`
    /// by default.
    pub lookups: Vec<LookupColumn>,
}
