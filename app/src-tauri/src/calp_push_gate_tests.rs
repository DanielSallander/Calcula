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
    let link = calp::WorkingCopyLink::new(
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
    let mut link = calp::WorkingCopyLink::new(
        r"\\server\reports",
        "sales",
        "report",
        "1.0.0",
        "2026-08-29T00:00:00Z",
        Vec::new(),
    );
    link.record_push("1.1.0", "2026-08-29T10:00:00Z", Vec::new(), Vec::new(), Vec::new(), Vec::new());
    assert_eq!(
        link.base_version, "1.1.0",
        "after a push, the version just published IS the base — otherwise the \
         author's very next push reports itself as stale against their own work"
    );
    assert_eq!(link.last_pushed_version, "1.1.0");
}

// ---------------------------------------------------------------------------
// BUG-0150: the push preview sees the frontend's distributable objects
// ---------------------------------------------------------------------------

fn overlay() -> crate::calp_commands::FrontendCustomObject {
    crate::calp_commands::FrontendCustomObject {
        kind: "calcula.modelOverlay".to_string(),
        id: "overlay-1".to_string(),
        name: "Workbook measures".to_string(),
        sheet_id: None,
        payload: serde_json::json!({ "measures": ["Margin"] }),
    }
}

/// Publish a one-sheet workbook with `custom_objects` into `reg` as `version`,
/// stamped the way `calp_publish` stamps it.
fn publish_with(
    reg: &calp::MemoryWorkspace,
    wb: &persistence::Workbook,
    version: calp::SemVer,
    custom_objects: Vec<calp::publish::PublishCustomObject>,
    prof: &std::path::Path,
) -> calp::manifest::VersionManifest {
    let mut request = calp::publish::PublishRequest {
        workbook: wb,
        package_name: "sales".to_string(),
        version: version.clone(),
        kind: "report".to_string(),
        mode: calp::PushMode::CreateNew,
        change_summary: String::new(),
        sheet_indices: vec![0],
        now: "2026-09-28T00:00:00Z".to_string(),
        published_by: "author".to_string(),
        writeback_regions: None,
        model_writebacks: None,
        object_scripts: None,
        module_scripts: None,
        notebooks: None,
        data_sources: Vec::new(),
        excluded_regions: Vec::new(),
        custom_objects,
        include_comments: false,
        min_app_version: String::new(),
    };
    crate::calp_commands::stamp_min_app_version(&mut request);
    calp::publish::publish(reg, &request, prof).expect("publish");
    calp::WorkspaceTransport::get_version_manifest(reg, "sales", &version.to_string()).unwrap()
}

/// The preview's working side, built the way `publish_into_for_preview` builds
/// it, diffed against a base that carries the frontend's overlay.
fn preview_against_overlay_base(
    frontend: Option<Vec<crate::calp_commands::FrontendCustomObject>>,
) -> calp::diff::VersionDiff {
    let prof = tempfile::TempDir::new().unwrap();
    let mut wb = persistence::Workbook::default();
    wb.sheets = vec![persistence::Sheet::new("Sheet1".to_string())];
    let base_reg = calp::MemoryWorkspace::new();
    // The base as a real push wrote it: carrying the overlay. Built directly,
    // not through the helper under test.
    let base = publish_with(
        &base_reg,
        &wb,
        calp::SemVer::new(1, 0, 0),
        vec![overlay().into()],
        prof.path(),
    );
    let supplied = frontend.is_some();
    let working_reg = calp::MemoryWorkspace::new();
    let working = publish_with(
        &working_reg,
        &wb,
        calp::SemVer::new(0, 0, 0),
        crate::calp_commands::merge_publish_custom_objects(Vec::new(), frontend),
        prof.path(),
    );
    let base_artifacts = base_reg.artifacts_of("sales", "1.0.0");
    let working_artifacts = working_reg.artifacts_of("sales", "0.0.0");
    let mut diff = calp::diff::diff_sides(
        &calp::diff::DiffSide::InMemory { manifest: &base, artifacts: &base_artifacts },
        &calp::diff::DiffSide::InMemory { manifest: &working, artifacts: &working_artifacts },
        &calp::diff::DiffOptions::default(),
    )
    .expect("diff");
    // What both preview commands do (pinned by the wiring test below).
    if !supplied {
        crate::calp_commands::reconcile_unknowable_min_app_version(&mut diff, &base, &working);
    }
    diff
}

/// BUG-0150. Handed the frontend's objects, the preview's working side carries
/// the overlay the push would carry, and the diff names no change -- where the
/// preview that could not see them reported it REMOVED.
///
/// SABOTAGE: drop the frontend half of `merge_publish_custom_objects`.
#[test]
fn a_preview_handed_the_frontends_objects_reports_no_removal() {
    let diff = preview_against_overlay_base(Some(vec![overlay()]));
    assert!(
        diff.objects.iter().all(|o| o.domain != "customObject"),
        "the overlay the push would carry is reported as a change: {:?}",
        diff.objects
    );
    assert!(diff.manifest_changes.is_empty(), "no manifest change either: {:?}", diff.manifest_changes);

    // The mechanism, for contrast: a preview that CANNOT see them reports the
    // overlay removed (the reconcile only hides the version-stamp line).
    let blind = preview_against_overlay_base(None);
    assert!(
        blind.objects.iter().any(|o| o.domain == "customObject" && o.change == "removed"),
        "precondition: without the objects the overlay reads as removed: {:?}",
        blind.objects
    );
}

/// A preview that WAS handed the frontend's objects saw everything the push
/// carries, so a base stamped for an overlay the author really removed is a
/// real `minAppVersion` change and stays in the diff. Only a preview that could
/// not see them has that line reconciled away.
///
/// SABOTAGE: reconcile regardless of `frontend_objects_supplied`.
#[test]
fn a_really_removed_overlays_version_stamp_change_is_kept_when_the_preview_saw_everything() {
    let diff = preview_against_overlay_base(Some(Vec::new()));
    assert!(
        diff.manifest_changes.iter().any(|c| c.field == "minAppVersion"),
        "the author removed the only thing that stamped the version; the preview \
         saw every object and must say so: {:?}",
        diff.manifest_changes
    );
    let blind = preview_against_overlay_base(None);
    assert!(
        !blind.manifest_changes.iter().any(|c| c.field == "minAppVersion"),
        "a preview that could not see the objects cannot know that line is real"
    );
}

/// THE WIRING the tests above cannot see: both preview commands forward the
/// caller's objects into the one preview publish, which merges them through
/// `merge_publish_custom_objects`.
#[test]
fn both_preview_commands_forward_the_frontends_objects() {
    let read = |rel: &str| -> String {
        std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(rel))
            .unwrap()
            .lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let diff_rs = read("src/calp_diff.rs");
    let merge_rs = read("src/calp_merge.rs");
    let cmds = read("src/calp_commands.rs");
    let call = &diff_rs[diff_rs.find("publish_into_for_preview(").expect("the diff's preview publish")..];
    let call = &call[..call.find(")?;").unwrap()];
    assert!(call.contains("params.custom_objects,"), "calp_diff_working_copy does not forward customObjects");
    assert_eq!(
        merge_rs.matches("params.unwrap_or_default().custom_objects,").count(),
        2,
        "the merge analysis AND the merge apply must both forward customObjects"
    );
    for (name, src) in [("calp_diff.rs", &diff_rs), ("calp_merge.rs", &merge_rs)] {
        let at = src
            .find("reconcile_unknowable_min_app_version(")
            .unwrap_or_else(|| panic!("{name} no longer reconciles the stamp"));
        let guard = src[..at].rfind("if !frontend_objects_supplied {");
        assert!(
            guard.is_some_and(|g| at - g < 120),
            "{name} reconciles the stamp even when it was handed the frontend's objects"
        );
    }
    let preview = &cmds[cmds.find("pub(crate) fn publish_into_for_preview(").unwrap()..];
    let preview = &preview[..preview.find("\n}\n").unwrap()];
    assert!(
        preview.contains("merge_publish_custom_objects(") && preview.contains("frontend_custom_objects,"),
        "the preview publish does not merge the frontend's objects"
    );
}

/// BUG-0151's push half, wired: the one publish assembly undoes a working
/// copy's collision renames in the references it ships (the tab names are
/// restored just above it), and a merge brings the head's cells in under the
/// working copy's local names. Both functions are unit-tested in
/// calp_materialize_tests.rs; this pins that the paths that need them call them.
#[test]
fn the_push_assembly_and_the_merge_follow_a_working_copys_collision_renames() {
    let read = |rel: &str| -> String {
        std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(rel))
            .unwrap()
            .lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let cmds = read("src/calp_commands.rs");
    let assembly = &cmds[cmds.find("fn assemble_publish_workbook(").unwrap()..];
    let assembly = &assembly[..assembly.find("\n}\n").unwrap()];
    let restored_names = assembly.find("sheet.name = published.clone();").expect("the tab-name restore moved");
    let restored_refs = assembly
        .find("restore_published_sheet_references(&mut workbook, sheet_indices, &renamed_for_publish);")
        .expect("the push no longer restores the references a checkout rewrote");
    assert!(restored_names < restored_refs, "references are restored with the names they follow");
    // BOTH doors that lay a PUBLISHED version's cells into the live working
    // copy -- the merge (the head's) and the push dialog's hold-back (the
    // base's) -- read them through the one function that renames, handed the
    // working copy's own renames. The hold-back was the door the first round
    // missed: it put `DATA!A1*2` back over a working copy whose "Data" is the
    // application's "Data (2)".
    let merge = read("src/calp_merge.rs");
    let overlay = &merge[merge.find("fn overlay_their_cells(").expect("the merge overlay moved")..];
    // The last function of its file: the joined text has no newline after its `}`.
    let overlay = &overlay[..overlay.find("\n}").unwrap_or(overlay.len())];
    let hold_back = &cmds[cmds.find("pub fn calp_hold_back_cells(").expect("the hold-back moved")..];
    let hold_back = &hold_back[..hold_back.find("\n}\n").unwrap()];
    for (door, body) in [("the merge", overlay), ("the hold-back", hold_back)] {
        let renames = body
            .find("working_copy_sheet_renames(")
            .unwrap_or_else(|| panic!("{door} no longer resolves the working copy's renames"));
        let read_cells = body
            .find("published_cells_in_local_names(")
            .unwrap_or_else(|| panic!("{door} reads published cells without renaming them"));
        assert!(renames < read_cells, "{door}: the renames are resolved before the read");
        let call = &body[read_cells..];
        let call = &call[..call.find(")?").unwrap()];
        assert!(call.contains("&renames,"), "{door} hands the read the working copy's renames");
        assert!(
            !body.contains("sheet_data_to_cells("),
            "{door} reads a published sheet's cells by hand again -- unrenamed"
        );
    }
    // A SUBSCRIBER's reset rebuilds from a re-pull, and its diff compares in the
    // published spelling -- the same renames, the other two doors.
    let reset = &cmds[cmds.find("pub fn calp_reset_subscription(").unwrap()..];
    let reset = &reset[..reset.find("\n}\n").unwrap()];
    let pulled = reset.find("calp::pull::pull(").expect("the reset re-pulls");
    let renamed = reset
        .find("rename_pulled_references_for_reset(&state, &subscription, &mut result)?;")
        .expect("the reset no longer renames the re-pulled references");
    let materialized = reset.find(".to_grid()").expect("the reset rebuilds grids");
    assert!(pulled < renamed && renamed < materialized, "renamed after the pull, before the grids");
    let diff = read("src/calp_diff.rs");
    assert!(
        diff.contains("subscriber_published_names(") && diff.contains("&published_names,"),
        "the subscriber diff no longer compares renamed references in the published spelling"
    );
}
