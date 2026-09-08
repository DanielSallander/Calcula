//! FILENAME: app/src-tauri/src/insights/strategy/calibration_tests.rs
// PURPOSE: Measure how role inference behaves across STRUCTURALLY DIFFERENT
// models, so "is it promoting too many columns to analysis" is a number rather
// than an argument about one screenshot.
// CONTEXT: A reviewer looked at one example model, saw a lot of `analysis`
// columns, and asked whether inference is miscalibrated. That could not be
// answered: one fixture exercises code paths, it does not tell you whether a
// heuristic is calibrated — the fixture might simply be name-heavy.
//
// So this file builds six models chosen to be different from each other in the
// ways that matter to the role ladder, runs the real `infer` over each, and
// prints the role distribution. Two things come out of it:
//
//   1. A TABLE somebody can read, printed on every run (`--nocapture`) and
//      folded into the failure message so it is visible when it matters most.
//   2. BOUNDS. The design target is roughly one to four `analysis` columns per
//      dimension, with the wide dimensions putting most of their columns in
//      `ignore`. A model that blows through that is a calibration failure and
//      names itself.
//
// THE BOUNDS ARE DELIBERATELY LOOSE, and only on the aggregate shape. A tight
// per-model assertion over a heuristic is a test that fails every time somebody
// improves the heuristic, which is how a calibration guard becomes a thing
// people delete. What must not happen silently is a drift from "a handful of
// axes per dimension" to "everything is an axis" — that is what these catch.
//
// AND IT IS THE HARNESS FOR NEXT TIME. When per-column distinct counts land
// (docs/design/open-items.md §2.AI.6), the thresholds get retuned, and this is
// where the before/after is read off.

use std::collections::BTreeMap;

use bi_engine::{
    sum_measure, Column, DataModel, DataType, DateRole, Measure, Relationship, Table,
};

use super::facts::facts_from_model;
use super::infer::infer;
use super::types::{Role, TableKind};
use crate::insights::usage::UsageIndex;

/// The design target: a dimension offers a handful of axes, not all of them.
const MAX_ANALYSIS_PER_DIMENSION: usize = 4;

/// Above this many columns a dimension is "wide", and a wide one that promotes
/// most of its columns is the failure this file exists to catch. Below it the
/// share is meaningless — a three-column dimension promoting one is 33%.
const WIDE_DIMENSION_COLUMNS: usize = 8;

/// A wide dimension must leave at least this share of its columns out of
/// `analysis`. Not "most land in ignore": `key`, `label` and `filter` are also
/// perfectly good non-axis answers, and counting only `ignore` would punish a
/// ladder for classifying precisely.
const WIDE_DIMENSION_MIN_NON_ANALYSIS_SHARE: f64 = 0.6;

fn t(name: &str, columns: Vec<Column>) -> Table {
    Table::new(name, columns).expect("the fixture table builds")
}

/// Sales, with a key per dimension the caller wires up.
fn sales_table() -> Table {
    t(
        "Sales",
        vec![
            Column::new("Amount", DataType::Float64),
            Column::new("Cost", DataType::Float64),
            Column::new("Qty", DataType::Int64),
            Column::new("CustomerKey", DataType::Int64),
            Column::new("ProductKey", DataType::Int64),
            Column::new("FlagKey", DataType::Int64),
            Column::new("DeptKey", DataType::Int64),
            Column::new("Date", DataType::Date),
        ],
    )
}

fn rel(name: &str, from_col: &str, to_table: &str, to_col: &str) -> Relationship {
    Relationship::many_to_one(name, "Sales", from_col, to_table, to_col)
}

/// The six shapes, each named for what it is meant to stress.
fn fixtures() -> Vec<(&'static str, DataModel)> {
    let measures = || {
        vec![
            sum_measure("Revenue", "Sales", "Amount"),
            sum_measure("Cost", "Sales", "Cost"),
            sum_measure("Quantity", "Sales", "Qty"),
        ]
    };

    let build = |tables: Vec<Table>, rels: Vec<Relationship>, ms: Vec<Measure>, date: bool| {
        let mut b = DataModel::builder();
        for table in tables {
            b = b.add_table(table);
        }
        for r in rels {
            b = b.add_relationship(r);
        }
        for m in ms {
            b = b.add_measure(m);
        }
        if date {
            b = b.mark_date_table("Calendar");
        }
        b.build().expect("the fixture model builds")
    };

    // 1. WIDE AND LABEL-HEAVY. The reviewer's worry: a customer dimension whose
    //    columns are mostly names, addresses and contact details. Only a few of
    //    them are axes anybody would group by.
    let wide = build(
        vec![
            sales_table(),
            t(
                "Customer",
                vec![
                    Column::new("CustomerKey", DataType::Int64),
                    Column::new("FullName", DataType::String),
                    Column::new("Email", DataType::String),
                    Column::new("Phone", DataType::String),
                    Column::new("AddressLine1", DataType::String),
                    Column::new("AddressLine2", DataType::String),
                    Column::new("PostCode", DataType::String),
                    Column::new("City", DataType::String),
                    Column::new("Country", DataType::String),
                    Column::new("Segment", DataType::String),
                    Column::new("created_at", DataType::Date),
                ],
            ),
        ],
        vec![rel("Sales_Customer", "CustomerKey", "Customer", "CustomerKey")],
        measures(),
        false,
    );

    // 2. NARROW. Three columns, one of which is the key. There is barely a
    //    decision to make, and the ladder must not invent one.
    let narrow = build(
        vec![
            sales_table(),
            t(
                "Product",
                vec![
                    Column::new("ProductKey", DataType::Int64),
                    Column::new("Category", DataType::String),
                    Column::new("ProductName", DataType::String),
                ],
            ),
        ],
        vec![rel("Sales_Product", "ProductKey", "Product", "ProductKey")],
        measures(),
        false,
    );

    // 3. A CALENDAR. Every non-key column is a calendar attribute by
    //    construction, so this one is EXPECTED to promote several — it is the
    //    case where a high analysis count is correct, and it is here so the
    //    bounds cannot be tuned by punishing it.
    let calendar = build(
        vec![
            sales_table(),
            t(
                "Calendar",
                vec![
                    Column::new("Date", DataType::Date).with_date_role(DateRole::DateKey),
                    Column::new("Year", DataType::Int32).with_date_role(DateRole::Year),
                    Column::new("Quarter", DataType::Int32).with_date_role(DateRole::Quarter),
                    Column::new("MonthNumber", DataType::Int32),
                    Column::new("MonthName", DataType::String).with_sort_by("MonthNumber"),
                    Column::new("etl_loaded_at", DataType::Date),
                ],
            ),
        ],
        vec![rel("Sales_Calendar", "Date", "Calendar", "Date")],
        measures(),
        true,
    );

    // 4. A JUNK DIMENSION: a key plus a handful of booleans. Flags are filters,
    //    not axes, and a ladder that reads them as axes offers a breakdown by
    //    "IsActive" on every measure.
    let junk = build(
        vec![
            sales_table(),
            t(
                "Flags",
                vec![
                    Column::new("FlagKey", DataType::Int64),
                    Column::new("IsActive", DataType::Boolean),
                    Column::new("IsReturned", DataType::Boolean),
                    Column::new("IsDiscounted", DataType::Boolean),
                    Column::new("IsGift", DataType::Boolean),
                ],
            ),
        ],
        vec![rel("Sales_Flags", "FlagKey", "Flags", "FlagKey")],
        measures(),
        false,
    );

    // 5. DEGENERATE: a dimension that is nothing but its key. There is no axis
    //    here at all and the honest answer is zero.
    let degenerate = build(
        vec![
            sales_table(),
            t("Dept", vec![Column::new("DeptKey", DataType::Int64)]),
        ],
        vec![rel("Sales_Dept", "DeptKey", "Dept", "DeptKey")],
        measures(),
        false,
    );

    // 6. A FACT TABLE WITH SEVERAL MEASURES AND NO DIMENSION. Its own numeric
    //    columns must not become axes — they are what the measures aggregate.
    let fact_only = build(vec![sales_table()], vec![], measures(), false);

    vec![
        ("wide label-heavy dimension", wide),
        ("narrow dimension", narrow),
        ("calendar", calendar),
        ("junk dimension (flags)", junk),
        ("degenerate dimension (key only)", degenerate),
        ("fact table, no dimension", fact_only),
    ]
}

/// One table's role tally, in a fixed order so two runs diff cleanly.
#[derive(Default)]
struct Tally {
    kind: Option<TableKind>,
    counts: BTreeMap<String, usize>,
    total: usize,
}

fn role_key(role: Role) -> &'static str {
    match role {
        Role::Analysis => "analysis",
        Role::Hierarchy => "hierarchy",
        Role::Filter => "filter",
        Role::Label => "label",
        Role::Key => "key",
        Role::Ignore => "ignore",
    }
}

const ROLE_ORDER: [&str; 6] = ["analysis", "hierarchy", "filter", "label", "key", "ignore"];

fn tally(model: &DataModel) -> BTreeMap<String, Tally> {
    let facts = facts_from_model(model);
    let doc = infer(&facts, model, &UsageIndex::default());
    let mut out: BTreeMap<String, Tally> = BTreeMap::new();
    for (table, ts) in &doc.tables {
        let entry = out.entry(table.clone()).or_default();
        entry.kind = ts.kind;
        for cs in ts.columns.values() {
            *entry.counts.entry(role_key(cs.role).to_string()).or_insert(0) += 1;
            entry.total += 1;
        }
    }
    out
}

fn render() -> (String, Vec<String>) {
    let mut table = String::new();
    let mut failures: Vec<String> = Vec::new();
    table.push_str(&format!(
        "\n{:<32} {:<26} {:>5} {:>9} {:>10} {:>7} {:>6} {:>5} {:>7}\n",
        "model", "table (kind)", "cols", "analysis", "hierarchy", "filter", "label", "key", "ignore"
    ));
    table.push_str(&"-".repeat(118));
    table.push('\n');

    for (name, model) in fixtures() {
        for (table_name, t) in tally(&model) {
            let get = |k: &str| *t.counts.get(k).unwrap_or(&0);
            let kind = t
                .kind
                .map(|k| format!("{k:?}").to_lowercase())
                .unwrap_or_else(|| "-".into());
            table.push_str(&format!(
                "{:<32} {:<26} {:>5} {:>9} {:>10} {:>7} {:>6} {:>5} {:>7}\n",
                name,
                format!("{table_name} ({kind})"),
                t.total,
                get("analysis"),
                get("hierarchy"),
                get("filter"),
                get("label"),
                get("key"),
                get("ignore"),
            ));

            // The calendar is exempt from the ceiling BY DESIGN: every non-key
            // column of a marked date table is a calendar attribute, so a high
            // count there is the ladder working, not failing.
            let is_calendar = t.kind == Some(TableKind::Calendar);
            let is_dimension = matches!(t.kind, Some(TableKind::Dimension));
            let analysis = get("analysis");

            if is_dimension && analysis > MAX_ANALYSIS_PER_DIMENSION {
                failures.push(format!(
                    "{name} / {table_name}: {analysis} analysis columns, over the design ceiling \
                     of {MAX_ANALYSIS_PER_DIMENSION}"
                ));
            }
            if is_dimension && !is_calendar && t.total >= WIDE_DIMENSION_COLUMNS {
                let non_analysis = (t.total - analysis) as f64 / t.total as f64;
                if non_analysis < WIDE_DIMENSION_MIN_NON_ANALYSIS_SHARE {
                    failures.push(format!(
                        "{name} / {table_name}: only {:.0}% of {} columns stayed out of analysis, \
                         under the {:.0}% a wide dimension should",
                        non_analysis * 100.0,
                        t.total,
                        WIDE_DIMENSION_MIN_NON_ANALYSIS_SHARE * 100.0
                    ));
                }
            }
        }
    }
    (table, failures)
}

#[test]
fn role_inference_stays_inside_its_design_target_across_differently_shaped_models() {
    let (table, failures) = render();
    println!("{table}");
    assert!(
        failures.is_empty(),
        "role inference is outside its design target on {} table(s):\n  {}\n{}",
        failures.len(),
        failures.join("\n  "),
        table
    );
}

#[test]
fn a_junk_dimensions_flags_are_filters_and_never_axes() {
    // The single clearest miscalibration to watch for: a boolean is a filter.
    // Reading four flags as four axes offers "revenue by IsGift" on every
    // measure, which is the kind of true-and-useless breakdown the whole role
    // ladder exists to suppress.
    let model = fixtures().into_iter().find(|(n, _)| n.starts_with("junk")).unwrap().1;
    let t = tally(&model);
    let flags = &t["Flags"];
    assert_eq!(flags.counts.get("analysis"), None, "{:?}", flags.counts);
    assert_eq!(flags.counts.get("filter"), Some(&4), "{:?}", flags.counts);
}

#[test]
fn a_degenerate_dimension_offers_no_axis_at_all() {
    // Zero is the honest answer, and a ladder that reaches for one anyway would
    // offer a breakdown by a surrogate key.
    let model = fixtures().into_iter().find(|(n, _)| n.starts_with("degenerate")).unwrap().1;
    let t = tally(&model);
    assert_eq!(t["Dept"].counts.get("analysis"), None, "{:?}", t["Dept"].counts);
}

#[test]
fn a_fact_tables_own_numeric_columns_are_never_axes() {
    // `Amount`, `Cost` and `Qty` are what the measures aggregate. Promoting one
    // would offer "revenue broken down by amount".
    //
    // Read against the NARROW model, not the relationship-free one: a table
    // with no relationships is classified `Other`, not `Fact`, because the
    // classifier reads the relationship graph and a lone table has no from-side.
    // That is correct, and asserting `Fact` there was my own wrong premise.
    let model = fixtures().into_iter().find(|(n, _)| n.starts_with("narrow")).unwrap().1;
    let t = tally(&model);
    let sales = &t["Sales"];
    assert_eq!(sales.kind, Some(TableKind::Fact));
    assert_eq!(sales.counts.get("analysis"), None, "{:?}", sales.counts);

    // ...and the same holds for a table nothing joins to, which is merely
    // classified differently.
    let lone = fixtures().into_iter().find(|(n, _)| n.starts_with("fact table")).unwrap().1;
    let lone_sales = &tally(&lone)["Sales"];
    assert_eq!(lone_sales.kind, Some(TableKind::Other));
    assert_eq!(lone_sales.counts.get("analysis"), None, "{:?}", lone_sales.counts);
}

#[test]
fn the_calibration_table_is_printable_without_running_the_assertions() {
    // The reviewer asked for a TABLE, not a verdict. Rendering must not depend
    // on the bounds passing, or the number nobody can see is the one they
    // needed when it went out of range.
    let (table, _) = render();
    assert!(table.contains("analysis"), "{table}");
    assert!(table.lines().count() > 8, "every fixture contributes a row:\n{table}");
}
