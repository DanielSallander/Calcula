//! FILENAME: app/src-tauri/src/report.rs
//! Paginated grid reports — Slice 1: materialize a design query straight into a
//! range of grid cells (committed / pivot-like model). A report holds pivot-layout
//! DSL + a model binding; its result is written into the grid like a pivot's
//! output, refreshable and delete-able. Reuses the generic grid-write primitive
//! `write_pivot_to_grid` and the headless `compute_design_query_view` compute core.
//!
//! Slice-1 scope: create / refresh / delete / list, fixed inline FILTERS, single
//! row-capped block, overwrite-guarded, region-tracked (region_type "report").
//! Deferred to follow-up slices: .cala persistence, undo, .calp distribution,
//! interactive filters, true pagination.

use tauri::State;

use engine::CellValue;

use crate::bi::types::BiState;
use crate::pivot::headless::{compute_design_query_view, DesignQueryRequest};
use crate::pivot::operations::{
    clear_pivot_region_from_grid, recalculate_sheet_formulas, write_pivot_to_grid,
};
use crate::pivot::types::PivotState;
use crate::{AppState, ProtectedRegion};

pub type ReportId = identity::EntityId;

/// Safety cap on materialized rows so a runaway query can't fill a sheet.
const MAX_REPORT_ROWS: usize = 100_000;

/// Extension-data key under which reports persist (the sanctioned, feature-neutral
/// workbook persistence channel — no new typed .cala field needed).
pub const REPORTS_EXT_KEY: &str = "calcula.reports";

/// A saved grid report. Lives in `AppState.report_definitions` (in-memory) and is
/// mirrored into `extension_data["calcula.reports"]` so it persists with the
/// workbook. The materialized cells persist as ordinary grid content.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedReport {
    pub id: ReportId,
    pub name: String,
    /// The pivot-layout DSL text (kept for editing + refresh recompile on the frontend).
    pub dsl_text: String,
    pub connection_id: identity::EntityId,
    pub sheet_index: usize,
    pub anchor_row: u32,
    pub anchor_col: u32,
    /// Last materialized region bounds (inclusive) — lets the protected region be
    /// re-registered on load without re-running the query.
    pub end_row: u32,
    pub end_col: u32,
}

/// Mirror the in-memory report definitions into extension_data so they persist
/// with the workbook (extension_data is saved + loaded automatically).
fn sync_reports_to_extension_data(state: &AppState) {
    let defs = state.report_definitions.lock().unwrap();
    if let Ok(v) = serde_json::to_value(&*defs) {
        state
            .extension_data
            .lock()
            .unwrap()
            .insert(REPORTS_EXT_KEY.to_string(), v);
    }
}

/// Re-register a report's protected region from its saved bounds. Called on load
/// (the cells themselves are restored as ordinary grid content).
pub fn reregister_report_region(state: &AppState, r: &SavedReport) {
    let mut regions = state.protected_regions.lock().unwrap();
    regions.retain(|reg| !(reg.region_type == "report" && reg.owner_id == r.id));
    regions.push(ProtectedRegion {
        id: format!("report-{}", r.id),
        region_type: "report".to_string(),
        owner_id: r.id,
        sheet_index: r.sheet_index,
        start_row: r.anchor_row,
        start_col: r.anchor_col,
        end_row: r.end_row,
        end_col: r.end_col,
    });
}

// ============================================================================
// DTOs
// ============================================================================

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateReportRequest {
    pub name: String,
    pub dsl_text: String,
    pub sheet_index: usize,
    pub anchor_row: u32,
    pub anchor_col: u32,
    /// The compiled design query (connectionId + field refs), from the frontend.
    pub query: DesignQueryRequest,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshReportRequest {
    pub report_id: ReportId,
    /// The (re-compiled) design query, so a refresh picks up model changes.
    pub query: DesignQueryRequest,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportResult {
    pub report_id: ReportId,
    pub row_count: u32,
    pub col_count: u32,
    /// Non-empty cells outside the report's previous region that this write covered.
    pub overwritten_cell_count: u32,
}

// ============================================================================
// Region helpers (report-specific; parallel to the pivot ones)
// ============================================================================

fn get_report_region(state: &AppState, report_id: ReportId) -> Option<ProtectedRegion> {
    let regions = state.protected_regions.lock().unwrap();
    regions
        .iter()
        .find(|r| r.region_type == "report" && r.owner_id == report_id)
        .cloned()
}

/// Count non-empty cells the write would clobber outside the report's old region.
fn count_report_overwrites(
    state: &AppState,
    report_id: ReportId,
    sheet_idx: usize,
    dest: (u32, u32),
    view: &pivot_engine::PivotView,
) -> u32 {
    let visible_rows = view.rows.iter().filter(|r| r.visible).count() as u32;
    if visible_rows == 0 || view.col_count == 0 {
        return 0;
    }
    let (dest_row, dest_col) = dest;
    let end_row = dest_row + visible_rows - 1;
    let end_col = dest_col + view.col_count as u32 - 1;

    let old = get_report_region(state, report_id);
    let grids = state.grids.lock().unwrap();
    let grid = match grids.get(sheet_idx) {
        Some(g) => g,
        None => return 0,
    };

    let mut count = 0u32;
    for row in dest_row..=end_row {
        for col in dest_col..=end_col {
            if let Some(ref o) = old {
                if row >= o.start_row && row <= o.end_row && col >= o.start_col && col <= o.end_col {
                    continue;
                }
            }
            if let Some(cell) = grid.get_cell(row, col) {
                if !matches!(cell.value, CellValue::Empty) {
                    count += 1;
                }
            }
        }
    }
    count
}

/// Clear the report's previous region, write the new view, and re-register the
/// region (region_type "report"). Mirrors `update_pivot_in_grid` for reports.
fn write_report_to_grid(
    state: &AppState,
    report_id: ReportId,
    sheet_idx: usize,
    dest: (u32, u32),
    view: &pivot_engine::PivotView,
) {
    let old = get_report_region(state, report_id);

    {
        let mut styles = state.style_registry.lock().unwrap();
        let mut grids = state.grids.lock().unwrap();
        if let Some(dest_grid) = grids.get_mut(sheet_idx) {
            if let Some(ref r) = old {
                if r.sheet_index == sheet_idx {
                    clear_pivot_region_from_grid(dest_grid, r.start_row, r.start_col, r.end_row, r.end_col);
                }
            }

            let active_sheet = *state.active_sheet.lock().unwrap();
            let merges = if sheet_idx == active_sheet {
                let mut active_grid = state.grid.lock().unwrap();
                if let Some(ref r) = old {
                    if r.sheet_index == sheet_idx {
                        active_grid.clear_region(r.start_row, r.start_col, r.end_row, r.end_col);
                    }
                }
                let m = write_pivot_to_grid(dest_grid, Some(&mut active_grid), view, dest, &mut styles);
                active_grid.recalculate_bounds();
                m
            } else {
                write_pivot_to_grid(dest_grid, None, view, dest, &mut styles)
            };

            let (dest_row, dest_col) = dest;
            let visible_rows = view.rows.iter().filter(|r| r.visible).count() as u32;
            let new_end_row = dest_row + visible_rows.max(1) - 1;
            let new_end_col = dest_col + view.col_count.max(1) as u32 - 1;

            let mut merged = state.merged_regions.lock().unwrap();
            if let Some(ref r) = old {
                merged.retain(|m| {
                    !(m.start_row >= r.start_row && m.end_row <= r.end_row
                        && m.start_col >= r.start_col && m.end_col <= r.end_col)
                });
            }
            merged.retain(|m| {
                !(m.start_row >= dest_row && m.end_row <= new_end_row
                    && m.start_col >= dest_col && m.end_col <= new_end_col)
            });
            for mr in merges {
                merged.insert(mr);
            }
        }
    }

    // Re-register the protected region (region_type "report").
    let (dest_row, dest_col) = dest;
    let visible_rows = view.rows.iter().filter(|r| r.visible).count() as u32;
    let end_row = dest_row + visible_rows.max(1) - 1;
    let end_col = dest_col + view.col_count.max(1) as u32 - 1;
    let mut regions = state.protected_regions.lock().unwrap();
    regions.retain(|r| !(r.region_type == "report" && r.owner_id == report_id));
    regions.push(ProtectedRegion {
        id: format!("report-{}", report_id),
        region_type: "report".to_string(),
        owner_id: report_id,
        sheet_index: sheet_idx,
        start_row: dest_row,
        start_col: dest_col,
        end_row,
        end_col,
    });
}

fn clear_report_region(state: &AppState, report_id: ReportId) {
    let old = get_report_region(state, report_id);
    if let Some(r) = old {
        let mut grids = state.grids.lock().unwrap();
        if let Some(dest_grid) = grids.get_mut(r.sheet_index) {
            clear_pivot_region_from_grid(dest_grid, r.start_row, r.start_col, r.end_row, r.end_col);
        }
        let active_sheet = *state.active_sheet.lock().unwrap();
        if r.sheet_index == active_sheet {
            let mut active_grid = state.grid.lock().unwrap();
            active_grid.clear_region(r.start_row, r.start_col, r.end_row, r.end_col);
            active_grid.recalculate_bounds();
        }
        let mut merged = state.merged_regions.lock().unwrap();
        merged.retain(|m| {
            !(m.start_row >= r.start_row && m.end_row <= r.end_row
                && m.start_col >= r.start_col && m.end_col <= r.end_col)
        });
    }
    let mut regions = state.protected_regions.lock().unwrap();
    regions.retain(|reg| !(reg.region_type == "report" && reg.owner_id == report_id));
}

/// Materialize a computed view for a report at (sheet, dest): count overwrites,
/// write cells, register the region, recalc dependent formulas. Returns the count.
#[allow(clippy::too_many_arguments)]
fn materialize(
    state: &AppState,
    pivot_state: &PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    report_id: ReportId,
    sheet_idx: usize,
    dest: (u32, u32),
    view: &pivot_engine::PivotView,
) -> u32 {
    let overwritten = count_report_overwrites(state, report_id, sheet_idx, dest, view);
    write_report_to_grid(state, report_id, sheet_idx, dest, view);
    recalculate_sheet_formulas(state, pivot_state, Some((pane_control_state, ribbon_filter_state)));
    overwritten
}

// ============================================================================
// Commands
// ============================================================================

/// Create a report: run its design query and materialize the result into the grid.
#[tauri::command]
pub async fn create_report(
    state: State<'_, AppState>,
    bi_state: State<'_, BiState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: CreateReportRequest,
) -> Result<ReportResult, String> {
    let (_def, _cache, view) = compute_design_query_view(&bi_state, &request.query).await?;
    let visible_rows = view.rows.iter().filter(|r| r.visible).count();
    if visible_rows > MAX_REPORT_ROWS {
        return Err(format!(
            "This report has {} rows, over the {} row cap. Add filters to narrow it.",
            visible_rows, MAX_REPORT_ROWS
        ));
    }

    let report_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    let dest = (request.anchor_row, request.anchor_col);
    let overwritten = materialize(
        &state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        report_id,
        request.sheet_index,
        dest,
        &view,
    );

    let end_row = request.anchor_row + (visible_rows.max(1) as u32) - 1;
    let end_col = request.anchor_col + (view.col_count.max(1) as u32) - 1;
    state.report_definitions.lock().unwrap().push(SavedReport {
        id: report_id,
        name: request.name,
        dsl_text: request.dsl_text,
        connection_id: request.query.connection_id,
        sheet_index: request.sheet_index,
        anchor_row: request.anchor_row,
        anchor_col: request.anchor_col,
        end_row,
        end_col,
    });
    sync_reports_to_extension_data(&state);

    Ok(ReportResult {
        report_id,
        row_count: visible_rows as u32,
        col_count: view.col_count as u32,
        overwritten_cell_count: overwritten,
    })
}

/// Refresh a report: re-run its query and re-materialize at its anchor.
#[tauri::command]
pub async fn refresh_report(
    state: State<'_, AppState>,
    bi_state: State<'_, BiState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: RefreshReportRequest,
) -> Result<ReportResult, String> {
    let (sheet_idx, dest) = {
        let defs = state.report_definitions.lock().unwrap();
        let def = defs
            .iter()
            .find(|d| d.id == request.report_id)
            .ok_or_else(|| format!("Report {} not found", request.report_id))?;
        (def.sheet_index, (def.anchor_row, def.anchor_col))
    };

    let (_def, _cache, view) = compute_design_query_view(&bi_state, &request.query).await?;
    let visible_rows = view.rows.iter().filter(|r| r.visible).count();
    if visible_rows > MAX_REPORT_ROWS {
        return Err(format!(
            "This report has {} rows, over the {} row cap. Add filters to narrow it.",
            visible_rows, MAX_REPORT_ROWS
        ));
    }

    let overwritten = materialize(
        &state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        request.report_id,
        sheet_idx,
        dest,
        &view,
    );

    let end_row = dest.0 + (visible_rows.max(1) as u32) - 1;
    let end_col = dest.1 + (view.col_count.max(1) as u32) - 1;
    {
        let mut defs = state.report_definitions.lock().unwrap();
        if let Some(d) = defs.iter_mut().find(|d| d.id == request.report_id) {
            d.end_row = end_row;
            d.end_col = end_col;
        }
    }
    sync_reports_to_extension_data(&state);

    Ok(ReportResult {
        report_id: request.report_id,
        row_count: visible_rows as u32,
        col_count: view.col_count as u32,
        overwritten_cell_count: overwritten,
    })
}

/// Delete a report: clear its region and drop the definition.
#[tauri::command]
pub fn delete_report(
    state: State<'_, AppState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    report_id: ReportId,
) -> Result<(), String> {
    clear_report_region(&state, report_id);
    state.report_definitions.lock().unwrap().retain(|d| d.id != report_id);
    sync_reports_to_extension_data(&state);
    recalculate_sheet_formulas(&state, &pivot_state, Some((&pane_control_state, &ribbon_filter_state)));
    Ok(())
}

/// List all report definitions.
#[tauri::command]
pub fn list_reports(state: State<'_, AppState>) -> Result<Vec<SavedReport>, String> {
    Ok(state.report_definitions.lock().unwrap().clone())
}
