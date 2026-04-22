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
use crate::style::{Color, UnderlineStyle};

/// Represents valid key types for Dict cells.
/// Follows Python conventions: strings, numbers, and booleans are hashable.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum DictKey {
    Text(String),
    Number(f64),
    Boolean(bool),
}

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
///
/// List and Dict variants use Box<Vec<...>> to keep the enum small (~24 bytes).
/// Normal scalar cells pay zero cost for the existence of these variants —
/// the heap allocation only happens when a List or Dict is actually created.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum CellValue {
    Empty,
    Number(f64),
    Text(String),
    Boolean(bool),
    Error(CellError),
    /// An ordered collection of values (Python-style list).
    /// Created via COLLECT() or curly-brace literal syntax.
    List(Box<Vec<CellValue>>),
    /// A key-value collection (Python-style dict).
    /// Uses Vec to preserve insertion order. Created via DICT() function.
    Dict(Box<Vec<(DictKey, CellValue)>>),
}

/// A single run of text with optional formatting overrides.
/// When a cell has rich_text, the display value is composed of these runs
/// instead of the plain display string. Each run carries its own formatting
/// that overrides the cell's base style for that segment of text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RichTextRun {
    /// The text content of this run.
    pub text: String,
    /// Override: bold (None = inherit from cell style).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    /// Override: italic.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    /// Override: underline style.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub underline: Option<UnderlineStyle>,
    /// Override: strikethrough.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strikethrough: Option<bool>,
    /// Override: font size in points.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_size: Option<u8>,
    /// Override: font family name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    /// Override: text color.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<Color>,
    /// Superscript rendering (reduced size, raised baseline).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub superscript: bool,
    /// Subscript rendering (reduced size, lowered baseline).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub subscript: bool,
}

impl RichTextRun {
    /// Create a plain text run with no formatting overrides.
    pub fn plain(text: String) -> Self {
        RichTextRun {
            text,
            bold: None,
            italic: None,
            underline: None,
            strikethrough: None,
            font_size: None,
            font_family: None,
            color: None,
            superscript: false,
            subscript: false,
        }
    }
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
    /// Rich text runs for partial formatting within the cell.
    /// When present, the cell's display text is composed of these runs
    /// instead of the plain value string. Each run can override
    /// bold, italic, color, font, superscript, subscript, etc.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rich_text: Option<Vec<RichTextRun>>,
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
            rich_text: self.rich_text.clone(),
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
            rich_text: None,
            cached_ast: None,
        }
    }

    pub fn new_number(num: f64) -> Self {
        Cell {
            formula: None,
            value: CellValue::Number(num),
            style_index: 0,
            rich_text: None,
            cached_ast: None,
        }
    }

    pub fn new_text(text: String) -> Self {
        Cell {
            formula: None,
            value: CellValue::Text(text),
            style_index: 0,
            rich_text: None,
            cached_ast: None,
        }
    }

    pub fn new_formula(formula: String) -> Self {
        Cell {
            formula: Some(formula),
            value: CellValue::Empty,
            style_index: 0,
            rich_text: None,
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
            rich_text: None,
            cached_ast: Some(Box::new(ast)),
        }
    }

    pub fn new_boolean(value: bool) -> Self {
        Cell {
            formula: None,
            value: CellValue::Boolean(value),
            style_index: 0,
            rich_text: None,
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
            CellValue::List(items) => format!("[List({})]", items.len()),
            CellValue::Dict(entries) => format!("[Dict({})]", entries.len()),
        }
    }
}

impl Default for Cell {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rich_text_run_plain() {
        let run = RichTextRun::plain("hello".to_string());
        assert_eq!(run.text, "hello");
        assert_eq!(run.bold, None);
        assert_eq!(run.italic, None);
        assert!(!run.superscript);
        assert!(!run.subscript);
    }

    #[test]
    fn test_rich_text_run_serialization_minimal() {
        // A plain run should serialize without optional fields
        let run = RichTextRun::plain("test".to_string());
        let json = serde_json::to_string(&run).unwrap();
        assert!(json.contains("\"text\":\"test\""));
        // Optional None fields should be skipped
        assert!(!json.contains("bold"));
        assert!(!json.contains("italic"));
        assert!(!json.contains("superscript"));
        assert!(!json.contains("subscript"));
    }

    #[test]
    fn test_rich_text_run_serialization_with_overrides() {
        let run = RichTextRun {
            text: "bold text".to_string(),
            bold: Some(true),
            italic: Some(false),
            underline: None,
            strikethrough: None,
            font_size: Some(14),
            font_family: None,
            color: Some(Color::new(255, 0, 0)),
            superscript: true,
            subscript: false,
        };
        let json = serde_json::to_string(&run).unwrap();
        assert!(json.contains("\"bold\":true"));
        assert!(json.contains("\"italic\":false"));
        assert!(json.contains("\"fontSize\":14"));
        assert!(json.contains("\"superscript\":true"));
        // subscript is false so should be skipped
        assert!(!json.contains("\"subscript\""));
        // underline is None so should be skipped
        assert!(!json.contains("\"underline\""));
    }

    #[test]
    fn test_rich_text_run_deserialization_camel_case() {
        let json = r#"{"text":"hi","bold":true,"fontSize":12,"superscript":true}"#;
        let run: RichTextRun = serde_json::from_str(json).unwrap();
        assert_eq!(run.text, "hi");
        assert_eq!(run.bold, Some(true));
        assert_eq!(run.font_size, Some(12));
        assert!(run.superscript);
        assert!(!run.subscript); // default
        assert_eq!(run.italic, None); // missing = None
    }

    #[test]
    fn test_rich_text_run_roundtrip() {
        let original = RichTextRun {
            text: "formatted".to_string(),
            bold: Some(true),
            italic: Some(true),
            underline: Some(UnderlineStyle::Single),
            strikethrough: Some(false),
            font_size: Some(18),
            font_family: Some("Arial".to_string()),
            color: Some(Color::new(0, 128, 255)),
            superscript: false,
            subscript: true,
        };
        let json = serde_json::to_string(&original).unwrap();
        let restored: RichTextRun = serde_json::from_str(&json).unwrap();
        assert_eq!(original, restored);
    }

    #[test]
    fn test_cell_with_rich_text() {
        let mut cell = Cell::new_text("Hello World".to_string());
        assert!(cell.rich_text.is_none());

        cell.rich_text = Some(vec![
            RichTextRun {
                text: "Hello ".to_string(),
                bold: Some(true),
                ..RichTextRun::plain(String::new())
            },
            RichTextRun::plain("World".to_string()),
        ]);

        assert_eq!(cell.rich_text.as_ref().unwrap().len(), 2);
        assert_eq!(cell.rich_text.as_ref().unwrap()[0].bold, Some(true));
        assert_eq!(cell.rich_text.as_ref().unwrap()[1].bold, None);
    }

    #[test]
    fn test_cell_clone_preserves_rich_text() {
        let mut cell = Cell::new_text("test".to_string());
        cell.rich_text = Some(vec![RichTextRun {
            text: "test".to_string(),
            superscript: true,
            ..RichTextRun::plain(String::new())
        }]);

        let cloned = cell.clone();
        assert!(cloned.rich_text.is_some());
        assert!(cloned.rich_text.as_ref().unwrap()[0].superscript);
    }

    #[test]
    fn test_cell_rich_text_serialization_roundtrip() {
        let mut cell = Cell::new_text("x2".to_string());
        cell.rich_text = Some(vec![
            RichTextRun::plain("x".to_string()),
            RichTextRun {
                text: "2".to_string(),
                superscript: true,
                ..RichTextRun::plain(String::new())
            },
        ]);

        let json = serde_json::to_string(&cell).unwrap();
        let restored: Cell = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.rich_text.as_ref().unwrap().len(), 2);
        assert!(restored.rich_text.as_ref().unwrap()[1].superscript);
    }

    #[test]
    fn test_cell_without_rich_text_no_field_in_json() {
        let cell = Cell::new_number(42.0);
        let json = serde_json::to_string(&cell).unwrap();
        // rich_text is None, so should not appear in JSON
        assert!(!json.contains("richText"));
    }
}