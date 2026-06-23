//! FILENAME: core/calp/src/audit.rs
//! PURPOSE: Opt-in audit log for subscription events in .cala workbooks.
//! CONTEXT: Records subscription events, refreshes, override creation/deletion.
//! Policy is set per registry: a registry may require audit logging for
//! packages it serves. Off by default.

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
    /// Subscribed to a new package.
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
    /// Published a package version.
    Published,
    /// Changed active channel.
    ChannelChanged,
    /// Submitted writeback values to the registry.
    WritebackSubmitted,
    /// Writeback drafts invalidated by refresh (removed/incompatible regions).
    WritebackInvalidated,
    /// Publisher approved or rejected a submitted writeback value.
    WritebackReviewed,
}

impl AuditLog {
    pub fn new() -> Self {
        Self {
            format_version: 1,
            enabled: false,
            max_entries: 0,
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

    /// Record an event. No-op if logging is disabled.
    pub fn record(&mut self, event: AuditEvent, description: &str, user: &str, now: &str) {
        if !self.enabled {
            return;
        }

        self.entries.push(AuditEntry {
            timestamp: now.to_string(),
            event,
            description: description.to_string(),
            user: user.to_string(),
            extra: HashMap::new(),
        });

        // Trim to max_entries if set
        if self.max_entries > 0 && self.entries.len() > self.max_entries {
            let excess = self.entries.len() - self.max_entries;
            self.entries.drain(..excess);
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
}
