//! FILENAME: app/src-tauri/src/object_bindings/audit.rs
// PURPOSE: The audit row a SCRIPT or AI binding edit leaves (D §3.11), in the
//          one per-workbook trail every script and AI action already writes.
// CONTEXT: A binding is EVALUATED, never executed, so it is not code; but who
//          bound what is exactly the transparency question the vision asks
//          ("the user must always know ... what it can touch"). An ordinary
//          user edit (`BindingEditSource::User`) records nothing, like any
//          other edit; a script or AI edit -- accepted OR refused -- records one
//          `ScriptExecuted` row with structured fields.
//
// The source label is renderer-supplied (D §3.9): it LABELS the row and drives
// the defence-in-depth clamp re-check; it is never a security boundary.

use serde_json::json;

use crate::api_types::{BindingEditSource, ObjectBindingRef};
use crate::AppState;

/// What a binding edit was, as the audit row's `op` field spells it.
pub const ACTION_BINDING_SET: &str = "bindingSet";
pub const ACTION_BINDING_CLEAR: &str = "bindingClear";
pub const ACTION_LITERAL_SET: &str = "literalSet";

/// The `surface` an object-script binding row carries (an AI row carries
/// `"mcp"`, written by `record_mcp_tool_action`).
pub const SCRIPT_BINDING_SURFACE: &str = "objectScript";

fn verb(action: &str) -> &'static str {
    match action {
        ACTION_BINDING_SET => "bound",
        ACTION_BINDING_CLEAR => "unbound",
        _ => "set",
    }
}

/// Record one binding edit by a script or the AI. `refusal` is the sentence
/// when the edit was refused (the row then says `ok: false`). A `User` source
/// records nothing.
pub fn record_binding_edit(
    state: &AppState,
    source: &BindingEditSource,
    action: &str,
    object: &ObjectBindingRef,
    path: &str,
    formula_or_value: &str,
    refusal: Option<&str>,
) {
    let target = format!("{} {}", object.kind.wire_name(), object.id);
    let mut fields: Vec<(&str, serde_json::Value)> = vec![
        ("op", json!(action)),
        ("objectKind", json!(object.kind.wire_name())),
        ("objectId", json!(object.id)),
        ("path", json!(path)),
        ("formula", json!(formula_or_value)),
        ("ok", json!(refusal.is_none())),
    ];
    if let Some(why) = refusal {
        fields.push(("error", json!(why)));
    }
    let description = match refusal {
        None => format!("{} {path} of {target}: {formula_or_value}", capitalised(verb(action))),
        Some(why) => format!("Refused: {} {path} of {target}: {why}", verb(action)),
    };
    match source {
        BindingEditSource::User => {}
        BindingEditSource::Ai { tool } => {
            crate::scripting::commands::record_mcp_tool_action(state, tool, &description, fields);
        }
        BindingEditSource::Script { script_id, unlocked } => {
            let mut extra: std::collections::HashMap<String, serde_json::Value> = fields
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect();
            extra.insert("surface".into(), json!(SCRIPT_BINDING_SURFACE));
            extra.insert("scriptId".into(), json!(script_id));
            extra.insert("unlocked".into(), json!(unlocked));
            crate::calp_commands::record_audit_event_with_extra(
                state,
                calp::audit::AuditEvent::ScriptExecuted,
                description,
                extra,
            );
        }
    }
}

fn capitalised(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}
