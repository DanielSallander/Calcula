//! FILENAME: core/engine/src/grid.rs
//! PURPOSE: Manages the collection of cells (The Spreadsheet Grid).
//! CONTEXT: This file defines the `Grid` struct which acts as the container
//! for all cell data. It uses a sparse storage strategy (HashMap) to
//! efficiently handle massive spreadsheets where most cells are empty.

use rustc_hash::FxHashMap;
use crate::cell::{Cell, CellValue};

/// Sparse cell storage keyed by (row, col). Uses FxHash — every formula
/// evaluation probes this map per referenced cell, and the default SipHash
/// costs 2-3x more per probe for these tiny keys.
pub type CellMap = FxHashMap<(u32, u32), Cell>;

/// The Grid struct holds the state of the spreadsheet data.
/// It uses a sparse representation (HashMap) mapping coordinates to Cells.
/// Row and Col are 0-based indices.
#[derive(Debug, Clone)]
pub struct Grid {
    /// Sparse storage: keys are (row, col), values are Cell instances.
    /// Row and Col are 0-based indices.
    pub cells: CellMap,

    /// Tracks the highest row index currently in use.
    pub max_row: u32,
    
    /// Tracks the highest column index currently in use.
    pub max_col: u32,

    /// Default style for an entire ROW, by row index.
    ///
    /// Excel's `<row s="..">` tier. Without this, styling a whole row or column
    /// means materializing a `Cell` at every position — 1,048,576 of them for a
    /// column — which inflates `max_row`/`max_col`, the used range, the saved
    /// file and every full-grid scan. With it, a whole-column format is ONE
    /// entry.
    pub row_styles: FxHashMap<u32, usize>,

    /// Default style for an entire COLUMN, by column index. Excel's
    /// `<col s="..">` tier. Consulted after [`Grid::row_styles`].
    pub column_styles: FxHashMap<u32, usize>,
}

impl Grid {
    /// Creates a new, empty Grid.
    pub fn new() -> Self {
        Grid {
            cells: CellMap::default(),
            max_row: 0,
            max_col: 0,
            row_styles: FxHashMap::default(),
            column_styles: FxHashMap::default(),
        }
    }

    /// The style index that actually applies at (row, col).
    ///
    /// Resolution order, matching Excel: **cell > row > column > default**.
    ///
    /// `style_index == 0` on a cell means INHERIT, not "explicitly default".
    /// Index 0 is the default style, and a cell that has never been formatted
    /// carries 0, so treating it as an explicit choice would make every
    /// pre-existing cell opaque to a row or column style applied later — the
    /// tier would only ever affect empty positions, which defeats it.
    ///
    /// Consequence to be aware of: Clear Formats (which sets `style_index = 0`)
    /// now returns a cell to its row/column default rather than to the workbook
    /// default. That is what Excel does.
    ///
    /// With no row or column styles registered this returns exactly
    /// `cell.style_index`, so the tier is inert until something writes to it.
    pub fn effective_style_index(&self, row: u32, col: u32) -> usize {
        if let Some(cell) = self.cells.get(&(row, col)) {
            if cell.style_index != 0 {
                return cell.style_index;
            }
        }
        if let Some(&idx) = self.row_styles.get(&row) {
            if idx != 0 {
                return idx;
            }
        }
        if let Some(&idx) = self.column_styles.get(&col) {
            if idx != 0 {
                return idx;
            }
        }
        0
    }

    /// Set (or clear, with index 0) the default style for a whole row.
    pub fn set_row_style(&mut self, row: u32, style_index: usize) {
        if style_index == 0 {
            self.row_styles.remove(&row);
        } else {
            self.row_styles.insert(row, style_index);
        }
    }

    /// Set (or clear, with index 0) the default style for a whole column.
    pub fn set_column_style(&mut self, col: u32, style_index: usize) {
        if style_index == 0 {
            self.column_styles.remove(&col);
        } else {
            self.column_styles.insert(col, style_index);
        }
    }

    /// Rewrite EVERY style index this grid holds through `remap` (local index
    /// -> shared index): per-cell indices AND the row/column tiers. Counterpart
    /// of `StyleRegistry::merge_remap`; forgetting the tiers here was how a
    /// pulled .calp sheet ended up wearing unrelated host styles.
    pub fn remap_style_indices(&mut self, remap: &[usize]) {
        for cell in self.cells.values_mut() {
            if cell.style_index < remap.len() {
                cell.style_index = remap[cell.style_index];
            }
        }
        for idx in self.row_styles.values_mut() {
            if *idx < remap.len() {
                *idx = remap[*idx];
            }
        }
        for idx in self.column_styles.values_mut() {
            if *idx < remap.len() {
                *idx = remap[*idx];
            }
        }
    }

    /// Sets a cell at the specified coordinates.
    /// Updates max_row/max_col boundaries automatically.
    pub fn set_cell(&mut self, row: u32, col: u32, cell: Cell) {
        if row > self.max_row {
            self.max_row = row;
        }
        if col > self.max_col {
            self.max_col = col;
        }
        crate::lookup_cache::notify_write(row, col);
        self.cells.insert((row, col), cell);
    }

    /// Inserts a cell without updating bounds tracking.
    /// Use when doing bulk inserts followed by a single `update_bounds()` call.
    #[inline(always)]
    pub fn set_cell_unchecked(&mut self, row: u32, col: u32, cell: Cell) {
        crate::lookup_cache::notify_write(row, col);
        self.cells.insert((row, col), cell);
    }

    /// Updates max_row/max_col to cover the specified region.
    /// Call after a batch of `set_cell_unchecked` operations.
    pub fn update_bounds(&mut self, max_row: u32, max_col: u32) {
        if max_row > self.max_row {
            self.max_row = max_row;
        }
        if max_col > self.max_col {
            self.max_col = max_col;
        }
    }

    /// Retrieves a reference to a cell at the specified coordinates.
    /// Returns None if the cell is empty (not stored).
    pub fn get_cell(&self, row: u32, col: u32) -> Option<&Cell> {
        self.cells.get(&(row, col))
    }

    /// Removes a cell from the grid (clearing it).
    /// If the cell was at a boundary (max_row or max_col), recalculates bounds.
    pub fn clear_cell(&mut self, row: u32, col: u32) {
        let was_at_boundary = row == self.max_row || col == self.max_col;
        crate::lookup_cache::notify_write(row, col);
        self.cells.remove(&(row, col));
        
        // Only recalculate bounds if we cleared a cell at a boundary
        if was_at_boundary {
            self.recalculate_bounds();
        }
    }

    /// Clears all cells in the given rectangular region without per-cell
    /// bounds recalculation. Bounds are recalculated once at the end.
    pub fn clear_region(&mut self, start_row: u32, start_col: u32, end_row: u32, end_col: u32) {
        crate::lookup_cache::notify_write_rect(start_row, end_row, start_col, end_col);
        for row in start_row..=end_row {
            for col in start_col..=end_col {
                self.cells.remove(&(row, col));
            }
        }
        self.recalculate_bounds();
    }

    /// Recalculates max_row and max_col by scanning all cells.
    /// This is O(n) where n is the number of non-empty cells.
    /// Called automatically when boundary cells are cleared.
    pub fn recalculate_bounds(&mut self) {
        if self.cells.is_empty() {
            self.max_row = 0;
            self.max_col = 0;
            return;
        }
        
        let mut new_max_row = 0u32;
        let mut new_max_col = 0u32;
        
        for &(row, col) in self.cells.keys() {
            if row > new_max_row {
                new_max_row = row;
            }
            if col > new_max_col {
                new_max_col = col;
            }
        }
        
        self.max_row = new_max_row;
        self.max_col = new_max_col;
    }

    // ========================================================================
    // FIND & REPLACE
    // ========================================================================

    /// Search for cells containing the query string.
    /// Returns coordinates sorted by row then column (reading order).
    /// 
    /// Options:
    /// - `case_sensitive`: If false, comparison is case-insensitive
    /// - `match_entire_cell`: If true, only matches if cell content equals query exactly
    /// - `search_formulas`: If true, also search in formula text (not just displayed values)
    pub fn find_all(
        &self,
        query: &str,
        case_sensitive: bool,
        match_entire_cell: bool,
        search_formulas: bool,
    ) -> Vec<(u32, u32)> {
        if query.is_empty() {
            return Vec::new();
        }

        let query_normalized = if case_sensitive {
            query.to_string()
        } else {
            query.to_lowercase()
        };

        let mut matches: Vec<(u32, u32)> = self
            .cells
            .iter()
            .filter(|(_, cell)| {
                self.cell_matches(cell, &query_normalized, case_sensitive, match_entire_cell, search_formulas)
            })
            .map(|(&pos, _)| pos)
            .collect();

        // Sort by row, then by column (reading order)
        matches.sort_by(|a, b| {
            if a.0 != b.0 {
                a.0.cmp(&b.0)
            } else {
                a.1.cmp(&b.1)
            }
        });

        matches
    }

    /// Check if a cell matches the search query.
    fn cell_matches(
        &self,
        cell: &Cell,
        query: &str,
        case_sensitive: bool,
        match_entire_cell: bool,
        search_formulas: bool,
    ) -> bool {
        // Get the display value of the cell
        let display_value = self.get_cell_display_value(cell);
        
        let display_normalized = if case_sensitive {
            display_value.clone()
        } else {
            display_value.to_lowercase()
        };

        // Check display value
        let display_matches = if match_entire_cell {
            display_normalized == *query
        } else {
            display_normalized.contains(query)
        };

        if display_matches {
            return true;
        }

        // Optionally check formula text
        if search_formulas {
            if let Some(formula) = cell.formula_string() {
                let formula_normalized = if case_sensitive {
                    formula
                } else {
                    formula.to_lowercase()
                };

                if match_entire_cell {
                    return formula_normalized == *query;
                } else {
                    return formula_normalized.contains(query);
                }
            }
        }

        false
    }

    /// Get the display value of a cell as a string.
    fn get_cell_display_value(&self, cell: &Cell) -> String {
        match &cell.value {
            CellValue::Empty => String::new(),
            CellValue::Number(n) => {
                // Simple formatting - detailed formatting happens at display layer
                if n.fract() == 0.0 {
                    format!("{:.0}", n)
                } else {
                    format!("{}", n)
                }
            }
            CellValue::Text(s) => s.clone(),
            CellValue::Boolean(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
            CellValue::Error(e) => format!("#{:?}", e).to_uppercase(),
            CellValue::List(items) => format!("[List({})]", items.len()),
            CellValue::Dict(entries) => format!("[Dict({})]", entries.len()),
        }
    }

    /// Count occurrences of a search query in the grid.
    pub fn count_matches(
        &self,
        query: &str,
        case_sensitive: bool,
        match_entire_cell: bool,
        search_formulas: bool,
    ) -> usize {
        self.find_all(query, case_sensitive, match_entire_cell, search_formulas).len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_find_all_basic() {
        let mut grid = Grid::new();
        grid.set_cell(0, 0, Cell::new_text("hello".to_string()));
        grid.set_cell(1, 0, Cell::new_text("world".to_string()));
        grid.set_cell(2, 0, Cell::new_text("hello world".to_string()));

        let results = grid.find_all("hello", false, false, false);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0], (0, 0));
        assert_eq!(results[1], (2, 0));
    }

    #[test]
    fn test_find_all_case_insensitive() {
        let mut grid = Grid::new();
        grid.set_cell(0, 0, Cell::new_text("Hello".to_string()));
        grid.set_cell(1, 0, Cell::new_text("HELLO".to_string()));

        let results = grid.find_all("hello", false, false, false);
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn test_find_all_match_entire_cell() {
        let mut grid = Grid::new();
        grid.set_cell(0, 0, Cell::new_text("hello".to_string()));
        grid.set_cell(1, 0, Cell::new_text("hello world".to_string()));

        let results = grid.find_all("hello", false, true, false);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0], (0, 0));
    }

    #[test]
    fn test_find_numbers() {
        let mut grid = Grid::new();
        grid.set_cell(0, 0, Cell::new_number(123.0));
        grid.set_cell(1, 0, Cell::new_number(456.0));
        grid.set_cell(2, 0, Cell::new_number(1234.0));

        let results = grid.find_all("123", false, false, false);
        assert_eq!(results.len(), 2); // 123 and 1234
    }

    // ------------------------------------------------------------------
    // Row / column style tiers
    // ------------------------------------------------------------------

    fn styled(style_index: usize) -> Cell {
        let mut c = Cell::new();
        c.style_index = style_index;
        c
    }

    #[test]
    fn with_no_tiers_the_resolver_is_todays_behaviour() {
        // The whole tier is inert until something writes to it, which is what
        // makes it safe to introduce ahead of the readers.
        let mut grid = Grid::new();
        grid.set_cell(0, 0, styled(7));
        assert_eq!(grid.effective_style_index(0, 0), 7);
        assert_eq!(grid.effective_style_index(5, 5), 0, "absent cell");
    }

    #[test]
    fn a_column_style_reaches_cells_that_already_exist() {
        // The point of "0 means inherit": a cell that was typed into before the
        // column was styled carries style_index 0, and must still pick the
        // column up. Treating 0 as an explicit choice would make the tier apply
        // only to empty positions.
        let mut grid = Grid::new();
        grid.set_cell(3, 2, Cell::new()); // typed, never formatted -> index 0
        grid.set_column_style(2, 9);
        assert_eq!(grid.effective_style_index(3, 2), 9);
        assert_eq!(grid.effective_style_index(3, 1), 0, "other column unaffected");
    }

    #[test]
    fn resolution_order_is_cell_then_row_then_column() {
        let mut grid = Grid::new();
        grid.set_column_style(0, 3);
        assert_eq!(grid.effective_style_index(0, 0), 3, "column applies");

        grid.set_row_style(0, 5);
        assert_eq!(grid.effective_style_index(0, 0), 5, "row beats column");

        grid.set_cell(0, 0, styled(8));
        assert_eq!(grid.effective_style_index(0, 0), 8, "cell beats row");
    }

    #[test]
    fn a_column_style_costs_one_entry_not_a_million_cells() {
        // The reason this tier exists: styling a whole column must not
        // materialize a Cell per row, which would inflate max_row and the used
        // range and be persisted in full.
        let mut grid = Grid::new();
        grid.set_column_style(4, 2);
        assert_eq!(grid.column_styles.len(), 1);
        assert!(grid.cells.is_empty(), "no cells materialized");
        assert_eq!(grid.max_row, 0, "used range untouched");
        // ...and it still resolves anywhere down the column.
        assert_eq!(grid.effective_style_index(1_048_575, 4), 2);
    }

    #[test]
    fn clearing_formats_returns_a_cell_to_its_tier_not_to_the_workbook_default() {
        // Clear Formats sets style_index = 0, which under "0 means inherit"
        // falls back to the row/column tier. Excel behaves the same way. The
        // consequence worth knowing: because lock state is a style attribute,
        // Clear Formats also drops a per-cell LOCK override.
        let mut grid = Grid::new();
        grid.set_column_style(1, 5); // e.g. an unlocked input column
        let mut overridden = Cell::new();
        overridden.style_index = 9; // cell-level override, e.g. re-locked
        grid.set_cell(2, 1, overridden);
        assert_eq!(grid.effective_style_index(2, 1), 9);

        // Clear Formats
        let mut cleared = grid.get_cell(2, 1).unwrap().clone();
        cleared.style_index = 0;
        grid.set_cell(2, 1, cleared);

        assert_eq!(
            grid.effective_style_index(2, 1),
            5,
            "falls back to the column tier, not to 0"
        );
    }

    #[test]
    fn tiers_are_index_keyed_so_a_structural_edit_must_renumber_them() {
        // Pins WHY commands/structure.rs shifts these. A column style is stored
        // against a column INDEX, so inserting a column to its left leaves the
        // style on the wrong column unless something renumbers it — the same
        // drift class as comments, notes and allow-edit ranges.
        let mut grid = Grid::new();
        grid.set_column_style(3, 9);
        assert_eq!(grid.effective_style_index(0, 3), 9);

        // Simulate the shift a column-insert at 0 must perform.
        let shifted: Vec<(u32, usize)> =
            grid.column_styles.iter().map(|(&c, &s)| (c + 1, s)).collect();
        grid.column_styles.clear();
        for (c, s) in shifted {
            grid.set_column_style(c, s);
        }

        assert_eq!(grid.effective_style_index(0, 4), 9, "moved with its column");
        assert_eq!(grid.effective_style_index(0, 3), 0, "old column is bare");
    }

    #[test]
    fn setting_a_tier_to_index_zero_clears_it() {
        let mut grid = Grid::new();
        grid.set_row_style(1, 6);
        assert_eq!(grid.effective_style_index(1, 0), 6);
        grid.set_row_style(1, 0);
        assert!(grid.row_styles.is_empty(), "cleared, not stored as 0");
        assert_eq!(grid.effective_style_index(1, 0), 0);
    }
}