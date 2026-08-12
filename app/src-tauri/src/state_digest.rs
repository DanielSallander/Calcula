//! FILENAME: app/src-tauri/src/state_digest.rs
// PURPOSE: Canonical workbook-state digest for e2e testing oracles.
// CONTEXT: The digest captures everything undo/redo and save/reload must
// preserve, assembled directly from AppState (NOT the save path, which is
// lossy). Test oracles compare two digests to detect state corruption:
//   - undo round-trip:    digest -> N actions -> undo N -> digest must match
//   - save/reload:        digest -> save -> open -> digest must match
//   - recalc consistency: digest cells -> calculate_now -> cells must match
//
// Determinism rules:
//   - Collections derived from HashMaps are emitted as BTreeMaps (sorted keys)
//     or sorted Vecs so two digests of identical state serialize identically.
//   - Volatile state is excluded: timestamps, undo stack, dependency maps,
//     file path, locale, selection/scroll, id registry, calp subscriptions.
// Hashing/canonicalization happens on the TypeScript side (app/e2e/oracles/).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::AppState;
use crate::log_info;

// ============================================================================
// TYPES
// ============================================================================

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestOptions {
    /// When true, only sheet cell content is captured (faster; used by the
    /// recalc-consistency oracle which only cares about values).
    #[serde(default)]
    pub cells_only: bool,
}

/// One cell, in canonical form.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellDigest {
    /// Formatted display text (what the user sees).
    pub v: String,
    /// The raw CellValue as JSON (catches changes invisible in display text).
    pub raw: Value,
    /// Canonical (non-localized) formula without leading '=', if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub f: Option<String>,
    /// Style index into usedStyles.
    pub s: usize,
    /// Rich text runs, if any.
    #[serde(skip_serializing_if = "Value::is_null")]
    pub rt: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetDigest {
    pub name: String,
    /// Cells keyed "row:col".
    pub cells: BTreeMap<String, CellDigest>,
    /// Merged regions as [startRow, startCol, endRow, endCol], sorted.
    pub merged_regions: Vec<[u32; 4]>,
    pub freeze_row: Option<u32>,
    pub freeze_col: Option<u32>,
    pub col_widths: BTreeMap<u32, f64>,
    pub row_heights: BTreeMap<u32, f64>,
    /// Rows/columns the user hid by hand, ascending. In the digest because the
    /// save/reload oracle was structurally blind to them: hiding a row produced
    /// an identical digest before and after a round-trip, which is exactly how
    /// the hide-is-never-persisted bug stayed green.
    pub user_hidden_rows: Vec<u32>,
    pub user_hidden_cols: Vec<u32>,
    /// Row/column style tiers (`Grid.row_styles` / `Grid.column_styles`).
    /// Without these the round-trip oracles were structurally blind to tier
    /// loss — a whole-column lock or format change produced an identical
    /// digest, which is exactly how two tier-dropping bugs stayed green.
    /// Indices resolve through `used_styles` like cell style indices do.
    pub row_styles: BTreeMap<u32, usize>,
    pub column_styles: BTreeMap<u32, usize>,
    pub tab_color: String,
    pub visibility: String,
    pub show_gridlines: bool,
    pub page_setup: Value,
    pub split: Value,
    /// Per-sheet zoom percent. In the digest for the same reason the
    /// user-hidden sets are: without it a save/reload that dropped the zoom
    /// produced a byte-identical digest, so the oracle was structurally blind
    /// to losing it.
    pub zoom: f64,
    pub scroll_area: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookStateDigest {
    /// Digest format version. Bump when the shape changes; the TS side checks.
    pub version: u32,
    pub active_sheet: usize,
    pub sheet_names: Vec<String>,
    /// Parallel to sheet_names (order is meaningful).
    pub sheets: Vec<SheetDigest>,
    /// Styles referenced by at least one cell: index -> CellStyle JSON.
    /// Style indices are not stable across save/reload; the saveReload diff
    /// profile resolves indices through this map and compares content.
    pub used_styles: BTreeMap<usize, Value>,
    pub named_ranges: BTreeMap<String, Value>,
    pub named_styles: BTreeMap<String, Value>,
    /// Table id -> Table.
    pub tables: BTreeMap<String, Value>,
    pub slicers: BTreeMap<String, Value>,
    pub ribbon_filters: BTreeMap<String, Value>,
    /// Chart id -> ChartEntry.
    pub charts: BTreeMap<String, Value>,
    /// Sheet index -> sorted sparkline groups_json strings.
    pub sparklines: BTreeMap<String, Vec<String>>,
    /// Pivot id -> PivotDefinition JSON (cache is derived state, excluded).
    pub pivots: BTreeMap<String, Value>,
    /// Sheet index -> conditional format definitions (rule order preserved).
    pub conditional_formats: BTreeMap<String, Value>,
    /// Sheet index -> validation ranges (order preserved).
    pub data_validations: BTreeMap<String, Value>,
    /// "sheet:row:col" -> Comment.
    pub comments: BTreeMap<String, Value>,
    /// "sheet:row:col" -> Note.
    pub notes: BTreeMap<String, Value>,
    /// "sheet:row:col" -> Hyperlink.
    pub hyperlinks: BTreeMap<String, Value>,
    /// Sheet index -> AutoFilter.
    pub auto_filters: BTreeMap<String, Value>,
    /// Sheet index -> SheetOutline (row/column grouping).
    pub outlines: BTreeMap<String, Value>,
    /// Sheet index -> scenarios.
    pub scenarios: BTreeMap<String, Value>,
    /// "sheet:row:col" -> ControlMetadata.
    pub controls: BTreeMap<String, Value>,
    /// Sheet index -> SheetComputedProperties.
    pub computed_properties: BTreeMap<String, Value>,
    /// Sheet index -> SheetProtection.
    pub sheet_protection: BTreeMap<String, Value>,
    // NOTE: no `cell_protection` field. Cell lock state is a CellStyle
    // attribute now, so it is already captured per cell via `used_styles`
    // (see digest_cells); a separate map would be a second, divergable copy.
    pub workbook_protection: Value,
    /// Sheet index -> hidden row indices (advanced filter), sorted.
    pub advanced_filter_hidden_rows: BTreeMap<String, Vec<u32>>,
    /// Protected regions sorted by id. Extension-registered (pivot/chart);
    /// TS diff profiles may exclude these (re-registration timing varies).
    pub protected_regions: Vec<Value>,
    pub pivot_layouts: Vec<Value>,
    pub object_scripts: Vec<Value>,
    pub theme: Value,
    pub defaults: Value,
}

// ============================================================================
// HELPERS
// ============================================================================

fn to_value_or_null<T: Serialize>(v: &T) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

/// Stable string key for any serializable id type (EntityId, PivotId, ...).
fn id_key<T: Serialize>(id: &T) -> String {
    match serde_json::to_value(id) {
        Ok(Value::String(s)) => s,
        Ok(other) => other.to_string(),
        Err(_) => String::from("<unserializable-id>"),
    }
}

fn cell_key(row: u32, col: u32) -> String {
    format!("{}:{}", row, col)
}

fn sheet_cell_key(sheet: usize, row: u32, col: u32) -> String {
    format!("{}:{}:{}", sheet, row, col)
}

/// Build the cell map for one grid and record used style indices.
fn digest_cells(
    grid: &engine::Grid,
    styles: &engine::StyleRegistry,
    locale: &engine::LocaleSettings,
    used_styles: &mut BTreeMap<usize, Value>,
) -> BTreeMap<String, CellDigest> {
    let mut cells = BTreeMap::new();
    for ((row, col), cell) in grid.cells.iter() {
        let style = styles.get(cell.style_index);
        used_styles
            .entry(cell.style_index)
            .or_insert_with(|| to_value_or_null(style));
        cells.insert(
            cell_key(*row, *col),
            CellDigest {
                v: crate::format_cell_value(&cell.value, style, locale),
                raw: to_value_or_null(&cell.value),
                f: cell.formula_string(),
                s: cell.style_index,
                rt: to_value_or_null(&cell.rich_text),
            },
        );
    }
    cells
}

// ============================================================================
// COMMAND
// ============================================================================

/// Build a canonical digest of the full workbook state for testing oracles.
///
/// Reads the active sheet from the `state.grid` mirror (NOT `grids[active]`,
/// which is stale — see get_watch_cells in commands/data.rs) and all other
/// sheets from `state.grids`.
// ============================================================================
// DEADLOCK WATCHDOG
// ============================================================================
//
// TWICE IN ONE SESSION the app stopped answering with this function's own entry
// line as the last thing in the log and no completion, no panic and no crash --
// once on soak seed 20260810, once on 1786446166374. A hang leaves no evidence
// at all: the window goes "Not Responding", every later test in the run fails
// against a dead page, and the only thing anyone can say afterwards is "it was
// in the digest somewhere".
//
// THE SECOND WEDGE WAS NOT IN THE DIGEST, AND "THE LAST LINE IN THE LOG" IS WHY
// ANYONE THOUGHT IT WAS (measured 2026-08-11).
//
// The first one was: `build_workbook_state_digest` really did take `grids`
// before `grid`. The second one was `open_file` -> `restore_spill_map_on_load`
// -> `recover_spill_map_by_evaluation`, holding `sheet_names` and waiting for
// `grids` while the gather-refresh worker held both grid locks and waited for
// `sheet_names`. That was established by suspending the wedged process and
// walking every thread's stack from OUTSIDE it -- because, as this watchdog
// discovered the hard way, nothing inside the process can report: the log file
// is written through a `BufWriter` that is never flushed on this path, so the
// last few kilobytes of the log do not exist on disk and the "last line" is
// simply the last line that happened to fit. A digest entry with no completion
// is therefore NOT evidence that the digest did not complete.
//
// The watchdog is kept, because naming the phase is still the right instrument
// and it costs one relaxed store per phase. What is corrected here is the
// CONCLUSION anyone should draw from it: if it does not print, that is not the
// digest being stuck, it is the logger being downstream of the wedge. Get the
// stacks.
//
// The digest takes about thirty locks. `Persisted<T>` is a **Mutex**, not an
// RwLock -- `read()` is `lock()` -- so every one of them excludes every other
// holder, and any of them can be the one. Knowing WHICH is the whole diagnosis,
// and it is the one thing the log could not say.
//
// So the digest now announces the phase it is in, and a watchdog thread prints
// the last phase reached if the call has not finished. It costs one relaxed
// atomic store per phase and one thread per digest -- the digest is a test-only
// oracle command, invoked a few times per checkpoint, so that is nothing.
//
// This does not FIX a deadlock. It converts one from "the app is wedged and
// nobody knows why" into a line naming the section, which is the difference
// between a defect that can be fixed and one that has now cost three passes.

/// Phase names, indexed by the atomic below. Order is the digest's own order.
const DIGEST_PHASES: &[&str] = &[
    "0: entry",
    "1: per-sheet block (grid, grids, dims, merges, freeze, tab colors, zoom)",
    "2: named ranges + named styles",
    "3: tables",
    "4: slicers + ribbon filters + charts + sparklines",
    "5: pivots",
    "6: conditional formats + data validation",
    "7: comments + notes + hyperlinks + auto filters + outlines + scenarios",
    "8: controls + computed properties",
    "9: protection + advanced-filter hidden rows",
    "10: protected regions + pivot layouts + object scripts + theme + defaults",
    "11: assembling the result",
];

static DIGEST_PHASE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn digest_phase(index: usize) {
    DIGEST_PHASE.store(index, std::sync::atomic::Ordering::Relaxed);
}

/// Prints the last phase reached if the digest has not returned in time.
struct DigestWatchdog {
    finished: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl DigestWatchdog {
    /// How long a digest may take before it is reported as stuck. Generous: a
    /// full digest of a large workbook on a debug build is still well under a
    /// second, and this must never cry wolf on a merely slow machine.
    const BUDGET: std::time::Duration = std::time::Duration::from_secs(30);

    fn start() -> Self {
        digest_phase(0);
        let finished = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = std::sync::Arc::clone(&finished);
        std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Self::BUDGET;
            while std::time::Instant::now() < deadline {
                if flag.load(std::sync::atomic::Ordering::Relaxed) {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            if flag.load(std::sync::atomic::Ordering::Relaxed) {
                return;
            }
            let phase = DIGEST_PHASE.load(std::sync::atomic::Ordering::Relaxed);
            let name = DIGEST_PHASES.get(phase).copied().unwrap_or("<unknown>");
            crate::log_error!(
                "DIGEST",
                "STUCK: the workbook digest has not returned in {:?}. Last phase \
                 reached: {}. A lock this phase takes is held by another thread \
                 and never released -- the app is deadlocked, the window will \
                 stop answering, and every later command will queue behind it.",
                Self::BUDGET,
                name
            );
        });
        DigestWatchdog { finished }
    }
}

impl Drop for DigestWatchdog {
    fn drop(&mut self) {
        self.finished
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn get_workbook_state_digest(
    state: State<AppState>,
    pivot_state: State<'_, crate::pivot::types::PivotState>,
    slicer_state: State<'_, crate::slicer::SlicerState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    options: Option<DigestOptions>,
) -> Result<WorkbookStateDigest, String> {
    build_workbook_state_digest(
        &state,
        &pivot_state,
        &slicer_state,
        &ribbon_filter_state,
        options,
    )
}

/// The digest itself, as a PLAIN FUNCTION over the states.
///
/// Split out of the command for the reason `run_calculation_pass` gives for the
/// same split: a `#[tauri::command]` body takes `State` and cannot be called
/// from a unit test, so its LOCK ORDER -- the thing that hung the app -- could
/// only ever be asserted against its source text. It is now asserted by running
/// it, from `state_digest_lock_order_tests`.
pub(crate) fn build_workbook_state_digest(
    state: &AppState,
    pivot_state: &crate::pivot::types::PivotState,
    slicer_state: &crate::slicer::SlicerState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    options: Option<DigestOptions>,
) -> Result<WorkbookStateDigest, String> {
    let opts = options.unwrap_or_default();
    log_info!("DIGEST", "get_workbook_state_digest cells_only={}", opts.cells_only);
    let _watchdog = DigestWatchdog::start();

    let mut used_styles: BTreeMap<usize, Value> = BTreeMap::new();

    // ---- Per-sheet content ----
    //
    // LOCK ORDER IS LOAD-BEARING HERE, AND GETTING IT WRONG HUNG THE WHOLE APP.
    //
    // `run_calculation_pass` takes `grid` (the active-sheet mirror) and THEN
    // `grids` (every sheet), holds both for the entire evaluation, and -- since
    // it was made an async command so Cancel could work -- runs on a background
    // thread. A synchronous command runs on the MAIN thread. So the two really
    // do overlap, and this command used to take the same two locks the other
    // way round:
    //
    //   pass   (bg thread): grid.write()  held ... wants grids.write()
    //   digest (main)     : grids.read()  held ... wants grid.read()
    //
    // Neither can proceed. The main thread is inside a sync command, so the
    // WebView2 message pump stops with it: the window goes "Not Responding" and
    // there is no crash, no panic and no log line -- the last thing written is
    // this function's own "DIGEST" line, with no matching CMD completion.
    // OBSERVED LIVE on the soak walk (seed 20260810): the app hung for 27
    // minutes until it was killed, and every replay the minimiser attempted
    // afterwards timed out against a dead page.
    //
    // So this block acquires in the PASS's order: grid, grids, sheet_names,
    // active_sheet, style_registry, locale. Everything else it reads
    // (dimensions, merges, freeze configs) the pass either clones before it
    // takes any grid lock, or never touches.
    digest_phase(1);
    let sheets_and_styles = {
        // `grid` FIRST, then `grids` — the pass's order. The two lines below
        // were the other way round in the shipped tree even though the comment
        // above and both guards in `state_digest_lock_order_tests` describe
        // this order: the fix's prose landed and its code did not. It hung the
        // app again, live, on soak seed 1786446166374 (see the register).
        let active_grid = state.grid.read().map_err(|e| e.to_string())?;
        let grids = state.grids.read().map_err(|e| e.to_string())?;
        let sheet_names = state.sheet_names.read().map_err(|e| e.to_string())?.clone();
        let sheet_count = sheet_names.len();
        let active_sheet = *state.active_sheet.read().map_err(|e| e.to_string())?;
        let locale = state.locale.lock().map_err(|e| e.to_string())?.clone();
        let mut sheets: Vec<SheetDigest> = Vec::with_capacity(sheet_count);
        let styles = state.style_registry.read().map_err(|e| e.to_string())?;
        let all_cw = state.all_column_widths.read().map_err(|e| e.to_string())?;
        let all_rh = state.all_row_heights.read().map_err(|e| e.to_string())?;
        let active_cw = state.column_widths.read().map_err(|e| e.to_string())?;
        let active_rh = state.row_heights.read().map_err(|e| e.to_string())?;
        let all_merged = state.all_merged_regions.read().map_err(|e| e.to_string())?;
        let active_merged = state.merged_regions.read().map_err(|e| e.to_string())?;
        let freeze_configs = state.freeze_configs.read().map_err(|e| e.to_string())?;
        let split_configs = state.split_configs.read().map_err(|e| e.to_string())?;
        let tab_colors = state.tab_colors.read().map_err(|e| e.to_string())?;
        let visibility = state.sheet_visibility.read().map_err(|e| e.to_string())?;
        let gridlines = state.show_gridlines.read().map_err(|e| e.to_string())?;
        let page_setups = state.page_setups.read().map_err(|e| e.to_string())?;
        let scroll_areas = state.scroll_areas.lock().map_err(|e| e.to_string())?;
        let sheet_zooms = state.sheet_zooms.read().map_err(|e| e.to_string())?;

        for i in 0..sheet_count {
            // The active-sheet mirror is authoritative for the active sheet.
            let grid: &engine::Grid = if i == active_sheet {
                &active_grid
            } else {
                match grids.get(i) {
                    Some(g) => g,
                    None => continue,
                }
            };

            let cells = digest_cells(grid, &styles, &locale, &mut used_styles);

            if opts.cells_only {
                sheets.push(SheetDigest {
                    name: sheet_names.get(i).cloned().unwrap_or_default(),
                    cells,
                    merged_regions: Vec::new(),
                    freeze_row: None,
                    freeze_col: None,
                    col_widths: BTreeMap::new(),
                    row_heights: BTreeMap::new(),
                    user_hidden_rows: Vec::new(),
                    user_hidden_cols: Vec::new(),
                    row_styles: BTreeMap::new(),
                    column_styles: BTreeMap::new(),
                    tab_color: String::new(),
                    visibility: String::new(),
                    show_gridlines: true,
                    page_setup: Value::Null,
                    split: Value::Null,
                    zoom: persistence::DEFAULT_SHEET_ZOOM_PERCENT,
                    scroll_area: None,
                });
                continue;
            }

            let mut merged: Vec<[u32; 4]> = if i == active_sheet {
                active_merged
                    .iter()
                    .map(|r| [r.start_row, r.start_col, r.end_row, r.end_col])
                    .collect()
            } else {
                all_merged
                    .get(i)
                    .map(|set| {
                        set.iter()
                            .map(|r| [r.start_row, r.start_col, r.end_row, r.end_col])
                            .collect()
                    })
                    .unwrap_or_default()
            };
            merged.sort_unstable();

            let col_widths: BTreeMap<u32, f64> = if i == active_sheet {
                active_cw.iter().map(|(k, v)| (*k, *v)).collect()
            } else {
                all_cw
                    .get(i)
                    .map(|m| m.iter().map(|(k, v)| (*k, *v)).collect())
                    .unwrap_or_default()
            };
            let row_heights: BTreeMap<u32, f64> = if i == active_sheet {
                active_rh.iter().map(|(k, v)| (*k, *v)).collect()
            } else {
                all_rh
                    .get(i)
                    .map(|m| m.iter().map(|(k, v)| (*k, *v)).collect())
                    .unwrap_or_default()
            };

            // Row/column style tiers, with their styles registered in
            // used_styles so the saveReload profile can compare content
            // (indices are not stable across save/reload).
            let row_styles: BTreeMap<u32, usize> =
                grid.row_styles.iter().map(|(k, v)| (*k, *v)).collect();
            let column_styles: BTreeMap<u32, usize> =
                grid.column_styles.iter().map(|(k, v)| (*k, *v)).collect();
            for &idx in row_styles.values().chain(column_styles.values()) {
                used_styles
                    .entry(idx)
                    .or_insert_with(|| to_value_or_null(&styles.get(idx)));
            }

            let mut user_hidden_rows: Vec<u32> =
                crate::commands::dimensions::user_hidden_rows_for_sheet(&state, i)
                    .into_iter()
                    .collect();
            user_hidden_rows.sort_unstable();
            let mut user_hidden_cols: Vec<u32> =
                crate::commands::dimensions::user_hidden_cols_for_sheet(&state, i)
                    .into_iter()
                    .collect();
            user_hidden_cols.sort_unstable();

            let fc = freeze_configs.get(i);
            sheets.push(SheetDigest {
                name: sheet_names.get(i).cloned().unwrap_or_default(),
                cells,
                merged_regions: merged,
                freeze_row: fc.and_then(|f| f.freeze_row),
                freeze_col: fc.and_then(|f| f.freeze_col),
                col_widths,
                row_heights,
                user_hidden_rows,
                user_hidden_cols,
                row_styles,
                column_styles,
                tab_color: tab_colors.get(i).cloned().unwrap_or_default(),
                visibility: visibility
                    .get(i)
                    .cloned()
                    .unwrap_or_else(|| "visible".to_string()),
                show_gridlines: gridlines.get(i).copied().unwrap_or(true),
                page_setup: page_setups
                    .get(i)
                    .map(to_value_or_null)
                    .unwrap_or(Value::Null),
                split: split_configs
                    .get(i)
                    .map(to_value_or_null)
                    .unwrap_or(Value::Null),
                zoom: sheet_zooms
                    .get(i)
                    .copied()
                    .unwrap_or(persistence::DEFAULT_SHEET_ZOOM_PERCENT),
                scroll_area: scroll_areas.get(i).cloned().flatten(),
            });
        }
        (sheets, sheet_names, active_sheet)
    };
    let (sheets, sheet_names, active_sheet) = sheets_and_styles;

    let mut digest = WorkbookStateDigest {
        version: 1,
        active_sheet,
        sheet_names,
        sheets,
        used_styles,
        named_ranges: BTreeMap::new(),
        named_styles: BTreeMap::new(),
        tables: BTreeMap::new(),
        slicers: BTreeMap::new(),
        ribbon_filters: BTreeMap::new(),
        charts: BTreeMap::new(),
        sparklines: BTreeMap::new(),
        pivots: BTreeMap::new(),
        conditional_formats: BTreeMap::new(),
        data_validations: BTreeMap::new(),
        comments: BTreeMap::new(),
        notes: BTreeMap::new(),
        hyperlinks: BTreeMap::new(),
        auto_filters: BTreeMap::new(),
        outlines: BTreeMap::new(),
        scenarios: BTreeMap::new(),
        controls: BTreeMap::new(),
        computed_properties: BTreeMap::new(),
        sheet_protection: BTreeMap::new(),
        workbook_protection: Value::Null,
        advanced_filter_hidden_rows: BTreeMap::new(),
        protected_regions: Vec::new(),
        pivot_layouts: Vec::new(),
        object_scripts: Vec::new(),
        theme: Value::Null,
        defaults: Value::Null,
    };

    if opts.cells_only {
        return Ok(digest);
    }

    // ---- Workbook-level stores ----
    digest_phase(2);
    if let Ok(named_ranges) = state.named_ranges.read() {
        for (name, nr) in named_ranges.iter() {
            digest.named_ranges.insert(name.clone(), to_value_or_null(nr));
        }
    }
    if let Ok(named_styles) = state.named_styles.read() {
        for (name, ns) in named_styles.iter() {
            digest.named_styles.insert(name.clone(), to_value_or_null(ns));
        }
    }
    digest_phase(3);
    if let Ok(tables) = state.tables.read() {
        for sheet_tables in tables.values() {
            for (id, table) in sheet_tables.iter() {
                digest.tables.insert(id_key(id), to_value_or_null(table));
            }
        }
    }
    digest_phase(4);
    if let Ok(slicers) = slicer_state.slicers.read() {
        for (id, slicer) in slicers.iter() {
            digest.slicers.insert(id_key(id), to_value_or_null(slicer));
        }
    }
    if let Ok(filters) = ribbon_filter_state.filters.read() {
        for (id, filter) in filters.iter() {
            digest
                .ribbon_filters
                .insert(id_key(id), to_value_or_null(filter));
        }
    }
    if let Ok(charts) = state.charts.read() {
        for chart in charts.iter() {
            digest.charts.insert(id_key(&chart.id), to_value_or_null(chart));
        }
    }
    if let Ok(sparklines) = state.sparklines.read() {
        for entry in sparklines.iter() {
            digest
                .sparklines
                .entry(entry.sheet_index.to_string())
                .or_default()
                .push(entry.groups_json.clone());
        }
        for groups in digest.sparklines.values_mut() {
            groups.sort_unstable();
        }
    }
    digest_phase(5);
    if let Ok(pivot_tables) = pivot_state.pivot_tables.read() {
        for (id, (definition, _cache)) in pivot_tables.iter() {
            digest.pivots.insert(id_key(id), to_value_or_null(definition));
        }
    }
    // Skip sheets whose list is EMPTY. An empty Vec and an absent key are
    // behaviourally identical everywhere in the app (every reader iterates the
    // Vec), but they are not identical to the oracle: save omits empty entries
    // and load never recreates the key, so a sheet left holding `vec![]` —
    // which any delete-the-last-rule path produces, including the structural
    // shift — showed up as a phantom `"0": []` that vanished across a
    // save/reload or undo/redo round trip and was reported as a diff.
    digest_phase(6);
    if let Ok(cf) = state.conditional_formats.read() {
        for (sheet, defs) in cf.iter() {
            if defs.is_empty() {
                continue;
            }
            digest
                .conditional_formats
                .insert(sheet.to_string(), to_value_or_null(defs));
        }
    }
    if let Ok(dv) = state.data_validations.read() {
        for (sheet, ranges) in dv.iter() {
            if ranges.is_empty() {
                continue;
            }
            digest
                .data_validations
                .insert(sheet.to_string(), to_value_or_null(ranges));
        }
    }
    // Note/comment ids and timestamps are regenerated on reload (the .cala
    // format stores only position/text/author) — strip them so the digest
    // compares semantic content, not volatile identity.
    fn strip_volatile(mut value: Value) -> Value {
        if let Some(obj) = value.as_object_mut() {
            obj.remove("id");
            obj.remove("createdAt");
            obj.remove("updatedAt");
            obj.remove("modifiedAt");
        }
        value
    }
    digest_phase(7);
    if let Ok(comments) = state.comments.read() {
        for (sheet, sheet_comments) in comments.iter() {
            for ((row, col), comment) in sheet_comments.iter() {
                digest.comments.insert(
                    sheet_cell_key(*sheet, *row, *col),
                    strip_volatile(to_value_or_null(comment)),
                );
            }
        }
    }
    if let Ok(notes) = state.notes.read() {
        for (sheet, sheet_notes) in notes.iter() {
            for ((row, col), note) in sheet_notes.iter() {
                digest.notes.insert(
                    sheet_cell_key(*sheet, *row, *col),
                    strip_volatile(to_value_or_null(note)),
                );
            }
        }
    }
    if let Ok(hyperlinks) = state.hyperlinks.read() {
        for (sheet, sheet_links) in hyperlinks.iter() {
            for ((row, col), link) in sheet_links.iter() {
                digest
                    .hyperlinks
                    .insert(sheet_cell_key(*sheet, *row, *col), to_value_or_null(link));
            }
        }
    }
    if let Ok(auto_filters) = state.auto_filters.read() {
        for (sheet, af) in auto_filters.iter() {
            let mut value = to_value_or_null(af);
            // hidden_rows is a HashSet — its JSON order is nondeterministic.
            // Sort for a canonical digest.
            if let Some(rows) = value.get_mut("hiddenRows").and_then(|v| v.as_array_mut()) {
                rows.sort_by_key(|v| v.as_u64().unwrap_or(0));
            }
            digest
                .auto_filters
                .insert(sheet.to_string(), value);
        }
    }
    if let Ok(outlines) = state.outlines.read() {
        for (sheet, outline) in outlines.iter() {
            digest
                .outlines
                .insert(sheet.to_string(), to_value_or_null(outline));
        }
    }
    if let Ok(scenarios) = state.scenarios.read() {
        for (sheet, list) in scenarios.iter() {
            digest
                .scenarios
                .insert(sheet.to_string(), to_value_or_null(list));
        }
    }
    digest_phase(8);
    if let Ok(controls) = state.controls.read() {
        for ((sheet, row, col), metadata) in controls.iter() {
            digest.controls.insert(
                sheet_cell_key(*sheet, *row, *col),
                to_value_or_null(metadata),
            );
        }
    }
    if let Ok(props) = state.computed_properties.read() {
        // ComputedProperty carries derived caches (AST, cached value) and tuple
        // map keys, so digest only the semantic fields, with string keys.
        fn prop_list(list: &[crate::computed_properties::ComputedProperty]) -> Value {
            Value::Array(
                list.iter()
                    .map(|p| {
                        serde_json::json!({
                            "id": p.id,
                            "attribute": p.attribute,
                            "formula": p.formula,
                        })
                    })
                    .collect(),
            )
        }
        for (sheet, sheet_props) in props.iter() {
            let mut cols: BTreeMap<String, Value> = BTreeMap::new();
            for (col, list) in sheet_props.column_props.iter() {
                cols.insert(col.to_string(), prop_list(list));
            }
            let mut rows: BTreeMap<String, Value> = BTreeMap::new();
            for (row, list) in sheet_props.row_props.iter() {
                rows.insert(row.to_string(), prop_list(list));
            }
            let mut cells: BTreeMap<String, Value> = BTreeMap::new();
            for ((row, col), list) in sheet_props.cell_props.iter() {
                cells.insert(cell_key(*row, *col), prop_list(list));
            }
            digest.computed_properties.insert(
                sheet.to_string(),
                serde_json::json!({ "columns": cols, "rows": rows, "cells": cells }),
            );
        }
    }
    digest_phase(9);
    if let Ok(protection) = state.sheet_protection.read() {
        for (sheet, p) in protection.iter() {
            digest
                .sheet_protection
                .insert(sheet.to_string(), to_value_or_null(p));
        }
    }
    if let Ok(wp) = state.workbook_protection.read() {
        digest.workbook_protection = to_value_or_null(&*wp);
    }
    if let Ok(hidden) = state.advanced_filter_hidden_rows.lock() {
        for (sheet, rows) in hidden.iter() {
            let mut sorted = rows.clone();
            sorted.sort_unstable();
            digest
                .advanced_filter_hidden_rows
                .insert(sheet.to_string(), sorted);
        }
    }
    digest_phase(10);
    if let Ok(regions) = state.protected_regions.lock() {
        let mut list: Vec<Value> = regions
            .iter()
            .map(|r| {
                serde_json::json!({
                    "id": r.id,
                    "regionType": r.region_type,
                    "ownerId": to_value_or_null(&r.owner_id),
                    "sheetIndex": r.sheet_index,
                    "startRow": r.start_row,
                    "startCol": r.start_col,
                    "endRow": r.end_row,
                    "endCol": r.end_col,
                })
            })
            .collect();
        list.sort_unstable_by_key(|v| v["id"].to_string());
        digest.protected_regions = list;
    }
    if let Ok(layouts) = state.pivot_layouts.read() {
        digest.pivot_layouts = layouts.iter().map(to_value_or_null).collect();
    }
    if let Ok(scripts) = state.object_scripts.read() {
        digest.object_scripts = scripts.iter().map(to_value_or_null).collect();
    }
    if let Ok(theme) = state.theme.read() {
        digest.theme = to_value_or_null(&*theme);
    }

    digest_phase(11);
    let default_row_height = *state.default_row_height.read().map_err(|e| e.to_string())?;
    let default_column_width = *state.default_column_width.read().map_err(|e| e.to_string())?;
    let reference_style = state.reference_style.lock().map_err(|e| e.to_string())?.clone();
    digest.defaults = serde_json::json!({
        "defaultRowHeight": default_row_height,
        "defaultColumnWidth": default_column_width,
        "referenceStyle": reference_style,
    });

    Ok(digest)
}
