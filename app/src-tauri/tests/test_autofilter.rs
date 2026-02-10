//! FILENAME: tests/test_autofilter.rs
//! Integration tests for AutoFilter commands.

mod common;

use app_lib::{
    AutoFilter, FilterCriteria, FilterOn, FilterOperator,
    DynamicFilterCriteria, ColumnFilter,
};
use common::{TestHarness, SalesFixture};
use engine::Cell;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/// Create a harness with sales data suitable for filtering.
fn create_sales_harness() -> TestHarness {
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
// AUTOFILTER CREATION TESTS
// ============================================================================

#[test]
fn test_create_autofilter() {
    let harness = create_sales_harness();

    // Create AutoFilter for the data range
    let af = AutoFilter::new(0, 0, 12, 4);

    assert_eq!(af.start_row, 0);
    assert_eq!(af.start_col, 0);
    assert_eq!(af.end_row, 12);
    assert_eq!(af.end_col, 4);
    assert!(af.enabled);
    assert!(!af.is_data_filtered());
}

#[test]
fn test_autofilter_column_count() {
    let af = AutoFilter::new(0, 0, 10, 4);
    assert_eq!(af.column_count(), 5); // Columns 0-4 = 5 columns
}

#[test]
fn test_autofilter_row_count() {
    let af = AutoFilter::new(0, 0, 12, 4);
    assert_eq!(af.row_count(), 13); // Rows 0-12 = 13 rows
}

#[test]
fn test_autofilter_range_normalization() {
    // Create with reversed coordinates
    let af = AutoFilter::new(10, 4, 0, 0);

    // Should be normalized
    assert_eq!(af.start_row, 0);
    assert_eq!(af.start_col, 0);
    assert_eq!(af.end_row, 10);
    assert_eq!(af.end_col, 4);
}

// ============================================================================
// FILTER CRITERIA TESTS
// ============================================================================

#[test]
fn test_default_filter_criteria() {
    let criteria = FilterCriteria::default();

    assert!(criteria.criterion1.is_none());
    assert!(criteria.criterion2.is_none());
    assert!(matches!(criteria.filter_on, FilterOn::Values));
    assert!(criteria.values.is_empty());
    assert!(!criteria.filter_out_blanks);
}

#[test]
fn test_value_filter_criteria() {
    let criteria = FilterCriteria {
        filter_on: FilterOn::Values,
        values: vec!["North".to_string(), "South".to_string()],
        ..Default::default()
    };

    assert_eq!(criteria.values.len(), 2);
    assert!(criteria.values.contains(&"North".to_string()));
    assert!(criteria.values.contains(&"South".to_string()));
}

#[test]
fn test_top_items_filter_criteria() {
    let criteria = FilterCriteria {
        filter_on: FilterOn::TopItems,
        criterion1: Some("5".to_string()), // Top 5 items
        ..Default::default()
    };

    assert!(matches!(criteria.filter_on, FilterOn::TopItems));
    assert_eq!(criteria.criterion1, Some("5".to_string()));
}

#[test]
fn test_top_percent_filter_criteria() {
    let criteria = FilterCriteria {
        filter_on: FilterOn::TopPercent,
        criterion1: Some("10".to_string()), // Top 10%
        ..Default::default()
    };

    assert!(matches!(criteria.filter_on, FilterOn::TopPercent));
}

#[test]
fn test_custom_filter_criteria() {
    let criteria = FilterCriteria {
        filter_on: FilterOn::Custom,
        criterion1: Some(">1000".to_string()),
        criterion2: Some("<5000".to_string()),
        operator: Some(FilterOperator::And),
        ..Default::default()
    };

    assert!(matches!(criteria.filter_on, FilterOn::Custom));
    assert!(matches!(criteria.operator, Some(FilterOperator::And)));
}

#[test]
fn test_dynamic_filter_above_average() {
    let criteria = FilterCriteria {
        filter_on: FilterOn::Dynamic,
        dynamic_criteria: Some(DynamicFilterCriteria::AboveAverage),
        ..Default::default()
    };

    assert!(matches!(criteria.filter_on, FilterOn::Dynamic));
    assert!(matches!(
        criteria.dynamic_criteria,
        Some(DynamicFilterCriteria::AboveAverage)
    ));
}

// ============================================================================
// COLUMN FILTER TESTS
// ============================================================================

#[test]
fn test_add_column_filter() {
    let mut af = AutoFilter::new(0, 0, 12, 4);

    let col_filter = ColumnFilter {
        column_index: 0,
        criteria: FilterCriteria {
            filter_on: FilterOn::Values,
            values: vec!["North".to_string()],
            ..Default::default()
        },
    };

    af.column_filters.insert(0, col_filter);

    assert!(af.is_data_filtered());
    assert_eq!(af.column_filters.len(), 1);
}

#[test]
fn test_multiple_column_filters() {
    let mut af = AutoFilter::new(0, 0, 12, 4);

    // Filter on Region (col 0)
    af.column_filters.insert(
        0,
        ColumnFilter {
            column_index: 0,
            criteria: FilterCriteria {
                filter_on: FilterOn::Values,
                values: vec!["North".to_string()],
                ..Default::default()
            },
        },
    );

    // Filter on Product (col 1)
    af.column_filters.insert(
        1,
        ColumnFilter {
            column_index: 1,
            criteria: FilterCriteria {
                filter_on: FilterOn::Values,
                values: vec!["Widget".to_string()],
                ..Default::default()
            },
        },
    );

    assert_eq!(af.column_filters.len(), 2);
    assert!(af.column_filters.contains_key(&0));
    assert!(af.column_filters.contains_key(&1));
}

#[test]
fn test_clear_column_filter() {
    let mut af = AutoFilter::new(0, 0, 12, 4);

    // Add then remove filter
    af.column_filters.insert(
        0,
        ColumnFilter {
            column_index: 0,
            criteria: FilterCriteria::default(),
        },
    );

    af.column_filters.remove(&0);

    assert!(!af.is_data_filtered());
    assert!(af.column_filters.is_empty());
}

// ============================================================================
// HIDDEN ROWS TESTS
// ============================================================================

#[test]
fn test_hidden_rows_tracking() {
    let mut af = AutoFilter::new(0, 0, 12, 4);

    // Hide some rows
    af.hidden_rows.insert(2);
    af.hidden_rows.insert(4);
    af.hidden_rows.insert(6);

    assert_eq!(af.hidden_rows.len(), 3);
    assert!(af.hidden_rows.contains(&2));
    assert!(af.hidden_rows.contains(&4));
    assert!(af.hidden_rows.contains(&6));
    assert!(!af.hidden_rows.contains(&1));
}

#[test]
fn test_show_hidden_rows() {
    let mut af = AutoFilter::new(0, 0, 12, 4);

    // Hide then show
    af.hidden_rows.insert(2);
    af.hidden_rows.insert(4);
    af.hidden_rows.remove(&2);

    assert_eq!(af.hidden_rows.len(), 1);
    assert!(af.hidden_rows.contains(&4));
}

#[test]
fn test_clear_all_hidden_rows() {
    let mut af = AutoFilter::new(0, 0, 12, 4);

    for i in 1..10 {
        af.hidden_rows.insert(i);
    }

    af.hidden_rows.clear();

    assert!(af.hidden_rows.is_empty());
}

// ============================================================================
// AUTOFILTER STORAGE TESTS
// ============================================================================

#[test]
fn test_autofilter_storage_per_sheet() {
    let harness = create_sales_harness();

    {
        let mut storage = harness.state.auto_filters.lock().unwrap();

        // Add AutoFilter to sheet 0
        storage.insert(0, AutoFilter::new(0, 0, 12, 4));

        // Should only have one
        assert_eq!(storage.len(), 1);
        assert!(storage.contains_key(&0));
    }
}

#[test]
fn test_multiple_sheets_autofilters() {
    let harness = TestHarness::with_multiple_sheets(3);

    {
        let mut storage = harness.state.auto_filters.lock().unwrap();

        // Each sheet can have its own AutoFilter
        storage.insert(0, AutoFilter::new(0, 0, 10, 5));
        storage.insert(1, AutoFilter::new(0, 0, 20, 3));
        storage.insert(2, AutoFilter::new(5, 2, 50, 8));

        assert_eq!(storage.len(), 3);
    }

    let storage = harness.state.auto_filters.lock().unwrap();
    let af0 = storage.get(&0).unwrap();
    let af1 = storage.get(&1).unwrap();
    let af2 = storage.get(&2).unwrap();

    assert_eq!(af0.end_row, 10);
    assert_eq!(af1.end_row, 20);
    assert_eq!(af2.start_row, 5);
}

#[test]
fn test_remove_autofilter() {
    let harness = create_sales_harness();

    {
        let mut storage = harness.state.auto_filters.lock().unwrap();
        storage.insert(0, AutoFilter::new(0, 0, 12, 4));
    }

    {
        let mut storage = harness.state.auto_filters.lock().unwrap();
        storage.remove(&0);
    }

    let storage = harness.state.auto_filters.lock().unwrap();
    assert!(storage.get(&0).is_none());
}

// ============================================================================
// FILTER MATCHING LOGIC TESTS
// ============================================================================

#[test]
fn test_value_matching() {
    let criteria = FilterCriteria {
        filter_on: FilterOn::Values,
        values: vec!["North".to_string(), "South".to_string()],
        ..Default::default()
    };

    // These should match
    assert!(criteria.values.contains(&"North".to_string()));
    assert!(criteria.values.contains(&"South".to_string()));

    // These should not match
    assert!(!criteria.values.contains(&"East".to_string()));
    assert!(!criteria.values.contains(&"West".to_string()));
}

#[test]
fn test_blanks_filtering() {
    let criteria = FilterCriteria {
        filter_on: FilterOn::Values,
        filter_out_blanks: true,
        ..Default::default()
    };

    assert!(criteria.filter_out_blanks);
}

// ============================================================================
// AUTOFILTER INFO CONVERSION TESTS
// ============================================================================

#[test]
fn test_autofilter_to_info() {
    let mut af = AutoFilter::new(0, 0, 10, 4);
    af.column_filters.insert(
        0,
        ColumnFilter {
            column_index: 0,
            criteria: FilterCriteria {
                filter_on: FilterOn::Values,
                values: vec!["Test".to_string()],
                ..Default::default()
            },
        },
    );

    let info: app_lib::AutoFilterInfo = (&af).into();

    assert_eq!(info.start_row, 0);
    assert_eq!(info.end_col, 4);
    assert!(info.is_data_filtered);
    assert!(info.enabled);
    assert_eq!(info.criteria.len(), 5); // 5 columns
    assert!(info.criteria[0].is_some());
    assert!(info.criteria[1].is_none());
}

// ============================================================================
// EDGE CASES
// ============================================================================

#[test]
fn test_single_cell_autofilter() {
    let af = AutoFilter::new(0, 0, 0, 0);

    assert_eq!(af.column_count(), 1);
    assert_eq!(af.row_count(), 1);
}

#[test]
fn test_large_range_autofilter() {
    let af = AutoFilter::new(0, 0, 100000, 50);

    assert_eq!(af.row_count(), 100001);
    assert_eq!(af.column_count(), 51);
}

#[test]
fn test_disabled_autofilter() {
    let mut af = AutoFilter::new(0, 0, 10, 4);
    af.enabled = false;

    assert!(!af.enabled);
    // Still maintains range info even when disabled
    assert_eq!(af.start_row, 0);
    assert_eq!(af.end_row, 10);
}

#[test]
fn test_dynamic_filter_criteria_variants() {
    let date_filters = vec![
        DynamicFilterCriteria::Today,
        DynamicFilterCriteria::Yesterday,
        DynamicFilterCriteria::Tomorrow,
        DynamicFilterCriteria::ThisWeek,
        DynamicFilterCriteria::ThisMonth,
        DynamicFilterCriteria::ThisYear,
        DynamicFilterCriteria::AboveAverage,
        DynamicFilterCriteria::BelowAverage,
    ];

    for df in date_filters {
        let criteria = FilterCriteria {
            filter_on: FilterOn::Dynamic,
            dynamic_criteria: Some(df),
            ..Default::default()
        };
        assert!(matches!(criteria.filter_on, FilterOn::Dynamic));
        assert!(criteria.dynamic_criteria.is_some());
    }
}

#[test]
fn test_filter_operator_variants() {
    // Test AND operator
    let and_criteria = FilterCriteria {
        filter_on: FilterOn::Custom,
        operator: Some(FilterOperator::And),
        ..Default::default()
    };
    assert!(matches!(and_criteria.operator, Some(FilterOperator::And)));

    // Test OR operator
    let or_criteria = FilterCriteria {
        filter_on: FilterOn::Custom,
        operator: Some(FilterOperator::Or),
        ..Default::default()
    };
    assert!(matches!(or_criteria.operator, Some(FilterOperator::Or)));
}
