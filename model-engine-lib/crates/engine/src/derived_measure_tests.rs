//! Regression: a DERIVED measure — one whose expression reaches its fact table
//! only through `[MeasureRef]`s (`[Revenue] - [Cost]`, `DIVIDE([Margin],
//! [Revenue])`, `GVAR total = [Revenue] RETURN [Revenue] / total`) — must query
//! when the model arrived through serde, the way every host load path builds
//! it (`serde_json::from_value::<DataModel>` + `validate()` + `Engine::new`).
//!
//! `Measure::cached_table` is `#[serde(skip)]` and re-inferred from the
//! expression alone on deserialization, and `infer_fact_table` cannot see
//! through a measure reference, so such a measure deserializes with an empty
//! home table. The planner then listed `""` among the tables to fetch and
//! refused the whole query with `SourceNotRegistered("")` — found live by the
//! Calcula insights route on the sales-star fixture (`Margin`, `MarginPct`) and
//! on an AdventureWorks model (`% Revenue of Total`). The engine's own
//! `Engine::load_model` resolves home tables after deserialization
//! (`reparse_measures_from_source`); nothing resolved them for a model built
//! any other way.
//!
//! The GVAR case covers a SECOND gap: `query_auto_refresh` — the entry point
//! the host's `bi_query`, insights and MCP use — skipped the facade's
//! query-scoped-binding resolution that `query` / `query_with_cancellation` /
//! `query_explained` run, so a GVAR measure reached the executor unresolved
//! on that path alone.
//!
//! Fixture (the GVAR tests'): `Sales(prod_id, amount, cost)` -> `Product(id,
//! name)`; per product SUM(amount): Bikes 130, Helmets 60; SUM(cost): Bikes 75,
//! Helmets 35.

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{Array, DictionaryArray, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Int32Type, Schema};
use arrow::record_batch::RecordBatch;

use crate::{
    parse_measure_expression, sum_measure, CalculationGroup, CalculationGroupApplication,
    CalculationItem, Column, ColumnRef, DataModel, DataModelBuilder, DataType, Engine, Measure,
    QueryRequest, Relationship, SourceBinding, StorageMode, Table,
};

fn measure_from(name: &str, text: &str) -> Measure {
    Measure::new(name, parse_measure_expression(text).unwrap()).with_source(text)
}

/// The star, built through the builder — and then ROUND-TRIPPED through
/// JSON, which is the host's construction path (`bi_model_new` serialises a
/// built model and every load site deserialises one). The round trip is what
/// drops the derived measures' home tables.
fn json_loaded_model() -> DataModel {
    round_trip(base_builder().build().unwrap())
}

/// The host's path: serialise, deserialise, `validate()`.
fn round_trip(built: DataModel) -> DataModel {
    let json = serde_json::to_value(&built).expect("a built model serialises");
    let model: DataModel = serde_json::from_value(json).expect("and deserialises");
    model.validate().expect("validate() passes: the builder skips MeasureRef measures");
    model
}

/// The tables, the relationship and the five measures; tests add to it.
fn base_builder() -> DataModelBuilder {
    DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("prod_id", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                    Column::new("cost", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_table(
            Table::new(
                "Product",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("name", DataType::String),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_relationship(Relationship::many_to_one(
            "Sales_Product",
            "Sales",
            "prod_id",
            "Product",
            "id",
        ))
        .add_measure(sum_measure("Revenue", "Sales", "amount"))
        .add_measure(sum_measure("Cost", "Sales", "cost"))
        // Every leaf is a measure reference: no column of its own.
        .add_measure(measure_from("Margin", "[Revenue] - [Cost]"))
        // Transitive: reaches the fact only through Margin.
        .add_measure(measure_from("MarginPct", "DIVIDE([Margin], [Revenue])"))
        // The %-of-total shape: a GVAR bound to a measure reference.
        .add_measure(measure_from(
            "PctOfTotal",
            "GVAR total = [Revenue] RETURN DIVIDE([Revenue], total)",
        ))
}

fn engine_over(model: DataModel) -> Engine {
    let mut engine = Engine::new(model);
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    engine.bind_table("Product", 0, SourceBinding::new("public", "product"));
    engine
        .cache
        .store(
            "Sales",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("prod_id", ArrowType::Int64, true),
                    Field::new("amount", ArrowType::Float64, true),
                    Field::new("cost", ArrowType::Float64, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1, 2, 1, 2])),
                    Arc::new(Float64Array::from(vec![100.0, 40.0, 30.0, 20.0])),
                    Arc::new(Float64Array::from(vec![60.0, 25.0, 15.0, 10.0])),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    engine
        .cache
        .store(
            "Product",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("id", ArrowType::Int64, true),
                    Field::new("name", ArrowType::Utf8, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1, 2])),
                    Arc::new(StringArray::from(vec!["Bikes", "Helmets"])),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    engine
}

fn col_idx(batch: &RecordBatch, name: &str) -> usize {
    batch
        .schema()
        .index_of(name)
        .unwrap_or_else(|_| panic!("column '{name}' not found in {:?}", batch.schema()))
}

fn as_f64(array: &dyn Array, row: usize) -> f64 {
    if let Some(a) = array.as_any().downcast_ref::<Float64Array>() {
        a.value(row)
    } else if let Some(a) = array.as_any().downcast_ref::<Int64Array>() {
        a.value(row) as f64
    } else {
        panic!("unexpected measure array type: {:?}", array.data_type());
    }
}

/// `name -> measure` over all result rows (handles dictionary-encoded names).
fn grouped(batches: &[RecordBatch], measure_col: &str) -> HashMap<String, f64> {
    let mut out = HashMap::new();
    for b in batches {
        let g = b.column(col_idx(b, "name"));
        let m = b.column(col_idx(b, measure_col));
        for row in 0..b.num_rows() {
            let key = if let Some(a) = g.as_any().downcast_ref::<StringArray>() {
                a.value(row).to_string()
            } else if let Some(a) = g.as_any().downcast_ref::<DictionaryArray<Int32Type>>() {
                let values = a.values().as_any().downcast_ref::<StringArray>().unwrap();
                values.value(a.key(row).unwrap()).to_string()
            } else {
                panic!("unexpected group array type: {:?}", g.data_type());
            };
            out.insert(key, as_f64(m.as_ref(), row));
        }
    }
    out
}

fn request(measure: &str) -> QueryRequest {
    QueryRequest {
        measures: vec![measure.into()],
        group_by: vec![ColumnRef::new("Product", "name")],
        ..Default::default()
    }
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

// --- The round trip is the premise: it really does drop the home tables ---

#[test]
fn the_json_round_trip_drops_every_derived_measures_home_table() {
    // Documents the mechanism the tests below guard against. If this ever
    // starts failing because deserialization resolves on its own, the guards
    // below still hold and this test can go.
    let json = serde_json::to_value(
        &DataModel::builder()
            .add_table(
                Table::new("Sales", vec![Column::new("amount", DataType::Float64)]).unwrap(),
            )
            .add_measure(sum_measure("Revenue", "Sales", "amount"))
            .add_measure(measure_from("Doubled", "[Revenue] * 2"))
            .build()
            .unwrap(),
    )
    .unwrap();
    let raw: DataModel = serde_json::from_value(json).unwrap();
    assert_eq!(raw.measure("Revenue").unwrap().table(), "Sales");
    assert_eq!(
        raw.measure("Doubled").unwrap().table(),
        "",
        "a bare deserialization cannot see through a measure reference"
    );
}

// --- The guards ---

#[test]
fn an_installed_model_reports_a_derived_measures_home_table() {
    // Hosts read `engine.model().measures()[i].table()` for their field lists
    // (Calcula's pivot showed `table=` for Margin). Installing a model on an
    // engine — by construction or by `set_model` — must leave every derived
    // measure with the home table of the measures it builds on, transitively.
    let engine = Engine::new(json_loaded_model());
    let model = engine.model();
    assert_eq!(model.measure("Margin").unwrap().table(), "Sales");
    assert_eq!(model.measure("MarginPct").unwrap().table(), "Sales");
    assert_eq!(model.measure("PctOfTotal").unwrap().table(), "Sales");

    let mut again = Engine::new(json_loaded_model());
    again.set_model(json_loaded_model()).unwrap();
    assert_eq!(again.model().measure("Margin").unwrap().table(), "Sales");
}

#[tokio::test]
async fn a_json_loaded_derived_measure_queries_on_the_query_path() {
    // The pivot's route: query_with_meta -> query -> query_with_cancellation.
    let engine = engine_over(json_loaded_model());
    let r = grouped(&engine.query(request("Margin")).await.unwrap(), "Margin");
    assert!(close(r["Bikes"], 130.0 - 75.0), "got {:?}", r);
    assert!(close(r["Helmets"], 60.0 - 35.0), "got {:?}", r);
}

#[tokio::test]
async fn a_json_loaded_chained_derived_measure_resolves_transitively() {
    // MarginPct reaches the fact only through Margin, which is itself derived.
    let engine = engine_over(json_loaded_model());
    let r = grouped(
        &engine.query(request("MarginPct")).await.unwrap(),
        "MarginPct",
    );
    assert!(close(r["Bikes"], 55.0 / 130.0), "got {:?}", r);
    assert!(close(r["Helmets"], 25.0 / 60.0), "got {:?}", r);
}

#[tokio::test]
async fn a_json_loaded_derived_measure_queries_on_the_auto_refresh_path() {
    // The host's bi_query / insights / MCP route.
    let mut engine = engine_over(json_loaded_model());
    let (batches, _refreshed) = engine.query_auto_refresh(request("Margin")).await.unwrap();
    let r = grouped(&batches, "Margin");
    assert!(close(r["Bikes"], 55.0), "got {:?}", r);
    assert!(close(r["Helmets"], 25.0), "got {:?}", r);
}

#[tokio::test]
async fn a_gvar_measure_over_a_measure_ref_queries_on_the_auto_refresh_path() {
    // Two gaps at once: the home table (a GVAR over [Revenue] has no column of
    // its own) and the auto-refresh path's missing GVAR resolution. `query`
    // already passes this shape (gvar_tests::PctViaMeasureRef); the host's
    // insights route does not go through `query`.
    let mut engine = engine_over(json_loaded_model());
    let (batches, _refreshed) = engine
        .query_auto_refresh(request("PctOfTotal"))
        .await
        .unwrap();
    let r = grouped(&batches, "PctOfTotal");
    assert!(close(r["Bikes"], 130.0 / 190.0), "got {:?}", r);
    assert!(close(r["Helmets"], 60.0 / 190.0), "got {:?}", r);
}

#[tokio::test]
async fn a_derived_measure_under_a_calculation_group_queries() {
    // A calculation item is applied to the base measure's UNEXPANDED
    // expression (`calculation_group.rs`, `substitute_selected_measure`), so
    // the synthetic "Margin [Doubled]" has no column of its own and an empty
    // table even after install; the planner's per-request resolution is what
    // rescues it — on both paths.
    let model = round_trip(
        base_builder()
            .add_calculation_group(CalculationGroup::new(
                "Time",
                vec![
                    CalculationItem::from_text("Current", "SELECTEDMEASURE()").unwrap(),
                    CalculationItem::from_text("Doubled", "SELECTEDMEASURE() * 2").unwrap(),
                ],
            ))
            .build()
            .unwrap(),
    );
    let mut engine = engine_over(model);
    let req = QueryRequest {
        calculation_group: Some(CalculationGroupApplication::new("Time", vec![])),
        ..request("Margin")
    };
    let batches = engine.query(req.clone()).await.unwrap();
    let current = grouped(&batches, "Margin [Current]");
    let doubled = grouped(&batches, "Margin [Doubled]");
    assert!(close(current["Bikes"], 55.0) && close(current["Helmets"], 25.0), "{current:?}");
    assert!(close(doubled["Bikes"], 110.0) && close(doubled["Helmets"], 50.0), "{doubled:?}");

    let (batches, _) = engine.query_auto_refresh(req).await.unwrap();
    let doubled = grouped(&batches, "Margin [Doubled]");
    assert!(close(doubled["Bikes"], 110.0) && close(doubled["Helmets"], 50.0), "{doubled:?}");
}

#[tokio::test]
async fn a_derived_measure_carrying_isfiltered_queries() {
    // The ISFILTERED fold rebuilds the measure from its UNEXPANDED folded
    // expression, so the overlay measure is derived and tableless again; the
    // planner's per-request resolution rescues it.
    let model = round_trip(
        base_builder()
            .add_measure(measure_from(
                "Flag",
                "IF(ISFILTERED(Product[name]), [Revenue], [Cost])",
            ))
            .build()
            .unwrap(),
    );
    let mut engine = engine_over(model);
    // Grouped by Product[name]: the marker folds to TRUE -> Revenue.
    let r = grouped(&engine.query(request("Flag")).await.unwrap(), "Flag");
    assert!(close(r["Bikes"], 130.0) && close(r["Helmets"], 60.0), "{r:?}");
    // The same through the auto-refresh path (the query cache is off by
    // default, so this plans again rather than replaying the result above).
    let (batches, _) = engine.query_auto_refresh(request("Flag")).await.unwrap();
    let r = grouped(&batches, "Flag");
    assert!(close(r["Bikes"], 130.0) && close(r["Helmets"], 60.0), "{r:?}");
    // No group-by: the marker folds to FALSE -> Cost, one scalar row.
    let batches = engine
        .query(QueryRequest { measures: vec!["Flag".into()], ..Default::default() })
        .await
        .unwrap();
    let b = &batches[0];
    assert_eq!(b.num_rows(), 1);
    assert!(close(as_f64(b.column(col_idx(b, "Flag")).as_ref(), 0), 110.0));
}

#[tokio::test]
async fn the_pre_plan_chain_borrows_when_nothing_applies() {
    // The common case — no marker, no GVAR, no calculation group on the
    // request — must clone neither the model nor the request. (Margin is
    // derived; that is the planner's business, not the overlay chain's.)
    let engine = engine_over(json_loaded_model());
    let req = request("Margin");
    let token = tokio_util::sync::CancellationToken::new();
    let (model, effective) = engine
        .resolve_pre_plan_overlays(&req, &[], &token)
        .await
        .unwrap();
    assert!(matches!(model, std::borrow::Cow::Borrowed(_)), "the model was cloned for nothing");
    assert!(matches!(effective, std::borrow::Cow::Borrowed(_)), "the request was cloned for nothing");
}

#[tokio::test]
async fn a_gvar_measure_over_a_measure_ref_queries_on_the_query_path_from_json() {
    // The pivot's route, on the JSON-loaded model (the GVAR tests build theirs
    // through the builder, where the facade overlay repairs the table).
    let engine = engine_over(json_loaded_model());
    let r = grouped(
        &engine.query(request("PctOfTotal")).await.unwrap(),
        "PctOfTotal",
    );
    assert!(close(r["Bikes"], 130.0 / 190.0), "got {:?}", r);
    assert!(close(r["Helmets"], 60.0 / 190.0), "got {:?}", r);
}
