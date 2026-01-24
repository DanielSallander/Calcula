// FILENAME: core\persistence\src\lib.rs
//! Calcula Persistence Module
//!
//! Handles saving and loading spreadsheet files in XLSX format.

mod error;
mod xlsx_reader;
mod xlsx_writer;

pub use error::PersistenceError;
pub use xlsx_reader::load_xlsx;
pub use xlsx_writer::save_xlsx;

use engine::cell::{Cell, CellValue};
use engine::grid::Grid;
use engine::style::{CellStyle, StyleRegistry};
use std::collections::HashMap;

/// Represents a complete workbook that can be saved/loaded
#[derive(Debug, Clone)]
pub struct Workbook {
    pub sheets: Vec<Sheet>,
    pub active_sheet: usize,
}

impl Workbook {
    pub fn new() -> Self {
        Self {
            sheets: vec![Sheet::new("Sheet1".to_string())],
            active_sheet: 0,
        }
    }

    pub fn from_grid(grid: &Grid, styles: &StyleRegistry, dimensions: &DimensionData) -> Self {
        Self {
            sheets: vec![Sheet::from_grid("Sheet1".to_string(), grid, styles, dimensions)],
            active_sheet: 0,
        }
    }
}

impl Default for Workbook {
    fn default() -> Self {
        Self::new()
    }
}

/// Represents a single worksheet
#[derive(Debug, Clone)]
pub struct Sheet {
    pub name: String,
    pub cells: HashMap<(u32, u32), SavedCell>,
    pub column_widths: HashMap<u32, f64>,
    pub row_heights: HashMap<u32, f64>,
    pub styles: Vec<CellStyle>,
}

impl Sheet {
    pub fn new(name: String) -> Self {
        Self {
            name,
            cells: HashMap::new(),
            column_widths: HashMap::new(),
            row_heights: HashMap::new(),
            styles: vec![CellStyle::new()],
        }
    }

    pub fn from_grid(name: String, grid: &Grid, styles: &StyleRegistry, dimensions: &DimensionData) -> Self {
        let mut cells = HashMap::new();

        for ((row, col), cell) in grid.cells.iter() {
            cells.insert((*row, *col), SavedCell::from_cell(cell));
        }

        Self {
            name,
            cells,
            column_widths: dimensions.column_widths.clone(),
            row_heights: dimensions.row_heights.clone(),
            styles: styles.all_styles().to_vec(),
        }
    }

    pub fn to_grid(&self) -> (Grid, StyleRegistry) {
        let mut grid = Grid::new();
        let mut style_registry = StyleRegistry::new();

        // Rebuild styles
        for style in &self.styles[1..] {
            style_registry.get_or_create(style.clone());
        }

        // Rebuild cells
        for ((row, col), saved_cell) in &self.cells {
            let cell = saved_cell.to_cell();
            grid.set_cell(*row, *col, cell);
        }

        (grid, style_registry)
    }
}

/// Dimension data for columns and rows
#[derive(Debug, Clone, Default)]
pub struct DimensionData {
    pub column_widths: HashMap<u32, f64>,
    pub row_heights: HashMap<u32, f64>,
}

/// A cell that can be serialized
#[derive(Debug, Clone)]
pub struct SavedCell {
    pub value: SavedCellValue,
    pub formula: Option<String>,
    pub style_index: usize,
}

impl SavedCell {
    pub fn from_cell(cell: &Cell) -> Self {
        Self {
            value: SavedCellValue::from_value(&cell.value),
            formula: cell.formula.clone(),
            style_index: cell.style_index,
        }
    }

    pub fn to_cell(&self) -> Cell {
        Cell {
            value: self.value.to_value(),
            formula: self.formula.clone(),
            style_index: self.style_index,
        }
    }
}

/// Serializable cell value
#[derive(Debug, Clone)]
pub enum SavedCellValue {
    Empty,
    Number(f64),
    Text(String),
    Boolean(bool),
    Error(String),
}

impl SavedCellValue {
    pub fn from_value(value: &CellValue) -> Self {
        match value {
            CellValue::Empty => SavedCellValue::Empty,
            CellValue::Number(n) => SavedCellValue::Number(*n),
            CellValue::Text(s) => SavedCellValue::Text(s.clone()),
            CellValue::Boolean(b) => SavedCellValue::Boolean(*b),
            CellValue::Error(e) => SavedCellValue::Error(format!("{:?}", e)),
        }
    }

    pub fn to_value(&self) -> CellValue {
        match self {
            SavedCellValue::Empty => CellValue::Empty,
            SavedCellValue::Number(n) => CellValue::Number(*n),
            SavedCellValue::Text(s) => CellValue::Text(s.clone()),
            SavedCellValue::Boolean(b) => CellValue::Boolean(*b),
            SavedCellValue::Error(_) => CellValue::Error(engine::cell::CellError::Value),
        }
    }
}