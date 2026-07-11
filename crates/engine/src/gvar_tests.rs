//! End-to-end tests for query-scoped (`GVAR`) variables.
//!
//! A `GVAR` is evaluated **once per query context** — under the query's outer
//! filter/slicer context (and active RLS role) but with **no** group-by axis —
//! and substituted as a literal everywhere it is referenced. These tests prove
//! that semantics against a cache-served in-memory star schema so the whole
//! facade path (facade GVAR resolution → planner → executor) runs.
//!
//! Fixture: `Sales(prod_id, amount, cost)` → `Product(id, name)`.
//! Per product — SUM(amount): Bikes 130, Helmets 60; grand total 190.
//!
//! The canonical measure is "% of grand total":
//! ```text
//! GVAR grand = SUM(Sales[amount])            -- once per query = 190
//! RETURN DIVIDE(SUM(Sales[amount]), grand)   -- per group / 190
//! ```
//! Bikes → 130/190 ≈ 0.6842, Helmets → 60/190 ≈ 0.3158. Written with a plain
//! `VAR` instead, `grand` is inlined per group and the ratio is 1.0 everywhere —
//! the contrast test proves the difference.

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{Array, DictionaryArray, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Int32Type, Schema};
use arrow::record_batch::RecordBatch;

use crate::{
    parse_measure_expression, sum_measure, CalculationGroup, CalculationGroupApplication,
    CalculationItem, Column, ColumnRef, ComparisonOp, DataModel, DataType, Engine, FilterCondition,
    FilterOperator, GlobalVariable, Measure, QueryError, QueryRequest, Relationship, SecurityRole,
    SourceBinding, StorageMode, Table,
};

fn measure_from(name: &str, text: &str) -> Measure {
    Measure::new(name, parse_measure_expression(text).unwrap()).with_source(text)
}

fn gvar_model() -> DataModel {
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
        // Once-per-query % of grand total.
        .add_measure(measure_from(
            "PctOfTotal",
            "GVAR grand = SUM(Sales[amount]) RETURN DIVIDE(SUM(Sales[amount]), grand)",
        ))
        // Same shape with a plain VAR — inlined per group, so the ratio is 1.0.
        .add_measure(measure_from(
            "PctOfTotalVar",
            "VAR grand = SUM(Sales[amount]) RETURN DIVIDE(SUM(Sales[amount]), grand)",
        ))
        // A GVAR referencing an earlier GVAR.
        .add_measure(measure_from(
            "PctChained",
            "GVAR a = SUM(Sales[amount]) GVAR b = a RETURN DIVIDE(SUM(Sales[amount]), b)",
        ))
        // A per-row VAR referencing a GVAR (allowed direction).
        .add_measure(measure_from(
            "PctViaVarRef",
            "GVAR grand = SUM(Sales[amount]) VAR ratio = DIVIDE(SUM(Sales[amount]), grand) \
             RETURN ratio",
        ))
        // GVAR that resolves to BLANK (MAX over an empty context). The RETURN
        // branches on ISBLANK(mx): blank → SUM(amount) (130/60), else SUM(cost)
        // (75/35) — so the value proves mx was BLANK, and the RETURN still has a
        // real fact aggregate (a fact table can be inferred).
        .add_measure(measure_from(
            "BlankProbe",
            "GVAR mx = MAX(Sales[amount], KEEP(Product, Product[id] = 999)) \
             RETURN IF(ISBLANK(mx), SUM(Sales[amount]), SUM(Sales[cost]))",
        ))
        // GVAR bound to a MEASURE REFERENCE (the canonical %-of-total shape).
        .add_measure(measure_from(
            "PctViaMeasureRef",
            "GVAR total = [Revenue] RETURN DIVIDE([Revenue], total)",
        ))
        // Chained GVAR arithmetic over an earlier GVAR that is BLANK on an empty
        // context (b = a * 2 with a = MAX over nothing). Must not error.
        .add_measure(measure_from(
            "ChainedBlank",
            "GVAR a = MAX(Sales[amount], KEEP(Product, Product[id] = 999)) GVAR b = a * 2 \
             RETURN IF(ISBLANK(b), SUM(Sales[amount]), SUM(Sales[cost]))",
        ))
        // A user measure carrying the ephemeral inner-query name: GVAR
        // evaluation must uniquify around it (every GVAR test in this module
        // exercises the collision).
        .add_measure(sum_measure("__gvar_scalar__", "Sales", "cost"))
        // A constant date-function GVAR: folds via the shared incremental
        // machinery (DATE + DATEADD), no fact table needed in the binding.
        .add_measure(measure_from(
            "ConstDateGvar",
            "GVAR from_date = DATEADD(DATE(2000, 1, 1), 31, \"DAY\") \
             RETURN IF(ISBLANK(from_date), SUM(Sales[cost]), SUM(Sales[amount]))",
        ))
        // A model-level global variable, to prove GVAR names must not collide
        // with it (checked in validate_measure_text / build).
        .add_global_variable(GlobalVariable::new(
            "gv_total",
            "Sales",
            parse_measure_expression("SUM(Sales[amount])").unwrap(),
        ))
        .add_calculation_group(CalculationGroup::new(
            "Time",
            vec![CalculationItem::from_text("Current", "SELECTEDMEASURE()").unwrap()],
        ))
        .add_security_role(SecurityRole::new("BikesOnly").with_filter(
            "Sales",
            "prod_id",
            ComparisonOp::Equal,
            "1",
        ))
        .add_security_role(SecurityRole::new("HelmetsOnly").with_filter(
            "Sales",
            "prod_id",
            ComparisonOp::Equal,
            "2",
        ))
        .build()
        .unwrap()
}

fn gvar_engine() -> Engine {
    let mut engine = Engine::new(gvar_model());
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

// --- Core semantics ---

#[tokio::test]
async fn gvar_computed_once_per_query() {
    // grand = 190 (whole context), so each group is its share of the total.
    let engine = gvar_engine();
    let r = grouped(
        &engine.query(request("PctOfTotal")).await.unwrap(),
        "PctOfTotal",
    );
    assert!((r["Bikes"] - 130.0 / 190.0).abs() < 1e-9, "got {:?}", r);
    assert!((r["Helmets"] - 60.0 / 190.0).abs() < 1e-9, "got {:?}", r);
}

#[tokio::test]
async fn plain_var_recomputes_per_group() {
    // Contrast: a plain VAR inlines `grand` per group, so the ratio is 1.0.
    let engine = gvar_engine();
    let r = grouped(
        &engine.query(request("PctOfTotalVar")).await.unwrap(),
        "PctOfTotalVar",
    );
    assert!((r["Bikes"] - 1.0).abs() < 1e-9, "got {:?}", r);
    assert!((r["Helmets"] - 1.0).abs() < 1e-9, "got {:?}", r);
}

#[tokio::test]
async fn gvar_respects_slicer() {
    // Slice to Bikes: grand respects the slicer (= 130), so Bikes = 130/130 = 1.0
    // — NOT 130/190 (which an absolute-constant or RESET-style global would give).
    let engine = gvar_engine();
    let req = QueryRequest {
        measures: vec!["PctOfTotal".into()],
        group_by: vec![ColumnRef::new("Product", "name")],
        filters: vec![FilterCondition::new("name", FilterOperator::Equal, "Bikes")],
        ..Default::default()
    };
    let r = grouped(&engine.query(req).await.unwrap(), "PctOfTotal");
    assert_eq!(r.len(), 1, "only Bikes in scope: {:?}", r);
    assert!(
        (r["Bikes"] - 1.0).abs() < 1e-9,
        "grand respects the slicer: {:?}",
        r
    );
}

#[tokio::test]
async fn chained_gvar_references_earlier_gvar() {
    let engine = gvar_engine();
    let r = grouped(
        &engine.query(request("PctChained")).await.unwrap(),
        "PctChained",
    );
    assert!((r["Bikes"] - 130.0 / 190.0).abs() < 1e-9, "got {:?}", r);
    assert!((r["Helmets"] - 60.0 / 190.0).abs() < 1e-9, "got {:?}", r);
}

#[tokio::test]
async fn var_may_reference_gvar() {
    let engine = gvar_engine();
    let r = grouped(
        &engine.query(request("PctViaVarRef")).await.unwrap(),
        "PctViaVarRef",
    );
    assert!((r["Bikes"] - 130.0 / 190.0).abs() < 1e-9, "got {:?}", r);
    assert!((r["Helmets"] - 60.0 / 190.0).abs() < 1e-9, "got {:?}", r);
}

#[tokio::test]
async fn gvar_blank_propagates_without_error() {
    // mx = MAX over an empty context = BLANK, so ISBLANK(mx) picks SUM(amount).
    let engine = gvar_engine();
    let r = grouped(
        &engine.query(request("BlankProbe")).await.unwrap(),
        "BlankProbe",
    );
    assert!(
        (r["Bikes"] - 130.0).abs() < 1e-9,
        "mx should be BLANK: {:?}",
        r
    );
    assert!(
        (r["Helmets"] - 60.0).abs() < 1e-9,
        "mx should be BLANK: {:?}",
        r
    );
}

// --- Security ---

#[tokio::test]
async fn gvar_respects_active_rls_role() {
    // Under BikesOnly (Sales.prod_id = 1) the whole context is Bikes, so
    // grand = 130 and Bikes = 130/130 = 1.0. The role must apply to the inner
    // GVAR query too — otherwise grand would leak the unrestricted total (190).
    let mut engine = gvar_engine();
    engine.set_active_role(Some("BikesOnly".into()));
    let r = grouped(
        &engine.query(request("PctOfTotal")).await.unwrap(),
        "PctOfTotal",
    );
    assert_eq!(r.len(), 1, "only Bikes visible under the role: {:?}", r);
    assert!((r["Bikes"] - 1.0).abs() < 1e-9, "grand honors RLS: {:?}", r);
}

// --- Fail-closed composition ---

// --- Validation (model build) ---

/// Build a minimal `Sales → Product` model with one measure parsed from `text`.
fn try_build_measure(name: &str, text: &str) -> Result<DataModel, crate::EngineError> {
    DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("prod_id", DataType::Int64),
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
        .add_measure(measure_from(name, text))
        .build()
}

#[test]
fn reject_table_producing_gvar() {
    let err = try_build_measure(
        "M",
        "GVAR t = QUERY(SUM(Sales[amount]) AS a BY Product[name]) RETURN AVG(t[a])",
    )
    .unwrap_err()
    .to_string();
    assert!(err.contains("must be a scalar"), "got: {err}");
}

#[test]
fn reject_nested_query_in_gvar_binding() {
    // A QUERY nested inside arithmetic (not the top node) must still be rejected
    // — the scalar-only guard checks for a Query node recursively.
    let err = try_build_measure(
        "M",
        "GVAR g = SUM(Sales[amount]) + QUERY(SUM(Sales[amount]) AS a BY Product[name]) RETURN g",
    )
    .unwrap_err()
    .to_string();
    assert!(err.contains("must be a scalar"), "got: {err}");
}

#[test]
fn reject_gvar_referencing_var() {
    let err = try_build_measure("M", "VAR x = SUM(Sales[amount]) GVAR y = x RETURN y")
        .unwrap_err()
        .to_string();
    assert!(err.contains("per-row VAR"), "got: {err}");
}

#[test]
fn reject_gvar_referencing_later_gvar() {
    let err = try_build_measure("M", "GVAR a = b GVAR b = SUM(Sales[amount]) RETURN a")
        .unwrap_err()
        .to_string();
    assert!(err.contains("declared later"), "got: {err}");
}

#[test]
fn reject_duplicate_gvar_var_name() {
    let err = try_build_measure(
        "M",
        "GVAR x = SUM(Sales[amount]) VAR x = SUM(Sales[amount]) RETURN x",
    )
    .unwrap_err()
    .to_string();
    assert!(err.contains("more than once"), "got: {err}");
}

#[test]
fn reject_gvar_colliding_with_model_global_variable() {
    use crate::GlobalVariable;
    let err = DataModel::builder()
        .add_table(Table::new("Sales", vec![Column::new("amount", DataType::Float64)]).unwrap())
        .add_global_variable(GlobalVariable::new(
            "grand",
            "Sales",
            parse_measure_expression("SUM(Sales[amount])").unwrap(),
        ))
        .add_measure(measure_from(
            "M",
            "GVAR grand = SUM(Sales[amount]) RETURN grand",
        ))
        .build()
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("collides with a shared expression"),
        "got: {err}"
    );
}

#[test]
fn accept_var_referencing_gvar_at_build() {
    // The allowed direction: a VAR may reference a GVAR.
    assert!(try_build_measure(
        "M",
        "GVAR grand = SUM(Sales[amount]) VAR r = DIVIDE(SUM(Sales[amount]), grand) RETURN r",
    )
    .is_ok());
}

#[tokio::test]
async fn gvar_with_calculation_group_fails_closed() {
    let engine = gvar_engine();
    let err = engine
        .query(QueryRequest {
            measures: vec!["PctOfTotal".into()],
            group_by: vec![ColumnRef::new("Product", "name")],
            calculation_group: Some(CalculationGroupApplication::new(
                "Time",
                vec!["Current".into()],
            )),
            ..Default::default()
        })
        .await
        .unwrap_err();
    let QueryError::InvalidQuery(msg) = &err else {
        panic!("expected InvalidQuery, got {err:?}");
    };
    assert!(msg.contains("calculation group"), "got: {msg}");
}

// --- Regression tests for review-confirmed defects ---

#[tokio::test]
async fn gvar_bound_to_measure_reference() {
    // `GVAR total = [Revenue]` — the binding is a measure reference, which must
    // be expanded and evaluated via the inner query (not misrouted to the
    // constant folder). Same %-of-total result as the column-aggregate form.
    let engine = gvar_engine();
    let r = grouped(
        &engine.query(request("PctViaMeasureRef")).await.unwrap(),
        "PctViaMeasureRef",
    );
    assert!((r["Bikes"] - 130.0 / 190.0).abs() < 1e-9, "got {:?}", r);
    assert!((r["Helmets"] - 60.0 / 190.0).abs() < 1e-9, "got {:?}", r);
}

#[tokio::test]
async fn chained_gvar_arithmetic_over_blank_does_not_error() {
    // a = MAX over an empty context = BLANK; b = a * 2 must fold to BLANK (not
    // error), so ISBLANK(b) picks SUM(amount).
    let engine = gvar_engine();
    let r = grouped(
        &engine.query(request("ChainedBlank")).await.unwrap(),
        "ChainedBlank",
    );
    assert!(
        (r["Bikes"] - 130.0).abs() < 1e-9,
        "b should be BLANK: {:?}",
        r
    );
    assert!(
        (r["Helmets"] - 60.0).abs() < 1e-9,
        "b should be BLANK: {:?}",
        r
    );
}

#[tokio::test]
async fn gvar_with_multiple_roles_fails_closed() {
    // Multi-role + GVAR fails closed (the inner GVAR query would otherwise
    // bypass the single-role RLS enforceability gate).
    let mut engine = gvar_engine();
    engine.set_active_roles(vec!["BikesOnly".into(), "HelmetsOnly".into()]);
    let err = engine.query(request("PctOfTotal")).await.unwrap_err();
    let QueryError::InvalidQuery(msg) = &err else {
        panic!("expected InvalidQuery, got {err:?}");
    };
    assert!(msg.contains("multiple active roles"), "got: {msg}");
}

#[tokio::test]
async fn gvar_via_auto_tier_fails_closed() {
    // query_auto_tier does not resolve GVARs; a GVAR measure must FAIL CLOSED
    // there (forced local + executor guard), never be pushed to source or
    // silently mis-rendered.
    let mut engine = gvar_engine();
    let err = engine
        .query_auto_tier(request("PctOfTotal"))
        .await
        .unwrap_err();
    let QueryError::InvalidQuery(msg) = &err else {
        panic!("expected InvalidQuery, got {err:?}");
    };
    assert!(msg.contains("GVAR"), "got: {msg}");
}

// --- Regression tests for the post-commit review fixes ---

#[tokio::test]
async fn const_date_gvar_folds_and_evaluates() {
    // The binding has no fact table; it folds via the shared incremental date
    // machinery (DATE(2000,1,1) + 31 days) into a LiteralDate, so ISBLANK is
    // false and the measure returns SUM(amount) per group.
    let engine = gvar_engine();
    let r = grouped(
        &engine.query(request("ConstDateGvar")).await.unwrap(),
        "ConstDateGvar",
    );
    assert!((r["Bikes"] - 130.0).abs() < 1e-9, "got {:?}", r);
    assert!((r["Helmets"] - 60.0).abs() < 1e-9, "got {:?}", r);
}

#[tokio::test]
async fn gvar_survives_user_measure_named_like_ephemeral() {
    // The fixture defines a real measure literally named `__gvar_scalar__`;
    // the inner-query ephemeral name is uniquified around it, so GVAR
    // evaluation still works (and the user measure itself stays queryable).
    let engine = gvar_engine();
    let r = grouped(
        &engine.query(request("PctOfTotal")).await.unwrap(),
        "PctOfTotal",
    );
    assert!((r["Bikes"] - 130.0 / 190.0).abs() < 1e-9, "got {:?}", r);
    let user = grouped(
        &engine.query(request("__gvar_scalar__")).await.unwrap(),
        "__gvar_scalar__",
    );
    assert!((user["Bikes"] - 75.0).abs() < 1e-9, "got {:?}", user);
}

#[tokio::test]
async fn validate_measure_text_rejects_gvar_violations() {
    // The editor-time validation surface must reject everything the model
    // build would reject — no validate-OK-then-build-fail inconsistency.
    let engine = gvar_engine();

    // Scalar-only violation: a QUERY nested in a GVAR binding.
    let err = engine
        .validate_measure_text(
            "Bad1",
            "GVAR t = SUM(Sales[amount]) + QUERY(SUM(Sales[amount]) AS a BY Product[name]) \
             RETURN t",
        )
        .unwrap_err();
    assert!(err.to_string().contains("must be a scalar"), "got: {err}");

    // A window buried in a SWITCH inside a GVAR binding (the has_window
    // recursion fix).
    let err = engine
        .validate_measure_text(
            "Bad2",
            "GVAR g = SWITCH(1, 1, WINDOW(SUM(Sales[amount]), SUM, ORDERBY(Product[name])), 0) \
             RETURN g",
        )
        .unwrap_err();
    assert!(err.to_string().contains("must be a scalar"), "got: {err}");

    // GVAR name colliding with a model global variable.
    let err = engine
        .validate_measure_text("Bad3", "GVAR gv_total = SUM(Sales[amount]) RETURN gv_total")
        .unwrap_err();
    assert!(
        err.to_string().contains("shared expression"),
        "got: {err}"
    );

    // A valid GVAR measure still validates.
    engine
        .validate_measure_text(
            "Good",
            "GVAR grand = SUM(Sales[amount]) RETURN DIVIDE(SUM(Sales[amount]), grand)",
        )
        .unwrap();
}

#[test]
fn reject_buried_window_in_gvar_binding_at_build() {
    // The scalar-only guard sees a window through ANY combinator (SWITCH here)
    // — the has_window catch-all gap is closed.
    let err = try_build_measure(
        "M",
        "GVAR g = SWITCH(1, 1, WINDOW(SUM(Sales[amount]), SUM, ORDERBY(Product[name])), 0) \
         RETURN g",
    )
    .unwrap_err()
    .to_string();
    assert!(err.contains("must be a scalar"), "got: {err}");
}

#[test]
fn reject_gvar_in_calculation_item_at_build() {
    // A calc item declaring a GVAR could never execute (applying a group always
    // fails closed on GVARs), so the build rejects it outright.
    let err = DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("prod_id", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap(),
        )
        .add_measure(sum_measure("Revenue", "Sales", "amount"))
        .add_calculation_group(CalculationGroup::new(
            "Time",
            vec![CalculationItem::from_text(
                "Bad",
                "GVAR t = SUM(Sales[amount]) RETURN SELECTEDMEASURE() / t",
            )
            .unwrap()],
        ))
        .build()
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("not supported in calculation items"),
        "got: {err}"
    );
}
