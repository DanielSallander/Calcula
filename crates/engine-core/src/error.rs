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

    /// A context-driven calculated column definition is invalid.
    #[error("Invalid context column '{name}': {reason}")]
    InvalidContextColumn {
        /// The context column name.
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

    /// A referenced calculation group was not found in the data model.
    #[error("Calculation group '{0}' not found")]
    CalculationGroupNotFound(String),

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

    /// A referenced global variable (UI term: shared expression) was not found.
    #[error("Shared expression '{0}' not found")]
    GlobalVariableNotFound(String),

    /// A global variable (UI term: shared expression) definition is invalid.
    #[error("Invalid shared expression '{name}': {reason}")]
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

    /// The model's marked date table is invalid (missing table, duplicate
    /// date roles, or a role on a column with an unsuitable data type).
    #[error("Invalid date table '{table}': {reason}")]
    InvalidDateTable {
        /// The marked date-table name.
        table: String,
        /// Description of the validation failure.
        reason: String,
    },

    /// A time-intelligence function (`YTD`, `QTD`, `MTD`, `PRIORYEAR`,
    /// `PRIORPERIOD`) cannot be evaluated because a model or query
    /// prerequisite is missing — no marked date table, missing date roles,
    /// or the required date columns are absent from the query's group_by.
    ///
    /// The `reason` always states the corrective action so the message can
    /// be surfaced directly to model authors.
    #[error("Time intelligence: {function} cannot be evaluated: {reason}")]
    TimeIntelligence {
        /// The function as written (e.g. `YTD`, `PRIORPERIOD`).
        function: String,
        /// What is missing and how to fix it.
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

    /// Presentation metadata (display name, description, format string)
    /// on a model object is invalid — e.g. an over-long string or an
    /// empty display name.
    #[error("Invalid metadata on {entity}: {field} {reason}")]
    InvalidMetadata {
        /// The model object carrying the metadata (e.g. `table 'Sales'`,
        /// `measure 'Revenue'`, `column 'Sales.amount'`).
        entity: String,
        /// The metadata field that failed validation (e.g. `display_name`).
        field: String,
        /// Description of the validation failure.
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

    /// An expression calls a function that is neither a built-in nor a
    /// registered UDF.
    ///
    /// The parser accepts any well-formed unknown function name as a UDF
    /// call (`Expression::Call`); the engine verifies at query time that
    /// every called name is registered and raises this error otherwise —
    /// covering both unregistered UDFs and typos in built-in names.
    #[error("Unknown function or unregistered UDF '{name}' (referenced by {referenced_by}). Register it with Engine::register_udf() before querying.")]
    UnknownFunction {
        /// The unresolved function name.
        name: String,
        /// What references the function (e.g. `measure 'Revenue'`).
        referenced_by: String,
    },

    /// A sandboxed Rhai script function failed to compile or evaluate.
    ///
    /// Script function bodies travel inside shared model files (a trust
    /// boundary), so this single variant covers every script failure mode:
    ///
    /// - **Compile errors** (raised at [`Engine`](crate) build time and by
    ///   model validation): a syntax error in the body. `position` is a
    ///   best-effort byte offset into the body, derived from Rhai's
    ///   line/column position, suitable for inline error highlighting.
    /// - **Runtime errors** (raised during query execution): the sandbox
    ///   tripped a resource limit (operation budget, call-level/recursion
    ///   depth, string/array size), a type mismatch occurred, or the body
    ///   evaluated to an unconvertible value. `position` is `None` for these.
    ///
    /// The `function` field always names the offending script so the message
    /// can be surfaced directly to model authors.
    #[error("Script '{function}' error{}: {message}", position.map(|p| format!(" at position {p}")).unwrap_or_default())]
    ScriptError {
        /// The script function's name.
        function: String,
        /// Best-effort byte offset into the body for a compile error;
        /// `None` for runtime failures (no source position is available).
        position: Option<usize>,
        /// Description of the failure.
        message: String,
    },

    /// A security role was activated (or looked up) that the model does not
    /// define.
    ///
    /// Raised when a host sets an active role whose name has no matching
    /// [`SecurityRole`](crate::model::SecurityRole) in the model, or when the
    /// engine resolves the active role's predicates before a query.
    /// Surfacing this as a hard error (rather than silently running
    /// unrestricted) is a safety property: a typo'd role name must never
    /// degrade into a no-RLS query.
    #[error("Security role '{0}' not found")]
    SecurityRoleNotFound(String),

    /// The active security role filters a table whose restriction cannot be
    /// enforced for the current query, so the query is **refused** rather than
    /// run with an under-restricted (data-leaking) result.
    ///
    /// This happens when a role filters a dimension that reaches a queried
    /// fact only through a relationship the engine cannot turn into a fact
    /// restriction: a non-equi / many-to-many / multi-condition (composite
    /// key) relationship, an inactive relationship, or a multi-hop
    /// (snowflake) path. Failing closed here is a security property — RLS must
    /// never silently return rows the role was meant to hide. The supported
    /// shape is a single-hop, active, single-column equi relationship from the
    /// fact to the role-filtered dimension.
    #[error(
        "row-level security for the active role cannot be enforced for table '{table}' in this query: {reason}"
    )]
    RowLevelSecurityNotEnforceable {
        /// The role-filtered table whose restriction could not be enforced.
        table: String,
        /// Why enforcement is impossible for this query.
        reason: String,
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
