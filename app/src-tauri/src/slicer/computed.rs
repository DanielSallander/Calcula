//! FILENAME: app/src-tauri/src/slicer/computed.rs
//! PURPOSE: Computed properties for slicers — formula-driven dynamic attributes.
//! CONTEXT: Allows users to control slicer attributes (width, height, columns, etc.)
//!          via formulas that reference cell values. When referenced cells change,
//!          the slicer attributes are re-evaluated automatically.

use std::collections::{HashMap, HashSet};
use engine::{self, CellValue, Grid, StyleRegistry};
use tauri::State;
use crate::api_types::{SlicerComputedPropertyData, SlicerComputedPropertyResult};
use crate::{evaluate_formula_with_context, AppState};
use crate::slicer::SlicerState;
use crate::log_debug;

// ============================================================================
// Storage types
// ============================================================================

/// A single computed property attached to a slicer.
#[derive(Debug, Clone)]
pub struct SlicerComputedProperty {
    pub id: u64,
    pub slicer_id: u64,
    pub attribute: String,
    pub formula: String,
    /// Cached engine AST for fast re-evaluation.
    pub cached_ast: Option<engine::Expression>,
    /// Last evaluated value (for display in the dialog).
    pub cached_value: Option<CellValue>,
}

/// All slicer computed properties: slicer_id -> list of properties.
pub type SlicerComputedPropertiesStorage = HashMap<u64, Vec<SlicerComputedProperty>>;

/// Dependency tracking: prop_id -> set of (sheet_index, row, col) cells the formula references.
pub type SlicerComputedPropDependencies = HashMap<u64, HashSet<(usize, u32, u32)>>;

/// Reverse dependency: (sheet_index, row, col) -> set of prop_ids that need re-evaluation.
pub type SlicerComputedPropDependents = HashMap<(usize, u32, u32), HashSet<u64>>;

// ============================================================================
// Available attributes
// ============================================================================

/// Returns the valid attribute names for slicer computed properties.
pub fn slicer_available_attributes() -> Vec<&'static str> {
    vec![
        "width",
        "height",
        "columns",
        "showHeader",
        "headerText",
        "stylePreset",
        "hideNoData",
        "indicateNoData",
        "sortNoDataLast",
        "itemGap",
        "itemPadding",
        "buttonRadius",
    ]
}

// ============================================================================
// Evaluation helpers
// ============================================================================

/// Evaluate a slicer computed property formula and return the result.
fn evaluate_slicer_property(
    grids: &[Grid],
    sheet_names: &[String],
    sheet_index: usize,
    prop: &SlicerComputedProperty,
    row_heights: &HashMap<u32, f64>,
    column_widths: &HashMap<u32, f64>,
    styles: &StyleRegistry,
) -> CellValue {
    let ast = match &prop.cached_ast {
        Some(ast) => ast.clone(),
        None => {
            match parser::parse(&prop.formula) {
                Ok(parsed) => crate::convert_expr(&parsed),
                Err(_) => return CellValue::Error(engine::CellError::Value),
            }
        }
    };

    // Slicer formulas don't have a specific cell context, use (0, 0)
    let eval_ctx = engine::EvalContext {
        current_row: Some(0),
        current_col: Some(0),
        row_heights: Some(row_heights.clone()),
        column_widths: Some(column_widths.clone()),
        hidden_rows: None,
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

/// Apply a computed property value to a slicer attribute.
/// Returns true if the slicer was modified.
fn apply_slicer_property_value(
    attribute: &str,
    value: &CellValue,
    slicer: &mut crate::slicer::Slicer,
) -> bool {
    match attribute {
        "width" => {
            if let Some(n) = value_to_f64(value) {
                let clamped = n.max(60.0).min(2000.0);
                if (slicer.width - clamped).abs() > 0.01 {
                    slicer.width = clamped;
                    return true;
                }
            }
        }
        "height" => {
            if let Some(n) = value_to_f64(value) {
                let clamped = n.max(60.0).min(2000.0);
                if (slicer.height - clamped).abs() > 0.01 {
                    slicer.height = clamped;
                    return true;
                }
            }
        }
        "columns" => {
            if let Some(n) = value_to_f64(value) {
                let clamped = (n as u32).clamp(1, 20);
                if slicer.columns != clamped {
                    slicer.columns = clamped;
                    return true;
                }
            }
        }
        "showHeader" => {
            if let Some(b) = value_to_bool(value) {
                if slicer.show_header != b {
                    slicer.show_header = b;
                    return true;
                }
            }
        }
        "headerText" => {
            if let Some(s) = value_to_string(value) {
                let new_val = if s.is_empty() { None } else { Some(s) };
                if slicer.header_text != new_val {
                    slicer.header_text = new_val;
                    return true;
                }
            }
        }
        "stylePreset" => {
            if let Some(s) = value_to_string(value) {
                if !s.is_empty() && slicer.style_preset != s {
                    slicer.style_preset = s;
                    return true;
                }
            }
        }
        "hideNoData" => {
            if let Some(b) = value_to_bool(value) {
                if slicer.hide_no_data != b {
                    slicer.hide_no_data = b;
                    return true;
                }
            }
        }
        "indicateNoData" => {
            if let Some(b) = value_to_bool(value) {
                if slicer.indicate_no_data != b {
                    slicer.indicate_no_data = b;
                    return true;
                }
            }
        }
        "sortNoDataLast" => {
            if let Some(b) = value_to_bool(value) {
                if slicer.sort_no_data_last != b {
                    slicer.sort_no_data_last = b;
                    return true;
                }
            }
        }
        "itemGap" => {
            if let Some(n) = value_to_f64(value) {
                let clamped = n.max(0.0).min(50.0);
                if (slicer.item_gap - clamped).abs() > 0.01 {
                    slicer.item_gap = clamped;
                    return true;
                }
            }
        }
        "itemPadding" => {
            if let Some(n) = value_to_f64(value) {
                let clamped = n.max(0.0).min(30.0);
                if (slicer.item_padding - clamped).abs() > 0.01 {
                    slicer.item_padding = clamped;
                    return true;
                }
            }
        }
        "buttonRadius" => {
            if let Some(n) = value_to_f64(value) {
                let clamped = n.max(0.0).min(20.0);
                if (slicer.button_radius - clamped).abs() > 0.01 {
                    slicer.button_radius = clamped;
                    return true;
                }
            }
        }
        _ => {}
    }
    false
}

/// Convert a CellValue to f64 if possible.
fn value_to_f64(value: &CellValue) -> Option<f64> {
    match value {
        CellValue::Number(n) => Some(*n),
        CellValue::Boolean(b) => Some(if *b { 1.0 } else { 0.0 }),
        CellValue::Text(s) => s.parse::<f64>().ok(),
        _ => None,
    }
}

/// Convert a CellValue to bool if possible.
fn value_to_bool(value: &CellValue) -> Option<bool> {
    match value {
        CellValue::Boolean(b) => Some(*b),
        CellValue::Number(n) => Some(*n != 0.0),
        CellValue::Text(s) => match s.to_lowercase().as_str() {
            "true" | "1" | "yes" => Some(true),
            "false" | "0" | "no" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

/// Convert a CellValue to String if possible.
fn value_to_string(value: &CellValue) -> Option<String> {
    match value {
        CellValue::Text(s) => Some(s.clone()),
        CellValue::Number(n) => Some(format!("{}", n)),
        CellValue::Boolean(b) => Some(if *b { "TRUE".to_string() } else { "FALSE".to_string() }),
        CellValue::Error(_) => None,
        CellValue::Empty => Some(String::new()),
        _ => None,
    }
}

/// Format a CellValue for display in the dialog.
fn format_value_for_display(value: &CellValue) -> String {
    match value {
        CellValue::Number(n) => {
            if n.fract() == 0.0 && n.abs() < 1e15 {
                format!("{}", *n as i64)
            } else {
                format!("{}", n)
            }
        }
        CellValue::Text(s) => s.clone(),
        CellValue::Boolean(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
        CellValue::Error(e) => format!("{:?}", e),
        CellValue::Empty => String::new(),
        _ => String::new(),
    }
}

// ============================================================================
// Dependency tracking
// ============================================================================

/// Update dependency maps for a slicer computed property.
fn update_slicer_prop_dependencies(
    prop_id: u64,
    formula: &str,
    sheet_index: usize,
    grid: &Grid,
    dependencies: &mut SlicerComputedPropDependencies,
    dependents: &mut SlicerComputedPropDependents,
) {
    // Remove old dependencies
    if let Some(old_cells) = dependencies.remove(&prop_id) {
        for cell in &old_cells {
            if let Some(prop_set) = dependents.get_mut(cell) {
                prop_set.remove(&prop_id);
                if prop_set.is_empty() {
                    dependents.remove(cell);
                }
            }
        }
    }

    // Parse formula and extract references
    if let Ok(parsed) = parser::parse(formula) {
        let refs = crate::extract_all_references(&parsed, grid);
        let mut cell_set: HashSet<(usize, u32, u32)> = HashSet::new();

        for (r, c) in &refs.cells {
            cell_set.insert((sheet_index, *r, *c));
        }

        if !cell_set.is_empty() {
            dependencies.insert(prop_id, cell_set.clone());
            for cell_key in cell_set {
                dependents.entry(cell_key).or_default().insert(prop_id);
            }
        }
    }
}

// ============================================================================
// Tauri commands
// ============================================================================

/// Get computed properties for a specific slicer.
#[tauri::command]
pub fn get_slicer_computed_properties(
    slicer_state: State<SlicerState>,
    slicer_id: u64,
) -> SlicerComputedPropertyResult {
    let props = slicer_state.computed_properties.lock().unwrap();
    let slicer_props = props.get(&slicer_id);

    let properties: Vec<SlicerComputedPropertyData> = slicer_props
        .map(|list| {
            list.iter()
                .map(|p| SlicerComputedPropertyData {
                    id: p.id,
                    slicer_id: p.slicer_id,
                    attribute: p.attribute.clone(),
                    formula: p.formula.clone(),
                    current_value: p.cached_value.as_ref().map(format_value_for_display),
                })
                .collect()
        })
        .unwrap_or_default();

    SlicerComputedPropertyResult {
        success: true,
        properties,
        slicer_changed: false,
    }
}

/// Get available attributes for slicer computed properties.
#[tauri::command]
pub fn get_slicer_available_attributes() -> Vec<String> {
    slicer_available_attributes()
        .into_iter()
        .map(|s| s.to_string())
        .collect()
}

/// Add a new computed property to a slicer.
#[tauri::command]
pub fn add_slicer_computed_property(
    state: State<AppState>,
    slicer_state: State<SlicerState>,
    slicer_id: u64,
    attribute: String,
    formula: String,
) -> Result<SlicerComputedPropertyResult, String> {
    // Validate attribute
    let valid = slicer_available_attributes();
    if !valid.contains(&attribute.as_str()) {
        return Err(format!("Invalid slicer attribute: {}", attribute));
    }

    // Check for duplicate attribute
    {
        let props = slicer_state.computed_properties.lock().unwrap();
        if let Some(list) = props.get(&slicer_id) {
            if list.iter().any(|p| p.attribute == attribute) {
                return Err(format!(
                    "Attribute '{}' already has a computed property",
                    attribute
                ));
            }
        }
    }

    // Get slicer's sheet index
    let sheet_index = {
        let slicers = slicer_state.slicers.lock().unwrap();
        let slicer = slicers
            .get(&slicer_id)
            .ok_or_else(|| format!("Slicer {} not found", slicer_id))?;
        slicer.sheet_index
    };

    // Generate ID
    let id = {
        let mut next = slicer_state.next_computed_prop_id.lock().unwrap();
        let id = *next;
        *next += 1;
        id
    };

    // Parse formula
    let cached_ast = match parser::parse(&formula) {
        Ok(parsed) => Some(crate::convert_expr(&parsed)),
        Err(_) => None,
    };

    // Evaluate formula
    let grids = state.grids.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();
    let row_heights = state.row_heights.lock().unwrap();
    let column_widths = state.column_widths.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();

    let mut prop = SlicerComputedProperty {
        id,
        slicer_id,
        attribute: attribute.clone(),
        formula: formula.clone(),
        cached_ast,
        cached_value: None,
    };

    let value = evaluate_slicer_property(
        &grids,
        &sheet_names,
        sheet_index,
        &prop,
        &row_heights,
        &column_widths,
        &styles,
    );
    prop.cached_value = Some(value.clone());

    // Apply to slicer
    let slicer_changed = {
        let mut slicers = slicer_state.slicers.lock().unwrap();
        if let Some(slicer) = slicers.get_mut(&slicer_id) {
            apply_slicer_property_value(&attribute, &value, slicer)
        } else {
            false
        }
    };

    // Update dependencies
    {
        let grid = if sheet_index < grids.len() { &grids[sheet_index] } else { &grids[0] };
        let mut deps = slicer_state.computed_prop_dependencies.lock().unwrap();
        let mut rev_deps = slicer_state.computed_prop_dependents.lock().unwrap();
        update_slicer_prop_dependencies(id, &formula, sheet_index, grid, &mut deps, &mut rev_deps);
    }

    // Store the property
    {
        let mut props = slicer_state.computed_properties.lock().unwrap();
        props.entry(slicer_id).or_default().push(prop);
    }

    log_debug!(
        "SLICER",
        "add_slicer_computed_property slicer={} attr={} formula={}",
        slicer_id,
        attribute,
        formula
    );

    // Build result
    let props = slicer_state.computed_properties.lock().unwrap();
    let slicer_props = props.get(&slicer_id);
    let properties: Vec<SlicerComputedPropertyData> = slicer_props
        .map(|list| {
            list.iter()
                .map(|p| SlicerComputedPropertyData {
                    id: p.id,
                    slicer_id: p.slicer_id,
                    attribute: p.attribute.clone(),
                    formula: p.formula.clone(),
                    current_value: p.cached_value.as_ref().map(format_value_for_display),
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(SlicerComputedPropertyResult {
        success: true,
        properties,
        slicer_changed,
    })
}

/// Update an existing slicer computed property.
#[tauri::command]
pub fn update_slicer_computed_property(
    state: State<AppState>,
    slicer_state: State<SlicerState>,
    prop_id: u64,
    attribute: Option<String>,
    formula: Option<String>,
) -> Result<SlicerComputedPropertyResult, String> {
    // Validate attribute if provided
    if let Some(ref attr) = attribute {
        let valid = slicer_available_attributes();
        if !valid.contains(&attr.as_str()) {
            return Err(format!("Invalid slicer attribute: {}", attr));
        }
    }

    // Find the property and its slicer
    let (slicer_id, sheet_index) = {
        let props = slicer_state.computed_properties.lock().unwrap();
        let mut found = None;
        for (sid, list) in props.iter() {
            if list.iter().any(|p| p.id == prop_id) {
                found = Some(*sid);
                break;
            }
        }
        let slicer_id = found.ok_or_else(|| format!("Property {} not found", prop_id))?;

        let slicers = slicer_state.slicers.lock().unwrap();
        let sheet_index = slicers
            .get(&slicer_id)
            .map(|s| s.sheet_index)
            .unwrap_or(0);
        (slicer_id, sheet_index)
    };

    // Check for duplicate attribute (if changing attribute)
    if let Some(ref new_attr) = attribute {
        let props = slicer_state.computed_properties.lock().unwrap();
        if let Some(list) = props.get(&slicer_id) {
            if list
                .iter()
                .any(|p| p.id != prop_id && p.attribute == *new_attr)
            {
                return Err(format!(
                    "Attribute '{}' already has a computed property",
                    new_attr
                ));
            }
        }
    }

    // Update the property
    let updated_attr;
    {
        let mut props = slicer_state.computed_properties.lock().unwrap();
        let list = props
            .get_mut(&slicer_id)
            .ok_or_else(|| "Slicer properties not found".to_string())?;
        let prop = list
            .iter_mut()
            .find(|p| p.id == prop_id)
            .ok_or_else(|| format!("Property {} not found", prop_id))?;

        if let Some(ref attr) = attribute {
            prop.attribute = attr.clone();
        }
        if let Some(ref f) = formula {
            prop.formula = f.clone();
            prop.cached_ast = match parser::parse(f) {
                Ok(parsed) => Some(crate::convert_expr(&parsed)),
                Err(_) => None,
            };
        }
        updated_attr = prop.attribute.clone();
    }

    // Re-evaluate
    let grids = state.grids.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();
    let row_heights = state.row_heights.lock().unwrap();
    let column_widths = state.column_widths.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();

    let value = {
        let props = slicer_state.computed_properties.lock().unwrap();
        let list = props.get(&slicer_id).unwrap();
        let prop = list.iter().find(|p| p.id == prop_id).unwrap();
        evaluate_slicer_property(
            &grids,
            &sheet_names,
            sheet_index,
            prop,
            &row_heights,
            &column_widths,
            &styles,
        )
    };

    // Update cached value
    {
        let mut props = slicer_state.computed_properties.lock().unwrap();
        let list = props.get_mut(&slicer_id).unwrap();
        let prop = list.iter_mut().find(|p| p.id == prop_id).unwrap();
        prop.cached_value = Some(value.clone());
    }

    // Apply to slicer
    let slicer_changed = {
        let mut slicers = slicer_state.slicers.lock().unwrap();
        if let Some(slicer) = slicers.get_mut(&slicer_id) {
            apply_slicer_property_value(&updated_attr, &value, slicer)
        } else {
            false
        }
    };

    // Update dependencies if formula changed
    if formula.is_some() {
        let current_formula = {
            let props = slicer_state.computed_properties.lock().unwrap();
            let list = props.get(&slicer_id).unwrap();
            let prop = list.iter().find(|p| p.id == prop_id).unwrap();
            prop.formula.clone()
        };
        let grid = if sheet_index < grids.len() { &grids[sheet_index] } else { &grids[0] };
        let mut deps = slicer_state.computed_prop_dependencies.lock().unwrap();
        let mut rev_deps = slicer_state.computed_prop_dependents.lock().unwrap();
        update_slicer_prop_dependencies(
            prop_id,
            &current_formula,
            sheet_index,
            grid,
            &mut deps,
            &mut rev_deps,
        );
    }

    // Build result
    let props = slicer_state.computed_properties.lock().unwrap();
    let slicer_props = props.get(&slicer_id);
    let properties: Vec<SlicerComputedPropertyData> = slicer_props
        .map(|list| {
            list.iter()
                .map(|p| SlicerComputedPropertyData {
                    id: p.id,
                    slicer_id: p.slicer_id,
                    attribute: p.attribute.clone(),
                    formula: p.formula.clone(),
                    current_value: p.cached_value.as_ref().map(format_value_for_display),
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(SlicerComputedPropertyResult {
        success: true,
        properties,
        slicer_changed,
    })
}

/// Remove a slicer computed property.
#[tauri::command]
pub fn remove_slicer_computed_property(
    slicer_state: State<SlicerState>,
    prop_id: u64,
) -> Result<SlicerComputedPropertyResult, String> {
    // Find which slicer owns this property
    let slicer_id = {
        let props = slicer_state.computed_properties.lock().unwrap();
        let mut found = None;
        for (sid, list) in props.iter() {
            if list.iter().any(|p| p.id == prop_id) {
                found = Some(*sid);
                break;
            }
        }
        found.ok_or_else(|| format!("Property {} not found", prop_id))?
    };

    // Remove the property
    {
        let mut props = slicer_state.computed_properties.lock().unwrap();
        if let Some(list) = props.get_mut(&slicer_id) {
            list.retain(|p| p.id != prop_id);
            if list.is_empty() {
                props.remove(&slicer_id);
            }
        }
    }

    // Clean up dependencies
    {
        let mut deps = slicer_state.computed_prop_dependencies.lock().unwrap();
        let mut rev_deps = slicer_state.computed_prop_dependents.lock().unwrap();
        if let Some(old_cells) = deps.remove(&prop_id) {
            for cell in &old_cells {
                if let Some(prop_set) = rev_deps.get_mut(cell) {
                    prop_set.remove(&prop_id);
                    if prop_set.is_empty() {
                        rev_deps.remove(cell);
                    }
                }
            }
        }
    }

    log_debug!(
        "SLICER",
        "remove_slicer_computed_property prop_id={}",
        prop_id
    );

    // Build result
    let props = slicer_state.computed_properties.lock().unwrap();
    let slicer_props = props.get(&slicer_id);
    let properties: Vec<SlicerComputedPropertyData> = slicer_props
        .map(|list| {
            list.iter()
                .map(|p| SlicerComputedPropertyData {
                    id: p.id,
                    slicer_id: p.slicer_id,
                    attribute: p.attribute.clone(),
                    formula: p.formula.clone(),
                    current_value: p.cached_value.as_ref().map(format_value_for_display),
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(SlicerComputedPropertyResult {
        success: true,
        properties,
        slicer_changed: false,
    })
}

/// Re-evaluate slicer computed properties affected by changed cells.
/// Called from the main recalculation flow when cells change.
/// Returns a set of slicer IDs that were modified.
pub fn re_evaluate_slicer_computed_properties(
    changed_cells: &[(usize, u32, u32)],
    grids: &[Grid],
    sheet_names: &[String],
    row_heights: &HashMap<u32, f64>,
    column_widths: &HashMap<u32, f64>,
    styles: &StyleRegistry,
    slicer_state: &SlicerState,
) -> HashSet<u64> {
    let mut affected_prop_ids: HashSet<u64> = HashSet::new();
    let mut modified_slicers: HashSet<u64> = HashSet::new();

    // Collect affected property IDs
    {
        let rev_deps = slicer_state.computed_prop_dependents.lock().unwrap();
        for cell in changed_cells {
            if let Some(prop_ids) = rev_deps.get(cell) {
                affected_prop_ids.extend(prop_ids);
            }
        }
    }

    if affected_prop_ids.is_empty() {
        return modified_slicers;
    }

    // Re-evaluate each affected property
    let mut props = slicer_state.computed_properties.lock().unwrap();
    let mut slicers = slicer_state.slicers.lock().unwrap();

    for prop_id in &affected_prop_ids {
        // Find the property across all slicers
        let mut found_slicer_id = None;
        let mut found_idx = None;

        for (sid, list) in props.iter() {
            for (idx, p) in list.iter().enumerate() {
                if p.id == *prop_id {
                    found_slicer_id = Some(*sid);
                    found_idx = Some(idx);
                    break;
                }
            }
            if found_slicer_id.is_some() {
                break;
            }
        }

        if let (Some(slicer_id), Some(idx)) = (found_slicer_id, found_idx) {
            let sheet_index = slicers.get(&slicer_id).map(|s| s.sheet_index).unwrap_or(0);

            // Evaluate
            let value = {
                let list = props.get(&slicer_id).unwrap();
                let prop = &list[idx];
                evaluate_slicer_property(
                    grids,
                    sheet_names,
                    sheet_index,
                    prop,
                    row_heights,
                    column_widths,
                    styles,
                )
            };

            // Update cached value
            {
                let list = props.get_mut(&slicer_id).unwrap();
                list[idx].cached_value = Some(value.clone());
            }

            // Apply to slicer
            if let Some(slicer) = slicers.get_mut(&slicer_id) {
                let attr = props.get(&slicer_id).unwrap()[idx].attribute.clone();
                if apply_slicer_property_value(&attr, &value, slicer) {
                    modified_slicers.insert(slicer_id);
                }
            }
        }
    }

    modified_slicers
}

/// Get computed attribute names for a slicer (used by UI to grey out controlled attributes).
#[tauri::command]
pub fn get_slicer_computed_attributes(
    slicer_state: State<SlicerState>,
    slicer_id: u64,
) -> Vec<String> {
    let props = slicer_state.computed_properties.lock().unwrap();
    props
        .get(&slicer_id)
        .map(|list| list.iter().map(|p| p.attribute.clone()).collect())
        .unwrap_or_default()
}
