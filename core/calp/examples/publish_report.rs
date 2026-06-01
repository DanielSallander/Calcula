//! FILENAME: core/calp/examples/publish_report.rs
//! PURPOSE: Build a report workbook with sample data + pivot table and publish
//!          it as a .calp package. The subscriber gets both the data sheet and
//!          a PivotDefinition that Calcula can render on open.
//!
//! USAGE:   cargo run --example publish_report -- <registry_dir>
//!
//! Example:
//!   cargo run --example publish_report -- \
//!     "C:\Dropbox\Projekt\Calcula\output\registry"

use std::collections::HashMap;
use std::env;
use std::path::Path;

use engine::style::{
    BorderLineStyle, BorderStyle as CellBorderStyle, Borders, CellStyle, Color, Fill, FontStyle,
    TextAlign, VerticalAlign,
};
use engine::ThemeColor;
use persistence::{SavedCell, SavedCellValue, SavedPivotDefinition, Sheet, Workbook};
use pivot_engine::{
    AggregationType, PivotDefinition, PivotField, PivotId, ValueField,
};

use calp::publish::{publish, PublishRequest};
use calp::registry::LocalRegistry;
use calp::version::SemVer;

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
    let mut s = CellStyle::new();
    s.font.bold = true;
    s.font.color = tc(255, 255, 255);
    s.fill = Fill::Solid { color: tc(47, 85, 151) };
    s.text_align = TextAlign::Center;
    s.vertical_align = VerticalAlign::Middle;
    s.borders.bottom = border_thin(255, 255, 255);
    s
}

fn make_data_style() -> CellStyle {
    CellStyle::new()
}

fn make_alt_row_style() -> CellStyle {
    let mut s = CellStyle::new();
    s.fill = Fill::Solid { color: tc(234, 240, 247) };
    s
}

fn make_title_style() -> CellStyle {
    let mut s = CellStyle::new();
    s.font.bold = true;
    s.font.size = 16;
    s.font.color = tc(47, 85, 151);
    s
}

fn make_number_style() -> CellStyle {
    let mut s = CellStyle::new();
    s.number_format = engine::style::NumberFormat::Number {
        decimal_places: 0,
        use_thousands_separator: true,
    };
    s.text_align = TextAlign::Right;
    s
}

fn make_number_alt_style() -> CellStyle {
    let mut s = CellStyle::new();
    s.fill = Fill::Solid { color: tc(234, 240, 247) };
    s.number_format = engine::style::NumberFormat::Number {
        decimal_places: 0,
        use_thousands_separator: true,
    };
    s.text_align = TextAlign::Right;
    s
}

// ---------------------------------------------------------------------------
// Cell helpers
// ---------------------------------------------------------------------------

fn put_text(cells: &mut HashMap<(u32, u32), SavedCell>, row: u32, col: u32, val: &str, style: usize) {
    cells.insert(
        (row, col),
        SavedCell {
            value: SavedCellValue::Text(val.to_string()),
            formula: None,
            style_index: style,
            rich_text: None,
        },
    );
}

fn put_number(cells: &mut HashMap<(u32, u32), SavedCell>, row: u32, col: u32, val: f64, style: usize) {
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
// Sample sales data
// ---------------------------------------------------------------------------

struct SalesRow {
    region: &'static str,
    product: &'static str,
    quarter: &'static str,
    revenue: f64,
    units: f64,
}

fn sample_data() -> Vec<SalesRow> {
    vec![
        SalesRow { region: "North", product: "Widget A", quarter: "Q1", revenue: 45000.0, units: 150.0 },
        SalesRow { region: "North", product: "Widget A", quarter: "Q2", revenue: 52000.0, units: 173.0 },
        SalesRow { region: "North", product: "Widget A", quarter: "Q3", revenue: 48000.0, units: 160.0 },
        SalesRow { region: "North", product: "Widget A", quarter: "Q4", revenue: 61000.0, units: 203.0 },
        SalesRow { region: "North", product: "Widget B", quarter: "Q1", revenue: 32000.0, units: 200.0 },
        SalesRow { region: "North", product: "Widget B", quarter: "Q2", revenue: 35000.0, units: 219.0 },
        SalesRow { region: "North", product: "Widget B", quarter: "Q3", revenue: 29000.0, units: 181.0 },
        SalesRow { region: "North", product: "Widget B", quarter: "Q4", revenue: 41000.0, units: 256.0 },
        SalesRow { region: "South", product: "Widget A", quarter: "Q1", revenue: 38000.0, units: 127.0 },
        SalesRow { region: "South", product: "Widget A", quarter: "Q2", revenue: 41000.0, units: 137.0 },
        SalesRow { region: "South", product: "Widget A", quarter: "Q3", revenue: 39000.0, units: 130.0 },
        SalesRow { region: "South", product: "Widget A", quarter: "Q4", revenue: 47000.0, units: 157.0 },
        SalesRow { region: "South", product: "Widget B", quarter: "Q1", revenue: 28000.0, units: 175.0 },
        SalesRow { region: "South", product: "Widget B", quarter: "Q2", revenue: 31000.0, units: 194.0 },
        SalesRow { region: "South", product: "Widget B", quarter: "Q3", revenue: 27000.0, units: 169.0 },
        SalesRow { region: "South", product: "Widget B", quarter: "Q4", revenue: 36000.0, units: 225.0 },
        SalesRow { region: "East",  product: "Widget A", quarter: "Q1", revenue: 55000.0, units: 183.0 },
        SalesRow { region: "East",  product: "Widget A", quarter: "Q2", revenue: 62000.0, units: 207.0 },
        SalesRow { region: "East",  product: "Widget A", quarter: "Q3", revenue: 58000.0, units: 193.0 },
        SalesRow { region: "East",  product: "Widget A", quarter: "Q4", revenue: 71000.0, units: 237.0 },
        SalesRow { region: "East",  product: "Widget B", quarter: "Q1", revenue: 42000.0, units: 263.0 },
        SalesRow { region: "East",  product: "Widget B", quarter: "Q2", revenue: 46000.0, units: 288.0 },
        SalesRow { region: "East",  product: "Widget B", quarter: "Q3", revenue: 39000.0, units: 244.0 },
        SalesRow { region: "East",  product: "Widget B", quarter: "Q4", revenue: 53000.0, units: 331.0 },
        SalesRow { region: "West",  product: "Widget A", quarter: "Q1", revenue: 49000.0, units: 163.0 },
        SalesRow { region: "West",  product: "Widget A", quarter: "Q2", revenue: 54000.0, units: 180.0 },
        SalesRow { region: "West",  product: "Widget A", quarter: "Q3", revenue: 51000.0, units: 170.0 },
        SalesRow { region: "West",  product: "Widget A", quarter: "Q4", revenue: 63000.0, units: 210.0 },
        SalesRow { region: "West",  product: "Widget B", quarter: "Q1", revenue: 36000.0, units: 225.0 },
        SalesRow { region: "West",  product: "Widget B", quarter: "Q2", revenue: 39000.0, units: 244.0 },
        SalesRow { region: "West",  product: "Widget B", quarter: "Q3", revenue: 34000.0, units: 213.0 },
        SalesRow { region: "West",  product: "Widget B", quarter: "Q4", revenue: 47000.0, units: 294.0 },
    ]
}

// ---------------------------------------------------------------------------
// Sheet builders
// ---------------------------------------------------------------------------

/// Build the "Sales Data" sheet — raw tabular data that serves as pivot source.
fn build_data_sheet() -> Sheet {
    let mut sheet = Sheet::new("Sales Data".to_string());

    // Styles: 0=default, 1=header, 2=data, 3=alt_row, 4=number, 5=number_alt
    sheet.styles = vec![
        CellStyle::new(),       // 0
        make_header_style(),    // 1
        make_data_style(),      // 2
        make_alt_row_style(),   // 3
        make_number_style(),    // 4
        make_number_alt_style(),// 5
    ];

    let cells = &mut sheet.cells;

    // Headers (row 0): Region | Product | Quarter | Revenue | Units
    put_text(cells, 0, 0, "Region", 1);
    put_text(cells, 0, 1, "Product", 1);
    put_text(cells, 0, 2, "Quarter", 1);
    put_text(cells, 0, 3, "Revenue", 1);
    put_text(cells, 0, 4, "Units", 1);

    // Data rows
    let data = sample_data();
    for (i, row) in data.iter().enumerate() {
        let r = (i + 1) as u32;
        let text_style = if i % 2 == 0 { 2 } else { 3 };
        let num_style = if i % 2 == 0 { 4 } else { 5 };
        put_text(cells, r, 0, row.region, text_style);
        put_text(cells, r, 1, row.product, text_style);
        put_text(cells, r, 2, row.quarter, text_style);
        put_number(cells, r, 3, row.revenue, num_style);
        put_number(cells, r, 4, row.units, num_style);
    }

    // Column widths
    sheet.column_widths.insert(0, 100.0);
    sheet.column_widths.insert(1, 100.0);
    sheet.column_widths.insert(2, 80.0);
    sheet.column_widths.insert(3, 120.0);
    sheet.column_widths.insert(4, 80.0);

    sheet
}

/// Build the "Dashboard" sheet with a title. The pivot output will be rendered
/// here by Calcula when it opens the file and recalculates the pivot.
fn build_dashboard_sheet() -> Sheet {
    let mut sheet = Sheet::new("Dashboard".to_string());

    sheet.styles = vec![
        CellStyle::new(),       // 0
        make_title_style(),     // 1
    ];

    let cells = &mut sheet.cells;
    put_text(cells, 0, 0, "Sales Performance Report", 1);
    put_text(cells, 1, 0, "Pivot table below is calculated from the Sales Data sheet.", 0);

    sheet.column_widths.insert(0, 200.0);
    for i in 1..6 {
        sheet.column_widths.insert(i, 120.0);
    }
    sheet.row_heights.insert(0, 36.0);

    sheet
}

/// Build a PivotDefinition that references the "Sales Data" sheet.
/// Layout: Region as rows, Quarter as columns, Sum of Revenue as values.
fn build_pivot_definition(data_row_count: usize) -> PivotDefinition {
    let pivot_id = PivotId::from_bytes(identity::generate_uuid_v7());

    let mut def = PivotDefinition::new(
        pivot_id,
        (0, 0),                                      // source_start (row 0, col 0)
        ((data_row_count) as u32, 4),                 // source_end (last data row, col 4)
    );

    def.name = Some("Revenue by Region".to_string());
    def.source_has_headers = true;

    // Pivot output starts at row 3 on the Dashboard sheet (below the title)
    def.destination = (3, 0);
    def.destination_sheet = Some("Dashboard".to_string());

    // Row fields: Region (col 0), Product (col 1)
    def.row_fields = vec![
        PivotField::new(0, "Region".to_string()),
        PivotField::new(1, "Product".to_string()),
    ];

    // Column fields: Quarter (col 2)
    def.column_fields = vec![
        PivotField::new(2, "Quarter".to_string()),
    ];

    // Value fields: Sum of Revenue (col 3)
    def.value_fields = vec![
        ValueField::new(3, "Sum of Revenue".to_string(), AggregationType::Sum),
    ];

    def
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: publish_report <registry_dir>");
        eprintln!();
        eprintln!("Example:");
        eprintln!("  cargo run --example publish_report -- \\");
        eprintln!("    \"C:\\Dropbox\\Projekt\\Calcula\\output\\registry\"");
        std::process::exit(1);
    }

    let registry_path = Path::new(&args[1]);

    // Build workbook with data + dashboard sheets
    let data = sample_data();
    let data_count = data.len();
    drop(data);

    let data_sheet = build_data_sheet();
    let dashboard_sheet = build_dashboard_sheet();

    let mut workbook = Workbook::new();
    workbook.sheets.clear();
    workbook.sheets.push(dashboard_sheet);
    workbook.sheets.push(data_sheet);
    workbook.properties.title = "Sales Performance Report".to_string();
    workbook.properties.author = "Calcula Report Builder".to_string();
    workbook.properties.description = "Sample report with pivot table".to_string();

    // Build and embed the pivot definition
    let pivot_def = build_pivot_definition(data_count);
    println!("Pivot: {} ({}x{} source)", pivot_def.name.as_deref().unwrap_or("unnamed"), data_count, 5);

    let pivot_json = serde_json::to_value(&pivot_def).expect("Failed to serialize PivotDefinition");
    workbook.pivot_definitions.push(SavedPivotDefinition {
        id: pivot_def.id,
        source_type: "grid".to_string(),
        source_sheet_index: Some(1), // "Sales Data" is sheet index 1
        definition: pivot_json,
    });

    println!("Built workbook: {} sheets, {} pivot(s)", workbook.sheets.len(), workbook.pivot_definitions.len());

    // Open (or create) the local registry
    let registry = LocalRegistry::open(registry_path).expect("Failed to open/create registry");
    println!("Registry at: {}", registry_path.display());

    // Delete existing package directory if present (overwrite)
    let pkg_dir = registry_path.join("sales-report");
    if pkg_dir.exists() {
        std::fs::remove_dir_all(&pkg_dir).expect("Failed to remove old package");
        println!("Removed existing sales-report package");
    }

    // Publish
    let version = SemVer::parse("1.0.0").unwrap();
    let now = {
        let dur = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap();
        format!(
            "2026-06-01T{:02}:{:02}:{:02}Z",
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
        data_sources: Vec::new(),
    };

    let result = publish(&registry, &request).expect("Publish failed");

    println!();
    println!("Published .calp package successfully!");
    println!("  Package:  {}", result.package_name);
    println!("  Version:  {}", result.version);
    println!("  Sheets:   {}", result.sheets_published);
    println!("  Pivots:   {}", workbook.pivot_definitions.len());
    println!();
    println!("Subscribe in Calcula:");
    println!("  Data > Subscribe to Package...");
    println!("  Registry: {}", registry_path.display());
    println!("  Package:  sales-report");
}
