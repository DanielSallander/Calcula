//! Query execution: plan execution and result assembly.

pub(crate) mod cancel;
pub mod explain;
pub mod pipeline;

pub use pipeline::QueryExecutor;
