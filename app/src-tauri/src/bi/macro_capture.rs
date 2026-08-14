//! FILENAME: app/src-tauri/src/bi/macro_capture.rs
//! PURPOSE: Macro-recorder capture of BI-model mutations (design:
//!          docs/design/macro-model-recording-and-fused-cli.md, Feature 1).
//!
//! One armed-only hook below `emit_model_changed` — the single funnel every
//! model mutation passes through (edits, undo/redo, batch rollback, imports;
//! both windows; the Model Editor CLI) — emits a `macro:model-edit` Tauri
//! event TARGETED AT THE MAIN WINDOW, where the recording session lives.
//!
//! THE PAYLOAD IS GATEWAY-READY. Each captured upsert/delete carries exactly
//! the JSON object the `script_bi_model` dispatch arms consume (the
//! `gateway_field` reads in model_editor.rs), so the generated macro embeds it
//! VERBATIM into `caps.biModel.upsert/delete` calls. Building the payload here
//! — in the same crate as its consumer — is what keeps the two from drifting;
//! a TS-side field mapping would be a second source of truth.
//!
//! SECURITY INVARIANTS (do not weaken):
//! * Kinds outside `GATEWAY_MUTABLE_KINDS` are NEVER given a payload — a role
//!   or source edit captures as `replayable: false` with a reason, and for
//!   roles/sources not even the object NAME rides along (role names are
//!   privileged; see `sanitized_model_info`).
//! * Script-attributed mutations (`script_id` set) are never captured — the
//!   recorder records the USER, and a script the user runs mid-recording is
//!   already recorded as the gesture that launched it.
//! * Emission happens only while armed, and only to the "main" window label.
//!   Nothing is broadcast app-wide except the boolean armed-state change.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use serde_json::{json, Map, Value};

use super::types::ConnectionId;

// ---------------------------------------------------------------------------
// Arming
// ---------------------------------------------------------------------------

/// Process-wide: recording is app-modal (one session at a time), so a single
/// flag is the honest shape. Set only by the MAIN-window-guarded command.
static MODEL_RECORDING_ARMED: AtomicBool = AtomicBool::new(false);

pub(crate) fn is_armed() -> bool {
    MODEL_RECORDING_ARMED.load(Ordering::SeqCst)
}

/// Arm/disarm model-edit capture. Called by the macro recorder session in the
/// main window when recording starts/stops. Broadcasts the (boolean-only)
/// armed state app-wide so the Model Editor window can show a recording pill.
#[tauri::command]
pub fn macro_model_recording_set_armed(armed: bool, window: tauri::Window) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    MODEL_RECORDING_ARMED.store(armed, Ordering::SeqCst);
    if let Some(app) = super::writeback_source::app_handle() {
        use tauri::Emitter;
        let _ = app.emit("macro:recording-armed-changed", json!({ "armed": armed }));
    }
    Ok(())
}

/// Read the armed state (the Model Editor window's pill asks on mount; later
/// changes arrive via `macro:recording-armed-changed`).
#[tauri::command]
pub fn macro_model_recording_armed(window: tauri::Window) -> Result<bool, String> {
    crate::security::window_guard::require_label(
        &window,
        crate::security::window_guard::MAIN_AND_MODEL_EDITOR,
    )?;
    Ok(is_armed())
}

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

/// One captured model mutation, as the main-window recorder session receives
/// it on `macro:model-edit`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedModelEditPayload {
    pub connection_id: ConnectionId,
    /// Gateway kind for replayable edits; the raw diff domain otherwise
    /// ("table", "bulk", ...). Empty for roles/sources ("privileged").
    pub kind: String,
    /// "upsert" | "delete" | "undo" | "redo" (the last two are session-editing
    /// markers, never emitted into generated code).
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Gateway-ready `caps.biModel` payload — embedded verbatim by codegen.
    /// Present only when `replayable` (privileged kinds never carry one).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
    pub replayable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Batch boundary marker (`macro:model-batch`): lets the session drop the
/// model edits of a cancelled CLI batch instead of replaying rolled-back work.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordedModelBatchPayload {
    connection_id: ConnectionId,
    /// "begin" | "end" | "cancel"
    action: String,
}

// ---------------------------------------------------------------------------
// Emission (called from model_editor's choke points)
// ---------------------------------------------------------------------------

/// Capture hook, invoked by `emit_model_changed` AFTER the ordinary lifecycle
/// event. `before`/`after` are the pre/post base models; `source` is the
/// lifecycle source ("user" | "script" | "undo" | "redo").
pub(super) fn capture_and_emit(
    app: &tauri::AppHandle,
    connection_id: ConnectionId,
    before: &bi_engine::DataModel,
    after: &bi_engine::DataModel,
    source: &str,
    script_id: Option<&str>,
) {
    if !is_armed() {
        return;
    }
    // A script's mutations (and a script batch's rollback) are not USER
    // gestures — the recorder captured the gesture that ran the script.
    if script_id.is_some() || source == "script" {
        return;
    }
    let captured = match source {
        // Session-editing markers: the session pops/restores the last model
        // action, mirroring how grid Ctrl+Z edits the recording.
        "undo" | "redo" => Some(RecordedModelEditPayload {
            connection_id,
            kind: "model".to_string(),
            action: source.to_string(),
            name: None,
            payload: None,
            replayable: false,
            reason: None,
        }),
        _ => compute_capture(connection_id, before, after),
    };
    let Some(payload) = captured else {
        return;
    };
    use tauri::Emitter;
    let _ = app.emit_to("main", "macro:model-edit", payload);
}

/// Batch boundary hook, invoked by the trusted `bi_model_batch_*` commands
/// (the CLI's atomic runs). Script batches never reach those commands.
pub(super) fn emit_batch_marker(connection_id: ConnectionId, action: &str) {
    if !is_armed() {
        return;
    }
    let Some(app) = super::writeback_source::app_handle() else {
        return;
    };
    use tauri::Emitter;
    let _ = app.emit_to(
        "main",
        "macro:model-batch",
        RecordedModelBatchPayload {
            connection_id,
            action: action.to_string(),
        },
    );
}

// ---------------------------------------------------------------------------
// Capture computation (pure; unit-tested below)
// ---------------------------------------------------------------------------

/// Serialized-payload ceiling. A captured object bigger than this (a formula
/// pasted from a novel, a megabyte extension-data value) records as
/// NOT REPLAYABLE instead of bloating the workbook's script store.
const MAX_CAPTURED_PAYLOAD_BYTES: usize = 262_144;

/// The one-edit-fans-out domains capture accepts from a multi-domain diff.
/// STRICTER than the lifecycle event's priority list on purpose: a
/// writebackColumn or calculatedTable edit legitimately synthesizes side
/// tables/columns, so the authored domain IS the whole edit — but a diff
/// touching `measure` plus anything else would REPLAY only the measure and
/// silently drop the rest, so it must record as an unreplayable bulk change.
const CAPTURE_FANOUT_DOMAINS: &[&str] = &["writebackColumn", "calculatedTable"];

/// Map a diff domain (changed_domain vocabulary) to the gateway kind.
fn domain_to_gateway_kind(domain: &str) -> &str {
    match domain {
        // table_variables diff under "variable"; the gateway calls them
        // "tableVariable".
        "variable" => "tableVariable",
        other => other,
    }
}

fn not_replayable(
    connection_id: ConnectionId,
    kind: &str,
    action: &str,
    name: Option<String>,
    reason: &str,
) -> RecordedModelEditPayload {
    RecordedModelEditPayload {
        connection_id,
        kind: kind.to_string(),
        action: action.to_string(),
        name,
        payload: None,
        replayable: false,
        reason: Some(reason.to_string()),
    }
}

/// Diff two base models into at most one recordable action. Pure — the
/// armed/source filtering lives in `capture_and_emit`.
pub(crate) fn compute_capture(
    connection_id: ConnectionId,
    before: &bi_engine::DataModel,
    after: &bi_engine::DataModel,
) -> Option<RecordedModelEditPayload> {
    use super::model_editor::{diff_entity_lists, EntityChangeKind};

    let changes = diff_entity_lists(before, after);

    let single = match changes.len() {
        0 => return scalar_capture(connection_id, before, after),
        1 => &changes[0],
        _ => {
            // Accept only the documented synthesized fan-outs (see
            // CAPTURE_FANOUT_DOMAINS); anything else is a genuine bulk change.
            match CAPTURE_FANOUT_DOMAINS
                .iter()
                .find_map(|p| changes.iter().find(|c| c.domain == *p))
            {
                Some(c) => c,
                None => {
                    return Some(not_replayable(
                        connection_id,
                        "bulk",
                        "upsert",
                        None,
                        "one edit changed several model areas at once (import or bulk \
                         change) — re-create it in the Model Editor",
                    ));
                }
            }
        }
    };

    // Privileged domains: no payload, and for roles/sources not even the name.
    match single.domain {
        "role" => {
            return Some(not_replayable(
                connection_id,
                "role",
                "upsert",
                None,
                "security roles are not scriptable — re-create this edit in the Model Editor",
            ));
        }
        "source" => {
            return Some(not_replayable(
                connection_id,
                "source",
                "upsert",
                None,
                "data sources and connections are not scriptable — connect before running \
                 the macro",
            ));
        }
        "table" => {
            return Some(not_replayable(
                connection_id,
                "table",
                "upsert",
                single.name.clone(),
                "table structure edits (add/rename/delete/storage) are not scriptable via \
                 bi.model",
            ));
        }
        _ => {}
    }

    let kind = domain_to_gateway_kind(single.domain);
    let Some(name) = single.name.clone() else {
        return Some(not_replayable(
            connection_id,
            kind,
            "upsert",
            None,
            "could not determine the single changed object (ambiguous change)",
        ));
    };

    let built = match single.change {
        EntityChangeKind::Added => {
            upsert_payload(kind, &name, None, after).map(|p| ("upsert", p))
        }
        EntityChangeKind::Edited => {
            upsert_payload(kind, &name, Some(&name), after).map(|p| ("upsert", p))
        }
        EntityChangeKind::Renamed => {
            let original = single.original_name.as_deref();
            upsert_payload(kind, &name, original, after).map(|p| ("upsert", p))
        }
        EntityChangeKind::Removed => delete_payload(kind, &name, before).map(|p| ("delete", p)),
        EntityChangeKind::Unknown => Err("ambiguous change".to_string()),
    };

    let (action, payload) = match built {
        Ok(v) => v,
        Err(e) => {
            return Some(not_replayable(
                connection_id,
                kind,
                "upsert",
                Some(name),
                &format!("could not capture this edit ({})", e),
            ));
        }
    };

    // Size ceiling: record the gesture, refuse the blob.
    match serde_json::to_string(&payload) {
        Ok(s) if s.len() > MAX_CAPTURED_PAYLOAD_BYTES => {
            return Some(not_replayable(
                connection_id,
                kind,
                action,
                Some(name),
                "the edited object is too large to record (over 256 KB)",
            ));
        }
        Err(e) => {
            return Some(not_replayable(
                connection_id,
                kind,
                action,
                Some(name),
                &format!("could not serialize this edit ({})", e),
            ));
        }
        Ok(_) => {}
    }

    Some(RecordedModelEditPayload {
        connection_id,
        kind: kind.to_string(),
        action: action.to_string(),
        name: Some(name),
        payload: Some(payload),
        replayable: true,
        reason: None,
    })
}

/// No entity list changed: a scalar/metadata edit. Distinguish the two
/// gateway-replayable scalars (dateTable, descriptive metadata) from the
/// rest (defaultLookupResolution has no gateway kind).
fn scalar_capture(
    connection_id: ConnectionId,
    before: &bi_engine::DataModel,
    after: &bi_engine::DataModel,
) -> Option<RecordedModelEditPayload> {
    if before.date_table() != after.date_table() {
        return Some(RecordedModelEditPayload {
            connection_id,
            kind: "dateTable".to_string(),
            action: "upsert".to_string(),
            name: after.date_table().map(|s| s.to_string()),
            payload: Some(json!({ "table": after.date_table() })),
            replayable: true,
            reason: None,
        });
    }
    let meta_changed = before.model_name() != after.model_name()
        || before.model_version() != after.model_version()
        || before.model_author() != after.model_author()
        || before.model_description() != after.model_description();
    if meta_changed {
        return Some(RecordedModelEditPayload {
            connection_id,
            kind: "metadata".to_string(),
            action: "upsert".to_string(),
            name: None,
            payload: Some(json!({
                "name": after.model_name(),
                "version": after.model_version(),
                "author": after.model_author(),
                "description": after.model_description(),
            })),
            replayable: true,
            reason: None,
        });
    }
    if before.default_lookup_resolution() != after.default_lookup_resolution() {
        return Some(not_replayable(
            connection_id,
            "metadata",
            "upsert",
            None,
            "the default lookup resolution is not scriptable via bi.model",
        ));
    }
    // A no-op install (nothing visibly changed) records nothing.
    None
}

// ---------------------------------------------------------------------------
// Gateway-ready payload builders
// ---------------------------------------------------------------------------

/// Find one object of an overview list by a string field.
fn find_in<'a>(ov: &'a Value, list: &str, field: &str, value: &str) -> Option<&'a Map<String, Value>> {
    ov.get(list)?.as_array()?.iter().find_map(|v| {
        let o = v.as_object()?;
        (o.get(field)?.as_str()? == value).then_some(o)
    })
}

/// Clone an overview DTO object, dropping and adding fields to reach the
/// gateway payload shape.
fn clone_with(o: &Map<String, Value>, add: &[(&str, Value)], drop: &[&str]) -> Value {
    let mut m = o.clone();
    for d in drop {
        m.remove(*d);
    }
    for (k, v) in add {
        m.insert((*k).to_string(), v.clone());
    }
    Value::Object(m)
}

/// Build the `caps.biModel.upsert` payload for a changed object, from the
/// POST-edit model. Field names mirror the `gateway_field` reads of the
/// matching `script_bi_model` dispatch arm — that adjacency (same crate, same
/// module tree) is the drift guard.
fn upsert_payload(
    kind: &str,
    name: &str,
    original: Option<&str>,
    after: &bi_engine::DataModel,
) -> Result<Value, String> {
    let ov = serde_json::to_value(super::model_editor::build_overview(after, &[], true, None))
        .map_err(|e| e.to_string())?;
    let orig = match original {
        Some(o) => Value::String(o.to_string()),
        None => Value::Null,
    };
    let missing = || format!("changed {} '{}' not found in the edited model", kind, name);

    let payload = match kind {
        "measure" => {
            let m = find_in(&ov, "measures", "name", name).ok_or_else(missing)?;
            json!({
                "originalName": orig,
                "name": m.get("name"),
                "formula": m.get("formula"),
                "description": m.get("description"),
                "formatString": m.get("formatString"),
                "formatStringExpression": m.get("formatStringExpression"),
                "detailRows": m.get("detailRows"),
                "group": m.get("group"),
                "hidden": m.get("isHidden"),
            })
        }
        "calcColumn" => {
            // Calc columns live merged into their table's column list.
            let (table, col) = ov
                .get("tables")
                .and_then(Value::as_array)
                .and_then(|tables| {
                    tables.iter().find_map(|t| {
                        let to = t.as_object()?;
                        let c = to.get("columns")?.as_array()?.iter().find_map(|c| {
                            let co = c.as_object()?;
                            (co.get("isCalculated")?.as_bool()? && co.get("name")?.as_str()? == name)
                                .then_some(co)
                        })?;
                        Some((to.get("name")?.clone(), c))
                    })
                })
                .ok_or_else(missing)?;
            json!({
                "originalName": orig,
                "name": col.get("name"),
                "table": table,
                "formula": col.get("formula"),
                "dataType": col.get("dataType"),
                "description": col.get("description"),
            })
        }
        "relationship" => {
            let o = find_in(&ov, "relationships", "name", name).ok_or_else(missing)?;
            clone_with(o, &[("originalName", orig)], &[])
        }
        "hierarchy" => {
            let o = find_in(&ov, "hierarchies", "name", name).ok_or_else(missing)?;
            clone_with(o, &[("originalName", orig)], &[])
        }
        "kpi" => {
            let o = find_in(&ov, "kpis", "name", name).ok_or_else(missing)?;
            clone_with(o, &[("originalName", orig)], &[])
        }
        "calcGroup" => {
            let o = find_in(&ov, "calculationGroups", "name", name).ok_or_else(missing)?;
            clone_with(o, &[("originalName", orig)], &[])
        }
        "perspective" => {
            let o = find_in(&ov, "perspectives", "name", name).ok_or_else(missing)?;
            clone_with(o, &[("originalName", orig)], &[])
        }
        "culture" => {
            let o = find_in(&ov, "cultures", "locale", name).ok_or_else(missing)?;
            clone_with(o, &[("originalLocale", orig)], &[])
        }
        "scriptFunction" => {
            let o = find_in(&ov, "scriptFunctions", "name", name).ok_or_else(missing)?;
            clone_with(o, &[("originalName", orig)], &[])
        }
        "calculatedTable" => {
            let o = find_in(&ov, "globalVariables", "name", name).ok_or_else(missing)?;
            json!({
                "originalName": orig,
                "name": o.get("name"),
                "table": o.get("table"),
                "expression": o.get("expression"),
                "dynamic": o.get("dynamic"),
            })
        }
        "tableVariable" => {
            let o = find_in(&ov, "tableVariables", "name", name).ok_or_else(missing)?;
            clone_with(o, &[("originalName", orig)], &[])
        }
        "context" => {
            let o = find_in(&ov, "contexts", "name", name).ok_or_else(missing)?;
            json!({
                "originalName": orig,
                "name": o.get("name"),
                "expression": o.get("expression"),
            })
        }
        "contextColumn" => {
            let o = find_in(&ov, "contextColumns", "name", name).ok_or_else(missing)?;
            clone_with(o, &[("originalName", orig)], &[])
        }
        "writebackColumn" => {
            let o = find_in(&ov, "writebackColumns", "name", name).ok_or_else(missing)?;
            // A create replays with originalId null (the server mints the id);
            // an edit/rename addresses the existing column by its stable id.
            let original_id = if original.is_some() {
                o.get("id").cloned().unwrap_or(Value::Null)
            } else {
                Value::Null
            };
            clone_with(o, &[("originalId", original_id)], &["id", "historyTable"])
        }
        "extensionData" => {
            json!({
                "key": name,
                "value": after.extension_data().get(name),
            })
        }
        // dateTable/metadata go through scalar_capture; anything else here is
        // a coverage bug the tests catch by this marker.
        other => return Err(format!("UNSUPPORTED_KIND: {}", other)),
    };
    Ok(payload)
}

/// Build the `caps.biModel.delete` payload for a removed object, from the
/// PRE-edit model (the object is gone from `after`).
fn delete_payload(kind: &str, name: &str, before: &bi_engine::DataModel) -> Result<Value, String> {
    Ok(match kind {
        "culture" => json!({ "locale": name }),
        "extensionData" => json!({ "key": name }),
        // The recorded event cannot see the user's cascade choice; false is
        // the conservative replay (fail loudly if references remain).
        "calculatedTable" => json!({ "name": name, "cascade": false }),
        "writebackColumn" => {
            let ov = serde_json::to_value(super::model_editor::build_overview(
                before,
                &[],
                true,
                None,
            ))
            .map_err(|e| e.to_string())?;
            let o = find_in(&ov, "writebackColumns", "name", name)
                .ok_or_else(|| format!("deleted writeback column '{}' not found", name))?;
            json!({ "id": o.get("id") })
        }
        "metadata" | "dateTable" => {
            return Err(format!("UNSUPPORTED_KIND: {} has no delete", kind));
        }
        _ => json!({ "name": name }),
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use bi_engine::{sum_measure, Column, DataModel, DataType, StorageMode, Table};

    fn conn() -> ConnectionId {
        ConnectionId::from_bytes(identity::generate_uuid_v7())
    }

    fn sales_table() -> Table {
        Table::new(
            "Sales",
            vec![
                Column::new("country", DataType::String),
                Column::new("amount", DataType::Float64),
            ],
        )
        .unwrap()
        .with_storage_mode(StorageMode::InMemory)
    }

    fn base() -> DataModel {
        DataModel::builder().add_table(sales_table()).build().unwrap()
    }

    fn with_measure(name: &str) -> DataModel {
        DataModel::builder()
            .add_table(sales_table())
            .add_measure(sum_measure(name, "Sales", "amount"))
            .build()
            .unwrap()
    }

    #[test]
    fn measure_add_captures_gateway_ready_upsert() {
        let cap = compute_capture(conn(), &base(), &with_measure("Revenue")).unwrap();
        assert!(cap.replayable, "reason: {:?}", cap.reason);
        assert_eq!(cap.kind, "measure");
        assert_eq!(cap.action, "upsert");
        assert_eq!(cap.name.as_deref(), Some("Revenue"));
        let p = cap.payload.unwrap();
        // Exactly the keys the gateway's ("measure","upsert") arm reads.
        let mut keys: Vec<&str> = p.as_object().unwrap().keys().map(|s| s.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "description", "detailRows", "formatString", "formatStringExpression",
                "formula", "group", "hidden", "name", "originalName",
            ]
        );
        assert_eq!(p["originalName"], Value::Null);
        assert_eq!(p["name"], "Revenue");
        assert_eq!(p["hidden"], false);
    }

    #[test]
    fn measure_rename_carries_original_name() {
        let cap = compute_capture(conn(), &with_measure("Revenue"), &with_measure("Sales Rev"))
            .unwrap();
        assert!(cap.replayable);
        let p = cap.payload.unwrap();
        assert_eq!(p["originalName"], "Revenue");
        assert_eq!(p["name"], "Sales Rev");
    }

    #[test]
    fn measure_in_place_edit_sets_original_to_self() {
        let before = with_measure("Revenue");
        let after = DataModel::builder()
            .add_table(sales_table())
            .add_measure(sum_measure("Revenue", "Sales", "amount").with_description("net"))
            .build()
            .unwrap();
        let cap = compute_capture(conn(), &before, &after).unwrap();
        assert!(cap.replayable);
        let p = cap.payload.unwrap();
        assert_eq!(p["originalName"], "Revenue");
        assert_eq!(p["description"], "net");
    }

    #[test]
    fn measure_delete_captures_name_payload() {
        let cap = compute_capture(conn(), &with_measure("Revenue"), &base()).unwrap();
        assert!(cap.replayable);
        assert_eq!(cap.action, "delete");
        assert_eq!(cap.payload.unwrap(), json!({ "name": "Revenue" }));
    }

    #[test]
    fn role_edit_is_not_replayable_and_leaks_no_name() {
        let after = DataModel::builder()
            .add_table(sales_table())
            .add_security_role(bi_engine::SecurityRole::new("EMEA Managers").with_filter(
                "Sales",
                "country",
                bi_engine::ComparisonOp::Equal,
                "SE",
            ))
            .build()
            .unwrap();
        let cap = compute_capture(conn(), &base(), &after).unwrap();
        assert!(!cap.replayable);
        assert_eq!(cap.kind, "role");
        assert!(cap.name.is_none(), "role names are privileged");
        assert!(cap.payload.is_none());
        let text = serde_json::to_string(&cap).unwrap();
        assert!(!text.contains("EMEA"), "role name leaked into the capture event");
    }

    #[test]
    fn date_table_set_and_metadata_edit_capture_precisely() {
        let dated = DataModel::builder()
            .add_table(sales_table())
            .build()
            .unwrap()
            .with_date_table(Some("Sales".to_string()));
        let cap = compute_capture(conn(), &base(), &dated).unwrap();
        assert!(cap.replayable);
        assert_eq!(cap.kind, "dateTable");
        assert_eq!(cap.payload.unwrap(), json!({ "table": "Sales" }));

        let renamed = base().with_model_metadata(
            Some("Q3 Model".to_string()),
            None,
            None,
            None,
        );
        let cap = compute_capture(conn(), &base(), &renamed).unwrap();
        assert!(cap.replayable);
        assert_eq!(cap.kind, "metadata");
        assert_eq!(cap.payload.unwrap()["name"], "Q3 Model");
    }

    #[test]
    fn multi_domain_change_without_fanout_is_bulk_not_replayable() {
        // Measure AND a second table added in one install: replaying only the
        // measure would silently drop the table, so this must not replay.
        let after = DataModel::builder()
            .add_table(sales_table())
            .add_table(
                Table::new("Dates", vec![Column::new("day", DataType::String)])
                    .unwrap()
                    .with_storage_mode(StorageMode::InMemory),
            )
            .add_measure(sum_measure("Revenue", "Sales", "amount"))
            .build()
            .unwrap();
        let cap = compute_capture(conn(), &base(), &after).unwrap();
        assert!(!cap.replayable);
        assert_eq!(cap.kind, "bulk");
    }

    #[test]
    fn table_add_is_not_replayable() {
        let after = DataModel::builder()
            .add_table(sales_table())
            .add_table(
                Table::new("Dates", vec![Column::new("day", DataType::String)])
                    .unwrap()
                    .with_storage_mode(StorageMode::InMemory),
            )
            .build()
            .unwrap();
        let cap = compute_capture(conn(), &base(), &after).unwrap();
        assert!(!cap.replayable);
        assert_eq!(cap.kind, "table");
    }

    fn with_ext_data(key: &str, value: Value) -> DataModel {
        let mut map = std::collections::BTreeMap::new();
        map.insert(key.to_string(), value);
        base().with_extension_data(map)
    }

    #[test]
    fn extension_data_set_and_delete_capture() {
        let with_data = with_ext_data("acme.notes", json!({ "v": 1 }));
        let cap = compute_capture(conn(), &base(), &with_data).unwrap();
        assert!(cap.replayable, "reason: {:?}", cap.reason);
        assert_eq!(cap.kind, "extensionData");
        assert_eq!(cap.payload.unwrap(), json!({ "key": "acme.notes", "value": { "v": 1 } }));

        let cap = compute_capture(conn(), &with_data, &base()).unwrap();
        assert!(cap.replayable);
        assert_eq!(cap.action, "delete");
        assert_eq!(cap.payload.unwrap(), json!({ "key": "acme.notes" }));
    }

    #[test]
    fn oversized_payload_records_as_not_replayable() {
        let big = "x".repeat(MAX_CAPTURED_PAYLOAD_BYTES + 1024);
        let with_data = with_ext_data("acme.blob", json!(big));
        let cap = compute_capture(conn(), &base(), &with_data).unwrap();
        assert!(!cap.replayable);
        assert!(cap.reason.unwrap().contains("too large"));
    }

    #[test]
    fn noop_install_captures_nothing() {
        assert!(compute_capture(conn(), &base(), &base()).is_none());
    }

    /// Every gateway-mutable kind must have a payload-builder arm: an unknown
    /// kind returns the UNSUPPORTED_KIND marker, a known-but-absent object a
    /// "not found" error. dateTable/metadata are scalar-path kinds.
    #[test]
    fn every_gateway_mutable_kind_has_a_builder_arm() {
        let model = base();
        for kind in super::super::model_editor::GATEWAY_MUTABLE_KINDS {
            if *kind == "dateTable" || *kind == "metadata" {
                continue;
            }
            match upsert_payload(kind, "nonexistent", None, &model) {
                Ok(_) => {} // extensionData builds unconditionally
                Err(e) => assert!(
                    !e.starts_with("UNSUPPORTED_KIND"),
                    "kind '{}' has no upsert builder arm",
                    kind
                ),
            }
        }
    }
}
