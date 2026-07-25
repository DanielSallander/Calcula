//! Connector-specific error types.

use thiserror::Error;

/// Errors that can occur during connector operations.
#[derive(Debug, Error)]
pub enum ConnectorError {
    /// Failed to establish a connection to the data source.
    #[error("Connection failed: {0}")]
    ConnectionFailed(String),

    /// A query failed to execute.
    #[error("Query execution failed: {0}")]
    QueryFailed(String),

    /// Schema introspection failed.
    #[error("Schema introspection failed: {0}")]
    IntrospectionFailed(String),

    /// A database column type has no mapping to an engine data type.
    #[error("Unsupported database type '{db_type}' for column '{column}'")]
    UnsupportedType {
        /// The column name.
        column: String,
        /// The database type name.
        db_type: String,
    },

    /// An error occurred while converting rows to Arrow format.
    #[error("Arrow conversion error: {0}")]
    ArrowConversion(String),

    /// A decimal value could not be rescaled to the target Arrow decimal
    /// representation without overflowing 128 bits.
    #[error("Decimal value '{value}' overflows the target Arrow Decimal128 representation")]
    DecimalOverflow {
        /// The source value that overflowed, formatted as text.
        value: String,
    },

    /// An error from the sqlx library.
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),

    /// An error from the tiberius library.
    #[error(transparent)]
    Tiberius(#[from] tiberius::error::Error),

    /// An error from the Arrow library.
    #[error(transparent)]
    Arrow(#[from] arrow::error::ArrowError),

    /// An error from the engine-core library.
    #[error(transparent)]
    Engine(#[from] engine_core::error::EngineError),

    /// An operation is not supported by this connector.
    #[error("Unsupported operation: {0}")]
    UnsupportedOperation(String),

    /// The requested authentication method is not supported by this connector.
    #[error("Authentication method not supported: {0}")]
    AuthMethodNotSupported(String),

    /// A connection parameter holds a value that cannot be represented in the
    /// underlying wire protocol (for example, an embedded NUL byte).
    #[error("Invalid connection parameter '{parameter}': {reason}")]
    InvalidConnectionParameter {
        /// Name of the offending parameter (e.g. `"host"`, `"database"`,
        /// `"username"`, `"password"`).
        parameter: String,
        /// Why the value was rejected.
        reason: String,
    },
}

/// Convenience result type for connector operations.
pub type ConnectorResult<T> = Result<T, ConnectorError>;
