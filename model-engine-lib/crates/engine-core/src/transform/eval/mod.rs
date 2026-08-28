//! Evaluating a pipeline over real Arrow batches.
//!
//! [`apply_steps`] folds the steps over a batch, threading the **derived
//! schema** alongside the data. Carrying both is what lets each step ask its
//! input for a model-level type (which literal spelling a value needs, which
//! type the unpivoted columns must agree on) without converting Arrow types
//! back into model types and risking a different answer than derivation gave.
//!
//! Steps are dispatched to one of two backends — see
//! [`sql_steps`] and [`kernel_steps`] for why each step is where it is.

mod kernel_steps;
mod sql_steps;

#[cfg(test)]
mod eval_tests;

use arrow::record_batch::RecordBatch;

use crate::compute::udf::UdfRegistry;
use crate::error::{EngineError, EngineResult};
use crate::model::Column;
use crate::transform::schema::derive_step_schema;
use crate::transform::TransformStep;
use crate::types::DataType;

/// Build the runtime failure error, anchored to the step that raised it.
pub(crate) fn step_error(table: &str, step_index: usize, reason: impl Into<String>) -> EngineError {
    EngineError::TransformFailed {
        table: table.to_string(),
        step_index,
        reason: reason.into(),
    }
}

/// The model-level type of `name` in `columns`.
fn type_of(columns: &[Column], name: &str) -> Option<DataType> {
    columns
        .iter()
        .find(|c| c.name() == name)
        .map(|c| c.data_type().clone())
}

/// Apply `steps[..upto]` to `batch`.
///
/// `source_columns` is the model's record of the schema entering the
/// pipeline; the derived schema is folded forward from it step by step.
///
/// `upto` is how many steps to run — `steps.len()` for a full refresh, or a
/// smaller number to reproduce the pipeline as of a given step for a preview.
/// Values beyond the pipeline length are clamped.
///
/// The returned batch has the shape the pipeline produces, which is not
/// necessarily byte-identical to the table's declared Arrow schema (a
/// generated SQL statement may, for instance, widen an integer). Callers that
/// need the declared schema conform afterwards.
///
/// # Errors
///
/// [`EngineError::TransformFailed`] naming the step that failed, or
/// [`EngineError::InvalidTransform`] if a step cannot apply to the schema
/// reaching it (which model validation should already have caught, but a
/// hand-edited model file has not been through it).
pub async fn apply_steps(
    table: &str,
    batch: RecordBatch,
    source_columns: &[Column],
    steps: &[TransformStep],
    upto: usize,
    udfs: &UdfRegistry,
) -> EngineResult<RecordBatch> {
    let upto = upto.min(steps.len());
    let mut batch = batch;
    let mut columns = source_columns.to_vec();

    for (index, step) in steps.iter().take(upto).enumerate() {
        let output = derive_step_schema(table, index, &columns, step)?;
        batch = apply_one(table, index, batch, step, &columns, &output, udfs).await?;
        columns = output;
    }
    Ok(batch)
}

/// Apply a single step. `input`/`output` are the derived schemas either side
/// of it.
async fn apply_one(
    table: &str,
    index: usize,
    batch: RecordBatch,
    step: &TransformStep,
    input: &[Column],
    output: &[Column],
    udfs: &UdfRegistry,
) -> EngineResult<RecordBatch> {
    match step {
        // --- Arrow kernels ---
        TransformStep::RemoveColumns { .. } | TransformStep::SelectColumns { .. } => {
            // Derivation already worked out which columns survive and in what
            // order, so both steps are the same projection here.
            let keep: Vec<String> = output.iter().map(|c| c.name().to_string()).collect();
            kernel_steps::project(table, index, &batch, &keep)
        }
        TransformStep::RenameColumns { renames } => {
            kernel_steps::rename(table, index, &batch, renames)
        }
        TransformStep::ChangeType { changes, on_error } => {
            kernel_steps::change_type(table, index, &batch, changes, *on_error)
        }
        TransformStep::FillDown { columns } => {
            kernel_steps::fill_down(table, index, &batch, columns)
        }
        TransformStep::RemoveDuplicates { columns } => {
            kernel_steps::remove_duplicates(table, index, &batch, columns)
        }
        TransformStep::Sort { by } => kernel_steps::sort(table, index, &batch, by),
        TransformStep::KeepRows { range } => kernel_steps::keep_rows(&batch, range),
        TransformStep::RemoveRows { range } => kernel_steps::remove_rows(&batch, range),
        TransformStep::Unpivot {
            columns,
            name_column,
            value_column,
        } => {
            // Derivation chose the shared value type; the evaluator must use
            // exactly that, or the batch would not match the declared schema.
            let value_type = type_of(output, value_column).ok_or_else(|| {
                step_error(table, index, "the unpivot value column was not derived")
            })?;
            kernel_steps::unpivot(
                table,
                index,
                &batch,
                columns,
                name_column,
                value_column,
                &value_type,
            )
        }

        // --- Generated SQL ---
        // One context for every SQL-backed step: which table, which step, and
        // the UDFs its expressions may call.
        TransformStep::FilterRows { condition } => {
            let step = sql_steps::SqlStep { table, index, udfs };
            sql_steps::filter_rows(&step, batch, input, condition).await
        }
        TransformStep::AddColumn {
            name, expression, ..
        } => {
            let step = sql_steps::SqlStep { table, index, udfs };
            sql_steps::add_column(&step, batch, input, name, expression).await
        }
        TransformStep::TransformColumn {
            column,
            expression,
            data_type,
        } => {
            let step = sql_steps::SqlStep { table, index, udfs };
            sql_steps::transform_column(&step, batch, input, column, expression, data_type.as_ref())
                .await
        }
        TransformStep::SplitColumn {
            column,
            delimiter,
            parts,
            keep_original,
        } => {
            let step = sql_steps::SqlStep { table, index, udfs };
            sql_steps::split_column(&step, batch, column, delimiter, *parts, *keep_original).await
        }
        TransformStep::ReplaceValues {
            column,
            find,
            replace,
            match_entire_value,
        } => {
            let column_type = type_of(input, column)
                .ok_or_else(|| step_error(table, index, format!("no column '{column}'")))?;
            let step = sql_steps::SqlStep { table, index, udfs };
            sql_steps::replace_values(
                &step,
                batch,
                column,
                find,
                replace,
                *match_entire_value,
                &column_type,
            )
            .await
        }
        TransformStep::TextTransform { columns, operation } => {
            let step = sql_steps::SqlStep { table, index, udfs };
            sql_steps::text_transform(&step, batch, columns, *operation).await
        }
        TransformStep::GroupBy {
            group_by,
            aggregates,
        } => {
            let step = sql_steps::SqlStep { table, index, udfs };
            sql_steps::group_by(&step, batch, group_by, aggregates, input).await
        }
        TransformStep::Pivot {
            name_column,
            value_column,
            aggregate,
            value_names,
        } => {
            let step = sql_steps::SqlStep { table, index, udfs };
            sql_steps::pivot(
                &step,
                batch,
                name_column,
                value_column,
                *aggregate,
                value_names,
                input,
            )
            .await
        }
    }
}

/// Conform `batch` to the columns a table declares: select by name, cast to
/// the declared type, and order as declared.
///
/// Applied after a pipeline runs, for two reasons. The generated SQL steps
/// return whatever DataFusion computed (an integer sum may come back wider
/// than the model records), and the source itself may have drifted. Selecting
/// **by name** means a missing column is a loud, named error rather than a
/// silently mismatched positional read.
///
/// # Errors
///
/// [`EngineError::TransformFailed`] naming the missing or unconvertible
/// column. The step index reported is the last step, since conformance is the
/// pipeline's final act.
pub fn conform_to_declared(
    table: &str,
    last_step: usize,
    batch: &RecordBatch,
    declared: &[Column],
) -> EngineResult<RecordBatch> {
    use arrow::compute::{cast_with_options, CastOptions};
    use arrow::datatypes::{Field, Schema};

    let options = CastOptions {
        safe: false,
        format_options: Default::default(),
    };
    let mut fields: Vec<Field> = Vec::with_capacity(declared.len());
    let mut columns: Vec<arrow::array::ArrayRef> = Vec::with_capacity(declared.len());

    for column in declared {
        let index = batch.schema().index_of(column.name()).map_err(|_| {
            let produced = batch
                .schema()
                .fields()
                .iter()
                .map(|f| f.name().clone())
                .collect::<Vec<_>>()
                .join(", ");
            step_error(
                table,
                last_step,
                format!(
                    "the pipeline produced no column '{}' (produced: {produced}). \
                     The source's shape may have changed — refresh the table's \
                     source schema",
                    column.name()
                ),
            )
        })?;
        let target = column.data_type().to_arrow();
        let array = if batch.column(index).data_type() == &target {
            batch.column(index).clone()
        } else {
            cast_with_options(batch.column(index), &target, &options).map_err(|e| {
                step_error(
                    table,
                    last_step,
                    format!(
                        "column '{}' cannot be read as the declared type {:?}: {e}",
                        column.name(),
                        column.data_type()
                    ),
                )
            })?
        };
        // Widen the declared nullability if the data actually carries nulls:
        // an Arrow batch whose field claims non-null while the array has nulls
        // is invalid, and refusing here would be a worse answer than recording
        // the truth.
        let nullable = column.nullable() || array.null_count() > 0;
        fields.push(Field::new(column.name(), target, nullable));
        columns.push(array);
    }
    Ok(RecordBatch::try_new(
        std::sync::Arc::new(Schema::new(fields)),
        columns,
    )?)
}
