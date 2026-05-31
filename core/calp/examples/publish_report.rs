//! FILENAME: core/calp/examples/publish_report.rs
//! PURPOSE: Build a report workbook from a BI model JSON and publish it as a .calp package.
//! USAGE:   cargo run --example publish_report -- <model.json> <registry_dir>
//!
//! Example:
//!   cargo run --example publish_report -- \
//!     "C:\Dropbox\Projekt\Calcula Studio\examples\model.json" \
//!     "C:\Dropbox\Projekt\Calcula\output\registry"

use std::collections::HashMap;
use std::env;
use std::path::Path;

use engine::style::{
    BorderLineStyle, BorderStyle as CellBorderStyle, Borders, CellStyle, Color, Fill, FontStyle,
    NumberFormat, TextAlign, VerticalAlign,
};
use engine::ThemeColor;
use persistence::{SavedCell, SavedCellValue, Sheet, Workbook};

use calp::publish::{publish, PublishRequest};
use calp::registry::LocalRegistry;
use calp::version::SemVer;

// ---------------------------------------------------------------------------
// Model JSON parsing (lightweight, no bi_engine dependency)
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct ModelInfo {
    tables: Vec<TableInfo>,
    measures: Vec<MeasureInfo>,
}

#[derive(Debug)]
struct TableInfo {
    name: String,
    columns: Vec<String>,
}

#[derive(Debug)]
struct MeasureInfo {
    name: String,
    group: String,
}

fn parse_model(path: &Path) -> ModelInfo {
    let json_str = std::fs::read_to_string(path).expect("Failed to read model JSON");
    let json: serde_json::Value = serde_json::from_str(&json_str).expect("Failed to parse JSON");

    // Support both raw model and ModelBundle (has "formatVersion" wrapper)
    let model = if json.get("formatVersion").is_some() {
        json.get("model")
            .expect("ModelBundle missing 'model'")
            .clone()
    } else {
        json
    };

    let tables = model
        .get("tables")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|t| TableInfo {
                    name: t["name"].as_str().unwrap_or("").to_string(),
                    columns: t
                        .get("columns")
                        .and_then(|c| c.as_array())
                        .map(|cols| {
                            cols.iter()
                                .map(|c| c["name"].as_str().unwrap_or("").to_string())
                                .collect()
                        })
                        .unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default();

    let measures = model
        .get("measures")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|m| MeasureInfo {
                    name: m["name"].as_str().unwrap_or("").to_string(),
                    group: m["group"].as_str().unwrap_or("").to_string(),
                })
                .collect()
        })
        .unwrap_or_default();

    ModelInfo { tables, measures }
}

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

fn tc(r: u8, g: u8, b: u8) -> ThemeColor {
    ThemeColor::Absolute(Color::new(r, g, b))
}

fn border_thin(r: u8, g: u8, b: u8) -> CellBorderStyle {
    CellBorderStyle {
        width: 1,
        color: tc(r, g, b),
        style: BorderLineStyle::Solid,
    }
}

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

fn make_header_style() -> CellStyle {
    let mut style = CellStyle::new();
    style.font = FontStyle {
        bold: true,
        size: 12,
        color: tc(255, 255, 255),
        ..FontStyle::default()
    };
    style.fill = Fill::Solid {
        color: tc(43, 87, 151),
    };
    style.text_align = TextAlign::Center;
    style.vertical_align = VerticalAlign::Middle;
    style
}

fn make_subheader_style() -> CellStyle {
    let mut style = CellStyle::new();
    style.font = FontStyle {
        bold: true,
        size: 11,
        color: tc(26, 58, 92),
        ..FontStyle::default()
    };
    style.fill = Fill::Solid {
        color: tc(214, 228, 240),
    };
    style.borders = Borders {
        bottom: border_thin(43, 87, 151),
        ..Borders::default()
    };
    style
}

fn make_title_style() -> CellStyle {
    let mut style = CellStyle::new();
    style.font = FontStyle {
        bold: true,
        size: 16,
        color: tc(26, 58, 92),
        ..FontStyle::default()
    };
    style.text_align = TextAlign::Left;
    style
}

fn make_kpi_label_style() -> CellStyle {
    let mut style = CellStyle::new();
    style.font = FontStyle {
        bold: false,
        size: 10,
        color: tc(102, 102, 102),
        ..FontStyle::default()
    };
    style.text_align = TextAlign::Center;
    style.vertical_align = VerticalAlign::Middle;
    style.fill = Fill::Solid {
        color: tc(245, 245, 245),
    };
    style
}

fn make_kpi_value_style() -> CellStyle {
    let mut style = CellStyle::new();
    style.font = FontStyle {
        bold: true,
        size: 14,
        color: tc(43, 87, 151),
        ..FontStyle::default()
    };
    style.text_align = TextAlign::Center;
    style.vertical_align = VerticalAlign::Middle;
    style.number_format = NumberFormat::Custom { format: "#,##0".to_string() };
    style.fill = Fill::Solid {
        color: tc(245, 245, 245),
    };
    let b = border_thin(204, 204, 204);
    style.borders = Borders {
        top: b.clone(),
        bottom: b.clone(),
        left: b.clone(),
        right: b,
        ..Borders::default()
    };
    style
}

fn make_data_style() -> CellStyle {
    let mut style = CellStyle::new();
    style.borders = Borders {
        bottom: CellBorderStyle {
            width: 1,
            color: tc(221, 221, 221),
            style: BorderLineStyle::Dotted,
        },
        ..Borders::default()
    };
    style
}

fn make_alt_row_style() -> CellStyle {
    let mut style = make_data_style();
    style.fill = Fill::Solid {
        color: tc(240, 244, 248),
    };
    style
}

// ---------------------------------------------------------------------------
// Cell insertion helpers
// ---------------------------------------------------------------------------

fn put_text(
    cells: &mut HashMap<(u32, u32), SavedCell>,
    row: u32,
    col: u32,
    text: &str,
    style: usize,
) {
    cells.insert(
        (row, col),
        SavedCell {
            value: SavedCellValue::Text(text.to_string()),
            formula: None,
            style_index: style,
            rich_text: None,
        },
    );
}

fn put_number(
    cells: &mut HashMap<(u32, u32), SavedCell>,
    row: u32,
    col: u32,
    val: f64,
    style: usize,
) {
    cells.insert(
        (row, col),
        SavedCell {
            value: SavedCellValue::Number(val),
            formula: None,
            style_index: style,
            rich_text: None,
        },
    );
}

// ---------------------------------------------------------------------------
// Sheet builders
// ---------------------------------------------------------------------------

fn build_dashboard_sheet(model: &ModelInfo) -> Sheet {
    let mut sheet = Sheet::new("Sales Dashboard".to_string());

    // Register styles: 0=default, 1=title, 2=header, 3=subheader,
    // 4=kpi_label, 5=kpi_value, 6=data, 7=alt_row
    sheet.styles = vec![
        CellStyle::new(),       // 0
        make_title_style(),     // 1
        make_header_style(),    // 2
        make_subheader_style(), // 3
        make_kpi_label_style(), // 4
        make_kpi_value_style(), // 5
        make_data_style(),      // 6
        make_alt_row_style(),   // 7
    ];

    let cells = &mut sheet.cells;

    // Title row
    put_text(cells, 0, 0, "Sales Performance Report", 1);

    // KPI cards (row 2-3): show Basic measures as KPI cards across columns
    let basic_measures: Vec<&MeasureInfo> = model
        .measures
        .iter()
        .filter(|m| m.group == "Basic")
        .collect();
    for (i, m) in basic_measures.iter().enumerate().take(6) {
        let col = i as u32;
        put_text(cells, 2, col, &m.name, 4);
        put_text(cells, 3, col, "(connect to view)", 5);
    }

    // KPI section: Key Performance Indicators
    put_text(cells, 5, 0, "Key Performance Indicators", 3);
    let kpi_measures: Vec<&MeasureInfo> = model
        .measures
        .iter()
        .filter(|m| m.group == "KPIs")
        .collect();
    for (i, m) in kpi_measures.iter().enumerate() {
        let row = 6 + i as u32;
        let style = if i % 2 == 0 { 6 } else { 7 };
        put_text(cells, row, 0, &m.name, style);
        put_text(cells, row, 1, "(connect to view)", style);
    }

    // Filtered measures section
    let kpi_end = 6 + kpi_measures.len() as u32;
    put_text(cells, kpi_end + 1, 0, "Filtered Measures", 3);
    let filtered: Vec<&MeasureInfo> = model
        .measures
        .iter()
        .filter(|m| m.group == "Filtered")
        .collect();
    for (i, m) in filtered.iter().enumerate() {
        let row = kpi_end + 2 + i as u32;
        let style = if i % 2 == 0 { 6 } else { 7 };
        put_text(cells, row, 0, &m.name, style);
        put_text(cells, row, 1, "(connect to view)", style);
    }

    // Complex measures section
    let filt_end = kpi_end + 2 + filtered.len() as u32;
    put_text(cells, filt_end + 1, 0, "Advanced Analytics", 3);
    let complex: Vec<&MeasureInfo> = model
        .measures
        .iter()
        .filter(|m| m.group == "Complex")
        .collect();
    for (i, m) in complex.iter().enumerate() {
        let row = filt_end + 2 + i as u32;
        let style = if i % 2 == 0 { 6 } else { 7 };
        put_text(cells, row, 0, &m.name, style);
        put_text(cells, row, 1, "(connect to view)", style);
    }

    // Column widths
    sheet.column_widths.insert(0, 220.0);
    sheet.column_widths.insert(1, 150.0);
    for i in 2..6 {
        sheet.column_widths.insert(i, 140.0);
    }

    // Row heights
    sheet.row_heights.insert(0, 36.0);
    sheet.row_heights.insert(2, 20.0);
    sheet.row_heights.insert(3, 32.0);

    sheet
}

fn build_model_overview_sheet(model: &ModelInfo) -> Sheet {
    let mut sheet = Sheet::new("Model Overview".to_string());

    sheet.styles = vec![
        CellStyle::new(),       // 0
        make_title_style(),     // 1
        make_header_style(),    // 2
        make_subheader_style(), // 3
        make_data_style(),      // 4
        make_alt_row_style(),   // 5
    ];

    let cells = &mut sheet.cells;

    // Title
    put_text(cells, 0, 0, "Data Model Reference", 1);

    // --- Tables section ---
    put_text(cells, 2, 0, "Table", 2);
    put_text(cells, 2, 1, "Type", 2);
    put_text(cells, 2, 2, "Columns", 2);
    put_text(cells, 2, 3, "Column Count", 2);

    for (i, table) in model.tables.iter().enumerate() {
        let row = 3 + i as u32;
        let style = if i % 2 == 0 { 4 } else { 5 };
        let ttype = if table.name.starts_with("fact_") {
            "Fact"
        } else if table.name.starts_with("dim_") {
            "Dimension"
        } else {
            "Other"
        };
        put_text(cells, row, 0, &table.name, style);
        put_text(cells, row, 1, ttype, style);
        put_text(cells, row, 2, &table.columns.join(", "), style);
        put_number(cells, row, 3, table.columns.len() as f64, style);
    }

    // --- Measures section ---
    let measures_start = 3 + model.tables.len() as u32 + 2;
    put_text(cells, measures_start, 0, "Measure", 2);
    put_text(cells, measures_start, 1, "Group", 2);

    let groups = ["Basic", "KPIs", "Filtered", "Complex"];
    let mut row = measures_start + 1;
    for group in &groups {
        let group_measures: Vec<&MeasureInfo> = model
            .measures
            .iter()
            .filter(|m| m.group == *group)
            .collect();
        if group_measures.is_empty() {
            continue;
        }
        put_text(cells, row, 0, group, 3);
        put_text(
            cells,
            row,
            1,
            &format!("{} measures", group_measures.len()),
            3,
        );
        row += 1;

        for (i, m) in group_measures.iter().enumerate() {
            let style = if i % 2 == 0 { 4 } else { 5 };
            put_text(cells, row, 0, &format!("  {}", m.name), style);
            put_text(cells, row, 1, &m.group, style);
            row += 1;
        }
    }

    // Column widths
    sheet.column_widths.insert(0, 220.0);
    sheet.column_widths.insert(1, 120.0);
    sheet.column_widths.insert(2, 400.0);
    sheet.column_widths.insert(3, 100.0);

    sheet.row_heights.insert(0, 36.0);

    sheet
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 {
        eprintln!("Usage: publish_report <model.json> <registry_dir>");
        eprintln!();
        eprintln!("Example:");
        eprintln!("  cargo run --example publish_report -- \\");
        eprintln!("    \"C:\\Dropbox\\Projekt\\Calcula Studio\\examples\\model.json\" \\");
        eprintln!("    \"C:\\Dropbox\\Projekt\\Calcula\\output\\registry\"");
        std::process::exit(1);
    }

    let model_path = Path::new(&args[1]);
    let registry_path = Path::new(&args[2]);

    println!("Loading model from: {}", model_path.display());
    let model = parse_model(model_path);
    println!(
        "  Found {} tables, {} measures",
        model.tables.len(),
        model.measures.len()
    );

    // Build workbook with report sheets
    let mut workbook = Workbook::new();
    workbook.sheets.clear(); // Remove default "Sheet1"
    workbook.sheets.push(build_dashboard_sheet(&model));
    workbook.sheets.push(build_model_overview_sheet(&model));
    workbook.properties.title = "BI Sales Report".to_string();
    workbook.properties.author = "Calcula Report Builder".to_string();
    workbook.properties.description = "Auto-generated report from BI model".to_string();

    println!("Built workbook: {} sheets", workbook.sheets.len());

    // Open (or create) the local registry
    let registry = LocalRegistry::open(registry_path).expect("Failed to open/create registry");
    println!("Registry at: {}", registry_path.display());

    // Publish
    let version = SemVer::parse("1.0.0").unwrap();
    let now = {
        let dur = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap();
        format!(
            "2026-05-31T{:02}:{:02}:{:02}Z",
            (dur.as_secs() / 3600) % 24,
            (dur.as_secs() / 60) % 60,
            dur.as_secs() % 60,
        )
    };

    let request = PublishRequest {
        workbook: &workbook,
        package_name: "sales-report".to_string(),
        version,
        kind: "report".to_string(),
        sheet_indices: vec![0, 1],
        now,
        published_by: "Calcula CLI".to_string(),
        writeback_regions: None,
        object_scripts: None,
    };

    let result = publish(&registry, &request).expect("Publish failed");

    println!();
    println!("Published .calp package successfully!");
    println!("  Package:  {}", result.package_name);
    println!("  Version:  {}", result.version);
    println!("  Sheets:   {}", result.sheets_published);
    println!("  Tables:   {}", result.tables_published);
    println!("  Ranges:   {}", result.named_ranges_published);
    println!("  Scripts:  {}", result.scripts_published);
    println!();
    println!("Registry location: {}", registry_path.display());
}
