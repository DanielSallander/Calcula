//! PostgreSQL connector using `sqlx` with connection pooling.

use std::sync::atomic::{AtomicU64, Ordering};

use arrow::datatypes::{Field, Schema};
use arrow::record_batch::RecordBatch;
use engine_core::model::{Column, Table};
use sqlx::postgres::PgPoolOptions;
use sqlx::{Column as SqlxColumn, Executor, PgPool, Row};

use crate::arrow_convert::rows_to_record_batches;
use crate::error::{ConnectorError, ConnectorResult};
use crate::traits::{Connector, FetchRequest, SourceTable};
use crate::type_mapping::pg_type_to_engine_type;

/// Configuration for connecting to a PostgreSQL database.
#[derive(Debug, Clone)]
pub struct PostgresConfig {
    /// Connection URL, e.g. `"postgresql://user:pass@host:port/dbname"`.
    pub connection_url: String,
    /// Maximum number of connections in the pool (default: 5).
    pub max_connections: u32,
}

impl PostgresConfig {
    /// Create a new configuration with the given connection URL.
    pub fn new(connection_url: impl Into<String>) -> Self {
        Self {
            connection_url: connection_url.into(),
            max_connections: 5,
        }
    }

    /// Set the maximum number of connections in the pool.
    pub fn with_max_connections(mut self, max: u32) -> Self {
        self.max_connections = max;
        self
    }
}

/// PostgreSQL connector using `sqlx` with connection pooling.
pub struct PostgresConnector {
    pool: PgPool,
    /// Counter for generating unique temp table names.
    temp_table_counter: AtomicU64,
}

impl PostgresConnector {
    /// Connect to a PostgreSQL database.
    pub async fn connect(config: PostgresConfig) -> ConnectorResult<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(config.max_connections)
            .connect(&config.connection_url)
            .await
            .map_err(|e| ConnectorError::ConnectionFailed(e.to_string()))?;
        Ok(Self {
            pool,
            temp_table_counter: AtomicU64::new(0),
        })
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
