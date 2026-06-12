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

    /// A measure, context, or variable text expression failed to parse.
    ///
    /// Raised by the expression parser for syntax errors and for errors
    /// triggered by the content of the parsed text (e.g. unknown function
    /// names, reserved variable names, invalid interval keywords).
    ///
    /// `position` is a byte offset into the input text where the error was
    /// detected, suitable for inline error highlighting in host applications
    /// (e.g. a formula bar). For errors at end of input it equals the input
    /// length.
    #[error("Parse error at position {position}: {message}")]
    ParseError {
        /// Byte offset into the input text where the error was detected.
        position: usize,
        /// Description of the parse failure.
        message: String,
    },

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

    /// A referenced hierarchy was not found.
    #[error("Hierarchy '{0}' not found")]
    HierarchyNotFound(String),

    /// A hierarchy definition is invalid.
    #[error("Invalid hierarchy '{name}': {reason}")]
    InvalidHierarchy {
        /// The hierarchy name.
        name: String,
        /// Description of the validation failure.
        reason: String,
    },

    /// A column's sort_by_column reference is invalid.
    #[error("Invalid sort_by_column on '{table}.{column}': {reason}")]
    InvalidSortByColumn {
        /// The table name.
        table: String,
        /// The column that has the invalid sort_by_column setting.
        column: String,
        /// Description of the validation failure.
        reason: String,
    },

    /// An expression is invalid or used in an unsupported way.
    #[error("Invalid expression: {0}")]
    InvalidExpression(String),

    /// A model identifier (table, column, calculated-column, or measure name)
    /// contains characters that are unsafe to interpolate into quoted SQL
    /// identifiers or derived file names.
    #[error("Invalid identifier '{name}': {reason}")]
    InvalidIdentifier {
        /// The offending identifier.
        name: String,
        /// Description of why the identifier was rejected.
        reason: String,
    },

    /// Attempted an in-memory operation on a DirectQuery table.
    #[error("Table '{0}' is not configured for in-memory storage")]
    TableNotInMemory(String),

    /// Refreshing a table would exceed the memory budget.
    #[error("Memory budget exceeded: need {needed} bytes but only {available} bytes available (budget: {budget} bytes)")]
    MemoryBudgetExceeded {
        /// Bytes needed by the new data.
        needed: usize,
        /// Bytes currently available within the budget.
        available: usize,
        /// Total configured budget in bytes.
        budget: usize,
    },

    /// An in-memory table was queried before its first refresh.
    #[error("Table '{0}' has not been refreshed yet — call refresh_table() before querying")]
    TableNotCached(String),

    /// A model-supplied `SourceQuery` poll SQL was rejected before execution,
    /// either by validation (not a single SELECT statement) or by host policy.
    ///
    /// Model files are shared between users, so the SQL embedded in a
    /// `SourceQuery` refresh strategy crosses a trust boundary and must be
    /// validated before it is sent to a connector.
    #[error("Source query for table '{table}' rejected: {reason}")]
    SourceQueryRejected {
        /// The table whose connector would have executed the query.
        table: String,
        /// Why the query was rejected.
        reason: String,
    },

    /// A model file was written by a newer engine than the one loading it.
    ///
    /// Raised by model-loading paths *before* structural deserialization
    /// when the file's `format_version` exceeds the running engine's
    /// supported version. Refusing the load up front (instead of partially
    /// deserializing and silently dropping unknown content) protects
    /// newer-format models from being destroyed by a subsequent save.
    #[error("Model file format version {found} is newer than this engine supports (max {supported}). Update the application to open this model.")]
    ModelFormatTooNew {
        /// The format version declared in the file.
        found: u32,
        /// The maximum format version this engine supports.
        supported: u32,
    },

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
