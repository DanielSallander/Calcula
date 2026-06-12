//! Shared test fixtures for the pushdown planner test modules.

use engine_connectors::FetchRequest;
use engine_core::compute::measure::{count_measure, sum_measure};
use engine_core::model::{Column, DataModel, Relationship, Table};
use engine_core::types::DataType;

use crate::registry::{SourceBinding, SourceRegistry};

use super::QueryPlan;

pub(super) fn test_model_single_table() -> DataModel {
    let sales = Table::new(
        "Sales",
        vec![
            Column::new("id", DataType::Int64),
            Column::new("amount", DataType::Float64),
            Column::new("region", DataType::String),
        ],
    )
    .unwrap();

    DataModel::builder()
        .add_table(sales)
        .add_measure(sum_measure("TotalAmount", "Sales", "amount"))
        .add_measure(count_measure("OrderCount", "Sales", "id"))
        .build()
        .unwrap()
}

pub(super) fn test_model_star_schema() -> DataModel {
    let sales = Table::new(
        "Sales",
        vec![
            Column::new("id", DataType::Int64),
            Column::new("product_id", DataType::Int64),
            Column::new("amount", DataType::Float64),
        ],
    )
    .unwrap();

    let products = Table::new(
        "Products",
        vec![
            Column::new("id", DataType::Int64),
            Column::new("category", DataType::String),
        ],
    )
    .unwrap();

    DataModel::builder()
        .add_table(sales)
        .add_table(products)
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

pub(super) fn mock_registry_single(connector_idx: usize) -> SourceRegistry {
    let mut registry = SourceRegistry::new();
    registry.bind(
        "Sales",
        connector_idx,
        SourceBinding::new("sales", "salesorderheader"),
    );
    registry
}

pub(super) fn mock_registry_star(connector_idx: usize) -> SourceRegistry {
    let mut registry = SourceRegistry::new();
    registry.bind(
        "Sales",
        connector_idx,
        SourceBinding::new("sales", "salesorderheader"),
    );
    registry.bind(
        "Products",
        connector_idx,
        SourceBinding::new("production", "product"),
    );
    registry
}

/// Two tables on different connectors — forces local aggregation.
pub(super) fn make_cross_source_registry() -> SourceRegistry {
    let mut registry = SourceRegistry::new();
    registry.bind("Sales", 0, SourceBinding::new("sales", "salesorderheader"));
    registry.bind("Products", 1, SourceBinding::new("production", "product"));
    registry
}

pub(super) fn mock_registry_cross_source() -> SourceRegistry {
    let mut registry = SourceRegistry::new();
    // Sales on connector 0, Products on connector 1 (different sources).
    registry.bind("Sales", 0, SourceBinding::new("sales", "salesorderheader"));
    registry.bind("Products", 1, SourceBinding::new("production", "product"));
    registry
}

/// Star schema with fact + two dimensions, for context filter pushdown tests.
pub(super) fn test_model_three_table() -> DataModel {
    let sales = Table::new(
        "Sales",
        vec![
            Column::new("id", DataType::Int64),
            Column::new("product_id", DataType::Int64),
            Column::new("date_id", DataType::Int64),
            Column::new("amount", DataType::Float64),
        ],
    )
    .unwrap();

    let products = Table::new(
        "Products",
        vec![
            Column::new("id", DataType::Int64),
            Column::new("category", DataType::String),
        ],
    )
    .unwrap();

    let dates = Table::new(
        "Dates",
        vec![
            Column::new("id", DataType::Int64),
            Column::new("year", DataType::Int32),
            Column::new("month", DataType::Int32),
        ],
    )
    .unwrap();

    DataModel::builder()
        .add_table(sales)
        .add_table(products)
        .add_table(dates)
        .add_relationship(Relationship::many_to_one(
            "Sales_Products",
            "Sales",
            "product_id",
            "Products",
            "id",
        ))
        .add_relationship(Relationship::many_to_one(
            "Sales_Dates",
            "Sales",
            "date_id",
            "Dates",
            "id",
        ))
        .build()
        .unwrap()
}

pub(super) fn mock_registry_three(connector_idx: usize) -> SourceRegistry {
    let mut registry = SourceRegistry::new();
    registry.bind("Sales", connector_idx, SourceBinding::new("dbo", "sales"));
    registry.bind(
        "Products",
        connector_idx,
        SourceBinding::new("dbo", "products"),
    );
    registry.bind("Dates", connector_idx, SourceBinding::new("dbo", "dates"));
    registry
}

/// Extract the fetch for a table from a LocalAggregation plan.
pub(super) fn fetch_for<'p>(plan: &'p QueryPlan, table: &str) -> &'p FetchRequest {
    match plan {
        QueryPlan::LocalAggregation { fetches, .. } => {
            &fetches
                .iter()
                .find(|(name, _)| name == table)
                .unwrap_or_else(|| panic!("no fetch for table '{table}'"))
                .1
        }
        other => panic!("Expected LocalAggregation, got {other:?}"),
    }
}
