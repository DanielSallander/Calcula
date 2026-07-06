//! FILENAME: core/calp/src/publish.rs
//! PURPOSE: Publish a workbook's selected sheets as a .calp package version.
//! CONTEXT: The author selects sheets to publish, specifies a version, and
//! the content is written to the registry as an immutable version directory.

use std::path::Path;

use identity::{EntityId, SheetId};
use persistence::{SavedCell, SavedTable, SavedObjectScript, SavedScript, SavedNotebook, SavedChart, SavedSparkline, Workbook};

use crate::error::CalpError;
use crate::manifest::*;
use crate::signing::PublisherKeypair;
use crate::transport::RegistryTransport;
use crate::version::SemVer;

/// A data source to embed in the published package.
pub struct PublishDataSource {
    pub id: String,
    pub name: String,
    pub connection_type: String,
    pub server: String,
    pub database: String,
    /// The BI DataModel as JSON (will be written to models/{id}/model.json).
    pub model_json: serde_json::Value,
    pub bindings: Vec<PackageBinding>,
}

/// A rectangular region of cells to exclude from published sheet data.
/// Used to strip pivot output cells (which are recalculated by subscribers).
pub struct ExcludedRegion {
    /// The sheet ID this exclusion applies to.
    pub sheet_id: identity::SheetId,
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
}

/// Request to publish selected sheets from a workbook.
pub struct PublishRequest<'a> {
    pub workbook: &'a Workbook,
    pub package_name: String,
    pub version: SemVer,
    pub kind: String,
    /// Which sheets to publish (by index into workbook.sheets).
    pub sheet_indices: Vec<usize>,
    pub now: String,
    pub published_by: String,
    /// Writeback region declarations to include in the manifest.
    pub writeback_regions: Option<Vec<crate::writeback::WritebackRegionDeclaration>>,
    /// Object scripts to include in the package.
    /// If None, all workbook object scripts are published.
    pub object_scripts: Option<Vec<SavedObjectScript>>,
    /// Standalone module scripts to include in the package (C8).
    /// If None, all workbook module scripts (`workbook.scripts`) are published;
    /// Some means exactly these. Distributed inert — never auto-executed.
    pub module_scripts: Option<Vec<SavedScript>>,
    /// Standalone notebooks to include in the package (C8).
    /// If None, all workbook notebooks (`workbook.notebooks`) are published;
    /// Some means exactly these. Execution metadata is stripped at write time.
    pub notebooks: Option<Vec<SavedNotebook>>,
    /// Data source definitions to embed in the package for live data.
    pub data_sources: Vec<PublishDataSource>,
    /// Cell regions to exclude from published sheet data (e.g., pivot output).
    /// These regions are recalculated by subscribers from the source definition.
    pub excluded_regions: Vec<ExcludedRegion>,
    /// Generic custom objects to carry in the package (distribution brick 4) —
    /// the open channel for object families beyond the built-in set. Each is
    /// written as an opaque-JSON artifact under `custom_objects/{kind}/{id}.json`
    /// and listed in the manifest. Built-in producers (cell types) and
    /// third-party providers both feed this.
    pub custom_objects: Vec<PublishCustomObject>,
}

/// A custom object to publish (distribution brick 4). `payload` is opaque
/// app-owned JSON the publisher's producer supplies; the .calp layer only
/// stores + checksums it and records the manifest entry.
pub struct PublishCustomObject {
    pub kind: String,
    pub id: String,
    pub name: String,
    /// For per-sheet objects: the package sheet id (remapped on pull). None =
    /// workbook-scoped.
    pub sheet_id: Option<SheetId>,
    pub payload: serde_json::Value,
}

/// Result of a publish operation.
pub struct PublishResult {
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
    /// Charts on the published sheets.
    pub charts_published: usize,
    /// Sparkline sheet-entries on the published sheets.
    pub sparklines_published: usize,
    /// Pivot definitions carried by the package.
    pub pivots_published: usize,
    /// Sheets that carried conditional-formatting rules.
    pub conditional_format_sheets: usize,
    /// Sheets that carried data-validation ranges.
    pub data_validation_sheets: usize,
    /// Sheets that carried cell-anchored controls (buttons/checkboxes).
    pub control_sheets_published: usize,
    /// Pane controls (Controls pane) carried by the package (workbook-scoped).
    pub pane_controls_published: usize,
    /// Embedded BI data-source models.
    pub data_sources_published: usize,
    /// Writeback region declarations in the manifest.
    pub writeback_regions_published: usize,
    /// Publish-time disclosure warnings (fidelity-matrix approach): conditions
    /// that do NOT change the artifact but will degrade for subscribers —
    /// e.g. a dropdown pane control whose CellRange item source references a
    /// sheet outside the published selection (the pulled dropdown dangles).
    pub warnings: Vec<String>,
}

/// The sheet-name prefix of an A1-style range reference:
/// `"Data!A1:A10"` -> `Some("Data")`, `"'My Sheet'!A1"` -> `Some("My Sheet")`
/// (quoted names unescape the doubled-quote convention), `"A1:A10"` -> `None`
/// (no prefix — the reference is active-sheet-relative).
fn reference_sheet_name(reference: &str) -> Option<String> {
    let reference = reference.trim();
    if let Some(rest) = reference.strip_prefix('\'') {
        // Quoted sheet name: scan to the closing quote ('' escapes a quote),
        // which must be immediately followed by '!'.
        let mut name = String::new();
        let mut chars = rest.chars().peekable();
        while let Some(c) = chars.next() {
            if c != '\'' {
                name.push(c);
            } else if chars.peek() == Some(&'\'') {
                chars.next();
                name.push('\'');
            } else {
                return match chars.next() {
                    Some('!') => Some(name),
                    _ => None, // malformed quote-then-no-'!' — treat as prefix-less
                };
            }
        }
        None // unterminated quote — treat as prefix-less
    } else {
        reference.find('!').map(|i| reference[..i].to_string())
    }
}

/// Disclosure-only dropdown-reference check (fidelity-matrix approach): a
/// dropdown pane control whose items come from a CellRange ships its
/// reference VERBATIM — the artifact is never rewritten. When the referenced
/// sheet is not in the published selection the pulled dropdown dangles (no
/// items) on the subscriber, and a prefix-less reference resolves against
/// whichever sheet is active there. Both surface as warnings so the author
/// learns at publish time instead of the subscriber at pull time.
///
/// Factored out of `publish` so callers (e.g. the app's publish PREVIEW) can
/// compute the SAME warnings without writing any artifact. Controls are
/// visited in the published artifact's (order, id) ordering, so warning order
/// matches a real publish. Out-of-range sheet indices are ignored here
/// (`publish` validates them separately; the preview path is tolerant).
pub fn dropdown_reference_warnings(workbook: &Workbook, sheet_indices: &[usize]) -> Vec<String> {
    let published_sheet_names: std::collections::HashSet<&str> = sheet_indices
        .iter()
        .filter_map(|&idx| workbook.sheets.get(idx).map(|s| s.name.as_str()))
        .collect();
    let mut controls: Vec<&persistence::SavedPaneControl> =
        workbook.pane_controls.iter().collect();
    controls.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));

    let mut warnings: Vec<String> = Vec::new();
    for control in controls {
        if control.control_type != "dropdown" {
            continue;
        }
        // Config is an opaque app-owned payload here; probe only the
        // documented dropdown CellRange shape and stay silent otherwise.
        let source = control.config.get("source");
        let is_cell_range =
            source.and_then(|s| s.get("type")).and_then(|t| t.as_str()) == Some("cellRange");
        if !is_cell_range {
            continue;
        }
        let Some(reference) = source
            .and_then(|s| s.get("reference"))
            .and_then(|r| r.as_str())
        else {
            continue;
        };
        match reference_sheet_name(reference) {
            Some(sheet_name) if published_sheet_names.contains(sheet_name.as_str()) => {}
            Some(sheet_name) => warnings.push(format!(
                "Dropdown pane control \"{}\" reads its items from \"{}\", but sheet \"{}\" is not in the published selection — the dropdown will arrive with no items.",
                control.name, reference, sheet_name
            )),
            None => warnings.push(format!(
                "Dropdown pane control \"{}\" reads its items from \"{}\" without a sheet prefix — on the subscriber it resolves against whichever sheet is active and may not find the intended data.",
                control.name, reference
            )),
        }
    }
    warnings
}

/// Publish selected sheets from a workbook to a local registry.
///
/// `profile_dir` is the per-user profile directory holding the publisher's
/// Ed25519 keypair (`publisher-key.json`, created on first publish). The
/// version manifest carries the publisher's public key, and its raw on-disk
/// bytes are signed into a detached `version-manifest.sig` (S5 phase 2).
pub fn publish(
    registry: &dyn RegistryTransport,
    request: &PublishRequest,
    profile_dir: &Path,
) -> Result<PublishResult, CalpError> {
    let version_str = request.version.to_string();

    // Load (or create on first publish) the publisher's signing identity.
    // Generated with the OS CSPRNG inside PublisherKeypair::load_or_create.
    let keypair = PublisherKeypair::load_or_create(profile_dir)?;

    if registry.version_exists(&request.package_name, &version_str) {
        return Err(CalpError::VersionAlreadyPublished {
            package: request.package_name.clone(),
            version: version_str,
        });
    }

    for &idx in &request.sheet_indices {
        if idx >= request.workbook.sheets.len() {
            return Err(CalpError::SheetNotFound(format!("index {}", idx)));
        }
    }

    let published_sheet_ids: Vec<_> = request.sheet_indices.iter()
        .map(|&idx| request.workbook.sheets[idx].id)
        .collect();

    // Build version manifest
    let sheets: Vec<PublishedSheet> = request.sheet_indices.iter().map(|&idx| {
        let sheet = &request.workbook.sheets[idx];
        PublishedSheet {
            sheet_id: sheet.id,
            name: sheet.name.clone(),
            description: String::new(),
            extra: std::collections::HashMap::new(),
        }
    }).collect();

    let named_ranges: Vec<PublishedNamedRange> = request.workbook.named_ranges.iter()
        .filter(|nr| match nr.sheet_id {
            None => true,
            Some(sid) => published_sheet_ids.contains(&sid),
        })
        .map(|nr| PublishedNamedRange {
            name: nr.name.clone(),
            refers_to: nr.refers_to.clone(),
            sheet_id: nr.sheet_id,
            extra: std::collections::HashMap::new(),
        })
        .collect();

    let published_tables: Vec<&SavedTable> = request.workbook.tables.iter()
        .filter(|t| published_sheet_ids.contains(&t.sheet_id))
        .collect();
    let table_ids: Vec<EntityId> = published_tables.iter().map(|t| t.id).collect();

    // Collect object scripts to publish
    let scripts_to_publish: Vec<&SavedObjectScript> = match &request.object_scripts {
        Some(scripts) => scripts.iter().collect(),
        None => request.workbook.object_scripts.iter().collect(),
    };

    let published_scripts: Vec<PublishedObjectScript> = scripts_to_publish.iter().map(|s| {
        PublishedObjectScript {
            id: s.id.clone(),
            name: s.name.clone(),
            object_type: format!("{:?}", s.object_type).to_lowercase(),
            instance_id: s.instance_id.clone(),
            description: s.description.clone(),
            // R19: the publisher's declared ceiling for this script, lifted
            // from its source pragmas. This is what the package's scripts may
            // use; the subscriber's pull sets each script's ceiling from this.
            capabilities: persistence::parse_declared_capabilities(&s.source),
        }
    }).collect();

    // Collect standalone module scripts to publish (C8). Override-or-all,
    // mirroring object_scripts. These are inert, transparent data.
    let modules_to_publish: Vec<&SavedScript> = match &request.module_scripts {
        Some(scripts) => scripts.iter().collect(),
        None => request.workbook.scripts.iter().collect(),
    };

    let published_modules: Vec<PublishedModuleScript> = modules_to_publish.iter().map(|s| {
        PublishedModuleScript {
            id: s.id.clone(),
            name: s.name.clone(),
            // Discriminated so a sheet literally named "workbook" can't be
            // confused with workbook-global scope in the pre-pull review surface.
            // (The authoritative scope still round-trips via the artifact's
            // tagged ScriptScopeDef; this manifest string is display-only.)
            scope: match &s.scope {
                persistence::SavedScriptScope::Workbook => "workbook".to_string(),
                persistence::SavedScriptScope::Sheet { name } => format!("sheet:{}", name),
            },
            description: s.description.clone(),
        }
    }).collect();

    // Collect standalone notebooks to publish (C8). Override-or-all.
    let notebooks_to_publish: Vec<&SavedNotebook> = match &request.notebooks {
        Some(notebooks) => notebooks.iter().collect(),
        None => request.workbook.notebooks.iter().collect(),
    };

    let published_notebooks: Vec<PublishedNotebook> = notebooks_to_publish.iter().map(|n| {
        PublishedNotebook {
            id: n.id.clone(),
            name: n.name.clone(),
            cell_count: n.cells.len(),
            description: None,
        }
    }).collect();

    // Generic custom objects (brick 4): index-based artifact paths avoid any
    // path-injection from extension-supplied kind/id while keeping ids unique.
    let published_custom_objects: Vec<PublishedCustomObject> = request
        .custom_objects
        .iter()
        .enumerate()
        .map(|(i, co)| PublishedCustomObject {
            kind: co.kind.clone(),
            id: co.id.clone(),
            name: co.name.clone(),
            sheet_id: co.sheet_id,
            payload_path: format!("custom_objects/{i}.json"),
            extra: std::collections::HashMap::new(),
        })
        .collect();

    let mut version_manifest = VersionManifest {
        format_version: 1,
        package_name: request.package_name.clone(),
        version: version_str.clone(),
        kind: request.kind.clone(),
        published_at: request.now.clone(),
        published_by: request.published_by.clone(),
        // S5 phase 2: the asserted signer. publisher_key is what the
        // subscriber verifies against; publisher_name is display-only.
        publisher_key: keypair.public_key_hex(),
        publisher_name: keypair.display_name(),
        // Opt-in publisher minimum-app-version (publisher UX to set it is a
        // later slice); empty = no minimum.
        min_app_version: String::new(),
        sheets,
        named_ranges: named_ranges.clone(),
        tables: table_ids,
        locked_sheets: Vec::new(),
        locked_cells: Vec::new(),
        writeback_regions: request.writeback_regions.clone(),
        object_scripts: published_scripts,
        module_scripts: published_modules,
        notebooks: published_notebooks,
        data_sources: request.data_sources.iter().map(|ds| PackageDataSource {
            id: ds.id.clone(),
            name: ds.name.clone(),
            connection_type: ds.connection_type.clone(),
            server: ds.server.clone(),
            database: ds.database.clone(),
            model_path: format!("models/{}/model.json", ds.id),
            bindings: ds.bindings.clone(),
            extra: std::collections::HashMap::new(),
        }).collect(),
        custom_objects: published_custom_objects,
        // Filled in below, after all artifacts are on disk in final form.
        artifact_checksums: std::collections::BTreeMap::new(),
        extra: std::collections::HashMap::new(),
    };

    // The version manifest is written LAST (it is the integrity root and the
    // publish commit point — version_exists() keys off it). If the version
    // already has artifacts without a manifest, that is debris from a crashed
    // earlier publish: clear it so stale files can't end up unlisted in the
    // checksum map. Through the transport, never the filesystem directly.
    let pkg = request.package_name.as_str();
    let ver = version_str.as_str();
    registry.clear_version(pkg, ver)?;

    // Write generic custom-object payloads (brick 4). Opaque JSON; the .calp
    // layer stores + checksums but never interprets them.
    for (i, co) in request.custom_objects.iter().enumerate() {
        registry.write_artifact(
            pkg,
            ver,
            &format!("custom_objects/{i}.json"),
            serde_json::to_string_pretty(&co.payload)?.as_bytes(),
        )?;
    }

    // Write sheet data (cells, styles, layout as JSON)
    for &idx in &request.sheet_indices {
        let sheet = &request.workbook.sheets[idx];
        // Version-relative artifact prefix for this sheet (forward slashes — the
        // manifest checksum-key convention). sheet.id is a path-safe UUID v7.
        let sheet_prefix = format!("sheets/{}", sheet.id);

        // Filter out cells in excluded regions (e.g., pivot output areas).
        // These cells are recalculated by subscribers from the pivot definition.
        let exclusions: Vec<&ExcludedRegion> = request.excluded_regions.iter()
            .filter(|r| r.sheet_id == sheet.id)
            .collect();

        let cells = if exclusions.is_empty() {
            std::borrow::Cow::Borrowed(&sheet.cells)
        } else {
            let filtered: std::collections::HashMap<(u32, u32), SavedCell> = sheet.cells.iter()
                .filter(|(&(row, col), _)| {
                    !exclusions.iter().any(|r|
                        row >= r.start_row && row <= r.end_row &&
                        col >= r.start_col && col <= r.end_col
                    )
                })
                .map(|(&k, v)| (k, v.clone()))
                .collect();
            std::borrow::Cow::Owned(filtered)
        };

        // Cell data
        let cell_data = calcula_format::sheet_data::cells_to_sheet_data(&cells);
        registry.write_artifact(
            pkg, ver,
            &format!("{sheet_prefix}/data.json"),
            serde_json::to_string_pretty(&cell_data)?.as_bytes(),
        )?;

        // Styles registry (the sheet's Vec<CellStyle>, indexed by style_index).
        registry.write_artifact(
            pkg, ver,
            &format!("{sheet_prefix}/styles.json"),
            serde_json::to_string_pretty(&sheet.styles)?.as_bytes(),
        )?;

        // Per-cell style assignments (A1 -> style index). data.json does NOT
        // carry style_index (it is always 0 there), so without this companion
        // map the registry above could never be re-associated with cells and
        // all per-cell formatting would be lost on the consuming side (subscriber
        // refresh, HTML export). Only written when there are non-default styles,
        // mirroring named_ranges.json. Uses the (possibly region-filtered) cells.
        let cell_styles = calcula_format::sheet_styles::cells_to_sheet_styles(&cells);
        if !cell_styles.cells.is_empty() {
            registry.write_artifact(
                pkg, ver,
                &format!("{sheet_prefix}/cell_styles.json"),
                serde_json::to_string_pretty(&cell_styles)?.as_bytes(),
            )?;
        }

        // Layout (column widths + row heights as simple JSON)
        let layout = calcula_format::sheet_layout::SheetLayout::from_dimensions(
            &sheet.column_widths,
            &sheet.row_heights,
        );
        registry.write_artifact(
            pkg, ver,
            &format!("{sheet_prefix}/layout.json"),
            serde_json::to_string_pretty(&layout)?.as_bytes(),
        )?;

        // Presentation metadata (D9): merged regions, freeze panes, hidden
        // rows/cols, tab color, visibility, notes, hyperlinks, page setup,
        // gridlines. Written before the manifest, so the integrity walk
        // checksums it and pull restores it instead of dropping it.
        let metadata = crate::manifest::PublishedSheetMetadata::from_sheet(sheet);
        registry.write_artifact(
            pkg, ver,
            &format!("{sheet_prefix}/metadata.json"),
            serde_json::to_string_pretty(&metadata)?.as_bytes(),
        )?;
    }

    // Write tables
    for table in &published_tables {
        registry.write_artifact(
            pkg, ver,
            &format!("tables/{}.json", table.id),
            serde_json::to_string_pretty(table)?.as_bytes(),
        )?;
    }

    // Write named ranges
    if !named_ranges.is_empty() {
        registry.write_artifact(
            pkg, ver,
            "named_ranges.json",
            serde_json::to_string_pretty(&named_ranges)?.as_bytes(),
        )?;
    }

    // Write charts on the published sheets, carried so subscribers see them
    // in-app (pull remaps each chart's sheet id to the new local sheet).
    let published_charts: Vec<&SavedChart> = request
        .workbook
        .charts
        .iter()
        .filter(|c| published_sheet_ids.contains(&c.sheet_id))
        .collect();
    if !published_charts.is_empty() {
        registry.write_artifact(
            pkg, ver,
            "charts.json",
            serde_json::to_string_pretty(&published_charts)?.as_bytes(),
        )?;
    }

    // Write sparklines on the published sheets (C2a) — same shape as charts:
    // sheet-keyed, opaque groups_json with only in-sheet coords, so pull remaps
    // each entry's sheet id to the new local sheet. Written before the manifest
    // so the integrity walk checksums it and the signature seals it.
    let published_sparklines: Vec<&SavedSparkline> = request
        .workbook
        .sparklines
        .iter()
        .filter(|s| published_sheet_ids.contains(&s.sheet_id))
        .collect();
    if !published_sparklines.is_empty() {
        registry.write_artifact(
            pkg, ver,
            "sparklines.json",
            serde_json::to_string_pretty(&published_sparklines)?.as_bytes(),
        )?;
    }

    // Write conditional formatting + data validation on the published sheets.
    // The Workbook carrier (build_workbook_snapshot) already holds them per-sheet,
    // keyed by SheetId with opaque app payloads; filter to published sheets and
    // write as artifacts (pull remaps each entry's sheet id to the local sheet).
    let published_conditional_formats: Vec<_> = request
        .workbook
        .conditional_formats
        .iter()
        .filter(|c| published_sheet_ids.contains(&c.sheet_id))
        .collect();
    if !published_conditional_formats.is_empty() {
        registry.write_artifact(
            pkg, ver,
            "conditional_formats.json",
            serde_json::to_string_pretty(&published_conditional_formats)?.as_bytes(),
        )?;
    }
    let published_data_validations: Vec<_> = request
        .workbook
        .data_validations
        .iter()
        .filter(|d| published_sheet_ids.contains(&d.sheet_id))
        .collect();
    if !published_data_validations.is_empty() {
        registry.write_artifact(
            pkg, ver,
            "data_validations.json",
            serde_json::to_string_pretty(&published_data_validations)?.as_bytes(),
        )?;
    }

    // Write cell-anchored controls (buttons/checkboxes — onSelect wiring,
    // formula-driven properties) on the published sheets. Same per-sheet
    // opaque-payload shape as CF/DV; pull remaps each entry's sheet id to the
    // local sheet. The scripts a control references travel separately as
    // object_scripts (consent-gated); this carries the HOST so a shipped
    // script no longer arrives orphaned.
    let published_controls: Vec<_> = request
        .workbook
        .controls
        .iter()
        .filter(|c| published_sheet_ids.contains(&c.sheet_id))
        .collect();
    if !published_controls.is_empty() {
        registry.write_artifact(
            pkg, ver,
            "controls.json",
            serde_json::to_string_pretty(&published_controls)?.as_bytes(),
        )?;
    }

    // Write pane controls (Controls pane) — WORKBOOK-scoped like pivot
    // definitions, not filtered per sheet: the pane strip belongs to the
    // workbook, so a report package carries all of it. Sorted by (order, id)
    // for deterministic artifact bytes across publishes (stable checksums +
    // blob dedup), matching collect_pane_controls_for_save's .cala ordering.
    //
    // No sanitization needed (D6, deliberate contrast with on-grid controls'
    // stripped onSelect): pane-control configs contain NO inline code by
    // design. A custom control's script is a normal object script
    // (instanceId "pane-{controlId}") and a pane button's click behavior is an
    // objectType "button" object script — both ship separately via
    // object_scripts/ above, where pull forces Restricted/Distributed and the
    // subscriber's consent gate governs mounting.
    let published_pane_controls = {
        let mut controls = request.workbook.pane_controls.clone();
        controls.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
        controls
    };
    if !published_pane_controls.is_empty() {
        registry.write_artifact(
            pkg, ver,
            "pane_controls.json",
            serde_json::to_string_pretty(&published_pane_controls)?.as_bytes(),
        )?;
    }

    // Disclosure-only dropdown-reference check — shared with the app's
    // publish preview via `dropdown_reference_warnings` (which re-derives the
    // artifact's (order, id) ordering, so the warnings match the
    // published_pane_controls written above).
    let warnings = dropdown_reference_warnings(request.workbook, &request.sheet_indices);

    // Write object scripts
    if !scripts_to_publish.is_empty() {
        for script in &scripts_to_publish {
            let mut def = calcula_format::features::object_scripts::ObjectScriptDef::from(*script);
            // Packages ship provenance-clean: the subscriber stamps
            // provenance at pull time. This also covers re-publishing a
            // workbook that itself contains pulled (distributed) scripts.
            def.provenance = Default::default();
            def.package_name = None;
            registry.write_artifact(
                pkg, ver,
                &format!("object_scripts/{}.json", script.id),
                serde_json::to_string_pretty(&def)?.as_bytes(),
            )?;
        }
    }

    // Write standalone module scripts (C8) as modules/{id}.json using the
    // calcula-format ScriptDef (camelCase). Module scripts are inert,
    // transparent data — distributed as-is, no provenance/access-level/
    // capability stamping. Written BEFORE the manifest so the integrity walk
    // checksums them and the Ed25519 signature seals them.
    if !modules_to_publish.is_empty() {
        for script in &modules_to_publish {
            let mut def = calcula_format::features::scripts::ScriptDef::from(*script);
            // Clear any distribution provenance: the SUBSCRIBER stamps this with
            // the new package name on pull. A publisher who in turn subscribed to
            // some upstream package must not leak that upstream attribution.
            def.source_package = None;
            registry.write_artifact(
                pkg, ver,
                &format!("modules/{}.json", script.id),
                serde_json::to_string_pretty(&def)?.as_bytes(),
            )?;
        }
    }

    // Write standalone notebooks (C8) as notebooks/{id}.json using the
    // calcula-format NotebookDef (camelCase). Execution metadata is STRIPPED:
    // last_output/last_error/cells_modified/duration_ms/execution_index are
    // zeroed so cached output can never leak in a published package — only
    // cell id + source ship. Written BEFORE the manifest so they are covered
    // by the integrity checksums and the Ed25519 signature.
    if !notebooks_to_publish.is_empty() {
        for notebook in &notebooks_to_publish {
            let mut def = calcula_format::features::notebooks::NotebookDef::from(*notebook);
            // Clear provenance (subscriber re-stamps on pull) + strip exec metadata.
            def.source_package = None;
            for cell in &mut def.cells {
                cell.last_output = Vec::new();
                cell.last_error = None;
                cell.cells_modified = 0;
                cell.duration_ms = 0;
                cell.execution_index = None;
            }
            registry.write_artifact(
                pkg, ver,
                &format!("notebooks/{}.json", notebook.id),
                serde_json::to_string_pretty(&def)?.as_bytes(),
            )?;
        }
    }

    // Write pivot definitions
    if !request.workbook.pivot_definitions.is_empty() {
        for pivot_def in &request.workbook.pivot_definitions {
            registry.write_artifact(
                pkg, ver,
                &format!("pivot_definitions/{}.json", pivot_def.id),
                serde_json::to_string_pretty(pivot_def)?.as_bytes(),
            )?;
        }
    }

    // Write BI pivot metadata (needed for BI-connected pivots)
    if !request.workbook.bi_pivot_metadata.is_empty() {
        registry.write_artifact(
            pkg, ver,
            "pivot_definitions/bi_metadata.json",
            serde_json::to_string_pretty(&request.workbook.bi_pivot_metadata)?.as_bytes(),
        )?;
    }

    // Write embedded data source models
    for ds in &request.data_sources {
        registry.write_artifact(
            pkg, ver,
            &format!("models/{}/model.json", ds.id),
            serde_json::to_string_pretty(&ds.model_json)?.as_bytes(),
        )?;
    }

    // All artifacts are on disk in final form: compute SHA-256 checksums over
    // the actual bytes via the transport, then write the version manifest LAST.
    // The manifest is the integrity root — it cannot contain its own hash, so it
    // covers all OTHER artifacts and is itself the commit point of the publish.
    version_manifest.artifact_checksums =
        crate::integrity::compute_artifact_checksums_via(registry, pkg, ver)?;
    // Org-scale dedup: move the just-written artifacts into the content-addressed
    // blob store (identical bytes across versions are stored once). The checksum
    // map computed above is unchanged, so the signed manifest — and integrity —
    // are unaffected; only WHERE the bytes live changes.
    registry.commit_artifacts_as_blobs(pkg, ver, &version_manifest.artifact_checksums)?;
    registry.write_version_manifest(pkg, ver, &version_manifest)?;

    // S5 phase 2: seal the integrity root. Sign the RAW bytes of
    // version-manifest.json AS WRITTEN (read it back via the transport —
    // re-serializing the in-memory manifest may not be byte-identical to what
    // write_version_manifest produced). The detached signature lands in the
    // sibling version-manifest.sig, completing the publish.
    let manifest_bytes = registry
        .read_artifact(pkg, ver, crate::integrity::VERSION_MANIFEST_FILE)?
        .ok_or_else(|| CalpError::Registry(format!(
            "version manifest missing immediately after write for {pkg}@{ver}"
        )))?;
    let signature_hex = keypair.sign(&manifest_bytes);
    registry.write_artifact(
        pkg, ver,
        crate::integrity::VERSION_MANIFEST_SIG_FILE,
        signature_hex.as_bytes(),
    )?;

    // Update the package manifest under the registry lock (D7): the version-list
    // read-modify-write must be serialized so a concurrent publish to the same
    // registry can't drop the other's version. The lock releases when `_lock`
    // drops at the end of this scope.
    {
        let _lock = registry.lock()?;
        let mut pkg_manifest = registry.get_package_manifest(&request.package_name)
            .unwrap_or_else(|_| PackageManifest::new(
                &request.package_name, &request.kind, &request.published_by, &request.now,
            ));

        pkg_manifest.versions.push(VersionEntry {
            version: version_str.clone(),
            published_at: request.now.clone(),
            published_by: request.published_by.clone(),
            extra: std::collections::HashMap::new(),
        });
        registry.write_package_manifest(&pkg_manifest)?;
    }

    Ok(PublishResult {
        package_name: request.package_name.clone(),
        version: version_str,
        sheets_published: request.sheet_indices.len(),
        tables_published: published_tables.len(),
        named_ranges_published: named_ranges.len(),
        scripts_published: scripts_to_publish.len(),
        modules_published: modules_to_publish.len(),
        notebooks_published: notebooks_to_publish.len(),
        charts_published: published_charts.len(),
        sparklines_published: published_sparklines.len(),
        pivots_published: request.workbook.pivot_definitions.len(),
        conditional_format_sheets: published_conditional_formats.len(),
        data_validation_sheets: published_data_validations.len(),
        control_sheets_published: published_controls.len(),
        pane_controls_published: published_pane_controls.len(),
        data_sources_published: request.data_sources.len(),
        writeback_regions_published: request
            .writeback_regions
            .as_ref()
            .map_or(0, |w| w.len()),
        warnings,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;
    use persistence::Sheet;
    use engine::cell::Cell;
    use crate::registry::LocalRegistry;

    fn make_test_workbook() -> Workbook {
        let mut sheet1 = Sheet::new("Dashboard".to_string());
        let cell = Cell::new_number(42.0);
        sheet1.cells.insert((0, 0), persistence::SavedCell::from_cell(&cell));

        let mut sheet2 = Sheet::new("Data".to_string());
        let cell2 = Cell::new_text("hello".to_string());
        sheet2.cells.insert((0, 0), persistence::SavedCell::from_cell(&cell2));

        let mut wb = Workbook::default();
        wb.sheets = vec![sheet1, sheet2];
        wb
    }

    /// A dropdown pane control with the given item `source` payload.
    fn dropdown_pane_control(name: &str, source: serde_json::Value) -> persistence::SavedPaneControl {
        persistence::SavedPaneControl {
            id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            name: name.to_string(),
            control_type: "dropdown".to_string(),
            config: serde_json::json!({ "type": "dropdown", "source": source, "placeholder": null }),
            value: serde_json::Value::Null,
            order: 0,
        }
    }

    #[test]
    fn reference_sheet_name_parses_prefixes() {
        assert_eq!(reference_sheet_name("Data!A1:A10"), Some("Data".to_string()));
        assert_eq!(reference_sheet_name("  Data!A1  "), Some("Data".to_string()));
        assert_eq!(reference_sheet_name("'My Sheet'!A1"), Some("My Sheet".to_string()));
        assert_eq!(reference_sheet_name("'It''s'!A1:B2"), Some("It's".to_string()));
        assert_eq!(reference_sheet_name("A1:A10"), None);
        assert_eq!(reference_sheet_name("'Unterminated"), None);
        assert_eq!(reference_sheet_name("'Quoted'NoBang"), None);
    }

    #[test]
    fn publish_warns_on_dangling_dropdown_cell_range_references() {
        // Disclosure-only (fidelity matrix): dropdown CellRange references
        // ship verbatim; a reference to a sheet OUTSIDE the published
        // selection (or with no sheet prefix at all) must surface a publish
        // warning while leaving the artifact byte-identical semantics-wise.
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();

        let mut wb = make_test_workbook(); // sheets: "Dashboard", "Data"
        wb.pane_controls = vec![
            // In-selection reference: silent.
            dropdown_pane_control(
                "Region",
                serde_json::json!({ "type": "cellRange", "reference": "Dashboard!A1:A5" }),
            ),
            // References the UNPUBLISHED "Data" sheet: warned.
            dropdown_pane_control(
                "Product",
                serde_json::json!({ "type": "cellRange", "reference": "Data!A1:A10" }),
            ),
            // Quoted form of the same unpublished sheet: warned (unquoted name).
            dropdown_pane_control(
                "Quarter",
                serde_json::json!({ "type": "cellRange", "reference": "'Data'!B1:B4" }),
            ),
            // No sheet prefix (active-sheet-relative): flagged too.
            dropdown_pane_control(
                "Channel",
                serde_json::json!({ "type": "cellRange", "reference": "A1:A3" }),
            ),
            // Static dropdowns never warn.
            dropdown_pane_control(
                "Mode",
                serde_json::json!({ "type": "static", "items": ["a", "b"] }),
            ),
        ];

        let request = PublishRequest {
            workbook: &wb,
            package_name: "dangle".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            sheet_indices: vec![0], // only "Dashboard" ships
            now: "2026-07-03T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
        };
        let result = publish(&reg, &request, prof.path()).unwrap();

        assert_eq!(result.pane_controls_published, 5);
        assert_eq!(result.warnings.len(), 3, "warnings: {:?}", result.warnings);
        let warned = result.warnings.join("\n");
        assert!(warned.contains("\"Product\"") && warned.contains("Data!A1:A10"), "{warned}");
        assert!(warned.contains("\"Quarter\"") && warned.contains("sheet \"Data\""), "{warned}");
        assert!(
            warned.contains("\"Channel\"") && warned.contains("without a sheet prefix"),
            "{warned}"
        );
        assert!(!warned.contains("\"Region\""), "{warned}");
        assert!(!warned.contains("\"Mode\""), "{warned}");

        // No behavior change to the artifact: the reference ships verbatim.
        let bytes = reg
            .read_artifact("dangle", "1.0.0", "pane_controls.json")
            .unwrap()
            .expect("pane_controls.json");
        let saved: Vec<persistence::SavedPaneControl> = serde_json::from_slice(&bytes).unwrap();
        assert!(saved
            .iter()
            .any(|c| c.config["source"]["reference"] == "Data!A1:A10"));
    }

    #[test]
    fn publish_with_covered_dropdown_references_emits_no_warnings() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();

        let mut wb = make_test_workbook();
        wb.pane_controls = vec![dropdown_pane_control(
            "Region",
            serde_json::json!({ "type": "cellRange", "reference": "Data!A1:A5" }),
        )];

        let request = PublishRequest {
            workbook: &wb,
            package_name: "covered".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            sheet_indices: vec![0, 1], // both sheets ship — "Data" is covered
            now: "2026-07-03T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
        };
        let result = publish(&reg, &request, prof.path()).unwrap();
        assert!(result.warnings.is_empty(), "warnings: {:?}", result.warnings);
    }

    #[test]
    fn dropdown_reference_warnings_computes_without_publishing() {
        // The preview contract: the SAME warnings a publish would emit,
        // computed from the carrier alone — no registry, no artifact writes.
        let mut wb = make_test_workbook(); // sheets: "Dashboard", "Data"
        wb.pane_controls = vec![
            dropdown_pane_control(
                "Region",
                serde_json::json!({ "type": "cellRange", "reference": "Dashboard!A1:A5" }),
            ),
            dropdown_pane_control(
                "Product",
                serde_json::json!({ "type": "cellRange", "reference": "Data!A1:A10" }),
            ),
            dropdown_pane_control(
                "Channel",
                serde_json::json!({ "type": "cellRange", "reference": "A1:A3" }),
            ),
        ];

        let warnings = dropdown_reference_warnings(&wb, &[0]); // only "Dashboard"
        assert_eq!(warnings.len(), 2, "warnings: {:?}", warnings);
        let joined = warnings.join("\n");
        assert!(joined.contains("\"Product\"") && joined.contains("sheet \"Data\""), "{joined}");
        assert!(joined.contains("\"Channel\"") && joined.contains("without a sheet prefix"), "{joined}");
        assert!(!joined.contains("\"Region\""), "{joined}");

        // Covering selection: the sheet-scoped warning clears; the
        // prefix-less "Channel" one is selection-independent and remains.
        let covered = dropdown_reference_warnings(&wb, &[0, 1]);
        assert_eq!(covered.len(), 1, "warnings: {:?}", covered);
        assert!(covered[0].contains("\"Channel\""), "{covered:?}");
        // Out-of-range indices are tolerated (the preview path never
        // validates them; publish does separately).
        assert_eq!(dropdown_reference_warnings(&wb, &[0, 99]).len(), 2);
    }

    #[test]
    fn publish_creates_package() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        let wb = make_test_workbook();

        let request = PublishRequest {
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
        };

        let result = publish(&reg, &request, prof.path()).unwrap();
        assert_eq!(result.sheets_published, 2);
        assert_eq!(result.version, "1.0.0");

        // Verify package manifest was created
        let pkg = reg.get_package_manifest("test-pkg").unwrap();
        assert_eq!(pkg.versions.len(), 1);
        assert_eq!(pkg.versions[0].version, "1.0.0");

        // Verify version manifest
        let ver = reg.get_version_manifest("test-pkg", "1.0.0").unwrap();
        assert_eq!(ver.sheets.len(), 2);
        assert_eq!(ver.sheets[0].name, "Dashboard");
        assert_eq!(ver.sheets[1].name, "Data");

        // S5 phase 2: the manifest carries the publisher's public key and a
        // detached signature file sits next to it.
        assert_eq!(ver.publisher_key.len(), 64, "publisher_key should be 32-byte hex");
        assert!(!ver.publisher_name.is_empty());
        let ver_dir = reg.version_dir("test-pkg", "1.0.0").unwrap();
        let sig_path = ver_dir.join(crate::integrity::VERSION_MANIFEST_SIG_FILE);
        assert!(sig_path.exists(), "version-manifest.sig must be written");
        // The signature verifies over the RAW on-disk manifest bytes.
        let manifest_bytes = fs::read(ver_dir.join(crate::integrity::VERSION_MANIFEST_FILE)).unwrap();
        let sig_hex = fs::read_to_string(&sig_path).unwrap();
        crate::signing::verify_signature(
            &ver.publisher_key, &manifest_bytes, sig_hex.trim(), "test-pkg", "1.0.0",
        ).unwrap();

        // Sheet artifacts are deduplicated into the content-addressed blob store
        // (not stored per-version), and remain retrievable via read_artifact.
        let sid = &wb.sheets[0].id;
        for name in ["data.json", "styles.json", "layout.json"] {
            let key = format!("sheets/{sid}/{name}");
            assert!(
                reg.read_artifact("test-pkg", "1.0.0", &key).unwrap().is_some(),
                "artifact {key} must be retrievable"
            );
        }
        // The per-version copy was moved out by dedup.
        let sheet_dir = reg.sheet_dir("test-pkg", "1.0.0", sid).unwrap();
        assert!(!sheet_dir.join("data.json").exists());
    }

    #[test]
    fn publish_selected_sheets_only() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        let wb = make_test_workbook();

        let request = PublishRequest {
            workbook: &wb,
            package_name: "partial".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            sheet_indices: vec![0], // Only Dashboard
            now: "2026-05-18T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            writeback_regions: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
        };

        let result = publish(&reg, &request, prof.path()).unwrap();
        assert_eq!(result.sheets_published, 1);

        let ver = reg.get_version_manifest("partial", "1.0.0").unwrap();
        assert_eq!(ver.sheets.len(), 1);
        assert_eq!(ver.sheets[0].name, "Dashboard");
    }

    #[test]
    fn publish_records_artifact_checksums() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        let wb = make_test_workbook();

        let request = PublishRequest {
            workbook: &wb,
            package_name: "checked".to_string(),
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
        };
        publish(&reg, &request, prof.path()).unwrap();

        let ver = reg.get_version_manifest("checked", "1.0.0").unwrap();

        // 2 sheets x (data.json + styles.json + layout.json + metadata.json)
        assert_eq!(ver.artifact_checksums.len(), 8);
        // The manifest is the integrity root: never lists itself.
        assert!(!ver.artifact_checksums.contains_key("version-manifest.json"));
        // The detached signature is likewise not a listed artifact.
        assert!(!ver.artifact_checksums.contains_key("version-manifest.sig"));

        // Keys are version-dir-relative with forward slashes; digests are
        // lowercase hex SHA-256 of the final on-disk bytes.
        let data_key = format!("sheets/{}/data.json", wb.sheets[0].id);
        let digest = ver.artifact_checksums.get(&data_key)
            .expect("data.json must be listed in artifact checksums");
        assert_eq!(digest.len(), 64);
        assert!(digest.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));

        let bytes = reg
            .read_artifact("checked", "1.0.0", &data_key)
            .unwrap()
            .expect("data.json must be retrievable from the blob store");
        assert_eq!(digest, &crate::integrity::sha256_hex(&bytes));
    }

    /// Count blob files in the registry's content-addressed store.
    fn count_blobs(root: &std::path::Path) -> usize {
        let blobs = root.join(".blobs");
        let mut n = 0;
        if let Ok(shards) = fs::read_dir(&blobs) {
            for shard in shards.flatten() {
                if let Ok(files) = fs::read_dir(shard.path()) {
                    n += files
                        .flatten()
                        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
                        .count();
                }
            }
        }
        n
    }

    #[test]
    fn publish_dedups_identical_artifacts_across_versions() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        let wb = make_test_workbook();

        // Publish two versions of the SAME workbook — the artifact bytes are
        // identical across versions (only the manifest differs).
        for v in [SemVer::new(1, 0, 0), SemVer::new(1, 0, 1)] {
            let request = PublishRequest {
                workbook: &wb,
                package_name: "dedup".to_string(),
                version: v,
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
            };
            publish(&reg, &request, prof.path()).unwrap();
        }

        let v1 = reg.get_version_manifest("dedup", "1.0.0").unwrap();
        let v2 = reg.get_version_manifest("dedup", "1.0.1").unwrap();
        let total_refs = v1.artifact_checksums.len() + v2.artifact_checksums.len();
        assert!(total_refs > 0);

        let mut unique: std::collections::HashSet<&String> = std::collections::HashSet::new();
        unique.extend(v1.artifact_checksums.values());
        unique.extend(v2.artifact_checksums.values());

        let blob_count = count_blobs(dir.path());
        // Dedup: identical bytes across versions are stored once, so fewer blobs
        // than total artifact references, exactly one blob per unique content.
        assert!(
            blob_count < total_refs,
            "expected dedup: {blob_count} blobs < {total_refs} refs"
        );
        assert_eq!(blob_count, unique.len(), "one blob per unique content hash");

        // Both versions still pull intact from the shared blob store.
        for ver in ["1.0.0", "1.0.1"] {
            let req = crate::pull::PullRequest {
                package_name: "dedup".to_string(),
                registry_url: format!("file://{}", dir.path().display()),
                version_pin: crate::version::VersionPin::Exact(
                    if ver == "1.0.0" { SemVer::new(1, 0, 0) } else { SemVer::new(1, 0, 1) },
                ),
                now: "2026-05-18T01:00:00Z".to_string(),
            };
            let result = crate::pull::pull(&reg, &req, prof.path()).unwrap();
            assert_eq!(result.sheets.len(), 2);
        }
    }

    #[test]
    fn publish_duplicate_version_fails() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        let wb = make_test_workbook();

        let request = PublishRequest {
            workbook: &wb,
            package_name: "dup".to_string(),
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
        };

        publish(&reg, &request, prof.path()).unwrap();
        let result = publish(&reg, &request, prof.path());
        assert!(matches!(result, Err(CalpError::VersionAlreadyPublished { .. })));
    }

    #[test]
    fn publish_multiple_versions() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        let wb = make_test_workbook();

        for (major, minor) in [(1, 0), (1, 1), (2, 0)] {
            let request = PublishRequest {
                workbook: &wb,
                package_name: "multi".to_string(),
                version: SemVer::new(major, minor, 0),
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
            };
            publish(&reg, &request, prof.path()).unwrap();
        }

        let pkg = reg.get_package_manifest("multi").unwrap();
        assert_eq!(pkg.versions.len(), 3);

        let versions = reg.list_versions("multi").unwrap();
        assert_eq!(versions, vec![
            SemVer::new(1, 0, 0),
            SemVer::new(1, 1, 0),
            SemVer::new(2, 0, 0),
        ]);
    }
}
