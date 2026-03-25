//! Data source connectors for the Calcula Engine.
//!
//! This crate provides a pluggable [`Connector`] trait for accessing external
//! databases, with implementations for PostgreSQL (`sqlx`) and SQL Server
//! (`tiberius`).
//!
//! # Architecture
//!
//! Connectors translate between the engine's type system (defined in
//! `engine-core`) and source-specific SQL dialects. Results are returned as
//! Arrow [`RecordBatch`](arrow::record_batch::RecordBatch) values, consistent
//! with the rest of the engine.

pub mod arrow_convert;
pub mod error;
pub mod postgres;
pub mod sqlserver;
pub mod sqlserver_convert;
pub mod traits;
pub mod type_mapping;

pub use error::{ConnectorError, ConnectorResult};
pub use postgres::{PostgresConfig, PostgresConnector};
pub use sqlserver::{SqlServerConfig, SqlServerConnector};
pub use traits::{
    AggregateExpr, AggregateFunction, Connector, FetchRequest, FilterCondition, FilterOperator,
    InFilterCondition, SourceTable,
};
