//! FILENAME: core/calp/src/pull.rs
//! PURPOSE: Pull (subscribe and materialize) a .calp package into a workbook.
//! CONTEXT: Phase 2 — raw subscribe-and-materialize, no override layer.

use std::fs;
use std::path::{Path, PathBuf};
use std::collections::HashMap;

use identity::SheetId;
use persistence::{Sheet, SavedCell, SavedTable, SavedObjectScript, SavedScript, SavedNotebook};

use crate::error::CalpError;
use crate::integrity::TrustStatus;
use crate::manifest::*;
use crate::registry::LocalRegistry;
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
    /// Trust outcome of the manifest-signature + TOFU check (S5 phase 2).
    /// FirstUse means this publisher key was just pinned; Verified means it
    /// matched a prior pin. The Tauri layer can surface this to the user.
    pub trust_status: TrustStatus,
    /// The publisher's display name asserted in the (now verified) manifest.
    pub publisher_name: String,
}

/// A data source pulled from a package, ready for connection resolution.
pub struct PulledDataSource {
    /// The data source definition from the version manifest.
    pub definition: PackageDataSource,
    /// Absolute path to the embedded model.json in the registry.
    pub model_path: PathBuf,
}

/// A sheet pulled from a package, ready to be inserted into a workbook.
pub struct PulledSheet {
    pub package_sheet_id: SheetId,
    pub name: String,
    pub sheet: Sheet,
}

/// Pull a package from the registry. Returns sheets and metadata for the
/// caller to integrate into the workbook.
///
/// `profile_dir` is the per-user profile directory holding the TOFU pin store
/// (`trusted-publishers.json`); the manifest-signature step pins/compares the
/// publisher key there (S5 phase 2).
pub fn pull(
    registry: &LocalRegistry,
    request: &PullRequest,
    profile_dir: &Path,
) -> Result<PullResult, CalpError> {
    let resolved = registry.resolve_version(&request.package_name, &request.version_pin)?;
    let version_str = resolved.to_string();
    let ver_manifest = registry.get_version_manifest(&request.package_name, &version_str)?;

    let ver_dir = registry.version_dir(&request.package_name, &version_str)?;

    // ORIGIN GATE (S5 phase 2): verify the manifest's Ed25519 signature and
    // apply TOFU publisher pinning BEFORE the integrity gate below. The
    // checksum map lives inside the manifest, so the manifest must be proven a
    // trusted root before its checksums are believed. A tampered manifest,
    // a wrong/changed publisher key, or an unsigned package all fail here.
    let trust_status = crate::integrity::verify_manifest_signature(
        &ver_dir,
        &ver_manifest,
        &request.package_name,
        profile_dir,
    )?;

    // INTEGRITY GATE: verify every artifact in the version directory against
    // the manifest's published SHA-256 checksums BEFORE materializing
    // anything. This single chokepoint covers both subscribe and refresh
    // (pull_all_updates delegates here), and also vouches for artifacts the
    // Tauri layer reads lazily after pull (e.g. models/{ds}/model.json).
    crate::integrity::verify_version_artifacts(
        &ver_dir,
        &ver_manifest,
        &request.package_name,
        &version_str,
    )?;

    // Read sheets
    let mut pulled_sheets = Vec::new();
    for pub_sheet in &ver_manifest.sheets {
        let sheet_dir = registry.sheet_dir(
            &request.package_name, &version_str, &pub_sheet.sheet_id,
        )?;

        // Read cell data
        let cells: HashMap<(u32, u32), SavedCell> = {
            let data_path = sheet_dir.join("data.json");
            if data_path.exists() {
                let content = fs::read_to_string(&data_path)?;
                let sd: calcula_format::sheet_data::SheetData = serde_json::from_str(&content)?;
                calcula_format::sheet_data::sheet_data_to_cells(&sd)
            } else {
                HashMap::new()
            }
        };

        // Read styles
        let styles: Vec<engine::style::CellStyle> = {
            let path = sheet_dir.join("styles.json");
            if path.exists() {
                serde_json::from_str(&fs::read_to_string(&path)?)?
            } else {
                vec![engine::style::CellStyle::new()]
            }
        };

        // Read layout
        let (column_widths, row_heights) = {
            let path = sheet_dir.join("layout.json");
            if path.exists() {
                let layout: calcula_format::sheet_layout::SheetLayout =
                    serde_json::from_str(&fs::read_to_string(&path)?)?;
                layout.to_dimensions()
            } else {
                (HashMap::new(), HashMap::new())
            }
        };

        // Build Sheet with fresh local SheetId
        let local_id = SheetId::from_bytes(identity::generate_uuid_v7());
        let sheet = Sheet {
            id: local_id,
            name: pub_sheet.name.clone(),
            cells,
            column_widths,
            row_heights,
            styles,
            merged_regions: Vec::new(),
            freeze_row: None,
            freeze_col: None,
            hidden_rows: std::collections::HashSet::new(),
            hidden_cols: std::collections::HashSet::new(),
            tab_color: String::new(),
            visibility: "visible".to_string(),
            notes: Vec::new(),
            hyperlinks: Vec::new(),
            page_setup: None,
            show_gridlines: true,
        };

        pulled_sheets.push(PulledSheet {
            package_sheet_id: pub_sheet.sheet_id,
            name: pub_sheet.name.clone(),
            sheet,
        });
    }

    // Read tables
    let mut pulled_tables = Vec::new();
    for table_id in &ver_manifest.tables {
        let tables_dir = registry.tables_dir(&request.package_name, &version_str)?;
        let path = tables_dir.join(format!("{}.json", table_id));
        if path.exists() {
            let table: SavedTable = serde_json::from_str(&fs::read_to_string(&path)?)?;
            pulled_tables.push(table);
        }
    }

    // Read object scripts
    let mut pulled_scripts: Vec<SavedObjectScript> = Vec::new();
    for pub_script in &ver_manifest.object_scripts {
        let scripts_dir = registry.scripts_dir(&request.package_name, &version_str)?;
        let path = scripts_dir.join(format!("{}.json", pub_script.id));
        if path.exists() {
            let content = fs::read_to_string(&path)?;
            let def: calcula_format::features::object_scripts::ObjectScriptDef =
                serde_json::from_str(&content)?;
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
        let modules_dir = registry.modules_dir(&request.package_name, &version_str)?;
        let path = modules_dir.join(format!("{}.json", pub_module.id));
        if path.exists() {
            let content = fs::read_to_string(&path)?;
            let def: calcula_format::features::scripts::ScriptDef =
                serde_json::from_str(&content)?;
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
        let notebooks_dir = registry.notebooks_dir(&request.package_name, &version_str)?;
        let path = notebooks_dir.join(format!("{}.json", pub_notebook.id));
        if path.exists() {
            let content = fs::read_to_string(&path)?;
            let def: calcula_format::features::notebooks::NotebookDef =
                serde_json::from_str(&content)?;
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
        resolved_version: version_str,
        resolved_at: request.now.clone(),
        sheets: subscribed_sheets,
        channel: String::new(), // default/production channel
        data_source_configs: Vec::new(),
        extra: HashMap::new(),
    };

    // Read pivot definitions
    let mut pulled_pivot_defs: Vec<persistence::SavedPivotDefinition> = Vec::new();
    {
        let pivot_dir = registry
            .version_dir(&request.package_name, subscription.resolved_version.as_str())?
            .join("pivot_definitions");
        if pivot_dir.exists() {
            if let Ok(entries) = fs::read_dir(&pivot_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().map_or(false, |e| e == "json") {
                        if let Ok(content) = fs::read_to_string(&path) {
                            if let Ok(def) = serde_json::from_str::<persistence::SavedPivotDefinition>(&content) {
                                pulled_pivot_defs.push(def);
                            }
                        }
                    }
                }
            }
        }
    }

    // Read BI pivot metadata (if present)
    let bi_pivot_metadata: Vec<serde_json::Value> = {
        let meta_path = registry
            .version_dir(&request.package_name, subscription.resolved_version.as_str())?
            .join("pivot_definitions")
            .join("bi_metadata.json");
        if meta_path.exists() {
            fs::read_to_string(&meta_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            Vec::new()
        }
    };

    // Resolve data source model paths
    let ds_ver_dir = registry
        .version_dir(&request.package_name, subscription.resolved_version.as_str())?;
    let pulled_data_sources: Vec<PulledDataSource> = ver_manifest.data_sources.iter().map(|ds| {
        let model_path = ds_ver_dir.join(&ds.model_path);
        PulledDataSource {
            definition: ds.clone(),
            model_path,
        }
    }).collect();

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
        trust_status,
        publisher_name: ver_manifest.publisher_name.clone(),
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use crate::publish::{self, PublishRequest};

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
    fn pull_fails_on_file_added_after_publish() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        publish_test_package(&reg, prof.path());

        // Inject a file the publisher never wrote (e.g. a smuggled script).
        let rogue = reg
            .version_dir("test-pkg", "1.0.0")
            .unwrap()
            .join("object_scripts");
        fs::create_dir_all(&rogue).unwrap();
        fs::write(rogue.join("rogue.json"), "{\"source\": \"evil()\"}").unwrap();

        let err = expect_pull_err(&reg, &make_pull_request(), prof.path());
        assert!(matches!(err, CalpError::UnlistedArtifact { .. }));
        assert!(err.to_string().contains("object_scripts/rogue.json"));
    }

    #[test]
    fn pull_fails_on_deleted_artifact() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        let wb = publish_test_package(&reg, prof.path());

        // Tamper-by-deletion: previously a silent skip, now a hard error.
        let styles_path = reg
            .sheet_dir("test-pkg", "1.0.0", &wb.sheets[1].id)
            .unwrap()
            .join("styles.json");
        fs::remove_file(&styles_path).unwrap();

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

        // Subscriber-written submissions land inside the version directory
        // after publish — they are a separate trust domain and must not
        // trip the publisher-artifact integrity gate.
        let submission = crate::writeback::WritebackSubmission {
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
            extra: HashMap::new(),
        };
        reg.save_submission("test-pkg", "1.0.0", &submission).unwrap();

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
                last_output: vec!["2".to_string(), "cached".to_string()],
                last_error: Some("stale error".to_string()),
                cells_modified: 7,
                duration_ms: 123,
                execution_index: Some(3),
            }],
            source_package: None,
        }];

        let request = PublishRequest {
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
        use calcula_format::features::notebooks::{NotebookCellDef, NotebookDef};
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
                last_output: vec!["All checks passed".to_string()],
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
