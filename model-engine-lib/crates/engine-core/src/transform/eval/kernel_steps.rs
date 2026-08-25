//! Steps evaluated with Arrow kernels directly.
//!
//! These steps go through kernels rather than generated SQL for one of two
//! reasons:
//!
//! - **Determinism.** `removeDuplicates` must keep the *first* occurrence and
//!   `sort` must produce one specific row order. SQL `DISTINCT` and DataFusion's
//!   partitioned execution promise neither.
//! - **Cost.** Dropping, reordering, renaming, and slicing columns are
//!   metadata operations over the same underlying buffers; routing them
//!   through a query engine would copy every value for no reason.

use std::collections::HashSet;
use std::sync::Arc;

use arrow::array::{Array, ArrayRef, StringArray, UInt32Array};
use arrow::compute::{cast_with_options, CastOptions};
use arrow::datatypes::{DataType as ArrowType, Field, Schema};
use arrow::record_batch::RecordBatch;

use crate::error::EngineResult;
use crate::transform::eval::step_error;
use crate::transform::parts::{CastErrorPolicy, ColumnRename, RowRange, SortKey, TypeChange};
use crate::types::DataType;

/// Index of a column by name, or a step-anchored error.
fn column_index(
    table: &str,
    step_index: usize,
    batch: &RecordBatch,
    name: &str,
) -> EngineResult<usize> {
    batch.schema().index_of(name).map_err(|_| {
        step_error(
            table,
            step_index,
            format!("the fetched data has no column '{name}'"),
        )
    })
}

/// Rebuild a batch from explicit fields and arrays.
fn rebuild(fields: Vec<Field>, columns: Vec<ArrayRef>) -> EngineResult<RecordBatch> {
    Ok(RecordBatch::try_new(
        Arc::new(Schema::new(fields)),
        columns,
    )?)
}

/// `removeColumns` / `selectColumns` — both are a projection by name.
pub(super) fn project(
    table: &str,
    step_index: usize,
    batch: &RecordBatch,
    keep: &[String],
) -> EngineResult<RecordBatch> {
    let indices: Vec<usize> = keep
        .iter()
        .map(|name| column_index(table, step_index, batch, name))
        .collect::<EngineResult<_>>()?;
    Ok(batch.project(&indices)?)
}

/// `renameColumns` — new field names over the same arrays (no data is copied).
pub(super) fn rename(
    table: &str,
    step_index: usize,
    batch: &RecordBatch,
    renames: &[ColumnRename],
) -> EngineResult<RecordBatch> {
    let mut fields: Vec<Field> = batch
        .schema()
        .fields()
        .iter()
        .map(|f| f.as_ref().clone())
        .collect();
    for rename in renames {
        let index = fields
            .iter()
            .position(|f| f.name() == &rename.from)
            .ok_or_else(|| {
                step_error(
                    table,
                    step_index,
                    format!("the fetched data has no column '{}'", rename.from),
                )
            })?;
        fields[index] = fields[index].clone().with_name(&rename.to);
    }
    rebuild(fields, batch.columns().to_vec())
}

/// `changeType`.
pub(super) fn change_type(
    table: &str,
    step_index: usize,
    batch: &RecordBatch,
    changes: &[TypeChange],
    on_error: CastErrorPolicy,
) -> EngineResult<RecordBatch> {
    let options = CastOptions {
        // `safe: true` substitutes null for an unconvertible value; `false`
        // raises, which is what the default Fail policy wants.
        safe: on_error == CastErrorPolicy::Null,
        format_options: Default::default(),
    };

    let mut fields: Vec<Field> = batch
        .schema()
        .fields()
        .iter()
        .map(|f| f.as_ref().clone())
        .collect();
    let mut columns = batch.columns().to_vec();

    for change in changes {
        let index = column_index(table, step_index, batch, &change.column)?;
        let target = change.new_type.to_arrow();
        let source_type = columns[index].data_type().clone();
        let cast = cast_with_options(&columns[index], &target, &options).map_err(|e| {
            step_error(
                table,
                step_index,
                format!(
                    "column '{}' has values that cannot be read as {:?} ({e}). \
                     Set the step's error handling to produce nulls instead, or \
                     clean the values first",
                    change.column, change.new_type
                ),
            )
        })?;

        // Arrow's `safe: false` does NOT make a fractional-to-integer cast an
        // error: it converts through `num::NumCast`, which truncates toward
        // zero and fails only on NaN/infinity/overflow. So 10.7 would become
        // 10 with no complaint — silently altering data under the one policy
        // whose whole contract is to stop instead. Casting back and comparing
        // is the only way to see the loss, so do it exactly where it can occur.
        let cast = if narrowing_can_truncate(&source_type, &target) {
            let round_trip = cast_with_options(&cast, &source_type, &options).map_err(|e| {
                step_error(
                    table,
                    step_index,
                    format!(
                        "column '{}' could not be checked for rounding: {e}",
                        change.column
                    ),
                )
            })?;
            let differs = arrow::compute::kernels::cmp::neq(&columns[index], &round_trip)?;
            match (differs.true_count(), on_error) {
                (0, _) => cast,
                // Fail: a value that has to be rounded is a value this policy
                // says the refresh must not invent.
                (lost, CastErrorPolicy::Fail) => {
                    return Err(step_error(
                        table,
                        step_index,
                        format!(
                            "column '{}' has {lost} value(s) that cannot become {:?} without \
                             rounding. Set the step's error handling to produce blanks instead, \
                             or round the values deliberately first",
                            change.column, change.new_type
                        ),
                    ));
                }
                // Null: "cannot be represented" is exactly what this policy
                // turns into a blank.
                (_, CastErrorPolicy::Null) => {
                    arrow::compute::kernels::nullif::nullif(&cast, &differs)?
                }
            }
        } else {
            cast
        };

        let nullable = fields[index].is_nullable() || on_error == CastErrorPolicy::Null;
        fields[index] = Field::new(fields[index].name(), target, nullable);
        columns[index] = cast;
    }
    rebuild(fields, columns)
}

/// `true` when a cast can silently ROUND rather than fail or succeed exactly.
///
/// Arrow reports overflow and unparseable text, but a fractional source
/// narrowed to an integer target converts by truncation with no error — the one
/// outcome a caller cannot detect from the cast's own result.
fn narrowing_can_truncate(from: &ArrowType, to: &ArrowType) -> bool {
    let fractional = matches!(
        from,
        ArrowType::Float16
            | ArrowType::Float32
            | ArrowType::Float64
            | ArrowType::Decimal128(_, _)
            | ArrowType::Decimal256(_, _)
    );
    let integral = matches!(
        to,
        ArrowType::Int8
            | ArrowType::Int16
            | ArrowType::Int32
            | ArrowType::Int64
            | ArrowType::UInt8
            | ArrowType::UInt16
            | ArrowType::UInt32
            | ArrowType::UInt64
    );
    fractional && integral
}

/// `fillDown` — carry the last non-null value forward, per column.
pub(super) fn fill_down(
    table: &str,
    step_index: usize,
    batch: &RecordBatch,
    columns: &[String],
) -> EngineResult<RecordBatch> {
    let rows = batch.num_rows();
    let mut arrays = batch.columns().to_vec();

    for name in columns {
        let index = column_index(table, step_index, batch, name)?;
        let array = &arrays[index];
        if array.null_count() == 0 {
            continue;
        }
        // One take-index per row: itself when non-null, otherwise the most
        // recent non-null row above it. A leading run of nulls has no source
        // and stays null by pointing at itself.
        let mut indices: Vec<u32> = Vec::with_capacity(rows);
        let mut last_valid: Option<u32> = None;
        for row in 0..rows {
            if array.is_valid(row) {
                last_valid = Some(row as u32);
                indices.push(row as u32);
            } else {
                indices.push(last_valid.unwrap_or(row as u32));
            }
        }
        arrays[index] = arrow::compute::take(array, &UInt32Array::from(indices), None)?;
    }
    Ok(RecordBatch::try_new(batch.schema(), arrays)?)
}

/// Take indices from `batch` in `order`, preserving the schema.
fn take_rows(batch: &RecordBatch, order: &UInt32Array) -> EngineResult<RecordBatch> {
    let columns = batch
        .columns()
        .iter()
        .map(|array| arrow::compute::take(array, order, None))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(RecordBatch::try_new(batch.schema(), columns)?)
}

/// `removeDuplicates` — keep the FIRST row of each group.
///
/// First-wins is why this is a kernel: it is a promise about *which* row
/// survives, and SQL `DISTINCT` makes no such promise.
pub(super) fn remove_duplicates(
    table: &str,
    step_index: usize,
    batch: &RecordBatch,
    subset: &[String],
) -> EngineResult<RecordBatch> {
    use arrow::row::{RowConverter, SortField};

    let indices: Vec<usize> = if subset.is_empty() {
        (0..batch.num_columns()).collect()
    } else {
        subset
            .iter()
            .map(|name| column_index(table, step_index, batch, name))
            .collect::<EngineResult<_>>()?
    };

    let arrays: Vec<ArrayRef> = indices.iter().map(|i| batch.column(*i).clone()).collect();
    let fields: Vec<SortField> = arrays
        .iter()
        .map(|a| SortField::new(a.data_type().clone()))
        .collect();
    let converter = RowConverter::new(fields)?;
    let rows = converter.convert_columns(&arrays)?;

    let mut seen: HashSet<Vec<u8>> = HashSet::with_capacity(batch.num_rows());
    let mut keep: Vec<u32> = Vec::with_capacity(batch.num_rows());
    for row in 0..batch.num_rows() {
        if seen.insert(rows.row(row).as_ref().to_vec()) {
            keep.push(row as u32);
        }
    }
    if keep.len() == batch.num_rows() {
        return Ok(batch.clone());
    }
    take_rows(batch, &UInt32Array::from(keep))
}

/// `sort`.
pub(super) fn sort(
    table: &str,
    step_index: usize,
    batch: &RecordBatch,
    by: &[SortKey],
) -> EngineResult<RecordBatch> {
    let columns: Vec<arrow::compute::SortColumn> = by
        .iter()
        .map(|key| {
            let index = column_index(table, step_index, batch, &key.column)?;
            Ok(arrow::compute::SortColumn {
                values: batch.column(index).clone(),
                options: Some(arrow::compute::SortOptions {
                    descending: key.descending,
                    // Nulls last in both directions: "no value" belongs at the
                    // bottom of a report whichever way the column is sorted.
                    nulls_first: false,
                }),
            })
        })
        .collect::<EngineResult<_>>()?;

    let order = arrow::compute::lexsort_to_indices(&columns, None)?;
    take_rows(batch, &order)
}

/// `keepRows` — a zero-copy slice.
pub(super) fn keep_rows(batch: &RecordBatch, range: &RowRange) -> EngineResult<RecordBatch> {
    let (offset, length) = range.resolve(batch.num_rows() as u64);
    Ok(batch.slice(offset as usize, length as usize))
}

/// `removeRows` — the slices on either side of the range, concatenated.
pub(super) fn remove_rows(batch: &RecordBatch, range: &RowRange) -> EngineResult<RecordBatch> {
    let rows = batch.num_rows() as u64;
    let (offset, length) = range.resolve(rows);
    if length == 0 {
        return Ok(batch.clone());
    }
    let head = batch.slice(0, offset as usize);
    let tail_start = offset + length;
    let tail = batch.slice(tail_start as usize, (rows - tail_start) as usize);
    Ok(arrow::compute::concat_batches(
        &batch.schema(),
        &[head, tail],
    )?)
}

/// `unpivot` — one output row per (input row, unpivoted column) pair.
pub(super) fn unpivot(
    table: &str,
    step_index: usize,
    batch: &RecordBatch,
    columns: &[String],
    name_column: &str,
    value_column: &str,
    value_type: &DataType,
) -> EngineResult<RecordBatch> {
    let rows = batch.num_rows();
    let width = columns.len();

    let unpivoted: Vec<usize> = columns
        .iter()
        .map(|name| column_index(table, step_index, batch, name))
        .collect::<EngineResult<_>>()?;
    let kept: Vec<usize> = (0..batch.num_columns())
        .filter(|i| !unpivoted.contains(i))
        .collect();

    // Row i of the input becomes rows [i*width, (i+1)*width) of the output, so
    // each kept column repeats its value `width` times.
    let repeat: UInt32Array = (0..rows)
        .flat_map(|row| std::iter::repeat_n(row as u32, width))
        .collect::<Vec<u32>>()
        .into();

    let mut fields: Vec<Field> = Vec::with_capacity(kept.len() + 2);
    let mut arrays: Vec<ArrayRef> = Vec::with_capacity(kept.len() + 2);
    for index in &kept {
        let field = batch.schema().field(*index).clone();
        arrays.push(arrow::compute::take(batch.column(*index), &repeat, None)?);
        fields.push(field);
    }

    // The attribute-name column cycles through the unpivoted column names.
    let names: StringArray = (0..rows)
        .flat_map(|_| columns.iter().map(|c| Some(c.as_str())))
        .collect::<Vec<_>>()
        .into();
    fields.push(Field::new(
        name_column,
        arrow::datatypes::DataType::Utf8,
        false,
    ));
    arrays.push(Arc::new(names));

    // One value column has to hold every unpivoted column's values, so they
    // are cast to the shared type derivation chose before being interleaved.
    let target = value_type.to_arrow();
    let cast_options = CastOptions {
        safe: false,
        format_options: Default::default(),
    };
    let sources: Vec<ArrayRef> = unpivoted
        .iter()
        .map(|index| {
            cast_with_options(batch.column(*index), &target, &cast_options).map_err(|e| {
                step_error(
                    table,
                    step_index,
                    format!("cannot combine the unpivoted columns into one value column: {e}"),
                )
            })
        })
        .collect::<EngineResult<_>>()?;
    let source_refs: Vec<&dyn Array> = sources.iter().map(|a| a.as_ref()).collect();
    let picks: Vec<(usize, usize)> = (0..rows)
        .flat_map(|row| (0..width).map(move |column| (column, row)))
        .collect();
    fields.push(Field::new(value_column, target, true));
    arrays.push(arrow::compute::interleave(&source_refs, &picks)?);

    rebuild(fields, arrays)
}
