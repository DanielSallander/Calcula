//! FILENAME: app/src-tauri/tests/test_grouping.rs
//! PURPOSE: Tests for row and column grouping (outline) functionality.

mod common;

use app_lib::{
    RowGroup, ColumnGroup, SheetOutline, OutlineSettings, SummaryPosition,
    OutlineStorage, MAX_OUTLINE_LEVEL,
};
use std::collections::HashMap;

// ============================================================================
// UNIT TESTS - RowGroup
// ============================================================================

#[test]
fn test_row_group_creation() {
    let group = RowGroup::new(5, 10, 1);

    assert_eq!(group.start_row, 5);
    assert_eq!(group.end_row, 10);
    assert_eq!(group.level, 1);
    assert!(!group.collapsed);
}

#[test]
fn test_row_group_normalizes_order() {
    let group = RowGroup::new(10, 5, 1);

    assert_eq!(group.start_row, 5);
    assert_eq!(group.end_row, 10);
}

#[test]
fn test_row_group_clamps_level() {
    let group = RowGroup::new(0, 10, 100);
    assert_eq!(group.level, MAX_OUTLINE_LEVEL);

    let group2 = RowGroup::new(0, 10, 0);
    assert_eq!(group2.level, 1);
}

#[test]
fn test_row_group_contains() {
    let group = RowGroup::new(5, 10, 1);

    assert!(!group.contains_row(4));
    assert!(group.contains_row(5));
    assert!(group.contains_row(7));
    assert!(group.contains_row(10));
    assert!(!group.contains_row(11));
}

#[test]
fn test_row_group_overlaps() {
    let group1 = RowGroup::new(5, 10, 1);

    let group2 = RowGroup::new(8, 15, 1); // Overlaps
    assert!(group1.overlaps(&group2));

    let group3 = RowGroup::new(0, 4, 1); // Before, no overlap
    assert!(!group1.overlaps(&group3));

    let group4 = RowGroup::new(11, 15, 1); // After, no overlap
    assert!(!group1.overlaps(&group4));

    let group5 = RowGroup::new(6, 8, 1); // Contained within
    assert!(group1.overlaps(&group5));
}

// ============================================================================
// UNIT TESTS - ColumnGroup
// ============================================================================

#[test]
fn test_column_group_creation() {
    let group = ColumnGroup::new(2, 5, 2);

    assert_eq!(group.start_col, 2);
    assert_eq!(group.end_col, 5);
    assert_eq!(group.level, 2);
    assert!(!group.collapsed);
}

#[test]
fn test_column_group_contains() {
    let group = ColumnGroup::new(2, 5, 1);

    assert!(!group.contains_col(1));
    assert!(group.contains_col(2));
    assert!(group.contains_col(3));
    assert!(group.contains_col(5));
    assert!(!group.contains_col(6));
}

// ============================================================================
// UNIT TESTS - SheetOutline
// ============================================================================

#[test]
fn test_sheet_outline_default() {
    let outline = SheetOutline::new();

    assert!(outline.row_groups.is_empty());
    assert!(outline.column_groups.is_empty());
    assert_eq!(outline.max_row_level, 0);
    assert_eq!(outline.max_col_level, 0);
}

#[test]
fn test_sheet_outline_row_level() {
    let mut outline = SheetOutline::new();
    outline.row_groups.push(RowGroup::new(0, 10, 1));
    outline.row_groups.push(RowGroup::new(2, 8, 2));
    outline.row_groups.push(RowGroup::new(4, 6, 3));

    // Nested levels
    assert_eq!(outline.get_row_level(0), 1);
    assert_eq!(outline.get_row_level(1), 1);
    assert_eq!(outline.get_row_level(2), 2);
    assert_eq!(outline.get_row_level(3), 2);
    assert_eq!(outline.get_row_level(4), 3);
    assert_eq!(outline.get_row_level(5), 3);
    assert_eq!(outline.get_row_level(6), 3);
    assert_eq!(outline.get_row_level(7), 2);
    assert_eq!(outline.get_row_level(8), 2);
    assert_eq!(outline.get_row_level(9), 1);
    assert_eq!(outline.get_row_level(10), 1);
    assert_eq!(outline.get_row_level(11), 0); // Outside all groups
}

#[test]
fn test_sheet_outline_hidden_rows() {
    let mut outline = SheetOutline::new();
    outline.row_groups.push(RowGroup {
        start_row: 1,
        end_row: 3,
        level: 1,
        collapsed: true,
    });
    outline.row_groups.push(RowGroup {
        start_row: 5,
        end_row: 7,
        level: 1,
        collapsed: false,
    });

    let hidden = outline.get_hidden_rows();

    assert!(hidden.contains(&1));
    assert!(hidden.contains(&2));
    assert!(hidden.contains(&3));
    assert!(!hidden.contains(&4));
    assert!(!hidden.contains(&5));
    assert!(!hidden.contains(&6));
    assert!(!hidden.contains(&7));
}

#[test]
fn test_sheet_outline_hidden_cols() {
    let mut outline = SheetOutline::new();
    outline.column_groups.push(ColumnGroup {
        start_col: 0,
        end_col: 2,
        level: 1,
        collapsed: true,
    });

    let hidden = outline.get_hidden_cols();

    assert!(hidden.contains(&0));
    assert!(hidden.contains(&1));
    assert!(hidden.contains(&2));
    assert!(!hidden.contains(&3));
}

#[test]
fn test_sheet_outline_col_level() {
    let mut outline = SheetOutline::new();
    outline.column_groups.push(ColumnGroup::new(0, 5, 1));
    outline.column_groups.push(ColumnGroup::new(2, 4, 2));

    assert_eq!(outline.get_col_level(0), 1);
    assert_eq!(outline.get_col_level(2), 2);
    assert_eq!(outline.get_col_level(3), 2);
    assert_eq!(outline.get_col_level(5), 1);
    assert_eq!(outline.get_col_level(6), 0);
}

// ============================================================================
// UNIT TESTS - OutlineSettings
// ============================================================================

#[test]
fn test_outline_settings_default() {
    let settings = OutlineSettings::default();

    assert_eq!(settings.summary_row_position, SummaryPosition::BelowRight);
    assert_eq!(settings.summary_col_position, SummaryPosition::BelowRight);
    assert!(settings.show_outline_symbols);
    assert!(!settings.auto_styles);
}

#[test]
fn test_summary_position_default() {
    assert_eq!(SummaryPosition::default(), SummaryPosition::BelowRight);
}

// ============================================================================
// UNIT TESTS - Storage
// ============================================================================

#[test]
fn test_outline_storage() {
    let mut storage: OutlineStorage = HashMap::new();

    // Add outline to sheet 0
    let mut outline0 = SheetOutline::new();
    outline0.row_groups.push(RowGroup::new(0, 10, 1));
    storage.insert(0, outline0);

    // Add outline to sheet 1
    let mut outline1 = SheetOutline::new();
    outline1.column_groups.push(ColumnGroup::new(0, 5, 2));
    storage.insert(1, outline1);

    assert!(storage.contains_key(&0));
    assert!(storage.contains_key(&1));
    assert!(!storage.contains_key(&2));

    assert_eq!(storage.get(&0).unwrap().row_groups.len(), 1);
    assert_eq!(storage.get(&1).unwrap().column_groups.len(), 1);
}

// ============================================================================
// INTEGRATION TESTS - Using TestHarness
// ============================================================================

#[test]
fn test_create_and_collapse_row_group() {
    let harness = common::TestHarness::new();

    // Create a row group
    {
        let mut outlines = harness.state.outlines.lock().unwrap();
        let outline = outlines.entry(0).or_insert_with(SheetOutline::new);
        outline.row_groups.push(RowGroup::new(5, 10, 1));
    }

    // Verify it exists
    {
        let outlines = harness.state.outlines.lock().unwrap();
        let outline = outlines.get(&0).unwrap();
        assert_eq!(outline.row_groups.len(), 1);
        assert!(!outline.row_groups[0].collapsed);
    }

    // Collapse it
    {
        let mut outlines = harness.state.outlines.lock().unwrap();
        let outline = outlines.get_mut(&0).unwrap();
        outline.row_groups[0].collapsed = true;
    }

    // Check hidden rows
    {
        let outlines = harness.state.outlines.lock().unwrap();
        let outline = outlines.get(&0).unwrap();
        let hidden = outline.get_hidden_rows();

        assert!(hidden.contains(&5));
        assert!(hidden.contains(&7));
        assert!(hidden.contains(&10));
        assert!(!hidden.contains(&4));
        assert!(!hidden.contains(&11));
    }
}

#[test]
fn test_nested_row_groups() {
    let harness = common::TestHarness::new();

    {
        let mut outlines = harness.state.outlines.lock().unwrap();
        let outline = outlines.entry(0).or_insert_with(SheetOutline::new);

        // Level 1: rows 0-20
        outline.row_groups.push(RowGroup::new(0, 20, 1));
        // Level 2: rows 5-15
        outline.row_groups.push(RowGroup::new(5, 15, 2));
        // Level 3: rows 8-12
        outline.row_groups.push(RowGroup::new(8, 12, 3));
    }

    {
        let outlines = harness.state.outlines.lock().unwrap();
        let outline = outlines.get(&0).unwrap();

        assert_eq!(outline.get_row_level(0), 1);
        assert_eq!(outline.get_row_level(5), 2);
        assert_eq!(outline.get_row_level(8), 3);
        assert_eq!(outline.get_row_level(10), 3);
        assert_eq!(outline.get_row_level(12), 3);
        assert_eq!(outline.get_row_level(15), 2);
        assert_eq!(outline.get_row_level(20), 1);
        assert_eq!(outline.get_row_level(21), 0);
    }
}

#[test]
fn test_show_outline_level() {
    let harness = common::TestHarness::new();

    // Create nested groups
    {
        let mut outlines = harness.state.outlines.lock().unwrap();
        let outline = outlines.entry(0).or_insert_with(SheetOutline::new);

        outline.row_groups.push(RowGroup::new(0, 20, 1));
        outline.row_groups.push(RowGroup::new(5, 15, 2));
        outline.row_groups.push(RowGroup::new(8, 12, 3));
    }

    // Show only level 1 (collapse levels 2 and 3)
    {
        let mut outlines = harness.state.outlines.lock().unwrap();
        let outline = outlines.get_mut(&0).unwrap();

        for group in &mut outline.row_groups {
            group.collapsed = group.level > 1;
        }
    }

    // Verify hidden rows
    {
        let outlines = harness.state.outlines.lock().unwrap();
        let outline = outlines.get(&0).unwrap();
        let hidden = outline.get_hidden_rows();

        // Level 2 and 3 should be hidden
        assert!(hidden.contains(&5));  // Level 2
        assert!(hidden.contains(&8));  // Level 3
        assert!(hidden.contains(&12)); // Level 3
        assert!(hidden.contains(&15)); // Level 2

        // Level 1 should be visible
        assert!(!hidden.contains(&0));
        assert!(!hidden.contains(&20));
    }
}

#[test]
fn test_grouping_across_sheets() {
    let harness = common::TestHarness::with_multiple_sheets(3);

    // Add groups to different sheets
    {
        let mut outlines = harness.state.outlines.lock().unwrap();

        // Sheet 0: row group
        let outline0 = outlines.entry(0).or_insert_with(SheetOutline::new);
        outline0.row_groups.push(RowGroup::new(0, 5, 1));

        // Sheet 1: column group
        let outline1 = outlines.entry(1).or_insert_with(SheetOutline::new);
        outline1.column_groups.push(ColumnGroup::new(0, 3, 1));

        // Sheet 2: both
        let outline2 = outlines.entry(2).or_insert_with(SheetOutline::new);
        outline2.row_groups.push(RowGroup::new(0, 2, 1));
        outline2.column_groups.push(ColumnGroup::new(0, 2, 1));
    }

    // Verify each sheet
    {
        let outlines = harness.state.outlines.lock().unwrap();

        assert_eq!(outlines.get(&0).unwrap().row_groups.len(), 1);
        assert_eq!(outlines.get(&0).unwrap().column_groups.len(), 0);

        assert_eq!(outlines.get(&1).unwrap().row_groups.len(), 0);
        assert_eq!(outlines.get(&1).unwrap().column_groups.len(), 1);

        assert_eq!(outlines.get(&2).unwrap().row_groups.len(), 1);
        assert_eq!(outlines.get(&2).unwrap().column_groups.len(), 1);
    }
}

#[test]
fn test_grouping_json_serialization() {
    let settings = OutlineSettings::default();
    let json = serde_json::to_string(&settings).unwrap();

    // Should use camelCase
    assert!(json.contains("\"summaryRowPosition\""));
    assert!(json.contains("\"showOutlineSymbols\""));
    assert!(!json.contains("\"summary_row_position\""));
    assert!(!json.contains("\"show_outline_symbols\""));
}

#[test]
fn test_summary_position_serialization() {
    let below = SummaryPosition::BelowRight;
    let above = SummaryPosition::AboveLeft;

    assert_eq!(serde_json::to_string(&below).unwrap(), "\"belowRight\"");
    assert_eq!(serde_json::to_string(&above).unwrap(), "\"aboveLeft\"");
}
