//! Query planning and pushdown for the Calcula Engine.
//!
//! This crate provides the query planner and executor that coordinate between
//! data sources (via `engine-connectors`) and local computation (via
//! `engine-core`). The planner pushes aggregations to data sources when
//! possible, falling back to local DataFusion-based computation for
//! cross-table operations.

pub mod error;
pub mod executor;
pub mod planner;
pub mod registry;
pub mod request;

pub use error::{QueryError, QueryResult};
pub use executor::QueryExecutor;
pub use planner::{LookupSpec, PushdownPlanner, QueryPlan};
pub use registry::{AnyConnector, SourceBinding, SourceRegistry};
pub use request::{ColumnRef, LookupColumn, QueryRequest};
