//! FILENAME: core/calcula-format/src/zip_io.rs
//! ZIP archive read/write for the .cala format.
//!
//! Writes and reads the structured ZIP containing manifest, sheets, styles, and features.

use crate::error::FormatError;
use crate::features::tables::TableDef;
use crate::features::slicers::SlicerDef;
use crate::features::ribbon_filters::RibbonFilterDef;
use crate::features::scripts::ScriptDef;
use crate::features::notebooks::NotebookDef;
use crate::features::pivot_layouts::PivotLayoutDef;
use crate::manifest::Manifest;
use crate::sheet_data::{cells_to_sheet_data, sheet_data_to_cells, SheetData};
use crate::sheet_layout::SheetLayout;
use crate::sheet_styles::{
    apply_sheet_styles, cells_to_sheet_styles,
    serialize_style_registry, SheetStyles,
};

use engine::theme::ThemeDefinition;
use persistence::{SavedChart, SavedNotebook, SavedPivotLayout, SavedRibbonFilter, SavedScript, SavedSlicer, SavedSparkline, SavedTable, Workbook, WorkbookProperties};
use std::io::{Read, Write};
use std::path::Path;
use zip::write::FileOptions;
use zip::CompressionMethod;

/// Write a Workbook to a .cala ZIP file.
pub fn write_calcula(workbook: &Workbook, path: &Path) -> Result<(), FormatError> {
    let file = std::fs::File::create(path)?;
    let mut zip = zip::ZipWriter::new(file);
    let options = FileOptions::<()>::default().compression_method(CompressionMethod::Deflated);

    // Build manifest
    let sheet_names: Vec<String> = workbook.sheets.iter().map(|s| s.name.clone()).collect();
    let mut manifest = Manifest::from_sheet_names(&sheet_names, workbook.active_sheet);

    // Track which features are present
    if !workbook.tables.is_empty() {
        manifest.features.push("tables".to_string());
    }
    if !workbook.slicers.is_empty() {
        manifest.features.push("slicers".to_string());
    }
    if !workbook.ribbon_filters.is_empty() {
        manifest.features.push("ribbon_filters".to_string());
    }
    if !workbook.scripts.is_empty() {
        manifest.features.push("scripts".to_string());
    }
    if !workbook.notebooks.is_empty() {
        manifest.features.push("notebooks".to_string());
    }
    if !workbook.charts.is_empty() {
        manifest.features.push("charts".to_string());
    }
    if !workbook.pivot_layouts.is_empty() {
        manifest.features.push("pivot_layouts".to_string());
    }
    if !workbook.user_files.is_empty() {
        manifest.features.push("files".to_string());
    }
    manifest.features.push("theme".to_string());

    // Store default dimensions in manifest
    manifest.default_row_height = workbook.default_row_height;
    manifest.default_column_width = workbook.default_column_width;

    // Write manifest.json
    let manifest_json = serde_json::to_string_pretty(&manifest)?;
    zip.start_file("manifest.json", options.clone())?;
    zip.write_all(manifest_json.as_bytes())?;

    // Write theme.json (document theme)
    let theme_json = serde_json::to_string_pretty(&workbook.theme)?;
    zip.start_file("theme.json", options.clone())?;
    zip.write_all(theme_json.as_bytes())?;

    // Write styles/registry.json (use first sheet's styles as the shared registry)
    if let Some(sheet) = workbook.sheets.first() {
        let registry_json = serialize_style_registry(&sheet.styles)?;
        zip.start_file("styles/registry.json", options.clone())?;
        zip.write_all(registry_json.as_bytes())?;
    }

    // Write each sheet
    for (i, sheet) in workbook.sheets.iter().enumerate() {
        let folder = &manifest.sheets[i].folder;
        let base_path = format!("sheets/{}", folder);

        // data.json — sparse cell values and formulas
        let sheet_data = cells_to_sheet_data(&sheet.cells);
        let data_json = serde_json::to_string_pretty(&sheet_data)?;
        zip.start_file(format!("{}/data.json", base_path), options.clone())?;
        zip.write_all(data_json.as_bytes())?;

        // styles.json — cell style index assignments
        let sheet_styles = cells_to_sheet_styles(&sheet.cells);
        if !sheet_styles.cells.is_empty() {
            let styles_json = serde_json::to_string_pretty(&sheet_styles)?;
            zip.start_file(format!("{}/styles.json", base_path), options.clone())?;
            zip.write_all(styles_json.as_bytes())?;
        }

        // layout.json — column widths, row heights
        let layout = SheetLayout::from_dimensions(&sheet.column_widths, &sheet.row_heights);
        if !layout.column_widths.is_empty() || !layout.row_heights.is_empty() {
            let layout_json = serde_json::to_string_pretty(&layout)?;
            zip.start_file(format!("{}/layout.json", base_path), options.clone())?;
            zip.write_all(layout_json.as_bytes())?;
        }
    }

    // Write tables
    for table in &workbook.tables {
        let table_def = TableDef::from(table);
        let table_json = serde_json::to_string_pretty(&table_def)?;
        zip.start_file(
            format!("tables/table_{}.json", table.id),
            options.clone(),
        )?;
        zip.write_all(table_json.as_bytes())?;
    }

    // Write slicers
    for slicer in &workbook.slicers {
        let slicer_def = SlicerDef::from(slicer);
        let slicer_json = serde_json::to_string_pretty(&slicer_def)?;
        zip.start_file(
            format!("slicers/slicer_{}.json", slicer.id),
            options.clone(),
        )?;
        zip.write_all(slicer_json.as_bytes())?;
    }

    // Write pivot layouts
    for layout in &workbook.pivot_layouts {
        let layout_def = PivotLayoutDef::from(layout);
        let layout_json = serde_json::to_string_pretty(&layout_def)?;
        zip.start_file(
            format!("pivot_layouts/layout_{}.json", layout.id),
            options.clone(),
        )?;
        zip.write_all(layout_json.as_bytes())?;
    }

    // Write ribbon filters
    for ribbon_filter in &workbook.ribbon_filters {
        let filter_def = RibbonFilterDef::from(ribbon_filter);
        let filter_json = serde_json::to_string_pretty(&filter_def)?;
        zip.start_file(
            format!("ribbon_filters/filter_{}.json", ribbon_filter.id),
            options.clone(),
        )?;
        zip.write_all(filter_json.as_bytes())?;
    }

    // Write scripts
    for script in &workbook.scripts {
        let script_def = ScriptDef::from(script);
        let script_json = serde_json::to_string_pretty(&script_def)?;
        zip.start_file(
            format!("scripts/script_{}.json", script.id),
            options.clone(),
        )?;
        zip.write_all(script_json.as_bytes())?;
    }

    // Write notebooks
    for notebook in &workbook.notebooks {
        let notebook_def = NotebookDef::from(notebook);
        let notebook_json = serde_json::to_string_pretty(&notebook_def)?;
        zip.start_file(
            format!("notebooks/notebook_{}.json", notebook.id),
            options.clone(),
        )?;
        zip.write_all(notebook_json.as_bytes())?;
    }

    // Write charts as a single charts.json array
    if !workbook.charts.is_empty() {
        let charts_json = serde_json::to_string_pretty(&workbook.charts)?;
        zip.start_file("charts.json", options.clone())?;
        zip.write_all(charts_json.as_bytes())?;
    }

    // Write sparklines as a single sparklines.json array
    if !workbook.sparklines.is_empty() {
        let sparklines_json = serde_json::to_string_pretty(&workbook.sparklines)?;
        zip.start_file("sparklines.json", options.clone())?;
        zip.write_all(sparklines_json.as_bytes())?;
    }

    // Write workbook properties (properties.json)
    let props_json = serde_json::to_string_pretty(&workbook.properties)?;
    zip.start_file("properties.json", options.clone())?;
    zip.write_all(props_json.as_bytes())?;

    // Write user files (stored under files/ prefix)
    for (path, content) in &workbook.user_files {
        zip.start_file(format!("files/{}", path), options.clone())?;
        zip.write_all(content)?;
    }

    zip.finish()?;
    Ok(())
}

/// Read a Workbook from a .cala ZIP file.
pub fn read_calcula(path: &Path) -> Result<Workbook, FormatError> {
    let file = std::fs::File::open(path)?;
    let mut archive = zip::ZipArchive::new(file)?;

    // Read manifest.json
    let manifest: Manifest = {
        let mut entry = archive
            .by_name("manifest.json")
            .map_err(|_| FormatError::MissingEntry("manifest.json".to_string()))?;
        let mut contents = String::new();
        entry.read_to_string(&mut contents)?;
        serde_json::from_str(&contents)?
    };

    if manifest.format_version != 1 {
        return Err(FormatError::InvalidFormat(format!(
            "Unsupported format version: {}",
            manifest.format_version
        )));
    }

    // Read theme.json (document theme)
    let theme = read_optional_json::<ThemeDefinition>(&mut archive, "theme.json")?
        .unwrap_or_default();

    // Read styles/registry.json
    let style_list = read_optional_json::<Vec<engine::style::CellStyle>>(
        &mut archive,
        "styles/registry.json",
    )?
    .unwrap_or_else(|| vec![engine::style::CellStyle::new()]);

    // Read each sheet
    let mut sheets = Vec::new();
    for sheet_entry in &manifest.sheets {
        let base_path = format!("sheets/{}", sheet_entry.folder);

        // data.json
        let sheet_data = read_optional_json::<SheetData>(&mut archive, &format!("{}/data.json", base_path))?
            .unwrap_or(SheetData {
                cells: std::collections::BTreeMap::new(),
            });
        let mut cells = sheet_data_to_cells(&sheet_data);

        // styles.json
        if let Some(sheet_styles) =
            read_optional_json::<SheetStyles>(&mut archive, &format!("{}/styles.json", base_path))?
        {
            apply_sheet_styles(&mut cells, &sheet_styles);
        }

        // layout.json
        let layout = read_optional_json::<SheetLayout>(
            &mut archive,
            &format!("{}/layout.json", base_path),
        )?
        .unwrap_or(SheetLayout {
            column_widths: std::collections::BTreeMap::new(),
            row_heights: std::collections::BTreeMap::new(),
        });
        let (col_widths, row_heights) = layout.to_dimensions();

        sheets.push(persistence::Sheet {
            name: sheet_entry.name.clone(),
            cells,
            column_widths: col_widths,
            row_heights: row_heights,
            styles: style_list.clone(),
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
        });
    }

    // Read tables
    let mut tables: Vec<SavedTable> = Vec::new();
    if manifest.features.contains(&"tables".to_string()) {
        // Scan for table files
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
            if let Some(table_def) = read_optional_json::<TableDef>(&mut archive, &table_name)? {
                tables.push(SavedTable::from(&table_def));
            }
        }
    }

    // Read slicers
    let mut slicers: Vec<SavedSlicer> = Vec::new();
    if manifest.features.contains(&"slicers".to_string()) {
        let slicer_names: Vec<String> = (0..archive.len())
            .filter_map(|i| {
                let entry = archive.by_index(i).ok()?;
                let name = entry.name().to_string();
                if name.starts_with("slicers/") && name.ends_with(".json") {
                    Some(name)
                } else {
                    None
                }
            })
            .collect();

        for slicer_name in slicer_names {
            if let Some(slicer_def) = read_optional_json::<SlicerDef>(&mut archive, &slicer_name)? {
                slicers.push(SavedSlicer::from(&slicer_def));
            }
        }
    }

    // Read pivot layouts
    let mut pivot_layouts: Vec<SavedPivotLayout> = Vec::new();
    if manifest.features.contains(&"pivot_layouts".to_string()) {
        let layout_names: Vec<String> = (0..archive.len())
            .filter_map(|i| {
                let entry = archive.by_index(i).ok()?;
                let name = entry.name().to_string();
                if name.starts_with("pivot_layouts/") && name.ends_with(".json") {
                    Some(name)
                } else {
                    None
                }
            })
            .collect();

        for layout_name in layout_names {
            if let Some(layout_def) = read_optional_json::<PivotLayoutDef>(&mut archive, &layout_name)? {
                pivot_layouts.push(SavedPivotLayout::from(&layout_def));
            }
        }
    }

    // Read ribbon filters
    let mut ribbon_filters: Vec<SavedRibbonFilter> = Vec::new();
    if manifest.features.contains(&"ribbon_filters".to_string()) {
        let filter_names: Vec<String> = (0..archive.len())
            .filter_map(|i| {
                let entry = archive.by_index(i).ok()?;
                let name = entry.name().to_string();
                if name.starts_with("ribbon_filters/") && name.ends_with(".json") {
                    Some(name)
                } else {
                    None
                }
            })
            .collect();

        for filter_name in filter_names {
            if let Some(filter_def) = read_optional_json::<RibbonFilterDef>(&mut archive, &filter_name)? {
                ribbon_filters.push(SavedRibbonFilter::from(&filter_def));
            }
        }
    }

    // Read scripts
    let mut scripts: Vec<SavedScript> = Vec::new();
    if manifest.features.contains(&"scripts".to_string()) {
        let script_names: Vec<String> = (0..archive.len())
            .filter_map(|i| {
                let entry = archive.by_index(i).ok()?;
                let name = entry.name().to_string();
                if name.starts_with("scripts/") && name.ends_with(".json") {
                    Some(name)
                } else {
                    None
                }
            })
            .collect();

        for script_name in script_names {
            if let Some(script_def) = read_optional_json::<ScriptDef>(&mut archive, &script_name)? {
                scripts.push(SavedScript::from(&script_def));
            }
        }
    }

    // Read notebooks
    let mut notebooks: Vec<SavedNotebook> = Vec::new();
    if manifest.features.contains(&"notebooks".to_string()) {
        let notebook_names: Vec<String> = (0..archive.len())
            .filter_map(|i| {
                let entry = archive.by_index(i).ok()?;
                let name = entry.name().to_string();
                if name.starts_with("notebooks/") && name.ends_with(".json") {
                    Some(name)
                } else {
                    None
                }
            })
            .collect();

        for notebook_name in notebook_names {
            if let Some(notebook_def) = read_optional_json::<NotebookDef>(&mut archive, &notebook_name)? {
                notebooks.push(SavedNotebook::from(&notebook_def));
            }
        }
    }

    // Read charts
    let charts: Vec<SavedChart> = if manifest.features.contains(&"charts".to_string()) {
        read_optional_json::<Vec<SavedChart>>(&mut archive, "charts.json")?
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    // Read sparklines
    let sparklines: Vec<SavedSparkline> =
        read_optional_json::<Vec<SavedSparkline>>(&mut archive, "sparklines.json")?
            .unwrap_or_default();

    // Read user files (files/ prefix)
    let mut user_files = std::collections::HashMap::new();
    if manifest.features.contains(&"files".to_string()) {
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
            let mut entry = archive.by_name(&file_name)
                .map_err(|e| FormatError::Zip(e))?;
            let mut content = Vec::new();
            entry.read_to_end(&mut content)?;
            // Strip the "files/" prefix
            let relative_path = file_name[6..].to_string();
            user_files.insert(relative_path, content);
        }
    }

    // Read workbook properties
    let properties = read_optional_json::<WorkbookProperties>(&mut archive, "properties.json")?
        .unwrap_or_default();

    Ok(Workbook {
        sheets,
        active_sheet: manifest.active_sheet,
        tables,
        slicers,
        ribbon_filters,
        user_files,
        theme,
        scripts,
        notebooks,
        default_row_height: manifest.default_row_height,
        default_column_width: manifest.default_column_width,
        properties,
        charts,
        sparklines,
        named_ranges: Vec::new(),
        pivot_layouts,
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
    use persistence::{SavedCell, SavedCellValue};
    use std::collections::HashMap;

    fn make_test_workbook() -> Workbook {
        let mut cells = HashMap::new();
        cells.insert(
            (0, 0),
            SavedCell {
                value: SavedCellValue::Text("Name".to_string()),
                formula: None,
                style_index: 1,
                rich_text: None,
            },
        );
        cells.insert(
            (0, 1),
            SavedCell {
                value: SavedCellValue::Text("Value".to_string()),
                formula: None,
                style_index: 1,
                rich_text: None,
            },
        );
        cells.insert(
            (1, 0),
            SavedCell {
                value: SavedCellValue::Text("Revenue".to_string()),
                formula: None,
                style_index: 0,
                rich_text: None,
            },
        );
        cells.insert(
            (1, 1),
            SavedCell {
                value: SavedCellValue::Number(42500.0),
                formula: Some("=SUM(C2:C100)".to_string()),
                style_index: 2,
                rich_text: None,
            },
        );
        cells.insert(
            (2, 0),
            SavedCell {
                value: SavedCellValue::Boolean(true),
                formula: None,
                style_index: 0,
                rich_text: None,
            },
        );

        let styles = vec![
            engine::style::CellStyle::new(),
            engine::style::CellStyle::new().with_bold(true),
            engine::style::CellStyle::new()
                .with_number_format(engine::style::NumberFormat::Currency {
                    decimal_places: 2,
                    symbol: "$".to_string(),
                    symbol_position: engine::style::CurrencyPosition::Before,
                }),
        ];

        let mut col_widths = HashMap::new();
        col_widths.insert(0, 150.0);
        col_widths.insert(1, 120.0);

        let mut row_heights = HashMap::new();
        row_heights.insert(0, 25.0);

        let sheet = persistence::Sheet {
            name: "Sales Data".to_string(),
            cells,
            column_widths: col_widths,
            row_heights: row_heights,
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
        };

        Workbook {
            sheets: vec![sheet],
            active_sheet: 0,
            tables: vec![],
            slicers: vec![],
            ribbon_filters: vec![],
            user_files: HashMap::new(),
            theme: ThemeDefinition::default(),
            scripts: Vec::new(),
            notebooks: Vec::new(),
            default_row_height: 24.0,
            default_column_width: 100.0,
            properties: WorkbookProperties::default(),
            charts: Vec::new(),
            sparklines: Vec::new(),
            named_ranges: Vec::new(),
            pivot_layouts: Vec::new(),
        }
    }

    #[test]
    fn test_roundtrip_basic() {
        let workbook = make_test_workbook();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.cala");

        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.sheets.len(), 1);
        assert_eq!(loaded.sheets[0].name, "Sales Data");
        assert_eq!(loaded.active_sheet, 0);

        // Check cells
        let cells = &loaded.sheets[0].cells;
        assert!(cells.len() >= 4); // At least the non-empty cells

        // Check A1 = "Name" with style 1
        let a1 = &cells[&(0, 0)];
        assert!(matches!(&a1.value, SavedCellValue::Text(s) if s == "Name"));
        assert_eq!(a1.style_index, 1);

        // Check B2 = 42500.0 with formula
        let b2 = &cells[&(1, 1)];
        assert!(matches!(&b2.value, SavedCellValue::Number(n) if *n == 42500.0));
        assert_eq!(b2.formula, Some("=SUM(C2:C100)".to_string()));
        assert_eq!(b2.style_index, 2);

        // Check A3 = true
        let a3 = &cells[&(2, 0)];
        assert!(matches!(&a3.value, SavedCellValue::Boolean(true)));

        // Check layout
        assert_eq!(loaded.sheets[0].column_widths[&0], 150.0);
        assert_eq!(loaded.sheets[0].column_widths[&1], 120.0);
        assert_eq!(loaded.sheets[0].row_heights[&0], 25.0);

        // Check styles
        assert_eq!(loaded.sheets[0].styles.len(), 3);
        assert!(loaded.sheets[0].styles[1].font.bold);
    }

    #[test]
    fn test_roundtrip_with_tables() {
        let mut workbook = make_test_workbook();
        workbook.tables.push(persistence::SavedTable {
            id: 1,
            name: "SalesTable".to_string(),
            sheet_index: 0,
            start_row: 0,
            start_col: 0,
            end_row: 2,
            end_col: 1,
            columns: vec![
                persistence::SavedTableColumn {
                    id: 0,
                    name: "Name".to_string(),
                    totals_row_function: "none".to_string(),
                    totals_row_formula: None,
                    calculated_formula: None,
                },
                persistence::SavedTableColumn {
                    id: 1,
                    name: "Value".to_string(),
                    totals_row_function: "sum".to_string(),
                    totals_row_formula: None,
                    calculated_formula: None,
                },
            ],
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
        let path = dir.path().join("test_tables.cala");

        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.tables.len(), 1);
        assert_eq!(loaded.tables[0].name, "SalesTable");
        assert_eq!(loaded.tables[0].columns.len(), 2);
        assert_eq!(loaded.tables[0].style_options.banded_rows, true);
    }

    #[test]
    fn test_empty_workbook() {
        let workbook = Workbook::new();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.cala");

        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.sheets.len(), 1);
        assert_eq!(loaded.sheets[0].name, "Sheet1");
        assert!(loaded.sheets[0].cells.is_empty());
    }
}
