//! Source registry: maps data model tables to their data source connectors.

use std::collections::HashMap;

use arrow::record_batch::RecordBatch;
use engine_connectors::auth::{AuthMethodKind, ConnectorAuth};
use engine_connectors::postgres::PostgresConnector;
use engine_connectors::sqlserver::SqlServerConnector;
use engine_connectors::traits::{Connector, ConnectorCapabilities, FetchRequest, SourceTable};
use engine_connectors::ConnectorResult;
use engine_core::model::Table;

use crate::csv_connector::CsvConnector;
use crate::in_memory_connector::InMemoryConnector;
use crate::parquet_connector::ParquetConnector;

use crate::error::{QueryError, QueryResult};

/// Identifies a table within a data source (schema + table name).
#[derive(Debug, Clone)]
pub struct SourceBinding {
    /// Source schema name (e.g., `"sales"`, `"BI"`).
    pub schema: String,
    /// Source table name (e.g., `"salesorderheader"`).
    pub table: String,
}

impl SourceBinding {
    /// Create a new source binding.
    pub fn new(schema: impl Into<String>, table: impl Into<String>) -> Self {
        Self {
            schema: schema.into(),
            table: table.into(),
        }
    }
}

/// Generate the closed [`AnyConnector`] enum and all of its dispatch.
///
/// One invocation lists every built-in connector as `Variant => Type`. The
/// macro expands that single list into the enum variants, every dispatch method
/// (the data operations, `capabilities`, the `execute_join_aggregation` join
/// pushdown, and the `supported_auth_methods` static call that makes a missing
/// `ConnectorAuth` impl a **compile error**), and the `From<Type>` conversions.
///
/// Adding a connector is therefore one line in the [`define_any_connector!`]
/// invocation — there are no hand-maintained per-method match arms that can
/// drift out of sync or silently omit a variant.
macro_rules! define_any_connector {
    ($($(#[$vmeta:meta])* $variant:ident => $ty:ty),+ $(,)?) => {
        /// Enum dispatch for connectors, avoiding async-trait object-safety
        /// issues. The set is **closed** so the `supported_auth_methods`
        /// dispatch can statically require every variant's type to implement
        /// [`ConnectorAuth`] — the compile-enforced half of the connector
        /// checklist (see [`define_any_connector!`]).
        pub enum AnyConnector {
            $(
                $(#[$vmeta])*
                $variant($ty),
            )+
        }

        impl AnyConnector {
            /// The source-side computation capabilities of the wrapped
            /// connector (dispatch). The planner consults this — never a
            /// hardcoded connector name — to decide what to push.
            pub fn capabilities(&self) -> ConnectorCapabilities {
                match self { $( AnyConnector::$variant(c) => c.capabilities(), )+ }
            }

            /// Fetch data from this connector.
            pub async fn fetch_data(&self, request: &FetchRequest) -> ConnectorResult<Vec<RecordBatch>> {
                match self { $( AnyConnector::$variant(c) => c.fetch_data(request).await, )+ }
            }

            /// Execute a raw SQL query.
            pub async fn execute_query(&self, sql: &str) -> ConnectorResult<Vec<RecordBatch>> {
                match self { $( AnyConnector::$variant(c) => c.execute_query(sql).await, )+ }
            }

            /// List tables in the data source.
            pub async fn list_tables(&self) -> ConnectorResult<Vec<SourceTable>> {
                match self { $( AnyConnector::$variant(c) => c.list_tables().await, )+ }
            }

            /// Introspect a table's schema.
            pub async fn introspect_table(&self, schema: &str, table_name: &str) -> ConnectorResult<Table> {
                match self { $( AnyConnector::$variant(c) => c.introspect_table(schema, table_name).await, )+ }
            }

            /// Get the row count for a table.
            pub async fn row_count(&self, schema: &str, table_name: &str) -> ConnectorResult<usize> {
                match self { $( AnyConnector::$variant(c) => c.row_count(schema, table_name).await, )+ }
            }

            /// Returns the auth methods supported by this connector type.
            ///
            /// This is the ONE site that statically calls each variant type's
            /// [`ConnectorAuth::supported_auth_methods`] — a connector listed in
            /// [`define_any_connector!`] that does not implement [`ConnectorAuth`]
            /// fails to compile. (The in-memory connector implements it trivially:
            /// it is built from in-process data and supports no auth methods.)
            pub fn supported_auth_methods(&self) -> Vec<AuthMethodKind> {
                match self { $( AnyConnector::$variant(_) => <$ty as ConnectorAuth>::supported_auth_methods(), )+ }
            }

            /// Execute a multi-table aggregation query with JOINs.
            pub async fn execute_join_aggregation(
                &self,
                request: &engine_connectors::JoinAggregationRequest,
            ) -> ConnectorResult<Vec<RecordBatch>> {
                match self { $( AnyConnector::$variant(c) => c.execute_join_aggregation(request).await, )+ }
            }
        }

        $(
            impl From<$ty> for AnyConnector {
                fn from(connector: $ty) -> Self {
                    AnyConnector::$variant(connector)
                }
            }
        )+
    };
}

define_any_connector! {
    /// PostgreSQL connector.
    Postgres => PostgresConnector,
    /// SQL Server connector.
    SqlServer => SqlServerConnector,
    /// In-process connector serving canned Arrow batches (testing and simple
    /// file-less in-memory sources). See [`InMemoryConnector`].
    InMemory => InMemoryConnector,
    /// File-backed connector serving CSV files from a directory. See [`CsvConnector`].
    Csv => CsvConnector,
    /// File-backed connector serving Apache Parquet files from a directory. See [`ParquetConnector`].
    Parquet => ParquetConnector,
}

impl AnyConnector {
    /// Whether this connector can execute a pushed join-aggregation whose
    /// GROUP BY / measures are arbitrary expressions (e.g. a context-driven
    /// calculated column's resolved `CASE`). Connectors that cannot render
    /// Expression trees (everything but PostgreSQL today) compute such queries
    /// locally instead — see [`ConnectorCapabilities::expression_pushdown`].
    pub fn supports_expression_pushdown(&self) -> bool {
        self.capabilities().expression_pushdown
    }
}

/// Registry that maps data model table names to their connectors and
/// source locations.
///
/// Multiple model tables can share the same connector instance (e.g., all
/// tables from the same PostgreSQL database use one connector).
pub struct SourceRegistry {
    /// Map from model table name to (connector index, source binding).
    bindings: HashMap<String, (usize, SourceBinding)>,
    /// Connectors, referenced by index.
    connectors: Vec<AnyConnector>,
}

impl SourceRegistry {
    /// Create a new empty registry.
    pub fn new() -> Self {
        Self {
            bindings: HashMap::new(),
            connectors: Vec::new(),
        }
    }

    /// Register a connector and return its index.
    pub fn add_connector(&mut self, connector: AnyConnector) -> usize {
        let idx = self.connectors.len();
        self.connectors.push(connector);
        idx
    }

    /// Bind a model table name to a connector and source location.
    pub fn bind(
        &mut self,
        model_table: impl Into<String>,
        connector_index: usize,
        binding: SourceBinding,
    ) {
        self.bindings
            .insert(model_table.into(), (connector_index, binding));
    }

    /// Look up the connector for a model table.
    ///
    /// Returns [`QueryError::SourceNotRegistered`] when the table has no
    /// binding, or when its binding points at a connector index that was never
    /// registered (a host that called `bind` with a stale index) — the latter
    /// must not panic (library code never panics; see CLAUDE.md), so callers
    /// can treat an unregistered source uniformly (e.g. the context-column
    /// pushdown capability probe falls back to local aggregation).
    pub fn connector_for(&self, model_table: &str) -> QueryResult<&AnyConnector> {
        let (idx, _) = self
            .bindings
            .get(model_table)
            .ok_or_else(|| QueryError::SourceNotRegistered(model_table.to_string()))?;
        self.connectors
            .get(*idx)
            .ok_or_else(|| QueryError::SourceNotRegistered(model_table.to_string()))
    }

    /// Look up a connector by its registration index. Used by host commands that
    /// run a connector-level operation against a known connection (e.g. a
    /// consented script's read-only raw-SQL query), where the index comes from
    /// the connection rather than from a model table binding.
    pub fn connector_by_index(&self, index: usize) -> Option<&AnyConnector> {
        self.connectors.get(index)
    }

    /// Look up the source binding for a model table.
    pub fn binding_for(&self, model_table: &str) -> QueryResult<&SourceBinding> {
        let (_, binding) = self
            .bindings
            .get(model_table)
            .ok_or_else(|| QueryError::SourceNotRegistered(model_table.to_string()))?;
        Ok(binding)
    }

    /// Get the connector index for a model table.
    pub fn connector_index_for(&self, model_table: &str) -> QueryResult<usize> {
        let (idx, _) = self
            .bindings
            .get(model_table)
            .ok_or_else(|| QueryError::SourceNotRegistered(model_table.to_string()))?;
        Ok(*idx)
    }

    /// Check if a model table is registered.
    pub fn has_table(&self, model_table: &str) -> bool {
        self.bindings.contains_key(model_table)
    }
}

impl Default for SourceRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Test-only: a pushdown-capable connector (a lazy PostgreSQL connector that is
/// never actually connected) for planner plan-shape tests.
///
/// The planner's expression-pushdown gate only inspects the connector *kind*
/// (never its pool), and plan-shape tests call `plan`, not `execute`, so the
/// pool is never used. A process-lifetime current-thread runtime is held so
/// sqlx's lazy pool can spawn its (never-run) reaper task without each sync
/// `#[test]` needing its own runtime.
#[cfg(test)]
mod capability_tests {
    use super::*;
    use crate::in_memory_connector::InMemoryConnector;

    #[test]
    fn postgres_advertises_expression_pushdown() {
        let c = test_capable_connector();
        assert!(c.capabilities().expression_pushdown);
        assert!(c.supports_expression_pushdown());
    }

    #[test]
    fn in_memory_is_fetch_only() {
        let c = AnyConnector::InMemory(InMemoryConnector::new());
        assert_eq!(c.capabilities(), ConnectorCapabilities::fetch_only());
        assert!(!c.supports_expression_pushdown());
    }

    #[test]
    fn from_connector_builds_matching_variant() {
        // The macro-generated `From<Type>` conversions back `Engine::add_source`.
        let c: AnyConnector = InMemoryConnector::new().into();
        assert!(matches!(c, AnyConnector::InMemory(_)));
        assert!(c.supported_auth_methods().is_empty());
    }
}

#[cfg(test)]
pub(crate) fn test_capable_connector() -> AnyConnector {
    use std::sync::OnceLock;
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    let rt = RT.get_or_init(|| {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("build current-thread runtime for test connector")
    });
    let _guard = rt.enter();
    AnyConnector::Postgres(PostgresConnector::lazy_unconnected())
}
