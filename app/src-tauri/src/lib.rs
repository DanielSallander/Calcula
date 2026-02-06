//! FILENAME: app/src-tauri/src/lib.rs
// PURPOSE: Main library entry point (Tauri Bridge).
// CONTEXT: Uses a generic ProtectedRegion system for extension-owned cell regions.

use engine::{
    format_number, Cell, CellError, CellStyle, CellValue, Evaluator, Grid, NumberFormat,
    StyleRegistry, MultiSheetContext,
};
use engine::{
    BinaryOperator as EngineBinaryOp, Expression as EngineExpr, UnaryOperator as EngineUnaryOp,
    Value as EngineValue,
};
use parser::ast::{
    BinaryOperator as ParserBinaryOp, Expression as ParserExpr, UnaryOperator as ParserUnaryOp,
    Value as ParserValue,
};
use parser::parse as parse_formula;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use persistence::FileState;
use engine::UndoStack;

pub mod persistence;
pub mod api_types;
pub mod calculation;
pub mod commands;
pub mod formula;
pub mod logging;
pub mod sheets;
pub mod undo_commands;
pub mod merge_commands;
pub mod pivot;

pub use api_types::{CellData, StyleData, DimensionData, FormattingParams, MergedRegion};
pub use logging::{init_log_file, get_log_path, next_seq, write_log, write_log_raw};
pub use engine::{Transaction, CellChange};
pub use sheets::FreezeConfig;

#[cfg(test)]
mod tests;

// ============================================================================
// APPLICATION STATE
// ============================================================================

/// A generic protected region on a sheet, registered by any extension (e.g., pivot, chart).
/// Extensions register regions through this struct; the kernel remains feature-agnostic.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ProtectedRegion {
    /// Unique identifier (e.g., "pivot-1", "chart-3")
    pub id: String,
    /// Region type (e.g., "pivot", "chart")
    pub region_type: String,
    /// Numeric owner ID within the extension's namespace
    pub owner_id: u64,
    pub sheet_index: usize,
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
}

pub struct AppState {
    /// Multiple grids, one per sheet
    pub grids: Mutex<Vec<Grid>>,
    /// Sheet names in order
    pub sheet_names: Mutex<Vec<String>>,
    /// Currently active sheet index
    pub active_sheet: Mutex<usize>,
    /// The currently active grid (synced with grids[active_sheet])
    /// Commands use this for all cell operations
    pub grid: Mutex<Grid>,
    pub style_registry: Mutex<StyleRegistry>,
    pub column_widths: Mutex<HashMap<u32, f64>>,
    pub row_heights: Mutex<HashMap<u32, f64>>,
    pub dependents: Mutex<HashMap<(u32, u32), HashSet<(u32, u32)>>>,
    pub dependencies: Mutex<HashMap<(u32, u32), HashSet<(u32, u32)>>>,
    /// Calculation mode: "automatic" or "manual"
    pub calculation_mode: Mutex<String>,
    /// Column-level dependencies: column index -> set of formula cells that depend on entire column
    pub column_dependents: Mutex<HashMap<u32, HashSet<(u32, u32)>>>,
    /// Row-level dependencies: row index -> set of formula cells that depend on entire row
    pub row_dependents: Mutex<HashMap<u32, HashSet<(u32, u32)>>>,
    /// Track which columns each formula cell depends on (for cleanup)
    pub column_dependencies: Mutex<HashMap<(u32, u32), HashSet<u32>>>,
    /// Track which rows each formula cell depends on (for cleanup)
    pub row_dependencies: Mutex<HashMap<(u32, u32), HashSet<u32>>>,
    /// Cross-sheet dependencies: (sheet_name, row, col) -> set of (sheet_index, row, col) that depend on it
    pub cross_sheet_dependents: Mutex<HashMap<(String, u32, u32), HashSet<(usize, u32, u32)>>>,
    /// Track which cross-sheet cells each formula depends on (for cleanup)
    pub cross_sheet_dependencies: Mutex<HashMap<(usize, u32, u32), HashSet<(String, u32, u32)>>>,
    pub undo_stack: Mutex<UndoStack>,
    /// Freeze pane configurations per sheet
    pub freeze_configs: Mutex<Vec<FreezeConfig>>,
    /// Merged cell regions for the current sheet
    pub merged_regions: Mutex<HashSet<MergedRegion>>,
    /// Protected regions - cells in these regions cannot be edited directly.
    /// Registered by extensions (e.g., pivot tables, charts).
    pub protected_regions: Mutex<Vec<ProtectedRegion>>,
}

impl AppState {
    /// Get the active grid (convenience method)
    pub fn get_active_grid(&self) -> std::sync::MutexGuard<Grid> {
        self.grid.lock().unwrap()
    }
    
    /// Check if a cell is within any protected region.
    /// Returns the first matching region, or None.
    pub fn get_region_at_cell(&self, sheet_index: usize, row: u32, col: u32) -> Option<ProtectedRegion> {
        let regions = self.protected_regions.lock().unwrap();
        for region in regions.iter() {
            if region.sheet_index == sheet_index
                && row >= region.start_row
                && row <= region.end_row
                && col >= region.start_col
                && col <= region.end_col
            {
                return Some(region.clone());
            }
        }
        None
    }
}

pub fn create_app_state() -> AppState {
    log_info!("SYS", "Creating AppState");
    let initial_grid = Grid::new();
    AppState {
        grids: Mutex::new(vec![initial_grid.clone()]),
        sheet_names: Mutex::new(vec!["Sheet1".to_string()]),
        active_sheet: Mutex::new(0),
        grid: Mutex::new(initial_grid),
        style_registry: Mutex::new(StyleRegistry::new()),
        column_widths: Mutex::new(HashMap::new()),
        row_heights: Mutex::new(HashMap::new()),
        dependents: Mutex::new(HashMap::new()),
        dependencies: Mutex::new(HashMap::new()),
        calculation_mode: Mutex::new("automatic".to_string()),
        column_dependents: Mutex::new(HashMap::new()),
        row_dependents: Mutex::new(HashMap::new()),
        column_dependencies: Mutex::new(HashMap::new()),
        row_dependencies: Mutex::new(HashMap::new()),
        cross_sheet_dependents: Mutex::new(HashMap::new()),
        cross_sheet_dependencies: Mutex::new(HashMap::new()),
        undo_stack: Mutex::new(UndoStack::new()),
        freeze_configs: Mutex::new(vec![FreezeConfig::default()]),
        merged_regions: Mutex::new(HashSet::new()),
        protected_regions: Mutex::new(Vec::new()),
    }
}

// ============================================================================
// CELL FORMATTING
// ============================================================================

pub fn format_cell_value(value: &CellValue, style: &CellStyle) -> String {
    match value {
        CellValue::Empty => String::new(),
        CellValue::Number(n) => {
            let result = format_number(*n, &style.number_format);
            if !matches!(style.number_format, NumberFormat::General) {
                log_debug!("FMT", "num={} fmt={:?} --> {}", n, style.number_format, result);
            }
            result
        },
        CellValue::Text(s) => s.clone(),
        CellValue::Boolean(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
        CellValue::Error(e) => format!("#{:?}", e).to_uppercase(),
    }
}

pub fn format_cell_value_simple(value: &CellValue) -> String {
    match value {
        CellValue::Empty => String::new(),
        CellValue::Number(n) => format_number_simple(*n),
        CellValue::Text(s) => s.clone(),
        CellValue::Boolean(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
        CellValue::Error(e) => format!("#{:?}", e).to_uppercase(),
    }
}

pub fn format_number_simple(n: f64) -> String {
    if n.fract() == 0.0 {
        format!("{:.0}", n)
    } else {
        let s = format!("{:.10}", n);
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

// ============================================================================
// EXPRESSION CONVERSION (Parser -> Engine)
// ============================================================================

fn convert_value(v: &ParserValue) -> EngineValue {
    match v {
        ParserValue::Number(n) => EngineValue::Number(*n),
        ParserValue::String(s) => EngineValue::String(s.clone()),
        ParserValue::Boolean(b) => EngineValue::Boolean(*b),
    }
}

fn convert_binary_op(op: &ParserBinaryOp) -> EngineBinaryOp {
    match op {
        ParserBinaryOp::Add => EngineBinaryOp::Add,
        ParserBinaryOp::Subtract => EngineBinaryOp::Subtract,
        ParserBinaryOp::Multiply => EngineBinaryOp::Multiply,
        ParserBinaryOp::Divide => EngineBinaryOp::Divide,
        ParserBinaryOp::Power => EngineBinaryOp::Power,
        ParserBinaryOp::Concat => EngineBinaryOp::Concat,
        ParserBinaryOp::Equal => EngineBinaryOp::Equal,
        ParserBinaryOp::NotEqual => EngineBinaryOp::NotEqual,
        ParserBinaryOp::LessThan => EngineBinaryOp::LessThan,
        ParserBinaryOp::GreaterThan => EngineBinaryOp::GreaterThan,
        ParserBinaryOp::LessEqual => EngineBinaryOp::LessEqual,
        ParserBinaryOp::GreaterEqual => EngineBinaryOp::GreaterEqual,
    }
}

fn convert_unary_op(op: &ParserUnaryOp) -> EngineUnaryOp {
    match op {
        ParserUnaryOp::Negate => EngineUnaryOp::Negate,
    }
}

fn convert_expr(expr: &ParserExpr) -> EngineExpr {
    match expr {
        ParserExpr::Literal(v) => EngineExpr::Literal(convert_value(v)),
        ParserExpr::CellRef { sheet, col, row, .. } => EngineExpr::CellRef {
            sheet: sheet.clone(),
            col: col.clone(),
            row: *row,
        },
        ParserExpr::Range { sheet, start, end } => EngineExpr::Range {
            sheet: sheet.clone(),
            start: Box::new(convert_expr(start)),
            end: Box::new(convert_expr(end)),
        },
        ParserExpr::ColumnRef { sheet, start_col, end_col, .. } => EngineExpr::ColumnRef {
            sheet: sheet.clone(),
            start_col: start_col.clone(),
            end_col: end_col.clone(),
        },
        ParserExpr::RowRef { sheet, start_row, end_row, .. } => EngineExpr::RowRef {
            sheet: sheet.clone(),
            start_row: *start_row,
            end_row: *end_row,
        },
        ParserExpr::BinaryOp { left, op, right } => EngineExpr::BinaryOp {
            left: Box::new(convert_expr(left)),
            op: convert_binary_op(op),
            right: Box::new(convert_expr(right)),
        },
        ParserExpr::UnaryOp { op, operand } => EngineExpr::UnaryOp {
            op: convert_unary_op(op),
            operand: Box::new(convert_expr(operand)),
        },
        ParserExpr::FunctionCall { name, args } => EngineExpr::FunctionCall {
            name: name.clone(),
            args: args.iter().map(convert_expr).collect(),
        },
    }
}

fn col_letter_to_index(col: &str) -> u32 {
    let mut result: u32 = 0;
    for c in col.chars() {
        let val = (c.to_ascii_uppercase() as u32) - ('A' as u32) + 1;
        result = result * 26 + val;
    }
    result.saturating_sub(1)
}

// ============================================================================
// FORMULA EVALUATION
// ============================================================================

/// Result of extracting references from a formula expression
pub struct ExtractedRefs {
    /// Individual cell references (row, col) on the current sheet - 0-indexed
    pub cells: HashSet<(u32, u32)>,
    /// Column references (column indices)
    pub columns: HashSet<u32>,
    /// Row references (row indices) - 0-indexed
    pub rows: HashSet<u32>,
    /// Cross-sheet cell references (sheet_name, row, col) - row is 0-indexed
    pub cross_sheet_cells: HashSet<(String, u32, u32)>,
}

impl ExtractedRefs {
    pub fn new() -> Self {
        ExtractedRefs {
            cells: HashSet::new(),
            columns: HashSet::new(),
            rows: HashSet::new(),
            cross_sheet_cells: HashSet::new(),
        }
    }
}

pub fn extract_references(expr: &ParserExpr, grid: &Grid) -> HashSet<(u32, u32)> {
    let refs = extract_all_references(expr, grid);
    refs.cells
}

pub fn extract_all_references(expr: &ParserExpr, grid: &Grid) -> ExtractedRefs {
    let mut refs = ExtractedRefs::new();
    extract_references_recursive(expr, grid, &mut refs);
    refs
}

fn extract_references_recursive(expr: &ParserExpr, grid: &Grid, refs: &mut ExtractedRefs) {
    match expr {
        ParserExpr::Literal(_) => {}
        ParserExpr::CellRef { sheet, col, row, .. } => {
            let col_idx = col_letter_to_index(col);
            let row_idx = row.saturating_sub(1);
            if let Some(sheet_name) = sheet {
                refs.cross_sheet_cells.insert((sheet_name.clone(), row_idx, col_idx));
            } else {
                refs.cells.insert((row_idx, col_idx));
            }
        }
        ParserExpr::Range { sheet, start, end } => {
            if let (
                ParserExpr::CellRef { col: start_col, row: start_row, .. },
                ParserExpr::CellRef { col: end_col, row: end_row, .. },
            ) = (start.as_ref(), end.as_ref())
            {
                let sc = col_letter_to_index(start_col);
                let ec = col_letter_to_index(end_col);
                let sr = start_row.saturating_sub(1);
                let er = end_row.saturating_sub(1);
                
                if let Some(sheet_name) = sheet {
                    for r in sr.min(er)..=sr.max(er) {
                        for c in sc.min(ec)..=sc.max(ec) {
                            refs.cross_sheet_cells.insert((sheet_name.clone(), r, c));
                        }
                    }
                } else {
                    for r in sr.min(er)..=sr.max(er) {
                        for c in sc.min(ec)..=sc.max(ec) {
                            refs.cells.insert((r, c));
                        }
                    }
                }
            } else {
                extract_references_recursive(start, grid, refs);
                extract_references_recursive(end, grid, refs);
            }
        }
        ParserExpr::ColumnRef { start_col, end_col, .. } => {
            let sc = col_letter_to_index(start_col);
            let ec = col_letter_to_index(end_col);
            let min_col = sc.min(ec);
            let max_col = sc.max(ec);
            
            for col in min_col..=max_col {
                refs.columns.insert(col);
            }
            
            for ((r, c), _) in grid.cells.iter() {
                if *c >= min_col && *c <= max_col {
                    refs.cells.insert((*r, *c));
                }
            }
        }
        ParserExpr::RowRef { start_row, end_row, .. } => {
            let min_row = start_row.saturating_sub(1).min(end_row.saturating_sub(1));
            let max_row = start_row.saturating_sub(1).max(end_row.saturating_sub(1));
            
            for row in min_row..=max_row {
                refs.rows.insert(row);
            }
            
            for ((r, c), _) in grid.cells.iter() {
                if *r >= min_row && *r <= max_row {
                    refs.cells.insert((*r, *c));
                }
            }
        }
        ParserExpr::BinaryOp { left, right, .. } => {
            extract_references_recursive(left, grid, refs);
            extract_references_recursive(right, grid, refs);
        }
        ParserExpr::UnaryOp { operand, .. } => {
            extract_references_recursive(operand, grid, refs);
        }
        ParserExpr::FunctionCall { args, .. } => {
            for arg in args {
                extract_references_recursive(arg, grid, refs);
            }
        }
    }
}

pub fn evaluate_formula(grid: &Grid, formula: &str) -> CellValue {
    log_debug!("EVAL", "formula={}", formula);
    
    match parse_formula(formula) {
        Ok(parser_ast) => {
            let engine_ast = convert_expr(&parser_ast);
            let evaluator = Evaluator::new(grid);
            let result = evaluator.evaluate(&engine_ast);
            let cell_value = result.to_cell_value();
            log_debug!("EVAL", "result={:?}", cell_value);
            cell_value
        }
        Err(e) => {
            log_error!("EVAL", "parse_err formula={} err={}", formula, e);
            CellValue::Error(CellError::Value)
        }
    }
}

pub fn evaluate_formula_multi_sheet(
    grids: &[Grid],
    sheet_names: &[String],
    current_sheet_index: usize,
    formula: &str,
) -> CellValue {
    log_debug!("EVAL", "formula={} sheet_idx={}", formula, current_sheet_index);
    
    if current_sheet_index >= grids.len() || current_sheet_index >= sheet_names.len() {
        log_error!("EVAL", "invalid sheet index {}", current_sheet_index);
        return CellValue::Error(CellError::Ref);
    }

    match parse_formula(formula) {
        Ok(parser_ast) => {
            let engine_ast = convert_expr(&parser_ast);
            
            let current_grid = &grids[current_sheet_index];
            let current_sheet_name = &sheet_names[current_sheet_index];
            
            let mut context = engine::MultiSheetContext::new(current_sheet_name.clone());
            for (i, grid) in grids.iter().enumerate() {
                if i < sheet_names.len() {
                    context.add_grid(sheet_names[i].clone(), grid);
                }
            }
            
            let evaluator = Evaluator::with_multi_sheet(current_grid, context);
            let result = evaluator.evaluate(&engine_ast);
            let cell_value = result.to_cell_value();
            log_debug!("EVAL", "result={:?}", cell_value);
            cell_value
        }
        Err(e) => {
            log_error!("EVAL", "parse_err formula={} err={}", formula, e);
            CellValue::Error(CellError::Value)
        }
    }
}

pub fn parse_cell_input(input: &str) -> Cell {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Cell::new();
    }
    if trimmed.starts_with('=') {
        log_debug!("PARSE", "formula input={}", trimmed);
        return Cell::new_formula(trimmed.to_string());
    }
    let upper = trimmed.to_uppercase();
    if upper == "TRUE" {
        return Cell::new_boolean(true);
    }
    if upper == "FALSE" {
        return Cell::new_boolean(false);
    }
    if let Some(num) = parse_number(trimmed) {
        return Cell::new_number(num);
    }
    Cell::new_text(trimmed.to_string())
}

fn parse_number(s: &str) -> Option<f64> {
    let trimmed = s.trim();
    if trimmed.ends_with('%') {
        let num_part = trimmed.trim_end_matches('%').trim();
        if let Ok(n) = num_part.parse::<f64>() {
            return Some(n / 100.0);
        }
        return None;
    }
    let cleaned = trimmed.replace(',', "");
    if let Ok(n) = cleaned.parse::<f64>() {
        if n.is_finite() {
            return Some(n);
        }
    }
    None
}

// ============================================================================
// DEPENDENCY TRACKING
// ============================================================================

pub fn update_dependencies(
    cell_pos: (u32, u32),
    new_refs: HashSet<(u32, u32)>,
    dependencies: &mut HashMap<(u32, u32), HashSet<(u32, u32)>>,
    dependents: &mut HashMap<(u32, u32), HashSet<(u32, u32)>>,
) {
    let old_refs = dependencies.remove(&cell_pos).unwrap_or_default();
    
    if !old_refs.is_empty() || !new_refs.is_empty() {
        log_debug!("DEP", "cell={:?} old_refs={} new_refs={}", cell_pos, old_refs.len(), new_refs.len());
    }
    
    for old_ref in &old_refs {
        if let Some(deps) = dependents.get_mut(old_ref) {
            deps.remove(&cell_pos);
            if deps.is_empty() {
                dependents.remove(old_ref);
            }
        }
    }
    for new_ref in &new_refs {
        dependents
            .entry(*new_ref)
            .or_insert_with(HashSet::new)
            .insert(cell_pos);
    }
    if !new_refs.is_empty() {
        dependencies.insert(cell_pos, new_refs);
    }
}

pub fn update_column_dependencies(
    cell_pos: (u32, u32),
    new_cols: HashSet<u32>,
    column_dependencies: &mut HashMap<(u32, u32), HashSet<u32>>,
    column_dependents: &mut HashMap<u32, HashSet<(u32, u32)>>,
) {
    let old_cols = column_dependencies.remove(&cell_pos).unwrap_or_default();
    
    for old_col in &old_cols {
        if let Some(deps) = column_dependents.get_mut(old_col) {
            deps.remove(&cell_pos);
            if deps.is_empty() {
                column_dependents.remove(old_col);
            }
        }
    }
    
    for new_col in &new_cols {
        column_dependents
            .entry(*new_col)
            .or_insert_with(HashSet::new)
            .insert(cell_pos);
    }
    
    if !new_cols.is_empty() {
        column_dependencies.insert(cell_pos, new_cols);
    }
}

pub fn update_row_dependencies(
    cell_pos: (u32, u32),
    new_rows: HashSet<u32>,
    row_dependencies: &mut HashMap<(u32, u32), HashSet<u32>>,
    row_dependents: &mut HashMap<u32, HashSet<(u32, u32)>>,
) {
    let old_rows = row_dependencies.remove(&cell_pos).unwrap_or_default();
    
    for old_row in &old_rows {
        if let Some(deps) = row_dependents.get_mut(old_row) {
            deps.remove(&cell_pos);
            if deps.is_empty() {
                row_dependents.remove(old_row);
            }
        }
    }
    
    for new_row in &new_rows {
        row_dependents
            .entry(*new_row)
            .or_insert_with(HashSet::new)
            .insert(cell_pos);
    }
    
    if !new_rows.is_empty() {
        row_dependencies.insert(cell_pos, new_rows);
    }
}

pub fn update_cross_sheet_dependencies(
    formula_cell: (usize, u32, u32),
    new_refs: HashSet<(String, u32, u32)>,
    cross_sheet_dependencies: &mut HashMap<(usize, u32, u32), HashSet<(String, u32, u32)>>,
    cross_sheet_dependents: &mut HashMap<(String, u32, u32), HashSet<(usize, u32, u32)>>,
) {
    let old_refs = cross_sheet_dependencies.remove(&formula_cell).unwrap_or_default();
    
    for old_ref in &old_refs {
        if let Some(deps) = cross_sheet_dependents.get_mut(old_ref) {
            deps.remove(&formula_cell);
            if deps.is_empty() {
                cross_sheet_dependents.remove(old_ref);
            }
        }
    }
    
    for new_ref in &new_refs {
        cross_sheet_dependents
            .entry(new_ref.clone())
            .or_insert_with(HashSet::new)
            .insert(formula_cell);
    }
    
    if !new_refs.is_empty() {
        log_debug!("XDEP", "formula={:?} cross_sheet_refs={}", formula_cell, new_refs.len());
        cross_sheet_dependencies.insert(formula_cell, new_refs);
    }
}

pub fn get_recalculation_order(
    changed_cell: (u32, u32),
    dependents: &HashMap<(u32, u32), HashSet<(u32, u32)>>,
) -> Vec<(u32, u32)> {
    let mut to_recalc = Vec::new();
    let mut visited = HashSet::new();
    let mut stack = vec![changed_cell];
    while let Some(cell) = stack.pop() {
        if visited.contains(&cell) {
            continue;
        }
        if cell != changed_cell {
            to_recalc.push(cell);
        }
        visited.insert(cell);
        if let Some(deps) = dependents.get(&cell) {
            for dep in deps {
                if !visited.contains(dep) {
                    stack.push(*dep);
                }
            }
        }
    }
    
    if !to_recalc.is_empty() {
        log_debug!("RECALC", "changed={:?} cascade={}", changed_cell, to_recalc.len());
    }
    
    to_recalc
}

pub fn get_column_row_dependents(
    changed_cell: (u32, u32),
    column_dependents: &HashMap<u32, HashSet<(u32, u32)>>,
    row_dependents: &HashMap<u32, HashSet<(u32, u32)>>,
) -> HashSet<(u32, u32)> {
    let (row, col) = changed_cell;
    let mut result = HashSet::new();
    
    if let Some(col_deps) = column_dependents.get(&col) {
        for dep in col_deps {
            if *dep != changed_cell {
                result.insert(*dep);
            }
        }
    }
    
    if let Some(row_deps) = row_dependents.get(&row) {
        for dep in row_deps {
            if *dep != changed_cell {
                result.insert(*dep);
            }
        }
    }
    
    result
}

// ============================================================================
// TAURI APP ENTRY
// ============================================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    match init_log_file() {
        Ok(path) => {
            eprintln!("[LOG_INIT] SUCCESS - Log file: {:?}", path);
            log_info!("SYS", "Tauri backend starting, log={}", path.display());
        }
        Err(e) => {
            eprintln!("[LOG_INIT] FAILED: {}", e);
            eprintln!("[LOG_INIT] Continuing with console-only logging");
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(create_app_state())
        .manage(FileState::default())
        .manage(pivot::PivotState::new())
        .invoke_handler(tauri::generate_handler![
            // Grid commands
            commands::get_viewport_cells,
            commands::get_cell,
            commands::update_cell,
            commands::clear_cell,
            commands::clear_range,
            commands::get_grid_bounds,
            commands::get_cell_count,
            // Navigation commands
            commands::find_ctrl_arrow_target,
            // Dimension commands
            commands::set_column_width,
            commands::get_column_width,
            commands::get_all_column_widths,
            commands::set_row_height,
            commands::get_row_height,
            commands::get_all_row_heights,
            // Style commands
            commands::get_style,
            commands::get_all_styles,
            commands::set_cell_style,
            commands::apply_formatting,
            commands::get_style_count,
            commands::insert_rows,
            commands::insert_columns,
            commands::delete_rows,
            commands::delete_columns,
            commands::shift_formula_for_fill,
            // Undo/Redo commands
            undo_commands::begin_undo_transaction,
            undo_commands::commit_undo_transaction,
            undo_commands::cancel_undo_transaction,
            undo_commands::get_undo_state,
            undo_commands::undo,
            undo_commands::redo,
            undo_commands::clear_undo_history,
            // Logging commands
            logging::log_frontend,
            logging::log_frontend_atomic,
            logging::get_next_seq,
            logging::sort_log_file,
            // Calculation mode commands
            calculation::set_calculation_mode,
            calculation::get_calculation_mode,
            calculation::calculate_now,
            calculation::calculate_sheet,
            // Formula library commands
            formula::get_functions_by_category,
            formula::get_all_functions,
            formula::get_function_template,
            // File commands
            persistence::save_file,
            persistence::open_file,
            persistence::new_file,
            persistence::get_current_file_path,
            persistence::is_file_modified,
            persistence::mark_file_modified,
            // Sheet commands
            sheets::get_sheets,
            sheets::get_active_sheet,
            sheets::set_active_sheet,
            sheets::add_sheet,
            sheets::delete_sheet,
            sheets::rename_sheet,
            sheets::set_freeze_panes,
            sheets::get_freeze_panes,
            // Find & Replace commands
            commands::find_all,
            commands::count_matches,
            commands::replace_all,
            commands::replace_single,
            // Merge cell commands
            merge_commands::merge_cells,
            merge_commands::unmerge_cells,
            merge_commands::get_merged_regions,
            merge_commands::get_merge_info,
            // Pivot table commands
            pivot::create_pivot_table,
            pivot::update_pivot_fields,
            pivot::toggle_pivot_group,
            pivot::get_pivot_view,
            pivot::delete_pivot_table,
            pivot::get_pivot_source_data,
            pivot::refresh_pivot_cache,
            pivot::get_pivot_at_cell,
            pivot::get_pivot_regions_for_sheet,
            pivot::get_pivot_field_unique_values,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}