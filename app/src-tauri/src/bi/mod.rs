//! FILENAME: app/src-tauri/src/bi/mod.rs
//! PURPOSE: Business Intelligence module - multi-connection model for
//!          analytical queries against external databases.

pub mod types;
pub mod commands;

pub use commands::*;
pub use types::{BiState, ConnectionId};
