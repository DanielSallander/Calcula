//! FILENAME: app/src-tauri/src/pivot/mod.rs
pub mod types;
pub mod utils;
pub mod operations;
pub mod grid_theme;
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
/// Deletes a pivot table. Defined here, where `generate_handler!` names it
/// (`pivot::delete_pivot_table`), SHADOWING the glob re-export of
/// `commands::delete_pivot_table` -- the body, over plain references, which
/// the AI tool (`mcp::objects::delete_pivot`) and the unit tier call. A
/// one-line delegation: every rule lives in that body.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn delete_pivot_table(
    state: tauri::State<crate::AppState>,
    file_state: tauri::State<'_, crate::persistence::FileState>,
    pivot_state: tauri::State<'_, PivotState>,
    user_files_state: tauri::State<'_, crate::persistence::UserFilesState>,
    pane_control_state: tauri::State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: tauri::State<'_, crate::ribbon_filter::RibbonFilterState>,
    slicer_state: tauri::State<'_, crate::slicer::SlicerState>,
    timeline_state: tauri::State<'_, crate::timeline_slicer::TimelineSlicerState>,
    pivot_id: pivot_engine::PivotId,
) -> Result<(), String> {
    commands::delete_pivot_table(
        &state,
        &file_state,
        &pivot_state,
        &user_files_state,
        &pane_control_state,
        &ribbon_filter_state,
        &slicer_state,
        &timeline_state,
        pivot_id,
    )
}
