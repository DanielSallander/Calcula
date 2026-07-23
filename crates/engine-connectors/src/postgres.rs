//! PostgreSQL connector using `sqlx` with connection pooling.

use std::sync::atomic::{AtomicU64, Ordering};

use arrow::datatypes::{Field, Schema};
use arrow::record_batch::RecordBatch;
use engine_core::compute::sql_util::quote_ident_double;
use engine_core::model::{Column, Table};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};
use sqlx::{Column as SqlxColumn, Executor, PgPool, Row};

use crate::arrow_convert::rows_to_record_batches;
use crate::auth::{
    resolve_credentials, validate_target, AuthMethod, AuthMethodKind, ConnectionTarget,
    ConnectorAuth, ResolvedCredentials,
};
use crate::error::{ConnectorError, ConnectorResult};
use crate::sql_builder::{self, PostgresDialect, SqlDialect};
use crate::traits::{
    Connector, FetchRequest, InFilterCondition, InValueKind, JoinAggregationRequest, SchemaCache,
    SourceTable,
};
use crate::type_mapping::pg_type_to_engine_type;

/// Default number of connections in the pool.
const DEFAULT_MAX_CONNECTIONS: u32 = 5;

/// PostgreSQL connector using `sqlx` with connection pooling.
pub struct PostgresConnector {
    pool: PgPool,
    /// Counter for generating unique temp table names.
    temp_table_counter: AtomicU64,
    /// Read-through cache of introspected table schemas, keyed by
    /// `(schema, table)`. Avoids repeating the `information_schema.columns`
    /// and `pg_type` domain-resolution queries on every fetch. Entries live
    /// for the connector's lifetime — see
    /// [`PostgresConnector::invalidate_schema_cache`] for the staleness
    /// tradeoff.
    schema_cache: SchemaCache,
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
    /// Connection parameters are applied through sqlx's typed
    /// [`PgConnectOptions`] builder — no connection URL is ever assembled, so
    /// hostile values in a [`ConnectionTarget`] (which may come from a shared
    /// model file) cannot restructure the connection or inject options.
    /// Uses port **5432** when `target.port` is `None`.
    ///
    /// # Auth method handling
    ///
    /// - [`AuthMethod::UsernamePassword`]: passes credentials to the builder.
    /// - [`AuthMethod::EnvironmentVariable`]: resolves env vars at call time.
    /// - [`AuthMethod::Integrated`][]: returns
    ///   [`ConnectorError::AuthMethodNotSupported`].
    ///
    /// # TLS behavior
    ///
    /// - `target.trust_server_certificate == false` (default): sqlx's default
    ///   ssl-mode applies (`prefer`, or the `PGSSLMODE` environment variable
    ///   when set) — unchanged from previous releases.
    /// - `target.trust_server_certificate == true`: ssl-mode is forced to
    ///   `require` (TLS mandatory, server certificate not verified).
    pub async fn connect(target: ConnectionTarget, auth: AuthMethod) -> ConnectorResult<Self> {
        let options = Self::build_connect_options(&target, auth)?;

        // Ask the server for untranslated (ASCII) diagnostics via the startup
        // packet: on Windows servers whose lc_messages locale is not UTF-8
        // (e.g. "Swedish_Sweden.1252"), errors raised during connection setup
        // otherwise arrive in a non-UTF-8 encoding the protocol layer cannot
        // decode — masking the REAL problem ("password authentication failed",
        // "database … does not exist", "role … does not exist") behind
        // "Postgres returned a non-UTF-8 string for its error message".
        // lc_messages is a USERSET GUC, so plain roles may set it.
        let with_ascii_diagnostics = options.clone().options([("lc_messages", "C")]);
        let pool = match PgPoolOptions::new()
            .max_connections(DEFAULT_MAX_CONNECTIONS)
            .connect_with(with_ascii_diagnostics)
            .await
        {
            Ok(pool) => pool,
            // Some poolers (e.g. PgBouncer without ignore_startup_parameters)
            // reject the `options` startup parameter — retry without it.
            Err(e) if e.to_string().contains("unsupported startup parameter") => {
                PgPoolOptions::new()
                    .max_connections(DEFAULT_MAX_CONNECTIONS)
                    .connect_with(options)
                    .await
                    .map_err(|e| ConnectorError::ConnectionFailed(e.to_string()))?
            }
            Err(e) => return Err(ConnectorError::ConnectionFailed(e.to_string())),
        };
        Ok(Self {
            pool,
            temp_table_counter: AtomicU64::new(0),
            schema_cache: SchemaCache::new(),
        })
    }

    /// Construct a connector backed by a **lazy** connection pool that never
    /// actually connects (sqlx opens a connection only on first use).
    ///
    /// Intended for planner/plan-shape tests and tooling that need a
    /// pushdown-capable connector instance without a live database — the
    /// capability probes ([`supports_expression_pushdown`](crate::registry) via
    /// the registry) only inspect the connector *kind*, never the pool. Any
    /// method that issues a query will fail at connection time.
    #[doc(hidden)]
    pub fn lazy_unconnected() -> Self {
        let pool = PgPoolOptions::new().connect_lazy_with(PgConnectOptions::new());
        Self {
            pool,
            temp_table_counter: AtomicU64::new(0),
            schema_cache: SchemaCache::new(),
        }
    }

    /// Build typed PostgreSQL connection options from a target and auth
    /// method.
    ///
    /// Every value goes through a dedicated [`PgConnectOptions`] setter, so
    /// URL metacharacters (`@`, `/`, `?`, `#`, …) in any field are treated as
    /// literal text and cannot alter the connection structure. Values that
    /// the wire protocol cannot represent (embedded NUL bytes) are rejected
    /// with [`ConnectorError::InvalidConnectionParameter`].
    fn build_connect_options(
        target: &ConnectionTarget,
        auth: AuthMethod,
    ) -> ConnectorResult<PgConnectOptions> {
        let port = target.port.unwrap_or(5432);
        validate_target(target)?;

        // Shared resolver handles env-var lookup + credential NUL validation;
        // PostgreSQL does not support OS-integrated auth in this connector.
        let (username, password) = match resolve_credentials(auth)? {
            ResolvedCredentials::UsernamePassword { username, password } => (username, password),
            ResolvedCredentials::Integrated => {
                return Err(ConnectorError::AuthMethodNotSupported(
                    "Integrated (SSPI/Kerberos) authentication is not supported by the PostgreSQL connector".to_string(),
                ));
            }
        };

        let mut options = PgConnectOptions::new()
            .host(&target.host)
            .port(port)
            .database(&target.database)
            .username(&username)
            .password(&password);

        if let Some(mode) = Self::ssl_mode_override(target) {
            options = options.ssl_mode(mode);
        }

        Ok(options)
    }

    /// Choose the PostgreSQL ssl-mode from the target's explicit `ssl_mode`
    /// override, falling back to `trust_server_certificate`.
    ///
    /// - explicit `"disable"` → [`PgSslMode::Disable`]: TLS is never used
    ///   (required for servers that do not support TLS at all).
    /// - explicit `"require"`, or `trust_server_certificate == true` →
    ///   [`PgSslMode::Require`]: TLS mandatory, server certificate not verified.
    /// - explicit `"prefer"` → [`PgSslMode::Prefer`]: attempt TLS, fall back to
    ///   plaintext.
    /// - otherwise `None`: sqlx's default applies (`prefer`, or `PGSSLMODE`).
    ///
    /// Stricter modes (`verify-ca` / `verify-full`) are future work.
    fn ssl_mode_override(target: &ConnectionTarget) -> Option<PgSslMode> {
        match target
            .ssl_mode
            .as_deref()
            .map(|s| s.trim().to_ascii_lowercase())
            .as_deref()
        {
            Some("disable") => Some(PgSslMode::Disable),
            Some("require") => Some(PgSslMode::Require),
            Some("prefer") => Some(PgSslMode::Prefer),
            _ if target.trust_server_certificate => Some(PgSslMode::Require),
            _ => None,
        }
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
    ///
    /// Delegates to the shared [`sql_builder`] with the PostgreSQL dialect
    /// (`"ident"` quoting, `$n` placeholders, trailing `LIMIT`).
    fn build_aggregate_sql(request: &FetchRequest) -> (String, Vec<String>) {
        sql_builder::build_aggregate_sql(&PostgresDialect, request)
    }

    /// Generate a unique temp table name.
    fn next_temp_table_name(&self) -> String {
        let id = self.temp_table_counter.fetch_add(1, Ordering::Relaxed);
        PostgresDialect.temp_table_name(id)
    }

    /// Create a temp table on the given connection and populate it with values.
    ///
    /// The column type follows the (pre-validated) value kind: `BIGINT` for
    /// [`InValueKind::Integer`] so the fact-table FK comparison needs no
    /// casts, `TEXT` otherwise. Values are inserted as multi-row `VALUES`
    /// statements of up to 1000 rows each (values are inlined literals, so
    /// the bind-parameter limit does not apply).
    ///
    /// Returns the temp table name on success, or `None` if creation or any
    /// insert failed (e.g., insufficient permissions, or an integer value out
    /// of `BIGINT` range) — callers fall back to the inline IN list.
    async fn create_temp_filter_table(
        &self,
        conn: &mut sqlx::pool::PoolConnection<sqlx::Postgres>,
        values: &[String],
        kind: InValueKind,
    ) -> Option<String> {
        let name = self.next_temp_table_name();
        let create_sql = PostgresDialect.temp_table_ddl(&name, kind);
        if conn.execute(create_sql.as_str()).await.is_err() {
            return None;
        }

        // Integer values were validated (parse::<i128>) by the caller via
        // `effective_kind()` before choosing this kind.
        for insert_sql in
            sql_builder::temp_table_insert_statements(&PostgresDialect, &name, values, kind)
        {
            if conn.execute(insert_sql.as_str()).await.is_err() {
                let _ = conn
                    .execute(sql_builder::temp_table_drop_sql(&PostgresDialect, &name).as_str())
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
        let mut params: Vec<String> = Vec::new();
        let mut conditions =
            sql_builder::build_filter_conditions(&PostgresDialect, &request.filters, &mut params);

        for in_filter in &request.in_filters {
            if in_filter.values.is_empty() {
                // An empty IN set matches nothing — restrict to zero rows
                // rather than dropping the constraint (would return all rows).
                conditions.push(sql_builder::FALSE_PREDICATE.to_string());
                continue;
            }
            if in_filter.values.len() > threshold {
                // Temp table path. `effective_kind()` re-validates Integer
                // values so the temp table type matches what gets inserted.
                let kind = in_filter.effective_kind();
                match self
                    .create_temp_filter_table(&mut conn, &in_filter.values, kind)
                    .await
                {
                    Some(temp_name) => {
                        conditions.push(sql_builder::temp_in_condition(
                            &PostgresDialect,
                            &in_filter.column,
                            &temp_name,
                            kind,
                        ));
                        temp_tables.push(temp_name);
                    }
                    None => {
                        // Fallback: inline IN list if temp table creation failed.
                        conditions.push(build_inline_in_pg(in_filter));
                    }
                }
            } else {
                // Below threshold: inline.
                conditions.push(build_inline_in_pg(in_filter));
            }
        }

        // Build the SQL query.
        let is_aggregate = !request.aggregates.is_empty();
        let sql = if is_aggregate {
            sql_builder::build_aggregate_sql_with_conditions(&PostgresDialect, request, &conditions)
        } else {
            sql_builder::build_select_sql_with_conditions(&PostgresDialect, request, &conditions)
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
                .execute(sql_builder::temp_table_drop_sql(&PostgresDialect, name).as_str())
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

    /// Introspect a table's schema directly against the source catalog,
    /// bypassing the schema cache.
    ///
    /// Runs an `information_schema.columns` query plus a `pg_type` /
    /// `pg_namespace` domain-resolution query per custom-typed column.
    /// [`Connector::introspect_table`] wraps this with the read-through
    /// [`SchemaCache`].
    async fn introspect_table_uncached(
        &self,
        schema: &str,
        table_name: &str,
    ) -> ConnectorResult<Table> {
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

    /// Discard all cached table schemas, forcing the next introspection of
    /// each table to re-read the source catalog.
    ///
    /// Schemas are cached for the connector's lifetime, so DDL on the source
    /// (`ALTER TABLE`, column changes, drops) is invisible until this is
    /// called. Host applications that issue or expect DDL — model designer
    /// hosts in particular — should invalidate afterwards. Synchronous and
    /// cheap: it only clears an in-memory map.
    pub fn invalidate_schema_cache(&self) {
        self.schema_cache.invalidate_all();
    }
}

impl Connector for PostgresConnector {
    fn capabilities(&self) -> crate::traits::ConnectorCapabilities {
        // PostgreSQL renders Expression trees through the unified SQL renderer
        // (`pg_dialect`) and executes pushed JOIN-aggregations.
        crate::traits::ConnectorCapabilities::with_expression_pushdown()
    }

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

    /// Introspect a table's schema, served from the connector's
    /// [`SchemaCache`] after the first lookup.
    ///
    /// The returned [`Table`] is identical to an uncached introspection; only
    /// the catalog round-trips are skipped. Stale after source DDL until
    /// [`PostgresConnector::invalidate_schema_cache`] is called.
    async fn introspect_table(&self, schema: &str, table_name: &str) -> ConnectorResult<Table> {
        self.schema_cache
            .get_or_load(schema, table_name, || {
                self.introspect_table_uncached(schema, table_name)
            })
            .await
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

        // Build SQL query. Filter values are bound as text parameters and
        // cast to the column's type using PG's `::text` cast on the column
        // side for universal comparison.
        let (sql, params) = sql_builder::build_select_sql(&PostgresDialect, request);

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
        let sql = format!(
            "SELECT COUNT(*) AS cnt FROM {}.{}",
            quote_ident_double(schema),
            quote_ident_double(table_name)
        );
        let row = sqlx::query(&sql).fetch_one(&self.pool).await?;
        let count: i64 = row.try_get("cnt")?;
        Ok(count as usize)
    }

    async fn execute_join_aggregation(
        &self,
        request: &JoinAggregationRequest,
    ) -> ConnectorResult<Vec<RecordBatch>> {
        // The structural SQL assembly is shared across dialects; PostgreSQL's
        // identifier quoting and Expression rendering (`pg_dialect`) come from
        // its `SqlDialect` / `ExpressionDialect` impls.
        let (sql, params) = sql_builder::build_join_aggregation_sql(&PostgresDialect, request)?;
        self.execute_query_with_params(&sql, &params).await
    }

    /// Trait-level dispatch to [`PostgresConnector::invalidate_schema_cache`].
    fn invalidate_schema_cache(&self) {
        self.schema_cache.invalidate_all();
    }
}

/// Build an inline `"col" IN (...)` condition for PostgreSQL.
///
/// The column is never cast: casting the (typically indexed) fact column to
/// text makes the predicate non-sargable and forces a sequential scan.
///
/// - [`InValueKind::Integer`] (re-validated via
///   [`InFilterCondition::effective_kind`]): values render as unquoted
///   numeric literals — `"col" IN (1, 2, 3)`.
/// - [`InValueKind::Text`] (or failed integer validation): values are
///   escaped with [`sql_quote_literal`] — `"col" IN ('v1', 'v2')`. The
///   quoted literals are of "unknown" type in PostgreSQL, so they coerce to
///   the column's actual type (text, varchar, date, uuid, ...) and the
///   comparison stays index-friendly.
///
/// The column identifier is escaped with [`quote_ident_double`] so it cannot
/// break out of the IN list. Delegates to the shared [`sql_builder`] inline-IN
/// builder with the PostgreSQL dialect.
fn build_inline_in_pg(in_filter: &InFilterCondition) -> String {
    sql_builder::build_inline_in(&PostgresDialect, in_filter)
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
        "NUMERIC" | "DECIMAL" => Ok(AT::Decimal128(
            crate::decimal::DEFAULT_DECIMAL_PRECISION,
            crate::decimal::DEFAULT_DECIMAL_SCALE,
        )),
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
    use engine_core::compute::expression::{
        ColumnQualifier, Expression, PostgresDialect, SqlRenderer,
    };
    use engine_core::compute::sql_util::quote_ident_double;
    use engine_core::error::EngineResult;

    use super::{ConnectorError, ConnectorResult};

    /// Resolve a model table name to its source table name via the table map.
    fn source_table(model_table: &str, table_map: &[(String, String)]) -> String {
        table_map
            .iter()
            .find(|(m, _)| m.eq_ignore_ascii_case(model_table))
            .map(|(_, s)| s.clone())
            .unwrap_or_else(|| model_table.to_string())
    }

    /// Column qualifier that renders table-qualified references through the
    /// connector table map: `"source_table"."column"`.
    struct TableMapQualifier<'a> {
        table_map: &'a [(String, String)],
    }

    impl ColumnQualifier for TableMapQualifier<'_> {
        fn column(&self, table_or_var: Option<&str>, column: &str) -> EngineResult<String> {
            Ok(match table_or_var {
                None => quote_ident_double(column),
                Some(table) => {
                    let src = source_table(table, self.table_map);
                    format!(
                        "{}.{}",
                        quote_ident_double(&src),
                        quote_ident_double(column)
                    )
                }
            })
        }
    }

    /// Render an Expression as PostgreSQL SQL.
    ///
    /// Uses `"double_quotes"` for identifiers and PostgreSQL-specific function
    /// syntax (e.g., `PERCENTILE_CONT`, `STDDEV_SAMP`, `::NUMERIC` casts).
    /// Delegates to the unified [`SqlRenderer`] (Postgres dialect, table-map
    /// qualifier, KEEP rendered as conditional aggregation).
    pub fn expr_to_sql(
        expr: &Expression,
        table_map: &[(String, String)],
    ) -> ConnectorResult<String> {
        let qualifier = TableMapQualifier { table_map };
        SqlRenderer::new(PostgresDialect, &qualifier)
            .with_keep_case_when()
            .render(expr)
            .map_err(|e| ConnectorError::UnsupportedOperation(format!("PostgreSQL pushdown: {e}")))
    }

    /// Render a full Expression with CLEAR/CLEAREXCEPT as window functions.
    ///
    /// NOT unified into [`SqlRenderer`]: the CLEAR-to-window translation
    /// depends on the request's `group_by` column set (to compute the
    /// PARTITION BY over *source* table/column names), which is join-request
    /// state rather than expression-rendering configuration. Non-CLEAR
    /// subtrees delegate to the unified renderer via [`expr_to_sql`].
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
                    .map(|col| {
                        format!(
                            "{}.{}",
                            quote_ident_double(&col.table),
                            quote_ident_double(&col.column)
                        )
                    })
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
                    .map(|col| {
                        format!(
                            "{}.{}",
                            quote_ident_double(&col.table),
                            quote_ident_double(&col.column)
                        )
                    })
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
            Expression::Block {
                query_scoped_bindings,
                ..
            } => {
                // Query-scoped (GVAR) bindings must be resolved to literals at
                // the Engine facade before any source SQL is generated;
                // inline_bindings would silently drop a survivor. Fail closed
                // (mirrors the engine-core renderer guards). The pushdown
                // planner marks GVAR blocks unpushable, so this is
                // defense-in-depth against a future pushability change.
                if !query_scoped_bindings.is_empty() {
                    return Err(ConnectorError::QueryFailed(
                        "internal: a query-scoped (GVAR) binding reached connector SQL \
                         generation unresolved (it must be resolved at the Engine facade)"
                            .to_string(),
                    ));
                }
                let inlined = expr.inline_bindings();
                expr_to_sql_with_clear(&inlined, table_map, group_by)
            }
            _ => expr_to_sql(expr, table_map),
        }
    }
}

/// PostgreSQL can render Expression trees, so it implements
/// [`ExpressionDialect`](sql_builder::ExpressionDialect) — unlocking the shared
/// [`build_join_aggregation_sql`](sql_builder::build_join_aggregation_sql).
impl sql_builder::ExpressionDialect for PostgresDialect {
    fn render_join_expression(
        &self,
        expr: &engine_core::compute::expression::Expression,
        table_map: &[(String, String)],
        group_by: &[crate::traits::QualifiedColumn],
    ) -> ConnectorResult<String> {
        pg_dialect::expr_to_sql_with_clear(expr, table_map, group_by)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::traits::{AggregateExpr, AggregateFunction};

    /// Test helper: build an [`InFilterCondition`] from string values.
    fn in_filter(column: &str, values: &[&str], kind: InValueKind) -> InFilterCondition {
        InFilterCondition {
            column: column.into(),
            values: values.iter().map(|v| v.to_string()).collect(),
            kind,
        }
    }

    #[test]
    fn build_inline_in_pg_escapes_injection_payload() {
        let cond = build_inline_in_pg(&in_filter(
            "color",
            &["x'); DROP TABLE t; --"],
            InValueKind::Text,
        ));
        assert_eq!(cond, "\"color\" IN ('x''); DROP TABLE t; --')");
        assert!(cond.contains("''"));
        assert!(!cond.contains("IN ('x');"));
    }

    #[test]
    fn build_inline_in_pg_escapes_embedded_identifier_quote() {
        let cond = build_inline_in_pg(&in_filter("evil\"name", &["a"], InValueKind::Text));
        assert!(cond.starts_with("\"evil\"\"name\" IN"));
    }

    #[test]
    fn build_inline_in_pg_integer_kind_renders_unquoted_without_cast() {
        let cond = build_inline_in_pg(&in_filter(
            "product_id",
            &["1", "2", "3"],
            InValueKind::Integer,
        ));
        assert_eq!(cond, "\"product_id\" IN (1, 2, 3)");
        assert!(!cond.contains("::text"));
        assert!(!cond.contains('\''));
    }

    #[test]
    fn build_inline_in_pg_text_kind_drops_column_cast_but_keeps_quoting() {
        let cond = build_inline_in_pg(&in_filter("region", &["north"], InValueKind::Text));
        assert_eq!(cond, "\"region\" IN ('north')");
        assert!(!cond.contains("::text"));
    }

    #[test]
    fn build_inline_in_pg_hostile_integer_value_falls_back_to_quoted_text() {
        // Declared Integer but contains a non-numeric payload: must be
        // re-validated and rendered escaped + quoted, never inlined raw.
        let cond = build_inline_in_pg(&in_filter(
            "product_id",
            &["1", "2); DROP TABLE t; --"],
            InValueKind::Integer,
        ));
        assert_eq!(cond, "\"product_id\" IN ('1', '2); DROP TABLE t; --')");
        assert!(!cond.contains("IN (1, 2);"));
    }

    #[test]
    fn build_inline_in_pg_negative_and_large_integers_stay_integer() {
        let cond = build_inline_in_pg(&in_filter(
            "key",
            &["-7", "9223372036854775807"],
            InValueKind::Integer,
        ));
        assert_eq!(cond, "\"key\" IN (-7, 9223372036854775807)");
    }

    #[test]
    fn pg_dialect_complex_expression_pinned() {
        // Equivalence oracle for the unified renderer migration: KEEP + IF +
        // SAFE DIVIDE + aggregates + literals with embedded quotes, rendered
        // with table-map-qualified column references. Pinned from the
        // pre-unification implementation — must never change.
        use engine_core::compute::aggregate::AggregateOp;
        use engine_core::compute::expression::{
            agg, col, compare, if_expr, keep, lit_int, lit_str, safe_divide, ComparisonOp,
            FilterPredicate,
        };

        let table_map = vec![("Products".to_string(), "production_product".to_string())];
        let expr = if_expr(
            compare(
                agg(
                    AggregateOp::Sum,
                    keep(
                        col("amount"),
                        vec![FilterPredicate::new(
                            "Products",
                            "category",
                            ComparisonOp::Equal,
                            "O'Brien",
                        )],
                    ),
                ),
                ComparisonOp::GreaterThan,
                lit_int(1000),
            ),
            lit_str("it's high"),
            safe_divide(
                agg(AggregateOp::Sum, col("amount")),
                agg(AggregateOp::Count, col("id")),
                None,
            ),
        );

        let sql = pg_dialect::expr_to_sql(&expr, &table_map).unwrap();
        assert_eq!(
            sql,
            "CASE WHEN (SUM(CASE WHEN \"production_product\".\"category\" = 'O''Brien' \
             THEN \"amount\" END) > 1000) THEN 'it''s high' \
             ELSE CASE WHEN COUNT(\"id\") = 0 THEN NULL \
             ELSE CAST(SUM(\"amount\") AS DOUBLE PRECISION) / COUNT(\"id\") END END"
        );
    }

    #[test]
    fn pg_dialect_round_is_pinned_to_numeric_cast() {
        // PostgreSQL ROUND requires a NUMERIC operand — pinned from the
        // pre-unification implementation.
        use engine_core::compute::expression::{col, lit_int, scalar_fn, ScalarFunction};

        let expr = scalar_fn(ScalarFunction::Round, vec![col("x"), lit_int(2)]);
        assert_eq!(
            pg_dialect::expr_to_sql(&expr, &[]).unwrap(),
            "ROUND((\"x\")::NUMERIC, 2)"
        );
    }

    #[test]
    fn pg_dialect_keep_filter_value_injection_is_escaped() {
        use engine_core::compute::aggregate::AggregateOp;
        use engine_core::compute::expression::{ComparisonOp, Expression, FilterPredicate};

        let expr = Expression::Aggregate {
            operation: AggregateOp::Sum,
            operand: Box::new(Expression::Keep {
                expr: Box::new(Expression::ColumnRef("linetotal".into())),
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
        let table_map = vec![("Products".to_string(), "product".to_string())];
        let sql = pg_dialect::expr_to_sql(&expr, &table_map).unwrap();
        assert!(sql.contains("'x''); DROP TABLE t; --'"), "{sql}");
        assert!(!sql.contains("= 'x');"), "{sql}");
    }

    #[test]
    fn pg_dialect_context_column_case_renders_escaped_for_group_by() {
        // The expression a context-driven calculated column pushes into GROUP BY:
        // `IF(fact[paid_date] <= <resolved date>, "Pa'id", "Open")`. It comes from
        // the (untrusted) model file, so its string branches must be escaped and
        // the substituted scalar renders as a typed DATE literal — never raw SQL.
        // This is the SAME renderer the connector uses for `computed_group_by`.
        use engine_core::compute::expression::{compare, if_expr, lit_str, qualified_col};
        use engine_core::compute::expression::{ComparisonOp, Expression};

        let expr = if_expr(
            compare(
                qualified_col("Invoice", "paid_date"),
                ComparisonOp::LessThanOrEqual,
                Expression::LiteralDate(19_813),
            ),
            lit_str("Pa'id"),
            lit_str("Open"),
        );
        let table_map = vec![("Invoice".to_string(), "invoice".to_string())];
        let sql = pg_dialect::expr_to_sql_with_clear(&expr, &table_map, &[]).unwrap();
        // 19_813 days since the Unix epoch is 2024-03-31. PostgreSQL rejects
        // integer→date casts, so the scalar renders as a `DATE '…'` literal.
        assert_eq!(
            sql,
            "CASE WHEN (\"invoice\".\"paid_date\" <= DATE '2024-03-31') \
             THEN 'Pa''id' ELSE 'Open' END"
        );
        // The apostrophe is doubled (escaped), not left to terminate the literal.
        assert!(sql.contains("'Pa''id'"), "{sql}");
        assert!(!sql.contains("'Pa'id'"), "{sql}");
    }

    #[test]
    fn build_aggregate_sql_escapes_identifier_quotes() {
        let request = FetchRequest {
            schema: Some("public".into()),
            table: "evil\"table".into(),
            aggregates: vec![AggregateExpr {
                column: "evil\"col".into(),
                function: AggregateFunction::Sum,
                alias: Some("total".into()),
            }],
            ..Default::default()
        };
        let (sql, _params) = PostgresConnector::build_aggregate_sql(&request);
        assert!(sql.contains("\"evil\"\"table\""), "{sql}");
        assert!(sql.contains("SUM(\"evil\"\"col\")"), "{sql}");
    }

    #[test]
    fn build_aggregate_sql_unchanged_for_clean_names() {
        let request = FetchRequest {
            schema: Some("sales".into()),
            table: "orders".into(),
            aggregates: vec![AggregateExpr {
                column: "amount".into(),
                function: AggregateFunction::Sum,
                alias: Some("total".into()),
            }],
            ..Default::default()
        };
        let (sql, params) = PostgresConnector::build_aggregate_sql(&request);
        assert_eq!(
            sql,
            "SELECT SUM(\"amount\") AS \"total\" FROM \"sales\".\"orders\""
        );
        assert!(params.is_empty());
    }

    #[test]
    fn build_connect_options_username_password() {
        let target = ConnectionTarget::new("dbhost", "analytics").with_port(5433);
        let auth = AuthMethod::UsernamePassword {
            username: "alice".into(),
            password: "secret".into(),
        };
        let options = PostgresConnector::build_connect_options(&target, auth).unwrap();
        assert_eq!(options.get_host(), "dbhost");
        assert_eq!(options.get_port(), 5433);
        assert_eq!(options.get_username(), "alice");
        assert_eq!(options.get_database(), Some("analytics"));
    }

    #[test]
    fn build_connect_options_default_port() {
        let target = ConnectionTarget::new("host", "db");
        let auth = AuthMethod::UsernamePassword {
            username: "u".into(),
            password: "p".into(),
        };
        let options = PostgresConnector::build_connect_options(&target, auth).unwrap();
        assert_eq!(options.get_port(), 5432);
    }

    #[test]
    fn build_connect_options_integrated_returns_error() {
        let target = ConnectionTarget::new("kerberos-host", "warehouse");
        let err =
            PostgresConnector::build_connect_options(&target, AuthMethod::Integrated).unwrap_err();
        assert!(err.to_string().contains("not supported"));
    }

    #[test]
    fn build_connect_options_env_var_missing() {
        let target = ConnectionTarget::new("host", "db");
        let auth = AuthMethod::EnvironmentVariable {
            username_var: "__CALCULA_TEST_NONEXISTENT_USER__".into(),
            password_var: "__CALCULA_TEST_NONEXISTENT_PASS__".into(),
        };
        let err = PostgresConnector::build_connect_options(&target, auth).unwrap_err();
        assert!(err.to_string().contains("environment variable"));
    }

    #[test]
    fn build_connect_options_hostile_password_does_not_alter_host_or_database() {
        let target = ConnectionTarget::new("db.example.com", "mydb");
        let auth = AuthMethod::UsernamePassword {
            username: "user".into(),
            password: "p@evil.com/x?sslmode=disable#".into(),
        };
        let options = PostgresConnector::build_connect_options(&target, auth).unwrap();
        assert_eq!(options.get_host(), "db.example.com");
        assert_eq!(options.get_port(), 5432);
        assert_eq!(options.get_database(), Some("mydb"));
        assert_eq!(options.get_username(), "user");
    }

    #[test]
    fn build_connect_options_hostile_database_stays_literal() {
        let target = ConnectionTarget::new("host", "db?sslmode=disable&host=evil");
        let auth = AuthMethod::UsernamePassword {
            username: "u".into(),
            password: "p".into(),
        };
        let options = PostgresConnector::build_connect_options(&target, auth).unwrap();
        assert_eq!(options.get_host(), "host");
        assert_eq!(options.get_database(), Some("db?sslmode=disable&host=evil"));
    }

    #[test]
    fn build_connect_options_trust_server_certificate_forces_require() {
        let target = ConnectionTarget::new("host", "db").with_trust_server_certificate(true);
        let auth = AuthMethod::UsernamePassword {
            username: "u".into(),
            password: "p".into(),
        };
        let options = PostgresConnector::build_connect_options(&target, auth).unwrap();
        assert!(matches!(options.get_ssl_mode(), PgSslMode::Require));
    }

    #[test]
    fn ssl_mode_override_maps_trust_flag() {
        let trust = ConnectionTarget::new("h", "d").with_trust_server_certificate(true);
        assert!(matches!(
            PostgresConnector::ssl_mode_override(&trust),
            Some(PgSslMode::Require)
        ));
        assert!(PostgresConnector::ssl_mode_override(&ConnectionTarget::new("h", "d")).is_none());
    }

    #[test]
    fn ssl_mode_override_honors_explicit_mode() {
        let disable = ConnectionTarget::new("h", "d").with_ssl_mode("disable");
        assert!(matches!(
            PostgresConnector::ssl_mode_override(&disable),
            Some(PgSslMode::Disable)
        ));
        // Explicit "disable" wins even if trust is set.
        let disable_trust = ConnectionTarget::new("h", "d")
            .with_trust_server_certificate(true)
            .with_ssl_mode("disable");
        assert!(matches!(
            PostgresConnector::ssl_mode_override(&disable_trust),
            Some(PgSslMode::Disable)
        ));
        let prefer = ConnectionTarget::new("h", "d").with_ssl_mode("prefer");
        assert!(matches!(
            PostgresConnector::ssl_mode_override(&prefer),
            Some(PgSslMode::Prefer)
        ));
    }

    #[test]
    fn build_connect_options_nul_byte_in_password_is_rejected() {
        let target = ConnectionTarget::new("host", "db");
        let auth = AuthMethod::UsernamePassword {
            username: "u".into(),
            password: "p\0w".into(),
        };
        let err = PostgresConnector::build_connect_options(&target, auth).unwrap_err();
        assert!(matches!(
            err,
            ConnectorError::InvalidConnectionParameter { ref parameter, .. }
                if parameter == "password"
        ));
    }

    #[test]
    fn supported_auth_methods_includes_username_password() {
        let methods = PostgresConnector::supported_auth_methods();
        assert!(methods.contains(&AuthMethodKind::UsernamePassword));
        assert!(methods.contains(&AuthMethodKind::EnvironmentVariable));
        assert!(!methods.contains(&AuthMethodKind::Integrated));
    }
}
