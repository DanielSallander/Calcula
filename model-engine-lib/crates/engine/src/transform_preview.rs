//! Previewing a transformation pipeline as of a given step.
//!
//! The step editor's feedback loop: fetch a bounded sample from the source and
//! run the **candidate** steps — the ones the user is editing, not the ones
//! saved on the model — so a step can be seen working before it is committed.

use arrow::record_batch::RecordBatch;
use engine_connectors::traits::FetchRequest;
use engine_core::error::{EngineError, EngineResult};
use engine_core::transform::{
    apply_steps, conform_to_declared, derive_pipeline_schema, validate_steps, TransformStep,
};
use tokio_util::sync::CancellationToken;

use crate::Engine;

/// Largest sample a preview will pull, whatever the caller asks for.
///
/// A preview is a feedback loop for a person editing steps; pulling more than
/// this serves no one and turns a keystroke into a long source query.
pub const MAX_PREVIEW_ROWS: usize = 10_000;

/// A request to preview a candidate pipeline.
#[derive(Debug, Clone)]
pub struct TransformPreviewRequest {
    /// The model table whose source supplies the sample rows.
    pub table: String,
    /// The candidate steps — normally the editor's unsaved draft.
    pub steps: Vec<TransformStep>,
    /// How many steps to apply. `None` applies all of them; `Some(0)` shows
    /// the raw source sample, which is what a step list's "Source" row means.
    pub upto_step: Option<usize>,
    /// How many source rows to sample, clamped to [`MAX_PREVIEW_ROWS`].
    pub row_limit: usize,
}

impl TransformPreviewRequest {
    /// A preview of every step in `steps` over a default-sized sample.
    pub fn new(table: impl Into<String>, steps: Vec<TransformStep>) -> Self {
        Self {
            table: table.into(),
            steps,
            upto_step: None,
            row_limit: 500,
        }
    }

    /// Preview as of `step` (`0` = the raw source).
    pub fn upto(mut self, step: usize) -> Self {
        self.upto_step = Some(step);
        self
    }

    /// Sample at most `rows` source rows.
    pub fn with_row_limit(mut self, rows: usize) -> Self {
        self.row_limit = rows;
        self
    }
}

/// The result of a preview: the transformed sample, plus what it was a sample
/// **of**.
///
/// The source counts are part of the result rather than something the caller
/// infers, because a caller cannot infer them. A pipeline that filters rows out
/// leaves an output far smaller than the cap even when the source was truncated
/// — so judging "is this a sample?" from the output row count alone
/// under-reports exactly when a `groupBy` total is most likely to mislead.
#[derive(Debug, Clone)]
pub struct TransformPreview {
    /// The batch after applying the requested steps.
    pub batch: RecordBatch,
    /// How many source rows were fetched (at most `row_limit`).
    pub source_rows: usize,
    /// `true` when the source had more rows than were sampled, so any step
    /// that aggregates or reorders across the whole table saw only part of it.
    pub source_truncated: bool,
}

impl Engine {
    /// Run a candidate pipeline over a bounded sample of the table's source.
    ///
    /// Takes `&self`: a preview never touches the cache or the model, so it
    /// cannot disturb a session while someone is editing.
    ///
    /// # A preview is a sample, not the answer
    ///
    /// Steps that aggregate or reorder across the whole table
    /// ([`changes_row_count`](TransformStep::changes_row_count) reports which)
    /// see only the sampled rows, so their preview is indicative rather than
    /// final. Hosts should say so rather than presenting a sampled `groupBy`
    /// total as the number the refresh will produce.
    ///
    /// # Errors
    ///
    /// - [`EngineError::InvalidTransform`] if a candidate step cannot apply —
    ///   the fast path the editor shows while typing, raised before any I/O.
    /// - Fetch failures from the source.
    /// - A cancelled token surfaces as
    ///   [`EngineError::InvalidData`] naming the cancellation, so a caller can
    ///   distinguish "you stopped it" from "it broke".
    pub async fn preview_transformations(
        &self,
        request: &TransformPreviewRequest,
        cancel: &CancellationToken,
    ) -> EngineResult<TransformPreview> {
        let table = self.model.table(&request.table)?;
        let binding = table
            .source_binding()
            .ok_or_else(|| EngineError::InvalidTransform {
                table: request.table.clone(),
                step_index: 0,
                reason: "the table is not bound to a data source, so there is \
                         nothing to preview"
                    .to_string(),
            })?;

        // The recorded source schema is the pipeline's anchor. A table with no
        // pipeline yet has none, and its current columns ARE its source
        // columns.
        let source_columns = if binding.source_columns.is_empty() {
            table.columns().to_vec()
        } else {
            binding.source_columns.clone()
        };

        // Validate before fetching. A typo in a half-typed expression should
        // come back instantly, not after a round trip to the database.
        validate_steps(&request.table, &source_columns, &request.steps)?;

        let cancelled = || {
            EngineError::InvalidData(format!(
                "preview of table '{}' was cancelled",
                request.table
            ))
        };
        if cancel.is_cancelled() {
            return Err(cancelled());
        }

        let limit = request.row_limit.clamp(1, MAX_PREVIEW_ROWS);
        // Fetch ONE row beyond the limit. That extra row is the only way to
        // tell "the source has exactly `limit` rows" from "the source has more
        // and this is a sample" — and the difference decides whether an
        // aggregating step's preview can be trusted as a final answer.
        let probe_limit = limit.saturating_add(1);
        let fetch = FetchRequest {
            schema: Some(binding.schema.clone()),
            table: binding.table.clone(),
            source_query: binding.source_query.clone(),
            limit: Some(probe_limit),
            ..Default::default()
        };
        let connector = self
            .registry
            .connector_for(&request.table)
            .map_err(|e| EngineError::InvalidData(e.to_string()))?;

        // Race the fetch against the token so a cancelled preview stops at the
        // source, not after it — the fetch is the slow part. Dropping the
        // fetch future cancels the client-side work; the server may still
        // finish the statement it was given.
        //
        // `futures::select` rather than `tokio::select!`: this crate has no
        // runtime dependency, and a preview is not a reason to add one.
        let batches = {
            let fetching = connector.fetch_data(&fetch);
            let cancelling = cancel.cancelled();
            futures::pin_mut!(fetching);
            futures::pin_mut!(cancelling);
            match futures::future::select(fetching, cancelling).await {
                futures::future::Either::Left((fetched, _)) => {
                    fetched.map_err(|e| EngineError::InvalidData(e.to_string()))?
                }
                futures::future::Either::Right(_) => return Err(cancelled()),
            }
        };

        let fetched = if batches.is_empty() {
            RecordBatch::new_empty(std::sync::Arc::new(
                engine_core::model::Table::new(&request.table, source_columns.clone())?
                    .to_arrow_schema(),
            ))
        } else {
            let schema = batches[0].schema();
            arrow::compute::concat_batches(&schema, &batches)?
        };

        // Trim the probe row back off before the steps run, so the preview
        // shows exactly the sample the caller asked for.
        let source_truncated = fetched.num_rows() > limit;
        let input = if source_truncated {
            fetched.slice(0, limit)
        } else {
            fetched
        };
        let source_rows = input.num_rows();

        if cancel.is_cancelled() {
            return Err(cancelled());
        }

        let upto = request.upto_step.unwrap_or(request.steps.len());
        let previewed = &request.steps[..upto.min(request.steps.len())];
        let batch = apply_steps(
            &request.table,
            input,
            &source_columns,
            &request.steps,
            upto,
            self.effective_udfs.as_ref(),
        )
        .await?;

        // Conform to the schema these steps DERIVE, exactly as a refresh
        // conforms to the table's declared columns. Without it a preview can
        // render a value the refresh would store differently (a generated
        // aggregate coming back wider than the step declares), which makes the
        // preview a worse guide the more the user relies on it.
        let derived = derive_pipeline_schema(&request.table, &source_columns, previewed)?;
        let batch = conform_to_declared(
            &request.table,
            previewed.len().saturating_sub(1),
            &batch,
            &derived,
        )?;

        Ok(TransformPreview {
            batch,
            source_rows,
            source_truncated,
        })
    }
}
