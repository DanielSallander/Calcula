//! FILENAME: core/calcula-format/src/zip_io.rs
//! ZIP archive read/write for the .cala format.
//!
//! Writes and reads the structured ZIP containing manifest, sheets, styles, and features.

use crate::error::FormatError;
use crate::features::tables::TableDef;
use crate::features::slicers::SlicerDef;
use crate::features::ribbon_filters::RibbonFilterDef;
use crate::features::pane_controls::PaneControlDef;
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
use identity::SheetId;
use crate::features::object_scripts::ObjectScriptDef;
use persistence::{SavedChart, SavedNotebook, SavedObjectScript, SavedPaneControl, SavedPivotLayout, SavedRibbonFilter, SavedScript, SavedSlicer, SavedSparkline, SavedTable, Workbook, WorkbookProperties};
use std::io::{Read, Write};
use zip::write::FileOptions;
use zip::CompressionMethod;

/// Build the complete `.cala` ZIP into a byte buffer (no file I/O). The host
/// wraps this — optionally encrypting it — and writes it atomically.
pub fn write_calcula_bytes(workbook: &Workbook) -> Result<Vec<u8>, FormatError> {
    let mut buf = Vec::new();
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
    let options = FileOptions::<()>::default().compression_method(CompressionMethod::Deflated);

    // Build manifest with sheet IDs
    let sheet_names: Vec<String> = workbook.sheets.iter().map(|s| s.name.clone()).collect();
    let sheet_ids: Vec<SheetId> = workbook.sheets.iter().map(|s| s.id).collect();
    let mut manifest = Manifest::from_sheets(&sheet_names, &sheet_ids, workbook.active_sheet);

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
    if !workbook.pane_controls.is_empty() {
        manifest.features.push("pane_controls".to_string());
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
    if !workbook.pivot_definitions.is_empty() {
        manifest.features.push("pivot_definitions".to_string());
    }
    if !workbook.bi_pivot_metadata.is_empty() {
        manifest.features.push("bi_pivot_metadata".to_string());
    }
    if !workbook.object_scripts.is_empty() {
        manifest.features.push("object_scripts".to_string());
    }
    if !workbook.bi_connection_roles.is_empty() {
        manifest.features.push("bi_connection_roles".to_string());
    }
    if !workbook.bi_connections.is_empty() {
        manifest.features.push("bi_connections".to_string());
    }
    if !workbook.bi_connection_caches.is_empty() {
        manifest.features.push("bi_connection_caches".to_string());
    }
    if !workbook.extension_data.is_empty() {
        manifest.features.push("extension_data".to_string());
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

        // metadata.json — merges, freeze panes, hidden rows/cols, tab color,
        // visibility, notes, hyperlinks, page setup, gridlines. Without this
        // file the format silently dropped all of these (BUG-0018 etc.).
        let metadata = crate::sheet_metadata::SheetMetadata::from_sheet(sheet);
        if !metadata.is_default() {
            let metadata_json = serde_json::to_string_pretty(&metadata)?;
            zip.start_file(format!("{}/metadata.json", base_path), options.clone())?;
            zip.write_all(metadata_json.as_bytes())?;
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

    // Write full pivot definitions (PivotDefinition as JSON)
    for pivot_def in &workbook.pivot_definitions {
        let json = serde_json::to_string_pretty(pivot_def)?;
        zip.start_file(
            format!("pivot_definitions/def_{}.json", pivot_def.id),
            options.clone(),
        )?;
        zip.write_all(json.as_bytes())?;
    }

    // Write BI pivot metadata
    for (i, bi_meta) in workbook.bi_pivot_metadata.iter().enumerate() {
        let json = serde_json::to_string_pretty(bi_meta)?;
        zip.start_file(
            format!("bi_pivot_metadata/meta_{}.json", i),
            options.clone(),
        )?;
        zip.write_all(json.as_bytes())?;
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

    // Write pane controls (Controls Pane)
    for pane_control in &workbook.pane_controls {
        let control_def = PaneControlDef::from(pane_control);
        let control_json = serde_json::to_string_pretty(&control_def)?;
        zip.start_file(
            format!("pane_controls/control_{}.json", pane_control.id),
            options.clone(),
        )?;
        zip.write_all(control_json.as_bytes())?;
    }

    // Write object scripts (scriptable objects)
    for obj_script in &workbook.object_scripts {
        let obj_script_def = ObjectScriptDef::from(obj_script);
        let obj_script_json = serde_json::to_string_pretty(&obj_script_def)?;
        zip.start_file(
            format!("object_scripts/script_{}.json", obj_script.id),
            options.clone(),
        )?;
        zip.write_all(obj_script_json.as_bytes())?;
    }

    // Write BI connection RLS roles (subscriber "view as" selections)
    if !workbook.bi_connection_roles.is_empty() {
        let roles_json = serde_json::to_string_pretty(&workbook.bi_connection_roles)?;
        zip.start_file("bi_connection_roles.json", options.clone())?;
        zip.write_all(roles_json.as_bytes())?;
    }

    // Write locally-authored BI connections (embedded model + spec + bindings).
    // One file each — embedded models can be large.
    for (i, conn) in workbook.bi_connections.iter().enumerate() {
        let conn_json = serde_json::to_string_pretty(conn)?;
        zip.start_file(format!("bi_connections/conn_{}.json", i), options.clone())?;
        zip.write_all(conn_json.as_bytes())?;
    }

    // Write embedded BI cache blobs as raw binary entries under
    // bi_cache/{connId}/{relfile} (connId is a UUID, relfile is an engine-
    // sanitized cache file name — neither contains path separators).
    for (conn_id, files) in &workbook.bi_connection_caches {
        for (rel, bytes) in files {
            zip.start_file(format!("bi_cache/{}/{}", conn_id, rel), options.clone())?;
            zip.write_all(bytes)?;
        }
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

    // Write named ranges (defined names) as a single named_ranges.json array.
    // Read unconditionally on load (like sparklines), so no manifest feature flag
    // is needed and older files without the artifact load as an empty set.
    if !workbook.named_ranges.is_empty() {
        let named_ranges_json = serde_json::to_string_pretty(&workbook.named_ranges)?;
        zip.start_file("named_ranges.json", options.clone())?;
        zip.write_all(named_ranges_json.as_bytes())?;
    }

    // Write conditional formats + data validations (per-sheet, opaque payloads).
    // Same unconditional-read pattern as named_ranges/sparklines.
    if !workbook.conditional_formats.is_empty() {
        let cf_json = serde_json::to_string_pretty(&workbook.conditional_formats)?;
        zip.start_file("conditional_formats.json", options.clone())?;
        zip.write_all(cf_json.as_bytes())?;
    }
    if !workbook.data_validations.is_empty() {
        let dv_json = serde_json::to_string_pretty(&workbook.data_validations)?;
        zip.start_file("data_validations.json", options.clone())?;
        zip.write_all(dv_json.as_bytes())?;
    }
    if !workbook.controls.is_empty() {
        let controls_json = serde_json::to_string_pretty(&workbook.controls)?;
        zip.start_file("controls.json", options.clone())?;
        zip.write_all(controls_json.as_bytes())?;
    }
    if !workbook.cell_types.is_empty() {
        let cell_types_json = serde_json::to_string_pretty(&workbook.cell_types)?;
        zip.start_file("cell_types.json", options.clone())?;
        zip.write_all(cell_types_json.as_bytes())?;
    }
    if !workbook.cell_behaviors.is_empty() {
        let cell_behaviors_json = serde_json::to_string_pretty(&workbook.cell_behaviors)?;
        zip.start_file("cell_behaviors.json", options.clone())?;
        zip.write_all(cell_behaviors_json.as_bytes())?;
    }

    // Write generic per-extension state as a single extension-data.json object
    if !workbook.extension_data.is_empty() {
        let extension_data_json = serde_json::to_string_pretty(&workbook.extension_data)?;
        zip.start_file("extension-data.json", options.clone())?;
        zip.write_all(extension_data_json.as_bytes())?;
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

    zip.finish()?; // consumes `zip`, releasing the &mut borrow of `buf`
    Ok(buf)
}

/// Parse a Workbook from `.cala` ZIP bytes (no file I/O). The host reads the
/// file, decrypts if needed, then calls this on the plain ZIP bytes.
pub fn read_calcula_bytes(bytes: &[u8]) -> Result<Workbook, FormatError> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))?;

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

        // Use stored sheet_id or mint a fresh one for old .cala files
        let sheet_id = sheet_entry.sheet_id.unwrap_or_else(|| {
            SheetId::from_bytes(identity::generate_uuid_v7())
        });

        let mut sheet = persistence::Sheet {
            id: sheet_id,
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
        };

        // metadata.json — merges, freeze, hidden rows/cols, tab color,
        // visibility, notes, hyperlinks, page setup, gridlines
        if let Some(metadata) = read_optional_json::<crate::sheet_metadata::SheetMetadata>(
            &mut archive,
            &format!("{}/metadata.json", base_path),
        )? {
            metadata.apply_to_sheet(&mut sheet);
        }

        sheets.push(sheet);
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

    // Read full pivot definitions
    let mut pivot_definitions: Vec<persistence::SavedPivotDefinition> = Vec::new();
    if manifest.features.contains(&"pivot_definitions".to_string()) {
        let def_names: Vec<String> = (0..archive.len())
            .filter_map(|i| {
                let entry = archive.by_index(i).ok()?;
                let name = entry.name().to_string();
                if name.starts_with("pivot_definitions/") && name.ends_with(".json") {
                    Some(name)
                } else {
                    None
                }
            })
            .collect();

        for def_name in def_names {
            if let Some(def) = read_optional_json::<persistence::SavedPivotDefinition>(&mut archive, &def_name)? {
                pivot_definitions.push(def);
            }
        }
    }

    // Read BI pivot metadata
    let mut bi_pivot_metadata: Vec<serde_json::Value> = Vec::new();
    if manifest.features.contains(&"bi_pivot_metadata".to_string()) {
        let meta_names: Vec<String> = (0..archive.len())
            .filter_map(|i| {
                let entry = archive.by_index(i).ok()?;
                let name = entry.name().to_string();
                if name.starts_with("bi_pivot_metadata/") && name.ends_with(".json") {
                    Some(name)
                } else {
                    None
                }
            })
            .collect();

        for meta_name in meta_names {
            if let Some(meta) = read_optional_json::<serde_json::Value>(&mut archive, &meta_name)? {
                bi_pivot_metadata.push(meta);
            }
        }
    }

    // Read object scripts (scriptable objects)
    let mut object_scripts: Vec<SavedObjectScript> = Vec::new();
    if manifest.features.contains(&"object_scripts".to_string()) {
        let obj_script_names: Vec<String> = (0..archive.len())
            .filter_map(|i| {
                let entry = archive.by_index(i).ok()?;
                let name = entry.name().to_string();
                if name.starts_with("object_scripts/") && name.ends_with(".json") {
                    Some(name)
                } else {
                    None
                }
            })
            .collect();

        for obj_script_name in obj_script_names {
            if let Some(obj_script_def) = read_optional_json::<ObjectScriptDef>(&mut archive, &obj_script_name)? {
                object_scripts.push(SavedObjectScript::from(&obj_script_def));
            }
        }
    }

    // Read BI connection RLS roles
    let mut bi_connection_roles: Vec<persistence::SavedBiConnectionRole> = Vec::new();
    if manifest.features.contains(&"bi_connection_roles".to_string()) {
        if let Some(roles) = read_optional_json::<Vec<persistence::SavedBiConnectionRole>>(
            &mut archive,
            "bi_connection_roles.json",
        )? {
            bi_connection_roles = roles;
        }
    }

    // Read locally-authored BI connections (embedded models)
    let mut bi_connections: Vec<persistence::SavedBiConnection> = Vec::new();
    if manifest.features.contains(&"bi_connections".to_string()) {
        let conn_names: Vec<String> = (0..archive.len())
            .filter_map(|i| {
                let entry = archive.by_index(i).ok()?;
                let name = entry.name().to_string();
                if name.starts_with("bi_connections/") && name.ends_with(".json") {
                    Some(name)
                } else {
                    None
                }
            })
            .collect();
        for conn_name in conn_names {
            if let Some(conn) =
                read_optional_json::<persistence::SavedBiConnection>(&mut archive, &conn_name)?
            {
                bi_connections.push(conn);
            }
        }
    }

    // Read embedded BI cache blobs: bi_cache/{connId}/{relfile} -> raw bytes
    let mut bi_connection_caches: std::collections::HashMap<String, std::collections::HashMap<String, Vec<u8>>> = std::collections::HashMap::new();
    if manifest.features.contains(&"bi_connection_caches".to_string()) {
        let cache_names: Vec<String> = (0..archive.len())
            .filter_map(|i| {
                let entry = archive.by_index(i).ok()?;
                let name = entry.name().to_string();
                if name.starts_with("bi_cache/") && !name.ends_with('/') {
                    Some(name)
                } else {
                    None
                }
            })
            .collect();
        for name in cache_names {
            // bi_cache/{connId}/{rel}
            let rest = &name["bi_cache/".len()..];
            let Some(slash) = rest.find('/') else { continue };
            let conn_id = rest[..slash].to_string();
            let rel = rest[slash + 1..].to_string();
            if conn_id.is_empty() || rel.is_empty() {
                continue;
            }
            let mut entry = archive.by_name(&name).map_err(FormatError::Zip)?;
            let mut content = Vec::new();
            entry.read_to_end(&mut content)?;
            bi_connection_caches.entry(conn_id).or_default().insert(rel, content);
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

    // Read pane controls (Controls Pane). Old files without the feature flag
    // load as an empty list.
    let mut pane_controls: Vec<SavedPaneControl> = Vec::new();
    if manifest.features.contains(&"pane_controls".to_string()) {
        let control_names: Vec<String> = (0..archive.len())
            .filter_map(|i| {
                let entry = archive.by_index(i).ok()?;
                let name = entry.name().to_string();
                if name.starts_with("pane_controls/") && name.ends_with(".json") {
                    Some(name)
                } else {
                    None
                }
            })
            .collect();

        for control_name in control_names {
            if let Some(control_def) = read_optional_json::<PaneControlDef>(&mut archive, &control_name)? {
                pane_controls.push(SavedPaneControl::from(&control_def));
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

    // Read named ranges (defined names)
    let named_ranges: Vec<persistence::SavedNamedRange> =
        read_optional_json::<Vec<persistence::SavedNamedRange>>(&mut archive, "named_ranges.json")?
            .unwrap_or_default();

    // Read conditional formats + data validations (per-sheet, opaque payloads)
    let conditional_formats: Vec<persistence::SavedSheetConditionalFormats> =
        read_optional_json::<Vec<persistence::SavedSheetConditionalFormats>>(&mut archive, "conditional_formats.json")?
            .unwrap_or_default();
    let data_validations: Vec<persistence::SavedSheetDataValidations> =
        read_optional_json::<Vec<persistence::SavedSheetDataValidations>>(&mut archive, "data_validations.json")?
            .unwrap_or_default();
    let controls: Vec<persistence::SavedSheetControls> =
        read_optional_json::<Vec<persistence::SavedSheetControls>>(&mut archive, "controls.json")?
            .unwrap_or_default();
    let cell_types: Vec<persistence::SavedSheetCellTypes> =
        read_optional_json::<Vec<persistence::SavedSheetCellTypes>>(&mut archive, "cell_types.json")?
            .unwrap_or_default();
    let cell_behaviors: Vec<persistence::SavedCellBehavior> =
        read_optional_json::<Vec<persistence::SavedCellBehavior>>(&mut archive, "cell_behaviors.json")?
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

    // Read generic per-extension persisted state (opaque per-extension JSON blobs).
    let extension_data = read_optional_json::<std::collections::HashMap<String, serde_json::Value>>(
        &mut archive,
        "extension-data.json",
    )?
    .unwrap_or_default();

    Ok(Workbook {
        sheets,
        active_sheet: manifest.active_sheet,
        tables,
        slicers,
        ribbon_filters,
        pane_controls,
        user_files,
        theme,
        scripts,
        notebooks,
        default_row_height: manifest.default_row_height,
        default_column_width: manifest.default_column_width,
        properties,
        charts,
        sparklines,
        named_ranges,
        pivot_layouts,
        pivot_definitions,
        bi_pivot_metadata,
        object_scripts,
        bi_connection_roles,
        bi_connections,
        bi_connection_caches,
        extension_data,
        conditional_formats,
        data_validations,
        controls,
        cell_types,
        cell_behaviors,
    })
}

/// Read an optional JSON file from the archive. Returns None if the file doesn't exist.
fn read_optional_json<T: serde::de::DeserializeOwned>(
    archive: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>,
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

    // Test shims: the public file API moved to the crate root (save_calcula /
    // load_calcula), and zip_io is now bytes-first. These keep the existing
    // round-trip tests writing/reading a real temp file via the bytes API.
    fn write_calcula(workbook: &Workbook, path: &std::path::Path) -> Result<(), FormatError> {
        std::fs::write(path, write_calcula_bytes(workbook)?)?;
        Ok(())
    }
    fn read_calcula(path: &std::path::Path) -> Result<Workbook, FormatError> {
        read_calcula_bytes(&std::fs::read(path)?)
    }

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
            id: SheetId::from_bytes(identity::generate_uuid_v7()),
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
            show_gridlines: true,
        };

        Workbook {
            sheets: vec![sheet],
            active_sheet: 0,
            tables: vec![],
            slicers: vec![],
            ribbon_filters: vec![],
            pane_controls: vec![],
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
            pivot_definitions: Vec::new(),
            bi_pivot_metadata: Vec::new(),
            object_scripts: Vec::new(),
            bi_connection_roles: Vec::new(),
            bi_connections: Vec::new(),
            bi_connection_caches: std::collections::HashMap::new(),
            extension_data: Default::default(),
            conditional_formats: Vec::new(),
            data_validations: Vec::new(),
            controls: Vec::new(),
            cell_types: Vec::new(),
            cell_behaviors: Vec::new(),
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

        // Sheet ID should survive the roundtrip
        assert_eq!(loaded.sheets[0].id, workbook.sheets[0].id);

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
    fn test_roundtrip_named_ranges() {
        // Regression: named ranges (defined names) were silently dropped on every
        // .cala save (writer had no branch; reader hardcoded Vec::new()).
        let mut workbook = make_test_workbook();
        let sheet_id = workbook.sheets[0].id;
        workbook.named_ranges = vec![
            persistence::SavedNamedRange {
                name: "TaxRate".to_string(),
                refers_to: "=0.25".to_string(),
                sheet_id: None, // workbook-scoped
                comment: Some("VAT".to_string()),
                folder: Some("Finance".to_string()),
            },
            persistence::SavedNamedRange {
                name: "SalesData".to_string(),
                refers_to: "Sales Data!$A$1:$B$10".to_string(),
                sheet_id: Some(sheet_id), // sheet-scoped
                comment: None,
                folder: None,
            },
        ];

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nr.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.named_ranges.len(), 2, "named ranges must survive the .cala round-trip");
        let tax = loaded.named_ranges.iter().find(|nr| nr.name == "TaxRate").expect("TaxRate present");
        assert_eq!(tax.refers_to, "=0.25");
        assert_eq!(tax.sheet_id, None);
        assert_eq!(tax.comment.as_deref(), Some("VAT"));
        assert_eq!(tax.folder.as_deref(), Some("Finance"));
        let sales = loaded.named_ranges.iter().find(|nr| nr.name == "SalesData").expect("SalesData present");
        assert_eq!(sales.sheet_id, Some(sheet_id), "sheet-scoped SheetId must round-trip");
    }

    #[test]
    fn test_roundtrip_slicer_biconnection_report_connection() {
        // Regression: a slicer Report-Connection to a BI connection deserialized
        // back to Table (the connected_sources match had no "biConnection" arm).
        let mut workbook = make_test_workbook();
        let sheet_id = workbook.sheets[0].id;
        let conn_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        workbook.slicers.push(persistence::SavedSlicer {
            id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            name: "Region".to_string(),
            header_text: None,
            sheet_id,
            x: 0.0, y: 0.0, width: 200.0, height: 150.0,
            source_type: persistence::SavedSlicerSourceType::BiConnection,
            cache_source_id: conn_id,
            field_name: "Region".to_string(),
            selected_items: None,
            show_header: true,
            columns: 1,
            style_preset: "default".to_string(),
            selection_mode: Default::default(),
            hide_no_data: false,
            indicate_no_data: true,
            sort_no_data_last: true,
            force_selection: false,
            show_select_all: false,
            arrangement: Default::default(),
            rows: 0,
            item_gap: 4.0,
            autogrid: true,
            item_padding: 0.0,
            button_radius: 4.0,
            computed_properties: Vec::new(),
            connected_sources: vec![persistence::SavedSlicerConnection {
                source_type: persistence::SavedSlicerSourceType::BiConnection,
                source_id: conn_id,
            }],
        });

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("slicer.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.slicers.len(), 1);
        let cs = &loaded.slicers[0].connected_sources;
        assert_eq!(cs.len(), 1, "the BI connected-source must survive");
        assert!(
            matches!(cs[0].source_type, persistence::SavedSlicerSourceType::BiConnection),
            "slicer Report-Connection to a BI connection must round-trip (regression: downgraded to Table)"
        );
    }

    #[test]
    fn test_roundtrip_ribbon_filter_advanced_filter() {
        // Regression: a Filter-Pane advanced (operator/value/logic) condition was
        // dropped by the .cala RibbonFilterDef mirror (no field; reverse forced None).
        let mut workbook = make_test_workbook();
        workbook.ribbon_filters.push(persistence::SavedRibbonFilter {
            id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            name: "Sales".to_string(),
            connection_id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            data_source_id: None,
            field_name: "Sales.Amount".to_string(),
            field_data_type: "number".to_string(),
            connection_mode: Default::default(),
            connected_pivots: Vec::new(),
            connected_sheets: Vec::new(),
            display_mode: Default::default(),
            selected_items: None,
            cross_filter_targets: Vec::new(),
            cross_filter_slicer_targets: Vec::new(),
            advanced_filter: Some(persistence::SavedAdvancedFilter {
                condition1: persistence::SavedAdvancedFilterCondition {
                    operator: "greaterThan".to_string(),
                    value: "100".to_string(),
                },
                condition2: Some(persistence::SavedAdvancedFilterCondition {
                    operator: "lessThan".to_string(),
                    value: "500".to_string(),
                }),
                logic: "and".to_string(),
            }),
            hide_no_data: false,
            indicate_no_data: true,
            sort_no_data_last: true,
            show_select_all: false,
            single_select: false,
            order: 0,
            button_columns: 2,
            button_rows: 0,
        });

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ribbon.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.ribbon_filters.len(), 1);
        let af = loaded.ribbon_filters[0]
            .advanced_filter
            .as_ref()
            .expect("ribbon-filter advanced_filter must survive reload (regression: dropped by the .cala mirror)");
        assert_eq!(af.condition1.operator, "greaterThan");
        assert_eq!(af.condition1.value, "100");
        assert_eq!(af.condition2.as_ref().expect("condition2").operator, "lessThan");
        assert_eq!(af.logic, "and");
    }

    #[test]
    fn test_roundtrip_pane_controls() {
        // Pane controls (Controls Pane) persist one file per control under
        // pane_controls/control_{id}.json. `config`/`value` are opaque JSON and
        // must round-trip byte-identical (structurally).
        let mut workbook = make_test_workbook();
        let slider_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        let button_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        workbook.pane_controls.push(persistence::SavedPaneControl {
            id: slider_id,
            name: "Growth".to_string(),
            control_type: "slider".to_string(),
            config: serde_json::json!({
                "type": "slider", "min": 0.0, "max": 1.0, "step": 0.05, "showValue": true
            }),
            value: serde_json::json!({ "type": "number", "value": 0.25 }),
            order: 3,
        });
        workbook.pane_controls.push(persistence::SavedPaneControl {
            id: button_id,
            name: "Refresh".to_string(),
            control_type: "button".to_string(),
            config: serde_json::json!({ "type": "button", "label": "Refresh data" }),
            value: serde_json::Value::Null, // value-less control
            order: 7,
        });

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pane_controls.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.pane_controls.len(), 2, "pane controls must survive the .cala round-trip");
        let slider = loaded.pane_controls.iter().find(|c| c.id == slider_id).expect("slider present");
        assert_eq!(slider.name, "Growth");
        assert_eq!(slider.control_type, "slider");
        assert_eq!(slider.config, workbook.pane_controls[0].config);
        assert_eq!(slider.value, workbook.pane_controls[0].value);
        assert_eq!(slider.order, 3);
        let button = loaded.pane_controls.iter().find(|c| c.id == button_id).expect("button present");
        assert_eq!(button.control_type, "button");
        assert!(button.value.is_null(), "value-less control must round-trip as null");
        assert_eq!(button.order, 7);
    }

    #[test]
    fn test_pane_controls_absent_defaults_to_empty() {
        // Old files (written before pane controls existed) have no
        // pane_controls feature flag or entries — they must load as an
        // empty list.
        let workbook = make_test_workbook();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("no_pane_controls.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();
        assert!(loaded.pane_controls.is_empty());
    }

    #[test]
    fn test_roundtrip_conditional_formats_and_data_validations() {
        // Regression: CF + DV were not modeled in the file format at all — lost on
        // every .cala save/reload. The payload is opaque to the format (app-owned
        // JSON), so this asserts the per-sheet payload + SheetId survive write/read.
        let mut workbook = make_test_workbook();
        let sheet_id = workbook.sheets[0].id;
        workbook.conditional_formats = vec![persistence::SavedSheetConditionalFormats {
            sheet_id,
            rules: serde_json::json!([
                { "id": 7, "priority": 1, "rule": { "type": "cellValue" },
                  "ranges": [{ "startRow": 0, "startCol": 0, "endRow": 9, "endCol": 0 }],
                  "stopIfTrue": false, "enabled": true }
            ]),
        }];
        workbook.data_validations = vec![persistence::SavedSheetDataValidations {
            sheet_id,
            ranges: serde_json::json!([
                { "startRow": 0, "startCol": 1, "endRow": 5, "endCol": 1,
                  "validation": { "rule": { "type": "list" } } }
            ]),
        }];

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cfdv.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.conditional_formats.len(), 1, "CF must survive the .cala round-trip");
        assert_eq!(loaded.conditional_formats[0].sheet_id, sheet_id);
        assert_eq!(loaded.conditional_formats[0].rules, workbook.conditional_formats[0].rules);
        assert_eq!(loaded.data_validations.len(), 1, "DV must survive the .cala round-trip");
        assert_eq!(loaded.data_validations[0].sheet_id, sheet_id);
        assert_eq!(loaded.data_validations[0].ranges, workbook.data_validations[0].ranges);
    }

    #[test]
    fn test_roundtrip_controls() {
        // Regression: control metadata (buttons/checkboxes — onSelect scripts,
        // formula-driven properties) lived only in AppState and vanished on every
        // save/reload. The payload is opaque to the format (app-owned JSON), so
        // this asserts the per-sheet payload + SheetId survive write/read.
        let mut workbook = make_test_workbook();
        let sheet_id = workbook.sheets[0].id;
        workbook.controls = vec![persistence::SavedSheetControls {
            sheet_id,
            controls: serde_json::json!([
                { "row": 2, "col": 3, "controlType": "button",
                  "properties": {
                      "text": { "valueType": "static", "value": "Run" },
                      "onSelect": { "valueType": "static", "value": "script-uuid-1" }
                  } }
            ]),
        }];

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.controls.len(), 1, "controls must survive the .cala round-trip");
        assert_eq!(loaded.controls[0].sheet_id, sheet_id);
        assert_eq!(loaded.controls[0].controls, workbook.controls[0].controls);
    }

    #[test]
    fn test_roundtrip_cell_types() {
        // Cell-type assignments (granular bricks: checkbox/progress/button
        // typed cells) persist as an opaque per-sheet payload keyed by SheetId,
        // exactly like controls.
        let mut workbook = make_test_workbook();
        let sheet_id = workbook.sheets[0].id;
        workbook.cell_types = vec![persistence::SavedSheetCellTypes {
            sheet_id,
            cells: serde_json::json!([
                { "row": 1, "col": 0, "typeId": "calcula.checkbox", "params": {} },
                { "row": 4, "col": 2, "typeId": "calcula.progress", "params": { "max": 100 } }
            ]),
        }];

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cell_types.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.cell_types.len(), 1, "cell types must survive the .cala round-trip");
        assert_eq!(loaded.cell_types[0].sheet_id, sheet_id);
        assert_eq!(loaded.cell_types[0].cells, workbook.cell_types[0].cells);
    }

    #[test]
    fn test_cell_types_absent_defaults_to_empty() {
        // Files written before cell types existed have no cell_types.json —
        // they must load as an empty store, not error.
        let workbook = make_test_workbook();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("no_cell_types.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();
        assert!(loaded.cell_types.is_empty());
    }

    #[test]
    fn test_roundtrip_with_tables() {
        let mut workbook = make_test_workbook();
        let sheet_id = workbook.sheets[0].id;
        workbook.tables.push(persistence::SavedTable {
            id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            name: "SalesTable".to_string(),
            sheet_id,
            start_row: 0,
            start_col: 0,
            end_row: 2,
            end_col: 1,
            columns: vec![
                persistence::SavedTableColumn {
                    id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
                    name: "Name".to_string(),
                    totals_row_function: "none".to_string(),
                    totals_row_formula: None,
                    calculated_formula: None,
                },
                persistence::SavedTableColumn {
                    id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
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
        assert_eq!(loaded.tables[0].sheet_id, sheet_id);
        assert_eq!(loaded.tables[0].columns.len(), 2);
        assert_eq!(loaded.tables[0].style_options.banded_rows, true);
    }

    #[test]
    fn test_roundtrip_with_object_scripts() {
        let mut workbook = make_test_workbook();
        workbook.object_scripts.push(persistence::SavedObjectScript {
            id: "os-1".to_string(),
            name: "Cell Script".to_string(),
            object_type: persistence::ScriptableObjectType::Cell,
            instance_id: None,
            source: "function setup(cell) { cell.onEdit(() => {}); }".to_string(),
            access_level: persistence::ScriptAccessLevel::Restricted,
            description: Some("Test cell script".to_string()),
            provenance: persistence::ScriptProvenance::Local,
            package_name: None,
            declared_capabilities: Vec::new(),
        });
        workbook.object_scripts.push(persistence::SavedObjectScript {
            id: "os-2".to_string(),
            name: "Slicer Script".to_string(),
            object_type: persistence::ScriptableObjectType::Slicer,
            instance_id: Some("slicer-42".to_string()),
            source: "function setup(slicer) { slicer.onSelectionChange(() => {}); }".to_string(),
            access_level: persistence::ScriptAccessLevel::Unlocked,
            description: None,
            provenance: persistence::ScriptProvenance::Distributed,
            package_name: Some("test-pkg".to_string()),
            declared_capabilities: Vec::new(),
        });

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_object_scripts.cala");

        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.object_scripts.len(), 2);

        // Verify primitive script
        let cell_script = loaded.object_scripts.iter().find(|s| s.id == "os-1").unwrap();
        assert_eq!(cell_script.name, "Cell Script");
        assert_eq!(cell_script.object_type, persistence::ScriptableObjectType::Cell);
        assert!(cell_script.instance_id.is_none());
        assert_eq!(cell_script.access_level, persistence::ScriptAccessLevel::Restricted);
        assert!(cell_script.source.contains("cell.onEdit"));
        assert_eq!(cell_script.description, Some("Test cell script".to_string()));

        // Verify component script
        let slicer_script = loaded.object_scripts.iter().find(|s| s.id == "os-2").unwrap();
        assert_eq!(slicer_script.name, "Slicer Script");
        assert_eq!(slicer_script.object_type, persistence::ScriptableObjectType::Slicer);
        assert_eq!(slicer_script.instance_id, Some("slicer-42".to_string()));
        assert_eq!(slicer_script.access_level, persistence::ScriptAccessLevel::Unlocked);
    }

    #[test]
    fn test_roundtrip_with_bi_connection_roles() {
        let mut workbook = make_test_workbook();
        workbook.bi_connection_roles.push(persistence::SavedBiConnectionRole {
            connection_key: "ds-sales-uuid".to_string(),
            active_role: "WestRegion".to_string(),
        });
        workbook.bi_connection_roles.push(persistence::SavedBiConnectionRole {
            connection_key: "C:/models/local.model".to_string(),
            active_role: "Analyst".to_string(),
        });

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_bi_roles.cala");

        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.bi_connection_roles.len(), 2);
        let pkg = loaded.bi_connection_roles.iter()
            .find(|r| r.connection_key == "ds-sales-uuid").unwrap();
        assert_eq!(pkg.active_role, "WestRegion");
        let local = loaded.bi_connection_roles.iter()
            .find(|r| r.connection_key == "C:/models/local.model").unwrap();
        assert_eq!(local.active_role, "Analyst");
    }

    #[test]
    fn test_roundtrip_without_bi_connection_roles_is_empty() {
        let workbook = make_test_workbook();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_no_bi_roles.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();
        assert!(loaded.bi_connection_roles.is_empty());
    }

    #[test]
    fn test_roundtrip_extension_data() {
        let mut workbook = make_test_workbook();
        workbook.extension_data.insert(
            "calcula.my-extension".to_string(),
            serde_json::json!({ "enabled": true, "items": [1, 2, 3], "label": "héllo" }),
        );
        workbook.extension_data.insert(
            "third.party.ext".to_string(),
            serde_json::json!("a bare string value"),
        );

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_extension_data.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.extension_data.len(), 2);
        assert_eq!(loaded.extension_data["calcula.my-extension"]["items"][1], 2);
        assert_eq!(loaded.extension_data["calcula.my-extension"]["label"], "héllo");
        assert_eq!(loaded.extension_data["third.party.ext"], "a bare string value");

        // Empty extension_data must NOT write the part, and still round-trips empty.
        let empty = make_test_workbook();
        let path2 = dir.path().join("test_extension_data_empty.cala");
        write_calcula(&empty, &path2).unwrap();
        let loaded2 = read_calcula(&path2).unwrap();
        assert!(loaded2.extension_data.is_empty());
    }

    #[test]
    fn test_roundtrip_with_bi_connections() {
        let mut workbook = make_test_workbook();
        workbook.bi_connections.push(persistence::SavedBiConnection {
            id: "11111111-1111-1111-1111-111111111111".to_string(),
            name: "Sales DB".to_string(),
            description: "Local sales model".to_string(),
            connection_type: "PostgreSQL".to_string(),
            server: "localhost".to_string(),
            database: "sales".to_string(),
            preferred_auth: "Integrated".to_string(),
            model_path: Some("C:/models/sales.model".to_string()),
            model_json: serde_json::json!({ "tables": [], "measures": [], "formatVersion": 1 }),
            bindings: vec![persistence::SavedBiBinding {
                model_table: "Sales".to_string(),
                schema: "public".to_string(),
                source_table: "sales".to_string(),
            }],
            calculated_measures: Vec::new(),
        });

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_bi_connections.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.bi_connections.len(), 1);
        let c = &loaded.bi_connections[0];
        assert_eq!(c.id, "11111111-1111-1111-1111-111111111111");
        assert_eq!(c.name, "Sales DB");
        assert_eq!(c.server, "localhost");
        assert_eq!(c.database, "sales");
        assert_eq!(c.bindings.len(), 1);
        assert_eq!(c.bindings[0].model_table, "Sales");
        assert_eq!(c.model_json["formatVersion"], 1);
        // Credentials are never persisted.
        assert_eq!(loaded.bi_connections[0].model_json.get("connectionString"), None);
    }

    #[test]
    fn test_roundtrip_with_bi_connection_caches() {
        let mut workbook = make_test_workbook();
        let mut files = HashMap::new();
        files.insert("metadata.json".to_string(), b"{\"tables\":[]}".to_vec());
        // Raw binary (incl. non-UTF8 bytes) must round-trip byte-for-byte.
        files.insert("Sales_1a2b3c4d.arrow".to_string(), vec![1u8, 2, 3, 255, 0, 42, 200]);
        workbook.bi_connection_caches.insert("conn-1".to_string(), files);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_bi_cache.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();

        assert_eq!(loaded.bi_connection_caches.len(), 1);
        let c = loaded.bi_connection_caches.get("conn-1").unwrap();
        assert_eq!(c.len(), 2);
        assert_eq!(c.get("metadata.json").unwrap(), b"{\"tables\":[]}");
        assert_eq!(
            c.get("Sales_1a2b3c4d.arrow").unwrap(),
            &vec![1u8, 2, 3, 255, 0, 42, 200]
        );
    }

    #[test]
    fn test_bi_connection_caches_absent_when_empty() {
        let workbook = make_test_workbook();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_no_bi_cache.cala");
        write_calcula(&workbook, &path).unwrap();
        let loaded = read_calcula(&path).unwrap();
        assert!(loaded.bi_connection_caches.is_empty());
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

    #[test]
    fn encrypted_roundtrip() {
        let workbook = make_test_workbook();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("enc.cala");
        crate::save_calcula_opt(&workbook, &path, Some(b"hunter2")).unwrap();

        // On disk it's an encrypted container, not a plain ZIP.
        let raw = std::fs::read(&path).unwrap();
        assert!(calcula_crypto::is_encrypted(&raw));
        assert_ne!(&raw[..2], b"PK");

        let loaded = crate::load_calcula_opt(&path, Some(b"hunter2")).unwrap();
        assert_eq!(loaded.sheets.len(), workbook.sheets.len());
    }

    #[test]
    fn encrypted_needs_then_wrong_password() {
        let workbook = make_test_workbook();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("enc2.cala");
        crate::save_calcula_opt(&workbook, &path, Some(b"s3cret")).unwrap();

        assert!(matches!(
            crate::load_calcula_opt(&path, None),
            Err(FormatError::NeedsPassword)
        ));
        assert!(matches!(
            crate::load_calcula_opt(&path, Some(b"wrong")),
            Err(FormatError::WrongPassword)
        ));
        // Correct password still works.
        assert!(crate::load_calcula_opt(&path, Some(b"s3cret")).is_ok());
    }

    #[test]
    fn plain_save_is_zip_by_default() {
        let workbook = make_test_workbook();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plain.cala");
        crate::save_calcula(&workbook, &path).unwrap();

        let raw = std::fs::read(&path).unwrap();
        assert_eq!(&raw[..2], b"PK", "plain save must remain a ZIP");
        assert!(!calcula_crypto::is_encrypted(&raw));
        let loaded = crate::load_calcula(&path).unwrap();
        assert_eq!(loaded.sheets.len(), workbook.sheets.len());
    }
}
