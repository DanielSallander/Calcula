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

    // 7-10. THE SAME CUSTOMER DIMENSION IN FOUR NAMING CONVENTIONS.
    //
    // Fixtures 1-6 are all PascalCase, which is one convention out of several
    // and happens to be the one `words()` splits perfectly. A name lexicon
    // generalises exactly as far as its naming conventions do, so a harness that
    // samples one convention is passing its own exam: `words("emailaddress")` is
    // a single token, so the `email` entry never matches, while `postalcode`
    // looked fine only because it is in the joined list verbatim.
    //
    // The four below are the conventions real imported schemas actually use.
    // They are deliberately the SAME dimension each time — a customer with a
    // name, contact details, an address and three genuine axes — so the only
    // thing that varies between their rows in the table is the spelling.

    // 7. CONCATENATED LOWERCASE. No separator and no case change anywhere, so
    //    `words()` cannot split a single one of these names.
    let concatenated = build(
        vec![
            sales_table(),
            t(
                "Customer",
                vec![
                    Column::new("customerkey", DataType::Int64),
                    Column::new("fullname", DataType::String),
                    Column::new("emailaddress", DataType::String),
                    Column::new("phonenumber", DataType::String),
                    Column::new("addressline1", DataType::String),
                    Column::new("postalcode", DataType::String),
                    Column::new("stateprovince", DataType::String),
                    Column::new("city", DataType::String),
                    Column::new("country", DataType::String),
                    Column::new("segment", DataType::String),
                    Column::new("createdat", DataType::Date),
                ],
            ),
        ],
        vec![rel("Sales_Customer", "CustomerKey", "Customer", "customerkey")],
        measures(),
        false,
    );

    // 8. SNAKE_CASE. `words()` splits it cleanly, so this one is the CONTROL:
    //    it shows how much of the gap is the lexicon and how much is the
    //    splitter.
    let snake = build(
        vec![
            sales_table(),
            t(
                "Customer",
                vec![
                    Column::new("customer_key", DataType::Int64),
                    Column::new("full_name", DataType::String),
                    Column::new("email_address", DataType::String),
                    Column::new("phone_number", DataType::String),
                    Column::new("address_line_1", DataType::String),
                    Column::new("postal_code", DataType::String),
                    Column::new("state_province", DataType::String),
                    Column::new("city", DataType::String),
                    Column::new("country", DataType::String),
                    Column::new("segment", DataType::String),
                ],
            ),
        ],
        vec![rel("Sales_Customer", "CustomerKey", "Customer", "customer_key")],
        measures(),
        false,
    );

    // 9. ABBREVIATIONS, the convention a warehouse built on a mainframe extract
    //    uses. This is the one the lexicon is EXPECTED to lose ground on, and it
    //    is here to be honest about that rather than to be fixed by contorting
    //    the word list: `cust_nm` is a name only to somebody who already knows.
    let abbreviated = build(
        vec![
            sales_table(),
            t(
                "Customer",
                vec![
                    Column::new("cust_key", DataType::Int64),
                    Column::new("cust_nm", DataType::String),
                    Column::new("email_addr", DataType::String),
                    Column::new("phone_no", DataType::String),
                    Column::new("addr1", DataType::String),
                    Column::new("addr2", DataType::String),
                    Column::new("city", DataType::String),
                    Column::new("ctry", DataType::String),
                    Column::new("seg", DataType::String),
                    Column::new("created_at", DataType::Date),
                    Column::new("updated_at", DataType::Date),
                ],
            ),
        ],
        vec![rel("Sales_Customer", "CustomerKey", "Customer", "cust_key")],
        measures(),
        false,
    );

    // 10. SWEDISH, concatenated the way Swedish compounds are written. A Swedish
    //     model is the normal case for this product, not an edge case, and every
    //     other lexicon in this layer is already bilingual — this one was not.
    let swedish = build(
        vec![
            sales_table(),
            t(
                "Kund",
                vec![
                    Column::new("kund_id", DataType::Int64),
                    Column::new("kundnamn", DataType::String),
                    Column::new("epostadress", DataType::String),
                    Column::new("telefonnummer", DataType::String),
                    Column::new("gatuadress", DataType::String),
                    Column::new("postnummer", DataType::String),
                    Column::new("ort", DataType::String),
                    Column::new("land", DataType::String),
                    Column::new("kundsegment", DataType::String),
                ],
            ),
        ],
        vec![rel("Sales_Kund", "CustomerKey", "Kund", "kund_id")],
        measures(),
        false,
    );

    // 11. SEVERAL NAME COLUMNS ON ONE DIMENSION. Every fixture above has exactly
    //     ONE name-ish column, which is why this harness could not see the role
    //     ladder's label arm reading only the WINNER of the label election:
    //     with one candidate there are no runners-up to misclassify. A contact
    //     dimension has four, and three of them were coming back `analysis` -
    //     "revenue by first name" is one fact per person.
    let several_names = build(
        vec![
            sales_table(),
            t(
                "Contact",
                vec![
                    Column::new("ContactKey", DataType::Int64),
                    Column::new("FirstName", DataType::String),
                    Column::new("MiddleName", DataType::String),
                    Column::new("LastName", DataType::String),
                    Column::new("FullName", DataType::String),
                    Column::new("City", DataType::String),
                    Column::new("Country", DataType::String),
                    Column::new("Segment", DataType::String),
                ],
            ),
        ],
        vec![rel("Sales_Contact", "CustomerKey", "Contact", "ContactKey")],
        measures(),
        false,
    );

    // 12. THE SAME DIMENSION IN SWEDISH, compounded the way Swedish writes it:
    //     `fornamn` and `efternamn` are single unsplittable tokens, so only the
    //     joined-head rule in `label_score` can see them at all.
    let swedish_names = build(
        vec![
            sales_table(),
            t(
                "Kontakt",
                vec![
                    Column::new("kontakt_id", DataType::Int64),
                    Column::new("fornamn", DataType::String),
                    Column::new("efternamn", DataType::String),
                    Column::new("fullstandigtnamn", DataType::String),
                    Column::new("ort", DataType::String),
                    Column::new("land", DataType::String),
                    Column::new("segment", DataType::String),
                ],
            ),
        ],
        vec![rel("Sales_Kontakt", "CustomerKey", "Kontakt", "kontakt_id")],
        measures(),
        false,
    );

    // 13. THE COST OF DEMOTING EVERY NAME-LIKE COLUMN, as its own fixture so it
    //     is a measured row rather than a footnote. `Category Name` on a product
    //     dimension is a LEGITIMATE axis - grouping revenue by category name is
    //     a perfectly good breakdown - and the rule demotes it to `label`.
    let denormalised_names = build(
        vec![
            sales_table(),
            t(
                "Product",
                vec![
                    Column::new("ProductKey", DataType::Int64),
                    Column::new("Product Name", DataType::String),
                    Column::new("Category Name", DataType::String),
                    Column::new("Color", DataType::String),
                ],
            ),
        ],
        vec![rel("Sales_Product", "ProductKey", "Product", "ProductKey")],
        measures(),
        false,
    );

    vec![
        ("wide label-heavy dimension", wide),
        ("narrow dimension", narrow),
        ("calendar", calendar),
        ("junk dimension (flags)", junk),
        ("degenerate dimension (key only)", degenerate),
        ("fact table, no dimension", fact_only),
        ("concatenated lowercase names", concatenated),
        ("snake_case names", snake),
        ("abbreviated names", abbreviated),
        ("swedish names", swedish),
        ("several name columns", several_names),
        ("swedish name columns", swedish_names),
        ("denormalised name-as-axis", denormalised_names),
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

/// One table's columns and the role each was given, by fixture name prefix.
fn roles(fixture: &str, table: &str) -> BTreeMap<String, String> {
    let model = fixtures()
        .into_iter()
        .find(|(n, _)| n.starts_with(fixture))
        .unwrap_or_else(|| panic!("no fixture named '{fixture}'"))
        .1;
    let facts = facts_from_model(&model);
    let doc = infer(&facts, &model, &UsageIndex::default());
    doc.tables[table]
        .columns
        .iter()
        .map(|(c, cs)| (c.clone(), role_key(cs.role).to_string()))
        .collect()
}

#[test]
fn the_name_lexicon_reads_four_naming_conventions_and_names_the_one_it_still_loses() {
    // THE SAME DIMENSION IN FOUR SPELLINGS. Fixtures 1-6 are all PascalCase,
    // which `words()` splits perfectly, so the lexicon was passing its own exam:
    // `words("emailaddress")` is ONE token, and the `email` entry — matched by
    // word equality — never fired on it.
    //
    // Each assertion below names the convention it is about, so a future
    // widening (or a regression) says which one moved.
    let concatenated = roles("concatenated", "Customer");
    for column in ["emailaddress", "phonenumber", "addressline1", "postalcode"] {
        assert_eq!(
            concatenated.get(column).map(String::as_str),
            Some("ignore"),
            "concatenated lowercase: {column} is one per row: {concatenated:?}"
        );
    }
    assert_eq!(concatenated.get("fullname").map(String::as_str), Some("label"));
    // THE NEGATIVE CONTROLS. These are genuine axes and the anchored match must
    // leave them alone — `stateprovince` is not an address part just because an
    // address has a state in it.
    for column in ["stateprovince", "city", "country", "segment"] {
        assert_eq!(
            concatenated.get(column).map(String::as_str),
            Some("analysis"),
            "concatenated lowercase: {column} is an axis: {concatenated:?}"
        );
    }

    // snake_case already worked: the splitter does the whole job there. It is in
    // the harness as the CONTROL that separates a splitter problem from a
    // lexicon problem.
    let snake = roles("snake_case", "Customer");
    assert_eq!(snake.get("email_address").map(String::as_str), Some("ignore"));
    assert_eq!(snake.get("full_name").map(String::as_str), Some("label"));
    assert_eq!(snake.get("state_province").map(String::as_str), Some("analysis"));

    let swedish = roles("swedish", "Kund");
    for column in ["epostadress", "telefonnummer", "gatuadress", "postnummer"] {
        assert_eq!(
            swedish.get(column).map(String::as_str),
            Some("ignore"),
            "swedish: {column} is one per row: {swedish:?}"
        );
    }
    assert_eq!(swedish.get("kundnamn").map(String::as_str), Some("label"));
    for column in ["ort", "land", "kundsegment"] {
        assert_eq!(
            swedish.get(column).map(String::as_str),
            Some("analysis"),
            "swedish: {column} is an axis: {swedish:?}"
        );
    }

    // THE HONEST MISS, ASSERTED SO IT IS VISIBLE. `addr1` is reachable (the
    // `addr` term anchors at the start of a token nothing can split), but
    // `cust_nm` is a customer NAME only to somebody who already knows the
    // schema. No word list covers `nm`, `dsc` and their dialects without also
    // matching things that are not those, so this stays wrong until per-column
    // distinct counts land (open-items §2.AI.6) — and stays asserted, so fixing
    // it is a deliberate act rather than a surprise.
    let abbreviated = roles("abbreviated", "Customer");
    assert_eq!(abbreviated.get("addr1").map(String::as_str), Some("ignore"));
    assert_eq!(abbreviated.get("phone_no").map(String::as_str), Some("ignore"));
    assert_eq!(
        abbreviated.get("cust_nm").map(String::as_str),
        Some("analysis"),
        "the abbreviation defeats the lexicon, and the table says so rather than \
         the lexicon being contorted to cover it: {abbreviated:?}"
    );
}

/// The `labelColumn` a fixture's table elects, if it elects one.
fn label_column(fixture: &str, table: &str) -> Option<String> {
    let model = fixtures()
        .into_iter()
        .find(|(n, _)| n.starts_with(fixture))
        .unwrap_or_else(|| panic!("no fixture named '{fixture}'"))
        .1;
    let facts = facts_from_model(&model);
    infer(&facts, &model, &UsageIndex::default()).tables[table]
        .label_column
        .clone()
}

#[test]
fn a_dimension_with_several_name_columns_makes_axes_of_none_of_them() {
    // THE DEFECT THE HARNESS COULD NOT SEE. Every other fixture has exactly ONE
    // name-ish column, so the label arm reading only the ELECTION WINNER
    // (`label_column == name`) looked correct: with one candidate there are no
    // runners-up. Give a contact dimension four and three of them fell through
    // `is_one_per_row_shaped` - which carries no name terms - into the
    // dimension+type allowlist and came out `analysis`.
    //
    // Cardinality is not what fixes this and never would have been: `FirstName`
    // genuinely has a few hundred distinct values across ten thousand
    // customers, so a distinct count CONFIRMS it as an axis. Only the name
    // lexicon can demote it, which is why this matters independently of
    // open-items §2.AI.6.
    let contact = roles("several name columns", "Contact");
    for column in ["FirstName", "MiddleName", "LastName", "FullName"] {
        let role = contact.get(column).map(String::as_str);
        assert!(
            matches!(role, Some("label") | Some("ignore")),
            "'{column}' is name-like and must be label-shaped, was {role:?}: {contact:?}"
        );
    }
    // EXACTLY ONE of them wins the election, and it has to be the WHOLE name.
    // Winning stays a separate, additional fact about one column - the pointer
    // a report names a row by - and it no longer decides whether the other
    // three are axes. A label of `FirstName` names three rows "Anna", which is
    // the same as having no label.
    assert_eq!(
        label_column("several name columns", "Contact").as_deref(),
        Some("FullName"),
        "the whole name must beat a fragment of it"
    );
    // POSITIVE CONTROLS: the ordinary axes on the same table are untouched.
    for column in ["City", "Country", "Segment"] {
        assert_eq!(
            contact.get(column).map(String::as_str),
            Some("analysis"),
            "'{column}' is a perfectly good axis: {contact:?}"
        );
    }

    // THE SWEDISH HALF. `fornamn` and `efternamn` are single unsplittable
    // tokens, so `words()` cannot help and only the joined-head rule sees them.
    let swedish = roles("swedish name columns", "Kontakt");
    for column in ["fornamn", "efternamn", "fullstandigtnamn"] {
        let role = swedish.get(column).map(String::as_str);
        assert!(
            matches!(role, Some("label") | Some("ignore")),
            "swedish: '{column}' must be label-shaped, was {role:?}: {swedish:?}"
        );
    }
    assert_eq!(
        label_column("swedish name columns", "Kontakt").as_deref(),
        Some("fullstandigtnamn"),
        "swedish: the whole name must beat a fragment of it"
    );
    for column in ["ort", "land", "segment"] {
        assert_eq!(
            swedish.get(column).map(String::as_str),
            Some("analysis"),
            "swedish: '{column}' is an axis: {swedish:?}"
        );
    }
}

#[test]
fn a_denormalised_name_that_really_is_an_axis_is_demoted_too_and_the_harness_says_so() {
    // THE PRICE OF THE RULE ABOVE, MEASURED. `Category Name` on a product
    // dimension is a legitimate axis and this ladder calls it a label, so the
    // breakdown is not offered. The trade is a withheld breakdown against a
    // meaningless one, paid in a dropdown a person can change - every entry
    // ships `reviewed: false`. It is asserted so it stays a known consequence.
    let product = roles("denormalised name-as-axis", "Product");
    assert_eq!(
        label_column("denormalised name-as-axis", "Product").as_deref(),
        Some("Product Name"),
        "the column that restates the table still wins the election"
    );
    assert_eq!(
        product.get("Category Name").map(String::as_str),
        Some("label"),
        "the cost of the rule: {product:?}"
    );
    // The axis that does not read as a name keeps its role, so the price is
    // paid only where the lexicon actually fires.
    assert_eq!(product.get("Color").map(String::as_str), Some("analysis"));
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
