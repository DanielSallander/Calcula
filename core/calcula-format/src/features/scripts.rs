//! FILENAME: core/calcula-format/src/features/scripts.rs
//! Script definitions serialization.
//! Each script is stored as scripts/script_{id}.json.

use persistence::{SavedScript, SavedScriptScope};
use serde::{Deserialize, Serialize};

/// Script scope in the .cala JSON format.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ScriptScopeDef {
    Workbook,
    Sheet { name: String },
}

impl Default for ScriptScopeDef {
    fn default() -> Self {
        ScriptScopeDef::Workbook
    }
}

/// JSON-friendly script definition that uses camelCase for the .cala format.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptDef {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub source: String,
    #[serde(default)]
    pub scope: ScriptScopeDef,
}

impl From<&SavedScript> for ScriptDef {
    fn from(s: &SavedScript) -> Self {
        ScriptDef {
            id: s.id.clone(),
            name: s.name.clone(),
            description: s.description.clone(),
            source: s.source.clone(),
            scope: match &s.scope {
                SavedScriptScope::Workbook => ScriptScopeDef::Workbook,
                SavedScriptScope::Sheet { name } => ScriptScopeDef::Sheet { name: name.clone() },
            },
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
            scope: match &d.scope {
                ScriptScopeDef::Workbook => SavedScriptScope::Workbook,
                ScriptScopeDef::Sheet { name } => SavedScriptScope::Sheet { name: name.clone() },
            },
        }
    }
}
