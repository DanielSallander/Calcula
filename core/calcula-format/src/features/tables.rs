//! FILENAME: core/calcula-format/src/features/tables.rs
//! Table definitions serialization.
//! Each table is stored as tables/table_{id}.json.

use persistence::{SavedTable, SavedTableColumn, SavedTableStyleOptions};
use serde::{Deserialize, Serialize};

/// JSON-friendly table definition that uses camelCase for AI readability.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDef {
    pub id: u64,
    pub name: String,
    pub sheet_index: usize,
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
    pub columns: Vec<TableColumnDef>,
    pub style_options: TableStyleOptionsDef,
    pub style_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableColumnDef {
    pub id: u32,
    pub name: String,
    pub totals_row_function: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub totals_row_formula: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub calculated_formula: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableStyleOptionsDef {
    pub banded_rows: bool,
    pub banded_columns: bool,
    pub header_row: bool,
    pub total_row: bool,
    pub first_column: bool,
    pub last_column: bool,
    pub show_filter_button: bool,
}

impl From<&SavedTable> for TableDef {
    fn from(t: &SavedTable) -> Self {
        TableDef {
            id: t.id,
            name: t.name.clone(),
            sheet_index: t.sheet_index,
            start_row: t.start_row,
            start_col: t.start_col,
            end_row: t.end_row,
            end_col: t.end_col,
            columns: t.columns.iter().map(|c| TableColumnDef {
                id: c.id,
                name: c.name.clone(),
                totals_row_function: c.totals_row_function.clone(),
                totals_row_formula: c.totals_row_formula.clone(),
                calculated_formula: c.calculated_formula.clone(),
            }).collect(),
            style_options: TableStyleOptionsDef {
                banded_rows: t.style_options.banded_rows,
                banded_columns: t.style_options.banded_columns,
                header_row: t.style_options.header_row,
                total_row: t.style_options.total_row,
                first_column: t.style_options.first_column,
                last_column: t.style_options.last_column,
                show_filter_button: t.style_options.show_filter_button,
            },
            style_name: t.style_name.clone(),
        }
    }
}

impl From<&TableDef> for SavedTable {
    fn from(t: &TableDef) -> Self {
        SavedTable {
            id: t.id,
            name: t.name.clone(),
            sheet_index: t.sheet_index,
            start_row: t.start_row,
            start_col: t.start_col,
            end_row: t.end_row,
            end_col: t.end_col,
            columns: t.columns.iter().map(|c| SavedTableColumn {
                id: c.id,
                name: c.name.clone(),
                totals_row_function: c.totals_row_function.clone(),
                totals_row_formula: c.totals_row_formula.clone(),
                calculated_formula: c.calculated_formula.clone(),
            }).collect(),
            style_options: SavedTableStyleOptions {
                banded_rows: t.style_options.banded_rows,
                banded_columns: t.style_options.banded_columns,
                header_row: t.style_options.header_row,
                total_row: t.style_options.total_row,
                first_column: t.style_options.first_column,
                last_column: t.style_options.last_column,
                show_filter_button: t.style_options.show_filter_button,
            },
            style_name: t.style_name.clone(),
        }
    }
}
