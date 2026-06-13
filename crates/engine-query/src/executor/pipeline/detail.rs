//! Drillthrough / detail-rows execution: return the **raw fact rows** behind a
//! pivot cell, with no aggregation.
//!
//! [`QueryExecutor::execute_detail`] fetches the detail (fact) table's rows,
//! filtered to the cell's coordinates, with row-level security fully enforced
//! and a mandatory row cap. It is deliberately self-contained: it reuses the
//! aggregation path's *leaf* helpers ([`filter_cached_batch`],
//! [`extract_column_values`], [`filter_batches_by_in_values`]) and the
//! planner's RLS helpers ([`rls_relevance`], [`role_conditions_for_table`]),
//! but does not touch the 1400-line `execute_local_aggregation`.
//!
//! # Security model (raw-row enforcement)
//!
//! Because detail rows are returned verbatim, a missing restriction is a
//! direct data leak — not merely a wrong total. Three mechanisms hold the
//! line, each mirroring the aggregation path so the two stay in lockstep:
//!
//! 1. **Fail closed.** [`rls_relevance`] is called over the detail table as
//!    the sole "fact". If the active role filters a dimension that could
//!    restrict the detail table but reaches it only through a relationship the
//!    engine cannot turn into a row restriction (non-equi / many-to-many /
//!    composite-key / inactive / multi-hop), the query is **refused** with
//!    [`RowLevelSecurityNotEnforceable`](engine_core::error::EngineError::RowLevelSecurityNotEnforceable).
//!    The check guarantees every role-relevant dimension is of the one
//!    enforceable shape, so no role restriction is ever silently dropped.
//! 2. **Dimension → detail propagation.** Every dimension carrying a
//!    cell-coordinate filter or a role filter, related to the detail table by
//!    a single-hop active single-column equi relationship, is fetched
//!    restricted by those filters; its surviving join keys become an
//!    `IN (...)` filter on the detail table's join column — so only detail
//!    rows joined to permitted dimension rows survive.
//! 3. **Direct sealing.** The role's predicates on the detail table itself are
//!    sealed onto the detail fetch (and, for a cached detail table, applied
//!    locally).

use std::collections::HashSet;

use arrow::record_batch::RecordBatch;
use tokio_util::sync::CancellationToken;

use engine_connectors::{
    FetchRequest, FilterCondition, InFilterCondition, OrderByExpr, OrderByTarget,
};
use engine_core::compute::expression::FilterPredicate;
use engine_core::error::EngineError;
use engine_core::model::DataModel;
use engine_core::store::InMemoryCache;

use crate::error::{QueryError, QueryResult};
use crate::executor::cancel::{check_cancelled, race_cancelled};
use crate::planner::{rls_relevance, role_conditions_for_table};
use crate::registry::SourceRegistry;
use crate::request::{DetailRequest, OrderByClause, OrderTarget};

use super::bidirectional::filter_batches_by_in_values;
use super::fetch::{extract_column_values, filter_cached_batch};
use super::QueryExecutor;

impl QueryExecutor {
    /// Execute a drillthrough: return the raw detail-table rows behind a pivot
    /// cell, with no aggregation.
    ///
    /// `role_filters` are the active security role's predicates (empty when no
    /// role is active). The caller (the [`Engine`](crate) facade) must have
    /// validated the active role first.
    ///
    /// `token` enables cooperative cancellation: it is checked before any work
    /// and raced against the connector fetches.
    ///
    /// Returns the detail rows as Arrow `RecordBatch` values (the requested
    /// columns, or all columns when `request.columns` is empty), capped at
    /// `request.limit`.
    ///
    /// # Errors
    ///
    /// - [`QueryError::SourceNotRegistered`] if the detail table is neither
    ///   bound to a connector nor present in the cache.
    /// - [`QueryError::Engine`] wrapping
    ///   [`EngineError::TableNotFound`](engine_core::error::EngineError::TableNotFound)
    ///   if the detail table is not in the model, or
    ///   [`EngineError::RowLevelSecurityNotEnforceable`](engine_core::error::EngineError::RowLevelSecurityNotEnforceable)
    ///   when a relevant role restriction cannot be enforced (fail closed).
    /// - [`QueryError::InvalidQuery`] when a filter or order-by clause cannot
    ///   be mapped to the detail table or a propagatable dimension.
    #[allow(clippy::too_many_arguments)]
    pub async fn execute_detail(
        request: &DetailRequest,
        model: &DataModel,
        registry: &SourceRegistry,
        cache: Option<&InMemoryCache>,
        max_inline_in_values: Option<usize>,
        role_filters: &[FilterPredicate],
        token: &CancellationToken,
    ) -> QueryResult<Vec<RecordBatch>> {
        // Cancellation checkpoint: before any work.
        check_cancelled(token)?;

        let detail_table = request.table.as_str();
        // The detail table must exist in the model (so we can match columns and
        // resolve relationships). A non-existent table is a hard error.
        let detail_def = model.table(detail_table).map_err(QueryError::Engine)?;

        // The detail table must be servable: either bound to a connector or in
        // the cache. Neither → SourceNotRegistered.
        let detail_cached = is_cached(model, cache, detail_table);
        if !detail_cached && !registry.has_table(detail_table) {
            return Err(QueryError::SourceNotRegistered(detail_table.to_string()));
        }

        // --- Step 1: resolve the involved tables ---
        //
        // The detail table plus every table whose column a filter names. A
        // FilterCondition has no table field, so — exactly as the aggregation
        // planner does — each filter is matched to the table whose model
        // definition owns its column. Filters that match the detail table are
        // applied directly; filters that match a dimension are propagated.
        //
        // Partition the request's filters: those on the detail table vs. those
        // on a related dimension (grouped by dimension table name).
        let mut detail_filters: Vec<FilterCondition> = Vec::new();
        // dimension table name -> its cell-coordinate filters.
        let mut dim_filters: Vec<(String, FilterCondition)> = Vec::new();

        for filter in &request.filters {
            if detail_def.column(&filter.column).is_ok() {
                // Owned by the detail table — apply directly.
                detail_filters.push(filter.clone());
                continue;
            }
            // Find the model table that owns this column. We only accept a
            // dimension that is single-hop equi-related to the detail table
            // (the propagatable shape); anything else cannot restrict the
            // detail rows and is rejected rather than silently ignored.
            let owner = find_filter_owner(model, detail_table, &filter.column);
            match owner {
                Some(dim) => {
                    dim_filters.push((dim, filter.clone()));
                }
                None => {
                    return Err(QueryError::InvalidQuery(format!(
                        "drillthrough filter on column '{}' does not match the detail \
                         table '{detail_table}' or any dimension related to it by a \
                         single-hop equi relationship",
                        filter.column
                    )));
                }
            }
        }

        // --- Step 2: RLS fail-closed check ---
        //
        // Treat the detail table as the sole "fact" AND the sole table "in" the
        // query. Drillthrough does not JOIN, so — unlike aggregation — a
        // role-filtered dimension is enforceable only if it can be propagated
        // to the detail rows via a single-hop active single-column equi
        // relationship. Passing just the detail table means `rls_relevance`:
        //   - returns the enforceable role-filtered dimensions to pull in
        //     (`role_extra`, all single-hop equi);
        //   - FAILS CLOSED (`RowLevelSecurityNotEnforceable`) for any role
        //     dimension reachable from the detail table only through a non-equi
        //     / many-to-many / composite / inactive / multi-hop relationship;
        //   - treats a role dimension UNRELATED to the detail table as an
        //     irrelevant no-op — so an active role that filters some other part
        //     of the model never breaks an unrelated drillthrough.
        // A role on the detail table itself is sealed onto its fetch (step 4).
        let detail_only: HashSet<String> = std::iter::once(detail_table.to_string()).collect();
        let (_, role_extra) = rls_relevance(role_filters, &detail_only, &[detail_table], model)
            .map_err(QueryError::Engine)?;

        // --- Step 3: dimension → detail propagation ---
        //
        // For each dimension that has a cell-coordinate filter OR a role
        // filter and is single-hop active single-column equi related to the
        // detail table, fetch it restricted by (cell filters + role
        // conditions), extract its join keys, and add an IN filter on the
        // detail table's join column. This is the security-critical step: it
        // turns a dimension restriction into a detail-row restriction.
        //
        // Collect the dimensions to propagate: those carrying a cell-coordinate
        // filter, plus the role-filtered dimensions `rls_relevance` deemed
        // enforceable (`role_extra`, all single-hop equi). Role dimensions
        // unrelated to the detail table are absent from `role_extra` and so are
        // correctly ignored; non-equi role dimensions were already refused
        // above. Both kinds are restricted (cell filter and/or role
        // conditions) and turned into an IN filter on the detail FK.
        let mut propagate_dims: Vec<String> = Vec::new();
        {
            let mut seen: HashSet<String> = HashSet::new();
            for (dim, _) in &dim_filters {
                if seen.insert(dim.clone()) {
                    propagate_dims.push(dim.clone());
                }
            }
            for dim in &role_extra {
                if seen.insert(dim.clone()) {
                    propagate_dims.push(dim.clone());
                }
            }
        }

        let mut in_filters: Vec<InFilterCondition> = Vec::new();
        for dim in &propagate_dims {
            // The detail↔dimension relationship must be the one propagatable
            // shape. `find_relationship` returns only ACTIVE relationships; we
            // additionally require single-condition equi. This MUST agree with
            // the aggregation IN-propagation gate and with `rls_relevance`'s
            // `fact_restrictable_by_dimension` — if it disagreed we could drop
            // a restriction the fail-closed check assumed enforceable.
            let Ok(rel) = model.find_relationship(detail_table, dim) else {
                // A dimension carrying a cell filter but no active relationship
                // to the detail table cannot restrict it — reject (cell
                // correctness). A role-only dimension in this state was already
                // refused by the fail-closed check above, so this only fires
                // for stray cell filters.
                return Err(QueryError::InvalidQuery(format!(
                    "drillthrough filter targets dimension '{dim}', which has no active \
                     relationship to the detail table '{detail_table}'"
                )));
            };
            if rel.conditions().len() != 1 || !rel.is_equi_only() {
                return Err(QueryError::InvalidQuery(format!(
                    "drillthrough filter targets dimension '{dim}', related to the detail \
                     table '{detail_table}' only through a relationship that cannot be \
                     turned into a row restriction (non-equi / composite-key)"
                )));
            }
            // Orient the relationship: which column is on the detail side and
            // which is on the dimension side.
            let (detail_col, dim_col) = if rel.from_table() == detail_table {
                (rel.from_column().to_string(), rel.to_column().to_string())
            } else {
                (rel.to_column().to_string(), rel.from_column().to_string())
            };

            // Build the dimension's restricting filters: its cell filters plus
            // the role's conditions on it. (Role conditions are sealed here so
            // a role on a dimension restricts the detail rows even when the
            // dimension carries no cell filter.)
            let mut dim_restrict: Vec<FilterCondition> = dim_filters
                .iter()
                .filter(|(d, _)| d == dim)
                .map(|(_, f)| f.clone())
                .collect();
            dim_restrict.extend(role_conditions_for_table(role_filters, dim));

            // Fetch the restricted dimension: cached → filter the cached batch
            // locally; connector-bound → push the filters to the source.
            let dim_batches = if is_cached(model, cache, dim) {
                let batch = cache
                    .and_then(|c| c.get(dim))
                    .ok_or_else(|| QueryError::Engine(EngineError::TableNotCached(dim.clone())))?;
                if dim_restrict.is_empty() {
                    vec![batch.clone()]
                } else {
                    vec![filter_cached_batch(batch, &dim_restrict).await?]
                }
            } else {
                let binding = registry.binding_for(dim)?;
                let fetch = FetchRequest {
                    schema: Some(binding.schema.clone()),
                    table: binding.table.clone(),
                    columns: vec![dim_col.clone()],
                    filters: dim_restrict,
                    max_inline_in_values,
                    ..Default::default()
                };
                let connector = registry.connector_for(dim)?;
                race_cancelled(token, async { Ok(connector.fetch_data(&fetch).await?) }).await?
            };

            // Extract the surviving join keys and turn them into an IN filter
            // on the detail table's join column.
            let (values, kind) = extract_column_values(&dim_batches, &dim_col);
            in_filters.push(InFilterCondition {
                column: detail_col,
                values,
                kind,
            });
        }

        // Security floor: if any propagated key set is EMPTY, the dimension
        // restriction (a cell filter or — critically — an active role) permits
        // no rows, so no detail row can join to a permitted dimension row. The
        // result MUST be empty. We short-circuit here rather than emit an empty
        // `IN ()` filter, because a connector that drops an empty IN-list would
        // otherwise return the whole table — a data leak. (The cached path's
        // `filter_batches_by_in_values` already yields zero rows for empty
        // values, but the short-circuit makes both paths correct and
        // connector-independent.)
        if in_filters.iter().any(|f| f.values.is_empty()) {
            return Ok(Vec::new());
        }

        // --- Step 4: build the detail FetchRequest ---
        //
        // Direct detail filters + the role's own predicates on the detail
        // table, the propagated IN filters, the converted ORDER BY, the
        // mandatory limit. No group_by, no aggregates.
        let mut detail_fetch_filters = detail_filters;
        detail_fetch_filters.extend(role_conditions_for_table(role_filters, detail_table));

        let order_by = convert_order_by(&request.order_by, detail_table)?;

        // --- Step 5: fetch the detail rows ---
        if detail_cached {
            // Served from the in-memory cache: apply the combined filters
            // locally, then the propagated IN filters, project the requested
            // columns, and truncate to `limit`.
            let batch = cache.and_then(|c| c.get(detail_table)).ok_or_else(|| {
                QueryError::Engine(EngineError::TableNotCached(detail_table.to_string()))
            })?;

            let mut batches = if detail_fetch_filters.is_empty() {
                vec![batch.clone()]
            } else {
                vec![filter_cached_batch(batch, &detail_fetch_filters).await?]
            };

            for in_filter in &in_filters {
                batches =
                    filter_batches_by_in_values(&batches, &in_filter.column, &in_filter.values)?;
            }

            let batches = project_columns(batches, &request.columns)?;
            Ok(truncate_batches(batches, request.limit))
        } else {
            // Connector-bound: the connector honors columns / filters /
            // in_filters / order_by / limit directly.
            let binding = registry.binding_for(detail_table)?;
            let fetch = FetchRequest {
                schema: Some(binding.schema.clone()),
                table: binding.table.clone(),
                columns: request.columns.clone(),
                filters: detail_fetch_filters,
                in_filters,
                order_by,
                limit: Some(request.limit),
                max_inline_in_values,
                ..Default::default()
            };
            let connector = registry.connector_for(detail_table)?;
            // Cancellation checkpoint, then race the fetch.
            check_cancelled(token)?;
            let batches =
                race_cancelled(token, async { Ok(connector.fetch_data(&fetch).await?) }).await?;
            Ok(batches)
        }
    }
}

/// Whether `table` is served from local memory (a model in-memory table or a
/// table present in the runtime cache).
fn is_cached(model: &DataModel, cache: Option<&InMemoryCache>, table: &str) -> bool {
    let is_in_memory = model.table(table).is_ok_and(|t| t.is_in_memory());
    let in_runtime_cache = cache.is_some_and(|c| c.contains(table));
    is_in_memory || in_runtime_cache
}

/// Find the model table that owns `column` and is single-hop equi-related to
/// `detail_table` (the propagatable shape).
///
/// Returns `None` when no related table owns the column. Restricting the
/// search to single-hop equi-related dimensions keeps the result enforceable:
/// a column on an unrelated or non-propagatably-related table cannot restrict
/// the detail rows, so the caller rejects it rather than silently ignoring it.
fn find_filter_owner(model: &DataModel, detail_table: &str, column: &str) -> Option<String> {
    for rel in model.relationships() {
        let other = if rel.from_table() == detail_table {
            Some(rel.to_table())
        } else if rel.to_table() == detail_table {
            Some(rel.from_table())
        } else {
            None
        };
        let Some(other) = other else {
            continue;
        };
        // Only an active, single-hop, single-column equi relationship is
        // propagatable. (`find_relationship` enforces active + direction; we
        // additionally require single-condition equi.)
        if !rel.is_active() || rel.conditions().len() != 1 || !rel.is_equi_only() {
            continue;
        }
        if model
            .table(other)
            .ok()
            .and_then(|t| t.column(column).ok())
            .is_some()
        {
            return Some(other.to_string());
        }
    }
    None
}

/// Convert a drillthrough request's [`OrderByClause`]s (detail-table columns
/// only) into connector [`OrderByExpr`]s.
///
/// Rejects an [`OrderTarget::Measure`] target (a drillthrough computes no
/// measures) and a column that does not belong to the detail table (the
/// connector orders the detail `SELECT` directly, with no joins, so dimension
/// columns are not available to sort by).
fn convert_order_by(
    clauses: &[OrderByClause],
    detail_table: &str,
) -> QueryResult<Vec<OrderByExpr>> {
    let mut out = Vec::with_capacity(clauses.len());
    for clause in clauses {
        match &clause.target {
            OrderTarget::Column(col) => {
                if !col.table.eq_ignore_ascii_case(detail_table) {
                    return Err(QueryError::InvalidQuery(format!(
                        "drillthrough ORDER BY column '{}.{}' is not a column of the detail \
                         table '{detail_table}' (only detail-table columns can be ordered by)",
                        col.table, col.column
                    )));
                }
                out.push(OrderByExpr {
                    target: OrderByTarget::Column(col.column.clone()),
                    descending: clause.descending,
                });
            }
            OrderTarget::Measure(name) => {
                return Err(QueryError::InvalidQuery(format!(
                    "drillthrough ORDER BY cannot reference a measure ('{name}') — a \
                     drillthrough returns raw rows and computes no measures"
                )));
            }
        }
    }
    Ok(out)
}

/// Project `batches` down to `columns` (in the requested order). An empty
/// `columns` list returns the batches unchanged (all columns).
fn project_columns(batches: Vec<RecordBatch>, columns: &[String]) -> QueryResult<Vec<RecordBatch>> {
    if columns.is_empty() {
        return Ok(batches);
    }
    let mut out = Vec::with_capacity(batches.len());
    for batch in &batches {
        let schema = batch.schema();
        let mut indices = Vec::with_capacity(columns.len());
        for name in columns {
            let idx = schema.index_of(name).map_err(|_| {
                QueryError::InvalidQuery(format!(
                    "drillthrough requested column '{name}' is not present in the detail table"
                ))
            })?;
            indices.push(idx);
        }
        out.push(batch.project(&indices)?);
    }
    Ok(out)
}

/// Truncate `batches` to at most `limit` rows total, preserving order.
fn truncate_batches(batches: Vec<RecordBatch>, limit: usize) -> Vec<RecordBatch> {
    let mut out = Vec::with_capacity(batches.len());
    let mut remaining = limit;
    for batch in batches {
        if remaining == 0 {
            break;
        }
        if batch.num_rows() <= remaining {
            remaining -= batch.num_rows();
            out.push(batch);
        } else {
            out.push(batch.slice(0, remaining));
            remaining = 0;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use arrow::array::{Float64Array, Int64Array};
    use arrow::datatypes::{DataType as ArrowType, Field, Schema};

    use super::*;
    use crate::request::ColumnRef;

    fn sample_batch(rows: usize) -> RecordBatch {
        RecordBatch::try_new(
            Arc::new(Schema::new(vec![
                Field::new("id", ArrowType::Int64, true),
                Field::new("amount", ArrowType::Float64, true),
            ])),
            vec![
                Arc::new(Int64Array::from_iter_values(0..rows as i64)),
                Arc::new(Float64Array::from_iter_values((0..rows).map(|i| i as f64))),
            ],
        )
        .unwrap()
    }

    #[test]
    fn truncate_batches_caps_total_rows() {
        let batches = vec![sample_batch(3), sample_batch(3)];
        let out = truncate_batches(batches, 4);
        let total: usize = out.iter().map(|b| b.num_rows()).sum();
        assert_eq!(total, 4);
    }

    #[test]
    fn truncate_batches_zero_limit_is_empty() {
        let out = truncate_batches(vec![sample_batch(5)], 0);
        let total: usize = out.iter().map(|b| b.num_rows()).sum();
        assert_eq!(total, 0);
    }

    #[test]
    fn truncate_batches_under_limit_is_unchanged() {
        let out = truncate_batches(vec![sample_batch(2)], 10);
        assert_eq!(out.iter().map(|b| b.num_rows()).sum::<usize>(), 2);
    }

    #[test]
    fn project_columns_empty_returns_all() {
        let batches = vec![sample_batch(2)];
        let out = project_columns(batches, &[]).unwrap();
        assert_eq!(out[0].num_columns(), 2);
    }

    #[test]
    fn project_columns_selects_and_reorders() {
        let out = project_columns(vec![sample_batch(2)], &["amount".into(), "id".into()]).unwrap();
        assert_eq!(out[0].num_columns(), 2);
        assert_eq!(out[0].schema().field(0).name(), "amount");
        assert_eq!(out[0].schema().field(1).name(), "id");
    }

    #[test]
    fn project_columns_unknown_column_errors() {
        let err = project_columns(vec![sample_batch(1)], &["ghost".into()]).unwrap_err();
        assert!(matches!(err, QueryError::InvalidQuery(_)));
    }

    #[test]
    fn convert_order_by_accepts_detail_column() {
        let clauses = vec![OrderByClause::column_desc("Sales", "id")];
        let out = convert_order_by(&clauses, "Sales").unwrap();
        assert_eq!(out.len(), 1);
        assert!(out[0].descending);
        assert_eq!(out[0].target, OrderByTarget::Column("id".to_string()));
    }

    #[test]
    fn convert_order_by_rejects_foreign_table_column() {
        let clauses = vec![OrderByClause::column("Geography", "region")];
        let err = convert_order_by(&clauses, "Sales").unwrap_err();
        assert!(matches!(err, QueryError::InvalidQuery(_)));
    }

    #[test]
    fn convert_order_by_rejects_measure_target() {
        let clauses = vec![OrderByClause::measure("Revenue")];
        let err = convert_order_by(&clauses, "Sales").unwrap_err();
        assert!(matches!(err, QueryError::InvalidQuery(_)));
    }

    #[test]
    fn convert_order_by_is_case_insensitive_on_table_name() {
        let clauses = vec![OrderByClause {
            target: OrderTarget::Column(ColumnRef::new("sales", "id")),
            descending: false,
        }];
        assert!(convert_order_by(&clauses, "Sales").is_ok());
    }
}
