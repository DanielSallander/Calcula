//! Query engine error types.

use thiserror::Error;

/// Errors produced by the query engine.
#[derive(Debug, Error)]
pub enum QueryError {
    /// A referenced measure was not found in the data model.
    #[error("Measure '{0}' not found in data model")]
    MeasureNotFound(String),

    /// A table has no registered data source.
    #[error("Table '{0}' has no registered source")]
    SourceNotRegistered(String),

    /// The query request is invalid.
    #[error("Invalid query: {0}")]
    InvalidQuery(String),

    /// An error from the engine core.
    #[error(transparent)]
    Engine(#[from] engine_core::error::EngineError),

    /// An error from a connector.
    #[error(transparent)]
    Connector(#[from] engine_connectors::ConnectorError),

    /// An error from the Arrow library.
    #[error(transparent)]
    Arrow(#[from] arrow::error::ArrowError),

    /// An error from the DataFusion library.
    #[error(transparent)]
    DataFusion(#[from] datafusion::error::DataFusionError),
}

/// Convenience result type for query operations.
pub type QueryResult<T> = Result<T, QueryError>;
