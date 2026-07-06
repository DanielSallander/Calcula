//! Pushdown planner: decides what to push to data sources vs. compute locally.

mod collect;
mod collector;
mod context_filters;
mod hierarchy;
mod lookups;
mod projection;
mod security;
mod source_sql;
#[cfg(test)]
mod test_util;
mod totals_order;

pub use hierarchy::{effective_group_by, HierarchyLevelSpec, HierarchySpec};

// Re-exported for the executor's drillthrough path (`executor::pipeline::detail`),
// which must enforce the *same* RLS relevance / fail-closed check and seal the
// *same* role conditions onto its fetches as the aggregation planner. Sharing
// these keeps the two enforcement halves in lockstep.
pub(crate) use security::{rls_relevance, role_conditions_for_table};

use engine_connectors::{AggregateExpr, FetchRequest, FilterCondition};
use engine_core::compute::expression::{expand_measure_refs, infer_fact_table, FilterPredicate};
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

/// Convert a user [`InFilter`](crate::request::InFilter) on `table` into a
/// connector [`InFilterCondition`], inferring the value kind from the column's
/// model type: integer columns render bare (sargable), everything else as
/// escaped/quoted text (the safe default).
fn in_filter_condition(
    model: &DataModel,
    table: &str,
    filter: &crate::request::InFilter,
) -> engine_connectors::InFilterCondition {
    use engine_core::types::DataType;
    let is_integer = model
        .table(table)
        .ok()
        .and_then(|t| t.column(&filter.column).ok())
        .is_some_and(|c| matches!(c.data_type(), DataType::Int32 | DataType::Int64));
    engine_connectors::InFilterCondition {
        column: filter.column.clone(),
        values: filter.values.clone(),
        kind: if is_integer {
            engine_connectors::traits::InValueKind::Integer
        } else {
            engine_connectors::traits::InValueKind::Text
        },
    }
}

/// Upgrade integer-typed scalar and OR filters in a finished plan to a sargable
/// rendering.
///
/// Every filter is built with [`InValueKind::Text`] (the column is text-cast
/// and the value bound as a parameter — correct for any column type but
/// non-sargable, defeating source indexes). Once planning is done each fetch
/// carries a known model table, so a filter whose column is an integer type can
/// be rendered as `col op <literal>` against the *uncast* column, which an index
/// can serve. This is the scalar analogue of the IN-list `InValueKind::Integer`
/// optimization. Only integer columns are upgraded; the value is re-validated as
/// an integer at render time ([`FilterCondition::effective_kind`]), so nothing
/// untrusted is ever inlined.
fn apply_sargable_filter_kinds(plan: &mut QueryPlan, model: &DataModel) {
    use engine_connectors::FilterCondition;

    /// Stamp `Integer` onto each filter whose column is *unambiguously* an
    /// integer column across the candidate tables (integer in at least one, and
    /// never a non-integer type in any — so an ambiguous name stays text-safe).
    fn stamp(model: &DataModel, tables: &[&str], filters: &mut [FilterCondition]) {
        use engine_connectors::traits::InValueKind;
        use engine_core::types::DataType;
        for filter in filters.iter_mut() {
            let mut integer_somewhere = false;
            let mut conflicting = false;
            for table in tables {
                if let Some(col) = model
                    .table(table)
                    .ok()
                    .and_then(|t| t.column(&filter.column).ok())
                {
                    match col.data_type() {
                        DataType::Int32 | DataType::Int64 => integer_somewhere = true,
                        _ => conflicting = true,
                    }
                }
            }
            if integer_somewhere && !conflicting {
                filter.kind = InValueKind::Integer;
            }
        }
    }

    fn stamp_fetch(model: &DataModel, tables: &[&str], request: &mut FetchRequest) {
        stamp(model, tables, &mut request.filters);
        for group in request.or_groups.iter_mut() {
            stamp(model, tables, group);
        }
    }

    match plan {
        QueryPlan::PushedAggregation {
            source_table,
            request,
        } => stamp_fetch(model, &[source_table.as_str()], request),
        QueryPlan::LocalAggregation { fetches, .. } => {
            for (table, request) in fetches.iter_mut() {
                stamp_fetch(model, &[table.as_str()], request);
            }
        }
        QueryPlan::PushedJoinAggregation { request, .. } => {
            let tables: Vec<&str> =
                request.table_map.iter().map(|(m, _)| m.as_str()).collect();
            stamp(model, &tables, &mut request.filters);
        }
    }
}

/// Partition a query's filters for the context-column pushdown path, which
/// queries only the fact table.
///
/// Returns `Some(fact_filters)` when every filter can be handled by a fact-only
/// pushed query, and `None` (defer to local) otherwise:
///
/// - A filter on a column the **fact owns** is pushed onto the fact (it
///   restricts fact rows, exactly as local aggregation would).
/// - Any other filter must be owned **solely by table(s) disconnected from the
///   fact** (no relationship). Such a filter cannot restrict fact rows; it only
///   shaped a context column's scalar, which the facade has already resolved to
///   a literal — so it is correctly dropped here.
/// - A filter owned by a fact-**related** dimension (local aggregation would
///   propagate it to the fact) or by **no** table at all forces the local path,
///   which performs that relationship-aware propagation.
///
/// This keeps the pushed result identical to the local result for every filter
/// shape — the pushed path activates only when it provably matches.
fn context_pushdown_fact_filters(
    model: &DataModel,
    fact: &str,
    filters: &[FilterCondition],
) -> Option<Vec<FilterCondition>> {
    let fact_table = model.table(fact).ok()?;
    let mut fact_filters = Vec::new();
    for f in filters {
        if collector::resolve_physical_column(fact_table, &f.column).is_some() {
            fact_filters.push(f.clone());
            continue;
        }
        // Not a fact column: every owner must be disconnected from the fact.
        let mut any_owner = false;
        for owner in model.tables() {
            if collector::resolve_physical_column(owner, &f.column).is_none() {
                continue;
            }
            any_owner = true;
            if owner.name().eq_ignore_ascii_case(fact) {
                continue;
            }
            if model.find_any_relationship(fact, owner.name()).is_ok() {
                return None; // related-dimension filter — needs local propagation
            }
        }
        if !any_owner {
            return None; // unattributable filter — defer to local
        }
    }
    Some(fact_filters)
}

fn lc_set_has(set: &std::collections::HashSet<String>, target_lc: &str) -> bool {
    set.iter().any(|s| s.eq_ignore_ascii_case(target_lc))
}

fn lc_pair_set_has(
    set: &std::collections::HashSet<(String, String)>,
    table_lc: &str,
    column_lc: &str,
) -> bool {
    set.iter()
        .any(|(t, c)| t.eq_ignore_ascii_case(table_lc) && c.eq_ignore_ascii_case(column_lc))
}

/// Fail closed when a measure clears a table/column — via a **both-source**
/// (`CLEAR`/`RESET`/`CLEAREXCEPT`) or **outer** (`CLEAR_OUTER`/`RESET_OUTER`)
/// context op — that the request currently restricts with a report slicer.
///
/// The chosen semantics are REMOVEFILTERS: `CLEAR`/`RESET` remove BOTH the
/// group-by axis and report slicers. The axis half is delivered by the window
/// (`OVER (PARTITION BY …)`) render; the slicer half would require fetching the
/// cleared table *unfiltered*, which is not yet wired. Rather than silently
/// return an axis-only (slicer-respecting) number — wrong under the chosen
/// semantics, and inconsistent between the pushed and local paths — we refuse.
/// Axis-only clearing is available today via `CLEAR_INNER`/`RESET_INNER`, which
/// never touch slicers (and never reach this guard).
///
/// Runs before path selection so the pushed and local paths behave identically.
fn validate_no_slicer_clear(request: &QueryRequest, model: &DataModel) -> QueryResult<()> {
    use engine_core::compute::context::ContextResolver;

    // (owner_table_lc, column_lc) for every report slicer column.
    let mut sliced_cols: std::collections::HashSet<(String, String)> =
        std::collections::HashSet::new();
    let slicer_columns = request
        .filters
        .iter()
        .map(|f| f.column.as_str())
        .chain(request.or_filters.iter().map(|f| f.column.as_str()))
        .chain(request.in_filters.iter().map(|f| f.column.as_str()));
    for col in slicer_columns {
        for t in model.tables().iter().filter(|t| t.column(col).is_ok()) {
            sliced_cols.insert((t.name().to_lowercase(), col.to_lowercase()));
        }
    }
    if sliced_cols.is_empty() {
        return Ok(());
    }

    for m_name in &request.measures {
        // Missing / unresolvable measures are reported by the normal path.
        let Ok(measure) = model.measure(m_name) else {
            continue;
        };
        let Ok(expanded) = expand_measure_refs(measure.expression(), model) else {
            continue;
        };
        let Ok((_, ctx)) = ContextResolver::new(model).resolve(&expanded) else {
            continue;
        };

        // `is_reset` / `is_reset_outer` drop ALL query-level filters — any slicer
        // present is one they would need to strip. `is_reset_inner` is axis-only.
        let clears_all_slicers = ctx.is_reset || ctx.is_reset_outer;
        let offending = if clears_all_slicers {
            sliced_cols.iter().next()
        } else {
            sliced_cols.iter().find(|(t, c)| {
                lc_set_has(&ctx.cleared_tables, t)
                    || lc_set_has(&ctx.cleared_outer_tables, t)
                    || lc_pair_set_has(&ctx.cleared_columns, t, c)
                    || lc_pair_set_has(&ctx.cleared_outer_columns, t, c)
                    || ctx.clear_except.iter().any(|(et, preserved)| {
                        et.eq_ignore_ascii_case(t)
                            && !preserved.iter().any(|p| p.eq_ignore_ascii_case(c))
                    })
            })
        };

        if let Some((t, c)) = offending {
            return Err(QueryError::InvalidQuery(format!(
                "measure '{m_name}' clears '{t}[{c}]' (via CLEAR/RESET/CLEAREXCEPT or \
                 CLEAR_OUTER/RESET_OUTER), which the query currently restricts with a report \
                 slicer. Removing a report slicer from inside a measure (REMOVEFILTERS \
                 semantics) is not yet supported. Use CLEAR_INNER/RESET_INNER to ignore only \
                 the group-by axis while keeping slicers, or remove the slicer from the request."
            )));
        }
    }
    Ok(())
}

/// The pushdown planner analyzes a query request and produces an execution plan.
pub struct PushdownPlanner;

impl PushdownPlanner {
    /// Analyze a query request and produce a plan.
    ///
    /// The planner resolves measure definitions from the `DataModel`, checks
    /// which tables are involved and whether they share a data source, and
    /// decides whether to push the aggregation to the source or compute locally.
    ///
    /// `role_filters` are the active security role's predicates (empty when no
    /// role is active). They are applied as a sealed pre-aggregation filter on
    /// every table they target; see the [`security`] module for the
    /// enforcement model.
    pub fn plan(
        request: &QueryRequest,
        model: &DataModel,
        registry: &SourceRegistry,
        role_filters: &[FilterPredicate],
    ) -> QueryResult<QueryPlan> {
        Self::plan_with_cached(
            request,
            model,
            registry,
            &std::collections::HashSet::new(),
            role_filters,
        )
    }

    /// Analyze a query request and produce a plan along with column-projection
    /// diagnostics describing which tables fall back to a full fetch.
    ///
    /// Used by `plan_explained` to report projection decisions.
    pub fn plan_with_diagnostics(
        request: &QueryRequest,
        model: &DataModel,
        registry: &SourceRegistry,
        role_filters: &[FilterPredicate],
    ) -> QueryResult<(QueryPlan, ProjectionDiagnostics)> {
        Self::plan_with_cached_diagnostics(
            request,
            model,
            registry,
            &std::collections::HashSet::new(),
            role_filters,
            &[],
        )
    }

    /// Like [`plan`](Self::plan), but with facade-resolved context-driven
    /// calculated column expressions (each a row-level `CASE` whose scalar
    /// measure is already substituted to a literal). When a context column is
    /// on the group-by axis and the query is otherwise pushable on a connector
    /// that supports expression pushdown, the planner pushes the `CASE` into the
    /// source GROUP BY instead of forcing local aggregation.
    pub fn plan_with_context_columns(
        request: &QueryRequest,
        model: &DataModel,
        registry: &SourceRegistry,
        role_filters: &[FilterPredicate],
        context_column_cases: &[(ColumnRef, engine_core::compute::expression::Expression)],
    ) -> QueryResult<QueryPlan> {
        Ok(Self::plan_with_cached_diagnostics(
            request,
            model,
            registry,
            &std::collections::HashSet::new(),
            role_filters,
            context_column_cases,
        )?
        .0)
    }

    /// Analyze a query request and produce a plan, treating tables in
    /// `cached_tables` as locally cached (same as in-memory tables for
    /// pushdown decisions).
    pub fn plan_with_cached(
        request: &QueryRequest,
        model: &DataModel,
        registry: &SourceRegistry,
        cached_tables: &std::collections::HashSet<String>,
        role_filters: &[FilterPredicate],
    ) -> QueryResult<QueryPlan> {
        Ok(Self::plan_with_cached_diagnostics(
            request,
            model,
            registry,
            cached_tables,
            role_filters,
            &[],
        )?
        .0)
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
        role_filters: &[FilterPredicate],
        context_column_cases: &[(ColumnRef, engine_core::compute::expression::Expression)],
    ) -> QueryResult<(QueryPlan, ProjectionDiagnostics)> {
        let (mut plan, diagnostics) = Self::plan_with_cached_diagnostics_inner(
            request,
            model,
            registry,
            cached_tables,
            role_filters,
            context_column_cases,
        )?;
        // Post-pass: now that every fetch in the plan carries a known model
        // table, upgrade integer-typed scalar/OR filters to a sargable
        // (uncast column, unquoted integer literal) rendering so source
        // indexes are usable. Correct-by-default text rendering is kept for
        // every other column type. See `apply_sargable_filter_kinds`.
        apply_sargable_filter_kinds(&mut plan, model);
        Ok((plan, diagnostics))
    }

    fn plan_with_cached_diagnostics_inner(
        request: &QueryRequest,
        model: &DataModel,
        registry: &SourceRegistry,
        cached_tables: &std::collections::HashSet<String>,
        role_filters: &[FilterPredicate],
        context_column_cases: &[(ColumnRef, engine_core::compute::expression::Expression)],
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

        // Context-driven calculated columns referenced on the group-by axis.
        // Each is rendered, per query, as a CASE expression in the local
        // DataFusion SQL (its scalar measure resolved from the filter context
        // and substituted as a literal), so a context column on the axis forces
        // LocalAggregation. The scalar measures they reference — and the model
        // tables those measures aggregate over — are pulled into the fetch set
        // so the executor can resolve the scalar against the (filtered) source
        // data. The executor re-derives the column definitions from the model;
        // the planner only needs the force-local signal and the extra fetches.
        let context_columns_on_axis: Vec<&engine_core::model::ContextColumn> = request
            .group_by
            .iter()
            .filter_map(|c| {
                model
                    .context_column(&c.column)
                    .filter(|cc| cc.table().eq_ignore_ascii_case(&c.table))
            })
            .collect();
        let has_context_columns = !context_columns_on_axis.is_empty();
        // The scalar measures referenced by those columns, plus the tables they
        // aggregate over (added to `all_tables` below). Scalar source tables are
        // probed, NOT joined, so they are later excluded from the RLS
        // query-table set (a role on one must restrict via two-phase propagation
        // or fail closed, never via a join that does not exist).
        let mut context_scalar_measures: Vec<Measure> = Vec::new();
        let mut context_scalar_tables: Vec<String> = Vec::new();
        // Tables a context column references across a (fan-out-safe) relationship
        // in its row-level expression (v2 cross-table references). These ARE
        // LEFT JOINed into the main statement, so they stay in the RLS set.
        let mut context_ref_tables: Vec<String> = Vec::new();
        for cc in &context_columns_on_axis {
            // Inline references to other context columns on the host so the
            // TRANSITIVE scalar measures and cross-table references are fetched
            // (a column may depend on another's scalar). This also detects a
            // dependency cycle at plan time and fails closed.
            let inlined = model
                .inline_context_column_refs(
                    cc.table(),
                    cc.expression(),
                    &mut vec![cc.name().to_lowercase()],
                )
                .map_err(QueryError::Engine)?;
            for m_name in inlined.measure_references() {
                let measure = model.measure(m_name).map_err(QueryError::Engine)?;
                let source_table = if measure.table().is_empty() {
                    let expanded =
                        expand_measure_refs(measure.expression(), model).map_err(QueryError::Engine)?;
                    infer_fact_table(&expanded)
                } else {
                    Some(measure.table().to_string())
                };
                if let Some(t) = source_table {
                    if !context_scalar_tables.iter().any(|x| x.eq_ignore_ascii_case(&t)) {
                        context_scalar_tables.push(t);
                    }
                }
                if !context_scalar_measures
                    .iter()
                    .any(|m| m.name().eq_ignore_ascii_case(measure.name()))
                {
                    context_scalar_measures.push(measure.clone());
                }
            }
            for (ref_table, _) in inlined.qualified_column_references() {
                if !ref_table.eq_ignore_ascii_case(cc.table())
                    && !context_ref_tables
                        .iter()
                        .any(|x| x.eq_ignore_ascii_case(ref_table))
                {
                    context_ref_tables.push(ref_table.to_string());
                }
            }
        }

        // Validate ORDER BY targets against group_by and measures.
        validate_order_by(request)?;

        // Fail closed (both paths) when a measure's CLEAR/RESET/CLEAR_OUTER would
        // need to remove a report slicer — slicer removal is not yet wired, so
        // returning an axis-only number would be silently wrong under the chosen
        // REMOVEFILTERS semantics. Axis-only clearing (CLEAR_INNER) is unaffected.
        validate_no_slicer_clear(request, model)?;

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

        // Filter-context time intelligence: when a measure is a top-level
        // ToDate/PeriodShift AND no group_by column is on the marked date
        // table, the executor evaluates it from the date filter context. That
        // path probes the date table and joins it for the date-range filter, so
        // the date table must be fetched and registered even though it appears
        // in neither group_by nor an explicit filter.
        //
        // FAIL CLOSED (Fix C): the filter-context path needs the WHOLE calendar
        // in memory — it imposes its own DateKey range (for PRIORYEAR/
        // SAMEPERIODLASTYEAR, a shifted range that reaches dates OUTSIDE the
        // request's date filter). A connector-fetched (DirectQuery, not cached)
        // date table is fetched WITH the request's date filter applied at the
        // source, so the shifted range would find no rows and silently return a
        // blank/too-low value. Require the date table to be in-memory (or
        // cached); otherwise refuse with an actionable error rather than mislead.
        let time_intelligence_tables: Vec<String> = {
            let date_on_axis = model
                .date_table()
                .is_some_and(|dt| group_by_tables.iter().any(|t| t.eq_ignore_ascii_case(dt)));
            // Detect a filter-context time-intelligence node at the top level OR
            // inside a compound combinator (YoY = YTD − PRIORYEAR, DIVIDE, IF,
            // COALESCE, IFERROR), so a compound TI measure also pulls in the
            // off-axis date table.
            let has_filter_context_ti = measures
                .iter()
                .any(|m| m.expression().contains_time_intelligence());
            match model.date_table() {
                Some(dt) if has_filter_context_ti && !date_on_axis => {
                    let in_memory = model.table(dt).is_ok_and(|t| t.is_in_memory())
                        || cached_tables.contains(dt);
                    if !in_memory {
                        return Err(QueryError::Engine(
                            engine_core::error::EngineError::TimeIntelligence {
                                function: "time intelligence".to_string(),
                                reason: format!(
                                    "filter-context time intelligence requires the date table \
                                     '{dt}' to be in-memory; mark it with StorageMode::InMemory \
                                     (or put a date column on the group-by axis)"
                                ),
                            },
                        ));
                    }
                    vec![dt.to_string()]
                }
                _ => Vec::new(),
            }
        };

        // Tables referenced only by an IN-list slicer (e.g. slice by a
        // dimension that is not on the group-by axis) must still be fetched so
        // the slicer can restrict the related fact. Add every model table that
        // owns an IN-filter column.
        let in_filter_tables: Vec<&str> = request
            .in_filters
            .iter()
            .flat_map(|f| {
                model
                    .tables()
                    .iter()
                    .filter(move |t| t.column(&f.column).is_ok())
                    .map(|t| t.name())
            })
            .collect();

        // A cross-column OR slicer must reference columns of a SINGLE table (the
        // fetch is per-table; a cross-table OR cannot be pushed to one fetch).
        // Resolve that table now and fail closed if no single table owns every
        // OR-condition column. That table is fetched and the OR restricts it.
        let or_filter_table: Option<&str> = if request.or_filters.is_empty() {
            None
        } else {
            let cols: Vec<&str> = request.or_filters.iter().map(|f| f.column.as_str()).collect();
            match model
                .tables()
                .iter()
                .find(|t| cols.iter().all(|c| t.column(c).is_ok()))
                .map(|t| t.name())
            {
                Some(t) => Some(t),
                None => {
                    return Err(QueryError::InvalidQuery(
                        "an OR slicer (`or_filters`) must reference columns of a single table; \
                         conditions spanning different tables are not yet supported — use \
                         separate IN-list slicers, or model the columns on one table"
                            .into(),
                    ))
                }
            }
        };

        // Collect all referenced tables (deduplication happens below).
        let all_tables: Vec<&str> = measure_tables
            .iter()
            .chain(group_by_tables.iter())
            .chain(context_tables.iter())
            .copied()
            .chain(variable_tables.iter().map(|s| s.as_str()))
            .chain(named_context_tables.iter().map(|s| s.as_str()))
            .chain(userelationship_tables.iter().map(|s| s.as_str()))
            .chain(time_intelligence_tables.iter().map(|s| s.as_str()))
            .chain(context_scalar_tables.iter().map(|s| s.as_str()))
            .chain(context_ref_tables.iter().map(|s| s.as_str()))
            .chain(in_filter_tables.iter().copied())
            .chain(or_filter_table.iter().copied())
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

        // --- Row-level security relevance ---
        //
        // Determine whether the active role's predicates touch this query and,
        // if so, which role-filtered dimension tables must be pulled into the
        // fetch set so their restriction propagates to the fact (see the
        // `security` module). An RLS-active query that touches a role-filtered
        // table is routed through LocalAggregation: the single-table and
        // pushed-join fast paths cannot guarantee the dimension→fact
        // restriction when the dimension is not otherwise in the query, so we
        // forgo them (documented performance trade-off — one extra fetch buys
        // a correct, un-bypassable restriction).
        let mut query_table_set: std::collections::HashSet<String> =
            unique_tables.iter().map(|t| t.to_string()).collect();
        // A table pulled in ONLY to probe a context-column scalar is NOT joined
        // into the main aggregation statement, so its role predicate cannot
        // restrict a fact via an in-statement join. Remove such tables from the
        // RLS query-table set: `rls_relevance` treats a role-filtered table that
        // is "in the query" as already enforceable (the join restricts the
        // fact). For a scalar-only table that join does not exist, so a role on
        // it must instead be routed through the enforceable two-phase
        // propagation path (`rls_extra_tables`) or fail closed — never silently
        // leave the fact unrestricted. A scalar table that is ALSO a measure or
        // group-by table is genuinely joined, so it stays.
        for st in &context_scalar_tables {
            let joined = measure_tables.iter().any(|m| m.eq_ignore_ascii_case(st))
                || group_by_tables.iter().any(|g| g.eq_ignore_ascii_case(st));
            if !joined {
                query_table_set.retain(|t| !t.eq_ignore_ascii_case(st));
            }
        }
        let (rls_relevant, rls_extra_tables) =
            rls_relevance(role_filters, &query_table_set, &measure_tables, model)?;

        // Force the relationship-aware LocalAggregation path when RLS must
        // pull a role-filtered dimension into the query that is not otherwise
        // present: only that path's two-phase IN-propagation restricts the
        // fact to rows joined to permitted dimension rows. When every
        // role-filtered table is already in the query, the pushed paths inject
        // the predicates into their own WHERE and remain correct (an INNER
        // JOIN / single-table WHERE restricts in-statement), so they stay
        // eligible.
        let rls_force_local = rls_relevant && !rls_extra_tables.is_empty();

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

        // User IN-list and cross-column OR slicers force LocalAggregation. Each
        // table is still fetched with its IN/OR filter pushed to the source (the
        // connector renders `in_filters` and `or_groups`), and a dimension-side
        // slicer restricts the fact through the existing two-phase propagation —
        // so this is the single, well-tested path for these filters rather than
        // threading them through the single-statement pushed-join builders too.
        let has_in_filters = !request.in_filters.is_empty() || !request.or_filters.is_empty();

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
            && !rls_force_local
            && !has_in_filters
            && !has_context_columns
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

                // Seal the active role's predicates into the pushed WHERE for
                // this (single) table. They go straight into the FetchRequest
                // filters — never through ContextResolver — so RESET/CLEAR
                // cannot remove them.
                let mut fetch_filters = request.filters.clone();
                fetch_filters.extend(role_conditions_for_table(role_filters, table_name));

                let fetch = FetchRequest {
                    schema: Some(binding.schema.clone()),
                    table: binding.table.clone(),
                    filters: fetch_filters,
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

        // Role predicates for the pushed-join paths. The role's conditions for
        // every table in the query are appended to the query filters; inside a
        // single JOIN statement they restrict the named table directly and the
        // fact transitively through the INNER JOIN. Only reached when
        // `rls_force_local` is false (every role-filtered table is already in
        // the query), so no dimension needs pulling in. Empty when no role is
        // active.
        let join_role_filters: Vec<FilterCondition> = unique_tables
            .iter()
            .flat_map(|t| role_conditions_for_table(role_filters, t))
            .collect();
        let build_join_filters = || {
            let mut f = request.filters.clone();
            f.extend(join_role_filters.iter().cloned());
            f
        };

        // Whether any measure contains operations that cannot be expressed
        // in source SQL: RESET/CLEAR_INNER/USERELATIONSHIP-style context
        // ops, two-stage constructs (QUERY, window functions), and
        // host-registered UDF calls (which exist only in the local
        // DataFusion session). Any of these force LocalAggregation.
        let has_unpushable_context = measures.iter().any(|m| has_unpushable_ops(m.expression()));

        // Whether every real source table involved can execute a pushed
        // join-aggregation (the connector renders Expression trees as SQL).
        // Only such connectors may receive a `PushedJoinAggregation`; for any
        // other source (e.g. SQL Server, which has no expression renderer) the
        // pushed-join branches below must fall through to `LocalAggregation`
        // rather than emit a plan the connector answers with
        // `UnsupportedOperation` (a hard error where local would succeed).
        // QUERY-in-VAR binding names are not source tables and are skipped.
        let all_push_capable = all_tables
            .iter()
            .filter(|t| !query_binding_names.contains(&t.to_lowercase()))
            .all(|t| {
                registry
                    .connector_for(t)
                    .map(|c| c.supports_expression_pushdown())
                    .unwrap_or(false)
            });

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
            && !rls_force_local
            && !has_in_filters
            && !has_context_columns
            && all_push_capable
        {
            let table_name = all_tables[0];
            if let Ok(req) = build_join_aggregation_request(
                &measures,
                &request.group_by,
                &build_join_filters(),
                &all_tables,
                model,
                registry,
                &[],
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
            && !rls_force_local
            && !has_in_filters
            && !has_context_columns
            && all_push_capable
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
                        &build_join_filters(),
                        &all_tables,
                        model,
                        registry,
                        &[],
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

        // Context-driven calculated column pushdown. When a host-only context
        // column is on the group-by axis and the facade has resolved its scalar
        // to a literal (`context_column_cases`), push the resolved CASE into the
        // source GROUP BY instead of aggregating locally — provided this is a
        // single-fact query, every group-by column is on the fact (no dimension
        // joins), the measures are simple pushable aggregates, there is no other
        // force-local reason, and the fact's connector supports expression
        // pushdown (PostgreSQL today). Otherwise fall through to local. The
        // scalar source table is NOT included (its value is already a literal),
        // so only the fact is queried.
        // Filters safe to push onto the fact-only query: fact-owned filters are
        // pushed; disconnected scalar-shaping filters are dropped (baked into the
        // resolved literal). `None` means a filter requires local propagation.
        let context_push_fact_filters = if has_context_columns
            && !context_column_cases.is_empty()
            && measure_tables.len() == 1
        {
            context_pushdown_fact_filters(model, measure_tables[0], &request.filters)
        } else {
            None
        };
        // Only the FACT is queried here, so only the fact must be a live source —
        // an in-memory/cached as-of *reference* table (a common slicer) is fine,
        // since its scalar is already resolved to a literal. (`any_in_memory`
        // would over-block by counting that reference table.)
        let fact_is_live_source = measure_tables.len() == 1 && {
            let f = measure_tables[0];
            !(model.table(f).is_ok_and(|t| t.is_in_memory()) || cached_tables.contains(f))
        };
        if has_context_columns
            && !context_column_cases.is_empty()
            && context_ref_tables.is_empty()
            && measure_tables.len() == 1
            && context_push_fact_filters.is_some()
            && fact_is_live_source
            && request
                .group_by
                .iter()
                .all(|c| c.table.eq_ignore_ascii_case(measure_tables[0]))
            && all_simple
            && all_pushable
            && !any_context_ops
            && !any_table_var_refs
            && lookup_specs.is_empty()
            && !needs_sort_substitution
            && request.totals == TotalsMode::None
            && !hierarchy_needs_local
            && !rls_force_local
            && !has_in_filters
            && registry
                .connector_for(measure_tables[0])
                .map(|c| c.supports_expression_pushdown())
                .unwrap_or(false)
        {
            let fact = measure_tables[0];
            // Fact-owned request filters + the fact's active-role conditions.
            let mut pushed_filters = context_push_fact_filters.unwrap_or_default();
            pushed_filters.extend(role_conditions_for_table(role_filters, fact));
            // Physical fact group-by columns (the context columns become
            // computed_group_by below).
            let physical_group_by: Vec<ColumnRef> = request
                .group_by
                .iter()
                .filter(|c| {
                    model
                        .context_column(&c.column)
                        .filter(|cc| cc.table().eq_ignore_ascii_case(&c.table))
                        .is_none()
                })
                .cloned()
                .collect();
            // The resolved CASE for each context column actually on this axis.
            let computed: Vec<(ColumnRef, engine_core::compute::expression::Expression)> =
                context_column_cases
                    .iter()
                    .filter(|(cr, _)| {
                        request.group_by.iter().any(|g| {
                            g.table.eq_ignore_ascii_case(&cr.table)
                                && g.column.eq_ignore_ascii_case(&cr.column)
                        })
                    })
                    .cloned()
                    .collect();
            if !computed.is_empty() {
                if let Ok(req) = build_join_aggregation_request(
                    &measures,
                    &physical_group_by,
                    &pushed_filters,
                    &[fact],
                    model,
                    registry,
                    &computed,
                ) {
                    return Ok((
                        QueryPlan::PushedJoinAggregation {
                            source_table: fact.to_string(),
                            request: req,
                            order_by: effective_order.clone(),
                            limit: request.limit,
                        },
                        ProjectionDiagnostics::default(),
                    ));
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
        // fetch (empty column list = SELECT *). The context-column scalar
        // measures are walked alongside the request measures so their source
        // columns (e.g. the date column behind an as-of scalar) are fetched.
        let projection_measures: Vec<Measure> = measures
            .iter()
            .cloned()
            .chain(context_scalar_measures.iter().cloned())
            .collect();
        let projections = compute_table_projections(
            request,
            model,
            &projection_measures,
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

                // Seal the active role's predicates for this table into its
                // fetch filters. For a role-filtered dimension this is what
                // makes the existing two-phase IN-propagation restrict the
                // related fact: the dimension is fetched with the role filter,
                // and only its surviving join keys reach the fact. These never
                // pass through ContextResolver.
                table_filters.extend(role_conditions_for_table(role_filters, table_name));

                // User IN-list slicers whose column lives on this table, as
                // pushed `column IN (...)` conditions. Integer columns render
                // bare (sargable); other types render escaped/quoted text.
                let table_in_filters: Vec<engine_connectors::InFilterCondition> = request
                    .in_filters
                    .iter()
                    .filter(|f| {
                        model
                            .table(table_name)
                            .ok()
                            .and_then(|t| t.column(&f.column).ok())
                            .is_some()
                    })
                    .map(|f| in_filter_condition(model, table_name, f))
                    .collect();

                // A cross-column OR slicer (DNF: each condition its own group →
                // OR-combined) goes on the single table that owns its columns.
                let table_or_groups: Vec<Vec<FilterCondition>> =
                    if or_filter_table == Some(*table_name) {
                        request.or_filters.iter().map(|c| vec![c.clone()]).collect()
                    } else {
                        Vec::new()
                    };

                let fetch = FetchRequest {
                    schema: Some(binding.schema.clone()),
                    table: binding.table.clone(),
                    columns: projections.columns_for(table_name),
                    filters: table_filters,
                    in_filters: table_in_filters,
                    or_groups: table_or_groups,
                    ..Default::default()
                };

                fetches.push((table_name.to_string(), fetch));
            }
        }

        // Pull in role-filtered dimension tables that are NOT otherwise in the
        // query. Each is fetched (full projection — we cannot statically know
        // which of its columns a later phase needs beyond the join key, and a
        // dimension is small) with the role's predicates as filters, so the
        // LocalAggregation two-phase IN-propagation restricts the related fact
        // to rows joined to permitted dimension rows — even though the
        // dimension appears in neither group_by nor query filters.
        for extra_table in &rls_extra_tables {
            if seen_tables.insert(extra_table.as_str()) {
                let binding = registry.binding_for(extra_table)?;
                let fetch = FetchRequest {
                    schema: Some(binding.schema.clone()),
                    table: binding.table.clone(),
                    filters: role_conditions_for_table(role_filters, extra_table),
                    ..Default::default()
                };
                fetches.push((extra_table.clone(), fetch));
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

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();

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
    fn integer_filter_is_stamped_sargable_but_text_filter_is_not() {
        use engine_connectors::traits::InValueKind;
        use engine_connectors::{FilterCondition, FilterOperator};

        let model = test_model_single_table();
        let registry = mock_registry_single(0);

        // One filter on an integer column (`id`), one on a text column
        // (`region`). The post-pass upgrades only the integer one to a
        // sargable rendering; the text one stays the safe text-cast default.
        let request = QueryRequest {
            measures: vec!["TotalAmount".into()],
            filters: vec![
                FilterCondition::new("id", FilterOperator::Equal, "42"),
                FilterCondition::new("region", FilterOperator::Equal, "West"),
            ],
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();
        match plan {
            QueryPlan::PushedAggregation { request, .. } => {
                let id = request.filters.iter().find(|f| f.column == "id").unwrap();
                let region = request
                    .filters
                    .iter()
                    .find(|f| f.column == "region")
                    .unwrap();
                assert_eq!(id.kind, InValueKind::Integer, "integer column → sargable");
                assert_eq!(region.kind, InValueKind::Text, "text column → text-cast");
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

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();

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

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();

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
    fn star_schema_on_non_pushdown_source_falls_back_to_local() {
        // A same-source star schema whose connector cannot render expression
        // GROUP BY/JOIN aggregation (e.g. SQL Server, or here the in-memory
        // connector) must NOT be planned as a PushedJoinAggregation — the
        // connector would answer with UnsupportedOperation, a hard error where
        // local aggregation succeeds. The capability gate falls it back.
        use crate::in_memory_connector::InMemoryConnector;
        use crate::registry::{AnyConnector, SourceBinding};

        let model = test_model_star_schema();
        let mut registry = SourceRegistry::new();
        let idx = registry.add_connector(AnyConnector::InMemory(InMemoryConnector::new()));
        registry.bind("Sales", idx, SourceBinding::new("sales", "salesorderheader"));
        registry.bind("Products", idx, SourceBinding::new("production", "product"));

        let request = QueryRequest {
            measures: vec!["TotalAmount".into()],
            group_by: vec![ColumnRef::new("Products", "category")],
            ..Default::default()
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();
        assert!(
            matches!(plan, QueryPlan::LocalAggregation { .. }),
            "a non-pushdown source must aggregate locally, got {plan:?}"
        );
    }

    #[test]
    fn non_pushdown_fallback_still_seals_role_conditions() {
        // The fail-soft is done at the PLANNER, so a compound-measure query on a
        // non-pushdown source falls back to LocalAggregation with the active
        // role's predicate STILL sealed into the fact fetch — no RLS leak. (A
        // naive executor-side catch that re-fetched without the role would leak.)
        use crate::in_memory_connector::InMemoryConnector;
        use crate::registry::{AnyConnector, SourceBinding};

        let model = test_model_single_compound();
        let mut registry = SourceRegistry::new();
        let idx = registry.add_connector(AnyConnector::InMemory(InMemoryConnector::new()));
        registry.bind("Sales", idx, SourceBinding::new("dbo", "sales"));

        let request = QueryRequest {
            measures: vec!["Doubled".into()],
            ..Default::default()
        };
        let plan = PushdownPlanner::plan(&request, &model, &registry, &west_role()).unwrap();
        match plan {
            QueryPlan::LocalAggregation { fetches, .. } => {
                let sales = &fetches.iter().find(|(n, _)| n == "Sales").unwrap().1;
                assert!(
                    sales
                        .filters
                        .iter()
                        .any(|f| f.column == "region" && f.value == "West"),
                    "active-role predicate must survive the fallback into the fetch: {sales:?}"
                );
            }
            other => panic!("expected LocalAggregation, got {other:?}"),
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

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();

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

        let result = PushdownPlanner::plan(&request, &model, &registry, &[]);
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

        let result = PushdownPlanner::plan(&request, &model, &registry, &[]);
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

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();

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

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();

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

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();

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

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();

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

        let plan = PushdownPlanner::plan(&request, &model, &registry, &[]).unwrap();
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

        let result = PushdownPlanner::plan(&request, &model, &registry, &[]);
        assert!(result.is_err());
    }
}
