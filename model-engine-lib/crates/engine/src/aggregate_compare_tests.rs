//! A measure-level comparison whose operands are AGGREGATES (or expressions
//! over them) reads a BLANK side as DAX does, end to end through
//! `Engine::query` on the LOCAL (DataFusion) path (BUG-0762, ledger programme
//! 2): "BLANK or a blank value is converted to 0, "", or False, depending on
//! the data type of the other compared value" (Microsoft, *Data types in
//! Power BI*). `SUM(a) > SUM(b)` with one sum BLANK answered SQL's NULL -- a
//! bare boolean measure was BLANK, and `IF(SUM(a) < SUM(b), ...)` took the
//! ELSE branch where DAX takes the THEN.
//!
//! The fixture mirrors the [LIVE] probe of Excel 16's data model (the Power BI
//! DAX engine, 2026-11-06), one row per `k`:
//!
//! | k | a     | b     | d          | prod |
//! |---|-------|-------|------------|------|
//! | 1 | 10    | 5     | 2024-01-10 | 1    |
//! | 2 | BLANK | 3     | BLANK      | 2    |
//! | 3 | 7     | BLANK | 2024-01-08 | 1    |
//! | 4 | BLANK | BLANK | BLANK      | 2    |
//!
//! [LIVE] per row: BLANK > 3 is FALSE, BLANK < 3 TRUE; 7 > BLANK TRUE;
//! BLANK = BLANK TRUE, <> FALSE, >= TRUE, < FALSE; BLANK < BLANK + 1 TRUE;
//! `IF(BLANK < 3, "yes", "no")` is "yes"; `NOT(BLANK > 3)` TRUE; `SUM(a) =
//! BLANK()` TRUE over BLANK, FALSE over 10; `MAX(d) < DATE(2020, 1, 1)` TRUE
//! over no date; `SWITCH(<BLANK>, 0, ...)` takes the else (SWITCH is
//! strict), `SWITCH(<BLANK>, <BLANK>, ...)` matches. Product 1 is Bikes, 2
//! Helmets.

#![cfg(test)]

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{Array, Date32Array, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Schema};
use arrow::record_batch::RecordBatch;

use crate::expression::{agg, compare, qualified_col};
use crate::{
    expression_measure, parse_measure, AggregateOp, Column, ColumnRef, ComparisonOp, DataModel,
    DataType, Engine, Expression, FilterCondition, FilterOperator, Measure, QueryRequest,
    Relationship, SourceBinding, StorageMode, Table,
};

fn sum(column: &str) -> Expression {
    agg(AggregateOp::Sum, qualified_col("Sales", column))
}

fn bool_measure(name: &str, expr: Expression) -> Measure {
    expression_measure(name, expr)
}

/// The measures, with their DAX answer per `k` (`None` is BLANK; a boolean
/// TRUE is 1, FALSE 0).
fn cases() -> Vec<(Measure, [Option<f64>; 4])> {
    let t = Some(1.0);
    let f = Some(0.0);
    let parsed = |name: &str, formula: &str| {
        expression_measure(name, parse_measure(formula).unwrap_or_else(|e| panic!("{name}: {e}")))
    };
    vec![
        (bool_measure("GtAB", compare(sum("a"), ComparisonOp::GreaterThan, sum("b"))), [t, f, t, f]),
        (bool_measure("LtAB", compare(sum("a"), ComparisonOp::LessThan, sum("b"))), [f, t, f, f]),
        (bool_measure("EqAB", compare(sum("a"), ComparisonOp::Equal, sum("b"))), [f, f, f, t]),
        (bool_measure("NeAB", compare(sum("a"), ComparisonOp::NotEqual, sum("b"))), [t, t, t, f]),
        (
            bool_measure("GeAB", compare(sum("a"), ComparisonOp::GreaterThanOrEqual, sum("b"))),
            [t, f, t, t],
        ),
        (
            bool_measure(
                "LtABPlusOne",
                compare(sum("a"), ComparisonOp::LessThan, sum("b").add(Expression::LiteralInt(1))),
            ),
            [f, t, f, t],
        ),
        (
            bool_measure(
                "NotGt",
                Expression::Not(Box::new(compare(sum("a"), ComparisonOp::GreaterThan, sum("b")))),
            ),
            [f, t, f, t],
        ),
        (bool_measure("EqBlank", compare(sum("a"), ComparisonOp::Equal, Expression::Blank)), [f, t, f, t]),
        (
            bool_measure(
                "DateBefore2020",
                compare(
                    agg(AggregateOp::Max, qualified_col("Sales", "d")),
                    ComparisonOp::LessThan,
                    Expression::LiteralDate(18_262),
                ),
            ),
            [f, t, f, t],
        ),
        // IF conditions: the branch DAX takes.
        (parsed("IfLt", "IF(SUM(Sales[a]) < SUM(Sales[b]), 1, 2)"), [Some(2.0), Some(1.0), Some(2.0), Some(2.0)]),
        (
            parsed("IfGe", "IF(SUM(Sales[a]) >= SUM(Sales[b]), 1, 2)"),
            [Some(1.0), Some(2.0), Some(1.0), Some(1.0)],
        ),
        // SWITCH is STRICT: a BLANK subject matches no number, only BLANK.
        (parsed("SwitchZero", "SWITCH(SUM(Sales[a]), 0, 1, 2)"), [Some(2.0), Some(2.0), Some(2.0), Some(2.0)]),
        (
            parsed("SwitchBlank", "SWITCH(SUM(Sales[a]), SUM(Sales[b]), 1, 2)"),
            [Some(2.0), Some(2.0), Some(2.0), Some(1.0)],
        ),
        // Two sides whose kind only their COLUMNS show (wave 3, lane engfix):
        // [LIVE] `CALCULATE(MAX(T[a]) > MIN(T[b]), T[k] = 2)` is FALSE.
        (
            bool_measure(
                "MaxGtMin",
                compare(
                    agg(AggregateOp::Max, qualified_col("Sales", "a")),
                    ComparisonOp::GreaterThan,
                    agg(AggregateOp::Min, qualified_col("Sales", "b")),
                ),
            ),
            [t, f, t, f],
        ),
        (parsed("IfMaxLtMin", "IF(MAX(Sales[a]) < MIN(Sales[b]), 1, 2)"), [Some(2.0), Some(1.0), Some(2.0), Some(2.0)]),
        (
            parsed("IfSelectedGtMax", "IF(SELECTEDVALUE(Sales[a]) > MAX(Sales[b]), 1, 2)"),
            [Some(1.0), Some(2.0), Some(1.0), Some(2.0)],
        ),
        // Date arithmetic is in days; a BLANK date is DATE(1899, 12, 30), so
        // BLANK < BLANK + 1 too. Both failed to plan (`COALESCE(<date>, 0)`).
        (
            parsed("IfBeforeMinPlusOne", "IF(MAX(Sales[d]) < MIN(Sales[d]) + 1, 1, 2)"),
            [Some(1.0), Some(1.0), Some(1.0), Some(1.0)],
        ),
        (
            parsed("IfWithinThirtyDays", "IF(MAX(Sales[d]) > TODAY() - 30, 1, 2)"),
            [Some(2.0), Some(2.0), Some(2.0), Some(2.0)],
        ),
    ]
}

fn model(extra: Vec<Measure>) -> DataModel {
    let mut builder = DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("k", DataType::Int64),
                    Column::new("prod", DataType::Int64),
                    Column::new("a", DataType::Float64),
                    Column::new("b", DataType::Float64),
                    Column::new("d", DataType::Date),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_table(
            Table::new(
                "Product",
                vec![Column::new("id", DataType::Int64), Column::new("name", DataType::String)],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_relationship(Relationship::many_to_one("Sales_Product", "Sales", "prod", "Product", "id"));
    for (m, _) in cases() {
        builder = builder.add_measure(m);
    }
    for m in extra {
        builder = builder.add_measure(m);
    }
    builder.build().unwrap()
}

fn engine_for(model: DataModel) -> Engine {
    let mut engine = Engine::new(model);
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    engine.bind_table("Product", 0, SourceBinding::new("public", "product"));
    engine
        .cache
        .store(
            "Sales",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("k", ArrowType::Int64, true),
                    Field::new("prod", ArrowType::Int64, true),
                    Field::new("a", ArrowType::Float64, true),
                    Field::new("b", ArrowType::Float64, true),
                    Field::new("d", ArrowType::Date32, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1, 2, 3, 4])),
                    Arc::new(Int64Array::from(vec![1, 2, 1, 2])),
                    Arc::new(Float64Array::from(vec![Some(10.0), None, Some(7.0), None])),
                    Arc::new(Float64Array::from(vec![Some(5.0), Some(3.0), None, None])),
                    Arc::new(Date32Array::from(vec![Some(19_732), None, Some(19_730), None])),
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

fn value(column: &dyn Array, row: usize) -> Option<f64> {
    if column.is_null(row) {
        return None;
    }
    let as_f64 = arrow::compute::cast(&column.slice(row, 1), &ArrowType::Float64).unwrap();
    Some(as_f64.as_any().downcast_ref::<Float64Array>().unwrap().value(0))
}

/// `measures` grouped by `Sales[k]`: k -> measure -> answer.
async fn by_k(engine: &Engine, measures: &[&str]) -> HashMap<i64, HashMap<String, Option<f64>>> {
    let batches = engine
        .query(QueryRequest {
            measures: measures.iter().map(|m| m.to_string()).collect(),
            group_by: vec![ColumnRef::new("Sales", "k")],
            ..Default::default()
        })
        .await
        .unwrap_or_else(|e| panic!("{measures:?}: {e}"));
    let mut out: HashMap<i64, HashMap<String, Option<f64>>> = HashMap::new();
    for b in &batches {
        let k = b.column(b.schema().index_of("k").unwrap());
        let k = arrow::compute::cast(k, &ArrowType::Int64).unwrap();
        let k = k.as_any().downcast_ref::<Int64Array>().unwrap();
        for row in 0..b.num_rows() {
            let entry = out.entry(k.value(row)).or_default();
            for m in measures {
                let col = b.column(b.schema().index_of(m).unwrap());
                entry.insert((*m).to_string(), value(col.as_ref(), row));
            }
        }
    }
    out
}

/// `measures` ungrouped, under the filter `Sales[k] = k` (DAX's
/// `CALCULATE(..., T[k] = k)` of the probe).
async fn at_k(engine: &Engine, measures: &[&str], k: i64) -> HashMap<String, Option<f64>> {
    let batches = engine
        .query(QueryRequest {
            measures: measures.iter().map(|m| m.to_string()).collect(),
            filters: vec![FilterCondition::new("k", FilterOperator::Equal, k.to_string())],
            ..Default::default()
        })
        .await
        .unwrap_or_else(|e| panic!("{measures:?} at k = {k}: {e}"));
    let b = batches.iter().find(|b| b.num_rows() == 1).expect("one ungrouped row");
    measures
        .iter()
        .map(|m| ((*m).to_string(), value(b.column(b.schema().index_of(m).unwrap()).as_ref(), 0)))
        .collect()
}

#[tokio::test]
async fn an_aggregate_comparison_reads_a_blank_side_as_dax_does_ungrouped() {
    let e = engine_for(model(Vec::new()));
    for (m, want) in cases() {
        for k in 1..=4i64 {
            let got = at_k(&e, &[m.name()], k).await;
            assert_eq!(got[m.name()], want[(k - 1) as usize], "{} at k = {k}", m.name());
        }
    }
}

#[tokio::test]
async fn an_aggregate_comparison_reads_a_blank_side_as_dax_does_grouped() {
    let e = engine_for(model(Vec::new()));
    let all = cases();
    let names: Vec<&str> = all.iter().map(|(m, _)| m.name()).collect();
    // Each measure alone, then all of them in one query.
    for (m, want) in &all {
        let got = by_k(&e, &[m.name()]).await;
        for k in 1..=4i64 {
            let cell = got.get(&k).and_then(|row| row.get(m.name()).copied()).flatten();
            assert_eq!(cell, want[(k - 1) as usize], "{} for k = {k}: {got:?}", m.name());
        }
    }
    let got = by_k(&e, &names).await;
    for (m, want) in &all {
        for k in 1..=4i64 {
            let cell = got.get(&k).and_then(|row| row.get(m.name()).copied()).flatten();
            assert_eq!(cell, want[(k - 1) as usize], "{} for k = {k} in one query", m.name());
        }
    }
}

#[tokio::test]
async fn a_keep_scoped_aggregate_compares_its_blank_as_dax_does() {
    // The Helmets rows (k 2 and 4) have no `a`: the KEEP-scoped sum is BLANK,
    // the unfiltered SUM(b) is 8. BLANK < 8 is TRUE, BLANK > 8 FALSE -- on the
    // compound route each operand resolves its own context.
    let helmets = parse_measure("SUM(Sales[a], KEEP(Product, Product[name] = \"Helmets\"))").unwrap();
    let extra = vec![
        expression_measure(
            "HelmetsBelowB",
            compare(helmets.clone(), ComparisonOp::LessThan, sum("b")),
        ),
        expression_measure(
            "HelmetsAboveB",
            compare(helmets, ComparisonOp::GreaterThan, sum("b")),
        ),
        expression_measure(
            "IfHelmetsBelowB",
            parse_measure(
                "IF(SUM(Sales[a], KEEP(Product, Product[name] = \"Helmets\")) < SUM(Sales[b]), 1, 2)",
            )
            .unwrap(),
        ),
    ];
    let e = engine_for(model(extra));
    let names = ["HelmetsBelowB", "HelmetsAboveB", "IfHelmetsBelowB"];
    let batches = e
        .query(QueryRequest {
            measures: names.iter().map(|m| m.to_string()).collect(),
            ..Default::default()
        })
        .await
        .unwrap();
    let b = batches.iter().find(|b| b.num_rows() == 1).expect("one row");
    let get = |m: &str| value(b.column(b.schema().index_of(m).unwrap()).as_ref(), 0);
    assert_eq!(get("HelmetsBelowB"), Some(1.0), "BLANK < 8");
    assert_eq!(get("HelmetsAboveB"), Some(0.0), "BLANK > 8");
    assert_eq!(get("IfHelmetsBelowB"), Some(1.0), "IF(BLANK < 8, 1, 2)");
    for m in names {
        let batches = e
            .query(QueryRequest {
                measures: vec![m.to_string()],
                ..Default::default()
            })
            .await
            .unwrap();
        let b = batches.iter().find(|b| b.num_rows() == 1).expect("one row");
        let alone = value(b.column(b.schema().index_of(m).unwrap()).as_ref(), 0);
        assert_eq!(alone, get(m), "{m} asked alone");
    }
}
