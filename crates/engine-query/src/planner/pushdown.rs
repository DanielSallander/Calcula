//! Pushdown planner: decides what to push to data sources vs. compute locally.

use engine_connectors::{
    AggregateExpr, AggregateFunction, FetchRequest, FilterCondition, FilterOperator,
};
use engine_core::compute::expression::{ComparisonOp, Expression, FilterPredicate};
use engine_core::compute::measure::Measure;
use engine_core::compute::parser::parse_measure_expression;
use engine_core::compute::sql_util::{quote_ident_double, sql_quote_literal};
use engine_core::model::schema::apply_lookup_placeholder;
use engine_core::model::DataModel;
use engine_core::types::DataType;

use crate::error::{QueryError, QueryResult};
use crate::registry::SourceRegistry;
use crate::request::{ColumnRef, QueryRequest};

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
    PushedJoinAggregation {
        /// Any model table name (to look up the connector).
        source_table: String,
        /// Structured join aggregation request (dialect-neutral).
        request: engine_connectors::JoinAggregationRequest,
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

    /// Analyze a query request and produce a plan, treating tables in
    /// `cached_tables` as locally cached (same as in-memory tables for
    /// pushdown decisions).
    pub fn plan_with_cached(
        request: &QueryRequest,
        model: &DataModel,
        registry: &SourceRegistry,
        cached_tables: &std::collections::HashSet<String>,
    ) -> QueryResult<QueryPlan> {
        if request.measures.is_empty() {
            return Err(QueryError::InvalidQuery(
                "at least one measure is required".into(),
            ));
        }

        // Resolve all measures.
        let measures: Vec<Measure> = request
            .measures
            .iter()
            .map(|name| model.measure(name).cloned())
            .collect::<Result<Vec<_>, _>>()?;

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
        {
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

            let group_by: Vec<String> = request.group_by.iter().map(|c| c.column.clone()).collect();

            let fetch = FetchRequest {
                schema: Some(binding.schema.clone()),
                table: binding.table.clone(),
                filters: request.filters.clone(),
                group_by,
                aggregates,
                ..Default::default()
            };

            return Ok(QueryPlan::PushedAggregation {
                source_table: table_name.to_string(),
                request: fetch,
            });
        }

        // Single-table with compound expressions (not simple aggregates):
        // use PushedJoinAggregation (no JOINs needed, just compound SQL).
        if unique_tables.len() == 1
            && !any_context_ops
            && !any_table_var_refs
            && lookup_specs.is_empty()
            && !any_in_memory
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
                return Ok(QueryPlan::PushedJoinAggregation {
                    source_table: table_name.to_string(),
                    request: req,
                });
            }
        }

        // Multi-table same-source case: if all tables share the same connector
        // and measures have no unpushable context ops or table variable refs,
        // push a JOIN query with compound SQL expressions directly to the source.
        // KEEP is pushable (translates to CASE WHEN), but CLEAR/RESET/UseRelationship are not.
        let has_unpushable_context = measures.iter().any(|m| has_unpushable_ops(m.expression()));

        if !has_unpushable_context
            && !any_table_var_refs
            && lookup_specs.is_empty()
            && !any_in_memory
            && unique_tables.len() > 1
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
                        return Ok(QueryPlan::PushedJoinAggregation {
                            source_table: first_table.to_string(),
                            request: req,
                        });
                    }
                }
            }
        }

        // Multi-table (star-schema) case: fetch raw data, aggregate locally.
        //
        // Even though the aggregation is local, we can still push KEEP filter
        // predicates to source fetches for dimension tables that are referenced
        // only through context operations. This reduces data volume at the source.
        let pushable_context_filters =
            compute_pushable_context_filters(&measures, &measure_tables, &group_by_tables);

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
                    ..Default::default()
                };
                fetches.push((spec.table.clone(), fetch));
            }
        }

        Ok(QueryPlan::LocalAggregation {
            fetches,
            measures,
            group_by: request.group_by.clone(),
            lookup_specs,
        })
    }
}

/// Check if an expression contains any `QualifiedColumnRef` that references
/// a table variable (rather than a real table). Such references require
/// context resolution and cannot be pushed down as simple aggregates.
fn has_table_variable_refs(expr: &Expression, model: &DataModel) -> bool {
    match expr {
        Expression::QualifiedColumnRef { table_or_var, .. } => {
            model.table_variable(table_or_var).is_ok()
        }
        Expression::Aggregate { operand, .. } => has_table_variable_refs(operand, model),
        Expression::BinaryOp { left, right, .. }
        | Expression::Comparison { left, right, .. }
        | Expression::And(left, right)
        | Expression::Or(left, right)
        | Expression::Xor(left, right) => {
            has_table_variable_refs(left, model) || has_table_variable_refs(right, model)
        }
        Expression::Not(inner) | Expression::IsBlank(inner) => {
            has_table_variable_refs(inner, model)
        }
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => {
            has_table_variable_refs(condition, model)
                || has_table_variable_refs(then_expr, model)
                || has_table_variable_refs(else_expr, model)
        }
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => {
            has_table_variable_refs(numerator, model)
                || has_table_variable_refs(denominator, model)
                || alternate
                    .as_ref()
                    .is_some_and(|a| has_table_variable_refs(a, model))
        }
        Expression::Coalesce(exprs) => exprs.iter().any(|e| has_table_variable_refs(e, model)),
        Expression::ScalarFunc { args, .. } | Expression::TextFunc { args, .. } => {
            args.iter().any(|a| has_table_variable_refs(a, model))
        }
        _ => false,
    }
}

/// Collect all base tables referenced by table variables in an expression.
///
/// This walks the expression to find:
/// - `Keep { variables: [name, ...] }` — bare variable references
/// - `QualifiedColumnRef { table_or_var }` — variable-qualified column refs
/// - `Keep { expr: TableRef(name) }` — older-style variable refs
///
/// For each variable, follows the source chain to the base table and collects
/// all filter tables along the way. These tables must be fetched and registered
/// in DataFusion for the query to succeed.
fn collect_variable_tables(expr: &Expression, model: &DataModel) -> Vec<String> {
    let mut var_names = Vec::new();
    collect_variable_names(expr, model, &mut var_names);

    let mut tables = Vec::new();
    for var_name in &var_names {
        resolve_variable_tables(var_name, model, &mut tables);
    }
    tables.sort();
    tables.dedup();
    tables
}

/// Recursively collect all variable names referenced in an expression.
fn collect_variable_names(expr: &Expression, model: &DataModel, names: &mut Vec<String>) {
    match expr {
        Expression::QualifiedColumnRef { table_or_var, .. } => {
            if model.table_variable(table_or_var).is_ok() {
                names.push(table_or_var.clone());
            }
        }
        Expression::Keep {
            expr: inner,
            variables,
            ..
        } => {
            for v in variables {
                // Only collect table variable names, not named context names.
                // Named contexts are resolved at context-resolution time and
                // don't reference additional tables directly.
                if model.table_variable(v).is_ok() {
                    names.push(v.clone());
                }
            }
            // Check for TableRef inside Keep (older pattern).
            if let Expression::TableRef(ref name) = **inner {
                if model.table_variable(name).is_ok() {
                    names.push(name.clone());
                }
            }
            collect_variable_names(inner, model, names);
        }
        Expression::Aggregate { operand, .. } => collect_variable_names(operand, model, names),
        Expression::BinaryOp { left, right, .. }
        | Expression::Comparison { left, right, .. }
        | Expression::And(left, right)
        | Expression::Or(left, right)
        | Expression::Xor(left, right) => {
            collect_variable_names(left, model, names);
            collect_variable_names(right, model, names);
        }
        Expression::Not(inner) | Expression::IsBlank(inner) => {
            collect_variable_names(inner, model, names);
        }
        Expression::Clear { expr: inner, .. }
        | Expression::Reset { expr: inner }
        | Expression::ClearInner { expr: inner, .. }
        | Expression::ClearOuter { expr: inner, .. }
        | Expression::ResetInner { expr: inner }
        | Expression::ResetOuter { expr: inner }
        | Expression::Traverse { expr: inner, .. }
        | Expression::Using { expr: inner, .. }
        | Expression::KeepIn { expr: inner, .. } => {
            collect_variable_names(inner, model, names);
        }
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => {
            collect_variable_names(condition, model, names);
            collect_variable_names(then_expr, model, names);
            collect_variable_names(else_expr, model, names);
        }
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => {
            collect_variable_names(numerator, model, names);
            collect_variable_names(denominator, model, names);
            if let Some(a) = alternate {
                collect_variable_names(a, model, names);
            }
        }
        Expression::Coalesce(exprs) => {
            for e in exprs {
                collect_variable_names(e, model, names);
            }
        }
        Expression::ScalarFunc { args, .. } | Expression::TextFunc { args, .. } => {
            for a in args {
                collect_variable_names(a, model, names);
            }
        }
        Expression::Block { bindings, result } => {
            for (_, e) in bindings {
                collect_variable_names(e, model, names);
            }
            collect_variable_names(result, model, names);
        }
        Expression::Query { aggregates, .. } => {
            for (agg_expr, _) in aggregates {
                collect_variable_names(agg_expr, model, names);
            }
        }
        Expression::Switch {
            expr: inner,
            cases,
            default,
        } => {
            collect_variable_names(inner, model, names);
            for (v, r) in cases {
                collect_variable_names(v, model, names);
                collect_variable_names(r, model, names);
            }
            if let Some(d) = default {
                collect_variable_names(d, model, names);
            }
        }
        _ => {}
    }
}

/// Follow a variable's source chain and collect all referenced tables
/// (the base table + all filter tables along the chain).
fn resolve_variable_tables(var_name: &str, model: &DataModel, tables: &mut Vec<String>) {
    let mut current = var_name.to_string();
    loop {
        if let Ok(var) = model.table_variable(&current) {
            // Collect tables from the variable's filters.
            for f in var.filters() {
                tables.push(f.table.clone());
            }
            current = var.source().to_string();
        } else {
            // Reached a real table — add it.
            tables.push(current);
            break;
        }
    }
}

/// Collect all tables referenced by named context definitions in an expression.
///
/// When a measure uses a bare context name (e.g., `ctx_bikes`) in its Keep.variables,
/// the context definition's KEEP filters reference tables that need to be fetched.
/// This function walks the expression, finds named context references, and collects
/// all tables from their KEEP filter predicates (recursively following Inherit ops).
fn collect_named_context_tables(expr: &Expression, model: &DataModel) -> Vec<String> {
    let mut context_names = Vec::new();
    collect_context_names_from_expr(expr, model, &mut context_names);

    let mut tables = Vec::new();
    for ctx_name in &context_names {
        collect_tables_from_context(ctx_name, model, &mut tables);
    }
    tables.sort();
    tables.dedup();
    tables
}

/// Recursively find bare names in Keep.variables that are named contexts (not table variables).
fn collect_context_names_from_expr(expr: &Expression, model: &DataModel, names: &mut Vec<String>) {
    match expr {
        Expression::Keep {
            expr: inner,
            variables,
            ..
        } => {
            for v in variables {
                if model.table_variable(v).is_err() && model.context(v).is_ok() {
                    names.push(v.clone());
                }
            }
            collect_context_names_from_expr(inner, model, names);
        }
        Expression::Aggregate { operand, .. } => {
            collect_context_names_from_expr(operand, model, names);
        }
        Expression::BinaryOp { left, right, .. }
        | Expression::Comparison { left, right, .. }
        | Expression::And(left, right)
        | Expression::Or(left, right)
        | Expression::Xor(left, right) => {
            collect_context_names_from_expr(left, model, names);
            collect_context_names_from_expr(right, model, names);
        }
        Expression::Not(inner) | Expression::IsBlank(inner) => {
            collect_context_names_from_expr(inner, model, names);
        }
        Expression::Clear { expr: inner, .. }
        | Expression::Reset { expr: inner }
        | Expression::ClearInner { expr: inner, .. }
        | Expression::ClearOuter { expr: inner, .. }
        | Expression::ResetInner { expr: inner }
        | Expression::ResetOuter { expr: inner }
        | Expression::Traverse { expr: inner, .. }
        | Expression::Using { expr: inner, .. }
        | Expression::KeepIn { expr: inner, .. } => {
            collect_context_names_from_expr(inner, model, names);
        }
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => {
            collect_context_names_from_expr(condition, model, names);
            collect_context_names_from_expr(then_expr, model, names);
            collect_context_names_from_expr(else_expr, model, names);
        }
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => {
            collect_context_names_from_expr(numerator, model, names);
            collect_context_names_from_expr(denominator, model, names);
            if let Some(a) = alternate {
                collect_context_names_from_expr(a, model, names);
            }
        }
        Expression::Coalesce(exprs) => {
            for e in exprs {
                collect_context_names_from_expr(e, model, names);
            }
        }
        Expression::ScalarFunc { args, .. } | Expression::TextFunc { args, .. } => {
            for a in args {
                collect_context_names_from_expr(a, model, names);
            }
        }
        Expression::Block { bindings, result } => {
            for (_, binding_expr) in bindings {
                collect_context_names_from_expr(binding_expr, model, names);
            }
            collect_context_names_from_expr(result, model, names);
        }
        Expression::Query { aggregates, .. } => {
            for (agg_expr, _) in aggregates {
                collect_context_names_from_expr(agg_expr, model, names);
            }
        }
        Expression::Switch {
            expr: inner,
            cases,
            default,
        } => {
            collect_context_names_from_expr(inner, model, names);
            for (v, r) in cases {
                collect_context_names_from_expr(v, model, names);
                collect_context_names_from_expr(r, model, names);
            }
            if let Some(d) = default {
                collect_context_names_from_expr(d, model, names);
            }
        }
        _ => {}
    }
}

/// Collect tables from a named context's operations, recursively following Inherit.
fn collect_tables_from_context(ctx_name: &str, model: &DataModel, tables: &mut Vec<String>) {
    if let Ok(ctx) = model.context(ctx_name) {
        for op in ctx.operations() {
            match op {
                engine_core::model::context::ContextOp::Keep(filters) => {
                    for f in filters {
                        tables.push(f.table.clone());
                    }
                }
                engine_core::model::context::ContextOp::KeepIn(predicates) => {
                    for p in predicates {
                        tables.push(p.table.clone());
                    }
                }
                engine_core::model::context::ContextOp::Inherit(parent) => {
                    collect_tables_from_context(parent, model, tables);
                }
                _ => {}
            }
        }
    }
}

/// Collect all tables referenced by USERELATIONSHIP expressions.
///
/// When a measure uses `USERELATIONSHIP("rel_name")`, the relationship's
/// from_table and to_table must be fetched and registered in DataFusion so
/// the aliased JOIN can reference them.
fn collect_userelationship_tables(expr: &Expression, model: &DataModel) -> Vec<String> {
    let mut rel_names = Vec::new();
    collect_userelationship_names(expr, &mut rel_names);

    let mut tables = Vec::new();
    for rel_name in &rel_names {
        if let Ok(rel) = model.relationship(rel_name) {
            tables.push(rel.from_table().to_string());
            tables.push(rel.to_table().to_string());
        }
    }
    tables.sort();
    tables.dedup();
    tables
}

/// Recursively collect all relationship names from UseRelationship expressions.
fn collect_userelationship_names(expr: &Expression, names: &mut Vec<String>) {
    match expr {
        Expression::UseRelationship {
            expr: inner,
            relationship_name,
        } => {
            names.push(relationship_name.clone());
            collect_userelationship_names(inner, names);
        }
        Expression::Aggregate { operand, .. } => {
            collect_userelationship_names(operand, names);
        }
        Expression::BinaryOp { left, right, .. }
        | Expression::Comparison { left, right, .. }
        | Expression::And(left, right)
        | Expression::Or(left, right)
        | Expression::Xor(left, right) => {
            collect_userelationship_names(left, names);
            collect_userelationship_names(right, names);
        }
        Expression::Not(inner) | Expression::IsBlank(inner) => {
            collect_userelationship_names(inner, names);
        }
        Expression::Keep { expr: inner, .. }
        | Expression::KeepIn { expr: inner, .. }
        | Expression::Clear { expr: inner, .. }
        | Expression::Reset { expr: inner }
        | Expression::ClearInner { expr: inner, .. }
        | Expression::ClearOuter { expr: inner, .. }
        | Expression::ResetInner { expr: inner }
        | Expression::ResetOuter { expr: inner }
        | Expression::Traverse { expr: inner, .. }
        | Expression::Using { expr: inner, .. } => {
            collect_userelationship_names(inner, names);
        }
        Expression::Block { bindings, result } => {
            for (_, binding_expr) in bindings {
                collect_userelationship_names(binding_expr, names);
            }
            collect_userelationship_names(result, names);
        }
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => {
            collect_userelationship_names(condition, names);
            collect_userelationship_names(then_expr, names);
            collect_userelationship_names(else_expr, names);
        }
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => {
            collect_userelationship_names(numerator, names);
            collect_userelationship_names(denominator, names);
            if let Some(a) = alternate {
                collect_userelationship_names(a, names);
            }
        }
        Expression::Coalesce(exprs) => {
            for e in exprs {
                collect_userelationship_names(e, names);
            }
        }
        Expression::ScalarFunc { args, .. } | Expression::TextFunc { args, .. } => {
            for a in args {
                collect_userelationship_names(a, names);
            }
        }
        Expression::Switch {
            expr: inner,
            cases,
            default,
        } => {
            collect_userelationship_names(inner, names);
            for (v, r) in cases {
                collect_userelationship_names(v, names);
                collect_userelationship_names(r, names);
            }
            if let Some(d) = default {
                collect_userelationship_names(d, names);
            }
        }
        Expression::Query { aggregates, .. } => {
            for (agg_expr, _) in aggregates {
                collect_userelationship_names(agg_expr, names);
            }
        }
        Expression::HasOneValue { column } => collect_userelationship_names(column, names),
        Expression::SelectedValue { column, alternate } => {
            collect_userelationship_names(column, names);
            if let Some(a) = alternate {
                collect_userelationship_names(a, names);
            }
        }
        Expression::FirstValue { column, order_by } => {
            collect_userelationship_names(column, names);
            collect_userelationship_names(order_by, names);
        }
        _ => {}
    }
}

/// Collect QUERY binding names from Block expressions.
///
/// These are intermediate table names (e.g. "monthly", "by_year") that are
/// computed at runtime via `Expression::Query` bindings — they are NOT
/// registered data sources and must be excluded from source verification.
fn collect_query_binding_names(expr: &Expression) -> Vec<String> {
    let mut names = Vec::new();
    collect_query_names_recursive(expr, &mut names);
    names
}

fn collect_query_names_recursive(expr: &Expression, names: &mut Vec<String>) {
    match expr {
        Expression::Block { bindings, result } => {
            for (name, binding_expr) in bindings {
                if matches!(binding_expr, Expression::Query { .. }) {
                    names.push(name.to_lowercase());
                }
                collect_query_names_recursive(binding_expr, names);
            }
            collect_query_names_recursive(result, names);
        }
        Expression::Aggregate { operand, .. } => {
            collect_query_names_recursive(operand, names);
        }
        Expression::BinaryOp { left, right, .. }
        | Expression::Comparison { left, right, .. }
        | Expression::And(left, right)
        | Expression::Or(left, right)
        | Expression::Xor(left, right) => {
            collect_query_names_recursive(left, names);
            collect_query_names_recursive(right, names);
        }
        Expression::Not(inner) | Expression::IsBlank(inner) => {
            collect_query_names_recursive(inner, names);
        }
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => {
            collect_query_names_recursive(condition, names);
            collect_query_names_recursive(then_expr, names);
            collect_query_names_recursive(else_expr, names);
        }
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => {
            collect_query_names_recursive(numerator, names);
            collect_query_names_recursive(denominator, names);
            if let Some(a) = alternate {
                collect_query_names_recursive(a, names);
            }
        }
        Expression::ScalarFunc { args, .. } | Expression::TextFunc { args, .. } => {
            for a in args {
                collect_query_names_recursive(a, names);
            }
        }
        Expression::Coalesce(exprs) => {
            for e in exprs {
                collect_query_names_recursive(e, names);
            }
        }
        Expression::Keep { expr: inner, .. }
        | Expression::Clear { expr: inner, .. }
        | Expression::Reset { expr: inner }
        | Expression::ClearInner { expr: inner, .. }
        | Expression::ClearOuter { expr: inner, .. }
        | Expression::ResetInner { expr: inner }
        | Expression::ResetOuter { expr: inner }
        | Expression::Traverse { expr: inner, .. }
        | Expression::Using { expr: inner, .. }
        | Expression::KeepIn { expr: inner, .. } => {
            collect_query_names_recursive(inner, names);
        }
        _ => {}
    }
}

/// Convert a `ComparisonOp` to a connector `FilterOperator`.
fn comparison_to_filter_op(op: &ComparisonOp) -> FilterOperator {
    match op {
        ComparisonOp::Equal => FilterOperator::Equal,
        ComparisonOp::NotEqual => FilterOperator::NotEqual,
        ComparisonOp::GreaterThan => FilterOperator::GreaterThan,
        ComparisonOp::GreaterThanOrEqual => FilterOperator::GreaterThanOrEqual,
        ComparisonOp::LessThan => FilterOperator::LessThan,
        ComparisonOp::LessThanOrEqual => FilterOperator::LessThanOrEqual,
    }
}

/// Collect all KEEP filter predicates from an expression, grouped by table.
///
/// Walks the expression tree and extracts `FilterPredicate` values from `Keep`
/// nodes. Returns a map from table name to the set of predicates on that table.
fn collect_keep_predicates_by_table(
    expr: &Expression,
) -> std::collections::HashMap<String, Vec<FilterPredicate>> {
    let mut predicates = Vec::new();
    collect_keep_predicates_recursive(expr, &mut predicates);

    let mut by_table: std::collections::HashMap<String, Vec<FilterPredicate>> =
        std::collections::HashMap::new();
    for pred in predicates {
        by_table.entry(pred.table.clone()).or_default().push(pred);
    }
    // Deduplicate within each table.
    for preds in by_table.values_mut() {
        preds.sort_by(|a, b| (&a.column, &a.value).cmp(&(&b.column, &b.value)));
        preds.dedup_by(|a, b| {
            a.table == b.table
                && a.column == b.column
                && a.operator == b.operator
                && a.value == b.value
        });
    }
    by_table
}

/// Recursively collect all KEEP filter predicates from an expression.
fn collect_keep_predicates_recursive(expr: &Expression, out: &mut Vec<FilterPredicate>) {
    match expr {
        Expression::Keep {
            expr: inner,
            filters,
            ..
        } => {
            out.extend(filters.iter().cloned());
            collect_keep_predicates_recursive(inner, out);
        }
        Expression::Aggregate { operand, .. } => {
            collect_keep_predicates_recursive(operand, out);
        }
        Expression::BinaryOp { left, right, .. }
        | Expression::Comparison { left, right, .. }
        | Expression::And(left, right)
        | Expression::Or(left, right)
        | Expression::Xor(left, right) => {
            collect_keep_predicates_recursive(left, out);
            collect_keep_predicates_recursive(right, out);
        }
        Expression::Not(inner) | Expression::IsBlank(inner) => {
            collect_keep_predicates_recursive(inner, out);
        }
        Expression::Clear { expr: inner, .. }
        | Expression::Reset { expr: inner }
        | Expression::ClearInner { expr: inner, .. }
        | Expression::ClearOuter { expr: inner, .. }
        | Expression::ResetInner { expr: inner }
        | Expression::ResetOuter { expr: inner }
        | Expression::Traverse { expr: inner, .. }
        | Expression::Using { expr: inner, .. }
        | Expression::KeepIn { expr: inner, .. } => {
            collect_keep_predicates_recursive(inner, out);
        }
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => {
            collect_keep_predicates_recursive(condition, out);
            collect_keep_predicates_recursive(then_expr, out);
            collect_keep_predicates_recursive(else_expr, out);
        }
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => {
            collect_keep_predicates_recursive(numerator, out);
            collect_keep_predicates_recursive(denominator, out);
            if let Some(a) = alternate {
                collect_keep_predicates_recursive(a, out);
            }
        }
        Expression::Coalesce(exprs) => {
            for e in exprs {
                collect_keep_predicates_recursive(e, out);
            }
        }
        Expression::ScalarFunc { args, .. } | Expression::TextFunc { args, .. } => {
            for a in args {
                collect_keep_predicates_recursive(a, out);
            }
        }
        Expression::Block { bindings, result } => {
            for (_, binding_expr) in bindings {
                collect_keep_predicates_recursive(binding_expr, out);
            }
            collect_keep_predicates_recursive(result, out);
        }
        Expression::Query { aggregates, .. } => {
            for (agg_expr, _) in aggregates {
                collect_keep_predicates_recursive(agg_expr, out);
            }
        }
        Expression::Switch {
            expr: inner,
            cases,
            default,
        } => {
            collect_keep_predicates_recursive(inner, out);
            for (v, r) in cases {
                collect_keep_predicates_recursive(v, out);
                collect_keep_predicates_recursive(r, out);
            }
            if let Some(d) = default {
                collect_keep_predicates_recursive(d, out);
            }
        }
        Expression::HasOneValue { column } => {
            collect_keep_predicates_recursive(column, out);
        }
        Expression::SelectedValue { column, alternate } => {
            collect_keep_predicates_recursive(column, out);
            if let Some(a) = alternate {
                collect_keep_predicates_recursive(a, out);
            }
        }
        Expression::FirstValue { column, order_by } => {
            collect_keep_predicates_recursive(column, out);
            collect_keep_predicates_recursive(order_by, out);
        }
        _ => {}
    }
}

/// Compute pushable context filters for source fetches.
///
/// For each dimension table that is referenced ONLY through KEEP filters
/// (not as a measure fact table or group-by table), extract filter predicates
/// that can be pushed down as WHERE clauses on the source fetch.
///
/// When multiple measures have KEEP filters on the same table, only predicates
/// common to ALL measures (intersection) are pushed. If a measure has no KEEP
/// filter on a table, it doesn't constrain that table (it doesn't need data
/// from it), so it doesn't participate in the intersection.
fn compute_pushable_context_filters(
    measures: &[Measure],
    measure_tables: &[&str],
    group_by_tables: &[&str],
) -> std::collections::HashMap<String, Vec<FilterCondition>> {
    // Collect KEEP predicates per measure, grouped by table.
    let per_measure: Vec<std::collections::HashMap<String, Vec<FilterPredicate>>> = measures
        .iter()
        .map(|m| collect_keep_predicates_by_table(m.expression()))
        .collect();

    // Find all context-only tables (not fact tables, not group-by tables).
    let excluded: std::collections::HashSet<&str> = measure_tables
        .iter()
        .chain(group_by_tables.iter())
        .copied()
        .collect();

    // Collect all context tables across measures.
    let mut all_context_tables: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    for preds_by_table in &per_measure {
        for table in preds_by_table.keys() {
            if !excluded.iter().any(|e| e.eq_ignore_ascii_case(table)) {
                all_context_tables.insert(table.clone());
            }
        }
    }

    let mut result: std::collections::HashMap<String, Vec<FilterCondition>> =
        std::collections::HashMap::new();

    for table in &all_context_tables {
        // Collect predicate sets from measures that reference this table.
        let mut caring_sets: Vec<&Vec<FilterPredicate>> = Vec::new();
        for preds_by_table in &per_measure {
            if let Some(preds) = preds_by_table.get(table) {
                caring_sets.push(preds);
            }
        }

        if caring_sets.is_empty() {
            continue;
        }

        // Compute intersection: predicates present in ALL caring measures.
        let base = &caring_sets[0];
        let intersection: Vec<&FilterPredicate> = base
            .iter()
            .filter(|pred| {
                caring_sets[1..].iter().all(|set| {
                    set.iter().any(|p| {
                        p.column == pred.column
                            && p.operator == pred.operator
                            && p.value == pred.value
                    })
                })
            })
            .collect();

        if !intersection.is_empty() {
            let conditions: Vec<FilterCondition> = intersection
                .iter()
                .map(|pred| FilterCondition {
                    column: pred.column.clone(),
                    operator: comparison_to_filter_op(&pred.operator),
                    value: pred.value.clone(),
                })
                .collect();
            result.insert(table.clone(), conditions);
        }
    }

    result
}

/// Convert an engine-core `AggregateOp` to a connector `AggregateFunction`.
///
/// Returns `None` for statistical aggregates (Median, StdevSample, etc.)
/// that cannot be pushed to data sources and must be computed locally.
fn aggregate_op_to_function(
    op: engine_core::compute::aggregate::AggregateOp,
) -> Option<AggregateFunction> {
    match op {
        engine_core::compute::aggregate::AggregateOp::Sum => Some(AggregateFunction::Sum),
        engine_core::compute::aggregate::AggregateOp::Count => Some(AggregateFunction::Count),
        engine_core::compute::aggregate::AggregateOp::Average => Some(AggregateFunction::Avg),
        engine_core::compute::aggregate::AggregateOp::Min => Some(AggregateFunction::Min),
        engine_core::compute::aggregate::AggregateOp::Max => Some(AggregateFunction::Max),
        engine_core::compute::aggregate::AggregateOp::DistinctCount => {
            Some(AggregateFunction::CountDistinct)
        }
        engine_core::compute::aggregate::AggregateOp::CountRows => {
            Some(AggregateFunction::CountAll)
        }
        // Statistical aggregates are computed locally, not pushed to sources.
        engine_core::compute::aggregate::AggregateOp::Median
        | engine_core::compute::aggregate::AggregateOp::StdevSample
        | engine_core::compute::aggregate::AggregateOp::StdevPop
        | engine_core::compute::aggregate::AggregateOp::VarSample
        | engine_core::compute::aggregate::AggregateOp::VarPop => None,
        // AnyValue, Mode: computed locally.
        engine_core::compute::aggregate::AggregateOp::AnyValue
        | engine_core::compute::aggregate::AggregateOp::Mode => None,
    }
}

/// Check if an expression contains RESET, UseRelationship, or other context ops
/// that cannot be pushed to a source. KEEP and CLEAR are pushable.
fn has_unpushable_ops(expr: &Expression) -> bool {
    match expr {
        Expression::ClearInner { .. }
        | Expression::ClearOuter { .. }
        | Expression::Reset { .. }
        | Expression::ResetInner { .. }
        | Expression::ResetOuter { .. }
        | Expression::UseRelationship { .. }
        | Expression::Traverse { .. }
        | Expression::Using { .. }
        | Expression::KeepIn { .. } => true,
        Expression::Clear { expr, .. } | Expression::ClearExcept { expr, .. } => {
            has_unpushable_ops(expr)
        }
        Expression::Keep {
            expr,
            variables,
            conditions,
            in_predicates,
            ..
        } => {
            // KEEP with variables, expression conditions, or IN predicates
            // requires local context resolution — not pushable.
            !variables.is_empty()
                || !conditions.is_empty()
                || !in_predicates.is_empty()
                || has_unpushable_ops(expr)
        }
        Expression::Iterate { expression, .. } => has_unpushable_ops(expression),
        Expression::IfError { expr, alternate } => {
            has_unpushable_ops(expr) || has_unpushable_ops(alternate)
        }
        Expression::DateTimeFunc { args, .. } => args.iter().any(has_unpushable_ops),
        Expression::IsInScope { .. } => false,
        Expression::Percentile {
            operand,
            percentile,
        } => has_unpushable_ops(operand) || has_unpushable_ops(percentile),
        Expression::HasOneValue { column } | Expression::FirstValue { column, .. } => {
            has_unpushable_ops(column)
        }
        Expression::SelectedValue { column, alternate } => {
            has_unpushable_ops(column) || alternate.as_ref().is_some_and(|a| has_unpushable_ops(a))
        }
        Expression::BinaryOp { left, right, .. }
        | Expression::Comparison { left, right, .. }
        | Expression::And(left, right)
        | Expression::Or(left, right)
        | Expression::Xor(left, right) => has_unpushable_ops(left) || has_unpushable_ops(right),
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => {
            has_unpushable_ops(numerator)
                || has_unpushable_ops(denominator)
                || alternate.as_ref().is_some_and(|a| has_unpushable_ops(a))
        }
        Expression::Not(inner) | Expression::IsBlank(inner) => has_unpushable_ops(inner),
        Expression::Aggregate { operand, .. } => has_unpushable_ops(operand),
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => {
            has_unpushable_ops(condition)
                || has_unpushable_ops(then_expr)
                || has_unpushable_ops(else_expr)
        }
        Expression::Coalesce(exprs) => exprs.iter().any(has_unpushable_ops),
        Expression::ScalarFunc { args, .. } | Expression::TextFunc { args, .. } => {
            args.iter().any(has_unpushable_ops)
        }
        // Block with QUERY bindings requires two-stage evaluation — not pushable.
        Expression::Block { bindings, .. }
            if bindings
                .iter()
                .any(|(_, e)| matches!(e, Expression::Query { .. })) =>
        {
            true
        }
        Expression::Block { bindings, result } => {
            bindings.iter().any(|(_, e)| has_unpushable_ops(e)) || has_unpushable_ops(result)
        }
        Expression::Switch {
            expr,
            cases,
            default,
        } => {
            has_unpushable_ops(expr)
                || cases
                    .iter()
                    .any(|(v, r)| has_unpushable_ops(v) || has_unpushable_ops(r))
                || default.as_ref().is_some_and(|d| has_unpushable_ops(d))
        }
        // New pushable expression types.
        Expression::Greatest(args) | Expression::Least(args) => args.iter().any(has_unpushable_ops),
        Expression::NullIf { expr, value } => has_unpushable_ops(expr) || has_unpushable_ops(value),
        Expression::CountIf { condition } => has_unpushable_ops(condition),
        Expression::ListAgg { column, delimiter } => {
            has_unpushable_ops(column) || has_unpushable_ops(delimiter)
        }
        Expression::MaxBy { value, sort_by } | Expression::MinBy { value, sort_by } => {
            has_unpushable_ops(value) || has_unpushable_ops(sort_by)
        }
        // Window/rank functions and QUERY require two-stage evaluation — not pushable.
        Expression::Offset { .. }
        | Expression::Index { .. }
        | Expression::Window { .. }
        | Expression::RankWindow { .. }
        | Expression::Query { .. } => true,
        _ => false,
    }
}

/// Convert an expression to SQL with table-qualified column references for pushdown.
///
/// Uses source bindings to translate model column refs into `"source_table"."column"`.
#[allow(dead_code)]
fn expression_to_source_sql(
    expr: &Expression,
    model: &DataModel,
    registry: &SourceRegistry,
) -> QueryResult<String> {
    use engine_core::compute::aggregate::AggregateOp;

    match expr {
        Expression::QualifiedColumnRef {
            table_or_var,
            column,
        } => {
            let binding = registry.binding_for(table_or_var)?;
            Ok(format!(
                "{}.{}",
                quote_ident_double(&binding.table),
                quote_ident_double(column)
            ))
        }
        Expression::ColumnRef(name) => Ok(quote_ident_double(name)),
        Expression::LiteralFloat(v) => Ok(format!("{v}")),
        Expression::LiteralInt(v) => Ok(format!("{v}")),
        Expression::LiteralBool(b) => Ok(if *b { "TRUE" } else { "FALSE" }.to_string()),
        Expression::LiteralString(s) => Ok(sql_quote_literal(s)),
        Expression::Blank => Ok("NULL".to_string()),

        Expression::Aggregate { operation, operand } => {
            // Check if the operand is a Keep expression (KEEP inside aggregate).
            if let Expression::Keep {
                expr: inner,
                filters,
                variables,
                conditions,
                in_predicates,
            } = operand.as_ref()
            {
                if variables.is_empty() && conditions.is_empty() && in_predicates.is_empty() {
                    // Build CASE WHEN condition from filter predicates.
                    let condition_parts: Vec<String> = filters
                        .iter()
                        .map(|f| {
                            let binding = registry.binding_for(&f.table)?;
                            let qualified_col = format!(
                                "{}.{}",
                                quote_ident_double(&binding.table),
                                quote_ident_double(&f.column)
                            );
                            Ok(format!(
                                "{qualified_col} {} {}",
                                f.operator.as_sql(),
                                sql_quote_literal(&f.value)
                            ))
                        })
                        .collect::<QueryResult<Vec<_>>>()?;

                    let condition = condition_parts.join(" AND ");
                    let inner_sql = expression_to_source_sql(inner, model, registry)?;
                    let case_expr = format!("CASE WHEN {condition} THEN {inner_sql} END");
                    return Ok(match operation {
                        AggregateOp::Sum => format!("SUM({case_expr})"),
                        AggregateOp::Count => format!("COUNT({case_expr})"),
                        AggregateOp::Average => format!("AVG({case_expr})"),
                        AggregateOp::Min => format!("MIN({case_expr})"),
                        AggregateOp::Max => format!("MAX({case_expr})"),
                        AggregateOp::DistinctCount => format!("COUNT(DISTINCT {case_expr})"),
                        AggregateOp::CountRows => {
                            format!("SUM(CASE WHEN {condition} THEN 1 END)")
                        }
                        AggregateOp::Median => {
                            format!("PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY {case_expr})")
                        }
                        AggregateOp::StdevSample => format!("STDDEV_SAMP({case_expr})"),
                        AggregateOp::StdevPop => format!("STDDEV_POP({case_expr})"),
                        AggregateOp::VarSample => format!("VAR_SAMP({case_expr})"),
                        AggregateOp::VarPop => format!("VAR_POP({case_expr})"),
                        AggregateOp::AnyValue => format!("MIN({case_expr})"),
                        AggregateOp::Mode => format!("MODE() WITHIN GROUP (ORDER BY {case_expr})"),
                    });
                }
            }

            let operand_sql = expression_to_source_sql(operand, model, registry)?;
            Ok(match operation {
                AggregateOp::Sum => format!("SUM({operand_sql})"),
                AggregateOp::Count => format!("COUNT({operand_sql})"),
                AggregateOp::Average => format!("AVG({operand_sql})"),
                AggregateOp::Min => format!("MIN({operand_sql})"),
                AggregateOp::Max => format!("MAX({operand_sql})"),
                AggregateOp::DistinctCount => format!("COUNT(DISTINCT {operand_sql})"),
                AggregateOp::CountRows => "COUNT(*)".to_string(),
                // PostgreSQL statistical aggregates
                AggregateOp::Median => {
                    format!("PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY {operand_sql})")
                }
                AggregateOp::StdevSample => format!("STDDEV_SAMP({operand_sql})"),
                AggregateOp::StdevPop => format!("STDDEV_POP({operand_sql})"),
                AggregateOp::VarSample => format!("VAR_SAMP({operand_sql})"),
                AggregateOp::VarPop => format!("VAR_POP({operand_sql})"),
                AggregateOp::AnyValue => format!("MIN({operand_sql})"),
                AggregateOp::Mode => format!("MODE() WITHIN GROUP (ORDER BY {operand_sql})"),
            })
        }
        Expression::BinaryOp { left, op, right } => {
            let l = expression_to_source_sql(left, model, registry)?;
            let r = expression_to_source_sql(right, model, registry)?;
            Ok(format!("({l} {} {r})", op.as_sql()))
        }
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => {
            let n = expression_to_source_sql(numerator, model, registry)?;
            let d = expression_to_source_sql(denominator, model, registry)?;
            let alt = match alternate {
                Some(a) => expression_to_source_sql(a, model, registry)?,
                None => "NULL".to_string(),
            };
            Ok(format!(
                "CASE WHEN {d} = 0 THEN {alt} ELSE CAST({n} AS DOUBLE PRECISION) / {d} END"
            ))
        }
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => {
            let c = expression_to_source_sql(condition, model, registry)?;
            let t = expression_to_source_sql(then_expr, model, registry)?;
            let e = expression_to_source_sql(else_expr, model, registry)?;
            Ok(format!("CASE WHEN {c} THEN {t} ELSE {e} END"))
        }
        Expression::Comparison { left, op, right } => {
            let l = expression_to_source_sql(left, model, registry)?;
            let r = expression_to_source_sql(right, model, registry)?;
            Ok(format!("({l} {} {r})", op.as_sql()))
        }
        Expression::And(left, right) => {
            let l = expression_to_source_sql(left, model, registry)?;
            let r = expression_to_source_sql(right, model, registry)?;
            Ok(format!("({l} AND {r})"))
        }
        Expression::Or(left, right) => {
            let l = expression_to_source_sql(left, model, registry)?;
            let r = expression_to_source_sql(right, model, registry)?;
            Ok(format!("({l} OR {r})"))
        }
        Expression::Not(inner) => {
            let i = expression_to_source_sql(inner, model, registry)?;
            Ok(format!("(NOT {i})"))
        }
        Expression::IsBlank(inner) => {
            let i = expression_to_source_sql(inner, model, registry)?;
            Ok(format!("({i} IS NULL)"))
        }
        Expression::Coalesce(exprs) => {
            let parts: Vec<String> = exprs
                .iter()
                .map(|e| expression_to_source_sql(e, model, registry))
                .collect::<QueryResult<Vec<_>>>()?;
            Ok(format!("COALESCE({})", parts.join(", ")))
        }
        Expression::ScalarFunc { function, args } => {
            use engine_core::compute::expression::ScalarFunction;
            let mapped: Vec<String> = args
                .iter()
                .map(|a| expression_to_source_sql(a, model, registry))
                .collect::<QueryResult<Vec<_>>>()?;
            // PostgreSQL-specific: ROUND requires numeric, not double precision.
            match function {
                ScalarFunction::Round | ScalarFunction::RoundUp | ScalarFunction::RoundDown => {
                    let digits = mapped.get(1).map(|s| s.as_str()).unwrap_or("0");
                    let func = match function {
                        ScalarFunction::RoundDown => "TRUNC",
                        _ => "ROUND",
                    };
                    Ok(format!("{func}(({})::NUMERIC, {digits})", mapped[0]))
                }
                ScalarFunction::Sign => Ok(format!("SIGN({})", mapped[0])),
                ScalarFunction::Mod => Ok(format!("MOD({}, {})", mapped[0], mapped[1])),
                // TRUNC needs ::NUMERIC cast like ROUND
                ScalarFunction::Trunc => {
                    let digits = mapped.get(1).map(|s| s.as_str()).unwrap_or("0");
                    Ok(format!("TRUNC(({})::NUMERIC, {digits})", mapped[0]))
                }
                // PostgreSQL uses LOG(base, value) not LOG10(value)
                ScalarFunction::Log10 => Ok(format!("LOG(10, ({})::NUMERIC)", mapped[0])),
                _ => Ok(function.to_sql_strs(&mapped)),
            }
        }
        Expression::Keep {
            expr: inner,
            filters,
            variables,
            conditions,
            in_predicates,
        } => {
            // Only handle simple filter predicates for pushdown.
            // Bail if there are variables, expression conditions, or IN predicates.
            if !variables.is_empty() || !conditions.is_empty() || !in_predicates.is_empty() {
                return Err(QueryError::InvalidQuery(
                    "KEEP with variables/conditions/IN not supported for pushdown".into(),
                ));
            }

            // Build CASE WHEN condition from filter predicates.
            let condition_parts: Vec<String> = filters
                .iter()
                .map(|f| {
                    let binding = registry.binding_for(&f.table)?;
                    let qualified_col = format!(
                        "{}.{}",
                        quote_ident_double(&binding.table),
                        quote_ident_double(&f.column)
                    );
                    let op_sql = f.operator.as_sql();
                    Ok(format!(
                        "{qualified_col} {} {}",
                        op_sql,
                        sql_quote_literal(&f.value)
                    ))
                })
                .collect::<QueryResult<Vec<_>>>()?;

            let condition = condition_parts.join(" AND ");

            // Apply CASE WHEN to the inner expression's aggregates.
            expression_to_case_when_source_sql(inner, &condition, model, registry)
        }
        Expression::Block { .. } => {
            // Inline variables and then convert.
            let inlined = expr.inline_bindings();
            expression_to_source_sql(&inlined, model, registry)
        }
        Expression::TextFunc { function, args } => {
            let mapped: Vec<String> = args
                .iter()
                .map(|a| expression_to_source_sql(a, model, registry))
                .collect::<QueryResult<Vec<_>>>()?;
            Ok(function.to_sql_strs(&mapped))
        }
        // DateTime functions: YEAR, MONTH, DAY, DATEDIFF, TODAY, NOW, etc.
        Expression::DateTimeFunc { function, args } => {
            let mapped: Vec<String> = args
                .iter()
                .map(|a| expression_to_source_sql(a, model, registry))
                .collect::<QueryResult<Vec<_>>>()?;
            Ok(function.to_sql_strs(&mapped))
        }
        // IFERROR(expr, alternate) → COALESCE(expr, alternate)
        Expression::IfError {
            expr: inner,
            alternate,
        } => {
            let inner_sql = expression_to_source_sql(inner, model, registry)?;
            let alt_sql = expression_to_source_sql(alternate, model, registry)?;
            Ok(format!("COALESCE({inner_sql}, {alt_sql})"))
        }
        // ISINSCOPE(table[column]) — resolved at plan time to TRUE/FALSE.
        Expression::IsInScope { .. } => {
            // Default to TRUE — the planner resolves this before SQL generation.
            Ok("TRUE".to_string())
        }
        // ITERATE(table, expression) — transparent: just render the inner expression.
        Expression::Iterate { expression, .. } => {
            expression_to_source_sql(expression, model, registry)
        }
        // ClearExcept is handled at the measure level in expression_to_source_sql_with_clear.
        // If we reach it here, strip it and render the inner expression.
        Expression::ClearExcept { expr: inner, .. } => {
            expression_to_source_sql(inner, model, registry)
        }
        // Switch expression
        Expression::Switch {
            expr: switch_expr,
            cases,
            default,
        } => {
            let expr_sql = expression_to_source_sql(switch_expr, model, registry)?;
            let mut sql = format!("CASE {expr_sql}");
            for (val, result) in cases {
                let val_sql = expression_to_source_sql(val, model, registry)?;
                let result_sql = expression_to_source_sql(result, model, registry)?;
                sql.push_str(&format!(" WHEN {val_sql} THEN {result_sql}"));
            }
            if let Some(def) = default {
                let def_sql = expression_to_source_sql(def, model, registry)?;
                sql.push_str(&format!(" ELSE {def_sql}"));
            }
            sql.push_str(" END");
            Ok(sql)
        }
        // Xor
        Expression::Xor(left, right) => {
            let l = expression_to_source_sql(left, model, registry)?;
            let r = expression_to_source_sql(right, model, registry)?;
            Ok(format!("(({l} AND NOT {r}) OR (NOT {l} AND {r}))"))
        }
        // Percentile
        Expression::Percentile {
            operand,
            percentile,
        } => {
            let op_sql = expression_to_source_sql(operand, model, registry)?;
            let k_sql = expression_to_source_sql(percentile, model, registry)?;
            Ok(format!(
                "PERCENTILE_CONT({k_sql}) WITHIN GROUP (ORDER BY {op_sql})"
            ))
        }
        // HasOneValue: COUNT(DISTINCT col) = 1
        Expression::HasOneValue { column } => {
            let col_sql = expression_to_source_sql(column, model, registry)?;
            Ok(format!("(COUNT(DISTINCT {col_sql}) = 1)"))
        }
        // SelectedValue: CASE WHEN COUNT(DISTINCT col) = 1 THEN MIN(col) ELSE alt END
        Expression::SelectedValue { column, alternate } => {
            let col_sql = expression_to_source_sql(column, model, registry)?;
            let alt_sql = match alternate {
                Some(a) => expression_to_source_sql(a, model, registry)?,
                None => "NULL".to_string(),
            };
            Ok(format!(
                "CASE WHEN COUNT(DISTINCT {col_sql}) = 1 THEN MIN({col_sql}) ELSE {alt_sql} END"
            ))
        }
        // FirstValue: first value by sort order
        Expression::FirstValue {
            column,
            order_by: _,
        } => {
            let col_sql = expression_to_source_sql(column, model, registry)?;
            // Use subquery or MIN with ORDER BY — simplified as MIN for pushdown
            Ok(format!("MIN({col_sql})"))
        }
        // For any expression we can't translate, bail out so caller falls back to local.
        _ => Err(QueryError::InvalidQuery(format!(
            "Expression not supported for pushdown: {expr:?}"
        ))),
    }
}

/// Convert an expression to CASE WHEN SQL for KEEP context pushdown.
///
/// Wraps aggregates with `AGG(CASE WHEN condition THEN col END)` using
/// source-qualified column references.
#[allow(dead_code)]
fn expression_to_case_when_source_sql(
    expr: &Expression,
    condition: &str,
    model: &DataModel,
    registry: &SourceRegistry,
) -> QueryResult<String> {
    use engine_core::compute::aggregate::AggregateOp;

    match expr {
        Expression::Aggregate { operation, operand } => {
            let operand_sql = expression_to_source_sql(operand, model, registry)?;
            let case_expr = format!("CASE WHEN {condition} THEN {operand_sql} END");
            Ok(match operation {
                AggregateOp::Sum => format!("SUM({case_expr})"),
                AggregateOp::Count => format!("COUNT({case_expr})"),
                AggregateOp::Average => format!("AVG({case_expr})"),
                AggregateOp::Min => format!("MIN({case_expr})"),
                AggregateOp::Max => format!("MAX({case_expr})"),
                AggregateOp::DistinctCount => format!("COUNT(DISTINCT {case_expr})"),
                AggregateOp::CountRows => {
                    format!("SUM(CASE WHEN {condition} THEN 1 END)")
                }
                AggregateOp::Median => {
                    format!("PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY {case_expr})")
                }
                AggregateOp::StdevSample => format!("STDDEV_SAMP({case_expr})"),
                AggregateOp::StdevPop => format!("STDDEV_POP({case_expr})"),
                AggregateOp::VarSample => format!("VAR_SAMP({case_expr})"),
                AggregateOp::VarPop => format!("VAR_POP({case_expr})"),
                AggregateOp::AnyValue => format!("MIN({case_expr})"),
                AggregateOp::Mode => format!("MODE() WITHIN GROUP (ORDER BY {case_expr})"),
            })
        }
        Expression::BinaryOp { left, op, right } => {
            let l = expression_to_case_when_source_sql(left, condition, model, registry)?;
            let r = expression_to_case_when_source_sql(right, condition, model, registry)?;
            Ok(format!("({l} {} {r})", op.as_sql()))
        }
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => {
            let n = expression_to_case_when_source_sql(numerator, condition, model, registry)?;
            let d = expression_to_case_when_source_sql(denominator, condition, model, registry)?;
            let alt = match alternate {
                Some(a) => expression_to_source_sql(a, model, registry)?,
                None => "NULL".to_string(),
            };
            Ok(format!(
                "CASE WHEN {d} = 0 THEN {alt} ELSE CAST({n} AS DOUBLE PRECISION) / {d} END"
            ))
        }
        // For non-aggregate leaf expressions inside CASE WHEN context,
        // just generate regular source SQL (literals, column refs, etc.)
        _ => expression_to_source_sql(expr, model, registry),
    }
}

/// Generate SQL for an expression that may contain CLEAR context ops.
///
/// CLEAR is translated to a window function: the inner aggregate result is
/// wrapped in `SUM(inner_agg) OVER (PARTITION BY non-cleared-columns)`.
/// This produces the aggregate value ignoring the cleared dimension's grouping.
#[allow(dead_code)]
fn expression_to_source_sql_with_clear(
    expr: &Expression,
    model: &DataModel,
    registry: &SourceRegistry,
    group_by: &[ColumnRef],
) -> QueryResult<String> {
    use engine_core::model::ClearTarget;

    match expr {
        Expression::Clear {
            expr: inner,
            targets,
        } => {
            // Generate the inner expression SQL (may have KEEP → CASE WHEN).
            let inner_sql = expression_to_source_sql_with_clear(inner, model, registry, group_by)?;

            // Compute PARTITION BY: group_by columns minus cleared targets.
            let partition_cols: Vec<String> = group_by
                .iter()
                .filter(|col_ref| {
                    !targets.iter().any(|t| match t {
                        ClearTarget::Table(table) => col_ref.table == *table,
                        ClearTarget::Column { table, column } => {
                            col_ref.table == *table && col_ref.column == *column
                        }
                    })
                })
                .map(|col_ref| {
                    registry.binding_for(&col_ref.table).map(|b| {
                        format!(
                            "{}.{}",
                            quote_ident_double(&b.table),
                            quote_ident_double(&col_ref.column)
                        )
                    })
                })
                .collect::<QueryResult<Vec<_>>>()?;

            let over_clause = if partition_cols.is_empty() {
                "OVER ()".to_string()
            } else {
                format!("OVER (PARTITION BY {})", partition_cols.join(", "))
            };

            // Wrap in SUM(...) OVER (...) — works for SUM and COUNT aggregates.
            // For SUM: SUM(SUM(x)) OVER (...) = total sum ignoring cleared groups
            // For COUNT: SUM(COUNT(x)) OVER (...) = total count
            Ok(format!("SUM({inner_sql}) {over_clause}"))
        }
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => {
            // Recurse: either side may contain CLEAR.
            let n = expression_to_source_sql_with_clear(numerator, model, registry, group_by)?;
            let d = expression_to_source_sql_with_clear(denominator, model, registry, group_by)?;
            let alt = match alternate {
                Some(a) => expression_to_source_sql_with_clear(a, model, registry, group_by)?,
                None => "NULL".to_string(),
            };
            Ok(format!(
                "CASE WHEN {d} = 0 THEN {alt} ELSE CAST({n} AS DOUBLE PRECISION) / {d} END"
            ))
        }
        Expression::ClearExcept {
            expr: inner,
            table,
            except_columns,
        } => {
            // ClearExcept: keep only the listed columns from the specified table.
            let inner_sql = expression_to_source_sql_with_clear(inner, model, registry, group_by)?;

            // PARTITION BY: group_by columns that are either:
            // - NOT from the cleared table, OR
            // - In the except_columns list
            let partition_cols: Vec<String> = group_by
                .iter()
                .filter(|col_ref| {
                    if col_ref.table != *table {
                        true // different table — keep
                    } else {
                        except_columns.contains(&col_ref.column)
                    }
                })
                .map(|col_ref| {
                    registry.binding_for(&col_ref.table).map(|b| {
                        format!(
                            "{}.{}",
                            quote_ident_double(&b.table),
                            quote_ident_double(&col_ref.column)
                        )
                    })
                })
                .collect::<QueryResult<Vec<_>>>()?;

            let over_clause = if partition_cols.is_empty() {
                "OVER ()".to_string()
            } else {
                format!("OVER (PARTITION BY {})", partition_cols.join(", "))
            };

            Ok(format!("SUM({inner_sql}) {over_clause}"))
        }
        Expression::BinaryOp { left, op, right } => {
            let l = expression_to_source_sql_with_clear(left, model, registry, group_by)?;
            let r = expression_to_source_sql_with_clear(right, model, registry, group_by)?;
            Ok(format!("({l} {} {r})", op.as_sql()))
        }
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => {
            let c = expression_to_source_sql_with_clear(condition, model, registry, group_by)?;
            let t = expression_to_source_sql_with_clear(then_expr, model, registry, group_by)?;
            let e = expression_to_source_sql_with_clear(else_expr, model, registry, group_by)?;
            Ok(format!("CASE WHEN {c} THEN {t} ELSE {e} END"))
        }
        Expression::Coalesce(exprs) => {
            let parts: Vec<String> = exprs
                .iter()
                .map(|e| expression_to_source_sql_with_clear(e, model, registry, group_by))
                .collect::<QueryResult<Vec<_>>>()?;
            Ok(format!("COALESCE({})", parts.join(", ")))
        }
        Expression::Block { .. } => {
            let inlined = expr.inline_bindings();
            expression_to_source_sql_with_clear(&inlined, model, registry, group_by)
        }
        // For non-CLEAR expressions, delegate to the standard function.
        _ => expression_to_source_sql(expr, model, registry),
    }
}

/// Build a SQL query with JOINs for multi-table same-source pushdown.
///
/// Generates: SELECT dim.col, AGG(fact.col) AS alias, ...
///            FROM fact JOIN dim ON ... GROUP BY dim.col
fn build_join_aggregation_request(
    measures: &[Measure],
    group_by: &[ColumnRef],
    filters: &[FilterCondition],
    all_tables: &[&str],
    model: &DataModel,
    registry: &SourceRegistry,
) -> QueryResult<engine_connectors::JoinAggregationRequest> {
    use engine_connectors::{JoinAggregationRequest, JoinClause, MeasureExpr, QualifiedColumn};

    let fact_table = measures[0].table();
    let fact_binding = registry.binding_for(fact_table)?;

    // Build table map: model name → source table name.
    let mut table_map: Vec<(String, String)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for t in all_tables {
        if seen.insert(*t) {
            let binding = registry.binding_for(t)?;
            table_map.push((t.to_string(), binding.table.clone()));
        }
    }

    // Build group_by as QualifiedColumn (using source table names).
    let qualified_group_by: Vec<QualifiedColumn> = group_by
        .iter()
        .map(|c| {
            let binding = registry.binding_for(&c.table)?;
            Ok(QualifiedColumn {
                table: binding.table.clone(),
                column: c.column.clone(),
            })
        })
        .collect::<QueryResult<Vec<_>>>()?;

    // Build measure expressions.
    let measure_exprs: Vec<MeasureExpr> = measures
        .iter()
        .map(|m| MeasureExpr {
            expression: m.expression().clone(),
            alias: m.name().to_string(),
        })
        .collect();

    // Build JOINs.
    let mut joins: Vec<JoinClause> = Vec::new();
    let mut joined = std::collections::HashSet::new();
    joined.insert(fact_table.to_string());

    for t in all_tables {
        if *t == fact_table || joined.contains(*t) {
            continue;
        }
        let rel = model.find_relationship(fact_table, t).map_err(|_| {
            QueryError::InvalidQuery(format!("No relationship between '{fact_table}' and '{t}'"))
        })?;
        let dim_binding = registry.binding_for(t)?;
        let (fact_col, dim_col) = if rel.from_table() == fact_table {
            (rel.from_column().to_string(), rel.to_column().to_string())
        } else {
            (rel.to_column().to_string(), rel.from_column().to_string())
        };
        joins.push(JoinClause {
            dim_schema: dim_binding.schema.clone(),
            dim_table: dim_binding.table.clone(),
            fact_column: fact_col,
            dim_column: dim_col,
        });
        joined.insert(t.to_string());
    }

    Ok(JoinAggregationRequest {
        fact_schema: fact_binding.schema.clone(),
        fact_table: fact_binding.table.clone(),
        joins,
        measures: measure_exprs,
        group_by: qualified_group_by,
        filters: filters.to_vec(),
        table_map,
    })
}

/// Resolve lookup columns into `LookupSpec`s with pre-rendered SQL.
///
/// For each `LookupColumn`:
/// - Validates the table and column exist in the model.
/// - Auto-infers the key column from `group_by` if not specified.
/// - Builds the resolution SQL using the first match in the chain:
///   1. the column's own `lookup_resolution` expression;
///   2. the model-level `default_lookup_resolution`, with the `__column`
///      placeholder rewritten to the lookup column;
///   3. the built-in fallback — SELECTEDVALUE-style semantics
///      (`CASE WHEN COUNT(DISTINCT col) = 1 THEN MIN(col) ELSE '#' END`)
///      for `String` columns, plain `MIN(col)` for all other types.
/// - Returns a `LookupSpec` with the SQL fragment for the post-aggregation step.
fn resolve_lookups(
    lookups: &[crate::request::LookupColumn],
    group_by: &[ColumnRef],
    model: &DataModel,
) -> QueryResult<Vec<LookupSpec>> {
    let mut specs = Vec::new();

    for lookup in lookups {
        // Validate table exists.
        let table = model
            .table(&lookup.table)
            .map_err(|_| QueryError::InvalidQuery(format!("Table '{}' not found", lookup.table)))?;

        // Validate column exists.
        let col = table.column(&lookup.column).map_err(|_| {
            QueryError::InvalidQuery(format!(
                "Column '{}' not found in table '{}'",
                lookup.column, lookup.table
            ))
        })?;

        // Determine key column.
        let key_column = match &lookup.key_column {
            Some(key) => {
                // Validate explicit key exists.
                table.column(key).map_err(|_| {
                    QueryError::InvalidQuery(format!(
                        "Key column '{}' not found in table '{}'",
                        key, lookup.table
                    ))
                })?;
                // Validate key is in group_by.
                let in_group_by = group_by
                    .iter()
                    .any(|g| g.table == lookup.table && g.column == *key);
                if !in_group_by {
                    return Err(QueryError::InvalidQuery(format!(
                        "Key column '{}.{}' for lookup '{}.{}' must be in group_by",
                        lookup.table, key, lookup.table, lookup.column
                    )));
                }
                key.clone()
            }
            None => {
                // Auto-infer: find group_by columns from the same table.
                let candidates: Vec<&ColumnRef> = group_by
                    .iter()
                    .filter(|g| g.table == lookup.table)
                    .collect();

                match candidates.len() {
                    0 => {
                        return Err(QueryError::InvalidQuery(format!(
                            "No group_by column from table '{}' to use as key for lookup '{}.{}'",
                            lookup.table, lookup.table, lookup.column
                        )));
                    }
                    1 => candidates[0].column.clone(),
                    _ => {
                        let names: Vec<&str> =
                            candidates.iter().map(|c| c.column.as_str()).collect();
                        return Err(QueryError::InvalidQuery(format!(
                            "Multiple group_by columns from table '{}': [{}]. \
                             Specify key_column explicitly for lookup '{}.{}'",
                            lookup.table,
                            names.join(", "),
                            lookup.table,
                            lookup.column
                        )));
                    }
                }
            }
        };

        // Build resolution SQL: per-column expression → model default
        // (with `__column` placeholder) → built-in fallback.
        let table_alias = lookup.table.to_lowercase();
        let col_name = &lookup.column;
        let resolution_sql = match col.lookup_resolution() {
            Some(expr_text) => render_resolution_sql(expr_text, &table_alias, col_name)?,
            None => match model.default_lookup_resolution() {
                Some(default_expr) => {
                    render_default_resolution_sql(default_expr, &table_alias, col_name)?
                }
                None => built_in_resolution_sql(&table_alias, col_name, col.data_type()),
            },
        };

        specs.push(LookupSpec {
            table: lookup.table.clone(),
            column: lookup.column.clone(),
            key_column,
            resolution_sql,
        });
    }

    Ok(specs)
}

/// Render a resolution expression to SQL by parsing it through the expression
/// parser, qualifying column references with the table alias, and rendering
/// the result as SQL.
///
/// This supports the full expression language including VAR/RETURN blocks,
/// IF/SWITCH, HASONEVALUE, SELECTEDVALUE, FIRST, and all scalar functions.
///
/// Column references (bare names) in the expression are qualified with the
/// table alias: `col` → `table."col"`.
fn render_resolution_sql(
    expr_text: &str,
    table_alias: &str,
    column_name: &str,
) -> QueryResult<String> {
    // Parse the expression through the full parser.
    let parsed = parse_measure_expression(expr_text).map_err(|e| {
        QueryError::InvalidQuery(format!(
            "Invalid lookup_resolution expression for column '{}': {}",
            column_name, e
        ))
    })?;

    // Render to SQL with column refs qualified by the table alias.
    Ok(qualified_sql(&parsed, table_alias))
}

/// Render the model-level default lookup resolution for a specific column.
///
/// The model default is column-generic: the reserved bare identifier
/// `__column` (case-insensitive) stands for the lookup column it is applied
/// to. The expression is parsed, every placeholder reference is rewritten to
/// the actual column, and the result is rendered with the dimension table
/// alias. Defaults that omit the placeholder (or table-qualify it) are
/// rejected — `DataModelBuilder::build()` enforces the same rule, so this
/// only fires for models that bypassed validation.
fn render_default_resolution_sql(
    default_expr: &str,
    table_alias: &str,
    column_name: &str,
) -> QueryResult<String> {
    let parsed = parse_measure_expression(default_expr).map_err(|e| {
        QueryError::InvalidQuery(format!("Invalid default_lookup_resolution expression: {e}"))
    })?;
    let rewritten = apply_lookup_placeholder(&parsed, column_name)?;
    Ok(qualified_sql(&rewritten, table_alias))
}

/// Built-in lookup resolution fallback (no per-column expression, no model
/// default).
///
/// `String` columns get SELECTEDVALUE-style semantics: the actual value when
/// the group maps to exactly one distinct value, `'#'` when ambiguous. All
/// other data types keep plain `MIN(col)` — mixing `MIN(col)` with the
/// string literal `'#'` in one CASE would give the branches incompatible
/// types.
fn built_in_resolution_sql(table_alias: &str, column_name: &str, data_type: &DataType) -> String {
    let col = quote_ident_double(column_name);
    if matches!(data_type, DataType::String) {
        format!(
            "CASE WHEN COUNT(DISTINCT {table_alias}.{col}) = 1 \
             THEN MIN({table_alias}.{col}) ELSE '#' END"
        )
    } else {
        format!("MIN({table_alias}.{col})")
    }
}

/// Render an expression to SQL, qualifying bare `ColumnRef` nodes with the table alias.
///
/// `ColumnRef("col")` → `table."col"` instead of just `"col"`.
/// This is used for lookup resolution SQL where column references must be
/// prefixed with the dimension table alias.
fn qualified_sql(expr: &Expression, table_alias: &str) -> String {
    match expr {
        Expression::ColumnRef(name) => {
            format!("{table_alias}.{}", quote_ident_double(name))
        }
        Expression::QualifiedColumnRef { column, .. } => {
            format!("{table_alias}.{}", quote_ident_double(column))
        }
        Expression::LiteralFloat(v) => format!("{v}"),
        Expression::LiteralInt(v) => format!("{v}"),
        Expression::LiteralString(s) => sql_quote_literal(s),
        Expression::LiteralBool(b) => {
            if *b {
                "TRUE".to_string()
            } else {
                "FALSE".to_string()
            }
        }
        Expression::Blank => "NULL".to_string(),
        Expression::BinaryOp { left, op, right } => {
            format!(
                "({} {} {})",
                qualified_sql(left, table_alias),
                op.as_sql(),
                qualified_sql(right, table_alias)
            )
        }
        Expression::Aggregate { operation, operand } => {
            use engine_core::compute::aggregate::AggregateOp;
            match operation {
                AggregateOp::DistinctCount => {
                    format!("COUNT(DISTINCT {})", qualified_sql(operand, table_alias))
                }
                AggregateOp::CountRows => "COUNT(*)".to_string(),
                _ => format!("{operation}({})", qualified_sql(operand, table_alias)),
            }
        }
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => {
            format!(
                "CASE WHEN {} THEN {} ELSE {} END",
                qualified_sql(condition, table_alias),
                qualified_sql(then_expr, table_alias),
                qualified_sql(else_expr, table_alias)
            )
        }
        Expression::Comparison { left, op, right } => {
            format!(
                "({} {} {})",
                qualified_sql(left, table_alias),
                op.as_sql(),
                qualified_sql(right, table_alias)
            )
        }
        Expression::And(left, right) => {
            format!(
                "({} AND {})",
                qualified_sql(left, table_alias),
                qualified_sql(right, table_alias)
            )
        }
        Expression::Or(left, right) => {
            format!(
                "({} OR {})",
                qualified_sql(left, table_alias),
                qualified_sql(right, table_alias)
            )
        }
        Expression::Not(inner) => format!("(NOT {})", qualified_sql(inner, table_alias)),
        Expression::Xor(left, right) => {
            let l = qualified_sql(left, table_alias);
            let r = qualified_sql(right, table_alias);
            format!("(({l} AND NOT {r}) OR (NOT {l} AND {r}))")
        }
        Expression::IsBlank(inner) => {
            format!("({} IS NULL)", qualified_sql(inner, table_alias))
        }
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => {
            let alt = alternate
                .as_ref()
                .map(|a| qualified_sql(a, table_alias))
                .unwrap_or_else(|| "NULL".to_string());
            format!(
                "CASE WHEN {} = 0 THEN {} ELSE (CAST({} AS DOUBLE) / {}) END",
                qualified_sql(denominator, table_alias),
                alt,
                qualified_sql(numerator, table_alias),
                qualified_sql(denominator, table_alias)
            )
        }
        Expression::Coalesce(exprs) => {
            let args: Vec<String> = exprs
                .iter()
                .map(|e| qualified_sql(e, table_alias))
                .collect();
            format!("COALESCE({})", args.join(", "))
        }
        Expression::ScalarFunc { function, args } => {
            let strs: Vec<String> = args.iter().map(|a| qualified_sql(a, table_alias)).collect();
            function.to_sql_strs(&strs)
        }
        Expression::TextFunc { function, args } => {
            let strs: Vec<String> = args.iter().map(|a| qualified_sql(a, table_alias)).collect();
            function.to_sql_strs(&strs)
        }
        Expression::Switch {
            expr,
            cases,
            default,
        } => {
            let mut sql = format!("CASE {}", qualified_sql(expr, table_alias));
            for (val, result) in cases {
                sql.push_str(&format!(
                    " WHEN {} THEN {}",
                    qualified_sql(val, table_alias),
                    qualified_sql(result, table_alias)
                ));
            }
            if let Some(d) = default {
                sql.push_str(&format!(" ELSE {}", qualified_sql(d, table_alias)));
            }
            sql.push_str(" END");
            sql
        }
        Expression::Block { .. } => {
            // Inline bindings first, then render with qualification.
            let inlined = expr.inline_bindings();
            qualified_sql(&inlined, table_alias)
        }
        Expression::HasOneValue { column } => {
            format!(
                "(COUNT(DISTINCT {}) = 1)",
                qualified_sql(column, table_alias)
            )
        }
        Expression::SelectedValue { column, alternate } => {
            let col_sql = qualified_sql(column, table_alias);
            let alt = alternate
                .as_ref()
                .map(|a| qualified_sql(a, table_alias))
                .unwrap_or_else(|| "NULL".to_string());
            format!("CASE WHEN COUNT(DISTINCT {col_sql}) = 1 THEN MIN({col_sql}) ELSE {alt} END")
        }
        Expression::FirstValue { column, order_by } => {
            format!(
                "FIRST_VALUE({} ORDER BY {})",
                qualified_sql(column, table_alias),
                qualified_sql(order_by, table_alias)
            )
        }
        // Context ops, TableRef, etc. — delegate to inner or pass through.
        Expression::Keep { expr, .. }
        | Expression::Clear { expr, .. }
        | Expression::Reset { expr }
        | Expression::ClearInner { expr, .. }
        | Expression::ClearOuter { expr, .. }
        | Expression::ResetInner { expr }
        | Expression::ResetOuter { expr }
        | Expression::Traverse { expr, .. }
        | Expression::Using { expr, .. }
        | Expression::KeepIn { expr, .. } => qualified_sql(expr, table_alias),
        _ => expr.to_sql_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::SourceBinding;
    use engine_core::compute::measure::{count_measure, sum_measure};
    use engine_core::model::schema::DataModel;
    use engine_core::model::{Column, Relationship, Table};
    use engine_core::types::DataType;

    fn test_model_single_table() -> DataModel {
        let sales = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("amount", DataType::Float64),
                Column::new("region", DataType::String),
            ],
        )
        .unwrap();

        DataModel::builder()
            .add_table(sales)
            .add_measure(sum_measure("TotalAmount", "Sales", "amount"))
            .add_measure(count_measure("OrderCount", "Sales", "id"))
            .build()
            .unwrap()
    }

    fn test_model_star_schema() -> DataModel {
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

        DataModel::builder()
            .add_table(sales)
            .add_table(products)
            .add_relationship(Relationship::many_to_one(
                "Sales_Products",
                "Sales",
                "product_id",
                "Products",
                "id",
            ))
            .add_measure(sum_measure("TotalAmount", "Sales", "amount"))
            .build()
            .unwrap()
    }

    fn mock_registry_single(connector_idx: usize) -> SourceRegistry {
        let mut registry = SourceRegistry::new();
        registry.bind(
            "Sales",
            connector_idx,
            SourceBinding::new("sales", "salesorderheader"),
        );
        registry
    }

    fn mock_registry_star(connector_idx: usize) -> SourceRegistry {
        let mut registry = SourceRegistry::new();
        registry.bind(
            "Sales",
            connector_idx,
            SourceBinding::new("sales", "salesorderheader"),
        );
        registry.bind(
            "Products",
            connector_idx,
            SourceBinding::new("production", "product"),
        );
        registry
    }

    /// Two tables on different connectors — forces local aggregation.
    fn make_cross_source_registry() -> SourceRegistry {
        let mut registry = SourceRegistry::new();
        registry.bind("Sales", 0, SourceBinding::new("sales", "salesorderheader"));
        registry.bind("Products", 1, SourceBinding::new("production", "product"));
        registry
    }

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
    fn keep_filter_value_injection_is_escaped_in_source_sql() {
        use engine_core::compute::aggregate::AggregateOp;

        let model = test_model_star_schema();
        let registry = mock_registry_star(0);

        let expr = Expression::Aggregate {
            operation: AggregateOp::Sum,
            operand: Box::new(Expression::Keep {
                expr: Box::new(Expression::ColumnRef("amount".into())),
                filters: vec![FilterPredicate::new(
                    "Products",
                    "category",
                    ComparisonOp::Equal,
                    "x'); DROP TABLE t; --",
                )],
                variables: vec![],
                conditions: vec![],
                in_predicates: vec![],
            }),
        };

        let sql = expression_to_source_sql(&expr, &model, &registry).unwrap();
        // The embedded quote is doubled so the literal cannot terminate early.
        assert!(sql.contains("'x''); DROP TABLE t; --'"), "{sql}");
        assert!(!sql.contains("= 'x');"), "{sql}");
    }

    #[test]
    fn identifier_with_embedded_quote_is_escaped_in_source_sql() {
        let model = test_model_star_schema();
        let registry = mock_registry_star(0);

        let expr = Expression::ColumnRef("evil\"name".into());
        let sql = expression_to_source_sql(&expr, &model, &registry).unwrap();
        assert_eq!(sql, "\"evil\"\"name\"");
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
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry).unwrap();

        match plan {
            QueryPlan::PushedJoinAggregation {
                source_table,
                request: req,
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
        };

        let result = PushdownPlanner::plan(&request, &model, &registry);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Sales"));
    }

    fn mock_registry_cross_source() -> SourceRegistry {
        let mut registry = SourceRegistry::new();
        // Sales on connector 0, Products on connector 1 (different sources).
        registry.bind("Sales", 0, SourceBinding::new("sales", "salesorderheader"));
        registry.bind("Products", 1, SourceBinding::new("production", "product"));
        registry
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
    fn empty_measures_returns_error() {
        let model = test_model_single_table();
        let registry = mock_registry_single(0);

        let request = QueryRequest {
            measures: vec![],
            group_by: vec![],
            filters: vec![],
            lookups: vec![],
        };

        let result = PushdownPlanner::plan(&request, &model, &registry);
        assert!(result.is_err());
    }

    // --- Context filter pushdown tests ---

    use engine_core::compute::aggregate::AggregateOp;
    use engine_core::compute::expression::{self as expr, ComparisonOp, FilterPredicate};
    use engine_core::compute::measure::expression_measure;

    /// Star schema with fact + two dimensions, for context filter pushdown tests.
    fn test_model_three_table() -> DataModel {
        let sales = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("product_id", DataType::Int64),
                Column::new("date_id", DataType::Int64),
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

        let dates = Table::new(
            "Dates",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("year", DataType::Int32),
                Column::new("month", DataType::Int32),
            ],
        )
        .unwrap();

        DataModel::builder()
            .add_table(sales)
            .add_table(products)
            .add_table(dates)
            .add_relationship(Relationship::many_to_one(
                "Sales_Products",
                "Sales",
                "product_id",
                "Products",
                "id",
            ))
            .add_relationship(Relationship::many_to_one(
                "Sales_Dates",
                "Sales",
                "date_id",
                "Dates",
                "id",
            ))
            .build()
            .unwrap()
    }

    fn mock_registry_three(connector_idx: usize) -> SourceRegistry {
        let mut registry = SourceRegistry::new();
        registry.bind("Sales", connector_idx, SourceBinding::new("dbo", "sales"));
        registry.bind(
            "Products",
            connector_idx,
            SourceBinding::new("dbo", "products"),
        );
        registry.bind("Dates", connector_idx, SourceBinding::new("dbo", "dates"));
        registry
    }

    #[test]
    fn context_filter_pushed_to_dimension_fetch() {
        // KEEP filter on Dates (not in group_by) should be pushed to source fetch.
        let mut model = test_model_three_table();
        model = DataModel::builder()
            .add_table(model.table("Sales").unwrap().clone())
            .add_table(model.table("Products").unwrap().clone())
            .add_table(model.table("Dates").unwrap().clone())
            .add_relationship(Relationship::many_to_one(
                "Sales_Products",
                "Sales",
                "product_id",
                "Products",
                "id",
            ))
            .add_relationship(Relationship::many_to_one(
                "Sales_Dates",
                "Sales",
                "date_id",
                "Dates",
                "id",
            ))
            .add_measure(expression_measure(
                "Revenue2014",
                expr::agg(
                    AggregateOp::Sum,
                    expr::keep(
                        expr::qualified_col("Sales", "amount"),
                        vec![FilterPredicate::new(
                            "Dates",
                            "year",
                            ComparisonOp::Equal,
                            "2014",
                        )],
                    ),
                ),
            ))
            .build()
            .unwrap();

        let registry = mock_registry_three(0);
        let request = QueryRequest {
            measures: vec!["Revenue2014".into()],
            group_by: vec![ColumnRef::new("Products", "category")],
            filters: vec![],
            lookups: vec![],
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry).unwrap();

        match plan {
            QueryPlan::PushedJoinAggregation { .. } => {
                // KEEP filter should be translated to CASE WHEN in pushed SQL.
            }
            other => panic!("Expected PushedJoinAggregation, got {other:?}"),
        }
    }

    #[test]
    fn context_filter_not_pushed_to_group_by_table() {
        // KEEP filter on Products (which is also in group_by) should NOT be pushed.
        let mut model = test_model_three_table();
        model = DataModel::builder()
            .add_table(model.table("Sales").unwrap().clone())
            .add_table(model.table("Products").unwrap().clone())
            .add_table(model.table("Dates").unwrap().clone())
            .add_relationship(Relationship::many_to_one(
                "Sales_Products",
                "Sales",
                "product_id",
                "Products",
                "id",
            ))
            .add_relationship(Relationship::many_to_one(
                "Sales_Dates",
                "Sales",
                "date_id",
                "Dates",
                "id",
            ))
            .add_measure(expression_measure(
                "BikeRevenue",
                expr::agg(
                    AggregateOp::Sum,
                    expr::keep(
                        expr::qualified_col("Sales", "amount"),
                        vec![FilterPredicate::new(
                            "Products",
                            "category",
                            ComparisonOp::Equal,
                            "Bikes",
                        )],
                    ),
                ),
            ))
            .build()
            .unwrap();

        let registry = mock_registry_three(0);
        let request = QueryRequest {
            measures: vec!["BikeRevenue".into()],
            group_by: vec![ColumnRef::new("Products", "category")],
            filters: vec![],
            lookups: vec![],
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry).unwrap();

        match plan {
            QueryPlan::PushedJoinAggregation { .. } => {
                // KEEP filter on group-by table becomes CASE WHEN in pushed SQL.
            }
            other => panic!("Expected PushedJoinAggregation, got {other:?}"),
        }
    }

    #[test]
    fn context_filter_not_pushed_to_fact_table() {
        // KEEP filter on Sales (the fact/measure table) should NOT be pushed.
        let mut model = test_model_three_table();
        model = DataModel::builder()
            .add_table(model.table("Sales").unwrap().clone())
            .add_table(model.table("Products").unwrap().clone())
            .add_table(model.table("Dates").unwrap().clone())
            .add_relationship(Relationship::many_to_one(
                "Sales_Products",
                "Sales",
                "product_id",
                "Products",
                "id",
            ))
            .add_relationship(Relationship::many_to_one(
                "Sales_Dates",
                "Sales",
                "date_id",
                "Dates",
                "id",
            ))
            .add_measure(expression_measure(
                "LargeOrders",
                expr::agg(
                    AggregateOp::Sum,
                    expr::keep(
                        expr::qualified_col("Sales", "amount"),
                        vec![FilterPredicate::new(
                            "Sales",
                            "amount",
                            ComparisonOp::GreaterThan,
                            "1000",
                        )],
                    ),
                ),
            ))
            .build()
            .unwrap();

        let registry = mock_registry_three(0);
        let request = QueryRequest {
            measures: vec!["LargeOrders".into()],
            group_by: vec![ColumnRef::new("Products", "category")],
            filters: vec![],
            lookups: vec![],
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry).unwrap();

        match plan {
            QueryPlan::PushedJoinAggregation { .. } => {
                // KEEP filter on fact table becomes CASE WHEN in pushed SQL.
            }
            other => panic!("Expected PushedJoinAggregation, got {other:?}"),
        }
    }

    #[test]
    fn conflicting_context_filters_not_pushed() {
        // Two measures with different KEEP values on the same dimension → no push.
        let mut model = test_model_three_table();
        model = DataModel::builder()
            .add_table(model.table("Sales").unwrap().clone())
            .add_table(model.table("Products").unwrap().clone())
            .add_table(model.table("Dates").unwrap().clone())
            .add_relationship(Relationship::many_to_one(
                "Sales_Products",
                "Sales",
                "product_id",
                "Products",
                "id",
            ))
            .add_relationship(Relationship::many_to_one(
                "Sales_Dates",
                "Sales",
                "date_id",
                "Dates",
                "id",
            ))
            .add_measure(expression_measure(
                "Revenue2014",
                expr::agg(
                    AggregateOp::Sum,
                    expr::keep(
                        expr::qualified_col("Sales", "amount"),
                        vec![FilterPredicate::new(
                            "Dates",
                            "year",
                            ComparisonOp::Equal,
                            "2014",
                        )],
                    ),
                ),
            ))
            .add_measure(expression_measure(
                "Revenue2015",
                expr::agg(
                    AggregateOp::Sum,
                    expr::keep(
                        expr::qualified_col("Sales", "amount"),
                        vec![FilterPredicate::new(
                            "Dates",
                            "year",
                            ComparisonOp::Equal,
                            "2015",
                        )],
                    ),
                ),
            ))
            .build()
            .unwrap();

        let registry = mock_registry_three(0);
        let request = QueryRequest {
            measures: vec!["Revenue2014".into(), "Revenue2015".into()],
            group_by: vec![ColumnRef::new("Products", "category")],
            filters: vec![],
            lookups: vec![],
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry).unwrap();

        match plan {
            QueryPlan::PushedJoinAggregation { .. } => {
                // Both KEEP filters become separate CASE WHEN clauses.
            }
            other => panic!("Expected PushedJoinAggregation, got {other:?}"),
        }
    }

    #[test]
    fn agreeing_context_filters_pushed() {
        // Two measures with SAME KEEP value on a dimension → push.
        let mut model = test_model_three_table();
        model = DataModel::builder()
            .add_table(model.table("Sales").unwrap().clone())
            .add_table(model.table("Products").unwrap().clone())
            .add_table(model.table("Dates").unwrap().clone())
            .add_relationship(Relationship::many_to_one(
                "Sales_Products",
                "Sales",
                "product_id",
                "Products",
                "id",
            ))
            .add_relationship(Relationship::many_to_one(
                "Sales_Dates",
                "Sales",
                "date_id",
                "Dates",
                "id",
            ))
            .add_measure(expression_measure(
                "SumRevenue2014",
                expr::agg(
                    AggregateOp::Sum,
                    expr::keep(
                        expr::qualified_col("Sales", "amount"),
                        vec![FilterPredicate::new(
                            "Dates",
                            "year",
                            ComparisonOp::Equal,
                            "2014",
                        )],
                    ),
                ),
            ))
            .add_measure(expression_measure(
                "CountRevenue2014",
                expr::agg(
                    AggregateOp::Count,
                    expr::keep(
                        expr::qualified_col("Sales", "amount"),
                        vec![FilterPredicate::new(
                            "Dates",
                            "year",
                            ComparisonOp::Equal,
                            "2014",
                        )],
                    ),
                ),
            ))
            .build()
            .unwrap();

        let registry = mock_registry_three(0);
        let request = QueryRequest {
            measures: vec!["SumRevenue2014".into(), "CountRevenue2014".into()],
            group_by: vec![ColumnRef::new("Products", "category")],
            filters: vec![],
            lookups: vec![],
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry).unwrap();

        match plan {
            QueryPlan::PushedJoinAggregation { .. } => {
                // Both measures use the same year=2014 KEEP filter.
            }
            other => panic!("Expected PushedJoinAggregation, got {other:?}"),
        }
    }

    #[test]
    fn one_measure_with_context_one_without_still_pushes() {
        // Measure A: KEEP(Dates.year = 2014), Measure B: no filter on Dates.
        // Measure B doesn't need Dates data, so pushing year=2014 is safe.
        let mut model = test_model_three_table();
        model = DataModel::builder()
            .add_table(model.table("Sales").unwrap().clone())
            .add_table(model.table("Products").unwrap().clone())
            .add_table(model.table("Dates").unwrap().clone())
            .add_relationship(Relationship::many_to_one(
                "Sales_Products",
                "Sales",
                "product_id",
                "Products",
                "id",
            ))
            .add_relationship(Relationship::many_to_one(
                "Sales_Dates",
                "Sales",
                "date_id",
                "Dates",
                "id",
            ))
            .add_measure(expression_measure(
                "Revenue2014",
                expr::agg(
                    AggregateOp::Sum,
                    expr::keep(
                        expr::qualified_col("Sales", "amount"),
                        vec![FilterPredicate::new(
                            "Dates",
                            "year",
                            ComparisonOp::Equal,
                            "2014",
                        )],
                    ),
                ),
            ))
            .add_measure(sum_measure("TotalRevenue", "Sales", "amount"))
            .build()
            .unwrap();

        let registry = mock_registry_three(0);
        let request = QueryRequest {
            measures: vec!["Revenue2014".into(), "TotalRevenue".into()],
            group_by: vec![ColumnRef::new("Products", "category")],
            filters: vec![],
            lookups: vec![],
        };

        let plan = PushdownPlanner::plan(&request, &model, &registry).unwrap();

        match plan {
            QueryPlan::PushedJoinAggregation { .. } => {
                // Revenue2014 has KEEP filter → CASE WHEN in SQL.
                // TotalRevenue is a plain SUM without CASE WHEN.
                // TotalRevenue should be a plain SUM.
            }
            other => panic!("Expected PushedJoinAggregation, got {other:?}"),
        }
    }

    // --- resolve_lookups tests ---

    fn lookup_model() -> DataModel {
        let products = Table::new(
            "Products",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("category_id", DataType::Int32),
                Column::new("category_name", DataType::String),
                Column::new("subcategory", DataType::String),
                Column::new("weight", DataType::Float64),
            ],
        )
        .unwrap();

        let sales = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("product_id", DataType::Int64),
                Column::new("amount", DataType::Float64),
            ],
        )
        .unwrap();

        DataModel::builder()
            .add_table(products)
            .add_table(sales)
            .add_relationship(Relationship::many_to_one(
                "Sales_Products",
                "Sales",
                "product_id",
                "Products",
                "id",
            ))
            .add_measure(sum_measure("Revenue", "Sales", "amount"))
            .build()
            .unwrap()
    }

    #[test]
    fn resolve_lookups_auto_infers_key() {
        use crate::request::LookupColumn;
        let model = lookup_model();
        let group_by = vec![ColumnRef::new("Products", "category_id")];
        let lookups = vec![LookupColumn::new("Products", "category_name")];
        let specs = resolve_lookups(&lookups, &group_by, &model).unwrap();

        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].column, "category_name");
        assert_eq!(specs[0].key_column, "category_id");
        // Default: SELECTEDVALUE semantics — return value when unique, '#' when ambiguous.
        assert!(specs[0].resolution_sql.contains("COUNT(DISTINCT"));
        assert!(specs[0].resolution_sql.contains("MIN("));
        assert!(specs[0].resolution_sql.contains("'#'"));
    }

    #[test]
    fn resolve_lookups_explicit_key() {
        use crate::request::LookupColumn;
        let model = lookup_model();
        let group_by = vec![
            ColumnRef::new("Products", "category_id"),
            ColumnRef::new("Products", "subcategory"),
        ];
        let lookups = vec![LookupColumn::with_key(
            "Products",
            "category_name",
            "category_id",
        )];
        let specs = resolve_lookups(&lookups, &group_by, &model).unwrap();

        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].key_column, "category_id");
    }

    #[test]
    fn resolve_lookups_errors_on_ambiguous_key() {
        use crate::request::LookupColumn;
        let model = lookup_model();
        let group_by = vec![
            ColumnRef::new("Products", "category_id"),
            ColumnRef::new("Products", "subcategory"),
        ];
        let lookups = vec![LookupColumn::new("Products", "category_name")];
        let result = resolve_lookups(&lookups, &group_by, &model);

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Multiple group_by columns"));
    }

    #[test]
    fn resolve_lookups_errors_on_no_key() {
        use crate::request::LookupColumn;
        let model = lookup_model();
        // group_by has no Products columns
        let group_by = vec![ColumnRef::new("Sales", "product_id")];
        let lookups = vec![LookupColumn::new("Products", "category_name")];
        let result = resolve_lookups(&lookups, &group_by, &model);

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("No group_by column"));
    }

    #[test]
    fn resolve_lookups_default_resolution_is_selectedvalue() {
        use crate::request::LookupColumn;
        let model = lookup_model();
        let group_by = vec![ColumnRef::new("Products", "category_id")];
        let lookups = vec![LookupColumn::new("Products", "category_name")];
        let specs = resolve_lookups(&lookups, &group_by, &model).unwrap();

        // String column default:
        // CASE WHEN COUNT(DISTINCT col) = 1 THEN MIN(col) ELSE '#' END
        let sql = &specs[0].resolution_sql;
        assert_eq!(
            sql,
            "CASE WHEN COUNT(DISTINCT products.\"category_name\") = 1 \
             THEN MIN(products.\"category_name\") ELSE '#' END"
        );
    }

    #[test]
    fn resolve_lookups_non_string_column_gets_min_fallback() {
        use crate::request::LookupColumn;
        let model = lookup_model();
        let group_by = vec![ColumnRef::new("Products", "category_id")];
        let lookups = vec![LookupColumn::new("Products", "weight")];
        let specs = resolve_lookups(&lookups, &group_by, &model).unwrap();

        // Non-string columns must NOT get the '#' CASE branch — MIN(float)
        // and '#' would have incompatible types.
        assert_eq!(specs[0].resolution_sql, "MIN(products.\"weight\")");
    }

    #[test]
    fn resolve_lookups_model_default_resolution() {
        use crate::request::LookupColumn;

        let products = Table::new(
            "Products",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("category_id", DataType::Int32),
                Column::new("category_name", DataType::String),
            ],
        )
        .unwrap();

        let model = DataModel::builder()
            .add_table(products)
            .default_lookup_resolution("MAX(__column)")
            .build()
            .unwrap();

        let group_by = vec![ColumnRef::new("Products", "category_id")];
        let lookups = vec![LookupColumn::new("Products", "category_name")];
        let specs = resolve_lookups(&lookups, &group_by, &model).unwrap();

        // Model default overrides the built-in fallback; the `__column`
        // placeholder is rewritten to the actual lookup column.
        assert_eq!(specs[0].resolution_sql, "MAX(products.\"category_name\")");
    }

    #[test]
    fn resolve_lookups_model_default_applies_to_each_column() {
        use crate::request::LookupColumn;
        let model = {
            let products = Table::new(
                "Products",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("category_id", DataType::Int32),
                    Column::new("category_name", DataType::String),
                    Column::new("subcategory", DataType::String),
                ],
            )
            .unwrap();
            DataModel::builder()
                .add_table(products)
                .default_lookup_resolution("MAX(__column)")
                .build()
                .unwrap()
        };

        let group_by = vec![ColumnRef::new("Products", "category_id")];
        let lookups = vec![
            LookupColumn::new("Products", "category_name"),
            LookupColumn::new("Products", "subcategory"),
        ];
        let specs = resolve_lookups(&lookups, &group_by, &model).unwrap();

        // Each lookup resolves ITS OWN column — the placeholder must not
        // pin the default to one hard-coded column.
        assert_eq!(specs[0].resolution_sql, "MAX(products.\"category_name\")");
        assert_eq!(specs[1].resolution_sql, "MAX(products.\"subcategory\")");
    }

    #[test]
    fn model_default_without_placeholder_rejected_at_build() {
        let products = Table::new(
            "Products",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("category_name", DataType::String),
            ],
        )
        .unwrap();

        let result = DataModel::builder()
            .add_table(products)
            .default_lookup_resolution("MAX(category_name)")
            .build();

        let err = result.unwrap_err().to_string();
        assert!(err.contains("__column"), "got: {err}");
    }

    #[test]
    fn invalid_model_default_rejected_at_build() {
        let products = Table::new("Products", vec![Column::new("id", DataType::Int64)]).unwrap();

        let result = DataModel::builder()
            .add_table(products)
            .default_lookup_resolution("MAX(")
            .build();

        let err = result.unwrap_err().to_string();
        assert!(err.contains("does not parse"), "got: {err}");
    }

    #[test]
    fn resolve_lookups_column_overrides_model_default() {
        use crate::request::LookupColumn;

        let products = Table::new(
            "Products",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("category_id", DataType::Int32),
                Column::new("category_name", DataType::String)
                    .with_lookup_resolution("FIRST(category_name, ORDER BY id)"),
            ],
        )
        .unwrap();

        let model = DataModel::builder()
            .add_table(products)
            .default_lookup_resolution("MAX(__column)")
            .build()
            .unwrap();

        let group_by = vec![ColumnRef::new("Products", "category_id")];
        let lookups = vec![LookupColumn::new("Products", "category_name")];
        let specs = resolve_lookups(&lookups, &group_by, &model).unwrap();

        // Per-column resolution wins over model default.
        assert!(specs[0].resolution_sql.contains("FIRST_VALUE"));
    }

    #[test]
    fn resolve_lookups_custom_resolution() {
        use crate::request::LookupColumn;

        let products = Table::new(
            "Products",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("category_id", DataType::Int32),
                Column::new("category_name", DataType::String)
                    .with_lookup_resolution("MAX(category_name)"),
            ],
        )
        .unwrap();

        let sales = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("product_id", DataType::Int64),
                Column::new("amount", DataType::Float64),
            ],
        )
        .unwrap();

        let model = DataModel::builder()
            .add_table(products)
            .add_table(sales)
            .add_relationship(Relationship::many_to_one(
                "Sales_Products",
                "Sales",
                "product_id",
                "Products",
                "id",
            ))
            .add_measure(sum_measure("Revenue", "Sales", "amount"))
            .build()
            .unwrap();

        let group_by = vec![ColumnRef::new("Products", "category_id")];
        let lookups = vec![LookupColumn::new("Products", "category_name")];
        let specs = resolve_lookups(&lookups, &group_by, &model).unwrap();

        assert_eq!(specs[0].resolution_sql, "MAX(products.\"category_name\")");
    }

    #[test]
    fn resolve_lookups_empty_is_noop() {
        let model = lookup_model();
        let group_by = vec![ColumnRef::new("Products", "category_id")];
        let specs = resolve_lookups(&[], &group_by, &model).unwrap();
        assert!(specs.is_empty());
    }

    #[test]
    fn render_resolution_hasonevalue() {
        let sql = render_resolution_sql(
            "IF(HASONEVALUE(category_name), SELECTEDVALUE(category_name), \"*\")",
            "products",
            "category_name",
        )
        .unwrap();
        assert!(sql.contains("COUNT(DISTINCT products.\"category_name\")"));
        assert!(sql.contains("'*'"));
    }

    #[test]
    fn render_resolution_selectedvalue() {
        let sql = render_resolution_sql(
            "SELECTEDVALUE(category_name, \"Multiple\")",
            "products",
            "category_name",
        )
        .unwrap();
        assert!(sql.contains("COUNT(DISTINCT products.\"category_name\")"));
        assert!(sql.contains("'Multiple'"));
    }

    #[test]
    fn render_resolution_first() {
        let sql =
            render_resolution_sql("FIRST(name, ORDER BY sort_order)", "products", "name").unwrap();
        assert_eq!(
            sql,
            "FIRST_VALUE(products.\"name\" ORDER BY products.\"sort_order\")"
        );
    }

    #[test]
    fn render_resolution_var_return() {
        let sql = render_resolution_sql(
            "VAR cnt = DISTINCTCOUNT(name) RETURN IF(cnt > 1, \"*\", MIN(name))",
            "products",
            "name",
        )
        .unwrap();
        // After inlining: IF(DISTINCTCOUNT(name) > 1, "*", MIN(name))
        assert!(sql.contains("COUNT(DISTINCT products.\"name\")"));
        assert!(sql.contains("MIN(products.\"name\")"));
    }

    #[test]
    fn render_resolution_simple_min() {
        let sql = render_resolution_sql("MIN(category_name)", "products", "category_name").unwrap();
        assert_eq!(sql, "MIN(products.\"category_name\")");
    }

    #[test]
    fn render_resolution_simple_max() {
        let sql = render_resolution_sql("MAX(category_name)", "products", "category_name").unwrap();
        assert_eq!(sql, "MAX(products.\"category_name\")");
    }
}
