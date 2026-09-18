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

// A role whose DIMENSION predicate matches ZERO dimension rows must restrict
// the fact to zero rows — NOT leave it unrestricted. (Historically the engine
// skipped building an empty IN-filter, so a role like `region = "Atlantis"`
// when no such region exists would drop the restriction and expose ALL rows.)
#[tokio::test]
async fn role_matching_no_dimension_rows_returns_empty_not_all() {
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
        // The role permits a region that does not exist in the data.
        .add_security_role(SecurityRole::new("Nowhere").with_filter(
            "Geography",
            "region",
            ComparisonOp::Equal,
            "Atlantis",
        ))
        .build()
        .unwrap();

    let mut engine = Engine::new(model);
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    engine.bind_table("Geography", 0, SourceBinding::new("public", "geography"));
    let sales = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("geo_id", ArrowType::Int64, true),
            Field::new("amount", ArrowType::Float64, true),
        ])),
        vec![
            Arc::new(Int64Array::from(vec![1, 2, 3])),
            Arc::new(Float64Array::from(vec![100.0, 40.0, 30.0])),
        ],
    )
    .unwrap();
    let geo = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("id", ArrowType::Int64, true),
            Field::new("region", ArrowType::Utf8, true),
        ])),
        vec![
            Arc::new(Int64Array::from(vec![1, 2])),
            Arc::new(StringArray::from(vec!["West", "East"])),
        ],
    )
    .unwrap();
    engine.cache.store("Sales", sales).unwrap();
    engine.cache.store("Geography", geo).unwrap();
    engine.set_active_role(Some("Nowhere".into()));

    // Group by region so an empty fact yields zero rows (the role permits no
    // region, so the result must be empty — not the grand total 170).
    let batches = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            group_by: vec![ColumnRef::new("Geography", "region")],
            ..Default::default()
        })
        .await
        .unwrap();
    let rows: usize = batches.iter().map(|b| b.num_rows()).sum();
    assert_eq!(
        rows, 0,
        "a role matching no dimension rows must return zero fact rows, not all of them"
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
                    // Even the maximum filter level cannot reach RLS
                    // predicates — they are sealed into the fetch, outside
                    // the level model entirely.
                    level: Some(9),
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

// --- Multi-role union (a row is visible if ANY active role permits it) ---

/// A three-region star schema with one role per region, for union tests.
/// Sales(geo, cat, amount): West/Bikes 100, East/Helmets 60, North/Bikes 25,
/// West/Helmets 30, North/Helmets 15. Region totals: West 130, East 60,
/// North 40 (grand 230). West∪East = 190.
fn union_engine() -> Engine {
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
        // Discloses only when the USER filtered the region column. A role
        // predicate on that column must not count as such a filter, however
        // the role set is enforced (single role or multi-role union).
        .add_measure(crate::expression_measure(
            "RegionGated",
            crate::parse_measure("IF(ISFILTERED(Geography[region]), SUM(Sales[amount]), 0.0 - 1.0)")
                .unwrap(),
        ))
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
        .add_security_role(SecurityRole::new("NorthOnly").with_filter(
            "Geography",
            "region",
            ComparisonOp::Equal,
            "North",
        ))
        .build()
        .unwrap();

    let mut engine = Engine::new(model);
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    engine.bind_table("Geography", 0, SourceBinding::new("public", "geography"));
    engine.bind_table("Category", 0, SourceBinding::new("public", "category"));
    let sales = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("geo_id", ArrowType::Int64, true),
            Field::new("cat_id", ArrowType::Int64, true),
            Field::new("amount", ArrowType::Float64, true),
        ])),
        vec![
            Arc::new(Int64Array::from(vec![1, 2, 3, 1, 3])),
            Arc::new(Int64Array::from(vec![10, 20, 10, 20, 20])),
            Arc::new(Float64Array::from(vec![100.0, 60.0, 25.0, 30.0, 15.0])),
        ],
    )
    .unwrap();
    let geo = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("id", ArrowType::Int64, true),
            Field::new("region", ArrowType::Utf8, true),
        ])),
        vec![
            Arc::new(Int64Array::from(vec![1, 2, 3])),
            Arc::new(StringArray::from(vec!["West", "East", "North"])),
        ],
    )
    .unwrap();
    let cat = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("id", ArrowType::Int64, true),
            Field::new("name", ArrowType::Utf8, true),
        ])),
        vec![
            Arc::new(Int64Array::from(vec![10, 20])),
            Arc::new(StringArray::from(vec!["Bikes", "Helmets"])),
        ],
    )
    .unwrap();
    engine.cache.store("Sales", sales).unwrap();
    engine.cache.store("Geography", geo).unwrap();
    engine.cache.store("Category", cat).unwrap();
    engine
}

#[tokio::test]
async fn multi_role_union_includes_both_regions_excludes_third() {
    // HEADLINE: WestOnly ∪ EastOnly restricts the fact to West+East rows
    // (190) even though Geography is in neither group_by nor filters. North
    // (40) is excluded; the grand total (230) must never appear.
    let mut engine = union_engine();
    engine.set_active_roles(vec!["WestOnly".into(), "EastOnly".into()]);
    assert_eq!(engine.active_roles().len(), 2);

    let batches = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(
        (scalar(&batches, "Revenue") - 190.0).abs() < 1e-9,
        "West∪East = 190, never 230 (grand) or 130 (West alone); got {}",
        scalar(&batches, "Revenue")
    );
}

#[tokio::test]
async fn single_role_via_set_active_roles_matches_single_role() {
    // A one-element role set behaves exactly like the legacy single role.
    let mut engine = union_engine();
    engine.set_active_roles(vec!["WestOnly".into()]);
    let batches = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            ..Default::default()
        })
        .await
        .unwrap();
    assert!((scalar(&batches, "Revenue") - 130.0).abs() < 1e-9);
    assert_eq!(engine.active_role(), Some("WestOnly"));
}

#[tokio::test]
async fn multi_role_union_composes_with_group_by_on_another_dimension() {
    // West∪East, grouped by Category. Bikes: West 100 (North 25 excluded) =
    // 100. Helmets: East 60 + West 30 (North 15 excluded) = 90.
    let mut engine = union_engine();
    engine.set_active_roles(vec!["WestOnly".into(), "EastOnly".into()]);
    let by_cat = grouped(
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
    assert!((by_cat["Bikes"] - 100.0).abs() < 1e-9, "Bikes: {by_cat:?}");
    assert!(
        (by_cat["Helmets"] - 90.0).abs() < 1e-9,
        "Helmets: {by_cat:?}"
    );
}

#[tokio::test]
async fn multi_role_union_cache_isolation() {
    // The union has its own cache identity, distinct from any single role and
    // from no role: switching among them never serves another's cached result.
    let mut engine = union_engine();
    engine.set_query_cache_config(QueryCacheConfig {
        enabled: true,
        ..Default::default()
    });
    let request = || QueryRequest {
        measures: vec!["Revenue".into()],
        ..Default::default()
    };

    engine.set_active_roles(vec!["WestOnly".into()]);
    assert!((scalar(&engine.query(request()).await.unwrap(), "Revenue") - 130.0).abs() < 1e-9);

    engine.set_active_roles(vec!["WestOnly".into(), "EastOnly".into()]);
    let union = scalar(&engine.query(request()).await.unwrap(), "Revenue");
    assert!(
        (union - 190.0).abs() < 1e-9,
        "union must not serve the West-only cache; got {union}"
    );

    // Role-set ORDER must not matter (the key is canonicalized): East∪West is
    // the same identity as West∪East — still 190, still cached.
    engine.set_active_roles(vec!["EastOnly".into(), "WestOnly".into()]);
    let reordered = scalar(&engine.query(request()).await.unwrap(), "Revenue");
    assert!((reordered - 190.0).abs() < 1e-9, "got {reordered}");

    engine.set_active_roles(vec![]);
    assert!((scalar(&engine.query(request()).await.unwrap(), "Revenue") - 230.0).abs() < 1e-9);
}

#[tokio::test]
async fn multi_role_union_on_fact_column_combines_predicates() {
    // Roles that filter the FACT directly (Sales.region) union by OR on the
    // fact. region IN effect = West OR East → 100 + 60 + 30 = 190 (North 40
    // excluded), with no dimension hop involved.
    let model = DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("region", DataType::String),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_measure(sum_measure("Revenue", "Sales", "amount"))
        .add_security_role(SecurityRole::new("WestOnly").with_filter(
            "Sales",
            "region",
            ComparisonOp::Equal,
            "West",
        ))
        .add_security_role(SecurityRole::new("EastOnly").with_filter(
            "Sales",
            "region",
            ComparisonOp::Equal,
            "East",
        ))
        .build()
        .unwrap();

    let mut engine = Engine::new(model);
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    let sales = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("region", ArrowType::Utf8, true),
            Field::new("amount", ArrowType::Float64, true),
        ])),
        vec![
            Arc::new(StringArray::from(vec![
                "West", "East", "North", "West", "North",
            ])),
            Arc::new(Float64Array::from(vec![100.0, 60.0, 25.0, 30.0, 15.0])),
        ],
    )
    .unwrap();
    engine.cache.store("Sales", sales).unwrap();
    engine.set_active_roles(vec!["WestOnly".into(), "EastOnly".into()]);

    let batches = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(
        (scalar(&batches, "Revenue") - 190.0).abs() < 1e-9,
        "West∪East on the fact = 190; got {}",
        scalar(&batches, "Revenue")
    );
}

#[tokio::test]
async fn multi_role_union_across_tables_fails_closed() {
    // WestOnly filters Geography; a role filtering Category targets a DIFFERENT
    // table. The union is not a single-table OR slicer → refuse rather than
    // run with an unenforceable (potentially under-restricted) shape.
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
        .add_security_role(SecurityRole::new("BikesOnly").with_filter(
            "Category",
            "name",
            ComparisonOp::Equal,
            "Bikes",
        ))
        .build()
        .unwrap();
    let mut engine = Engine::new(model);
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    engine.bind_table("Geography", 0, SourceBinding::new("public", "geography"));
    engine.bind_table("Category", 0, SourceBinding::new("public", "category"));
    engine.cache.store("Sales", sales_batch()).unwrap();
    engine.cache.store("Geography", geo_batch()).unwrap();
    engine.cache.store("Category", cat_batch()).unwrap();
    engine.set_active_roles(vec!["WestOnly".into(), "BikesOnly".into()]);

    let err = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            ..Default::default()
        })
        .await
        .unwrap_err();
    let QueryError::InvalidQuery(msg) = &err else {
        panic!("expected InvalidQuery, got {err:?}");
    };
    assert!(msg.contains("same table"), "got: {msg}");
}

#[tokio::test]
async fn multi_role_union_multi_predicate_role_fails_closed() {
    // A role with TWO predicates is not a single OR-term; pairing it with
    // another active role must fail closed (the AND-of-predicates union is not
    // a flat single-table OR).
    let model = DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("region", DataType::String),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_measure(sum_measure("Revenue", "Sales", "amount"))
        .add_security_role(
            SecurityRole::new("WestBig")
                .with_filter("Sales", "region", ComparisonOp::Equal, "West")
                .with_filter("Sales", "amount", ComparisonOp::GreaterThan, "50"),
        )
        .add_security_role(SecurityRole::new("EastOnly").with_filter(
            "Sales",
            "region",
            ComparisonOp::Equal,
            "East",
        ))
        .build()
        .unwrap();

    let mut engine = Engine::new(model);
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    let sales = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("region", ArrowType::Utf8, true),
            Field::new("amount", ArrowType::Float64, true),
        ])),
        vec![
            Arc::new(StringArray::from(vec!["West", "East"])),
            Arc::new(Float64Array::from(vec![100.0, 60.0])),
        ],
    )
    .unwrap();
    engine.cache.store("Sales", sales).unwrap();
    engine.set_active_roles(vec!["WestBig".into(), "EastOnly".into()]);

    let err = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            ..Default::default()
        })
        .await
        .unwrap_err();
    let QueryError::InvalidQuery(msg) = &err else {
        panic!("expected InvalidQuery, got {err:?}");
    };
    assert!(msg.contains("one predicate per role"), "got: {msg}");
}

#[tokio::test]
async fn multi_role_union_unenforceable_dimension_fails_closed() {
    // Two roles on a dimension reachable only through a NON-EQUI many-to-many
    // relationship: the enforceability probe (single-role plan) refuses, so the
    // union refuses too — never an under-restricted fact.
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
        .add_security_role(SecurityRole::new("EastOnly").with_filter(
            "Periods",
            "region",
            ComparisonOp::Equal,
            "East",
        ))
        .build()
        .unwrap();

    let mut engine = Engine::new(model);
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    engine.bind_table("Periods", 0, SourceBinding::new("public", "periods"));
    let sales = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("order_day", ArrowType::Int64, true),
            Field::new("amount", ArrowType::Float64, true),
        ])),
        vec![
            Arc::new(Int64Array::from(vec![1, 2, 3])),
            Arc::new(Float64Array::from(vec![10.0, 20.0, 30.0])),
        ],
    )
    .unwrap();
    engine.cache.store("Sales", sales).unwrap();
    engine.set_active_roles(vec!["WestOnly".into(), "EastOnly".into()]);

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

#[tokio::test]
async fn multi_role_rejected_on_drillthrough_path() {
    // Drillthrough (query_rows) does not implement the union rewrite; under
    // multiple active roles it must fail closed, never emit unrestricted rows.
    use crate::DetailRequest;
    let mut engine = union_engine();
    engine.set_active_roles(vec!["WestOnly".into(), "EastOnly".into()]);
    let err = engine
        .query_rows(DetailRequest::new("Sales", 10))
        .await
        .unwrap_err();
    assert!(
        matches!(err, QueryError::InvalidQuery(ref m) if m.contains("single active role")),
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

// --- Dynamic RLS (USERNAME() / CUSTOMDATA()) ---

use engine_core::compute::expression::FilterPredicate;

/// Engine over the same star fixture, but the role restricts `Geography.region`
/// via the given (dynamic) predicate instead of a static `= West`.
fn dynamic_rls_engine(role: SecurityRole) -> Engine {
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
        .add_security_role(role)
        .build()
        .unwrap();
    let mut engine = Engine::new(model);
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    engine.bind_table("Geography", 0, SourceBinding::new("public", "geography"));
    engine.bind_table("Category", 0, SourceBinding::new("public", "category"));
    engine.cache.store("Sales", sales_batch()).unwrap();
    engine.cache.store("Geography", geo_batch()).unwrap();
    engine.cache.store("Category", cat_batch()).unwrap();
    engine
}

fn revenue_request() -> QueryRequest {
    QueryRequest {
        measures: vec!["Revenue".into()],
        ..Default::default()
    }
}

#[tokio::test]
async fn dynamic_username_restricts_to_the_identity_region() {
    // Role: Geography.region = USERNAME(). The identity selects the region.
    let role = SecurityRole::new("DynRegion").with_filters(vec![FilterPredicate::username(
        "Geography",
        "region",
        ComparisonOp::Equal,
    )]);
    let mut engine = dynamic_rls_engine(role);
    engine.set_active_role(Some("DynRegion".into()));

    engine.set_user_identity(Some("West".into()));
    let west = engine.query(revenue_request()).await.unwrap();
    assert!(
        (scalar(&west, "Revenue") - 130.0).abs() < 1e-9,
        "USERNAME()=West → 130"
    );

    engine.set_user_identity(Some("East".into()));
    let east = engine.query(revenue_request()).await.unwrap();
    assert!(
        (scalar(&east, "Revenue") - 60.0).abs() < 1e-9,
        "USERNAME()=East → 60"
    );
}

#[tokio::test]
async fn dynamic_customdata_restricts_to_the_supplied_region() {
    let role = SecurityRole::new("DynCustom").with_filters(vec![FilterPredicate::custom_data(
        "Geography",
        "region",
        ComparisonOp::Equal,
    )]);
    let mut engine = dynamic_rls_engine(role);
    engine.set_active_role(Some("DynCustom".into()));
    engine.set_custom_data(Some("West".into()));
    let r = engine.query(revenue_request()).await.unwrap();
    assert!((scalar(&r, "Revenue") - 130.0).abs() < 1e-9);
}

#[tokio::test]
async fn dynamic_username_without_identity_fails_closed() {
    // No user identity set → a USERNAME() role must FAIL CLOSED, never run
    // unrestricted (or render the placeholder literal).
    let role = SecurityRole::new("DynRegion").with_filters(vec![FilterPredicate::username(
        "Geography",
        "region",
        ComparisonOp::Equal,
    )]);
    let mut engine = dynamic_rls_engine(role);
    engine.set_active_role(Some("DynRegion".into()));
    // user_identity is None.
    let err = engine.query(revenue_request()).await.unwrap_err();
    let QueryError::Engine(EngineError::RowLevelSecurityNotEnforceable { .. }) = &err else {
        panic!("expected RowLevelSecurityNotEnforceable, got {err:?}");
    };
    assert!(err.to_string().contains("USERNAME()"), "got: {err}");
}

#[tokio::test]
async fn dynamic_customdata_without_data_fails_closed() {
    let role = SecurityRole::new("DynCustom").with_filters(vec![FilterPredicate::custom_data(
        "Geography",
        "region",
        ComparisonOp::Equal,
    )]);
    let mut engine = dynamic_rls_engine(role);
    engine.set_active_role(Some("DynCustom".into()));
    let err = engine.query(revenue_request()).await.unwrap_err();
    assert!(
        matches!(
            err,
            QueryError::Engine(EngineError::RowLevelSecurityNotEnforceable { .. })
        ),
        "got: {err:?}"
    );
}

#[tokio::test]
async fn dynamic_identity_isolates_the_cache() {
    // Same role + request; switching identity must recompute (no cross-serve).
    let role = SecurityRole::new("DynRegion").with_filters(vec![FilterPredicate::username(
        "Geography",
        "region",
        ComparisonOp::Equal,
    )]);
    let mut engine = dynamic_rls_engine(role);
    engine.set_active_role(Some("DynRegion".into()));

    engine.set_user_identity(Some("West".into()));
    let west = engine.query(revenue_request()).await.unwrap();
    assert!((scalar(&west, "Revenue") - 130.0).abs() < 1e-9);

    // Switching identity invalidates the cache; the second user sees THEIR rows,
    // never the cached West result.
    engine.set_user_identity(Some("East".into()));
    let east = engine.query(revenue_request()).await.unwrap();
    assert!(
        (scalar(&east, "Revenue") - 60.0).abs() < 1e-9,
        "East must not be served West's cached 130"
    );
}

#[tokio::test]
async fn a_static_username_literal_is_not_substituted() {
    // A STATIC predicate whose value is literally "USERNAME()" must NOT be
    // treated as dynamic (the typed `dynamic` field, not a magic string, decides
    // substitution). region = 'USERNAME()' matches no row → 0, even with an
    // identity that would otherwise select a region.
    let role = SecurityRole::new("LiteralUser").with_filter(
        "Geography",
        "region",
        ComparisonOp::Equal,
        "USERNAME()",
    );
    let mut engine = dynamic_rls_engine(role);
    engine.set_active_role(Some("LiteralUser".into()));
    engine.set_user_identity(Some("West".into()));
    let r = engine.query(revenue_request()).await.unwrap();
    let revenue = if r.is_empty() || r[0].num_rows() == 0 {
        0.0
    } else {
        scalar(&r, "Revenue")
    };
    assert!(
        revenue.abs() < 1e-9,
        "a static 'USERNAME()' literal must not resolve to the identity; got {revenue}"
    );
}

#[test]
fn role_cache_key_folds_identity_custom_data_and_all_roles() {
    // The query-cache key must encode the FULL security context, so a result
    // restricted for one (roles, identity, custom_data) is never keyed the same
    // as another. (Guards the class of bug where a path keyed on only the first
    // role name or dropped the identity — auto-tier regression.)
    let mut e = rls_engine();

    e.set_active_role(Some("WestOnly".into()));
    e.set_user_identity(Some("alice".into()));
    let k_alice = e.role_cache_key();
    e.set_user_identity(Some("bob".into()));
    let k_bob = e.role_cache_key();
    assert_ne!(
        k_alice, k_bob,
        "different user identities must produce different keys"
    );

    // All roles fold in (not just the first): two sets sharing a first role differ.
    e.set_user_identity(None);
    e.set_active_roles(vec!["WestOnly".into(), "Alpha".into()]);
    let k_alpha = e.role_cache_key();
    e.set_active_roles(vec!["WestOnly".into(), "Beta".into()]);
    let k_beta = e.role_cache_key();
    assert_ne!(
        k_alpha, k_beta,
        "role sets sharing a first role must differ"
    );

    // custom_data folds in too.
    e.set_active_roles(Vec::new());
    e.set_custom_data(Some("tenant1".into()));
    let k_t1 = e.role_cache_key();
    e.set_custom_data(Some("tenant2".into()));
    let k_t2 = e.role_cache_key();
    assert_ne!(
        k_t1, k_t2,
        "different custom data must produce different keys"
    );

    // No context at all → None.
    e.set_custom_data(None);
    assert!(e.role_cache_key().is_none());

    // Length-prefixed encoding is collision-free: a role named with the field
    // separators cannot alias a different (roles, identity) context.
    e.set_active_roles(vec!["WestOnly".into()]);
    e.set_user_identity(Some("x".into()));
    let a = e.role_cache_key();
    e.set_active_roles(vec!["WestOnly".into()]);
    e.set_user_identity(Some("y".into()));
    let b = e.role_cache_key();
    assert_ne!(a, b);
}

// --- Object-level security (OLS): denied tables / columns fail closed ---

/// The RLS star schema plus an `Analyst` role with object-level denials:
/// the whole `Category` table, and `Geography[region]` at column granularity
/// (its sibling `Geography[id]` stays accessible).
fn ols_engine() -> Engine {
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
        // Reaches the denied column ONLY through its own expression, so a
        // request grouping by a permitted column still has to be refused.
        .add_measure(crate::count_measure("RegionCount", "Geography", "region"))
        .add_security_role(
            SecurityRole::new("Analyst")
                .with_denied_tables(vec!["Category".to_string()])
                .with_denied_columns(vec!["Geography[region]".to_string()]),
        )
        .build()
        .unwrap();
    let mut engine = Engine::new(model);
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    engine.bind_table("Geography", 0, SourceBinding::new("public", "geography"));
    engine.bind_table("Category", 0, SourceBinding::new("public", "category"));
    engine.cache.store("Sales", sales_batch()).unwrap();
    engine.cache.store("Geography", geo_batch()).unwrap();
    engine.cache.store("Category", cat_batch()).unwrap();
    engine
}

#[tokio::test]
async fn ols_denied_table_refuses_group_by_and_no_role_allows_it() {
    let mut engine = ols_engine();
    // Without the role, grouping by Category works.
    let batches = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            group_by: vec![ColumnRef::new("Category", "name")],
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(grouped(&batches, "name", "Revenue").len(), 2);

    // With the role active, the same query is refused.
    engine.set_active_role(Some("Analyst".into()));
    let err = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            group_by: vec![ColumnRef::new("Category", "name")],
            ..Default::default()
        })
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("object-level security"), "got: {err}");
    assert!(err.contains("Category"), "got: {err}");
}

#[tokio::test]
async fn ols_denied_column_refuses_group_by_but_not_sibling_column() {
    let mut engine = ols_engine();
    engine.set_active_role(Some("Analyst".into()));

    // Geography[region] is denied at column granularity.
    let err = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            group_by: vec![ColumnRef::new("Geography", "region")],
            ..Default::default()
        })
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("object-level security"), "got: {err}");
    assert!(err.contains("Geography[region]"), "got: {err}");

    // The sibling column Geography[id] is NOT denied: grouping by it works.
    let batches = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            group_by: vec![ColumnRef::new("Geography", "id")],
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(!batches.is_empty());

    // A bare-column filter naming the denied column is refused too.
    let err = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            filters: vec![crate::FilterCondition::new(
                "region",
                crate::FilterOperator::Equal,
                "West",
            )],
            ..Default::default()
        })
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("object-level security"), "got: {err}");
}

#[tokio::test]
async fn ols_denied_table_refuses_drillthrough() {
    let mut engine = ols_engine();
    engine.set_active_role(Some("Analyst".into()));

    // Drilling the denied table itself is refused.
    let err = engine
        .query_rows(crate::DetailRequest::new("Category", 10))
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("object-level security"), "got: {err}");

    // Drilling Sales with a denied dimension attribute is refused.
    let err = engine
        .query_rows(
            crate::DetailRequest::new("Sales", 10)
                .with_dimension_columns(vec![ColumnRef::new("Geography", "region")]),
        )
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("object-level security"), "got: {err}");

    // Plain Sales drillthrough (no denied objects) still works.
    let batches = engine
        .query_rows(crate::DetailRequest::new("Sales", 10))
        .await
        .unwrap();
    assert_eq!(batches.iter().map(|b| b.num_rows()).sum::<usize>(), 4);
}

#[test]
fn ols_denials_validated_at_build() {
    // Unknown denied table: rejected.
    let err = DataModel::builder()
        .add_table(Table::new("Sales", vec![Column::new("amount", DataType::Float64)]).unwrap())
        .add_security_role(SecurityRole::new("R").with_denied_tables(vec!["Phantom".to_string()]))
        .build()
        .unwrap_err()
        .to_string();
    assert!(err.contains("Phantom"), "got: {err}");

    // Malformed denied column ref: rejected.
    let err = DataModel::builder()
        .add_table(Table::new("Sales", vec![Column::new("amount", DataType::Float64)]).unwrap())
        .add_security_role(
            SecurityRole::new("R").with_denied_columns(vec!["not_qualified".to_string()]),
        )
        .build()
        .unwrap_err()
        .to_string();
    assert!(err.contains("Table[column]"), "got: {err}");
}

// --- One aggregate query path: OLS and the multi-role union on every entry point ---
//
// `query_auto_refresh` (the host's bi_query / column-values / refresh / cube /
// insights / MCP route), `query_auto_tier` and `query_explained` used to plan
// on their own: no object-level security, and either a fail-closed multi-role
// refusal (auto-refresh, explain) or — worse — a multi-role run with EMPTY
// role filters (auto-tier). They now run the same path as `query`.

#[tokio::test]
async fn ols_denied_table_refuses_auto_refresh_and_no_role_allows_it() {
    let mut engine = ols_engine();
    let request = || QueryRequest {
        measures: vec!["Revenue".into()],
        group_by: vec![ColumnRef::new("Category", "name")],
        ..Default::default()
    };

    // Positive control: without the role the auto-refresh path answers.
    let (batches, _) = engine.query_auto_refresh(request()).await.unwrap();
    assert_eq!(grouped(&batches, "name", "Revenue").len(), 2);

    engine.set_active_role(Some("Analyst".into()));
    let err = engine
        .query_auto_refresh(request())
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("object-level security"), "got: {err}");
    assert!(err.contains("Category"), "got: {err}");

    // A denied column referenced only through the requested MEASURE's
    // closure is refused too — the group-by column here is PERMITTED, so
    // only the closure walk can refuse this (the host's filter pane queries
    // a placeholder measure, so this is the shape that matters there).
    let err = engine
        .query_auto_refresh(QueryRequest {
            measures: vec!["RegionCount".into()],
            group_by: vec![ColumnRef::new("Geography", "id")],
            ..Default::default()
        })
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("Geography[region]"), "got: {err}");
    assert!(
        err.contains("referenced by measure 'RegionCount'"),
        "the refusal must name the measure whose closure reached it: {err}"
    );
}

#[tokio::test]
async fn ols_refusal_on_auto_refresh_happens_before_any_refresh() {
    // A request that will be refused must trigger no source I/O: the
    // validations run BEFORE `refresh_stale`, so the refresh report is never
    // written. (`refresh_stale` always stores a report, even an empty one.)
    let mut engine = ols_engine();
    engine.set_active_role(Some("Analyst".into()));
    assert!(engine.last_refresh_report().is_none());

    let _ = engine
        .query_auto_refresh(QueryRequest {
            measures: vec!["Revenue".into()],
            group_by: vec![ColumnRef::new("Category", "name")],
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert!(
        engine.last_refresh_report().is_none(),
        "the refusal must come before refresh_stale runs"
    );

    // Positive control: a permitted request DOES run the refresh step.
    let (_, refreshed) = engine
        .query_auto_refresh(QueryRequest {
            measures: vec!["Revenue".into()],
            group_by: vec![ColumnRef::new("Geography", "id")],
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(refreshed.is_empty(), "cache-served tables have nothing to refresh");
    assert!(engine.last_refresh_report().is_some());
}

#[tokio::test]
async fn ols_denied_table_refuses_explain_and_auto_tier() {
    let mut engine = ols_engine();
    let request = || QueryRequest {
        measures: vec!["Revenue".into()],
        group_by: vec![ColumnRef::new("Category", "name")],
        ..Default::default()
    };

    // Positive controls.
    let (batches, _plan) = engine.query_explained(request()).await.unwrap();
    assert_eq!(grouped(&batches, "name", "Revenue").len(), 2);
    let (batches, _tiered) = engine.query_auto_tier(request()).await.unwrap();
    assert_eq!(grouped(&batches, "name", "Revenue").len(), 2);

    engine.set_active_role(Some("Analyst".into()));
    let err = engine.query_explained(request()).await.unwrap_err().to_string();
    assert!(err.contains("object-level security"), "explain: {err}");
    let err = engine.query_auto_tier(request()).await.unwrap_err().to_string();
    assert!(err.contains("object-level security"), "auto-tier: {err}");
}

#[tokio::test]
async fn multi_role_union_runs_on_auto_refresh_explain_and_auto_tier() {
    // West ∪ East = 190 on every aggregate entry point — never 230 (no
    // restriction) and never the old "single active role" refusal.
    let mut engine = union_engine();
    engine.set_active_roles(vec!["WestOnly".into(), "EastOnly".into()]);
    let request = || QueryRequest {
        measures: vec!["Revenue".into()],
        ..Default::default()
    };

    let (batches, _) = engine.query_auto_refresh(request()).await.unwrap();
    assert!(
        (scalar(&batches, "Revenue") - 190.0).abs() < 1e-9,
        "auto-refresh: {}",
        scalar(&batches, "Revenue")
    );
    let (batches, _) = engine.query_explained(request()).await.unwrap();
    assert!(
        (scalar(&batches, "Revenue") - 190.0).abs() < 1e-9,
        "explain: {}",
        scalar(&batches, "Revenue")
    );
    let (batches, _) = engine.query_auto_tier(request()).await.unwrap();
    assert!(
        (scalar(&batches, "Revenue") - 190.0).abs() < 1e-9,
        "auto-tier: {}",
        scalar(&batches, "Revenue")
    );
}

#[tokio::test]
async fn multi_role_union_unsupported_shape_fails_closed_on_every_aggregate_path() {
    // The cross-table shape is refused by the union builder on `query`; the
    // other entry points share that builder now, so they refuse the same way
    // (and auto-tier no longer runs it with empty role filters).
    let mut engine = union_engine_with_cross_table_role();
    engine.set_active_roles(vec!["WestOnly".into(), "BikesOnly".into()]);
    let request = || QueryRequest {
        measures: vec!["Revenue".into()],
        ..Default::default()
    };

    for (path, err) in [
        (
            "auto-refresh",
            engine.query_auto_refresh(request()).await.unwrap_err(),
        ),
        ("explain", engine.query_explained(request()).await.unwrap_err()),
        ("auto-tier", engine.query_auto_tier(request()).await.unwrap_err()),
    ] {
        let QueryError::InvalidQuery(msg) = &err else {
            panic!("{path}: expected InvalidQuery, got {err:?}");
        };
        assert!(msg.contains("same table"), "{path}: {msg}");
    }
}

/// `union_engine`'s star schema with a second role on a DIFFERENT table, so a
/// two-role set is not a single-table OR.
fn union_engine_with_cross_table_role() -> Engine {
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
        .add_security_role(SecurityRole::new("BikesOnly").with_filter(
            "Category",
            "name",
            ComparisonOp::Equal,
            "Bikes",
        ))
        .build()
        .unwrap();
    let mut engine = Engine::new(model);
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    engine.bind_table("Geography", 0, SourceBinding::new("public", "geography"));
    engine.bind_table("Category", 0, SourceBinding::new("public", "category"));
    engine.cache.store("Sales", sales_batch()).unwrap();
    engine.cache.store("Geography", geo_batch()).unwrap();
    engine.cache.store("Category", cat_batch()).unwrap();
    engine
}

#[tokio::test]
async fn ols_denied_column_in_a_scoped_filter_is_refused_on_every_aggregate_path() {
    // Every host filter arrives as a SCOPED filter (pivot slicers, bi_query,
    // MCP). The gate used to inspect only the bare `filters` / `in_filters` /
    // `or_filters` lists, so a caller under a role that denies
    // Geography[region] could bisect its values through
    // `WHERE Geography[region] = x`. Qualified and unqualified, scalar and
    // IN-list, on all four aggregate entry points.
    let mut engine = ols_engine();
    let qualified = || QueryRequest {
        measures: vec!["Revenue".into()],
        scoped_filters: vec![crate::ScopedFilter {
            table: Some("Geography".into()),
            condition: crate::FilterCondition::new("region", crate::FilterOperator::Equal, "West"),
            level: 1,
        }],
        ..Default::default()
    };
    let unqualified = || QueryRequest {
        measures: vec!["Revenue".into()],
        scoped_filters: vec![crate::ScopedFilter {
            table: None,
            condition: crate::FilterCondition::new("region", crate::FilterOperator::Equal, "West"),
            level: 1,
        }],
        ..Default::default()
    };
    let in_list = || QueryRequest {
        measures: vec!["Revenue".into()],
        scoped_in_filters: vec![crate::ScopedInFilter {
            table: Some("Geography".into()),
            filter: crate::InFilter::new("region", ["West"]),
            level: 1,
        }],
        ..Default::default()
    };

    // Positive control: without the role the scoped filter restricts to West.
    let batches = engine.query(qualified()).await.unwrap();
    assert!((scalar(&batches, "Revenue") - 130.0).abs() < 1e-9);

    engine.set_active_role(Some("Analyst".into()));
    for (path, err) in [
        ("query/qualified", engine.query(qualified()).await.unwrap_err()),
        ("query/unqualified", engine.query(unqualified()).await.unwrap_err()),
        ("query/in-list", engine.query(in_list()).await.unwrap_err()),
        (
            "auto-refresh",
            engine.query_auto_refresh(qualified()).await.unwrap_err(),
        ),
        ("explain", engine.query_explained(qualified()).await.unwrap_err()),
        ("auto-tier", engine.query_auto_tier(qualified()).await.unwrap_err()),
    ] {
        let msg = err.to_string();
        assert!(msg.contains("object-level security"), "{path}: {msg}");
        assert!(msg.contains("Geography[region]"), "{path}: {msg}");
    }

    // Not over-refusing: a scoped filter on the permitted sibling column.
    let batches = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            scoped_filters: vec![crate::ScopedFilter {
                table: Some("Geography".into()),
                condition: crate::FilterCondition::new("id", crate::FilterOperator::Equal, "1"),
                level: 1,
            }],
            ..Default::default()
        })
        .await
        .unwrap();
    assert!((scalar(&batches, "Revenue") - 130.0).abs() < 1e-9);
}

#[tokio::test]
async fn multi_role_union_composes_with_rank_by_on_auto_refresh() {
    // Ordering pin: the post-aggregation peel runs OUTERMOST and the union
    // rewrite INNERMOST. The union builder refuses a request that already
    // carries `or_filters`, so if the union ran first the peeled inner call
    // would refuse itself. West ∪ East by Category: Bikes 100, Helmets 90 —
    // ranked 1, 2 — never the unrestricted 125 / 105.
    let mut engine = union_engine();
    engine.set_active_roles(vec!["WestOnly".into(), "EastOnly".into()]);
    let (batches, _) = engine
        .query_auto_refresh(QueryRequest {
            measures: vec!["Revenue".into()],
            group_by: vec![ColumnRef::new("Category", "name")],
            rank_by: Some(crate::RankBy::new("Revenue", "Rank")),
            ..Default::default()
        })
        .await
        .unwrap();
    let revenue = grouped(&batches, "name", "Revenue");
    assert!((revenue["Bikes"] - 100.0).abs() < 1e-9, "{revenue:?}");
    assert!((revenue["Helmets"] - 90.0).abs() < 1e-9, "{revenue:?}");
    let rank = grouped(&batches, "name", "Rank");
    assert_eq!(rank["Bikes"] as i64, 1, "{rank:?}");
    assert_eq!(rank["Helmets"] as i64, 2, "{rank:?}");
}

#[tokio::test]
async fn isfiltered_ignores_the_multi_role_unions_injected_predicates() {
    // A role predicate is sealed security, not a user filter. Under ONE role
    // `ISFILTERED(Geography[region])` folds FALSE (the predicate travels in
    // `role_filters`, which the fold never sees); the union of two roles on
    // that column injects the predicates as request `or_filters`, and the
    // fold used to read THOSE — so a measure gating disclosure on ISFILTERED
    // disclosed under two roles and blanked under one. The fold now reads the
    // request as the caller wrote it, on every aggregate entry point.
    let mut engine = union_engine();
    let req = || QueryRequest {
        measures: vec!["RegionGated".into()],
        ..Default::default()
    };

    engine.set_active_role(Some("WestOnly".into()));
    let single = scalar(&engine.query(req()).await.unwrap(), "RegionGated");
    assert!(
        (single + 1.0).abs() < 1e-9,
        "one role must not count as a user filter; got {single}"
    );

    engine.set_active_roles(vec!["WestOnly".into(), "EastOnly".into()]);
    for (path, batches) in [
        ("query", engine.query(req()).await.unwrap()),
        (
            "auto-refresh",
            engine.query_auto_refresh(req()).await.unwrap().0,
        ),
        ("explain", engine.query_explained(req()).await.unwrap().0),
        ("auto-tier", engine.query_auto_tier(req()).await.unwrap().0),
    ] {
        let v = scalar(&batches, "RegionGated");
        assert!(
            (v + 1.0).abs() < 1e-9,
            "{path}: the union's injected predicates must not fold ISFILTERED TRUE; got {v}"
        );
    }

    // Positive control: a USER filter on the same column does fold it TRUE.
    engine.set_active_role(None);
    let batches = engine
        .query(QueryRequest {
            measures: vec!["RegionGated".into()],
            filters: vec![crate::FilterCondition::new(
                "region",
                crate::FilterOperator::Equal,
                "West",
            )],
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(
        (scalar(&batches, "RegionGated") - 130.0).abs() < 1e-9,
        "a user filter must fold it TRUE"
    );
}

#[tokio::test]
async fn multi_role_union_is_order_independent() {
    // The builder used to validate each role's SHAPE as it walked the set and
    // to return "unrestricted" the moment it met a role with no filters, so
    // {two-predicate role, unrestricted role} refused in one activation order
    // and returned every row in the other — while the cache key sorts the set
    // precisely so that order cannot matter. Every role's predicates are
    // resolved before any shape decision now.
    let model = DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("region", DataType::String),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_measure(sum_measure("Revenue", "Sales", "amount"))
        .add_security_role(
            SecurityRole::new("WestBig")
                .with_filter("Sales", "region", ComparisonOp::Equal, "West")
                .with_filter("Sales", "amount", ComparisonOp::GreaterThan, "50"),
        )
        .add_security_role(SecurityRole::new("Everything"))
        .build()
        .unwrap();
    let mut engine = Engine::new(model);
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    engine
        .cache
        .store(
            "Sales",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("region", ArrowType::Utf8, true),
                    Field::new("amount", ArrowType::Float64, true),
                ])),
                vec![
                    Arc::new(StringArray::from(vec!["West", "East"])),
                    Arc::new(Float64Array::from(vec![100.0, 60.0])),
                ],
            )
            .unwrap(),
        )
        .unwrap();

    for order in [
        vec!["WestBig".to_string(), "Everything".to_string()],
        vec!["Everything".to_string(), "WestBig".to_string()],
    ] {
        engine.set_active_roles(order.clone());
        let batches = engine
            .query(QueryRequest {
                measures: vec!["Revenue".into()],
                ..Default::default()
            })
            .await
            .unwrap_or_else(|e| panic!("{order:?} was refused: {e}"));
        assert!(
            (scalar(&batches, "Revenue") - 160.0).abs() < 1e-9,
            "{order:?}: an unrestricted role in the set means every row"
        );
    }
}
