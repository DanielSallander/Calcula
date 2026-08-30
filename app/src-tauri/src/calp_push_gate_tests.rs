//! FILENAME: app/src-tauri/src/calp_push_gate_tests.rs
//! PURPOSE: The push gates that need WORKBOOK state — the ones core `publish()`
//! cannot run because it cannot see the open document.
//! CONTEXT: Registry-fact gates (mode, base version, monotonic version, key
//! continuity) live in core and are tested there, under the registry lock, in
//! `core/calp/tests/workspace_lifecycle.rs`. What is tested here is the layer
//! above: is this workbook a working copy of the package it is pushing to, is
//! it instead a SUBSCRIBER of it (the identity trap), and does an update say
//! what it changed and what it was based on.

use crate::calp_commands::{parse_push_mode, PublishParams};

fn params(mode: Option<&str>, base: Option<&str>, summary: &str) -> PublishParams {
    PublishParams {
        registry_path: r"\\server\registry".to_string(),
        package_name: "sales".to_string(),
        version: "1.1.0".to_string(),
        kind: "report".to_string(),
        sheet_indices: vec![0],
        published_by: String::new(),
        custom_objects: None,
        include_comments: false,
        mode: mode.map(|m| m.to_string()),
        expected_base_version: base.map(|b| b.to_string()),
        change_summary: summary.to_string(),
    }
}

#[test]
fn an_absent_mode_creates_rather_than_guessing_an_update() {
    // The default has to be the one that CANNOT silently overwrite somebody
    // else's version. A default of "update" would need a base version, and the
    // only base available without being told is "whatever the registry says
    // right now" — which is exactly the lost update the gate exists to prevent.
    let mode = parse_push_mode(&params(None, None, "")).expect("defaults to create");
    assert_eq!(mode, calp::PushMode::CreateNew);
}

#[test]
fn an_update_without_a_base_version_is_refused_rather_than_defaulted() {
    let err = parse_push_mode(&params(Some("update"), None, "a change"))
        .expect_err("an update with no base must not be constructible");
    assert!(
        err.contains("CALP_PUSH_NO_BASE"),
        "the refusal must be branchable by the dialog, got: {err}"
    );
}

#[test]
fn an_update_carries_the_base_it_was_told() {
    let mode = parse_push_mode(&params(Some("update"), Some("1.2.0"), "a change"))
        .expect("a well-formed update");
    assert_eq!(
        mode,
        calp::PushMode::Update { expected_base: calp::SemVer::new(1, 2, 0) }
    );
}

#[test]
fn a_blank_base_version_counts_as_absent() {
    // An empty string is what an unfilled form field sends. Treating it as a
    // version would produce a parse error about "" rather than the sentence
    // that tells the user what to do.
    let err = parse_push_mode(&params(Some("update"), Some("   "), "a change"))
        .expect_err("blank is not a version");
    assert!(err.contains("CALP_PUSH_NO_BASE"), "got: {err}");
}

#[test]
fn an_unknown_mode_is_refused_rather_than_falling_through_to_create() {
    let err = parse_push_mode(&params(Some("push"), Some("1.2.0"), "a change"))
        .expect_err("an unrecognised mode must not be silently reinterpreted");
    assert!(err.contains("push"), "the refusal should name what was sent: {err}");
}

#[test]
fn a_malformed_base_version_is_refused() {
    let err = parse_push_mode(&params(Some("update"), Some("not-a-version"), "a change"))
        .expect_err("a base that is not a version must be refused");
    assert!(!err.is_empty());
}

// ---------------------------------------------------------------------------
// The workspace link's own gate logic
// ---------------------------------------------------------------------------

#[test]
fn a_link_targets_the_same_share_however_the_user_spelled_it() {
    let link = calp::WorkspaceLink::new(
        r"\\server\reports",
        "sales",
        "report",
        "1.0.0",
        "2026-08-29T00:00:00Z",
        Vec::new(),
    );
    // The same share reached two ways is the same share; refusing a push over a
    // trailing backslash would be a gate refusing for a reason that is not the
    // reason the gate exists.
    assert!(link.targets(r"\\server\reports\", "sales"));
    assert!(link.targets(r"\\SERVER\Reports", "sales"));
    // But a DIFFERENT package is a different package, case included: registry
    // package directories are case-sensitive and so is the TOFU pin lookup.
    assert!(!link.targets(r"\\server\reports", "Sales"));
    assert!(!link.targets(r"\\other\share", "sales"));
}

#[test]
fn recording_a_push_moves_the_base_so_the_next_push_is_measured_from_it() {
    let mut link = calp::WorkspaceLink::new(
        r"\\server\reports",
        "sales",
        "report",
        "1.0.0",
        "2026-08-29T00:00:00Z",
        Vec::new(),
    );
    link.record_push("1.1.0", "2026-08-29T10:00:00Z", Vec::new());
    assert_eq!(
        link.base_version, "1.1.0",
        "after a push, the version just published IS the base — otherwise the \
         author's very next push reports itself as stale against their own work"
    );
    assert_eq!(link.last_pushed_version, "1.1.0");
}
