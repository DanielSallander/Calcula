//! FILENAME: app/src-tauri/src/linked_sheets.rs
//! Tauri commands for the Linked Sheet distribution system.
//!
//! Authors publish sheets to a shared directory (any location).
//! Consumers link published sheets into their workbooks with auto/manual refresh.

use serde::{Deserialize, Serialize};
use tauri::State;

use calcula_format::publish::linked::{LinkedSheetInfo, RefreshResult};
use calcula_format::publish::manifest::PublishManifest;
use calcula_format::publish::reader::{
    browse_published_sheets as do_browse, read_publish_manifest, read_published_sheet,
    PublishedSheetInfo,
};
use calcula_format::publish::writer::{publish_sheets as do_publish, PublishRequest};

use crate::persistence::UserFilesState;
use crate::AppState;
use crate::ProtectedRegion;

// ─── JSON types for frontend ──────────────────────────────────────────────────

/// Published sheet info returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedSheetInfoJson {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: u64,
    pub published_at: String,
    pub checksum: String,
}

impl From<PublishedSheetInfo> for PublishedSheetInfoJson {
    fn from(info: PublishedSheetInfo) -> Self {
        PublishedSheetInfoJson {
            id: info.id,
            name: info.name,
            description: info.description,
            version: info.version,
            published_at: info.published_at,
            checksum: info.checksum,
        }
    }
}

/// Publish manifest info returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishManifestJson {
    pub format_version: u32,
    pub name: String,
    pub published_at: String,
    pub published_by: String,
    pub sheets: Vec<PublishedSheetInfoJson>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub connections: Vec<PublishedConnectionJson>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parameters: Vec<ConnectionParameterJson>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub environments: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedConnectionJson {
    pub name: String,
    pub connection_type: String,
    pub connection_string_template: String,
    pub model_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionParameterJson {
    pub name: String,
    pub description: String,
    pub secret: bool,
}

impl From<PublishManifest> for PublishManifestJson {
    fn from(m: PublishManifest) -> Self {
        PublishManifestJson {
            format_version: m.format_version,
            name: m.name,
            published_at: m.published_at,
            published_by: m.published_by,
            sheets: m
                .sheets
                .iter()
                .map(|s| PublishedSheetInfoJson {
                    id: s.id.clone(),
                    name: s.name.clone(),
                    description: s.description.clone(),
                    version: s.version,
                    published_at: s.published_at.clone(),
                    checksum: s.checksum.clone(),
                })
                .collect(),
            connections: m
                .connections
                .iter()
                .map(|c| PublishedConnectionJson {
                    name: c.name.clone(),
                    connection_type: c.connection_type.clone(),
                    connection_string_template: c.connection_string_template.clone(),
                    model_path: c.model_path.clone(),
                })
                .collect(),
            parameters: m
                .parameters
                .iter()
                .map(|p| ConnectionParameterJson {
                    name: p.name.clone(),
                    description: p.description.clone(),
                    secret: p.secret,
                })
                .collect(),
            environments: m.environments.keys().cloned().collect(),
        }
    }
}

/// Request from frontend to publish sheets.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishSheetsRequest {
    /// Path to the publication directory.
    pub pub_dir: String,
    /// Which sheets to publish (by index).
    pub sheet_indices: Vec<usize>,
    /// Optional per-sheet descriptions.
    #[serde(default)]
    pub descriptions: Vec<String>,
    /// Author name.
    pub author: String,
    /// Optional BI connection strings to auto-extract parameters from.
    /// Each entry: { name, connectionType, connectionString, modelPath? }
    #[serde(default)]
    pub connections: Vec<ConnectionInput>,
    /// Named environment profiles.
    /// Key: env name (e.g., "DEV"), Value: param_name -> value.
    #[serde(default)]
    pub environments: std::collections::HashMap<String, std::collections::HashMap<String, String>>,
}

/// BI connection info provided by the frontend for publishing.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInput {
    pub name: String,
    pub connection_type: String,
    pub connection_string: String,
    pub model_path: Option<String>,
}

/// Result returned to frontend after publishing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishSheetsResultJson {
    pub sheets_published: usize,
    pub pub_dir: String,
}

/// Request from frontend to link published sheets.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkSheetsRequest {
    /// Path to the publication directory.
    pub pub_dir: String,
    /// Which published sheet IDs to link.
    pub sheet_ids: Vec<String>,
    /// Selected environment name for resolving connection parameters.
    #[serde(default)]
    pub environment: Option<String>,
}

/// Result returned to frontend after linking.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkResultJson {
    pub linked_sheet_indices: Vec<usize>,
    pub linked_sheet_names: Vec<String>,
}

/// Result returned to frontend after refresh.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshResultJson {
    pub sheet_index: usize,
    pub updated: bool,
    pub old_version: u64,
    pub new_version: u64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

impl From<RefreshResult> for RefreshResultJson {
    fn from(r: RefreshResult) -> Self {
        RefreshResultJson {
            sheet_index: r.sheet_index,
            updated: r.updated,
            old_version: r.old_version,
            new_version: r.new_version,
            warnings: r.warnings,
        }
    }
}

/// Status returned to frontend for a linked sheet.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedSheetStatusJson {
    pub sheet_index: usize,
    pub state: String,
    pub local_version: u64,
    pub remote_version: Option<u64>,
    pub message: String,
}

// ─── Helper: get ISO 8601 timestamp ───────────────────────────────────────────

fn now_iso8601() -> String {
    // Use system time for a simple ISO 8601 timestamp
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    // Simple UTC formatting: YYYY-MM-DDTHH:MM:SSZ
    let secs_per_day = 86400u64;
    let days = now / secs_per_day;
    let time_of_day = now % secs_per_day;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    // Days since epoch to Y/M/D (simplified)
    let mut y = 1970i64;
    let mut remaining_days = days as i64;
    loop {
        let days_in_year = if is_leap_year(y) { 366 } else { 365 };
        if remaining_days < days_in_year {
            break;
        }
        remaining_days -= days_in_year;
        y += 1;
    }
    let days_in_months = if is_leap_year(y) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut m = 1u32;
    for &dim in &days_in_months {
        if remaining_days < dim {
            break;
        }
        remaining_days -= dim;
        m += 1;
    }
    let d = remaining_days + 1;

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y, m, d, hours, minutes, seconds
    )
}

fn is_leap_year(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
}

// ─── Tauri commands: Author side ──────────────────────────────────────────────

/// Publish selected sheets from the current workbook to a publication directory.
#[tauri::command]
pub fn publish_sheets(
    state: State<AppState>,
    user_files_state: State<UserFilesState>,
    script_state: State<crate::scripting::types::ScriptState>,
    request: PublishSheetsRequest,
) -> Result<PublishSheetsResultJson, String> {
    use calcula_format::publish::manifest::{
        build_connection_template, parse_connection_params, ConnectionParameter,
        PublishedConnection,
    };
    use calcula_format::publish::writer::ScriptToPublish;
    use crate::scripting::types::ScriptScope;

    let workbook = crate::persistence::build_workbook_for_save(&state, &user_files_state)
        .map_err(|e| e.to_string())?;

    let pub_dir = std::path::Path::new(&request.pub_dir);

    // Collect sheet names being published
    let published_sheet_names: Vec<String> = request
        .sheet_indices
        .iter()
        .filter_map(|&idx| workbook.sheets.get(idx).map(|s| s.name.clone()))
        .collect();

    // Automatically collect scripts scoped to the published sheets
    let scripts_to_publish: Vec<ScriptToPublish> = {
        let scripts = script_state.workbook_scripts.lock().map_err(|e| e.to_string())?;
        scripts
            .values()
            .filter_map(|s| match &s.scope {
                ScriptScope::Sheet { name } if published_sheet_names.contains(name) => {
                    Some(ScriptToPublish {
                        id: s.id.clone(),
                        name: s.name.clone(),
                        description: s.description.clone(),
                        source: s.source.clone(),
                        sheet_name: name.clone(),
                    })
                }
                _ => None,
            })
            .collect()
    };

    let pub_request = PublishRequest {
        sheet_indices: request.sheet_indices,
        descriptions: request.descriptions,
        author: request.author.clone(),
        now: now_iso8601(),
        scripts: scripts_to_publish,
    };

    let mut result = do_publish(&workbook, &pub_request, pub_dir)
        .map_err(|e| e.to_string())?;

    // Process connections: auto-extract parameters and build templates
    if !request.connections.is_empty() {
        let mut all_params: Vec<ConnectionParameter> = Vec::new();
        let mut published_connections: Vec<PublishedConnection> = Vec::new();

        for conn in &request.connections {
            let extracted = parse_connection_params(&conn.connection_string);
            let template = build_connection_template(&conn.connection_string, &extracted);

            published_connections.push(PublishedConnection {
                name: conn.name.clone(),
                connection_type: conn.connection_type.clone(),
                connection_string_template: template,
                model_path: conn.model_path.clone(),
            });

            // Collect unique parameters
            for (name, _value, secret) in &extracted {
                if !all_params.iter().any(|p| p.name == *name) {
                    all_params.push(ConnectionParameter {
                        name: name.clone(),
                        description: default_param_description(name),
                        secret: *secret,
                    });
                }
            }
        }

        result.manifest.connections = published_connections;
        result.manifest.parameters = all_params;

        // Set environments from the request
        if !request.environments.is_empty() {
            result.manifest.environments = request.environments;
        } else {
            // Auto-create a "DEV" environment from the current values
            let mut dev_env = std::collections::HashMap::new();
            for conn in &request.connections {
                for (name, value, _) in parse_connection_params(&conn.connection_string) {
                    dev_env.entry(name).or_insert(value);
                }
            }
            if !dev_env.is_empty() {
                result
                    .manifest
                    .environments
                    .insert("DEV".to_string(), dev_env);
            }
        }

        // Re-write manifest with connection info
        let manifest_path = pub_dir.join("publish-manifest.json");
        let manifest_json = serde_json::to_string_pretty(&result.manifest)
            .map_err(|e| e.to_string())?;
        std::fs::write(&manifest_path, manifest_json.as_bytes())
            .map_err(|e| e.to_string())?;
    }

    Ok(PublishSheetsResultJson {
        sheets_published: result.sheets_published,
        pub_dir: pub_dir.to_string_lossy().to_string(),
    })
}

/// Default description for auto-detected connection parameters.
fn default_param_description(name: &str) -> String {
    match name {
        "DB_HOST" => "Database server hostname".to_string(),
        "DB_PORT" => "Database server port".to_string(),
        "DB_NAME" => "Database name".to_string(),
        "DB_USER" => "Database username".to_string(),
        "DB_PASS" => "Database password".to_string(),
        "CONNECTION_STRING" => "Full connection string".to_string(),
        _ => String::new(),
    }
}

/// Get information about what's already published at a directory.
#[tauri::command]
pub fn get_publish_info(pub_dir: String) -> Result<Option<PublishManifestJson>, String> {
    let path = std::path::Path::new(&pub_dir);

    if !path.exists() {
        return Ok(None);
    }

    let manifest = read_publish_manifest(path).map_err(|e| e.to_string())?;
    Ok(Some(manifest.into()))
}

/// Remove a published sheet from the publication directory.
#[tauri::command]
pub fn unpublish_sheet(pub_dir: String, sheet_id: String) -> Result<(), String> {
    let path = std::path::Path::new(&pub_dir);

    calcula_format::publish::writer::unpublish_sheet(path, &sheet_id)
        .map_err(|e| e.to_string())
}

// ─── Tauri commands: Consumer side ────────────────────────────────────────────

/// Browse published sheets available at a publication directory.
#[tauri::command]
pub fn browse_published_sheets(
    pub_dir: String,
) -> Result<Vec<PublishedSheetInfoJson>, String> {
    let path = std::path::Path::new(&pub_dir);

    let sheets = do_browse(path).map_err(|e| e.to_string())?;
    Ok(sheets.into_iter().map(PublishedSheetInfoJson::from).collect())
}

/// Link published sheets into the current workbook.
#[tauri::command]
pub fn link_published_sheets(
    state: State<AppState>,
    script_state: State<crate::scripting::types::ScriptState>,
    request: LinkSheetsRequest,
) -> Result<LinkResultJson, String> {
    let pub_dir = std::path::Path::new(&request.pub_dir);

    let manifest = read_publish_manifest(pub_dir).map_err(|e| e.to_string())?;

    let mut linked_indices = Vec::new();
    let mut linked_names = Vec::new();

    let mut grids = state.grids.lock().map_err(|e| e.to_string())?;
    let mut sheet_names = state.sheet_names.lock().map_err(|e| e.to_string())?;
    let mut all_cw = state.all_column_widths.lock().map_err(|e| e.to_string())?;
    let mut all_rh = state.all_row_heights.lock().map_err(|e| e.to_string())?;
    let mut freeze_configs = state.freeze_configs.lock().map_err(|e| e.to_string())?;
    let mut split_configs = state.split_configs.lock().map_err(|e| e.to_string())?;
    let mut page_setups = state.page_setups.lock().map_err(|e| e.to_string())?;
    let mut tab_colors = state.tab_colors.lock().map_err(|e| e.to_string())?;
    let mut hidden_sheets = state.hidden_sheets.lock().map_err(|e| e.to_string())?;
    let mut protected_regions = state.protected_regions.lock().map_err(|e| e.to_string())?;
    let mut linked_sheets = state.linked_sheets.lock().map_err(|e| e.to_string())?;
    let mut style_registry = state.style_registry.lock().map_err(|e| e.to_string())?;

    for sheet_id in &request.sheet_ids {
        let published = manifest
            .find_sheet(sheet_id)
            .ok_or_else(|| format!("Published sheet '{}' not found", sheet_id))?;

        let sheet = read_published_sheet(pub_dir, published).map_err(|e| e.to_string())?;

        // Build a grid from the sheet data
        let (grid, _styles) = sheet.to_grid();

        // Remap styles from the published sheet into the workbook's shared registry
        // (The published sheet may have its own style set that needs merging)
        for style in &sheet.styles {
            style_registry.get_or_create(style.clone());
        }

        let new_idx = grids.len();

        // Determine the data extent for the protected region
        let (max_row, max_col) = sheet
            .cells
            .keys()
            .fold((0u32, 0u32), |(mr, mc), &(r, c)| (mr.max(r), mc.max(c)));

        grids.push(grid);
        sheet_names.push(sheet.name.clone());
        all_cw.push(sheet.column_widths.clone());
        all_rh.push(sheet.row_heights.clone());
        freeze_configs.push(crate::sheets::FreezeConfig::default());
        split_configs.push(crate::sheets::SplitConfig::default());
        page_setups.push(crate::api_types::PageSetup::default());
        tab_colors.push(String::new());
        hidden_sheets.push(false);

        // Create protected region covering the entire data area
        if !sheet.cells.is_empty() {
            protected_regions.push(ProtectedRegion {
                id: format!("linked-sheet-{}", new_idx),
                region_type: "linked-sheet".to_string(),
                owner_id: new_idx as u64,
                sheet_index: new_idx,
                start_row: 0,
                start_col: 0,
                end_row: max_row,
                end_col: max_col,
            });
        }

        // Create linked sheet metadata
        linked_sheets.push(LinkedSheetInfo {
            sheet_index: new_idx,
            published_sheet_id: published.id.clone(),
            synced_version: published.version,
            source_path: pub_dir.to_string_lossy().to_string(),
            source_folder: published.folder.clone(),
            synced_checksum: published.checksum.clone(),
            last_refreshed: now_iso8601(),
            layout_overrides: None,
        });

        linked_indices.push(new_idx);
        linked_names.push(sheet.name.clone());
    }

    // Import scripts that are scoped to the linked sheets
    if !manifest.scripts.is_empty() {
        use crate::scripting::types::{ScriptScope, WorkbookScript};
        let mut scripts = script_state.workbook_scripts.lock().map_err(|e| e.to_string())?;

        for published_script in &manifest.scripts {
            // Only import scripts for sheets we just linked
            if linked_names.contains(&published_script.sheet_name) {
                scripts.insert(
                    published_script.id.clone(),
                    WorkbookScript {
                        id: published_script.id.clone(),
                        name: published_script.name.clone(),
                        description: published_script.description.clone(),
                        source: published_script.source.clone(),
                        scope: ScriptScope::Sheet {
                            name: published_script.sheet_name.clone(),
                        },
                    },
                );
            }
        }
    }

    Ok(LinkResultJson {
        linked_sheet_indices: linked_indices,
        linked_sheet_names: linked_names,
    })
}

/// Refresh a single linked sheet from its published source.
#[tauri::command]
pub fn refresh_linked_sheet(
    state: State<AppState>,
    sheet_index: usize,
) -> Result<RefreshResultJson, String> {
    let mut linked_sheets = state.linked_sheets.lock().map_err(|e| e.to_string())?;

    let link_info = linked_sheets
        .iter()
        .find(|l| l.sheet_index == sheet_index)
        .ok_or_else(|| format!("Sheet {} is not a linked sheet", sheet_index))?
        .clone();

    let pub_dir = std::path::Path::new(&link_info.source_path);

    // Read the publish manifest to check for updates
    let manifest = read_publish_manifest(pub_dir).map_err(|e| e.to_string())?;
    let published = manifest
        .find_sheet(&link_info.published_sheet_id)
        .ok_or_else(|| {
            format!(
                "Published sheet '{}' no longer exists",
                link_info.published_sheet_id
            )
        })?;

    let old_version = link_info.synced_version;

    // Check if already up to date
    if published.version == link_info.synced_version
        && published.checksum == link_info.synced_checksum
    {
        return Ok(RefreshResultJson {
            sheet_index,
            updated: false,
            old_version,
            new_version: old_version,
            warnings: vec![],
        });
    }

    // Read the new sheet data
    let sheet = read_published_sheet(pub_dir, published).map_err(|e| e.to_string())?;

    // Save consumer's current layout overrides before replacing data
    let layout_overrides = {
        let all_cw = state.all_column_widths.lock().map_err(|e| e.to_string())?;
        let all_rh = state.all_row_heights.lock().map_err(|e| e.to_string())?;
        if let (Some(cw), Some(rh)) = (all_cw.get(sheet_index), all_rh.get(sheet_index)) {
            if !cw.is_empty() || !rh.is_empty() {
                Some(calcula_format::publish::linked::LinkedSheetInfo {
                    layout_overrides: Some(
                        calcula_format::sheet_layout::SheetLayout::from_dimensions(cw, rh),
                    ),
                    ..link_info.clone()
                })
            } else {
                None
            }
        } else {
            None
        }
    };

    // Determine if consumer has layout overrides
    let consumer_layout = layout_overrides
        .as_ref()
        .and_then(|l| l.layout_overrides.as_ref());

    // Replace the grid data
    {
        let mut grids = state.grids.lock().map_err(|e| e.to_string())?;
        if let Some(grid) = grids.get_mut(sheet_index) {
            let (new_grid, _styles) = sheet.to_grid();
            *grid = new_grid;
        }
    }

    // Apply layout: use consumer overrides if available, otherwise use source layout
    {
        let mut all_cw = state.all_column_widths.lock().map_err(|e| e.to_string())?;
        let mut all_rh = state.all_row_heights.lock().map_err(|e| e.to_string())?;

        if let Some(layout) = consumer_layout {
            let (cw, rh) = layout.to_dimensions();
            if let Some(existing_cw) = all_cw.get_mut(sheet_index) {
                *existing_cw = cw;
            }
            if let Some(existing_rh) = all_rh.get_mut(sheet_index) {
                *existing_rh = rh;
            }
        } else {
            if let Some(existing_cw) = all_cw.get_mut(sheet_index) {
                *existing_cw = sheet.column_widths.clone();
            }
            if let Some(existing_rh) = all_rh.get_mut(sheet_index) {
                *existing_rh = sheet.row_heights.clone();
            }
        }
    }

    // Update protected region to cover new data extent
    {
        let (max_row, max_col) = sheet
            .cells
            .keys()
            .fold((0u32, 0u32), |(mr, mc), &(r, c)| (mr.max(r), mc.max(c)));

        let mut regions = state.protected_regions.lock().map_err(|e| e.to_string())?;
        // Remove old region for this sheet
        regions.retain(|r| {
            !(r.region_type == "linked-sheet" && r.sheet_index == sheet_index)
        });
        // Add new region
        if !sheet.cells.is_empty() {
            regions.push(ProtectedRegion {
                id: format!("linked-sheet-{}", sheet_index),
                region_type: "linked-sheet".to_string(),
                owner_id: sheet_index as u64,
                sheet_index,
                start_row: 0,
                start_col: 0,
                end_row: max_row,
                end_col: max_col,
            });
        }
    }

    // Update linked sheet metadata
    let new_version = published.version;
    if let Some(info) = linked_sheets
        .iter_mut()
        .find(|l| l.sheet_index == sheet_index)
    {
        info.synced_version = new_version;
        info.synced_checksum = published.checksum.clone();
        info.last_refreshed = now_iso8601();
        // Preserve consumer's layout overrides
        if let Some(lo) = layout_overrides {
            info.layout_overrides = lo.layout_overrides;
        }
    }

    Ok(RefreshResultJson {
        sheet_index,
        updated: true,
        old_version,
        new_version,
        warnings: vec![],
    })
}

/// Refresh all linked sheets in the workbook.
#[tauri::command]
pub fn refresh_all_linked_sheets(
    state: State<AppState>,
) -> Result<Vec<RefreshResultJson>, String> {
    let linked = state.linked_sheets.lock().map_err(|e| e.to_string())?;
    let indices: Vec<usize> = linked.iter().map(|l| l.sheet_index).collect();
    drop(linked); // Release the lock before calling refresh

    let mut results = Vec::new();
    for idx in indices {
        match refresh_linked_sheet(state.clone(), idx) {
            Ok(result) => results.push(result),
            Err(e) => {
                // Source unavailable — report as warning, don't fail the whole batch
                results.push(RefreshResultJson {
                    sheet_index: idx,
                    updated: false,
                    old_version: 0,
                    new_version: 0,
                    warnings: vec![format!("Failed to refresh: {}", e)],
                });
            }
        }
    }

    Ok(results)
}

/// Convert a linked sheet to a regular sheet (removes protection and metadata).
#[tauri::command]
pub fn unlink_sheet(
    state: State<AppState>,
    sheet_index: usize,
) -> Result<(), String> {
    let mut linked_sheets = state.linked_sheets.lock().map_err(|e| e.to_string())?;

    let idx = linked_sheets
        .iter()
        .position(|l| l.sheet_index == sheet_index)
        .ok_or_else(|| format!("Sheet {} is not a linked sheet", sheet_index))?;

    linked_sheets.remove(idx);

    // Remove the protected region
    let mut regions = state.protected_regions.lock().map_err(|e| e.to_string())?;
    regions.retain(|r| {
        !(r.region_type == "linked-sheet" && r.sheet_index == sheet_index)
    });

    Ok(())
}

/// Check the sync status of a linked sheet.
#[tauri::command]
pub fn get_linked_sheet_status(
    state: State<AppState>,
    sheet_index: usize,
) -> Result<LinkedSheetStatusJson, String> {
    let linked_sheets = state.linked_sheets.lock().map_err(|e| e.to_string())?;

    let link_info = linked_sheets
        .iter()
        .find(|l| l.sheet_index == sheet_index)
        .ok_or_else(|| format!("Sheet {} is not a linked sheet", sheet_index))?;

    let pub_dir = std::path::Path::new(&link_info.source_path);

    // Try to read the remote manifest
    match read_publish_manifest(pub_dir) {
        Ok(manifest) => {
            if let Some(published) = manifest.find_sheet(&link_info.published_sheet_id) {
                if published.version == link_info.synced_version
                    && published.checksum == link_info.synced_checksum
                {
                    Ok(LinkedSheetStatusJson {
                        sheet_index,
                        state: "upToDate".to_string(),
                        local_version: link_info.synced_version,
                        remote_version: Some(published.version),
                        message: "Up to date".to_string(),
                    })
                } else {
                    Ok(LinkedSheetStatusJson {
                        sheet_index,
                        state: "stale".to_string(),
                        local_version: link_info.synced_version,
                        remote_version: Some(published.version),
                        message: format!(
                            "Remote version {} available (local: {})",
                            published.version, link_info.synced_version
                        ),
                    })
                }
            } else {
                Ok(LinkedSheetStatusJson {
                    sheet_index,
                    state: "sourceUnavailable".to_string(),
                    local_version: link_info.synced_version,
                    remote_version: None,
                    message: format!(
                        "Published sheet '{}' no longer exists in the manifest",
                        link_info.published_sheet_id
                    ),
                })
            }
        }
        Err(_) => Ok(LinkedSheetStatusJson {
            sheet_index,
            state: "sourceUnavailable".to_string(),
            local_version: link_info.synced_version,
            remote_version: None,
            message: format!(
                "Cannot access publication directory: {}",
                pub_dir.display()
            ),
        }),
    }
}

/// Get all linked sheet indices in the current workbook.
#[tauri::command]
pub fn get_linked_sheets(
    state: State<AppState>,
) -> Result<Vec<LinkedSheetInfoJson>, String> {
    let linked_sheets = state.linked_sheets.lock().map_err(|e| e.to_string())?;

    Ok(linked_sheets
        .iter()
        .map(|l| LinkedSheetInfoJson {
            sheet_index: l.sheet_index,
            published_sheet_id: l.published_sheet_id.clone(),
            synced_version: l.synced_version,
            source_path: l.source_path.clone(),
            last_refreshed: l.last_refreshed.clone(),
        })
        .collect())
}

/// JSON representation of linked sheet info for the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedSheetInfoJson {
    pub sheet_index: usize,
    pub published_sheet_id: String,
    pub synced_version: u64,
    pub source_path: String,
    pub last_refreshed: String,
}
