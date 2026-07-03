//! FILENAME: core/calcula-format/src/features/notebooks.rs
//! Notebook definitions serialization.
//! Each notebook is stored as notebooks/notebook_{id}.json.

use persistence::{SavedNotebook, SavedNotebookCell, SavedNotebookOutputItem};
use serde::{Deserialize, Serialize};

/// JSON-friendly notebook definition that uses camelCase for the .cala format.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookDef {
    pub id: String,
    pub name: String,
    pub cells: Vec<NotebookCellDef>,
    /// .calp distribution provenance (C8). None = local. See
    /// persistence::SavedNotebook::source_package.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_package: Option<String>,
}

/// JSON-friendly notebook cell definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookCellDef {
    pub id: String,
    pub source: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub last_output: Vec<NotebookOutputItemDef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default)]
    pub cells_modified: u32,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_index: Option<u32>,
}

/// JSON-friendly structured output item (mirror of
/// persistence::SavedNotebookOutputItem, same serde representation).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum NotebookOutputItemDef {
    #[serde(rename_all = "camelCase")]
    Text { text: String },
    #[serde(rename_all = "camelCase")]
    Table {
        columns: Vec<String>,
        rows: Vec<Vec<String>>,
        truncated: bool,
        total_rows: usize,
    },
}

impl From<&SavedNotebookOutputItem> for NotebookOutputItemDef {
    fn from(i: &SavedNotebookOutputItem) -> Self {
        match i {
            SavedNotebookOutputItem::Text { text } => {
                NotebookOutputItemDef::Text { text: text.clone() }
            }
            SavedNotebookOutputItem::Table {
                columns,
                rows,
                truncated,
                total_rows,
            } => NotebookOutputItemDef::Table {
                columns: columns.clone(),
                rows: rows.clone(),
                truncated: *truncated,
                total_rows: *total_rows,
            },
        }
    }
}

impl From<&NotebookOutputItemDef> for SavedNotebookOutputItem {
    fn from(i: &NotebookOutputItemDef) -> Self {
        match i {
            NotebookOutputItemDef::Text { text } => {
                SavedNotebookOutputItem::Text { text: text.clone() }
            }
            NotebookOutputItemDef::Table {
                columns,
                rows,
                truncated,
                total_rows,
            } => SavedNotebookOutputItem::Table {
                columns: columns.clone(),
                rows: rows.clone(),
                truncated: *truncated,
                total_rows: *total_rows,
            },
        }
    }
}

impl From<&SavedNotebook> for NotebookDef {
    fn from(n: &SavedNotebook) -> Self {
        NotebookDef {
            id: n.id.clone(),
            name: n.name.clone(),
            cells: n.cells.iter().map(NotebookCellDef::from).collect(),
            source_package: n.source_package.clone(),
        }
    }
}

impl From<&SavedNotebookCell> for NotebookCellDef {
    fn from(c: &SavedNotebookCell) -> Self {
        NotebookCellDef {
            id: c.id.clone(),
            source: c.source.clone(),
            last_output: c.last_output.iter().map(NotebookOutputItemDef::from).collect(),
            last_error: c.last_error.clone(),
            cells_modified: c.cells_modified,
            duration_ms: c.duration_ms,
            execution_index: c.execution_index,
        }
    }
}

impl From<&NotebookDef> for SavedNotebook {
    fn from(d: &NotebookDef) -> Self {
        SavedNotebook {
            id: d.id.clone(),
            name: d.name.clone(),
            cells: d.cells.iter().map(SavedNotebookCell::from).collect(),
            source_package: d.source_package.clone(),
        }
    }
}

impl From<&NotebookCellDef> for SavedNotebookCell {
    fn from(d: &NotebookCellDef) -> Self {
        SavedNotebookCell {
            id: d.id.clone(),
            source: d.source.clone(),
            last_output: d.last_output.iter().map(SavedNotebookOutputItem::from).collect(),
            last_error: d.last_error.clone(),
            cells_modified: d.cells_modified,
            duration_ms: d.duration_ms,
            execution_index: d.execution_index,
        }
    }
}
