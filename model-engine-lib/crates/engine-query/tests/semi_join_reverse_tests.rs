//! Deterministic cross-source semi-join reverse-pushdown tests (no database).
//!
//! Fixture: a single-fact star split across two in-memory connectors —
//! `Sales(prod_id, region, amount)` on connector A, `Product(id, name)` on
//! connector B, joined `Sales.prod_id → Product.id`. Both are `DirectQuery`
//! (connector-backed, not cache-served), so a query spanning them plans as
//! `LocalAggregation` and the executor fetches each side from its own connector.
//!
//! These prove the opt-in reverse (fact → dimension) pushdown
//! ([`SemiJoinConfig`]) both (a) produces **byte-identical** results to the
//! full-fetch path and (b) actually **pulls fewer dimension rows** across the
//! source boundary — without a real database.

use std::collections::BTreeMap;
use std::sync::Arc;

use arrow::array::{Array, DictionaryArray, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Int32Type, Schema};
use arrow::record_batch::RecordBatch;

use engine_connectors::{FilterCondition, FilterOperator};
use engine_core::compute::measure::sum_measure;
use engine_core::compute::plan::{PlanNode, PlanValue};
use engine_core::model::schema::DataModel;
use engine_core::model::{Column, Relationship, Table};
use engine_core::types::DataType;
use engine_query::in_memory_connector::InMemoryConnector;
use engine_query::registry::SemiJoinConfig;
use engine_query::{
    AnyConnector, ColumnRef, PushdownPlanner, QueryExecutor, QueryPlan, QueryRequest,
    SourceBinding, SourceRegistry,
};

/// `Sales(prod_id, region, amount)`. East rows reference products 1 and 2 only;
/// product 3 appears only in a West row; product 4 is never referenced.
fn sales_batch() -> RecordBatch {
    let schema = Arc::new(Schema::new(vec![
        Field::new("prod_id", ArrowType::Int64, true),
        Field::new("region", ArrowType::Utf8, true),
        Field::new("amount", ArrowType::Float64, true),
    ]));
    RecordBatch::try_new(
        schema,
        vec![
            Arc::new(Int64Array::from(vec![1, 2, 1, 3])),
            Arc::new(StringArray::from(vec!["East", "East", "West", "West"])),
            Arc::new(Float64Array::from(vec![100.0, 40.0, 30.0, 70.0])),
        ],
    )
    .unwrap()
}

/// `Product(id, name)` — four products; 4 ("Ghost") is never referenced.
fn product_batch() -> RecordBatch {
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", ArrowType::Int64, true),
        Field::new("name", ArrowType::Utf8, true),
    ]));
    RecordBatch::try_new(
        schema,
        vec![
            Arc::new(Int64Array::from(vec![1, 2, 3, 4])),
            Arc::new(StringArray::from(vec!["Bike", "Helmet", "Tyre", "Ghost"])),
        ],
    )
    .unwrap()
}

fn star_model() -> DataModel {
    DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("prod_id", DataType::Int64),
                    Column::new("region", DataType::String),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap(),
        )
        .add_table(
            Table::new(
                "Product",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("name", DataType::String),
                ],
            )
            .unwrap(),
        )
        .add_relationship(Relationship::many_to_one(
            "Sales_Product",
            "Sales",
            "prod_id",
            "Product",
            "id",
        ))
        .add_measure(sum_measure("Revenue", "Sales", "amount"))
        .build()
        .unwrap()
}

/// Two in-memory connectors (fact on A, dimension on B) with the given
/// semi-join config.
fn cross_source_registry(config: SemiJoinConfig) -> SourceRegistry {
    let sales = InMemoryConnector::new().with_table("s", "sales", sales_batch());
    let product = InMemoryConnector::new().with_table("p", "product", product_batch());
    let mut registry = SourceRegistry::new();
    let a = registry.add_connector(AnyConnector::InMemory(sales));
    let b = registry.add_connector(AnyConnector::InMemory(product));
    registry.bind("Sales", a, SourceBinding::new("s", "sales"));
    registry.bind("Product", b, SourceBinding::new("p", "product"));
    registry.set_semi_join_config(config);
    registry
}

/// Query: East-only Revenue grouped by Product name. The fact is filtered
/// (region = East), so reverse pushdown can restrict the Product fetch.
fn east_by_product() -> QueryRequest {
    QueryRequest {
        measures: vec!["Revenue".into()],
        group_by: vec![ColumnRef::new("Product", "name")],
        filters: vec![FilterCondition::new(
            "region",
            FilterOperator::Equal,
            "East",
        )],
        ..Default::default()
    }
}

/// Extract `name -> Revenue` as a sorted map (canonical, for equality checks).
/// Handles both plain and dictionary-encoded group-by string columns.
fn result_map(batches: &[RecordBatch]) -> BTreeMap<String, f64> {
    let mut out = BTreeMap::new();
    for b in batches {
        let name_idx = b.schema().index_of("name").unwrap();
        let rev_idx = b.schema().index_of("Revenue").unwrap();
        let names = b.column(name_idx);
        let revs = b
            .column(rev_idx)
            .as_any()
            .downcast_ref::<Float64Array>()
            .expect("Revenue is Float64");
        for row in 0..b.num_rows() {
            out.insert(string_at(names.as_ref(), row), revs.value(row));
        }
    }
    out
}

fn string_at(array: &dyn Array, row: usize) -> String {
    if let Some(a) = array.as_any().downcast_ref::<StringArray>() {
        a.value(row).to_string()
    } else if let Some(d) = array.as_any().downcast_ref::<DictionaryArray<Int32Type>>() {
        let values = d.values().as_any().downcast_ref::<StringArray>().unwrap();
        values.value(d.key(row).unwrap()).to_string()
    } else {
        panic!("unexpected group array type: {:?}", array.data_type());
    }
}

/// Recursively find the `SourceFetch` node for `table` and return its
/// `rows_fetched`.
fn rows_fetched(node: &PlanNode, table: &str) -> Option<usize> {
    let is_fetch_for_table = node
        .properties
        .iter()
        .any(|p| p.key == "table" && matches!(&p.value, PlanValue::Text(t) if t == table));
    if is_fetch_for_table {
        if let Some(p) = node.properties.iter().find(|p| p.key == "rows_fetched") {
            if let PlanValue::Number(n) = p.value {
                return Some(n as usize);
            }
        }
    }
    node.children.iter().find_map(|c| rows_fetched(c, table))
}

/// Whether the `SourceFetch` node for `table` carries a reverse
/// (`bidirectional_filters`) annotation.
fn has_reverse_filter(node: &PlanNode, table: &str) -> bool {
    let is_fetch_for_table = node
        .properties
        .iter()
        .any(|p| p.key == "table" && matches!(&p.value, PlanValue::Text(t) if t == table));
    if is_fetch_for_table
        && node
            .properties
            .iter()
            .any(|p| p.key == "bidirectional_filters")
    {
        return true;
    }
    node.children.iter().any(|c| has_reverse_filter(c, table))
}

async fn run(config: SemiJoinConfig) -> (BTreeMap<String, f64>, PlanNode) {
    let model = star_model();
    let registry = cross_source_registry(config);
    let request = east_by_product();
    let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();
    assert!(
        matches!(plan, QueryPlan::LocalAggregation { .. }),
        "cross-source query must plan as LocalAggregation"
    );
    let (batches, node) =
        QueryExecutor::execute_explained(&plan, &model, &registry, None, None, None, &[])
            .await
            .unwrap();
    (result_map(&batches), node)
}

#[tokio::test]
async fn reverse_pushdown_is_byte_identical_and_shrinks_dimension_fetch() {
    // Baseline: reverse pushdown OFF (the default).
    let (off, off_plan) = run(SemiJoinConfig::default()).await;
    // Optimized: reverse pushdown ON.
    let (on, on_plan) = run(SemiJoinConfig {
        reverse_pushdown: true,
        ..SemiJoinConfig::default()
    })
    .await;

    // (a) Correctness: identical results. East revenue: Bike 100, Helmet 40.
    let expected: BTreeMap<String, f64> =
        [("Bike".to_string(), 100.0), ("Helmet".to_string(), 40.0)]
            .into_iter()
            .collect();
    assert_eq!(off, expected, "baseline result");
    assert_eq!(on, expected, "optimized result must match baseline");

    // (b) Pulls less data: the Product dimension fetch shrinks from all 4 rows
    // to just the 2 referenced by the East-filtered fact.
    assert_eq!(rows_fetched(&off_plan, "Product"), Some(4));
    assert_eq!(rows_fetched(&on_plan, "Product"), Some(2));

    // The reverse filter is recorded only when the optimization is enabled.
    assert!(!has_reverse_filter(&off_plan, "Product"));
    assert!(has_reverse_filter(&on_plan, "Product"));
}

#[tokio::test]
async fn abort_tier_falls_back_to_full_dimension_fetch() {
    // A tiny abort ceiling: the fact key set (2 distinct products) exceeds it,
    // so the opportunistic reverse filter is skipped — the dimension is fetched
    // in full, and the result is still correct.
    let (result, plan) = run(SemiJoinConfig {
        reverse_pushdown: true,
        key_set_abort_max: 1,
    })
    .await;

    let expected: BTreeMap<String, f64> =
        [("Bike".to_string(), 100.0), ("Helmet".to_string(), 40.0)]
            .into_iter()
            .collect();
    assert_eq!(result, expected);
    assert_eq!(
        rows_fetched(&plan, "Product"),
        Some(4),
        "oversized key set aborts to a full dimension fetch"
    );
    assert!(!has_reverse_filter(&plan, "Product"));
}

#[tokio::test]
async fn default_config_does_not_reverse_propagate() {
    // Explicit guard that the feature is off by default (no behavior change for
    // existing hosts): the default config fetches the full dimension.
    let (_, plan) = run(SemiJoinConfig::default()).await;
    assert_eq!(rows_fetched(&plan, "Product"), Some(4));
    assert!(!has_reverse_filter(&plan, "Product"));
}
