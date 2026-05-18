//! FILENAME: core/calp/src/pull.rs
//! PURPOSE: Pull (subscribe and materialize) a .calp package into a workbook.
//! CONTEXT: Phase 2 — raw subscribe-and-materialize, no override layer.

use std::fs;
use std::collections::HashMap;

use identity::SheetId;
use persistence::{Sheet, SavedCell, SavedTable};

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

    // Build subscription metadata
    let subscribed_sheets: Vec<SubscribedSheet> = pulled_sheets.iter().map(|ps| {
        SubscribedSheet {
            package_sheet_id: ps.package_sheet_id,
            local_sheet_id: ps.sheet.id,
            local_name: ps.name.clone(),
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
    };

    Ok(PullResult {
        package_name: request.package_name.clone(),
        resolved_version: resolved,
        sheets: pulled_sheets,
        tables: pulled_tables,
        subscription,
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
