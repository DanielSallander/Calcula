//! FILENAME: app/src-tauri/src/scripting/object_script_commands.rs
//! PURPOSE: Tauri commands for object script CRUD (scriptable objects).
//! CONTEXT: These commands manage scripts attached to primitive objects (workbook, sheet,
//!          cell, row, column) and component objects (slicer, chart, pivot, etc.).
//!          Object scripts are stored in AppState and persisted in .cala files.

use tauri::State;
use serde::{Deserialize, Serialize};

use crate::document_effect::DocumentEffect;
use crate::persistence::FileState;
use crate::AppState;
use persistence::{SavedObjectScript, ScriptableObjectType, ScriptAccessLevel, ScriptProvenance};

// OBJECT SCRIPTS ARE PERSISTED (`workbook.object_scripts`), so every mutator dirties.
//
// Note the contrast with WORKBOOK scripts (`scripting::commands::save_script`): those
// looked safe in manual testing only because `app/src/api/workbookScripts.ts` calls
// markFileModified() right after -- the single place in the whole frontend that
// compensated for a backend gap. Nothing compensated for object scripts, and any
// non-UI caller (a script, an MCP tool, the scheduler, a .calp install) bypassed the
// frontend anyway. The mark belongs here, in the backend, for both.

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
    /// For distributed scripts: the resolved package version. Read-only over IPC.
    #[serde(default)]
    pub package_version: Option<String>,
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
    /// For distributed scripts: the resolved package version. Read-only over IPC
    /// (preserved from the stored entry on save, exactly like package_name).
    #[serde(default)]
    pub package_version: Option<String>,
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
        ScriptableObjectType::Form => "form".to_string(),
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
        "form" => Ok(ScriptableObjectType::Form),
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
        package_version: s.package_version.clone(),
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
        package_version: s.package_version.clone(),
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
        package_version: None,
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
    let scripts = state.object_scripts.read().map_err(|e| e.to_string())?;
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
    let scripts = state.object_scripts.read().map_err(|e| e.to_string())?;
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
    let scripts = state.object_scripts.read().map_err(|e| e.to_string())?;
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
    file_state: State<FileState>,
    script: ObjectScriptData,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_OBJECT_SCRIPT_EDITOR)?;
    // Past the window guard and `from_data` validation, both of which can still refuse.
    let mut saved = from_data(&script)?;
    let effect = DocumentEffect::mutates(&file_state);
    let mut scripts = state.object_scripts.write(&effect).map_err(|e| e.to_string())?;

    // Update if exists, otherwise push new
    if let Some(existing) = scripts.iter_mut().find(|s| s.id == saved.id) {
        saved.provenance = existing.provenance.clone();
        saved.package_name = existing.package_name.clone();
        saved.package_version = existing.package_version.clone();
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
    file_state: State<FileState>,
    id: String,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_OBJECT_SCRIPT_EDITOR)?;
    // Resolve the not-found refusal under a READ guard first, so it stays clean.
    if !state
        .object_scripts
        .read()
        .map_err(|e| e.to_string())?
        .iter()
        .any(|s| s.id == id)
    {
        return Err(format!("Object script '{}' not found", id));
    }
    let effect = DocumentEffect::mutates(&file_state);
    let mut scripts = state.object_scripts.write(&effect).map_err(|e| e.to_string())?;
    scripts.retain(|s| s.id != id);
    drop(scripts);
    // The script is gone, so its schedule is meaningless. It could not have
    // fired anyway (a deleted script never mounts) nor survived a save (export
    // filters on the workbook's script index), but leaving it in the registry
    // would show the user a live-looking job for code that no longer exists —
    // the transparency panel must not list a ghost.
    crate::scripting::scheduler::remove_script_jobs(&id);
    // Same reasoning, same place: the script's authoring history describes code
    // that no longer exists. Deleting a script deletes its history with it.
    // AFTER `drop(scripts)` above -- std mutexes are not reentrant and this
    // takes its own guard on a different store.
    crate::scripting::authoring_log::forget_script_runs(&state, &effect, &id);
    Ok(())
}

/// Prune every object script attached to a deleted component instance (C10 lifecycle
/// hygiene). Called from the backend delete paths (chart/slicer/pivot/timeline/table/
/// named range) so a deleted object never leaves a dangling, still-persisted script
/// behind. instance_id is an EntityId UUID and therefore globally unique across object
/// types, so matching by id alone is sufficient. Lock-poison is swallowed: cleanup must
/// never turn a successful delete into an error.
///
/// Takes the caller's `DocumentEffect`: pruning removes entries from
/// `workbook.object_scripts`, which is persisted, and every caller is itself a delete
/// that already changes the document. Threading the effect (rather than minting one
/// here) is what forces each of those delete paths -- chart, table, named range, pivot,
/// slicer, timeline -- to have made the dirty-flag decision for its own mutation too.
pub(crate) fn prune_scripts_for_instance(
    state: &AppState,
    effect: &DocumentEffect,
    instance_id: &str,
) {
    let mut removed: Vec<String> = Vec::new();
    if let Ok(mut scripts) = state.object_scripts.write(effect) {
        scripts.retain(|s| {
            let keep = s.instance_id.as_deref() != Some(instance_id);
            if !keep {
                removed.push(s.id.clone());
            }
            keep
        });
    }
    // Same reasoning as delete_object_script: a pruned script's schedule must
    // not outlive it in the registry the transparency panel reads.
    for id in &removed {
        crate::scripting::scheduler::remove_script_jobs(id);
        crate::scripting::authoring_log::forget_script_runs(state, effect, id);
    }
}

/// Delete all object scripts for a specific component instance (when the component is deleted).
#[tauri::command]
pub fn delete_object_scripts_for_instance(
    state: State<AppState>,
    file_state: State<FileState>,
    instance_id: String,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN_AND_OBJECT_SCRIPT_EDITOR)?;
    let effect = DocumentEffect::mutates(&file_state);
    prune_scripts_for_instance(&state, &effect, &instance_id);
    Ok(())
}
