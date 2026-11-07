//! A KEEP's simple predicate (`table[column] op literal`, a
//! [`FilterPredicate`](crate::FilterPredicate)) compares as the COLUMN's type,
//! end to end through `Engine::query` on the LOCAL (DataFusion) path
//! (BUG-0758, ledger programme 2).
//!
//! A FilterPredicate stores its literal as text (`"9"`); every renderer types
//! it from the model column before it reaches SQL, so `Sales[amount] > 9`
//! compares numbers as numbers (`10 > 9`), never text as text (`'10' > '9'`
//! is FALSE), a date column compares as a date, and a text column that holds
//! digits keeps comparing as TEXT (`"10" < "9"` is TRUE). DAX's own
//! `CALCULATE(SUM(T[amount]), T[amount] > 9)` is the reference.
//!
//! Fixture: `Sales(prod_id, amount, price, day, code)` -> `Product(id, name,
//! weight)`. Rows (prod_id, amount, price, day, code): `(1, 10, 10.0,
//! 2024-01-10, "10")`, `(2, 8, 8.0, 2024-01-08, "8")`; product 1 is Bikes
//! (weight 10.0), product 2 Helmets (weight 8.0).

#![cfg(test)]

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{Array, Date32Array, DictionaryArray, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Int32Type, Schema};
use arrow::record_batch::RecordBatch;

use crate::{
    expression_measure, parse_measure, Column, ColumnRef, DataModel, DataType, Engine,
    QueryRequest, Relationship, SourceBinding, StorageMode, Table,
};

/// (measure, formula, DAX answer over both rows; `None` is BLANK).
const MEASURES: &[(&str, &str, Option<f64>)] = &[
    ("Total", "SUM(Sales[amount])", Some(18.0)),
    // An integer column against an integer literal: 10 > 9 keeps the 10.
    // As text, '10' > '9' and '8' > '9' are both FALSE: BLANK.
    (
        "AmountOver9",
        "SUM(Sales[amount], KEEP(Sales, Sales[amount] > 9))",
        Some(10.0),
    ),
    // A floating-point column, an integer literal and a decimal literal.
    (
        "PriceOver9",
        "SUM(Sales[amount], KEEP(Sales, Sales[price] > 9))",
        Some(10.0),
    ),
    (
        "PriceOver9Half",
        "SUM(Sales[amount], KEEP(Sales, Sales[price] >= 9.5))",
        Some(10.0),
    ),
    // `<=` on an integer column: '10' <= '9' is TRUE as text (wrong).
    (
        "AmountAtMost9",
        "SUM(Sales[amount], KEEP(Sales, Sales[amount] <= 9))",
        Some(8.0),
    ),
    // A date column against a DATE compares as a date. (A date compared with
    // TEXT, `Sales[day] > "2024-01-09"`, is an error in DAX -- [LIVE] Excel
    // 16's data model refuses it -- so it is deliberately not pinned here;
    // wave 3 replaced the text form this test pinned.)
    (
        "DayAfter9th",
        "SUM(Sales[amount], KEEP(Sales, Sales[day] > DATE(2024, 1, 9)))",
        Some(10.0),
    ),
    // A TEXT column that holds digits keeps comparing as text: "10" < "9"
    // and "8" < "9" are both TRUE in DAX (and in SQL).
    (
        "CodeBelow9",
        "SUM(Sales[amount], KEEP(Sales, Sales[code] < \"9\"))",
        Some(18.0),
    ),
    // A dimension column, through the relationship.
    (
        "HeavyProducts",
        "SUM(Sales[amount], KEEP(Product, Product[weight] > 9))",
        Some(10.0),
    ),
    // COUNTROWS under the KEEP.
    (
        "RowsOver9",
        "COUNTROWS(Sales, KEEP(Sales, Sales[amount] > 9))",
        Some(1.0),
    ),
    // The compound routes: a KEEP inside a comparison and inside arithmetic.
    (
        "IfOver9",
        "IF(SUM(Sales[amount], KEEP(Sales, Sales[amount] > 9)) > 9, 1, 2)",
        Some(1.0),
    ),
    (
        "Over9PlusTotal",
        "SUM(Sales[amount], KEEP(Sales, Sales[amount] > 9)) + SUM(Sales[amount])",
        Some(28.0),
    ),
    // A CALCULATED column (`double_amount = amount * 2`: 20 and 16) is not
    // one of the table's physical columns: both rows are > 9. As text,
    // '20' > '9' and '16' > '9' are both FALSE.
    (
        "DoubleOver9",
        "SUM(Sales[amount], KEEP(Sales, Sales[double_amount] > 9))",
        Some(18.0),
    ),
];

fn model() -> DataModel {
    let mut builder = DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("prod_id", DataType::Int64),
                    Column::new("amount", DataType::Int64),
                    Column::new("price", DataType::Float64),
                    Column::new("day", DataType::Date),
                    Column::new("code", DataType::String),
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
                    Column::new("weight", DataType::Float64),
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
        .add_calculated_column(crate::CalculatedColumn::new(
            "double_amount",
            "Sales",
            crate::parse_measure_expression("Sales[amount] * 2").unwrap(),
            DataType::Int64,
        ));
    for (name, formula, _) in MEASURES {
        builder = builder.add_measure(expression_measure(
            *name,
            parse_measure(formula).unwrap_or_else(|e| panic!("{name}: {e}")),
        ));
    }
    builder.build().unwrap()
}

/// Days since 1970-01-01 of a 2024-01 day.
fn jan_2024(day: i32) -> i32 {
    19_723 + (day - 1)
}

fn engine() -> Engine {
    let mut engine = Engine::new(model());
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    engine.bind_table("Product", 0, SourceBinding::new("public", "product"));
    engine
        .cache
        .store(
            "Sales",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("prod_id", ArrowType::Int64, true),
                    Field::new("amount", ArrowType::Int64, true),
                    Field::new("price", ArrowType::Float64, true),
                    Field::new("day", ArrowType::Date32, true),
                    Field::new("code", ArrowType::Utf8, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1, 2])),
                    Arc::new(Int64Array::from(vec![10, 8])),
                    Arc::new(Float64Array::from(vec![10.0, 8.0])),
                    Arc::new(Date32Array::from(vec![jan_2024(10), jan_2024(8)])),
                    Arc::new(StringArray::from(vec!["10", "8"])),
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
                    Field::new("weight", ArrowType::Float64, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1, 2])),
                    Arc::new(StringArray::from(vec!["Bikes", "Helmets"])),
                    Arc::new(Float64Array::from(vec![10.0, 8.0])),
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

fn key(array: &dyn Array, row: usize) -> String {
    if let Some(a) = array.as_any().downcast_ref::<StringArray>() {
        a.value(row).to_string()
    } else if let Some(a) = array.as_any().downcast_ref::<DictionaryArray<Int32Type>>() {
        let values = a.values().as_any().downcast_ref::<StringArray>().unwrap();
        values.value(a.key(row).unwrap()).to_string()
    } else {
        panic!("unexpected group array type: {:?}", array.data_type());
    }
}

/// Ask `measures` grouped by `group` (or ungrouped): group key ("" when
/// ungrouped) -> measure -> answer.
async fn ask(
    engine: &Engine,
    measures: &[&str],
    group: Option<ColumnRef>,
) -> HashMap<String, HashMap<String, Option<f64>>> {
    let group_column = group.as_ref().map(|g| g.column.clone());
    let batches = engine
        .query(QueryRequest {
            measures: measures.iter().map(|m| m.to_string()).collect(),
            group_by: group.into_iter().collect(),
            ..Default::default()
        })
        .await
        .unwrap_or_else(|e| panic!("{measures:?}: {e}"));
    let mut out: HashMap<String, HashMap<String, Option<f64>>> = HashMap::new();
    for b in &batches {
        for row in 0..b.num_rows() {
            let k = match &group_column {
                Some(c) => key(b.column(b.schema().index_of(c).unwrap()).as_ref(), row),
                None => String::new(),
            };
            let entry = out.entry(k).or_default();
            for m in measures {
                let col = b.column(b.schema().index_of(m).unwrap());
                entry.insert((*m).to_string(), value(col.as_ref(), row));
            }
        }
    }
    out
}

fn expected(name: &str) -> Option<f64> {
    MEASURES
        .iter()
        .find(|(m, _, _)| *m == name)
        .unwrap_or_else(|| panic!("no measure {name}"))
        .2
}

#[tokio::test]
async fn a_keep_literal_compares_as_its_columns_type_ungrouped() {
    let e = engine();
    // Each measure alone, then all of them in one query.
    for (m, _, _) in MEASURES {
        let got = ask(&e, &[m], None).await;
        assert_eq!(got[""][*m], expected(m), "{m} asked alone: {got:?}");
    }
    let all: Vec<&str> = MEASURES.iter().map(|(m, _, _)| *m).collect();
    let got = ask(&e, &all, None).await;
    for m in &all {
        assert_eq!(got[""][*m], expected(m), "{m} in one shared query: {got:?}");
    }
}

#[tokio::test]
async fn a_keep_literal_compares_as_its_columns_type_grouped() {
    // Grouped by the dimension's name: the Bikes row is the amount-10 row,
    // the Helmets row the amount-8 row.
    let e = engine();
    let per_group: &[(&str, Option<f64>, Option<f64>)] = &[
        ("AmountOver9", Some(10.0), None),
        ("PriceOver9", Some(10.0), None),
        ("PriceOver9Half", Some(10.0), None),
        ("AmountAtMost9", None, Some(8.0)),
        ("DayAfter9th", Some(10.0), None),
        ("CodeBelow9", Some(10.0), Some(8.0)),
        ("HeavyProducts", Some(10.0), None),
        ("RowsOver9", Some(1.0), None),
        ("IfOver9", Some(1.0), Some(2.0)),
        ("Over9PlusTotal", Some(20.0), Some(8.0)),
        ("DoubleOver9", Some(10.0), Some(8.0)),
    ];
    for (m, bikes, helmets) in per_group {
        let got = ask(&e, &[m, "Total"], Some(ColumnRef::new("Product", "name"))).await;
        let cell = |g: &str| got.get(g).and_then(|row| row.get(*m).copied()).flatten();
        assert_eq!(cell("Bikes"), *bikes, "{m} for Bikes: {got:?}");
        assert_eq!(cell("Helmets"), *helmets, "{m} for Helmets: {got:?}");
    }
}

