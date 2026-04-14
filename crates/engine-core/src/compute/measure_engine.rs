//! MeasureEngine: evaluates measures against in-memory data.
//!
//! The engine takes a `DataModel` and `ColumnStore` and computes measure
//! results as scalar values or grouped `RecordBatch` results. It handles
//! single-table and cross-table (star-schema) evaluations, materializing
//! calculated columns as needed.

use arrow::compute::concat_batches;
use arrow::record_batch::RecordBatch;
use datafusion::common::ScalarValue;
use datafusion::prelude::SessionContext;

use crate::compute::aggregate::AggregateResult;
use crate::compute::context::{
    format_filter_value, ContextResolver, ResolvedFilter, ResolvedInFilter,
};
use crate::compute::evaluate::materialize_calculated_columns;
use crate::compute::expression::expand_global_variables;
use crate::error::EngineResult;
use crate::model::schema::DataModel;
use crate::store::ColumnStore;
use crate::types::TableColumn;

/// Evaluates measures against in-memory data in a `ColumnStore`.
///
/// The `MeasureEngine` is the primary API for computing measure results
/// against locally stored data. It resolves measures from the `DataModel`,
/// materializes calculated columns when needed, and uses DataFusion for
/// computation.
pub struct MeasureEngine<'a> {
    model: &'a DataModel,
    store: &'a ColumnStore,
}

impl<'a> MeasureEngine<'a> {
    /// Create a new MeasureEngine.
    pub fn new(model: &'a DataModel, store: &'a ColumnStore) -> Self {
        Self { model, store }
    }

    /// Evaluate a single measure by name, returning a scalar result.
    pub async fn evaluate(&self, measure_name: &str) -> EngineResult<AggregateResult> {
        self.evaluate_with_outer_filters(measure_name, &[]).await
    }

    /// Evaluate a single measure with outer (query-level) filters.
    ///
    /// Context operations in the measure expression (`keep`, `clear`, `reset`)
    /// are resolved against the outer filters. For example, `reset()` removes
    /// all outer filters, while `keep()` adds additional filters.
    pub async fn evaluate_with_outer_filters(
        &self,
        measure_name: &str,
        outer_filters: &[ResolvedFilter],
    ) -> EngineResult<AggregateResult> {
        let measure = self.model.measure(measure_name)?;
        let table_name = measure.table();

        // Expand global variable references before context resolution.
        let expanded = expand_global_variables(measure.expression(), self.model);

        // Resolve context operations from the expression.
        let resolver = ContextResolver::new(self.model);
        let (stripped_expr, eval_ctx) = resolver.resolve(&expanded)?;
        let effective = eval_ctx.effective_filters(outer_filters);

        // Two-stage evaluation for measures with QUERY bindings.
        if stripped_expr.has_query_bindings() {
            return self
                .evaluate_query_block(measure_name, &stripped_expr, table_name, &effective)
                .await;
        }

        // Get table data and materialize calculated columns if needed.
        let batch = self.get_table_batch(table_name).await?;

        let ctx = SessionContext::new();
        ctx.register_batch("t", batch)?;

        // Register dimension tables if we have cross-table filters.
        let cross_table_filters = self
            .register_cross_table_data(&ctx, table_name, &effective)
            .await?;

        let expr_sql = stripped_expr.to_sql_string();
        let mut sql = format!("SELECT {expr_sql} AS \"{}\" FROM t", measure.name());

        // Add JOINs for cross-table filters.
        for (dim_lower, join_clause) in &cross_table_filters {
            sql.push_str(&format!(" JOIN {dim_lower} ON {join_clause}"));
        }

        // Build WHERE clause from resolved filters + IN filters.
        let where_clause = self.build_where_clause(&effective, table_name);
        let mut registered = std::collections::HashSet::new();
        registered.insert("t".to_string());
        let in_conditions = self
            .build_in_filter_sql(&ctx, &eval_ctx.in_filters, table_name, &mut registered)
            .await?;

        let mut all_where: Vec<String> = Vec::new();
        if !where_clause.is_empty() {
            all_where.push(where_clause);
        }
        all_where.extend(in_conditions);

        if !all_where.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&all_where.join(" AND "));
        }

        let df = ctx.sql(&sql).await?;
        let batches = df.collect().await?;

        let scalar = extract_scalar(&batches)?;
        Ok(AggregateResult {
            operation: measure
                .simple_operation()
                .unwrap_or(crate::compute::aggregate::AggregateOp::Sum),
            column: measure.name().to_string(),
            value: scalar,
        })
    }

    /// Evaluate a measure grouped by one or more columns.
    ///
    /// Group-by columns may reference the measure's own table or dimension
    /// tables connected via relationships in the data model.
    pub async fn evaluate_grouped(
        &self,
        measure_name: &str,
        group_by: &[TableColumn],
    ) -> EngineResult<RecordBatch> {
        self.evaluate_grouped_with_outer_filters(measure_name, group_by, &[])
            .await
    }

    /// Evaluate a measure grouped by columns, with outer (query-level) filters.
    pub async fn evaluate_grouped_with_outer_filters(
        &self,
        measure_name: &str,
        group_by: &[TableColumn],
        outer_filters: &[ResolvedFilter],
    ) -> EngineResult<RecordBatch> {
        let measure = self.model.measure(measure_name)?;
        let fact_table = measure.table();

        // Expand global variable references before context resolution.
        let expanded = expand_global_variables(measure.expression(), self.model);

        // Resolve context operations.
        let resolver = ContextResolver::new(self.model);
        let (stripped_expr, eval_ctx) = resolver.resolve(&expanded)?;
        let effective = eval_ctx.effective_filters(outer_filters);

        // Two-stage evaluation for measures with QUERY bindings.
        if stripped_expr.has_query_bindings() {
            return self
                .evaluate_query_block_grouped(
                    measure_name,
                    &stripped_expr,
                    fact_table,
                    group_by,
                    &effective,
                )
                .await;
        }

        // Determine which tables are involved (from group-by + filters).
        let mut tables_needed: Vec<&str> = vec![fact_table];
        for tc in group_by {
            if tc.table != fact_table && !tables_needed.contains(&tc.table.as_str()) {
                tables_needed.push(&tc.table);
            }
        }
        for f in &effective {
            if f.table != fact_table && !tables_needed.contains(&f.table.as_str()) {
                tables_needed.push(&f.table);
            }
        }

        let ctx = SessionContext::new();

        // Register all needed tables (with calculated columns materialized).
        for table_name in &tables_needed {
            let batch = self.get_table_batch(table_name).await?;
            let df_name = table_name.to_lowercase();
            ctx.register_batch(&df_name, batch)?;
        }

        let fact_lower = fact_table.to_lowercase();

        // Build SELECT: group_by columns + measure expression
        let mut select_parts: Vec<String> = Vec::new();
        let mut group_parts: Vec<String> = Vec::new();

        for tc in group_by {
            let tbl = tc.table.to_lowercase();
            let qualified = format!("{tbl}.\"{}\"", tc.column);
            select_parts.push(qualified.clone());
            group_parts.push(qualified);
        }

        let expr_sql = stripped_expr.to_sql_string();
        select_parts.push(format!("{expr_sql} AS \"{}\"", measure.name()));

        let select_clause = select_parts.join(", ");
        let mut sql = format!("SELECT {select_clause} FROM {fact_lower}");

        // Add JOINs for dimension tables.
        let mut joined = std::collections::HashSet::new();
        joined.insert(fact_lower.clone());

        for table_name in &tables_needed {
            let dim_lower = table_name.to_lowercase();
            if joined.contains(&dim_lower) {
                continue;
            }

            let rel = self.model.find_relationship(fact_table, table_name)?;
            let left_is_from = rel.from_table() == fact_table;
            let on_clause = rel.build_on_clause(&fact_lower, &dim_lower, left_is_from);
            sql.push_str(&format!(" JOIN {dim_lower} ON {on_clause}"));
            joined.insert(dim_lower);
        }

        // WHERE clause from context-resolved filters + IN filters.
        let where_parts: Vec<String> = effective
            .iter()
            .map(|f| {
                let tbl = if f.table == fact_table {
                    fact_lower.clone()
                } else {
                    f.table.to_lowercase()
                };
                let op = f.operator.as_sql();
                let val = format_filter_value(&f.table, &f.column, &f.value, self.model);
                format!("{tbl}.\"{}\" {op} {val}", f.column)
            })
            .collect();
        let in_conditions = self
            .build_in_filter_sql(&ctx, &eval_ctx.in_filters, fact_table, &mut joined)
            .await?;

        let mut all_where = where_parts;
        all_where.extend(in_conditions);

        if !all_where.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&all_where.join(" AND "));
        }

        // GROUP BY
        if !group_parts.is_empty() {
            sql.push_str(" GROUP BY ");
            sql.push_str(&group_parts.join(", "));
        }

        let df = ctx.sql(&sql).await?;
        let batches = df.collect().await?;

        if batches.is_empty() {
            return Ok(RecordBatch::new_empty(arrow::datatypes::SchemaRef::new(
                arrow::datatypes::Schema::empty(),
            )));
        }

        let schema = batches[0].schema();
        let combined = concat_batches(&schema, &batches)?;
        Ok(combined)
    }

    /// Evaluate a scalar measure whose expression is a Block with Query bindings.
    ///
    /// Two-stage evaluation:
    /// 1. Materialize each QUERY binding as an intermediate RecordBatch
    /// 2. Evaluate the RETURN expression over the intermediate table(s)
    ///
    /// Supports KEEP/CLEAR on intermediate tables: filters that reference a
    /// binding name are applied as WHERE conditions on the intermediate table
    /// rather than being passed to `materialize_query`.
    async fn evaluate_query_block(
        &self,
        measure_name: &str,
        expr: &crate::compute::expression::Expression,
        fact_table: &str,
        outer_filters: &[ResolvedFilter],
    ) -> EngineResult<AggregateResult> {
        use crate::compute::expression::Expression;

        let Expression::Block {
            bindings,
            result: _,
        } = expr
        else {
            return Err(crate::error::EngineError::InvalidExpression(
                "Expected Block with Query bindings".into(),
            ));
        };

        let ctx = SessionContext::new();
        let mut query_binding_names: Vec<String> = Vec::new();
        let mut binding_schemas: std::collections::HashMap<String, arrow::datatypes::SchemaRef> =
            std::collections::HashMap::new();

        // Partition filters: separate intermediate table filters from source filters.
        let binding_name_set: std::collections::HashSet<String> = bindings
            .iter()
            .filter(|(_, e)| e.is_query())
            .map(|(name, _)| name.to_lowercase())
            .collect();
        let source_filters: Vec<ResolvedFilter> = outer_filters
            .iter()
            .filter(|f| !binding_name_set.contains(&f.table.to_lowercase()))
            .cloned()
            .collect();
        let intermediate_filters: Vec<&ResolvedFilter> = outer_filters
            .iter()
            .filter(|f| binding_name_set.contains(&f.table.to_lowercase()))
            .collect();

        // Step 1: Materialize each Query binding (using only source filters).
        for (name, binding_expr) in bindings {
            if let Expression::Query {
                aggregates,
                group_by,
            } = binding_expr
            {
                let batch = self
                    .materialize_query(aggregates, group_by, fact_table, &source_filters)
                    .await?;
                let schema = batch.schema();
                ctx.register_batch(&name.to_lowercase(), batch)?;
                binding_schemas.insert(name.to_lowercase(), schema);
                query_binding_names.push(name.clone());
            }
        }

        if query_binding_names.is_empty() {
            return Err(crate::error::EngineError::InvalidExpression(
                "Block has no Query bindings".into(),
            ));
        }

        // Step 2: Inline scalar bindings and evaluate the RETURN expression.
        let inlined = expr.inline_bindings();
        let result_sql = inlined.to_sql_string();
        let from_table = query_binding_names[0].to_lowercase();

        let mut sql = format!("SELECT {result_sql} AS \"{measure_name}\" FROM {from_table}");

        // Apply intermediate table filters as WHERE clause.
        let where_clause = build_intermediate_where(&intermediate_filters, &binding_schemas);
        if !where_clause.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&where_clause);
        }

        let df = ctx.sql(&sql).await?;
        let batches = df.collect().await?;
        let scalar = extract_scalar(&batches)?;

        Ok(AggregateResult {
            operation: crate::compute::aggregate::AggregateOp::Sum,
            column: measure_name.to_string(),
            value: scalar,
        })
    }

    /// Evaluate a grouped measure whose expression is a Block with Query bindings.
    ///
    /// The outer group-by columns are mapped to columns in the intermediate
    /// table produced by the QUERY binding. Supports KEEP/CLEAR on intermediate
    /// tables.
    async fn evaluate_query_block_grouped(
        &self,
        measure_name: &str,
        expr: &crate::compute::expression::Expression,
        fact_table: &str,
        group_by: &[TableColumn],
        outer_filters: &[ResolvedFilter],
    ) -> EngineResult<RecordBatch> {
        use crate::compute::expression::Expression;

        let Expression::Block {
            bindings,
            result: _,
        } = expr
        else {
            return Err(crate::error::EngineError::InvalidExpression(
                "Expected Block with Query bindings".into(),
            ));
        };

        let ctx = SessionContext::new();
        let mut query_binding_names: Vec<String> = Vec::new();
        let mut binding_schemas: std::collections::HashMap<String, arrow::datatypes::SchemaRef> =
            std::collections::HashMap::new();

        // Partition filters: separate intermediate table filters from source filters.
        let binding_name_set: std::collections::HashSet<String> = bindings
            .iter()
            .filter(|(_, e)| e.is_query())
            .map(|(name, _)| name.to_lowercase())
            .collect();
        let source_filters: Vec<ResolvedFilter> = outer_filters
            .iter()
            .filter(|f| !binding_name_set.contains(&f.table.to_lowercase()))
            .cloned()
            .collect();
        let intermediate_filters: Vec<&ResolvedFilter> = outer_filters
            .iter()
            .filter(|f| binding_name_set.contains(&f.table.to_lowercase()))
            .collect();

        // Step 1: Materialize each Query binding (using only source filters).
        // Inject outer group-by columns into the QUERY's own group-by so
        // the intermediate table carries dimension columns needed for the
        // final GROUP BY (DAX-style context propagation).
        for (name, binding_expr) in bindings {
            if let Expression::Query {
                aggregates,
                group_by: qgb,
            } = binding_expr
            {
                let mut augmented_gb = qgb.clone();
                for tc in group_by {
                    let already = augmented_gb.iter().any(|(t, c)| {
                        t.eq_ignore_ascii_case(&tc.table) && c.eq_ignore_ascii_case(&tc.column)
                    });
                    if !already {
                        augmented_gb.push((tc.table.clone(), tc.column.clone()));
                    }
                }

                let batch = self
                    .materialize_query(aggregates, &augmented_gb, fact_table, &source_filters)
                    .await?;
                let schema = batch.schema();
                ctx.register_batch(&name.to_lowercase(), batch)?;
                binding_schemas.insert(name.to_lowercase(), schema);
                query_binding_names.push(name.clone());
            }
        }

        if query_binding_names.is_empty() {
            return Err(crate::error::EngineError::InvalidExpression(
                "Block has no Query bindings".into(),
            ));
        }

        // Step 2: Build SQL over the intermediate table(s).
        let inlined = expr.inline_bindings();
        let result_sql = inlined.to_sql_string();
        let from_table = query_binding_names[0].to_lowercase();

        let mut select_parts: Vec<String> = Vec::new();
        let mut group_parts: Vec<String> = Vec::new();

        // Map outer group-by columns to the intermediate table.
        for tc in group_by {
            let qualified = format!("{from_table}.\"{}\"", tc.column);
            select_parts.push(qualified.clone());
            group_parts.push(qualified);
        }

        select_parts.push(format!("{result_sql} AS \"{measure_name}\""));

        let select_clause = select_parts.join(", ");
        let mut sql = format!("SELECT {select_clause} FROM {from_table}");

        // Apply intermediate table filters as WHERE clause.
        let where_clause = build_intermediate_where(&intermediate_filters, &binding_schemas);
        if !where_clause.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&where_clause);
        }

        if !group_parts.is_empty() {
            sql.push_str(" GROUP BY ");
            sql.push_str(&group_parts.join(", "));
        }

        let df = ctx.sql(&sql).await?;
        let batches = df.collect().await?;

        if batches.is_empty() {
            return Ok(RecordBatch::new_empty(arrow::datatypes::SchemaRef::new(
                arrow::datatypes::Schema::empty(),
            )));
        }

        let schema = batches[0].schema();
        let combined = concat_batches(&schema, &batches)?;
        Ok(combined)
    }

    /// Materialize a QUERY expression: execute the grouped aggregation and
    /// return the result as a RecordBatch.
    ///
    /// The output has columns for each group-by column plus each aggregate alias.
    async fn materialize_query(
        &self,
        aggregates: &[(crate::compute::expression::Expression, String)],
        group_by: &[(String, String)],
        fact_table: &str,
        outer_filters: &[ResolvedFilter],
    ) -> EngineResult<RecordBatch> {
        let ctx = SessionContext::new();
        let fact_lower = fact_table.to_lowercase();

        // Register fact table.
        let fact_batch = self.get_table_batch(fact_table).await?;
        ctx.register_batch(&fact_lower, fact_batch)?;

        // Collect dimension tables needed from group-by columns.
        let mut dim_tables: Vec<String> = Vec::new();
        for (table, _) in group_by {
            if table != fact_table && !dim_tables.contains(table) {
                dim_tables.push(table.clone());
            }
        }

        // Register dimension tables.
        for dim in &dim_tables {
            let dim_batch = self.get_table_batch(dim).await?;
            ctx.register_batch(&dim.to_lowercase(), dim_batch)?;
        }

        // Build SELECT: group-by columns + aggregate expressions.
        let mut select_parts: Vec<String> = Vec::new();
        let mut group_parts: Vec<String> = Vec::new();

        for (table, column) in group_by {
            let tbl = table.to_lowercase();
            let qualified = format!("{tbl}.\"{column}\"");
            select_parts.push(qualified.clone());
            group_parts.push(qualified);
        }

        // Resolve context on each aggregate expression.
        let resolver = ContextResolver::new(self.model);
        let mut extra_dim_tables: Vec<String> = Vec::new();

        for (agg_expr, alias) in aggregates {
            let (stripped, eval_ctx) = resolver.resolve(agg_expr)?;
            let effective = eval_ctx.effective_filters(outer_filters);

            if effective.is_empty() {
                let sql = stripped.to_sql_string();
                select_parts.push(format!("{sql} AS \"{alias}\""));
            } else {
                // Build CASE WHEN for per-aggregate context filters.
                let condition = self.build_where_clause(&effective, fact_table);
                let measure_table = &fact_lower;
                let sql = stripped.to_case_when_sql(&condition, measure_table);
                select_parts.push(format!("{sql} AS \"{alias}\""));

                // Track additional dimension tables needed for filter JOINs.
                for f in &effective {
                    if f.table != fact_table
                        && !dim_tables.contains(&f.table)
                        && !extra_dim_tables.contains(&f.table)
                    {
                        extra_dim_tables.push(f.table.clone());
                    }
                }
            }
        }

        // Register any extra dimension tables from context filters.
        for dim in &extra_dim_tables {
            let dim_batch = self.get_table_batch(dim).await?;
            ctx.register_batch(&dim.to_lowercase(), dim_batch)?;
        }

        let select_clause = select_parts.join(", ");
        let mut sql = format!("SELECT {select_clause} FROM {fact_lower}");

        // Add JOINs for all dimension tables.
        let all_dims: Vec<&String> = dim_tables.iter().chain(extra_dim_tables.iter()).collect();
        let mut joined = std::collections::HashSet::new();
        joined.insert(fact_lower.clone());

        for dim in all_dims {
            let dim_lower = dim.to_lowercase();
            if joined.contains(&dim_lower) {
                continue;
            }
            let rel = self.model.find_relationship(fact_table, dim)?;
            let left_is_from = rel.from_table() == fact_table;
            let on_clause = rel.build_on_clause(&fact_lower, &dim_lower, left_is_from);
            sql.push_str(&format!(" JOIN {dim_lower} ON {on_clause}"));
            joined.insert(dim_lower);
        }

        // GROUP BY clause.
        if !group_parts.is_empty() {
            sql.push_str(" GROUP BY ");
            sql.push_str(&group_parts.join(", "));
        }

        let df = ctx.sql(&sql).await?;
        let batches = df.collect().await?;

        if batches.is_empty() {
            return Ok(RecordBatch::new_empty(arrow::datatypes::SchemaRef::new(
                arrow::datatypes::Schema::empty(),
            )));
        }

        let schema = batches[0].schema();
        let combined = concat_batches(&schema, &batches)?;
        Ok(combined)
    }

    /// Evaluate multiple measures at once, returning scalar results.
    pub async fn evaluate_many(
        &self,
        measure_names: &[&str],
    ) -> EngineResult<Vec<AggregateResult>> {
        let mut results = Vec::with_capacity(measure_names.len());
        for name in measure_names {
            results.push(self.evaluate(name).await?);
        }
        Ok(results)
    }

    /// Build a WHERE clause from resolved filters.
    fn build_where_clause(&self, filters: &[ResolvedFilter], fact_table: &str) -> String {
        let conditions: Vec<String> = filters
            .iter()
            .map(|f| {
                let tbl = if f.table == fact_table {
                    "t".to_string()
                } else {
                    f.table.to_lowercase()
                };
                let op = f.operator.as_sql();
                let val = format_filter_value(&f.table, &f.column, &f.value, self.model);
                format!("{tbl}.\"{}\" {op} {val}", f.column)
            })
            .collect();
        conditions.join(" AND ")
    }

    /// Register dimension tables needed for cross-table filters.
    ///
    /// Returns a list of `(dim_table_lowercase, join_clause)` for each dimension
    /// table that needs to be joined.
    async fn register_cross_table_data(
        &self,
        session: &SessionContext,
        fact_table: &str,
        filters: &[ResolvedFilter],
    ) -> EngineResult<Vec<(String, String)>> {
        let mut joins = Vec::new();
        let mut registered = std::collections::HashSet::new();
        registered.insert(fact_table.to_string());

        for filter in filters {
            if filter.table == fact_table || registered.contains(&filter.table) {
                continue;
            }

            // Find relationship between fact table and filter's table.
            let rel = self.model.find_relationship(fact_table, &filter.table)?;
            let batch = self.get_table_batch(&filter.table).await?;
            let dim_lower = filter.table.to_lowercase();
            session.register_batch(&dim_lower, batch)?;

            let join_clause = rel.build_on_clause("t", &dim_lower, rel.from_table() == fact_table);
            joins.push((dim_lower.clone(), join_clause));
            registered.insert(filter.table.clone());
        }

        Ok(joins)
    }

    /// Register tables and build SQL conditions for IN-membership filters.
    ///
    /// Returns SQL condition strings like:
    /// `t."col" IN (SELECT var_tbl."var_col" FROM var_tbl WHERE ...)`
    async fn build_in_filter_sql(
        &self,
        session: &SessionContext,
        in_filters: &[ResolvedInFilter],
        fact_table: &str,
        registered: &mut std::collections::HashSet<String>,
    ) -> EngineResult<Vec<String>> {
        let mut conditions = Vec::new();

        for inf in in_filters {
            let var_lower = format!("var_{}", inf.var_base_table.to_lowercase());

            // Register the variable's base table if not already registered.
            if !registered.contains(&var_lower) {
                let batch = self.get_table_batch(&inf.var_base_table).await?;
                session.register_batch(&var_lower, batch)?;
                registered.insert(var_lower.clone());
            }

            // Build the subquery: SELECT var_tbl."col" FROM var_tbl WHERE <filters>
            let mut subquery =
                format!("SELECT {var_lower}.\"{}\" FROM {var_lower}", inf.var_column);

            if !inf.var_filters.is_empty() {
                let where_parts: Vec<String> = inf
                    .var_filters
                    .iter()
                    .map(|f| {
                        let op = f.operator.as_sql();
                        let val = format_filter_value(&f.table, &f.column, &f.value, self.model);
                        format!("{var_lower}.\"{}\" {op} {val}", f.column)
                    })
                    .collect();
                subquery.push_str(" WHERE ");
                subquery.push_str(&where_parts.join(" AND "));
            }

            // Build the IN condition referencing the fact table
            let fact_prefix = if fact_table == inf.table {
                "t".to_string()
            } else {
                inf.table.to_lowercase()
            };
            conditions.push(format!("{fact_prefix}.\"{}\" IN ({subquery})", inf.column));
        }

        Ok(conditions)
    }

    /// Get a RecordBatch for a table with calculated columns materialized.
    async fn get_table_batch(&self, table_name: &str) -> EngineResult<RecordBatch> {
        let table_data = self.store.table_data(table_name)?;
        let batch = table_data.to_record_batch()?;

        // Materialize any calculated columns for this table.
        let calc_cols: Vec<_> = self
            .model
            .calculated_columns_for_table(table_name)
            .into_iter()
            .cloned()
            .collect();

        if calc_cols.is_empty() {
            Ok(batch)
        } else {
            materialize_calculated_columns(&batch, &calc_cols).await
        }
    }
}

/// Extract a single scalar value from result batches.
/// Build a WHERE clause from filters targeting intermediate QUERY tables.
///
/// Uses the Arrow schema of each intermediate table to determine correct
/// value quoting (numeric types rendered bare, string types single-quoted).
fn build_intermediate_where(
    filters: &[&ResolvedFilter],
    schemas: &std::collections::HashMap<String, arrow::datatypes::SchemaRef>,
) -> String {
    let parts: Vec<String> = filters
        .iter()
        .map(|f| {
            let tbl = f.table.to_lowercase();
            let op = f.operator.as_sql();
            let val = format_intermediate_value(&tbl, &f.column, &f.value, schemas);
            format!("{tbl}.\"{}\" {op} {val}", f.column)
        })
        .collect();
    parts.join(" AND ")
}

/// Format a filter value for an intermediate table column.
///
/// Looks up the column's Arrow data type in the materialized schema to decide
/// whether the value needs SQL quoting. Falls back to quoting if the column
/// cannot be found (defensive).
fn format_intermediate_value(
    table: &str,
    column: &str,
    value: &str,
    schemas: &std::collections::HashMap<String, arrow::datatypes::SchemaRef>,
) -> String {
    let needs_quoting = schemas
        .get(table)
        .and_then(|schema| schema.field_with_name(column).ok())
        .map(|field| {
            use arrow::datatypes::DataType as ArrowDT;
            matches!(
                field.data_type(),
                ArrowDT::Utf8
                    | ArrowDT::LargeUtf8
                    | ArrowDT::Date32
                    | ArrowDT::Date64
                    | ArrowDT::Timestamp(_, _)
            )
        })
        .unwrap_or(true); // fallback: quote if unsure

    if needs_quoting {
        format!("'{}'", value.replace('\'', "''"))
    } else {
        value.to_string()
    }
}

fn extract_scalar(batches: &[RecordBatch]) -> EngineResult<ScalarValue> {
    if batches.is_empty() || batches[0].num_rows() == 0 {
        return Ok(ScalarValue::Null);
    }
    let col = batches[0].column(0);
    let scalar = ScalarValue::try_from_array(col, 0)?;
    Ok(scalar)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute::aggregate::AggregateOp;
    use crate::compute::expression::{self as expr, ComparisonOp, Expression};
    use crate::compute::measure::{
        count_measure, distinct_count_measure, expression_measure, sum_measure,
    };
    use crate::model::calculated_column::CalculatedColumn;
    use crate::model::column::Column;
    use crate::model::relationship::Relationship;
    use crate::model::table::Table;
    use crate::types::{DataType, Value};

    fn sales_table() -> Table {
        Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("product_id", DataType::Int64),
                Column::new("amount", DataType::Float64),
                Column::new("price", DataType::Float64),
                Column::new("quantity", DataType::Int64),
            ],
        )
        .unwrap()
    }

    fn products_table() -> Table {
        Table::new(
            "Products",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("name", DataType::String),
                Column::new("category", DataType::String),
            ],
        )
        .unwrap()
    }

    fn populated_store() -> ColumnStore {
        let mut store = ColumnStore::new();
        store.register_table(sales_table()).unwrap();
        store.register_table(products_table()).unwrap();

        store
            .insert_rows(
                "Sales",
                vec![
                    vec![
                        Value::Int64(1),
                        Value::Int64(101),
                        Value::Float64(50.0),
                        Value::Float64(10.0),
                        Value::Int64(5),
                    ],
                    vec![
                        Value::Int64(2),
                        Value::Int64(102),
                        Value::Float64(30.0),
                        Value::Float64(15.0),
                        Value::Int64(2),
                    ],
                    vec![
                        Value::Int64(3),
                        Value::Int64(101),
                        Value::Float64(20.0),
                        Value::Float64(20.0),
                        Value::Int64(1),
                    ],
                ],
            )
            .unwrap();

        store
            .insert_rows(
                "Products",
                vec![
                    vec![
                        Value::Int64(101),
                        Value::String("Widget".into()),
                        Value::String("A".into()),
                    ],
                    vec![
                        Value::Int64(102),
                        Value::String("Gadget".into()),
                        Value::String("B".into()),
                    ],
                ],
            )
            .unwrap();

        store
    }

    fn single_table_model() -> DataModel {
        DataModel::builder()
            .add_table(sales_table())
            .add_measure(sum_measure("TotalAmount", "Sales", "amount"))
            .add_measure(count_measure("OrderCount", "Sales", "id"))
            .add_measure(distinct_count_measure(
                "UniqueProducts",
                "Sales",
                "product_id",
            ))
            .add_measure(expression_measure(
                "Revenue",
                expr::agg(
                    AggregateOp::Sum,
                    expr::qualified_col("Sales", "price")
                        .multiply(expr::qualified_col("Sales", "quantity")),
                ),
            ))
            .add_measure(expression_measure(
                "AvgOrderValue",
                expr::agg(AggregateOp::Sum, expr::qualified_col("Sales", "amount"))
                    .divide(expr::agg(AggregateOp::Count, expr::qualified_col("Sales", "id"))),
            ))
            .build()
            .unwrap()
    }

    fn star_schema_model() -> DataModel {
        DataModel::builder()
            .add_table(sales_table())
            .add_table(products_table())
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

    #[tokio::test]
    async fn evaluate_sum_scalar() {
        let model = single_table_model();
        let store = populated_store();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("TotalAmount").await.unwrap();
        assert_eq!(result.as_f64(), Some(100.0)); // 50 + 30 + 20
    }

    #[tokio::test]
    async fn evaluate_count_scalar() {
        let model = single_table_model();
        let store = populated_store();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("OrderCount").await.unwrap();
        // COUNT returns Int64 or UInt64 depending on DataFusion version
        let count_val = match &result.value {
            ScalarValue::Int64(Some(n)) => *n,
            ScalarValue::UInt64(Some(n)) => *n as i64,
            other => panic!("Unexpected scalar type: {other:?}"),
        };
        assert_eq!(count_val, 3);
    }

    #[tokio::test]
    async fn evaluate_distinct_count_scalar() {
        let model = single_table_model();
        let store = populated_store();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("UniqueProducts").await.unwrap();
        let count_val = match &result.value {
            ScalarValue::Int64(Some(n)) => *n,
            ScalarValue::UInt64(Some(n)) => *n as i64,
            other => panic!("Unexpected scalar type: {other:?}"),
        };
        assert_eq!(count_val, 2); // product_id 101, 102
    }

    #[tokio::test]
    async fn evaluate_expression_measure() {
        let model = single_table_model();
        let store = populated_store();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("Revenue").await.unwrap();
        // SUM(price * quantity) = (10*5) + (15*2) + (20*1) = 50 + 30 + 20 = 100
        assert_eq!(result.as_f64(), Some(100.0));
    }

    #[tokio::test]
    async fn evaluate_ratio_measure() {
        let model = single_table_model();
        let store = populated_store();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("AvgOrderValue").await.unwrap();
        // SUM(amount) / COUNT(id) = 100.0 / 3 ≈ 33.33
        let val = result.as_f64().unwrap();
        assert!((val - 100.0 / 3.0).abs() < 0.01);
    }

    #[tokio::test]
    async fn evaluate_grouped_same_table() {
        let model = single_table_model();
        let store = populated_store();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine
            .evaluate_grouped("TotalAmount", &[TableColumn::new("Sales", "product_id")])
            .await
            .unwrap();

        // Two groups: product_id 101 (50+20=70), product_id 102 (30)
        assert_eq!(result.num_columns(), 2);
        assert_eq!(result.num_rows(), 2);
    }

    #[tokio::test]
    async fn evaluate_grouped_star_schema() {
        let model = star_schema_model();
        let store = populated_store();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine
            .evaluate_grouped("TotalAmount", &[TableColumn::new("Products", "category")])
            .await
            .unwrap();

        // Category A: product 101 → 50+20=70, Category B: product 102 → 30
        assert_eq!(result.num_columns(), 2);
        assert_eq!(result.num_rows(), 2);
    }

    #[tokio::test]
    async fn evaluate_many_measures() {
        let model = single_table_model();
        let store = populated_store();
        let engine = MeasureEngine::new(&model, &store);

        let results = engine
            .evaluate_many(&["TotalAmount", "OrderCount"])
            .await
            .unwrap();

        assert_eq!(results.len(), 2);
        assert_eq!(results[0].as_f64(), Some(100.0));
    }

    #[tokio::test]
    async fn evaluate_nonexistent_measure_errors() {
        let model = single_table_model();
        let store = populated_store();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("NonExistent").await;
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("NonExistent"));
    }

    #[tokio::test]
    async fn evaluate_table_not_in_store_errors() {
        let model = DataModel::builder()
            .add_table(Table::new("Missing", vec![Column::new("x", DataType::Float64)]).unwrap())
            .add_measure(sum_measure("Total", "Missing", "x"))
            .build()
            .unwrap();

        let store = ColumnStore::new(); // empty
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("Total").await;
        assert!(result.is_err());
    }

    // --- Context-aware evaluation tests ---

    fn store_with_regions() -> ColumnStore {
        let mut store = ColumnStore::new();
        let sales = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("product_id", DataType::Int64),
                Column::new("amount", DataType::Float64),
                Column::new("region", DataType::String),
            ],
        )
        .unwrap();
        store.register_table(sales).unwrap();
        store.register_table(products_table()).unwrap();

        store
            .insert_rows(
                "Sales",
                vec![
                    vec![
                        Value::Int64(1),
                        Value::Int64(101),
                        Value::Float64(50.0),
                        Value::String("US".into()),
                    ],
                    vec![
                        Value::Int64(2),
                        Value::Int64(102),
                        Value::Float64(30.0),
                        Value::String("EU".into()),
                    ],
                    vec![
                        Value::Int64(3),
                        Value::Int64(101),
                        Value::Float64(20.0),
                        Value::String("US".into()),
                    ],
                ],
            )
            .unwrap();

        store
            .insert_rows(
                "Products",
                vec![
                    vec![
                        Value::Int64(101),
                        Value::String("Widget".into()),
                        Value::String("A".into()),
                    ],
                    vec![
                        Value::Int64(102),
                        Value::String("Gadget".into()),
                        Value::String("B".into()),
                    ],
                ],
            )
            .unwrap();

        store
    }

    fn context_aware_model() -> DataModel {
        use crate::compute::expression::{ComparisonOp, FilterPredicate};
        use crate::model::context::{ContextDefinition, ContextOp};

        let sales = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("product_id", DataType::Int64),
                Column::new("amount", DataType::Float64),
                Column::new("region", DataType::String),
            ],
        )
        .unwrap();

        DataModel::builder()
            .add_table(sales)
            .add_table(products_table())
            .add_relationship(Relationship::many_to_one(
                "Sales_Products",
                "Sales",
                "product_id",
                "Products",
                "id",
            ))
            // Measure with keep(): sum only US
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
            // Measure with reset(): always total
            .add_measure(expression_measure(
                "TotalAll",
                expr::agg(AggregateOp::Sum, expr::reset(expr::qualified_col("Sales", "amount"))),
            ))
            // Plain measure for comparison
            .add_measure(sum_measure("Revenue", "Sales", "amount"))
            // Measure with cross-table keep
            .add_measure(expression_measure(
                "CategoryA_Revenue",
                expr::agg(
                    AggregateOp::Sum,
                    expr::keep(
                        expr::qualified_col("Sales", "amount"),
                        vec![FilterPredicate::new(
                            "Products",
                            "category",
                            ComparisonOp::Equal,
                            "A",
                        )],
                    ),
                ),
            ))
            // Named context measure
            .add_context(ContextDefinition::new(
                "ctx_us",
                vec![ContextOp::Keep(vec![FilterPredicate::new(
                    "Sales",
                    "region",
                    ComparisonOp::Equal,
                    "US",
                )])],
            ))
            .add_measure(expression_measure(
                "US_Revenue_Via_Context",
                expr::agg(AggregateOp::Sum, expr::using(expr::qualified_col("Sales", "amount"), "ctx_us")),
            ))
            .build()
            .unwrap()
    }

    #[tokio::test]
    async fn evaluate_measure_with_keep_filter() {
        let model = context_aware_model();
        let store = store_with_regions();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("US_Revenue").await.unwrap();
        // Only US rows: 50 + 20 = 70
        assert_eq!(result.as_f64(), Some(70.0));
    }

    #[tokio::test]
    async fn evaluate_measure_with_reset_ignores_outer() {
        use crate::compute::expression::ComparisonOp;
        let model = context_aware_model();
        let store = store_with_regions();
        let engine = MeasureEngine::new(&model, &store);

        // Evaluate with outer filter (region=EU)
        let outer = vec![ResolvedFilter::new(
            "Sales",
            "region",
            ComparisonOp::Equal,
            "EU",
        )];

        // TotalAll has reset() — should ignore outer filter
        let result = engine
            .evaluate_with_outer_filters("TotalAll", &outer)
            .await
            .unwrap();
        assert_eq!(result.as_f64(), Some(100.0)); // All rows: 50+30+20

        // Revenue (no reset) — should respect outer filter
        let result = engine
            .evaluate_with_outer_filters("Revenue", &outer)
            .await
            .unwrap();
        assert_eq!(result.as_f64(), Some(30.0)); // Only EU: 30
    }

    #[tokio::test]
    async fn evaluate_measure_with_cross_table_filter() {
        let model = context_aware_model();
        let store = store_with_regions();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("CategoryA_Revenue").await.unwrap();
        // Category A = product 101 → Sales rows with product_id=101: 50+20=70
        assert_eq!(result.as_f64(), Some(70.0));
    }

    #[tokio::test]
    async fn evaluate_measure_with_named_context() {
        let model = context_aware_model();
        let store = store_with_regions();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("US_Revenue_Via_Context").await.unwrap();
        // ctx_us applies region=US filter → 50+20=70
        assert_eq!(result.as_f64(), Some(70.0));
    }

    #[tokio::test]
    async fn evaluate_with_in_filter() {
        use crate::compute::expression::{ComparisonOp, FilterPredicate, InPredicate};
        use crate::model::table_variable::TableVariable;

        // Products: 101=Widget(A), 102=Gadget(B)
        // Sales: row1(product_id=101, amount=50), row2(product_id=102, amount=30),
        //        row3(product_id=101, amount=20)
        // Variable "premium" = Products WHERE category = "A" → only product 101
        // Measure: SUM(keep_in(amount, Sales.product_id IN premium.id))
        // Expected: 50 + 20 = 70 (only sales for product 101)

        let model = DataModel::builder()
            .add_table(sales_table())
            .add_table(products_table())
            .add_relationship(Relationship::many_to_one(
                "Sales_Products",
                "Sales",
                "product_id",
                "Products",
                "id",
            ))
            .add_table_variable(TableVariable::new(
                "premium",
                "Products",
                vec![FilterPredicate::new(
                    "Products",
                    "category",
                    ComparisonOp::Equal,
                    "A",
                )],
            ))
            .add_measure(crate::compute::measure::Measure::new(
                "PremiumRevenue",
                expr::agg(
                    AggregateOp::Sum,
                    expr::keep_in(
                        expr::qualified_col("Sales", "amount"),
                        vec![InPredicate::new("Sales", "product_id", "premium", "id")],
                    ),
                ),
            ))
            .build()
            .unwrap();

        let store = populated_store();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("PremiumRevenue").await.unwrap();
        assert_eq!(result.as_f64(), Some(70.0));
    }

    #[tokio::test]
    async fn evaluate_in_filter_with_composed_variable() {
        use crate::compute::expression::{ComparisonOp, FilterPredicate, InPredicate};
        use crate::model::table_variable::TableVariable;

        // "premium" = Products WHERE category = "A" → product 101 (Widget)
        // "named_premium" = premium WHERE name != "" → still product 101
        // Measure: SUM(keep_in(amount, Sales.product_id IN named_premium.id))
        // Expected: 50 + 20 = 70

        let model = DataModel::builder()
            .add_table(sales_table())
            .add_table(products_table())
            .add_relationship(Relationship::many_to_one(
                "Sales_Products",
                "Sales",
                "product_id",
                "Products",
                "id",
            ))
            .add_table_variable(TableVariable::new(
                "premium",
                "Products",
                vec![FilterPredicate::new(
                    "Products",
                    "category",
                    ComparisonOp::Equal,
                    "A",
                )],
            ))
            .add_table_variable(TableVariable::new(
                "named_premium",
                "premium",
                vec![FilterPredicate::new(
                    "Products",
                    "name",
                    ComparisonOp::NotEqual,
                    "",
                )],
            ))
            .add_measure(crate::compute::measure::Measure::new(
                "NamedPremiumRevenue",
                expr::agg(
                    AggregateOp::Sum,
                    expr::keep_in(
                        expr::qualified_col("Sales", "amount"),
                        vec![InPredicate::new(
                            "Sales",
                            "product_id",
                            "named_premium",
                            "id",
                        )],
                    ),
                ),
            ))
            .build()
            .unwrap();

        let store = populated_store();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("NamedPremiumRevenue").await.unwrap();
        assert_eq!(result.as_f64(), Some(70.0));
    }

    #[tokio::test]
    async fn evaluate_with_calculated_column() {
        let model = DataModel::builder()
            .add_table(sales_table())
            .add_calculated_column(CalculatedColumn::new(
                "line_total",
                "Sales",
                expr::col("price").multiply(expr::col("quantity")),
                DataType::Float64,
            ))
            .add_measure(sum_measure("TotalRevenue", "Sales", "line_total"))
            .build()
            .unwrap();

        let store = populated_store();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("TotalRevenue").await.unwrap();
        // SUM(price*quantity) = 50 + 30 + 20 = 100
        assert_eq!(result.as_f64(), Some(100.0));
    }

    // --- QUERY-in-VAR tests ---

    fn query_test_store() -> ColumnStore {
        let mut store = ColumnStore::new();

        let orders = Table::new(
            "Orders",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("product_id", DataType::Int64),
                Column::new("amount", DataType::Float64),
                Column::new("month", DataType::Int64),
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

        store.register_table(orders).unwrap();
        store.register_table(products).unwrap();

        // 6 orders across 3 months and 2 products
        store
            .insert_rows(
                "Orders",
                vec![
                    // Month 1: product 1 = 100, product 2 = 50
                    vec![
                        Value::Int64(1),
                        Value::Int64(1),
                        Value::Float64(100.0),
                        Value::Int64(1),
                    ],
                    vec![
                        Value::Int64(2),
                        Value::Int64(2),
                        Value::Float64(50.0),
                        Value::Int64(1),
                    ],
                    // Month 2: product 1 = 200, product 2 = 80
                    vec![
                        Value::Int64(3),
                        Value::Int64(1),
                        Value::Float64(200.0),
                        Value::Int64(2),
                    ],
                    vec![
                        Value::Int64(4),
                        Value::Int64(2),
                        Value::Float64(80.0),
                        Value::Int64(2),
                    ],
                    // Month 3: product 1 = 150, product 2 = 70
                    vec![
                        Value::Int64(5),
                        Value::Int64(1),
                        Value::Float64(150.0),
                        Value::Int64(3),
                    ],
                    vec![
                        Value::Int64(6),
                        Value::Int64(2),
                        Value::Float64(70.0),
                        Value::Int64(3),
                    ],
                ],
            )
            .unwrap();

        store
            .insert_rows(
                "Products",
                vec![
                    vec![Value::Int64(1), Value::String("A".into())],
                    vec![Value::Int64(2), Value::String("B".into())],
                ],
            )
            .unwrap();

        store
    }

    #[tokio::test]
    async fn evaluate_query_in_var_avg_of_monthly_sums() {
        // VAR monthly = QUERY(SUM(Orders[amount]) AS revenue BY Orders[month])
        // RETURN AVG(monthly[revenue])
        //
        // Monthly sums: month1=150, month2=280, month3=220
        // AVG = 650/3 ≈ 216.667

        let model = DataModel::builder()
            .add_table(
                Table::new(
                    "Orders",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("product_id", DataType::Int64),
                        Column::new("amount", DataType::Float64),
                        Column::new("month", DataType::Int64),
                    ],
                )
                .unwrap(),
            )
            .add_measure(expression_measure(
                "AvgMonthlyRevenue",
                Expression::Block {
                    bindings: vec![(
                        "monthly".to_string(),
                        Expression::Query {
                            aggregates: vec![(
                                expr::agg(AggregateOp::Sum, expr::qualified_col("Orders", "amount")),
                                "revenue".to_string(),
                            )],
                            group_by: vec![("Orders".to_string(), "month".to_string())],
                        },
                    )],
                    result: Box::new(expr::agg(
                        AggregateOp::Average,
                        Expression::QualifiedColumnRef {
                            table_or_var: "monthly".to_string(),
                            column: "revenue".to_string(),
                        },
                    )),
                },
            ))
            .build()
            .unwrap();

        let store = query_test_store();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("AvgMonthlyRevenue").await.unwrap();
        let val = result.as_f64().unwrap();
        // AVG(150, 280, 220) = 650/3 ≈ 216.667
        assert!((val - 650.0 / 3.0).abs() < 0.01);
    }

    #[tokio::test]
    async fn evaluate_query_in_var_max_of_monthly_sums() {
        // VAR monthly = QUERY(SUM(Orders[amount]) AS revenue BY Orders[month])
        // RETURN MAX(monthly[revenue])
        //
        // Monthly sums: month1=150, month2=280, month3=220
        // MAX = 280

        let model = DataModel::builder()
            .add_table(
                Table::new(
                    "Orders",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("product_id", DataType::Int64),
                        Column::new("amount", DataType::Float64),
                        Column::new("month", DataType::Int64),
                    ],
                )
                .unwrap(),
            )
            .add_measure(expression_measure(
                "MaxMonthlyRevenue",
                Expression::Block {
                    bindings: vec![(
                        "monthly".to_string(),
                        Expression::Query {
                            aggregates: vec![(
                                expr::agg(AggregateOp::Sum, expr::qualified_col("Orders", "amount")),
                                "revenue".to_string(),
                            )],
                            group_by: vec![("Orders".to_string(), "month".to_string())],
                        },
                    )],
                    result: Box::new(expr::agg(
                        AggregateOp::Max,
                        Expression::QualifiedColumnRef {
                            table_or_var: "monthly".to_string(),
                            column: "revenue".to_string(),
                        },
                    )),
                },
            ))
            .build()
            .unwrap();

        let store = query_test_store();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("MaxMonthlyRevenue").await.unwrap();
        assert_eq!(result.as_f64(), Some(280.0));
    }

    #[tokio::test]
    async fn evaluate_query_in_var_with_cross_table_group_by() {
        // VAR by_category = QUERY(SUM(Orders[amount]) AS revenue BY Products[category])
        // RETURN MAX(by_category[revenue])
        //
        // Category A (product 1): 100+200+150 = 450
        // Category B (product 2): 50+80+70 = 200
        // MAX = 450

        use crate::model::relationship::Relationship;

        let model = DataModel::builder()
            .add_table(
                Table::new(
                    "Orders",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("product_id", DataType::Int64),
                        Column::new("amount", DataType::Float64),
                        Column::new("month", DataType::Int64),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "Products",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("category", DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_relationship(Relationship::many_to_one(
                "Orders_Products",
                "Orders",
                "product_id",
                "Products",
                "id",
            ))
            .add_measure(expression_measure(
                "MaxCategoryRevenue",
                Expression::Block {
                    bindings: vec![(
                        "by_cat".to_string(),
                        Expression::Query {
                            aggregates: vec![(
                                expr::agg(AggregateOp::Sum, expr::qualified_col("Orders", "amount")),
                                "revenue".to_string(),
                            )],
                            group_by: vec![("Products".to_string(), "category".to_string())],
                        },
                    )],
                    result: Box::new(expr::agg(
                        AggregateOp::Max,
                        Expression::QualifiedColumnRef {
                            table_or_var: "by_cat".to_string(),
                            column: "revenue".to_string(),
                        },
                    )),
                },
            ))
            .build()
            .unwrap();

        let store = query_test_store();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("MaxCategoryRevenue").await.unwrap();
        assert_eq!(result.as_f64(), Some(450.0));
    }

    #[tokio::test]
    async fn evaluate_query_in_var_grouped_output() {
        // VAR monthly = QUERY(SUM(Orders[amount]) AS revenue BY Orders[month])
        // RETURN AVG(monthly[revenue])
        // Grouped by Orders[month] should return each month's sum (since
        // each group has 1 row in the intermediate table).
        //
        // But this test groups the RETURN by Orders[month], which maps to
        // the "month" column in the intermediate "monthly" table.
        // month1: AVG(150)=150, month2: AVG(280)=280, month3: AVG(220)=220

        let model = DataModel::builder()
            .add_table(
                Table::new(
                    "Orders",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("product_id", DataType::Int64),
                        Column::new("amount", DataType::Float64),
                        Column::new("month", DataType::Int64),
                    ],
                )
                .unwrap(),
            )
            .add_measure(expression_measure(
                "AvgMonthlyRevenue",
                Expression::Block {
                    bindings: vec![(
                        "monthly".to_string(),
                        Expression::Query {
                            aggregates: vec![(
                                expr::agg(AggregateOp::Sum, expr::qualified_col("Orders", "amount")),
                                "revenue".to_string(),
                            )],
                            group_by: vec![("Orders".to_string(), "month".to_string())],
                        },
                    )],
                    result: Box::new(expr::agg(
                        AggregateOp::Average,
                        Expression::QualifiedColumnRef {
                            table_or_var: "monthly".to_string(),
                            column: "revenue".to_string(),
                        },
                    )),
                },
            ))
            .build()
            .unwrap();

        let store = query_test_store();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine
            .evaluate_grouped("AvgMonthlyRevenue", &[TableColumn::new("Orders", "month")])
            .await
            .unwrap();

        // 3 groups, each with a single intermediate row → AVG = the sum itself
        assert_eq!(result.num_rows(), 3);
        assert_eq!(result.num_columns(), 2); // month + AvgMonthlyRevenue
    }

    #[tokio::test]
    async fn evaluate_query_in_var_count_of_groups() {
        // VAR monthly = QUERY(SUM(Orders[amount]) AS revenue BY Orders[month])
        // RETURN COUNTROWS(monthly)
        //
        // 3 months → COUNTROWS = 3

        let model = DataModel::builder()
            .add_table(
                Table::new(
                    "Orders",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("product_id", DataType::Int64),
                        Column::new("amount", DataType::Float64),
                        Column::new("month", DataType::Int64),
                    ],
                )
                .unwrap(),
            )
            .add_measure(expression_measure(
                "MonthCount",
                Expression::Block {
                    bindings: vec![(
                        "monthly".to_string(),
                        Expression::Query {
                            aggregates: vec![(
                                expr::agg(AggregateOp::Sum, expr::qualified_col("Orders", "amount")),
                                "revenue".to_string(),
                            )],
                            group_by: vec![("Orders".to_string(), "month".to_string())],
                        },
                    )],
                    result: Box::new(expr::agg(
                        AggregateOp::CountRows,
                        Expression::TableRef("monthly".to_string()),
                    )),
                },
            ))
            .build()
            .unwrap();

        let store = query_test_store();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("MonthCount").await.unwrap();
        let count = match &result.value {
            ScalarValue::Int64(Some(n)) => *n,
            ScalarValue::UInt64(Some(n)) => *n as i64,
            other => panic!("Unexpected scalar type: {other:?}"),
        };
        assert_eq!(count, 3);
    }

    // --- KEEP/CLEAR on intermediate tables tests ---

    #[tokio::test]
    async fn evaluate_query_in_var_keep_on_intermediate_table() {
        // VAR monthly = QUERY(SUM(Orders[amount]) AS revenue BY Orders[month])
        // RETURN SUM(monthly[revenue], KEEP(monthly[month] = 2))
        //
        // Monthly sums: month1=150, month2=280, month3=220
        // KEEP(month=2) → only month2 row → SUM = 280
        use crate::compute::expression::FilterPredicate;

        let model = DataModel::builder()
            .add_table(
                Table::new(
                    "Orders",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("product_id", DataType::Int64),
                        Column::new("amount", DataType::Float64),
                        Column::new("month", DataType::Int64),
                    ],
                )
                .unwrap(),
            )
            .add_measure(expression_measure(
                "Month2Revenue",
                Expression::Block {
                    bindings: vec![(
                        "monthly".to_string(),
                        Expression::Query {
                            aggregates: vec![(
                                expr::agg(AggregateOp::Sum, expr::qualified_col("Orders", "amount")),
                                "revenue".to_string(),
                            )],
                            group_by: vec![("Orders".to_string(), "month".to_string())],
                        },
                    )],
                    result: Box::new(expr::agg(
                        AggregateOp::Sum,
                        expr::keep(
                            Expression::QualifiedColumnRef {
                                table_or_var: "monthly".to_string(),
                                column: "revenue".to_string(),
                            },
                            vec![FilterPredicate::new(
                                "monthly",
                                "month",
                                ComparisonOp::Equal,
                                "2",
                            )],
                        ),
                    )),
                },
            ))
            .build()
            .unwrap();

        let store = query_test_store();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("Month2Revenue").await.unwrap();
        assert_eq!(result.as_f64(), Some(280.0));
    }

    #[tokio::test]
    async fn evaluate_query_in_var_keep_multiple_filters() {
        // VAR by_month_product = QUERY(SUM(Orders[amount]) AS revenue
        //                              BY Orders[month], Orders[product_id])
        // RETURN SUM(by_month_product[revenue],
        //            KEEP(by_month_product[month] = 1, by_month_product[product_id] = 1))
        //
        // Data: month=1, product=1 → amount=100
        // KEEP(month=1 AND product_id=1) → only that row → SUM = 100
        use crate::compute::expression::FilterPredicate;

        let model = DataModel::builder()
            .add_table(
                Table::new(
                    "Orders",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("product_id", DataType::Int64),
                        Column::new("amount", DataType::Float64),
                        Column::new("month", DataType::Int64),
                    ],
                )
                .unwrap(),
            )
            .add_measure(expression_measure(
                "SingleCell",
                Expression::Block {
                    bindings: vec![(
                        "detail".to_string(),
                        Expression::Query {
                            aggregates: vec![(
                                expr::agg(AggregateOp::Sum, expr::qualified_col("Orders", "amount")),
                                "revenue".to_string(),
                            )],
                            group_by: vec![
                                ("Orders".to_string(), "month".to_string()),
                                ("Orders".to_string(), "product_id".to_string()),
                            ],
                        },
                    )],
                    result: Box::new(expr::agg(
                        AggregateOp::Sum,
                        expr::keep(
                            Expression::QualifiedColumnRef {
                                table_or_var: "detail".to_string(),
                                column: "revenue".to_string(),
                            },
                            vec![
                                FilterPredicate::new("detail", "month", ComparisonOp::Equal, "1"),
                                FilterPredicate::new(
                                    "detail",
                                    "product_id",
                                    ComparisonOp::Equal,
                                    "1",
                                ),
                            ],
                        ),
                    )),
                },
            ))
            .build()
            .unwrap();

        let store = query_test_store();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("SingleCell").await.unwrap();
        assert_eq!(result.as_f64(), Some(100.0));
    }

    #[tokio::test]
    async fn evaluate_query_in_var_keep_grouped() {
        // VAR monthly = QUERY(SUM(Orders[amount]) AS revenue BY Orders[month])
        // RETURN SUM(monthly[revenue], KEEP(monthly[month] >= 2))
        // Grouped by Orders[month]
        //
        // Intermediate: month1=150, month2=280, month3=220
        // KEEP(month >= 2) → month2=280, month3=220
        // Grouped by month: each row has 1 value → SUM = that value
        // Result: 2 rows (month2=280, month3=220)
        use crate::compute::expression::FilterPredicate;

        let model = DataModel::builder()
            .add_table(
                Table::new(
                    "Orders",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("product_id", DataType::Int64),
                        Column::new("amount", DataType::Float64),
                        Column::new("month", DataType::Int64),
                    ],
                )
                .unwrap(),
            )
            .add_measure(expression_measure(
                "FilteredRevenue",
                Expression::Block {
                    bindings: vec![(
                        "monthly".to_string(),
                        Expression::Query {
                            aggregates: vec![(
                                expr::agg(AggregateOp::Sum, expr::qualified_col("Orders", "amount")),
                                "revenue".to_string(),
                            )],
                            group_by: vec![("Orders".to_string(), "month".to_string())],
                        },
                    )],
                    result: Box::new(expr::agg(
                        AggregateOp::Sum,
                        expr::keep(
                            Expression::QualifiedColumnRef {
                                table_or_var: "monthly".to_string(),
                                column: "revenue".to_string(),
                            },
                            vec![FilterPredicate::new(
                                "monthly",
                                "month",
                                ComparisonOp::GreaterThanOrEqual,
                                "2",
                            )],
                        ),
                    )),
                },
            ))
            .build()
            .unwrap();

        let store = query_test_store();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine
            .evaluate_grouped("FilteredRevenue", &[TableColumn::new("Orders", "month")])
            .await
            .unwrap();

        // KEEP(month >= 2) filters intermediate to 2 rows
        assert_eq!(result.num_rows(), 2);
    }

    #[tokio::test]
    async fn evaluate_query_in_var_keep_scalar_sum() {
        // VAR monthly = QUERY(SUM(Orders[amount]) AS revenue BY Orders[month])
        // RETURN SUM(monthly[revenue], KEEP(monthly[month] >= 2))
        //
        // Intermediate: month1=150, month2=280, month3=220
        // KEEP(month >= 2) → month2+month3 = 500
        use crate::compute::expression::FilterPredicate;

        let model = DataModel::builder()
            .add_table(
                Table::new(
                    "Orders",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("product_id", DataType::Int64),
                        Column::new("amount", DataType::Float64),
                        Column::new("month", DataType::Int64),
                    ],
                )
                .unwrap(),
            )
            .add_measure(expression_measure(
                "RecentRevenue",
                Expression::Block {
                    bindings: vec![(
                        "monthly".to_string(),
                        Expression::Query {
                            aggregates: vec![(
                                expr::agg(AggregateOp::Sum, expr::qualified_col("Orders", "amount")),
                                "revenue".to_string(),
                            )],
                            group_by: vec![("Orders".to_string(), "month".to_string())],
                        },
                    )],
                    result: Box::new(expr::agg(
                        AggregateOp::Sum,
                        expr::keep(
                            Expression::QualifiedColumnRef {
                                table_or_var: "monthly".to_string(),
                                column: "revenue".to_string(),
                            },
                            vec![FilterPredicate::new(
                                "monthly",
                                "month",
                                ComparisonOp::GreaterThanOrEqual,
                                "2",
                            )],
                        ),
                    )),
                },
            ))
            .build()
            .unwrap();

        let store = query_test_store();
        let engine = MeasureEngine::new(&model, &store);

        let result = engine.evaluate("RecentRevenue").await.unwrap();
        // month2 (280) + month3 (220) = 500
        assert_eq!(result.as_f64(), Some(500.0));
    }
}
