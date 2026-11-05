//! FILENAME: app/src-tauri/src/machine_audit.rs
//! PURPOSE: The MACHINE-scoped, append-only trail of collaboration audit rows
//!          that belong to NO open workbook -- today: a push (or a model-only
//!          publish) that LANDED in the workspace after File > Open / New had
//!          replaced the workbook that made it (BUG-0653).
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
}
