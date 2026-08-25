//! Unit tests for JSON -> Arrow decoding.
//!
//! A child module of [`super`], so the private per-type converters and the
//! decimal parser are reachable without widening their visibility.

use super::*;
use arrow::array::{
    Array, BooleanArray, Date32Array, Decimal128Array, Float64Array, Int32Array, Int64Array,
    StringArray, TimestampMicrosecondArray,
};

fn rows(text: &str) -> Vec<Value> {
    match serde_json::from_str(text).expect("test JSON parses") {
        Value::Array(items) => items,
        other => vec![other],
    }
}

#[test]
fn a_missing_or_null_value_becomes_an_arrow_null() {
    let rows = rows(r#"[{"a":1},{"a":null},{}]"#);
    let batch = rows_to_batch("t", &rows, &[RestField::new("a", "a", DataType::Int64)]).unwrap();
    let col = batch
        .column(0)
        .as_any()
        .downcast_ref::<Int64Array>()
        .unwrap();
    assert_eq!(col.len(), 3);
    assert_eq!(col.value(0), 1);
    assert!(col.is_null(1));
    assert!(col.is_null(2));
}

#[test]
fn a_nested_path_projects_out_of_the_row_object() {
    let rows = rows(r#"[{"customer":{"name":"Ada"}},{"customer":{}}]"#);
    let batch = rows_to_batch(
        "t",
        &rows,
        &[RestField::new(
            "customer.name",
            "customer",
            DataType::String,
        )],
    )
    .unwrap();
    let col = batch
        .column(0)
        .as_any()
        .downcast_ref::<StringArray>()
        .unwrap();
    assert_eq!(col.value(0), "Ada");
    assert!(col.is_null(1));
}

#[test]
fn scalars_decode_into_their_declared_arrow_types() {
    let rows = rows(r#"[{"b":true,"i":7,"n":2,"f":1.5,"s":"x"}]"#);
    let batch = rows_to_batch(
        "t",
        &rows,
        &[
            RestField::new("b", "b", DataType::Boolean),
            RestField::new("i", "i", DataType::Int64),
            RestField::new("n", "n", DataType::Int32),
            RestField::new("f", "f", DataType::Float64),
            RestField::new("s", "s", DataType::String),
        ],
    )
    .unwrap();
    assert!(batch
        .column(0)
        .as_any()
        .downcast_ref::<BooleanArray>()
        .unwrap()
        .value(0));
    assert_eq!(
        batch
            .column(1)
            .as_any()
            .downcast_ref::<Int64Array>()
            .unwrap()
            .value(0),
        7
    );
    assert_eq!(
        batch
            .column(2)
            .as_any()
            .downcast_ref::<Int32Array>()
            .unwrap()
            .value(0),
        2
    );
    assert!(
        (batch
            .column(3)
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap()
            .value(0)
            - 1.5)
            .abs()
            < f64::EPSILON
    );
    assert_eq!(
        batch
            .column(4)
            .as_any()
            .downcast_ref::<StringArray>()
            .unwrap()
            .value(0),
        "x"
    );
}

#[test]
fn numeric_strings_and_stringified_numbers_are_coerced() {
    let rows = rows(r#"[{"i":"42","s":7,"b":"TRUE"}]"#);
    let batch = rows_to_batch(
        "t",
        &rows,
        &[
            RestField::new("i", "i", DataType::Int64),
            RestField::new("s", "s", DataType::String),
            RestField::new("b", "b", DataType::Boolean),
        ],
    )
    .unwrap();
    assert_eq!(
        batch
            .column(0)
            .as_any()
            .downcast_ref::<Int64Array>()
            .unwrap()
            .value(0),
        42
    );
    assert_eq!(
        batch
            .column(1)
            .as_any()
            .downcast_ref::<StringArray>()
            .unwrap()
            .value(0),
        "7"
    );
    assert!(batch
        .column(2)
        .as_any()
        .downcast_ref::<BooleanArray>()
        .unwrap()
        .value(0));
}

#[test]
fn an_undecodable_value_errors_naming_the_column_rather_than_nulling_it() {
    let rows = rows(r#"[{"i":"not a number"}]"#);
    let err = rows_to_batch("t", &rows, &[RestField::new("i", "i", DataType::Int64)])
        .unwrap_err()
        .to_string();
    assert!(err.contains("column 'i'"), "got {err}");
}

#[test]
fn an_int32_overflow_is_reported_not_truncated() {
    let rows = rows(r#"[{"i":5000000000}]"#);
    let err = rows_to_batch("t", &rows, &[RestField::new("i", "i", DataType::Int32)])
        .unwrap_err()
        .to_string();
    assert!(err.contains("32-bit"), "got {err}");
}

#[test]
fn dates_and_timestamps_decode_from_iso_strings() {
    let rows = rows(r#"[{"d":"1970-01-11","t":"1970-01-01T00:00:01Z"}]"#);
    let batch = rows_to_batch(
        "t",
        &rows,
        &[
            RestField::new("d", "d", DataType::Date),
            RestField::new("t", "t", DataType::Timestamp),
        ],
    )
    .unwrap();
    assert_eq!(
        batch
            .column(0)
            .as_any()
            .downcast_ref::<Date32Array>()
            .unwrap()
            .value(0),
        10
    );
    assert_eq!(
        batch
            .column(1)
            .as_any()
            .downcast_ref::<TimestampMicrosecondArray>()
            .unwrap()
            .value(0),
        1_000_000
    );
}

#[test]
fn a_date_from_an_epoch_number_is_refused_rather_than_guessed() {
    let rows = rows(r#"[{"d":19000}]"#);
    let err = rows_to_batch("t", &rows, &[RestField::new("d", "d", DataType::Date)])
        .unwrap_err()
        .to_string();
    assert!(err.contains("ISO-8601"), "got {err}");
}

#[test]
fn decimals_parse_from_text_without_a_float_round_trip() {
    let rows = rows(r#"[{"m":"10.25"},{"m":-1.5},{"m":null}]"#);
    let batch = rows_to_batch(
        "t",
        &rows,
        &[RestField::new("m", "m", DataType::Decimal(18, 4))],
    )
    .unwrap();
    let col = batch
        .column(0)
        .as_any()
        .downcast_ref::<Decimal128Array>()
        .unwrap();
    assert_eq!(col.value(0), 102_500);
    assert_eq!(col.value(1), -15_000);
    assert!(col.is_null(2));
}

#[test]
fn a_decimal_with_more_digits_than_the_scale_is_refused() {
    let rows = rows(r#"[{"m":"1.239"}]"#);
    let err = rows_to_batch(
        "t",
        &rows,
        &[RestField::new("m", "m", DataType::Decimal(18, 2))],
    )
    .unwrap_err()
    .to_string();
    assert!(err.contains("fractional digits"), "got {err}");
}

#[test]
fn scaled_decimal_parsing_covers_the_shapes_json_produces() {
    assert_eq!(parse_scaled_decimal("0", 2), Ok(0));
    assert_eq!(parse_scaled_decimal("1", 2), Ok(100));
    assert_eq!(parse_scaled_decimal(".5", 2), Ok(50));
    assert_eq!(parse_scaled_decimal("-0.05", 2), Ok(-5));
    assert_eq!(parse_scaled_decimal("+12.3", 2), Ok(1230));
    assert!(parse_scaled_decimal("1e5", 2).is_err());
    assert!(parse_scaled_decimal("abc", 2).is_err());
    assert!(parse_scaled_decimal("", 2).is_err());
}

#[test]
fn a_non_object_row_is_an_error_not_an_all_null_table() {
    let rows = rows(r#"[1,2,3]"#);
    let err = rows_to_batch("t", &rows, &[RestField::new("a", "a", DataType::Int64)])
        .unwrap_err()
        .to_string();
    assert!(err.contains("row to be a JSON object"), "got {err}");
}
