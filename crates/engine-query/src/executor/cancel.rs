//! Cooperative cancellation helpers for the query executor.
//!
//! The executor never interrupts running code preemptively. Instead it
//! checks the [`CancellationToken`] at phase boundaries (cheap, synchronous)
//! and races long-lived awaits — connector fetches and DataFusion
//! execution — against the token with [`race_cancelled`]. Dropping a
//! connector fetch future stops client-side work (sqlx/tiberius futures
//! cancel on drop), but the database server may continue executing the
//! already-submitted statement; cancellation only releases the caller.

use std::future::Future;

use tokio_util::sync::CancellationToken;

use crate::error::{QueryError, QueryResult};

/// Return [`QueryError::Cancelled`] when `token` has been cancelled.
///
/// Used at phase boundaries (before fetches, before registration, before
/// each measure-evaluation block, before the final SQL) so a cancelled query
/// stops at the next checkpoint instead of running to completion.
pub(crate) fn check_cancelled(token: &CancellationToken) -> QueryResult<()> {
    if token.is_cancelled() {
        Err(QueryError::Cancelled)
    } else {
        Ok(())
    }
}

/// Race `future` against cancellation of `token`.
///
/// Returns [`QueryError::Cancelled`] as soon as the token is cancelled,
/// dropping `future` (which cancels in-flight client-side work). The
/// `biased` ordering checks the token first on every poll, so a
/// pre-cancelled token never starts polling the inner future's body past
/// its first suspension point.
pub(crate) async fn race_cancelled<T>(
    token: &CancellationToken,
    future: impl Future<Output = QueryResult<T>>,
) -> QueryResult<T> {
    tokio::select! {
        biased;
        _ = token.cancelled() => Err(QueryError::Cancelled),
        result = future => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_cancelled_passes_for_fresh_token() {
        let token = CancellationToken::new();
        assert!(check_cancelled(&token).is_ok());
    }

    #[test]
    fn check_cancelled_errors_for_cancelled_token() {
        let token = CancellationToken::new();
        token.cancel();
        assert!(matches!(
            check_cancelled(&token),
            Err(QueryError::Cancelled)
        ));
    }

    #[tokio::test]
    async fn race_cancelled_returns_value_when_not_cancelled() {
        let token = CancellationToken::new();
        let result = race_cancelled(&token, async { Ok(42) }).await;
        assert_eq!(result.unwrap(), 42);
    }

    #[tokio::test]
    async fn race_cancelled_pre_cancelled_token_wins_over_ready_future() {
        let token = CancellationToken::new();
        token.cancel();
        // `biased` ordering: the cancelled token is observed before the
        // (immediately ready) future.
        let result = race_cancelled(&token, async { Ok(42) }).await;
        assert!(matches!(result, Err(QueryError::Cancelled)));
    }

    #[tokio::test]
    async fn race_cancelled_wakes_on_cancellation_mid_flight() {
        // Deterministic mid-flight equivalent: the inner future never
        // completes, so this test finishes only if cancellation wakes the
        // select. No timing assertions involved.
        let token = CancellationToken::new();
        let cancel_handle = token.clone();
        tokio::spawn(async move { cancel_handle.cancel() });

        let result: QueryResult<()> = race_cancelled(&token, std::future::pending()).await;
        assert!(matches!(result, Err(QueryError::Cancelled)));
    }

    /// In-memory single-table fixture served entirely from the cache (no
    /// connector registered): a non-cancelled execution succeeds, so an
    /// `Err(Cancelled)` can only come from a cancellation checkpoint.
    fn cancellation_fixture() -> (
        engine_core::model::DataModel,
        engine_core::store::InMemoryCache,
        crate::registry::SourceRegistry,
    ) {
        use std::sync::Arc;

        use arrow::array::{Float64Array, Int64Array};
        use arrow::datatypes::{DataType as ArrowDataType, Field, Schema};
        use arrow::record_batch::RecordBatch;
        use engine_core::compute::aggregate::AggregateOp;
        use engine_core::compute::measure::Measure;
        use engine_core::model::column::Column;
        use engine_core::model::table::{StorageMode, Table};
        use engine_core::model::DataModel;
        use engine_core::store::InMemoryCache;
        use engine_core::types::DataType as EngineDataType;

        use crate::registry::{SourceBinding, SourceRegistry};

        let table = Table::new(
            "fact_sales",
            vec![
                Column::new("id", EngineDataType::Int64),
                Column::new("amount", EngineDataType::Float64),
            ],
        )
        .unwrap()
        .with_storage_mode(StorageMode::InMemory);
        let model = DataModel::builder()
            .add_table(table)
            .add_measure(Measure::simple(
                "Total",
                "fact_sales",
                "amount",
                AggregateOp::Sum,
            ))
            .build()
            .unwrap();

        let schema = Arc::new(Schema::new(vec![
            Field::new("id", ArrowDataType::Int64, true),
            Field::new("amount", ArrowDataType::Float64, true),
        ]));
        let batch = RecordBatch::try_new(
            schema,
            vec![
                Arc::new(Int64Array::from(vec![1, 2])),
                Arc::new(Float64Array::from(vec![1.5, 2.5])),
            ],
        )
        .unwrap();
        let mut cache = InMemoryCache::new();
        cache.store("fact_sales", batch).unwrap();

        // Bind so the planner accepts the table; the cache serves the data.
        let mut registry = SourceRegistry::new();
        registry.bind("fact_sales", 0, SourceBinding::new("public", "fact_sales"));

        (model, cache, registry)
    }

    #[tokio::test]
    async fn executor_pre_cancelled_token_returns_cancelled_without_executing() {
        use crate::executor::QueryExecutor;
        use crate::planner::PushdownPlanner;
        use crate::request::QueryRequest;

        let (model, cache, registry) = cancellation_fixture();
        let request = QueryRequest {
            measures: vec!["Total".into()],
            ..Default::default()
        };
        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();

        // Pre-cancelled token: the entry checkpoint fires before any work.
        let token = CancellationToken::new();
        token.cancel();
        let err = QueryExecutor::execute_with_cancellation(
            &plan,
            &model,
            &registry,
            Some(&cache),
            None,
            None,
            &[],
            &token,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, QueryError::Cancelled), "got: {err:?}");

        // Sanity check: the identical plan succeeds with a fresh token, so
        // the error above is the cancellation checkpoint — not the fixture.
        let batches = QueryExecutor::execute_with_cancellation(
            &plan,
            &model,
            &registry,
            Some(&cache),
            None,
            None,
            &[],
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        let rows: usize = batches.iter().map(|b| b.num_rows()).sum();
        assert_eq!(rows, 1);
    }
}
