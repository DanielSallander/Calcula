//! End-to-end measure-value ranking (`QueryRequest.rank_by`, DAX `RANKX`-style).
//!
//! Built over an in-memory star schema served from the cache. Fixture:
//! `Sales(prod_id, region_id, amount)` → `Product(id, name)` and `Region(id,
//! region)`. Per product — Revenue = SUM(amount): Bikes 130, Helmets 60,
//! Tires 60 (a tie with Helmets), Widgets 10.

#![cfg(test)]

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{Array, DictionaryArray, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Int32Type, Schema};
use arrow::record_batch::RecordBatch;

use crate::{
    sum_measure, Column, ColumnRef, DataModel, DataType, Engine, OrderByClause, QueryError,
    QueryRequest, RankBy, Relationship, SourceBinding, StorageMode, Table, TotalsMode,
};

fn rank_model() -> DataModel {
    let in_mem = |t: Table| t.with_storage_mode(StorageMode::InMemory);
    DataModel::builder()
        .add_table(in_mem(
            Table::new(
                "Sales",
                vec![
                    Column::new("prod_id", DataType::Int64),
                    Column::new("region_id", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap(),
        ))
        .add_table(in_mem(
            Table::new(
                "Product",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("name", DataType::String),
                ],
            )
            .unwrap(),
        ))
        .add_table(in_mem(
            Table::new(
                "Region",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("region", DataType::String),
                ],
            )
            .unwrap(),
        ))
        .add_relationship(Relationship::many_to_one(
            "Sales_Product",
            "Sales",
            "prod_id",
            "Product",
            "id",
        ))
        .add_relationship(Relationship::many_to_one(
            "Sales_Region",
            "Sales",
            "region_id",
            "Region",
            "id",
        ))
        .add_measure(sum_measure("Revenue", "Sales", "amount"))
        .build()
        .unwrap()
}

fn rank_engine() -> Engine {
    let mut engine = Engine::new(rank_model());
    for t in ["Sales", "Product", "Region"] {
        engine.bind_table(t, 0, SourceBinding::new("public", &t.to_lowercase()));
    }
    // Sales rows (prod, region, amount): Bikes(1)/East 100, Bikes/West 30,
    // Helmets(2)/East 60, Tires(3)/West 60, Widgets(4)/East 10.
    // Per product: Bikes 130, Helmets 60, Tires 60, Widgets 10.
    engine
        .cache
        .store(
            "Sales",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("prod_id", ArrowType::Int64, true),
                    Field::new("region_id", ArrowType::Int64, true),
                    Field::new("amount", ArrowType::Float64, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1, 1, 2, 3, 4])),
                    Arc::new(Int64Array::from(vec![1, 2, 1, 2, 1])),
                    Arc::new(Float64Array::from(vec![100.0, 30.0, 60.0, 60.0, 10.0])),
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
                    Arc::new(Int64Array::from(vec![1, 2, 3, 4])),
                    Arc::new(StringArray::from(vec![
                        "Bikes", "Helmets", "Tires", "Widgets",
                    ])),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    engine
        .cache
        .store(
            "Region",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("id", ArrowType::Int64, true),
                    Field::new("region", ArrowType::Utf8, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1, 2])),
                    Arc::new(StringArray::from(vec!["East", "West"])),
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

fn str_key(array: &dyn Array, row: usize) -> String {
    if let Some(a) = array.as_any().downcast_ref::<StringArray>() {
        a.value(row).to_string()
    } else if let Some(a) = array.as_any().downcast_ref::<DictionaryArray<Int32Type>>() {
        let values = a.values().as_any().downcast_ref::<StringArray>().unwrap();
        values.value(a.key(row).unwrap()).to_string()
    } else {
        panic!("unexpected group array type: {:?}", array.data_type());
    }
}

/// `product name -> rank` from a result carrying a `name` column and `rank_col`.
fn ranks_by_product(batches: &[RecordBatch], rank_col: &str) -> HashMap<String, i64> {
    let mut out = HashMap::new();
    for b in batches {
        let g = b.column(col_idx(b, "name"));
        let r = b
            .column(col_idx(b, rank_col))
            .as_any()
            .downcast_ref::<Int64Array>()
            .expect("rank column is Int64");
        for row in 0..b.num_rows() {
            out.insert(str_key(g.as_ref(), row), r.value(row));
        }
    }
    out
}

fn base_request(rank_by: Option<RankBy>) -> QueryRequest {
    QueryRequest {
        measures: vec!["Revenue".into()],
        group_by: vec![ColumnRef::new("Product", "name")],
        rank_by,
        ..Default::default()
    }
}

#[tokio::test]
async fn rank_descending_standard_ties() {
    // Bikes 130, Helmets 60, Tires 60, Widgets 10. Descending standard ranking:
    // 1, 2, 2 (tie), 4 (the tie consumes rank 3).
    let engine = rank_engine();
    let batches = engine
        .query(base_request(Some(RankBy::new("Revenue", "Rank"))))
        .await
        .unwrap();
    let r = ranks_by_product(&batches, "Rank");
    assert_eq!(r["Bikes"], 1);
    assert_eq!(r["Helmets"], 2);
    assert_eq!(r["Tires"], 2, "tie shares the rank");
    assert_eq!(
        r["Widgets"], 4,
        "standard ranking skips rank 3 after the tie"
    );
}

#[tokio::test]
async fn rank_dense_does_not_skip() {
    // Dense ranking after the 60/60 tie: 1, 2, 2, 3.
    let engine = rank_engine();
    let batches = engine
        .query(base_request(Some(RankBy::new("Revenue", "Rank").dense())))
        .await
        .unwrap();
    let r = ranks_by_product(&batches, "Rank");
    assert_eq!(r["Bikes"], 1);
    assert_eq!(r["Helmets"], 2);
    assert_eq!(r["Tires"], 2);
    assert_eq!(r["Widgets"], 3, "dense ranking does not skip");
}

#[tokio::test]
async fn rank_ascending_inverts_order() {
    // Ascending: Widgets(10)=1, then the 60 tie=2, Bikes(130)=4.
    let engine = rank_engine();
    let batches = engine
        .query(base_request(Some(
            RankBy::new("Revenue", "Rank").ascending(),
        )))
        .await
        .unwrap();
    let r = ranks_by_product(&batches, "Rank");
    assert_eq!(r["Widgets"], 1);
    assert_eq!(r["Helmets"], 2);
    assert_eq!(r["Tires"], 2);
    assert_eq!(r["Bikes"], 4);
}

#[tokio::test]
async fn rank_composes_with_order_and_limit_for_top_n() {
    // order by Revenue desc + rank + limit 2 → the top 2 products, each ranked.
    let engine = rank_engine();
    let req = QueryRequest {
        measures: vec!["Revenue".into()],
        group_by: vec![ColumnRef::new("Product", "name")],
        order_by: vec![OrderByClause::measure_desc("Revenue")],
        limit: Some(2),
        rank_by: Some(RankBy::new("Revenue", "Rank")),
        ..Default::default()
    };
    let batches = engine.query(req).await.unwrap();
    let total: usize = batches.iter().map(|b| b.num_rows()).sum();
    assert_eq!(total, 2, "limit applies after ranking");
    let r = ranks_by_product(&batches, "Rank");
    assert_eq!(r["Bikes"], 1);
    // The second row is one of the 60-tie products at rank 2.
    assert!(r.values().any(|&v| v == 2));
}

#[tokio::test]
async fn rank_partitioned_restarts_within_region() {
    // Rank products WITHIN each region. East: Bikes 100, Helmets 60, Widgets 10
    // → 1,2,3. West: Bikes 30, Tires 60 → Tires 1, Bikes 2.
    let engine = rank_engine();
    let req = QueryRequest {
        measures: vec!["Revenue".into()],
        group_by: vec![
            ColumnRef::new("Region", "region"),
            ColumnRef::new("Product", "name"),
        ],
        rank_by: Some(
            RankBy::new("Revenue", "Rank").within(vec![ColumnRef::new("Region", "region")]),
        ),
        ..Default::default()
    };
    let batches = engine.query(req).await.unwrap();
    // Collect (region, name) -> rank.
    let mut by_cell: HashMap<(String, String), i64> = HashMap::new();
    for b in &batches {
        let region = b.column(col_idx(b, "region"));
        let name = b.column(col_idx(b, "name"));
        let rank = b
            .column(col_idx(b, "Rank"))
            .as_any()
            .downcast_ref::<Int64Array>()
            .unwrap();
        for row in 0..b.num_rows() {
            by_cell.insert(
                (str_key(region.as_ref(), row), str_key(name.as_ref(), row)),
                rank.value(row),
            );
        }
    }
    assert_eq!(by_cell[&("East".into(), "Bikes".into())], 1);
    assert_eq!(by_cell[&("East".into(), "Helmets".into())], 2);
    assert_eq!(by_cell[&("East".into(), "Widgets".into())], 3);
    assert_eq!(by_cell[&("West".into(), "Tires".into())], 1);
    assert_eq!(by_cell[&("West".into(), "Bikes".into())], 2);
}

#[test]
fn rank_partition_key_does_not_collide_on_control_chars() {
    // Two partition columns whose values contain the byte a flattened key would
    // have used as a separator. Old scheme: P1=(x, \u{1}y) and P2=(x\u{1}, y)
    // flatten to the SAME string → merged into one partition (ranks 1,2). The
    // structured key keeps them distinct → each its own partition (rank 1,1).
    use arrow::datatypes::DataType as ArrowType;
    let batch = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("p1", ArrowType::Utf8, true),
            Field::new("p2", ArrowType::Utf8, true),
            Field::new("Revenue", ArrowType::Float64, true),
        ])),
        vec![
            Arc::new(StringArray::from(vec!["x", "x\u{1}"])),
            Arc::new(StringArray::from(vec!["\u{1}y", "y"])),
            Arc::new(Float64Array::from(vec![10.0, 20.0])),
        ],
    )
    .unwrap();
    let rank = RankBy::new("Revenue", "Rank")
        .within(vec![ColumnRef::new("T", "p1"), ColumnRef::new("T", "p2")]);
    let out = crate::apply_ranking(&[batch], &rank).unwrap();
    let b = &out[0];
    let r = b
        .column(col_idx(b, "Rank"))
        .as_any()
        .downcast_ref::<Int64Array>()
        .unwrap();
    assert_eq!(r.value(0), 1, "distinct partition → rank 1");
    assert_eq!(r.value(1), 1, "distinct partition → rank 1 (not merged)");
}

#[tokio::test]
async fn rank_unknown_measure_fails_closed() {
    let engine = rank_engine();
    let err = engine
        .query(base_request(Some(RankBy::new("Nonexistent", "Rank"))))
        .await
        .unwrap_err();
    assert!(
        matches!(err, QueryError::InvalidQuery(ref m) if m.contains("not in the request's measures")),
        "got {err:?}"
    );
}

#[tokio::test]
async fn rank_output_column_collision_fails_closed() {
    // Naming the rank column after an existing column must fail closed.
    let engine = rank_engine();
    let err = engine
        .query(base_request(Some(RankBy::new("Revenue", "Revenue"))))
        .await
        .unwrap_err();
    assert!(
        matches!(err, QueryError::InvalidQuery(ref m) if m.contains("collides")),
        "got {err:?}"
    );
}

#[tokio::test]
async fn rank_with_rollup_fails_closed() {
    let engine = rank_engine();
    let req = QueryRequest {
        measures: vec!["Revenue".into()],
        group_by: vec![ColumnRef::new("Product", "name")],
        totals: TotalsMode::Rollup,
        rank_by: Some(RankBy::new("Revenue", "Rank")),
        ..Default::default()
    };
    let err = engine.query(req).await.unwrap_err();
    assert!(
        matches!(err, QueryError::InvalidQuery(ref m) if m.contains("ROLLUP")),
        "got {err:?}"
    );
}
