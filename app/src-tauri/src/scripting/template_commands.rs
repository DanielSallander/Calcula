//! FILENAME: app/src-tauri/src/scripting/template_commands.rs
//! PURPOSE: Tauri commands for object script template CRUD.
//! CONTEXT: Templates are stored as individual JSON files in the user's
//!          %APPDATA%/Calcula/templates/ directory for cross-workbook reuse.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

// ============================================================================
// Types
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectTemplate {
    pub id: String,
    pub name: String,
    pub object_type: String,
    pub script_source: String,
    pub access_level: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

// ============================================================================
// Helpers
// ============================================================================

fn templates_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;
    let dir = base.join("templates");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create templates dir: {}", e))?;
    }
    Ok(dir)
}

fn template_path(dir: &PathBuf, id: &str) -> PathBuf {
    dir.join(format!("{}.json", id))
}

// ============================================================================
// Commands
// ============================================================================

/// List all saved object templates.
#[tauri::command]
pub fn list_object_templates(
    app: tauri::AppHandle,
) -> Result<Vec<ObjectTemplate>, String> {
    let dir = templates_dir(&app)?;
    let mut templates = Vec::new();

    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map_or(false, |e| e == "json") {
                if let Ok(contents) = fs::read_to_string(&path) {
                    if let Ok(template) = serde_json::from_str::<ObjectTemplate>(&contents) {
                        templates.push(template);
                    }
                }
            }
        }
    }

    templates.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(templates)
}

/// Save an object template.
#[tauri::command]
pub fn save_object_template(
    app: tauri::AppHandle,
    template: ObjectTemplate,
) -> Result<(), String> {
    let dir = templates_dir(&app)?;
    let path = template_path(&dir, &template.id);
    let json = serde_json::to_string_pretty(&template)
        .map_err(|e| format!("Failed to serialize template: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write template: {}", e))?;
    Ok(())
}

/// Load a single object template by ID.
#[tauri::command]
pub fn load_object_template(
    app: tauri::AppHandle,
    id: String,
) -> Result<ObjectTemplate, String> {
    let dir = templates_dir(&app)?;
    let path = template_path(&dir, &id);
    let contents =
        fs::read_to_string(&path).map_err(|e| format!("Template '{}' not found: {}", id, e))?;
    serde_json::from_str::<ObjectTemplate>(&contents)
        .map_err(|e| format!("Failed to parse template: {}", e))
}

/// Delete an object template by ID.
#[tauri::command]
pub fn delete_object_template(
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    let dir = templates_dir(&app)?;
    let path = template_path(&dir, &id);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Failed to delete template: {}", e))?;
    }
    Ok(())
}
