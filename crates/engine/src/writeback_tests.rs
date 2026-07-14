//! End-to-end tests for writeback columns through the Engine facade: host
//! feeds via `set_writeback_data`, projection via
//! `project_writeback_current`, the generated lookup column joining the
//! current store, measures over it, empty-store seeding, and the schema gate.
//!
//! Fixture: `dim_customer(ID, Name)` with writeback column `Forecast`
//! (Float64, keyed by ID). Host rows: (1, "Alice"), (2, "Bob"), (3, "Cara").

use std::sync::Arc;

use arrow::array::{Array, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Schema};
use arrow::record_batch::RecordBatch;

use crate::{
    parse_measure_expression, AggregateOp, Column, ColumnRef, DataModel, DataType, Engine,
    Expression, Measure, QueryRequest, SourceBinding, StorageMode, Table, WritebackColumn,
    WritebackProjection, WritebackSlot,
};

const WB_ID: &str = "wb-forecast-1";
/// Synthesized store names (hyphen-stripped id).
const HIST: &str = "__wb_wbforecast1_hist";

fn model(projection: WritebackProjection) -> DataModel {
    DataModel::builder()
        .add_table(
            Table::new(
                "dim_customer",
                vec![
                    Column::new("ID", DataType::Int64),
                    Column::new("Name", DataType::String),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_writeback_column(
            WritebackColumn::new(
                WB_ID,
                "Forecast",
                "dim_customer",
                DataType::Float64,
                vec!["ID".to_string()],
            )
            .with_projection(projection),
        )
        .add_measure(Measure::new(
            "ForecastTotal",
            parse_measure_expression("SUM(dim_customer[Forecast])").unwrap(),
        ))
        // Row counter over the history store, for querying it directly.
        .add_measure(Measure::new(
            "HistRows",
            Expression::Aggregate {
                operation: AggregateOp::CountRows,
                operand: Box::new(Expression::TableRef(HIST.to_string())),
            },
        ))
        .build()
        .unwrap()
}

fn engine_with_hosts(projection: WritebackProjection) -> Engine {
    let mut engine = Engine::new(model(projection));
    // The planner resolves fetch targets from bindings for physical tables
    // (the executor then serves the cached batch); same dummy binding as the
    // other engine test fixtures. Store tables need no binding by design.
    engine.bind_table("dim_customer", 0, SourceBinding::new("public", "dim_customer"));
    engine
        .cache
        .store(
            "dim_customer",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("ID", ArrowType::Int64, true),
                    Field::new("Name", ArrowType::Utf8, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1, 2, 3])),
                    Arc::new(StringArray::from(vec!["Alice", "Bob", "Cara"])),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    engine
}

/// Build a current-slot batch (ID + value) against the declared store schema.
fn current_batch(engine: &Engine, rows: &[(i64, f64)]) -> RecordBatch {
    let schema = Arc::new(
        engine
            .writeback_slot_schema(WB_ID, WritebackSlot::Current)
            .unwrap(),
    );
    RecordBatch::try_new(
        schema,
        vec![
            Arc::new(Int64Array::from(
                rows.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
            )),
            Arc::new(Float64Array::from(
                rows.iter().map(|(_, v)| *v).collect::<Vec<_>>(),
            )),
        ],
    )
    .unwrap()
}

/// Feed a history batch of (ID, value, submitted_at, state) rows.
fn feed_history(engine: &mut Engine, rows: &[(i64, Option<f64>, &str, &str)]) {
    let schema = Arc::new(
        engine
            .writeback_slot_schema(WB_ID, WritebackSlot::History)
            .unwrap(),
    );
    let hist = RecordBatch::try_new(
        schema,
        vec![
            Arc::new(Int64Array::from(
                rows.iter().map(|(id, ..)| *id).collect::<Vec<_>>(),
            )),
            Arc::new(Float64Array::from(
                rows.iter().map(|(_, v, ..)| *v).collect::<Vec<_>>(),
            )),
            Arc::new(StringArray::from(vec!["u1"; rows.len()])),
            Arc::new(StringArray::from(vec!["User One"; rows.len()])),
            Arc::new(StringArray::from(
                rows.iter().map(|(_, _, at, _)| *at).collect::<Vec<_>>(),
            )),
            Arc::new(StringArray::from(
                rows.iter().map(|(.., st)| *st).collect::<Vec<_>>(),
            )),
        ],
    )
    .unwrap();
    engine
        .set_writeback_data(WB_ID, WritebackSlot::History, hist)
        .unwrap();
}

fn forecast_by_name(batches: &[RecordBatch]) -> Vec<(String, Option<f64>)> {
    let mut out = Vec::new();
    for b in batches {
        let ni = b.schema().index_of("Name").unwrap();
        let fi = b.schema().index_of("Forecast").unwrap();
        let names = b.column(ni);
        let fores = b
            .column(fi)
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap()
            .clone();
        for row in 0..b.num_rows() {
            let name = if let Some(a) = names.as_any().downcast_ref::<StringArray>() {
                a.value(row).to_string()
            } else {
                // Dictionary-encoded after optimization.
                use arrow::array::DictionaryArray;
                use arrow::datatypes::Int32Type;
                let d = names
                    .as_any()
                    .downcast_ref::<DictionaryArray<Int32Type>>()
                    .unwrap();
                let vals = d.values().as_any().downcast_ref::<StringArray>().unwrap();
                vals.value(d.key(row).unwrap()).to_string()
            };
            let v = if fores.is_null(row) {
                None
            } else {
                Some(fores.value(row))
            };
            out.push((name, v));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Group by (Name, Forecast) with a measure (the engine requires one).
async fn forecast_rows(engine: &mut Engine) -> Vec<(String, Option<f64>)> {
    let request = QueryRequest {
        measures: vec!["ForecastTotal".to_string()],
        group_by: vec![
            ColumnRef::new("dim_customer", "Name"),
            ColumnRef::new("dim_customer", "Forecast"),
        ],
        ..Default::default()
    };
    let (batches, _) = engine.query_auto_refresh(request).await.unwrap();
    forecast_by_name(&batches)
}

// Uncached stores are seeded EMPTY by refresh_stale, so querying the
// generated column before any host feed yields NULLs, not an error.
#[tokio::test]
async fn unfed_store_yields_nulls() {
    let mut engine = engine_with_hosts(WritebackProjection::Latest);
    let rows = forecast_rows(&mut engine).await;
    assert_eq!(rows.len(), 3);
    assert!(rows.iter().all(|(_, v)| v.is_none()));
}

// Feeding the current store makes values appear through the generated
// LOOKUPVALUE column; keys without a value stay NULL; measures aggregate.
#[tokio::test]
async fn fed_values_join_and_aggregate() {
    let mut engine = engine_with_hosts(WritebackProjection::Latest);
    let batch = current_batch(&engine, &[(1, 42.5), (3, 7.5)]);
    engine
        .set_writeback_data(WB_ID, WritebackSlot::Current, batch)
        .unwrap();

    assert_eq!(
        forecast_rows(&mut engine).await,
        vec![
            ("Alice".to_string(), Some(42.5)),
            ("Bob".to_string(), None),
            ("Cara".to_string(), Some(7.5)),
        ]
    );

    let measure_request = QueryRequest {
        measures: vec!["ForecastTotal".to_string()],
        ..Default::default()
    };
    let (batches, _) = engine.query_auto_refresh(measure_request).await.unwrap();
    let total = batches[0]
        .column(batches[0].schema().index_of("ForecastTotal").unwrap())
        .as_any()
        .downcast_ref::<Float64Array>()
        .unwrap()
        .value(0);
    assert_eq!(total, 50.0);

    // Re-feeding replaces the current values.
    let batch = current_batch(&engine, &[(2, 100.0)]);
    engine
        .set_writeback_data(WB_ID, WritebackSlot::Current, batch)
        .unwrap();
    assert_eq!(
        forecast_rows(&mut engine).await,
        vec![
            ("Alice".to_string(), None),
            ("Bob".to_string(), Some(100.0)),
            ("Cara".to_string(), None),
        ]
    );
}

// The history store is an ordinary queryable table: feed it and group by its
// columns (the "full history of a row" report).
#[tokio::test]
async fn history_store_is_queryable() {
    let mut engine = engine_with_hosts(WritebackProjection::Latest);
    feed_history(
        &mut engine,
        &[
            (1, Some(40.0), "2026-07-01T10:00:00Z", "submitted"),
            (1, Some(42.5), "2026-07-02T10:00:00Z", "submitted"),
        ],
    );

    let request = QueryRequest {
        measures: vec!["HistRows".to_string()],
        group_by: vec![
            ColumnRef::new(HIST, "submitted_at"),
            ColumnRef::new(HIST, "value"),
        ],
        ..Default::default()
    };
    let (batches, _) = engine.query_auto_refresh(request).await.unwrap();
    let total_rows: usize = batches.iter().map(|b| b.num_rows()).sum();
    assert_eq!(total_rows, 2);
}

// Latest projection: newest applicable entry per key wins; a cleared (NULL)
// winner removes the key; rejected/draft entries never count.
#[tokio::test]
async fn latest_projection_from_history() {
    let mut engine = engine_with_hosts(WritebackProjection::Latest);
    feed_history(
        &mut engine,
        &[
            (1, Some(10.0), "2026-07-01T10:00:00Z", "submitted"),
            (1, Some(42.5), "2026-07-03T10:00:00Z", "submitted"), // newest for ID 1
            (2, Some(5.0), "2026-07-01T10:00:00Z", "submitted"),
            (2, None, "2026-07-04T10:00:00Z", "submitted"), // cleared -> key removed
            (3, Some(99.0), "2026-07-02T10:00:00Z", "rejected"), // never counts
        ],
    );
    engine.project_writeback_current(WB_ID, None).await.unwrap();
    assert_eq!(
        forecast_rows(&mut engine).await,
        vec![
            ("Alice".to_string(), Some(42.5)),
            ("Bob".to_string(), None),
            ("Cara".to_string(), None),
        ]
    );
}

// Blank projection: only entries at/after the session floor show; a None
// floor (fresh reload) clears the column while history stays intact.
#[tokio::test]
async fn blank_projection_respects_session_floor() {
    let mut engine = engine_with_hosts(WritebackProjection::Blank);
    feed_history(
        &mut engine,
        &[
            (1, Some(10.0), "2026-07-01T10:00:00Z", "submitted"), // pre-session
            (2, Some(20.0), "2026-07-12T09:00:00Z", "submitted"), // this session
        ],
    );

    engine
        .project_writeback_current(WB_ID, Some("2026-07-12T00:00:00Z"))
        .await
        .unwrap();
    assert_eq!(
        forecast_rows(&mut engine).await,
        vec![
            ("Alice".to_string(), None), // pre-session entry hidden
            ("Bob".to_string(), Some(20.0)),
            ("Cara".to_string(), None),
        ]
    );

    // Reload: no floor -> everything blank, history untouched.
    engine.project_writeback_current(WB_ID, None).await.unwrap();
    assert!(forecast_rows(&mut engine)
        .await
        .iter()
        .all(|(_, v)| v.is_none()));
}

// Expression projection: designer aggregation over `history[...]` refs.
#[tokio::test]
async fn expression_projection_runs_designer_aggregate() {
    let mut engine = engine_with_hosts(WritebackProjection::Expression(
        "MAX(history[value])".to_string(),
    ));
    feed_history(
        &mut engine,
        &[
            (1, Some(10.0), "2026-07-01T10:00:00Z", "submitted"),
            (1, Some(42.5), "2026-07-02T10:00:00Z", "submitted"),
            (1, Some(30.0), "2026-07-03T10:00:00Z", "submitted"),
            (2, Some(5.0), "2026-07-01T10:00:00Z", "submitted"),
        ],
    );
    engine.project_writeback_current(WB_ID, None).await.unwrap();
    assert_eq!(
        forecast_rows(&mut engine).await,
        vec![
            ("Alice".to_string(), Some(42.5)), // MAX over ID 1's history
            ("Bob".to_string(), Some(5.0)),
            ("Cara".to_string(), None),
        ]
    );
}

// The schema gate rejects drifted feeds and unknown ids.
#[tokio::test]
async fn feed_schema_gate() {
    let mut engine = engine_with_hosts(WritebackProjection::Latest);

    // Wrong columns for the slot.
    let wrong = RecordBatch::try_new(
        Arc::new(Schema::new(vec![Field::new("bogus", ArrowType::Int64, true)])),
        vec![Arc::new(Int64Array::from(vec![1]))],
    )
    .unwrap();
    assert!(engine
        .set_writeback_data(WB_ID, WritebackSlot::Current, wrong)
        .is_err());

    // Unknown writeback id.
    let batch = current_batch(&engine, &[(1, 1.0)]);
    assert!(engine
        .set_writeback_data("no-such-id", WritebackSlot::Current, batch)
        .is_err());

    // Zero-row feed clears the store instead of erroring.
    let empty = current_batch(&engine, &[]);
    engine
        .set_writeback_data(WB_ID, WritebackSlot::Current, empty)
        .unwrap();
}
