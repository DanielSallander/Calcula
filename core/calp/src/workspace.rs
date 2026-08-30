//! FILENAME: core/calp/src/workspace.rs
//! PURPOSE: The workspace link — a `.cala`'s record of the package it is a
//! working copy of.
//! CONTEXT: `.calp` had provenance in one direction only. A subscriber's
//! `Subscription` records where its sheets came from; nothing recorded where a
//! publisher's sheets were going, so the author's own workbook could not answer
//! "which package is this, and which version am I working from" — which is the
//! question every push gate needs answered.

use std::collections::HashMap;

use identity::SheetId;
use serde::{Deserialize, Serialize};

/// A workbook's link to the package it is a working copy of.
///
/// Written at checkout, and at the first publish of a standalone workbook (so
/// creating a package also makes the workbook its working copy). Persisted in
/// the `.cala` beside the subscription manifest and the override layer.
///
/// A workbook holds at most ONE of these. A `.cala` is a working copy of one
/// package; it may separately SUBSCRIBE to others, but it may never be both a
/// working copy and a subscriber of the same package — see
/// `docs/design/calp-workspace-collaboration.md` §2.3.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceLink {
    pub format_version: u32,
    /// The registry location in the USER'S spelling — the same string that was
    /// handed to `open_registry_scoped`, so re-opening resolves to the same
    /// pin scope. (`Subscription::registry_url` carries the same convention.)
    pub registry_url: String,
    pub package_name: String,
    /// The package kind at link time ("report", "dataset", …). Advisory: it
    /// prefills the push dialog rather than gating anything.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kind: String,
    /// The version this working copy was checked out from, or last pushed /
    /// merged to. This is the base the next push declares, and the value the
    /// base-version gate compares against the registry head.
    pub base_version: String,
    pub checked_out_at: String,
    /// The last version pushed FROM this working copy; empty until it pushes.
    /// Kept beside `base_version` (which it usually equals after a push)
    /// because they diverge the moment a checkout is made from an older
    /// version, and the status UI wants to say so.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub last_pushed_version: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub last_pushed_at: String,
    /// The sheets the base version contained. The push dialog defaults its
    /// sheet selection to these, so a push does not silently drop a sheet the
    /// package had merely because the author did not re-tick it — and it does
    /// so OFFLINE, without a registry round trip.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub base_sheets: Vec<WorkspaceSheetRef>,
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

/// One sheet of the base version: its package sheet id and the name it had.
///
/// There is deliberately no local-id field. Checkout preserves package sheet
/// ids, so in a working copy the package id and the local id are the same
/// value — recording a mapping would be recording that they are equal, and a
/// second copy of a fact is a second place for it to go wrong.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSheetRef {
    pub sheet_id: SheetId,
    pub name: String,
}

impl WorkspaceLink {
    /// A link for a working copy freshly checked out at `version`.
    pub fn new(
        registry_url: &str,
        package_name: &str,
        kind: &str,
        version: &str,
        now: &str,
        base_sheets: Vec<WorkspaceSheetRef>,
    ) -> Self {
        Self {
            format_version: 1,
            registry_url: registry_url.to_string(),
            package_name: package_name.to_string(),
            kind: kind.to_string(),
            base_version: version.to_string(),
            checked_out_at: now.to_string(),
            last_pushed_version: String::new(),
            last_pushed_at: String::new(),
            base_sheets,
            extra: HashMap::new(),
        }
    }

    /// Whether this link targets the given package in the given registry.
    ///
    /// The registry comparison is on the user's spelling, case-insensitively
    /// and ignoring a trailing separator, because the same share reached as
    /// `\\srv\reports` and `\\srv\reports\` is the same share. Callers that
    /// need registry IDENTITY rather than a UI convenience should compare
    /// `RegistryScope::id`s instead — this is the prefill/gate check, and it
    /// errs toward "yes, that's your package" so the gate's refusal text is
    /// about the real problem rather than a trailing backslash.
    pub fn targets(&self, registry_url: &str, package_name: &str) -> bool {
        fn norm(s: &str) -> String {
            s.trim().trim_end_matches(['/', '\\']).to_lowercase()
        }
        self.package_name == package_name && norm(&self.registry_url) == norm(registry_url)
    }

    /// Record a successful push: the pushed version becomes the new base.
    pub fn record_push(&mut self, version: &str, now: &str, sheets: Vec<WorkspaceSheetRef>) {
        self.base_version = version.to_string();
        self.last_pushed_version = version.to_string();
        self.last_pushed_at = now.to_string();
        self.base_sheets = sheets;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link() -> WorkspaceLink {
        WorkspaceLink::new(
            r"\\server\reports",
            "sales",
            "report",
            "1.2.0",
            "2026-08-29T00:00:00Z",
            Vec::new(),
        )
    }

    #[test]
    fn targets_ignores_trailing_separator_and_case() {
        let l = link();
        assert!(l.targets(r"\\server\reports", "sales"));
        assert!(l.targets(r"\\server\reports\", "sales"));
        assert!(l.targets(r"\\SERVER\Reports", "sales"));
        assert!(!l.targets(r"\\server\other", "sales"));
        // The package name is NOT case-folded: registries are case-sensitive
        // directories and the pin store's exact `get` is too.
        assert!(!l.targets(r"\\server\reports", "Sales"));
    }

    #[test]
    fn record_push_advances_the_base() {
        let mut l = link();
        assert_eq!(l.last_pushed_version, "");
        l.record_push("1.3.0", "2026-08-30T00:00:00Z", Vec::new());
        assert_eq!(l.base_version, "1.3.0");
        assert_eq!(l.last_pushed_version, "1.3.0");
        assert_eq!(l.last_pushed_at, "2026-08-30T00:00:00Z");
    }

    #[test]
    fn round_trips_through_json_with_camel_case_keys() {
        let mut l = link();
        l.base_sheets = vec![WorkspaceSheetRef {
            sheet_id: SheetId::from_bytes(identity::generate_uuid_v7()),
            name: "Dashboard".to_string(),
        }];
        let json = serde_json::to_string(&l).unwrap();
        assert!(json.contains("\"baseVersion\""), "camelCase over the wire: {json}");
        assert!(json.contains("\"baseSheets\""));
        // Empty optional strings are omitted rather than written as "".
        assert!(!json.contains("lastPushedVersion"));
        let back: WorkspaceLink = serde_json::from_str(&json).unwrap();
        assert_eq!(back, l);
    }
}
