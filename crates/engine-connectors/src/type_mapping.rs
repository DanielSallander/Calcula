//! Mapping from database type names to engine data types.

use engine_core::types::DataType;

use crate::error::{ConnectorError, ConnectorResult};

/// Default scale for decimal columns whose scale is not reported by the
/// database (e.g. unconstrained PostgreSQL `NUMERIC`, where
/// `information_schema` reports NULL precision and scale).
///
/// Defaulting to 0 would silently drop every fractional digit, so we default
/// to a fraction-preserving scale matching the inferred-schema paths, which
/// hardcode `Decimal128(38, 10)`.
const DEFAULT_DECIMAL_SCALE: i32 = crate::decimal::DEFAULT_DECIMAL_SCALE as i32;

/// Maximum precision supported by Arrow `Decimal128`.
const MAX_DECIMAL_PRECISION: i32 = crate::decimal::DEFAULT_DECIMAL_PRECISION as i32;

/// Build a [`DataType::Decimal`] from database-reported precision/scale
/// metadata, applying safe defaults for unconstrained decimals.
///
/// Precision is clamped to `1..=38` (Arrow `Decimal128` limits); scale
/// defaults to [`DEFAULT_DECIMAL_SCALE`] when unreported and is clamped so
/// that it never exceeds the capped precision.
fn decimal_type_from_metadata(
    numeric_precision: Option<i32>,
    numeric_scale: Option<i32>,
) -> DataType {
    let precision = numeric_precision
        .unwrap_or(MAX_DECIMAL_PRECISION)
        .clamp(1, MAX_DECIMAL_PRECISION);
    let scale = numeric_scale
        .unwrap_or(DEFAULT_DECIMAL_SCALE)
        .clamp(-MAX_DECIMAL_PRECISION, precision);
    DataType::Decimal(precision as u8, scale as i8)
}

/// Map a PostgreSQL type name (from `information_schema` or `pg_type`) to an
/// engine [`DataType`].
///
/// The `column_name` parameter is used only for error messages.
pub fn pg_type_to_engine_type(
    pg_type: &str,
    column_name: &str,
    numeric_precision: Option<i32>,
    numeric_scale: Option<i32>,
) -> ConnectorResult<DataType> {
    match pg_type {
        "integer" | "int4" => Ok(DataType::Int32),
        "smallint" | "int2" => Ok(DataType::Int32),
        "bigint" | "int8" | "serial" | "bigserial" => Ok(DataType::Int64),
        "double precision" | "float8" => Ok(DataType::Float64),
        "real" | "float4" => Ok(DataType::Float64),
        "numeric" | "decimal" => Ok(decimal_type_from_metadata(numeric_precision, numeric_scale)),
        "text" | "varchar" | "character varying" | "char" | "character" | "name" | "uuid"
        | "xml" | "json" | "jsonb" | "citext" => Ok(DataType::String),
        "boolean" | "bool" => Ok(DataType::Boolean),
        "date" => Ok(DataType::Date),
        "timestamp without time zone"
        | "timestamp with time zone"
        | "timestamp"
        | "timestamptz" => Ok(DataType::Timestamp),
        _ => Err(ConnectorError::UnsupportedType {
            column: column_name.to_string(),
            db_type: pg_type.to_string(),
        }),
    }
}

/// Map a SQL Server type name (from `INFORMATION_SCHEMA`) to an engine
/// [`DataType`].
///
/// SQL Server type names from `INFORMATION_SCHEMA.COLUMNS.DATA_TYPE` are
/// typically lowercase: `"int"`, `"bigint"`, `"nvarchar"`, etc.
pub fn sqlserver_type_to_engine_type(
    sql_type: &str,
    column_name: &str,
    numeric_precision: Option<i32>,
    numeric_scale: Option<i32>,
) -> ConnectorResult<DataType> {
    match sql_type.to_lowercase().as_str() {
        "int" => Ok(DataType::Int32),
        "smallint" | "tinyint" => Ok(DataType::Int32),
        "bigint" => Ok(DataType::Int64),
        "float" | "real" => Ok(DataType::Float64),
        "decimal" | "numeric" | "money" | "smallmoney" => {
            Ok(decimal_type_from_metadata(numeric_precision, numeric_scale))
        }
        "nvarchar" | "varchar" | "nchar" | "char" | "ntext" | "text" | "uniqueidentifier"
        | "xml" => Ok(DataType::String),
        "bit" => Ok(DataType::Boolean),
        "date" => Ok(DataType::Date),
        "datetime" | "datetime2" | "smalldatetime" | "datetimeoffset" => Ok(DataType::Timestamp),
        _ => Err(ConnectorError::UnsupportedType {
            column: column_name.to_string(),
            db_type: sql_type.to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integer_maps_to_int32() {
        assert_eq!(
            pg_type_to_engine_type("integer", "col", None, None).unwrap(),
            DataType::Int32
        );
        assert_eq!(
            pg_type_to_engine_type("int4", "col", None, None).unwrap(),
            DataType::Int32
        );
    }

    #[test]
    fn smallint_maps_to_int32() {
        assert_eq!(
            pg_type_to_engine_type("smallint", "col", None, None).unwrap(),
            DataType::Int32
        );
    }

    #[test]
    fn bigint_maps_to_int64() {
        assert_eq!(
            pg_type_to_engine_type("bigint", "col", None, None).unwrap(),
            DataType::Int64
        );
    }

    #[test]
    fn float_types_map_to_float64() {
        assert_eq!(
            pg_type_to_engine_type("double precision", "col", None, None).unwrap(),
            DataType::Float64
        );
        assert_eq!(
            pg_type_to_engine_type("real", "col", None, None).unwrap(),
            DataType::Float64
        );
    }

    #[test]
    fn numeric_maps_to_decimal_with_precision_scale() {
        assert_eq!(
            pg_type_to_engine_type("numeric", "col", Some(10), Some(2)).unwrap(),
            DataType::Decimal(10, 2)
        );
    }

    #[test]
    fn unconstrained_numeric_defaults_to_fraction_preserving_scale() {
        // Unconstrained NUMERIC reports NULL precision/scale. Defaulting the
        // scale to 0 would silently truncate every fractional digit.
        assert_eq!(
            pg_type_to_engine_type("numeric", "col", None, None).unwrap(),
            DataType::Decimal(38, 10)
        );
        assert_eq!(
            sqlserver_type_to_engine_type("decimal", "col", None, None).unwrap(),
            DataType::Decimal(38, 10)
        );
    }

    #[test]
    fn numeric_precision_capped_and_scale_clamped_to_precision() {
        // Precision beyond Decimal128's 38-digit limit is capped, and the
        // scale must never exceed the capped precision.
        assert_eq!(
            pg_type_to_engine_type("numeric", "col", Some(50), Some(45)).unwrap(),
            DataType::Decimal(38, 38)
        );
        // Scale larger than a small precision is clamped to the precision.
        assert_eq!(
            pg_type_to_engine_type("numeric", "col", Some(5), Some(12)).unwrap(),
            DataType::Decimal(5, 5)
        );
    }

    #[test]
    fn numeric_with_explicit_zero_scale_is_preserved() {
        // numeric(10) declares scale 0 explicitly — that must be honored.
        assert_eq!(
            pg_type_to_engine_type("numeric", "col", Some(10), Some(0)).unwrap(),
            DataType::Decimal(10, 0)
        );
    }

    #[test]
    fn text_types_map_to_string() {
        for pg_type in &[
            "text",
            "varchar",
            "character varying",
            "char",
            "uuid",
            "name",
            "json",
            "jsonb",
        ] {
            assert_eq!(
                pg_type_to_engine_type(pg_type, "col", None, None).unwrap(),
                DataType::String,
                "failed for {pg_type}"
            );
        }
    }

    #[test]
    fn boolean_maps_to_boolean() {
        assert_eq!(
            pg_type_to_engine_type("boolean", "col", None, None).unwrap(),
            DataType::Boolean
        );
        assert_eq!(
            pg_type_to_engine_type("bool", "col", None, None).unwrap(),
            DataType::Boolean
        );
    }

    #[test]
    fn date_maps_to_date() {
        assert_eq!(
            pg_type_to_engine_type("date", "col", None, None).unwrap(),
            DataType::Date
        );
    }

    #[test]
    fn timestamp_maps_to_timestamp() {
        assert_eq!(
            pg_type_to_engine_type("timestamp without time zone", "col", None, None).unwrap(),
            DataType::Timestamp
        );
        assert_eq!(
            pg_type_to_engine_type("timestamp with time zone", "col", None, None).unwrap(),
            DataType::Timestamp
        );
    }

    #[test]
    fn unsupported_type_returns_error() {
        let err = pg_type_to_engine_type("bytea", "my_col", None, None).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("bytea"));
        assert!(msg.contains("my_col"));
    }

    // --- SQL Server type mapping tests ---

    #[test]
    fn sqlserver_int_maps_to_int32() {
        assert_eq!(
            sqlserver_type_to_engine_type("int", "col", None, None).unwrap(),
            DataType::Int32
        );
        assert_eq!(
            sqlserver_type_to_engine_type("smallint", "col", None, None).unwrap(),
            DataType::Int32
        );
        assert_eq!(
            sqlserver_type_to_engine_type("tinyint", "col", None, None).unwrap(),
            DataType::Int32
        );
    }

    #[test]
    fn sqlserver_bigint_maps_to_int64() {
        assert_eq!(
            sqlserver_type_to_engine_type("bigint", "col", None, None).unwrap(),
            DataType::Int64
        );
    }

    #[test]
    fn sqlserver_float_maps_to_float64() {
        assert_eq!(
            sqlserver_type_to_engine_type("float", "col", None, None).unwrap(),
            DataType::Float64
        );
        assert_eq!(
            sqlserver_type_to_engine_type("real", "col", None, None).unwrap(),
            DataType::Float64
        );
    }

    #[test]
    fn sqlserver_decimal_maps_to_decimal() {
        assert_eq!(
            sqlserver_type_to_engine_type("decimal", "col", Some(18), Some(4)).unwrap(),
            DataType::Decimal(18, 4)
        );
        assert_eq!(
            sqlserver_type_to_engine_type("money", "col", Some(19), Some(4)).unwrap(),
            DataType::Decimal(19, 4)
        );
    }

    #[test]
    fn sqlserver_string_types_map_to_string() {
        for t in &[
            "nvarchar",
            "varchar",
            "nchar",
            "char",
            "ntext",
            "text",
            "uniqueidentifier",
        ] {
            assert_eq!(
                sqlserver_type_to_engine_type(t, "col", None, None).unwrap(),
                DataType::String,
                "failed for {t}"
            );
        }
    }

    #[test]
    fn sqlserver_bit_maps_to_boolean() {
        assert_eq!(
            sqlserver_type_to_engine_type("bit", "col", None, None).unwrap(),
            DataType::Boolean
        );
    }

    #[test]
    fn sqlserver_date_maps_to_date() {
        assert_eq!(
            sqlserver_type_to_engine_type("date", "col", None, None).unwrap(),
            DataType::Date
        );
    }

    #[test]
    fn sqlserver_datetime_maps_to_timestamp() {
        assert_eq!(
            sqlserver_type_to_engine_type("datetime", "col", None, None).unwrap(),
            DataType::Timestamp
        );
        assert_eq!(
            sqlserver_type_to_engine_type("datetime2", "col", None, None).unwrap(),
            DataType::Timestamp
        );
    }

    #[test]
    fn sqlserver_unsupported_returns_error() {
        let err = sqlserver_type_to_engine_type("image", "my_col", None, None).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("image"));
        assert!(msg.contains("my_col"));
    }
}
