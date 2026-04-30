//! Table definition for the data model.

use std::hash::{Hash, Hasher};

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
    /// Optional TTL for in-memory tables: if the cached data is older than this
    /// many seconds, it is considered stale and eligible for automatic refresh.
    /// Only meaningful when `storage_mode` is `InMemory`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    refresh_interval_secs: Option<u64>,
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
            refresh_interval_secs: None,
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

    /// Set the refresh interval (TTL) for this in-memory table.
    ///
    /// When set, the table's cached data is considered stale after this duration.
    /// Only meaningful when `storage_mode` is `InMemory`.
    pub fn with_refresh_interval(mut self, interval: std::time::Duration) -> Self {
        self.refresh_interval_secs = Some(interval.as_secs());
        self
    }

    /// Returns the configured refresh interval as a `Duration`, if set.
    pub fn refresh_interval(&self) -> Option<std::time::Duration> {
        self.refresh_interval_secs
            .map(std::time::Duration::from_secs)
    }

    /// Compute a deterministic hash of this table's schema (column names,
    /// types, and nullability in order).
    ///
    /// Used to detect whether cached data on disk is still compatible with the
    /// current model. A different hash means the schema has changed and the
    /// cached data should be discarded.
    pub fn schema_hash(&self) -> String {
        use std::collections::hash_map::DefaultHasher;

        let mut hasher = DefaultHasher::new();
        for col in &self.columns {
            col.name().hash(&mut hasher);
            // Hash the debug representation of DataType which uniquely
            // identifies each variant including Decimal(p, s).
            format!("{:?}", col.data_type()).hash(&mut hasher);
            col.nullable().hash(&mut hasher);
        }
        format!("{:016x}", hasher.finish())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::DataType;
    use std::time::Duration;

    fn make_table(name: &str) -> Table {
        Table::new(name, vec![Column::new("id", DataType::Int64)]).unwrap()
    }

    #[test]
    fn refresh_interval_default_is_none() {
        let table = make_table("t");
        assert!(table.refresh_interval().is_none());
    }

    #[test]
    fn with_refresh_interval_sets_duration() {
        let table = make_table("t").with_refresh_interval(Duration::from_secs(300));
        assert_eq!(table.refresh_interval(), Some(Duration::from_secs(300)));
    }

    #[test]
    fn refresh_interval_serialization_roundtrip() {
        let table = make_table("t")
            .with_storage_mode(StorageMode::InMemory)
            .with_refresh_interval(Duration::from_secs(600));

        let json = serde_json::to_string(&table).unwrap();
        assert!(json.contains("\"refresh_interval_secs\":600"));

        let deserialized: Table = serde_json::from_str(&json).unwrap();
        assert_eq!(
            deserialized.refresh_interval(),
            Some(Duration::from_secs(600))
        );
    }

    #[test]
    fn refresh_interval_not_serialized_when_none() {
        let table = make_table("t").with_storage_mode(StorageMode::InMemory);
        let json = serde_json::to_string(&table).unwrap();
        assert!(!json.contains("refresh_interval"));
    }

    #[test]
    fn backward_compatible_deserialization() {
        // Old JSON without refresh_interval_secs should deserialize fine.
        let json = r#"{"name":"t","columns":[{"name":"id","data_type":"Int64","nullable":true}],"storage_mode":"in_memory"}"#;
        let table: Table = serde_json::from_str(json).unwrap();
        assert!(table.is_in_memory());
        assert!(table.refresh_interval().is_none());
    }

    #[test]
    fn schema_hash_deterministic() {
        let t1 = make_table("t");
        let t2 = make_table("t");
        assert_eq!(t1.schema_hash(), t2.schema_hash());
    }

    #[test]
    fn schema_hash_differs_on_column_name_change() {
        let t1 = Table::new("t", vec![Column::new("id", DataType::Int64)]).unwrap();
        let t2 = Table::new("t", vec![Column::new("key", DataType::Int64)]).unwrap();
        assert_ne!(t1.schema_hash(), t2.schema_hash());
    }

    #[test]
    fn schema_hash_differs_on_type_change() {
        let t1 = Table::new("t", vec![Column::new("id", DataType::Int64)]).unwrap();
        let t2 = Table::new("t", vec![Column::new("id", DataType::Int32)]).unwrap();
        assert_ne!(t1.schema_hash(), t2.schema_hash());
    }

    #[test]
    fn schema_hash_differs_on_nullable_change() {
        let t1 = Table::new("t", vec![Column::new("id", DataType::Int64)]).unwrap();
        let t2 = Table::new("t", vec![Column::non_nullable("id", DataType::Int64)]).unwrap();
        assert_ne!(t1.schema_hash(), t2.schema_hash());
    }

    #[test]
    fn schema_hash_differs_on_column_order() {
        let t1 = Table::new(
            "t",
            vec![
                Column::new("a", DataType::Int64),
                Column::new("b", DataType::String),
            ],
        )
        .unwrap();
        let t2 = Table::new(
            "t",
            vec![
                Column::new("b", DataType::String),
                Column::new("a", DataType::Int64),
            ],
        )
        .unwrap();
        assert_ne!(t1.schema_hash(), t2.schema_hash());
    }

    #[test]
    fn schema_hash_differs_on_column_added() {
        let t1 = Table::new("t", vec![Column::new("id", DataType::Int64)]).unwrap();
        let t2 = Table::new(
            "t",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("name", DataType::String),
            ],
        )
        .unwrap();
        assert_ne!(t1.schema_hash(), t2.schema_hash());
    }

    #[test]
    fn schema_hash_ignores_table_name() {
        let t1 = Table::new("foo", vec![Column::new("id", DataType::Int64)]).unwrap();
        let t2 = Table::new("bar", vec![Column::new("id", DataType::Int64)]).unwrap();
        // Same columns → same schema hash (table name is not part of schema).
        assert_eq!(t1.schema_hash(), t2.schema_hash());
    }
}
