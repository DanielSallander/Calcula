//! Pushdown planner: decides what to push to data sources vs. compute locally.

mod collect;
mod collector;
mod context_filters;
mod hierarchy;
mod lookups;
mod projection;
mod source_sql;
#[cfg(test)]
mod test_util;
mod totals_order;

pub use hierarchy::{effective_group_by, HierarchyLevelSpec, HierarchySpec};

use engine_connectors::{AggregateExpr, FetchRequest, FilterCondition};
use engine_core::compute::measure::Measure;
use engine_core::model::DataModel;

use crate::error::{QueryError, QueryResult};
use crate::registry::SourceRegistry;
use crate::request::{ColumnRef, OrderByClause, QueryRequest, TotalsMode};

use collect::{
    collect_named_context_tables, collect_query_binding_names, collect_userelationship_tables,
    collect_variable_tables, has_table_variable_refs,
};
use context_filters::compute_pushable_context_filters;
pub(crate) use hierarchy::resolve_hierarchy;
use lookups::resolve_lookups;
use projection::compute_table_projections;
use source_sql::{aggregate_op_to_function, build_join_aggregation_request, has_unpushable_ops};
use totals_order::{
    build_pushed_order_by, canonical_effective_order, order_requires_sort_substitution,
    validate_order_by, validate_totals,
};

/// The outcome of query planning: what to push down vs. compute locally.
#[derive(Debug)]
pub enum QueryPlan {
    /// The entire aggregation can be pushed to a single data source.
    PushedAggregation {
        /// The model table name (fact table).
        source_table: String,
        /// The `FetchRequest` with aggregation to send to the connector.
        request: FetchRequest,
    },
    /// Multi-table aggregation pushed to source via structured request.
    ///
    /// Used when all tables share the same connector. The connector
    /// renders the request using its own SQL dialect.
    ///
    /// The pushed join SQL itself is not ordered; `order_by` and `limit` are
    /// applied locally (Arrow-level) to the result rows it returns. When the
    /// effective ordering requires sort-by-column substitution (the sort
    /// column is not part of the result), the planner does not choose this
    /// plan and falls back to [`QueryPlan::LocalAggregation`] instead.
    PushedJoinAggregation {
        /// Any model table name (to look up the connector).
        source_table: String,
        /// Structured join aggregation request (dialect-neutral).
        request: engine_connectors::JoinAggregationRequest,
        /// Effective ORDER BY clauses (explicit, or derived from `group_by`).
        order_by: Vec<OrderByClause>,
        /// Maximum number of result rows, applied after ordering.
        limit: Option<usize>,
    },
    /// Must fetch raw data and aggregate locally.
    ///
    /// Filters are still pushed to the source in the `FetchRequest`.
    LocalAggregation {
        /// Requests to fetch raw data, keyed by model table name.
        fetches: Vec<(String, FetchRequest)>,
        /// Measures to compute locally.
        measures: Vec<Measure>,
        /// Dimension columns to group by.
        group_by: Vec<ColumnRef>,
        /// Columns to look up post-aggregation via JOIN + resolution expression.
        lookup_specs: Vec<LookupSpec>,
        /// Effective ORDER BY clauses (explicit, or derived from `group_by`).
        order_by: Vec<OrderByClause>,
        /// Maximum number of result rows, applied after ordering.
        limit: Option<usize>,
        /// Whether to add ROLLUP subtotal rows to the local aggregation
        /// (rendered as `GROUP BY ROLLUP` in the local DataFusion SQL).
        totals: TotalsMode,
        /// Resolved hierarchy group-by, when the request used one.
        ///
        /// The hierarchy's level columns are already expanded into
        /// `group_by`; this spec tells the executor which of those columns
        /// are hierarchy levels and which [`RaggedBehavior`] transforms to
        /// apply (see [`HierarchySpec`]).
        ///
        /// [`RaggedBehavior`]: engine_core::model::RaggedBehavior
        hierarchy: Option<HierarchySpec>,
    },
}

/// A lookup column resolved by the planner: contains the pre-rendered SQL
/// for the resolution expression used in the post-aggregation JOIN.
#[derive(Debug, Clone)]
pub struct LookupSpec {
    /// The dimension table containing the lookup column.
    pub table: String,
    /// The column to look up.
    pub column: String,
    /// The key column to join on (in both the aggregated result and dimension table).
    pub key_column: String,
    /// Pre-rendered SQL resolution expression (e.g., `MIN(dim."col")`).
    pub resolution_sql: String,
}

/// Diagnostics describing column-projection decisions made while planning
/// `LocalAggregation` source fetches.
///
/// A fetch with an empty `columns` list is executed as `SELECT *`. This
/// struct records why projection was skipped for specific tables so that
/// `plan_explained` can report it.
#[derive(Debug, Clone, Default)]
pub struct ProjectionDiagnostics {
    /// `(table, reason)` pairs for tables fetched without column projection.
    /// The table name `"*"` means projection was disabled for all tables.
    pub fallbacks: Vec<(String, String)>,
}

/// The pushdown planner analyzes a query request and produces an execution plan.
pub struct PushdownPlanner;

impl PushdownPlanner {
    /// Analyze a query request and produce a plan.
    ///
    /// The planner resolves measure definitions from the `DataModel`, checks
    /// which tables are involved and whether they share a data source, and
    /// decides whether to push the aggregation to the source or compute locally.
    pub fn plan(
        request: &QueryRequest,
        model: &DataModel,
        registry: &SourceRegistry,
    ) -> QueryResult<QueryPlan> {
        Self::plan_with_cached(request, model, registry, &std::collections::HashSet::new())
    }

    /// Analyze a query request and produce a plan along with column-projection
    /// diagnostics describing which tables fall back to a full fetch.
    ///
    /// Used by `plan_explained` to report projection decisions.
    pub fn plan_with_diagnostics(
        request: &QueryRequest,
        model: &DataModel,
        registry: &SourceRegistry,
    ) -> QueryResult<(QueryPlan, ProjectionDiagnostics)> {
        Self::plan_with_cached_diagnostics(
            request,
            model,
            registry,
            &std::collections::HashSet::new(),
        )
    }

    /// Analyze a query request and produce a plan, treating tables in
    /// `cached_tables` as locally cached (same as in-memory tables for
    /// pushdown decisions).
    pub fn plan_with_cached(
        request: &QueryRequest,
        model: &DataModel,
        registry: &SourceRegistry,
        cached_tables: &std::collections::HashSet<String>,
    ) -> QueryResult<QueryPlan> {
        Ok(Self::plan_with_cached_diagnostics(request, model, registry, cached_tables)?.0)
    }

    /// Analyze a query request and produce a plan plus projection diagnostics,
    /// treating tables in `cached_tables` as locally cached.
    ///
    /// For `LocalAggregation` plans, each source fetch carries the exact set
    /// of columns required by the query (measure references, group-by columns,
    /// relationship join keys, filter columns, calculated-column inputs, and
    /// lookup columns). Tables whose requirements cannot be statically
    /// determined fall back to a full fetch (empty `columns`), with the reason
    /// recorded in the returned [`ProjectionDiagnostics`].
    pub fn plan_with_cached_diagnostics(
        request: &QueryRequest,
        model: &DataModel,
        registry: &SourceRegistry,
        cached_tables: &std::collections::HashSet<String>,
    ) -> QueryResult<(QueryPlan, ProjectionDiagnostics)> {
        if request.measures.is_empty() {
            return Err(QueryError::InvalidQuery(
                "at least one measure is required".into(),
            ));
        }

        // Resolve and expand a hierarchy group-by FIRST: the hierarchy's
        // level columns are appended to `group_by` (see `effective_group_by`
        // in the `hierarchy` module), and everything downstream — ORDER BY
        // validation and defaulting, totals validation, lookup-key
        // inference, projections, fetch construction — operates on the
        // expanded request, treating the levels as ordinary group-by
        // columns.
        let hierarchy_spec = resolve_hierarchy(request, model)?;
        let expanded_request: QueryRequest;
        let request: &QueryRequest = match &hierarchy_spec {
            Some(spec) => {
                let mut group_by = request.group_by.clone();
                group_by.extend(spec.level_column_refs());
                expanded_request = QueryRequest {
                    group_by,
                    ..request.clone()
                };
                &expanded_request
            }
            None => request,
        };
        // Ragged behaviors that transform or filter level values (and
        // stoppers, which must be NULL-normalized) are rendered into the
        // local DataFusion SQL — they force LocalAggregation below.
        let hierarchy_needs_local = hierarchy_spec.as_ref().is_some_and(|s| s.needs_local());

        // Validate ORDER BY targets against group_by and measures.
        validate_order_by(request)?;

        // Validate ROLLUP totals constraints (see `TotalsMode` docs).
        validate_totals(request)?;

        // Resolve all measures.
        let measures: Vec<Measure> = request
            .measures
            .iter()
            .map(|name| model.measure(name).cloned())
            .collect::<Result<Vec<_>, _>>()?;

        // Effective ordering: explicit clauses, or the group-by columns
        // (ascending) when none were given. Targets are canonicalized to the
        // exact group-by column / measure-name spelling so SQL rendering
        // matches the SELECT list.
        let effective_order = canonical_effective_order(request, &measures);

        // Whether the effective ordering needs sort-by-column substitution
        // (a group-by column whose model `sort_by_column` differs from the
        // column itself). Pushed join SQL cannot express the `MIN(sort_col)`
        // ordering, so substitution forces local aggregation for join plans.
        let needs_sort_substitution = order_requires_sort_substitution(&effective_order, model);

        // Collect all referenced tables.
        let measure_tables: Vec<&str> = measures.iter().map(|m| m.table()).collect();
        let group_by_tables: Vec<&str> =
            request.group_by.iter().map(|c| c.table.as_str()).collect();

        // Collect tables referenced by context ops (KEEP filters, etc.).
        let context_tables: Vec<&str> = measures
            .iter()
            .flat_map(|m| m.expression().context_filter_tables())
            .collect();

        // Collect tables referenced by table variables (Keep.variables, QualifiedColumnRef).
        let variable_tables: Vec<String> = measures
            .iter()
            .flat_map(|m| collect_variable_tables(m.expression(), model))
            .collect();

        // Collect tables referenced by named context definitions (bare context names
        // in Keep.variables that aren't table variables).
        let named_context_tables: Vec<String> = measures
            .iter()
            .flat_map(|m| collect_named_context_tables(m.expression(), model))
            .collect();

        // Collect tables referenced by USERELATIONSHIP overrides.
        // When a measure activates an inactive relationship, both tables in
        // that relationship must be fetched and registered in DataFusion.
        let userelationship_tables: Vec<String> = measures
            .iter()
            .flat_map(|m| collect_userelationship_tables(m.expression(), model))
            .collect();

        // Collect QUERY binding names from Block expressions — these are
        // intermediate tables computed at runtime, not registered data sources.
        let query_binding_names: std::collections::HashSet<String> = measures
            .iter()
            .flat_map(|m| collect_query_binding_names(m.expression()))
            .collect();

        // Collect all referenced tables (deduplication happens below).
        let all_tables: Vec<&str> = measure_tables
            .iter()
            .chain(group_by_tables.iter())
            .chain(context_tables.iter())
            .copied()
            .chain(variable_tables.iter().map(|s| s.as_str()))
            .chain(named_context_tables.iter().map(|s| s.as_str()))
            .chain(userelationship_tables.iter().map(|s| s.as_str()))
            .collect();

        // Verify all tables have registered sources (skip QUERY binding names).
        for table in &all_tables {
            if query_binding_names.contains(&table.to_lowercase()) {
                continue;
            }
            if !registry.has_table(table) {
                return Err(QueryError::SourceNotRegistered(table.to_string()));
            }
        }

        // Single-table case: all measures and group_by on the same table.
        // Only push if all measures are simple aggregates (AGG(column))
        // AND no measure has context operations (keep/clear/reset/etc.)
        // AND no measure references table variables (which need local context resolution).
        let unique_tables: std::collections::HashSet<&str> = all_tables.iter().copied().collect();
        let all_simple = measures.iter().all(|m| m.is_simple_aggregate());
        let any_context_ops = measures.iter().any(|m| m.expression().has_context_ops());
        let any_table_var_refs = measures
            .iter()
            .any(|m| has_table_variable_refs(m.expression(), model));

        // Resolve lookup columns (if any).
        let lookup_specs = resolve_lookups(&request.lookups, &request.group_by, model)?;

        // In-memory or auto-tiered tables are already local — never push aggregates to a source.
        let any_in_memory = all_tables.iter().any(|t| {
            model.table(t).is_ok_and(|tbl| tbl.is_in_memory()) || cached_tables.contains(*t)
        });

        // Statistical aggregates (MEDIAN, STDEV, etc.) cannot be pushed down.
        let all_pushable = measures.iter().all(|m| {
            m.simple_operation()
                .and_then(aggregate_op_to_function)
                .is_some()
        });

        if unique_tables.len() == 1
            && all_simple
            && all_pushable
            && !any_context_ops
            && !any_table_var_refs
            && lookup_specs.is_empty()
            && !any_in_memory
            && !hierarchy_needs_local
        {
            // ORDER BY / LIMIT are rendered into the pushed SQL. Sort-by
            // substitution uses `MIN(sort_col)` on the same (single) table.
            // `None` means an ordering entry is not expressible at the source
            // (the sort column is not a physical source column, e.g. a
            // calculated column) — fall through to local aggregation, which
            // materializes calculated columns before ordering.
            if let Some(pushed_order) = build_pushed_order_by(&effective_order, model) {
                let table_name = all_tables[0];
                let binding = registry.binding_for(table_name)?;

                let aggregates: Vec<AggregateExpr> = measures
                    .iter()
                    .map(|m| {
                        // Safe to unwrap: we checked is_simple_aggregate and all_pushable above.
                        let col = m.simple_column().unwrap();
                        let op = m.simple_operation().unwrap();
                        AggregateExpr {
                            column: col.to_string(),
                            function: aggregate_op_to_function(op).unwrap(),
                            alias: Some(m.name().to_string()),
                        }
                    })
                    .collect();

                let group_by: Vec<String> =
                    request.group_by.iter().map(|c| c.column.clone()).collect();

                let fetch = FetchRequest {
                    schema: Some(binding.schema.clone()),
                    table: binding.table.clone(),
                    filters: request.filters.clone(),
                    group_by,
                    aggregates,
                    order_by: pushed_order,
                    limit: request.limit,
                    // Real ROLLUP rendered at the source: the connector adds
                    // `GROUP BY ROLLUP (...)` plus the trailing grouping-id
                    // column (see `FetchRequest::rollup_totals`).
                    rollup_totals: request.totals == TotalsMode::Rollup,
                    ..Default::default()
                };

                return Ok((
                    QueryPlan::PushedAggregation {
                        source_table: table_name.to_string(),
                        request: fetch,
                    },
                    ProjectionDiagnostics::default(),
                ));
            }
        }

        // Whether any measure contains operations that cannot be expressed
        // in source SQL: RESET/CLEAR_INNER/USERELATIONSHIP-style context
        // ops, two-stage constructs (QUERY, window functions), and
        // host-registered UDF calls (which exist only in the local
        // DataFusion session). Any of these force LocalAggregation.
        let has_unpushable_context = measures.iter().any(|m| has_unpushable_ops(m.expression()));

        // Single-table with compound expressions (not simple aggregates):
        // use PushedJoinAggregation (no JOINs needed, just compound SQL).
        // Skipped when a measure contains unpushable operations (UDF calls,
        // two-stage constructs) — those must be evaluated locally.
        // Skipped when the effective ordering needs sort-by-column
        // substitution — the pushed join result lacks the sort column, so
        // ordering must happen in local SQL (LocalAggregation below).
        // Skipped when ROLLUP totals are requested — the join request cannot
        // express ROLLUP, so totals fall back to LocalAggregation (which
        // renders ROLLUP into the local DataFusion SQL).
        if unique_tables.len() == 1
            && !any_context_ops
            && !has_unpushable_context
            && !any_table_var_refs
            && lookup_specs.is_empty()
            && !any_in_memory
            && !needs_sort_substitution
            && request.totals == TotalsMode::None
            && !hierarchy_needs_local
        {
            let table_name = all_tables[0];
            if let Ok(req) = build_join_aggregation_request(
                &measures,
                &request.group_by,
                &request.filters,
                &all_tables,
                model,
                registry,
            ) {
                return Ok((
                    QueryPlan::PushedJoinAggregation {
                        source_table: table_name.to_string(),
                        request: req,
                        order_by: effective_order.clone(),
                        limit: request.limit,
                    },
                    ProjectionDiagnostics::default(),
                ));
            }
        }

        // Multi-table same-source case: if all tables share the same connector
        // and measures have no unpushable context ops or table variable refs,
        // push a JOIN query with compound SQL expressions directly to the source.
        // KEEP is pushable (translates to CASE WHEN), but CLEAR/RESET/UseRelationship are not.
        // Skipped when ordering needs sort-by-column substitution (see above).
        //
        // Bidirectional (FilterPropagation::Both) analysis: pushed plans need
        // no special handling and no plan-shape change. The pushed join runs
        // as ONE SQL statement whose relationships render as INNER JOINs
        // (`build_join_aggregation_request` → connector `JOIN` rendering), and
        // an INNER JOIN naturally filters both ways within the statement: a
        // dimension-side aggregate evaluated there only sees dimension rows
        // matched by the surviving (filtered) fact rows. So Both-like
        // semantics already hold for pushed plans at the database's own join
        // semantics. The missing case is exclusively LocalAggregation, where
        // each table is fetched separately — handled at fetch time by the
        // pipeline (see `executor/pipeline/bidirectional.rs`).
        if !has_unpushable_context
            && !any_table_var_refs
            && lookup_specs.is_empty()
            && !any_in_memory
            && unique_tables.len() > 1
            && !needs_sort_substitution
            && request.totals == TotalsMode::None
            && !hierarchy_needs_local
        {
            // Check if all tables share the same connector.
            let first_table = all_tables[0];
            if let Ok(first_idx) = registry.connector_index_for(first_table) {
                let all_same_source = all_tables
                    .iter()
                    .filter(|t| !query_binding_names.contains(&t.to_lowercase()))
                    .all(|t| registry.connector_index_for(t).ok() == Some(first_idx));

                if all_same_source {
                    if let Ok(req) = build_join_aggregation_request(
                        &measures,
                        &request.group_by,
                        &request.filters,
                        &all_tables,
                        model,
                        registry,
                    ) {
                        return Ok((
                            QueryPlan::PushedJoinAggregation {
                                source_table: first_table.to_string(),
                                request: req,
                                order_by: effective_order.clone(),
                                limit: request.limit,
                            },
                            ProjectionDiagnostics::default(),
                        ));
                    }
                }
            }
        }

        // Multi-table (star-schema) case: fetch raw data, aggregate locally.
        //
        // Even though the aggregation is local, we can still push KEEP filter
        // predicates to source fetches for dimension tables that are referenced
        // only through context operations. This reduces data volume at the source.
        //
        // Relationships marked FilterPropagation::Both get reverse
        // (fact → dimension) IN-filter propagation at fetch time in the
        // pipeline (`executor/pipeline/bidirectional.rs`) — a pure fetch
        // enrichment, so the plan shape built here is unchanged.
        let pushable_context_filters =
            compute_pushable_context_filters(&measures, &measure_tables, &group_by_tables);

        // Determine the distinct set of tables that will be fetched (skipping
        // QUERY binding names, including lookup-only tables) so the column
        // projection can account for every relationship and lookup among them.
        let mut projection_tables: Vec<String> = Vec::new();
        {
            let mut seen = std::collections::HashSet::new();
            for table_name in &all_tables {
                if query_binding_names.contains(&table_name.to_lowercase()) {
                    continue;
                }
                if seen.insert(*table_name) {
                    projection_tables.push((*table_name).to_string());
                }
            }
            for spec in &lookup_specs {
                if seen.insert(spec.table.as_str()) {
                    projection_tables.push(spec.table.clone());
                }
            }
        }

        // Compute the exact source columns each fetch needs. Tables whose
        // requirements cannot be statically determined fall back to a full
        // fetch (empty column list = SELECT *).
        let projections = compute_table_projections(
            request,
            model,
            &measures,
            &projection_tables,
            &lookup_specs,
            cached_tables,
        );

        let mut fetches = Vec::new();
        let mut seen_tables = std::collections::HashSet::new();

        for table_name in &all_tables {
            // Skip QUERY binding names — they are intermediate tables, not sources.
            if query_binding_names.contains(&table_name.to_lowercase()) {
                continue;
            }
            if seen_tables.insert(*table_name) {
                let binding = registry.binding_for(table_name)?;

                // Push filters that apply to this table.
                let mut table_filters: Vec<FilterCondition> = request
                    .filters
                    .iter()
                    .filter(|f| {
                        // Simple heuristic: filter applies to this table if the
                        // column exists in the model table.
                        model
                            .table(table_name)
                            .ok()
                            .and_then(|t| t.column(&f.column).ok())
                            .is_some()
                    })
                    .cloned()
                    .collect();

                // Add pushable context filters for this table.
                if let Some(context_filters) = pushable_context_filters.get(*table_name) {
                    table_filters.extend(context_filters.iter().cloned());
                }

                let fetch = FetchRequest {
                    schema: Some(binding.schema.clone()),
                    table: binding.table.clone(),
                    columns: projections.columns_for(table_name),
                    filters: table_filters,
                    ..Default::default()
                };

                fetches.push((table_name.to_string(), fetch));
            }
        }

        // Ensure lookup tables are included in fetches.
        for spec in &lookup_specs {
            if seen_tables.insert(spec.table.as_str()) {
                let binding = registry.binding_for(&spec.table)?;
                let fetch = FetchRequest {
                    schema: Some(binding.schema.clone()),
                    table: binding.table.clone(),
                    columns: projections.columns_for(&spec.table),
                    ..Default::default()
                };
                fetches.push((spec.table.clone(), fetch));
            }
        }

        let diagnostics = projections.into_diagnostics();

        Ok((
            QueryPlan::LocalAggregation {
                fetches,
                measures,
                group_by: request.group_by.clone(),
                lookup_specs,
                order_by: effective_order,
                limit: request.limit,
                totals: request.totals,
                hierarchy: hierarchy_spec,
            },
            diagnostics,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::test_util::*;
    use super::*;
    use engine_connectors::AggregateFunction;
    use engine_core::model::{Column, Table};
    use engine_core::types::DataType;

    #[test]
    fn single_table_produces_pushed_plan() {
        let model = test_model_single_table();
        // Use index 0 even though no real connector — planner only checks index equality.
        let registry = mock_registry_single(0);

        let request = QueryRequest {
            measures: vec!["TotalAmount".into()],
            group_by: vec![ColumnRef::new("Sales", "region")],
            filters: vec![],
            lookups: vec![],
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry).unwrap();

        match plan {
            QueryPlan::PushedAggregation {
                source_table,
                request,
            } => {
                assert_eq!(source_table, "Sales");
                assert_eq!(request.aggregates.len(), 1);
                assert_eq!(request.aggregates[0].function, AggregateFunction::Sum);
                assert_eq!(request.aggregates[0].column, "amount");
                assert_eq!(request.group_by, vec!["region".to_string()]);
                assert_eq!(request.schema.as_deref(), Some("sales"));
                assert_eq!(request.table, "salesorderheader");
            }
            other => panic!("Expected PushedAggregation, got {other:?}"),
        }
    }

    #[test]
    fn multiple_measures_same_table_pushed() {
        let model = test_model_single_table();
        let registry = mock_registry_single(0);

        let request = QueryRequest {
            measures: vec!["TotalAmount".into(), "OrderCount".into()],
            group_by: vec![],
            filters: vec![],
            lookups: vec![],
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry).unwrap();

        match plan {
            QueryPlan::PushedAggregation { request, .. } => {
                assert_eq!(request.aggregates.len(), 2);
            }
            other => panic!("Expected PushedAggregation, got {other:?}"),
        }
    }

    #[test]
    fn star_schema_same_source_produces_pushed_join() {
        let model = test_model_star_schema();
        let registry = mock_registry_star(0);

        let request = QueryRequest {
            measures: vec!["TotalAmount".into()],
            group_by: vec![ColumnRef::new("Products", "category")],
            filters: vec![],
            lookups: vec![],
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry).unwrap();

        match plan {
            QueryPlan::PushedJoinAggregation {
                source_table,
                request: req,
                ..
            } => {
                assert_eq!(source_table, "Sales");
                assert!(!req.joins.is_empty(), "Expected JOINs");
                assert!(!req.measures.is_empty(), "Expected measures");
            }
            other => panic!("Expected PushedJoinAggregation, got {other:?}"),
        }
    }

    #[test]
    fn star_schema_cross_source_produces_local_plan() {
        let model = test_model_star_schema();
        let registry = make_cross_source_registry();

        let request = QueryRequest {
            measures: vec!["TotalAmount".into()],
            group_by: vec![ColumnRef::new("Products", "category")],
            filters: vec![],
            lookups: vec![],
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry).unwrap();

        match plan {
            QueryPlan::LocalAggregation { fetches, .. } => {
                assert_eq!(fetches.len(), 2);
            }
            other => panic!("Expected LocalAggregation, got {other:?}"),
        }
    }

    #[test]
    fn unknown_measure_returns_error() {
        let model = test_model_single_table();
        let registry = mock_registry_single(0);

        let request = QueryRequest {
            measures: vec!["NonExistent".into()],
            group_by: vec![],
            filters: vec![],
            lookups: vec![],
            ..Default::default()
        };

        let result = PushdownPlanner::plan(&request, &model, &registry);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("NonExistent"));
    }

    #[test]
    fn unregistered_source_returns_error() {
        let model = test_model_single_table();
        let registry = SourceRegistry::new(); // empty — no bindings

        let request = QueryRequest {
            measures: vec!["TotalAmount".into()],
            group_by: vec![],
            filters: vec![],
            lookups: vec![],
            ..Default::default()
        };

        let result = PushdownPlanner::plan(&request, &model, &registry);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Sales"));
    }

    #[test]
    fn cross_source_produces_local_plan() {
        let model = test_model_star_schema();
        let registry = mock_registry_cross_source();

        let request = QueryRequest {
            measures: vec!["TotalAmount".into()],
            group_by: vec![ColumnRef::new("Products", "category")],
            filters: vec![],
            lookups: vec![],
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry).unwrap();

        match plan {
            QueryPlan::LocalAggregation {
                fetches,
                measures,
                group_by,
                ..
            } => {
                assert_eq!(fetches.len(), 2);
                assert_eq!(measures.len(), 1);
                assert_eq!(measures[0].name(), "TotalAmount");
                assert_eq!(group_by.len(), 1);
                assert_eq!(group_by[0].table, "Products");
            }
            other => panic!("Expected LocalAggregation, got {other:?}"),
        }
    }

    #[test]
    fn cross_source_fetches_have_correct_bindings() {
        let model = test_model_star_schema();
        let registry = mock_registry_cross_source();

        let request = QueryRequest {
            measures: vec!["TotalAmount".into()],
            group_by: vec![ColumnRef::new("Products", "category")],
            filters: vec![],
            lookups: vec![],
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry).unwrap();

        match plan {
            QueryPlan::LocalAggregation { fetches, .. } => {
                // Sales fetch has sales schema.
                let sales_fetch = fetches.iter().find(|(n, _)| n == "Sales").unwrap();
                assert_eq!(sales_fetch.1.schema.as_deref(), Some("sales"));
                assert_eq!(sales_fetch.1.table, "salesorderheader");

                // Products fetch has production schema.
                let products_fetch = fetches.iter().find(|(n, _)| n == "Products").unwrap();
                assert_eq!(products_fetch.1.schema.as_deref(), Some("production"));
                assert_eq!(products_fetch.1.table, "product");
            }
            other => panic!("Expected LocalAggregation, got {other:?}"),
        }
    }

    #[test]
    fn measure_with_context_ops_forces_local() {
        use engine_core::compute::aggregate::AggregateOp;
        use engine_core::compute::expression::{self as expr, ComparisonOp, FilterPredicate};
        use engine_core::compute::measure::expression_measure;

        let sales = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("amount", DataType::Float64),
                Column::new("region", DataType::String),
            ],
        )
        .unwrap();

        let model = DataModel::builder()
            .add_table(sales)
            .add_measure(expression_measure(
                "US_Revenue",
                expr::agg(
                    AggregateOp::Sum,
                    expr::keep(
                        expr::qualified_col("Sales", "amount"),
                        vec![FilterPredicate::new(
                            "Sales",
                            "region",
                            ComparisonOp::Equal,
                            "US",
                        )],
                    ),
                ),
            ))
            .build()
            .unwrap();

        let registry = mock_registry_single(0);

        let request = QueryRequest {
            measures: vec!["US_Revenue".into()],
            group_by: vec![],
            filters: vec![],
            lookups: vec![],
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry).unwrap();

        // Context ops force local aggregation even though it's single-table
        match plan {
            QueryPlan::LocalAggregation { measures, .. } => {
                assert_eq!(measures[0].name(), "US_Revenue");
            }
            other => panic!("Expected LocalAggregation, got {other:?}"),
        }
    }

    #[test]
    fn measure_with_udf_call_forces_local() {
        use engine_core::compute::aggregate::AggregateOp;
        use engine_core::compute::expression::{self as expr};
        use engine_core::compute::measure::expression_measure;

        let sales = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("amount", DataType::Float64),
            ],
        )
        .unwrap();

        // SUM(double(Sales[amount])) — `double` is a host-registered UDF the
        // source knows nothing about.
        let model = DataModel::builder()
            .add_table(sales)
            .add_measure(expression_measure(
                "DoubledRevenue",
                expr::agg(
                    AggregateOp::Sum,
                    expr::call("double", vec![expr::qualified_col("Sales", "amount")]),
                ),
            ))
            .build()
            .unwrap();

        let registry = mock_registry_single(0);

        let request = QueryRequest {
            measures: vec!["DoubledRevenue".into()],
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry).unwrap();

        // UDF calls are unpushable: even a single-table compound measure must
        // not become a PushedJoinAggregation (the source cannot render the
        // call) — it falls through to LocalAggregation.
        match plan {
            QueryPlan::LocalAggregation {
                measures, fetches, ..
            } => {
                assert_eq!(measures[0].name(), "DoubledRevenue");
                // ProjectionCollector walks Call args: the fetch projects the
                // argument column (and nothing else).
                let sales_fetch = fetches.iter().find(|(n, _)| n == "Sales").unwrap();
                assert_eq!(sales_fetch.1.columns, vec!["amount".to_string()]);
            }
            other => panic!("Expected LocalAggregation, got {other:?}"),
        }
    }

    #[test]
    fn udf_call_in_group_by_query_collects_arg_and_join_columns() {
        use engine_core::compute::aggregate::AggregateOp;
        use engine_core::compute::expression::{self as expr};
        use engine_core::compute::measure::expression_measure;

        // Star schema with a UDF measure, grouped by a dimension: the fact
        // fetch must project the call argument column plus the join key.
        let sales = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("product_id", DataType::Int64),
                Column::new("amount", DataType::Float64),
            ],
        )
        .unwrap();
        let products = Table::new(
            "Products",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("category", DataType::String),
            ],
        )
        .unwrap();
        let model = DataModel::builder()
            .add_table(sales)
            .add_table(products)
            .add_relationship(engine_core::model::Relationship::many_to_one(
                "Sales_Products",
                "Sales",
                "product_id",
                "Products",
                "id",
            ))
            .add_measure(expression_measure(
                "DoubledRevenue",
                expr::agg(
                    AggregateOp::Sum,
                    expr::call("double", vec![expr::qualified_col("Sales", "amount")]),
                ),
            ))
            .build()
            .unwrap();

        let registry = mock_registry_star(0);

        let request = QueryRequest {
            measures: vec!["DoubledRevenue".into()],
            group_by: vec![ColumnRef::new("Products", "category")],
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry).unwrap();
        match plan {
            QueryPlan::LocalAggregation { fetches, .. } => {
                let sales_fetch = fetches.iter().find(|(n, _)| n == "Sales").unwrap();
                assert!(
                    sales_fetch.1.columns.iter().any(|c| c == "amount"),
                    "fetch must project the Call argument column, got {:?}",
                    sales_fetch.1.columns
                );
            }
            other => panic!("Expected LocalAggregation, got {other:?}"),
        }
    }

    #[test]
    fn empty_measures_returns_error() {
        let model = test_model_single_table();
        let registry = mock_registry_single(0);

        let request = QueryRequest {
            measures: vec![],
            group_by: vec![],
            filters: vec![],
            lookups: vec![],
            ..Default::default()
        };

        let result = PushdownPlanner::plan(&request, &model, &registry);
        assert!(result.is_err());
    }
}
