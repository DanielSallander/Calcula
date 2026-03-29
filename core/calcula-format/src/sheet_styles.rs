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

/// Deserialize a style registry from JSON.
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
            },
        );
        cells.insert(
            (1, 0),
            SavedCell {
                value: SavedCellValue::Number(100.0),
                formula: None,
                style_index: 0, // Default — should not appear in styles.json
                rich_text: None,
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
            },
        );
        loaded_cells.insert(
            (1, 0),
            SavedCell {
                value: SavedCellValue::Number(100.0),
                formula: None,
                style_index: 0,
                rich_text: None,
            },
        );

        apply_sheet_styles(&mut loaded_cells, &sheet_styles);
        assert_eq!(loaded_cells[&(0, 0)].style_index, 3);
        assert_eq!(loaded_cells[&(1, 0)].style_index, 0);
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
}
