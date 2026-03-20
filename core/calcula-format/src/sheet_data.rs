//! FILENAME: core/calcula-format/src/sheet_data.rs
//! Sparse cell data serialization for sheets.
//!
//! Each sheet's data.json contains only non-empty cells, keyed by A1 reference.
//! Format:
//! ```json
//! {
//!   "cells": {
//!     "A1": { "v": "Hello", "t": "s" },
//!     "B2": { "v": 42.0, "t": "n", "f": "=A2*2" }
//!   }
//! }
//! ```

use crate::cell_ref;
use persistence::{SavedCell, SavedCellValue};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

/// Root structure for a sheet's data.json.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SheetData {
    /// Sparse cell map keyed by A1 reference, sorted for deterministic output.
    pub cells: BTreeMap<String, CellEntry>,
}

/// A single cell entry in the sparse data format.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CellEntry {
    /// Cell value. Type depends on `t` field.
    /// - string for "s", number for "n", bool for "b", null for "x"/"e"
    /// - array for "l", object for "d"
    #[serde(default, skip_serializing_if = "is_null_value")]
    pub v: serde_json::Value,

    /// Type code: "s" string, "n" number, "b" boolean, "e" error, "l" list, "d" dict, "x" empty
    pub t: String,

    /// Formula (without leading =), if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub f: Option<String>,

    /// Error message (only for type "e").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub e: Option<String>,
}

fn is_null_value(v: &serde_json::Value) -> bool {
    v.is_null()
}

/// Convert a HashMap of (row, col) -> SavedCell to SheetData.
pub fn cells_to_sheet_data(cells: &HashMap<(u32, u32), SavedCell>) -> SheetData {
    let mut sorted_cells = BTreeMap::new();

    for ((row, col), cell) in cells {
        // Skip completely empty cells (no value, no formula, default style)
        if matches!(cell.value, SavedCellValue::Empty)
            && cell.formula.is_none()
            && cell.style_index == 0
        {
            continue;
        }

        let key = cell_ref::to_a1(*row, *col);
        let entry = saved_cell_to_entry(cell);
        sorted_cells.insert(key, entry);
    }

    SheetData {
        cells: sorted_cells,
    }
}

/// Convert SheetData back to a HashMap of (row, col) -> SavedCell.
/// Style indices are NOT restored here (they come from styles.json).
pub fn sheet_data_to_cells(data: &SheetData) -> HashMap<(u32, u32), SavedCell> {
    let mut cells = HashMap::new();

    for (key, entry) in &data.cells {
        if let Some((row, col)) = cell_ref::from_a1(key) {
            let cell = entry_to_saved_cell(entry);
            cells.insert((row, col), cell);
        }
    }

    cells
}

fn saved_cell_to_entry(cell: &SavedCell) -> CellEntry {
    let (v, t, e) = saved_value_to_json(&cell.value);

    CellEntry {
        v,
        t,
        f: cell.formula.clone(),
        e,
    }
}

fn saved_value_to_json(value: &SavedCellValue) -> (serde_json::Value, String, Option<String>) {
    match value {
        SavedCellValue::Empty => (serde_json::Value::Null, "x".to_string(), None),
        SavedCellValue::Number(n) => (serde_json::json!(*n), "n".to_string(), None),
        SavedCellValue::Text(s) => (serde_json::json!(s), "s".to_string(), None),
        SavedCellValue::Boolean(b) => (serde_json::json!(*b), "b".to_string(), None),
        SavedCellValue::Error(msg) => {
            (serde_json::Value::Null, "e".to_string(), Some(msg.clone()))
        }
        SavedCellValue::List(items) => {
            let arr: Vec<serde_json::Value> = items.iter().map(saved_value_to_json_value).collect();
            (serde_json::Value::Array(arr), "l".to_string(), None)
        }
        SavedCellValue::Dict(entries) => {
            let obj: serde_json::Map<String, serde_json::Value> = entries
                .iter()
                .map(|(k, v)| (k.clone(), saved_value_to_json_value(v)))
                .collect();
            (serde_json::Value::Object(obj), "d".to_string(), None)
        }
    }
}

fn saved_value_to_json_value(value: &SavedCellValue) -> serde_json::Value {
    match value {
        SavedCellValue::Empty => serde_json::Value::Null,
        SavedCellValue::Number(n) => serde_json::json!(*n),
        SavedCellValue::Text(s) => serde_json::json!(s),
        SavedCellValue::Boolean(b) => serde_json::json!(*b),
        SavedCellValue::Error(msg) => serde_json::json!({ "error": msg }),
        SavedCellValue::List(items) => {
            serde_json::Value::Array(items.iter().map(saved_value_to_json_value).collect())
        }
        SavedCellValue::Dict(entries) => {
            let obj: serde_json::Map<String, serde_json::Value> = entries
                .iter()
                .map(|(k, v)| (k.clone(), saved_value_to_json_value(v)))
                .collect();
            serde_json::Value::Object(obj)
        }
    }
}

fn entry_to_saved_cell(entry: &CellEntry) -> SavedCell {
    let value = json_to_saved_value(&entry.v, &entry.t, &entry.e);

    SavedCell {
        value,
        formula: entry.f.clone(),
        style_index: 0, // Will be set from styles.json
    }
}

fn json_to_saved_value(
    v: &serde_json::Value,
    t: &str,
    e: &Option<String>,
) -> SavedCellValue {
    match t {
        "n" => {
            if let Some(n) = v.as_f64() {
                SavedCellValue::Number(n)
            } else {
                SavedCellValue::Empty
            }
        }
        "s" => {
            if let Some(s) = v.as_str() {
                SavedCellValue::Text(s.to_string())
            } else {
                SavedCellValue::Empty
            }
        }
        "b" => {
            if let Some(b) = v.as_bool() {
                SavedCellValue::Boolean(b)
            } else {
                SavedCellValue::Empty
            }
        }
        "e" => SavedCellValue::Error(e.clone().unwrap_or_default()),
        "l" => {
            if let Some(arr) = v.as_array() {
                SavedCellValue::List(
                    arr.iter()
                        .map(|item| json_value_to_saved_value(item))
                        .collect(),
                )
            } else {
                SavedCellValue::Empty
            }
        }
        "d" => {
            if let Some(obj) = v.as_object() {
                SavedCellValue::Dict(
                    obj.iter()
                        .map(|(k, val)| (k.clone(), json_value_to_saved_value(val)))
                        .collect(),
                )
            } else {
                SavedCellValue::Empty
            }
        }
        _ => SavedCellValue::Empty, // "x" or unknown
    }
}

fn json_value_to_saved_value(v: &serde_json::Value) -> SavedCellValue {
    match v {
        serde_json::Value::Null => SavedCellValue::Empty,
        serde_json::Value::Number(n) => SavedCellValue::Number(n.as_f64().unwrap_or(0.0)),
        serde_json::Value::String(s) => SavedCellValue::Text(s.clone()),
        serde_json::Value::Bool(b) => SavedCellValue::Boolean(*b),
        serde_json::Value::Array(arr) => {
            SavedCellValue::List(arr.iter().map(json_value_to_saved_value).collect())
        }
        serde_json::Value::Object(obj) => {
            // Check if it's an error object
            if let Some(err) = obj.get("error").and_then(|e| e.as_str()) {
                return SavedCellValue::Error(err.to_string());
            }
            SavedCellValue::Dict(
                obj.iter()
                    .map(|(k, val)| (k.clone(), json_value_to_saved_value(val)))
                    .collect(),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_roundtrip_number() {
        let mut cells = HashMap::new();
        cells.insert(
            (0, 0),
            SavedCell {
                value: SavedCellValue::Number(42.5),
                formula: None,
                style_index: 0,
            },
        );
        cells.insert(
            (1, 0),
            SavedCell {
                value: SavedCellValue::Number(0.0),
                formula: Some("=B1*2".to_string()),
                style_index: 1,
            },
        );

        let data = cells_to_sheet_data(&cells);
        assert_eq!(data.cells.len(), 2);
        assert!(data.cells.contains_key("A1"));
        assert!(data.cells.contains_key("A2"));

        let restored = sheet_data_to_cells(&data);
        assert_eq!(restored.len(), 2);
        if let SavedCellValue::Number(n) = &restored[&(0, 0)].value {
            assert_eq!(*n, 42.5);
        } else {
            panic!("Expected number");
        }
        assert_eq!(restored[&(1, 0)].formula, Some("=B1*2".to_string()));
    }

    #[test]
    fn test_skip_empty_cells() {
        let mut cells = HashMap::new();
        cells.insert(
            (0, 0),
            SavedCell {
                value: SavedCellValue::Empty,
                formula: None,
                style_index: 0,
            },
        );
        // Cell with only style should be kept
        cells.insert(
            (1, 0),
            SavedCell {
                value: SavedCellValue::Empty,
                formula: None,
                style_index: 5,
            },
        );

        let data = cells_to_sheet_data(&cells);
        assert_eq!(data.cells.len(), 1); // Only the styled cell
        assert!(data.cells.contains_key("A2"));
    }

    #[test]
    fn test_all_value_types() {
        let mut cells = HashMap::new();
        cells.insert(
            (0, 0),
            SavedCell {
                value: SavedCellValue::Text("hello".to_string()),
                formula: None,
                style_index: 1,
            },
        );
        cells.insert(
            (1, 0),
            SavedCell {
                value: SavedCellValue::Boolean(true),
                formula: None,
                style_index: 1,
            },
        );
        cells.insert(
            (2, 0),
            SavedCell {
                value: SavedCellValue::Error("DIV/0".to_string()),
                formula: None,
                style_index: 1,
            },
        );
        cells.insert(
            (3, 0),
            SavedCell {
                value: SavedCellValue::List(vec![
                    SavedCellValue::Number(1.0),
                    SavedCellValue::Number(2.0),
                ]),
                formula: None,
                style_index: 1,
            },
        );

        let data = cells_to_sheet_data(&cells);
        let json = serde_json::to_string_pretty(&data).unwrap();
        let parsed: SheetData = serde_json::from_str(&json).unwrap();
        let restored = sheet_data_to_cells(&parsed);

        assert_eq!(restored.len(), 4);
        assert!(matches!(restored[&(0, 0)].value, SavedCellValue::Text(_)));
        assert!(matches!(restored[&(1, 0)].value, SavedCellValue::Boolean(true)));
        assert!(matches!(restored[&(2, 0)].value, SavedCellValue::Error(_)));
        assert!(matches!(restored[&(3, 0)].value, SavedCellValue::List(_)));
    }
}
