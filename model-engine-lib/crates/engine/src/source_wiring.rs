//! Persisted multi-source wiring for the [`Engine`] facade.
//!
//! A multi-source model records its data sources in the model's persisted
//! catalog ([`DataModel::sources`](engine_core::model::DataModel::sources)) and
//! binds each table to a source via
//! [`Table::source_binding`](engine_core::model::Table::source_binding). Those
//! descriptors are **secret-free** — they carry a connection target and a
//! preferred-auth *hint*, never a credential (see
//! [`engine_core::model::source`]). This module supplies:
//!
//! - the **composite-model API** ([`Engine::add_postgres_source`] and siblings,
//!   [`Engine::bind_source_table`], [`Engine::bind_source_tables`]) that
//!   registers a source under a stable id and records it in the catalog, so a
//!   host never tracks connector indices; and
//! - the **load-time wiring** ([`Engine::wire_sources`] /
//!   [`Engine::wire_sources_with_auth`]) that rebuilds the live
//!   [`SourceRegistry`] from the persisted catalog, with the host re-supplying
//!   secrets at that point.
//!
//! Loading a model opens **no** connections; wiring is an explicit, async step.

use std::collections::HashMap;

use engine_connectors::auth::{AuthMethod, AuthMethodKind, ConnectionTarget};
use engine_connectors::ConnectorError;
use engine_core::error::{EngineError, EngineResult};
use engine_core::model::{
    PersistedAuthKind, PersistedConnection, PersistedSource, SourceKind, Table, TableSourceBinding,
};
use engine_query::registry::{AnyConnector, SourceBinding};

use crate::{
    CsvConnector, Engine, InMemoryConnector, ParquetConnector, PostgresConnector,
    SqlServerConnector,
};

/// How the host supplies a connector for a persisted source when wiring.
///
/// Returned by the resolver passed to [`Engine::wire_sources`]. Because an
/// [`SourceKind::InMemory`] source's data lives in the host (not in the
/// persisted descriptor), such a source can only be wired with
/// [`SourceCredential::Connector`].
pub enum SourceCredential {
    /// Build the connector from the persisted connection target using this
    /// auth. Valid for `Postgres`/`SqlServer` (connect) and `Csv`/`Parquet`
    /// (open the directory). Supplying this for an `InMemory` source is an error.
    Auth(AuthMethod),
    /// Use this already-built connector as-is. Required for `InMemory` sources
    /// (the host owns the data); also an escape hatch for custom connector setup.
    Connector(AnyConnector),
    /// Leave this source unwired. Its tables remain unbound and fail closed at
    /// query time with `SourceNotRegistered`.
    Skip,
}

/// Outcome of an [`Engine::wire_sources`] call.
///
/// All lists hold ids/names; nothing here is an error — an unwired source (its
/// id in `skipped`, its tables in `unbound_tables`) is a deliberate, recoverable
/// state, not a failure. The host can present `unbound_tables` as
/// "reconnect required".
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct WireReport {
    /// Source ids that were connected/registered.
    pub wired: Vec<String>,
    /// Source ids the resolver chose to skip.
    pub skipped: Vec<String>,
    /// Model tables that were bound to a live connector.
    pub bound_tables: Vec<String>,
    /// Model tables whose `source_binding` points at a source that was not
    /// wired (skipped or absent); they fail closed at query time.
    pub unbound_tables: Vec<String>,
}

/// Map a persisted (secret-free) connection descriptor to a live
/// [`ConnectionTarget`]. The single forward-translation site; paired with
/// [`target_to_persisted`] and covered by a drift round-trip test.
fn persisted_to_target(conn: &PersistedConnection) -> ConnectionTarget {
    let mut target = ConnectionTarget::new(conn.host.clone(), conn.database.clone())
        .with_trust_server_certificate(conn.trust_server_certificate);
    if let Some(port) = conn.port {
        target = target.with_port(port);
    }
    if let Some(schema) = &conn.default_schema {
        target = target.with_default_schema(schema.clone());
    }
    if let Some(mode) = &conn.ssl_mode {
        target = target.with_ssl_mode(mode.clone());
    }
    target
}

/// Map a live [`ConnectionTarget`] to a persisted (secret-free) connection
/// descriptor. The single reverse-translation site (see [`persisted_to_target`]).
fn target_to_persisted(target: &ConnectionTarget) -> PersistedConnection {
    PersistedConnection {
        host: target.host.clone(),
        port: target.port,
        database: target.database.clone(),
        default_schema: target.default_schema.clone(),
        trust_server_certificate: target.trust_server_certificate,
        ssl_mode: target.ssl_mode.clone(),
    }
}

/// Map a runtime auth *kind* to its persisted (hint-only) counterpart.
fn auth_kind_to_persisted(kind: AuthMethodKind) -> PersistedAuthKind {
    match kind {
        AuthMethodKind::Integrated => PersistedAuthKind::Integrated,
        AuthMethodKind::UsernamePassword => PersistedAuthKind::UsernamePassword,
        AuthMethodKind::EnvironmentVariable => PersistedAuthKind::EnvironmentVariable,
    }
}

/// Connector errors have no dedicated [`EngineError`] variant (engine-core does
/// not depend on engine-connectors), so the facade surfaces them as
/// [`EngineError::InvalidData`] carrying the connector's message — matching how
/// the refresh path already maps them.
fn map_conn_err(e: ConnectorError) -> EngineError {
    EngineError::InvalidData(e.to_string())
}

impl Engine {
    /// Register a PostgreSQL source under a stable `id`, record it in the
    /// model's persisted catalog (secret-free), and return its connector index.
    ///
    /// Unlike [`add_postgres`](Self::add_postgres), the source is persisted with
    /// the model so it can be reopened and reconnected via
    /// [`wire_sources`](Self::wire_sources). Bind tables to it with
    /// [`bind_source_table`](Self::bind_source_table) /
    /// [`bind_source_tables`](Self::bind_source_tables). Fails with
    /// [`EngineError::DuplicateName`] if `id` is already in the catalog.
    pub async fn add_postgres_source(
        &mut self,
        id: impl Into<String>,
        target: ConnectionTarget,
        auth: AuthMethod,
    ) -> EngineResult<usize> {
        let id = id.into();
        self.ensure_unique_source_id(&id)?;
        let connection = target_to_persisted(&target);
        let preferred_auth = auth_kind_to_persisted(auth.kind());
        let connector = PostgresConnector::connect(target, auth)
            .await
            .map_err(map_conn_err)?;
        self.register_persisted_source(
            id,
            SourceKind::Postgres,
            connection,
            preferred_auth,
            connector.into(),
        )
    }

    /// Register a SQL Server source under a stable `id`. See
    /// [`add_postgres_source`](Self::add_postgres_source).
    pub async fn add_sqlserver_source(
        &mut self,
        id: impl Into<String>,
        target: ConnectionTarget,
        auth: AuthMethod,
    ) -> EngineResult<usize> {
        let id = id.into();
        self.ensure_unique_source_id(&id)?;
        let connection = target_to_persisted(&target);
        let preferred_auth = auth_kind_to_persisted(auth.kind());
        let connector = SqlServerConnector::connect(target, auth)
            .await
            .map_err(map_conn_err)?;
        self.register_persisted_source(
            id,
            SourceKind::SqlServer,
            connection,
            preferred_auth,
            connector.into(),
        )
    }

    /// Register a CSV directory source under a stable `id`. See
    /// [`add_postgres_source`](Self::add_postgres_source) and
    /// [`add_csv_source`](Self::add_csv_source). Synchronous (no I/O).
    pub fn add_csv_source_with_id(
        &mut self,
        id: impl Into<String>,
        target: ConnectionTarget,
        auth: AuthMethod,
    ) -> EngineResult<usize> {
        let id = id.into();
        self.ensure_unique_source_id(&id)?;
        let connection = target_to_persisted(&target);
        let preferred_auth = auth_kind_to_persisted(auth.kind());
        let connector = CsvConnector::from_target(target, auth).map_err(map_conn_err)?;
        self.register_persisted_source(
            id,
            SourceKind::Csv,
            connection,
            preferred_auth,
            connector.into(),
        )
    }

    /// Register a Parquet directory source under a stable `id`. See
    /// [`add_postgres_source`](Self::add_postgres_source) and
    /// [`add_parquet_source`](Self::add_parquet_source). Synchronous (no I/O).
    pub fn add_parquet_source_with_id(
        &mut self,
        id: impl Into<String>,
        target: ConnectionTarget,
        auth: AuthMethod,
    ) -> EngineResult<usize> {
        let id = id.into();
        self.ensure_unique_source_id(&id)?;
        let connection = target_to_persisted(&target);
        let preferred_auth = auth_kind_to_persisted(auth.kind());
        let connector = ParquetConnector::from_target(target, auth).map_err(map_conn_err)?;
        self.register_persisted_source(
            id,
            SourceKind::Parquet,
            connection,
            preferred_auth,
            connector.into(),
        )
    }

    /// Register an in-process [`InMemoryConnector`] under a stable `id` and
    /// record it in the catalog. The persisted descriptor carries no connection
    /// (the data lives in the host), so on reopen the host must re-supply the
    /// connector via [`SourceCredential::Connector`]. Synchronous (no I/O).
    pub fn add_in_memory_source_with_id(
        &mut self,
        id: impl Into<String>,
        connector: InMemoryConnector,
    ) -> EngineResult<usize> {
        let id = id.into();
        self.ensure_unique_source_id(&id)?;
        self.register_persisted_source(
            id,
            SourceKind::InMemory,
            PersistedConnection::default(),
            PersistedAuthKind::Integrated,
            connector.into(),
        )
    }

    /// Bind an **existing** model table to a location within a registered
    /// source, setting both the live registry binding and the persisted
    /// [`Table::source_binding`] so it survives save/reopen.
    ///
    /// `model_table` defaults to `table` when `None`. The model table must
    /// already exist (this method performs no introspection — use
    /// [`bind_source_tables`](Self::bind_source_tables) to discover and add
    /// tables). The source must be registered (added via one of the
    /// `add_*_source*` methods or wired). Synchronous (no I/O).
    pub fn bind_source_table(
        &mut self,
        source_id: &str,
        schema: &str,
        table: &str,
        model_table: Option<&str>,
    ) -> EngineResult<()> {
        let idx = self.source_index_for(source_id)?;
        if self.model.source(source_id).is_none() {
            return Err(EngineError::InvalidData(format!(
                "data source '{source_id}' is not in the model's source catalog; \
                 register it with add_<kind>_source* before binding tables"
            )));
        }
        let model_table = model_table.unwrap_or(table);
        // Verify the model table exists before mutating anything.
        self.model.table(model_table)?;

        let binding = TableSourceBinding::new(source_id, schema, table);
        let updated_tables: Vec<Table> = self
            .model
            .tables()
            .iter()
            .map(|t| {
                if t.name() == model_table {
                    let mut t = t.clone();
                    t.set_source_binding(Some(binding.clone()));
                    t
                } else {
                    t.clone()
                }
            })
            .collect();
        let new_model = self.model.with_tables(updated_tables);
        new_model.validate()?;
        self.set_model(new_model)?;
        self.registry
            .bind(model_table, idx, SourceBinding::new(schema, table));
        Ok(())
    }

    /// Discover every table a registered source exposes ([`Connector::list_tables`]),
    /// add any the model lacks (introspecting their schema), bind each to the
    /// source in both the registry and the persisted model, and return the bound
    /// model table names.
    ///
    /// Each source table binds to a model table of the **same name** (existing
    /// tables are re-bound, never overwritten; missing ones are added). To rename
    /// or bind selectively, add the table yourself and use
    /// [`bind_source_table`](Self::bind_source_table). If two sources expose a
    /// table of the same name, the later `bind_source_tables` re-points that
    /// model table — bind such tables explicitly with distinct model names
    /// instead.
    ///
    /// [`Connector::list_tables`]: engine_connectors::traits::Connector::list_tables
    pub async fn bind_source_tables(&mut self, source_id: &str) -> EngineResult<Vec<String>> {
        let idx = self.source_index_for(source_id)?;
        if self.model.source(source_id).is_none() {
            return Err(EngineError::InvalidData(format!(
                "data source '{source_id}' is not in the model's source catalog; \
                 register it with add_<kind>_source* before binding tables"
            )));
        }

        // Phase A (immutable borrows): list the source tables, and introspect
        // only those the model does not already define. Collect owned results so
        // no connector borrow is held while the model/registry are mutated.
        let source_tables = {
            let connector = self.registry.connector_by_index(idx).ok_or_else(|| {
                EngineError::InvalidData(format!("data source '{source_id}' is not registered"))
            })?;
            connector.list_tables().await.map_err(map_conn_err)?
        };
        let mut introspected: Vec<Table> = Vec::new();
        for st in &source_tables {
            if self.model.table(&st.name).is_err() {
                let connector = self.registry.connector_by_index(idx).ok_or_else(|| {
                    EngineError::InvalidData(format!("data source '{source_id}' is not registered"))
                })?;
                let table = connector
                    .introspect_table(&st.schema, &st.name)
                    .await
                    .map_err(map_conn_err)?
                    .with_source_binding(TableSourceBinding::new(source_id, &st.schema, &st.name));
                introspected.push(table);
            }
        }

        // Phase B (mutate): stamp bindings on existing tables, append the newly
        // introspected ones, revalidate, install, then bind at runtime.
        let mut updated_tables: Vec<Table> = self
            .model
            .tables()
            .iter()
            .map(|t| {
                if let Some(st) = source_tables.iter().find(|st| st.name == t.name()) {
                    let mut t = t.clone();
                    t.set_source_binding(Some(TableSourceBinding::new(
                        source_id, &st.schema, &st.name,
                    )));
                    t
                } else {
                    t.clone()
                }
            })
            .collect();
        updated_tables.extend(introspected);
        let new_model = self.model.with_tables(updated_tables);
        new_model.validate()?;
        self.set_model(new_model)?;

        let mut bound = Vec::with_capacity(source_tables.len());
        for st in &source_tables {
            self.registry.bind(
                st.name.clone(),
                idx,
                SourceBinding::new(&st.schema, &st.name),
            );
            bound.push(st.name.clone());
        }
        Ok(bound)
    }

    /// Rebuild the live [`SourceRegistry`] from the model's persisted catalog,
    /// asking `resolve` how to obtain each source's connector, then bind every
    /// table whose `source_binding` names a source that was wired.
    ///
    /// This is the reopen path: [`load_model`](Self::load_model) opens no
    /// connections, so a host loads a model and then calls `wire_sources`,
    /// supplying secrets (which are never persisted) at that point. A source the
    /// resolver skips — or a table binding whose source is skipped/unknown —
    /// leaves those tables unbound; they fail closed at query time with
    /// `SourceNotRegistered` rather than erroring here. See [`WireReport`].
    pub async fn wire_sources<F>(&mut self, mut resolve: F) -> EngineResult<WireReport>
    where
        F: FnMut(&PersistedSource) -> SourceCredential,
    {
        // Clone the small descriptors up front: the async connect below must not
        // hold a borrow of self.model while self.registry is mutated.
        let sources: Vec<PersistedSource> = self.model.sources().to_vec();
        let mut report = WireReport::default();
        for src in &sources {
            match resolve(src) {
                SourceCredential::Skip => report.skipped.push(src.id.clone()),
                SourceCredential::Connector(connector) => {
                    self.registry
                        .add_connector_with_id(Some(src.id.clone()), connector);
                    report.wired.push(src.id.clone());
                }
                SourceCredential::Auth(auth) => {
                    let connector = build_connector(src, auth).await?;
                    self.registry
                        .add_connector_with_id(Some(src.id.clone()), connector);
                    report.wired.push(src.id.clone());
                }
            }
        }

        // Bind every persisted table binding whose source is now registered;
        // record the rest as unbound. Collect first (immutable borrows), then
        // apply (mutable) to keep the borrow checker happy.
        let mut to_bind: Vec<(String, usize, SourceBinding)> = Vec::new();
        for table in self.model.tables() {
            if let Some(binding) = table.source_binding() {
                match self
                    .registry
                    .connector_index_by_source_id(&binding.source_id)
                {
                    Some(idx) => to_bind.push((
                        table.name().to_string(),
                        idx,
                        SourceBinding::new(&binding.schema, &binding.table),
                    )),
                    None => report.unbound_tables.push(table.name().to_string()),
                }
            }
        }
        for (name, idx, binding) in to_bind {
            self.registry.bind(name.clone(), idx, binding);
            report.bound_tables.push(name);
        }
        Ok(report)
    }

    /// Convenience wrapper over [`wire_sources`](Self::wire_sources) for the
    /// common all-database/file case: each non-in-memory source's auth is looked
    /// up in `auth` by source id; local `Csv`/`Parquet` sources default to
    /// [`AuthMethod::Integrated`] when absent. In-memory sources are **skipped**
    /// (and reported) because their data cannot be rebuilt from the map — supply
    /// them via the callback form of `wire_sources`.
    pub async fn wire_sources_with_auth(
        &mut self,
        auth: &HashMap<String, AuthMethod>,
    ) -> EngineResult<WireReport> {
        self.wire_sources(|src| match src.kind {
            SourceKind::InMemory => SourceCredential::Skip,
            SourceKind::Csv | SourceKind::Parquet => match auth.get(&src.id) {
                Some(a) => SourceCredential::Auth(a.clone()),
                None => SourceCredential::Auth(AuthMethod::Integrated),
            },
            SourceKind::Postgres | SourceKind::SqlServer => match auth.get(&src.id) {
                Some(a) => SourceCredential::Auth(a.clone()),
                None => SourceCredential::Skip,
            },
        })
        .await
    }

    /// Reject a source id that is already in the model's catalog.
    fn ensure_unique_source_id(&self, id: &str) -> EngineResult<()> {
        if self.model.source(id).is_some() {
            return Err(EngineError::DuplicateName(format!(
                "Duplicate data source id '{id}'"
            )));
        }
        Ok(())
    }

    /// Resolve a source id to its connector index, erroring if it is not
    /// registered in the live registry.
    fn source_index_for(&self, source_id: &str) -> EngineResult<usize> {
        self.registry
            .connector_index_by_source_id(source_id)
            .ok_or_else(|| {
                EngineError::InvalidData(format!(
                    "data source '{source_id}' is not registered; add it with \
                     add_<kind>_source* or wire_sources first"
                ))
            })
    }

    /// Record a source in the persisted catalog and register its connector under
    /// the same id, returning the connector index. Shared by the `add_*_source*`
    /// composite constructors.
    fn register_persisted_source(
        &mut self,
        id: String,
        kind: SourceKind,
        connection: PersistedConnection,
        preferred_auth: PersistedAuthKind,
        connector: AnyConnector,
    ) -> EngineResult<usize> {
        self.model.push_source(PersistedSource::new(
            id.clone(),
            kind,
            connection,
            preferred_auth,
        ))?;
        // Adding a source to the catalog has no effect on query results, so we
        // do not invalidate the result cache (unlike set_model).
        Ok(self.registry.add_connector_with_id(Some(id), connector))
    }
}

/// Build a live connector for a persisted source from a host-supplied auth.
/// In-memory sources cannot be rebuilt this way (their data lives in the host);
/// the caller must use [`SourceCredential::Connector`] for those.
async fn build_connector(src: &PersistedSource, auth: AuthMethod) -> EngineResult<AnyConnector> {
    let target = persisted_to_target(&src.connection);
    let connector: AnyConnector = match src.kind {
        SourceKind::Postgres => PostgresConnector::connect(target, auth)
            .await
            .map_err(map_conn_err)?
            .into(),
        SourceKind::SqlServer => SqlServerConnector::connect(target, auth)
            .await
            .map_err(map_conn_err)?
            .into(),
        SourceKind::Csv => CsvConnector::from_target(target, auth)
            .map_err(map_conn_err)?
            .into(),
        SourceKind::Parquet => ParquetConnector::from_target(target, auth)
            .map_err(map_conn_err)?
            .into(),
        SourceKind::InMemory => {
            return Err(EngineError::InvalidData(format!(
                "in-memory data source '{}' cannot be rebuilt from persisted auth; \
                 supply SourceCredential::Connector with the host's data",
                src.id
            )))
        }
    };
    Ok(connector)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persisted_target_round_trip_preserves_all_fields() {
        // Drift guard: persisted_to_target ∘ target_to_persisted must be the
        // identity over every secret-free field of ConnectionTarget.
        let target = ConnectionTarget::new("host.example.com", "warehouse")
            .with_port(5433)
            .with_default_schema("reporting")
            .with_trust_server_certificate(true);
        let restored = persisted_to_target(&target_to_persisted(&target));
        assert_eq!(target, restored);
    }

    #[test]
    fn persisted_target_round_trip_minimal() {
        let target = ConnectionTarget::new("db", "analytics");
        let restored = persisted_to_target(&target_to_persisted(&target));
        assert_eq!(target, restored);
    }

    #[test]
    fn auth_kind_maps_to_persisted() {
        assert_eq!(
            auth_kind_to_persisted(AuthMethodKind::Integrated),
            PersistedAuthKind::Integrated
        );
        assert_eq!(
            auth_kind_to_persisted(AuthMethodKind::UsernamePassword),
            PersistedAuthKind::UsernamePassword
        );
        assert_eq!(
            auth_kind_to_persisted(AuthMethodKind::EnvironmentVariable),
            PersistedAuthKind::EnvironmentVariable
        );
    }
}
