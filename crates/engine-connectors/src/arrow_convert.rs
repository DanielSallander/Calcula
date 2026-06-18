//! Conversion from sqlx PostgreSQL rows to Arrow `RecordBatch` values.
//!
//! All the shared builder/chunking/decimal logic lives in [`crate::arrow_build`];
//! this module only implements the thin [`RowReader`] over `PgRow`, handling
//! sqlx's wire-type quirks (smallint as `i16`, `real` as `f32`, `uuid`,
//! `timestamptz`).

use arrow::datatypes::Schema;
use arrow::record_batch::RecordBatch;
use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use rust_decimal::Decimal;
use sqlx::postgres::PgRow;
use sqlx::{Column as SqlxColumn, Row, TypeInfo};

use crate::arrow_build::RowReader;
use crate::decimal::decimal_to_i128;
use crate::error::{ConnectorError, ConnectorResult};

/// Convert a slice of `PgRow` values into Arrow `RecordBatch` values.
///
/// The `schema` determines the Arrow data type used for each column.
pub fn rows_to_record_batches(rows: &[PgRow], schema: &Schema) -> ConnectorResult<Vec<RecordBatch>> {
    crate::arrow_build::rows_to_record_batches::<PgReader>(rows, schema)
}

/// [`RowReader`] over sqlx PostgreSQL rows. The hint is the uppercase PG wire
/// type name (e.g. `"INT2"`, `"FLOAT4"`, `"UUID"`, `"TIMESTAMPTZ"`), used to
/// pick the correct sqlx decode type — sqlx's decoders are strict and reject a
/// mismatched wire type.
struct PgReader;

impl RowReader for PgReader {
    type Row = PgRow;
    type Hint = String;

    fn default_hint() -> String {
        String::new()
    }

    fn column_hints(first_row: &PgRow) -> Vec<String> {
        first_row
            .columns()
            .iter()
            .map(|c| c.type_info().name().to_uppercase())
            .collect()
    }

    fn get_i32(row: &PgRow, col: usize, hint: &String) -> ConnectorResult<Option<i32>> {
        // smallint (INT2) must be decoded as i16, then widened to i32.
        if hint == "INT2" {
            let val: Option<i16> = row.try_get(col).map_err(sqlx_get_err)?;
            Ok(val.map(i32::from))
        } else {
            row.try_get(col).map_err(sqlx_get_err)
        }
    }

    fn get_i64(row: &PgRow, col: usize) -> ConnectorResult<Option<i64>> {
        row.try_get(col).map_err(sqlx_get_err)
    }

    fn get_f64(row: &PgRow, col: usize, hint: &String) -> ConnectorResult<Option<f64>> {
        // real (FLOAT4) must be decoded as f32, then widened to f64: sqlx's f64
        // decoder only accepts the FLOAT8 wire type.
        if hint == "FLOAT4" {
            let val: Option<f32> = row.try_get(col).map_err(sqlx_get_err)?;
            Ok(val.map(f64::from))
        } else {
            row.try_get(col).map_err(sqlx_get_err)
        }
    }

    fn get_decimal_i128(
        row: &PgRow,
        col: usize,
        scale: i8,
        _hint: &String,
    ) -> ConnectorResult<Option<i128>> {
        let val: Option<Decimal> = row.try_get(col).map_err(sqlx_get_err)?;
        val.map(|d| decimal_to_i128(&d, scale)).transpose()
    }

    fn get_string(row: &PgRow, col: usize, hint: &String) -> ConnectorResult<Option<String>> {
        // UUID columns must be decoded via sqlx's Uuid type, not String.
        if hint == "UUID" {
            let val: Option<sqlx::types::Uuid> = row.try_get(col).map_err(sqlx_get_err)?;
            Ok(val.map(|u| u.to_string()))
        } else {
            row.try_get(col).map_err(sqlx_get_err)
        }
    }

    fn get_bool(row: &PgRow, col: usize) -> ConnectorResult<Option<bool>> {
        row.try_get(col).map_err(sqlx_get_err)
    }

    fn get_date(row: &PgRow, col: usize) -> ConnectorResult<Option<NaiveDate>> {
        row.try_get(col).map_err(sqlx_get_err)
    }

    fn get_timestamp_micros(
        row: &PgRow,
        col: usize,
        hint: &String,
    ) -> ConnectorResult<Option<i64>> {
        // timestamptz must be decoded as DateTime<Utc>: sqlx's NaiveDateTime
        // decoder only accepts the TIMESTAMP wire type.
        if hint == "TIMESTAMPTZ" {
            let val: Option<DateTime<Utc>> = row.try_get(col).map_err(sqlx_get_err)?;
            Ok(val.map(|dt| dt.timestamp_micros()))
        } else {
            let val: Option<NaiveDateTime> = row.try_get(col).map_err(sqlx_get_err)?;
            Ok(val.map(|dt| dt.and_utc().timestamp_micros()))
        }
    }
}

/// Convert a sqlx error into a `ConnectorError`.
fn sqlx_get_err(e: sqlx::Error) -> ConnectorError {
    ConnectorError::ArrowConversion(format!("failed to extract column value: {e}"))
}
