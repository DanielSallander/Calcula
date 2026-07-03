//! FILENAME: core/calcula-format/src/features/pane_controls.rs
//! Pane control definitions serialization (Controls Pane).
//! Each pane control is stored as pane_controls/control_{id}.json.
//! `config` and `value` are opaque app-owned JSON payloads stored as-is
//! (raw serde_json::Value passthrough — the format never inspects them).

use identity::EntityId;
use persistence::SavedPaneControl;
use serde::{Deserialize, Serialize};

/// JSON-friendly pane control definition that uses camelCase for the .cala format.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneControlDef {
    pub id: EntityId,
    pub name: String,
    /// "button" | "slider" | "dropdown" | "checkbox" | "custom"
    pub control_type: String,
    /// Opaque control configuration (app-owned PaneControlConfig JSON).
    #[serde(default)]
    pub config: serde_json::Value,
    /// Opaque current value (app-owned ControlValue JSON; null when value-less).
    #[serde(default)]
    pub value: serde_json::Value,
    /// Position in the Controls-pane strip. Shares the number space with
    /// ribbon filter `order` (one merged, mixed list).
    #[serde(default)]
    pub order: u32,
}

impl From<&SavedPaneControl> for PaneControlDef {
    fn from(c: &SavedPaneControl) -> Self {
        PaneControlDef {
            id: c.id,
            name: c.name.clone(),
            control_type: c.control_type.clone(),
            config: c.config.clone(),
            value: c.value.clone(),
            order: c.order,
        }
    }
}

impl From<&PaneControlDef> for SavedPaneControl {
    fn from(c: &PaneControlDef) -> Self {
        SavedPaneControl {
            id: c.id,
            name: c.name.clone(),
            control_type: c.control_type.clone(),
            config: c.config.clone(),
            value: c.value.clone(),
            order: c.order,
        }
    }
}
