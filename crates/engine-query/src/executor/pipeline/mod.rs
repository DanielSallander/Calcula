//! Query executor: executes a `QueryPlan` and returns Arrow results.

mod bidirectional;
#[cfg(test)]
mod bidirectional_tests;
mod detail;
mod fetch;
mod hierarchy;
#[cfg(test)]
mod hierarchy_tests;
mod local_aggregation;
mod lookups;
mod measures;
mod multi_group;
#[cfg(test)]
mod multi_group_tests;
mod order_limit;
mod pre_aggregate;
mod query_measures;
mod sql;
#[cfg(test)]
mod time_intelligence_tests;
#[cfg(test)]
mod udf_tests;
mod window;

pub(crate) use fetch::render_filter_literal;
pub(crate) use order_limit::apply_order_and_limit;

use arrow::record_batch::RecordBatch;
use tokio_util::sync::CancellationToken;

use engine_core::compute::expression::FilterPredicate;
use engine_core::compute::udf::UdfRegistry;
use engine_core::model::DataModel;
use engine_core::store::InMemoryCache;

use crate::error::QueryResult;
use crate::executor::cancel::{check_cancelled, race_cancelled};
use crate::planner::QueryPlan;
use crate::registry::SourceRegistry;

/// Executes query plans, coordinating between data sources and local computation.
pub struct QueryExecutor;

impl QueryExecutor {
    /// Execute a query plan and return results as Arrow `RecordBatch` values.
    ///
    /// When `cache` is provided, tables configured for in-memory storage are
    /// served from the cache instead of being fetched from the source connector.
    ///
    /// When `udfs` is provided, host-registered UDFs are available to the
    /// local DataFusion session, so measures containing
    /// [`Expression::Call`](engine_core::compute::expression::Expression::Call)
    /// nodes resolve. With `None` (or an unregistered name) such measures
    /// fail with a DataFusion "invalid function" error.
    ///
    /// Equivalent to [`execute_with_cancellation`](Self::execute_with_cancellation)
    /// with a token that is never cancelled.
    ///
    /// `role_filters` are the active security role's predicates (empty when no
    /// role is active). The planner already seals them into each table's
    /// fetch; the executor re-applies them as a defense-in-depth guard so a
    /// plan that reached this path without them still cannot leak rows.
    pub async fn execute(
        plan: &QueryPlan,
        model: &DataModel,
        registry: &SourceRegistry,
        cache: Option<&InMemoryCache>,
        max_inline_in_values: Option<usize>,
        udfs: Option<&UdfRegistry>,
        role_filters: &[FilterPredicate],
    ) -> QueryResult<Vec<RecordBatch>> {
        Self::execute_with_cancellation(
            plan,
            model,
            registry,
            cache,
            max_inline_in_values,
            udfs,
            role_filters,
            &CancellationToken::new(),
        )
        .await
    }

    /// Execute a query plan with cooperative cancellation.
    ///
    /// Like [`execute`](Self::execute), but stops with
    /// [`QueryError::Cancelled`](crate::error::QueryError::Cancelled) when
    /// `token` is cancelled. Cancellation is observed at phase boundaries
    /// (before fetches, before DataFusion registration, before each
    /// measure-evaluation block, before the final SQL) and races the
    /// long-lived awaits — connector fetches and the final DataFusion
    /// execution.
    ///
    /// Dropping an in-flight connector fetch cancels the client-side work,
    /// but the database server may continue executing the already-submitted
    /// statement; cancellation releases the caller, it does not guarantee
    /// the source stops working.
    #[allow(clippy::too_many_arguments)]
    pub async fn execute_with_cancellation(
        plan: &QueryPlan,
        model: &DataModel,
        registry: &SourceRegistry,
        cache: Option<&InMemoryCache>,
        max_inline_in_values: Option<usize>,
        udfs: Option<&UdfRegistry>,
        role_filters: &[FilterPredicate],
        token: &CancellationToken,
    ) -> QueryResult<Vec<RecordBatch>> {
        // Defense in depth (release-active, ALL plan arms): a dynamic RLS
        // predicate (USERNAME()/CUSTOMDATA()) must be substituted to a concrete
        // identity by the facade before it reaches the executor. If one arrives
        // unresolved — on a pushed OR a local plan — FAIL CLOSED rather than render
        // its placeholder value as a SQL literal (which would mis-restrict or
        // leak). The facade's substitution makes this unreachable in normal
        // operation; this backstops any future path that forgets it.
        if let Some(p) = role_filters.iter().find(|p| p.dynamic.is_some()) {
            return Err(crate::error::QueryError::Engine(
                engine_core::error::EngineError::RowLevelSecurityNotEnforceable {
                    table: p.table.clone(),
                    reason: "a dynamic row-level-security predicate (USERNAME()/CUSTOMDATA()) \
                             reached the executor unresolved; it must be substituted to a \
                             concrete identity before planning"
                        .to_string(),
                },
            ));
        }
        match plan {
            QueryPlan::PushedAggregation {
                source_table,
                request,
            } => {
                check_cancelled(token)?;
                let connector = registry.connector_for(source_table)?;
                let batches =
                    race_cancelled(token, async { Ok(connector.fetch_data(request).await?) })
                        .await?;
                Ok(batches)
            }
            QueryPlan::PushedJoinAggregation {
                source_table,
                request,
                order_by,
                limit,
            } => {
                check_cancelled(token)?;
                let connector = registry.connector_for(source_table)?;
                let batches = race_cancelled(token, async {
                    Ok(connector.execute_join_aggregation(request).await?)
                })
                .await?;
                // The pushed join SQL is not ordered; apply ORDER BY / LIMIT
                // locally over the (already aggregated) result rows.
                apply_order_and_limit(batches, order_by, *limit)
            }
            QueryPlan::LocalAggregation {
                fetches,
                measures,
                group_by,
                lookup_specs,
                order_by,
                limit,
                totals,
                hierarchy,
            } => {
                Self::execute_local_aggregation(
                    fetches,
                    measures,
                    group_by,
                    lookup_specs,
                    order_by,
                    *limit,
                    *totals,
                    hierarchy.as_ref(),
                    model,
                    registry,
                    cache,
                    max_inline_in_values,
                    udfs,
                    role_filters,
                    None,
                    token,
                )
                .await
            }
        }
    }
}
