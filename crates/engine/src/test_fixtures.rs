//! Shared fixtures for engine unit tests.

use std::sync::Arc;

use arrow::array::{Float64Array, Int64Array};
use arrow::datatypes::{DataType as ArrowDataType, Field, Schema as ArrowSchema};
use arrow::record_batch::RecordBatch;

use crate::{
    sum_measure, Column, DataModel, DataType, RefreshStrategy, Relationship, StorageMode, Table,
};

pub(crate) fn make_inmemory_model() -> DataModel {
    DataModel::builder()
        .add_table(
            Table::new(
                "Products",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("price", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory)
            .with_refresh_interval(std::time::Duration::from_secs(300)),
        )
        .build()
        .unwrap()
}

pub(crate) fn make_test_batch() -> RecordBatch {
    let schema = Arc::new(ArrowSchema::new(vec![
        Field::new("id", ArrowDataType::Int64, true),
        Field::new("price", ArrowDataType::Float64, true),
    ]));
    RecordBatch::try_new(
        schema,
        vec![
            Arc::new(Int64Array::from(vec![1, 2, 3])),
            Arc::new(Float64Array::from(vec![9.99, 19.99, 29.99])),
        ],
    )
    .unwrap()
}

pub(crate) fn make_cache_dir(test_name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("calcula_cache_test_{test_name}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Model with one InMemory table carrying a single `SourceQuery` strategy.
pub(crate) fn make_source_query_model(sql: &str) -> DataModel {
    DataModel::builder()
        .add_table(
            Table::new(
                "Products",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("price", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory)
            .with_refresh_strategy(RefreshStrategy::SourceQuery {
                sql: sql.to_string(),
                source_table: None,
            }),
        )
        .build()
        .unwrap()
}

pub(crate) fn make_star_schema_model() -> DataModel {
    DataModel::builder()
        .add_table(
            Table::new(
                "fact_sales",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("product_id", DataType::Int64),
                    Column::new("customer_id", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap(),
        )
        .add_table(
            Table::new(
                "dim_products",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("name", DataType::String),
                ],
            )
            .unwrap(),
        )
        .add_table(
            Table::new(
                "dim_customers",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("name", DataType::String),
                ],
            )
            .unwrap(),
        )
        .add_relationship(Relationship::many_to_one(
            "sales_products",
            "fact_sales",
            "product_id",
            "dim_products",
            "id",
        ))
        .add_relationship(Relationship::many_to_one(
            "sales_customers",
            "fact_sales",
            "customer_id",
            "dim_customers",
            "id",
        ))
        .add_measure(sum_measure("Revenue", "fact_sales", "amount"))
        .build()
        .unwrap()
}
