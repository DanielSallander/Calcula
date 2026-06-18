//! SQL Server connector using `tiberius` with `bb8` connection pooling.

use std::sync::atomic::{AtomicU64, Ordering};

use arrow::datatypes::{Field, Schema};
use arrow::record_batch::RecordBatch;
use bb8::Pool;
use bb8_tiberius::ConnectionManager;
use engine_core::compute::sql_util::quote_ident_bracket;
use engine_core::model::{Column, Table};
use tiberius::{Config, EncryptionLevel};

use crate::auth::{
    resolve_credentials, validate_target, AuthMethod, AuthMethodKind, ConnectionTarget,
    ConnectorAuth, ResolvedCredentials,
};
use crate::error::{ConnectorError, ConnectorResult};
use crate::sql_builder::{self, SqlDialect, SqlServerDialect};
use crate::sqlserver_convert::tiberius_rows_to_record_batches;
use crate::traits::{
    Connector, FetchRequest, InFilterCondition, InValueKind, SchemaCache, SourceTable,
};
use crate::type_mapping::sqlserver_type_to_engine_type;

/// Default number of connections in the pool.
const DEFAULT_MAX_CONNECTIONS: u32 = 5;

/// SQL Server connector using `tiberius` with `bb8` connection pooling.
pub struct SqlServerConnector {
    pool: Pool<ConnectionManager>,
    /// Counter for generating unique temp table names.
    temp_table_counter: AtomicU64,
    /// Read-through cache of introspected table schemas, keyed by
    /// `(schema, table)`. Avoids repeating the `INFORMATION_SCHEMA.COLUMNS`
    /// query on every fetch. Entries live for the connector's lifetime — see
    /// [`SqlServerConnector::invalidate_schema_cache`] for the staleness
    /// tradeoff.
    schema_cache: SchemaCache,
}

impl ConnectorAuth for SqlServerConnector {
    fn supported_auth_methods() -> Vec<AuthMethodKind> {
        vec![
            AuthMethodKind::Integrated,
            AuthMethodKind::UsernamePassword,
            AuthMethodKind::EnvironmentVariable,
        ]
    }
}

/// Resolved SQL Server authentication, after environment-variable lookup.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ResolvedSqlServerAuth {
    /// Integrated / Windows Authentication (SSPI).
    Integrated,
    /// SQL Server authentication with explicit credentials.
    SqlServer {
        /// Database username.
        username: String,
        /// Database password.
        password: String,
    },
}

/// Fully-resolved, typed connection settings for SQL Server.
///
/// Intermediate representation between ([`ConnectionTarget`], [`AuthMethod`])
/// and [`tiberius::Config`]. It exists so the resolution logic is a pure,
/// unit-testable function — `tiberius::Config` has no public getters. Every
/// field is later passed to `Config` through a dedicated typed setter, which
/// makes ADO-string option injection structurally impossible.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SqlServerConnectionSettings {
    /// Hostname or IP address (always the literal value from the target).
    host: String,
    /// TCP port.
    port: u16,
    /// Database name (always the literal value from the target).
    database: String,
    /// Resolved authentication.
    auth: ResolvedSqlServerAuth,
    /// Whether to accept the server's TLS certificate without validation.
    trust_server_certificate: bool,
}

impl SqlServerConnector {
    /// Connect to a SQL Server database.
    ///
    /// Connection parameters are applied through tiberius's typed [`Config`]
    /// setters — no ADO.NET connection string is ever assembled, so hostile
    /// values in a [`ConnectionTarget`] (which may come from a shared model
    /// file) cannot inject connection options such as
    /// `TrustServerCertificate` or `Encrypt`, or redirect the `Server`.
    /// Uses port **1433** when `target.port` is `None`.
    ///
    /// # Auth method handling
    ///
    /// - [`AuthMethod::Integrated`]: Windows Authentication (SSPI).
    /// - [`AuthMethod::UsernamePassword`]: SQL Server authentication.
    /// - [`AuthMethod::EnvironmentVariable`]: resolves env vars at call time.
    pub async fn connect(target: ConnectionTarget, auth: AuthMethod) -> ConnectorResult<Self> {
        let settings = Self::build_settings(&target, auth)?;
        let tib_config = Self::settings_to_config(settings)?;

        let mgr = ConnectionManager::build(tib_config)
            .map_err(|e| ConnectorError::ConnectionFailed(e.to_string()))?;

        let pool = Pool::builder()
            .max_size(DEFAULT_MAX_CONNECTIONS)
            .build(mgr)
            .await
            .map_err(|e| ConnectorError::ConnectionFailed(e.to_string()))?;

        Ok(Self {
            pool,
            temp_table_counter: AtomicU64::new(0),
            schema_cache: SchemaCache::new(),
        })
    }

    /// Resolve a target and auth method into typed connection settings.
    ///
    /// Pure except for environment-variable lookups
    /// ([`AuthMethod::EnvironmentVariable`]). Unit-tested to guarantee that
    /// hostile values (e.g. a database named
    /// `"db;TrustServerCertificate=true"`) remain literal data. Values that
    /// the wire protocol cannot represent (embedded NUL bytes) are rejected
    /// with [`ConnectorError::InvalidConnectionParameter`].
    fn build_settings(
        target: &ConnectionTarget,
        auth: AuthMethod,
    ) -> ConnectorResult<SqlServerConnectionSettings> {
        let port = target.port.unwrap_or(1433);
        validate_target(target)?;

        // Shared resolver handles env-var lookup + credential NUL validation;
        // SQL Server additionally accepts integrated (Windows/SSPI) auth.
        let resolved_auth = match resolve_credentials(auth)? {
            ResolvedCredentials::Integrated => ResolvedSqlServerAuth::Integrated,
            ResolvedCredentials::UsernamePassword { username, password } => {
                ResolvedSqlServerAuth::SqlServer { username, password }
            }
        };

        Ok(SqlServerConnectionSettings {
            host: target.host.clone(),
            port,
            database: target.database.clone(),
            auth: resolved_auth,
            trust_server_certificate: target.trust_server_certificate,
        })
    }

    /// Convert resolved settings into a [`tiberius::Config`] using only typed
    /// setters.
    ///
    /// The effective TLS behavior matches what the previous ADO-string path
    /// produced for this build of tiberius (compiled without a TLS feature):
    /// the generated string never contained an `encrypt` key, which tiberius
    /// parses as [`EncryptionLevel::NotSupported`] in non-TLS builds, and
    /// `TrustServerCertificate=true` mapped to [`Config::trust_cert`]. If a
    /// tiberius TLS feature is enabled in the future, revisit the encryption
    /// level here (it will need an encryption policy on
    /// [`ConnectionTarget`]).
    fn settings_to_config(settings: SqlServerConnectionSettings) -> ConnectorResult<Config> {
        let mut config = Config::new();
        config.host(&settings.host);
        config.port(settings.port);
        config.database(&settings.database);

        match settings.auth {
            ResolvedSqlServerAuth::Integrated => {
                // tiberius only exposes `AuthMethod::Integrated` on Windows
                // builds with the `winauth` feature (enabled through
                // bb8-tiberius's default features).
                #[cfg(windows)]
                {
                    config.authentication(tiberius::AuthMethod::Integrated);
                }
                #[cfg(not(windows))]
                {
                    return Err(ConnectorError::AuthMethodNotSupported(
                        "Integrated (SSPI) authentication is only available on Windows".to_string(),
                    ));
                }
            }
            ResolvedSqlServerAuth::SqlServer { username, password } => {
                config.authentication(tiberius::AuthMethod::sql_server(username, password));
            }
        }

        if settings.trust_server_certificate {
            // Cannot panic: `trust_cert()` only panics if `trust_cert_ca()`
            // was called first, and we never call `trust_cert_ca()`.
            config.trust_cert();
        }

        // Match the previous effective behavior exactly: the old ADO string
        // had no `encrypt` key, which this TLS-less tiberius build parses as
        // `NotSupported` (the only level it can perform).
        config.encryption(EncryptionLevel::NotSupported);

        Ok(config)
    }

    /// Get a connection from the pool.
    async fn get_conn(&self) -> ConnectorResult<bb8::PooledConnection<'_, ConnectionManager>> {
        self.pool
            .get()
            .await
            .map_err(|e| ConnectorError::ConnectionFailed(e.to_string()))
    }

    /// Build SQL for an aggregate query from a `FetchRequest`.
    ///
    /// Returns `(sql, params)` where params are bound as `@P1`, `@P2`, etc.
    /// Delegates to the shared [`sql_builder`] with the SQL Server dialect
    /// (`[ident]` quoting, `@Pn` placeholders, `TOP(n)` row limiting).
    fn build_aggregate_sql(request: &FetchRequest) -> (String, Vec<String>) {
        sql_builder::build_aggregate_sql(&SqlServerDialect, request)
    }

    /// Execute a parameterized query and return results as Arrow `RecordBatch`
    /// values with schema inferred from the result metadata.
    async fn execute_query_with_params(
        &self,
        sql: &str,
        params: &[String],
    ) -> ConnectorResult<Vec<RecordBatch>> {
        let mut conn = self.get_conn().await?;

        let mut query = tiberius::Query::new(sql);
        for param in params {
            query.bind(param);
        }

        let results = query.query(&mut *conn).await?;
        let rows: Vec<tiberius::Row> = results.into_first_result().await?;

        if rows.is_empty() {
            return Ok(vec![]);
        }

        let schema = infer_schema_from_row(&rows[0])?;
        tiberius_rows_to_record_batches(&rows, &schema)
    }

    /// Generate a unique temp table name (SQL Server `#` prefix).
    fn next_temp_table_name(&self) -> String {
        let id = self.temp_table_counter.fetch_add(1, Ordering::Relaxed);
        SqlServerDialect.temp_table_name(id)
    }

    /// Create a temp table on the given connection and populate it with values.
    ///
    /// The column type follows the (pre-validated) value kind: `BIGINT` for
    /// [`InValueKind::Integer`] so the fact-table FK comparison needs no
    /// casts, `NVARCHAR(MAX)` otherwise. Values are inserted as multi-row
    /// `VALUES` statements of up to 1000 rows each (the SQL Server table
    /// value constructor maximum; values are inlined literals, so the
    /// bind-parameter limit does not apply).
    ///
    /// Returns `true` on success, `false` if creation or any insert failed
    /// (e.g., permissions, or an integer value out of `BIGINT` range) —
    /// callers fall back to the inline IN list.
    async fn create_temp_filter_table(
        conn: &mut bb8::PooledConnection<'_, ConnectionManager>,
        name: &str,
        values: &[String],
        kind: InValueKind,
    ) -> bool {
        let create_sql = SqlServerDialect.temp_table_ddl(name, kind);
        if conn.execute(&create_sql, &[]).await.is_err() {
            return false;
        }

        // Integer values were validated (parse::<i128>) by the caller via
        // `effective_kind()` before choosing this kind.
        for insert_sql in
            sql_builder::temp_table_insert_statements(&SqlServerDialect, name, values, kind)
        {
            if conn.execute(&insert_sql, &[]).await.is_err() {
                let _ = conn
                    .execute(
                        &sql_builder::temp_table_drop_sql(&SqlServerDialect, name),
                        &[],
                    )
                    .await;
                return false;
            }
        }
        true
    }

    /// Fetch data using temp tables for large IN-filter value sets.
    ///
    /// Uses a single pooled connection so that temp tables are visible for
    /// the entire CREATE → INSERT → SELECT → DROP sequence.
    async fn fetch_data_with_temp_tables(
        &self,
        request: &FetchRequest,
        threshold: usize,
    ) -> ConnectorResult<Vec<RecordBatch>> {
        let schema_name = request.schema.as_deref().unwrap_or("dbo");
        let mut conn = self.get_conn().await?;

        let mut temp_tables: Vec<String> = Vec::new();

        // Build WHERE conditions, using temp tables for large IN-filter sets.
        let mut params: Vec<String> = Vec::new();
        let mut conditions =
            sql_builder::build_filter_conditions(&SqlServerDialect, &request.filters, &mut params);

        for in_filter in &request.in_filters {
            if in_filter.values.is_empty() {
                // An empty IN set matches nothing — restrict to zero rows
                // rather than dropping the constraint (would return all rows).
                conditions.push(sql_builder::FALSE_PREDICATE.to_string());
                continue;
            }
            if in_filter.values.len() > threshold {
                // `effective_kind()` re-validates Integer values so the temp
                // table type matches what gets inserted.
                let kind = in_filter.effective_kind();
                let temp_name = self.next_temp_table_name();
                if Self::create_temp_filter_table(&mut conn, &temp_name, &in_filter.values, kind)
                    .await
                {
                    conditions.push(sql_builder::temp_in_condition(
                        &SqlServerDialect,
                        &in_filter.column,
                        &temp_name,
                        kind,
                    ));
                    temp_tables.push(temp_name);
                } else {
                    // Fallback: inline IN list if temp table creation failed.
                    conditions.push(build_inline_in_ss(in_filter));
                }
            } else {
                conditions.push(build_inline_in_ss(in_filter));
            }
        }

        // Build SQL.
        let is_aggregate = !request.aggregates.is_empty();
        let sql = if is_aggregate {
            sql_builder::build_aggregate_sql_with_conditions(
                &SqlServerDialect,
                request,
                &conditions,
            )
        } else {
            sql_builder::build_select_sql_with_conditions(&SqlServerDialect, request, &conditions)
        };

        // Execute on the pinned connection.
        let mut query = tiberius::Query::new(&sql);
        for param in &params {
            query.bind(param.as_str());
        }
        let results = query.query(&mut *conn).await?;
        let rows: Vec<tiberius::Row> = results.into_first_result().await?;

        // Cleanup temp tables.
        for name in &temp_tables {
            let _ = conn
                .execute(
                    &sql_builder::temp_table_drop_sql(&SqlServerDialect, name),
                    &[],
                )
                .await;
        }

        if rows.is_empty() {
            return Ok(vec![]);
        }

        if is_aggregate {
            let schema = infer_schema_from_row(&rows[0])?;
            tiberius_rows_to_record_batches(&rows, &schema)
        } else {
            let arrow_schema = {
                let table = self.introspect_table(schema_name, &request.table).await?;
                let fields: Vec<Field> = if request.columns.is_empty() {
                    table
                        .columns()
                        .iter()
                        .map(|c| Field::new(c.name(), c.data_type().to_arrow(), c.nullable()))
                        .collect()
                } else {
                    request
                        .columns
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
                Schema::new(fields)
            };
            tiberius_rows_to_record_batches(&rows, &arrow_schema)
        }
    }

    /// Introspect a table's schema directly against the source catalog,
    /// bypassing the schema cache.
    ///
    /// Runs an `INFORMATION_SCHEMA.COLUMNS` query.
    /// [`Connector::introspect_table`] wraps this with the read-through
    /// [`SchemaCache`].
    async fn introspect_table_uncached(
        &self,
        schema: &str,
        table_name: &str,
    ) -> ConnectorResult<Table> {
        let mut conn = self.get_conn().await?;

        let mut query = tiberius::Query::new(
            "SELECT
                COLUMN_NAME,
                DATA_TYPE,
                IS_NULLABLE,
                NUMERIC_PRECISION,
                NUMERIC_SCALE
             FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = @P1 AND TABLE_NAME = @P2
             ORDER BY ORDINAL_POSITION",
        );
        query.bind(schema);
        query.bind(table_name);

        let results = query.query(&mut *conn).await?;
        let rows = results.into_first_result().await?;

        if rows.is_empty() {
            return Err(ConnectorError::IntrospectionFailed(format!(
                "table '[{schema}].[{table_name}]' not found or has no columns"
            )));
        }

        let mut columns = Vec::with_capacity(rows.len());
        for row in &rows {
            let col_name: &str = row.try_get(0).map_err(tib_err)?.unwrap_or_default();
            let data_type: &str = row.try_get(1).map_err(tib_err)?.unwrap_or_default();
            let is_nullable: &str = row.try_get(2).map_err(tib_err)?.unwrap_or("YES");
            let precision: Option<u8> = row.try_get(3).map_err(tib_err)?;
            let scale: Option<i32> = row.try_get(4).map_err(tib_err)?;

            let engine_type = sqlserver_type_to_engine_type(
                data_type,
                col_name,
                precision.map(|p| p as i32),
                scale,
            )?;

            let column = if is_nullable == "YES" {
                Column::new(col_name, engine_type)
            } else {
                Column::non_nullable(col_name, engine_type)
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

impl Connector for SqlServerConnector {
    async fn list_tables(&self) -> ConnectorResult<Vec<SourceTable>> {
        let mut conn = self.get_conn().await?;
        let results = conn
            .simple_query(
                "SELECT TABLE_SCHEMA, TABLE_NAME
                 FROM INFORMATION_SCHEMA.TABLES
                 WHERE TABLE_TYPE IN ('BASE TABLE', 'VIEW')
                   AND TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest')
                 ORDER BY TABLE_SCHEMA, TABLE_NAME",
            )
            .await?;
        let rows = results.into_first_result().await?;

        let mut tables = Vec::with_capacity(rows.len());
        for row in &rows {
            let schema: &str = row.try_get(0).map_err(tib_err)?.unwrap_or_default();
            let name: &str = row.try_get(1).map_err(tib_err)?.unwrap_or_default();
            tables.push(SourceTable {
                schema: schema.to_string(),
                name: name.to_string(),
            });
        }

        Ok(tables)
    }

    /// Introspect a table's schema, served from the connector's
    /// [`SchemaCache`] after the first lookup.
    ///
    /// The returned [`Table`] is identical to an uncached introspection; only
    /// the catalog round-trip is skipped. Stale after source DDL until
    /// [`SqlServerConnector::invalidate_schema_cache`] is called.
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

        let schema_name = request.schema.as_deref().unwrap_or("dbo");

        // Build Arrow schema for result conversion.
        let arrow_schema = {
            let table = self.introspect_table(schema_name, &request.table).await?;
            let fields: Vec<Field> = if request.columns.is_empty() {
                table
                    .columns()
                    .iter()
                    .map(|c| Field::new(c.name(), c.data_type().to_arrow(), c.nullable()))
                    .collect()
            } else {
                request
                    .columns
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
            Schema::new(fields)
        };

        // Build SQL query (filter values bound as `@Pn` parameters, row limit
        // rendered as `TOP(n)`).
        let (sql, params) = sql_builder::build_select_sql(&SqlServerDialect, request);

        // Execute with parameters.
        let mut conn = self.get_conn().await?;
        let mut query = tiberius::Query::new(&sql);
        for param in &params {
            query.bind(param.as_str());
        }

        let results = query.query(&mut *conn).await?;
        let rows: Vec<tiberius::Row> = results.into_first_result().await?;
        tiberius_rows_to_record_batches(&rows, &arrow_schema)
    }

    async fn execute_query(&self, sql: &str) -> ConnectorResult<Vec<RecordBatch>> {
        let mut conn = self.get_conn().await?;
        let results = conn.simple_query(sql).await?;
        let rows: Vec<tiberius::Row> = results.into_first_result().await?;

        if rows.is_empty() {
            return Ok(vec![]);
        }

        let schema = infer_schema_from_row(&rows[0])?;
        tiberius_rows_to_record_batches(&rows, &schema)
    }

    async fn row_count(&self, schema: &str, table_name: &str) -> ConnectorResult<usize> {
        // COUNT_BIG returns bigint; plain COUNT(*) errors server-side beyond
        // i32::MAX rows.
        let sql = format!(
            "SELECT COUNT_BIG(*) AS cnt FROM {}.{}",
            quote_ident_bracket(schema),
            quote_ident_bracket(table_name)
        );
        let mut conn = self.get_conn().await?;
        let results = conn.simple_query(sql).await?;
        let row = results
            .into_row()
            .await?
            .ok_or_else(|| ConnectorError::QueryFailed("no result from COUNT_BIG(*)".into()))?;
        let count: i64 = row
            .try_get(0)
            .map_err(tib_err)?
            .ok_or_else(|| ConnectorError::QueryFailed("COUNT_BIG(*) returned NULL".into()))?;
        Ok(count as usize)
    }

    /// Trait-level dispatch to
    /// [`SqlServerConnector::invalidate_schema_cache`].
    fn invalidate_schema_cache(&self) {
        self.schema_cache.invalidate_all();
    }
}

/// Infer an Arrow `Schema` from the first result row's column metadata.
fn infer_schema_from_row(row: &tiberius::Row) -> ConnectorResult<Schema> {
    use arrow::datatypes::DataType as AT;
    use arrow::datatypes::TimeUnit;

    let columns = row.columns();
    let mut fields = Vec::with_capacity(columns.len());

    for col in columns {
        let col_name = col.name();
        let arrow_type = match col.column_type() {
            tiberius::ColumnType::Int1
            | tiberius::ColumnType::Int2
            | tiberius::ColumnType::Int4 => AT::Int32,
            tiberius::ColumnType::Int8 => AT::Int64,
            tiberius::ColumnType::Float4 => AT::Float64,
            tiberius::ColumnType::Float8 => AT::Float64,
            tiberius::ColumnType::Decimaln | tiberius::ColumnType::Numericn => AT::Decimal128(
                crate::decimal::DEFAULT_DECIMAL_PRECISION,
                crate::decimal::DEFAULT_DECIMAL_SCALE,
            ),
            tiberius::ColumnType::Money | tiberius::ColumnType::Money4 => AT::Decimal128(19, 4),
            tiberius::ColumnType::Bit | tiberius::ColumnType::Bitn => AT::Boolean,
            tiberius::ColumnType::Daten => AT::Date32,
            tiberius::ColumnType::Datetime2
            | tiberius::ColumnType::Datetime
            | tiberius::ColumnType::Datetimen
            | tiberius::ColumnType::DatetimeOffsetn => AT::Timestamp(TimeUnit::Microsecond, None),
            _ => AT::Utf8, // Default to string for text types and unknowns.
        };
        fields.push(Field::new(col_name, arrow_type, true));
    }

    Ok(Schema::new(fields))
}

/// Build an inline IN condition for SQL Server.
///
/// - [`InValueKind::Integer`] (re-validated via
///   [`InFilterCondition::effective_kind`]): renders `[col] IN (1, 2, 3)` —
///   unquoted numeric literals against the uncast column, so the FK index
///   stays usable (casting the column to NVARCHAR forces a scan).
/// - [`InValueKind::Text`] (or failed integer validation): keeps the
///   existing `CAST([col] AS NVARCHAR(MAX)) IN (N'v1', ...)` form —
///   collation-sensitive text comparison is left untouched.
///
/// Values are escaped with `sql_quote_literal` and the column is escaped
/// with [`quote_ident_bracket`] so neither can break out of the IN list.
/// Delegates to the shared [`sql_builder`] inline-IN builder with the SQL
/// Server dialect.
fn build_inline_in_ss(in_filter: &InFilterCondition) -> String {
    sql_builder::build_inline_in(&SqlServerDialect, in_filter)
}

/// Convert a tiberius error into a `ConnectorError`.
fn tib_err(e: tiberius::error::Error) -> ConnectorError {
    ConnectorError::QueryFailed(format!("failed to extract column value: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::traits::{AggregateExpr, AggregateFunction, FilterCondition, FilterOperator};

    /// Test helper: build an [`InFilterCondition`] from string values.
    fn in_filter(column: &str, values: &[&str], kind: InValueKind) -> InFilterCondition {
        InFilterCondition {
            column: column.into(),
            values: values.iter().map(|v| v.to_string()).collect(),
            kind,
        }
    }

    #[test]
    fn build_inline_in_ss_escapes_injection_payload() {
        let cond = build_inline_in_ss(&in_filter(
            "color",
            &["x'); DROP TABLE t; --"],
            InValueKind::Text,
        ));
        assert_eq!(
            cond,
            "CAST([color] AS NVARCHAR(MAX)) IN (N'x''); DROP TABLE t; --')"
        );
        assert!(cond.contains("''"));
        assert!(!cond.contains("IN (N'x');"));
    }

    #[test]
    fn build_inline_in_ss_escapes_embedded_bracket_identifier() {
        let cond = build_inline_in_ss(&in_filter("evil]name", &["a"], InValueKind::Text));
        assert!(cond.starts_with("CAST([evil]]name] AS NVARCHAR(MAX)) IN"));
    }

    #[test]
    fn build_inline_in_ss_text_kind_keeps_existing_cast_form() {
        // Text path is intentionally unchanged: collation-sensitive text
        // comparison keeps the CAST + N'' literal form.
        let cond = build_inline_in_ss(&in_filter("region", &["north", "south"], InValueKind::Text));
        assert_eq!(
            cond,
            "CAST([region] AS NVARCHAR(MAX)) IN (N'north', N'south')"
        );
    }

    #[test]
    fn build_inline_in_ss_integer_kind_renders_unquoted_without_cast() {
        let cond = build_inline_in_ss(&in_filter(
            "product_id",
            &["1", "2", "3"],
            InValueKind::Integer,
        ));
        assert_eq!(cond, "[product_id] IN (1, 2, 3)");
        assert!(!cond.contains("CAST"));
        assert!(!cond.contains("N'"));
    }

    #[test]
    fn build_inline_in_ss_hostile_integer_value_falls_back_to_quoted_text() {
        // Declared Integer but contains a non-numeric payload: must be
        // re-validated and rendered escaped + quoted, never inlined raw.
        let cond = build_inline_in_ss(&in_filter(
            "product_id",
            &["1", "2); DROP TABLE t; --"],
            InValueKind::Integer,
        ));
        assert_eq!(
            cond,
            "CAST([product_id] AS NVARCHAR(MAX)) IN (N'1', N'2); DROP TABLE t; --')"
        );
        assert!(!cond.contains("IN (1, 2);"));
    }

    #[test]
    fn build_inline_in_ss_negative_and_large_integers_stay_integer() {
        let cond = build_inline_in_ss(&in_filter(
            "key",
            &["-7", "9223372036854775807"],
            InValueKind::Integer,
        ));
        assert_eq!(cond, "[key] IN (-7, 9223372036854775807)");
    }

    #[test]
    fn build_aggregate_sql_escapes_bracket_identifiers() {
        let request = FetchRequest {
            schema: Some("dbo".into()),
            table: "evil]table".into(),
            aggregates: vec![AggregateExpr {
                column: "evil]col".into(),
                function: AggregateFunction::Sum,
                alias: Some("total".into()),
            }],
            ..Default::default()
        };
        let (sql, _params) = SqlServerConnector::build_aggregate_sql(&request);
        assert!(sql.contains("[evil]]table]"), "{sql}");
        assert!(sql.contains("SUM([evil]]col])"), "{sql}");
    }

    #[test]
    fn build_aggregate_sql_simple_sum() {
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
        let (sql, params) = SqlServerConnector::build_aggregate_sql(&request);
        assert!(sql.contains("[sales].[orders]"));
        assert!(sql.contains("SUM([amount]) AS [total]"));
        assert!(params.is_empty());
    }

    #[test]
    fn build_aggregate_sql_with_filter() {
        let request = FetchRequest {
            schema: Some("dbo".into()),
            table: "orders".into(),
            aggregates: vec![AggregateExpr {
                column: "id".into(),
                function: AggregateFunction::Count,
                alias: Some("cnt".into()),
            }],
            filters: vec![FilterCondition::new("status", FilterOperator::Equal, "active")],
            ..Default::default()
        };
        let (sql, params) = SqlServerConnector::build_aggregate_sql(&request);
        assert!(sql.contains("@P1"));
        assert!(sql.contains("CAST([status] AS NVARCHAR(MAX))"));
        assert_eq!(params, vec!["active".to_string()]);
    }

    #[test]
    fn build_aggregate_sql_with_group_by() {
        let request = FetchRequest {
            schema: Some("dbo".into()),
            table: "sales".into(),
            aggregates: vec![AggregateExpr {
                column: "amount".into(),
                function: AggregateFunction::Sum,
                alias: Some("total".into()),
            }],
            group_by: vec!["region".into()],
            ..Default::default()
        };
        let (sql, _) = SqlServerConnector::build_aggregate_sql(&request);
        assert!(sql.contains("GROUP BY [region]"));
        assert!(sql.contains("[region]"));
    }

    #[test]
    fn build_aggregate_sql_with_top_limit() {
        let request = FetchRequest {
            schema: Some("dbo".into()),
            table: "sales".into(),
            aggregates: vec![AggregateExpr {
                column: "id".into(),
                function: AggregateFunction::Count,
                alias: Some("cnt".into()),
            }],
            limit: Some(10),
            ..Default::default()
        };
        let (sql, _) = SqlServerConnector::build_aggregate_sql(&request);
        assert!(sql.contains("TOP(10)"));
    }

    #[test]
    fn build_aggregate_sql_count_distinct() {
        let request = FetchRequest {
            schema: Some("dbo".into()),
            table: "orders".into(),
            aggregates: vec![AggregateExpr {
                column: "customer_id".into(),
                function: AggregateFunction::CountDistinct,
                alias: Some("unique_customers".into()),
            }],
            ..Default::default()
        };
        let (sql, _) = SqlServerConnector::build_aggregate_sql(&request);
        assert!(sql.contains("COUNT(DISTINCT [customer_id]) AS [unique_customers]"));
    }

    #[test]
    fn build_aggregate_sql_default_schema_is_dbo() {
        let request = FetchRequest {
            schema: None,
            table: "orders".into(),
            aggregates: vec![AggregateExpr {
                column: "id".into(),
                function: AggregateFunction::Count,
                alias: None,
            }],
            ..Default::default()
        };
        let (sql, _) = SqlServerConnector::build_aggregate_sql(&request);
        assert!(sql.contains("[dbo].[orders]"));
    }

    #[test]
    fn build_settings_integrated() {
        let target = ConnectionTarget::new("sqlhost", "warehouse")
            .with_port(1434)
            .with_trust_server_certificate(true);
        let settings = SqlServerConnector::build_settings(&target, AuthMethod::Integrated).unwrap();
        assert_eq!(settings.host, "sqlhost");
        assert_eq!(settings.port, 1434);
        assert_eq!(settings.database, "warehouse");
        assert_eq!(settings.auth, ResolvedSqlServerAuth::Integrated);
        assert!(settings.trust_server_certificate);
    }

    #[test]
    fn build_settings_username_password() {
        let target = ConnectionTarget::new("dbserver", "mydb");
        let auth = AuthMethod::UsernamePassword {
            username: "sa".into(),
            password: "Pass123!".into(),
        };
        let settings = SqlServerConnector::build_settings(&target, auth).unwrap();
        assert_eq!(settings.port, 1433);
        assert_eq!(
            settings.auth,
            ResolvedSqlServerAuth::SqlServer {
                username: "sa".into(),
                password: "Pass123!".into(),
            }
        );
    }

    #[test]
    fn build_settings_default_port() {
        let target = ConnectionTarget::new("host", "db");
        let auth = AuthMethod::UsernamePassword {
            username: "u".into(),
            password: "p".into(),
        };
        let settings = SqlServerConnector::build_settings(&target, auth).unwrap();
        assert_eq!(settings.port, 1433);
    }

    #[test]
    fn build_settings_no_trust_cert_by_default() {
        let target = ConnectionTarget::new("host", "db");
        let settings = SqlServerConnector::build_settings(&target, AuthMethod::Integrated).unwrap();
        assert!(!settings.trust_server_certificate);
    }

    #[test]
    fn build_settings_env_var_missing() {
        let target = ConnectionTarget::new("host", "db");
        let auth = AuthMethod::EnvironmentVariable {
            username_var: "__CALCULA_TEST_NONEXISTENT_USER__".into(),
            password_var: "__CALCULA_TEST_NONEXISTENT_PASS__".into(),
        };
        let err = SqlServerConnector::build_settings(&target, auth).unwrap_err();
        assert!(err.to_string().contains("environment variable"));
    }

    #[test]
    fn build_settings_hostile_database_stays_literal() {
        // An ADO-string build would have parsed this as three separate
        // options (TLS downgrade injection). With typed settings it must
        // remain the literal database name and not flip any flags.
        let target = ConnectionTarget::new("host", "db;TrustServerCertificate=true;Encrypt=false");
        let auth = AuthMethod::UsernamePassword {
            username: "u".into(),
            password: "p".into(),
        };
        let settings = SqlServerConnector::build_settings(&target, auth).unwrap();
        assert_eq!(
            settings.database,
            "db;TrustServerCertificate=true;Encrypt=false"
        );
        assert_eq!(settings.host, "host");
        assert!(!settings.trust_server_certificate);
    }

    #[test]
    fn build_settings_hostile_password_stays_literal() {
        let target = ConnectionTarget::new("host", "db");
        let auth = AuthMethod::UsernamePassword {
            username: "u".into(),
            password: "p;Server=evil;Encrypt=false".into(),
        };
        let settings = SqlServerConnector::build_settings(&target, auth).unwrap();
        assert_eq!(settings.host, "host");
        assert_eq!(
            settings.auth,
            ResolvedSqlServerAuth::SqlServer {
                username: "u".into(),
                password: "p;Server=evil;Encrypt=false".into(),
            }
        );
    }

    #[test]
    fn build_settings_nul_byte_in_database_is_rejected() {
        let target = ConnectionTarget::new("host", "db\0evil");
        let err = SqlServerConnector::build_settings(&target, AuthMethod::Integrated).unwrap_err();
        assert!(matches!(
            err,
            ConnectorError::InvalidConnectionParameter { ref parameter, .. }
                if parameter == "database"
        ));
    }

    #[test]
    fn settings_to_config_accepts_sql_server_auth() {
        let settings = SqlServerConnectionSettings {
            host: "host".into(),
            port: 1433,
            database: "db".into(),
            auth: ResolvedSqlServerAuth::SqlServer {
                username: "u".into(),
                password: "p".into(),
            },
            trust_server_certificate: true,
        };
        let config = SqlServerConnector::settings_to_config(settings).unwrap();
        assert_eq!(config.get_addr(), "host:1433");
    }

    #[cfg(windows)]
    #[test]
    fn settings_to_config_accepts_integrated_auth_on_windows() {
        let settings = SqlServerConnectionSettings {
            host: "sqlhost".into(),
            port: 1434,
            database: "warehouse".into(),
            auth: ResolvedSqlServerAuth::Integrated,
            trust_server_certificate: false,
        };
        let config = SqlServerConnector::settings_to_config(settings).unwrap();
        assert_eq!(config.get_addr(), "sqlhost:1434");
    }

    #[test]
    fn supported_auth_methods_includes_integrated() {
        let methods = SqlServerConnector::supported_auth_methods();
        assert!(methods.contains(&AuthMethodKind::Integrated));
        assert!(methods.contains(&AuthMethodKind::UsernamePassword));
        assert!(methods.contains(&AuthMethodKind::EnvironmentVariable));
    }
}
