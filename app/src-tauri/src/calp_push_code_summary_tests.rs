//! FILENAME: app/src-tauri/src/calp_push_code_summary_tests.rs
//! PURPOSE: The PUSH preview carries the code summary (owner question 14): the
//! code this push changes against its signed base, and what each change means
//! for everyone on the development line -- the Promote dialog's summary
//! (`calp::code_summary`), not a second one.
//! CONTEXT: A push is where a developer decides what code goes out under their
//! key, and until now the push dialog showed the code only inside the cell diff
//! (a changed macro among the edits). `calp_diff_working_copy` already reads the
//! signed base through the verified reader and runs the REAL publish into
//! memory, so the summary compares those two sides: the base as
//! `DiffSide::PublishedChecked` (every code artifact held to its signed
//! checksum when it is read) and the push as `DiffSide::InMemory`.
//!
//! The command needs eight `State` handles and a window, so the comparison is
//! `calp_diff::push_code_summary`, exercised here against a real signed
//! workspace and a real in-memory publish; the command's arrangement is pinned
//! by a source guard at the end. Every test names the sabotage that turns it red.

use std::collections::BTreeMap;

use calp::code_summary::{CodeChangeKind, CodeKind, SubscriberConsequence};
use calp::publish::{self, PublishRequest, PushMode};
use calp::transport::WorkspaceTransport;
use calp::version::SemVer;
use calp::workspace::LocalWorkspace;
use calp::VersionManifest;
use tempfile::TempDir;

use crate::calp_signer_trust_tests::{location, workbook, PKG};

/// `wb` with exactly these module scripts: `(id, name, source)`.
fn with_macros(wb: &persistence::Workbook, macros: &[(&str, &str, &str)]) -> persistence::Workbook {
    let mut wb = wb.clone();
    wb.scripts = macros
        .iter()
        .map(|(id, name, source)| persistence::SavedScript {
            id: id.to_string(),
            name: name.to_string(),
            description: None,
            source: source.to_string(),
            scope: persistence::SavedScriptScope::default(),
            source_package: None,
        })
        .collect();
    wb
}

fn request(wb: &persistence::Workbook, version: SemVer, mode: PushMode) -> PublishRequest<'_> {
    PublishRequest {
        workbook: wb,
        package_name: PKG.to_string(),
        version,
        kind: "report".to_string(),
        mode,
        change_summary: "a change".to_string(),
        sheet_indices: vec![0],
        now: "2026-10-02T00:00:00Z".to_string(),
        published_by: "author".to_string(),
        writeback_regions: None,
        model_writebacks: None,
        object_scripts: None,
        module_scripts: None,
        notebooks: None,
        data_sources: Vec::new(),
        excluded_regions: Vec::new(),
        custom_objects: Vec::new(),
        include_comments: false,
        min_app_version: String::new(),
    }
}

/// Alice publishes the BASE, 1.0.0, carrying the macro `mod-report`
/// (`return 1;`). Returns (workspace dir, alice's profile, the base workbook).
fn base() -> (TempDir, TempDir, persistence::Workbook) {
    let dir = TempDir::new().unwrap();
    let alice = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    let wb = with_macros(&workbook("v1"), &[("mod-report", "Report", "return 1;")]);
    publish::publish(&reg, &request(&wb, SemVer::new(1, 0, 0), PushMode::CreateNew), alice.path())
        .expect("the base publish failed");
    (dir, alice, wb)
}

/// What the push would publish: `wb` through the real publish into memory, the
/// way `publish_into_for_preview` builds the preview's working side (a fresh
/// in-memory workspace, `CreateNew`, version 0.0.0).
fn working(wb: &persistence::Workbook, profile: &std::path::Path) -> (VersionManifest, BTreeMap<String, Vec<u8>>) {
    let memory = calp::MemoryWorkspace::new();
    publish::publish(&memory, &request(wb, SemVer::new(0, 0, 0), PushMode::CreateNew), profile)
        .expect("the in-memory publish failed");
    let manifest = memory.get_version_manifest(PKG, "0.0.0").unwrap();
    let artifacts = memory.artifacts_of(PKG, "0.0.0");
    (manifest, artifacts)
}

/// The base exactly as the command opens it: the VERIFIED reader, every
/// artifact walked.
fn open_base(dir: &TempDir) -> (Box<dyn WorkspaceTransport>, String, VersionManifest) {
    crate::calp_inspector::open_verified_content(&location(dir), PKG, "=1.0.0", true).expect("the base reads")
}

fn summary(
    base: &(Box<dyn WorkspaceTransport>, String, VersionManifest),
    working: &(VersionManifest, BTreeMap<String, Vec<u8>>),
) -> crate::calp_diff::WorkingCopyCode {
    let (registry, version, manifest) = base;
    crate::calp_diff::push_code_summary(registry.as_ref(), PKG, version, manifest, &working.0, &working.1)
}

// ---------------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------------

/// The push changes `mod-report` and adds `mod-extra`: both are listed, with the
/// code before and after and what each means for the development line, and the
/// headline flag says everyone there is asked again.
///
/// SABOTAGE: have `push_code_summary` answer an empty `WorkingCopyCode`.
#[test]
fn the_push_preview_lists_the_code_this_push_changes() {
    let (dir, alice, wb) = base();
    let pushed = with_macros(&wb, &[("mod-report", "Report", "return 2;"), ("mod-extra", "Extra", "return 3;")]);
    let code = summary(&open_base(&dir), &working(&pushed, alice.path()));

    assert_eq!(code.code_error, None);
    let report = code
        .code_changes
        .iter()
        .find(|c| c.id == "mod-report")
        .unwrap_or_else(|| panic!("the changed macro is not listed: {:?}", code.code_changes));
    assert_eq!(report.kind, CodeKind::Macro);
    assert_eq!(report.change, CodeChangeKind::Modified);
    assert_eq!(report.consequence, SubscriberConsequence::AsksApprovalAgain);
    assert_eq!(report.before.as_deref(), Some("return 1;"), "the BEFORE side is the signed base");
    assert_eq!(report.after.as_deref(), Some("return 2;"), "the AFTER side is what this push publishes");

    let extra = code
        .code_changes
        .iter()
        .find(|c| c.id == "mod-extra")
        .unwrap_or_else(|| panic!("the new macro is not listed: {:?}", code.code_changes));
    assert_eq!(extra.change, CodeChangeKind::Added);
    assert_eq!(extra.consequence, SubscriberConsequence::AsksApprovalAgain);
    assert!(extra.before.is_none());
    assert!(code.asks_approval_again);

    // The wire: camelCase, the same three fields the promotion's impact carries
    // (one TypeScript reader reads both), and `codeError` present as null.
    let wire = serde_json::to_value(&code).unwrap();
    assert!(wire.get("codeError").is_some_and(|v| v.is_null()), "{wire}");
    assert!(wire.get("codeChanges").is_some_and(|v| v.is_array()), "{wire}");
    assert!(wire.get("asksApprovalAgain").is_some_and(|v| v.as_bool() == Some(true)), "{wire}");
}

/// A push whose code is the base's lists no code, and asks nobody again --
/// even though it changes cells. The base is a real FROM side, never "nothing
/// was published before" (which would list `mod-report` as new).
///
/// SABOTAGE: pass `None` as the FROM side of `code_summary` in
/// `push_code_summary`.
#[test]
fn a_push_that_changes_no_code_lists_none() {
    let (dir, alice, wb) = base();
    let mut pushed = wb.clone();
    pushed.sheets[0]
        .cells
        .insert((1, 0), persistence::SavedCell::from_cell(&engine::cell::Cell::new_text("edited".to_string())));
    let code = summary(&open_base(&dir), &working(&pushed, alice.path()));

    assert_eq!(code.code_error, None);
    assert!(code.code_changes.is_empty(), "unchanged code was listed: {:?}", code.code_changes);
    assert!(!code.asks_approval_again);
}

/// THE BASE IS HELD TO ITS SIGNATURE WHEN THE SUMMARY READS IT. The command
/// verifies the base, then spends a full publish before the summary reads the
/// base's code; a module rewritten on the share in between must not become the
/// BEFORE side of a row (or vanish from it). It is a named failure -- never a
/// list, and never "no code changes".
///
/// SABOTAGE: read the base as `DiffSide::Published` (unchecked) in
/// `push_code_summary`; or swallow the error into an empty `code_changes` with
/// no `code_error`.
#[test]
fn the_push_preview_holds_the_base_code_to_its_signature() {
    let (dir, alice, wb) = base();
    let pushed = with_macros(&wb, &[("mod-report", "Report", "return 2;")]);
    let opened = open_base(&dir);

    // Positive control: untouched, the change is listed.
    let clean = summary(&opened, &working(&pushed, alice.path()));
    assert_eq!(clean.code_error, None);
    assert!(clean.code_changes.iter().any(|c| c.id == "mod-report"), "{:?}", clean.code_changes);

    // Someone who can write to the share rewrites the base's macro AFTER the
    // command verified it: a loose file in the version folder, which the
    // workspace serves ahead of the content-addressed blob.
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    let rel = "modules/mod-report.json";
    let original = reg
        .read_artifact(PKG, "1.0.0", rel)
        .unwrap()
        .unwrap_or_else(|| panic!("the fixture's base carries no `{rel}` for this test to rewrite"));
    let mut def: serde_json::Value = serde_json::from_slice(&original).unwrap();
    def["source"] = serde_json::Value::String("return 2;".to_string());
    let module = reg.version_dir(PKG, "1.0.0").unwrap().join("modules").join("mod-report.json");
    std::fs::create_dir_all(module.parent().unwrap()).unwrap();
    std::fs::write(&module, serde_json::to_vec(&def).unwrap()).unwrap();
    assert_ne!(
        reg.read_artifact(PKG, "1.0.0", rel).unwrap().as_deref(),
        Some(original.as_slice()),
        "the rewrite did not change what the workspace serves, so this test would prove nothing"
    );

    let code = summary(&opened, &working(&pushed, alice.path()));
    assert!(
        code.code_changes.is_empty(),
        "code was compared against a base nobody signed: {:?}",
        code.code_changes
    );
    assert!(!code.asks_approval_again);
    let error = code.code_error.expect("the failure is named, not swallowed into 'no code changes'");
    assert!(error.contains("does not match its published checksum"), "{error}");
    assert!(error.contains("v1.0.0"), "the failure names the base: {error}");
}

// ---------------------------------------------------------------------------
// The command's arrangement
// ---------------------------------------------------------------------------

fn body_of(src: &str, signature: &str) -> String {
    let start = src
        .find(signature)
        .unwrap_or_else(|| panic!("signature not found: {}", signature));
    let rest = &src[start..];
    let end = rest.find("\n}\n").unwrap_or(rest.len());
    rest[..end]
        .lines()
        .map(|line| match line.find("//") {
            Some(i) => line[..i].to_string(),
            None => line.to_string(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

const DIFF_SRC: &str = include_str!("calp_diff.rs");

fn at(hay: &str, needle: &str, what: &str) -> usize {
    hay.find(needle)
        .unwrap_or_else(|| panic!("{} is gone (looked for `{}`)", what, needle))
}

/// `calp_diff_working_copy` compares the code only when asked (the push dialog
/// asks; the subscriber's diff does not), and compares the base it read through
/// the VERIFIED reader with the push it published into memory -- the same two
/// sides as the cell diff, so the two halves of the preview cannot describe
/// different pushes. The summary itself is core's, judged against the list the
/// subscriber's admission uses, exactly as the promotion's is.
///
/// SABOTAGE (each alone): drop or invert the `params.code_summary` condition;
/// pass a different manifest than `&base_manifest`; answer `code: None`; read
/// the base in `push_code_summary` as `DiffSide::Published`; judge button cells
/// against an empty list.
#[test]
fn the_working_copy_diff_compares_the_verified_base_with_the_push_when_asked() {
    let command = body_of(DIFF_SRC, "pub fn calp_diff_working_copy(");
    let verified = at(&command, "crate::calp_inspector::open_verified_content(", "the base's verified read");
    let published = at(&command, "publish_into_for_preview(", "the in-memory publish");
    let asked = at(&command, "let code = if params.code_summary {", "the opt-in");
    let call = at(&command, "push_code_summary(", "the code summary");
    assert!(verified < call && published < call, "the code is compared before both sides exist");
    assert!(asked < call, "the code is compared whether or not the caller asked");
    let args = &command[call..];
    let args = &args[..args.find("} else").unwrap_or(args.len())];
    for needle in ["base_registry.as_ref()", "&base_version", "&base_manifest", "&working_manifest", "&artifacts"] {
        assert!(args.contains(needle), "push_code_summary is not handed `{needle}`: {args}");
    }
    assert!(command.contains("\n        code,\n"), "the answer does not carry the code summary");
    assert!(
        !command.contains("open_authorized_content("),
        "the base is read through the verified reader (owner question 14)"
    );

    let summary = body_of(DIFF_SRC, "pub(crate) fn push_code_summary(");
    assert!(summary.contains("DiffSide::PublishedChecked {"), "the base's code is not held to its signed checksums");
    assert!(!summary.contains("DiffSide::Published {"), "the base's code is read unchecked");
    assert!(summary.contains("DiffSide::InMemory {"), "the push side is not the in-memory publish");
    assert!(summary.contains("calp::code_summary::code_summary("), "the summary is not core's");
    assert!(
        summary.contains("crate::button_cells::DISTRIBUTABLE_BUTTON_COMMANDS"),
        "button cells are not judged against the list the subscriber's admission uses"
    );
}
