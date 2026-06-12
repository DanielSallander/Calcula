//! FILENAME: core/calp/src/pull.rs
//! PURPOSE: Pull (subscribe and materialize) a .calp package into a workbook.
//! CONTEXT: Phase 2 — raw subscribe-and-materialize, no override layer.

use std::fs;
use std::path::PathBuf;
use std::collections::HashMap;

use identity::SheetId;
use persistence::{Sheet, SavedCell, SavedTable, SavedObjectScript};

use crate::error::CalpError;
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
    /// Data source definitions from the package, with resolved model paths.
    pub data_sources: Vec<PulledDataSource>,
    /// Pivot table definitions from the package.
    pub pivot_definitions: Vec<persistence::SavedPivotDefinition>,
    /// BI pivot metadata for reconnecting to BI models.
    pub bi_pivot_metadata: Vec<serde_json::Value>,
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
pub fn pull(
    registry: &LocalRegistry,
    request: &PullRequest,
) -> Result<PullResult, CalpError> {
    let resolved = registry.resolve_version(&request.package_name, &request.version_pin)?;
    let version_str = resolved.to_string();
    let ver_manifest = registry.get_version_manifest(&request.package_name, &version_str)?;

    // INTEGRITY GATE: verify every artifact in the version directory against
    // the manifest's published SHA-256 checksums BEFORE materializing
    // anything. This single chokepoint covers both subscribe and refresh
    // (pull_all_updates delegates here), and also vouches for artifacts the
    // Tauri layer reads lazily after pull (e.g. models/{ds}/model.json).
    // Phase 2 (Ed25519 signing + TOFU pinning) will verify the manifest
    // signature here first — see integrity.rs.
    let ver_dir = registry.version_dir(&request.package_name, &version_str);
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
        );

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
        let tables_dir = registry.tables_dir(&request.package_name, &version_str);
        let path = tables_dir.join(format!("{}.json", table_id));
        if path.exists() {
            let table: SavedTable = serde_json::from_str(&fs::read_to_string(&path)?)?;
            pulled_tables.push(table);
        }
    }

    // Read object scripts
    let mut pulled_scripts: Vec<SavedObjectScript> = Vec::new();
    for pub_script in &ver_manifest.object_scripts {
        let scripts_dir = registry.scripts_dir(&request.package_name, &version_str);
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
            pulled_scripts.push(script);
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
        let pivot_dir = registry.root()
            .join(&request.package_name)
            .join(subscription.resolved_version.as_str())
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
        let meta_path = registry.root()
            .join(&request.package_name)
            .join(subscription.resolved_version.as_str())
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
    let pulled_data_sources: Vec<PulledDataSource> = ver_manifest.data_sources.iter().map(|ds| {
        let ver_dir = registry.root()
            .join(&request.package_name)
            .join(subscription.resolved_version.as_str());
        let model_path = ver_dir.join(&ds.model_path);
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
        data_sources: pulled_data_sources,
        pivot_definitions: pulled_pivot_defs,
        bi_pivot_metadata,
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

    fn publish_test_package(reg: &LocalRegistry) -> persistence::Workbook {
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
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
        };
        publish::publish(reg, &request).unwrap();
        wb
    }

    #[test]
    fn pull_materializes_sheets() {
        let dir = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        publish_test_package(&reg);

        let request = PullRequest {
            package_name: "test-pkg".to_string(),
            registry_url: format!("file://{}", dir.path().display()),
            version_pin: VersionPin::Exact(SemVer::new(1, 0, 0)),
            now: "2026-05-18T01:00:00Z".to_string(),
        };

        let result = pull(&reg, &request).unwrap();
        assert_eq!(result.sheets.len(), 2);
        assert_eq!(result.sheets[0].name, "Dashboard");
        assert_eq!(result.sheets[1].name, "Data");
        assert_eq!(result.resolved_version, SemVer::new(1, 0, 0));

        // Verify cell data was materialized
        let dashboard = &result.sheets[0].sheet;
        let cell = dashboard.cells.get(&(0, 0)).unwrap();
        assert!(matches!(cell.value, persistence::SavedCellValue::Number(n) if n == 42.0));
    }

    #[test]
    fn pull_creates_subscription_metadata() {
        let dir = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        publish_test_package(&reg);

        let request = PullRequest {
            package_name: "test-pkg".to_string(),
            registry_url: "file:///test/registry".to_string(),
            version_pin: VersionPin::Caret(SemVer::new(1, 0, 0)),
            now: "2026-05-18T01:00:00Z".to_string(),
        };

        let result = pull(&reg, &request).unwrap();
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
                data_sources: Vec::new(),
                excluded_regions: Vec::new(),
            };
            publish::publish(&reg, &request).unwrap();
        }

        // ^1.0 should resolve to 1.1.0
        let request = PullRequest {
            package_name: "versioned".to_string(),
            registry_url: "file:///test".to_string(),
            version_pin: VersionPin::Caret(SemVer::new(1, 0, 0)),
            now: "2026-05-18T01:00:00Z".to_string(),
        };

        let result = pull(&reg, &request).unwrap();
        assert_eq!(result.resolved_version, SemVer::new(1, 1, 0));
    }

    #[test]
    fn pull_nonexistent_package_fails() {
        let dir = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();

        let request = PullRequest {
            package_name: "ghost".to_string(),
            registry_url: "file:///test".to_string(),
            version_pin: VersionPin::Latest,
            now: "2026-05-18T00:00:00Z".to_string(),
        };

        let result = pull(&reg, &request);
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
    fn expect_pull_err(reg: &LocalRegistry, req: &PullRequest) -> CalpError {
        match pull(reg, req) {
            Ok(_) => panic!("pull unexpectedly succeeded"),
            Err(e) => e,
        }
    }

    #[test]
    fn pull_roundtrip_passes_integrity_verification() {
        let dir = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        publish_test_package(&reg);

        // Publish recorded checksums...
        let ver = reg.get_version_manifest("test-pkg", "1.0.0").unwrap();
        assert!(!ver.artifact_checksums.is_empty());

        // ...and an untampered pull passes the integrity gate.
        let result = pull(&reg, &make_pull_request()).unwrap();
        assert_eq!(result.sheets.len(), 2);
    }

    #[test]
    fn pull_fails_on_tampered_data_file() {
        let dir = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        let wb = publish_test_package(&reg);

        // Tamper with a published artifact after publish.
        let data_path = reg
            .sheet_dir("test-pkg", "1.0.0", &wb.sheets[0].id)
            .join("data.json");
        fs::write(&data_path, "{\"cells\": \"tampered\"}").unwrap();

        let err = expect_pull_err(&reg, &make_pull_request());
        assert!(matches!(err, CalpError::ChecksumMismatch { .. }));
        let msg = err.to_string();
        assert!(msg.contains("Package integrity check failed"), "msg: {}", msg);
        assert!(msg.contains("test-pkg@1.0.0"), "msg: {}", msg);
        assert!(msg.contains("data.json"), "msg: {}", msg);
    }

    #[test]
    fn pull_fails_on_file_added_after_publish() {
        let dir = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        publish_test_package(&reg);

        // Inject a file the publisher never wrote (e.g. a smuggled script).
        let rogue = reg
            .version_dir("test-pkg", "1.0.0")
            .join("object_scripts");
        fs::create_dir_all(&rogue).unwrap();
        fs::write(rogue.join("rogue.json"), "{\"source\": \"evil()\"}").unwrap();

        let err = expect_pull_err(&reg, &make_pull_request());
        assert!(matches!(err, CalpError::UnlistedArtifact { .. }));
        assert!(err.to_string().contains("object_scripts/rogue.json"));
    }

    #[test]
    fn pull_fails_on_deleted_artifact() {
        let dir = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        let wb = publish_test_package(&reg);

        // Tamper-by-deletion: previously a silent skip, now a hard error.
        let styles_path = reg
            .sheet_dir("test-pkg", "1.0.0", &wb.sheets[1].id)
            .join("styles.json");
        fs::remove_file(&styles_path).unwrap();

        let err = expect_pull_err(&reg, &make_pull_request());
        assert!(matches!(err, CalpError::MissingArtifact { .. }));
        assert!(err.to_string().contains("styles.json"));
    }

    #[test]
    fn pull_fails_on_package_published_without_checksums() {
        let dir = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        publish_test_package(&reg);

        // Simulate a pre-checksum (legacy) package: strip the checksum map
        // from the version manifest. No backward compatibility: hard error.
        let mut ver = reg.get_version_manifest("test-pkg", "1.0.0").unwrap();
        ver.artifact_checksums = std::collections::BTreeMap::new();
        reg.write_version_manifest("test-pkg", "1.0.0", &ver).unwrap();

        let err = expect_pull_err(&reg, &make_pull_request());
        assert!(matches!(err, CalpError::MissingChecksums { .. }));
        let msg = err.to_string();
        assert!(msg.contains("without integrity checksums"), "msg: {}", msg);
        assert!(msg.contains("republish"), "msg: {}", msg);
    }

    #[test]
    fn pull_ignores_subscriber_submissions() {
        let dir = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        publish_test_package(&reg);

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

        let result = pull(&reg, &make_pull_request()).unwrap();
        assert_eq!(result.sheets.len(), 2);
    }

    #[test]
    fn end_to_end_publish_and_pull_roundtrip() {
        let dir = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        let original_wb = publish_test_package(&reg);

        let request = PullRequest {
            package_name: "test-pkg".to_string(),
            registry_url: format!("file://{}", dir.path().display()),
            version_pin: VersionPin::Exact(SemVer::new(1, 0, 0)),
            now: "2026-05-18T01:00:00Z".to_string(),
        };
        let result = pull(&reg, &request).unwrap();

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
}
