//! FILENAME: core/engine/src/locale_corpus_tests.rs
//! PURPOSE: Assert the engine against THE shared Rust <-> TypeScript
//!          number/date text corpus, `core/engine/tests/fixtures/
//!          locale_text_corpus.json` (P2 S1). The TypeScript formatter in
//!          `app/src/core/lib/locale/` reads the very same rows
//!          (`localeText.corpus.test.ts`), so a display the two disagree on
//!          fails one of the two suites instead of drifting silently.
//!
//! Every failing row is reported by its INDEX and its full JSON, all at once,
//! so a broken corpus row (or a broken formatter) names itself.

use serde_json::Value as Json;

use crate::custom_format::format_custom_value;
use crate::locale::LocaleSettings;
use crate::number_format::format_number;
use crate::style::NumberFormat;
use crate::typed_entry::{parse_date_time_input, parse_number};

const CORPUS: &str = include_str!("../tests/fixtures/locale_text_corpus.json");

/// The LOCALES the corpus must cover (the spec's six).
const REQUIRED_LOCALES: [&str; 6] = ["en-US", "en-GB", "sv-SE", "de-DE", "de-CH", "fr-FR"];

fn rows() -> Vec<Json> {
    let doc: Json = serde_json::from_str(CORPUS).expect("the corpus is valid JSON");
    doc.get("rows")
        .and_then(Json::as_array)
        .expect("the corpus has a `rows` array")
        .clone()
}

fn number_json(n: Option<f64>) -> Json {
    match n {
        Some(v) => serde_json::Number::from_f64(v).map(Json::Number).unwrap_or(Json::Null),
        None => Json::Null,
    }
}

/// What the engine produces for one row.
fn actual(row: &Json) -> Result<Json, String> {
    let locale_id = row["locale"].as_str().ok_or("row has no locale")?;
    let locale = LocaleSettings::from_locale_id(locale_id);
    if locale.locale_id != locale_id {
        return Err(format!("unknown locale {locale_id:?} (resolved to {})", locale.locale_id));
    }
    let op = row["op"].as_str().ok_or("row has no op")?;
    match op {
        "format" => {
            let value = row["input"].as_f64().ok_or("format input is not a number")?;
            let text = match row.get("code").and_then(Json::as_str) {
                Some(code) => format_custom_value(value, code, &locale).text,
                None => format_number(value, &NumberFormat::General, &locale),
            };
            Ok(Json::String(text))
        }
        "parse" => {
            let text = row["input"].as_str().ok_or("parse input is not text")?;
            Ok(number_json(parse_number(text, &locale)))
        }
        "parseDate" => {
            let text = row["input"].as_str().ok_or("parseDate input is not text")?;
            Ok(number_json(parse_date_time_input(text, &locale).map(|(serial, _)| serial)))
        }
        "formatDate" => {
            let serial = row["input"].as_f64().ok_or("formatDate input is not a number")?;
            let pattern = match row.get("style").and_then(Json::as_str).unwrap_or("short") {
                "short" => locale.date_format.clone(),
                "long" => locale.long_date_format.clone(),
                "time" => locale.time_format.clone(),
                "dateTime" => format!("{} {}", locale.date_format, locale.time_format),
                other => return Err(format!("unknown formatDate style {other:?}")),
            };
            Ok(Json::String(format_number(serial, &NumberFormat::Date { format: pattern }, &locale)))
        }
        other => Err(format!("unknown op {other:?}")),
    }
}

fn same(expected: &Json, got: &Json) -> bool {
    match (expected, got) {
        (Json::Number(a), Json::Number(b)) => {
            let (a, b) = (a.as_f64().unwrap(), b.as_f64().unwrap());
            (a - b).abs() <= 1e-9 * a.abs().max(1.0)
        }
        _ => expected == got,
    }
}

#[test]
fn every_corpus_row_matches_the_engine() {
    let rows = rows();
    let mut failures = Vec::new();
    for (i, row) in rows.iter().enumerate() {
        match actual(row) {
            Ok(got) if same(&row["expected"], &got) => {}
            Ok(got) => failures.push(format!("row {i}: {row} -> engine gave {got}")),
            Err(e) => failures.push(format!("row {i}: {row} -> {e}")),
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} corpus rows disagree with the engine:\n{}",
        failures.len(),
        rows.len(),
        failures.join("\n")
    );
}

/// The corpus's `locales` section, which the TypeScript suite formats with, is
/// the ENGINE's locale table byte for byte -- in the wire shape
/// `get_locale_settings` sends (`LocaleSettingsData`: separators as strings,
/// `currencyPosition` lowercase, the calendar names and quarter labels). A
/// hand-copied TS locale that drifted from `from_locale_id` would let both
/// suites pass while the two formatters disagreed in the app (P2 S6).
#[test]
fn the_corpus_locales_are_the_engine_locales_in_wire_shape() {
    let doc: Json = serde_json::from_str(CORPUS).expect("the corpus is valid JSON");
    let locales = doc
        .get("locales")
        .and_then(Json::as_object)
        .expect("the corpus has a `locales` object");
    let mut failures = Vec::new();
    for id in REQUIRED_LOCALES {
        let l = LocaleSettings::from_locale_id(id);
        let cal = l.calendar();
        let names = |a: &[&'static str]| Json::Array(a.iter().map(|s| Json::String(s.to_string())).collect());
        let expected = serde_json::json!({
            "localeId": l.locale_id,
            "displayName": l.display_name,
            "decimalSeparator": l.decimal_separator.to_string(),
            "thousandsSeparator": l.thousands_separator.to_string(),
            "listSeparator": l.list_separator.to_string(),
            "dateFormat": l.date_format,
            "longDateFormat": l.long_date_format,
            "timeFormat": l.time_format,
            "currencySymbol": l.currency_symbol,
            "currencyPosition": match l.currency_position {
                crate::locale::LocaleCurrencyPosition::Before => "before",
                crate::locale::LocaleCurrencyPosition::After => "after",
            },
            "overrideId": Json::Null,
            "monthNamesShort": names(&cal.months_short),
            "monthNamesLong": names(&cal.months_full),
            "dayNamesShort": names(&cal.days_short),
            "dayNamesLong": names(&cal.days_full),
            "quarterLabels": Json::Array((1..=4).map(|q| Json::String(cal.quarter_label(q))).collect()),
        });
        match locales.get(id) {
            Some(got) if *got == expected => {}
            Some(got) => failures.push(format!("{id}: corpus has {got}\n   engine is {expected}")),
            None => failures.push(format!("{id}: missing from `locales`")),
        }
    }
    assert!(failures.is_empty(), "corpus locales drifted from the engine:\n{}", failures.join("\n"));
}

#[test]
fn the_corpus_is_large_enough_and_covers_every_locale_and_op() {
    let rows = rows();
    assert!(rows.len() >= 120, "the corpus has only {} rows (spec: at least 120)", rows.len());
    for locale in REQUIRED_LOCALES {
        for op in ["format", "parse", "parseDate", "formatDate"] {
            assert!(
                rows.iter().any(|r| r["locale"] == locale && r["op"] == op),
                "no {op} row for {locale}"
            );
        }
    }
    // NBSP grouping is what the sv-SE/fr-FR rows exist to pin; a corpus whose
    // NBSPs were "normalised" to spaces by an editor would pass vacuously.
    assert!(
        rows.iter()
            .any(|r| r["locale"] == "sv-SE" && r["expected"].as_str().is_some_and(|s| s.contains('\u{00A0}'))),
        "no sv-SE expectation carries a U+00A0 group separator"
    );
    assert!(
        CORPUS.contains("\\u00A0"),
        "the corpus must spell U+00A0 as an escape so editors cannot normalise it"
    );
}
