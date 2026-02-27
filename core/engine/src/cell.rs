//! FILENAME: core/engine/src/cell.rs
//! PURPOSE: Defines the fundamental data structures for a single spreadsheet cell.
//! CONTEXT: This file contains the `Cell` struct and `CellValue` enum.
//! It separates the user's input (formula) from the calculated result (value).
//! It is designed to be lightweight as millions of these instances may exist.
//!
//! PERFORMANCE: Cells with formulas can cache their parsed AST to avoid
//! re-parsing on every recalculation. The cached AST is not serialized.

use serde::{Deserialize, Serialize};
use crate::dependency_extractor::Expression;

/// Represents the possible errors a cell can hold (e.g., #DIV/0!)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum CellError {
    Div0,       // Division by zero
    Ref,        // Invalid reference
    Name,       // Unknown function name
    Value,      // Wrong type of argument
    NA,         // Value not available (#N/A)
    Parse,      // Formula parsing error
    Circular,   // Circular dependency detected
    Conflict,   // Conflicting UI effects (e.g., two formulas setting same row height)
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
///
/// Cells can optionally cache their parsed formula AST to avoid re-parsing
/// on every recalculation. The cache is populated on first evaluation and
/// reused for subsequent evaluations until the formula changes.
#[derive(Debug, Serialize, Deserialize)]
pub struct Cell {
    pub formula: Option<String>,
    pub value: CellValue,
    pub style_index: usize,
    /// Cached parsed AST for formula cells. Not serialized - regenerated on load.
    #[serde(skip)]
    pub cached_ast: Option<Box<Expression>>,
}

impl Clone for Cell {
    fn clone(&self) -> Self {
        Cell {
            formula: self.formula.clone(),
            value: self.value.clone(),
            style_index: self.style_index,
            cached_ast: self.cached_ast.clone(),
        }
    }
}

impl Cell {
    pub fn new() -> Self {
        Cell {
            formula: None,
            value: CellValue::Empty,
            style_index: 0,
            cached_ast: None,
        }
    }

    pub fn new_number(num: f64) -> Self {
        Cell {
            formula: None,
            value: CellValue::Number(num),
            style_index: 0,
            cached_ast: None,
        }
    }

    pub fn new_text(text: String) -> Self {
        Cell {
            formula: None,
            value: CellValue::Text(text),
            style_index: 0,
            cached_ast: None,
        }
    }

    pub fn new_formula(formula: String) -> Self {
        Cell {
            formula: Some(formula),
            value: CellValue::Empty,
            style_index: 0,
            cached_ast: None, // Will be populated on first evaluation
        }
    }

    /// Creates a new formula cell with a pre-parsed AST.
    /// This is more efficient when the AST is already available.
    pub fn new_formula_with_ast(formula: String, ast: Expression) -> Self {
        Cell {
            formula: Some(formula),
            value: CellValue::Empty,
            style_index: 0,
            cached_ast: Some(Box::new(ast)),
        }
    }

    pub fn new_boolean(value: bool) -> Self {
        Cell {
            formula: None,
            value: CellValue::Boolean(value),
            style_index: 0,
            cached_ast: None,
        }
    }

    /// Sets the cached AST for this cell.
    /// Call this after parsing a formula to cache the AST for reuse.
    pub fn set_cached_ast(&mut self, ast: Expression) {
        self.cached_ast = Some(Box::new(ast));
    }

    /// Clears the cached AST. Call this when the formula changes.
    pub fn clear_cached_ast(&mut self) {
        self.cached_ast = None;
    }

    /// Returns a reference to the cached AST if available.
    pub fn get_cached_ast(&self) -> Option<&Expression> {
        self.cached_ast.as_ref().map(|b| b.as_ref())
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
            CellValue::Error(e) => match e {
                CellError::NA => "#N/A".to_string(),
                CellError::Conflict => "#CONFLICT".to_string(),
                other => format!("#{:?}", other).to_uppercase(),
            },
        }
    }
}

impl Default for Cell {
    fn default() -> Self {
        Self::new()
    }
}