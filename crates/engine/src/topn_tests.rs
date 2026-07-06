//! End-to-end request-level TOPN (`QueryRequest.top_n`, DAX `TOPN`, tie-inclusive).
//!
//! Over the same in-memory star schema as `rank_tests`. Per product —
//! Revenue = SUM(amount): Bikes 130, Helmets 60, Tires 60 (a tie), Widgets 10.
//! The headline behavior is **tie-inclusiveness**: `top_n.limit = 2` keeps THREE
//! products (Helmets and Tires both tie at the 2nd value).

#![cfg(test)]

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{Array, DictionaryArray, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Int32Type, Schema};
use arrow::record_batch::RecordBatch;

use crate::{
    sum_measure, CalculationGroup, CalculationGroupApplication, CalculationItem, Column, ColumnRef,
    DataModel, DataType, Engine, OrderByClause, QueryError, QueryRequest, Relationship,
    SourceBinding, StorageMode, Table, TopN, TotalsMode,
};

fn topn_model() -> DataModel {
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

fn topn_engine() -> Engine {
    let mut engine = Engine::new(topn_model());
    for t in ["Sales", "Product", "Region"] {
        engine.bind_table(t, 0, SourceBinding::new("public", &t.to_lowercase()));
    }
    // Sales (prod, region, amount): Bikes(1)/East 100, Bikes/West 30,
    // Helmets(2)/East 60, Tires(3)/West 60, Widgets(4)/East 10.
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

/// Set of product names in the result.
fn products(batches: &[RecordBatch]) -> Vec<String> {
    let mut out = Vec::new();
    for b in batches {
        let g = b.column(col_idx(b, "name"));
        for row in 0..b.num_rows() {
            out.push(str_key(g.as_ref(), row));
        }
    }
    out.sort();
    out
}

fn req(group_by: &[(&str, &str)], top_n: Option<TopN>) -> QueryRequest {
    QueryRequest {
        measures: vec!["Revenue".into()],
        group_by: group_by
            .iter()
            .map(|(t, c)| ColumnRef::new(*t, *c))
            .collect(),
        top_n,
        ..Default::default()
    }
}

#[tokio::test]
async fn topn_2_is_tie_inclusive() {
    // Top 2 by Revenue: Bikes(130) + the 60-tie (Helmets, Tires) = THREE rows,
    // because Helmets and Tires both sit at the 2nd value. (order_by+limit would
    // give exactly 2.)
    let engine = topn_engine();
    let batches = engine
        .query(req(&[("Product", "name")], Some(TopN::new("Revenue", 2))))
        .await
        .unwrap();
    assert_eq!(
        products(&batches),
        vec!["Bikes", "Helmets", "Tires"],
        "tie-inclusive top-2 keeps both 60-valued products"
    );
}

#[tokio::test]
async fn topn_1_is_single() {
    let engine = topn_engine();
    let batches = engine
        .query(req(&[("Product", "name")], Some(TopN::new("Revenue", 1))))
        .await
        .unwrap();
    assert_eq!(products(&batches), vec!["Bikes"]);
}

#[tokio::test]
async fn topn_ascending_takes_the_bottom() {
    // Bottom 2: Widgets(10) + the 60-tie (Helmets, Tires) = three rows; Bikes excluded.
    let engine = topn_engine();
    let batches = engine
        .query(req(
            &[("Product", "name")],
            Some(TopN::new("Revenue", 2).ascending()),
        ))
        .await
        .unwrap();
    assert_eq!(products(&batches), vec!["Helmets", "Tires", "Widgets"]);
}

#[tokio::test]
async fn topn_partitioned_per_region() {
    // Group by (region, product); top-1 within each region.
    // East: Bikes 100, Helmets 60, Widgets 10 → Bikes. West: Bikes 30, Tires 60 → Tires.
    let engine = topn_engine();
    let topn = TopN::new("Revenue", 1).within(vec![ColumnRef::new("Region", "region")]);
    let batches = engine
        .query(req(
            &[("Region", "region"), ("Product", "name")],
            Some(topn),
        ))
        .await
        .unwrap();
    // One winner per region, distinct partitions not merged.
    assert_eq!(products(&batches), vec!["Bikes", "Tires"]);
}

#[tokio::test]
async fn topn_tie_count_column() {
    // limit 2 with a tie-count column: 3 rows kept; the boundary value 60 is
    // shared by Helmets+Tires, so the tie count is 2 on every kept row.
    let engine = topn_engine();
    let topn = TopN::new("Revenue", 2).with_tie_count("TiedAtBoundary");
    let batches = engine
        .query(req(&[("Product", "name")], Some(topn)))
        .await
        .unwrap();
    let b = &batches[0];
    let tc = b
        .column(col_idx(b, "TiedAtBoundary"))
        .as_any()
        .downcast_ref::<Int64Array>()
        .expect("tie-count column is Int64");
    assert_eq!(b.num_rows(), 3);
    for i in 0..b.num_rows() {
        assert_eq!(tc.value(i), 2, "two products tie at the boundary value");
    }
}

#[tokio::test]
async fn topn_then_order_and_limit_truncates_exactly() {
    // top_n=2 (→ 3 tie-inclusive rows), then order desc + limit 2 → exactly 2.
    let engine = topn_engine();
    let mut request = req(&[("Product", "name")], Some(TopN::new("Revenue", 2)));
    request.order_by = vec![OrderByClause::measure_desc("Revenue")];
    request.limit = Some(2);
    let batches = engine.query(request).await.unwrap();
    let total: usize = batches.iter().map(|b| b.num_rows()).sum();
    assert_eq!(total, 2, "limit truncates the tie-inclusive result exactly");
    // The top row is Bikes (highest revenue).
    assert_eq!(
        str_key(batches[0].column(col_idx(&batches[0], "name")).as_ref(), 0),
        "Bikes"
    );
}

#[tokio::test]
async fn measure_filters_apply_before_topn() {
    // Revenue < 100 (keeps Helmets/Tires/Widgets, drops Bikes), then top_n=1.
    // With measure_filters FIRST: top-1 of {60,60,10} = the 60-tie = 2 rows.
    // (If top_n ran first it would pick Bikes(130), then the filter would drop
    // it → 0 rows; this value distinguishes the composition order.)
    let engine = topn_engine();
    let mut request = req(&[("Product", "name")], Some(TopN::new("Revenue", 1)));
    request.measure_filters = vec![crate::MeasureFilter {
        measure: "Revenue".into(),
        operator: engine_connectors::FilterOperator::LessThan,
        value: 100.0,
    }];
    let batches = engine.query(request).await.unwrap();
    assert_eq!(
        products(&batches),
        vec!["Helmets", "Tires"],
        "measure filter applies before top-N"
    );
}

#[tokio::test]
async fn topn_with_rollup_fails_closed() {
    let engine = topn_engine();
    let mut request = req(&[("Product", "name")], Some(TopN::new("Revenue", 2)));
    request.totals = TotalsMode::Rollup;
    let err = engine.query(request).await.unwrap_err();
    assert!(matches!(err, QueryError::InvalidQuery(_)), "got: {err:?}");
    assert!(err.to_string().contains("top_n"), "got: {err}");
}

#[tokio::test]
async fn topn_with_calc_group_fails_closed() {
    let mut model = topn_model();
    model = {
        let mut b = DataModel::builder();
        for t in model.tables() {
            b = b.add_table(t.clone());
        }
        for r in model.relationships() {
            b = b.add_relationship(r.clone());
        }
        for m in model.measures() {
            b = b.add_measure(m.clone());
        }
        b.add_calculation_group(CalculationGroup::new(
            "Time",
            vec![CalculationItem::new(
                "Current",
                engine_core::compute::parser::parse_measure_expression("SELECTEDMEASURE()")
                    .unwrap(),
            )],
        ))
        .build()
        .unwrap()
    };
    let mut engine = Engine::new(model);
    for t in ["Sales", "Product", "Region"] {
        engine.bind_table(t, 0, SourceBinding::new("public", &t.to_lowercase()));
    }
    let mut request = req(&[("Product", "name")], Some(TopN::new("Revenue", 2)));
    request.calculation_group = Some(CalculationGroupApplication::new("Time", vec![]));
    let err = engine.query(request).await.unwrap_err();
    assert!(matches!(err, QueryError::InvalidQuery(_)), "got: {err:?}");
}

#[tokio::test]
async fn topn_unknown_measure_fails_closed() {
    let engine = topn_engine();
    let err = engine
        .query(req(&[("Product", "name")], Some(TopN::new("Nope", 2))))
        .await
        .unwrap_err();
    assert!(matches!(err, QueryError::InvalidQuery(_)), "got: {err:?}");
}

#[tokio::test]
async fn topn_partition_not_in_group_by_fails_closed() {
    let engine = topn_engine();
    let topn = TopN::new("Revenue", 1).within(vec![ColumnRef::new("Region", "region")]);
    // group_by is Product only; the partition column 'region' is not present.
    let err = engine
        .query(req(&[("Product", "name")], Some(topn)))
        .await
        .unwrap_err();
    assert!(matches!(err, QueryError::InvalidQuery(_)), "got: {err:?}");
}

#[tokio::test]
async fn topn_output_column_collision_fails_closed() {
    let engine = topn_engine();
    let topn = TopN::new("Revenue", 2).with_tie_count("Revenue"); // collides
    let err = engine
        .query(req(&[("Product", "name")], Some(topn)))
        .await
        .unwrap_err();
    assert!(matches!(err, QueryError::InvalidQuery(_)), "got: {err:?}");
}
