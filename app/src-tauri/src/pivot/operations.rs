//! FILENAME: app/src-tauri/src/pivot/operations.rs
use std::collections::HashMap;
use crate::api_types::MergedRegion;
use crate::commands::styles::parse_number_format;
use crate::pivot::utils::col_index_to_letter;
use crate::{log_debug, AppState, ProtectedRegion};
use pivot_engine::{calculate_pivot, PivotCache, PivotDefinition, PivotId, PivotView};
use engine::{
    Cell, CellStyle, CellValue, StyleRegistry,
    Borders, BorderStyle, BorderLineStyle, Color, Fill, TextAlign, ThemeColor,
};
use arrow::array::{
    Array, BooleanArray, Date32Array, Decimal128Array,
    Float32Array, Float64Array, Int16Array, Int32Array, Int64Array,
    StringArray, TimestampMicrosecondArray,
};
use arrow::datatypes::DataType as ArrowDataType;
use arrow::record_batch::RecordBatch;

// ============================================================================
// CONSTANTS
// ============================================================================

/// Minimum reserved rows for an empty pivot table placeholder
const EMPTY_PIVOT_ROWS: u32 = 18;
/// Minimum reserved columns for an empty pivot table placeholder
const EMPTY_PIVOT_COLS: u32 = 3;

// ============================================================================
// GRID & LOGIC OPERATIONS
// ============================================================================

/// Creates an empty pivot view for when no fields are configured
pub(crate) fn create_empty_view(pivot_id: PivotId, version: u64) -> PivotView {
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
        filter_row_count: 0,     // Added missing field
        filter_rows: Vec::new(), // Added missing field
        row_field_summaries: Vec::new(),
        column_field_summaries: Vec::new(),
    }
}

/// Check if the pivot definition has any fields configured
pub(crate) fn has_fields_configured(definition: &PivotDefinition) -> bool {
    !definition.row_fields.is_empty() 
        || !definition.column_fields.is_empty() 
        || !definition.value_fields.is_empty()
}

/// Safely calculate pivot - returns empty view if no fields configured
pub(crate) fn safe_calculate_pivot(definition: &PivotDefinition, cache: &mut PivotCache) -> PivotView {
    if !has_fields_configured(definition) {
        log_debug!("PIVOT", "No fields configured, returning empty view");
        return create_empty_view(definition.id, definition.version);
    }
    calculate_pivot(definition, cache)
}

/// Builds a PivotCache from grid data.
///
/// When the source range extends well beyond the grid's actual data (e.g. the
/// user selected entire columns A:D which resolves to A1:D1048576), the end row
/// is automatically clamped to the last populated row in the grid.  This matches
/// Excel's behaviour where full-column references only include populated cells.
pub(crate) fn build_cache_from_grid(
    grid: &engine::Grid,
    start: (u32, u32),
    end: (u32, u32),
    has_headers: bool,
) -> Result<(PivotCache, Vec<String>), String> {
    let (start_row, start_col) = start;
    let (mut end_row, end_col) = end;

    // Clamp end_row to the grid's last populated row so that full-column
    // selections (e.g. A:D -> A1:D1048576) don't iterate over a million
    // empty rows.
    if end_row > grid.max_row {
        end_row = grid.max_row;
    }

    let col_count = (end_col - start_col + 1) as usize;

    // If the (clamped) end row is before the start row there is no data.
    if end_row < start_row {
        let headers: Vec<String> = (0..col_count)
            .map(|i| col_index_to_letter(i as u32))
            .collect();
        let cache = PivotCache::new(1, col_count);
        return Ok((cache, headers));
    }

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

    // Find the actual last row with data within this column range.
    // grid.max_row is a global bound — data in other columns may push it
    // beyond what these specific columns contain.
    let mut effective_end_row = data_start_row.saturating_sub(1);
    for row in (data_start_row..=end_row).rev() {
        let has_data = (start_col..=end_col)
            .any(|col| grid.get_cell(row, col).is_some());
        if has_data {
            effective_end_row = row;
            break;
        }
    }

    // Create cache
    let mut cache = PivotCache::new(1, col_count);

    // Set field names
    for (i, name) in headers.iter().enumerate() {
        cache.set_field_name(i, name.clone());
    }

    // Add records up to the last row with data
    for row in data_start_row..=effective_end_row {
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

/// Builds a PivotCache from Arrow RecordBatches (BI query results).
/// Each column in the batch becomes a cache field.
pub(crate) fn build_cache_from_arrow_batches(
    pivot_id: PivotId,
    batches: &[RecordBatch],
) -> Result<PivotCache, String> {
    if batches.is_empty() {
        return Ok(PivotCache::new(pivot_id, 0));
    }

    let schema = batches[0].schema();
    let field_count = schema.fields().len();
    let mut cache = PivotCache::new(pivot_id, field_count);

    // Set field names from schema
    for (i, field) in schema.fields().iter().enumerate() {
        cache.set_field_name(i, field.name().clone());
    }

    // Add records from all batches
    let mut source_row: u32 = 0;
    for batch in batches {
        for row_idx in 0..batch.num_rows() {
            let mut values: Vec<CellValue> = Vec::with_capacity(field_count);
            for col_idx in 0..batch.num_columns() {
                let col = batch.column(col_idx);
                values.push(arrow_cell_to_value(col.as_ref(), row_idx));
            }
            cache.add_record(source_row, &values);
            source_row += 1;
        }
    }

    Ok(cache)
}

/// Convert an Arrow array cell to a CellValue for the PivotCache.
fn arrow_cell_to_value(array: &dyn Array, idx: usize) -> CellValue {
    if array.is_null(idx) {
        return CellValue::Empty;
    }
    match array.data_type() {
        ArrowDataType::Int16 => {
            let a = array.as_any().downcast_ref::<Int16Array>().unwrap();
            CellValue::Number(a.value(idx) as f64)
        }
        ArrowDataType::Int32 => {
            let a = array.as_any().downcast_ref::<Int32Array>().unwrap();
            CellValue::Number(a.value(idx) as f64)
        }
        ArrowDataType::Int64 => {
            let a = array.as_any().downcast_ref::<Int64Array>().unwrap();
            CellValue::Number(a.value(idx) as f64)
        }
        ArrowDataType::Float32 => {
            let a = array.as_any().downcast_ref::<Float32Array>().unwrap();
            CellValue::Number(a.value(idx) as f64)
        }
        ArrowDataType::Float64 => {
            let a = array.as_any().downcast_ref::<Float64Array>().unwrap();
            CellValue::Number(a.value(idx))
        }
        ArrowDataType::Utf8 => {
            let a = array.as_any().downcast_ref::<StringArray>().unwrap();
            CellValue::Text(a.value(idx).to_string())
        }
        ArrowDataType::Boolean => {
            let a = array.as_any().downcast_ref::<BooleanArray>().unwrap();
            CellValue::Boolean(a.value(idx))
        }
        ArrowDataType::Date32 => {
            let a = array.as_any().downcast_ref::<Date32Array>().unwrap();
            let days = a.value(idx);
            let date = chrono::NaiveDate::from_num_days_from_ce_opt(days + 719_163);
            match date {
                Some(d) => CellValue::Text(d.format("%Y-%m-%d").to_string()),
                None => CellValue::Number(days as f64),
            }
        }
        ArrowDataType::Timestamp(arrow::datatypes::TimeUnit::Microsecond, _) => {
            let a = array.as_any().downcast_ref::<TimestampMicrosecondArray>().unwrap();
            let us = a.value(idx);
            let secs = us / 1_000_000;
            let nsecs = ((us % 1_000_000) * 1000) as u32;
            let dt = chrono::DateTime::from_timestamp(secs, nsecs);
            match dt {
                Some(d) => CellValue::Text(d.format("%Y-%m-%d %H:%M:%S").to_string()),
                None => CellValue::Number(us as f64),
            }
        }
        ArrowDataType::Decimal128(_, scale) => {
            let a = array.as_any().downcast_ref::<Decimal128Array>().unwrap();
            let raw = a.value(idx);
            let scale = *scale as u32;
            let divisor = 10f64.powi(scale as i32);
            CellValue::Number(raw as f64 / divisor)
        }
        _ => CellValue::Text(format!("<unsupported: {:?}>", array.data_type())),
    }
}

/// Builds a PivotCache from Arrow RecordBatches with a synthetic "Total"
/// dimension column prepended. Used when a BI pivot has measures but no
/// group-by dimensions.
pub(crate) fn build_cache_with_synthetic_dim(
    pivot_id: PivotId,
    batches: &[RecordBatch],
) -> Result<PivotCache, String> {
    if batches.is_empty() {
        let mut cache = PivotCache::new(pivot_id, 1);
        cache.set_field_name(0, "Total".to_string());
        return Ok(cache);
    }

    let schema = batches[0].schema();
    let orig_field_count = schema.fields().len();
    let total_fields = orig_field_count + 1; // +1 for synthetic "Total"

    let mut cache = PivotCache::new(pivot_id, total_fields);
    cache.set_field_name(0, "Total".to_string());
    for (i, field) in schema.fields().iter().enumerate() {
        cache.set_field_name(i + 1, field.name().clone());
    }

    let mut source_row: u32 = 0;
    for batch in batches {
        for row_idx in 0..batch.num_rows() {
            let mut values: Vec<CellValue> = Vec::with_capacity(total_fields);
            values.push(CellValue::Text("Total".to_string()));
            for col_idx in 0..batch.num_columns() {
                let col = batch.column(col_idx);
                values.push(arrow_cell_to_value(col.as_ref(), row_idx));
            }
            cache.add_record(source_row, &values);
            source_row += 1;
        }
    }

    Ok(cache)
}

/// Resolves the destination sheet index from a pivot definition.
/// Falls back to active sheet if destination_sheet is not set or not found.
pub(crate) fn resolve_dest_sheet_index(state: &AppState, definition: &PivotDefinition) -> usize {
    if let Some(ref sheet_name) = definition.destination_sheet {
        let sheet_names = state.sheet_names.lock().unwrap();
        for (idx, name) in sheet_names.iter().enumerate() {
            if name == sheet_name {
                return idx;
            }
        }
    }
    // Fallback to active sheet
    *state.active_sheet.lock().unwrap()
}

/// Clears cells in a pivot region from the grid.
pub(crate) fn clear_pivot_region_from_grid(
    grid: &mut engine::Grid,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) {
    log_debug!(
        "PIVOT",
        "clear_pivot_region_from_grid: ({},{}) to ({},{})",
        start_row,
        start_col,
        end_row,
        end_col
    );

    grid.clear_region(start_row, start_col, end_row, end_col);
}

/// Gets the current protected region for a pivot ID, if it exists.
pub(crate) fn get_pivot_region(state: &AppState, pivot_id: PivotId) -> Option<ProtectedRegion> {
    let regions = state.protected_regions.lock().unwrap();
    regions.iter().find(|r| r.region_type == "pivot" && r.owner_id == pivot_id as u64).cloned()
}

// ============================================================================
// PIVOT THEME COLORS (matches frontend DEFAULT_PIVOT_THEME)
// ============================================================================

const PIVOT_HEADER_BG: Color = Color::new(192, 230, 245);       // #C0E6F5
const PIVOT_TOTAL_BG: Color = Color::new(232, 232, 232);        // #e8e8e8
const PIVOT_GRAND_TOTAL_BG: Color = Color::new(192, 230, 245);  // #C0E6F5
const PIVOT_FILTER_BG: Color = Color::new(217, 217, 217);       // #D9D9D9
const PIVOT_BORDER_COLOR: Color = Color::new(232, 232, 232);    // #e8e8e8
const PIVOT_HEADER_BORDER: Color = Color::new(160, 208, 232);   // #a0d0e8

/// Cache key for deduplicating pivot cell styles.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct PivotStyleKey {
    background_style: u8,
    is_bold: bool,
    indent_level: u8,
    text_align: u8,
    number_format_key: String,
    border_key: u8,
}

/// Build a full CellStyle for a pivot cell based on its metadata.
fn build_pivot_cell_style(
    pivot_cell: &pivot_engine::PivotViewCell,
    styles: &mut StyleRegistry,
    style_cache: &mut HashMap<PivotStyleKey, usize>,
) -> usize {
    use pivot_engine::{BackgroundStyle, PivotCellType};

    // Determine bold
    let is_bold = pivot_cell.is_bold
        || pivot_cell.is_expandable
        || matches!(
            pivot_cell.cell_type,
            PivotCellType::FilterLabel | PivotCellType::RowLabelHeader | PivotCellType::ColumnLabelHeader
        )
        || matches!(
            pivot_cell.background_style,
            BackgroundStyle::Header | BackgroundStyle::Subtotal | BackgroundStyle::Total | BackgroundStyle::GrandTotal
        );

    // Determine text alignment
    let text_align = match pivot_cell.cell_type {
        PivotCellType::Data
        | PivotCellType::RowSubtotal
        | PivotCellType::ColumnSubtotal
        | PivotCellType::GrandTotal
        | PivotCellType::GrandTotalRow
        | PivotCellType::GrandTotalColumn
        | PivotCellType::FilterLabel => TextAlign::Right,
        _ => TextAlign::Left,
    };

    // Border key: encode the border configuration as a single byte
    let border_key: u8 = match pivot_cell.background_style {
        BackgroundStyle::Header => 1,       // bottom 2px
        BackgroundStyle::Subtotal | BackgroundStyle::Total => 2, // top+bottom 1px
        BackgroundStyle::GrandTotal => 3,   // top+bottom 2px
        BackgroundStyle::FilterRow => 4,    // bottom 1px
        _ => 0,                             // no borders
    };

    // Background style as u8
    let bg_key: u8 = match pivot_cell.background_style {
        BackgroundStyle::Normal => 0,
        BackgroundStyle::Header => 1,
        BackgroundStyle::Subtotal => 2,
        BackgroundStyle::Total => 3,
        BackgroundStyle::GrandTotal => 4,
        BackgroundStyle::Alternate => 5,
        BackgroundStyle::FilterRow => 6,
    };

    // Text align as u8
    let align_key: u8 = match text_align {
        TextAlign::Right => 1,
        _ => 0,
    };

    let nf_key = pivot_cell.number_format.clone().unwrap_or_default();

    let cache_key = PivotStyleKey {
        background_style: bg_key,
        is_bold,
        indent_level: pivot_cell.indent_level,
        text_align: align_key,
        number_format_key: nf_key.clone(),
        border_key,
    };

    if let Some(&cached_idx) = style_cache.get(&cache_key) {
        return cached_idx;
    }

    // Build the fill
    let fill = match pivot_cell.background_style {
        BackgroundStyle::Header => Fill::Solid { color: ThemeColor::Absolute(PIVOT_HEADER_BG) },
        BackgroundStyle::Subtotal | BackgroundStyle::Total => Fill::Solid { color: ThemeColor::Absolute(PIVOT_TOTAL_BG) },
        BackgroundStyle::GrandTotal => Fill::Solid { color: ThemeColor::Absolute(PIVOT_GRAND_TOTAL_BG) },
        BackgroundStyle::FilterRow => Fill::Solid { color: ThemeColor::Absolute(PIVOT_FILTER_BG) },
        _ => Fill::Solid { color: ThemeColor::Absolute(Color::white()) },
    };

    // Build borders
    let borders = match pivot_cell.background_style {
        BackgroundStyle::Header => Borders {
            bottom: BorderStyle { width: 2, color: ThemeColor::Absolute(PIVOT_HEADER_BORDER), style: BorderLineStyle::Solid },
            ..Borders::default()
        },
        BackgroundStyle::Subtotal | BackgroundStyle::Total => Borders {
            top: BorderStyle { width: 1, color: ThemeColor::Absolute(PIVOT_BORDER_COLOR), style: BorderLineStyle::Solid },
            bottom: BorderStyle { width: 1, color: ThemeColor::Absolute(PIVOT_BORDER_COLOR), style: BorderLineStyle::Solid },
            ..Borders::default()
        },
        BackgroundStyle::GrandTotal => Borders {
            top: BorderStyle { width: 2, color: ThemeColor::Absolute(PIVOT_HEADER_BORDER), style: BorderLineStyle::Solid },
            bottom: BorderStyle { width: 2, color: ThemeColor::Absolute(PIVOT_HEADER_BORDER), style: BorderLineStyle::Solid },
            ..Borders::default()
        },
        BackgroundStyle::FilterRow => Borders {
            bottom: BorderStyle { width: 1, color: ThemeColor::Absolute(PIVOT_BORDER_COLOR), style: BorderLineStyle::Solid },
            ..Borders::default()
        },
        _ => Borders::default(),
    };

    // Build number format
    let nf = if !nf_key.is_empty() {
        parse_number_format(&nf_key)
    } else {
        engine::NumberFormat::General
    };

    // Assemble the full style
    let mut style = CellStyle::new()
        .with_bold(is_bold)
        .with_fill(fill)
        .with_text_align(text_align)
        .with_number_format(nf);
    style.borders = borders;
    style.indent = pivot_cell.indent_level;

    let idx = styles.get_or_create(style);
    style_cache.insert(cache_key, idx);
    idx
}

/// Writes pivot view cells to the destination grid.
/// Creates full cell styles (fill, bold, borders, alignment, indent, number format)
/// so that pivot cells render correctly via the grid renderer without an overlay.
/// Returns a list of merge regions for cells with col_span/row_span > 1.
pub(crate) fn write_pivot_to_grid(
    grid: &mut engine::Grid,
    mut active_grid: Option<&mut engine::Grid>,
    view: &PivotView,
    destination: (u32, u32),
    styles: &mut StyleRegistry,
) -> Vec<MergedRegion> {
    let (dest_row, dest_col) = destination;

    log_debug!(
        "PIVOT",
        "write_pivot_to_grid: dest=({},{}) view_size={}x{} dual_write={}",
        dest_row,
        dest_col,
        view.row_count,
        view.col_count,
        active_grid.is_some()
    );

    // If view is empty, nothing to write
    if view.row_count == 0 || view.col_count == 0 {
        log_debug!("PIVOT", "Empty view, nothing to write to grid");
        return Vec::new();
    }

    // Collect merge regions for cells with col_span/row_span > 1
    let mut merge_regions: Vec<MergedRegion> = Vec::new();

    // Cache: composite style key → style_index. Avoids redundant style lookups.
    let mut style_cache: HashMap<PivotStyleKey, usize> = HashMap::new();

    // Pre-allocate grid capacity to avoid HashMap resizing during bulk insert.
    let cell_count = view.row_count * view.col_count;
    grid.cells.reserve(cell_count);
    if let Some(ref mut ag) = active_grid {
        ag.cells.reserve(cell_count);
    }

    // Iterate through all rows, skipping hidden ones.
    // Use view_row (sequential visible index) for grid positioning so that
    // collapsed rows don't leave gaps or write cells beyond the pivot region.
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
            let grid_row = dest_row + row_descriptor.view_row as u32;
            let grid_col = dest_col + col_idx as u32;

            // Determine CellValue and style_index (shared between both grid writes)
            let cell_value = match &pivot_cell.value {
                pivot_engine::PivotCellValue::Empty => CellValue::Empty,
                pivot_engine::PivotCellValue::Number(n) => CellValue::Number(*n),
                pivot_engine::PivotCellValue::Text(s) => {
                    if s.is_empty() {
                        CellValue::Empty
                    } else {
                        CellValue::Text(s.clone())
                    }
                }
                pivot_engine::PivotCellValue::Boolean(b) => CellValue::Boolean(*b),
                pivot_engine::PivotCellValue::Error(e) => CellValue::Text(format!("#{}", e)),
            };

            // Build full cell style (fill, bold, borders, alignment, indent, number format)
            let style_idx = build_pivot_cell_style(pivot_cell, styles, &mut style_cache);

            // Write to both grids using unchecked insert (bounds set once after loop)
            if let Some(ag) = active_grid.as_deref_mut() {
                ag.set_cell_unchecked(grid_row, grid_col, Cell {
                    formula: None,
                    value: cell_value.clone(),
                    style_index: style_idx,
                    rich_text: None,
                    cached_ast: None,
                });
            }
            grid.set_cell_unchecked(grid_row, grid_col, Cell {
                formula: None,
                value: cell_value,
                style_index: style_idx,
                rich_text: None,
                cached_ast: None,
            });

            // Collect merge regions for spanned cells
            if pivot_cell.col_span > 1 || pivot_cell.row_span > 1 {
                merge_regions.push(MergedRegion {
                    start_row: grid_row,
                    start_col: grid_col,
                    end_row: grid_row + (pivot_cell.row_span as u32).max(1) - 1,
                    end_col: grid_col + (pivot_cell.col_span as u32).max(1) - 1,
                });
            }
        }
    }

    // Update bounds once for the entire region (instead of per-cell)
    if view.row_count > 0 && view.col_count > 0 {
        let end_row = dest_row + view.row_count as u32 - 1;
        let end_col = dest_col + view.col_count as u32 - 1;
        grid.update_bounds(end_row, end_col);
        if let Some(ag) = active_grid.as_deref_mut() {
            ag.update_bounds(end_row, end_col);
        }
    }

    log_debug!(
        "PIVOT",
        "write_pivot_to_grid: wrote {} rows to grid ({} merge regions)",
        view.rows.iter().filter(|r| r.visible).count(),
        merge_regions.len()
    );

    merge_regions
}

/// Updates the pivot region tracking for a pivot table.
pub(crate) fn update_pivot_region(
    state: &AppState,
    pivot_id: PivotId,
    sheet_index: usize,
    destination: (u32, u32),
    view: &PivotView,
) {
    let mut regions = state.protected_regions.lock().unwrap();

    // Remove any existing region for this pivot
    regions.retain(|r| !(r.region_type == "pivot" && r.owner_id == pivot_id as u64));
    
    let (dest_row, dest_col) = destination;
    
    // Calculate region size - use actual view size or minimum reserved size for empty pivots
    let (end_row, end_col) = if view.row_count > 0 && view.col_count > 0 {
        // Count all rows in the view (headers + data)
        let total_rows = view.row_count as u32;
        let total_cols = view.col_count as u32;
        (
            dest_row + total_rows.saturating_sub(1),
            dest_col + total_cols.saturating_sub(1),
        )
    } else {
        // Empty pivot - reserve minimum space for placeholder
        (
            dest_row + EMPTY_PIVOT_ROWS - 1,
            dest_col + EMPTY_PIVOT_COLS - 1,
        )
    };
    
    regions.push(ProtectedRegion {
        id: format!("pivot-{}", pivot_id),
        region_type: "pivot".to_string(),
        owner_id: pivot_id as u64,
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

/// Clears the old pivot region and writes the new view to the grid.
/// Also syncs to state.grid if needed.
pub(crate) fn update_pivot_in_grid(
    state: &AppState,
    pivot_id: PivotId,
    dest_sheet_idx: usize,
    destination: (u32, u32),
    view: &PivotView,
) {
    // Get old region before writing new data
    let old_region = get_pivot_region(state, pivot_id);

    let mut styles = state.style_registry.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    if let Some(dest_grid) = grids.get_mut(dest_sheet_idx) {
        // Clear old pivot area first if it exists
        if let Some(ref region) = old_region {
            if region.sheet_index == dest_sheet_idx {
                clear_pivot_region_from_grid(
                    dest_grid,
                    region.start_row,
                    region.start_col,
                    region.end_row,
                    region.end_col,
                );
            }
        }

        // Check if this is the active sheet — if so, write to both grids in one pass
        let active_sheet = *state.active_sheet.lock().unwrap();
        let is_active = dest_sheet_idx == active_sheet;

        let pivot_merges = if is_active {
            let mut active_grid = state.grid.lock().unwrap();

            // Clear old region from active grid too
            if let Some(ref region) = old_region {
                if region.sheet_index == dest_sheet_idx {
                    active_grid.clear_region(
                        region.start_row,
                        region.start_col,
                        region.end_row,
                        region.end_col,
                    );
                }
            }

            // Single-pass write to both grids (eliminates second iteration + clones)
            let merges = write_pivot_to_grid(dest_grid, Some(&mut active_grid), view, destination, &mut styles);
            active_grid.recalculate_bounds();
            log_debug!("PIVOT", "wrote pivot to both grids in single pass (active sheet)");
            merges
        } else {
            // Not the active sheet — write to sheet grid only
            write_pivot_to_grid(dest_grid, None, view, destination, &mut styles)
        };
        let (dest_row, dest_col) = destination;
        let new_end_row = dest_row + view.row_count.max(1) as u32 - 1;
        let new_end_col = dest_col + view.col_count.max(1) as u32 - 1;

        let mut merged = state.merged_regions.lock().unwrap();

        // Remove merges in old pivot region
        if let Some(ref region) = old_region {
            merged.retain(|m| {
                !(m.start_row >= region.start_row && m.end_row <= region.end_row
                    && m.start_col >= region.start_col && m.end_col <= region.end_col)
            });
        }
        // Also remove merges in new pivot region (in case of overlap)
        merged.retain(|m| {
            !(m.start_row >= dest_row && m.end_row <= new_end_row
                && m.start_col >= dest_col && m.end_col <= new_end_col)
        });

        // Add new pivot merge regions
        for mr in pivot_merges {
            merged.insert(mr);
        }
    }
}

/// Auto-fit column widths for a pivot table based on cell content.
/// Scans all visible cells in the view and sets each column width to fit
/// the longest formatted value, using a character-based width estimate.
pub(crate) fn auto_fit_pivot_columns(
    state: &AppState,
    destination: (u32, u32),
    view: &PivotView,
) {
    if view.col_count == 0 || view.row_count == 0 {
        return;
    }

    let (_dest_row, dest_col) = destination;

    // Approximate pixel width per character (Segoe UI ~12px font).
    // Average character width for proportional text is ~6.2px at 12px font size.
    // The renderer uses CELL_PADDING_X = 6 on each side (12px total).
    const CHAR_WIDTH: f64 = 6.2;
    const CELL_PADDING: f64 = 12.0;
    const MIN_WIDTH: f64 = 40.0;
    const MAX_WIDTH: f64 = 400.0;

    // Find max display text length per column, including formatted numbers
    let mut max_len: Vec<usize> = vec![0; view.col_count];

    for (row_idx, row_desc) in view.rows.iter().enumerate() {
        if !row_desc.visible {
            continue;
        }
        if row_idx >= view.cells.len() {
            continue;
        }
        let row_cells = &view.cells[row_idx];
        for (col_idx, cell) in row_cells.iter().enumerate() {
            if col_idx >= max_len.len() {
                break;
            }
            // Get the display text: use formatted number if available,
            // fall back to formatted_value, then raw number string
            let display = if let Some(ref fmt) = cell.number_format {
                if !fmt.is_empty() {
                    if let pivot_engine::PivotCellValue::Number(n) = &cell.value {
                        engine::format_number(*n, &parse_number_format(fmt), &engine::LocaleSettings::invariant())
                    } else {
                        cell.formatted_value.clone()
                    }
                } else {
                    cell.formatted_value.clone()
                }
            } else if cell.formatted_value.is_empty() {
                // No number format and no formatted_value: use raw value string
                match &cell.value {
                    pivot_engine::PivotCellValue::Number(n) => {
                        // Format integers without decimal point
                        if n.fract() == 0.0 && n.abs() < 1e15 {
                            format!("{}", *n as i64)
                        } else {
                            format!("{}", n)
                        }
                    }
                    _ => cell.formatted_value.clone(),
                }
            } else {
                cell.formatted_value.clone()
            };
            let len = display.len();
            // Account for indent in compact layout (~20px per level = ~3.2 chars)
            let extra = (cell.indent_level as usize) * 3
                + if cell.is_expandable { 3 } else { 0 };
            let effective_len = len + extra;
            if effective_len > max_len[col_idx] {
                max_len[col_idx] = effective_len;
            }
        }
    }

    // Apply column widths
    let mut widths = state.column_widths.lock().unwrap();
    for (col_idx, &char_len) in max_len.iter().enumerate() {
        let grid_col = dest_col + col_idx as u32;
        let width = ((char_len as f64) * CHAR_WIDTH + CELL_PADDING)
            .max(MIN_WIDTH)
            .min(MAX_WIDTH);
        widths.insert(grid_col, width);
    }

    log_debug!(
        "PIVOT",
        "auto_fit_pivot_columns: set {} column widths (cols {}..{})",
        view.col_count,
        dest_col,
        dest_col + view.col_count as u32 - 1
    );
}

/// Looks up a value in a pivot table for GETPIVOTDATA.
/// Searches all pivot tables to find one containing the referenced cell,
/// then queries it for the matching aggregated value.
pub fn lookup_pivot_data(
    pivot_tables: &HashMap<PivotId, (PivotDefinition, PivotCache)>,
    pivot_views: &HashMap<PivotId, PivotView>,
    data_field: &str,
    pivot_row: u32,
    pivot_col: u32,
    field_item_pairs: &[(&str, &str)],
) -> Option<f64> {
    // Find which pivot table contains the referenced cell
    let (pivot_id, view) = pivot_views.iter().find(|(_id, v)| {
        // Check if the cell falls within this view's region
        // We need the definition to know the destination
        if let Some((def, _cache)) = pivot_tables.get(_id) {
            let (dest_row, dest_col) = def.destination;
            let end_row = dest_row + v.row_count as u32;
            let end_col = dest_col + v.col_count as u32;
            pivot_row >= dest_row && pivot_row < end_row
                && pivot_col >= dest_col && pivot_col < end_col
        } else {
            false
        }
    })?;

    let (definition, _cache) = pivot_tables.get(pivot_id)?;

    // Find the value field by name (case-insensitive)
    let data_field_lower = data_field.to_lowercase();
    let vf_idx = definition.value_fields.iter().position(|vf| {
        vf.name.to_lowercase() == data_field_lower
    })?;

    // If no field/item pairs, return the grand total for this value field
    if field_item_pairs.is_empty() {
        // Compute grand total by looking at the view's grand total row
        // Find the grand total value in the view
        for row_cells in &view.cells {
            for cell in row_cells {
                if cell.cell_type == pivot_engine::PivotCellType::GrandTotal {
                    if let pivot_engine::PivotCellValue::Number(n) = cell.value {
                        return Some(n);
                    }
                }
            }
        }
        return None;
    }

    // With field/item pairs: we need to find the specific cell in the view
    // that matches ALL the field/item criteria.
    // Strategy: search the view cells for a data cell whose row/column headers
    // match the specified field/item pairs.

    // Build a lookup: for each row, collect its header labels
    let row_label_cols = view.row_label_col_count;
    let header_rows = view.column_header_row_count + view.filter_row_count;

    // For each data row, check if its row headers match the criteria
    for (view_row_idx, row_cells) in view.cells.iter().enumerate() {
        if view_row_idx < header_rows {
            continue; // Skip header rows
        }

        // Collect row header labels for this row
        let row_headers: Vec<&str> = row_cells.iter()
            .take(row_label_cols)
            .filter(|c| matches!(c.cell_type,
                pivot_engine::PivotCellType::RowHeader | pivot_engine::PivotCellType::RowLabelHeader))
            .map(|c| c.formatted_value.as_str())
            .collect();

        // Check if this row matches the field/item criteria for row fields
        let row_matches = field_item_pairs.iter().all(|(_field, item)| {
            row_headers.iter().any(|h| h.eq_ignore_ascii_case(item))
        });

        if !row_matches {
            continue;
        }

        // Now find the data cell for the correct value field
        let data_cells: Vec<&pivot_engine::PivotViewCell> = row_cells.iter()
            .skip(row_label_cols)
            .filter(|c| matches!(c.cell_type, pivot_engine::PivotCellType::Data))
            .collect();

        // The vf_idx-th data cell (in a simple layout) is the one we want
        if let Some(cell) = data_cells.get(vf_idx) {
            if let pivot_engine::PivotCellValue::Number(n) = cell.value {
                return Some(n);
            }
        }
    }

    None
}