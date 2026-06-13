//! End-to-end row-level security (RLS) enforcement tests.
//!
//! These build the engine over in-memory star-schema fixtures served entirely
//! from the cache (no connector), so the whole RLS path is exercised against
//! real data: planner injection, dimension→fact propagation, sealed-filter
//! immunity to RESET/ALL, composition with group_by / Rollup, and cache-key
//! role isolation. Stored directly into `self.cache` (a crate-private field),
//! which is why this lives in the crate rather than `tests/`.
//!
//! Fixture: a fact `Sales(geo_id, cat_id, amount)` related to two dimensions,
//! `Geography(id, region)` and `Category(id, name)`. The `WestOnly` role
//! filters `Geography.region = West`. Totals: West = 100 + 30 = 130,
//! East = 40 + 20 = 60; grand total 190.

#![cfg(test)]

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{Array, DictionaryArray, Float64Array, Int32Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Int32Type, Schema};
use arrow::record_batch::RecordBatch;

use crate::{
    expression, sum_measure, AggregateOp, Cardinality, Column, ColumnRef, ComparisonOp, DataModel,
    DataType, Engine, EngineError, Expression, JoinCondition, JoinOperator, Measure,
    QueryCacheConfig, QueryError, QueryRequest, Relationship, SecurityRole, SourceBinding,
    StorageMode, Table, TotalsMode,
};

// --- Fixtures ---

fn rls_model() -> DataModel {
    DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("geo_id", DataType::Int64),
                    Column::new("cat_id", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_table(
            Table::new(
                "Geography",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("region", DataType::String),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_table(
            Table::new(
                "Category",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("name", DataType::String),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_relationship(Relationship::many_to_one(
            "Sales_Geo",
            "Sales",
            "geo_id",
            "Geography",
            "id",
        ))
        .add_relationship(Relationship::many_to_one(
            "Sales_Cat",
            "Sales",
            "cat_id",
            "Category",
            "id",
        ))
        .add_measure(sum_measure("Revenue", "Sales", "amount"))
        .add_security_role(SecurityRole::new("WestOnly").with_filter(
            "Geography",
            "region",
            ComparisonOp::Equal,
            "West",
        ))
        .build()
        .unwrap()
}

fn geo_batch() -> RecordBatch {
    // geo 1 = West, geo 2 = East.
    RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("id", ArrowType::Int64, true),
            Field::new("region", ArrowType::Utf8, true),
        ])),
        vec![
            Arc::new(Int64Array::from(vec![1, 2])),
            Arc::new(StringArray::from(vec!["West", "East"])),
        ],
    )
    .unwrap()
}

fn cat_batch() -> RecordBatch {
    // cat 10 = Bikes, cat 20 = Helmets.
    RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("id", ArrowType::Int64, true),
            Field::new("name", ArrowType::Utf8, true),
        ])),
        vec![
            Arc::new(Int64Array::from(vec![10, 20])),
            Arc::new(StringArray::from(vec!["Bikes", "Helmets"])),
        ],
    )
    .unwrap()
}

fn sales_batch() -> RecordBatch {
    // (geo, cat, amount):
    //   West/Bikes   = 100
    //   East/Helmets = 40
    //   West/Helmets = 30
    //   East/Bikes   = 20
    // West total = 130, East total = 60, grand total = 190.
    RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("geo_id", ArrowType::Int64, true),
            Field::new("cat_id", ArrowType::Int64, true),
            Field::new("amount", ArrowType::Float64, true),
        ])),
        vec![
            Arc::new(Int64Array::from(vec![1, 2, 1, 2])),
            Arc::new(Int64Array::from(vec![10, 20, 20, 10])),
            Arc::new(Float64Array::from(vec![100.0, 40.0, 30.0, 20.0])),
        ],
    )
    .unwrap()
}

/// Engine over the in-memory star schema with all three tables cached.
/// Bindings exist only so the planner accepts the tables; the cache serves
/// the data, so no connector is ever contacted.
fn rls_engine() -> Engine {
    let mut engine = Engine::new(rls_model());
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    engine.bind_table("Geography", 0, SourceBinding::new("public", "geography"));
    engine.bind_table("Category", 0, SourceBinding::new("public", "category"));
    engine.cache.store("Sales", sales_batch()).unwrap();
    engine.cache.store("Geography", geo_batch()).unwrap();
    engine.cache.store("Category", cat_batch()).unwrap();
    engine
}

// --- Result extraction helpers ---

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

/// Scalar measure value from a single-row result.
fn scalar(batches: &[RecordBatch], col: &str) -> f64 {
    assert!(!batches.is_empty(), "no batches");
    let b = &batches[0];
    assert!(b.num_rows() >= 1, "no rows");
    as_f64(b.column(col_idx(b, col)).as_ref(), 0)
}

/// Group-string → measure-f64 map (handles dictionary-encoded group columns).
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
            } else if g.is_null(row) {
                "<null>".to_string()
            } else {
                panic!("unexpected group array type: {:?}", g.data_type());
            };
            out.insert(key, as_f64(m.as_ref(), row));
        }
    }
    out
}

// --- (g) No active role → unchanged results ---

#[tokio::test]
async fn no_active_role_returns_grand_total() {
    let engine = rls_engine();
    assert!(engine.active_role().is_none());
    let batches = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            ..Default::default()
        })
        .await
        .unwrap();
    assert!((scalar(&batches, "Revenue") - 190.0).abs() < 1e-9);
}

// --- (b) HEADLINE: dimension role restricts the fact when the dimension is
//         NOT in group_by or filters ---

#[tokio::test]
async fn dimension_role_restricts_fact_without_dimension_in_query() {
    let mut engine = rls_engine();
    engine.set_active_role(Some("WestOnly".into()));

    // Geography appears in NEITHER group_by NOR filters — yet the West-only
    // role must restrict Sales to West rows (100 + 30 = 130).
    let batches = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(
        (scalar(&batches, "Revenue") - 130.0).abs() < 1e-9,
        "expected West-only total 130, got {}",
        scalar(&batches, "Revenue")
    );
}

// --- (a) Role on the fact restricts a pushed-simple-shaped query ---

#[tokio::test]
async fn role_on_fact_table_restricts_simple_query() {
    // A role that filters the fact directly (amount >= 30) drops the East/Bikes
    // row (20). 100 + 40 + 30 = 170.
    let model = DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("geo_id", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_measure(sum_measure("Revenue", "Sales", "amount"))
        .add_security_role(SecurityRole::new("BigOnly").with_filter(
            "Sales",
            "amount",
            ComparisonOp::GreaterThanOrEqual,
            "30",
        ))
        .build()
        .unwrap();

    let mut engine = Engine::new(model);
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    let sales = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("geo_id", ArrowType::Int64, true),
            Field::new("amount", ArrowType::Float64, true),
        ])),
        vec![
            Arc::new(Int64Array::from(vec![1, 2, 1, 2])),
            Arc::new(Float64Array::from(vec![100.0, 40.0, 30.0, 20.0])),
        ],
    )
    .unwrap();
    engine.cache.store("Sales", sales).unwrap();

    engine.set_active_role(Some("BigOnly".into()));
    let batches = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(
        (scalar(&batches, "Revenue") - 170.0).abs() < 1e-9,
        "got {}",
        scalar(&batches, "Revenue")
    );
}

// --- (c) Role on a cached/auto-tier dimension restricts the fact ---

#[tokio::test]
async fn role_on_cached_dimension_restricts_cached_fact() {
    let mut engine = rls_engine();
    engine.set_active_role(Some("WestOnly".into()));
    // Group by the OTHER dimension (Category): each category reflects only its
    // West rows. Bikes: West 100 (East 20 excluded). Helmets: West 30 (East 40
    // excluded).
    let batches = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            group_by: vec![ColumnRef::new("Category", "name")],
            ..Default::default()
        })
        .await
        .unwrap();
    let by_cat = grouped(&batches, "name", "Revenue");
    assert_eq!(by_cat.len(), 2, "two categories: {by_cat:?}");
    assert!(
        (by_cat["Bikes"] - 100.0).abs() < 1e-9,
        "Bikes West-only = 100"
    );
    assert!(
        (by_cat["Helmets"] - 30.0).abs() < 1e-9,
        "Helmets West-only = 30"
    );
}

// --- (e) RLS + group_by on a different dim ---

#[tokio::test]
async fn rls_composes_with_group_by_on_another_dimension() {
    let mut engine = rls_engine();

    // Without a role: Bikes = 100 + 20 = 120, Helmets = 40 + 30 = 70.
    let unrestricted = grouped(
        &engine
            .query(QueryRequest {
                measures: vec!["Revenue".into()],
                group_by: vec![ColumnRef::new("Category", "name")],
                ..Default::default()
            })
            .await
            .unwrap(),
        "name",
        "Revenue",
    );
    assert!((unrestricted["Bikes"] - 120.0).abs() < 1e-9);
    assert!((unrestricted["Helmets"] - 70.0).abs() < 1e-9);

    // With WestOnly: Bikes = 100, Helmets = 30.
    engine.set_active_role(Some("WestOnly".into()));
    let restricted = grouped(
        &engine
            .query(QueryRequest {
                measures: vec!["Revenue".into()],
                group_by: vec![ColumnRef::new("Category", "name")],
                ..Default::default()
            })
            .await
            .unwrap(),
        "name",
        "Revenue",
    );
    assert!((restricted["Bikes"] - 100.0).abs() < 1e-9);
    assert!((restricted["Helmets"] - 30.0).abs() < 1e-9);
}

// --- (d) RESET / ALL cannot bypass the sealed filter ---

#[tokio::test]
async fn reset_cannot_bypass_role_restriction() {
    // SUM(RESET(Sales[amount])): RESET clears measure context, but the role's
    // pre-aggregation filter lives below ContextResolver and must survive.
    // Under WestOnly the result is still the West-only total (130), never the
    // grand total (190).
    let model = DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("geo_id", DataType::Int64),
                    Column::new("cat_id", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_table(
            Table::new(
                "Geography",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("region", DataType::String),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_relationship(Relationship::many_to_one(
            "Sales_Geo",
            "Sales",
            "geo_id",
            "Geography",
            "id",
        ))
        .add_measure(Measure::new(
            "ResetRevenue",
            Expression::Aggregate {
                operation: AggregateOp::Sum,
                operand: Box::new(Expression::Reset {
                    expr: Box::new(expression::qualified_col("Sales", "amount")),
                }),
            },
        ))
        .add_security_role(SecurityRole::new("WestOnly").with_filter(
            "Geography",
            "region",
            ComparisonOp::Equal,
            "West",
        ))
        .build()
        .unwrap();

    let mut engine = Engine::new(model);
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    engine.bind_table("Geography", 0, SourceBinding::new("public", "geography"));
    engine.cache.store("Sales", sales_batch()).unwrap();
    engine.cache.store("Geography", geo_batch()).unwrap();

    engine.set_active_role(Some("WestOnly".into()));
    let batches = engine
        .query(QueryRequest {
            measures: vec!["ResetRevenue".into()],
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(
        (scalar(&batches, "ResetRevenue") - 130.0).abs() < 1e-9,
        "RESET must not recover excluded rows; got {} (grand total would be 190)",
        scalar(&batches, "ResetRevenue")
    );
}

// --- (f) RLS + Rollup ---

#[tokio::test]
async fn rls_composes_with_rollup_totals() {
    let mut engine = rls_engine();
    engine.set_active_role(Some("WestOnly".into()));

    let batches = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            group_by: vec![ColumnRef::new("Category", "name")],
            totals: TotalsMode::Rollup,
            ..Default::default()
        })
        .await
        .unwrap();

    // Detail rows (grouping_id 0): Bikes 100, Helmets 30 → sum 130. Grand
    // total row: 130 — all restricted to West, never 190.
    let mut detail_sum = 0.0;
    let mut grand_total = None;
    for b in &batches {
        let gid = b
            .column(col_idx(b, "__grouping_id"))
            .as_any()
            .downcast_ref::<Int32Array>()
            .unwrap();
        let rev = b.column(col_idx(b, "Revenue"));
        for row in 0..b.num_rows() {
            let value = as_f64(rev.as_ref(), row);
            if gid.value(row) == 0 {
                detail_sum += value;
            } else {
                grand_total = Some(value);
            }
        }
    }
    assert!((detail_sum - 130.0).abs() < 1e-9, "West detail sum = 130");
    assert!(
        (grand_total.expect("a grand-total row") - 130.0).abs() < 1e-9,
        "West grand total = 130, never 190"
    );
}

// --- (h) Cache: switching the active role does NOT return another role's
//         cached result ---

#[tokio::test]
async fn switching_role_does_not_leak_cached_result() {
    // A two-role model (WestOnly / EastOnly) over the in-memory star schema,
    // with the query-result cache enabled.
    let model = DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("geo_id", DataType::Int64),
                    Column::new("cat_id", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_table(
            Table::new(
                "Geography",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("region", DataType::String),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_relationship(Relationship::many_to_one(
            "Sales_Geo",
            "Sales",
            "geo_id",
            "Geography",
            "id",
        ))
        .add_measure(sum_measure("Revenue", "Sales", "amount"))
        .add_security_role(SecurityRole::new("WestOnly").with_filter(
            "Geography",
            "region",
            ComparisonOp::Equal,
            "West",
        ))
        .add_security_role(SecurityRole::new("EastOnly").with_filter(
            "Geography",
            "region",
            ComparisonOp::Equal,
            "East",
        ))
        .build()
        .unwrap();

    let mut engine = Engine::new(model);
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    engine.bind_table("Geography", 0, SourceBinding::new("public", "geography"));
    engine.cache.store("Sales", sales_batch()).unwrap();
    engine.cache.store("Geography", geo_batch()).unwrap();
    engine.set_query_cache_config(QueryCacheConfig {
        enabled: true,
        ..Default::default()
    });

    let request = || QueryRequest {
        measures: vec!["Revenue".into()],
        ..Default::default()
    };

    // West first (caches 130 under the WestOnly key).
    engine.set_active_role(Some("WestOnly".into()));
    let west = scalar(&engine.query(request()).await.unwrap(), "Revenue");
    assert!((west - 130.0).abs() < 1e-9, "West = 130, got {west}");

    // Switch to East: must NOT serve the West-cached 130; East = 60.
    engine.set_active_role(Some("EastOnly".into()));
    let east = scalar(&engine.query(request()).await.unwrap(), "Revenue");
    assert!(
        (east - 60.0).abs() < 1e-9,
        "switching roles must not leak the West cache; got {east}"
    );

    // Switch back to West: the original restricted result is served again.
    engine.set_active_role(Some("WestOnly".into()));
    let west_again = scalar(&engine.query(request()).await.unwrap(), "Revenue");
    assert!((west_again - 130.0).abs() < 1e-9);

    // No role: grand total 190 (a third, distinct cache identity).
    engine.set_active_role(None);
    let all = scalar(&engine.query(request()).await.unwrap(), "Revenue");
    assert!(
        (all - 190.0).abs() < 1e-9,
        "no-role grand total = 190, got {all}"
    );
}

// --- (i) Unknown active role → SecurityRoleNotFound ---

#[tokio::test]
async fn unknown_active_role_errors() {
    let mut engine = rls_engine();
    engine.set_active_role(Some("DoesNotExist".into()));
    let err = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            ..Default::default()
        })
        .await
        .unwrap_err();
    match err {
        QueryError::Engine(EngineError::SecurityRoleNotFound(name)) => {
            assert_eq!(name, "DoesNotExist");
        }
        other => panic!("expected SecurityRoleNotFound, got {other:?}"),
    }
}

/// A role on a dimension reachable from the fact only through a relationship
/// the engine cannot turn into a restriction (here a NON-EQUI many-to-many
/// BETWEEN join) must REFUSE the query — never return the unrestricted fact.
/// This is the headline data-leak the adversarial review found; the fix fails
/// closed.
#[tokio::test]
async fn unenforceable_dimension_role_refuses_query_instead_of_leaking() {
    let model = DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("order_day", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_table(
            Table::new(
                "Periods",
                vec![
                    Column::new("start_day", DataType::Int64),
                    Column::new("end_day", DataType::Int64),
                    Column::new("region", DataType::String),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        // Non-equi BETWEEN, many-to-many: IN-propagation cannot express it.
        .add_relationship(Relationship::with_conditions(
            "Sales_Periods",
            "Sales",
            "Periods",
            vec![
                JoinCondition::new("order_day", "start_day", JoinOperator::GreaterThanOrEqual),
                JoinCondition::new("order_day", "end_day", JoinOperator::LessThanOrEqual),
            ],
            Cardinality::ManyToMany,
        ))
        .add_measure(sum_measure("Revenue", "Sales", "amount"))
        .add_security_role(SecurityRole::new("WestOnly").with_filter(
            "Periods",
            "region",
            ComparisonOp::Equal,
            "West",
        ))
        .build()
        .unwrap();

    let mut engine = Engine::new(model);
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    engine.bind_table("Periods", 0, SourceBinding::new("public", "periods"));
    let schema = Arc::new(Schema::new(vec![
        Field::new("order_day", ArrowType::Int64, true),
        Field::new("amount", ArrowType::Float64, true),
    ]));
    let sales = RecordBatch::try_new(
        schema,
        vec![
            Arc::new(Int64Array::from(vec![1, 2, 3])),
            Arc::new(Float64Array::from(vec![10.0, 20.0, 30.0])),
        ],
    )
    .unwrap();
    engine.cache.store("Sales", sales).unwrap();
    engine.set_active_role(Some("WestOnly".into()));

    let err = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            ..Default::default()
        })
        .await
        .unwrap_err();
    match err {
        QueryError::Engine(EngineError::RowLevelSecurityNotEnforceable { table, .. }) => {
            assert_eq!(table, "Periods");
        }
        other => panic!("expected RowLevelSecurityNotEnforceable, got {other:?}"),
    }
}

// --- Model layer: serde round-trip + builder validation ---

#[test]
fn model_with_security_role_serde_round_trip() {
    let model = rls_model();
    let json = serde_json::to_string(&model).unwrap();
    assert!(json.contains("security_roles"), "roles must serialize");
    let back: DataModel = serde_json::from_str(&json).unwrap();
    assert_eq!(back.security_roles().len(), 1);
    assert_eq!(back.security_roles()[0].name(), "WestOnly");
    back.validate().unwrap();
}

#[test]
fn builder_rejects_role_filtering_unknown_table() {
    let err = DataModel::builder()
        .add_table(Table::new("Sales", vec![Column::new("amount", DataType::Float64)]).unwrap())
        .add_security_role(SecurityRole::new("R").with_filter(
            "Ghost",
            "x",
            ComparisonOp::Equal,
            "1",
        ))
        .build()
        .unwrap_err();
    assert!(
        matches!(err, EngineError::InvalidData(ref m) if m.contains("Ghost")),
        "got {err:?}"
    );
}

#[test]
fn builder_rejects_role_filtering_unknown_column() {
    let err = DataModel::builder()
        .add_table(Table::new("Sales", vec![Column::new("amount", DataType::Float64)]).unwrap())
        .add_security_role(SecurityRole::new("R").with_filter(
            "Sales",
            "ghost_col",
            ComparisonOp::Equal,
            "1",
        ))
        .build()
        .unwrap_err();
    assert!(
        matches!(err, EngineError::InvalidData(ref m) if m.contains("ghost_col")),
        "got {err:?}"
    );
}

#[test]
fn builder_rejects_duplicate_role_names() {
    let err = DataModel::builder()
        .add_table(Table::new("Sales", vec![Column::new("amount", DataType::Float64)]).unwrap())
        .add_security_role(SecurityRole::new("R").with_filter(
            "Sales",
            "amount",
            ComparisonOp::GreaterThan,
            "0",
        ))
        .add_security_role(SecurityRole::new("R").with_filter(
            "Sales",
            "amount",
            ComparisonOp::LessThan,
            "100",
        ))
        .build()
        .unwrap_err();
    assert!(matches!(err, EngineError::DuplicateName(_)), "got {err:?}");
}

#[test]
fn builder_rejects_bad_role_name() {
    let err = DataModel::builder()
        .add_table(Table::new("Sales", vec![Column::new("amount", DataType::Float64)]).unwrap())
        .add_security_role(SecurityRole::new("bad\"name").with_filter(
            "Sales",
            "amount",
            ComparisonOp::GreaterThan,
            "0",
        ))
        .build()
        .unwrap_err();
    assert!(
        matches!(err, EngineError::InvalidIdentifier { .. }),
        "got {err:?}"
    );
}

// --- Active-role cache invalidation ---

#[test]
fn changing_active_role_invalidates_query_cache() {
    let mut engine = rls_engine();
    let v0 = engine.query_cache.lock().model_version();
    engine.set_active_role(Some("WestOnly".into()));
    let v1 = engine.query_cache.lock().model_version();
    assert!(v1 > v0, "activating a role must invalidate the cache");
    // No-op change does not bump.
    engine.set_active_role(Some("WestOnly".into()));
    assert_eq!(engine.query_cache.lock().model_version(), v1);
    // Clearing the role bumps again.
    engine.set_active_role(None);
    assert!(engine.query_cache.lock().model_version() > v1);
}
