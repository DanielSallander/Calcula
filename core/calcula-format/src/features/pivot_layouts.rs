//! FILENAME: core/calcula-format/src/features/pivot_layouts.rs
//! Pivot layout definitions serialization.
//! Each layout is stored as pivot_layouts/layout_{id}.json.

use persistence::SavedPivotLayout;
use serde::{Deserialize, Serialize};

/// JSON-friendly pivot layout definition that uses camelCase for the .cala format.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PivotLayoutDef {
    pub id: u64,
    pub name: String,
    pub dsl_text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub source_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_table_name: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub source_bi_tables: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub source_bi_measures: Vec<String>,
    pub created_at: f64,
    pub updated_at: f64,
}

impl From<&SavedPivotLayout> for PivotLayoutDef {
    fn from(s: &SavedPivotLayout) -> Self {
        PivotLayoutDef {
            id: s.id,
            name: s.name.clone(),
            dsl_text: s.dsl_text.clone(),
            description: s.description.clone(),
            source_type: s.source_type.clone(),
            source_table_name: s.source_table_name.clone(),
            source_bi_tables: s.source_bi_tables.clone(),
            source_bi_measures: s.source_bi_measures.clone(),
            created_at: s.created_at,
            updated_at: s.updated_at,
        }
    }
}

impl From<&PivotLayoutDef> for SavedPivotLayout {
    fn from(d: &PivotLayoutDef) -> Self {
        SavedPivotLayout {
            id: d.id,
            name: d.name.clone(),
            dsl_text: d.dsl_text.clone(),
            description: d.description.clone(),
            source_type: d.source_type.clone(),
            source_table_name: d.source_table_name.clone(),
            source_bi_tables: d.source_bi_tables.clone(),
            source_bi_measures: d.source_bi_measures.clone(),
            created_at: d.created_at,
            updated_at: d.updated_at,
        }
    }
}
