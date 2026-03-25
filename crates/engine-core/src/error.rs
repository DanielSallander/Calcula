//! Engine error types.

use thiserror::Error;

/// Errors produced by the engine core.
#[derive(Debug, Error)]
pub enum EngineError {
    /// A referenced table was not found in the data model.
    #[error("Table '{0}' not found")]
    TableNotFound(String),

    /// A referenced column was not found in the specified table.
    #[error("Column '{column}' not found in table '{table}'")]
    ColumnNotFound {
        /// Table name.
        table: String,
        /// Column name.
        column: String,
    },

    /// A type mismatch occurred during data insertion or computation.
    #[error("Type mismatch: expected {expected}, got {actual}")]
    TypeMismatch {
        /// Expected type description.
        expected: String,
        /// Actual type description.
        actual: String,
    },

    /// A duplicate name was encountered (e.g. duplicate table or column name).
    #[error("Duplicate name: {0}")]
    DuplicateName(String),

    /// The provided data has an invalid shape (e.g. wrong number of columns).
    #[error("Invalid data: {0}")]
    InvalidData(String),

    /// A referenced relationship was not found in the data model.
    #[error("Relationship '{0}' not found")]
    RelationshipNotFound(String),

    /// A relationship references a table or column that does not exist,
    /// or has incompatible column types.
    #[error("Invalid relationship '{relationship}': {reason}")]
    InvalidRelationship {
        /// The relationship name.
        relationship: String,
        /// Description of why the relationship is invalid.
        reason: String,
    },

    /// A referenced measure was not found in the data model.
    #[error("Measure '{0}' not found")]
    MeasureNotFound(String),

    /// A calculated column definition is invalid.
    #[error("Invalid calculated column '{name}': {reason}")]
    InvalidCalculatedColumn {
        /// The calculated column name.
        name: String,
        /// Description of the validation failure.
        reason: String,
    },

    /// An expression references a column that does not exist.
    #[error("Expression references unknown column '{column}' in table '{table}'")]
    ExpressionColumnNotFound {
        /// Table name.
        table: String,
        /// Column name.
        column: String,
    },

    /// A measure group was not found.
    #[error("Measure group '{0}' not found")]
    MeasureGroupNotFound(String),

    /// A referenced context definition was not found.
    #[error("Context '{0}' not found")]
    ContextNotFound(String),

    /// A context definition is invalid.
    #[error("Invalid context '{name}': {reason}")]
    InvalidContext {
        /// The context name.
        name: String,
        /// Description of the validation failure.
        reason: String,
    },

    /// A referenced table variable was not found.
    #[error("Table variable '{0}' not found")]
    TableVariableNotFound(String),

    /// A table variable definition is invalid.
    #[error("Invalid table variable '{name}': {reason}")]
    InvalidTableVariable {
        /// The table variable name.
        name: String,
        /// Description of the validation failure.
        reason: String,
    },

    /// A lookup column configuration is invalid.
    #[error("Invalid lookup on '{table}.{column}': {reason}")]
    InvalidLookup {
        /// The table name.
        table: String,
        /// The column name.
        column: String,
        /// Description of the validation failure.
        reason: String,
    },

    /// A referenced global variable was not found.
    #[error("Global variable '{0}' not found")]
    GlobalVariableNotFound(String),

    /// A global variable definition is invalid.
    #[error("Invalid global variable '{name}': {reason}")]
    InvalidGlobalVariable {
        /// The global variable name.
        name: String,
        /// Description of the validation failure.
        reason: String,
    },

    /// An expression is invalid or used in an unsupported way.
    #[error("Invalid expression: {0}")]
    InvalidExpression(String),

    /// An aggregation was attempted on an unsupported column type.
    #[error("Aggregation '{operation}' is not supported on column type '{column_type}'")]
    UnsupportedAggregation {
        /// The aggregation operation name.
        operation: String,
        /// The column type description.
        column_type: String,
    },

    /// An error from the Arrow library.
    #[error("Arrow error: {0}")]
    Arrow(#[from] arrow::error::ArrowError),

    /// An error from the DataFusion library.
    #[error("DataFusion error: {0}")]
    DataFusion(#[from] datafusion::error::DataFusionError),
}

/// Convenience result type for engine operations.
pub type EngineResult<T> = Result<T, EngineError>;
