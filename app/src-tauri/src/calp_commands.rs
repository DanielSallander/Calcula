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
    /// Number of standalone module scripts published (C8).
    pub modules_published: usize,
    /// Number of standalone notebooks published (C8).
    pub notebooks_published: usize,
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
    /// Publisher display name asserted in the verified manifest (S5 phase 2).
    pub publisher_name: String,
    /// Trust outcome: "firstUse" (publisher key newly pinned) or "verified"
    /// (matched a prior pin). The frontend can surface a first-use notice.
    pub trust_status: String,
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

/// Resolve the per-user Calcula profile directory (%LOCALAPPDATA%\Calcula).
/// This is the SAME directory used for the subscriber identity; it also holds
/// the publisher's Ed25519 keypair (`publisher-key.json`) and the TOFU pin
/// store (`trusted-publishers.json`) for S5 phase 2 package signing.
pub(crate) fn calcula_profile_dir() -> std::path::PathBuf {
    let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".to_string());
    std::path::PathBuf::from(local_app_data).join("Calcula")
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Publish selected sheets to a local registry.
#[tauri::command]
pub fn calp_publish(
    state: State<AppState>,
    bi_state: State<BiState>,
    pivot_state: State<crate::pivot::types::PivotState>,
    script_state: State<crate::scripting::types::ScriptState>,
    params: PublishParams,
    window: tauri::Window,
) -> Result<PublishResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let registry = LocalRegistry::open(std::path::Path::new(&params.registry_path))
        .map_err(|e| e.to_string())?;

    let version = SemVer::parse(&params.version)
        .map_err(|e| e.to_string())?;

    let now = chrono::Utc::now().to_rfc3339();

    // Build a lightweight workbook snapshot for publishing
    let mut workbook = crate::persistence::build_workbook_snapshot(&state)?;

    // build_workbook_snapshot does not carry standalone module scripts /
    // notebooks (they live in ScriptState, not AppState), so populate them
    // here. With these present, the publish request's None ("all from the
    // workbook") ships every module script + notebook (C8).
    workbook.scripts = crate::persistence::collect_scripts_for_save(&script_state);
    workbook.notebooks = crate::persistence::collect_notebooks_for_save(&script_state);

    // Ship pivot definitions + BI pivot metadata so subscribers can rebuild
    // live pivots; per-pivot data source routing reads the dataSourceId
    // carried in that metadata. Without this, in-app publishes shipped no
    // pivots at all (only the example generator did).
    crate::persistence::collect_pivot_definitions(&pivot_state, &state, &mut workbook);

    // The package contains only the selected sheets: drop pivots whose
    // source or destination sheet isn't included, and remap grid-source
    // sheet indices from workbook positions to package positions (pull
    // appends package sheets in order, offset by the pre-pull sheet count).
    {
        let index_map: std::collections::HashMap<usize, usize> = params
            .sheet_indices
            .iter()
            .enumerate()
            .map(|(package_idx, &wb_idx)| (wb_idx, package_idx))
            .collect();
        let published_names: std::collections::HashSet<String> = params
            .sheet_indices
            .iter()
            .filter_map(|&i| workbook.sheets.get(i).map(|s| s.name.clone()))
            .collect();

        workbook.pivot_definitions.retain_mut(|def| {
            let dest_ok = def
                .definition
                .get("destination_sheet")
                .and_then(|v| v.as_str())
                .map_or(true, |name| published_names.contains(name));
            if !dest_ok {
                return false;
            }
            match def.source_sheet_index {
                Some(wb_idx) => match index_map.get(&wb_idx) {
                    Some(&package_idx) => {
                        def.source_sheet_index = Some(package_idx);
                        true
                    }
                    None => false, // grid source sheet not published
                },
                None => true, // BI pivot — no grid source sheet
            }
        });

        let kept: std::collections::HashSet<String> = workbook
            .pivot_definitions
            .iter()
            .map(|d| d.id.to_string())
            .collect();
        workbook.bi_pivot_metadata.retain(|m| {
            m.get("pivotId")
                .and_then(|v| v.as_str())
                .map_or(false, |id| kept.contains(id))
        });
    }

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
    let data_sources = capture_bi_data_sources(&bi_state)?;

    // Validate BI pivot definitions against the embedded model before publishing.
    // This catches mismatched field names (e.g., grid-style "Category" instead of
    // BI-style "dim_product.categoryname") that would silently break for subscribers.
    validate_bi_pivot_definitions(&workbook, &data_sources)?;

    // Build exclusion regions from pivot protected regions.
    // Pivot output cells are recalculated by subscribers, so we strip them
    // from the published data — only hard-coded cell values go into the package.
    let excluded_regions = {
        let regions = state.protected_regions.lock().map_err(|e| e.to_string())?;
        let sheet_ids = state.sheet_ids.lock().map_err(|e| e.to_string())?;
        regions.iter()
            .filter(|r| r.region_type == "pivot")
            .filter_map(|r| {
                sheet_ids.get(r.sheet_index).map(|&sid| calp::publish::ExcludedRegion {
                    sheet_id: sid,
                    start_row: r.start_row,
                    start_col: r.start_col,
                    end_row: r.end_row,
                    end_col: r.end_col,
                })
            })
            .collect::<Vec<_>>()
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
        object_scripts,
        // None => publish all standalone module scripts / notebooks carried in
        // the snapshot above (C8). They distribute as inert, transparent data.
        module_scripts: None,
        notebooks: None,
        data_sources,
        excluded_regions,
    };

    let result = calp::publish::publish(&registry, &request, &calcula_profile_dir())
        .map_err(|e| e.to_string())?;

    Ok(PublishResponse {
        package_name: result.package_name,
        version: result.version,
        sheets_published: result.sheets_published,
        tables_published: result.tables_published,
        named_ranges_published: result.named_ranges_published,
        scripts_published: result.scripts_published,
        modules_published: result.modules_published,
        notebooks_published: result.notebooks_published,
    })
}

/// Materialize ONE package's distributed standalone module scripts + notebooks
/// into ScriptState (C8). Used by BOTH the initial pull and the version refresh so
/// upstream updates propagate identically. Distributed standalone scripts/notebooks
/// are upstream-owned and inert — they appear in the workbook's script/notebook list
/// but are NEVER auto-executed; they run only on explicit, sandboxed user action.
///
/// Provenance-driven semantics (parity with distributed object scripts):
/// - REMOVAL-ON-REFRESH: a module/notebook this package shipped before but no longer
///   ships is dropped (so a publisher's deletion reaches the subscriber).
/// - UPDATE: a same-id entry owned by THIS package is replaced (the corrected
///   version lands).
/// - PRESERVE-LOCAL: a same-id entry that is subscriber-authored (no source_package)
///   or owned by a DIFFERENT package is kept — a package never silently shadows it
///   (the incoming one is skipped + logged). To customize distributed content, copy
///   it to a NEW id. `modules`/`notebooks` are already stamped source_package =
///   package_name at pull. Notebooks arrive run-clean (exec metadata stripped at pull).
fn materialize_distributed_scripts(
    script_state: &crate::scripting::types::ScriptState,
    package_name: &str,
    modules: &[persistence::SavedScript],
    notebooks: &[persistence::SavedNotebook],
) -> Result<(), String> {
    use std::collections::HashSet;

    {
        use crate::scripting::types::{ScriptScope, WorkbookScript};
        let mut scripts = script_state.workbook_scripts.lock().map_err(|e| e.to_string())?;
        let new_ids: HashSet<&str> = modules.iter().map(|m| m.id.as_str()).collect();
        // Removal-on-refresh: drop this package's prior modules it no longer ships.
        scripts.retain(|id, s| {
            !(s.source_package.as_deref() == Some(package_name) && !new_ids.contains(id.as_str()))
        });
        for module in modules {
            // Conflict = an existing same-id entry NOT owned by this package
            // (local, or a different package). Compute (and clone) up front so the
            // immutable borrow is released before the insert.
            let conflict: Option<Option<String>> = scripts.get(&module.id).and_then(|e| {
                if e.source_package.as_deref() == Some(package_name) { None }
                else { Some(e.source_package.clone()) }
            });
            if let Some(existing_owner) = conflict {
                crate::log_warn!(
                    "CALP",
                    "module '{}' from package '{}' not applied: id already used by {}",
                    module.id, package_name,
                    existing_owner.map(|p| format!("package '{}'", p))
                        .unwrap_or_else(|| "a local script".to_string()),
                );
                continue;
            }
            scripts.insert(
                module.id.clone(),
                WorkbookScript {
                    id: module.id.clone(),
                    name: module.name.clone(),
                    description: module.description.clone(),
                    source: module.source.clone(),
                    scope: match &module.scope {
                        persistence::SavedScriptScope::Workbook => ScriptScope::Workbook,
                        persistence::SavedScriptScope::Sheet { name } => {
                            ScriptScope::Sheet { name: name.clone() }
                        }
                    },
                    source_package: module.source_package.clone(),
                },
            );
        }
    }

    {
        use crate::scripting::types::{NotebookCell, NotebookDocument};
        let mut nbs = script_state.workbook_notebooks.lock().map_err(|e| e.to_string())?;
        let new_ids: HashSet<&str> = notebooks.iter().map(|n| n.id.as_str()).collect();
        nbs.retain(|id, n| {
            !(n.source_package.as_deref() == Some(package_name) && !new_ids.contains(id.as_str()))
        });
        for nb in notebooks {
            let conflict: Option<Option<String>> = nbs.get(&nb.id).and_then(|e| {
                if e.source_package.as_deref() == Some(package_name) { None }
                else { Some(e.source_package.clone()) }
            });
            if let Some(existing_owner) = conflict {
                crate::log_warn!(
                    "CALP",
                    "notebook '{}' from package '{}' not applied: id already used by {}",
                    nb.id, package_name,
                    existing_owner.map(|p| format!("package '{}'", p))
                        .unwrap_or_else(|| "a local notebook".to_string()),
                );
                continue;
            }
            nbs.insert(
                nb.id.clone(),
                NotebookDocument {
                    id: nb.id.clone(),
                    name: nb.name.clone(),
                    cells: nb
                        .cells
                        .iter()
                        .map(|c| NotebookCell {
                            id: c.id.clone(),
                            source: c.source.clone(),
                            last_output: c.last_output.clone(),
                            last_error: c.last_error.clone(),
                            cells_modified: c.cells_modified,
                            duration_ms: c.duration_ms,
                            execution_index: c.execution_index,
                        })
                        .collect(),
                    source_package: nb.source_package.clone(),
                },
            );
        }
    }
    Ok(())
}

/// Pull (subscribe to) a package.
#[tauri::command]
pub fn calp_pull(
    state: State<AppState>,
    pivot_state: State<'_, crate::pivot::types::PivotState>,
    bi_state: State<'_, BiState>,
    script_state: State<'_, crate::scripting::types::ScriptState>,
    params: PullParams,
    window: tauri::Window,
) -> Result<PullResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
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

    let result = calp::pull::pull(&registry, &request, &calcula_profile_dir())
        .map_err(|e| e.to_string())?;

    // S5 phase 2: capture the origin/trust outcome before `result` is consumed.
    let publisher_name = result.publisher_name.clone();
    let trust_status = match result.trust_status {
        calp::integrity::TrustStatus::FirstUse => "firstUse",
        calp::integrity::TrustStatus::Verified => "verified",
    }
    .to_string();

    let sheets_pulled = result.sheets.len();

    // Materialize pulled sheets into the workbook.
    // Each pulled sheet has its own local StyleRegistry; we merge styles into
    // the shared registry and remap cell style_index values accordingly.
    let chart_sheet_index = {
        let mut grids = state.grids.lock().map_err(|e| e.to_string())?;
        let mut sheet_names = state.sheet_names.lock().map_err(|e| e.to_string())?;
        let mut sheet_ids = state.sheet_ids.lock().map_err(|e| e.to_string())?;
        let mut shared_styles = state.style_registry.lock().map_err(|e| e.to_string())?;
        let mut all_cw = state.all_column_widths.lock().map_err(|e| e.to_string())?;
        let mut all_rh = state.all_row_heights.lock().map_err(|e| e.to_string())?;

        // Workbook index where pulled sheets land — a chart (keyed by its local
        // sheet id) remaps to this for ChartEntry.sheet_index.
        let base_index = grids.len();
        let mut chart_index_map: std::collections::HashMap<_, usize> =
            std::collections::HashMap::new();

        for (i, pulled) in result.sheets.iter().enumerate() {
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
            chart_index_map.insert(pulled.sheet.id, base_index + i);
        }
        chart_index_map
    };

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

    // Materialize pulled charts onto their (remapped) sheet index, so the
    // subscriber sees the report's charts in-app. Don't overwrite a chart the
    // subscriber already has by id.
    if !result.charts.is_empty() {
        let mut charts = state.charts.lock().map_err(|e| e.to_string())?;
        for chart in result.charts {
            if let Some(&sheet_index) = chart_sheet_index.get(&chart.sheet_id) {
                if !charts.iter().any(|c| c.id == chart.id) {
                    charts.push(crate::api_types::ChartEntry {
                        id: chart.id,
                        sheet_index,
                        spec_json: chart.spec_json,
                    });
                }
            }
        }
    }

    // Materialize pulled standalone module scripts + notebooks (C8) into
    // ScriptState. Shared with the refresh path so updates propagate identically.
    materialize_distributed_scripts(
        &script_state,
        &result.package_name,
        &result.module_scripts,
        &result.notebooks,
    )?;

    // Rebuild writeback index from updated subscriptions
    rebuild_writeback_index(&state);

    // Auto-load embedded BI models from the pulled package.
    // This creates BI connections so that BI pivots have a live engine to query.
    let embedded_connection_ids = load_embedded_data_sources(&result.data_sources, &bi_state);

    // Restore pivot definitions from the package and render to grid.
    // The source_sheet_index in each definition is relative to the publisher's
    // workbook. We need to offset it by the number of sheets that existed
    // before the pull (since pulled sheets are appended).
    if !result.pivot_definitions.is_empty() {
        let sheet_offset = {
            let names = state.sheet_names.lock().map_err(|e| e.to_string())?;
            names.len() - sheets_pulled
        };
        restore_pulled_pivots(
            &result.pivot_definitions,
            &result.bi_pivot_metadata,
            &state,
            &pivot_state,
            sheet_offset,
            &embedded_connection_ids,
        );
    }

    Ok(PullResponse {
        package_name: result.package_name,
        resolved_version: result.resolved_version.to_string(),
        sheets_pulled,
        tables_pulled: result.tables.len(),
        scripts_pulled,
        publisher_name,
        trust_status,
    })
}

/// Browse packages in a local registry.
#[tauri::command]
pub fn calp_browse_registry(
    registry_path: String,
    window: tauri::Window,
) -> Result<Vec<PackageInfo>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
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

/// What a package version contains, surfaced BEFORE pulling so the user can
/// review (and explicitly accept) incoming scripts, data sources, and
/// writeback regions instead of having them materialized silently.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageInspection {
    pub package_name: String,
    pub resolved_version: String,
    pub sheets: Vec<SheetInfo>,
    pub scripts: Vec<InspectedScript>,
    /// Standalone module scripts bundled with the package (C8). Surfaced in the
    /// pre-pull review for transparency — they are inert (never auto-executed).
    pub module_scripts: Vec<InspectedModuleScript>,
    /// Standalone notebooks bundled with the package (C8). Surfaced in the
    /// pre-pull review for transparency — inert until the user runs them.
    pub notebooks: Vec<InspectedNotebook>,
    pub data_sources: Vec<InspectedDataSource>,
    pub writeback_region_count: usize,
    pub table_count: usize,
    pub named_range_count: usize,
    /// S5 phase 2: the verified publisher's display name. Inspect is a pre-pull
    /// trust surface, so the manifest signature is checked here too.
    pub publisher_name: String,
    /// "firstUse" (publisher key newly pinned) or "verified" (matched a prior
    /// pin). If verification fails, inspect returns an Err instead.
    pub trust_status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedScript {
    pub name: String,
    pub object_type: String,
    pub description: Option<String>,
    /// The capability ids the package's manifest declares this script needs
    /// (R19 ceiling). Surfaced BEFORE pulling so the user sees what the
    /// package's scripts want before accepting.
    pub requested_capabilities: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedModuleScript {
    pub name: String,
    /// "workbook" or a sheet name.
    pub scope: String,
    pub description: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedNotebook {
    pub name: String,
    pub cell_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedDataSource {
    pub name: String,
    pub connection_type: String,
    pub server: String,
    pub database: String,
}

/// Inspect a package version's contents without materializing anything.
#[tauri::command]
pub fn calp_inspect_package(
    registry_path: String,
    package_name: String,
    version_pin: String,
    window: tauri::Window,
) -> Result<PackageInspection, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let registry = LocalRegistry::open(std::path::Path::new(&registry_path))
        .map_err(|e| e.to_string())?;

    let pin = VersionPin::parse(&version_pin).map_err(|e| e.to_string())?;
    let resolved = registry
        .resolve_version(&package_name, &pin)
        .map_err(|e| e.to_string())?;
    let version = resolved.to_string();

    let manifest = registry
        .get_version_manifest(&package_name, &version)
        .map_err(|e| e.to_string())?;

    // S5 phase 2: verify the manifest's Ed25519 signature + TOFU pin BEFORE
    // surfacing the contents — inspect is a pre-pull trust surface, so an
    // unsigned/tampered/hijacked package must fail to inspect, not just to pull.
    let ver_dir = registry.version_dir(&package_name, &version).map_err(|e| e.to_string())?;
    let trust = calp::integrity::verify_manifest_signature(
        &ver_dir,
        &manifest,
        &package_name,
        &calcula_profile_dir(),
    )
    .map_err(|e| e.to_string())?;
    let trust_status = match trust {
        calp::integrity::TrustStatus::FirstUse => "firstUse",
        calp::integrity::TrustStatus::Verified => "verified",
    }
    .to_string();

    Ok(PackageInspection {
        package_name,
        resolved_version: version,
        publisher_name: manifest.publisher_name.clone(),
        trust_status,
        sheets: manifest.sheets.iter().map(|s| SheetInfo {
            name: s.name.clone(),
            description: s.description.clone(),
        }).collect(),
        scripts: manifest.object_scripts.iter().map(|s| InspectedScript {
            name: s.name.clone(),
            object_type: s.object_type.clone(),
            description: s.description.clone(),
            requested_capabilities: s.capabilities.clone(),
        }).collect(),
        module_scripts: manifest.module_scripts.iter().map(|m| InspectedModuleScript {
            name: m.name.clone(),
            scope: m.scope.clone(),
            description: m.description.clone(),
        }).collect(),
        notebooks: manifest.notebooks.iter().map(|n| InspectedNotebook {
            name: n.name.clone(),
            cell_count: n.cell_count,
        }).collect(),
        data_sources: manifest.data_sources.iter().map(|ds| InspectedDataSource {
            name: ds.name.clone(),
            connection_type: ds.connection_type.clone(),
            server: ds.server.clone(),
            database: ds.database.clone(),
        }).collect(),
        writeback_region_count: manifest
            .writeback_regions
            .as_ref()
            .map(|r| r.len())
            .unwrap_or(0),
        table_count: manifest.tables.len(),
        named_range_count: manifest.named_ranges.len(),
    })
}

/// Get subscription metadata for the current workbook.
#[tauri::command]
pub fn calp_get_subscriptions(
    state: State<AppState>,
    window: tauri::Window,
) -> Result<SubscriptionManifest, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
    Ok(subs.clone())
}

/// Return the entire override layer for the current workbook.
#[tauri::command]
pub fn calp_get_overrides(
    state: State<AppState>,
    window: tauri::Window,
) -> Result<calp::OverrideLayer, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let layer = state.override_layer.lock().map_err(|e| e.to_string())?;
    Ok(layer.clone())
}

/// Materialize an OverrideValue into a grid cell, preserving the cell's style.
/// Formula cells get their AST set with an Empty value — the caller is
/// responsible for triggering a recalculation pass afterwards.
fn write_override_value(grid: &mut engine::Grid, row: u32, col: u32, value: &calp::OverrideValue) {
    let style_index = grid.get_cell(row, col).map(|c| c.style_index).unwrap_or(0);
    match value {
        calp::OverrideValue::Empty => {
            grid.clear_cell(row, col);
        }
        calp::OverrideValue::Value { display } => {
            let cell_value = if display.is_empty() {
                engine::CellValue::Empty
            } else if let Ok(n) = display.parse::<f64>() {
                engine::CellValue::Number(n)
            } else if display == "TRUE" {
                engine::CellValue::Boolean(true)
            } else if display == "FALSE" {
                engine::CellValue::Boolean(false)
            } else {
                engine::CellValue::Text(display.clone())
            };
            grid.set_cell(row, col, engine::Cell {
                ast: None,
                value: cell_value,
                style_index,
                rich_text: None,
            });
        }
        calp::OverrideValue::Formula { formula } => {
            match parser::parse(formula) {
                Ok(ast) => {
                    grid.set_cell(row, col, engine::Cell {
                        ast: Some(Box::new(ast)),
                        value: engine::CellValue::Empty,
                        style_index,
                        rich_text: None,
                    });
                }
                Err(_) => {
                    // Version skew can make a stored formula unparseable
                    // here. Keep the text visible instead of silently
                    // blanking the cell (the override layer still holds it).
                    crate::log_warn!("CALP", "Override formula failed to parse at ({},{}): ={}", row, col, formula);
                    grid.set_cell(row, col, engine::Cell {
                        ast: None,
                        value: engine::CellValue::Text(format!("={}", formula)),
                        style_index,
                        rich_text: None,
                    });
                }
            }
        }
    }
}

/// Resolve a sheet id to its current workbook index.
fn sheet_index_for_id(state: &AppState, sheet_id: SheetId) -> Option<usize> {
    state.sheet_ids.lock().ok()?.iter().position(|id| *id == sheet_id)
}

/// Write an OverrideValue into the workbook grids at the cell's current
/// position. Returns true if a cell was written.
fn apply_override_value_to_grid(
    state: &AppState,
    sheet_id: SheetId,
    cell_id: CellId,
    fallback_position: (u32, u32),
    value: &calp::OverrideValue,
) -> bool {
    let position = state
        .id_registry
        .lock()
        .ok()
        .and_then(|reg| reg.cell_position(sheet_id, cell_id))
        .unwrap_or(fallback_position);

    let sheet_index = {
        let sheet_ids = match state.sheet_ids.lock() {
            Ok(s) => s,
            Err(_) => return false,
        };
        match sheet_ids.iter().position(|id| *id == sheet_id) {
            Some(i) => i,
            None => return false,
        }
    };

    {
        let mut grids = match state.grids.lock() {
            Ok(g) => g,
            Err(_) => return false,
        };
        match grids.get_mut(sheet_index) {
            Some(grid) => write_override_value(grid, position.0, position.1, value),
            None => return false,
        }
    }

    // Keep the active-sheet mirror in sync.
    let active = state.active_sheet.lock().map(|a| *a).unwrap_or(usize::MAX);
    if active == sheet_index {
        if let Ok(mut grid) = state.grid.lock() {
            write_override_value(&mut grid, position.0, position.1, value);
        }
    }
    true
}

/// Revert a single override, restoring the upstream (baseline) value for
/// that cell in the grid.
#[tauri::command]
pub fn calp_revert_override(
    state: State<AppState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    pivot_state: State<crate::pivot::types::PivotState>,
    sheet_id: String,
    cell_id: String,
    window: tauri::Window,
) -> Result<bool, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let sid = SheetId::parse(&sheet_id)
        .ok_or_else(|| format!("Invalid sheet_id: {}", sheet_id))?;
    let cid = CellId::parse(&cell_id)
        .ok_or_else(|| format!("Invalid cell_id: {}", cell_id))?;

    let restore = {
        let mut layer = state.override_layer.lock().map_err(|e| e.to_string())?;
        let restore = layer
            .get(sid, cid)
            .map(|ovr| (ovr.baseline.clone(), ovr.position));
        if restore.is_some() {
            layer.remove_override(sid, cid);
        }
        restore
    };

    match restore {
        Some((baseline, position)) => {
            apply_override_value_to_grid(&state, sid, cid, position, &baseline);
            // Re-evaluate the sheet so restored formulas (written Empty,
            // pending recalc) and dependents of the restored value display
            // correctly even when the sheet is not active — the frontend's
            // calculateNow only covers the active one.
            if let Some(idx) = sheet_index_for_id(&state, sid) {
                crate::calculation::recalculate_sheet_values(&state, &user_files_state, &pivot_state, idx);
            }
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Accept the upstream value for a conflicted cell: discards the override and
/// writes the new upstream value into the grid.
#[tauri::command]
pub fn calp_accept_upstream(
    state: State<AppState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    pivot_state: State<crate::pivot::types::PivotState>,
    sheet_id: String,
    cell_id: String,
    window: tauri::Window,
) -> Result<bool, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let sid = SheetId::parse(&sheet_id)
        .ok_or_else(|| format!("Invalid sheet_id: {}", sheet_id))?;
    let cid = CellId::parse(&cell_id)
        .ok_or_else(|| format!("Invalid cell_id: {}", cell_id))?;

    let restore = {
        let mut layer = state.override_layer.lock().map_err(|e| e.to_string())?;
        let restore = layer.get(sid, cid).map(|ovr| {
            // For a conflicted override the value to accept is the new
            // upstream; otherwise the baseline is the upstream value.
            let value = ovr.upstream_new.clone().unwrap_or_else(|| ovr.baseline.clone());
            (value, ovr.position)
        });
        if restore.is_some() {
            layer.accept_upstream(sid, cid);
        }
        restore
    };

    match restore {
        Some((upstream, position)) => {
            apply_override_value_to_grid(&state, sid, cid, position, &upstream);
            if let Some(idx) = sheet_index_for_id(&state, sid) {
                crate::calculation::recalculate_sheet_values(&state, &user_files_state, &pivot_state, idx);
            }
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Keep the consumer's override for a conflicted cell (rebases onto new upstream baseline).
#[tauri::command]
pub fn calp_keep_override(
    state: State<AppState>,
    sheet_id: String,
    cell_id: String,
    window: tauri::Window,
) -> Result<bool, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
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
    window: tauri::Window,
) -> Result<calp::OverridePatch, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
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
    window: tauri::Window,
) -> Result<usize, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
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

// ============================================================================
// Override capture — subscriber edits to subscribed sheets
// ============================================================================

/// Canonical string form of an engine cell value for override comparison.
/// Must stay in sync with `override_value_from_saved` so a captured baseline
/// compares meaningfully against upstream values from pulled payloads
/// (SavedCellValue::from_value uses the same conventions, incl. `{:?}` errors).
fn override_display(value: &engine::CellValue) -> String {
    match value {
        engine::CellValue::Empty => String::new(),
        engine::CellValue::Number(n) => n.to_string(),
        engine::CellValue::Text(s) => s.clone(),
        engine::CellValue::Boolean(b) => if *b { "TRUE".to_string() } else { "FALSE".to_string() },
        engine::CellValue::Error(e) => format!("{:?}", e),
        other => format!("{:?}", other),
    }
}

/// Canonical OverrideValue for an engine cell (None = absent/cleared cell).
fn override_value_from_cell(cell: Option<&engine::Cell>) -> calp::OverrideValue {
    match cell {
        None => calp::OverrideValue::Empty,
        Some(c) => {
            if let Some(formula) = c.formula_string() {
                calp::OverrideValue::Formula { formula }
            } else if matches!(c.value, engine::CellValue::Empty) {
                calp::OverrideValue::Empty
            } else {
                calp::OverrideValue::Value { display: override_display(&c.value) }
            }
        }
    }
}

/// Canonical OverrideValue for a pulled payload cell (None = absent cell).
/// Mirror of `override_value_from_cell` for persistence::SavedCell.
pub(crate) fn override_value_from_saved(cell: Option<&persistence::SavedCell>) -> calp::OverrideValue {
    match cell {
        None => calp::OverrideValue::Empty,
        Some(c) => {
            if let Some(ref formula) = c.formula {
                calp::OverrideValue::Formula { formula: formula.clone() }
            } else {
                match &c.value {
                    persistence::SavedCellValue::Empty => calp::OverrideValue::Empty,
                    persistence::SavedCellValue::Number(n) => {
                        calp::OverrideValue::Value { display: n.to_string() }
                    }
                    persistence::SavedCellValue::Text(s) => {
                        calp::OverrideValue::Value { display: s.clone() }
                    }
                    persistence::SavedCellValue::Boolean(b) => calp::OverrideValue::Value {
                        display: if *b { "TRUE".to_string() } else { "FALSE".to_string() },
                    },
                    // SavedCellValue::Error already stores the engine error's
                    // Debug string (persistence from_value) — same form as
                    // override_display's `{:?}` of CellError. Wrapping it in
                    // another Debug would make every error-cell override a
                    // permanent spurious conflict.
                    persistence::SavedCellValue::Error(s) => {
                        calp::OverrideValue::Value { display: s.clone() }
                    }
                    other => calp::OverrideValue::Value { display: format!("{:?}", other) },
                }
            }
        }
    }
}

/// Record consumer-side overrides for committed edits on a subscribed sheet.
/// Called by the cell write paths (update_cell, update_cells_batch, fill_range)
/// after the grid mutation succeeds; `edits` carries (row, col, pre, post)
/// cell states. Cheap no-op when the sheet isn't part of any subscription.
/// Writeback cells are excluded (they route to the draft layer instead).
pub(crate) fn record_subscription_override_edits(
    state: &AppState,
    sheet_index: usize,
    edits: &[(u32, u32, Option<engine::Cell>, Option<engine::Cell>)],
) {
    if edits.is_empty() {
        return;
    }

    // Resolve the local sheet id for this index.
    let sheet_id = {
        let sheet_ids = match state.sheet_ids.lock() {
            Ok(s) => s,
            Err(_) => return,
        };
        match sheet_ids.get(sheet_index) {
            Some(&sid) => sid,
            None => return,
        }
    };

    // Only sheets that belong to a subscription get overrides.
    {
        let subs = match state.subscriptions.lock() {
            Ok(s) => s,
            Err(_) => return,
        };
        let subscribed = subs.subscriptions.iter()
            .any(|sub| sub.sheets.iter().any(|s| s.local_sheet_id == sheet_id));
        if !subscribed {
            return;
        }
    }

    let now = chrono::Utc::now().to_rfc3339();
    let wb_index = state.writeback_index.lock().ok();
    // LOCK ORDER: override_layer BEFORE id_registry — calp_refresh_apply and
    // the workbook-load path acquire them in that order; inverting it here
    // would be an ABBA deadlock under concurrent commands.
    let mut layer = match state.override_layer.lock() {
        Ok(l) => l,
        Err(_) => return,
    };
    let mut id_reg = match state.id_registry.lock() {
        Ok(r) => r,
        Err(_) => return,
    };

    for (row, col, pre, post) in edits {
        if let Some(ref idx) = wb_index {
            if idx.contains(sheet_id, *row, *col) {
                continue;
            }
        }

        let pre_value = override_value_from_cell(pre.as_ref());
        let post_value = override_value_from_cell(post.as_ref());
        if pre_value == post_value {
            continue;
        }

        let cell_id = id_reg.cell_id_at(sheet_id, (*row, *col));

        let restored_baseline = layer
            .get(sheet_id, cell_id)
            .map(|existing| post_value == existing.baseline);
        match restored_baseline {
            Some(true) => {
                // Consumer restored the upstream value — the override is gone.
                layer.remove_override(sheet_id, cell_id);
            }
            Some(false) => {
                if let Some(existing) = layer.get_mut(sheet_id, cell_id) {
                    existing.current = post_value;
                    existing.position = (*row, *col);
                    existing.modified_at = now.clone();
                    // A new edit on a conflicted cell supersedes the conflict
                    // decision implicitly: keep the conflict flag so the user
                    // still resolves it in the Overrides pane.
                }
            }
            None => {
                // First edit of this cell: the pre-edit state IS the upstream
                // value (no override existed, so the cell was unmodified).
                layer.set_override(calp::CellOverride {
                    sheet_id,
                    cell_id,
                    position: (*row, *col),
                    baseline: pre_value,
                    current: post_value,
                    created_at: now.clone(),
                    modified_at: now.clone(),
                    author: String::new(),
                    conflict: false,
                    upstream_new: None,
                    extra: std::collections::HashMap::new(),
                });
            }
        }
    }
}

/// Resolve a subscription's registry filesystem path from its stored URL.
/// Subscriptions store URLs like `file://C:\path\to\registry`.
fn subscription_registry_path(sub: &calp::manifest::Subscription) -> &str {
    sub.registry_url.strip_prefix("file://").unwrap_or(&sub.registry_url)
}

/// Group refreshable subscriptions by registry path, preserving each
/// subscription's index into the workbook subscription list. Dev and
/// channel subscriptions are skipped (they refresh through their own flows).
fn group_subscriptions_by_registry(
    subs: &[calp::manifest::Subscription],
) -> Vec<(String, Vec<usize>)> {
    let mut groups: Vec<(String, Vec<usize>)> = Vec::new();
    for (i, sub) in subs.iter().enumerate() {
        if sub.version_pin == "dev" || sub.version_pin.starts_with("channel:") {
            continue;
        }
        let path = subscription_registry_path(sub).to_string();
        if let Some(group) = groups.iter_mut().find(|(p, _)| *p == path) {
            group.1.push(i);
        } else {
            groups.push((path, vec![i]));
        }
    }
    groups
}

/// Compute a preview of what a refresh would change, without applying anything.
/// Each subscription is resolved against its own stored registry URL, so
/// workbooks subscribed to multiple registries refresh correctly.
#[tauri::command]
pub fn calp_refresh_preview(
    state: State<AppState>,
    window: tauri::Window,
) -> Result<calp::refresh::RefreshPreview, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
    let layer = state.override_layer.lock().map_err(|e| e.to_string())?;

    let mut merged = calp::refresh::RefreshPreview {
        subscription_previews: Vec::new(),
        total_cells_changed: 0,
        total_sheets_added: 0,
        total_sheets_removed: 0,
        total_overrides_conflicted: 0,
        total_overrides_auto_cleared: 0,
    };

    for (registry_path, indices) in group_subscriptions_by_registry(&subs.subscriptions) {
        let registry = LocalRegistry::open(std::path::Path::new(&registry_path))
            .map_err(|e| format!("Registry '{}': {}", registry_path, e))?;
        let group: Vec<_> = indices.iter()
            .map(|&i| subs.subscriptions[i].clone())
            .collect();
        let preview = calp::refresh::compute_preview(&registry, &group, &layer)
            .map_err(|e| format!("Registry '{}': {}", registry_path, e))?;

        merged.subscription_previews.extend(preview.subscription_previews);
        merged.total_cells_changed += preview.total_cells_changed;
        merged.total_sheets_added += preview.total_sheets_added;
        merged.total_sheets_removed += preview.total_sheets_removed;
        merged.total_overrides_conflicted += preview.total_overrides_conflicted;
        merged.total_overrides_auto_cleared += preview.total_overrides_auto_cleared;
    }

    Ok(merged)
}

/// Apply the refresh after the user has confirmed the preview.
/// Pulls new versions for all subscriptions that have updates and materializes
/// new/updated sheets into the workbook grids. Each subscription is pulled
/// from its own stored registry URL.
#[tauri::command]
pub fn calp_refresh_apply(
    state: State<AppState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    pivot_state: State<crate::pivot::types::PivotState>,
    script_state: State<crate::scripting::types::ScriptState>,
    window: tauri::Window,
) -> Result<calp::refresh::RefreshResult, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let now = chrono::Utc::now().to_rfc3339();

    // Pull new versions for all subscriptions that have updates.
    let payloads = {
        let subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
        let mut all_payloads = Vec::new();
        for (registry_path, indices) in group_subscriptions_by_registry(&subs.subscriptions) {
            let registry = LocalRegistry::open(std::path::Path::new(&registry_path))
                .map_err(|e| format!("Registry '{}': {}", registry_path, e))?;
            let group: Vec<_> = indices.iter()
                .map(|&i| subs.subscriptions[i].clone())
                .collect();
            let group_payloads = calp::refresh::pull_all_updates(&registry, &group, &calcula_profile_dir())
                .map_err(|e| format!("Registry '{}': {}", registry_path, e))?;
            for mut payload in group_payloads {
                // pull_all_updates indexed into the group slice; remap back to
                // the workbook subscription index.
                payload.subscription_index = indices[payload.subscription_index];
                all_payloads.push(payload);
            }
        }
        all_payloads
    };

    // Materialize new/updated sheets into grids.
    let active_grid_after_materialize = {
        let mut grids = state.grids.lock().map_err(|e| e.to_string())?;
        let mut sheet_names = state.sheet_names.lock().map_err(|e| e.to_string())?;
        let mut sheet_ids = state.sheet_ids.lock().map_err(|e| e.to_string())?;
        let mut shared_styles = state.style_registry.lock().map_err(|e| e.to_string())?;
        let mut all_cw = state.all_column_widths.lock().map_err(|e| e.to_string())?;
        let mut all_rh = state.all_row_heights.lock().map_err(|e| e.to_string())?;
        let subs = state.subscriptions.lock().map_err(|e| e.to_string())?;

        for payload in &payloads {
            // Revalidate: a concurrent detach/subscribe between lock windows
            // can shift indices; indexing blindly would panic and poison the
            // grid mutexes app-wide.
            let Some(sub) = subs.subscriptions.get(payload.subscription_index) else {
                continue;
            };

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

        // Snapshot the active sheet ONLY when it was actually refreshed.
        // state.grid is the authoritative mirror for the active sheet and
        // grids[active] can legitimately lag behind it (BUG-0016) — an
        // unconditional sync would regress unrefreshed active-sheet content.
        // (sheet_ids and subs are the guards already held by this block.)
        let active = *state.active_sheet.lock().map_err(|e| e.to_string())?;
        let active_was_refreshed = sheet_ids.get(active).map_or(false, |active_sid| {
            payloads.iter().any(|payload| {
                let sub = match subs.subscriptions.get(payload.subscription_index) {
                    Some(s) => s,
                    None => return false,
                };
                payload.pull_result.sheets.iter().any(|pulled| {
                    sub.sheets.iter().any(|s| {
                        s.package_sheet_id == pulled.package_sheet_id
                            && s.local_sheet_id == *active_sid
                    })
                })
            })
        });
        if active_was_refreshed {
            grids.get(active).cloned()
        } else {
            None
        }
    };

    // Sync the active-sheet mirror: state.grid is the read path for the
    // active sheet, and calculate_now copies it back over grids[active] —
    // without this sync a refreshed active sheet reverts on the next recalc.
    if let Some(grid) = active_grid_after_materialize {
        *state.grid.lock().map_err(|e| e.to_string())? = grid;
    }

    // Capture the pre-refresh writeback declarations BEFORE the index is
    // rebuilt below, so removed/incompatible regions are actually detected.
    let old_decls = state.writeback_declarations.lock()
        .map(|d| d.clone()).unwrap_or_default();

    // Build the upstream-value map for the override rebase: for every
    // override on a refreshed sheet, the new upstream value at the override's
    // current local position. Package payloads are coordinate-keyed (no
    // per-cell ids yet), so matching is positional — correct when upstream
    // updates values in place; upstream row/column insertions are a known
    // limitation until packages carry cell-level ids.
    let (upstream_values, refreshed_sheet_ids) = {
        let subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
        let layer = state.override_layer.lock().map_err(|e| e.to_string())?;
        let id_reg = state.id_registry.lock().map_err(|e| e.to_string())?;

        let mut values: std::collections::HashMap<(SheetId, CellId), calp::OverrideValue> =
            std::collections::HashMap::new();
        let mut sheets: std::collections::HashSet<SheetId> = std::collections::HashSet::new();
        for payload in &payloads {
            let Some(sub) = subs.subscriptions.get(payload.subscription_index) else {
                continue;
            };
            for pulled in &payload.pull_result.sheets {
                let Some(sheet_sub) = sub.sheets.iter()
                    .find(|s| s.package_sheet_id == pulled.package_sheet_id)
                else { continue };
                let local_sid = sheet_sub.local_sheet_id;
                sheets.insert(local_sid);
                for ovr in layer.overrides_for_sheet(local_sid) {
                    let pos = id_reg
                        .cell_position(local_sid, ovr.cell_id)
                        .unwrap_or(ovr.position);
                    let upstream_cell = pulled.sheet.cells.get(&pos);
                    values.insert(
                        (local_sid, ovr.cell_id),
                        override_value_from_saved(upstream_cell),
                    );
                }
            }
        }
        (values, sheets)
    };

    // Collect each payload's refreshed script set before the payloads move
    // into apply_refresh below.
    let script_updates: Vec<(String, Vec<persistence::SavedObjectScript>)> = payloads
        .iter()
        .map(|p| (p.pull_result.package_name.clone(), p.pull_result.object_scripts.clone()))
        .collect();

    // C8: likewise collect the refreshed standalone module scripts + notebooks
    // before the move, so the refresh can materialize them (without this they are
    // pulled then silently dropped, leaving a subscriber stuck on the version
    // present at first subscribe). Kept PER PACKAGE so removal-on-refresh +
    // preserve-local can scope to the owning package.
    #[allow(clippy::type_complexity)]
    let module_notebook_updates: Vec<(String, Vec<persistence::SavedScript>, Vec<persistence::SavedNotebook>)> =
        payloads
            .iter()
            .map(|p| {
                (
                    p.pull_result.package_name.clone(),
                    p.pull_result.module_scripts.clone(),
                    p.pull_result.notebooks.clone(),
                )
            })
            .collect();

    // Apply refresh: update subscription metadata and rebase overrides.
    let mut subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
    let mut layer = state.override_layer.lock().map_err(|e| e.to_string())?;

    // apply_refresh indexes subscriptions by payload.subscription_index; if a
    // concurrent detach shrank the list since the payloads were built, bail
    // out instead of panicking inside the core crate.
    if payloads.iter().any(|p| p.subscription_index >= subs.subscriptions.len()) {
        return Err("Subscriptions changed while the refresh was running — please retry.".to_string());
    }

    let result = calp::refresh::apply_refresh(
        payloads,
        &mut subs.subscriptions,
        &mut layer,
        &upstream_values,
        &now,
    );

    // Re-overlay surviving overrides onto the refreshed grids: the wholesale
    // grid replacement above wrote pristine upstream content, which would
    // otherwise silently discard the subscriber's local modifications.
    // Conflicted overrides keep showing the local value; the Overrides pane
    // is where the user resolves them.
    let to_overlay: Vec<calp::CellOverride> = layer.overrides.iter()
        .filter(|o| refreshed_sheet_ids.contains(&o.sheet_id))
        .cloned()
        .collect();

    // Rebuild writeback index from updated subscriptions
    drop(subs);
    drop(layer);

    for ovr in &to_overlay {
        apply_override_value_to_grid(&state, ovr.sheet_id, ovr.cell_id, ovr.position, &ovr.current);
    }

    // Swap in the refreshed packages' scripts: replace each package's
    // previous distributed scripts with the new version's set (already
    // stamped Distributed + restricted by the pull layer) and add new ones.
    // Without this the workbook keeps running v1 scripts against vN sheets
    // and the hash-keyed consent re-prompt can never trigger. Distributed
    // scripts are upstream-owned (read-only locally), so replacement is safe.
    {
        let mut scripts = state.object_scripts.lock().map_err(|e| e.to_string())?;
        for (package_name, new_scripts) in script_updates {
            scripts.retain(|s| {
                !(matches!(s.provenance, persistence::ScriptProvenance::Distributed)
                    && s.package_name.as_deref() == Some(package_name.as_str()))
            });
            for script in new_scripts {
                // Never let a package script shadow an unrelated local
                // script that happens to share its id.
                if !scripts.iter().any(|s| s.id == script.id) {
                    scripts.push(script);
                }
            }
        }
    }

    // C8: materialize each refreshed package's standalone module scripts +
    // notebooks so upstream updates (incl. removals) actually land on refresh,
    // while preserving subscriber-local same-id documents.
    for (pkg, modules, notebooks) in &module_notebook_updates {
        materialize_distributed_scripts(&script_state, pkg, modules, notebooks)?;
    }

    rebuild_writeback_index(&state);

    // Handle writeback region changes: invalidate drafts for removed/incompatible regions
    {
        // Reload new declarations (rebuild_writeback_index just updated them);
        // old_decls was captured before the rebuild.
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

    // The refreshed grids hold pristine upstream content plus overlays whose
    // formula cells are pending evaluation, and the dependency maps still
    // describe the PRE-refresh active sheet. Rebuild deps (active sheet only —
    // the maps are single-sheet) and re-evaluate every refreshed sheet,
    // including non-active ones that calculate_now never touches.
    {
        let refreshed_indices: Vec<usize> = {
            let sheet_ids = state.sheet_ids.lock().map_err(|e| e.to_string())?;
            sheet_ids.iter().enumerate()
                .filter(|(_, sid)| refreshed_sheet_ids.contains(sid))
                .map(|(i, _)| i)
                .collect()
        };
        let active = *state.active_sheet.lock().map_err(|e| e.to_string())?;
        if refreshed_indices.contains(&active) {
            crate::undo_commands::rebuild_all_dependencies(&state);
        }
        for idx in refreshed_indices {
            crate::calculation::recalculate_sheet_values(&state, &user_files_state, &pivot_state, idx);
        }
    }

    Ok(result)
}

/// Strip all subscriptions and overrides, converting the workbook to a
/// standalone (detached) document.
#[tauri::command]
pub fn calp_detach(state: State<AppState>, window: tauri::Window) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let mut subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
    let mut layer = state.override_layer.lock().map_err(|e| e.to_string())?;

    calp::refresh::detach(&mut subs.subscriptions, &mut layer);

    // Clear writeback index (no subscriptions remain)
    drop(subs);
    drop(layer);
    if let Ok(mut idx) = state.writeback_index.lock() {
        *idx = calp::WritebackIndex::default();
    }
    invalidate_gather_cache(&state);

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
    window: tauri::Window,
) -> Result<PullResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
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
        // Dev subscriptions pull from the user's own local workbook folder
        // (not a signed registry package), so there is no publisher to verify.
        publisher_name: String::new(),
        trust_status: "dev".to_string(),
    })
}

/// Re-pull from the dev source, refreshing HEAD sheets in the workbook.
#[tauri::command]
pub fn calp_dev_refresh(state: State<AppState>, window: tauri::Window) -> Result<PullResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
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
        // Dev re-pull: local-folder source, no signed publisher to verify.
        publisher_name: String::new(),
        trust_status: "dev".to_string(),
    })
}

/// Rename a stable CellId (author-facing operation).
#[tauri::command]
pub fn calp_rename_cell_id(
    state: State<AppState>,
    sheet_id: String,
    old_cell_id: String,
    new_cell_id: String,
    window: tauri::Window,
) -> Result<bool, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
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
    window: tauri::Window,
) -> Result<bool, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
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
    window: tauri::Window,
) -> Result<calp::audit::AuditLog, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
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
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let mut log = state.audit_log.lock().map_err(|e| e.to_string())?;
    log.enabled = enabled;
    log.max_entries = max_entries;
    Ok(())
}

/// Discard all audit log entries.
#[tauri::command]
pub fn calp_clear_audit_log(
    state: State<AppState>,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
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
    window: tauri::Window,
) -> Result<Vec<calp::WritebackRegionEntry>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
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
/// Each subscription's manifest is read from its own stored registry URL.
/// Called internally after pull and refresh, and after workbook load (the
/// index is in-memory only and would otherwise be stale-empty after reopen).
pub(crate) fn rebuild_writeback_index(state: &AppState) {
    // The index changes on pull/refresh/open/detach — the cached GATHER map
    // is built from the same declarations and must go with it.
    invalidate_gather_cache(state);

    let subs = match state.subscriptions.lock() {
        Ok(s) => s,
        Err(_) => return,
    };

    let mut all_decls = Vec::new();

    for sub in &subs.subscriptions {
        // Skip dev and file-channel subscriptions (no writeback in those)
        if sub.version_pin == "dev" || sub.version_pin.starts_with("channel:") {
            continue;
        }
        let registry_path = subscription_registry_path(sub);
        let registry = match calp::registry::LocalRegistry::open(std::path::Path::new(registry_path)) {
            Ok(r) => r,
            Err(_) => continue,
        };
        if let Ok(ver_manifest) = registry.get_version_manifest(
            &sub.package_name, &sub.resolved_version,
        ) {
            if let Some(ref wb_regions) = ver_manifest.writeback_regions {
                all_decls.extend(wb_regions.iter().cloned());
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

/// Resolve the stable SheetId for a workbook sheet index.
/// Used by the frontend to build region selectors for the active sheet
/// (e.g., when designating a writeback region from the current selection).
#[tauri::command]
pub fn calp_get_sheet_id(
    state: State<AppState>,
    sheet_index: usize,
    window: tauri::Window,
) -> Result<String, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let sheet_ids = state.sheet_ids.lock().map_err(|e| e.to_string())?;
    sheet_ids
        .get(sheet_index)
        .map(|id| id.to_string())
        .ok_or_else(|| format!("No sheet at index {}", sheet_index))
}

/// Get all draft writeback regions for the current workbook.
#[tauri::command]
pub fn calp_get_writeback_draft_regions(
    state: State<AppState>,
    window: tauri::Window,
) -> Result<Vec<calp::WritebackRegionDeclaration>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let drafts = state.writeback_draft_regions.lock().map_err(|e| e.to_string())?;
    Ok(drafts.clone())
}

/// Add a new draft writeback region.
#[tauri::command]
pub fn calp_add_writeback_region(
    state: State<AppState>,
    region: calp::WritebackRegionDeclaration,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
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
    window: tauri::Window,
) -> Result<bool, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
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
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
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

/// Get the cached subscriber identity, loading/creating it on first use.
pub(crate) fn get_subscriber_identity(state: &AppState) -> Result<calp::SubmitterIdentity, String> {
    {
        let cached = state.subscriber_identity.lock().map_err(|e| e.to_string())?;
        if let Some(ref id) = *cached {
            return Ok(id.clone());
        }
    }
    let profile_dir = calcula_profile_dir();
    let id = calp::identity_provider::load_or_create(&profile_dir)?;
    let mut cached = state.subscriber_identity.lock().map_err(|e| e.to_string())?;
    *cached = Some(id.clone());
    Ok(id)
}

/// Resolve the subscription that declares the given writeback region.
/// Returns (package_name, resolved_version, registry_path). This is what
/// makes multi-subscription workbooks submit to the right package — the
/// region id is looked up in each subscription's version manifest.
fn owning_subscription_for_region(
    state: &AppState,
    region_id: &str,
) -> Result<(String, String, String), String> {
    let subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
    for sub in &subs.subscriptions {
        if sub.version_pin == "dev" || sub.version_pin.starts_with("channel:") {
            continue;
        }
        let registry_path = subscription_registry_path(sub).to_string();
        let Ok(registry) =
            calp::registry::LocalRegistry::open(std::path::Path::new(&registry_path))
        else {
            continue;
        };
        let Ok(manifest) =
            registry.get_version_manifest(&sub.package_name, &sub.resolved_version)
        else {
            continue;
        };
        if let Some(ref regions) = manifest.writeback_regions {
            if regions.iter().any(|r| r.id == region_id) {
                return Ok((
                    sub.package_name.clone(),
                    sub.resolved_version.clone(),
                    registry_path,
                ));
            }
        }
    }
    Err(format!(
        "No subscription declares writeback region '{}'",
        region_id
    ))
}

/// Versions of a package strictly OLDER than `resolved_version` (semver
/// order). Used for lenient carry-forward — a subscriber pinned behind must
/// not see submissions made against newer versions.
fn older_package_versions(
    registry: &calp::registry::LocalRegistry,
    package_name: &str,
    resolved_version: &str,
) -> Vec<String> {
    let resolved = match calp::SemVer::parse(resolved_version) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    registry
        .get_package_manifest(package_name)
        .map(|m| {
            m.versions
                .iter()
                .map(|v| v.version.clone())
                .filter(|v| calp::SemVer::parse(v).map(|c| c < resolved).unwrap_or(false))
                .collect()
        })
        .unwrap_or_default()
}

/// Whether the registry already holds a Submitted/Approved record for this
/// slot from the current subscriber, in the resolved version or any older
/// one. One-shot/locked lifecycle policies must consult this: the local
/// writeback layer is volatile (reset when the workbook is reopened without
/// saving), so it alone cannot enforce "submit once".
fn registry_has_own_submission(state: &AppState, region_id: &str, row: u32, col: u32) -> bool {
    let Ok((package_name, resolved_version, registry_path)) =
        owning_subscription_for_region(state, region_id)
    else {
        return false;
    };
    let Ok(own) = get_subscriber_identity(state) else {
        return false;
    };
    let Ok(registry) =
        calp::registry::LocalRegistry::open(std::path::Path::new(&registry_path))
    else {
        return false;
    };
    let mut versions = vec![resolved_version.clone()];
    versions.extend(older_package_versions(&registry, &package_name, &resolved_version));
    versions.into_iter().any(|version| {
        registry
            .load_submissions(&package_name, &version, &own.id)
            .map(|subs| {
                subs.iter().any(|s| {
                    s.region_id == region_id
                        && s.cell_row == row
                        && s.cell_col == col
                        && matches!(
                            s.state,
                            calp::writeback::SubmissionState::Submitted
                                | calp::writeback::SubmissionState::Approved
                        )
                })
            })
            .unwrap_or(false)
    })
}

/// Drop the cached GATHER map after anything that changes submission data.
pub(crate) fn invalidate_gather_cache(state: &AppState) {
    if let Ok(mut cache) = state.gather_cache.lock() {
        *cache = None;
    }
}

/// True when the given deadline (ISO 8601, or datetime-local "YYYY-MM-DDTHH:MM")
/// has passed relative to `now` (RFC 3339).
fn deadline_passed(deadline: &str, now: &str) -> bool {
    use chrono::{DateTime, NaiveDateTime, Utc};
    let now_parsed = DateTime::parse_from_rfc3339(now).map(|d| d.with_timezone(&Utc));
    let deadline_parsed = DateTime::parse_from_rfc3339(deadline)
        .map(|d| d.with_timezone(&Utc))
        .or_else(|_| {
            NaiveDateTime::parse_from_str(deadline, "%Y-%m-%dT%H:%M").map(|n| n.and_utc())
        });
    match (now_parsed, deadline_parsed) {
        (Ok(n), Ok(d)) => n >= d,
        // Unparseable deadline: fall back to lexicographic comparison, which
        // is correct for identically-formatted UTC timestamps.
        _ => now >= deadline,
    }
}

/// Enforce a region's lifecycle policy for a new draft/submission.
/// `already_submitted` says whether this submitter already has a submitted
/// value for the cell in question.
fn check_lifecycle_policy(
    decl: &calp::WritebackRegionDeclaration,
    already_submitted: bool,
    now: &str,
) -> Result<(), String> {
    use calp::writeback::LifecyclePolicy;
    match &decl.lifecycle {
        None | Some(LifecyclePolicy::Always) => Ok(()),
        Some(LifecyclePolicy::UntilDeadline { deadline }) => {
            if let Some(deadline) = deadline {
                if deadline_passed(deadline, now) {
                    return Err(format!(
                        "The submission deadline for this region has passed ({}).",
                        deadline
                    ));
                }
            }
            Ok(())
        }
        Some(LifecyclePolicy::Never) => {
            if already_submitted {
                Err("This region is one-shot: the value was already submitted and cannot be changed.".to_string())
            } else {
                Ok(())
            }
        }
        Some(LifecyclePolicy::RequiresUnlock) => {
            if already_submitted {
                Err("This value was submitted and is locked. Ask the publisher to unlock it (publisher unlock is not yet supported).".to_string())
            } else {
                Ok(())
            }
        }
    }
}

/// Save a writeback draft for a cell in a writeback region.
/// Auto-mints a CellId if the cell doesn't have one yet.
/// Enforces the region's schema and lifecycle policy; regions with the
/// `immediate` submission policy are auto-submitted to the registry on save.
#[tauri::command]
pub fn calp_save_writeback_draft(
    state: State<AppState>,
    region_id: String,
    sheet_id: String,
    row: u32,
    col: u32,
    value: calp::writeback::SubmissionValue,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let sid = SheetId::parse(&sheet_id)
        .ok_or_else(|| format!("Invalid sheet_id: {}", sheet_id))?;

    // Verify the cell is in a writeback region — and in the CLAIMED region:
    // schema/lifecycle enforcement below resolves the declaration from the
    // caller-supplied id, so a mismatched id would validate against the wrong
    // declaration (or none at all, silently skipping enforcement).
    {
        let wb_index = state.writeback_index.lock().map_err(|e| e.to_string())?;
        match wb_index.region_id_at(sid, row, col) {
            Some(actual) if actual == region_id => {}
            Some(actual) => {
                return Err(format!(
                    "Cell ({}, {}) belongs to writeback region '{}', not '{}'",
                    row, col, actual, region_id
                ));
            }
            None => {
                return Err(format!("Cell ({}, {}) is not in a writeback region", row, col));
            }
        }
    }

    let now = chrono::Utc::now().to_rfc3339();

    // Look up the region declaration once for schema + policy enforcement.
    let decl = {
        let decls = state.writeback_declarations.lock().map_err(|e| e.to_string())?;
        decls.iter().find(|d| d.id == region_id).cloned()
    };

    if let Some(ref decl) = decl {
        // Validate value against the region's schema (if one is defined)
        if let Some(ref schema) = decl.schema {
            schema.validate(&value).map_err(|msg| {
                format!("Schema validation failed: {}", msg)
            })?;
        }

        // Enforce the lifecycle policy (deadline / one-shot / locked)
        let already_submitted = {
            let wb_layer = state.writeback_layer.lock().map_err(|e| e.to_string())?;
            wb_layer.drafts.iter().any(|d| {
                d.region_id == region_id
                    && d.cell_row == row
                    && d.cell_col == col
                    && matches!(
                        d.state,
                        calp::writeback::SubmissionState::Submitted
                            | calp::writeback::SubmissionState::Approved
                    )
            })
        };
        // One-shot/locked policies must also consult the authoritative
        // registry record — the local layer alone is defeated by reopening
        // the workbook without saving.
        let already_submitted = already_submitted
            || (matches!(
                decl.lifecycle,
                Some(calp::writeback::LifecyclePolicy::Never)
                    | Some(calp::writeback::LifecyclePolicy::RequiresUnlock)
            ) && registry_has_own_submission(&state, &region_id, row, col));
        check_lifecycle_policy(decl, already_submitted, &now)?;
    }

    // Get or mint a CellId for this cell
    let cell_id = {
        let mut id_reg = state.id_registry.lock().map_err(|e| e.to_string())?;
        id_reg.cell_id_at(sid, (row, col)).to_string()
    };

    // Get subscriber identity
    let submitter = get_subscriber_identity(&state)?;
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
        region_id: region_id.clone(),
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

    let auto_submit = matches!(
        decl.as_ref().and_then(|d| d.submission_policy.clone()),
        Some(calp::writeback::SubmissionPolicy::Immediate)
    );

    {
        let mut wb_layer = state.writeback_layer.lock().map_err(|e| e.to_string())?;
        wb_layer.set_draft(submission);
    }

    // `immediate` regions go straight to the registry — saving IS submitting.
    if auto_submit {
        submit_region_internal(&state, &region_id)?;
    }

    Ok(())
}

/// Get the writeback layer (all drafts) for the current workbook.
#[tauri::command]
pub fn calp_get_writeback_layer(
    state: State<AppState>,
    window: tauri::Window,
) -> Result<calp::writeback::WritebackLayer, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let layer = state.writeback_layer.lock().map_err(|e| e.to_string())?;
    Ok(layer.clone())
}

/// Submit all drafts for a region to the registry of the subscription that
/// actually declares the region.
///
/// Registry writes happen FIRST; local drafts are only advanced to Submitted
/// after every write succeeded. Advancing first would permanently mark values
/// as submitted that the registry never received (retry would be a no-op
/// because submit_region only advances Draft-state entries).
fn submit_region_internal(state: &AppState, region_id: &str) -> Result<usize, String> {
    let now = chrono::Utc::now().to_rfc3339();

    // Resolve the OWNING subscription for this region (not subscriptions[0]).
    let (package_name, resolved_version, registry_path) =
        owning_subscription_for_region(state, region_id)?;

    // Snapshot the drafts to submit, as they would look once submitted.
    let to_submit: Vec<calp::writeback::WritebackSubmission> = {
        let wb_layer = state.writeback_layer.lock().map_err(|e| e.to_string())?;
        wb_layer
            .drafts
            .iter()
            .filter(|d| {
                d.region_id == region_id
                    && matches!(d.state, calp::writeback::SubmissionState::Draft)
            })
            .map(|d| {
                let mut s = d.clone();
                s.state = calp::writeback::SubmissionState::Submitted;
                s.submitted_at = Some(now.clone());
                s.updated_at = now.clone();
                s
            })
            .collect()
    };

    if to_submit.is_empty() {
        return Ok(0);
    }

    // Write to registry BEFORE mutating local state.
    let registry = calp::registry::LocalRegistry::open(std::path::Path::new(&registry_path))
        .map_err(|e| e.to_string())?;

    for sub in &to_submit {
        registry.save_submission(&package_name, &resolved_version, sub)
            .map_err(|e| e.to_string())?;
    }

    // All writes succeeded — advance the local drafts.
    {
        let mut wb_layer = state.writeback_layer.lock().map_err(|e| e.to_string())?;
        wb_layer.submit_region(region_id, &now);
    }
    invalidate_gather_cache(state);

    let count = to_submit.len();

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

/// Submit all drafts for a region. The owning subscription's registry is
/// resolved from the region id — no registry path parameter needed.
#[tauri::command]
pub fn calp_submit_region(
    state: State<AppState>,
    region_id: String,
    window: tauri::Window,
) -> Result<usize, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    submit_region_internal(&state, &region_id)
}

/// One value that would leave the machine on submit.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboundValue {
    pub cell_row: u32,
    pub cell_col: u32,
    pub value_display: String,
    pub value_kind: String,
}

/// A read-only preview of EXACTLY what `calp_submit_region` would send: the
/// destination package + registry, the submitter identity it would be sent as,
/// and each draft value — so the user reviews what leaves the machine, to whom,
/// and as whom, BEFORE it leaves (transparency blind spot: outbound-data preview).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboundSubmissionPreview {
    pub region_id: String,
    pub package_name: String,
    pub resolved_version: String,
    pub registry_path: String,
    pub submitter_id: String,
    pub submitter_name: String,
    pub values: Vec<OutboundValue>,
}

/// Mirror `submit_region_internal`'s resolution + draft snapshot WITHOUT writing,
/// so the UI can show an outbound-data preview + confirm step before submitting.
#[tauri::command]
pub fn calp_preview_region_submission(
    state: State<AppState>,
    region_id: String,
    window: tauri::Window,
) -> Result<OutboundSubmissionPreview, String> {
    use calp::writeback::{SubmissionState, SubmissionValue};
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;

    // Same owning-subscription resolution the real submit uses (not subscriptions[0]).
    let (package_name, resolved_version, registry_path) =
        owning_subscription_for_region(&state, &region_id)?;
    // The identity the submission would be sent as.
    let identity = get_subscriber_identity(&state)?;

    // Exactly the drafts submit_region_internal would send: Draft state, this region.
    let values: Vec<OutboundValue> = {
        let wb_layer = state.writeback_layer.lock().map_err(|e| e.to_string())?;
        wb_layer
            .drafts
            .iter()
            .filter(|d| {
                d.region_id == region_id && matches!(d.state, SubmissionState::Draft)
            })
            .map(|d| {
                let (value_display, value_kind) = match &d.value {
                    SubmissionValue::Number { value } => (value.to_string(), "number"),
                    SubmissionValue::Text { value } => (value.clone(), "text"),
                    SubmissionValue::Boolean { value } => {
                        ((if *value { "TRUE" } else { "FALSE" }).to_string(), "boolean")
                    }
                    SubmissionValue::Empty => (String::new(), "empty"),
                };
                OutboundValue {
                    cell_row: d.cell_row,
                    cell_col: d.cell_col,
                    value_display,
                    value_kind: value_kind.to_string(),
                }
            })
            .collect()
    };

    Ok(OutboundSubmissionPreview {
        region_id,
        package_name,
        resolved_version,
        registry_path,
        submitter_id: identity.id,
        submitter_name: identity.display_name,
        values,
    })
}

/// Render a published package version to a self-contained HTML string the
/// recipient can open WITHOUT Calcula (recipient reach). `mode` is "static" (a
/// stacked, print-ready report) or "viewer" (a multi-sheet tabbed viewer). The
/// frontend then saves the string as .html or opens it for print-to-PDF.
#[tauri::command]
pub fn calp_export_package_html(
    registry_path: String,
    package_name: String,
    version: String,
    mode: String,
    window: tauri::Window,
) -> Result<String, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let path = registry_path
        .strip_prefix("file://")
        .unwrap_or(&registry_path);
    let registry = calp::registry::LocalRegistry::open(std::path::Path::new(path))
        .map_err(|e| e.to_string())?;
    let export_mode = match mode.as_str() {
        "viewer" => calp::HtmlExportMode::Viewer,
        _ => calp::HtmlExportMode::Static,
    };
    let opts = calp::HtmlExportOptions { mode: export_mode };
    calp::render_package_html(&registry, &package_name, &version, &opts).map_err(|e| e.to_string())
}

/// Approve or reject a submitted writeback value (publisher action).
/// Rewrites the submission's registry file with the new state; `on_approval`
/// regions only aggregate Approved submissions in GATHER.
#[tauri::command]
pub fn calp_set_submission_state(
    state: State<AppState>,
    region_id: String,
    submitter_id: String,
    cell_row: u32,
    cell_col: u32,
    new_state: String,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let target_state = match new_state.as_str() {
        "approved" => calp::writeback::SubmissionState::Approved,
        "rejected" => calp::writeback::SubmissionState::Rejected,
        "submitted" => calp::writeback::SubmissionState::Submitted,
        _ => {
            return Err(format!(
                "Invalid submission state '{}'. Must be 'approved', 'rejected', or 'submitted'",
                new_state
            ))
        }
    };

    let (package_name, resolved_version, registry_path) =
        owning_subscription_for_region(&state, &region_id)?;
    let registry = calp::registry::LocalRegistry::open(std::path::Path::new(&registry_path))
        .map_err(|e| e.to_string())?;

    // Search the resolved version first, then older ones: lenient regions
    // carry submissions forward across version bumps, and those records live
    // in the version directory they were submitted against — they must be
    // approvable (and rewritten) where they actually are.
    let mut versions = vec![resolved_version.clone()];
    versions.extend(older_package_versions(&registry, &package_name, &resolved_version));

    let mut found: Option<(String, calp::writeback::WritebackSubmission)> = None;
    for version in &versions {
        let Ok(submissions) = registry.load_submissions(&package_name, version, &submitter_id)
        else {
            continue;
        };
        if let Some(s) = submissions.into_iter().find(|s| {
            s.region_id == region_id && s.cell_row == cell_row && s.cell_col == cell_col
        }) {
            found = Some((version.clone(), s));
            break;
        }
    }
    let (version, mut submission) = found.ok_or_else(|| {
        format!(
            "No submission found for region '{}' cell ({}, {}) by submitter '{}'",
            region_id, cell_row, cell_col, submitter_id
        )
    })?;

    let now = chrono::Utc::now().to_rfc3339();
    submission.state = target_state;
    submission.updated_at = now;

    registry
        .save_submission(&package_name, &version, &submission)
        .map_err(|e| e.to_string())?;
    invalidate_gather_cache(&state);
    Ok(())
}

/// A submission row for the publisher data-collection dashboard (D5).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionSubmissionInfo {
    pub region_id: String,
    pub cell_row: u32,
    pub cell_col: u32,
    pub submitter_id: String,
    pub submitter_name: String,
    pub value_display: String,
    pub value_kind: String,
    pub state: String,
    pub submitted_at: Option<String>,
    pub updated_at: String,
}

/// Load EVERY submission for a writeback region across all submitters — the
/// publisher's "see all" view for the data-collection dashboard (D5). Unlike the
/// GATHER path, this is not filtered by per-subscriber visibility: a region's
/// owner manages all of it. Resolves the owning subscription (package + version +
/// registry) for the region, then collects the current record per (submitter,
/// cell) slot across the resolved version and older ones (lenient carry-forward).
#[tauri::command]
pub fn calp_load_region_submissions(
    state: State<AppState>,
    region_id: String,
    window: tauri::Window,
) -> Result<Vec<RegionSubmissionInfo>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    use calp::writeback::{SubmissionState, SubmissionValue};

    let (package_name, resolved_version, registry_path) =
        owning_subscription_for_region(&state, &region_id)?;
    let registry = calp::registry::LocalRegistry::open(std::path::Path::new(&registry_path))
        .map_err(|e| e.to_string())?;

    let mut versions = vec![resolved_version.clone()];
    versions.extend(older_package_versions(&registry, &package_name, &resolved_version));

    // Newest version first: keep the current record per (submitter, cell) slot.
    let mut by_slot: std::collections::HashMap<(String, u32, u32), calp::writeback::WritebackSubmission> =
        std::collections::HashMap::new();
    for version in &versions {
        if let Ok(subs) = registry.load_region_submissions(&package_name, version, &region_id) {
            for s in subs {
                by_slot
                    .entry((s.submitter.id.clone(), s.cell_row, s.cell_col))
                    .or_insert(s);
            }
        }
    }

    let mut out: Vec<RegionSubmissionInfo> = by_slot
        .into_values()
        .map(|s| {
            let (value_display, value_kind) = match &s.value {
                SubmissionValue::Number { value } => (value.to_string(), "number"),
                SubmissionValue::Text { value } => (value.clone(), "text"),
                SubmissionValue::Boolean { value } => {
                    ((if *value { "TRUE" } else { "FALSE" }).to_string(), "boolean")
                }
                SubmissionValue::Empty => (String::new(), "empty"),
            };
            let state = match s.state {
                SubmissionState::Draft => "draft",
                SubmissionState::Submitted => "submitted",
                SubmissionState::Approved => "approved",
                SubmissionState::Rejected => "rejected",
            };
            RegionSubmissionInfo {
                region_id: s.region_id,
                cell_row: s.cell_row,
                cell_col: s.cell_col,
                submitter_id: s.submitter.id,
                submitter_name: s.submitter.display_name,
                value_display,
                value_kind: value_kind.to_string(),
                state: state.to_string(),
                submitted_at: s.submitted_at,
                updated_at: s.updated_at,
            }
        })
        .collect();
    // Stable ordering: by submitter then cell.
    out.sort_by(|a, b| {
        a.submitter_name
            .cmp(&b.submitter_name)
            .then(a.cell_row.cmp(&b.cell_row))
            .then(a.cell_col.cmp(&b.cell_col))
    });
    Ok(out)
}

/// Apply a region's GATHER governance to its submissions: approval gating,
/// drop cleared cells, then visibility (own_only hides others; own_plus_aggregate
/// keeps values but anonymizes other submitters). Pure + unit-tested — this is the
/// privacy boundary, so it must never silently change.
fn apply_gather_governance(
    mut submissions: Vec<calp::writeback::WritebackSubmission>,
    region: &calp::WritebackRegionDeclaration,
    own_identity: Option<&calp::SubmitterIdentity>,
) -> Vec<calp::writeback::WritebackSubmission> {
    // Approval gating: rejected submissions never count; under
    // on_approval only Approved submissions join the aggregate.
    let require_approval = matches!(
        region.submission_policy,
        Some(calp::writeback::SubmissionPolicy::OnApproval)
    );
    submissions.retain(|s| match s.state {
        calp::writeback::SubmissionState::Rejected
        | calp::writeback::SubmissionState::Draft => false,
        calp::writeback::SubmissionState::Submitted => !require_approval,
        calp::writeback::SubmissionState::Approved => true,
    });

    // A cleared cell is "no submission", not a zero — counting it
    // would skew AVERAGE/COUNT/SUBMITTERS aggregates.
    submissions.retain(|s| !matches!(s.value, calp::writeback::SubmissionValue::Empty));

    // Visibility enforcement. NOTE: the policy docs say "publisher
    // sees all", but without authenticated identities (roadmap D8)
    // every gatherer is a subscriber, so the policy applies to all.
    match region.visibility {
        Some(calp::writeback::VisibilityPolicy::OwnOnly) => {
            submissions.retain(|s| {
                own_identity
                    .map(|own| s.submitter.id == own.id)
                    .unwrap_or(false)
            });
        }
        Some(calp::writeback::VisibilityPolicy::OwnPlusAggregate) => {
            // Values flow (aggregates need them) but other
            // submitters' identities are anonymized.
            for s in submissions.iter_mut() {
                let is_own = own_identity
                    .map(|own| s.submitter.id == own.id)
                    .unwrap_or(false);
                if !is_own {
                    s.submitter.display_name = "(anonymous)".to_string();
                    s.submitter.id = String::new();
                }
            }
        }
        _ => {}
    }

    submissions
}

/// Build a GatherRegionData map from the current subscriptions for formula evaluation.
/// This is the pre-fetch step: load all submission data from the registry once,
/// so GATHER functions can look it up synchronously during evaluation.
pub fn build_gather_data(state: &AppState) -> std::collections::HashMap<String, engine::GatherRegionData> {
    let mut result = std::collections::HashMap::new();

    // Fast path: no writeback regions known to this workbook — skip all
    // registry I/O. This is called on every cell edit and recalculation pass,
    // so it must be free for ordinary workbooks. (Declarations are rebuilt at
    // pull, refresh, and workbook open.)
    if state
        .writeback_declarations
        .lock()
        .map(|d| d.is_empty())
        .unwrap_or(true)
    {
        return result;
    }

    // Short-TTL cache: this runs on every edit and recalc pass; without it,
    // each keystroke rescans every submission file in every subscribed
    // registry. A TTL (rather than pure event-invalidation) keeps OTHER
    // subscribers' new submissions appearing without an explicit action;
    // local mutations invalidate eagerly via invalidate_gather_cache.
    const GATHER_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(2);
    if let Ok(cache) = state.gather_cache.lock() {
        if let Some((stamp, cached)) = cache.as_ref() {
            if stamp.elapsed() < GATHER_CACHE_TTL {
                return cached.clone();
            }
        }
    }

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

        // Load the resolved version's submissions in ONE tree scan and bucket
        // by region — per-region loads would rescan everything R times.
        let mut current_by_region: std::collections::HashMap<String, Vec<calp::writeback::WritebackSubmission>> =
            std::collections::HashMap::new();
        match registry.load_all_submissions(&sub.package_name, &sub.resolved_version) {
            Ok(all) => {
                for s in all {
                    current_by_region.entry(s.region_id.clone()).or_default().push(s);
                }
            }
            Err(_) => continue,
        }

        // Strictly OLDER versions, each loaded once: their region
        // declarations (for the schema-compatibility gate) and their
        // submissions bucketed by region.
        let older: Vec<(Vec<calp::WritebackRegionDeclaration>, std::collections::HashMap<String, Vec<calp::writeback::WritebackSubmission>>)> =
            older_package_versions(&registry, &sub.package_name, &sub.resolved_version)
                .iter()
                .filter_map(|version| {
                    let manifest = registry
                        .get_version_manifest(&sub.package_name, version)
                        .ok()?;
                    let mut by_region: std::collections::HashMap<String, Vec<calp::writeback::WritebackSubmission>> =
                        std::collections::HashMap::new();
                    for s in registry.load_all_submissions(&sub.package_name, version).ok()? {
                        by_region.entry(s.region_id.clone()).or_default().push(s);
                    }
                    Some((manifest.writeback_regions.unwrap_or_default(), by_region))
                })
                .collect();

        // The reader's own identity, for visibility enforcement.
        let own_identity = get_subscriber_identity(state).ok();

        // Aggregate per region
        for region in regions {
            let mut submissions = current_by_region.remove(&region.id).unwrap_or_default();

            // Lenient version binding: submissions made against earlier
            // versions of the same region carry forward instead of being
            // silently dropped on every version bump — but only when that
            // version's region schema is compatible with the current one.
            // Newest wins per (submitter, cell) slot.
            let lenient = !matches!(
                region.version_binding,
                Some(calp::writeback::VersionBinding::Strict)
            );
            if lenient && !older.is_empty() {
                let mut slots: std::collections::HashMap<(String, u32, u32), usize> =
                    submissions
                        .iter()
                        .enumerate()
                        .map(|(i, s)| ((s.submitter.id.clone(), s.cell_row, s.cell_col), i))
                        .collect();
                for (old_regions, old_by_region) in &older {
                    // Schema gate, matching check_region_compatibility: both
                    // schemas present → compare; either absent → compatible;
                    // region absent in that version → nothing to carry.
                    let compatible = match old_regions.iter().find(|r| r.id == region.id) {
                        None => false,
                        Some(old_r) => match (&old_r.schema, &region.schema) {
                            (Some(old_s), Some(new_s)) => old_s.is_compatible_with(new_s),
                            _ => true,
                        },
                    };
                    if !compatible {
                        continue;
                    }
                    let Some(older_subs) = old_by_region.get(&region.id) else {
                        continue;
                    };
                    for candidate in older_subs.iter().cloned() {
                        let key = (
                            candidate.submitter.id.clone(),
                            candidate.cell_row,
                            candidate.cell_col,
                        );
                        match slots.get(&key) {
                            Some(&i) => {
                                if candidate.updated_at > submissions[i].updated_at {
                                    submissions[i] = candidate;
                                }
                            }
                            None => {
                                submissions.push(candidate);
                                slots.insert(key, submissions.len() - 1);
                            }
                        }
                    }
                }
            }

            let submissions = apply_gather_governance(submissions, region, own_identity.as_ref());

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

            // First subscription declaring a region wins, matching the
            // submit path (owning_subscription_for_region) — last-wins here
            // would read a different registry than submits write to.
            result
                .entry(region.id.clone())
                .or_insert(engine::GatherRegionData { submissions: gather_subs });
        }
    }

    if let Ok(mut cache) = state.gather_cache.lock() {
        *cache = Some((std::time::Instant::now(), result.clone()));
    }

    result
}

#[cfg(test)]
mod gather_governance_tests {
    //! Unit tests for `apply_gather_governance` — the writeback privacy/approval
    //! boundary extracted (behavior-preserving) out of `build_gather_data`. This
    //! is the GATHER governance safety net (roadmap D4 / D10): it must never
    //! silently change which submissions are visible or whether other
    //! submitters' identities leak.
    use super::apply_gather_governance;
    use std::collections::HashMap;

    use calp::writeback::{
        RegionSelector, SubmissionPolicy, SubmissionState, SubmissionValue, VisibilityPolicy,
        WritebackRegionDeclaration, WritebackSubmission,
    };
    use calp::SubmitterIdentity;

    fn make_identity(id: &str, name: &str) -> SubmitterIdentity {
        SubmitterIdentity {
            display_name: name.to_string(),
            id: id.to_string(),
            extra: HashMap::new(),
        }
    }

    /// Build a submission for the "r" region at cell (0,0) from one submitter
    /// with a given state and value. Only the fields the governance step reads
    /// (submitter, value, state) vary; the rest are stable filler.
    fn make_submission(
        submitter_id: &str,
        name: &str,
        state: SubmissionState,
        value: SubmissionValue,
    ) -> WritebackSubmission {
        WritebackSubmission {
            id: format!("sub-{submitter_id}"),
            region_id: "r".to_string(),
            cell_row: 0,
            cell_col: 0,
            cell_id: None,
            submitter: make_identity(submitter_id, name),
            value,
            state,
            created_at: "2026-06-15T00:00:00Z".to_string(),
            updated_at: "2026-06-15T00:00:00Z".to_string(),
            submitted_at: None,
            extra: HashMap::new(),
        }
    }

    /// Build a region declaration carrying only the two governance-relevant
    /// policies; the selector is a 1x1 placeholder (governance ignores it).
    fn make_region(
        visibility: Option<VisibilityPolicy>,
        policy: Option<SubmissionPolicy>,
    ) -> WritebackRegionDeclaration {
        let sheet_id = identity::SheetId::from_bytes(identity::generate_uuid_v7());
        WritebackRegionDeclaration {
            id: "r".to_string(),
            selector: RegionSelector {
                sheet_id,
                row_start: 0,
                row_end: 0,
                col_start: 0,
                col_end: 0,
            },
            mode: None,
            schema: None,
            visibility,
            submission_policy: policy,
            version_binding: None,
            lifecycle: None,
            aggregation_hint: None,
            extra: HashMap::new(),
        }
    }

    fn num(v: f64) -> SubmissionValue {
        SubmissionValue::Number { value: v }
    }

    // 1. OnApproval: a Submitted submission is EXCLUDED, an Approved one INCLUDED.
    #[test]
    fn on_approval_excludes_submitted_includes_approved() {
        let region = make_region(None, Some(SubmissionPolicy::OnApproval));
        let subs = vec![
            make_submission("alice", "Alice", SubmissionState::Submitted, num(10.0)),
            make_submission("bob", "Bob", SubmissionState::Approved, num(20.0)),
        ];
        let out = apply_gather_governance(subs, &region, None);
        assert_eq!(out.len(), 1, "only the Approved submission survives on_approval");
        assert_eq!(out[0].submitter.id, "bob");
        assert!(matches!(out[0].value, SubmissionValue::Number { value } if value == 20.0));
    }

    // 2. Immediate / OnSubmit / None: a Submitted submission is INCLUDED.
    #[test]
    fn non_approval_policies_include_submitted() {
        for policy in [
            None,
            Some(SubmissionPolicy::Immediate),
            Some(SubmissionPolicy::OnSubmit),
        ] {
            let region = make_region(None, policy.clone());
            let subs = vec![make_submission(
                "alice",
                "Alice",
                SubmissionState::Submitted,
                num(10.0),
            )];
            let out = apply_gather_governance(subs, &region, None);
            assert_eq!(
                out.len(),
                1,
                "Submitted must be included under policy {policy:?}"
            );
        }
    }

    // 3. Rejected and Draft: always EXCLUDED regardless of policy.
    #[test]
    fn rejected_and_draft_always_excluded() {
        for policy in [
            None,
            Some(SubmissionPolicy::Immediate),
            Some(SubmissionPolicy::OnSubmit),
            Some(SubmissionPolicy::OnApproval),
        ] {
            let region = make_region(None, policy.clone());
            let subs = vec![
                make_submission("a", "A", SubmissionState::Rejected, num(1.0)),
                make_submission("b", "B", SubmissionState::Draft, num(2.0)),
            ];
            let out = apply_gather_governance(subs, &region, None);
            assert!(
                out.is_empty(),
                "Rejected + Draft must both be dropped under policy {policy:?}"
            );
        }
    }

    // 4. Empty value: EXCLUDED (a cleared cell is "no submission", not a zero).
    #[test]
    fn empty_value_excluded() {
        let region = make_region(None, None);
        let subs = vec![
            make_submission("a", "A", SubmissionState::Submitted, SubmissionValue::Empty),
            make_submission("b", "B", SubmissionState::Submitted, num(5.0)),
        ];
        let out = apply_gather_governance(subs, &region, None);
        assert_eq!(out.len(), 1, "the Empty submission is dropped");
        assert_eq!(out[0].submitter.id, "b");
    }

    // 5. OwnOnly: with own_identity = Alice, only Alice's submissions remain.
    #[test]
    fn own_only_keeps_only_own() {
        let region = make_region(Some(VisibilityPolicy::OwnOnly), None);
        let alice = make_identity("id-alice", "Alice");
        let subs = vec![
            make_submission("id-alice", "Alice", SubmissionState::Submitted, num(10.0)),
            make_submission("id-bob", "Bob", SubmissionState::Submitted, num(20.0)),
        ];
        let out = apply_gather_governance(subs, &region, Some(&alice));
        assert_eq!(out.len(), 1, "only Alice's own submission remains");
        assert_eq!(out[0].submitter.id, "id-alice");
        assert_eq!(out[0].submitter.display_name, "Alice");
    }

    // 6. OwnPlusAggregate: Bob's value REMAINS but his identity is anonymized;
    //    Alice's own row is untouched (real id + name).
    #[test]
    fn own_plus_aggregate_anonymizes_others_keeps_values() {
        let region = make_region(Some(VisibilityPolicy::OwnPlusAggregate), None);
        let alice = make_identity("id-alice", "Alice");
        let subs = vec![
            make_submission("id-alice", "Alice", SubmissionState::Submitted, num(10.0)),
            make_submission("id-bob", "Bob", SubmissionState::Submitted, num(20.0)),
        ];
        let out = apply_gather_governance(subs, &region, Some(&alice));
        assert_eq!(out.len(), 2, "both values flow into the aggregate");

        let own = out.iter().find(|s| s.submitter.id == "id-alice").expect("own row present");
        assert_eq!(own.submitter.display_name, "Alice", "own identity untouched");
        assert!(matches!(own.value, SubmissionValue::Number { value } if value == 10.0));

        let other = out
            .iter()
            .find(|s| matches!(s.value, SubmissionValue::Number { value } if value == 20.0))
            .expect("Bob's value preserved");
        assert_eq!(other.submitter.display_name, "(anonymous)", "Bob's name anonymized");
        assert_eq!(other.submitter.id, "", "Bob's id cleared");
    }

    // 7. Transparent / None visibility: all submissions remain with real identities.
    #[test]
    fn transparent_and_none_keep_real_identities() {
        for visibility in [None, Some(VisibilityPolicy::Transparent)] {
            let region = make_region(visibility.clone(), None);
            let alice = make_identity("id-alice", "Alice");
            let subs = vec![
                make_submission("id-alice", "Alice", SubmissionState::Submitted, num(10.0)),
                make_submission("id-bob", "Bob", SubmissionState::Submitted, num(20.0)),
            ];
            let out = apply_gather_governance(subs, &region, Some(&alice));
            assert_eq!(out.len(), 2, "all submissions remain under {visibility:?}");
            let bob = out.iter().find(|s| s.submitter.id == "id-bob").expect("Bob present");
            assert_eq!(bob.submitter.display_name, "Bob", "Bob's real name kept under {visibility:?}");
        }
    }

    // 8. own_identity = None + OwnOnly: everything is dropped (no own to match) —
    //    documents the fail-closed behavior.
    #[test]
    fn own_only_with_no_identity_drops_everything() {
        let region = make_region(Some(VisibilityPolicy::OwnOnly), None);
        let subs = vec![
            make_submission("id-alice", "Alice", SubmissionState::Submitted, num(10.0)),
            make_submission("id-bob", "Bob", SubmissionState::Submitted, num(20.0)),
        ];
        let out = apply_gather_governance(subs, &region, None);
        assert!(
            out.is_empty(),
            "without an own identity, own_only fails closed and reveals nothing"
        );
    }
}

/// Look up the CellId at a position without minting. Returns null if none exists.
#[tauri::command]
pub fn calp_get_cell_id(
    state: State<AppState>,
    sheet_id: String,
    row: u32,
    col: u32,
    window: tauri::Window,
) -> Result<Option<String>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let sid = SheetId::parse(&sheet_id)
        .ok_or_else(|| format!("Invalid sheet_id: {}", sheet_id))?;
    let reg = state.id_registry.lock().map_err(|e| e.to_string())?;
    Ok(reg.lookup_cell_id(sid, (row, col)).map(|id| id.to_string()))
}

/// Get the current subscriber identity (creates one on first call).
#[tauri::command]
pub fn calp_get_subscriber_identity(
    state: State<AppState>,
    window: tauri::Window,
) -> Result<calp::SubmitterIdentity, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    get_subscriber_identity(&state)
}

/// Suggest the next version for a package given a bump type ("major", "minor", "patch").
#[tauri::command]
pub fn calp_next_version(
    registry_path: String,
    package_name: String,
    bump: String,
    window: tauri::Window,
) -> Result<String, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
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

/// Connection spec info extracted from a model's connectionSpecs.
pub struct ConnectionSpecInfo {
    pub server: String,
    pub database: String,
    pub connector_type: String,
    pub preferred_auth: String,
}

/// Extract server, database, connector type, and preferred auth from a model's connectionSpecs.
pub fn extract_connection_spec_info(model_json: &serde_json::Value) -> ConnectionSpecInfo {
    if let Some(specs) = model_json.get("connectionSpecs").and_then(|s| s.as_array()) {
        if let Some(spec) = specs.first() {
            let connector_type = spec.get("connectorType")
                .and_then(|v| v.as_str())
                .unwrap_or("PostgreSQL")
                .to_string();
            let preferred_auth = spec.get("preferred_auth")
                .and_then(|v| v.as_str())
                .unwrap_or("UsernamePassword")
                .to_string();
            if let Some(target) = spec.get("target") {
                let host = target.get("host").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let port = target.get("port").and_then(|v| v.as_u64()).map(|p| p as u16);
                let database = target.get("database").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let server = if let Some(p) = port {
                    if p != 5432 { format!("{}:{}", host, p) } else { host }
                } else {
                    host
                };
                return ConnectionSpecInfo { server, database, connector_type, preferred_auth };
            }
        }
    }
    ConnectionSpecInfo {
        server: String::new(),
        database: String::new(),
        connector_type: String::new(),
        preferred_auth: String::new(),
    }
}

/// Load embedded BI model data sources from a pulled package into BiState.
/// Returns a mapping from package data source ID to the created connection ID.
fn load_embedded_data_sources(
    data_sources: &[calp::pull::PulledDataSource],
    bi_state: &BiState,
) -> std::collections::HashMap<String, crate::bi::types::ConnectionId> {
    use crate::bi::types::{Connection, ConnectionType};
    use crate::bi::engine_registry::ModelKey;

    let mut ds_to_conn: std::collections::HashMap<String, crate::bi::types::ConnectionId> =
        std::collections::HashMap::new();

    for ds in data_sources {
        let model_path = ds.model_path.to_string_lossy().to_string();

        // Read the raw JSON to access both ModelBundle wrapper and DataModel
        let json_str = match std::fs::read_to_string(&ds.model_path) {
            Ok(s) => s,
            Err(e) => {
                crate::log_warn!("CALP", "Failed to read embedded model {}: {}", model_path, e);
                continue;
            }
        };
        let json_value: serde_json::Value = match serde_json::from_str(&json_str) {
            Ok(v) => v,
            Err(e) => {
                crate::log_warn!("CALP", "Failed to parse embedded model JSON {}: {}", model_path, e);
                continue;
            }
        };

        // Extract connection info from connectionSpecs (ModelBundle wrapper level)
        let spec_info = extract_connection_spec_info(&json_value);
        crate::log_info!("CALP-DIAG", "load_embedded_data_sources: ds_id={}, spec_info: server='{}', database='{}', preferred_auth='{}', connector_type='{}'",
            ds.definition.id, spec_info.server, spec_info.database, spec_info.preferred_auth, spec_info.connector_type);

        // Parse the DataModel from the JSON (handles both ModelBundle and raw format)
        let model_json = if json_value.get("model").is_some() && json_value.get("formatVersion").is_some() {
            json_value.get("model").unwrap().clone()
        } else {
            json_value
        };
        if let Err(e) = crate::bi::commands::check_model_format_version(&model_json) {
            crate::log_warn!("CALP", "Skipping data source {}: {}", ds.definition.id, e);
            continue;
        }
        let model: bi_engine::DataModel = match serde_json::from_value(model_json) {
            Ok(m) => m,
            Err(e) => {
                crate::log_warn!("CALP", "Failed to deserialize DataModel {}: {}", model_path, e);
                continue;
            }
        };

        // Create the BI engine (no database connection yet)
        let mut engine = bi_engine::Engine::new(model);
        engine.set_auto_tier_config(bi_engine::AutoTierConfig {
            enabled: true,
            max_rows: 100_000,
            default_ttl_secs: 3600,
        });
        engine.set_query_cache_config(bi_engine::QueryCacheConfig {
            enabled: true,
            max_entries: 256,
            max_memory_bytes: 64 * 1024 * 1024,
            ttl_secs: 300,
        });

        let model_key = ModelKey::from_model_path(&model_path);
        let (engine_arc, _was_existing, _cache_dir) =
            bi_state.engine_registry.get_or_create(&model_key, engine);

        // Allocate a connection ID and register the connection
        let conn_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());

        // Build bindings from the package definition
        let bindings: Vec<crate::bi::types::BiBindRequest> = ds.definition.bindings.iter().map(|b| {
            crate::bi::types::BiBindRequest {
                model_table: b.model_table.clone(),
                schema: b.schema.clone(),
                source_table: b.source_table.clone(),
            }
        }).collect();

        // Use server/database from model's connectionSpecs, falling back to package metadata
        let conn_server = if !spec_info.server.is_empty() { spec_info.server.clone() } else { ds.definition.server.clone() };
        let conn_database = if !spec_info.database.is_empty() { spec_info.database.clone() } else { ds.definition.database.clone() };
        let conn_preferred_auth = spec_info.preferred_auth.clone();

        // Derive the connection type from the model's connectionSpecs,
        // falling back to the package manifest. (Previously hardcoded to
        // PostgreSQL regardless of what the package declared.)
        let conn_type = if !spec_info.connector_type.is_empty() {
            ConnectionType::parse_or_default(&spec_info.connector_type)
        } else {
            ConnectionType::parse_or_default(&ds.definition.connection_type)
        };

        let connection = Connection {
            id: conn_id,
            name: ds.definition.name.clone(),
            description: format!("Embedded model from package ({})", ds.definition.id),
            connection_type: conn_type,
            connection_string: String::new(), // subscriber provides credentials via Connect
            server: conn_server.clone(),
            database: conn_database.clone(),
            preferred_auth: conn_preferred_auth.clone(),
            model_path: Some(model_path),
            engine: Some(engine_arc),
            model_key: Some(model_key),
            connector_index: None,
            bindings,
            last_refreshed: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            is_connected: false,
            active_queries: std::collections::HashMap::new(),
            package_data_source_id: Some(ds.definition.id.clone()),
            active_role: None,
        };

        bi_state.connections.lock().unwrap().insert(conn_id, connection);
        ds_to_conn.insert(ds.definition.id.clone(), conn_id);

        crate::log_info!(
            "CALP-DIAG",
            "Created BI connection: conn_id={}, name='{}', ds_id='{}', server='{}', database='{}', preferred_auth='{}', conn_str='{}'",
            conn_id,
            ds.definition.name,
            ds.definition.id,
            conn_server,
            conn_database,
            conn_preferred_auth,
            "(empty — awaiting credentials)"
        );
    }

    ds_to_conn
}

/// Restore pivot definitions from a pulled .calp package: deserialize, rebuild
/// cache from source grid data, calculate the view, and write output cells.
fn restore_pulled_pivots(
    pivot_defs: &[persistence::SavedPivotDefinition],
    bi_pivot_metadata: &[serde_json::Value],
    state: &AppState,
    pivot_state: &crate::pivot::types::PivotState,
    sheet_offset: usize,
    embedded_connection_ids: &std::collections::HashMap<String, crate::bi::types::ConnectionId>,
) {
    use pivot_engine::{PivotCache, PivotDefinition};
    use crate::pivot::operations::{build_cache_from_grid, safe_calculate_pivot, write_pivot_to_grid, update_pivot_region};
    use crate::pivot::types::{BiPivotMetadata, SavedBiPivotMetadata};

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
        let mut def: PivotDefinition = match serde_json::from_value(saved.definition.clone()) {
            Ok(d) => d,
            Err(e) => {
                crate::log_warn!("CALP", "Failed to deserialize pivot definition {}: {}", saved.id, e);
                continue;
            }
        };

        let pivot_id = def.id;

        // For BI pivots, ensure the source display shows the model name, not a grid range
        if saved.source_type == "bi" && def.source_range_display.is_none() {
            def.source_range_display = Some("BI Model".to_string());
        }

        // Build cache — try grid data first (even for BI pivots, the package
        // includes a snapshot of the data), fall back to empty cache.
        let source_sheet_idx = saved.source_sheet_index.map(|i| i + sheet_offset);
        let (mut cache, _field_names) = if let Some(idx) = source_sheet_idx {
            if let Some(source_grid) = grids.get(idx) {
                match build_cache_from_grid(
                    source_grid,
                    def.source_start,
                    def.source_end,
                    def.source_has_headers,
                ) {
                    Ok(result) => result,
                    Err(e) => {
                        crate::log_warn!("CALP", "Failed to build cache for pivot {}: {}", pivot_id, e);
                        (PivotCache::new(pivot_id, 0), Vec::new())
                    }
                }
            } else {
                crate::log_warn!("CALP", "Source sheet {} not found for pivot {}", idx, pivot_id);
                (PivotCache::new(pivot_id, 0), Vec::new())
            }
        } else {
            // No source sheet — empty cache (BI pivot without snapshot data)
            (PivotCache::new(pivot_id, 0), Vec::new())
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

        // Register the protected region so the frontend can discover this pivot
        update_pivot_region(state, pivot_id, dest_sheet_idx, def.destination, &view);

        // Store in PivotState
        pivot_tables.insert(pivot_id, (def, cache));
    }

    // Restore BI pivot metadata, resolving connection_id from embedded data sources
    if !bi_pivot_metadata.is_empty() {
        crate::log_info!("CALP-DIAG", "Restoring BI metadata: {} entries, embedded_connection_ids={:?}",
            bi_pivot_metadata.len(), embedded_connection_ids);

        if let Ok(mut bi_meta) = pivot_state.bi_metadata.lock() {
            for meta_json in bi_pivot_metadata {
                if let Ok(saved) = serde_json::from_value::<SavedBiPivotMetadata>(meta_json.clone()) {
                    // Route each pivot to ITS package data source. Packages
                    // published before data_source_id existed fall back to
                    // the first embedded connection (single-source packages
                    // are unaffected; multi-source ones should republish).
                    let conn_id = saved
                        .data_source_id
                        .as_deref()
                        .and_then(|id| embedded_connection_ids.get(id))
                        .copied()
                        .or_else(|| embedded_connection_ids.values().next().copied())
                        .unwrap_or_default();
                    crate::log_info!("CALP-DIAG", "  BI metadata: pivot_id={}, tables={}, measures={}, data_source_id={:?}, assigned connection_id={}",
                        saved.pivot_id, saved.model_tables.len(), saved.measures.len(), saved.data_source_id, conn_id);
                    bi_meta.insert(saved.pivot_id, BiPivotMetadata {
                        connection_id: conn_id,
                        // Keep the PACKAGE data source id so re-saves and
                        // re-publishes keep routing this pivot correctly.
                        data_source_id: saved.data_source_id.clone(),
                        model_tables: saved.model_tables,
                        measures: saved.measures,
                        hierarchies: saved.hierarchies,
                        calculation_groups: saved.calculation_groups,
                        applied_calc_group: saved.applied_calc_group,
                        last_query: None,
                        lookup_columns: saved.lookup_columns.into_iter().collect(),
                        drill_through: saved.drill_through,
                    });
                }
            }
        }
    }
}

// ============================================================================
// Capture BI Data Sources for Publishing
// ============================================================================

/// Extract active BI connections from BiState as publishable data sources.
/// Captures each connected source's model JSON, bindings, and server/database
/// (without credentials) so subscribers can refresh BI pivots against live
/// data. The deprecated query-region path (direct cell insertion) is gone —
/// BI data flows to subscribers through pivots (and CUBE formulas, planned).
fn capture_bi_data_sources(
    bi_state: &BiState,
) -> Result<Vec<calp::publish::PublishDataSource>, String> {
    let connections = bi_state.connections.lock().map_err(|e| e.to_string())?;

    let mut data_sources = Vec::new();

    for conn in connections.values() {
        // Get the engine and serialize the model. Connections without a
        // loaded engine have nothing to embed.
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

        // The connection's EntityId (canonical UUID string) is the stable data source ID
        let ds_id = conn.id.to_string();

        // Convert bindings
        let bindings: Vec<calp::PackageBinding> = conn.bindings.iter().map(|b| {
            calp::PackageBinding {
                model_table: b.model_table.clone(),
                schema: b.schema.clone(),
                source_table: b.source_table.clone(),
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
        });
    }

    Ok(data_sources)
}

/// Parse server (host) and database (dbname) from a PostgreSQL connection string.
/// Strips credentials — only returns the non-sensitive parts.
pub fn parse_pg_connection_info(connection_string: &str) -> (String, String) {
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

/// Verify connectivity for all subscription data sources.
///
/// For each data source:
/// 1. Check subscriber's saved connection config
/// 2. If none, try building SSPI connection string and testing it
/// 3. If connection works: load model and bind tables (verifies the source)
/// 4. If connection fails: add to needs_configuration list
///
/// BI data reaches the grid through pivots (and CUBE formulas, planned) —
/// the deprecated query-region direct cell insertion path was removed.
#[tauri::command]
pub async fn calp_refresh_data(
    state: State<'_, AppState>,
    bi_state: State<'_, BiState>,
    window: tauri::Window,
) -> Result<DataRefreshResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    use calp::data_refresh;

    let mut sources_refreshed = 0usize;
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

        // Detect ModelBundle format. Parse failures skip THIS source — one
        // corrupt package must not abort verification of the others.
        let actual_model_json = if model_json.get("formatVersion").is_some() {
            match model_json.get("model") {
                Some(m) => m.clone(),
                None => {
                    crate::log_warn!("CALP", "ModelBundle missing 'model' field for {}", ds.id);
                    continue;
                }
            }
        } else {
            model_json
        };

        if let Err(e) = crate::bi::commands::check_model_format_version(&actual_model_json) {
            crate::log_warn!("CALP", "Skipping data source {}: {}", ds.id, e);
            continue;
        }
        let model: bi_engine::DataModel = match serde_json::from_value(actual_model_json) {
            Ok(m) => m,
            Err(e) => {
                crate::log_warn!("CALP", "Failed to parse model for {}: {}", ds.id, e);
                continue;
            }
        };

        // Create a temporary engine for this refresh
        let mut engine = bi_engine::Engine::new(model);
        engine.set_auto_tier_config(bi_engine::AutoTierConfig {
            enabled: true,
            max_rows: 100_000,
            default_ttl_secs: 3600,
        });

        // Live connect supports PostgreSQL only — don't funnel other source
        // types into a credentials prompt that can never succeed.
        if crate::bi::types::ConnectionType::parse_or_default(&ds.connection_type)
            != crate::bi::types::ConnectionType::PostgreSQL
        {
            crate::log_warn!(
                "CALP",
                "Data source '{}' is type '{}' — live connect is not yet supported for it, skipping",
                ds.name, ds.connection_type
            );
            continue;
        }

        // Try to connect to the database. On failure, surface the source in
        // needs_configuration so the ConnectionDialog can prompt the user
        // (stale saved config and missing-SSPI cases both end up here).
        let (target, auth) = crate::bi::commands::parse_connection_string(&connection_string);
        let connector_idx = match engine.add_postgres(target, auth).await {
            Ok(idx) => idx,
            Err(_e) => {
                needs_config.push(DataSourceNeedsConfig {
                    data_source_id: ds.id.clone(),
                    name: ds.name.clone(),
                    server: ds.server.clone(),
                    database: ds.database.clone(),
                    connection_type: ds.connection_type.clone(),
                });
                continue;
            }
        };

        // Bind tables to verify the model is queryable against this source.
        for binding in &ds.bindings {
            let source_binding = bi_engine::SourceBinding::new(&binding.schema, &binding.source_table);
            engine.bind_table(&binding.model_table, connector_idx, source_binding);
        }

        // Propagate the verified connection string into the pulled BiState
        // connection pivots actually query — verifying against the throwaway
        // engine above alone would leave the real connection unconfigured
        // ("verified" toast, but pivot refresh still prompts for credentials).
        if let Ok(mut connections) = bi_state.connections.lock() {
            if let Some(conn) = connections
                .values_mut()
                .find(|c| c.package_data_source_id.as_deref() == Some(ds.id.as_str()))
            {
                if conn.connection_string != connection_string {
                    conn.connection_string = connection_string.clone();
                }
            }
        }

        sources_refreshed += 1;
    }

    Ok(DataRefreshResponse {
        sources_refreshed,
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
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
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
    window: tauri::Window,
) -> Result<Vec<DataSourceInfo>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
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
    pub is_configured: bool,
    pub package_name: String,
}

// ============================================================================
// BI Pivot Publish-Time Validation
// ============================================================================

/// Validate all BI pivot definitions in the workbook against the embedded BI models.
/// Returns an error with a human-readable summary if any field names are invalid.
fn validate_bi_pivot_definitions(
    workbook: &persistence::Workbook,
    data_sources: &[calp::publish::PublishDataSource],
) -> Result<(), String> {
    use pivot_engine::PivotDefinition;

    // Collect all table names, column names, and measure names from data sources
    let mut all_tables: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    let mut all_measures: Vec<String> = Vec::new();

    for ds in data_sources {
        // Navigate into ModelBundle wrapper if present
        let model_json = if ds.model_json.get("formatVersion").is_some() {
            ds.model_json.get("model").unwrap_or(&ds.model_json)
        } else {
            &ds.model_json
        };

        if let Some(tables) = model_json.get("tables").and_then(|t| t.as_array()) {
            for table in tables {
                let table_name = table.get("name").and_then(|n| n.as_str()).unwrap_or("");
                let columns: Vec<String> = table.get("columns")
                    .and_then(|c| c.as_array())
                    .map(|cols| cols.iter()
                        .filter_map(|c| c.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
                        .collect())
                    .unwrap_or_default();
                all_tables.insert(table_name.to_string(), columns);
            }
        }

        if let Some(measures) = model_json.get("measures").and_then(|m| m.as_array()) {
            for measure in measures {
                if let Some(name) = measure.get("name").and_then(|n| n.as_str()) {
                    all_measures.push(name.to_string());
                }
            }
        }
    }

    // If no data sources with models, nothing to validate against
    if all_tables.is_empty() && all_measures.is_empty() {
        return Ok(());
    }

    let mut errors: Vec<String> = Vec::new();

    for pivot_def in &workbook.pivot_definitions {
        if pivot_def.source_type != "bi" {
            continue;
        }

        let def: PivotDefinition = serde_json::from_value(pivot_def.definition.clone())
            .map_err(|e| format!("Failed to parse pivot definition {}: {}", pivot_def.id, e))?;

        let id_str = pivot_def.id.to_string();
        let pivot_name = def.name.as_deref().unwrap_or(&id_str);

        // Validate row fields
        for field in &def.row_fields {
            validate_dimension_field(field.name.as_str(), "Row", pivot_name, &all_tables, &mut errors);
        }

        // Validate column fields
        for field in &def.column_fields {
            validate_dimension_field(field.name.as_str(), "Column", pivot_name, &all_tables, &mut errors);
        }

        // Validate filter fields
        for field in &def.filter_fields {
            validate_dimension_field(field.field.name.as_str(), "Filter", pivot_name, &all_tables, &mut errors);
        }

        // Validate value fields — must match a BI measure name
        for field in &def.value_fields {
            if !all_measures.iter().any(|m| m == &field.name) {
                errors.push(format!(
                    "BI pivot \"{}\": Value field \"{}\" does not match any measure in the model. Available measures: {}",
                    pivot_name,
                    field.name,
                    if all_measures.is_empty() { "(none)".to_string() } else { all_measures.join(", ") },
                ));
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Publish failed: BI pivot definitions have invalid fields:\n  - {}",
            errors.join("\n  - ")
        ))
    }
}

/// Validate a single dimension field (row, column, or filter) for a BI pivot.
/// Must be in "Table.Column" format with a valid table and column name.
fn validate_dimension_field(
    name: &str,
    area: &str,
    pivot_name: &str,
    tables: &std::collections::HashMap<String, Vec<String>>,
    errors: &mut Vec<String>,
) {
    if !name.contains('.') {
        errors.push(format!(
            "BI pivot \"{}\": {} field \"{}\" is not in Table.Column format (expected e.g. \"dim_product.categoryname\")",
            pivot_name, area, name,
        ));
        return;
    }

    let (table_name, column_name) = name.split_once('.').unwrap();

    if let Some(columns) = tables.get(table_name) {
        if !columns.iter().any(|c| c == column_name) {
            errors.push(format!(
                "BI pivot \"{}\": {} field \"{}\" references column \"{}\" which does not exist in table \"{}\". Available columns: {}",
                pivot_name, area, name, column_name, table_name,
                if columns.is_empty() { "(none)".to_string() } else { columns.join(", ") },
            ));
        }
    } else {
        let available = tables.keys().cloned().collect::<Vec<_>>().join(", ");
        errors.push(format!(
            "BI pivot \"{}\": {} field \"{}\" references table \"{}\" which does not exist in the model. Available tables: {}",
            pivot_name, area, name, table_name,
            if available.is_empty() { "(none)".to_string() } else { available },
        ));
    }
}

#[cfg(test)]
mod c8_materialize_tests {
    use super::materialize_distributed_scripts;
    use crate::scripting::types::{ScriptScope, ScriptState, WorkbookScript};

    /// A pulled module, stamped with its source package (as pull does).
    fn mk_module(pkg: &str, id: &str, source: &str) -> persistence::SavedScript {
        persistence::SavedScript {
            id: id.to_string(),
            name: "M".to_string(),
            description: None,
            source: source.to_string(),
            scope: persistence::SavedScriptScope::Workbook,
            source_package: Some(pkg.to_string()),
        }
    }

    fn mk_notebook(pkg: &str, id: &str, src: &str) -> persistence::SavedNotebook {
        persistence::SavedNotebook {
            id: id.to_string(),
            name: "N".to_string(),
            cells: vec![persistence::SavedNotebookCell {
                id: "c1".to_string(),
                source: src.to_string(),
                last_output: Vec::new(),
                last_error: None,
                cells_modified: 0,
                duration_ms: 0,
                execution_index: None,
            }],
            source_package: Some(pkg.to_string()),
        }
    }

    #[test]
    fn materializes_modules_and_notebooks_into_script_state() {
        let st = ScriptState::new();
        materialize_distributed_scripts(&st, "pkg", &[mk_module("pkg", "m1", "v1")], &[mk_notebook("pkg", "n1", "x")]).unwrap();
        let scripts = st.workbook_scripts.lock().unwrap();
        assert_eq!(scripts.get("m1").unwrap().source, "v1");
        assert_eq!(scripts.get("m1").unwrap().source_package.as_deref(), Some("pkg"));
        assert_eq!(st.workbook_notebooks.lock().unwrap().get("n1").unwrap().cells[0].source, "x");
    }

    #[test]
    fn same_package_refresh_replaces_the_prior_version() {
        let st = ScriptState::new();
        materialize_distributed_scripts(&st, "pkg", &[mk_module("pkg", "m1", "v1")], &[mk_notebook("pkg", "n1", "old")]).unwrap();
        materialize_distributed_scripts(&st, "pkg", &[mk_module("pkg", "m1", "v2-updated")], &[mk_notebook("pkg", "n1", "new")]).unwrap();
        let scripts = st.workbook_scripts.lock().unwrap();
        assert_eq!(scripts.len(), 1, "same id replaces, not duplicates");
        assert_eq!(scripts.get("m1").unwrap().source, "v2-updated");
        assert_eq!(st.workbook_notebooks.lock().unwrap().get("n1").unwrap().cells[0].source, "new");
    }

    #[test]
    fn removal_on_refresh_drops_a_module_the_package_no_longer_ships() {
        let st = ScriptState::new();
        materialize_distributed_scripts(&st, "pkg", &[mk_module("pkg", "m1", "a"), mk_module("pkg", "m2", "b")], &[]).unwrap();
        // The next version ships only m1 -> m2 must be removed.
        materialize_distributed_scripts(&st, "pkg", &[mk_module("pkg", "m1", "a2")], &[]).unwrap();
        let scripts = st.workbook_scripts.lock().unwrap();
        assert_eq!(scripts.len(), 1);
        assert!(scripts.contains_key("m1"));
        assert!(!scripts.contains_key("m2"), "removed-upstream module must be dropped on refresh");
    }

    #[test]
    fn preserves_a_subscriber_local_same_id_module() {
        let st = ScriptState::new();
        // A genuinely local (subscriber-authored) module with id "m1".
        st.workbook_scripts.lock().unwrap().insert(
            "m1".to_string(),
            WorkbookScript {
                id: "m1".to_string(),
                name: "Local".to_string(),
                description: None,
                source: "my local edit".to_string(),
                scope: ScriptScope::Workbook,
                source_package: None,
            },
        );
        // A package ships its own "m1" -> the local one is preserved, package skipped.
        materialize_distributed_scripts(&st, "pkg", &[mk_module("pkg", "m1", "upstream")], &[]).unwrap();
        let scripts = st.workbook_scripts.lock().unwrap();
        assert_eq!(scripts.get("m1").unwrap().source, "my local edit");
        assert_eq!(scripts.get("m1").unwrap().source_package, None);
    }

    #[test]
    fn does_not_let_one_package_shadow_anothers_same_id() {
        let st = ScriptState::new();
        materialize_distributed_scripts(&st, "pkg-a", &[mk_module("pkg-a", "m1", "from-a")], &[]).unwrap();
        // A second package reuses the id -> the first package keeps ownership.
        materialize_distributed_scripts(&st, "pkg-b", &[mk_module("pkg-b", "m1", "from-b")], &[]).unwrap();
        let scripts = st.workbook_scripts.lock().unwrap();
        assert_eq!(scripts.get("m1").unwrap().source, "from-a");
        assert_eq!(scripts.get("m1").unwrap().source_package.as_deref(), Some("pkg-a"));
    }
}
