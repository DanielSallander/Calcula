//! FILENAME: app/src-tauri/src/calp_commands.rs
//! PURPOSE: Tauri commands for .calp package operations (publish, pull, etc.).

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::AppState;

use calp::manifest::SubscriptionManifest;
use calp::registry::LocalRegistry;
use calp::version::{SemVer, VersionPin};
use identity::{CellId, SheetId};

// ============================================================================
// API Types (camelCase for TypeScript)
// ============================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishParams {
    pub registry_path: String,
    pub package_name: String,
    pub version: String,
    pub kind: String,
    pub sheet_indices: Vec<usize>,
    pub published_by: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResponse {
    pub package_name: String,
    pub version: String,
    pub sheets_published: usize,
    pub tables_published: usize,
    pub named_ranges_published: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullParams {
    pub registry_path: String,
    pub package_name: String,
    pub version_pin: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullResponse {
    pub package_name: String,
    pub resolved_version: String,
    pub sheets_pulled: usize,
    pub tables_pulled: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageInfo {
    pub name: String,
    pub description: String,
    pub kind: String,
    pub author: String,
    pub versions: Vec<VersionInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub version: String,
    pub published_at: String,
    pub published_by: String,
    pub sheets: Vec<SheetInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetInfo {
    pub name: String,
    pub description: String,
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Publish selected sheets to a local registry.
#[tauri::command]
pub fn calp_publish(
    state: State<AppState>,
    params: PublishParams,
) -> Result<PublishResponse, String> {
    let registry = LocalRegistry::open(std::path::Path::new(&params.registry_path))
        .map_err(|e| e.to_string())?;

    let version = SemVer::parse(&params.version)
        .map_err(|e| e.to_string())?;

    let now = chrono::Utc::now().to_rfc3339();

    // Build a lightweight workbook snapshot for publishing
    let workbook = crate::persistence::build_workbook_snapshot(&state)?;

    let request = calp::publish::PublishRequest {
        workbook: &workbook,
        package_name: params.package_name,
        version,
        kind: params.kind,
        sheet_indices: params.sheet_indices,
        now,
        published_by: params.published_by,
    };

    let result = calp::publish::publish(&registry, &request)
        .map_err(|e| e.to_string())?;

    Ok(PublishResponse {
        package_name: result.package_name,
        version: result.version,
        sheets_published: result.sheets_published,
        tables_published: result.tables_published,
        named_ranges_published: result.named_ranges_published,
    })
}

/// Pull (subscribe to) a package.
#[tauri::command]
pub fn calp_pull(
    state: State<AppState>,
    params: PullParams,
) -> Result<PullResponse, String> {
    let registry = LocalRegistry::open(std::path::Path::new(&params.registry_path))
        .map_err(|e| e.to_string())?;

    let version_pin = VersionPin::parse(&params.version_pin)
        .map_err(|e| e.to_string())?;

    let now = chrono::Utc::now().to_rfc3339();

    let request = calp::pull::PullRequest {
        package_name: params.package_name.clone(),
        registry_url: format!("file://{}", params.registry_path),
        version_pin,
        now,
    };

    let result = calp::pull::pull(&registry, &request)
        .map_err(|e| e.to_string())?;

    let sheets_pulled = result.sheets.len();

    // Materialize pulled sheets into the workbook.
    // Each pulled sheet has its own local StyleRegistry; we merge styles into
    // the shared registry and remap cell style_index values accordingly.
    {
        let mut grids = state.grids.lock().map_err(|e| e.to_string())?;
        let mut sheet_names = state.sheet_names.lock().map_err(|e| e.to_string())?;
        let mut sheet_ids = state.sheet_ids.lock().map_err(|e| e.to_string())?;
        let mut shared_styles = state.style_registry.lock().map_err(|e| e.to_string())?;
        let mut all_cw = state.all_column_widths.lock().map_err(|e| e.to_string())?;
        let mut all_rh = state.all_row_heights.lock().map_err(|e| e.to_string())?;

        for pulled in &result.sheets {
            let (mut grid, local_styles) = pulled.sheet.to_grid();

            // Remap local style indices to the shared registry
            let local_all = local_styles.all_styles();
            let mut remap: Vec<usize> = Vec::with_capacity(local_all.len());
            for style in local_all {
                remap.push(shared_styles.get_or_create(style.clone()));
            }
            for (_key, cell) in grid.cells.iter_mut() {
                if cell.style_index < remap.len() {
                    cell.style_index = remap[cell.style_index];
                }
            }

            grids.push(grid);
            sheet_names.push(pulled.name.clone());
            sheet_ids.push(pulled.sheet.id);
            all_cw.push(pulled.sheet.column_widths.clone());
            all_rh.push(pulled.sheet.row_heights.clone());
        }
    }

    // Store subscription
    {
        let mut subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
        subs.subscriptions.push(result.subscription);
    }

    Ok(PullResponse {
        package_name: result.package_name,
        resolved_version: result.resolved_version.to_string(),
        sheets_pulled,
        tables_pulled: result.tables.len(),
    })
}

/// Browse packages in a local registry.
#[tauri::command]
pub fn calp_browse_registry(
    registry_path: String,
) -> Result<Vec<PackageInfo>, String> {
    let registry = LocalRegistry::open(std::path::Path::new(&registry_path))
        .map_err(|e| e.to_string())?;

    let names = registry.list_packages().map_err(|e| e.to_string())?;
    let mut packages = Vec::new();

    for name in names {
        let manifest = registry.get_package_manifest(&name).map_err(|e| e.to_string())?;
        let mut versions = Vec::new();

        for entry in &manifest.versions {
            let sheets = registry.get_version_manifest(&name, &entry.version)
                .map(|vm| vm.sheets.iter().map(|s| SheetInfo {
                    name: s.name.clone(),
                    description: s.description.clone(),
                }).collect())
                .unwrap_or_default();

            versions.push(VersionInfo {
                version: entry.version.clone(),
                published_at: entry.published_at.clone(),
                published_by: entry.published_by.clone(),
                sheets,
            });
        }

        packages.push(PackageInfo {
            name: manifest.name,
            description: manifest.description,
            kind: manifest.kind,
            author: manifest.author,
            versions,
        });
    }

    Ok(packages)
}

/// Get subscription metadata for the current workbook.
#[tauri::command]
pub fn calp_get_subscriptions(
    state: State<AppState>,
) -> Result<SubscriptionManifest, String> {
    let subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
    Ok(subs.clone())
}

/// Return the entire override layer for the current workbook.
#[tauri::command]
pub fn calp_get_overrides(
    state: State<AppState>,
) -> Result<calp::OverrideLayer, String> {
    let layer = state.override_layer.lock().map_err(|e| e.to_string())?;
    Ok(layer.clone())
}

/// Revert a single override, restoring the upstream value for that cell.
#[tauri::command]
pub fn calp_revert_override(
    state: State<AppState>,
    sheet_id: String,
    cell_id: String,
) -> Result<bool, String> {
    let sid = SheetId::parse(&sheet_id)
        .ok_or_else(|| format!("Invalid sheet_id: {}", sheet_id))?;
    let cid = CellId::parse(&cell_id)
        .ok_or_else(|| format!("Invalid cell_id: {}", cell_id))?;
    let mut layer = state.override_layer.lock().map_err(|e| e.to_string())?;
    Ok(layer.remove_override(sid, cid))
}

/// Accept the upstream value for a conflicted cell (discards the override).
#[tauri::command]
pub fn calp_accept_upstream(
    state: State<AppState>,
    sheet_id: String,
    cell_id: String,
) -> Result<bool, String> {
    let sid = SheetId::parse(&sheet_id)
        .ok_or_else(|| format!("Invalid sheet_id: {}", sheet_id))?;
    let cid = CellId::parse(&cell_id)
        .ok_or_else(|| format!("Invalid cell_id: {}", cell_id))?;
    let mut layer = state.override_layer.lock().map_err(|e| e.to_string())?;
    Ok(layer.accept_upstream(sid, cid))
}

/// Keep the consumer's override for a conflicted cell (rebases onto new upstream baseline).
#[tauri::command]
pub fn calp_keep_override(
    state: State<AppState>,
    sheet_id: String,
    cell_id: String,
) -> Result<bool, String> {
    let sid = SheetId::parse(&sheet_id)
        .ok_or_else(|| format!("Invalid sheet_id: {}", sheet_id))?;
    let cid = CellId::parse(&cell_id)
        .ok_or_else(|| format!("Invalid cell_id: {}", cell_id))?;
    let mut layer = state.override_layer.lock().map_err(|e| e.to_string())?;
    Ok(layer.keep_override(sid, cid))
}

/// Export the current override layer as a portable OverridePatch for the given package.
#[tauri::command]
pub fn calp_export_overrides(
    state: State<AppState>,
    package_name: String,
) -> Result<calp::OverridePatch, String> {
    let layer = state.override_layer.lock().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    // Determine baseline version from subscription manifest (first match wins).
    let baseline_version = {
        let subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
        subs.subscriptions.iter()
            .find(|s| s.package_name == package_name)
            .map(|s| s.resolved_version.clone())
            .unwrap_or_else(|| "0.0.0".to_string())
    };
    let patch = calp::OverridePatch::from_layer(&layer, &package_name, &baseline_version, &now);
    Ok(patch)
}

/// Import (merge) an OverridePatch JSON string into the current override layer.
/// Returns the number of overrides imported.
#[tauri::command]
pub fn calp_import_overrides(
    state: State<AppState>,
    patch_json: String,
) -> Result<usize, String> {
    let patch: calp::OverridePatch =
        serde_json::from_str(&patch_json).map_err(|e| e.to_string())?;
    let count = patch.overrides.len();
    let mut layer = state.override_layer.lock().map_err(|e| e.to_string())?;
    patch.apply_to(&mut layer);
    Ok(count)
}

/// Compute a preview of what a refresh would change, without applying anything.
#[tauri::command]
pub fn calp_refresh_preview(
    state: State<AppState>,
    registry_path: String,
) -> Result<calp::refresh::RefreshPreview, String> {
    let registry = LocalRegistry::open(std::path::Path::new(&registry_path))
        .map_err(|e| e.to_string())?;

    let subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
    let layer = state.override_layer.lock().map_err(|e| e.to_string())?;

    calp::refresh::compute_preview(&registry, &subs.subscriptions, &layer)
        .map_err(|e| e.to_string())
}

/// Apply the refresh after the user has confirmed the preview.
/// Pulls new versions for all subscriptions that have updates and materializes
/// new/updated sheets into the workbook grids.
#[tauri::command]
pub fn calp_refresh_apply(
    state: State<AppState>,
    registry_path: String,
) -> Result<calp::refresh::RefreshResult, String> {
    let registry = LocalRegistry::open(std::path::Path::new(&registry_path))
        .map_err(|e| e.to_string())?;

    let now = chrono::Utc::now().to_rfc3339();

    // Pull new versions for all subscriptions that have updates.
    let payloads = {
        let subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
        calp::refresh::pull_all_updates(&registry, &subs.subscriptions)
            .map_err(|e| e.to_string())?
    };

    // Materialize new/updated sheets into grids.
    {
        let mut grids = state.grids.lock().map_err(|e| e.to_string())?;
        let mut sheet_names = state.sheet_names.lock().map_err(|e| e.to_string())?;
        let mut sheet_ids = state.sheet_ids.lock().map_err(|e| e.to_string())?;
        let mut shared_styles = state.style_registry.lock().map_err(|e| e.to_string())?;
        let mut all_cw = state.all_column_widths.lock().map_err(|e| e.to_string())?;
        let mut all_rh = state.all_row_heights.lock().map_err(|e| e.to_string())?;
        let subs = state.subscriptions.lock().map_err(|e| e.to_string())?;

        for payload in &payloads {
            let sub = &subs.subscriptions[payload.subscription_index];

            // Collect package_sheet_ids already tracked in this subscription so
            // we can distinguish new sheets from updated ones.
            let old_package_ids: Vec<_> = sub.sheets.iter()
                .map(|s| s.package_sheet_id)
                .collect();

            for pulled in &payload.pull_result.sheets {
                let (mut grid, local_styles) = pulled.sheet.to_grid();

                // Remap local style indices to the shared registry.
                let local_all = local_styles.all_styles();
                let mut remap: Vec<usize> = Vec::with_capacity(local_all.len());
                for style in local_all {
                    remap.push(shared_styles.get_or_create(style.clone()));
                }
                for (_key, cell) in grid.cells.iter_mut() {
                    if cell.style_index < remap.len() {
                        cell.style_index = remap[cell.style_index];
                    }
                }

                if old_package_ids.contains(&pulled.package_sheet_id) {
                    // Updated sheet — replace the existing grid in-place.
                    if let Some(pos) = sub.sheets.iter()
                        .position(|s| s.package_sheet_id == pulled.package_sheet_id)
                    {
                        // The local sheet index in the workbook equals the
                        // position of the subscribed sheet in the global sheet list.
                        // We track it via the local_sheet_id stored at subscription time.
                        let local_sid = sub.sheets[pos].local_sheet_id;
                        if let Some(grid_idx) = sheet_ids.iter().position(|id| *id == local_sid) {
                            grids[grid_idx] = grid;
                            all_cw[grid_idx] = pulled.sheet.column_widths.clone();
                            all_rh[grid_idx] = pulled.sheet.row_heights.clone();
                        }
                    }
                } else {
                    // New sheet — append to the workbook.
                    grids.push(grid);
                    sheet_names.push(pulled.name.clone());
                    sheet_ids.push(pulled.sheet.id);
                    all_cw.push(pulled.sheet.column_widths.clone());
                    all_rh.push(pulled.sheet.row_heights.clone());
                }
            }
        }
    }

    // Apply refresh: update subscription metadata and rebase overrides.
    let mut subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
    let mut layer = state.override_layer.lock().map_err(|e| e.to_string())?;

    let result = calp::refresh::apply_refresh(
        payloads,
        &mut subs.subscriptions,
        &mut layer,
        &now,
    );

    Ok(result)
}

/// Strip all subscriptions and overrides, converting the workbook to a
/// standalone (detached) document.
#[tauri::command]
pub fn calp_detach(state: State<AppState>) -> Result<(), String> {
    let mut subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
    let mut layer = state.override_layer.lock().map_err(|e| e.to_string())?;

    calp::refresh::detach(&mut subs.subscriptions, &mut layer);

    Ok(())
}
