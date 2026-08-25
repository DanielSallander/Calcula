//! Decoding JSON rows into an Arrow [`RecordBatch`] against declared fields.
//!
//! One column at a time, one Arrow builder per declared
//! [`RestField`](engine_core::model::RestField). A field whose path is absent
//! in a row — or whose value is JSON `null` — becomes an **Arrow null**, never
//! a zero or an empty string: analytical data has holes and the engine's null
//! handling is Arrow-native, so a hole must arrive as one.
//!
//! Coercion is deliberately narrow. A number arriving where a string is
//! declared is stringified (APIs are inconsistent about quoting ids) and a
//! numeric string arriving where a number is declared is parsed (same reason),
//! but a value that cannot be represented at all is an **error naming the
//! column** — not a silent null, which would look like missing data rather than
//! a broken mapping.

use std::sync::Arc;

use arrow::array::{
    ArrayRef, BooleanBuilder, Date32Builder, Decimal128Builder, Float64Builder, Int32Builder,
    Int64Builder, StringBuilder, TimestampMicrosecondBuilder,
};
use arrow::datatypes::{Field, Schema};
use arrow::record_batch::RecordBatch;
use engine_connectors::{ConnectorError, ConnectorResult};
use engine_core::model::RestField;
use engine_core::types::DataType;
use serde_json::Value;

use super::json_rows::lookup_path;

/// Days between the Unix epoch and the proleptic Gregorian year 1 (the anchor
/// `chrono::NaiveDate::num_days_from_ce` counts from).
const CE_DAYS_TO_UNIX_EPOCH: i32 = 719_163;

/// Build one Arrow batch from `rows`, projecting each declared field out of
/// each row object by its dotted path.
///
/// The batch's schema is exactly `fields`, in order, every column nullable.
/// A row that is not a JSON object is an error — an endpoint whose "rows" are
/// scalars has a wrong `rowsPath`, and decoding it as though each scalar were a
/// row would produce an all-null table that looks like a successful refresh.
pub(crate) fn rows_to_batch(
    endpoint: &str,
    rows: &[Value],
    fields: &[RestField],
) -> ConnectorResult<RecordBatch> {
    let schema = Arc::new(Schema::new(
        fields
            .iter()
            .map(|f| Field::new(&f.name, f.data_type.to_arrow(), true))
            .collect::<Vec<_>>(),
    ));

    for row in rows {
        if !row.is_object() {
            return Err(ConnectorError::ArrowConversion(format!(
                "REST endpoint '{endpoint}': expected each row to be a JSON object, got {}",
                super::json_rows::describe_json_kind(row)
            )));
        }
    }

    let mut columns: Vec<ArrayRef> = Vec::with_capacity(fields.len());
    for field in fields {
        columns.push(build_column(endpoint, rows, field)?);
    }

    if fields.is_empty() {
        return Err(ConnectorError::ArrowConversion(format!(
            "REST endpoint '{endpoint}' has no declared or inferred columns"
        )));
    }

    RecordBatch::try_new(schema, columns)
        .map_err(|e| ConnectorError::ArrowConversion(format!("REST endpoint '{endpoint}': {e}")))
}

/// Build one Arrow column for `field` across every row.
fn build_column(endpoint: &str, rows: &[Value], field: &RestField) -> ConnectorResult<ArrayRef> {
    let values = rows.iter().map(|row| lookup_path(row, &field.path));
    let column = &field.name;

    macro_rules! build {
        ($builder:expr, $convert:expr) => {{
            let mut builder = $builder;
            for value in values {
                match value {
                    None | Some(Value::Null) => builder.append_null(),
                    Some(value) => builder.append_value($convert(endpoint, column, value)?),
                }
            }
            Arc::new(builder.finish()) as ArrayRef
        }};
    }

    let array: ArrayRef = match &field.data_type {
        DataType::Boolean => build!(BooleanBuilder::new(), as_bool),
        DataType::Int32 => build!(Int32Builder::new(), as_i32),
        DataType::Int64 => build!(Int64Builder::new(), as_i64),
        DataType::Float64 => build!(Float64Builder::new(), as_f64),
        DataType::String => build!(StringBuilder::new(), as_text),
        DataType::Date => build!(Date32Builder::new(), as_date32),
        DataType::Timestamp => build!(TimestampMicrosecondBuilder::new(), as_timestamp_micros),
        DataType::Decimal(precision, scale) => {
            let (precision, scale) = (*precision, *scale);
            let mut builder = Decimal128Builder::new()
                .with_precision_and_scale(precision, scale)
                .map_err(|e| {
                    ConnectorError::ArrowConversion(format!(
                        "REST endpoint '{endpoint}' column '{column}': \
                         invalid decimal precision/scale {precision}/{scale}: {e}"
                    ))
                })?;
            for value in values {
                match value {
                    None | Some(Value::Null) => builder.append_null(),
                    Some(value) => {
                        builder.append_value(as_decimal(endpoint, column, value, scale)?)
                    }
                }
            }
            Arc::new(builder.finish()) as ArrayRef
        }
    };
    Ok(array)
}

/// The one shape every conversion failure takes.
fn bad_value(endpoint: &str, column: &str, value: &Value, expected: &str) -> ConnectorError {
    ConnectorError::ArrowConversion(format!(
        "REST endpoint '{endpoint}' column '{column}': cannot read {} as {expected}",
        super::json_rows::describe_json_kind(value)
    ))
}

/// JSON → `bool`. Accepts the strings `"true"`/`"false"` (case-insensitive),
/// which several APIs use for flags.
fn as_bool(endpoint: &str, column: &str, value: &Value) -> ConnectorResult<bool> {
    match value {
        Value::Bool(b) => Ok(*b),
        Value::String(s) if s.eq_ignore_ascii_case("true") => Ok(true),
        Value::String(s) if s.eq_ignore_ascii_case("false") => Ok(false),
        other => Err(bad_value(endpoint, column, other, "a boolean")),
    }
}

/// JSON → `i64`. Accepts an integral float (`3.0`) and a numeric string.
fn as_i64(endpoint: &str, column: &str, value: &Value) -> ConnectorResult<i64> {
    match value {
        Value::Number(n) => n
            .as_i64()
            .or_else(|| n.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64))
            .ok_or_else(|| bad_value(endpoint, column, value, "a 64-bit integer")),
        Value::String(s) => s
            .trim()
            .parse::<i64>()
            .map_err(|_| bad_value(endpoint, column, value, "a 64-bit integer")),
        other => Err(bad_value(endpoint, column, other, "a 64-bit integer")),
    }
}

/// JSON → `i32`, via [`as_i64`] plus a range check (an out-of-range id is a
/// wrong declared type, not a null).
fn as_i32(endpoint: &str, column: &str, value: &Value) -> ConnectorResult<i32> {
    let wide = as_i64(endpoint, column, value)?;
    i32::try_from(wide).map_err(|_| {
        ConnectorError::ArrowConversion(format!(
            "REST endpoint '{endpoint}' column '{column}': {wide} does not fit a 32-bit \
             integer; declare the column as Int64"
        ))
    })
}

/// JSON → `f64`. Accepts a numeric string.
fn as_f64(endpoint: &str, column: &str, value: &Value) -> ConnectorResult<f64> {
    match value {
        Value::Number(n) => n
            .as_f64()
            .ok_or_else(|| bad_value(endpoint, column, value, "a number")),
        Value::String(s) => s
            .trim()
            .parse::<f64>()
            .map_err(|_| bad_value(endpoint, column, value, "a number")),
        other => Err(bad_value(endpoint, column, other, "a number")),
    }
}

/// JSON → text. Scalars stringify; an object or array is rendered as its
/// compact JSON, which keeps the value rather than losing it.
fn as_text(_endpoint: &str, _column: &str, value: &Value) -> ConnectorResult<String> {
    Ok(match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        other => other.to_string(),
    })
}

/// JSON → Arrow `Date32` (days since the Unix epoch).
///
/// Accepts `YYYY-MM-DD` and the date part of an ISO-8601 / RFC 3339 timestamp.
/// A bare epoch number is **refused**: days-vs-seconds-vs-milliseconds cannot
/// be told apart, and guessing wrong silently shifts every date in the table.
fn as_date32(endpoint: &str, column: &str, value: &Value) -> ConnectorResult<i32> {
    let Value::String(text) = value else {
        return Err(ConnectorError::ArrowConversion(format!(
            "REST endpoint '{endpoint}' column '{column}': a Date column must arrive as an \
             ISO-8601 string (got {})",
            super::json_rows::describe_json_kind(value)
        )));
    };
    let date_part = text.trim().split(['T', ' ']).next().unwrap_or("");
    let date = chrono::NaiveDate::parse_from_str(date_part, "%Y-%m-%d").map_err(|_| {
        ConnectorError::ArrowConversion(format!(
            "REST endpoint '{endpoint}' column '{column}': '{date_part}' is not an ISO-8601 date \
             (YYYY-MM-DD)"
        ))
    })?;
    Ok(chrono::Datelike::num_days_from_ce(&date) - CE_DAYS_TO_UNIX_EPOCH)
}

/// JSON → Arrow `Timestamp(Microsecond, None)`.
///
/// Accepts RFC 3339 (with an offset, normalized to UTC) and a naive
/// `YYYY-MM-DDTHH:MM:SS[.fff]`. A bare epoch number is refused for the same
/// reason as [`as_date32`].
fn as_timestamp_micros(endpoint: &str, column: &str, value: &Value) -> ConnectorResult<i64> {
    let Value::String(text) = value else {
        return Err(ConnectorError::ArrowConversion(format!(
            "REST endpoint '{endpoint}' column '{column}': a Timestamp column must arrive as an \
             ISO-8601 string (got {})",
            super::json_rows::describe_json_kind(value)
        )));
    };
    let text = text.trim();
    if let Ok(offset) = chrono::DateTime::parse_from_rfc3339(text) {
        return Ok(offset.timestamp_micros());
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f"] {
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(text, format) {
            return Ok(naive.and_utc().timestamp_micros());
        }
    }
    // A date-only value is midnight UTC — the same reading a `Date` column gets.
    if let Ok(date) = chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        if let Some(naive) = date.and_hms_opt(0, 0, 0) {
            return Ok(naive.and_utc().timestamp_micros());
        }
    }
    Err(ConnectorError::ArrowConversion(format!(
        "REST endpoint '{endpoint}' column '{column}': '{text}' is not an ISO-8601 timestamp"
    )))
}

/// JSON → Arrow `Decimal128` unscaled units at `scale`.
///
/// Parses the value's decimal text (a JSON number is taken via its own textual
/// form, which avoids the binary-float rounding a `f64` round-trip would
/// introduce on money). Excess fractional digits are an error rather than a
/// silent truncation — losing cents without saying so is exactly the failure a
/// decimal column exists to prevent.
fn as_decimal(endpoint: &str, column: &str, value: &Value, scale: i8) -> ConnectorResult<i128> {
    let text = match value {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.trim().to_string(),
        other => {
            return Err(bad_value(endpoint, column, other, "a decimal number"));
        }
    };
    parse_scaled_decimal(&text, scale).map_err(|reason| {
        ConnectorError::ArrowConversion(format!(
            "REST endpoint '{endpoint}' column '{column}': '{text}' {reason}"
        ))
    })
}

/// Parse decimal text into unscaled `i128` units at `scale`.
///
/// Handles a leading sign, an absent integer or fractional part, and an
/// exponent-free form only — `1e5` is refused rather than mis-parsed.
fn parse_scaled_decimal(text: &str, scale: i8) -> Result<i128, String> {
    if scale < 0 {
        return Err("cannot be stored at a negative decimal scale".to_string());
    }
    let scale = scale as u32;
    let text = text.trim();
    if text.is_empty() {
        return Err("is empty".to_string());
    }
    let (negative, digits) = match text.as_bytes()[0] {
        b'-' => (true, &text[1..]),
        b'+' => (false, &text[1..]),
        _ => (false, text),
    };
    let (integer, fraction) = match digits.split_once('.') {
        Some((i, f)) => (i, f),
        None => (digits, ""),
    };
    let all_digits = |s: &str| s.chars().all(|c| c.is_ascii_digit());
    if !all_digits(integer) || !all_digits(fraction) || (integer.is_empty() && fraction.is_empty())
    {
        return Err("is not a plain decimal number".to_string());
    }
    if fraction.len() as u32 > scale {
        return Err(format!(
            "has more fractional digits than the column's scale of {scale}"
        ));
    }
    let padded = format!(
        "{integer}{fraction}{}",
        "0".repeat(scale as usize - fraction.len())
    );
    let trimmed = padded.trim_start_matches('0');
    let magnitude: i128 = if trimmed.is_empty() {
        0
    } else {
        trimmed
            .parse::<i128>()
            .map_err(|_| "overflows a 128-bit decimal".to_string())?
    };
    Ok(if negative { -magnitude } else { magnitude })
}

#[cfg(test)]
mod tests;
