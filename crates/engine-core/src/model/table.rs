//! Table definition for the data model.

use arrow::datatypes::{Field, Schema};
use serde::{Deserialize, Serialize};

use crate::error::{EngineError, EngineResult};
use crate::model::column::Column;

/// Controls how table data is sourced at query time.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StorageMode {
    /// Data is fetched from the source connector on every query (default).
    #[default]
    DirectQuery,
    /// Data is pre-loaded into memory and served from cache.
    InMemory,
}

impl StorageMode {
    /// Returns `true` if the storage mode is `DirectQuery`.
    fn is_direct_query(&self) -> bool {
        *self == Self::DirectQuery
    }
}

/// A table definition: a named collection of typed columns.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Table {
    name: String,
    columns: Vec<Column>,
    #[serde(default, skip_serializing_if = "StorageMode::is_direct_query")]
    storage_mode: StorageMode,
}

impl Table {
    /// Create a new table with the given name and columns.
    ///
    /// Returns an error if column names are not unique.
    pub fn new(name: impl Into<String>, columns: Vec<Column>) -> EngineResult<Self> {
        let name = name.into();
        // Validate uniqueness of column names.
        let mut seen = std::collections::HashSet::new();
        for col in &columns {
            if !seen.insert(col.name()) {
                return Err(EngineError::DuplicateName(format!(
                    "Duplicate column '{}' in table '{}'",
                    col.name(),
                    name
                )));
            }
        }
        Ok(Self {
            name,
            columns,
            storage_mode: StorageMode::default(),
        })
    }

    /// Returns the table name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the columns in this table.
    pub fn columns(&self) -> &[Column] {
        &self.columns
    }

    /// Look up a column by name.
    pub fn column(&self, name: &str) -> EngineResult<&Column> {
        self.columns
            .iter()
            .find(|c| c.name() == name)
            .ok_or_else(|| EngineError::ColumnNotFound {
                table: self.name.clone(),
                column: name.to_string(),
            })
    }

    /// Convert this table definition to an Arrow schema.
    pub fn to_arrow_schema(&self) -> Schema {
        let fields: Vec<Field> = self
            .columns
            .iter()
            .map(|col| Field::new(col.name(), col.data_type().to_arrow(), col.nullable()))
            .collect();
        Schema::new(fields)
    }

    /// Set the storage mode for this table.
    pub fn with_storage_mode(mut self, mode: StorageMode) -> Self {
        self.storage_mode = mode;
        self
    }

    /// Returns the storage mode for this table.
    pub fn storage_mode(&self) -> &StorageMode {
        &self.storage_mode
    }

    /// Returns `true` if this table uses in-memory storage.
    pub fn is_in_memory(&self) -> bool {
        self.storage_mode == StorageMode::InMemory
    }
}
