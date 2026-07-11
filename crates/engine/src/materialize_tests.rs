//! End-to-end tests for MATERIALIZED calculated tables.
//!
//! A materialized calculated table (`GlobalVariable` with `dynamic == false`)
//! becomes a real derived model table: synthesized at build from the QUERY's
//! inferred schema, populated at refresh by evaluating the QUERY over the
//! unfiltered model. These tests prove the full path against a cache-served
//! in-memory star schema: build-time synthesis, materialization, querying the
//! derived table like any table, refresh_stale ordering, mode flips, and
//! cycle rejection.
//!
//! Fixture: `Sales(prod_id, amount)` → `Product(id, name)`; the calculated
//! table is `prod_sales = QUERY(SUM(Sales[amount]) AS Amt BY Product[name])`.
//! Per product — SUM(amount): Bikes 130, Helmets 60.

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{Array, DictionaryArray, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Int32Type, Schema};
use arrow::record_batch::RecordBatch;

use crate::{
    parse_measure_expression, Column, ColumnRef, DataModel, DataType, Engine, GlobalVariable,
    Measure, QueryRequest, Relationship, SourceBinding, StorageMode, Table,
};

fn measure_from(name: &str, text: &str) -> Measure {
    Measure::new(name, parse_measure_expression(text).unwrap()).with_source(text)
}

fn prod_sales_gv(dynamic: bool) -> GlobalVariable {
    GlobalVariable::new(
        "prod_sales",
        "Sales",
        parse_measure_expression("QUERY(SUM(Sales[amount]) AS Amt BY Product[name])").unwrap(),
    )
    .with_dynamic(dynamic)
}

fn star_model(gv: GlobalVariable) -> DataModel {
    DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("prod_id", DataType::Int64),
                    Column::new("amount", DataType::Float64),
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
        .add_global_variable(gv)
        // A measure over the derived table — resolves like any table measure.
        .add_measure(measure_from("ProdSalesTotal", "SUM(prod_sales[Amt])"))
        .build()
        .unwrap()
}

fn star_engine(model: DataModel) -> Engine {
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
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1, 2, 1, 2])),
                    Arc::new(Float64Array::from(vec![100.0, 40.0, 30.0, 20.0])),
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

/// `group -> measure` over all result rows (handles dictionary-encoded names).
fn grouped(batches: &[RecordBatch], group_col: &str, measure_col: &str) -> HashMap<String, f64> {
    let mut out = HashMap::new();
    for b in batches {
        let g = b.column(col_idx(b, group_col));
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

// --- Build-time synthesis ---

#[test]
fn build_synthesizes_derived_table() {
    let model = star_model(prod_sales_gv(false));
    let derived = model.table("prod_sales").expect("derived table exists");
    assert!(derived.is_calculated());
    assert!(derived.is_in_memory());
    let cols: Vec<(&str, DataType)> = derived
        .columns()
        .iter()
        .map(|c| (c.name(), c.data_type().clone()))
        .collect();
    assert_eq!(
        cols,
        vec![("name", DataType::String), ("Amt", DataType::Float64)]
    );
}

#[test]
fn dynamic_calculated_table_synthesizes_nothing() {
    let model = star_model(prod_sales_gv(true));
    assert!(model.table("prod_sales").is_err());
}

#[test]
fn mode_flip_reconciles_derived_table() {
    let model = star_model(prod_sales_gv(true));
    // dynamic -> materialized: derived table appears.
    let materialized = model
        .with_global_variables(vec![prod_sales_gv(false)])
        .unwrap();
    assert!(materialized.table("prod_sales").is_ok());
    assert!(materialized.validate().is_ok());
    // materialized -> dynamic: derived table disappears again.
    let dynamic = materialized
        .with_global_variables(vec![prod_sales_gv(true)])
        .unwrap();
    assert!(dynamic.table("prod_sales").is_err());
}

#[test]
fn relationship_to_derived_table_validates() {
    // A relationship can bind the derived table like any table.
    let model = star_model(prod_sales_gv(false));
    let with_rel = model.with_relationships(
        model
            .relationships()
            .iter()
            .cloned()
            .chain(std::iter::once(Relationship::many_to_one(
                "ProdSales_Product",
                "prod_sales",
                "name",
                "Product",
                "name",
            )))
            .collect(),
    );
    assert!(with_rel.validate().is_ok());
}

#[test]
fn mode_flip_to_dynamic_fails_closed_on_bound_relationship() {
    // With a relationship bound to the derived table, flipping the calculated
    // table back to dynamic drops the table — validate must reject the
    // dangling relationship instead of silently ignoring it.
    let model = star_model(prod_sales_gv(false));
    let with_rel = model.with_relationships(
        model
            .relationships()
            .iter()
            .cloned()
            .chain(std::iter::once(Relationship::many_to_one(
                "ProdSales_Product",
                "prod_sales",
                "name",
                "Product",
                "name",
            )))
            .collect(),
    );
    assert!(with_rel.validate().is_ok());
    let flipped = with_rel
        .with_global_variables(vec![prod_sales_gv(true)])
        .unwrap();
    assert!(flipped.validate().is_err());
}

#[test]
fn materialized_cycle_rejected() {
    let a = GlobalVariable::new(
        "ct_a",
        "Sales",
        parse_measure_expression("QUERY(SUM(ct_b[Amt]) AS Amt BY ct_b[name])").unwrap(),
    )
    .with_dynamic(false);
    let b = GlobalVariable::new(
        "ct_b",
        "Sales",
        parse_measure_expression("QUERY(SUM(ct_a[Amt]) AS Amt BY ct_a[name])").unwrap(),
    )
    .with_dynamic(false);
    let err = DataModel::builder()
        .add_table(
            Table::new("Sales", vec![Column::new("amount", DataType::Float64)]).unwrap(),
        )
        .add_global_variable(a)
        .add_global_variable(b)
        .build()
        .unwrap_err()
        .to_string();
    assert!(err.contains("cycle"), "got: {err}");
}

// --- Materialization + querying ---

#[tokio::test]
async fn materialize_and_query_derived_table() {
    let mut engine = star_engine(star_model(prod_sales_gv(false)));
    engine.materialize_calculated_table("prod_sales").await.unwrap();
    assert!(engine.cache.contains("prod_sales"));

    // Group by the derived table's own column.
    let batches = engine
        .query(QueryRequest {
            measures: vec!["ProdSalesTotal".into()],
            group_by: vec![ColumnRef::new("prod_sales", "name")],
            ..Default::default()
        })
        .await
        .unwrap();
    let by_name = grouped(&batches, "name", "ProdSalesTotal");
    assert_eq!(by_name.get("Bikes"), Some(&130.0));
    assert_eq!(by_name.get("Helmets"), Some(&60.0));

    // Scalar over the derived table.
    let batches = engine
        .query(QueryRequest {
            measures: vec!["ProdSalesTotal".into()],
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(as_f64(batches[0].column(0).as_ref(), 0), 190.0);
}

#[tokio::test]
async fn materialize_rejects_dynamic_calculated_table() {
    let mut engine = star_engine(star_model(prod_sales_gv(true)));
    let err = engine
        .materialize_calculated_table("prod_sales")
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("dynamic"), "got: {err}");
}

#[tokio::test]
async fn refresh_stale_materializes_missing_calculated_table() {
    let mut engine = star_engine(star_model(prod_sales_gv(false)));
    assert!(!engine.cache.contains("prod_sales"));

    // Sales/Product are cached (not stale); only the calculated table needs work.
    let report = engine.refresh_stale().await.unwrap();
    assert_eq!(report.refreshed, vec!["prod_sales".to_string()]);
    assert!(report.failures.is_empty(), "got: {:?}", report.failures);
    assert!(engine.cache.contains("prod_sales"));

    // A second run has nothing to do: cache present, no source refreshed.
    let report = engine.refresh_stale().await.unwrap();
    assert!(report.refreshed.is_empty(), "got: {:?}", report.refreshed);
}

#[tokio::test]
async fn refresh_table_routes_calculated_table_to_materialization() {
    let mut engine = star_engine(star_model(prod_sales_gv(false)));
    engine.refresh_table("prod_sales").await.unwrap();
    assert!(engine.cache.contains("prod_sales"));

    let batches = engine
        .query(QueryRequest {
            measures: vec!["ProdSalesTotal".into()],
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(as_f64(batches[0].column(0).as_ref(), 0), 190.0);
}
