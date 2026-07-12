//! FILENAME: core/calp/examples/publish_report.rs
//! PURPOSE: Build a report workbook with sales data + pivot table and publish
//!          it as a .calp package with an embedded BI model data source.
//!          The subscriber gets the data sheet, an interactive pivot, and
//!          the BI model for live data refresh.
//!
//! USAGE:   cargo run --example publish_report -- <registry_dir> [model_path]
//!
//! Example:
//!   cargo run --example publish_report -- \
//!     "C:\Dropbox\Projekt\Calcula\output\registry" \
//!     "C:\Dropbox\Projekt\Calcula Studio\examples\model.json"

use std::collections::HashMap;
use std::env;
use std::path::Path;

use engine::style::{
    BorderLineStyle, BorderStyle as CellBorderStyle, CellStyle, Color, Fill,
    NumberFormat, TextAlign, VerticalAlign,
};
use engine::ThemeColor;
use persistence::{SavedCell, SavedCellValue, SavedPivotDefinition, Sheet, Workbook};
use pivot_engine::{
    AggregationType, PivotDefinition, PivotField, PivotId, ValueField,
};

use calp::publish::{publish, ExcludedRegion, PublishDataSource, PublishRequest};
use calp::PackageBinding;
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
    s.number_format = NumberFormat::Number {
        decimal_places: 0,
        use_thousands_separator: true,
    };
    s.text_align = TextAlign::Right;
    s
}

fn make_number_alt_style() -> CellStyle {
    let mut s = CellStyle::new();
    s.fill = Fill::Solid { color: tc(234, 240, 247) };
    s.number_format = NumberFormat::Number {
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
// Sample sales data (denormalized from the BI model's star schema)
// Simulates a JOIN of fact_sales + dim_product + dim_territory + dim_date
// ---------------------------------------------------------------------------

struct SalesRow {
    category: &'static str,
    product: &'static str,
    territory: &'static str,
    territory_group: &'static str,
    year: f64,
    quarter: &'static str,
    order_qty: f64,
    unit_price: f64,
    line_total: f64,
}

fn sample_data() -> Vec<SalesRow> {
    vec![
        // Bikes - North America
        SalesRow { category: "Bikes", product: "Mountain-200 Black", territory: "Northwest", territory_group: "North America", year: 2024.0, quarter: "Q1", order_qty: 42.0, unit_price: 2295.0, line_total: 96390.0 },
        SalesRow { category: "Bikes", product: "Mountain-200 Black", territory: "Northwest", territory_group: "North America", year: 2024.0, quarter: "Q2", order_qty: 55.0, unit_price: 2295.0, line_total: 126225.0 },
        SalesRow { category: "Bikes", product: "Mountain-200 Black", territory: "Northwest", territory_group: "North America", year: 2024.0, quarter: "Q3", order_qty: 38.0, unit_price: 2295.0, line_total: 87210.0 },
        SalesRow { category: "Bikes", product: "Mountain-200 Black", territory: "Northwest", territory_group: "North America", year: 2024.0, quarter: "Q4", order_qty: 67.0, unit_price: 2295.0, line_total: 153765.0 },
        SalesRow { category: "Bikes", product: "Road-250 Red", territory: "Southwest", territory_group: "North America", year: 2024.0, quarter: "Q1", order_qty: 61.0, unit_price: 2443.0, line_total: 149023.0 },
        SalesRow { category: "Bikes", product: "Road-250 Red", territory: "Southwest", territory_group: "North America", year: 2024.0, quarter: "Q2", order_qty: 73.0, unit_price: 2443.0, line_total: 178339.0 },
        SalesRow { category: "Bikes", product: "Road-250 Red", territory: "Southwest", territory_group: "North America", year: 2024.0, quarter: "Q3", order_qty: 49.0, unit_price: 2443.0, line_total: 119707.0 },
        SalesRow { category: "Bikes", product: "Road-250 Red", territory: "Southwest", territory_group: "North America", year: 2024.0, quarter: "Q4", order_qty: 82.0, unit_price: 2443.0, line_total: 200326.0 },
        // Bikes - Europe
        SalesRow { category: "Bikes", product: "Mountain-200 Black", territory: "United Kingdom", territory_group: "Europe", year: 2024.0, quarter: "Q1", order_qty: 31.0, unit_price: 2295.0, line_total: 71145.0 },
        SalesRow { category: "Bikes", product: "Mountain-200 Black", territory: "United Kingdom", territory_group: "Europe", year: 2024.0, quarter: "Q2", order_qty: 44.0, unit_price: 2295.0, line_total: 100980.0 },
        SalesRow { category: "Bikes", product: "Mountain-200 Black", territory: "Germany", territory_group: "Europe", year: 2024.0, quarter: "Q3", order_qty: 29.0, unit_price: 2295.0, line_total: 66555.0 },
        SalesRow { category: "Bikes", product: "Mountain-200 Black", territory: "Germany", territory_group: "Europe", year: 2024.0, quarter: "Q4", order_qty: 51.0, unit_price: 2295.0, line_total: 117045.0 },
        SalesRow { category: "Bikes", product: "Road-250 Red", territory: "France", territory_group: "Europe", year: 2024.0, quarter: "Q1", order_qty: 38.0, unit_price: 2443.0, line_total: 92834.0 },
        SalesRow { category: "Bikes", product: "Road-250 Red", territory: "France", territory_group: "Europe", year: 2024.0, quarter: "Q2", order_qty: 52.0, unit_price: 2443.0, line_total: 127036.0 },
        SalesRow { category: "Bikes", product: "Road-250 Red", territory: "United Kingdom", territory_group: "Europe", year: 2024.0, quarter: "Q3", order_qty: 35.0, unit_price: 2443.0, line_total: 85505.0 },
        SalesRow { category: "Bikes", product: "Road-250 Red", territory: "United Kingdom", territory_group: "Europe", year: 2024.0, quarter: "Q4", order_qty: 60.0, unit_price: 2443.0, line_total: 146580.0 },
        // Bikes - Pacific
        SalesRow { category: "Bikes", product: "Mountain-200 Black", territory: "Australia", territory_group: "Pacific", year: 2024.0, quarter: "Q1", order_qty: 25.0, unit_price: 2295.0, line_total: 57375.0 },
        SalesRow { category: "Bikes", product: "Mountain-200 Black", territory: "Australia", territory_group: "Pacific", year: 2024.0, quarter: "Q2", order_qty: 33.0, unit_price: 2295.0, line_total: 75735.0 },
        SalesRow { category: "Bikes", product: "Road-250 Red", territory: "Australia", territory_group: "Pacific", year: 2024.0, quarter: "Q3", order_qty: 28.0, unit_price: 2443.0, line_total: 68404.0 },
        SalesRow { category: "Bikes", product: "Road-250 Red", territory: "Australia", territory_group: "Pacific", year: 2024.0, quarter: "Q4", order_qty: 45.0, unit_price: 2443.0, line_total: 109935.0 },
        // Components - North America
        SalesRow { category: "Components", product: "HL Mountain Frame", territory: "Northwest", territory_group: "North America", year: 2024.0, quarter: "Q1", order_qty: 120.0, unit_price: 1364.0, line_total: 163680.0 },
        SalesRow { category: "Components", product: "HL Mountain Frame", territory: "Northwest", territory_group: "North America", year: 2024.0, quarter: "Q2", order_qty: 145.0, unit_price: 1364.0, line_total: 197780.0 },
        SalesRow { category: "Components", product: "HL Mountain Frame", territory: "Southwest", territory_group: "North America", year: 2024.0, quarter: "Q3", order_qty: 98.0, unit_price: 1364.0, line_total: 133672.0 },
        SalesRow { category: "Components", product: "HL Mountain Frame", territory: "Southwest", territory_group: "North America", year: 2024.0, quarter: "Q4", order_qty: 160.0, unit_price: 1364.0, line_total: 218240.0 },
        // Components - Europe
        SalesRow { category: "Components", product: "HL Mountain Frame", territory: "Germany", territory_group: "Europe", year: 2024.0, quarter: "Q1", order_qty: 85.0, unit_price: 1364.0, line_total: 115940.0 },
        SalesRow { category: "Components", product: "HL Mountain Frame", territory: "Germany", territory_group: "Europe", year: 2024.0, quarter: "Q2", order_qty: 110.0, unit_price: 1364.0, line_total: 150040.0 },
        SalesRow { category: "Components", product: "HL Mountain Frame", territory: "France", territory_group: "Europe", year: 2024.0, quarter: "Q3", order_qty: 72.0, unit_price: 1364.0, line_total: 98208.0 },
        SalesRow { category: "Components", product: "HL Mountain Frame", territory: "France", territory_group: "Europe", year: 2024.0, quarter: "Q4", order_qty: 130.0, unit_price: 1364.0, line_total: 177320.0 },
        // Accessories - North America
        SalesRow { category: "Accessories", product: "Sport-100 Helmet", territory: "Northwest", territory_group: "North America", year: 2024.0, quarter: "Q1", order_qty: 210.0, unit_price: 35.0, line_total: 7350.0 },
        SalesRow { category: "Accessories", product: "Sport-100 Helmet", territory: "Northwest", territory_group: "North America", year: 2024.0, quarter: "Q2", order_qty: 280.0, unit_price: 35.0, line_total: 9800.0 },
        SalesRow { category: "Accessories", product: "Sport-100 Helmet", territory: "Southwest", territory_group: "North America", year: 2024.0, quarter: "Q3", order_qty: 195.0, unit_price: 35.0, line_total: 6825.0 },
        SalesRow { category: "Accessories", product: "Sport-100 Helmet", territory: "Southwest", territory_group: "North America", year: 2024.0, quarter: "Q4", order_qty: 320.0, unit_price: 35.0, line_total: 11200.0 },
        // Accessories - Europe
        SalesRow { category: "Accessories", product: "Sport-100 Helmet", territory: "United Kingdom", territory_group: "Europe", year: 2024.0, quarter: "Q1", order_qty: 150.0, unit_price: 35.0, line_total: 5250.0 },
        SalesRow { category: "Accessories", product: "Sport-100 Helmet", territory: "United Kingdom", territory_group: "Europe", year: 2024.0, quarter: "Q2", order_qty: 190.0, unit_price: 35.0, line_total: 6650.0 },
        SalesRow { category: "Accessories", product: "Sport-100 Helmet", territory: "Germany", territory_group: "Europe", year: 2024.0, quarter: "Q3", order_qty: 135.0, unit_price: 35.0, line_total: 4725.0 },
        SalesRow { category: "Accessories", product: "Sport-100 Helmet", territory: "Germany", territory_group: "Europe", year: 2024.0, quarter: "Q4", order_qty: 225.0, unit_price: 35.0, line_total: 7875.0 },
        // Accessories - Pacific
        SalesRow { category: "Accessories", product: "Sport-100 Helmet", territory: "Australia", territory_group: "Pacific", year: 2024.0, quarter: "Q1", order_qty: 100.0, unit_price: 35.0, line_total: 3500.0 },
        SalesRow { category: "Accessories", product: "Sport-100 Helmet", territory: "Australia", territory_group: "Pacific", year: 2024.0, quarter: "Q2", order_qty: 140.0, unit_price: 35.0, line_total: 4900.0 },
        SalesRow { category: "Accessories", product: "Sport-100 Helmet", territory: "Australia", territory_group: "Pacific", year: 2024.0, quarter: "Q3", order_qty: 115.0, unit_price: 35.0, line_total: 4025.0 },
        SalesRow { category: "Accessories", product: "Sport-100 Helmet", territory: "Australia", territory_group: "Pacific", year: 2024.0, quarter: "Q4", order_qty: 180.0, unit_price: 35.0, line_total: 6300.0 },
        // Clothing - North America
        SalesRow { category: "Clothing", product: "Classic Vest", territory: "Northwest", territory_group: "North America", year: 2024.0, quarter: "Q1", order_qty: 95.0, unit_price: 64.0, line_total: 6080.0 },
        SalesRow { category: "Clothing", product: "Classic Vest", territory: "Southwest", territory_group: "North America", year: 2024.0, quarter: "Q2", order_qty: 125.0, unit_price: 64.0, line_total: 8000.0 },
        SalesRow { category: "Clothing", product: "Classic Vest", territory: "Northwest", territory_group: "North America", year: 2024.0, quarter: "Q3", order_qty: 88.0, unit_price: 64.0, line_total: 5632.0 },
        SalesRow { category: "Clothing", product: "Classic Vest", territory: "Southwest", territory_group: "North America", year: 2024.0, quarter: "Q4", order_qty: 150.0, unit_price: 64.0, line_total: 9600.0 },
        // Clothing - Europe
        SalesRow { category: "Clothing", product: "Classic Vest", territory: "France", territory_group: "Europe", year: 2024.0, quarter: "Q1", order_qty: 70.0, unit_price: 64.0, line_total: 4480.0 },
        SalesRow { category: "Clothing", product: "Classic Vest", territory: "United Kingdom", territory_group: "Europe", year: 2024.0, quarter: "Q2", order_qty: 95.0, unit_price: 64.0, line_total: 6080.0 },
        SalesRow { category: "Clothing", product: "Classic Vest", territory: "Germany", territory_group: "Europe", year: 2024.0, quarter: "Q3", order_qty: 60.0, unit_price: 64.0, line_total: 3840.0 },
        SalesRow { category: "Clothing", product: "Classic Vest", territory: "France", territory_group: "Europe", year: 2024.0, quarter: "Q4", order_qty: 110.0, unit_price: 64.0, line_total: 7040.0 },
    ]
}

// ---------------------------------------------------------------------------
// Headers for the data sheet (matches BI model schema)
// ---------------------------------------------------------------------------

const HEADERS: [&str; 9] = [
    "Category", "Product", "Territory", "Territory Group",
    "Year", "Quarter", "Order Qty", "Unit Price", "Line Total",
];

// ---------------------------------------------------------------------------
// Sheet builders
// ---------------------------------------------------------------------------

/// Build the "Sales Data" sheet — denormalized sales data as pivot source.
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

    // Headers (row 0)
    for (col, header) in HEADERS.iter().enumerate() {
        put_text(cells, 0, col as u32, header, 1);
    }

    // Data rows
    let data = sample_data();
    for (i, row) in data.iter().enumerate() {
        let r = (i + 1) as u32;
        let text_style = if i % 2 == 0 { 2 } else { 3 };
        let num_style = if i % 2 == 0 { 4 } else { 5 };
        put_text(cells, r, 0, row.category, text_style);
        put_text(cells, r, 1, row.product, text_style);
        put_text(cells, r, 2, row.territory, text_style);
        put_text(cells, r, 3, row.territory_group, text_style);
        put_number(cells, r, 4, row.year, num_style);
        put_text(cells, r, 5, row.quarter, text_style);
        put_number(cells, r, 6, row.order_qty, num_style);
        put_number(cells, r, 7, row.unit_price, num_style);
        put_number(cells, r, 8, row.line_total, num_style);
    }

    // Column widths
    sheet.column_widths.insert(0, 110.0);
    sheet.column_widths.insert(1, 160.0);
    sheet.column_widths.insert(2, 130.0);
    sheet.column_widths.insert(3, 130.0);
    sheet.column_widths.insert(4, 60.0);
    sheet.column_widths.insert(5, 70.0);
    sheet.column_widths.insert(6, 80.0);
    sheet.column_widths.insert(7, 90.0);
    sheet.column_widths.insert(8, 110.0);

    sheet
}

/// Build the "Dashboard" sheet with a title.
fn build_dashboard_sheet() -> Sheet {
    let mut sheet = Sheet::new("Dashboard".to_string());

    sheet.styles = vec![
        CellStyle::new(),       // 0
        make_title_style(),     // 1
    ];

    let cells = &mut sheet.cells;
    put_text(cells, 0, 0, "Sales Performance Dashboard", 1);
    put_text(cells, 1, 0, "Product category sales by territory group (from BI model)", 0);

    sheet.column_widths.insert(0, 200.0);
    for i in 1..8 {
        sheet.column_widths.insert(i, 120.0);
    }
    sheet.row_heights.insert(0, 36.0);

    sheet
}

/// Build a PivotDefinition referencing the "Sales Data" sheet.
/// Layout: Category + Product as rows, Territory Group as columns, Sum of Line Total.
fn build_pivot_definition(data_row_count: usize, is_bi: bool) -> PivotDefinition {
    let pivot_id = PivotId::from_bytes(identity::generate_uuid_v7());

    let mut def = PivotDefinition::new(
        pivot_id,
        (0, 0),                                      // source_start (row 0, col 0)
        (data_row_count as u32, 8),                   // source_end (last data row, col 8)
    );

    def.name = Some("Sales by Category & Territory".to_string());
    def.source_has_headers = true;
    if is_bi {
        def.source_range_display = Some("Adventure Works Sales Model".to_string());
    }

    // Pivot output starts at row 3 on the Dashboard sheet (below the title)
    def.destination = (3, 0);
    def.destination_sheet = Some("Dashboard".to_string());

    if is_bi {
        // BI pivot: field names must be in "Table.Column" format and value fields
        // must reference BI model measure names (not grid column headers).
        // Source index 0 is used as placeholder — the BI engine resolves by name.
        def.row_fields = vec![
            PivotField::new(0, "dim_product.categoryname".to_string()),
            PivotField::new(0, "dim_product.productname".to_string()),
        ];
        def.column_fields = vec![
            PivotField::new(0, "dim_territory.territorygroup".to_string()),
        ];
        // Value fields use BI measure names directly
        def.value_fields = vec![
            ValueField::new(0, "TotalSales".to_string(), AggregationType::Sum),
            ValueField::new(0, "TotalQty".to_string(), AggregationType::Sum),
        ];
    } else {
        // Grid pivot: field names are grid column headers, source_index is column position
        def.row_fields = vec![
            PivotField::new(0, "Category".to_string()),
            PivotField::new(1, "Product".to_string()),
        ];
        def.column_fields = vec![
            PivotField::new(3, "Territory Group".to_string()),
        ];
        def.value_fields = vec![
            ValueField::new(8, "Sum of Line Total".to_string(), AggregationType::Sum),
            ValueField::new(6, "Sum of Order Qty".to_string(), AggregationType::Sum),
        ];
    }

    def
}

/// Build BI pivot metadata (SavedBiPivotMetadata) from model JSON.
/// This metadata tells the pivot extension what tables/columns/measures are available.
fn build_bi_pivot_metadata(pivot_id: PivotId, model_or_bundle: &serde_json::Value) -> serde_json::Value {
    // Handle both ModelBundle (tables inside "model") and raw DataModel
    let model = model_or_bundle.get("model").unwrap_or(model_or_bundle);
    let mut model_tables = Vec::new();

    if let Some(tables) = model.get("tables").and_then(|t| t.as_array()) {
        for table in tables {
            let name = table.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
            let columns: Vec<serde_json::Value> = table.get("columns")
                .and_then(|c| c.as_array())
                .map(|cols| cols.iter().map(|col| {
                    let col_name = col.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                    let data_type = col.get("data_type").map(|dt| {
                        if dt.is_string() { dt.as_str().unwrap_or("String").to_string() }
                        else { format!("{}", dt) }
                    }).unwrap_or_else(|| "String".to_string());
                    let is_numeric = matches!(data_type.as_str(), "Int32" | "Int64" | "Float64")
                        || data_type.starts_with("{\"Decimal");
                    serde_json::json!({
                        "name": col_name,
                        "dataType": data_type,
                        "isNumeric": is_numeric,
                    })
                }).collect())
                .unwrap_or_default();
            model_tables.push(serde_json::json!({
                "name": name,
                "columns": columns,
            }));
        }
    }

    // Extract measures from the model (DAX measures or calculated measures)
    let measures: Vec<serde_json::Value> = model.get("measures")
        .and_then(|m| m.as_array())
        .map(|arr| arr.iter().map(|m| {
            serde_json::json!({
                "name": m.get("name").and_then(|n| n.as_str()).unwrap_or(""),
                "table": m.get("table").and_then(|t| t.as_str()).unwrap_or(""),
                "sourceColumn": m.get("source_column").and_then(|s| s.as_str()).unwrap_or(""),
                "aggregation": m.get("aggregation").and_then(|a| a.as_str()).unwrap_or("Sum"),
            })
        }).collect())
        .unwrap_or_default();

    serde_json::json!({
        "pivotId": pivot_id.to_string(),
        "modelTables": model_tables,
        "measures": measures,
        "lookupColumns": [],
        // Routes the pivot to its data source on pull (matches the ds_id in
        // load_bi_data_source below).
        "dataSourceId": "bi-sales-model",
    })
}

/// Load a BI model file and build a PublishDataSource from it.
fn load_bi_data_source(model_path: &Path) -> Option<PublishDataSource> {
    let raw = match std::fs::read_to_string(model_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("Warning: Could not read model file: {}", e);
            return None;
        }
    };

    // Parse - handle both raw DataModel and ModelBundle wrapper formats
    let model_json: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("Warning: Could not parse model JSON: {}", e);
            return None;
        }
    };

    // If it's a ModelBundle, use it as-is (connectionSpecs live at the wrapper level).
    // Extract the inner DataModel for table inspection.
    let (bundle, inner_model) = if model_json.get("model").is_some() && model_json.get("formatVersion").is_some() {
        (model_json.clone(), model_json["model"].clone())
    } else {
        (model_json.clone(), model_json)
    };

    // Extract table names from the inner model for bindings
    let tables = inner_model.get("tables")
        .and_then(|t| t.as_array())
        .map(|arr| arr.iter().filter_map(|t| t.get("name").and_then(|n| n.as_str()).map(|s| s.to_string())).collect::<Vec<_>>())
        .unwrap_or_default();

    let bindings: Vec<PackageBinding> = tables.iter().map(|table_name| {
        PackageBinding {
            model_table: table_name.clone(),
            schema: "BI".to_string(),
            source_table: table_name.clone(),
            source_query: None,
        }
    }).collect();

    let ds_id = "bi-sales-model".to_string();

    Some(PublishDataSource {
        id: ds_id,
        name: "Adventure Works Sales Model".to_string(),
        connection_type: "PostgreSQL".to_string(),
        server: String::new(), // read from model's connectionSpecs at pull time
        database: String::new(),
        model_json: bundle, // embed full ModelBundle (includes connectionSpecs)
        bindings,
        calculated_table_snapshots: Vec::new(),
    })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: publish_report <registry_dir> [model_path]");
        eprintln!();
        eprintln!("Example:");
        eprintln!("  cargo run --example publish_report -- \\");
        eprintln!("    \"C:\\Dropbox\\Projekt\\Calcula\\output\\registry\" \\");
        eprintln!("    \"C:\\Dropbox\\Projekt\\Calcula Studio\\examples\\model.json\"");
        std::process::exit(1);
    }

    let registry_path = Path::new(&args[1]);

    // Optionally load the BI model
    let model_path = args.get(2).map(|s| Path::new(s));
    let data_source = model_path.and_then(|p| load_bi_data_source(p));

    // Build workbook
    let data = sample_data();
    let data_count = data.len();
    drop(data);

    let data_sheet = build_data_sheet();
    let dashboard_sheet = build_dashboard_sheet();

    let mut workbook = Workbook::new();
    workbook.sheets.clear();
    workbook.sheets.push(dashboard_sheet);
    workbook.sheets.push(data_sheet);
    workbook.properties.title = "Sales Performance Dashboard".to_string();
    workbook.properties.author = "Calcula Report Builder".to_string();
    workbook.properties.description = "Sales report with BI model pivot table".to_string();

    // Prepare data sources (needed before pivot definition to determine source type)
    let data_sources: Vec<PublishDataSource> = match data_source {
        Some(ds) => {
            println!("BI model embedded: {} ({} bindings)", ds.name, ds.bindings.len());
            vec![ds]
        }
        None => {
            println!("No BI model provided (pivot uses static grid data only)");
            vec![]
        }
    };
    let is_bi = !data_sources.is_empty();

    // Build and embed the pivot definition
    let pivot_def = build_pivot_definition(data_count, is_bi);
    println!("Pivot: {} ({}x{} source)", pivot_def.name.as_deref().unwrap_or("unnamed"), data_count, HEADERS.len());

    let pivot_json = serde_json::to_value(&pivot_def).expect("Failed to serialize PivotDefinition");
    workbook.pivot_definitions.push(SavedPivotDefinition {
        id: pivot_def.id,
        source_type: if is_bi { "bi".to_string() } else { "grid".to_string() },
        source_sheet_index: Some(1), // "Sales Data" is sheet index 1 (snapshot data for initial render)
        definition: pivot_json,
    });

    // If we have a BI model, add BI pivot metadata so the pivot knows about model fields
    if is_bi {
        let bi_meta = build_bi_pivot_metadata(pivot_def.id, &data_sources[0].model_json);
        workbook.bi_pivot_metadata.push(bi_meta);
    }

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
            "2026-06-02T{:02}:{:02}:{:02}Z",
            (dur.as_secs() / 3600) % 24,
            (dur.as_secs() / 60) % 60,
            dur.as_secs() % 60,
        )
    };

    // Exclude pivot output cells from the Dashboard sheet.
    // Subscribers recalculate these from the pivot definition + source data.
    let dashboard_id = workbook.sheets[0].id;
    let pivot_dest = pivot_def.destination; // (3, 0) on Dashboard
    let excluded_regions = vec![
        ExcludedRegion {
            sheet_id: dashboard_id,
            start_row: pivot_dest.0,
            start_col: pivot_dest.1,
            end_row: pivot_dest.0 + 100, // generous upper bound
            end_col: pivot_dest.1 + 20,
        },
    ];

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
        module_scripts: None,
        notebooks: None,
        data_sources,
        excluded_regions,
        custom_objects: Vec::new(),
        include_comments: false,
        min_app_version: String::new(),
    };

    // Profile dir holds the publisher's Ed25519 keypair (created on first
    // publish) for signing the manifest (S5 phase 2). Kept next to the
    // registry for this example.
    let profile_dir = registry_path.join(".calcula-profile");
    let result = publish(&registry, &request, &profile_dir).expect("Publish failed");

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
