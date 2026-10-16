//! FILENAME: app/src-tauri/src/pivot/grid_theme.rs
//! PURPOSE: The colours a pivot's HIDDEN GRID cells wear -- the persisted
//! PivotTable style (`PivotDefinition.style`), resolved from the ONE preset
//! data file the Pivot extension paints the box with.
//!
//! CONTEXT (ruling R3, WP-C S10b, 2026-10-15). `write_pivot_to_grid` used to
//! style every pivot cell from six fixed constants, whatever style the box
//! showed, so a copy of a styled pivot's cells pasted the default colours. The
//! Excel style catalogue is DATA, and it lives in exactly one file,
//! `app/extensions/Pivot/styles/excelPivotStyles.json`: the extension imports
//! it (styles/excelPivotStyles.ts, and rendering/pivot.ts's
//! `DEFAULT_PIVOT_THEME` takes its `fallbackTheme`), and this module
//! `include_str!`s the same bytes. There is no second list to drift: each
//! style carries its resolved `theme` (the PivotTheme values the box paints
//! with), so no derivation rule is ported here either.
//!
//! THE RESOLUTION RULE ([`resolved_theme_values`]) mirrors
//! `resolvePivotStyleOverrides` in `app/extensions/Pivot/lib/pivotStyles.ts`:
//!   1. no style, or style id "" -> the file's `defaultStyle`;
//!   2. an id the catalogue does not know -> no preset values (`fallbackTheme`);
//!   3. the pivot's theme overrides win, each only when it names a colour key
//!      of the style theme (never `headerFontWeight`) and is `#rrggbb`.
//!
//! The cell rules ([`PivotGridTheme::background_for`] / [`PivotGridTheme::text_for`]
//! and the bold rule in `build_pivot_cell_style`) mirror the box's
//! `getThemedBackground` / `getThemedTextStyle` (Pivot/rendering/pivot.ts).
//!
//! DRIFT: the tests below prove this module reads the file the TypeScript
//! module imports (and that the compiled-in bytes are that file's current
//! bytes); `app/extensions/Pivot/__tests__/pivotStyleSourceDrift.test.ts` proves
//! the reverse direction from the TypeScript side.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use engine::Color;
use pivot_engine::{BackgroundStyle, PivotCellType, PivotStyleChoice};
use serde::Deserialize;

/// Where the data file sits, relative to THIS source file. `include_str!`
/// takes a literal, so the macro below spells it again; the drift tests read
/// this source as text and compare both spellings to the TypeScript import.
pub(crate) const PIVOT_STYLE_DATA_PATH: &str = "../../../extensions/Pivot/styles/excelPivotStyles.json";

/// The ONE pivot style preset data file, compiled in.
pub(crate) const PIVOT_STYLE_DATA_JSON: &str =
    include_str!("../../../extensions/Pivot/styles/excelPivotStyles.json");

/// The data file's shape. Unknown keys (`$comment`, each style's Excel
/// element definitions, which only the gallery thumbnails read) are ignored.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PivotStyleData {
    pub default_style: String,
    pub fallback_theme: BTreeMap<String, String>,
    pub styles: Vec<PivotStylePreset>,
}

/// One preset: its Excel name and the PivotTheme values the box paints with.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PivotStylePreset {
    pub name: String,
    pub theme: BTreeMap<String, String>,
}

/// The parsed data file. A file that does not parse (impossible for a build
/// whose tests pass -- `the_data_file_parses_and_names_its_default`) is
/// logged once and read as empty, so every pivot falls back to
/// [`FAILSAFE`] colours instead of a panic inside a grid write.
pub(crate) fn pivot_style_data() -> Option<&'static PivotStyleData> {
    static DATA: OnceLock<Option<PivotStyleData>> = OnceLock::new();
    DATA.get_or_init(|| match serde_json::from_str::<PivotStyleData>(PIVOT_STYLE_DATA_JSON) {
        Ok(data) => Some(data),
        Err(e) => {
            crate::log_error!("PIVOT", "the pivot style data file does not parse: {}", e);
            None
        }
    })
    .as_ref()
}

/// The theme key a weight lives under; every other key is a colour.
const HEADER_FONT_WEIGHT: &str = "headerFontWeight";

fn is_rrggbb(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// THE resolution rule (module doc): every style theme key -> its value for
/// `choice`. Mirrors `resolvePivotStyleOverrides` merged over
/// `DEFAULT_PIVOT_THEME` (whose style keys ARE `fallbackTheme`).
pub(crate) fn resolved_theme_values(choice: Option<&PivotStyleChoice>) -> BTreeMap<String, String> {
    let Some(data) = pivot_style_data() else {
        return BTreeMap::new();
    };
    let mut out = data.fallback_theme.clone();
    let id = choice
        .map(|c| c.style_id.as_str())
        .filter(|id| !id.is_empty())
        .unwrap_or(data.default_style.as_str());
    if let Some(preset) = data.styles.iter().find(|s| s.name == id) {
        for (k, v) in &preset.theme {
            out.insert(k.clone(), v.clone());
        }
    }
    if let Some(choice) = choice {
        for (k, v) in &choice.theme_overrides {
            if k != HEADER_FONT_WEIGHT && data.fallback_theme.contains_key(k) && is_rrggbb(v) {
                out.insert(k.clone(), v.clone());
            }
        }
    }
    out
}

/// The colours the hidden grid needs, resolved once per grid write.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PivotGridTheme {
    pub header_background: Color,
    pub header_text: Color,
    pub label_background: Color,
    pub label_text: Color,
    pub value_background: Color,
    pub value_text: Color,
    pub total_background: Color,
    pub total_text: Color,
    pub grand_total_background: Color,
    pub grand_total_text: Color,
    pub filter_row_background: Color,
    pub filter_text: Color,
    pub alternate_row_background: Color,
    pub border_color: Color,
    pub header_border_color: Color,
    /// The box paints its bold cells with `headerFontWeight`; "400" = none bold.
    pub bold_weight: bool,
}

/// Used only when the data file cannot be read: white cells, black text.
const FAILSAFE_BACKGROUND: Color = Color::white();
const FAILSAFE_TEXT: Color = Color::black();

/// A CSS font weight that paints bold ("bold", "bolder", or 600 and up).
fn weight_is_bold(weight: &str) -> bool {
    match weight.trim() {
        "bold" | "bolder" => true,
        w => w.parse::<u32>().map(|n| n >= 600).unwrap_or(false),
    }
}

impl PivotGridTheme {
    /// The theme `choice` resolves to (`None` = the pivot has no persisted style).
    pub(crate) fn for_choice(choice: Option<&PivotStyleChoice>) -> PivotGridTheme {
        let values = resolved_theme_values(choice);
        let colour = |key: &str, failsafe: Color| -> Color {
            values.get(key).and_then(|v| Color::from_hex(v)).unwrap_or(failsafe)
        };
        PivotGridTheme {
            header_background: colour("headerBackground", FAILSAFE_BACKGROUND),
            header_text: colour("headerText", FAILSAFE_TEXT),
            label_background: colour("labelBackground", FAILSAFE_BACKGROUND),
            label_text: colour("labelText", FAILSAFE_TEXT),
            value_background: colour("valueBackground", FAILSAFE_BACKGROUND),
            value_text: colour("valueText", FAILSAFE_TEXT),
            total_background: colour("totalBackground", FAILSAFE_BACKGROUND),
            total_text: colour("totalText", FAILSAFE_TEXT),
            grand_total_background: colour("grandTotalBackground", FAILSAFE_BACKGROUND),
            grand_total_text: colour("grandTotalText", FAILSAFE_TEXT),
            filter_row_background: colour("filterRowBackground", FAILSAFE_BACKGROUND),
            filter_text: colour("filterText", FAILSAFE_TEXT),
            alternate_row_background: colour("alternateRowBackground", FAILSAFE_BACKGROUND),
            border_color: colour("borderColor", FAILSAFE_BACKGROUND),
            header_border_color: colour("headerBorderColor", FAILSAFE_BACKGROUND),
            bold_weight: values.get(HEADER_FONT_WEIGHT).map(|w| weight_is_bold(w)).unwrap_or(true),
        }
    }

    /// The default style's theme: a pivot with no persisted style, and the
    /// grid REPORTS that reuse the pivot writer (they have no style of their own).
    pub(crate) fn default_style() -> PivotGridTheme {
        PivotGridTheme::for_choice(None)
    }

    /// Does the box paint this cell's BACKGROUND as a label (`labelBackground`)
    /// rather than a value? `getThemedBackground`'s Normal branch.
    pub(crate) fn label_background_cell(cell_type: &PivotCellType) -> bool {
        matches!(
            cell_type,
            PivotCellType::RowHeader
                | PivotCellType::Corner
                | PivotCellType::RowLabelHeader
                | PivotCellType::ColumnLabelHeader
        )
    }

    /// Does the box paint this cell's TEXT as a label (`labelText`)?
    /// `getThemedTextStyle`'s default branch -- note it includes ColumnHeader,
    /// which the background rule does not.
    pub(crate) fn label_text_cell(cell_type: &PivotCellType) -> bool {
        matches!(
            cell_type,
            PivotCellType::RowHeader
                | PivotCellType::ColumnHeader
                | PivotCellType::Corner
                | PivotCellType::RowLabelHeader
                | PivotCellType::ColumnLabelHeader
        )
    }

    /// The cell's fill: `getThemedBackground`.
    pub(crate) fn background_for(&self, background: &BackgroundStyle, cell_type: &PivotCellType) -> Color {
        match background {
            BackgroundStyle::Header => self.header_background,
            BackgroundStyle::Subtotal | BackgroundStyle::Total => self.total_background,
            BackgroundStyle::GrandTotal => self.grand_total_background,
            BackgroundStyle::FilterRow => self.filter_row_background,
            BackgroundStyle::Alternate => self.alternate_row_background,
            BackgroundStyle::Normal => {
                if Self::label_background_cell(cell_type) {
                    self.label_background
                } else {
                    self.value_background
                }
            }
        }
    }

    /// The cell's text colour: `getThemedTextStyle`.
    pub(crate) fn text_for(&self, background: &BackgroundStyle, cell_type: &PivotCellType) -> Color {
        match background {
            BackgroundStyle::Header => self.header_text,
            BackgroundStyle::GrandTotal => self.grand_total_text,
            BackgroundStyle::Subtotal | BackgroundStyle::Total => self.total_text,
            BackgroundStyle::FilterRow => self.filter_text,
            BackgroundStyle::Normal | BackgroundStyle::Alternate => {
                if Self::label_text_cell(cell_type) {
                    self.label_text
                } else {
                    self.value_text
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "grid_theme_tests.rs"]
mod tests;
