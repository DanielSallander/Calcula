//! FILENAME: tests/common/mod.rs
//! Test harness and fixtures for Calcula backend integration tests.

use app_lib::{create_app_state, AppState};
use engine::{Cell, CellValue, Grid};

use pivot_engine::{
    PivotCache, PivotDefinition, PivotField, PivotView,
    PivotCellType, PivotCellValue, ValueField, calculate_pivot,
};

// ============================================================================
// TEST HARNESS
// ============================================================================

/// Test harness for creating and managing test state.
pub struct TestHarness {
    pub state: AppState,
}

impl TestHarness {
    /// Create a new test harness with empty state.
    pub fn new() -> Self {
        TestHarness {
            state: create_app_state(),
        }
    }

    /// Create a harness with multiple sheets.
    pub fn with_multiple_sheets(sheet_count: usize) -> Self {
        let harness = Self::new();
        {
            let mut names = harness.state.sheet_names.lock().unwrap();
            let mut grids = harness.state.grids.lock().unwrap();
            let mut freeze_configs = harness.state.freeze_configs.lock().unwrap();

            for i in 1..sheet_count {
                names.push(format!("Sheet{}", i + 1));
                grids.push(Grid::new());
                freeze_configs.push(app_lib::FreezeConfig::default());
            }
        }
        harness
    }

    /// Set a cell value directly.
    pub fn set_cell(&self, row: u32, col: u32, cell: Cell) {
        let mut grid = self.state.grid.lock().unwrap();
        let mut grids = self.state.grids.lock().unwrap();
        grid.set_cell(row, col, cell);
        if !grids.is_empty() {
            grids[0].set_cell(row, col, grid.get_cell(row, col).unwrap().clone());
        }
    }

    /// Get cell value (raw).
    pub fn get_cell_value(&self, row: u32, col: u32) -> Option<CellValue> {
        let grid = self.state.grid.lock().unwrap();
        grid.get_cell(row, col).map(|c| c.value.clone())
    }
}

impl Default for TestHarness {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// PIVOT ENGINE HELPERS
// ============================================================================

impl TestHarness {
    /// Build a PivotCache from the current grid's source range.
    /// `start`/`end` are 0-based (row, col), `has_headers` controls whether
    /// the first row is treated as column names.
    pub fn build_pivot_cache(
        &self,
        start: (u32, u32),
        end: (u32, u32),
        has_headers: bool,
    ) -> (PivotCache, Vec<String>) {
        let grid = self.state.grid.lock().unwrap();
        let (start_row, start_col) = start;
        let (end_row, end_col) = end;
        let col_count = (end_col - start_col + 1) as usize;

        let data_start_row = if has_headers { start_row + 1 } else { start_row };

        let headers: Vec<String> = if has_headers {
            (start_col..=end_col)
                .map(|c| {
                    grid.get_cell(start_row, c)
                        .map(|cell| cell.display_value())
                        .unwrap_or_else(|| format!("Col{}", c - start_col))
                })
                .collect()
        } else {
            (0..col_count).map(|i| format!("Col{}", i)).collect()
        };

        // Find effective end row
        let mut effective_end_row = data_start_row.saturating_sub(1);
        for row in (data_start_row..=end_row).rev() {
            let has_data = (start_col..=end_col)
                .any(|col| grid.get_cell(row, col).is_some());
            if has_data {
                effective_end_row = row;
                break;
            }
        }

        let mut cache = PivotCache::new(1, col_count);
        for (i, name) in headers.iter().enumerate() {
            cache.set_field_name(i, name.clone());
        }

        for row in data_start_row..=effective_end_row {
            let mut values: Vec<CellValue> = Vec::with_capacity(col_count);
            for col in start_col..=end_col {
                let value = grid
                    .get_cell(row, col)
                    .map(|cell| cell.value.clone())
                    .unwrap_or(CellValue::Empty);
                values.push(value);
            }
            cache.add_record(row - data_start_row, &values);
        }

        (cache, headers)
    }

    /// Create a complete pivot: builds cache from grid, applies definition, returns view.
    pub fn create_pivot(
        &self,
        source_start: (u32, u32),
        source_end: (u32, u32),
        row_fields: Vec<PivotField>,
        column_fields: Vec<PivotField>,
        value_fields: Vec<ValueField>,
    ) -> (PivotDefinition, PivotCache, PivotView) {
        let (mut cache, _headers) = self.build_pivot_cache(source_start, source_end, true);

        let mut def = PivotDefinition::new(1, source_start, source_end);
        def.source_has_headers = true;
        def.row_fields = row_fields;
        def.column_fields = column_fields;
        def.value_fields = value_fields;

        let view = calculate_pivot(&def, &mut cache);
        (def, cache, view)
    }
}

// ============================================================================
// TEST DATA FIXTURES
// ============================================================================

/// Sample financial data for pivot table testing.
pub struct SalesFixture;

impl SalesFixture {
    pub fn headers() -> Vec<&'static str> {
        vec!["Region", "Product", "Quarter", "Sales", "Quantity"]
    }

    pub fn data() -> Vec<(&'static str, &'static str, &'static str, f64, f64)> {
        vec![
            ("North", "Widget", "Q1", 10000.0, 100.0),
            ("North", "Widget", "Q2", 12000.0, 120.0),
            ("North", "Gadget", "Q1", 8000.0, 80.0),
            ("North", "Gadget", "Q2", 9000.0, 90.0),
            ("South", "Widget", "Q1", 15000.0, 150.0),
            ("South", "Widget", "Q2", 14000.0, 140.0),
            ("South", "Gadget", "Q1", 11000.0, 110.0),
            ("South", "Gadget", "Q2", 13000.0, 130.0),
            ("East", "Widget", "Q1", 9000.0, 90.0),
            ("East", "Widget", "Q2", 11000.0, 110.0),
            ("East", "Gadget", "Q1", 7000.0, 70.0),
            ("East", "Gadget", "Q2", 8500.0, 85.0),
        ]
    }
}

/// Adventure Works sales fixture -- mirrors the BI model schema.
/// Provides a denormalised view of fact_sales joined with dimensions.
pub struct AdventureWorksFixture;

impl AdventureWorksFixture {
    /// Column headers matching the denormalised model.
    pub fn headers() -> Vec<&'static str> {
        vec![
            "Territory",   // 0 - dim_territory.territoryname
            "Country",     // 1 - dim_territory.countryregioncode
            "Category",    // 2 - dim_product.categoryname
            "SubCategory", // 3 - dim_product.subcategoryname
            "Product",     // 4 - dim_product.productname
            "Customer",    // 5 - dim_customer.fullname
            "City",        // 6 - dim_customer.city
            "Year",        // 7 - dim_date.year
            "Quarter",     // 8 - dim_date.quarter
            "Month",       // 9 - dim_date.month
            "OrderQty",    // 10 - fact_sales.orderqty
            "UnitPrice",   // 11 - fact_sales.unitprice
            "LineTotal",   // 12 - fact_sales.linetotal
        ]
    }

    /// 40 rows of representative data modelled after the Adventure Works schema.
    pub fn data() -> Vec<(
        &'static str, &'static str, &'static str, &'static str, &'static str,
        &'static str, &'static str, f64, f64, f64, f64, f64, f64,
    )> {
        vec![
            ("Northwest", "US", "Bikes", "Mountain Bikes", "Mountain-100", "Alice Adams", "Seattle", 2023.0, 1.0, 1.0, 2.0, 3399.99, 6799.98),
            ("Northwest", "US", "Bikes", "Mountain Bikes", "Mountain-200", "Bob Brown", "Portland", 2023.0, 1.0, 2.0, 1.0, 2294.99, 2294.99),
            ("Northwest", "US", "Bikes", "Road Bikes", "Road-150", "Alice Adams", "Seattle", 2023.0, 1.0, 3.0, 3.0, 3578.27, 10734.81),
            ("Northwest", "US", "Clothing", "Jerseys", "Sport-100", "Charlie Clark", "Tacoma", 2023.0, 2.0, 4.0, 5.0, 34.99, 174.95),
            ("Northwest", "US", "Clothing", "Shorts", "Sport-200", "Bob Brown", "Portland", 2023.0, 2.0, 5.0, 4.0, 49.99, 199.96),
            ("Southwest", "US", "Bikes", "Mountain Bikes", "Mountain-100", "Diana Davis", "Phoenix", 2023.0, 2.0, 4.0, 1.0, 3399.99, 3399.99),
            ("Southwest", "US", "Bikes", "Road Bikes", "Road-250", "Eve Evans", "Tucson", 2023.0, 2.0, 6.0, 2.0, 2443.35, 4886.70),
            ("Southwest", "US", "Clothing", "Jerseys", "Sport-100", "Diana Davis", "Phoenix", 2023.0, 3.0, 7.0, 3.0, 34.99, 104.97),
            ("Southwest", "US", "Clothing", "Gloves", "Glove-100", "Frank Foster", "Albuquerque", 2023.0, 3.0, 8.0, 6.0, 28.99, 173.94),
            ("Northeast", "US", "Bikes", "Mountain Bikes", "Mountain-100", "Grace Green", "New York", 2023.0, 1.0, 1.0, 2.0, 3399.99, 6799.98),
            ("Northeast", "US", "Bikes", "Road Bikes", "Road-150", "Henry Hill", "Boston", 2023.0, 1.0, 2.0, 1.0, 3578.27, 3578.27),
            ("Northeast", "US", "Clothing", "Jerseys", "Sport-100", "Grace Green", "New York", 2023.0, 3.0, 9.0, 10.0, 34.99, 349.90),
            ("Northeast", "US", "Clothing", "Caps", "Cap-100", "Irene Ito", "Philadelphia", 2023.0, 4.0, 10.0, 8.0, 19.99, 159.92),
            ("Central", "US", "Bikes", "Mountain Bikes", "Mountain-200", "Jack Jones", "Chicago", 2023.0, 1.0, 3.0, 1.0, 2294.99, 2294.99),
            ("Central", "US", "Bikes", "Touring Bikes", "Touring-1000", "Karen King", "Denver", 2023.0, 2.0, 5.0, 2.0, 2384.07, 4768.14),
            ("Central", "US", "Clothing", "Shorts", "Sport-200", "Jack Jones", "Chicago", 2023.0, 3.0, 7.0, 3.0, 49.99, 149.97),
            ("Central", "US", "Clothing", "Gloves", "Glove-100", "Larry Lee", "St Louis", 2023.0, 4.0, 11.0, 5.0, 28.99, 144.95),
            ("Northwest", "US", "Bikes", "Mountain Bikes", "Mountain-100", "Alice Adams", "Seattle", 2024.0, 1.0, 1.0, 3.0, 3399.99, 10199.97),
            ("Northwest", "US", "Bikes", "Road Bikes", "Road-150", "Bob Brown", "Portland", 2024.0, 1.0, 2.0, 2.0, 3578.27, 7156.54),
            ("Northwest", "US", "Clothing", "Jerseys", "Sport-100", "Charlie Clark", "Tacoma", 2024.0, 2.0, 4.0, 8.0, 34.99, 279.92),
            ("Southwest", "US", "Bikes", "Mountain Bikes", "Mountain-100", "Diana Davis", "Phoenix", 2024.0, 1.0, 1.0, 2.0, 3399.99, 6799.98),
            ("Southwest", "US", "Bikes", "Road Bikes", "Road-250", "Eve Evans", "Tucson", 2024.0, 2.0, 5.0, 3.0, 2443.35, 7330.05),
            ("Southwest", "US", "Clothing", "Jerseys", "Sport-100", "Frank Foster", "Albuquerque", 2024.0, 3.0, 7.0, 4.0, 34.99, 139.96),
            ("Northeast", "US", "Bikes", "Mountain Bikes", "Mountain-100", "Grace Green", "New York", 2024.0, 1.0, 1.0, 4.0, 3399.99, 13599.96),
            ("Northeast", "US", "Bikes", "Road Bikes", "Road-150", "Henry Hill", "Boston", 2024.0, 2.0, 4.0, 2.0, 3578.27, 7156.54),
            ("Northeast", "US", "Clothing", "Caps", "Cap-100", "Irene Ito", "Philadelphia", 2024.0, 3.0, 8.0, 12.0, 19.99, 239.88),
            ("Central", "US", "Bikes", "Touring Bikes", "Touring-1000", "Karen King", "Denver", 2024.0, 1.0, 3.0, 3.0, 2384.07, 7152.21),
            ("Central", "US", "Clothing", "Shorts", "Sport-200", "Larry Lee", "St Louis", 2024.0, 2.0, 6.0, 6.0, 49.99, 299.94),
            ("Canada", "CA", "Bikes", "Mountain Bikes", "Mountain-100", "Mike Morin", "Toronto", 2023.0, 1.0, 2.0, 1.0, 3399.99, 3399.99),
            ("Canada", "CA", "Bikes", "Road Bikes", "Road-250", "Nancy Ng", "Vancouver", 2023.0, 2.0, 5.0, 2.0, 2443.35, 4886.70),
            ("Canada", "CA", "Clothing", "Jerseys", "Sport-100", "Mike Morin", "Toronto", 2023.0, 3.0, 8.0, 4.0, 34.99, 139.96),
            ("Canada", "CA", "Clothing", "Caps", "Cap-100", "Nancy Ng", "Vancouver", 2023.0, 4.0, 11.0, 7.0, 19.99, 139.93),
            ("France", "FR", "Bikes", "Road Bikes", "Road-150", "Olivier Olivier", "Paris", 2023.0, 1.0, 1.0, 1.0, 3578.27, 3578.27),
            ("France", "FR", "Bikes", "Mountain Bikes", "Mountain-200", "Pierre Petit", "Lyon", 2023.0, 2.0, 4.0, 1.0, 2294.99, 2294.99),
            ("France", "FR", "Clothing", "Jerseys", "Sport-100", "Olivier Olivier", "Paris", 2023.0, 3.0, 9.0, 6.0, 34.99, 209.94),
            ("Germany", "DE", "Bikes", "Mountain Bikes", "Mountain-100", "Rainer Richter", "Berlin", 2024.0, 1.0, 1.0, 2.0, 3399.99, 6799.98),
            ("Germany", "DE", "Bikes", "Road Bikes", "Road-150", "Stefan Schulz", "Munich", 2024.0, 2.0, 5.0, 1.0, 3578.27, 3578.27),
            ("Germany", "DE", "Clothing", "Gloves", "Glove-100", "Rainer Richter", "Berlin", 2024.0, 3.0, 7.0, 5.0, 28.99, 144.95),
            ("UK", "GB", "Bikes", "Touring Bikes", "Touring-1000", "Tom Taylor", "London", 2024.0, 1.0, 2.0, 2.0, 2384.07, 4768.14),
            ("UK", "GB", "Clothing", "Jerseys", "Sport-100", "Wendy White", "Manchester", 2024.0, 2.0, 6.0, 5.0, 34.99, 174.95),
        ]
    }

    /// Populate a test harness with the Adventure Works data.
    pub fn populate(harness: &TestHarness) {
        let headers = Self::headers();
        for (col, header) in headers.iter().enumerate() {
            harness.set_cell(0, col as u32, Cell::new_text(header.to_string()));
        }
        for (i, row) in Self::data().iter().enumerate() {
            let r = (i + 1) as u32;
            harness.set_cell(r, 0, Cell::new_text(row.0.to_string()));
            harness.set_cell(r, 1, Cell::new_text(row.1.to_string()));
            harness.set_cell(r, 2, Cell::new_text(row.2.to_string()));
            harness.set_cell(r, 3, Cell::new_text(row.3.to_string()));
            harness.set_cell(r, 4, Cell::new_text(row.4.to_string()));
            harness.set_cell(r, 5, Cell::new_text(row.5.to_string()));
            harness.set_cell(r, 6, Cell::new_text(row.6.to_string()));
            harness.set_cell(r, 7, Cell::new_number(row.7));
            harness.set_cell(r, 8, Cell::new_number(row.8));
            harness.set_cell(r, 9, Cell::new_number(row.9));
            harness.set_cell(r, 10, Cell::new_number(row.10));
            harness.set_cell(r, 11, Cell::new_number(row.11));
            harness.set_cell(r, 12, Cell::new_number(row.12));
        }
    }
}

// ============================================================================
// PIVOT VIEW ASSERTION HELPERS
// ============================================================================

/// Helper: extract the grand total value from a pivot view.
pub fn pivot_grand_total(view: &PivotView) -> Option<f64> {
    for row in &view.cells {
        for cell in row {
            if cell.cell_type == PivotCellType::GrandTotal {
                if let PivotCellValue::Number(n) = &cell.value {
                    return Some(*n);
                }
            }
        }
    }
    None
}

/// Helper: collect all row header labels from a pivot view (for assertions).
pub fn pivot_row_labels(view: &PivotView) -> Vec<String> {
    let mut labels = Vec::new();
    for row in &view.cells {
        for cell in row {
            if cell.cell_type == PivotCellType::RowHeader {
                let val = cell.formatted_value.trim().to_string();
                if !val.is_empty() {
                    labels.push(val);
                }
            }
        }
    }
    labels
}

/// Helper: collect all column header labels from a pivot view.
pub fn pivot_col_labels(view: &PivotView) -> Vec<String> {
    let mut labels = Vec::new();
    for row in &view.cells {
        for cell in row {
            if cell.cell_type == PivotCellType::ColumnHeader {
                let val = cell.formatted_value.trim().to_string();
                if !val.is_empty() && !labels.contains(&val) {
                    labels.push(val);
                }
            }
        }
    }
    labels
}

/// Helper: count cells of a given type in the pivot view.
pub fn pivot_cell_type_count(view: &PivotView, cell_type: PivotCellType) -> usize {
    view.cells.iter().flat_map(|r| r.iter()).filter(|c| c.cell_type == cell_type).count()
}

/// Helper: sum all Data cells in the pivot view.
pub fn pivot_data_sum(view: &PivotView) -> f64 {
    view.cells.iter().flat_map(|r| r.iter())
        .filter(|c| c.cell_type == PivotCellType::Data)
        .filter_map(|c| match &c.value { PivotCellValue::Number(n) => Some(*n), _ => None })
        .sum()
}
