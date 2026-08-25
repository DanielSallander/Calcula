//! Steps evaluated by generating one DataFusion SQL statement over the batch.
//!
//! Every identifier and literal reaching this SQL comes from a model file — a
//! trust boundary — so **nothing** is interpolated raw: identifiers go through
//! [`quote_ident_double`], literals through [`sql_quote_literal`], and
//! expressions through the shared [`SqlRenderer`], exactly as the rest of the
//! engine's SQL-generating paths do.

use arrow::record_batch::RecordBatch;

use crate::compute::aggregate::AggregateOp;
use crate::compute::parser::parse_refresh_filter;
use crate::compute::sql_util::{quote_ident_double, sql_quote_literal};
use crate::compute::udf::{session_context_with_udfs, UdfRegistry};
use crate::error::EngineResult;
use crate::transform::eval::step_error;
use crate::transform::parts::{GroupAggregate, TextOp};
use crate::types::DataType;

/// The name the input batch is registered under. Underscore-prefixed so it
/// cannot collide with a model table name in the same context.
const INPUT: &str = "_t";

/// The context every SQL step threads through: which table is being
/// transformed, which step is running, and the UDFs its expressions may call.
///
/// Bundled rather than passed as three parameters because they travel together
/// through every function here — and because a step that needs its own operands
/// as well would otherwise run past a reasonable argument count.
pub(super) struct SqlStep<'a> {
    /// The model table being transformed (error messages only).
    pub table: &'a str,
    /// Zero-based index of the running step (error messages only).
    pub index: usize,
    /// The effective UDF registry, so a step's expression can call a model
    /// script function exactly as a measure can.
    pub udfs: &'a UdfRegistry,
}

impl SqlStep<'_> {
    /// Build this step's runtime failure error.
    fn error(&self, reason: impl Into<String>) -> crate::error::EngineError {
        step_error(self.table, self.index, reason)
    }
}

/// Run one generated statement over `batch` and return the result as a single
/// batch.
async fn run_sql(step: &SqlStep<'_>, batch: RecordBatch, sql: &str) -> EngineResult<RecordBatch> {
    let ctx = session_context_with_udfs(step.udfs);
    ctx.register_batch(INPUT, batch)?;
    let frame = ctx.sql(sql).await.map_err(|e| step.error(format!("{e}")))?;
    let schema: arrow::datatypes::SchemaRef =
        std::sync::Arc::new(frame.schema().as_arrow().clone());
    let batches = frame
        .collect()
        .await
        .map_err(|e| step.error(format!("{e}")))?;

    match batches.len() {
        // An empty result still has to carry the statement's schema, or the
        // next step would see a batch with no columns.
        0 => Ok(RecordBatch::new_empty(schema)),
        1 => Ok(batches.into_iter().next().expect("length checked")),
        _ => {
            let schema = batches[0].schema();
            Ok(arrow::compute::concat_batches(&schema, &batches)?)
        }
    }
}

/// Render a step's expression source as a SQL fragment.
///
/// Model build-time validation already established that the expression parses
/// and is row-level; this re-parses because the pipeline stores text, and
/// fails with a step-anchored error if a hand-edited model file slipped
/// something through.
fn expression_sql(step: &SqlStep<'_>, source: &str) -> EngineResult<String> {
    let parsed = parse_refresh_filter(source).map_err(|e| step.error(format!("{e}")))?;
    parsed
        .to_sql_string()
        .map_err(|e| step.error(format!("{e}")))
}

/// Every column of `batch`, quoted, with `overrides` substituted by name.
///
/// The shared shape of the in-place value steps: they rewrite one or more
/// columns and pass the rest through, preserving column order.
fn select_list_with(batch: &RecordBatch, overrides: &[(String, String)]) -> String {
    batch
        .schema()
        .fields()
        .iter()
        .map(|field| {
            let name = field.name();
            match overrides.iter().find(|(column, _)| column == name) {
                Some((_, sql)) => format!("{sql} AS {}", quote_ident_double(name)),
                None => quote_ident_double(name),
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// `filterRows`.
pub(super) async fn filter_rows(
    step: &SqlStep<'_>,
    batch: RecordBatch,
    condition: &str,
) -> EngineResult<RecordBatch> {
    let predicate = expression_sql(step, condition)?;
    let sql = format!("SELECT * FROM {INPUT} WHERE {predicate}");
    run_sql(step, batch, &sql).await
}

/// `addColumn`.
pub(super) async fn add_column(
    step: &SqlStep<'_>,
    batch: RecordBatch,
    name: &str,
    expression: &str,
) -> EngineResult<RecordBatch> {
    let value = expression_sql(step, expression)?;
    let sql = format!(
        "SELECT *, {value} AS {} FROM {INPUT}",
        quote_ident_double(name)
    );
    run_sql(step, batch, &sql).await
}

/// `splitColumn`.
pub(super) async fn split_column(
    step: &SqlStep<'_>,
    batch: RecordBatch,
    column: &str,
    delimiter: &str,
    parts: u32,
    keep_original: bool,
) -> EngineResult<RecordBatch> {
    let quoted = quote_ident_double(column);
    let delimiter_literal = sql_quote_literal(delimiter);

    let mut select: Vec<String> = Vec::with_capacity(batch.num_columns() + parts as usize);
    for field in batch.schema().fields() {
        if field.name() != column {
            select.push(quote_ident_double(field.name()));
            continue;
        }
        if keep_original {
            select.push(quoted.clone());
        }
        for part in 1..=parts {
            // An absent part comes back as the empty string from split_part;
            // NULLIF turns that into a null, which is what "no value" means
            // in a column.
            select.push(format!(
                "NULLIF(split_part({quoted}, {delimiter_literal}, {part}), '') AS {}",
                quote_ident_double(&format!("{column}.{part}"))
            ));
        }
    }
    let sql = format!("SELECT {} FROM {INPUT}", select.join(", "));
    run_sql(step, batch, &sql).await
}

/// `replaceValues`.
pub(super) async fn replace_values(
    step: &SqlStep<'_>,
    batch: RecordBatch,
    column: &str,
    find: &str,
    replace: &str,
    match_entire_value: bool,
    column_type: &DataType,
) -> EngineResult<RecordBatch> {
    let quoted = quote_ident_double(column);
    let rewritten = if match_entire_value {
        // Whole-value replacement compares against a typed literal, so it
        // works on numbers and dates as well as text.
        let literal = |text: &str| -> String {
            if column_type.needs_sql_quoting() {
                sql_quote_literal(text)
            } else {
                text.to_string()
            }
        };
        format!(
            "CASE WHEN {quoted} = {} THEN {} ELSE {quoted} END",
            literal(find),
            literal(replace)
        )
    } else {
        format!(
            "REPLACE({quoted}, {}, {})",
            sql_quote_literal(find),
            sql_quote_literal(replace)
        )
    };

    let sql = format!(
        "SELECT {} FROM {INPUT}",
        select_list_with(&batch, &[(column.to_string(), rewritten)])
    );
    run_sql(step, batch, &sql).await
}

/// `textTransform`.
pub(super) async fn text_transform(
    step: &SqlStep<'_>,
    batch: RecordBatch,
    columns: &[String],
    operation: TextOp,
) -> EngineResult<RecordBatch> {
    let overrides: Vec<(String, String)> = columns
        .iter()
        .map(|column| {
            let quoted = quote_ident_double(column);
            let sql = match operation {
                TextOp::Trim => format!("TRIM({quoted})"),
                // POSIX class rather than an escaped character range: the
                // literal control characters would have to survive being
                // written into a SQL string, and `[[:cntrl:]]` says what is
                // meant.
                TextOp::Clean => format!("regexp_replace({quoted}, '[[:cntrl:]]', '', 'g')"),
                TextOp::Upper => format!("UPPER({quoted})"),
                TextOp::Lower => format!("LOWER({quoted})"),
            };
            (column.clone(), sql)
        })
        .collect();

    let sql = format!(
        "SELECT {} FROM {INPUT}",
        select_list_with(&batch, &overrides)
    );
    run_sql(step, batch, &sql).await
}

/// Render one aggregate over a quoted operand.
fn aggregate_sql(aggregate: &GroupAggregate) -> String {
    if aggregate.function == AggregateOp::CountRows {
        AggregateOp::CountRows.render_sql("*")
    } else {
        aggregate
            .function
            .render_sql(&quote_ident_double(&aggregate.column))
    }
}

/// `groupBy`.
pub(super) async fn group_by(
    step: &SqlStep<'_>,
    batch: RecordBatch,
    keys: &[String],
    aggregates: &[GroupAggregate],
) -> EngineResult<RecordBatch> {
    let quoted_keys: Vec<String> = keys.iter().map(|k| quote_ident_double(k)).collect();

    let mut select = quoted_keys.clone();
    for aggregate in aggregates {
        select.push(format!(
            "{} AS {}",
            aggregate_sql(aggregate),
            quote_ident_double(&aggregate.alias)
        ));
    }

    let mut sql = format!("SELECT {} FROM {INPUT}", select.join(", "));
    if !quoted_keys.is_empty() {
        sql.push_str(&format!(" GROUP BY {}", quoted_keys.join(", ")));
    }
    run_sql(step, batch, &sql).await
}

/// `pivot`.
pub(super) async fn pivot(
    step: &SqlStep<'_>,
    batch: RecordBatch,
    name_column: &str,
    value_column: &str,
    aggregate: AggregateOp,
    value_names: &[String],
) -> EngineResult<RecordBatch> {
    let quoted_name = quote_ident_double(name_column);
    let quoted_value = quote_ident_double(value_column);

    // Everything that is neither the name nor the value column becomes the
    // group — the same rule schema derivation used.
    let group: Vec<String> = batch
        .schema()
        .fields()
        .iter()
        .filter(|f| f.name() != name_column && f.name() != value_column)
        .map(|f| quote_ident_double(f.name()))
        .collect();

    let mut select = group.clone();
    for value_name in value_names {
        let cell = format!(
            "CASE WHEN {quoted_name} = {} THEN {quoted_value} END",
            sql_quote_literal(value_name)
        );
        select.push(format!(
            "{} AS {}",
            aggregate.render_sql(&cell),
            quote_ident_double(value_name)
        ));
    }

    let mut sql = format!("SELECT {} FROM {INPUT}", select.join(", "));
    if !group.is_empty() {
        sql.push_str(&format!(" GROUP BY {}", group.join(", ")));
    }
    run_sql(step, batch, &sql).await
}
