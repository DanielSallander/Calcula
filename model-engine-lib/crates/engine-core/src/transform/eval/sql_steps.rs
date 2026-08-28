//! Steps evaluated by generating one DataFusion SQL statement over the batch.
//!
//! Every identifier and literal reaching this SQL comes from a model file — a
//! trust boundary — so **nothing** is interpolated raw: identifiers go through
//! [`quote_ident_double`], literals through [`sql_quote_literal`], and
//! expressions through the shared [`SqlRenderer`], exactly as the rest of the
//! engine's SQL-generating paths do.

use arrow::record_batch::RecordBatch;

use crate::compute::aggregate::AggregateOp;
use crate::compute::sql_util::{quote_ident_double, sql_quote_literal};
use crate::compute::udf::{session_context_with_udfs, UdfRegistry};
use crate::error::EngineResult;
use crate::model::Column;
use crate::transform::eval::step_error;
use crate::transform::infer::infer_parsed_type;
use crate::transform::literal::typed_sql_literal;
use crate::transform::parts::{GroupAggregate, LookupKey, LookupTake, TextOp};
use crate::transform::rules_rows::aggregate_output_type;
use crate::transform::validate::parse_row_expression;
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
    run_sql_inner(step, batch, None, sql).await
}

/// [`run_sql`] with a second table registered as the lookup target.
///
/// Separate rather than an `Option` on every call because exactly one step
/// needs it, and the registration name is part of the SQL those statements
/// generate.
async fn run_sql_with_lookup(
    step: &SqlStep<'_>,
    batch: RecordBatch,
    target: RecordBatch,
    sql: &str,
) -> EngineResult<RecordBatch> {
    run_sql_inner(step, batch, Some(target), sql).await
}

async fn run_sql_inner(
    step: &SqlStep<'_>,
    batch: RecordBatch,
    target: Option<RecordBatch>,
    sql: &str,
) -> EngineResult<RecordBatch> {
    let ctx = session_context_with_udfs(step.udfs);
    if let Some(target) = target {
        ctx.register_batch(LOOKUP, target)?;
    }
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
/// Goes through the SAME `parse_row_expression` the validator uses, taking the
/// step's input schema with it. That matters twice over:
///
/// * **Brackets resolve here too.** `[status]` is a measure reference to the
///   bare parser and a column only after resolution, which needs the schema.
///   Parsing without it would let `LEFT([status], 3)` pass model build and then
///   fail at refresh — validated on one path, broken on the other.
/// * **The allowlist runs on the refresh path.** `apply_steps` calls
///   `derive_step_schema` but never `validate_steps`, so before this a
///   hand-edited model file's expression reached SQL generation
///   allowlist-unchecked. Now every path parses the same way.
fn expression_sql(step: &SqlStep<'_>, input: &[Column], source: &str) -> EngineResult<String> {
    let parsed = parse_row_expression(step.table, step.index, input, source)?;
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
    input: &[Column],
    condition: &str,
) -> EngineResult<RecordBatch> {
    let predicate = expression_sql(step, input, condition)?;
    let sql = format!("SELECT * FROM {INPUT} WHERE {predicate}");
    run_sql(step, batch, &sql).await
}

/// `addColumn`.
pub(super) async fn add_column(
    step: &SqlStep<'_>,
    batch: RecordBatch,
    input: &[Column],
    name: &str,
    expression: &str,
) -> EngineResult<RecordBatch> {
    let value = expression_sql(step, input, expression)?;
    let sql = format!(
        "SELECT *, {value} AS {} FROM {INPUT}",
        quote_ident_double(name)
    );
    run_sql(step, batch, &sql).await
}

/// `transformColumn`: rewrite one existing column with a row-level expression,
/// in place.
///
/// Rides `select_list_with`, exactly as `replaceValues` and `textTransform` do,
/// which is what keeps the column in its original POSITION rather than moving
/// it to the end the way an add-then-drop-then-rename would.
///
/// The right-hand side reads the column's PRE-STEP value: SQL evaluates a
/// select list against the input row, so `net = [net] - [discount]` means what
/// it looks like it means, and two such steps compose.
pub(super) async fn transform_column(
    step: &SqlStep<'_>,
    batch: RecordBatch,
    input: &[Column],
    column: &str,
    expression: &str,
    declared_type: Option<&DataType>,
) -> EngineResult<RecordBatch> {
    let value = expression_sql(step, input, expression)?;
    // A DECLARED type is a promise the terminal conform cannot keep mid-way:
    // it runs once, after the whole pipeline, against the table's columns. A
    // later step that type-checks against this column (a cast, a text step, an
    // aggregate) consults DERIVATION, not the batch — so without this cast the
    // two disagree from here on. Rendered through the dialect the session
    // actually uses.
    let value = match declared_type {
        Some(data_type) => format!("CAST({value} AS {})", local_sql_type(data_type)),
        None => value,
    };
    let select = select_list_with(&batch, &[(column.to_string(), value)]);
    let sql = format!("SELECT {select} FROM {INPUT}");
    run_sql(step, batch, &sql).await
}

/// The local (DataFusion) spelling of a declared type, for the cast above.
///
/// Deliberately narrow: this renders into the SAME session
/// [`run_sql`] executes in, never into a connector's dialect. Pushing a step
/// into a source is a separate problem with a separate renderer, and a fixed
/// literal here would be a spelling to unpick later — see the dialect note in
/// the host-integration changelog.
fn local_sql_type(data_type: &DataType) -> String {
    match data_type {
        DataType::Int32 => "INT".to_string(),
        DataType::Int64 => "BIGINT".to_string(),
        DataType::Float64 => "DOUBLE".to_string(),
        DataType::Decimal(precision, scale) => format!("DECIMAL({precision}, {scale})"),
        DataType::String => "VARCHAR".to_string(),
        DataType::Boolean => "BOOLEAN".to_string(),
        DataType::Date => "DATE".to_string(),
        DataType::Timestamp => "TIMESTAMP".to_string(),
    }
}

/// The name the lookup target is registered under, beside [`INPUT`].
const LOOKUP: &str = "_lk";

/// `lookupColumn`: bring columns across from another table, matched on a key.
///
/// # The join cannot multiply rows
///
/// The target is joined as a subquery **grouped by exactly the join keys**, so
/// it contributes at most one row per key — by the shape of the query, on
/// every path, with no runtime cardinality check to forget. That is the same
/// guarantee (and the same `MIN`-on-ties resolution) the engine's calculated
/// -column `LOOKUPVALUE` has always had, so the two surfaces cannot disagree
/// about what a duplicate key means.
///
/// `LEFT` keeps every host row, so a key with no match yields null rather than
/// dropping the row — which is why derivation marks every output column
/// nullable.
pub(super) async fn lookup_column(
    step: &SqlStep<'_>,
    batch: RecordBatch,
    target: RecordBatch,
    keys: &[LookupKey],
    takes: &[LookupTake],
) -> EngineResult<RecordBatch> {
    let target_keys: Vec<String> = keys
        .iter()
        .map(|key| quote_ident_double(&key.target))
        .collect();

    // One grouped subquery serves every take: three columns from a dimension
    // cost one pass over it, not three.
    let mut projected: Vec<String> = target_keys.clone();
    for (position, take) in takes.iter().enumerate() {
        projected.push(format!(
            "MIN({}) AS {}",
            quote_ident_double(&take.column),
            // A positional alias, so two takes of the same target column (or a
            // take whose name collides with a key) cannot shadow each other
            // inside the subquery. The outer SELECT renames to the real output.
            quote_ident_double(&format!("_v{position}"))
        ));
    }
    let deduplicated = format!(
        "SELECT {} FROM {LOOKUP} GROUP BY {}",
        projected.join(", "),
        target_keys.join(", ")
    );

    let on = keys
        .iter()
        .map(|key| {
            format!(
                "_h.{} = _lkd.{}",
                quote_ident_double(&key.host),
                quote_ident_double(&key.target)
            )
        })
        .collect::<Vec<_>>()
        .join(" AND ");

    // A JOIN does not preserve input row order, and this pipeline's row order
    // is MEANINGFUL: `keepRows`/`removeRows` address positions, `fillDown`
    // carries a value downwards, and `removeDuplicates` keeps the FIRST row.
    // A lookup that quietly reshuffled would corrupt every one of them — and
    // silently, since the row COUNT stays right. So the host is numbered
    // before the join and sorted back afterwards; the ordinal never reaches
    // the output because the select list names the real columns rather than
    // using `*`.
    const ORDINAL: &str = "_lk_ord";
    let host_columns: Vec<String> = batch
        .schema()
        .fields()
        .iter()
        .map(|field| quote_ident_double(field.name()))
        .collect();
    let numbered_host = format!(
        "SELECT {}, ROW_NUMBER() OVER () AS {} FROM {INPUT}",
        host_columns.join(", "),
        quote_ident_double(ORDINAL)
    );

    let mut select: Vec<String> = host_columns
        .iter()
        .map(|column| format!("_h.{column}"))
        .collect();
    for (position, take) in takes.iter().enumerate() {
        select.push(format!(
            "_lkd.{} AS {}",
            quote_ident_double(&format!("_v{position}")),
            quote_ident_double(take.output())
        ));
    }

    let sql = format!(
        "SELECT {} FROM ({numbered_host}) AS _h LEFT JOIN ({deduplicated}) AS _lkd ON {on} \
         ORDER BY _h.{}",
        select.join(", "),
        quote_ident_double(ORDINAL)
    );
    run_sql_with_lookup(step, batch, target, &sql).await
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
        // Whole-value replacement compares against a TYPED literal, parsed and
        // re-rendered by `typed_sql_literal` — never the author's bytes. For a
        // numeric or boolean column the literal is emitted bare, so passing the
        // text through would be a raw interpolation of model-file content.
        // Derivation already refused text that cannot render, so a failure here
        // means a hand-edited model file: fail the step rather than build a
        // statement out of it.
        let literal = |text: &str| -> EngineResult<String> {
            typed_sql_literal(text, column_type).map_err(|reason| {
                step.error(format!("cannot replace values in '{column}': {reason}"))
            })
        };
        format!(
            "CASE WHEN {quoted} = {} THEN {} ELSE {quoted} END",
            literal(find)?,
            literal(replace)?
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

/// Render one aggregate over its operand — a quoted column, or a formula.
fn aggregate_sql(
    step: &SqlStep<'_>,
    aggregate: &GroupAggregate,
    input: &[Column],
) -> EngineResult<String> {
    if aggregate.function == AggregateOp::CountRows {
        return Ok(AggregateOp::CountRows.render_sql("*"));
    }
    let operand = match &aggregate.expression {
        // The SUMIF shape: the operand is a row-level formula. It goes through
        // the SAME `parse_row_expression` the validator uses (allowlist,
        // bracket resolution, column existence), and its INFERRED type — not a
        // by-name lookup, which has no name here — feeds the cast decision.
        // Getting that wrong is a silently integer-truncated median, not an
        // error, which is why the operand-slot idea was once killed outright.
        Some(expression) => {
            let parsed = parse_row_expression(step.table, step.index, input, expression)?;
            let operand_type = infer_parsed_type(&parsed, input);
            let sql = parsed
                .to_sql_string()
                .map_err(|e| step.error(format!("{e}")))?;
            fractional_cast(
                format!("({sql})"),
                operand_type.as_ref(),
                aggregate.function,
            )
        }
        None => aggregate_operand(&aggregate.column, aggregate.function, input),
    };
    Ok(aggregate.function.render_sql(&operand))
}

/// Wrap an operand in a `DOUBLE` cast when schema derivation declares a
/// fractional result over an operand that is not already fractional.
fn fractional_cast(
    operand_sql: String,
    operand_type: Option<&DataType>,
    function: AggregateOp,
) -> String {
    let declared_fractional = matches!(
        aggregate_output_type(function, operand_type),
        Some(DataType::Float64)
    );
    let already_fractional = matches!(operand_type, Some(DataType::Float64));
    if declared_fractional && !already_fractional {
        format!("CAST({operand_sql} AS DOUBLE)")
    } else {
        operand_sql
    }
}

/// The operand SQL for an aggregate, cast to `DOUBLE` when schema derivation
/// declares a fractional result over a column that is not already fractional.
///
/// Without the cast the two layers disagree on the VALUE, not just the type.
/// DataFusion's `median` returns its INPUT type and computes an even-count
/// median with the input's own arithmetic, so the median of two `Int64` rows
/// truncates — and the terminal cast to the derived `Float64` then makes the
/// wrong number look deliberate. `SUM` over `Decimal` has the same shape: it
/// returns a widened decimal where derivation promised `Float64`.
///
/// Casting the OPERAND makes the aggregate compute in the type it was declared
/// to produce, so preview, refresh and the declared schema all agree.
fn aggregate_operand(column: &str, function: AggregateOp, input: &[Column]) -> String {
    let column_type = input
        .iter()
        .find(|c| c.name() == column)
        .map(|c| c.data_type().clone());
    fractional_cast(quote_ident_double(column), column_type.as_ref(), function)
}

/// `groupBy`.
pub(super) async fn group_by(
    step: &SqlStep<'_>,
    batch: RecordBatch,
    keys: &[String],
    aggregates: &[GroupAggregate],
    input: &[Column],
) -> EngineResult<RecordBatch> {
    let quoted_keys: Vec<String> = keys.iter().map(|k| quote_ident_double(k)).collect();

    let mut select = quoted_keys.clone();
    for aggregate in aggregates {
        select.push(format!(
            "{} AS {}",
            aggregate_sql(step, aggregate, input)?,
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
    input: &[Column],
) -> EngineResult<RecordBatch> {
    let quoted_name = quote_ident_double(name_column);
    let operand = aggregate_operand(value_column, aggregate, input);

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
        // `render_case_when_sql`, NOT `render_sql` over a CASE expression:
        // `render_sql` DISCARDS its operand for CountRows and emits a bare
        // `COUNT(*)`, which would give every pivoted column the whole group's
        // row count instead of the count for its own value.
        let condition = format!("{quoted_name} = {}", sql_quote_literal(value_name));
        select.push(format!(
            "{} AS {}",
            aggregate.render_case_when_sql(&condition, &operand),
            quote_ident_double(value_name)
        ));
    }

    let mut sql = format!("SELECT {} FROM {INPUT}", select.join(", "));
    if !group.is_empty() {
        sql.push_str(&format!(" GROUP BY {}", group.join(", ")));
    }
    run_sql(step, batch, &sql).await
}
