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

    // Include any author-designated writeback regions in the publish
    let writeback_regions = {
        let drafts = state.writeback_draft_regions.lock().map_err(|e| e.to_string())?;
        if drafts.is_empty() { None } else { Some(drafts.clone()) }
    };

    let request = calp::publish::PublishRequest {
        workbook: &workbook,
        package_name: params.package_name,
        version,
        kind: params.kind,
        sheet_indices: params.sheet_indices,
        now,
        published_by: params.published_by,
        writeback_regions,
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

    // Rebuild writeback index from updated subscriptions
    rebuild_writeback_index(&state, Some(&params.registry_path));

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

    // Rebuild writeback index from updated subscriptions
    drop(subs);
    drop(layer);
    rebuild_writeback_index(&state, Some(&registry_path));

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
            calp::audit::AuditEvent::Published, // Reuse Published for now
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
