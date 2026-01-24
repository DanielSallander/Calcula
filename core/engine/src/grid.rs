//! FILENAME: core/engine/src/grid.rs
//! PURPOSE: Manages the collection of cells (The Spreadsheet Grid).
//! CONTEXT: This file defines the `Grid` struct which acts as the container
//! for all cell data. It uses a sparse storage strategy (HashMap) to
//! efficiently handle massive spreadsheets where most cells are empty.

use std::collections::HashMap;
use crate::cell::{Cell, CellValue};

/// The Grid struct holds the state of the spreadsheet data.
/// It uses a sparse representation (HashMap) mapping coordinates to Cells.
/// Row and Col are 0-based indices.
#[derive(Debug, Clone)]
pub struct Grid {
    /// Sparse storage: keys are (row, col), values are Cell instances.
    /// Row and Col are 0-based indices.
    pub cells: HashMap<(u32, u32), Cell>,

    /// Tracks the highest row index currently in use.
    pub max_row: u32,
    
    /// Tracks the highest column index currently in use.
    pub max_col: u32,
}

impl Grid {
    /// Creates a new, empty Grid.
    pub fn new() -> Self {
        Grid {
            cells: HashMap::new(),
            max_row: 0,
            max_col: 0,
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
        self.cells.insert((row, col), cell);
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
        self.cells.remove(&(row, col));
        
        // Only recalculate bounds if we cleared a cell at a boundary
        if was_at_boundary {
            self.recalculate_bounds();
        }
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
            if let Some(ref formula) = cell.formula {
                let formula_normalized = if case_sensitive {
                    formula.clone()
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
}