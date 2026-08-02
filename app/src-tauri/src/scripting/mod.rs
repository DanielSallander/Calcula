//! FILENAME: app/src-tauri/src/scripting/mod.rs
//! PURPOSE: Module declarations for the scripting subsystem.
//! CONTEXT: Follows the same pattern as the pivot module.

pub mod types;
pub mod commands;
pub mod notebook_commands;
pub mod notebook_executor;
pub mod object_script_commands;
pub mod template_commands;
pub mod capability_store;
pub mod scheduler;
pub mod udf;
pub mod writeback_gateway;
pub mod distribution_gateway;

pub use commands::*;
pub use notebook_commands::*;
pub use object_script_commands::*;
pub use template_commands::*;
pub use udf::*;
pub use capability_store::CapabilityStore;
// Glob so the `#[tauri::command]`-generated `__cmd__script_scheduler` macro
// comes along — `generate_handler!` resolves those, not just the function.
pub use scheduler::*;
// Glob so the `#[tauri::command]`-generated `__cmd__*` macros come along —
// `generate_handler!` resolves those, not just the functions.
pub use writeback_gateway::*;
// Same reason: `script_distribution`'s `__cmd__` macro has to be nameable from
// `generate_handler!`.
pub use distribution_gateway::*;
pub use types::{ScriptState, ScriptSummary, WorkbookScript, NotebookDocument, NotebookSummary};
