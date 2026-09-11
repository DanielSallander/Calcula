//! FILENAME: core/insights/examples/narration.rs
// PURPOSE: The two things an offline narration eval needs from this crate, and
//          cannot have by re-implementing: REAL fact bundles, and the REAL
//          citation check.
// CONTEXT: M6's measurement. `tests/eval/run-narration-eval.mjs` drives a model
//          and has to ask, of every sentence it gets back, "is this entitled to
//          the numbers it prints?" — a question only `narrate::cite` may
//          answer. A JavaScript port of that check would be a second opinion
//          about `number.rs`'s rounding, the scientific cut-off and the sv-SE
//          non-breaking space, and the eval would then be measuring the port.
//          So the runner shells out to this, exactly as the design-query runner
//          bundles the product's own modules rather than copying them.
//
// TWO MODES, chosen by argv:
//
//   facts   Emit the fixture bundles as JSON on stdout: for each, the label,
//           the engine's own `factsJson`, and the DETERMINISTIC narration that
//           the same facts produced. The last is not the answer key — there is
//           no single right wording — it is the control: a run can always ask
//           what the engine itself said, and the check is known to accept it.
//
//   check   Read `{ localeId, factsJson, sentences: [{ text, factIds }] }` on
//           stdin and write the verdict on stdout: which sentences survive,
//           which were deleted and why, and which facts nobody covered.
//
// The fixtures are produced by running the REAL engine over synthetic datasets
// rather than by hand-writing facts. Hand-written facts drift from what the
// engine actually emits, and the numbers in them stop being the numbers a
// narrator would ever see.

use std::io::Read;

use insights::narrate::cite::{check_narration, DropReason, TaggedSentence};
use insights::narrate::prompt::{system_prompt, user_message, NARRATION_SCHEMA, NARRATION_SCHEMA_NAME};
use insights::narrate::Locale;
use insights::types::{Column, Datum, Dataset, FactKind, Insight, RangeRef, SourceRef};
use insights::AnalyzeOptions;

fn col(name: &str, index: u32, cells: Vec<Datum>) -> Column {
    Column {
        name: name.to_string(),
        sheet: "Sheet1".to_string(),
        range: RangeRef::new("Sheet1", 1, index, cells.len() as u32, index),
        cells,
    }
}

fn nums(values: &[f64]) -> Vec<Datum> {
    values.iter().map(|v| Datum::Number(*v)).collect()
}

fn texts(values: &[&str]) -> Vec<Datum> {
    values.iter().map(|v| Datum::Text(v.to_string())).collect()
}

fn dataset(label: &str, columns: Vec<Column>) -> Dataset {
    let rows = columns.iter().map(|c| c.cells.len()).max().unwrap_or(0);
    Dataset {
        source: SourceRef {
            label: label.to_string(),
            sheet: "Sheet1".to_string(),
            range: Some(RangeRef::new("Sheet1", 0, 0, rows as u32, columns.len() as u32)),
        },
        has_header: true,
        row_origins: (1..=rows as u32).collect(),
        columns,
    }
}

/// Datasets chosen to reach DIFFERENT fact kinds, not to be realistic.
///
/// A narration eval whose every bundle is one rising series measures one
/// template. These reach a trend, an outlier, a correlation, a dominant
/// category and a hygiene problem, which is a spread of sentence shapes — and
/// the numbers in them differ in magnitude, so the formatter's rounding bands
/// are exercised too.
fn fixtures() -> Vec<(&'static str, Dataset)> {
    let months = texts(&[
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]);
    vec![
        (
            "a rising series",
            dataset(
                "Sheet1!A1:B13",
                vec![
                    col("Month", 0, months.clone()),
                    col(
                        "Revenue",
                        1,
                        nums(&[
                            1000.0, 1120.0, 1190.0, 1305.0, 1410.0, 1495.0, 1630.0, 1710.0,
                            1845.0, 1920.0, 2050.0, 2180.0,
                        ]),
                    ),
                ],
            ),
        ),
        (
            "a series with one bad month",
            dataset(
                "Sheet1!A1:B13",
                vec![
                    col("Month", 0, months.clone()),
                    col(
                        "Orders",
                        1,
                        nums(&[
                            210.0, 205.0, 219.0, 198.0, 221.0, 214.0, 12.0, 208.0, 217.0, 203.0,
                            226.0, 212.0,
                        ]),
                    ),
                ],
            ),
        ),
        (
            "two columns that move together",
            dataset(
                "Sheet1!A1:C13",
                vec![
                    col("Month", 0, months.clone()),
                    col(
                        "Spend",
                        1,
                        nums(&[
                            50.0, 62.0, 71.0, 80.5, 93.0, 101.0, 118.0, 124.0, 139.0, 145.0,
                            158.0, 167.0,
                        ]),
                    ),
                    col(
                        "Leads",
                        2,
                        nums(&[
                            120.0, 148.0, 170.0, 193.0, 224.0, 240.0, 282.0, 297.0, 333.0, 347.0,
                            379.0, 401.0,
                        ]),
                    ),
                ],
            ),
        ),
        (
            "a category that dominates",
            dataset(
                "Sheet1!A1:B11",
                vec![
                    col(
                        "Region",
                        0,
                        texts(&[
                            "North", "North", "North", "North", "North", "North", "North",
                            "South", "East", "West",
                        ]),
                    ),
                    col(
                        "Amount",
                        1,
                        nums(&[
                            900.0, 880.0, 940.0, 910.0, 875.0, 925.0, 890.0, 120.0, 95.0, 88.0,
                        ]),
                    ),
                ],
            ),
        ),
        (
            "a column with holes and a repeat",
            dataset(
                "Sheet1!A1:B9",
                vec![
                    col(
                        "Customer",
                        0,
                        vec![
                            Datum::Text("Acme".into()),
                            Datum::Text("Borg".into()),
                            Datum::Blank,
                            Datum::Text("Acme".into()),
                            Datum::Blank,
                            Datum::Text("Delta".into()),
                            Datum::Text("Echo".into()),
                            Datum::Text("Acme".into()),
                        ],
                    ),
                    col(
                        "Value",
                        1,
                        nums(&[12.5, 0.0004, 3300.0, 12.5, 42.0, 9.75, 128.0, 12.5]),
                    ),
                ],
            ),
        ),
    ]
}

fn emit_facts(locale: Locale) {
    let mut out = Vec::new();
    for (label, data) in fixtures() {
        let options = AnalyzeOptions { locale, ..AnalyzeOptions::default() };
        let bundle = insights::analyze(&data, &options);
        out.push(serde_json::json!({
            "label": label,
            "localeId": bundle.locale_id,
            "factsJson": bundle.facts_json,
            // The product's own user message for these facts, so the runner
            // sends the bytes the product would send.
            "userMessage": user_message(&bundle.facts_json),
            // The engine's own narration of the same facts. A control, not an
            // answer key: there is no single right wording, and the eval scores
            // survival and coverage rather than similarity to this.
            "deterministic": bundle.insights.iter().map(|i| serde_json::json!({
                "id": i.id,
                "text": i.text,
            })).collect::<Vec<_>>(),
        }));
    }
    println!("{}", serde_json::to_string_pretty(&out).expect("fixtures serialise"));
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckInput {
    locale_id: String,
    facts_json: String,
    sentences: Vec<InputSentence>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct InputSentence {
    text: String,
    #[serde(default)]
    fact_ids: Vec<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FactsDoc {
    facts: Vec<FactRecord>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FactRecord {
    id: String,
    score: f64,
    kind: FactKind,
}

fn reason_json(reason: &DropReason) -> serde_json::Value {
    match reason {
        DropReason::NoFactCited => serde_json::json!({ "reason": "noFactCited" }),
        DropReason::UnknownFact(id) => serde_json::json!({ "reason": "unknownFact", "detail": id }),
        DropReason::UncitedNumber(n) => {
            serde_json::json!({ "reason": "uncitedNumber", "detail": n })
        }
    }
}

fn run_check() {
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw).expect("stdin is readable");
    let input: CheckInput = serde_json::from_str(&raw).expect("input parses");
    let locale = Locale::from_locale_id(&input.locale_id);
    let doc: FactsDoc = serde_json::from_str(&input.facts_json).expect("factsJson parses");

    // Rebuild the insights from their KINDS, which recomputes each id. If a
    // document's stated id disagrees with the one its own numbers produce, the
    // document is inconsistent and every coverage number drawn from it would be
    // fiction — so say so rather than measuring it.
    let mut facts = Vec::new();
    for record in doc.facts {
        let rebuilt = Insight::new(record.kind, record.score);
        assert_eq!(
            rebuilt.id, record.id,
            "factsJson states an id its own fact does not produce"
        );
        facts.push(rebuilt);
    }

    let sentences: Vec<TaggedSentence> = input
        .sentences
        .into_iter()
        .map(|s| TaggedSentence { text: s.text, fact_ids: s.fact_ids })
        .collect();
    let offered = sentences.len();
    let checked = check_narration(sentences, &facts, locale);

    let verdict = serde_json::json!({
        "offered": offered,
        "kept": checked.kept.iter().map(|s| serde_json::json!({
            "text": s.text,
            "factIds": s.fact_ids,
        })).collect::<Vec<_>>(),
        "dropped": checked.dropped.iter().map(|d| {
            let mut v = reason_json(&d.reason);
            v["text"] = serde_json::Value::String(d.sentence.text.clone());
            v
        }).collect::<Vec<_>>(),
        "covered": checked.covered.iter().collect::<Vec<_>>(),
        "uncovered": checked.uncovered,
        "coverage": checked.coverage(),
    });
    println!("{}", serde_json::to_string(&verdict).expect("verdict serialises"));
}

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_default();
    let locale_id = std::env::args().nth(2).unwrap_or_else(|| "en-US".to_string());
    match mode.as_str() {
        "facts" => emit_facts(Locale::from_locale_id(&locale_id)),
        // The PRODUCT's prompt and reply schema, so the eval measures what
        // the product will send rather than a copy that drifts from it.
        "prompt" => {
            let locale = Locale::from_locale_id(&locale_id);
            let out = serde_json::json!({
                "system": system_prompt(locale),
                "schemaName": NARRATION_SCHEMA_NAME,
                "schema": serde_json::from_str::<serde_json::Value>(NARRATION_SCHEMA).expect("schema is JSON"),
            });
            println!("{}", serde_json::to_string(&out).expect("serialises"));
        }
        "check" => run_check(),
        other => {
            eprintln!("usage: narration facts [localeId] | narration prompt [localeId] | narration check   (got {other:?})");
            std::process::exit(2);
        }
    }
}
