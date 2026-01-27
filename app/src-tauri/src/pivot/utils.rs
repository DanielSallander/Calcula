//! FILENAME: app/src-tauri/src/pivot/utils.rs
use crate::pivot::types::*;
use engine::pivot::{
    AggregationType, PivotField, PivotLayout, PivotView, ReportLayout, ShowValuesAs, SortOrder,
    ValueField, ValuesPosition,
};

// ============================================================================
// PARSING & STRING UTILS
// ============================================================================

/// Strips the sheet name prefix from a cell reference or range.
/// "Sheet1!A1" -> "A1", "A1" -> "A1", "'Sheet Name'!B2" -> "B2"
pub(crate) fn strip_sheet_prefix(reference: &str) -> &str {
    if let Some(pos) = reference.rfind('!') {
        &reference[pos + 1..]
    } else {
        reference
    }
}

/// Parses a cell reference like "A1" into (row, col) 0-indexed coordinates.
/// Also handles references with sheet prefixes like "Sheet1!A1".
pub(crate) fn parse_cell_ref(cell_ref: &str) -> Result<(u32, u32), String> {
    // Strip any sheet prefix first
    let cell_ref = strip_sheet_prefix(cell_ref);
    let cell_ref = cell_ref.trim().to_uppercase();
    
    let col_end = cell_ref
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .count();
    
    if col_end == 0 {
        return Err(format!("Invalid cell reference: no column letters in '{}'", cell_ref));
    }
    
    let col_str = &cell_ref[..col_end];
    let row_str = &cell_ref[col_end..];
    
    if row_str.is_empty() {
        return Err(format!("Invalid cell reference: no row number in '{}'", cell_ref));
    }
    
    let row: u32 = row_str
        .parse()
        .map_err(|_| format!("Invalid row number in '{}'", cell_ref))?;
    
    if row == 0 {
        return Err("Row number must be >= 1".to_string());
    }
    
    let col = col_letter_to_index(col_str);
    
    Ok((row - 1, col)) // Convert to 0-indexed
}

/// Parses a range like "A1:D10" or "Sheet1!A1:D10" into ((start_row, start_col), (end_row, end_col))
pub(crate) fn parse_range(range: &str) -> Result<((u32, u32), (u32, u32)), String> {
    // Strip any sheet prefix from the entire range first
    let range = strip_sheet_prefix(range);
    
    let parts: Vec<&str> = range.split(':').collect();
    
    if parts.len() != 2 {
        return Err(format!("Invalid range format: '{}'. Expected 'A1:B2'", range));
    }
    
    let start = parse_cell_ref(parts[0])?;
    let end = parse_cell_ref(parts[1])?;
    
    // Normalize so start <= end
    let start_row = start.0.min(end.0);
    let end_row = start.0.max(end.0);
    let start_col = start.1.min(end.1);
    let end_col = start.1.max(end.1);
    
    Ok(((start_row, start_col), (end_row, end_col)))
}

/// Converts column letters to 0-indexed column number
pub(crate) fn col_letter_to_index(col: &str) -> u32 {
    let mut result: u32 = 0;
    for c in col.chars() {
        let val = (c.to_ascii_uppercase() as u32) - ('A' as u32) + 1;
        result = result * 26 + val;
    }
    result.saturating_sub(1)
}

/// Converts 0-indexed column to letters
pub(crate) fn col_index_to_letter(col: u32) -> String {
    let mut result = String::new();
    let mut n = col + 1;
    while n > 0 {
        let rem = ((n - 1) % 26) as u8;
        result.insert(0, (b'A' + rem) as char);
        n = (n - 1) / 26;
    }
    result
}

// ============================================================================
// CONFIG CONVERTERS
// ============================================================================

/// Converts PivotFieldConfig to engine PivotField
pub(crate) fn config_to_pivot_field(config: &PivotFieldConfig) -> PivotField {
    let mut field = PivotField::new(config.source_index, config.name.clone());
    
    if let Some(ref sort) = config.sort_order {
        field.sort_order = match sort.to_lowercase().as_str() {
            "desc" | "descending" => SortOrder::Descending,
            "manual" => SortOrder::Manual,
            "source" | "datasource" => SortOrder::DataSourceOrder,
            _ => SortOrder::Ascending,
        };
    }
    
    if let Some(subtotals) = config.show_subtotals {
        field.show_subtotals = subtotals;
    }
    
    if let Some(collapsed) = config.collapsed {
        field.collapsed = collapsed;
    }
    
    if let Some(ref hidden) = config.hidden_items {
        field.hidden_items = hidden.clone();
    }
    
    field
}

/// Converts ValueFieldConfig to engine ValueField
pub(crate) fn config_to_value_field(config: &ValueFieldConfig) -> ValueField {
    let aggregation = match config.aggregation.to_lowercase().as_str() {
        "count" => AggregationType::Count,
        "average" | "avg" => AggregationType::Average,
        "min" => AggregationType::Min,
        "max" => AggregationType::Max,
        "countnumbers" | "count_numbers" => AggregationType::CountNumbers,
        "stddev" | "stdev" => AggregationType::StdDev,
        "stddevp" | "stdevp" => AggregationType::StdDevP,
        "var" => AggregationType::Var,
        "varp" => AggregationType::VarP,
        "product" => AggregationType::Product,
        _ => AggregationType::Sum,
    };
    
    let mut field = ValueField::new(config.source_index, config.name.clone(), aggregation);
    field.number_format = config.number_format.clone();
    
    if let Some(ref show_as) = config.show_values_as {
        field.show_values_as = match show_as.to_lowercase().as_str() {
            "percent_of_total" | "percentoftotal" => ShowValuesAs::PercentOfGrandTotal,
            "percent_of_row" | "percentofrow" => ShowValuesAs::PercentOfRowTotal,
            "percent_of_column" | "percentofcolumn" => ShowValuesAs::PercentOfColumnTotal,
            "percent_of_parent_row" => ShowValuesAs::PercentOfParentRow,
            "percent_of_parent_column" => ShowValuesAs::PercentOfParentColumn,
            "difference" => ShowValuesAs::Difference,
            "percent_difference" => ShowValuesAs::PercentDifference,
            "running_total" => ShowValuesAs::RunningTotal,
            "index" => ShowValuesAs::Index,
            _ => ShowValuesAs::Normal,
        };
    }
    
    field
}

/// Applies layout config to PivotLayout
pub(crate) fn apply_layout_config(layout: &mut PivotLayout, config: &LayoutConfig) {
    if let Some(v) = config.show_row_grand_totals {
        layout.show_row_grand_totals = v;
    }
    if let Some(v) = config.show_column_grand_totals {
        layout.show_column_grand_totals = v;
    }
    if let Some(ref v) = config.report_layout {
        layout.report_layout = match v.to_lowercase().as_str() {
            "outline" => ReportLayout::Outline,
            "tabular" => ReportLayout::Tabular,
            _ => ReportLayout::Compact,
        };
    }
    if let Some(v) = config.repeat_row_labels {
        layout.repeat_row_labels = v;
    }
    if let Some(v) = config.show_empty_rows {
        layout.show_empty_rows = v;
    }
    if let Some(v) = config.show_empty_cols {
        layout.show_empty_cols = v;
    }
    if let Some(ref v) = config.values_position {
        layout.values_position = match v.to_lowercase().as_str() {
            "rows" => ValuesPosition::Rows,
            _ => ValuesPosition::Columns,
        };
    }
}

// ============================================================================
// REVERSE CONVERTERS (engine types to strings)
// ============================================================================

/// Converts AggregationType to string
pub(crate) fn aggregation_to_string(agg: AggregationType) -> String {
    match agg {
        AggregationType::Sum => "sum".to_string(),
        AggregationType::Count => "count".to_string(),
        AggregationType::Average => "average".to_string(),
        AggregationType::Min => "min".to_string(),
        AggregationType::Max => "max".to_string(),
        AggregationType::CountNumbers => "countnumbers".to_string(),
        AggregationType::StdDev => "stddev".to_string(),
        AggregationType::StdDevP => "stddevp".to_string(),
        AggregationType::Var => "var".to_string(),
        AggregationType::VarP => "varp".to_string(),
        AggregationType::Product => "product".to_string(),
    }
}

/// Converts ReportLayout to string
pub(crate) fn report_layout_to_string(layout: ReportLayout) -> String {
    match layout {
        ReportLayout::Compact => "compact".to_string(),
        ReportLayout::Outline => "outline".to_string(),
        ReportLayout::Tabular => "tabular".to_string(),
    }
}

/// Converts ValuesPosition to string
pub(crate) fn values_position_to_string(pos: ValuesPosition) -> String {
    match pos {
        ValuesPosition::Columns => "columns".to_string(),
        ValuesPosition::Rows => "rows".to_string(),
    }
}

/// Converts engine PivotView to response format
pub(crate) fn view_to_response(view: &PivotView) -> PivotViewResponse {
    let rows: Vec<PivotRowData> = view
        .cells
        .iter()
        .zip(view.rows.iter())
        .map(|(cells, descriptor)| {
            let cell_data: Vec<PivotCellData> = cells
                .iter()
                .map(|cell| PivotCellData {
                    cell_type: format!("{:?}", cell.cell_type),
                    value: match &cell.value {
                        engine::pivot::PivotCellValue::Empty => PivotCellValueData::Empty,
                        engine::pivot::PivotCellValue::Number(n) => PivotCellValueData::Number(*n),
                        engine::pivot::PivotCellValue::Text(s) => {
                            PivotCellValueData::Text(s.clone())
                        }
                        engine::pivot::PivotCellValue::Boolean(b) => {
                            PivotCellValueData::Boolean(*b)
                        }
                        engine::pivot::PivotCellValue::Error(e) => {
                            PivotCellValueData::Error(e.clone())
                        }
                    },
                    formatted_value: cell.formatted_value.clone(),
                    indent_level: cell.indent_level,
                    is_bold: cell.is_bold,
                    is_expandable: cell.is_expandable,
                    is_collapsed: cell.is_collapsed,
                    background_style: format!("{:?}", cell.background_style),
                    number_format: cell.number_format.clone(),
                })
                .collect();

            PivotRowData {
                view_row: descriptor.view_row,
                row_type: format!("{:?}", descriptor.row_type),
                depth: descriptor.depth,
                visible: descriptor.visible,
                cells: cell_data,
            }
        })
        .collect();

    let columns: Vec<PivotColumnData> = view
        .columns
        .iter()
        .map(|col| PivotColumnData {
            view_col: col.view_col,
            col_type: format!("{:?}", col.col_type),
            depth: col.depth,
            width_hint: col.width_hint,
        })
        .collect();

    PivotViewResponse {
        pivot_id: view.pivot_id,
        version: view.version,
        row_count: view.row_count,
        col_count: view.col_count,
        row_label_col_count: view.row_label_col_count,
        column_header_row_count: view.column_header_row_count,
        rows,
        columns,
    }
}