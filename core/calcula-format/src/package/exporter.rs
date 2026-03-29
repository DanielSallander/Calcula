//! FILENAME: core/calcula-format/src/package/exporter.rs
//! Exports selected objects from a Workbook into a `.calp` package file (ZIP archive).

use crate::error::FormatError;
use crate::features::tables::TableDef;
use crate::manifest::Manifest;
use crate::sheet_data::cells_to_sheet_data;
use crate::sheet_layout::SheetLayout;
use crate::sheet_styles::{cells_to_sheet_styles, serialize_style_registry};

use super::manifest::{PackageContent, PackageContentType, PackageManifest};
use persistence::Workbook;
use std::io::Write;
use std::path::Path;
use zip::write::FileOptions;
use zip::CompressionMethod;

/// Specifies what to export from a workbook.
#[derive(Debug, Clone)]
pub struct ExportRequest {
    /// Package metadata.
    pub package: PackageManifest,
    /// Which sheets to include (by index).
    pub sheet_indices: Vec<usize>,
    /// Which tables to include (by ID).
    pub table_ids: Vec<u64>,
    /// Which user files to include (by path).
    pub file_paths: Vec<String>,
}

/// Export selected objects from a workbook as a `.calp` package file.
pub fn export_package(
    workbook: &Workbook,
    request: &ExportRequest,
    output_path: &Path,
) -> Result<(), FormatError> {
    let file = std::fs::File::create(output_path)?;
    let mut zip = zip::ZipWriter::new(file);
    let options = FileOptions::<()>::default().compression_method(CompressionMethod::Deflated);

    // Write package.json
    let pkg_json = serde_json::to_string_pretty(&request.package)?;
    zip.start_file("package.json", options.clone())?;
    zip.write_all(pkg_json.as_bytes())?;

    // Collect sheets to export
    let selected_sheets: Vec<(usize, &persistence::Sheet)> = request
        .sheet_indices
        .iter()
        .filter_map(|&idx| workbook.sheets.get(idx).map(|s| (idx, s)))
        .collect();

    // Build and write manifest.json for the included sheets
    if !selected_sheets.is_empty() {
        let sheet_names: Vec<String> = selected_sheets.iter().map(|(_, s)| s.name.clone()).collect();
        let manifest = Manifest::from_sheet_names(&sheet_names, 0);
        let manifest_json = serde_json::to_string_pretty(&manifest)?;
        zip.start_file("manifest.json", options.clone())?;
        zip.write_all(manifest_json.as_bytes())?;

        // Write styles registry from the first selected sheet
        if let Some((_, sheet)) = selected_sheets.first() {
            let registry_json = serialize_style_registry(&sheet.styles)?;
            zip.start_file("styles/registry.json", options.clone())?;
            zip.write_all(registry_json.as_bytes())?;
        }

        // Write each selected sheet
        for (new_idx, (_, sheet)) in selected_sheets.iter().enumerate() {
            let folder = format!("{}_{}", new_idx, sanitize_folder_name(&sheet.name));
            let base_path = format!("sheets/{}", folder);

            // data.json
            let sheet_data = cells_to_sheet_data(&sheet.cells);
            let data_json = serde_json::to_string_pretty(&sheet_data)?;
            zip.start_file(format!("{}/data.json", base_path), options.clone())?;
            zip.write_all(data_json.as_bytes())?;

            // styles.json
            let sheet_styles = cells_to_sheet_styles(&sheet.cells);
            if !sheet_styles.cells.is_empty() {
                let styles_json = serde_json::to_string_pretty(&sheet_styles)?;
                zip.start_file(format!("{}/styles.json", base_path), options.clone())?;
                zip.write_all(styles_json.as_bytes())?;
            }

            // layout.json
            let layout = SheetLayout::from_dimensions(&sheet.column_widths, &sheet.row_heights);
            if !layout.column_widths.is_empty() || !layout.row_heights.is_empty() {
                let layout_json = serde_json::to_string_pretty(&layout)?;
                zip.start_file(format!("{}/layout.json", base_path), options.clone())?;
                zip.write_all(layout_json.as_bytes())?;
            }
        }
    }

    // Write selected tables
    for &table_id in &request.table_ids {
        if let Some(table) = workbook.tables.iter().find(|t| t.id == table_id) {
            let table_def = TableDef::from(table);
            let table_json = serde_json::to_string_pretty(&table_def)?;
            zip.start_file(format!("tables/table_{}.json", table.id), options.clone())?;
            zip.write_all(table_json.as_bytes())?;
        }
    }

    // Write selected user files
    for file_path in &request.file_paths {
        if let Some(content) = workbook.user_files.get(file_path) {
            zip.start_file(format!("files/{}", file_path), options.clone())?;
            zip.write_all(content)?;
        }
    }

    zip.finish()?;
    Ok(())
}

/// Sanitize a sheet name for use as a folder name.
fn sanitize_folder_name(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect()
}

/// Build the `contents` list for a PackageManifest from an export request.
/// This is a convenience helper for constructing the manifest before export.
pub fn build_contents_list(
    workbook: &Workbook,
    sheet_indices: &[usize],
    table_ids: &[u64],
    file_paths: &[String],
) -> Vec<PackageContent> {
    let mut contents = Vec::new();

    for (new_idx, &idx) in sheet_indices.iter().enumerate() {
        if let Some(sheet) = workbook.sheets.get(idx) {
            let folder = format!("{}_{}", new_idx, sanitize_folder_name(&sheet.name));
            contents.push(PackageContent {
                content_type: PackageContentType::Sheet,
                path: format!("sheets/{}", folder),
                name: sheet.name.clone(),
                description: None,
            });
        }
    }

    for &table_id in table_ids {
        if let Some(table) = workbook.tables.iter().find(|t| t.id == table_id) {
            contents.push(PackageContent {
                content_type: PackageContentType::Table,
                path: format!("tables/table_{}.json", table.id),
                name: table.name.clone(),
                description: None,
            });
        }
    }

    for file_path in file_paths {
        if workbook.user_files.contains_key(file_path) {
            contents.push(PackageContent {
                content_type: PackageContentType::File,
                path: format!("files/{}", file_path),
                name: file_path.clone(),
                description: None,
            });
        }
    }

    contents
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::package::parser::{parse_package, parse_package_metadata};
    use persistence::{SavedCell, SavedCellValue, Sheet};
    use std::collections::HashMap;

    fn make_test_workbook() -> Workbook {
        let mut cells = HashMap::new();
        cells.insert(
            (0, 0),
            SavedCell {
                value: SavedCellValue::Text("Name".to_string()),
                formula: None,
                style_index: 0,
                rich_text: None,
            },
        );
        cells.insert(
            (1, 0),
            SavedCell {
                value: SavedCellValue::Number(100.0),
                formula: Some("=B2*2".to_string()),
                style_index: 0,
                rich_text: None,
            },
        );

        let sheet = Sheet {
            name: "Dashboard".to_string(),
            cells,
            column_widths: HashMap::new(),
            row_heights: HashMap::new(),
            styles: vec![engine::style::CellStyle::new()],
        };

        Workbook {
            sheets: vec![sheet],
            active_sheet: 0,
            tables: vec![],
            slicers: vec![],
            user_files: HashMap::new(),
        }
    }

    #[test]
    fn test_export_and_parse_roundtrip() {
        let workbook = make_test_workbook();
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("test.calp");

        let contents = build_contents_list(&workbook, &[0], &[], &[]);
        let request = ExportRequest {
            package: PackageManifest {
                id: "com.test.dashboard".to_string(),
                name: "Dashboard Package".to_string(),
                version: "1.0.0".to_string(),
                description: "Test dashboard".to_string(),
                author: "Test".to_string(),
                tags: vec![],
                contents,
                data_sources: vec![],
                min_calc_version: None,
                required_extensions: vec![],
            },
            sheet_indices: vec![0],
            table_ids: vec![],
            file_paths: vec![],
        };

        export_package(&workbook, &request, &output).unwrap();

        // Parse it back
        let parsed = parse_package(&output).unwrap();
        assert_eq!(parsed.package.id, "com.test.dashboard");
        assert_eq!(parsed.workbook.sheets.len(), 1);
        assert_eq!(parsed.workbook.sheets[0].name, "Dashboard");

        // Verify cell content survived the roundtrip
        let cells = &parsed.workbook.sheets[0].cells;
        let a1 = &cells[&(0, 0)];
        assert!(matches!(&a1.value, SavedCellValue::Text(s) if s == "Name"));

        let a2 = &cells[&(1, 0)];
        assert!(matches!(&a2.value, SavedCellValue::Number(n) if *n == 100.0));
        assert_eq!(a2.formula, Some("=B2*2".to_string()));
    }

    #[test]
    fn test_export_metadata_only() {
        let workbook = make_test_workbook();
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("meta.calp");

        let request = ExportRequest {
            package: PackageManifest {
                id: "com.test.meta".to_string(),
                name: "Metadata Test".to_string(),
                version: "0.1.0".to_string(),
                description: String::new(),
                author: String::new(),
                tags: vec!["test".to_string()],
                contents: vec![],
                data_sources: vec![],
                min_calc_version: None,
                required_extensions: vec![],
            },
            sheet_indices: vec![],
            table_ids: vec![],
            file_paths: vec![],
        };

        export_package(&workbook, &request, &output).unwrap();

        let metadata = parse_package_metadata(&output).unwrap();
        assert_eq!(metadata.id, "com.test.meta");
        assert_eq!(metadata.tags, vec!["test"]);
    }

    #[test]
    fn test_export_with_tables() {
        let mut workbook = make_test_workbook();
        workbook.tables.push(persistence::SavedTable {
            id: 1,
            name: "SalesTable".to_string(),
            sheet_index: 0,
            start_row: 0,
            start_col: 0,
            end_row: 1,
            end_col: 0,
            columns: vec![persistence::SavedTableColumn {
                id: 0,
                name: "Name".to_string(),
                totals_row_function: "none".to_string(),
                totals_row_formula: None,
                calculated_formula: None,
            }],
            style_options: persistence::SavedTableStyleOptions {
                banded_rows: true,
                banded_columns: false,
                header_row: true,
                total_row: false,
                first_column: false,
                last_column: false,
                show_filter_button: true,
            },
            style_name: "TableStyleMedium2".to_string(),
        });

        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("with_tables.calp");

        let contents = build_contents_list(&workbook, &[0], &[1], &[]);
        let request = ExportRequest {
            package: PackageManifest {
                id: "com.test.tables".to_string(),
                name: "Table Package".to_string(),
                version: "1.0.0".to_string(),
                description: String::new(),
                author: String::new(),
                tags: vec![],
                contents,
                data_sources: vec![],
                min_calc_version: None,
                required_extensions: vec![],
            },
            sheet_indices: vec![0],
            table_ids: vec![1],
            file_paths: vec![],
        };

        export_package(&workbook, &request, &output).unwrap();

        let parsed = parse_package(&output).unwrap();
        assert_eq!(parsed.workbook.sheets.len(), 1);
        assert_eq!(parsed.workbook.tables.len(), 1);
        assert_eq!(parsed.workbook.tables[0].name, "SalesTable");
    }

    #[test]
    fn test_export_with_user_files() {
        let mut workbook = make_test_workbook();
        workbook
            .user_files
            .insert("README.md".to_string(), b"# Hello\nThis is a test.".to_vec());

        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("with_files.calp");

        let contents = build_contents_list(&workbook, &[], &[], &["README.md".to_string()]);
        let request = ExportRequest {
            package: PackageManifest {
                id: "com.test.files".to_string(),
                name: "File Package".to_string(),
                version: "1.0.0".to_string(),
                description: String::new(),
                author: String::new(),
                tags: vec![],
                contents,
                data_sources: vec![],
                min_calc_version: None,
                required_extensions: vec![],
            },
            sheet_indices: vec![],
            table_ids: vec![],
            file_paths: vec!["README.md".to_string()],
        };

        export_package(&workbook, &request, &output).unwrap();

        let parsed = parse_package(&output).unwrap();
        assert_eq!(parsed.workbook.user_files.len(), 1);
        let content = &parsed.workbook.user_files["README.md"];
        assert_eq!(std::str::from_utf8(content).unwrap(), "# Hello\nThis is a test.");
    }

    #[test]
    fn test_build_contents_list() {
        let mut workbook = make_test_workbook();
        workbook.tables.push(persistence::SavedTable {
            id: 5,
            name: "MyTable".to_string(),
            sheet_index: 0,
            start_row: 0,
            start_col: 0,
            end_row: 1,
            end_col: 0,
            columns: vec![],
            style_options: persistence::SavedTableStyleOptions {
                banded_rows: false,
                banded_columns: false,
                header_row: true,
                total_row: false,
                first_column: false,
                last_column: false,
                show_filter_button: false,
            },
            style_name: "Default".to_string(),
        });
        workbook
            .user_files
            .insert("notes.txt".to_string(), b"test".to_vec());

        let contents = build_contents_list(
            &workbook,
            &[0],
            &[5],
            &["notes.txt".to_string()],
        );

        assert_eq!(contents.len(), 3);
        assert_eq!(contents[0].content_type, PackageContentType::Sheet);
        assert_eq!(contents[0].name, "Dashboard");
        assert_eq!(contents[1].content_type, PackageContentType::Table);
        assert_eq!(contents[1].name, "MyTable");
        assert_eq!(contents[2].content_type, PackageContentType::File);
        assert_eq!(contents[2].name, "notes.txt");
    }
}
