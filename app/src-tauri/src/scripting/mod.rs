//! FILENAME: app/src-tauri/src/scripting/mod.rs
//! PURPOSE: Module declarations for the scripting subsystem.
//! CONTEXT: Follows the same pattern as the pivot module.

pub mod types;
pub mod commands;

pub use commands::*;
pub use types::{ScriptState, ScriptSummary, WorkbookScript};
