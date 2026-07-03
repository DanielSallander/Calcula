//! FILENAME: app/src-tauri/src/pane_control/commands.rs
//! PURPOSE: Tauri commands for pane control CRUD + value publishing.
//! CONTEXT: Pane controls live in the Controls pane beside ribbon filters.
//!          Creation/rename enforce case-insensitive name uniqueness across
//!          BOTH families (RibbonFilterState is read-only here — the
//!          ribbon_filter module is never modified by this feature), and a
//!          new control's default `order` appends after both families' items.
//!          Undo mirrors ribbon_filter/commands.rs: pre-mutation snapshots
//!          recorded as custom restore kinds "pane_control",
//!          "pane_control_create", "pane_control_delete".

use crate::pane_control::types::*;
use crate::pane_control::values::NamedControlValue;
use crate::persistence::FileState;
use crate::AppState;
use tauri::State;

use crate::log_debug;

/// Case-insensitive lookup key for a control/filter name.
fn name_key(name: &str) -> String {
    name.trim().to_uppercase()
}

/// Check the trimmed, uppercased `candidate` against every pane control
/// (except `exclude`) and every ribbon filter. Returns a human-readable
/// description of the conflicting owner, or None when the name is free.
///
/// Caller must hold the pane-controls lock (passing the map) and must NOT yet
/// hold the ribbon-filters lock — it is taken here, briefly, respecting the
/// canonical lock order (pane controls -> ribbon filters).
fn find_name_conflict(
    candidate_key: &str,
    exclude: Option<identity::EntityId>,
    controls: &std::collections::HashMap<identity::EntityId, PaneControl>,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
) -> Option<String> {
    if let Some(c) = controls
        .values()
        .find(|c| Some(c.id) != exclude && name_key(&c.name) == candidate_key)
    {
        return Some(format!("pane control \"{}\"", c.name));
    }
    let filters = ribbon_filter_state.filters.lock().unwrap();
    if let Some(f) = filters
        .values()
        .find(|f| name_key(&f.name) == candidate_key)
    {
        return Some(format!("ribbon filter \"{}\"", f.name));
    }
    None
}

/// Next free strip position: max over ALL pane-control and ribbon-filter
/// orders, plus one (0 when the strip is empty). The two families share one
/// merged, mixed strip.
fn next_order(
    controls: &std::collections::HashMap<identity::EntityId, PaneControl>,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
) -> u32 {
    let pane_max = controls.values().map(|c| c.order).max();
    let filter_max = {
        let filters = ribbon_filter_state.filters.lock().unwrap();
        filters.values().map(|f| f.order).max()
    };
    match (pane_max, filter_max) {
        (Some(a), Some(b)) => a.max(b) + 1,
        (Some(a), None) => a + 1,
        (None, Some(b)) => b + 1,
        (None, None) => 0,
    }
}

// ============================================================================
// CRUD COMMANDS
// ============================================================================

/// Create a new pane control. Validates case-insensitive name uniqueness
/// against BOTH pane controls and ribbon filters.
#[tauri::command]
pub fn create_pane_control(
    state: State<AppState>,
    file_state: State<FileState>,
    pane_control_state: State<PaneControlState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
    params: CreatePaneControlParams,
) -> Result<PaneControl, String> {
    let name = params.name.trim().to_string();
    if name.is_empty() {
        return Err("Control name must not be empty".to_string());
    }

    let id = identity::EntityId::from_bytes(identity::generate_uuid_v7());

    let control = {
        // Canonical lock order: pane controls BEFORE ribbon filters (the
        // helper fns take the filters lock briefly under ours).
        let mut controls = pane_control_state.controls.lock().unwrap();

        let key = name_key(&name);
        if let Some(owner) = find_name_conflict(&key, None, &controls, &ribbon_filter_state) {
            return Err(format!(
                "A control named \"{}\" already exists ({}) — control names are unique across the Controls pane",
                name, owner
            ));
        }

        let order = params
            .order
            .unwrap_or_else(|| next_order(&controls, &ribbon_filter_state));

        let control = PaneControl {
            id,
            name,
            control_type: params.control_type,
            config: params.config,
            value: params.value,
            order,
        };
        controls.insert(id, control.clone());
        control
    };

    log_debug!(
        "PANE_CONTROL",
        "create_pane_control id={} name={} type={:?} order={}",
        id,
        control.name,
        control.control_type,
        control.order
    );

    // Record undo for pane control creation (undo = delete)
    {
        #[derive(serde::Serialize)]
        struct PaneControlCreateSnapshot { control_id: identity::EntityId }
        let data = serde_json::to_vec(&PaneControlCreateSnapshot { control_id: id }).unwrap_or_default();
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.begin_transaction("Create pane control");
        undo_stack.record_custom_restore("pane_control_create".to_string(), data, "Create pane control");
        undo_stack.commit_transaction();
    }

    // Pane controls are persisted workbook entities — mark the file dirty.
    if let Ok(mut modified) = file_state.is_modified.lock() { *modified = true; }

    Ok(control)
}

/// Delete a pane control.
#[tauri::command]
pub fn delete_pane_control(
    state: State<AppState>,
    file_state: State<FileState>,
    pane_control_state: State<PaneControlState>,
    control_id: identity::EntityId,
) -> Result<(), String> {
    log_debug!("PANE_CONTROL", "delete_pane_control id={}", control_id);

    let removed = pane_control_state
        .controls
        .lock()
        .unwrap()
        .remove(&control_id)
        .ok_or_else(|| format!("Pane control {} not found", control_id))?;

    // Record undo for pane control deletion (undo = recreate)
    {
        #[derive(serde::Serialize)]
        struct PaneControlSnapshot {
            control_id: identity::EntityId,
            previous: PaneControl,
        }
        let data = serde_json::to_vec(&PaneControlSnapshot { control_id, previous: removed }).unwrap_or_default();
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.begin_transaction("Delete pane control");
        undo_stack.record_custom_restore("pane_control_delete".to_string(), data, "Delete pane control");
        undo_stack.commit_transaction();
    }

    // Pane controls are persisted workbook entities — mark the file dirty.
    if let Ok(mut modified) = file_state.is_modified.lock() { *modified = true; }

    Ok(())
}

/// Update pane control properties (name/config/order). Renames re-validate
/// case-insensitive name uniqueness against both pane controls and filters.
#[tauri::command]
pub fn update_pane_control(
    state: State<AppState>,
    file_state: State<FileState>,
    pane_control_state: State<PaneControlState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
    control_id: identity::EntityId,
    params: UpdatePaneControlParams,
) -> Result<PaneControl, String> {
    log_debug!("PANE_CONTROL", "update_pane_control id={}", control_id);

    let mut controls = pane_control_state.controls.lock().unwrap();
    let previous = controls
        .get(&control_id)
        .cloned()
        .ok_or_else(|| format!("Pane control {} not found", control_id))?;

    // Validate a rename BEFORE recording undo / mutating (a rejected rename
    // must leave no undo entry and no partial change).
    let new_name = match &params.name {
        Some(raw) => {
            let trimmed = raw.trim().to_string();
            if trimmed.is_empty() {
                return Err("Control name must not be empty".to_string());
            }
            let key = name_key(&trimmed);
            // Same name (case-insensitively) = case-only rename; always allowed.
            if key != name_key(&previous.name) {
                if let Some(owner) =
                    find_name_conflict(&key, Some(control_id), &controls, &ribbon_filter_state)
                {
                    return Err(format!(
                        "A control named \"{}\" already exists ({}) — control names are unique across the Controls pane",
                        trimmed, owner
                    ));
                }
            }
            Some(trimmed)
        }
        None => None,
    };

    // Record undo snapshot before property changes
    {
        #[derive(serde::Serialize)]
        struct PaneControlSnapshot {
            control_id: identity::EntityId,
            previous: PaneControl,
        }
        let data = serde_json::to_vec(&PaneControlSnapshot { control_id, previous: previous.clone() }).unwrap_or_default();
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.begin_transaction("Update pane control");
        undo_stack.record_custom_restore("pane_control".to_string(), data, "Update pane control");
        undo_stack.commit_transaction();
    }

    let control = controls
        .get_mut(&control_id)
        .expect("presence checked above while holding the lock");
    if let Some(name) = new_name {
        control.name = name;
    }
    if let Some(config) = params.config {
        control.config = config;
    }
    if let Some(order) = params.order {
        control.order = order;
    }

    // Pane controls are persisted workbook entities — mark the file dirty.
    if let Ok(mut modified) = file_state.is_modified.lock() { *modified = true; }

    Ok(control.clone())
}

/// Publish a pane control's current value (what GET.CONTROLVALUE returns).
/// Slider drags are frontend-transient: this is called ONCE on pointer-up,
/// producing exactly one undo entry per committed drag.
#[tauri::command]
pub fn set_pane_control_value(
    state: State<AppState>,
    file_state: State<FileState>,
    pane_control_state: State<PaneControlState>,
    control_id: identity::EntityId,
    value: engine::ControlValue,
) -> Result<(), String> {
    log_debug!(
        "PANE_CONTROL",
        "set_pane_control_value id={} value={:?}",
        control_id,
        value
    );

    let mut controls = pane_control_state.controls.lock().unwrap();
    let control = controls
        .get_mut(&control_id)
        .ok_or_else(|| format!("Pane control {} not found", control_id))?;

    // Record undo snapshot before the value change
    {
        #[derive(serde::Serialize)]
        struct PaneControlSnapshot {
            control_id: identity::EntityId,
            previous: PaneControl,
        }
        let data = serde_json::to_vec(&PaneControlSnapshot { control_id, previous: control.clone() }).unwrap_or_default();
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.begin_transaction("Pane control change");
        undo_stack.record_custom_restore("pane_control".to_string(), data, "Pane control change");
        undo_stack.commit_transaction();
    }

    control.value = Some(value);

    // The published value is persisted with the workbook — mark the file
    // dirty so a committed slider drag survives close-without-save prompts.
    if let Ok(mut modified) = file_state.is_modified.lock() { *modified = true; }

    Ok(())
}

// ============================================================================
// QUERY COMMANDS
// ============================================================================

/// Get all pane controls.
#[tauri::command]
pub fn get_all_pane_controls(
    pane_control_state: State<PaneControlState>,
) -> Vec<PaneControl> {
    pane_control_state
        .controls
        .lock()
        .unwrap()
        .values()
        .cloned()
        .collect()
}

/// Get a single pane control by ID.
#[tauri::command]
pub fn get_pane_control(
    pane_control_state: State<PaneControlState>,
    control_id: identity::EntityId,
) -> Result<PaneControl, String> {
    pane_control_state
        .controls
        .lock()
        .unwrap()
        .get(&control_id)
        .cloned()
        .ok_or_else(|| format!("Pane control {} not found", control_id))
}

/// Enumerate every named control the GET.CONTROLVALUE snapshot draws from —
/// pane controls, ribbon filters (selection mapped to its formula value) and
/// named on-grid controls — in precedence order (pane > filter > on-grid),
/// with source attribution. Value-less controls (e.g. buttons) are included
/// with `value: null`; shadowed duplicates are NOT collapsed here (the
/// frontend facade decides how to present collisions).
#[tauri::command]
pub fn get_all_control_values(
    state: State<AppState>,
    pane_control_state: State<PaneControlState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
) -> Vec<NamedControlValue> {
    // Lock order: each store is locked briefly and dropped before the next;
    // grid locks are taken LAST, never while a controls/filters lock is held.
    let mut result = {
        let controls = pane_control_state.controls.lock().unwrap();
        crate::pane_control::values::pane_control_named_values(&controls)
    };
    {
        let filters = ribbon_filter_state.filters.lock().unwrap();
        result.extend(crate::pane_control::values::ribbon_filter_named_values(&filters));
    }
    {
        let on_grid = {
            let controls = state.controls.lock().unwrap();
            controls.clone()
        };
        let grids = state.grids.lock().unwrap();
        result.extend(crate::pane_control::values::on_grid_named_values(&on_grid, &grids));
    }
    result
}
