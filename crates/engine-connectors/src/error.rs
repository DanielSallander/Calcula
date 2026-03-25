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
}

/// Convenience result type for connector operations.
pub type ConnectorResult<T> = Result<T, ConnectorError>;
