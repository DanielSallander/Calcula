//! FILENAME: app/src-tauri/src/report.rs
//! Grid reports: materialize a design query straight into a range of grid cells
//! (committed / pivot-like model). A report holds pivot-layout DSL + a model
//! binding; its result is written into the grid like a pivot's output,
//! refreshable and delete-able. Reuses the generic grid-write primitive
//! `write_pivot_to_grid` and the headless `compute_design_query_view` compute core.
//!
//! Implemented here: create / refresh / delete / list / restore, row-capped
//! block, overlap- and overwrite-guarded, region-tracked (region_type "report"),
//! persistence via extension_data (`sync_reports_to_extension_data`), symmetric
//! cell-based undo (`ReportUndoSnapshot` / undo_commands::apply_report_restore),
//! and `.calp` distribution (`restore_report`). Interactive @param filters live
//! frontend-side (Reports extension). Still open: true pagination.

use std::collections::HashSet;

use tauri::State;

use engine::{Cell, CellValue};

use crate::bi::types::BiState;
use crate::pivot::headless::{compute_design_query_view, DesignQueryRequest};
use crate::pivot::operations::{
    clear_pivot_region_from_grid, recalculate_sheet_formulas, write_pivot_to_grid,
};
use crate::pivot::types::PivotState;
use crate::{AppState, MergedRegion, ProtectedRegion};

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
    /// Stable BI data-source id for cross-machine rebind on `.calp` pull (the
    /// connection's package data-source id, or its local id). Absent for grid
    /// reports without a package origin.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_source_id: Option<String>,
}

/// The stable data-source id for a connection: its package data-source id if it
/// was pulled from a package, else its local id (which becomes the package
/// data-source id when this workbook is itself published).
fn connection_data_source_id(bi_state: &BiState, connection_id: identity::EntityId) -> Option<String> {
    let connections = bi_state.connections.lock().ok()?;
    let conn = connections.get(&connection_id)?;
    Some(
        conn.package_data_source_id
            .clone()
            .unwrap_or_else(|| connection_id.to_string()),
    )
}

/// Mirror the in-memory report definitions into extension_data so they persist
/// with the workbook (extension_data is saved + loaded automatically).
pub fn sync_reports_to_extension_data(state: &AppState) {
    let defs = state.report_definitions.lock().unwrap();
    if let Ok(v) = serde_json::to_value(&*defs) {
        state
            .extension_data
            .lock()
            .unwrap()
            .insert(REPORTS_EXT_KEY.to_string(), v);
    }
}

/// Undo/redo snapshot for a report mutation: the affected grid cells (as they
/// were, to restore) plus the full report-definitions list. A single symmetric
/// snapshot covers create / refresh / delete — restore reverts to it and captures
/// the current state as the inverse (redo). Cell-based (not re-materialize) so
/// undo works offline. See `undo_commands::apply_report_restore`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ReportUndoSnapshot {
    pub sheet_index: usize,
    /// (row, col, cell-to-restore-to). `None` means the cell was empty.
    pub cells: Vec<(u32, u32, Option<Cell>)>,
    pub definitions: Vec<SavedReport>,
    /// Merged regions fully inside the snapshot box as they were (report header
    /// merges and any pre-existing user merges) — restored together with the
    /// cells, since the report write removes/replaces merges in its box.
    #[serde(default)]
    pub merges: Vec<MergedRegion>,
}

/// Run `f` on the merge set for `sheet_idx`: the live active-sheet set when that
/// sheet is active, else its slot in the per-sheet store. Report writes must go
/// through this — mutating `merged_regions` for a background sheet would corrupt
/// the VISIBLE sheet's merges (and lose the background sheet's own).
pub fn with_sheet_merges<R>(
    state: &AppState,
    sheet_idx: usize,
    f: impl FnOnce(&mut HashSet<MergedRegion>) -> R,
) -> R {
    let active = *state.active_sheet.lock().unwrap();
    if sheet_idx == active {
        let mut merged = state.merged_regions.lock().unwrap();
        f(&mut merged)
    } else {
        let mut all = state.all_merged_regions.lock().unwrap();
        while all.len() <= sheet_idx {
            all.push(HashSet::new());
        }
        f(&mut all[sheet_idx])
    }
}

/// The merged regions fully inside `bounds` on a sheet (for undo capture).
pub fn merges_in_box(
    state: &AppState,
    sheet_idx: usize,
    bounds: (u32, u32, u32, u32),
) -> Vec<MergedRegion> {
    let (sr, sc, er, ec) = bounds;
    with_sheet_merges(state, sheet_idx, |merged| {
        merged
            .iter()
            .filter(|m| m.start_row >= sr && m.end_row <= er && m.start_col >= sc && m.end_col <= ec)
            .cloned()
            .collect()
    })
}

/// Snapshot the current cells within a bounding box (inclusive) on a sheet.
fn snapshot_box_cells(
    state: &AppState,
    sheet_idx: usize,
    bounds: (u32, u32, u32, u32),
) -> Vec<(u32, u32, Option<Cell>)> {
    let (sr, sc, er, ec) = bounds;
    let grids = state.grids.lock().unwrap();
    let grid = match grids.get(sheet_idx) {
        Some(g) => g,
        None => return Vec::new(),
    };
    let mut cells = Vec::new();
    for row in sr..=er {
        for col in sc..=ec {
            cells.push((row, col, grid.get_cell(row, col).cloned()));
        }
    }
    cells
}

/// Record an undo entry (kind "report_restore") capturing the cells in `bounds`
/// (before the mutation) and the current report-definitions list.
fn record_report_undo(
    state: &AppState,
    sheet_idx: usize,
    bounds: (u32, u32, u32, u32),
    description: &str,
) {
    let cells = snapshot_box_cells(state, sheet_idx, bounds);
    let definitions = state.report_definitions.lock().unwrap().clone();
    let merges = merges_in_box(state, sheet_idx, bounds);
    let snapshot = ReportUndoSnapshot { sheet_index: sheet_idx, cells, definitions, merges };
    let data = serde_json::to_vec(&snapshot).unwrap_or_default();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    undo_stack.begin_transaction(description);
    undo_stack.record_custom_restore("report_restore".to_string(), data, description);
    undo_stack.commit_transaction();
}

/// Union of two inclusive regions (used to snapshot both the old and new report
/// extents before a refresh).
fn union_bounds(a: (u32, u32, u32, u32), b: (u32, u32, u32, u32)) -> (u32, u32, u32, u32) {
    (a.0.min(b.0), a.1.min(b.1), a.2.max(b.2), a.3.max(b.3))
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
    /// True for control-driven auto-refreshes (a bound control / ribbon filter
    /// changed). These skip the undo entry unless the write reaches user cells
    /// outside the report's previous region: recording one per filter click
    /// floods the undo stack and makes Ctrl+Z desync the report's cells from
    /// the visible filter state (the transient-write discipline).
    #[serde(default)]
    pub auto: bool,
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

/// Reject a write whose target box intersects a protected region NOT owned by
/// this report (another report, a pivot, ...): silently growing over a sibling
/// object would leave both regions corrupt.
fn check_report_overlap(
    state: &AppState,
    report_id: ReportId,
    sheet_idx: usize,
    bounds: (u32, u32, u32, u32),
) -> Result<(), String> {
    let (sr, sc, er, ec) = bounds;
    let regions = state.protected_regions.lock().unwrap();
    if let Some(other) = regions.iter().find(|r| {
        r.sheet_index == sheet_idx
            && !(r.region_type == "report" && r.owner_id == report_id)
            && r.start_row <= er
            && r.end_row >= sr
            && r.start_col <= ec
            && r.end_col >= sc
    }) {
        let what = match other.region_type.as_str() {
            "pivot" => "a pivot table".to_string(),
            "report" => "another report".to_string(),
            t => format!("a {} region", t),
        };
        return Err(format!(
            "The report result (rows {}-{}, columns {}-{}) would overlap {}. Move the report or narrow the query.",
            sr + 1,
            er + 1,
            sc + 1,
            ec + 1,
            what
        ));
    }
    Ok(())
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

            // Merge bookkeeping targets THIS report's sheet (per-sheet store when
            // it isn't the active one — never the visible sheet's set).
            with_sheet_merges(state, sheet_idx, |merged| {
                if let Some(ref r) = old {
                    if r.sheet_index == sheet_idx {
                        merged.retain(|m| {
                            !(m.start_row >= r.start_row && m.end_row <= r.end_row
                                && m.start_col >= r.start_col && m.end_col <= r.end_col)
                        });
                    }
                }
                merged.retain(|m| {
                    !(m.start_row >= dest_row && m.end_row <= new_end_row
                        && m.start_col >= dest_col && m.end_col <= new_end_col)
                });
                for mr in merges {
                    merged.insert(mr);
                }
            });
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
        {
            let mut grids = state.grids.lock().unwrap();
            if let Some(dest_grid) = grids.get_mut(r.sheet_index) {
                clear_pivot_region_from_grid(dest_grid, r.start_row, r.start_col, r.end_row, r.end_col);
            }
        }
        let active_sheet = *state.active_sheet.lock().unwrap();
        if r.sheet_index == active_sheet {
            let mut active_grid = state.grid.lock().unwrap();
            active_grid.clear_region(r.start_row, r.start_col, r.end_row, r.end_col);
            active_grid.recalculate_bounds();
        }
        // Merge bookkeeping on the report's own sheet (not the visible one).
        with_sheet_merges(state, r.sheet_index, |merged| {
            merged.retain(|m| {
                !(m.start_row >= r.start_row && m.end_row <= r.end_row
                    && m.start_col >= r.start_col && m.end_col <= r.end_col)
            });
        });
    }
    let mut regions = state.protected_regions.lock().unwrap();
    regions.retain(|reg| !(reg.region_type == "report" && reg.owner_id == report_id));
}

/// Materialize a computed view for a report at (sheet, dest): write cells,
/// register the region, recalc dependent formulas. Overwrite counting happens
/// in the callers BEFORE this runs (it feeds the undo-policy decision).
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
) {
    write_report_to_grid(state, report_id, sheet_idx, dest, view);
    recalculate_sheet_formulas(state, pivot_state, Some((pane_control_state, ribbon_filter_state)));
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
    let end_row = request.anchor_row + (visible_rows.max(1) as u32) - 1;
    let end_col = request.anchor_col + (view.col_count.max(1) as u32) - 1;
    let bounds = (request.anchor_row, request.anchor_col, end_row, end_col);

    {
        let grids = state.grids.lock().unwrap();
        if request.sheet_index >= grids.len() {
            return Err(format!("Sheet {} does not exist.", request.sheet_index + 1));
        }
    }
    check_report_overlap(&state, report_id, request.sheet_index, bounds)?;
    let overwritten = count_report_overwrites(&state, report_id, request.sheet_index, dest, &view);

    // Undo snapshot: the target cells as they are now + the current report list.
    record_report_undo(&state, request.sheet_index, bounds, "Create report");

    materialize(
        &state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        report_id,
        request.sheet_index,
        dest,
        &view,
    );

    let data_source_id = connection_data_source_id(&bi_state, request.query.connection_id);
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
        data_source_id,
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
    let (sheet_idx, dest, old_bounds) = {
        let defs = state.report_definitions.lock().unwrap();
        let def = defs
            .iter()
            .find(|d| d.id == request.report_id)
            .ok_or_else(|| format!("Report {} not found", request.report_id))?;
        (
            def.sheet_index,
            (def.anchor_row, def.anchor_col),
            (def.anchor_row, def.anchor_col, def.end_row, def.end_col),
        )
    };

    let (_def, _cache, view) = compute_design_query_view(&bi_state, &request.query).await?;
    let visible_rows = view.rows.iter().filter(|r| r.visible).count();
    if visible_rows > MAX_REPORT_ROWS {
        return Err(format!(
            "This report has {} rows, over the {} row cap. Add filters to narrow it.",
            visible_rows, MAX_REPORT_ROWS
        ));
    }

    {
        let grids = state.grids.lock().unwrap();
        if sheet_idx >= grids.len() {
            return Err(format!(
                "This report's sheet (sheet {}) no longer exists.",
                sheet_idx + 1
            ));
        }
    }

    let end_row = dest.0 + (visible_rows.max(1) as u32) - 1;
    let end_col = dest.1 + (view.col_count.max(1) as u32) - 1;
    check_report_overlap(&state, request.report_id, sheet_idx, (dest.0, dest.1, end_row, end_col))?;
    let overwritten = count_report_overwrites(&state, request.report_id, sheet_idx, dest, &view);

    // Undo policy: manual refreshes always record (covering both the old and new
    // extents). Control-driven auto-refreshes only rewrite the report's own
    // output — recording one entry per filter click floods the undo stack and
    // makes Ctrl+Z desync the report from the visible filter state — so they
    // skip the entry UNLESS the write reaches user cells outside the previous
    // region (then it must stay undoable: that data would otherwise be lost).
    if !request.auto || overwritten > 0 {
        let box_bounds = union_bounds(old_bounds, (dest.0, dest.1, end_row, end_col));
        record_report_undo(&state, sheet_idx, box_bounds, "Refresh report");
    }

    materialize(
        &state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        request.report_id,
        sheet_idx,
        dest,
        &view,
    );

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
    // Undo snapshot: the report's cells + the current report list, before clearing.
    if let Some((sheet_idx, bounds)) = {
        let defs = state.report_definitions.lock().unwrap();
        defs.iter().find(|d| d.id == report_id).map(|d| {
            (d.sheet_index, (d.anchor_row, d.anchor_col, d.end_row, d.end_col))
        })
    } {
        record_report_undo(&state, sheet_idx, bounds, "Delete report");
    }

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

/// Materialize a report on a `.calp` subscriber (via the distributable-object
/// channel): rebind its BI connection by the stable data-source id and register
/// the definition + protected region. The report's CELLS travel with the
/// package's sheet content, so no query runs here — the subscriber sees the data
/// immediately, and a Refresh re-runs against the rebound connection.
///
/// Returns `Ok(Some(warning))` when the report was registered but its connection
/// could not be rebound (a later Refresh will fail until a matching connection
/// exists); the pull flow surfaces the warning instead of losing it.
#[tauri::command]
pub fn restore_report(
    state: State<'_, AppState>,
    bi_state: State<'_, BiState>,
    report: SavedReport,
) -> Result<Option<String>, String> {
    let mut report = report;

    {
        let grids = state.grids.lock().unwrap();
        if report.sheet_index >= grids.len() {
            return Err(format!(
                "Report '{}' targets sheet {} but this workbook has {} sheet(s).",
                report.name,
                report.sheet_index + 1,
                grids.len()
            ));
        }
    }

    // Rebind the connection: find the local connection whose stable data-source
    // id matches the report's (the publisher's connection id is stale here).
    let mut rebind_warning: Option<String> = None;
    let ds_opt = report.data_source_id.clone();
    if let Some(ds) = ds_opt.as_deref() {
        if let Ok(connections) = bi_state.connections.lock() {
            let rebound = connections.iter().find_map(|(cid, c)| {
                if c.package_data_source_id.as_deref() == Some(ds) || cid.to_string() == ds {
                    Some(*cid)
                } else {
                    None
                }
            });
            match rebound {
                Some(cid) => report.connection_id = cid,
                None => {
                    rebind_warning = Some(format!(
                        "Report '{}': no local BI connection matches its data source ({}). \
                         The report's cells are intact, but Refresh will fail until the \
                         connection's model is set up.",
                        report.name, ds
                    ));
                }
            }
        }
    }

    {
        let mut defs = state.report_definitions.lock().unwrap();
        defs.retain(|d| d.id != report.id);
        defs.push(report.clone());
    }
    reregister_report_region(&state, &report);
    sync_reports_to_extension_data(&state);
    Ok(rebind_warning)
}
