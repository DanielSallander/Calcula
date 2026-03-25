//! Conversion from tiberius SQL Server rows to Arrow `RecordBatch` values.

use std::sync::Arc;

use arrow::array::{
    ArrayRef, BooleanBuilder, Date32Builder, Decimal128Builder, Float64Builder, Int32Builder,
    Int64Builder, StringBuilder, TimestampMicrosecondBuilder,
};
use arrow::datatypes::{DataType as ArrowDataType, Schema, TimeUnit};
use arrow::record_batch::RecordBatch;
use chrono::NaiveDate;
use rust_decimal::Decimal;
use tiberius::Row as TibRow;

use crate::error::{ConnectorError, ConnectorResult};

/// Maximum rows per `RecordBatch` when converting large result sets.
const BATCH_SIZE: usize = 8192;

/// Convert tiberius rows into Arrow `RecordBatch` values.
///
/// Rows are chunked into batches of up to [`BATCH_SIZE`] rows each.
/// The provided `schema` determines the Arrow data type used for each column.
pub fn tiberius_rows_to_record_batches(
    rows: &[TibRow],
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
fn chunk_to_record_batch(rows: &[TibRow], schema: &Schema) -> ConnectorResult<RecordBatch> {
    let num_cols = schema.fields().len();
    let mut columns: Vec<ArrayRef> = Vec::with_capacity(num_cols);

    for (col_idx, field) in schema.fields().iter().enumerate() {
        let array = build_column_array(rows, col_idx, field.data_type())?;
        columns.push(array);
    }

    RecordBatch::try_new(Arc::new(schema.clone()), columns).map_err(ConnectorError::from)
}

/// Build a single Arrow array from a column of tiberius rows.
fn build_column_array(
    rows: &[TibRow],
    col_idx: usize,
    arrow_type: &ArrowDataType,
) -> ConnectorResult<ArrayRef> {
    match arrow_type {
        ArrowDataType::Int32 => {
            let mut builder = Int32Builder::with_capacity(rows.len());
            for row in rows {
                // tiberius may return i16 for smallint, i32 for int.
                // Try i32 first, then fall back to i16 widened.
                let val: Option<i32> = row.try_get(col_idx).map_err(tib_get_err)?;
                builder.append_option(val);
            }
            Ok(Arc::new(builder.finish()))
        }
        ArrowDataType::Int64 => {
            let mut builder = Int64Builder::with_capacity(rows.len());
            for row in rows {
                let val: Option<i64> = row.try_get(col_idx).map_err(tib_get_err)?;
                builder.append_option(val);
            }
            Ok(Arc::new(builder.finish()))
        }
        ArrowDataType::Float64 => {
            let mut builder = Float64Builder::with_capacity(rows.len());
            for row in rows {
                let val: Option<f64> = row.try_get(col_idx).map_err(tib_get_err)?;
                builder.append_option(val);
            }
            Ok(Arc::new(builder.finish()))
        }
        ArrowDataType::Decimal128(precision, scale) => {
            let mut builder = Decimal128Builder::with_capacity(rows.len());
            builder = builder.with_precision_and_scale(*precision, *scale)?;
            for row in rows {
                let val: Option<Decimal> = row.try_get(col_idx).map_err(tib_get_err)?;
                match val {
                    Some(d) => {
                        let i128_val = decimal_to_i128(&d, *scale);
                        builder.append_value(i128_val);
                    }
                    None => builder.append_null(),
                }
            }
            Ok(Arc::new(builder.finish()))
        }
        ArrowDataType::Utf8 => {
            let mut builder = StringBuilder::with_capacity(rows.len(), rows.len() * 32);
            for row in rows {
                let val: Option<&str> = row.try_get(col_idx).map_err(tib_get_err)?;
                builder.append_option(val);
            }
            Ok(Arc::new(builder.finish()))
        }
        ArrowDataType::Boolean => {
            let mut builder = BooleanBuilder::with_capacity(rows.len());
            for row in rows {
                let val: Option<bool> = row.try_get(col_idx).map_err(tib_get_err)?;
                builder.append_option(val);
            }
            Ok(Arc::new(builder.finish()))
        }
        ArrowDataType::Date32 => {
            let mut builder = Date32Builder::with_capacity(rows.len());
            let epoch = NaiveDate::from_ymd_opt(1970, 1, 1).expect("valid epoch date");
            for row in rows {
                let val: Option<NaiveDate> = row.try_get(col_idx).map_err(tib_get_err)?;
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
            for row in rows {
                let val: Option<chrono::NaiveDateTime> =
                    row.try_get(col_idx).map_err(tib_get_err)?;
                match val {
                    Some(dt) => {
                        let micros = dt.and_utc().timestamp_micros();
                        builder.append_value(micros);
                    }
                    None => builder.append_null(),
                }
            }
            Ok(Arc::new(builder.finish()))
        }
        other => Err(ConnectorError::ArrowConversion(format!(
            "unsupported Arrow type: {other:?}"
        ))),
    }
}

/// Convert a `rust_decimal::Decimal` to an `i128` value at the given Arrow scale.
fn decimal_to_i128(d: &Decimal, target_scale: i8) -> i128 {
    let raw = d.mantissa();
    let d_scale = d.scale() as i8;
    let diff = target_scale - d_scale;
    if diff > 0 {
        raw * 10i128.pow(diff as u32)
    } else if diff < 0 {
        raw / 10i128.pow((-diff) as u32)
    } else {
        raw
    }
}

/// Convert a tiberius error into a `ConnectorError`.
fn tib_get_err(e: tiberius::error::Error) -> ConnectorError {
    ConnectorError::ArrowConversion(format!("failed to extract column value: {e}"))
}
