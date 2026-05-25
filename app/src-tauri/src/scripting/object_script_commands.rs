//! FILENAME: app/src-tauri/src/scripting/object_script_commands.rs
//! PURPOSE: Tauri commands for object script CRUD (scriptable objects).
//! CONTEXT: These commands manage scripts attached to primitive objects (workbook, sheet,
//!          cell, row, column) and component objects (slicer, chart, pivot, etc.).
//!          Object scripts are stored in AppState and persisted in .cala files.

use tauri::State;
use serde::{Deserialize, Serialize};

use crate::AppState;
use persistence::{SavedObjectScript, ScriptableObjectType, ScriptAccessLevel};

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

fn to_summary(s: &SavedObjectScript) -> ObjectScriptSummary {
    ObjectScriptSummary {
        id: s.id.clone(),
        name: s.name.clone(),
        object_type: object_type_to_string(&s.object_type),
        instance_id: s.instance_id.clone(),
        access_level: access_level_to_string(&s.access_level),
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
    })
}

// ============================================================================
// CRUD Commands
// ============================================================================

/// List all object scripts (lightweight summaries).
#[tauri::command]
pub fn list_object_scripts(
    state: State<AppState>,
) -> Result<Vec<ObjectScriptSummary>, String> {
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
) -> Result<ObjectScriptData, String> {
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
) -> Result<Option<ObjectScriptData>, String> {
    let obj_type = string_to_object_type(&object_type)?;
    let scripts = state.object_scripts.lock().map_err(|e| e.to_string())?;
    let found = scripts.iter().find(|s| {
        s.object_type == obj_type && s.instance_id == instance_id
    });
    Ok(found.map(to_data))
}

/// Save (create or update) an object script.
#[tauri::command]
pub fn save_object_script(
    state: State<AppState>,
    script: ObjectScriptData,
) -> Result<(), String> {
    let saved = from_data(&script)?;
    let mut scripts = state.object_scripts.lock().map_err(|e| e.to_string())?;

    // Update if exists, otherwise push new
    if let Some(existing) = scripts.iter_mut().find(|s| s.id == saved.id) {
        *existing = saved;
    } else {
        scripts.push(saved);
    }
    Ok(())
}

/// Delete an object script by ID.
#[tauri::command]
pub fn delete_object_script(
    state: State<AppState>,
    id: String,
) -> Result<(), String> {
    let mut scripts = state.object_scripts.lock().map_err(|e| e.to_string())?;
    let len_before = scripts.len();
    scripts.retain(|s| s.id != id);
    if scripts.len() == len_before {
        return Err(format!("Object script '{}' not found", id));
    }
    Ok(())
}

/// Delete all object scripts for a specific component instance (when the component is deleted).
#[tauri::command]
pub fn delete_object_scripts_for_instance(
    state: State<AppState>,
    instance_id: String,
) -> Result<(), String> {
    let mut scripts = state.object_scripts.lock().map_err(|e| e.to_string())?;
    scripts.retain(|s| s.instance_id.as_deref() != Some(&instance_id));
    Ok(())
}
