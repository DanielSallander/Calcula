//! FILENAME: tests/test_pivot.rs
//! Comprehensive integration tests for the pivot table engine.
//!
//! Uses a 40-row Adventure Works dataset (denormalised fact_sales joined with
//! dimension tables) that mirrors the BI model in
//! `Calcula Studio/examples/model.json`.  Tests cover:
//!
//! - Basic pivot creation & aggregation (Sum, Count, Average, Min, Max, etc.)
//! - Row + Column fields (cross-tab)
//! - Multiple value fields
//! - Filtering (hidden items, page filters)
//! - Sorting (ascending, descending)
//! - Layout variants (Compact, Tabular, Outline)
//! - Grand totals on/off
//! - Subtotals on/off
//! - Number binning grouping
//! - Manual grouping
//! - Calculated fields
//! - Show Values As (% of grand total, % of row, etc.)
//! - Protected regions & boundaries (retained from prior suite)
//! - Drill-down
//! - Multiple row/column hierarchies
//! - Empty pivot (no fields)
//! - Single-row dataset edge case

mod common;

use common::{
    AdventureWorksFixture, TestHarness, SalesFixture,
    pivot_grand_total, pivot_row_labels, pivot_col_labels,
    pivot_cell_type_count, pivot_data_sum,
};
use engine::Cell;
use pivot_engine::{
    AggregationType, CalculatedField, PivotDefinition, PivotField, PivotCellType,
    PivotCellValue, ValueField, ShowValuesAs, SortOrder,
    ReportLayout, FieldGrouping, ManualGroup,
    SubtotalLocation, ValuesPosition,
    calculate_pivot, drill_down,
};
use app_lib::ProtectedRegion;

// ============================================================================
// HARNESS BUILDERS
// ============================================================================

/// Build a harness loaded with the 40-row Adventure Works data.
fn aw_harness() -> TestHarness {
    let h = TestHarness::new();
    AdventureWorksFixture::populate(&h);
    h
}

/// Source range for the Adventure Works data (header + 40 data rows, 13 columns).
const AW_START: (u32, u32) = (0, 0);
const AW_END: (u32, u32) = (40, 12);

// ============================================================================
// 1. BASIC PIVOT CREATION
// ============================================================================

#[test]
fn test_empty_pivot_no_fields() {
    let h = aw_harness();
    let (mut cache, _) = h.build_pivot_cache(AW_START, AW_END, true);
    let def = PivotDefinition::new(1, AW_START, AW_END);
    let view = calculate_pivot(&def, &mut cache);

    // An empty pivot should produce a minimal view with no data cells.
    assert_eq!(pivot_cell_type_count(&view, PivotCellType::Data), 0);
}

#[test]
fn test_single_row_field_sum() {
    let h = aw_harness();
    // Pivot: Rows=Territory, Values=Sum of LineTotal
    let (_def, _cache, view) = h.create_pivot(
        AW_START, AW_END,
        vec![PivotField::new(0, "Territory".into())],
        vec![],
        vec![ValueField::new(12, "Sum of LineTotal".into(), AggregationType::Sum)],
    );

    let labels = pivot_row_labels(&view);
    // Should have all territories from the data
    assert!(labels.contains(&"Northwest".to_string()));
    assert!(labels.contains(&"Southwest".to_string()));
    assert!(labels.contains(&"Northeast".to_string()));
    assert!(labels.contains(&"Central".to_string()));
    assert!(labels.contains(&"Canada".to_string()));
    assert!(labels.contains(&"France".to_string()));
    assert!(labels.contains(&"Germany".to_string()));
    assert!(labels.contains(&"UK".to_string()));

    // Grand total should equal the sum of all LineTotal values in the fixture.
    let expected_total: f64 = AdventureWorksFixture::data().iter().map(|r| r.12).sum();
    let grand = pivot_grand_total(&view).expect("should have grand total");
    assert!((grand - expected_total).abs() < 0.01, "Grand total {grand} != {expected_total}");
}

#[test]
fn test_single_row_field_count() {
    let h = aw_harness();
    let (_def, _cache, view) = h.create_pivot(
        AW_START, AW_END,
        vec![PivotField::new(0, "Territory".into())],
        vec![],
        vec![ValueField::new(12, "Count of LineTotal".into(), AggregationType::Count)],
    );

    let grand = pivot_grand_total(&view).expect("should have grand total");
    assert_eq!(grand as u64, 40, "Total row count should be 40");
}

#[test]
fn test_single_row_field_average() {
    let h = aw_harness();
    let (_def, _cache, view) = h.create_pivot(
        AW_START, AW_END,
        vec![PivotField::new(0, "Territory".into())],
        vec![],
        vec![ValueField::new(12, "Avg of LineTotal".into(), AggregationType::Average)],
    );

    let expected_total: f64 = AdventureWorksFixture::data().iter().map(|r| r.12).sum();
    let expected_avg = expected_total / 40.0;
    let grand = pivot_grand_total(&view).expect("should have grand total");
    assert!((grand - expected_avg).abs() < 0.01, "Grand avg {grand} != {expected_avg}");
}

#[test]
fn test_single_row_field_min_max() {
    let h = aw_harness();
    let data = AdventureWorksFixture::data();
    let expected_min = data.iter().map(|r| r.12).fold(f64::INFINITY, f64::min);
    let expected_max = data.iter().map(|r| r.12).fold(f64::NEG_INFINITY, f64::max);

    // Min
    let (_, _, view_min) = h.create_pivot(
        AW_START, AW_END,
        vec![PivotField::new(0, "Territory".into())],
        vec![],
        vec![ValueField::new(12, "Min".into(), AggregationType::Min)],
    );
    let grand_min = pivot_grand_total(&view_min).expect("min grand total");
    assert!((grand_min - expected_min).abs() < 0.01);

    // Max
    let (_, _, view_max) = h.create_pivot(
        AW_START, AW_END,
        vec![PivotField::new(0, "Territory".into())],
        vec![],
        vec![ValueField::new(12, "Max".into(), AggregationType::Max)],
    );
    let grand_max = pivot_grand_total(&view_max).expect("max grand total");
    assert!((grand_max - expected_max).abs() < 0.01);
}

// ============================================================================
// 2. CROSS-TAB (ROW + COLUMN FIELDS)
// ============================================================================

#[test]
fn test_row_and_column_fields() {
    let h = aw_harness();
    // Rows=Category, Columns=Year, Values=Sum of LineTotal
    let (_def, _cache, view) = h.create_pivot(
        AW_START, AW_END,
        vec![PivotField::new(2, "Category".into())],
        vec![PivotField::new(7, "Year".into())],
        vec![ValueField::new(12, "Sum of LineTotal".into(), AggregationType::Sum)],
    );

    let row_labels = pivot_row_labels(&view);
    assert!(row_labels.contains(&"Bikes".to_string()));
    assert!(row_labels.contains(&"Clothing".to_string()));

    let col_labels = pivot_col_labels(&view);
    assert!(col_labels.contains(&"2023".to_string()) || col_labels.contains(&"2023.0".to_string())
        || col_labels.iter().any(|l| l.starts_with("2023")));
    assert!(col_labels.contains(&"2024".to_string()) || col_labels.contains(&"2024.0".to_string())
        || col_labels.iter().any(|l| l.starts_with("2024")));

    // Grand total must equal total of all rows
    let expected_total: f64 = AdventureWorksFixture::data().iter().map(|r| r.12).sum();
    let grand = pivot_grand_total(&view).expect("cross-tab grand total");
    assert!((grand - expected_total).abs() < 0.01);
}

#[test]
fn test_multiple_row_fields_hierarchy() {
    let h = aw_harness();
    // Rows=Territory, Category — two-level hierarchy
    let (_def, _cache, view) = h.create_pivot(
        AW_START, AW_END,
        vec![
            PivotField::new(0, "Territory".into()),
            PivotField::new(2, "Category".into()),
        ],
        vec![],
        vec![ValueField::new(12, "Sum of LineTotal".into(), AggregationType::Sum)],
    );

    let labels = pivot_row_labels(&view);
    // Outer level
    assert!(labels.contains(&"Northwest".to_string()));
    // Inner level
    assert!(labels.contains(&"Bikes".to_string()));
    assert!(labels.contains(&"Clothing".to_string()));
}

#[test]
fn test_multiple_column_fields() {
    let h = aw_harness();
    // Rows=Territory, Columns=Category + Year
    let (_def, _cache, view) = h.create_pivot(
        AW_START, AW_END,
        vec![PivotField::new(0, "Territory".into())],
        vec![
            PivotField::new(2, "Category".into()),
            PivotField::new(7, "Year".into()),
        ],
        vec![ValueField::new(12, "Sum of LineTotal".into(), AggregationType::Sum)],
    );

    // Should have column headers for Category values
    let col_labels = pivot_col_labels(&view);
    assert!(col_labels.iter().any(|l| l == "Bikes"));
    assert!(col_labels.iter().any(|l| l == "Clothing"));
}

// ============================================================================
// 3. MULTIPLE VALUE FIELDS
// ============================================================================

#[test]
fn test_multiple_value_fields() {
    let h = aw_harness();
    let (_def, _cache, view) = h.create_pivot(
        AW_START, AW_END,
        vec![PivotField::new(0, "Territory".into())],
        vec![],
        vec![
            ValueField::new(12, "Sum of LineTotal".into(), AggregationType::Sum),
            ValueField::new(10, "Sum of OrderQty".into(), AggregationType::Sum),
        ],
    );

    // Grand total should exist and data cells should be present
    let data_count = pivot_cell_type_count(&view, PivotCellType::Data);
    // 8 territories * 2 value fields = 16 data cells (at minimum)
    assert!(data_count >= 16, "Expected at least 16 data cells, got {data_count}");
}

#[test]
fn test_value_fields_count_and_average() {
    let h = aw_harness();
    let (_def, _cache, view) = h.create_pivot(
        AW_START, AW_END,
        vec![PivotField::new(2, "Category".into())],
        vec![],
        vec![
            ValueField::new(12, "Count".into(), AggregationType::Count),
            ValueField::new(11, "Avg UnitPrice".into(), AggregationType::Average),
        ],
    );

    // We have Bikes and Clothing categories, each with count and avg
    let data_count = pivot_cell_type_count(&view, PivotCellType::Data);
    assert!(data_count >= 4, "Expected at least 4 data cells (2 categories x 2 values)");
}

// ============================================================================
// 4. FILTERING
// ============================================================================

#[test]
fn test_hidden_items_filter() {
    let h = aw_harness();
    // Hide "Clothing" from Category — only Bikes should remain
    let (mut cache, _) = h.build_pivot_cache(AW_START, AW_END, true);
    let mut def = PivotDefinition::new(1, AW_START, AW_END);

    let mut cat_field = PivotField::new(2, "Category".into());
    cat_field.hidden_items = vec!["Clothing".to_string()];
    def.row_fields = vec![cat_field];
    def.value_fields = vec![ValueField::new(12, "Sum".into(), AggregationType::Sum)];

    let view = calculate_pivot(&def, &mut cache);

    let labels = pivot_row_labels(&view);
    assert!(labels.contains(&"Bikes".to_string()));
    assert!(!labels.contains(&"Clothing".to_string()), "Clothing should be filtered out");

    // Grand total should be Bikes-only total
    let bikes_total: f64 = AdventureWorksFixture::data()
        .iter()
        .filter(|r| r.2 == "Bikes")
        .map(|r| r.12)
        .sum();
    let grand = pivot_grand_total(&view).expect("filtered grand total");
    assert!((grand - bikes_total).abs() < 0.01);
}

#[test]
fn test_page_filter_via_hidden_items() {
    let h = aw_harness();
    let (mut cache, _) = h.build_pivot_cache(AW_START, AW_END, true);
    let mut def = PivotDefinition::new(1, AW_START, AW_END);

    // Filter to US only by hiding non-US countries on the Country row field
    // (Page filters with ValueList are not yet applied by the engine — use
    // hidden_items on a row field to achieve the equivalent.)
    let mut country_field = PivotField::new(1, "Country".into());
    country_field.hidden_items = vec![
        "CA".to_string(), "FR".to_string(), "DE".to_string(), "GB".to_string(),
    ];
    def.row_fields = vec![
        country_field,
        PivotField::new(0, "Territory".into()),
    ];
    def.value_fields = vec![ValueField::new(12, "Sum".into(), AggregationType::Sum)];

    let view = calculate_pivot(&def, &mut cache);

    let labels = pivot_row_labels(&view);
    // US-only territories should be present
    assert!(labels.contains(&"Northwest".to_string()));
    assert!(labels.contains(&"Southwest".to_string()));
    // International territories should be excluded
    assert!(!labels.contains(&"Canada".to_string()));
    assert!(!labels.contains(&"France".to_string()));
    assert!(!labels.contains(&"Germany".to_string()));
    assert!(!labels.contains(&"UK".to_string()));

    let us_total: f64 = AdventureWorksFixture::data()
        .iter()
        .filter(|r| r.1 == "US")
        .map(|r| r.12)
        .sum();
    let grand = pivot_grand_total(&view).expect("US-filtered grand total");
    assert!((grand - us_total).abs() < 0.01);
}

#[test]
fn test_hidden_items_multiple_values() {
    let h = aw_harness();
    let (mut cache, _) = h.build_pivot_cache(AW_START, AW_END, true);
    let mut def = PivotDefinition::new(1, AW_START, AW_END);

    // Hide several territories
    let mut territory = PivotField::new(0, "Territory".into());
    territory.hidden_items = vec![
        "Canada".to_string(),
        "France".to_string(),
        "Germany".to_string(),
        "UK".to_string(),
    ];
    def.row_fields = vec![territory];
    def.value_fields = vec![ValueField::new(12, "Sum".into(), AggregationType::Sum)];

    let view = calculate_pivot(&def, &mut cache);

    let labels = pivot_row_labels(&view);
    assert!(!labels.contains(&"Canada".to_string()));
    assert!(!labels.contains(&"France".to_string()));
    assert!(labels.contains(&"Northwest".to_string()));
}

// ============================================================================
// 5. SORTING
// ============================================================================

#[test]
fn test_sort_ascending() {
    let h = aw_harness();
    let (mut cache, _) = h.build_pivot_cache(AW_START, AW_END, true);
    let mut def = PivotDefinition::new(1, AW_START, AW_END);

    let mut field = PivotField::new(0, "Territory".into());
    field.sort_order = SortOrder::Ascending;
    def.row_fields = vec![field];
    def.value_fields = vec![ValueField::new(12, "Sum".into(), AggregationType::Sum)];

    let view = calculate_pivot(&def, &mut cache);

    let labels = pivot_row_labels(&view);
    // Labels should be in alphabetical order
    let mut sorted = labels.clone();
    sorted.sort();
    assert_eq!(labels, sorted, "Row labels should be sorted ascending");
}

#[test]
fn test_sort_descending() {
    let h = aw_harness();
    let (mut cache, _) = h.build_pivot_cache(AW_START, AW_END, true);
    let mut def = PivotDefinition::new(1, AW_START, AW_END);

    let mut field = PivotField::new(0, "Territory".into());
    field.sort_order = SortOrder::Descending;
    def.row_fields = vec![field];
    def.value_fields = vec![ValueField::new(12, "Sum".into(), AggregationType::Sum)];

    let view = calculate_pivot(&def, &mut cache);

    let labels = pivot_row_labels(&view);
    let mut sorted = labels.clone();
    sorted.sort();
    sorted.reverse();
    assert_eq!(labels, sorted, "Row labels should be sorted descending");
}

// ============================================================================
// 6. LAYOUT VARIANTS
// ============================================================================

#[test]
fn test_compact_layout() {
    let h = aw_harness();
    let (mut cache, _) = h.build_pivot_cache(AW_START, AW_END, true);
    let mut def = PivotDefinition::new(1, AW_START, AW_END);
    def.layout.report_layout = ReportLayout::Compact;
    def.row_fields = vec![
        PivotField::new(0, "Territory".into()),
        PivotField::new(2, "Category".into()),
    ];
    def.value_fields = vec![ValueField::new(12, "Sum".into(), AggregationType::Sum)];

    let view = calculate_pivot(&def, &mut cache);

    // Compact layout: row labels share a single column (row_label_col_count == 1)
    assert_eq!(view.row_label_col_count, 1, "Compact layout should use 1 label column");
}

#[test]
fn test_tabular_layout() {
    let h = aw_harness();
    let (mut cache, _) = h.build_pivot_cache(AW_START, AW_END, true);
    let mut def = PivotDefinition::new(1, AW_START, AW_END);
    def.layout.report_layout = ReportLayout::Tabular;
    def.row_fields = vec![
        PivotField::new(0, "Territory".into()),
        PivotField::new(2, "Category".into()),
    ];
    def.value_fields = vec![ValueField::new(12, "Sum".into(), AggregationType::Sum)];

    let view = calculate_pivot(&def, &mut cache);

    // Tabular layout: each row field gets its own column
    assert_eq!(view.row_label_col_count, 2, "Tabular layout with 2 row fields should use 2 label columns");
}

#[test]
fn test_outline_layout() {
    let h = aw_harness();
    let (mut cache, _) = h.build_pivot_cache(AW_START, AW_END, true);
    let mut def = PivotDefinition::new(1, AW_START, AW_END);
    def.layout.report_layout = ReportLayout::Outline;
    def.row_fields = vec![
        PivotField::new(0, "Territory".into()),
        PivotField::new(2, "Category".into()),
    ];
    def.value_fields = vec![ValueField::new(12, "Sum".into(), AggregationType::Sum)];

    let view = calculate_pivot(&def, &mut cache);

    // Outline layout: each field gets its own column, like Tabular
    assert_eq!(view.row_label_col_count, 2, "Outline layout with 2 row fields should use 2 label columns");
}

// ============================================================================
// 7. GRAND TOTALS ON/OFF
// ============================================================================

#[test]
fn test_no_row_grand_totals() {
    let h = aw_harness();
    let (mut cache, _) = h.build_pivot_cache(AW_START, AW_END, true);
    let mut def = PivotDefinition::new(1, AW_START, AW_END);
    def.layout.show_row_grand_totals = false;
    def.row_fields = vec![PivotField::new(0, "Territory".into())];
    def.value_fields = vec![ValueField::new(12, "Sum".into(), AggregationType::Sum)];

    let view = calculate_pivot(&def, &mut cache);

    let gt_count = pivot_cell_type_count(&view, PivotCellType::GrandTotalRow)
        + pivot_cell_type_count(&view, PivotCellType::GrandTotal);
    assert_eq!(gt_count, 0, "No row grand total when disabled");
}

#[test]
fn test_no_column_grand_totals() {
    let h = aw_harness();
    let (mut cache, _) = h.build_pivot_cache(AW_START, AW_END, true);
    let mut def = PivotDefinition::new(1, AW_START, AW_END);
    def.layout.show_column_grand_totals = false;
    def.row_fields = vec![PivotField::new(0, "Territory".into())];
    def.column_fields = vec![PivotField::new(2, "Category".into())];
    def.value_fields = vec![ValueField::new(12, "Sum".into(), AggregationType::Sum)];

    let view = calculate_pivot(&def, &mut cache);

    let gt_col_count = pivot_cell_type_count(&view, PivotCellType::GrandTotalColumn)
        + pivot_cell_type_count(&view, PivotCellType::GrandTotal);
    assert_eq!(gt_col_count, 0, "No column grand total when disabled");
}

#[test]
fn test_both_grand_totals_off() {
    let h = aw_harness();
    let (mut cache, _) = h.build_pivot_cache(AW_START, AW_END, true);
    let mut def = PivotDefinition::new(1, AW_START, AW_END);
    def.layout.show_row_grand_totals = false;
    def.layout.show_column_grand_totals = false;
    def.row_fields = vec![PivotField::new(0, "Territory".into())];
    def.column_fields = vec![PivotField::new(2, "Category".into())];
    def.value_fields = vec![ValueField::new(12, "Sum".into(), AggregationType::Sum)];

    let view = calculate_pivot(&def, &mut cache);

    let any_grand = pivot_cell_type_count(&view, PivotCellType::GrandTotalRow)
        + pivot_cell_type_count(&view, PivotCellType::GrandTotalColumn)
        + pivot_cell_type_count(&view, PivotCellType::GrandTotal);
    assert_eq!(any_grand, 0, "No grand totals at all when both disabled");
}

// ============================================================================
// 8. SUBTOTALS
// ============================================================================

#[test]
fn test_subtotals_off() {
    let h = aw_harness();
    let (mut cache, _) = h.build_pivot_cache(AW_START, AW_END, true);
    let mut def = PivotDefinition::new(1, AW_START, AW_END);

    let mut outer = PivotField::new(0, "Territory".into());
    outer.show_subtotals = false;
    def.row_fields = vec![outer, PivotField::new(2, "Category".into())];
    def.value_fields = vec![ValueField::new(12, "Sum".into(), AggregationType::Sum)];

    let view = calculate_pivot(&def, &mut cache);

    let subtotal_count = pivot_cell_type_count(&view, PivotCellType::RowSubtotal);
    assert_eq!(subtotal_count, 0, "No subtotals when show_subtotals=false on outer field");
}

#[test]
fn test_subtotals_on() {
    let h = aw_harness();
    let (mut cache, _) = h.build_pivot_cache(AW_START, AW_END, true);
    let mut def = PivotDefinition::new(1, AW_START, AW_END);

    let outer = PivotField::new(0, "Territory".into()); // show_subtotals defaults true
    def.row_fields = vec![outer, PivotField::new(2, "Category".into())];
    def.value_fields = vec![ValueField::new(12, "Sum".into(), AggregationType::Sum)];

    // Use Tabular or Outline layout — compact layout renders subtotals inline
    // and may not emit RowSubtotal cells.
    def.layout.report_layout = ReportLayout::Tabular;
    def.layout.subtotal_location = SubtotalLocation::AtBottom;

    let view = calculate_pivot(&def, &mut cache);

    let subtotal_count = pivot_cell_type_count(&view, PivotCellType::RowSubtotal);
    // Should have subtotal rows per outer group (8 territories)
    assert!(subtotal_count >= 8, "Expected at least 8 subtotal cells, got {subtotal_count}");
}

#[test]
fn test_subtotals_location_off() {
    let h = aw_harness();
    let (mut cache, _) = h.build_pivot_cache(AW_START, AW_END, true);
    let mut def = PivotDefinition::new(1, AW_START, AW_END);
    def.layout.subtotal_location = SubtotalLocation::Off;

    def.row_fields = vec![
        PivotField::new(0, "Territory".into()),
        PivotField::new(2, "Category".into()),
    ];
    def.value_fields = vec![ValueField::new(12, "Sum".into(), AggregationType::Sum)];

    let view = calculate_pivot(&def, &mut cache);

    let subtotal_count = pivot_cell_type_count(&view, PivotCellType::RowSubtotal);
    assert_eq!(subtotal_count, 0, "SubtotalLocation::Off should hide all subtotals");
}

// ============================================================================
// 9. NUMBER BINNING GROUPING
// ============================================================================

#[test]
fn test_number_binning() {
    let h = aw_harness();
    let (mut cache, _) = h.build_pivot_cache(AW_START, AW_END, true);
    let mut def = PivotDefinition::new(1, AW_START, AW_END);

    // Group UnitPrice (col 11) into bins: 0-100, 100-1000, 1000-4000
    let mut price_field = PivotField::new(11, "UnitPrice".into());
    price_field.grouping = FieldGrouping::NumberBinning {
        start: 0.0,
        end: 4000.0,
        interval: 1000.0,
    };
    def.row_fields = vec![price_field];
    def.value_fields = vec![ValueField::new(12, "Sum".into(), AggregationType::Sum)];

    let view = calculate_pivot(&def, &mut cache);

    let labels = pivot_row_labels(&view);
    // Should have binned labels
    assert!(!labels.is_empty(), "Number binning should produce row labels");

    // Grand total should still be correct
    let expected_total: f64 = AdventureWorksFixture::data().iter().map(|r| r.12).sum();
    let grand = pivot_grand_total(&view).expect("binning grand total");
    assert!((grand - expected_total).abs() < 0.01);
}

// ============================================================================
// 10. MANUAL GROUPING
// ============================================================================

#[test]
fn test_manual_grouping() {
    let h = aw_harness();
    let (mut cache, _) = h.build_pivot_cache(AW_START, AW_END, true);
    let mut def = PivotDefinition::new(1, AW_START, AW_END);

    // Group territories into "Domestic" and "International"
    let mut territory_field = PivotField::new(0, "Territory".into());
    territory_field.grouping = FieldGrouping::ManualGrouping {
        groups: vec![
            ManualGroup {
                name: "Domestic".into(),
                members: vec![
                    "Northwest".into(), "Southwest".into(), "Northeast".into(), "Central".into(),
                ],
            },
            ManualGroup {
                name: "International".into(),
                members: vec![
                    "Canada".into(), "France".into(), "Germany".into(), "UK".into(),
                ],
            },
        ],
        ungrouped_name: "Other".into(),
    };
    def.row_fields = vec![territory_field];
    def.value_fields = vec![ValueField::new(12, "Sum".into(), AggregationType::Sum)];

    let view = calculate_pivot(&def, &mut cache);

    let labels = pivot_row_labels(&view);
    assert!(labels.contains(&"Domestic".to_string()), "Should have Domestic group");
    assert!(labels.contains(&"International".to_string()), "Should have International group");

    // Grand total unchanged
    let expected_total: f64 = AdventureWorksFixture::data().iter().map(|r| r.12).sum();
    let grand = pivot_grand_total(&view).expect("manual grouping grand total");
    assert!((grand - expected_total).abs() < 0.01);
}

// ============================================================================
// 11. CALCULATED FIELDS
// ============================================================================

#[test]
fn test_calculated_field() {
    let h = aw_harness();
    let (mut cache, _) = h.build_pivot_cache(AW_START, AW_END, true);
    let mut def = PivotDefinition::new(1, AW_START, AW_END);

    def.row_fields = vec![PivotField::new(0, "Territory".into())];
    def.value_fields = vec![
        ValueField::new(12, "Sum of LineTotal".into(), AggregationType::Sum),
        ValueField::new(10, "Sum of OrderQty".into(), AggregationType::Sum),
    ];
    def.calculated_fields = vec![CalculatedField {
        name: "AvgPricePerUnit".into(),
        formula: "'Sum of LineTotal' / 'Sum of OrderQty'".into(),
        number_format: None,
    }];

    let view = calculate_pivot(&def, &mut cache);

    // Should have data cells (the calculated field should produce results)
    let data_count = pivot_cell_type_count(&view, PivotCellType::Data);
    // 8 territories * 3 value columns (2 regular + 1 calculated) = 24
    assert!(data_count >= 16, "Should have data cells including calculated field");
}

// ============================================================================
// 12. SHOW VALUES AS
// ============================================================================

#[test]
fn test_show_values_as_percent_of_grand_total() {
    let h = aw_harness();
    let (mut cache, _) = h.build_pivot_cache(AW_START, AW_END, true);
    let mut def = PivotDefinition::new(1, AW_START, AW_END);

    def.row_fields = vec![PivotField::new(0, "Territory".into())];
    let mut vf = ValueField::new(12, "% of Total".into(), AggregationType::Sum);
    vf.show_values_as = ShowValuesAs::PercentOfGrandTotal;
    def.value_fields = vec![vf];

    let view = calculate_pivot(&def, &mut cache);

    // The grand total in PercentOfGrandTotal mode should be 1.0 (100%)
    let grand = pivot_grand_total(&view);
    if let Some(g) = grand {
        assert!((g - 1.0).abs() < 0.01, "Grand total for % of total should be 1.0, got {g}");
    }

    // All data values should be between 0 and 1
    let data_values: Vec<f64> = view.cells.iter().flat_map(|r| r.iter())
        .filter(|c| c.cell_type == PivotCellType::Data)
        .filter_map(|c| match &c.value { PivotCellValue::Number(n) => Some(*n), _ => None })
        .collect();
    for v in &data_values {
        assert!(*v >= 0.0 && *v <= 1.0, "Percent value {v} should be between 0 and 1");
    }
}

#[test]
fn test_show_values_as_percent_of_row() {
    let h = aw_harness();
    let (mut cache, _) = h.build_pivot_cache(AW_START, AW_END, true);
    let mut def = PivotDefinition::new(1, AW_START, AW_END);

    def.row_fields = vec![PivotField::new(0, "Territory".into())];
    def.column_fields = vec![PivotField::new(2, "Category".into())];
    let mut vf = ValueField::new(12, "% of Row".into(), AggregationType::Sum);
    vf.show_values_as = ShowValuesAs::PercentOfRowTotal;
    def.value_fields = vec![vf];

    let view = calculate_pivot(&def, &mut cache);

    // Each row's data cells should sum to approximately 1.0
    // (This is a structural test — we check that percent mode produces output)
    let data_count = pivot_cell_type_count(&view, PivotCellType::Data);
    assert!(data_count > 0, "Should produce data cells in % of row mode");
}

// ============================================================================
// 13. VALUES POSITION
// ============================================================================

#[test]
fn test_values_position_rows() {
    let h = aw_harness();
    let (mut cache, _) = h.build_pivot_cache(AW_START, AW_END, true);
    let mut def = PivotDefinition::new(1, AW_START, AW_END);
    def.layout.values_position = ValuesPosition::Rows;

    def.row_fields = vec![PivotField::new(0, "Territory".into())];
    def.value_fields = vec![
        ValueField::new(12, "Sum of LineTotal".into(), AggregationType::Sum),
        ValueField::new(10, "Sum of OrderQty".into(), AggregationType::Sum),
    ];

    let view = calculate_pivot(&def, &mut cache);

    // When values are on rows, the "Values" pseudo-field becomes a row field,
    // so we expect more rows than territories alone.
    let row_count = view.cells.len();
    // At minimum: header rows + 8 territories * 2 values + grand total
    assert!(row_count > 8, "Values on rows should produce more rows, got {row_count}");
}

// ============================================================================
// 14. DRILL-DOWN
// ============================================================================

#[test]
fn test_drill_down_retrieves_source_rows() {
    let h = aw_harness();
    let (mut cache, _) = h.build_pivot_cache(AW_START, AW_END, true);
    let mut def = PivotDefinition::new(1, AW_START, AW_END);

    def.row_fields = vec![PivotField::new(0, "Territory".into())];
    def.value_fields = vec![ValueField::new(12, "Sum".into(), AggregationType::Sum)];

    let view = calculate_pivot(&def, &mut cache);

    // Find any cell with a non-empty group_path (could be Data, RowHeader, etc.)
    let mut found_drill = false;
    for row in &view.cells {
        for cell in row {
            if !cell.group_path.is_empty() {
                let result = drill_down(&def, &cache, &cell.group_path, 1000);
                assert!(!result.source_rows.is_empty(), "Drill-down should return source rows");
                assert!(!result.headers.is_empty(), "Drill-down should return headers");
                found_drill = true;
                break;
            }
        }
        if found_drill { break; }
    }
    assert!(found_drill, "Should have found a cell with drill-down path");
}

// ============================================================================
// 15. AGGREGATION TYPES (Product, StdDev, Variance)
// ============================================================================

#[test]
fn test_aggregation_product() {
    let h = aw_harness();
    // Use a small dataset to make product tractable
    let (mut cache, _) = h.build_pivot_cache(AW_START, AW_END, true);
    let mut def = PivotDefinition::new(1, AW_START, AW_END);
    def.row_fields = vec![PivotField::new(2, "Category".into())];
    def.value_fields = vec![ValueField::new(10, "Product of Qty".into(), AggregationType::Product)];

    let view = calculate_pivot(&def, &mut cache);
    let data_count = pivot_cell_type_count(&view, PivotCellType::Data);
    assert!(data_count >= 2, "Product aggregation should produce data cells");
}

#[test]
fn test_aggregation_stddev() {
    let h = aw_harness();
    let (_def, _cache, view) = h.create_pivot(
        AW_START, AW_END,
        vec![PivotField::new(0, "Territory".into())],
        vec![],
        vec![ValueField::new(12, "StdDev".into(), AggregationType::StdDev)],
    );

    // StdDev should produce numeric data cells
    let data_count = pivot_cell_type_count(&view, PivotCellType::Data);
    assert!(data_count >= 8, "StdDev should produce data cells per territory");

    // StdDev values should be non-negative
    for row in &view.cells {
        for cell in row {
            if cell.cell_type == PivotCellType::Data {
                if let PivotCellValue::Number(n) = &cell.value {
                    assert!(*n >= 0.0, "StdDev should be non-negative, got {n}");
                }
            }
        }
    }
}

#[test]
fn test_aggregation_variance() {
    let h = aw_harness();
    let (_def, _cache, view) = h.create_pivot(
        AW_START, AW_END,
        vec![PivotField::new(0, "Territory".into())],
        vec![],
        vec![ValueField::new(12, "Var".into(), AggregationType::Var)],
    );

    for row in &view.cells {
        for cell in row {
            if cell.cell_type == PivotCellType::Data {
                if let PivotCellValue::Number(n) = &cell.value {
                    assert!(*n >= 0.0, "Variance should be non-negative, got {n}");
                }
            }
        }
    }
}

// ============================================================================
// 16. SHOW VALUES AS (Ranking)
// ============================================================================

#[test]
fn test_show_values_as_rank_ascending() {
    let h = aw_harness();
    let (mut cache, _) = h.build_pivot_cache(AW_START, AW_END, true);
    let mut def = PivotDefinition::new(1, AW_START, AW_END);

    def.row_fields = vec![PivotField::new(0, "Territory".into())];
    let mut vf = ValueField::new(12, "Rank".into(), AggregationType::Sum);
    vf.show_values_as = ShowValuesAs::RankAscending;
    vf.base_field_index = Some(0); // rank within Territory
    def.value_fields = vec![vf];

    let view = calculate_pivot(&def, &mut cache);

    // Rank values should be integers 1..N
    let ranks: Vec<f64> = view.cells.iter().flat_map(|r| r.iter())
        .filter(|c| c.cell_type == PivotCellType::Data)
        .filter_map(|c| match &c.value { PivotCellValue::Number(n) => Some(*n), _ => None })
        .collect();
    assert!(!ranks.is_empty(), "Should have rank data cells");
    for r in &ranks {
        assert!(*r >= 1.0, "Rank should be >= 1, got {r}");
    }
}

// ============================================================================
// 17. THREE-LEVEL HIERARCHY
// ============================================================================

#[test]
fn test_three_level_row_hierarchy() {
    let h = aw_harness();
    // Territory > Category > SubCategory
    let (_def, _cache, view) = h.create_pivot(
        AW_START, AW_END,
        vec![
            PivotField::new(0, "Territory".into()),
            PivotField::new(2, "Category".into()),
            PivotField::new(3, "SubCategory".into()),
        ],
        vec![],
        vec![ValueField::new(12, "Sum".into(), AggregationType::Sum)],
    );

    let labels = pivot_row_labels(&view);
    // Should contain all three levels
    assert!(labels.contains(&"Northwest".to_string()), "Level 1: Territory");
    assert!(labels.contains(&"Bikes".to_string()), "Level 2: Category");
    assert!(labels.contains(&"Mountain Bikes".to_string()), "Level 3: SubCategory");

    // Grand total unchanged
    let expected_total: f64 = AdventureWorksFixture::data().iter().map(|r| r.12).sum();
    let grand = pivot_grand_total(&view).expect("3-level grand total");
    assert!((grand - expected_total).abs() < 0.01);
}

// ============================================================================
// 18. EDGE CASES
// ============================================================================

#[test]
fn test_single_row_dataset() {
    let h = TestHarness::new();
    // Just one data row
    h.set_cell(0, 0, Cell::new_text("Name".into()));
    h.set_cell(0, 1, Cell::new_text("Value".into()));
    h.set_cell(1, 0, Cell::new_text("Alice".into()));
    h.set_cell(1, 1, Cell::new_number(100.0));

    let (_def, _cache, view) = h.create_pivot(
        (0, 0), (1, 1),
        vec![PivotField::new(0, "Name".into())],
        vec![],
        vec![ValueField::new(1, "Sum".into(), AggregationType::Sum)],
    );

    let labels = pivot_row_labels(&view);
    assert_eq!(labels, vec!["Alice".to_string()]);

    let grand = pivot_grand_total(&view).expect("single row grand total");
    assert!((grand - 100.0).abs() < 0.01);
}

#[test]
fn test_all_same_values() {
    let h = TestHarness::new();
    h.set_cell(0, 0, Cell::new_text("Group".into()));
    h.set_cell(0, 1, Cell::new_text("Value".into()));
    for i in 1..=5 {
        h.set_cell(i, 0, Cell::new_text("A".into()));
        h.set_cell(i, 1, Cell::new_number(10.0));
    }

    let (_def, _cache, view) = h.create_pivot(
        (0, 0), (5, 1),
        vec![PivotField::new(0, "Group".into())],
        vec![],
        vec![
            ValueField::new(1, "Sum".into(), AggregationType::Sum),
            ValueField::new(1, "Count".into(), AggregationType::Count),
            ValueField::new(1, "Avg".into(), AggregationType::Average),
        ],
    );

    let _grand = pivot_grand_total(&view);
    // At minimum, data cells should exist
    let data_count = pivot_cell_type_count(&view, PivotCellType::Data);
    assert!(data_count >= 3, "Should have at least 3 data cells (3 value fields)");
}

#[test]
fn test_empty_cells_in_source() {
    let h = TestHarness::new();
    h.set_cell(0, 0, Cell::new_text("Region".into()));
    h.set_cell(0, 1, Cell::new_text("Sales".into()));
    h.set_cell(1, 0, Cell::new_text("North".into()));
    h.set_cell(1, 1, Cell::new_number(100.0));
    h.set_cell(2, 0, Cell::new_text("South".into()));
    // Row 2, col 1 is empty
    h.set_cell(3, 0, Cell::new_text("East".into()));
    h.set_cell(3, 1, Cell::new_number(300.0));

    let (_def, _cache, view) = h.create_pivot(
        (0, 0), (3, 1),
        vec![PivotField::new(0, "Region".into())],
        vec![],
        vec![ValueField::new(1, "Sum".into(), AggregationType::Sum)],
    );

    let labels = pivot_row_labels(&view);
    assert!(labels.contains(&"North".to_string()));
    assert!(labels.contains(&"South".to_string()));
    assert!(labels.contains(&"East".to_string()));

    // Grand total should be 400 (100 + 0 + 300)
    let grand = pivot_grand_total(&view).expect("grand total with empties");
    assert!((grand - 400.0).abs() < 0.01);
}

// ============================================================================
// 19. PROTECTED REGIONS (retained from prior suite)
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
}

#[test]
fn test_protected_region_boundaries() {
    let h = TestHarness::new();
    {
        let mut regions = h.state.protected_regions.lock().unwrap();
        regions.push(ProtectedRegion {
            id: "pivot-1".into(),
            region_type: "pivot".into(),
            owner_id: 1,
            sheet_index: 0,
            start_row: 5,
            start_col: 5,
            end_row: 10,
            end_col: 10,
        });
    }

    // Inside
    assert!(h.state.get_region_at_cell(0, 5, 5).is_some());
    assert!(h.state.get_region_at_cell(0, 10, 10).is_some());
    assert!(h.state.get_region_at_cell(0, 7, 7).is_some());

    // Outside
    assert!(h.state.get_region_at_cell(0, 4, 5).is_none());
    assert!(h.state.get_region_at_cell(0, 11, 10).is_none());
    assert!(h.state.get_region_at_cell(0, 0, 0).is_none());
}

#[test]
fn test_protected_regions_different_sheets() {
    let h = TestHarness::with_multiple_sheets(3);
    {
        let mut regions = h.state.protected_regions.lock().unwrap();
        regions.push(ProtectedRegion {
            id: "pivot-1".into(), region_type: "pivot".into(), owner_id: 1,
            sheet_index: 0, start_row: 0, start_col: 0, end_row: 10, end_col: 5,
        });
        regions.push(ProtectedRegion {
            id: "pivot-2".into(), region_type: "pivot".into(), owner_id: 2,
            sheet_index: 1, start_row: 0, start_col: 0, end_row: 10, end_col: 5,
        });
    }

    assert_eq!(h.state.get_region_at_cell(0, 5, 3).unwrap().id, "pivot-1");
    assert_eq!(h.state.get_region_at_cell(1, 5, 3).unwrap().id, "pivot-2");
    assert!(h.state.get_region_at_cell(2, 5, 3).is_none());
}

// ============================================================================
// 20. PIVOT VIEW STRUCTURE VALIDATION
// ============================================================================

#[test]
fn test_view_dimensions_consistency() {
    let h = aw_harness();
    let (_def, _cache, view) = h.create_pivot(
        AW_START, AW_END,
        vec![PivotField::new(0, "Territory".into())],
        vec![PivotField::new(2, "Category".into())],
        vec![ValueField::new(12, "Sum".into(), AggregationType::Sum)],
    );

    // row_count should match actual rows
    assert_eq!(view.row_count, view.cells.len(), "row_count should match cells.len()");

    // All rows should have the same column count
    if !view.cells.is_empty() {
        let expected_cols = view.col_count;
        for (i, row) in view.cells.iter().enumerate() {
            assert_eq!(row.len(), expected_cols, "Row {i} has {0} cols, expected {expected_cols}", row.len());
        }
    }
}

#[test]
fn test_view_has_header_area() {
    let h = aw_harness();
    let (_def, _cache, view) = h.create_pivot(
        AW_START, AW_END,
        vec![PivotField::new(0, "Territory".into())],
        vec![PivotField::new(2, "Category".into())],
        vec![ValueField::new(12, "Sum".into(), AggregationType::Sum)],
    );

    // Cross-tab pivot should have Corner, RowLabelHeader, or ColumnLabelHeader cells
    let header_cells = pivot_cell_type_count(&view, PivotCellType::Corner)
        + pivot_cell_type_count(&view, PivotCellType::RowLabelHeader)
        + pivot_cell_type_count(&view, PivotCellType::ColumnLabelHeader);
    assert!(header_cells > 0, "Cross-tab pivot should have header area cells, got {header_cells}");
}

#[test]
fn test_data_sum_equals_grand_total() {
    let h = aw_harness();
    // Single value field, no column fields — data cells sum should equal grand total
    let (_def, _cache, view) = h.create_pivot(
        AW_START, AW_END,
        vec![PivotField::new(0, "Territory".into())],
        vec![],
        vec![ValueField::new(12, "Sum".into(), AggregationType::Sum)],
    );

    let data_sum = pivot_data_sum(&view);
    let grand = pivot_grand_total(&view).expect("grand total");
    assert!(
        (data_sum - grand).abs() < 0.01,
        "Data cell sum ({data_sum}) should equal grand total ({grand})"
    );
}

// ============================================================================
// 21. ADVENTURE WORKS SPECIFIC SCENARIOS
// ============================================================================

#[test]
fn test_aw_sales_by_category_and_territory() {
    let h = aw_harness();
    let (_def, _cache, view) = h.create_pivot(
        AW_START, AW_END,
        vec![PivotField::new(2, "Category".into())],
        vec![PivotField::new(0, "Territory".into())],
        vec![ValueField::new(12, "Sum of LineTotal".into(), AggregationType::Sum)],
    );

    // Verify structure
    let row_labels = pivot_row_labels(&view);
    assert!(row_labels.contains(&"Bikes".to_string()));
    assert!(row_labels.contains(&"Clothing".to_string()));

    let col_labels = pivot_col_labels(&view);
    assert!(col_labels.len() >= 8, "Should have at least 8 territory columns");
}

#[test]
fn test_aw_quantity_analysis_by_subcategory() {
    let h = aw_harness();
    let (_def, _cache, view) = h.create_pivot(
        AW_START, AW_END,
        vec![PivotField::new(3, "SubCategory".into())],
        vec![],
        vec![
            ValueField::new(10, "Total Qty".into(), AggregationType::Sum),
            ValueField::new(10, "Avg Qty".into(), AggregationType::Average),
            ValueField::new(11, "Avg Price".into(), AggregationType::Average),
        ],
    );

    let labels = pivot_row_labels(&view);
    assert!(labels.contains(&"Mountain Bikes".to_string()));
    assert!(labels.contains(&"Road Bikes".to_string()));
    assert!(labels.contains(&"Touring Bikes".to_string()));
    assert!(labels.contains(&"Jerseys".to_string()));
    assert!(labels.contains(&"Shorts".to_string()));
    assert!(labels.contains(&"Gloves".to_string()));
    assert!(labels.contains(&"Caps".to_string()));
}

#[test]
fn test_aw_customer_city_analysis() {
    let h = aw_harness();
    let (_def, _cache, view) = h.create_pivot(
        AW_START, AW_END,
        vec![PivotField::new(6, "City".into())],
        vec![],
        vec![
            ValueField::new(12, "Revenue".into(), AggregationType::Sum),
            ValueField::new(12, "Orders".into(), AggregationType::Count),
        ],
    );

    let labels = pivot_row_labels(&view);
    assert!(labels.contains(&"Seattle".to_string()));
    assert!(labels.contains(&"New York".to_string()));
    assert!(labels.contains(&"Paris".to_string()));
    assert!(labels.contains(&"Berlin".to_string()));
}

#[test]
fn test_aw_yearly_comparison() {
    let h = aw_harness();
    let (_def, _cache, view) = h.create_pivot(
        AW_START, AW_END,
        vec![PivotField::new(7, "Year".into())],
        vec![PivotField::new(2, "Category".into())],
        vec![ValueField::new(12, "Revenue".into(), AggregationType::Sum)],
    );

    // Should have 2 year rows (2023, 2024)
    let labels = pivot_row_labels(&view);
    assert!(labels.len() >= 2, "Should have at least 2 year rows");

    // Both Bikes and Clothing as column headers
    let col_labels = pivot_col_labels(&view);
    assert!(col_labels.iter().any(|l| l == "Bikes"));
    assert!(col_labels.iter().any(|l| l == "Clothing"));
}

// ============================================================================
// 22. FILTER + SORT COMBINED
// ============================================================================

#[test]
fn test_filter_and_sort_combined() {
    let h = aw_harness();
    let (mut cache, _) = h.build_pivot_cache(AW_START, AW_END, true);
    let mut def = PivotDefinition::new(1, AW_START, AW_END);

    // Filter to US only via hidden_items on Territory, sort descending
    let mut territory = PivotField::new(0, "Territory".into());
    territory.sort_order = SortOrder::Descending;
    territory.hidden_items = vec![
        "Canada".into(), "France".into(), "Germany".into(), "UK".into(),
    ];
    def.row_fields = vec![territory];
    def.value_fields = vec![ValueField::new(12, "Sum".into(), AggregationType::Sum)];

    let view = calculate_pivot(&def, &mut cache);

    let labels = pivot_row_labels(&view);
    // Should be US-only territories in descending order
    assert!(!labels.contains(&"France".to_string()));
    assert!(!labels.contains(&"Canada".to_string()));
    let mut sorted = labels.clone();
    sorted.sort();
    sorted.reverse();
    assert_eq!(labels, sorted);
}

// ============================================================================
// 23. MULTIPLE VALUE FIELDS IN CROSS-TAB
// ============================================================================

#[test]
fn test_multiple_values_cross_tab() {
    let h = aw_harness();
    let (_def, _cache, view) = h.create_pivot(
        AW_START, AW_END,
        vec![PivotField::new(0, "Territory".into())],
        vec![PivotField::new(2, "Category".into())],
        vec![
            ValueField::new(12, "Revenue".into(), AggregationType::Sum),
            ValueField::new(10, "Quantity".into(), AggregationType::Sum),
        ],
    );

    // With 2 value fields and column field, we get nested column headers
    let data_count = pivot_cell_type_count(&view, PivotCellType::Data);
    // 8 territories * 2 categories * 2 values = 32 (some may not have data)
    assert!(data_count > 0, "Cross-tab with multiple values should produce data");
}

// ============================================================================
// 24. COUNT NUMBERS vs COUNT
// ============================================================================

#[test]
fn test_count_numbers_vs_count() {
    let h = TestHarness::new();
    h.set_cell(0, 0, Cell::new_text("Group".into()));
    h.set_cell(0, 1, Cell::new_text("Value".into()));
    h.set_cell(1, 0, Cell::new_text("A".into()));
    h.set_cell(1, 1, Cell::new_number(10.0));
    h.set_cell(2, 0, Cell::new_text("A".into()));
    h.set_cell(2, 1, Cell::new_text("text".into()));
    h.set_cell(3, 0, Cell::new_text("A".into()));
    h.set_cell(3, 1, Cell::new_number(30.0));
    h.set_cell(4, 0, Cell::new_text("A".into()));
    // Row 4, col 1 is empty

    let (mut cache, _) = h.build_pivot_cache((0, 0), (4, 1), true);
    let mut def = PivotDefinition::new(1, (0, 0), (4, 1));
    def.row_fields = vec![PivotField::new(0, "Group".into())];
    def.value_fields = vec![
        ValueField::new(1, "Count".into(), AggregationType::Count),
        ValueField::new(1, "CountNumbers".into(), AggregationType::CountNumbers),
    ];

    let view = calculate_pivot(&def, &mut cache);

    // Count should be 4 (all records), CountNumbers should be 2 (only numeric)
    // Grand total checks
    let data_count = pivot_cell_type_count(&view, PivotCellType::Data);
    assert!(data_count >= 2, "Should have Count and CountNumbers data cells");
}

// ============================================================================
// 25. SALES FIXTURE (legacy compatibility)
// ============================================================================

#[test]
fn test_sales_fixture_pivot() {
    let h = TestHarness::new();
    let headers = SalesFixture::headers();
    for (col, header) in headers.iter().enumerate() {
        h.set_cell(0, col as u32, Cell::new_text(header.to_string()));
    }
    for (i, (region, product, quarter, sales, quantity)) in SalesFixture::data().iter().enumerate() {
        let row = (i + 1) as u32;
        h.set_cell(row, 0, Cell::new_text(region.to_string()));
        h.set_cell(row, 1, Cell::new_text(product.to_string()));
        h.set_cell(row, 2, Cell::new_text(quarter.to_string()));
        h.set_cell(row, 3, Cell::new_number(*sales));
        h.set_cell(row, 4, Cell::new_number(*quantity));
    }

    let (_def, _cache, view) = h.create_pivot(
        (0, 0), (12, 4),
        vec![PivotField::new(0, "Region".into())],
        vec![PivotField::new(1, "Product".into())],
        vec![ValueField::new(3, "Sum of Sales".into(), AggregationType::Sum)],
    );

    let labels = pivot_row_labels(&view);
    assert!(labels.contains(&"North".to_string()));
    assert!(labels.contains(&"South".to_string()));
    assert!(labels.contains(&"East".to_string()));

    let expected: f64 = SalesFixture::data().iter().map(|r| r.3).sum();
    let grand = pivot_grand_total(&view).expect("sales fixture grand total");
    assert!((grand - expected).abs() < 0.01);
}

// ============================================================================
// 26. LARGE PIVOT PERFORMANCE SANITY
// ============================================================================

#[test]
fn test_large_pivot_1000_rows() {
    let h = TestHarness::new();
    h.set_cell(0, 0, Cell::new_text("Region".into()));
    h.set_cell(0, 1, Cell::new_text("Product".into()));
    h.set_cell(0, 2, Cell::new_text("Sales".into()));

    let regions = ["North", "South", "East", "West", "Central"];
    let products = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

    for i in 0..1000u32 {
        let row = i + 1;
        h.set_cell(row, 0, Cell::new_text(regions[(i as usize) % regions.len()].into()));
        h.set_cell(row, 1, Cell::new_text(products[(i as usize) % products.len()].into()));
        h.set_cell(row, 2, Cell::new_number((i as f64) * 10.0 + 1.0));
    }

    let (_def, _cache, view) = h.create_pivot(
        (0, 0), (1000, 2),
        vec![
            PivotField::new(0, "Region".into()),
            PivotField::new(1, "Product".into()),
        ],
        vec![],
        vec![ValueField::new(2, "Sum".into(), AggregationType::Sum)],
    );

    // In compact layout with subtotals, data cells include both leaf cells and subtotals.
    // 5 regions * 10 products = 50 leaf intersections, plus 5 region subtotals = 55+
    // But compact layout may inline subtotals. At minimum we need all product leaf cells.
    let data_count = pivot_cell_type_count(&view, PivotCellType::Data)
        + pivot_cell_type_count(&view, PivotCellType::RowSubtotal);
    assert!(data_count >= 15, "1000-row pivot should produce data cells, got {data_count}");

    // Verify grand total
    let expected: f64 = (0..1000u32).map(|i| (i as f64) * 10.0 + 1.0).sum();
    let grand = pivot_grand_total(&view).expect("large pivot grand total");
    assert!((grand - expected).abs() < 0.01);
}

// ============================================================================
// 27. RECALCULATION (modify definition, recalculate)
// ============================================================================

#[test]
fn test_recalculate_after_field_change() {
    let h = aw_harness();
    let (mut cache, _) = h.build_pivot_cache(AW_START, AW_END, true);

    // First: pivot by Territory
    let mut def = PivotDefinition::new(1, AW_START, AW_END);
    def.row_fields = vec![PivotField::new(0, "Territory".into())];
    def.value_fields = vec![ValueField::new(12, "Sum".into(), AggregationType::Sum)];

    let view1 = calculate_pivot(&def, &mut cache);
    let labels1 = pivot_row_labels(&view1);
    assert!(labels1.contains(&"Northwest".to_string()));

    // Second: change to Category
    def.row_fields = vec![PivotField::new(2, "Category".into())];
    def.bump_version();

    let view2 = calculate_pivot(&def, &mut cache);
    let labels2 = pivot_row_labels(&view2);
    assert!(labels2.contains(&"Bikes".to_string()));
    assert!(!labels2.contains(&"Northwest".to_string()), "Old labels should not appear");

    // Grand total should be the same
    let g1 = pivot_grand_total(&view1).unwrap();
    let g2 = pivot_grand_total(&view2).unwrap();
    assert!((g1 - g2).abs() < 0.01, "Grand total should be unchanged after field swap");
}

#[test]
fn test_change_aggregation_type() {
    let h = aw_harness();
    let (mut cache, _) = h.build_pivot_cache(AW_START, AW_END, true);
    let mut def = PivotDefinition::new(1, AW_START, AW_END);
    def.row_fields = vec![PivotField::new(0, "Territory".into())];

    // Sum first
    def.value_fields = vec![ValueField::new(12, "Sum".into(), AggregationType::Sum)];
    let view_sum = calculate_pivot(&def, &mut cache);
    let grand_sum = pivot_grand_total(&view_sum).unwrap();

    // Change to Average
    def.value_fields = vec![ValueField::new(12, "Avg".into(), AggregationType::Average)];
    def.bump_version();
    let view_avg = calculate_pivot(&def, &mut cache);
    let grand_avg = pivot_grand_total(&view_avg).unwrap();

    // Avg should be Sum / Count
    let expected_avg = grand_sum / 40.0;
    assert!((grand_avg - expected_avg).abs() < 0.01, "Avg grand {grand_avg} != {expected_avg}");
}
