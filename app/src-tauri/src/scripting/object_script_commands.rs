//! FILENAME: app/src-tauri/src/scripting/object_script_commands.rs
//! PURPOSE: Tauri commands for object script CRUD (scriptable objects).
//! CONTEXT: These commands manage scripts attached to primitive objects (workbook, sheet,
//!          cell, row, column) and component objects (slicer, chart, pivot, etc.).
//!          Object scripts are stored in AppState and persisted in .cala files.

use tauri::State;
use serde::{Deserialize, Serialize};

use crate::AppState;
use persistence::{SavedObjectScript, ScriptableObjectType, ScriptAccessLevel, ScriptProvenance};

// ============================================================================
// API Types (serialized to/from frontend)
// ============================================================================

/// Lightweight summary for listing object scripts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectScriptSummary {
    pub id: String,
    pub name: String,
    pub object_type: String,
    pub instance_id: Option<String>,
    pub access_level: String,
    #[serde(default)]
    pub provenance: Option<String>,
    #[serde(default)]
    pub package_name: Option<String>,
    /// The R19 declared-capability ceiling (authoritative). Read-only over IPC.
    #[serde(default)]
    pub declared_capabilities: Vec<String>,
}

/// Full object script definition for the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectScriptData {
    pub id: String,
    pub name: String,
    pub object_type: String,
    pub instance_id: Option<String>,
    pub source: String,
    pub access_level: String,
    pub description: Option<String>,
    /// "local" | "distributed". Read-only over IPC: save_object_script
    /// preserves the stored provenance regardless of what the frontend sends.
    #[serde(default)]
    pub provenance: Option<String>,
    #[serde(default)]
    pub package_name: Option<String>,
    /// The R19 declared-capability ceiling (authoritative). Read-only over IPC:
    /// save_object_script derives it from the source pragmas (local) or
    /// preserves the manifest-set ceiling (distributed).
    #[serde(default)]
    pub declared_capabilities: Vec<String>,
}

// ============================================================================
// Conversion helpers
// ============================================================================

fn object_type_to_string(t: &ScriptableObjectType) -> String {
    match t {
        ScriptableObjectType::Workbook => "workbook".to_string(),
        ScriptableObjectType::Sheet => "sheet".to_string(),
        ScriptableObjectType::Cell => "cell".to_string(),
        ScriptableObjectType::Row => "row".to_string(),
        ScriptableObjectType::Column => "column".to_string(),
        ScriptableObjectType::Slicer => "slicer".to_string(),
        ScriptableObjectType::Chart => "chart".to_string(),
        ScriptableObjectType::Pivot => "pivot".to_string(),
        ScriptableObjectType::Button => "button".to_string(),
        ScriptableObjectType::Textbox => "textbox".to_string(),
        ScriptableObjectType::Timeline => "timeline".to_string(),
        ScriptableObjectType::Shape => "shape".to_string(),
        ScriptableObjectType::Table => "table".to_string(),
        ScriptableObjectType::NamedRange => "namedRange".to_string(),
        ScriptableObjectType::Panel => "panel".to_string(),
        ScriptableObjectType::Range => "range".to_string(),
    }
}

fn string_to_object_type(s: &str) -> Result<ScriptableObjectType, String> {
    match s {
        "workbook" => Ok(ScriptableObjectType::Workbook),
        "sheet" => Ok(ScriptableObjectType::Sheet),
        "cell" => Ok(ScriptableObjectType::Cell),
        "row" => Ok(ScriptableObjectType::Row),
        "column" => Ok(ScriptableObjectType::Column),
        "slicer" => Ok(ScriptableObjectType::Slicer),
        "chart" => Ok(ScriptableObjectType::Chart),
        "pivot" => Ok(ScriptableObjectType::Pivot),
        "button" => Ok(ScriptableObjectType::Button),
        "textbox" => Ok(ScriptableObjectType::Textbox),
        "timeline" => Ok(ScriptableObjectType::Timeline),
        "shape" => Ok(ScriptableObjectType::Shape),
        "table" => Ok(ScriptableObjectType::Table),
        "namedRange" => Ok(ScriptableObjectType::NamedRange),
        "panel" => Ok(ScriptableObjectType::Panel),
        "range" => Ok(ScriptableObjectType::Range),
        _ => Err(format!("Invalid object type: {}", s)),
    }
}

fn access_level_to_string(l: &ScriptAccessLevel) -> String {
    match l {
        ScriptAccessLevel::Restricted => "restricted".to_string(),
        ScriptAccessLevel::Unlocked => "unlocked".to_string(),
    }
}

fn string_to_access_level(s: &str) -> Result<ScriptAccessLevel, String> {
    match s {
        "restricted" => Ok(ScriptAccessLevel::Restricted),
        "unlocked" => Ok(ScriptAccessLevel::Unlocked),
        _ => Err(format!("Invalid access level: {}. Must be 'restricted' or 'unlocked'", s)),
    }
}

fn provenance_to_string(p: &ScriptProvenance) -> String {
    match p {
        ScriptProvenance::Local => "local".to_string(),
        ScriptProvenance::Distributed => "distributed".to_string(),
    }
}

fn to_summary(s: &SavedObjectScript) -> ObjectScriptSummary {
    ObjectScriptSummary {
        id: s.id.clone(),
        name: s.name.clone(),
        object_type: object_type_to_string(&s.object_type),
        instance_id: s.instance_id.clone(),
        access_level: access_level_to_string(&s.access_level),
        provenance: Some(provenance_to_string(&s.provenance)),
        package_name: s.package_name.clone(),
        declared_capabilities: s.declared_capabilities.clone(),
    }
}

fn to_data(s: &SavedObjectScript) -> ObjectScriptData {
    ObjectScriptData {
        id: s.id.clone(),
        name: s.name.clone(),
        object_type: object_type_to_string(&s.object_type),
        instance_id: s.instance_id.clone(),
        source: s.source.clone(),
        access_level: access_level_to_string(&s.access_level),
        description: s.description.clone(),
        provenance: Some(provenance_to_string(&s.provenance)),
        package_name: s.package_name.clone(),
        declared_capabilities: s.declared_capabilities.clone(),
    }
}

fn from_data(d: &ObjectScriptData) -> Result<SavedObjectScript, String> {
    Ok(SavedObjectScript {
        id: d.id.clone(),
        name: d.name.clone(),
        object_type: string_to_object_type(&d.object_type)?,
        instance_id: d.instance_id.clone(),
        source: d.source.clone(),
        access_level: string_to_access_level(&d.access_level)?,
        description: d.description.clone(),
        // Provenance is server-authoritative: never taken from the payload.
        // save_object_script copies it from the stored entry (or Local for
        // new scripts) so a frontend save cannot launder a distributed
        // script into a local one.
        provenance: ScriptProvenance::Local,
        package_name: None,
        // The ceiling is derived server-side in save_object_script (from the
        // source for local scripts) or preserved from the stored distributed
        // entry — never taken from the payload.
        declared_capabilities: Vec::new(),
    })
}

// ============================================================================
// CRUD Commands
// ============================================================================

/// List all object scripts (lightweight summaries).
#[tauri::command]
pub fn list_object_scripts(
    state: State<AppState>,
    window: tauri::Window,
) -> Result<Vec<ObjectScriptSummary>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_OBJECT_SCRIPT_EDITOR)?;
    let scripts = state.object_scripts.lock().map_err(|e| e.to_string())?;
    let mut summaries: Vec<ObjectScriptSummary> = scripts.iter().map(to_summary).collect();
    summaries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(summaries)
}

/// Get a single object script by ID (includes source code).
#[tauri::command]
pub fn get_object_script(
    state: State<AppState>,
    id: String,
    window: tauri::Window,
) -> Result<ObjectScriptData, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_OBJECT_SCRIPT_EDITOR)?;
    let scripts = state.object_scripts.lock().map_err(|e| e.to_string())?;
    scripts
        .iter()
        .find(|s| s.id == id)
        .map(to_data)
        .ok_or_else(|| format!("Object script '{}' not found", id))
}

/// Get the object script for a specific object type and optional instance ID.
#[tauri::command]
pub fn get_object_script_by_target(
    state: State<AppState>,
    object_type: String,
    instance_id: Option<String>,
    window: tauri::Window,
) -> Result<Option<ObjectScriptData>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_OBJECT_SCRIPT_EDITOR)?;
    let obj_type = string_to_object_type(&object_type)?;
    let scripts = state.object_scripts.lock().map_err(|e| e.to_string())?;
    let found = scripts.iter().find(|s| {
        s.object_type == obj_type && s.instance_id == instance_id
    });
    Ok(found.map(to_data))
}

/// Save (create or update) an object script.
/// Provenance is preserved from the stored entry — a frontend save can never
/// flip a distributed script back to local. Distributed scripts also cannot
/// be escalated to unlocked through this command.
#[tauri::command]
pub fn save_object_script(
    state: State<AppState>,
    script: ObjectScriptData,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_OBJECT_SCRIPT_EDITOR)?;
    let mut saved = from_data(&script)?;
    let mut scripts = state.object_scripts.lock().map_err(|e| e.to_string())?;

    // Update if exists, otherwise push new
    if let Some(existing) = scripts.iter_mut().find(|s| s.id == saved.id) {
        saved.provenance = existing.provenance.clone();
        saved.package_name = existing.package_name.clone();
        if saved.provenance == ScriptProvenance::Distributed
            && saved.access_level == ScriptAccessLevel::Unlocked
            && existing.access_level != ScriptAccessLevel::Unlocked
        {
            return Err(
                "Distributed scripts cannot be escalated to unlocked access. \
                 Copy the script to a local one to take ownership of it."
                    .to_string(),
            );
        }
        // R19 ceiling. For a LOCAL script the source is authoritative, so
        // re-derive the declared capabilities from the updated source. For a
        // DISTRIBUTED script the ceiling is the package manifest's declaration
        // (set at pull time) and must NEVER be widened by an edited source, so
        // we preserve the stored ceiling instead.
        if saved.provenance == ScriptProvenance::Distributed {
            saved.declared_capabilities = existing.declared_capabilities.clone();
        } else {
            saved.declared_capabilities =
                persistence::parse_declared_capabilities(&saved.source);
        }
        *existing = saved;
    } else {
        // New scripts are always local-authored (pull materializes
        // distributed scripts directly into state, not through this command).
        // The source is authoritative for a local script's ceiling.
        saved.declared_capabilities = persistence::parse_declared_capabilities(&saved.source);
        scripts.push(saved);
    }
    Ok(())
}

/// Delete an object script by ID.
#[tauri::command]
pub fn delete_object_script(
    state: State<AppState>,
    id: String,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_OBJECT_SCRIPT_EDITOR)?;
    let mut scripts = state.object_scripts.lock().map_err(|e| e.to_string())?;
    let len_before = scripts.len();
    scripts.retain(|s| s.id != id);
    if scripts.len() == len_before {
        return Err(format!("Object script '{}' not found", id));
    }
    Ok(())
}

/// Prune every object script attached to a deleted component instance (C10 lifecycle
/// hygiene). Called from the backend delete paths (chart/slicer/pivot/timeline/table/
/// named range) so a deleted object never leaves a dangling, still-persisted script
/// behind. instance_id is an EntityId UUID and therefore globally unique across object
/// types, so matching by id alone is sufficient. Lock-poison is swallowed: cleanup must
/// never turn a successful delete into an error.
pub(crate) fn prune_scripts_for_instance(state: &AppState, instance_id: &str) {
    if let Ok(mut scripts) = state.object_scripts.lock() {
        scripts.retain(|s| s.instance_id.as_deref() != Some(instance_id));
    }
}

/// Delete all object scripts for a specific component instance (when the component is deleted).
#[tauri::command]
pub fn delete_object_scripts_for_instance(
    state: State<AppState>,
    instance_id: String,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_OBJECT_SCRIPT_EDITOR)?;
    prune_scripts_for_instance(&state, &instance_id);
    Ok(())
}
