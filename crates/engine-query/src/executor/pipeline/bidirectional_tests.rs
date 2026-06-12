//! Pipeline-level tests for bidirectional (`FilterPropagation::Both`)
//! filter propagation, using fully cache-served in-memory fixtures.
//!
//! Scenario: a star schema where `dim_customers` is filtered. The filter
//! propagates forward to `fact_sales` (existing machinery), and — for a
//! `Both` relationship — onward in reverse to `dim_products`, so a
//! dimension-side `DISTINCTCOUNT` measure (home table `dim_products`,
//! evaluated by the multi-fact path with no join to the fact) reflects only
//! products related to the filtered fact rows.

use std::sync::Arc;

use arrow::array::{Float64Array, Int64Array, StringArray};
use arrow::compute::concat_batches;
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;

use engine_connectors::{FetchRequest, FilterCondition, FilterOperator};
use engine_core::compute::aggregate::AggregateOp;
use engine_core::compute::measure::Measure;
use engine_core::compute::plan::{PlanNode, PlanOperation, PlanValue};
use engine_core::model::table::StorageMode;
use engine_core::model::{Column, DataModel, FilterPropagation, Relationship, Table};
use engine_core::store::InMemoryCache;
use engine_core::types::DataType as EngineDataType;

use crate::registry::SourceRegistry;
use crate::request::{ColumnRef, TotalsMode};

use super::QueryExecutor;

fn build_model(propagation: FilterPropagation) -> DataModel {
    let fact = Table::new(
        "fact_sales",
        vec![
            Column::new("product_id", EngineDataType::Int64),
            Column::new("customer_id", EngineDataType::Int64),
            Column::new("amount", EngineDataType::Float64),
        ],
    )
    .unwrap()
    .with_storage_mode(StorageMode::InMemory);
    let products = Table::new(
        "dim_products",
        vec![
            Column::new("id", EngineDataType::Int64),
            Column::new("name", EngineDataType::String),
        ],
    )
    .unwrap()
    .with_storage_mode(StorageMode::InMemory);
    let customers = Table::new(
        "dim_customers",
        vec![
            Column::new("id", EngineDataType::Int64),
            Column::new("region", EngineDataType::String),
        ],
    )
    .unwrap()
    .with_storage_mode(StorageMode::InMemory);

    DataModel::builder()
        .add_table(fact)
        .add_table(products)
        .add_table(customers)
        .add_relationship(Relationship::many_to_one(
            "Sales_Customers",
            "fact_sales",
            "customer_id",
            "dim_customers",
            "id",
        ))
        .add_relationship(
            Relationship::many_to_one(
                "Sales_Products",
                "fact_sales",
                "product_id",
                "dim_products",
                "id",
            )
            .with_propagation(propagation),
        )
        .build()
        .unwrap()
}

fn build_cache() -> InMemoryCache {
    let mut cache = InMemoryCache::new();

    // Customer 10 (EU) buys products 1 and 2; customer 20 (US) buys product 3.
    let fact_schema = Arc::new(Schema::new(vec![
        Field::new("product_id", DataType::Int64, true),
        Field::new("customer_id", DataType::Int64, true),
        Field::new("amount", DataType::Float64, true),
    ]));
    let fact_batch = RecordBatch::try_new(
        fact_schema,
        vec![
            Arc::new(Int64Array::from(vec![1, 2, 3])),
            Arc::new(Int64Array::from(vec![10, 10, 20])),
            Arc::new(Float64Array::from(vec![100.0, 50.0, 70.0])),
        ],
    )
    .unwrap();
    cache.store("fact_sales", fact_batch).unwrap();

    let products_schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, true),
        Field::new("name", DataType::Utf8, true),
    ]));
    let products_batch = RecordBatch::try_new(
        products_schema,
        vec![
            Arc::new(Int64Array::from(vec![1, 2, 3])),
            Arc::new(StringArray::from(vec!["Bike", "Helmet", "Glove"])),
        ],
    )
    .unwrap();
    cache.store("dim_products", products_batch).unwrap();

    let customers_schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, true),
        Field::new("region", DataType::Utf8, true),
    ]));
    let customers_batch = RecordBatch::try_new(
        customers_schema,
        vec![
            Arc::new(Int64Array::from(vec![10, 20])),
            Arc::new(StringArray::from(vec!["EU", "US"])),
        ],
    )
    .unwrap();
    cache.store("dim_customers", customers_batch).unwrap();

    cache
}

fn build_fetches(filter_customers: bool) -> Vec<(String, FetchRequest)> {
    let mut customers_request = FetchRequest {
        table: "dim_customers".to_string(),
        ..Default::default()
    };
    if filter_customers {
        customers_request.filters.push(FilterCondition {
            column: "region".to_string(),
            operator: FilterOperator::Equal,
            value: "EU".to_string(),
        });
    }
    vec![
        (
            "fact_sales".to_string(),
            FetchRequest {
                table: "fact_sales".to_string(),
                ..Default::default()
            },
        ),
        (
            "dim_products".to_string(),
            FetchRequest {
                table: "dim_products".to_string(),
                ..Default::default()
            },
        ),
        ("dim_customers".to_string(), customers_request),
    ]
}

/// Run the local aggregation pipeline: Revenue (home `fact_sales`) and
/// ProductCount (`DISTINCTCOUNT`, home `dim_products`), grouped by
/// `dim_customers.region`, all tables cache-served. Returns the result
/// batches and the execution plan node.
async fn run_pipeline(
    propagation: FilterPropagation,
    filter_customers: bool,
) -> (Vec<RecordBatch>, PlanNode) {
    let model = build_model(propagation);
    let cache = build_cache();
    let registry = SourceRegistry::new();
    let fetches = build_fetches(filter_customers);
    let measures = vec![
        Measure::simple("Revenue", "fact_sales", "amount", AggregateOp::Sum),
        Measure::simple(
            "ProductCount",
            "dim_products",
            "name",
            AggregateOp::DistinctCount,
        ),
    ];
    let group_by = vec![ColumnRef::new("dim_customers", "region")];

    let mut plan = PlanNode::new(PlanOperation::LocalAggregation, "test");
    let batches = QueryExecutor::execute_local_aggregation(
        &fetches,
        &measures,
        &group_by,
        &[],
        &[],
        None,
        TotalsMode::None,
        None,
        &model,
        &registry,
        Some(&cache),
        None,
        None,
        Some(&mut plan),
        &tokio_util::sync::CancellationToken::new(),
    )
    .await
    .unwrap();

    (batches, plan)
}

/// Extract the single ProductCount value from the combined result.
fn product_count(batches: &[RecordBatch]) -> i64 {
    let combined = concat_batches(&batches[0].schema(), batches).unwrap();
    let idx = combined.schema().index_of("ProductCount").unwrap();
    let arr = combined
        .column(idx)
        .as_any()
        .downcast_ref::<Int64Array>()
        .unwrap();
    arr.value(0)
}

fn find_fetch_node<'a>(plan: &'a PlanNode, label: &str) -> &'a PlanNode {
    plan.children
        .iter()
        .find(|n| n.label == label)
        .unwrap_or_else(|| panic!("missing plan node '{label}'"))
}

fn property<'a>(node: &'a PlanNode, key: &str) -> Option<&'a PlanValue> {
    node.properties
        .iter()
        .find(|p| p.key == key)
        .map(|p| &p.value)
}

#[tokio::test]
async fn both_relationship_reduces_dimension_distinctcount() {
    let (batches, plan) = run_pipeline(FilterPropagation::Both, true).await;

    // EU fact rows reference products {1, 2} only — the reverse filter
    // restricts dim_products before its DISTINCTCOUNT group evaluates.
    assert_eq!(product_count(&batches), 2);

    // Revenue still reflects the EU filter via the forward join: one group
    // row (EU) with SUM(amount) = 150.
    let combined = concat_batches(&batches[0].schema(), &batches).unwrap();
    assert_eq!(combined.num_rows(), 1);
    let rev_idx = combined.schema().index_of("Revenue").unwrap();
    let revenue = combined
        .column(rev_idx)
        .as_any()
        .downcast_ref::<Float64Array>()
        .unwrap()
        .value(0);
    assert!((revenue - 150.0).abs() < 1e-9);

    // The dimension's fetch node reports the reverse filter (mirroring the
    // fact-side `relationship_filters` property). Cache-served dimension:
    // strategy is "local".
    let dim_node = find_fetch_node(&plan, "Cache: dim_products");
    match property(dim_node, "bidirectional_filters") {
        Some(PlanValue::List(items)) => {
            assert_eq!(items.len(), 1);
            assert!(
                items[0].contains("id IN (2 values, via fact_sales, strategy: local)"),
                "unexpected property text: {}",
                items[0]
            );
        }
        other => panic!("expected bidirectional_filters list, got {other:?}"),
    }

    // The locally applied filter is also reflected in the reported row count.
    match property(dim_node, "rows_fetched") {
        Some(PlanValue::Number(n)) => assert_eq!(*n, 2.0),
        other => panic!("expected rows_fetched number, got {other:?}"),
    }
}

#[tokio::test]
async fn auto_relationship_keeps_dimension_unfiltered() {
    // Contrast test: identical model and query, but the relationship is
    // Auto — the dimension fetch must stay unfiltered and the count
    // unchanged (zero regression for non-Both models).
    let (batches, plan) = run_pipeline(FilterPropagation::Auto, true).await;

    assert_eq!(product_count(&batches), 3);

    let dim_node = find_fetch_node(&plan, "Cache: dim_products");
    assert!(
        property(dim_node, "bidirectional_filters").is_none(),
        "Auto must not produce a bidirectional_filters property"
    );
    match property(dim_node, "rows_fetched") {
        Some(PlanValue::Number(n)) => assert_eq!(*n, 3.0),
        other => panic!("expected rows_fetched number, got {other:?}"),
    }
}

#[tokio::test]
async fn both_relationship_without_fact_filters_propagates_nothing() {
    // No filter anywhere: the fact side is unfiltered, so no reverse
    // propagation happens even with Both (and no IN filter appears on the
    // dimension's fetch node).
    let (batches, plan) = run_pipeline(FilterPropagation::Both, false).await;

    assert_eq!(product_count(&batches), 3);

    let dim_node = find_fetch_node(&plan, "Cache: dim_products");
    assert!(
        property(dim_node, "bidirectional_filters").is_none(),
        "unfiltered fact must not produce a bidirectional_filters property"
    );
    match property(dim_node, "rows_fetched") {
        Some(PlanValue::Number(n)) => assert_eq!(*n, 3.0),
        other => panic!("expected rows_fetched number, got {other:?}"),
    }
}
