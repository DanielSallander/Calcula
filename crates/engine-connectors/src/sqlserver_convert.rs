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
use tiberius::{ColumnType as TibColumnType, Row as TibRow};

use crate::decimal::{decimal_to_i128, f64_to_scaled_i128};
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

    // Get TDS column types from the first row so each column is decoded with
    // the type tiberius actually delivers (its `FromSql` impls are strict:
    // e.g. `i32` does not match a smallint's `ColumnData::I16`).
    let col_types: Vec<TibColumnType> = rows[0].columns().iter().map(|c| c.column_type()).collect();

    for (col_idx, field) in schema.fields().iter().enumerate() {
        let col_type = col_types
            .get(col_idx)
            .copied()
            .unwrap_or(TibColumnType::Null);
        let array = build_column_array(rows, col_idx, field.data_type(), col_type)?;
        columns.push(array);
    }

    RecordBatch::try_new(Arc::new(schema.clone()), columns).map_err(ConnectorError::from)
}

/// Build a single Arrow array from a column of tiberius rows.
///
/// The `col_type` parameter is the TDS column type reported by the server,
/// used to choose the correct tiberius decode type (mirroring the `pg_type`
/// dispatch in `arrow_convert`).
fn build_column_array(
    rows: &[TibRow],
    col_idx: usize,
    arrow_type: &ArrowDataType,
    col_type: TibColumnType,
) -> ConnectorResult<ArrayRef> {
    match arrow_type {
        ArrowDataType::Int32 => {
            let mut builder = Int32Builder::with_capacity(rows.len());
            match col_type {
                // smallint arrives as ColumnData::I16; decode i16, widen.
                TibColumnType::Int2 => {
                    for row in rows {
                        let val: Option<i16> = row.try_get(col_idx).map_err(tib_get_err)?;
                        builder.append_option(val.map(i32::from));
                    }
                }
                // tinyint arrives as ColumnData::U8; decode u8, widen.
                TibColumnType::Int1 => {
                    for row in rows {
                        let val: Option<u8> = row.try_get(col_idx).map_err(tib_get_err)?;
                        builder.append_option(val.map(i32::from));
                    }
                }
                _ => {
                    for row in rows {
                        let val: Option<i32> = row.try_get(col_idx).map_err(tib_get_err)?;
                        builder.append_option(val);
                    }
                }
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
            // real arrives as ColumnData::F32; decode f32, widen to f64.
            if col_type == TibColumnType::Float4 {
                for row in rows {
                    let val: Option<f32> = row.try_get(col_idx).map_err(tib_get_err)?;
                    builder.append_option(val.map(f64::from));
                }
            } else {
                for row in rows {
                    let val: Option<f64> = row.try_get(col_idx).map_err(tib_get_err)?;
                    builder.append_option(val);
                }
            }
            Ok(Arc::new(builder.finish()))
        }
        ArrowDataType::Decimal128(precision, scale) => {
            let mut builder = Decimal128Builder::with_capacity(rows.len());
            builder = builder.with_precision_and_scale(*precision, *scale)?;
            match col_type {
                // money/smallmoney arrive as ColumnData::F64 (tiberius
                // decodes the raw fixed-point integer divided by 1e4), so
                // they cannot be read as rust_decimal::Decimal.
                TibColumnType::Money | TibColumnType::Money4 => {
                    for row in rows {
                        let val: Option<f64> = row.try_get(col_idx).map_err(tib_get_err)?;
                        match val {
                            Some(v) => builder.append_value(f64_to_scaled_i128(v, *scale)?),
                            None => builder.append_null(),
                        }
                    }
                }
                _ => {
                    for row in rows {
                        let val: Option<Decimal> = row.try_get(col_idx).map_err(tib_get_err)?;
                        match val {
                            Some(d) => {
                                let i128_val = decimal_to_i128(&d, *scale)?;
                                builder.append_value(i128_val);
                            }
                            None => builder.append_null(),
                        }
                    }
                }
            }
            Ok(Arc::new(builder.finish()))
        }
        ArrowDataType::Utf8 => {
            let mut builder = StringBuilder::with_capacity(rows.len(), rows.len() * 32);
            // uniqueidentifier arrives as ColumnData::Guid and cannot be
            // decoded as &str; decode the Uuid and render it as text.
            if col_type == TibColumnType::Guid {
                for row in rows {
                    let val: Option<tiberius::Uuid> = row.try_get(col_idx).map_err(tib_get_err)?;
                    builder.append_option(val.map(|u| u.to_string()));
                }
            } else {
                for row in rows {
                    let val: Option<&str> = row.try_get(col_idx).map_err(tib_get_err)?;
                    builder.append_option(val);
                }
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
            // datetimeoffset arrives as ColumnData::DateTimeOffset, which
            // tiberius only decodes via DateTime<Utc> (normalizing to UTC);
            // NaiveDateTime does not match it.
            if col_type == TibColumnType::DatetimeOffsetn {
                for row in rows {
                    let val: Option<chrono::DateTime<chrono::Utc>> =
                        row.try_get(col_idx).map_err(tib_get_err)?;
                    builder.append_option(val.map(|dt| dt.timestamp_micros()));
                }
            } else {
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
            }
            Ok(Arc::new(builder.finish()))
        }
        other => Err(ConnectorError::ArrowConversion(format!(
            "unsupported Arrow type: {other:?}"
        ))),
    }
}

/// Convert a tiberius error into a `ConnectorError`.
fn tib_get_err(e: tiberius::error::Error) -> ConnectorError {
    ConnectorError::ArrowConversion(format!("failed to extract column value: {e}"))
}
