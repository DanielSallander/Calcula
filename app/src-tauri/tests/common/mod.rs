//! FILENAME: tests/common/mod.rs
//! Test harness and fixtures for Calcula backend integration tests.

use app_lib::{
    create_app_state, AppState, CellData, MergedRegion,
    NamedRange,
};
use engine::{Cell, CellValue, Grid};

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

    /// Create a harness with a sample spreadsheet grid (10x10 with test data).
    pub fn with_sample_data() -> Self {
        let harness = Self::new();
        harness.populate_sample_data();
        harness
    }

    /// Create a harness with a larger dataset for performance testing.
    pub fn with_large_data(rows: u32, cols: u32) -> Self {
        let harness = Self::new();
        harness.populate_large_data(rows, cols);
        harness
    }

    /// Create a harness with formula test data.
    pub fn with_formula_data() -> Self {
        let harness = Self::new();
        harness.populate_formula_data();
        harness
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

    /// Populate with sample spreadsheet data.
    fn populate_sample_data(&self) {
        let mut grid = self.state.grid.lock().unwrap();
        let mut grids = self.state.grids.lock().unwrap();

        // Header row (row 0)
        grid.set_cell(0, 0, Cell::new_text("Name".to_string()));
        grid.set_cell(0, 1, Cell::new_text("Age".to_string()));
        grid.set_cell(0, 2, Cell::new_text("City".to_string()));
        grid.set_cell(0, 3, Cell::new_text("Salary".to_string()));
        grid.set_cell(0, 4, Cell::new_text("Active".to_string()));

        // Data rows
        let test_data = vec![
            ("Alice", 30.0, "New York", 75000.0, true),
            ("Bob", 25.0, "Los Angeles", 65000.0, true),
            ("Charlie", 35.0, "Chicago", 85000.0, false),
            ("Diana", 28.0, "Houston", 70000.0, true),
            ("Eve", 32.0, "Phoenix", 80000.0, true),
            ("Frank", 45.0, "Philadelphia", 95000.0, false),
            ("Grace", 29.0, "San Antonio", 72000.0, true),
            ("Henry", 38.0, "San Diego", 88000.0, true),
            ("Ivy", 26.0, "Dallas", 62000.0, false),
        ];

        for (i, (name, age, city, salary, active)) in test_data.iter().enumerate() {
            let row = (i + 1) as u32;
            grid.set_cell(row, 0, Cell::new_text(name.to_string()));
            grid.set_cell(row, 1, Cell::new_number(*age));
            grid.set_cell(row, 2, Cell::new_text(city.to_string()));
            grid.set_cell(row, 3, Cell::new_number(*salary));
            grid.set_cell(row, 4, Cell::new_boolean(*active));
        }

        // Sync to grids[0]
        if !grids.is_empty() {
            grids[0] = grid.clone();
        }
    }

    /// Populate with formula test data.
    fn populate_formula_data(&self) {
        let mut grid = self.state.grid.lock().unwrap();
        let mut grids = self.state.grids.lock().unwrap();

        // Numbers in column A (A1:A5 = 10, 20, 30, 40, 50)
        for i in 0..5 {
            grid.set_cell(i, 0, Cell::new_number((i as f64 + 1.0) * 10.0));
        }

        // Numbers in column B (B1:B5 = 5, 10, 15, 20, 25)
        for i in 0..5 {
            grid.set_cell(i, 1, Cell::new_number((i as f64 + 1.0) * 5.0));
        }

        // Formulas in column C
        grid.set_cell(0, 2, Cell::new_formula("=A1+B1".to_string())); // C1 = 15
        grid.set_cell(1, 2, Cell::new_formula("=A2*B2".to_string())); // C2 = 200
        grid.set_cell(2, 2, Cell::new_formula("=SUM(A1:A5)".to_string())); // C3 = 150
        grid.set_cell(3, 2, Cell::new_formula("=AVERAGE(B1:B5)".to_string())); // C4 = 15
        grid.set_cell(4, 2, Cell::new_formula("=A5/B5".to_string())); // C5 = 2

        // Sync to grids[0]
        if !grids.is_empty() {
            grids[0] = grid.clone();
        }
    }

    /// Populate with large dataset for performance testing.
    fn populate_large_data(&self, rows: u32, cols: u32) {
        let mut grid = self.state.grid.lock().unwrap();
        let mut grids = self.state.grids.lock().unwrap();

        for row in 0..rows {
            for col in 0..cols {
                let value = (row * cols + col) as f64;
                grid.set_cell(row, col, Cell::new_number(value));
            }
        }

        // Sync to grids[0]
        if !grids.is_empty() {
            grids[0] = grid.clone();
        }
    }

    // ========================================================================
    // HELPER METHODS FOR SETTING UP SPECIFIC TEST SCENARIOS
    // ========================================================================

    /// Set a cell value directly.
    pub fn set_cell(&self, row: u32, col: u32, cell: Cell) {
        let mut grid = self.state.grid.lock().unwrap();
        let mut grids = self.state.grids.lock().unwrap();
        grid.set_cell(row, col, cell);
        if !grids.is_empty() {
            grids[0].set_cell(row, col, grid.get_cell(row, col).unwrap().clone());
        }
    }

    /// Set a cell value by text input (uses parse_cell_input).
    pub fn set_cell_input(&self, row: u32, col: u32, input: &str) {
        let cell = app_lib::parse_cell_input(input);
        self.set_cell(row, col, cell);
    }

    /// Add a named range.
    /// Note: range is stored as coordinates, not a string. This helper parses simple ranges like "A1:D10".
    pub fn add_named_range(&self, name: &str, range: &str, sheet_index: usize) {
        let mut named_ranges = self.state.named_ranges.lock().unwrap();

        // Parse range string to coordinates (simplified parser for tests)
        let (start_row, start_col, end_row, end_col) = parse_range_for_test(range);

        named_ranges.insert(
            name.to_uppercase(),
            NamedRange {
                name: name.to_string(),
                sheet_index: Some(sheet_index),
                start_row,
                start_col,
                end_row,
                end_col,
                comment: None,
            },
        );
    }

    /// Add a merged region.
    pub fn add_merged_region(&self, start_row: u32, start_col: u32, end_row: u32, end_col: u32) {
        let mut merged = self.state.merged_regions.lock().unwrap();
        merged.insert(MergedRegion {
            start_row,
            start_col,
            end_row,
            end_col,
        });
    }

    /// Set column width.
    pub fn set_column_width(&self, col: u32, width: f64) {
        let mut widths = self.state.column_widths.lock().unwrap();
        widths.insert(col, width);
    }

    /// Set row height.
    pub fn set_row_height(&self, row: u32, height: f64) {
        let mut heights = self.state.row_heights.lock().unwrap();
        heights.insert(row, height);
    }

    /// Get cell value as string.
    pub fn get_cell_display(&self, row: u32, col: u32) -> Option<String> {
        let grid = self.state.grid.lock().unwrap();
        let styles = self.state.style_registry.lock().unwrap();
        if let Some(cell) = grid.get_cell(row, col) {
            let style = styles.get(cell.style_index);
            Some(app_lib::format_cell_value(&cell.value, style))
        } else {
            None
        }
    }

    /// Get cell formula.
    pub fn get_cell_formula(&self, row: u32, col: u32) -> Option<String> {
        let grid = self.state.grid.lock().unwrap();
        grid.get_cell(row, col).and_then(|c| c.formula.clone())
    }

    /// Get cell value (raw).
    pub fn get_cell_value(&self, row: u32, col: u32) -> Option<CellValue> {
        let grid = self.state.grid.lock().unwrap();
        grid.get_cell(row, col).map(|c| c.value.clone())
    }

    /// Get active sheet index.
    pub fn get_active_sheet(&self) -> usize {
        *self.state.active_sheet.lock().unwrap()
    }

    /// Set active sheet.
    pub fn set_active_sheet(&self, index: usize) {
        let mut active = self.state.active_sheet.lock().unwrap();
        let grids = self.state.grids.lock().unwrap();
        if index < grids.len() {
            *active = index;
            drop(grids);
            drop(active);
            // Sync the active grid
            let grids = self.state.grids.lock().unwrap();
            let mut grid = self.state.grid.lock().unwrap();
            if index < grids.len() {
                *grid = grids[index].clone();
            }
        }
    }

    /// Get sheet count.
    pub fn get_sheet_count(&self) -> usize {
        self.state.sheet_names.lock().unwrap().len()
    }

    /// Get sheet name.
    pub fn get_sheet_name(&self, index: usize) -> Option<String> {
        self.state.sheet_names.lock().unwrap().get(index).cloned()
    }

    /// Get cell count in current grid.
    pub fn get_cell_count(&self) -> usize {
        self.state.grid.lock().unwrap().cells.len()
    }
}

impl Default for TestHarness {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// TEST DATA FIXTURES
// ============================================================================

/// Sample employee data for testing.
pub struct EmployeeFixture;

impl EmployeeFixture {
    pub fn headers() -> Vec<&'static str> {
        vec!["Name", "Age", "City", "Salary", "Active"]
    }

    pub fn data() -> Vec<(&'static str, f64, &'static str, f64, bool)> {
        vec![
            ("Alice", 30.0, "New York", 75000.0, true),
            ("Bob", 25.0, "Los Angeles", 65000.0, true),
            ("Charlie", 35.0, "Chicago", 85000.0, false),
            ("Diana", 28.0, "Houston", 70000.0, true),
            ("Eve", 32.0, "Phoenix", 80000.0, true),
        ]
    }
}

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

// ============================================================================
// ASSERTION HELPERS
// ============================================================================

/// Assert that a cell contains an expected number value.
pub fn assert_cell_number(harness: &TestHarness, row: u32, col: u32, expected: f64) {
    let value = harness.get_cell_value(row, col);
    match value {
        Some(CellValue::Number(n)) => {
            assert!(
                (n - expected).abs() < 0.001,
                "Cell ({}, {}) expected {} but got {}",
                row, col, expected, n
            );
        }
        other => panic!(
            "Cell ({}, {}) expected Number({}) but got {:?}",
            row, col, expected, other
        ),
    }
}

/// Assert that a cell contains expected text.
pub fn assert_cell_text(harness: &TestHarness, row: u32, col: u32, expected: &str) {
    let value = harness.get_cell_value(row, col);
    match value {
        Some(CellValue::Text(s)) => {
            assert_eq!(
                s, expected,
                "Cell ({}, {}) expected '{}' but got '{}'",
                row, col, expected, s
            );
        }
        other => panic!(
            "Cell ({}, {}) expected Text('{}') but got {:?}",
            row, col, expected, other
        ),
    }
}

/// Assert that a cell is empty.
pub fn assert_cell_empty(harness: &TestHarness, row: u32, col: u32) {
    let value = harness.get_cell_value(row, col);
    match value {
        None | Some(CellValue::Empty) => {}
        other => panic!("Cell ({}, {}) expected empty but got {:?}", row, col, other),
    }
}

/// Assert that a cell contains a boolean.
pub fn assert_cell_boolean(harness: &TestHarness, row: u32, col: u32, expected: bool) {
    let value = harness.get_cell_value(row, col);
    match value {
        Some(CellValue::Boolean(b)) => {
            assert_eq!(
                b, expected,
                "Cell ({}, {}) expected {} but got {}",
                row, col, expected, b
            );
        }
        other => panic!(
            "Cell ({}, {}) expected Boolean({}) but got {:?}",
            row, col, expected, other
        ),
    }
}

/// Assert cell display value (formatted string).
pub fn assert_cell_display(harness: &TestHarness, row: u32, col: u32, expected: &str) {
    let display = harness.get_cell_display(row, col).unwrap_or_default();
    assert_eq!(
        display, expected,
        "Cell ({}, {}) display expected '{}' but got '{}'",
        row, col, expected, display
    );
}

// ============================================================================
// RESULT COMPARISON HELPERS
// ============================================================================

/// Parse a range string for testing (simplified parser).
/// Supports formats like "A1:D10", "A1", "A:A", "1:1", "$A$1:$D$10", "'Sheet 1'!A1:D10"
/// Returns (start_row, start_col, end_row, end_col) as 0-indexed values.
pub fn parse_range_for_test(range: &str) -> (u32, u32, u32, u32) {
    // Remove sheet reference if present
    let range = if let Some(idx) = range.find('!') {
        &range[idx + 1..]
    } else {
        range
    };

    // Remove absolute reference markers
    let range = range.replace('$', "");

    // Handle column-only ranges like "A:A"
    if range.chars().all(|c| c.is_ascii_alphabetic() || c == ':') {
        let parts: Vec<&str> = range.split(':').collect();
        let start_col = col_to_index(parts[0]);
        let end_col = if parts.len() > 1 {
            col_to_index(parts[1])
        } else {
            start_col
        };
        return (0, start_col, u32::MAX, end_col);
    }

    // Handle row-only ranges like "1:1"
    if range.chars().all(|c| c.is_ascii_digit() || c == ':') {
        let parts: Vec<&str> = range.split(':').collect();
        let start_row = parts[0].parse::<u32>().unwrap_or(1) - 1;
        let end_row = if parts.len() > 1 {
            parts[1].parse::<u32>().unwrap_or(1) - 1
        } else {
            start_row
        };
        return (start_row, 0, end_row, u32::MAX);
    }

    // Handle cell ranges like "A1:D10" or single cells like "A1"
    let parts: Vec<&str> = range.split(':').collect();
    let (start_row, start_col) = parse_cell_ref(parts[0]);
    let (end_row, end_col) = if parts.len() > 1 {
        parse_cell_ref(parts[1])
    } else {
        (start_row, start_col)
    };

    (start_row, start_col, end_row, end_col)
}

/// Parse a cell reference like "A1" to (row, col) 0-indexed.
fn parse_cell_ref(cell_ref: &str) -> (u32, u32) {
    let mut col_str = String::new();
    let mut row_str = String::new();

    for c in cell_ref.chars() {
        if c.is_ascii_alphabetic() {
            col_str.push(c);
        } else if c.is_ascii_digit() {
            row_str.push(c);
        }
    }

    let col = col_to_index(&col_str);
    let row = row_str.parse::<u32>().unwrap_or(1) - 1;

    (row, col)
}

/// Convert column letters to 0-indexed column number (A=0, B=1, ..., Z=25, AA=26, etc.)
fn col_to_index(col: &str) -> u32 {
    let mut result: u32 = 0;
    for c in col.to_uppercase().chars() {
        if c.is_ascii_alphabetic() {
            result = result * 26 + (c as u32 - 'A' as u32 + 1);
        }
    }
    if result > 0 {
        result - 1
    } else {
        0
    }
}

/// Compare two CellData vectors (ignoring order).
pub fn assert_cells_equal_unordered(actual: &[CellData], expected: &[CellData]) {
    assert_eq!(
        actual.len(),
        expected.len(),
        "Cell count mismatch: {} vs {}",
        actual.len(),
        expected.len()
    );

    for exp in expected {
        let found = actual.iter().find(|a| a.row == exp.row && a.col == exp.col);
        assert!(
            found.is_some(),
            "Expected cell ({}, {}) not found",
            exp.row, exp.col
        );
        let act = found.unwrap();
        assert_eq!(
            act.display, exp.display,
            "Cell ({}, {}) display mismatch",
            exp.row, exp.col
        );
    }
}
