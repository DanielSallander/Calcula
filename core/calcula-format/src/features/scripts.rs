//! FILENAME: core/calcula-format/src/features/scripts.rs
//! Script definitions serialization.
//! Each script is stored as scripts/script_{id}.json.

use persistence::{SavedScript};
use serde::{Deserialize, Serialize};

/// JSON-friendly script definition that uses camelCase for the .cala format.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptDef {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub source: String,
}

impl From<&SavedScript> for ScriptDef {
    fn from(s: &SavedScript) -> Self {
        ScriptDef {
            id: s.id.clone(),
            name: s.name.clone(),
            description: s.description.clone(),
            source: s.source.clone(),
        }
    }
}

impl From<&ScriptDef> for SavedScript {
    fn from(d: &ScriptDef) -> Self {
        SavedScript {
            id: d.id.clone(),
            name: d.name.clone(),
            description: d.description.clone(),
            source: d.source.clone(),
        }
    }
}
