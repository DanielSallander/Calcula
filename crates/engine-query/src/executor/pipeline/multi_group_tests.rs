//! Regression tests for multi-fact-table combine (`execute_multi_group_aggregation`).
//!
//! The headline case is a 3-fact query over a conformed dimension that is
//! reachable from the later facts but NOT from the first: the combine must join
//! the later groups on the shared dimension, not cartesian-explode them.

use std::sync::Arc;

use arrow::array::{Float64Array, Int64Array, StringArray};
use arrow::compute::concat_batches;
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;

use engine_core::compute::measure::{expression_measure, Measure};
use engine_core::compute::parser::parse_measure_expression;
use engine_core::model::table::StorageMode;
use engine_core::model::{Column, DataModel, Relationship, Table};
use engine_core::store::InMemoryCache;
use engine_core::types::DataType as EngineDataType;

use super::QueryExecutor;
use crate::error::QueryResult;
use crate::planner::PushdownPlanner;
use crate::registry::{SourceBinding, SourceRegistry};
use crate::request::{ColumnRef, QueryRequest};

fn sum_measure(name: &str, table: &str, col: &str) -> Measure {
    expression_measure(
        name,
        parse_measure_expression(&format!("SUM({table}[{col}])")).unwrap(),
    )
}

fn in_mem(table: Table) -> Table {
    table.with_storage_mode(StorageMode::InMemory)
}

/// Model: a conformed `dim_geo` reachable from `fact_sales` and `fact_returns`
/// but NOT from `fact_budget` (which has no relationship to it). Measures:
/// `budget` (fact_budget, scalar), `sales` (fact_sales, per geo), `returns`
/// (fact_returns, per geo). The measure order puts the unrelated `budget`
/// FIRST, so it becomes group 0 — the exact shape that used to cartesian-explode.
fn conformed_dim_model() -> DataModel {
    let dim_geo = in_mem(
        Table::new(
            "dim_geo",
            vec![
                Column::new("id", EngineDataType::Int64),
                Column::new("region", EngineDataType::String),
            ],
        )
        .unwrap(),
    );
    let fact_budget = in_mem(
        Table::new(
            "fact_budget",
            vec![Column::new("amount_b", EngineDataType::Float64)],
        )
        .unwrap(),
    );
    let fact_sales = in_mem(
        Table::new(
            "fact_sales",
            vec![
                Column::new("geo_id", EngineDataType::Int64),
                Column::new("amount_s", EngineDataType::Float64),
            ],
        )
        .unwrap(),
    );
    let fact_returns = in_mem(
        Table::new(
            "fact_returns",
            vec![
                Column::new("geo_id", EngineDataType::Int64),
                Column::new("amount_r", EngineDataType::Float64),
            ],
        )
        .unwrap(),
    );

    DataModel::builder()
        .add_table(dim_geo)
        .add_table(fact_budget)
        .add_table(fact_sales)
        .add_table(fact_returns)
        .add_relationship(Relationship::many_to_one(
            "sales_geo",
            "fact_sales",
            "geo_id",
            "dim_geo",
            "id",
        ))
        .add_relationship(Relationship::many_to_one(
            "returns_geo",
            "fact_returns",
            "geo_id",
            "dim_geo",
            "id",
        ))
        .add_measure(sum_measure("budget", "fact_budget", "amount_b"))
        .add_measure(sum_measure("sales", "fact_sales", "amount_s"))
        .add_measure(sum_measure("returns", "fact_returns", "amount_r"))
        .build()
        .unwrap()
}

async fn run(model: &DataModel) -> QueryResult<Vec<RecordBatch>> {
    let mut cache = InMemoryCache::new();
    // dim_geo: 1 = West, 2 = East.
    cache
        .store(
            "dim_geo",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("id", DataType::Int64, true),
                    Field::new("region", DataType::Utf8, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1i64, 2])),
                    Arc::new(StringArray::from(vec!["West", "East"])),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    // fact_budget: scalar total 5 + 7 = 12, no geo.
    cache
        .store(
            "fact_budget",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![Field::new(
                    "amount_b",
                    DataType::Float64,
                    true,
                )])),
                vec![Arc::new(Float64Array::from(vec![5.0, 7.0]))],
            )
            .unwrap(),
        )
        .unwrap();
    // fact_sales: West=100, East=200.
    cache
        .store(
            "fact_sales",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("geo_id", DataType::Int64, true),
                    Field::new("amount_s", DataType::Float64, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1i64, 2])),
                    Arc::new(Float64Array::from(vec![100.0, 200.0])),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    // fact_returns: West=10, East=20.
    cache
        .store(
            "fact_returns",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("geo_id", DataType::Int64, true),
                    Field::new("amount_r", DataType::Float64, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1i64, 2])),
                    Arc::new(Float64Array::from(vec![10.0, 20.0])),
                ],
            )
            .unwrap(),
        )
        .unwrap();

    let mut registry = SourceRegistry::new();
    for t in ["dim_geo", "fact_budget", "fact_sales", "fact_returns"] {
        registry.bind(t, 0, SourceBinding::new("public", t));
    }

    let req = QueryRequest {
        measures: vec!["budget".into(), "sales".into(), "returns".into()],
        group_by: vec![ColumnRef::new("dim_geo", "region")],
        ..Default::default()
    };
    let plan = PushdownPlanner::plan(&req, model, &registry, &[])?;
    QueryExecutor::execute(&plan, model, &registry, Some(&cache), None, None, &[]).await
}

#[tokio::test]
async fn three_facts_conformed_dim_unreachable_from_first_does_not_cartesian() {
    let model = conformed_dim_model();
    let batches = run(&model).await.unwrap();
    let combined = concat_batches(&batches[0].schema(), &batches).unwrap();

    // Exactly two region rows — NOT four (the cartesian product of fact_sales'
    // regions × fact_returns' regions that the old group-0-only join produced).
    assert_eq!(
        combined.num_rows(),
        2,
        "expected one row per region, not a cartesian product"
    );

    // Collect region -> (budget, sales, returns).
    let region = combined
        .column(combined.schema().index_of("region").unwrap())
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    let f64col = |name: &str| {
        let idx = combined.schema().index_of(name).unwrap();
        let cast = arrow::compute::cast(combined.column(idx), &DataType::Float64).unwrap();
        cast.as_any()
            .downcast_ref::<Float64Array>()
            .unwrap()
            .clone()
    };
    let budget = f64col("budget");
    let sales = f64col("sales");
    let returns = f64col("returns");

    for i in 0..combined.num_rows() {
        let r = region.value(i);
        // budget is a scalar broadcast to every region row.
        assert_eq!(budget.value(i), 12.0, "budget broadcast for {r}");
        match r {
            "West" => {
                assert_eq!(sales.value(i), 100.0);
                assert_eq!(
                    returns.value(i),
                    10.0,
                    "returns aligned to West, not fanned out"
                );
            }
            "East" => {
                assert_eq!(sales.value(i), 200.0);
                assert_eq!(
                    returns.value(i),
                    20.0,
                    "returns aligned to East, not fanned out"
                );
            }
            other => panic!("unexpected region {other}"),
        }
    }
}

#[tokio::test]
async fn multi_fact_combine_unifies_a_null_conformed_dimension_member() {
    use arrow::array::Array;

    // dim_geo with a NULL-region member (id 3) referenced by BOTH facts. Grouped
    // by region, the NULL group must be ONE unified row carrying both measures —
    // a plain `=` join (NULL = NULL is NULL) would split it into two half-blank
    // rows (a silently-wrong number).
    let model = conformed_dim_model();
    let mut cache = InMemoryCache::new();
    cache
        .store(
            "dim_geo",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("id", DataType::Int64, true),
                    Field::new("region", DataType::Utf8, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1i64, 2, 3])),
                    Arc::new(StringArray::from(vec![Some("West"), Some("East"), None])),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    cache
        .store(
            "fact_sales",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("geo_id", DataType::Int64, true),
                    Field::new("amount_s", DataType::Float64, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1i64, 2, 3])),
                    Arc::new(Float64Array::from(vec![100.0, 200.0, 50.0])),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    cache
        .store(
            "fact_returns",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("geo_id", DataType::Int64, true),
                    Field::new("amount_r", DataType::Float64, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1i64, 2, 3])),
                    Arc::new(Float64Array::from(vec![10.0, 20.0, 5.0])),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    let mut registry = SourceRegistry::new();
    for t in ["dim_geo", "fact_sales", "fact_returns"] {
        registry.bind(t, 0, SourceBinding::new("public", t));
    }
    let req = QueryRequest {
        measures: vec!["sales".into(), "returns".into()],
        group_by: vec![ColumnRef::new("dim_geo", "region")],
        ..Default::default()
    };
    let plan = PushdownPlanner::plan(&req, &model, &registry, &[]).unwrap();
    let batches = QueryExecutor::execute(&plan, &model, &registry, Some(&cache), None, None, &[])
        .await
        .unwrap();
    let combined = concat_batches(&batches[0].schema(), &batches).unwrap();

    assert_eq!(
        combined.num_rows(),
        3,
        "West, East, and ONE unified NULL-region row — not a split"
    );
    let region = combined.column(combined.schema().index_of("region").unwrap());
    let f64col = |name: &str| {
        let idx = combined.schema().index_of(name).unwrap();
        arrow::compute::cast(combined.column(idx), &DataType::Float64)
            .unwrap()
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap()
            .clone()
    };
    let sales = f64col("sales");
    let returns = f64col("returns");
    let null_rows: Vec<usize> = (0..combined.num_rows())
        .filter(|&i| region.is_null(i))
        .collect();
    assert_eq!(null_rows.len(), 1, "the NULL region is a single combined row");
    let r = null_rows[0];
    assert_eq!(sales.value(r), 50.0, "NULL-region sales present");
    assert_eq!(returns.value(r), 5.0, "NULL-region returns present on same row");
}
