//! Shared fixtures for schema unit tests.

use crate::model::column::Column;
use crate::model::relationship::Relationship;
use crate::model::table::Table;
use crate::types::DataType;

pub(super) fn sales_table() -> Table {
    Table::new(
        "Sales",
        vec![
            Column::new("id", DataType::Int64),
            Column::new("product_id", DataType::Int64),
            Column::new("store_id", DataType::Int64),
            Column::new("amount", DataType::Float64),
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

pub(super) fn stores_table() -> Table {
    Table::new(
        "Stores",
        vec![
            Column::new("id", DataType::Int64),
            Column::new("city", DataType::String),
        ],
    )
    .unwrap()
}

pub(super) fn sales_products_relationship() -> Relationship {
    Relationship::many_to_one("Sales_Products", "Sales", "product_id", "Products", "id")
}

pub(super) fn sales_stores_relationship() -> Relationship {
    Relationship::many_to_one("Sales_Stores", "Sales", "store_id", "Stores", "id")
}
