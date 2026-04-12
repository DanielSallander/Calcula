//! FILENAME: core/calcula-format/src/publish/reader.rs
//! Reads published sheets from a publication directory.

use crate::error::FormatError;
use crate::sheet_data::{SheetData, sheet_data_to_cells};
use crate::sheet_layout::SheetLayout;
use crate::sheet_styles::{SheetStyles, apply_sheet_styles, deserialize_style_registry};

use super::manifest::{PublishManifest, PublishedSheet};
use persistence::{SavedCell, Sheet};
use std::collections::HashMap;
use std::path::Path;

/// Information about a published sheet, suitable for display to consumers.
#[derive(Debug, Clone)]
pub struct PublishedSheetInfo {
    /// Stable ID.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Description.
    pub description: String,
    /// Current version.
    pub version: u64,
    /// When it was last published.
    pub published_at: String,
    /// SHA-256 checksum.
    pub checksum: String,
}

impl From<&PublishedSheet> for PublishedSheetInfo {
    fn from(ps: &PublishedSheet) -> Self {
        PublishedSheetInfo {
            id: ps.id.clone(),
            name: ps.name.clone(),
            description: ps.description.clone(),
            version: ps.version,
            published_at: ps.published_at.clone(),
            checksum: ps.checksum.clone(),
        }
    }
}

/// Read the publish manifest from a publication directory.
pub fn read_publish_manifest(pub_dir: &Path) -> Result<PublishManifest, FormatError> {
    let manifest_path = pub_dir.join("publish-manifest.json");
    if !manifest_path.exists() {
        return Err(FormatError::MissingEntry(format!(
            "publish-manifest.json not found in {}",
            pub_dir.display()
        )));
    }

    let content = std::fs::read_to_string(&manifest_path)?;
    let manifest: PublishManifest = serde_json::from_str(&content)?;
    Ok(manifest)
}

/// List all published sheets available at a publication directory.
pub fn browse_published_sheets(pub_dir: &Path) -> Result<Vec<PublishedSheetInfo>, FormatError> {
    let manifest = read_publish_manifest(pub_dir)?;
    Ok(manifest.sheets.iter().map(PublishedSheetInfo::from).collect())
}

/// Read a single published sheet's data from the publication directory.
/// Returns a `persistence::Sheet` suitable for inserting into a workbook.
pub fn read_published_sheet(
    pub_dir: &Path,
    published_sheet: &PublishedSheet,
) -> Result<Sheet, FormatError> {
    let sheet_dir = pub_dir.join("sheets").join(&published_sheet.folder);

    // Read data.json (required)
    let data_path = sheet_dir.join("data.json");
    if !data_path.exists() {
        return Err(FormatError::MissingEntry(format!(
            "data.json not found for sheet '{}'",
            published_sheet.name
        )));
    }
    let data_content = std::fs::read_to_string(&data_path)?;
    let sheet_data: SheetData = serde_json::from_str(&data_content)?;
    let mut cells: HashMap<(u32, u32), SavedCell> = sheet_data_to_cells(&sheet_data);

    // Read styles.json (optional)
    let styles_path = sheet_dir.join("styles.json");
    if styles_path.exists() {
        let styles_content = std::fs::read_to_string(&styles_path)?;
        let sheet_styles: SheetStyles = serde_json::from_str(&styles_content)?;
        apply_sheet_styles(&mut cells, &sheet_styles);
    }

    // Read layout.json (optional)
    let layout_path = sheet_dir.join("layout.json");
    let (column_widths, row_heights) = if layout_path.exists() {
        let layout_content = std::fs::read_to_string(&layout_path)?;
        let layout: SheetLayout = serde_json::from_str(&layout_content)?;
        layout.to_dimensions()
    } else {
        (HashMap::new(), HashMap::new())
    };

    // Read style registry (optional)
    let registry_path = pub_dir
        .join("styles")
        .join(format!("{}_registry.json", published_sheet.folder));
    let styles = if registry_path.exists() {
        let registry_content = std::fs::read_to_string(&registry_path)?;
        deserialize_style_registry(&registry_content)?
    } else {
        vec![engine::style::CellStyle::new()]
    };

    Ok(Sheet {
        name: published_sheet.name.clone(),
        cells,
        column_widths,
        row_heights,
        styles,
    })
}

/// Read the data checksum for a published sheet without loading all data.
/// This allows quick staleness checks.
pub fn read_sheet_checksum(
    pub_dir: &Path,
    published_sheet: &PublishedSheet,
) -> Result<String, FormatError> {
    let data_path = pub_dir
        .join("sheets")
        .join(&published_sheet.folder)
        .join("data.json");

    if !data_path.exists() {
        return Err(FormatError::MissingEntry(format!(
            "data.json not found for sheet '{}'",
            published_sheet.name
        )));
    }

    let data = std::fs::read(&data_path)?;
    Ok(super::writer::compute_checksum(&data))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::publish::writer::{publish_sheets, PublishRequest};
    use engine::theme::ThemeDefinition;
    use persistence::{SavedCell, SavedCellValue, Workbook};

    fn make_test_workbook() -> Workbook {
        let mut cells = HashMap::new();
        cells.insert(
            (0, 0),
            SavedCell {
                value: SavedCellValue::Text("Header".to_string()),
                formula: None,
                style_index: 0,
                rich_text: None,
            },
        );
        cells.insert(
            (1, 0),
            SavedCell {
                value: SavedCellValue::Number(42.0),
                formula: Some("=B1*2".to_string()),
                style_index: 0,
                rich_text: None,
            },
        );

        Workbook {
            sheets: vec![Sheet {
                name: "Test Sheet".to_string(),
                cells,
                column_widths: [(0, 150.0)].into_iter().collect(),
                row_heights: HashMap::new(),
                styles: vec![engine::style::CellStyle::new()],
            }],
            active_sheet: 0,
            tables: vec![],
            slicers: vec![],
            user_files: HashMap::new(),
            theme: ThemeDefinition::default(),
            scripts: Vec::new(),
            notebooks: Vec::new(),
        }
    }

    #[test]
    fn test_publish_then_read_roundtrip() {
        let workbook = make_test_workbook();
        let dir = tempfile::tempdir().unwrap();
        let pub_dir = dir.path().join("test.calp-pub");

        let request = PublishRequest {
            sheet_indices: vec![0],
            descriptions: vec!["Test description".to_string()],
            author: "tester".to_string(),
            now: "2026-04-09T12:00:00Z".to_string(),
        };

        let result = publish_sheets(&workbook, &request, &pub_dir).unwrap();
        let published = &result.manifest.sheets[0];

        // Read it back
        let sheet = read_published_sheet(&pub_dir, published).unwrap();
        assert_eq!(sheet.name, "Test Sheet");

        // Verify cell data survived roundtrip
        let a1 = &sheet.cells[&(0, 0)];
        assert!(matches!(&a1.value, SavedCellValue::Text(s) if s == "Header"));

        let a2 = &sheet.cells[&(1, 0)];
        assert!(matches!(&a2.value, SavedCellValue::Number(n) if *n == 42.0));
        assert_eq!(a2.formula, Some("=B1*2".to_string()));

        // Verify layout survived
        assert_eq!(sheet.column_widths[&0], 150.0);
    }

    #[test]
    fn test_browse_published_sheets() {
        let workbook = make_test_workbook();
        let dir = tempfile::tempdir().unwrap();
        let pub_dir = dir.path().join("test.calp-pub");

        let request = PublishRequest {
            sheet_indices: vec![0],
            descriptions: vec!["A test".to_string()],
            author: "tester".to_string(),
            now: "2026-01-01T00:00:00Z".to_string(),
        };

        publish_sheets(&workbook, &request, &pub_dir).unwrap();

        let sheets = browse_published_sheets(&pub_dir).unwrap();
        assert_eq!(sheets.len(), 1);
        assert_eq!(sheets[0].name, "Test Sheet");
        assert_eq!(sheets[0].description, "A test");
        assert_eq!(sheets[0].version, 1);
    }

    #[test]
    fn test_read_manifest_missing() {
        let dir = tempfile::tempdir().unwrap();
        let result = read_publish_manifest(dir.path());
        assert!(result.is_err());
    }
}
