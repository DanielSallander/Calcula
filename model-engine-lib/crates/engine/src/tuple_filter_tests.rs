//! End-to-end tests for the TUPLE (multi-column, OR-of-AND) slicer
//! (`QueryRequest.scoped_tuple_filters`, [`crate::ScopedTupleFilter`]).
//!
//! A Ctrl+click selection across two fields -- (A, x) and (B, y) -- is not
//! the rectangle {A, B} x {x, y}: two per-column IN-lists would also keep
//! (A, y) and (B, x). These tests pin the exact semantics, the per-measure
//! PROJECTION a partially clearing measure sees, the blank member, the cache
//! key, OLS, the fail-closed refusals, the fetch pre-narrowing and the
//! projection widening.
//!
//! Fixture, a two-dimension star `Sales(prod_id, store_id, code, amount)` ->
//! `Product(id, cat)` and `Store(id, region)`:
//!
//! | row | cat    | region | code | amount |
//! |-----|--------|--------|------|--------|
//! | r1  | A      | x      | 1    | 1      |
//! | r2  | A      | y      | 1    | 2      |
//! | r3  | B      | x      | 2    | 4      |
//! | r4  | B      | y      | 2    | 8      |
//! | r5  | (NULL) | x      | NULL | 16     |
//! | r6  | ""     | y      | 3    | 32     |
//! | r7  | A      | z      | NULL | 64     |
//!
//! Grand total 127. Amounts are powers of two, so every sum names exactly
//! which rows it contains.

#![cfg(test)]

use std::collections::BTreeMap;
use std::sync::Arc;

use arrow::array::{Array, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Schema};
use arrow::record_batch::RecordBatch;

use crate::query_cache::query_cache_key;
use crate::{
    expression_measure, parse_measure, sum_measure, Column, ColumnRef, DataModel, DataType, Engine,
    EngineError, InMemoryConnector, QueryError, QueryRequest, Relationship, ScopedTupleFilter,
    SecurityRole, SourceBinding, StorageMode, Table, TotalsMode, TupleColumn, BLANK_MEMBER_LABEL,
};

fn model(storage: StorageMode) -> DataModel {
    DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("prod_id", DataType::Int64),
                    Column::new("store_id", DataType::Int64),
                    Column::new("code", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(storage.clone()),
        )
        .add_table(
            Table::new(
                "Product",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("cat", DataType::String),
                ],
            )
            .unwrap()
            .with_storage_mode(storage.clone()),
        )
        .add_table(
            Table::new(
                "Store",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("region", DataType::String),
                ],
            )
            .unwrap()
            .with_storage_mode(storage.clone()),
        )
        .add_relationship(Relationship::many_to_one(
            "Sales_Product",
            "Sales",
            "prod_id",
            "Product",
            "id",
        ))
        .add_relationship(Relationship::many_to_one(
            "Sales_Store",
            "Sales",
            "store_id",
            "Store",
            "id",
        ))
        .add_measure(sum_measure("Revenue", "Sales", "amount"))
        .add_measure(expression_measure(
            "RevNoProduct",
            parse_measure("SUM(Sales[amount], CLEAR(Product))").unwrap(),
        ))
        .add_measure(expression_measure(
            "RevNoStore",
            parse_measure("SUM(Sales[amount], CLEAR(Store))").unwrap(),
        ))
        .add_measure(expression_measure(
            "Total",
            parse_measure("SUM(Sales[amount], RESET())").unwrap(),
        ))
        .add_measure(expression_measure(
            "Share",
            parse_measure("DIVIDE(SUM(Sales[amount]), SUM(Sales[amount], RESET()))").unwrap(),
        ))
        .add_security_role(
            SecurityRole::new("NoRegion").with_denied_columns(vec!["Store[region]".to_string()]),
        )
        .build()
        .unwrap()
}

fn sales() -> RecordBatch {
    RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("prod_id", ArrowType::Int64, false),
            Field::new("store_id", ArrowType::Int64, false),
            Field::new("code", ArrowType::Int64, true),
            Field::new("amount", ArrowType::Float64, false),
        ])),
        vec![
            Arc::new(Int64Array::from(vec![1, 1, 2, 2, 3, 4, 1])),
            Arc::new(Int64Array::from(vec![10, 20, 10, 20, 10, 20, 30])),
            Arc::new(Int64Array::from(vec![
                Some(1),
                Some(1),
                Some(2),
                Some(2),
                None,
                Some(3),
                None,
            ])),
            Arc::new(Float64Array::from(vec![
                1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 64.0,
            ])),
        ],
    )
    .unwrap()
}

fn products() -> RecordBatch {
    RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("id", ArrowType::Int64, false),
            Field::new("cat", ArrowType::Utf8, true),
        ])),
        vec![
            Arc::new(Int64Array::from(vec![1, 2, 3, 4])),
            Arc::new(StringArray::from(vec![
                Some("A"),
                Some("B"),
                None,
                Some(""),
            ])),
        ],
    )
    .unwrap()
}

fn stores() -> RecordBatch {
    RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("id", ArrowType::Int64, false),
            Field::new("region", ArrowType::Utf8, true),
        ])),
        vec![
            Arc::new(Int64Array::from(vec![10, 20, 30])),
            Arc::new(StringArray::from(vec![Some("x"), Some("y"), Some("z")])),
        ],
    )
    .unwrap()
}

fn bind(engine: &mut Engine, idx: usize) {
    engine.bind_table("Sales", idx, SourceBinding::new("public", "sales"));
    engine.bind_table("Product", idx, SourceBinding::new("public", "product"));
    engine.bind_table("Store", idx, SourceBinding::new("public", "store"));
}

/// Served from the in-memory CACHE (the dictionary-encoded batches).
fn cached_engine() -> Engine {
    let mut engine = Engine::new(model(StorageMode::InMemory));
    bind(&mut engine, 0);
    engine.cache.store("Sales", sales()).unwrap();
    engine.cache.store("Product", products()).unwrap();
    engine.cache.store("Store", stores()).unwrap();
    engine
}

/// Fetched through a CONNECTOR on every query (DirectQuery over an in-memory
/// source), so the pre-narrowing IN-lists run in the connector's filter path.
fn connector_engine() -> Engine {
    let mut engine = Engine::new(model(StorageMode::DirectQuery));
    let idx = engine.add_in_memory_source(
        InMemoryConnector::new()
            .with_table("public", "sales", sales())
            .with_table("public", "product", products())
            .with_table("public", "store", stores()),
    );
    bind(&mut engine, idx);
    engine
}

fn engines() -> [(&'static str, Engine); 2] {
    [
        ("cached", cached_engine()),
        ("connector", connector_engine()),
    ]
}

fn tuple(columns: &[(&str, &str)], tuples: &[&[&str]]) -> ScopedTupleFilter {
    ScopedTupleFilter {
        columns: columns
            .iter()
            .map(|(t, c)| TupleColumn::new(*t, *c))
            .collect(),
        tuples: tuples
            .iter()
            .map(|t| t.iter().map(|v| v.to_string()).collect())
            .collect(),
        level: 1,
    }
}

/// The (A, x) + (B, y) selection on Product[cat] x Store[region].
fn diagonal() -> ScopedTupleFilter {
    tuple(
        &[("Product", "cat"), ("Store", "region")],
        &[&["A", "x"], &["B", "y"]],
    )
}

fn measure_value(batch: &RecordBatch, measure: &str, row: usize) -> Option<f64> {
    let idx = batch
        .schema()
        .index_of(measure)
        .unwrap_or_else(|_| panic!("no {measure}"));
    let col = batch.column(idx);
    if col.is_null(row) {
        return None;
    }
    Some(
        if let Some(a) = col.as_any().downcast_ref::<Float64Array>() {
            a.value(row)
        } else if let Some(a) = col.as_any().downcast_ref::<Int64Array>() {
            a.value(row) as f64
        } else {
            panic!("unexpected measure type {:?}", col.data_type())
        },
    )
}

/// The scalar value of `measure` in a one-row (measure-only) result.
fn scalar(batches: &[RecordBatch], measure: &str) -> f64 {
    let mut total = 0.0;
    for b in batches {
        for r in 0..b.num_rows() {
            total += measure_value(b, measure, r).unwrap_or(0.0);
        }
    }
    total
}

/// `group key (columns joined by '/') -> measure value` over a grouped result.
fn by_group(batches: &[RecordBatch], keys: &[&str], measure: &str) -> BTreeMap<String, f64> {
    let mut out = BTreeMap::new();
    for b in batches {
        for r in 0..b.num_rows() {
            let key: Vec<String> = keys
                .iter()
                .map(|k| {
                    let idx = b.schema().index_of(k).unwrap_or_else(|_| panic!("no {k}"));
                    arrow::util::display::array_value_to_string(b.column(idx), r).unwrap()
                })
                .collect();
            if let Some(v) = measure_value(b, measure, r) {
                out.insert(key.join("/"), v);
            }
        }
    }
    out
}

fn expected(rows: &[(&str, f64)]) -> BTreeMap<String, f64> {
    rows.iter().map(|(k, v)| (k.to_string(), *v)).collect()
}

async fn run(engine: &Engine, request: QueryRequest) -> Vec<RecordBatch> {
    engine.query(request).await.expect("the tuple query")
}

fn measure_only(measures: &[&str], filter: ScopedTupleFilter) -> QueryRequest {
    QueryRequest {
        measures: measures.iter().map(|m| m.to_string()).collect(),
        scoped_tuple_filters: vec![filter],
        ..Default::default()
    }
}

// 1. Exactness: the two tuples, never the rectangle.
#[tokio::test]
async fn two_tuples_keep_exactly_their_two_pairs_never_the_rectangle() {
    for (name, engine) in engines() {
        let batches = run(
            &engine,
            QueryRequest {
                measures: vec!["Revenue".into()],
                group_by: vec![
                    ColumnRef::new("Product", "cat"),
                    ColumnRef::new("Store", "region"),
                ],
                scoped_tuple_filters: vec![diagonal()],
                ..Default::default()
            },
        )
        .await;
        assert_eq!(
            by_group(&batches, &["cat", "region"], "Revenue"),
            expected(&[("A/x", 1.0), ("B/y", 8.0)]),
            "{name}: (A, y) and (B, x) must be absent -- a rectangular IN would keep them"
        );
        // Measure-only: 1 + 8, where the rectangle would give 1 + 2 + 4 + 8.
        let batches = run(&engine, measure_only(&["Revenue"], diagonal())).await;
        assert_eq!(scalar(&batches, "Revenue"), 9.0, "{name}");
    }
}

// 2. Projection: a measure clearing ONE column sees the others' projection.
#[tokio::test]
async fn a_measure_clearing_one_column_sees_the_projection_onto_the_rest() {
    for (name, engine) in engines() {
        let batches = run(
            &engine,
            measure_only(&["Revenue", "RevNoProduct", "RevNoStore"], diagonal()),
        )
        .await;
        assert_eq!(scalar(&batches, "Revenue"), 9.0, "{name}: the exact tuples");
        assert_eq!(
            scalar(&batches, "RevNoProduct"),
            63.0,
            "{name}: CLEAR(Product) sees region IN {{x, y}} (r1..r6), not the tuples"
        );
        assert_eq!(
            scalar(&batches, "RevNoStore"),
            79.0,
            "{name}: CLEAR(Store) sees cat IN {{A, B}} (r1, r2, r3, r4, r7)"
        );
    }
}

// 2b. Projection on a grouped query, and the row domain under it.
#[tokio::test]
async fn a_grouped_projection_keeps_the_row_domain_of_the_full_tuples() {
    for (name, engine) in engines() {
        let batches = run(
            &engine,
            QueryRequest {
                measures: vec!["RevNoStore".into()],
                group_by: vec![ColumnRef::new("Product", "cat")],
                scoped_tuple_filters: vec![diagonal()],
                ..Default::default()
            },
        )
        .await;
        assert_eq!(
            by_group(&batches, &["cat"], "RevNoStore"),
            expected(&[("A", 67.0), ("B", 12.0)]),
            "{name}: A = r1 + r2 + r7, B = r3 + r4"
        );
        // Grouped by the column the measure keeps, with EVERY measure clearing
        // the other table: the row-domain probe still reads Product[cat] (its
        // table joins although no measure condition names it), and region z
        // (in no tuple) is not a row.
        let batches = run(
            &engine,
            QueryRequest {
                measures: vec!["RevNoProduct".into()],
                group_by: vec![ColumnRef::new("Store", "region")],
                scoped_tuple_filters: vec![diagonal()],
                ..Default::default()
            },
        )
        .await;
        assert_eq!(
            by_group(&batches, &["region"], "RevNoProduct"),
            expected(&[("x", 21.0), ("y", 42.0)]),
            "{name}: x = r1 + r3 + r5, y = r2 + r4 + r6; z is outside the tuple set"
        );
    }
}

// 3. Clearing every column removes the filter for that measure.
#[tokio::test]
async fn clearing_every_column_removes_the_filter() {
    for (name, engine) in engines() {
        let batches = run(&engine, measure_only(&["Revenue", "Total"], diagonal())).await;
        assert_eq!(scalar(&batches, "Revenue"), 9.0, "{name}");
        assert_eq!(
            scalar(&batches, "Total"),
            127.0,
            "{name}: RESET() clears both columns"
        );
    }
}

// 4. The blank member on a text column (NULL and "") and on an int column.
#[tokio::test]
async fn the_blank_member_on_a_text_and_an_integer_column() {
    for (name, engine) in engines() {
        let text = tuple(
            &[("Product", "cat"), ("Store", "region")],
            &[
                &[BLANK_MEMBER_LABEL, "x"],
                &[BLANK_MEMBER_LABEL, "y"],
                &["A", "z"],
            ],
        );
        let batches = run(&engine, measure_only(&["Revenue"], text)).await;
        assert_eq!(
            scalar(&batches, "Revenue"),
            112.0,
            "{name}: (blank, x) = r5 (NULL cat), (blank, y) = r6 (empty cat), (A, z) = r7"
        );
        // Any case, as the host spells it back.
        let text_case = tuple(
            &[("Product", "cat"), ("Store", "region")],
            &[&["(Blank)", "y"]],
        );
        assert_eq!(
            scalar(
                &run(&engine, measure_only(&["Revenue"], text_case)).await,
                "Revenue"
            ),
            32.0
        );

        let int = tuple(
            &[("Sales", "code"), ("Store", "region")],
            &[
                &[BLANK_MEMBER_LABEL, "x"],
                &[BLANK_MEMBER_LABEL, "z"],
                &["1", "y"],
            ],
        );
        let batches = run(&engine, measure_only(&["Revenue"], int)).await;
        assert_eq!(
            scalar(&batches, "Revenue"),
            82.0,
            "{name}: (blank code, x) = r5, (blank code, z) = r7, (1, y) = r2 -- never (1, x) = r1"
        );
    }
}

// 5. An empty tuple list matches nothing (never everything).
#[tokio::test]
async fn an_empty_tuple_list_matches_nothing() {
    for (name, engine) in engines() {
        let empty = tuple(&[("Product", "cat"), ("Store", "region")], &[]);
        let batches = run(&engine, measure_only(&["Revenue", "Total"], empty)).await;
        assert_eq!(
            scalar(&batches, "Revenue"),
            0.0,
            "{name}: an empty selection keeps no row"
        );
        assert_eq!(
            scalar(&batches, "Total"),
            127.0,
            "{name}: the clearing measure still sees all"
        );
    }
}

// 6. Cache key: order, values, level and columns all part of the key.
#[test]
fn the_cache_key_distinguishes_tuple_order_values_level_and_columns() {
    let key = |f: ScopedTupleFilter| query_cache_key(&measure_only(&["Revenue"], f), 0, 0, None);
    let base = diagonal();
    assert_eq!(
        key(base.clone()),
        key(diagonal()),
        "the same selection shares a key"
    );

    let mut reordered = base.clone();
    reordered.tuples.reverse();
    assert_ne!(key(base.clone()), key(reordered), "tuple order");

    let mut other_value = base.clone();
    other_value.tuples[1][1] = "x".into();
    assert_ne!(key(base.clone()), key(other_value), "tuple values");

    let mut pinned = base.clone();
    pinned.level = 2;
    assert_ne!(key(base.clone()), key(pinned), "level");

    let mut unqualified = base.clone();
    unqualified.columns[0].table = None;
    assert_ne!(key(base.clone()), key(unqualified), "table attribution");

    let no_tuple = query_cache_key(
        &QueryRequest {
            measures: vec!["Revenue".into()],
            ..Default::default()
        },
        0,
        0,
        None,
    );
    assert_ne!(key(base), no_tuple, "a tuple filter vs none");
}

/// The cache key reaches the engine's REAL cache: two selections that differ
/// only in a value never return the first one's cached answer.
#[tokio::test]
async fn the_query_cache_never_serves_one_selection_for_another() {
    let mut engine = cached_engine();
    engine.set_query_cache_config(crate::QueryCacheConfig {
        enabled: true,
        ..Default::default()
    });
    let first = run(&engine, measure_only(&["Revenue"], diagonal())).await;
    assert_eq!(scalar(&first, "Revenue"), 9.0);
    let other = tuple(
        &[("Product", "cat"), ("Store", "region")],
        &[&["A", "x"], &["B", "x"]],
    );
    let second = run(&engine, measure_only(&["Revenue"], other)).await;
    assert_eq!(scalar(&second, "Revenue"), 5.0, "(A, x) + (B, x) = r1 + r3");
    // The first selection again is a real cache HIT (the cache is live).
    let hits_before = engine.query_cache_stats().hits;
    let third = run(&engine, measure_only(&["Revenue"], diagonal())).await;
    assert_eq!(scalar(&third, "Revenue"), 9.0);
    assert_eq!(
        engine.query_cache_stats().hits,
        hits_before + 1,
        "the cache is live"
    );
}

// 7. OLS: a denied column inside a tuple is refused.
#[tokio::test]
async fn a_denied_column_in_a_tuple_is_refused() {
    let mut engine = cached_engine();
    engine.set_active_role(Some("NoRegion".into()));
    let err = engine
        .query(measure_only(&["Revenue"], diagonal()))
        .await
        .expect_err("a tuple over a denied column must be refused");
    assert!(
        matches!(
            err,
            QueryError::Engine(EngineError::ObjectLevelSecurityDenied { .. })
        ),
        "{err:?}"
    );
    // ...and unqualified, matched conservatively by name.
    let mut bare = diagonal();
    bare.columns[1].table = None;
    let err = engine
        .query(measure_only(&["Revenue"], bare))
        .await
        .expect_err("bare name");
    assert!(
        matches!(
            err,
            QueryError::Engine(EngineError::ObjectLevelSecurityDenied { .. })
        ),
        "{err:?}"
    );
    // The same request without the tuple is permitted.
    engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            ..Default::default()
        })
        .await
        .expect("Revenue alone is permitted");
}

// 8. Ambiguity and malformed tuples fail closed.
#[tokio::test]
async fn an_ambiguous_or_malformed_tuple_filter_fails_closed() {
    let engine = cached_engine();
    let ambiguous = ScopedTupleFilter {
        columns: vec![
            TupleColumn {
                table: None,
                column: "id".into(),
            },
            TupleColumn::new("Store", "region"),
        ],
        tuples: vec![vec!["1".into(), "x".into()]],
        level: 1,
    };
    let err = engine
        .query(measure_only(&["Revenue"], ambiguous))
        .await
        .expect_err("ambiguous");
    assert!(
        matches!(&err, QueryError::InvalidQuery(m) if m.contains("in more than one table") && m.contains("name its table")),
        "{err:?}"
    );

    // A unique bare name resolves (cat lives only on Product).
    let mut bare = diagonal();
    bare.columns[0].table = None;
    assert_eq!(
        scalar(
            &run(&engine, measure_only(&["Revenue"], bare)).await,
            "Revenue"
        ),
        9.0
    );

    let mut ragged = diagonal();
    ragged.tuples[1].pop();
    let err = engine
        .query(measure_only(&["Revenue"], ragged))
        .await
        .expect_err("ragged");
    assert!(
        matches!(&err, QueryError::InvalidQuery(m) if m.contains("value(s)")),
        "{err:?}"
    );

    let no_columns = ScopedTupleFilter {
        columns: vec![],
        tuples: vec![],
        level: 1,
    };
    let err = engine
        .query(measure_only(&["Revenue"], no_columns))
        .await
        .expect_err("no column");
    assert!(matches!(err, QueryError::InvalidQuery(_)), "{err:?}");

    let mut twice = diagonal();
    twice.columns[1] = TupleColumn::new("Product", "cat");
    let err = engine
        .query(measure_only(&["Revenue"], twice))
        .await
        .expect_err("twice");
    assert!(
        matches!(&err, QueryError::InvalidQuery(m) if m.contains("twice")),
        "{err:?}"
    );

    let mut bad_level = diagonal();
    bad_level.level = 0;
    let err = engine
        .query(measure_only(&["Revenue"], bad_level))
        .await
        .expect_err("level 0");
    assert!(matches!(err, QueryError::InvalidQuery(_)), "{err:?}");

    let unknown = tuple(&[("Nowhere", "cat"), ("Store", "region")], &[&["A", "x"]]);
    let err = engine
        .query(measure_only(&["Revenue"], unknown))
        .await
        .expect_err("unknown table");
    assert!(matches!(err, QueryError::InvalidQuery(_)), "{err:?}");

    let rollup = QueryRequest {
        measures: vec!["Revenue".into()],
        group_by: vec![ColumnRef::new("Product", "cat")],
        totals: TotalsMode::Rollup,
        scoped_tuple_filters: vec![diagonal()],
        ..Default::default()
    };
    let err = engine
        .query(rollup)
        .await
        .expect_err("ROLLUP under a tuple filter");
    assert!(
        matches!(&err, QueryError::InvalidQuery(m) if m.contains("ROLLUP")),
        "{err:?}"
    );
}

fn collect_property(node: &crate::PlanNode, key: &str, out: &mut Vec<String>) {
    for p in &node.properties {
        if p.key == key {
            match &p.value {
                crate::PlanValue::List(items) => out.extend(items.iter().cloned()),
                crate::PlanValue::Text(t) => out.push(t.clone()),
                other => out.push(format!("{other:?}")),
            }
        }
    }
    for child in &node.children {
        collect_property(child, key, out);
    }
}

// 9. Pre-narrowing: per-column INs for the UNCLEARED columns only.
#[tokio::test]
async fn explain_shows_the_pre_narrowing_in_lists_for_uncleared_columns_only() {
    let engine = connector_engine();

    // Nobody clears: both columns pre-narrow their own table's fetch.
    let (batches, plan) = engine
        .query_explained(measure_only(&["Revenue"], diagonal()))
        .await
        .expect("explain");
    assert_eq!(scalar(&batches, "Revenue"), 9.0);
    let mut pushed = Vec::new();
    collect_property(&plan.root, "in_filters_pushed", &mut pushed);
    assert!(
        pushed.iter().any(|p| p == "Product.cat IN (2 value(s))"),
        "{pushed:?}"
    );
    assert!(
        pushed.iter().any(|p| p == "Store.region IN (2 value(s))"),
        "{pushed:?}"
    );
    let mut described = Vec::new();
    collect_property(&plan.root, "tuple_filters", &mut described);
    assert_eq!(described.len(), 1, "{described:?}");
    assert!(described[0].contains("2 tuple(s)"), "{described:?}");

    // RevNoProduct clears Product[cat]: only Store[region] pre-narrows -- a
    // fetch-time IN on cat would delete the rows the clearing measure needs.
    let (batches, plan) = engine
        .query_explained(measure_only(&["Revenue", "RevNoProduct"], diagonal()))
        .await
        .expect("explain");
    assert_eq!(scalar(&batches, "Revenue"), 9.0);
    assert_eq!(scalar(&batches, "RevNoProduct"), 63.0);
    let mut pushed = Vec::new();
    collect_property(&plan.root, "in_filters_pushed", &mut pushed);
    assert!(
        pushed.iter().any(|p| p == "Store.region IN (2 value(s))"),
        "{pushed:?}"
    );
    assert!(
        !pushed.iter().any(|p| p.starts_with("Product.cat")),
        "{pushed:?}"
    );
    let mut described = Vec::new();
    collect_property(&plan.root, "tuple_filters", &mut described);
    assert!(
        described[0].contains("RevNoProduct clears Product[cat]"),
        "{described:?}"
    );
    assert!(
        described[0].contains("pre-narrowed at fetch: Store[region]"),
        "{described:?}"
    );
}

// 10. A compound share measure is refused with the typed contested-clear text.
#[tokio::test]
async fn a_compound_share_measure_under_a_tuple_filter_is_refused_never_a_number() {
    for (name, engine) in engines() {
        let err = engine
            .query(measure_only(&["Share"], diagonal()))
            .await
            .expect_err("a compound measure under a tuple filter must be refused");
        assert!(
            matches!(&err, QueryError::InvalidQuery(m) if m.contains(" clears ")),
            "{name}: the host reads ' clears ' as the contested-clear refusal: {err:?}"
        );
    }
}

// 11. Projection widening: a tuple on a column in no group-by and no other
// filter still filters (the column reached the joined frame). The in-memory
// connector scans whole batches, so the widened PROJECTION itself is pinned at
// the planner (`a_tuple_filter_plans_local_with_widened_projection_and_
// pre_narrowing` in engine-query's pushdown tests, which a sabotage of the
// widening fails); this test pins the end-to-end answer.
#[tokio::test]
async fn a_tuple_on_a_column_outside_every_group_by_and_filter_still_filters() {
    for (name, engine) in engines() {
        let codes = tuple(
            &[("Sales", "code"), ("Store", "region")],
            &[&["2", "x"], &["1", "y"]],
        );
        let batches = run(
            &engine,
            QueryRequest {
                measures: vec!["Revenue".into()],
                group_by: vec![ColumnRef::new("Product", "cat")],
                scoped_tuple_filters: vec![codes],
                ..Default::default()
            },
        )
        .await;
        assert_eq!(
            by_group(&batches, &["cat"], "Revenue"),
            expected(&[("A", 2.0), ("B", 4.0)]),
            "{name}: (2, x) = r3 (B), (1, y) = r2 (A)"
        );
    }
}

/// The shared IN-list renderer behind contested IN-lists and tuple filters:
/// an EMPTY contested IN-list (a slicer with nothing selected, which a
/// clearing measure contests) keeps no row for the honouring measure and
/// every row for the clearing one -- never a DataFusion internal error
/// (BUG-0525).
#[tokio::test]
async fn an_empty_contested_in_list_matches_nothing() {
    for (name, engine) in engines() {
        let batches = run(
            &engine,
            QueryRequest {
                measures: vec!["Revenue".into(), "Total".into()],
                scoped_in_filters: vec![crate::ScopedInFilter {
                    table: Some("Store".into()),
                    filter: crate::InFilter::new("region", Vec::<String>::new()),
                    level: 1,
                }],
                ..Default::default()
            },
        )
        .await;
        assert_eq!(scalar(&batches, "Revenue"), 0.0, "{name}");
        assert_eq!(scalar(&batches, "Total"), 127.0, "{name}");
    }
}

/// The same row-domain probe for a CONTESTED IN-list whose table no measure
/// condition joins (the only measure clears it): the grouped result keeps
/// only groups with a row matching the slicer, and the probe's table joins
/// (BUG-0526).
#[tokio::test]
async fn a_contested_filter_cleared_by_every_measure_still_bounds_the_grouped_rows() {
    for (name, engine) in engines() {
        let batches = run(
            &engine,
            QueryRequest {
                measures: vec!["RevNoProduct".into()],
                group_by: vec![ColumnRef::new("Store", "region")],
                scoped_in_filters: vec![crate::ScopedInFilter {
                    table: Some("Product".into()),
                    filter: crate::InFilter::new("cat", ["B"]),
                    level: 1,
                }],
                ..Default::default()
            },
        )
        .await;
        assert_eq!(
            by_group(&batches, &["region"], "RevNoProduct"),
            expected(&[("x", 21.0), ("y", 42.0)]),
            "{name}: z has no B row, so it is not a row; x and y show the cleared totals"
        );
    }
}
