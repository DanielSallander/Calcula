//! FILENAME: app/src-tauri/src/pivot/mod.rs
pub mod types;
pub mod utils;
pub mod operations;
pub mod commands;
pub mod layout_commands;
pub mod headless;
pub mod mask_safety;
pub mod totals;
#[cfg(test)]
mod regression_tests;

// Re-export commands so they are easy to access from main.rs
pub use commands::*;
pub use types::PivotState;

/// The pivot listing over IPC: every pivot's info AND the sheet it is on.
///
/// Defined here, where `generate_handler!` names it (`pivot::
/// get_all_pivot_tables`), and so SHADOWING the glob re-export of
/// `commands::get_all_pivot_tables` -- which keeps returning plain
/// `PivotTableInfo` for its in-crate reader, the MCP inventory. One listing,
/// `commands::get_all_pivot_tables_core`, behind both.
#[tauri::command]
pub fn get_all_pivot_tables(
    state: tauri::State<crate::AppState>,
    pivot_state: tauri::State<'_, PivotState>,
) -> Vec<types::PivotTableListing> {
    commands::get_all_pivot_tables_core(&state, &pivot_state)
}