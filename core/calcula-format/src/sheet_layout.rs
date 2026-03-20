//! FILENAME: core/calcula-format/src/sheet_layout.rs
//! Sheet layout: column widths, row heights, and other spatial configuration.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

/// Layout data for a single sheet (layout.json).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetLayout {
    /// Column widths keyed by column index (only non-default widths).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub column_widths: BTreeMap<u32, f64>,

    /// Row heights keyed by row index (only non-default heights).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub row_heights: BTreeMap<u32, f64>,
}

impl SheetLayout {
    /// Create from HashMap-based dimension data.
    pub fn from_dimensions(
        column_widths: &HashMap<u32, f64>,
        row_heights: &HashMap<u32, f64>,
    ) -> Self {
        SheetLayout {
            column_widths: column_widths.iter().map(|(&k, &v)| (k, v)).collect(),
            row_heights: row_heights.iter().map(|(&k, &v)| (k, v)).collect(),
        }
    }

    /// Convert back to HashMap-based dimension data.
    pub fn to_dimensions(&self) -> (HashMap<u32, f64>, HashMap<u32, f64>) {
        let col_widths = self.column_widths.iter().map(|(&k, &v)| (k, v)).collect();
        let row_heights = self.row_heights.iter().map(|(&k, &v)| (k, v)).collect();
        (col_widths, row_heights)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_layout_roundtrip() {
        let mut col_widths = HashMap::new();
        col_widths.insert(0, 120.0);
        col_widths.insert(5, 200.0);

        let mut row_heights = HashMap::new();
        row_heights.insert(0, 30.0);

        let layout = SheetLayout::from_dimensions(&col_widths, &row_heights);
        let json = serde_json::to_string_pretty(&layout).unwrap();
        let parsed: SheetLayout = serde_json::from_str(&json).unwrap();
        let (restored_cw, restored_rh) = parsed.to_dimensions();

        assert_eq!(restored_cw.len(), 2);
        assert_eq!(restored_cw[&0], 120.0);
        assert_eq!(restored_cw[&5], 200.0);
        assert_eq!(restored_rh.len(), 1);
        assert_eq!(restored_rh[&0], 30.0);
    }

    #[test]
    fn test_empty_layout() {
        let layout = SheetLayout::from_dimensions(&HashMap::new(), &HashMap::new());
        let json = serde_json::to_string(&layout).unwrap();
        // Empty maps should be omitted
        assert!(!json.contains("columnWidths"));
        assert!(!json.contains("rowHeights"));
    }
}
