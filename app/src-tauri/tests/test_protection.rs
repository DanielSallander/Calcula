//! FILENAME: app/src-tauri/tests/test_protection.rs
//! PURPOSE: Tests for sheet and cell protection functionality.

mod common;

use app_lib::{
    SheetProtection, SheetProtectionOptions, AllowEditRange, CellProtection,
    ProtectionStorage, CellProtectionStorage,
};
use std::collections::HashMap;

// ============================================================================
// UNIT TESTS - SheetProtectionOptions
// ============================================================================

#[test]
fn test_default_protection_options() {
    let options = SheetProtectionOptions::default();

    // Selection should be allowed by default
    assert!(options.allow_select_locked_cells);
    assert!(options.allow_select_unlocked_cells);

    // Modifications should be blocked by default
    assert!(!options.allow_format_cells);
    assert!(!options.allow_format_columns);
    assert!(!options.allow_format_rows);
    assert!(!options.allow_insert_columns);
    assert!(!options.allow_insert_rows);
    assert!(!options.allow_insert_hyperlinks);
    assert!(!options.allow_delete_columns);
    assert!(!options.allow_delete_rows);
    assert!(!options.allow_sort);
    assert!(!options.allow_auto_filter);
    assert!(!options.allow_pivot_tables);
    assert!(!options.allow_edit_objects);
    assert!(!options.allow_edit_scenarios);
}

// ============================================================================
// UNIT TESTS - SheetProtection
// ============================================================================

#[test]
fn test_sheet_protection_default() {
    let protection = SheetProtection::default();

    assert!(!protection.protected);
    assert!(protection.password_hash.is_none());
    assert!(protection.password_salt.is_none());
    assert!(protection.allow_edit_ranges.is_empty());
}

#[test]
fn test_can_edit_unprotected_sheet() {
    let protection = SheetProtection::default();

    // Unprotected sheet - all cells editable regardless of lock status
    assert!(protection.can_edit_cell(0, 0, true));  // Locked cell
    assert!(protection.can_edit_cell(0, 0, false)); // Unlocked cell
    assert!(protection.can_edit_cell(100, 100, true));
}

#[test]
fn test_can_edit_protected_sheet_locked_cells() {
    let mut protection = SheetProtection::default();
    protection.protected = true;

    // Protected sheet - locked cells cannot be edited
    assert!(!protection.can_edit_cell(0, 0, true));
    assert!(!protection.can_edit_cell(5, 5, true));

    // Unlocked cells can still be edited
    assert!(protection.can_edit_cell(0, 0, false));
    assert!(protection.can_edit_cell(5, 5, false));
}

#[test]
fn test_can_edit_with_allow_edit_range() {
    let mut protection = SheetProtection::default();
    protection.protected = true;
    protection.allow_edit_ranges.push(AllowEditRange {
        title: "EditableArea".to_string(),
        start_row: 5,
        start_col: 5,
        end_row: 10,
        end_col: 10,
        password_hash: None,
        password_salt: None,
    });

    // Outside the allow-edit range
    assert!(!protection.can_edit_cell(0, 0, true));
    assert!(!protection.can_edit_cell(4, 5, true));
    assert!(!protection.can_edit_cell(5, 4, true));
    assert!(!protection.can_edit_cell(11, 10, true));
    assert!(!protection.can_edit_cell(10, 11, true));

    // Inside the allow-edit range - always editable even if locked
    assert!(protection.can_edit_cell(5, 5, true));
    assert!(protection.can_edit_cell(7, 7, true));
    assert!(protection.can_edit_cell(10, 10, true));
    assert!(protection.can_edit_cell(5, 10, true));
    assert!(protection.can_edit_cell(10, 5, true));
}

#[test]
fn test_multiple_allow_edit_ranges() {
    let mut protection = SheetProtection::default();
    protection.protected = true;

    // Add two non-overlapping ranges
    protection.allow_edit_ranges.push(AllowEditRange {
        title: "Range1".to_string(),
        start_row: 0,
        start_col: 0,
        end_row: 5,
        end_col: 5,
        password_hash: None,
        password_salt: None,
    });
    protection.allow_edit_ranges.push(AllowEditRange {
        title: "Range2".to_string(),
        start_row: 10,
        start_col: 10,
        end_row: 15,
        end_col: 15,
        password_hash: None,
        password_salt: None,
    });

    // First range
    assert!(protection.can_edit_cell(0, 0, true));
    assert!(protection.can_edit_cell(5, 5, true));

    // Second range
    assert!(protection.can_edit_cell(10, 10, true));
    assert!(protection.can_edit_cell(15, 15, true));

    // Between ranges
    assert!(!protection.can_edit_cell(7, 7, true));
}

#[test]
fn test_is_action_allowed_unprotected() {
    let protection = SheetProtection::default();

    // All actions allowed when not protected
    assert!(protection.is_action_allowed("formatCells"));
    assert!(protection.is_action_allowed("insertRows"));
    assert!(protection.is_action_allowed("deleteColumns"));
    assert!(protection.is_action_allowed("sort"));
}

#[test]
fn test_is_action_allowed_protected_defaults() {
    let mut protection = SheetProtection::default();
    protection.protected = true;

    // Selection allowed by default
    assert!(protection.is_action_allowed("selectLockedCells"));
    assert!(protection.is_action_allowed("selectUnlockedCells"));

    // Modifications blocked by default
    assert!(!protection.is_action_allowed("formatCells"));
    assert!(!protection.is_action_allowed("formatColumns"));
    assert!(!protection.is_action_allowed("formatRows"));
    assert!(!protection.is_action_allowed("insertColumns"));
    assert!(!protection.is_action_allowed("insertRows"));
    assert!(!protection.is_action_allowed("insertHyperlinks"));
    assert!(!protection.is_action_allowed("deleteColumns"));
    assert!(!protection.is_action_allowed("deleteRows"));
    assert!(!protection.is_action_allowed("sort"));
    assert!(!protection.is_action_allowed("autoFilter"));
    assert!(!protection.is_action_allowed("pivotTables"));
    assert!(!protection.is_action_allowed("editObjects"));
    assert!(!protection.is_action_allowed("editScenarios"));
}

#[test]
fn test_is_action_allowed_custom_options() {
    let mut protection = SheetProtection::default();
    protection.protected = true;
    protection.options.allow_format_cells = true;
    protection.options.allow_sort = true;
    protection.options.allow_auto_filter = true;

    // Enabled actions
    assert!(protection.is_action_allowed("formatCells"));
    assert!(protection.is_action_allowed("sort"));
    assert!(protection.is_action_allowed("autoFilter"));

    // Still disabled
    assert!(!protection.is_action_allowed("insertRows"));
    assert!(!protection.is_action_allowed("deleteColumns"));
}

#[test]
fn test_is_action_allowed_unknown_action() {
    let mut protection = SheetProtection::default();
    protection.protected = true;

    // Unknown actions are blocked
    assert!(!protection.is_action_allowed("unknownAction"));
    assert!(!protection.is_action_allowed(""));
}

// ============================================================================
// UNIT TESTS - AllowEditRange
// ============================================================================

#[test]
fn test_allow_edit_range_contains() {
    let range = AllowEditRange {
        title: "Test".to_string(),
        start_row: 5,
        start_col: 5,
        end_row: 10,
        end_col: 10,
        password_hash: None,
        password_salt: None,
    };

    // Inside
    assert!(range.contains(5, 5));
    assert!(range.contains(7, 7));
    assert!(range.contains(10, 10));
    assert!(range.contains(5, 10));
    assert!(range.contains(10, 5));

    // Outside
    assert!(!range.contains(4, 5));
    assert!(!range.contains(5, 4));
    assert!(!range.contains(11, 10));
    assert!(!range.contains(10, 11));
    assert!(!range.contains(0, 0));
}

// ============================================================================
// UNIT TESTS - CellProtection
// ============================================================================

#[test]
fn test_cell_protection_default_locked() {
    let cp = CellProtection::default_locked();

    assert!(cp.locked);
    assert!(!cp.formula_hidden);
}

#[test]
fn test_cell_protection_unlocked() {
    let cp = CellProtection::unlocked();

    assert!(!cp.locked);
    assert!(!cp.formula_hidden);
}

#[test]
fn test_cell_protection_default() {
    let cp = CellProtection::default();

    // Default should be unlocked with formula visible
    assert!(!cp.locked);
    assert!(!cp.formula_hidden);
}

// ============================================================================
// UNIT TESTS - Storage
// ============================================================================

#[test]
fn test_protection_storage() {
    let mut storage: ProtectionStorage = HashMap::new();

    // Add protection to sheet 0
    let mut protection = SheetProtection::default();
    protection.protected = true;
    storage.insert(0, protection);

    // Add protection to sheet 1
    let mut protection2 = SheetProtection::default();
    protection2.protected = false;
    storage.insert(1, protection2);

    assert!(storage.get(&0).unwrap().protected);
    assert!(!storage.get(&1).unwrap().protected);
    assert!(storage.get(&2).is_none());
}

#[test]
fn test_cell_protection_storage() {
    let mut storage: CellProtectionStorage = HashMap::new();

    // Add cell protection to sheet 0
    let sheet0 = storage.entry(0).or_insert_with(HashMap::new);
    sheet0.insert((0, 0), CellProtection::unlocked());
    sheet0.insert((0, 1), CellProtection { locked: true, formula_hidden: true });

    // Verify
    let sheet0 = storage.get(&0).unwrap();
    assert!(!sheet0.get(&(0, 0)).unwrap().locked);
    assert!(sheet0.get(&(0, 1)).unwrap().locked);
    assert!(sheet0.get(&(0, 1)).unwrap().formula_hidden);
    assert!(sheet0.get(&(0, 2)).is_none()); // Not set = use default
}

// ============================================================================
// INTEGRATION TESTS - Using TestHarness
// ============================================================================

#[test]
fn test_protect_and_check_cell() {
    let harness = common::TestHarness::new();

    // Set protection
    {
        let mut protection_storage = harness.state.sheet_protection.lock().unwrap();
        let mut protection = SheetProtection::default();
        protection.protected = true;
        protection_storage.insert(0, protection);
    }

    // Set a cell as unlocked
    {
        let mut cell_protection = harness.state.cell_protection.lock().unwrap();
        let sheet = cell_protection.entry(0).or_insert_with(HashMap::new);
        sheet.insert((5, 5), CellProtection::unlocked());
    }

    // Check cells
    {
        let protection_storage = harness.state.sheet_protection.lock().unwrap();
        let cell_protection = harness.state.cell_protection.lock().unwrap();
        let protection = protection_storage.get(&0).unwrap();

        // Default locked cell
        let is_locked_00 = cell_protection
            .get(&0)
            .and_then(|s| s.get(&(0, 0)))
            .map(|cp| cp.locked)
            .unwrap_or(true);
        assert!(!protection.can_edit_cell(0, 0, is_locked_00));

        // Explicitly unlocked cell
        let is_locked_55 = cell_protection
            .get(&0)
            .and_then(|s| s.get(&(5, 5)))
            .map(|cp| cp.locked)
            .unwrap_or(true);
        assert!(protection.can_edit_cell(5, 5, is_locked_55));
    }
}

#[test]
fn test_allow_edit_range_with_protection() {
    let harness = common::TestHarness::new();

    // Set protection with allow-edit range
    {
        let mut protection_storage = harness.state.sheet_protection.lock().unwrap();
        let mut protection = SheetProtection::default();
        protection.protected = true;
        protection.allow_edit_ranges.push(AllowEditRange {
            title: "InputArea".to_string(),
            start_row: 10,
            start_col: 0,
            end_row: 20,
            end_col: 5,
            password_hash: None,
            password_salt: None,
        });
        protection_storage.insert(0, protection);
    }

    // Check cells
    {
        let protection_storage = harness.state.sheet_protection.lock().unwrap();
        let protection = protection_storage.get(&0).unwrap();

        // Outside allow-edit range - blocked (assuming locked)
        assert!(!protection.can_edit_cell(0, 0, true));
        assert!(!protection.can_edit_cell(9, 0, true));
        assert!(!protection.can_edit_cell(21, 0, true));

        // Inside allow-edit range - always allowed
        assert!(protection.can_edit_cell(10, 0, true));
        assert!(protection.can_edit_cell(15, 3, true));
        assert!(protection.can_edit_cell(20, 5, true));
    }
}

#[test]
fn test_protection_across_sheets() {
    let harness = common::TestHarness::with_multiple_sheets(3);

    // Set different protection on each sheet
    {
        let mut protection_storage = harness.state.sheet_protection.lock().unwrap();

        // Sheet 0: protected
        let mut p0 = SheetProtection::default();
        p0.protected = true;
        protection_storage.insert(0, p0);

        // Sheet 1: not protected
        let p1 = SheetProtection::default();
        protection_storage.insert(1, p1);

        // Sheet 2: protected with custom options
        let mut p2 = SheetProtection::default();
        p2.protected = true;
        p2.options.allow_format_cells = true;
        protection_storage.insert(2, p2);
    }

    // Verify each sheet
    {
        let protection_storage = harness.state.sheet_protection.lock().unwrap();

        let p0 = protection_storage.get(&0).unwrap();
        assert!(p0.protected);
        assert!(!p0.is_action_allowed("formatCells"));

        let p1 = protection_storage.get(&1).unwrap();
        assert!(!p1.protected);
        assert!(p1.is_action_allowed("formatCells")); // Not protected

        let p2 = protection_storage.get(&2).unwrap();
        assert!(p2.protected);
        assert!(p2.is_action_allowed("formatCells")); // Explicitly allowed
    }
}

#[test]
fn test_protection_json_serialization() {
    let options = SheetProtectionOptions::default();
    let json = serde_json::to_string(&options).unwrap();

    // Should use camelCase
    assert!(json.contains("\"allowSelectLockedCells\""));
    assert!(json.contains("\"allowFormatCells\""));
    assert!(!json.contains("\"allow_select_locked_cells\""));
    assert!(!json.contains("\"allow_format_cells\""));
}

#[test]
fn test_cell_protection_json_serialization() {
    let cp = CellProtection {
        locked: true,
        formula_hidden: true,
    };
    let json = serde_json::to_string(&cp).unwrap();

    // Should use camelCase
    assert!(json.contains("\"locked\""));
    assert!(json.contains("\"formulaHidden\""));
    assert!(!json.contains("\"formula_hidden\""));
}
