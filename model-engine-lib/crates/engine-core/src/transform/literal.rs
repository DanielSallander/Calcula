//! Turning a step's author-typed text into a SAFE, typed SQL literal.
//!
//! Steps such as [`ReplaceValues`](crate::transform::TransformStep::ReplaceValues)
//! carry free text that has to be compared against a column of some concrete
//! type. Text columns are easy — [`sql_quote_literal`] neutralises them — but a
//! numeric or boolean column renders its literal **bare**, and a bare
//! interpolation of author text is exactly the raw-SQL hole the engine's
//! quoting helpers exist to close.
//!
//! So nothing is ever interpolated bare on trust: this module PARSES the text
//! as a value of the column's type and renders the parsed value. Text that does
//! not parse is rejected — at model-build time by
//! [`validate_typed_literal`], long before it could reach a generated
//! statement — with a message naming the column and the type, instead of a
//! DataFusion syntax error at refresh.

use crate::compute::sql_util::sql_quote_literal;
use crate::types::DataType;

/// Render `text` as a SQL literal of `data_type`, or explain why it cannot be.
///
/// The returned string is safe to interpolate: quoted types go through
/// [`sql_quote_literal`], and bare types are re-rendered from a value this
/// function itself parsed, so no author byte reaches the statement unchecked.
///
/// # Errors
///
/// A short, user-facing reason (no column name — callers add that context).
pub(crate) fn typed_sql_literal(text: &str, data_type: &DataType) -> Result<String, String> {
    let trimmed = text.trim();
    match data_type {
        // Quoting fully neutralises these; the value's *meaning* is the
        // source's business, not ours.
        DataType::String | DataType::Date | DataType::Timestamp => Ok(sql_quote_literal(text)),

        DataType::Int32 => trimmed
            .parse::<i32>()
            .map(|v| v.to_string())
            .map_err(|_| format!("'{text}' is not a whole number")),
        DataType::Int64 => trimmed
            .parse::<i64>()
            .map(|v| v.to_string())
            .map_err(|_| format!("'{text}' is not a whole number")),

        DataType::Float64 => match trimmed.parse::<f64>() {
            // A non-finite literal has no SQL spelling and would render as
            // `inf`/`NaN`, which DataFusion does not parse as a number.
            Ok(v) if v.is_finite() => Ok(format_finite_f64(v)),
            Ok(_) => Err(format!("'{text}' is not a finite number")),
            Err(_) => Err(format!("'{text}' is not a number")),
        },

        // Rendered from the author's digits rather than through f64, so an
        // exact decimal is not bent by a binary-float round trip on the way to
        // the comparison. The shape check is what makes it safe to emit.
        DataType::Decimal(_, _) => {
            if is_plain_decimal(trimmed) {
                Ok(trimmed.to_string())
            } else {
                Err(format!("'{text}' is not a decimal number"))
            }
        }

        DataType::Boolean => match trimmed.to_ascii_lowercase().as_str() {
            "true" | "1" => Ok("TRUE".to_string()),
            "false" | "0" => Ok("FALSE".to_string()),
            _ => Err(format!("'{text}' is not true or false")),
        },
    }
}

/// Check that `text` can be rendered as a literal of `data_type`, discarding
/// the rendering.
///
/// Used by schema derivation so a step that could not render is refused while
/// the author is still editing it.
pub(crate) fn validate_typed_literal(text: &str, data_type: &DataType) -> Result<(), String> {
    typed_sql_literal(text, data_type).map(|_| ())
}

/// Render a finite `f64` so DataFusion always reads it as a float.
///
/// `{}` on a whole-valued f64 prints `5`, which types as an integer and can
/// change a comparison's coercion; the trailing `.0` keeps it a float.
fn format_finite_f64(value: f64) -> String {
    let rendered = format!("{value}");
    if rendered.contains(['.', 'e', 'E', 'n', 'i']) {
        rendered
    } else {
        format!("{rendered}.0")
    }
}

/// `true` for an optionally-signed run of digits with at most one decimal
/// point and at least one digit — the only shape emitted bare for a decimal.
fn is_plain_decimal(text: &str) -> bool {
    let body = text.strip_prefix(['+', '-']).unwrap_or(text);
    if body.is_empty() {
        return false;
    }
    let mut seen_dot = false;
    let mut seen_digit = false;
    for ch in body.chars() {
        match ch {
            '0'..='9' => seen_digit = true,
            '.' if !seen_dot => seen_dot = true,
            _ => return false,
        }
    }
    seen_digit
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_and_temporal_literals_are_quoted_and_escaped() {
        assert_eq!(
            typed_sql_literal("open", &DataType::String).unwrap(),
            "'open'"
        );
        assert_eq!(
            typed_sql_literal("O'Brien", &DataType::String).unwrap(),
            "'O''Brien'"
        );
        assert_eq!(
            typed_sql_literal("2026-01-01", &DataType::Date).unwrap(),
            "'2026-01-01'"
        );
    }

    #[test]
    fn a_sql_injection_payload_in_a_text_value_is_neutralised() {
        let rendered = typed_sql_literal("x'); DROP TABLE t; --", &DataType::String).unwrap();
        assert_eq!(rendered, "'x''); DROP TABLE t; --'");
        assert!(!rendered.contains("x');"));
    }

    #[test]
    fn numeric_literals_are_reparsed_not_passed_through() {
        assert_eq!(typed_sql_literal(" 42 ", &DataType::Int64).unwrap(), "42");
        assert_eq!(typed_sql_literal("-7", &DataType::Int32).unwrap(), "-7");
        assert_eq!(typed_sql_literal("1.5", &DataType::Float64).unwrap(), "1.5");
    }

    #[test]
    fn a_whole_valued_float_keeps_a_decimal_point() {
        // `5` would type as an integer and change how the comparison coerces.
        assert_eq!(typed_sql_literal("5", &DataType::Float64).unwrap(), "5.0");
    }

    #[test]
    fn boolean_literals_render_as_sql_keywords() {
        assert_eq!(
            typed_sql_literal("TRUE", &DataType::Boolean).unwrap(),
            "TRUE"
        );
        assert_eq!(
            typed_sql_literal("false", &DataType::Boolean).unwrap(),
            "FALSE"
        );
        assert_eq!(typed_sql_literal("1", &DataType::Boolean).unwrap(), "TRUE");
    }

    #[test]
    fn a_decimal_keeps_the_authors_digits() {
        // Not routed through f64: 0.1 must stay 0.1, not 0.1000000000000000055.
        assert_eq!(
            typed_sql_literal("0.1", &DataType::Decimal(18, 4)).unwrap(),
            "0.1"
        );
    }

    #[test]
    fn text_that_is_not_a_value_of_the_type_is_refused_not_interpolated() {
        // THE POINT OF THIS MODULE: each of these would previously have been
        // pasted bare into a generated statement.
        for (text, data_type) in [
            ("0 OR 1=1", DataType::Int64),
            ("abc", DataType::Float64),
            ("1; DROP TABLE t", DataType::Int32),
            ("maybe", DataType::Boolean),
            ("1e5", DataType::Decimal(18, 2)),
            ("--", DataType::Int64),
        ] {
            let result = typed_sql_literal(text, &data_type);
            assert!(
                result.is_err(),
                "'{text}' as {data_type:?} must be refused, got {result:?}"
            );
        }
    }

    #[test]
    fn a_non_finite_float_is_refused() {
        assert!(typed_sql_literal("inf", &DataType::Float64).is_err());
        assert!(typed_sql_literal("NaN", &DataType::Float64).is_err());
    }

    #[test]
    fn every_rendered_bare_literal_is_free_of_sql_metacharacters() {
        // The safety property stated as a property: for the bare (unquoted)
        // types, nothing that survives can carry a quote, a semicolon or a
        // comment introducer.
        for data_type in [
            DataType::Int32,
            DataType::Int64,
            DataType::Float64,
            DataType::Decimal(18, 2),
            DataType::Boolean,
        ] {
            for text in ["1", "0", "-1", "1.5", "true", "false", "  2  "] {
                if let Ok(rendered) = typed_sql_literal(text, &data_type) {
                    assert!(
                        !rendered.contains(['\'', ';', '-', '(', ')']) || rendered.starts_with('-'),
                        "{data_type:?} rendered '{text}' as unsafe '{rendered}'"
                    );
                }
            }
        }
    }

    #[test]
    fn validate_mirrors_the_renderer() {
        assert!(validate_typed_literal("42", &DataType::Int64).is_ok());
        assert!(validate_typed_literal("nope", &DataType::Int64).is_err());
    }
}
