//! DAX BLANK semantics end to end on the LOCAL (in-memory) path: the
//! counting aggregates over no rows, BLANK arithmetic, and the `/` operator's
//! IEEE division by zero (`engine_core::compute::dax_semantics` holds the
//! table and its Microsoft citations).
//!
//! Each answer is asked through the routes a measure can take: an ungrouped
//! query, a grouped query, a RESET total hoisted into a CROSS JOIN, and the
//! multi-fact-table star queries.
//!
//! Fixture: `Sales(prod_id, amount, qty)` -> `Product(id, name)`.
//! `data_engine`: Bikes (1) has amounts 100 and 30 (qty 2 + 1); Helmets (2)
//! has two rows whose `amount` is BLANK (qty 1 + 3). `empty_engine`: the same
//! model with an EMPTY `Sales` table. A second fact table `Returns(prod_id,
//! units)` is empty in both, so a query mixing a Sales and a Returns measure
//! runs as two star queries joined together.

#![cfg(test)]

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{Array, DictionaryArray, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Int32Type, Schema};
use arrow::record_batch::RecordBatch;

use crate::{
    expression_measure, parse_measure, Column, ColumnRef, DataModel, DataType, Engine,
    QueryRequest, Relationship, SourceBinding, StorageMode, Table,
};

/// Every measure the tests ask for, by name.
const MEASURES: &[(&str, &str)] = &[
    // The counting aggregates.
    ("Rows", "COUNTROWS(Sales)"),
    ("Amounts", "COUNT(Sales[amount])"),
    ("Products", "DISTINCTCOUNT(Sales[prod_id])"),
    ("RowsTotal", "COUNTROWS(Sales, RESET())"),
    // BLANK in + and - reads as 0, unless every term is BLANK.
    ("SumPlusOne", "SUM(Sales[amount]) + 1"),
    ("SumMinusOne", "SUM(Sales[amount]) - 1"),
    ("OneMinusSum", "1 - SUM(Sales[amount])"),
    ("SumPlusSum", "SUM(Sales[amount]) + SUM(Sales[amount])"),
    ("RowsPlusOne", "COUNTROWS(Sales) + 1"),
    ("RowsTotalPlusOne", "COUNTROWS(Sales, RESET()) + 1"),
    (
        "SumPlusTotal",
        "SUM(Sales[amount]) + SUM(Sales[amount], RESET())",
    ),
    ("NegSum", "-SUM(Sales[amount])"),
    // BLANK in * and as a / numerator propagates.
    ("SumTimesTwo", "SUM(Sales[amount]) * 2"),
    ("SumOverTwo", "SUM(Sales[amount]) / 2"),
    // A BLANK denominator reads as 0; x / 0 is IEEE, never an error.
    ("TwoOverSum", "2 / SUM(Sales[amount])"),
    ("ZeroOverSum", "0 / SUM(Sales[amount])"),
    ("QtyOverZero", "SUM(Sales[qty]) / 0"),
    ("NegQtyOverZero", "(0 - SUM(Sales[qty])) / 0"),
    ("ZeroOverZero", "(SUM(Sales[qty]) - SUM(Sales[qty])) / 0"),
    ("RowShare", "COUNTROWS(Sales) / COUNTROWS(Sales)"),
    (
        "RowShareOfTotal",
        "COUNTROWS(Sales) / COUNTROWS(Sales, RESET())",
    ),
    // `/` answers a REAL: 2 / 3 is 0.667, not SQL's integer 0.
    ("RowsOverThree", "COUNTROWS(Sales) / 3"),
    // DIVIDE: a BLANK denominator answers the alternate.
    ("DivideBlankAlt", "DIVIDE(1, SUM(Sales[amount]), 0)"),
    // Row level (DAX's SUMX(Sales, Sales[amount] + 1)): BLANK + 1 is 1.
    ("RowLevelPlusOne", "SUM(Sales[amount] + 1)"),
    // DAX compares a BLANK as 0 against a number: COUNTROWS(empty) = 0 is TRUE.
    ("EmptyFlag", "IF(COUNTROWS(Sales) = 0, 1, 2)"),
    ("FewRows", "IF(COUNTROWS(Sales) < 1, 1, 2)"),
    ("SwitchRows", "SWITCH(COUNTROWS(Sales), 0, 10, 20)"),
    ("RowsBlank", "IF(ISBLANK(COUNTROWS(Sales)), 1, 2)"),
    // DISTINCTCOUNT counts BLANK as a value; DISTINCTCOUNTNOBLANK does not.
    ("AmountValues", "DISTINCTCOUNT(Sales[amount])"),
    ("AmountValuesNoBlank", "DISTINCTCOUNTNOBLANK(Sales[amount])"),
    // DIVIDE: a BLANK numerator is BLANK even over a zero denominator with an
    // alternate -- on the SQL path and in the constant folder (a GVAR over an
    // earlier GVAR that is BLANK: Helmets' amounts are all BLANK).
    ("DivideBlankZeroAlt", "DIVIDE(SUM(Sales[amount]), 0, 7)"),
    (
        "FoldDivideBlankZeroAlt",
        "GVAR h = MAX(Sales[amount], KEEP(Product, Product[id] = 2)) GVAR d = DIVIDE(h, 0, 7) \
         RETURN IF(ISBLANK(d), COUNTROWS(Sales), SUM(Sales[qty]))",
    ),
    // Row level (DAX's SUMX(Sales, IF(Sales[amount] < 50, 1, 0))): a BLANK
    // amount compares as 0.
    ("SmallAmounts", "SUM(IF(Sales[amount] < 50, 1, 0))"),
    ("ZeroAmounts", "SUM(IF(Sales[amount] = 0, 1, 0))"),
    ("PositiveAmounts", "SUM(IF(Sales[amount] > 0, 1, 0))"),
    // A filtered count (KEEP) on the local path.
    (
        "BikeRows",
        "COUNTROWS(Sales, KEEP(Product, Product[name] = \"Bikes\"))",
    ),
    // A second, always-empty fact table.
    ("ReturnUnits", "SUM(Returns[units])"),
    ("ReturnRows", "COUNTROWS(Returns)"),
];

fn model() -> DataModel {
    let mut builder = DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("prod_id", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                    Column::new("qty", DataType::Int64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_table(
            Table::new(
                "Returns",
                vec![
                    Column::new("prod_id", DataType::Int64),
                    Column::new("units", DataType::Int64),
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
        .add_relationship(Relationship::many_to_one(
            "Returns_Product",
            "Returns",
            "prod_id",
            "Product",
            "id",
        ));
    for (name, formula) in MEASURES {
        builder = builder.add_measure(expression_measure(
            *name,
            parse_measure(formula).unwrap_or_else(|e| panic!("{name}: {e}")),
        ));
    }
    builder.build().unwrap()
}

fn engine_with(sales: (Vec<i64>, Vec<Option<f64>>, Vec<i64>)) -> Engine {
    let mut engine = Engine::new(model());
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    engine.bind_table("Returns", 0, SourceBinding::new("public", "returns"));
    engine.bind_table("Product", 0, SourceBinding::new("public", "product"));
    let (prod, amount, qty) = sales;
    engine
        .cache
        .store(
            "Sales",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("prod_id", ArrowType::Int64, true),
                    Field::new("amount", ArrowType::Float64, true),
                    Field::new("qty", ArrowType::Int64, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(prod)),
                    Arc::new(Float64Array::from(amount)),
                    Arc::new(Int64Array::from(qty)),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    engine
        .cache
        .store(
            "Returns",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("prod_id", ArrowType::Int64, true),
                    Field::new("units", ArrowType::Int64, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(Vec::<i64>::new())),
                    Arc::new(Int64Array::from(Vec::<i64>::new())),
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

fn empty_engine() -> Engine {
    engine_with((vec![], vec![], vec![]))
}

fn data_engine() -> Engine {
    engine_with((
        vec![1, 1, 2, 2],
        vec![Some(100.0), Some(30.0), None, None],
        vec![2, 1, 1, 3],
    ))
}

/// A measure cell: `None` is BLANK; numbers compare by value (`NaN` == `NaN`).
#[derive(Debug, Clone, Copy)]
struct Cell(Option<f64>);

impl PartialEq for Cell {
    fn eq(&self, other: &Self) -> bool {
        match (self.0, other.0) {
            (None, None) => true,
            (Some(a), Some(b)) if a.is_nan() && b.is_nan() => true,
            (Some(a), Some(b)) => a == b || (a - b).abs() < 1e-9,
            _ => false,
        }
    }
}

const BLANK: Cell = Cell(None);
fn n(v: f64) -> Cell {
    Cell(Some(v))
}

fn cell(column: &dyn Array, row: usize) -> Cell {
    if column.is_null(row) {
        return BLANK;
    }
    let as_f64 =
        arrow::compute::cast(&column.slice(row, 1), &ArrowType::Float64).unwrap_or_else(|e| {
            panic!(
                "measure column {:?} is not numeric: {e}",
                column.data_type()
            )
        });
    let a = as_f64.as_any().downcast_ref::<Float64Array>().unwrap();
    Cell(Some(a.value(0)))
}

/// One ungrouped measure's answer.
async fn scalar(engine: &Engine, measure: &str) -> Result<Cell, String> {
    let batches = engine
        .query(QueryRequest {
            measures: vec![measure.into()],
            ..Default::default()
        })
        .await
        .map_err(|e| e.to_string())?;
    let rows: usize = batches.iter().map(|b| b.num_rows()).sum();
    assert_eq!(rows, 1, "{measure}: an ungrouped query answers one row");
    let b = batches.iter().find(|b| b.num_rows() == 1).unwrap();
    Ok(cell(
        b.column(b.schema().index_of(measure).unwrap()).as_ref(),
        0,
    ))
}

/// One measure grouped by `Product[name]`: name -> answer.
async fn grouped(
    engine: &Engine,
    measures: &[&str],
    measure: &str,
) -> Result<HashMap<String, Cell>, String> {
    let batches = engine
        .query(QueryRequest {
            measures: measures.iter().map(|m| m.to_string()).collect(),
            group_by: vec![ColumnRef::new("Product", "name")],
            ..Default::default()
        })
        .await
        .map_err(|e| e.to_string())?;
    let mut out = HashMap::new();
    for b in &batches {
        let g = b.column(b.schema().index_of("name").unwrap());
        let m = b.column(b.schema().index_of(measure).unwrap());
        for row in 0..b.num_rows() {
            if g.is_null(row) {
                continue;
            }
            let key = if let Some(a) = g.as_any().downcast_ref::<StringArray>() {
                a.value(row).to_string()
            } else if let Some(a) = g.as_any().downcast_ref::<DictionaryArray<Int32Type>>() {
                let values = a.values().as_any().downcast_ref::<StringArray>().unwrap();
                values.value(a.key(row).unwrap()).to_string()
            } else {
                panic!("unexpected group array type: {:?}", g.data_type());
            };
            out.insert(key, cell(m.as_ref(), row));
        }
    }
    Ok(out)
}

#[tokio::test]
async fn the_counting_aggregates_answer_blank_over_an_empty_table() {
    // COUNTROWS: "When the table argument contains no rows, the function
    // returns BLANK"; COUNT / DISTINCTCOUNT: "When the function finds no rows
    // to count, it returns a blank" (Microsoft DAX reference). The engine
    // answered 0.
    let e = empty_engine();
    for m in ["Rows", "Amounts", "Products", "RowsTotal"] {
        assert_eq!(scalar(&e, m).await, Ok(BLANK), "{m} over an empty Sales");
    }
    // A bare RESET total and the compound hoisted total agree.
    assert_eq!(scalar(&e, "RowShareOfTotal").await, Ok(BLANK));
}

#[tokio::test]
async fn a_blank_count_still_compares_as_zero() {
    // "BLANK or a blank value is converted to 0, "", or False, depending on
    // the data type of the other compared value" (Microsoft): a count that is
    // BLANK over an empty table keeps `IF(COUNTROWS(t) = 0, ...)` answering
    // as it did when the count was 0, and ISBLANK now sees it.
    let e = empty_engine();
    assert_eq!(
        scalar(&e, "EmptyFlag").await,
        Ok(n(1.0)),
        "COUNTROWS(empty) = 0"
    );
    assert_eq!(
        scalar(&e, "FewRows").await,
        Ok(n(1.0)),
        "COUNTROWS(empty) < 1"
    );
    assert_eq!(
        scalar(&e, "SwitchRows").await,
        Ok(n(10.0)),
        "SWITCH(COUNTROWS(empty), 0, ...)"
    );
    assert_eq!(
        scalar(&e, "RowsBlank").await,
        Ok(n(1.0)),
        "ISBLANK(COUNTROWS(empty))"
    );
    let d = data_engine();
    assert_eq!(scalar(&d, "EmptyFlag").await, Ok(n(2.0)));
    assert_eq!(scalar(&d, "SwitchRows").await, Ok(n(20.0)));
}

#[tokio::test]
async fn a_count_of_only_blank_values_is_blank_per_group() {
    // Helmets has rows, but no amount to count: COUNT is BLANK, not 0.
    let e = data_engine();
    let got = grouped(&e, &["Amounts", "Rows"], "Amounts").await.unwrap();
    assert_eq!(got["Bikes"], n(2.0));
    assert_eq!(
        got["Helmets"], BLANK,
        "COUNT over only-BLANK values is BLANK"
    );
}

#[tokio::test]
async fn blank_reads_as_zero_in_addition_and_subtraction() {
    // Microsoft: BLANK + 5 = 5, BLANK + BLANK = BLANK; Definitive Guide to
    // DAX: BLANK - 10 = -10. The engine answered NULL for every one.
    let e = empty_engine();
    assert_eq!(scalar(&e, "SumPlusOne").await, Ok(n(1.0)));
    assert_eq!(scalar(&e, "SumMinusOne").await, Ok(n(-1.0)));
    assert_eq!(scalar(&e, "OneMinusSum").await, Ok(n(1.0)));
    assert_eq!(scalar(&e, "SumPlusSum").await, Ok(BLANK), "BLANK + BLANK");
    assert_eq!(scalar(&e, "RowsPlusOne").await, Ok(n(1.0)));
    // The RESET total hoisted into the CROSS JOIN reads BLANK, plus 1 is 1.
    assert_eq!(scalar(&e, "RowsTotalPlusOne").await, Ok(n(1.0)));
    // Unary minus keeps BLANK.
    assert_eq!(scalar(&e, "NegSum").await, Ok(BLANK), "-BLANK is BLANK");
}

#[tokio::test]
async fn blank_propagates_through_multiplication_and_a_blank_numerator() {
    // Microsoft: BLANK * 5 = BLANK; Definitive Guide: BLANK / 3 = BLANK.
    let e = empty_engine();
    assert_eq!(scalar(&e, "SumTimesTwo").await, Ok(BLANK));
    assert_eq!(scalar(&e, "SumOverTwo").await, Ok(BLANK));
}

#[tokio::test]
async fn division_by_zero_or_blank_is_ieee_never_an_error() {
    // Microsoft: 5 / BLANK = Infinity, 0 / BLANK = NaN, BLANK / BLANK = BLANK;
    // Definitive Guide Table 2-3: 10 / 0 = Infinity, 0 / 0 = NaN. The engine
    // failed the whole query ("Arrow error: Divide by zero error").
    let e = empty_engine();
    assert_eq!(scalar(&e, "TwoOverSum").await, Ok(n(f64::INFINITY)));
    assert_eq!(scalar(&e, "ZeroOverSum").await, Ok(n(f64::NAN)));
    assert_eq!(
        scalar(&e, "RowShare").await,
        Ok(BLANK),
        "COUNTROWS / COUNTROWS over an empty table is BLANK / BLANK"
    );
    let d = data_engine();
    assert_eq!(scalar(&d, "QtyOverZero").await, Ok(n(f64::INFINITY)));
    assert_eq!(scalar(&d, "NegQtyOverZero").await, Ok(n(f64::NEG_INFINITY)));
    assert_eq!(scalar(&d, "ZeroOverZero").await, Ok(n(f64::NAN)));
    // DIVIDE with a BLANK denominator answers its alternate.
    assert_eq!(scalar(&e, "DivideBlankAlt").await, Ok(n(0.0)));
}

#[tokio::test]
async fn division_answers_a_real_never_an_integer_quotient() {
    // DAX's division table: INTEGER / INTEGER is REAL. The engine rendered
    // integer division, so COUNTROWS(Sales) / 3 over 4 rows answered 1.
    let d = data_engine();
    assert_eq!(scalar(&d, "RowsOverThree").await, Ok(n(4.0 / 3.0)));
    let got = grouped(&d, &["RowsOverThree"], "RowsOverThree")
        .await
        .unwrap();
    assert_eq!(got["Bikes"], n(2.0 / 3.0));
}

#[tokio::test]
async fn grouped_rows_follow_the_same_table() {
    let d = data_engine();
    let measures = [
        "SumPlusOne",
        "SumTimesTwo",
        "NegSum",
        "QtyOverZero",
        "ZeroOverZero",
        "RowLevelPlusOne",
    ];
    let get = |m: &'static str| {
        let d = &d;
        async move { grouped(d, &measures, m).await.unwrap() }
    };
    let plus_one = get("SumPlusOne").await;
    assert_eq!(plus_one["Bikes"], n(131.0));
    assert_eq!(plus_one["Helmets"], n(1.0), "BLANK + 1 on a grouped row");
    assert_eq!(get("SumTimesTwo").await["Helmets"], BLANK);
    assert_eq!(get("NegSum").await["Helmets"], BLANK);
    assert_eq!(get("NegSum").await["Bikes"], n(-130.0));
    assert_eq!(get("QtyOverZero").await["Helmets"], n(f64::INFINITY));
    assert_eq!(get("ZeroOverZero").await["Bikes"], n(f64::NAN));
    // Row level: each Helmets row is BLANK + 1 = 1, so the sum is 2.
    let row_level = get("RowLevelPlusOne").await;
    assert_eq!(row_level["Helmets"], n(2.0));
    assert_eq!(row_level["Bikes"], n(132.0));
}

#[tokio::test]
async fn a_hoisted_reset_total_reads_blank_as_zero_per_group() {
    // SUM(amount) + SUM(amount, RESET()): Helmets' own SUM is BLANK, the
    // RESET total (hoisted into the CROSS JOIN) is 130, so the row is 130.
    let d = data_engine();
    let got = grouped(&d, &["SumPlusTotal"], "SumPlusTotal")
        .await
        .unwrap();
    assert_eq!(got["Bikes"], n(260.0));
    assert_eq!(got["Helmets"], n(130.0));
}

#[tokio::test]
async fn the_multi_fact_star_queries_follow_the_same_table() {
    // A Sales measure and a Returns measure in one query run as two star
    // queries joined together; the empty Returns side answers BLANK counts.
    let e = empty_engine();
    let batches = e
        .query(QueryRequest {
            measures: vec![
                "SumPlusOne".into(),
                "ReturnRows".into(),
                "ReturnUnits".into(),
            ],
            ..Default::default()
        })
        .await
        .unwrap();
    let b = batches.iter().find(|b| b.num_rows() == 1).expect("one row");
    let col = |m: &str| cell(b.column(b.schema().index_of(m).unwrap()).as_ref(), 0);
    assert_eq!(
        col("ReturnRows"),
        BLANK,
        "COUNTROWS of an empty second fact table"
    );
    assert_eq!(col("ReturnUnits"), BLANK);
    assert_eq!(col("SumPlusOne"), n(1.0));
}

#[tokio::test]
async fn distinctcount_counts_blank_as_one_value() {
    // "The DISTINCTCOUNT function counts the BLANK value. To skip the BLANK
    // value, use the DISTINCTCOUNTNOBLANK function." (Microsoft). [LIVE] Excel
    // 16's data model (the Power BI DAX engine): DISTINCTCOUNT over 10, 0,
    // BLANK, 7 is 4, over one BLANK row 1, over no rows BLANK. The engine
    // rendered SQL's COUNT(DISTINCT), which skips NULL.
    let d = data_engine();
    // Amounts 100, 30, BLANK, BLANK: three distinct values, one of them BLANK.
    assert_eq!(scalar(&d, "AmountValues").await, Ok(n(3.0)));
    assert_eq!(scalar(&d, "AmountValuesNoBlank").await, Ok(n(2.0)));
    let measures = ["AmountValues", "AmountValuesNoBlank"];
    let values = grouped(&d, &measures, "AmountValues").await.unwrap();
    assert_eq!(values["Bikes"], n(2.0));
    assert_eq!(
        values["Helmets"],
        n(1.0),
        "Helmets' amounts are all BLANK: one distinct value"
    );
    let no_blank = grouped(&d, &measures, "AmountValuesNoBlank").await.unwrap();
    assert_eq!(no_blank["Bikes"], n(2.0));
    assert_eq!(no_blank["Helmets"], BLANK, "nothing to count is BLANK");
    let e = empty_engine();
    for m in measures {
        assert_eq!(scalar(&e, m).await, Ok(BLANK), "{m} over an empty Sales");
    }
}

#[tokio::test]
async fn divide_of_a_blank_numerator_is_blank_even_with_an_alternate() {
    // [LIVE] Excel 16's data model: DIVIDE(BLANK(), 0, 7) and DIVIDE(BLANK(),
    // BLANK(), 7) are BLANK; DIVIDE(0, 0, 7) and DIVIDE(0, BLANK(), 7) are 7.
    // The SQL path answered the alternate (7) while the constant folder
    // answered BLANK.
    let e = empty_engine();
    assert_eq!(scalar(&e, "DivideBlankZeroAlt").await, Ok(BLANK));
    let d = data_engine();
    let got = grouped(&d, &["DivideBlankZeroAlt"], "DivideBlankZeroAlt")
        .await
        .unwrap();
    assert_eq!(got["Bikes"], n(7.0), "130 / 0 with an alternate is 7");
    assert_eq!(got["Helmets"], BLANK, "BLANK / 0 is BLANK, alternate or not");
    // The folder: `d` folds to BLANK, so the RETURN answers COUNTROWS (4)
    // rather than SUM(qty) (7).
    assert_eq!(scalar(&d, "FoldDivideBlankZeroAlt").await, Ok(n(4.0)));
}

#[tokio::test]
async fn a_filtered_count_counts_the_kept_rows_locally() {
    // The local half of NEW-countrows-keep-pushdown: COUNTROWS(t, KEEP(...))
    // counts the rows the KEEP keeps (BLANK where it keeps none).
    let d = data_engine();
    assert_eq!(scalar(&d, "BikeRows").await, Ok(n(2.0)));
    let got = grouped(&d, &["BikeRows", "Rows"], "BikeRows").await.unwrap();
    assert_eq!(got["Bikes"], n(2.0));
    assert_eq!(got.get("Helmets").copied().unwrap_or(BLANK), BLANK);
}

#[tokio::test]
async fn a_row_level_comparison_reads_a_blank_as_zero() {
    // NEW-dax-row-comparison. "BLANK or a blank value is converted to 0, "",
    // or False, depending on the data type of the other compared value"
    // (Microsoft). [LIVE] Excel 16's data model over amounts 10, 0, BLANK, 7:
    // FILTER(T, T[amount] < 5) keeps 2 rows (0 and BLANK), = 0 keeps 2, > 0
    // keeps 2 (10 and 7). SQL's NULL < 50 is NULL, so the engine dropped the
    // BLANK rows. Amounts here: 100, 30, BLANK, BLANK.
    let d = data_engine();
    assert_eq!(scalar(&d, "SmallAmounts").await, Ok(n(3.0)), "30 and two BLANKs");
    assert_eq!(scalar(&d, "ZeroAmounts").await, Ok(n(2.0)), "BLANK = 0");
    assert_eq!(scalar(&d, "PositiveAmounts").await, Ok(n(2.0)), "BLANK > 0 is FALSE");
    let got = grouped(&d, &["SmallAmounts"], "SmallAmounts").await.unwrap();
    assert_eq!(got["Helmets"], n(2.0));
    assert_eq!(got["Bikes"], n(1.0));
}
