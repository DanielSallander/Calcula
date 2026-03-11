//! FILENAME: app/src-tauri/src/bi/mod.rs
//! PURPOSE: Business Intelligence module - integrates Calcula Engine Lib for
//!          analytical queries against external databases.
//! CONTEXT: Phase 1 of the BI extension. Provides Tauri commands for loading
//!          data models, connecting to PostgreSQL, binding tables, and executing
//!          measure queries that are inserted into the grid as locked regions.

pub mod types;
pub mod commands;

pub use commands::*;
pub use types::BiState;
