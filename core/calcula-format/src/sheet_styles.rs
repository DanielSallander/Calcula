//! FILENAME: core/calcula-format/src/sheet_styles.rs
//! Per-sheet style index mapping and style registry serialization.
//!
//! styles/registry.json contains the full StyleRegistry (all unique styles).
//! sheets/X/styles.json maps cell references to style indices.

use crate::cell_ref;
use engine::style::CellStyle;
use persistence::SavedCell;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

/// Per-sheet style assignments: maps A1 references to style indices.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SheetStyles {
    /// Cell reference -> style index. Only non-default (index > 0) entries are stored.
    pub cells: BTreeMap<String, usize>,
}

/// Convert a cell map to SheetStyles (only cells with non-default styles).
pub fn cells_to_sheet_styles(cells: &HashMap<(u32, u32), SavedCell>) -> SheetStyles {
    let mut style_cells = BTreeMap::new();

    for ((row, col), cell) in cells {
        if cell.style_index > 0 {
            let key = cell_ref::to_a1(*row, *col);
            style_cells.insert(key, cell.style_index);
        }
    }

    SheetStyles {
        cells: style_cells,
    }
}

/// Apply style indices from SheetStyles onto a cell map.
pub fn apply_sheet_styles(
    cells: &mut HashMap<(u32, u32), SavedCell>,
    styles: &SheetStyles,
) {
    for (key, &style_index) in &styles.cells {
        if let Some((row, col)) = cell_ref::from_a1(key) {
            if let Some(cell) = cells.get_mut(&(row, col)) {
                cell.style_index = style_index;
            } else {
                // Style exists for a cell not in data.json — create an empty cell with style
                cells.insert(
                    (row, col),
                    SavedCell {
                        value: persistence::SavedCellValue::Empty,
                        formula: None,
                        style_index,
                        rich_text: None,
                        // A style-only cell has no formula, so it can never be
                        // a spill origin.
                        spill: None,
                    },
                );
            }
        }
    }
}

/// Serialize the full style registry to JSON.
pub fn serialize_style_registry(registry: &[CellStyle]) -> Result<String, serde_json::Error> {
    serde_json::to_string_pretty(registry)
}

/// Deserialize a style registry from JSON (inverse of [`serialize_style_registry`]).
/// Production reads go through `read_optional_json` in zip_io; this function
/// pins the registry format contract and is exercised by the roundtrip test.
#[cfg_attr(not(test), allow(dead_code))]
pub fn deserialize_style_registry(json: &str) -> Result<Vec<CellStyle>, serde_json::Error> {
    serde_json::from_str(json)
}



#[cfg(test)]
mod tests {
    use super::*;
    use persistence::SavedCellValue;

    #[test]
    fn test_style_mapping_roundtrip() {
        let mut cells = HashMap::new();
        cells.insert(
            (0, 0),
            SavedCell {
                value: SavedCellValue::Text("Header".to_string()),
                formula: None,
                style_index: 3,
                rich_text: None,
                spill: None,
            },
        );
        cells.insert(
            (1, 0),
            SavedCell {
                value: SavedCellValue::Number(100.0),
                formula: None,
                style_index: 0, // Default — should not appear in styles.json
                rich_text: None,
                spill: None,
            },
        );

        let sheet_styles = cells_to_sheet_styles(&cells);
        assert_eq!(sheet_styles.cells.len(), 1);
        assert_eq!(sheet_styles.cells["A1"], 3);

        // Simulate loading: start with style_index=0 from data.json
        let mut loaded_cells = HashMap::new();
        loaded_cells.insert(
            (0, 0),
            SavedCell {
                value: SavedCellValue::Text("Header".to_string()),
                formula: None,
                style_index: 0,
                rich_text: None,
                spill: None,
            },
        );
        loaded_cells.insert(
            (1, 0),
            SavedCell {
                value: SavedCellValue::Number(100.0),
                formula: None,
                style_index: 0,
                rich_text: None,
                spill: None,
            },
        );

        apply_sheet_styles(&mut loaded_cells, &sheet_styles);
        assert_eq!(loaded_cells[&(0, 0)].style_index, 3);
        assert_eq!(loaded_cells[&(1, 0)].style_index, 0);
    }

    /// SAVE/LOAD ROUND TRIP for the vertical-alignment default (Excel parity).
    ///
    /// Two separate claims, because getting one right and the other wrong is
    /// exactly how a default change leaks into files:
    ///
    /// 1. A DEFAULT-ALIGNED CELL PERSISTS AS "NO ALIGNMENT". It keeps style
    ///    index 0 and `cells_to_sheet_styles` omits it from `styles.json`
    ///    entirely, so nothing per-cell is stamped on the way out. That is why
    ///    the parity change is a one-place change and not a migration.
    /// 2. THE REGISTRY'S INDEX 0 -- the one thing that IS written -- comes back
    ///    saying Bottom, and an explicitly-middle style beside it comes back
    ///    saying Middle. If index 0 round-tripped as Middle, every new file
    ///    would freeze the pre-parity default into itself.
    #[test]
    fn default_alignment_persists_as_no_style_and_the_registry_roundtrips_bottom() {
        use engine::style::{StyleRegistry, VerticalAlign};

        let mut registry = StyleRegistry::new();
        let middle_idx =
            registry.get_or_create(CellStyle::new().with_vertical_align(VerticalAlign::Middle));
        assert_ne!(middle_idx, 0);

        // A default-aligned cell and an explicitly-middle one, side by side.
        let mut cells = HashMap::new();
        cells.insert(
            (0, 0),
            SavedCell {
                value: SavedCellValue::Text("default".to_string()),
                formula: None,
                style_index: 0,
                rich_text: None,
                spill: None,
            },
        );
        cells.insert(
            (1, 0),
            SavedCell {
                value: SavedCellValue::Text("explicitly middle".to_string()),
                formula: None,
                style_index: middle_idx,
                rich_text: None,
                spill: None,
            },
        );

        let sheet_styles = cells_to_sheet_styles(&cells);
        assert_eq!(
            sheet_styles.cells.len(),
            1,
            "only the explicitly-aligned cell may be written; a default-aligned \
             cell must persist as NO alignment at all"
        );
        assert!(
            !sheet_styles.cells.contains_key("A1"),
            "the default-aligned cell must not be stamped into styles.json"
        );
        assert_eq!(sheet_styles.cells["A2"], middle_idx);

        // The registry itself is what carries the default's identity.
        let json = serialize_style_registry(registry.all_styles()).unwrap();
        let restored = deserialize_style_registry(&json).unwrap();
        assert_eq!(
            restored[0].vertical_align,
            VerticalAlign::Bottom,
            "style index 0 must reload as Excel's default, Bottom"
        );
        assert_eq!(
            restored[middle_idx].vertical_align,
            VerticalAlign::Middle,
            "an explicitly-middle cell must reload as Middle -- only the DEFAULT moved"
        );
    }

    #[test]
    fn test_style_registry_roundtrip() {
        let mut registry = engine::style::StyleRegistry::new();
        let bold_style = CellStyle::new().with_bold(true);
        registry.get_or_create(bold_style.clone());

        let json = serialize_style_registry(registry.all_styles()).unwrap();
        let restored = deserialize_style_registry(&json).unwrap();

        assert_eq!(restored.len(), 2); // default + bold
        assert_eq!(restored[1], bold_style);
    }

    /// The three style shapes the Home-tab programme added survive .cala
    /// (`styles/registry.json` is a plain serde dump of the engine style):
    /// a half-point and a 409 pt font, stacked text, and an Accounting format
    /// carrying the leading-minus pattern. And a workbook with none of them
    /// writes the SAME bytes it always did -- a whole size is still an
    /// integer -- which is why none of them is linked to the format version
    /// (an older reader refuses a fraction or an unknown variant loudly; it
    /// cannot misread one -- see `FontSize`'s serializer).
    #[test]
    fn half_points_stacked_text_and_minus_accounting_survive_the_registry() {
        use engine::style::{
            CurrencyPosition, FontSize, NegativeStyle, NumberFormat, StyleRegistry, TextRotation,
        };
        let mut registry = StyleRegistry::new();
        let mut half = CellStyle::new();
        half.font.size = FontSize::from_points(10.5).unwrap();
        let mut top = CellStyle::new();
        top.font.size = FontSize::from_whole_points(409);
        let stacked = CellStyle::new().with_text_rotation(TextRotation::Vertical);
        let comma = CellStyle::new().with_number_format(NumberFormat::Accounting {
            decimal_places: 2,
            symbol: String::new(),
            symbol_position: CurrencyPosition::Before,
            negative_style: NegativeStyle::Minus,
        });
        let indices: Vec<usize> = [half, top, stacked, comma]
            .into_iter()
            .map(|s| registry.get_or_create(s))
            .collect();

        let json = serialize_style_registry(registry.all_styles()).unwrap();
        assert!(json.contains("\"size\": 10.5"), "{json}");
        assert!(json.contains("\"size\": 409"), "{json}");
        let restored = deserialize_style_registry(&json).unwrap();
        for i in indices {
            assert_eq!(restored[i], registry.all_styles()[i], "style {i}");
        }

        // An ordinary registry is unchanged on disk: `"size": 11`, no fraction.
        let plain = serialize_style_registry(StyleRegistry::new().all_styles()).unwrap();
        assert!(plain.contains("\"size\": 11,"), "{plain}");
    }
}
