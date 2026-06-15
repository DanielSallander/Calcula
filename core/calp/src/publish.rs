//! FILENAME: core/calp/src/publish.rs
//! PURPOSE: Publish a workbook's selected sheets as a .calp package version.
//! CONTEXT: The author selects sheets to publish, specifies a version, and
//! the content is written to the registry as an immutable version directory.

use std::fs;
use std::path::Path;

use identity::EntityId;
use persistence::{SavedCell, SavedTable, SavedObjectScript, SavedScript, SavedNotebook, Workbook};

use crate::error::CalpError;
use crate::manifest::*;
use crate::registry::LocalRegistry;
use crate::signing::PublisherKeypair;
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
}

/// Publish selected sheets from a workbook to a local registry.
///
/// `profile_dir` is the per-user profile directory holding the publisher's
/// Ed25519 keypair (`publisher-key.json`, created on first publish). The
/// version manifest carries the publisher's public key, and its raw on-disk
/// bytes are signed into a detached `version-manifest.sig` (S5 phase 2).
pub fn publish(
    registry: &LocalRegistry,
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
        // Filled in below, after all artifacts are on disk in final form.
        artifact_checksums: std::collections::BTreeMap::new(),
        extra: std::collections::HashMap::new(),
    };

    // The version manifest is written LAST (it is the integrity root and the
    // publish commit point — version_exists() keys off it). If the version
    // directory already exists without a manifest, it is debris from a
    // crashed earlier publish: clear it so stale files can't end up unlisted
    // in the checksum map.
    let ver_dir = registry.version_dir(&request.package_name, &version_str);
    if ver_dir.exists() {
        fs::remove_dir_all(&ver_dir)?;
    }
    fs::create_dir_all(&ver_dir)?;

    // Write sheet data (cells, styles, layout as JSON)
    for &idx in &request.sheet_indices {
        let sheet = &request.workbook.sheets[idx];
        let sheet_dir = registry.sheet_dir(&request.package_name, &version_str, &sheet.id);
        fs::create_dir_all(&sheet_dir)?;

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
        fs::write(sheet_dir.join("data.json"), serde_json::to_string_pretty(&cell_data)?)?;

        // Styles
        fs::write(sheet_dir.join("styles.json"), serde_json::to_string_pretty(&sheet.styles)?)?;

        // Layout (column widths + row heights as simple JSON)
        let layout = calcula_format::sheet_layout::SheetLayout::from_dimensions(
            &sheet.column_widths,
            &sheet.row_heights,
        );
        fs::write(sheet_dir.join("layout.json"), serde_json::to_string_pretty(&layout)?)?;
    }

    // Write tables
    for table in &published_tables {
        let tables_dir = registry.tables_dir(&request.package_name, &version_str);
        fs::create_dir_all(&tables_dir)?;
        fs::write(
            tables_dir.join(format!("{}.json", table.id)),
            serde_json::to_string_pretty(table)?,
        )?;
    }

    // Write named ranges
    if !named_ranges.is_empty() {
        fs::write(
            ver_dir.join("named_ranges.json"),
            serde_json::to_string_pretty(&named_ranges)?,
        )?;
    }

    // Write object scripts
    if !scripts_to_publish.is_empty() {
        let scripts_dir = registry.scripts_dir(&request.package_name, &version_str);
        fs::create_dir_all(&scripts_dir)?;
        for script in &scripts_to_publish {
            let mut def = calcula_format::features::object_scripts::ObjectScriptDef::from(*script);
            // Packages ship provenance-clean: the subscriber stamps
            // provenance at pull time. This also covers re-publishing a
            // workbook that itself contains pulled (distributed) scripts.
            def.provenance = Default::default();
            def.package_name = None;
            fs::write(
                scripts_dir.join(format!("{}.json", script.id)),
                serde_json::to_string_pretty(&def)?,
            )?;
        }
    }

    // Write standalone module scripts (C8) as modules/{id}.json using the
    // calcula-format ScriptDef (camelCase). Module scripts are inert,
    // transparent data — distributed as-is, no provenance/access-level/
    // capability stamping. Written BEFORE the manifest so the integrity walk
    // checksums them and the Ed25519 signature seals them.
    if !modules_to_publish.is_empty() {
        let modules_dir = registry.modules_dir(&request.package_name, &version_str);
        fs::create_dir_all(&modules_dir)?;
        for script in &modules_to_publish {
            let mut def = calcula_format::features::scripts::ScriptDef::from(*script);
            // Clear any distribution provenance: the SUBSCRIBER stamps this with
            // the new package name on pull. A publisher who in turn subscribed to
            // some upstream package must not leak that upstream attribution.
            def.source_package = None;
            fs::write(
                modules_dir.join(format!("{}.json", script.id)),
                serde_json::to_string_pretty(&def)?,
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
        let notebooks_dir = registry.notebooks_dir(&request.package_name, &version_str);
        fs::create_dir_all(&notebooks_dir)?;
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
            fs::write(
                notebooks_dir.join(format!("{}.json", notebook.id)),
                serde_json::to_string_pretty(&def)?,
            )?;
        }
    }

    // Write pivot definitions
    if !request.workbook.pivot_definitions.is_empty() {
        let pivot_dir = ver_dir.join("pivot_definitions");
        fs::create_dir_all(&pivot_dir)?;
        for pivot_def in &request.workbook.pivot_definitions {
            fs::write(
                pivot_dir.join(format!("{}.json", pivot_def.id)),
                serde_json::to_string_pretty(pivot_def)?,
            )?;
        }
    }

    // Write BI pivot metadata (needed for BI-connected pivots)
    if !request.workbook.bi_pivot_metadata.is_empty() {
        let pivot_dir = ver_dir.join("pivot_definitions");
        fs::create_dir_all(&pivot_dir)?;
        fs::write(
            pivot_dir.join("bi_metadata.json"),
            serde_json::to_string_pretty(&request.workbook.bi_pivot_metadata)?,
        )?;
    }

    // Write embedded data source models
    for ds in &request.data_sources {
        let model_dir = ver_dir.join("models").join(&ds.id);
        fs::create_dir_all(&model_dir)?;
        fs::write(
            model_dir.join("model.json"),
            serde_json::to_string_pretty(&ds.model_json)?,
        )?;
    }

    // All artifacts are on disk in final form: compute SHA-256 checksums over
    // the actual bytes, then write the version manifest LAST. The manifest is
    // the integrity root — it cannot contain its own hash, so it covers all
    // OTHER artifacts and is itself the commit point of the publish.
    version_manifest.artifact_checksums =
        crate::integrity::compute_artifact_checksums(&ver_dir)?;
    registry.write_version_manifest(&request.package_name, &version_str, &version_manifest)?;

    // S5 phase 2: seal the integrity root. Sign the RAW bytes of
    // version-manifest.json AS WRITTEN TO DISK (read it back — re-serializing
    // the in-memory manifest may not be byte-identical to what write_version_
    // manifest produced). The detached signature lands in the sibling
    // version-manifest.sig, completing the publish.
    let manifest_path = ver_dir.join(crate::integrity::VERSION_MANIFEST_FILE);
    let manifest_bytes = fs::read(&manifest_path)?;
    let signature_hex = keypair.sign(&manifest_bytes);
    fs::write(
        ver_dir.join(crate::integrity::VERSION_MANIFEST_SIG_FILE),
        signature_hex,
    )?;

    // Update package manifest
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

    Ok(PublishResult {
        package_name: request.package_name.clone(),
        version: version_str,
        sheets_published: request.sheet_indices.len(),
        tables_published: published_tables.len(),
        named_ranges_published: named_ranges.len(),
        scripts_published: scripts_to_publish.len(),
        modules_published: modules_to_publish.len(),
        notebooks_published: notebooks_to_publish.len(),
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use persistence::Sheet;
    use engine::cell::Cell;

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
        let ver_dir = reg.version_dir("test-pkg", "1.0.0");
        let sig_path = ver_dir.join(crate::integrity::VERSION_MANIFEST_SIG_FILE);
        assert!(sig_path.exists(), "version-manifest.sig must be written");
        // The signature verifies over the RAW on-disk manifest bytes.
        let manifest_bytes = fs::read(ver_dir.join(crate::integrity::VERSION_MANIFEST_FILE)).unwrap();
        let sig_hex = fs::read_to_string(&sig_path).unwrap();
        crate::signing::verify_signature(
            &ver.publisher_key, &manifest_bytes, sig_hex.trim(), "test-pkg", "1.0.0",
        ).unwrap();

        // Verify sheet data files exist
        let sheet_dir = reg.sheet_dir("test-pkg", "1.0.0", &wb.sheets[0].id);
        assert!(sheet_dir.join("data.json").exists());
        assert!(sheet_dir.join("styles.json").exists());
        assert!(sheet_dir.join("layout.json").exists());
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
        };
        publish(&reg, &request, prof.path()).unwrap();

        let ver = reg.get_version_manifest("checked", "1.0.0").unwrap();

        // 2 sheets x (data.json + styles.json + layout.json)
        assert_eq!(ver.artifact_checksums.len(), 6);
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

        let on_disk = fs::read(
            reg.sheet_dir("checked", "1.0.0", &wb.sheets[0].id).join("data.json"),
        ).unwrap();
        assert_eq!(digest, &crate::integrity::sha256_hex(&on_disk));
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
