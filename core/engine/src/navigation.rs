//! FILENAME: core/engine/src/navigation.rs
//! PURPOSE: Shared grid navigation/region algorithms: Ctrl+Arrow edge
//! navigation (Excel Range.End), CurrentRegion expansion, and UsedRange
//! bounds.
//! CONTEXT: ONE implementation used by BOTH the Tauri commands
//! (app/src-tauri/src/commands/nav.rs, data.rs) and the QuickJS script ops
//! (core/script-engine/src/ops/*) so keyboard navigation, extension scripts,
//! and notebooks can never drift apart.
//!
//! `range_edge` is the verbatim port of the `find_ctrl_arrow_target` Tauri
//! command that has always driven the grid's Ctrl+Arrow keyboard handling
//! (app/src/core/hooks/useGridKeyboard.ts -> findCtrlArrowTarget); that
//! command now delegates here. `current_region` is the port of the
//! `detect_data_region_impl` used by the CurrentRegion commands; `used_range`
//! is the port of the used-range bounds scan (get_used_range command and the
//! QuickJS getUsedRange op both had a copy).

use crate::cell::CellValue;
use crate::grid::Grid;

/// Excel's last 0-based row index (1,048,576 rows). Matches the frontend's
/// DEFAULT_GRID_CONFIG.totalRows - 1, which the keyboard handler passes to
/// find_ctrl_arrow_target as its row bound.
pub const EXCEL_MAX_ROW_INDEX: u32 = 1_048_575;

/// Excel's last 0-based column index (XFD = 16,384 columns). Matches the
/// frontend's DEFAULT_GRID_CONFIG.totalCols - 1.
pub const EXCEL_MAX_COL_INDEX: u32 = 16_383;

/// A Ctrl+Arrow / Range.End direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EdgeDirection {
    Up,
    Down,
    Left,
    Right,
}

impl EdgeDirection {
    /// Parse the wire spelling ("up" | "down" | "left" | "right").
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "up" => Some(Self::Up),
            "down" => Some(Self::Down),
            "left" => Some(Self::Left),
            "right" => Some(Self::Right),
            _ => None,
        }
    }

    /// (row delta, col delta) for one step in this direction.
    fn deltas(self) -> (i64, i64) {
        match self {
            Self::Up => (-1, 0),
            Self::Down => (1, 0),
            Self::Left => (0, -1),
            Self::Right => (0, 1),
        }
    }
}

/// Find the target cell for Ctrl+Arrow navigation (Excel Range.End semantics).
///
/// - Current cell non-empty AND next cell non-empty: move to the end of the
///   contiguous non-empty block.
/// - Current cell non-empty AND next cell empty: jump to the next non-empty
///   cell in that direction, or to the grid edge if there is none.
/// - Current cell empty: jump to the next non-empty cell, or to the grid edge.
/// - Already at the edge: stay in place.
///
/// `max_row`/`max_col` are the last VALID 0-based indices (inclusive bounds);
/// pass [`EXCEL_MAX_ROW_INDEX`]/[`EXCEL_MAX_COL_INDEX`] for full-grid
/// navigation. "Non-empty" means the stored cell value is not
/// `CellValue::Empty` — identical to the keyboard behavior this was ported
/// from.
pub fn range_edge(
    grid: &Grid,
    row: u32,
    col: u32,
    direction: EdgeDirection,
    max_row: u32,
    max_col: u32,
) -> (u32, u32) {
    let (d_row, d_col) = direction.deltas();

    let is_non_empty = |r: u32, c: u32| -> bool {
        grid.get_cell(r, c)
            .map(|cell| !matches!(cell.value, CellValue::Empty))
            .unwrap_or(false)
    };

    let is_in_bounds =
        |r: i64, c: i64| -> bool { r >= 0 && r <= max_row as i64 && c >= 0 && c <= max_col as i64 };

    let current_has_content = is_non_empty(row, col);

    let next_r = row as i64 + d_row;
    let next_c = col as i64 + d_col;

    // Already at the edge: stay in place.
    if !is_in_bounds(next_r, next_c) {
        return (row, col);
    }

    let next_has_content = is_non_empty(next_r as u32, next_c as u32);

    if current_has_content && next_has_content {
        // Both current and next have content: find the end of the block.
        let mut r = next_r;
        let mut c = next_c;
        loop {
            let peek_r = r + d_row;
            let peek_c = c + d_col;
            if !is_in_bounds(peek_r, peek_c) || !is_non_empty(peek_r as u32, peek_c as u32) {
                return (r as u32, c as u32);
            }
            r = peek_r;
            c = peek_c;
        }
    } else {
        // Current is empty OR next is empty.
        // Special case: current empty but next non-empty -> the next cell.
        if !current_has_content && next_has_content {
            return (next_r as u32, next_c as u32);
        }

        // Search from after the next cell for the first non-empty cell.
        let mut r = next_r;
        let mut c = next_c;
        loop {
            r += d_row;
            c += d_col;

            if !is_in_bounds(r, c) {
                // Hit the edge without finding data: land on the edge.
                let edge_r = if d_row < 0 {
                    0
                } else if d_row > 0 {
                    max_row as i64
                } else {
                    row as i64
                };
                let edge_c = if d_col < 0 {
                    0
                } else if d_col > 0 {
                    max_col as i64
                } else {
                    col as i64
                };
                return (edge_r as u32, edge_c as u32);
            }

            if is_non_empty(r as u32, c as u32) {
                return (r as u32, c as u32);
            }
        }
    }
}

/// Detect the contiguous data region around a cell (Excel's CurrentRegion).
///
/// Expands a bounding rectangle from `(row, col)` until it is bordered by
/// fully empty rows/columns (or the grid's data bounds). "Content" means a
/// formula OR a non-empty value. Returns `(start_row, start_col, end_row,
/// end_col)`, or `None` when the starting cell is empty and has no adjacent
/// data.
pub fn current_region(grid: &Grid, row: u32, col: u32) -> Option<(u32, u32, u32, u32)> {
    let has_content = |r: u32, c: u32| -> bool {
        grid.get_cell(r, c)
            .map(|cell| cell.has_formula() || !matches!(cell.value, CellValue::Empty))
            .unwrap_or(false)
    };

    let row_empty = |r: u32, sc: u32, ec: u32| -> bool { !(sc..=ec).any(|c| has_content(r, c)) };
    let col_empty = |c: u32, sr: u32, er: u32| -> bool { !(sr..=er).any(|r| has_content(r, c)) };

    let mut sr = row;
    let mut er = row;
    let mut sc = col;
    let mut ec = col;

    loop {
        let prev = (sr, er, sc, ec);

        while sr > 0 && !row_empty(sr - 1, sc, ec) {
            sr -= 1;
        }
        while er < grid.max_row && !row_empty(er + 1, sc, ec) {
            er += 1;
        }
        while sc > 0 && !col_empty(sc - 1, sr, er) {
            sc -= 1;
        }
        while ec < grid.max_col && !col_empty(ec + 1, sr, er) {
            ec += 1;
        }

        if (sr, er, sc, ec) == prev {
            break;
        }
    }

    // Isolated empty starting cell: no region.
    if sr == er && sc == ec && !has_content(row, col) {
        return None;
    }

    Some((sr, sc, er, ec))
}

/// The bounding box of every stored cell in the grid (Excel's UsedRange).
///
/// Any stored cell counts (including style-only cells), exactly like the
/// sparse-key scan both previous copies performed. Returns `(start_row,
/// start_col, end_row, end_col)`, or `None` for a grid with no stored cells.
pub fn used_range(grid: &Grid) -> Option<(u32, u32, u32, u32)> {
    if grid.cells.is_empty() {
        return None;
    }
    let mut min_row = u32::MAX;
    let mut min_col = u32::MAX;
    let mut max_row = 0u32;
    let mut max_col = 0u32;
    for &(row, col) in grid.cells.keys() {
        if row < min_row {
            min_row = row;
        }
        if row > max_row {
            max_row = row;
        }
        if col < min_col {
            min_col = col;
        }
        if col > max_col {
            max_col = col;
        }
    }
    Some((min_row, min_col, max_row, max_col))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cell::Cell;
    use crate::dependency_extractor::{Expression, Value};

    fn text_cell(text: &str) -> Cell {
        Cell {
            ast: None,
            value: CellValue::Text(text.to_string()),
            style_index: 0,
            rich_text: None,
        }
    }

    /// A grid with a contiguous block in row 0: A1..D1 ("a".."d"), a gap, then
    /// G1 ("g"); and in column 0: A1..A4 ("a", "r2", "r3", "r4"), a gap, then
    /// A7 ("r7").
    fn fixture() -> Grid {
        let mut g = Grid::new();
        for (c, t) in ["a", "b", "c", "d"].iter().enumerate() {
            g.set_cell(0, c as u32, text_cell(t));
        }
        g.set_cell(0, 6, text_cell("g"));
        for (r, t) in ["r2", "r3", "r4"].iter().enumerate() {
            g.set_cell(r as u32 + 1, 0, text_cell(t));
        }
        g.set_cell(6, 0, text_cell("r7"));
        g
    }

    const MAX_R: u32 = 99;
    const MAX_C: u32 = 49;

    #[test]
    fn range_edge_semantics_matrix() {
        let g = fixture();
        // (from_row, from_col, direction, expected_row, expected_col, label)
        let cases: &[(u32, u32, EdgeDirection, u32, u32, &str)] = &[
            // Non-empty start, non-empty next: end of contiguous block.
            (0, 0, EdgeDirection::Right, 0, 3, "block start -> block end"),
            (0, 1, EdgeDirection::Right, 0, 3, "mid-block -> block end"),
            (0, 3, EdgeDirection::Left, 0, 0, "block end -> block start"),
            (0, 0, EdgeDirection::Down, 3, 0, "column block start -> end"),
            (3, 0, EdgeDirection::Up, 0, 0, "column block end -> start"),
            // Non-empty start, empty next: jump across the gap to next data.
            (0, 3, EdgeDirection::Right, 0, 6, "gap jump to next non-empty"),
            (0, 6, EdgeDirection::Left, 0, 3, "gap jump left to block end"),
            (3, 0, EdgeDirection::Down, 6, 0, "gap jump down to next data"),
            (6, 0, EdgeDirection::Up, 3, 0, "gap jump up to block end"),
            // Non-empty start, empty next, nothing further: grid edge.
            (0, 6, EdgeDirection::Right, 0, MAX_C, "no more data -> right edge"),
            (6, 0, EdgeDirection::Down, MAX_R, 0, "no more data -> bottom edge"),
            // Empty start: first non-empty in direction, or the edge.
            (0, 5, EdgeDirection::Right, 0, 6, "empty start, adjacent data"),
            (0, 20, EdgeDirection::Left, 0, 6, "empty start, distant data"),
            (20, 0, EdgeDirection::Up, 6, 0, "empty start, data above"),
            (50, 5, EdgeDirection::Down, MAX_R, 5, "empty column -> bottom edge"),
            (50, 5, EdgeDirection::Up, 0, 5, "empty column -> top edge"),
            // Already at the edge: stay.
            (0, 0, EdgeDirection::Up, 0, 0, "top edge stays"),
            (0, 0, EdgeDirection::Left, 0, 0, "left edge stays"),
            (MAX_R, 3, EdgeDirection::Down, MAX_R, 3, "bottom edge stays"),
            (5, MAX_C, EdgeDirection::Right, 5, MAX_C, "right edge stays"),
        ];
        for &(r, c, dir, er, ec, label) in cases {
            assert_eq!(
                range_edge(&g, r, c, dir, MAX_R, MAX_C),
                (er, ec),
                "case: {}",
                label
            );
        }
    }

    #[test]
    fn range_edge_last_row_idiom() {
        // THE VBA idiom: Cells(Rows.Count, 1).End(xlUp) — from the very last
        // row of an empty tail, Up lands on the last non-empty cell.
        let g = fixture();
        assert_eq!(
            range_edge(&g, EXCEL_MAX_ROW_INDEX, 0, EdgeDirection::Up, EXCEL_MAX_ROW_INDEX, EXCEL_MAX_COL_INDEX),
            (6, 0)
        );
        // And in a column with no data at all, it goes to the top edge.
        assert_eq!(
            range_edge(&g, EXCEL_MAX_ROW_INDEX, 30, EdgeDirection::Up, EXCEL_MAX_ROW_INDEX, EXCEL_MAX_COL_INDEX),
            (0, 30)
        );
    }

    #[test]
    fn edge_direction_parses_wire_spellings_only() {
        assert_eq!(EdgeDirection::parse("up"), Some(EdgeDirection::Up));
        assert_eq!(EdgeDirection::parse("down"), Some(EdgeDirection::Down));
        assert_eq!(EdgeDirection::parse("left"), Some(EdgeDirection::Left));
        assert_eq!(EdgeDirection::parse("right"), Some(EdgeDirection::Right));
        assert_eq!(EdgeDirection::parse("Up"), None);
        assert_eq!(EdgeDirection::parse("xlUp"), None);
        assert_eq!(EdgeDirection::parse(""), None);
    }

    #[test]
    fn current_region_expands_to_the_contiguous_block() {
        let mut g = Grid::new();
        // 3x2 block at B2:C4 (rows 1..=3, cols 1..=2).
        for r in 1..=3 {
            for c in 1..=2 {
                g.set_cell(r, c, text_cell("x"));
            }
        }
        // Distant cell that must NOT be swallowed (separated by empty gap).
        g.set_cell(10, 10, text_cell("far"));

        // From inside, from a corner, and from an empty cell ADJACENT to the
        // block (Excel includes the neighbor case).
        assert_eq!(current_region(&g, 2, 1), Some((1, 1, 3, 2)));
        assert_eq!(current_region(&g, 1, 1), Some((1, 1, 3, 2)));
        assert_eq!(current_region(&g, 0, 1), Some((0, 1, 3, 2)));
    }

    #[test]
    fn current_region_isolated_empty_cell_is_none() {
        let g = fixture();
        assert_eq!(current_region(&g, 50, 30), None);
    }

    #[test]
    fn current_region_isolated_nonempty_cell_is_itself() {
        let mut g = Grid::new();
        g.set_cell(5, 5, text_cell("solo"));
        assert_eq!(current_region(&g, 5, 5), Some((5, 5, 5, 5)));
    }

    #[test]
    fn current_region_counts_formula_cells_as_content() {
        let mut g = Grid::new();
        g.set_cell(0, 0, text_cell("a"));
        // A formula cell whose VALUE is empty still extends the region.
        g.set_cell(
            1,
            0,
            Cell {
                ast: Some(Box::new(Expression::Literal(Value::Number(1.0)))),
                value: CellValue::Empty,
                style_index: 0,
                rich_text: None,
            },
        );
        assert_eq!(current_region(&g, 0, 0), Some((0, 0, 1, 0)));
    }

    #[test]
    fn used_range_none_when_empty_and_bounds_otherwise() {
        let g = Grid::new();
        assert_eq!(used_range(&g), None);

        let mut g = Grid::new();
        g.set_cell(2, 3, text_cell("a"));
        g.set_cell(7, 1, text_cell("b"));
        assert_eq!(used_range(&g), Some((2, 1, 7, 3)));
    }
}
