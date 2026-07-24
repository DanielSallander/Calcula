//! FILENAME: core/calp/src/pull.rs
//! PURPOSE: Pull (subscribe and materialize) a .calp package into a workbook.
//! CONTEXT: Phase 2 — raw subscribe-and-materialize, no override layer.

use std::path::{Path, PathBuf};
use std::collections::HashMap;

use identity::SheetId;
use persistence::{Sheet, SavedCell, SavedTable, SavedObjectScript, SavedScript, SavedNotebook, SavedChart, SavedSparkline, SavedSheetConditionalFormats, SavedSheetDataValidations, SavedSheetControls, SavedSheetComments, SavedSheetScenarios, SavedSheetOutline, SavedPaneControl, SavedSlicer, SavedRibbonFilter, SavedPivotLayout};

use crate::error::CalpError;
use crate::integrity::TrustStatus;
use crate::manifest::*;
use crate::transport::RegistryTransport;
use crate::version::{SemVer, VersionPin};

/// Request to pull (subscribe to) a package.
pub struct PullRequest {
    pub package_name: String,
    pub registry_url: String,
    pub version_pin: VersionPin,
    pub now: String,
}

/// Result of a pull operation.
pub struct PullResult {
    pub package_name: String,
    pub resolved_version: SemVer,
    pub sheets: Vec<PulledSheet>,
    pub tables: Vec<SavedTable>,
    pub subscription: Subscription,
    /// Object scripts bundled with the package.
    /// These should be loaded in restricted mode and marked as read-only.
    pub object_scripts: Vec<SavedObjectScript>,
    /// Standalone module scripts bundled with the package (C8). Inert,
    /// transparent data: materialized into the workbook on pull but NEVER
    /// auto-executed — they run only on explicit user action, sandboxed.
    pub module_scripts: Vec<SavedScript>,
    /// Standalone notebooks bundled with the package (C8). Inert, transparent
    /// data like module_scripts; execution metadata was stripped at publish.
    pub notebooks: Vec<SavedNotebook>,
    /// Data source definitions from the package, with resolved model paths.
    pub data_sources: Vec<PulledDataSource>,
    /// Pivot table definitions from the package.
    pub pivot_definitions: Vec<persistence::SavedPivotDefinition>,
    /// BI pivot metadata for reconnecting to BI models.
    pub bi_pivot_metadata: Vec<serde_json::Value>,
    /// Charts carried by the package, each with its `sheet_id` already remapped
    /// from the package's sheet id to the new LOCAL sheet id so it materializes
    /// on the right sheet. Empty for packages published before charts were carried.
    pub charts: Vec<SavedChart>,
    /// Sparklines carried by the package (C2a), each with its `sheet_id` already
    /// remapped to the new LOCAL sheet id. Empty for packages published before
    /// sparklines were carried.
    pub sparklines: Vec<SavedSparkline>,
    /// Named ranges carried by the package (from the version manifest). Their
    /// `sheet_id` is the PACKAGE sheet id (un-remapped); the Tauri pull maps it to
    /// the local sheet index. Empty for packages published before names were carried.
    pub named_ranges: Vec<PublishedNamedRange>,
    /// Conditional-formatting rules carried by the package, per sheet. `sheet_id`
    /// is the PACKAGE sheet id (un-remapped); `rules` is the opaque app payload.
    pub conditional_formats: Vec<SavedSheetConditionalFormats>,
    /// Data-validation ranges carried by the package, per sheet. `sheet_id` is the
    /// PACKAGE sheet id (un-remapped); `ranges` is the opaque app payload.
    pub data_validations: Vec<SavedSheetDataValidations>,
    /// Cell-anchored controls carried by the package, per sheet. `sheet_id` is
    /// the PACKAGE sheet id (un-remapped); `controls` is the opaque app payload.
    /// Empty for packages published before controls were carried.
    pub controls: Vec<SavedSheetControls>,
    /// Threaded comments carried by the package, per sheet (Wave B). `sheet_id`
    /// is the PACKAGE sheet id (un-remapped); `comments` is the opaque app
    /// payload. Empty unless the publisher opted in via `include_comments`
    /// (and for packages published before comments were carried).
    pub comments: Vec<SavedSheetComments>,
    /// What-if scenarios carried by the package, per sheet (Wave B). `sheet_id`
    /// is the PACKAGE sheet id (un-remapped); `scenarios` is the opaque app
    /// payload. Empty for older packages.
    pub scenarios: Vec<SavedSheetScenarios>,
    /// Row/column outline groups carried by the package, per sheet (Wave B).
    /// `sheet_id` is the PACKAGE sheet id (un-remapped); `outline` is the
    /// opaque app payload. Empty for older packages.
    pub outlines: Vec<SavedSheetOutline>,
    /// Pane controls (Controls pane) carried by the package. WORKBOOK-scoped
    /// (no sheet remap needed) and complete: the package list is the
    /// publisher's whole pane-control set, in the deterministic (order, id)
    /// order publish wrote. `config`/`value` are opaque app-owned JSON;
    /// configs contain no inline code by design (D6) — custom-control /
    /// button scripts travel separately as consent-gated object_scripts.
    /// Empty for packages published before pane controls were carried.
    pub pane_controls: Vec<SavedPaneControl>,
    /// Generic custom objects carried by the package (distribution brick 4).
    /// Each carries its `kind`, id, name, the PACKAGE `sheet_id` (un-remapped;
    /// the Tauri layer maps it to a local sheet), and the opaque JSON payload.
    /// Built-in kinds (cellType) are materialized Rust-side on pull; unknown
    /// kinds are surfaced to frontend distributable-object providers.
    pub custom_objects: Vec<PulledCustomObject>,
    /// Slicers carried by the package (Wave A). `sheet_id` is the PACKAGE
    /// sheet id (un-remapped, like CF/DV); the Tauri layer maps it to the
    /// local sheet and drops slicers whose sheet wasn't pulled. Empty for
    /// packages published before slicers were carried.
    pub slicers: Vec<SavedSlicer>,
    /// Ribbon filters carried by the package (Wave A). WORKBOOK-scoped; each
    /// carries the publisher's connection uuid plus its stable package
    /// data-source id — the Tauri layer re-binds connection ids onto the
    /// freshly materialized package connections and skips filters whose data
    /// source is not embedded in the package. Empty for older packages.
    pub ribbon_filters: Vec<SavedRibbonFilter>,
    /// Saved pivot layouts carried by the package (Wave A). Workbook-scoped.
    /// Empty for older packages.
    pub pivot_layouts: Vec<SavedPivotLayout>,
    /// The publisher's document theme (Wave A). None for packages published
    /// before themes were carried. A workbook SINGLETON: the Tauri layer
    /// applies it only while the subscriber's theme is still the default.
    pub theme: Option<engine::theme::ThemeDefinition>,
    /// Per-extension persisted state carried by the package (Wave A). The
    /// Tauri layer merges ADDITIVELY (subscriber keys are never overwritten).
    /// Empty for older packages.
    pub extension_data: HashMap<String, serde_json::Value>,
    /// Trust outcome of the manifest-signature + TOFU check (S5 phase 2).
    /// FirstUse means this publisher key was just pinned; Verified means it
    /// matched a prior pin. The Tauri layer can surface this to the user.
    pub trust_status: TrustStatus,
    /// The publisher's display name asserted in the (now verified) manifest.
    pub publisher_name: String,
}

/// A generic custom object pulled from a package (distribution brick 4).
pub struct PulledCustomObject {
    pub kind: String,
    pub id: String,
    pub name: String,
    /// The PACKAGE sheet id (un-remapped) for per-sheet objects; None =
    /// workbook-scoped.
    pub package_sheet_id: Option<SheetId>,
    /// Opaque app-owned JSON payload (already integrity-verified).
    pub payload: serde_json::Value,
}

/// A data source pulled from a package, ready for connection resolution.
pub struct PulledDataSource {
    /// The data source definition from the version manifest.
    pub definition: PackageDataSource,
    /// Absolute path to the embedded model.json in the registry.
    pub model_path: PathBuf,
    /// Materialized calculated-table snapshots: (table name, absolute path
    /// to the Arrow IPC stream artifact). Empty when the package carries
    /// none. Integrity-verified with the rest of the artifacts.
    pub calculated_table_snapshots: Vec<(String, PathBuf)>,
    /// Absolute path to the publisher's writeback-column history baseline
    /// (models/{id}/writeback_history.json), when the package carries one.
    /// Opaque JSON (host-defined entry shape); integrity-verified like every
    /// artifact.
    pub writeback_history_path: Option<PathBuf>,
}

/// A sheet pulled from a package, ready to be inserted into a workbook.
pub struct PulledSheet {
    pub package_sheet_id: SheetId,
    pub name: String,
    pub sheet: Sheet,
}

/// Rename pulled sheets whose names collide with an already-taken workbook
/// sheet name (case-insensitive, Excel-style: "Name" → "Name (2)" → "Name (3)"),
/// keeping the subscription ledger's `local_name` in sync so refresh keeps
/// matching by `package_sheet_id` under the resolved local name.
///
/// - `taken` is the subscriber's current sheet-name list; every FINAL name of a
///   non-skipped pulled sheet is appended to it, so callers can thread one list
///   through multiple pulls (multi-subscription refresh) and within-package
///   duplicates also resolve.
/// - `skip` holds package sheet ids to leave untouched — refresh passes the
///   already-tracked sheets, which replace in place under their existing local
///   name and must not be renamed against their own workbook entry.
pub fn resolve_sheet_name_collisions(
    sheets: &mut [PulledSheet],
    subscribed: &mut [SubscribedSheet],
    taken: &mut Vec<String>,
    skip: &std::collections::HashSet<SheetId>,
) {
    let mut taken_lower: std::collections::HashSet<String> =
        taken.iter().map(|n| n.to_lowercase()).collect();

    for ps in sheets.iter_mut() {
        if skip.contains(&ps.package_sheet_id) {
            continue;
        }
        let mut resolved = ps.name.clone();
        if taken_lower.contains(&resolved.to_lowercase()) {
            let mut n = 2usize;
            loop {
                let candidate = format!("{} ({})", ps.name, n);
                if !taken_lower.contains(&candidate.to_lowercase()) {
                    resolved = candidate;
                    break;
                }
                n += 1;
            }
        }
        if resolved != ps.name {
            if let Some(entry) = subscribed
                .iter_mut()
                .find(|s| s.package_sheet_id == ps.package_sheet_id)
            {
                entry.local_name = resolved.clone();
            }
            ps.name = resolved.clone();
        }
        taken_lower.insert(resolved.to_lowercase());
        taken.push(resolved);
    }
}

/// Pull a package from the registry. Returns sheets and metadata for the
/// caller to integrate into the workbook.
///
/// `profile_dir` is the per-user profile directory holding the TOFU pin store
/// (`trusted-publishers.json`); the manifest-signature step pins/compares the
/// publisher key there (S5 phase 2).
pub fn pull(
    registry: &dyn RegistryTransport,
    request: &PullRequest,
    profile_dir: &Path,
) -> Result<PullResult, CalpError> {
    let resolved = registry.resolve_version(&request.package_name, &request.version_pin)?;
    let version_str = resolved.to_string();
    let pkg = request.package_name.as_str();
    let ver = version_str.as_str();

    // ORIGIN GATE (S5 phase 2): read the manifest bytes ONCE, verify the
    // manifest's Ed25519 signature over exactly those bytes, apply TOFU
    // publisher pinning, and parse the verified bytes into `ver_manifest`.
    // Everything downstream — the checksum map, min_app_version, and the object
    // inventory that drives materialization — is then sourced from the single
    // cryptographically-verified copy, so a hostile transport cannot present a
    // signed manifest for the crypto check and a different one for the payload.
    // A tampered manifest, a wrong/changed publisher key, or an unsigned
    // package all fail here.
    let (trust_status, ver_manifest) = crate::integrity::verify_and_load_manifest_via(
        registry,
        pkg,
        ver,
        profile_dir,
    )?;

    // COMPATIBILITY GATE: refuse a package that needs a newer Calcula than this
    // one (an honest "update the app" rather than a silent/partial failure).
    // min_app_version lives in the now-signature-verified manifest; the host app
    // version was recorded at startup via calp::set_host_app_version. Skipped
    // when the package declares no minimum or the host version is unknown.
    crate::compat::check_min_app_version(
        pkg,
        ver,
        &ver_manifest.min_app_version,
        crate::compat::host_app_version(),
    )?;

    // INTEGRITY GATE: verify every artifact the transport exposes for this
    // version against the manifest's published SHA-256 checksums BEFORE
    // materializing anything. This single chokepoint covers both subscribe and
    // refresh (pull_all_updates delegates here), and also vouches for artifacts
    // the Tauri layer reads lazily after pull (e.g. models/{ds}/model.json).
    crate::integrity::verify_version_artifacts_via(
        registry,
        pkg,
        ver,
        &ver_manifest,
    )?;

    // Read sheets
    let mut pulled_sheets = Vec::new();
    for pub_sheet in &ver_manifest.sheets {
        // Version-relative artifact prefix for this sheet (forward slashes).
        let sheet_prefix = format!("sheets/{}", pub_sheet.sheet_id);

        // Read cell data
        let mut cells: HashMap<(u32, u32), SavedCell> = {
            match registry.read_artifact(pkg, ver, &format!("{sheet_prefix}/data.json"))? {
                Some(bytes) => {
                    let sd: calcula_format::sheet_data::SheetData = serde_json::from_slice(&bytes)?;
                    calcula_format::sheet_data::sheet_data_to_cells(&sd)
                }
                None => HashMap::new(),
            }
        };

        // Apply per-cell style indices. data.json serializes every cell's
        // style_index as 0, so the cell->style association rides in a companion
        // cell_styles.json (A1 -> style index). Without this a subscriber's
        // sheet would lose ALL per-cell styling (colors/fonts/borders). Absent
        // in pre-cell_styles packages -> cells keep their default style.
        if let Some(bytes) =
            registry.read_artifact(pkg, ver, &format!("{sheet_prefix}/cell_styles.json"))?
        {
            let sheet_styles: calcula_format::sheet_styles::SheetStyles =
                serde_json::from_slice(&bytes)?;
            calcula_format::sheet_styles::apply_sheet_styles(&mut cells, &sheet_styles);
        }

        // Read styles
        let styles: Vec<engine::style::CellStyle> = {
            match registry.read_artifact(pkg, ver, &format!("{sheet_prefix}/styles.json"))? {
                Some(bytes) => serde_json::from_slice(&bytes)?,
                None => vec![engine::style::CellStyle::new()],
            }
        };

        // Read layout
        let (column_widths, row_heights) = {
            match registry.read_artifact(pkg, ver, &format!("{sheet_prefix}/layout.json"))? {
                Some(bytes) => {
                    let layout: calcula_format::sheet_layout::SheetLayout =
                        serde_json::from_slice(&bytes)?;
                    layout.to_dimensions()
                }
                None => (HashMap::new(), HashMap::new()),
            }
        };

        // Read presentation metadata (D9). Absent in pre-D9 packages -> the
        // (correct) per-field defaults via PublishedSheetMetadata::default().
        let metadata: crate::manifest::PublishedSheetMetadata = {
            match registry.read_artifact(pkg, ver, &format!("{sheet_prefix}/metadata.json"))? {
                Some(bytes) => serde_json::from_slice(&bytes)?,
                None => crate::manifest::PublishedSheetMetadata::default(),
            }
        };

        // Build Sheet with fresh local SheetId, restoring the carried metadata
        // (merged regions, freeze panes, hidden rows/cols, tab color, visibility,
        // notes, hyperlinks, page setup, gridlines) instead of dropping it.
        let local_id = SheetId::from_bytes(identity::generate_uuid_v7());
        let sheet = Sheet {
            id: local_id,
            name: pub_sheet.name.clone(),
            cells,
            column_widths,
            row_heights,
            styles,
            merged_regions: metadata.merged_regions,
            freeze_row: metadata.freeze_row,
            freeze_col: metadata.freeze_col,
            hidden_rows: metadata.hidden_rows,
            hidden_cols: metadata.hidden_cols,
            tab_color: metadata.tab_color,
            visibility: metadata.visibility,
            notes: metadata.notes,
            hyperlinks: metadata.hyperlinks,
            page_setup: metadata.page_setup,
            show_gridlines: metadata.show_gridlines,
        };

        pulled_sheets.push(PulledSheet {
            package_sheet_id: pub_sheet.sheet_id,
            name: pub_sheet.name.clone(),
            sheet,
        });
    }

    // Read charts (carried for subscriber in-app fidelity). Each chart names the
    // sheet it lives on by the PACKAGE sheet id; remap to the new LOCAL sheet id
    // (pull assigns fresh ids) so it lands on the right sheet. A chart whose
    // sheet wasn't pulled is dropped. Absent in packages published before charts.
    let pulled_charts: Vec<SavedChart> = {
        match registry.read_artifact(pkg, ver, "charts.json")? {
            Some(bytes) => {
                let package_charts: Vec<SavedChart> = serde_json::from_slice(&bytes)?;
                let id_map: HashMap<SheetId, SheetId> = pulled_sheets
                    .iter()
                    .map(|p| (p.package_sheet_id, p.sheet.id))
                    .collect();
                package_charts
                    .into_iter()
                    .filter_map(|mut chart| {
                        id_map.get(&chart.sheet_id).map(|&local| {
                            chart.sheet_id = local;
                            chart
                        })
                    })
                    .collect()
            }
            None => Vec::new(),
        }
    };

    // Read sparklines (C2a) — same package->local sheet-id remap as charts; an
    // entry whose sheet wasn't pulled is dropped. Absent in older packages.
    let pulled_sparklines: Vec<SavedSparkline> = {
        match registry.read_artifact(pkg, ver, "sparklines.json")? {
            Some(bytes) => {
                let package_sparklines: Vec<SavedSparkline> = serde_json::from_slice(&bytes)?;
                let id_map: HashMap<SheetId, SheetId> = pulled_sheets
                    .iter()
                    .map(|p| (p.package_sheet_id, p.sheet.id))
                    .collect();
                package_sparklines
                    .into_iter()
                    .filter_map(|mut sp| {
                        id_map.get(&sp.sheet_id).map(|&local| {
                            sp.sheet_id = local;
                            sp
                        })
                    })
                    .collect()
            }
            None => Vec::new(),
        }
    };

    // Read conditional formats + data validations (per-sheet, opaque payloads).
    // Sheet ids are left as PACKAGE ids here; the Tauri pull remaps them to local
    // sheet indices (alongside named ranges). Absent in older packages.
    let pulled_conditional_formats: Vec<SavedSheetConditionalFormats> =
        match registry.read_artifact(pkg, ver, "conditional_formats.json")? {
            Some(bytes) => serde_json::from_slice(&bytes)?,
            None => Vec::new(),
        };
    let pulled_data_validations: Vec<SavedSheetDataValidations> =
        match registry.read_artifact(pkg, ver, "data_validations.json")? {
            Some(bytes) => serde_json::from_slice(&bytes)?,
            None => Vec::new(),
        };
    let pulled_controls: Vec<SavedSheetControls> =
        match registry.read_artifact(pkg, ver, "controls.json")? {
            Some(bytes) => serde_json::from_slice(&bytes)?,
            None => Vec::new(),
        };

    // Read Wave B artifacts (comments, scenarios, outlines) — per-sheet opaque
    // payloads with PACKAGE sheet ids, exactly like CF/DV. All optional:
    // comments.json exists only when the publisher opted in, and older
    // packages lack all three.
    let pulled_comments: Vec<SavedSheetComments> =
        match registry.read_artifact(pkg, ver, "comments.json")? {
            Some(bytes) => serde_json::from_slice(&bytes)?,
            None => Vec::new(),
        };
    let pulled_scenarios: Vec<SavedSheetScenarios> =
        match registry.read_artifact(pkg, ver, "scenarios.json")? {
            Some(bytes) => serde_json::from_slice(&bytes)?,
            None => Vec::new(),
        };
    let pulled_outlines: Vec<SavedSheetOutline> =
        match registry.read_artifact(pkg, ver, "outlines.json")? {
            Some(bytes) => serde_json::from_slice(&bytes)?,
            None => Vec::new(),
        };

    // Read pane controls (workbook-scoped, like pivot definitions — no
    // per-sheet filtering or sheet-id remap). The artifact carries the
    // publisher's COMPLETE pane-control set; the caller materializes it as a
    // whole (the app layer decides collision handling against the
    // subscriber's own controls). Absent in older packages -> empty.
    let pulled_pane_controls: Vec<SavedPaneControl> =
        match registry.read_artifact(pkg, ver, "pane_controls.json")? {
            Some(bytes) => serde_json::from_slice(&bytes)?,
            None => Vec::new(),
        };

    // Read Wave A artifacts (slicers, ribbon filters, pivot layouts, theme,
    // extension data). All optional — packages published before Wave A simply
    // lack the artifacts, mirroring how conditional_formats.json absence is
    // handled. Sheet ids on slicers stay PACKAGE ids (the Tauri layer remaps).
    let pulled_slicers: Vec<SavedSlicer> =
        match registry.read_artifact(pkg, ver, "slicers.json")? {
            Some(bytes) => serde_json::from_slice(&bytes)?,
            None => Vec::new(),
        };
    let pulled_ribbon_filters: Vec<SavedRibbonFilter> =
        match registry.read_artifact(pkg, ver, "ribbon_filters.json")? {
            Some(bytes) => serde_json::from_slice(&bytes)?,
            None => Vec::new(),
        };
    let pulled_pivot_layouts: Vec<SavedPivotLayout> =
        match registry.read_artifact(pkg, ver, "pivot_layouts.json")? {
            Some(bytes) => serde_json::from_slice(&bytes)?,
            None => Vec::new(),
        };
    let pulled_theme: Option<engine::theme::ThemeDefinition> =
        match registry.read_artifact(pkg, ver, "theme.json")? {
            Some(bytes) => Some(serde_json::from_slice(&bytes)?),
            None => None,
        };
    let pulled_extension_data: HashMap<String, serde_json::Value> =
        match registry.read_artifact(pkg, ver, "extension_data.json")? {
            Some(bytes) => serde_json::from_slice(&bytes)?,
            None => HashMap::new(),
        };

    // Read tables
    let mut pulled_tables = Vec::new();
    for table_id in &ver_manifest.tables {
        if let Some(bytes) =
            registry.read_artifact(pkg, ver, &format!("tables/{}.json", table_id))?
        {
            let table: SavedTable = serde_json::from_slice(&bytes)?;
            pulled_tables.push(table);
        }
    }

    // Read object scripts
    let mut pulled_scripts: Vec<SavedObjectScript> = Vec::new();
    for pub_script in &ver_manifest.object_scripts {
        if let Some(bytes) =
            registry.read_artifact(pkg, ver, &format!("object_scripts/{}.json", pub_script.id))?
        {
            let def: calcula_format::features::object_scripts::ObjectScriptDef =
                serde_json::from_slice(&bytes)?;
            let mut script = SavedObjectScript::from(&def);
            // SECURITY: Force all distributed scripts to restricted mode.
            // Subscribers control their own access level.
            script.access_level = persistence::ScriptAccessLevel::Restricted;
            // Mark provenance so the consent gate fires before mounting and
            // the script cannot masquerade as locally-authored.
            script.provenance = persistence::ScriptProvenance::Distributed;
            script.package_name = Some(request.package_name.clone());
            // R19 SECURITY: the declared-capability ceiling is server-
            // authoritative — it comes from the package MANIFEST, never from
            // the (tamperable) script source. A tampered source can therefore
            // never widen a distributed script's ceiling.
            script.declared_capabilities = pub_script.capabilities.clone();
            pulled_scripts.push(script);
        }
    }

    // Read standalone module scripts (C8). Behind the same integrity gate as
    // everything else (the UnlistedArtifact check already rejects any
    // modules/*.json the publisher did not list). These are materialized as-is
    // and never auto-executed — no provenance/access-level stamping.
    let mut pulled_modules: Vec<SavedScript> = Vec::new();
    for pub_module in &ver_manifest.module_scripts {
        if let Some(bytes) =
            registry.read_artifact(pkg, ver, &format!("modules/{}.json", pub_module.id))?
        {
            let def: calcula_format::features::scripts::ScriptDef =
                serde_json::from_slice(&bytes)?;
            let mut s = SavedScript::from(&def);
            // Stamp distribution provenance so refresh + dedupe can tell this
            // module belongs to THIS package (vs a subscriber-authored local one).
            s.source_package = Some(request.package_name.clone());
            pulled_modules.push(s);
        }
    }

    // Read standalone notebooks (C8). Same integrity gate. Execution metadata is
    // stripped HERE, defensively, on the bytes actually delivered + signed — not
    // just at publish. The signature only proves the publisher signed these
    // bytes; it does NOT prove the bytes are benign. A malicious/compromised
    // publisher could hand-write notebooks/{id}.json with forged last_output /
    // last_error / execution_index, sign the manifest, and the subscriber's UI
    // would render the fabricated output as if it were their own genuine run.
    // Stripping at pull (mirroring how object scripts are force-normalized to
    // Restricted/Distributed regardless of on-disk source) makes the run-clean
    // guarantee hold against the delivered content, upholding the transparency
    // rule ("the user must not be misled about what they ran").
    let mut pulled_notebooks: Vec<SavedNotebook> = Vec::new();
    for pub_notebook in &ver_manifest.notebooks {
        if let Some(bytes) =
            registry.read_artifact(pkg, ver, &format!("notebooks/{}.json", pub_notebook.id))?
        {
            let def: calcula_format::features::notebooks::NotebookDef =
                serde_json::from_slice(&bytes)?;
            let mut nb = SavedNotebook::from(&def);
            nb.source_package = Some(request.package_name.clone());
            for cell in &mut nb.cells {
                cell.last_output = Vec::new();
                cell.last_error = None;
                cell.cells_modified = 0;
                cell.duration_ms = 0;
                cell.execution_index = None;
            }
            pulled_notebooks.push(nb);
        }
    }

    // Build subscription metadata
    let subscribed_sheets: Vec<SubscribedSheet> = pulled_sheets.iter().map(|ps| {
        SubscribedSheet {
            package_sheet_id: ps.package_sheet_id,
            local_sheet_id: ps.sheet.id,
            local_name: ps.name.clone(),
            extra: HashMap::new(),
        }
    }).collect();

    let subscription = Subscription {
        package_name: request.package_name.clone(),
        registry_url: request.registry_url.clone(),
        version_pin: request.version_pin.to_string(),
        resolved_version: version_str.clone(),
        resolved_at: request.now.clone(),
        sheets: subscribed_sheets,
        channel: String::new(), // default/production channel
        data_source_configs: Vec::new(),
        // Filled by the app layer after materialization (it knows what actually
        // landed vs was skipped on collision).
        objects: Vec::new(),
        extra: HashMap::new(),
    };

    // Read pivot definitions. They are not enumerated by id in the manifest's
    // typed fields, so discover them from the SIGNED manifest's checksum keys —
    // every pivot_definitions/*.json EXCEPT the BI metadata sidecar. (The
    // previous transport dir-walk returned NOTHING once publish committed
    // artifacts into the content-addressed blob store, silently dropping every
    // pivot from real pulls; the checksum map is the authoritative artifact
    // set and survives dedup.)
    let mut pulled_pivot_defs: Vec<persistence::SavedPivotDefinition> = Vec::new();
    {
        let rel_paths: Vec<String> = ver_manifest.artifact_checksums.keys().cloned().collect();
        for rel in &rel_paths {
            if rel.starts_with("pivot_definitions/")
                && rel.ends_with(".json")
                && rel != "pivot_definitions/bi_metadata.json"
            {
                if let Some(bytes) = registry.read_artifact(pkg, ver, rel)? {
                    if let Ok(def) =
                        serde_json::from_slice::<persistence::SavedPivotDefinition>(&bytes)
                    {
                        pulled_pivot_defs.push(def);
                    }
                }
            }
        }
    }

    // Read BI pivot metadata (if present)
    let bi_pivot_metadata: Vec<serde_json::Value> = {
        match registry.read_artifact(pkg, ver, "pivot_definitions/bi_metadata.json")? {
            Some(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
            None => Vec::new(),
        }
    };

    // Resolve data source model paths. The Tauri layer reads embedded BI model
    // JSON lazily by path after pull; for the local transport we hand it the
    // absolute on-disk path (those bytes were already integrity-verified above).
    // A non-local transport returns None here — it would instead surface bytes
    // via read_artifact (a later HTTP effort, out of scope).
    let pulled_data_sources: Vec<PulledDataSource> = ver_manifest
        .data_sources
        .iter()
        .map(|ds| {
            let model_path = registry
                .local_artifact_path(pkg, ver, &ds.model_path)?
                .unwrap_or_default();
            let calculated_table_snapshots = ds
                .calculated_table_snapshots
                .iter()
                .map(|snap| {
                    Ok((
                        snap.table.clone(),
                        registry
                            .local_artifact_path(pkg, ver, &snap.path)?
                            .unwrap_or_default(),
                    ))
                })
                .collect::<Result<Vec<_>, CalpError>>()?;
            // Writeback-column baseline is optional: probe by manifest-derived
            // path; absent (or non-local transport) resolves to None.
            let writeback_history_path = registry
                .local_artifact_path(
                    pkg,
                    ver,
                    &format!("models/{}/writeback_history.json", ds.id),
                )?
                .filter(|p| p.exists());
            Ok(PulledDataSource {
                definition: ds.clone(),
                model_path,
                calculated_table_snapshots,
                writeback_history_path,
            })
        })
        .collect::<Result<Vec<_>, CalpError>>()?;

    // Generic custom objects (brick 4): read each declared payload via the
    // transport. The artifacts were integrity-verified above (their SHA-256s
    // are in the signed manifest), so a tampered payload has already failed the
    // pull. A payload that fails to parse as JSON is skipped (defensive).
    let mut pulled_custom_objects: Vec<PulledCustomObject> = Vec::new();
    for co in &ver_manifest.custom_objects {
        if let Some(bytes) = registry.read_artifact(pkg, ver, &co.payload_path)? {
            if let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                pulled_custom_objects.push(PulledCustomObject {
                    kind: co.kind.clone(),
                    id: co.id.clone(),
                    name: co.name.clone(),
                    package_sheet_id: co.sheet_id,
                    payload,
                });
            }
        }
    }

    Ok(PullResult {
        package_name: request.package_name.clone(),
        resolved_version: resolved,
        sheets: pulled_sheets,
        tables: pulled_tables,
        subscription,
        object_scripts: pulled_scripts,
        module_scripts: pulled_modules,
        notebooks: pulled_notebooks,
        data_sources: pulled_data_sources,
        pivot_definitions: pulled_pivot_defs,
        bi_pivot_metadata,
        charts: pulled_charts,
        sparklines: pulled_sparklines,
        named_ranges: ver_manifest.named_ranges.clone(),
        conditional_formats: pulled_conditional_formats,
        data_validations: pulled_data_validations,
        controls: pulled_controls,
        comments: pulled_comments,
        scenarios: pulled_scenarios,
        outlines: pulled_outlines,
        pane_controls: pulled_pane_controls,
        custom_objects: pulled_custom_objects,
        slicers: pulled_slicers,
        ribbon_filters: pulled_ribbon_filters,
        pivot_layouts: pulled_pivot_layouts,
        theme: pulled_theme,
        extension_data: pulled_extension_data,
        trust_status,
        publisher_name: ver_manifest.publisher_name.clone(),
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod sheet_name_collision_tests {
    use super::*;

    fn pulled(name: &str) -> PulledSheet {
        PulledSheet {
            package_sheet_id: SheetId::from_bytes(identity::generate_uuid_v7()),
            name: name.to_string(),
            sheet: Sheet::new(name.to_string()),
        }
    }

    fn subscribed_for(sheets: &[PulledSheet]) -> Vec<SubscribedSheet> {
        sheets
            .iter()
            .map(|ps| SubscribedSheet {
                package_sheet_id: ps.package_sheet_id,
                local_sheet_id: ps.sheet.id,
                local_name: ps.name.clone(),
                extra: HashMap::new(),
            })
            .collect()
    }

    #[test]
    fn colliding_name_gets_excel_style_suffix() {
        let mut sheets = vec![pulled("Sheet1")];
        let mut subs = subscribed_for(&sheets);
        let mut taken = vec!["Sheet1".to_string()];
        resolve_sheet_name_collisions(
            &mut sheets,
            &mut subs,
            &mut taken,
            &std::collections::HashSet::new(),
        );
        assert_eq!(sheets[0].name, "Sheet1 (2)");
        assert_eq!(subs[0].local_name, "Sheet1 (2)");
        assert!(taken.contains(&"Sheet1 (2)".to_string()));
    }

    #[test]
    fn collision_check_is_case_insensitive_and_counts_up() {
        let mut sheets = vec![pulled("Report")];
        let mut subs = subscribed_for(&sheets);
        let mut taken = vec!["report".to_string(), "Report (2)".to_string()];
        resolve_sheet_name_collisions(
            &mut sheets,
            &mut subs,
            &mut taken,
            &std::collections::HashSet::new(),
        );
        assert_eq!(sheets[0].name, "Report (3)");
    }

    #[test]
    fn non_colliding_names_are_untouched() {
        let mut sheets = vec![pulled("Sales")];
        let mut subs = subscribed_for(&sheets);
        let mut taken = vec!["Sheet1".to_string()];
        resolve_sheet_name_collisions(
            &mut sheets,
            &mut subs,
            &mut taken,
            &std::collections::HashSet::new(),
        );
        assert_eq!(sheets[0].name, "Sales");
        assert_eq!(subs[0].local_name, "Sales");
    }

    #[test]
    fn duplicates_within_one_pull_also_resolve() {
        let mut sheets = vec![pulled("Data"), pulled("Data")];
        let mut subs = subscribed_for(&sheets);
        let mut taken = Vec::new();
        resolve_sheet_name_collisions(
            &mut sheets,
            &mut subs,
            &mut taken,
            &std::collections::HashSet::new(),
        );
        assert_eq!(sheets[0].name, "Data");
        assert_eq!(sheets[1].name, "Data (2)");
    }

    #[test]
    fn skipped_tracked_sheets_are_left_alone() {
        let mut sheets = vec![pulled("Sheet1"), pulled("Sheet1")];
        let mut subs = subscribed_for(&sheets);
        let mut taken = vec!["Sheet1".to_string()];
        let skip: std::collections::HashSet<SheetId> =
            [sheets[0].package_sheet_id].into_iter().collect();
        resolve_sheet_name_collisions(&mut sheets, &mut subs, &mut taken, &skip);
        // Tracked sheet keeps its package name (it replaces in place);
        // the genuinely new sheet renames around the existing workbook name.
        assert_eq!(sheets[0].name, "Sheet1");
        assert_eq!(sheets[1].name, "Sheet1 (2)");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;
    use crate::publish::{self, PublishRequest};
    use crate::registry::LocalRegistry;

    fn make_test_workbook() -> persistence::Workbook {
        let mut sheet1 = Sheet::new("Dashboard".to_string());
        let cell = engine::cell::Cell::new_number(42.0);
        sheet1.cells.insert((0, 0), SavedCell::from_cell(&cell));

        let mut sheet2 = Sheet::new("Data".to_string());
        let cell2 = engine::cell::Cell::new_text("hello".to_string());
        sheet2.cells.insert((0, 0), SavedCell::from_cell(&cell2));

        let mut wb = persistence::Workbook::default();
        wb.sheets = vec![sheet1, sheet2];
        wb
    }

    fn publish_test_package(reg: &LocalRegistry, prof: &std::path::Path) -> persistence::Workbook {
        let wb = make_test_workbook();
        let request = PublishRequest {
            model_writebacks: None,
            workbook: &wb,
            package_name: "test-pkg".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            sheet_indices: vec![0, 1],
            now: "2026-05-18T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments: false,
            min_app_version: String::new(),
        };
        publish::publish(reg, &request, prof).unwrap();
        wb
    }

    #[test]
    fn pull_materializes_sheets() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        publish_test_package(&reg, prof.path());

        let request = PullRequest {
            package_name: "test-pkg".to_string(),
            registry_url: format!("file://{}", dir.path().display()),
            version_pin: VersionPin::Exact(SemVer::new(1, 0, 0)),
            now: "2026-05-18T01:00:00Z".to_string(),
        };

        let result = pull(&reg, &request, prof.path()).unwrap();
        assert_eq!(result.sheets.len(), 2);
        assert_eq!(result.sheets[0].name, "Dashboard");
        assert_eq!(result.sheets[1].name, "Data");
        assert_eq!(result.resolved_version, SemVer::new(1, 0, 0));
        // First pull pins the publisher key (trust-on-first-use).
        assert_eq!(result.trust_status, TrustStatus::FirstUse);
        assert!(!result.publisher_name.is_empty());

        // Verify cell data was materialized
        let dashboard = &result.sheets[0].sheet;
        let cell = dashboard.cells.get(&(0, 0)).unwrap();
        assert!(matches!(cell.value, persistence::SavedCellValue::Number(n) if n == 42.0));
    }

    #[test]
    fn custom_objects_round_trip_through_publish_and_pull() {
        // Distribution brick 4: a generic custom object (opaque JSON payload,
        // per-sheet) survives publish -> pull with its kind/id/name/payload and
        // its package sheet id intact (so the app layer can remap it).
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();

        let wb = make_test_workbook();
        let sheet0_id = wb.sheets[0].id;
        let request = PublishRequest {
            model_writebacks: None,
            workbook: &wb,
            package_name: "co-pkg".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            sheet_indices: vec![0, 1],
            now: "2026-05-18T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: vec![crate::publish::PublishCustomObject {
                kind: "cellType".to_string(),
                id: "cellType-sheet0".to_string(),
                name: "Cell Types".to_string(),
                sheet_id: Some(sheet0_id),
                payload: serde_json::json!([
                    { "row": 1, "col": 0, "typeId": "calcula.checkbox", "params": {} }
                ]),
            }],
            include_comments: false,
            min_app_version: String::new(),
        };
        publish::publish(&reg, &request, prof.path()).unwrap();

        let pull_req = PullRequest {
            package_name: "co-pkg".to_string(),
            registry_url: format!("file://{}", dir.path().display()),
            version_pin: VersionPin::Exact(SemVer::new(1, 0, 0)),
            now: "2026-05-18T01:00:00Z".to_string(),
        };
        let result = pull(&reg, &pull_req, prof.path()).unwrap();

        assert_eq!(result.custom_objects.len(), 1);
        let co = &result.custom_objects[0];
        assert_eq!(co.kind, "cellType");
        assert_eq!(co.id, "cellType-sheet0");
        assert_eq!(co.name, "Cell Types");
        assert_eq!(co.package_sheet_id, Some(sheet0_id));
        // Opaque payload round-trips byte-for-byte through the signed artifact.
        assert_eq!(
            co.payload,
            serde_json::json!([
                { "row": 1, "col": 0, "typeId": "calcula.checkbox", "params": {} }
            ])
        );
    }

    #[test]
    fn pull_restores_per_cell_style_indices() {
        // A cell carrying a non-default style index. data.json serializes
        // style_index 0, so the cell->style association must survive
        // publish->pull via the companion cell_styles.json.
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();

        let mut sheet = Sheet::new("Styled".to_string());
        let mut sc = SavedCell::from_cell(&engine::cell::Cell::new_text("x".to_string()));
        sc.style_index = 3;
        sheet.cells.insert((1, 2), sc);
        let mut wb = persistence::Workbook::default();
        wb.sheets = vec![sheet];

        let publish_req = PublishRequest {
            model_writebacks: None,
            workbook: &wb,
            package_name: "styled-pkg".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            sheet_indices: vec![0],
            now: "2026-05-18T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments: false,
            min_app_version: String::new(),
        };
        publish::publish(&reg, &publish_req, prof.path()).unwrap();

        let pull_req = PullRequest {
            package_name: "styled-pkg".to_string(),
            registry_url: format!("file://{}", dir.path().display()),
            version_pin: VersionPin::Exact(SemVer::new(1, 0, 0)),
            now: "2026-05-18T01:00:00Z".to_string(),
        };
        let result = pull(&reg, &pull_req, prof.path()).unwrap();

        // The pulled cell carries the published style index, not the
        // data.json-serialized 0.
        let styled = &result.sheets[0].sheet;
        assert_eq!(styled.cells.get(&(1, 2)).map(|c| c.style_index), Some(3));
    }

    #[test]
    fn pull_carries_controls() {
        // Controls (buttons/checkboxes with onSelect wiring) travel as a
        // per-sheet opaque payload keyed by the PACKAGE sheet id, like CF/DV.
        // A control on an unpublished sheet must not leak into the package.
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();

        let mut wb = make_test_workbook();
        let published_sheet_id = wb.sheets[0].id;
        let unpublished_sheet_id = wb.sheets[1].id;
        wb.controls = vec![
            persistence::SavedSheetControls {
                sheet_id: published_sheet_id,
                controls: serde_json::json!([
                    { "row": 4, "col": 1, "controlType": "button",
                      "properties": { "onSelect": { "valueType": "static", "value": "script-1" } } }
                ]),
            },
            persistence::SavedSheetControls {
                sheet_id: unpublished_sheet_id,
                controls: serde_json::json!([
                    { "row": 0, "col": 0, "controlType": "checkbox", "properties": {} }
                ]),
            },
        ];

        let publish_req = PublishRequest {
            model_writebacks: None,
            workbook: &wb,
            package_name: "controls-pkg".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            sheet_indices: vec![0], // only the first sheet
            now: "2026-07-02T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments: false,
            min_app_version: String::new(),
        };
        let pub_result = publish::publish(&reg, &publish_req, prof.path()).unwrap();
        assert_eq!(pub_result.control_sheets_published, 1);

        let pull_req = PullRequest {
            package_name: "controls-pkg".to_string(),
            registry_url: format!("file://{}", dir.path().display()),
            version_pin: VersionPin::Exact(SemVer::new(1, 0, 0)),
            now: "2026-07-02T01:00:00Z".to_string(),
        };
        let result = pull(&reg, &pull_req, prof.path()).unwrap();

        assert_eq!(result.controls.len(), 1, "only the published sheet's controls travel");
        assert_eq!(result.controls[0].sheet_id, published_sheet_id,
            "controls carry the un-remapped PACKAGE sheet id, like CF/DV");
        let entries = result.controls[0].controls.as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["controlType"], "button");
        assert_eq!(entries[0]["properties"]["onSelect"]["value"], "script-1");
    }

    /// Two pane controls for the pane-control tests: a slider carrying a
    /// published value and a custom scripted control carrying declared
    /// properties (its script would travel separately as an object script —
    /// configs hold no inline code by design, D6).
    fn make_test_pane_controls() -> Vec<persistence::SavedPaneControl> {
        vec![
            persistence::SavedPaneControl {
                id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
                name: "Rate".to_string(),
                control_type: "slider".to_string(),
                config: serde_json::json!({
                    "type": "slider", "min": 0.0, "max": 100.0, "step": 1.0, "showValue": true
                }),
                value: serde_json::json!({ "kind": "number", "value": 42.0 }),
                order: 3,
            },
            persistence::SavedPaneControl {
                id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
                name: "Gauge".to_string(),
                control_type: "custom".to_string(),
                config: serde_json::json!({
                    "type": "custom", "properties": { "color": "#ff0000", "label": "Fuel" }
                }),
                value: serde_json::Value::Null,
                order: 1,
            },
        ]
    }

    #[test]
    fn pull_carries_pane_controls_with_config_value_and_order_intact() {
        // Pane controls are WORKBOOK-scoped: all of them travel regardless of
        // which sheets are published, and pull hands back the complete set in
        // the deterministic (order, id) order publish wrote.
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();

        let mut wb = make_test_workbook();
        wb.pane_controls = make_test_pane_controls();
        let slider_id = wb.pane_controls[0].id;
        let custom_id = wb.pane_controls[1].id;

        let publish_req = PublishRequest {
            model_writebacks: None,
            workbook: &wb,
            package_name: "pane-pkg".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            sheet_indices: vec![0], // partial sheet selection — controls still all travel
            now: "2026-07-03T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments: false,
            min_app_version: String::new(),
        };
        let pub_result = publish::publish(&reg, &publish_req, prof.path()).unwrap();
        assert_eq!(pub_result.pane_controls_published, 2);

        // The artifact is covered by the signed manifest's integrity checksums.
        let ver = reg.get_version_manifest("pane-pkg", "1.0.0").unwrap();
        assert!(ver.artifact_checksums.contains_key("pane_controls.json"));

        let pull_req = PullRequest {
            package_name: "pane-pkg".to_string(),
            registry_url: format!("file://{}", dir.path().display()),
            version_pin: VersionPin::Exact(SemVer::new(1, 0, 0)),
            now: "2026-07-03T01:00:00Z".to_string(),
        };
        let result = pull(&reg, &pull_req, prof.path()).unwrap();

        assert_eq!(result.pane_controls.len(), 2, "both pane controls travel");

        // Deterministic order: sorted by (order, id) — custom (order 1) first.
        let custom = &result.pane_controls[0];
        let slider = &result.pane_controls[1];
        assert_eq!(custom.id, custom_id);
        assert_eq!(slider.id, slider_id);

        // Custom control: config properties intact, value-less (null).
        assert_eq!(custom.name, "Gauge");
        assert_eq!(custom.control_type, "custom");
        assert_eq!(custom.order, 1);
        assert_eq!(custom.config["type"], "custom");
        assert_eq!(custom.config["properties"]["color"], "#ff0000");
        assert_eq!(custom.config["properties"]["label"], "Fuel");
        assert!(custom.value.is_null(), "value-less control stays null");

        // Slider: config AND current published value intact.
        assert_eq!(slider.name, "Rate");
        assert_eq!(slider.control_type, "slider");
        assert_eq!(slider.order, 3);
        assert_eq!(slider.config["type"], "slider");
        assert_eq!(slider.config["max"], 100.0);
        assert_eq!(slider.config["showValue"], true);
        assert_eq!(slider.value["kind"], "number");
        assert_eq!(slider.value["value"], 42.0);
    }

    #[test]
    fn pane_controls_artifact_is_byte_stable_across_publishes() {
        // Determinism: the SAME control set handed to publish in a DIFFERENT
        // Vec order must produce byte-identical pane_controls.json (publish
        // sorts by order, then id) — stable checksums, blob dedup intact.
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();

        let controls = make_test_pane_controls();

        let wb = make_test_workbook();
        for (version, reversed) in [(SemVer::new(1, 0, 0), false), (SemVer::new(1, 0, 1), true)] {
            let mut wb = wb.clone();
            wb.pane_controls = if reversed {
                controls.iter().rev().cloned().collect()
            } else {
                controls.clone()
            };
            let publish_req = PublishRequest {
            model_writebacks: None,
                workbook: &wb,
                package_name: "pane-det".to_string(),
                version,
                kind: "report".to_string(),
                sheet_indices: vec![0, 1],
                now: "2026-07-03T00:00:00Z".to_string(),
                published_by: "tester".to_string(),
                writeback_regions: None,
                object_scripts: None,
                module_scripts: None,
                notebooks: None,
                data_sources: Vec::new(),
                excluded_regions: Vec::new(),
                custom_objects: Vec::new(),
                include_comments: false,
                min_app_version: String::new(),
            };
            publish::publish(&reg, &publish_req, prof.path()).unwrap();
        }

        let bytes_v1 = reg
            .read_artifact("pane-det", "1.0.0", "pane_controls.json")
            .unwrap()
            .expect("pane_controls.json in v1.0.0");
        let bytes_v2 = reg
            .read_artifact("pane-det", "1.0.1", "pane_controls.json")
            .unwrap()
            .expect("pane_controls.json in v1.0.1");
        assert_eq!(bytes_v1, bytes_v2, "artifact bytes must be input-order independent");

        // And the signed checksums agree (one shared blob after dedup).
        let v1 = reg.get_version_manifest("pane-det", "1.0.0").unwrap();
        let v2 = reg.get_version_manifest("pane-det", "1.0.1").unwrap();
        assert_eq!(
            v1.artifact_checksums.get("pane_controls.json"),
            v2.artifact_checksums.get("pane_controls.json"),
        );
    }

    // --- Wave A: slicers / ribbon filters / pivot layouts / theme / extension data ---

    /// A fully-populated SavedSlicer anchored to `sheet_id`.
    fn make_test_slicer(name: &str, sheet_id: identity::SheetId) -> persistence::SavedSlicer {
        persistence::SavedSlicer {
            id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            name: name.to_string(),
            header_text: Some("Region".to_string()),
            sheet_id,
            x: 100.0,
            y: 50.0,
            width: 180.0,
            height: 220.0,
            source_type: persistence::SavedSlicerSourceType::Pivot,
            cache_source_id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            field_name: "Region".to_string(),
            selected_items: Some(vec!["North".to_string(), "South".to_string()]),
            show_header: true,
            columns: 2,
            style_preset: "SlicerStyleLight2".to_string(),
            selection_mode: persistence::SavedSlicerSelectionMode::Multi,
            hide_no_data: false,
            indicate_no_data: true,
            sort_no_data_last: true,
            force_selection: false,
            show_select_all: true,
            arrangement: persistence::SavedSlicerArrangement::Grid,
            rows: 3,
            item_gap: 4.0,
            autogrid: true,
            item_padding: 2.0,
            button_radius: 2.0,
            computed_properties: Vec::new(),
            connected_sources: vec![persistence::SavedSlicerConnection {
                source_type: persistence::SavedSlicerSourceType::Pivot,
                source_id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            }],
        }
    }

    #[test]
    fn pull_carries_slicers_filtered_to_published_sheets() {
        // Wave A: slicers are sheet-anchored — only slicers on published
        // sheets travel, keyed by the un-remapped PACKAGE sheet id (CF/DV
        // semantics; the Tauri layer remaps to the local sheet).
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();

        let mut wb = make_test_workbook();
        let published_sheet_id = wb.sheets[0].id;
        let unpublished_sheet_id = wb.sheets[1].id;
        let published_slicer = make_test_slicer("ByRegion", published_sheet_id);
        let published_slicer_id = published_slicer.id;
        let connected_pivot_id = published_slicer.connected_sources[0].source_id;
        wb.slicers = vec![
            published_slicer,
            make_test_slicer("Hidden", unpublished_sheet_id),
        ];

        let publish_req = PublishRequest {
            model_writebacks: None,
            workbook: &wb,
            package_name: "slicer-pkg".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            sheet_indices: vec![0], // only the first sheet ships
            now: "2026-07-12T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments: false,
            min_app_version: String::new(),
        };
        let pub_result = publish::publish(&reg, &publish_req, prof.path()).unwrap();
        assert_eq!(pub_result.slicers_published, 1);

        // The artifact is covered by the signed manifest's checksums.
        let ver = reg.get_version_manifest("slicer-pkg", "1.0.0").unwrap();
        assert!(ver.artifact_checksums.contains_key("slicers.json"));

        let pull_req = PullRequest {
            package_name: "slicer-pkg".to_string(),
            registry_url: format!("file://{}", dir.path().display()),
            version_pin: VersionPin::Exact(SemVer::new(1, 0, 0)),
            now: "2026-07-12T01:00:00Z".to_string(),
        };
        let result = pull(&reg, &pull_req, prof.path()).unwrap();

        assert_eq!(result.slicers.len(), 1, "only the published sheet's slicer travels");
        let s = &result.slicers[0];
        assert_eq!(s.id, published_slicer_id);
        assert_eq!(s.name, "ByRegion");
        assert_eq!(
            s.sheet_id, published_sheet_id,
            "slicers carry the un-remapped PACKAGE sheet id, like CF/DV"
        );
        assert_eq!(
            s.selected_items,
            Some(vec!["North".to_string(), "South".to_string()])
        );
        assert_eq!(s.style_preset, "SlicerStyleLight2");
        assert!(matches!(s.selection_mode, persistence::SavedSlicerSelectionMode::Multi));
        assert_eq!(s.connected_sources.len(), 1);
        assert_eq!(s.connected_sources[0].source_id, connected_pivot_id);
    }

    #[test]
    fn min_app_version_stamped_for_wave_content_and_empty_otherwise() {
        // Compatibility contract: a package carrying Wave A/B artifacts must
        // declare the publisher app's version (publish writes the request's
        // min_app_version VERBATIM into the signed manifest) so pre-Wave apps
        // refuse it honestly instead of silently dropping the new artifacts.
        // A cell-only package carries no minimum and stays pullable anywhere.
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();

        // Cell-only workbook: no Wave A/B content -> hosts stamp nothing.
        let plain_wb = make_test_workbook();
        let mut plain_req = PublishRequest {
            model_writebacks: None,
            workbook: &plain_wb,
            package_name: "min-app-pkg".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            sheet_indices: vec![0, 1],
            now: "2026-07-12T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments: false,
            min_app_version: String::new(),
        };
        assert!(
            !publish::carries_wave_content(&plain_req),
            "a cell-only package must not trigger the version stamp"
        );
        publish::publish(&reg, &plain_req, prof.path()).unwrap();
        let v1 = reg.get_version_manifest("min-app-pkg", "1.0.0").unwrap();
        assert_eq!(v1.min_app_version, "", "cell-only package declares no minimum");

        // Same package, next version, now with a slicer (Wave A): the host
        // detects wave content and the stamp lands verbatim in the manifest.
        let mut wave_wb = make_test_workbook();
        wave_wb.slicers = vec![make_test_slicer("ByRegion", wave_wb.sheets[0].id)];
        plain_req.workbook = &wave_wb;
        plain_req.version = SemVer::new(1, 0, 1);
        assert!(
            publish::carries_wave_content(&plain_req),
            "a slicer on a published sheet is Wave A content"
        );
        plain_req.min_app_version = "2.5.0".to_string();
        publish::publish(&reg, &plain_req, prof.path()).unwrap();
        let v2 = reg.get_version_manifest("min-app-pkg", "1.0.1").unwrap();
        assert_eq!(v2.min_app_version, "2.5.0", "publish writes the stamp verbatim");
    }

    #[test]
    fn pull_carries_ribbon_filters_with_data_source_id() {
        // Wave A: ribbon filters are workbook-scoped and BI-only; the stable
        // package data-source id must survive so the subscriber's pull can
        // re-bind connection_id onto the freshly materialized connection.
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();

        let mut wb = make_test_workbook();
        let filter_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        let connection_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        wb.ribbon_filters = vec![persistence::SavedRibbonFilter {
            id: filter_id,
            name: "Year".to_string(),
            connection_id,
            data_source_id: Some(connection_id.to_string()),
            field_name: "dim_date.year".to_string(),
            field_data_type: "number".to_string(),
            connection_mode: persistence::SavedConnectionMode::Workbook,
            connected_pivots: Vec::new(),
            connected_sheets: Vec::new(),
            display_mode: persistence::SavedRibbonFilterDisplayMode::Dropdown,
            selected_items: Some(vec!["2026".to_string()]),
            cross_filter_targets: Vec::new(),
            cross_filter_slicer_targets: Vec::new(),
            advanced_filter: None,
            hide_no_data: false,
            indicate_no_data: true,
            sort_no_data_last: true,
            show_select_all: false,
            single_select: true,
            order: 2,
            button_columns: 2,
            button_rows: 0,
        }];

        let publish_req = PublishRequest {
            model_writebacks: None,
            workbook: &wb,
            package_name: "filter-pkg".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            sheet_indices: vec![0], // partial selection — filters still all travel
            now: "2026-07-12T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments: false,
            min_app_version: String::new(),
        };
        let pub_result = publish::publish(&reg, &publish_req, prof.path()).unwrap();
        assert_eq!(pub_result.ribbon_filters_published, 1);
        let ver = reg.get_version_manifest("filter-pkg", "1.0.0").unwrap();
        assert!(ver.artifact_checksums.contains_key("ribbon_filters.json"));

        let pull_req = PullRequest {
            package_name: "filter-pkg".to_string(),
            registry_url: format!("file://{}", dir.path().display()),
            version_pin: VersionPin::Exact(SemVer::new(1, 0, 0)),
            now: "2026-07-12T01:00:00Z".to_string(),
        };
        let result = pull(&reg, &pull_req, prof.path()).unwrap();

        assert_eq!(result.ribbon_filters.len(), 1);
        let f = &result.ribbon_filters[0];
        assert_eq!(f.id, filter_id);
        assert_eq!(f.name, "Year");
        assert_eq!(
            f.data_source_id.as_deref(),
            Some(connection_id.to_string().as_str()),
            "the stable data_source_id must survive for the pull-side re-bind"
        );
        assert_eq!(f.field_name, "dim_date.year");
        assert_eq!(f.selected_items, Some(vec!["2026".to_string()]));
        assert!(f.single_select);
        assert_eq!(f.order, 2);
    }

    #[test]
    fn pull_carries_pivot_layouts() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();

        let mut wb = make_test_workbook();
        let layout_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        wb.pivot_layouts = vec![persistence::SavedPivotLayout {
            id: layout_id,
            name: "Sales by Region".to_string(),
            dsl_text: "ROWS: Region\nVALUES: SUM(Amount)".to_string(),
            description: Some("quarterly view".to_string()),
            source_type: "bi".to_string(),
            source_table_name: None,
            source_bi_tables: vec!["fact_sales".to_string()],
            source_bi_measures: vec!["Total Amount".to_string()],
            created_at: 1.0,
            updated_at: 2.0,
        }];

        let publish_req = PublishRequest {
            model_writebacks: None,
            workbook: &wb,
            package_name: "layout-pkg".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            sheet_indices: vec![0, 1],
            now: "2026-07-12T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments: false,
            min_app_version: String::new(),
        };
        let pub_result = publish::publish(&reg, &publish_req, prof.path()).unwrap();
        assert_eq!(pub_result.pivot_layouts_published, 1);
        let ver = reg.get_version_manifest("layout-pkg", "1.0.0").unwrap();
        assert!(ver.artifact_checksums.contains_key("pivot_layouts.json"));

        let pull_req = PullRequest {
            package_name: "layout-pkg".to_string(),
            registry_url: format!("file://{}", dir.path().display()),
            version_pin: VersionPin::Exact(SemVer::new(1, 0, 0)),
            now: "2026-07-12T01:00:00Z".to_string(),
        };
        let result = pull(&reg, &pull_req, prof.path()).unwrap();

        assert_eq!(result.pivot_layouts.len(), 1);
        let l = &result.pivot_layouts[0];
        assert_eq!(l.id, layout_id);
        assert_eq!(l.name, "Sales by Region");
        assert_eq!(l.dsl_text, "ROWS: Region\nVALUES: SUM(Amount)");
        assert_eq!(l.source_type, "bi");
        assert_eq!(l.source_bi_tables, vec!["fact_sales".to_string()]);
        assert_eq!(l.source_bi_measures, vec!["Total Amount".to_string()]);
    }

    #[test]
    fn pull_carries_document_theme() {
        // Wave A: theme.json is a singleton — ALWAYS written, and the
        // publisher's (customized) theme reads back exactly.
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();

        let mut wb = make_test_workbook();
        wb.theme = engine::theme::ThemeDefinition::facet();

        let publish_req = PublishRequest {
            model_writebacks: None,
            workbook: &wb,
            package_name: "theme-pkg".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            sheet_indices: vec![0, 1],
            now: "2026-07-12T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments: false,
            min_app_version: String::new(),
        };
        publish::publish(&reg, &publish_req, prof.path()).unwrap();
        let ver = reg.get_version_manifest("theme-pkg", "1.0.0").unwrap();
        assert!(ver.artifact_checksums.contains_key("theme.json"));

        let pull_req = PullRequest {
            package_name: "theme-pkg".to_string(),
            registry_url: format!("file://{}", dir.path().display()),
            version_pin: VersionPin::Exact(SemVer::new(1, 0, 0)),
            now: "2026-07-12T01:00:00Z".to_string(),
        };
        let result = pull(&reg, &pull_req, prof.path()).unwrap();

        let theme = result.theme.expect("theme.json is always carried");
        assert_eq!(theme, engine::theme::ThemeDefinition::facet());
        assert_eq!(theme.name, "Facet");
    }

    #[test]
    fn pull_carries_extension_data() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();

        let mut wb = make_test_workbook();
        wb.extension_data.insert(
            "calcula.bookmarks".to_string(),
            serde_json::json!({ "items": [{ "name": "Q1", "ref": "A1" }] }),
        );
        wb.extension_data.insert(
            "thirdparty.notes".to_string(),
            serde_json::json!("plain string state"),
        );

        let publish_req = PublishRequest {
            model_writebacks: None,
            workbook: &wb,
            package_name: "ext-pkg".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            sheet_indices: vec![0, 1],
            now: "2026-07-12T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments: false,
            min_app_version: String::new(),
        };
        let pub_result = publish::publish(&reg, &publish_req, prof.path()).unwrap();
        assert_eq!(pub_result.extension_data_published, 2);
        let ver = reg.get_version_manifest("ext-pkg", "1.0.0").unwrap();
        assert!(ver.artifact_checksums.contains_key("extension_data.json"));

        let pull_req = PullRequest {
            package_name: "ext-pkg".to_string(),
            registry_url: format!("file://{}", dir.path().display()),
            version_pin: VersionPin::Exact(SemVer::new(1, 0, 0)),
            now: "2026-07-12T01:00:00Z".to_string(),
        };
        let result = pull(&reg, &pull_req, prof.path()).unwrap();

        assert_eq!(result.extension_data.len(), 2);
        assert_eq!(
            result.extension_data.get("calcula.bookmarks"),
            Some(&serde_json::json!({ "items": [{ "name": "Q1", "ref": "A1" }] }))
        );
        assert_eq!(
            result.extension_data.get("thirdparty.notes"),
            Some(&serde_json::json!("plain string state"))
        );
    }

    #[test]
    fn pull_without_wave_a_artifacts_returns_empty_defaults() {
        // A package whose workbook carries none of the optional Wave A kinds:
        // the vec artifacts are absent (reader tolerates), extension data is
        // empty, and only the always-written theme singleton is present.
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        publish_test_package(&reg, prof.path());

        assert!(reg.read_artifact("test-pkg", "1.0.0", "slicers.json").unwrap().is_none());
        assert!(reg.read_artifact("test-pkg", "1.0.0", "ribbon_filters.json").unwrap().is_none());
        assert!(reg.read_artifact("test-pkg", "1.0.0", "pivot_layouts.json").unwrap().is_none());
        assert!(reg.read_artifact("test-pkg", "1.0.0", "extension_data.json").unwrap().is_none());

        let result = pull(&reg, &make_pull_request(), prof.path()).unwrap();
        assert!(result.slicers.is_empty());
        assert!(result.ribbon_filters.is_empty());
        assert!(result.pivot_layouts.is_empty());
        assert!(result.extension_data.is_empty());
        assert_eq!(result.theme, Some(engine::theme::ThemeDefinition::default()));
    }

    #[test]
    fn pull_with_no_pane_controls_returns_empty() {
        // Packages published without pane controls (or before they were
        // carried) pull an empty set — no artifact, no error.
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        publish_test_package(&reg, prof.path());

        assert!(reg
            .read_artifact("test-pkg", "1.0.0", "pane_controls.json")
            .unwrap()
            .is_none());
        let result = pull(&reg, &make_pull_request(), prof.path()).unwrap();
        assert!(result.pane_controls.is_empty());
    }

    #[test]
    fn model_only_dataset_package_round_trip() {
        // Slice E (model-in-calp): a package of kind "dataset" with ZERO
        // sheets is the distribution unit for a BI model — publish embeds the
        // credential-free model JSON as models/{id}/model.json; pull hands
        // back the data source (the app layer materializes a connection).
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();

        let wb = persistence::Workbook::new();
        let publish_req = PublishRequest {
            model_writebacks: None,
            workbook: &wb,
            package_name: "sales-model".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "dataset".to_string(),
            sheet_indices: Vec::new(), // model-only: no sheets
            now: "2026-07-02T00:00:00Z".to_string(),
            published_by: "author".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: vec![publish::PublishDataSource {
                id: "ds-1".to_string(),
                name: "Sales".to_string(),
                connection_type: "PostgreSQL".to_string(),
                server: "db.example".to_string(),
                database: "sales".to_string(),
                model_json: serde_json::json!({
                    "formatVersion": 1,
                    "model": { "tables": [] }
                }),
                bindings: Vec::new(),
                calculated_table_snapshots: Vec::new(),
                writeback_history_json: None,
            }],
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments: false,
            min_app_version: String::new(),
        };
        let pub_result = publish::publish(&reg, &publish_req, prof.path()).unwrap();
        assert_eq!(pub_result.sheets_published, 0);
        assert_eq!(pub_result.data_sources_published, 1);

        let pull_req = PullRequest {
            package_name: "sales-model".to_string(),
            registry_url: format!("file://{}", dir.path().display()),
            version_pin: VersionPin::Exact(SemVer::new(1, 0, 0)),
            now: "2026-07-02T01:00:00Z".to_string(),
        };
        let result = pull(&reg, &pull_req, prof.path()).unwrap();
        assert_eq!(result.sheets.len(), 0, "a dataset package carries no sheets");
        assert_eq!(result.data_sources.len(), 1);
        assert_eq!(result.data_sources[0].definition.name, "Sales");
        assert_eq!(result.data_sources[0].definition.server, "db.example");
        // The local transport resolves the embedded model to a readable
        // on-disk path (blob-fallback after dedup), and the bytes are the
        // published model JSON.
        let bytes = fs::read(&result.data_sources[0].model_path)
            .expect("embedded model resolvable on disk");
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(v.get("formatVersion").is_some());
    }

    #[test]
    fn pull_carries_named_ranges_and_cf_dv() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();

        let mut sheet = Sheet::new("Sales".to_string());
        sheet
            .cells
            .insert((0, 0), SavedCell::from_cell(&engine::cell::Cell::new_number(1.0)));
        let pkg_sheet_id = sheet.id;
        let mut wb = persistence::Workbook::default();
        wb.sheets = vec![sheet];
        wb.named_ranges.push(persistence::SavedNamedRange {
            name: "TaxRate".to_string(),
            refers_to: "=0.25".to_string(),
            sheet_id: None, // workbook-scoped
            comment: None,
            folder: None,
        });
        wb.conditional_formats.push(persistence::SavedSheetConditionalFormats {
            sheet_id: pkg_sheet_id,
            rules: serde_json::json!([{ "id": 1, "rule": { "type": "cellValue" } }]),
        });
        wb.data_validations.push(persistence::SavedSheetDataValidations {
            sheet_id: pkg_sheet_id,
            ranges: serde_json::json!([{ "startRow": 0, "startCol": 0, "endRow": 9, "endCol": 0 }]),
        });

        let publish_req = PublishRequest {
            model_writebacks: None,
            workbook: &wb,
            package_name: "fidelity-pkg".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            sheet_indices: vec![0],
            now: "2026-05-18T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments: false,
            min_app_version: String::new(),
        };
        publish::publish(&reg, &publish_req, prof.path()).unwrap();

        let pull_req = PullRequest {
            package_name: "fidelity-pkg".to_string(),
            registry_url: format!("file://{}", dir.path().display()),
            version_pin: VersionPin::Exact(SemVer::new(1, 0, 0)),
            now: "2026-05-18T01:00:00Z".to_string(),
        };
        let result = pull(&reg, &pull_req, prof.path()).unwrap();

        // Named ranges ride in the manifest; CF/DV are read from their artifacts.
        // sheet_ids stay as PACKAGE ids here (the Tauri pull remaps to local index).
        assert_eq!(result.named_ranges.len(), 1, "named range must be carried by .calp");
        assert_eq!(result.named_ranges[0].name, "TaxRate");
        assert_eq!(result.conditional_formats.len(), 1, "CF must be carried by .calp");
        assert_eq!(result.conditional_formats[0].sheet_id, pkg_sheet_id);
        assert_eq!(result.data_validations.len(), 1, "DV must be carried by .calp");
        assert_eq!(result.data_validations[0].sheet_id, pkg_sheet_id);
    }

    /// Workbook with one published + one unpublished sheet, carrying Wave B
    /// state (comments/scenarios/outlines) on BOTH — so the tests can assert
    /// both the carry and the published-sheet filter.
    fn make_wave_b_workbook() -> (persistence::Workbook, SheetId) {
        let mut sheet = Sheet::new("Report".to_string());
        sheet
            .cells
            .insert((0, 0), SavedCell::from_cell(&engine::cell::Cell::new_number(1.0)));
        let pkg_sheet_id = sheet.id;
        let other_sheet = Sheet::new("Private".to_string());
        let other_id = other_sheet.id;
        let mut wb = persistence::Workbook::default();
        wb.sheets = vec![sheet, other_sheet];
        for sid in [pkg_sheet_id, other_id] {
            wb.comments.push(SavedSheetComments {
                sheet_id: sid,
                comments: serde_json::json!([
                    { "id": "c-1", "row": 0, "col": 0, "content": "internal note",
                      "resolved": false, "replies": [] }
                ]),
            });
            wb.scenarios.push(SavedSheetScenarios {
                sheet_id: sid,
                scenarios: serde_json::json!([
                    { "name": "Best case", "sheetIndex": 0,
                      "changingCells": [ { "row": 1, "col": 1, "value": "42" } ] }
                ]),
            });
            wb.outlines.push(SavedSheetOutline {
                sheet_id: sid,
                outline: serde_json::json!({
                    "rowGroups": [ { "startRow": 2, "endRow": 5, "level": 1, "collapsed": true } ],
                    "columnGroups": []
                }),
            });
        }
        (wb, pkg_sheet_id)
    }

    fn wave_b_publish_req<'a>(
        wb: &'a persistence::Workbook,
        include_comments: bool,
    ) -> PublishRequest<'a> {
        PublishRequest {
            model_writebacks: None,
            workbook: wb,
            package_name: "wave-b-pkg".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            sheet_indices: vec![0], // only "Report" — "Private" stays behind
            now: "2026-07-12T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments,
            min_app_version: String::new(),
        }
    }

    #[test]
    fn pull_carries_scenarios_and_outlines_filtered_to_published_sheets() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        let (wb, pkg_sheet_id) = make_wave_b_workbook();

        let pub_result =
            publish::publish(&reg, &wave_b_publish_req(&wb, false), prof.path()).unwrap();
        assert_eq!(pub_result.scenario_sheets_published, 1);
        assert_eq!(pub_result.outline_sheets_published, 1);

        let pull_req = PullRequest {
            package_name: "wave-b-pkg".to_string(),
            registry_url: format!("file://{}", dir.path().display()),
            version_pin: VersionPin::Exact(SemVer::new(1, 0, 0)),
            now: "2026-07-12T01:00:00Z".to_string(),
        };
        let result = pull(&reg, &pull_req, prof.path()).unwrap();

        // Scenarios + outlines travel per published sheet, PACKAGE sheet ids
        // un-remapped (CF/DV semantics); the unpublished sheet's entries do not.
        assert_eq!(result.scenarios.len(), 1, "scenarios must be carried by .calp");
        assert_eq!(result.scenarios[0].sheet_id, pkg_sheet_id);
        assert_eq!(result.scenarios[0].scenarios, wb.scenarios[0].scenarios);
        assert_eq!(result.outlines.len(), 1, "outlines must be carried by .calp");
        assert_eq!(result.outlines[0].sheet_id, pkg_sheet_id);
        assert_eq!(result.outlines[0].outline, wb.outlines[0].outline);
    }

    #[test]
    fn publish_omits_comments_unless_opted_in() {
        // PRIVACY POLICY: include_comments=false (the default everywhere) must
        // never write comments.json — even when the carrier holds comments on
        // the published sheets.
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        let (wb, _) = make_wave_b_workbook();

        let pub_result =
            publish::publish(&reg, &wave_b_publish_req(&wb, false), prof.path()).unwrap();
        assert_eq!(pub_result.comment_sheets_published, 0);

        let pkg = "wave-b-pkg";
        let ver = "1.0.0";
        assert!(
            reg.read_artifact(pkg, ver, "comments.json").unwrap().is_none(),
            "comments.json must not exist without the opt-in"
        );

        let pull_req = PullRequest {
            package_name: pkg.to_string(),
            registry_url: format!("file://{}", dir.path().display()),
            version_pin: VersionPin::Exact(SemVer::new(1, 0, 0)),
            now: "2026-07-12T01:00:00Z".to_string(),
        };
        let result = pull(&reg, &pull_req, prof.path()).unwrap();
        assert!(result.comments.is_empty(), "no comments may arrive without the opt-in");
    }

    #[test]
    fn pull_carries_comments_when_opted_in() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        let (wb, pkg_sheet_id) = make_wave_b_workbook();

        let pub_result =
            publish::publish(&reg, &wave_b_publish_req(&wb, true), prof.path()).unwrap();
        assert_eq!(pub_result.comment_sheets_published, 1);

        let pull_req = PullRequest {
            package_name: "wave-b-pkg".to_string(),
            registry_url: format!("file://{}", dir.path().display()),
            version_pin: VersionPin::Exact(SemVer::new(1, 0, 0)),
            now: "2026-07-12T01:00:00Z".to_string(),
        };
        let result = pull(&reg, &pull_req, prof.path()).unwrap();

        // Only the PUBLISHED sheet's comments travel, package sheet id
        // un-remapped, payload byte-identical (opaque to the calp layer).
        assert_eq!(result.comments.len(), 1, "opted-in comments must be carried by .calp");
        assert_eq!(result.comments[0].sheet_id, pkg_sheet_id);
        assert_eq!(result.comments[0].comments, wb.comments[0].comments);
    }

    #[test]
    fn pull_materializes_charts_with_remapped_sheet_id() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();

        // A workbook with a chart that lives on its sheet.
        let mut sheet = Sheet::new("Charted".to_string());
        sheet
            .cells
            .insert((0, 0), SavedCell::from_cell(&engine::cell::Cell::new_number(1.0)));
        let pkg_sheet_id = sheet.id;
        let chart_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        let mut wb = persistence::Workbook::default();
        wb.charts.push(SavedChart {
            id: chart_id,
            sheet_id: pkg_sheet_id,
            spec_json: "{\"kind\":\"bar\"}".to_string(),
        });
        wb.sheets = vec![sheet];

        let publish_req = PublishRequest {
            model_writebacks: None,
            workbook: &wb,
            package_name: "charted-pkg".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            sheet_indices: vec![0],
            now: "2026-05-18T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments: false,
            min_app_version: String::new(),
        };
        publish::publish(&reg, &publish_req, prof.path()).unwrap();

        let pull_req = PullRequest {
            package_name: "charted-pkg".to_string(),
            registry_url: format!("file://{}", dir.path().display()),
            version_pin: VersionPin::Exact(SemVer::new(1, 0, 0)),
            now: "2026-05-18T01:00:00Z".to_string(),
        };
        let result = pull(&reg, &pull_req, prof.path()).unwrap();

        // The chart round-trips, with its sheet_id remapped from the package id
        // to the new LOCAL sheet id so it lands on the right sheet.
        assert_eq!(result.charts.len(), 1);
        let chart = &result.charts[0];
        assert_eq!(chart.id, chart_id);
        assert_eq!(chart.spec_json, "{\"kind\":\"bar\"}");
        let local_sheet_id = result.sheets[0].sheet.id;
        assert_eq!(chart.sheet_id, local_sheet_id);
        assert_ne!(chart.sheet_id, pkg_sheet_id);
    }

    #[test]
    fn pull_restores_sparklines_with_remapped_sheet_id() {
        // C2a: a sparkline must survive publish -> pull with its sheet_id remapped
        // from the package id to the new LOCAL sheet id (same contract as charts).
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();

        let mut sheet = Sheet::new("Sparked".to_string());
        sheet
            .cells
            .insert((0, 0), SavedCell::from_cell(&engine::cell::Cell::new_number(1.0)));
        let pkg_sheet_id = sheet.id;
        let groups = "[{\"dataRange\":\"A1:A5\",\"location\":\"B1\"}]".to_string();
        let mut wb = persistence::Workbook::default();
        wb.sparklines.push(SavedSparkline {
            sheet_id: pkg_sheet_id,
            groups_json: groups.clone(),
        });
        wb.sheets = vec![sheet];

        let publish_req = PublishRequest {
            model_writebacks: None,
            workbook: &wb,
            package_name: "sparked-pkg".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            sheet_indices: vec![0],
            now: "2026-06-28T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments: false,
            min_app_version: String::new(),
        };
        publish::publish(&reg, &publish_req, prof.path()).unwrap();

        let pull_req = PullRequest {
            package_name: "sparked-pkg".to_string(),
            registry_url: format!("file://{}", dir.path().display()),
            version_pin: VersionPin::Exact(SemVer::new(1, 0, 0)),
            now: "2026-06-28T01:00:00Z".to_string(),
        };
        let result = pull(&reg, &pull_req, prof.path()).unwrap();

        assert_eq!(result.sparklines.len(), 1, "the sparkline round-trips");
        let sp = &result.sparklines[0];
        assert_eq!(sp.groups_json, groups, "opaque groups_json is byte-preserved");
        let local_sheet_id = result.sheets[0].sheet.id;
        assert_eq!(sp.sheet_id, local_sheet_id, "remapped to the new local sheet");
        assert_ne!(sp.sheet_id, pkg_sheet_id, "no longer the package sheet id");
    }

    #[test]
    fn pull_creates_subscription_metadata() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        publish_test_package(&reg, prof.path());

        let request = PullRequest {
            package_name: "test-pkg".to_string(),
            registry_url: "file:///test/registry".to_string(),
            version_pin: VersionPin::Caret(SemVer::new(1, 0, 0)),
            now: "2026-05-18T01:00:00Z".to_string(),
        };

        let result = pull(&reg, &request, prof.path()).unwrap();
        let sub = &result.subscription;
        assert_eq!(sub.package_name, "test-pkg");
        assert_eq!(sub.resolved_version, "1.0.0");
        assert_eq!(sub.sheets.len(), 2);

        // Local sheet IDs should be different from package sheet IDs
        for sheet_sub in &sub.sheets {
            assert_ne!(sheet_sub.package_sheet_id, sheet_sub.local_sheet_id);
        }
    }

    #[test]
    fn pull_with_version_resolution() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        let wb = make_test_workbook();

        // Publish v1.0.0, v1.1.0, v2.0.0
        for (maj, min) in [(1, 0), (1, 1), (2, 0)] {
            let request = PublishRequest {
            model_writebacks: None,
                workbook: &wb,
                package_name: "versioned".to_string(),
                version: SemVer::new(maj, min, 0),
                kind: "report".to_string(),
                sheet_indices: vec![0],
                now: "2026-05-18T00:00:00Z".to_string(),
                published_by: "tester".to_string(),
                writeback_regions: None,
                object_scripts: None,
                module_scripts: None,
                notebooks: None,
                data_sources: Vec::new(),
                excluded_regions: Vec::new(),
                custom_objects: Vec::new(),
                include_comments: false,
                min_app_version: String::new(),
            };
            publish::publish(&reg, &request, prof.path()).unwrap();
        }

        // ^1.0 should resolve to 1.1.0
        let request = PullRequest {
            package_name: "versioned".to_string(),
            registry_url: "file:///test".to_string(),
            version_pin: VersionPin::Caret(SemVer::new(1, 0, 0)),
            now: "2026-05-18T01:00:00Z".to_string(),
        };

        let result = pull(&reg, &request, prof.path()).unwrap();
        assert_eq!(result.resolved_version, SemVer::new(1, 1, 0));
    }

    #[test]
    fn pull_nonexistent_package_fails() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();

        let request = PullRequest {
            package_name: "ghost".to_string(),
            registry_url: "file:///test".to_string(),
            version_pin: VersionPin::Latest,
            now: "2026-05-18T00:00:00Z".to_string(),
        };

        let result = pull(&reg, &request, prof.path());
        assert!(result.is_err());
    }

    // --- Integrity verification tests (S5 phase 1) ---

    fn make_pull_request() -> PullRequest {
        PullRequest {
            package_name: "test-pkg".to_string(),
            registry_url: "file:///test".to_string(),
            version_pin: VersionPin::Exact(SemVer::new(1, 0, 0)),
            now: "2026-05-18T01:00:00Z".to_string(),
        }
    }

    /// unwrap_err() requires Debug on the Ok type; PullResult intentionally
    /// has no Debug derive (deep persistence types), so match instead.
    fn expect_pull_err(reg: &LocalRegistry, req: &PullRequest, prof: &std::path::Path) -> CalpError {
        match pull(reg, req, prof) {
            Ok(_) => panic!("pull unexpectedly succeeded"),
            Err(e) => e,
        }
    }

    /// Re-sign a manifest after a test mutates it in place (publish signs the
    /// ORIGINAL bytes; rewriting the manifest invalidates that signature, which
    /// the signature gate — running first — would otherwise flag). Uses the
    /// persisted publisher keypair so the signature is valid for the new bytes,
    /// letting the test reach the integrity gate it is actually exercising.
    fn resign_manifest(reg: &LocalRegistry, prof: &std::path::Path, package: &str, version: &str) {
        let ver_dir = reg.version_dir(package, version).unwrap();
        let manifest_bytes = fs::read(ver_dir.join(crate::integrity::VERSION_MANIFEST_FILE)).unwrap();
        let kp = crate::signing::PublisherKeypair::load_or_create(prof).unwrap();
        let sig = kp.sign(&manifest_bytes);
        fs::write(ver_dir.join(crate::integrity::VERSION_MANIFEST_SIG_FILE), sig).unwrap();
    }

    #[test]
    fn pull_roundtrip_passes_integrity_verification() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        publish_test_package(&reg, prof.path());

        // Publish recorded checksums...
        let ver = reg.get_version_manifest("test-pkg", "1.0.0").unwrap();
        assert!(!ver.artifact_checksums.is_empty());

        // ...and an untampered pull passes the integrity gate.
        let result = pull(&reg, &make_pull_request(), prof.path()).unwrap();
        assert_eq!(result.sheets.len(), 2);
    }

    #[test]
    fn pull_fails_on_tampered_data_file() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        let wb = publish_test_package(&reg, prof.path());

        // Tamper with a published artifact after publish.
        let data_path = reg
            .sheet_dir("test-pkg", "1.0.0", &wb.sheets[0].id)
            .unwrap()
            .join("data.json");
        fs::write(&data_path, "{\"cells\": \"tampered\"}").unwrap();

        let err = expect_pull_err(&reg, &make_pull_request(), prof.path());
        assert!(matches!(err, CalpError::ChecksumMismatch { .. }));
        let msg = err.to_string();
        assert!(msg.contains("Package integrity check failed"), "msg: {}", msg);
        assert!(msg.contains("test-pkg@1.0.0"), "msg: {}", msg);
        assert!(msg.contains("data.json"), "msg: {}", msg);
    }

    #[test]
    fn pull_fails_on_corrupted_blob() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        let wb = publish_test_package(&reg, prof.path());

        // Corrupt a deduped artifact's blob: its content no longer hashes to the
        // (signed) checksum, so pull rejects it. With content-addressed storage,
        // smuggling an UNLISTED extra file is moot — it is never referenced by the
        // signed manifest, hence never read or pulled.
        let ver = reg.get_version_manifest("test-pkg", "1.0.0").unwrap();
        let key = format!("sheets/{}/data.json", wb.sheets[0].id);
        let hash = ver.artifact_checksums.get(&key).expect("data.json checksum");
        let blob = dir.path().join(".blobs").join(&hash[0..2]).join(hash);
        fs::write(&blob, "{\"cells\": \"corrupted\"}").unwrap();

        let err = expect_pull_err(&reg, &make_pull_request(), prof.path());
        assert!(matches!(err, CalpError::ChecksumMismatch { .. }));
        assert!(err.to_string().contains("data.json"));
    }

    #[test]
    fn pull_fails_on_deleted_artifact() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        let wb = publish_test_package(&reg, prof.path());

        // Tamper-by-deletion: remove a deduped artifact's blob -> a hard error.
        let ver = reg.get_version_manifest("test-pkg", "1.0.0").unwrap();
        let key = format!("sheets/{}/styles.json", wb.sheets[1].id);
        let hash = ver.artifact_checksums.get(&key).expect("styles.json checksum");
        let blob = dir.path().join(".blobs").join(&hash[0..2]).join(hash);
        fs::remove_file(&blob).unwrap();

        let err = expect_pull_err(&reg, &make_pull_request(), prof.path());
        assert!(matches!(err, CalpError::MissingArtifact { .. }));
        assert!(err.to_string().contains("styles.json"));
    }

    #[test]
    fn pull_fails_on_package_published_without_checksums() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        publish_test_package(&reg, prof.path());

        // Simulate a pre-checksum (legacy) package: strip the checksum map
        // from the version manifest. No backward compatibility: hard error.
        // Re-sign so we get PAST the signature gate (which runs first) and
        // actually exercise the checksum gate this test is about.
        let mut ver = reg.get_version_manifest("test-pkg", "1.0.0").unwrap();
        ver.artifact_checksums = std::collections::BTreeMap::new();
        reg.write_version_manifest("test-pkg", "1.0.0", &ver).unwrap();
        resign_manifest(&reg, prof.path(), "test-pkg", "1.0.0");

        let err = expect_pull_err(&reg, &make_pull_request(), prof.path());
        assert!(matches!(err, CalpError::MissingChecksums { .. }));
        let msg = err.to_string();
        assert!(msg.contains("without integrity checksums"), "msg: {}", msg);
        assert!(msg.contains("republish"), "msg: {}", msg);
    }

    #[test]
    fn pull_ignores_subscriber_submissions() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        publish_test_package(&reg, prof.path());

        // Post-publish event files land inside the version directory —
        // subscriber submissions AND publisher review events. Both are a
        // separate trust domain and must not trip the publisher-artifact
        // integrity gate.
        let submission = crate::writeback::WritebackSubmission {
            model_key: None,
            id: "sub-1".to_string(),
            region_id: "r1".to_string(),
            cell_row: 0,
            cell_col: 0,
            cell_id: None,
            submitter: crate::identity_provider::SubmitterIdentity {
                display_name: "alice".to_string(),
                id: "id-alice".to_string(),
                extra: HashMap::new(),
            },
            value: crate::writeback::SubmissionValue::Number { value: 42.0 },
            state: crate::writeback::SubmissionState::Submitted,
            created_at: "2026-05-18T02:00:00Z".to_string(),
            updated_at: "2026-05-18T02:00:00Z".to_string(),
            submitted_at: Some("2026-05-18T02:00:00Z".to_string()),
            review_reason: None,
            reviewed_by: None,
            extra: HashMap::new(),
        };
        reg.save_submission("test-pkg", "1.0.0", &submission).unwrap();
        reg.save_review(
            "test-pkg",
            "1.0.0",
            &crate::writeback::ReviewEvent {
                id: "rev-1".to_string(),
                target_submission_id: "sub-1".to_string(),
                region_id: "r1".to_string(),
                submitter_id: "id-alice".to_string(),
                new_state: crate::writeback::SubmissionState::Approved,
                review_reason: None,
                reviewed_by: Some("Publisher".to_string()),
                reviewed_at: "2026-05-18T03:00:00Z".to_string(),
                extra: HashMap::new(),
            },
        )
        .unwrap();

        let result = pull(&reg, &make_pull_request(), prof.path()).unwrap();
        assert_eq!(result.sheets.len(), 2);
    }

    #[test]
    fn end_to_end_publish_and_pull_roundtrip() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        let original_wb = publish_test_package(&reg, prof.path());

        let request = PullRequest {
            package_name: "test-pkg".to_string(),
            registry_url: format!("file://{}", dir.path().display()),
            version_pin: VersionPin::Exact(SemVer::new(1, 0, 0)),
            now: "2026-05-18T01:00:00Z".to_string(),
        };
        let result = pull(&reg, &request, prof.path()).unwrap();

        // Same number of sheets
        assert_eq!(result.sheets.len(), original_wb.sheets.len());

        // Same sheet names
        for (pulled, original) in result.sheets.iter().zip(original_wb.sheets.iter()) {
            assert_eq!(pulled.name, original.name);
        }

        // Same cell count in first sheet
        let original_cell_count = original_wb.sheets[0].cells.len();
        let pulled_cell_count = result.sheets[0].sheet.cells.len();
        assert_eq!(pulled_cell_count, original_cell_count);
    }

    // --- D9: sheet presentation-metadata fidelity ---

    #[test]
    fn pull_restores_sheet_presentation_metadata() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();

        // A sheet carrying rich metadata a pre-D9 pull would have dropped.
        let mut wb = make_test_workbook();
        {
            let s = &mut wb.sheets[0];
            s.merged_regions = vec![persistence::SavedMergedRegion {
                start_row: 0, start_col: 0, end_row: 0, end_col: 3,
            }];
            s.freeze_row = Some(1);
            s.freeze_col = Some(2);
            s.hidden_rows = [3u32, 4].into_iter().collect();
            s.hidden_cols = [5u32].into_iter().collect();
            s.tab_color = "#ff0000".to_string();
            s.visibility = "hidden".to_string();
            s.notes = vec![persistence::SavedNote {
                row: 0, col: 0, text: "hi".to_string(), author: "me".to_string(),
                rich_content: None, width: 0.0, height: 0.0, visible: false,
                created_at: String::new(), modified_at: String::new(),
            }];
            s.hyperlinks = vec![persistence::SavedHyperlink {
                row: 1, col: 1, target: "https://x".to_string(), display_text: None, tooltip: None,
            }];
            s.show_gridlines = false;
        }

        let request = PublishRequest {
            model_writebacks: None,
            workbook: &wb,
            package_name: "d9-pkg".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            sheet_indices: vec![0, 1],
            now: "2026-05-18T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments: false,
            min_app_version: String::new(),
        };
        publish::publish(&reg, &request, prof.path()).unwrap();

        let pull_req = PullRequest {
            package_name: "d9-pkg".to_string(),
            registry_url: format!("file://{}", dir.path().display()),
            version_pin: VersionPin::Exact(SemVer::new(1, 0, 0)),
            now: "2026-05-18T01:00:00Z".to_string(),
        };
        let result = pull(&reg, &pull_req, prof.path()).unwrap();

        // The metadata-rich sheet round-trips fully.
        let pulled = &result.sheets[0].sheet;
        assert_eq!(pulled.merged_regions.len(), 1);
        assert_eq!(pulled.merged_regions[0].end_col, 3);
        assert_eq!(pulled.freeze_row, Some(1));
        assert_eq!(pulled.freeze_col, Some(2));
        assert!(pulled.hidden_rows.contains(&3) && pulled.hidden_rows.contains(&4));
        assert!(pulled.hidden_cols.contains(&5));
        assert_eq!(pulled.tab_color, "#ff0000");
        assert_eq!(pulled.visibility, "hidden");
        assert_eq!(pulled.notes.len(), 1);
        assert_eq!(pulled.notes[0].text, "hi");
        assert_eq!(pulled.hyperlinks.len(), 1);
        assert_eq!(pulled.hyperlinks[0].target, "https://x");
        assert!(!pulled.show_gridlines);

        // A plain sheet with no metadata round-trips to the correct defaults.
        let plain = &result.sheets[1].sheet;
        assert!(plain.merged_regions.is_empty());
        assert_eq!(plain.visibility, "visible");
        assert!(plain.show_gridlines);
    }

    // --- C8: standalone module scripts + notebooks ---

    #[test]
    fn pull_materializes_modules_and_notebooks_with_stripped_exec_metadata() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();

        // A workbook carrying one module script and one notebook whose cell
        // has non-trivial execution metadata that MUST be stripped on publish.
        let mut wb = make_test_workbook();
        wb.scripts = vec![SavedScript {
            id: "mod-1".to_string(),
            name: "Helper".to_string(),
            description: Some("a helper module".to_string()),
            source: "export function add(a, b) { return a + b; }".to_string(),
            scope: persistence::SavedScriptScope::Sheet { name: "Data".to_string() },
            source_package: None,
        }];
        wb.notebooks = vec![SavedNotebook {
            id: "nb-1".to_string(),
            name: "Analysis".to_string(),
            cells: vec![persistence::SavedNotebookCell {
                id: "cell-1".to_string(),
                source: "1 + 1".to_string(),
                // Runtime artifacts that must NOT leak into the package.
                last_output: vec![
                    persistence::SavedNotebookOutputItem::text("2"),
                    persistence::SavedNotebookOutputItem::text("cached"),
                ],
                last_error: Some("stale error".to_string()),
                cells_modified: 7,
                duration_ms: 123,
                execution_index: Some(3),
            }],
            source_package: None,
        }];

        let request = PublishRequest {
            model_writebacks: None,
            workbook: &wb,
            package_name: "c8-pkg".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            sheet_indices: vec![0, 1],
            now: "2026-05-18T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None, // None => all from the workbook
            notebooks: None,      // None => all from the workbook
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments: false,
            min_app_version: String::new(),
        };
        let pub_result = publish::publish(&reg, &request, prof.path()).unwrap();
        assert_eq!(pub_result.modules_published, 1);
        assert_eq!(pub_result.notebooks_published, 1);

        // The manifest lists both, and the on-disk artifacts are covered by the
        // integrity checksum walk (they were written before the manifest).
        let ver = reg.get_version_manifest("c8-pkg", "1.0.0").unwrap();
        assert_eq!(ver.module_scripts.len(), 1);
        assert_eq!(ver.module_scripts[0].id, "mod-1");
        assert_eq!(ver.module_scripts[0].scope, "sheet:Data");
        assert_eq!(ver.notebooks.len(), 1);
        assert_eq!(ver.notebooks[0].id, "nb-1");
        assert_eq!(ver.notebooks[0].cell_count, 1);
        assert!(ver.artifact_checksums.contains_key("modules/mod-1.json"));
        assert!(ver.artifact_checksums.contains_key("notebooks/nb-1.json"));

        // Pull and assert content round-trips (and passes the integrity gate).
        let pull_req = PullRequest {
            package_name: "c8-pkg".to_string(),
            registry_url: format!("file://{}", dir.path().display()),
            version_pin: VersionPin::Exact(SemVer::new(1, 0, 0)),
            now: "2026-05-18T01:00:00Z".to_string(),
        };
        let result = pull(&reg, &pull_req, prof.path()).unwrap();

        assert_eq!(result.module_scripts.len(), 1);
        let m = &result.module_scripts[0];
        assert_eq!(m.id, "mod-1");
        assert_eq!(m.name, "Helper");
        assert_eq!(m.description.as_deref(), Some("a helper module"));
        assert_eq!(m.source, "export function add(a, b) { return a + b; }");
        assert!(matches!(
            &m.scope,
            persistence::SavedScriptScope::Sheet { name } if name == "Data"
        ));
        // Provenance is stamped with the package name on pull.
        assert_eq!(m.source_package.as_deref(), Some("c8-pkg"));

        assert_eq!(result.notebooks.len(), 1);
        let nb = &result.notebooks[0];
        assert_eq!(nb.id, "nb-1");
        assert_eq!(nb.name, "Analysis");
        assert_eq!(nb.source_package.as_deref(), Some("c8-pkg"));
        assert_eq!(nb.cells.len(), 1);
        let cell = &nb.cells[0];
        assert_eq!(cell.id, "cell-1");
        assert_eq!(cell.source, "1 + 1");
        // Execution metadata MUST have been stripped at publish time.
        assert!(cell.last_output.is_empty(), "last_output should be stripped");
        assert!(cell.last_error.is_none(), "last_error should be stripped");
        assert_eq!(cell.cells_modified, 0, "cells_modified should be stripped");
        assert_eq!(cell.duration_ms, 0, "duration_ms should be stripped");
        assert!(cell.execution_index.is_none(), "execution_index should be stripped");
    }

    #[test]
    fn pull_with_no_modules_or_notebooks_returns_empty() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        publish_test_package(&reg, prof.path());

        // The base workbook has no module scripts / notebooks; the manifest
        // omits the (empty) fields on the wire and pull returns empty vecs.
        let ver = reg.get_version_manifest("test-pkg", "1.0.0").unwrap();
        assert!(ver.module_scripts.is_empty());
        assert!(ver.notebooks.is_empty());

        let result = pull(&reg, &make_pull_request(), prof.path()).unwrap();
        assert!(result.module_scripts.is_empty());
        assert!(result.notebooks.is_empty());
    }

    /// A malicious/compromised publisher controls the notebook bytes AND signs
    /// the manifest, so a hand-forged notebook with populated execution output
    /// passes the Ed25519 signature + SHA-256 integrity gates. The pull-time
    /// strip must still neutralize it so the subscriber is never shown fabricated
    /// "execution output" as if it were their own genuine run.
    #[test]
    fn pull_strips_forged_notebook_exec_metadata_from_a_signed_malicious_package() {
        use calcula_format::features::notebooks::{NotebookCellDef, NotebookDef, NotebookOutputItemDef};
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();

        // Publish a package carrying one (clean) notebook.
        let mut wb = make_test_workbook();
        wb.notebooks = vec![SavedNotebook {
            id: "nb-evil".to_string(),
            name: "Report".to_string(),
            cells: vec![persistence::SavedNotebookCell {
                id: "c1".to_string(),
                source: "1 + 1".to_string(),
                last_output: Vec::new(),
                last_error: None,
                cells_modified: 0,
                duration_ms: 0,
                execution_index: None,
            }],
            source_package: None,
        }];
        let request = PublishRequest {
            model_writebacks: None,
            workbook: &wb,
            package_name: "evil-pkg".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            sheet_indices: vec![0, 1],
            now: "2026-05-18T00:00:00Z".to_string(),
            published_by: "attacker".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments: false,
            min_app_version: String::new(),
        };
        publish::publish(&reg, &request, prof.path()).unwrap();

        // Forge the on-disk notebook: populate cached output + an execution_index
        // (which would make the cell render as a genuine "executed" cell), then
        // recompute the checksum and re-sign the manifest — a publisher with the
        // signing key can do all of this.
        let ver_dir = reg.version_dir("evil-pkg", "1.0.0").unwrap();
        let forged = NotebookDef {
            id: "nb-evil".to_string(),
            name: "Report".to_string(),
            cells: vec![NotebookCellDef {
                id: "c1".to_string(),
                source: "1 + 1".to_string(),
                last_output: vec![NotebookOutputItemDef::Text {
                    text: "All checks passed".to_string(),
                }],
                last_error: Some("phishing".to_string()),
                cells_modified: 9,
                duration_ms: 42,
                execution_index: Some(7),
            }],
            // Also try to forge a different package's attribution.
            source_package: Some("trusted-other-pkg".to_string()),
        };
        fs::write(
            ver_dir.join("notebooks").join("nb-evil.json"),
            serde_json::to_string_pretty(&forged).unwrap(),
        )
        .unwrap();
        let mut manifest = reg.get_version_manifest("evil-pkg", "1.0.0").unwrap();
        manifest.artifact_checksums = crate::integrity::compute_artifact_checksums(&ver_dir).unwrap();
        reg.write_version_manifest("evil-pkg", "1.0.0", &manifest).unwrap();
        resign_manifest(&reg, prof.path(), "evil-pkg", "1.0.0");

        // The pull passes the (now-consistent) gates, but the forged metadata is
        // stripped defensively at pull.
        let pull_req = PullRequest {
            package_name: "evil-pkg".to_string(),
            registry_url: format!("file://{}", dir.path().display()),
            version_pin: VersionPin::Exact(SemVer::new(1, 0, 0)),
            now: "2026-05-18T01:00:00Z".to_string(),
        };
        let result = pull(&reg, &pull_req, prof.path()).unwrap();

        assert_eq!(result.notebooks.len(), 1);
        // Provenance is re-stamped with the ACTUAL package on pull, overriding the
        // publisher's forged "trusted-other-pkg" attribution.
        assert_eq!(result.notebooks[0].source_package.as_deref(), Some("evil-pkg"));
        let cell = &result.notebooks[0].cells[0];
        assert_eq!(cell.source, "1 + 1", "the real payload (source) must survive");
        assert!(cell.last_output.is_empty(), "forged last_output must be stripped at pull");
        assert!(cell.last_error.is_none(), "forged last_error must be stripped at pull");
        assert_eq!(cell.cells_modified, 0);
        assert_eq!(cell.duration_ms, 0);
        assert!(cell.execution_index.is_none(), "forged execution_index must be stripped at pull");
    }

    // --- Signature + TOFU tests (S5 phase 2) ---

    #[test]
    fn pull_fails_on_tampered_manifest() {
        // Tampering the manifest itself breaks the signature, which the
        // ORIGIN gate (running before the integrity gate) catches.
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        publish_test_package(&reg, prof.path());

        // Tamper the manifest CONTENT while keeping it valid JSON (so it still
        // deserializes and we reach the signature gate, not a parse error).
        // Changing a value byte changes the signed bytes -> signature mismatch.
        let manifest_path = reg
            .version_dir("test-pkg", "1.0.0")
            .unwrap()
            .join(crate::integrity::VERSION_MANIFEST_FILE);
        let text = fs::read_to_string(&manifest_path).unwrap();
        let tampered = text.replace("\"tester\"", "\"hacker\"");
        assert_ne!(tampered, text, "expected to find the published_by value to tamper");
        fs::write(&manifest_path, tampered).unwrap();

        let err = expect_pull_err(&reg, &make_pull_request(), prof.path());
        assert!(matches!(err, CalpError::ManifestSignatureInvalid { .. }), "got {:?}", err);
        assert!(err.to_string().contains("test-pkg@1.0.0"));
    }

    #[test]
    fn pull_fails_when_signature_missing() {
        // No backward compat: a package without a signature is rejected.
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        publish_test_package(&reg, prof.path());

        fs::remove_file(
            reg.version_dir("test-pkg", "1.0.0")
                .unwrap()
                .join(crate::integrity::VERSION_MANIFEST_SIG_FILE),
        )
        .unwrap();

        let err = expect_pull_err(&reg, &make_pull_request(), prof.path());
        assert!(matches!(err, CalpError::MissingSignature { .. }), "got {:?}", err);
        assert!(err.to_string().contains("not signed"));
    }

    #[test]
    fn tofu_first_use_then_verified_on_second_pull() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        publish_test_package(&reg, prof.path());

        // First pull pins the publisher key.
        let first = pull(&reg, &make_pull_request(), prof.path()).unwrap();
        assert_eq!(first.trust_status, TrustStatus::FirstUse);

        // Second pull (same package, same key) verifies against the pin.
        let second = pull(&reg, &make_pull_request(), prof.path()).unwrap();
        assert_eq!(second.trust_status, TrustStatus::Verified);
    }

    #[test]
    fn tofu_rejects_different_publisher_key_for_same_package() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        publish_test_package(&reg, prof.path());

        // First pull pins publisher A's key.
        let first = pull(&reg, &make_pull_request(), prof.path()).unwrap();
        assert_eq!(first.trust_status, TrustStatus::FirstUse);

        // Re-sign the SAME package with a DIFFERENT publisher (key B) — as a
        // registry attacker who controls the manifest would. We swap in B's
        // public key and a valid B-signature so the crypto check passes but
        // the key differs from the pin.
        let prof_b = TempDir::new().unwrap();
        let kp_b = crate::signing::PublisherKeypair::load_or_create(prof_b.path()).unwrap();
        let mut ver = reg.get_version_manifest("test-pkg", "1.0.0").unwrap();
        ver.publisher_key = kp_b.public_key_hex();
        ver.publisher_name = "attacker".to_string();
        reg.write_version_manifest("test-pkg", "1.0.0", &ver).unwrap();
        let manifest_bytes = fs::read(
            reg.version_dir("test-pkg", "1.0.0")
                .unwrap()
                .join(crate::integrity::VERSION_MANIFEST_FILE),
        )
        .unwrap();
        fs::write(
            reg.version_dir("test-pkg", "1.0.0")
                .unwrap()
                .join(crate::integrity::VERSION_MANIFEST_SIG_FILE),
            kp_b.sign(&manifest_bytes),
        )
        .unwrap();

        // The signature is cryptographically valid (for B), but B != the
        // pinned key A -> PublisherKeyChanged.
        let err = expect_pull_err(&reg, &make_pull_request(), prof.path());
        assert!(matches!(err, CalpError::PublisherKeyChanged { .. }), "got {:?}", err);
        let msg = err.to_string();
        assert!(msg.contains("changed since first use"), "msg: {}", msg);
    }
}
