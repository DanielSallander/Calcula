//! FILENAME: app/src-tauri/src/ai/audit.rs
// PURPOSE: Record, in the workbook's own audit trail, that a model proposed
//          something and a person accepted it into the document.
// CONTEXT: Calcula's Transparency pillar says a user must always be able to
//          find out what touched their data. Sandboxed scripts, capability
//          calls and protection changes all record; generated content did not,
//          because until the formula assistant there was none.
//
//          The event is deliberately narrow: it fires when ACCEPTED CONTENT
//          LANDS, never when a model is merely asked something. A log of every
//          question would bury the one line anybody ever needs — "this cell's
//          formula came from a model, on this date, and the engine had
//          verified it first" — under a hundred lines of chatter.
//
//          `verified` is the field that earns the whole entry. A verified
//          proposal was computed by Calcula's own evaluator against the real
//          workbook before the preview appeared; an unverified one is a
//          suggestion the user took anyway. Six months later those are the two
//          cases someone needs to tell apart, and the cell itself cannot.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::document_effect::{CleanReason, DocumentEffect};
use crate::AppState;

/// What the user accepted, and what was known about it at the time.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAcceptedEdit {
    /// Which feature offered it: `"formulaAssist"`, `"chat"`, `"insights"`.
    pub surface: String,
    /// What the user did with it: `"insert"`, `"insertFillDown"`, `"replace"`.
    pub action: String,
    /// The model that produced it, as the provider reported it.
    pub model: String,
    /// Sheet name and A1 target, for the entry's description.
    pub sheet: String,
    pub target: String,
    /// The content itself, truncated. A formula is short; a narrated paragraph
    /// is not, and an audit trail that stores whole documents stops being a
    /// trail and becomes a second copy of the workbook.
    pub content: String,
    /// Did Calcula's engine compute this against the real workbook and agree
    /// with what the preview claimed, BEFORE the user was offered it?
    pub verified: bool,
    /// Set when `verified` is false, so the trail says why rather than leaving
    /// a reader to guess whether verification failed or never ran.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unverified_reason: Option<String>,
}

/// Longest `content` kept in an entry. Past this the trail is storing prose.
const MAX_CONTENT_CHARS: usize = 300;

/// Truncate on a CHARACTER boundary. Slicing a `String` by bytes panics on a
/// multi-byte character, and a formula can hold any text a user typed — a
/// Swedish sheet name in a cross-sheet reference is enough to hit it.
fn clip(s: &str) -> String {
    if s.chars().count() <= MAX_CONTENT_CHARS {
        return s.to_string();
    }
    let head: String = s.chars().take(MAX_CONTENT_CHARS).collect();
    format!("{head}…")
}

/// Build the human sentence and the structured fields for one accepted edit.
///
/// Split out from the command so it can be tested without a Tauri window: the
/// interesting behaviour is entirely in what the entry SAYS.
pub fn describe(edit: &AiAcceptedEdit) -> (String, HashMap<String, serde_json::Value>) {
    let verb = match edit.action.as_str() {
        "insertFillDown" => "inserted and filled down",
        "replace" => "replaced",
        _ => "inserted",
    };
    let checked = if edit.verified {
        "verified by the engine"
    } else {
        "NOT verified"
    };
    let where_ = if edit.sheet.is_empty() {
        edit.target.clone()
    } else {
        format!("{}!{}", edit.sheet, edit.target)
    };
    let description = format!(
        "AI-assisted edit {verb} at {where_} ({checked}) — {} via {}",
        edit.model, edit.surface
    );

    // `verified` goes in as a real boolean, not the string "true". The audit
    // viewer filters on it, and a string that looks like a boolean is the kind
    // of thing a later filter gets subtly wrong.
    let mut extra: HashMap<String, serde_json::Value> = HashMap::new();
    extra.insert("surface".to_string(), edit.surface.clone().into());
    extra.insert("action".to_string(), edit.action.clone().into());
    extra.insert("model".to_string(), edit.model.clone().into());
    extra.insert("sheet".to_string(), edit.sheet.clone().into());
    extra.insert("target".to_string(), edit.target.clone().into());
    extra.insert("content".to_string(), clip(&edit.content).into());
    extra.insert("verified".to_string(), edit.verified.into());
    if let Some(reason) = &edit.unverified_reason {
        extra.insert("unverifiedReason".to_string(), clip(reason).into());
    }
    (description, extra)
}

/// Record one accepted AI edit.
///
/// `deliberately_clean(AuditTrail)` for the same reason every other audit write
/// is: the trail is a record OF a change, not itself a change to saved content
/// the user would be prompted about. The mutation that dirtied the document was
/// the cell write, and it set the flag on its own.
#[tauri::command]
pub fn ai_record_accepted_edit(
    edit: AiAcceptedEdit,
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;

    // The caller sends no sheet name on purpose: which sheet is active is
    // backend state, and a name passed in from the renderer would be a second
    // source of truth that goes stale the moment the user switches tabs between
    // asking and accepting.
    let mut edit = edit;
    if edit.sheet.is_empty() {
        let names = state.sheet_names.read().map_err(|e| e.to_string())?;
        let active = *state.active_sheet.read().map_err(|e| e.to_string())?;
        edit.sheet = names.get(active).cloned().unwrap_or_default();
    }

    let (description, extra) = describe(&edit);
    let now = chrono::Utc::now().to_rfc3339();
    let user = state
        .subscriber_identity
        .lock()
        .ok()
        .and_then(|id| id.as_ref().map(|i| i.display_name.clone()))
        .unwrap_or_default();

    let mut log = state
        .audit_log
        .write(&DocumentEffect::deliberately_clean(CleanReason::AuditTrail))
        .map_err(|e| format!("Audit log unavailable: {e}"))?;
    log.record_with_extra(
        calp::audit::AuditEvent::AiAssistedEdit,
        &description,
        &user,
        &now,
        extra,
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn an_edit() -> AiAcceptedEdit {
        AiAcceptedEdit {
            surface: "formulaAssist".to_string(),
            action: "insert".to_string(),
            model: "qwen2.5-coder:1.5b".to_string(),
            sheet: "Sales".to_string(),
            target: "D2".to_string(),
            content: "=SUMIFS(C:C,A:A,\"North\")".to_string(),
            verified: true,
            unverified_reason: None,
        }
    }

    #[test]
    fn a_verified_edit_says_so_in_the_sentence_a_person_reads() {
        let (description, extra) = describe(&an_edit());
        assert!(description.contains("verified by the engine"), "{description}");
        assert!(description.contains("Sales!D2"), "{description}");
        assert_eq!(extra.get("verified").and_then(|v| v.as_bool()), Some(true));
    }

    #[test]
    fn an_unverified_edit_is_distinguishable_and_carries_its_reason() {
        // The whole point of the entry: an accepted suggestion the engine never
        // checked must not read like a checked one.
        let mut edit = an_edit();
        edit.verified = false;
        edit.unverified_reason = Some("the model returned no parseable formula".to_string());
        let (description, extra) = describe(&edit);
        assert!(description.contains("NOT verified"), "{description}");
        assert_eq!(extra.get("verified").and_then(|v| v.as_bool()), Some(false));
        assert_eq!(
            extra.get("unverifiedReason").and_then(|v| v.as_str()),
            Some("the model returned no parseable formula")
        );
    }

    #[test]
    fn a_fill_down_reads_as_a_fill_down() {
        let mut edit = an_edit();
        edit.action = "insertFillDown".to_string();
        let (description, _) = describe(&edit);
        assert!(description.contains("inserted and filled down"), "{description}");
    }

    #[test]
    fn long_content_is_clipped_on_a_character_boundary_not_a_byte_one() {
        // A byte-slice truncation panics here. The repeated character is
        // multi-byte on purpose, and 400 of them exceeds the cap.
        let mut edit = an_edit();
        edit.content = "ä".repeat(400);
        let (_, extra) = describe(&edit);
        let stored = extra
            .get("content")
            .and_then(|v| v.as_str())
            .expect("content is always recorded, as a string");
        assert_eq!(stored.chars().count(), MAX_CONTENT_CHARS + 1, "clip keeps the ellipsis");
        assert!(stored.ends_with('…'));
    }

    #[test]
    fn the_event_is_recorded_even_with_distribution_auditing_switched_off() {
        // A workbook that never subscribed to anything has `enabled: false`,
        // and that is precisely the workbook where someone later asks who wrote
        // a formula. If this ever goes opt-in, the trail is empty in the common
        // case and the entry is worth nothing.
        assert!(calp::audit::AuditEvent::AiAssistedEdit.is_always_recorded());

        let mut log = calp::audit::AuditLog::new();
        assert!(!log.enabled, "the default really is off");
        let (description, extra) = describe(&an_edit());
        log.record_with_extra(
            calp::audit::AuditEvent::AiAssistedEdit,
            &description,
            "local",
            "2026-09-07T00:00:00Z",
            extra,
        );
        assert_eq!(log.entries.len(), 1);
    }
}
