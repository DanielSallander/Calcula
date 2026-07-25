//! End-to-end tests for host-registered UDFs through the local-aggregation
//! pipeline: a measure calling a real DataFusion `ScalarUDF` is planned,
//! fetched from the in-memory cache, and evaluated by the executor.

use std::sync::Arc;

use arrow::array::Float64Array;
use arrow::compute::concat_batches;
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;

use engine_core::compute::aggregate::AggregateOp;
use engine_core::compute::expression::{self as expr};
use engine_core::compute::measure::expression_measure;
use engine_core::compute::udf::{create_udf, ColumnarValue, ScalarUDF, UdfRegistry, Volatility};
use engine_core::model::column::Column;
use engine_core::model::table::{StorageMode, Table};
use engine_core::model::DataModel;
use engine_core::store::InMemoryCache;
use engine_core::types::DataType as EngineDataType;

use crate::planner::{PushdownPlanner, QueryPlan};
use crate::registry::{SourceBinding, SourceRegistry};
use crate::request::{ColumnRef, QueryRequest};

use super::QueryExecutor;

/// `double(x) = x * 2` over Float64.
fn double_udf() -> ScalarUDF {
    create_udf(
        "double",
        vec![DataType::Float64],
        DataType::Float64,
        Volatility::Immutable,
        Arc::new(|args: &[ColumnarValue]| {
            let arrays = ColumnarValue::values_to_arrays(args)?;
            let input = arrays[0]
                .as_any()
                .downcast_ref::<Float64Array>()
                .ok_or_else(|| {
                    datafusion::error::DataFusionError::Internal(
                        "double: expected Float64 input".to_string(),
                    )
                })?;
            let out: Float64Array = input.iter().map(|v| v.map(|x| x * 2.0)).collect();
            Ok(ColumnarValue::Array(Arc::new(out)))
        }),
    )
}

/// In-memory single-table model with the measure
/// `Doubled = SUM(double(fact_sales[amount]))`. Amounts: 20 + 10 + 30 + 5 = 65.
fn fixture() -> (DataModel, InMemoryCache, SourceRegistry) {
    let table = Table::new(
        "fact_sales",
        vec![
            Column::new("region", EngineDataType::String),
            Column::new("amount", EngineDataType::Float64),
        ],
    )
    .unwrap()
    .with_storage_mode(StorageMode::InMemory);

    let model = DataModel::builder()
        .add_table(table)
        .add_measure(expression_measure(
            "Doubled",
            expr::agg(
                AggregateOp::Sum,
                expr::call("double", vec![expr::qualified_col("fact_sales", "amount")]),
            ),
        ))
        .build()
        .unwrap();

    let schema = Arc::new(Schema::new(vec![
        Field::new("region", DataType::Utf8, true),
        Field::new("amount", DataType::Float64, true),
    ]));
    let batch = RecordBatch::try_new(
        schema,
        vec![
            Arc::new(arrow::array::StringArray::from(vec![
                "West", "East", "South", "East",
            ])),
            Arc::new(Float64Array::from(vec![20.0, 10.0, 30.0, 5.0])),
        ],
    )
    .unwrap();
    let mut cache = InMemoryCache::new();
    cache.store("fact_sales", batch).unwrap();

    // Bind the table so the planner accepts it; the in-memory cache serves
    // the data, so no connector is ever contacted.
    let mut registry = SourceRegistry::new();
    registry.bind("fact_sales", 0, SourceBinding::new("public", "fact_sales"));

    (model, cache, registry)
}

fn scalar_result(batches: &[RecordBatch]) -> f64 {
    let combined = concat_batches(&batches[0].schema(), batches).unwrap();
    combined
        .column(0)
        .as_any()
        .downcast_ref::<Float64Array>()
        .unwrap()
        .value(0)
}

#[tokio::test]
async fn udf_measure_evaluates_through_full_pipeline() {
    let (model, cache, registry) = fixture();
    let mut udfs = UdfRegistry::new();
    udfs.register(double_udf(), 1).unwrap();

    let request = QueryRequest {
        measures: vec!["Doubled".into()],
        ..Default::default()
    };
    let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();
    assert!(
        matches!(plan, QueryPlan::LocalAggregation { .. }),
        "UDF measures must be evaluated locally"
    );

    let batches = QueryExecutor::execute(
        &plan,
        &model,
        &registry,
        Some(&cache),
        None,
        Some(&udfs),
        &[],
    )
    .await
    .unwrap();

    // SUM(double(amount)) = 2 * 65 = 130.
    assert!((scalar_result(&batches) - 130.0).abs() < 1e-9);
}

#[tokio::test]
async fn udf_measure_grouped_evaluates_through_full_pipeline() {
    let (model, cache, registry) = fixture();
    let mut udfs = UdfRegistry::new();
    udfs.register(double_udf(), 1).unwrap();

    let request = QueryRequest {
        measures: vec!["Doubled".into()],
        group_by: vec![ColumnRef::new("fact_sales", "region")],
        ..Default::default()
    };
    let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();
    let batches = QueryExecutor::execute(
        &plan,
        &model,
        &registry,
        Some(&cache),
        None,
        Some(&udfs),
        &[],
    )
    .await
    .unwrap();

    // Per-region: East 2*(10+5)=30, South 2*30=60, West 2*20=40 (group-by order).
    let combined = concat_batches(&batches[0].schema(), &batches).unwrap();
    let idx = combined.schema().index_of("Doubled").unwrap();
    let values: Vec<f64> = {
        let arr = combined
            .column(idx)
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap();
        (0..arr.len()).map(|i| arr.value(i)).collect()
    };
    assert_eq!(values, vec![30.0, 60.0, 40.0]);
}

#[tokio::test]
async fn udf_measure_without_registry_fails() {
    let (model, cache, registry) = fixture();

    let request = QueryRequest {
        measures: vec!["Doubled".into()],
        ..Default::default()
    };
    let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();
    let err = QueryExecutor::execute(&plan, &model, &registry, Some(&cache), None, None, &[])
        .await
        .unwrap_err();
    // Raw executor error (DataFusion cannot resolve the function). The
    // engine facade catches this earlier with the clearer
    // `EngineError::UnknownFunction` (see bi-engine tests).
    assert!(
        err.to_string().to_lowercase().contains("double"),
        "got: {err}"
    );
}
