//! FILENAME: app/src-tauri/src/consolidate.rs
// PURPOSE: Data consolidation engine - aggregates data across sheets.
// CONTEXT: Supports both "by position" and "by category" consolidation
//          modes, with 11 aggregation functions (SUM, COUNT, AVERAGE,
//          MAX, MIN, PRODUCT, COUNT NUMS, STDEV, STDEVP, VAR, VARP).

use std::collections::{HashMap, HashSet};
use tauri::State;

use crate::api_types::{
    CellData, ConsolidateParams, ConsolidateResult, ConsolidationFunction,
    ConsolidationSourceRange, MergedRegion,
};
use crate::{format_cell_value, AppState};
use engine::{Cell, CellValue, Grid, StyleRegistry};

// ============================================================================
// Aggregation
// ============================================================================

/// Apply the chosen aggregation function to a slice of numeric values.
/// Empty slices return 0.0 for most functions (matching Excel behavior).
fn aggregate(values: &[f64], function: ConsolidationFunction) -> f64 {
    if values.is_empty() {
        return match function {
            ConsolidationFunction::Count | ConsolidationFunction::CountNums => 0.0,
            ConsolidationFunction::Product => 1.0,
            _ => 0.0,
        };
    }

    match function {
        ConsolidationFunction::Sum => values.iter().sum(),
        ConsolidationFunction::Count | ConsolidationFunction::CountNums => values.len() as f64,
        ConsolidationFunction::Average => {
            let sum: f64 = values.iter().sum();
            sum / values.len() as f64
        }
        ConsolidationFunction::Max => values.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
        ConsolidationFunction::Min => values.iter().cloned().fold(f64::INFINITY, f64::min),
        ConsolidationFunction::Product => values.iter().product(),
        ConsolidationFunction::StdDev => sample_std_dev(values),
        ConsolidationFunction::StdDevP => population_std_dev(values),
        ConsolidationFunction::Var => sample_variance(values),
        ConsolidationFunction::VarP => population_variance(values),
    }
}

fn mean(values: &[f64]) -> f64 {
    values.iter().sum::<f64>() / values.len() as f64
}

fn population_variance(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let m = mean(values);
    values.iter().map(|v| (v - m).powi(2)).sum::<f64>() / values.len() as f64
}

fn sample_variance(values: &[f64]) -> f64 {
    if values.len() < 2 {
        return 0.0;
    }
    let m = mean(values);
    values.iter().map(|v| (v - m).powi(2)).sum::<f64>() / (values.len() as f64 - 1.0)
}

fn population_std_dev(values: &[f64]) -> f64 {
    population_variance(values).sqrt()
}

fn sample_std_dev(values: &[f64]) -> f64 {
    sample_variance(values).sqrt()
}

// ============================================================================
// Cell value extraction
// ============================================================================

/// Extract a numeric value from a cell, returning None for text/empty/error.
fn get_numeric_value(grid: &Grid, row: u32, col: u32) -> Option<f64> {
    match grid.get_cell(row, col) {
        Some(cell) => match &cell.value {
            CellValue::Number(n) if n.is_finite() => Some(*n),
            CellValue::Boolean(true) => Some(1.0),
            CellValue::Boolean(false) => Some(0.0),
            _ => None, // Text, Empty, Error, NaN, Infinity are ignored
        },
        None => None,
    }
}

/// Extract the display text of a cell for use as a header label.
fn get_header_text(grid: &Grid, row: u32, col: u32) -> String {
    match grid.get_cell(row, col) {
        Some(cell) => match &cell.value {
            CellValue::Text(s) => s.clone(),
            CellValue::Number(n) => format!("{}", n),
            CellValue::Boolean(b) => {
                if *b {
                    "TRUE".to_string()
                } else {
                    "FALSE".to_string()
                }
            }
            CellValue::Empty => String::new(),
            CellValue::Error(_) => String::new(),
        },
        None => String::new(),
    }
}

// ============================================================================
// Error helper
// ============================================================================

fn error_result(msg: &str) -> ConsolidateResult {
    ConsolidateResult {
        success: false,
        rows_written: 0,
        cols_written: 0,
        updated_cells: Vec::new(),
        error: Some(msg.to_string()),
    }
}

// ============================================================================
// CellData builder
// ============================================================================

fn build_cell_data(
    grid: &Grid,
    styles: &StyleRegistry,
    merged_regions: &HashSet<MergedRegion>,
    row: u32,
    col: u32,
    sheet_index: Option<usize>,
) -> Option<CellData> {
    let cell = grid.get_cell(row, col)?;
    let style = styles.get(cell.style_index);
    let display = format_cell_value(&cell.value, style);

    let merge = merged_regions
        .iter()
        .find(|m| m.start_row == row && m.start_col == col);
    let (row_span, col_span) = match merge {
        Some(m) => (m.end_row - m.start_row + 1, m.end_col - m.start_col + 1),
        None => (1, 1),
    };

    Some(CellData {
        row,
        col,
        display,
        formula: cell.formula.clone(),
        style_index: cell.style_index,
        row_span,
        col_span,
        sheet_index,
    })
}

// ============================================================================
// Position-based consolidation
// ============================================================================

/// Consolidate by position: all source ranges must have identical dimensions.
/// Returns a vector of (relative_row, relative_col, aggregated_value).
fn consolidate_by_position(
    grids: &[Grid],
    params: &ConsolidateParams,
) -> Result<Vec<(u32, u32, f64)>, String> {
    let first = &params.source_ranges[0];
    let num_rows = first.end_row - first.start_row + 1;
    let num_cols = first.end_col - first.start_col + 1;

    // Validate all ranges have the same dimensions
    for (i, range) in params.source_ranges.iter().enumerate() {
        let r = range.end_row - range.start_row + 1;
        let c = range.end_col - range.start_col + 1;
        if r != num_rows || c != num_cols {
            return Err(format!(
                "Source range {} has dimensions {}x{}, but range 1 has {}x{}. \
                 All ranges must have the same size for position-based consolidation.",
                i + 1,
                r,
                c,
                num_rows,
                num_cols
            ));
        }
    }

    let mut results = Vec::new();

    for rel_r in 0..num_rows {
        for rel_c in 0..num_cols {
            let mut values = Vec::new();
            for range in &params.source_ranges {
                let abs_row = range.start_row + rel_r;
                let abs_col = range.start_col + rel_c;
                if let Some(v) = get_numeric_value(&grids[range.sheet_index], abs_row, abs_col) {
                    values.push(v);
                }
            }
            let agg = aggregate(&values, params.function);
            results.push((rel_r, rel_c, agg));
        }
    }

    Ok(results)
}

// ============================================================================
// Category-based consolidation
// ============================================================================

/// Result of category-based consolidation.
struct CategoryResult {
    /// Column header labels (written to top row of output if use_top_row)
    col_headers: Vec<String>,
    /// Row header labels (written to left column of output if use_left_column)
    row_headers: Vec<String>,
    /// Data values indexed by (row_idx, col_idx) in the result matrix
    data: Vec<Vec<f64>>,
}

/// Consolidate by category: match row and/or column headers across sources.
fn consolidate_by_category(
    grids: &[Grid],
    params: &ConsolidateParams,
) -> Result<CategoryResult, String> {
    let use_top = params.use_top_row;
    let use_left = params.use_left_column;

    // Determine data offsets within each source range
    let data_row_offset: u32 = if use_top { 1 } else { 0 };
    let data_col_offset: u32 = if use_left { 1 } else { 0 };

    // ------------------------------------------------------------------
    // 1. Build master header sets (preserving first-seen order)
    // ------------------------------------------------------------------
    let mut col_header_order: Vec<String> = Vec::new();
    let mut col_header_set: HashSet<String> = HashSet::new();

    let mut row_header_order: Vec<String> = Vec::new();
    let mut row_header_set: HashSet<String> = HashSet::new();

    for range in &params.source_ranges {
        let grid = &grids[range.sheet_index];

        // Collect column headers from the top row of this source
        if use_top {
            for c in (range.start_col + data_col_offset)..=range.end_col {
                let header = get_header_text(grid, range.start_row, c).trim().to_string();
                if !header.is_empty() && !col_header_set.contains(&header) {
                    col_header_set.insert(header.clone());
                    col_header_order.push(header);
                }
            }
        }

        // Collect row headers from the left column of this source
        if use_left {
            for r in (range.start_row + data_row_offset)..=range.end_row {
                let header = get_header_text(grid, r, range.start_col).trim().to_string();
                if !header.is_empty() && !row_header_set.contains(&header) {
                    row_header_set.insert(header.clone());
                    row_header_order.push(header);
                }
            }
        }
    }

    // If no headers were found, determine dimensions from the data region
    let num_data_rows = if use_left {
        row_header_order.len()
    } else {
        // Use the first source range's data row count
        let first = &params.source_ranges[0];
        (first.end_row - first.start_row + 1 - data_row_offset) as usize
    };

    let num_data_cols = if use_top {
        col_header_order.len()
    } else {
        let first = &params.source_ranges[0];
        (first.end_col - first.start_col + 1 - data_col_offset) as usize
    };

    if num_data_rows == 0 || num_data_cols == 0 {
        return Err(
            "No data to consolidate. Source ranges contain no data cells beyond headers."
                .to_string(),
        );
    }

    // ------------------------------------------------------------------
    // 2. Collect values from all sources into the master matrix
    // ------------------------------------------------------------------
    // Each cell in the matrix accumulates a Vec<f64> of source values
    let mut value_matrix: Vec<Vec<Vec<f64>>> = vec![vec![Vec::new(); num_data_cols]; num_data_rows];

    for range in &params.source_ranges {
        let grid = &grids[range.sheet_index];

        // Build local header maps for this source
        let local_col_map: HashMap<String, u32> = if use_top {
            let mut m = HashMap::new();
            for c in (range.start_col + data_col_offset)..=range.end_col {
                let header = get_header_text(grid, range.start_row, c).trim().to_string();
                if !header.is_empty() {
                    m.insert(header, c);
                }
            }
            m
        } else {
            HashMap::new()
        };

        let local_row_map: HashMap<String, u32> = if use_left {
            let mut m = HashMap::new();
            for r in (range.start_row + data_row_offset)..=range.end_row {
                let header = get_header_text(grid, r, range.start_col).trim().to_string();
                if !header.is_empty() {
                    m.insert(header, r);
                }
            }
            m
        } else {
            HashMap::new()
        };

        // Iterate the master matrix positions and pull values from this source
        for master_r in 0..num_data_rows {
            // Determine the source row for this master row
            let source_row = if use_left {
                let row_header = &row_header_order[master_r];
                match local_row_map.get(row_header) {
                    Some(&r) => r,
                    None => continue, // This source doesn't have this row header
                }
            } else {
                range.start_row + data_row_offset + master_r as u32
            };

            for master_c in 0..num_data_cols {
                // Determine the source column for this master column
                let source_col = if use_top {
                    let col_header = &col_header_order[master_c];
                    match local_col_map.get(col_header) {
                        Some(&c) => c,
                        None => continue, // This source doesn't have this column header
                    }
                } else {
                    range.start_col + data_col_offset + master_c as u32
                };

                if let Some(v) = get_numeric_value(grid, source_row, source_col) {
                    value_matrix[master_r][master_c].push(v);
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // 4. Aggregate
    // ------------------------------------------------------------------
    let data: Vec<Vec<f64>> = value_matrix
        .iter()
        .map(|row| {
            row.iter()
                .map(|values| aggregate(values, params.function))
                .collect()
        })
        .collect();

    Ok(CategoryResult {
        col_headers: col_header_order,
        row_headers: row_header_order,
        data,
    })
}

// ============================================================================
// Tauri command
// ============================================================================

#[tauri::command]
pub fn consolidate_data(state: State<AppState>, params: ConsolidateParams) -> ConsolidateResult {
    crate::log_info!(
        "CONSOLIDATE",
        "Starting: function={:?} sources={} dest=sheet{}!({},{}) top_row={} left_col={}",
        params.function,
        params.source_ranges.len(),
        params.dest_sheet_index,
        params.dest_row,
        params.dest_col,
        params.use_top_row,
        params.use_left_column
    );

    // ---- Validation ----
    if params.source_ranges.is_empty() {
        return error_result("At least one source range is required.");
    }

    // Acquire locks (same order as goal_seek.rs to avoid deadlocks)
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let merged_regions = state.merged_regions.lock().unwrap();

    let num_sheets = grids.len();

    // Validate sheet indices
    if params.dest_sheet_index >= num_sheets {
        return error_result(&format!(
            "Destination sheet index {} is out of range (workbook has {} sheets).",
            params.dest_sheet_index, num_sheets
        ));
    }
    for (i, range) in params.source_ranges.iter().enumerate() {
        if range.sheet_index >= num_sheets {
            return error_result(&format!(
                "Source range {} references sheet index {} which is out of range.",
                i + 1,
                range.sheet_index
            ));
        }
        if range.start_row > range.end_row || range.start_col > range.end_col {
            return error_result(&format!(
                "Source range {} has invalid coordinates (start > end).",
                i + 1
            ));
        }
    }

    // ---- Determine consolidation mode ----
    let is_category_mode = params.use_top_row || params.use_left_column;

    if is_category_mode {
        // ----------------------------------------------------------------
        // Category-based consolidation
        // ----------------------------------------------------------------
        let cat_result = match consolidate_by_category(&grids, &params) {
            Ok(r) => r,
            Err(e) => return error_result(&e),
        };

        let has_col_headers = params.use_top_row && !cat_result.col_headers.is_empty();
        let has_row_headers = params.use_left_column && !cat_result.row_headers.is_empty();

        let header_row_offset: u32 = if has_col_headers { 1 } else { 0 };
        let header_col_offset: u32 = if has_row_headers { 1 } else { 0 };

        let total_rows = header_row_offset + cat_result.data.len() as u32;
        let total_cols = header_col_offset
            + if cat_result.data.is_empty() {
                0
            } else {
                cat_result.data[0].len() as u32
            };

        let dest_sheet = params.dest_sheet_index;

        // Write column headers
        if has_col_headers {
            for (c_idx, header) in cat_result.col_headers.iter().enumerate() {
                let cell = Cell::new_text(header.clone());
                let dest_r = params.dest_row;
                let dest_c = params.dest_col + header_col_offset + c_idx as u32;
                grids[dest_sheet].set_cell(dest_r, dest_c, cell.clone());
                if dest_sheet == active_sheet {
                    grid.set_cell(dest_r, dest_c, cell);
                }
            }
        }

        // Write row headers
        if has_row_headers {
            for (r_idx, header) in cat_result.row_headers.iter().enumerate() {
                let cell = Cell::new_text(header.clone());
                let dest_r = params.dest_row + header_row_offset + r_idx as u32;
                let dest_c = params.dest_col;
                grids[dest_sheet].set_cell(dest_r, dest_c, cell.clone());
                if dest_sheet == active_sheet {
                    grid.set_cell(dest_r, dest_c, cell);
                }
            }
        }

        // Write data values
        for (r_idx, row_data) in cat_result.data.iter().enumerate() {
            for (c_idx, &value) in row_data.iter().enumerate() {
                let cell = Cell::new_number(value);
                let dest_r = params.dest_row + header_row_offset + r_idx as u32;
                let dest_c = params.dest_col + header_col_offset + c_idx as u32;
                grids[dest_sheet].set_cell(dest_r, dest_c, cell.clone());
                if dest_sheet == active_sheet {
                    grid.set_cell(dest_r, dest_c, cell);
                }
            }
        }

        // Build updated_cells
        let mut updated_cells = Vec::new();
        let sheet_idx_param = if dest_sheet != active_sheet {
            Some(dest_sheet)
        } else {
            None
        };

        for r in 0..total_rows {
            for c in 0..total_cols {
                let abs_r = params.dest_row + r;
                let abs_c = params.dest_col + c;
                if let Some(cd) = build_cell_data(
                    &grids[dest_sheet],
                    &styles,
                    &merged_regions,
                    abs_r,
                    abs_c,
                    sheet_idx_param,
                ) {
                    updated_cells.push(cd);
                }
            }
        }

        crate::log_info!(
            "CONSOLIDATE",
            "Done (category): {}x{} output ({} cells written)",
            total_rows,
            total_cols,
            updated_cells.len()
        );

        ConsolidateResult {
            success: true,
            rows_written: total_rows,
            cols_written: total_cols,
            updated_cells,
            error: None,
        }
    } else {
        // ----------------------------------------------------------------
        // Position-based consolidation
        // ----------------------------------------------------------------
        let pos_results = match consolidate_by_position(&grids, &params) {
            Ok(r) => r,
            Err(e) => return error_result(&e),
        };

        let first = &params.source_ranges[0];
        let num_rows = first.end_row - first.start_row + 1;
        let num_cols = first.end_col - first.start_col + 1;
        let dest_sheet = params.dest_sheet_index;

        // Write results to destination
        for &(rel_r, rel_c, value) in &pos_results {
            let cell = Cell::new_number(value);
            let dest_r = params.dest_row + rel_r;
            let dest_c = params.dest_col + rel_c;
            grids[dest_sheet].set_cell(dest_r, dest_c, cell.clone());
            if dest_sheet == active_sheet {
                grid.set_cell(dest_r, dest_c, cell);
            }
        }

        // Build updated_cells
        let mut updated_cells = Vec::new();
        let sheet_idx_param = if dest_sheet != active_sheet {
            Some(dest_sheet)
        } else {
            None
        };

        for &(rel_r, rel_c, _) in &pos_results {
            let abs_r = params.dest_row + rel_r;
            let abs_c = params.dest_col + rel_c;
            if let Some(cd) = build_cell_data(
                &grids[dest_sheet],
                &styles,
                &merged_regions,
                abs_r,
                abs_c,
                sheet_idx_param,
            ) {
                updated_cells.push(cd);
            }
        }

        crate::log_info!(
            "CONSOLIDATE",
            "Done (position): {}x{} output ({} cells written)",
            num_rows,
            num_cols,
            updated_cells.len()
        );

        ConsolidateResult {
            success: true,
            rows_written: num_rows,
            cols_written: num_cols,
            updated_cells,
            error: None,
        }
    }
}
