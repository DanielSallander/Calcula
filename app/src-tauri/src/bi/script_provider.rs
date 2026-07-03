//! FILENAME: app/src-tauri/src/bi/script_provider.rs
//! PURPOSE: HostModelProvider — the app's implementation of the script
//!          engine's ModelDataProvider (read-only model.* API in notebooks).
//! CONTEXT: Runs ON the notebook executor thread (a plain OS thread), so it
//!          may block: every method re-checks the capability grant in the
//!          authoritative Rust CapabilityStore (keyed by the calling surface
//!          id, e.g. "notebook:nb-123"), bridges to the async BI internals
//!          via Handle::block_on + a hard timeout, funnels queries through
//!          the SAME gate-free cores as the existing script commands
//!          (bi_query_core / bi_sql_core — RLS + read-only validation by
//!          construction), and records every call — success and denial —
//!          into the per-workbook capability audit trail.

use std::future::Future;
use std::time::Duration;

use script_engine::model_provider::{
    ModelDataProvider, ModelProviderError, ModelProviderErrorKind, ModelQuerySpec, ModelTable,
};
use tauri::Manager;

use super::commands::{bi_query_core, bi_sql_core, extract_connection_model_info};
use super::cube::{
    conn_id_by_name, cube_err_message, script_cube_kpi, script_cube_members, script_cube_value,
};
use super::types::{BiColumnRef, BiFilter, BiQueryRequest, BiQueryResult, BiState, ConnectionId};

/// Hard per-call ceiling: a hung data source must not wedge the notebook
/// executor thread forever.
const MODEL_CALL_TIMEOUT: Duration = Duration::from_secs(60);

/// Rows entering JS from one query (the live Table output item is further
/// capped at 200 rows by the display layer; .cala persists at most 50).
const MODEL_RESULT_ROW_CAP: usize = 50_000;

pub struct HostModelProvider {
    app: tauri::AppHandle,
    rt: tokio::runtime::Handle,
}

impl HostModelProvider {
    pub fn new(app: tauri::AppHandle, rt: tokio::runtime::Handle) -> Self {
        HostModelProvider { app, rt }
    }

    /// Authoritative capability re-check (same store the worker-realm gates
    /// use). A miss is recorded as a DENIED capability call and surfaces as
    /// ConsentRequired (message = the capability id, which the ops layer
    /// folds into the BI_CONSENT_REQUIRED sentinel).
    fn check_cap(&self, surface: &str, capability: &str) -> Result<(), ModelProviderError> {
        let cap_store = self.app.state::<crate::scripting::CapabilityStore>();
        if !cap_store.is_bi_granted(surface, capability) {
            let app_state = self.app.state::<crate::AppState>();
            crate::net_commands::record_capability_call(
                &app_state.audit_log,
                capability,
                surface,
                false,
                None,
                Some(&format!("{} not granted", capability)),
            );
            return Err(ModelProviderError::new(
                ModelProviderErrorKind::ConsentRequired,
                capability,
            ));
        }
        Ok(())
    }

    /// Record a successful capability call (always-on trail; detail is
    /// non-sensitive: connection + a short specifier, never full SQL).
    fn audit_ok(&self, capability: &str, surface: &str, detail: &str) {
        let app_state = self.app.state::<crate::AppState>();
        crate::net_commands::record_capability_call(
            &app_state.audit_log,
            capability,
            surface,
            true,
            Some(detail),
            None,
        );
    }

    fn resolve_conn(&self, connection: &str) -> Result<ConnectionId, ModelProviderError> {
        let bi = self.app.state::<BiState>();
        conn_id_by_name(&bi, connection).ok_or_else(|| {
            ModelProviderError::new(
                ModelProviderErrorKind::NotAvailable,
                format!("Unknown BI connection '{}'", connection),
            )
        })
    }

    /// Drive an async BI call to completion from this (plain) thread with the
    /// hard timeout. Safe here: the executor thread is not a tokio worker.
    fn block_on_bi<T, F>(&self, fut: F) -> Result<T, ModelProviderError>
    where
        F: Future<Output = Result<T, String>>,
    {
        match self.rt.block_on(tokio::time::timeout(MODEL_CALL_TIMEOUT, fut)) {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(e)) => Err(ModelProviderError::new(ModelProviderErrorKind::Query, e)),
            Err(_) => Err(ModelProviderError::new(
                ModelProviderErrorKind::Timeout,
                format!("no response within {}s", MODEL_CALL_TIMEOUT.as_secs()),
            )),
        }
    }
}

/// Convert a BiQueryResult into the provider table shape, applying the
/// row cap for values entering the JS heap.
fn result_to_table(mut result: BiQueryResult) -> ModelTable {
    let total_rows = result.rows.len();
    let truncated = total_rows > MODEL_RESULT_ROW_CAP;
    if truncated {
        result.rows.truncate(MODEL_RESULT_ROW_CAP);
    }
    ModelTable {
        columns: result.columns,
        rows: result.rows,
        total_rows,
        truncated,
    }
}

impl ModelDataProvider for HostModelProvider {
    fn connections(&self, surface: &str) -> Result<String, ModelProviderError> {
        self.check_cap(surface, "bi.query")?;
        // Whitelisted, NON-sensitive summaries only: no connection strings,
        // servers, database names, or model paths reach script code.
        let summaries: Vec<serde_json::Value> = {
            let bi = self.app.state::<BiState>();
            let connections = bi.connections.lock().unwrap();
            let mut infos: Vec<_> = connections.values().map(|c| c.to_info()).collect();
            infos.sort_by_key(|c| c.id);
            infos
                .iter()
                .map(|c| {
                    serde_json::json!({
                        "id": c.id,
                        "name": c.name,
                        "description": c.description,
                        "connectionType": c.connection_type,
                        "isConnected": c.is_connected,
                        "tableCount": c.table_count,
                        "measureCount": c.measure_count,
                    })
                })
                .collect()
        };
        self.audit_ok("bi.query", surface, "model.connections");
        serde_json::to_string(&summaries).map_err(|e| {
            ModelProviderError::new(ModelProviderErrorKind::Query, format!("Serialize failed: {}", e))
        })
    }

    fn model_info(&self, surface: &str, connection: &str) -> Result<String, ModelProviderError> {
        self.check_cap(surface, "bi.query")?;
        let conn_id = self.resolve_conn(connection)?;
        let info = {
            let bi = self.app.state::<BiState>();
            self.block_on_bi(extract_connection_model_info(&bi, conn_id))?
        };
        self.audit_ok(
            "bi.query",
            surface,
            &format!("model.info connection {}", conn_id),
        );
        serde_json::to_string(&info).map_err(|e| {
            ModelProviderError::new(ModelProviderErrorKind::Query, format!("Serialize failed: {}", e))
        })
    }

    fn query(
        &self,
        surface: &str,
        connection: &str,
        spec: &ModelQuerySpec,
    ) -> Result<ModelTable, ModelProviderError> {
        self.check_cap(surface, "bi.query")?;
        let conn_id = self.resolve_conn(connection)?;
        let request = BiQueryRequest {
            measures: spec.measures.clone(),
            group_by: spec
                .group_by
                .iter()
                .map(|g| BiColumnRef {
                    table: g.table.clone(),
                    column: g.column.clone(),
                })
                .collect(),
            filters: spec
                .filters
                .iter()
                .map(|f| BiFilter {
                    table: f.table.clone(),
                    column: f.column.clone(),
                    operator: f.operator.clone(),
                    value: f.value.clone(),
                })
                .collect(),
        };
        let result = {
            let bi = self.app.state::<BiState>();
            self.block_on_bi(bi_query_core(&bi, conn_id, &request))?
        };
        let measures_summary: String = {
            let joined = request.measures.join(", ");
            joined.chars().take(60).collect()
        };
        self.audit_ok(
            "bi.query",
            surface,
            &format!("model.query connection {} — measures [{}]", conn_id, measures_summary),
        );
        Ok(result_to_table(result))
    }

    fn sql(
        &self,
        surface: &str,
        connection: &str,
        sql: &str,
    ) -> Result<ModelTable, ModelProviderError> {
        self.check_cap(surface, "bi.sql")?;
        let conn_id = self.resolve_conn(connection)?;
        let result = {
            let bi = self.app.state::<BiState>();
            self.block_on_bi(bi_sql_core(&bi, conn_id, sql))?
        };
        // Same redaction policy as script_bi_sql: a short prefix, never the
        // full query (it may carry literals the user considers sensitive).
        let sql_prefix: String = sql.trim().chars().take(60).collect();
        self.audit_ok(
            "bi.sql",
            surface,
            &format!("model.sql connection {} — {}", conn_id, sql_prefix),
        );
        Ok(result_to_table(result))
    }

    fn cube_value(
        &self,
        surface: &str,
        connection: &str,
        members: &[String],
    ) -> Result<Option<f64>, ModelProviderError> {
        self.check_cap(surface, "bi.query")?;
        let v = {
            let bi = self.app.state::<BiState>();
            self.block_on_bi(async {
                script_cube_value(&bi, connection, members)
                    .await
                    .map_err(cube_err_message)
            })?
        };
        self.audit_ok(
            "bi.query",
            surface,
            &format!("model.value connection {}", connection),
        );
        Ok(v)
    }

    fn cube_members(
        &self,
        surface: &str,
        connection: &str,
        level: &str,
    ) -> Result<Vec<String>, ModelProviderError> {
        self.check_cap(surface, "bi.query")?;
        let v = {
            let bi = self.app.state::<BiState>();
            self.block_on_bi(async {
                script_cube_members(&bi, connection, level)
                    .await
                    .map_err(cube_err_message)
            })?
        };
        self.audit_ok(
            "bi.query",
            surface,
            &format!("model.members connection {}", connection),
        );
        Ok(v)
    }

    fn cube_kpi(
        &self,
        surface: &str,
        connection: &str,
        kpi: &str,
        property: i64,
    ) -> Result<Option<f64>, ModelProviderError> {
        self.check_cap(surface, "bi.query")?;
        let v = {
            let bi = self.app.state::<BiState>();
            self.block_on_bi(async {
                script_cube_kpi(&bi, connection, kpi, property)
                    .await
                    .map_err(cube_err_message)
            })?
        };
        self.audit_ok(
            "bi.query",
            surface,
            &format!("model.kpi connection {}", connection),
        );
        Ok(v)
    }
}
