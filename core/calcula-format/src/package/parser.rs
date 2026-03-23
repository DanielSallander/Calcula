//! FILENAME: core/calcula-format/src/package/parser.rs
//! Reads `.calp` package files (ZIP archives) and extracts their metadata and content.

use crate::error::FormatError;
use crate::features::tables::TableDef;
use crate::manifest::Manifest;
use crate::sheet_data::{sheet_data_to_cells, SheetData};
use crate::sheet_layout::SheetLayout;
use crate::sheet_styles::{apply_sheet_styles, SheetStyles};

use super::manifest::{PackageContent, PackageContentType, PackageManifest};
use persistence::{SavedTable, Sheet, Workbook};
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

/// Result of parsing a `.calp` file — contains both the package metadata
/// and the extracted workbook content ready for merging.
#[derive(Debug)]
pub struct ParsedPackage {
    /// The package descriptor from `package.json`.
    pub package: PackageManifest,
    /// The workbook content extracted from the archive.
    /// Contains only the sheets/tables/files included in the package.
    pub workbook: Workbook,
}

/// Parse a `.calp` file and return its metadata without extracting content.
/// Use this for preview/browse operations where you only need the manifest.
pub fn parse_package_metadata(path: &Path) -> Result<PackageManifest, FormatError> {
    let file = std::fs::File::open(path)?;
    let mut archive = zip::ZipArchive::new(file)?;

    read_package_json(&mut archive)
}

/// Parse a `.calp` file and extract both metadata and workbook content.
pub fn parse_package(path: &Path) -> Result<ParsedPackage, FormatError> {
    let file = std::fs::File::open(path)?;
    let mut archive = zip::ZipArchive::new(file)?;

    // Read package.json (required)
    let package = read_package_json(&mut archive)?;

    // Read the .cala-compatible content (manifest.json, sheets, tables, files)
    let workbook = read_package_content(&mut archive, &package)?;

    Ok(ParsedPackage { package, workbook })
}

/// Read and parse `package.json` from the archive.
fn read_package_json(
    archive: &mut zip::ZipArchive<std::fs::File>,
) -> Result<PackageManifest, FormatError> {
    let mut entry = archive
        .by_name("package.json")
        .map_err(|_| FormatError::MissingEntry("package.json".to_string()))?;
    let mut contents = String::new();
    entry.read_to_string(&mut contents)?;
    let manifest: PackageManifest = serde_json::from_str(&contents)?;
    Ok(manifest)
}

/// Extract the workbook content from the archive, guided by the package manifest.
fn read_package_content(
    archive: &mut zip::ZipArchive<std::fs::File>,
    package: &PackageManifest,
) -> Result<Workbook, FormatError> {
    // Read the .cala manifest if present (optional — older packages might not have it)
    let cala_manifest = read_optional_json::<Manifest>(archive, "manifest.json")?;

    // Read styles registry
    let style_list = read_optional_json::<Vec<engine::style::CellStyle>>(
        archive,
        "styles/registry.json",
    )?
    .unwrap_or_else(|| vec![engine::style::CellStyle::new()]);

    // Extract sheets
    let mut sheets = Vec::new();
    let sheet_contents: Vec<&PackageContent> = package
        .contents
        .iter()
        .filter(|c| c.content_type == PackageContentType::Sheet)
        .collect();

    if let Some(ref manifest) = cala_manifest {
        // Use the .cala manifest for sheet ordering and folder names
        for sheet_entry in &manifest.sheets {
            let base_path = format!("sheets/{}", sheet_entry.folder);

            let sheet_data = read_optional_json::<SheetData>(
                archive,
                &format!("{}/data.json", base_path),
            )?
            .unwrap_or(SheetData {
                cells: std::collections::BTreeMap::new(),
            });
            let mut cells = sheet_data_to_cells(&sheet_data);

            if let Some(sheet_styles) = read_optional_json::<SheetStyles>(
                archive,
                &format!("{}/styles.json", base_path),
            )? {
                apply_sheet_styles(&mut cells, &sheet_styles);
            }

            let layout = read_optional_json::<SheetLayout>(
                archive,
                &format!("{}/layout.json", base_path),
            )?
            .unwrap_or(SheetLayout {
                column_widths: std::collections::BTreeMap::new(),
                row_heights: std::collections::BTreeMap::new(),
            });
            let (col_widths, row_heights) = layout.to_dimensions();

            sheets.push(Sheet {
                name: sheet_entry.name.clone(),
                cells,
                column_widths: col_widths,
                row_heights: row_heights,
                styles: style_list.clone(),
            });
        }
    } else if !sheet_contents.is_empty() {
        // Fallback: use package.json contents to find sheets
        for content in &sheet_contents {
            let base_path = &content.path;

            let sheet_data = read_optional_json::<SheetData>(
                archive,
                &format!("{}/data.json", base_path),
            )?
            .unwrap_or(SheetData {
                cells: std::collections::BTreeMap::new(),
            });
            let mut cells = sheet_data_to_cells(&sheet_data);

            if let Some(sheet_styles) = read_optional_json::<SheetStyles>(
                archive,
                &format!("{}/styles.json", base_path),
            )? {
                apply_sheet_styles(&mut cells, &sheet_styles);
            }

            let layout = read_optional_json::<SheetLayout>(
                archive,
                &format!("{}/layout.json", base_path),
            )?
            .unwrap_or(SheetLayout {
                column_widths: std::collections::BTreeMap::new(),
                row_heights: std::collections::BTreeMap::new(),
            });
            let (col_widths, row_heights) = layout.to_dimensions();

            sheets.push(Sheet {
                name: content.name.clone(),
                cells,
                column_widths: col_widths,
                row_heights: row_heights,
                styles: style_list.clone(),
            });
        }
    }

    // Read tables
    let mut tables: Vec<SavedTable> = Vec::new();
    let table_names: Vec<String> = (0..archive.len())
        .filter_map(|i| {
            let entry = archive.by_index(i).ok()?;
            let name = entry.name().to_string();
            if name.starts_with("tables/") && name.ends_with(".json") {
                Some(name)
            } else {
                None
            }
        })
        .collect();

    for table_name in table_names {
        if let Some(table_def) = read_optional_json::<TableDef>(archive, &table_name)? {
            tables.push(SavedTable::from(&table_def));
        }
    }

    // Read user files (files/ prefix)
    let mut user_files = HashMap::new();
    let file_names: Vec<String> = (0..archive.len())
        .filter_map(|i| {
            let entry = archive.by_index(i).ok()?;
            let name = entry.name().to_string();
            if name.starts_with("files/") && name.len() > 6 && !name.ends_with('/') {
                Some(name)
            } else {
                None
            }
        })
        .collect();

    for file_name in file_names {
        let mut entry = archive
            .by_name(&file_name)
            .map_err(|e| FormatError::Zip(e))?;
        let mut content = Vec::new();
        entry.read_to_end(&mut content)?;
        let relative_path = file_name[6..].to_string();
        user_files.insert(relative_path, content);
    }

    Ok(Workbook {
        sheets,
        active_sheet: 0,
        tables,
        user_files,
    })
}

/// Read an optional JSON file from the archive. Returns None if the file doesn't exist.
fn read_optional_json<T: serde::de::DeserializeOwned>(
    archive: &mut zip::ZipArchive<std::fs::File>,
    name: &str,
) -> Result<Option<T>, FormatError> {
    match archive.by_name(name) {
        Ok(mut entry) => {
            let mut contents = String::new();
            entry.read_to_string(&mut contents)?;
            let value = serde_json::from_str(&contents)?;
            Ok(Some(value))
        }
        Err(zip::result::ZipError::FileNotFound) => Ok(None),
        Err(e) => Err(FormatError::Zip(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: create a minimal .calp file in a temp directory and return its path.
    fn create_test_package(dir: &std::path::Path) -> std::path::PathBuf {
        use crate::sheet_data::cells_to_sheet_data;
        use persistence::{SavedCell, SavedCellValue};
        use std::io::Write;
        use zip::write::FileOptions;
        use zip::CompressionMethod;

        let path = dir.join("test.calp");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = FileOptions::<()>::default().compression_method(CompressionMethod::Deflated);

        // package.json
        let pkg = PackageManifest {
            id: "com.test.simple".to_string(),
            name: "Test Package".to_string(),
            version: "1.0.0".to_string(),
            description: "A test package".to_string(),
            author: "Test".to_string(),
            tags: vec!["test".to_string()],
            contents: vec![PackageContent {
                content_type: PackageContentType::Sheet,
                path: "sheets/0_Data".to_string(),
                name: "Data".to_string(),
                description: None,
            }],
            data_sources: vec![],
            min_calc_version: None,
            required_extensions: vec![],
        };
        let pkg_json = serde_json::to_string_pretty(&pkg).unwrap();
        zip.start_file("package.json", options.clone()).unwrap();
        zip.write_all(pkg_json.as_bytes()).unwrap();

        // manifest.json
        let manifest = Manifest::from_sheet_names(&["Data".to_string()], 0);
        let manifest_json = serde_json::to_string_pretty(&manifest).unwrap();
        zip.start_file("manifest.json", options.clone()).unwrap();
        zip.write_all(manifest_json.as_bytes()).unwrap();

        // styles/registry.json
        let styles = vec![engine::style::CellStyle::new()];
        let styles_json = serde_json::to_string_pretty(&styles).unwrap();
        zip.start_file("styles/registry.json", options.clone()).unwrap();
        zip.write_all(styles_json.as_bytes()).unwrap();

        // sheets/0_Data/data.json — build via the standard helper
        let mut cells = HashMap::new();
        cells.insert(
            (0, 0),
            SavedCell {
                value: SavedCellValue::Text("Hello".to_string()),
                formula: None,
                style_index: 0,
            },
        );
        cells.insert(
            (0, 1),
            SavedCell {
                value: SavedCellValue::Number(42.0),
                formula: Some("=A1+1".to_string()),
                style_index: 0,
            },
        );
        let sheet_data = cells_to_sheet_data(&cells);
        let data_json = serde_json::to_string_pretty(&sheet_data).unwrap();
        zip.start_file("sheets/0_Data/data.json", options.clone()).unwrap();
        zip.write_all(data_json.as_bytes()).unwrap();

        zip.finish().unwrap();
        path
    }

    #[test]
    fn test_parse_metadata_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = create_test_package(dir.path());

        let metadata = parse_package_metadata(&path).unwrap();
        assert_eq!(metadata.id, "com.test.simple");
        assert_eq!(metadata.name, "Test Package");
        assert_eq!(metadata.version, "1.0.0");
        assert_eq!(metadata.contents.len(), 1);
    }

    #[test]
    fn test_parse_full_package() {
        let dir = tempfile::tempdir().unwrap();
        let path = create_test_package(dir.path());

        let parsed = parse_package(&path).unwrap();
        assert_eq!(parsed.package.id, "com.test.simple");
        assert_eq!(parsed.workbook.sheets.len(), 1);
        assert_eq!(parsed.workbook.sheets[0].name, "Data");

        // Verify cells were loaded
        let cells = &parsed.workbook.sheets[0].cells;
        assert!(cells.contains_key(&(0, 0)));
        assert!(cells.contains_key(&(0, 1)));

        let cell_a1 = &cells[&(0, 0)];
        assert!(matches!(
            &cell_a1.value,
            persistence::SavedCellValue::Text(s) if s == "Hello"
        ));

        let cell_b1 = &cells[&(0, 1)];
        assert_eq!(cell_b1.formula, Some("=A1+1".to_string()));
    }

    #[test]
    fn test_missing_package_json() {
        use std::io::Write;
        use zip::write::FileOptions;
        use zip::CompressionMethod;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad.calp");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = FileOptions::<()>::default().compression_method(CompressionMethod::Deflated);

        // Only a manifest.json, no package.json
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(b"{}").unwrap();
        zip.finish().unwrap();

        let result = parse_package_metadata(&path);
        assert!(result.is_err());
    }
}
