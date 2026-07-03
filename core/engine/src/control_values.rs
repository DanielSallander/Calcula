//! FILENAME: core/engine/src/control_values.rs
//! PURPOSE: The engine-owned value model for named UI controls.
//! CONTEXT: GET.CONTROLVALUE("name") reads the current value of a named UI
//! control (pane control, ribbon filter, or named on-grid control). The app
//! layer snapshots every named control into a `HashMap<String, ControlValue>`
//! (keys UPPERCASED) and attaches it to `EvalContext.control_values` before a
//! recalc; the evaluator resolves lookups against that map synchronously.
//!
//! The enum is deliberately minimal: it models what a control can PUBLISH,
//! not what a control IS (configs live in the app layer's pane_control types).
//! - Slider            -> Number
//! - Dropdown          -> Text
//! - Checkbox          -> Boolean
//! - Ribbon filter     -> Text ("(All)" / single selection) or TextList
//!                        (multi selection; spills vertically in the grid)
//! - Custom scripted   -> whatever the script sets

use serde::{Deserialize, Serialize};

/// The published value of a named UI control.
///
/// Serialized for IPC with an adjacently-tagged representation, e.g.
/// `{ "kind": "number", "value": 42.0 }` or
/// `{ "kind": "textList", "value": ["A", "B"] }` — matching the cube module's
/// `CubeCallResult` wire style.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum ControlValue {
    /// A numeric value (e.g. a slider position).
    Number(f64),
    /// A text value (e.g. a dropdown selection, a single-select filter item).
    Text(String),
    /// A boolean value (e.g. a checkbox).
    Boolean(bool),
    /// Multiple text values (e.g. a multi-select ribbon filter). GET.CONTROLVALUE
    /// returns a vertical spill for 2+ items, the single Text for exactly 1,
    /// and #N/A for 0.
    TextList(Vec<String>),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_value_serde_round_trip() {
        let values = vec![
            ControlValue::Number(42.5),
            ControlValue::Text("North".to_string()),
            ControlValue::Boolean(true),
            ControlValue::TextList(vec!["A".to_string(), "B".to_string()]),
        ];
        for v in values {
            let json = serde_json::to_string(&v).unwrap();
            let back: ControlValue = serde_json::from_str(&json).unwrap();
            assert_eq!(back, v);
        }
    }

    #[test]
    fn control_value_wire_format_is_adjacently_tagged_camel_case() {
        let json = serde_json::to_string(&ControlValue::Number(1.0)).unwrap();
        assert_eq!(json, r#"{"kind":"number","value":1.0}"#);
        let json = serde_json::to_string(&ControlValue::TextList(vec!["x".to_string()])).unwrap();
        assert_eq!(json, r#"{"kind":"textList","value":["x"]}"#);
        let json = serde_json::to_string(&ControlValue::Boolean(false)).unwrap();
        assert_eq!(json, r#"{"kind":"boolean","value":false}"#);
        let json = serde_json::to_string(&ControlValue::Text("hi".to_string())).unwrap();
        assert_eq!(json, r#"{"kind":"text","value":"hi"}"#);
    }
}
