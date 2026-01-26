//! Pivot Table Tauri Commands
//!
//! This module provides the bridge between the frontend and the pivot table engine.
//! Commands handle creation, updates, and view generation for pivot tables.

use crate::{log_debug, log_info, AppState, PivotRegion};
use engine::pivot::{
    calculate_pivot, drill_down, AggregationType, PivotCache, PivotDefinition,
    PivotField, PivotId, PivotLayout, PivotView, ReportLayout, ShowValuesAs, SortOrder,
    ValueField, ValuesPosition,
};
use engine::{Cell, CellValue};
use serde::{Deserialize, Serialize};
use tauri::State;

// ============================================================================
// API TYPES
// ============================================================================

/// Request to create a new pivot table
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreatePivotRequest {
    /// Source range in A1 notation (e.g., "A1:D100")
    pub source_range: String,
    /// Destination cell in A1 notation (e.g., "F1")
    pub destination_cell: String,
    /// Optional: sheet index for source data (defaults to active sheet)
    pub source_sheet: Option<usize>,
    /// Optional: sheet index for destination (defaults to active sheet)
    pub destination_sheet: Option<usize>,
    /// Whether first row contains headers
    pub has_headers: Option<bool>,
}

/// Field configuration for pivot updates
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PivotFieldConfig {
    /// Source column index (0-based)
    pub source_index: usize,
    /// Display name
    pub name: String,
    /// Sort order: "asc", "desc", "manual", "source"
    pub sort_order: Option<String>,
    /// Whether to show subtotals
    pub show_subtotals: Option<bool>,
    /// Whether field is collapsed
    pub collapsed: Option<bool>,
    /// Items to hide (filter out)
    pub hidden_items: Option<Vec<String>>,
}

/// Value field configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValueFieldConfig {
    /// Source column index (0-based)
    pub source_index: usize,
    /// Display name
    pub name: String,
    /// Aggregation type: "sum", "count", "average", "min", "max", etc.
    pub aggregation: String,
    /// Number format string
    pub number_format: Option<String>,
    /// Show values as: "normal", "percent_of_total", etc.
    pub show_values_as: Option<String>,
}

/// Layout configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayoutConfig {
    pub show_row_grand_totals: Option<bool>,
    pub show_column_grand_totals: Option<bool>,
    /// "compact", "outline", "tabular"
    pub report_layout: Option<String>,
    pub repeat_row_labels: Option<bool>,
    pub show_empty_rows: Option<bool>,
    pub show_empty_cols: Option<bool>,
    /// "columns" or "rows"
    pub values_position: Option<String>,
}

/// Request to update pivot table fields
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdatePivotFieldsRequest {
    /// Pivot table ID
    pub pivot_id: PivotId,
    /// Row fields (optional - if None, keep existing)
    pub row_fields: Option<Vec<PivotFieldConfig>>,
    /// Column fields (optional)
    pub column_fields: Option<Vec<PivotFieldConfig>>,
    /// Value fields (optional)
    pub value_fields: Option<Vec<ValueFieldConfig>>,
    /// Layout options (optional)
    pub layout: Option<LayoutConfig>,
}

/// Request to toggle a group's expand/collapse state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToggleGroupRequest {
    /// Pivot table ID
    pub pivot_id: PivotId,
    /// Whether this is a row (true) or column (false) group
    pub is_row: bool,
    /// The field index to toggle
    pub field_index: usize,
    /// The specific value to toggle (optional - if None, toggle all)
    pub value: Option<String>,
}

/// Response containing the pivot view data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PivotViewResponse {
    pub pivot_id: PivotId,
    pub version: u64,
    pub row_count: usize,
    pub col_count: usize,
    pub row_label_col_count: usize,
    pub column_header_row_count: usize,
    pub rows: Vec<PivotRowData>,
    pub columns: Vec<PivotColumnData>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PivotRowData {
    pub view_row: usize,
    pub row_type: String,
    pub depth: u8,
    pub visible: bool,
    pub cells: Vec<PivotCellData>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PivotCellData {
    pub cell_type: String,
    pub value: PivotCellValueData,
    pub formatted_value: String,
    pub indent_level: u8,
    pub is_bold: bool,
    pub is_expandable: bool,
    pub is_collapsed: bool,
    pub background_style: String,
    pub number_format: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum PivotCellValueData {
    Empty,
    Number(f64),
    Text(String),
    Boolean(bool),
    Error(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PivotColumnData {
    pub view_col: usize,
    pub col_type: String,
    pub depth: u8,
    pub width_hint: u16,
}

/// Source data response for drill-down
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceDataResponse {
    pub pivot_id: PivotId,
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub total_count: usize,
    pub is_truncated: bool,
}

/// Response for pivot region check
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PivotRegionInfo {
    pub pivot_id: PivotId,
    pub is_empty: bool,
    pub source_fields: Vec<SourceFieldInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFieldInfo {
    pub index: usize,
    pub name: String,
    pub is_numeric: bool,
}

// ============================================================================
// CONSTANTS
// ============================================================================

/// Minimum reserved rows for an empty pivot table placeholder
const EMPTY_PIVOT_ROWS: u32 = 18;
/// Minimum reserved columns for an empty pivot table placeholder
const EMPTY_PIVOT_COLS: u32 = 5;

// ============================================================================
// HELPER FUNCTIONS
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

/// Converts PivotFieldConfig to engine PivotField
fn config_to_pivot_field(config: &PivotFieldConfig) -> PivotField {
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
fn config_to_value_field(config: &ValueFieldConfig) -> ValueField {
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
fn apply_layout_config(layout: &mut PivotLayout, config: &LayoutConfig) {
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

/// Creates an empty pivot view for when no fields are configured
fn create_empty_view(pivot_id: PivotId, version: u64) -> PivotView {
    PivotView {
        pivot_id,
        version,
        row_count: 0,
        col_count: 0,
        row_label_col_count: 0,
        column_header_row_count: 0,
        cells: Vec::new(),
        rows: Vec::new(),
        columns: Vec::new(),
        is_windowed: false,
        total_row_count: None,
        window_start_row: None,
    }
}

/// Check if the pivot definition has any fields configured
fn has_fields_configured(definition: &PivotDefinition) -> bool {
    !definition.row_fields.is_empty() 
        || !definition.column_fields.is_empty() 
        || !definition.value_fields.is_empty()
}

/// Safely calculate pivot - returns empty view if no fields configured
fn safe_calculate_pivot(definition: &PivotDefinition, cache: &mut PivotCache) -> PivotView {
    if !has_fields_configured(definition) {
        log_debug!("PIVOT", "No fields configured, returning empty view");
        return create_empty_view(definition.id, definition.version);
    }
    calculate_pivot(definition, cache)
}

/// Converts engine PivotView to response format
fn view_to_response(view: &PivotView) -> PivotViewResponse {
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

/// Builds a PivotCache from grid data
fn build_cache_from_grid(
    grid: &engine::Grid,
    start: (u32, u32),
    end: (u32, u32),
    has_headers: bool,
) -> Result<(PivotCache, Vec<String>), String> {
    let (start_row, start_col) = start;
    let (end_row, end_col) = end;
    
    let col_count = (end_col - start_col + 1) as usize;
    let data_start_row = if has_headers { start_row + 1 } else { start_row };
    
    // Extract headers
    let headers: Vec<String> = if has_headers {
        (start_col..=end_col)
            .map(|c| {
                grid.get_cell(start_row, c)
                    .map(|cell| cell.display_value())
                    .unwrap_or_else(|| col_index_to_letter(c - start_col))
            })
            .collect()
    } else {
        (0..col_count)
            .map(|i| col_index_to_letter(i as u32))
            .collect()
    };
    
    // Create cache
    let mut cache = PivotCache::new(1, col_count);
    
    // Set field names
    for (i, name) in headers.iter().enumerate() {
        cache.set_field_name(i, name.clone());
    }
    
    // Add records
    for row in data_start_row..=end_row {
        let mut values: Vec<CellValue> = Vec::with_capacity(col_count);
        
        for col in start_col..=end_col {
            let value = grid
                .get_cell(row, col)
                .map(|cell| cell.value.clone())
                .unwrap_or(CellValue::Empty);
            values.push(value);
        }
        
        // source_row is u32
        cache.add_record(row - data_start_row, &values);
    }
    
    Ok((cache, headers))
}

/// Writes pivot view cells to the destination grid
fn write_pivot_to_grid(
    grid: &mut engine::Grid,
    view: &PivotView,
    destination: (u32, u32),
) {
    let (dest_row, dest_col) = destination;
    
    log_debug!(
        "PIVOT",
        "write_pivot_to_grid: dest=({},{}) view_size={}x{}",
        dest_row,
        dest_col,
        view.row_count,
        view.col_count
    );
    
    // If view is empty, nothing to write
    if view.row_count == 0 || view.col_count == 0 {
        log_debug!("PIVOT", "Empty view, nothing to write to grid");
        return;
    }
    
    // Iterate through visible rows only
    for (row_idx, row_descriptor) in view.rows.iter().enumerate() {
        if !row_descriptor.visible {
            continue;
        }
        
        // Get the cells for this row
        if row_idx >= view.cells.len() {
            continue;
        }
        let row_cells = &view.cells[row_idx];
        
        for (col_idx, pivot_cell) in row_cells.iter().enumerate() {
            let grid_row = dest_row + row_idx as u32;
            let grid_col = dest_col + col_idx as u32;
            
            // Use formatted_value for display if available, otherwise use the raw value
            let display_text = if !pivot_cell.formatted_value.is_empty() {
                pivot_cell.formatted_value.clone()
            } else {
                match &pivot_cell.value {
                    engine::pivot::PivotCellValue::Empty => String::new(),
                    engine::pivot::PivotCellValue::Number(n) => n.to_string(),
                    engine::pivot::PivotCellValue::Text(s) => s.clone(),
                    engine::pivot::PivotCellValue::Boolean(b) => if *b { "TRUE".to_string() } else { "FALSE".to_string() },
                    engine::pivot::PivotCellValue::Error(e) => format!("#{}", e),
                }
            };
            
            // Create the cell - for now we use text cells with the formatted value
            // This ensures the display matches what the pivot engine calculated
            let cell = if display_text.is_empty() {
                Cell::new()
            } else {
                Cell::new_text(display_text)
            };
            
            grid.set_cell(grid_row, grid_col, cell);
        }
    }
    
    log_debug!(
        "PIVOT",
        "write_pivot_to_grid: wrote {} rows to grid",
        view.rows.iter().filter(|r| r.visible).count()
    );
}

/// Updates the pivot region tracking for a pivot table.
/// Always tracks a region, even for empty pivots (using minimum reserved size).
fn update_pivot_region(
    state: &AppState,
    pivot_id: PivotId,
    sheet_index: usize,
    destination: (u32, u32),
    view: &PivotView,
) {
    let mut regions = state.pivot_regions.lock().unwrap();
    
    // Remove any existing region for this pivot
    regions.retain(|r| r.pivot_id != pivot_id);
    
    let (dest_row, dest_col) = destination;
    
    // Calculate region size - use actual view size or minimum reserved size for empty pivots
    let (end_row, end_col) = if view.row_count > 0 && view.col_count > 0 {
        let visible_rows = view.rows.iter().filter(|r| r.visible).count() as u32;
        (
            dest_row + visible_rows.saturating_sub(1),
            dest_col + (view.col_count as u32).saturating_sub(1),
        )
    } else {
        // Empty pivot - reserve minimum space for placeholder
        (
            dest_row + EMPTY_PIVOT_ROWS - 1,
            dest_col + EMPTY_PIVOT_COLS - 1,
        )
    };
    
    regions.push(PivotRegion {
        pivot_id,
        sheet_index,
        start_row: dest_row,
        start_col: dest_col,
        end_row,
        end_col,
    });
    
    log_debug!(
        "PIVOT",
        "updated pivot region: id={} sheet={} ({},{}) to ({},{}) empty={}",
        pivot_id,
        sheet_index,
        dest_row,
        dest_col,
        end_row,
        end_col,
        view.row_count == 0
    );
}

// ============================================================================
// TAURI COMMANDS
// ============================================================================

/// Creates a new pivot table from the specified source range
#[tauri::command]
pub fn create_pivot_table(
    state: State<AppState>,
    request: CreatePivotRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "create_pivot_table source={} dest={} dest_sheet={:?}",
        request.source_range,
        request.destination_cell,
        request.destination_sheet
    );

    // Parse ranges
    let (source_start, source_end) = parse_range(&request.source_range)?;
    let destination = parse_cell_ref(&request.destination_cell)?;

    // Get source sheet
    let source_sheet_idx = request.source_sheet.unwrap_or_else(|| {
        *state.active_sheet.lock().unwrap()
    });

    // Get destination sheet - use provided value or fall back to active sheet
    let dest_sheet_idx = request.destination_sheet.unwrap_or_else(|| {
        *state.active_sheet.lock().unwrap()
    });
    
    log_info!(
        "PIVOT",
        "source_sheet_idx={} dest_sheet_idx={}",
        source_sheet_idx,
        dest_sheet_idx
    );

    // Get grid data for source
    let grids = state.grids.lock().unwrap();
    let grid = grids
        .get(source_sheet_idx)
        .ok_or_else(|| format!("Sheet index {} not found", source_sheet_idx))?;

    let has_headers = request.has_headers.unwrap_or(true);

    // Build cache from grid
    let (cache, _headers) = build_cache_from_grid(grid, source_start, source_end, has_headers)?;
    drop(grids); // Release lock early

    // Generate new pivot ID
    let mut next_id = state.next_pivot_id.lock().unwrap();
    let pivot_id = *next_id;
    *next_id += 1;
    drop(next_id);

    // Create definition - START EMPTY (no auto-population)
    let mut definition = PivotDefinition::new(pivot_id, source_start, source_end);
    definition.source_has_headers = has_headers;
    definition.destination = destination;

    // Store destination sheet in definition
    {
        let sheet_names = state.sheet_names.lock().unwrap();
        if dest_sheet_idx < sheet_names.len() {
            definition.destination_sheet = Some(sheet_names[dest_sheet_idx].clone());
        }
    }

    // NOTE: We intentionally do NOT auto-populate fields here.
    // The pivot table starts empty - users drag fields into zones via the pivot pane.
    // This gives users full control over the pivot layout from the start.

    // Calculate initial view (will be empty since no fields are configured)
    let mut cache_mut = cache;
    let view = safe_calculate_pivot(&definition, &mut cache_mut);
    let response = view_to_response(&view);

    // Update pivot region tracking (tracks even empty pivots with reserved space)
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

    // Write pivot output to destination grid (empty for now, but reserves the space)
    {
        let mut grids = state.grids.lock().unwrap();
        
        // Verify destination sheet exists
        if dest_sheet_idx >= grids.len() {
            return Err(format!(
                "Destination sheet index {} does not exist (only {} sheets available)",
                dest_sheet_idx,
                grids.len()
            ));
        }
        
        if let Some(dest_grid) = grids.get_mut(dest_sheet_idx) {
            write_pivot_to_grid(dest_grid, &view, destination);
            log_info!(
                "PIVOT",
                "wrote pivot output to grids[{}] at ({},{}) size {}x{}",
                dest_sheet_idx,
                destination.0,
                destination.1,
                view.row_count,
                view.col_count
            );
            
            // IMPORTANT: If dest_sheet is the currently active sheet,
            // we also need to sync state.grid
            let active_sheet = *state.active_sheet.lock().unwrap();
            if dest_sheet_idx == active_sheet {
                let mut grid = state.grid.lock().unwrap();
                // Copy the cells we just wrote to state.grid as well
                for ((r, c), cell) in dest_grid.cells.iter() {
                    grid.set_cell(*r, *c, cell.clone());
                }
                grid.recalculate_bounds();
                log_info!("PIVOT", "synced pivot cells to state.grid (active sheet)");
            }
        } else {
            log_info!("PIVOT", "WARNING: destination sheet {} not found", dest_sheet_idx);
        }
    }

    // Store pivot table
    let mut pivot_tables = state.pivot_tables.lock().unwrap();
    pivot_tables.insert(pivot_id, (definition, cache_mut));

    // Set as active pivot
    let mut active = state.active_pivot_id.lock().unwrap();
    *active = Some(pivot_id);

    log_info!("PIVOT", "created pivot_id={} rows={} (empty - awaiting field configuration)", pivot_id, response.row_count);

    Ok(response)
}

/// Updates the field configuration of an existing pivot table
#[tauri::command]
pub fn update_pivot_fields(
    state: State<AppState>,
    request: UpdatePivotFieldsRequest,
) -> Result<PivotViewResponse, String> {
    log_info!("PIVOT", "update_pivot_fields pivot_id={}", request.pivot_id);

    let mut pivot_tables = state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    // Update row fields
    if let Some(ref row_configs) = request.row_fields {
        definition.row_fields = row_configs
            .iter()
            .map(config_to_pivot_field)
            .collect();
    }

    // Update column fields
    if let Some(ref col_configs) = request.column_fields {
        definition.column_fields = col_configs
            .iter()
            .map(config_to_pivot_field)
            .collect();
    }

    // Update value fields
    if let Some(ref value_configs) = request.value_fields {
        definition.value_fields = value_configs
            .iter()
            .map(config_to_value_field)
            .collect();
    }

    // Update layout
    if let Some(ref layout_config) = request.layout {
        apply_layout_config(&mut definition.layout, layout_config);
    }

    // Bump version for cache invalidation
    definition.bump_version();

    // Recalculate view
    let view = safe_calculate_pivot(definition, cache);
    
    // Get destination info before dropping pivot_tables lock
    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = 0; // TODO: resolve from definition.destination_sheet
    
    drop(pivot_tables);
    
    // Update pivot region tracking
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);
    
    // Write updated pivot output to grid
    {
        let mut grids = state.grids.lock().unwrap();
        if let Some(dest_grid) = grids.get_mut(dest_sheet_idx) {
            // Clear old pivot area first (we don't track old size, so just write new)
            write_pivot_to_grid(dest_grid, &view, destination);
            
            // Sync to state.grid if this is the active sheet
            let active_sheet = *state.active_sheet.lock().unwrap();
            if dest_sheet_idx == active_sheet {
                let mut grid = state.grid.lock().unwrap();
                for ((r, c), cell) in dest_grid.cells.iter() {
                    grid.set_cell(*r, *c, cell.clone());
                }
                grid.recalculate_bounds();
            }
        }
    }
    
    let response = view_to_response(&view);

    log_info!(
        "PIVOT",
        "updated pivot_id={} version={} rows={}",
        request.pivot_id,
        response.version,
        response.row_count
    );

    Ok(response)
}

/// Toggles the expand/collapse state of a pivot group
#[tauri::command]
pub fn toggle_pivot_group(
    state: State<AppState>,
    request: ToggleGroupRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "toggle_pivot_group pivot_id={} is_row={} field_idx={}",
        request.pivot_id,
        request.is_row,
        request.field_index
    );

    let mut pivot_tables = state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    // Get the appropriate field list
    let fields = if request.is_row {
        &mut definition.row_fields
    } else {
        &mut definition.column_fields
    };

    // Find and toggle the field
    if request.field_index >= fields.len() {
        return Err(format!(
            "Field index {} out of range (max {})",
            request.field_index,
            fields.len().saturating_sub(1)
        ));
    }

    let field = &mut fields[request.field_index];
    field.collapsed = !field.collapsed;

    log_debug!(
        "PIVOT",
        "toggled field {} collapsed={}",
        field.name,
        field.collapsed
    );

    // Bump version
    definition.bump_version();

    // Recalculate view
    let view = safe_calculate_pivot(definition, cache);
    
    // Get destination info
    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = 0; // TODO: resolve from definition.destination_sheet
    
    drop(pivot_tables);
    
    // Update pivot region tracking
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);
    
    // Write updated pivot output to grid
    {
        let mut grids = state.grids.lock().unwrap();
        if let Some(dest_grid) = grids.get_mut(dest_sheet_idx) {
            write_pivot_to_grid(dest_grid, &view, destination);
            
            // Sync to state.grid if this is the active sheet
            let active_sheet = *state.active_sheet.lock().unwrap();
            if dest_sheet_idx == active_sheet {
                let mut grid = state.grid.lock().unwrap();
                for ((r, c), cell) in dest_grid.cells.iter() {
                    grid.set_cell(*r, *c, cell.clone());
                }
                grid.recalculate_bounds();
            }
        }
    }
    
    let response = view_to_response(&view);

    Ok(response)
}

/// Gets the current view of a pivot table
#[tauri::command]
pub fn get_pivot_view(
    state: State<AppState>,
    pivot_id: Option<PivotId>,
) -> Result<PivotViewResponse, String> {
    // Use provided ID or active pivot
    let id = match pivot_id {
        Some(id) => id,
        None => {
            let active = state.active_pivot_id.lock().unwrap();
            active.ok_or_else(|| "No active pivot table".to_string())?
        }
    };

    log_debug!("PIVOT", "get_pivot_view pivot_id={}", id);

    let mut pivot_tables = state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&id)
        .ok_or_else(|| format!("Pivot table {} not found", id))?;

    let view = safe_calculate_pivot(definition, cache);
    Ok(view_to_response(&view))
}

/// Deletes a pivot table
#[tauri::command]
pub fn delete_pivot_table(state: State<AppState>, pivot_id: PivotId) -> Result<(), String> {
    log_info!("PIVOT", "delete_pivot_table pivot_id={}", pivot_id);

    let mut pivot_tables = state.pivot_tables.lock().unwrap();
    
    if pivot_tables.remove(&pivot_id).is_none() {
        return Err(format!("Pivot table {} not found", pivot_id));
    }

    // Clear active if this was the active pivot
    let mut active = state.active_pivot_id.lock().unwrap();
    if *active == Some(pivot_id) {
        *active = None;
    }
    
    // Remove pivot region tracking
    let mut regions = state.pivot_regions.lock().unwrap();
    regions.retain(|r| r.pivot_id != pivot_id);

    Ok(())
}

/// Gets source data for drill-down (detail view)
#[tauri::command]
pub fn get_pivot_source_data(
    state: State<AppState>,
    pivot_id: PivotId,
    group_path: Vec<(usize, u32)>,
    max_records: Option<usize>,
) -> Result<SourceDataResponse, String> {
    log_info!(
        "PIVOT",
        "get_pivot_source_data pivot_id={} path_len={}",
        pivot_id,
        group_path.len()
    );

    let pivot_tables = state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    let max = max_records.unwrap_or(1000);
    let result = drill_down(definition, cache, &group_path, max);

    // Convert source rows to formatted strings
    let grids = state.grids.lock().unwrap();
    let source_sheet_idx = 0; // TODO: use definition's source sheet
    let grid = grids
        .get(source_sheet_idx)
        .ok_or_else(|| "Source sheet not found".to_string())?;

    let (start_row, start_col) = definition.source_start;
    let (_, end_col) = definition.source_end;
    let data_start = if definition.source_has_headers {
        start_row + 1
    } else {
        start_row
    };

    let rows: Vec<Vec<String>> = result
        .source_rows
        .iter()
        .map(|&src_row| {
            let grid_row = data_start + src_row;
            (start_col..=end_col)
                .map(|c| {
                    grid.get_cell(grid_row, c)
                        .map(|cell| cell.display_value())
                        .unwrap_or_default()
                })
                .collect()
        })
        .collect();

    Ok(SourceDataResponse {
        pivot_id,
        headers: result.headers,
        rows,
        total_count: result.total_count,
        is_truncated: result.is_truncated,
    })
}

/// Refreshes the pivot cache from current grid data
#[tauri::command]
pub fn refresh_pivot_cache(
    state: State<AppState>,
    pivot_id: PivotId,
) -> Result<PivotViewResponse, String> {
    log_info!("PIVOT", "refresh_pivot_cache pivot_id={}", pivot_id);

    // First, get the definition to know the source range
    let pivot_tables = state.pivot_tables.lock().unwrap();
    let (definition, _) = pivot_tables
        .get(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    let source_start = definition.source_start;
    let source_end = definition.source_end;
    let has_headers = definition.source_has_headers;
    let destination = definition.destination;
    drop(pivot_tables);

    // Get fresh data from grid
    let grids = state.grids.lock().unwrap();
    let source_sheet_idx = 0; // TODO: resolve from definition.destination_sheet
    let grid = grids
        .get(source_sheet_idx)
        .ok_or_else(|| "Source sheet not found".to_string())?;

    let (new_cache, _headers) = build_cache_from_grid(grid, source_start, source_end, has_headers)?;
    drop(grids);

    // Update the stored cache
    let mut pivot_tables = state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    *cache = new_cache;
    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    
    let dest_sheet_idx = 0; // TODO: resolve from definition.destination_sheet
    
    drop(pivot_tables);
    
    // Update pivot region tracking
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);
    
    // Write refreshed pivot output to grid
    {
        let mut grids = state.grids.lock().unwrap();
        if let Some(dest_grid) = grids.get_mut(dest_sheet_idx) {
            write_pivot_to_grid(dest_grid, &view, destination);
            
            // Sync to state.grid if this is the active sheet
            let active_sheet = *state.active_sheet.lock().unwrap();
            if dest_sheet_idx == active_sheet {
                let mut grid = state.grid.lock().unwrap();
                for ((r, c), cell) in dest_grid.cells.iter() {
                    grid.set_cell(*r, *c, cell.clone());
                }
                grid.recalculate_bounds();
            }
        }
    }
    
    let response = view_to_response(&view);

    log_info!(
        "PIVOT",
        "refreshed pivot_id={} version={} rows={}",
        pivot_id,
        response.version,
        response.row_count
    );

    Ok(response)
}

/// Check if a cell is within a pivot region and return pivot info if so
#[tauri::command]
pub fn get_pivot_at_cell(
    state: State<AppState>,
    row: u32,
    col: u32,
) -> Result<Option<PivotRegionInfo>, String> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    
    // Check if cell is in any pivot region
    let pivot_id = match state.is_cell_in_pivot_region(active_sheet, row, col) {
        Some(id) => id,
        None => return Ok(None),
    };
    
    log_debug!("PIVOT", "get_pivot_at_cell ({},{}) found pivot_id={}", row, col, pivot_id);
    
    // Get pivot info
    let pivot_tables = state.pivot_tables.lock().unwrap();
    let (definition, cache) = match pivot_tables.get(&pivot_id) {
        Some(t) => t,
        None => return Ok(None),
    };
    
    let is_empty = !has_fields_configured(definition);
    
    // Build source field info from cache
    let field_count = cache.field_count();
    let source_fields: Vec<SourceFieldInfo> = (0..field_count)
        .map(|i| {
            let name = cache.field_name(i).unwrap_or_else(|| format!("Field{}", i + 1));
            let is_numeric = cache.is_numeric_field(i);
            SourceFieldInfo {
                index: i,
                name,
                is_numeric,
            }
        })
        .collect();
    
    Ok(Some(PivotRegionInfo {
        pivot_id,
        is_empty,
        source_fields,
    }))
}