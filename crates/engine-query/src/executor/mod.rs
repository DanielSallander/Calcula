//! Query execution: plan execution and result assembly.

pub mod explain;
pub mod pipeline;

pub use pipeline::QueryExecutor;
