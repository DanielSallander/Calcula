//! FILENAME: app/src-tauri/src/controls.rs
// PURPOSE: Control metadata storage and Tauri commands.
// CONTEXT: Stores per-cell control properties (script references, formula-driven properties).
//          The button/checkbox bool in CellStyle handles fast rendering checks;
//          this module stores richer metadata like onSelect scripts and formula properties.

use crate::{
    AppState, format_cell_value_simple, parse_formula, convert_expr, create_multi_sheet_context,
    ast_has_named_refs, resolve_names_in_ast, ast_has_table_refs, resolve_table_refs_in_ast,
    TableRefContext,
};
use engine::{CellValue, Evaluator};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tauri::State;

// ============================================================================
// Types
// ============================================================================

/// A single property value that can be either a static value or a formula.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlPropertyValue {
    /// "static" or "formula"
    pub value_type: String,
    /// The static value or formula string (formulas start with "=")
    pub value: String,
}

/// Metadata for a single control instance at a specific cell.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlMetadata {
    /// Control type identifier: "button", "checkbox", etc.
    pub control_type: String,
    /// Map of property name to property value.
    /// Common properties: text, fill, color, borderColor, fontSize, onSelect, tooltip
    pub properties: HashMap<String, ControlPropertyValue>,
}

/// Location key for a control: (sheet_index, row, col)
type ControlKey = (usize, u32, u32);

/// Storage for all controls: (sheet_index, row, col) -> ControlMetadata
pub type ControlStorage = HashMap<ControlKey, ControlMetadata>;

/// A control entry with its location, for returning lists.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlEntry {
    pub sheet_index: usize,
    pub row: u32,
    pub col: u32,
    pub metadata: ControlMetadata,
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Get the control metadata for a specific cell.
#[tauri::command]
pub fn get_control_metadata(
    state: State<AppState>,
    sheet_index: usize,
    row: u32,
    col: u32,
) -> Option<ControlMetadata> {
    let controls = state.controls.lock().unwrap();
    controls.get(&(sheet_index, row, col)).cloned()
}

/// Set a single property on a control. Creates the control metadata if it doesn't exist.
#[tauri::command]
pub fn set_control_property(
    state: State<AppState>,
    sheet_index: usize,
    row: u32,
    col: u32,
    control_type: String,
    property_name: String,
    value_type: String,
    value: String,
) -> ControlMetadata {
    let mut controls = state.controls.lock().unwrap();
    let key = (sheet_index, row, col);

    let metadata = controls.entry(key).or_insert_with(|| ControlMetadata {
        control_type: control_type.clone(),
        properties: HashMap::new(),
    });

    // Update control type if provided (allows changing control type)
    if !control_type.is_empty() {
        metadata.control_type = control_type;
    }

    metadata.properties.insert(
        property_name,
        ControlPropertyValue { value_type, value },
    );

    metadata.clone()
}

/// Set the full control metadata for a cell (replaces existing).
#[tauri::command]
pub fn set_control_metadata(
    state: State<AppState>,
    sheet_index: usize,
    row: u32,
    col: u32,
    metadata: ControlMetadata,
) -> ControlMetadata {
    let mut controls = state.controls.lock().unwrap();
    controls.insert((sheet_index, row, col), metadata.clone());
    metadata
}

/// Remove control metadata for a specific cell.
#[tauri::command]
pub fn remove_control_metadata(
    state: State<AppState>,
    sheet_index: usize,
    row: u32,
    col: u32,
) -> bool {
    let mut controls = state.controls.lock().unwrap();
    controls.remove(&(sheet_index, row, col)).is_some()
}

/// Get all controls for a specific sheet.
#[tauri::command]
pub fn get_all_controls(
    state: State<AppState>,
    sheet_index: usize,
) -> Vec<ControlEntry> {
    let controls = state.controls.lock().unwrap();
    controls
        .iter()
        .filter(|((si, _, _), _)| *si == sheet_index)
        .map(|((si, r, c), meta)| ControlEntry {
            sheet_index: *si,
            row: *r,
            col: *c,
            metadata: meta.clone(),
        })
        .collect()
}

/// Resolve formula-type properties for a control.
/// Returns a map of property name -> resolved string value.
/// Static properties are returned as-is; formula properties are evaluated.
#[tauri::command]
pub fn resolve_control_properties(
    state: State<AppState>,
    sheet_index: usize,
    row: u32,
    col: u32,
) -> HashMap<String, String> {
    let controls = state.controls.lock().unwrap();
    let meta = match controls.get(&(sheet_index, row, col)) {
        Some(m) => m.clone(),
        None => return HashMap::new(),
    };
    // Release the controls lock before acquiring grids
    drop(controls);

    let grids = state.grids.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();

    // Build evaluator once for all formulas
    let evaluator = if sheet_index < grids.len() && sheet_index < sheet_names.len() {
        let current_grid = &grids[sheet_index];
        let current_sheet_name = &sheet_names[sheet_index];
        let context = create_multi_sheet_context(&grids, &sheet_names, current_sheet_name);
        Some(Evaluator::with_multi_sheet(current_grid, context))
    } else {
        None
    };

    let mut resolved = HashMap::new();
    for (key, prop) in &meta.properties {
        if prop.value_type == "formula" && prop.value.starts_with('=') {
            // Evaluate the formula
            let display = if let Some(ref ev) = evaluator {
                match parse_formula(&prop.value) {
                    Ok(parser_ast) => {
                        // Resolve named references (AST splicing)
                        let resolved = if ast_has_named_refs(&parser_ast) {
                            let named_ranges_map = state.named_ranges.lock().unwrap();
                            let mut visited = HashSet::new();
                            let r = resolve_names_in_ast(
                                &parser_ast,
                                &named_ranges_map,
                                sheet_index,
                                &mut visited,
                            );
                            drop(named_ranges_map);
                            r
                        } else {
                            parser_ast
                        };

                        // Resolve structured table references
                        let resolved = if ast_has_table_refs(&resolved) {
                            let tables_map = state.tables.lock().unwrap();
                            let table_names_map = state.table_names.lock().unwrap();
                            let ctx = TableRefContext {
                                tables: &tables_map,
                                table_names: &table_names_map,
                                current_sheet_index: sheet_index,
                                current_row: row,
                            };
                            let r = resolve_table_refs_in_ast(&resolved, &ctx);
                            drop(table_names_map);
                            drop(tables_map);
                            r
                        } else {
                            resolved
                        };

                        let engine_ast = convert_expr(&resolved);
                        let cell_value: CellValue = ev.evaluate(&engine_ast).to_cell_value();
                        format_cell_value_simple(&cell_value)
                    }
                    Err(_) => prop.value.clone(),
                }
            } else {
                prop.value.clone()
            };
            resolved.insert(key.clone(), display);
        } else {
            resolved.insert(key.clone(), prop.value.clone());
        }
    }

    resolved
}
