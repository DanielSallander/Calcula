//! FILENAME: tests/test_dimensions.rs
//! Integration tests for dimension commands (column widths, row heights).

mod common;

use common::TestHarness;

// ============================================================================
// COLUMN WIDTH TESTS
// ============================================================================

#[test]
fn test_set_column_width() {
    let harness = TestHarness::new();
    harness.set_column_width(0, 150.0);

    let widths = harness.state.column_widths.lock().unwrap();
    assert_eq!(widths.get(&0), Some(&150.0));
}

#[test]
fn test_get_column_width_default() {
    let harness = TestHarness::new();
    let widths = harness.state.column_widths.lock().unwrap();

    // Column with no explicit width should not be in the map
    assert!(widths.get(&0).is_none());
}

#[test]
fn test_set_multiple_column_widths() {
    let harness = TestHarness::new();
    harness.set_column_width(0, 100.0);
    harness.set_column_width(1, 200.0);
    harness.set_column_width(2, 50.0);

    let widths = harness.state.column_widths.lock().unwrap();
    assert_eq!(widths.get(&0), Some(&100.0));
    assert_eq!(widths.get(&1), Some(&200.0));
    assert_eq!(widths.get(&2), Some(&50.0));
}

#[test]
fn test_update_column_width() {
    let harness = TestHarness::new();
    harness.set_column_width(0, 100.0);
    harness.set_column_width(0, 200.0); // Update

    let widths = harness.state.column_widths.lock().unwrap();
    assert_eq!(widths.get(&0), Some(&200.0));
}

#[test]
fn test_get_all_column_widths() {
    let harness = TestHarness::new();
    harness.set_column_width(0, 100.0);
    harness.set_column_width(5, 150.0);
    harness.set_column_width(10, 200.0);

    let widths = harness.state.column_widths.lock().unwrap();
    assert_eq!(widths.len(), 3);
}

#[test]
fn test_column_width_zero() {
    let harness = TestHarness::new();
    harness.set_column_width(0, 0.0); // Hidden column

    let widths = harness.state.column_widths.lock().unwrap();
    assert_eq!(widths.get(&0), Some(&0.0));
}

#[test]
fn test_column_width_very_large() {
    let harness = TestHarness::new();
    harness.set_column_width(0, 10000.0);

    let widths = harness.state.column_widths.lock().unwrap();
    assert_eq!(widths.get(&0), Some(&10000.0));
}

// ============================================================================
// ROW HEIGHT TESTS
// ============================================================================

#[test]
fn test_set_row_height() {
    let harness = TestHarness::new();
    harness.set_row_height(0, 30.0);

    let heights = harness.state.row_heights.lock().unwrap();
    assert_eq!(heights.get(&0), Some(&30.0));
}

#[test]
fn test_get_row_height_default() {
    let harness = TestHarness::new();
    let heights = harness.state.row_heights.lock().unwrap();

    // Row with no explicit height should not be in the map
    assert!(heights.get(&0).is_none());
}

#[test]
fn test_set_multiple_row_heights() {
    let harness = TestHarness::new();
    harness.set_row_height(0, 25.0);
    harness.set_row_height(1, 50.0);
    harness.set_row_height(2, 100.0);

    let heights = harness.state.row_heights.lock().unwrap();
    assert_eq!(heights.get(&0), Some(&25.0));
    assert_eq!(heights.get(&1), Some(&50.0));
    assert_eq!(heights.get(&2), Some(&100.0));
}

#[test]
fn test_update_row_height() {
    let harness = TestHarness::new();
    harness.set_row_height(0, 25.0);
    harness.set_row_height(0, 50.0); // Update

    let heights = harness.state.row_heights.lock().unwrap();
    assert_eq!(heights.get(&0), Some(&50.0));
}

#[test]
fn test_get_all_row_heights() {
    let harness = TestHarness::new();
    harness.set_row_height(0, 25.0);
    harness.set_row_height(10, 50.0);
    harness.set_row_height(100, 75.0);

    let heights = harness.state.row_heights.lock().unwrap();
    assert_eq!(heights.len(), 3);
}

#[test]
fn test_row_height_zero() {
    let harness = TestHarness::new();
    harness.set_row_height(0, 0.0); // Hidden row

    let heights = harness.state.row_heights.lock().unwrap();
    assert_eq!(heights.get(&0), Some(&0.0));
}

#[test]
fn test_row_height_fractional() {
    let harness = TestHarness::new();
    harness.set_row_height(0, 25.5);

    let heights = harness.state.row_heights.lock().unwrap();
    assert_eq!(heights.get(&0), Some(&25.5));
}

// ============================================================================
// MIXED DIMENSION TESTS
// ============================================================================

#[test]
fn test_dimensions_independence() {
    let harness = TestHarness::new();

    // Set both column and row dimensions
    harness.set_column_width(0, 100.0);
    harness.set_row_height(0, 50.0);

    // They should be stored independently
    let widths = harness.state.column_widths.lock().unwrap();
    let heights = harness.state.row_heights.lock().unwrap();

    assert_eq!(widths.get(&0), Some(&100.0));
    assert_eq!(heights.get(&0), Some(&50.0));
}

#[test]
fn test_many_dimensions() {
    let harness = TestHarness::new();

    // Set many column widths
    for col in 0..100 {
        harness.set_column_width(col, (col as f64) * 10.0 + 50.0);
    }

    // Set many row heights
    for row in 0..1000 {
        harness.set_row_height(row, (row as f64) * 0.1 + 20.0);
    }

    let widths = harness.state.column_widths.lock().unwrap();
    let heights = harness.state.row_heights.lock().unwrap();

    assert_eq!(widths.len(), 100);
    assert_eq!(heights.len(), 1000);

    // Check specific values
    assert_eq!(widths.get(&50), Some(&550.0)); // 50 * 10 + 50
    assert_eq!(heights.get(&500), Some(&70.0)); // 500 * 0.1 + 20
}
