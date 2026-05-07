//! FILENAME: app/src-tauri/src/pivot/layout_commands.rs
//! PURPOSE: Tauri commands for saving/loading/deleting pivot layout configurations.

use crate::AppState;
use persistence::SavedPivotLayout;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePivotLayoutRequest {
    /// If provided, updates existing layout with this ID. Otherwise creates new.
    pub id: Option<u64>,
    pub name: String,
    pub dsl_text: String,
    pub description: Option<String>,
    pub source_type: String,
    pub source_table_name: Option<String>,
    pub source_bi_tables: Vec<String>,
    pub source_bi_measures: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PivotLayoutResponse {
    pub id: u64,
    pub name: String,
    pub dsl_text: String,
    pub description: Option<String>,
    pub source_type: String,
    pub source_table_name: Option<String>,
    pub source_bi_tables: Vec<String>,
    pub source_bi_measures: Vec<String>,
    pub created_at: f64,
    pub updated_at: f64,
}

impl From<&SavedPivotLayout> for PivotLayoutResponse {
    fn from(s: &SavedPivotLayout) -> Self {
        PivotLayoutResponse {
            id: s.id,
            name: s.name.clone(),
            dsl_text: s.dsl_text.clone(),
            description: s.description.clone(),
            source_type: s.source_type.clone(),
            source_table_name: s.source_table_name.clone(),
            source_bi_tables: s.source_bi_tables.clone(),
            source_bi_measures: s.source_bi_measures.clone(),
            created_at: s.created_at,
            updated_at: s.updated_at,
        }
    }
}

/// Save or update a pivot layout configuration.
#[tauri::command]
pub fn save_pivot_layout(
    state: State<'_, AppState>,
    request: SavePivotLayoutRequest,
) -> Result<u64, String> {
    let mut layouts = state.pivot_layouts.lock()
        .map_err(|e| format!("pivot_layouts lock poisoned: {}", e))?;

    let now = js_sys_now();

    if let Some(id) = request.id {
        // Update existing
        if let Some(layout) = layouts.iter_mut().find(|l| l.id == id) {
            layout.name = request.name;
            layout.dsl_text = request.dsl_text;
            layout.description = request.description;
            layout.source_type = request.source_type;
            layout.source_table_name = request.source_table_name;
            layout.source_bi_tables = request.source_bi_tables;
            layout.source_bi_measures = request.source_bi_measures;
            layout.updated_at = now;
            return Ok(id);
        }
        return Err(format!("Layout with id {} not found", id));
    }

    // Create new
    let id = layouts.iter().map(|l| l.id).max().unwrap_or(0) + 1;
    layouts.push(SavedPivotLayout {
        id,
        name: request.name,
        dsl_text: request.dsl_text,
        description: request.description,
        source_type: request.source_type,
        source_table_name: request.source_table_name,
        source_bi_tables: request.source_bi_tables,
        source_bi_measures: request.source_bi_measures,
        created_at: now,
        updated_at: now,
    });

    Ok(id)
}

/// Get all saved pivot layouts.
#[tauri::command]
pub fn get_pivot_layouts(
    state: State<'_, AppState>,
) -> Result<Vec<PivotLayoutResponse>, String> {
    let layouts = state.pivot_layouts.lock()
        .map_err(|e| format!("pivot_layouts lock poisoned: {}", e))?;
    Ok(layouts.iter().map(PivotLayoutResponse::from).collect())
}

/// Delete a pivot layout by ID.
#[tauri::command]
pub fn delete_pivot_layout(
    state: State<'_, AppState>,
    id: u64,
) -> Result<(), String> {
    let mut layouts = state.pivot_layouts.lock()
        .map_err(|e| format!("pivot_layouts lock poisoned: {}", e))?;
    let before = layouts.len();
    layouts.retain(|l| l.id != id);
    if layouts.len() == before {
        return Err(format!("Layout with id {} not found", id));
    }
    Ok(())
}

/// Get current time as f64 milliseconds (like Date.now() in JS).
fn js_sys_now() -> f64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}
