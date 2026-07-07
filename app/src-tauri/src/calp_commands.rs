//! FILENAME: app/src-tauri/src/calp_commands.rs
//! PURPOSE: Tauri commands for .calp package operations (publish, pull, etc.).

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::AppState;
use crate::bi::types::BiState;

use calp::manifest::SubscriptionManifest;
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
    /// Extra custom objects supplied by frontend distributable-object providers
    /// (distribution brick 4). Merged with the Rust-collected built-in custom
    /// objects (cell types). Absent when no provider contributed.
    #[serde(default)]
    pub custom_objects: Option<Vec<FrontendCustomObject>>,
}

/// A custom object contributed by a FRONTEND provider for publishing
/// (distribution brick 4). Mirrors `calp::publish::PublishCustomObject` over
/// the IPC boundary; `payload` is opaque provider-owned JSON.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendCustomObject {
    pub kind: String,
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub sheet_id: Option<identity::SheetId>,
    pub payload: serde_json::Value,
}

impl From<FrontendCustomObject> for calp::publish::PublishCustomObject {
    fn from(f: FrontendCustomObject) -> Self {
        calp::publish::PublishCustomObject {
            kind: f.kind,
            id: f.id,
            name: f.name,
            sheet_id: f.sheet_id,
            payload: f.payload,
        }
    }
}

/// Collect the workbook's cell-type assignments (for the selected sheets) as
/// generic custom objects — one per sheet that has assignments (distribution
/// brick 4 dogfood). Mirrors how controls travel, but through the open channel.
fn collect_cell_type_custom_objects(
    state: &AppState,
    sheet_indices: &[usize],
) -> Result<Vec<calp::publish::PublishCustomObject>, String> {
    let sheet_ids = state.sheet_ids.lock().map_err(|e| e.to_string())?;
    let selected: std::collections::HashSet<identity::SheetId> = sheet_indices
        .iter()
        .filter_map(|&i| sheet_ids.get(i).copied())
        .collect();
    let cell_types = state.cell_types.lock().map_err(|e| e.to_string())?;
    let objects = crate::cell_types::collect_cell_types_for_save(&cell_types, &sheet_ids)
        .into_iter()
        .filter(|s| selected.contains(&s.sheet_id))
        .map(|s| calp::publish::PublishCustomObject {
            kind: "cellType".to_string(),
            // Stable per-sheet id so refresh replaces the same object.
            id: format!("cellType-{}", s.sheet_id),
            name: "Cell Types".to_string(),
            sheet_id: Some(s.sheet_id),
            payload: s.cells,
        })
        .collect();
    Ok(objects)
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
    /// Transparency report: everything that shipped and everything present in
    /// the workbook that packages cannot carry yet (no silent drops).
    pub report: PublishReport,
    /// Publish-time disclosure warnings from core publish — e.g. a dropdown
    /// pane control whose CellRange item source references a sheet outside
    /// the published selection (the artifact is unchanged; these only warn).
    pub warnings: Vec<String>,
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
    /// Generic custom objects of kinds NOT handled Rust-side (distribution
    /// brick 4), surfaced so frontend distributable-object providers can
    /// materialize them. Built-in kinds (cellType) are already applied and are
    /// NOT included here. Payloads are already integrity-verified.
    #[serde(default)]
    pub custom_objects: Vec<PulledCustomObjectDto>,
}

/// A pulled custom object handed to the frontend for provider materialization
/// (distribution brick 4). `sheet_index` is the LOCAL sheet index (the package
/// sheet remapped), or null for workbook-scoped / unresolvable objects.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PulledCustomObjectDto {
    pub kind: String,
    pub id: String,
    pub name: String,
    pub sheet_index: Option<usize>,
    pub payload: serde_json::Value,
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

// ============================================================================
// Publish assembly + transparency report
// ============================================================================

/// Everything calp_publish hands to core publish, assembled once so the real
/// publish and the dry-run preview (calp_publish_preview) can never drift.
struct PublishAssembly {
    workbook: persistence::Workbook,
    writeback_regions: Option<Vec<calp::WritebackRegionDeclaration>>,
    object_scripts: Option<Vec<persistence::SavedObjectScript>>,
    data_sources: Vec<calp::publish::PublishDataSource>,
    excluded_regions: Vec<calp::publish::ExcludedRegion>,
}

/// Build the publish carrier. ONE collector — the same enriched builder as the
/// .cala save path (active-sheet mirror content, notes/hyperlinks/hidden rows/
/// page setup, CF/DV, controls, charts, sparklines, tables, named ranges,
/// slicers, ribbon filters, theme, extension data) — so package fidelity
/// automatically tracks file fidelity. Core publish writes the subset the
/// .calp format supports; compute_publish_report tells the author exactly
/// what shipped and what stayed behind.
fn assemble_publish_workbook(
    state: &State<AppState>,
    bi_state: &State<BiState>,
    pivot_state: &State<crate::pivot::types::PivotState>,
    script_state: &State<crate::scripting::types::ScriptState>,
    slicer_state: &State<crate::slicer::SlicerState>,
    ribbon_filter_state: &State<crate::ribbon_filter::RibbonFilterState>,
    pane_control_state: &State<crate::pane_control::PaneControlState>,
    user_files_state: &State<crate::persistence::UserFilesState>,
    sheet_indices: &[usize],
) -> Result<PublishAssembly, String> {
    let mut workbook = crate::persistence::build_workbook_for_save_with_slicers(
        state,
        user_files_state,
        slicer_state,
        ribbon_filter_state,
    )?;

    // Pane controls (Controls pane) are workbook-scoped and ride in the
    // package as pane_controls.json (config + current values, sorted
    // deterministically at publish). Their custom-control/button scripts are
    // ordinary object scripts and ship consent-gated via object_scripts below.
    workbook.pane_controls =
        crate::persistence::collect_pane_controls_for_save(pane_control_state);

    for &idx in sheet_indices {
        if idx >= workbook.sheets.len() {
            return Err(format!("Sheet index {} out of range", idx));
        }
    }

    // Standalone module scripts / notebooks live in ScriptState, not AppState.
    // With these present, the publish request's None ("all from the workbook")
    // ships every module script + notebook (C8).
    workbook.scripts = crate::persistence::collect_scripts_for_save(script_state);
    workbook.notebooks = crate::persistence::collect_notebooks_for_save(script_state);

    // Ship pivot definitions + BI pivot metadata so subscribers can rebuild
    // live pivots; per-pivot data source routing reads the dataSourceId
    // carried in that metadata.
    crate::persistence::collect_pivot_definitions(pivot_state, state, &mut workbook);

    // The package contains only the selected sheets: drop pivots whose
    // source or destination sheet isn't included, and remap grid-source
    // sheet indices from workbook positions to package positions (pull
    // appends package sheets in order, offset by the pre-pull sheet count).
    {
        let index_map: std::collections::HashMap<usize, usize> = sheet_indices
            .iter()
            .enumerate()
            .map(|(package_idx, &wb_idx)| (wb_idx, package_idx))
            .collect();
        let published_names: std::collections::HashSet<String> = sheet_indices
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
    let data_sources = capture_bi_data_sources(bi_state)?;

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

    Ok(PublishAssembly {
        workbook,
        writeback_regions,
        object_scripts,
        data_sources,
        excluded_regions,
    })
}

/// One line of the publish transparency report.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishReportItem {
    pub category: String,
    pub count: usize,
    pub detail: String,
}

/// What a publish did (or, for the preview, WOULD do) carry — and what stays
/// behind. No silent drops: anything present in the workbook that packages
/// cannot carry yet is listed under `excluded` with a reason.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishReport {
    pub included: Vec<PublishReportItem>,
    pub excluded: Vec<PublishReportItem>,
}

fn compute_publish_report(
    assembly: &PublishAssembly,
    state: &AppState,
    sheet_indices: &[usize],
) -> PublishReport {
    let wb = &assembly.workbook;
    let published_sheet_ids: std::collections::HashSet<SheetId> = sheet_indices
        .iter()
        .filter_map(|&i| wb.sheets.get(i).map(|s| s.id))
        .collect();

    let item = |list: &mut Vec<PublishReportItem>, category: &str, count: usize, detail: &str| {
        if count > 0 {
            list.push(PublishReportItem {
                category: category.to_string(),
                count,
                detail: detail.to_string(),
            });
        }
    };

    let mut included: Vec<PublishReportItem> = Vec::new();
    item(&mut included, "sheets", sheet_indices.len(),
        "cell data, formulas, styles, merges, freeze panes, notes, hyperlinks, page setup");
    item(&mut included, "tables",
        wb.tables.iter().filter(|t| published_sheet_ids.contains(&t.sheet_id)).count(),
        "table objects (name, range, columns, style)");
    item(&mut included, "namedRanges",
        wb.named_ranges.iter()
            .filter(|nr| nr.sheet_id.map_or(true, |sid| published_sheet_ids.contains(&sid)))
            .count(),
        "workbook-scoped names + names on published sheets");
    item(&mut included, "charts",
        wb.charts.iter().filter(|c| published_sheet_ids.contains(&c.sheet_id)).count(),
        "charts on published sheets");
    item(&mut included, "sparklines",
        wb.sparklines.iter().filter(|s| published_sheet_ids.contains(&s.sheet_id)).count(),
        "sheets with sparkline groups");
    item(&mut included, "pivots", wb.pivot_definitions.len(),
        "pivot definitions (output recalculated by subscribers)");
    item(&mut included, "conditionalFormatting",
        wb.conditional_formats.iter().filter(|c| published_sheet_ids.contains(&c.sheet_id)).count(),
        "sheets with conditional formatting rules");
    item(&mut included, "dataValidation",
        wb.data_validations.iter().filter(|d| published_sheet_ids.contains(&d.sheet_id)).count(),
        "sheets with data validation");
    item(&mut included, "controls",
        wb.controls.iter().filter(|c| published_sheet_ids.contains(&c.sheet_id)).count(),
        "sheets with buttons/checkboxes (incl. onSelect wiring)");
    item(&mut included, "paneControls", wb.pane_controls.len(),
        "pane controls (config + current values); custom-control scripts ship as object scripts (consent-gated)");
    item(&mut included, "objectScripts",
        assembly.object_scripts.as_ref().map_or(0, |s| s.len()),
        "consent-gated on the subscriber; capability ceiling in the signed manifest");
    item(&mut included, "moduleScripts", wb.scripts.len(),
        "inert until explicitly run by the subscriber");
    item(&mut included, "notebooks", wb.notebooks.len(),
        "execution output stripped; inert until run");
    item(&mut included, "dataSources", assembly.data_sources.len(),
        "BI model schema only — no data, no credentials");
    item(&mut included, "writebackRegions",
        assembly.writeback_regions.as_ref().map_or(0, |w| w.len()),
        "declared data-collection regions");

    let mut excluded: Vec<PublishReportItem> = Vec::new();
    item(&mut excluded, "slicers",
        wb.slicers.iter().filter(|s| published_sheet_ids.contains(&s.sheet_id)).count(),
        "slicers are not yet carried by packages");
    item(&mut excluded, "ribbonFilters", wb.ribbon_filters.len(),
        "filter-pane state is not yet carried by packages");
    item(&mut excluded, "pivotLayouts", wb.pivot_layouts.len(),
        "saved pivot layouts are not yet carried by packages");
    let theme_custom = serde_json::to_value(&wb.theme).ok()
        != serde_json::to_value(engine::ThemeDefinition::default()).ok();
    item(&mut excluded, "documentTheme", usize::from(theme_custom),
        "the document theme is not yet carried; concrete cell styles ship");
    if !wb.extension_data.is_empty() {
        let keys: Vec<&str> = wb.extension_data.keys().map(|k| k.as_str()).collect();
        excluded.push(PublishReportItem {
            category: "extensionData".to_string(),
            count: wb.extension_data.len(),
            detail: format!("extension state is not yet carried: {}", keys.join(", ")),
        });
    }
    item(&mut excluded, "workbookFiles", wb.user_files.len(),
        "workbook files (bookmarks, stored documents, filter state) stay local");
    let comments: usize = state.comments.lock()
        .map(|c| c.values().map(|m| m.len()).sum()).unwrap_or(0);
    item(&mut excluded, "comments", comments,
        "threaded comments are not yet persisted or published");
    let scenarios: usize = state.scenarios.lock()
        .map(|s| s.values().map(|v| v.len()).sum()).unwrap_or(0);
    item(&mut excluded, "scenarios", scenarios,
        "saved scenarios are not yet persisted or published");
    let protected = state.sheet_protection.lock().map(|p| p.len()).unwrap_or(0);
    item(&mut excluded, "protection", protected,
        "sheet/cell protection is not yet carried by packages");
    let outline_groups: usize = state.outlines.lock()
        .map(|o| o.values().map(|g| g.row_groups.len() + g.column_groups.len()).sum())
        .unwrap_or(0);
    item(&mut excluded, "outlineGroups", outline_groups,
        "outline structure is not carried (collapsed groups ship as hidden rows)");
    let doc_props = [
        &wb.properties.title,
        &wb.properties.author,
        &wb.properties.subject,
        &wb.properties.description,
        &wb.properties.keywords,
        &wb.properties.category,
    ]
    .iter()
    .filter(|s| !s.is_empty())
    .count();
    item(&mut excluded, "documentProperties", doc_props,
        "document properties (title, author, description, ...) are not yet carried by packages");

    PublishReport { included, excluded }
}

/// Publish selected sheets to a local registry.
#[tauri::command]
pub fn calp_publish(
    state: State<AppState>,
    bi_state: State<BiState>,
    pivot_state: State<crate::pivot::types::PivotState>,
    script_state: State<crate::scripting::types::ScriptState>,
    slicer_state: State<crate::slicer::SlicerState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
    pane_control_state: State<crate::pane_control::PaneControlState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    params: PublishParams,
    window: tauri::Window,
) -> Result<PublishResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let registry = crate::calp_registry::open_registry(&params.registry_path)
        .map_err(|e| e.to_string())?;

    let version = SemVer::parse(&params.version)
        .map_err(|e| e.to_string())?;

    let now = chrono::Utc::now().to_rfc3339();

    // Empty selection = every sheet — the SAME normalization the preview
    // applies, so the dry-run report can never describe a different package
    // than the publish that follows it (previously an empty selection
    // previewed the whole workbook but published a zero-sheet package).
    let sheet_indices = resolve_publish_sheet_indices(&state, params.sheet_indices)?;

    let assembly = assemble_publish_workbook(
        &state,
        &bi_state,
        &pivot_state,
        &script_state,
        &slicer_state,
        &ribbon_filter_state,
        &pane_control_state,
        &user_files_state,
        &sheet_indices,
    )?;
    let report = compute_publish_report(&assembly, &state, &sheet_indices);

    let PublishAssembly {
        workbook,
        writeback_regions,
        object_scripts,
        data_sources,
        excluded_regions,
    } = assembly;

    // Cell types travel via the generic custom-object channel (brick 4
    // dogfood): one per selected sheet, kind "cellType", payload = the sheet's
    // opaque cell-type assignments. Frontend providers can add more via
    // params.custom_objects (merged in — moved out of params before the request
    // literal consumes its other fields).
    let frontend_custom_objects = params.custom_objects.unwrap_or_default();
    let mut custom_objects = collect_cell_type_custom_objects(&state, &sheet_indices)?;
    custom_objects.extend(frontend_custom_objects.into_iter().map(Into::into));

    let request = calp::publish::PublishRequest {
        workbook: &workbook,
        package_name: params.package_name,
        version,
        kind: params.kind,
        sheet_indices,
        now,
        published_by: params.published_by,
        writeback_regions,
        object_scripts,
        // None => publish all standalone module scripts / notebooks carried in
        // the carrier above (C8). They distribute as inert, transparent data.
        module_scripts: None,
        notebooks: None,
        data_sources,
        excluded_regions,
        custom_objects,
    };

    let result = calp::publish::publish(&registry, &request, &calcula_profile_dir())
        .map_err(|e| e.to_string())?;

    // Audit (B4)
    {
        let now = chrono::Utc::now().to_rfc3339();
        let user = audit_user(&state);
        if let Ok(mut audit) = state.audit_log.lock() {
            audit.record(
                calp::audit::AuditEvent::Published,
                &format!(
                    "Published {} v{} ({} sheets)",
                    result.package_name, result.version, result.sheets_published
                ),
                &user,
                &now,
            );
        }
    }

    Ok(PublishResponse {
        package_name: result.package_name,
        version: result.version,
        sheets_published: result.sheets_published,
        tables_published: result.tables_published,
        named_ranges_published: result.named_ranges_published,
        scripts_published: result.scripts_published,
        modules_published: result.modules_published,
        notebooks_published: result.notebooks_published,
        report,
        warnings: result.warnings,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishModelParams {
    pub registry_path: String,
    pub package_name: String,
    pub version: String,
    pub published_by: String,
    /// The BI connection whose model to publish (EntityId as UUID string).
    pub connection_id: String,
}

/// Publish a single BI model as a MODEL-ONLY package (kind "dataset", zero
/// sheets). This makes the .calp the distribution unit for models — signed
/// (Ed25519 + TOFU), versioned (semver pins), min-app-gated — replacing loose
/// .json file hand-off. Subscribing materializes a live BI connection
/// (schema only, no data, no credentials; the subscriber connects with their
/// own credentials, so RLS is preserved).
#[tauri::command]
pub fn calp_publish_model(
    state: State<AppState>,
    bi_state: State<BiState>,
    params: PublishModelParams,
    window: tauri::Window,
) -> Result<PublishResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let registry = crate::calp_registry::open_registry(&params.registry_path)
        .map_err(|e| e.to_string())?;
    let version = SemVer::parse(&params.version).map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();

    // Capture ONLY the requested connection as a package data source (the
    // capture serializes the live engine model, credential-free).
    let data_sources: Vec<calp::publish::PublishDataSource> =
        capture_bi_data_sources(&bi_state)?
            .into_iter()
            .filter(|ds| ds.id == params.connection_id)
            .collect();
    if data_sources.is_empty() {
        // capture_bi_data_sources silently skips a busy engine — distinguish
        // that from a genuinely missing connection so the error is actionable.
        let busy = {
            let connections = bi_state.connections.lock().map_err(|e| e.to_string())?;
            connections.values().any(|c| {
                c.id.to_string() == params.connection_id
                    && c.engine.as_ref().is_some_and(|arc| arc.try_lock().is_err())
            })
        };
        return Err(if busy {
            "The connection's engine is busy (a query or refresh is running) — retry in a moment."
                .to_string()
        } else {
            "Connection not found or its model is not loaded (open Data > Connections)"
                .to_string()
        });
    }
    let model_name = data_sources[0].name.clone();

    // A minimal carrier: zero sheets, no scripts/tables/names — the package is
    // the model. Workbook::new()'s default sheet is never published because
    // sheet_indices is empty.
    let workbook = persistence::Workbook::new();
    let request = calp::publish::PublishRequest {
        workbook: &workbook,
        package_name: params.package_name,
        version,
        kind: "dataset".to_string(),
        sheet_indices: Vec::new(),
        now: now.clone(),
        published_by: params.published_by,
        writeback_regions: None,
        object_scripts: None,
        module_scripts: None,
        notebooks: None,
        data_sources,
        excluded_regions: Vec::new(),
        custom_objects: Vec::new(),
    };
    let result = calp::publish::publish(&registry, &request, &calcula_profile_dir())
        .map_err(|e| e.to_string())?;

    // Audit (B4)
    {
        let user = audit_user(&state);
        if let Ok(mut audit) = state.audit_log.lock() {
            audit.record(
                calp::audit::AuditEvent::Published,
                &format!(
                    "Published model '{}' as dataset package {} v{}",
                    model_name, result.package_name, result.version
                ),
                &user,
                &now,
            );
        }
    }

    let report = PublishReport {
        included: vec![PublishReportItem {
            category: "dataSources".to_string(),
            count: 1,
            detail: format!(
                "model '{}' — schema only: no data, no credentials",
                model_name
            ),
        }],
        excluded: Vec::new(),
    };

    Ok(PublishResponse {
        package_name: result.package_name,
        version: result.version,
        sheets_published: result.sheets_published,
        tables_published: result.tables_published,
        named_ranges_published: result.named_ranges_published,
        scripts_published: result.scripts_published,
        modules_published: result.modules_published,
        notebooks_published: result.notebooks_published,
        report,
        warnings: result.warnings,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishPreviewParams {
    /// Sheets to include (workbook indices). None or empty => all sheets.
    #[serde(default)]
    pub sheet_indices: Option<Vec<usize>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishPreviewResponse {
    /// Names of the sheets the preview covered, in package order.
    pub sheet_names: Vec<String>,
    pub report: PublishReport,
    /// The SAME disclosure warnings a real publish of this selection would
    /// emit (core `dropdown_reference_warnings` over the same carrier) — e.g.
    /// a dropdown pane control whose CellRange item source references a sheet
    /// outside the selection. Non-blocking; the artifact is never rewritten.
    pub warnings: Vec<String>,
}

/// Dry-run of calp_publish: assemble the EXACT carrier a publish would use
/// (same collector, same filters) and report what would ship vs stay behind —
/// without writing anything to any registry.
#[tauri::command]
pub fn calp_publish_preview(
    state: State<AppState>,
    bi_state: State<BiState>,
    pivot_state: State<crate::pivot::types::PivotState>,
    script_state: State<crate::scripting::types::ScriptState>,
    slicer_state: State<crate::slicer::SlicerState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
    pane_control_state: State<crate::pane_control::PaneControlState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    params: PublishPreviewParams,
    window: tauri::Window,
) -> Result<PublishPreviewResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;

    let sheet_indices =
        resolve_publish_sheet_indices(&state, params.sheet_indices.unwrap_or_default())?;

    let assembly = assemble_publish_workbook(
        &state,
        &bi_state,
        &pivot_state,
        &script_state,
        &slicer_state,
        &ribbon_filter_state,
        &pane_control_state,
        &user_files_state,
        &sheet_indices,
    )?;
    let report = compute_publish_report(&assembly, &state, &sheet_indices);
    // Same check core publish runs, over the same carrier — so the author
    // sees dangling dropdown references at PREVIEW time, not only after the
    // artifact is already written.
    let warnings = calp::publish::dropdown_reference_warnings(&assembly.workbook, &sheet_indices);
    let sheet_names = sheet_indices
        .iter()
        .filter_map(|&i| assembly.workbook.sheets.get(i).map(|s| s.name.clone()))
        .collect();

    Ok(PublishPreviewResponse { sheet_names, report, warnings })
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
) -> Result<(Vec<(String, String)>, Vec<(String, String)>), String> {
    use std::collections::HashSet;

    // (id, name) of the modules/notebooks ACTUALLY inserted — conflict-skipped
    // ones excluded, so the provenance ledger never attributes a preserved
    // local (or other-package) document to this package.
    let mut applied_modules: Vec<(String, String)> = Vec::new();
    let mut applied_notebooks: Vec<(String, String)> = Vec::new();

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
            applied_modules.push((module.id.clone(), module.name.clone()));
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
            applied_notebooks.push((nb.id.clone(), nb.name.clone()));
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
                            last_output: c
                                .last_output
                                .iter()
                                .map(crate::persistence::saved_output_to_item)
                                .collect(),
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
    Ok((applied_modules, applied_notebooks))
}

/// Grow an index-aligned per-sheet Vec store so `idx` is addressable.
fn ensure_slot<T: Clone>(v: &mut Vec<T>, idx: usize, default: T) {
    while v.len() <= idx {
        v.push(default.clone());
    }
}

/// Materialize pulled sheet presentation state (merged regions, freeze panes,
/// tab color, visibility, gridlines, page setup, notes, hyperlinks) into the
/// per-sheet AppState stores, and keep the index-aligned Vec stores aligned
/// for appended sheets. Before this, pulled packages carried all of it in
/// sheets/{id}/metadata.json and the Tauri materializer dropped it — the
/// subscriber lost merges/freeze panes/notes — AND the aligned Vec stores
/// stayed short, misaligning any sheet added after a pull.
///
/// Reset semantics per materialized sheet (the publisher owns a subscribed
/// sheet's presentation): used by first pull (fresh sheets, so reset ==
/// initialize), refresh (overwrite with the new version's state), and the
/// dev-mode preview loop. `sheets` pairs each source/package sheet id with its
/// carrier Sheet; ids resolve to local indices via `pkg_to_index`.
fn materialize_pulled_sheet_state(
    state: &AppState,
    sheets: &[(SheetId, &persistence::Sheet)],
    pkg_to_index: &std::collections::HashMap<SheetId, usize>,
    active_sheet: usize,
) -> Result<(), String> {
    // Each store is locked, updated, and released independently (mirroring the
    // .cala load path) to keep lock scopes small and ordering trivial.
    let targets: Vec<(usize, &persistence::Sheet)> = sheets
        .iter()
        .filter_map(|(pkg_sid, sheet)| pkg_to_index.get(pkg_sid).map(|&idx| (idx, *sheet)))
        .collect();

    {
        let mut v = state.freeze_configs.lock().map_err(|e| e.to_string())?;
        for (idx, p) in &targets {
            ensure_slot(&mut v, *idx, crate::sheets::FreezeConfig::default());
            v[*idx] = crate::sheets::FreezeConfig {
                freeze_row: p.freeze_row,
                freeze_col: p.freeze_col,
            };
        }
    }
    {
        let mut v = state.split_configs.lock().map_err(|e| e.to_string())?;
        for (idx, _) in &targets {
            ensure_slot(&mut v, *idx, crate::sheets::SplitConfig::default());
        }
    }
    {
        let mut v = state.scroll_areas.lock().map_err(|e| e.to_string())?;
        for (idx, _) in &targets {
            ensure_slot(&mut v, *idx, None);
        }
    }
    {
        let mut v = state.tab_colors.lock().map_err(|e| e.to_string())?;
        for (idx, p) in &targets {
            ensure_slot(&mut v, *idx, String::new());
            v[*idx] = p.tab_color.clone();
        }
    }
    {
        let mut v = state.sheet_visibility.lock().map_err(|e| e.to_string())?;
        for (idx, p) in &targets {
            ensure_slot(&mut v, *idx, "visible".to_string());
            v[*idx] = p.visibility.clone();
        }
    }
    {
        let mut v = state.show_gridlines.lock().map_err(|e| e.to_string())?;
        for (idx, p) in &targets {
            ensure_slot(&mut v, *idx, true);
            v[*idx] = p.show_gridlines;
        }
    }
    {
        let mut all_merged = state.all_merged_regions.lock().map_err(|e| e.to_string())?;
        for (idx, p) in &targets {
            ensure_slot(&mut all_merged, *idx, std::collections::HashSet::new());
            let merges: std::collections::HashSet<crate::api_types::MergedRegion> = p
                .merged_regions
                .iter()
                .map(|mr| crate::api_types::MergedRegion {
                    start_row: mr.start_row,
                    start_col: mr.start_col,
                    end_row: mr.end_row,
                    end_col: mr.end_col,
                })
                .collect();
            // The active sheet's merges live in the mirror (source of truth
            // while active); a refreshed active sheet must sync it too.
            if *idx == active_sheet {
                let mut mirror = state.merged_regions.lock().map_err(|e| e.to_string())?;
                *mirror = merges.clone();
            }
            all_merged[*idx] = merges;
        }
    }
    {
        let mut page_setups = state.page_setups.lock().map_err(|e| e.to_string())?;
        for (idx, p) in &targets {
            ensure_slot(&mut page_setups, *idx, crate::api_types::PageSetup::default());
            page_setups[*idx] = match &p.page_setup {
                Some(ps) => crate::api_types::PageSetup {
                    paper_size: ps.paper_size.clone(),
                    orientation: ps.orientation.clone(),
                    margin_top: ps.margin_top,
                    margin_bottom: ps.margin_bottom,
                    margin_left: ps.margin_left,
                    margin_right: ps.margin_right,
                    margin_header: ps.margin_header,
                    margin_footer: ps.margin_footer,
                    header: ps.header.clone(),
                    footer: ps.footer.clone(),
                    print_area: ps.print_area.clone(),
                    print_titles_rows: ps.print_titles_rows.clone(),
                    manual_row_breaks: ps.manual_row_breaks.clone(),
                    print_gridlines: ps.print_gridlines,
                    center_horizontally: ps.center_horizontally,
                    center_vertically: ps.center_vertically,
                    scale: ps.scale,
                    fit_to_width: ps.fit_to_width,
                    fit_to_height: ps.fit_to_height,
                    page_order: ps.page_order.clone(),
                    first_page_number: ps.first_page_number,
                    ..Default::default()
                },
                None => crate::api_types::PageSetup::default(),
            };
        }
    }
    {
        let mut notes_storage = state.notes.lock().map_err(|e| e.to_string())?;
        for (idx, p) in &targets {
            if p.notes.is_empty() {
                notes_storage.remove(idx);
                continue;
            }
            let mut sheet_notes = std::collections::HashMap::new();
            for n in &p.notes {
                sheet_notes.insert(
                    (n.row, n.col),
                    crate::notes::Note {
                        id: uuid::Uuid::new_v4().to_string(),
                        row: n.row,
                        col: n.col,
                        sheet_index: *idx,
                        author_name: n.author.clone(),
                        content: n.text.clone(),
                        rich_content: None,
                        width: 200.0,
                        height: 100.0,
                        visible: false,
                        created_at: chrono::Utc::now().to_rfc3339(),
                        modified_at: None,
                    },
                );
            }
            notes_storage.insert(*idx, sheet_notes);
        }
    }
    {
        let mut hyperlinks_storage = state.hyperlinks.lock().map_err(|e| e.to_string())?;
        for (idx, p) in &targets {
            if p.hyperlinks.is_empty() {
                hyperlinks_storage.remove(idx);
                continue;
            }
            let mut sheet_links = std::collections::HashMap::new();
            for h in &p.hyperlinks {
                sheet_links.insert(
                    (h.row, h.col),
                    crate::hyperlinks::Hyperlink {
                        row: h.row,
                        col: h.col,
                        sheet_index: *idx,
                        link_type: crate::hyperlinks::HyperlinkType::Url,
                        target: h.target.clone(),
                        internal_ref: None,
                        display_text: h.display_text.clone(),
                        tooltip: h.tooltip.clone(),
                    },
                );
            }
            hyperlinks_storage.insert(*idx, sheet_links);
        }
    }

    Ok(())
}

/// Materialize pulled tables at the sheet indices resolved by `map`
/// (ADDITIVE: id/name-collision skip so a subscriber's own table is never
/// clobbered). Appends a ledger entry per table actually added when a ledger
/// is supplied. Returns the number materialized. Shared by pull, refresh, and
/// the dev-mode preview loop.
fn materialize_pulled_tables(
    state: &AppState,
    saved_tables: &[persistence::SavedTable],
    map: &std::collections::HashMap<SheetId, usize>,
    mut ledger: Option<&mut Vec<calp::manifest::SubscribedObject>>,
) -> Result<usize, String> {
    if saved_tables.is_empty() {
        return Ok(0);
    }
    let mut materialized = 0usize;
    let mut tables = state.tables.lock().map_err(|e| e.to_string())?;
    let mut table_names = state.table_names.lock().map_err(|e| e.to_string())?;
    for saved in saved_tables {
        let Some(&idx) = map.get(&saved.sheet_id) else {
            continue; // the table's sheet wasn't pulled
        };
        let name_key = saved.name.to_uppercase();
        if table_names.contains_key(&name_key) {
            continue; // don't clobber a table the subscriber already has
        }
        if tables.values().any(|m| m.contains_key(&saved.id)) {
            continue;
        }
        let table = crate::persistence::saved_table_to_table_at(saved, idx);
        table_names.insert(name_key, (idx, table.id));
        if let Some(ledger) = ledger.as_deref_mut() {
            ledger.push(calp::manifest::SubscribedObject {
                kind: "table".to_string(),
                id: table.id.to_string(),
                name: table.name.clone(),
                extra: std::collections::HashMap::new(),
            });
        }
        tables.entry(idx).or_default().insert(table.id, table);
        materialized += 1;
    }
    Ok(materialized)
}

/// Normalize the author's sheet selection: empty means "every sheet". Shared
/// by calp_publish and calp_publish_preview so the dry-run can never describe
/// a different package than the one a publish with the same input would write.
fn resolve_publish_sheet_indices(
    state: &State<AppState>,
    requested: Vec<usize>,
) -> Result<Vec<usize>, String> {
    if !requested.is_empty() {
        return Ok(requested);
    }
    let names = state.sheet_names.lock().map_err(|e| e.to_string())?;
    Ok((0..names.len()).collect())
}

/// Uppercased name-collision set for pulled pane controls: existing pane
/// controls + ribbon filters (GET.CONTROLVALUE names are unique across both
/// families) + NAMED on-grid controls. Without the on-grid family a pulled
/// pane control could silently shadow a subscriber's named button/checkbox —
/// pane controls win the GET.CONTROLVALUE precedence, so the subscriber's
/// formulas would switch source without any warning. On-grid names use the
/// SAME extraction rule as the snapshot map (`static_control_name`: static,
/// non-empty after trim; formula-typed names excluded).
fn pane_control_taken_names<'a>(
    pane_controls: impl Iterator<Item = &'a crate::pane_control::PaneControl>,
    ribbon_filters: impl Iterator<Item = &'a crate::ribbon_filter::RibbonFilter>,
    on_grid_controls: &crate::controls::ControlStorage,
) -> std::collections::HashSet<String> {
    pane_controls
        .map(|c| c.name.to_uppercase())
        .chain(ribbon_filters.map(|f| f.name.to_uppercase()))
        .chain(
            on_grid_controls
                .values()
                .filter_map(crate::control_values::static_control_name)
                .map(|n| n.to_uppercase()),
        )
        .collect()
}

/// Snapshot AppState.controls (on-grid control metadata) under its own short
/// lock, released before the pane/filter locks are taken — the lock-order
/// convention (pane_control/types.rs, control_values.rs) never nests these.
fn snapshot_on_grid_controls(state: &AppState) -> Result<crate::controls::ControlStorage, String> {
    Ok(state.controls.lock().map_err(|e| e.to_string())?.clone())
}

/// Materialize pulled pane controls (Controls pane) into PaneControlState —
/// shared by calp_pull and calp_refresh_apply so first-pull and refresh
/// semantics can never drift. Workbook-scoped, ADDITIVE with don't-clobber
/// (the named-range / object-script convention): a control whose id already
/// exists, or whose name collides CASE-INSENSITIVELY with an existing pane
/// control, ribbon filter, or NAMED on-grid control (see
/// `pane_control_taken_names`), is skipped with a warning. Applied controls
/// re-base to the end of the subscriber's strip (max existing order + 1,
/// preserving package-relative order) — the same append semantics
/// create_pane_control uses. Configs carry no inline code by design (D6); a
/// custom control's script arrives separately as a consent-gated distributed
/// object script and stays inert until the subscriber consents.
///
/// `on_grid_controls` is a snapshot taken via `snapshot_on_grid_controls`
/// (its lock already released) — never a live guard, so no lock nests with
/// the pane/filter locks taken here.
///
/// Returns (id, name) for each control ACTUALLY inserted, so callers record
/// provenance-ledger entries only for what landed (a collision-skipped local
/// control is never attributed to the package).
fn materialize_pulled_pane_controls(
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    on_grid_controls: &crate::controls::ControlStorage,
    pulled: &[persistence::SavedPaneControl],
) -> Result<Vec<(String, String)>, String> {
    if pulled.is_empty() {
        return Ok(Vec::new());
    }
    // LOCK ORDER (pane_control/types.rs): PaneControlState.controls BEFORE
    // RibbonFilterState.filters; neither held while touching grids (we
    // don't touch grids here).
    let mut controls = pane_control_state.controls.lock().map_err(|e| e.to_string())?;
    let (mut taken_names, base_order) = {
        let filters = ribbon_filter_state.filters.lock().map_err(|e| e.to_string())?;
        let names = pane_control_taken_names(controls.values(), filters.values(), on_grid_controls);
        let max_order = controls
            .values()
            .map(|c| c.order)
            .chain(filters.values().map(|f| f.order))
            .max();
        (names, max_order.map_or(0, |m| m.saturating_add(1)))
    };

    // Package order is already (order, id)-sorted at publish; re-sort
    // defensively so re-based positions are deterministic regardless.
    let mut incoming = pulled.to_vec();
    incoming.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));

    let mut applied: Vec<(String, String)> = Vec::new();
    let mut next_order = base_order;
    for saved in &incoming {
        if controls.contains_key(&saved.id) {
            continue; // subscriber already has this control (id collision)
        }
        if taken_names.contains(&saved.name.to_uppercase()) {
            crate::log_warn!(
                "CALP",
                "Skipping pulled pane control \"{}\": name already in use",
                saved.name
            );
            continue;
        }
        // Same converter as .cala load: unknown types / bad configs are
        // skipped with a warning, never fail the pull.
        if let Some(mut control) = crate::persistence::saved_to_pane_control(saved) {
            control.order = next_order;
            next_order = next_order.saturating_add(1);
            taken_names.insert(control.name.to_uppercase());
            applied.push((control.id.to_string(), control.name.clone()));
            controls.insert(control.id, control);
        }
    }
    Ok(applied)
}

/// Instance ids ("pane-{controlId}", the CustomControlHost/ButtonControl
/// convention) of the incoming pane controls whose host did NOT land in the
/// strip after `materialize_pulled_pane_controls` ran for `incoming`. Strip
/// MEMBERSHIP is the criterion — it distinguishes the two skip reasons:
/// - name-collision skip (or converter drop): the control is ABSENT, so its
///   package-shipped "pane-{id}" object script would persist host-less
///   (inert, but violating delete-path hygiene) — reported for pruning;
/// - id-collision skip: the id is PRESENT (the subscriber's own control was
///   retained), so the script keeps a live host — NOT reported.
/// Every APPLIED control is present by construction, so "absent" is exactly
/// "in the incoming payload but neither applied nor retained".
///
/// Takes (and releases) the pane-controls lock; callers must not hold it.
fn orphaned_pane_script_instance_ids(
    pane_control_state: &crate::pane_control::PaneControlState,
    incoming: &[persistence::SavedPaneControl],
) -> Result<std::collections::HashSet<String>, String> {
    if incoming.is_empty() {
        return Ok(std::collections::HashSet::new());
    }
    let controls = pane_control_state.controls.lock().map_err(|e| e.to_string())?;
    Ok(incoming
        .iter()
        .filter(|saved| !controls.contains_key(&saved.id))
        .map(|saved| format!("pane-{}", saved.id))
        .collect())
}

/// Pull (subscribe to) a package.
#[tauri::command]
pub fn calp_pull(
    state: State<AppState>,
    pivot_state: State<'_, crate::pivot::types::PivotState>,
    bi_state: State<'_, BiState>,
    script_state: State<'_, crate::scripting::types::ScriptState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    params: PullParams,
    window: tauri::Window,
) -> Result<PullResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let registry = crate::calp_registry::open_registry(&params.registry_path)
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
    let (chart_sheet_index, pkg_to_index) = {
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
        // package sheet id -> local sheet index. Named ranges + CF/DV carry the
        // un-remapped PACKAGE sheet id (unlike charts/sparklines, which pull.rs
        // already remapped to the local sheet id), so they need this map.
        let mut pkg_to_index: std::collections::HashMap<_, usize> =
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
            pkg_to_index.insert(pulled.package_sheet_id, base_index + i);
        }
        (chart_index_map, pkg_to_index)
    };

    // Provenance ledger: everything this pull actually materializes. Stored on
    // the Subscription (subscriptions.json) so the Package Explorer can show
    // "which objects are connected to this package" and refresh can replace
    // exactly the package-owned objects.
    let mut sub_objects: Vec<calp::manifest::SubscribedObject> = Vec::new();
    let sub_object = |kind: &str, id: String, name: String| calp::manifest::SubscribedObject {
        kind: kind.to_string(),
        id,
        name,
        extra: std::collections::HashMap::new(),
    };

    // Materialize pulled sheet presentation state (merges, freeze panes, tab
    // color, visibility, gridlines, page setup, notes, hyperlinks) and keep the
    // index-aligned per-sheet stores aligned for the appended sheets.
    {
        let active = *state.active_sheet.lock().map_err(|e| e.to_string())?;
        let pairs: Vec<(SheetId, &persistence::Sheet)> = result
            .sheets
            .iter()
            .map(|p| (p.package_sheet_id, &p.sheet))
            .collect();
        materialize_pulled_sheet_state(&state, &pairs, &pkg_to_index, active)?;
    }

    // Materialize pulled tables. The package carries full table objects
    // (tables/{id}.json); before this they were read, counted, and then
    // dropped — the subscriber got the cells but lost the table entity (name,
    // structured references, header/filter behavior).
    let tables_materialized =
        materialize_pulled_tables(&state, &result.tables, &pkg_to_index, Some(&mut sub_objects))?;

    // Materialize pulled object scripts (forced to restricted mode by the calp layer)
    let scripts_pulled = result.object_scripts.len();
    if !result.object_scripts.is_empty() {
        let mut scripts = state.object_scripts.lock().map_err(|e| e.to_string())?;
        for script in result.object_scripts {
            // Don't overwrite existing scripts with the same ID (subscriber may have modified)
            if !scripts.iter().any(|s| s.id == script.id) {
                sub_objects.push(sub_object(
                    "objectScript",
                    script.id.clone(),
                    script.name.clone(),
                ));
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
                    sub_objects.push(sub_object("chart", chart.id.to_string(), String::new()));
                    charts.push(crate::api_types::ChartEntry {
                        id: chart.id,
                        sheet_index,
                        spec_json: chart.spec_json,
                    });
                }
            }
        }
    }

    // Materialize pulled sparklines onto their (remapped) sheet index (C2a).
    // Sparklines carry no id, so dedupe by (sheet_index, groups_json) to avoid
    // duplicating one the subscriber already has.
    if !result.sparklines.is_empty() {
        let mut sparklines = state.sparklines.lock().map_err(|e| e.to_string())?;
        for sp in result.sparklines {
            if let Some(&sheet_index) = chart_sheet_index.get(&sp.sheet_id) {
                let already = sparklines
                    .iter()
                    .any(|e| e.sheet_index == sheet_index && e.groups_json == sp.groups_json);
                if !already {
                    sparklines.push(crate::api_types::SparklineEntry {
                        sheet_index,
                        groups_json: sp.groups_json,
                    });
                }
            }
        }
    }

    // Materialize pulled named ranges. Pull is ADDITIVE (unlike .cala load): the
    // subscriber's own names are kept; a pulled name is added only if absent.
    // Keyed by the UPPERCASED name (the case-insensitive lookup invariant);
    // PublishedNamedRange.sheet_id is the PACKAGE id, mapped to the local index.
    if !result.named_ranges.is_empty() {
        let mut names = state.named_ranges.lock().map_err(|e| e.to_string())?;
        for nr in &result.named_ranges {
            let key = nr.name.to_uppercase();
            if names.contains_key(&key) {
                continue; // don't clobber a name the subscriber already defined
            }
            sub_objects.push(sub_object("namedRange", key.clone(), nr.name.clone()));
            names.insert(
                key,
                crate::named_ranges::NamedRange {
                    name: nr.name.clone(),
                    sheet_index: nr.sheet_id.and_then(|sid| pkg_to_index.get(&sid).copied()),
                    refers_to: nr.refers_to.clone(),
                    comment: None,
                    folder: None,
                },
            );
        }
    }

    // Materialize pulled conditional formats onto the (remapped) local sheet index.
    // Pulled sheets are freshly appended, so each lands on an empty per-sheet Vec.
    // Advance next_cf_rule_id past any pulled CF id to avoid collisions.
    if !result.conditional_formats.is_empty() {
        let mut max_id: u64 = 0;
        {
            let mut store = state.conditional_formats.lock().map_err(|e| e.to_string())?;
            for entry in &result.conditional_formats {
                if let Some(&idx) = pkg_to_index.get(&entry.sheet_id) {
                    if let Ok(defs) = serde_json::from_value::<
                        Vec<crate::conditional_formatting::ConditionalFormatDefinition>,
                    >(entry.rules.clone())
                    {
                        for d in &defs {
                            max_id = max_id.max(d.id);
                        }
                        store.entry(idx).or_default().extend(defs);
                    }
                }
            }
        }
        if let Ok(mut next_id) = state.next_cf_rule_id.lock() {
            if *next_id <= max_id {
                *next_id = max_id + 1;
            }
        }
    }

    // Materialize pulled data validations onto the (remapped) local sheet index.
    if !result.data_validations.is_empty() {
        let mut store = state.data_validations.lock().map_err(|e| e.to_string())?;
        for entry in &result.data_validations {
            if let Some(&idx) = pkg_to_index.get(&entry.sheet_id) {
                if let Ok(ranges) = serde_json::from_value::<
                    Vec<crate::data_validation::ValidationRange>,
                >(entry.ranges.clone())
                {
                    store.entry(idx).or_default().extend(ranges);
                }
            }
        }
    }

    // On-grid name snapshot for the pane-control collision guard below —
    // taken BEFORE the package's own on-grid controls materialize, so the
    // guard sees only the SUBSCRIBER's pre-existing names. Taking it after
    // would let the package's own just-landed on-grid names enter
    // taken_names and shadow the package's own same-named pane controls.
    // (The snapshot's lock is released inside the helper before any other
    // control lock is taken — canonical order preserved.)
    let on_grid_snapshot = snapshot_on_grid_controls(&state)?;

    // Materialize pulled controls (buttons/checkboxes) onto the freshly-
    // appended sheets — SANITIZED: distributed onSelect wiring is inline
    // script source and must not execute outside the consent model, so
    // packaged buttons arrive visually intact but disarmed. Publisher-shipped
    // interactivity flows through the consent-gated object scripts above.
    if !result.controls.is_empty() {
        let local_sheet_ids: std::collections::HashMap<SheetId, (SheetId, String)> = result
            .sheets
            .iter()
            .map(|p| (p.package_sheet_id, (p.sheet.id, p.name.clone())))
            .collect();
        let sanitized = crate::controls::sanitize_distributed_controls(&result.controls);
        let mut controls = state.controls.lock().map_err(|e| e.to_string())?;
        crate::controls::materialize_saved_controls(
            &sanitized,
            &mut controls,
            |sid| pkg_to_index.get(&sid).copied(),
        );
        for entry in &result.controls {
            if let Some((local_sid, sheet_name)) = local_sheet_ids.get(&entry.sheet_id) {
                sub_objects.push(sub_object(
                    "controlSheet",
                    local_sid.to_string(),
                    sheet_name.clone(),
                ));
            }
        }
    }

    // Materialize generic custom objects (distribution brick 4). Cell types
    // (the dogfood) are applied Rust-side, mirroring controls: reconstruct a
    // per-sheet SavedSheetCellTypes and materialize with the package->local
    // sheet remap. Unknown kinds fall through to the frontend response
    // (`custom_objects`) for third-party distributable-object providers. Every
    // custom object is recorded in the subscription ledger.
    let mut frontend_custom_objects: Vec<PulledCustomObjectDto> = Vec::new();
    {
        let cell_type_saved: Vec<persistence::SavedSheetCellTypes> = result
            .custom_objects
            .iter()
            .filter(|co| co.kind == "cellType")
            .filter_map(|co| {
                co.package_sheet_id.map(|sid| persistence::SavedSheetCellTypes {
                    sheet_id: sid,
                    cells: co.payload.clone(),
                })
            })
            .collect();
        if !cell_type_saved.is_empty() {
            let mut cell_types = state.cell_types.lock().map_err(|e| e.to_string())?;
            crate::cell_types::materialize_saved_cell_types(
                &cell_type_saved,
                &mut cell_types,
                |sid| pkg_to_index.get(&sid).copied(),
            );
        }
        for co in &result.custom_objects {
            sub_objects.push(sub_object(&co.kind, co.id.clone(), co.name.clone()));
            // Non-built-in kinds go to the frontend for provider materialization.
            if co.kind != "cellType" {
                frontend_custom_objects.push(PulledCustomObjectDto {
                    kind: co.kind.clone(),
                    id: co.id.clone(),
                    name: co.name.clone(),
                    sheet_index: co
                        .package_sheet_id
                        .and_then(|sid| pkg_to_index.get(&sid).copied()),
                    payload: co.payload.clone(),
                });
            }
        }
    }

    // Materialize pulled pane controls (Controls pane) into PaneControlState —
    // shared with the refresh path (see materialize_pulled_pane_controls for
    // the collision/ordering semantics). Ledger entries come from the APPLIED
    // list so a collision-skipped control is never attributed to this package.
    // `on_grid_snapshot` predates the package's own on-grid materialization
    // above (see the comment at its binding).
    let applied_pane_controls = materialize_pulled_pane_controls(
        &pane_control_state,
        &ribbon_filter_state,
        &on_grid_snapshot,
        &result.pane_controls,
    )?;
    for (id, name) in &applied_pane_controls {
        sub_objects.push(sub_object("paneControl", id.clone(), name.clone()));
    }

    // Delete-path hygiene: a collision-skipped pane control must not leave
    // the package's own just-landed "pane-{id}" object script behind with no
    // host control. Prune EXACTLY those scripts — this package's Distributed
    // set only; local scripts, other packages' scripts, and pane scripts of
    // applied/retained (id-collision) controls are untouched. Ledger entries
    // for pruned scripts are dropped too: they never became subscriber state.
    {
        let orphaned = orphaned_pane_script_instance_ids(
            &pane_control_state,
            &result.pane_controls,
        )?;
        if !orphaned.is_empty() {
            let mut removed_ids: std::collections::HashSet<String> =
                std::collections::HashSet::new();
            let mut scripts = state.object_scripts.lock().map_err(|e| e.to_string())?;
            scripts.retain(|s| {
                let orphan = matches!(s.provenance, persistence::ScriptProvenance::Distributed)
                    && s.package_name.as_deref() == Some(result.package_name.as_str())
                    && s.instance_id.as_deref().is_some_and(|i| orphaned.contains(i));
                if orphan {
                    crate::log_warn!(
                        "CALP",
                        "Pruning distributed script '{}' from package '{}': its host pane control was collision-skipped",
                        s.name, result.package_name
                    );
                    removed_ids.insert(s.id.clone());
                }
                !orphan
            });
            drop(scripts);
            sub_objects.retain(|o| !(o.kind == "objectScript" && removed_ids.contains(&o.id)));
        }
    }

    // Materialize pulled standalone module scripts + notebooks (C8) into
    // ScriptState. Shared with the refresh path so updates propagate
    // identically. Ledger entries come from the APPLIED lists so a
    // conflict-skipped local document is never attributed to this package.
    let (applied_modules, applied_notebooks) = materialize_distributed_scripts(
        &script_state,
        &result.package_name,
        &result.module_scripts,
        &result.notebooks,
    )?;
    for (id, name) in &applied_modules {
        sub_objects.push(sub_object("moduleScript", id.clone(), name.clone()));
    }
    for (id, name) in &applied_notebooks {
        sub_objects.push(sub_object("notebook", id.clone(), name.clone()));
    }
    for def in &result.pivot_definitions {
        sub_objects.push(sub_object("pivot", def.id.to_string(), String::new()));
    }
    for ds in &result.data_sources {
        sub_objects.push(sub_object(
            "dataSource",
            ds.definition.id.clone(),
            ds.definition.name.clone(),
        ));
    }

    // Store subscription — WITH the provenance ledger of what this pull
    // actually materialized. Must precede rebuild_writeback_index (it reads
    // the subscription list).
    {
        let mut subscription = result.subscription;
        subscription.objects = sub_objects;
        let mut subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
        subs.subscriptions.push(subscription);
    }

    // Rebuild writeback index from updated subscriptions
    rebuild_writeback_index(&state);

    // Auto-load embedded BI models from the pulled package.
    // This creates BI connections so that BI pivots have a live engine to query.
    let embedded_connection_ids =
        load_embedded_data_sources(&result.data_sources, &bi_state, &ribbon_filter_state);

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

    // Audit (B4)
    {
        let now = chrono::Utc::now().to_rfc3339();
        let user = audit_user(&state);
        if let Ok(mut audit) = state.audit_log.lock() {
            audit.record(
                calp::audit::AuditEvent::Subscribe,
                &format!(
                    "Subscribed to {} v{} ({} sheets, {} scripts)",
                    result.package_name, result.resolved_version, sheets_pulled, scripts_pulled
                ),
                &user,
                &now,
            );
        }
    }

    Ok(PullResponse {
        package_name: result.package_name,
        resolved_version: result.resolved_version.to_string(),
        sheets_pulled,
        // Tables actually MATERIALIZED into the workbook (collision-skipped
        // ones excluded) — the old count reported tables merely read from the
        // package, overstating what happened.
        tables_pulled: tables_materialized,
        scripts_pulled,
        publisher_name,
        trust_status,
        custom_objects: frontend_custom_objects,
    })
}

/// Browse packages in a local registry.
#[tauri::command]
pub fn calp_browse_registry(
    registry_path: String,
    window: tauri::Window,
) -> Result<Vec<PackageInfo>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let registry = crate::calp_registry::open_registry(&registry_path)
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
    /// Per-object transparency for the pre-pull review: names of the tables
    /// and named ranges the package carries (counts alone hide what arrives).
    pub table_names: Vec<String>,
    pub named_range_names: Vec<String>,
    pub chart_count: usize,
    pub sparkline_count: usize,
    pub pivot_count: usize,
    /// Sheets carrying cell-anchored controls (buttons/checkboxes).
    pub control_sheet_count: usize,
    /// Pane controls (Controls pane widgets) the package carries —
    /// workbook-scoped, materialized into the subscriber's Controls pane.
    pub pane_control_count: usize,
    /// Their display names (per-object transparency, like table_names).
    pub pane_control_names: Vec<String>,
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
    let registry = crate::calp_registry::open_registry(&registry_path)
        .map_err(|e| e.to_string())?;

    let pin = VersionPin::parse(&version_pin).map_err(|e| e.to_string())?;
    let resolved = registry
        .resolve_version(&package_name, &pin)
        .map_err(|e| e.to_string())?;
    let version = resolved.to_string();

    // S5 phase 2: read the manifest bytes ONCE, verify the Ed25519 signature +
    // TOFU pin over exactly those bytes, and parse the contents from them BEFORE
    // surfacing anything — inspect is a pre-pull trust surface, so an
    // unsigned/tampered/hijacked package must fail to inspect, not just to pull.
    // Transport-agnostic (reads manifest + .sig via the transport) so an HTTP
    // registry is verified exactly like a local one — no local dir required, and
    // no split-view between the signed bytes and the surfaced inventory.
    let (trust, manifest) = calp::integrity::verify_and_load_manifest_via(
        registry.as_ref(),
        &package_name,
        &version,
        &calcula_profile_dir(),
    )
    .map_err(|e| e.to_string())?;
    let trust_status = match trust {
        calp::integrity::TrustStatus::FirstUse => "firstUse",
        calp::integrity::TrustStatus::Verified => "verified",
    }
    .to_string();

    // Per-object detail read from the (integrity-checked) artifacts — computed
    // BEFORE the response literal because the literal moves package_name/version.
    let table_names: Vec<String> = {
        let mut names = Vec::new();
        for table_id in &manifest.tables {
            if let Ok(Some(bytes)) = registry.read_artifact(
                &package_name,
                &version,
                &format!("tables/{}.json", table_id),
            ) {
                if let Ok(table) = serde_json::from_slice::<persistence::SavedTable>(&bytes) {
                    names.push(table.name);
                }
            }
        }
        names
    };
    let chart_count = match registry.read_artifact(&package_name, &version, "charts.json") {
        Ok(Some(bytes)) => serde_json::from_slice::<Vec<persistence::SavedChart>>(&bytes)
            .map(|v| v.len())
            .unwrap_or(0),
        _ => 0,
    };
    let sparkline_count = match registry.read_artifact(&package_name, &version, "sparklines.json") {
        Ok(Some(bytes)) => serde_json::from_slice::<Vec<persistence::SavedSparkline>>(&bytes)
            .map(|v| v.len())
            .unwrap_or(0),
        _ => 0,
    };
    // Pivot artifacts are enumerated from the SIGNED manifest's checksum keys —
    // a transport dir-walk lists nothing once publish commits artifacts into
    // the content-addressed blob store.
    let pivot_count = manifest
        .artifact_checksums
        .keys()
        .filter(|p| {
            p.starts_with("pivot_definitions/")
                && p.ends_with(".json")
                && p.as_str() != "pivot_definitions/bi_metadata.json"
        })
        .count();
    let control_sheet_count =
        match registry.read_artifact(&package_name, &version, "controls.json") {
            Ok(Some(bytes)) => {
                serde_json::from_slice::<Vec<persistence::SavedSheetControls>>(&bytes)
                    .map(|v| v.len())
                    .unwrap_or(0)
            }
            _ => 0,
        };
    // Pane controls (workbook-scoped): count AND names, so the subscriber
    // reviews what will land in their Controls pane instead of accepting blind.
    let pane_control_names: Vec<String> =
        match registry.read_artifact(&package_name, &version, "pane_controls.json") {
            Ok(Some(bytes)) => serde_json::from_slice::<Vec<persistence::SavedPaneControl>>(&bytes)
                .map(|v| v.into_iter().map(|c| c.name).collect())
                .unwrap_or_default(),
            _ => Vec::new(),
        };

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
        table_names,
        named_range_names: manifest.named_ranges.iter().map(|nr| nr.name.clone()).collect(),
        chart_count,
        sparkline_count,
        pivot_count,
        control_sheet_count,
        pane_control_count: pane_control_names.len(),
        pane_control_names,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageObjectInfo {
    pub kind: String,
    pub id: String,
    pub name: String,
    /// Whether the object still exists in the live workbook (a subscriber may
    /// have deleted it since the pull).
    pub present: bool,
    /// The sheet the object lives on, when resolvable.
    pub sheet_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageSheetObjectInfo {
    pub local_name: String,
    pub local_sheet_index: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageObjectsResponse {
    pub package_name: String,
    pub resolved_version: String,
    pub registry_url: String,
    pub sheets: Vec<PackageSheetObjectInfo>,
    pub objects: Vec<PackageObjectInfo>,
}

/// Resolve one subscription's provenance ledger against the live workbook:
/// which sheets and objects are connected to this package, and whether each
/// still exists. Backs the Package Explorer pane.
#[tauri::command]
pub fn calp_get_package_objects(
    state: State<AppState>,
    pivot_state: State<crate::pivot::types::PivotState>,
    script_state: State<crate::scripting::types::ScriptState>,
    bi_state: State<BiState>,
    pane_control_state: State<crate::pane_control::PaneControlState>,
    package_name: String,
    window: tauri::Window,
) -> Result<PackageObjectsResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
    let Some(sub) = subs
        .subscriptions
        .iter()
        .find(|s| s.package_name == package_name)
    else {
        return Err(format!("No subscription named '{}'", package_name));
    };

    let sheet_ids = state.sheet_ids.lock().map_err(|e| e.to_string())?;
    let sheet_names = state.sheet_names.lock().map_err(|e| e.to_string())?;

    let sheets: Vec<PackageSheetObjectInfo> = sub
        .sheets
        .iter()
        .map(|s| {
            let idx = sheet_ids.iter().position(|id| *id == s.local_sheet_id);
            PackageSheetObjectInfo {
                local_name: idx
                    .and_then(|i| sheet_names.get(i).cloned())
                    .unwrap_or_else(|| s.local_name.clone()),
                local_sheet_index: idx,
            }
        })
        .collect();

    let tables = state.tables.lock().map_err(|e| e.to_string())?;
    let charts = state.charts.lock().map_err(|e| e.to_string())?;
    let named_ranges = state.named_ranges.lock().map_err(|e| e.to_string())?;
    let object_scripts = state.object_scripts.lock().map_err(|e| e.to_string())?;
    let pivot_tables = pivot_state.pivot_tables.lock().map_err(|e| e.to_string())?;
    let workbook_scripts = script_state.workbook_scripts.lock().map_err(|e| e.to_string())?;
    let workbook_notebooks = script_state
        .workbook_notebooks
        .lock()
        .map_err(|e| e.to_string())?;
    let connections = bi_state.connections.lock().map_err(|e| e.to_string())?;
    // Pane-control lock: safe alongside the AppState locks above (the
    // pane_control/types.rs order constraint only forbids holding it while
    // acquiring the grid locks, which this command never touches).
    let pane_controls = pane_control_state.controls.lock().map_err(|e| e.to_string())?;

    let sheet_name_at =
        |idx: usize| -> String { sheet_names.get(idx).cloned().unwrap_or_default() };

    let objects: Vec<PackageObjectInfo> = sub
        .objects
        .iter()
        .map(|o| {
            let (present, sheet_name) = match o.kind.as_str() {
                "table" => tables
                    .iter()
                    .find(|(_, m)| m.keys().any(|id| id.to_string() == o.id))
                    .map(|(idx, _)| (true, sheet_name_at(*idx)))
                    .unwrap_or((false, String::new())),
                "chart" => charts
                    .iter()
                    .find(|c| c.id.to_string() == o.id)
                    .map(|c| (true, sheet_name_at(c.sheet_index)))
                    .unwrap_or((false, String::new())),
                "namedRange" => (named_ranges.contains_key(&o.id), String::new()),
                "objectScript" => (
                    object_scripts.iter().any(|s| s.id == o.id),
                    String::new(),
                ),
                "moduleScript" => (workbook_scripts.contains_key(&o.id), String::new()),
                "notebook" => (workbook_notebooks.contains_key(&o.id), String::new()),
                "pivot" => (
                    pivot_tables.keys().any(|k| k.to_string() == o.id),
                    String::new(),
                ),
                "dataSource" => (
                    connections
                        .values()
                        .any(|c| c.package_data_source_id.as_deref() == Some(o.id.as_str())),
                    String::new(),
                ),
                // Pane controls are workbook-scoped (no sheet), like pivots.
                "paneControl" => (
                    pane_controls.keys().any(|k| k.to_string() == o.id),
                    String::new(),
                ),
                "controlSheet" => sheet_ids
                    .iter()
                    .position(|id| id.to_string() == o.id)
                    .map(|idx| (true, sheet_name_at(idx)))
                    .unwrap_or((false, String::new())),
                _ => (false, String::new()),
            };
            PackageObjectInfo {
                kind: o.kind.clone(),
                id: o.id.clone(),
                name: o.name.clone(),
                present,
                sheet_name,
            }
        })
        .collect();

    Ok(PackageObjectsResponse {
        package_name: sub.package_name.clone(),
        resolved_version: sub.resolved_version.clone(),
        registry_url: sub.registry_url.clone(),
        sheets,
        objects,
    })
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
    pane_control_state: State<crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
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
                crate::calculation::recalculate_sheet_values(&state, &user_files_state, &pivot_state, idx, Some((&*pane_control_state, &*ribbon_filter_state)));
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
    pane_control_state: State<crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
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
                crate::calculation::recalculate_sheet_values(&state, &user_files_state, &pivot_state, idx, Some((&*pane_control_state, &*ribbon_filter_state)));
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
        let registry = crate::calp_registry::open_registry(&registry_path)
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
    bi_state: State<BiState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
    pane_control_state: State<crate::pane_control::PaneControlState>,
    window: tauri::Window,
) -> Result<calp::refresh::RefreshResult, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let now = chrono::Utc::now().to_rfc3339();

    // Pull new versions for all subscriptions that have updates.
    let payloads = {
        let subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
        let mut all_payloads = Vec::new();
        for (registry_path, indices) in group_subscriptions_by_registry(&subs.subscriptions) {
            let registry = crate::calp_registry::open_registry(&registry_path)
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

    // Map each refreshed package sheet id -> its LOCAL sheet index, so named
    // ranges + CF/DV (which carry un-remapped PACKAGE sheet ids) materialize onto
    // the right sheet. Updated sheets resolve via the subscription's local_sheet_id
    // (still the pre-refresh mapping here); new sheets were just appended under
    // their own fresh local id (pulled.sheet.id). Runs AFTER sheet materialization
    // and BEFORE apply_refresh moves `payloads`.
    let cfdv_pkg_to_index: std::collections::HashMap<SheetId, usize> = {
        let subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
        let sheet_ids = state.sheet_ids.lock().map_err(|e| e.to_string())?;
        let mut map = std::collections::HashMap::new();
        for payload in &payloads {
            let Some(sub) = subs.subscriptions.get(payload.subscription_index) else {
                continue;
            };
            for pulled in &payload.pull_result.sheets {
                let local_sid = sub
                    .sheets
                    .iter()
                    .find(|s| s.package_sheet_id == pulled.package_sheet_id)
                    .map(|s| s.local_sheet_id)
                    .unwrap_or(pulled.sheet.id); // new sheet: its own fresh local id
                if let Some(idx) = sheet_ids.iter().position(|id| *id == local_sid) {
                    map.insert(pulled.package_sheet_id, idx);
                }
            }
        }
        map
    };

    // Materialize refreshed named ranges + CF/DV — the refresh analog of the
    // calp_pull materialization. Without this a refresh delivers v2 sheets/scripts
    // but leaves the subscriber stuck on v1's CF/DV/named ranges. Done before the
    // payloads move into apply_refresh; the post-refresh recalc resolves names.
    {
        // Named ranges: refresh applies the publisher's latest, so UPSERT by the
        // uppercased key (vs calp_pull's skip-if-present at first subscribe).
        // (Cannot distinguish a publisher-removed name from a subscriber's own
        // without provenance, so removals don't propagate — a known limit.)
        if payloads.iter().any(|p| !p.pull_result.named_ranges.is_empty()) {
            let mut names = state.named_ranges.lock().map_err(|e| e.to_string())?;
            for payload in &payloads {
                for nr in &payload.pull_result.named_ranges {
                    names.insert(
                        nr.name.to_uppercase(),
                        crate::named_ranges::NamedRange {
                            name: nr.name.clone(),
                            sheet_index: nr.sheet_id.and_then(|sid| cfdv_pkg_to_index.get(&sid).copied()),
                            refers_to: nr.refers_to.clone(),
                            comment: None,
                            folder: None,
                        },
                    );
                }
            }
        }

        // CF/DV: RESET each refreshed sheet's per-sheet entry, then apply v2's, so
        // rules the publisher added/changed/removed in v2 all land (extend would
        // duplicate across refreshes since refreshed sheets keep their local id).
        let refreshed_indices: std::collections::HashSet<usize> =
            cfdv_pkg_to_index.values().copied().collect();

        let mut max_cf_id: u64 = 0;
        {
            let mut store = state.conditional_formats.lock().map_err(|e| e.to_string())?;
            for idx in &refreshed_indices {
                store.remove(idx);
            }
            for payload in &payloads {
                for entry in &payload.pull_result.conditional_formats {
                    if let Some(&idx) = cfdv_pkg_to_index.get(&entry.sheet_id) {
                        if let Ok(defs) = serde_json::from_value::<
                            Vec<crate::conditional_formatting::ConditionalFormatDefinition>,
                        >(entry.rules.clone())
                        {
                            for d in &defs {
                                max_cf_id = max_cf_id.max(d.id);
                            }
                            store.insert(idx, defs);
                        }
                    }
                }
            }
        }
        if let Ok(mut next_id) = state.next_cf_rule_id.lock() {
            if *next_id <= max_cf_id {
                *next_id = max_cf_id + 1;
            }
        }

        {
            let mut store = state.data_validations.lock().map_err(|e| e.to_string())?;
            for idx in &refreshed_indices {
                store.remove(idx);
            }
            for payload in &payloads {
                for entry in &payload.pull_result.data_validations {
                    if let Some(&idx) = cfdv_pkg_to_index.get(&entry.sheet_id) {
                        if let Ok(ranges) = serde_json::from_value::<
                            Vec<crate::data_validation::ValidationRange>,
                        >(entry.ranges.clone())
                        {
                            store.insert(idx, ranges);
                        }
                    }
                }
            }
        }
    }

    // Cell types (distribution brick 4): refresh analog of the calp_pull
    // materialization — RESET each refreshed sheet's assignments then apply the
    // new version's, mirroring CF/DV so publisher add/change/remove all land.
    {
        let refreshed_indices: std::collections::HashSet<usize> =
            cfdv_pkg_to_index.values().copied().collect();
        let mut cell_types = state.cell_types.lock().map_err(|e| e.to_string())?;
        cell_types.retain(|(si, _, _), _| !refreshed_indices.contains(si));
        let saved: Vec<persistence::SavedSheetCellTypes> = payloads
            .iter()
            .flat_map(|p| p.pull_result.custom_objects.iter())
            .filter(|co| co.kind == "cellType")
            .filter_map(|co| {
                co.package_sheet_id.map(|sid| persistence::SavedSheetCellTypes {
                    sheet_id: sid,
                    cells: co.payload.clone(),
                })
            })
            .collect();
        crate::cell_types::materialize_saved_cell_types(
            &saved,
            &mut cell_types,
            |sid| cfdv_pkg_to_index.get(&sid).copied(),
        );
    }

    // Materialize refreshed sheet presentation state (merges, freeze panes,
    // tab color, visibility, gridlines, page setup, notes, hyperlinks) with
    // reset semantics — the publisher owns a subscribed sheet's presentation —
    // and keep the index-aligned per-sheet stores aligned for sheets this
    // refresh appended. The refresh analog of the calp_pull materialization.
    {
        let active = *state.active_sheet.lock().map_err(|e| e.to_string())?;
        for payload in &payloads {
            let pairs: Vec<(SheetId, &persistence::Sheet)> = payload
                .pull_result
                .sheets
                .iter()
                .map(|p| (p.package_sheet_id, &p.sheet))
                .collect();
            materialize_pulled_sheet_state(&state, &pairs, &cfdv_pkg_to_index, active)?;
        }
    }

    // Provenance-ledger updates accumulated per subscription while payloads
    // are still borrowable; merged into the subscriptions after apply_refresh.
    let mut refresh_ledgers: std::collections::HashMap<usize, Vec<calp::manifest::SubscribedObject>> =
        std::collections::HashMap::new();
    let ledger_entry = |kind: &str, id: String, name: String| calp::manifest::SubscribedObject {
        kind: kind.to_string(),
        id,
        name,
        extra: std::collections::HashMap::new(),
    };

    // Tables: replace this package's own tables (from the provenance ledger)
    // with the new version's set, so table changes actually land on refresh.
    // Subscriber-authored tables are not in the ledger and are never touched.
    {
        // Removal first (its own lock scope), then the shared additive
        // materializer re-adds the v2 set.
        {
            let subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
            let mut tables = state.tables.lock().map_err(|e| e.to_string())?;
            let mut table_names = state.table_names.lock().map_err(|e| e.to_string())?;
            for payload in &payloads {
                let Some(sub) = subs.subscriptions.get(payload.subscription_index) else {
                    continue;
                };
                let owned: std::collections::HashSet<String> = sub
                    .objects
                    .iter()
                    .filter(|o| o.kind == "table")
                    .map(|o| o.id.clone())
                    .collect();
                if !owned.is_empty() {
                    for sheet_tables in tables.values_mut() {
                        sheet_tables.retain(|id, t| {
                            let keep = !owned.contains(&id.to_string());
                            if !keep {
                                table_names.remove(&t.name.to_uppercase());
                            }
                            keep
                        });
                    }
                }
            }
        }
        for payload in &payloads {
            let entries = refresh_ledgers.entry(payload.subscription_index).or_default();
            materialize_pulled_tables(
                &state,
                &payload.pull_result.tables,
                &cfdv_pkg_to_index,
                Some(entries),
            )?;
        }
    }

    // Charts: same ledger-scoped replace, so v2 charts actually land on
    // refresh (previously a subscriber stayed on v1 charts forever). Chart
    // sheet ids in the payload are the FRESH local ids this pull minted; map
    // fresh id -> package id -> existing local index.
    {
        let subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
        let mut charts = state.charts.lock().map_err(|e| e.to_string())?;
        for payload in &payloads {
            let Some(sub) = subs.subscriptions.get(payload.subscription_index) else {
                continue;
            };
            let owned: std::collections::HashSet<String> = sub
                .objects
                .iter()
                .filter(|o| o.kind == "chart")
                .map(|o| o.id.clone())
                .collect();
            charts.retain(|c| !owned.contains(&c.id.to_string()));
            let fresh_to_pkg: std::collections::HashMap<SheetId, SheetId> = payload
                .pull_result
                .sheets
                .iter()
                .map(|p| (p.sheet.id, p.package_sheet_id))
                .collect();
            let entries = refresh_ledgers.entry(payload.subscription_index).or_default();
            for chart in &payload.pull_result.charts {
                let Some(pkg_sid) = fresh_to_pkg.get(&chart.sheet_id) else {
                    continue;
                };
                let Some(&idx) = cfdv_pkg_to_index.get(pkg_sid) else {
                    continue;
                };
                if !charts.iter().any(|c| c.id == chart.id) {
                    entries.push(ledger_entry("chart", chart.id.to_string(), String::new()));
                    charts.push(crate::api_types::ChartEntry {
                        id: chart.id,
                        sheet_index: idx,
                        spec_json: chart.spec_json.clone(),
                    });
                }
            }
        }
    }

    // Sparklines + controls: RESET each refreshed sheet's entries then apply
    // v2's (CF/DV semantics — sparklines carry no id, and controls are
    // publisher-owned presentation on subscribed sheets). Yields the on-grid
    // snapshot for the pane-control collision guard below: cloned AFTER the
    // reset removed the packages' v1 on-grid controls but BEFORE the v2 set
    // lands, so the guard sees only the SUBSCRIBER's own on-grid names —
    // never the packages' own (v1 or just-landed v2) names, which would
    // shadow the packages' own same-named pane controls.
    let on_grid_snapshot = {
        let refreshed: std::collections::HashSet<usize> =
            cfdv_pkg_to_index.values().copied().collect();
        {
            let mut sparklines = state.sparklines.lock().map_err(|e| e.to_string())?;
            sparklines.retain(|e| !refreshed.contains(&e.sheet_index));
            for payload in &payloads {
                let fresh_to_pkg: std::collections::HashMap<SheetId, SheetId> = payload
                    .pull_result
                    .sheets
                    .iter()
                    .map(|p| (p.sheet.id, p.package_sheet_id))
                    .collect();
                for sp in &payload.pull_result.sparklines {
                    let Some(pkg_sid) = fresh_to_pkg.get(&sp.sheet_id) else { continue };
                    let Some(&idx) = cfdv_pkg_to_index.get(pkg_sid) else { continue };
                    sparklines.push(crate::api_types::SparklineEntry {
                        sheet_index: idx,
                        groups_json: sp.groups_json.clone(),
                    });
                }
            }
        }
        {
            let mut controls = state.controls.lock().map_err(|e| e.to_string())?;
            controls.retain(|(sheet_idx, _, _), _| !refreshed.contains(sheet_idx));
            // Cloned under the ALREADY-HELD controls lock (calling
            // snapshot_on_grid_controls here would re-lock and deadlock);
            // released with this scope, before the pane/filter locks below.
            let snapshot = controls.clone();
            let sheet_ids = state.sheet_ids.lock().map_err(|e| e.to_string())?;
            let sheet_names = state.sheet_names.lock().map_err(|e| e.to_string())?;
            for payload in &payloads {
                // Same sanitization as first pull: distributed onSelect wiring
                // (inline script source) never materializes.
                let sanitized =
                    crate::controls::sanitize_distributed_controls(&payload.pull_result.controls);
                crate::controls::materialize_saved_controls(
                    &sanitized,
                    &mut controls,
                    |sid| cfdv_pkg_to_index.get(&sid).copied(),
                );
                let entries = refresh_ledgers.entry(payload.subscription_index).or_default();
                for entry in &payload.pull_result.controls {
                    if let Some(&idx) = cfdv_pkg_to_index.get(&entry.sheet_id) {
                        if let Some(local_sid) = sheet_ids.get(idx) {
                            entries.push(ledger_entry(
                                "controlSheet",
                                local_sid.to_string(),
                                sheet_names.get(idx).cloned().unwrap_or_default(),
                            ));
                        }
                    }
                }
            }
            snapshot
        }
    };

    // Pane controls: same ledger-scoped replace as tables/charts — remove the
    // package's own pane controls (from the provenance ledger; subscriber-
    // authored ones are never in it and are never touched), then re-add the
    // new version's set through the SAME collision-guarded materializer
    // calp_pull uses (a v2 control landing on a subscriber-taken name is
    // skipped, not clobbered). Without this a subscriber stayed on first-pull
    // pane controls forever. Fresh "paneControl" ledger entries come from the
    // APPLIED list; like every other kind here, refresh mutates backend state
    // directly and the document-modified flag stays frontend-owned
    // (mark_file_modified after the command returns).
    //
    // Yields package name -> "pane-{id}" instance ids of incoming pane
    // controls whose host did NOT land (collision-skipped, not retained):
    // the script swap below must not land those packages' host-less pane
    // scripts (delete-path hygiene).
    let orphaned_pane_instances: std::collections::HashMap<
        String,
        std::collections::HashSet<String>,
    > = {
        // Removal first (its own lock scope, subscriptions before pane
        // controls — the same order as the table/chart removal blocks), then
        // the shared additive materializer re-adds the v2 set.
        {
            let subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
            let mut controls = pane_control_state.controls.lock().map_err(|e| e.to_string())?;
            for payload in &payloads {
                let Some(sub) = subs.subscriptions.get(payload.subscription_index) else {
                    continue;
                };
                let owned: std::collections::HashSet<String> = sub
                    .objects
                    .iter()
                    .filter(|o| o.kind == "paneControl")
                    .map(|o| o.id.clone())
                    .collect();
                if !owned.is_empty() {
                    controls.retain(|id, _| !owned.contains(&id.to_string()));
                }
            }
        }
        // `on_grid_snapshot` was cloned above AFTER the refreshed sheets'
        // on-grid controls were reset but BEFORE v2's landed, so a package's
        // own on-grid names never block its own pane controls (they only
        // guard the subscriber's).
        let mut orphaned: std::collections::HashMap<
            String,
            std::collections::HashSet<String>,
        > = std::collections::HashMap::new();
        for payload in &payloads {
            let applied = materialize_pulled_pane_controls(
                &pane_control_state,
                &ribbon_filter_state,
                &on_grid_snapshot,
                &payload.pull_result.pane_controls,
            )?;
            let entries = refresh_ledgers.entry(payload.subscription_index).or_default();
            for (id, name) in applied {
                entries.push(ledger_entry("paneControl", id, name));
            }
            let missing_hosts = orphaned_pane_script_instance_ids(
                &pane_control_state,
                &payload.pull_result.pane_controls,
            )?;
            if !missing_hosts.is_empty() {
                orphaned
                    .entry(payload.pull_result.package_name.clone())
                    .or_default()
                    .extend(missing_hosts);
            }
        }
        orphaned
    };

    // Ledger entries for named ranges (upserted unconditionally above, so the
    // full v2 set is accurate). Script kinds (objectScript/moduleScript/
    // notebook) are recorded at their point of ACTUAL application below — the
    // swap/materialize conflict guards can skip entries, and a skipped local
    // script must never be attributed to the package.
    for payload in &payloads {
        let entries = refresh_ledgers.entry(payload.subscription_index).or_default();
        for nr in &payload.pull_result.named_ranges {
            entries.push(ledger_entry("namedRange", nr.name.to_uppercase(), nr.name.clone()));
        }
    }

    // Re-materialize refreshed package data sources: swap each existing
    // package connection's engine onto the new version's model (and create
    // connections for data sources ADDED in this version). Without this, a
    // dataset (model-only) subscription refresh advanced the version while
    // silently serving the old model. Existing dataSource ledger entries
    // carry over in the merge below; only newly-added ones are appended.
    for payload in &payloads {
        let added = refresh_embedded_data_sources(
            &payload.pull_result.data_sources,
            &bi_state,
            &ribbon_filter_state,
        );
        if !added.is_empty() {
            let entries = refresh_ledgers.entry(payload.subscription_index).or_default();
            for (id, name) in added {
                entries.push(ledger_entry("dataSource", id, name));
            }
        }
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

    // Merge the provenance-ledger updates into the refreshed subscriptions:
    // kinds this refresh re-materialized are replaced with the v2 set; kinds a
    // refresh does not touch (pivots, data sources) carry over from the pull.
    // paneControl deliberately does NOT carry over: every refreshed payload
    // re-materializes pane controls above (pull_all_updates always reads
    // pane_controls.json, empty set included, and every payload enters
    // refresh_ledgers via the tables block), so the fresh entries are the
    // full truth — carrying old ones would resurrect ledger rows for controls
    // the v2 removal just deleted. Subscriptions WITHOUT an update never get
    // a payload, never enter refresh_ledgers, and keep their ledger wholesale.
    for (sub_idx, new_entries) in refresh_ledgers {
        if let Some(sub) = subs.subscriptions.get_mut(sub_idx) {
            let mut objects: Vec<calp::manifest::SubscribedObject> = sub
                .objects
                .iter()
                .filter(|o| o.kind == "pivot" || o.kind == "dataSource")
                .cloned()
                .collect();
            objects.extend(new_entries);
            sub.objects = objects;
        }
    }

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
    // (package name, ledger entries) for scripts ACTUALLY applied by the swap
    // and the module/notebook materialization below — appended to each
    // subscription's ledger afterwards, so a conflict-skipped local script is
    // never attributed to a package.
    let mut applied_script_entries: Vec<(String, Vec<calp::manifest::SubscribedObject>)> =
        Vec::new();
    {
        let mut scripts = state.object_scripts.lock().map_err(|e| e.to_string())?;
        for (package_name, new_scripts) in script_updates {
            scripts.retain(|s| {
                !(matches!(s.provenance, persistence::ScriptProvenance::Distributed)
                    && s.package_name.as_deref() == Some(package_name.as_str()))
            });
            let orphaned = orphaned_pane_instances.get(&package_name);
            let mut applied: Vec<calp::manifest::SubscribedObject> = Vec::new();
            for script in new_scripts {
                // Delete-path hygiene: a v2 "pane-{id}" script whose host
                // pane control was collision-skipped above never lands —
                // it would persist host-less (inert, but a distributed
                // script with nothing to attach to). Applied/retained
                // controls' scripts, and everything non-pane, pass through.
                if orphaned.is_some_and(|set| {
                    script.instance_id.as_deref().is_some_and(|i| set.contains(i))
                }) {
                    crate::log_warn!(
                        "CALP",
                        "Skipping distributed script '{}' from package '{}': its host pane control was collision-skipped",
                        script.name, package_name
                    );
                    continue;
                }
                // Never let a package script shadow an unrelated local
                // script that happens to share its id.
                if !scripts.iter().any(|s| s.id == script.id) {
                    applied.push(calp::manifest::SubscribedObject {
                        kind: "objectScript".to_string(),
                        id: script.id.clone(),
                        name: script.name.clone(),
                        extra: std::collections::HashMap::new(),
                    });
                    scripts.push(script);
                }
            }
            applied_script_entries.push((package_name, applied));
        }
    }

    // C8: materialize each refreshed package's standalone module scripts +
    // notebooks so upstream updates (incl. removals) actually land on refresh,
    // while preserving subscriber-local same-id documents.
    for (pkg, modules, notebooks) in &module_notebook_updates {
        let (applied_modules, applied_notebooks) =
            materialize_distributed_scripts(&script_state, pkg, modules, notebooks)?;
        let mut entries: Vec<calp::manifest::SubscribedObject> = Vec::new();
        for (id, name) in applied_modules {
            entries.push(calp::manifest::SubscribedObject {
                kind: "moduleScript".to_string(),
                id,
                name,
                extra: std::collections::HashMap::new(),
            });
        }
        for (id, name) in applied_notebooks {
            entries.push(calp::manifest::SubscribedObject {
                kind: "notebook".to_string(),
                id,
                name,
                extra: std::collections::HashMap::new(),
            });
        }
        applied_script_entries.push((pkg.clone(), entries));
    }

    // Complete the provenance ledger with the script kinds recorded above at
    // their point of actual application. (The earlier merge replaced all
    // non-pivot/dataSource entries, so appending here cannot duplicate.)
    {
        let mut subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
        for (pkg, entries) in applied_script_entries {
            if entries.is_empty() {
                continue;
            }
            if let Some(sub) = subs
                .subscriptions
                .iter_mut()
                .find(|s| s.package_name == pkg)
            {
                sub.objects.extend(entries);
            }
        }
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
            crate::calculation::recalculate_sheet_values(&state, &user_files_state, &pivot_state, idx, Some((&*pane_control_state, &*ribbon_filter_state)));
        }
    }

    // Audit (B4)
    {
        let now = chrono::Utc::now().to_rfc3339();
        let user = audit_user(&state);
        if let Ok(mut audit) = state.audit_log.lock() {
            audit.record(
                calp::audit::AuditEvent::Refresh,
                "Refreshed subscriptions from registry",
                &user,
                &now,
            );
        }
    }

    Ok(result)
}

/// The display name of the current subscriber identity, for an audit `user`
/// field (best-effort; empty when no identity is established).
fn audit_user(state: &AppState) -> String {
    state
        .subscriber_identity
        .lock()
        .ok()
        .and_then(|id| id.as_ref().map(|i| i.display_name.clone()))
        .unwrap_or_default()
}

/// Strip all subscriptions and overrides, converting the workbook to a
/// standalone (detached) document.
#[tauri::command]
pub fn calp_detach(state: State<AppState>, window: tauri::Window) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let mut subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
    let mut layer = state.override_layer.lock().map_err(|e| e.to_string())?;

    let detached_count = subs.subscriptions.len();
    calp::refresh::detach(&mut subs.subscriptions, &mut layer);

    // Clear writeback index (no subscriptions remain)
    drop(subs);
    drop(layer);
    if let Ok(mut idx) = state.writeback_index.lock() {
        *idx = calp::WritebackIndex::default();
    }
    invalidate_gather_cache(&state);

    // Audit (B4)
    {
        let now = chrono::Utc::now().to_rfc3339();
        let user = audit_user(&state);
        if let Ok(mut audit) = state.audit_log.lock() {
            audit.record(
                calp::audit::AuditEvent::Detach,
                &format!("Detached from {} subscription(s)", detached_count),
                &user,
                &now,
            );
        }
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
    window: tauri::Window,
) -> Result<PullResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let source = std::path::Path::new(&params.source_path);
    let now = chrono::Utc::now().to_rfc3339();

    let result = calp::dev_mode::pull_dev(source, &params.sheet_names)
        .map_err(|e| e.to_string())?;

    let sheets_pulled = result.sheets.len();

    // Resolve the package name from the subscription that will be created.
    let package_name = format!("dev:{}", params.source_path);

    // Materialize pulled sheets into the workbook.
    let dev_map: std::collections::HashMap<SheetId, usize> = {
        let mut grids = state.grids.lock().map_err(|e| e.to_string())?;
        let mut sheet_names = state.sheet_names.lock().map_err(|e| e.to_string())?;
        let mut sheet_ids = state.sheet_ids.lock().map_err(|e| e.to_string())?;
        let mut shared_styles = state.style_registry.lock().map_err(|e| e.to_string())?;
        let mut all_cw = state.all_column_widths.lock().map_err(|e| e.to_string())?;
        let mut all_rh = state.all_row_heights.lock().map_err(|e| e.to_string())?;

        let mut map = std::collections::HashMap::new();
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

            map.insert(pulled.source_sheet_id, grids.len());
            grids.push(grid);
            sheet_names.push(pulled.name.clone());
            sheet_ids.push(pulled.sheet.id);
            all_cw.push(pulled.sheet.column_widths.clone());
            all_rh.push(pulled.sheet.row_heights.clone());
        }
        map
    };

    // Dev preview = subscriber fidelity: presentation state, tables and
    // controls materialize exactly like a real pull (controls sanitized the
    // same way), so the author's fast loop previews what subscribers get.
    {
        let active = *state.active_sheet.lock().map_err(|e| e.to_string())?;
        let pairs: Vec<(SheetId, &persistence::Sheet)> = result
            .sheets
            .iter()
            .map(|p| (p.source_sheet_id, &p.sheet))
            .collect();
        materialize_pulled_sheet_state(&state, &pairs, &dev_map, active)?;
    }
    let mut dev_objects: Vec<calp::manifest::SubscribedObject> = Vec::new();
    let tables_pulled =
        materialize_pulled_tables(&state, &result.tables, &dev_map, Some(&mut dev_objects))?;
    materialize_dev_controls(&state, &result, &dev_map, &mut dev_objects)?;

    // Store the dev subscription (with the provenance ledger, so the Package
    // Explorer works for dev subscriptions too).
    {
        let mut subscription = calp::dev_mode::make_dev_subscription(
            &params.source_path,
            &result,
            &now,
        );
        subscription.objects = dev_objects;
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
        custom_objects: Vec::new(),
    })
}

/// Materialize a dev pull's controls (sanitized like a real pull) and record
/// controlSheet ledger entries. Shared by dev subscribe + dev refresh.
fn materialize_dev_controls(
    state: &AppState,
    result: &calp::dev_mode::DevPullResult,
    dev_map: &std::collections::HashMap<SheetId, usize>,
    ledger: &mut Vec<calp::manifest::SubscribedObject>,
) -> Result<(), String> {
    if result.controls.is_empty() {
        return Ok(());
    }
    let sanitized = crate::controls::sanitize_distributed_controls(&result.controls);
    let mut controls = state.controls.lock().map_err(|e| e.to_string())?;
    crate::controls::materialize_saved_controls(&sanitized, &mut controls, |sid| {
        dev_map.get(&sid).copied()
    });
    drop(controls);
    let sheet_ids = state.sheet_ids.lock().map_err(|e| e.to_string())?;
    let sheet_names = state.sheet_names.lock().map_err(|e| e.to_string())?;
    for entry in &result.controls {
        if let Some(&idx) = dev_map.get(&entry.sheet_id) {
            if let Some(local_sid) = sheet_ids.get(idx) {
                ledger.push(calp::manifest::SubscribedObject {
                    kind: "controlSheet".to_string(),
                    id: local_sid.to_string(),
                    name: sheet_names.get(idx).cloned().unwrap_or_default(),
                    extra: std::collections::HashMap::new(),
                });
            }
        }
    }
    Ok(())
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
    let package_name = format!("dev:{}", source_path);

    // Replace sheets already tracked by this subscription; append any new ones.
    let dev_map: std::collections::HashMap<SheetId, usize> = {
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

        let mut map = std::collections::HashMap::new();
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
                    map.insert(pulled.source_sheet_id, grid_idx);
                }
            } else {
                // New sheet added since last pull — append.
                map.insert(pulled.source_sheet_id, grids.len());
                grids.push(grid);
                sheet_names_state.push(pulled.name.clone());
                sheet_ids.push(pulled.sheet.id);
                all_cw.push(pulled.sheet.column_widths.clone());
                all_rh.push(pulled.sheet.row_heights.clone());
            }
        }
        map
    };

    // Dev refresh mirrors the real refresh: presentation state resets to the
    // source's, this subscription's own tables are replaced with the new set,
    // and controls reset (sanitized) on the refreshed sheets.
    {
        let active = *state.active_sheet.lock().map_err(|e| e.to_string())?;
        let pairs: Vec<(SheetId, &persistence::Sheet)> = result
            .sheets
            .iter()
            .map(|p| (p.source_sheet_id, &p.sheet))
            .collect();
        materialize_pulled_sheet_state(&state, &pairs, &dev_map, active)?;
    }
    {
        // Remove this dev subscription's ledger-owned tables, then re-add v2.
        let owned: std::collections::HashSet<String> = {
            let subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
            subs.subscriptions[sub_index]
                .objects
                .iter()
                .filter(|o| o.kind == "table")
                .map(|o| o.id.clone())
                .collect()
        };
        if !owned.is_empty() {
            let mut tables = state.tables.lock().map_err(|e| e.to_string())?;
            let mut table_names = state.table_names.lock().map_err(|e| e.to_string())?;
            for sheet_tables in tables.values_mut() {
                sheet_tables.retain(|id, t| {
                    let keep = !owned.contains(&id.to_string());
                    if !keep {
                        table_names.remove(&t.name.to_uppercase());
                    }
                    keep
                });
            }
        }
    }
    let mut dev_objects: Vec<calp::manifest::SubscribedObject> = Vec::new();
    let tables_pulled =
        materialize_pulled_tables(&state, &result.tables, &dev_map, Some(&mut dev_objects))?;
    {
        let refreshed: std::collections::HashSet<usize> = dev_map.values().copied().collect();
        let mut controls = state.controls.lock().map_err(|e| e.to_string())?;
        controls.retain(|(sheet_idx, _, _), _| !refreshed.contains(sheet_idx));
    }
    materialize_dev_controls(&state, &result, &dev_map, &mut dev_objects)?;

    // Update the subscription timestamp + provenance ledger (a dev
    // subscription only ever owns tables + control sheets, so wholesale
    // replacement is accurate).
    {
        let mut subs = state.subscriptions.lock().map_err(|e| e.to_string())?;
        subs.subscriptions[sub_index].resolved_at = now;
        subs.subscriptions[sub_index].objects = dev_objects;
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
        custom_objects: Vec::new(),
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
    let mut entries = index.to_flat_list(&id_to_index);

    // Enrich each entry with its declaration's value type / required / deadline,
    // so the client commit guard can coerce typed input and the UI can show a
    // deadline countdown. The flat index carries no schema; the declarations do.
    if let Ok(decls) = state.writeback_declarations.lock() {
        for e in entries.iter_mut() {
            if let Some(decl) = decls.iter().find(|d| d.id == e.region_id) {
                if let Some(schema) = &decl.schema {
                    e.value_type = Some(match schema.value_type {
                        calp::writeback::ValueType::Number => "number",
                        calp::writeback::ValueType::Integer => "integer",
                        calp::writeback::ValueType::Text => "text",
                        calp::writeback::ValueType::Date => "date",
                        calp::writeback::ValueType::Boolean => "boolean",
                        calp::writeback::ValueType::Enum => "enum",
                    }.to_string());
                    e.required = Some(schema.required);
                    // Custom validator name rides the schema's forward-compat
                    // `extra` map (author writes `customValidator`), surfaced so
                    // the subscriber client can run it as an advisory check.
                    e.custom_validator = schema
                        .extra
                        .get("customValidator")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                }
                if let Some(calp::writeback::LifecyclePolicy::UntilDeadline { deadline: Some(dl) }) =
                    &decl.lifecycle
                {
                    e.deadline = Some(dl.clone());
                }
            }
        }
    }
    Ok(entries)
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
        let registry = match crate::calp_registry::open_registry(registry_path) {
            Ok(r) => r,
            Err(_) => continue,
        };
        // Trust-bearing read: these region declarations drive GATHER cell
        // geometry AND schema validation, and rebuild runs on plain workbook
        // OPEN (no pull() in the path), so an HTTP subscription would otherwise
        // re-install regions from an unsigned manifest a hostile server fully
        // controls (moving/expanding selectors to remap which cells GATHER
        // reads/writes). Verify the Ed25519 signature + TOFU over the single
        // trusted manifest copy; on failure, skip (never install unsigned decls).
        if let Ok((_, ver_manifest)) = calp::integrity::verify_and_load_manifest_via(
            registry.as_ref(), &sub.package_name, &sub.resolved_version, &calcula_profile_dir(),
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
            crate::calp_registry::open_registry(&registry_path)
        else {
            continue;
        };
        // Verify before believing a subscription's claim to own this region —
        // the authoritative submit re-validates too, but locating the target
        // registry from an unsigned manifest would let a hostile registry claim
        // regions it does not legitimately declare.
        let Ok((_, manifest)) = calp::integrity::verify_and_load_manifest_via(
            registry.as_ref(), &sub.package_name, &sub.resolved_version, &calcula_profile_dir(),
        )
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
    registry: &dyn calp::RegistryTransport,
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
        crate::calp_registry::open_registry(&registry_path)
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
                Err("This region is one-shot: the value was already submitted and cannot be changed. Ask the publisher to reject it if you need to revise.".to_string())
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
        review_reason: None,
        reviewed_by: None,
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

/// Reconcile the local writeback layer's submission STATES from the registry —
/// the return leg of the writeback loop (P0). After a subscriber submits, the
/// publisher may approve or reject the value in the registry; without this the
/// local layer (which drives the WritebackPane and the grid cell styling) would
/// stay "submitted" forever and a rejected contributor would never be told.
///
/// For each locally-submitted (non-Draft) entry, adopt the state of the
/// subscriber's OWN current registry record for that (region, cell) slot —
/// newest across the resolved version and older ones (lenient carry-forward).
/// Unsent drafts (Draft state) are left untouched.
fn reconcile_writeback_layer_internal(state: &AppState) -> Result<(), String> {
    // Which regions have a submitted entry whose status we should re-check?
    let region_ids: Vec<String> = {
        let layer = state.writeback_layer.lock().map_err(|e| e.to_string())?;
        let mut set = std::collections::BTreeSet::new();
        for d in &layer.drafts {
            if !matches!(d.state, calp::writeback::SubmissionState::Draft) {
                set.insert(d.region_id.clone());
            }
        }
        set.into_iter().collect()
    };
    if region_ids.is_empty() {
        return Ok(());
    }

    let own = get_subscriber_identity(state)?;

    // Build (region, row, col) -> current registry record for our OWN slots.
    let mut by_slot: std::collections::HashMap<
        (String, u32, u32),
        calp::writeback::WritebackSubmission,
    > = std::collections::HashMap::new();
    for region_id in &region_ids {
        let Ok((package_name, resolved_version, registry_path)) =
            owning_subscription_for_region(state, region_id)
        else {
            continue;
        };
        let Ok(registry) =
            crate::calp_registry::open_registry(&registry_path)
        else {
            continue;
        };
        // Newest version first: resolved, then older versions sorted descending.
        let mut older = older_package_versions(&registry, &package_name, &resolved_version);
        older.sort_by(|a, b| match (calp::SemVer::parse(b), calp::SemVer::parse(a)) {
            (Ok(bv), Ok(av)) => bv.cmp(&av),
            _ => b.cmp(a),
        });
        let mut versions = vec![resolved_version.clone()];
        versions.extend(older);

        let mut seen: std::collections::HashSet<(String, u32, u32)> =
            std::collections::HashSet::new();
        for version in &versions {
            let Ok(subs) = registry.load_submissions(&package_name, version, &own.id) else {
                continue;
            };
            for s in subs {
                if &s.region_id != region_id {
                    continue;
                }
                let key = (s.region_id.clone(), s.cell_row, s.cell_col);
                // First-seen wins => newest version's record is authoritative.
                if seen.insert(key.clone()) {
                    by_slot.insert(key, s);
                }
            }
        }
    }

    // Adopt the registry state + review feedback onto local non-Draft entries.
    {
        let mut layer = state.writeback_layer.lock().map_err(|e| e.to_string())?;
        for d in layer.drafts.iter_mut() {
            if matches!(d.state, calp::writeback::SubmissionState::Draft) {
                continue;
            }
            if let Some(reg) = by_slot.get(&(d.region_id.clone(), d.cell_row, d.cell_col)) {
                d.state = reg.state.clone();
                d.review_reason = reg.review_reason.clone();
                d.reviewed_by = reg.reviewed_by.clone();
            }
        }
    }
    Ok(())
}

/// Reconcile local submission states from the registry (approved/rejected
/// read-back) and return the updated writeback layer. This is what the
/// subscriber's UI calls to learn the fate of what they submitted.
#[tauri::command]
pub fn calp_reconcile_writeback(
    state: State<AppState>,
    window: tauri::Window,
) -> Result<calp::writeback::WritebackLayer, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    reconcile_writeback_layer_internal(&state)?;
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

    // OWNERSHIP (P0): every submission we write must be authored by THIS
    // installation. Drafts are stamped with the installation identity on save,
    // but the writeback layer is persisted in the .cala — opening a crafted file
    // could seed a draft attributed to a victim, which would otherwise be written
    // into the victim's registry slot. Refuse rather than impersonate.
    let own = get_subscriber_identity(state)?;
    if let Some(bad) = to_submit.iter().find(|s| s.submitter.id != own.id) {
        return Err(format!(
            "Refusing to submit: a draft is attributed to '{}', not this installation ('{}').",
            bad.submitter.id, own.id
        ));
    }

    // Write to registry BEFORE mutating local state.
    let registry = crate::calp_registry::open_registry(&registry_path)
        .map_err(|e| e.to_string())?;

    // RE-VALIDATE on the authoritative submit path (P0). Schema + lifecycle
    // validation in calp_save_writeback_draft is UX-only and bypassable: a
    // scripted client calling calp_submit_region directly, or a tampered .cala
    // seeding the writeback layer, would otherwise land schema/lifecycle-
    // violating values in the shared registry where GATHER aggregates them. The
    // declaration is resolved from the signature-VERIFIED version manifest
    // (Ed25519 + TOFU over the single trusted copy), not the in-memory layer, so
    // this trust gate stays sound even if the write side is ever made writable
    // over an HTTP transport. Validation runs over the whole batch BEFORE any
    // write, so a single bad value rejects the submit atomically (drafts stay
    // for correction).
    let decl = calp::integrity::verify_and_load_manifest_via(
        &*registry, &package_name, &resolved_version, &calcula_profile_dir(),
    )
    .ok()
    .and_then(|(_, m)| m.writeback_regions)
    .and_then(|regions| regions.into_iter().find(|r| r.id == region_id));
    if let Some(decl) = &decl {
        // COMPLETENESS (P1): a region the publisher marked `required` must have
        // every cell filled before submit — otherwise a contributor can submit a
        // partial mandatory region (2 of 5 line items) believing they're done.
        if decl.schema.as_ref().map(|s| s.required).unwrap_or(false) {
            let sel = &decl.selector;
            let layer = state.writeback_layer.lock().map_err(|e| e.to_string())?;
            let mut missing = Vec::new();
            for row in sel.row_start..=sel.row_end {
                for col in sel.col_start..=sel.col_end {
                    let filled = layer.drafts.iter().any(|d| {
                        d.region_id == *region_id
                            && d.cell_row == row
                            && d.cell_col == col
                            && !matches!(d.value, calp::writeback::SubmissionValue::Empty)
                    });
                    if !filled {
                        missing.push(format!("({}, {})", row + 1, col + 1));
                    }
                }
            }
            if !missing.is_empty() {
                let shown: Vec<String> = missing.iter().take(10).cloned().collect();
                let more = if missing.len() > 10 {
                    format!(" (+{} more)", missing.len() - 10)
                } else {
                    String::new()
                };
                return Err(format!(
                    "This region is required — fill every cell before submitting. Missing {} cell(s): {}{}.",
                    missing.len(),
                    shown.join(", "),
                    more
                ));
            }
        }
        for sub in &to_submit {
            if let Some(schema) = &decl.schema {
                schema.validate(&sub.value).map_err(|msg| {
                    format!(
                        "Submission for cell ({}, {}) failed validation: {}",
                        sub.cell_row, sub.cell_col, msg
                    )
                })?;
            }
            // Lifecycle (deadline / one-shot / locked). One-shot & locked
            // consult the authoritative registry record; others ignore the flag.
            let already_submitted = matches!(
                decl.lifecycle,
                Some(calp::writeback::LifecyclePolicy::Never)
                    | Some(calp::writeback::LifecyclePolicy::RequiresUnlock)
            ) && registry_has_own_submission(state, region_id, sub.cell_row, sub.cell_col);
            check_lifecycle_policy(decl, already_submitted, &now)?;
        }
    }

    for sub in &to_submit {
        registry.save_submission(&package_name, &resolved_version, sub)
            .map_err(|e| e.to_string())?;
    }
    // Refresh the per-version Parquet rollup, if the publisher opted in.
    if rollup_enabled(&registry, &package_name) {
        materialize_submissions_parquet(&registry, &package_name, &resolved_version);
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

/// Submit the drafts of EVERY writeback region that has any — the "I'm done /
/// submit all" action, so a contributor doesn't leave whole regions as unsent
/// drafts believing they're done. Returns the total values submitted. Surfaces
/// the first region's error (e.g. a required region with empty cells), leaving
/// the rest unsubmitted so the contributor can fix and retry.
#[tauri::command]
pub fn calp_submit_all_regions(
    state: State<AppState>,
    window: tauri::Window,
) -> Result<usize, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let region_ids: Vec<String> = {
        let layer = state.writeback_layer.lock().map_err(|e| e.to_string())?;
        let mut set = std::collections::BTreeSet::new();
        for d in &layer.drafts {
            if matches!(d.state, calp::writeback::SubmissionState::Draft) {
                set.insert(d.region_id.clone());
            }
        }
        set.into_iter().collect()
    };
    let mut total = 0usize;
    for region_id in region_ids {
        total += submit_region_internal(&state, &region_id)?;
    }
    Ok(total)
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
    let registry = crate::calp_registry::open_registry(path)
        .map_err(|e| e.to_string())?;
    let export_mode = match mode.as_str() {
        "viewer" => calp::HtmlExportMode::Viewer,
        _ => calp::HtmlExportMode::Static,
    };
    let opts = calp::HtmlExportOptions { mode: export_mode };
    calp::render_package_html(&registry, &package_name, &version, &opts).map_err(|e| e.to_string())
}

/// Authorize a PUBLISHER-only writeback action (approve/reject) against a
/// package version. Proof of publisher ownership is possession of the Ed25519
/// signing key whose public key the SIGNED version manifest asserts as
/// `publisher_key`: the publisher's machine has `publisher-key.json` in its
/// profile dir (written by the first publish), a subscriber does not, and a
/// different publisher's key won't match. Returns a user-facing error otherwise.
fn require_publisher(
    registry: &dyn calp::RegistryTransport,
    package_name: &str,
    version: &str,
) -> Result<(), String> {
    let manifest = registry
        .get_version_manifest(package_name, version)
        .map_err(|e| e.to_string())?;
    let owns = calp::signing::profile_holds_publisher_key(
        &calcula_profile_dir(),
        &manifest.publisher_key,
    )
    .map_err(|e| e.to_string())?;
    if owns {
        Ok(())
    } else {
        Err(format!(
            "Only the publisher of '{}' can approve or reject writeback submissions.",
            package_name
        ))
    }
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
    reason: Option<String>,
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
    let registry = crate::calp_registry::open_registry(&registry_path)
        .map_err(|e| e.to_string())?;

    // AUTHORIZATION (P0): approve/reject is publisher-only. Without this, any
    // subscriber could self-approve an out-of-policy value into an on_approval
    // aggregate, or reject a rival's so GATHER drops it.
    require_publisher(&registry, &package_name, &resolved_version)?;

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
    let reviewer = get_subscriber_identity(&state).ok().map(|i| i.display_name);
    submission.state = target_state;
    submission.updated_at = now.clone();
    // Attach the publisher's reason + identity so the contributor's read-back
    // can show WHY (not just a bare "rejected"). An empty reason clears it.
    submission.review_reason = reason
        .as_ref()
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty());
    submission.reviewed_by = reviewer;

    registry
        .save_submission(&package_name, &version, &submission)
        .map_err(|e| e.to_string())?;
    // Refresh the per-version Parquet rollup, if the publisher opted in.
    if rollup_enabled(&registry, &package_name) {
        materialize_submissions_parquet(&registry, &package_name, &version);
    }
    invalidate_gather_cache(&state);

    // Audit the publisher decision — the provenance of the return leg, so a
    // contributor who is told "rejected" can see who decided and when.
    {
        let mut audit = state.audit_log.lock().map_err(|e| e.to_string())?;
        let user = state
            .subscriber_identity
            .lock()
            .ok()
            .and_then(|id| id.as_ref().map(|i| i.display_name.clone()))
            .unwrap_or_default();
        audit.record(
            calp::audit::AuditEvent::WritebackReviewed,
            &format!(
                "{} {}'s submission for region {} cell ({}, {})",
                new_state, submitter_id, region_id, cell_row, cell_col
            ),
            &user,
            &now,
        );
    }
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
    pub review_reason: Option<String>,
    pub reviewed_by: Option<String>,
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
    load_region_submission_infos(&state, &region_id)
}

/// The current raw record per (submitter, cell) slot for a region, across the
/// resolved version and older ones (lenient carry-forward), sorted by submitter
/// then cell. Shared by the dashboard projection, the CSV export, and the
/// Parquet export so all three see exactly the same set.
fn load_region_current_submissions(
    state: &AppState,
    region_id: &str,
) -> Result<Vec<calp::writeback::WritebackSubmission>, String> {
    let (package_name, resolved_version, registry_path) =
        owning_subscription_for_region(state, region_id)?;
    let registry = crate::calp_registry::open_registry(&registry_path)
        .map_err(|e| e.to_string())?;

    let mut versions = vec![resolved_version.clone()];
    versions.extend(older_package_versions(&registry, &package_name, &resolved_version));

    // Newest version first: keep the current record per (submitter, cell) slot.
    let mut by_slot: std::collections::HashMap<(String, u32, u32), calp::writeback::WritebackSubmission> =
        std::collections::HashMap::new();
    for version in &versions {
        if let Ok(subs) = registry.load_region_submissions(&package_name, version, region_id) {
            for s in subs {
                by_slot
                    .entry((s.submitter.id.clone(), s.cell_row, s.cell_col))
                    .or_insert(s);
            }
        }
    }

    let mut out: Vec<_> = by_slot.into_values().collect();
    out.sort_by(|a, b| {
        a.submitter
            .display_name
            .cmp(&b.submitter.display_name)
            .then(a.cell_row.cmp(&b.cell_row))
            .then(a.cell_col.cmp(&b.cell_col))
    });
    Ok(out)
}

/// The string label for a submission state.
fn submission_state_str(s: &calp::writeback::SubmissionState) -> &'static str {
    use calp::writeback::SubmissionState::*;
    match s {
        Draft => "draft",
        Submitted => "submitted",
        Approved => "approved",
        Rejected => "rejected",
    }
}

/// Shared loader behind `calp_load_region_submissions` and the CSV export: the
/// current record per (submitter, cell) slot, projected for the dashboard.
fn load_region_submission_infos(
    state: &AppState,
    region_id: &str,
) -> Result<Vec<RegionSubmissionInfo>, String> {
    use calp::writeback::SubmissionValue;
    let out: Vec<RegionSubmissionInfo> = load_region_current_submissions(state, region_id)?
        .into_iter()
        .map(|s| {
            let (value_display, value_kind) = match &s.value {
                SubmissionValue::Number { value } => (value.to_string(), "number"),
                SubmissionValue::Text { value } => (value.clone(), "text"),
                SubmissionValue::Boolean { value } => {
                    ((if *value { "TRUE" } else { "FALSE" }).to_string(), "boolean")
                }
                SubmissionValue::Empty => (String::new(), "empty"),
            };
            RegionSubmissionInfo {
                region_id: s.region_id,
                cell_row: s.cell_row,
                cell_col: s.cell_col,
                submitter_id: s.submitter.id,
                submitter_name: s.submitter.display_name,
                value_display,
                value_kind: value_kind.to_string(),
                state: submission_state_str(&s.state).to_string(),
                submitted_at: s.submitted_at,
                updated_at: s.updated_at,
                review_reason: s.review_reason,
                reviewed_by: s.reviewed_by,
            }
        })
        .collect();
    Ok(out)
}

/// Quote a CSV field if it contains a comma, quote, or newline (RFC 4180).
fn csv_escape(s: &str) -> String {
    if s.contains(|c| c == ',' || c == '"' || c == '\n' || c == '\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// Export every submission for a writeback region as CSV text — the publisher's
/// data-collection output, so collected values can be pivoted / reconciled /
/// archived instead of being trapped behind the dashboard list. The frontend
/// saves the returned string as a .csv file.
#[tauri::command]
pub fn calp_export_region_submissions_csv(
    state: State<AppState>,
    region_id: String,
    window: tauri::Window,
) -> Result<String, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let rows = load_region_submission_infos(&state, &region_id)?;
    let mut out =
        String::from("submitter,submitterId,cell,value,type,state,submittedAt,updatedAt,reviewedBy,reviewReason\n");
    for r in &rows {
        let cell = format!("R{}C{}", r.cell_row + 1, r.cell_col + 1);
        let fields = [
            r.submitter_name.as_str(),
            r.submitter_id.as_str(),
            cell.as_str(),
            r.value_display.as_str(),
            r.value_kind.as_str(),
            r.state.as_str(),
            r.submitted_at.as_deref().unwrap_or(""),
            r.updated_at.as_str(),
            r.reviewed_by.as_deref().unwrap_or(""),
            r.review_reason.as_deref().unwrap_or(""),
        ];
        out.push_str(
            &fields
                .iter()
                .map(|f| csv_escape(f))
                .collect::<Vec<_>>()
                .join(","),
        );
        out.push('\n');
    }
    Ok(out)
}

/// A1 reference for a 0-based (row, col): e.g. (1, 1) -> "B2".
fn a1(row: u32, col: u32) -> String {
    let mut letters = String::new();
    let mut n = col as i64;
    loop {
        letters.insert(0, (b'A' + (n % 26) as u8) as char);
        n = n / 26 - 1;
        if n < 0 {
            break;
        }
    }
    format!("{}{}", letters, row + 1)
}

/// Encode a set of writeback submissions as Parquet bytes with a TYPED, columnar
/// schema (separate `value_number`/`value_text`/`value_bool` columns + a
/// `value_kind` discriminator), so a database can read it directly — e.g.
/// `SELECT SUM(value_number) ... WHERE value_kind = 'number'` — without parsing
/// per-slot JSON or guessing types from a CSV.
fn encode_submissions_parquet(
    subs: &[calp::writeback::WritebackSubmission],
) -> Result<Vec<u8>, String> {
    use arrow::array::{ArrayRef, BooleanBuilder, Float64Builder, StringBuilder, UInt32Builder};
    use arrow::datatypes::{DataType, Field, Schema};
    use arrow::record_batch::RecordBatch;
    use calp::writeback::SubmissionValue;
    use std::sync::Arc;

    let mut region_id = StringBuilder::new();
    let mut cell_row = UInt32Builder::new();
    let mut cell_col = UInt32Builder::new();
    let mut cell_ref = StringBuilder::new();
    let mut submitter_id = StringBuilder::new();
    let mut submitter_name = StringBuilder::new();
    let mut value_number = Float64Builder::new();
    let mut value_text = StringBuilder::new();
    let mut value_bool = BooleanBuilder::new();
    let mut value_kind = StringBuilder::new();
    let mut state = StringBuilder::new();
    let mut submitted_at = StringBuilder::new();
    let mut updated_at = StringBuilder::new();
    let mut reviewed_by = StringBuilder::new();
    let mut review_reason = StringBuilder::new();

    for s in subs {
        region_id.append_value(&s.region_id);
        cell_row.append_value(s.cell_row);
        cell_col.append_value(s.cell_col);
        cell_ref.append_value(a1(s.cell_row, s.cell_col));
        submitter_id.append_value(&s.submitter.id);
        submitter_name.append_value(&s.submitter.display_name);
        match &s.value {
            SubmissionValue::Number { value } => {
                value_number.append_value(*value);
                value_text.append_null();
                value_bool.append_null();
                value_kind.append_value("number");
            }
            SubmissionValue::Text { value } => {
                value_number.append_null();
                value_text.append_value(value);
                value_bool.append_null();
                value_kind.append_value("text");
            }
            SubmissionValue::Boolean { value } => {
                value_number.append_null();
                value_text.append_null();
                value_bool.append_value(*value);
                value_kind.append_value("boolean");
            }
            SubmissionValue::Empty => {
                value_number.append_null();
                value_text.append_null();
                value_bool.append_null();
                value_kind.append_value("empty");
            }
        }
        state.append_value(submission_state_str(&s.state));
        submitted_at.append_option(s.submitted_at.as_deref());
        updated_at.append_value(&s.updated_at);
        reviewed_by.append_option(s.reviewed_by.as_deref());
        review_reason.append_option(s.review_reason.as_deref());
    }

    let schema = Arc::new(Schema::new(vec![
        Field::new("region_id", DataType::Utf8, false),
        Field::new("cell_row", DataType::UInt32, false),
        Field::new("cell_col", DataType::UInt32, false),
        Field::new("cell_ref", DataType::Utf8, false),
        Field::new("submitter_id", DataType::Utf8, false),
        Field::new("submitter_name", DataType::Utf8, false),
        Field::new("value_number", DataType::Float64, true),
        Field::new("value_text", DataType::Utf8, true),
        Field::new("value_bool", DataType::Boolean, true),
        Field::new("value_kind", DataType::Utf8, false),
        Field::new("state", DataType::Utf8, false),
        Field::new("submitted_at", DataType::Utf8, true),
        Field::new("updated_at", DataType::Utf8, false),
        Field::new("reviewed_by", DataType::Utf8, true),
        Field::new("review_reason", DataType::Utf8, true),
    ]));

    let columns: Vec<ArrayRef> = vec![
        Arc::new(region_id.finish()),
        Arc::new(cell_row.finish()),
        Arc::new(cell_col.finish()),
        Arc::new(cell_ref.finish()),
        Arc::new(submitter_id.finish()),
        Arc::new(submitter_name.finish()),
        Arc::new(value_number.finish()),
        Arc::new(value_text.finish()),
        Arc::new(value_bool.finish()),
        Arc::new(value_kind.finish()),
        Arc::new(state.finish()),
        Arc::new(submitted_at.finish()),
        Arc::new(updated_at.finish()),
        Arc::new(reviewed_by.finish()),
        Arc::new(review_reason.finish()),
    ];

    let batch = RecordBatch::try_new(schema.clone(), columns).map_err(|e| e.to_string())?;

    let mut buf: Vec<u8> = Vec::new();
    {
        let mut writer = parquet::arrow::ArrowWriter::try_new(&mut buf, schema, None)
            .map_err(|e| e.to_string())?;
        writer.write(&batch).map_err(|e| e.to_string())?;
        writer.close().map_err(|e| e.to_string())?;
    }
    Ok(buf)
}

/// Export every submission for a writeback region as Parquet bytes (typed,
/// columnar — directly readable by DuckDB / Snowflake / Spark / pandas /
/// Polars). The frontend saves the bytes as a `.parquet` file.
#[tauri::command]
pub fn calp_export_region_submissions_parquet(
    state: State<AppState>,
    region_id: String,
    window: tauri::Window,
) -> Result<Vec<u8>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let subs = load_region_current_submissions(&state, &region_id)?;
    encode_submissions_parquet(&subs)
}

/// Best-effort: (re)materialize the per-version Parquet rollup of ALL submissions
/// at `{version}/submissions/_rollup.parquet`, so a database can read the whole
/// collection by pointing at the registry folder — no per-slot JSON parsing, and
/// no manual export. It lives UNDER `submissions/` (the subscriber-written
/// subtree excluded from the package integrity walk) so it never trips pull, and
/// it is a non-`.json` file so it is ignored by submission loading. Called after
/// any write to a version's submissions; failures are logged, not surfaced — the
/// JSON slots remain the source of truth and the next write self-heals the rollup.
fn materialize_submissions_parquet(
    registry: &dyn calp::RegistryTransport,
    package: &str,
    version: &str,
) {
    let subs = match registry.load_all_submissions(package, version) {
        Ok(s) => s,
        Err(e) => {
            crate::log_warn!("CALP", "writeback rollup: load_all_submissions failed: {}", e);
            return;
        }
    };
    let bytes = match encode_submissions_parquet(&subs) {
        Ok(b) => b,
        Err(e) => {
            crate::log_warn!("CALP", "writeback rollup: parquet encode failed: {}", e);
            return;
        }
    };
    if let Err(e) = registry.write_artifact(package, version, "submissions/_rollup.parquet", &bytes) {
        crate::log_warn!("CALP", "writeback rollup: write failed: {}", e);
    }
}

/// Whether the publisher has opted this package into the auto-materialized
/// Parquet rollup. Stored in the (unsigned) package manifest's `extra` —
/// package-level, default OFF, flippable any time by the publisher. It gates
/// *whether* the rollup is regenerated, not a security boundary, so the unsigned
/// package manifest is the right home (no per-version, no signing churn).
fn rollup_enabled(registry: &dyn calp::RegistryTransport, package: &str) -> bool {
    registry
        .get_package_manifest(package)
        .ok()
        .and_then(|m| m.extra.get("writebackRollup").and_then(|v| v.as_bool()))
        .unwrap_or(false)
}

/// Read whether the Parquet rollup is enabled for the package owning a region.
#[tauri::command]
pub fn calp_get_writeback_rollup(
    state: State<AppState>,
    region_id: String,
    window: tauri::Window,
) -> Result<bool, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let (package_name, _v, registry_path) = owning_subscription_for_region(&state, &region_id)?;
    let registry = crate::calp_registry::open_registry(&registry_path)
        .map_err(|e| e.to_string())?;
    Ok(rollup_enabled(&registry, &package_name))
}

/// Publisher-only: enable/disable the auto-materialized Parquet rollup for the
/// package owning a region. Enabling materializes it immediately so the file
/// appears at once (not just on the next submit/approve).
#[tauri::command]
pub fn calp_set_writeback_rollup(
    state: State<AppState>,
    region_id: String,
    enabled: bool,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let (package_name, resolved_version, registry_path) =
        owning_subscription_for_region(&state, &region_id)?;
    let registry = crate::calp_registry::open_registry(&registry_path)
        .map_err(|e| e.to_string())?;
    require_publisher(&registry, &package_name, &resolved_version)?;

    let mut manifest = registry
        .get_package_manifest(&package_name)
        .map_err(|e| e.to_string())?;
    if enabled {
        manifest
            .extra
            .insert("writebackRollup".to_string(), serde_json::Value::Bool(true));
    } else {
        manifest.extra.remove("writebackRollup");
    }
    registry
        .write_package_manifest(&manifest)
        .map_err(|e| e.to_string())?;

    if enabled {
        materialize_submissions_parquet(&registry, &package_name, &resolved_version);
    }
    Ok(())
}

/// Completion-tracking status for a writeback region: who the publisher expects
/// to respond, who has, and who is still missing.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionResponseStatus {
    /// The publisher's declared expected respondents (verbatim).
    pub expected: Vec<String>,
    /// Distinct submitter display names that have a non-empty submission.
    pub responded: Vec<String>,
    /// Expected identifiers with no matching submission yet.
    pub missing: Vec<String>,
}

/// Compute who has responded vs. who is still expected for a region — the
/// publisher's "7 of 12 submitted / chase the rest" view. Matches each declared
/// expected respondent case-insensitively against any submitter's display name
/// or id (with a substring fallback so "Alice" matches "Alice (North)").
#[tauri::command]
pub fn calp_region_response_status(
    state: State<AppState>,
    region_id: String,
    window: tauri::Window,
) -> Result<RegionResponseStatus, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let (package_name, resolved_version, registry_path) =
        owning_subscription_for_region(&state, &region_id)?;
    let registry = crate::calp_registry::open_registry(&registry_path)
        .map_err(|e| e.to_string())?;

    let expected: Vec<String> = registry
        .get_version_manifest(&package_name, &resolved_version)
        .ok()
        .and_then(|m| m.writeback_regions)
        .and_then(|regions| regions.into_iter().find(|r| r.id == region_id))
        .map(|d| d.expected_respondents)
        .unwrap_or_default();

    // Distinct submitters (id -> display name) with a non-empty submission,
    // across the resolved version and older ones (lenient carry-forward).
    let mut versions = vec![resolved_version.clone()];
    versions.extend(older_package_versions(&registry, &package_name, &resolved_version));
    let mut respondents: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for version in &versions {
        if let Ok(subs) = registry.load_region_submissions(&package_name, version, &region_id) {
            for s in subs {
                if matches!(s.value, calp::writeback::SubmissionValue::Empty) {
                    continue;
                }
                respondents
                    .entry(s.submitter.id.clone())
                    .or_insert(s.submitter.display_name.clone());
            }
        }
    }

    Ok(compute_response_status(expected, &respondents))
}

/// Pure completion-tracking computation (extracted for unit testing): given the
/// declared expected respondents and `respondents` (id -> display name of
/// everyone with a non-empty submission), return who responded and who's
/// missing. An expected entry matches case-insensitively on a submitter's id or
/// display name, with a substring fallback either way ("Alice" ⇄ "Alice (North)").
fn compute_response_status(
    expected: Vec<String>,
    respondents: &std::collections::HashMap<String, String>,
) -> RegionResponseStatus {
    let mut responded: Vec<String> = respondents.values().cloned().collect();
    responded.sort();
    responded.dedup();

    let matched = |exp: &str| -> bool {
        let e = exp.trim().to_lowercase();
        if e.is_empty() {
            return true; // a blank expected entry isn't "missing"
        }
        respondents.iter().any(|(id, name)| {
            let n = name.to_lowercase();
            id.to_lowercase() == e || n == e || n.contains(&e) || e.contains(&n)
        })
    };
    let missing: Vec<String> = expected.iter().filter(|e| !matched(e)).cloned().collect();

    RegionResponseStatus { expected, responded, missing }
}

/// Apply a region's GATHER governance to its submissions: approval gating,
/// drop cleared cells, READ-SIDE schema + deadline integrity, then visibility
/// (own_only hides others; own_plus_aggregate keeps values but anonymizes other
/// submitters). Pure + unit-tested — this is the privacy AND integrity boundary
/// for what reaches an aggregate, so it must never silently change.
fn apply_gather_governance(
    mut submissions: Vec<calp::writeback::WritebackSubmission>,
    region: &calp::WritebackRegionDeclaration,
    own_identity: Option<&calp::SubmitterIdentity>,
) -> Vec<calp::writeback::WritebackSubmission> {
    // PRIVACY FAIL-CLOSED (C2b): "is this submission the reader's own?" must
    // treat a BLANK/whitespace reader id as NO identity. A corrupt or
    // hand-written subscriber-identity.json with "id":"" would otherwise make
    // own.id == "" match every anonymized record (OwnPlusAggregate itself clears
    // ids to "") — leaking other people's values under own_only. With a blank
    // reader id this returns false everywhere, so own_only reveals nothing and
    // own_plus_aggregate anonymizes EVERYONE (the safe direction). A real minted
    // identity always carries a non-blank UUID, so legitimate views are
    // unaffected. See also the load-time guard in calp::identity_provider.
    fn is_own(own: Option<&calp::SubmitterIdentity>, submission_id: &str) -> bool {
        match own {
            Some(o) if !o.id.trim().is_empty() => o.id == submission_id,
            _ => false,
        }
    }

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

    // READ-SIDE SCHEMA INTEGRITY (P0): the publisher's ValueSchema is enforced
    // on the honest submit path, but the registry is a shared directory — a
    // hand-written submission file can carry an out-of-range or wrong-type value.
    // Drop anything that fails the region's schema so it can never reach an
    // aggregate. (Honest submissions already passed this exact check at submit,
    // so no legitimate value is dropped.)
    if let Some(schema) = &region.schema {
        submissions.retain(|s| schema.validate(&s.value).is_ok());
    }

    // READ-SIDE DEADLINE INTEGRITY (P0): a region with a passed `until_deadline`
    // blocks new submits on the honest path, but a late or backdated file would
    // otherwise still aggregate. Drop any submission whose `submitted_at` is at
    // or after the deadline. Best-effort without a trusted clock: a record that
    // lacks `submitted_at` is kept (we can't prove it was late); the schema gate
    // above still applies to it.
    if let Some(calp::writeback::LifecyclePolicy::UntilDeadline { deadline: Some(dl) }) =
        &region.lifecycle
    {
        submissions.retain(|s| match &s.submitted_at {
            Some(ts) => !deadline_passed(dl, ts),
            None => true,
        });
    }

    // Deterministic ordering BEFORE any anonymization: read_dir / HashMap order
    // is not cross-machine stable, so GATHER and GATHER.SUBMITTERS (which read
    // this same order) would otherwise not be index-pairable across machines.
    submissions.sort_by(|a, b| {
        a.cell_row
            .cmp(&b.cell_row)
            .then(a.cell_col.cmp(&b.cell_col))
            .then(a.submitter.id.cmp(&b.submitter.id))
    });

    // Visibility enforcement. NOTE: the policy docs say "publisher
    // sees all", but without authenticated identities (roadmap D8)
    // every gatherer is a subscriber, so the policy applies to all.
    match region.visibility {
        Some(calp::writeback::VisibilityPolicy::OwnOnly) => {
            submissions.retain(|s| is_own(own_identity, &s.submitter.id));
        }
        Some(calp::writeback::VisibilityPolicy::OwnPlusAggregate) => {
            // Values flow (aggregates need them) but other submitters'
            // identities are anonymized — to a STABLE DISTINCT token ("Submitter
            // 2") rather than a single "(anonymous)", so a roster of N
            // contributors stays distinguishable in GATHER.SUBMITTERS. Tokens
            // are assigned in the (already-deterministic) sorted order.
            let mut token_for: std::collections::HashMap<String, String> =
                std::collections::HashMap::new();
            let mut next: usize = 1;
            for s in submissions.iter() {
                if !is_own(own_identity, &s.submitter.id) && !token_for.contains_key(&s.submitter.id) {
                    token_for.insert(s.submitter.id.clone(), format!("Submitter {next}"));
                    next += 1;
                }
            }
            for s in submissions.iter_mut() {
                if !is_own(own_identity, &s.submitter.id) {
                    s.submitter.display_name = token_for
                        .get(&s.submitter.id)
                        .cloned()
                        .unwrap_or_else(|| "(anonymous)".to_string());
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

        let registry = match crate::calp_registry::open_registry(registry_path) {
            Ok(r) => r,
            Err(_) => continue,
        };

        // Load the version manifest to get writeback regions. GATHER
        // materializes the surviving submissions into workbook cells, and the
        // region declaration governs on_approval filtering, own_only/anonymize
        // visibility, and schema + deadline integrity — so it MUST come from the
        // signature-verified manifest, never a raw (split-viewable) HTTP GET.
        let ver_manifest = match calp::integrity::verify_and_load_manifest_via(
            registry.as_ref(), &sub.package_name, &sub.resolved_version, &calcula_profile_dir(),
        ) {
            Ok((_, m)) => m,
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
                    // Older versions' region schemas gate lenient carry-forward;
                    // verify them exactly as the current version.
                    let manifest = calp::integrity::verify_and_load_manifest_via(
                        registry.as_ref(), &sub.package_name, version, &calcula_profile_dir(),
                    )
                    .map(|(_, m)| m)
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

            let gather_subs: Vec<engine::GatherSubmission> = submissions.iter().filter_map(|s| {
                let value = match &s.value {
                    calp::writeback::SubmissionValue::Number { value } => engine::EvalResult::Number(*value),
                    calp::writeback::SubmissionValue::Text { value } => engine::EvalResult::Text(value.clone()),
                    calp::writeback::SubmissionValue::Boolean { value } => engine::EvalResult::Boolean(*value),
                    // Governance already drops Empty; never coerce it to 0.0
                    // (that would inject a phantom zero into SUM/AVERAGE/COUNT).
                    calp::writeback::SubmissionValue::Empty => return None,
                };
                Some(engine::GatherSubmission {
                    submitter_name: s.submitter.display_name.clone(),
                    submitter_id: s.submitter.id.clone(),
                    // Carry the cell (0-based absolute) so GATHER.AT and the
                    // cell-aware GATHER.FROM/COUNT/SUBMITTERS forms can scope a
                    // multi-cell region's submissions to one input cell.
                    cell_row: s.cell_row,
                    cell_col: s.cell_col,
                    value,
                })
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
        LifecyclePolicy, RegionSelector, SubmissionPolicy, SubmissionState, SubmissionValue,
        ValueSchema, ValueType, VisibilityPolicy, WritebackRegionDeclaration, WritebackSubmission,
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
            review_reason: None,
            reviewed_by: None,
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
            expected_respondents: Vec::new(),
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
        assert_eq!(
            other.submitter.display_name, "Submitter 1",
            "Bob anonymized to a stable distinct token"
        );
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

    // 8b. (C2b) A BLANK own id must fail closed exactly like None: a corrupt
    //     subscriber-identity.json with "id":"" would otherwise match every
    //     anonymized/empty-id record and leak it under own_only.
    #[test]
    fn own_only_with_blank_id_fails_closed() {
        let region = make_region(Some(VisibilityPolicy::OwnOnly), None);
        let ghost = make_identity("", "Ghost"); // blank principal
        let subs = vec![
            make_submission("id-alice", "Alice", SubmissionState::Submitted, num(10.0)),
            // A planted record with an empty submitter id (what OwnPlusAggregate
            // itself produces) — must NOT be revealed to a blank reader.
            make_submission("", "(anonymized)", SubmissionState::Submitted, num(99.0)),
        ];
        let out = apply_gather_governance(subs, &region, Some(&ghost));
        assert!(
            out.is_empty(),
            "a blank reader id reveals nothing, even the empty-id record"
        );
    }

    // 8c. (C2b) OwnPlusAggregate with a blank own id anonymizes EVERYONE — even
    //     the empty-id records OwnPlusAggregate itself produces. We PLANT a
    //     submission with a blank id: under the OLD un-trimmed predicate
    //     own.id("") == submitter.id("") it would be claimed as "own" and keep
    //     its real name; the trim fix anonymizes it like everyone else. (This
    //     planted blank-id row is what makes the test turn RED on the pre-fix
    //     code — a whitespace-only own id alone would have passed on both.)
    #[test]
    fn own_plus_aggregate_with_blank_id_anonymizes_all() {
        let region = make_region(Some(VisibilityPolicy::OwnPlusAggregate), None);
        let ghost = make_identity("", "Ghost"); // blank principal
        let subs = vec![
            make_submission("id-alice", "Alice", SubmissionState::Submitted, num(10.0)),
            make_submission("", "Planted", SubmissionState::Submitted, num(99.0)),
        ];
        let out = apply_gather_governance(subs, &region, Some(&ghost));
        assert_eq!(out.len(), 2, "values still flow for the aggregate");
        for s in &out {
            assert_eq!(s.submitter.id, "", "every id is cleared under a blank reader");
            assert!(
                s.submitter.display_name != "Alice" && s.submitter.display_name != "Planted",
                "no real submitter name survives for a blank reader (got {:?})",
                s.submitter.display_name
            );
        }
    }

    // --- Read-side integrity (P0): schema + deadline filtering ---

    fn make_region_with(
        schema: Option<ValueSchema>,
        lifecycle: Option<LifecyclePolicy>,
    ) -> WritebackRegionDeclaration {
        let mut r = make_region(None, None);
        r.schema = schema;
        r.lifecycle = lifecycle;
        r
    }

    fn number_schema(min: f64, max: f64) -> ValueSchema {
        ValueSchema {
            value_type: ValueType::Number,
            required: false,
            min: Some(min),
            max: Some(max),
            enum_values: Vec::new(),
            max_length: None,
            pattern: None,
            extra: HashMap::new(),
        }
    }

    fn make_submission_at(
        submitter_id: &str,
        state: SubmissionState,
        value: SubmissionValue,
        submitted_at: Option<&str>,
    ) -> WritebackSubmission {
        let mut s = make_submission(submitter_id, submitter_id, state, value);
        s.submitted_at = submitted_at.map(|t| t.to_string());
        s
    }

    // 9. A hand-written out-of-range or wrong-type value never reaches an
    //    aggregate — the read-side schema gate drops it.
    #[test]
    fn schema_drops_out_of_range_and_wrong_type_values() {
        let region = make_region_with(Some(number_schema(0.0, 100.0)), None);
        let subs = vec![
            make_submission("ok", "Ok", SubmissionState::Submitted, num(50.0)),
            make_submission("hi", "Hi", SubmissionState::Submitted, num(9999.0)),
            make_submission(
                "txt",
                "Txt",
                SubmissionState::Submitted,
                SubmissionValue::Text { value: "oops".to_string() },
            ),
        ];
        let out = apply_gather_governance(subs, &region, None);
        assert_eq!(out.len(), 1, "only the in-range numeric value survives");
        assert_eq!(out[0].submitter.id, "ok");
    }

    // 10. A submission made at/after an until_deadline cutoff is dropped at read
    //     time; one made before is kept; one lacking submitted_at is best-effort kept.
    #[test]
    fn deadline_drops_late_submissions() {
        let region = make_region_with(
            None,
            Some(LifecyclePolicy::UntilDeadline {
                deadline: Some("2026-06-15T12:00:00Z".to_string()),
            }),
        );
        let subs = vec![
            make_submission_at("early", SubmissionState::Submitted, num(1.0), Some("2026-06-15T09:00:00Z")),
            make_submission_at("late", SubmissionState::Submitted, num(2.0), Some("2026-06-15T15:00:00Z")),
            make_submission_at("untimed", SubmissionState::Submitted, num(3.0), None),
        ];
        let out = apply_gather_governance(subs, &region, None);
        let ids: Vec<String> = out.iter().map(|s| s.submitter.id.clone()).collect();
        assert!(ids.contains(&"early".to_string()), "before-deadline submission kept");
        assert!(!ids.contains(&"late".to_string()), "after-deadline submission dropped");
        assert!(ids.contains(&"untimed".to_string()), "no timestamp -> best-effort kept");
        assert_eq!(out.len(), 2);
    }

    // 11. Completion tracking: expected respondents are matched (case-insensitive,
    //     with a substring fallback either way) against who actually submitted;
    //     the rest are reported as missing; a blank expected entry is ignored.
    #[test]
    fn response_status_matches_and_lists_missing() {
        let mut respondents = HashMap::new();
        respondents.insert("id-north".to_string(), "Alice (North)".to_string());
        respondents.insert("id-south".to_string(), "Bob".to_string());
        let st = super::compute_response_status(
            vec![
                "Alice".into(),      // substring of "Alice (North)"
                "bob".into(),        // case-insensitive match of "Bob"
                "id-south".into(),   // match by id
                "Carol".into(),      // nobody -> missing
                "  ".into(),         // blank -> ignored
            ],
            &respondents,
        );
        assert_eq!(st.missing, vec!["Carol".to_string()]);
        assert_eq!(st.responded, vec!["Alice (North)".to_string(), "Bob".to_string()]);
    }
}

#[cfg(test)]
mod writeback_export_tests {
    //! The Parquet export/rollup encoder (used by both the on-demand export and
    //! the auto-materialized `_rollup.parquet`).
    use super::{a1, encode_submissions_parquet};
    use calp::writeback::{SubmissionState, SubmissionValue, WritebackSubmission};
    use calp::SubmitterIdentity;
    use std::collections::HashMap;

    fn sub(row: u32, col: u32, value: SubmissionValue) -> WritebackSubmission {
        WritebackSubmission {
            id: format!("s-{row}-{col}"),
            region_id: "r1".to_string(),
            cell_row: row,
            cell_col: col,
            cell_id: None,
            submitter: SubmitterIdentity {
                display_name: "Alice".into(),
                id: "id-alice".into(),
                extra: HashMap::new(),
            },
            value,
            state: SubmissionState::Submitted,
            created_at: "2026-06-15T00:00:00Z".into(),
            updated_at: "2026-06-15T00:00:00Z".into(),
            submitted_at: Some("2026-06-15T00:00:00Z".into()),
            review_reason: None,
            reviewed_by: None,
            extra: HashMap::new(),
        }
    }

    #[test]
    fn a1_reference_formatting() {
        assert_eq!(a1(0, 0), "A1");
        assert_eq!(a1(1, 1), "B2");
        assert_eq!(a1(0, 26), "AA1");
        assert_eq!(a1(4, 1), "B5");
    }

    #[test]
    fn parquet_encodes_mixed_types_to_a_valid_container() {
        let subs = vec![
            sub(1, 1, SubmissionValue::Number { value: 100.0 }),
            sub(2, 1, SubmissionValue::Text { value: "north".into() }),
            sub(3, 1, SubmissionValue::Boolean { value: true }),
            sub(4, 1, SubmissionValue::Empty),
        ];
        let bytes = encode_submissions_parquet(&subs).unwrap();
        // A well-formed Parquet file is framed by the "PAR1" magic at both ends;
        // ArrowWriter + RecordBatch::try_new also validate schema/column shape.
        assert!(bytes.len() > 8);
        assert_eq!(&bytes[0..4], b"PAR1", "parquet header magic");
        assert_eq!(&bytes[bytes.len() - 4..], b"PAR1", "parquet footer magic");
    }

    #[test]
    fn parquet_handles_empty_input() {
        let bytes = encode_submissions_parquet(&[]).unwrap();
        assert_eq!(&bytes[0..4], b"PAR1");
        assert_eq!(&bytes[bytes.len() - 4..], b"PAR1");
    }

    // Integration: the auto-materialize writes a real rollup into a real
    // registry, it reads back as Parquet with one row per slot, and it is
    // invisible to the integrity walk (so it never trips pull) and to
    // submission loading.
    #[test]
    fn rollup_materializes_reads_back_and_is_integrity_excluded() {
        use calp::registry::LocalRegistry;
        use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;

        // A throwaway registry under the OS temp dir.
        let root = std::env::temp_dir().join(format!("calcula_wb_rollup_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let reg = LocalRegistry::open(&root).unwrap();

        // Two submissions (two slots) — one numeric, one text.
        reg.save_submission("pkg", "1.0.0", &sub(1, 1, SubmissionValue::Number { value: 100.0 })).unwrap();
        reg.save_submission("pkg", "1.0.0", &sub(2, 1, SubmissionValue::Text { value: "north".into() })).unwrap();

        super::materialize_submissions_parquet(&reg, "pkg", "1.0.0");

        // The rollup exists under submissions/ and reads back as Parquet.
        let path = reg
            .version_dir("pkg", "1.0.0")
            .unwrap()
            .join("submissions")
            .join("_rollup.parquet");
        assert!(path.exists(), "rollup file written");
        let file = std::fs::File::open(&path).unwrap();
        let reader = ParquetRecordBatchReaderBuilder::try_new(file).unwrap().build().unwrap();
        let total: usize = reader.map(|b| b.unwrap().num_rows()).sum();
        assert_eq!(total, 2, "one row per current slot");

        // Excluded from the integrity walk (never an "unlisted artifact" on pull)...
        let arts = reg.list_artifacts("pkg", "1.0.0").unwrap();
        assert!(!arts.iter().any(|a| a.contains("_rollup")), "rollup excluded from artifacts");
        // ...and ignored by submission loading (still exactly the two JSON slots).
        assert_eq!(reg.load_all_submissions("pkg", "1.0.0").unwrap().len(), 2);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rollup_toggle_defaults_off_and_flips_on() {
        use calp::manifest::PackageManifest;
        use calp::registry::LocalRegistry;

        let root = std::env::temp_dir().join(format!("calcula_wb_toggle_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let reg = LocalRegistry::open(&root).unwrap();

        let mut pm = PackageManifest::new("pkg", "report", "auth", "2026-01-01T00:00:00Z");
        reg.write_package_manifest(&pm).unwrap();
        // Default OFF (opt-in).
        assert!(!super::rollup_enabled(&reg, "pkg"));

        // Publisher flips it on (what calp_set_writeback_rollup persists).
        pm.extra
            .insert("writebackRollup".to_string(), serde_json::Value::Bool(true));
        reg.write_package_manifest(&pm).unwrap();
        assert!(super::rollup_enabled(&reg, "pkg"));

        let _ = std::fs::remove_dir_all(&root);
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
    let registry = crate::calp_registry::open_registry(&registry_path)
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

/// Read + parse a pulled data source's embedded model (ModelBundle wrapper or
/// raw DataModel), format-version checked. Returns the RAW json (for
/// connectionSpecs) and the parsed model; logs and returns None on failure.
fn read_pulled_model(
    ds: &calp::pull::PulledDataSource,
) -> Option<(serde_json::Value, bi_engine::DataModel)> {
    let model_path = ds.model_path.to_string_lossy().to_string();
    let json_str = match std::fs::read_to_string(&ds.model_path) {
        Ok(s) => s,
        Err(e) => {
            crate::log_warn!("CALP", "Failed to read embedded model {}: {}", model_path, e);
            return None;
        }
    };
    let json_value: serde_json::Value = match serde_json::from_str(&json_str) {
        Ok(v) => v,
        Err(e) => {
            crate::log_warn!("CALP", "Failed to parse embedded model JSON {}: {}", model_path, e);
            return None;
        }
    };
    let model_json =
        if json_value.get("model").is_some() && json_value.get("formatVersion").is_some() {
            json_value.get("model").unwrap().clone()
        } else {
            json_value.clone()
        };
    if let Err(e) = crate::bi::commands::check_model_format_version(&model_json) {
        crate::log_warn!("CALP", "Skipping data source {}: {}", ds.definition.id, e);
        return None;
    }
    let model: bi_engine::DataModel = match serde_json::from_value(model_json) {
        Ok(m) => m,
        Err(e) => {
            crate::log_warn!("CALP", "Failed to deserialize DataModel {}: {}", model_path, e);
            return None;
        }
    };
    Some((json_value, model))
}

/// Load embedded BI model data sources from a pulled package into BiState.
/// Returns a mapping from package data source ID to the created connection ID.
/// Also re-binds ribbon filters saved against a previous session's connection
/// uuid to the freshly minted ones (via their stable data_source_id).
fn load_embedded_data_sources(
    data_sources: &[calp::pull::PulledDataSource],
    bi_state: &BiState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
) -> std::collections::HashMap<String, crate::bi::types::ConnectionId> {
    use crate::bi::types::{Connection, ConnectionType};
    use crate::bi::engine_registry::ModelKey;

    let mut ds_to_conn: std::collections::HashMap<String, crate::bi::types::ConnectionId> =
        std::collections::HashMap::new();

    for ds in data_sources {
        let model_path = ds.model_path.to_string_lossy().to_string();

        let Some((json_value, model)) = read_pulled_model(ds) else {
            continue;
        };

        // Extract connection info from connectionSpecs (ModelBundle wrapper level)
        let spec_info = extract_connection_spec_info(&json_value);
        crate::log_info!("CALP-DIAG", "load_embedded_data_sources: ds_id={}, spec_info: server='{}', database='{}', preferred_auth='{}', connector_type='{}'",
            ds.definition.id, spec_info.server, spec_info.database, spec_info.preferred_auth, spec_info.connector_type);

        // Keep the base model so calculated measures can be applied later.
        let base_model = model.clone();
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
            // Restore a saved "view as" RLS role for this package connection
            // (keyed by package data source id), if one was persisted.
            active_role: bi_state.pending_role_for(Some(&ds.definition.id), None),
            base_model: Some(base_model),
            calculated_measures: Vec::new(),
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

    crate::ribbon_filter::remap_ribbon_filter_connections(ribbon_filter_state, &ds_to_conn);

    ds_to_conn
}

/// Re-materialize refreshed package data sources onto their EXISTING
/// connections: swap the shared engine's model to the new version's and
/// update the connection's base_model (workbook calculated measures
/// re-applied on top). Without this, refreshing a dataset (model-only)
/// subscription advanced the version while silently serving the OLD model.
/// Data sources with no existing connection (added in the new version) are
/// freshly materialized; returns their (id, name) pairs for the ledger.
fn refresh_embedded_data_sources(
    data_sources: &[calp::pull::PulledDataSource],
    bi_state: &BiState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
) -> Vec<(String, String)> {
    let mut newly_created: Vec<(String, String)> = Vec::new();
    for ds in data_sources {
        let conn_id = {
            let conns = bi_state.connections.lock().unwrap();
            conns
                .iter()
                .find(|(_, c)| {
                    c.package_data_source_id.as_deref() == Some(ds.definition.id.as_str())
                })
                .map(|(id, _)| *id)
        };
        let Some(conn_id) = conn_id else {
            // Added in this version — materialize like a first pull.
            let created =
                load_embedded_data_sources(std::slice::from_ref(ds), bi_state, ribbon_filter_state);
            if created.contains_key(&ds.definition.id) {
                newly_created.push((ds.definition.id.clone(), ds.definition.name.clone()));
            }
            continue;
        };
        let Some((_, model)) = read_pulled_model(ds) else {
            continue;
        };

        let mut conns = bi_state.connections.lock().unwrap();
        let Some(conn) = conns.get_mut(&conn_id) else {
            continue;
        };
        let combined = if conn.calculated_measures.is_empty() {
            model.clone()
        } else {
            match crate::bi::measures::build_combined_model(&model, &conn.calculated_measures) {
                Ok(m) => m,
                Err(e) => {
                    crate::log_warn!(
                        "CALP",
                        "refresh: measures no longer apply to updated model {} ({}); applying base",
                        ds.definition.id,
                        e
                    );
                    model.clone()
                }
            }
        };
        if let Some(engine_arc) = &conn.engine {
            match engine_arc.try_lock() {
                Ok(mut engine) => {
                    if let Err(e) = engine.set_model(combined) {
                        // Engine kept the old model — leave base_model alone
                        // too, so the connection never CLAIMS the new version.
                        crate::log_warn!(
                            "CALP",
                            "refresh: set_model failed for data source {}: {}",
                            ds.definition.id,
                            e
                        );
                        continue;
                    }
                }
                Err(_) => {
                    crate::log_warn!(
                        "CALP",
                        "refresh: engine busy for data source {} — model NOT updated (re-run Refresh)",
                        ds.definition.id
                    );
                    continue;
                }
            }
        }
        conn.base_model = Some(model);
        crate::log_info!(
            "CALP",
            "refresh: updated embedded model for data source {}",
            ds.definition.id
        );
    }
    newly_created
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
                        data_as_of: saved.data_as_of,
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
                        let mut v = serde_json::to_value(engine.model())
                            .map_err(|e| format!("Failed to serialize model: {}", e))?;
                        // Ensure a GVAR model publishes stamped >= v13 so a
                        // subscriber on an older engine fails closed cleanly.
                        crate::bi::commands::stamp_feature_format_version(engine.model(), &mut v);
                        v
                    }
                    Err(_) => {
                        crate::log_warn!("CALP", "Engine busy for connection {}, skipping", conn.id);
                        continue;
                    }
                }
            }
            None => continue,
        };

        // The connection's own server/database fields are authoritative (they
        // survive URL-style connection strings and restored connections whose
        // connection_string is empty); the key=value parse is the fallback.
        let (parsed_server, parsed_database) = parse_pg_connection_info(&conn.connection_string);
        let server = if !conn.server.is_empty() { conn.server.clone() } else { parsed_server };
        let database = if !conn.database.is_empty() {
            conn.database.clone()
        } else {
            parsed_database
        };

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

            let registry = match crate::calp_registry::open_registry(registry_path) {
                Ok(r) => r,
                Err(_) => continue,
            };

            let ver_manifest = match registry.get_version_manifest(&sub.package_name, &sub.resolved_version) {
                Ok(m) => m,
                Err(_) => continue,
            };

            for ds in &ver_manifest.data_sources {
                // Resolve the model artifact THROUGH the transport, never by hand.
                // publish dedups artifacts into a content-addressed blob store and
                // deletes the per-version copy, so `ver_dir/models/{id}/model.json`
                // no longer exists after any publish — local_artifact_path does the
                // dir-first / blob-fallback resolution that keeps the lazy read
                // working. It also returns None for non-local transports (HTTP),
                // which we skip cleanly instead of reading a bogus "https:/…" path.
                let model_path = match registry.local_artifact_path(
                    &sub.package_name,
                    &sub.resolved_version,
                    &ds.model_path,
                ) {
                    Ok(Some(p)) => p,
                    Ok(None) => {
                        crate::log_warn!(
                            "CALP",
                            "Data source '{}' model refresh is unsupported for this registry transport (no local artifact); skipping",
                            ds.id
                        );
                        continue;
                    }
                    Err(e) => {
                        crate::log_warn!(
                            "CALP",
                            "Failed to resolve model path for {}: {}",
                            ds.id, e
                        );
                        continue;
                    }
                };

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

        let registry = match crate::calp_registry::open_registry(registry_path) {
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

        let registry = match crate::calp_registry::open_registry(registry_path) {
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

#[cfg(test)]
mod pane_control_pull_tests {
    //! Unit tests for the shared pull/refresh pane-control materializer —
    //! above all the taken-names collision guard, which must also cover NAMED
    //! on-grid controls: a pulled pane control shadows them in the
    //! GET.CONTROLVALUE precedence (pane > filter > on-grid), so collisions
    //! are SKIPPED (never renamed, never clobbered), matching the existing
    //! pane/filter collision policy.
    use super::{
        materialize_pulled_pane_controls, orphaned_pane_script_instance_ids,
        pane_control_taken_names,
    };
    use crate::controls::{ControlMetadata, ControlPropertyValue, ControlStorage};
    use crate::pane_control::{PaneControl, PaneControlConfig, PaneControlState, PaneControlType};
    use crate::ribbon_filter::RibbonFilterState;
    use std::collections::HashMap;

    /// An on-grid control whose "name" property has the given type/value.
    fn on_grid(name_type: &str, name: &str) -> ControlMetadata {
        let mut properties = HashMap::new();
        properties.insert(
            "name".to_string(),
            ControlPropertyValue {
                value_type: name_type.to_string(),
                value: name.to_string(),
            },
        );
        ControlMetadata {
            control_type: "button".to_string(),
            properties,
        }
    }

    /// A pulled (package) checkbox pane control.
    fn saved(name: &str, order: u32) -> persistence::SavedPaneControl {
        persistence::SavedPaneControl {
            id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            name: name.to_string(),
            control_type: "checkbox".to_string(),
            config: serde_json::json!({ "type": "checkbox", "label": name }),
            value: serde_json::Value::Null,
            order,
        }
    }

    /// A subscriber-local pane control already in the strip.
    fn existing_pane(name: &str, order: u32) -> PaneControl {
        PaneControl {
            id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            name: name.to_string(),
            control_type: PaneControlType::Checkbox,
            config: PaneControlConfig::Checkbox {
                label: name.to_string(),
            },
            value: None,
            order,
        }
    }

    #[test]
    fn taken_names_include_static_named_on_grid_controls_only() {
        // The static_control_name rule: static + non-empty after trim counts;
        // formula-typed and blank names never block a pull.
        let mut storage: ControlStorage = HashMap::new();
        storage.insert((0, 1, 1), on_grid("static", "  Threshold "));
        storage.insert((0, 2, 1), on_grid("formula", "=A1"));
        storage.insert((0, 3, 1), on_grid("static", "   "));
        let pane = PaneControlState::new();
        let filters = RibbonFilterState::new();
        let names = pane_control_taken_names(
            pane.controls.lock().unwrap().values(),
            filters.filters.lock().unwrap().values(),
            &storage,
        );
        assert_eq!(
            names,
            std::collections::HashSet::from(["THRESHOLD".to_string()])
        );
    }

    #[test]
    fn pulled_pane_control_cannot_shadow_a_named_on_grid_control() {
        let pane = PaneControlState::new();
        let filters = RibbonFilterState::new();
        let mut storage: ControlStorage = HashMap::new();
        storage.insert((0, 0, 0), on_grid("static", "Threshold"));

        // Case-insensitive: "THRESHOLD" collides with on-grid "Threshold"
        // and is skipped; "Rate" lands and is reported as applied.
        let pulled = vec![saved("THRESHOLD", 0), saved("Rate", 1)];
        let applied =
            materialize_pulled_pane_controls(&pane, &filters, &storage, &pulled).unwrap();
        assert_eq!(applied.len(), 1, "applied: {:?}", applied);
        assert_eq!(applied[0].1, "Rate");
        let controls = pane.controls.lock().unwrap();
        assert_eq!(controls.len(), 1);
        assert!(controls.values().all(|c| c.name == "Rate"));
    }

    #[test]
    fn applied_controls_rebase_after_existing_strip_and_skip_id_collisions() {
        let pane = PaneControlState::new();
        let filters = RibbonFilterState::new();
        let existing = existing_pane("Local", 7);
        let existing_id = existing.id;
        pane.controls.lock().unwrap().insert(existing_id, existing);

        // A same-id pull is skipped (never clobbers the subscriber's control);
        // the fresh one appends after the strip's max order.
        let mut same_id = saved("Local2", 0);
        same_id.id = existing_id;
        let pulled = vec![same_id, saved("Fresh", 5)];
        let applied =
            materialize_pulled_pane_controls(&pane, &filters, &HashMap::new(), &pulled).unwrap();
        assert_eq!(applied.len(), 1, "applied: {:?}", applied);
        assert_eq!(applied[0].1, "Fresh");
        let controls = pane.controls.lock().unwrap();
        assert_eq!(controls.len(), 2);
        let fresh = controls.values().find(|c| c.name == "Fresh").unwrap();
        assert_eq!(fresh.order, 8, "re-based to max existing order + 1");
        assert_eq!(
            controls.get(&existing_id).unwrap().name,
            "Local",
            "id collision never clobbers the subscriber's control"
        );
    }

    #[test]
    fn package_own_on_grid_names_never_shadow_its_pane_controls() {
        // The calp_pull/refresh ordering contract: the on-grid snapshot handed
        // to the materializer is taken BEFORE the package's own on-grid
        // controls land. A package shipping BOTH an on-grid button and a pane
        // control named "Threshold" must still get its pane control applied —
        // the guard protects the SUBSCRIBER's pre-existing names, not the
        // package against itself.
        let pane = PaneControlState::new();
        let filters = RibbonFilterState::new();
        // Subscriber's pre-pull on-grid state: one named control of their own.
        let mut storage: ControlStorage = HashMap::new();
        storage.insert((0, 0, 0), on_grid("static", "LocalName"));
        let snapshot = storage.clone(); // what calp_pull snapshots pre-materialization
        // The package's own on-grid control materializes (same name as its
        // pane control) — AFTER the snapshot, so it must not enter taken_names.
        storage.insert((3, 1, 1), on_grid("static", "Threshold"));

        let pulled = vec![saved("Threshold", 0), saved("LocalName", 1)];
        let applied =
            materialize_pulled_pane_controls(&pane, &filters, &snapshot, &pulled).unwrap();
        assert_eq!(applied.len(), 1, "applied: {:?}", applied);
        assert_eq!(
            applied[0].1, "Threshold",
            "the package's own on-grid name must not block its own pane control"
        );
        // The subscriber's name still guards: "LocalName" was skipped.
        assert!(pane.controls.lock().unwrap().values().all(|c| c.name == "Threshold"));
    }

    #[test]
    fn orphaned_pane_script_instances_cover_skipped_but_not_retained_controls() {
        // Name-collision skip -> host absent -> "pane-{id}" reported orphaned.
        // Id-collision skip -> the subscriber's control is retained under that
        // id -> its script keeps a live host -> NOT reported. Applied -> not
        // reported.
        let pane = PaneControlState::new();
        let filters = RibbonFilterState::new();
        let existing = existing_pane("Local", 0);
        let existing_id = existing.id;
        pane.controls.lock().unwrap().insert(existing_id, existing);
        let mut storage: ControlStorage = HashMap::new();
        storage.insert((0, 0, 0), on_grid("static", "Taken"));

        let name_skipped = saved("Taken", 0); // on-grid name collision -> absent
        let mut id_skipped = saved("Local2", 1); // id collision -> retained
        id_skipped.id = existing_id;
        let applied_ok = saved("Fresh", 2); // lands
        let name_skipped_id = name_skipped.id;
        let pulled = vec![name_skipped, id_skipped, applied_ok];

        let applied =
            materialize_pulled_pane_controls(&pane, &filters, &storage, &pulled).unwrap();
        assert_eq!(applied.len(), 1, "applied: {:?}", applied);

        let orphaned = orphaned_pane_script_instance_ids(&pane, &pulled).unwrap();
        assert_eq!(
            orphaned,
            std::collections::HashSet::from([format!("pane-{}", name_skipped_id)]),
            "only the name-collision-skipped control's instance id is orphaned"
        );
    }
}
