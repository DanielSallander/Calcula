//! FILENAME: app/src-tauri/tests/test_tables.rs
//! PURPOSE: Tests for table (structured references) functionality.

mod common;

use app_lib::{
    TotalsRowFunction, TableStyleOptions, TableColumn, Table,
    TableStorage, TableNameRegistry, TableResult, ResolvedStructuredRef,
    StructuredRefResult,
};
use std::collections::HashMap;

// ============================================================================
// UNIT TESTS - TotalsRowFunction
// ============================================================================

#[test]
fn test_totals_row_function_default() {
    assert_eq!(TotalsRowFunction::default(), TotalsRowFunction::None);
}

#[test]
fn test_totals_row_function_variants() {
    let funcs = vec![
        TotalsRowFunction::None,
        TotalsRowFunction::Average,
        TotalsRowFunction::Count,
        TotalsRowFunction::CountNumbers,
        TotalsRowFunction::Max,
        TotalsRowFunction::Min,
        TotalsRowFunction::Sum,
        TotalsRowFunction::StdDev,
        TotalsRowFunction::Var,
        TotalsRowFunction::Custom,
    ];
    assert_eq!(funcs.len(), 10);
}

// ============================================================================
// UNIT TESTS - TableStyleOptions
// ============================================================================

#[test]
fn test_table_style_options_default() {
    let options = TableStyleOptions::default();

    assert!(options.banded_rows);
    assert!(!options.banded_columns);
    assert!(options.header_row);
    assert!(!options.total_row);
    assert!(!options.first_column);
    assert!(!options.last_column);
    assert!(options.show_filter_button);
}

#[test]
fn test_table_style_options_custom() {
    let options = TableStyleOptions {
        banded_rows: false,
        banded_columns: true,
        header_row: true,
        total_row: true,
        first_column: true,
        last_column: true,
        show_filter_button: false,
    };

    assert!(!options.banded_rows);
    assert!(options.banded_columns);
    assert!(options.total_row);
    assert!(options.first_column);
    assert!(!options.show_filter_button);
}

// ============================================================================
// UNIT TESTS - TableColumn
// ============================================================================

#[test]
fn test_table_column_new() {
    let col = TableColumn::new(1, "Sales".to_string());

    assert_eq!(col.id, 1);
    assert_eq!(col.name, "Sales");
    assert_eq!(col.totals_row_function, TotalsRowFunction::None);
    assert!(col.totals_row_formula.is_none());
    assert!(col.calculated_formula.is_none());
}

#[test]
fn test_table_column_with_formula() {
    let mut col = TableColumn::new(1, "Total".to_string());
    col.totals_row_function = TotalsRowFunction::Custom;
    col.totals_row_formula = Some("=SUBTOTAL(109,[Amount])".to_string());

    assert_eq!(col.totals_row_function, TotalsRowFunction::Custom);
    assert!(col.totals_row_formula.is_some());
}

// ============================================================================
// UNIT TESTS - Table
// ============================================================================

#[test]
fn test_table_creation() {
    let table = Table {
        id: 1,
        name: "SalesData".to_string(),
        sheet_index: 0,
        start_row: 0,
        start_col: 0,
        end_row: 10,
        end_col: 5,
        columns: vec![
            TableColumn::new(0, "Date".to_string()),
            TableColumn::new(1, "Product".to_string()),
            TableColumn::new(2, "Amount".to_string()),
        ],
        style_options: TableStyleOptions::default(),
        style_name: "TableStyleMedium2".to_string(),
        auto_filter_id: None,
    };

    assert_eq!(table.id, 1);
    assert_eq!(table.name, "SalesData");
    assert_eq!(table.columns.len(), 3);
}

#[test]
fn test_table_contains() {
    let table = Table {
        id: 1,
        name: "Table1".to_string(),
        sheet_index: 0,
        start_row: 5,
        start_col: 2,
        end_row: 15,
        end_col: 8,
        columns: vec![],
        style_options: TableStyleOptions::default(),
        style_name: "TableStyleMedium2".to_string(),
        auto_filter_id: None,
    };

    // Corners
    assert!(table.contains(5, 2));
    assert!(table.contains(5, 8));
    assert!(table.contains(15, 2));
    assert!(table.contains(15, 8));

    // Inside
    assert!(table.contains(10, 5));

    // Outside
    assert!(!table.contains(4, 2));
    assert!(!table.contains(5, 1));
    assert!(!table.contains(16, 5));
    assert!(!table.contains(10, 9));
}

#[test]
fn test_table_data_rows_with_header() {
    let table = Table {
        id: 1,
        name: "Table1".to_string(),
        sheet_index: 0,
        start_row: 0,
        start_col: 0,
        end_row: 10,
        end_col: 5,
        columns: vec![],
        style_options: TableStyleOptions {
            header_row: true,
            total_row: false,
            ..Default::default()
        },
        style_name: "TableStyleMedium2".to_string(),
        auto_filter_id: None,
    };

    assert_eq!(table.data_start_row(), 1);
    assert_eq!(table.data_end_row(), 10);
    assert_eq!(table.row_count(), 10);
}

#[test]
fn test_table_data_rows_with_header_and_totals() {
    let table = Table {
        id: 1,
        name: "Table1".to_string(),
        sheet_index: 0,
        start_row: 0,
        start_col: 0,
        end_row: 10,
        end_col: 5,
        columns: vec![],
        style_options: TableStyleOptions {
            header_row: true,
            total_row: true,
            ..Default::default()
        },
        style_name: "TableStyleMedium2".to_string(),
        auto_filter_id: None,
    };

    assert_eq!(table.data_start_row(), 1);
    assert_eq!(table.data_end_row(), 9);
    assert_eq!(table.row_count(), 9);
}

#[test]
fn test_table_data_rows_no_header() {
    let table = Table {
        id: 1,
        name: "Table1".to_string(),
        sheet_index: 0,
        start_row: 0,
        start_col: 0,
        end_row: 10,
        end_col: 5,
        columns: vec![],
        style_options: TableStyleOptions {
            header_row: false,
            total_row: false,
            ..Default::default()
        },
        style_name: "TableStyleMedium2".to_string(),
        auto_filter_id: None,
    };

    assert_eq!(table.data_start_row(), 0);
    assert_eq!(table.data_end_row(), 10);
    assert_eq!(table.row_count(), 11);
}

#[test]
fn test_table_is_header() {
    let table = Table {
        id: 1,
        name: "Table1".to_string(),
        sheet_index: 0,
        start_row: 5,
        start_col: 0,
        end_row: 15,
        end_col: 5,
        columns: vec![],
        style_options: TableStyleOptions::default(),
        style_name: "TableStyleMedium2".to_string(),
        auto_filter_id: None,
    };

    assert!(table.is_header(5));
    assert!(!table.is_header(6));
    assert!(!table.is_header(15));
}

#[test]
fn test_table_is_totals() {
    let table = Table {
        id: 1,
        name: "Table1".to_string(),
        sheet_index: 0,
        start_row: 5,
        start_col: 0,
        end_row: 15,
        end_col: 5,
        columns: vec![],
        style_options: TableStyleOptions {
            total_row: true,
            ..Default::default()
        },
        style_name: "TableStyleMedium2".to_string(),
        auto_filter_id: None,
    };

    assert!(!table.is_totals(5));
    assert!(table.is_totals(15));
    assert!(!table.is_totals(10));
}

#[test]
fn test_table_column_count() {
    let table = Table {
        id: 1,
        name: "Table1".to_string(),
        sheet_index: 0,
        start_row: 0,
        start_col: 2,
        end_row: 10,
        end_col: 7,
        columns: vec![],
        style_options: TableStyleOptions::default(),
        style_name: "TableStyleMedium2".to_string(),
        auto_filter_id: None,
    };

    assert_eq!(table.column_count(), 6);
}

#[test]
fn test_table_get_column_by_name() {
    let table = Table {
        id: 1,
        name: "Table1".to_string(),
        sheet_index: 0,
        start_row: 0,
        start_col: 0,
        end_row: 10,
        end_col: 2,
        columns: vec![
            TableColumn::new(0, "Name".to_string()),
            TableColumn::new(1, "Amount".to_string()),
            TableColumn::new(2, "Total".to_string()),
        ],
        style_options: TableStyleOptions::default(),
        style_name: "TableStyleMedium2".to_string(),
        auto_filter_id: None,
    };

    assert!(table.get_column_by_name("Name").is_some());
    assert!(table.get_column_by_name("name").is_some()); // Case insensitive
    assert!(table.get_column_by_name("AMOUNT").is_some());
    assert!(table.get_column_by_name("Missing").is_none());
}

#[test]
fn test_table_get_column_index() {
    let table = Table {
        id: 1,
        name: "Table1".to_string(),
        sheet_index: 0,
        start_row: 0,
        start_col: 0,
        end_row: 10,
        end_col: 2,
        columns: vec![
            TableColumn::new(0, "Name".to_string()),
            TableColumn::new(1, "Amount".to_string()),
            TableColumn::new(2, "Total".to_string()),
        ],
        style_options: TableStyleOptions::default(),
        style_name: "TableStyleMedium2".to_string(),
        auto_filter_id: None,
    };

    assert_eq!(table.get_column_index("Name"), Some(0));
    assert_eq!(table.get_column_index("Amount"), Some(1));
    assert_eq!(table.get_column_index("total"), Some(2)); // Case insensitive
    assert_eq!(table.get_column_index("Missing"), None);
}

// ============================================================================
// UNIT TESTS - Storage
// ============================================================================

#[test]
fn test_table_storage() {
    let mut storage: TableStorage = HashMap::new();

    // Add table to sheet 0
    let table1 = Table {
        id: 1,
        name: "Table1".to_string(),
        sheet_index: 0,
        start_row: 0,
        start_col: 0,
        end_row: 10,
        end_col: 5,
        columns: vec![],
        style_options: TableStyleOptions::default(),
        style_name: "TableStyleMedium2".to_string(),
        auto_filter_id: None,
    };
    storage.entry(0).or_insert_with(HashMap::new).insert(1, table1);

    // Add table to sheet 1
    let table2 = Table {
        id: 2,
        name: "Table2".to_string(),
        sheet_index: 1,
        start_row: 0,
        start_col: 0,
        end_row: 5,
        end_col: 3,
        columns: vec![],
        style_options: TableStyleOptions::default(),
        style_name: "TableStyleMedium2".to_string(),
        auto_filter_id: None,
    };
    storage.entry(1).or_insert_with(HashMap::new).insert(2, table2);

    assert_eq!(storage.len(), 2);
    assert!(storage.get(&0).unwrap().contains_key(&1));
    assert!(storage.get(&1).unwrap().contains_key(&2));
}

#[test]
fn test_table_name_registry() {
    let mut registry: TableNameRegistry = HashMap::new();

    registry.insert("TABLE1".to_string(), (0, 1));
    registry.insert("SALESDATA".to_string(), (0, 2));
    registry.insert("INVENTORY".to_string(), (1, 1));

    assert_eq!(registry.get("TABLE1"), Some(&(0, 1)));
    assert_eq!(registry.get("SALESDATA"), Some(&(0, 2)));
    assert_eq!(registry.get("INVENTORY"), Some(&(1, 1)));
    assert!(registry.get("NONEXISTENT").is_none());
}

// ============================================================================
// UNIT TESTS - JSON Serialization
// ============================================================================

#[test]
fn test_totals_row_function_serialization() {
    let func = TotalsRowFunction::Sum;
    let json = serde_json::to_string(&func).unwrap();
    assert_eq!(json, "\"sum\"");

    let func2 = TotalsRowFunction::CountNumbers;
    let json2 = serde_json::to_string(&func2).unwrap();
    assert_eq!(json2, "\"countNumbers\"");
}

#[test]
fn test_table_style_options_serialization() {
    let options = TableStyleOptions {
        banded_rows: true,
        banded_columns: false,
        header_row: true,
        total_row: true,
        first_column: false,
        last_column: false,
        show_filter_button: true,
    };

    let json = serde_json::to_string(&options).unwrap();

    // Should use camelCase
    assert!(json.contains("\"bandedRows\""));
    assert!(json.contains("\"bandedColumns\""));
    assert!(json.contains("\"headerRow\""));
    assert!(json.contains("\"totalRow\""));
    assert!(json.contains("\"showFilterButton\""));
    assert!(!json.contains("\"banded_rows\""));
}

#[test]
fn test_table_column_serialization() {
    let col = TableColumn::new(1, "Amount".to_string());
    let json = serde_json::to_string(&col).unwrap();

    assert!(json.contains("\"totalsRowFunction\""));
    assert!(!json.contains("\"totals_row_function\""));
}

#[test]
fn test_table_serialization() {
    let table = Table {
        id: 1,
        name: "Table1".to_string(),
        sheet_index: 0,
        start_row: 0,
        start_col: 0,
        end_row: 10,
        end_col: 5,
        columns: vec![TableColumn::new(0, "Name".to_string())],
        style_options: TableStyleOptions::default(),
        style_name: "TableStyleMedium2".to_string(),
        auto_filter_id: None,
    };

    let json = serde_json::to_string(&table).unwrap();

    // Should use camelCase
    assert!(json.contains("\"sheetIndex\""));
    assert!(json.contains("\"startRow\""));
    assert!(json.contains("\"endCol\""));
    assert!(json.contains("\"styleName\""));
    assert!(json.contains("\"styleOptions\""));
    assert!(!json.contains("\"sheet_index\""));
    assert!(!json.contains("\"start_row\""));
}

#[test]
fn test_table_result_serialization() {
    let result = TableResult {
        success: true,
        table: Some(Table {
            id: 1,
            name: "Table1".to_string(),
            sheet_index: 0,
            start_row: 0,
            start_col: 0,
            end_row: 10,
            end_col: 5,
            columns: vec![],
            style_options: TableStyleOptions::default(),
            style_name: "TableStyleMedium2".to_string(),
            auto_filter_id: None,
        }),
        error: None,
    };

    let json = serde_json::to_string(&result).unwrap();
    assert!(json.contains("\"success\":true"));
    assert!(json.contains("\"table\""));
    assert!(!json.contains("\"error\""));
}

// ============================================================================
// INTEGRATION TESTS - Using TestHarness
// ============================================================================

#[test]
fn test_add_and_get_table() {
    let harness = common::TestHarness::new();

    // Add a table
    {
        let mut tables = harness.state.tables.lock().unwrap();
        let mut names = harness.state.table_names.lock().unwrap();

        let table = Table {
            id: 1,
            name: "SalesData".to_string(),
            sheet_index: 0,
            start_row: 0,
            start_col: 0,
            end_row: 10,
            end_col: 5,
            columns: vec![
                TableColumn::new(0, "Product".to_string()),
                TableColumn::new(1, "Sales".to_string()),
            ],
            style_options: TableStyleOptions::default(),
            style_name: "TableStyleMedium2".to_string(),
            auto_filter_id: None,
        };

        names.insert("SALESDATA".to_string(), (0, 1));
        tables.entry(0).or_insert_with(HashMap::new).insert(1, table);
    }

    // Verify
    {
        let tables = harness.state.tables.lock().unwrap();
        let names = harness.state.table_names.lock().unwrap();

        assert!(names.contains_key("SALESDATA"));
        let table = tables.get(&0).unwrap().get(&1).unwrap();
        assert_eq!(table.name, "SalesData");
        assert_eq!(table.columns.len(), 2);
    }
}

#[test]
fn test_multiple_tables_same_sheet() {
    let harness = common::TestHarness::new();

    // Add multiple tables
    {
        let mut tables = harness.state.tables.lock().unwrap();
        let mut names = harness.state.table_names.lock().unwrap();
        let sheet_tables = tables.entry(0).or_insert_with(HashMap::new);

        sheet_tables.insert(1, Table {
            id: 1,
            name: "Table1".to_string(),
            sheet_index: 0,
            start_row: 0,
            start_col: 0,
            end_row: 5,
            end_col: 3,
            columns: vec![],
            style_options: TableStyleOptions::default(),
            style_name: "TableStyleMedium2".to_string(),
            auto_filter_id: None,
        });
        names.insert("TABLE1".to_string(), (0, 1));

        sheet_tables.insert(2, Table {
            id: 2,
            name: "Table2".to_string(),
            sheet_index: 0,
            start_row: 10,
            start_col: 0,
            end_row: 15,
            end_col: 3,
            columns: vec![],
            style_options: TableStyleOptions::default(),
            style_name: "TableStyleMedium2".to_string(),
            auto_filter_id: None,
        });
        names.insert("TABLE2".to_string(), (0, 2));
    }

    // Verify
    {
        let tables = harness.state.tables.lock().unwrap();
        assert_eq!(tables.get(&0).unwrap().len(), 2);
    }
}

#[test]
fn test_tables_across_sheets() {
    let harness = common::TestHarness::with_multiple_sheets(3);

    // Add tables to different sheets
    {
        let mut tables = harness.state.tables.lock().unwrap();
        let mut names = harness.state.table_names.lock().unwrap();

        for i in 0..3 {
            let table = Table {
                id: (i + 1) as u64,
                name: format!("Sheet{}Table", i + 1),
                sheet_index: i,
                start_row: 0,
                start_col: 0,
                end_row: 5,
                end_col: 3,
                columns: vec![],
                style_options: TableStyleOptions::default(),
                style_name: "TableStyleMedium2".to_string(),
                auto_filter_id: None,
            };

            names.insert(format!("SHEET{}TABLE", i + 1), (i, (i + 1) as u64));
            tables.entry(i).or_insert_with(HashMap::new).insert((i + 1) as u64, table);
        }
    }

    // Verify
    {
        let tables = harness.state.tables.lock().unwrap();
        let names = harness.state.table_names.lock().unwrap();

        assert_eq!(names.len(), 3);
        assert!(tables.get(&0).unwrap().contains_key(&1));
        assert!(tables.get(&1).unwrap().contains_key(&2));
        assert!(tables.get(&2).unwrap().contains_key(&3));
    }
}

#[test]
fn test_rename_table() {
    let harness = common::TestHarness::new();

    // Add a table
    {
        let mut tables = harness.state.tables.lock().unwrap();
        let mut names = harness.state.table_names.lock().unwrap();

        let table = Table {
            id: 1,
            name: "OldName".to_string(),
            sheet_index: 0,
            start_row: 0,
            start_col: 0,
            end_row: 5,
            end_col: 3,
            columns: vec![],
            style_options: TableStyleOptions::default(),
            style_name: "TableStyleMedium2".to_string(),
            auto_filter_id: None,
        };

        names.insert("OLDNAME".to_string(), (0, 1));
        tables.entry(0).or_insert_with(HashMap::new).insert(1, table);
    }

    // Rename
    {
        let mut tables = harness.state.tables.lock().unwrap();
        let mut names = harness.state.table_names.lock().unwrap();

        names.remove("OLDNAME");
        names.insert("NEWNAME".to_string(), (0, 1));

        let table = tables.get_mut(&0).unwrap().get_mut(&1).unwrap();
        table.name = "NewName".to_string();
    }

    // Verify
    {
        let tables = harness.state.tables.lock().unwrap();
        let names = harness.state.table_names.lock().unwrap();

        assert!(!names.contains_key("OLDNAME"));
        assert!(names.contains_key("NEWNAME"));
        assert_eq!(tables.get(&0).unwrap().get(&1).unwrap().name, "NewName");
    }
}

#[test]
fn test_delete_table() {
    let harness = common::TestHarness::new();

    // Add tables
    {
        let mut tables = harness.state.tables.lock().unwrap();
        let mut names = harness.state.table_names.lock().unwrap();
        let sheet_tables = tables.entry(0).or_insert_with(HashMap::new);

        sheet_tables.insert(1, Table {
            id: 1,
            name: "Table1".to_string(),
            sheet_index: 0,
            start_row: 0,
            start_col: 0,
            end_row: 5,
            end_col: 3,
            columns: vec![],
            style_options: TableStyleOptions::default(),
            style_name: "TableStyleMedium2".to_string(),
            auto_filter_id: None,
        });
        names.insert("TABLE1".to_string(), (0, 1));

        sheet_tables.insert(2, Table {
            id: 2,
            name: "Table2".to_string(),
            sheet_index: 0,
            start_row: 10,
            start_col: 0,
            end_row: 15,
            end_col: 3,
            columns: vec![],
            style_options: TableStyleOptions::default(),
            style_name: "TableStyleMedium2".to_string(),
            auto_filter_id: None,
        });
        names.insert("TABLE2".to_string(), (0, 2));
    }

    // Delete table 1
    {
        let mut tables = harness.state.tables.lock().unwrap();
        let mut names = harness.state.table_names.lock().unwrap();

        tables.get_mut(&0).unwrap().remove(&1);
        names.remove("TABLE1");
    }

    // Verify
    {
        let tables = harness.state.tables.lock().unwrap();
        let names = harness.state.table_names.lock().unwrap();

        assert!(!names.contains_key("TABLE1"));
        assert!(names.contains_key("TABLE2"));
        assert_eq!(tables.get(&0).unwrap().len(), 1);
    }
}

#[test]
fn test_toggle_totals_row() {
    let harness = common::TestHarness::new();

    // Add a table
    {
        let mut tables = harness.state.tables.lock().unwrap();
        let table = Table {
            id: 1,
            name: "Table1".to_string(),
            sheet_index: 0,
            start_row: 0,
            start_col: 0,
            end_row: 10,
            end_col: 5,
            columns: vec![],
            style_options: TableStyleOptions {
                total_row: false,
                ..Default::default()
            },
            style_name: "TableStyleMedium2".to_string(),
            auto_filter_id: None,
        };
        tables.entry(0).or_insert_with(HashMap::new).insert(1, table);
    }

    // Toggle totals row on
    {
        let mut tables = harness.state.tables.lock().unwrap();
        let table = tables.get_mut(&0).unwrap().get_mut(&1).unwrap();
        table.style_options.total_row = true;
        table.end_row += 1;
    }

    // Verify
    {
        let tables = harness.state.tables.lock().unwrap();
        let table = tables.get(&0).unwrap().get(&1).unwrap();
        assert!(table.style_options.total_row);
        assert_eq!(table.end_row, 11);
    }
}

#[test]
fn test_table_with_auto_filter() {
    let harness = common::TestHarness::new();

    // Add a table with auto filter
    {
        let mut tables = harness.state.tables.lock().unwrap();
        let table = Table {
            id: 1,
            name: "FilteredTable".to_string(),
            sheet_index: 0,
            start_row: 0,
            start_col: 0,
            end_row: 10,
            end_col: 5,
            columns: vec![],
            style_options: TableStyleOptions {
                show_filter_button: true,
                ..Default::default()
            },
            style_name: "TableStyleMedium2".to_string(),
            auto_filter_id: Some(42),
        };
        tables.entry(0).or_insert_with(HashMap::new).insert(1, table);
    }

    // Verify
    {
        let tables = harness.state.tables.lock().unwrap();
        let table = tables.get(&0).unwrap().get(&1).unwrap();
        assert!(table.style_options.show_filter_button);
        assert_eq!(table.auto_filter_id, Some(42));
    }
}
