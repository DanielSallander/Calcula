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
        sheet_ids: None,
        published_by: String::new(),
        custom_objects: None,
        include_comments: false,
        mode: mode.map(|m| m.to_string()),
        expected_base_version: base.map(|b| b.to_string()),
        change_summary: summary.to_string(),
        acknowledged_button_code: Vec::new(),
        include_in_application: Vec::new(),
        require_verified_identity: None,
    }
}

/// THE IDENTITY RULE A PUSH WRITES (identity phase 1): the dialog's explicit
/// choice; otherwise none for a new application and the VERIFIED base's rule
/// for a push -- and a push whose base rule cannot be read is refused rather
/// than silently switching which answers every total counts.
///
/// SABOTAGE: make the `(None, Update)` arm return `Ok(None)` -- the
/// "keeps the base's rule" and "refused" assertions fail.
#[test]
fn a_push_keeps_its_bases_identity_rule_unless_the_author_changes_it() {
    use crate::calp_commands::resolve_identity_policy;
    let on = Some(calp::IdentityPolicy { require_verified: true });
    let update = calp::PushMode::Update { expected_base: calp::SemVer::new(1, 0, 0) };
    let unread = || -> Result<Option<calp::IdentityPolicy>, String> { panic!("the base must not be read") };
    assert_eq!(resolve_identity_policy(Some(true), &calp::PushMode::CreateNew, unread), Ok(on));
    assert_eq!(resolve_identity_policy(Some(false), &update, unread), Ok(None));
    assert_eq!(resolve_identity_policy(None, &calp::PushMode::CreateNew, unread), Ok(None));
    assert_eq!(resolve_identity_policy(None, &update, || Ok(on)), Ok(on), "a push keeps the base's rule");
    let refused = resolve_identity_policy(None, &update, || Err("unreadable".to_string())).unwrap_err();
    assert!(refused.starts_with("CALP_PUSH_IDENTITY_RULE_UNKNOWN"), "{refused}");
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
    link.record_push(
        "1.1.0",
        "2026-08-29T10:00:00Z",
        Vec::new(),
        calp::WorkingCopyContent::default(),
    );
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
        identity_policy: None,
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
    let assembly = &cmds[cmds.find("fn assemble_publish_snapshot(").unwrap()..];
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

/// A working copy whose link predates the record of what the application
/// carries is REFUSED, with the remedy -- never pushed on a guess. The filter
/// used to answer such a link with "publish everything", which is the leak the
/// record exists to close (review finding on BUG-0261; no backward
/// compatibility is kept, CLAUDE.md).
///
/// SABOTAGE: make `unrecorded_link_refusal` return `None` for every link.
#[test]
fn a_push_from_a_link_without_its_record_is_refused_with_the_remedy() {
    use crate::calp_commands::unrecorded_link_refusal;
    let ws = r"\\server\registry";
    let legacy = calp::WorkingCopyLink::new(ws, "sales", "report", "1.0.0", "2026-09-30T00:00:00Z", Vec::new());
    let refusal = unrecorded_link_refusal(Some(&legacy), ws, "sales").expect("an unrecorded link is refused");
    assert!(refusal.starts_with("CALP_PUSH_LINK_UNRECORDED:"), "{refusal}");
    assert!(refusal.contains("Open Application for Editing"), "the refusal names the remedy: {refusal}");
    assert!(refusal.contains("Nothing was pushed"), "{refusal}");

    let mut recorded = legacy.clone();
    recorded.record_content(calp::WorkingCopyContent::default());
    assert_eq!(unrecorded_link_refusal(Some(&recorded), ws, "sales"), None, "an EMPTY record is a record");
    // A link to ANOTHER application is not this push's business (a new
    // application created from the workbook has no link of its own yet).
    assert_eq!(unrecorded_link_refusal(Some(&legacy), ws, "sales-2026"), None);
    assert_eq!(unrecorded_link_refusal(None, ws, "sales"), None, "a first publish has no link");
}

/// The gate runs in `calp_publish` before anything is assembled or published.
///
/// SABOTAGE: delete the `unrecorded_link_refusal(` call from `calp_publish`.
#[test]
fn the_unrecorded_link_gate_runs_before_the_assembly() {
    let cmds: String = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/calp_commands.rs"))
        .unwrap()
        .lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n");
    let publish = &cmds[cmds.find("pub fn calp_publish(").unwrap()..];
    let publish = &publish[..publish.find("\n}\n").unwrap()];
    let gate = publish.find("unrecorded_link_refusal(").expect("calp_publish no longer refuses an unrecorded link");
    let assembly = publish.find("assemble_publish_workbook(").expect("the assembly moved");
    assert!(gate < assembly, "the gate runs before the carrier is assembled");
}

/// rev11A: a push the WORKSPACE is bound to refuse -- a stale base, a version
/// not above the head, one already published, a create over an existing
/// application or an update of a missing one -- is refused BEFORE the
/// recalculation before publishing, so it never runs a full workbook pass on
/// a manual-calculation author's workbook. Each refusal is core's own text
/// (`CalpError`); core asks every one again under the workspace lock.
///
/// SABOTAGE: make `preflight_workspace_gates` return `Ok(())` at once -- every
/// refusal below comes back Ok.
#[test]
fn the_workspace_gates_refuse_before_the_recalculation_with_cores_own_text() {
    use calp::{PushMode, SemVer};
    let prof = tempfile::TempDir::new().unwrap();
    let mut wb = persistence::Workbook::default();
    wb.sheets = vec![persistence::Sheet::new("Sheet1".to_string())];
    let reg = calp::MemoryWorkspace::new();
    publish_with(&reg, &wb, SemVer::new(1, 0, 0), Vec::new(), prof.path());
    let gates = |mode: PushMode, version: SemVer| {
        crate::calp_commands::preflight_workspace_gates(&reg, "sales", &mode, &version)
    };
    let update = |base: SemVer| PushMode::Update { expected_base: base };

    // POSITIVE CONTROL: the next version on the current head passes.
    gates(update(SemVer::new(1, 0, 0)), SemVer::new(1, 0, 1)).expect("a push the workspace accepts passes");
    // A create into an empty name passes too.
    crate::calp_commands::preflight_workspace_gates(&reg, "other", &PushMode::CreateNew, &SemVer::new(1, 0, 0))
        .expect("a new application passes");

    let stale = gates(update(SemVer::new(0, 9, 0)), SemVer::new(1, 0, 1)).unwrap_err();
    assert!(stale.contains("you started from v0.9.0") && stale.contains("now at v1.0.0"), "{stale}");
    let not_greater = gates(update(SemVer::new(1, 0, 0)), SemVer::new(1, 0, 0)).unwrap_err();
    assert!(not_greater.contains("Use v1.0.1 or higher"), "{not_greater}");
    let exists = gates(PushMode::CreateNew, SemVer::new(2, 0, 0)).unwrap_err();
    assert_eq!(exists, calp::CalpError::ApplicationAlreadyExists("sales".to_string()).to_string());
    let missing = crate::calp_commands::preflight_workspace_gates(
        &reg,
        "other",
        &update(SemVer::new(1, 0, 0)),
        &SemVer::new(1, 0, 1),
    )
    .unwrap_err();
    assert_eq!(missing, calp::CalpError::ApplicationNotFound("other".to_string()).to_string());
}

// ---------------------------------------------------------------------------
// rev13A: an (async) push that outlives its workbook (File > Open / New)
// ---------------------------------------------------------------------------

/// The two steps `open_file` and `new_file` run to replace the workbook, in
/// their order: the epoch moves, then every document-scoped store is reset.
/// Then the opened workbook's OWN link is restored, as `open_file` restores
/// it from the file.
fn open_another_workbook(
    state: &crate::AppState,
    file: &crate::persistence::FileState,
    its_link: Option<calp::WorkingCopyLink>,
) {
    let load = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::LoadingFromDisk,
    );
    file.note_document_replaced();
    crate::persistence::reset_document_scoped_stores(
        state,
        &crate::persistence::UserFilesState::default(),
        &crate::slicer::SlicerState::new(),
        &crate::ribbon_filter::RibbonFilterState::new(),
        &crate::pane_control::PaneControlState::new(),
        &crate::scripting::types::ScriptState::new(),
        &crate::pivot::types::PivotState::new(),
        &crate::bi::types::BiState::new(),
        &crate::timeline_slicer::TimelineSlicerState::new(),
        &load,
    )
    .expect("the reset succeeds");
    *state.working_copy_link.write(&load).unwrap() = its_link;
}

fn record(state: &crate::AppState, file: &crate::persistence::FileState, epoch: u64) -> bool {
    record_as(state, file, epoch) == crate::calp_commands::PushLinkRecord::Recorded
}

/// A push of application `x-app` landing in this workbook's link.
fn record_as(
    state: &crate::AppState,
    file: &crate::persistence::FileState,
    epoch: u64,
) -> crate::calp_commands::PushLinkRecord {
    crate::calp_commands::record_push_in_working_copy_link(
        state,
        file,
        epoch,
        r"\\server\reports",
        "x-app",
        "report",
        "1.1.0",
        "2026-10-31T10:00:00Z",
        Vec::new(),
        calp::WorkingCopyContent::default(),
    )
    .expect("the link write does not fail")
}

/// rev13A (MAJOR): `calp_publish` is `(async)`, so a File > Open landing
/// mid-push used to let the push record ITS version in the NEWLY opened
/// workbook's link -- making B a working copy of X, or moving app Y's base to
/// X's version -- and dirty B. And an open landing before the assembly let
/// the carrier be built from B after the gates judged A. The push now reads
/// the document epoch at entry: the shipped carrier is refused once it moved,
/// and the link write (asked under the link's lock) records nothing.
///
/// SABOTAGE: make `FileState::document_replaced_since` return `false` -- the
/// refusal and the "records nothing" assertions fail.
#[test]
fn a_push_that_outlives_its_workbook_ships_nothing_from_and_records_nothing_in_the_next_one() {
    let state = crate::create_app_state();
    let file = crate::persistence::FileState::default();

    // Positive control: nothing replaced the workbook, the push records.
    let epoch = file.document_epoch();
    crate::calp_commands::refuse_push_if_document_replaced(&file, epoch).expect("the same workbook ships");
    assert!(record(&state, &file, epoch), "a push from the workbook on screen is recorded");
    assert_eq!(state.working_copy_link.read().unwrap().as_ref().unwrap().base_version, "1.1.0");
    assert!(file.is_dirty(), "recording the push is saved state");

    // The push starts on A, and B (a working copy of app Y at 2.0.0) is opened
    // before the assembly or before the link write.
    let epoch = file.document_epoch();
    let b_link = calp::WorkingCopyLink::new(
        r"\\server\reports",
        "y-app",
        "report",
        "2.0.0",
        "2026-10-01T00:00:00Z",
        Vec::new(),
    );
    open_another_workbook(&state, &file, Some(b_link));
    crate::document_effect::mark_saved(&file);
    assert!(!file.is_dirty(), "the premise: B opened clean");

    let refused = crate::calp_commands::refuse_push_if_document_replaced(&file, epoch)
        .expect_err("a carrier assembled across File > Open was shipped");
    assert!(refused.starts_with("CALP_PUSH_DOCUMENT_REPLACED"), "{refused}");
    assert!(refused.contains("Nothing was published"), "{refused}");

    assert!(!record(&state, &file, epoch), "the push was recorded in the workbook opened after it started");
    let link = state.working_copy_link.read().unwrap().clone().expect("B's own link survives");
    assert_eq!(link.package_name, "y-app", "B became a working copy of the pushed application");
    assert_eq!(link.base_version, "2.0.0", "B's base moved to the pushed application's version");
    assert!(!file.is_dirty(), "the push dirtied the workbook it did not come from");
}

/// rev15B: THE SAME PUSH, WITH NO OPEN -- the link re-pointed by
/// Collaboration > Open Application for Editing of ANOTHER application Y while
/// the push of X ran (the Publish dialog is non-modal; `calp_checkout` writes
/// the link and does not move the epoch). The push recorded X's version and
/// X's published sheets on Y's link, so Y's working copy named a base Y never
/// had. The link's target is now asked under the same lock as the epoch.
///
/// SABOTAGE: drop the `targets(..)` check in
/// `record_push_in_working_copy_link` -- fails at "RE-POINTED".
#[test]
fn a_push_records_nothing_on_a_link_a_checkout_re_pointed_at_another_application() {
    use crate::calp_commands::PushLinkRecord;
    let state = crate::create_app_state();
    let file = crate::persistence::FileState::default();
    let epoch = file.document_epoch();
    // The push of x-app started on an unlinked workbook (CreateNew); the
    // checkout of y-app lands mid-push, as `calp_checkout` writes it.
    let y_link = calp::WorkingCopyLink::new(
        r"\\server\reports",
        "y-app",
        "report",
        "2.0.0",
        "2026-10-01T00:00:00Z",
        vec![calp::WorkingCopySheetRef { sheet_id: identity::SheetId::from_bytes(identity::generate_uuid_v7()), name: "Y".to_string() }],
    );
    let load = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::LoadingFromDisk,
    );
    *state.working_copy_link.write(&load).unwrap() = Some(y_link.clone());

    assert_eq!(
        record_as(&state, &file, epoch),
        PushLinkRecord::LinkRepointed { now_targets: "y-app".to_string() },
        "RE-POINTED: the push of x-app was recorded on y-app's working-copy link"
    );
    let link = state.working_copy_link.read().unwrap().clone().expect("Y's link survives");
    assert_eq!(link, y_link, "y-app's link was changed by a push of x-app");
    assert!(!file.is_dirty(), "a push that recorded nothing dirtied the workbook");

    // Positive control: the link names x-app (the workspace spelled with a
    // trailing separator, the same share) -- the push records.
    let mut x_link = y_link;
    x_link.package_name = "x-app".to_string();
    x_link.registry_url = r"\\server\reports\".to_string();
    *state.working_copy_link.write(&load).unwrap() = Some(x_link);
    assert_eq!(record_as(&state, &file, epoch), PushLinkRecord::Recorded);
    assert_eq!(state.working_copy_link.read().unwrap().as_ref().unwrap().base_version, "1.1.0");
}

/// The wiring a unit test cannot drive (both need Tauri `State`): `open_file`
/// and `new_file` move the epoch BEFORE they reset a store, and `calp_publish`
/// reads it before its first gate, asks it after the shipped carrier's
/// assembly (before core publish) and hands it to the link write.
///
/// SABOTAGE: delete `let _replacing = file_state.begin_document_replacement();` from `open_file`.
#[test]
fn file_open_and_new_move_the_epoch_and_the_push_checks_it() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let code = |rel: &str| -> String {
        std::fs::read_to_string(root.join(rel))
            .unwrap()
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let body = |src: &str, signature: &str| -> String {
        let at = src.find(signature).unwrap_or_else(|| panic!("`{signature}` moved"));
        let rest = &src[at..];
        rest[..rest.find("\n}").unwrap()].to_string()
    };
    let persistence = code("src/persistence.rs");
    for door in ["pub fn open_file(", "pub fn new_file("] {
        let b = body(&persistence, door);
        let bump = b.find("let _replacing = file_state.begin_document_replacement();").unwrap_or_else(|| panic!("`{door}..` no longer moves the document epoch"));
        let reset = b.find("reset_document_scoped_stores(").expect("the reset moved");
        assert!(bump < reset, "`{door}..` resets a store before it moves the document epoch");
    }
    let calp = code("src/calp_commands.rs");
    let publish = body(&calp, "pub fn calp_publish(");
    let read = publish
        .find("let document_epoch = file_state.settled_document_epoch();")
        .expect("the push no longer reads the SETTLED epoch (under the document pin)");
    let first_gate = publish.find("parse_push_mode(").expect("the first gate moved");
    assert!(read < first_gate, "the epoch is read after a gate judged the workbook");
    let assembled = publish.rfind("assemble_publish_workbook(").expect("the shipped assembly moved");
    let asked = publish.find("refuse_push_if_document_replaced(&file_state, document_epoch)?;").expect("the carrier is no longer checked");
    let stale = publish.find("refuse_push_on_stale_carrier(&assembly.workbook)?;").expect("the carrier's calculation is no longer checked");
    let core = publish.find("calp::publish::publish(").expect("core publish moved");
    assert!(assembled < asked && asked < core, "the epoch is not asked between the shipped assembly and core publish");
    assert!(assembled < stale && stale < core, "the calculation is not asked between the shipped assembly and core publish");
    let link = publish.find("record_push_in_working_copy_link(").expect("the link write moved");
    assert!(publish[link..].contains("document_epoch,"), "the link write is not handed the epoch");
    assert!(!publish.contains("working_copy_link.write("), "calp_publish writes the link around the epoch check");
}

/// calpref2 (pubepoch residual 1): the push's recalculation before publishing
/// MUTATES the live document, so a File > Open that landed during it let the
/// pass run over the newly opened workbook -- under manual calculation that
/// changed its stale values, though the push was then refused. The pass now
/// runs with the document PINNED to the push's epoch: an open waits for it
/// before it moves the epoch (and so before it resets a store), and a pinned
/// work that starts after the move never runs. (That the pass itself refuses
/// after an open, with nothing recalculated, is
/// `manual_calc_state_tests::a_push_whose_workbook_was_replaced_recalculates_nothing`.)
///
/// SABOTAGE: drop the exclusive pin from `FileState::note_document_replaced`
/// -- the open moves the epoch under the pinned work.
#[test]
fn file_open_waits_for_a_pinned_recalculation_and_a_pin_after_it_never_runs() {
    let file = std::sync::Arc::new(crate::persistence::FileState::default());
    let epoch = file.document_epoch();
    let (opener, moved_under_the_pin) = file
        .with_document_pinned(epoch, || {
            let f = std::sync::Arc::clone(&file);
            let opener = std::thread::spawn(move || f.note_document_replaced());
            // Ample time for an unblocked open to move the epoch.
            std::thread::sleep(std::time::Duration::from_millis(400));
            (opener, file.document_replaced_since(epoch))
        })
        .expect("the pin runs its work on the document of its own epoch");
    assert!(
        !moved_under_the_pin,
        "File > Open replaced the workbook while the push's recalculation was pinned to it"
    );
    opener.join().expect("the open finishes once the pin is released");
    assert!(file.document_replaced_since(epoch), "the open moved the epoch after the pinned work");
    assert!(
        file.with_document_pinned(epoch, || ()).is_none(),
        "a work pinned to the replaced workbook's epoch ran over the next one"
    );

    // The wiring: the push's pass is handed the entry epoch.
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let calp = std::fs::read_to_string(root.join("src/calp_commands.rs")).unwrap();
    let body = |signature: &str| -> String {
        let at = calp.find(signature).unwrap_or_else(|| panic!("`{signature}` moved"));
        let rest = &calp[at..];
        rest[..rest.find("\n}").unwrap()]
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let publish = body("pub fn calp_publish(");
    let call = &publish[publish.find("recalculate_before_publish(").expect("the push no longer recalculates")..];
    assert!(
        call[..call.find(")?;").unwrap()].contains("document_epoch,"),
        "the recalculation before publishing is not handed the push's epoch"
    );
    assert!(
        body("pub(crate) fn recalculate_before_publish(").contains("with_document_pinned(epoch,"),
        "the recalculation before publishing no longer pins the document"
    );
}

/// Round 18 (rev16B minor): File > Open moved the epoch under the exclusive
/// pin and RELEASED it at once, before resetting and restoring a single store.
/// A push that read its entry epoch then got the NEW epoch while the open was
/// still restoring, and its pinned pass ran over a half-restored workbook. The
/// replacement now holds the pin until it is done
/// (`begin_document_replacement`), and the push reads its entry epoch under the
/// shared pin (`settled_document_epoch`): both wait for the whole replacement.
///
/// SABOTAGE: read `settled_document_epoch` without the pin (a bare
/// `self.document_epoch()`) -- fails at "MID-REPLACEMENT".
#[test]
fn a_push_entry_epoch_and_a_pinned_work_wait_for_the_whole_replacement() {
    let file = std::sync::Arc::new(crate::persistence::FileState::default());
    let before = file.document_epoch();
    let replacing = file.begin_document_replacement();
    // The open is now "restoring": the epoch has moved, the pin is exclusive.
    let (read_tx, read_rx) = std::sync::mpsc::channel();
    let (pinned_tx, pinned_rx) = std::sync::mpsc::channel();
    let reader = {
        let f = std::sync::Arc::clone(&file);
        std::thread::spawn(move || {
            // The entry read is reported the moment it answers...
            let epoch = f.settled_document_epoch();
            read_tx.send(epoch).unwrap();
            // ...and the pinned work separately.
            pinned_tx.send(f.with_document_pinned(epoch, || ()).is_some()).unwrap();
        })
    };
    // Ample time for an unblocked reader to answer.
    std::thread::sleep(std::time::Duration::from_millis(400));
    assert!(
        read_rx.try_recv().is_err(),
        "the push read its entry epoch MID-REPLACEMENT (the open had not finished restoring)"
    );
    assert!(pinned_rx.try_recv().is_err(), "a pinned work ran MID-REPLACEMENT");
    drop(replacing);
    let epoch = read_rx.recv_timeout(std::time::Duration::from_secs(10)).expect("the read answers once the open is done");
    let ran = pinned_rx.recv_timeout(std::time::Duration::from_secs(10)).expect("the pinned work finishes");
    reader.join().unwrap();
    assert_eq!(epoch, before + 1, "after the replacement the settled epoch is the opened workbook's");
    assert!(ran, "a work pinned to the settled epoch runs once the replacement is done");
}

/// calpref2 (pubepoch residual 2): the audit row of a push that LANDED after
/// File > Open replaced its workbook was written into the trail of the
/// workbook now on screen (flagged `pushedFromReplacedWorkbook`) -- a trail
/// that is saved INSIDE that workbook, which never pushed. The row now goes
/// to the session log when the epoch moved, and to the pushing workbook's
/// trail otherwise.
///
/// SABOTAGE: make `record_push_audit_row` write the row whatever the epoch --
/// B's trail holds A's push.
#[test]
fn the_audit_row_of_a_push_whose_workbook_was_replaced_never_lands_in_the_next_workbook() {
    let state = crate::create_app_state();
    let file = crate::persistence::FileState::default();
    let row = |epoch: u64| {
        let mut extra = std::collections::HashMap::new();
        extra.insert("package".to_string(), serde_json::json!("x-app"));
        extra.insert("version".to_string(), serde_json::json!("1.1.0"));
        crate::calp_commands::record_push_audit_row(
            &state,
            &file,
            epoch,
            "Published x-app v1.1.0 (1 sheets)",
            "author",
            "2026-10-31T10:00:00Z",
            extra,
        )
    };
    let published = |state: &crate::AppState| {
        state
            .audit_log
            .read()
            .unwrap()
            .entries
            .iter()
            .filter(|e| matches!(e.event, calp::audit::AuditEvent::Published))
            .count()
    };

    // Positive control: the workbook that pushed records its push.
    assert!(row(file.document_epoch()), "the pushing workbook's trail refused the row");
    assert_eq!(published(&state), 1, "a push from the workbook on screen is audited in it");

    // The push starts on A; B is opened before the row is written.
    let epoch = file.document_epoch();
    open_another_workbook(&state, &file, None);
    assert_eq!(published(&state), 0, "the premise: B's trail starts empty");
    assert!(!row(epoch), "the row was reported as recorded in a workbook");
    assert_eq!(
        published(&state),
        0,
        "the push's audit row landed in the trail of the workbook opened after it started"
    );

    // ...and calp_publish writes its row only through the helper.
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let calp = std::fs::read_to_string(root.join("src/calp_commands.rs")).unwrap();
    let at = calp.find("pub fn calp_publish(").expect("calp_publish moved");
    let rest = &calp[at..];
    let publish: String = rest[..rest.find("\n}").unwrap()]
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!publish.contains("audit_log.write("), "calp_publish writes its audit row around the epoch check");
    let call = &publish[publish.find("record_push_audit_row(").expect("the push's audit row moved")..];
    assert!(call[..call.find(");").unwrap()].contains("document_epoch,"), "the audit row is not handed the epoch");
}

/// BUG-0653: THE ROW OF A PUSH WHOSE WORKBOOK WAS REPLACED HAS A DURABLE,
/// VISIBLE HOME. It used to reach only the session log -- no audit viewer
/// showed it and the next start lost it, while the workspace's signed version
/// list recorded the version. It now lands in THIS COMPUTER's append-only
/// trail (`machine_audit`, `collaboration-audit.jsonl` in the profile) with
/// every field it carried plus `reason: documentReplaced`, and the audit
/// viewer reads it through `calp_get_audit_log`'s `includeMachine`. A row
/// that DID reach its workbook is not copied there (positive control), and
/// the model-only publish -- which wrote its row straight into whatever
/// workbook was on screen -- now goes through the same helper.
///
/// SABOTAGES (separate builds, each fails its own assertion): (1) drop the
/// `machine_audit::record` call from `record_push_audit_row` -- "this
/// computer's trail must hold the replaced push". (2) `audit_log_view`
/// ignores `include_machine` -- "the viewer's read must carry this
/// computer's trail".
#[test]
fn the_audit_row_of_a_push_whose_workbook_was_replaced_lands_in_this_computers_trail() {
    let profile = tempfile::TempDir::new().unwrap();
    crate::profile_dir::with_test_profile(profile.path(), || {
        let state = crate::create_app_state();
        let file = crate::persistence::FileState::default();
        let row = |epoch: u64| {
            let mut extra = std::collections::HashMap::new();
            extra.insert("package".to_string(), serde_json::json!("x-app"));
            extra.insert("version".to_string(), serde_json::json!("1.1.0"));
            crate::calp_commands::record_push_audit_row(
                &state,
                &file,
                epoch,
                "Published x-app v1.1.0 (1 sheets)",
                "author",
                "2026-11-04T10:00:00Z",
                extra,
            )
        };
        let machine_rows = || crate::machine_audit::read_trail(profile.path()).entries;

        // Positive control: a push from the workbook on screen stays in it.
        assert!(row(file.document_epoch()));
        assert!(machine_rows().is_empty(), "a row that reached its workbook must not be copied to this computer's trail");

        // The push starts on A; B is opened before the row is written.
        let epoch = file.document_epoch();
        open_another_workbook(&state, &file, None);
        assert!(!row(epoch), "the premise: the row has no workbook");
        let rows = machine_rows();
        assert_eq!(rows.len(), 1, "this computer's trail must hold the replaced push");
        assert!(matches!(rows[0].event, calp::audit::AuditEvent::Published));
        assert_eq!(rows[0].description, "Published x-app v1.1.0 (1 sheets)");
        assert_eq!(rows[0].user, "author");
        assert_eq!(rows[0].extra["package"], serde_json::json!("x-app"), "every field the row carried");
        assert_eq!(rows[0].extra["reason"], serde_json::json!(crate::machine_audit::REASON_DOCUMENT_REPLACED));

        // The viewer reads it beside the workbook's own trail.
        let view = crate::calp_commands::audit_log_view(&state, true).unwrap();
        let machine = view.machine.expect("the viewer's read must carry this computer's trail");
        assert_eq!(machine.entries.len(), 1);
        assert!(view.log.entries.is_empty(), "B's own trail still holds nothing of A's push");
        assert!(crate::calp_commands::audit_log_view(&state, false).unwrap().machine.is_none(), "only when asked");
    });

    // ...and the model-only publish writes its row only through the helper,
    // handed the epoch it read at entry.
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let calp = std::fs::read_to_string(root.join("src/calp_commands.rs")).unwrap();
    let at = calp.find("pub fn calp_publish_model(").expect("calp_publish_model moved");
    let rest = &calp[at..];
    let body: String = rest[..rest.find("\n}").unwrap()]
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!body.contains("audit_log.write("), "calp_publish_model writes its audit row around the epoch check");
    let call = &body[body.find("record_push_audit_row(").expect("the model publish's audit row moved")..];
    assert!(call[..call.find(");").unwrap()].contains("document_epoch,"), "the model publish's row is not handed the epoch");
}
