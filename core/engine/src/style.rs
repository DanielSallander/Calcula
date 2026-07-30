//! FILENAME: core/engine/src/style.rs
//! PURPOSE: Defines the style data structures and registry for cell formatting.
//! CONTEXT: This file implements the Flyweight Pattern for efficient style storage.
//! Instead of storing full style data on every cell, cells store a style_index (usize)
//! that points to a shared Style object in the central StyleRegistry.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::theme::ThemeColor;

/// Text alignment options for cell content.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub enum TextAlign {
    #[default]
    General, // Auto: numbers right, text left
    Left,
    Center,
    Right,
}

/// Vertical alignment options for cell content.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub enum VerticalAlign {
    Top,
    #[default]
    Middle,
    Bottom,
}

/// Text rotation angles for cell content.
/// Measured in degrees counter-clockwise from horizontal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub enum TextRotation {
    #[default]
    None,        // 0 degrees (horizontal)
    Rotate90,    // 90 degrees counter-clockwise
    Rotate270,   // 270 degrees (90 degrees clockwise)
    Custom(i16), // Custom angle: -90 to +90 degrees
}

/// Number format types for displaying numeric values.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub enum NumberFormat {
    #[default]
    General,
    Number {
        decimal_places: u8,
        use_thousands_separator: bool,
    },
    Currency {
        decimal_places: u8,
        symbol: String,
        symbol_position: CurrencyPosition,
    },
    Accounting {
        decimal_places: u8,
        symbol: String,
        symbol_position: CurrencyPosition,
    },
    Fraction {
        /// Fixed denominator (e.g., Some(4) for quarters). None = best-fit.
        denominator: Option<u32>,
        /// Max digits in numerator/denominator for best-fit (1, 2, or 3).
        max_digits: u8,
    },
    Percentage {
        decimal_places: u8,
    },
    Scientific {
        decimal_places: u8,
    },
    Date {
        format: String, // e.g., "YYYY-MM-DD", "MM/DD/YYYY"
    },
    Time {
        format: String, // e.g., "HH:MM:SS", "HH:MM AM/PM"
    },
    Custom {
        format: String,
    },
}

/// Position of currency symbol relative to the number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub enum CurrencyPosition {
    #[default]
    Before, // $100
    After,  // 100$
}

/// RGB color representation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Color {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8, // Alpha channel (255 = opaque)
}

impl Color {
    pub const fn new(r: u8, g: u8, b: u8) -> Self {
        Color { r, g, b, a: 255 }
    }

    pub const fn with_alpha(r: u8, g: u8, b: u8, a: u8) -> Self {
        Color { r, g, b, a }
    }

    pub const fn black() -> Self {
        Color::new(0, 0, 0)
    }

    pub const fn white() -> Self {
        Color::new(255, 255, 255)
    }

    pub const fn transparent() -> Self {
        Color::with_alpha(0, 0, 0, 0)
    }

    /// Convert to CSS rgba() string.
    pub fn to_css(&self) -> String {
        if self.a == 255 {
            format!("#{:02x}{:02x}{:02x}", self.r, self.g, self.b)
        } else {
            format!(
                "rgba({}, {}, {}, {:.2})",
                self.r,
                self.g,
                self.b,
                self.a as f32 / 255.0
            )
        }
    }

    /// Parse from hex string (e.g., "#FF0000" or "FF0000").
    pub fn from_hex(hex: &str) -> Option<Self> {
        let hex = hex.trim_start_matches('#');
        if hex.len() == 6 {
            let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
            let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
            let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
            Some(Color::new(r, g, b))
        } else if hex.len() == 8 {
            let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
            let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
            let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
            let a = u8::from_str_radix(&hex[6..8], 16).ok()?;
            Some(Color::with_alpha(r, g, b, a))
        } else {
            None
        }
    }
}

impl Default for Color {
    fn default() -> Self {
        Color::black()
    }
}

/// Border style for a single edge.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub struct BorderStyle {
    pub width: u8,           // 0 = no border, 1 = thin, 2 = medium, 3 = thick
    pub color: ThemeColor,
    pub style: BorderLineStyle,
}

/// Line style for borders.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub enum BorderLineStyle {
    #[default]
    None,
    Solid,
    Dashed,
    Dotted,
    Double,
}

/// Complete border configuration for a cell.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub struct Borders {
    pub top: BorderStyle,
    pub right: BorderStyle,
    pub bottom: BorderStyle,
    pub left: BorderStyle,
    /// Diagonal border from top-left to bottom-right (\).
    #[serde(default)]
    pub diagonal_down: BorderStyle,
    /// Diagonal border from bottom-left to top-right (/).
    #[serde(default)]
    pub diagonal_up: BorderStyle,
}

/// Pattern type for pattern fills (Excel-compatible set).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub enum PatternType {
    #[default]
    None,
    Solid,
    DarkGray,       // 75% gray
    MediumGray,     // 50% gray
    LightGray,      // 25% gray
    Gray125,        // 12.5% gray
    Gray0625,       // 6.25% gray
    DarkHorizontal,
    DarkVertical,
    DarkDown,       // diagonal \
    DarkUp,         // diagonal /
    DarkGrid,       // cross-hatch
    DarkTrellis,    // diagonal cross-hatch
    LightHorizontal,
    LightVertical,
    LightDown,
    LightUp,
    LightGrid,
    LightTrellis,
}

/// Direction for gradient fills.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub enum GradientDirection {
    #[default]
    Horizontal, // left to right (0 degrees)
    Vertical,   // top to bottom (90 degrees)
    DiagonalDown, // top-left to bottom-right (135 degrees)
    DiagonalUp,   // bottom-left to top-right (45 degrees)
    FromCenter,   // radial from center
}

/// Fill type for cells.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Fill {
    /// No fill / default white background
    #[default]
    None,
    /// Solid color fill
    Solid {
        color: ThemeColor,
    },
    /// Pattern fill with foreground pattern on background color
    Pattern {
        pattern_type: PatternType,
        fg_color: ThemeColor,
        bg_color: ThemeColor,
    },
    /// Two-color gradient fill
    Gradient {
        color1: ThemeColor,
        color2: ThemeColor,
        direction: GradientDirection,
    },
}

impl Fill {
    /// Get the primary background color of this fill (for legacy compatibility).
    /// Returns the solid color, pattern bg color, gradient first color, or default white.
    pub fn background_color(&self) -> &ThemeColor {
        match self {
            Fill::None => &ThemeColor::DEFAULT_BACKGROUND,
            Fill::Solid { color } => color,
            Fill::Pattern { bg_color, .. } => bg_color,
            Fill::Gradient { color1, .. } => color1,
        }
    }

    /// Check if this fill is the default (no fill).
    pub fn is_none(&self) -> bool {
        matches!(self, Fill::None)
    }
}

/// Underline style for font rendering (Excel-compatible).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
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

/// Font style configuration.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct FontStyle {
    pub family: String,
    pub size: u8,         // Font size in points
    pub bold: bool,
    pub italic: bool,
    pub underline: UnderlineStyle,
    pub strikethrough: bool,
    pub color: ThemeColor,
}

impl Default for FontStyle {
    fn default() -> Self {
        FontStyle {
            family: "Body".to_string(),
            size: 11,
            bold: false,
            italic: false,
            underline: UnderlineStyle::None,
            strikethrough: false,
            color: ThemeColor::default_text(),
        }
    }
}

/// Complete cell style definition.
/// This is what gets stored in the StyleRegistry.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(default)]
pub struct CellStyle {
    pub font: FontStyle,
    pub fill: Fill,
    pub text_align: TextAlign,
    pub vertical_align: VerticalAlign,
    pub number_format: NumberFormat,
    pub borders: Borders,
    pub wrap_text: bool,
    pub text_rotation: TextRotation,
    pub indent: u8, // Number of indent levels (each level = ~8px)
    pub shrink_to_fit: bool, // Auto-reduce font size to fit cell width
    pub checkbox: bool, // In-cell checkbox presentation mode
    pub button: bool, // In-cell button control presentation mode
    pub locked: bool, // Cell locked when sheet is protected (Excel default: true)
    pub formula_hidden: bool, // Hide formula when sheet is protected
}

impl CellStyle {
    /// Create a new default style.
    pub fn new() -> Self {
        CellStyle {
            font: FontStyle::default(),
            fill: Fill::None,
            text_align: TextAlign::General,
            vertical_align: VerticalAlign::Middle,
            number_format: NumberFormat::General,
            borders: Borders::default(),
            wrap_text: false,
            text_rotation: TextRotation::None,
            indent: 0,
            shrink_to_fit: false,
            checkbox: false,
            button: false,
            locked: true,
            formula_hidden: false,
        }
    }

    /// Create a style with bold text.
    pub fn with_bold(mut self, bold: bool) -> Self {
        self.font.bold = bold;
        self
    }

    /// Create a style with italic text.
    pub fn with_italic(mut self, italic: bool) -> Self {
        self.font.italic = italic;
        self
    }

    /// Create a style with a specific text color.
    pub fn with_text_color(mut self, color: ThemeColor) -> Self {
        self.font.color = color;
        self
    }

    /// Create a style with a specific solid background color.
    pub fn with_background(mut self, color: ThemeColor) -> Self {
        self.fill = Fill::Solid { color };
        self
    }

    /// Create a style with a specific fill.
    pub fn with_fill(mut self, fill: Fill) -> Self {
        self.fill = fill;
        self
    }

    /// Create a style with a specific text alignment.
    pub fn with_text_align(mut self, align: TextAlign) -> Self {
        self.text_align = align;
        self
    }

    /// Create a style with a specific number format.
    pub fn with_number_format(mut self, format: NumberFormat) -> Self {
        self.number_format = format;
        self
    }

    /// Create a style with wrap text enabled/disabled.
    pub fn with_wrap_text(mut self, wrap: bool) -> Self {
        self.wrap_text = wrap;
        self
    }

    /// Create a style with a specific text rotation.
    pub fn with_text_rotation(mut self, rotation: TextRotation) -> Self {
        self.text_rotation = rotation;
        self
    }

    /// Create a style with a specific vertical alignment.
    pub fn with_vertical_align(mut self, align: VerticalAlign) -> Self {
        self.vertical_align = align;
        self
    }

    /// Create a style with underline text.
    pub fn with_underline(mut self, underline: UnderlineStyle) -> Self {
        self.font.underline = underline;
        self
    }

    /// Create a style with strikethrough text.
    pub fn with_strikethrough(mut self, strikethrough: bool) -> Self {
        self.font.strikethrough = strikethrough;
        self
    }

    /// Create a style with checkbox presentation mode.
    pub fn with_checkbox(mut self, checkbox: bool) -> Self {
        self.checkbox = checkbox;
        self
    }
}

impl Default for CellStyle {
    fn default() -> Self {
        CellStyle::new()
    }
}

/// The StyleRegistry implements the Flyweight Pattern.
/// It stores unique styles and returns indices for cells to reference.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StyleRegistry {
    /// Vector of unique styles. Index 0 is always the default style.
    styles: Vec<CellStyle>,
    /// Reverse lookup: style hash -> index for deduplication.
    #[serde(skip)]
    style_to_index: HashMap<CellStyle, usize>,
    /// Memoized index of the explicit duplicate of the default style, created
    /// by [`get_or_create_explicit`]. One duplicate serves every caller — this
    /// is what stops N explicit-default requests from appending N entries.
    #[serde(skip)]
    explicit_default: Option<usize>,
}

impl StyleRegistry {
    /// Create a new registry with the default style at index 0.
    pub fn new() -> Self {
        let default_style = CellStyle::new();
        let mut style_to_index = HashMap::new();
        style_to_index.insert(default_style.clone(), 0);

        StyleRegistry {
            styles: vec![default_style],
            style_to_index,
            explicit_default: None,
        }
    }

    /// Reconstruct a registry from a saved style vector, PRESERVING INDICES.
    ///
    /// This is the load-path counterpart of `all_styles()`. It must not intern:
    /// `get_or_create` dedupes, and the saved vector legitimately contains a
    /// duplicate of the default style whenever `get_or_create_explicit` ran
    /// before the save. Interning would collapse that duplicate and shift every
    /// later index down by one — silently re-styling (and re-locking) every
    /// cell whose index landed after it. Cells reference these indices verbatim,
    /// so the vector is installed verbatim.
    ///
    /// The dedup map keeps the FIRST occurrence of each style, which reproduces
    /// exactly the map `get_or_create`/`get_or_create_explicit` had built before
    /// the save: the default maps to 0, and the duplicate is only reachable
    /// through `explicit_default`.
    pub fn from_styles(styles: Vec<CellStyle>) -> Self {
        if styles.is_empty() {
            return StyleRegistry::new();
        }
        let mut registry = StyleRegistry {
            styles,
            style_to_index: HashMap::new(),
            explicit_default: None,
        };
        registry.rebuild_index();
        registry
    }

    /// Get or create a style index for the given style.
    /// If the style already exists, returns its index.
    /// Otherwise, adds the style and returns the new index.
    pub fn get_or_create(&mut self, style: CellStyle) -> usize {
        if let Some(&index) = self.style_to_index.get(&style) {
            return index;
        }

        let index = self.styles.len();
        self.style_to_index.insert(style.clone(), index);
        self.styles.push(style);
        index
    }

    /// Intern a style, guaranteeing a NON-ZERO index.
    ///
    /// Index 0 is overloaded: it is the default style, and on a cell it also
    /// means "inherit from the row/column tier" (see
    /// `Grid::effective_style_index`). A cell that must carry an EXPLICIT style
    /// therefore cannot use it — even when that style happens to equal the
    /// default.
    ///
    /// The case that forces this: a column is unlocked via its tier, and the
    /// user re-locks ONE cell in it. The style that cell needs is "locked, and
    /// otherwise default" — which IS the default, so plain `get_or_create`
    /// hands back 0, the cell reads as "inherit", and it stays unlocked. Here we
    /// append a duplicate of the default instead, giving the cell something
    /// concrete to point at. Dedup is only a size optimisation, so one extra
    /// entry costs nothing but correctness gains.
    pub fn get_or_create_explicit(&mut self, style: CellStyle) -> usize {
        let index = self.get_or_create(style.clone());
        if index != 0 {
            return index;
        }
        // One duplicate is enough for every caller; without this memo a
        // per-cell loop (lock a whole column, say) would append one entry per
        // cell, and the registry is persisted and shipped over IPC whole.
        if let Some(explicit) = self.explicit_default {
            return explicit;
        }
        // Deliberately NOT recorded in `style_to_index`: that map must keep
        // pointing the default at 0 so ordinary interning still dedupes.
        let explicit = self.styles.len();
        self.styles.push(style);
        self.explicit_default = Some(explicit);
        explicit
    }

    /// Get a style by its index.
    /// Returns the default style (index 0) if index is out of bounds.
    pub fn get(&self, index: usize) -> &CellStyle {
        self.styles.get(index).unwrap_or(&self.styles[0])
    }

    /// Get the default style (index 0).
    pub fn default_style(&self) -> &CellStyle {
        &self.styles[0]
    }

    /// Get the total number of unique styles.
    pub fn len(&self) -> usize {
        self.styles.len()
    }

    /// Check if the registry only contains the default style.
    pub fn is_empty(&self) -> bool {
        self.styles.len() <= 1
    }

    /// Rebuild the reverse lookup map after deserialization.
    ///
    /// FIRST occurrence wins. A blind insert would let a later duplicate of the
    /// default (from `get_or_create_explicit`) overwrite the default's map
    /// entry, after which ordinary interning of the default would return the
    /// duplicate's index instead of 0 — flipping "inherit" cells to "explicit".
    pub fn rebuild_index(&mut self) {
        self.style_to_index.clear();
        self.explicit_default = None;
        for (index, style) in self.styles.iter().enumerate() {
            if !self.style_to_index.contains_key(style) {
                self.style_to_index.insert(style.clone(), index);
            } else if index != 0 && self.explicit_default.is_none() && *style == self.styles[0] {
                // Recover the memo so post-load explicit interning reuses the
                // persisted duplicate instead of appending another.
                self.explicit_default = Some(index);
            }
        }
    }

    /// Get all styles (for serialization/debugging).
    pub fn all_styles(&self) -> &[CellStyle] {
        &self.styles
    }

    /// Merge every style of `local` into this registry and return the remap
    /// table (`local index -> index here`).
    ///
    /// A NON-ZERO local index whose style equals the default is the explicit
    /// duplicate `get_or_create_explicit` creates ("locked but otherwise
    /// default"). Plain interning would collapse it to 0 — which on a cell
    /// means "inherit the row/column tier" — so it is re-interned explicitly.
    pub fn merge_remap(&mut self, local: &StyleRegistry) -> Vec<usize> {
        let default_style = CellStyle::new();
        local
            .styles
            .iter()
            .enumerate()
            .map(|(i, style)| {
                if i != 0 && *style == default_style {
                    self.get_or_create_explicit(style.clone())
                } else {
                    self.get_or_create(style.clone())
                }
            })
            .collect()
    }
}

impl Default for StyleRegistry {
    fn default() -> Self {
        StyleRegistry::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_color_css() {
        let red = Color::new(255, 0, 0);
        assert_eq!(red.to_css(), "#ff0000");

        let semi_transparent = Color::with_alpha(0, 255, 0, 128);
        assert!(semi_transparent.to_css().starts_with("rgba("));
    }

    #[test]
    fn test_color_from_hex() {
        let color = Color::from_hex("#FF0000").unwrap();
        assert_eq!(color.r, 255);
        assert_eq!(color.g, 0);
        assert_eq!(color.b, 0);

        let color2 = Color::from_hex("00FF00").unwrap();
        assert_eq!(color2.g, 255);
    }

    #[test]
    fn test_style_registry_deduplication() {
        let mut registry = StyleRegistry::new();

        // Create two identical bold styles
        let style1 = CellStyle::new().with_bold(true);
        let style2 = CellStyle::new().with_bold(true);

        let index1 = registry.get_or_create(style1);
        let index2 = registry.get_or_create(style2);

        // Should get the same index
        assert_eq!(index1, index2);
        assert_eq!(registry.len(), 2); // default + bold
    }

    #[test]
    fn test_style_registry_different_styles() {
        let mut registry = StyleRegistry::new();

        let bold = CellStyle::new().with_bold(true);
        let italic = CellStyle::new().with_italic(true);

        let index1 = registry.get_or_create(bold);
        let index2 = registry.get_or_create(italic);

        // Should get different indices
        assert_ne!(index1, index2);
        assert_eq!(registry.len(), 3); // default + bold + italic
    }

    #[test]
    fn test_default_style_index() {
        let registry = StyleRegistry::new();
        let default = registry.get(0);
        assert!(!default.font.bold);
        assert!(!default.font.italic);
    }

    // REGRESSION: get_or_create_explicit's duplicate default collapsed when the
    // load path re-interned the saved vector, shifting every later style index
    // down by one — silently re-styling (and re-locking) cells after a reload.
    #[test]
    fn from_styles_preserves_indices_verbatim_including_explicit_duplicates() {
        let mut registry = StyleRegistry::new();
        let mut bold = CellStyle::new();
        bold.font.bold = true;
        let bold_idx = registry.get_or_create(bold.clone());
        let explicit_idx = registry.get_or_create_explicit(CellStyle::new());
        let mut italic = CellStyle::new();
        italic.font.italic = true;
        let italic_idx = registry.get_or_create(italic.clone());
        assert!(explicit_idx != 0 && italic_idx > explicit_idx);

        // "Save" and "load".
        let restored = StyleRegistry::from_styles(registry.all_styles().to_vec());
        assert_eq!(restored.len(), registry.len(), "no dedup collapse on load");
        assert!(restored.get(bold_idx).font.bold);
        assert_eq!(*restored.get(explicit_idx), CellStyle::new());
        assert!(restored.get(italic_idx).font.italic);

        // The dedup map still points the default at 0 (first occurrence wins) …
        let mut restored = restored;
        assert_eq!(restored.get_or_create(CellStyle::new()), 0);
        // … and the explicit-default memo reuses the persisted duplicate.
        assert_eq!(restored.get_or_create_explicit(CellStyle::new()), explicit_idx);
    }

    #[test]
    fn explicit_default_is_memoized_not_appended_per_call() {
        let mut registry = StyleRegistry::new();
        let first = registry.get_or_create_explicit(CellStyle::new());
        let second = registry.get_or_create_explicit(CellStyle::new());
        assert_eq!(first, second);
        assert_eq!(registry.len(), 2); // default + ONE duplicate
    }

    #[test]
    fn merge_remap_keeps_explicit_defaults_non_zero() {
        let mut local = StyleRegistry::new();
        let explicit_local = local.get_or_create_explicit(CellStyle::new());
        let mut shared = StyleRegistry::new();
        let remap = shared.merge_remap(&local);
        assert_eq!(remap[0], 0);
        assert_ne!(remap[explicit_local], 0, "explicit default must stay explicit");
    }

    #[test]
    fn test_default_indent_and_shrink_to_fit() {
        let style = CellStyle::new();
        assert_eq!(style.indent, 0);
        assert!(!style.shrink_to_fit);
    }

    #[test]
    fn test_indent_styles_are_distinct() {
        let mut registry = StyleRegistry::new();

        let indent0 = CellStyle::new();
        let mut indent2 = CellStyle::new();
        indent2.indent = 2;

        let idx0 = registry.get_or_create(indent0);
        let idx2 = registry.get_or_create(indent2);

        assert_ne!(idx0, idx2);
        assert_eq!(registry.get(idx2).indent, 2);
    }

    #[test]
    fn test_shrink_to_fit_style_distinct() {
        let mut registry = StyleRegistry::new();

        let normal = CellStyle::new();
        let mut shrink = CellStyle::new();
        shrink.shrink_to_fit = true;

        let idx_normal = registry.get_or_create(normal);
        let idx_shrink = registry.get_or_create(shrink);

        assert_ne!(idx_normal, idx_shrink);
        assert!(registry.get(idx_shrink).shrink_to_fit);
    }

    #[test]
    fn test_indent_deduplication() {
        let mut registry = StyleRegistry::new();

        let mut style1 = CellStyle::new();
        style1.indent = 3;
        let mut style2 = CellStyle::new();
        style2.indent = 3;

        let idx1 = registry.get_or_create(style1);
        let idx2 = registry.get_or_create(style2);

        assert_eq!(idx1, idx2, "Same indent level should deduplicate");
    }

    #[test]
    fn test_serde_backward_compat_missing_fields() {
        // Simulate deserializing a CellStyle JSON that doesn't have indent/shrink_to_fit/fill
        let json = r#"{
            "font": {
                "family": "Body",
                "size": 11,
                "bold": false,
                "italic": false,
                "underline": "None",
                "strikethrough": false,
                "color": {"Absolute": {"r": 0, "g": 0, "b": 0, "a": 255}}
            },
            "text_align": "General",
            "vertical_align": "Middle",
            "number_format": "General",
            "borders": {
                "top": {"width": 0, "color": {"Absolute": {"r": 0, "g": 0, "b": 0, "a": 255}}, "style": "None"},
                "right": {"width": 0, "color": {"Absolute": {"r": 0, "g": 0, "b": 0, "a": 255}}, "style": "None"},
                "bottom": {"width": 0, "color": {"Absolute": {"r": 0, "g": 0, "b": 0, "a": 255}}, "style": "None"},
                "left": {"width": 0, "color": {"Absolute": {"r": 0, "g": 0, "b": 0, "a": 255}}, "style": "None"}
            },
            "wrap_text": false,
            "text_rotation": "None",
            "checkbox": false,
            "button": false
        }"#;

        let style: CellStyle = serde_json::from_str(json).expect("Should deserialize without indent/shrink_to_fit/fill");
        assert_eq!(style.indent, 0, "Missing indent should default to 0");
        assert!(!style.shrink_to_fit, "Missing shrink_to_fit should default to false");
        assert!(style.fill.is_none(), "Missing fill should default to None");
    }
}