//! Many-to-many, range and one-to-many relationships on the LOCAL path,
//! end to end through `Engine::query` (ledger programme 2, lane engq).
//!
//! - BUG-0763: a KEEP whose table is reached through a many-to-many (or
//!   range) relationship added ONE predicate-free `EXISTS` to the shared
//!   statement's WHERE -- filtering every measure of the query by "has any
//!   related row" -- while the measure's own condition still named the
//!   unjoined table, so every such query failed ("No field named
//!   tags.tag"). It is now a semi-join of the measure that carries it.
//! - BUG-0730: the multi-fact route LEFT JOINed every KEEP table, key-safe or
//!   not (a total of 125 read 210 with a bridge KEEP and a range KEEP in the
//!   query), and INNER JOINed a many-to-many GROUP BY dimension (blue 35 read
//!   55); a one-to-many KEEP seen from its one side multiplied rows on the
//!   single-fact route too (products with a big sale: 2 read 3).
//! - BUG-0764: grouping through such a relationship re-aggregated every
//!   per-key partial with SUM and joined the bridge itself, so a key it holds
//!   twice counted twice: measured on the original code, blue's MEDIAN of 10
//!   read 47.5 and its SUM of 35 read 55.
//!
//! DAX (Power BI): a many-to-many relationship is "limited" -- its joins use
//! INNER JOIN semantics with no blank row -- and a fact row filtered or
//! grouped through it counts ONCE however many bridge rows match it ("the
//! customer balances are non-additive", Microsoft, Many-to-many relationship
//! guidance). The filter runs from the KEEP's (or the axis') table to the
//! measure's table.
//!
//! Fixture. `Sales(id, prod_id, day, amount, qty, cat, cust)`:
//!
//! | id | prod | day | amount | qty  | cat | cust  |
//! |----|------|-----|--------|------|-----|-------|
//! | 1  | 1    | 1   | 10     | 1    | A   | x     |
//! | 2  | 2    | 7   | 20     | NULL | A   | x     |
//! | 3  | 3    | 20  | 40     | 3    | B   | y     |
//! | 4  | 1    | 8   | 5      | 4    | B   | BLANK |
//! | 5  | 3    | 21  | 50     | 5    | B   | z     |
//!
//! `Tags(prod_id, tag)` -- an equality many-to-many bridge on `prod_id`:
//! (1, red), (1, blue), (2, blue), (2, blue) -- product 2's blue row TWICE,
//! product 3 untagged. `Periods(start_day, end_day, label)` -- a range
//! many-to-many (`start_day <= day <= end_day`): Q1 0-5, Q2 6-10, Mid 3-9
//! (overlapping). `Deadlines(due, kind)` -- ONE range condition, declared
//! from Deadlines (`due >= day`): (5, soft), (9, hard). `Product(id, name)`
//! many-to-one: Bikes, Helmets, Locks. `Budget(prod_id, b)` -- a second fact
//! -> Product: 100, 200, 300.
//!
//! So red holds rows 1, 4; blue rows 1, 2, 4; Q1 row 1; Q2 and Mid rows 2, 4;
//! a hard deadline rows 1, 2, 4; a soft one row 1.

#![cfg(test)]

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{Array, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Schema};
use arrow::record_batch::RecordBatch;

use crate::{
    expression_measure, parse_measure, Cardinality, Column, ColumnRef, ComparisonOp, DataModel,
    DataType, Engine,
    FilterCondition, FilterOperator, FilterPropagation, InFilter, JoinCondition, JoinOperator,
    InMemoryConnector, Measure, QueryRequest, Relationship, ScopedInFilter, SourceBinding,
    SecurityRole, StorageMode, Table,
};

/// (measure, formula). The DAX answers are asserted where they are read.
const MEASURES: &[(&str, &str)] = &[
    ("Total", "SUM(Sales[amount])"),
    ("Rows", "COUNTROWS(Sales)"),
    ("QtyCount", "COUNT(Sales[qty])"),
    ("MinAmount", "MIN(Sales[amount])"),
    ("MaxAmount", "MAX(Sales[amount])"),
    ("AvgAmount", "AVERAGE(Sales[amount])"),
    ("Customers", "DISTINCTCOUNT(Sales[cust])"),
    ("CustomersNoBlank", "DISTINCTCOUNTNOBLANK(Sales[cust])"),
    ("MedianAmount", "MEDIAN(Sales[amount])"),
    ("StdevAmount", "STDEV(Sales[amount])"),
    ("StdevPAmount", "STDEVP(Sales[amount])"),
    ("VarAmount", "VARIANCE(Sales[amount])"),
    ("VarPAmount", "VARIANCEP(Sales[amount])"),
    ("AmountPerRow", "SUM(Sales[amount]) / COUNTROWS(Sales)"),
    ("CatASum", "SUM(Sales[amount], KEEP(Sales, Sales[cat] = \"A\"))"),
    (
        "TotalPlusCatA",
        "SUM(Sales[amount]) + SUM(Sales[amount], KEEP(Sales, Sales[cat] = \"A\"))",
    ),
    ("Share", "DIVIDE(SUM(Sales[amount]), SUM(Sales[amount], RESET()))"),
    ("GrandTotal", "SUM(Sales[amount], RESET())"),
    // ---- KEEPs on the many-to-many / range / one-to-many tables ----
    ("RedSum", "SUM(Sales[amount], KEEP(Tags, Tags[tag] = \"red\"))"),
    ("BlueSum", "SUM(Sales[amount], KEEP(Tags, Tags[tag] = \"blue\"))"),
    ("NotRedSum", "SUM(Sales[amount], KEEP(Tags, Tags[tag] <> \"red\"))"),
    ("RedRows", "COUNTROWS(Sales, KEEP(Tags, Tags[tag] = \"red\"))"),
    ("RedCustomers", "DISTINCTCOUNT(Sales[cust], KEEP(Tags, Tags[tag] = \"red\"))"),
    ("Q2Sum", "SUM(Sales[amount], KEEP(Periods, Periods[label] = \"Q2\"))"),
    ("MidRows", "COUNTROWS(Sales, KEEP(Periods, Periods[label] = \"Mid\"))"),
    (
        "RedQ2Sum",
        "SUM(Sales[amount], KEEP(Tags, Tags[tag] = \"red\"), KEEP(Periods, Periods[label] = \"Q2\"))",
    ),
    ("HardSum", "SUM(Sales[amount], KEEP(Deadlines, Deadlines[kind] = \"hard\"))"),
    ("SoftSum", "SUM(Sales[amount], KEEP(Deadlines, Deadlines[kind] = \"soft\"))"),
    (
        "RedPlusTotal",
        "SUM(Sales[amount], KEEP(Tags, Tags[tag] = \"red\")) + SUM(Sales[amount])",
    ),
    (
        "RedShare",
        "DIVIDE(SUM(Sales[amount], KEEP(Tags, Tags[tag] = \"red\")), SUM(Sales[amount]))",
    ),
    ("Budget", "SUM(Budget[b])"),
    ("ProductCount", "COUNTROWS(Product)"),
    ("ProductsWithBigSale", "COUNTROWS(Product, KEEP(Sales, Sales[amount] > 15))"),
    // ---- wave 3 (lane engfix) ----
    ("BikesSum", "SUM(Sales[amount], KEEP(Product, Product[name] = \"Bikes\"))"),
    ("LocksSum", "SUM(Sales[amount], KEEP(Sales, Sales[prod_id] = 3))"),
    ("LocksMedian", "MEDIAN(Sales[amount], KEEP(Sales, Sales[prod_id] = 3))"),
    // Through the INACTIVE many-to-many Sales_Labels.
    (
        "HotViaLabels",
        "SUM(Sales[amount], USERELATIONSHIP(\"Sales_Labels\"), KEEP(Labels, Labels[label] = \"hot\"))",
    ),
    (
        "ColdViaLabels",
        "SUM(Sales[amount], USERELATIONSHIP(\"Sales_Labels\"), KEEP(Labels, Labels[label] = \"cold\"))",
    ),
    ("ViaLabels", "SUM(Sales[amount], USERELATIONSHIP(\"Sales_Labels\"))"),
];

fn table(storage: StorageMode, name: &str, columns: &[(&str, DataType)]) -> Table {
    (
        Table::new(
            name,
            columns
                .iter()
                .map(|(c, t)| Column::new(*c, t.clone()))
                .collect(),
        )
        .unwrap()
    )
    .with_storage_mode(storage)
}

fn model() -> DataModel {
    model_with(Vec::new())
}

fn model_with(extra: Vec<Measure>) -> DataModel {
    model_with_product_relationship(
        extra,
        Relationship::many_to_one("Sales_Product", "Sales", "prod_id", "Product", "id"),
    )
}

/// The fixture with `sales_product` as the Sales <-> Product relationship
/// (the default declares it many-to-one from Sales).
fn model_with_product_relationship(extra: Vec<Measure>, sales_product: Relationship) -> DataModel {
    model_variant(extra, sales_product, false, Vec::new())
}

/// The fixture's range relationships: as declared (`Sales_Periods` from
/// Sales, `Deadlines_Sales` from Deadlines) or, with `flip_ranges`, each
/// declared from its OTHER end (`Periods[start_day] <= Sales[day] AND
/// Periods[end_day] >= Sales[day]`; `Sales[day] <= Deadlines[due]`) -- the
/// same relationships, so every DAX answer is the same.
fn range_relationships(flip_ranges: bool) -> [Relationship; 2] {
    if !flip_ranges {
        return [
            Relationship::many_to_many(
                "Sales_Periods",
                "Sales",
                "Periods",
                vec![
                    JoinCondition::new("day", "start_day", JoinOperator::GreaterThanOrEqual),
                    JoinCondition::new("day", "end_day", JoinOperator::LessThanOrEqual),
                ],
            ),
            Relationship::many_to_many(
                "Deadlines_Sales",
                "Deadlines",
                "Sales",
                vec![JoinCondition::new(
                    "due",
                    "day",
                    JoinOperator::GreaterThanOrEqual,
                )],
            ),
        ];
    }
    [
        Relationship::many_to_many(
            "Sales_Periods",
            "Periods",
            "Sales",
            vec![
                JoinCondition::new("start_day", "day", JoinOperator::LessThanOrEqual),
                JoinCondition::new("end_day", "day", JoinOperator::GreaterThanOrEqual),
            ],
        ),
        Relationship::many_to_many(
            "Deadlines_Sales",
            "Sales",
            "Deadlines",
            vec![JoinCondition::new("day", "due", JoinOperator::LessThanOrEqual)],
        ),
    ]
}

/// The fixture with `sales_product` as the Sales <-> Product relationship,
/// the range relationships declared from either end (`flip_ranges`), and
/// `extra_relationships` added.
fn model_variant(
    extra: Vec<Measure>,
    sales_product: Relationship,
    flip_ranges: bool,
    extra_relationships: Vec<Relationship>,
) -> DataModel {
    model_variant_stored(
        StorageMode::InMemory,
        extra,
        sales_product,
        flip_ranges,
        extra_relationships,
    )
}

/// [`model_variant`] with every table in `storage` mode (`DirectQuery` for the
/// connector-served fixture).
fn model_variant_stored(
    storage: StorageMode,
    extra: Vec<Measure>,
    sales_product: Relationship,
    flip_ranges: bool,
    extra_relationships: Vec<Relationship>,
) -> DataModel {
    let [sales_periods, deadlines_sales] = range_relationships(flip_ranges);
    let mut builder = DataModel::builder()
        .add_table(table(
            storage.clone(),
            "Sales",
            &[
                ("id", DataType::Int64),
                ("prod_id", DataType::Int64),
                ("day", DataType::Int64),
                ("amount", DataType::Float64),
                ("qty", DataType::Int64),
                ("cat", DataType::String),
                ("cust", DataType::String),
            ],
        ))
        .add_table(table(
            storage.clone(),
            "Tags",
            &[("prod_id", DataType::Int64), ("tag", DataType::String)],
        ))
        .add_table(table(
            storage.clone(),
            "Periods",
            &[
                ("start_day", DataType::Int64),
                ("end_day", DataType::Int64),
                ("label", DataType::String),
            ],
        ))
        .add_table(table(
            storage.clone(),
            "Deadlines",
            &[("due", DataType::Int64), ("kind", DataType::String)],
        ))
        .add_table(table(
            storage.clone(),
            "Product",
            &[
                ("id", DataType::Int64),
                ("name", DataType::String),
                ("grp", DataType::String),
                ("lo", DataType::Int64),
                ("hi", DataType::Int64),
            ],
        ))
        .add_table(table(
            storage.clone(),
            "Budget",
            &[("prod_id", DataType::Int64), ("b", DataType::Float64)],
        ))
        .add_relationship(Relationship::with_conditions(
            "Sales_Tags",
            "Sales",
            "Tags",
            vec![JoinCondition::equal("prod_id", "prod_id")],
            Cardinality::ManyToMany,
        ))
        .add_relationship(sales_periods)
        .add_relationship(deadlines_sales)
        .add_table(table(
            storage.clone(),
            "Labels",
            &[("prod_id", DataType::Int64), ("label", DataType::String)],
        ))
        .add_relationship(sales_product)
        .add_relationship(
            Relationship::with_conditions(
                "Sales_Labels",
                "Sales",
                "Labels",
                vec![JoinCondition::equal("prod_id", "prod_id")],
                Cardinality::ManyToMany,
            )
            .with_active(false),
        )
        .add_relationship(Relationship::many_to_one(
            "Budget_Product",
            "Budget",
            "prod_id",
            "Product",
            "id",
        ));
    for r in extra_relationships {
        builder = builder.add_relationship(r);
    }
    for (name, formula) in MEASURES {
        builder = builder.add_measure(expression_measure(
            *name,
            parse_measure(formula).unwrap_or_else(|e| panic!("{name}: {e}")),
        ));
    }
    for m in extra {
        builder = builder.add_measure(m);
    }
    builder.build().unwrap()
}

fn store(
    batches: &mut Vec<(&'static str, RecordBatch)>,
    table: &'static str,
    fields: Vec<Field>,
    columns: Vec<Arc<dyn Array>>,
) {
    batches.push((
        table,
        RecordBatch::try_new(Arc::new(Schema::new(fields)), columns).unwrap(),
    ));
}

fn int(name: &str) -> Field {
    Field::new(name, ArrowType::Int64, true)
}

fn text(name: &str) -> Field {
    Field::new(name, ArrowType::Utf8, true)
}

fn engine() -> Engine {
    engine_for(model())
}

/// The fixture's rows served from the in-memory CACHE.
fn engine_for(model: DataModel) -> Engine {
    fixture_engine(model, false)
}

/// The fixture's rows served by a CONNECTOR (an `InMemoryConnector` source
/// over a `DirectQuery` model): the fetch path's connector branches.
fn connector_engine_for(model: DataModel) -> Engine {
    fixture_engine(model, true)
}

fn fixture_engine(model: DataModel, connector: bool) -> Engine {
    let mut e = Engine::new(model);
    let mut batches: Vec<(&'static str, RecordBatch)> = Vec::new();
    store(
        &mut batches,
        "Sales",
        vec![
            int("id"),
            int("prod_id"),
            int("day"),
            Field::new("amount", ArrowType::Float64, true),
            int("qty"),
            text("cat"),
            text("cust"),
        ],
        vec![
            Arc::new(Int64Array::from(vec![1, 2, 3, 4, 5])),
            Arc::new(Int64Array::from(vec![1, 2, 3, 1, 3])),
            Arc::new(Int64Array::from(vec![1, 7, 20, 8, 21])),
            Arc::new(Float64Array::from(vec![10.0, 20.0, 40.0, 5.0, 50.0])),
            Arc::new(Int64Array::from(vec![
                Some(1),
                None,
                Some(3),
                Some(4),
                Some(5),
            ])),
            Arc::new(StringArray::from(vec!["A", "A", "B", "B", "B"])),
            Arc::new(StringArray::from(vec![
                Some("x"),
                Some("x"),
                Some("y"),
                None,
                Some("z"),
            ])),
        ],
    );
    store(
        &mut batches,
        "Tags",
        vec![int("prod_id"), text("tag")],
        vec![
            Arc::new(Int64Array::from(vec![1, 1, 2, 2])),
            Arc::new(StringArray::from(vec!["red", "blue", "blue", "blue"])),
        ],
    );
    store(
        &mut batches,
        "Periods",
        vec![int("start_day"), int("end_day"), text("label")],
        vec![
            Arc::new(Int64Array::from(vec![0, 6, 3])),
            Arc::new(Int64Array::from(vec![5, 10, 9])),
            Arc::new(StringArray::from(vec!["Q1", "Q2", "Mid"])),
        ],
    );
    store(
        &mut batches,
        "Deadlines",
        vec![int("due"), text("kind")],
        vec![
            Arc::new(Int64Array::from(vec![5, 9])),
            Arc::new(StringArray::from(vec!["soft", "hard"])),
        ],
    );
    store(
        &mut batches,
        "Product",
        vec![int("id"), text("name"), text("grp"), int("lo"), int("hi")],
        vec![
            Arc::new(Int64Array::from(vec![1, 2, 3])),
            Arc::new(StringArray::from(vec!["Bikes", "Helmets", "Locks"])),
            Arc::new(StringArray::from(vec!["odd", "even", "odd"])),
            Arc::new(Int64Array::from(vec![0, 6, 15])),
            Arc::new(Int64Array::from(vec![5, 10, 25])),
        ],
    );
    store(
        &mut batches,
        "Budget",
        vec![int("prod_id"), Field::new("b", ArrowType::Float64, true)],
        vec![
            Arc::new(Int64Array::from(vec![1, 2, 3])),
            Arc::new(Float64Array::from(vec![100.0, 200.0, 300.0])),
        ],
    );
    // Product 1 labelled hot twice, product 3 hot and cold, product 2 none.
    store(
        &mut batches,
        "Labels",
        vec![int("prod_id"), text("label")],
        vec![
            Arc::new(Int64Array::from(vec![1, 1, 3, 3])),
            Arc::new(StringArray::from(vec!["hot", "hot", "hot", "cold"])),
        ],
    );
    if connector {
        let mut source = InMemoryConnector::new();
        for (t, b) in &batches {
            source = source.with_table("public", t.to_lowercase(), b.clone());
        }
        let idx = e.add_in_memory_source(source);
        for (t, _) in &batches {
            e.bind_table(*t, idx, SourceBinding::new("public", &t.to_lowercase()));
        }
    } else {
        for (t, b) in batches {
            e.bind_table(t, 0, SourceBinding::new("public", &t.to_lowercase()));
            e.cache.store(t, b).unwrap();
        }
    }
    e
}

type Answers = HashMap<String, HashMap<String, Option<f64>>>;

fn value(column: &dyn Array, row: usize) -> Option<f64> {
    if column.is_null(row) {
        return None;
    }
    let as_f64 = arrow::compute::cast(&column.slice(row, 1), &ArrowType::Float64).unwrap();
    Some(
        as_f64
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap()
            .value(0),
    )
}

fn key_part(column: &dyn Array, row: usize) -> String {
    if column.is_null(row) {
        return "BLANK".to_string();
    }
    arrow::util::display::array_value_to_string(column, row).unwrap()
}

/// Ask `measures` grouped by `group` (none = ungrouped): group key (the
/// group values joined with `|`, "" ungrouped) -> measure -> answer.
async fn try_ask(
    engine: &Engine,
    measures: &[&str],
    group: &[ColumnRef],
) -> Result<Answers, String> {
    try_ask_filtered(engine, measures, group, QueryRequest::default()).await
}

/// [`try_ask`] under the filters (scalar, IN-list, scoped) of `filtered`.
async fn try_ask_filtered(
    engine: &Engine,
    measures: &[&str],
    group: &[ColumnRef],
    filtered: QueryRequest,
) -> Result<Answers, String> {
    let batches = engine
        .query(QueryRequest {
            measures: measures.iter().map(|m| m.to_string()).collect(),
            group_by: group.to_vec(),
            ..filtered
        })
        .await
        .map_err(|e| e.to_string())?;
    let mut out: Answers = HashMap::new();
    for b in &batches {
        for row in 0..b.num_rows() {
            let k: Vec<String> = group
                .iter()
                .map(|g| {
                    key_part(
                        b.column(b.schema().index_of(&g.column).unwrap()).as_ref(),
                        row,
                    )
                })
                .collect();
            let entry = out.entry(k.join("|")).or_default();
            for m in measures {
                let col = b.column(b.schema().index_of(m).unwrap());
                entry.insert((*m).to_string(), value(col.as_ref(), row));
            }
        }
    }
    Ok(out)
}

async fn ask(engine: &Engine, measures: &[&str], group: &[ColumnRef]) -> Answers {
    try_ask(engine, measures, group)
        .await
        .unwrap_or_else(|e| panic!("{measures:?} by {group:?}: {e}"))
}

async fn ask_filtered(
    engine: &Engine,
    measures: &[&str],
    group: &[ColumnRef],
    filtered: QueryRequest,
) -> Answers {
    try_ask_filtered(engine, measures, group, filtered)
        .await
        .unwrap_or_else(|e| panic!("{measures:?} by {group:?} (filtered): {e}"))
}

fn close(got: Option<f64>, want: Option<f64>) -> bool {
    match (got, want) {
        (Some(g), Some(w)) => (g - w).abs() < 1e-9,
        (None, None) => true,
        _ => false,
    }
}

#[track_caller]
fn check(answers: &Answers, key: &str, measure: &str, want: Option<f64>, route: &str) {
    let got = answers
        .get(key)
        .unwrap_or_else(|| panic!("{route}: no row '{key}' in {answers:?}"))
        .get(measure)
        .copied()
        .unwrap_or_else(|| panic!("{route}: no {measure}"));
    assert!(
        close(got, want),
        "{measure} at '{key}' via {route}: got {got:?}, DAX answers {want:?} ({answers:?})"
    );
}

fn cat() -> ColumnRef {
    ColumnRef::new("Sales", "cat")
}

fn product() -> ColumnRef {
    ColumnRef::new("Product", "name")
}

fn tag() -> ColumnRef {
    ColumnRef::new("Tags", "tag")
}

fn period() -> ColumnRef {
    ColumnRef::new("Periods", "label")
}

// ---------------------------------------------------------------- BUG-0763

/// The ungrouped DAX answers of the KEEP measures.
const KEEP_UNGROUPED: &[(&str, f64)] = &[
    ("RedSum", 15.0),
    // Product 2's blue row twice is still product 2 once.
    ("BlueSum", 35.0),
    // Every visible Tags row is blue: products 1 and 2 -- the untagged
    // product 3 is NOT kept (a limited relationship has no blank row).
    ("NotRedSum", 35.0),
    ("RedRows", 2.0),
    // Rows 1 and 4: customer x and a BLANK one (DISTINCTCOUNT counts BLANK).
    ("RedCustomers", 2.0),
    ("Q2Sum", 25.0),
    ("MidRows", 2.0),
    // Both KEEPs on the same row: product 1 AND a Q2 day -- row 4.
    ("RedQ2Sum", 5.0),
    // `due >= day` for some hard deadline (9): days 1, 7, 8.
    ("HardSum", 35.0),
    // A soft deadline (5): day 1.
    ("SoftSum", 10.0),
    ("RedPlusTotal", 140.0),
    ("RedShare", 0.12),
];

#[tokio::test]
async fn a_many_to_many_keep_filters_only_its_own_measure() {
    let e = engine();
    // Alone (the KEEP is pushed into its table's fetch), then with the plain
    // total in ONE shared statement, which must stay 125.
    for (m, want) in KEEP_UNGROUPED {
        let got = ask(&e, &[m], &[]).await;
        check(&got, "", m, Some(*want), &format!("{m} alone"));
        let got = ask(&e, &["Total", m], &[]).await;
        check(&got, "", m, Some(*want), &format!("{m} beside Total"));
        check(&got, "", "Total", Some(125.0), &format!("Total beside {m}"));
    }
    // Every KEEP measure in one statement, beside the unfiltered ones.
    let mut all: Vec<&str> = vec!["Total", "Rows", "Customers"];
    all.extend(KEEP_UNGROUPED.iter().map(|(m, _)| *m));
    let got = ask(&e, &all, &[]).await;
    check(&got, "", "Total", Some(125.0), "all in one statement");
    check(&got, "", "Rows", Some(5.0), "all in one statement");
    check(&got, "", "Customers", Some(4.0), "all in one statement");
    for (m, want) in KEEP_UNGROUPED {
        check(&got, "", m, Some(*want), "all in one statement");
    }
}

#[tokio::test]
async fn a_many_to_many_keep_filters_only_its_own_measure_in_every_group() {
    let e = engine();
    // By a fact column: A = rows 1, 2; B = rows 3, 4, 5.
    let names = [
        "Total",
        "RedSum",
        "BlueSum",
        "Q2Sum",
        "HardSum",
        "RedPlusTotal",
    ];
    let got = ask(&e, &names, &[cat()]).await;
    for (k, m, want) in [
        ("A", "Total", 30.0),
        ("B", "Total", 95.0),
        ("A", "RedSum", 10.0),
        ("B", "RedSum", 5.0),
        ("A", "BlueSum", 30.0),
        ("B", "BlueSum", 5.0),
        ("A", "Q2Sum", 20.0),
        ("B", "Q2Sum", 5.0),
        ("A", "HardSum", 30.0),
        ("B", "HardSum", 5.0),
        ("A", "RedPlusTotal", 40.0),
        ("B", "RedPlusTotal", 100.0),
    ] {
        check(&got, k, m, Some(want), "grouped by Sales[cat]");
    }
    // Each alone, grouped the same way.
    for (k, m, want) in [
        ("A", "RedSum", 10.0),
        ("B", "Q2Sum", 5.0),
        ("B", "HardSum", 5.0),
    ] {
        let alone = ask(&e, &[m], &[cat()]).await;
        check(
            &alone,
            k,
            m,
            Some(want),
            &format!("{m} alone by Sales[cat]"),
        );
    }
    // By a many-to-one dimension: Bikes rows 1, 4; Helmets row 2; Locks 3, 5.
    let got = ask(&e, &["Total", "RedSum", "BlueSum"], &[product()]).await;
    for (k, m, want) in [
        ("Bikes", "Total", Some(15.0)),
        ("Helmets", "Total", Some(20.0)),
        ("Locks", "Total", Some(90.0)),
        ("Bikes", "RedSum", Some(15.0)),
        ("Helmets", "RedSum", None),
        ("Locks", "RedSum", None),
        ("Bikes", "BlueSum", Some(15.0)),
        ("Helmets", "BlueSum", Some(20.0)),
        ("Locks", "BlueSum", None),
    ] {
        check(&got, k, m, want, "grouped by Product[name]");
    }
}

// ---------------------------------------------------------------- BUG-0730

#[tokio::test]
async fn the_multi_fact_route_never_joins_a_table_that_multiplies_its_rows() {
    let e = engine();
    // A Budget measure makes the query multi-fact. The bridge and the range
    // table LEFT JOINed multiplied the Sales rows of EVERY measure of the
    // group: Total read 210 (product 1's two tags, product 2's two blue rows,
    // days 7 and 8 in two periods each).
    let got = ask(&e, &["Total", "RedSum", "BlueSum", "Q2Sum", "Budget"], &[]).await;
    check(&got, "", "Total", Some(125.0), "multi-fact, ungrouped");
    check(&got, "", "RedSum", Some(15.0), "multi-fact, ungrouped");
    check(&got, "", "BlueSum", Some(35.0), "multi-fact, ungrouped");
    check(&got, "", "Q2Sum", Some(25.0), "multi-fact, ungrouped");
    check(&got, "", "Budget", Some(600.0), "multi-fact, ungrouped");

    let got = ask(&e, &["Total", "RedSum", "BlueSum", "Budget"], &[product()]).await;
    for (k, m, want) in [
        ("Bikes", "Total", Some(15.0)),
        ("Locks", "Total", Some(90.0)),
        ("Bikes", "BlueSum", Some(15.0)),
        ("Helmets", "BlueSum", Some(20.0)),
        ("Helmets", "RedSum", None),
        ("Bikes", "Budget", Some(100.0)),
        ("Locks", "Budget", Some(300.0)),
    ] {
        check(&got, k, m, want, "multi-fact by Product[name]");
    }

    // A many-to-many GROUP BY on the multi-fact route was INNER JOINed: blue
    // read 55. It now takes the pre-aggregation, as a single-fact query does;
    // Budget does not reach Tags, so its total repeats on every tag.
    let got = ask(&e, &["Total", "Budget"], &[tag()]).await;
    check(&got, "red", "Total", Some(15.0), "multi-fact by Tags[tag]");
    check(&got, "blue", "Total", Some(35.0), "multi-fact by Tags[tag]");
    check(
        &got,
        "blue",
        "Budget",
        Some(600.0),
        "multi-fact by Tags[tag]",
    );
    let got = ask(&e, &["Total", "Budget"], &[period()]).await;
    check(
        &got,
        "Q2",
        "Total",
        Some(25.0),
        "multi-fact by Periods[label]",
    );
    check(
        &got,
        "Q1",
        "Total",
        Some(10.0),
        "multi-fact by Periods[label]",
    );
}

#[tokio::test]
async fn a_keep_on_the_many_side_reaches_the_one_side_once_per_row() {
    let e = engine();
    // Products with SOME sale over 15: Helmets (20) and Locks (40, 50) -- 2.
    // LEFT JOINed, Locks counted once per big sale (3), and the plain
    // COUNTROWS(Product) beside it counted product x sale pairs (5).
    let got = ask(&e, &["ProductsWithBigSale"], &[]).await;
    check(&got, "", "ProductsWithBigSale", Some(2.0), "alone");
    let got = ask(&e, &["ProductCount", "ProductsWithBigSale"], &[]).await;
    check(&got, "", "ProductCount", Some(3.0), "one statement");
    check(&got, "", "ProductsWithBigSale", Some(2.0), "one statement");
    let got = ask(&e, &["ProductCount", "ProductsWithBigSale"], &[product()]).await;
    check(&got, "Locks", "ProductCount", Some(1.0), "by Product[name]");
    check(
        &got,
        "Locks",
        "ProductsWithBigSale",
        Some(1.0),
        "by Product[name]",
    );
    check(
        &got,
        "Helmets",
        "ProductsWithBigSale",
        Some(1.0),
        "by Product[name]",
    );
    check(
        &got,
        "Bikes",
        "ProductsWithBigSale",
        None,
        "by Product[name]",
    );
    // And on the multi-fact route, beside a Sales measure.
    let got = ask(&e, &["Total", "ProductCount", "ProductsWithBigSale"], &[]).await;
    check(&got, "", "Total", Some(125.0), "multi-fact");
    check(&got, "", "ProductCount", Some(3.0), "multi-fact");
    check(&got, "", "ProductsWithBigSale", Some(2.0), "multi-fact");
}

// ---------------------------------------------------------------- BUG-0764

/// Per group value, the DAX answers of the plain aggregates. `None` = BLANK.
fn by_tag(measure: &str, key: &str) -> Option<f64> {
    // red: rows 1, 4 -> amounts [10, 5], qty [1, 4], cust [x, BLANK].
    // blue: rows 1, 2, 4 -> amounts [10, 20, 5], qty [1, BLANK, 4],
    // cust [x, x, BLANK].
    let red = key == "red";
    Some(match measure {
        "Total" => {
            if red {
                15.0
            } else {
                35.0
            }
        }
        "Rows" => {
            if red {
                2.0
            } else {
                3.0
            }
        }
        "QtyCount" => 2.0,
        "MinAmount" => 5.0,
        "MaxAmount" => {
            if red {
                10.0
            } else {
                20.0
            }
        }
        "AvgAmount" => {
            if red {
                7.5
            } else {
                35.0 / 3.0
            }
        }
        "Customers" => 2.0,
        "CustomersNoBlank" => 1.0,
        "MedianAmount" => {
            if red {
                7.5
            } else {
                10.0
            }
        }
        "StdevAmount" => {
            if red {
                12.5_f64.sqrt()
            } else {
                (175.0_f64 / 3.0).sqrt()
            }
        }
        "StdevPAmount" => {
            if red {
                2.5
            } else {
                (350.0_f64 / 9.0).sqrt()
            }
        }
        "VarAmount" => {
            if red {
                12.5
            } else {
                175.0 / 3.0
            }
        }
        "VarPAmount" => {
            if red {
                6.25
            } else {
                350.0 / 9.0
            }
        }
        "AmountPerRow" => {
            if red {
                7.5
            } else {
                35.0 / 3.0
            }
        }
        // Row 1 (A) for red; rows 1, 2 for blue.
        "CatASum" => {
            if red {
                10.0
            } else {
                30.0
            }
        }
        "TotalPlusCatA" => {
            if red {
                25.0
            } else {
                65.0
            }
        }
        // Over the RESET total of every Sales row, tagged or not: 125.
        "Share" => {
            if red {
                0.12
            } else {
                0.28
            }
        }
        "GrandTotal" => 125.0,
        // A KEEP on ANOTHER range table: red rows 1, 4 on Q2 days -> row 4.
        "Q2Sum" => {
            if red {
                5.0
            } else {
                25.0
            }
        }
        other => panic!("no tag answer for {other}"),
    })
}

/// Q1: row 1; Q2 and Mid: rows 2, 4 -> amounts [20, 5], qty [BLANK, 4],
/// cust [x, BLANK].
fn by_period(measure: &str, key: &str) -> Option<f64> {
    let q1 = key == "Q1";
    Some(match measure {
        "Total" => {
            if q1 {
                10.0
            } else {
                25.0
            }
        }
        "Rows" => {
            if q1 {
                1.0
            } else {
                2.0
            }
        }
        "QtyCount" => 1.0,
        "MinAmount" => {
            if q1 {
                10.0
            } else {
                5.0
            }
        }
        "MaxAmount" => {
            if q1 {
                10.0
            } else {
                20.0
            }
        }
        "AvgAmount" => {
            if q1 {
                10.0
            } else {
                12.5
            }
        }
        "Customers" => {
            if q1 {
                1.0
            } else {
                2.0
            }
        }
        "CustomersNoBlank" => 1.0,
        "MedianAmount" => {
            if q1 {
                10.0
            } else {
                12.5
            }
        }
        "StdevAmount" => return if q1 { None } else { Some(112.5_f64.sqrt()) },
        "StdevPAmount" => {
            if q1 {
                0.0
            } else {
                7.5
            }
        }
        "VarAmount" => return if q1 { None } else { Some(112.5) },
        "VarPAmount" => {
            if q1 {
                0.0
            } else {
                56.25
            }
        }
        "AmountPerRow" => {
            if q1 {
                10.0
            } else {
                12.5
            }
        }
        "CatASum" => {
            if q1 {
                10.0
            } else {
                20.0
            }
        }
        "TotalPlusCatA" => {
            if q1 {
                20.0
            } else {
                45.0
            }
        }
        "Share" => {
            if q1 {
                0.08
            } else {
                0.2
            }
        }
        "GrandTotal" => 125.0,
        // A KEEP on the equality bridge: Q1 row 1 is red; row 4 is red.
        "RedSum" => {
            if q1 {
                10.0
            } else {
                5.0
            }
        }
        other => panic!("no period answer for {other}"),
    })
}

/// The same measure computed WITHOUT grouping through the relationship: the
/// group value as a KEEP on its table, ungrouped (a per-measure semi-join,
/// no pre-aggregation, no mapping).
fn keep_formula(measure: &str, keep: &str) -> String {
    let (_, formula) = MEASURES.iter().find(|(m, _)| *m == measure).unwrap();
    match measure {
        "AmountPerRow" => format!("SUM(Sales[amount], {keep}) / COUNTROWS(Sales, {keep})"),
        "TotalPlusCatA" => format!(
            "SUM(Sales[amount], {keep}) + SUM(Sales[amount], KEEP(Sales, Sales[cat] = \"A\"), {keep})"
        ),
        "Share" => format!("DIVIDE(SUM(Sales[amount], {keep}), SUM(Sales[amount], RESET()))"),
        "GrandTotal" => formula.to_string(),
        _ => {
            // `AGG(Sales[col])` or `AGG(Sales[col], KEEP(...))`: add the KEEP
            // as one more context argument.
            let open = formula.find('(').unwrap();
            let close = formula.rfind(')').unwrap();
            format!("{}({}, {keep})", &formula[..open], &formula[open + 1..close])
        }
    }
}

const GROUPED: &[&str] = &[
    "Total",
    "Rows",
    "QtyCount",
    "MinAmount",
    "MaxAmount",
    "AvgAmount",
    "Customers",
    "CustomersNoBlank",
    "MedianAmount",
    "StdevAmount",
    "StdevPAmount",
    "VarAmount",
    "VarPAmount",
    "AmountPerRow",
    "CatASum",
    "TotalPlusCatA",
    "Share",
    "GrandTotal",
];

/// An engine holding, beside the fixture measures, `<measure>@<value>` =
/// the measure with the group value as a KEEP, for the cross-route oracle.
fn oracle_engine(axis: &ColumnRef, values: &[&str], measures: &[&str]) -> Engine {
    let mut extra = Vec::new();
    for measure in measures {
        for v in values {
            let keep = format!("KEEP({0}, {0}[{1}] = \"{v}\")", axis.table, axis.column);
            let f = keep_formula(measure, &keep);
            extra.push(expression_measure(
                format!("{measure}@{v}"),
                parse_measure(&f).unwrap_or_else(|e| panic!("{f}: {e}")),
            ));
        }
    }
    engine_for(model_with(extra))
}

async fn every_aggregate_kind_through(axis: ColumnRef, values: &[&str], extra: &[&str]) {
    let answer = |m: &str, k: &str| {
        if axis.table == "Tags" {
            by_tag(m, k)
        } else {
            by_period(m, k)
        }
    };
    let mut names: Vec<&str> = GROUPED.to_vec();
    names.extend_from_slice(extra);
    let e = oracle_engine(&axis, values, &names);
    for m in &names {
        // Alone: the two stages for a decomposable aggregate, the fine grain
        // for any other.
        let got = ask(&e, &[m], std::slice::from_ref(&axis)).await;
        for v in values {
            // A group whose only measure is BLANK is no row (SUMMARIZECOLUMNS).
            if answer(m, v).is_none() {
                assert!(!got.contains_key(*v), "{m} alone by {axis:?}: {got:?}");
            } else {
                check(&got, v, m, answer(m, v), &format!("{m} alone by {axis:?}"));
            }
            // The same answer without grouping through the relationship.
            let oracle = format!("{m}@{v}");
            let ungrouped = ask(&e, &[oracle.as_str()], &[]).await;
            check(
                &ungrouped,
                "",
                &oracle,
                answer(m, v),
                &format!("{oracle} ungrouped"),
            );
        }
    }
    // All of them in ONE statement (the fine grain for every measure).
    let got = ask(&e, &names, std::slice::from_ref(&axis)).await;
    for m in &names {
        for v in values {
            check(
                &got,
                v,
                m,
                answer(m, v),
                &format!("{m} in one statement by {axis:?}"),
            );
        }
    }
    // Only the decomposable ones together: the two stages, joined through
    // the DISTINCT mapping.
    let decomposable = [
        "Total",
        "Rows",
        "QtyCount",
        "MinAmount",
        "MaxAmount",
        "AvgAmount",
        "CatASum",
    ];
    let got = ask(&e, &decomposable, std::slice::from_ref(&axis)).await;
    for m in decomposable {
        for v in values {
            check(
                &got,
                v,
                m,
                answer(m, v),
                &format!("{m} with the decomposable by {axis:?}"),
            );
        }
    }
}

#[tokio::test]
async fn every_aggregate_kind_grouped_through_an_equality_bridge() {
    every_aggregate_kind_through(tag(), &["red", "blue"], &["Q2Sum"]).await;
}

#[tokio::test]
async fn every_aggregate_kind_grouped_through_a_range_relationship() {
    every_aggregate_kind_through(period(), &["Q1", "Q2", "Mid"], &["RedSum"]).await;
}

#[tokio::test]
async fn grouping_by_two_bridges_or_a_bridge_and_a_fact_column() {
    let e = engine();
    let got = ask(&e, &["Total", "MedianAmount"], &[tag(), period()]).await;
    for (k, total, median) in [
        ("red|Q1", 10.0, 10.0),
        ("red|Q2", 5.0, 5.0),
        ("red|Mid", 5.0, 5.0),
        ("blue|Q1", 10.0, 10.0),
        ("blue|Q2", 25.0, 12.5),
        ("blue|Mid", 25.0, 12.5),
    ] {
        check(
            &got,
            k,
            "Total",
            Some(total),
            "by Tags[tag], Periods[label]",
        );
        check(
            &got,
            k,
            "MedianAmount",
            Some(median),
            "by Tags[tag], Periods[label]",
        );
    }
    // The two stages alone over both axes.
    let got = ask(&e, &["Total"], &[tag(), period()]).await;
    check(
        &got,
        "blue|Q2",
        "Total",
        Some(25.0),
        "two stages by two bridges",
    );
    // A fact column and a bridge.
    let got = ask(&e, &["Total", "Customers"], &[cat(), tag()]).await;
    for (k, total, customers) in [
        ("A|red", 10.0, 1.0),
        ("B|red", 5.0, 1.0),
        ("A|blue", 30.0, 1.0),
        ("B|blue", 5.0, 1.0),
    ] {
        check(&got, k, "Total", Some(total), "by Sales[cat], Tags[tag]");
        check(
            &got,
            k,
            "Customers",
            Some(customers),
            "by Sales[cat], Tags[tag]",
        );
    }
}

#[tokio::test]
async fn what_grouping_through_a_bridge_cannot_answer_is_refused_not_guessed() {
    let e = engine();
    // A KEEP on the bridge the axis groups by must test the group's own row.
    let err = try_ask(&e, &["RedSum"], &[tag()]).await.unwrap_err();
    assert!(err.contains("same table"), "{err}");
}

// ------------------------------------------- wave 3 (lane engfix) fix-ups

/// Sales <-> Product declared ONE-TO-MANY from Product (`Product[id]` ->
/// `Sales[prod_id]`): the same star as the default many-to-one, written from
/// the dimension. The Model Editor authors this shape.
fn one_to_many_from_product(propagation: FilterPropagation) -> Relationship {
    Relationship::new(
        "Product_Sales",
        "Product",
        "id",
        "Sales",
        "prod_id",
        Cardinality::OneToMany,
    )
    .with_propagation(propagation)
}

fn share_of_products() -> Measure {
    expression_measure(
        "ShareOfProducts",
        parse_measure("DIVIDE(SUM(Sales[amount]), SUM(Sales[amount], CLEAR(Product)))").unwrap(),
    )
}

fn product_names() -> Measure {
    expression_measure(
        "ProductNames",
        parse_measure("DISTINCTCOUNT(Product[name])").unwrap(),
    )
}

/// A one-to-many relationship declared from its ONE side is an ordinary
/// many-to-one from the fact: grouped by the dimension it is a direct join,
/// with its KEEPs, percent-of-parent clears and BLANK-group suppression. The
/// direction-blind routing sent it to the pre-aggregation, which refuses a
/// KEEP on its axis table and a percent-of-parent clear (wave 1 verifier).
#[tokio::test]
async fn a_one_to_many_declared_from_the_dimension_is_an_ordinary_star() {
    let e = engine_for(model_with_product_relationship(
        vec![share_of_products()],
        one_to_many_from_product(FilterPropagation::Auto),
    ));
    let names = ["Total", "BikesSum", "ShareOfProducts"];
    let got = ask(&e, &names, &[product()]).await;
    for (k, m, want) in [
        ("Bikes", "Total", Some(15.0)),
        ("Helmets", "Total", Some(20.0)),
        ("Locks", "Total", Some(90.0)),
        ("Bikes", "BikesSum", Some(15.0)),
        ("Helmets", "BikesSum", None),
        ("Locks", "BikesSum", None),
        ("Bikes", "ShareOfProducts", Some(0.12)),
        ("Locks", "ShareOfProducts", Some(0.72)),
    ] {
        check(&got, k, m, want, "single fact by Product[name], one-to-many");
    }
    // Alone, a KEEP's BLANK groups are dropped (the main route's HAVING).
    let got = ask(&e, &["BikesSum"], &[product()]).await;
    assert_eq!(got.len(), 1, "only Bikes answers: {got:?}");
    check(&got, "Bikes", "BikesSum", Some(15.0), "BikesSum alone");
    // The multi-fact route, beside a Budget measure.
    let got = ask(&e, &["Total", "BikesSum", "Budget"], &[product()]).await;
    for (k, m, want) in [
        ("Bikes", "Total", Some(15.0)),
        ("Bikes", "BikesSum", Some(15.0)),
        ("Locks", "BikesSum", None),
        ("Bikes", "Budget", Some(100.0)),
        ("Locks", "Budget", Some(300.0)),
    ] {
        check(&got, k, m, want, "multi-fact by Product[name], one-to-many");
    }
}

/// A measure on the ONE side grouped by a column of the MANY side
/// (COUNTROWS(Product) by Sales[cat]). It was INNER JOINed and counted
/// product x sale pairs (A 2, B 3). DAX follows the relationship's cross
/// filter direction: a single-direction relationship filters from the one
/// side to the many side only, so every group repeats the ungrouped value
/// (3); with Both, a group keeps the products SOME of its sales relate to,
/// each once (A: Bikes, Helmets; B: Locks, Bikes).
#[tokio::test]
async fn a_group_on_the_many_side_follows_the_cross_filter_direction() {
    for (label, model, want_a, want_b) in [
        (
            "many-to-one, single direction",
            model_with(vec![product_names()]),
            3.0,
            3.0,
        ),
        (
            "one-to-many from Product, single direction",
            model_with_product_relationship(
                vec![product_names()],
                one_to_many_from_product(FilterPropagation::Auto),
            ),
            3.0,
            3.0,
        ),
        (
            "many-to-one, both directions",
            model_with_product_relationship(
                vec![product_names()],
                Relationship::many_to_one("Sales_Product", "Sales", "prod_id", "Product", "id")
                    .with_propagation(FilterPropagation::Both),
            ),
            2.0,
            2.0,
        ),
        (
            "one-to-many from Product, both directions",
            model_with_product_relationship(
                vec![product_names()],
                one_to_many_from_product(FilterPropagation::Both),
            ),
            2.0,
            2.0,
        ),
    ] {
        let e = engine_for(model);
        // Two stages (COUNTROWS) and the fine grain (DISTINCTCOUNT).
        for m in ["ProductCount", "ProductNames"] {
            let got = ask(&e, &[m], &[cat()]).await;
            check(&got, "A", m, Some(want_a), &format!("{m} by Sales[cat], {label}"));
            check(&got, "B", m, Some(want_b), &format!("{m} by Sales[cat], {label}"));
        }
        // The multi-fact route, beside a Sales measure.
        let got = ask(&e, &["Total", "ProductCount"], &[cat()]).await;
        check(&got, "A", "Total", Some(30.0), &format!("multi-fact, {label}"));
        check(&got, "B", "Total", Some(95.0), &format!("multi-fact, {label}"));
        check(&got, "A", "ProductCount", Some(want_a), &format!("multi-fact, {label}"));
        check(&got, "B", "ProductCount", Some(want_b), &format!("multi-fact, {label}"));
    }
}

/// Grouped through a bridge, a group whose every measure is BLANK is not a
/// row (SUMMARIZECOLUMNS; the main route's HAVING). Neither tag holds a
/// Locks sale, so LocksSum alone answers no rows on either pre-aggregation
/// route; beside Total both tags show, with a BLANK LocksSum.
#[tokio::test]
async fn a_group_through_a_bridge_where_no_measure_answers_is_not_a_row() {
    let e = engine();
    for m in ["LocksSum", "LocksMedian"] {
        let got = ask(&e, &[m], &[tag()]).await;
        assert!(got.is_empty(), "{m} alone by Tags[tag]: {got:?}");
        let got = ask(&e, &[m], &[period()]).await;
        assert!(
            !got.contains_key("Q1"),
            "{m} alone by Periods[label]: {got:?}"
        );
        let got = ask(&e, &["Total", m], &[tag()]).await;
        check(&got, "red", "Total", Some(15.0), &format!("Total beside {m}"));
        check(&got, "blue", m, None, &format!("{m} beside Total"));
    }
    // The multi-fact route's pre-aggregated group too.
    let got = ask(&e, &["LocksSum", "Budget"], &[tag()]).await;
    for (k, row) in &got {
        assert_eq!(row["LocksSum"], None, "{k}: {got:?}");
    }
}

/// A USERELATIONSHIP over a many-to-many relationship is a semi-join of the
/// measure that carries it. It was a predicate-free EXISTS in the shared
/// statement's WHERE, which filtered EVERY measure by "has a Labels row"
/// (Total beside ViaLabels read 105), while a KEEP on the table named an
/// alias the statement never joined (the query failed).
#[tokio::test]
async fn a_many_to_many_userelationship_filters_only_its_own_measure() {
    let e = engine();
    const UNGROUPED: &[(&str, f64)] = &[
        // Products 1 and 3 are hot; product 1's two hot rows count once.
        ("HotViaLabels", 105.0),
        ("ColdViaLabels", 90.0),
        // Nothing filters Labels, so the override restricts nothing (wave 4:
        // it read 105, the rows SOME Labels row relates to).
        ("ViaLabels", 125.0),
    ];
    for (m, want) in UNGROUPED {
        let got = ask(&e, &[m], &[]).await;
        check(&got, "", m, Some(*want), &format!("{m} alone"));
        let got = ask(&e, &["Total", m], &[]).await;
        check(&got, "", m, Some(*want), &format!("{m} beside Total"));
        check(&got, "", "Total", Some(125.0), &format!("Total beside {m}"));
        // The multi-fact route.
        let got = ask(&e, &["Total", m, "Budget"], &[]).await;
        check(&got, "", m, Some(*want), &format!("{m}, multi-fact"));
        check(&got, "", "Total", Some(125.0), &format!("Total beside {m}, multi-fact"));
    }
    let names = ["Total", "HotViaLabels", "ColdViaLabels", "ViaLabels"];
    let got = ask(&e, &names, &[cat()]).await;
    for (k, m, want) in [
        ("A", "Total", Some(30.0)),
        ("B", "Total", Some(95.0)),
        ("A", "HotViaLabels", Some(10.0)),
        ("B", "HotViaLabels", Some(95.0)),
        ("A", "ColdViaLabels", None),
        ("B", "ColdViaLabels", Some(90.0)),
        ("A", "ViaLabels", Some(30.0)),
        ("B", "ViaLabels", Some(95.0)),
    ] {
        check(&got, k, m, want, "grouped by Sales[cat]");
    }
    let got = ask(&e, &["Total", "HotViaLabels"], &[product()]).await;
    check(&got, "Helmets", "Total", Some(20.0), "by Product[name]");
    check(&got, "Helmets", "HotViaLabels", None, "by Product[name]");
    check(&got, "Locks", "HotViaLabels", Some(90.0), "by Product[name]");
}

// ------------------------------------------- wave 4 (lane eng4) fix-ups

fn kind() -> ColumnRef {
    ColumnRef::new("Deadlines", "kind")
}

fn grp() -> ColumnRef {
    ColumnRef::new("Product", "grp")
}

fn default_sales_product() -> Relationship {
    Relationship::many_to_one("Sales_Product", "Sales", "prod_id", "Product", "id")
}

/// A request filtered by the scalar `column = value` slicer.
fn slicer(column: &str, value: &str) -> QueryRequest {
    QueryRequest {
        filters: vec![FilterCondition::new(column, FilterOperator::Equal, value)],
        ..Default::default()
    }
}

/// A request filtered by the table-attributed IN-list slicer
/// `table[column] IN (values)`.
fn scoped_slicer(table: &str, column: &str, values: &[&str]) -> QueryRequest {
    QueryRequest {
        scoped_in_filters: vec![ScopedInFilter {
            table: Some(table.into()),
            filter: InFilter::new(column, values.iter().copied()),
            level: 1,
        }],
        ..Default::default()
    }
}

/// A range relationship declared from EITHER end is the same relationship:
/// grouping by its table, a KEEP on it and the multi-fact route answer the
/// same in both declarations. The flip of the condition was missing from
/// `Relationship::build_on_clause` (and `build_exists_clause`), which the
/// pre-aggregation's mapping and the semi-join's key table render, so a
/// range declared from the dimension (`Deadlines[due] >= Sales[day]`) grouped
/// by its table tested `Sales[day] >= Deadlines[due]`: hard read 90 and soft
/// 115 where DAX answers 35 and 10 (wave 3 verifier).
#[tokio::test]
async fn a_range_declared_from_either_end_groups_and_filters_the_same() {
    for flip in [false, true] {
        let label = if flip { "flipped" } else { "as declared" };
        let e = engine_for(model_variant(
            Vec::new(),
            default_sales_product(),
            flip,
            Vec::new(),
        ));
        // Grouped by Deadlines[kind]: soft (due 5) holds day 1 (row 1); hard
        // (due 9) days 1, 7, 8 (rows 1, 2, 4).
        let deadlines: &[(&str, &str, Option<f64>)] = &[
            ("soft", "Total", Some(10.0)),
            ("hard", "Total", Some(35.0)),
            ("soft", "Rows", Some(1.0)),
            ("hard", "Rows", Some(3.0)),
            ("soft", "MaxAmount", Some(10.0)),
            ("hard", "MaxAmount", Some(20.0)),
            ("soft", "MedianAmount", Some(10.0)),
            ("hard", "MedianAmount", Some(10.0)),
            // Customers x, x and BLANK: DISTINCTCOUNT counts BLANK.
            ("soft", "Customers", Some(1.0)),
            ("hard", "Customers", Some(2.0)),
        ];
        for (k, m, want) in deadlines {
            // Alone: the two stages, or the fine grain.
            let got = ask(&e, &[m], &[kind()]).await;
            check(&got, k, m, *want, &format!("{m} alone by Deadlines[kind], {label}"));
        }
        let names = ["Total", "Rows", "MaxAmount", "MedianAmount", "Customers"];
        let got = ask(&e, &names, &[kind()]).await;
        for (k, m, want) in deadlines {
            check(&got, k, m, *want, &format!("one statement by Deadlines[kind], {label}"));
        }
        // The decomposable ones together (the two stages).
        let got = ask(&e, &["Total", "Rows", "MaxAmount"], &[kind()]).await;
        check(&got, "hard", "Total", Some(35.0), &format!("two stages, {label}"));
        check(&got, "soft", "Rows", Some(1.0), &format!("two stages, {label}"));
        // The multi-fact route: Budget does not reach Deadlines, so its
        // total repeats on every kind.
        let got = ask(&e, &["Total", "MedianAmount", "Budget"], &[kind()]).await;
        check(&got, "soft", "Total", Some(10.0), &format!("multi-fact, {label}"));
        check(&got, "hard", "Total", Some(35.0), &format!("multi-fact, {label}"));
        check(&got, "hard", "MedianAmount", Some(10.0), &format!("multi-fact, {label}"));
        check(&got, "hard", "Budget", Some(600.0), &format!("multi-fact, {label}"));
        // Grouped by Periods[label] (two conditions).
        for m in ["Total", "Rows", "MedianAmount", "Customers", "AvgAmount"] {
            let got = ask(&e, &[m], &[period()]).await;
            for k in ["Q1", "Q2", "Mid"] {
                check(&got, k, m, by_period(m, k), &format!("{m} by Periods[label], {label}"));
            }
        }
        // A KEEP on either range table: a semi-join of its measure, alone,
        // beside Total and on the multi-fact route.
        for (m, want) in [
            ("HardSum", 35.0),
            ("SoftSum", 10.0),
            ("Q2Sum", 25.0),
            ("MidRows", 2.0),
        ] {
            let got = ask(&e, &[m], &[]).await;
            check(&got, "", m, Some(want), &format!("{m} alone, {label}"));
            let got = ask(&e, &["Total", m, "Budget"], &[]).await;
            check(&got, "", m, Some(want), &format!("{m}, multi-fact, {label}"));
            check(&got, "", "Total", Some(125.0), &format!("Total beside {m}, {label}"));
        }
        let got = ask(&e, &["Total", "HardSum", "Q2Sum"], &[cat()]).await;
        for (k, m, want) in [
            ("A", "HardSum", 30.0),
            ("B", "HardSum", 5.0),
            ("A", "Q2Sum", 20.0),
            ("B", "Q2Sum", 5.0),
        ] {
            check(&got, k, m, Some(want), &format!("by Sales[cat], {label}"));
        }
    }
}

/// A multi-fact query whose second "fact" is the filtered dimension itself
/// ([Total, ProductCount] under a Product slicer): the slicer reaches Sales
/// through the many-to-one relationship for Total, as it does with Total
/// alone. It was dropped for Total (125, by Sales[cat] A 30 / B 95) because
/// the filtered table was one of the facts (wave 3 verifier).
#[tokio::test]
async fn a_slicer_on_a_dimension_that_is_also_a_fact_still_filters_the_other_fact() {
    for (served, e) in [
        ("cached", engine()),
        (
            "connector",
            connector_engine_for(model_variant_stored(
                StorageMode::DirectQuery,
                Vec::new(),
                default_sales_product(),
                false,
                Vec::new(),
            )),
        ),
    ] {
    for (slicer_kind, filtered) in [
        ("scalar slicer", slicer("name", "Helmets")),
        ("scoped slicer", scoped_slicer("Product", "name", &["Helmets"])),
    ] {
        let label = format!("{slicer_kind}, {served}");
        let got = ask_filtered(&e, &["Total"], &[], filtered.clone()).await;
        check(&got, "", "Total", Some(20.0), &format!("Total alone, {label}"));
        let got = ask_filtered(&e, &["Total", "ProductCount"], &[], filtered.clone()).await;
        check(&got, "", "Total", Some(20.0), &format!("multi-fact, {label}"));
        check(&got, "", "ProductCount", Some(1.0), &format!("multi-fact, {label}"));
        let got =
            ask_filtered(&e, &["Total", "ProductCount", "Budget"], &[], filtered.clone()).await;
        check(&got, "", "Total", Some(20.0), &format!("three facts, {label}"));
        check(&got, "", "Budget", Some(200.0), &format!("three facts, {label}"));
        // By Sales[cat]: Helmets' one sale is in A, and B shows too, with a
        // BLANK Total and ProductCount 1 -- a filter argument on another
        // table does not shrink the group domain of Sales[cat]; only the
        // all-BLANK groups are dropped ([LIVE] Excel 16 Data Model, wave 5:
        // SUMMARIZECOLUMNS(S[cat], TREATAS({"Helmets"}, P[name]), ...)
        // answers A 20 / 1 and B BLANK / 1). Wave 6 (misc6) registers that
        // domain apart (`AxisDomains`); before, B was missing.
        let got =
            ask_filtered(&e, &["Total", "ProductCount"], &[cat()], filtered.clone()).await;
        let r = format!("by Sales[cat], {label}");
        check(&got, "A", "Total", Some(20.0), &r);
        check(&got, "A", "ProductCount", Some(1.0), &r);
        check(&got, "B", "Total", None, &r);
        check(&got, "B", "ProductCount", Some(1.0), &r);
        assert_eq!(got.len(), 2, "{r}: {got:?}");
        // A fact that does not reach the axis at all (Budget -> Product):
        // its value broadcasts onto every value of the domain.
        let got = ask_filtered(&e, &["Total", "Budget"], &[cat()], filtered.clone()).await;
        let r = format!("[Total, Budget] by Sales[cat], {label}");
        check(&got, "A", "Total", Some(20.0), &r);
        check(&got, "A", "Budget", Some(200.0), &r);
        check(&got, "B", "Total", None, &r);
        check(&got, "B", "Budget", Some(200.0), &r);
        assert_eq!(got.len(), 2, "{r}: {got:?}");
        // The axis table's OWN filter still shrinks its domain (auto-exist):
        // a Sales[cust] = "y" slicer leaves B alone (row 3).
        let mut own = filtered.clone();
        own.scoped_in_filters.push(ScopedInFilter {
            table: Some("Sales".into()),
            filter: InFilter::new("cust", ["y"]),
            level: 1,
        });
        let got = ask_filtered(&e, &["Total", "ProductCount"], &[cat()], own).await;
        let r = format!("by Sales[cat] with a Sales[cust] slicer, {label}");
        check(&got, "B", "Total", None, &r);
        check(&got, "B", "ProductCount", Some(1.0), &r);
        assert_eq!(got.len(), 1, "{r}: the own slicer keeps A out: {got:?}");
    }
    }
}

/// The group domain of an axis table is restricted by ROW-LEVEL SECURITY
/// wherever the role reaches it, even where a slicer beside the role does
/// not count (owner decision 2026-11-06, BUG-0759: a security filter never
/// widens). A role on Product (Locks only) restricts Sales to Locks' sales,
/// all in B; a Product[grp] slicer beside it must not let the category A --
/// which no permitted sale has -- back onto the axis with ProductCount 1.
/// A role on Sales itself (CustX: rows 1, 2, both A) is the axis table's own
/// filter: B stays out under a Product slicer.
#[tokio::test]
async fn the_group_domain_never_widens_past_a_security_role() {
    let roles = || {
        vec![
            SecurityRole::new("ProdLocks").with_filter("Product", "name", ComparisonOp::Equal, "Locks"),
            SecurityRole::new("CustX").with_filter("Sales", "cust", ComparisonOp::Equal, "x"),
        ]
    };
    for storage in [StorageMode::InMemory, StorageMode::DirectQuery] {
        let served = if storage == StorageMode::DirectQuery { "connector" } else { "cached" };
        let make = |active: &str| {
            let m = model_variant_stored(storage.clone(), Vec::new(), default_sales_product(), false, Vec::new())
                .with_security_roles(roles());
            let mut e = if storage == StorageMode::DirectQuery {
                connector_engine_for(m)
            } else {
                engine_for(m)
            };
            e.set_active_roles(vec![active.to_string()]);
            e
        };

        // ProdLocks + a Product[grp] = "odd" slicer (Bikes, Locks).
        let e = make("ProdLocks");
        let got =
            ask_filtered(&e, &["Total", "ProductCount"], &[cat()], scoped_slicer("Product", "grp", &["odd"]))
                .await;
        let r = format!("ProdLocks + grp slicer by Sales[cat], {served}");
        check(&got, "B", "Total", Some(90.0), &r);
        check(&got, "B", "ProductCount", Some(1.0), &r);
        assert!(!got.contains_key("A"), "{r}: the role's sales are all B, A must stay hidden: {got:?}");

        // CustX + a Product[name] = "Helmets" slicer: the role is Sales' own.
        let e = make("CustX");
        let got = ask_filtered(&e, &["Total", "ProductCount"], &[cat()], slicer("name", "Helmets")).await;
        let r = format!("CustX + Helmets by Sales[cat], {served}");
        check(&got, "A", "Total", Some(20.0), &r);
        check(&got, "A", "ProductCount", Some(1.0), &r);
        assert!(!got.contains_key("B"), "{r}: the role's rows are all A, B must stay hidden: {got:?}");
    }
}

/// A slicer on a column of the MANY side (Sales[cat]) reaches a measure on
/// the ONE side (COUNTROWS(Product)) only when the relationship cross
/// filters in BOTH directions -- the rule the group-by already follows
/// (wave 3). A single direction filters from the one side to the many side
/// only, so every product still counts (3), where the fetch's IN-propagation
/// counted the two products with a category-A sale. A KEEP on the many
/// table (a table filter, DAX's expanded table) still reaches it.
#[tokio::test]
async fn a_slicer_on_the_many_side_follows_the_cross_filter_direction() {
    let model = |storage: StorageMode, rel: Relationship| {
        model_variant_stored(storage, vec![product_names()], rel, false, Vec::new())
    };
    let cases = |storage: StorageMode| {
        [
            (
                "many-to-one, single direction",
                model(storage.clone(), default_sales_product()),
                false,
            ),
            (
                "one-to-many from Product, single direction",
                model(storage.clone(), one_to_many_from_product(FilterPropagation::Auto)),
                false,
            ),
            (
                "many-to-one, both directions",
                model(
                    storage,
                    default_sales_product().with_propagation(FilterPropagation::Both),
                ),
                true,
            ),
        ]
    };
    let mut engines: Vec<(String, Engine, bool)> = Vec::new();
    for (label, m, both) in cases(StorageMode::InMemory) {
        engines.push((format!("{label}, cached"), engine_for(m), both));
    }
    for (label, m, both) in cases(StorageMode::DirectQuery) {
        engines.push((format!("{label}, connector"), connector_engine_for(m), both));
    }
    for (label, e, both) in engines {
        for (how, filtered) in [
            ("scalar", slicer("cat", "A")),
            ("scoped", scoped_slicer("Sales", "cat", &["A"])),
        ] {
            let want = if both { 2.0 } else { 3.0 };
            for m in ["ProductCount", "ProductNames"] {
                let got = ask_filtered(&e, &[m], &[], filtered.clone()).await;
                check(&got, "", m, Some(want), &format!("{m}, {label}, {how}"));
            }
            let got =
                ask_filtered(&e, &["Total", "ProductCount"], &[], filtered.clone()).await;
            check(&got, "", "Total", Some(30.0), &format!("multi-fact, {label}, {how}"));
            check(&got, "", "ProductCount", Some(want), &format!("multi-fact, {label}, {how}"));
            // By Product[name]: Locks has no category-A sale.
            let got =
                ask_filtered(&e, &["Total", "ProductCount"], &[product()], filtered.clone())
                    .await;
            let route = format!("by Product[name], {label}, {how}");
            check(&got, "Bikes", "Total", Some(10.0), &route);
            check(&got, "Helmets", "ProductCount", Some(1.0), &route);
            if both {
                assert!(!got.contains_key("Locks"), "{route}: {got:?}");
            } else {
                check(&got, "Locks", "Total", None, &route);
                check(&got, "Locks", "ProductCount", Some(1.0), &route);
            }
            // A KEEP on Sales is a table filter: it reaches Product either
            // way. Category-A sales over 15: Helmets (20).
            let got = ask_filtered(&e, &["ProductsWithBigSale"], &[], filtered.clone()).await;
            check(&got, "", "ProductsWithBigSale", Some(1.0), &format!("KEEP, {label}, {how}"));
        }
    }
}

/// Inactive relationships from Sales to Product that are NOT key-safe, for a
/// USERELATIONSHIP to the GROUP BY table: an equality many-to-many on
/// `Sales[qty] = Product[id]`, a BETWEEN pair and ONE range condition, both
/// declared from Product.
fn override_relationships() -> Vec<Relationship> {
    vec![
        Relationship::with_conditions(
            "Sales_Product_Qty",
            "Sales",
            "Product",
            vec![JoinCondition::equal("qty", "id")],
            Cardinality::ManyToMany,
        )
        .with_active(false),
        Relationship::many_to_many(
            "Product_Sales_Between",
            "Product",
            "Sales",
            vec![
                JoinCondition::new("lo", "day", JoinOperator::LessThanOrEqual),
                JoinCondition::new("hi", "day", JoinOperator::GreaterThanOrEqual),
            ],
        )
        .with_active(false),
        Relationship::many_to_many(
            "Product_Sales_Hi",
            "Product",
            "Sales",
            vec![JoinCondition::new("hi", "day", JoinOperator::GreaterThanOrEqual)],
        )
        .with_active(false),
    ]
}

const OVERRIDE_MEASURES: &[(&str, &str)] = &[
    ("ViaQty", "SUM(Sales[amount], USERELATIONSHIP(\"Sales_Product_Qty\"))"),
    ("ViaBetween", "SUM(Sales[amount], USERELATIONSHIP(\"Product_Sales_Between\"))"),
    ("RowsViaBetween", "COUNTROWS(Sales, USERELATIONSHIP(\"Product_Sales_Between\"))"),
    (
        "MedianViaBetween",
        "MEDIAN(Sales[amount], USERELATIONSHIP(\"Product_Sales_Between\"))",
    ),
    (
        "BViaBetween",
        "SUM(Sales[amount], USERELATIONSHIP(\"Product_Sales_Between\"), KEEP(Sales, Sales[cat] = \"B\"))",
    ),
    ("ViaHi", "SUM(Sales[amount], USERELATIONSHIP(\"Product_Sales_Hi\"))"),
];

fn override_engine() -> Engine {
    let extra: Vec<Measure> = OVERRIDE_MEASURES
        .iter()
        .map(|(n, f)| {
            expression_measure(*n, parse_measure(f).unwrap_or_else(|e| panic!("{n}: {e}")))
        })
        .collect();
    engine_for(model_variant(
        extra,
        default_sales_product(),
        false,
        override_relationships(),
    ))
}

/// A USERELATIONSHIP to a GROUP BY table through a relationship that is not
/// key-safe: each group reads the fact rows SOME of its rows relate to
/// through the override, each once. The split route bounded every group by
/// the MAX / MIN of each condition's key, which is right for ONE range
/// condition only: the odd products (Bikes 0-5, Locks 15-25) read days 0-25
/// (125, DAX 100) and the qty-keyed odd group read only qty 3 (40, DAX 50).
/// A KEEP on the measure's own table was dropped (BViaBetween read 100).
#[tokio::test]
async fn a_userelationship_to_a_group_by_table_reads_every_key_of_the_group() {
    let e = override_engine();
    // odd = Bikes (id 1, days 0-5, hi 5) and Locks (id 3, days 15-25, hi
    // 25); even = Helmets (id 2, days 6-10, hi 10).
    let want: &[(&str, &str, Option<f64>)] = &[
        // qty 1 (row 1) and qty 3 (row 3); no sale has qty 2.
        ("odd", "ViaQty", Some(50.0)),
        ("even", "ViaQty", None),
        // Days 1, 20, 21 / days 7, 8.
        ("odd", "ViaBetween", Some(100.0)),
        ("even", "ViaBetween", Some(25.0)),
        ("odd", "RowsViaBetween", Some(3.0)),
        ("even", "RowsViaBetween", Some(2.0)),
        ("odd", "MedianViaBetween", Some(40.0)),
        ("even", "MedianViaBetween", Some(12.5)),
        ("odd", "BViaBetween", Some(90.0)),
        ("even", "BViaBetween", Some(5.0)),
        // A day at most 5 or at most 25: every row / days 1, 7, 8.
        ("odd", "ViaHi", Some(125.0)),
        ("even", "ViaHi", Some(35.0)),
    ];
    for (k, m, w) in want {
        let got = ask(&e, &["Total", m], &[grp()]).await;
        check(&got, k, m, *w, &format!("{m} beside Total by Product[grp]"));
        let total = if *k == "odd" { 105.0 } else { 20.0 };
        check(&got, k, "Total", Some(total), &format!("Total beside {m}"));
    }
    let names: Vec<&str> = std::iter::once("Total")
        .chain(OVERRIDE_MEASURES.iter().map(|(n, _)| *n))
        .collect();
    let got = ask(&e, &names, &[grp()]).await;
    for (k, m, w) in want {
        check(&got, k, m, *w, "all in one request by Product[grp]");
    }
    // One key per group: by Product[name].
    let got = ask(&e, &["Total", "ViaQty", "ViaHi"], &[product()]).await;
    for (k, m, w) in [
        ("Bikes", "ViaQty", Some(10.0)),
        ("Helmets", "ViaQty", None),
        ("Locks", "ViaQty", Some(40.0)),
        ("Bikes", "ViaHi", Some(10.0)),
        ("Helmets", "ViaHi", Some(35.0)),
        ("Locks", "ViaHi", Some(125.0)),
    ] {
        check(&got, k, m, w, "by Product[name]");
    }
}

/// USERELATIONSHIP only CHOOSES the relationship a filter travels; with
/// nothing filtering the other table it restricts nothing (DAX propagates a
/// filter from a filtered table only). ViaLabels with no Labels filter is
/// the plain total (125, A 30 / B 95); it read 105, the rows SOME Labels row
/// relates to. A slicer on Labels reaches Sales through the override only,
/// so the plain Total ignores it.
#[tokio::test]
async fn a_userelationship_with_nothing_filtering_its_table_restricts_nothing() {
    let e = engine();
    let got = ask(&e, &["ViaLabels"], &[]).await;
    check(&got, "", "ViaLabels", Some(125.0), "ViaLabels alone");
    let got = ask(&e, &["Total", "ViaLabels", "Budget"], &[]).await;
    check(&got, "", "ViaLabels", Some(125.0), "ViaLabels, multi-fact");
    let got = ask(&e, &["Total", "ViaLabels"], &[cat()]).await;
    check(&got, "A", "ViaLabels", Some(30.0), "by Sales[cat]");
    check(&got, "B", "ViaLabels", Some(95.0), "by Sales[cat]");
    // An override over an UNSAFE relationship, ungrouped: no Product filter.
    let e2 = override_engine();
    for m in ["ViaQty", "ViaBetween", "ViaHi"] {
        let got = ask(&e2, &["Total", m], &[]).await;
        check(&got, "", m, Some(125.0), &format!("{m} ungrouped"));
    }
    // Products 1 and 3 are hot; product 3 alone is cold.
    for (value, want) in [("cold", 90.0), ("hot", 105.0)] {
        let got = ask_filtered(
            &e,
            &["Total", "ViaLabels"],
            &[],
            scoped_slicer("Labels", "label", &[value]),
        )
        .await;
        let route = format!("under Labels = {value}");
        check(&got, "", "ViaLabels", Some(want), &route);
        check(&got, "", "Total", Some(125.0), &route);
    }
    // Served by a connector: the same answers.
    let e = connector_engine_for(model_variant_stored(
        StorageMode::DirectQuery,
        Vec::new(),
        default_sales_product(),
        false,
        Vec::new(),
    ));
    let got = ask(&e, &["Total", "ViaLabels"], &[]).await;
    check(&got, "", "ViaLabels", Some(125.0), "ViaLabels, connector");
    let got = ask_filtered(
        &e,
        &["Total", "ViaLabels"],
        &[],
        scoped_slicer("Labels", "label", &["cold"]),
    )
    .await;
    check(&got, "", "ViaLabels", Some(90.0), "under Labels = cold, connector");
    check(&got, "", "Total", Some(125.0), "under Labels = cold, connector");
}

// ---- wave 5 (lane eng5): row-level security never follows the
// cross-filter direction ----

/// The fixture under the given security roles, cached or connector-served.
fn role_engine(storage: StorageMode, rel: Relationship, roles: &[&str]) -> Engine {
    let m = model_variant_stored(storage.clone(), vec![product_names()], rel, false, Vec::new())
        .with_security_roles(vec![
            // Sales rows 1, 2 -> products 1 (Bikes), 2 (Helmets).
            SecurityRole::new("CatA").with_filter("Sales", "cat", ComparisonOp::Equal, "A"),
            // Sales rows 3, 4, 5 -> products 3 (Locks), 1 (Bikes).
            SecurityRole::new("CatB").with_filter("Sales", "cat", ComparisonOp::Equal, "B"),
            // Sales rows 1, 2 -> products 1, 2.
            SecurityRole::new("CustX").with_filter("Sales", "cust", ComparisonOp::Equal, "x"),
            // Sales rows 1, 4 -> product 1.
            SecurityRole::new("Prod1").with_filter("Sales", "prod_id", ComparisonOp::Equal, "1"),
        ]);
    let mut e = if storage == StorageMode::DirectQuery {
        connector_engine_for(m)
    } else {
        engine_for(m)
    };
    e.set_active_roles(roles.iter().map(|r| r.to_string()).collect());
    e
}

/// A role filter is SEALED SECURITY, not a slicer: it restricts every table
/// it reaches through a key-safe relationship, in EITHER direction, so a role
/// on the many side (Sales[cat] = "A") restricts a measure on the one side
/// (COUNTROWS(Product)) even across a single-direction relationship. Owner
/// decision 2026-11-06 (BUG-0759, "RLS stays strict"): a security filter
/// never WIDENS what a role sees -- a deliberate difference from Power BI,
/// whose single-direction RLS would count all three products. Wave 4 made the
/// fetch's key propagation follow the cross-filter direction for slicers,
/// and the same propagation carried the role predicates: under CatA,
/// COUNTROWS(Product) widened from 2 to 3 (wave 4 verifier), while the
/// planner's `rls_relevance` still counted on the propagation. An ordinary
/// slicer on the same column keeps following the direction (3).
#[tokio::test]
async fn a_role_filter_on_the_many_side_restricts_the_one_side_in_every_direction() {
    let rels = || {
        [
            ("many-to-one, single direction", default_sales_product(), false),
            (
                "one-to-many from Product, single direction",
                one_to_many_from_product(FilterPropagation::Auto),
                false,
            ),
            (
                "many-to-one, both directions",
                default_sales_product().with_propagation(FilterPropagation::Both),
                true,
            ),
        ]
    };
    for storage in [StorageMode::InMemory, StorageMode::DirectQuery] {
        let served = if storage == StorageMode::DirectQuery { "connector" } else { "cached" };
        for (label, rel, both) in rels() {
            let route = |what: &str| format!("{what}, {label}, {served}");

            // ---- CatA: Sales rows 1, 2 -> Bikes, Helmets ----
            let e = role_engine(storage.clone(), rel.clone(), &["CatA"]);
            for m in ["ProductCount", "ProductNames"] {
                let got = ask(&e, &[m], &[]).await;
                check(&got, "", m, Some(2.0), &route(&format!("{m} alone under CatA")));
            }
            let got = ask(&e, &["Total", "ProductCount"], &[]).await;
            check(&got, "", "Total", Some(30.0), &route("multi-fact under CatA"));
            check(&got, "", "ProductCount", Some(2.0), &route("multi-fact under CatA"));
            // By Product[name]: Locks is hidden by the role.
            let got = ask(&e, &["Total", "ProductCount"], &[product()]).await;
            check(&got, "Bikes", "ProductCount", Some(1.0), &route("by Product[name] under CatA"));
            check(&got, "Helmets", "Total", Some(20.0), &route("by Product[name] under CatA"));
            assert!(
                !got.contains_key("Locks"),
                "{}: the role hides Locks: {got:?}",
                route("by Product[name] under CatA")
            );
            // By Sales[cat]: the role hides B; the one-side count is the
            // role's two products.
            for measures in [&["ProductCount"][..], &["Total", "ProductCount"][..]] {
                let got = ask(&e, measures, &[cat()]).await;
                let r = route(&format!("{measures:?} by Sales[cat] under CatA"));
                check(&got, "A", "ProductCount", Some(2.0), &r);
                assert!(!got.contains_key("B"), "{r}: the role hides B: {got:?}");
            }

            // ---- CatB with a Sales[cust] = y slicer: the role restricts
            // Product to its sales' products (Locks, Bikes); the slicer
            // (row 3, Locks) reaches Product only under Both ----
            let e = role_engine(storage.clone(), rel.clone(), &["CatB"]);
            let filtered = scoped_slicer("Sales", "cust", &["y"]);
            let want = if both { 1.0 } else { 2.0 };
            let got = ask_filtered(&e, &["ProductCount"], &[], filtered.clone()).await;
            check(&got, "", "ProductCount", Some(want), &route("CatB + cust slicer"));
            let got = ask_filtered(&e, &["Total", "ProductCount"], &[], filtered.clone()).await;
            check(&got, "", "Total", Some(40.0), &route("multi-fact, CatB + cust slicer"));
            check(&got, "", "ProductCount", Some(want), &route("multi-fact, CatB + cust slicer"));

            // ---- Two roles, a union on Sales: CustX (rows 1, 2) or Prod1
            // (rows 1, 4) -> Bikes, Helmets ----
            let e = role_engine(storage.clone(), rel.clone(), &["CustX", "Prod1"]);
            let got = ask(&e, &["ProductCount"], &[]).await;
            check(&got, "", "ProductCount", Some(2.0), &route("role union"));
            let got = ask(&e, &["Total", "ProductCount"], &[]).await;
            check(&got, "", "Total", Some(35.0), &route("multi-fact, role union"));
            check(&got, "", "ProductCount", Some(2.0), &route("multi-fact, role union"));

            // ---- No role: the same column as a SLICER follows the
            // cross-filter direction ----
            let e = role_engine(storage.clone(), rel.clone(), &[]);
            let got = ask_filtered(&e, &["ProductCount"], &[], slicer("cat", "A")).await;
            let want = if both { 2.0 } else { 3.0 };
            check(&got, "", "ProductCount", Some(want), &route("Sales[cat] slicer, no role"));
        }
    }
}

/// A measure group with no row at all keeps its columns, so the groups can
/// still be combined: by Product[name] under a Sales[cust] slicer no sale
/// matches, so `[Total]` has no group, and DAX shows every product with a
/// BLANK Total beside COUNTROWS(Product) = 1 (the slicer does not reach
/// Product across the single-direction relationship). The empty group was
/// registered with no schema, so the join on its `name` failed.
#[tokio::test]
async fn an_empty_measure_group_keeps_its_columns() {
    for (served, e) in [
        ("cached", engine()),
        (
            "connector",
            connector_engine_for(model_variant_stored(
                StorageMode::DirectQuery,
                Vec::new(),
                default_sales_product(),
                false,
                Vec::new(),
            )),
        ),
    ] {
        let got = ask_filtered(
            &e,
            &["Total", "ProductCount"],
            &[product()],
            scoped_slicer("Sales", "cust", &["nobody"]),
        )
        .await;
        let r = format!("by Product[name] under an empty Sales slicer, {served}");
        for name in ["Bikes", "Helmets", "Locks"] {
            check(&got, name, "Total", None, &r);
            check(&got, name, "ProductCount", Some(1.0), &r);
        }
        assert_eq!(got.len(), 3, "{r}: {got:?}");
    }
}
