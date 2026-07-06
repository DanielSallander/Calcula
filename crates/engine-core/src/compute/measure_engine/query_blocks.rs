//! Two-stage evaluation of measures with QUERY-in-VAR bindings: each QUERY
//! binding is materialized as an intermediate RecordBatch, then the RETURN
//! expression is evaluated over the intermediate table(s).

use arrow::compute::concat_batches;
use arrow::record_batch::RecordBatch;

use crate::compute::aggregate::AggregateResult;
use crate::compute::context::{ContextResolver, EvaluationContext, ResolvedFilter};
use crate::compute::sql_util::{quote_ident_double, sql_quote_literal};
use crate::error::EngineResult;
use crate::types::TableColumn;

use super::sql::extract_scalar;
use super::MeasureEngine;

impl<'a> MeasureEngine<'a> {
    /// Evaluate a scalar measure whose expression is a Block with Query bindings.
    ///
    /// Two-stage evaluation:
    /// 1. Materialize each QUERY binding as an intermediate RecordBatch
    /// 2. Evaluate the RETURN expression over the intermediate table(s)
    ///
    /// Supports KEEP/CLEAR on intermediate tables: filters that reference a
    /// binding name are applied as WHERE conditions on the intermediate table
    /// rather than being passed to `materialize_query`.
    pub(super) async fn evaluate_query_block(
        &self,
        measure_name: &str,
        expr: &crate::compute::expression::Expression,
        fact_table: &str,
        outer_filters: &[ResolvedFilter],
    ) -> EngineResult<AggregateResult> {
        use crate::compute::expression::Expression;

        let Expression::Block { bindings, .. } = expr else {
            return Err(crate::error::EngineError::InvalidExpression(
                "Expected Block with Query bindings".into(),
            ));
        };

        let ctx = self.session_context();
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
                    .materialize_query(aggregates, group_by, fact_table, &source_filters, &[])
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
        let result_sql = inlined.to_sql_string()?;
        let from_table = query_binding_names[0].to_lowercase();

        let mut sql = format!(
            "SELECT {result_sql} AS {} FROM {from_table}",
            quote_ident_double(measure_name)
        );

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
    pub(super) async fn evaluate_query_block_grouped(
        &self,
        measure_name: &str,
        expr: &crate::compute::expression::Expression,
        fact_table: &str,
        group_by: &[TableColumn],
        outer_filters: &[ResolvedFilter],
    ) -> EngineResult<RecordBatch> {
        use crate::compute::expression::Expression;

        let Expression::Block { bindings, .. } = expr else {
            return Err(crate::error::EngineError::InvalidExpression(
                "Expected Block with Query bindings".into(),
            ));
        };

        let ctx = self.session_context();
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
                    .materialize_query(aggregates, &augmented_gb, fact_table, &source_filters, &[])
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
        let result_sql = inlined.to_sql_string()?;
        let from_table = query_binding_names[0].to_lowercase();

        let mut select_parts: Vec<String> = Vec::new();
        let mut group_parts: Vec<String> = Vec::new();

        // Map outer group-by columns to the intermediate table.
        for tc in group_by {
            let qualified = format!("{from_table}.{}", quote_ident_double(&tc.column));
            select_parts.push(qualified.clone());
            group_parts.push(qualified);
        }

        select_parts.push(format!(
            "{result_sql} AS {}",
            quote_ident_double(measure_name)
        ));

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
        relationship_overrides: &[String],
    ) -> EngineResult<RecordBatch> {
        let ctx = self.session_context();
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
            let qualified = format!("{tbl}.{}", quote_ident_double(column));
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
                let sql = stripped.to_sql_string()?;
                select_parts.push(format!("{sql} AS {}", quote_ident_double(alias)));
            } else {
                // Build CASE WHEN for per-aggregate context filters.
                let condition = self.build_where_clause(&effective, fact_table);
                let measure_table = &fact_lower;
                let sql = stripped.to_case_when_sql(&condition, measure_table)?;
                select_parts.push(format!("{sql} AS {}", quote_ident_double(alias)));

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
            // Use relationship overrides if available.
            let resolve_ctx = EvaluationContext {
                relationship_overrides: relationship_overrides.to_vec(),
                ..Default::default()
            };
            let rel = resolve_ctx.resolve_relationship(self.model, fact_table, dim)?;
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
            format!("{tbl}.{} {op} {val}", quote_ident_double(&f.column))
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
        sql_quote_literal(value)
    } else {
        value.to_string()
    }
}
