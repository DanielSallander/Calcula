//! Integration tests for columnar storage and aggregation.

use engine_core::compute::{
    average_column, compute_aggregate, count_column, sum_column, AggregateOp,
};
use engine_core::model::{Column, DataModel, Table};
use engine_core::store::{ColumnStore, TableData};
use engine_core::types::{DataType, Value};

/// Helper: build a Sales table with id, product, and amount columns.
fn sales_table() -> Table {
    Table::new(
        "Sales",
        vec![
            Column::new("id", DataType::Int64),
            Column::new("product", DataType::String),
            Column::new("amount", DataType::Float64),
            Column::new("quantity", DataType::Int32),
        ],
    )
    .unwrap()
}

/// Helper: populate a TableData with sample sales rows.
fn populated_sales() -> TableData {
    let mut data = TableData::new(sales_table());
    data.insert_rows(vec![
        vec![
            Value::Int64(1),
            Value::String("Widget".into()),
            Value::Float64(100.0),
            Value::Int32(5),
        ],
        vec![
            Value::Int64(2),
            Value::String("Gadget".into()),
            Value::Float64(250.0),
            Value::Int32(2),
        ],
        vec![
            Value::Int64(3),
            Value::String("Widget".into()),
            Value::Float64(150.0),
            Value::Int32(3),
        ],
        vec![
            Value::Int64(4),
            Value::String("Doohickey".into()),
            Value::Null,
            Value::Int32(1),
        ],
    ])
    .unwrap();
    data
}

#[tokio::test]
async fn end_to_end_sum_aggregation() {
    let data = populated_sales();
    let result = sum_column(&data, "amount").await.unwrap();
    assert_eq!(result, Some(500.0));
}

#[tokio::test]
async fn end_to_end_count_aggregation() {
    let data = populated_sales();
    // COUNT skips nulls — amount has one null.
    let result = count_column(&data, "amount").await.unwrap();
    assert_eq!(result, Some(3));
}

#[tokio::test]
async fn end_to_end_average_aggregation() {
    let data = populated_sales();
    // Average of 100, 250, 150 (null excluded) = 500/3 ≈ 166.67
    let result = average_column(&data, "amount").await.unwrap();
    let avg = result.unwrap();
    assert!((avg - 500.0 / 3.0).abs() < 0.01);
}

#[tokio::test]
async fn end_to_end_min_max() {
    let data = populated_sales();

    let min = compute_aggregate(&data, "amount", AggregateOp::Min)
        .await
        .unwrap();
    assert_eq!(min.as_f64(), Some(100.0));

    let max = compute_aggregate(&data, "amount", AggregateOp::Max)
        .await
        .unwrap();
    assert_eq!(max.as_f64(), Some(250.0));
}

#[tokio::test]
async fn aggregation_on_integer_column() {
    let data = populated_sales();
    let result = sum_column(&data, "quantity").await.unwrap();
    // 5 + 2 + 3 + 1 = 11, but quantity is Int32 → sum is i32 → as_f64 = 11.0
    assert_eq!(result, Some(11.0));
}

#[test]
fn column_store_workflow() {
    let mut store = ColumnStore::new();
    store.register_table(sales_table()).unwrap();

    store
        .insert_rows(
            "Sales",
            vec![
                vec![
                    Value::Int64(1),
                    Value::String("A".into()),
                    Value::Float64(10.0),
                    Value::Int32(1),
                ],
                vec![
                    Value::Int64(2),
                    Value::String("B".into()),
                    Value::Float64(20.0),
                    Value::Int32(2),
                ],
            ],
        )
        .unwrap();

    let batch = store.to_record_batch("Sales").unwrap();
    assert_eq!(batch.num_rows(), 2);
    assert_eq!(batch.num_columns(), 4);
}

#[test]
fn data_model_builder_integration() {
    let model = DataModel::builder()
        .add_table(sales_table())
        .add_table(
            Table::new(
                "Products",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("name", DataType::String),
                    Column::new("price", DataType::Float64),
                ],
            )
            .unwrap(),
        )
        .build()
        .unwrap();

    assert_eq!(model.tables().len(), 2);
    assert_eq!(model.table("Sales").unwrap().columns().len(), 4);
    assert_eq!(model.table("Products").unwrap().columns().len(), 3);
}

#[test]
fn arrow_schema_matches_table_definition() {
    let table = sales_table();
    let schema = table.to_arrow_schema();
    assert_eq!(schema.fields().len(), 4);
    assert_eq!(schema.field(0).name(), "id");
    assert_eq!(schema.field(1).name(), "product");
    assert_eq!(schema.field(2).name(), "amount");
    assert_eq!(schema.field(3).name(), "quantity");
}
