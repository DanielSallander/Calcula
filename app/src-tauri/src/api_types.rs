//! FILENAME: app/src-tauri/src/api_types.rs
// PURPOSE: Shared type definitions for Tauri API communication.
// CONTEXT: All structs use camelCase serialization for JavaScript interoperability.
// UPDATED: Added row_span and col_span for merged cells support.

use serde::{Deserialize, Serialize};

/// Underline style for font rendering (Excel-compatible).
/// Mirrors engine::UnderlineStyle with camelCase serialization for TypeScript.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum UnderlineStyle {
    None,
    Single,
    Double,
    SingleAccounting,
    DoubleAccounting,
}

impl Default for UnderlineStyle {
    fn default() -> Self {
        UnderlineStyle::None
    }
}

impl From<engine::UnderlineStyle> for UnderlineStyle {
    fn from(u: engine::UnderlineStyle) -> Self {
        match u {
            engine::UnderlineStyle::None => UnderlineStyle::None,
            engine::UnderlineStyle::Single => UnderlineStyle::Single,
            engine::UnderlineStyle::Double => UnderlineStyle::Double,
            engine::UnderlineStyle::SingleAccounting => UnderlineStyle::SingleAccounting,
            engine::UnderlineStyle::DoubleAccounting => UnderlineStyle::DoubleAccounting,
        }
    }
}

impl From<UnderlineStyle> for engine::UnderlineStyle {
    fn from(u: UnderlineStyle) -> Self {
        match u {
            UnderlineStyle::None => engine::UnderlineStyle::None,
            UnderlineStyle::Single => engine::UnderlineStyle::Single,
            UnderlineStyle::Double => engine::UnderlineStyle::Double,
            UnderlineStyle::SingleAccounting => engine::UnderlineStyle::SingleAccounting,
            UnderlineStyle::DoubleAccounting => engine::UnderlineStyle::DoubleAccounting,
        }
    }
}

impl From<bool> for UnderlineStyle {
    fn from(b: bool) -> Self {
        if b { UnderlineStyle::Single } else { UnderlineStyle::None }
    }
}

impl From<UnderlineStyle> for bool {
    fn from(u: UnderlineStyle) -> Self {
        !matches!(u, UnderlineStyle::None)
    }
}

/// A single run of rich text with formatting overrides.
/// Sent to the frontend for Canvas rendering of partially formatted cell text.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RichTextRunData {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub underline: Option<UnderlineStyle>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strikethrough: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_size: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub superscript: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub subscript: bool,
}

/// Accounting layout data for split rendering in cells.
/// Symbol is drawn left-aligned, value is drawn right-aligned.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountingLayout {
    /// Currency symbol text (e.g., "$", "EUR")
    pub symbol: String,
    /// Whether the symbol appears before the value
    pub symbol_before: bool,
    /// Formatted number part (e.g., "1,234.00", "(1,234.00)", "-")
    pub value: String,
}

/// Which of Excel's overflow rules a cell's VALUE is entitled to.
///
/// `CellData` carries only a formatted `display` string, and that string has
/// already thrown away the two things Excel's overflow rules ask about: the
/// value's TYPE and, for a date, its SIGN. The renderer can infer the type from
/// the format plus the text and is exact for almost every cell, but two cases
/// are not recoverable downstream at all:
///
///   - a NEGATIVE serial under a Date or Time format. Excel refuses it with
///     '####' at EVERY width, because a serial below zero has no representation
///     in the 1900 date system, and Microsoft's remedy is "verify that dates and
///     times are positive values" rather than "widen the column". The engine
///     instead renders `-1.0` as "1900-01-01" and `-0.5` as "12:00:00" -- values
///     a user cannot tell from real ones. By the time the renderer sees
///     "1900-01-01" the negativity is gone (BUG-0066).
///   - TEXT stored in a cell carrying an explicitly numeric format. The
///     inference reads it as numeric if it contains a digit, and would mark a
///     pasted header in a Date column.
///
/// `Text` is the default and the FAIL-SAFE direction: text never shows the
/// marker, so a construction site that gets this wrong degrades to the
/// pre-BUG-0066 behaviour rather than to a wrong '####'.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum OverflowClass {
    /// Spills into absolutely-empty neighbours; clipped mid-glyph otherwise.
    #[default]
    Text,
    /// Cannot spill. Shows '####' when the formatted value does not fit.
    Numeric,
    /// Cannot spill and cannot be shown AT ALL: '####' at every width.
    Unrepresentable,
}

/// The overflow class of a value under a style, decided where BOTH are in hand.
///
/// This is the ONE place the decision is made. It is deliberately not a method
/// on `CellValue` (which has no style) nor on `CellStyle` (which has no value).
pub fn overflow_class_for(
    value: &engine::CellValue,
    style: &engine::CellStyle,
) -> OverflowClass {
    use engine::{CellValue, NumberFormat};
    let is_date_or_time = matches!(
        style.number_format,
        NumberFormat::Date { .. } | NumberFormat::Time { .. }
    );
    match value {
        // Excel's Text format shows the value exactly as typed and does not
        // evaluate it as a number, so digits under `@` still spill like prose.
        CellValue::Number(n) => {
            if is_date_or_time && *n < 0.0 {
                OverflowClass::Unrepresentable
            } else if matches!(&style.number_format, NumberFormat::Custom { format } if format == "@")
            {
                OverflowClass::Text
            } else {
                OverflowClass::Numeric
            }
        }
        // An error literal cannot spill either: Excel marks a too-narrow one
        // exactly as it marks a number.
        CellValue::Error(_) => OverflowClass::Numeric,
        CellValue::Boolean(_) => OverflowClass::Numeric,
        _ => OverflowClass::Text,
    }
}

/// Cell data returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellData {
    pub row: u32,
    pub col: u32,
    pub display: String,
    /// Which of Excel's overflow rules this cell's VALUE is entitled to.
    /// Defaulted to `Text` (the fail-safe direction) and omitted from the wire
    /// when it is the default, so text cells cost nothing extra.
    #[serde(default, skip_serializing_if = "OverflowClass::is_default")]
    pub overflow: OverflowClass,
    /// Optional color override from number format (e.g., [Red] in custom format).
    /// CSS hex color string like "#ff0000". None when no format color applies.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_color: Option<String>,
    pub formula: Option<String>,
    pub style_index: usize,
    /// Number of rows this cell spans (1 = normal, >1 = merged master cell)
    #[serde(default = "default_span")]
    pub row_span: u32,
    /// Number of columns this cell spans (1 = normal, >1 = merged master cell)
    #[serde(default = "default_span")]
    pub col_span: u32,
    /// Sheet index for cross-sheet updates (None = current active sheet)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sheet_index: Option<usize>,
    /// Rich text runs for partial formatting within the cell.
    /// When present, the renderer should draw each run with its own formatting
    /// instead of using the cell's base style for the entire display text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rich_text: Option<Vec<RichTextRunData>>,
    /// Accounting layout for split rendering (symbol left, value right).
    /// When present, the renderer draws symbol at left edge and value at right edge.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accounting_layout: Option<AccountingLayout>,
}

impl OverflowClass {
    /// `skip_serializing_if` hook: the default costs no bytes on the wire.
    pub fn is_default(&self) -> bool {
        matches!(self, OverflowClass::Text)
    }
}

fn default_span() -> u32 {
    1
}

/// A cell read with its VALUE TYPE preserved — the payload of a bulk, typed
/// range read (`get_range_cells_typed`). `CellData` carries only the formatted
/// `display` string, so a consumer cannot tell the number 5 from the text "5",
/// nor an error from a cell literally containing "#DIV/0!". This shape keeps the
/// engine's own typing:
///   - `value` is the JSON-native value: number | string | boolean | null
///     (null = empty; an error cell carries its Excel literal, e.g. "#DIV/0!").
///   - `display` is the same formatted text `CellData.display` carries.
///   - `formula` is the localized formula ("=A1+B1"), withheld exactly where
///     `get_cell` withholds it (protected sheet + hidden-formula style).
///   - `r#type` serializes as "type": number|text|boolean|empty|error.
/// List/Dict cells have no JSON scalar form; they report type "text" with their
/// display text as the value.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypedCellData {
    pub row: u32,
    pub col: u32,
    pub value: serde_json::Value,
    pub display: String,
    pub formula: Option<String>,
    pub r#type: String,
}

/// The result of evaluating ONE formula expression against the live grid
/// (`evaluate_formula_typed`) — the WorksheetFunction bridge's payload.
///
/// Deliberately the same `value` / `display` / `type` triple `TypedCellData`
/// carries, minus the coordinates and the formula (an expression that was never
/// stored has neither), so a script can treat an evaluated result and a read
/// cell with the same code path. An expression that fails to parse comes back
/// as type "error" with the Excel literal "#SYNTAX!" rather than rejecting the
/// whole batch — one bad expression must not lose the other nine answers.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypedEvalResult {
    pub value: serde_json::Value,
    pub display: String,
    pub r#type: String,
}

/// Represents a single item in a collection preview (List or Dict).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "type")]
pub enum CollectionItem {
    /// A scalar value with display text
    #[serde(rename = "scalar")]
    Scalar { display: String },
    /// A nested list
    #[serde(rename = "list")]
    List { count: usize, items: Vec<CollectionItem> },
    /// A nested dict
    #[serde(rename = "dict")]
    Dict { count: usize, entries: Vec<CollectionEntry> },
}

/// A key-value entry in a dict preview.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionEntry {
    pub key: String,
    pub value: CollectionItem,
}

/// Result of get_cell_collection: the structured contents of a List or Dict cell.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionPreviewResult {
    /// "list", "dict", or "none" if the cell is not a collection
    pub cell_type: String,
    /// Root collection item (only present for list/dict cells)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<CollectionItem>,
}

/// Input for batch cell updates.
/// Used by update_cells_batch for efficient bulk operations.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellUpdateInput {
    pub row: u32,
    pub col: u32,
    pub value: String,
    /// Optional style index to apply. When None, preserves existing style.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style_index: Option<usize>,
    /// When true, the value is already in invariant (US) format — skip delocalization.
    /// Used by extensions and tests that send formulas with ',' as argument separator.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invariant: Option<bool>,
}

/// A single border side (top, right, bottom, or left).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BorderSideData {
    pub style: String,
    pub color: String,
    pub width: u8,
}

/// Style data returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleData {
    pub bold: bool,
    pub italic: bool,
    pub underline: UnderlineStyle,
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
    pub border_top: BorderSideData,
    pub border_right: BorderSideData,
    pub border_bottom: BorderSideData,
    pub border_left: BorderSideData,
    pub border_diagonal_down: BorderSideData,
    pub border_diagonal_up: BorderSideData,
    pub checkbox: bool,
    pub button: bool,
    pub indent: u8,
    pub shrink_to_fit: bool,
    /// Theme slot for text color (e.g. "accent1"), None if absolute color.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_color_theme: Option<String>,
    /// Theme tint for text color (permille), None if absolute color.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_color_tint: Option<i16>,
    /// Theme slot for background color, None if absolute color.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bg_color_theme: Option<String>,
    /// Theme tint for background color, None if absolute color.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bg_color_tint: Option<i16>,
    /// Theme font keyword ("body" or "headings"), None if absolute font.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_family_theme: Option<String>,
    /// Fill data (solid/gradient/pattern). None means legacy solid bg only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill: Option<FillData>,
    /// Whether the cell is locked (cannot be edited when sheet is protected).
    /// Default: true (Excel behavior).
    pub locked: bool,
    /// Whether the formula is hidden when the sheet is protected.
    /// Default: false.
    pub formula_hidden: bool,
}

// ============================================================================
// Fill API Types
// ============================================================================

/// Fill data sent to the frontend.
/// Represents solid, gradient, or pattern fills.
/// NOTE: For internally-tagged enums, rename_all on the enum only renames
/// variant tags. Each variant needs its own rename_all for field names.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum FillData {
    /// No fill (default white background)
    #[serde(rename = "none")]
    None,
    /// Solid color fill
    #[serde(rename = "solid", rename_all = "camelCase")]
    Solid {
        color: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        color_theme: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        color_tint: Option<i16>,
    },
    /// Pattern fill
    #[serde(rename = "pattern", rename_all = "camelCase")]
    Pattern {
        pattern_type: String,
        fg_color: String,
        bg_color: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        fg_color_theme: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        fg_color_tint: Option<i16>,
        #[serde(skip_serializing_if = "Option::is_none")]
        bg_color_theme: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        bg_color_tint: Option<i16>,
    },
    /// Two-color gradient fill
    #[serde(rename = "gradient", rename_all = "camelCase")]
    Gradient {
        color1: String,
        color2: String,
        direction: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        color1_theme: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        color1_tint: Option<i16>,
        #[serde(skip_serializing_if = "Option::is_none")]
        color2_theme: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        color2_tint: Option<i16>,
    },
}

/// Fill parameters for formatting commands (from frontend).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type")]
pub enum FillParam {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "solid", rename_all = "camelCase")]
    Solid {
        color: String,
        #[serde(default)]
        color_theme: Option<String>,
        #[serde(default)]
        color_tint: Option<i16>,
    },
    #[serde(rename = "pattern", rename_all = "camelCase")]
    Pattern {
        pattern_type: String,
        fg_color: String,
        bg_color: String,
        #[serde(default)]
        fg_color_theme: Option<String>,
        #[serde(default)]
        fg_color_tint: Option<i16>,
        #[serde(default)]
        bg_color_theme: Option<String>,
        #[serde(default)]
        bg_color_tint: Option<i16>,
    },
    #[serde(rename = "gradient", rename_all = "camelCase")]
    Gradient {
        color1: String,
        color2: String,
        direction: String,
        #[serde(default)]
        color1_theme: Option<String>,
        #[serde(default)]
        color1_tint: Option<i16>,
        #[serde(default)]
        color2_theme: Option<String>,
        #[serde(default)]
        color2_tint: Option<i16>,
    },
}

// ============================================================================
// Theme API Types
// ============================================================================

/// Theme definition data sent to/from the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeDefinitionData {
    pub name: String,
    pub colors: ThemeColorsData,
    pub fonts: ThemeFontsData,
}

/// The 12 base theme colors as CSS hex strings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeColorsData {
    pub dark1: String,
    pub light1: String,
    pub dark2: String,
    pub light2: String,
    pub accent1: String,
    pub accent2: String,
    pub accent3: String,
    pub accent4: String,
    pub accent5: String,
    pub accent6: String,
    pub hyperlink: String,
    pub followed_hyperlink: String,
}

/// Theme font pair.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeFontsData {
    pub heading: String,
    pub body: String,
}

/// A single entry in the theme color palette (for the color picker).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeColorInfo {
    pub slot: String,
    pub tint: i16,
    pub resolved_color: String,
    pub label: String,
}

/// Result from set_document_theme: includes refreshed style list.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetThemeResult {
    pub styles: Vec<StyleEntry>,
}

impl ThemeDefinitionData {
    pub fn from_theme(theme: &engine::ThemeDefinition) -> Self {
        ThemeDefinitionData {
            name: theme.name.clone(),
            colors: ThemeColorsData {
                dark1: theme.colors.dark1.to_css(),
                light1: theme.colors.light1.to_css(),
                dark2: theme.colors.dark2.to_css(),
                light2: theme.colors.light2.to_css(),
                accent1: theme.colors.accent1.to_css(),
                accent2: theme.colors.accent2.to_css(),
                accent3: theme.colors.accent3.to_css(),
                accent4: theme.colors.accent4.to_css(),
                accent5: theme.colors.accent5.to_css(),
                accent6: theme.colors.accent6.to_css(),
                hyperlink: theme.colors.hyperlink.to_css(),
                followed_hyperlink: theme.colors.followed_hyperlink.to_css(),
            },
            fonts: ThemeFontsData {
                heading: theme.fonts.heading.clone(),
                body: theme.fonts.body.clone(),
            },
        }
    }

    pub fn to_theme(&self) -> engine::ThemeDefinition {
        use engine::{Color, ThemeColors, ThemeFonts};
        let parse = |s: &str| Color::from_hex(s).unwrap_or(Color::black());
        engine::ThemeDefinition {
            name: self.name.clone(),
            colors: ThemeColors {
                dark1: parse(&self.colors.dark1),
                light1: parse(&self.colors.light1),
                dark2: parse(&self.colors.dark2),
                light2: parse(&self.colors.light2),
                accent1: parse(&self.colors.accent1),
                accent2: parse(&self.colors.accent2),
                accent3: parse(&self.colors.accent3),
                accent4: parse(&self.colors.accent4),
                accent5: parse(&self.colors.accent5),
                accent6: parse(&self.colors.accent6),
                hyperlink: parse(&self.colors.hyperlink),
                followed_hyperlink: parse(&self.colors.followed_hyperlink),
            },
            fonts: ThemeFonts {
                heading: self.fonts.heading.clone(),
                body: self.fonts.body.clone(),
            },
        }
    }
}

/// Dimension data for column widths and row heights.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DimensionData {
    pub index: u32,
    pub size: f64,
    /// "row" or "column" — identifies the dimension type for the frontend.
    pub dimension_type: String,
}

/// A single border side for formatting parameters.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BorderSideParam {
    pub style: String,
    pub color: String,
}

/// Formatting parameters for cell styling.
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FormattingParams {
    pub rows: Vec<u32>,
    pub cols: Vec<u32>,
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    pub underline: Option<UnderlineStyle>,
    pub strikethrough: Option<bool>,
    pub font_size: Option<u8>,
    pub font_family: Option<String>,
    pub text_color: Option<String>,
    pub background_color: Option<String>,
    pub text_align: Option<String>,
    pub vertical_align: Option<String>,
    pub number_format: Option<String>,
    pub wrap_text: Option<bool>,
    pub text_rotation: Option<String>,
    pub border_top: Option<BorderSideParam>,
    pub border_right: Option<BorderSideParam>,
    pub border_bottom: Option<BorderSideParam>,
    pub border_left: Option<BorderSideParam>,
    pub border_diagonal_down: Option<BorderSideParam>,
    pub border_diagonal_up: Option<BorderSideParam>,
    pub checkbox: Option<bool>,
    pub button: Option<bool>,
    pub indent: Option<u8>,
    pub shrink_to_fit: Option<bool>,
    /// Theme slot for text color (overrides text_color when set)
    pub text_color_theme: Option<String>,
    pub text_color_tint: Option<i16>,
    /// Theme slot for background color (overrides background_color when set)
    pub bg_color_theme: Option<String>,
    pub bg_color_tint: Option<i16>,
    /// Fill data (solid/gradient/pattern). When set, overrides background_color.
    pub fill: Option<FillParam>,
    /// Whether the cell is locked when sheet is protected.
    pub locked: Option<bool>,
    /// Whether the formula is hidden when sheet is protected.
    pub formula_hidden: Option<bool>,
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

/// Result from update_cell that includes both updated cells and optional dimension changes.
/// Dimension changes are only present when UI formulas (like SET.ROW.HEIGHT) are evaluated.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCellResult {
    pub cells: Vec<CellData>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dimension_changes: Vec<DimensionData>,
    /// When true, the frontend should refresh its style cache (e.g., after SET.CELL.FILLCOLOR).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub needs_style_refresh: bool,
    /// When true, slicer computed properties changed a slicer — frontend should refresh slicer overlays.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub slicer_changed: bool,
}

/// Spill range information for visual rendering.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpillRangeInfo {
    pub origin_row: u32,
    pub origin_col: u32,
    pub end_row: u32,
    pub end_col: u32,
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
// Clear Range Options (Excel-compatible)
// ============================================================================

/// Specifies what to clear from a range.
/// Matches Excel's ClearApplyTo enum.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ClearApplyTo {
    /// Clear all contents and formatting (default behavior)
    All,
    /// Clear only cell values, leaving formatting intact
    Contents,
    /// Clear only formatting, leaving values intact
    Formats,
    /// Clear hyperlinks only (placeholder - not yet implemented)
    Hyperlinks,
    /// Remove hyperlinks and formatting but keep content
    RemoveHyperlinks,
    /// Reset cells to their default state
    ResetContents,
}

impl Default for ClearApplyTo {
    fn default() -> Self {
        ClearApplyTo::All
    }
}

/// Parameters for clear_range_with_options command.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearRangeParams {
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
    #[serde(default)]
    pub apply_to: ClearApplyTo,
    /// Target sheet (0-based). None = the active sheet (Wave 3 cross-sheet ops).
    #[serde(default)]
    pub sheet_index: Option<usize>,
}

/// Result of clear_range_with_options command.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearRangeResult {
    /// Number of cells affected
    pub count: u32,
    /// Updated cells (with new display values if only formatting was cleared)
    pub updated_cells: Vec<CellData>,
}

// ============================================================================
// Sort Range (Excel-compatible)
// ============================================================================

/// Specifies what to sort on.
/// Matches Excel's SortOn enum.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SortOn {
    /// Sort by cell value (default)
    Value,
    /// Sort by cell background color
    CellColor,
    /// Sort by font color
    FontColor,
    /// Sort by cell icon (conditional formatting)
    Icon,
}

impl Default for SortOn {
    fn default() -> Self {
        SortOn::Value
    }
}

/// Additional sort data options.
/// Matches Excel's SortDataOption enum.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SortDataOption {
    /// Normal sorting (default)
    Normal,
    /// Treat text as numbers when sorting
    TextAsNumber,
}

impl Default for SortDataOption {
    fn default() -> Self {
        SortDataOption::Normal
    }
}

/// Sort orientation (by rows or columns).
/// Matches Excel's SortOrientation enum.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SortOrientation {
    /// Sort by rows (sort data vertically - typical case)
    Rows,
    /// Sort by columns (sort data horizontally)
    Columns,
}

impl Default for SortOrientation {
    fn default() -> Self {
        SortOrientation::Rows
    }
}

/// A single sort field/condition.
/// Matches Excel's SortField interface.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortField {
    /// Column (or row) offset from the first column (or row) being sorted (0-based).
    /// Required field.
    pub key: u32,
    /// Sort direction: true for ascending (A-Z, 0-9), false for descending.
    #[serde(default = "default_ascending")]
    pub ascending: bool,
    /// What to sort on (value, cell color, font color, or icon).
    #[serde(default)]
    pub sort_on: SortOn,
    /// The color to sort by when sort_on is CellColor or FontColor (CSS color string).
    pub color: Option<String>,
    /// Additional data options (e.g., treat text as numbers).
    #[serde(default)]
    pub data_option: SortDataOption,
    /// For sorting rich values - the subfield/property name to sort on.
    pub sub_field: Option<String>,
    /// Custom sort order: a built-in list name ("weekdays", "weekdaysShort", "months",
    /// "monthsShort") or a comma-separated list of values for custom ordering.
    pub custom_order: Option<String>,
}

fn default_ascending() -> bool {
    true
}

/// Parameters for sort_range command.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortRangeParams {
    /// Start row of range to sort (0-based)
    pub start_row: u32,
    /// Start column of range to sort (0-based)
    pub start_col: u32,
    /// End row of range to sort (0-based, inclusive)
    pub end_row: u32,
    /// End column of range to sort (0-based, inclusive)
    pub end_col: u32,
    /// Sort fields (criteria) - at least one required
    pub fields: Vec<SortField>,
    /// Whether sorting is case-sensitive
    #[serde(default)]
    pub match_case: bool,
    /// Whether the range has a header row/column that should not be sorted
    #[serde(default)]
    pub has_headers: bool,
    /// Sort orientation (rows or columns)
    #[serde(default)]
    pub orientation: SortOrientation,
    /// Target sheet (0-based). None = the active sheet (Wave 3 cross-sheet ops).
    #[serde(default)]
    pub sheet_index: Option<usize>,
}

/// Result of sort_range command.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SortRangeResult {
    /// Whether the sort was successful
    pub success: bool,
    /// Number of rows (or columns) sorted
    pub sorted_count: u32,
    /// Updated cells after sorting
    pub updated_cells: Vec<CellData>,
    /// Error message if sort failed
    pub error: Option<String>,
}

// ============================================================================
// Conversion helpers: API types <--> Engine types
// ============================================================================

use engine::{BorderLineStyle, CellStyle, NumberFormat, RichTextRun, TextAlign, TextRotation, VerticalAlign};

/// Convert engine RichTextRun to API RichTextRunData.
pub fn rich_text_runs_to_data(runs: &[RichTextRun]) -> Vec<RichTextRunData> {
    runs.iter()
        .map(|run| RichTextRunData {
            text: run.text.clone(),
            bold: run.bold,
            italic: run.italic,
            underline: run.underline.map(|u| u.into()),
            strikethrough: run.strikethrough,
            font_size: run.font_size,
            font_family: run.font_family.clone(),
            color: run.color.map(|c| c.to_css()),
            superscript: run.superscript,
            subscript: run.subscript,
        })
        .collect()
}

/// Convert API RichTextRunData back to engine RichTextRun.
pub fn data_to_rich_text_runs(data: &[RichTextRunData]) -> Vec<RichTextRun> {
    data.iter()
        .map(|d| RichTextRun {
            text: d.text.clone(),
            bold: d.bold,
            italic: d.italic,
            underline: d.underline.map(|u| u.into()),
            strikethrough: d.strikethrough,
            font_size: d.font_size,
            font_family: d.font_family.clone(),
            color: d.color.as_ref().and_then(|c| engine::Color::from_hex(c)),
            superscript: d.superscript,
            subscript: d.subscript,
        })
        .collect()
}

fn border_side_to_data(side: &engine::BorderStyle, theme: &engine::ThemeDefinition) -> BorderSideData {
    let style_str = if side.style == BorderLineStyle::None || side.width == 0 {
        "none".to_string()
    } else {
        match side.style {
            BorderLineStyle::None => "none".to_string(),
            BorderLineStyle::Solid => match side.width {
                0 => "none".to_string(),
                1 => "thin".to_string(),
                2 => "medium".to_string(),
                _ => "thick".to_string(),
            },
            BorderLineStyle::Dashed => "dashed".to_string(),
            BorderLineStyle::Dotted => "dotted".to_string(),
            BorderLineStyle::Double => "double".to_string(),
        }
    };
    BorderSideData {
        style: style_str,
        color: theme.resolve_color(&side.color).to_css(),
        width: side.width,
    }
}

impl StyleData {
    /// Convert a CellStyle to StyleData, resolving theme colors and fonts.
    pub fn from_cell_style(style: &CellStyle, theme: &engine::ThemeDefinition) -> Self {
        use engine::ThemeColor;

        let (text_color, text_color_theme, text_color_tint) = match &style.font.color {
            ThemeColor::Absolute(_) => (theme.resolve_color(&style.font.color).to_css(), None, None),
            ThemeColor::Theme { slot, tint } => (
                theme.resolve_color(&style.font.color).to_css(),
                Some(slot.key().to_string()),
                Some(tint.0),
            ),
        };
        // Derive backgroundColor from fill for legacy frontend compatibility
        let bg_color = style.fill.background_color();
        let (background_color, bg_color_theme, bg_color_tint) = resolve_theme_color(bg_color, theme);

        let font_family_theme = match style.font.family.as_str() {
            "Body" | "body" => Some("body".to_string()),
            "Headings" | "headings" => Some("headings".to_string()),
            _ => None,
        };
        let font_family = theme.resolve_font(&style.font.family).to_string();

        StyleData {
            bold: style.font.bold,
            italic: style.font.italic,
            underline: UnderlineStyle::from(style.font.underline),
            strikethrough: style.font.strikethrough,
            font_size: style.font.size,
            font_family,
            text_color,
            background_color,
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
            border_top: border_side_to_data(&style.borders.top, theme),
            border_right: border_side_to_data(&style.borders.right, theme),
            border_bottom: border_side_to_data(&style.borders.bottom, theme),
            border_left: border_side_to_data(&style.borders.left, theme),
            border_diagonal_down: border_side_to_data(&style.borders.diagonal_down, theme),
            border_diagonal_up: border_side_to_data(&style.borders.diagonal_up, theme),
            checkbox: style.checkbox,
            button: style.button,
            indent: style.indent,
            shrink_to_fit: style.shrink_to_fit,
            text_color_theme,
            text_color_tint,
            bg_color_theme,
            bg_color_tint,
            font_family_theme,
            fill: fill_to_data(&style.fill, theme),
            locked: style.locked,
            formula_hidden: style.formula_hidden,
        }
    }
}

/// Convert a Fill to FillData, resolving theme colors.
fn fill_to_data(fill: &engine::Fill, theme: &engine::ThemeDefinition) -> Option<FillData> {
    use engine::Fill;

    match fill {
        Fill::None => None,
        Fill::Solid { color } => {
            let (resolved, color_theme, color_tint) = resolve_theme_color(color, theme);
            Some(FillData::Solid {
                color: resolved,
                color_theme,
                color_tint,
            })
        }
        Fill::Pattern { pattern_type, fg_color, bg_color } => {
            let (fg_resolved, fg_theme, fg_tint) = resolve_theme_color(fg_color, theme);
            let (bg_resolved, bg_theme, bg_tint) = resolve_theme_color(bg_color, theme);
            Some(FillData::Pattern {
                pattern_type: pattern_type_to_string(pattern_type),
                fg_color: fg_resolved,
                bg_color: bg_resolved,
                fg_color_theme: fg_theme,
                fg_color_tint: fg_tint,
                bg_color_theme: bg_theme,
                bg_color_tint: bg_tint,
            })
        }
        Fill::Gradient { color1, color2, direction } => {
            let (c1_resolved, c1_theme, c1_tint) = resolve_theme_color(color1, theme);
            let (c2_resolved, c2_theme, c2_tint) = resolve_theme_color(color2, theme);
            Some(FillData::Gradient {
                color1: c1_resolved,
                color2: c2_resolved,
                direction: gradient_direction_to_string(direction),
                color1_theme: c1_theme,
                color1_tint: c1_tint,
                color2_theme: c2_theme,
                color2_tint: c2_tint,
            })
        }
    }
}

/// Resolve a ThemeColor to (css_string, optional_theme_slot, optional_tint).
fn resolve_theme_color(
    color: &engine::ThemeColor,
    theme: &engine::ThemeDefinition,
) -> (String, Option<String>, Option<i16>) {
    use engine::ThemeColor;
    match color {
        ThemeColor::Absolute(_) => (theme.resolve_color(color).to_css(), None, None),
        ThemeColor::Theme { slot, tint } => (
            theme.resolve_color(color).to_css(),
            Some(slot.key().to_string()),
            Some(tint.0),
        ),
    }
}

fn pattern_type_to_string(pt: &engine::PatternType) -> String {
    use engine::PatternType;
    match pt {
        PatternType::None => "none",
        PatternType::Solid => "solid",
        PatternType::DarkGray => "darkGray",
        PatternType::MediumGray => "mediumGray",
        PatternType::LightGray => "lightGray",
        PatternType::Gray125 => "gray125",
        PatternType::Gray0625 => "gray0625",
        PatternType::DarkHorizontal => "darkHorizontal",
        PatternType::DarkVertical => "darkVertical",
        PatternType::DarkDown => "darkDown",
        PatternType::DarkUp => "darkUp",
        PatternType::DarkGrid => "darkGrid",
        PatternType::DarkTrellis => "darkTrellis",
        PatternType::LightHorizontal => "lightHorizontal",
        PatternType::LightVertical => "lightVertical",
        PatternType::LightDown => "lightDown",
        PatternType::LightUp => "lightUp",
        PatternType::LightGrid => "lightGrid",
        PatternType::LightTrellis => "lightTrellis",
    }
    .to_string()
}

fn gradient_direction_to_string(dir: &engine::GradientDirection) -> String {
    use engine::GradientDirection;
    match dir {
        GradientDirection::Horizontal => "horizontal",
        GradientDirection::Vertical => "vertical",
        GradientDirection::DiagonalDown => "diagonalDown",
        GradientDirection::DiagonalUp => "diagonalUp",
        GradientDirection::FromCenter => "fromCenter",
    }
    .to_string()
}

// ============================================================================
// Batch Formula Shift (for fill operations)
// ============================================================================

/// Input for batch formula shifting.
/// Used by shift_formulas_batch for efficient fill operations.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormulaShiftInput {
    /// The formula to shift (including the "=" prefix)
    pub formula: String,
    /// Row delta to shift (positive = down, negative = up)
    pub row_delta: i32,
    /// Column delta to shift (positive = right, negative = left)
    pub col_delta: i32,
}

/// Result of batch formula shifting.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormulaShiftResult {
    /// The shifted formulas in the same order as the input
    pub formulas: Vec<String>,
}

/// Convert NumberFormat to a display name.
///
/// BUG-0065: everything this emits MUST be readable by
/// `commands::styles::try_parse_display_name` (its inverse) -- get_style hands
/// these names to the frontend and the Format Cells dialog sends them straight
/// back through parse_number_format on OK. A shape added here without its
/// inverse there silently corrupts the cell's format on an untouched OK.
/// Pinned by `every_display_name_the_serializer_emits_round_trips` in
/// commands/styles.rs.
/// The clause a Currency/Accounting display name carries when the symbol sits
/// AFTER the number. Empty for `Before`, which is the overwhelmingly common
/// shape and the one every pre-existing name was written for.
///
/// WHY IT IS NOW SPELLED OUT. `try_parse_display_name` used to reconstruct the
/// position from the symbol text — `symbol.trim() == "kr"` meant After and
/// everything else meant Before — and its own doc comment justified that by
/// noting `kr` was the only suffix currency the app could emit. Reading the
/// user's Windows regional settings (open-items 1.3) breaks that premise the
/// first time somebody's `LOCALE_SCURRENCY` is `zł`, `Ft` or `Kč` with
/// `LOCALE_ICURRENCY = 3`: the name round-tripped back as a PREFIX currency and
/// the symbol jumped to the wrong side of the number on an untouched OK.
fn symbol_position_suffix(position: engine::CurrencyPosition) -> &'static str {
    match position {
        engine::CurrencyPosition::Before => "",
        engine::CurrencyPosition::After => ", symbol after",
    }
}

pub(crate) fn format_number_format_name(format: &NumberFormat) -> String {
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
            symbol_position,
            negative_style,
        } => {
            // Both optional clauses are EMPTY for the common shape, so an
            // ordinary `$` currency keeps the name it has always had and only a
            // deliberate choice widens it. `try_parse_display_name` is the
            // inverse and the round trip is pinned by
            // `every_display_name_the_serializer_emits_round_trips`.
            format!(
                "Currency ({}, {} decimals{}{})",
                symbol,
                decimal_places,
                symbol_position_suffix(*symbol_position),
                negative_style.display_suffix()
            )
        }
        NumberFormat::Accounting {
            symbol,
            decimal_places,
            symbol_position,
        } => {
            format!(
                "Accounting ({}, {} decimals{})",
                symbol,
                decimal_places,
                symbol_position_suffix(*symbol_position)
            )
        }
        NumberFormat::Fraction {
            denominator,
            max_digits,
        } => {
            match denominator {
                Some(d) => format!("Fraction (/{} fixed)", d),
                None => format!("Fraction (up to {} digits)", max_digits),
            }
        }
        NumberFormat::Percentage { decimal_places } => {
            format!("Percentage ({} decimals)", decimal_places)
        }
        NumberFormat::Scientific { decimal_places } => {
            format!("Scientific ({} decimals)", decimal_places)
        }
        NumberFormat::Date { format } => format!("Date ({})", format),
        NumberFormat::Time { format } => format!("Time ({})", format),
        NumberFormat::Custom { format } => format.clone(),
    }
}

// ============================================================================
// Remove Duplicates (Excel-compatible)
// ============================================================================

/// Parameters for remove_duplicates command.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveDuplicatesParams {
    /// Start row of range (0-based)
    pub start_row: u32,
    /// Start column of range (0-based)
    pub start_col: u32,
    /// End row of range (0-based, inclusive)
    pub end_row: u32,
    /// End column of range (0-based, inclusive)
    pub end_col: u32,
    /// Absolute column indices to use as duplicate keys
    pub key_columns: Vec<u32>,
    /// Whether the first row is a header (excluded from evaluation)
    pub has_headers: bool,
}

/// Result of remove_duplicates command.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveDuplicatesResult {
    /// Whether the operation was successful
    pub success: bool,
    /// Number of duplicate rows removed
    pub duplicates_removed: u32,
    /// Number of unique rows remaining
    pub unique_remaining: u32,
    /// Updated cells after removal
    pub updated_cells: Vec<CellData>,
    /// Error message if operation failed
    pub error: Option<String>,
}

// ============================================================================
// Goal Seek (single-variable solver)
// ============================================================================

fn default_max_iterations() -> u32 {
    100
}

fn default_tolerance() -> f64 {
    0.001
}

/// Parameters for goal_seek command.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalSeekParams {
    /// Row of the target cell (must contain a formula), 0-based
    pub target_row: u32,
    /// Column of the target cell, 0-based
    pub target_col: u32,
    /// The numeric value we want the target cell to evaluate to
    pub target_value: f64,
    /// Row of the variable cell (must be a constant), 0-based
    pub variable_row: u32,
    /// Column of the variable cell, 0-based
    pub variable_col: u32,
    /// Maximum number of iterations (default: 100)
    #[serde(default = "default_max_iterations")]
    pub max_iterations: u32,
    /// Convergence tolerance (default: 0.001)
    #[serde(default = "default_tolerance")]
    pub tolerance: f64,
}

/// Result of goal_seek command.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalSeekResult {
    /// Whether a solution was found within tolerance
    pub found_solution: bool,
    /// The final value placed in the variable cell
    pub variable_value: f64,
    /// The final evaluated value of the target cell
    pub target_result: f64,
    /// Number of iterations performed
    pub iterations: u32,
    /// The original value of the variable cell (for reverting)
    pub original_variable_value: f64,
    /// Updated cells (the variable cell + target cell + any dependents)
    pub updated_cells: Vec<CellData>,
    /// Error message if goal seek failed validation
    pub error: Option<String>,
}

// ============================================================================
// Data Consolidation
// ============================================================================

/// Aggregation function for data consolidation.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConsolidationFunction {
    Sum,
    Count,
    Average,
    Max,
    Min,
    Product,
    CountNums,
    StdDev,
    StdDevP,
    Var,
    VarP,
}

/// A single source range reference for consolidation.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsolidationSourceRange {
    /// Sheet index (0-based)
    pub sheet_index: usize,
    /// Start row (0-based)
    pub start_row: u32,
    /// Start column (0-based)
    pub start_col: u32,
    /// End row (0-based, inclusive)
    pub end_row: u32,
    /// End column (0-based, inclusive)
    pub end_col: u32,
}

/// Parameters for the consolidate_data command.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsolidateParams {
    /// Aggregation function to apply
    pub function: ConsolidationFunction,
    /// Source ranges to consolidate
    pub source_ranges: Vec<ConsolidationSourceRange>,
    /// Destination sheet index (0-based)
    pub dest_sheet_index: usize,
    /// Destination start row (0-based)
    pub dest_row: u32,
    /// Destination start column (0-based)
    pub dest_col: u32,
    /// Use top row as column headers for category matching
    pub use_top_row: bool,
    /// Use left column as row headers for category matching
    pub use_left_column: bool,
}

/// Result of the consolidate_data command.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsolidateResult {
    /// Whether the operation was successful
    pub success: bool,
    /// Number of output rows written
    pub rows_written: u32,
    /// Number of output columns written
    pub cols_written: u32,
    /// Updated cells in the destination range
    pub updated_cells: Vec<CellData>,
    /// Error message if operation failed
    pub error: Option<String>,
}

// ============================================================================
// Trace Precedents / Trace Dependents
// ============================================================================

/// A single cell reference in a trace result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceCellRef {
    pub row: u32,
    pub col: u32,
    /// Whether this cell currently displays an error value
    pub is_error: bool,
    /// The display value (for UI tooltips)
    pub display: String,
}

/// A contiguous range that feeds into a formula (or is fed by a cell).
/// When multiple individual cells form a contiguous rectangle, they are
/// grouped into a single TraceRange for visual compactness.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceRange {
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
    /// Whether ANY cell in this range has an error value
    pub has_error: bool,
}

/// A cross-sheet reference in a trace result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceCrossSheetRef {
    pub sheet_name: String,
    pub sheet_index: usize,
    pub row: u32,
    pub col: u32,
    /// Whether this cell has an error
    pub is_error: bool,
}

/// Result of tracing precedents or dependents for a single cell.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceResult {
    /// The cell being traced
    pub source_row: u32,
    pub source_col: u32,
    /// Same-sheet individual cell references (ungrouped singletons)
    pub cells: Vec<TraceCellRef>,
    /// Same-sheet range references (grouped contiguous regions)
    pub ranges: Vec<TraceRange>,
    /// Cross-sheet references
    pub cross_sheet_refs: Vec<TraceCrossSheetRef>,
    /// Whether the source cell itself is in error
    pub source_is_error: bool,
}

// ============================================================================
// Evaluate Formula (step-by-step formula debugger)
// ============================================================================

/// State returned for each step of the Evaluate Formula debugger session.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalStepState {
    /// Unique session identifier
    pub session_id: String,
    /// Current formula display text (with partial evaluations inlined)
    pub formula_display: String,
    /// Character position where the underline starts (0-based)
    pub underline_start: usize,
    /// Character position where the underline ends (exclusive)
    pub underline_end: usize,
    /// Can click [Evaluate] button
    pub can_evaluate: bool,
    /// Can click [Step In] (current node is a cell ref with a formula)
    pub can_step_in: bool,
    /// Can click [Step Out] (currently inside a stepped-in frame)
    pub can_step_out: bool,
    /// Evaluation has completed (AST reduced to a single value)
    pub is_complete: bool,
    /// Which cell we're evaluating (e.g., "$A$1")
    pub cell_reference: String,
    /// If step-in is available, which cell it would enter
    pub step_in_target: Option<String>,
    /// Final result when evaluation is complete
    pub evaluation_result: Option<String>,
    /// Error message if something went wrong
    pub error: Option<String>,
}

// ============================================================================
// Formula Evaluation Plan (visual formula debugger)
// ============================================================================

/// One node in the formula expression tree for the visual debugger.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalPlanNode {
    /// Unique node identifier (e.g., "n0", "n1")
    pub id: String,
    /// Node kind: "function", "operator", "literal", "cell_ref", "range", "unary"
    pub node_type: String,
    /// Primary display label (function name, operator symbol, cell address, or literal value)
    pub label: String,
    /// Secondary info with values and refs (e.g., "452 (#2) + 452 (E2)")
    pub subtitle: String,
    /// Compact subtitle: refs only, no values (e.g., "#2 + E2")
    pub subtitle_compact: String,
    /// Values only, no refs (e.g., "452 + 452")
    pub subtitle_values_only: String,
    /// Bare subtitle: no values, no refs — just structure (e.g., the original arg summary)
    pub subtitle_bare: String,
    /// Evaluated value as formatted string
    pub value: String,
    /// Raw numeric value if applicable
    pub raw_value: Option<f64>,
    /// Child node IDs (inputs to this operation)
    pub children: Vec<String>,
    /// Start character offset in reconstructed formula text
    pub source_start: usize,
    /// End character offset (exclusive) in reconstructed formula text
    pub source_end: usize,
    /// 0-based evaluation order index
    pub eval_order: usize,
    /// Relative computation cost (0.0 - 100.0)
    pub cost_pct: f64,
    /// Whether this is a leaf node (no children evaluated individually)
    pub is_leaf: bool,
    /// 1-based step number for display (None if node was not individually evaluated)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_number: Option<usize>,
}

/// One step of the formula reduction sequence.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalReductionStep {
    /// Which node was evaluated in this step
    pub node_id: String,
    /// Human-readable description (e.g., "SUM(A1:A5) = 150")
    pub description: String,
    /// Formula text before this step's substitution
    pub formula_before: String,
    /// Formula text after substitution
    pub formula_after: String,
    /// Start offset of the substituted region in formula_after
    pub highlight_start: usize,
    /// End offset of the substituted region in formula_after
    pub highlight_end: usize,
}

/// Complete evaluation plan for a formula, returned to the frontend in one call.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormulaEvalPlan {
    /// The reconstructed formula text (without leading =)
    pub formula: String,
    /// All nodes in the expression tree
    pub nodes: Vec<EvalPlanNode>,
    /// ID of the root node
    pub root_id: String,
    /// Final evaluated result as formatted string
    pub result: String,
    /// Ordered reduction steps
    pub steps: Vec<EvalReductionStep>,
}

// ============================================================================
// Custom Number Format Preview
// ============================================================================

/// Result of previewing a custom number format.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResult {
    /// The formatted display string
    pub display: String,
    /// Optional color from format tokens (CSS hex)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

// ============================================================================
// Status Bar Aggregation
// ============================================================================

/// Result of computing aggregations over a selected range.
/// Numeric aggregations (sum, average, min, max) are None when no numeric cells exist.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionAggregationResult {
    /// Sum of all numeric values
    pub sum: Option<f64>,
    /// Average of all numeric values
    pub average: Option<f64>,
    /// Minimum numeric value
    pub min: Option<f64>,
    /// Maximum numeric value
    pub max: Option<f64>,
    /// Count of all non-empty cells
    pub count: u32,
    /// Count of numeric cells only
    pub numerical_count: u32,
}

// ============================================================================
// Computed Properties types
// ============================================================================

/// A single computed property as returned to / received from the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputedPropertyData {
    pub id: u64,
    pub attribute: String,
    pub formula: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_value: Option<String>,
}

/// Result from add/update/remove computed property operations.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputedPropertyResult {
    pub success: bool,
    pub properties: Vec<ComputedPropertyData>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dimension_changes: Vec<DimensionData>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub needs_style_refresh: bool,
}

// ============================================================================
// Slicer Computed Properties types
// ============================================================================

/// A single slicer computed property as returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlicerComputedPropertyData {
    pub id: identity::EntityId,
    pub slicer_id: identity::EntityId,
    pub attribute: String,
    pub formula: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_value: Option<String>,
}

/// Result from slicer computed property operations.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlicerComputedPropertyResult {
    pub success: bool,
    pub properties: Vec<SlicerComputedPropertyData>,
    /// Whether the slicer was modified and needs redraw
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub slicer_changed: bool,
}

// ============================================================================
// Page Setup / Print Settings
// ============================================================================

/// Page setup configuration for printing, stored per sheet.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSetup {
    /// Paper size: "letter", "a4", "a3", "legal", "tabloid"
    #[serde(default = "default_paper_size")]
    pub paper_size: String,
    /// Page orientation: "portrait" or "landscape"
    #[serde(default = "default_orientation")]
    pub orientation: String,
    /// Margins in inches
    #[serde(default = "default_margin")]
    pub margin_top: f64,
    #[serde(default = "default_margin")]
    pub margin_bottom: f64,
    #[serde(default = "default_margin_side")]
    pub margin_left: f64,
    #[serde(default = "default_margin_side")]
    pub margin_right: f64,
    /// Header/footer margins in inches
    #[serde(default = "default_header_margin")]
    pub margin_header: f64,
    #[serde(default = "default_header_margin")]
    pub margin_footer: f64,
    /// Scaling percentage (100 = no scaling)
    #[serde(default = "default_scale")]
    pub scale: u32,
    /// Fit to N pages wide (0 = auto/disabled)
    #[serde(default)]
    pub fit_to_width: u32,
    /// Fit to N pages tall (0 = auto/disabled)
    #[serde(default)]
    pub fit_to_height: u32,
    /// Whether to print gridlines
    #[serde(default)]
    pub print_gridlines: bool,
    /// Whether to print row/column headings
    #[serde(default)]
    pub print_headings: bool,
    /// Print area (e.g., "A1:F20"). Empty = entire sheet.
    #[serde(default)]
    pub print_area: String,
    /// Rows to repeat at top (e.g., "1:2"). Empty = none.
    #[serde(default)]
    pub print_titles_rows: String,
    /// Columns to repeat at left (e.g., "A:B"). Empty = none.
    #[serde(default)]
    pub print_titles_cols: String,
    /// Center content horizontally on page
    #[serde(default)]
    pub center_horizontally: bool,
    /// Center content vertically on page
    #[serde(default)]
    pub center_vertically: bool,
    /// Header text (left|center|right separated by &L, &C, &R)
    #[serde(default)]
    pub header: String,
    /// Footer text
    #[serde(default = "default_footer")]
    pub footer: String,
    /// Manual row page breaks (0-indexed row numbers where a new page starts)
    #[serde(default)]
    pub manual_row_breaks: Vec<u32>,
    /// Manual column page breaks (0-indexed col numbers where a new page starts)
    #[serde(default)]
    pub manual_col_breaks: Vec<u32>,
    /// Print comments mode: "none", "atEnd", "asDisplayed"
    #[serde(default)]
    pub print_comments: String,
    /// First page number: -1 = auto, 1+ = custom starting page number
    #[serde(default = "default_first_page_number")]
    pub first_page_number: i32,
    /// Page order: "downThenOver" or "overThenDown"
    #[serde(default)]
    pub page_order: String,
}

fn default_paper_size() -> String { "a4".to_string() }
fn default_orientation() -> String { "portrait".to_string() }
fn default_margin() -> f64 { 0.75 }
fn default_margin_side() -> f64 { 0.7 }
fn default_header_margin() -> f64 { 0.3 }
fn default_scale() -> u32 { 100 }
fn default_footer() -> String { "Page &P".to_string() }
fn default_first_page_number() -> i32 { -1 }

impl Default for PageSetup {
    fn default() -> Self {
        Self {
            paper_size: default_paper_size(),
            orientation: default_orientation(),
            margin_top: default_margin(),
            margin_bottom: default_margin(),
            margin_left: default_margin_side(),
            margin_right: default_margin_side(),
            margin_header: default_header_margin(),
            margin_footer: default_header_margin(),
            scale: default_scale(),
            fit_to_width: 0,
            fit_to_height: 0,
            print_gridlines: false,
            print_headings: false,
            print_area: String::new(),
            print_titles_rows: String::new(),
            print_titles_cols: String::new(),
            center_horizontally: false,
            center_vertically: false,
            header: String::new(),
            footer: default_footer(),
            manual_row_breaks: Vec::new(),
            manual_col_breaks: Vec::new(),
            print_comments: String::new(),
            first_page_number: default_first_page_number(),
            page_order: String::new(),
        }
    }
}

/// Data needed to render a print preview or execute a print.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintData {
    pub cells: Vec<CellData>,
    pub styles: Vec<StyleData>,
    pub col_widths: Vec<f64>,
    pub row_heights: Vec<f64>,
    pub merged_regions: Vec<MergedRegion>,
    pub page_setup: PageSetup,
    pub sheet_name: String,
    /// Grid bounds: (max_row, max_col) - 0-indexed
    pub bounds: (u32, u32),
}

// ============================================================================
// Scenario Manager
// ============================================================================

/// A single changing cell within a scenario.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioCell {
    /// Row (0-based)
    pub row: u32,
    /// Column (0-based)
    pub col: u32,
    /// The value for this cell in this scenario
    pub value: String,
}

/// A named scenario.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scenario {
    /// Unique scenario name
    pub name: String,
    /// Changing cells with their scenario values
    pub changing_cells: Vec<ScenarioCell>,
    /// Optional comment/description
    pub comment: String,
    /// Who created this scenario
    pub created_by: String,
    /// Sheet index this scenario belongs to (0-based)
    pub sheet_index: usize,
}

/// Parameters for adding/updating a scenario.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioAddParams {
    /// Scenario name (must be unique within sheet)
    pub name: String,
    /// Changing cells with values
    pub changing_cells: Vec<ScenarioCell>,
    /// Optional comment
    pub comment: String,
    /// Sheet index (0-based)
    pub sheet_index: usize,
}

/// Parameters for showing (applying) a scenario.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioShowParams {
    /// Name of the scenario to apply
    pub name: String,
    /// Sheet index (0-based)
    pub sheet_index: usize,
}

/// Parameters for deleting a scenario.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioDeleteParams {
    /// Name of the scenario to delete
    pub name: String,
    /// Sheet index (0-based)
    pub sheet_index: usize,
}

/// A single row in the scenario summary report.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioSummaryRow {
    /// Cell reference label (e.g. "$B$2")
    pub cell_ref: String,
    /// Current value of this cell
    pub current_value: String,
    /// Value in each scenario (parallel to scenario names)
    pub scenario_values: Vec<String>,
    /// Whether this is a changing cell (true) or result cell (false)
    pub is_changing_cell: bool,
}

/// Parameters for generating a scenario summary report.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioSummaryParams {
    /// Sheet index (0-based)
    pub sheet_index: usize,
    /// Result cells to include in the summary (rows of formulas)
    pub result_cells: Vec<ScenarioCell>,
}

/// Result of scenario summary generation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioSummaryResult {
    /// Names of all scenarios
    pub scenario_names: Vec<String>,
    /// Summary rows (changing cells + result cells)
    pub rows: Vec<ScenarioSummaryRow>,
    /// Error message if any
    pub error: Option<String>,
}

/// Result of showing a scenario.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioShowResult {
    /// Updated cells after applying the scenario
    pub updated_cells: Vec<CellData>,
    /// Error message if any
    pub error: Option<String>,
}

/// Result of listing scenarios.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioListResult {
    /// All scenarios for the sheet
    pub scenarios: Vec<Scenario>,
}

// ============================================================================
// Animation playback — transient frame writes (see animation_commands.rs)
// ============================================================================

/// A single transient cell write applied during one animation frame.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransientCellWrite {
    /// Row (0-based)
    pub row: u32,
    /// Column (0-based)
    pub col: u32,
    /// The literal value to write (parsed like a scenario value: number / TRUE /
    /// FALSE / text). A driver write never installs a formula.
    pub value: String,
}

/// Params for `anim_snapshot`: capture the listed cells under a caller-owned token.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimSnapshotParams {
    /// Token identifying this snapshot buffer (one per driver run).
    pub token: String,
    /// Sheet index (0-based)
    pub sheet_index: usize,
    /// Cells to snapshot, as [row, col] pairs.
    pub cells: Vec<(u32, u32)>,
}

/// Params for `anim_apply_frame`: apply this frame's transient writes + recalc.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimApplyFrameParams {
    /// The snapshot token this frame belongs to. Required: a frame may only be
    /// applied while its `anim_snapshot` restore buffer is on file, which is how
    /// the transient-write exemption from the dirty flag is PROVEN rather than
    /// asserted (see `document_effect::TransientScope`).
    pub token: String,
    /// Sheet index (0-based)
    pub sheet_index: usize,
    /// Transient writes for this frame.
    pub writes: Vec<TransientCellWrite>,
}

/// Params for `anim_restore`: restore (and drop) the named snapshot buffer.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimRestoreParams {
    /// The snapshot token to restore.
    pub token: String,
    /// Sheet index (0-based)
    pub sheet_index: usize,
}

/// Acknowledgement for `anim_snapshot`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimSnapshotResult {
    /// Whether the snapshot was captured.
    pub success: bool,
    /// Error message, if any.
    pub error: Option<String>,
}

/// Result of an animation frame apply / restore: the recalculated cells.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimationFrameResult {
    /// Cells changed by this frame (driver cell + recalculated dependents).
    pub updated_cells: Vec<CellData>,
    /// Error message, if any.
    pub error: Option<String>,
}

/// Params for `anim_reroll_and_read` (Monte Carlo): re-roll volatiles + read a cell.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimRerollParams {
    /// Sheet index (0-based)
    pub sheet_index: usize,
    /// Outcome cell to read after the recalc (0-based).
    pub outcome_row: u32,
    pub outcome_col: u32,
}

/// Result of one Monte Carlo trial: the numeric outcome after a fresh recalc.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimRerollResult {
    /// The outcome cell's numeric value (None if it is not numeric).
    pub value: Option<f64>,
    pub error: Option<String>,
}

/// One frame of a GIF export: RGBA pixels (width*height*4) + its display delay.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GifFrame {
    /// Row-major RGBA bytes; length must equal width*height*4.
    pub rgba: Vec<u8>,
    /// Frame delay in centiseconds (1/100 s).
    pub delay_cs: u16,
}

/// Request to encode a sequence of RGBA frames to an animated GIF on disk.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GifExportRequest {
    /// Absolute path to write the .gif to (chosen via a save dialog).
    pub path: String,
    pub width: u16,
    pub height: u16,
    pub frames: Vec<GifFrame>,
    /// Loop forever when true; play once when false.
    pub repeat: bool,
}

/// Generic result for scenario operations.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioResult {
    pub success: bool,
    pub error: Option<String>,
}

// ============================================================================
// Data Tables (What-If)
// ============================================================================

/// Parameters for a one-variable data table.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataTableOneVarParams {
    /// Sheet index (0-based)
    pub sheet_index: usize,
    /// The table range: top-left row (0-based)
    pub start_row: u32,
    /// The table range: top-left col (0-based)
    pub start_col: u32,
    /// The table range: bottom-right row (0-based, inclusive)
    pub end_row: u32,
    /// The table range: bottom-right col (0-based, inclusive)
    pub end_col: u32,
    /// Row input cell (if substituting along a row)
    pub row_input_row: Option<u32>,
    pub row_input_col: Option<u32>,
    /// Column input cell (if substituting along a column)
    pub col_input_row: Option<u32>,
    pub col_input_col: Option<u32>,
}

/// Parameters for a two-variable data table.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataTableTwoVarParams {
    /// Sheet index (0-based)
    pub sheet_index: usize,
    /// The table range: top-left row (0-based)
    pub start_row: u32,
    /// The table range: top-left col (0-based)
    pub start_col: u32,
    /// The table range: bottom-right row (0-based, inclusive)
    pub end_row: u32,
    /// The table range: bottom-right col (0-based, inclusive)
    pub end_col: u32,
    /// Row input cell (values in top row)
    pub row_input_row: u32,
    pub row_input_col: u32,
    /// Column input cell (values in left column)
    pub col_input_row: u32,
    pub col_input_col: u32,
}

/// A single computed cell value in the data table result.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataTableCell {
    pub row: u32,
    pub col: u32,
    pub value: String,
    pub numeric_value: Option<f64>,
}

/// Result of data table calculation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataTableResult {
    /// Computed cells
    pub cells: Vec<DataTableCell>,
    /// Updated cells for grid refresh
    pub updated_cells: Vec<CellData>,
    /// Error message if any
    pub error: Option<String>,
}

// ============================================================================
// Solver
// ============================================================================

/// Solver objective type.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SolverObjective {
    Maximize,
    Minimize,
    TargetValue,
}

/// Solver constraint operator.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConstraintOperator {
    /// <=
    LessEqual,
    /// >=
    GreaterEqual,
    /// =
    Equal,
    /// integer
    Integer,
    /// binary (0 or 1)
    Binary,
    /// all different
    AllDifferent,
}

/// A single solver constraint.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolverConstraint {
    /// Cell reference (row, col) for the left-hand side
    pub cell_row: u32,
    pub cell_col: u32,
    /// Operator
    pub operator: ConstraintOperator,
    /// Right-hand side value (not used for int/bin/dif)
    pub rhs_value: Option<f64>,
    /// Right-hand side cell reference (alternative to rhs_value)
    pub rhs_cell_row: Option<u32>,
    pub rhs_cell_col: Option<u32>,
}

/// Solver method.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SolverMethod {
    /// Generalized Reduced Gradient for nonlinear problems
    GrgNonlinear,
    /// Simplex for linear problems
    SimplexLp,
    /// Evolutionary/genetic algorithm
    Evolutionary,
}

/// Parameters for the solver command.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolverParams {
    /// Sheet index (0-based)
    pub sheet_index: usize,
    /// Objective cell (must contain a formula)
    pub objective_row: u32,
    pub objective_col: u32,
    /// Objective type
    pub objective: SolverObjective,
    /// Target value (only used when objective == TargetValue)
    pub target_value: Option<f64>,
    /// Variable cells (changing cells)
    pub variable_cells: Vec<SolverVariableCell>,
    /// Constraints
    pub constraints: Vec<SolverConstraint>,
    /// Solving method
    pub method: SolverMethod,
    /// Maximum iterations (default: 1000)
    #[serde(default = "default_solver_max_iterations")]
    pub max_iterations: u32,
    /// Maximum time in seconds (default: 100)
    #[serde(default = "default_solver_max_time")]
    pub max_time: u32,
    /// Convergence tolerance (default: 0.0001)
    #[serde(default = "default_solver_tolerance")]
    pub tolerance: f64,
}

fn default_solver_max_iterations() -> u32 {
    1000
}

fn default_solver_max_time() -> u32 {
    100
}

fn default_solver_tolerance() -> f64 {
    0.0001
}

/// A variable cell for the solver.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolverVariableCell {
    pub row: u32,
    pub col: u32,
}

/// Solver result.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SolverResult {
    /// Whether a solution was found
    pub found_solution: bool,
    /// Final objective value
    pub objective_value: f64,
    /// Final variable values
    pub variable_values: Vec<SolverVariableValue>,
    /// Number of iterations
    pub iterations: u32,
    /// Solver status message
    pub status_message: String,
    /// Updated cells for grid refresh
    pub updated_cells: Vec<CellData>,
    /// Original variable values (for reverting)
    pub original_values: Vec<SolverVariableValue>,
    /// Error message if any
    pub error: Option<String>,
}

/// A variable cell value in solver results.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolverVariableValue {
    pub row: u32,
    pub col: u32,
    pub value: f64,
}

// ============================================================================
// LOCALE / REGIONAL SETTINGS
// ============================================================================

/// Locale settings returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocaleSettingsData {
    pub locale_id: String,
    pub display_name: String,
    pub decimal_separator: String,
    pub thousands_separator: String,
    pub list_separator: String,
    pub date_format: String,
    /// OS long-date pattern. Excel's Long Date entry is `[$-x-sysdate]`, i.e.
    /// "whatever the region says"; this is that pattern for this locale.
    pub long_date_format: String,
    /// OS long-time pattern (with seconds). Excel's Time entry is
    /// `[$-x-systime]`.
    pub time_format: String,
    pub currency_symbol: String,
    pub currency_position: String,
}

impl From<&engine::LocaleSettings> for LocaleSettingsData {
    fn from(locale: &engine::LocaleSettings) -> Self {
        Self {
            locale_id: locale.locale_id.clone(),
            display_name: locale.display_name.clone(),
            decimal_separator: locale.decimal_separator.to_string(),
            thousands_separator: locale.thousands_separator.to_string(),
            list_separator: locale.list_separator.to_string(),
            date_format: locale.date_format.clone(),
            long_date_format: locale.long_date_format.clone(),
            time_format: locale.time_format.clone(),
            currency_symbol: locale.currency_symbol.clone(),
            currency_position: match locale.currency_position {
                engine::LocaleCurrencyPosition::Before => "before".to_string(),
                engine::LocaleCurrencyPosition::After => "after".to_string(),
            },
        }
    }
}

/// A supported locale entry for the settings UI dropdown.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportedLocaleEntry {
    pub locale_id: String,
    pub display_name: String,
}

// ============================================================================
// Named Cell Styles
// ============================================================================

/// A named cell style (e.g. "Heading 1", "Good", "Currency").
/// Maps a user-facing name to a style_index in the StyleRegistry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedCellStyle {
    /// Display name (e.g. "Heading 1")
    pub name: String,
    /// Whether this is a built-in style (cannot be deleted)
    pub built_in: bool,
    /// Index into the StyleRegistry
    pub style_index: usize,
    /// Category for grouping: "Good, Bad and Neutral", "Data and Model",
    /// "Titles and Headings", "Number Format", "Themed Cell Styles", "Custom"
    pub category: String,
}

/// Bounding box of all non-empty cells in the active sheet.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsedRangeResult {
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
    pub empty: bool,
}

/// Target cell of a Ctrl+Arrow / Range.End edge navigation (get_range_edge).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RangeEdgeResult {
    pub row: u32,
    pub col: u32,
}

/// One cell coordinate in a get_special_cells answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpecialCellRef {
    pub row: u32,
    pub col: u32,
}

/// Result of get_special_cells (Excel's Range.SpecialCells / Go To Special).
/// `cells` is row-major sorted and capped at 100,000 entries; `truncated`
/// says whether the cap dropped anything.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpecialCellsResult {
    pub cells: Vec<SpecialCellRef>,
    pub truncated: bool,
}

/// Which rows (or columns) are hidden on ONE sheet, split by authority.
///
/// The two questions a caller can ask are genuinely different and the shape
/// refuses to conflate them:
///   - `user`      -- what a person (or a script) hid BY HAND. "What did I hide?"
///   - `effective` -- hidden by ANY authority: user OR filter OR outline.
///                    "Is this row visible?"
///
/// `user` is always a subset of `effective`. Both are ascending.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HiddenLinesInfo {
    pub user: Vec<u32>,
    pub effective: Vec<u32>,
}

// ============================================================================
// Chart Entry (opaque JSON persistence)
// ============================================================================

/// A chart entry stored in the backend. The chart specification is stored as
/// an opaque JSON string to avoid replicating the full ChartSpec type in Rust.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartEntry {
    /// Unique chart ID (UUID, assigned by the frontend).
    pub id: identity::EntityId,
    /// Sheet index where the chart is rendered.
    pub sheet_index: usize,
    /// The full ChartDefinition serialized as a JSON string.
    pub spec_json: String,
}

// ============================================================================
// Sparkline Entry (opaque JSON persistence)
// ============================================================================

/// A sparkline entry stored in the backend. Sparkline groups are serialized
/// as JSON strings, similar to charts, to avoid replicating the full type in Rust.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SparklineEntry {
    /// Sheet index where the sparkline groups belong.
    pub sheet_index: usize,
    /// All sparkline groups for this sheet, serialized as a JSON string.
    pub groups_json: String,
}

// ============================================================================
// Floating Ranges
// ============================================================================

/// A FLOATING RANGE: a shape-like object floating over the grid whose content
/// is a real range of cells, backed by an OBJECT-VISIBILITY engine sheet
/// (`sheets::OBJECT_SHEET_VISIBILITY`). The object's NAME is not stored here —
/// it IS `sheet_names[backing]`, which is what makes `=Float1!A1` parse,
/// normalize, cascade and rename-repair through the ordinary sheet machinery.
///
/// Sheets are referenced by STABLE ID, never index: indices renumber on every
/// sheet add/delete/move and this row must survive all of them untouched.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FloatingRange {
    pub id: identity::EntityId,
    pub backing_sheet_id: identity::SheetId,
    pub host_sheet_id: identity::SheetId,
    /// Sheet pixels relative to the host sheet's A1 top-left corner.
    pub x: f64,
    pub y: f64,
    /// RESERVED for tilt: persisted from day one so adding rotation later is
    /// not a format change. Always 0.0 in v1; nothing renders tilted.
    #[serde(default)]
    pub rotation: f32,
    /// RESERVED for pin-to-grid anchoring (Controls semantics). v1: false.
    #[serde(default)]
    pub pin_to_grid: bool,
    /// The visible window: the backing grid is sparse and unbounded, these
    /// are how many rows/columns the object SHOWS (and its frame derives its
    /// size from). Shrinking hides but never deletes cells.
    pub row_count: u32,
    pub col_count: u32,
    /// Per-column width / per-row height overrides (logical px); missing
    /// entries use the grid defaults. No UI in v1; carried for v2.
    #[serde(default)]
    pub col_widths: std::collections::HashMap<u32, f64>,
    #[serde(default)]
    pub row_heights: std::collections::HashMap<u32, f64>,
}

/// What the frontend needs to render/address a floating range: the persisted
/// row plus the LIVE resolutions of its stable ids (object name = the backing
/// sheet's name; indices valid only until the next sheet operation).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FloatingRangeInfo {
    #[serde(flatten)]
    pub range: FloatingRange,
    pub name: String,
    pub backing_sheet_index: usize,
    pub host_sheet_index: usize,
}

/// Partial update for `update_floating_range`: geometry and window size in one
/// command (one `generate_handler!` slot — the dispatch frame's stack budget is
/// finite). Absent fields are left unchanged.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FloatingRangePatch {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub row_count: Option<u32>,
    pub col_count: Option<u32>,
}

/// Default row height and column width for the workbook.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultDimensions {
    pub default_row_height: f64,
    pub default_column_width: f64,
}

// ============================================================================
// Workbook Properties (document metadata)
// ============================================================================

/// Workbook-level document properties (author, title, subject, etc.).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookProperties {
    pub title: String,
    pub author: String,
    pub subject: String,
    pub description: String,
    pub keywords: String,
    pub category: String,
    /// ISO 8601 date string
    pub created: String,
    /// ISO 8601 date string
    pub last_modified: String,
}

/// Per-sheet DISPLAY FLAGS — the sheet's display mode, landed as one unit.
///
/// These four lived ONLY in the frontend Core grid reducer until .cala v6: there was no
/// authoritative Rust copy, so every one of them silently reset on save/reload. They
/// share a struct, a command and a format-version link because they are a single
/// user-facing concept and because four parallel `Vec`s would be four chances to forget
/// to resize on sheet insert.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetDisplayFlags {
    /// Zeros render as "0" (true, default) or blank.
    pub display_zeros: bool,
    /// Cells show formula TEXT instead of the computed value (Excel's Ctrl+`).
    pub show_formulas: bool,
    /// "normal" (default), "pageLayout" or "pageBreakPreview".
    pub view_mode: String,
    /// Row/column headings (1,2,3 / A,B,C) are shown.
    pub display_headings: bool,
}

impl Default for SheetDisplayFlags {
    fn default() -> Self {
        SheetDisplayFlags {
            display_zeros: true,
            show_formulas: false,
            view_mode: ::persistence::DEFAULT_SHEET_VIEW_MODE.to_string(),
            display_headings: true,
        }
    }
}

/// Partial update for [`SheetDisplayFlags`]: every field optional, so a caller that
/// toggles one flag does not have to know the other three (and cannot clobber them).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SheetDisplayFlagsPatch {
    pub display_zeros: Option<bool>,
    pub show_formulas: Option<bool>,
    pub view_mode: Option<String>,
    pub display_headings: Option<bool>,
}

#[cfg(test)]
mod overflow_class_tests {
    use super::*;
    use engine::{CellError, CellStyle, CellValue, NumberFormat};

    fn dated(pattern: &str) -> CellStyle {
        CellStyle::new().with_number_format(NumberFormat::Date { format: pattern.to_string() })
    }
    fn timed(pattern: &str) -> CellStyle {
        CellStyle::new().with_number_format(NumberFormat::Time { format: pattern.to_string() })
    }

    /// BUG-0066. The rung that no renderer-side rule can reach: Excel refuses a
    /// negative serial under a Date or Time format at EVERY width, because a
    /// serial below zero has no representation in the 1900 date system.
    ///
    /// The engine renders -1.0 as "1900-01-01" and -0.5 as "12:00:00" -- values
    /// a user cannot tell from real ones -- so by the time the renderer holds
    /// the display string the negativity is gone. It has to be decided HERE.
    #[test]
    fn a_negative_serial_under_a_date_or_time_format_is_unrepresentable() {
        for pattern in ["YYYY-MM-DD", "yyyy-mm-dd", "mm/dd/yyyy"] {
            assert_eq!(
                overflow_class_for(&CellValue::Number(-1.0), &dated(pattern)),
                OverflowClass::Unrepresentable,
                "negative date serial under {pattern}"
            );
        }
        assert_eq!(
            overflow_class_for(&CellValue::Number(-0.5), &timed("hh:mm:ss")),
            OverflowClass::Unrepresentable,
        );
    }

    /// The refusal is SCOPED to date/time formats. Excel shows a negative
    /// number under General or Number perfectly normally -- it is the date
    /// interpretation that has no answer, not the sign.
    #[test]
    fn a_negative_number_under_a_non_date_format_is_an_ordinary_numeric() {
        assert_eq!(
            overflow_class_for(&CellValue::Number(-1.0), &CellStyle::new()),
            OverflowClass::Numeric,
        );
        let two_dp = CellStyle::new().with_number_format(NumberFormat::Number {
            decimal_places: 2,
            use_thousands_separator: false,
        });
        assert_eq!(
            overflow_class_for(&CellValue::Number(-1.0), &two_dp),
            OverflowClass::Numeric,
        );
    }

    /// Zero is a real date (the 1900 system's day 0) and every positive serial
    /// is representable, so neither may be refused.
    #[test]
    fn zero_and_positive_serials_under_a_date_format_are_ordinary_numerics() {
        assert_eq!(
            overflow_class_for(&CellValue::Number(0.0), &dated("YYYY-MM-DD")),
            OverflowClass::Numeric,
        );
        assert_eq!(
            overflow_class_for(&CellValue::Number(45306.0), &dated("YYYY-MM-DD")),
            OverflowClass::Numeric,
        );
    }

    /// Excel's Text format shows the value exactly as typed and does not
    /// evaluate it as a number, so its digits still spill like prose and must
    /// never be marked. This is the second half BUG-0066 closes: the renderer's
    /// inference reads "1234567890" under `@` by its digits alone.
    #[test]
    fn digits_under_the_text_format_stay_text() {
        let text_fmt = CellStyle::new()
            .with_number_format(NumberFormat::Custom { format: "@".to_string() });
        assert_eq!(
            overflow_class_for(&CellValue::Number(1234567890.0), &text_fmt),
            OverflowClass::Text,
        );
        assert_eq!(
            overflow_class_for(&CellValue::Text("hello".into()), &text_fmt),
            OverflowClass::Text,
        );
    }

    /// Text stored in a cell carrying an explicitly numeric format is the case
    /// the renderer's inference gets WRONG (it reads a digit and says numeric),
    /// and it is exactly what the transported class fixes: a pasted header in a
    /// Date column is text and must not be marked.
    #[test]
    fn text_under_a_numeric_format_is_text_not_a_marked_number() {
        assert_eq!(
            overflow_class_for(&CellValue::Text("Q1 2024".into()), &dated("YYYY-MM-DD")),
            OverflowClass::Text,
        );
    }

    /// Errors and booleans cannot spill: Excel marks a too-narrow one exactly
    /// as it marks a number.
    #[test]
    fn errors_and_booleans_cannot_spill() {
        assert_eq!(
            overflow_class_for(&CellValue::Error(CellError::Div0), &CellStyle::new()),
            OverflowClass::Numeric,
        );
        assert_eq!(
            overflow_class_for(&CellValue::Boolean(true), &CellStyle::new()),
            OverflowClass::Numeric,
        );
    }

    /// An empty cell has nothing to overflow, and Text is the fail-safe class.
    #[test]
    fn empty_is_text_and_text_is_the_serde_default() {
        assert_eq!(
            overflow_class_for(&CellValue::Empty, &dated("YYYY-MM-DD")),
            OverflowClass::Text,
        );
        assert_eq!(OverflowClass::default(), OverflowClass::Text);
        assert!(OverflowClass::Text.is_default());
        assert!(!OverflowClass::Numeric.is_default());
        assert!(!OverflowClass::Unrepresentable.is_default());
    }

    /// The wire spelling is camelCase and the default costs no bytes -- the
    /// same struct-level `rename_all` discipline every other API type follows.
    #[test]
    fn the_wire_shape_is_camel_case_and_the_default_is_omitted() {
        let numeric = serde_json::to_string(&OverflowClass::Numeric).unwrap();
        assert_eq!(numeric, "\"numeric\"");
        let unrep = serde_json::to_string(&OverflowClass::Unrepresentable).unwrap();
        assert_eq!(unrep, "\"unrepresentable\"");

        let text_cell = CellData {
            row: 0,
            col: 0,
            display: "hi".into(),
            overflow: OverflowClass::Text,
            display_color: None,
            formula: None,
            style_index: 0,
            row_span: 1,
            col_span: 1,
            sheet_index: None,
            rich_text: None,
            accounting_layout: None,
        };
        let json = serde_json::to_string(&text_cell).unwrap();
        assert!(!json.contains("overflow"), "default must not reach the wire: {json}");

        let marked = CellData { overflow: OverflowClass::Unrepresentable, ..text_cell };
        let json = serde_json::to_string(&marked).unwrap();
        assert!(json.contains("\"overflow\":\"unrepresentable\""), "{json}");
    }
}
