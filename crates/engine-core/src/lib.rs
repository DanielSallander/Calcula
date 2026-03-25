//! # Engine Core
//!
//! Core columnar engine for the Calcula BI ecosystem.
//!
//! Provides data model definitions (tables, columns), Arrow-backed in-memory
//! columnar storage, and aggregation computation powered by DataFusion.
//!
//! This crate is self-contained with zero network dependencies — it works
//! purely with in-memory data.
//!
//! # Example
//!
//! ```rust
//! use engine_core::model::{Column, Table};
//! use engine_core::store::TableData;
//! use engine_core::types::{DataType, Value};
//!
//! let table = Table::new("Sales", vec![
//!     Column::new("amount", DataType::Float64),
//! ]).unwrap();
//!
//! let mut data = TableData::new(table);
//! data.insert_rows(vec![
//!     vec![Value::Float64(100.0)],
//!     vec![Value::Float64(200.0)],
//! ]).unwrap();
//!
//! let batch = data.to_record_batch().unwrap();
//! assert_eq!(batch.num_rows(), 2);
//! ```

pub mod compute;
pub mod error;
pub mod model;
pub mod store;
pub mod types;
