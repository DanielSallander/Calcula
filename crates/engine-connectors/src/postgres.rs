//! PostgreSQL connector using `sqlx` with connection pooling.

use std::sync::atomic::{AtomicU64, Ordering};

use arrow::datatypes::{Field, Schema};
use arrow::record_batch::RecordBatch;
use engine_core::model::{Column, Table};
use sqlx::postgres::PgPoolOptions;
use sqlx::{Column as SqlxColumn, Executor, PgPool, Row};

use crate::arrow_convert::rows_to_record_batches;
use crate::auth::{AuthMethod, AuthMethodKind, ConnectionTarget, ConnectorAuth};
use crate::error::{ConnectorError, ConnectorResult};
use crate::traits::{Connector, FetchRequest, JoinAggregationRequest, SourceTable};
use crate::type_mapping::pg_type_to_engine_type;

/// Default number of connections in the pool.
const DEFAULT_MAX_CONNECTIONS: u32 = 5;

/// PostgreSQL connector using `sqlx` with connection pooling.
pub struct PostgresConnector {
    pool: PgPool,
    /// Counter for generating unique temp table names.
    temp_table_counter: AtomicU64,
}

impl ConnectorAuth for PostgresConnector {
    fn supported_auth_methods() -> Vec<AuthMethodKind> {
        vec![
            AuthMethodKind::UsernamePassword,
            AuthMethodKind::EnvironmentVariable,
        ]
    }
}

impl PostgresConnector {
    /// Connect to a PostgreSQL database.
    ///
    /// Builds the connection URL from the given target and auth method.
    /// Uses port **5432** when `target.port` is `None`.
    ///
    /// # Auth method handling
    ///
    /// - [`AuthMethod::UsernamePassword`]: embeds credentials in the URL.
    /// - [`AuthMethod::EnvironmentVariable`]: resolves env vars at call time.
    /// - [`AuthMethod::Integrated`]: connects without credentials (relies on
    ///   server-side GSSAPI/SSPI/peer authentication).
    pub async fn connect(target: ConnectionTarget, auth: AuthMethod) -> ConnectorResult<Self> {
        let url = Self::build_connection_url(target, auth)?;
        let pool = PgPoolOptions::new()
            .max_connections(DEFAULT_MAX_CONNECTIONS)
            .connect(&url)
            .await
            .map_err(|e| ConnectorError::ConnectionFailed(e.to_string()))?;
        Ok(Self {
            pool,
            temp_table_counter: AtomicU64::new(0),
        })
    }

    /// Build a PostgreSQL connection URL from a target and auth method.
    fn build_connection_url(target: ConnectionTarget, auth: AuthMethod) -> ConnectorResult<String> {
        let port = target.port.unwrap_or(5432);

        let url = match auth {
            AuthMethod::UsernamePassword { username, password } => {
                format!(
                    "postgresql://{}:{}@{}:{}/{}",
                    username, password, target.host, port, target.database
                )
            }
            AuthMethod::EnvironmentVariable {
                username_var,
                password_var,
            } => {
                let username = std::env::var(&username_var).map_err(|_| {
                    ConnectorError::ConnectionFailed(format!(
                        "environment variable '{}' not set",
                        username_var
                    ))
                })?;
                let password = std::env::var(&password_var).map_err(|_| {
                    ConnectorError::ConnectionFailed(format!(
                        "environment variable '{}' not set",
                        password_var
                    ))
                })?;
                format!(
                    "postgresql://{}:{}@{}:{}/{}",
                    username, password, target.host, port, target.database
                )
            }
            AuthMethod::Integrated => {
                return Err(ConnectorError::AuthMethodNotSupported(
                    "Integrated (SSPI/Kerberos) authentication is not supported by the PostgreSQL connector".to_string(),
                ));
            }
        };

        Ok(url)
    }

    /// Close the connection pool gracefully.
    pub async fn close(self) {
        self.pool.close().await;
    }

    /// Build the Arrow schema for a table by introspecting its columns.
    async fn build_arrow_schema_for_query(
        &self,
        schema: &str,
        table_name: &str,
        columns: &[String],
    ) -> ConnectorResult<Schema> {
        let table = self.introspect_table(schema, table_name).await?;
        let fields: Vec<Field> = if columns.is_empty() {
            table
                .columns()
                .iter()
                .map(|c| Field::new(c.name(), c.data_type().to_arrow(), c.nullable()))
                .collect()
        } else {
            columns
                .iter()
                .map(|name| {
                    let col = table.column(name)?;
                    Ok(Field::new(
                        col.name(),
                        col.data_type().to_arrow(),
                        col.nullable(),
                    ))
                })
                .collect::<ConnectorResult<Vec<_>>>()?
        };
        Ok(Schema::new(fields))
    }

    /// Execute a SQL query with bind parameters and return results as
    /// Arrow `RecordBatch` values.
    ///
    /// Schema is inferred from the result's PG column metadata, like
    /// `execute_query`. Used for aggregate pushdown where the result schema
    /// differs from the source table schema.
    async fn execute_query_with_params(
        &self,
        sql: &str,
        params: &[String],
    ) -> ConnectorResult<Vec<RecordBatch>> {
        let mut query = sqlx::query(sql);
        for param in params {
            query = query.bind(param);
        }

        let rows = query.fetch_all(&self.pool).await?;

        if rows.is_empty() {
            return Ok(vec![]);
        }

        // Build Arrow schema from the first row's column metadata.
        let first_row = &rows[0];
        let pg_columns = first_row.columns();
        let mut fields = Vec::with_capacity(pg_columns.len());

        for pg_col in pg_columns {
            let col_name = pg_col.name();
            let type_info = pg_col.type_info().to_string();
            let arrow_type = pg_type_name_to_arrow(&type_info, col_name)?;
            fields.push(Field::new(col_name, arrow_type, true));
        }

        let schema = Schema::new(fields);
        rows_to_record_batches(&rows, &schema)
    }

    /// Build SQL for an aggregate query from a `FetchRequest`.
    fn build_aggregate_sql(request: &FetchRequest) -> (String, Vec<String>) {
        let schema_name = request.schema.as_deref().unwrap_or("public");
        let table_ref = format!("\"{schema_name}\".\"{table}\"", table = request.table);

        // SELECT group_by columns + aggregate expressions.
        let mut select_parts: Vec<String> = request
            .group_by
            .iter()
            .map(|c| format!("\"{c}\""))
            .collect();

        for agg in &request.aggregates {
            let func = agg.function.as_sql();
            let col = &agg.column;
            let default_alias = format!("{}_{}", func.to_lowercase(), col);
            let alias = agg.alias.as_deref().unwrap_or(&default_alias);
            if agg.function == crate::traits::AggregateFunction::CountDistinct {
                select_parts.push(format!("{func}(DISTINCT \"{col}\") AS \"{alias}\""));
            } else if agg.function == crate::traits::AggregateFunction::CountAll {
                select_parts.push(format!("COUNT(*) AS \"{alias}\""));
            } else {
                select_parts.push(format!("{func}(\"{col}\") AS \"{alias}\""));
            }
        }

        let select_clause = select_parts.join(", ");
        let mut sql = format!("SELECT {select_clause} FROM {table_ref}");

        // WHERE clause.
        let mut params: Vec<String> = Vec::new();
        let has_conditions = !request.filters.is_empty() || !request.in_filters.is_empty();
        if has_conditions {
            let mut conditions = Vec::new();
            for filter in &request.filters {
                params.push(filter.value.clone());
                let param_idx = params.len();
                conditions.push(format!(
                    "\"{}\"::text {} ${}",
                    filter.column,
                    filter.operator.as_sql(),
                    param_idx
                ));
            }
            for in_filter in &request.in_filters {
                if !in_filter.values.is_empty() {
                    conditions.push(build_inline_in_pg(&in_filter.column, &in_filter.values));
                }
            }
            sql.push_str(" WHERE ");
            sql.push_str(&conditions.join(" AND "));
        }

        // GROUP BY clause.
        if !request.group_by.is_empty() {
            let group_clause: Vec<String> = request
                .group_by
                .iter()
                .map(|c| format!("\"{c}\""))
                .collect();
            sql.push_str(" GROUP BY ");
            sql.push_str(&group_clause.join(", "));
        }

        if let Some(limit) = request.limit {
            sql.push_str(&format!(" LIMIT {limit}"));
        }

        (sql, params)
    }

    /// Generate a unique temp table name.
    fn next_temp_table_name(&self) -> String {
        let id = self.temp_table_counter.fetch_add(1, Ordering::Relaxed);
        format!("_ef_{id}")
    }

    /// Create a temp table on the given connection and populate it with values.
    ///
    /// Returns the temp table name on success, or `None` if creation failed
    /// (e.g., insufficient permissions). Values are inserted in batches of 500.
    async fn create_temp_filter_table(
        &self,
        conn: &mut sqlx::pool::PoolConnection<sqlx::Postgres>,
        values: &[String],
    ) -> Option<String> {
        let name = self.next_temp_table_name();
        let create_sql = format!("CREATE TEMP TABLE \"{name}\" (val TEXT)");
        if conn.execute(create_sql.as_str()).await.is_err() {
            return None;
        }

        for chunk in values.chunks(500) {
            let rows: Vec<String> = chunk
                .iter()
                .map(|v| format!("('{}')", v.replace('\'', "''")))
                .collect();
            let insert_sql = format!("INSERT INTO \"{name}\" (val) VALUES {}", rows.join(", "));
            if conn.execute(insert_sql.as_str()).await.is_err() {
                let _ = conn
                    .execute(format!("DROP TABLE IF EXISTS \"{name}\"").as_str())
                    .await;
                return None;
            }
        }
        Some(name)
    }

    /// Fetch data using temp tables for large IN-filter value sets.
    ///
    /// Acquires a single pooled connection so that temp tables are visible
    /// for the duration of the CREATE → INSERT → SELECT → DROP sequence.
    async fn fetch_data_with_temp_tables(
        &self,
        request: &FetchRequest,
        threshold: usize,
    ) -> ConnectorResult<Vec<RecordBatch>> {
        let schema_name = request.schema.as_deref().unwrap_or("public");
        let mut conn = self.pool.acquire().await.map_err(|e| {
            ConnectorError::ConnectionFailed(format!("failed to acquire connection: {e}"))
        })?;

        let mut temp_tables: Vec<String> = Vec::new();

        // Build WHERE conditions, using temp tables for large IN-filter sets.
        let mut conditions = Vec::new();
        let mut params: Vec<String> = Vec::new();

        for filter in &request.filters {
            params.push(filter.value.clone());
            let param_idx = params.len();
            conditions.push(format!(
                "\"{}\"::text {} ${}",
                filter.column,
                filter.operator.as_sql(),
                param_idx
            ));
        }

        for in_filter in &request.in_filters {
            if in_filter.values.is_empty() {
                continue;
            }
            if in_filter.values.len() > threshold {
                // Temp table path.
                match self
                    .create_temp_filter_table(&mut conn, &in_filter.values)
                    .await
                {
                    Some(temp_name) => {
                        conditions.push(format!(
                            "\"{}\"::text IN (SELECT val FROM \"{}\")",
                            in_filter.column, temp_name
                        ));
                        temp_tables.push(temp_name);
                    }
                    None => {
                        // Fallback: inline IN list if temp table creation failed.
                        conditions.push(build_inline_in_pg(&in_filter.column, &in_filter.values));
                    }
                }
            } else {
                // Below threshold: inline.
                conditions.push(build_inline_in_pg(&in_filter.column, &in_filter.values));
            }
        }

        // Build the SQL query.
        let is_aggregate = !request.aggregates.is_empty();
        let sql = if is_aggregate {
            Self::build_aggregate_sql_with_conditions(request, &conditions, &params)
        } else {
            let select_clause = if request.columns.is_empty() {
                "*".to_string()
            } else {
                request
                    .columns
                    .iter()
                    .map(|c| format!("\"{c}\""))
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            let table_ref = format!("\"{schema_name}\".\"{table}\"", table = request.table);
            let mut sql = format!("SELECT {select_clause} FROM {table_ref}");
            if !conditions.is_empty() {
                sql.push_str(" WHERE ");
                sql.push_str(&conditions.join(" AND "));
            }
            if let Some(limit) = request.limit {
                sql.push_str(&format!(" LIMIT {limit}"));
            }
            sql
        };

        // Execute on the pinned connection.
        let mut query = sqlx::query(&sql);
        for param in &params {
            query = query.bind(param);
        }
        let rows = query
            .fetch_all(&mut *conn)
            .await
            .map_err(ConnectorError::from)?;

        // Cleanup temp tables.
        for name in &temp_tables {
            let _ = conn
                .execute(format!("DROP TABLE IF EXISTS \"{name}\"").as_str())
                .await;
        }

        if rows.is_empty() {
            return Ok(vec![]);
        }

        if is_aggregate {
            // Infer schema from result metadata (aggregate queries change the schema).
            let first_row = &rows[0];
            let pg_columns = first_row.columns();
            let mut fields = Vec::with_capacity(pg_columns.len());
            for pg_col in pg_columns {
                let col_name = pg_col.name();
                let type_info = pg_col.type_info().to_string();
                let arrow_type = pg_type_name_to_arrow(&type_info, col_name)?;
                fields.push(Field::new(col_name, arrow_type, true));
            }
            let schema = Schema::new(fields);
            rows_to_record_batches(&rows, &schema)
        } else {
            let arrow_schema = self
                .build_arrow_schema_for_query(schema_name, &request.table, &request.columns)
                .await?;
            rows_to_record_batches(&rows, &arrow_schema)
        }
    }

    /// Build aggregate SQL with pre-built WHERE conditions (for temp table path).
    fn build_aggregate_sql_with_conditions(
        request: &FetchRequest,
        conditions: &[String],
        _params: &[String],
    ) -> String {
        let schema_name = request.schema.as_deref().unwrap_or("public");
        let table_ref = format!("\"{schema_name}\".\"{table}\"", table = request.table);

        let mut select_parts: Vec<String> = request
            .group_by
            .iter()
            .map(|c| format!("\"{c}\""))
            .collect();

        for agg in &request.aggregates {
            let func = agg.function.as_sql();
            let col = &agg.column;
            let default_alias = format!("{}_{}", func.to_lowercase(), col);
            let alias = agg.alias.as_deref().unwrap_or(&default_alias);
            if agg.function == crate::traits::AggregateFunction::CountDistinct {
                select_parts.push(format!("{func}(DISTINCT \"{col}\") AS \"{alias}\""));
            } else if agg.function == crate::traits::AggregateFunction::CountAll {
                select_parts.push(format!("COUNT(*) AS \"{alias}\""));
            } else {
                select_parts.push(format!("{func}(\"{col}\") AS \"{alias}\""));
            }
        }

        let select_clause = select_parts.join(", ");
        let mut sql = format!("SELECT {select_clause} FROM {table_ref}");

        if !conditions.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&conditions.join(" AND "));
        }

        if !request.group_by.is_empty() {
            let group_clause: Vec<String> = request
                .group_by
                .iter()
                .map(|c| format!("\"{c}\""))
                .collect();
            sql.push_str(" GROUP BY ");
            sql.push_str(&group_clause.join(", "));
        }

        if let Some(limit) = request.limit {
            sql.push_str(&format!(" LIMIT {limit}"));
        }

        sql
    }

    /// Resolve a custom PostgreSQL domain type to its base type name.
    ///
    /// AdventureWorks uses domain types like `"Flag"`, `"OrderNumber"`,
    /// `"AccountNumber"` that are aliases for standard types. This method
    /// resolves them via `pg_type` and `pg_namespace`.
    async fn resolve_base_type(
        &self,
        type_name: &str,
        type_schema: &str,
    ) -> ConnectorResult<String> {
        let row = sqlx::query(
            "SELECT base.typname AS base_type
             FROM pg_type t
             JOIN pg_namespace n ON n.oid = t.typnamespace
             JOIN pg_type base ON base.oid = t.typbasetype
             WHERE t.typname = $1 AND n.nspname = $2 AND t.typbasetype != 0",
        )
        .bind(type_name)
        .bind(type_schema)
        .fetch_optional(&self.pool)
        .await?;

        match row {
            Some(r) => {
                let base: String = r.try_get("base_type")?;
                Ok(base)
            }
            None => Ok(type_name.to_string()),
        }
    }
}

impl Connector for PostgresConnector {
    async fn list_tables(&self) -> ConnectorResult<Vec<SourceTable>> {
        let rows = sqlx::query(
            "SELECT table_schema, table_name
             FROM information_schema.tables
             WHERE table_type IN ('BASE TABLE', 'VIEW')
               AND table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
             ORDER BY table_schema, table_name",
        )
        .fetch_all(&self.pool)
        .await?;

        let tables = rows
            .iter()
            .map(|row| {
                let schema: String = row.try_get("table_schema")?;
                let name: String = row.try_get("table_name")?;
                Ok(SourceTable { schema, name })
            })
            .collect::<Result<Vec<_>, sqlx::Error>>()?;

        Ok(tables)
    }

    async fn introspect_table(&self, schema: &str, table_name: &str) -> ConnectorResult<Table> {
        let rows = sqlx::query(
            "SELECT
                c.column_name,
                CASE
                    WHEN c.data_type = 'USER-DEFINED' THEN c.udt_name
                    ELSE c.data_type
                END AS data_type,
                c.is_nullable,
                c.numeric_precision,
                c.numeric_scale,
                c.udt_schema
             FROM information_schema.columns c
             WHERE c.table_schema = $1 AND c.table_name = $2
             ORDER BY c.ordinal_position",
        )
        .bind(schema)
        .bind(table_name)
        .fetch_all(&self.pool)
        .await?;

        if rows.is_empty() {
            return Err(ConnectorError::IntrospectionFailed(format!(
                "table '{schema}.{table_name}' not found or has no columns"
            )));
        }

        let mut columns = Vec::with_capacity(rows.len());
        for row in &rows {
            let col_name: String = row.try_get("column_name")?;
            let mut data_type_str: String = row.try_get("data_type")?;
            let is_nullable: String = row.try_get("is_nullable")?;
            let precision: Option<i32> = row.try_get("numeric_precision")?;
            let scale: Option<i32> = row.try_get("numeric_scale")?;
            let udt_schema: String = row.try_get("udt_schema")?;

            // Resolve custom domain types to their base type.
            let resolved = self.resolve_base_type(&data_type_str, &udt_schema).await?;
            if resolved != data_type_str {
                data_type_str = pg_base_type_to_info_schema(&resolved);
            }

            let engine_type = pg_type_to_engine_type(&data_type_str, &col_name, precision, scale)?;

            let column = if is_nullable == "YES" {
                Column::new(&col_name, engine_type)
            } else {
                Column::non_nullable(&col_name, engine_type)
            };
            columns.push(column);
        }

        let full_name = format!("{schema}.{table_name}");
        Table::new(&full_name, columns).map_err(ConnectorError::from)
    }

    async fn fetch_data(&self, request: &FetchRequest) -> ConnectorResult<Vec<RecordBatch>> {
        // Check if any IN-filter exceeds the temp-table threshold.
        let threshold = request.max_inline_in_values.unwrap_or(usize::MAX);
        let needs_temp_table = request
            .in_filters
            .iter()
            .any(|f| f.values.len() > threshold);
        if needs_temp_table {
            return self.fetch_data_with_temp_tables(request, threshold).await;
        }

        // Aggregate pushdown: build GROUP BY query and use schema inference.
        if !request.aggregates.is_empty() {
            let (sql, params) = Self::build_aggregate_sql(request);
            return self.execute_query_with_params(&sql, &params).await;
        }

        let schema_name = request.schema.as_deref().unwrap_or("public");

        // Build Arrow schema for result conversion.
        let arrow_schema = self
            .build_arrow_schema_for_query(schema_name, &request.table, &request.columns)
            .await?;

        // Build SQL query.
        let select_clause = if request.columns.is_empty() {
            "*".to_string()
        } else {
            request
                .columns
                .iter()
                .map(|c| format!("\"{c}\""))
                .collect::<Vec<_>>()
                .join(", ")
        };

        let table_ref = format!("\"{schema_name}\".\"{table}\"", table = request.table);
        let mut sql = format!("SELECT {select_clause} FROM {table_ref}");

        // Append WHERE clause from filters.
        // Values are bound as text parameters and cast to the column's type
        // using PG's `::text` cast on the column side for universal comparison.
        let mut params: Vec<String> = Vec::new();
        let has_conditions = !request.filters.is_empty() || !request.in_filters.is_empty();
        if has_conditions {
            let mut conditions = Vec::new();
            for filter in &request.filters {
                params.push(filter.value.clone());
                let param_idx = params.len();
                conditions.push(format!(
                    "\"{}\"::text {} ${}",
                    filter.column,
                    filter.operator.as_sql(),
                    param_idx
                ));
            }
            for in_filter in &request.in_filters {
                if !in_filter.values.is_empty() {
                    conditions.push(build_inline_in_pg(&in_filter.column, &in_filter.values));
                }
            }
            sql.push_str(" WHERE ");
            sql.push_str(&conditions.join(" AND "));
        }

        if let Some(limit) = request.limit {
            sql.push_str(&format!(" LIMIT {limit}"));
        }

        // Execute the query with parameters.
        let mut query = sqlx::query(&sql);
        for param in &params {
            query = query.bind(param);
        }

        let rows = query.fetch_all(&self.pool).await?;
        rows_to_record_batches(&rows, &arrow_schema)
    }

    async fn execute_query(&self, sql: &str) -> ConnectorResult<Vec<RecordBatch>> {
        // First execute to get rows and infer schema from the result.
        let rows = sqlx::query(sql).fetch_all(&self.pool).await?;

        if rows.is_empty() {
            return Ok(vec![]);
        }

        // Build Arrow schema from the first row's column metadata.
        let first_row = &rows[0];
        let pg_columns = first_row.columns();
        let mut fields = Vec::with_capacity(pg_columns.len());

        for pg_col in pg_columns {
            let col_name = pg_col.name();
            let type_info = pg_col.type_info().to_string();
            let arrow_type = pg_type_name_to_arrow(&type_info, col_name)?;
            fields.push(Field::new(col_name, arrow_type, true));
        }

        let schema = Schema::new(fields);
        rows_to_record_batches(&rows, &schema)
    }

    async fn row_count(&self, schema: &str, table_name: &str) -> ConnectorResult<usize> {
        let sql = format!("SELECT COUNT(*) AS cnt FROM \"{schema}\".\"{table_name}\"");
        let row = sqlx::query(&sql).fetch_one(&self.pool).await?;
        let count: i64 = row.try_get("cnt")?;
        Ok(count as usize)
    }

    async fn execute_join_aggregation(
        &self,
        request: &JoinAggregationRequest,
    ) -> ConnectorResult<Vec<RecordBatch>> {
        // Resolve ISINSCOPE in expressions before SQL generation.
        let group_by_pairs: Vec<(String, String)> = request
            .table_map
            .iter()
            .flat_map(|(model, _)| {
                request
                    .group_by
                    .iter()
                    .filter(move |col| {
                        request
                            .table_map
                            .iter()
                            .any(|(m, s)| m.eq_ignore_ascii_case(model) && s == &col.table)
                    })
                    .map(move |col| (model.clone(), col.column.clone()))
            })
            .collect();

        // Build SELECT parts.
        let mut select_parts: Vec<String> = Vec::new();
        let mut group_by_parts: Vec<String> = Vec::new();

        for col in &request.group_by {
            let qualified = format!("\"{}\".\"{}\"", col.table, col.column);
            select_parts.push(qualified.clone());
            group_by_parts.push(qualified);
        }

        for m in &request.measures {
            let resolved = engine_core::compute::expression::resolve_is_in_scope(
                &m.expression,
                &group_by_pairs,
            );
            let expr_sql = pg_dialect::expr_to_sql_with_clear(
                &resolved,
                &request.table_map,
                &request.group_by,
            )?;
            select_parts.push(format!("{expr_sql} AS \"{}\"", m.alias));
        }

        // Build FROM + JOINs.
        let mut sql = format!(
            "SELECT {} FROM \"{}\".\"{}\"",
            select_parts.join(", "),
            request.fact_schema,
            request.fact_table
        );

        for join in &request.joins {
            sql.push_str(&format!(
                " JOIN \"{}\".\"{}\" ON \"{}\".\"{}\" = \"{}\".\"{}\"",
                join.dim_schema,
                join.dim_table,
                request.fact_table,
                join.fact_column,
                join.dim_table,
                join.dim_column,
            ));
        }

        // WHERE clause.
        if !request.filters.is_empty() {
            let where_parts: Vec<String> = request
                .filters
                .iter()
                .map(|f| format!("\"{}\" {} '{}'", f.column, f.operator.as_sql(), f.value))
                .collect();
            sql.push_str(&format!(" WHERE {}", where_parts.join(" AND ")));
        }

        // GROUP BY.
        if !group_by_parts.is_empty() {
            sql.push_str(&format!(" GROUP BY {}", group_by_parts.join(", ")));
        }

        self.execute_query(&sql).await
    }
}

/// Build an inline `"col"::text IN ('v1', 'v2', ...)` condition for PostgreSQL.
fn build_inline_in_pg(column: &str, values: &[String]) -> String {
    let quoted: Vec<String> = values
        .iter()
        .map(|v| format!("'{}'", v.replace('\'', "''")))
        .collect();
    format!("\"{}\"::text IN ({})", column, quoted.join(", "))
}

/// Map a pg_type base type name (e.g., `"bool"`, `"int4"`) back to
/// `information_schema`-style type names for our type mapping function.
fn pg_base_type_to_info_schema(base_type: &str) -> String {
    match base_type {
        "bool" => "boolean".to_string(),
        "int2" => "smallint".to_string(),
        "int4" => "integer".to_string(),
        "int8" => "bigint".to_string(),
        "float4" => "real".to_string(),
        "float8" => "double precision".to_string(),
        "numeric" => "numeric".to_string(),
        "varchar" | "text" | "bpchar" | "name" => "character varying".to_string(),
        "timestamp" => "timestamp without time zone".to_string(),
        "timestamptz" => "timestamp with time zone".to_string(),
        "date" => "date".to_string(),
        "uuid" => "uuid".to_string(),
        other => other.to_string(),
    }
}

/// Map a sqlx `TypeInfo` name (e.g., `"INT4"`, `"TEXT"`, `"NUMERIC"`) to an
/// Arrow data type. Used by `execute_query` which does not have
/// `information_schema` metadata.
fn pg_type_name_to_arrow(
    type_name: &str,
    col_name: &str,
) -> ConnectorResult<arrow::datatypes::DataType> {
    use arrow::datatypes::DataType as AT;
    use arrow::datatypes::TimeUnit;

    match type_name.to_uppercase().as_str() {
        "INT4" | "INT" | "INTEGER" => Ok(AT::Int32),
        "INT2" | "SMALLINT" => Ok(AT::Int32),
        "INT8" | "BIGINT" | "SERIAL" | "BIGSERIAL" => Ok(AT::Int64),
        "FLOAT4" | "REAL" => Ok(AT::Float64),
        "FLOAT8" | "DOUBLE PRECISION" => Ok(AT::Float64),
        "NUMERIC" | "DECIMAL" => Ok(AT::Decimal128(38, 10)),
        "TEXT" | "VARCHAR" | "CHAR" | "CHARACTER" | "CHARACTER VARYING" | "BPCHAR" | "NAME"
        | "UUID" | "JSON" | "JSONB" | "XML" => Ok(AT::Utf8),
        "BOOL" | "BOOLEAN" => Ok(AT::Boolean),
        "DATE" => Ok(AT::Date32),
        "TIMESTAMP" | "TIMESTAMPTZ" => Ok(AT::Timestamp(TimeUnit::Microsecond, None)),
        other => Err(ConnectorError::UnsupportedType {
            column: col_name.to_string(),
            db_type: other.to_string(),
        }),
    }
}

// ---------------------------------------------------------------------------
// PostgreSQL dialect: Expression → SQL rendering
// ---------------------------------------------------------------------------

mod pg_dialect {
    use engine_core::compute::aggregate::AggregateOp;
    use engine_core::compute::expression::Expression;

    use super::ConnectorResult;

    /// Resolve a model table name to its source table name via the table map.
    fn source_table(model_table: &str, table_map: &[(String, String)]) -> String {
        table_map
            .iter()
            .find(|(m, _)| m.eq_ignore_ascii_case(model_table))
            .map(|(_, s)| s.clone())
            .unwrap_or_else(|| model_table.to_string())
    }

    /// Render an Expression as PostgreSQL SQL.
    ///
    /// Uses `"double_quotes"` for identifiers and PostgreSQL-specific function
    /// syntax (e.g., `PERCENTILE_CONT`, `STDDEV_SAMP`, `::NUMERIC` casts).
    pub fn expr_to_sql(
        expr: &Expression,
        table_map: &[(String, String)],
    ) -> ConnectorResult<String> {
        use engine_core::compute::expression::ScalarFunction;

        match expr {
            Expression::QualifiedColumnRef {
                table_or_var,
                column,
            } => {
                let src = source_table(table_or_var, table_map);
                Ok(format!("\"{src}\".\"{column}\""))
            }
            Expression::ColumnRef(name) => Ok(format!("\"{name}\"")),
            Expression::LiteralFloat(v) => Ok(format!("{v}")),
            Expression::LiteralInt(v) => Ok(format!("{v}")),
            Expression::LiteralBool(b) => Ok(if *b { "TRUE" } else { "FALSE" }.to_string()),
            Expression::LiteralString(s) => Ok(format!("'{}'", s.replace('\'', "''"))),
            Expression::Blank => Ok("NULL".to_string()),

            Expression::Aggregate { operation, operand } => {
                // Check for KEEP inside aggregate operand.
                if let Expression::Keep {
                    expr: inner,
                    filters,
                    variables,
                    conditions,
                    in_predicates,
                } = operand.as_ref()
                {
                    if variables.is_empty() && conditions.is_empty() && in_predicates.is_empty() {
                        let condition = filters_to_condition(filters, table_map)?;
                        let inner_sql = expr_to_sql(inner, table_map)?;
                        let case_expr = format!("CASE WHEN {condition} THEN {inner_sql} END");
                        return Ok(agg_sql(operation, &case_expr));
                    }
                }
                let operand_sql = expr_to_sql(operand, table_map)?;
                Ok(agg_sql(operation, &operand_sql))
            }
            Expression::BinaryOp { left, op, right } => {
                let l = expr_to_sql(left, table_map)?;
                let r = expr_to_sql(right, table_map)?;
                Ok(format!("({l} {} {r})", op.as_sql()))
            }
            Expression::SafeDivide {
                numerator,
                denominator,
                alternate,
            } => {
                let n = expr_to_sql(numerator, table_map)?;
                let d = expr_to_sql(denominator, table_map)?;
                let alt = match alternate {
                    Some(a) => expr_to_sql(a, table_map)?,
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
                let c = expr_to_sql(condition, table_map)?;
                let t = expr_to_sql(then_expr, table_map)?;
                let e = expr_to_sql(else_expr, table_map)?;
                Ok(format!("CASE WHEN {c} THEN {t} ELSE {e} END"))
            }
            Expression::Comparison { left, op, right } => {
                let l = expr_to_sql(left, table_map)?;
                let r = expr_to_sql(right, table_map)?;
                Ok(format!("({l} {} {r})", op.as_sql()))
            }
            Expression::And(l, r) => Ok(format!(
                "({} AND {})",
                expr_to_sql(l, table_map)?,
                expr_to_sql(r, table_map)?
            )),
            Expression::Or(l, r) => Ok(format!(
                "({} OR {})",
                expr_to_sql(l, table_map)?,
                expr_to_sql(r, table_map)?
            )),
            Expression::Not(inner) => Ok(format!("(NOT {})", expr_to_sql(inner, table_map)?)),
            Expression::IsBlank(inner) => {
                Ok(format!("({} IS NULL)", expr_to_sql(inner, table_map)?))
            }
            Expression::Coalesce(exprs) => {
                let parts: Vec<String> = exprs
                    .iter()
                    .map(|e| expr_to_sql(e, table_map))
                    .collect::<ConnectorResult<Vec<_>>>()?;
                Ok(format!("COALESCE({})", parts.join(", ")))
            }
            Expression::ScalarFunc { function, args } => {
                let mapped: Vec<String> = args
                    .iter()
                    .map(|a| expr_to_sql(a, table_map))
                    .collect::<ConnectorResult<Vec<_>>>()?;
                match function {
                    ScalarFunction::Round | ScalarFunction::RoundUp | ScalarFunction::RoundDown => {
                        let digits = mapped.get(1).map(|s| s.as_str()).unwrap_or("0");
                        let func = if matches!(function, ScalarFunction::RoundDown) {
                            "TRUNC"
                        } else {
                            "ROUND"
                        };
                        Ok(format!("{func}(({})::NUMERIC, {digits})", mapped[0]))
                    }
                    ScalarFunction::Trunc => {
                        let digits = mapped.get(1).map(|s| s.as_str()).unwrap_or("0");
                        Ok(format!("TRUNC(({})::NUMERIC, {digits})", mapped[0]))
                    }
                    ScalarFunction::Log10 => Ok(format!("LOG(10, ({})::NUMERIC)", mapped[0])),
                    ScalarFunction::Sign => Ok(format!("SIGN({})", mapped[0])),
                    ScalarFunction::Mod => Ok(format!("MOD({}, {})", mapped[0], mapped[1])),
                    _ => Ok(function.to_sql_strs(&mapped)),
                }
            }
            Expression::TextFunc { function, args } => {
                let mapped: Vec<String> = args
                    .iter()
                    .map(|a| expr_to_sql(a, table_map))
                    .collect::<ConnectorResult<Vec<_>>>()?;
                Ok(function.to_sql_strs(&mapped))
            }
            Expression::DateTimeFunc { function, args } => {
                let mapped: Vec<String> = args
                    .iter()
                    .map(|a| expr_to_sql(a, table_map))
                    .collect::<ConnectorResult<Vec<_>>>()?;
                Ok(function.to_sql_strs(&mapped))
            }
            Expression::IfError {
                expr: inner,
                alternate,
            } => {
                let i = expr_to_sql(inner, table_map)?;
                let a = expr_to_sql(alternate, table_map)?;
                Ok(format!("COALESCE({i}, {a})"))
            }
            Expression::IsInScope { .. } => Ok("TRUE".to_string()),
            Expression::Iterate { expression, .. } => expr_to_sql(expression, table_map),
            Expression::ClearExcept { expr: inner, .. } | Expression::Clear { expr: inner, .. } => {
                expr_to_sql(inner, table_map)
            }
            Expression::Keep {
                expr: inner,
                filters,
                variables,
                conditions,
                in_predicates,
            } => {
                if variables.is_empty() && conditions.is_empty() && in_predicates.is_empty() {
                    let condition = filters_to_condition(filters, table_map)?;
                    return case_when_expr(inner, &condition, table_map);
                }
                expr_to_sql(inner, table_map)
            }
            Expression::Block { .. } => {
                let inlined = expr.inline_bindings();
                expr_to_sql(&inlined, table_map)
            }
            Expression::Switch {
                expr: switch_expr,
                cases,
                default,
            } => {
                let e = expr_to_sql(switch_expr, table_map)?;
                let mut sql = format!("CASE {e}");
                for (v, r) in cases {
                    sql.push_str(&format!(
                        " WHEN {} THEN {}",
                        expr_to_sql(v, table_map)?,
                        expr_to_sql(r, table_map)?
                    ));
                }
                if let Some(d) = default {
                    sql.push_str(&format!(" ELSE {}", expr_to_sql(d, table_map)?));
                }
                sql.push_str(" END");
                Ok(sql)
            }
            Expression::Percentile {
                operand,
                percentile,
            } => {
                let op = expr_to_sql(operand, table_map)?;
                let k = expr_to_sql(percentile, table_map)?;
                Ok(format!("PERCENTILE_CONT({k}) WITHIN GROUP (ORDER BY {op})"))
            }
            Expression::HasOneValue { column } => {
                let c = expr_to_sql(column, table_map)?;
                Ok(format!("(COUNT(DISTINCT {c}) = 1)"))
            }
            Expression::SelectedValue { column, alternate } => {
                let c = expr_to_sql(column, table_map)?;
                let a = match alternate {
                    Some(v) => expr_to_sql(v, table_map)?,
                    None => "NULL".to_string(),
                };
                Ok(format!(
                    "CASE WHEN COUNT(DISTINCT {c}) = 1 THEN MIN({c}) ELSE {a} END"
                ))
            }
            Expression::FirstValue { column, .. } => {
                let c = expr_to_sql(column, table_map)?;
                Ok(format!("MIN({c})"))
            }
            Expression::Xor(l, r) => {
                let ls = expr_to_sql(l, table_map)?;
                let rs = expr_to_sql(r, table_map)?;
                Ok(format!("(({ls} AND NOT {rs}) OR (NOT {ls} AND {rs}))"))
            }
            Expression::Greatest(args) => {
                let parts: Vec<String> = args
                    .iter()
                    .map(|e| expr_to_sql(e, table_map))
                    .collect::<ConnectorResult<Vec<_>>>()?;
                Ok(format!("GREATEST({})", parts.join(", ")))
            }
            Expression::Least(args) => {
                let parts: Vec<String> = args
                    .iter()
                    .map(|e| expr_to_sql(e, table_map))
                    .collect::<ConnectorResult<Vec<_>>>()?;
                Ok(format!("LEAST({})", parts.join(", ")))
            }
            Expression::NullIf { expr: inner, value } => {
                let i = expr_to_sql(inner, table_map)?;
                let v = expr_to_sql(value, table_map)?;
                Ok(format!("NULLIF({i}, {v})"))
            }
            Expression::TableRef(_) => Ok(String::new()),
            // COUNT_IF(condition) → SUM(CASE WHEN condition THEN 1 ELSE 0 END)
            Expression::CountIf { condition } => {
                let c = expr_to_sql(condition, table_map)?;
                Ok(format!("SUM(CASE WHEN {c} THEN 1 ELSE 0 END)"))
            }
            // STRING_AGG
            Expression::ListAgg { column, delimiter } => {
                let col = expr_to_sql(column, table_map)?;
                let delim = expr_to_sql(delimiter, table_map)?;
                Ok(format!("STRING_AGG({col}, {delim})"))
            }
            // MAXBY / MINBY — needs subquery or ORDER BY, simplified
            Expression::MaxBy { value, sort_by } => {
                let v = expr_to_sql(value, table_map)?;
                let s = expr_to_sql(sort_by, table_map)?;
                Ok(format!("(ARRAY_AGG({v} ORDER BY {s} DESC NULLS LAST))[1]"))
            }
            Expression::MinBy { value, sort_by } => {
                let v = expr_to_sql(value, table_map)?;
                let s = expr_to_sql(sort_by, table_map)?;
                Ok(format!("(ARRAY_AGG({v} ORDER BY {s} ASC NULLS LAST))[1]"))
            }
            // IN list
            Expression::InList {
                expr: inner,
                values,
            } => {
                let e = expr_to_sql(inner, table_map)?;
                let vals: Vec<String> = values
                    .iter()
                    .map(|v| expr_to_sql(v, table_map))
                    .collect::<ConnectorResult<Vec<_>>>()?;
                Ok(format!("{e} IN ({})", vals.join(", ")))
            }
            _ => Err(super::ConnectorError::UnsupportedOperation(format!(
                "PostgreSQL pushdown: unsupported expression {expr:?}"
            ))),
        }
    }

    /// Render an aggregate operation as PostgreSQL SQL.
    fn agg_sql(op: &AggregateOp, operand: &str) -> String {
        match op {
            AggregateOp::Sum => format!("SUM({operand})"),
            AggregateOp::Count => format!("COUNT({operand})"),
            AggregateOp::Average => format!("AVG({operand})"),
            AggregateOp::Min => format!("MIN({operand})"),
            AggregateOp::Max => format!("MAX({operand})"),
            AggregateOp::DistinctCount => format!("COUNT(DISTINCT {operand})"),
            AggregateOp::CountRows => "COUNT(*)".to_string(),
            AggregateOp::Median => {
                format!("PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY {operand})")
            }
            AggregateOp::StdevSample => format!("STDDEV_SAMP({operand})"),
            AggregateOp::StdevPop => format!("STDDEV_POP({operand})"),
            AggregateOp::VarSample => format!("VAR_SAMP({operand})"),
            AggregateOp::VarPop => format!("VAR_POP({operand})"),
            AggregateOp::AnyValue => format!("MIN({operand})"),
            AggregateOp::Mode => format!("MODE() WITHIN GROUP (ORDER BY {operand})"),
        }
    }

    /// Build a CASE WHEN SQL fragment for KEEP filter predicates.
    fn filters_to_condition(
        filters: &[engine_core::compute::expression::FilterPredicate],
        table_map: &[(String, String)],
    ) -> ConnectorResult<String> {
        let parts: Vec<String> = filters
            .iter()
            .map(|f| {
                let src = source_table(&f.table, table_map);
                Ok(format!(
                    "\"{src}\".\"{}\" {} '{}'",
                    f.column,
                    f.operator.as_sql(),
                    f.value
                ))
            })
            .collect::<ConnectorResult<Vec<_>>>()?;
        Ok(parts.join(" AND "))
    }

    /// Wrap an inner expression's aggregates with CASE WHEN.
    fn case_when_expr(
        expr: &Expression,
        condition: &str,
        table_map: &[(String, String)],
    ) -> ConnectorResult<String> {
        match expr {
            Expression::Aggregate { operation, operand } => {
                let inner_sql = expr_to_sql(operand, table_map)?;
                let case_expr = format!("CASE WHEN {condition} THEN {inner_sql} END");
                Ok(agg_sql(operation, &case_expr))
            }
            Expression::BinaryOp { left, op, right } => {
                let l = case_when_expr(left, condition, table_map)?;
                let r = case_when_expr(right, condition, table_map)?;
                Ok(format!("({l} {} {r})", op.as_sql()))
            }
            Expression::SafeDivide {
                numerator,
                denominator,
                alternate,
            } => {
                let n = case_when_expr(numerator, condition, table_map)?;
                let d = case_when_expr(denominator, condition, table_map)?;
                let alt = match alternate {
                    Some(a) => expr_to_sql(a, table_map)?,
                    None => "NULL".to_string(),
                };
                Ok(format!(
                    "CASE WHEN {d} = 0 THEN {alt} ELSE CAST({n} AS DOUBLE PRECISION) / {d} END"
                ))
            }
            _ => expr_to_sql(expr, table_map),
        }
    }

    /// Render a full Expression with CLEAR/CLEAREXCEPT as window functions.
    pub fn expr_to_sql_with_clear(
        expr: &Expression,
        table_map: &[(String, String)],
        group_by: &[crate::traits::QualifiedColumn],
    ) -> ConnectorResult<String> {
        use engine_core::model::ClearTarget;

        match expr {
            Expression::Clear {
                expr: inner,
                targets,
            } => {
                let inner_sql = expr_to_sql_with_clear(inner, table_map, group_by)?;
                let partition_cols: Vec<String> = group_by
                    .iter()
                    .filter(|col| {
                        !targets.iter().any(|t| match t {
                            ClearTarget::Table(table) => table_map
                                .iter()
                                .any(|(m, s)| m.eq_ignore_ascii_case(table) && s == &col.table),
                            ClearTarget::Column { table, column } => {
                                table_map
                                    .iter()
                                    .any(|(m, s)| m.eq_ignore_ascii_case(table) && s == &col.table)
                                    && col.column == *column
                            }
                        })
                    })
                    .map(|col| format!("\"{}\".\"{}\"", col.table, col.column))
                    .collect();
                let over = if partition_cols.is_empty() {
                    "OVER ()".to_string()
                } else {
                    format!("OVER (PARTITION BY {})", partition_cols.join(", "))
                };
                Ok(format!("SUM({inner_sql}) {over}"))
            }
            Expression::ClearExcept {
                expr: inner,
                table,
                except_columns,
            } => {
                let inner_sql = expr_to_sql_with_clear(inner, table_map, group_by)?;
                let src_table = source_table(table, table_map);
                let partition_cols: Vec<String> = group_by
                    .iter()
                    .filter(|col| {
                        if col.table != src_table {
                            true
                        } else {
                            except_columns.contains(&col.column)
                        }
                    })
                    .map(|col| format!("\"{}\".\"{}\"", col.table, col.column))
                    .collect();
                let over = if partition_cols.is_empty() {
                    "OVER ()".to_string()
                } else {
                    format!("OVER (PARTITION BY {})", partition_cols.join(", "))
                };
                Ok(format!("SUM({inner_sql}) {over}"))
            }
            Expression::SafeDivide {
                numerator,
                denominator,
                alternate,
            } => {
                let n = expr_to_sql_with_clear(numerator, table_map, group_by)?;
                let d = expr_to_sql_with_clear(denominator, table_map, group_by)?;
                let alt = match alternate {
                    Some(a) => expr_to_sql_with_clear(a, table_map, group_by)?,
                    None => "NULL".to_string(),
                };
                Ok(format!(
                    "CASE WHEN {d} = 0 THEN {alt} ELSE CAST({n} AS DOUBLE PRECISION) / {d} END"
                ))
            }
            Expression::BinaryOp { left, op, right } => {
                let l = expr_to_sql_with_clear(left, table_map, group_by)?;
                let r = expr_to_sql_with_clear(right, table_map, group_by)?;
                Ok(format!("({l} {} {r})", op.as_sql()))
            }
            Expression::If {
                condition,
                then_expr,
                else_expr,
            } => {
                let c = expr_to_sql_with_clear(condition, table_map, group_by)?;
                let t = expr_to_sql_with_clear(then_expr, table_map, group_by)?;
                let e = expr_to_sql_with_clear(else_expr, table_map, group_by)?;
                Ok(format!("CASE WHEN {c} THEN {t} ELSE {e} END"))
            }
            Expression::Coalesce(exprs) => {
                let parts: Vec<String> = exprs
                    .iter()
                    .map(|e| expr_to_sql_with_clear(e, table_map, group_by))
                    .collect::<ConnectorResult<Vec<_>>>()?;
                Ok(format!("COALESCE({})", parts.join(", ")))
            }
            Expression::Block { .. } => {
                let inlined = expr.inline_bindings();
                expr_to_sql_with_clear(&inlined, table_map, group_by)
            }
            _ => expr_to_sql(expr, table_map),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_url_username_password() {
        let target = ConnectionTarget::new("dbhost", "analytics").with_port(5433);
        let auth = AuthMethod::UsernamePassword {
            username: "alice".into(),
            password: "secret".into(),
        };
        let url = PostgresConnector::build_connection_url(target, auth).unwrap();
        assert_eq!(url, "postgresql://alice:secret@dbhost:5433/analytics");
    }

    #[test]
    fn build_url_default_port() {
        let target = ConnectionTarget::new("host", "db");
        let auth = AuthMethod::UsernamePassword {
            username: "u".into(),
            password: "p".into(),
        };
        let url = PostgresConnector::build_connection_url(target, auth).unwrap();
        assert!(url.contains(":5432/"));
    }

    #[test]
    fn build_url_integrated_returns_error() {
        let target = ConnectionTarget::new("kerberos-host", "warehouse");
        let err =
            PostgresConnector::build_connection_url(target, AuthMethod::Integrated).unwrap_err();
        assert!(err.to_string().contains("not supported"));
    }

    #[test]
    fn build_url_env_var_missing() {
        let target = ConnectionTarget::new("host", "db");
        let auth = AuthMethod::EnvironmentVariable {
            username_var: "__CALCULA_TEST_NONEXISTENT_USER__".into(),
            password_var: "__CALCULA_TEST_NONEXISTENT_PASS__".into(),
        };
        let err = PostgresConnector::build_connection_url(target, auth).unwrap_err();
        assert!(err.to_string().contains("environment variable"));
    }

    #[test]
    fn supported_auth_methods_includes_username_password() {
        let methods = PostgresConnector::supported_auth_methods();
        assert!(methods.contains(&AuthMethodKind::UsernamePassword));
        assert!(methods.contains(&AuthMethodKind::EnvironmentVariable));
        assert!(!methods.contains(&AuthMethodKind::Integrated));
    }
}
