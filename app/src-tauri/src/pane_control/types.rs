//! FILENAME: app/src-tauri/src/pane_control/types.rs
//! PURPOSE: Type definitions for Pane Controls (Controls pane).
//! CONTEXT: A pane control is a named, pane-hosted UI control (button, slider,
//!          dropdown, checkbox, or custom scripted control). Its published
//!          value (engine::ControlValue) is what GET.CONTROLVALUE("name")
//!          returns. Mirrors ribbon_filter/types.rs structurally; the two
//!          entity families share the Controls-pane strip (merged `order`
//!          number space) but are otherwise independent.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

// ============================================================================
// ENUMS
// ============================================================================

/// The kind of pane control. Determines which `PaneControlConfig` variant is
/// expected and what value type the control publishes:
/// Button -> no value, Slider -> Number, Dropdown -> Text,
/// Checkbox -> Boolean, Custom -> script-defined.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PaneControlType {
    Button,
    Slider,
    Dropdown,
    Checkbox,
    Custom,
}

impl PaneControlType {
    /// Stable string form used by `persistence::SavedPaneControl.control_type`
    /// (matches the serde camelCase wire form).
    pub fn as_type_str(&self) -> &'static str {
        match self {
            PaneControlType::Button => "button",
            PaneControlType::Slider => "slider",
            PaneControlType::Dropdown => "dropdown",
            PaneControlType::Checkbox => "checkbox",
            PaneControlType::Custom => "custom",
        }
    }

    /// Inverse of `as_type_str`. None for an unknown string — loaders skip the
    /// control (with a warning) rather than failing the whole load.
    pub fn from_type_str(s: &str) -> Option<Self> {
        match s {
            "button" => Some(PaneControlType::Button),
            "slider" => Some(PaneControlType::Slider),
            "dropdown" => Some(PaneControlType::Dropdown),
            "checkbox" => Some(PaneControlType::Checkbox),
            "custom" => Some(PaneControlType::Custom),
            _ => None,
        }
    }
}

/// Where a dropdown pane control gets its item list (v1: static list or a
/// cell range; model-column sources are what a Filter item is for).
/// NOTE: For internally-tagged enums, rename_all on the enum only renames
/// variant tags. Each struct variant needs its own rename_all for field names
/// (precedent: FillData in api_types.rs).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum DropdownSource {
    /// A fixed list of items authored in the control's config.
    #[serde(rename_all = "camelCase")]
    Static { items: Vec<String> },
    /// Items read from a cell range, e.g. "Sheet1!A1:A10" (frontend reads the
    /// range via the grid API and refreshes on grid changes).
    #[serde(rename_all = "camelCase")]
    CellRange { reference: String },
}

/// An optional chart-parameter binding: value changes (including transient
/// drag frames, frontend-side) drive the chart param via @api/chartParams.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartParamTarget {
    pub chart_id: String,
    pub param: String,
}

/// Per-type configuration for a pane control. Internally tagged on "type"
/// so the frontend can discriminate: `{ "type": "slider", "min": 0, ... }`.
/// NOTE: For internally-tagged enums, rename_all on the enum only renames
/// variant tags. Each struct variant needs its own rename_all for field names
/// (precedent: FillData in api_types.rs) — e.g. show_value -> "showValue".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum PaneControlConfig {
    /// A clickable button (value-less; click behavior comes from an
    /// objectType "button" object script, consent-gated — never inline code).
    #[serde(rename_all = "camelCase")]
    Button { label: String },
    /// A numeric slider.
    #[serde(rename_all = "camelCase")]
    Slider {
        min: f64,
        max: f64,
        step: f64,
        show_value: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        chart_param_target: Option<ChartParamTarget>,
    },
    /// A single-select dropdown.
    #[serde(rename_all = "camelCase")]
    Dropdown {
        source: DropdownSource,
        placeholder: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        chart_param_target: Option<ChartParamTarget>,
    },
    /// A boolean checkbox.
    #[serde(rename_all = "camelCase")]
    Checkbox { label: String },
    /// A custom scripted control (shape object script hosted in the pane).
    /// `properties` are the initial declared properties; the script itself is
    /// a normal ObjectScriptDefinition (instanceId "pane-" + control id) and
    /// lives in the object-script store, NOT here (no inline code by design).
    #[serde(rename_all = "camelCase")]
    Custom { properties: HashMap<String, String> },
}

// ============================================================================
// PANE CONTROL DEFINITION
// ============================================================================

/// A pane control — a named control card in the Controls pane.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneControl {
    /// Unique control ID
    pub id: identity::EntityId,
    /// Display name. Unique CASE-INSENSITIVELY across pane controls AND
    /// ribbon filters (GET.CONTROLVALUE resolves by uppercased name).
    pub name: String,
    /// The control kind (matches the `config` variant).
    pub control_type: PaneControlType,
    /// Per-type configuration.
    pub config: PaneControlConfig,
    /// The control's current published value. None for value-less controls
    /// (buttons) or controls that have not published a value yet — those are
    /// simply absent from the GET.CONTROLVALUE snapshot map.
    pub value: Option<engine::ControlValue>,
    /// Position in the Controls-pane strip. Shares the number space with
    /// `RibbonFilter.order` (the frontend merge-sorts both lists).
    #[serde(default)]
    pub order: u32,
}

// ============================================================================
// COMMAND PARAMS
// ============================================================================

/// Parameters for creating a new pane control.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePaneControlParams {
    pub name: String,
    pub control_type: PaneControlType,
    pub config: PaneControlConfig,
    /// Optional initial value (e.g. a checkbox starting checked).
    #[serde(default)]
    pub value: Option<engine::ControlValue>,
    /// Explicit strip position; when None the control is appended after every
    /// existing pane control AND ribbon filter (max order + 1).
    pub order: Option<u32>,
}

/// Parameters for updating pane control properties (all optional; value
/// changes go through the dedicated set_pane_control_value command).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePaneControlParams {
    pub name: Option<String>,
    pub config: Option<PaneControlConfig>,
    pub order: Option<u32>,
}

// ============================================================================
// APPLICATION STATE
// ============================================================================

/// Pane control state managed by Tauri.
///
/// LOCK ORDER: when both families are needed, take `PaneControlState.controls`
/// BEFORE `RibbonFilterState.filters`, and NEVER hold either while acquiring
/// the grid locks (`AppState.grids` / `AppState.grid`) — extract plain data
/// first, drop, then read grids (convention per resolve_control_properties).
pub struct PaneControlState {
    /// All pane controls: id -> PaneControl
    pub controls: Mutex<HashMap<identity::EntityId, PaneControl>>,
}

impl PaneControlState {
    pub fn new() -> Self {
        Self {
            controls: Mutex::new(HashMap::new()),
        }
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// The camelCase IPC contract: struct-variant fields of internally-tagged
    /// enums must serialize camelCase (per-variant rename_all — enum-level
    /// rename_all only covers the variant tag).
    #[test]
    fn slider_config_round_trips_with_camel_case_fields() {
        let config = PaneControlConfig::Slider {
            min: 0.0,
            max: 100.0,
            step: 1.0,
            show_value: true,
            chart_param_target: None,
        };

        let json = serde_json::to_string(&config).unwrap();
        assert!(
            json.contains("\"showValue\""),
            "Slider must serialize show_value as showValue, got: {}",
            json
        );
        assert!(
            !json.contains("show_value"),
            "snake_case field leaked into the IPC JSON: {}",
            json
        );
        assert!(json.contains("\"type\":\"slider\""), "variant tag must stay camelCase: {}", json);

        // Round-trip through our own serialization...
        let back: PaneControlConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back, config);

        // ...and the exact frontend wire form must deserialize (the probe
        // from the review finding). chartParamTarget is optional: absent on
        // the wire => None (old saves keep loading).
        let from_frontend: PaneControlConfig = serde_json::from_str(
            r#"{"type":"slider","min":0.0,"max":100.0,"step":1.0,"showValue":true}"#,
        )
        .unwrap();
        assert_eq!(from_frontend, config);

        // The chart-param binding rides camelCase and round-trips.
        let bound = PaneControlConfig::Slider {
            min: 0.0,
            max: 1.0,
            step: 0.1,
            show_value: false,
            chart_param_target: Some(ChartParamTarget {
                chart_id: "chart-1".to_string(),
                param: "Threshold".to_string(),
            }),
        };
        let json = serde_json::to_string(&bound).unwrap();
        assert!(json.contains("\"chartParamTarget\""), "got: {}", json);
        assert!(json.contains("\"chartId\""), "got: {}", json);
        assert!(!json.contains("chart_param_target"), "snake_case leaked: {}", json);
        let back: PaneControlConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back, bound);
    }

    #[test]
    fn dropdown_source_round_trips_with_camel_case_tags() {
        let cell_range = DropdownSource::CellRange {
            reference: "Sheet1!A1:A10".to_string(),
        };
        let json = serde_json::to_string(&cell_range).unwrap();
        assert!(
            json.contains("\"type\":\"cellRange\""),
            "CellRange tag must be camelCase: {}",
            json
        );
        assert!(json.contains("\"reference\""), "field name must survive: {}", json);
        let back: DropdownSource = serde_json::from_str(&json).unwrap();
        assert_eq!(back, cell_range);

        let config = PaneControlConfig::Dropdown {
            source: DropdownSource::Static {
                items: vec!["North".to_string(), "South".to_string()],
            },
            placeholder: Some("Pick a region".to_string()),
            chart_param_target: None,
        };
        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("\"type\":\"dropdown\""), "got: {}", json);
        assert!(json.contains("\"type\":\"static\""), "nested source tag must be camelCase: {}", json);
        let back: PaneControlConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back, config);
    }

    #[test]
    fn control_type_wire_form_matches_as_type_str() {
        for (variant, expected) in [
            (PaneControlType::Button, "button"),
            (PaneControlType::Slider, "slider"),
            (PaneControlType::Dropdown, "dropdown"),
            (PaneControlType::Checkbox, "checkbox"),
            (PaneControlType::Custom, "custom"),
        ] {
            let json = serde_json::to_string(&variant).unwrap();
            assert_eq!(json, format!("\"{}\"", expected));
            assert_eq!(variant.as_type_str(), expected);
            assert_eq!(PaneControlType::from_type_str(expected), Some(variant));
        }
    }
}
