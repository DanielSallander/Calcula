//! FILENAME: app/src-tauri/src/report.rs
//! Grid reports: materialize a design query straight into a range of grid cells
//! (committed / pivot-like model). A report holds pivot-layout DSL + a model
//! binding; its result is written into the grid like a pivot's output,
//! refreshable and delete-able. Reuses the generic grid-write primitive
//! `write_pivot_to_grid` and the headless `compute_design_query_view` compute core.
//!
//! Implemented here: create / refresh / delete / list / restore, row-capped
//! block, overlap- and overwrite-guarded, region-tracked (region_type "report"),
//! persistence in extension_data (`read_reports` / `with_reports_mut` — the ONLY
//! two doors, see below), symmetric cell-based undo (`ReportUndoSnapshot` /
//! undo_commands::apply_report_restore), and `.calp` distribution
//! (`restore_report`). Interactive @param filters live frontend-side (Reports
//! extension). Still open: true pagination.
//!
//! # THE REPORT STORE HAS EXACTLY ONE REPRESENTATION
//!
//! Reports used to live in `AppState.report_definitions` (a bare `Mutex<Vec<_>>`)
//! AND in `extension_data["calcula.reports"]`, kept in step by a
//! `sync_reports_to_extension_data` call that every mutation site had to
//! REMEMBER. The saved bytes came from the mirror, so a mutation that forgot the
//! sync was silently dropped at save: no error, no prompt, the user's report
//! simply absent on reopen. Eleven call sites happened to be correct; nothing
//! made the twelfth correct.
//!
//! The store is gone. `extension_data[REPORTS_EXT_KEY]` is now the ONE
//! representation — the thing that is saved is the thing that is mutated — and
//! it is reached only through [`read_reports`] (immutable, no effect) and
//! [`with_reports_mut`] (requires a `DocumentEffect`, writes back before it
//! returns). There is no sync to forget because there is nothing to sync, and a
//! caller reaching for the old field does not compile.
//!
//! The slot is RESERVED against the generic extension-data tier
//! (`persistence::set_extension_data`) and against the `.calp` extension-data
//! merge, so the one remaining way to reach it — a dynamic string key over IPC —
//! is refused rather than allowed to clobber the reports.

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

/// Extension-data key under which reports live (the sanctioned, feature-neutral
/// workbook persistence channel — no new typed .cala field needed). This slot is
/// the report store itself, not a copy of one: see the module header.
///
/// It is deliberately identical to the Reports extension's manifest id, which is
/// exactly why it is RESERVED: `set_extension_data("calcula.reports", …)` would
/// otherwise be a legal call that silently replaced every report in the workbook.
pub const REPORTS_EXT_KEY: &str = "calcula.reports";

/// A saved grid report. Lives ONLY in `extension_data["calcula.reports"]`, read
/// through [`read_reports`] and mutated through [`with_reports_mut`]. The
/// materialized cells persist as ordinary grid content.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
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

/// Decode the reports slot. A slot that is absent, or present but unreadable,
/// reads as "no reports" — the same answer the loader gave before the collapse.
fn decode_reports(data: &std::collections::HashMap<String, serde_json::Value>) -> Vec<SavedReport> {
    data.get(REPORTS_EXT_KEY)
        .and_then(|v| serde_json::from_value::<Vec<SavedReport>>(v.clone()).ok())
        .unwrap_or_default()
}

/// A snapshot of the workbook's reports, as of the moment [`read_reports`] was
/// called. Derefs to `[SavedReport]`, so everything a reader wants — `iter`,
/// `find`, `len`, indexing — works; nothing a WRITER wants does.
///
/// That is the whole reason it exists rather than being a plain `Vec`. A `Vec`
/// handed out by a read is mutable, and `read_reports(&state).push(r)` compiles
/// and does nothing: the mutation lands on a copy that is dropped on the next
/// line. It is the same "my change did not survive" failure the collapse
/// removed, one scope smaller, so it is refused at the same place — the type.
#[derive(Debug, Clone, PartialEq)]
pub struct Reports(Vec<SavedReport>);

impl std::ops::Deref for Reports {
    type Target = [SavedReport];
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl Reports {
    /// Take the snapshot as an owned, mutable `Vec` — for callers that need to
    /// STORE it (the undo snapshot, the command return value), not for callers
    /// that want to change the workbook's reports. That is `with_reports_mut`.
    pub fn into_vec(self) -> Vec<SavedReport> {
        self.0
    }
}

impl<'a> IntoIterator for &'a Reports {
    type Item = &'a SavedReport;
    type IntoIter = std::slice::Iter<'a, SavedReport>;
    fn into_iter(self) -> Self::IntoIter {
        self.0.iter()
    }
}

/// READ the workbook's report definitions. Free — no `DocumentEffect`, no write.
///
/// Returns a snapshot rather than a guard on purpose: the slot is stored as
/// JSON, so there is no `&Vec<SavedReport>` inside `AppState` to borrow, and a
/// guard would only have handed callers a way to hold the `extension_data` lock
/// across arbitrary work. Reports are a handful per workbook and nothing on a
/// render path reads them.
pub fn read_reports(state: &AppState) -> Reports {
    let data = state.extension_data.read().unwrap();
    Reports(decode_reports(&data))
}

/// MUTATE the workbook's report definitions.
///
/// This is the only door to a report write, and it writes the result back before
/// it returns — so "the mutation happened but the workbook was not updated" is
/// not a state this code can be in. The `DocumentEffect` is the same gate every
/// other persisted store carries: a report change dirties the document.
///
/// Nothing is written when the closure changes nothing, so the callers that run
/// on every row/column insert and every sheet reorder do not stamp an empty
/// `"calcula.reports": []` into the extension-data of every workbook that has no
/// reports. Emptying the list removes the slot rather than storing `[]`.
///
/// The `extension_data` write guard is held across the closure: pass a closure
/// that touches the report list and nothing else.
pub fn with_reports_mut<R>(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    f: impl FnOnce(&mut Vec<SavedReport>) -> R,
) -> R {
    let mut data = state.extension_data.write(effect).unwrap();
    let before = decode_reports(&data);
    let mut defs = before.clone();
    let out = f(&mut defs);
    if defs != before {
        if defs.is_empty() {
            data.remove(REPORTS_EXT_KEY);
        } else if let Ok(v) = serde_json::to_value(&defs) {
            data.insert(REPORTS_EXT_KEY.to_string(), v);
        }
    }
    out
}

/// Re-point every report at its sheet's new index, dropping the reports whose
/// sheet is gone (`f` returns `None`).
///
/// This is the report half of a sheet delete / move / copy, and it is the exact
/// shape of `sheets::remap_sheet_keyed_stores`, which is called next to it at all
/// three sites — the three used to be three hand-written loops, each followed by
/// its own remembered persist call.
pub fn remap_report_sheets(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    f: impl Fn(usize) -> Option<usize>,
) {
    with_reports_mut(state, effect, |defs| {
        defs.retain(|d| f(d.sheet_index).is_some());
        for d in defs.iter_mut() {
            if let Some(i) = f(d.sheet_index) {
                d.sheet_index = i;
            }
        }
    });
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
///
/// READ-ONLY. The mutating half is [`with_sheet_merges_mut`], which demands a
/// `DocumentEffect`. Splitting them was forced by onboarding `merged_regions`
/// to `Persisted<T>` and is worth keeping: this function used to hand every
/// caller a `&mut` whether it wanted one or not, so "which of the 17 call sites
/// actually change the document?" could only be answered by reading all 17.
pub fn with_sheet_merges<R>(
    state: &AppState,
    sheet_idx: usize,
    f: impl FnOnce(&HashSet<MergedRegion>) -> R,
) -> R {
    let active = *state.active_sheet.read().unwrap();
    if sheet_idx == active {
        let merged = state.merged_regions.read().unwrap();
        f(&merged)
    } else {
        let all = state.all_merged_regions.read().unwrap();
        match all.get(sheet_idx) {
            Some(set) => f(set),
            // A sheet with no slot yet has no merges; growing the vector is a
            // write, and a READ must not perform one.
            None => f(&HashSet::new()),
        }
    }
}

/// The mutating half of [`with_sheet_merges`].
pub fn with_sheet_merges_mut<R>(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    sheet_idx: usize,
    f: impl FnOnce(&mut HashSet<MergedRegion>) -> R,
) -> R {
    let active = *state.active_sheet.read().unwrap();
    if sheet_idx == active {
        let mut merged = state.merged_regions.write(effect).unwrap();
        f(&mut merged)
    } else {
        let mut all = state.all_merged_regions.write(effect).unwrap();
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
    let grids = state.grids.read().unwrap();
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
    let definitions = read_reports(state).into_vec();
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
    /// When set (Edit Design Query), the stored DSL text is replaced along with
    /// the re-materialization — one undoable step covering cells + definition.
    #[serde(default)]
    pub dsl_text: Option<String>,
    /// When set, the report is renamed in the same step.
    #[serde(default)]
    pub name: Option<String>,
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
    let grids = state.grids.read().unwrap();
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
    effect: &crate::document_effect::DocumentEffect,
    report_id: ReportId,
    sheet_idx: usize,
    dest: (u32, u32),
    view: &pivot_engine::PivotView,
) {
    let old = get_report_region(state, report_id);

    {
        // CANONICAL LOCK ORDER: `grid` (the active-sheet mirror) BEFORE `grids`,
        // and both BEFORE every other store. The recalculation pass runs on a
        // background thread and takes them in that order and holds both while it
        // goes on to take `style_registry`; anything that takes them the other
        // way round deadlocks the whole app with no panic and no log line. The
        // mirror is taken unconditionally here — it used to be acquired inside
        // the `sheet_idx == active_sheet` branch, below `grids` — which costs a
        // slightly wider critical section and buys the one order.
        let mut active_grid = state.grid.write(&effect).unwrap();
        let mut grids = state.grids.write(&effect).unwrap();
        let mut styles = state.style_registry.write(effect).unwrap();
        if let Some(dest_grid) = grids.get_mut(sheet_idx) {
            if let Some(ref r) = old {
                if r.sheet_index == sheet_idx {
                    clear_pivot_region_from_grid(dest_grid, r.start_row, r.start_col, r.end_row, r.end_col);
                }
            }

            let active_sheet = *state.active_sheet.read().unwrap();
            let merges = if sheet_idx == active_sheet {
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
            with_sheet_merges_mut(state, effect, sheet_idx, |merged| {
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

fn clear_report_region(state: &AppState, effect: &crate::document_effect::DocumentEffect, report_id: ReportId) {
    let old = get_report_region(state, report_id);
    if let Some(r) = old {
        {
            let mut grids = state.grids.write(&effect).unwrap();
            if let Some(dest_grid) = grids.get_mut(r.sheet_index) {
                clear_pivot_region_from_grid(dest_grid, r.start_row, r.start_col, r.end_row, r.end_col);
            }
        }
        let active_sheet = *state.active_sheet.read().unwrap();
        if r.sheet_index == active_sheet {
            let mut active_grid = state.grid.write(&effect).unwrap();
            active_grid.clear_region(r.start_row, r.start_col, r.end_row, r.end_col);
            active_grid.recalculate_bounds();
        }
        // Merge bookkeeping on the report's own sheet (not the visible one).
        with_sheet_merges_mut(state, effect, r.sheet_index, |merged| {
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
    // Required so a caller cannot materialize a report without first deciding what it
    // does to the saved document. It is now genuinely CONSUMED: `AppState.grids` is a
    // `Persisted<T>`, so the cells this writes present exactly this token.
    effect: &crate::document_effect::DocumentEffect,
    state: &AppState,
    pivot_state: &PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    report_id: ReportId,
    sheet_idx: usize,
    dest: (u32, u32),
    view: &pivot_engine::PivotView,
) {
    write_report_to_grid(state, effect, report_id, sheet_idx, dest, view);
    recalculate_sheet_formulas(state, pivot_state, Some((pane_control_state, ribbon_filter_state)));
}

// ============================================================================
// Commands
// ============================================================================

/// Create a report: run its design query and materialize the result into the grid.
#[tauri::command]
pub async fn create_report(
    state: State<'_, AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    bi_state: State<'_, BiState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: CreateReportRequest,
) -> Result<ReportResult, String> {
    let (_def, _cache, view) = compute_design_query_view(&bi_state, &request.query).await?;
    // The query resolved; everything below writes grid cells and the report
    // registry. Built after the await so a failed query leaves the doc clean.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
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
        let grids = state.grids.read().unwrap();
        if request.sheet_index >= grids.len() {
            return Err(format!("Sheet {} does not exist.", request.sheet_index + 1));
        }
    }
    check_report_overlap(&state, report_id, request.sheet_index, bounds)?;
    let overwritten = count_report_overwrites(&state, report_id, request.sheet_index, dest, &view);

    // Undo snapshot: the target cells as they are now + the current report list.
    record_report_undo(&state, request.sheet_index, bounds, "Create report");

    materialize(
        &effect,
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
    with_reports_mut(&state, &effect, |defs| {
        defs.push(SavedReport {
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
    });

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
    file_state: State<'_, crate::persistence::FileState>,
    bi_state: State<'_, BiState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: RefreshReportRequest,
) -> Result<ReportResult, String> {
    let (sheet_idx, dest, old_bounds) = {
        let defs = read_reports(&state);
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
    // The query resolved and the report exists. Everything below rewrites the
    // report's grid region and the definition registry (mirrored into
    // `workbook.extension_data`), so it changes what a save writes.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let visible_rows = view.rows.iter().filter(|r| r.visible).count();
    if visible_rows > MAX_REPORT_ROWS {
        return Err(format!(
            "This report has {} rows, over the {} row cap. Add filters to narrow it.",
            visible_rows, MAX_REPORT_ROWS
        ));
    }

    {
        let grids = state.grids.read().unwrap();
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
        &effect,
        &state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        request.report_id,
        sheet_idx,
        dest,
        &view,
    );

    with_reports_mut(&state, &effect, |defs| {
        if let Some(d) = defs.iter_mut().find(|d| d.id == request.report_id) {
            d.end_row = end_row;
            d.end_col = end_col;
            // Edit Design Query: persist the new DSL/name with the same
            // materialization (the undo snapshot above captured the OLD
            // definition, so Ctrl+Z reverts text + cells together).
            if let Some(text) = &request.dsl_text {
                d.dsl_text = text.clone();
            }
            if let Some(name) = &request.name {
                d.name = name.clone();
            }
        }
    });

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
    file_state: State<'_, crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    report_id: ReportId,
) -> Result<(), String> {
    // Deleting a report clears its grid region and drops the definition.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    // Undo snapshot: the report's cells + the current report list, before clearing.
    if let Some((sheet_idx, bounds)) = read_reports(&state)
        .iter()
        .find(|d| d.id == report_id)
        .map(|d| (d.sheet_index, (d.anchor_row, d.anchor_col, d.end_row, d.end_col)))
    {
        record_report_undo(&state, sheet_idx, bounds, "Delete report");
    }

    clear_report_region(&state, &effect, report_id);
    with_reports_mut(&state, &effect, |defs| defs.retain(|d| d.id != report_id));
    recalculate_sheet_formulas(&state, &pivot_state, Some((&pane_control_state, &ribbon_filter_state)));
    Ok(())
}

/// List all report definitions.
#[tauri::command]
pub fn list_reports(state: State<'_, AppState>) -> Result<Vec<SavedReport>, String> {
    Ok(read_reports(&state).into_vec())
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
    file_state: State<'_, crate::persistence::FileState>,
    bi_state: State<'_, BiState>,
    report: SavedReport,
) -> Result<Option<String>, String> {
    // Restoring re-materializes the report into the grid and re-registers it.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut report = report;

    {
        let grids = state.grids.read().unwrap();
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

    with_reports_mut(&state, &effect, |defs| {
        defs.retain(|d| d.id != report.id);
        defs.push(report.clone());
    });
    reregister_report_region(&state, &report);
    Ok(rebind_warning)
}

// ============================================================================
// TESTS -- the report store, end to end
// ============================================================================
//
// WHAT THESE EXIST FOR
// --------------------
// The bug they close was not a wrong value; it was a mutation that happened and
// then was not there next time the workbook opened. So the acceptance criterion
// is deliberately NOT "the persist helper was called" -- that is exactly the
// assertion that would have passed on the broken code, because the broken code's
// eleven call sites all called it. Every test below ends in a REAL `.cala` on
// disk being reopened and asked for its reports.
//
// The routes are driven at the lowest production-owned function each one has.
// `create_report` / `refresh_report` / `delete_report` / `restore_report` are
// `#[tauri::command]`s taking `State<'_, _>`, which no test in this crate can
// construct, so their store step is driven through the same door they use --
// which is the point of the collapse: there is now exactly one such door, and
// the compile-time half of this file's guarantee is what proves the commands go
// through it.

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::document_effect::{CleanReason, DocumentEffect};
    use crate::persistence::FileState;

    /// A report on `sheet_index`, with a distinguishable name.
    pub(crate) fn a_report(sheet_index: usize) -> SavedReport {
        SavedReport {
            id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            name: format!("Sales on sheet {}", sheet_index + 1),
            dsl_text: "ROWS: Product\nVALUES: SUM(Amount)".to_string(),
            connection_id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            sheet_index,
            anchor_row: 3,
            anchor_col: 1,
            end_row: 12,
            end_col: 4,
            data_source_id: Some("ds-sales".to_string()),
        }
    }

    fn mutating() -> (AppState, FileState) {
        (crate::create_app_state(), FileState::default())
    }

    /// THE ACCEPTANCE STEP: put this state's workbook on disk as a real `.cala`
    /// and open it again, returning the state the user would be looking at.
    ///
    /// The two lines that move `extension_data` in and out are copied verbatim
    /// from `build_workbook_for_save_with_slicers` and the loader, because those
    /// are `State<'_, _>`-taking functions; everything between them is the real
    /// format doing real work in a real ZIP.
    fn saved_and_reloaded(state: &AppState) -> AppState {
        let mut workbook = ::persistence::Workbook::new();
        workbook.extension_data = state.extension_data.read().unwrap().clone();

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("reports.cala");
        calcula_format::save_calcula(&workbook, &path).unwrap();
        let loaded = calcula_format::load_calcula(&path).unwrap();

        let reopened = crate::create_app_state();
        let load = DocumentEffect::deliberately_clean(CleanReason::LoadingFromDisk);
        *reopened.extension_data.write(&load).unwrap() = loaded.extension_data.clone();
        reopened
    }

    /// The names of the reports a reopened workbook has, sorted.
    fn reopened_report_names(state: &AppState) -> Vec<String> {
        let mut names: Vec<String> = read_reports(&saved_and_reloaded(state))
            .iter()
            .map(|r| r.name.clone())
            .collect();
        names.sort();
        names
    }

    // ------------------------------------------------------------------
    // Route by route: mutate -> save -> reload -> still there
    // ------------------------------------------------------------------

    /// Route 1: `create_report`.
    #[test]
    fn a_created_report_survives_save_and_reload() {
        let (state, fs) = mutating();
        let effect = DocumentEffect::mutates(&fs);
        with_reports_mut(&state, &effect, |defs| defs.push(a_report(0)));

        assert_eq!(reopened_report_names(&state), vec!["Sales on sheet 1"]);
    }

    /// Route 2: `refresh_report` -- the in-place edit (new bounds, and the Edit
    /// Design Query rename + DSL replacement).
    #[test]
    fn a_refreshed_reports_new_bounds_and_text_survive_save_and_reload() {
        let (state, fs) = mutating();
        let effect = DocumentEffect::mutates(&fs);
        let report = a_report(0);
        let id = report.id;
        with_reports_mut(&state, &effect, |defs| defs.push(report));

        with_reports_mut(&state, &effect, |defs| {
            let d = defs.iter_mut().find(|d| d.id == id).unwrap();
            d.end_row = 40;
            d.end_col = 7;
            d.dsl_text = "ROWS: Region\nVALUES: SUM(Amount)".to_string();
            d.name = "Sales by region".to_string();
        });

        let reopened = read_reports(&saved_and_reloaded(&state));
        assert_eq!(reopened.len(), 1);
        assert_eq!(reopened[0].name, "Sales by region");
        assert_eq!(reopened[0].dsl_text, "ROWS: Region\nVALUES: SUM(Amount)");
        assert_eq!((reopened[0].end_row, reopened[0].end_col), (40, 7));
    }

    /// Route 3: `delete_report`. The negative half -- a deletion that does not
    /// reach the file is the same bug wearing the other hat.
    #[test]
    fn a_deleted_report_stays_deleted_after_save_and_reload() {
        let (state, fs) = mutating();
        let effect = DocumentEffect::mutates(&fs);
        let keep = a_report(0);
        let drop = a_report(1);
        let drop_id = drop.id;
        with_reports_mut(&state, &effect, |defs| {
            defs.push(keep);
            defs.push(drop);
        });

        with_reports_mut(&state, &effect, |defs| defs.retain(|d| d.id != drop_id));

        assert_eq!(reopened_report_names(&state), vec!["Sales on sheet 1"]);
    }

    /// Route 4: `restore_report` -- the `.calp` pull, which replaces by id.
    #[test]
    fn a_restored_report_replaces_by_id_and_survives_save_and_reload() {
        let (state, fs) = mutating();
        let effect = DocumentEffect::mutates(&fs);
        let original = a_report(0);
        with_reports_mut(&state, &effect, |defs| defs.push(original.clone()));

        let mut pulled = original.clone();
        pulled.name = "Sales (from package)".to_string();
        with_reports_mut(&state, &effect, |defs| {
            defs.retain(|d| d.id != pulled.id);
            defs.push(pulled);
        });

        assert_eq!(reopened_report_names(&state), vec!["Sales (from package)"]);
    }

    /// Route 5: sheet DELETE -- reports on the deleted sheet go, the ones above
    /// it slide down.
    #[test]
    fn deleting_a_sheet_drops_and_reindexes_reports_through_save_and_reload() {
        let (state, fs) = mutating();
        let effect = DocumentEffect::mutates(&fs);
        with_reports_mut(&state, &effect, |defs| {
            defs.push(a_report(0));
            defs.push(a_report(1));
            defs.push(a_report(2));
        });

        // Sheet 2 (index 1) is deleted.
        remap_report_sheets(&state, &effect, |i| match i.cmp(&1) {
            std::cmp::Ordering::Equal => None,
            std::cmp::Ordering::Greater => Some(i - 1),
            std::cmp::Ordering::Less => Some(i),
        });

        let reopened = read_reports(&saved_and_reloaded(&state));
        let mut sheets: Vec<usize> = reopened.iter().map(|r| r.sheet_index).collect();
        sheets.sort();
        assert_eq!(sheets, vec![0, 1]);
        assert!(
            !reopened.iter().any(|r| r.name == "Sales on sheet 2"),
            "the deleted sheet's report came back on reopen -- the next refresh \
             would materialize it onto whichever sheet inherited its index"
        );
    }

    /// Route 6: sheet MOVE / COPY -- pure reindexing.
    #[test]
    fn moving_a_sheet_reindexes_reports_through_save_and_reload() {
        let (state, fs) = mutating();
        let effect = DocumentEffect::mutates(&fs);
        with_reports_mut(&state, &effect, |defs| defs.push(a_report(2)));

        // A copy inserted at index 0 pushes everything up by one.
        remap_report_sheets(&state, &effect, |i| Some(i + 1));

        let reopened = read_reports(&saved_and_reloaded(&state));
        assert_eq!(reopened.len(), 1);
        assert_eq!(reopened[0].sheet_index, 3);
    }

    /// Route 7: row/column insert + delete, which shift the report's protected
    /// region and then pull the definition back onto it. Driven through the
    /// production helper (`commands::structure::sync_report_definitions_to_regions`)
    /// with the region already shifted, exactly as the insert/delete commands
    /// leave it.
    #[test]
    fn a_row_insert_shift_reaches_the_file_not_just_the_region_index() {
        let (state, fs) = mutating();
        let effect = DocumentEffect::mutates(&fs);
        let report = a_report(0);
        let id = report.id;
        with_reports_mut(&state, &effect, |defs| defs.push(report.clone()));
        reregister_report_region(&state, &report);

        // Two rows inserted above the report: the generic region shift has
        // already moved the region.
        {
            let mut regions = state.protected_regions.lock().unwrap();
            for r in regions.iter_mut() {
                r.start_row += 2;
                r.end_row += 2;
            }
        }
        crate::commands::structure::sync_report_definitions_to_regions(&state, &effect);

        let reopened = read_reports(&saved_and_reloaded(&state));
        let d = reopened.iter().find(|d| d.id == id).unwrap();
        assert_eq!(
            (d.anchor_row, d.end_row),
            (5, 14),
            "the shifted anchor never reached the file, so the next refresh after a \
             reopen would re-materialize the report at its pre-insert coordinates"
        );
    }

    /// Route 8: undo of a report mutation. `apply_report_restore` swaps the
    /// whole list back and hands the previous one to the redo entry.
    #[test]
    fn undoing_a_report_creation_reaches_the_file() {
        let (state, fs) = mutating();
        let effect = DocumentEffect::mutates(&fs);
        with_reports_mut(&state, &effect, |defs| defs.push(a_report(0)));

        // The undo snapshot was taken before the create: an empty list.
        let redo_defs = with_reports_mut(&state, &effect, |defs| std::mem::take(defs));

        assert_eq!(redo_defs.len(), 1, "the redo entry lost the created report");
        assert!(
            read_reports(&saved_and_reloaded(&state)).is_empty(),
            "an undone report came back when the workbook was reopened"
        );
    }

    /// Route 9: opening a workbook. The definitions need no restoring at all --
    /// they arrive with `extension_data` -- so the loader only rebuilds the
    /// derived region index.
    #[test]
    fn opening_a_workbook_registers_a_protected_region_per_saved_report() {
        let (state, fs) = mutating();
        let effect = DocumentEffect::mutates(&fs);
        with_reports_mut(&state, &effect, |defs| {
            defs.push(a_report(0));
            defs.push(a_report(1));
        });

        let reopened = saved_and_reloaded(&state);
        for r in &read_reports(&reopened) {
            reregister_report_region(&reopened, r);
        }

        let regions = reopened.protected_regions.lock().unwrap();
        assert_eq!(
            regions.iter().filter(|r| r.region_type == "report").count(),
            2,
            "a reopened report with no protected region is writable straight over"
        );
    }

    /// Route 10: File > New. The reports go with `extension_data`, because they
    /// ARE `extension_data` -- there is no second copy left holding the previous
    /// workbook's reports into the blank one.
    #[test]
    fn a_new_workbook_starts_with_no_reports() {
        let (state, fs) = mutating();
        let effect = DocumentEffect::mutates(&fs);
        with_reports_mut(&state, &effect, |defs| defs.push(a_report(0)));

        let reset = DocumentEffect::deliberately_clean(CleanReason::LoadingFromDisk);
        state.extension_data.write(&reset).unwrap().clear();

        assert!(read_reports(&state).is_empty());
        assert!(reopened_report_names(&state).is_empty());
    }

    // ------------------------------------------------------------------
    // The slot is not free-form extension state
    // ------------------------------------------------------------------

    /// The Reports extension's manifest id IS `calcula.reports`. Every other
    /// extension persists with `setExtensionData(EXTENSION_ID, ...)`, so this is
    /// not a hypothetical collision -- it is the idiom, pointed at the store.
    #[test]
    fn the_generic_extension_data_tier_refuses_the_reserved_reports_key() {
        let (state, fs) = mutating();
        let effect = DocumentEffect::mutates(&fs);
        with_reports_mut(&state, &effect, |defs| defs.push(a_report(0)));

        let err = crate::persistence::set_extension_data_impl(
            &state,
            &fs,
            REPORTS_EXT_KEY.to_string(),
            Some(serde_json::json!({ "lastOpenedTab": "design" })),
        )
        .expect_err("the reports slot is not free-form extension state");
        assert!(err.contains("reserved"), "unhelpful refusal: {}", err);

        assert_eq!(
            reopened_report_names(&state),
            vec!["Sales on sheet 1"],
            "an ordinary setExtensionData call replaced every report in the workbook"
        );
    }

    /// An ordinary extension key is unaffected -- the guard is a reservation,
    /// not a lockdown of the tier.
    #[test]
    fn an_ordinary_extension_key_still_writes() {
        let (state, fs) = mutating();
        crate::persistence::set_extension_data_impl(
            &state,
            &fs,
            "calcula.animation".to_string(),
            Some(serde_json::json!({ "drivers": [] })),
        )
        .expect("the sanctioned extension persistence tier still works");
        assert!(state
            .extension_data
            .read()
            .unwrap()
            .contains_key("calcula.animation"));
    }

    // ------------------------------------------------------------------
    // The structural guarantee
    // ------------------------------------------------------------------

    /// Lines with the `//` comment prefix stripped, so a mention of the key in
    /// prose does not count as reaching it.
    fn code_lines(src: &str) -> impl Iterator<Item = &str> {
        src.lines().filter(|l| !l.trim_start().starts_with("//"))
    }

    /// THE STORE HAS ONE REPRESENTATION, AND THE CHECK IS ON THE SOURCE TEXT
    /// BECAUSE THERE IS NOTHING ELSE TO CHECK.
    ///
    /// Re-adding `pub report_definitions: Mutex<Vec<SavedReport>>` to `AppState`
    /// compiles, `.lock()` hands back a guard, and the whole defect is back --
    /// a store whose contents reach the file only if somebody remembers to copy
    /// them over. The failure this test exists for is a future author adding a
    /// "cache so we don't deserialize on every read".
    #[test]
    fn appstate_holds_no_second_copy_of_the_report_store() {
        let lib = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs"),
        )
        .expect("lib.rs");

        let offender = code_lines(&lib)
            .map(str::trim)
            .find(|l| l.starts_with("pub ") && l.contains("SavedReport"));
        assert!(
            offender.is_none(),
            "AppState grew a second copy of the report store:\n      {}\n\
             The reports live in extension_data[\"calcula.reports\"] and nowhere else \
             (report::read_reports / report::with_reports_mut). A cached Vec here has \
             to be hand-synced into that slot, and the saved bytes come from the slot \
             -- which is precisely the data-loss shape this collapse removed.",
            offender.unwrap_or_default()
        );
    }

    /// The slot itself has ONE writer, and the files allowed to name it at all
    /// carry their reason here -- so a new one has to be argued for rather than
    /// merely made to compile.
    #[test]
    fn only_report_rs_reaches_the_reports_slot() {
        // (file, why it may name the key)
        let sanctioned: &[(&str, &str)] = &[
            ("report.rs", "declares the key and owns both doors to it"),
            (
                "persistence.rs",
                "REFUSES it in the generic extension-data tier (reject_reserved_extension_key)",
            ),
            (
                "calp_commands.rs",
                "SKIPS it in the .calp extension-data merge (reports arrive via restore_report)",
            ),
        ];

        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders: Vec<String> = Vec::new();
        let mut stack = vec![root];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).expect("src is readable") {
                let path = entry.expect("dir entry").path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                    continue;
                }
                let name = path.file_name().unwrap().to_string_lossy().to_string();
                if sanctioned.iter().any(|(f, _)| *f == name) || name.contains("tests") {
                    continue;
                }
                let src = std::fs::read_to_string(&path).expect("source is readable");
                for (n, line) in code_lines(&src).enumerate() {
                    if line.contains("REPORTS_EXT_KEY") || line.contains("\"calcula.reports\"") {
                        offenders.push(format!("{}:{}  {}", name, n + 1, line.trim()));
                    }
                }
            }
        }

        assert!(
            offenders.is_empty(),
            "these reach the reports slot by key instead of through \
             report::read_reports / report::with_reports_mut:\n  {}\n\
             Only {} may name it.",
            offenders.join("\n  "),
            sanctioned
                .iter()
                .map(|(f, why)| format!("{} ({})", f, why))
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
}

