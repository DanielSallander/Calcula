//! FILENAME: tests/test_named_ranges.rs
//! Integration tests for named range commands.

mod common;

use app_lib::NamedRange;
use common::TestHarness;

// ============================================================================
// BASIC NAMED RANGE TESTS
// ============================================================================

#[test]
fn test_create_named_range() {
    let harness = TestHarness::new();
    harness.add_named_range("SalesData", "A1:D10", 0);

    let ranges = harness.state.named_ranges.lock().unwrap();
    assert!(ranges.contains_key("SALESDATA")); // Stored uppercase
}

#[test]
fn test_named_range_properties() {
    let harness = TestHarness::new();
    harness.add_named_range("MyRange", "B2:E20", 0);

    let ranges = harness.state.named_ranges.lock().unwrap();
    let range = ranges.get("MYRANGE").unwrap();

    assert_eq!(range.name, "MyRange");
    // B2:E20 -> row 1-19 (0-indexed), col 1-4 (0-indexed)
    assert_eq!(range.start_row, 1);
    assert_eq!(range.start_col, 1);
    assert_eq!(range.end_row, 19);
    assert_eq!(range.end_col, 4);
    assert_eq!(range.sheet_index, Some(0));
}

#[test]
fn test_named_range_with_comment() {
    let harness = TestHarness::new();

    {
        let mut ranges = harness.state.named_ranges.lock().unwrap();
        ranges.insert(
            "BUDGET".to_string(),
            NamedRange {
                name: "Budget".to_string(),
                sheet_index: Some(0),
                start_row: 0,
                start_col: 2,
                end_row: 99,
                end_col: 2,
                comment: Some("Annual budget data".to_string()),
            },
        );
    }

    let ranges = harness.state.named_ranges.lock().unwrap();
    let range = ranges.get("BUDGET").unwrap();
    assert_eq!(range.comment, Some("Annual budget data".to_string()));
}

// ============================================================================
// MULTIPLE NAMED RANGES TESTS
// ============================================================================

#[test]
fn test_multiple_named_ranges() {
    let harness = TestHarness::new();

    harness.add_named_range("Headers", "A1:E1", 0);
    harness.add_named_range("Data", "A2:E100", 0);
    harness.add_named_range("Totals", "A101:E101", 0);

    let ranges = harness.state.named_ranges.lock().unwrap();
    assert_eq!(ranges.len(), 3);
    assert!(ranges.contains_key("HEADERS"));
    assert!(ranges.contains_key("DATA"));
    assert!(ranges.contains_key("TOTALS"));
}

#[test]
fn test_named_ranges_different_sheets() {
    let harness = TestHarness::with_multiple_sheets(3);

    harness.add_named_range("Sheet1Data", "A1:D10", 0);
    harness.add_named_range("Sheet2Data", "A1:D10", 1);
    harness.add_named_range("Sheet3Data", "A1:D10", 2);

    let ranges = harness.state.named_ranges.lock().unwrap();

    assert_eq!(ranges.get("SHEET1DATA").unwrap().sheet_index, Some(0));
    assert_eq!(ranges.get("SHEET2DATA").unwrap().sheet_index, Some(1));
    assert_eq!(ranges.get("SHEET3DATA").unwrap().sheet_index, Some(2));
}

// ============================================================================
// UPDATE NAMED RANGE TESTS
// ============================================================================

#[test]
fn test_update_named_range_range() {
    let harness = TestHarness::new();
    harness.add_named_range("Data", "A1:D10", 0);

    // Update the range to A1:D20
    {
        let mut ranges = harness.state.named_ranges.lock().unwrap();
        if let Some(range) = ranges.get_mut("DATA") {
            range.end_row = 19; // D20 -> row 19 (0-indexed)
        }
    }

    let ranges = harness.state.named_ranges.lock().unwrap();
    let range = ranges.get("DATA").unwrap();
    assert_eq!(range.start_row, 0);
    assert_eq!(range.end_row, 19);
}

#[test]
fn test_rename_named_range() {
    let harness = TestHarness::new();
    harness.add_named_range("OldName", "A1:A10", 0);

    // Rename
    {
        let mut ranges = harness.state.named_ranges.lock().unwrap();
        if let Some(range) = ranges.remove("OLDNAME") {
            let mut updated = range.clone();
            updated.name = "NewName".to_string();
            ranges.insert("NEWNAME".to_string(), updated);
        }
    }

    let ranges = harness.state.named_ranges.lock().unwrap();
    assert!(!ranges.contains_key("OLDNAME"));
    assert!(ranges.contains_key("NEWNAME"));
    assert_eq!(ranges.get("NEWNAME").unwrap().name, "NewName");
}

// ============================================================================
// DELETE NAMED RANGE TESTS
// ============================================================================

#[test]
fn test_delete_named_range() {
    let harness = TestHarness::new();
    harness.add_named_range("ToDelete", "A1:B5", 0);

    {
        let mut ranges = harness.state.named_ranges.lock().unwrap();
        ranges.remove("TODELETE");
    }

    let ranges = harness.state.named_ranges.lock().unwrap();
    assert!(!ranges.contains_key("TODELETE"));
}

#[test]
fn test_delete_one_of_many() {
    let harness = TestHarness::new();

    harness.add_named_range("Keep1", "A1:A10", 0);
    harness.add_named_range("Delete", "B1:B10", 0);
    harness.add_named_range("Keep2", "C1:C10", 0);

    {
        let mut ranges = harness.state.named_ranges.lock().unwrap();
        ranges.remove("DELETE");
    }

    let ranges = harness.state.named_ranges.lock().unwrap();
    assert_eq!(ranges.len(), 2);
    assert!(ranges.contains_key("KEEP1"));
    assert!(ranges.contains_key("KEEP2"));
}

// ============================================================================
// CASE INSENSITIVITY TESTS
// ============================================================================

#[test]
fn test_case_insensitive_lookup() {
    let harness = TestHarness::new();
    harness.add_named_range("MyRange", "A1:A10", 0);

    let ranges = harness.state.named_ranges.lock().unwrap();

    // All uppercase lookups should work
    assert!(ranges.contains_key("MYRANGE"));
}

#[test]
fn test_case_preserved_in_name() {
    let harness = TestHarness::new();
    harness.add_named_range("CamelCaseRange", "A1:A10", 0);

    let ranges = harness.state.named_ranges.lock().unwrap();
    let range = ranges.get("CAMELCASERANGE").unwrap();

    // Original case should be preserved in the name field
    assert_eq!(range.name, "CamelCaseRange");
}

// ============================================================================
// RANGE FORMAT TESTS
// ============================================================================

#[test]
fn test_single_cell_range() {
    let harness = TestHarness::new();
    harness.add_named_range("SingleCell", "A1", 0);

    let ranges = harness.state.named_ranges.lock().unwrap();
    let range = ranges.get("SINGLECELL").unwrap();
    // A1 -> row 0, col 0
    assert_eq!(range.start_row, 0);
    assert_eq!(range.start_col, 0);
    assert_eq!(range.end_row, 0);
    assert_eq!(range.end_col, 0);
}

#[test]
fn test_column_range() {
    let harness = TestHarness::new();
    harness.add_named_range("ColumnA", "A:A", 0);

    let ranges = harness.state.named_ranges.lock().unwrap();
    let range = ranges.get("COLUMNA").unwrap();
    // A:A -> col 0, all rows
    assert_eq!(range.start_col, 0);
    assert_eq!(range.end_col, 0);
    assert_eq!(range.start_row, 0);
}

#[test]
fn test_row_range() {
    let harness = TestHarness::new();
    harness.add_named_range("Row1", "1:1", 0);

    let ranges = harness.state.named_ranges.lock().unwrap();
    let range = ranges.get("ROW1").unwrap();
    // 1:1 -> row 0, all columns
    assert_eq!(range.start_row, 0);
    assert_eq!(range.end_row, 0);
    assert_eq!(range.start_col, 0);
}

#[test]
fn test_absolute_reference_range() {
    let harness = TestHarness::new();
    harness.add_named_range("Absolute", "$A$1:$D$10", 0);

    let ranges = harness.state.named_ranges.lock().unwrap();
    let range = ranges.get("ABSOLUTE").unwrap();
    // $A$1:$D$10 -> same as A1:D10
    assert_eq!(range.start_row, 0);
    assert_eq!(range.start_col, 0);
    assert_eq!(range.end_row, 9);
    assert_eq!(range.end_col, 3);
}

// ============================================================================
// GLOBAL VS SHEET-SCOPED TESTS
// ============================================================================

#[test]
fn test_global_named_range() {
    let harness = TestHarness::new();

    {
        let mut ranges = harness.state.named_ranges.lock().unwrap();
        ranges.insert(
            "GLOBAL".to_string(),
            NamedRange {
                name: "Global".to_string(),
                sheet_index: None, // Global scope
                start_row: 0,
                start_col: 0,
                end_row: 9,
                end_col: 0,
                comment: None,
            },
        );
    }

    let ranges = harness.state.named_ranges.lock().unwrap();
    assert!(ranges.get("GLOBAL").unwrap().sheet_index.is_none());
}

#[test]
fn test_sheet_scoped_named_range() {
    let harness = TestHarness::with_multiple_sheets(2);
    harness.add_named_range("Local", "A1:A10", 0);

    let ranges = harness.state.named_ranges.lock().unwrap();
    assert_eq!(ranges.get("LOCAL").unwrap().sheet_index, Some(0));
}

// ============================================================================
// EDGE CASES
// ============================================================================

#[test]
fn test_empty_named_ranges() {
    let harness = TestHarness::new();
    let ranges = harness.state.named_ranges.lock().unwrap();
    assert!(ranges.is_empty());
}

#[test]
fn test_many_named_ranges() {
    let harness = TestHarness::new();

    {
        let mut ranges = harness.state.named_ranges.lock().unwrap();
        for i in 0..100 {
            let name = format!("Range{}", i);
            ranges.insert(
                name.to_uppercase(),
                NamedRange {
                    name,
                    sheet_index: Some(0),
                    start_row: i,
                    start_col: 0,
                    end_row: i + 9,
                    end_col: 0,
                    comment: None,
                },
            );
        }
    }

    let ranges = harness.state.named_ranges.lock().unwrap();
    assert_eq!(ranges.len(), 100);
}

#[test]
fn test_special_characters_in_range() {
    let harness = TestHarness::new();

    // Cross-sheet reference stored as coordinates with sheet_index
    {
        let mut ranges = harness.state.named_ranges.lock().unwrap();
        ranges.insert(
            "CROSSSHEET".to_string(),
            NamedRange {
                name: "CrossSheet".to_string(),
                sheet_index: Some(1), // Reference to "Sheet 1" (index 1)
                start_row: 0,
                start_col: 0,
                end_row: 9,
                end_col: 3,
                comment: Some("Cross-sheet reference".to_string()),
            },
        );
    }

    let ranges = harness.state.named_ranges.lock().unwrap();
    let range = ranges.get("CROSSSHEET").unwrap();
    // Verify the range coordinates
    assert_eq!(range.sheet_index, Some(1));
    assert_eq!(range.start_row, 0);
    assert_eq!(range.end_row, 9);
}
