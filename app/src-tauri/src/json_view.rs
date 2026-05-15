//! FILENAME: app/src-tauri/src/json_view.rs
//! PURPOSE: Tauri commands for the JSON View extension.
//! CONTEXT: Provides generic get/set/list commands for inspecting and editing
//!          any workbook object as JSON. Used by the JsonView extension.

use crate::api_types;
use crate::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

// ============================================================================
// Types
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectEntry {
    pub object_type: String,
    pub object_id: String,
    pub label: String,
}

// ============================================================================
// get_object_json — Serialize any workbook object to pretty JSON
// ============================================================================

#[tauri::command]
pub fn get_object_json(
    state: State<AppState>,
    slicer_state: State<crate::slicer::SlicerState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
    script_state: State<crate::scripting::ScriptState>,
    timeline_slicer_state: State<crate::timeline_slicer::TimelineSlicerState>,
    object_type: String,
    object_id: String,
) -> Result<String, String> {
    match object_type.as_str() {
        "chart" => {
            let id: u32 = object_id.parse().map_err(|_| "Invalid chart id".to_string())?;
            let charts = state.charts.lock().unwrap();
            let entry = charts.iter().find(|c| c.id == id)
                .ok_or_else(|| format!("Chart {} not found", id))?;
            serde_json::to_string_pretty(entry).map_err(|e| e.to_string())
        }
        "table" => {
            let id: u64 = object_id.parse().map_err(|_| "Invalid table id".to_string())?;
            let tables = state.tables.lock().unwrap();
            for sheet_tables in tables.values() {
                if let Some(table) = sheet_tables.get(&id) {
                    return serde_json::to_string_pretty(table).map_err(|e| e.to_string());
                }
            }
            Err(format!("Table {} not found", id))
        }
        "slicer" => {
            let id: u64 = object_id.parse().map_err(|_| "Invalid slicer id".to_string())?;
            let slicers = slicer_state.slicers.lock().unwrap();
            let slicer = slicers.get(&id)
                .ok_or_else(|| format!("Slicer {} not found", id))?;
            serde_json::to_string_pretty(slicer).map_err(|e| e.to_string())
        }
        "ribbon_filter" => {
            let id: u64 = object_id.parse().map_err(|_| "Invalid ribbon filter id".to_string())?;
            let filters = ribbon_filter_state.filters.lock().unwrap();
            let filter = filters.get(&id)
                .ok_or_else(|| format!("Ribbon filter {} not found", id))?;
            serde_json::to_string_pretty(filter).map_err(|e| e.to_string())
        }
        "timeline_slicer" => {
            let id: u64 = object_id.parse().map_err(|_| "Invalid timeline slicer id".to_string())?;
            let timelines = timeline_slicer_state.timelines.lock().unwrap();
            let timeline = timelines.get(&id)
                .ok_or_else(|| format!("Timeline slicer {} not found", id))?;
            serde_json::to_string_pretty(timeline).map_err(|e| e.to_string())
        }
        "sparkline" => {
            let idx: usize = object_id.parse().map_err(|_| "Invalid sparkline index".to_string())?;
            let sparklines = state.sparklines.lock().unwrap();
            let entry = sparklines.get(idx)
                .ok_or_else(|| format!("Sparkline entry {} not found", idx))?;
            serde_json::to_string_pretty(entry).map_err(|e| e.to_string())
        }
        "script" => {
            let scripts = script_state.workbook_scripts.lock().unwrap();
            let script = scripts.get(&object_id)
                .ok_or_else(|| format!("Script '{}' not found", object_id))?;
            serde_json::to_string_pretty(script).map_err(|e| e.to_string())
        }
        "notebook" => {
            let notebooks = script_state.workbook_notebooks.lock().unwrap();
            let notebook = notebooks.get(&object_id)
                .ok_or_else(|| format!("Notebook '{}' not found", object_id))?;
            serde_json::to_string_pretty(notebook).map_err(|e| e.to_string())
        }
        "pivot_layout" => {
            let id: u64 = object_id.parse().map_err(|_| "Invalid pivot layout id".to_string())?;
            let layouts = state.pivot_layouts.lock().unwrap();
            let layout = layouts.iter().find(|l| l.id == id)
                .ok_or_else(|| format!("Pivot layout {} not found", id))?;
            serde_json::to_string_pretty(layout).map_err(|e| e.to_string())
        }
        "theme" => {
            let theme = state.theme.lock().unwrap();
            serde_json::to_string_pretty(&*theme).map_err(|e| e.to_string())
        }
        "properties" => {
            let props = state.workbook_properties.lock().unwrap();
            serde_json::to_string_pretty(&*props).map_err(|e| e.to_string())
        }
        _ => Err(format!("Unknown object type: {}", object_type)),
    }
}

// ============================================================================
// set_object_json — Deserialize JSON and replace the workbook object
// ============================================================================

#[tauri::command]
pub fn set_object_json(
    state: State<AppState>,
    slicer_state: State<crate::slicer::SlicerState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
    script_state: State<crate::scripting::ScriptState>,
    timeline_slicer_state: State<crate::timeline_slicer::TimelineSlicerState>,
    object_type: String,
    object_id: String,
    json: String,
) -> Result<(), String> {
    match object_type.as_str() {
        "chart" => {
            let id: u32 = object_id.parse().map_err(|_| "Invalid chart id".to_string())?;
            let new_entry: api_types::ChartEntry = serde_json::from_str(&json)
                .map_err(|e| format!("Invalid chart JSON: {}", e))?;
            let mut charts = state.charts.lock().unwrap();
            if let Some(existing) = charts.iter_mut().find(|c| c.id == id) {
                *existing = new_entry;
                Ok(())
            } else {
                Err(format!("Chart {} not found", id))
            }
        }
        "table" => {
            let id: u64 = object_id.parse().map_err(|_| "Invalid table id".to_string())?;
            let new_table: crate::tables::Table = serde_json::from_str(&json)
                .map_err(|e| format!("Invalid table JSON: {}", e))?;
            let mut tables = state.tables.lock().unwrap();
            for sheet_tables in tables.values_mut() {
                if let Some(existing) = sheet_tables.get_mut(&id) {
                    // Update the table name registry if name changed
                    if existing.name != new_table.name {
                        let mut names = state.table_names.lock().unwrap();
                        names.remove(&existing.name.to_uppercase());
                        names.insert(new_table.name.to_uppercase(), (new_table.sheet_index, new_table.id));
                    }
                    *existing = new_table;
                    return Ok(());
                }
            }
            Err(format!("Table {} not found", id))
        }
        "slicer" => {
            let id: u64 = object_id.parse().map_err(|_| "Invalid slicer id".to_string())?;
            let new_slicer: crate::slicer::Slicer = serde_json::from_str(&json)
                .map_err(|e| format!("Invalid slicer JSON: {}", e))?;
            let mut slicers = slicer_state.slicers.lock().unwrap();
            if let Some(existing) = slicers.get_mut(&id) {
                *existing = new_slicer;
                Ok(())
            } else {
                Err(format!("Slicer {} not found", id))
            }
        }
        "ribbon_filter" => {
            let id: u64 = object_id.parse().map_err(|_| "Invalid ribbon filter id".to_string())?;
            let new_filter: crate::ribbon_filter::RibbonFilter = serde_json::from_str(&json)
                .map_err(|e| format!("Invalid ribbon filter JSON: {}", e))?;
            let mut filters = ribbon_filter_state.filters.lock().unwrap();
            if let Some(existing) = filters.get_mut(&id) {
                *existing = new_filter;
                Ok(())
            } else {
                Err(format!("Ribbon filter {} not found", id))
            }
        }
        "timeline_slicer" => {
            let id: u64 = object_id.parse().map_err(|_| "Invalid timeline slicer id".to_string())?;
            let new_timeline: crate::timeline_slicer::TimelineSlicer = serde_json::from_str(&json)
                .map_err(|e| format!("Invalid timeline slicer JSON: {}", e))?;
            let mut timelines = timeline_slicer_state.timelines.lock().unwrap();
            if let Some(existing) = timelines.get_mut(&id) {
                *existing = new_timeline;
                Ok(())
            } else {
                Err(format!("Timeline slicer {} not found", id))
            }
        }
        "sparkline" => {
            let idx: usize = object_id.parse().map_err(|_| "Invalid sparkline index".to_string())?;
            let new_entry: api_types::SparklineEntry = serde_json::from_str(&json)
                .map_err(|e| format!("Invalid sparkline JSON: {}", e))?;
            let mut sparklines = state.sparklines.lock().unwrap();
            if idx < sparklines.len() {
                sparklines[idx] = new_entry;
                Ok(())
            } else {
                Err(format!("Sparkline entry {} not found", idx))
            }
        }
        "script" => {
            let new_script: crate::scripting::WorkbookScript = serde_json::from_str(&json)
                .map_err(|e| format!("Invalid script JSON: {}", e))?;
            let mut scripts = script_state.workbook_scripts.lock().unwrap();
            if scripts.contains_key(&object_id) {
                scripts.insert(object_id, new_script);
                Ok(())
            } else {
                Err(format!("Script '{}' not found", object_id))
            }
        }
        "notebook" => {
            let new_notebook: crate::scripting::NotebookDocument = serde_json::from_str(&json)
                .map_err(|e| format!("Invalid notebook JSON: {}", e))?;
            let mut notebooks = script_state.workbook_notebooks.lock().unwrap();
            if notebooks.contains_key(&object_id) {
                notebooks.insert(object_id, new_notebook);
                Ok(())
            } else {
                Err(format!("Notebook '{}' not found", object_id))
            }
        }
        "pivot_layout" => {
            let id: u64 = object_id.parse().map_err(|_| "Invalid pivot layout id".to_string())?;
            let new_layout: ::persistence::SavedPivotLayout = serde_json::from_str(&json)
                .map_err(|e| format!("Invalid pivot layout JSON: {}", e))?;
            let mut layouts = state.pivot_layouts.lock().unwrap();
            if let Some(existing) = layouts.iter_mut().find(|l| l.id == id) {
                *existing = new_layout;
                Ok(())
            } else {
                Err(format!("Pivot layout {} not found", id))
            }
        }
        "theme" => {
            let new_theme: engine::ThemeDefinition = serde_json::from_str(&json)
                .map_err(|e| format!("Invalid theme JSON: {}", e))?;
            let mut theme = state.theme.lock().unwrap();
            *theme = new_theme;
            Ok(())
        }
        "properties" => {
            let new_props: api_types::WorkbookProperties = serde_json::from_str(&json)
                .map_err(|e| format!("Invalid properties JSON: {}", e))?;
            let mut props = state.workbook_properties.lock().unwrap();
            *props = new_props;
            Ok(())
        }
        _ => Err(format!("Unknown object type: {}", object_type)),
    }
}

// ============================================================================
// list_objects — Enumerate all configurable objects in the workbook
// ============================================================================

#[tauri::command]
pub fn list_objects(
    state: State<AppState>,
    slicer_state: State<crate::slicer::SlicerState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
    script_state: State<crate::scripting::ScriptState>,
    timeline_slicer_state: State<crate::timeline_slicer::TimelineSlicerState>,
) -> Vec<ObjectEntry> {
    let mut entries = Vec::new();

    // Singleton objects
    entries.push(ObjectEntry {
        object_type: "theme".to_string(),
        object_id: "0".to_string(),
        label: "Document Theme".to_string(),
    });
    entries.push(ObjectEntry {
        object_type: "properties".to_string(),
        object_id: "0".to_string(),
        label: "Workbook Properties".to_string(),
    });

    // Charts
    {
        let charts = state.charts.lock().unwrap();
        for chart in charts.iter() {
            entries.push(ObjectEntry {
                object_type: "chart".to_string(),
                object_id: chart.id.to_string(),
                label: format!("Chart {}", chart.id),
            });
        }
    }

    // Tables
    {
        let tables = state.tables.lock().unwrap();
        for sheet_tables in tables.values() {
            for table in sheet_tables.values() {
                entries.push(ObjectEntry {
                    object_type: "table".to_string(),
                    object_id: table.id.to_string(),
                    label: format!("Table: {}", table.name),
                });
            }
        }
    }

    // Slicers
    {
        let slicers = slicer_state.slicers.lock().unwrap();
        for slicer in slicers.values() {
            entries.push(ObjectEntry {
                object_type: "slicer".to_string(),
                object_id: slicer.id.to_string(),
                label: format!("Slicer: {}", slicer.name),
            });
        }
    }

    // Ribbon filters
    {
        let filters = ribbon_filter_state.filters.lock().unwrap();
        for filter in filters.values() {
            entries.push(ObjectEntry {
                object_type: "ribbon_filter".to_string(),
                object_id: filter.id.to_string(),
                label: format!("Ribbon Filter: {}", filter.name),
            });
        }
    }

    // Timeline slicers
    {
        let timelines = timeline_slicer_state.timelines.lock().unwrap();
        for timeline in timelines.values() {
            entries.push(ObjectEntry {
                object_type: "timeline_slicer".to_string(),
                object_id: timeline.id.to_string(),
                label: format!("Timeline: {}", timeline.name),
            });
        }
    }

    // Sparklines
    {
        let sparklines = state.sparklines.lock().unwrap();
        for (idx, entry) in sparklines.iter().enumerate() {
            entries.push(ObjectEntry {
                object_type: "sparkline".to_string(),
                object_id: idx.to_string(),
                label: format!("Sparklines (Sheet {})", entry.sheet_index),
            });
        }
    }

    // Scripts
    {
        let scripts = script_state.workbook_scripts.lock().unwrap();
        for script in scripts.values() {
            entries.push(ObjectEntry {
                object_type: "script".to_string(),
                object_id: script.id.clone(),
                label: format!("Script: {}", script.name),
            });
        }
    }

    // Notebooks
    {
        let notebooks = script_state.workbook_notebooks.lock().unwrap();
        for notebook in notebooks.values() {
            entries.push(ObjectEntry {
                object_type: "notebook".to_string(),
                object_id: notebook.id.clone(),
                label: format!("Notebook: {}", notebook.name),
            });
        }
    }

    // Pivot layouts
    {
        let layouts = state.pivot_layouts.lock().unwrap();
        for layout in layouts.iter() {
            entries.push(ObjectEntry {
                object_type: "pivot_layout".to_string(),
                object_id: layout.id.to_string(),
                label: format!("Pivot Layout: {}", layout.name),
            });
        }
    }

    entries
}

// ============================================================================
// get_workbook_tree — Lightweight tree summary of the entire workbook structure
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub label: String,
    pub object_type: Option<String>,
    pub object_id: Option<String>,
    pub children: Vec<TreeNode>,
}

#[tauri::command]
pub fn get_workbook_tree(
    state: State<AppState>,
    slicer_state: State<crate::slicer::SlicerState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
    script_state: State<crate::scripting::ScriptState>,
    timeline_slicer_state: State<crate::timeline_slicer::TimelineSlicerState>,
) -> TreeNode {
    let mut root = TreeNode {
        label: "Workbook".to_string(),
        object_type: None,
        object_id: None,
        children: Vec::new(),
    };

    // Workbook-level singletons
    {
        let workbook_node = TreeNode {
            label: "Workbook Settings".to_string(),
            object_type: None,
            object_id: None,
            children: vec![
                TreeNode {
                    label: "Document Theme".to_string(),
                    object_type: Some("theme".to_string()),
                    object_id: Some("0".to_string()),
                    children: Vec::new(),
                },
                TreeNode {
                    label: "Workbook Properties".to_string(),
                    object_type: Some("properties".to_string()),
                    object_id: Some("0".to_string()),
                    children: Vec::new(),
                },
            ],
        };
        root.children.push(workbook_node);
    }

    // Sheets
    {
        let sheet_names = state.sheet_names.lock().unwrap();
        let mut sheets_node = TreeNode {
            label: format!("Sheets ({})", sheet_names.len()),
            object_type: None,
            object_id: None,
            children: Vec::new(),
        };
        for (idx, name) in sheet_names.iter().enumerate() {
            sheets_node.children.push(TreeNode {
                label: format!("{} (Sheet {})", name, idx),
                object_type: Some("sheet_layout".to_string()),
                object_id: Some(idx.to_string()),
                children: Vec::new(),
            });
        }
        root.children.push(sheets_node);
    }

    // Tables
    {
        let tables = state.tables.lock().unwrap();
        let all_tables: Vec<_> = tables.values()
            .flat_map(|sheet_tables| sheet_tables.values())
            .collect();
        if !all_tables.is_empty() {
            let mut node = TreeNode {
                label: format!("Tables ({})", all_tables.len()),
                object_type: None,
                object_id: None,
                children: Vec::new(),
            };
            for table in all_tables {
                node.children.push(TreeNode {
                    label: table.name.clone(),
                    object_type: Some("table".to_string()),
                    object_id: Some(table.id.to_string()),
                    children: Vec::new(),
                });
            }
            root.children.push(node);
        }
    }

    // Charts
    {
        let charts = state.charts.lock().unwrap();
        if !charts.is_empty() {
            let mut node = TreeNode {
                label: format!("Charts ({})", charts.len()),
                object_type: None,
                object_id: None,
                children: Vec::new(),
            };
            for chart in charts.iter() {
                node.children.push(TreeNode {
                    label: format!("Chart {}", chart.id),
                    object_type: Some("chart".to_string()),
                    object_id: Some(chart.id.to_string()),
                    children: Vec::new(),
                });
            }
            root.children.push(node);
        }
    }

    // Slicers
    {
        let slicers = slicer_state.slicers.lock().unwrap();
        if !slicers.is_empty() {
            let mut node = TreeNode {
                label: format!("Slicers ({})", slicers.len()),
                object_type: None,
                object_id: None,
                children: Vec::new(),
            };
            for slicer in slicers.values() {
                node.children.push(TreeNode {
                    label: slicer.name.clone(),
                    object_type: Some("slicer".to_string()),
                    object_id: Some(slicer.id.to_string()),
                    children: Vec::new(),
                });
            }
            root.children.push(node);
        }
    }

    // Ribbon Filters
    {
        let filters = ribbon_filter_state.filters.lock().unwrap();
        if !filters.is_empty() {
            let mut node = TreeNode {
                label: format!("Ribbon Filters ({})", filters.len()),
                object_type: None,
                object_id: None,
                children: Vec::new(),
            };
            for filter in filters.values() {
                node.children.push(TreeNode {
                    label: filter.name.clone(),
                    object_type: Some("ribbon_filter".to_string()),
                    object_id: Some(filter.id.to_string()),
                    children: Vec::new(),
                });
            }
            root.children.push(node);
        }
    }

    // Timeline Slicers
    {
        let timelines = timeline_slicer_state.timelines.lock().unwrap();
        if !timelines.is_empty() {
            let mut node = TreeNode {
                label: format!("Timeline Slicers ({})", timelines.len()),
                object_type: None,
                object_id: None,
                children: Vec::new(),
            };
            for timeline in timelines.values() {
                node.children.push(TreeNode {
                    label: timeline.name.clone(),
                    object_type: Some("timeline_slicer".to_string()),
                    object_id: Some(timeline.id.to_string()),
                    children: Vec::new(),
                });
            }
            root.children.push(node);
        }
    }

    // Sparklines
    {
        let sparklines = state.sparklines.lock().unwrap();
        if !sparklines.is_empty() {
            let mut node = TreeNode {
                label: format!("Sparklines ({})", sparklines.len()),
                object_type: None,
                object_id: None,
                children: Vec::new(),
            };
            for (idx, entry) in sparklines.iter().enumerate() {
                node.children.push(TreeNode {
                    label: format!("Sheet {}", entry.sheet_index),
                    object_type: Some("sparkline".to_string()),
                    object_id: Some(idx.to_string()),
                    children: Vec::new(),
                });
            }
            root.children.push(node);
        }
    }

    // Scripts
    {
        let scripts = script_state.workbook_scripts.lock().unwrap();
        if !scripts.is_empty() {
            let mut node = TreeNode {
                label: format!("Scripts ({})", scripts.len()),
                object_type: None,
                object_id: None,
                children: Vec::new(),
            };
            for script in scripts.values() {
                node.children.push(TreeNode {
                    label: script.name.clone(),
                    object_type: Some("script".to_string()),
                    object_id: Some(script.id.clone()),
                    children: Vec::new(),
                });
            }
            root.children.push(node);
        }
    }

    // Notebooks
    {
        let notebooks = script_state.workbook_notebooks.lock().unwrap();
        if !notebooks.is_empty() {
            let mut node = TreeNode {
                label: format!("Notebooks ({})", notebooks.len()),
                object_type: None,
                object_id: None,
                children: Vec::new(),
            };
            for notebook in notebooks.values() {
                node.children.push(TreeNode {
                    label: notebook.name.clone(),
                    object_type: Some("notebook".to_string()),
                    object_id: Some(notebook.id.clone()),
                    children: Vec::new(),
                });
            }
            root.children.push(node);
        }
    }

    // Pivot Layouts
    {
        let layouts = state.pivot_layouts.lock().unwrap();
        if !layouts.is_empty() {
            let mut node = TreeNode {
                label: format!("Pivot Layouts ({})", layouts.len()),
                object_type: None,
                object_id: None,
                children: Vec::new(),
            };
            for layout in layouts.iter() {
                node.children.push(TreeNode {
                    label: layout.name.clone(),
                    object_type: Some("pivot_layout".to_string()),
                    object_id: Some(layout.id.to_string()),
                    children: Vec::new(),
                });
            }
            root.children.push(node);
        }
    }

    root
}
