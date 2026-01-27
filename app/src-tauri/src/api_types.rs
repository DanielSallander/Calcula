//! FILENAME: app/src-tauri/src/api_types.rs
// PURPOSE: Shared type definitions for Tauri API communication.
// CONTEXT: All structs use camelCase serialization for JavaScript interoperability.
// UPDATED: Added row_span and col_span for merged cells support.

use serde::{Deserialize, Serialize};

/// Cell data returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellData {
    pub row: u32,
    pub col: u32,
    pub display: String,
    pub formula: Option<String>,
    pub style_index: usize,
    /// Number of rows this cell spans (1 = normal, >1 = merged master cell)
    #[serde(default = "default_span")]
    pub row_span: u32,
    /// Number of columns this cell spans (1 = normal, >1 = merged master cell)
    #[serde(default = "default_span")]
    pub col_span: u32,
}

fn default_span() -> u32 {
    1
}

/// Style data returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleData {
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strikethrough: bool,
    pub font_size: u8,
    pub font_family: String,
    pub text_color: String,
    pub background_color: String,
    pub text_align: String,
    pub vertical_align: String,
    pub number_format: String,
    pub wrap_text: bool,
    pub text_rotation: String,
}

/// Dimension data for column widths and row heights.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DimensionData {
    pub index: u32,
    pub size: f64,
}

/// Formatting parameters for cell styling.
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FormattingParams {
    pub rows: Vec<u32>,
    pub cols: Vec<u32>,
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    pub underline: Option<bool>,
    pub font_size: Option<u8>,
    pub font_family: Option<String>,
    pub text_color: Option<String>,
    pub background_color: Option<String>,
    pub text_align: Option<String>,
    pub vertical_align: Option<String>,
    pub number_format: Option<String>,
    pub wrap_text: Option<bool>,
    pub text_rotation: Option<String>,
}

/// Result from apply_formatting that includes both updated cells and new styles.
/// This allows the frontend to update its style cache in a single round-trip.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormattingResult {
    /// Updated cells with their new style indices
    pub cells: Vec<CellData>,
    /// New or updated styles that the frontend should cache
    /// Key is the style index, value is the style data
    pub styles: Vec<StyleEntry>,
}

/// A style entry with its index for caching purposes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleEntry {
    pub index: usize,
    pub style: StyleData,
}

/// Function definition for the formula library.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionInfo {
    pub name: String,
    pub syntax: String,
    pub description: String,
    pub category: String,
}

/// Result of getting available functions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionListResult {
    pub functions: Vec<FunctionInfo>,
}

/// A merged cell region definition.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct MergedRegion {
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
}

/// Result of merge operations.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub success: bool,
    pub merged_regions: Vec<MergedRegion>,
    pub updated_cells: Vec<CellData>,
}

// ============================================================================
// Conversion helpers: API types <--> Engine types
// ============================================================================

use engine::{CellStyle, TextAlign, VerticalAlign, NumberFormat, TextRotation};

impl From<&CellStyle> for StyleData {
    fn from(style: &CellStyle) -> Self {
        StyleData {
            bold: style.font.bold,
            italic: style.font.italic,
            underline: style.font.underline,
            strikethrough: style.font.strikethrough,
            font_size: style.font.size,
            font_family: style.font.family.clone(),
            text_color: style.font.color.to_css(),
            background_color: style.background.to_css(),
            text_align: match style.text_align {
                TextAlign::General => "general".to_string(),
                TextAlign::Left => "left".to_string(),
                TextAlign::Center => "center".to_string(),
                TextAlign::Right => "right".to_string(),
            },
            vertical_align: match style.vertical_align {
                VerticalAlign::Top => "top".to_string(),
                VerticalAlign::Middle => "middle".to_string(),
                VerticalAlign::Bottom => "bottom".to_string(),
            },
            number_format: format_number_format_name(&style.number_format),
            wrap_text: style.wrap_text,
            text_rotation: match style.text_rotation {
                TextRotation::None => "none".to_string(),
                TextRotation::Rotate90 => "rotate90".to_string(),
                TextRotation::Rotate270 => "rotate270".to_string(),
                TextRotation::Custom(angle) => format!("custom:{}", angle),
            },
        }
    }
}

/// Convert NumberFormat to a display name.
fn format_number_format_name(format: &NumberFormat) -> String {
    match format {
        NumberFormat::General => "General".to_string(),
        NumberFormat::Number {
            decimal_places,
            use_thousands_separator,
        } => {
            if *use_thousands_separator {
                format!("Number ({} decimals, with separators)", decimal_places)
            } else {
                format!("Number ({} decimals)", decimal_places)
            }
        }
        NumberFormat::Currency {
            symbol,
            decimal_places,
            ..
        } => {
            format!("Currency ({}, {} decimals)", symbol, decimal_places)
        }
        NumberFormat::Percentage { decimal_places } => {
            format!("Percentage ({} decimals)", decimal_places)
        }
        NumberFormat::Scientific { decimal_places } => {
            format!("Scientific ({} decimals)", decimal_places)
        }
        NumberFormat::Date { format } => format!("Date ({})", format),
        NumberFormat::Time { format } => format!("Time ({})", format),
        NumberFormat::Custom { format } => format!("Custom ({})", format),
    }
}