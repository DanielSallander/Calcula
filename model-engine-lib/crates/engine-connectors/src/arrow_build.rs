//! Driver-agnostic conversion from database rows to Arrow `RecordBatch` values.
//!
//! Every SQL connector reads rows from its own driver type (`sqlx::PgRow`,
//! `tiberius::Row`, …) whose decoders have vendor-specific wire-type quirks
//! (smallint vs int, `real` vs `double`, `money`, `uuid`, `timestamptz`, …).
//! Rather than re-implement the whole Arrow-builder dispatch per connector,
//! each connector implements the thin [`RowReader`] trait — typed getters that
//! hide *its* driver and quirks — and this module's generic
//! [`rows_to_record_batches`] owns everything shared: chunking, the Arrow-type
//! dispatch, the 1970-epoch `Date32` math, the microsecond timestamp packing,
//! and (via [`crate::decimal`]) the decimal rescaling.
//!
//! Adding a new SQL connector's row→Arrow path is then ~30 lines of `try_get`
//! wrappers, not the ~150-line builder match it would otherwise duplicate.

use std::sync::Arc;

use arrow::array::{
    ArrayRef, BooleanBuilder, Date32Builder, Decimal128Builder, Float64Builder, Int32Builder,
    Int64Builder, StringBuilder, TimestampMicrosecondBuilder,
};
use arrow::datatypes::{DataType as ArrowDataType, Schema, TimeUnit};
use arrow::record_batch::RecordBatch;
use chrono::NaiveDate;

use crate::error::{ConnectorError, ConnectorResult};

/// Maximum rows per `RecordBatch` when converting large result sets.
const BATCH_SIZE: usize = 8192;

/// A connector's bridge from its driver's row type to typed Arrow values.
///
/// Implementations are thin: each getter reads one column of one row at the
/// type the connector's Arrow schema asked for, transparently handling that
/// driver's wire-type quirks using the per-column [`Hint`](Self::Hint)
/// captured once from the first row. Getters return `None` for SQL `NULL`.
///
/// The methods are associated functions (no `self`) — a connector's reader is
/// a zero-sized marker; all per-call state is the row, column index, and hint.
pub(crate) trait RowReader {
    /// The driver's row type (e.g. `sqlx::postgres::PgRow`).
    type Row;
    /// A per-column wire-type hint (e.g. the uppercase PG type name, or the
    /// TDS `ColumnType`) the getters consult to pick the right decode type.
    type Hint;

    /// The hint used for a column the first row did not describe (defensive;
    /// the row's columns normally align with the schema).
    fn default_hint() -> Self::Hint;

    /// Capture the per-column wire-type hints from the first row.
    fn column_hints(first_row: &Self::Row) -> Vec<Self::Hint>;

    fn get_i32(row: &Self::Row, col: usize, hint: &Self::Hint) -> ConnectorResult<Option<i32>>;
    fn get_i64(row: &Self::Row, col: usize) -> ConnectorResult<Option<i64>>;
    fn get_f64(row: &Self::Row, col: usize, hint: &Self::Hint) -> ConnectorResult<Option<f64>>;
    /// Read a decimal column as an `i128` mantissa already rescaled to the Arrow
    /// column's `scale` (using the shared [`crate::decimal`] helpers). This is
    /// where a vendor decides between a native decimal and, e.g., a `money`
    /// column decoded as `f64`.
    fn get_decimal_i128(
        row: &Self::Row,
        col: usize,
        scale: i8,
        hint: &Self::Hint,
    ) -> ConnectorResult<Option<i128>>;
    fn get_string(
        row: &Self::Row,
        col: usize,
        hint: &Self::Hint,
    ) -> ConnectorResult<Option<String>>;
    fn get_bool(row: &Self::Row, col: usize) -> ConnectorResult<Option<bool>>;
    fn get_date(row: &Self::Row, col: usize) -> ConnectorResult<Option<NaiveDate>>;
    fn get_timestamp_micros(
        row: &Self::Row,
        col: usize,
        hint: &Self::Hint,
    ) -> ConnectorResult<Option<i64>>;
}

/// Convert driver rows into Arrow `RecordBatch` values, chunked into batches of
/// up to [`BATCH_SIZE`] rows. The `schema` chooses the Arrow type per column.
pub(crate) fn rows_to_record_batches<R: RowReader>(
    rows: &[R::Row],
    schema: &Schema,
) -> ConnectorResult<Vec<RecordBatch>> {
    if rows.is_empty() {
        return Ok(vec![RecordBatch::new_empty(Arc::new(schema.clone()))]);
    }
    let hints = R::column_hints(&rows[0]);
    let mut batches = Vec::new();
    for chunk in rows.chunks(BATCH_SIZE) {
        batches.push(chunk_to_record_batch::<R>(chunk, schema, &hints)?);
    }
    Ok(batches)
}

fn chunk_to_record_batch<R: RowReader>(
    rows: &[R::Row],
    schema: &Schema,
    hints: &[R::Hint],
) -> ConnectorResult<RecordBatch> {
    let mut columns: Vec<ArrayRef> = Vec::with_capacity(schema.fields().len());
    for (col_idx, field) in schema.fields().iter().enumerate() {
        columns.push(build_column_array::<R>(
            rows,
            col_idx,
            field.data_type(),
            hints.get(col_idx),
        )?);
    }
    RecordBatch::try_new(Arc::new(schema.clone()), columns).map_err(ConnectorError::from)
}

fn build_column_array<R: RowReader>(
    rows: &[R::Row],
    col: usize,
    arrow_type: &ArrowDataType,
    hint: Option<&R::Hint>,
) -> ConnectorResult<ArrayRef> {
    let default = R::default_hint();
    let hint = hint.unwrap_or(&default);
    match arrow_type {
        ArrowDataType::Int32 => {
            let mut builder = Int32Builder::with_capacity(rows.len());
            for row in rows {
                builder.append_option(R::get_i32(row, col, hint)?);
            }
            Ok(Arc::new(builder.finish()))
        }
        ArrowDataType::Int64 => {
            let mut builder = Int64Builder::with_capacity(rows.len());
            for row in rows {
                builder.append_option(R::get_i64(row, col)?);
            }
            Ok(Arc::new(builder.finish()))
        }
        ArrowDataType::Float64 => {
            let mut builder = Float64Builder::with_capacity(rows.len());
            for row in rows {
                builder.append_option(R::get_f64(row, col, hint)?);
            }
            Ok(Arc::new(builder.finish()))
        }
        ArrowDataType::Decimal128(precision, scale) => {
            let mut builder = Decimal128Builder::with_capacity(rows.len());
            builder = builder.with_precision_and_scale(*precision, *scale)?;
            for row in rows {
                match R::get_decimal_i128(row, col, *scale, hint)? {
                    Some(v) => builder.append_value(v),
                    None => builder.append_null(),
                }
            }
            Ok(Arc::new(builder.finish()))
        }
        ArrowDataType::Utf8 => {
            let mut builder = StringBuilder::with_capacity(rows.len(), rows.len() * 32);
            for row in rows {
                builder.append_option(R::get_string(row, col, hint)?);
            }
            Ok(Arc::new(builder.finish()))
        }
        ArrowDataType::Boolean => {
            let mut builder = BooleanBuilder::with_capacity(rows.len());
            for row in rows {
                builder.append_option(R::get_bool(row, col)?);
            }
            Ok(Arc::new(builder.finish()))
        }
        ArrowDataType::Date32 => {
            let mut builder = Date32Builder::with_capacity(rows.len());
            let epoch = NaiveDate::from_ymd_opt(1970, 1, 1).expect("valid epoch date");
            for row in rows {
                match R::get_date(row, col)? {
                    Some(d) => builder.append_value((d - epoch).num_days() as i32),
                    None => builder.append_null(),
                }
            }
            Ok(Arc::new(builder.finish()))
        }
        ArrowDataType::Timestamp(TimeUnit::Microsecond, _) => {
            let mut builder = TimestampMicrosecondBuilder::with_capacity(rows.len());
            for row in rows {
                builder.append_option(R::get_timestamp_micros(row, col, hint)?);
            }
            Ok(Arc::new(builder.finish()))
        }
        other => Err(ConnectorError::ArrowConversion(format!(
            "unsupported Arrow type: {other:?}"
        ))),
    }
}
