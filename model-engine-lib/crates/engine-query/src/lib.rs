//! Query planning and pushdown for the Calcula Engine.
//!
//! This crate provides the query planner and executor that coordinate between
//! data sources (via `engine-connectors`) and local computation (via
//! `engine-core`). The planner pushes aggregations to data sources when
//! possible, falling back to local DataFusion-based computation for
//! cross-table operations.

pub mod csv_connector;
pub mod error;
pub mod executor;
pub mod in_memory_connector;
pub mod parquet_connector;
pub mod planner;
pub mod registry;
pub mod request;

pub use csv_connector::CsvConnector;
pub use error::{QueryError, QueryResult};
pub use executor::QueryExecutor;
pub use in_memory_connector::InMemoryConnector;
pub use planner::{
    effective_group_by, HierarchyLevelSpec, HierarchySpec, LookupSpec, PushdownPlanner, QueryPlan,
};
pub use registry::{AnyConnector, SourceBinding, SourceRegistry};
pub use request::{
    CalculationGroupApplication, ColumnRef, DetailRequest, HierarchyGroupBy, InFilter,
    LookupColumn, MeasureFilter, OrderByClause, OrderTarget, QueryRequest, TotalsMode,
    GROUPING_ID_COLUMN,
};
