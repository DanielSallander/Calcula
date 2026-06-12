//! Conversion from sqlx PostgreSQL rows to Arrow `RecordBatch` values.

use std::sync::Arc;

use arrow::array::{
    ArrayRef, BooleanBuilder, Date32Builder, Decimal128Builder, Float64Builder, Int32Builder,
    Int64Builder, StringBuilder, TimestampMicrosecondBuilder,
};
use arrow::datatypes::{DataType as ArrowDataType, Schema, TimeUnit};
use arrow::record_batch::RecordBatch;
use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use rust_decimal::Decimal;
use sqlx::postgres::PgRow;
use sqlx::{Column as SqlxColumn, Row, TypeInfo};

use crate::decimal::decimal_to_i128;
use crate::error::{ConnectorError, ConnectorResult};

/// Maximum rows per `RecordBatch` when converting large result sets.
const BATCH_SIZE: usize = 8192;

/// Convert a vector of `PgRow` values into Arrow `RecordBatch` values.
///
/// Rows are chunked into batches of up to [`BATCH_SIZE`] rows each.
/// The provided `schema` determines the Arrow data type used for each column.
pub fn rows_to_record_batches(
    rows: &[PgRow],
    schema: &Schema,
) -> ConnectorResult<Vec<RecordBatch>> {
    if rows.is_empty() {
        let batch = RecordBatch::new_empty(Arc::new(schema.clone()));
        return Ok(vec![batch]);
    }

    let mut batches = Vec::new();
    for chunk in rows.chunks(BATCH_SIZE) {
        let batch = chunk_to_record_batch(chunk, schema)?;
        batches.push(batch);
    }
    Ok(batches)
}

/// Convert a single chunk of rows into one `RecordBatch`.
fn chunk_to_record_batch(rows: &[PgRow], schema: &Schema) -> ConnectorResult<RecordBatch> {
    let num_cols = schema.fields().len();
    let mut columns: Vec<ArrayRef> = Vec::with_capacity(num_cols);

    // Get PG wire types from the first row to handle sqlx decoding correctly.
    let pg_types: Vec<String> = rows[0]
        .columns()
        .iter()
        .map(|c| c.type_info().name().to_uppercase())
        .collect();

    for (col_idx, field) in schema.fields().iter().enumerate() {
        let pg_type = pg_types.get(col_idx).map(|s| s.as_str()).unwrap_or("");
        let array = build_column_array(rows, col_idx, field.data_type(), pg_type)?;
        columns.push(array);
    }

    RecordBatch::try_new(Arc::new(schema.clone()), columns).map_err(ConnectorError::from)
}

/// Build a single Arrow array from a column of rows.
///
/// The `pg_type` parameter is the uppercase PG wire type name (e.g., `"INT2"`,
/// `"INT4"`) used to choose the correct sqlx decode type.
fn build_column_array(
    rows: &[PgRow],
    col_idx: usize,
    arrow_type: &ArrowDataType,
    pg_type: &str,
) -> ConnectorResult<ArrayRef> {
    match arrow_type {
        ArrowDataType::Int32 => {
            let mut builder = Int32Builder::with_capacity(rows.len());
            // smallint (INT2) must be decoded as i16, then widened to i32.
            if pg_type == "INT2" {
                for row in rows {
                    let val: Option<i16> = row.try_get(col_idx).map_err(sqlx_get_err)?;
                    builder.append_option(val.map(i32::from));
                }
            } else {
                for row in rows {
                    let val: Option<i32> = row.try_get(col_idx).map_err(sqlx_get_err)?;
                    builder.append_option(val);
                }
            }
            Ok(Arc::new(builder.finish()))
        }
        ArrowDataType::Int64 => {
            let mut builder = Int64Builder::with_capacity(rows.len());
            for row in rows {
                let val: Option<i64> = row.try_get(col_idx).map_err(sqlx_get_err)?;
                builder.append_option(val);
            }
            Ok(Arc::new(builder.finish()))
        }
        ArrowDataType::Float64 => {
            let mut builder = Float64Builder::with_capacity(rows.len());
            // real (FLOAT4) must be decoded as f32, then widened to f64:
            // sqlx's f64 decoder only accepts the FLOAT8 wire type.
            if pg_type == "FLOAT4" {
                for row in rows {
                    let val: Option<f32> = row.try_get(col_idx).map_err(sqlx_get_err)?;
                    builder.append_option(val.map(f64::from));
                }
            } else {
                for row in rows {
                    let val: Option<f64> = row.try_get(col_idx).map_err(sqlx_get_err)?;
                    builder.append_option(val);
                }
            }
            Ok(Arc::new(builder.finish()))
        }
        ArrowDataType::Decimal128(precision, scale) => {
            let mut builder = Decimal128Builder::with_capacity(rows.len());
            builder = builder.with_precision_and_scale(*precision, *scale)?;
            for row in rows {
                let val: Option<Decimal> = row.try_get(col_idx).map_err(sqlx_get_err)?;
                match val {
                    Some(d) => {
                        let i128_val = decimal_to_i128(&d, *scale)?;
                        builder.append_value(i128_val);
                    }
                    None => builder.append_null(),
                }
            }
            Ok(Arc::new(builder.finish()))
        }
        ArrowDataType::Utf8 => {
            let mut builder = StringBuilder::with_capacity(rows.len(), rows.len() * 32);
            // UUID columns must be decoded via sqlx's Uuid type, not String.
            if pg_type == "UUID" {
                for row in rows {
                    let val: Option<sqlx::types::Uuid> =
                        row.try_get(col_idx).map_err(sqlx_get_err)?;
                    builder.append_option(val.map(|u| u.to_string()));
                }
            } else {
                for row in rows {
                    let val: Option<String> = row.try_get(col_idx).map_err(sqlx_get_err)?;
                    builder.append_option(val);
                }
            }
            Ok(Arc::new(builder.finish()))
        }
        ArrowDataType::Boolean => {
            let mut builder = BooleanBuilder::with_capacity(rows.len());
            for row in rows {
                let val: Option<bool> = row.try_get(col_idx).map_err(sqlx_get_err)?;
                builder.append_option(val);
            }
            Ok(Arc::new(builder.finish()))
        }
        ArrowDataType::Date32 => {
            let mut builder = Date32Builder::with_capacity(rows.len());
            let epoch = NaiveDate::from_ymd_opt(1970, 1, 1).expect("valid epoch date");
            for row in rows {
                let val: Option<NaiveDate> = row.try_get(col_idx).map_err(sqlx_get_err)?;
                match val {
                    Some(d) => {
                        let days = (d - epoch).num_days() as i32;
                        builder.append_value(days);
                    }
                    None => builder.append_null(),
                }
            }
            Ok(Arc::new(builder.finish()))
        }
        ArrowDataType::Timestamp(TimeUnit::Microsecond, _) => {
            let mut builder = TimestampMicrosecondBuilder::with_capacity(rows.len());
            // timestamptz must be decoded as DateTime<Utc>: sqlx's
            // NaiveDateTime decoder only accepts the TIMESTAMP wire type.
            if pg_type == "TIMESTAMPTZ" {
                for row in rows {
                    let val: Option<DateTime<Utc>> = row.try_get(col_idx).map_err(sqlx_get_err)?;
                    builder.append_option(val.map(|dt| dt.timestamp_micros()));
                }
            } else {
                for row in rows {
                    let val: Option<NaiveDateTime> = row.try_get(col_idx).map_err(sqlx_get_err)?;
                    match val {
                        Some(dt) => {
                            let micros = dt.and_utc().timestamp_micros();
                            builder.append_value(micros);
                        }
                        None => builder.append_null(),
                    }
                }
            }
            Ok(Arc::new(builder.finish()))
        }
        other => Err(ConnectorError::ArrowConversion(format!(
            "unsupported Arrow type: {other:?}"
        ))),
    }
}

/// Convert a sqlx error into a `ConnectorError`.
fn sqlx_get_err(e: sqlx::Error) -> ConnectorError {
    ConnectorError::ArrowConversion(format!("failed to extract column value: {e}"))
}
