//! FILENAME: core/calp/src/audit.rs
//! PURPOSE: Opt-in audit log for subscription events in .cala workbooks.
//! CONTEXT: Records subscription events, refreshes, override creation/deletion.
//! Policy is set per workspace: a workspace may require audit logging for
//! applications it serves. Off by default.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Audit log stored in the .cala file (audit_log.json in user_files).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditLog {
    pub format_version: u32,
    /// Whether audit logging is enabled.
    pub enabled: bool,
    /// Maximum number of entries to keep (0 = unlimited).
    #[serde(default)]
    pub max_entries: usize,
    /// Audit entries, newest last.
    pub entries: Vec<AuditEntry>,
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

/// A single audit log entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    /// ISO 8601 timestamp.
    pub timestamp: String,
    /// Event type.
    pub event: AuditEvent,
    /// Human-readable description.
    pub description: String,
    /// Who performed the action (if known).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub user: String,
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Types of auditable events.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditEvent {
    /// Subscribed to a new application.
    Subscribe,
    /// Refreshed one or more subscriptions.
    Refresh,
    /// Detached from all subscriptions.
    Detach,
    /// Created an override on a cell.
    OverrideCreated,
    /// Reverted an override.
    OverrideReverted,
    /// Resolved a conflict (accepted upstream or kept override).
    ConflictResolved,
    /// Exported overrides as a patch.
    OverrideExported,
    /// Imported overrides from a patch.
    OverrideImported,
    /// Published an application version.
    Published,
    /// Opened a published application version as a WORKING COPY (checkout). The
    /// author-side counterpart of `Subscribe`: same materialization, different
    /// intent — this workbook is now something that can push.
    CheckedOut,
    /// A checkout was REFUSED because the application carries a module,
    /// notebook or defined name with the same identity as one this workbook
    /// already holds (opened here, the workbook's own would have been kept and
    /// later pushed as the application's). The colliding ids are in `extra`.
    CheckoutRefused,
    /// A published version was refused because of WHO SIGNED IT (BUG-0262):
    /// its signer is not an authorised publisher of the application, or the
    /// application's first version -- the anchor -- cannot be verified. Recorded
    /// by every door that opens a version for editing: checkout, the push merge
    /// and the push dialog's hold-back. `extra` names the door, the application,
    /// the version, and the signer with their key fingerprint.
    SignerRefused,
    /// An application's button code was refused: a push whose held code could
    /// not be proved to be the application's, or that would publish button code
    /// nobody acknowledged (BUG-0257), a click on a button cell whose action is
    /// not its application's to run (BUG-0260), a push whose buttons run a
    /// macro it does not publish (`reason` "unshippedMacro"), and a push whose
    /// "Include in application" names code that changed since the author read
    /// it (`reason` "includedChanged"). `extra` names the door, the application
    /// and the cells (or, for an inclusion, the items). Since phase 4 the button
    /// door (`run_control_action`) records here what it refuses about the BUTTON
    /// itself, door "click": a stamp it cannot read ("stampUnreadable"), held code
    /// that is not static ("unsupportedValueType"), a control that is not a button
    /// ("notAButton"), a button cell's held action in a working copy
    /// ("heldInWorkingCopy"), and a stamped cell's foreign macro. A stamped
    /// cell's COMMAND is refused by the command gate instead
    /// (`ApplicationCodeRefused`, surface "buttonCommand"); the page records
    /// here only what it refuses itself about a command (its live registration).
    ButtonCodeRefused,
    /// The user told THIS COMPUTER to forget who created an application it
    /// develops (the developer anchor). A deliberate hole: the next checkout or
    /// push records whatever root the workspace then names, which is exactly
    /// what a planted first version needs. `extra` names the workspace (as the
    /// user configured it), the application and the forgotten root's key
    /// fingerprint.
    DeveloperAnchorForgotten,
    /// An application's code RAN (M4, phase 3 of BUG-0257): a macro that came
    /// with an application ran through the module runtime, or an application's
    /// code was mounted by a button click. Recorded by the host's run gate
    /// (`scripting::application_code_gate`) AFTER every refusal it applies has
    /// passed. `extra` names the surface, the application, the macro and the
    /// sha256 of the source that ran -- and, for a button click, the button
    /// (its cell, caption and whether its link came with the application), read
    /// from the backend's own store, never from the page. Since plan_M8 S1 also a
    /// button cell of an application's running a Calcula command on Calcula's
    /// list, once approved (surface "buttonCommand", `commandId` in place of
    /// `macroId`).
    ApplicationCodeRun,
    /// An application's code was REFUSED before it ran: not approved
    /// (`reason` "notConsented"), a working copy with the developer's own sheets
    /// beside the application ("privateSheets"), or a button click the stored
    /// button does not back ("triggerMismatch"). Since phase 4 also: held button
    /// code handed to a run that is not its button's ("heldCodeOutsideButton"),
    /// and a click whose plan the button door refused ("objectScriptMacro",
    /// "ambiguous", "composesApplicationCode"; surface "button"). `extra` names
    /// the surface, the application, the macro -- for inline button code its
    /// approval id `buttonAction:<sha256>` -- and, when a button asked, the button.
    /// Since plan_M8 S1 also an application's button COMMAND (surface
    /// "buttonCommand", `commandId` in place of `macroId`): not on Calcula's list
    /// ("notAllowlisted"), not approved under its own key ("notConsented"), the
    /// private-sheet rule, or a claim the stored cell does not back
    /// ("triggerMismatch").
    ApplicationCodeRefused,
    /// The user made an application's button code THEIR OWN ("Make this my
    /// own", phase 4 of BUG-0257): the code the application shipped moved out
    /// of the held compartment into the button's live slots, where it runs as
    /// the user's own code with no approval. `extra` names the application, the
    /// version, the button's cell and caption, and each moved slot with the
    /// sha256 of its bytes.
    ButtonCodeAdopted,
    /// Changed which ENVIRONMENT a subscription follows — or moved it to or
    /// from the development line.
    ///
    /// It replaces a `ChannelChanged` variant that no code ever recorded,
    /// beside a `Subscription.channel` field no code ever read. Opt-in like
    /// `Subscribe` rather than always-on: it changes what WILL arrive on the
    /// next refresh, not what has already left the machine.
    SubscriptionEnvironmentChanged,
    /// Submitted writeback values to the workspace.
    WritebackSubmitted,
    /// Writeback drafts invalidated by refresh (removed/incompatible regions).
    WritebackInvalidated,
    /// Publisher approved or rejected a submitted writeback value.
    WritebackReviewed,
    /// A sandboxed script (run_script / notebook cell / MCP tool) mutated grid cells.
    ScriptExecuted,
    /// A sandboxed script/extension used a broker-mediated capability (net.fetch,
    /// bi.query, bi.sql, storage, ui.html, formula.udf, …) — success or denial.
    /// The specific capability + outcome live in the entry's `extra`.
    CapabilityCall,
    /// Sheet or workbook protection was turned on, turned off, or reconfigured.
    ///
    /// Protection is what a workbook author relies on to state "these cells are
    /// not yours to change". A change to that boundary is exactly the kind of
    /// event the Transparency pillar exists for — without it, a user reopening a
    /// shared workbook has no way to learn that a script unprotected a sheet.
    ProtectionChanged,
    /// A language model proposed something and the user accepted it into the
    /// document — a formula inserted from the formula assistant, most of all.
    ///
    /// The user pressed the button, so this is not a record of the machine
    /// acting alone. It is a record of WHERE THE CONTENT CAME FROM, which is a
    /// different question and the one nobody can answer six months later by
    /// looking at the cell. The `extra` map carries the surface, the model, the
    /// target cell and whether Calcula's own engine verified the result before
    /// it was offered — so an unverified suggestion that was accepted anyway is
    /// findable rather than indistinguishable from a checked one.
    AiAssistedEdit,
}

impl AuditEvent {
    /// Events recorded EVEN WHEN the (collaboration) audit log is disabled.
    ///
    /// The Transparency pillar requires that a user never has to wonder what
    /// touched their data, so two classes are always on:
    ///
    /// * SCRIPT ACTIVITY — grid mutations and capability use.
    /// * WRITEBACK — submitting is the moment a contributor's typed values
    ///   LEAVE THE MACHINE for a shared workspace, which makes it an egress
    ///   event much closer to a `CapabilityCall` (net.fetch and friends) than
    ///   to bookkeeping like subscribe/refresh. `WritebackReviewed` and
    ///   `WritebackInvalidated` are its counterparts: an approve/reject changes
    ///   whether someone's answer counts, and an invalidation silently discards
    ///   entered work. Recording those only when a workbook happened to opt in
    ///   meant the trail was absent exactly when someone needed to reconstruct
    ///   what they had sent.
    ///
    /// * PUBLISH — the same egress argument as writeback, pointed the other
    ///   way: a push is the moment this workbook's content LEAVES THE MACHINE
    ///   for a shared workspace, where other people will pull it. In the
    ///   workspace model it is also the workbook's only local record of its own
    ///   release history, and "which version did I push, from which base" is
    ///   precisely the question asked after something went wrong — i.e. when
    ///   nobody thought to turn logging on first.
    ///
    /// The remaining collaboration events (subscribe/refresh/override/…) stay
    /// opt-in via the `enabled` flag.
    pub fn is_always_recorded(&self) -> bool {
        matches!(
            self,
            AuditEvent::ScriptExecuted
                | AuditEvent::CapabilityCall
                | AuditEvent::WritebackSubmitted
                | AuditEvent::WritebackReviewed
                | AuditEvent::WritebackInvalidated
                | AuditEvent::Published
                // Protection changes are a security boundary moving; recording
                // them only when collaboration auditing happens to be on would
                // make the trail useless exactly when it matters.
                | AuditEvent::ProtectionChanged
                // Provenance of generated content. A workbook that never
                // subscribed to anything has collaboration auditing off, and that
                // is exactly the workbook where a colleague later asks "did a
                // person write this formula or did a model?". Opt-in would make
                // the trail empty in the common case.
                | AuditEvent::AiAssistedEdit
                // A refused checkout names ids that SOMEBODY ELSE shipped. An
                // application can ship a module id matching a predictable local
                // one (`macro-<slug>`) and block every developer who owns it --
                // a lever, and one that is only visible if the refusals are
                // recorded where nobody had to opt in first.
                | AuditEvent::CheckoutRefused
                // "Every run and every refusal of application code is written
                // to the audit trail" (the BUG-0257 guardrail). A refusal is
                // what a planted version or a forged working copy PRODUCES, so a
                // trail that exists only when somebody opted in first is absent
                // exactly when it is evidence.
                | AuditEvent::SignerRefused
                | AuditEvent::ButtonCodeRefused
                // Forgetting an application's remembered creator re-opens the
                // one door the anchor closes (a planted first version). If a
                // planted root is later accepted, this row is how anyone finds
                // out when, and on whose say-so, the memory was dropped.
                | AuditEvent::DeveloperAnchorForgotten
                // "Every run and every refusal of application code is written
                // to the audit trail" -- the guardrail phase 3 arms buttons
                // under. A run of an application's macro is the moment a
                // stranger's code touched this workbook; a trail that exists
                // only when somebody opted in first is empty in the common case.
                | AuditEvent::ApplicationCodeRun
                | AuditEvent::ApplicationCodeRefused
                // Making an application's code your own switches off every
                // approval it would have needed from then on. The row is how
                // anyone later learns that a stranger's code became "yours",
                // when and at which button -- recorded whether or not somebody
                // opted in to auditing.
                | AuditEvent::ButtonCodeAdopted
        )
    }
}

/// Default rolling cap for the audit log when one is not explicitly set, so the
/// always-on script-activity trail (and a default-on collaboration log) cannot
/// grow unbounded in the workbook. Mirrors the frontend broker ring capacity.
pub const DEFAULT_MAX_ENTRIES: usize = 2000;

impl AuditLog {
    pub fn new() -> Self {
        Self {
            format_version: 1,
            enabled: false,
            max_entries: DEFAULT_MAX_ENTRIES,
            entries: Vec::new(),
            extra: HashMap::new(),
        }
    }

    pub fn new_enabled(max_entries: usize) -> Self {
        Self {
            format_version: 1,
            enabled: true,
            max_entries,
            entries: Vec::new(),
            extra: HashMap::new(),
        }
    }

    /// Record an event. No-op if logging is disabled UNLESS the event is
    /// always-recorded (script activity — see `AuditEvent::is_always_recorded`).
    pub fn record(&mut self, event: AuditEvent, description: &str, user: &str, now: &str) {
        self.record_with_extra(event, description, user, now, HashMap::new());
    }

    /// Record an event with structured `extra` fields (e.g. a script's surface,
    /// id, mutated sheet/range). Same enable/always-recorded gating as `record`.
    pub fn record_with_extra(
        &mut self,
        event: AuditEvent,
        description: &str,
        user: &str,
        now: &str,
        extra: HashMap<String, serde_json::Value>,
    ) {
        if !self.enabled && !event.is_always_recorded() {
            return;
        }

        self.entries.push(AuditEntry {
            timestamp: now.to_string(),
            event,
            description: description.to_string(),
            user: user.to_string(),
            extra,
        });

        // Trim to max_entries if set.
        //
        // ALWAYS-RECORDED ENTRIES ARE EVICTED LAST. A plain oldest-first drain
        // let high-volume opt-in traffic push the always-on trail out of the
        // window: an `immediate`-policy writeback region submits on every
        // committed cell, so a busy form could evict the script-activity
        // entries that are supposed to be non-negotiable. Drop the oldest
        // opt-in entries first, and only fall back to dropping always-recorded
        // ones once nothing else is left to give.
        if self.max_entries > 0 && self.entries.len() > self.max_entries {
            let mut excess = self.entries.len() - self.max_entries;

            let optional_count = self
                .entries
                .iter()
                .filter(|e| !e.event.is_always_recorded())
                .count();
            if optional_count >= excess {
                // Enough opt-in entries to absorb the whole overflow.
                let mut to_drop = excess;
                self.entries.retain(|e| {
                    if to_drop > 0 && !e.event.is_always_recorded() {
                        to_drop -= 1;
                        false
                    } else {
                        true
                    }
                });
            } else {
                // Drop every opt-in entry, then the oldest always-recorded ones.
                self.entries.retain(|e| e.event.is_always_recorded());
                excess -= optional_count;
                if excess > 0 {
                    let excess = excess.min(self.entries.len());
                    self.entries.drain(..excess);
                }
            }
        }
    }

    /// Get the most recent N entries.
    pub fn recent(&self, n: usize) -> &[AuditEntry] {
        let start = self.entries.len().saturating_sub(n);
        &self.entries[start..]
    }

    /// Clear the log.
    pub fn clear(&mut self) {
        self.entries.clear();
    }

    pub fn entry_count(&self) -> usize {
        self.entries.len()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_log_ignores_events() {
        let mut log = AuditLog::new();
        assert!(!log.enabled);
        log.record(AuditEvent::Subscribe, "test", "user", "2026-01-01T00:00:00Z");
        assert_eq!(log.entry_count(), 0);
    }

    #[test]
    fn writeback_events_record_even_when_disabled() {
        let mut log = AuditLog::new();
        assert!(!log.enabled);
        for ev in [
            AuditEvent::WritebackSubmitted,
            AuditEvent::WritebackReviewed,
            AuditEvent::WritebackInvalidated,
        ] {
            log.record(ev, "wb", "user", "2026-01-01T00:00:00Z");
        }
        assert_eq!(
            log.entry_count(),
            3,
            "writeback egress/review/invalidation must not depend on the opt-in flag"
        );
        // Collaboration bookkeeping stays opt-in.
        log.record(AuditEvent::Refresh, "r", "user", "2026-01-01T00:00:00Z");
        assert_eq!(log.entry_count(), 3);
    }

    /// A refused checkout names ids somebody else shipped; recorded only when
    /// auditing is on, the refusals -- and a colleague's module id blocking
    /// every developer who owns the same one -- would be invisible in the
    /// common case. A successful checkout stays opt-in.
    ///
    /// SABOTAGE: drop `CheckoutRefused` from `is_always_recorded`.
    #[test]
    fn a_refused_checkout_is_recorded_even_when_auditing_is_off() {
        let mut log = AuditLog::new();
        assert!(!log.enabled);
        log.record(AuditEvent::CheckoutRefused, "refused", "user", "2026-09-30T00:00:00Z");
        assert_eq!(log.entry_count(), 1, "a refused checkout left no trail");
        log.record(AuditEvent::CheckedOut, "opened", "user", "2026-09-30T00:00:00Z");
        assert_eq!(log.entry_count(), 1, "a successful checkout is opt-in bookkeeping");
        let json = serde_json::to_string(&log.entries[0].event).unwrap();
        assert_eq!(json, "\"checkout_refused\"", "the audit viewer keys on this spelling");
    }

    /// A refusal of application code -- a version refused for who signed it, a
    /// push or a click refused over button code -- leaves a trail with auditing
    /// OFF (the default), under the spellings the audit viewer keys on.
    ///
    /// SABOTAGE: drop `SignerRefused` and `ButtonCodeRefused` from
    /// `is_always_recorded`.
    #[test]
    fn refusals_of_application_code_are_recorded_even_when_auditing_is_off() {
        let mut log = AuditLog::new();
        assert!(!log.enabled);
        log.record(AuditEvent::SignerRefused, "refused a planted version", "user", "2026-09-30T00:00:00Z");
        log.record(AuditEvent::ButtonCodeRefused, "refused a forged push", "user", "2026-09-30T00:00:00Z");
        assert_eq!(log.entry_count(), 2, "a refusal of application code left no trail");
        let spell = |e: &AuditEvent| serde_json::to_string(e).unwrap();
        assert_eq!(spell(&log.entries[0].event), "\"signer_refused\"");
        assert_eq!(spell(&log.entries[1].event), "\"button_code_refused\"");
    }

    /// Forgetting a remembered creator is recorded with auditing OFF.
    ///
    /// SABOTAGE: drop `DeveloperAnchorForgotten` from `is_always_recorded`.
    #[test]
    fn forgetting_a_remembered_creator_is_recorded_even_when_auditing_is_off() {
        let mut log = AuditLog::new();
        assert!(!log.enabled);
        log.record(AuditEvent::DeveloperAnchorForgotten, "forgot", "user", "2026-09-30T00:00:00Z");
        assert_eq!(log.entry_count(), 1, "forgetting a remembered creator left no trail");
        assert_eq!(
            serde_json::to_string(&log.entries[0].event).unwrap(),
            "\"developer_anchor_forgotten\""
        );
    }

    /// Every run and every refusal of an application's code is recorded with
    /// auditing OFF (the default), under the spellings the audit viewer keys on.
    ///
    /// SABOTAGE: drop `ApplicationCodeRun` and `ApplicationCodeRefused` from
    /// `is_always_recorded`.
    #[test]
    fn application_code_events_are_always_recorded() {
        let mut log = AuditLog::new();
        assert!(!log.enabled);
        log.record(AuditEvent::ApplicationCodeRun, "ran", "user", "2026-09-30T00:00:00Z");
        log.record(AuditEvent::ApplicationCodeRefused, "refused", "user", "2026-09-30T00:00:00Z");
        assert_eq!(log.entry_count(), 2, "a run or a refusal of application code left no trail");
        let spell = |e: &AuditEvent| serde_json::to_string(e).unwrap();
        assert_eq!(spell(&log.entries[0].event), "\"application_code_run\"");
        assert_eq!(spell(&log.entries[1].event), "\"application_code_refused\"");
    }

    /// "Make this my own" is recorded with auditing OFF, under the spelling the
    /// audit viewer keys on.
    ///
    /// SABOTAGE: drop `ButtonCodeAdopted` from `is_always_recorded`.
    #[test]
    fn button_code_adopted_is_always_recorded() {
        let mut log = AuditLog::new();
        assert!(!log.enabled);
        log.record(AuditEvent::ButtonCodeAdopted, "adopted", "user", "2026-10-01T00:00:00Z");
        assert_eq!(log.entry_count(), 1, "making an application's code your own left no trail");
        assert_eq!(
            serde_json::to_string(&log.entries[0].event).unwrap(),
            "\"button_code_adopted\""
        );
    }

    #[test]
    fn trim_evicts_optional_entries_before_always_recorded_ones() {
        let mut log = AuditLog::new_enabled(4);
        // Two always-recorded entries first, so an oldest-first drain would
        // have taken exactly these.
        log.record(AuditEvent::ScriptExecuted, "script-a", "u", "t1");
        log.record(AuditEvent::CapabilityCall, "cap-a", "u", "t2");
        for i in 0..6 {
            log.record(AuditEvent::Refresh, &format!("refresh-{i}"), "u", "t3");
        }
        assert_eq!(log.entry_count(), 4);
        let kept: Vec<&str> = log.entries.iter().map(|e| e.description.as_str()).collect();
        assert!(kept.contains(&"script-a"), "script trail evicted: {:?}", kept);
        assert!(kept.contains(&"cap-a"), "capability trail evicted: {:?}", kept);
        // The survivors among the optional entries are the NEWEST ones.
        assert!(kept.contains(&"refresh-5"), "{:?}", kept);
        assert!(!kept.contains(&"refresh-0"), "{:?}", kept);
    }

    #[test]
    fn trim_falls_back_to_dropping_always_recorded_when_nothing_else_left() {
        // The cap is still a hard bound — an all-always-recorded log must not
        // grow without limit just because every entry is privileged.
        let mut log = AuditLog::new_enabled(3);
        for i in 0..7 {
            log.record(AuditEvent::ScriptExecuted, &format!("s{i}"), "u", "t");
        }
        assert_eq!(log.entry_count(), 3);
        let kept: Vec<&str> = log.entries.iter().map(|e| e.description.as_str()).collect();
        assert_eq!(kept, vec!["s4", "s5", "s6"], "oldest-first within the class");
    }

    #[test]
    fn enabled_log_records_events() {
        let mut log = AuditLog::new_enabled(0);
        log.record(AuditEvent::Subscribe, "Subscribed to pkg v1.0", "alice", "2026-01-01T00:00:00Z");
        log.record(AuditEvent::Refresh, "Refreshed to v1.1", "alice", "2026-01-02T00:00:00Z");

        assert_eq!(log.entry_count(), 2);
        assert_eq!(log.entries[0].description, "Subscribed to pkg v1.0");
        assert!(matches!(log.entries[1].event, AuditEvent::Refresh));
    }

    #[test]
    fn max_entries_trims_oldest() {
        let mut log = AuditLog::new_enabled(3);

        for i in 0..5 {
            log.record(AuditEvent::OverrideCreated, &format!("override {}", i), "", &format!("2026-01-0{}T00:00:00Z", i + 1));
        }

        assert_eq!(log.entry_count(), 3);
        assert_eq!(log.entries[0].description, "override 2"); // oldest two trimmed
    }

    #[test]
    fn recent_returns_tail() {
        let mut log = AuditLog::new_enabled(0);
        for i in 0..10 {
            log.record(AuditEvent::Refresh, &format!("event {}", i), "", "2026-01-01T00:00:00Z");
        }

        let recent = log.recent(3);
        assert_eq!(recent.len(), 3);
        assert_eq!(recent[0].description, "event 7");
    }

    #[test]
    fn serde_roundtrip() {
        let mut log = AuditLog::new_enabled(100);
        log.record(AuditEvent::Published, "Published v2.0", "bob", "2026-05-18T10:00:00Z");

        let json = serde_json::to_string(&log).unwrap();
        let deserialized: AuditLog = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.entry_count(), 1);
        assert!(matches!(deserialized.entries[0].event, AuditEvent::Published));
    }

    #[test]
    fn clear_removes_all() {
        let mut log = AuditLog::new_enabled(0);
        log.record(AuditEvent::Detach, "detached", "", "2026-01-01T00:00:00Z");
        log.clear();
        assert_eq!(log.entry_count(), 0);
    }

    #[test]
    fn script_executed_variant_roundtrips() {
        let mut log = AuditLog::new_enabled(0);
        log.record(AuditEvent::ScriptExecuted, "A script modified 3 cell(s)", "local", "2026-06-28T00:00:00Z");
        let json = serde_json::to_string(&log).unwrap();
        assert!(json.contains("\"script_executed\""));
        let back: AuditLog = serde_json::from_str(&json).unwrap();
        assert!(matches!(back.entries[0].event, AuditEvent::ScriptExecuted));
    }

    #[test]
    fn script_events_record_even_when_disabled() {
        // Transparency: a DISABLED (default) log still records script activity,
        // but NOT opt-in collaboration events.
        let mut log = AuditLog::new();
        assert!(!log.enabled);
        log.record(AuditEvent::Subscribe, "collaboration event", "user", "2026-01-01T00:00:00Z");
        assert_eq!(log.entry_count(), 0, "collaboration events stay opt-in");
        log.record(AuditEvent::ScriptExecuted, "a script wrote cells", "local", "2026-01-01T00:00:00Z");
        assert_eq!(log.entry_count(), 1, "script activity is always recorded");
    }

    #[test]
    fn record_with_extra_carries_structured_fields() {
        let mut log = AuditLog::new(); // disabled by default; script event still records
        let mut extra = HashMap::new();
        extra.insert("surface".to_string(), serde_json::json!("run_script"));
        extra.insert("surfaceId".to_string(), serde_json::json!("hello.js"));
        extra.insert("sheet".to_string(), serde_json::json!(0));
        extra.insert("cellsModified".to_string(), serde_json::json!(3));
        log.record_with_extra(AuditEvent::ScriptExecuted, "run_script modified 3 cell(s)", "local", "2026-06-28T00:00:00Z", extra);
        let json = serde_json::to_string(&log).unwrap();
        // `extra` is flattened onto the entry.
        assert!(json.contains("\"surface\":\"run_script\""));
        assert!(json.contains("\"surfaceId\":\"hello.js\""));
        let back: AuditLog = serde_json::from_str(&json).unwrap();
        assert_eq!(back.entries[0].extra.get("cellsModified"), Some(&serde_json::json!(3)));
    }

    #[test]
    fn default_log_has_a_rolling_cap() {
        let log = AuditLog::new();
        assert_eq!(log.max_entries, DEFAULT_MAX_ENTRIES);
    }

    #[test]
    fn capability_call_records_even_when_disabled_with_detail() {
        // Capability use is script activity → always recorded (transparency),
        // even on a disabled (default) log, with structured detail.
        let mut log = AuditLog::new();
        assert!(!log.enabled);
        let mut extra = HashMap::new();
        extra.insert("capability".to_string(), serde_json::json!("net.fetch"));
        extra.insert("scriptId".to_string(), serde_json::json!("ext:weather"));
        extra.insert("ok".to_string(), serde_json::json!(true));
        extra.insert("detail".to_string(), serde_json::json!("https://api.example.com"));
        log.record_with_extra(AuditEvent::CapabilityCall, "net.fetch → https://api.example.com", "local", "2026-06-29T00:00:00Z", extra);
        assert_eq!(log.entry_count(), 1);
        let json = serde_json::to_string(&log).unwrap();
        assert!(json.contains("\"capability_call\""));
        assert!(json.contains("\"net.fetch\""));
        let back: AuditLog = serde_json::from_str(&json).unwrap();
        assert!(matches!(back.entries[0].event, AuditEvent::CapabilityCall));
        assert_eq!(back.entries[0].extra.get("scriptId"), Some(&serde_json::json!("ext:weather")));
    }
}
