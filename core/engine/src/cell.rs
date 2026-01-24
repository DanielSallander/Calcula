//! FILENAME: core/engine/src/cell.rs
//! PURPOSE: Defines the fundamental data structures for a single spreadsheet cell.
//! CONTEXT: This file contains the `Cell` struct and `CellValue` enum.
//! It separates the user's input (formula) from the calculated result (value).
//! It is designed to be lightweight as millions of these instances may exist.

use serde::{Deserialize, Serialize};

/// Represents the possible errors a cell can hold (e.g., #DIV/0!)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum CellError {
    Div0,       // Division by zero
    Ref,        // Invalid reference
    Name,       // Unknown function name
    Value,      // Wrong type of argument
    Parse,      // Formula parsing error
    Circular,   // Circular dependency detected
}

/// Represents the calculated result or raw data within a cell.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum CellValue {
    Empty,
    Number(f64),
    Text(String),
    Boolean(bool),
    Error(CellError),
}

/// The atomic unit of the spreadsheet.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Cell {
    pub formula: Option<String>,
    pub value: CellValue,
    pub style_index: usize,
}

impl Cell {
    pub fn new() -> Self {
        Cell {
            formula: None,
            value: CellValue::Empty,
            style_index: 0,
        }
    }

    pub fn new_number(num: f64) -> Self {
        Cell {
            formula: None,
            value: CellValue::Number(num),
            style_index: 0,
        }
    }

    pub fn new_text(text: String) -> Self {
        Cell {
            formula: None,
            value: CellValue::Text(text),
            style_index: 0,
        }
    }

    pub fn new_formula(formula: String) -> Self {
        Cell {
            formula: Some(formula),
            value: CellValue::Empty,
            style_index: 0,
        }
    }

    pub fn new_boolean(value: bool) -> Self {
        Cell {
            formula: None,
            value: CellValue::Boolean(value),
            style_index: 0,
        }
    }

    /// Returns the display value of the cell as a String.
    /// This is used for pivot tables and other features that need
    /// to show the cell's value as text.
    pub fn display_value(&self) -> String {
        match &self.value {
            CellValue::Empty => String::new(),
            CellValue::Number(n) => {
                // Format without unnecessary decimal places
                if n.fract() == 0.0 && n.abs() < 1e15 {
                    format!("{:.0}", n)
                } else {
                    format!("{}", n)
                }
            }
            CellValue::Text(s) => s.clone(),
            CellValue::Boolean(b) => {
                if *b { "TRUE" } else { "FALSE" }.to_string()
            }
            CellValue::Error(e) => format!("#{:?}", e).to_uppercase(),
        }
    }
}

impl Default for Cell {
    fn default() -> Self {
        Self::new()
    }
}