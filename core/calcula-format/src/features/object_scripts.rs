//! FILENAME: core/calcula-format/src/features/object_scripts.rs
//! Object script definitions serialization for the .cala format.
//! Each object script is stored as object_scripts/script_{id}.json.

use persistence::{SavedObjectScript, ScriptableObjectType, ScriptAccessLevel, ScriptProvenance};
use serde::{Deserialize, Serialize};

/// JSON-friendly object script definition for the .cala format.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectScriptDef {
    pub id: String,
    pub name: String,
    pub object_type: ObjectScriptObjectTypeDef,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    pub source: String,
    #[serde(default)]
    pub access_level: ObjectScriptAccessLevelDef,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Origin of the script: local (default) or distributed via .calp.
    #[serde(default)]
    pub provenance: ObjectScriptProvenanceDef,
    /// For distributed scripts: the source package name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package_name: Option<String>,
    /// The authoritative declared-capability ceiling (R19). Persisted in the
    /// .cala so a distributed script's ceiling survives save/reload without
    /// being re-derived from its (tamperable) source.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub declared_capabilities: Vec<String>,
}

/// Object type in the .cala JSON format.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ObjectScriptObjectTypeDef {
    Workbook,
    Sheet,
    Cell,
    Row,
    Column,
    Slicer,
    Chart,
    Pivot,
    Button,
    Textbox,
    Timeline,
    Shape,
    Table,
    NamedRange,
    Panel,
    Range,
}

/// Access level in the .cala JSON format.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ObjectScriptAccessLevelDef {
    Restricted,
    Unlocked,
}

impl Default for ObjectScriptAccessLevelDef {
    fn default() -> Self {
        ObjectScriptAccessLevelDef::Restricted
    }
}

/// Script provenance in the .cala JSON format.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ObjectScriptProvenanceDef {
    Local,
    Distributed,
}

impl Default for ObjectScriptProvenanceDef {
    fn default() -> Self {
        ObjectScriptProvenanceDef::Local
    }
}

// ============================================================================
// Conversions: SavedObjectScript <-> ObjectScriptDef
// ============================================================================

impl From<&ScriptableObjectType> for ObjectScriptObjectTypeDef {
    fn from(t: &ScriptableObjectType) -> Self {
        match t {
            ScriptableObjectType::Workbook => ObjectScriptObjectTypeDef::Workbook,
            ScriptableObjectType::Sheet => ObjectScriptObjectTypeDef::Sheet,
            ScriptableObjectType::Cell => ObjectScriptObjectTypeDef::Cell,
            ScriptableObjectType::Row => ObjectScriptObjectTypeDef::Row,
            ScriptableObjectType::Column => ObjectScriptObjectTypeDef::Column,
            ScriptableObjectType::Slicer => ObjectScriptObjectTypeDef::Slicer,
            ScriptableObjectType::Chart => ObjectScriptObjectTypeDef::Chart,
            ScriptableObjectType::Pivot => ObjectScriptObjectTypeDef::Pivot,
            ScriptableObjectType::Button => ObjectScriptObjectTypeDef::Button,
            ScriptableObjectType::Textbox => ObjectScriptObjectTypeDef::Textbox,
            ScriptableObjectType::Timeline => ObjectScriptObjectTypeDef::Timeline,
            ScriptableObjectType::Shape => ObjectScriptObjectTypeDef::Shape,
            ScriptableObjectType::Table => ObjectScriptObjectTypeDef::Table,
            ScriptableObjectType::NamedRange => ObjectScriptObjectTypeDef::NamedRange,
            ScriptableObjectType::Panel => ObjectScriptObjectTypeDef::Panel,
            ScriptableObjectType::Range => ObjectScriptObjectTypeDef::Range,
        }
    }
}

impl From<&ObjectScriptObjectTypeDef> for ScriptableObjectType {
    fn from(t: &ObjectScriptObjectTypeDef) -> Self {
        match t {
            ObjectScriptObjectTypeDef::Workbook => ScriptableObjectType::Workbook,
            ObjectScriptObjectTypeDef::Sheet => ScriptableObjectType::Sheet,
            ObjectScriptObjectTypeDef::Cell => ScriptableObjectType::Cell,
            ObjectScriptObjectTypeDef::Row => ScriptableObjectType::Row,
            ObjectScriptObjectTypeDef::Column => ScriptableObjectType::Column,
            ObjectScriptObjectTypeDef::Slicer => ScriptableObjectType::Slicer,
            ObjectScriptObjectTypeDef::Chart => ScriptableObjectType::Chart,
            ObjectScriptObjectTypeDef::Pivot => ScriptableObjectType::Pivot,
            ObjectScriptObjectTypeDef::Button => ScriptableObjectType::Button,
            ObjectScriptObjectTypeDef::Textbox => ScriptableObjectType::Textbox,
            ObjectScriptObjectTypeDef::Timeline => ScriptableObjectType::Timeline,
            ObjectScriptObjectTypeDef::Shape => ScriptableObjectType::Shape,
            ObjectScriptObjectTypeDef::Table => ScriptableObjectType::Table,
            ObjectScriptObjectTypeDef::NamedRange => ScriptableObjectType::NamedRange,
            ObjectScriptObjectTypeDef::Panel => ScriptableObjectType::Panel,
            ObjectScriptObjectTypeDef::Range => ScriptableObjectType::Range,
        }
    }
}

impl From<&ScriptAccessLevel> for ObjectScriptAccessLevelDef {
    fn from(l: &ScriptAccessLevel) -> Self {
        match l {
            ScriptAccessLevel::Restricted => ObjectScriptAccessLevelDef::Restricted,
            ScriptAccessLevel::Unlocked => ObjectScriptAccessLevelDef::Unlocked,
        }
    }
}

impl From<&ObjectScriptAccessLevelDef> for ScriptAccessLevel {
    fn from(l: &ObjectScriptAccessLevelDef) -> Self {
        match l {
            ObjectScriptAccessLevelDef::Restricted => ScriptAccessLevel::Restricted,
            ObjectScriptAccessLevelDef::Unlocked => ScriptAccessLevel::Unlocked,
        }
    }
}

impl From<&ScriptProvenance> for ObjectScriptProvenanceDef {
    fn from(p: &ScriptProvenance) -> Self {
        match p {
            ScriptProvenance::Local => ObjectScriptProvenanceDef::Local,
            ScriptProvenance::Distributed => ObjectScriptProvenanceDef::Distributed,
        }
    }
}

impl From<&ObjectScriptProvenanceDef> for ScriptProvenance {
    fn from(p: &ObjectScriptProvenanceDef) -> Self {
        match p {
            ObjectScriptProvenanceDef::Local => ScriptProvenance::Local,
            ObjectScriptProvenanceDef::Distributed => ScriptProvenance::Distributed,
        }
    }
}

impl From<&SavedObjectScript> for ObjectScriptDef {
    fn from(s: &SavedObjectScript) -> Self {
        ObjectScriptDef {
            id: s.id.clone(),
            name: s.name.clone(),
            object_type: ObjectScriptObjectTypeDef::from(&s.object_type),
            instance_id: s.instance_id.clone(),
            source: s.source.clone(),
            access_level: ObjectScriptAccessLevelDef::from(&s.access_level),
            description: s.description.clone(),
            provenance: ObjectScriptProvenanceDef::from(&s.provenance),
            package_name: s.package_name.clone(),
            declared_capabilities: s.declared_capabilities.clone(),
        }
    }
}

impl From<&ObjectScriptDef> for SavedObjectScript {
    fn from(d: &ObjectScriptDef) -> Self {
        SavedObjectScript {
            id: d.id.clone(),
            name: d.name.clone(),
            object_type: ScriptableObjectType::from(&d.object_type),
            instance_id: d.instance_id.clone(),
            source: d.source.clone(),
            access_level: ScriptAccessLevel::from(&d.access_level),
            description: d.description.clone(),
            provenance: ScriptProvenance::from(&d.provenance),
            package_name: d.package_name.clone(),
            declared_capabilities: d.declared_capabilities.clone(),
        }
    }
}
