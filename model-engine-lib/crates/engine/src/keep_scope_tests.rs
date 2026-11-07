//! Every measure sees its OWN filter context, and every KEEP reaches every
//! aggregate it wraps -- end to end through `Engine::query` on the LOCAL
//! (DataFusion) path (open-ledger round E, lane bie).
//!
//! - NEW-keep-in-if-condition: a KEEP inside a measure-level comparison (an
//!   `IF` condition, or a bare comparison measure) was silently dropped: the
//!   compound route resolved the whole comparison as ONE context and rendered
//!   it through the conditional renderer, whose comparison arm fell back to
//!   plain SQL -- `SUM("amount") > SUM("qty")`, no filter at all.
//! - NEW-shared-query-dimension-keep: a dimension KEEP was pushed into the
//!   dimension's FETCH (`compute_pushable_context_filters`) whenever no other
//!   measure filtered that table, so the shared SELECT's inner join to the
//!   pre-filtered dimension dropped the other measures' fact rows too (Total
//!   answered 10, not 18).
//! - NEW-preagg-conditions: the two-stage pre-aggregation (a GROUP BY through
//!   a many-to-many relationship) counted a KEEP's expression conditions
//!   (`IN {...}`, column-vs-column comparisons) as context but rendered only
//!   its simple filters, so the condition was dropped or empty.
//!
//! Fixture (the one `case_null_condition_tests` uses): `Sales(prod_id, day,
//! amount, qty, cat, cat2, nothing)` -> `Product(id, name, kind)` (many-to-one)
//! and -> `Periods(start_day, end_day, label)` (non-equi many-to-many). Rows
//! (prod_id, amount, qty, cat): `(1, 10, 1, Bikes)`, `(1, BLANK, 2, Bikes)`,
//! `(2, 8, 4, BLANK)`; product 1 is Bikes, product 2 Helmets. So the amounts
//! total 18 and the quantities 7; Bikes' amounts are 10 and its quantities 3.

#![cfg(test)]

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{Array, DictionaryArray, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Int32Type, Schema};
use arrow::record_batch::RecordBatch;

use crate::{
    expression_measure, parse_measure, Cardinality, Column, ColumnRef, DataModel, DataType, Engine,
    JoinCondition, JoinOperator, Measure, QueryRequest, Relationship, SourceBinding, StorageMode,
    Table,
};

/// (measure, formula, DAX answer over all three rows; `None` is BLANK).
const MEASURES: &[(&str, &str, Option<f64>)] = &[
    ("Total", "SUM(Sales[amount])", Some(18.0)),
    ("Qty", "SUM(Sales[qty])", Some(7.0)),
    // ---- NEW-keep-in-if-condition ----
    // No row is a Helmets row (the BLANK-`cat` row is not one): BLANK > 7 is
    // FALSE, so the IF is BLANK. With the KEEP dropped it read 18 > 7 -> 7.
    (
        "HelmetIf",
        "IF(SUM(Sales[amount], KEEP(Sales, Sales[cat] = \"Helmets\")) > SUM(Sales[qty]), \
         SUM(Sales[qty]), BLANK())",
        None,
    ),
    // The positive control: Bikes' 10 > 7, so the THEN branch, all quantities.
    (
        "BikeIf",
        "IF(SUM(Sales[amount], KEEP(Sales, Sales[cat] = \"Bikes\")) > SUM(Sales[qty]), \
         SUM(Sales[qty]), BLANK())",
        Some(7.0),
    ),
    // The KEEP is on the RIGHT operand only: 7 > 10 - 4 is TRUE. Had the
    // KEEP leaked onto the left operand (Bikes' quantities, 3), it is FALSE.
    (
        "KeepOnRight",
        "IF(SUM(Sales[qty]) > SUM(Sales[amount], KEEP(Sales, Sales[cat] = \"Bikes\")) - 4, 1, 2)",
        Some(1.0),
    ),
    // A comparison inside AND: the Helmets sum is BLANK, BLANK > 0 is FALSE.
    (
        "HelmetAnd",
        "IF(AND(SUM(Sales[amount], KEEP(Sales, Sales[cat] = \"Helmets\")) > 0, \
         SUM(Sales[qty]) > 0), 1, 2)",
        Some(2.0),
    ),
    // ---- NEW-shared-query-dimension-keep ----
    (
        "BikeSumByProduct",
        "SUM(Sales[amount], KEEP(Product, Product[name] = \"Bikes\"))",
        Some(10.0),
    ),
    // One measure, two sub-aggregates: only the first sees the KEEP. 10 + 7;
    // with the KEEP pushed into the Product fetch the quantities lost the
    // Helmets row (10 + 3).
    (
        "BikeSumPlusQty",
        "SUM(Sales[amount], KEEP(Product, Product[name] = \"Bikes\")) + SUM(Sales[qty])",
        Some(17.0),
    ),
    // Two measures that BOTH keep Bikes may still share a pushed fetch.
    (
        "BikeQtyByProduct",
        "SUM(Sales[qty], KEEP(Product, Product[name] = \"Bikes\"))",
        Some(3.0),
    ),
];

fn in_mem(t: Table) -> Table {
    t.with_storage_mode(StorageMode::InMemory)
}

fn model_with(measures: &[(&str, &str)], built: Vec<Measure>) -> DataModel {
    let mut builder = DataModel::builder()
        .add_table(in_mem(
            Table::new(
                "Sales",
                vec![
                    Column::new("prod_id", DataType::Int64),
                    Column::new("day", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                    Column::new("qty", DataType::Int64),
                    Column::new("cat", DataType::String),
                    Column::new("cat2", DataType::String),
                    Column::new("nothing", DataType::Float64),
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
                    Column::new("kind", DataType::String),
                ],
            )
            .unwrap(),
        ))
        .add_table(in_mem(
            Table::new(
                "Periods",
                vec![
                    Column::new("start_day", DataType::Int64),
                    Column::new("end_day", DataType::Int64),
                    Column::new("label", DataType::String),
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
        .add_relationship(Relationship::with_conditions(
            "Sales_Periods",
            "Sales",
            "Periods",
            vec![
                JoinCondition::new("day", "start_day", JoinOperator::GreaterThanOrEqual),
                JoinCondition::new("day", "end_day", JoinOperator::LessThanOrEqual),
            ],
            Cardinality::ManyToMany,
        ));
    for (name, formula) in measures {
        builder = builder.add_measure(expression_measure(
            *name,
            parse_measure(formula).unwrap_or_else(|e| panic!("{name}: {e}")),
        ));
    }
    for m in built {
        builder = builder.add_measure(m);
    }
    builder.build().unwrap()
}

fn store(engine: &mut Engine, table: &str, fields: Vec<Field>, columns: Vec<Arc<dyn Array>>) {
    engine
        .cache
        .store(
            table,
            RecordBatch::try_new(Arc::new(Schema::new(fields)), columns).unwrap(),
        )
        .unwrap();
}

fn engine_with(measures: &[(&str, &str)]) -> Engine {
    engine_for(model_with(measures, Vec::new()))
}

fn engine_for(model: DataModel) -> Engine {
    let mut engine = Engine::new(model);
    for t in ["Sales", "Product", "Periods"] {
        engine.bind_table(t, 0, SourceBinding::new("public", &t.to_lowercase()));
    }
    store(
        &mut engine,
        "Sales",
        vec![
            Field::new("prod_id", ArrowType::Int64, true),
            Field::new("day", ArrowType::Int64, true),
            Field::new("amount", ArrowType::Float64, true),
            Field::new("qty", ArrowType::Int64, true),
            Field::new("cat", ArrowType::Utf8, true),
            Field::new("cat2", ArrowType::Utf8, true),
            Field::new("nothing", ArrowType::Float64, true),
        ],
        vec![
            Arc::new(Int64Array::from(vec![1, 1, 2])),
            Arc::new(Int64Array::from(vec![1, 1, 1])),
            Arc::new(Float64Array::from(vec![Some(10.0), None, Some(8.0)])),
            Arc::new(Int64Array::from(vec![1, 2, 4])),
            Arc::new(StringArray::from(vec![Some("Bikes"), Some("Bikes"), None])),
            Arc::new(StringArray::from(vec!["Bikes", "Bikes", "Bikes"])),
            Arc::new(Float64Array::from(vec![None::<f64>, None, None])),
        ],
    );
    store(
        &mut engine,
        "Product",
        vec![
            Field::new("id", ArrowType::Int64, true),
            Field::new("name", ArrowType::Utf8, true),
            Field::new("kind", ArrowType::Utf8, true),
        ],
        vec![
            Arc::new(Int64Array::from(vec![1, 2])),
            Arc::new(StringArray::from(vec!["Bikes", "Helmets"])),
            Arc::new(StringArray::from(vec!["Cycle", "Cycle"])),
        ],
    );
    store(
        &mut engine,
        "Periods",
        vec![
            Field::new("start_day", ArrowType::Int64, true),
            Field::new("end_day", ArrowType::Int64, true),
            Field::new("label", ArrowType::Utf8, true),
        ],
        vec![
            Arc::new(Int64Array::from(vec![0])),
            Arc::new(Int64Array::from(vec![10])),
            Arc::new(StringArray::from(vec!["All"])),
        ],
    );
    engine
}

fn engine() -> Engine {
    let all: Vec<(&str, &str)> = MEASURES.iter().map(|(m, f, _)| (*m, *f)).collect();
    engine_with(&all)
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

fn assert_dax(got: &HashMap<String, Option<f64>>, names: &[&str], route: &str) {
    for name in names {
        assert_eq!(
            got.get(*name).copied().unwrap_or_else(|| panic!("{name} missing via {route}")),
            expected(name),
            "{name} via {route}"
        );
    }
}

#[tokio::test]
async fn a_keep_inside_a_comparison_filters_only_its_own_aggregate() {
    let e = engine();
    let names = ["HelmetIf", "BikeIf", "KeepOnRight", "HelmetAnd"];
    for m in names {
        let got = ask(&e, &[m], None).await;
        assert_dax(&got[""], &[m], &format!("an ungrouped query of {m} alone"));
        // Grouped: a BLANK measure shows no row (DAX), so a missing group
        // reads as BLANK.
        let got = ask(&e, &[m], Some(ColumnRef::new("Sales", "cat2"))).await;
        assert_eq!(
            got.get("Bikes").and_then(|row| row[m]),
            expected(m),
            "{m} grouped by Sales[cat2]: {got:?}"
        );
    }
    let mut shared = vec!["Total"];
    shared.extend(names);
    let got = ask(&e, &shared, None).await;
    assert_dax(&got[""], &shared, "one ungrouped query");
}

#[tokio::test]
async fn a_bare_comparison_measure_keeps_its_keep() {
    // A comparison measure (a model file can hold one; the formula grammar
    // has no top-level comparison) is a boolean: Bikes' 10 < all 18 is TRUE.
    // With the KEEP dropped it read 18 < 18, FALSE.
    let bikes = parse_measure("SUM(Sales[amount], KEEP(Sales, Sales[cat] = \"Bikes\"))").unwrap();
    let total = parse_measure("SUM(Sales[amount])").unwrap();
    let e = engine_for(model_with(
        &[],
        vec![expression_measure(
            "BikesBelowTotal",
            crate::expression::compare(bikes, crate::ComparisonOp::LessThan, total),
        )],
    ));
    let got = ask(&e, &["BikesBelowTotal"], None).await;
    assert_eq!(got[""]["BikesBelowTotal"], Some(1.0), "{got:?}");
}

#[tokio::test]
async fn a_dimension_keep_never_filters_another_measures_rows() {
    let e = engine();
    // Each alone, then every combination the shared SELECT serves: the
    // ungrouped query, grouped by a fact column, and grouped by the very
    // dimension the KEEP filters (never pushed: it is on the axis).
    let alone = ["BikeSumByProduct", "BikeSumPlusQty", "BikeQtyByProduct"];
    for m in alone {
        let got = ask(&e, &[m], None).await;
        assert_dax(&got[""], &[m], &format!("an ungrouped query of {m} alone"));
    }
    let shared = ["Total", "Qty", "BikeSumByProduct", "BikeSumPlusQty", "BikeQtyByProduct"];
    let got = ask(&e, &shared, None).await;
    assert_dax(&got[""], &shared, "one ungrouped query");
    let got = ask(&e, &shared, Some(ColumnRef::new("Sales", "cat2"))).await;
    assert_dax(&got["Bikes"], &shared, "a query grouped by Sales[cat2]");
    // Two measures that keep the SAME Bikes filter beside the total.
    let got = ask(&e, &["BikeSumByProduct", "BikeQtyByProduct", "Total"], None).await;
    assert_dax(
        &got[""],
        &["BikeSumByProduct", "BikeQtyByProduct", "Total"],
        "two Bikes KEEPs beside the total",
    );
    // Grouped by the product: Bikes 10 / 3 / 1+2, Helmets BLANK / BLANK / 4.
    let got = ask(&e, &["Total", "Qty", "BikeSumByProduct"], Some(ColumnRef::new("Product", "name")))
        .await;
    assert_eq!(got["Bikes"]["Total"], Some(10.0), "{got:?}");
    assert_eq!(got["Bikes"]["BikeSumByProduct"], Some(10.0), "{got:?}");
    assert_eq!(got["Helmets"]["Qty"], Some(4.0), "{got:?}");
    assert_eq!(got["Helmets"]["BikeSumByProduct"], None, "{got:?}");
}

#[tokio::test]
async fn the_two_stage_pre_aggregation_applies_a_keeps_expression_conditions() {
    // Grouped through the many-to-many Periods relationship (one period
    // `All` holds every row): the two-stage pre-aggregation.
    let e = engine_with(&[
        ("Total", "SUM(Sales[amount])"),
        // An IN-list is an expression condition, not a simple filter.
        (
            "BikesIn",
            "SUM(Sales[amount], KEEP(Sales, Sales[cat] IN {\"Bikes\"}))",
        ),
        // A simple filter AND a column-vs-column condition: no Bikes row
        // has more quantity than amount (1 > 10 is FALSE, 2 > BLANK is not
        // TRUE), so BLANK. With the condition dropped: 10.
        (
            "BikesQtyOver",
            "SUM(Sales[amount], KEEP(Sales, Sales[cat] = \"Bikes\", Sales[qty] > Sales[amount]))",
        ),
        ("BikeRowsIn", "COUNTROWS(Sales, KEEP(Sales, Sales[cat] IN {\"Bikes\"}))"),
        // A KEEP on a dimension: Stage 1 must join it.
        (
            "BikeSumByProduct",
            "SUM(Sales[amount], KEEP(Product, Product[name] = \"Bikes\"))",
        ),
    ]);
    let group = Some(ColumnRef::new("Periods", "label"));
    let names = ["Total", "BikesIn", "BikesQtyOver", "BikeRowsIn", "BikeSumByProduct"];
    let got = ask(&e, &names, group.clone()).await;
    let all = &got["All"];
    assert_eq!(all["Total"], Some(18.0), "{got:?}");
    assert_eq!(all["BikesIn"], Some(10.0), "{got:?}");
    assert_eq!(all["BikesQtyOver"], None, "{got:?}");
    assert_eq!(all["BikeRowsIn"], Some(2.0), "{got:?}");
    assert_eq!(all["BikeSumByProduct"], Some(10.0), "{got:?}");
    // Each alone takes the same route. A measure that is BLANK in the group
    // ALONE is no row there (SUMMARIZECOLUMNS drops a row whose every measure
    // is BLANK, as the main route's HAVING does); this pinned an all-BLANK
    // "All" row for BikesQtyOver until wave 3 (lane engfix).
    for m in names {
        let got = ask(&e, &[m], group.clone()).await;
        match all[m] {
            None => assert!(!got.contains_key("All"), "{m} alone: {got:?}"),
            Some(_) => assert_eq!(got["All"][m], all[m], "{m} alone"),
        }
    }
}

#[tokio::test]
async fn a_fact_row_with_no_dimension_row_still_counts_for_the_other_measures() {
    // A fourth sale (amount 5, qty 1) of product 9, which the Product table
    // does not hold. DAX: it belongs to no product, so no Bikes KEEP keeps
    // it, but every unfiltered measure counts it. The shared SELECT
    // INNER-joined `product` for the KEEP and dropped it from the total.
    let mut e = engine();
    store(
        &mut e,
        "Sales",
        vec![
            Field::new("prod_id", ArrowType::Int64, true),
            Field::new("day", ArrowType::Int64, true),
            Field::new("amount", ArrowType::Float64, true),
            Field::new("qty", ArrowType::Int64, true),
            Field::new("cat", ArrowType::Utf8, true),
            Field::new("cat2", ArrowType::Utf8, true),
            Field::new("nothing", ArrowType::Float64, true),
        ],
        vec![
            Arc::new(Int64Array::from(vec![1, 1, 2, 9])),
            Arc::new(Int64Array::from(vec![1, 1, 1, 1])),
            Arc::new(Float64Array::from(vec![Some(10.0), None, Some(8.0), Some(5.0)])),
            Arc::new(Int64Array::from(vec![1, 2, 4, 1])),
            Arc::new(StringArray::from(vec![Some("Bikes"), Some("Bikes"), None, Some("Bikes")])),
            Arc::new(StringArray::from(vec!["Bikes", "Bikes", "Bikes", "Bikes"])),
            Arc::new(Float64Array::from(vec![None::<f64>, None, None, None])),
        ],
    );
    let names = ["Total", "Qty", "BikeSumByProduct", "BikeSumPlusQty"];
    for group in [None, Some(ColumnRef::new("Sales", "cat2"))] {
        let got = ask(&e, &names, group.clone()).await;
        let row = &got[if group.is_some() { "Bikes" } else { "" }];
        assert_eq!(row["Total"], Some(23.0), "{group:?}: {got:?}");
        assert_eq!(row["Qty"], Some(8.0), "{group:?}: {got:?}");
        assert_eq!(row["BikeSumByProduct"], Some(10.0), "{group:?}: {got:?}");
        assert_eq!(row["BikeSumPlusQty"], Some(18.0), "{group:?}: {got:?}");
    }
}
