//! Locating an endpoint's rows inside a JSON response, and inferring their
//! schema when the model declares none.
//!
//! The Arrow decoding itself lives in [`super::decode`]; this module answers the
//! two questions that come first: *where are the rows* and *what shape are
//! they*.

use engine_connectors::{ConnectorError, ConnectorResult};
use engine_core::model::RestField;
use engine_core::types::DataType;
use serde_json::Value;

/// Walk a dotted path into a JSON value, e.g. `data.items` or `customer.name`.
///
/// An empty path returns the value itself. A missing segment, or a segment
/// applied to a non-object, returns `None` — which the decoder treats as an
/// Arrow null. Key names containing a literal `.` are therefore not reachable;
/// that is a documented limitation of the dotted form.
pub(crate) fn lookup_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    if path.is_empty() {
        return Some(value);
    }
    let mut current = value;
    for segment in path.split('.') {
        current = current.as_object()?.get(segment)?;
    }
    Some(current)
}

/// Extract an endpoint's rows array from a parsed response body.
///
/// `rows_path` is the dotted path to the array; empty means the body *is* the
/// array. Anything else — a missing path, or a path that lands on a non-array —
/// is an error naming the path, because silently returning zero rows from a
/// mis-typed path is a wrong answer that looks like an empty source.
pub(crate) fn extract_rows(body: &Value, rows_path: &str) -> ConnectorResult<Vec<Value>> {
    let located = lookup_path(body, rows_path).ok_or_else(|| {
        ConnectorError::QueryFailed(format!(
            "REST response has no value at rowsPath '{}'",
            describe_path(rows_path)
        ))
    })?;
    match located {
        Value::Array(items) => Ok(items.clone()),
        other => Err(ConnectorError::QueryFailed(format!(
            "REST response value at rowsPath '{}' is {}, not an array of rows",
            describe_path(rows_path),
            describe_json_kind(other)
        ))),
    }
}

/// Read a cursor value out of a response body for
/// [`RestPagination::Cursor`](engine_core::model::RestPagination::Cursor).
///
/// Absent, `null`, and the empty string all mean "no more pages"; a non-string
/// scalar is accepted and stringified (some APIs page by an integer id).
pub(crate) fn extract_cursor(body: &Value, cursor_path: &str) -> ConnectorResult<Option<String>> {
    let Some(value) = lookup_path(body, cursor_path) else {
        return Ok(None);
    };
    let cursor = match value {
        Value::Null => return Ok(None),
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        other => {
            return Err(ConnectorError::QueryFailed(format!(
                "REST cursor at '{}' is {}, not a scalar",
                describe_path(cursor_path),
                describe_json_kind(other)
            )))
        }
    };
    Ok(if cursor.is_empty() {
        None
    } else {
        Some(cursor)
    })
}

/// The types [`infer_fields`] can produce, plus the lattice used to widen a
/// column whose sampled values disagree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Inferred {
    /// Every sampled value was `null` (or the key was absent).
    Unknown,
    /// `true` / `false`.
    Bool,
    /// A JSON integer.
    Int,
    /// A JSON number with a fractional part.
    Float,
    /// A JSON string, or a mix that nothing narrower covers.
    Text,
}

impl Inferred {
    /// Widen two observations of the same column into one type.
    fn merge(self, other: Inferred) -> Inferred {
        match (self, other) {
            (Inferred::Unknown, x) | (x, Inferred::Unknown) => x,
            (a, b) if a == b => a,
            (Inferred::Int, Inferred::Float) | (Inferred::Float, Inferred::Int) => Inferred::Float,
            // Anything else is a genuine mix (a number in one row, a string in
            // another) — text is the only lossless answer.
            _ => Inferred::Text,
        }
    }

    /// The engine type, or `None` for a column that was `null` throughout.
    fn data_type(self) -> Option<DataType> {
        match self {
            Inferred::Unknown => None,
            Inferred::Bool => Some(DataType::Boolean),
            Inferred::Int => Some(DataType::Int64),
            Inferred::Float => Some(DataType::Float64),
            Inferred::Text => Some(DataType::String),
        }
    }
}

/// Classify one JSON scalar. Objects and arrays return `None` — they are not
/// inferable columns and are skipped.
fn classify(value: &Value) -> Option<Inferred> {
    match value {
        Value::Null => Some(Inferred::Unknown),
        Value::Bool(_) => Some(Inferred::Bool),
        Value::Number(n) => Some(if n.is_f64() {
            Inferred::Float
        } else {
            Inferred::Int
        }),
        Value::String(_) => Some(Inferred::Text),
        Value::Array(_) | Value::Object(_) => None,
    }
}

/// Infer an endpoint's columns by sampling rows from its first page.
///
/// Deliberately narrow: it produces **`Boolean`, `Int64`, `Float64` and
/// `String` only**. There is no way to tell an ISO-8601 date from an ordinary
/// string by looking at it — a product code like `2026-08-25` is a perfectly
/// good string — and guessing wrong turns a working column into a parse error
/// on some future row. A `Date`, `Timestamp` or `Decimal` column therefore
/// needs an explicit
/// [`RestField`](engine_core::model::RestField) in the endpoint's `fields`,
/// as does any value nested inside an object or array (which has no top-level
/// key to infer from and is skipped here).
///
/// Column order follows first appearance across the sample, so a stable API
/// yields a stable schema.
pub(crate) fn infer_fields(endpoint: &str, rows: &[Value]) -> ConnectorResult<Vec<RestField>> {
    if rows.is_empty() {
        return Err(ConnectorError::IntrospectionFailed(format!(
            "REST endpoint '{endpoint}' returned no rows, so its columns cannot be inferred; \
             declare them explicitly in the endpoint's fields"
        )));
    }

    let mut order: Vec<String> = Vec::new();
    let mut seen: std::collections::HashMap<String, Inferred> = std::collections::HashMap::new();
    let mut skipped: Vec<String> = Vec::new();

    for row in rows {
        let object = row.as_object().ok_or_else(|| {
            ConnectorError::IntrospectionFailed(format!(
                "REST endpoint '{endpoint}' returned {} where a row object was expected",
                describe_json_kind(row)
            ))
        })?;
        for (key, value) in object {
            let Some(observed) = classify(value) else {
                if !skipped.contains(key) {
                    skipped.push(key.clone());
                }
                continue;
            };
            match seen.get_mut(key) {
                Some(current) => *current = current.merge(observed),
                None => {
                    order.push(key.clone());
                    seen.insert(key.clone(), observed);
                }
            }
        }
    }

    let mut fields = Vec::with_capacity(order.len());
    for key in &order {
        // A column that was null in every sampled row carries no type
        // information; String is the lossless placeholder and keeps the column
        // visible instead of dropping it.
        let data_type = seen
            .get(key)
            .copied()
            .unwrap_or(Inferred::Unknown)
            .data_type()
            .unwrap_or(DataType::String);
        fields.push(RestField::new(key, key, data_type));
    }

    if fields.is_empty() {
        return Err(ConnectorError::IntrospectionFailed(format!(
            "REST endpoint '{endpoint}' has no inferable columns (every value is nested in an \
             object or array); declare its fields explicitly with a path for each column"
        )));
    }
    Ok(fields)
}

/// Render an empty rows path as something readable in a message.
fn describe_path(path: &str) -> &str {
    if path.is_empty() {
        "(response root)"
    } else {
        path
    }
}

/// Name a JSON value's kind for an error message. Never prints the value —
/// a response body can contain anything, including an echoed credential.
pub(crate) fn describe_json_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(text: &str) -> Value {
        serde_json::from_str(text).expect("test JSON parses")
    }

    #[test]
    fn root_rows_path_takes_the_body_itself() {
        let rows = extract_rows(&json(r#"[{"a":1},{"a":2}]"#), "").unwrap();
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn nested_rows_path_walks_dotted_segments() {
        let body = json(r#"{"data":{"items":[{"a":1}],"total":1}}"#);
        let rows = extract_rows(&body, "data.items").unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn a_missing_or_non_array_rows_path_is_an_error_not_zero_rows() {
        let body = json(r#"{"data":{"items":[]}}"#);
        assert!(extract_rows(&body, "data.missing").is_err());
        assert!(extract_rows(&body, "data").is_err());
        // A correct path to an empty array is still fine.
        assert!(extract_rows(&body, "data.items").unwrap().is_empty());
    }

    #[test]
    fn cursor_extraction_treats_absent_null_and_empty_as_done() {
        let body = json(r#"{"meta":{"next":"abc","empty":"","nil":null}}"#);
        assert_eq!(
            extract_cursor(&body, "meta.next").unwrap(),
            Some("abc".to_string())
        );
        assert_eq!(extract_cursor(&body, "meta.empty").unwrap(), None);
        assert_eq!(extract_cursor(&body, "meta.nil").unwrap(), None);
        assert_eq!(extract_cursor(&body, "meta.absent").unwrap(), None);
    }

    #[test]
    fn cursor_extraction_stringifies_a_numeric_cursor() {
        let body = json(r#"{"next":42}"#);
        assert_eq!(
            extract_cursor(&body, "next").unwrap(),
            Some("42".to_string())
        );
    }

    #[test]
    fn inference_covers_bool_int_float_and_string_only() {
        let rows = match json(r#"[{"b":true,"i":1,"f":1.5,"s":"x"}]"#) {
            Value::Array(items) => items,
            _ => unreachable!(),
        };
        let fields = infer_fields("t", &rows).unwrap();
        let by_name = |n: &str| {
            fields
                .iter()
                .find(|f| f.name == n)
                .map(|f| f.data_type.clone())
        };
        assert_eq!(by_name("b"), Some(DataType::Boolean));
        assert_eq!(by_name("i"), Some(DataType::Int64));
        assert_eq!(by_name("f"), Some(DataType::Float64));
        assert_eq!(by_name("s"), Some(DataType::String));
    }

    #[test]
    fn an_iso_date_string_infers_as_string_never_as_date() {
        let rows = match json(r#"[{"when":"2026-08-25"}]"#) {
            Value::Array(items) => items,
            _ => unreachable!(),
        };
        let fields = infer_fields("t", &rows).unwrap();
        assert_eq!(fields[0].data_type, DataType::String);
    }

    #[test]
    fn inference_widens_int_and_float_and_falls_back_to_text_on_a_real_mix() {
        let rows = match json(r#"[{"n":1,"m":1},{"n":2.5,"m":"x"}]"#) {
            Value::Array(items) => items,
            _ => unreachable!(),
        };
        let fields = infer_fields("t", &rows).unwrap();
        let by_name = |n: &str| {
            fields
                .iter()
                .find(|f| f.name == n)
                .map(|f| f.data_type.clone())
        };
        assert_eq!(by_name("n"), Some(DataType::Float64));
        assert_eq!(by_name("m"), Some(DataType::String));
    }

    #[test]
    fn inference_keeps_first_seen_column_order_and_unions_late_keys() {
        let rows = match json(r#"[{"a":1,"b":2},{"c":3,"a":4}]"#) {
            Value::Array(items) => items,
            _ => unreachable!(),
        };
        let fields = infer_fields("t", &rows).unwrap();
        let names: Vec<&str> = fields.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["a", "b", "c"]);
    }

    #[test]
    fn an_all_null_column_survives_as_string() {
        let rows = match json(r#"[{"a":null},{"a":null}]"#) {
            Value::Array(items) => items,
            _ => unreachable!(),
        };
        let fields = infer_fields("t", &rows).unwrap();
        assert_eq!(fields[0].data_type, DataType::String);
    }

    #[test]
    fn nested_values_are_skipped_and_an_all_nested_row_is_an_error() {
        let rows = match json(r#"[{"a":1,"nested":{"x":1}}]"#) {
            Value::Array(items) => items,
            _ => unreachable!(),
        };
        let fields = infer_fields("t", &rows).unwrap();
        assert_eq!(fields.len(), 1);
        assert_eq!(fields[0].name, "a");

        let rows = match json(r#"[{"nested":{"x":1}}]"#) {
            Value::Array(items) => items,
            _ => unreachable!(),
        };
        let err = infer_fields("t", &rows).unwrap_err().to_string();
        assert!(err.contains("no inferable columns"), "got {err}");
    }

    #[test]
    fn inference_refuses_an_empty_sample_and_a_non_object_row() {
        assert!(infer_fields("t", &[]).is_err());
        let rows = vec![json("1")];
        assert!(infer_fields("t", &rows).is_err());
    }

    #[test]
    fn lookup_path_returns_none_for_a_missing_or_scalar_segment() {
        let body = json(r#"{"a":{"b":1},"c":2}"#);
        assert!(lookup_path(&body, "a.b").is_some());
        assert!(lookup_path(&body, "a.z").is_none());
        assert!(lookup_path(&body, "c.b").is_none());
        assert!(lookup_path(&body, "").is_some());
    }
}
