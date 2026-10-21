//! FILENAME: app/src-tauri/src/bi/member_tests.rs
//! PURPOSE: P2 S5, DC1/DC4 -- a BI query result is written to the grid by its
//!          column's declared TYPE, never by guessing from the machine text:
//!
//! - `batches_to_result` carries `column_kinds` from the Arrow schema;
//! - a Date32 value is a date serial shown with the app locale's short-date
//!   pattern, FROZEN at write time exactly as typed date entry freezes it
//!   (written under de-DE it keeps `DD.MM.YYYY` after a switch to sv-SE);
//! - a Utf8 "00123" stays text (the old guess made it the number 123);
//! - a Float64 "1234.5" is the number 1234.5 under de-DE (the machine text is
//!   invariant, so it is never parsed in the app locale);
//! - an empty `column_kinds` (a hand-built result) keeps today's guess;
//! - both grid writers go through the ONE `ResultCellWriter`.

use std::sync::Arc;

use arrow::array::{BooleanArray, Date32Array, Float64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Schema};
use arrow::record_batch::RecordBatch;
use engine::{CellValue, LocaleSettings, NumberFormat, StyleRegistry};

use super::commands::batches_to_result;
use super::member::{typed_cell, BiColumnKind, ResultCellWriter};

fn de() -> LocaleSettings {
    LocaleSettings::from_locale_id("de-DE")
}

/// Days since 1970-01-01 (Arrow Date32) of a calendar day.
fn epoch_days(y: i32, m: u32, d: u32) -> i32 {
    let date = chrono::NaiveDate::from_ymd_opt(y, m, d).unwrap();
    (date - chrono::NaiveDate::from_ymd_opt(1970, 1, 1).unwrap()).num_days() as i32
}

/// day Date32 | code Utf8 | amount Float64 | flag Boolean, one row:
/// 2024-01-15 | "00123" | 1234.5 | true
fn batch() -> RecordBatch {
    let schema = Arc::new(Schema::new(vec![
        Field::new("day", ArrowType::Date32, true),
        Field::new("code", ArrowType::Utf8, true),
        Field::new("amount", ArrowType::Float64, true),
        Field::new("flag", ArrowType::Boolean, true),
    ]));
    RecordBatch::try_new(
        schema,
        vec![
            Arc::new(Date32Array::from(vec![Some(epoch_days(2024, 1, 15))])),
            Arc::new(StringArray::from(vec![Some("00123")])),
            Arc::new(Float64Array::from(vec![Some(1234.5)])),
            Arc::new(BooleanArray::from(vec![Some(true)])),
        ],
    )
    .unwrap()
}

/// The cells one result row writes, through the shared writer.
fn written(
    kinds: &[BiColumnKind],
    row: &[Option<String>],
    locale: &LocaleSettings,
    styles: &mut StyleRegistry,
) -> Vec<engine::Cell> {
    let writer = ResultCellWriter::new(kinds, locale, styles);
    row.iter().enumerate().map(|(c, v)| writer.cell(c, v.as_deref())).collect()
}

#[test]
fn batches_to_result_carries_the_column_kinds_from_the_schema() {
    let result = batches_to_result(&[batch()]);
    assert_eq!(
        result.column_kinds,
        vec![BiColumnKind::Date, BiColumnKind::Text, BiColumnKind::Number, BiColumnKind::Boolean]
    );
    // The machine text is unchanged: the type travels BESIDE it.
    assert_eq!(
        result.rows[0],
        vec![
            Some("2024-01-15".to_string()),
            Some("00123".to_string()),
            Some("1234.5".to_string()),
            Some("true".to_string()),
        ]
    );
    assert!(batches_to_result(&[]).column_kinds.is_empty());
    // On the wire the kinds are camelCase, and an absent field is empty.
    let json = serde_json::to_value(&result).unwrap();
    assert_eq!(json["columnKinds"], serde_json::json!(["date", "text", "number", "boolean"]));
    let legacy: super::types::BiQueryResult =
        serde_json::from_value(serde_json::json!({ "columns": ["A"], "rows": [["1"]], "rowCount": 1 })).unwrap();
    assert!(legacy.column_kinds.is_empty());
}

#[test]
fn a_query_result_row_is_written_by_its_declared_types_under_de_de() {
    let result = batches_to_result(&[batch()]);
    let mut styles = StyleRegistry::new();
    let cells = written(&result.column_kinds, &result.rows[0], &de(), &mut styles);

    // Date32 -> the date serial, styled with de-DE's short-date pattern.
    assert_eq!(cells[0].value, CellValue::Number(45306.0));
    assert_eq!(
        styles.get(cells[0].style_index).number_format,
        NumberFormat::Date { format: de().date_format.clone() }
    );
    // Utf8 "00123" stays text: a code, not the number 123 (behaviour change).
    assert_eq!(cells[1].value, CellValue::Text("00123".to_string()));
    // Float64 machine text parses invariantly, whatever the app locale.
    assert_eq!(cells[2].value, CellValue::Number(1234.5));
    assert_eq!(cells[2].style_index, 0, "a number column adds no style");
    assert_eq!(cells[3].value, CellValue::Boolean(true));
}

#[test]
fn a_bi_date_freezes_the_write_time_pattern_like_typed_date_entry() {
    // DC4: the typed-entry precedent this follows. A date TYPED under de-DE
    // carries de-DE's pattern as its format...
    let (typed, typed_format) = engine::parse_cell_input_with_format("15.01.2024", &de());
    assert_eq!(typed.value, CellValue::Number(45306.0));
    let typed_format = typed_format.expect("a typed date implies its format");

    // ...and a BI date written under de-DE carries the SAME format. A later
    // adaptive marker must change both sites together.
    let bi = typed_cell(Some("2024-01-15"), BiColumnKind::Date, &de());
    assert_eq!(bi.number_format, Some(typed_format.clone()));

    // After a switch to sv-SE the cell still READS de-DE's pattern: the
    // format was frozen in the style when it was written.
    let shown = engine::format_number(45306.0, &typed_format, &LocaleSettings::from_locale_id("sv-SE"));
    assert_eq!(shown, "15.01.2024");
}

#[test]
fn an_empty_column_kinds_keeps_todays_guess() {
    let mut styles = StyleRegistry::new();
    let before = styles.len();
    let row = vec![Some("00123".to_string()), Some("2024-01-15".to_string()), Some("East".to_string()), None];
    let cells = written(&[], &row, &de(), &mut styles);
    assert_eq!(cells[0].value, CellValue::Number(123.0), "Unknown: a number when the text parses invariantly");
    assert_eq!(cells[1].value, CellValue::Text("2024-01-15".to_string()));
    assert_eq!(cells[2].value, CellValue::Text("East".to_string()));
    assert_eq!(cells[3].value, CellValue::Empty, "a NULL is an empty cell");
    assert_eq!(styles.len(), before, "no date column, no style interned");
}

#[test]
fn a_date_time_column_carries_date_and_time_patterns() {
    let mut styles = StyleRegistry::new();
    let row = vec![Some("2024-01-15 12:00:00".to_string())];
    let cells = written(&[BiColumnKind::DateTime], &row, &de(), &mut styles);
    assert_eq!(cells[0].value, CellValue::Number(45306.5));
    assert_eq!(
        styles.get(cells[0].style_index).number_format,
        NumberFormat::Date { format: format!("{} {}", de().date_format, de().time_format) }
    );
    // Text that is not ISO in a date column is kept as text, never misread.
    let odd = written(&[BiColumnKind::Date], &[Some("n/a".to_string())], &de(), &mut styles);
    assert_eq!(odd[0].value, CellValue::Text("n/a".to_string()));
}

/// The two grid writers go through the ONE writer: no second copy of the
/// type decision (or of the old text guess) survives in either body.
#[test]
fn both_bi_grid_writers_use_the_shared_result_cell_writer() {
    let src = include_str!("commands.rs");
    let body = |name: &str| -> &str {
        let start = src
            .find(&format!("pub async fn {name}("))
            .unwrap_or_else(|| panic!("{name} not found"));
        let rest = &src[start..];
        let end = rest.find("\n#[tauri::command]").unwrap_or(rest.len());
        &rest[..end]
    };
    for name in ["bi_insert_result", "bi_refresh_connection"] {
        let b = body(name);
        assert!(b.contains("ResultCellWriter::new("), "{name} does not build the shared writer");
        assert!(b.contains("cell_writer.cell("), "{name} does not write through it");
        assert!(!b.contains("parse::<f64>"), "{name} guesses a number from text again");
        assert!(!b.contains("try_parse_number"), "{name} kept the old guess");
    }
}
