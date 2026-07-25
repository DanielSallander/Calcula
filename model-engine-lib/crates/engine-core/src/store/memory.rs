//! In-memory Arrow-backed columnar storage.

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{
    ArrayRef, BooleanBuilder, Date32Builder, Decimal128Builder, Float64Builder, Int32Builder,
    Int64Builder, StringBuilder, TimestampMicrosecondBuilder,
};
use arrow::datatypes::Schema;
use arrow::record_batch::RecordBatch;

use crate::error::{EngineError, EngineResult};
use crate::model::table::Table;
use crate::types::{DataType, Value};

/// Arrow-backed columnar storage for a single table.
///
/// Data is accumulated via [`insert_rows`](Self::insert_rows) and materialized
/// into an Arrow `RecordBatch` via [`to_record_batch`](Self::to_record_batch).
#[derive(Debug)]
pub struct TableData {
    table: Table,
    /// Each inner Vec stores the values for one column, in row order.
    columns: Vec<Vec<Value>>,
    row_count: usize,
}

impl TableData {
    /// Create empty storage for the given table definition.
    pub fn new(table: Table) -> Self {
        let num_cols = table.columns().len();
        Self {
            table,
            columns: vec![Vec::new(); num_cols],
            row_count: 0,
        }
    }

    /// Returns the table definition.
    pub fn table(&self) -> &Table {
        &self.table
    }

    /// Returns the number of rows stored.
    pub fn row_count(&self) -> usize {
        self.row_count
    }

    /// Insert one or more rows of data.
    ///
    /// Each inner `Vec<Value>` is one row, with values corresponding to the
    /// table's columns in order.
    pub fn insert_rows(&mut self, rows: Vec<Vec<Value>>) -> EngineResult<()> {
        let expected_cols = self.table.columns().len();
        for (i, row) in rows.iter().enumerate() {
            if row.len() != expected_cols {
                return Err(EngineError::InvalidData(format!(
                    "Row {} has {} values, expected {}",
                    i,
                    row.len(),
                    expected_cols
                )));
            }
            // Validate types for non-null values.
            for (j, value) in row.iter().enumerate() {
                if !value.is_null() {
                    validate_value_type(value, self.table.columns()[j].data_type())?;
                }
            }
        }

        for row in rows {
            for (col_idx, value) in row.into_iter().enumerate() {
                self.columns[col_idx].push(value);
            }
            self.row_count += 1;
        }
        Ok(())
    }

    /// Build an Arrow `RecordBatch` from the stored data.
    pub fn to_record_batch(&self) -> EngineResult<RecordBatch> {
        let schema = Arc::new(self.table.to_arrow_schema());
        let arrays = self.build_arrays()?;
        let batch = RecordBatch::try_new(schema, arrays)?;
        Ok(batch)
    }

    /// Returns the Arrow schema for this table.
    pub fn arrow_schema(&self) -> Schema {
        self.table.to_arrow_schema()
    }

    fn build_arrays(&self) -> EngineResult<Vec<ArrayRef>> {
        let mut arrays: Vec<ArrayRef> = Vec::with_capacity(self.table.columns().len());

        for (col_idx, col_def) in self.table.columns().iter().enumerate() {
            let values = &self.columns[col_idx];
            let array = build_arrow_array(values, col_def.data_type())?;
            arrays.push(array);
        }

        Ok(arrays)
    }
}

/// In-memory store holding data for multiple tables.
#[derive(Debug, Default)]
pub struct ColumnStore {
    tables: HashMap<String, TableData>,
}

impl ColumnStore {
    /// Create an empty column store.
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a table and create empty storage for it.
    pub fn register_table(&mut self, table: Table) -> EngineResult<()> {
        if self.tables.contains_key(table.name()) {
            return Err(EngineError::DuplicateName(format!(
                "Table '{}' already registered",
                table.name()
            )));
        }
        let name = table.name().to_string();
        self.tables.insert(name, TableData::new(table));
        Ok(())
    }

    /// Get a reference to a table's data.
    pub fn table_data(&self, name: &str) -> EngineResult<&TableData> {
        self.tables
            .get(name)
            .ok_or_else(|| EngineError::TableNotFound(name.to_string()))
    }

    /// Get a mutable reference to a table's data (for inserting rows).
    pub fn table_data_mut(&mut self, name: &str) -> EngineResult<&mut TableData> {
        self.tables
            .get_mut(name)
            .ok_or_else(|| EngineError::TableNotFound(name.to_string()))
    }

    /// Insert rows into a named table.
    pub fn insert_rows(&mut self, table_name: &str, rows: Vec<Vec<Value>>) -> EngineResult<()> {
        self.table_data_mut(table_name)?.insert_rows(rows)
    }

    /// Get a `RecordBatch` for a named table.
    pub fn to_record_batch(&self, table_name: &str) -> EngineResult<RecordBatch> {
        self.table_data(table_name)?.to_record_batch()
    }
}

/// Validate that a `Value` matches the expected `DataType`.
fn validate_value_type(value: &Value, expected: &DataType) -> EngineResult<()> {
    let ok = matches!(
        (value, expected),
        (Value::Null, _)
            | (Value::Int32(_), DataType::Int32)
            | (Value::Int64(_), DataType::Int64)
            | (Value::Float64(_), DataType::Float64)
            | (Value::Decimal(_, _, _), DataType::Decimal(_, _))
            | (Value::String(_), DataType::String)
            | (Value::Boolean(_), DataType::Boolean)
            | (Value::Date(_), DataType::Date)
            | (Value::Timestamp(_), DataType::Timestamp)
    );
    if ok {
        Ok(())
    } else {
        Err(EngineError::TypeMismatch {
            expected: format!("{expected:?}"),
            actual: format!("{value:?}"),
        })
    }
}

/// Build an Arrow array from a slice of `Value`s.
fn build_arrow_array(values: &[Value], data_type: &DataType) -> EngineResult<ArrayRef> {
    match data_type {
        DataType::Int32 => {
            let mut builder = Int32Builder::with_capacity(values.len());
            for v in values {
                match v {
                    Value::Int32(n) => builder.append_value(*n),
                    Value::Null => builder.append_null(),
                    _ => return Err(type_mismatch_err(data_type, v)),
                }
            }
            Ok(Arc::new(builder.finish()))
        }
        DataType::Int64 => {
            let mut builder = Int64Builder::with_capacity(values.len());
            for v in values {
                match v {
                    Value::Int64(n) => builder.append_value(*n),
                    Value::Null => builder.append_null(),
                    _ => return Err(type_mismatch_err(data_type, v)),
                }
            }
            Ok(Arc::new(builder.finish()))
        }
        DataType::Float64 => {
            let mut builder = Float64Builder::with_capacity(values.len());
            for v in values {
                match v {
                    Value::Float64(n) => builder.append_value(*n),
                    Value::Null => builder.append_null(),
                    _ => return Err(type_mismatch_err(data_type, v)),
                }
            }
            Ok(Arc::new(builder.finish()))
        }
        DataType::Decimal(precision, scale) => {
            let mut builder = Decimal128Builder::with_capacity(values.len())
                .with_precision_and_scale(*precision, *scale)?;
            for v in values {
                match v {
                    Value::Decimal(n, _, _) => builder.append_value(*n),
                    Value::Null => builder.append_null(),
                    _ => return Err(type_mismatch_err(data_type, v)),
                }
            }
            Ok(Arc::new(builder.finish()))
        }
        DataType::String => {
            let mut builder = StringBuilder::with_capacity(values.len(), values.len() * 32);
            for v in values {
                match v {
                    Value::String(s) => builder.append_value(s),
                    Value::Null => builder.append_null(),
                    _ => return Err(type_mismatch_err(data_type, v)),
                }
            }
            Ok(Arc::new(builder.finish()))
        }
        DataType::Boolean => {
            let mut builder = BooleanBuilder::with_capacity(values.len());
            for v in values {
                match v {
                    Value::Boolean(b) => builder.append_value(*b),
                    Value::Null => builder.append_null(),
                    _ => return Err(type_mismatch_err(data_type, v)),
                }
            }
            Ok(Arc::new(builder.finish()))
        }
        DataType::Date => {
            let mut builder = Date32Builder::with_capacity(values.len());
            for v in values {
                match v {
                    Value::Date(d) => builder.append_value(*d),
                    Value::Null => builder.append_null(),
                    _ => return Err(type_mismatch_err(data_type, v)),
                }
            }
            Ok(Arc::new(builder.finish()))
        }
        DataType::Timestamp => {
            let mut builder = TimestampMicrosecondBuilder::with_capacity(values.len());
            for v in values {
                match v {
                    Value::Timestamp(ts) => builder.append_value(*ts),
                    Value::Null => builder.append_null(),
                    _ => return Err(type_mismatch_err(data_type, v)),
                }
            }
            Ok(Arc::new(builder.finish()))
        }
    }
}

fn type_mismatch_err(expected: &DataType, actual: &Value) -> EngineError {
    EngineError::TypeMismatch {
        expected: format!("{expected:?}"),
        actual: format!("{actual:?}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::column::Column;

    fn sales_table() -> Table {
        Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("product", DataType::String),
                Column::new("amount", DataType::Float64),
            ],
        )
        .unwrap()
    }

    #[test]
    fn insert_and_retrieve_record_batch() {
        let mut data = TableData::new(sales_table());
        data.insert_rows(vec![
            vec![
                Value::Int64(1),
                Value::String("Widget".into()),
                Value::Float64(10.0),
            ],
            vec![
                Value::Int64(2),
                Value::String("Gadget".into()),
                Value::Float64(20.0),
            ],
        ])
        .unwrap();

        assert_eq!(data.row_count(), 2);

        let batch = data.to_record_batch().unwrap();
        assert_eq!(batch.num_rows(), 2);
        assert_eq!(batch.num_columns(), 3);
    }

    #[test]
    fn insert_with_nulls() {
        let mut data = TableData::new(sales_table());
        data.insert_rows(vec![vec![Value::Int64(1), Value::Null, Value::Null]])
            .unwrap();

        let batch = data.to_record_batch().unwrap();
        assert_eq!(batch.num_rows(), 1);
        // The string and float columns should have null values.
        assert_eq!(batch.column(1).null_count(), 1);
        assert_eq!(batch.column(2).null_count(), 1);
    }

    #[test]
    fn wrong_column_count_rejected() {
        let mut data = TableData::new(sales_table());
        let result = data.insert_rows(vec![vec![Value::Int64(1), Value::Float64(10.0)]]);
        assert!(result.is_err());
    }

    #[test]
    fn type_mismatch_rejected() {
        let mut data = TableData::new(sales_table());
        let result = data.insert_rows(vec![vec![
            Value::String("not an int".into()),
            Value::String("ok".into()),
            Value::Float64(10.0),
        ]]);
        assert!(result.is_err());
    }

    #[test]
    fn column_store_register_and_insert() {
        let mut store = ColumnStore::new();
        store.register_table(sales_table()).unwrap();

        store
            .insert_rows(
                "Sales",
                vec![vec![
                    Value::Int64(1),
                    Value::String("A".into()),
                    Value::Float64(100.0),
                ]],
            )
            .unwrap();

        let batch = store.to_record_batch("Sales").unwrap();
        assert_eq!(batch.num_rows(), 1);
    }

    #[test]
    fn column_store_duplicate_table_rejected() {
        let mut store = ColumnStore::new();
        store.register_table(sales_table()).unwrap();
        assert!(store.register_table(sales_table()).is_err());
    }
}
