//! Table definition for the data model.

use std::hash::{Hash, Hasher};

use arrow::datatypes::{Field, Schema};
use serde::{Deserialize, Serialize};

use crate::error::{EngineError, EngineResult};
use crate::model::column::Column;

/// Controls how table data is sourced at query time.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StorageMode {
    /// Data is fetched from the source connector on every query (default).
    #[default]
    DirectQuery,
    /// Data is pre-loaded into memory and served from cache.
    InMemory,
}

impl StorageMode {
    /// Returns `true` if the storage mode is `DirectQuery`.
    fn is_direct_query(&self) -> bool {
        *self == Self::DirectQuery
    }
}

/// Strategy that determines when an in-memory table should be refreshed.
///
/// Multiple strategies can be combined on a single table — if **any** strategy
/// signals a refresh, the table is refreshed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RefreshStrategy {
    /// Refresh after a fixed duration has elapsed since the last refresh.
    Interval {
        /// Number of seconds before the cache is considered stale.
        secs: u64,
    },

    /// Refresh if the cached data does not contain today's date in the
    /// specified column. Ideal for date/calendar dimension tables.
    ContainsCurrentDate {
        /// Name of the date column to check (must be a `Date` column).
        column: String,
    },

    /// Refresh once daily after a specific wall-clock time (local time).
    /// Useful for tables fed by nightly ETL jobs.
    ///
    /// Out-of-range values (hour > 23 or minute > 59) are clamped to the
    /// valid range at evaluation time because strategies deserialized from
    /// model files bypass construction-time checks. Hosts can call
    /// [`RefreshStrategy::validate`] to detect out-of-range values eagerly.
    DailyAfter {
        /// Hour (0–23) in local time.
        hour: u8,
        /// Minute (0–59) in local time.
        minute: u8,
    },

    /// Refresh when a source-side query returns a different value than last
    /// time. Ideal for ETL-driven tables where the ETL process writes a
    /// completion timestamp or version to a log table.
    ///
    /// The SQL must return exactly one row with one column (a scalar value).
    /// The result is compared as a string against the previously stored
    /// fingerprint. If different (or if no fingerprint is stored yet), the
    /// table is refreshed.
    ///
    /// # Security
    ///
    /// Model files are shared between users, so this SQL crosses a trust
    /// boundary. The engine validates it with
    /// [`RefreshStrategy::validate_source_query_sql`] before execution
    /// (exactly one statement, SELECT only), and hosts can disable
    /// model-supplied SQL entirely via the engine's source-query policy.
    ///
    /// # Example
    ///
    /// ```text
    /// sql: "SELECT MAX(loaded_at) FROM etl_log WHERE table_name = 'products'"
    /// ```
    SourceQuery {
        /// SQL query returning a single scalar value (one row, one column).
        sql: String,
        /// Which model table's connector to use for running the query.
        /// If `None`, uses this table's own connector.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source_table: Option<String>,
    },
}

impl RefreshStrategy {
    /// Returns `true` if this strategy requires I/O (e.g., a database query)
    /// and cannot be evaluated against cached data alone.
    pub fn requires_io(&self) -> bool {
        matches!(self, Self::SourceQuery { .. })
    }

    /// Validate this strategy's parameters.
    ///
    /// Checks that [`DailyAfter`](Self::DailyAfter) `hour` is 0–23 and
    /// `minute` is 0–59. Other strategies always pass.
    ///
    /// Construction goes through the infallible builder method
    /// [`Table::with_refresh_strategy`] (and model files bypass construction
    /// entirely), so out-of-range values cannot be rejected at build time
    /// without breaking the builder pattern. Evaluation clamps them
    /// defensively; this method lets hosts surface the problem eagerly.
    pub fn validate(&self) -> EngineResult<()> {
        match self {
            Self::DailyAfter { hour, minute } => {
                if *hour > 23 || *minute > 59 {
                    Err(EngineError::InvalidData(format!(
                        "Invalid DailyAfter refresh strategy: hour must be 0-23 and \
                         minute 0-59 (got {hour}:{minute:02})"
                    )))
                } else {
                    Ok(())
                }
            }
            _ => Ok(()),
        }
    }

    /// Validate that a [`SourceQuery`](Self::SourceQuery) poll SQL is safe to
    /// send to a connector.
    ///
    /// Model files are shared between users, so the poll SQL crosses a trust
    /// boundary: on SQL Server the connector executes it as a raw T-SQL
    /// batch, which would otherwise allow multi-statement payloads like
    /// `SELECT 1; DROP TABLE x;`. This check requires the SQL to parse as
    /// **exactly one** statement, and that statement must be a plain query
    /// (`SELECT`, including CTE-wrapped selects). DML, DDL, multi-statement
    /// batches, `SELECT ... INTO`, and data-modifying CTEs are rejected with
    /// [`EngineError::SourceQueryRejected`].
    ///
    /// `table` is used only for error reporting (the table whose connector
    /// would run the query).
    pub fn validate_source_query_sql(table: &str, sql: &str) -> EngineResult<()> {
        use datafusion::sql::sqlparser::ast::Statement;
        use datafusion::sql::sqlparser::dialect::GenericDialect;
        use datafusion::sql::sqlparser::parser::Parser;

        let reject = |reason: String| EngineError::SourceQueryRejected {
            table: table.to_string(),
            reason,
        };

        let statements = Parser::parse_sql(&GenericDialect {}, sql)
            .map_err(|e| reject(format!("SQL parse error: {e}")))?;

        if statements.len() != 1 {
            return Err(reject(format!(
                "expected exactly one SQL statement, found {}",
                statements.len()
            )));
        }

        match &statements[0] {
            Statement::Query(query) if query_is_read_only(query) => Ok(()),
            Statement::Query(_) => Err(reject(
                "query contains a data-modifying construct (e.g. SELECT INTO or a \
                 writing CTE), which is not permitted for source-query polling"
                    .to_string(),
            )),
            _ => Err(reject(
                "only a single SELECT statement is permitted for source-query polling".to_string(),
            )),
        }
    }
}

/// Returns `true` if the query (including its CTEs) contains only read-only
/// constructs. Used by [`RefreshStrategy::validate_source_query_sql`].
fn query_is_read_only(query: &datafusion::sql::sqlparser::ast::Query) -> bool {
    if let Some(with) = &query.with {
        if !with
            .cte_tables
            .iter()
            .all(|cte| query_is_read_only(&cte.query))
        {
            return false;
        }
    }
    set_expr_is_read_only(&query.body)
}

/// Returns `true` if a set expression is read-only (no `SELECT INTO`, no
/// embedded INSERT/UPDATE set expressions). Unknown/future variants are
/// conservatively treated as not read-only.
fn set_expr_is_read_only(expr: &datafusion::sql::sqlparser::ast::SetExpr) -> bool {
    use datafusion::sql::sqlparser::ast::SetExpr;

    match expr {
        SetExpr::Select(select) => select.into.is_none(),
        SetExpr::Query(query) => query_is_read_only(query),
        SetExpr::SetOperation { left, right, .. } => {
            set_expr_is_read_only(left) && set_expr_is_read_only(right)
        }
        SetExpr::Values(_) => true,
        // INSERT/UPDATE set expressions and any future variants: reject.
        _ => false,
    }
}

/// A table definition: a named collection of typed columns.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Table {
    name: String,
    columns: Vec<Column>,
    #[serde(default, skip_serializing_if = "StorageMode::is_direct_query")]
    storage_mode: StorageMode,
    /// Strategies that determine when cached data should be refreshed.
    /// If **any** strategy signals staleness, the table is refreshed.
    /// Only meaningful when `storage_mode` is `InMemory`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    refresh_strategies: Vec<RefreshStrategy>,
}

impl Table {
    /// Create a new table with the given name and columns.
    ///
    /// Returns an error if column names are not unique.
    pub fn new(name: impl Into<String>, columns: Vec<Column>) -> EngineResult<Self> {
        let name = name.into();
        // Validate uniqueness of column names.
        let mut seen = std::collections::HashSet::new();
        for col in &columns {
            if !seen.insert(col.name()) {
                return Err(EngineError::DuplicateName(format!(
                    "Duplicate column '{}' in table '{}'",
                    col.name(),
                    name
                )));
            }
        }
        Ok(Self {
            name,
            columns,
            storage_mode: StorageMode::default(),
            refresh_strategies: Vec::new(),
        })
    }

    /// Returns the table name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the columns in this table.
    pub fn columns(&self) -> &[Column] {
        &self.columns
    }

    /// Look up a column by name.
    pub fn column(&self, name: &str) -> EngineResult<&Column> {
        self.columns
            .iter()
            .find(|c| c.name() == name)
            .ok_or_else(|| EngineError::ColumnNotFound {
                table: self.name.clone(),
                column: name.to_string(),
            })
    }

    /// Returns the effective sort column name for a given column.
    ///
    /// If the column has a `sort_by_column` set, returns that column name.
    /// Otherwise returns the column's own name (natural sort).
    pub fn sort_column_for<'a>(&'a self, column_name: &'a str) -> EngineResult<&'a str> {
        let col = self.column(column_name)?;
        Ok(col.sort_by_column().unwrap_or(column_name))
    }

    /// Convert this table definition to an Arrow schema.
    pub fn to_arrow_schema(&self) -> Schema {
        let fields: Vec<Field> = self
            .columns
            .iter()
            .map(|col| Field::new(col.name(), col.data_type().to_arrow(), col.nullable()))
            .collect();
        Schema::new(fields)
    }

    /// Set the storage mode for this table.
    pub fn with_storage_mode(mut self, mode: StorageMode) -> Self {
        self.storage_mode = mode;
        self
    }

    /// Returns the storage mode for this table.
    pub fn storage_mode(&self) -> &StorageMode {
        &self.storage_mode
    }

    /// Returns `true` if this table uses in-memory storage.
    pub fn is_in_memory(&self) -> bool {
        self.storage_mode == StorageMode::InMemory
    }

    /// Add a refresh strategy to this table.
    ///
    /// Multiple strategies can be combined — if **any** strategy signals
    /// staleness, the table is refreshed. Only meaningful when `storage_mode`
    /// is `InMemory`.
    pub fn with_refresh_strategy(mut self, strategy: RefreshStrategy) -> Self {
        self.refresh_strategies.push(strategy);
        self
    }

    /// Convenience: add an interval-based refresh strategy (TTL).
    ///
    /// Equivalent to `with_refresh_strategy(RefreshStrategy::Interval { secs })`.
    pub fn with_refresh_interval(self, interval: std::time::Duration) -> Self {
        self.with_refresh_strategy(RefreshStrategy::Interval {
            secs: interval.as_secs(),
        })
    }

    /// Returns the configured refresh strategies.
    pub fn refresh_strategies(&self) -> &[RefreshStrategy] {
        &self.refresh_strategies
    }

    /// Returns only the strategies that can be evaluated locally (no I/O).
    pub fn local_refresh_strategies(&self) -> Vec<&RefreshStrategy> {
        self.refresh_strategies
            .iter()
            .filter(|s| !s.requires_io())
            .collect()
    }

    /// Returns only the strategies that require I/O (source queries).
    pub fn io_refresh_strategies(&self) -> Vec<&RefreshStrategy> {
        self.refresh_strategies
            .iter()
            .filter(|s| s.requires_io())
            .collect()
    }

    /// Compute a deterministic hash of this table's schema (column names,
    /// types, and nullability in order).
    ///
    /// Used to detect whether cached data on disk is still compatible with the
    /// current model. A different hash means the schema has changed and the
    /// cached data should be discarded.
    pub fn schema_hash(&self) -> String {
        use std::collections::hash_map::DefaultHasher;

        let mut hasher = DefaultHasher::new();
        for col in &self.columns {
            col.name().hash(&mut hasher);
            // Hash the debug representation of DataType which uniquely
            // identifies each variant including Decimal(p, s).
            format!("{:?}", col.data_type()).hash(&mut hasher);
            col.nullable().hash(&mut hasher);
        }
        format!("{:016x}", hasher.finish())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::DataType;
    use std::time::Duration;

    fn make_table(name: &str) -> Table {
        Table::new(name, vec![Column::new("id", DataType::Int64)]).unwrap()
    }

    #[test]
    fn refresh_strategies_default_empty() {
        let table = make_table("t");
        assert!(table.refresh_strategies().is_empty());
    }

    #[test]
    fn with_refresh_interval_adds_interval_strategy() {
        let table = make_table("t").with_refresh_interval(Duration::from_secs(300));
        let strategies = table.refresh_strategies();
        assert_eq!(strategies.len(), 1);
        assert_eq!(strategies[0], RefreshStrategy::Interval { secs: 300 });
    }

    #[test]
    fn with_refresh_strategy_adds_strategy() {
        let table = make_table("t").with_refresh_strategy(RefreshStrategy::ContainsCurrentDate {
            column: "date".to_string(),
        });
        let strategies = table.refresh_strategies();
        assert_eq!(strategies.len(), 1);
        assert!(matches!(
            &strategies[0],
            RefreshStrategy::ContainsCurrentDate { column } if column == "date"
        ));
    }

    #[test]
    fn multiple_strategies_combined() {
        let table = make_table("t")
            .with_refresh_interval(Duration::from_secs(300))
            .with_refresh_strategy(RefreshStrategy::ContainsCurrentDate {
                column: "date".to_string(),
            })
            .with_refresh_strategy(RefreshStrategy::DailyAfter { hour: 6, minute: 0 });
        assert_eq!(table.refresh_strategies().len(), 3);
    }

    #[test]
    fn refresh_strategies_serialization_roundtrip() {
        let table = make_table("t")
            .with_storage_mode(StorageMode::InMemory)
            .with_refresh_interval(Duration::from_secs(600))
            .with_refresh_strategy(RefreshStrategy::ContainsCurrentDate {
                column: "date".to_string(),
            });

        let json = serde_json::to_string(&table).unwrap();
        assert!(json.contains("\"refresh_strategies\""));
        assert!(json.contains("\"interval\""));
        assert!(json.contains("\"contains_current_date\""));

        let deserialized: Table = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.refresh_strategies().len(), 2);
    }

    #[test]
    fn strategies_not_serialized_when_empty() {
        let table = make_table("t").with_storage_mode(StorageMode::InMemory);
        let json = serde_json::to_string(&table).unwrap();
        assert!(!json.contains("refresh_strategies"));
    }

    #[test]
    fn source_query_serialization_roundtrip() {
        let table = make_table("t")
            .with_storage_mode(StorageMode::InMemory)
            .with_refresh_strategy(RefreshStrategy::SourceQuery {
                sql: "SELECT MAX(loaded_at) FROM etl_log".to_string(),
                source_table: Some("etl_log".to_string()),
            });

        let json = serde_json::to_string(&table).unwrap();
        assert!(json.contains("\"source_query\""));
        assert!(json.contains("etl_log"));

        let deserialized: Table = serde_json::from_str(&json).unwrap();
        let strategies = deserialized.refresh_strategies();
        assert_eq!(strategies.len(), 1);
        assert!(matches!(
            &strategies[0],
            RefreshStrategy::SourceQuery { sql, source_table }
                if sql.contains("etl_log") && *source_table == Some("etl_log".to_string())
        ));
    }

    #[test]
    fn source_query_without_source_table_omits_field() {
        let table = make_table("t")
            .with_storage_mode(StorageMode::InMemory)
            .with_refresh_strategy(RefreshStrategy::SourceQuery {
                sql: "SELECT 1".to_string(),
                source_table: None,
            });

        let json = serde_json::to_string(&table).unwrap();
        assert!(!json.contains("source_table"));

        let deserialized: Table = serde_json::from_str(&json).unwrap();
        assert!(matches!(
            &deserialized.refresh_strategies()[0],
            RefreshStrategy::SourceQuery { source_table, .. } if source_table.is_none()
        ));
    }

    #[test]
    fn requires_io_only_for_source_query() {
        assert!(!RefreshStrategy::Interval { secs: 60 }.requires_io());
        assert!(!RefreshStrategy::ContainsCurrentDate { column: "d".into() }.requires_io());
        assert!(!RefreshStrategy::DailyAfter { hour: 6, minute: 0 }.requires_io());
        assert!(RefreshStrategy::SourceQuery {
            sql: "SELECT 1".into(),
            source_table: None,
        }
        .requires_io());
    }

    #[test]
    fn local_and_io_strategies_split() {
        let table = make_table("t")
            .with_refresh_interval(Duration::from_secs(300))
            .with_refresh_strategy(RefreshStrategy::SourceQuery {
                sql: "SELECT 1".to_string(),
                source_table: None,
            });
        assert_eq!(table.local_refresh_strategies().len(), 1);
        assert_eq!(table.io_refresh_strategies().len(), 1);
    }

    #[test]
    fn schema_hash_deterministic() {
        let t1 = make_table("t");
        let t2 = make_table("t");
        assert_eq!(t1.schema_hash(), t2.schema_hash());
    }

    #[test]
    fn schema_hash_differs_on_column_name_change() {
        let t1 = Table::new("t", vec![Column::new("id", DataType::Int64)]).unwrap();
        let t2 = Table::new("t", vec![Column::new("key", DataType::Int64)]).unwrap();
        assert_ne!(t1.schema_hash(), t2.schema_hash());
    }

    #[test]
    fn schema_hash_differs_on_type_change() {
        let t1 = Table::new("t", vec![Column::new("id", DataType::Int64)]).unwrap();
        let t2 = Table::new("t", vec![Column::new("id", DataType::Int32)]).unwrap();
        assert_ne!(t1.schema_hash(), t2.schema_hash());
    }

    #[test]
    fn schema_hash_differs_on_nullable_change() {
        let t1 = Table::new("t", vec![Column::new("id", DataType::Int64)]).unwrap();
        let t2 = Table::new("t", vec![Column::non_nullable("id", DataType::Int64)]).unwrap();
        assert_ne!(t1.schema_hash(), t2.schema_hash());
    }

    #[test]
    fn schema_hash_differs_on_column_order() {
        let t1 = Table::new(
            "t",
            vec![
                Column::new("a", DataType::Int64),
                Column::new("b", DataType::String),
            ],
        )
        .unwrap();
        let t2 = Table::new(
            "t",
            vec![
                Column::new("b", DataType::String),
                Column::new("a", DataType::Int64),
            ],
        )
        .unwrap();
        assert_ne!(t1.schema_hash(), t2.schema_hash());
    }

    #[test]
    fn schema_hash_differs_on_column_added() {
        let t1 = Table::new("t", vec![Column::new("id", DataType::Int64)]).unwrap();
        let t2 = Table::new(
            "t",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("name", DataType::String),
            ],
        )
        .unwrap();
        assert_ne!(t1.schema_hash(), t2.schema_hash());
    }

    #[test]
    fn validate_source_query_accepts_plain_select() {
        assert!(RefreshStrategy::validate_source_query_sql(
            "products",
            "SELECT MAX(loaded_at) FROM etl_log WHERE table_name = 'products'"
        )
        .is_ok());
    }

    #[test]
    fn validate_source_query_accepts_cte_wrapped_select() {
        assert!(RefreshStrategy::validate_source_query_sql(
            "products",
            "WITH latest AS (SELECT MAX(loaded_at) AS v FROM etl_log) SELECT v FROM latest"
        )
        .is_ok());
    }

    #[test]
    fn validate_source_query_rejects_multi_statement_batch() {
        let result =
            RefreshStrategy::validate_source_query_sql("products", "SELECT 1; DROP TABLE x;");
        assert!(matches!(
            result.unwrap_err(),
            EngineError::SourceQueryRejected { table, .. } if table == "products"
        ));
    }

    #[test]
    fn validate_source_query_rejects_ddl() {
        assert!(matches!(
            RefreshStrategy::validate_source_query_sql("t", "DROP TABLE users").unwrap_err(),
            EngineError::SourceQueryRejected { .. }
        ));
    }

    #[test]
    fn validate_source_query_rejects_dml() {
        for sql in [
            "UPDATE t SET a = 1",
            "DELETE FROM t",
            "INSERT INTO t VALUES (1)",
        ] {
            assert!(
                matches!(
                    RefreshStrategy::validate_source_query_sql("t", sql),
                    Err(EngineError::SourceQueryRejected { .. })
                ),
                "expected rejection for: {sql}"
            );
        }
    }

    #[test]
    fn validate_source_query_rejects_select_into() {
        assert!(
            RefreshStrategy::validate_source_query_sql("t", "SELECT * INTO backup FROM users")
                .is_err()
        );
    }

    #[test]
    fn validate_source_query_rejects_empty_and_garbage() {
        assert!(RefreshStrategy::validate_source_query_sql("t", "").is_err());
        assert!(RefreshStrategy::validate_source_query_sql("t", "not sql at all").is_err());
    }

    #[test]
    fn validate_rejects_out_of_range_daily_after() {
        assert!(RefreshStrategy::DailyAfter {
            hour: 24,
            minute: 0
        }
        .validate()
        .is_err());
        assert!(RefreshStrategy::DailyAfter {
            hour: 6,
            minute: 60
        }
        .validate()
        .is_err());
        assert!(RefreshStrategy::DailyAfter {
            hour: 23,
            minute: 59
        }
        .validate()
        .is_ok());
        assert!(RefreshStrategy::Interval { secs: 60 }.validate().is_ok());
    }

    #[test]
    fn schema_hash_ignores_table_name() {
        let t1 = Table::new("foo", vec![Column::new("id", DataType::Int64)]).unwrap();
        let t2 = Table::new("bar", vec![Column::new("id", DataType::Int64)]).unwrap();
        // Same columns → same schema hash (table name is not part of schema).
        assert_eq!(t1.schema_hash(), t2.schema_hash());
    }
}
