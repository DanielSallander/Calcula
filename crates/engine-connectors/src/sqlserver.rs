//! SQL Server connector using `tiberius` with `bb8` connection pooling.

use arrow::datatypes::{Field, Schema};
use arrow::record_batch::RecordBatch;
use bb8::Pool;
use bb8_tiberius::ConnectionManager;
use engine_core::model::{Column, Table};
use tiberius::Config;

use crate::error::{ConnectorError, ConnectorResult};
use crate::sqlserver_convert::tiberius_rows_to_record_batches;
use crate::traits::{Connector, FetchRequest, SourceTable};
use crate::type_mapping::sqlserver_type_to_engine_type;

/// Configuration for connecting to a SQL Server database.
#[derive(Debug, Clone)]
pub struct SqlServerConfig {
    /// ADO.NET-style connection string, e.g.
    /// `"server=tcp:localhost,1433;user=sa;password=Pass;database=MyDb;TrustServerCertificate=true"`.
    pub connection_string: String,
    /// Maximum number of connections in the pool (default: 5).
    pub max_connections: u32,
}

impl SqlServerConfig {
    /// Create a new configuration with the given connection string.
    pub fn new(connection_string: impl Into<String>) -> Self {
        Self {
            connection_string: connection_string.into(),
            max_connections: 5,
        }
    }

    /// Set the maximum number of connections in the pool.
    pub fn with_max_connections(mut self, max: u32) -> Self {
        self.max_connections = max;
        self
    }
}

/// SQL Server connector using `tiberius` with `bb8` connection pooling.
pub struct SqlServerConnector {
    pool: Pool<ConnectionManager>,
}

impl SqlServerConnector {
    /// Connect to a SQL Server database.
    pub async fn connect(config: SqlServerConfig) -> ConnectorResult<Self> {
        let tib_config = Config::from_ado_string(&config.connection_string)
            .map_err(|e| ConnectorError::ConnectionFailed(e.to_string()))?;

        let mgr = ConnectionManager::build(tib_config)
            .map_err(|e| ConnectorError::ConnectionFailed(e.to_string()))?;

        let pool = Pool::builder()
            .max_size(config.max_connections)
            .build(mgr)
            .await
            .map_err(|e| ConnectorError::ConnectionFailed(e.to_string()))?;

        Ok(Self { pool })
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
    fn build_aggregate_sql(request: &FetchRequest) -> (String, Vec<String>) {
        let schema_name = request.schema.as_deref().unwrap_or("dbo");
        let table_ref = format!("[{schema_name}].[{table}]", table = request.table);

        // SELECT group_by columns + aggregate expressions.
        let mut select_parts: Vec<String> =
            request.group_by.iter().map(|c| format!("[{c}]")).collect();

        for agg in &request.aggregates {
            let func = agg.function.as_sql();
            let col = &agg.column;
            let default_alias = format!("{}_{}", func.to_lowercase(), col);
            let alias = agg.alias.as_deref().unwrap_or(&default_alias);
            if agg.function == crate::traits::AggregateFunction::CountDistinct {
                select_parts.push(format!("{func}(DISTINCT [{col}]) AS [{alias}]"));
            } else if agg.function == crate::traits::AggregateFunction::CountAll {
                select_parts.push(format!("COUNT(*) AS [{alias}]"));
            } else {
                select_parts.push(format!("{func}([{col}]) AS [{alias}]"));
            }
        }

        let select_clause = select_parts.join(", ");

        // TOP for LIMIT (SQL Server syntax).
        let top_clause = request
            .limit
            .map(|n| format!("TOP({n}) "))
            .unwrap_or_default();

        let mut sql = format!("SELECT {top_clause}{select_clause} FROM {table_ref}");

        // WHERE clause.
        let mut params: Vec<String> = Vec::new();
        let has_conditions = !request.filters.is_empty() || !request.in_filters.is_empty();
        if has_conditions {
            let mut conditions = Vec::new();
            for filter in &request.filters {
                params.push(filter.value.clone());
                let param_idx = params.len();
                conditions.push(format!(
                    "CAST([{}] AS NVARCHAR(MAX)) {} @P{}",
                    filter.column,
                    filter.operator.as_sql(),
                    param_idx
                ));
            }
            for in_filter in &request.in_filters {
                if !in_filter.values.is_empty() {
                    let quoted: Vec<String> = in_filter
                        .values
                        .iter()
                        .map(|v| format!("N'{}'", v.replace('\'', "''")))
                        .collect();
                    conditions.push(format!(
                        "CAST([{}] AS NVARCHAR(MAX)) IN ({})",
                        in_filter.column,
                        quoted.join(", ")
                    ));
                }
            }
            sql.push_str(" WHERE ");
            sql.push_str(&conditions.join(" AND "));
        }

        // GROUP BY clause.
        if !request.group_by.is_empty() {
            let group_clause: Vec<String> =
                request.group_by.iter().map(|c| format!("[{c}]")).collect();
            sql.push_str(" GROUP BY ");
            sql.push_str(&group_clause.join(", "));
        }

        (sql, params)
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

    async fn introspect_table(&self, schema: &str, table_name: &str) -> ConnectorResult<Table> {
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

    async fn fetch_data(&self, request: &FetchRequest) -> ConnectorResult<Vec<RecordBatch>> {
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

        // Build SQL query.
        let select_clause = if request.columns.is_empty() {
            "*".to_string()
        } else {
            request
                .columns
                .iter()
                .map(|c| format!("[{c}]"))
                .collect::<Vec<_>>()
                .join(", ")
        };

        let table_ref = format!("[{schema_name}].[{table}]", table = request.table);

        // TOP for LIMIT.
        let top_clause = request
            .limit
            .map(|n| format!("TOP({n}) "))
            .unwrap_or_default();

        let mut sql = format!("SELECT {top_clause}{select_clause} FROM {table_ref}");

        // WHERE clause.
        let mut params: Vec<String> = Vec::new();
        let has_conditions = !request.filters.is_empty() || !request.in_filters.is_empty();
        if has_conditions {
            let mut conditions = Vec::new();
            for filter in &request.filters {
                params.push(filter.value.clone());
                let param_idx = params.len();
                conditions.push(format!(
                    "CAST([{}] AS NVARCHAR(MAX)) {} @P{}",
                    filter.column,
                    filter.operator.as_sql(),
                    param_idx
                ));
            }
            for in_filter in &request.in_filters {
                if !in_filter.values.is_empty() {
                    let quoted: Vec<String> = in_filter
                        .values
                        .iter()
                        .map(|v| format!("N'{}'", v.replace('\'', "''")))
                        .collect();
                    conditions.push(format!(
                        "CAST([{}] AS NVARCHAR(MAX)) IN ({})",
                        in_filter.column,
                        quoted.join(", ")
                    ));
                }
            }
            sql.push_str(" WHERE ");
            sql.push_str(&conditions.join(" AND "));
        }

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
        let sql = format!("SELECT COUNT(*) AS cnt FROM [{schema}].[{table_name}]");
        let mut conn = self.get_conn().await?;
        let results = conn.simple_query(sql).await?;
        let row = results
            .into_row()
            .await?
            .ok_or_else(|| ConnectorError::QueryFailed("no result from COUNT(*)".into()))?;
        let count: i32 = row.try_get(0).map_err(tib_err)?.unwrap_or(0);
        Ok(count as usize)
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
            tiberius::ColumnType::Decimaln | tiberius::ColumnType::Numericn => {
                AT::Decimal128(38, 10)
            }
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

/// Convert a tiberius error into a `ConnectorError`.
fn tib_err(e: tiberius::error::Error) -> ConnectorError {
    ConnectorError::QueryFailed(format!("failed to extract column value: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::traits::{AggregateExpr, AggregateFunction, FilterCondition, FilterOperator};

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
            filters: vec![FilterCondition {
                column: "status".into(),
                operator: FilterOperator::Equal,
                value: "active".into(),
            }],
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
}
