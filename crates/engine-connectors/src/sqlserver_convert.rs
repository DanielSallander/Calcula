//! Conversion from tiberius SQL Server rows to Arrow `RecordBatch` values.
//!
//! All the shared builder/chunking/decimal logic lives in [`crate::arrow_build`];
//! this module only implements the thin [`RowReader`] over `tiberius::Row`,
//! handling the TDS wire-type quirks (smallint/tinyint, `real`, `money`,
//! `uniqueidentifier`, `datetimeoffset`).

use arrow::datatypes::Schema;
use arrow::record_batch::RecordBatch;
use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use rust_decimal::Decimal;
use tiberius::{ColumnType as TibColumnType, Row as TibRow};

use crate::arrow_build::RowReader;
use crate::decimal::{decimal_to_i128, f64_to_scaled_i128};
use crate::error::{ConnectorError, ConnectorResult};

/// Convert tiberius rows into Arrow `RecordBatch` values.
///
/// The `schema` determines the Arrow data type used for each column.
pub fn tiberius_rows_to_record_batches(
    rows: &[TibRow],
    schema: &Schema,
) -> ConnectorResult<Vec<RecordBatch>> {
    crate::arrow_build::rows_to_record_batches::<TibReader>(rows, schema)
}

/// [`RowReader`] over tiberius SQL Server rows. The hint is the TDS
/// [`ColumnType`](TibColumnType) reported by the server, used to pick the
/// correct tiberius decode type — its `FromSql` impls are strict (e.g. `i32`
/// does not match a smallint's `ColumnData::I16`).
struct TibReader;

impl RowReader for TibReader {
    type Row = TibRow;
    type Hint = TibColumnType;

    fn default_hint() -> TibColumnType {
        TibColumnType::Null
    }

    fn column_hints(first_row: &TibRow) -> Vec<TibColumnType> {
        first_row
            .columns()
            .iter()
            .map(|c| c.column_type())
            .collect()
    }

    fn get_i32(row: &TibRow, col: usize, hint: &TibColumnType) -> ConnectorResult<Option<i32>> {
        match hint {
            // smallint arrives as ColumnData::I16; decode i16, widen.
            TibColumnType::Int2 => {
                let val: Option<i16> = row.try_get(col).map_err(tib_get_err)?;
                Ok(val.map(i32::from))
            }
            // tinyint arrives as ColumnData::U8; decode u8, widen.
            TibColumnType::Int1 => {
                let val: Option<u8> = row.try_get(col).map_err(tib_get_err)?;
                Ok(val.map(i32::from))
            }
            _ => row.try_get(col).map_err(tib_get_err),
        }
    }

    fn get_i64(row: &TibRow, col: usize) -> ConnectorResult<Option<i64>> {
        row.try_get(col).map_err(tib_get_err)
    }

    fn get_f64(row: &TibRow, col: usize, hint: &TibColumnType) -> ConnectorResult<Option<f64>> {
        // real arrives as ColumnData::F32; decode f32, widen to f64.
        if *hint == TibColumnType::Float4 {
            let val: Option<f32> = row.try_get(col).map_err(tib_get_err)?;
            Ok(val.map(f64::from))
        } else {
            row.try_get(col).map_err(tib_get_err)
        }
    }

    fn get_decimal_i128(
        row: &TibRow,
        col: usize,
        scale: i8,
        hint: &TibColumnType,
    ) -> ConnectorResult<Option<i128>> {
        match hint {
            // money/smallmoney arrive as ColumnData::F64 (tiberius decodes the
            // raw fixed-point integer divided by 1e4), so they cannot be read
            // as rust_decimal::Decimal.
            TibColumnType::Money | TibColumnType::Money4 => {
                let val: Option<f64> = row.try_get(col).map_err(tib_get_err)?;
                val.map(|v| f64_to_scaled_i128(v, scale)).transpose()
            }
            _ => {
                let val: Option<Decimal> = row.try_get(col).map_err(tib_get_err)?;
                val.map(|d| decimal_to_i128(&d, scale)).transpose()
            }
        }
    }

    fn get_string(
        row: &TibRow,
        col: usize,
        hint: &TibColumnType,
    ) -> ConnectorResult<Option<String>> {
        // uniqueidentifier arrives as ColumnData::Guid and cannot be decoded as
        // &str; decode the Uuid and render it as text.
        if *hint == TibColumnType::Guid {
            let val: Option<tiberius::Uuid> = row.try_get(col).map_err(tib_get_err)?;
            Ok(val.map(|u| u.to_string()))
        } else {
            let val: Option<&str> = row.try_get(col).map_err(tib_get_err)?;
            Ok(val.map(|s| s.to_string()))
        }
    }

    fn get_bool(row: &TibRow, col: usize) -> ConnectorResult<Option<bool>> {
        row.try_get(col).map_err(tib_get_err)
    }

    fn get_date(row: &TibRow, col: usize) -> ConnectorResult<Option<NaiveDate>> {
        row.try_get(col).map_err(tib_get_err)
    }

    fn get_timestamp_micros(
        row: &TibRow,
        col: usize,
        hint: &TibColumnType,
    ) -> ConnectorResult<Option<i64>> {
        // datetimeoffset arrives as ColumnData::DateTimeOffset, which tiberius
        // only decodes via DateTime<Utc> (normalizing to UTC); NaiveDateTime
        // does not match it.
        if *hint == TibColumnType::DatetimeOffsetn {
            let val: Option<DateTime<Utc>> = row.try_get(col).map_err(tib_get_err)?;
            Ok(val.map(|dt| dt.timestamp_micros()))
        } else {
            let val: Option<NaiveDateTime> = row.try_get(col).map_err(tib_get_err)?;
            Ok(val.map(|dt| dt.and_utc().timestamp_micros()))
        }
    }
}

/// Convert a tiberius error into a `ConnectorError`.
fn tib_get_err(e: tiberius::error::Error) -> ConnectorError {
    ConnectorError::ArrowConversion(format!("failed to extract column value: {e}"))
}
