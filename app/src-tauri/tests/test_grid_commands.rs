//! FILENAME: tests/test_grid_commands.rs
//! Integration tests for grid commands (get_viewport_cells, get_cell, update_cell, etc.)

mod common;

use app_lib::{
    create_app_state, AppState, CellData, MergedRegion,
    parse_cell_input, format_cell_value, evaluate_formula,
};
use common::{TestHarness, assert_cell_number, assert_cell_text, assert_cell_empty, assert_cell_boolean};
use engine::{Cell, CellValue, Grid, CellStyle};
use std::collections::HashSet;

// ============================================================================
// GET CELL TESTS
// ============================================================================

#[test]
fn test_get_cell_empty() {
    let harness = TestHarness::new();
    let value = harness.get_cell_value(0, 0);
    assert!(value.is_none() || matches!(value, Some(CellValue::Empty)));
}

#[test]
fn test_get_cell_with_number() {
    let harness = TestHarness::new();
    harness.set_cell(0, 0, Cell::new_number(42.0));
    assert_cell_number(&harness, 0, 0, 42.0);
}

#[test]
fn test_get_cell_with_text() {
    let harness = TestHarness::new();
    harness.set_cell(0, 0, Cell::new_text("Hello World".to_string()));
    assert_cell_text(&harness, 0, 0, "Hello World");
}

#[test]
fn test_get_cell_with_boolean() {
    let harness = TestHarness::new();
    harness.set_cell(0, 0, Cell::new_boolean(true));
    harness.set_cell(0, 1, Cell::new_boolean(false));
    assert_cell_boolean(&harness, 0, 0, true);
    assert_cell_boolean(&harness, 0, 1, false);
}

#[test]
fn test_get_cell_with_formula() {
    let harness = TestHarness::with_formula_data();
    // C1 should have formula =A1+B1
    let formula = harness.get_cell_formula(0, 2);
    assert_eq!(formula, Some("=A1+B1".to_string()));
}

// ============================================================================
// SET CELL TESTS (via parse_cell_input)
// ============================================================================

#[test]
fn test_set_cell_input_number() {
    let harness = TestHarness::new();
    harness.set_cell_input(0, 0, "123.45");
    assert_cell_number(&harness, 0, 0, 123.45);
}

#[test]
fn test_set_cell_input_negative_number() {
    let harness = TestHarness::new();
    harness.set_cell_input(0, 0, "-500");
    assert_cell_number(&harness, 0, 0, -500.0);
}

#[test]
fn test_set_cell_input_percentage() {
    let harness = TestHarness::new();
    harness.set_cell_input(0, 0, "50%");
    assert_cell_number(&harness, 0, 0, 0.5);
}

#[test]
fn test_set_cell_input_text() {
    let harness = TestHarness::new();
    harness.set_cell_input(0, 0, "Hello");
    assert_cell_text(&harness, 0, 0, "Hello");
}

#[test]
fn test_set_cell_input_boolean_true() {
    let harness = TestHarness::new();
    harness.set_cell_input(0, 0, "TRUE");
    assert_cell_boolean(&harness, 0, 0, true);
}

#[test]
fn test_set_cell_input_boolean_false_lowercase() {
    let harness = TestHarness::new();
    harness.set_cell_input(0, 0, "false");
    assert_cell_boolean(&harness, 0, 0, false);
}

#[test]
fn test_set_cell_input_formula() {
    let harness = TestHarness::new();
    harness.set_cell(0, 0, Cell::new_number(10.0));
    harness.set_cell(0, 1, Cell::new_number(20.0));
    harness.set_cell_input(0, 2, "=A1+B1");
    let formula = harness.get_cell_formula(0, 2);
    assert_eq!(formula, Some("=A1+B1".to_string()));
}

#[test]
fn test_set_cell_input_empty_clears_cell() {
    let harness = TestHarness::new();
    harness.set_cell(0, 0, Cell::new_number(100.0));
    harness.set_cell_input(0, 0, "");
    assert_cell_empty(&harness, 0, 0);
}

#[test]
fn test_set_cell_input_thousands_separator() {
    let harness = TestHarness::new();
    harness.set_cell_input(0, 0, "1,234,567");
    assert_cell_number(&harness, 0, 0, 1234567.0);
}

// ============================================================================
// VIEWPORT CELLS TESTS
// ============================================================================

#[test]
fn test_get_viewport_cells_empty_grid() {
    let harness = TestHarness::new();
    let grid = harness.state.grid.lock().unwrap();
    let styles = harness.state.style_registry.lock().unwrap();
    let merged = harness.state.merged_regions.lock().unwrap();

    // Check that an empty grid returns no cells in viewport
    let cell_count = grid.cells.len();
    assert_eq!(cell_count, 0);
}

#[test]
fn test_get_viewport_cells_with_data() {
    let harness = TestHarness::with_sample_data();
    let grid = harness.state.grid.lock().unwrap();

    // Sample data has 10 rows (1 header + 9 data rows) x 5 columns
    assert!(grid.cells.len() > 0);

    // Check specific cells
    drop(grid);
    assert_cell_text(&harness, 0, 0, "Name"); // Header
    assert_cell_text(&harness, 1, 0, "Alice"); // First data row
}

#[test]
fn test_get_viewport_partial_range() {
    let harness = TestHarness::with_sample_data();

    // Get only rows 1-3, columns 0-2
    let grid = harness.state.grid.lock().unwrap();
    let mut count = 0;
    for row in 1..=3 {
        for col in 0..=2 {
            if grid.get_cell(row, col).is_some() {
                count += 1;
            }
        }
    }
    // Should have 3 rows x 3 cols = 9 cells (all with data)
    assert_eq!(count, 9);
}

// ============================================================================
// CLEAR CELL TESTS
// ============================================================================

#[test]
fn test_clear_single_cell() {
    let harness = TestHarness::new();
    harness.set_cell(0, 0, Cell::new_number(100.0));

    // Clear the cell
    {
        let mut grid = harness.state.grid.lock().unwrap();
        grid.clear_cell(0, 0);
    }

    assert_cell_empty(&harness, 0, 0);
}

#[test]
fn test_clear_range() {
    let harness = TestHarness::with_sample_data();

    // Clear range A1:C3
    {
        let mut grid = harness.state.grid.lock().unwrap();
        for row in 0..3 {
            for col in 0..3 {
                grid.clear_cell(row, col);
            }
        }
    }

    // Verify cleared
    for row in 0..3 {
        for col in 0..3 {
            assert_cell_empty(&harness, row, col);
        }
    }

    // Check that cells outside range are still there
    assert_cell_number(&harness, 1, 3, 75000.0); // Salary column still has data
}

// ============================================================================
// GRID BOUNDS TESTS
// ============================================================================

#[test]
fn test_get_grid_bounds_empty() {
    let harness = TestHarness::new();
    let grid = harness.state.grid.lock().unwrap();

    // Empty grid should have bounds at origin or very small
    let max_row = grid.cells.keys().map(|(r, _)| *r).max().unwrap_or(0);
    let max_col = grid.cells.keys().map(|(_, c)| *c).max().unwrap_or(0);

    assert_eq!(max_row, 0);
    assert_eq!(max_col, 0);
}

#[test]
fn test_get_grid_bounds_with_data() {
    let harness = TestHarness::with_sample_data();
    let grid = harness.state.grid.lock().unwrap();

    let max_row = grid.cells.keys().map(|(r, _)| *r).max().unwrap_or(0);
    let max_col = grid.cells.keys().map(|(_, c)| *c).max().unwrap_or(0);

    // Sample data: 10 rows (0-9), 5 columns (0-4)
    assert_eq!(max_row, 9);
    assert_eq!(max_col, 4);
}

#[test]
fn test_get_grid_bounds_sparse() {
    let harness = TestHarness::new();
    harness.set_cell(100, 50, Cell::new_number(1.0)); // Far cell

    let grid = harness.state.grid.lock().unwrap();
    let max_row = grid.cells.keys().map(|(r, _)| *r).max().unwrap_or(0);
    let max_col = grid.cells.keys().map(|(_, c)| *c).max().unwrap_or(0);

    assert_eq!(max_row, 100);
    assert_eq!(max_col, 50);
}

// ============================================================================
// CELL COUNT TESTS
// ============================================================================

#[test]
fn test_get_cell_count_empty() {
    let harness = TestHarness::new();
    assert_eq!(harness.get_cell_count(), 0);
}

#[test]
fn test_get_cell_count_with_data() {
    let harness = TestHarness::with_sample_data();
    // 1 header row (5 cells) + 9 data rows (5 cells each) = 50 cells
    assert_eq!(harness.get_cell_count(), 50);
}

#[test]
fn test_get_cell_count_after_clear() {
    let harness = TestHarness::with_sample_data();
    let initial_count = harness.get_cell_count();

    // Clear one cell
    {
        let mut grid = harness.state.grid.lock().unwrap();
        grid.clear_cell(0, 0);
    }

    assert_eq!(harness.get_cell_count(), initial_count - 1);
}

// ============================================================================
// MERGED CELLS TESTS
// ============================================================================

#[test]
fn test_merged_region_creation() {
    let harness = TestHarness::new();
    harness.set_cell(0, 0, Cell::new_text("Merged Header".to_string()));
    harness.add_merged_region(0, 0, 0, 3); // A1:D1 merged

    let merged = harness.state.merged_regions.lock().unwrap();
    assert_eq!(merged.len(), 1);

    let region = merged.iter().next().unwrap();
    assert_eq!(region.start_row, 0);
    assert_eq!(region.start_col, 0);
    assert_eq!(region.end_row, 0);
    assert_eq!(region.end_col, 3);
}

#[test]
fn test_merged_region_span() {
    let harness = TestHarness::new();
    harness.add_merged_region(0, 0, 2, 2); // A1:C3 merged (3x3)

    let merged = harness.state.merged_regions.lock().unwrap();
    let region = merged.iter().next().unwrap();

    let row_span = region.end_row - region.start_row + 1;
    let col_span = region.end_col - region.start_col + 1;

    assert_eq!(row_span, 3);
    assert_eq!(col_span, 3);
}

// ============================================================================
// FORMULA EVALUATION TESTS
// ============================================================================

#[test]
fn test_formula_simple_addition() {
    let mut grid = Grid::new();
    grid.set_cell(0, 0, Cell::new_number(10.0));
    grid.set_cell(0, 1, Cell::new_number(20.0));

    let result = evaluate_formula(&grid, "=A1+B1");
    assert!(matches!(result, CellValue::Number(n) if (n - 30.0).abs() < 0.001));
}

#[test]
fn test_formula_multiplication() {
    let mut grid = Grid::new();
    grid.set_cell(0, 0, Cell::new_number(5.0));
    grid.set_cell(0, 1, Cell::new_number(4.0));

    let result = evaluate_formula(&grid, "=A1*B1");
    assert!(matches!(result, CellValue::Number(n) if (n - 20.0).abs() < 0.001));
}

#[test]
fn test_formula_sum_range() {
    let mut grid = Grid::new();
    for i in 0..5 {
        grid.set_cell(i, 0, Cell::new_number((i + 1) as f64 * 10.0));
    }

    let result = evaluate_formula(&grid, "=SUM(A1:A5)");
    // 10 + 20 + 30 + 40 + 50 = 150
    assert!(matches!(result, CellValue::Number(n) if (n - 150.0).abs() < 0.001));
}

#[test]
fn test_formula_average() {
    let mut grid = Grid::new();
    for i in 0..5 {
        grid.set_cell(i, 0, Cell::new_number((i + 1) as f64 * 10.0));
    }

    let result = evaluate_formula(&grid, "=AVERAGE(A1:A5)");
    // Average of 10, 20, 30, 40, 50 = 30
    assert!(matches!(result, CellValue::Number(n) if (n - 30.0).abs() < 0.001));
}

#[test]
fn test_formula_nested_operations() {
    let mut grid = Grid::new();
    grid.set_cell(0, 0, Cell::new_number(10.0));
    grid.set_cell(0, 1, Cell::new_number(2.0));

    let result = evaluate_formula(&grid, "=(A1+B1)*3");
    // (10 + 2) * 3 = 36
    assert!(matches!(result, CellValue::Number(n) if (n - 36.0).abs() < 0.001));
}

#[test]
fn test_formula_division_by_zero() {
    let grid = Grid::new();

    let result = evaluate_formula(&grid, "=1/0");
    assert!(matches!(result, CellValue::Error(_)));
}

// ============================================================================
// SORT RANGE TESTS
// ============================================================================

#[test]
fn test_sort_data_preparation() {
    let harness = TestHarness::with_sample_data();

    // Verify initial order (should be Alice, Bob, Charlie, ...)
    assert_cell_text(&harness, 1, 0, "Alice");
    assert_cell_text(&harness, 2, 0, "Bob");
    assert_cell_text(&harness, 3, 0, "Charlie");
}

#[test]
fn test_sort_by_age_ascending() {
    let harness = TestHarness::with_sample_data();
    let mut grid = harness.state.grid.lock().unwrap();

    // Collect data rows (skip header at row 0)
    let mut rows: Vec<Vec<(u32, u32, Cell)>> = Vec::new();
    for row in 1..=9 {
        let mut row_data = Vec::new();
        for col in 0..5 {
            if let Some(cell) = grid.get_cell(row, col) {
                row_data.push((row, col, cell.clone()));
            }
        }
        if !row_data.is_empty() {
            rows.push(row_data);
        }
    }

    // Sort by age (column 1 = B)
    rows.sort_by(|a, b| {
        let age_a = a.iter().find(|(_, c, _)| *c == 1).map(|(_, _, cell)| {
            if let CellValue::Number(n) = cell.value { n } else { 0.0 }
        }).unwrap_or(0.0);
        let age_b = b.iter().find(|(_, c, _)| *c == 1).map(|(_, _, cell)| {
            if let CellValue::Number(n) = cell.value { n } else { 0.0 }
        }).unwrap_or(0.0);
        age_a.partial_cmp(&age_b).unwrap()
    });

    // Youngest should be Bob (25)
    let first_row = &rows[0];
    let name_cell = first_row.iter().find(|(_, c, _)| *c == 0).unwrap();
    assert!(matches!(&name_cell.2.value, CellValue::Text(s) if s == "Bob"));
}

// ============================================================================
// LARGE DATA TESTS
// ============================================================================

#[test]
fn test_large_grid_creation() {
    let harness = TestHarness::with_large_data(100, 50);
    let cell_count = harness.get_cell_count();

    // Should have 100 * 50 = 5000 cells
    assert_eq!(cell_count, 5000);
}

#[test]
fn test_large_grid_random_access() {
    let harness = TestHarness::with_large_data(1000, 100);

    // Access random cells - should be fast
    assert_cell_number(&harness, 500, 50, (500.0 * 100.0) + 50.0);
    assert_cell_number(&harness, 999, 99, (999.0 * 100.0) + 99.0);
    assert_cell_number(&harness, 0, 0, 0.0);
}

// ============================================================================
// EDGE CASES
// ============================================================================

#[test]
fn test_special_characters_in_text() {
    let harness = TestHarness::new();
    harness.set_cell(0, 0, Cell::new_text("Hello\nWorld".to_string()));
    harness.set_cell(0, 1, Cell::new_text("Tab\there".to_string()));
    harness.set_cell(0, 2, Cell::new_text("Quotes \"test\"".to_string()));

    assert_cell_text(&harness, 0, 0, "Hello\nWorld");
    assert_cell_text(&harness, 0, 1, "Tab\there");
    assert_cell_text(&harness, 0, 2, "Quotes \"test\"");
}

#[test]
fn test_unicode_text() {
    let harness = TestHarness::new();
    harness.set_cell(0, 0, Cell::new_text("日本語".to_string()));
    harness.set_cell(0, 1, Cell::new_text("émojis 🎉".to_string()));
    harness.set_cell(0, 2, Cell::new_text("Ñoño".to_string()));

    assert_cell_text(&harness, 0, 0, "日本語");
    assert_cell_text(&harness, 0, 1, "émojis 🎉");
    assert_cell_text(&harness, 0, 2, "Ñoño");
}

#[test]
fn test_very_large_numbers() {
    let harness = TestHarness::new();
    harness.set_cell(0, 0, Cell::new_number(1e308)); // Near max f64
    harness.set_cell(0, 1, Cell::new_number(1e-308)); // Near min positive f64

    let val1 = harness.get_cell_value(0, 0);
    let val2 = harness.get_cell_value(0, 1);

    assert!(matches!(val1, Some(CellValue::Number(n)) if n > 1e307));
    assert!(matches!(val2, Some(CellValue::Number(n)) if n < 1e-307 && n > 0.0));
}

#[test]
fn test_zero_values() {
    let harness = TestHarness::new();
    harness.set_cell(0, 0, Cell::new_number(0.0));
    harness.set_cell(0, 1, Cell::new_number(-0.0));

    assert_cell_number(&harness, 0, 0, 0.0);
    assert_cell_number(&harness, 0, 1, 0.0); // -0.0 should equal 0.0
}
