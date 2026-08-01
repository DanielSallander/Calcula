//! FILENAME: app/src-tauri/src/extension_audit.rs
//! PURPOSE: The MACHINE-scoped, append-only record of every add-in trust
//!          decision this computer has made: what was installed, who signed it,
//!          what trust status it had AT THE MOMENT it was accepted, what it
//!          declared it would contribute and reach, when — and the same for
//!          removal and for accepting a publisher-key change.
//! CONTEXT: Calcula already has an audit trail, but `calp::audit` is
//!          WORKBOOK-scoped: it lives inside the open .cala and it goes away
//!          when the document does. Installing an add-in is not a fact about a
//!          document. It is a fact about the machine: the code lands in
//!          %APPDATA%/com.calcula.app/extensions and it loads into EVERY
//!          workbook the user opens afterwards. Recording it in a workbook
//!          would mean the one decision with the widest blast radius was the
//!          one decision with the shortest-lived record — and, worse, a
//!          decision the user could only rediscover by opening the right file.
//!
//! WHY THIS IS PART OF THE SECURITY BAR, not bookkeeping:
//!
//!   * TRANSPARENCY is one of the three promises. "The user must always know
//!     where code resides and what it can touch" is not answerable after the
//!     fact unless somebody wrote down what was agreed to and when. A consent
//!     dialog that leaves no trace is a consent dialog nobody can audit.
//!   * The TOFU pin store (`trusted-publishers.json`) records the OUTCOME (this
//!     key is trusted for this id) but not the DECISION (who asked, when, what
//!     it claimed it would do, what Calcula could prove at the time). A pin that
//!     appeared out of nowhere is exactly what task 1 of this wave removed from
//!     the scan path; this file is what makes the remaining, legitimate pins
//!     explicable afterwards.
//!   * A publisher change accepted six months ago is the single most important
//!     thing to be able to look up when an add-in later misbehaves. It is
//!     recorded as its own action, with BOTH keys.
//!
//! THE RULES THIS FILE KEEPS:
//!
//!   1. APPEND-ONLY. Every write is an `O_APPEND` of one JSON object plus a
//!      newline. Nothing here ever rewrites, reorders, compacts or deletes a
//!      line. A trail that its own writer can edit is not a trail. (The same
//!      discipline as the writeback event log — see
//!      docs/design/writeback-event-log — for the same reason.)
//!   2. IT NEVER BLOCKS THE ACT IT RECORDS. `record` returns `()`. An install
//!      that succeeded must not be reported as failed because a log line could
//!      not be written, and — the direction that actually matters — a failure
//!      to log must never be turned into a reason to skip the trust checks. The
//!      failure is surfaced through `last_write_error()` so the UI can say "the
//!      trail could not be written" instead of silently showing a short list.
//!   3. IT IS DATA, NOT AUTHORITY. Nothing in Calcula reads this file to decide
//!      whether an add-in may load. Trust decisions come from the signature, the
//!      code hash and the pin store, re-derived from disk every scan. If this
//!      file were consulted, an attacker who can write the profile directory
//!      could grant trust by appending a line.
//!   4. IT IS READ THROUGH A MAIN-WINDOW-ONLY COMMAND. It names the add-ins on
//!      this machine and their publisher keys; a background or child window has
//!      no business enumerating them.
//!
//! Location: `<profile>/extension-audit.jsonl`, beside `trusted-publishers.json`
//! (%LOCALAPPDATA%\Calcula), because it is a fact about this user on this
//! machine, exactly like the pin store it explains.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// The trail's file name inside the Calcula profile directory.
pub const EXTENSION_AUDIT_FILE: &str = "extension-audit.jsonl";

/// Hard ceiling on how many entries a single read returns (newest kept). The
/// FILE is never truncated — rule 1 — but a UI that has to render an unbounded
/// list is a UI that stops being read, and the recent decisions are the ones a
/// user is actually trying to reconstruct.
pub const MAX_RETURNED_ENTRIES: usize = 500;

/// A single line of the trail is refused above this size so a corrupt or
/// hostile file cannot be used to balloon the reader's memory.
const MAX_LINE_BYTES: usize = 64 * 1024;

// ---------------------------------------------------------------------------
// The action vocabulary
// ---------------------------------------------------------------------------
//
// Deliberately small and deliberately explicit. Each value answers a question a
// worried user asks in those words, and every one of them is a moment where
// trust CHANGED — never a moment where code merely ran.

/// A bundle was copied into the extensions directory after the user confirmed.
pub const ACTION_INSTALLED: &str = "installed";
/// A bundle (and its sidecars) was deleted from the extensions directory.
pub const ACTION_REMOVED: &str = "removed";
/// A publisher key was pinned for an id for the first time.
pub const ACTION_PUBLISHER_PINNED: &str = "publisherPinned";
/// A DIFFERENT publisher key replaced an existing pin, after the user answered
/// the separate publisher-change question.
pub const ACTION_PUBLISHER_CHANGE_ACCEPTED: &str = "publisherChangeAccepted";

/// Every action this store can record. Exported so a UI cannot render an
/// unlabelled row for an action it has no phrasing for (the same failure the
/// trust-status badge list guards against) and so a test can pin the list.
pub const EXTENSION_AUDIT_ACTIONS: &[&str] = &[
    ACTION_INSTALLED,
    ACTION_REMOVED,
    ACTION_PUBLISHER_PINNED,
    ACTION_PUBLISHER_CHANGE_ACCEPTED,
];

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/// One machine-scoped add-in trust decision.
///
/// Every field is what Calcula could state FROM EVIDENCE at the moment of the
/// decision. Nothing here is re-derived on read: the point of the record is that
/// it preserves what was true and what was claimed THEN, so a later change (a
/// re-signed manifest, a swapped bundle, a corrupted pin store) cannot rewrite
/// the user's memory of what they agreed to.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionAuditEntry {
    /// RFC 3339 UTC timestamp of the decision.
    pub at: String,
    /// One of `EXTENSION_AUDIT_ACTIONS`.
    pub action: String,
    /// Sidecar manifest id — the TOFU + consent identity ("" when unknowable,
    /// e.g. removing a bundle whose manifest is already gone).
    #[serde(default)]
    pub id: String,
    /// Display name at the time.
    #[serde(default)]
    pub name: String,
    /// Version at the time.
    #[serde(default)]
    pub version: String,
    /// The file name the scan reports: "<base>.js" or "<dir>/index.js". This is
    /// the handle the user sees in the Extensions list and in uninstall.
    #[serde(default)]
    pub bundle_file_name: String,
    /// Ed25519 public key asserted by the manifest ("" when unsigned).
    #[serde(default)]
    pub publisher_key: String,
    /// The key that was pinned BEFORE this decision ("" when there was none).
    /// Non-empty on `publisherChangeAccepted` is the whole point of that row.
    #[serde(default)]
    pub previous_publisher_key: String,
    /// The trust status Calcula computed at that moment (the same vocabulary as
    /// `extension_install::EXTENSION_TRUST_STATUSES`).
    #[serde(default)]
    pub trust_status: String,
    /// Whether that status let the add-in's declared ceiling survive.
    #[serde(default)]
    pub capabilities_honored: bool,
    /// Capabilities as DECLARED in the manifest at that moment.
    #[serde(default)]
    pub declared_capabilities: Vec<String>,
    /// Declared contributions, flattened "kind:id" so one row shows exactly what
    /// the add-in said it would add to the app.
    #[serde(default)]
    pub contributions: Vec<String>,
    /// Where the bundle was read FROM (install only). Absolute, as the user
    /// picked it in the native folder dialog.
    #[serde(default)]
    pub source_path: String,
    /// A plain-language sentence, written once, at decision time.
    #[serde(default)]
    pub detail: String,
}

/// A read of the trail, plus whether the trail itself is healthy. Both halves
/// matter: a UI must be able to distinguish "nothing was ever installed" from
/// "the record could not be read", because those look identical as an empty
/// list and mean opposite things.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionAuditTrail {
    /// Newest first. At most `MAX_RETURNED_ENTRIES`.
    pub entries: Vec<ExtensionAuditEntry>,
    /// Total lines the file holds (may exceed `entries.len()`).
    pub total: usize,
    /// Lines that could not be parsed. Non-zero means the file was damaged;
    /// it is REPORTED rather than swallowed, because a silently-dropped line is
    /// indistinguishable from a decision that never happened.
    pub unreadable_lines: usize,
    /// Absolute path of the trail, so the user can go and read it themselves.
    /// The vision's transparency promise does not end at Calcula's own UI.
    pub path: String,
    /// True when the file does not exist yet (nothing has ever been recorded).
    pub missing: bool,
    /// The last write that failed, if any (this process's lifetime). Empty when
    /// every record so far reached disk.
    pub last_write_error: String,
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/// Last append failure in this process. Held so `record` can keep its promise of
/// never failing the act it records while still not hiding that it failed.
static LAST_WRITE_ERROR: Mutex<Option<String>> = Mutex::new(None);

/// Absolute path of the trail for a given profile directory.
pub fn audit_path(profile_dir: &Path) -> PathBuf {
    profile_dir.join(EXTENSION_AUDIT_FILE)
}

/// The failure of the most recent append, if it failed.
pub fn last_write_error() -> Option<String> {
    LAST_WRITE_ERROR.lock().ok().and_then(|g| g.clone())
}

/// Append one entry. NEVER fails the caller (rule 2) — the outcome is visible
/// through `last_write_error()` and surfaces in `read_trail`.
pub fn record(profile_dir: &Path, entry: ExtensionAuditEntry) {
    if let Err(e) = try_record(profile_dir, &entry) {
        crate::log_warn!(
            "extension_audit",
            "failed to record '{}' for '{}': {}",
            entry.action,
            entry.id,
            e
        );
        if let Ok(mut g) = LAST_WRITE_ERROR.lock() {
            *g = Some(e);
        }
        return;
    }
    if let Ok(mut g) = LAST_WRITE_ERROR.lock() {
        *g = None;
    }
}

/// The fallible half, split out so tests can assert the bytes actually landed.
pub fn try_record(profile_dir: &Path, entry: &ExtensionAuditEntry) -> Result<(), String> {
    std::fs::create_dir_all(profile_dir)
        .map_err(|e| format!("could not create '{}': {}", profile_dir.display(), e))?;
    // One line, one object. Serialized WITHOUT pretty-printing precisely so a
    // record is exactly one line: a multi-line record could be truncated by an
    // interrupted write into something that still parses as a different,
    // smaller decision.
    let mut line = serde_json::to_string(entry).map_err(|e| e.to_string())?;
    if line.contains('\n') {
        // Defensive: serde_json never emits a raw newline inside a string, but a
        // trail whose framing can be forged by a field value would be a trail an
        // attacker can rewrite by naming an add-in cleverly.
        line = line.replace('\n', " ");
    }
    line.push('\n');

    let path = audit_path(profile_dir);
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("could not open '{}': {}", path.display(), e))?;
    file.write_all(line.as_bytes())
        .map_err(|e| format!("could not write '{}': {}", path.display(), e))?;
    // Durability matters more than throughput for a security record that is
    // written a handful of times in a machine's life.
    file.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Timestamp helper so every record in this store agrees on the format.
pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// Read the trail, newest first, tolerating damage rather than hiding it.
pub fn read_trail(profile_dir: &Path) -> ExtensionAuditTrail {
    let path = audit_path(profile_dir);
    let mut trail = ExtensionAuditTrail {
        path: path.to_string_lossy().to_string(),
        last_write_error: last_write_error().unwrap_or_default(),
        ..Default::default()
    };

    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            trail.missing = true;
            return trail;
        }
        Err(e) => {
            // The file exists and cannot be read: that is NOT "nothing was ever
            // installed", and it must not be presented as such.
            trail.last_write_error = format!(
                "the add-in trail at '{}' could not be read: {}",
                path.display(),
                e
            );
            return trail;
        }
    };

    let mut parsed: Vec<ExtensionAuditEntry> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        trail.total += 1;
        if line.len() > MAX_LINE_BYTES {
            trail.unreadable_lines += 1;
            continue;
        }
        match serde_json::from_str::<ExtensionAuditEntry>(line) {
            Ok(entry) => parsed.push(entry),
            Err(_) => trail.unreadable_lines += 1,
        }
    }

    parsed.reverse(); // newest first
    parsed.truncate(MAX_RETURNED_ENTRIES);
    trail.entries = parsed;
    trail
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/// Read this machine's add-in trust trail.
///
/// SECURITY: main-window only. It enumerates every add-in on the machine and
/// the publisher keys behind them; a child or background window has no reason
/// to ask. Read-only by construction — this module exposes no command that
/// writes, so the trail cannot be edited from the renderer at all.
#[tauri::command]
pub fn list_extension_audit(window: tauri::Window) -> Result<ExtensionAuditTrail, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    Ok(read_trail(&crate::calp_commands::calcula_profile_dir()))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(action: &str, id: &str) -> ExtensionAuditEntry {
        ExtensionAuditEntry {
            at: now_rfc3339(),
            action: action.to_string(),
            id: id.to_string(),
            name: "Demo".to_string(),
            version: "1.0.0".to_string(),
            bundle_file_name: "demo.js".to_string(),
            publisher_key: "aaaa".to_string(),
            trust_status: "verified".to_string(),
            capabilities_honored: true,
            declared_capabilities: vec!["formula.udf".to_string()],
            contributions: vec!["formulas:DEMO".to_string()],
            ..Default::default()
        }
    }

    #[test]
    fn a_missing_trail_reads_as_missing_not_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let trail = read_trail(dir.path());
        assert!(trail.missing, "an absent file must say so");
        assert_eq!(trail.total, 0);
        assert!(trail.entries.is_empty());
        assert!(trail.path.ends_with(EXTENSION_AUDIT_FILE));
    }

    #[test]
    fn records_append_and_read_back_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        try_record(dir.path(), &entry(ACTION_INSTALLED, "a.one")).unwrap();
        try_record(dir.path(), &entry(ACTION_INSTALLED, "b.two")).unwrap();
        try_record(dir.path(), &entry(ACTION_REMOVED, "a.one")).unwrap();

        let trail = read_trail(dir.path());
        assert!(!trail.missing);
        assert_eq!(trail.total, 3);
        assert_eq!(trail.unreadable_lines, 0);
        assert_eq!(trail.entries.len(), 3);
        assert_eq!(trail.entries[0].action, ACTION_REMOVED);
        assert_eq!(trail.entries[0].id, "a.one");
        assert_eq!(trail.entries[2].id, "a.one");
        assert_eq!(trail.entries[2].action, ACTION_INSTALLED);
        assert_eq!(
            trail.entries[0].declared_capabilities,
            vec!["formula.udf".to_string()]
        );
    }

    /// The defining property: writing never rewrites. Two appends leave the
    /// FIRST line byte-identical.
    #[test]
    fn appending_never_rewrites_an_earlier_line() {
        let dir = tempfile::tempdir().unwrap();
        try_record(dir.path(), &entry(ACTION_INSTALLED, "a.one")).unwrap();
        let first = std::fs::read_to_string(audit_path(dir.path())).unwrap();
        try_record(dir.path(), &entry(ACTION_REMOVED, "a.one")).unwrap();
        let after = std::fs::read_to_string(audit_path(dir.path())).unwrap();
        assert!(
            after.starts_with(&first),
            "an append must leave every earlier byte untouched"
        );
        assert_eq!(after.lines().count(), 2);
    }

    #[test]
    fn a_damaged_line_is_counted_not_swallowed() {
        let dir = tempfile::tempdir().unwrap();
        try_record(dir.path(), &entry(ACTION_INSTALLED, "a.one")).unwrap();
        // A truncated / hand-edited line.
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(audit_path(dir.path()))
            .unwrap();
        f.write_all(b"{ not json\n").unwrap();
        drop(f);
        try_record(dir.path(), &entry(ACTION_REMOVED, "a.one")).unwrap();

        let trail = read_trail(dir.path());
        assert_eq!(trail.total, 3);
        assert_eq!(trail.entries.len(), 2);
        assert_eq!(
            trail.unreadable_lines, 1,
            "a line that could not be read must be reported, never silently dropped"
        );
    }

    #[test]
    fn a_publisher_change_records_both_keys() {
        let dir = tempfile::tempdir().unwrap();
        let mut e = entry(ACTION_PUBLISHER_CHANGE_ACCEPTED, "a.one");
        e.previous_publisher_key = "old-key".to_string();
        e.publisher_key = "new-key".to_string();
        try_record(dir.path(), &e).unwrap();

        let trail = read_trail(dir.path());
        assert_eq!(trail.entries[0].previous_publisher_key, "old-key");
        assert_eq!(trail.entries[0].publisher_key, "new-key");
    }

    /// A field value must not be able to forge a second record.
    #[test]
    fn a_newline_in_a_field_cannot_forge_a_row() {
        let dir = tempfile::tempdir().unwrap();
        let mut e = entry(ACTION_INSTALLED, "evil");
        e.name = "Nice\n{\"action\":\"removed\",\"id\":\"victim\"}".to_string();
        try_record(dir.path(), &e).unwrap();
        let trail = read_trail(dir.path());
        assert_eq!(trail.total, 1, "one record must occupy exactly one line");
        assert_eq!(trail.entries.len(), 1);
        assert_eq!(trail.entries[0].id, "evil");
    }

    #[test]
    fn a_read_is_capped_but_the_total_is_honest() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..(MAX_RETURNED_ENTRIES + 7) {
            try_record(dir.path(), &entry(ACTION_INSTALLED, &format!("id{i}"))).unwrap();
        }
        let trail = read_trail(dir.path());
        assert_eq!(trail.entries.len(), MAX_RETURNED_ENTRIES);
        assert_eq!(trail.total, MAX_RETURNED_ENTRIES + 7);
        // Newest first, so the cap drops the OLDEST rows.
        assert_eq!(
            trail.entries[0].id,
            format!("id{}", MAX_RETURNED_ENTRIES + 6)
        );
    }

    #[test]
    fn the_action_vocabulary_is_the_documented_four() {
        assert_eq!(EXTENSION_AUDIT_ACTIONS.len(), 4);
        for a in [
            ACTION_INSTALLED,
            ACTION_REMOVED,
            ACTION_PUBLISHER_PINNED,
            ACTION_PUBLISHER_CHANGE_ACCEPTED,
        ] {
            assert!(EXTENSION_AUDIT_ACTIONS.contains(&a), "missing action {a}");
        }
    }
}
