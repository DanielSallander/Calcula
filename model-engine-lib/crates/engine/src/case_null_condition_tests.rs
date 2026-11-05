//! A `CASE` whose condition is NULL takes its ELSE -- end to end on the LOCAL
//! (DataFusion) path, through every route a conditional aggregate or an `IF`
//! takes there (NEW-datafusion-case-null, open-ledger round D).
//!
//! DataFusion 44 answers `CASE WHEN c THEN col END` with `col` when `c` is
//! NULL (`case_column_or_null`: `nullif(col, not(c))`), so every conditional
//! aggregate also aggregated the rows whose KEEP condition is NULL: a BLANK
//! attribute, or a fact row whose dimension row is missing. In DAX a BLANK
//! never satisfies a filter on a value, and SQL's own `CASE` agrees; the
//! renderer now spells the condition `COALESCE(c, FALSE)`
//! (`engine_core::compute::sql_util::null_is_false_condition`).
//!
//! Fixture: `Sales(prod_id, day, amount, qty, cat, cat2, nothing)` ->
//! `Product(id, name)` (many-to-one) and -> `Periods(start_day, end_day,
//! label)` (non-equi many-to-many, which routes a GROUP BY through two-stage
//! pre-aggregation). Rows (prod_id, amount, qty, cat):
//! `(1, 10, 1, Bikes)`, `(1, BLANK, 2, Bikes)`, `(2, 8, 4, BLANK)` -- the
//! third row's `cat` is BLANK. `cat2`
//! is `Bikes` and `nothing` BLANK on every row; `day` is 1 on every row,
//! inside the one period `All`.

#![cfg(test)]

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{Array, DictionaryArray, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Int32Type, Schema};
use arrow::record_batch::RecordBatch;

use crate::{
    expression as expr, expression_measure, parse_measure, AggregateOp, Cardinality, Column,
    ColumnRef, ComparisonOp, ContextColumn, DataModel, DataType, Engine, Expression, JoinCondition,
    JoinOperator, Measure, QueryRequest, Relationship, SourceBinding, StorageMode, Table,
};

/// (measure, formula, DAX answer over all three rows; `None` is BLANK).
const MEASURES: &[(&str, &str, Option<f64>)] = &[
    ("Total", "SUM(Sales[amount])", Some(18.0)),
    // KEEP on a fact column: the BLANK-`cat` row is not a Bikes row.
    (
        "BikeAmounts",
        "COUNT(Sales[amount], KEEP(Sales, Sales[cat] = \"Bikes\"))",
        Some(1.0),
    ),
    (
        "BikeSum",
        "SUM(Sales[amount], KEEP(Sales, Sales[cat] = \"Bikes\"))",
        Some(10.0),
    ),
    (
        "BikeMin",
        "MIN(Sales[amount], KEEP(Sales, Sales[cat] = \"Bikes\"))",
        Some(10.0),
    ),
    // DISTINCTCOUNT counts BLANK as a value: Bikes' amounts are 10 and BLANK.
    (
        "BikeValues",
        "DISTINCTCOUNT(Sales[amount], KEEP(Sales, Sales[cat] = \"Bikes\"))",
        Some(2.0),
    ),
    // KEEP on a dimension (the third row is a Helmets row).
    (
        "BikeSumByProduct",
        "SUM(Sales[amount], KEEP(Product, Product[name] = \"Bikes\"))",
        Some(10.0),
    ),
    // `THEN 1` never took DataFusion's fast path: the control.
    (
        "BikeRows",
        "COUNTROWS(Sales, KEEP(Sales, Sales[cat] = \"Bikes\"))",
        Some(2.0),
    ),
    // Row-level IF (DAX's SUMX(Sales, IF(...))): BLANK = "Bikes" is FALSE.
    (
        "RowIf",
        "SUM(IF(Sales[cat] = Sales[cat2], Sales[amount], BLANK()))",
        Some(10.0),
    ),
    // No row is a Helmets row.
    (
        "HelmetSum",
        "SUM(Sales[amount], KEEP(Sales, Sales[cat] = \"Helmets\"))",
        None,
    ),
    // Measure-level IF: a BLANK (the sum of a column with no value) compared
    // with a number is not greater.
    (
        "MeasureIf",
        "IF(SUM(Sales[nothing]) > SUM(Sales[qty]), SUM(Sales[qty]), BLANK())",
        None,
    ),
    // An IF whose condition is a PARTITIONED clear (a BLANK used as a
    // condition is FALSE): grouped by Product[kind] and Product[name], the
    // two-level percent-of-parent query (`hoist_measure_sql`).
    (
        "ParentIf",
        "IF(SUM(Sales[nothing], CLEAREXCEPT(Product, kind)), SUM(Sales[qty]), BLANK())",
        None,
    ),
    // The same IF beside a RESET total: the hoisted compound route
    // (`resolve_compound_sql`).
    (
        "MeasureIfTotal",
        "IF(SUM(Sales[nothing]) > SUM(Sales[qty], RESET()), SUM(Sales[qty]), BLANK())",
        None,
    ),
];

fn in_mem(t: Table) -> Table {
    t.with_storage_mode(StorageMode::InMemory)
}

fn model() -> DataModel {
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
    for (name, formula, _) in MEASURES {
        builder = builder.add_measure(expression_measure(
            *name,
            parse_measure(formula).unwrap_or_else(|e| panic!("{name}: {e}")),
        ));
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

fn engine() -> Engine {
    let mut engine = Engine::new(model());
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

fn assert_dax(got: &HashMap<String, Option<f64>>, route: &str) {
    for (name, _, expected) in MEASURES {
        if let Some(v) = got.get(*name) {
            assert_eq!(v, expected, "{name} via {route}");
        }
    }
}

#[tokio::test]
async fn a_null_keep_condition_keeps_no_row_on_every_local_route() {
    let e = engine();
    let all: Vec<&str> = MEASURES.iter().map(|(m, _, _)| *m).collect();
    // Each measure alone (the simple-aggregate and the compound routes)...
    for m in &all {
        let got = ask(&e, &[m], None).await;
        assert_dax(&got[""], &format!("an ungrouped query of {m} alone"));
    }
    // ... all of them in one query (the conditional CASE WHEN columns)...
    // BikeSumByProduct stays out of the shared queries: with a dimension
    // KEEP among them the shared SELECT joins `product`, and every OTHER
    // measure loses the Helmets row (Total answers 10, not 18) -- a separate
    // defect (open-ledger round D, reported), not this one.
    let shared: Vec<&str> = all
        .iter()
        .copied()
        .filter(|m| *m != "BikeSumByProduct" && *m != "ParentIf")
        .collect();
    let got = ask(&e, &shared, None).await;
    assert_dax(&got[""], "one ungrouped query");
    // ... grouped by a fact column that puts every row in one group...
    let got = ask(&e, &shared, Some(ColumnRef::new("Sales", "cat2"))).await;
    assert_dax(&got["Bikes"], "a query grouped by Sales[cat2]");
    // ... and grouped through the many-to-many relationship, which runs the
    // two-stage pre-aggregation (`pre_aggregate.rs`) for the simple
    // aggregates.
    let pre: Vec<&str> = [
        "Total",
        "BikeAmounts",
        "BikeSum",
        "BikeMin",
        "BikeValues",
        "BikeRows",
    ]
    .to_vec();
    let got = ask(&e, &pre, Some(ColumnRef::new("Periods", "label"))).await;
    assert_dax(&got["All"], "a query grouped through a many-to-many relationship");
    // ... and the two-level percent-of-parent query: every product's IF is
    // BLANK (Bikes' quantity is 3, Helmets' 4, so a NULL condition taking
    // THEN would show those).
    let batches = e
        .query(QueryRequest {
            measures: vec!["ParentIf".into()],
            group_by: vec![ColumnRef::new("Product", "kind"), ColumnRef::new("Product", "name")],
            ..Default::default()
        })
        .await
        .unwrap();
    let mut rows = 0;
    for b in &batches {
        let m = b.column(b.schema().index_of("ParentIf").unwrap());
        for row in 0..b.num_rows() {
            rows += 1;
            let name = key(b.column(b.schema().index_of("name").unwrap()).as_ref(), row);
            assert_eq!(value(m.as_ref(), row), None, "ParentIf for {name} via the two-level query");
        }
    }
    assert_eq!(rows, 2, "Bikes and Helmets");
}

#[tokio::test]
async fn a_context_columns_distinctcount_scalar_counts_blank() {
    // NEW-context-probe-render: a context column's scalar measure is
    // resolved by a probe query; it rendered SQL's COUNT(DISTINCT x), which
    // skips BLANK, while DAX's DISTINCTCOUNT counts it ("The DISTINCTCOUNT
    // function counts the BLANK value" -- Microsoft). Customers 1, 2 and
    // BLANK are THREE distinct values, so Band = IF(amount >= 3, "Big",
    // "Small"): Big = 3 + 5, Small = 2. The probe answered 2, which made
    // every amount Big (10).
    let band = expr::if_expr(
        expr::compare(
            expr::qualified_col("Invoice", "amount"),
            ComparisonOp::GreaterThanOrEqual,
            Expression::MeasureRef("Customers".into()),
        ),
        expr::lit_str("Big"),
        expr::lit_str("Small"),
    );
    let model = DataModel::builder()
        .add_table(in_mem(
            Table::new(
                "Invoice",
                vec![
                    Column::new("customer", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap(),
        ))
        .add_measure(crate::sum_measure("Revenue", "Invoice", "amount"))
        .add_measure(Measure::new(
            "Customers",
            expr::agg(
                AggregateOp::DistinctCount,
                expr::qualified_col("Invoice", "customer"),
            ),
        ))
        .add_context_column(ContextColumn::new("Band", "Invoice", band, DataType::String))
        .build()
        .unwrap();
    let mut e = Engine::new(model);
    e.bind_table("Invoice", 0, SourceBinding::new("public", "invoice"));
    store(
        &mut e,
        "Invoice",
        vec![
            Field::new("customer", ArrowType::Int64, true),
            Field::new("amount", ArrowType::Float64, true),
        ],
        vec![
            Arc::new(Int64Array::from(vec![Some(1), Some(2), None])),
            Arc::new(Float64Array::from(vec![2.0, 3.0, 5.0])),
        ],
    );
    let got = ask(&e, &["Revenue"], Some(ColumnRef::new("Invoice", "Band"))).await;
    assert_eq!(got.get("Big").and_then(|m| m["Revenue"]), Some(8.0), "{got:?}");
    assert_eq!(got.get("Small").and_then(|m| m["Revenue"]), Some(2.0), "{got:?}");
}

