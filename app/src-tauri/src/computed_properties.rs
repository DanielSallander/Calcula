//! FILENAME: app/src-tauri/src/computed_properties.rs
//! PURPOSE: Computed Properties — formula-driven attributes for columns, rows, and cells.
//! CONTEXT: Replaces the old SET formula system with object-attached formula attributes.
//! Users right-click an object → "Computed Properties..." → add/edit/remove attribute formulas.

use std::collections::{HashMap, HashSet};
use engine::{self, CellValue, Grid, StyleRegistry};
use tauri::State;
use crate::api_types::{ComputedPropertyData, ComputedPropertyResult, DimensionData};
use crate::{evaluate_formula_with_context, AppState};

// ============================================================================
// Storage types
// ============================================================================

/// A single computed property attached to a column, row, or cell.
#[derive(Debug, Clone)]
pub struct ComputedProperty {
    pub id: u64,
    pub attribute: String,
    pub formula: String,
    /// Cached engine AST for fast re-evaluation.
    pub cached_ast: Option<engine::Expression>,
    /// Last evaluated value (for display in the dialog).
    pub cached_value: Option<CellValue>,
}

/// All computed properties for a single sheet, grouped by target type.
#[derive(Debug, Clone, Default)]
pub struct SheetComputedProperties {
    /// Column properties: col_index (0-based) -> list of properties
    pub column_props: HashMap<u32, Vec<ComputedProperty>>,
    /// Row properties: row_index (0-based) -> list of properties
    pub row_props: HashMap<u32, Vec<ComputedProperty>>,
    /// Cell properties: (row, col) both 0-based -> list of properties
    pub cell_props: HashMap<(u32, u32), Vec<ComputedProperty>>,
}

/// Top-level storage: sheet_index -> SheetComputedProperties
pub type ComputedPropertiesStorage = HashMap<usize, SheetComputedProperties>;

/// Dependency tracking: prop_id -> set of (sheet_index, row, col) cells the formula references
pub type ComputedPropDependencies = HashMap<u64, HashSet<(usize, u32, u32)>>;

/// Reverse dependency: (sheet_index, row, col) -> set of prop_ids that need re-evaluation
pub type ComputedPropDependents = HashMap<(usize, u32, u32), HashSet<u64>>;

// ============================================================================
// Available attributes per target type
// ============================================================================

/// Returns the valid attribute names for a given target type.
pub fn available_attributes(target_type: &str) -> Vec<&'static str> {
    match target_type {
        "column" => vec![
            "width", "fillColor", "fontFamily", "fontSize", "fontBold",
            "fontItalic", "fontColor", "numberFormat", "textAlign",
        ],
        "row" => vec![
            "height", "fillColor", "fontFamily", "fontSize", "fontBold",
            "fontItalic", "fontColor", "numberFormat", "textAlign",
        ],
        "cell" => vec![
            "fillColor", "fontFamily", "fontSize", "fontBold",
            "fontItalic", "fontColor", "numberFormat", "textAlign",
        ],
        _ => vec![],
    }
}

// ============================================================================
// Evaluation helpers
// ============================================================================

/// Evaluate a single computed property formula and return the result.
fn evaluate_property(
    grids: &[Grid],
    sheet_names: &[String],
    sheet_index: usize,
    prop: &ComputedProperty,
    target_row: u32,
    target_col: u32,
    row_heights: &HashMap<u32, f64>,
    column_widths: &HashMap<u32, f64>,
    styles: &StyleRegistry,
) -> CellValue {
    let ast = match &prop.cached_ast {
        Some(ast) => ast.clone(),
        None => {
            // Parse and convert the formula
            match parser::parse(&prop.formula) {
                Ok(parsed) => crate::convert_expr(&parsed),
                Err(_) => return CellValue::Error(engine::CellError::Value),
            }
        }
    };

    let eval_ctx = engine::EvalContext {
        current_row: Some(target_row),
        current_col: Some(target_col),
        row_heights: Some(row_heights.clone()),
        column_widths: Some(column_widths.clone()),
    };

    evaluate_formula_with_context(
        grids,
        sheet_names,
        sheet_index,
        &ast,
        eval_ctx,
        Some(styles),
    )
}

/// Apply a computed property value to the appropriate target.
/// Returns dimension changes and whether a style refresh is needed.
pub fn apply_property_value(
    attribute: &str,
    value: &CellValue,
    target_type: &str,
    target_index: u32,         // col for column, row for row
    target_index2: Option<u32>, // row for cell, None for column/row
    row_heights: &mut HashMap<u32, f64>,
    column_widths: &mut HashMap<u32, f64>,
    grid: &mut Grid,
    grids: &mut [Grid],
    sheet_index: usize,
    style_registry: &mut StyleRegistry,
) -> (Vec<DimensionData>, bool) {
    let mut dimension_changes = Vec::new();
    let mut needs_style_refresh = false;

    match attribute {
        "width" => {
            if target_type == "column" {
                if let Some(w) = value_as_f64(value) {
                    if w > 0.0 {
                        column_widths.insert(target_index, w);
                        dimension_changes.push(DimensionData {
                            index: target_index,
                            size: w,
                            dimension_type: "column".to_string(),
                        });
                    }
                }
            }
        }
        "height" => {
            if target_type == "row" {
                if let Some(h) = value_as_f64(value) {
                    if h > 0.0 {
                        row_heights.insert(target_index, h);
                        dimension_changes.push(DimensionData {
                            index: target_index,
                            size: h,
                            dimension_type: "row".to_string(),
                        });
                    }
                }
            }
        }
        "fillColor" => {
            let color_str = value_as_string(value);
            if let Some(color) = parse_color(&color_str) {
                match target_type {
                    "cell" => {
                        let row = target_index;
                        let col = target_index2.unwrap_or(0);
                        apply_fill_color(grid, grids, sheet_index, style_registry, row, col, color);
                        needs_style_refresh = true;
                    }
                    "column" => {
                        // Apply to all existing cells in this column
                        let col = target_index;
                        let cell_keys: Vec<(u32, u32)> = grid.cells.keys().copied()
                            .filter(|&(_, c)| c == col)
                            .collect();
                        for (r, c) in cell_keys {
                            apply_fill_color(grid, grids, sheet_index, style_registry, r, c, color.clone());
                        }
                        needs_style_refresh = true;
                    }
                    "row" => {
                        let row = target_index;
                        let cell_keys: Vec<(u32, u32)> = grid.cells.keys().copied()
                            .filter(|&(r, _)| r == row)
                            .collect();
                        for (r, c) in cell_keys {
                            apply_fill_color(grid, grids, sheet_index, style_registry, r, c, color.clone());
                        }
                        needs_style_refresh = true;
                    }
                    _ => {}
                }
            }
        }
        "fontBold" => {
            let bold = value_as_bool(value);
            apply_style_change(target_type, target_index, target_index2, grid, grids, sheet_index, style_registry, |style| {
                style.font.bold = bold;
            });
            needs_style_refresh = true;
        }
        "fontItalic" => {
            let italic = value_as_bool(value);
            apply_style_change(target_type, target_index, target_index2, grid, grids, sheet_index, style_registry, |style| {
                style.font.italic = italic;
            });
            needs_style_refresh = true;
        }
        "fontSize" => {
            if let Some(size) = value_as_f64(value) {
                let size_u8 = (size.round() as u8).max(1);
                apply_style_change(target_type, target_index, target_index2, grid, grids, sheet_index, style_registry, |style| {
                    style.font.size = size_u8;
                });
                needs_style_refresh = true;
            }
        }
        "fontFamily" => {
            let family = value_as_string(value);
            if !family.is_empty() {
                apply_style_change(target_type, target_index, target_index2, grid, grids, sheet_index, style_registry, |style| {
                    style.font.family = family.clone();
                });
                needs_style_refresh = true;
            }
        }
        "fontColor" => {
            let color_str = value_as_string(value);
            if let Some(color) = parse_color(&color_str) {
                apply_style_change(target_type, target_index, target_index2, grid, grids, sheet_index, style_registry, |style| {
                    style.font.color = color.clone();
                });
                needs_style_refresh = true;
            }
        }
        "numberFormat" => {
            let fmt_str = value_as_string(value);
            if !fmt_str.is_empty() {
                apply_style_change(target_type, target_index, target_index2, grid, grids, sheet_index, style_registry, |style| {
                    style.number_format = engine::NumberFormat::Custom { format: fmt_str.clone() };
                });
                needs_style_refresh = true;
            }
        }
        "textAlign" => {
            let align_str = value_as_string(value);
            if let Some(align) = parse_text_align(&align_str) {
                apply_style_change(target_type, target_index, target_index2, grid, grids, sheet_index, style_registry, |style| {
                    style.text_align = align;
                });
                needs_style_refresh = true;
            }
        }
        _ => {}
    }

    (dimension_changes, needs_style_refresh)
}

// ============================================================================
// Style application helpers
// ============================================================================

fn apply_fill_color(
    grid: &mut Grid,
    grids: &mut [Grid],
    sheet_index: usize,
    style_registry: &mut StyleRegistry,
    row: u32,
    col: u32,
    color: engine::Color,
) {
    let old_style_index = grid.get_cell(row, col)
        .map(|c| c.style_index)
        .unwrap_or(0);
    let mut new_style = style_registry.get(old_style_index).clone();
    new_style.background = color;
    let new_style_index = style_registry.get_or_create(new_style);

    if let Some(existing) = grid.get_cell(row, col) {
        let mut updated = existing.clone();
        updated.style_index = new_style_index;
        grid.set_cell(row, col, updated);
    } else {
        let mut new_cell = engine::Cell::default();
        new_cell.style_index = new_style_index;
        grid.set_cell(row, col, new_cell);
    }

    if let Some(g) = grids.get_mut(sheet_index) {
        if let Some(existing) = g.get_cell(row, col) {
            let mut updated = existing.clone();
            updated.style_index = new_style_index;
            g.set_cell(row, col, updated);
        } else {
            let mut new_cell = engine::Cell::default();
            new_cell.style_index = new_style_index;
            g.set_cell(row, col, new_cell);
        }
    }
}

/// Apply a style mutation to the target cells (cell, all cells in a column, or all cells in a row).
fn apply_style_change<F>(
    target_type: &str,
    target_index: u32,
    target_index2: Option<u32>,
    grid: &mut Grid,
    grids: &mut [Grid],
    sheet_index: usize,
    style_registry: &mut StyleRegistry,
    mutate: F,
) where
    F: Fn(&mut engine::CellStyle),
{
    let cells_to_update: Vec<(u32, u32)> = match target_type {
        "cell" => {
            let row = target_index;
            let col = target_index2.unwrap_or(0);
            vec![(row, col)]
        }
        "column" => {
            let col = target_index;
            grid.cells.keys().copied()
                .filter(|&(_, c)| c == col)
                .collect()
        }
        "row" => {
            let row = target_index;
            grid.cells.keys().copied()
                .filter(|&(r, _)| r == row)
                .collect()
        }
        _ => vec![],
    };

    for (row, col) in cells_to_update {
        let old_style_index = grid.get_cell(row, col)
            .map(|c| c.style_index)
            .unwrap_or(0);
        let mut new_style = style_registry.get(old_style_index).clone();
        mutate(&mut new_style);
        let new_style_index = style_registry.get_or_create(new_style);

        if let Some(existing) = grid.get_cell(row, col) {
            let mut updated = existing.clone();
            updated.style_index = new_style_index;
            grid.set_cell(row, col, updated.clone());
            if let Some(g) = grids.get_mut(sheet_index) {
                g.set_cell(row, col, updated);
            }
        } else {
            let mut new_cell = engine::Cell::default();
            new_cell.style_index = new_style_index;
            grid.set_cell(row, col, new_cell.clone());
            if let Some(g) = grids.get_mut(sheet_index) {
                g.set_cell(row, col, new_cell);
            }
        }
    }
}

// ============================================================================
// Value conversion helpers
// ============================================================================

fn value_as_f64(val: &CellValue) -> Option<f64> {
    match val {
        CellValue::Number(n) => Some(*n),
        CellValue::Text(s) => s.parse::<f64>().ok(),
        CellValue::Boolean(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

fn value_as_string(val: &CellValue) -> String {
    match val {
        CellValue::Text(s) => s.clone(),
        CellValue::Number(n) => format!("{}", n),
        CellValue::Boolean(b) => if *b { "TRUE".to_string() } else { "FALSE".to_string() },
        _ => String::new(),
    }
}

fn value_as_bool(val: &CellValue) -> bool {
    match val {
        CellValue::Boolean(b) => *b,
        CellValue::Number(n) => *n != 0.0,
        CellValue::Text(s) => s.eq_ignore_ascii_case("true") || s == "1",
        _ => false,
    }
}

fn parse_color(s: &str) -> Option<engine::Color> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    // Support hex format: #RGB, #RRGGBB, #RRGGBBAA
    if s.starts_with('#') {
        let hex = &s[1..];
        match hex.len() {
            3 => {
                let r = u8::from_str_radix(&hex[0..1].repeat(2), 16).ok()?;
                let g = u8::from_str_radix(&hex[1..2].repeat(2), 16).ok()?;
                let b = u8::from_str_radix(&hex[2..3].repeat(2), 16).ok()?;
                Some(engine::Color::new(r, g, b))
            }
            6 => {
                let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
                let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
                let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
                Some(engine::Color::new(r, g, b))
            }
            8 => {
                let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
                let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
                let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
                let a = u8::from_str_radix(&hex[6..8], 16).ok()?;
                Some(engine::Color::with_alpha(r, g, b, a))
            }
            _ => None,
        }
    } else {
        None
    }
}

fn parse_text_align(s: &str) -> Option<engine::TextAlign> {
    match s.to_lowercase().as_str() {
        "left" => Some(engine::TextAlign::Left),
        "center" | "centre" => Some(engine::TextAlign::Center),
        "right" => Some(engine::TextAlign::Right),
        _ => None,
    }
}

fn cell_value_display(val: &CellValue) -> String {
    match val {
        CellValue::Number(n) => format!("{}", n),
        CellValue::Text(s) => s.clone(),
        CellValue::Boolean(b) => if *b { "TRUE".to_string() } else { "FALSE".to_string() },
        CellValue::Error(e) => format!("#{:?}", e).to_uppercase(),
        CellValue::Empty => String::new(),
    }
}

// ============================================================================
// Dependency tracking helpers
// ============================================================================

/// Extract cell references from a formula and update dependency maps.
fn update_prop_dependencies(
    prop_id: u64,
    formula: &str,
    sheet_index: usize,
    grid: &Grid,
    deps: &mut ComputedPropDependencies,
    rev_deps: &mut ComputedPropDependents,
) {
    // Clear old dependencies for this prop
    if let Some(old_cells) = deps.remove(&prop_id) {
        for cell_key in &old_cells {
            if let Some(set) = rev_deps.get_mut(cell_key) {
                set.remove(&prop_id);
                if set.is_empty() {
                    rev_deps.remove(cell_key);
                }
            }
        }
    }

    // Parse formula and extract references
    if let Ok(parsed) = parser::parse(formula) {
        let refs = crate::extract_all_references(&parsed, grid);
        let mut cell_set: HashSet<(usize, u32, u32)> = HashSet::new();

        // Same-sheet cell references
        for (r, c) in &refs.cells {
            cell_set.insert((sheet_index, *r, *c));
        }

        // Cross-sheet references (simplified: just track the cell coords on the target sheet)
        // For now we map sheet names to indices when we have the data
        // This is sufficient for Phase 2; Phase 7 will refine cross-sheet triggers

        deps.insert(prop_id, cell_set.clone());
        for cell_key in cell_set {
            rev_deps.entry(cell_key).or_insert_with(HashSet::new).insert(prop_id);
        }
    }
}

/// Remove all dependencies for a given prop_id.
fn clear_prop_dependencies(
    prop_id: u64,
    deps: &mut ComputedPropDependencies,
    rev_deps: &mut ComputedPropDependents,
) {
    if let Some(old_cells) = deps.remove(&prop_id) {
        for cell_key in &old_cells {
            if let Some(set) = rev_deps.get_mut(cell_key) {
                set.remove(&prop_id);
                if set.is_empty() {
                    rev_deps.remove(cell_key);
                }
            }
        }
    }
}

// ============================================================================
// Tauri commands
// ============================================================================

/// Get computed properties for a target (column, row, or cell).
#[tauri::command]
pub fn get_computed_properties(
    state: State<AppState>,
    target_type: String,
    index: u32,
    index2: Option<u32>,
) -> Vec<ComputedPropertyData> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let props_storage = state.computed_properties.lock().unwrap();

    let sheet_props = match props_storage.get(&active_sheet) {
        Some(sp) => sp,
        None => return Vec::new(),
    };

    let props = match target_type.as_str() {
        "column" => sheet_props.column_props.get(&index),
        "row" => sheet_props.row_props.get(&index),
        "cell" => {
            let row = index;
            let col = index2.unwrap_or(0);
            sheet_props.cell_props.get(&(row, col))
        }
        _ => None,
    };

    match props {
        Some(list) => list.iter().map(|p| ComputedPropertyData {
            id: p.id,
            attribute: p.attribute.clone(),
            formula: p.formula.clone(),
            current_value: p.cached_value.as_ref().map(cell_value_display),
        }).collect(),
        None => Vec::new(),
    }
}

/// Get the list of available attributes for a target type.
#[tauri::command]
pub fn get_available_attributes(target_type: String) -> Vec<String> {
    available_attributes(&target_type)
        .into_iter()
        .map(|s| s.to_string())
        .collect()
}

/// Add a new computed property to a target.
#[tauri::command]
pub fn add_computed_property(
    state: State<AppState>,
    target_type: String,
    index: u32,
    index2: Option<u32>,
    attribute: String,
    formula: String,
) -> ComputedPropertyResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let grids = state.grids.lock().unwrap();
    let grid = state.grid.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let row_heights_snapshot = state.row_heights.lock().unwrap().clone();
    let col_widths_snapshot = state.column_widths.lock().unwrap().clone();

    // Generate new ID
    let mut next_id = state.next_computed_prop_id.lock().unwrap();
    let prop_id = *next_id;
    *next_id += 1;
    drop(next_id);

    // Parse and cache the AST
    let cached_ast = parser::parse(&formula)
        .ok()
        .map(|parsed| crate::convert_expr(&parsed));

    // Determine the evaluation position (so ROW()/COLUMN() refer to the target)
    let (eval_row, eval_col) = match target_type.as_str() {
        "column" => (0, index),
        "row" => (index, 0),
        "cell" => (index, index2.unwrap_or(0)),
        _ => (0, 0),
    };

    // Evaluate the formula
    let eval_result = evaluate_property(
        &grids,
        &sheet_names,
        active_sheet,
        &ComputedProperty {
            id: prop_id,
            attribute: attribute.clone(),
            formula: formula.clone(),
            cached_ast: cached_ast.clone(),
            cached_value: None,
        },
        eval_row,
        eval_col,
        &row_heights_snapshot,
        &col_widths_snapshot,
        &styles,
    );

    // Store the property
    let mut props_storage = state.computed_properties.lock().unwrap();
    let sheet_props = props_storage.entry(active_sheet).or_insert_with(SheetComputedProperties::default);

    let prop = ComputedProperty {
        id: prop_id,
        attribute: attribute.clone(),
        formula: formula.clone(),
        cached_ast,
        cached_value: Some(eval_result.clone()),
    };

    match target_type.as_str() {
        "column" => sheet_props.column_props.entry(index).or_insert_with(Vec::new).push(prop),
        "row" => sheet_props.row_props.entry(index).or_insert_with(Vec::new).push(prop),
        "cell" => {
            let row = index;
            let col = index2.unwrap_or(0);
            sheet_props.cell_props.entry((row, col)).or_insert_with(Vec::new).push(prop);
        }
        _ => {}
    }

    // Update dependency tracking
    let mut deps = state.computed_prop_dependencies.lock().unwrap();
    let mut rev_deps = state.computed_prop_dependents.lock().unwrap();
    update_prop_dependencies(prop_id, &formula, active_sheet, &grid, &mut deps, &mut rev_deps);

    // Drop locks we no longer need before applying effects
    drop(props_storage);
    drop(grids);
    drop(grid);
    drop(sheet_names);
    drop(styles);
    drop(deps);
    drop(rev_deps);

    // Apply the computed value to the target
    let mut rh = state.row_heights.lock().unwrap();
    let mut cw = state.column_widths.lock().unwrap();
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let mut style_reg = state.style_registry.lock().unwrap();

    let (dimension_changes, needs_style_refresh) = apply_property_value(
        &attribute,
        &eval_result,
        &target_type,
        index,
        index2,
        &mut rh,
        &mut cw,
        &mut grid,
        &mut grids,
        active_sheet,
        &mut style_reg,
    );

    drop(rh);
    drop(cw);
    drop(grid);
    drop(grids);
    drop(style_reg);

    // Build response with current properties list
    let props_storage = state.computed_properties.lock().unwrap();
    let properties = get_props_list(&props_storage, active_sheet, &target_type, index, index2);

    ComputedPropertyResult {
        success: true,
        properties,
        dimension_changes,
        needs_style_refresh,
    }
}

/// Update an existing computed property's attribute and/or formula.
#[tauri::command]
pub fn update_computed_property(
    state: State<AppState>,
    prop_id: u64,
    attribute: String,
    formula: String,
) -> ComputedPropertyResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let grids = state.grids.lock().unwrap();
    let grid = state.grid.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let row_heights_snapshot = state.row_heights.lock().unwrap().clone();
    let col_widths_snapshot = state.column_widths.lock().unwrap().clone();

    // Find and update the property
    let mut props_storage = state.computed_properties.lock().unwrap();
    let (target_type, index, index2) = match find_prop_location(&props_storage, active_sheet, prop_id) {
        Some(loc) => loc,
        None => return ComputedPropertyResult {
            success: false,
            properties: Vec::new(),
            dimension_changes: Vec::new(),
            needs_style_refresh: false,
        },
    };

    let (eval_row, eval_col) = match target_type.as_str() {
        "column" => (0, index),
        "row" => (index, 0),
        "cell" => (index, index2.unwrap_or(0)),
        _ => (0, 0),
    };

    // Parse and cache new AST
    let cached_ast = parser::parse(&formula)
        .ok()
        .map(|parsed| crate::convert_expr(&parsed));

    // Evaluate new formula
    let eval_result = evaluate_property(
        &grids,
        &sheet_names,
        active_sheet,
        &ComputedProperty {
            id: prop_id,
            attribute: attribute.clone(),
            formula: formula.clone(),
            cached_ast: cached_ast.clone(),
            cached_value: None,
        },
        eval_row,
        eval_col,
        &row_heights_snapshot,
        &col_widths_snapshot,
        &styles,
    );

    // Update in storage
    if let Some(sheet_props) = props_storage.get_mut(&active_sheet) {
        let list = match target_type.as_str() {
            "column" => sheet_props.column_props.get_mut(&index),
            "row" => sheet_props.row_props.get_mut(&index),
            "cell" => sheet_props.cell_props.get_mut(&(index, index2.unwrap_or(0))),
            _ => None,
        };
        if let Some(list) = list {
            if let Some(prop) = list.iter_mut().find(|p| p.id == prop_id) {
                prop.attribute = attribute.clone();
                prop.formula = formula.clone();
                prop.cached_ast = cached_ast;
                prop.cached_value = Some(eval_result.clone());
            }
        }
    }

    // Update dependencies
    let mut deps = state.computed_prop_dependencies.lock().unwrap();
    let mut rev_deps = state.computed_prop_dependents.lock().unwrap();
    update_prop_dependencies(prop_id, &formula, active_sheet, &grid, &mut deps, &mut rev_deps);

    drop(props_storage);
    drop(grids);
    drop(grid);
    drop(sheet_names);
    drop(styles);
    drop(deps);
    drop(rev_deps);

    // Apply effect
    let mut rh = state.row_heights.lock().unwrap();
    let mut cw = state.column_widths.lock().unwrap();
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let mut style_reg = state.style_registry.lock().unwrap();

    let (dimension_changes, needs_style_refresh) = apply_property_value(
        &attribute,
        &eval_result,
        &target_type,
        index,
        index2,
        &mut rh,
        &mut cw,
        &mut grid,
        &mut grids,
        active_sheet,
        &mut style_reg,
    );

    drop(rh);
    drop(cw);
    drop(grid);
    drop(grids);
    drop(style_reg);

    let props_storage = state.computed_properties.lock().unwrap();
    let properties = get_props_list(&props_storage, active_sheet, &target_type, index, index2);

    ComputedPropertyResult {
        success: true,
        properties,
        dimension_changes,
        needs_style_refresh,
    }
}

/// Remove a computed property by ID.
#[tauri::command]
pub fn remove_computed_property(
    state: State<AppState>,
    prop_id: u64,
) -> ComputedPropertyResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut props_storage = state.computed_properties.lock().unwrap();

    let (target_type, index, index2) = match find_prop_location(&props_storage, active_sheet, prop_id) {
        Some(loc) => loc,
        None => return ComputedPropertyResult {
            success: false,
            properties: Vec::new(),
            dimension_changes: Vec::new(),
            needs_style_refresh: false,
        },
    };

    // Remove the property
    if let Some(sheet_props) = props_storage.get_mut(&active_sheet) {
        let list = match target_type.as_str() {
            "column" => sheet_props.column_props.get_mut(&index),
            "row" => sheet_props.row_props.get_mut(&index),
            "cell" => sheet_props.cell_props.get_mut(&(index, index2.unwrap_or(0))),
            _ => None,
        };
        if let Some(list) = list {
            list.retain(|p| p.id != prop_id);
        }
    }

    // Clear dependencies
    let mut deps = state.computed_prop_dependencies.lock().unwrap();
    let mut rev_deps = state.computed_prop_dependents.lock().unwrap();
    clear_prop_dependencies(prop_id, &mut deps, &mut rev_deps);

    let properties = get_props_list(&props_storage, active_sheet, &target_type, index, index2);

    // For dimension attributes, removing means reverting to default
    let mut dimension_changes = Vec::new();
    // Check what attribute was removed so we can revert if it's a dimension
    // We don't have the attribute anymore since it's removed, but we can handle
    // dimension revert by setting size to 0 (frontend interprets as default)
    // Actually, we need to look at remaining props to decide.
    // For simplicity, if width/height was removed and no other width/height prop exists,
    // revert to default by sending size=0.
    let has_width = properties.iter().any(|p| p.attribute == "width");
    let has_height = properties.iter().any(|p| p.attribute == "height");

    if target_type == "column" && !has_width {
        // Revert column width to default
        let mut cw = state.column_widths.lock().unwrap();
        cw.remove(&index);
        dimension_changes.push(DimensionData {
            index,
            size: 0.0,
            dimension_type: "column".to_string(),
        });
    }
    if target_type == "row" && !has_height {
        let mut rh = state.row_heights.lock().unwrap();
        rh.remove(&index);
        dimension_changes.push(DimensionData {
            index,
            size: 0.0,
            dimension_type: "row".to_string(),
        });
    }

    ComputedPropertyResult {
        success: true,
        properties,
        dimension_changes,
        needs_style_refresh: false,
    }
}

// ============================================================================
// Re-evaluation trigger (called from data.rs and calculation.rs)
// ============================================================================

/// Re-evaluate all computed properties affected by a set of changed cells.
/// Takes already-locked references (no locking inside).
/// Returns (dimension_changes, needs_style_refresh).
pub fn re_evaluate_for_changed_cells(
    changed_cells: &[(usize, u32, u32)],
    cp_storage: &mut ComputedPropertiesStorage,
    cp_dependents: &ComputedPropDependents,
    grids: &mut [Grid],
    grid: &mut Grid,
    sheet_names: &[String],
    active_sheet: usize,
    row_heights: &mut HashMap<u32, f64>,
    column_widths: &mut HashMap<u32, f64>,
    style_registry: &mut StyleRegistry,
) -> (Vec<DimensionData>, bool) {
    // 1. Collect all affected prop_ids
    let mut affected_props: HashSet<u64> = HashSet::new();
    for cell_key in changed_cells {
        if let Some(prop_ids) = cp_dependents.get(cell_key) {
            affected_props.extend(prop_ids);
        }
    }

    if affected_props.is_empty() {
        return (Vec::new(), false);
    }

    // 2. Evaluate each affected property (uses immutable grids via reborrow)
    // Collect: (prop_id, attribute, target_type, target_index, target_index2, new_value)
    let mut eval_results: Vec<(u64, String, String, u32, Option<u32>, CellValue)> = Vec::new();

    for &prop_id in &affected_props {
        // Find the property's location and data
        for (&sheet_idx, sheet_props) in cp_storage.iter() {
            // Search column_props
            for (&col_idx, props_list) in &sheet_props.column_props {
                for prop in props_list {
                    if prop.id == prop_id {
                        let val = evaluate_property(
                            grids, sheet_names, sheet_idx, prop,
                            0, col_idx, row_heights, column_widths, style_registry,
                        );
                        eval_results.push((prop_id, prop.attribute.clone(), "column".to_string(), col_idx, None, val));
                    }
                }
            }
            // Search row_props
            for (&row_idx, props_list) in &sheet_props.row_props {
                for prop in props_list {
                    if prop.id == prop_id {
                        let val = evaluate_property(
                            grids, sheet_names, sheet_idx, prop,
                            row_idx, 0, row_heights, column_widths, style_registry,
                        );
                        eval_results.push((prop_id, prop.attribute.clone(), "row".to_string(), row_idx, None, val));
                    }
                }
            }
            // Search cell_props
            for (&(row_idx, col_idx), props_list) in &sheet_props.cell_props {
                for prop in props_list {
                    if prop.id == prop_id {
                        let val = evaluate_property(
                            grids, sheet_names, sheet_idx, prop,
                            row_idx, col_idx, row_heights, column_widths, style_registry,
                        );
                        eval_results.push((prop_id, prop.attribute.clone(), "cell".to_string(), row_idx, Some(col_idx), val));
                    }
                }
            }
        }
    }

    // 3. Update cached values in storage
    for (prop_id, _, _, _, _, ref val) in &eval_results {
        for sheet_props in cp_storage.values_mut() {
            for props_list in sheet_props.column_props.values_mut()
                .chain(sheet_props.row_props.values_mut())
            {
                if let Some(prop) = props_list.iter_mut().find(|p| p.id == *prop_id) {
                    prop.cached_value = Some(val.clone());
                }
            }
            for props_list in sheet_props.cell_props.values_mut() {
                if let Some(prop) = props_list.iter_mut().find(|p| p.id == *prop_id) {
                    prop.cached_value = Some(val.clone());
                }
            }
        }
    }

    // 4. Apply all results
    let mut all_dimension_changes = Vec::new();
    let mut any_style_refresh = false;

    for (_prop_id, attribute, target_type, index, index2, value) in &eval_results {
        let (dim_changes, style_refresh) = apply_property_value(
            attribute, value, target_type, *index, *index2,
            row_heights, column_widths, grid, grids, active_sheet, style_registry,
        );
        all_dimension_changes.extend(dim_changes);
        any_style_refresh = any_style_refresh || style_refresh;
    }

    (all_dimension_changes, any_style_refresh)
}

/// Re-evaluate ALL computed properties for a given sheet.
/// Used by calculate_now (manual recalculation).
pub fn re_evaluate_all_properties(
    cp_storage: &mut ComputedPropertiesStorage,
    grids: &mut [Grid],
    grid: &mut Grid,
    sheet_names: &[String],
    sheet_index: usize,
    row_heights: &mut HashMap<u32, f64>,
    column_widths: &mut HashMap<u32, f64>,
    style_registry: &mut StyleRegistry,
) -> (Vec<DimensionData>, bool) {
    let sheet_props = match cp_storage.get(&sheet_index) {
        Some(sp) => sp.clone(),
        None => return (Vec::new(), false),
    };

    // Collect all evaluations
    let mut eval_results: Vec<(u64, String, String, u32, Option<u32>, CellValue)> = Vec::new();

    for (&col_idx, props_list) in &sheet_props.column_props {
        for prop in props_list {
            let val = evaluate_property(
                grids, sheet_names, sheet_index, prop,
                0, col_idx, row_heights, column_widths, style_registry,
            );
            eval_results.push((prop.id, prop.attribute.clone(), "column".to_string(), col_idx, None, val));
        }
    }
    for (&row_idx, props_list) in &sheet_props.row_props {
        for prop in props_list {
            let val = evaluate_property(
                grids, sheet_names, sheet_index, prop,
                row_idx, 0, row_heights, column_widths, style_registry,
            );
            eval_results.push((prop.id, prop.attribute.clone(), "row".to_string(), row_idx, None, val));
        }
    }
    for (&(row_idx, col_idx), props_list) in &sheet_props.cell_props {
        for prop in props_list {
            let val = evaluate_property(
                grids, sheet_names, sheet_index, prop,
                row_idx, col_idx, row_heights, column_widths, style_registry,
            );
            eval_results.push((prop.id, prop.attribute.clone(), "cell".to_string(), row_idx, Some(col_idx), val));
        }
    }

    // Update cached values
    if let Some(sp) = cp_storage.get_mut(&sheet_index) {
        for (prop_id, _, _, _, _, ref val) in &eval_results {
            for props_list in sp.column_props.values_mut()
                .chain(sp.row_props.values_mut())
            {
                if let Some(prop) = props_list.iter_mut().find(|p| p.id == *prop_id) {
                    prop.cached_value = Some(val.clone());
                }
            }
            for props_list in sp.cell_props.values_mut() {
                if let Some(prop) = props_list.iter_mut().find(|p| p.id == *prop_id) {
                    prop.cached_value = Some(val.clone());
                }
            }
        }
    }

    // Apply all results
    let mut all_dimension_changes = Vec::new();
    let mut any_style_refresh = false;

    for (_prop_id, attribute, target_type, index, index2, value) in &eval_results {
        let (dim_changes, style_refresh) = apply_property_value(
            attribute, value, target_type, *index, *index2,
            row_heights, column_widths, grid, grids, sheet_index, style_registry,
        );
        all_dimension_changes.extend(dim_changes);
        any_style_refresh = any_style_refresh || style_refresh;
    }

    (all_dimension_changes, any_style_refresh)
}

// ============================================================================
// Internal helpers
// ============================================================================

/// Find which target type and indices a prop_id belongs to.
fn find_prop_location(
    storage: &ComputedPropertiesStorage,
    sheet_index: usize,
    prop_id: u64,
) -> Option<(String, u32, Option<u32>)> {
    let sheet_props = storage.get(&sheet_index)?;

    for (col, props) in &sheet_props.column_props {
        if props.iter().any(|p| p.id == prop_id) {
            return Some(("column".to_string(), *col, None));
        }
    }
    for (row, props) in &sheet_props.row_props {
        if props.iter().any(|p| p.id == prop_id) {
            return Some(("row".to_string(), *row, None));
        }
    }
    for ((row, col), props) in &sheet_props.cell_props {
        if props.iter().any(|p| p.id == prop_id) {
            return Some(("cell".to_string(), *row, Some(*col)));
        }
    }
    None
}

/// Get current props list for a target as ComputedPropertyData.
fn get_props_list(
    storage: &ComputedPropertiesStorage,
    sheet_index: usize,
    target_type: &str,
    index: u32,
    index2: Option<u32>,
) -> Vec<ComputedPropertyData> {
    let sheet_props = match storage.get(&sheet_index) {
        Some(sp) => sp,
        None => return Vec::new(),
    };

    let props = match target_type {
        "column" => sheet_props.column_props.get(&index),
        "row" => sheet_props.row_props.get(&index),
        "cell" => sheet_props.cell_props.get(&(index, index2.unwrap_or(0))),
        _ => None,
    };

    match props {
        Some(list) => list.iter().map(|p| ComputedPropertyData {
            id: p.id,
            attribute: p.attribute.clone(),
            formula: p.formula.clone(),
            current_value: p.cached_value.as_ref().map(cell_value_display),
        }).collect(),
        None => Vec::new(),
    }
}
