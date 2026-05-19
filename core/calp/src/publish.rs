//! FILENAME: core/calp/src/publish.rs
//! PURPOSE: Publish a workbook's selected sheets as a .calp package version.
//! CONTEXT: The author selects sheets to publish, specifies a version, and
//! the content is written to the registry as an immutable version directory.

use std::fs;

use identity::EntityId;
use persistence::{SavedTable, Workbook};

use crate::error::CalpError;
use crate::manifest::*;
use crate::registry::LocalRegistry;
use crate::version::SemVer;

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
}

/// Result of a publish operation.
pub struct PublishResult {
    pub package_name: String,
    pub version: String,
    pub sheets_published: usize,
    pub tables_published: usize,
    pub named_ranges_published: usize,
}

/// Publish selected sheets from a workbook to a local registry.
pub fn publish(
    registry: &LocalRegistry,
    request: &PublishRequest,
) -> Result<PublishResult, CalpError> {
    let version_str = request.version.to_string();

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

    let version_manifest = VersionManifest {
        format_version: 1,
        package_name: request.package_name.clone(),
        version: version_str.clone(),
        kind: request.kind.clone(),
        published_at: request.now.clone(),
        published_by: request.published_by.clone(),
        sheets,
        named_ranges: named_ranges.clone(),
        tables: table_ids,
        locked_sheets: Vec::new(),
        locked_cells: Vec::new(),
        writeback_regions: None,
        extra: std::collections::HashMap::new(),
    };

    registry.write_version_manifest(&request.package_name, &version_str, &version_manifest)?;

    // Write sheet data (cells, styles, layout as JSON)
    for &idx in &request.sheet_indices {
        let sheet = &request.workbook.sheets[idx];
        let sheet_dir = registry.sheet_dir(&request.package_name, &version_str, &sheet.id);
        fs::create_dir_all(&sheet_dir)?;

        // Cell data
        let cell_data = calcula_format::sheet_data::cells_to_sheet_data(&sheet.cells);
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
        let ver_dir = registry.root()
            .join(&request.package_name)
            .join(&version_str);
        fs::write(
            ver_dir.join("named_ranges.json"),
            serde_json::to_string_pretty(&named_ranges)?,
        )?;
    }

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
        };

        let result = publish(&reg, &request).unwrap();
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

        // Verify sheet data files exist
        let sheet_dir = reg.sheet_dir("test-pkg", "1.0.0", &wb.sheets[0].id);
        assert!(sheet_dir.join("data.json").exists());
        assert!(sheet_dir.join("styles.json").exists());
        assert!(sheet_dir.join("layout.json").exists());
    }

    #[test]
    fn publish_selected_sheets_only() {
        let dir = TempDir::new().unwrap();
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
        };

        let result = publish(&reg, &request).unwrap();
        assert_eq!(result.sheets_published, 1);

        let ver = reg.get_version_manifest("partial", "1.0.0").unwrap();
        assert_eq!(ver.sheets.len(), 1);
        assert_eq!(ver.sheets[0].name, "Dashboard");
    }

    #[test]
    fn publish_duplicate_version_fails() {
        let dir = TempDir::new().unwrap();
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
        };

        publish(&reg, &request).unwrap();
        let result = publish(&reg, &request);
        assert!(matches!(result, Err(CalpError::VersionAlreadyPublished { .. })));
    }

    #[test]
    fn publish_multiple_versions() {
        let dir = TempDir::new().unwrap();
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
            };
            publish(&reg, &request).unwrap();
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
