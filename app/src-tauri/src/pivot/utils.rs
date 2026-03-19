//! FILENAME: app/src-tauri/src/pivot/utils.rs
use crate::commands::styles::parse_number_format;
use crate::pivot::types::*;
use engine::format_number;
use pivot_engine::{
    AggregationType, CacheValue, DateGroupLevel, FieldGrouping, FilterCondition, ManualGroup,
    PivotCache, PivotDefinition, PivotField, PivotFilter, PivotLayout, PivotView, ReportLayout,
    ShowValuesAs, SortOrder, SubtotalLocation, ValueField, ValuesPosition, VALUE_ID_EMPTY,
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

/// Excel-compatible max row count (1-indexed).
const MAX_ROWS: u32 = 1_048_576;

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

/// Tries to parse a column-only reference like "A" into a 0-indexed column index.
/// Returns None if the string contains non-alphabetic characters.
fn try_parse_col_only(s: &str) -> Option<u32> {
    let s = s.trim();
    if s.is_empty() || !s.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    Some(col_letter_to_index(&s.to_uppercase()))
}

/// Parses a range like "A1:D10", "Sheet1!A1:D10", or column-only "A:D"
/// into ((start_row, start_col), (end_row, end_col)).
/// Column-only references expand to the full row range (0 to MAX_ROWS-1).
pub(crate) fn parse_range(range: &str) -> Result<((u32, u32), (u32, u32)), String> {
    // Strip any sheet prefix from the entire range first
    let range = strip_sheet_prefix(range);

    let parts: Vec<&str> = range.split(':').collect();

    if parts.len() != 2 {
        return Err(format!("Invalid range format: '{}'. Expected 'A1:B2' or 'A:D'", range));
    }

    // Check if both parts are column-only references (e.g. "A:D")
    if let (Some(start_col), Some(end_col)) = (try_parse_col_only(parts[0]), try_parse_col_only(parts[1])) {
        let min_col = start_col.min(end_col);
        let max_col = start_col.max(end_col);
        return Ok(((0, min_col), (MAX_ROWS - 1, max_col)));
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
// COLLAPSE STATE PRESERVATION
// ============================================================================

/// Carry over collapse state (collapsed flag + per-item collapsed_items) from
/// old fields to new fields that match by name.  Fields that were removed or
/// added keep the default (expanded) state.
pub(crate) fn preserve_collapse_state(new_fields: &mut [PivotField], old_fields: &[PivotField]) {
    for new_field in new_fields.iter_mut() {
        if let Some(old) = old_fields.iter().find(|o| o.name == new_field.name) {
            new_field.collapsed = old.collapsed;
            new_field.collapsed_items = old.collapsed_items.clone();
        }
    }
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

    if let Some(ref collapsed_items) = config.collapsed_items {
        field.collapsed_items = collapsed_items.clone();
    }

    if let Some(show_all) = config.show_all_items {
        field.show_all_items = show_all;
    }

    if let Some(ref grouping_config) = config.grouping {
        field.grouping = api_grouping_config_to_engine(grouping_config);
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

/// Converts PivotFieldConfig to engine PivotFilter (for filter area)
pub(crate) fn config_to_pivot_filter(config: &PivotFieldConfig) -> PivotFilter {
    let field = config_to_pivot_field(config);

    // Default to showing all values (empty ValueList means include all)
    // If hidden_items are specified, we'll exclude those
    let condition = if let Some(ref hidden) = config.hidden_items {
        if hidden.is_empty() {
            // No hidden items means show all
            FilterCondition::ValueList(Vec::new())
        } else {
            // hidden_items represents items to exclude
            // For now, we use ValueList but the engine handles hidden_items on the field
            FilterCondition::ValueList(Vec::new())
        }
    } else {
        FilterCondition::ValueList(Vec::new())
    };

    PivotFilter { field, condition }
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
    if let Some(v) = config.auto_fit_column_widths {
        layout.auto_fit_column_widths = v;
    }
}

/// Converts API SubtotalLocationType to engine SubtotalLocation.
pub(crate) fn api_subtotal_location_to_engine(loc: &SubtotalLocationType) -> SubtotalLocation {
    match loc {
        SubtotalLocationType::AtTop => SubtotalLocation::AtTop,
        SubtotalLocationType::AtBottom => SubtotalLocation::AtBottom,
        SubtotalLocationType::Off => SubtotalLocation::Off,
    }
}

/// Converts engine SubtotalLocation to API SubtotalLocationType.
#[allow(dead_code)]
pub(crate) fn engine_subtotal_location_to_api(loc: SubtotalLocation) -> SubtotalLocationType {
    match loc {
        SubtotalLocation::AtTop => SubtotalLocationType::AtTop,
        SubtotalLocation::AtBottom | SubtotalLocation::Off => SubtotalLocationType::AtBottom,
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

/// Convert a CacheValue to a display string
pub(crate) fn cache_value_to_string(value: &CacheValue) -> String {
    match value {
        CacheValue::Empty => "(Blank)".to_string(),
        CacheValue::Number(n) => {
            let f = n.as_f64();
            if f.fract() == 0.0 {
                format!("{}", f as i64)
            } else {
                format!("{}", f)
            }
        }
        CacheValue::Text(s) => s.clone(),
        CacheValue::Boolean(b) => if *b { "TRUE".to_string() } else { "FALSE".to_string() },
        CacheValue::Error(e) => format!("#{}", e),
    }
}

/// Converts an API FieldGroupingConfig to the engine FieldGrouping type.
pub(crate) fn api_grouping_config_to_engine(config: &FieldGroupingConfig) -> FieldGrouping {
    match config {
        FieldGroupingConfig::None => FieldGrouping::None,
        FieldGroupingConfig::DateGrouping { levels } => {
            let engine_levels: Vec<DateGroupLevel> = levels
                .iter()
                .filter_map(|s| match s.to_lowercase().as_str() {
                    "year" => Some(DateGroupLevel::Year),
                    "quarter" => Some(DateGroupLevel::Quarter),
                    "month" => Some(DateGroupLevel::Month),
                    "week" => Some(DateGroupLevel::Week),
                    "day" => Some(DateGroupLevel::Day),
                    _ => None,
                })
                .collect();
            FieldGrouping::DateGrouping { levels: engine_levels }
        }
        FieldGroupingConfig::NumberBinning { start, end, interval } => {
            FieldGrouping::NumberBinning {
                start: *start,
                end: *end,
                interval: *interval,
            }
        }
        FieldGroupingConfig::ManualGrouping { groups, ungrouped_name } => {
            let engine_groups: Vec<ManualGroup> = groups
                .iter()
                .map(|g| ManualGroup {
                    name: g.name.clone(),
                    members: g.members.clone(),
                })
                .collect();
            FieldGrouping::ManualGrouping {
                groups: engine_groups,
                ungrouped_name: ungrouped_name
                    .clone()
                    .unwrap_or_else(|| "Other".to_string()),
            }
        }
    }
}

/// Converts engine PivotView to response format, including filter row data with unique values
/// Maximum number of rows before auto-windowing kicks in.
const WINDOW_THRESHOLD: usize = 500;
/// Number of rows in the initial cell window for large pivots.
const INITIAL_WINDOW_SIZE: usize = 200;

pub(crate) fn view_to_response(
    view: &PivotView,
    definition: &PivotDefinition,
    cache: &mut PivotCache,
) -> PivotViewResponse {
    // Filter to only visible rows (fast-path toggle keeps hidden rows in the view
    // for re-expansion, but the frontend should only receive visible rows).
    let visible_indices: Vec<usize> = view.rows.iter().enumerate()
        .filter(|(_, r)| r.visible)
        .map(|(i, _)| i)
        .collect();
    let total_rows = visible_indices.len();
    let use_windowing = total_rows > WINDOW_THRESHOLD;
    let window_end = if use_windowing { INITIAL_WINDOW_SIZE.min(total_rows) } else { total_rows };

    // Helper: convert engine cells to response cells
    let convert_cells = |cells: &[pivot_engine::PivotViewCell]| -> Vec<PivotCellData> {
        cells
            .iter()
            .map(|cell| PivotCellData {
                cell_type: cell.cell_type,
                value: match &cell.value {
                    pivot_engine::PivotCellValue::Empty => PivotCellValueData::Empty,
                    pivot_engine::PivotCellValue::Number(n) => PivotCellValueData::Number(*n),
                    pivot_engine::PivotCellValue::Text(s) => {
                        PivotCellValueData::Text(s.clone())
                    }
                    pivot_engine::PivotCellValue::Boolean(b) => {
                        PivotCellValueData::Boolean(*b)
                    }
                    pivot_engine::PivotCellValue::Error(e) => {
                        PivotCellValueData::Text(format!("#{}", e))
                    }
                },
                formatted_value: match (&cell.value, &cell.number_format) {
                    (pivot_engine::PivotCellValue::Number(n), Some(fmt)) if !fmt.is_empty() => {
                        format_number(*n, &parse_number_format(fmt))
                    }
                    _ => String::new(),
                },
                indent_level: cell.indent_level,
                is_bold: cell.is_bold,
                is_expandable: cell.is_expandable,
                is_collapsed: cell.is_collapsed,
                background_style: cell.background_style,
                number_format: cell.number_format.clone(),
                filter_field_index: cell.filter_field_index,
                col_span: cell.col_span,
                group_path: match cell.cell_type {
                    pivot_engine::PivotCellType::RowHeader
                    | pivot_engine::PivotCellType::ColumnHeader
                    | pivot_engine::PivotCellType::RowSubtotal
                    | pivot_engine::PivotCellType::ColumnSubtotal
                    | pivot_engine::PivotCellType::GrandTotalRow
                    | pivot_engine::PivotCellType::GrandTotalColumn
                    | pivot_engine::PivotCellType::GrandTotal => cell
                        .group_path
                        .iter()
                        .map(|(fi, vid)| (*fi, *vid))
                        .collect(),
                    _ => Vec::new(),
                },
            })
            .collect()
    };

    // Only build full PivotRowData (with cells) for the window; rest get empty cells.
    // For windowed pivots this avoids cloning cell data for 98K+ rows when only ~200 are sent.
    // Only visible rows are included (invisible rows from fast-path toggle are excluded).
    let all_rows: Vec<PivotRowData> = visible_indices
        .iter()
        .enumerate()
        .map(|(visible_idx, &orig_idx)| {
            let descriptor = &view.rows[orig_idx];
            let cells = &view.cells[orig_idx];
            PivotRowData {
                view_row: descriptor.view_row,
                row_type: descriptor.row_type,
                depth: descriptor.depth,
                visible: true,
                cells: if visible_idx < window_end { convert_cells(cells) } else { Vec::new() },
            }
        })
        .collect();

    // Compute max_content_sample per column: the longest display string
    // (with indent padding) so the frontend can measure width from a single
    // string instead of scanning all cells.
    let num_cols = view.columns.len();
    let mut max_samples: Vec<String> = vec![String::new(); num_cols];
    let mut max_lengths: Vec<usize> = vec![0; num_cols];
    for row_cells in &view.cells {
        for (j, cell) in row_cells.iter().enumerate() {
            if j >= num_cols { break; }
            let display = if let Some(ref fmt) = cell.number_format {
                if !fmt.is_empty() {
                    if let pivot_engine::PivotCellValue::Number(n) = &cell.value {
                        format_number(*n, &parse_number_format(fmt))
                    } else {
                        cell.formatted_value.clone()
                    }
                } else {
                    cell.formatted_value.clone()
                }
            } else {
                cell.formatted_value.clone()
            };
            // Approximate effective length: indent adds 2 chars per level,
            // expandable icon adds 2 chars.
            let extra = (cell.indent_level as usize) * 2
                + if cell.is_expandable { 2 } else { 0 };
            let effective_len = display.len() + extra;
            if effective_len > max_lengths[j] {
                max_lengths[j] = effective_len;
                // Prepend spaces to represent indent + icon padding
                if extra > 0 {
                    let mut padded = " ".repeat(extra);
                    padded.push_str(&display);
                    max_samples[j] = padded;
                } else {
                    max_samples[j] = display;
                }
            }
        }
    }

    let columns: Vec<PivotColumnData> = view
        .columns
        .iter()
        .enumerate()
        .map(|(i, col)| PivotColumnData {
            view_col: col.view_col,
            col_type: col.col_type,
            depth: col.depth,
            width_hint: col.width_hint,
            max_content_sample: max_samples.get(i).cloned().unwrap_or_default(),
        })
        .collect();

    // Build filter rows with unique values from the cache
    let filter_rows: Vec<FilterRowData> = definition
        .filter_fields
        .iter()
        .enumerate()
        .map(|(idx, filter)| {
            let field_index = filter.field.source_index;
            let field_name = filter.field.name.clone();

            // Get unique values from cache
            let unique_values: Vec<String> = if let Some(field_cache) = cache.fields.get_mut(field_index) {
                // Clone sorted_ids to end the mutable borrow before calling get_value
                let sorted_ids = field_cache.sorted_ids().to_vec();
                sorted_ids
                    .iter()
                    .filter_map(|&id| {
                        if id == VALUE_ID_EMPTY {
                            return None;
                        }
                        field_cache.get_value(id).map(cache_value_to_string)
                    })
                    .collect()
            } else {
                Vec::new()
            };

            // Get selected values (all values minus hidden items)
            let hidden_items = &filter.field.hidden_items;
            let selected_values: Vec<String> = unique_values
                .iter()
                .filter(|v| !hidden_items.contains(v))
                .cloned()
                .collect();

            // Calculate display value for the filter cell
            let display_value = if hidden_items.is_empty() {
                "(All)".to_string()
            } else if selected_values.len() == 1 {
                selected_values[0].clone()
            } else if selected_values.is_empty() {
                "(None)".to_string()
            } else {
                "(Multiple Items)".to_string()
            };

            FilterRowData {
                field_index,
                field_name,
                selected_values,
                unique_values,
                display_value,
                view_row: idx,
            }
        })
        .collect();

    // Build row/column field summaries for header filter dropdowns
    let row_field_summaries: Vec<HeaderFieldSummaryData> = view
        .row_field_summaries
        .iter()
        .map(|s| HeaderFieldSummaryData {
            field_index: s.field_index,
            field_name: s.field_name.clone(),
            has_active_filter: s.has_active_filter,
        })
        .collect();

    let column_field_summaries: Vec<HeaderFieldSummaryData> = view
        .column_field_summaries
        .iter()
        .map(|s| HeaderFieldSummaryData {
            field_index: s.field_index,
            field_name: s.field_name.clone(),
            has_active_filter: s.has_active_filter,
        })
        .collect();

    if use_windowing {
        // Large pivot: send row descriptors for ALL rows + cells for first window only.
        // Cell data beyond window_end is already empty (skipped during construction above).
        let row_descriptors: Vec<PivotRowDescriptorData> = all_rows
            .iter()
            .map(|r| PivotRowDescriptorData {
                view_row: r.view_row,
                row_type: r.row_type,
                depth: r.depth,
                visible: r.visible,
            })
            .collect();

        let windowed_rows: Vec<PivotRowData> = all_rows.into_iter().take(window_end).collect();

        PivotViewResponse {
            pivot_id: view.pivot_id,
            version: view.version,
            row_count: view.row_count,
            col_count: view.col_count,
            row_label_col_count: view.row_label_col_count,
            column_header_row_count: view.column_header_row_count,
            filter_row_count: view.filter_row_count,
            filter_rows,
            row_field_summaries,
            column_field_summaries,
            rows: windowed_rows,
            columns,
            is_windowed: true,
            total_row_count: Some(total_rows),
            window_start_row: Some(0),
            row_descriptors,
        }
    } else {
        // Small pivot: send everything (no windowing)
        PivotViewResponse {
            pivot_id: view.pivot_id,
            version: view.version,
            row_count: view.row_count,
            col_count: view.col_count,
            row_label_col_count: view.row_label_col_count,
            column_header_row_count: view.column_header_row_count,
            filter_row_count: view.filter_row_count,
            filter_rows,
            row_field_summaries,
            column_field_summaries,
            rows: all_rows,
            columns,
            is_windowed: false,
            total_row_count: None,
            window_start_row: None,
            row_descriptors: Vec::new(),
        }
    }
}

/// Extract a cell window from a stored PivotView for scroll-triggered fetching.
pub(crate) fn extract_cell_window(
    view: &PivotView,
    start_row: usize,
    row_count: usize,
) -> Vec<PivotRowData> {
    let end_row = (start_row + row_count).min(view.rows.len());
    view.cells[start_row..end_row]
        .iter()
        .zip(view.rows[start_row..end_row].iter())
        .map(|(cells, descriptor)| {
            let cell_data: Vec<PivotCellData> = cells
                .iter()
                .map(|cell| PivotCellData {
                    cell_type: cell.cell_type,
                    value: match &cell.value {
                        pivot_engine::PivotCellValue::Empty => PivotCellValueData::Empty,
                        pivot_engine::PivotCellValue::Number(n) => PivotCellValueData::Number(*n),
                        pivot_engine::PivotCellValue::Text(s) => {
                            PivotCellValueData::Text(s.clone())
                        }
                        pivot_engine::PivotCellValue::Boolean(b) => {
                            PivotCellValueData::Boolean(*b)
                        }
                        pivot_engine::PivotCellValue::Error(e) => {
                            PivotCellValueData::Text(format!("#{}", e))
                        }
                    },
                    formatted_value: match (&cell.value, &cell.number_format) {
                        (pivot_engine::PivotCellValue::Number(n), Some(fmt)) if !fmt.is_empty() => {
                            format_number(*n, &parse_number_format(fmt))
                        }
                        _ => String::new(),
                    },
                    indent_level: cell.indent_level,
                    is_bold: cell.is_bold,
                    is_expandable: cell.is_expandable,
                    is_collapsed: cell.is_collapsed,
                    background_style: cell.background_style,
                    number_format: cell.number_format.clone(),
                    filter_field_index: cell.filter_field_index,
                    col_span: cell.col_span,
                    group_path: match cell.cell_type {
                        pivot_engine::PivotCellType::RowHeader
                        | pivot_engine::PivotCellType::ColumnHeader
                        | pivot_engine::PivotCellType::RowSubtotal
                        | pivot_engine::PivotCellType::ColumnSubtotal
                        | pivot_engine::PivotCellType::GrandTotalRow
                        | pivot_engine::PivotCellType::GrandTotalColumn
                        | pivot_engine::PivotCellType::GrandTotal => cell
                            .group_path
                            .iter()
                            .map(|(fi, vid)| (*fi, *vid))
                            .collect(),
                        _ => Vec::new(),
                    },
                })
                .collect();

            PivotRowData {
                view_row: descriptor.view_row,
                row_type: descriptor.row_type,
                depth: descriptor.depth,
                visible: descriptor.visible,
                cells: cell_data,
            }
        })
        .collect()
}