//! FILENAME: app/src-tauri/src/calp_commands.rs
//! PURPOSE: Tauri commands for .calp package operations (publish, pull, etc.).

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::AppState;
use crate::bi::types::BiState;

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
    pub scripts_published: usize,
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
    pub scripts_pulled: usize,
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
    bi_state: State<BiState>,
    params: PublishParams,
) -> Result<PublishResponse, String> {
    let registry = LocalRegistry::open(std::path::Path::new(&params.registry_path))
        .map_err(|e| e.to_string())?;

    let version = SemVer::parse(&params.version)
        .map_err(|e| e.to_string())?;

    let now = chrono::Utc::now().to_rfc3339();

    // Build a lightweight workbook snapshot for publishing
    let workbook = crate::persistence::build_workbook_snapshot(&state)?;

    // Include any author-designated writeback regions in the publish
    let writeback_regions = {
        let drafts = state.writeback_draft_regions.lock().map_err(|e| e.to_string())?;
        if drafts.is_empty() { None } else { Some(drafts.clone()) }
    };

    // Include object scripts in the publish
    let object_scripts = {
        let scripts = state.object_scripts.lock().map_err(|e| e.to_string())?;
        if scripts.is_empty() { None } else { Some(scripts.clone()) }
    };

    // Capture active BI connections as data sources
    let data_sources = capture_bi_data_sources(&state, &bi_state)?;

    let request = calp::publish::PublishRequest {
        workbook: &workbook,
        package_name: params.package_name,
        version,
        kind: params.kind,
        sheet_indices: params.sheet_indices,
        now,
        published_by: params.published_by,
        writeback_regions,
        object_scripts,
        data_sources,
    };

    let result = calp::publish::publish(&registry, &request)
        .map_err(|e| e.to_string())?;

    Ok(PublishResponse {
        package_name: result.package_name,
        version: result.version,
        sheets_published: result.sheets_published,
        tables_published: result.tables_published,
        named_ranges_published: result.named_ranges_published,
        scripts_published: result.scripts_published,
    })
}

/// Pull (subscribe to) a package.
#[tauri::command]
pub fn calp_pull(
    state: State<AppState>,
    pivot_state: State<'_, crate::pivot::types::PivotState>,
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

    // Materialize pulled object scripts (forced to restricted mode by the calp layer)
    let scripts_pulled = result.object_scripts.len();
    if !result.object_scripts.is_empty() {
        let mut scripts = state.object_scripts.lock().map_err(|e| e.to_string())?;
        for script in result.object_scripts {
            // Don't overwrite existing scripts with the same ID (subscriber may have modified)
            if !scripts.iter().any(|s| s.id == script.id) {
                scripts.push(script);
            }
        }
    }

    // Rebuild writeback index from updated subscriptions
    rebuild_writeback_index(&state, Some(&params.registry_path));

    // Restore pivot definitions from the package and render to grid.
    // The source_sheet_index in each definition is relative to the publisher's
    // workbook. We need to offset it by the number of sheets that existed
    // before the pull (since pulled sheets are appended).
    if !result.pivot_definitions.is_empty() {
        let sheet_offset = {
            let names = state.sheet_names.lock().map_err(|e| e.to_string())?;
            names.len() - sheets_pulled
        };
        restore_pulled_pivots(&result.pivot_definitions, &state, &pivot_state, sheet_offset);
    }

    Ok(PullResponse {
        package_name: result.package_name,
        resolved_version: result.resolved_version.to_string(),
        sheets_pulled,
        tables_pulled: result.tables.len(),
        scripts_pulled,
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
    let mut patch: calp::OverridePatch =
        serde_json::from_str(&patch_json).map_err(|e| e.to_string())?;

    // Filter out overrides targeting writeback cells — overrides on writeback
    // cells are not allowed (writeback cells use the writeback layer instead).
    {
        let wb_index = state.writeback_index.lock().map_err(|e| e.to_string())?;
        if !wb_index.is_empty() {
            let before = patch.overrides.len();
            patch.overrides.retain(|ovr| {
                !wb_index.contains(ovr.sheet_id, ovr.position.0, ovr.position.1)
            });
            let skipped = before - patch.overrides.len();
            if skipped > 0 {
                crate::log_info!("CALP", "Skipped {} overrides targeting writeback cells", skipped);
            }
        }
    }

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

    // Rebuild writeback index from updated subscriptions
    drop(subs);
    drop(layer);
    rebuild_writeback_index(&state, Some(&registry_path));

    // Handle writeback region changes: invalidate drafts for removed/incompatible regions
    {
        let old_decls = state.writeback_declarations.lock()
            .map(|d| d.clone()).unwrap_or_default();

        // Reload new declarations (rebuild_writeback_index just updated them)
        let new_decls = state.writeback_declarations.lock()
            .map(|d| d.clone()).unwrap_or_default();

        if !old_decls.is_empty() || !new_decls.is_empty() {
            let compat = calp::writeback::check_region_compatibility(&old_decls, &new_decls);

            // Remove drafts for removed or incompatible regions
            let invalidated_ids: std::collections::HashSet<&str> = compat.removed.iter()
                .chain(compat.incompatible.iter().map(|(id, _)| id))
                .map(|s| s.as_str())
                .collect();

            if !invalidated_ids.is_empty() {
                if let Ok(mut wb_layer) = state.writeback_layer.lock() {
                    let before = wb_layer.draft_count();
                    wb_layer.drafts.retain(|d| !invalidated_ids.contains(d.region_id.as_str()));
                    let removed = before - wb_layer.draft_count();
                    if removed > 0 {
                        crate::log_info!("CALP", "Refresh invalidated {} writeback drafts for removed/incompatible regions", removed);
                    }
                }
            }
        }
    }

    Ok(result)
}

/// Strip all subscriptions and overrides, converting the workbook to a
/// standalone (detached) document.
#[tauri::command]
pub fn calp_detach(state: State<AppState>) -> Result<(), String> {
    let mut subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
    let mut layer = state.override_layer.lock().map_err(|e| e.to_string())?;

    calp::refresh::detach(&mut subs.subscriptions, &mut layer);

    // Clear writeback index (no subscriptions remain)
    drop(subs);
    drop(layer);
    if let Ok(mut idx) = state.writeback_index.lock() {
        *idx = calp::WritebackIndex::default();
    }

    Ok(())
}

// ============================================================================
// Phase 6: Author Workflow Commands
// ============================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevSubscribeParams {
    /// Local .cala file path to subscribe to in dev mode.
    pub source_path: String,
    /// Sheet names to pull; empty means all sheets.
    pub sheet_names: Vec<String>,
}

/// Subscribe to a local .cala file in dev mode.
/// Materialize the sheets into the workbook exactly like `calp_pull`.
#[tauri::command]
pub fn calp_dev_subscribe(
    state: State<AppState>,
    params: DevSubscribeParams,
) -> Result<PullResponse, String> {
    let source = std::path::Path::new(&params.source_path);
    let now = chrono::Utc::now().to_rfc3339();

    let result = calp::dev_mode::pull_dev(source, &params.sheet_names)
        .map_err(|e| e.to_string())?;

    let sheets_pulled = result.sheets.len();
    let tables_pulled = result.tables.len();

    // Resolve the package name from the subscription that will be created.
    let package_name = format!("dev:{}", params.source_path);

    // Materialize pulled sheets into the workbook.
    {
        let mut grids = state.grids.lock().map_err(|e| e.to_string())?;
        let mut sheet_names = state.sheet_names.lock().map_err(|e| e.to_string())?;
        let mut sheet_ids = state.sheet_ids.lock().map_err(|e| e.to_string())?;
        let mut shared_styles = state.style_registry.lock().map_err(|e| e.to_string())?;
        let mut all_cw = state.all_column_widths.lock().map_err(|e| e.to_string())?;
        let mut all_rh = state.all_row_heights.lock().map_err(|e| e.to_string())?;

        for pulled in &result.sheets {
            let (mut grid, local_styles) = pulled.sheet.to_grid();

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

    // Store the dev subscription.
    {
        let subscription = calp::dev_mode::make_dev_subscription(
            &params.source_path,
            &result,
            &now,
        );
        let mut subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
        subs.subscriptions.push(subscription);
    }

    Ok(PullResponse {
        package_name,
        resolved_version: "dev".to_string(),
        sheets_pulled,
        tables_pulled,
        scripts_pulled: 0,
    })
}

/// Re-pull from the dev source, refreshing HEAD sheets in the workbook.
#[tauri::command]
pub fn calp_dev_refresh(state: State<AppState>) -> Result<PullResponse, String> {
    // Find the dev subscription.
    let (source_path, sub_index) = {
        let subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
        let idx = subs.subscriptions.iter().position(calp::dev_mode::is_dev_subscription)
            .ok_or_else(|| "No dev subscription found in current workbook".to_string())?;
        // registry_url is "file://<path>"; strip the prefix to get the raw path.
        let url = &subs.subscriptions[idx].registry_url;
        let path = url.strip_prefix("file://").unwrap_or(url).to_string();
        (path, idx)
    };

    let now = chrono::Utc::now().to_rfc3339();
    let source = std::path::Path::new(&source_path);

    // Determine which sheet names were originally requested (empty = all).
    let sheet_names: Vec<String> = {
        let subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
        subs.subscriptions[sub_index].sheets.iter()
            .map(|s| s.local_name.clone())
            .collect()
    };

    let result = calp::dev_mode::pull_dev(source, &sheet_names)
        .map_err(|e| e.to_string())?;

    let sheets_pulled = result.sheets.len();
    let tables_pulled = result.tables.len();
    let package_name = format!("dev:{}", source_path);

    // Replace sheets already tracked by this subscription; append any new ones.
    {
        let mut grids = state.grids.lock().map_err(|e| e.to_string())?;
        let mut sheet_names_state = state.sheet_names.lock().map_err(|e| e.to_string())?;
        let mut sheet_ids = state.sheet_ids.lock().map_err(|e| e.to_string())?;
        let mut shared_styles = state.style_registry.lock().map_err(|e| e.to_string())?;
        let mut all_cw = state.all_column_widths.lock().map_err(|e| e.to_string())?;
        let mut all_rh = state.all_row_heights.lock().map_err(|e| e.to_string())?;
        let subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
        let sub = &subs.subscriptions[sub_index];

        let old_sheet_ids: Vec<_> = sub.sheets.iter()
            .map(|s| s.local_sheet_id)
            .collect();

        for (i, pulled) in result.sheets.iter().enumerate() {
            let (mut grid, local_styles) = pulled.sheet.to_grid();

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

            if let Some(local_sid) = old_sheet_ids.get(i).copied() {
                // Replace the existing grid in-place.
                if let Some(grid_idx) = sheet_ids.iter().position(|id| *id == local_sid) {
                    grids[grid_idx] = grid;
                    all_cw[grid_idx] = pulled.sheet.column_widths.clone();
                    all_rh[grid_idx] = pulled.sheet.row_heights.clone();
                }
            } else {
                // New sheet added since last pull — append.
                grids.push(grid);
                sheet_names_state.push(pulled.name.clone());
                sheet_ids.push(pulled.sheet.id);
                all_cw.push(pulled.sheet.column_widths.clone());
                all_rh.push(pulled.sheet.row_heights.clone());
            }
        }
    }

    // Update the subscription timestamp.
    {
        let mut subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
        subs.subscriptions[sub_index].resolved_at = now;
    }

    Ok(PullResponse {
        package_name,
        resolved_version: "dev".to_string(),
        sheets_pulled,
        tables_pulled,
        scripts_pulled: 0,
    })
}

/// Rename a stable CellId (author-facing operation).
#[tauri::command]
pub fn calp_rename_cell_id(
    state: State<AppState>,
    sheet_id: String,
    old_cell_id: String,
    new_cell_id: String,
) -> Result<bool, String> {
    let sid = SheetId::parse(&sheet_id)
        .ok_or_else(|| format!("Invalid sheet_id: {}", sheet_id))?;
    let old = CellId::parse(&old_cell_id)
        .ok_or_else(|| format!("Invalid old_cell_id: {}", old_cell_id))?;
    let new = CellId::parse(&new_cell_id)
        .ok_or_else(|| format!("Invalid new_cell_id: {}", new_cell_id))?;
    let mut reg = state.id_registry.lock().map_err(|e| e.to_string())?;
    Ok(reg.rename_cell(sid, old, new))
}

/// Merge two stable CellIds (author-facing operation).
#[tauri::command]
pub fn calp_merge_cell_ids(
    state: State<AppState>,
    sheet_id: String,
    survivor_cell_id: String,
    absorbed_cell_id: String,
) -> Result<bool, String> {
    let sid = SheetId::parse(&sheet_id)
        .ok_or_else(|| format!("Invalid sheet_id: {}", sheet_id))?;
    let survivor = CellId::parse(&survivor_cell_id)
        .ok_or_else(|| format!("Invalid survivor_cell_id: {}", survivor_cell_id))?;
    let absorbed = CellId::parse(&absorbed_cell_id)
        .ok_or_else(|| format!("Invalid absorbed_cell_id: {}", absorbed_cell_id))?;
    let mut reg = state.id_registry.lock().map_err(|e| e.to_string())?;
    Ok(reg.merge_cells(sid, survivor, absorbed))
}

// ============================================================================
// Phase 7: Audit Log Commands
// ============================================================================

/// Return the full audit log for the current workbook.
#[tauri::command]
pub fn calp_get_audit_log(
    state: State<AppState>,
) -> Result<calp::audit::AuditLog, String> {
    let log = state.audit_log.lock().map_err(|e| e.to_string())?;
    Ok(log.clone())
}

/// Enable or disable audit logging and set the maximum number of entries.
/// Pass `max_entries = 0` for unlimited.
#[tauri::command]
pub fn calp_set_audit_enabled(
    state: State<AppState>,
    enabled: bool,
    max_entries: usize,
) -> Result<(), String> {
    let mut log = state.audit_log.lock().map_err(|e| e.to_string())?;
    log.enabled = enabled;
    log.max_entries = max_entries;
    Ok(())
}

/// Discard all audit log entries.
#[tauri::command]
pub fn calp_clear_audit_log(
    state: State<AppState>,
) -> Result<(), String> {
    let mut log = state.audit_log.lock().map_err(|e| e.to_string())?;
    log.clear();
    Ok(())
}

// ============================================================================
// Phase 9: Writeback Readiness
// ============================================================================

/// Return the flat list of writeback regions for frontend guard evaluation.
#[tauri::command]
pub fn calp_get_writeback_regions(
    state: State<AppState>,
) -> Result<Vec<calp::WritebackRegionEntry>, String> {
    let index = state.writeback_index.lock().map_err(|e| e.to_string())?;
    let sheet_ids = state.sheet_ids.lock().map_err(|e| e.to_string())?;
    let id_to_index: std::collections::HashMap<identity::SheetId, usize> = sheet_ids
        .iter()
        .enumerate()
        .map(|(i, &sid)| (sid, i))
        .collect();
    Ok(index.to_flat_list(&id_to_index))
}

/// Rebuild the writeback index from the version manifests of all active subscriptions.
/// Called internally after pull, refresh, and detach.
fn rebuild_writeback_index(state: &AppState, registry_path: Option<&str>) {
    let subs = match state.subscriptions.lock() {
        Ok(s) => s,
        Err(_) => return,
    };

    let mut all_decls = Vec::new();

    if let Some(path) = registry_path {
        if let Ok(registry) = calp::registry::LocalRegistry::open(std::path::Path::new(path)) {
            for sub in &subs.subscriptions {
                // Skip dev and file-channel subscriptions (no writeback in those)
                if sub.version_pin == "dev" || sub.version_pin.starts_with("channel:") {
                    continue;
                }
                if let Ok(ver_manifest) = registry.get_version_manifest(
                    &sub.package_name, &sub.resolved_version,
                ) {
                    if let Some(ref wb_regions) = ver_manifest.writeback_regions {
                        all_decls.extend(wb_regions.iter().cloned());
                    }
                }
            }
        }
    }

    let new_index = match calp::WritebackIndex::from_declarations(&all_decls) {
        Ok(idx) => idx,
        Err(e) => {
            crate::log_warn!("CALP", "Failed to build writeback index: {}", e);
            calp::WritebackIndex::default()
        }
    };

    if let Ok(mut idx) = state.writeback_index.lock() {
        *idx = new_index;
    }

    // Also store the full declarations for schema validation
    if let Ok(mut decls) = state.writeback_declarations.lock() {
        *decls = all_decls;
    }
}

// ============================================================================
// Phase 12: Author UI — Writeback Region Designation
// ============================================================================

/// Get all draft writeback regions for the current workbook.
#[tauri::command]
pub fn calp_get_writeback_draft_regions(
    state: State<AppState>,
) -> Result<Vec<calp::WritebackRegionDeclaration>, String> {
    let drafts = state.writeback_draft_regions.lock().map_err(|e| e.to_string())?;
    Ok(drafts.clone())
}

/// Add a new draft writeback region.
#[tauri::command]
pub fn calp_add_writeback_region(
    state: State<AppState>,
    region: calp::WritebackRegionDeclaration,
) -> Result<(), String> {
    // Validate the region
    let test_decls = vec![region.clone()];
    calp::WritebackIndex::from_declarations(&test_decls)
        .map_err(|e| format!("Invalid region: {}", e))?;

    let mut drafts = state.writeback_draft_regions.lock().map_err(|e| e.to_string())?;

    // Check for ID collision
    if drafts.iter().any(|r| r.id == region.id) {
        return Err(format!("Region with ID '{}' already exists", region.id));
    }

    // Check for overlap with existing draft regions
    let mut all = drafts.clone();
    all.push(region.clone());
    calp::WritebackIndex::from_declarations(&all)
        .map_err(|e| format!("Region overlaps with existing draft: {}", e))?;

    drafts.push(region);
    Ok(())
}

/// Remove a draft writeback region by ID.
#[tauri::command]
pub fn calp_remove_writeback_region(
    state: State<AppState>,
    region_id: String,
) -> Result<bool, String> {
    let mut drafts = state.writeback_draft_regions.lock().map_err(|e| e.to_string())?;
    let len_before = drafts.len();
    drafts.retain(|r| r.id != region_id);
    Ok(drafts.len() < len_before)
}

/// Update an existing draft writeback region (replace by ID).
#[tauri::command]
pub fn calp_update_writeback_region(
    state: State<AppState>,
    region: calp::WritebackRegionDeclaration,
) -> Result<(), String> {
    let mut drafts = state.writeback_draft_regions.lock().map_err(|e| e.to_string())?;

    let pos = drafts.iter().position(|r| r.id == region.id)
        .ok_or_else(|| format!("Region '{}' not found", region.id))?;

    // Validate: build index with the updated region replacing the old one
    let mut test = drafts.clone();
    test[pos] = region.clone();
    calp::WritebackIndex::from_declarations(&test)
        .map_err(|e| format!("Invalid update: {}", e))?;

    drafts[pos] = region;
    Ok(())
}

// ============================================================================
// Phase 14: Writeback Submission
// ============================================================================

/// Save a writeback draft for a cell in a writeback region.
/// Auto-mints a CellId if the cell doesn't have one yet.
#[tauri::command]
pub fn calp_save_writeback_draft(
    state: State<AppState>,
    region_id: String,
    sheet_id: String,
    row: u32,
    col: u32,
    value: calp::writeback::SubmissionValue,
) -> Result<(), String> {
    let sid = SheetId::parse(&sheet_id)
        .ok_or_else(|| format!("Invalid sheet_id: {}", sheet_id))?;

    // Verify the cell is in a writeback region
    {
        let wb_index = state.writeback_index.lock().map_err(|e| e.to_string())?;
        if !wb_index.contains(sid, row, col) {
            return Err(format!("Cell ({}, {}) is not in a writeback region", row, col));
        }
    }

    // Validate value against the region's schema (if one is defined)
    {
        let decls = state.writeback_declarations.lock().map_err(|e| e.to_string())?;
        if let Some(decl) = decls.iter().find(|d| d.id == region_id) {
            if let Some(ref schema) = decl.schema {
                schema.validate(&value).map_err(|msg| {
                    format!("Schema validation failed: {}", msg)
                })?;
            }
        }
    }

    // Get or mint a CellId for this cell
    let cell_id = {
        let mut id_reg = state.id_registry.lock().map_err(|e| e.to_string())?;
        id_reg.cell_id_at(sid, (row, col)).to_string()
    };

    // Get subscriber identity
    let submitter = {
        let cached = state.subscriber_identity.lock().map_err(|e| e.to_string())?;
        match cached.as_ref() {
            Some(id) => id.clone(),
            None => {
                drop(cached);
                let profile_dir = {
                    let local_app_data = std::env::var("LOCALAPPDATA")
                        .unwrap_or_else(|_| ".".to_string());
                    std::path::PathBuf::from(local_app_data).join("Calcula")
                };
                let id = calp::identity_provider::load_or_create(&profile_dir)?;
                let mut cached = state.subscriber_identity.lock().map_err(|e| e.to_string())?;
                *cached = Some(id.clone());
                id
            }
        }
    };

    let now = chrono::Utc::now().to_rfc3339();
    let submission_id = {
        let bytes = identity::generate_uuid_v7();
        format!(
            "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
            bytes[0], bytes[1], bytes[2], bytes[3],
            bytes[4], bytes[5], bytes[6], bytes[7],
            bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15],
        )
    };

    let submission = calp::writeback::WritebackSubmission {
        id: submission_id,
        region_id,
        cell_row: row,
        cell_col: col,
        cell_id: Some(cell_id),
        submitter,
        value,
        state: calp::writeback::SubmissionState::Draft,
        created_at: now.clone(),
        updated_at: now,
        submitted_at: None,
        extra: std::collections::HashMap::new(),
    };

    let mut wb_layer = state.writeback_layer.lock().map_err(|e| e.to_string())?;
    wb_layer.set_draft(submission);

    Ok(())
}

/// Get the writeback layer (all drafts) for the current workbook.
#[tauri::command]
pub fn calp_get_writeback_layer(
    state: State<AppState>,
) -> Result<calp::writeback::WritebackLayer, String> {
    let layer = state.writeback_layer.lock().map_err(|e| e.to_string())?;
    Ok(layer.clone())
}

/// Submit all drafts for a region to the registry.
#[tauri::command]
pub fn calp_submit_region(
    state: State<AppState>,
    region_id: String,
    registry_path: String,
) -> Result<usize, String> {
    let now = chrono::Utc::now().to_rfc3339();

    // Get the resolved version from subscriptions
    let resolved_version = {
        let subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
        subs.subscriptions.first()
            .map(|s| s.resolved_version.clone())
            .ok_or_else(|| "No active subscription".to_string())?
    };

    let package_name = {
        let subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
        subs.subscriptions.first()
            .map(|s| s.package_name.clone())
            .ok_or_else(|| "No active subscription".to_string())?
    };

    // Advance drafts to submitted
    let submitted = {
        let mut wb_layer = state.writeback_layer.lock().map_err(|e| e.to_string())?;
        wb_layer.submit_region(&region_id, &now)
    };

    if submitted.is_empty() {
        return Ok(0);
    }

    // Write to registry
    let registry = calp::registry::LocalRegistry::open(std::path::Path::new(&registry_path))
        .map_err(|e| e.to_string())?;

    for sub in &submitted {
        registry.save_submission(&package_name, &resolved_version, sub)
            .map_err(|e| e.to_string())?;
    }

    let count = submitted.len();

    // Audit log
    {
        let mut audit = state.audit_log.lock().map_err(|e| e.to_string())?;
        let user = state.subscriber_identity.lock()
            .ok()
            .and_then(|id| id.as_ref().map(|i| i.display_name.clone()))
            .unwrap_or_default();
        audit.record(
            calp::audit::AuditEvent::WritebackSubmitted,
            &format!("Submitted {} writeback values for region {}", count, region_id),
            &user,
            &now,
        );
    }

    Ok(count)
}

/// Build a GatherRegionData map from the current subscriptions for formula evaluation.
/// This is the pre-fetch step: load all submission data from the registry once,
/// so GATHER functions can look it up synchronously during evaluation.
pub fn build_gather_data(state: &AppState) -> std::collections::HashMap<String, engine::GatherRegionData> {
    let mut result = std::collections::HashMap::new();

    let subs = match state.subscriptions.lock() {
        Ok(s) => s,
        Err(_) => return result,
    };

    for sub in &subs.subscriptions {
        // Skip dev and file-channel subscriptions
        if sub.version_pin == "dev" || sub.version_pin.starts_with("channel:") {
            continue;
        }

        // Extract registry path from URL
        let registry_path = sub.registry_url
            .strip_prefix("file://")
            .unwrap_or(&sub.registry_url);

        let registry = match calp::registry::LocalRegistry::open(std::path::Path::new(registry_path)) {
            Ok(r) => r,
            Err(_) => continue,
        };

        // Load the version manifest to get writeback regions
        let ver_manifest = match registry.get_version_manifest(&sub.package_name, &sub.resolved_version) {
            Ok(m) => m,
            Err(_) => continue,
        };

        let regions = match &ver_manifest.writeback_regions {
            Some(r) => r,
            None => continue,
        };

        // Load submissions for each region
        for region in regions {
            let submissions = match registry.load_region_submissions(
                &sub.package_name, &sub.resolved_version, &region.id,
            ) {
                Ok(s) => s,
                Err(_) => continue,
            };

            let gather_subs: Vec<engine::GatherSubmission> = submissions.iter().map(|s| {
                engine::GatherSubmission {
                    submitter_name: s.submitter.display_name.clone(),
                    submitter_id: s.submitter.id.clone(),
                    value: match &s.value {
                        calp::writeback::SubmissionValue::Number { value } => engine::EvalResult::Number(*value),
                        calp::writeback::SubmissionValue::Text { value } => engine::EvalResult::Text(value.clone()),
                        calp::writeback::SubmissionValue::Boolean { value } => engine::EvalResult::Boolean(*value),
                        calp::writeback::SubmissionValue::Empty => engine::EvalResult::Number(0.0),
                    },
                }
            }).collect();

            result.insert(region.id.clone(), engine::GatherRegionData { submissions: gather_subs });
        }
    }

    result
}

/// Look up the CellId at a position without minting. Returns null if none exists.
#[tauri::command]
pub fn calp_get_cell_id(
    state: State<AppState>,
    sheet_id: String,
    row: u32,
    col: u32,
) -> Result<Option<String>, String> {
    let sid = SheetId::parse(&sheet_id)
        .ok_or_else(|| format!("Invalid sheet_id: {}", sheet_id))?;
    let reg = state.id_registry.lock().map_err(|e| e.to_string())?;
    Ok(reg.lookup_cell_id(sid, (row, col)).map(|id| id.to_string()))
}

/// Get the current subscriber identity (creates one on first call).
#[tauri::command]
pub fn calp_get_subscriber_identity(
    state: State<AppState>,
) -> Result<calp::SubmitterIdentity, String> {
    let mut cached = state.subscriber_identity.lock().map_err(|e| e.to_string())?;
    if let Some(ref identity) = *cached {
        return Ok(identity.clone());
    }

    // Load or create from the user profile directory
    let profile_dir = {
        let local_app_data = std::env::var("LOCALAPPDATA")
            .unwrap_or_else(|_| ".".to_string());
        std::path::PathBuf::from(local_app_data).join("Calcula")
    };

    let identity = calp::identity_provider::load_or_create(&profile_dir)?;
    *cached = Some(identity.clone());
    Ok(identity)
}

/// Suggest the next version for a package given a bump type ("major", "minor", "patch").
#[tauri::command]
pub fn calp_next_version(
    registry_path: String,
    package_name: String,
    bump: String,
) -> Result<String, String> {
    let registry = LocalRegistry::open(std::path::Path::new(&registry_path))
        .map_err(|e| e.to_string())?;

    let manifest = registry.get_package_manifest(&package_name)
        .map_err(|e| e.to_string())?;

    // Parse all available versions and find the latest.
    let mut versions: Vec<SemVer> = manifest.versions.iter()
        .filter_map(|entry| SemVer::parse(&entry.version).ok())
        .collect();

    let next = if versions.is_empty() {
        // No published versions yet — start at 1.0.0.
        SemVer::new(1, 0, 0)
    } else {
        versions.sort();
        let latest = versions.last().unwrap();
        match bump.to_lowercase().as_str() {
            "major" => SemVer::new(latest.major + 1, 0, 0),
            "minor" => SemVer::new(latest.major, latest.minor + 1, 0),
            "patch" => SemVer::new(latest.major, latest.minor, latest.patch + 1),
            other => return Err(format!(
                "Invalid bump type '{}'. Expected 'major', 'minor', or 'patch'.", other
            )),
        }
    };

    Ok(next.to_string())
}

// ============================================================================
// Pivot Restoration for Pulled Packages
// ============================================================================

/// Restore pivot definitions from a pulled .calp package: deserialize, rebuild
/// cache from source grid data, calculate the view, and write output cells.
fn restore_pulled_pivots(
    pivot_defs: &[persistence::SavedPivotDefinition],
    state: &AppState,
    pivot_state: &crate::pivot::types::PivotState,
    sheet_offset: usize,
) {
    use pivot_engine::{PivotCache, PivotDefinition};
    use crate::pivot::operations::{build_cache_from_grid, safe_calculate_pivot, write_pivot_to_grid};

    let mut pivot_tables = match pivot_state.pivot_tables.lock() {
        Ok(pt) => pt,
        Err(_) => return,
    };

    let mut grids = match state.grids.lock() {
        Ok(g) => g,
        Err(_) => return,
    };

    let sheet_names = match state.sheet_names.lock() {
        Ok(sn) => sn,
        Err(_) => return,
    };

    let mut shared_styles = match state.style_registry.lock() {
        Ok(s) => s,
        Err(_) => return,
    };

    for saved in pivot_defs {
        let def: PivotDefinition = match serde_json::from_value(saved.definition.clone()) {
            Ok(d) => d,
            Err(e) => {
                crate::log_warn!("CALP", "Failed to deserialize pivot definition {}: {}", saved.id, e);
                continue;
            }
        };

        let pivot_id = def.id;

        // Find the source sheet index (adjust for subscriber's existing sheets)
        let source_sheet_idx = saved.source_sheet_index.unwrap_or(0) + sheet_offset;

        // Build cache from source grid data
        let source_grid = match grids.get(source_sheet_idx) {
            Some(g) => g,
            None => {
                crate::log_warn!("CALP", "Source sheet {} not found for pivot {}", source_sheet_idx, pivot_id);
                continue;
            }
        };

        let (mut cache, _field_names) = match build_cache_from_grid(
            source_grid,
            def.source_start,
            def.source_end,
            def.source_has_headers,
        ) {
            Ok(result) => result,
            Err(e) => {
                crate::log_warn!("CALP", "Failed to build cache for pivot {}: {}", pivot_id, e);
                continue;
            }
        };

        // Calculate the pivot view
        let view = safe_calculate_pivot(&def, &mut cache);

        // Find the destination sheet and write pivot output to grid
        let dest_sheet_name = def.destination_sheet.as_deref().unwrap_or("");
        let dest_sheet_idx = sheet_names.iter()
            .position(|n| n == dest_sheet_name)
            .unwrap_or(0);

        if let Some(dest_grid) = grids.get_mut(dest_sheet_idx) {
            let _merged = write_pivot_to_grid(
                dest_grid,
                None, // no active_grid dual-write needed
                &view,
                def.destination,
                &mut shared_styles,
            );
        }

        // Store in PivotState
        pivot_tables.insert(pivot_id, (def, cache));
    }
}

// ============================================================================
// Capture BI Data Sources for Publishing
// ============================================================================

/// Extract active BI connections from BiState as publishable data sources.
/// For each connection that has active queries, captures: model JSON, bindings,
/// queries with grid placements, and server/database (without credentials).
fn capture_bi_data_sources(
    state: &AppState,
    bi_state: &BiState,
) -> Result<Vec<calp::publish::PublishDataSource>, String> {
    let connections = bi_state.connections.lock().map_err(|e| e.to_string())?;
    let sheet_ids = state.sheet_ids.lock().map_err(|e| e.to_string())?;

    let mut data_sources = Vec::new();

    for conn in connections.values() {
        // Only include connections that have active queries (data in the grid)
        if conn.active_queries.is_empty() {
            continue;
        }

        // Get the engine and serialize the model
        let model_json = match &conn.engine {
            Some(engine_arc) => {
                match engine_arc.try_lock() {
                    Ok(engine) => {
                        serde_json::to_value(engine.model())
                            .map_err(|e| format!("Failed to serialize model: {}", e))?
                    }
                    Err(_) => {
                        crate::log_warn!("CALP", "Engine busy for connection {}, skipping", conn.id);
                        continue;
                    }
                }
            }
            None => continue,
        };

        // Parse server and database from connection string (PostgreSQL key=value format)
        let (server, database) = parse_pg_connection_info(&conn.connection_string);

        // Generate a stable ID for this data source
        let ds_id = format!("{:016x}", conn.id);

        // Convert bindings
        let bindings: Vec<calp::PackageBinding> = conn.bindings.iter().map(|b| {
            calp::PackageBinding {
                model_table: b.model_table.clone(),
                schema: b.schema.clone(),
                source_table: b.source_table.clone(),
            }
        }).collect();

        // Convert active queries to package queries
        let queries: Vec<calp::PackageQuery> = conn.active_queries.iter().map(|(entity_id, aq)| {
            let sheet_id = sheet_ids.get(aq.sheet_index)
                .copied()
                .unwrap_or_else(|| identity::SheetId::from_bytes(identity::generate_uuid_v7()));

            calp::PackageQuery {
                id: entity_id.to_string(),
                name: format!("Query {}", entity_id),
                data_source_id: ds_id.clone(),
                request: calp::PackageQueryRequest {
                    measures: aq.request.measures.clone(),
                    group_by: aq.request.group_by.iter().map(|g| {
                        calp::PackageColumnRef {
                            table: g.table.clone(),
                            column: g.column.clone(),
                        }
                    }).collect(),
                    filters: aq.request.filters.iter().map(|f| {
                        calp::PackageFilter {
                            table: f.table.clone(),
                            column: f.column.clone(),
                            operator: f.operator.clone(),
                            value: f.value.clone(),
                        }
                    }).collect(),
                },
                placement: calp::QueryPlacement {
                    sheet_id,
                    start_row: aq.start_row,
                    start_col: aq.start_col,
                    include_headers: true,
                },
                extra: std::collections::HashMap::new(),
            }
        }).collect();

        data_sources.push(calp::publish::PublishDataSource {
            id: ds_id,
            name: conn.name.clone(),
            connection_type: conn.connection_type.as_str().to_string(),
            server,
            database,
            model_json,
            bindings,
            queries,
        });
    }

    Ok(data_sources)
}

/// Parse server (host) and database (dbname) from a PostgreSQL connection string.
/// Strips credentials — only returns the non-sensitive parts.
fn parse_pg_connection_info(connection_string: &str) -> (String, String) {
    let mut server = String::new();
    let mut database = String::new();

    for part in connection_string.split_whitespace() {
        if let Some((key, value)) = part.split_once('=') {
            match key.to_lowercase().as_str() {
                "host" | "server" => server = value.to_string(),
                "dbname" | "database" => database = value.to_string(),
                "port" => {
                    if !server.is_empty() && !value.is_empty() && value != "5432" {
                        server = format!("{}:{}", server, value);
                    }
                }
                _ => {} // Skip user, password, sslmode, etc.
            }
        }
    }

    (server, database)
}

// ============================================================================
// Phase: Live Data Sources — Refresh & Connection Configuration
// ============================================================================

/// Response from a data refresh operation.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataRefreshResponse {
    pub sources_refreshed: usize,
    pub queries_executed: usize,
    pub cells_updated: usize,
    /// Data sources that could not auto-connect (need manual configuration).
    pub needs_configuration: Vec<DataSourceNeedsConfig>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSourceNeedsConfig {
    pub data_source_id: String,
    pub name: String,
    pub server: String,
    pub database: String,
    pub connection_type: String,
}

/// Refresh all data sources for the current workbook's subscriptions.
///
/// For each data source:
/// 1. Check subscriber's saved connection config
/// 2. If none, try building SSPI connection string and testing it
/// 3. If connection works: load model, bind tables, execute queries, write cells
/// 4. If connection fails: add to needs_configuration list
#[tauri::command]
pub async fn calp_refresh_data(
    state: State<'_, AppState>,
    bi_state: State<'_, BiState>,
) -> Result<DataRefreshResponse, String> {
    use calp::data_refresh;

    let mut sources_refreshed = 0usize;
    let mut queries_executed = 0usize;
    let mut cells_updated = 0usize;
    let mut needs_config = Vec::new();

    // Collect data sources from all subscriptions
    let subscription_data: Vec<(
        calp::PackageDataSource,
        std::path::PathBuf,
        Option<String>, // saved connection string
    )> = {
        let subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
        let mut result = Vec::new();

        for sub in &subs.subscriptions {
            // Skip dev and file-channel subscriptions
            if sub.version_pin == "dev" || sub.version_pin.starts_with("channel:") {
                continue;
            }

            let registry_path = sub.registry_url
                .strip_prefix("file://")
                .unwrap_or(&sub.registry_url);

            let registry = match calp::LocalRegistry::open(std::path::Path::new(registry_path)) {
                Ok(r) => r,
                Err(_) => continue,
            };

            let ver_manifest = match registry.get_version_manifest(&sub.package_name, &sub.resolved_version) {
                Ok(m) => m,
                Err(_) => continue,
            };

            for ds in &ver_manifest.data_sources {
                let ver_dir = std::path::Path::new(registry_path)
                    .join(&sub.package_name)
                    .join(&sub.resolved_version);
                let model_path = ver_dir.join(&ds.model_path);

                let saved_conn = sub.data_source_configs.iter()
                    .find(|c| c.data_source_id == ds.id)
                    .map(|c| c.connection_string.clone());

                result.push((ds.clone(), model_path, saved_conn));
            }
        }

        result
    };

    if subscription_data.is_empty() {
        return Ok(DataRefreshResponse {
            sources_refreshed: 0,
            queries_executed: 0,
            cells_updated: 0,
            needs_configuration: Vec::new(),
        });
    }

    for (ds, model_path, saved_conn) in &subscription_data {
        // Determine connection string
        let connection_string = if let Some(saved) = saved_conn {
            saved.clone()
        } else {
            // Try SSPI
            data_refresh::build_sspi_connection_string(&ds.server, &ds.database)
        };

        // Load model
        let model_json = match data_refresh::read_model_json(&model_path) {
            Ok(json) => json,
            Err(e) => {
                crate::log_warn!("CALP", "Failed to read model for data source {}: {}", ds.id, e);
                continue;
            }
        };

        // Detect ModelBundle format
        let actual_model_json = if model_json.get("formatVersion").is_some() {
            model_json.get("model")
                .ok_or_else(|| format!("ModelBundle missing 'model' field for {}", ds.id))?
                .clone()
        } else {
            model_json
        };

        let model: bi_engine::DataModel = serde_json::from_value(actual_model_json)
            .map_err(|e| format!("Failed to parse model for {}: {}", ds.id, e))?;

        // Create a temporary engine for this refresh
        let mut engine = bi_engine::Engine::new(model);
        engine.set_auto_tier_config(bi_engine::AutoTierConfig {
            enabled: true,
            max_rows: 100_000,
            default_ttl_secs: 3600,
        });

        // Try to connect to the database
        let config = bi_engine::PostgresConfig::new(&connection_string);
        let connector_idx = match engine.add_postgres(config).await {
            Ok(idx) => idx,
            Err(_e) => {
                // Connection failed — if this was a saved config, it's stale;
                // if SSPI, the user likely needs to configure manually.
                if saved_conn.is_none() {
                    needs_config.push(DataSourceNeedsConfig {
                        data_source_id: ds.id.clone(),
                        name: ds.name.clone(),
                        server: ds.server.clone(),
                        database: ds.database.clone(),
                        connection_type: ds.connection_type.clone(),
                    });
                } else {
                    needs_config.push(DataSourceNeedsConfig {
                        data_source_id: ds.id.clone(),
                        name: ds.name.clone(),
                        server: ds.server.clone(),
                        database: ds.database.clone(),
                        connection_type: ds.connection_type.clone(),
                    });
                }
                continue;
            }
        };

        // Bind tables
        for binding in &ds.bindings {
            let source_binding = bi_engine::SourceBinding::new(&binding.schema, &binding.source_table);
            engine.bind_table(&binding.model_table, connector_idx, source_binding);
        }

        // Execute queries and write results to grid
        for query in &ds.queries {
            // Build engine query request from package query
            let query_request = bi_engine::QueryRequest {
                measures: query.request.measures.clone(),
                group_by: query.request.group_by.iter()
                    .map(|g| bi_engine::ColumnRef::new(&g.table, &g.column))
                    .collect(),
                filters: query.request.filters.iter()
                    .map(|f| bi_engine::FilterCondition {
                        column: f.column.clone(),
                        operator: match f.operator.as_str() {
                            "=" | "eq" => bi_engine::FilterOperator::Equal,
                            "!=" | "ne" => bi_engine::FilterOperator::NotEqual,
                            ">" | "gt" => bi_engine::FilterOperator::GreaterThan,
                            "<" | "lt" => bi_engine::FilterOperator::LessThan,
                            ">=" | "gte" => bi_engine::FilterOperator::GreaterThanOrEqual,
                            "<=" | "lte" => bi_engine::FilterOperator::LessThanOrEqual,
                            _ => bi_engine::FilterOperator::Equal,
                        },
                        value: f.value.clone(),
                    })
                    .collect(),
                lookups: vec![],
            };

            let (batches, _refreshed) = match engine.query_auto_refresh(query_request).await {
                Ok(result) => result,
                Err(e) => {
                    crate::log_warn!("CALP", "Query {} failed: {}", query.id, e);
                    continue;
                }
            };

            // Convert to result
            let result = crate::bi::commands::batches_to_result(&batches);

            // Find the sheet index for this query's placement
            let sheet_ids = state.sheet_ids.lock().map_err(|e| e.to_string())?;
            let sheet_index = sheet_ids.iter()
                .position(|sid| *sid == query.placement.sheet_id);

            let sheet_index = match sheet_index {
                Some(idx) => idx,
                None => {
                    crate::log_warn!("CALP", "Sheet not found for query {} placement", query.id);
                    continue;
                }
            };

            // Write cells to grid
            let start_row = query.placement.start_row;
            let start_col = query.placement.start_col;
            let header_offset = if query.placement.include_headers { 1u32 } else { 0u32 };

            {
                let mut grids = state.grids.lock().map_err(|e| e.to_string())?;
                let grid = grids.get_mut(sheet_index)
                    .ok_or_else(|| format!("Sheet index {} out of range", sheet_index))?;

                if query.placement.include_headers {
                    let bold_style_idx = {
                        let mut styles = state.style_registry.lock().map_err(|e| e.to_string())?;
                        styles.get_or_create(engine::CellStyle::new().with_bold(true))
                    };
                    for (col_idx, col_name) in result.columns.iter().enumerate() {
                        let mut cell = engine::Cell::new_text(col_name.clone());
                        cell.style_index = bold_style_idx;
                        grid.set_cell(start_row, start_col + col_idx as u32, cell);
                    }
                }

                for (row_idx, row) in result.rows.iter().enumerate() {
                    let grid_row = start_row + header_offset + row_idx as u32;
                    for (col_idx, value) in row.iter().enumerate() {
                        let grid_col = start_col + col_idx as u32;
                        let cell = match value {
                            Some(s) => {
                                if let Ok(num) = s.parse::<f64>() {
                                    engine::Cell::new_number(num)
                                } else {
                                    engine::Cell::new_text(s.clone())
                                }
                            }
                            None => engine::Cell::new(),
                        };
                        grid.set_cell(grid_row, grid_col, cell);
                        cells_updated += 1;
                    }
                }
            }

            queries_executed += 1;
        }

        sources_refreshed += 1;
    }

    Ok(DataRefreshResponse {
        sources_refreshed,
        queries_executed,
        cells_updated,
        needs_configuration: needs_config,
    })
}

/// Save a subscriber's connection configuration for a specific data source.
/// Called after the user enters credentials in the ConnectionDialog.
#[tauri::command]
pub fn calp_save_data_source_config(
    state: State<AppState>,
    data_source_id: String,
    connection_string: String,
) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    let mut subs = state.subscriptions.lock().map_err(|e| e.to_string())?;

    for sub in &mut subs.subscriptions {
        // Find any subscription that references this data source
        let registry_path = sub.registry_url
            .strip_prefix("file://")
            .unwrap_or(&sub.registry_url);

        let registry = match calp::LocalRegistry::open(std::path::Path::new(registry_path)) {
            Ok(r) => r,
            Err(_) => continue,
        };

        let ver_manifest = match registry.get_version_manifest(&sub.package_name, &sub.resolved_version) {
            Ok(m) => m,
            Err(_) => continue,
        };

        if ver_manifest.data_sources.iter().any(|ds| ds.id == data_source_id) {
            // Update or add the config
            if let Some(existing) = sub.data_source_configs.iter_mut()
                .find(|c| c.data_source_id == data_source_id)
            {
                existing.connection_string = connection_string.clone();
                existing.last_connected = Some(now.clone());
            } else {
                sub.data_source_configs.push(calp::SubscriberDataSourceConfig {
                    data_source_id: data_source_id.clone(),
                    connection_string: connection_string.clone(),
                    last_connected: Some(now.clone()),
                });
            }
            return Ok(());
        }
    }

    Err(format!("No subscription found with data source {}", data_source_id))
}

/// Get the list of data sources for the current workbook's subscriptions.
/// Returns data source metadata so the frontend can show connection status.
#[tauri::command]
pub fn calp_get_data_sources(
    state: State<AppState>,
) -> Result<Vec<DataSourceInfo>, String> {
    let subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
    let mut result = Vec::new();

    for sub in &subs.subscriptions {
        if sub.version_pin == "dev" || sub.version_pin.starts_with("channel:") {
            continue;
        }

        let registry_path = sub.registry_url
            .strip_prefix("file://")
            .unwrap_or(&sub.registry_url);

        let registry = match calp::LocalRegistry::open(std::path::Path::new(registry_path)) {
            Ok(r) => r,
            Err(_) => continue,
        };

        let ver_manifest = match registry.get_version_manifest(&sub.package_name, &sub.resolved_version) {
            Ok(m) => m,
            Err(_) => continue,
        };

        for ds in &ver_manifest.data_sources {
            let is_configured = sub.data_source_configs.iter()
                .any(|c| c.data_source_id == ds.id && !c.connection_string.is_empty());

            result.push(DataSourceInfo {
                id: ds.id.clone(),
                name: ds.name.clone(),
                connection_type: ds.connection_type.clone(),
                server: ds.server.clone(),
                database: ds.database.clone(),
                query_count: ds.queries.len(),
                is_configured,
                package_name: sub.package_name.clone(),
            });
        }
    }

    Ok(result)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSourceInfo {
    pub id: String,
    pub name: String,
    pub connection_type: String,
    pub server: String,
    pub database: String,
    pub query_count: usize,
    pub is_configured: bool,
    pub package_name: String,
}
