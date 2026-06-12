//! Shared fixtures for measure-engine unit tests.

use crate::compute::aggregate::AggregateOp;
use crate::compute::expression::{self as expr};
use crate::compute::measure::{
    count_measure, distinct_count_measure, expression_measure, sum_measure,
};
use crate::model::column::Column;
use crate::model::relationship::Relationship;
use crate::model::schema::DataModel;
use crate::model::table::Table;
use crate::store::ColumnStore;
use crate::types::{DataType, Value};

pub(super) fn sales_table() -> Table {
    Table::new(
        "Sales",
        vec![
            Column::new("id", DataType::Int64),
            Column::new("product_id", DataType::Int64),
            Column::new("amount", DataType::Float64),
            Column::new("price", DataType::Float64),
            Column::new("quantity", DataType::Int64),
        ],
    )
    .unwrap()
}

pub(super) fn products_table() -> Table {
    Table::new(
        "Products",
        vec![
            Column::new("id", DataType::Int64),
            Column::new("name", DataType::String),
            Column::new("category", DataType::String),
        ],
    )
    .unwrap()
}

pub(super) fn populated_store() -> ColumnStore {
    let mut store = ColumnStore::new();
    store.register_table(sales_table()).unwrap();
    store.register_table(products_table()).unwrap();

    store
        .insert_rows(
            "Sales",
            vec![
                vec![
                    Value::Int64(1),
                    Value::Int64(101),
                    Value::Float64(50.0),
                    Value::Float64(10.0),
                    Value::Int64(5),
                ],
                vec![
                    Value::Int64(2),
                    Value::Int64(102),
                    Value::Float64(30.0),
                    Value::Float64(15.0),
                    Value::Int64(2),
                ],
                vec![
                    Value::Int64(3),
                    Value::Int64(101),
                    Value::Float64(20.0),
                    Value::Float64(20.0),
                    Value::Int64(1),
                ],
            ],
        )
        .unwrap();

    store
        .insert_rows(
            "Products",
            vec![
                vec![
                    Value::Int64(101),
                    Value::String("Widget".into()),
                    Value::String("A".into()),
                ],
                vec![
                    Value::Int64(102),
                    Value::String("Gadget".into()),
                    Value::String("B".into()),
                ],
            ],
        )
        .unwrap();

    store
}

pub(super) fn single_table_model() -> DataModel {
    DataModel::builder()
        .add_table(sales_table())
        .add_measure(sum_measure("TotalAmount", "Sales", "amount"))
        .add_measure(count_measure("OrderCount", "Sales", "id"))
        .add_measure(distinct_count_measure(
            "UniqueProducts",
            "Sales",
            "product_id",
        ))
        .add_measure(expression_measure(
            "Revenue",
            expr::agg(
                AggregateOp::Sum,
                expr::qualified_col("Sales", "price")
                    .multiply(expr::qualified_col("Sales", "quantity")),
            ),
        ))
        .add_measure(expression_measure(
            "AvgOrderValue",
            expr::agg(AggregateOp::Sum, expr::qualified_col("Sales", "amount")).divide(expr::agg(
                AggregateOp::Count,
                expr::qualified_col("Sales", "id"),
            )),
        ))
        .build()
        .unwrap()
}

pub(super) fn star_schema_model() -> DataModel {
    DataModel::builder()
        .add_table(sales_table())
        .add_table(products_table())
        .add_relationship(Relationship::many_to_one(
            "Sales_Products",
            "Sales",
            "product_id",
            "Products",
            "id",
        ))
        .add_measure(sum_measure("TotalAmount", "Sales", "amount"))
        .build()
        .unwrap()
}

pub(super) fn periods_table() -> Table {
    Table::new(
        "Periods",
        vec![
            Column::new("period_name", DataType::String),
            Column::new("start_id", DataType::Int64),
            Column::new("end_id", DataType::Int64),
        ],
    )
    .unwrap()
}

pub(super) fn store_with_periods() -> ColumnStore {
    let mut store = ColumnStore::new();
    store.register_table(sales_table()).unwrap();
    store.register_table(periods_table()).unwrap();

    store
        .insert_rows(
            "Sales",
            vec![
                vec![
                    Value::Int64(1),
                    Value::Int64(101),
                    Value::Float64(10.0),
                    Value::Float64(5.0),
                    Value::Int64(2),
                ],
                vec![
                    Value::Int64(2),
                    Value::Int64(102),
                    Value::Float64(20.0),
                    Value::Float64(10.0),
                    Value::Int64(1),
                ],
                vec![
                    Value::Int64(3),
                    Value::Int64(101),
                    Value::Float64(30.0),
                    Value::Float64(15.0),
                    Value::Int64(2),
                ],
                vec![
                    Value::Int64(4),
                    Value::Int64(103),
                    Value::Float64(15.0),
                    Value::Float64(7.0),
                    Value::Int64(1),
                ],
            ],
        )
        .unwrap();

    store
        .insert_rows(
            "Periods",
            vec![
                // P1 covers product IDs 101..=102
                vec![
                    Value::String("P1".into()),
                    Value::Int64(101),
                    Value::Int64(102),
                ],
                // P2 covers product IDs 102..=103
                vec![
                    Value::String("P2".into()),
                    Value::Int64(102),
                    Value::Int64(103),
                ],
            ],
        )
        .unwrap();

    store
}
