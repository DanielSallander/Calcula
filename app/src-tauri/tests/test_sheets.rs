//! FILENAME: tests/test_sheets.rs
//! Integration tests for sheet commands (add, delete, rename, freeze panes).

mod common;

use app_lib::FreezeConfig;
use common::TestHarness;
use engine::{Cell, Grid};

// ============================================================================
// SHEET CREATION TESTS
// ============================================================================

#[test]
fn test_default_sheet() {
    let harness = TestHarness::new();
    assert_eq!(harness.get_sheet_count(), 1);
    assert_eq!(harness.get_sheet_name(0), Some("Sheet1".to_string()));
}

#[test]
fn test_multiple_sheets_creation() {
    let harness = TestHarness::with_multiple_sheets(3);
    assert_eq!(harness.get_sheet_count(), 3);
    assert_eq!(harness.get_sheet_name(0), Some("Sheet1".to_string()));
    assert_eq!(harness.get_sheet_name(1), Some("Sheet2".to_string()));
    assert_eq!(harness.get_sheet_name(2), Some("Sheet3".to_string()));
}

#[test]
fn test_add_sheet() {
    let harness = TestHarness::new();

    {
        let mut names = harness.state.sheet_names.lock().unwrap();
        let mut grids = harness.state.grids.lock().unwrap();
        let mut freeze_configs = harness.state.freeze_configs.lock().unwrap();

        names.push("NewSheet".to_string());
        grids.push(Grid::new());
        freeze_configs.push(FreezeConfig::default());
    }

    assert_eq!(harness.get_sheet_count(), 2);
    assert_eq!(harness.get_sheet_name(1), Some("NewSheet".to_string()));
}

#[test]
fn test_delete_sheet() {
    let harness = TestHarness::with_multiple_sheets(3);

    {
        let mut names = harness.state.sheet_names.lock().unwrap();
        let mut grids = harness.state.grids.lock().unwrap();
        let mut freeze_configs = harness.state.freeze_configs.lock().unwrap();

        // Delete Sheet2 (index 1)
        names.remove(1);
        grids.remove(1);
        freeze_configs.remove(1);
    }

    assert_eq!(harness.get_sheet_count(), 2);
    assert_eq!(harness.get_sheet_name(0), Some("Sheet1".to_string()));
    assert_eq!(harness.get_sheet_name(1), Some("Sheet3".to_string()));
}

#[test]
fn test_rename_sheet() {
    let harness = TestHarness::new();

    {
        let mut names = harness.state.sheet_names.lock().unwrap();
        names[0] = "MyData".to_string();
    }

    assert_eq!(harness.get_sheet_name(0), Some("MyData".to_string()));
}

// ============================================================================
// ACTIVE SHEET TESTS
// ============================================================================

#[test]
fn test_default_active_sheet() {
    let harness = TestHarness::new();
    assert_eq!(harness.get_active_sheet(), 0);
}

#[test]
fn test_set_active_sheet() {
    let harness = TestHarness::with_multiple_sheets(3);
    harness.set_active_sheet(2);
    assert_eq!(harness.get_active_sheet(), 2);
}

#[test]
fn test_active_sheet_out_of_bounds() {
    let harness = TestHarness::with_multiple_sheets(3);
    harness.set_active_sheet(10); // Out of bounds

    // Should not change (stays at 0)
    assert_eq!(harness.get_active_sheet(), 0);
}

#[test]
fn test_active_sheet_data_isolation() {
    let harness = TestHarness::with_multiple_sheets(2);

    // Set data on Sheet1
    harness.set_cell(0, 0, Cell::new_text("Sheet1 Data".to_string()));

    // Switch to Sheet2
    harness.set_active_sheet(1);

    // Set data on Sheet2
    harness.set_cell(0, 0, Cell::new_text("Sheet2 Data".to_string()));

    // Verify Sheet2 data
    let display = harness.get_cell_display(0, 0);
    assert_eq!(display, Some("Sheet2 Data".to_string()));

    // Switch back to Sheet1 and verify data
    harness.set_active_sheet(0);
    let display = harness.get_cell_display(0, 0);
    assert_eq!(display, Some("Sheet1 Data".to_string()));
}

// ============================================================================
// FREEZE PANE TESTS
// ============================================================================

#[test]
fn test_default_freeze_config() {
    let harness = TestHarness::new();
    let configs = harness.state.freeze_configs.lock().unwrap();

    assert_eq!(configs.len(), 1);
    let config = &configs[0];
    assert_eq!(config.freeze_row, None);
    assert_eq!(config.freeze_col, None);
}

#[test]
fn test_set_freeze_rows() {
    let harness = TestHarness::new();

    {
        let mut configs = harness.state.freeze_configs.lock().unwrap();
        configs[0].freeze_row = Some(2);
    }

    let configs = harness.state.freeze_configs.lock().unwrap();
    assert_eq!(configs[0].freeze_row, Some(2));
    assert_eq!(configs[0].freeze_col, None);
}

#[test]
fn test_set_freeze_cols() {
    let harness = TestHarness::new();

    {
        let mut configs = harness.state.freeze_configs.lock().unwrap();
        configs[0].freeze_col = Some(3);
    }

    let configs = harness.state.freeze_configs.lock().unwrap();
    assert_eq!(configs[0].freeze_row, None);
    assert_eq!(configs[0].freeze_col, Some(3));
}

#[test]
fn test_set_freeze_both() {
    let harness = TestHarness::new();

    {
        let mut configs = harness.state.freeze_configs.lock().unwrap();
        configs[0].freeze_row = Some(1);
        configs[0].freeze_col = Some(2);
    }

    let configs = harness.state.freeze_configs.lock().unwrap();
    assert_eq!(configs[0].freeze_row, Some(1));
    assert_eq!(configs[0].freeze_col, Some(2));
}

#[test]
fn test_freeze_per_sheet() {
    let harness = TestHarness::with_multiple_sheets(2);

    {
        let mut configs = harness.state.freeze_configs.lock().unwrap();
        configs[0].freeze_row = Some(1); // Sheet1
        configs[1].freeze_col = Some(2); // Sheet2
    }

    let configs = harness.state.freeze_configs.lock().unwrap();
    assert_eq!(configs[0].freeze_row, Some(1));
    assert_eq!(configs[0].freeze_col, None);
    assert_eq!(configs[1].freeze_row, None);
    assert_eq!(configs[1].freeze_col, Some(2));
}

#[test]
fn test_unfreeze() {
    let harness = TestHarness::new();

    // Set freeze
    {
        let mut configs = harness.state.freeze_configs.lock().unwrap();
        configs[0].freeze_row = Some(5);
        configs[0].freeze_col = Some(3);
    }

    // Unfreeze
    {
        let mut configs = harness.state.freeze_configs.lock().unwrap();
        configs[0].freeze_row = None;
        configs[0].freeze_col = None;
    }

    let configs = harness.state.freeze_configs.lock().unwrap();
    assert_eq!(configs[0].freeze_row, None);
    assert_eq!(configs[0].freeze_col, None);
}

// ============================================================================
// SHEET DATA TESTS
// ============================================================================

#[test]
fn test_each_sheet_has_own_grid() {
    let harness = TestHarness::with_multiple_sheets(3);
    let grids = harness.state.grids.lock().unwrap();

    assert_eq!(grids.len(), 3);

    // Each grid should be independent
    for grid in grids.iter() {
        assert_eq!(grid.cells.len(), 0); // All start empty
    }
}

#[test]
fn test_sheet_grid_independence() {
    let harness = TestHarness::with_multiple_sheets(2);

    // Add data to Sheet1
    {
        let mut grids = harness.state.grids.lock().unwrap();
        grids[0].set_cell(0, 0, Cell::new_number(100.0));
    }

    // Add different data to Sheet2
    {
        let mut grids = harness.state.grids.lock().unwrap();
        grids[1].set_cell(0, 0, Cell::new_number(200.0));
    }

    // Verify data independence
    let grids = harness.state.grids.lock().unwrap();

    if let Some(cell) = grids[0].get_cell(0, 0) {
        if let engine::CellValue::Number(n) = cell.value {
            assert!((n - 100.0).abs() < 0.001);
        } else {
            panic!("Expected number in Sheet1");
        }
    }

    if let Some(cell) = grids[1].get_cell(0, 0) {
        if let engine::CellValue::Number(n) = cell.value {
            assert!((n - 200.0).abs() < 0.001);
        } else {
            panic!("Expected number in Sheet2");
        }
    }
}

// ============================================================================
// SHEET NAME EDGE CASES
// ============================================================================

#[test]
fn test_sheet_name_with_spaces() {
    let harness = TestHarness::new();

    {
        let mut names = harness.state.sheet_names.lock().unwrap();
        names[0] = "My Data Sheet".to_string();
    }

    assert_eq!(harness.get_sheet_name(0), Some("My Data Sheet".to_string()));
}

#[test]
fn test_sheet_name_with_special_chars() {
    let harness = TestHarness::new();

    {
        let mut names = harness.state.sheet_names.lock().unwrap();
        names[0] = "Q1-2024 (Sales)".to_string();
    }

    assert_eq!(harness.get_sheet_name(0), Some("Q1-2024 (Sales)".to_string()));
}

#[test]
fn test_sheet_name_unicode() {
    let harness = TestHarness::new();

    {
        let mut names = harness.state.sheet_names.lock().unwrap();
        names[0] = "データ".to_string(); // Japanese for "data"
    }

    assert_eq!(harness.get_sheet_name(0), Some("データ".to_string()));
}

#[test]
fn test_many_sheets() {
    let harness = TestHarness::new();

    {
        let mut names = harness.state.sheet_names.lock().unwrap();
        let mut grids = harness.state.grids.lock().unwrap();
        let mut freeze_configs = harness.state.freeze_configs.lock().unwrap();

        for i in 1..50 {
            names.push(format!("Sheet{}", i + 1));
            grids.push(Grid::new());
            freeze_configs.push(FreezeConfig::default());
        }
    }

    assert_eq!(harness.get_sheet_count(), 50);
    assert_eq!(harness.get_sheet_name(49), Some("Sheet50".to_string()));
}
