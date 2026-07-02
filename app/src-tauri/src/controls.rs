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
// Persistence (opaque per-sheet payload, keyed by SheetId)
// ============================================================================

/// One persisted control inside a sheet's opaque `SavedSheetControls` payload.
/// In-sheet coordinates only; the sheet association rides on the carrier's
/// SheetId (like conditional formats / data validations).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedControlEntry {
    pub row: u32,
    pub col: u32,
    pub control_type: String,
    pub properties: HashMap<String, ControlPropertyValue>,
}

/// Collect the live control store into per-sheet opaque payloads for the
/// persistence carrier. Sheets without controls produce no entry.
pub fn collect_controls_for_save(
    controls: &ControlStorage,
    sheet_ids: &[identity::SheetId],
) -> Vec<persistence::SavedSheetControls> {
    let mut per_sheet: HashMap<usize, Vec<SavedControlEntry>> = HashMap::new();
    for ((sheet_index, row, col), meta) in controls.iter() {
        per_sheet
            .entry(*sheet_index)
            .or_default()
            .push(SavedControlEntry {
                row: *row,
                col: *col,
                control_type: meta.control_type.clone(),
                properties: meta.properties.clone(),
            });
    }
    let mut saved = Vec::new();
    for (sheet_index, mut entries) in per_sheet {
        let Some(&sheet_id) = sheet_ids.get(sheet_index) else {
            continue;
        };
        // Deterministic artifact bytes across saves (HashMap iteration order
        // would otherwise churn checksums/diffs for identical content).
        entries.sort_by_key(|e| (e.row, e.col));
        if let Ok(value) = serde_json::to_value(&entries) {
            saved.push(persistence::SavedSheetControls {
                sheet_id,
                controls: value,
            });
        }
    }
    // Same determinism for the carrier ordering.
    saved.sort_by_key(|s| s.sheet_id);
    saved
}

/// Strip executable wiring from DISTRIBUTED control payloads before
/// materialization. A control's `onSelect` value is INLINE SCRIPT SOURCE the
/// Controls extension hands to the workbook-script runner — carrying it live
/// from a package would execute publisher code under the subscriber's global
/// script-security gate, bypassing the per-package, hash-keyed consent model
/// that governs every other distributed script. Packaged buttons therefore
/// arrive visually intact but DISARMED; publisher-shipped interactivity flows
/// through consent-gated object scripts instead. (.cala load of the user's own
/// workbook is NOT sanitized — local wiring is the user's own code.)
pub fn sanitize_distributed_controls(
    saved: &[persistence::SavedSheetControls],
) -> Vec<persistence::SavedSheetControls> {
    saved
        .iter()
        .map(|sheet_controls| {
            let mut cloned = sheet_controls.clone();
            if let serde_json::Value::Array(entries) = &mut cloned.controls {
                for entry in entries {
                    if let Some(props) = entry
                        .get_mut("properties")
                        .and_then(|p| p.as_object_mut())
                    {
                        props.remove("onSelect");
                    }
                }
            }
            cloned
        })
        .collect()
}

/// Materialize persisted per-sheet control payloads into ControlStorage
/// entries at the sheet indices resolved by `sheet_index_of`. Entries whose
/// sheet cannot be resolved are skipped. Returns the number of controls added.
pub fn materialize_saved_controls(
    saved: &[persistence::SavedSheetControls],
    controls: &mut ControlStorage,
    mut sheet_index_of: impl FnMut(identity::SheetId) -> Option<usize>,
) -> usize {
    let mut added = 0;
    for sheet_controls in saved {
        let Some(idx) = sheet_index_of(sheet_controls.sheet_id) else {
            continue;
        };
        let Ok(entries) =
            serde_json::from_value::<Vec<SavedControlEntry>>(sheet_controls.controls.clone())
        else {
            continue;
        };
        for entry in entries {
            controls.insert(
                (idx, entry.row, entry.col),
                ControlMetadata {
                    control_type: entry.control_type,
                    properties: entry.properties,
                },
            );
            added += 1;
        }
    }
    added
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

#[cfg(test)]
mod persistence_tests {
    use super::*;

    fn sample_storage() -> ControlStorage {
        let mut controls: ControlStorage = HashMap::new();
        let mut props = HashMap::new();
        props.insert(
            "text".to_string(),
            ControlPropertyValue { value_type: "static".to_string(), value: "Run".to_string() },
        );
        props.insert(
            "onSelect".to_string(),
            ControlPropertyValue {
                value_type: "static".to_string(),
                value: "MyScript();".to_string(),
            },
        );
        controls.insert(
            (0, 2, 3),
            ControlMetadata { control_type: "button".to_string(), properties: props },
        );
        controls
    }

    #[test]
    fn collect_and_materialize_round_trip() {
        let controls = sample_storage();
        let sheet_ids = vec![identity::SheetId::from_bytes(identity::generate_uuid_v7())];
        let saved = collect_controls_for_save(&controls, &sheet_ids);
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].sheet_id, sheet_ids[0]);

        let mut restored: ControlStorage = HashMap::new();
        let added = materialize_saved_controls(&saved, &mut restored, |sid| {
            if sid == sheet_ids[0] { Some(5) } else { None }
        });
        assert_eq!(added, 1);
        let meta = restored.get(&(5, 2, 3)).expect("control restored at remapped sheet");
        assert_eq!(meta.control_type, "button");
        assert_eq!(meta.properties.get("onSelect").map(|p| p.value.as_str()), Some("MyScript();"));
    }

    #[test]
    fn sanitize_strips_onselect_but_keeps_presentation() {
        // Distributed onSelect is inline script source — it must never
        // materialize from a package (consent-model bypass); the button's
        // visual properties survive.
        let controls = sample_storage();
        let sheet_ids = vec![identity::SheetId::from_bytes(identity::generate_uuid_v7())];
        let saved = collect_controls_for_save(&controls, &sheet_ids);
        let sanitized = sanitize_distributed_controls(&saved);

        let mut restored: ControlStorage = HashMap::new();
        materialize_saved_controls(&sanitized, &mut restored, |_| Some(0));
        let meta = restored.get(&(0, 2, 3)).expect("control materialized");
        assert!(meta.properties.get("onSelect").is_none(), "onSelect must be stripped");
        assert_eq!(meta.properties.get("text").map(|p| p.value.as_str()), Some("Run"));
    }
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
