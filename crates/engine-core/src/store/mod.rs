//! Columnar storage backed by Apache Arrow.

pub mod memory;

pub use memory::{ColumnStore, TableData};
