//! FILENAME: app/src-tauri/src/bi/mod.rs
//! PURPOSE: Business Intelligence module - multi-connection model for
//!          analytical queries against external databases.

pub mod types;
pub mod commands;
pub mod cube;
pub mod measures;
pub mod model_editor;
pub mod engine_registry;
pub mod credential_cache;
pub mod script_provider;

pub use commands::*;
pub use types::{BiState, ConnectionId};
pub use engine_registry::EngineRegistry;
