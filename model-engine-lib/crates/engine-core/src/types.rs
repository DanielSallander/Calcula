//! Shared type definitions for the engine.

use arrow::datatypes::DataType as ArrowDataType;
use serde::{Deserialize, Serialize};

/// Column data types supported by the engine, each mapping to a specific Arrow type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DataType {
    /// 32-bit signed integer.
    Int32,
    /// 64-bit signed integer.
    Int64,
    /// 64-bit floating point.
    Float64,
    /// Decimal with precision and scale.
    Decimal(u8, i8),
    /// UTF-8 string.
    String,
    /// Boolean.
    Boolean,
    /// Date (days since epoch).
    Date,
    /// Timestamp (microseconds since epoch).
    Timestamp,
}

impl DataType {
    /// Returns `true` if SQL filter values for this type need single-quote wrapping.
    ///
    /// Numeric types (`Int32`, `Int64`, `Float64`, `Decimal`) and `Boolean` are
    /// rendered as bare literals in SQL. String, Date, and Timestamp values
    /// require single quotes.
    pub fn needs_sql_quoting(&self) -> bool {
        match self {
            DataType::Int32
            | DataType::Int64
            | DataType::Float64
            | DataType::Decimal(_, _)
            | DataType::Boolean => false,
            DataType::String | DataType::Date | DataType::Timestamp => true,
        }
    }

    /// Convert to the corresponding Arrow data type.
    pub fn to_arrow(&self) -> ArrowDataType {
        match self {
            DataType::Int32 => ArrowDataType::Int32,
            DataType::Int64 => ArrowDataType::Int64,
            DataType::Float64 => ArrowDataType::Float64,
            DataType::Decimal(precision, scale) => ArrowDataType::Decimal128(*precision, *scale),
            DataType::String => ArrowDataType::Utf8,
            DataType::Boolean => ArrowDataType::Boolean,
            DataType::Date => ArrowDataType::Date32,
            DataType::Timestamp => {
                ArrowDataType::Timestamp(arrow::datatypes::TimeUnit::Microsecond, None)
            }
        }
    }
}

/// A scalar value that can be stored in a column.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Value {
    /// Null / missing value.
    Null,
    /// 32-bit integer.
    Int32(i32),
    /// 64-bit integer.
    Int64(i64),
    /// 64-bit float.
    Float64(f64),
    /// Decimal stored as i128 with precision and scale.
    Decimal(i128, u8, i8),
    /// UTF-8 string.
    String(String),
    /// Boolean.
    Boolean(bool),
    /// Date as days since epoch.
    Date(i32),
    /// Timestamp as microseconds since epoch.
    Timestamp(i64),
}

impl Value {
    /// Returns true if this value is null.
    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }
}

/// A reference to a column within a specific table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableColumn {
    /// Table name.
    pub table: String,
    /// Column name.
    pub column: String,
}

impl TableColumn {
    /// Create a new table-column reference.
    pub fn new(table: impl Into<String>, column: impl Into<String>) -> Self {
        Self {
            table: table.into(),
            column: column.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numeric_types_do_not_need_quoting() {
        assert!(!DataType::Int32.needs_sql_quoting());
        assert!(!DataType::Int64.needs_sql_quoting());
        assert!(!DataType::Float64.needs_sql_quoting());
        assert!(!DataType::Decimal(10, 2).needs_sql_quoting());
        assert!(!DataType::Boolean.needs_sql_quoting());
    }

    #[test]
    fn string_and_temporal_types_need_quoting() {
        assert!(DataType::String.needs_sql_quoting());
        assert!(DataType::Date.needs_sql_quoting());
        assert!(DataType::Timestamp.needs_sql_quoting());
    }
}
