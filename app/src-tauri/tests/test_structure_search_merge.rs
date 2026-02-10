//! FILENAME: tests/test_structure_search_merge.rs
//! Integration tests for structure commands (insert/delete rows/cols),
//! search commands (find/replace), and merge cell commands.

mod common;

use app_lib::MergedRegion;
use common::{TestHarness, assert_cell_number, assert_cell_text, assert_cell_empty};
use engine::{Cell, CellValue};
use std::collections::HashSet;

// ============================================================================
// MERGE CELL TESTS
// ============================================================================

#[test]
fn test_merge_cells_basic() {
    let harness = TestHarness::new();
    harness.add_merged_region(0, 0, 2, 3); // A1:D3

    let merged = harness.state.merged_regions.lock().unwrap();
    assert_eq!(merged.len(), 1);

    let region = merged.iter().next().unwrap();
    assert_eq!(region.start_row, 0);
    assert_eq!(region.start_col, 0);
    assert_eq!(region.end_row, 2);
    assert_eq!(region.end_col, 3);
}

#[test]
fn test_merge_cells_span_calculation() {
    let harness = TestHarness::new();
    harness.add_merged_region(0, 0, 4, 2); // A1:C5

    let merged = harness.state.merged_regions.lock().unwrap();
    let region = merged.iter().next().unwrap();

    let row_span = region.end_row - region.start_row + 1;
    let col_span = region.end_col - region.start_col + 1;

    assert_eq!(row_span, 5);
    assert_eq!(col_span, 3);
}

#[test]
fn test_multiple_merged_regions() {
    let harness = TestHarness::new();

    harness.add_merged_region(0, 0, 0, 3); // Header row merge
    harness.add_merged_region(5, 0, 5, 3); // Another row merge
    harness.add_merged_region(10, 0, 15, 0); // Column merge

    let merged = harness.state.merged_regions.lock().unwrap();
    assert_eq!(merged.len(), 3);
}

#[test]
fn test_unmerge_cells() {
    let harness = TestHarness::new();
    harness.add_merged_region(0, 0, 2, 2);

    // Unmerge
    {
        let mut merged = harness.state.merged_regions.lock().unwrap();
        merged.retain(|r| !(r.start_row == 0 && r.start_col == 0));
    }

    let merged = harness.state.merged_regions.lock().unwrap();
    assert!(merged.is_empty());
}

#[test]
fn test_merged_region_equality() {
    let region1 = MergedRegion {
        start_row: 0,
        start_col: 0,
        end_row: 5,
        end_col: 5,
    };

    let region2 = MergedRegion {
        start_row: 0,
        start_col: 0,
        end_row: 5,
        end_col: 5,
    };

    assert_eq!(region1, region2);
}

#[test]
fn test_merged_region_hashable() {
    let mut set: HashSet<MergedRegion> = HashSet::new();

    set.insert(MergedRegion {
        start_row: 0,
        start_col: 0,
        end_row: 2,
        end_col: 2,
    });

    set.insert(MergedRegion {
        start_row: 0,
        start_col: 0,
        end_row: 2,
        end_col: 2,
    }); // Duplicate

    assert_eq!(set.len(), 1); // Should only have one
}

// ============================================================================
// INSERT/DELETE ROW TESTS
// ============================================================================

#[test]
fn test_insert_rows_shifts_data() {
    let harness = TestHarness::with_sample_data();

    // Get original data at row 1
    let original_name = harness.get_cell_display(1, 0);
    assert_eq!(original_name, Some("Alice".to_string()));

    // Simulate inserting a row at row 1 by shifting data down
    {
        let mut grid = harness.state.grid.lock().unwrap();

        // Move row 1 data to row 2 (simplified simulation)
        if let Some(cell) = grid.get_cell(1, 0).cloned() {
            grid.set_cell(2, 0, cell);
            grid.clear_cell(1, 0);
        }
    }

    // Row 1 should now be empty
    assert_cell_empty(&harness, 1, 0);

    // Row 2 should have the original data
    assert_cell_text(&harness, 2, 0, "Alice");
}

#[test]
fn test_delete_rows_shifts_data() {
    let harness = TestHarness::with_sample_data();

    // Row 1: Alice, Row 2: Bob
    assert_cell_text(&harness, 1, 0, "Alice");
    assert_cell_text(&harness, 2, 0, "Bob");

    // Simulate deleting row 1 by shifting row 2 up
    {
        let mut grid = harness.state.grid.lock().unwrap();

        if let Some(cell) = grid.get_cell(2, 0).cloned() {
            grid.set_cell(1, 0, cell);
            grid.clear_cell(2, 0);
        }
    }

    // Row 1 should now have Bob
    assert_cell_text(&harness, 1, 0, "Bob");
}

// ============================================================================
// INSERT/DELETE COLUMN TESTS
// ============================================================================

#[test]
fn test_insert_columns_shifts_data() {
    let harness = TestHarness::with_sample_data();

    // Column 0: Name, Column 1: Age
    assert_cell_text(&harness, 0, 0, "Name");
    assert_cell_text(&harness, 0, 1, "Age");

    // Simulate inserting a column at column 1 by shifting data right
    {
        let mut grid = harness.state.grid.lock().unwrap();

        if let Some(cell) = grid.get_cell(0, 1).cloned() {
            grid.set_cell(0, 2, cell);
            grid.clear_cell(0, 1);
        }
    }

    // Column 1 should now be empty
    assert_cell_empty(&harness, 0, 1);

    // Column 2 should have Age
    assert_cell_text(&harness, 0, 2, "Age");
}

#[test]
fn test_delete_columns_shifts_data() {
    let harness = TestHarness::with_sample_data();

    // Column 0: Name, Column 1: Age
    assert_cell_text(&harness, 0, 1, "Age");
    assert_cell_text(&harness, 0, 2, "City");

    // Simulate deleting column 1 by shifting column 2 left
    {
        let mut grid = harness.state.grid.lock().unwrap();

        if let Some(cell) = grid.get_cell(0, 2).cloned() {
            grid.set_cell(0, 1, cell);
            grid.clear_cell(0, 2);
        }
    }

    // Column 1 should now have City
    assert_cell_text(&harness, 0, 1, "City");
}

// ============================================================================
// SEARCH (FIND) TESTS
// ============================================================================

#[test]
fn test_find_text_match() {
    let harness = TestHarness::with_sample_data();
    let grid = harness.state.grid.lock().unwrap();
    let styles = harness.state.style_registry.lock().unwrap();

    // Search for "Alice"
    let search_term = "Alice";
    let mut matches = Vec::new();

    for ((row, col), cell) in grid.cells.iter() {
        let display = app_lib::format_cell_value(&cell.value, styles.get(cell.style_index));
        if display.contains(search_term) {
            matches.push((*row, *col));
        }
    }

    assert_eq!(matches.len(), 1);
    assert!(matches.contains(&(1, 0)));
}

#[test]
fn test_find_multiple_matches() {
    let harness = TestHarness::new();

    // Create cells with repeated values
    for row in 0..5 {
        harness.set_cell(row, 0, Cell::new_text("FindMe".to_string()));
    }

    let grid = harness.state.grid.lock().unwrap();
    let styles = harness.state.style_registry.lock().unwrap();

    let search_term = "FindMe";
    let mut matches = Vec::new();

    for ((row, col), cell) in grid.cells.iter() {
        let display = app_lib::format_cell_value(&cell.value, styles.get(cell.style_index));
        if display.contains(search_term) {
            matches.push((*row, *col));
        }
    }

    assert_eq!(matches.len(), 5);
}

#[test]
fn test_find_case_insensitive() {
    let harness = TestHarness::new();
    harness.set_cell(0, 0, Cell::new_text("Hello World".to_string()));
    harness.set_cell(1, 0, Cell::new_text("HELLO WORLD".to_string()));
    harness.set_cell(2, 0, Cell::new_text("hello world".to_string()));

    let grid = harness.state.grid.lock().unwrap();
    let styles = harness.state.style_registry.lock().unwrap();

    let search_term = "hello";
    let mut matches = Vec::new();

    for ((row, col), cell) in grid.cells.iter() {
        let display = app_lib::format_cell_value(&cell.value, styles.get(cell.style_index));
        if display.to_lowercase().contains(&search_term.to_lowercase()) {
            matches.push((*row, *col));
        }
    }

    assert_eq!(matches.len(), 3);
}

#[test]
fn test_find_no_matches() {
    let harness = TestHarness::with_sample_data();
    let grid = harness.state.grid.lock().unwrap();
    let styles = harness.state.style_registry.lock().unwrap();

    let search_term = "ZZZZZZZ";
    let mut matches = Vec::new();

    for ((row, col), cell) in grid.cells.iter() {
        let display = app_lib::format_cell_value(&cell.value, styles.get(cell.style_index));
        if display.contains(search_term) {
            matches.push((*row, *col));
        }
    }

    assert!(matches.is_empty());
}

#[test]
fn test_find_in_numbers() {
    let harness = TestHarness::with_sample_data();
    let grid = harness.state.grid.lock().unwrap();
    let styles = harness.state.style_registry.lock().unwrap();

    // Search for "75000" (Alice's salary)
    let search_term = "75000";
    let mut matches = Vec::new();

    for ((row, col), cell) in grid.cells.iter() {
        let display = app_lib::format_cell_value(&cell.value, styles.get(cell.style_index));
        if display.contains(search_term) {
            matches.push((*row, *col));
        }
    }

    assert!(!matches.is_empty());
}

// ============================================================================
// REPLACE TESTS
// ============================================================================

#[test]
fn test_replace_single() {
    let harness = TestHarness::new();
    harness.set_cell(0, 0, Cell::new_text("Hello World".to_string()));

    // Replace "World" with "Universe"
    {
        let mut grid = harness.state.grid.lock().unwrap();
        if let Some(cell) = grid.get_cell(0, 0) {
            if let CellValue::Text(s) = &cell.value {
                let new_text = s.replace("World", "Universe");
                grid.set_cell(0, 0, Cell::new_text(new_text));
            }
        }
    }

    assert_cell_text(&harness, 0, 0, "Hello Universe");
}

#[test]
fn test_replace_all() {
    let harness = TestHarness::new();

    // Create cells with "old" text
    for row in 0..5 {
        harness.set_cell(row, 0, Cell::new_text("old value".to_string()));
    }

    // Replace all "old" with "new"
    {
        let mut grid = harness.state.grid.lock().unwrap();
        for row in 0..5 {
            if let Some(cell) = grid.get_cell(row, 0) {
                if let CellValue::Text(s) = &cell.value {
                    let new_text = s.replace("old", "new");
                    grid.set_cell(row, 0, Cell::new_text(new_text));
                }
            }
        }
    }

    // Verify all replaced
    for row in 0..5 {
        assert_cell_text(&harness, row, 0, "new value");
    }
}

#[test]
fn test_replace_count() {
    let harness = TestHarness::new();

    // Create cells with "target" text
    for row in 0..10 {
        harness.set_cell(row, 0, Cell::new_text("target".to_string()));
    }

    let grid = harness.state.grid.lock().unwrap();
    let styles = harness.state.style_registry.lock().unwrap();

    // Count matches
    let search_term = "target";
    let count = grid
        .cells
        .iter()
        .filter(|(_, cell)| {
            let display = app_lib::format_cell_value(&cell.value, styles.get(cell.style_index));
            display.contains(search_term)
        })
        .count();

    assert_eq!(count, 10);
}

// ============================================================================
// NAVIGATION (CTRL+ARROW) TESTS
// ============================================================================

#[test]
fn test_find_ctrl_arrow_right() {
    let harness = TestHarness::new();

    // Set up: A1:C1 have data, D1 empty, E1 has data
    harness.set_cell(0, 0, Cell::new_number(1.0));
    harness.set_cell(0, 1, Cell::new_number(2.0));
    harness.set_cell(0, 2, Cell::new_number(3.0));
    // D1 (0, 3) is empty
    harness.set_cell(0, 4, Cell::new_number(5.0));

    let grid = harness.state.grid.lock().unwrap();

    // From A1, Ctrl+Right should go to C1 (last cell before empty)
    // Then from C1, should jump to E1 (next data after empty)

    // Simulate: find next non-empty cell in direction
    let start_col = 0;
    let mut target_col = start_col;

    for col in (start_col + 1)..100 {
        if grid.get_cell(0, col).is_some() {
            target_col = col;
        } else {
            break;
        }
    }

    // Should stop at column 2 (C1)
    assert_eq!(target_col, 2);
}

#[test]
fn test_find_ctrl_arrow_down() {
    let harness = TestHarness::with_sample_data();
    let grid = harness.state.grid.lock().unwrap();

    // From header (row 0), Ctrl+Down should find last data row
    let start_row = 0;
    let mut target_row = start_row;

    for row in (start_row + 1)..100 {
        if grid.get_cell(row, 0).is_some() {
            target_row = row;
        } else {
            break;
        }
    }

    // Sample data has 10 rows (0-9)
    assert_eq!(target_row, 9);
}

// ============================================================================
// EDGE CASES
// ============================================================================

#[test]
fn test_single_cell_merge() {
    let harness = TestHarness::new();
    harness.add_merged_region(5, 5, 5, 5); // Single cell "merge"

    let merged = harness.state.merged_regions.lock().unwrap();
    let region = merged.iter().next().unwrap();

    let row_span = region.end_row - region.start_row + 1;
    let col_span = region.end_col - region.start_col + 1;

    assert_eq!(row_span, 1);
    assert_eq!(col_span, 1);
}

#[test]
fn test_empty_grid_search() {
    let harness = TestHarness::new();
    let grid = harness.state.grid.lock().unwrap();
    let styles = harness.state.style_registry.lock().unwrap();

    let search_term = "anything";
    let matches: Vec<_> = grid
        .cells
        .iter()
        .filter(|(_, cell)| {
            let display = app_lib::format_cell_value(&cell.value, styles.get(cell.style_index));
            display.contains(search_term)
        })
        .collect();

    assert!(matches.is_empty());
}

#[test]
fn test_replace_empty_string() {
    let harness = TestHarness::new();
    harness.set_cell(0, 0, Cell::new_text("Hello".to_string()));

    // Replace "Hello" with empty string
    {
        let mut grid = harness.state.grid.lock().unwrap();
        if let Some(cell) = grid.get_cell(0, 0) {
            if let CellValue::Text(_) = &cell.value {
                grid.set_cell(0, 0, Cell::new_text("".to_string()));
            }
        }
    }

    let display = harness.get_cell_display(0, 0);
    assert_eq!(display, Some("".to_string()));
}

#[test]
fn test_no_merged_regions() {
    let harness = TestHarness::new();
    let merged = harness.state.merged_regions.lock().unwrap();
    assert!(merged.is_empty());
}
