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
//!
//!          EXPOSURE CONTRACT: `bi.query` has TWO holders — object scripts
//!          reach the model through the broker gateway (`script_bi_model`,
//!          bi/model_editor.rs), notebook cells through this provider. The
//!          metadata each one may read MUST match, or the weaker surface
//!          becomes the way to read what the stronger one denies. Every
//!          metadata method here is therefore a WHITELIST projection, never a
//!          straight serialization of a host DTO: `connections()` emits
//!          non-sensitive connection summaries, `model_info()` CALLS the
//!          gateway's own `sanitized_model_info` (no securityRoles, no sources,
//!          no per-table sourceId) rather than keeping a second copy of the
//!          whitelist. Adding a field to a BI DTO must not silently widen
//!          either surface.
//!
//!          The gateway ALSO serves read-only diagnostics (validateMeasure,
//!          validateContext, validateModel, dependencyGraph, measureLineage,
//!          dependents) — but those sit behind `bi.model`, the STRONGER grant,
//!          not behind `bi.query`. That ordering is deliberate and must hold:
//!          `bi.query` is the weaker surface, so it may never grow a read the
//!          gateway gates on `bi.model`. If a notebook ever needs lineage, it
//!          needs `bi.model`, not a new method here.

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
        if !cap_store.is_granted(surface, capability) {
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

/// The sanitized model-info projection for `model.info`.
///
/// Delegates to the WORKER-REALM GATEWAY's projection
/// (`bi::model_editor::sanitized_model_info`, `action: "info"`) so the two
/// holders of `bi.query` metadata cannot drift: the same grant must not mean
/// "more" in a notebook cell than in an object script. Excluded there, and
/// therefore here: `securityRoles` (role names + their per-table filter
/// predicates + dynamic-identity markers), `sources` (connection targets), and
/// each table's `sourceId`.
fn sanitize_model_info<T: serde::Serialize>(info: &T) -> Result<serde_json::Value, String> {
    crate::bi::model_editor::sanitized_model_info(info)
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

    /// Model metadata for one connection — the SANITIZED projection, never the
    /// raw `BiModelInfo`. `BiModelInfo` carries `security_roles` (RLS role
    /// names + their per-table filter predicates); the worker-realm gateway
    /// strips those before sandboxed code sees them, so this surface must too —
    /// the same `bi.query` grant may not mean "more" in a notebook cell than in
    /// an object script. See `sanitize_model_info`.
    fn model_info(&self, surface: &str, connection: &str) -> Result<String, ModelProviderError> {
        self.check_cap(surface, "bi.query")?;
        let conn_id = self.resolve_conn(connection)?;
        let info = {
            let bi = self.app.state::<BiState>();
            self.block_on_bi(extract_connection_model_info(&bi, conn_id))?
        };
        let sanitized = sanitize_model_info(&info)
            .map_err(|e| ModelProviderError::new(ModelProviderErrorKind::Query, e))?;
        self.audit_ok(
            "bi.query",
            surface,
            &format!("model.info connection {}", conn_id),
        );
        serde_json::to_string(&sanitized).map_err(|e| {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::types::{
        BiColumnInfo, BiFilterPredicateInfo, BiMeasureInfo, BiModelInfo, BiRelationshipInfo,
        BiSecurityRoleInfo, BiTableInfo,
    };

    /// A model that DOES define RLS — names, per-table predicates, and a
    /// dynamic (USERNAME()) filter, i.e. everything a script must not read.
    fn model_info_with_roles() -> BiModelInfo {
        BiModelInfo {
            tables: vec![BiTableInfo {
                name: "Sales".to_string(),
                columns: vec![
                    BiColumnInfo {
                        name: "region".to_string(),
                        data_type: "String".to_string(),
                        is_context_column: false,
                        is_writeback_column: false,
                    },
                    BiColumnInfo {
                        name: "amount".to_string(),
                        data_type: "Float64".to_string(),
                        is_context_column: false,
                        is_writeback_column: false,
                    },
                ],
            }],
            measures: vec![BiMeasureInfo {
                name: "Revenue".to_string(),
                table: "Sales".to_string(),
            }],
            relationships: vec![BiRelationshipInfo {
                name: "Sales_Region".to_string(),
                from_table: "Sales".to_string(),
                from_column: "region".to_string(),
                to_table: "Region".to_string(),
                to_column: "code".to_string(),
            }],
            hierarchies: vec![],
            kpis: vec![],
            security_roles: vec![
                BiSecurityRoleInfo {
                    name: "EMEA Managers".to_string(),
                    table_filters: vec![BiFilterPredicateInfo {
                        table: "Sales".to_string(),
                        column: "region".to_string(),
                        operator: "Equal".to_string(),
                        value: "EMEA".to_string(),
                        dynamic: None,
                    }],
                    is_dynamic: false,
                },
                BiSecurityRoleInfo {
                    name: "Own Rows Only".to_string(),
                    table_filters: vec![BiFilterPredicateInfo {
                        table: "Sales".to_string(),
                        column: "owner_upn".to_string(),
                        operator: "Equal".to_string(),
                        value: "USERNAME()".to_string(),
                        dynamic: Some("Username".to_string()),
                    }],
                    is_dynamic: true,
                },
            ],
            calculation_groups: vec![],
        }
    }

    /// The leak this projection exists to close: the raw DTO carries the whole
    /// RLS definition, so `model.info` must not hand the raw DTO to JS.
    #[test]
    fn raw_model_info_still_carries_the_roles() {
        let raw = serde_json::to_string(&model_info_with_roles()).unwrap();
        assert!(raw.contains("securityRoles"));
        assert!(raw.contains("EMEA Managers"));
        assert!(raw.contains("owner_upn"));
    }

    /// No security-role data survives the projection — not the key, not a role
    /// name, not a predicate column/value, not the dynamic-identity marker.
    #[test]
    fn sanitized_model_info_drops_security_roles() {
        let sanitized = sanitize_model_info(&model_info_with_roles()).unwrap();
        let obj = sanitized.as_object().unwrap();
        assert!(
            !obj.contains_key("securityRoles"),
            "securityRoles must not reach script code"
        );
        // Snake_case can never appear either (serde renames at the struct
        // level), but assert on the serialized text so a nested or renamed
        // re-introduction is caught too.
        let text = serde_json::to_string(&sanitized).unwrap();
        for leaked in [
            "securityRoles",
            "security_roles",
            "EMEA Managers",
            "Own Rows Only",
            "owner_upn",
            "tableFilters",
            "isDynamic",
            "USERNAME()",
        ] {
            assert!(
                !text.contains(leaked),
                "sanitized model.info leaked '{}': {}",
                leaked,
                text
            );
        }
    }

    /// The projection is a whitelist, not a blocklist: analysis metadata still
    /// gets through, and nothing outside the whitelist does.
    #[test]
    fn sanitized_model_info_keeps_analysis_metadata() {
        let sanitized = sanitize_model_info(&model_info_with_roles()).unwrap();
        let obj = sanitized.as_object().unwrap();
        assert_eq!(obj["tables"].as_array().unwrap().len(), 1);
        assert_eq!(obj["tables"][0]["name"], "Sales");
        assert_eq!(obj["tables"][0]["columns"].as_array().unwrap().len(), 2);
        assert_eq!(obj["measures"][0]["name"], "Revenue");
        assert_eq!(obj["relationships"][0]["fromTable"], "Sales");
        assert!(obj.contains_key("hierarchies"));
        assert!(obj.contains_key("kpis"));
        assert!(obj.contains_key("calculationGroups"));

        const ALLOWED: &[&str] = &[
            "tables",
            "measures",
            "relationships",
            "hierarchies",
            "kpis",
            "calculationGroups",
        ];
        for key in obj.keys() {
            assert!(
                ALLOWED.contains(&key.as_str()),
                "unexpected key '{}' in sanitized model.info",
                key
            );
        }
    }

    /// Connection targets are stripped at both levels the gateway strips them:
    /// the top-level `sources` list and each table's `sourceId`. Driven through
    /// a synthetic overview because today's `BiModelInfo` carries neither —
    /// the guard must already be in place when it does.
    #[test]
    fn sanitized_model_info_strips_source_targets() {
        let overview = serde_json::json!({
            "editable": true,
            "modelName": "Sales Model",
            "sources": [{ "id": "src-1", "server": "sql-prod.internal", "database": "Finance" }],
            "tables": [{ "name": "Sales", "sourceId": "src-1", "columns": [] }],
            "measures": [],
            "securityRoles": [{ "name": "EMEA Managers" }],
            "connectionString": "Server=sql-prod.internal;Password=hunter2",
        });
        let sanitized = sanitize_model_info(&overview).unwrap();
        let obj = sanitized.as_object().unwrap();
        assert!(!obj.contains_key("sources"));
        assert!(!obj.contains_key("securityRoles"));
        // Default-deny: a key nobody whitelisted never appears.
        assert!(!obj.contains_key("connectionString"));
        assert_eq!(obj["editable"], true);
        assert_eq!(obj["modelName"], "Sales Model");
        assert_eq!(obj["tables"][0]["name"], "Sales");
        assert!(obj["tables"][0].as_object().unwrap().get("sourceId").is_none());
    }

    /// A non-object input is rejected rather than silently forwarded.
    #[test]
    fn sanitized_model_info_rejects_non_object() {
        let err = sanitize_model_info(&serde_json::json!(["Admin", "Viewer"])).unwrap_err();
        assert!(err.contains("did not serialize to an object"));
    }
}
