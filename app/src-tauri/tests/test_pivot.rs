//! FILENAME: tests/test_pivot.rs
//! Integration tests for pivot table commands.

mod common;

use app_lib::ProtectedRegion;
use common::{TestHarness, SalesFixture};
use engine::Cell;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/// Create a harness with sales data suitable for pivot tables.
fn create_pivot_harness() -> TestHarness {
    let harness = TestHarness::new();

    // Set up headers
    let headers = SalesFixture::headers();
    for (col, header) in headers.iter().enumerate() {
        harness.set_cell(0, col as u32, Cell::new_text(header.to_string()));
    }

    // Set up data
    let data = SalesFixture::data();
    for (i, (region, product, quarter, sales, quantity)) in data.iter().enumerate() {
        let row = (i + 1) as u32;
        harness.set_cell(row, 0, Cell::new_text(region.to_string()));
        harness.set_cell(row, 1, Cell::new_text(product.to_string()));
        harness.set_cell(row, 2, Cell::new_text(quarter.to_string()));
        harness.set_cell(row, 3, Cell::new_number(*sales));
        harness.set_cell(row, 4, Cell::new_number(*quantity));
    }

    harness
}

// ============================================================================
// PROTECTED REGION TESTS
// ============================================================================

#[test]
fn test_create_protected_region() {
    let region = ProtectedRegion {
        id: "pivot-1".to_string(),
        region_type: "pivot".to_string(),
        owner_id: 1,
        sheet_index: 0,
        start_row: 0,
        start_col: 10,
        end_row: 20,
        end_col: 15,
    };

    assert_eq!(region.id, "pivot-1");
    assert_eq!(region.region_type, "pivot");
    assert_eq!(region.sheet_index, 0);
}

#[test]
fn test_add_protected_region() {
    let harness = create_pivot_harness();

    {
        let mut regions = harness.state.protected_regions.lock().unwrap();
        regions.push(ProtectedRegion {
            id: "pivot-1".to_string(),
            region_type: "pivot".to_string(),
            owner_id: 1,
            sheet_index: 0,
            start_row: 0,
            start_col: 10,
            end_row: 20,
            end_col: 15,
        });
    }

    let regions = harness.state.protected_regions.lock().unwrap();
    assert_eq!(regions.len(), 1);
}

#[test]
fn test_multiple_protected_regions() {
    let harness = create_pivot_harness();

    {
        let mut regions = harness.state.protected_regions.lock().unwrap();

        // Add pivot table region
        regions.push(ProtectedRegion {
            id: "pivot-1".to_string(),
            region_type: "pivot".to_string(),
            owner_id: 1,
            sheet_index: 0,
            start_row: 0,
            start_col: 10,
            end_row: 10,
            end_col: 15,
        });

        // Add chart region
        regions.push(ProtectedRegion {
            id: "chart-1".to_string(),
            region_type: "chart".to_string(),
            owner_id: 1,
            sheet_index: 0,
            start_row: 12,
            start_col: 10,
            end_row: 25,
            end_col: 20,
        });
    }

    let regions = harness.state.protected_regions.lock().unwrap();
    assert_eq!(regions.len(), 2);
}

#[test]
fn test_get_region_at_cell() {
    let harness = create_pivot_harness();

    {
        let mut regions = harness.state.protected_regions.lock().unwrap();
        regions.push(ProtectedRegion {
            id: "pivot-1".to_string(),
            region_type: "pivot".to_string(),
            owner_id: 1,
            sheet_index: 0,
            start_row: 5,
            start_col: 10,
            end_row: 15,
            end_col: 15,
        });
    }

    // Cell inside region
    let region = harness.state.get_region_at_cell(0, 10, 12);
    assert!(region.is_some());
    assert_eq!(region.unwrap().id, "pivot-1");

    // Cell outside region
    let region = harness.state.get_region_at_cell(0, 0, 0);
    assert!(region.is_none());
}

#[test]
fn test_delete_protected_region() {
    let harness = create_pivot_harness();

    {
        let mut regions = harness.state.protected_regions.lock().unwrap();
        regions.push(ProtectedRegion {
            id: "pivot-1".to_string(),
            region_type: "pivot".to_string(),
            owner_id: 1,
            sheet_index: 0,
            start_row: 0,
            start_col: 10,
            end_row: 20,
            end_col: 15,
        });
    }

    // Delete
    {
        let mut regions = harness.state.protected_regions.lock().unwrap();
        regions.retain(|r| r.id != "pivot-1");
    }

    let regions = harness.state.protected_regions.lock().unwrap();
    assert!(regions.is_empty());
}

// ============================================================================
// PROTECTED REGION BOUNDARY TESTS
// ============================================================================

#[test]
fn test_region_boundary_start() {
    let harness = create_pivot_harness();

    {
        let mut regions = harness.state.protected_regions.lock().unwrap();
        regions.push(ProtectedRegion {
            id: "pivot-1".to_string(),
            region_type: "pivot".to_string(),
            owner_id: 1,
            sheet_index: 0,
            start_row: 5,
            start_col: 5,
            end_row: 10,
            end_col: 10,
        });
    }

    // Exactly at start - should be inside
    let region = harness.state.get_region_at_cell(0, 5, 5);
    assert!(region.is_some());
}

#[test]
fn test_region_boundary_end() {
    let harness = create_pivot_harness();

    {
        let mut regions = harness.state.protected_regions.lock().unwrap();
        regions.push(ProtectedRegion {
            id: "pivot-1".to_string(),
            region_type: "pivot".to_string(),
            owner_id: 1,
            sheet_index: 0,
            start_row: 5,
            start_col: 5,
            end_row: 10,
            end_col: 10,
        });
    }

    // Exactly at end - should be inside
    let region = harness.state.get_region_at_cell(0, 10, 10);
    assert!(region.is_some());
}

#[test]
fn test_region_boundary_just_outside() {
    let harness = create_pivot_harness();

    {
        let mut regions = harness.state.protected_regions.lock().unwrap();
        regions.push(ProtectedRegion {
            id: "pivot-1".to_string(),
            region_type: "pivot".to_string(),
            owner_id: 1,
            sheet_index: 0,
            start_row: 5,
            start_col: 5,
            end_row: 10,
            end_col: 10,
        });
    }

    // Just before start - outside
    let region = harness.state.get_region_at_cell(0, 4, 5);
    assert!(region.is_none());

    // Just after end - outside
    let region = harness.state.get_region_at_cell(0, 11, 10);
    assert!(region.is_none());
}

// ============================================================================
// MULTI-SHEET PROTECTED REGIONS
// ============================================================================

#[test]
fn test_protected_regions_different_sheets() {
    let harness = TestHarness::with_multiple_sheets(3);

    {
        let mut regions = harness.state.protected_regions.lock().unwrap();

        // Pivot on Sheet1
        regions.push(ProtectedRegion {
            id: "pivot-1".to_string(),
            region_type: "pivot".to_string(),
            owner_id: 1,
            sheet_index: 0,
            start_row: 0,
            start_col: 0,
            end_row: 10,
            end_col: 5,
        });

        // Pivot on Sheet2
        regions.push(ProtectedRegion {
            id: "pivot-2".to_string(),
            region_type: "pivot".to_string(),
            owner_id: 2,
            sheet_index: 1,
            start_row: 0,
            start_col: 0,
            end_row: 10,
            end_col: 5,
        });
    }

    // Check Sheet1
    let region = harness.state.get_region_at_cell(0, 5, 3);
    assert!(region.is_some());
    assert_eq!(region.unwrap().id, "pivot-1");

    // Check Sheet2
    let region = harness.state.get_region_at_cell(1, 5, 3);
    assert!(region.is_some());
    assert_eq!(region.unwrap().id, "pivot-2");

    // Sheet3 has no regions
    let region = harness.state.get_region_at_cell(2, 5, 3);
    assert!(region.is_none());
}

// ============================================================================
// SOURCE DATA TESTS
// ============================================================================

#[test]
fn test_pivot_source_data() {
    let harness = create_pivot_harness();

    // Verify source data exists
    let grid = harness.state.grid.lock().unwrap();

    // Header row
    if let Some(cell) = grid.get_cell(0, 0) {
        if let engine::CellValue::Text(s) = &cell.value {
            assert_eq!(s, "Region");
        }
    }

    // Data count
    assert!(grid.cells.len() > 0);
}

#[test]
fn test_source_data_range() {
    let harness = create_pivot_harness();
    let grid = harness.state.grid.lock().unwrap();

    // Calculate bounds
    let max_row = grid.cells.keys().map(|(r, _)| *r).max().unwrap_or(0);
    let max_col = grid.cells.keys().map(|(_, c)| *c).max().unwrap_or(0);

    // Sales fixture has 5 columns (0-4) and 13 rows (header + 12 data)
    assert_eq!(max_col, 4);
    assert_eq!(max_row, 12);
}

// ============================================================================
// REGION TYPE TESTS
// ============================================================================

#[test]
fn test_different_region_types() {
    let harness = TestHarness::new();

    {
        let mut regions = harness.state.protected_regions.lock().unwrap();

        let region_types = vec!["pivot", "chart", "table", "formula_array"];

        for (i, rtype) in region_types.iter().enumerate() {
            regions.push(ProtectedRegion {
                id: format!("{}-{}", rtype, i),
                region_type: rtype.to_string(),
                owner_id: i as u64,
                sheet_index: 0,
                start_row: (i * 20) as u32,
                start_col: 0,
                end_row: (i * 20 + 15) as u32,
                end_col: 10,
            });
        }
    }

    let regions = harness.state.protected_regions.lock().unwrap();
    assert_eq!(regions.len(), 4);

    // Verify each type
    assert!(regions.iter().any(|r| r.region_type == "pivot"));
    assert!(regions.iter().any(|r| r.region_type == "chart"));
    assert!(regions.iter().any(|r| r.region_type == "table"));
    assert!(regions.iter().any(|r| r.region_type == "formula_array"));
}

// ============================================================================
// EDGE CASES
// ============================================================================

#[test]
fn test_single_cell_protected_region() {
    let harness = TestHarness::new();

    {
        let mut regions = harness.state.protected_regions.lock().unwrap();
        regions.push(ProtectedRegion {
            id: "single-1".to_string(),
            region_type: "pivot".to_string(),
            owner_id: 1,
            sheet_index: 0,
            start_row: 5,
            start_col: 5,
            end_row: 5,
            end_col: 5,
        });
    }

    // The single cell should be protected
    let region = harness.state.get_region_at_cell(0, 5, 5);
    assert!(region.is_some());

    // Adjacent cells should not be protected
    let region = harness.state.get_region_at_cell(0, 5, 4);
    assert!(region.is_none());
}

#[test]
fn test_large_protected_region() {
    let harness = TestHarness::new();

    {
        let mut regions = harness.state.protected_regions.lock().unwrap();
        regions.push(ProtectedRegion {
            id: "large-1".to_string(),
            region_type: "pivot".to_string(),
            owner_id: 1,
            sheet_index: 0,
            start_row: 0,
            start_col: 0,
            end_row: 10000,
            end_col: 100,
        });
    }

    // Random cell in the middle should be protected
    let region = harness.state.get_region_at_cell(0, 5000, 50);
    assert!(region.is_some());
}

#[test]
fn test_no_protected_regions() {
    let harness = TestHarness::new();

    let regions = harness.state.protected_regions.lock().unwrap();
    assert!(regions.is_empty());

    // Any cell should not be protected
    let region = harness.state.get_region_at_cell(0, 0, 0);
    assert!(region.is_none());
}
