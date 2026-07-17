//! FILENAME: app/src-tauri/src/bi/writeback.rs
//! PURPOSE: Model writeback COLUMNS (engine v21) — the app-side store of
//! collected entries, the engine history feeds + projection calls, and the
//! cell-entry command the pivot commit guard invokes.
//!
//! The engine owns the definitions and the query semantics (store tables +
//! generated lookup column, `Engine::set_writeback_data` /
//! `Engine::project_writeback_current`). This module owns what the engine
//! must not know: WHO typed WHAT and WHEN. Locally (this milestone) every
//! entry is auto-approved on entry; the distributed flow (.calp submissions,
//! publisher approval) plugs into the same store later by writing entries
//! with real states.
//!
//! Storage: append-only per writeback column id (a UUID, globally unique —
//! stable across connection-id churn on reload), persisted in the workbook's
//! `user_files/model_writeback_values.json`. The projection's "this session"
//! boundary for Blank columns is `AppState.model_writeback_floor`, reset at
//! workbook open/new.

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{ArrayRef, BooleanArray, Float64Array, Int64Array, StringArray};
use arrow::record_batch::RecordBatch;
use calp::writeback::SubmissionValue;
use serde::{Deserialize, Serialize};
use tauri::State;

use super::types::{BiState, ConnectionId};
use crate::persistence::FileState;
use crate::AppState;

/// One collected entry for a model writeback column. Append-only: every edit
/// is a new entry with a later timestamp (the user's "all history is
/// preserved" requirement — reports over the history table see all of them).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelWritebackEntry {
    /// Key values in the column's `key_columns` order, canonical strings
    /// (Int64 keys render without separators, matching Arrow display).
    pub key: Vec<String>,
    /// The typed value; `Empty` = the key was cleared.
    pub value: SubmissionValue,
    pub submitter_id: String,
    pub submitter_name: String,
    /// ISO 8601 (RFC3339) timestamp.
    pub submitted_at: String,
    /// "draft" | "submitted" | "approved" | "rejected" — local entries are
    /// auto-approved; distributed submissions carry their real state.
    pub state: String,
}

/// Per-workbook store of model writeback entries, keyed by writeback column
/// id. Persisted in `.cala` `user_files`; the single source of truth the
/// engine history stores are rebuilt from.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelWritebackStore {
    #[serde(default)]
    pub entries: HashMap<String, Vec<ModelWritebackEntry>>,
}

// ---------------------------------------------------------------------------
// Value parsing + constraint validation
// ---------------------------------------------------------------------------

/// Parse a raw input string into the column's typed value, enforcing the
/// designer's constraints. `None` = clear (rejected when `required`).
fn parse_value(
    wb: &bi_engine::WritebackColumn,
    raw: Option<&str>,
) -> Result<SubmissionValue, String> {
    let constraints = wb.constraints();
    let required = constraints.map(|c| c.required).unwrap_or(false);
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        if required {
            return Err(format!(
                "'{}' requires a value (clearing is not allowed)",
                wb.name()
            ));
        }
        return Ok(SubmissionValue::Empty);
    };

    match wb.data_type() {
        bi_engine::DataType::Float64 | bi_engine::DataType::Int64 => {
            let v: f64 = raw
                .replace(',', ".")
                .parse()
                .map_err(|_| format!("'{}' expects a number, got '{raw}'", wb.name()))?;
            if let Some(c) = constraints {
                if let Some(min) = c.min {
                    if v < min {
                        return Err(format!("'{}' must be at least {min}", wb.name()));
                    }
                }
                if let Some(max) = c.max {
                    if v > max {
                        return Err(format!("'{}' must be at most {max}", wb.name()));
                    }
                }
            }
            if matches!(wb.data_type(), bi_engine::DataType::Int64) && v.fract() != 0.0 {
                return Err(format!("'{}' expects a whole number", wb.name()));
            }
            Ok(SubmissionValue::Number { value: v })
        }
        bi_engine::DataType::Boolean => match raw.to_ascii_uppercase().as_str() {
            "TRUE" | "1" | "YES" => Ok(SubmissionValue::Boolean { value: true }),
            "FALSE" | "0" | "NO" => Ok(SubmissionValue::Boolean { value: false }),
            _ => Err(format!("'{}' expects TRUE or FALSE", wb.name())),
        },
        bi_engine::DataType::String => {
            if let Some(c) = constraints {
                if !c.enum_values.is_empty()
                    && !c.enum_values.iter().any(|e| e.eq_ignore_ascii_case(raw))
                {
                    return Err(format!(
                        "'{}' must be one of: {}",
                        wb.name(),
                        c.enum_values.join(", ")
                    ));
                }
                if let Some(max_len) = c.max_length {
                    if raw.chars().count() > max_len {
                        return Err(format!(
                            "'{}' allows at most {max_len} characters",
                            wb.name()
                        ));
                    }
                }
                if let Some(pattern) = &c.pattern {
                    // Real regex with a literal-substring fallback — the same
                    // lenient posture as the calp ValueSchema validator.
                    let ok = match regex::Regex::new(pattern) {
                        Ok(re) => re.is_match(raw),
                        Err(_) => raw.contains(pattern.as_str()),
                    };
                    if !ok {
                        return Err(format!(
                            "'{}' must match the pattern {pattern}",
                            wb.name()
                        ));
                    }
                }
            }
            Ok(SubmissionValue::Text {
                value: raw.to_string(),
            })
        }
        other => Err(format!(
            "writeback columns of type {other:?} are not supported yet",

        )),
    }
}

/// MasterData editor gate: when an allowlist is present, the identity must
/// match one entry (case-insensitively on id or display name, with the same
/// substring fallback as expected-respondents matching).
fn check_editor_allowed(
    wb: &bi_engine::WritebackColumn,
    identity: &calp::SubmitterIdentity,
) -> Result<(), String> {
    if wb.kind() != bi_engine::WritebackColumnKind::MasterData
        || wb.allowed_editors().is_empty()
    {
        return Ok(());
    }
    let id = identity.id.to_lowercase();
    let name = identity.display_name.to_lowercase();
    let allowed = wb.allowed_editors().iter().any(|e| {
        let e = e.trim().to_lowercase();
        !e.is_empty() && (id == e || name == e || name.contains(&e) || e.contains(&name))
    });
    if allowed {
        Ok(())
    } else {
        Err(format!(
            "'{}' is a master data column — only its designated editors can change it",
            wb.name()
        ))
    }
}

// ---------------------------------------------------------------------------
// Engine feeds
// ---------------------------------------------------------------------------

/// Build the history batch for one writeback column from its store entries,
/// against the engine-declared slot schema (key columns first, then value,
/// submitter_id, submitter_name, submitted_at, state).
fn history_batch(
    engine: &bi_engine::Engine,
    wb: &bi_engine::WritebackColumn,
    entries: &[ModelWritebackEntry],
) -> Result<RecordBatch, String> {
    use arrow::datatypes::DataType as ArrowType;

    let schema = Arc::new(
        engine
            .writeback_slot_schema(wb.id(), bi_engine::WritebackSlot::History)
            .map_err(|e| e.to_string())?,
    );
    let n_keys = wb.key_columns().len();
    let mut arrays: Vec<ArrayRef> = Vec::with_capacity(schema.fields().len());

    for (i, field) in schema.fields().iter().enumerate() {
        let array: ArrayRef = if i < n_keys {
            match field.data_type() {
                ArrowType::Int64 => {
                    let vals: Vec<Option<i64>> = entries
                        .iter()
                        .map(|e| e.key.get(i).and_then(|s| s.trim().parse::<i64>().ok()))
                        .collect();
                    Arc::new(Int64Array::from(vals))
                }
                _ => Arc::new(StringArray::from(
                    entries
                        .iter()
                        .map(|e| e.key.get(i).cloned().unwrap_or_default())
                        .collect::<Vec<_>>(),
                )),
            }
        } else if field.name() == "value" {
            match field.data_type() {
                ArrowType::Float64 => Arc::new(Float64Array::from(
                    entries
                        .iter()
                        .map(|e| match &e.value {
                            SubmissionValue::Number { value } => Some(*value),
                            _ => None,
                        })
                        .collect::<Vec<_>>(),
                )),
                ArrowType::Int64 => Arc::new(Int64Array::from(
                    entries
                        .iter()
                        .map(|e| match &e.value {
                            SubmissionValue::Number { value } => Some(*value as i64),
                            _ => None,
                        })
                        .collect::<Vec<_>>(),
                )),
                ArrowType::Boolean => Arc::new(BooleanArray::from(
                    entries
                        .iter()
                        .map(|e| match &e.value {
                            SubmissionValue::Boolean { value } => Some(*value),
                            _ => None,
                        })
                        .collect::<Vec<_>>(),
                )),
                _ => Arc::new(StringArray::from(
                    entries
                        .iter()
                        .map(|e| match &e.value {
                            SubmissionValue::Text { value } => Some(value.clone()),
                            SubmissionValue::Number { value } => Some(value.to_string()),
                            SubmissionValue::Boolean { value } => {
                                Some(if *value { "TRUE" } else { "FALSE" }.to_string())
                            }
                            SubmissionValue::Empty => None,
                        })
                        .collect::<Vec<_>>(),
                )),
            }
        } else {
            let strings: Vec<String> = entries
                .iter()
                .map(|e| match field.name().as_str() {
                    "submitter_id" => e.submitter_id.clone(),
                    "submitter_name" => e.submitter_name.clone(),
                    "submitted_at" => e.submitted_at.clone(),
                    "state" => e.state.clone(),
                    _ => String::new(),
                })
                .collect();
            Arc::new(StringArray::from(strings))
        };
        arrays.push(array);
    }

    RecordBatch::try_new(schema, arrays).map_err(|e| e.to_string())
}

/// Feed ONE engine's writeback stores (local store + distributed entries,
/// merged) and re-project every column's current values. Idempotent; call
/// after restore, model mutation, or entry changes.
pub async fn feed_engine_writeback(
    store: &ModelWritebackStore,
    distributed: &HashMap<String, Vec<ModelWritebackEntry>>,
    session_floor: &str,
    engine: &mut bi_engine::Engine,
) -> Result<(), String> {
    let wbs: Vec<bi_engine::WritebackColumn> = engine.model().writeback_columns().to_vec();
    for wb in wbs {
        let entries = merged_entries(store, distributed, wb.id());
        let batch = history_batch(engine, &wb, &entries)?;
        engine
            .set_writeback_data(wb.id(), bi_engine::WritebackSlot::History, batch)
            .map_err(|e| e.to_string())?;
        engine
            .project_writeback_current(wb.id(), Some(session_floor))
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Distributed entries (.calp model writebacks)
// ---------------------------------------------------------------------------

/// Collect the DISTRIBUTED entries of every model writeback column this
/// workbook can see: per subscription, the signature-verified manifest's
/// `model_writebacks` declarations select which submissions count, the
/// package's publisher baseline (`models/{ds}/writeback_history.json`) seeds
/// the pre-distribution history, and registry submissions pass the same
/// read-side integrity gates as GATHER (schema validation, masterData editor
/// allowlist, drafts dropped) so hand-written registry files can't pollute
/// the model. First subscription declaring a column wins, matching the grid
/// writeback paths.
pub(crate) fn collect_distributed_writeback_entries(
    state: &AppState,
) -> HashMap<String, Vec<ModelWritebackEntry>> {
    let mut result: HashMap<String, Vec<ModelWritebackEntry>> = HashMap::new();
    let Ok(subs) = state.subscriptions.lock() else {
        return result;
    };

    for sub in &subs.subscriptions {
        if sub.version_pin == "dev" || sub.version_pin.starts_with("channel:") {
            continue;
        }
        let registry_path = sub
            .registry_url
            .strip_prefix("file://")
            .unwrap_or(&sub.registry_url);
        let Ok(registry) = crate::calp_registry::open_registry(registry_path) else {
            continue;
        };
        // Declarations MUST come from the signature-verified manifest — they
        // are the governance for what counts (same rule as GATHER).
        let Ok((_, manifest)) = calp::integrity::verify_and_load_manifest_via(
            registry.as_ref(),
            &sub.package_name,
            &sub.resolved_version,
            &crate::calp_commands::calcula_profile_dir(),
        ) else {
            continue;
        };
        let Some(declarations) = manifest.model_writebacks.as_ref().filter(|d| !d.is_empty())
        else {
            continue;
        };

        // Registry submissions for this version (current/folded view — review
        // state is derived from review events), bucketed by writeback id. The
        // fold's output order is already deterministic; the extra sort below
        // pins the ENGINE FEED order so `latest_per_key`'s feed-order
        // tie-break resolves identically on every machine.
        let mut by_region: HashMap<String, Vec<calp::writeback::WritebackSubmission>> =
            HashMap::new();
        if let Ok(all) = registry.load_current_submissions(&sub.package_name, &sub.resolved_version)
        {
            for s in all {
                if s.model_key.is_some() {
                    by_region.entry(s.region_id.clone()).or_default().push(s);
                }
            }
        }
        for subs in by_region.values_mut() {
            subs.sort_by(|a, b| a.submitted_at.cmp(&b.submitted_at).then_with(|| a.id.cmp(&b.id)));
        }

        // Publisher baselines are keyed by data source; load each once.
        let mut baselines: HashMap<String, HashMap<String, Vec<ModelWritebackEntry>>> =
            HashMap::new();
        for decl in declarations {
            if !baselines.contains_key(&decl.data_source_id) {
                let parsed = registry
                    .read_artifact(
                        &sub.package_name,
                        &sub.resolved_version,
                        &format!("models/{}/writeback_history.json", decl.data_source_id),
                    )
                    .ok()
                    .flatten()
                    .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                    .unwrap_or_default();
                baselines.insert(decl.data_source_id.clone(), parsed);
            }
        }

        for decl in declarations {
            if result.contains_key(&decl.id) {
                continue; // first subscription wins
            }
            let editor_allowed = |submitter: &calp::SubmitterIdentity| -> bool {
                if decl.kind != "masterData" || decl.allowed_editors.is_empty() {
                    return true;
                }
                let id = submitter.id.to_lowercase();
                let name = submitter.display_name.to_lowercase();
                decl.allowed_editors.iter().any(|e| {
                    let e = e.trim().to_lowercase();
                    !e.is_empty() && (id == e || name == e || name.contains(&e) || e.contains(&name))
                })
            };

            let mut entries: Vec<ModelWritebackEntry> = Vec::new();
            // Baseline first (pre-distribution history, oldest layer).
            if let Some(baseline) = baselines
                .get(&decl.data_source_id)
                .and_then(|b| b.get(&decl.id))
            {
                entries.extend(baseline.iter().cloned());
            }
            // Then registry submissions, read-side gated.
            for s in by_region.remove(&decl.id).unwrap_or_default() {
                if matches!(s.state, calp::writeback::SubmissionState::Draft) {
                    continue;
                }
                let Some(key) = s.model_key.clone() else {
                    continue;
                };
                if key.len() != decl.key_columns.len() {
                    continue; // wrong arity — cannot address a row
                }
                // READ-SIDE SCHEMA INTEGRITY (P0 parity): the registry is a
                // shared directory; a hand-written file with an out-of-range
                // value must never reach the model. Empty passes (an explicit
                // clear is meaningful history).
                if let Some(schema) = &decl.schema {
                    if !matches!(s.value, calp::writeback::SubmissionValue::Empty)
                        && schema.validate(&s.value).is_err()
                    {
                        continue;
                    }
                }
                // READ-SIDE EDITOR GATE: a masterData column only counts
                // entries from its designated editors.
                if !editor_allowed(&s.submitter) {
                    continue;
                }
                entries.push(ModelWritebackEntry {
                    key,
                    value: s.value.clone(),
                    submitter_id: s.submitter.id.clone(),
                    submitter_name: s.submitter.display_name.clone(),
                    submitted_at: s
                        .submitted_at
                        .clone()
                        .unwrap_or_else(|| s.updated_at.clone()),
                    state: crate::calp_commands::submission_state_str(&s.state).to_string(),
                });
            }
            if !entries.is_empty() {
                result.insert(decl.id.clone(), entries);
            }
        }
    }

    result
}

/// The merged entry list for one writeback column: distributed entries
/// (baseline + governed registry submissions) followed by local store
/// entries. Projections order by `submitted_at`, so layering here is only
/// about completeness, not precedence.
fn merged_entries(
    store: &ModelWritebackStore,
    distributed: &HashMap<String, Vec<ModelWritebackEntry>>,
    wb_id: &str,
) -> Vec<ModelWritebackEntry> {
    let mut entries: Vec<ModelWritebackEntry> =
        distributed.get(wb_id).cloned().unwrap_or_default();
    if let Some(local) = store.entries.get(wb_id) {
        entries.extend(local.iter().cloned());
    }
    entries
}

/// Fire-and-forget [`refresh_model_writeback`] for SYNC call sites (workbook
/// restore). No-op before the app handle is installed at startup.
pub fn queue_model_writeback_refresh() {
    let Some(app) = super::writeback_source::app_handle() else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        use tauri::Manager;
        let state = app.state::<AppState>();
        let bi_state = app.state::<BiState>();
        refresh_model_writeback(&state, &bi_state).await;
    });
}

/// Feed every open connection's engine (dedup shared engines). Used on
/// workbook restore and after model mutations that (re)introduce writeback
/// columns.
pub async fn refresh_model_writeback(state: &AppState, bi_state: &BiState) {
    let engines: Vec<Arc<tokio::sync::Mutex<bi_engine::Engine>>> = {
        let Ok(conns) = bi_state.connections.lock() else {
            return;
        };
        let mut list: Vec<Arc<tokio::sync::Mutex<bi_engine::Engine>>> = Vec::new();
        for c in conns.values() {
            if let Some(engine) = &c.engine {
                if !list.iter().any(|e| Arc::ptr_eq(e, engine)) {
                    list.push(engine.clone());
                }
            }
        }
        list
    };
    if engines.is_empty() {
        return;
    }
    let (store, floor) = {
        let store = match state.model_writeback.lock() {
            Ok(s) => s.clone(),
            Err(_) => return,
        };
        let floor = state
            .model_writeback_floor
            .lock()
            .map(|f| f.clone())
            .unwrap_or_default();
        (store, floor)
    };
    let distributed = collect_distributed_writeback_entries(state);
    for engine in &engines {
        let mut guard = engine.lock().await;
        if guard.model().writeback_columns().is_empty() {
            continue;
        }
        if let Err(e) = feed_engine_writeback(&store, &distributed, &floor, &mut guard).await {
            eprintln!("[writeback] engine feed failed: {e}");
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Enter (or clear) one value of a writeback column, identified by the host
/// row's key values. Validates against the designer's constraints and the
/// MasterData editor gate, appends an immutable entry to the history, feeds
/// the engine, and re-projects the displayed values.
#[tauri::command]
pub async fn bi_writeback_set_value(
    state: State<'_, AppState>,
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    connection_id: ConnectionId,
    writeback_id: String,
    key: Vec<String>,
    value: Option<String>,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(
        &window,
        crate::security::window_guard::MAIN_AND_MODEL_EDITOR,
    )?;

    let (engine_arc, is_subscribed) = {
        let conns = bi_state.connections.lock().map_err(|e| e.to_string())?;
        let conn = conns.get(&connection_id).ok_or("Connection not found")?;
        (
            conn.engine.clone().ok_or("No model loaded for this connection")?,
            conn.package_data_source_id.is_some(),
        )
    };
    let mut engine = engine_arc.lock().await;

    let wb = engine
        .model()
        .writeback_columns()
        .iter()
        .find(|w| w.id() == writeback_id)
        .cloned()
        .ok_or_else(|| format!("No writeback column '{writeback_id}' in this model"))?;
    if key.len() != wb.key_columns().len() {
        return Err(format!(
            "'{}' expects {} key value(s), got {}",
            wb.name(),
            wb.key_columns().len(),
            key.len()
        ));
    }

    let parsed = parse_value(&wb, value.as_deref())?;
    let identity = crate::calp_commands::get_subscriber_identity(&state)?;
    check_editor_allowed(&wb, &identity)?;

    if is_subscribed {
        // SUBSCRIBED model: the entry is a governed SUBMISSION to the
        // package's registry — the registry is the source of truth for
        // distributed columns (the local store never sees it). Every gate
        // re-validates against the SIGNED manifest's declaration, exactly
        // like the grid-region submit path: a tampered local model cannot
        // widen what the publisher declared.
        crate::calp_commands::submit_model_writeback(&state, &wb, key, parsed, &identity)?;
    } else {
        // LOCAL model: append to the workbook store, auto-approved (no
        // submit/approve ceremony inside one's own workbook).
        let entry = ModelWritebackEntry {
            key,
            value: parsed,
            submitter_id: identity.id,
            submitter_name: identity.display_name,
            submitted_at: chrono::Utc::now().to_rfc3339(),
            state: "approved".to_string(),
        };
        let mut store = state.model_writeback.lock().map_err(|e| e.to_string())?;
        store
            .entries
            .entry(wb.id().to_string())
            .or_default()
            .push(entry);
    }

    // Re-feed this engine from the merged (local + distributed) history.
    let store = state
        .model_writeback
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let distributed = collect_distributed_writeback_entries(&state);
    let entries = merged_entries(&store, &distributed, wb.id());
    let batch = history_batch(&engine, &wb, &entries)?;
    engine
        .set_writeback_data(wb.id(), bi_engine::WritebackSlot::History, batch)
        .map_err(|e| e.to_string())?;
    let floor = state
        .model_writeback_floor
        .lock()
        .map(|f| f.clone())
        .unwrap_or_default();
    engine
        .project_writeback_current(wb.id(), Some(&floor))
        .await
        .map_err(|e| e.to_string())?;
    drop(engine);

    *file_state.is_modified.lock().map_err(|e| e.to_string())? = true;
    Ok(())
}

/// One writeback column definition, projected for pivot editing: everything
/// the frontend needs to decide editability (key columns present as row
/// fields?) and to submit a value (id + key order + typing hints).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BiWritebackFieldMeta {
    pub id: String,
    pub table: String,
    pub name: String,
    pub data_type: String,
    /// "history" | "masterData"
    pub kind: String,
    /// Key column names on the host table, in submission order.
    pub key_columns: Vec<String>,
    pub required: bool,
    pub enum_values: Vec<String>,
}

/// List the writeback columns of one connection's model (for the pivot
/// field list + editing). Reads the connection's base model — no engine lock.
#[tauri::command]
pub fn bi_writeback_list_columns(
    bi_state: State<BiState>,
    connection_id: ConnectionId,
    window: tauri::Window,
) -> Result<Vec<BiWritebackFieldMeta>, String> {
    crate::security::window_guard::require_label(
        &window,
        crate::security::window_guard::MAIN_AND_MODEL_EDITOR,
    )?;
    let conns = bi_state.connections.lock().map_err(|e| e.to_string())?;
    let Some(model) = conns.get(&connection_id).and_then(|c| c.base_model.as_ref()) else {
        return Ok(Vec::new());
    };
    Ok(model
        .writeback_columns()
        .iter()
        .map(|wb| BiWritebackFieldMeta {
            id: wb.id().to_string(),
            table: wb.table().to_string(),
            name: wb.name().to_string(),
            data_type: format!("{:?}", wb.data_type()),
            kind: match wb.kind() {
                bi_engine::WritebackColumnKind::History => "history",
                bi_engine::WritebackColumnKind::MasterData => "masterData",
            }
            .to_string(),
            key_columns: wb.key_columns().to_vec(),
            required: wb.constraints().map(|c| c.required).unwrap_or(false),
            enum_values: wb
                .constraints()
                .map(|c| c.enum_values.clone())
                .unwrap_or_default(),
        })
        .collect())
}

/// Inspect the collected entries of one writeback column (history order).
#[tauri::command]
pub fn bi_writeback_get_values(
    state: State<AppState>,
    writeback_id: String,
    window: tauri::Window,
) -> Result<Vec<ModelWritebackEntry>, String> {
    crate::security::window_guard::require_label(
        &window,
        crate::security::window_guard::MAIN_AND_MODEL_EDITOR,
    )?;
    Ok(state
        .model_writeback
        .lock()
        .map_err(|e| e.to_string())?
        .entries
        .get(&writeback_id)
        .cloned()
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    //! Input parsing/constraints, the MasterData editor gate, and the
    //! history-batch encoder (against the engine-declared slot schema).
    use super::*;
    use arrow::array::Array;

    fn wb(data_type: bi_engine::DataType) -> bi_engine::WritebackColumn {
        bi_engine::WritebackColumn::new(
            "wb-test-1",
            "Forecast",
            "dim_customer",
            data_type,
            vec!["ID".to_string()],
        )
    }

    #[test]
    fn parse_value_matrix() {
        use bi_engine::{DataType, WritebackConstraints};

        let num = wb(DataType::Float64).with_constraints(WritebackConstraints {
            min: Some(0.0),
            max: Some(100.0),
            ..Default::default()
        });
        assert_eq!(
            parse_value(&num, Some("42,5")).unwrap(),
            SubmissionValue::Number { value: 42.5 }
        );
        assert!(parse_value(&num, Some("-1")).is_err());
        assert!(parse_value(&num, Some("101")).is_err());
        assert!(parse_value(&num, Some("abc")).is_err());
        assert_eq!(parse_value(&num, None).unwrap(), SubmissionValue::Empty);

        let required = wb(DataType::Float64).with_constraints(WritebackConstraints {
            required: true,
            ..Default::default()
        });
        assert!(parse_value(&required, None).is_err());
        assert!(parse_value(&required, Some("  ")).is_err());

        let int = wb(DataType::Int64);
        assert!(parse_value(&int, Some("1.5")).is_err());
        assert_eq!(
            parse_value(&int, Some("3")).unwrap(),
            SubmissionValue::Number { value: 3.0 }
        );

        let boolean = wb(DataType::Boolean);
        assert_eq!(
            parse_value(&boolean, Some("yes")).unwrap(),
            SubmissionValue::Boolean { value: true }
        );
        assert!(parse_value(&boolean, Some("maybe")).is_err());

        let text = wb(DataType::String).with_constraints(WritebackConstraints {
            enum_values: vec!["North".into(), "South".into()],
            max_length: Some(10),
            ..Default::default()
        });
        assert_eq!(
            parse_value(&text, Some("north")).unwrap(),
            SubmissionValue::Text { value: "north".into() }
        );
        assert!(parse_value(&text, Some("East")).is_err());
    }

    #[test]
    fn master_data_editor_gate() {
        let identity = calp::SubmitterIdentity {
            display_name: "Alice (North)".into(),
            id: "id-alice".into(),
            extra: std::collections::HashMap::new(),
        };
        // History columns and MasterData without an allowlist: open.
        assert!(check_editor_allowed(&wb(bi_engine::DataType::Float64), &identity).is_ok());
        let open_md = wb(bi_engine::DataType::Float64)
            .with_kind(bi_engine::WritebackColumnKind::MasterData);
        assert!(check_editor_allowed(&open_md, &identity).is_ok());
        // Allowlist: substring/case-insensitive match on name or id.
        let gated = open_md.clone().with_allowed_editors(vec!["alice".into()]);
        assert!(check_editor_allowed(&gated, &identity).is_ok());
        let denied = open_md.with_allowed_editors(vec!["Bob".into()]);
        assert!(check_editor_allowed(&denied, &identity).is_err());
    }

    #[test]
    fn history_batch_matches_slot_schema() {
        use bi_engine::{Column, DataModel, DataType, StorageMode, Table};

        let model = DataModel::builder()
            .add_table(
                Table::new(
                    "dim_customer",
                    vec![
                        Column::new("ID", DataType::Int64),
                        Column::new("Name", DataType::String),
                    ],
                )
                .unwrap()
                .with_storage_mode(StorageMode::InMemory),
            )
            .add_writeback_column(wb(DataType::Float64))
            .build()
            .unwrap();
        let engine = bi_engine::Engine::new(model);
        let wb = engine.model().writeback_columns()[0].clone();

        let entries = vec![
            ModelWritebackEntry {
                key: vec!["7".into()],
                value: SubmissionValue::Number { value: 42.5 },
                submitter_id: "u1".into(),
                submitter_name: "User One".into(),
                submitted_at: "2026-07-13T10:00:00Z".into(),
                state: "approved".into(),
            },
            ModelWritebackEntry {
                key: vec!["8".into()],
                value: SubmissionValue::Empty,
                submitter_id: "u1".into(),
                submitter_name: "User One".into(),
                submitted_at: "2026-07-13T11:00:00Z".into(),
                state: "approved".into(),
            },
        ];
        let batch = history_batch(&engine, &wb, &entries).unwrap();
        let expected = engine
            .writeback_slot_schema(wb.id(), bi_engine::WritebackSlot::History)
            .unwrap();
        assert_eq!(batch.schema().fields(), expected.fields());
        assert_eq!(batch.num_rows(), 2);
        let ids = batch
            .column(0)
            .as_any()
            .downcast_ref::<Int64Array>()
            .unwrap();
        assert_eq!((ids.value(0), ids.value(1)), (7, 8));
        let values = batch
            .column(1)
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap();
        assert_eq!(values.value(0), 42.5);
        assert!(values.is_null(1)); // Empty (cleared) -> NULL

        // The batch is accepted by the engine's schema gate.
        let mut engine = engine;
        engine
            .set_writeback_data(wb.id(), bi_engine::WritebackSlot::History, batch)
            .unwrap();
    }
}
