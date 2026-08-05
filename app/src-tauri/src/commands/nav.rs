//! FILENAME: app/src-tauri/src/commands/nav.rs
// PURPOSE: Navigation logic (e.g., Ctrl+Arrow, Go To Special).
// The edge/region ALGORITHMS live in engine::navigation (one implementation
// shared with the QuickJS script ops); this module only resolves state.

use crate::api_types::RangeEdgeResult;
use crate::AppState;
use engine::navigation::{self, EdgeDirection};
use engine::CellValue;
use serde::{Deserialize, Serialize};
use tauri::State;

/// Result of get_current_region command - structured version of detect_data_region.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentRegionResult {
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
    pub empty: bool,
}

/// Run `f` against the grid for `sheet_index` (defaulting to the active
/// sheet). The active sheet's LIVE grid is `state.grid` — `grids[active]` is
/// stale — so the selection must go through this helper, never `grids[i]`
/// directly.
fn with_sheet_grid<T>(
    state: &AppState,
    sheet_index: Option<usize>,
    f: impl FnOnce(&engine::Grid) -> T,
) -> Result<T, String> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let target_sheet = sheet_index.unwrap_or(active_sheet);
    let grids = state.grids.lock().unwrap();
    let active_grid = state.grid.lock().unwrap();
    let grid: &engine::Grid = if target_sheet == active_sheet {
        &active_grid
    } else if target_sheet < grids.len() {
        &grids[target_sheet]
    } else {
        return Err(format!("sheet index out of range: {}", target_sheet));
    };
    Ok(f(grid))
}

/// Get the current region around a cell as a structured result.
///
/// Returns a `CurrentRegionResult` with `empty: true` if the cell is isolated,
/// or the bounding rectangle of the contiguous data region otherwise.
/// `sheet_index` defaults to the active sheet.
#[tauri::command]
pub fn get_current_region(
    state: State<AppState>,
    row: u32,
    col: u32,
    sheet_index: Option<usize>,
) -> Result<CurrentRegionResult, String> {
    let region = with_sheet_grid(&state, sheet_index, |grid| {
        navigation::current_region(grid, row, col)
    })?;
    match region {
        Some((sr, sc, er, ec)) => Ok(CurrentRegionResult {
            start_row: sr,
            start_col: sc,
            end_row: er,
            end_col: ec,
            empty: false,
        }),
        None => Ok(CurrentRegionResult {
            start_row: row,
            start_col: col,
            end_row: row,
            end_col: col,
            empty: true,
        }),
    }
}

/// Detect the contiguous data region around a given cell (Excel's CurrentRegion).
///
/// Returns the bounding tuple `(startRow, startCol, endRow, endCol)` or `None`
/// if the starting cell is empty and has no adjacent data. Active sheet only;
/// use `get_current_region` for the sheet-addressable form.
#[tauri::command]
pub fn detect_data_region(
    state: State<AppState>,
    row: u32,
    col: u32,
) -> Option<(u32, u32, u32, u32)> {
    let grid = state.grid.lock().unwrap();
    navigation::current_region(&grid, row, col)
}

/// Find the target cell for Ctrl+Arrow navigation (Excel-like behavior).
///
/// Excel's Ctrl+Arrow behavior:
/// - If current cell is empty: jump to the next non-empty cell (or edge if none)
/// - If current cell has content AND next cell is empty: jump to next non-empty (or edge)
/// - If current cell has content AND next cell has content: jump to end of contiguous block
///
/// The algorithm is engine::navigation::range_edge — the SAME function behind
/// the script-facing `get_range_edge`, so keyboard and scripts cannot drift.
#[tauri::command]
pub fn find_ctrl_arrow_target(
    state: State<AppState>,
    row: u32,
    col: u32,
    direction: String,
    max_row: u32,
    max_col: u32,
) -> (u32, u32) {
    let Some(dir) = EdgeDirection::parse(&direction) else {
        return (row, col);
    };
    let grid = state.grid.lock().unwrap();
    navigation::range_edge(&grid, row, col, dir, max_row, max_col)
}

/// Script-facing Ctrl+Arrow edge navigation (Excel Range.End semantics).
///
/// Same algorithm as the keyboard's `find_ctrl_arrow_target`, but resolved
/// entirely server-side against Excel's full grid bounds (1,048,576 rows x
/// 16,384 columns) and addressable per sheet — never bulk-reading rows over
/// IPC. `direction` is "up" | "down" | "left" | "right"; `sheet_index`
/// defaults to the active sheet.
#[tauri::command]
pub fn get_range_edge(
    state: State<AppState>,
    row: u32,
    col: u32,
    direction: String,
    sheet_index: Option<usize>,
) -> Result<RangeEdgeResult, String> {
    let dir = EdgeDirection::parse(&direction).ok_or_else(|| {
        format!(
            "invalid direction \"{}\": expected \"up\", \"down\", \"left\", or \"right\"",
            direction
        )
    })?;
    let (target_row, target_col) = with_sheet_grid(&state, sheet_index, |grid| {
        navigation::range_edge(
            grid,
            row,
            col,
            dir,
            navigation::EXCEL_MAX_ROW_INDEX,
            navigation::EXCEL_MAX_COL_INDEX,
        )
    })?;
    Ok(RangeEdgeResult {
        row: target_row,
        col: target_col,
    })
}

// ============================================================================
// Go To Special
// ============================================================================

/// A cell coordinate returned for Go To Special results.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellCoord {
    pub row: u32,
    pub col: u32,
}

/// Result of go_to_special command.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoToSpecialResult {
    pub cells: Vec<CellCoord>,
}

/// Find cells matching specific criteria within the used range of the active sheet.
/// `criteria` can be: "blanks", "formulas", "constants", "errors", "comments", "notes",
///   "conditionalFormats", "dataValidation"
/// `search_range` is optional: (startRow, startCol, endRow, endCol). If None, uses entire used range.
#[tauri::command]
pub fn go_to_special(
    state: State<AppState>,
    criteria: String,
    search_range: Option<(u32, u32, u32, u32)>,
) -> GoToSpecialResult {
    let grid = state.grid.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();

    // Determine search bounds
    let (sr, sc, er, ec) = search_range.unwrap_or((0, 0, grid.max_row, grid.max_col));

    let mut cells = Vec::new();

    match criteria.as_str() {
        "blanks" => {
            for row in sr..=er {
                for col in sc..=ec {
                    let is_blank = grid.get_cell(row, col)
                        .map(|cell| !cell.has_formula() && matches!(cell.value, CellValue::Empty))
                        .unwrap_or(true);
                    if is_blank {
                        cells.push(CellCoord { row, col });
                    }
                }
            }
        }
        "formulas" => {
            for row in sr..=er {
                for col in sc..=ec {
                    let has_formula = grid.get_cell(row, col)
                        .map(|cell| cell.has_formula())
                        .unwrap_or(false);
                    if has_formula {
                        cells.push(CellCoord { row, col });
                    }
                }
            }
        }
        "constants" => {
            for row in sr..=er {
                for col in sc..=ec {
                    let is_constant = grid.get_cell(row, col)
                        .map(|cell| !cell.has_formula() && !matches!(cell.value, CellValue::Empty))
                        .unwrap_or(false);
                    if is_constant {
                        cells.push(CellCoord { row, col });
                    }
                }
            }
        }
        "errors" => {
            for row in sr..=er {
                for col in sc..=ec {
                    let is_error = grid.get_cell(row, col)
                        .map(|cell| matches!(cell.value, CellValue::Error(_)))
                        .unwrap_or(false);
                    if is_error {
                        cells.push(CellCoord { row, col });
                    }
                }
            }
        }
        "comments" => {
            let comments = state.comments.lock().unwrap();
            if let Some(sheet_comments) = comments.get(&active_sheet) {
                for (&(row, col), _) in sheet_comments {
                    if row >= sr && row <= er && col >= sc && col <= ec {
                        cells.push(CellCoord { row, col });
                    }
                }
            }
        }
        "notes" => {
            let notes = state.notes.lock().unwrap();
            if let Some(sheet_notes) = notes.get(&active_sheet) {
                for (&(row, col), _) in sheet_notes {
                    if row >= sr && row <= er && col >= sc && col <= ec {
                        cells.push(CellCoord { row, col });
                    }
                }
            }
        }
        "conditionalFormats" => {
            let cfs = state.conditional_formats.lock().unwrap();
            if let Some(sheet_cfs) = cfs.get(&active_sheet) {
                let mut cell_set = std::collections::HashSet::new();
                for cf in sheet_cfs {
                    for range in &cf.ranges {
                        for row in range.start_row..=range.end_row {
                            for col in range.start_col..=range.end_col {
                                if row >= sr && row <= er && col >= sc && col <= ec {
                                    cell_set.insert((row, col));
                                }
                            }
                        }
                    }
                }
                for (row, col) in cell_set {
                    cells.push(CellCoord { row, col });
                }
            }
        }
        "dataValidation" => {
            let validations = state.data_validations.lock().unwrap();
            if let Some(sheet_validations) = validations.get(&active_sheet) {
                let mut cell_set = std::collections::HashSet::new();
                for vr in sheet_validations {
                    for row in vr.start_row..=vr.end_row {
                        for col in vr.start_col..=vr.end_col {
                            if row >= sr && row <= er && col >= sc && col <= ec {
                                cell_set.insert((row, col));
                            }
                        }
                    }
                }
                for (row, col) in cell_set {
                    cells.push(CellCoord { row, col });
                }
            }
        }
        _ => {}
    }

    // Sort by row then col for consistent ordering
    cells.sort_by(|a, b| a.row.cmp(&b.row).then(a.col.cmp(&b.col)));

    GoToSpecialResult { cells }
}

// ============================================================================
// Special cells (script-facing Range.SpecialCells) — Wave 4
// ============================================================================

/// Hard cap on cells returned by get_special_cells. A script asking for the
/// blanks of a whole-column range must get a bounded answer, not a 16-million
/// row IPC payload; `truncated: true` says the cap dropped something.
pub const SPECIAL_CELLS_CAP: usize = 100_000;

/// Union of every backend authority that can hide a ROW on `sheet_index`:
/// AutoFilter criteria, an applied advanced filter, and collapsed outline
/// (grouping) rows. Manual hide/unhide lives in frontend Core state only and
/// is deliberately NOT consulted here — the backend answers with what IT owns.
pub(crate) fn collect_hidden_rows_for_sheet(
    state: &AppState,
    sheet_index: usize,
) -> std::collections::HashSet<u32> {
    let mut hidden: std::collections::HashSet<u32> = std::collections::HashSet::new();
    {
        let auto_filters = state.auto_filters.lock().unwrap();
        if let Some(af) = auto_filters.get(&sheet_index) {
            hidden.extend(af.hidden_rows.iter().copied());
        }
    }
    {
        let adv = state.advanced_filter_hidden_rows.lock().unwrap();
        if let Some(rows) = adv.get(&sheet_index) {
            hidden.extend(rows.iter().copied());
        }
    }
    {
        let outlines = state.outlines.lock().unwrap();
        if let Some(outline) = outlines.get(&sheet_index) {
            hidden.extend(outline.get_hidden_rows());
        }
    }
    hidden
}

/// Columns hidden on `sheet_index` by collapsed outline groups (the only
/// backend authority that hides columns).
pub(crate) fn collect_hidden_cols_for_sheet(
    state: &AppState,
    sheet_index: usize,
) -> std::collections::HashSet<u32> {
    let outlines = state.outlines.lock().unwrap();
    outlines
        .get(&sheet_index)
        .map(|o| o.get_hidden_cols())
        .unwrap_or_default()
}

/// Pure selector behind get_special_cells: pick the cells of `kind` inside the
/// inclusive rect, against ONE grid plus the authoritative hidden-row/col sets.
///
/// The rect is normalized and CLAMPED to the grid's used range (max_row /
/// max_col) — the dense kinds ("blanks", "visible") would otherwise have to
/// walk every addressable cell of a whole-column selection. Row-major sorted;
/// capped at `SPECIAL_CELLS_CAP` with the second tuple element reporting
/// whether the cap dropped anything.
pub(crate) fn compute_special_cells(
    grid: &engine::Grid,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
    kind: &str,
    hidden_rows: &std::collections::HashSet<u32>,
    hidden_cols: &std::collections::HashSet<u32>,
) -> Result<(Vec<crate::api_types::SpecialCellRef>, bool), String> {
    let (sr, er) = (start_row.min(end_row), start_row.max(end_row));
    let (sc, ec) = (start_col.min(end_col), start_col.max(end_col));
    // Clamp to the used range. An entirely off-range rect yields no cells.
    let er = er.min(grid.max_row);
    let ec = ec.min(grid.max_col);
    if sr > er || sc > ec {
        return match kind {
            "constants" | "formulas" | "blanks" | "visible" => Ok((Vec::new(), false)),
            other => Err(invalid_special_kind(other)),
        };
    }

    let mut cells: Vec<crate::api_types::SpecialCellRef> = Vec::new();
    let mut truncated = false;

    match kind {
        // Sparse kinds: walk stored cells only, then sort.
        "constants" | "formulas" => {
            let want_formula = kind == "formulas";
            for (&(row, col), cell) in &grid.cells {
                if row < sr || row > er || col < sc || col > ec {
                    continue;
                }
                let matches = if want_formula {
                    cell.has_formula()
                } else {
                    !cell.has_formula() && !matches!(cell.value, CellValue::Empty)
                };
                if matches {
                    cells.push(crate::api_types::SpecialCellRef { row, col });
                }
            }
            cells.sort_by(|a, b| a.row.cmp(&b.row).then(a.col.cmp(&b.col)));
            if cells.len() > SPECIAL_CELLS_CAP {
                cells.truncate(SPECIAL_CELLS_CAP);
                truncated = true;
            }
        }
        // Dense kinds: walk the (clamped) rect in row-major order, so the cap
        // can stop the walk the moment it is exceeded.
        "blanks" | "visible" => {
            let visible_kind = kind == "visible";
            'scan: for row in sr..=er {
                if visible_kind && hidden_rows.contains(&row) {
                    continue;
                }
                for col in sc..=ec {
                    let include = if visible_kind {
                        !hidden_cols.contains(&col)
                    } else {
                        grid.get_cell(row, col)
                            .map(|cell| {
                                !cell.has_formula() && matches!(cell.value, CellValue::Empty)
                            })
                            .unwrap_or(true)
                    };
                    if include {
                        if cells.len() >= SPECIAL_CELLS_CAP {
                            truncated = true;
                            break 'scan;
                        }
                        cells.push(crate::api_types::SpecialCellRef { row, col });
                    }
                }
            }
        }
        other => return Err(invalid_special_kind(other)),
    }

    Ok((cells, truncated))
}

fn invalid_special_kind(kind: &str) -> String {
    format!(
        "invalid kind \"{}\": expected \"constants\", \"formulas\", \"blanks\", or \"visible\"",
        kind
    )
}

/// Script-facing Range.SpecialCells (Excel's Go To Special, addressable per
/// sheet and bounded).
///
/// `kind` is "constants" | "formulas" | "blanks" | "visible".
/// "visible" is the reason this lives in the backend: filtered-out rows
/// (AutoFilter + advanced filter) and collapsed outline rows/cols are backend
/// state that a script cannot reach otherwise, and they are read here from
/// their authoritative homes. `sheet_index` defaults to the active sheet.
/// The rect is clamped to the sheet's used range; the answer is row-major
/// sorted and capped at 100,000 cells (`truncated` reports the cap firing).
#[tauri::command]
pub fn get_special_cells(
    state: State<AppState>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
    kind: String,
    sheet_index: Option<usize>,
) -> Result<crate::api_types::SpecialCellsResult, String> {
    // Resolve the target sheet FIRST, then gather the hidden sets while no
    // grid lock is held (collect_* take their own locks).
    let target_sheet = {
        let active_sheet = *state.active_sheet.lock().unwrap();
        sheet_index.unwrap_or(active_sheet)
    };
    let (hidden_rows, hidden_cols) = if kind == "visible" {
        (
            collect_hidden_rows_for_sheet(&state, target_sheet),
            collect_hidden_cols_for_sheet(&state, target_sheet),
        )
    } else {
        (
            std::collections::HashSet::new(),
            std::collections::HashSet::new(),
        )
    };
    let (cells, truncated) = with_sheet_grid(&state, Some(target_sheet), |grid| {
        compute_special_cells(
            grid, start_row, start_col, end_row, end_col, &kind, &hidden_rows, &hidden_cols,
        )
    })??;
    Ok(crate::api_types::SpecialCellsResult { cells, truncated })
}

#[cfg(test)]
mod special_cells_tests {
    use super::{
        collect_hidden_cols_for_sheet, collect_hidden_rows_for_sheet, compute_special_cells,
        SPECIAL_CELLS_CAP,
    };
    use engine::{Cell, Grid};
    use std::collections::HashSet;

    fn coords(cells: &[crate::api_types::SpecialCellRef]) -> Vec<(u32, u32)> {
        cells.iter().map(|c| (c.row, c.col)).collect()
    }

    fn none() -> HashSet<u32> {
        HashSet::new()
    }

    /// A small mixed grid:
    ///   (0,0) text  (0,1) blank
    ///   (1,0) num   (1,1) formula
    ///   (2,*) blank row
    ///   (3,1) num
    fn fixture() -> Grid {
        let mut g = Grid::new();
        g.set_cell(0, 0, Cell::new_text("header".to_string()));
        g.set_cell(1, 0, Cell::new_number(1.0));
        g.set_cell(1, 1, Cell::new_formula("A2+1".to_string()));
        g.set_cell(3, 1, Cell::new_number(2.0));
        g
    }

    #[test]
    fn constants_formulas_and_blanks_partition_the_rect() {
        let g = fixture();
        let (constants, t1) =
            compute_special_cells(&g, 0, 0, 3, 1, "constants", &none(), &none()).unwrap();
        assert_eq!(coords(&constants), vec![(0, 0), (1, 0), (3, 1)]);
        assert!(!t1);

        let (formulas, _) =
            compute_special_cells(&g, 0, 0, 3, 1, "formulas", &none(), &none()).unwrap();
        assert_eq!(coords(&formulas), vec![(1, 1)]);

        let (blanks, _) =
            compute_special_cells(&g, 0, 0, 3, 1, "blanks", &none(), &none()).unwrap();
        assert_eq!(coords(&blanks), vec![(0, 1), (2, 0), (2, 1), (3, 0)]);

        // The three kinds partition the rect: every cell is exactly one of
        // constant / formula / blank.
        assert_eq!(constants.len() + formulas.len() + blanks.len(), 8);
    }

    #[test]
    fn bounds_are_normalized_and_clamped_to_the_used_range() {
        let g = fixture();
        // Swapped corners + a far end way past the used range: same answer as
        // the canonical rect, because the rect is normalized then clamped.
        let (constants, _) =
            compute_special_cells(&g, 500, 200, 0, 0, "constants", &none(), &none()).unwrap();
        assert_eq!(coords(&constants), vec![(0, 0), (1, 0), (3, 1)]);

        // Entirely past the used range: empty, not an error.
        let (blanks, truncated) =
            compute_special_cells(&g, 100, 100, 200, 200, "blanks", &none(), &none()).unwrap();
        assert!(blanks.is_empty());
        assert!(!truncated);
    }

    #[test]
    fn an_invalid_kind_is_refused() {
        let g = fixture();
        let err = compute_special_cells(&g, 0, 0, 3, 1, "hunches", &none(), &none()).unwrap_err();
        assert!(err.contains("invalid kind"), "got: {}", err);
    }

    #[test]
    fn visible_skips_hidden_rows_and_cols() {
        let g = fixture();
        let hidden_rows: HashSet<u32> = [1, 2].into_iter().collect();
        let hidden_cols: HashSet<u32> = [0].into_iter().collect();
        let (visible, _) =
            compute_special_cells(&g, 0, 0, 3, 1, "visible", &hidden_rows, &hidden_cols).unwrap();
        assert_eq!(coords(&visible), vec![(0, 1), (3, 1)]);
    }

    #[test]
    fn the_cap_truncates_and_says_so() {
        // One far-away cell inflates the used range to 401 x 301 = 120,701
        // positions — a blanks scan must stop at the cap and admit it.
        let mut g = Grid::new();
        g.set_cell(400, 300, Cell::new_number(1.0));
        let (blanks, truncated) =
            compute_special_cells(&g, 0, 0, 400, 300, "blanks", &none(), &none()).unwrap();
        assert_eq!(blanks.len(), SPECIAL_CELLS_CAP);
        assert!(truncated, "the cap fired and must be reported");
        // Row-major order: the FIRST cells survive the cap.
        assert_eq!(coords(&blanks[..2]), vec![(0, 0), (0, 1)]);
    }

    /// The authoritative hidden-row union: AutoFilter criteria + advanced
    /// filter + collapsed outline groups, per sheet — the reason "visible"
    /// lives in the backend at all.
    #[test]
    fn visible_after_filter_reads_the_authoritative_hidden_state() {
        let state = crate::create_app_state();
        // Seed rows 0..=6 in column 0 on the active sheet (both the live grid
        // and the grids vec, as commands do).
        {
            let mut grid = state.grid.lock().unwrap();
            let mut grids = state.grids.lock().unwrap();
            for r in 0..=6u32 {
                let cell = Cell::new_number(r as f64);
                grid.set_cell(r, 0, cell.clone());
                grids[0].set_cell(r, 0, cell);
            }
        }
        // AutoFilter hides rows 2 and 3.
        {
            let mut af = crate::autofilter::AutoFilter::new(0, 0, 6, 0);
            af.hidden_rows = [2u32, 3].into_iter().collect();
            state.auto_filters.lock().unwrap().insert(0, af);
        }
        // An advanced filter hides row 4.
        state
            .advanced_filter_hidden_rows
            .lock()
            .unwrap()
            .insert(0, vec![4]);
        // A collapsed outline group over rows 5..=6 hides row 5 (row 6 is the
        // summary row and stays visible so the user can expand again).
        {
            let mut outline = crate::grouping::SheetOutline::new();
            let mut group = crate::grouping::RowGroup::new(5, 6, 1);
            group.collapsed = true;
            outline.row_groups.push(group);
            state.outlines.lock().unwrap().insert(0, outline);
        }

        let hidden_rows = collect_hidden_rows_for_sheet(&state, 0);
        assert_eq!(hidden_rows, [2u32, 3, 4, 5].into_iter().collect::<HashSet<u32>>());
        let hidden_cols = collect_hidden_cols_for_sheet(&state, 0);
        assert!(hidden_cols.is_empty());

        let grid = state.grid.lock().unwrap();
        let (visible, truncated) =
            compute_special_cells(&grid, 0, 0, 6, 0, "visible", &hidden_rows, &hidden_cols)
                .unwrap();
        assert_eq!(coords(&visible), vec![(0, 0), (1, 0), (6, 0)]);
        assert!(!truncated);

        // A DIFFERENT sheet has no hidden state: everything is visible there.
        assert!(collect_hidden_rows_for_sheet(&state, 1).is_empty());
    }
}