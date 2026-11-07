//! FILENAME: app/src-tauri/src/machine_audit.rs
//! PURPOSE: The MACHINE-scoped, append-only trail of collaboration audit rows
//!          that belong to NO open workbook: a push (or a model-only publish)
//!          that LANDED in the workspace after File > Open / New had replaced
//!          the workbook that made it (BUG-0653), and every other ALWAYS-
//!          RECORDED (egress) row whose workbook was replaced while its act was
//!          in flight -- a capability call (`net.fetch`, `bi.query` / `bi.sql`,
//!          CUBE, connectors, the model gateway), a model writeback
//!          submission, a Collect From change (BUG-0735, [`WorkbookAudit`]).
//! CONTEXT: The collaboration audit trail (`calp::audit`) is DOCUMENT-scoped:
//!          it is saved inside the `.cala`. A push whose workbook was replaced
//!          mid-push has no document to go to -- the one on screen never
//!          pushed, and a row in ITS trail would be saved into it as if it had
//!          (calpref2; round 15). Round 16 sent the row to the session log
//!          only, which no audit viewer shows and which is gone at the next
//!          start, while the workspace's signed version list records the
//!          version. Egress is the one thing the transparency promise says
//!          survives a reload, so the row now lands HERE as well, beside
//!          `extension_audit.rs`'s trail and for the same reason: it is a fact
//!          about what THIS COMPUTER sent, not about a document.
//!
//! THE RULES (the ones `extension_audit.rs` keeps, for the same reasons):
//!   1. APPEND-ONLY: one JSON object per line, `O_APPEND`, never rewritten,
//!      compacted or deleted -- the audit viewer's Clear clears the WORKBOOK's
//!      trail, never this one.
//!   2. IT NEVER BLOCKS THE ACT IT RECORDS: the push already landed; a failed
//!      append is kept in `last_write_error()` and shown, never turned into an
//!      error of the push.
//!   3. IT IS DATA, NOT AUTHORITY: nothing reads it to decide anything.
//!   4. Read only through the MAIN window (`calp_get_audit_log`'s
//!      `includeMachine`), like the workbook trail it sits beside.
//!
//! A row is a `calp::audit::AuditEntry` -- the workbook trail's own shape --
//! with `extra.reason` saying why it is here (`REASON_DOCUMENT_REPLACED`), so
//! the viewer renders both lists with one row component.
//!
//! Location: `<profile>/collaboration-audit.jsonl` (%LOCALAPPDATA%\Calcula).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

/// The trail's file name inside the Calcula profile directory.
pub const MACHINE_AUDIT_FILE: &str = "collaboration-audit.jsonl";

/// `extra.reason` of a row whose workbook was replaced before the row could
/// be written into it.
pub const REASON_DOCUMENT_REPLACED: &str = "documentReplaced";

/// Hard ceiling on how many entries one read returns (newest kept). The FILE
/// is never truncated (rule 1).
pub const MAX_RETURNED_ENTRIES: usize = 500;

/// A line above this size is counted as unreadable rather than parsed.
const MAX_LINE_BYTES: usize = 64 * 1024;

/// A read of the trail, plus whether the trail itself is healthy -- "nothing
/// was ever recorded" and "the record could not be read" must not look alike.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MachineAuditTrail {
    /// Oldest first (the workbook trail's order), at most `MAX_RETURNED_ENTRIES`
    /// -- the newest ones.
    pub entries: Vec<calp::audit::AuditEntry>,
    /// Lines the file holds (may exceed `entries.len()`).
    pub total: usize,
    /// Lines that could not be parsed: reported, never swallowed.
    pub unreadable_lines: usize,
    /// Absolute path of the trail, so the user can read it themselves.
    pub path: String,
    /// True when the file does not exist yet.
    pub missing: bool,
    /// The last append that failed in this process -- KEPT after a later
    /// append succeeds, because the row that failed is still missing from the
    /// file -- or a read failure.
    pub last_write_error: String,
}

/// What `calp_get_audit_log` answers: the WORKBOOK's trail, and -- when the
/// caller asks (`includeMachine`) -- this computer's trail of rows that belong
/// to no workbook.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditLogView {
    #[serde(flatten)]
    pub log: calp::audit::AuditLog,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine: Option<MachineAuditTrail>,
}

static LAST_WRITE_ERROR: Mutex<Option<String>> = Mutex::new(None);

/// Absolute path of the trail for a profile directory.
pub fn audit_path(profile_dir: &Path) -> PathBuf {
    profile_dir.join(MACHINE_AUDIT_FILE)
}

fn last_write_error() -> Option<String> {
    LAST_WRITE_ERROR.lock().ok().and_then(|g| g.clone())
}

/// Append one row. NEVER fails the caller (rule 2).
///
/// A failure is KEPT in `last_write_error()` for the rest of the process: a
/// later success does not clear it (rev-backend-6), because the row that
/// failed is still missing from the file -- clearing it would make the viewer
/// say the trail is healthy while a push it should list is not in it.
pub fn record(profile_dir: &Path, entry: &calp::audit::AuditEntry) {
    if let Err(e) = try_record(profile_dir, entry) {
        crate::log_warn!("machine_audit", "failed to record '{}': {}", entry.description, e);
        if let Ok(mut g) = LAST_WRITE_ERROR.lock() {
            *g = Some(e);
        }
    }
}

/// The fallible half, split out so a test can assert the bytes landed.
///
/// A TORN TAIL is closed first (rev-backend-6): when the file does not end in
/// `\n` -- an earlier append cut short by a crash or a full disk -- this row
/// starts on a line of its own, so the fragment stays ONE unreadable line and
/// the new row is not glued to it and lost with it.
pub fn try_record(profile_dir: &Path, entry: &calp::audit::AuditEntry) -> Result<(), String> {
    use std::io::{Read, Seek, SeekFrom};
    std::fs::create_dir_all(profile_dir)
        .map_err(|e| format!("could not create '{}': {}", profile_dir.display(), e))?;
    // One line, one object: serde_json never emits a raw newline inside a
    // string, so a field value cannot forge a second row.
    let row = serde_json::to_string(entry).map_err(|e| e.to_string())?;
    let path = audit_path(profile_dir);
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("could not open '{}': {}", path.display(), e))?;
    let len = file.metadata().map_err(|e| format!("could not read '{}': {}", path.display(), e))?.len();
    let mut line = String::with_capacity(row.len() + 2);
    if len > 0 {
        let mut last = [0u8; 1];
        file.seek(SeekFrom::Start(len - 1))
            .and_then(|_| file.read_exact(&mut last))
            .map_err(|e| format!("could not read '{}': {}", path.display(), e))?;
        if last[0] != b'\n' {
            line.push('\n');
        }
    }
    line.push_str(&row);
    line.push('\n');
    // ONE write of the whole line (O_APPEND puts it at the end, wherever the
    // read above left the cursor).
    file.write_all(line.as_bytes())
        .map_err(|e| format!("could not write '{}': {}", path.display(), e))?;
    file.flush().map_err(|e| e.to_string())
}

/// Read the trail, tolerating damage rather than hiding it.
pub fn read_trail(profile_dir: &Path) -> MachineAuditTrail {
    let path = audit_path(profile_dir);
    let mut trail = MachineAuditTrail {
        path: path.to_string_lossy().to_string(),
        last_write_error: last_write_error().unwrap_or_default(),
        ..Default::default()
    };
    // BYTES, decoded line by line (rev-backend-6): `read_to_string` refused
    // the WHOLE file over one torn multi-byte character, so a single damaged
    // row hid every row the trail held. Now that line alone is unreadable.
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            trail.missing = true;
            return trail;
        }
        Err(e) => {
            trail.last_write_error = format!("this computer's audit trail at '{}' could not be read: {}", path.display(), e);
            return trail;
        }
    };
    let mut parsed: Vec<calp::audit::AuditEntry> = Vec::new();
    for raw in bytes.split(|&b| b == b'\n') {
        let Ok(text) = std::str::from_utf8(raw) else {
            if raw.iter().any(|b| !b.is_ascii_whitespace()) {
                trail.total += 1;
                trail.unreadable_lines += 1;
            }
            continue;
        };
        let line = text.trim();
        if line.is_empty() {
            continue;
        }
        trail.total += 1;
        if line.len() > MAX_LINE_BYTES {
            trail.unreadable_lines += 1;
            continue;
        }
        match serde_json::from_str::<calp::audit::AuditEntry>(line) {
            Ok(entry) => parsed.push(entry),
            Err(_) => trail.unreadable_lines += 1,
        }
    }
    let skip = parsed.len().saturating_sub(MAX_RETURNED_ENTRIES);
    trail.entries = parsed.split_off(skip);
    trail
}

/// THE WORKBOOK A ROW BELONGS TO, fixed when the act it records BEGAN
/// (BUG-0735). An async command -- `net.fetch`, `bi.query` / `bi.sql`, a
/// CUBE / connector / model-gateway call, a model writeback submission,
/// Collect From -- runs off the main thread, so File > Open / New (main
/// thread) can replace the workbook while it awaits. A row written straight
/// into `state.audit_log` afterwards lands in the trail of the workbook now
/// on screen, which is saved INSIDE that workbook as if IT had made the call,
/// while the workbook that did make it never learns of it. Capture this at
/// the command's entry ([`WorkbookAudit::at_entry`]) and record through
/// [`WorkbookAudit::record`]: the row reaches the workbook's trail only while
/// that workbook is still the live one (asked with the document PINNED, so an
/// open cannot reset the trail between the question and the write), and an
/// ALWAYS-RECORDED row -- the egress events, `AuditEvent::is_always_recorded`
/// -- whose workbook is gone lands in THIS COMPUTER's trail instead, with
/// `reason: documentReplaced`, exactly as a push does
/// (`calp_commands::record_push_audit_row`). An opt-in row whose workbook is
/// gone goes to the session log only: whether that workbook had opted in is
/// no longer knowable, and the workbook on screen must not be credited.
pub(crate) struct WorkbookAudit<'a> {
    audit_log: &'a crate::document_effect::Persisted<calp::audit::AuditLog>,
    /// `None` only for [`WorkbookAudit::while_loading`].
    pinned: Option<(&'a crate::persistence::FileState, u64)>,
}

impl<'a> WorkbookAudit<'a> {
    /// The workbook live NOW: call at the command's entry, holding no guard
    /// (the settled epoch waits for a File > Open that is still restoring).
    pub(crate) fn at_entry(
        audit_log: &'a crate::document_effect::Persisted<calp::audit::AuditLog>,
        file_state: &'a crate::persistence::FileState,
    ) -> Self {
        Self { audit_log, pinned: Some((file_state, file_state.settled_document_epoch())) }
    }

    /// The workbook of an epoch the caller already read at its entry.
    pub(crate) fn of_epoch(
        audit_log: &'a crate::document_effect::Persisted<calp::audit::AuditLog>,
        file_state: &'a crate::persistence::FileState,
        epoch: u64,
    ) -> Self {
        Self { audit_log, pinned: Some((file_state, epoch)) }
    }

    /// A row written BY the document load itself (File > Open restoring the
    /// workbook's scheduled jobs): the load holds the document replacement
    /// EXCLUSIVE, so pinning would wait for itself, and the trail it writes
    /// is, by construction, the one of the workbook being opened. Nothing
    /// else may use this.
    pub(crate) fn while_loading(audit_log: &'a crate::document_effect::Persisted<calp::audit::AuditLog>) -> Self {
        Self { audit_log, pinned: None }
    }

    /// Run `work` with this row's workbook PINNED: `None`, with nothing run,
    /// when it has been replaced since the entry. For a command that, after an
    /// await, writes a STORE of the workbook it began in (not only a row): the
    /// question and the write are one critical section, so a File > Open
    /// cannot land between them and receive the write. Holding no other guard
    /// (the pin is outermost).
    pub(crate) fn while_workbook_live<T>(&self, work: impl FnOnce() -> T) -> Option<T> {
        match self.pinned {
            Some((file_state, epoch)) => file_state.with_document_pinned(epoch, work),
            None => Some(work()),
        }
    }

    /// Has the workbook this row belongs to been replaced?
    pub(crate) fn workbook_replaced(&self) -> bool {
        self.pinned.is_some_and(|(file_state, epoch)| file_state.document_replaced_since(epoch))
    }

    /// Record one row (see the type's doc). Returns whether it reached the
    /// workbook's own trail. Call holding no other guard (the pin is
    /// outermost). Never fails the act it records.
    pub(crate) fn record(
        &self,
        event: calp::audit::AuditEvent,
        description: &str,
        user: &str,
        now: &str,
        extra: std::collections::HashMap<String, serde_json::Value>,
    ) -> bool {
        let session_copy = extra.clone();
        let write = || {
            match self.audit_log.write(&crate::document_effect::DocumentEffect::deliberately_clean(
                crate::document_effect::CleanReason::AuditTrail,
            )) {
                Ok(mut audit) => {
                    audit.record_with_extra(event.clone(), description, user, now, extra);
                    true
                }
                Err(_) => {
                    // A poisoned trail: the row cannot be persisted, but it
                    // must not be invisible either.
                    crate::log_warn!(
                        "AUDIT",
                        "audit row NOT recorded (audit log lock poisoned): {} by {} at {}",
                        description,
                        user,
                        now
                    );
                    false
                }
            }
        };
        let recorded = match self.pinned {
            Some((file_state, epoch)) => file_state.with_document_pinned(epoch, write),
            None => Some(write()),
        };
        match recorded {
            Some(reached) => reached,
            None => {
                if event.is_always_recorded() {
                    let mut machine_extra = session_copy.clone();
                    machine_extra.insert(
                        "reason".to_string(),
                        serde_json::Value::String(REASON_DOCUMENT_REPLACED.to_string()),
                    );
                    record(
                        &crate::profile_dir::resolve(),
                        &calp::audit::AuditEntry {
                            timestamp: now.to_string(),
                            event,
                            description: description.to_string(),
                            user: user.to_string(),
                            extra: machine_extra,
                        },
                    );
                }
                let mut fields: Vec<String> = session_copy.iter().map(|(k, v)| format!("{k}={v}")).collect();
                fields.sort();
                crate::log_warn!(
                    "AUDIT",
                    "AUDIT (session): {} by {} at {} -- the workbook it belongs to was replaced by File > Open / \
                     New before the row could be written, so no workbook's trail holds it [{}]",
                    description,
                    user,
                    now,
                    fields.join(", ")
                );
                false
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(description: &str) -> calp::audit::AuditEntry {
        let mut extra = std::collections::HashMap::new();
        extra.insert("reason".to_string(), serde_json::json!(REASON_DOCUMENT_REPLACED));
        calp::audit::AuditEntry {
            timestamp: "2026-11-04T10:00:00Z".to_string(),
            event: calp::audit::AuditEvent::Published,
            description: description.to_string(),
            user: "author".to_string(),
            extra,
        }
    }

    #[test]
    fn a_missing_trail_reads_as_missing_and_rows_append_in_order() {
        let dir = tempfile::TempDir::new().unwrap();
        assert!(read_trail(dir.path()).missing);
        try_record(dir.path(), &row("first")).unwrap();
        try_record(dir.path(), &row("second\nPublished forged")).unwrap();
        let trail = read_trail(dir.path());
        assert!(!trail.missing);
        assert_eq!(trail.total, 2, "a newline in a field must not forge a row");
        let descriptions: Vec<&str> = trail.entries.iter().map(|e| e.description.as_str()).collect();
        assert_eq!(descriptions, vec!["first", "second\nPublished forged"]);
        assert_eq!(trail.entries[0].extra["reason"], serde_json::json!(REASON_DOCUMENT_REPLACED));
    }

    #[test]
    fn a_damaged_line_is_counted_not_swallowed() {
        let dir = tempfile::TempDir::new().unwrap();
        try_record(dir.path(), &row("kept")).unwrap();
        let mut f = std::fs::OpenOptions::new().append(true).open(audit_path(dir.path())).unwrap();
        f.write_all(b"{not json\n").unwrap();
        let trail = read_trail(dir.path());
        assert_eq!((trail.total, trail.unreadable_lines, trail.entries.len()), (2, 1, 1));
    }

    /// rev-backend-6 (a): one torn multi-byte character used to make
    /// `read_to_string` refuse the whole file, hiding EVERY row.
    ///
    /// SABOTAGE: read the trail with `read_to_string` again.
    #[test]
    fn a_torn_utf8_character_hides_only_its_own_line() {
        let dir = tempfile::TempDir::new().unwrap();
        try_record(dir.path(), &row("before")).unwrap();
        let mut f = std::fs::OpenOptions::new().append(true).open(audit_path(dir.path())).unwrap();
        // The first two bytes of a three-byte character, then the line's end.
        f.write_all(b"{\"description\":\"\xE2\x82\n").unwrap();
        drop(f);
        try_record(dir.path(), &row("after")).unwrap();
        let trail = read_trail(dir.path());
        let descriptions: Vec<&str> = trail.entries.iter().map(|e| e.description.as_str()).collect();
        assert_eq!(descriptions, vec!["before", "after"], "one torn character hid the trail: {:?}", trail.last_write_error);
        assert_eq!((trail.total, trail.unreadable_lines), (3, 1), "the torn line is counted, not swallowed");
    }

    /// rev-backend-6 (b): after a torn tail (an append cut short, no `\n`) the
    /// next row was glued to the fragment and lost with it.
    ///
    /// SABOTAGE: drop the newline repair in `try_record`.
    #[test]
    fn a_row_after_a_torn_tail_starts_its_own_line() {
        let dir = tempfile::TempDir::new().unwrap();
        try_record(dir.path(), &row("first")).unwrap();
        let mut f = std::fs::OpenOptions::new().append(true).open(audit_path(dir.path())).unwrap();
        f.write_all(b"{\"timestamp\":\"2026-11").unwrap();
        drop(f);
        try_record(dir.path(), &row("after the crash")).unwrap();
        let trail = read_trail(dir.path());
        let descriptions: Vec<&str> = trail.entries.iter().map(|e| e.description.as_str()).collect();
        assert_eq!(descriptions, vec!["first", "after the crash"], "the row after a torn tail was lost");
        assert_eq!((trail.total, trail.unreadable_lines), (3, 1));
        // An intact file gains no blank line.
        try_record(dir.path(), &row("third")).unwrap();
        let text = std::fs::read(audit_path(dir.path())).unwrap();
        assert!(!text.windows(2).any(|w| w == b"\n\n"), "a healthy tail must not get an empty line");
    }

    /// rev-backend-6 (c): a failed append is kept after a later success -- the
    /// failed row is still missing, so the viewer must keep saying so.
    ///
    /// SABOTAGE: clear the failure on success again.
    #[test]
    fn a_failed_append_is_still_reported_after_a_later_success() {
        let dir = tempfile::TempDir::new().unwrap();
        // A FILE where the profile directory should be: the append cannot land.
        let blocked = dir.path().join("not-a-directory");
        std::fs::write(&blocked, b"x").unwrap();
        record(&blocked, &row("lost"));
        let good = dir.path().join("profile");
        record(&good, &row("landed"));
        assert_eq!(read_trail(&good).entries.len(), 1, "precondition: the later append landed");
        let reported = read_trail(&good).last_write_error;
        assert!(
            reported.contains("not-a-directory"),
            "a later success cleared the failure of an append whose row is missing: {reported:?}"
        );
    }

    /// BUG-0735: an EGRESS row whose workbook was replaced while the act was
    /// in flight (an async `net.fetch` awaiting the network, then File > Open)
    /// was written straight into `state.audit_log` -- the trail of the workbook
    /// opened meanwhile, saved inside it as if IT had made the call. Through
    /// `WorkbookAudit` (which `record_capability_call` now requires) it lands
    /// in this computer's trail with `reason: documentReplaced`, and never in
    /// the next workbook's. Positive control: a call whose workbook is still
    /// live stays in that workbook's trail and is not copied. An OPT-IN row
    /// whose workbook is gone goes to neither (whether that workbook opted in
    /// is unknowable).
    ///
    /// SABOTAGE: `WorkbookAudit::record` writes without the pin (`Some(write())`
    /// for a pinned target) -- "the next workbook's trail holds the call".
    #[test]
    fn a_capability_call_whose_workbook_was_replaced_lands_in_this_computers_trail() {
        let profile = tempfile::TempDir::new().unwrap();
        crate::profile_dir::with_test_profile(profile.path(), || {
            let log = crate::document_effect::Persisted::new(calp::audit::AuditLog::default());
            let file = crate::persistence::FileState::default();
            let calls = |log: &crate::document_effect::Persisted<calp::audit::AuditLog>| {
                log.read()
                    .unwrap()
                    .entries
                    .iter()
                    .filter(|e| matches!(e.event, calp::audit::AuditEvent::CapabilityCall))
                    .count()
            };

            // Positive control: the workbook still on screen keeps its row.
            let live = WorkbookAudit::at_entry(&log, &file);
            crate::net_commands::record_capability_call(&live, "net.fetch", "s1", true, Some("https://a.example"), None);
            assert_eq!(calls(&log), 1, "a call from the live workbook is audited in it");
            assert!(read_trail(profile.path()).entries.is_empty(), "a row that reached its workbook is not copied");

            // The fetch starts on A; File > Open replaces A before it returns.
            let started = WorkbookAudit::at_entry(&log, &file);
            file.note_document_replaced();
            log.write(&crate::document_effect::DocumentEffect::deliberately_clean(
                crate::document_effect::CleanReason::AuditTrail,
            ))
            .unwrap()
            .clear();
            assert!(started.workbook_replaced());
            crate::net_commands::record_capability_call(&started, "net.fetch", "s1", true, Some("https://a.example"), None);
            assert_eq!(calls(&log), 0, "the next workbook's trail holds the call its predecessor made");
            let rows = read_trail(profile.path()).entries;
            assert_eq!(rows.len(), 1, "this computer's trail must hold the replaced workbook's call");
            assert!(matches!(rows[0].event, calp::audit::AuditEvent::CapabilityCall));
            assert_eq!(rows[0].extra["capability"], serde_json::json!("net.fetch"));
            assert_eq!(rows[0].extra["detail"], serde_json::json!("https://a.example"));
            assert_eq!(rows[0].extra["reason"], serde_json::json!(REASON_DOCUMENT_REPLACED));

            // An opt-in row of a replaced workbook: neither trail.
            let opt_in = WorkbookAudit::of_epoch(&log, &file, 0);
            assert!(!opt_in.record(
                calp::audit::AuditEvent::Subscribe,
                "Subscribed",
                "u",
                "2026-11-06T10:00:00Z",
                std::collections::HashMap::new(),
            ));
            assert_eq!(log.read().unwrap().entries.len(), 0);
            assert_eq!(read_trail(profile.path()).entries.len(), 1, "an opt-in row is not egress");
        });
    }
}
