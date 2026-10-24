//! FILENAME: app/src-tauri/src/subscribed_sheet_tests.rs
//! PURPOSE: A sheet that came from a subscribed `.calp` application is somebody
//! else's content. It must not leave in YOUR application without a deliberate,
//! disclosed act, and it must not be deleted out from under the subscription
//! that still tracks it.
//!
//! CONTEXT: Reported from live testing as "I can subscribe to a sheet, then
//! publish the same sheet and I cannot track what is published." It was worse
//! than that: NOTHING on the publish path consulted the subscription ledger, so
//! publishing application B from a workbook subscribed to application A shipped
//! A's sheets inside B, counted under `included["sheets"]` as the author's own.
//! `resolve_publish_sheet_indices` filtered object-backed sheets and nothing
//! else, and `CALP_PUSH_IS_SUBSCRIBER` — the one gate that existed — matched on
//! the application NAME alone, never compared workspaces, and had no test.
//!
//! Every test here names, in its own comment, the one-line production change
//! that makes it red. A guard nobody has watched fail is a guard nobody knows
//! the shape of.

use std::collections::{HashMap, HashSet};

use crate::calp_commands::RequestedSheets;
use crate::persistence::FileState;
use crate::AppState;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/// `resolve_publish_sheet_indices` for a request BY POSITION, in the push's
/// words and with no filter objects -- the question every test here asks of
/// the resolver (round 9 gave it a request type and the door's act word).
fn resolve_positions(
    state: &AppState,
    kind: &str,
    positions: Vec<usize>,
) -> Result<crate::calp_commands::PublishSelection, String> {
    crate::calp_commands::resolve_publish_sheet_indices(
        state,
        kind,
        &RequestedSheets::ByPosition(positions),
        "published",
        &Default::default(),
    )
}

/// A workbook with `count` user sheets, seeded the way a load does.
fn workbook_with_sheets(count: usize) -> AppState {
    let state = crate::create_app_state();
    let seed = crate::document_effect::test_seed_effect;
    for i in 1..count {
        state.grids.write(&seed()).unwrap().push(engine::Grid::new());
        state
            .sheet_names
            .write(&seed())
            .unwrap()
            .push(format!("Sheet{}", i + 1));
        state.all_column_widths.write(&seed()).unwrap().push(HashMap::new());
        state.all_row_heights.write(&seed()).unwrap().push(HashMap::new());
        state.all_user_hidden_rows.write(&seed()).unwrap().push(HashSet::new());
        state.all_user_hidden_cols.write(&seed()).unwrap().push(HashSet::new());
        state.all_merged_regions.write(&seed()).unwrap().push(HashSet::new());
        state
            .sheet_ids
            .write(&seed())
            .unwrap()
            .push(identity::SheetId::from_bytes(identity::generate_uuid_v7()));
    }
    state
}

fn sheet_id_at(state: &AppState, index: usize) -> identity::SheetId {
    state.sheet_ids.read().unwrap()[index]
}

/// Record that sheet `index` was materialized by application `package`.
fn subscribe_sheet(state: &AppState, index: usize, package: &str, registry: &str) {
    let seed = crate::document_effect::test_seed_effect();
    let local = sheet_id_at(state, index);
    let name = state.sheet_names.read().unwrap()[index].clone();
    let mut subs = state.subscriptions.write(&seed).unwrap();

    let entry = calp::manifest::SubscribedSheet {
        package_sheet_id: identity::SheetId::from_bytes(identity::generate_uuid_v7()),
        local_sheet_id: local,
        local_name: name,
        extra: HashMap::new(),
    };

    if let Some(existing) = subs
        .subscriptions
        .iter_mut()
        .find(|s| s.package_name == package && s.registry_url == registry)
    {
        existing.sheets.push(entry);
        return;
    }
    subs.subscriptions.push(calp::manifest::Subscription {
        package_name: package.to_string(),
        registry_url: registry.to_string(),
        version_pin: "latest".to_string(),
        resolved_version: "1.0.0".to_string(),
        resolved_at: "2026-08-31T00:00:00Z".to_string(),
        sheets: vec![entry],
        environment: None,
        data_source_configs: Vec::new(),
        objects: Vec::new(),
        detached_sheets: Vec::new(),
        detached_local_sheets: Vec::new(),
        upstream_removed_sheets: Vec::new(),
        extra: HashMap::new(),
    });
}

/// The source text of one function, for the placement assertions.
///
/// COMMENTS ARE STRIPPED FIRST, and that is not tidiness. The guard this file
/// checks the position of carries a comment explaining why it sits above
/// `DocumentEffect::mutates` — so a scanner that reads comments finds the phrase
/// in the explanation, decides the code is in the wrong order, and reports a
/// failure on the file that is correct. This test caught exactly that on its
/// first run.
fn body_of(signature: &str) -> String {
    let files = [
        include_str!("sheets.rs"),
        include_str!("calp_commands.rs"),
    ];
    for src in files {
        if let Some(start) = src.find(signature) {
            let rest = &src[start..];
            // Crude but sufficient: stop at the next top-level `\n}` .
            let end = rest.find("\n}\n").unwrap_or(rest.len());
            return strip_line_comments(&rest[..end]);
        }
    }
    panic!("signature not found: {}", signature);
}

/// Blank out `//` line comments, keeping byte offsets meaningful by preserving
/// line structure.
fn strip_line_comments(src: &str) -> String {
    src.lines()
        .map(|line| match line.find("//") {
            Some(i) => line[..i].to_string(),
            None => line.to_string(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// ---------------------------------------------------------------------------
// A. Publish
// ---------------------------------------------------------------------------

/// THE REPORTED DEFECT. Publishing must not ship a sheet that came from
/// somebody else's application.
///
/// SABOTAGE: delete the `.filter(|&i| !provenance.is_subscribed(i))` clause in
/// `resolve_publish_sheet_indices`' default branch.
#[test]
fn publishing_does_not_ship_a_subscribed_sheet_by_default() {
    let state = workbook_with_sheets(3);
    subscribe_sheet(&state, 1, "acme.finance", r"\\share\ws");

    let selection =
        resolve_positions(&state, "report", Vec::new()).unwrap();

    assert_eq!(
        selection.indices,
        vec![0, 2],
        "the subscribed sheet must be left out of a default publish"
    );
    assert_eq!(selection.withheld_subscribed.len(), 1);
    assert_eq!(selection.withheld_subscribed[0].package_name, "acme.finance");
    assert!(selection.included_subscribed.is_empty());
}

/// The deliberate opt-in still works — the point of "excluded BY DEFAULT".
///
/// SABOTAGE: move the filter out of the default branch into a
/// `selected.retain(...)` after the if/else. That is the PLAUSIBLE wrong
/// implementation, and it silently makes an explicit tick unpublishable.
#[test]
fn an_explicitly_ticked_subscribed_sheet_still_publishes() {
    let state = workbook_with_sheets(3);
    subscribe_sheet(&state, 1, "acme.finance", r"\\share\ws");

    let selection =
        resolve_positions(&state, "report", vec![1]).unwrap();

    assert_eq!(selection.indices, vec![1], "an explicit tick must be honoured");
    assert_eq!(
        selection.included_subscribed.len(),
        1,
        "and it must still be DISCLOSED — informed is not the same as unmentioned"
    );
    assert_eq!(selection.included_subscribed[0].package_name, "acme.finance");
}

/// The disclosure names the application, so the author can tell whose content
/// they are about to redistribute.
///
/// SABOTAGE: (a) drop `{}` for the application list from either detail string;
/// (b) emit the row unconditionally instead of returning `None` at zero.
#[test]
fn the_report_rows_name_the_application_and_vanish_when_empty() {
    let state = workbook_with_sheets(3);
    subscribe_sheet(&state, 1, "acme.finance", r"\\share\ws");

    let withheld =
        resolve_positions(&state, "report", Vec::new()).unwrap();
    let (included_row, excluded_row) =
        crate::calp_commands::subscribed_sheet_report_rows(&withheld);
    let excluded_row = excluded_row.expect("a withheld sheet must produce a 'stays behind' row");
    assert_eq!(excluded_row.category, "subscribedSheets");
    assert_eq!(excluded_row.count, 1);
    assert!(
        excluded_row.detail.contains("acme.finance"),
        "the row must say WHOSE content it is: {}",
        excluded_row.detail
    );
    assert!(included_row.is_none());

    let ticked =
        resolve_positions(&state, "report", vec![1]).unwrap();
    let (included_row, excluded_row) = crate::calp_commands::subscribed_sheet_report_rows(&ticked);
    let included_row = included_row.expect("a ticked subscribed sheet must be disclosed");
    assert!(included_row.detail.contains("acme.finance"));
    assert!(
        excluded_row.is_none(),
        "nothing was withheld, so there is no 'stays behind' row"
    );

    // A workbook with no subscriptions produces neither row.
    let plain = workbook_with_sheets(2);
    let none =
        resolve_positions(&plain, "report", Vec::new()).unwrap();
    let (a, b) = crate::calp_commands::subscribed_sheet_report_rows(&none);
    assert!(a.is_none() && b.is_none());
}

/// The library rule lives in ONE place now.
///
/// It used to be a branch inside `calp_publish` that `calp_publish_preview` did
/// not have, so a library PREVIEW described every sheet for a publish that
/// shipped none — while the resolver's own doc comment claimed the dry run
/// "can never describe a different application than the publish".
///
/// SABOTAGE: (a) delete the `library` arm in the resolver; (b) re-add the branch
/// in `calp_publish` — the source assertion catches the second.
#[test]
fn a_library_resolves_no_sheets_and_the_rule_lives_in_one_place() {
    let state = workbook_with_sheets(3);

    let library =
        resolve_positions(&state, "library", Vec::new()).unwrap();
    assert!(
        library.indices.is_empty(),
        "a library ships its module scripts, not the author's workbook"
    );

    let report =
        resolve_positions(&state, "report", Vec::new()).unwrap();
    assert_eq!(report.indices, vec![0, 1, 2]);

    // Explicit selection still wins for a library — the author named sheets.
    let explicit =
        resolve_positions(&state, "library", vec![1]).unwrap();
    assert_eq!(explicit.indices, vec![1]);

    let publish_body = body_of("pub fn calp_publish(");
    assert!(
        !publish_body.contains("LIBRARY_KIND"),
        "the library rule must live in the resolver, not be re-branched in the command"
    );
}

/// The preview hands the dialog TRUE workbook indices, not list positions.
///
/// SABOTAGE: build the list with `.enumerate()` over the filtered names instead
/// of the true index — the classic off-by-object-sheet.
#[test]
fn the_preview_sheet_list_reports_true_indices_and_provenance() {
    let state = workbook_with_sheets(3);
    subscribe_sheet(&state, 1, "acme.finance", r"\\share\ws");

    let selection =
        resolve_positions(&state, "report", Vec::new()).unwrap();
    let rows = crate::calp_commands::publish_preview_sheet_list(&state, &selection).unwrap();

    assert_eq!(rows.len(), 3);
    assert_eq!(rows[1].index, 1, "the TRUE workbook index, not the list position");
    assert_eq!(rows[1].subscribed_to, "acme.finance");
    assert!(!rows[1].default_selected, "a subscribed sheet opens unticked");
    assert!(rows[0].subscribed_to.is_empty());
    assert!(rows[0].default_selected);
}

// ---------------------------------------------------------------------------
// B. The delete guard
// ---------------------------------------------------------------------------

/// Deleting a subscribed sheet is refused, and the refusal names the remedy.
///
/// It must ALSO leave the document clean. `DocumentEffect::mutates` dirties at
/// CONSTRUCTION, so a guard placed below it marks the file modified on a refusal
/// the user can act on.
///
/// SABOTAGE: (a) delete the `ensure_unsubscribed_sheet(...)?` call — the message
/// assertion reds; (b) move the guard below `DocumentEffect::mutates` — the
/// CLEAN assertion reds while the message one still passes, which is what proves
/// the placement rather than the existence.
#[test]
fn deleting_a_subscribed_sheet_is_refused_and_names_detach() {
    let state = workbook_with_sheets(3);
    subscribe_sheet(&state, 1, "acme.finance", r"\\share\ws");
    let file_state = FileState::default();

    let before = state.sheet_names.read().unwrap().clone();
    let err = crate::sheets::delete_sheet_impl(
        &state,
        &file_state,
        &crate::pivot::types::PivotState::new(),
        &crate::persistence::UserFilesState::default(),
        &crate::pane_control::PaneControlState::new(),
        &crate::ribbon_filter::RibbonFilterState::new(),
        &crate::slicer::SlicerState::new(),
        &crate::timeline_slicer::TimelineSlicerState::new(),
        1,
        false,
        None,
    )
    .expect_err("a subscribed sheet must not be deletable");

    assert!(err.contains("acme.finance"), "name the application: {}", err);
    assert!(err.contains("Detach"), "name the remedy: {}", err);
    assert_eq!(
        *state.sheet_names.read().unwrap(),
        before,
        "a refused delete must not have removed anything"
    );
    assert!(
        !file_state.is_dirty(),
        "a refusal the user can act on must not leave the document dirty"
    );
}

/// Renaming is ALLOWED, and the ledger keeps pointing at the same sheet —
/// refresh matches on `local_sheet_id`, never on the name.
///
/// SABOTAGE: add `ensure_unsubscribed_sheet(...)?` to `rename_sheet_inner`.
#[test]
fn renaming_a_subscribed_sheet_is_allowed_and_keeps_the_mapping() {
    let state = workbook_with_sheets(2);
    subscribe_sheet(&state, 1, "acme.finance", r"\\share\ws");
    let file_state = FileState::default();
    let before = {
        let subs = state.subscriptions.read().unwrap();
        subs.subscriptions[0].sheets[0].local_sheet_id
    };

    let pivot_state = crate::pivot::types::PivotState::new();
    crate::sheets::rename_sheet_inner(&state, &file_state, &pivot_state, 1, "Vendor KPIs".to_string(), false)
        .expect("renaming a subscribed sheet is the subscriber's business");

    assert_eq!(state.sheet_names.read().unwrap()[1], "Vendor KPIs");
    let after = {
        let subs = state.subscriptions.read().unwrap();
        subs.subscriptions[0].sheets[0].local_sheet_id
    };
    assert_eq!(before, after, "the ledger must still point at the same sheet");
}

/// The guard's POSITION, asserted on the source, because the runtime assertion
/// above can only see one consequence of it.
///
/// SABOTAGE: swap the guard below the repairability block or below `mutates`.
#[test]
fn the_delete_guard_runs_before_the_preflight_and_before_mutates() {
    let body = body_of("pub(crate) fn delete_sheet_impl(");
    let guard = body
        .find("ensure_unsubscribed_sheet")
        .expect("the subscribed-sheet guard is gone from delete_sheet_impl");
    let preflight = body
        .find("check_workbook_repairable")
        .expect("the repairability pre-flight moved");
    let mutates = body
        .find("DocumentEffect::mutates")
        .expect("the effect construction moved");
    assert!(
        guard < preflight,
        "refuse before parsing every formula in the workbook"
    );
    assert!(
        guard < mutates,
        "refuse before the document is dirtied — `mutates` dirties at construction"
    );
}

/// The `delete_sheet` command's body over plain states, minus the slicer
/// pre/post work and the background re-query (which needs an AppHandle).
fn delete_through_the_impl(
    state: &AppState,
    file_state: &FileState,
    index: usize,
    expected: Option<identity::SheetId>,
) -> Result<crate::sheets::SheetsResult, String> {
    crate::sheets::delete_sheet_impl(
        state,
        file_state,
        &crate::pivot::types::PivotState::new(),
        &crate::persistence::UserFilesState::default(),
        &crate::pane_control::PaneControlState::new(),
        &crate::ribbon_filter::RibbonFilterState::new(),
        &crate::slicer::SlicerState::new(),
        &crate::timeline_slicer::TimelineSlicerState::new(),
        index,
        false,
        expected,
    )
}

/// Review RA-1, the pre-work. A delete that names its sheet by STABLE id is
/// answered about THAT sheet. The discard of a temporary sheet looked it up at
/// index 3, and then another door (the MCP server, on its own thread) moved a
/// SUBSCRIBED sheet into index 3. The subscribed-sheet guard ran by index,
/// before the delete's own id check, so the strip kept the temporary sheet and
/// showed "Cannot delete sheet 'Vendor KPIs': it came from the application
/// ... Detach it first" -- advice about a sheet the user never touched. And a
/// caller that MEANS the subscribed sheet is still refused about it, wherever
/// it now sits.
///
/// SABOTAGE: key the guard by `index` again (drop the `index_of_sheet` arm in
/// `delete_sheet_impl`) -- the first block fails, refused with the
/// subscribed-sheet message instead of the id check's.
#[test]
fn a_delete_by_stable_id_is_answered_about_the_sheet_it_meant() {
    // Sheet1, Costs, Vendor KPIs (subscribed), Drillthrough (temporary), all
    // through the real add path so the move below is the real one.
    let state = crate::create_app_state();
    let setup = FileState::default();
    for name in ["Costs", "Vendor KPIs", "Drillthrough"] {
        crate::sheets::add_sheet_inner(&state, &setup, Some(name.to_string()), ::persistence::SheetKind::Worksheet)
            .expect("add");
    }
    subscribe_sheet(&state, 2, "acme.finance", r"\\share\ws");
    let vendor = sheet_id_at(&state, 2);
    let drill = sheet_id_at(&state, 3);
    state.ephemeral_sheets.lock().unwrap().insert(drill);
    let names = |state: &AppState| state.sheet_names.read().unwrap().clone();
    let clean = FileState::default();

    // 1. The other door's move lands after the discard's lookup.
    let err = crate::sheets::discard_ephemeral_sheet_with(&state, &drill.to_string(), |index, id| {
        assert_eq!(index, 3, "fixture: the lookup found the temporary sheet at 3");
        crate::sheets::move_sheet_impl(
            &state,
            &setup,
            &crate::slicer::SlicerState::new(),
            &crate::timeline_slicer::TimelineSlicerState::new(),
            &crate::ribbon_filter::RibbonFilterState::new(),
            2,
            3,
        )
        .expect("the other door's move");
        assert_eq!(names(&state)[index], "Vendor KPIs", "fixture: the looked-up index now names the subscribed sheet");
        delete_through_the_impl(&state, &clean, index, Some(id))
    })
    .unwrap_err();
    assert_eq!(
        err,
        crate::sheets::SHEETS_CHANGED_UNDER_THE_DELETE,
        "the answer must be about the temporary sheet the discard meant, not the subscribed sheet that slid into its index"
    );
    assert_eq!(names(&state), vec!["Sheet1", "Costs", "Drillthrough", "Vendor KPIs"], "nothing was deleted");
    assert!(!clean.is_dirty(), "the refusal leaves the document clean");

    // 2. A caller that MEANS the subscribed sheet, and looked it up at 2 before
    //    the move, is refused about THAT sheet -- by name, with the remedy --
    //    although index 2 now holds the temporary sheet.
    let err = delete_through_the_impl(&state, &clean, 2, Some(vendor)).unwrap_err();
    assert!(
        err.contains("Vendor KPIs") && err.contains("acme.finance") && err.contains("Detach"),
        "refused about the sheet it meant, by name and with the remedy: {err}"
    );
    assert_eq!(names(&state), vec!["Sheet1", "Costs", "Drillthrough", "Vendor KPIs"]);
    assert!(!clean.is_dirty());
}

// ---------------------------------------------------------------------------
// C. Detach
// ---------------------------------------------------------------------------

/// Detaching makes the sheet the subscriber's own — publishable, and no longer
/// tracked.
///
/// SABOTAGE: remove the `sheets.retain(...)` that drops the ledger entry.
#[test]
fn detaching_a_sheet_makes_it_publishable() {
    let state = workbook_with_sheets(3);
    subscribe_sheet(&state, 1, "acme.finance", r"\\share\ws");
    let file_state = FileState::default();

    let before =
        resolve_positions(&state, "report", Vec::new()).unwrap();
    assert_eq!(before.indices, vec![0, 2], "precondition: withheld while subscribed");

    let result = crate::calp_commands::detach_sheet_inner(&state, &file_state, &crate::pivot::types::PivotState::new(), &crate::slicer::SlicerState::new(), &crate::timeline_slicer::TimelineSlicerState::new(), 1).unwrap();
    assert_eq!(result.package_name, "acme.finance");

    let after =
        resolve_positions(&state, "report", Vec::new()).unwrap();
    assert_eq!(after.indices, vec![0, 1, 2], "detached means yours to publish");
    assert!(after.withheld_subscribed.is_empty());
}

/// Detach leaves a tombstone, so a later refresh does not re-adopt the sheet.
///
/// SABOTAGE: drop the `detached_sheets.push(...)`. Refresh then sees the
/// application sheet as newly added and materializes it a second time.
#[test]
fn detach_records_a_tombstone_so_refresh_leaves_the_sheet_alone() {
    let state = workbook_with_sheets(2);
    subscribe_sheet(&state, 1, "acme.finance", r"\\share\ws");
    let package_sheet_id = {
        let subs = state.subscriptions.read().unwrap();
        subs.subscriptions[0].sheets[0].package_sheet_id
    };
    let file_state = FileState::default();

    crate::calp_commands::detach_sheet_inner(&state, &file_state, &crate::pivot::types::PivotState::new(), &crate::slicer::SlicerState::new(), &crate::timeline_slicer::TimelineSlicerState::new(), 1).unwrap();

    let subs = state.subscriptions.read().unwrap();
    // The subscription itself is gone here (it owned nothing else), which is
    // the stronger outcome: nothing left to refresh at all.
    assert!(
        subs.subscriptions.is_empty()
            || subs.subscriptions[0].detached_sheets.contains(&package_sheet_id),
        "detach must be remembered, or refresh re-adds the sheet"
    );
}

/// The whole subscription row goes only when it owns NOTHING else. A library or
/// dataset subscription legitimately has zero sheets.
///
/// SABOTAGE: drop `&& sub.objects.is_empty() && sub.data_source_configs.is_empty()`
/// — the second half of this test reds.
#[test]
fn the_subscription_survives_while_it_still_owns_something() {
    // Case 1: nothing else — the row goes.
    let state = workbook_with_sheets(2);
    subscribe_sheet(&state, 1, "acme.finance", r"\\share\ws");
    let file_state = FileState::default();
    let r = crate::calp_commands::detach_sheet_inner(&state, &file_state, &crate::pivot::types::PivotState::new(), &crate::slicer::SlicerState::new(), &crate::timeline_slicer::TimelineSlicerState::new(), 1).unwrap();
    assert!(r.subscription_removed);
    assert!(state.subscriptions.read().unwrap().subscriptions.is_empty());

    // Case 2: the subscription still lists an object — the row SURVIVES.
    let state = workbook_with_sheets(2);
    subscribe_sheet(&state, 1, "acme.finance", r"\\share\ws");
    {
        let seed = crate::document_effect::test_seed_effect();
        let mut subs = state.subscriptions.write(&seed).unwrap();
        subs.subscriptions[0].objects.push(calp::manifest::SubscribedObject {
            kind: "table".to_string(),
            id: "t1".to_string(),
            name: "Sales".to_string(),
            extra: HashMap::new(),
        });
    }
    let file_state = FileState::default();
    let r = crate::calp_commands::detach_sheet_inner(&state, &file_state, &crate::pivot::types::PivotState::new(), &crate::slicer::SlicerState::new(), &crate::timeline_slicer::TimelineSlicerState::new(), 1).unwrap();
    assert!(
        !r.subscription_removed,
        "a subscription that still owns a table is not empty"
    );
    assert_eq!(state.subscriptions.read().unwrap().subscriptions.len(), 1);
}

/// Detaching a sheet that came from nowhere is refused, and says so plainly.
///
/// SABOTAGE: replace the `ok_or_else` with a silent `return Ok(...)`.
#[test]
fn detaching_an_ordinary_sheet_is_refused() {
    let state = workbook_with_sheets(2);
    let file_state = FileState::default();
    let err = crate::calp_commands::detach_sheet_inner(&state, &file_state, &crate::pivot::types::PivotState::new(), &crate::slicer::SlicerState::new(), &crate::timeline_slicer::TimelineSlicerState::new(), 0)
        .expect_err("there is nothing to detach");
    assert!(err.contains("nothing to detach"), "{}", err);
    assert!(
        !file_state.is_dirty(),
        "a refusal must not dirty the document"
    );
}

// ---------------------------------------------------------------------------
// E. A working copy publishes the APPLICATION's sheets, not the workbook's
// ---------------------------------------------------------------------------

/// Record that this workbook is a working copy whose base version carried the
/// sheets at `indices`.
fn make_working_copy(state: &AppState, indices: &[usize], package: &str, registry: &str) {
    let seed = crate::document_effect::test_seed_effect();
    let ids = state.sheet_ids.read().unwrap().clone();
    let names = state.sheet_names.read().unwrap().clone();
    let base_sheets: Vec<calp::WorkingCopySheetRef> = indices
        .iter()
        .map(|&i| calp::WorkingCopySheetRef {
            sheet_id: ids[i],
            name: names[i].clone(),
        })
        .collect();
    let mut link = state.working_copy_link.write(&seed).unwrap();
    *link = Some(calp::WorkingCopyLink::new(
        registry,
        package,
        "report",
        "1.0.0",
        "2026-09-01T00:00:00Z",
        base_sheets,
    ));
}

/// THE CONSEQUENCE OF ADDITIVE CHECKOUT. The application's sheets join the
/// workbook you already had open, so "publish every sheet" would sweep your own
/// unrelated work into somebody else's application on the next push.
///
/// SABOTAGE: delete the `working_copy_base_sheets` branch from
/// `resolve_publish_sheet_indices` — the default falls back to "every user
/// sheet" and this reds immediately.
#[test]
fn a_working_copy_publishes_only_the_applications_sheets_by_default() {
    let state = workbook_with_sheets(3);
    // Sheet 1 is the application's; 0 and 2 are the user's own.
    make_working_copy(&state, &[1], "sales", r"\\share\ws");

    let selection =
        resolve_positions(&state, "report", Vec::new()).unwrap();

    assert_eq!(
        selection.indices,
        vec![1],
        "a push must not carry the author's unrelated sheets into the application"
    );
}

/// A sheet you ADD to the application still publishes — by ticking it. The
/// default is conservative, not a refusal.
#[test]
fn a_new_sheet_can_still_be_added_to_the_application_by_ticking_it() {
    let state = workbook_with_sheets(3);
    make_working_copy(&state, &[1], "sales", r"\\share\ws");

    let selection =
        resolve_positions(&state, "report", vec![1, 2]).unwrap();
    assert_eq!(selection.indices, vec![1, 2]);
}

/// A STANDALONE workbook is unaffected: no link, so the default is still every
/// user sheet minus the subscribed ones.
///
/// SABOTAGE: make `working_copy_base_sheets` return `Some(empty)` when there is
/// no link — every standalone publish would then ship nothing.
#[test]
fn a_standalone_workbook_still_defaults_to_every_sheet() {
    let state = workbook_with_sheets(3);
    let selection =
        resolve_positions(&state, "report", Vec::new()).unwrap();
    assert_eq!(selection.indices, vec![0, 1, 2]);
}

// ---------------------------------------------------------------------------
// D. The subscriber push gate
// ---------------------------------------------------------------------------

/// The identity trap: pushing to the very application you subscribe to.
///
/// SABOTAGE: `subscribes_to` returning `false` unconditionally.
#[test]
fn the_same_application_on_the_same_share_is_the_identity_trap() {
    let state = workbook_with_sheets(2);
    subscribe_sheet(&state, 1, "sales", r"\\share\ws");
    let subs = state.subscriptions.read().unwrap();
    assert!(crate::calp_commands::subscribes_to(
        &subs.subscriptions,
        r"\\share\ws",
        "sales"
    ));
}

/// THE TEST THAT DID NOT EXIST. Two teams may each publish `sales` to their own
/// share; refusing a push to YOUR `sales` because you subscribe to THEIRS is a
/// gate refusing for a reason that is not the reason it exists.
///
/// SABOTAGE: delete `&& calp::same_workspace(...)` — i.e. restore the code that
/// shipped. This test fires on exactly the line the fix adds.
#[test]
fn a_different_workspace_is_a_different_application() {
    let state = workbook_with_sheets(2);
    subscribe_sheet(&state, 1, "sales", r"\\theirs\ws");
    let subs = state.subscriptions.read().unwrap();
    assert!(
        !crate::calp_commands::subscribes_to(&subs.subscriptions, r"\\mine\ws", "sales"),
        "your own 'sales' on your own share is not the application you subscribe to"
    );
}

/// One share spelled two ways is one share — the gate must not refuse over a
/// trailing backslash.
///
/// SABOTAGE: change `same_workspace` to `a == b`.
#[test]
fn the_same_share_spelled_two_ways_is_the_same_share() {
    let state = workbook_with_sheets(2);
    subscribe_sheet(&state, 1, "sales", r"\\server\registry\");
    let subs = state.subscriptions.read().unwrap();
    assert!(crate::calp_commands::subscribes_to(
        &subs.subscriptions,
        r"\\SERVER\Registry",
        "sales"
    ));
}

/// The dead `version_pin != "dev"` exemption is gone. A dev subscription's name
/// is `dev:<path>`, which can never equal a target name — so the clause never
/// excluded anything, and would have silently activated if dev subscriptions
/// ever gained real names.
///
/// SABOTAGE: re-add `&& s.version_pin != "dev"`; the second assertion reds.
#[test]
fn a_dev_subscription_gets_no_exemption_it_never_used() {
    let state = workbook_with_sheets(2);
    subscribe_sheet(&state, 1, "dev:C:/x.cala", r"\\share\ws");
    {
        let seed = crate::document_effect::test_seed_effect();
        let mut subs = state.subscriptions.write(&seed).unwrap();
        subs.subscriptions[0].version_pin = "dev".to_string();
    }
    let subs = state.subscriptions.read().unwrap();
    assert!(!crate::calp_commands::subscribes_to(
        &subs.subscriptions,
        r"\\share\ws",
        "sales"
    ));
    assert!(
        crate::calp_commands::subscribes_to(&subs.subscriptions, r"\\share\ws", "dev:C:/x.cala"),
        "matched by its own name and share, dev or not"
    );
}

/// The publish gate and the advisory preview panel must ask the SAME question.
/// They already drifted once — the panel ignored the workspace entirely.
///
/// SABOTAGE: inline a hand-rolled `.package_name ==` walk back into either.
#[test]
fn the_publish_gate_and_the_advisory_panel_ask_the_same_question() {
    let publish = body_of("pub fn calp_publish(");
    let gates = body_of("fn evaluate_push_gates(");
    assert!(publish.contains("subscribes_to("), "calp_publish stopped using the shared predicate");
    assert!(gates.contains("subscribes_to("), "evaluate_push_gates stopped using it");
}

// ---------------------------------------------------------------------------
// E. Checkout is ADDITIVE
// ---------------------------------------------------------------------------
//
// Reported from live testing, twice over. First as an error: subscribe, rename
// the pulled sheet, then "Open application for editing" on the SAME application
// -> "Failed to switch sheet: Sheet index 1 out of range". Then as a complaint
// that is really the same defect from the other side: "when I open an
// application for editing it discards the sheet I am working with".
//
// Checkout used to REPLACE the document — it reset the document-scoped stores
// and cleared the sheet vectors, so the price of LOOKING at an application was
// whatever you had open, and the tab strip (which never heard about it) kept
// pointing at sheets the backend no longer had.
//
// These are source-text guards. A behavioural test of `calp_checkout` needs a
// signed workspace on disk and a Tauri `Window`; what actually regressed here is
// the SHAPE of the command, and that is what these pin.

/// SABOTAGE: put `crate::persistence::reset_document_scoped_stores(...)` back
/// into `calp_checkout`.
#[test]
fn checkout_does_not_tear_the_open_document_down() {
    let body = body_of("pub fn calp_checkout(");
    assert!(
        !body.contains("reset_document_scoped_stores"),
        "checkout tore the document down again — the user's open sheet is not the \
         price of opening an application for editing"
    );
}

/// The other half of "additive": the sheet vectors are appended to, never
/// truncated. `materialize_pull_result` pushes; nothing here may clear first.
///
/// SABOTAGE: add `state.sheet_names.write(&effect).unwrap().clear();` to
/// `calp_checkout`.
#[test]
fn checkout_does_not_clear_the_sheet_vectors() {
    let body = body_of("pub fn calp_checkout(");
    for store in ["grids", "sheet_names", "sheet_ids"] {
        assert!(
            !body.contains(&format!("{}.write", store)),
            "calp_checkout writes `{}` directly; the sheets must arrive only by \
             append, through materialize_pull_result",
            store
        );
    }
}

/// A workbook holds ONE role per application. Additive checkout makes the
/// overlap reachable — you can now be a subscriber AND ask to open the same
/// application for editing — so the refusal has to exist and has to name the
/// remedy.
///
/// SABOTAGE: delete any one of the three `return Err(format!("CALP_CHECKOUT_...`
/// arms.
#[test]
fn checkout_refuses_a_workbook_that_already_has_a_role() {
    let body = body_of("pub fn calp_checkout(");
    for code in [
        "CALP_CHECKOUT_ALREADY_OPEN",
        "CALP_CHECKOUT_ALREADY_LINKED",
        "CALP_CHECKOUT_IS_SUBSCRIBER",
    ] {
        assert!(body.contains(code), "the {} gate is gone", code);
    }
    // The subscriber gate must ask the SHARED question — name AND workspace —
    // not a hand-rolled name comparison, which is the bug section D exists for.
    assert!(
        body.contains("subscribes_to("),
        "checkout hand-rolled its own subscriber check instead of the shared predicate"
    );
}

/// The landing index comes from the BACKEND. The subscribe dialog once derived
/// it as `sheets.length - sheetsPulled`, which is arithmetic over a list that
/// OMITS object-backed sheets — with a floating range present it names the wrong
/// sheet. Checkout must not re-learn that lesson.
///
/// SABOTAGE: drop `first_sheet_index` from the `CheckoutResponse` construction.
#[test]
fn checkout_reports_which_sheet_to_land_on() {
    let body = body_of("pub fn calp_checkout(");
    assert!(
        body.contains("first_sheet_index: materialized.first_pulled_sheet_index"),
        "checkout stopped reporting the landing index, so the frontend has to \
         guess it from the sheet list"
    );
}

/// The workbook keeps its FILE. Checkout used to clear the path because the
/// document it produced was wholly new; it now joins a document the user may
/// have opened from disk, and clearing the path would turn their next Ctrl+S
/// into a Save As for a file they never closed.
///
/// SABOTAGE: re-add `*file_state.current_path.lock().unwrap() = None;` to
/// `calp_checkout`. The field is `FileState::current_path` — the guard names the
/// field, not the command `get_current_file_path`, because a guard that only
/// matches a spelling nobody would write has no teeth.
#[test]
fn checkout_leaves_the_open_file_alone() {
    let body = body_of("pub fn calp_checkout(");
    assert!(
        !body.contains("current_path"),
        "checkout touched the file path again"
    );
}

// ---------------------------------------------------------------------------
// F. Provenance reports the ROLE, not merely "came from an application"
// ---------------------------------------------------------------------------
//
// Two ways a sheet is not simply yours, pointing in OPPOSITE directions on the
// one gesture that matters:
//
//   subscribed  — somebody else's; a publish leaves it behind.
//   workingCopy — the application itself; a push CARRIES it.
//
// Saying "not yours" without saying which is worse than saying nothing. This is
// per-sheet only because checkout became additive; before that a working copy
// was the whole document and the status-bar chip answered it once.

/// SABOTAGE: report `SHEET_ROLE_SUBSCRIBED` for both branches. Every
/// working-copy tab would then wear the subscribed mark, claiming a push leaves
/// it behind when a push is exactly what carries it.
#[test]
fn provenance_distinguishes_a_subscribed_sheet_from_the_applications_own() {
    let state = workbook_with_sheets(4);
    // 1 is subscribed from someone else; 2 is the application this workbook is
    // the working copy of; 0 and 3 are the user's own.
    subscribe_sheet(&state, 1, "vendor-kpis", r"\share\theirs");
    make_working_copy(&state, &[2], "sales", r"\share\ws");

    let rows = crate::calp_commands::sheet_provenance_rows(&state).unwrap();
    assert_eq!(rows.len(), 2, "only the two application sheets are reported");

    let subscribed = rows.iter().find(|r| r.sheet_index == 1).expect("sheet 1 missing");
    assert_eq!(subscribed.role, "subscribed");
    assert_eq!(subscribed.package_name, "vendor-kpis");

    let working = rows.iter().find(|r| r.sheet_index == 2).expect("sheet 2 missing");
    assert_eq!(working.role, "workingCopy");
    assert_eq!(working.package_name, "sales");
    assert_eq!(working.resolved_version, "1.0.0", "the LINK's base version");
}

/// The working-copy rows are exactly the ones a push carries — same source, the
/// link's `base_sheets`. A tab marked "the application's" that a push then leaves
/// behind is a badge that lies about the only thing it is consulted for.
///
/// SABOTAGE: mark every sheet in a working copy, ignoring `base_sheets`.
#[test]
fn the_marked_working_copy_sheets_are_the_ones_a_push_carries() {
    let state = workbook_with_sheets(4);
    make_working_copy(&state, &[1, 3], "sales", r"\share\ws");

    let marked: Vec<usize> = crate::calp_commands::sheet_provenance_rows(&state)
        .unwrap()
        .iter()
        .filter(|r| r.role == "workingCopy")
        .map(|r| r.sheet_index)
        .collect();
    let published = resolve_positions(&state, "report", Vec::new())
        .unwrap()
        .indices;
    assert_eq!(marked, published, "the mark and the push must name the same sheets");
}

/// The sheet id reported is the LOCAL one — the key into THIS workbook. For a
/// subscribed sheet the ledger holds two different uuids and only one of them is
/// a key here; for a working copy they coincide, and that coincidence must not be
/// what the code relies on.
///
/// SABOTAGE: report `package_sheet_id` in the subscribed branch. The tab badge
/// keys on `sheetId`, so every subscribed sheet would silently stop being marked.
#[test]
fn provenance_reports_the_local_sheet_id() {
    let state = workbook_with_sheets(3);
    subscribe_sheet(&state, 1, "vendor-kpis", r"\share\theirs");

    let rows = crate::calp_commands::sheet_provenance_rows(&state).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].sheet_id, sheet_id_at(&state, 1).to_string());
}

/// A standalone workbook reports nothing at all — no link, no subscriptions.
///
/// SABOTAGE: build `base_sheets` from an empty link as "every sheet" rather than
/// "no sheets". Every tab in every ordinary workbook would wear a mark.
#[test]
fn a_standalone_workbook_has_no_provenance_rows() {
    let state = workbook_with_sheets(3);
    assert!(crate::calp_commands::sheet_provenance_rows(&state).unwrap().is_empty());
}

/// THE OTHER HALF OF "ONE ROLE PER APPLICATION". `calp_checkout` refused a
/// subscriber from 2026-08-31; nothing refused the reverse, so a developer could
/// subscribe to the very application their workbook was the working copy of and
/// end up holding the same sheets twice — once to push, once to refresh over.
///
/// The predicate is `WorkingCopyLink::targets`, which compares name AND
/// workspace, so two teams' identically named applications on different shares
/// stay distinct. SABOTAGE: delete the gate, or weaken `targets` to a name
/// comparison (which section D already proves reds `a_different_workspace_...`).
#[test]
fn subscribing_to_the_application_you_are_the_working_copy_of_is_refused() {
    let state = workbook_with_sheets(2);
    make_working_copy(&state, &[1], "sales", r"\share\ws");
    let link = state.working_copy_link.read().unwrap();
    let link = link.as_ref().expect("the harness must have written a link");

    // Same application, same share, spelled differently: still the same application.
    assert!(link.targets(r"\share\ws\", "sales"));
    // A different share is a different application, and subscribing is fine.
    assert!(!link.targets(r"\other\ws", "sales"));
    // A different application on the same share, likewise.
    assert!(!link.targets(r"\share\ws", "costs"));
}

/// And the gate is WIRED — the predicate being right is worth nothing if the
/// command never asks it. Placed BEFORE the `DocumentEffect`, which dirties at
/// construction: a refusal must not leave the document modified.
///
/// SABOTAGE: move the gate below `DocumentEffect::mutates(&file_state)`.
#[test]
fn the_pull_role_gate_runs_before_the_document_is_dirtied() {
    let body = body_of("pub fn calp_pull(");
    let gate = body
        .find("CALP_PULL_IS_WORKING_COPY")
        .expect("calp_pull no longer refuses a subscribe from its own working copy");
    let dirties = body
        .find("DocumentEffect::mutates")
        .expect("calp_pull no longer constructs its effect");
    assert!(
        gate < dirties,
        "the role gate must refuse BEFORE the effect is constructed — `mutates` \
         dirties at construction, so a refusal below it marks the workbook \
         modified for a subscribe that never happened"
    );
}

// ---------------------------------------------------------------------------
// F. Objects travel with their SOURCES (canvas M5)
// ---------------------------------------------------------------------------

fn new_entity() -> identity::EntityId {
    identity::EntityId::from_bytes(identity::generate_uuid_v7())
}

/// A chart on sheet `host` whose data source names sheet `source` by id.
fn chart_on(state: &AppState, host: usize, source: usize, name: &str) {
    let seed = crate::document_effect::test_seed_effect();
    let source_id = sheet_id_at(state, source);
    state.charts.write(&seed).unwrap().push(crate::api_types::ChartEntry {
        id: new_entity(),
        sheet_index: host,
        spec_json: serde_json::json!({
            "chartId": 1,
            "name": name,
            "sheetIndex": host,
            "spec": { "data": {
                "sheetIndex": source, "sheetId": source_id.to_string(),
                "startRow": 0, "startCol": 0, "endRow": 4, "endCol": 1
            } }
        })
        .to_string(),
    });
}

/// Append an OBJECT-backed sheet through the one shared push-list, with the
/// visibility vector padded for the sheets before it.
fn add_object_sheet(state: &AppState, name: &str) -> usize {
    let effect = crate::document_effect::test_seed_effect();
    let mut sheet_names = state.sheet_names.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    let mut freeze_configs = state.freeze_configs.write(&effect).unwrap();
    let mut tab_colors = state.tab_colors.write(&effect).unwrap();
    let mut sheet_visibility = state.sheet_visibility.write(&effect).unwrap();
    let mut all_column_widths = state.all_column_widths.write(&effect).unwrap();
    let mut all_row_heights = state.all_row_heights.write(&effect).unwrap();
    crate::sheets::append_sheet_stores(
        state,
        &effect,
        name.to_string(),
        crate::sheets::OBJECT_SHEET_VISIBILITY,
        ::persistence::SheetKind::Worksheet,
        &mut sheet_names,
        &mut grids,
        &mut freeze_configs,
        &mut tab_colors,
        &mut sheet_visibility,
        &mut all_column_widths,
        &mut all_row_heights,
    )
    .0
}

fn resolve(
    state: &AppState,
    requested: Vec<usize>,
    links: &crate::calp_commands::FilterObjectLinks,
) -> crate::calp_commands::PublishSelection {
    crate::calp_commands::resolve_publish_sheet_indices(
        state,
        "report",
        &RequestedSheets::ByPosition(requested),
        "published",
        links,
    )
    .unwrap()
}

/// The selection for a request BY ID: the stable ids of the sheets at
/// `positions` now, as the push dialog and the subscriber diff send them --
/// the one request that may name a floating range's backing sheet (the
/// subscriber diff sends the ids of the backing sheets a subscription pulled).
fn resolve_ids(state: &AppState, positions: &[usize]) -> crate::calp_commands::PublishSelection {
    let ids: Vec<String> = positions.iter().map(|&i| sheet_id_at(state, i).to_string()).collect();
    crate::calp_commands::resolve_publish_sheet_indices(
        state,
        "report",
        &RequestedSheets::ById(ids),
        "published",
        &Default::default(),
    )
    .unwrap()
}

/// A chart on a published sheet brings the sheet it reads. Without it the
/// chart arrives saying its source sheet no longer exists -- and nothing told
/// the author, who ticked only the dashboard.
///
/// SABOTAGE: drop the chart walk from the selection's fixpoint loop.
#[test]
fn publishing_a_charts_sheet_brings_the_sheet_it_reads() {
    let state = workbook_with_sheets(3);
    chart_on(&state, 0, 2, "Revenue");

    let selection = resolve(&state, vec![0], &Default::default());
    assert_eq!(selection.indices, vec![0, 2]);
    assert_eq!(selection.auto_included, vec!["Sheet3".to_string()], "and says why it is leaving");
    assert!(selection.source_warnings.is_empty());

    // The report carries the disclosure line for it.
    let (with_row, _) = crate::calp_commands::subscribed_sheet_report_rows(&selection);
    assert!(with_row.is_none(), "not a subscribed sheet -- that row stays quiet");
}

/// The two expansions feed each other and run to a FIXPOINT: a chart's source
/// sheet that hosts a floating range brings that range's backing sheet too --
/// and the selection lists user sheets before object sheets, the order the
/// subscriber's pull then appends them in.
///
/// SABOTAGE: run the floating-range expansion once, before the chart walk,
/// instead of inside the loop.
#[test]
fn a_chart_source_that_hosts_a_floating_range_brings_its_backing_sheet_too() {
    let state = workbook_with_sheets(2);
    chart_on(&state, 0, 1, "Revenue");
    let backing = add_object_sheet(&state, "Float1");
    {
        let seed = crate::document_effect::test_seed_effect();
        let row = crate::persistence::saved_floating_range_to_row(&::persistence::SavedFloatingRange {
            id: new_entity(),
            backing_sheet_id: sheet_id_at(&state, backing),
            host_sheet_id: sheet_id_at(&state, 1),
            x: 0.0,
            y: 0.0,
            rotation: 0.0,
            pin_to_grid: false,
            row_count: 1,
            col_count: 1,
            col_widths: HashMap::new(),
            row_heights: HashMap::new(),
            show_title: true,
            show_column_headers: true,
            show_row_headers: true,
            container: None,
            hidden_rows: Vec::new(),
            hidden_cols: Vec::new(),
        });
        state.floating_ranges.write(&seed).unwrap().push(row);
    }
    // A second floating range on the DASHBOARD, so the backing expansion runs
    // before the chart walk and a naive order would put an object sheet first.
    let own_backing = add_object_sheet(&state, "Float2");
    {
        let seed = crate::document_effect::test_seed_effect();
        let row = crate::persistence::saved_floating_range_to_row(&::persistence::SavedFloatingRange {
            id: new_entity(),
            backing_sheet_id: sheet_id_at(&state, own_backing),
            host_sheet_id: sheet_id_at(&state, 0),
            x: 0.0,
            y: 0.0,
            rotation: 0.0,
            pin_to_grid: false,
            row_count: 1,
            col_count: 1,
            col_widths: HashMap::new(),
            row_heights: HashMap::new(),
            show_title: true,
            show_column_headers: true,
            show_row_headers: true,
            container: None,
            hidden_rows: Vec::new(),
            hidden_cols: Vec::new(),
        });
        state.floating_ranges.write(&seed).unwrap().push(row);
    }

    let selection = resolve(&state, vec![0], &Default::default());
    let mut sorted = selection.indices.clone();
    sorted.sort();
    assert_eq!(sorted, vec![0, 1, backing, own_backing], "the fixpoint reached both backing sheets");
    let first_object = selection
        .indices
        .iter()
        .position(|&i| i == backing || i == own_backing)
        .unwrap();
    assert!(
        selection.indices[..first_object].len() == 2
            && selection.indices[first_object..].iter().all(|&i| i == backing || i == own_backing),
        "user sheets first, object sheets last: {:?}",
        selection.indices
    );
    assert_eq!(
        selection.auto_included,
        vec!["Sheet2".to_string()],
        "only the chart's SOURCE is disclosed as added -- a backing sheet is part of its object"
    );
}

/// A slicer's TABLE travels with the table's sheet, and a timeline's PIVOT
/// with the pivot's output sheet (a pulled pivot materializes where its
/// destination sheet arrived). Both come along.
///
/// SABOTAGE: drop the `filter_links` walk from the fixpoint loop.
#[test]
fn a_slicers_table_sheet_and_a_timelines_pivot_sheet_come_along() {
    let state = workbook_with_sheets(4);
    let seed = crate::document_effect::test_seed_effect();
    let table_id = new_entity();
    let table = crate::persistence::saved_table_to_table_at(
        &::persistence::SavedTable {
            id: table_id,
            name: "Sales".to_string(),
            sheet_id: sheet_id_at(&state, 2),
            start_row: 0,
            start_col: 0,
            end_row: 9,
            end_col: 2,
            columns: Vec::new(),
            style_options: ::persistence::SavedTableStyleOptions {
                banded_rows: true,
                banded_columns: false,
                header_row: true,
                total_row: false,
                first_column: false,
                last_column: false,
                show_filter_button: true,
            },
            style_name: "TableStyleMedium2".to_string(),
        },
        2,
    );
    state.tables.write(&seed).unwrap().entry(2).or_default().insert(table_id, table);
    let pivot_id = new_entity();
    state.protected_regions.lock().unwrap().push(crate::ProtectedRegion {
        id: "pivot-1".to_string(),
        region_type: "pivot".to_string(),
        owner_id: pivot_id,
        sheet_index: 3,
        start_row: 0,
        start_col: 0,
        end_row: 5,
        end_col: 3,
        reserved_only: false,
    });
    let links = crate::calp_commands::FilterObjectLinks {
        objects: vec![
            crate::calp_commands::FilterObjectLink {
                kind: "Slicer",
                name: "Region".to_string(),
                sheet_index: 0,
                tables: vec![table_id],
                pivots: Vec::new(),
            },
            crate::calp_commands::FilterObjectLink {
                kind: "Timeline",
                name: "Dates".to_string(),
                sheet_index: 0,
                tables: Vec::new(),
                pivots: vec![pivot_id],
            },
            // An object on an UNPUBLISHED sheet brings nothing.
            crate::calp_commands::FilterObjectLink {
                kind: "Slicer",
                name: "Elsewhere".to_string(),
                sheet_index: 1,
                tables: vec![table_id],
                pivots: Vec::new(),
            },
        ],
        // No pivot-store snapshot: the timeline's pivot is found through its
        // OUTPUT region alone, the fallback for a pivot the store does not hold.
        pivots: Vec::new(),
    };
    let selection = resolve(&state, vec![0], &links);
    assert_eq!(selection.indices, vec![0, 2, 3]);
}

/// The snapshot reads BOTH object stores: a slicer's own source and its report
/// connections, a timeline's pivot and its connected pivots.
#[test]
fn the_filter_object_snapshot_reads_slicers_and_timelines() {
    let slicer_state = crate::slicer::SlicerState::new();
    let timeline_state = crate::timeline_slicer::TimelineSlicerState::new();
    let seed = crate::document_effect::test_seed_effect();
    let (table_id, pivot_a, pivot_b) = (new_entity(), new_entity(), new_entity());
    let saved = ::persistence::SavedSlicer {
        id: new_entity(),
        name: "Region".to_string(),
        header_text: None,
        sheet_id: identity::SheetId::from_bytes(identity::generate_uuid_v7()),
        x: 0.0,
        y: 0.0,
        width: 180.0,
        height: 220.0,
        source_type: ::persistence::SavedSlicerSourceType::Table,
        cache_source_id: table_id,
        field_name: "Region".to_string(),
        selected_items: None,
        show_header: true,
        columns: 1,
        style_preset: "SlicerStyleLight1".to_string(),
        selection_mode: ::persistence::SavedSlicerSelectionMode::default(),
        hide_no_data: false,
        indicate_no_data: true,
        sort_no_data_last: true,
        force_selection: false,
        show_select_all: false,
        arrangement: ::persistence::SavedSlicerArrangement::default(),
        rows: 0,
        item_gap: 4.0,
        autogrid: true,
        item_padding: 0.0,
        button_radius: 2.0,
        computed_properties: Vec::new(),
        connected_sources: vec![::persistence::SavedSlicerConnection {
            source_type: ::persistence::SavedSlicerSourceType::Pivot,
            source_id: pivot_a,
        }],
        filter_level: 1,
        data_source_id: None,
        container: None,
    };
    let slicer = crate::persistence::saved_slicer_to_slicer_at(&saved, 2);
    slicer_state.slicers.write(&seed).unwrap().insert(slicer.id, slicer);
    let timeline = crate::persistence::saved_timeline_to_timeline_at(
        &::persistence::SavedTimelineSlicer {
            id: new_entity(),
            name: "Dates".to_string(),
            header_text: None,
            sheet_id: identity::SheetId::from_bytes(identity::generate_uuid_v7()),
            x: 0.0,
            y: 0.0,
            width: 300.0,
            height: 120.0,
            source_type: ::persistence::SavedTimelineSourceType::Pivot,
            source_id: pivot_a,
            field_name: "OrderDate".to_string(),
            level: ::persistence::SavedTimelineLevel::Months,
            selection_start: None,
            selection_end: None,
            show_header: true,
            show_level_selector: true,
            show_scrollbar: true,
            style_preset: "TimelineStyleLight1".to_string(),
            connected_pivot_ids: vec![pivot_a, pivot_b],
            container: None,
        },
        1,
    );
    timeline_state.timelines.write(&seed).unwrap().insert(timeline.id, timeline);

    let pivot_state = crate::pivot::types::PivotState::new();
    let links = crate::calp_commands::FilterObjectLinks::snapshot(
        &slicer_state,
        &timeline_state,
        &pivot_state,
    )
    .unwrap();
    assert_eq!(links.objects.len(), 2);
    assert!(links.pivots.is_empty(), "an empty pivot store snapshots no anchors");
    let timeline_link = &links.objects[0]; // sheet 1 sorts first
    assert_eq!((timeline_link.kind, timeline_link.sheet_index), ("Timeline", 1));
    assert_eq!(timeline_link.pivots, vec![pivot_a, pivot_b], "deduplicated, source first");
    let slicer_link = &links.objects[1];
    assert_eq!((slicer_link.kind, slicer_link.sheet_index), ("Slicer", 2));
    assert_eq!(slicer_link.tables, vec![table_id]);
    assert_eq!(slicer_link.pivots, vec![pivot_a], "report connections count too");
}

/// The publish dialog's sheet list says which sheets are canvases, read with
/// the same `.get(i)` idiom as the sheet id: a short kinds vector reads as a
/// worksheet, never as a panic or a neighbour's kind.
#[test]
fn the_publish_dialog_list_says_which_sheets_are_canvases() {
    let state = workbook_with_sheets(3);
    {
        let seed = crate::document_effect::test_seed_effect();
        let mut kinds = state.sheet_kinds.write(&seed).unwrap();
        kinds.truncate(1);
        kinds.push(::persistence::SheetKind::new_canvas()); // sheet 1; sheet 2 has NO slot
    }
    let selection = resolve(&state, Vec::new(), &Default::default());
    let rows = crate::calp_commands::publish_preview_sheet_list(&state, &selection).unwrap();
    let kinds: Vec<&str> = rows.iter().map(|r| r.kind.as_str()).collect();
    assert_eq!(kinds, vec!["worksheet", "canvas", "worksheet"]);
}

/// A WORKING COPY never gains a sheet as a side effect: a chart's source that
/// is not part of the application's base version is WARNED about, not added --
/// "a sheet you add is published by ticking it". A source that IS a base sheet
/// still comes along.
///
/// SABOTAGE: drop the `outside_base` check (the author's own Sheet3 ships).
#[test]
fn a_working_copy_warns_instead_of_adding_a_non_base_source_sheet() {
    let state = workbook_with_sheets(3);
    make_working_copy(&state, &[0, 1], "sales", r"\\share\ws");
    chart_on(&state, 0, 2, "Private");
    chart_on(&state, 0, 1, "Shared");

    let selection = resolve(&state, vec![0], &Default::default());
    assert_eq!(selection.indices, vec![0, 1], "the base source joins; the author's own does not");
    assert_eq!(selection.auto_included, vec!["Sheet2".to_string()]);
    assert_eq!(selection.source_warnings.len(), 1, "{:?}", selection.source_warnings);
    let warning = &selection.source_warnings[0];
    assert!(warning.contains("\"Sheet3\""), "names the sheet: {warning}");
    assert!(warning.contains("chart \"Private\""), "and the object that reads it: {warning}");

    // Ticking it is the way in, and then nothing is said.
    let ticked = resolve(&state, vec![0, 2], &Default::default());
    assert!(ticked.indices.contains(&2));
    assert!(ticked.source_warnings.is_empty());
}

// ---------------------------------------------------------------------------
// G. The M5 review: pivots, subscribed sources, backing sheets, pruned pivots
// ---------------------------------------------------------------------------

/// A chart whose data source is a PIVOT (`{type: "pivot", pivotId}`).
fn pivot_chart_on(state: &AppState, host: usize, pivot: identity::EntityId, name: &str) {
    let seed = crate::document_effect::test_seed_effect();
    state.charts.write(&seed).unwrap().push(crate::api_types::ChartEntry {
        id: new_entity(),
        sheet_index: host,
        spec_json: serde_json::json!({
            "chartId": 1,
            "name": name,
            "sheetIndex": host,
            "spec": { "data": { "type": "pivot", "pivotId": pivot.to_string() } }
        })
        .to_string(),
    });
}

/// A pivot's anchors as the snapshot would record them.
fn anchors(
    id: identity::EntityId,
    name: &str,
    destination: &str,
    source: Option<&str>,
) -> crate::calp_commands::PivotAnchors {
    crate::calp_commands::PivotAnchors {
        id,
        name: name.to_string(),
        destination_sheet: Some(destination.to_string()),
        source_sheet: source.map(str::to_string),
    }
}

fn pivot_links(pivots: Vec<crate::calp_commands::PivotAnchors>) -> crate::calp_commands::FilterObjectLinks {
    crate::calp_commands::FilterObjectLinks { objects: Vec::new(), pivots }
}

fn sorted(mut v: Vec<usize>) -> Vec<usize> {
    v.sort();
    v
}

/// A PIVOT CHART brings its pivot's two sheets -- the destination the pivot is
/// drawn on and the grid it reads -- because the pivot travels only when both
/// do. The chart walk used to see no sheet at all in a pivot source, so the
/// author who ticked only the dashboard shipped a chart whose pivot the
/// assembly then pruned, with no warning anywhere.
///
/// The anchors are matched case-insensitively (the stored `sheet2` is the tab
/// `Sheet2`), the rule the pruning uses.
///
/// SABOTAGE: drop the `for pivot in pivots` walk from the chart loop of
/// `resolve_publish_sheet_indices` -- the selection stays `[0]`.
#[test]
fn a_pivot_charts_pivot_travels_with_both_its_sheets() {
    let state = workbook_with_sheets(4); // Sheet1 dashboard, Sheet2 pivots, Sheet3 data, Sheet4 unrelated
    let pivot = new_entity();
    pivot_chart_on(&state, 0, pivot, "Revenue chart");
    let links = pivot_links(vec![anchors(pivot, "Revenue", "sheet2", Some("Sheet3"))]);

    let selection = resolve(&state, vec![0], &links);
    assert_eq!(sorted(selection.indices.clone()), vec![0, 1, 2], "{:?}", selection.indices);
    let mut added = selection.auto_included.clone();
    added.sort();
    assert_eq!(added, vec!["Sheet2".to_string(), "Sheet3".to_string()], "and says why they leave");
    assert!(selection.source_warnings.is_empty());
}

/// A pivot on a PUBLISHED sheet needs the sheet it reads (a canvas page's pivot
/// shows data that lives elsewhere), and a TIMELINE that filters a pivot brings
/// both of its sheets -- through the store's anchors, with no output region to
/// go on.
///
/// SABOTAGE: drop the "a PIVOT on a selected sheet" loop -- the first
/// assertion stays `[1]`.
#[test]
fn a_pivots_source_sheet_follows_its_destination_and_its_filters() {
    let state = workbook_with_sheets(4);
    let pivot = new_entity();
    let mut links = pivot_links(vec![anchors(pivot, "Revenue", "Sheet2", Some("Sheet3"))]);

    let on_its_page = resolve(&state, vec![1], &links);
    assert_eq!(sorted(on_its_page.indices.clone()), vec![1, 2]);
    assert_eq!(on_its_page.auto_included, vec!["Sheet3".to_string()]);

    links.objects.push(crate::calp_commands::FilterObjectLink {
        kind: "Timeline",
        name: "Dates".to_string(),
        sheet_index: 0,
        tables: Vec::new(),
        pivots: vec![pivot],
    });
    let from_the_dashboard = resolve(&state, vec![0], &links);
    assert_eq!(sorted(from_the_dashboard.indices), vec![0, 1, 2]);

    // A BI pivot reads the embedded model: its destination comes, nothing else.
    let bi = pivot_links(vec![anchors(pivot, "Revenue", "Sheet2", None)]);
    pivot_chart_on(&state, 3, pivot, "BI chart");
    assert_eq!(sorted(resolve(&state, vec![3], &bi).indices), vec![1, 3]);
}

/// The working-copy exception covers BOTH pivot sheets: a base sheet comes
/// along, the author's own non-base sheet is withheld and named.
#[test]
fn a_working_copy_withholds_a_pivots_non_base_source_sheet() {
    let state = workbook_with_sheets(3);
    make_working_copy(&state, &[0, 1], "sales", r"\\share\ws");
    let pivot = new_entity();
    pivot_chart_on(&state, 0, pivot, "Revenue chart");
    let links = pivot_links(vec![anchors(pivot, "Revenue", "Sheet2", Some("Sheet3"))]);

    let selection = resolve(&state, vec![0], &links);
    assert_eq!(selection.indices, vec![0, 1], "the base destination joins; the private source does not");
    assert_eq!(selection.source_warnings.len(), 1, "{:?}", selection.source_warnings);
    let warning = &selection.source_warnings[0];
    assert!(warning.contains("\"Sheet3\"") && warning.contains("chart \"Revenue chart\""), "{warning}");
}

/// The snapshot reads the PIVOT store: both anchors, the source falling back to
/// the destination exactly as `collect_pivot_definitions` does, and none at all
/// for a BI pivot.
#[test]
fn the_snapshot_reads_each_pivots_two_anchors() {
    let pivot_state = crate::pivot::types::PivotState::new();
    let seed = crate::document_effect::test_seed_effect();
    let (cross, same) = (new_entity(), new_entity());
    {
        let mut tables = pivot_state.pivot_tables.write(&seed).unwrap();
        let mut def = pivot_engine::PivotDefinition::new(cross, (0, 0), (9, 2));
        def.name = Some("Revenue".to_string());
        def.destination_sheet = Some("Report".to_string());
        def.source_sheet = Some("Data".to_string());
        tables.insert(cross, (def, pivot_engine::PivotCache::new(cross, 3)));
        let mut def = pivot_engine::PivotDefinition::new(same, (0, 0), (9, 2));
        def.destination_sheet = Some("Report".to_string());
        tables.insert(same, (def, pivot_engine::PivotCache::new(same, 3)));
    }
    let links = crate::calp_commands::FilterObjectLinks::snapshot(
        &crate::slicer::SlicerState::new(),
        &crate::timeline_slicer::TimelineSlicerState::new(),
        &pivot_state,
    )
    .unwrap();
    let find = |id| links.pivots.iter().find(|p| p.id == id).expect("snapshotted");
    let c = find(cross);
    assert_eq!((c.name.as_str(), c.destination_sheet.as_deref(), c.source_sheet.as_deref()),
        ("Revenue", Some("Report"), Some("Data")));
    let s = find(same);
    assert_eq!(s.source_sheet.as_deref(), Some("Report"), "a same-sheet pivot reads its destination");
    assert_eq!(s.name, same.to_string(), "an unnamed pivot is named by its id");
}

/// A SUBSCRIBED sheet is another publisher's content. The default withholds
/// it; the expansion used to add it straight back whenever one of the author's
/// charts read from it -- signed into this application under the author's key,
/// impossible to untick, and reported as a sheet "you ticked". It is now
/// withheld with a warning naming the object and the application, and an
/// explicit tick still publishes it.
///
/// SABOTAGE: delete the `provenance.is_subscribed(idx) && !requested_explicitly
/// .contains(&idx)` branch from the add loop -- Sheet3 ships in the default.
#[test]
fn a_subscribed_source_sheet_is_withheld_not_dragged_along() {
    let state = workbook_with_sheets(3);
    subscribe_sheet(&state, 2, "prices", r"\\share\a");
    chart_on(&state, 0, 2, "Margin");

    for requested in [Vec::new(), vec![0]] {
        let selection = resolve(&state, requested.clone(), &Default::default());
        assert!(!selection.indices.contains(&2), "{requested:?}: {:?}", selection.indices);
        assert!(selection.included_subscribed.is_empty(), "nothing the author did not tick");
        assert_eq!(selection.source_warnings.len(), 1, "{:?}", selection.source_warnings);
        let warning = &selection.source_warnings[0];
        assert!(
            warning.contains("\"Sheet3\"")
                && warning.contains("application \"prices\"")
                && warning.contains("chart \"Margin\"")
                && warning.contains("republish it deliberately"),
            "{warning}"
        );
        let (included, excluded) = crate::calp_commands::subscribed_sheet_report_rows(&selection);
        assert!(included.is_none(), "the 'you ticked' row must not claim a tick nobody made");
        assert!(excluded.is_some_and(|row| row.detail.contains("Sheet3")));
    }

    // Ticking it is the deliberate act, and it is disclosed as one.
    let ticked = resolve(&state, vec![0, 2], &Default::default());
    assert!(ticked.indices.contains(&2));
    assert!(ticked.source_warnings.is_empty());
    assert_eq!(ticked.included_subscribed.len(), 1);
}

/// A floating range with its host in `host` backed by a new object sheet.
fn floating_range_on(state: &AppState, host: usize, name: &str) -> usize {
    let backing = add_object_sheet(state, name);
    let seed = crate::document_effect::test_seed_effect();
    let row = crate::persistence::saved_floating_range_to_row(&::persistence::SavedFloatingRange {
        id: new_entity(),
        backing_sheet_id: sheet_id_at(state, backing),
        host_sheet_id: sheet_id_at(state, host),
        x: 0.0,
        y: 0.0,
        rotation: 0.0,
        pin_to_grid: false,
        row_count: 1,
        col_count: 1,
        col_widths: HashMap::new(),
        row_heights: HashMap::new(),
        show_title: true,
        show_column_headers: true,
        show_row_headers: true,
        container: None,
        hidden_rows: Vec::new(),
        hidden_cols: Vec::new(),
    });
    state.floating_ranges.write(&seed).unwrap().push(row);
    backing
}

/// UNTICKING A PAGE WITHHOLDS ITS FLOATING RANGE'S CELLS. The dialog lists user
/// sheets only but seeded its selection from the default list, backing indices
/// included, so unticking the host left the backing index in the request -- and
/// the range's cells shipped as an orphaned hidden sheet. An object sheet now
/// joins only through its owner, whatever the request says; a chart reading a
/// range's cells brings the range's HOST.
///
/// BY POSITION the backing sheet cannot be named at all any more (review round
/// 11): no list a caller reads shows it, so `[1, backing]` is refused as an
/// index the workbook does not have -- never cleaned up in silence, which is
/// how a script's off-by-one into the object tail published the wrong sheets
/// under the author's key. BY ID it still can be -- the subscriber diff sends
/// the ids of the backing sheets a subscription pulled -- and there the
/// backing sheet stays home without its host.
///
/// SABOTAGE: restore `requested` verbatim in the explicit branch AND drop the
/// final `claimed_backing` retain -- the backing sheet survives the ids of
/// `[Sheet2, backing]`. Or let the `ByPosition` branch of
/// `resolve_publish_sheet_indices` pass an object sheet -- `[1, backing]`
/// resolves again.
#[test]
fn an_unticked_hosts_backing_sheet_stays_home() {
    use crate::calp_commands::CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE;
    let state = workbook_with_sheets(2);
    let backing = floating_range_on(&state, 0, "Float1");

    let default = resolve(&state, Vec::new(), &Default::default());
    assert_eq!(sorted(default.indices), vec![0, 1, backing]);

    // Page (Sheet1) unticked, its backing sheet still in a request BY POSITION:
    // refused as a position no list shows, and counted as the lists count.
    let refusal = resolve_positions(&state, "report", vec![1, backing])
        .map(|s| s.indices)
        .expect_err("a request naming the backing sheet by position resolved");
    assert_eq!(
        refusal,
        format!(
            "{CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE}: There is no sheet at index {backing}: the workbook has 2 sheets \
             (indexes 0 to 1). Nothing was published; read the sheet list again and choose the sheets again."
        )
    );

    // The same request BY ID -- Sheet2 and the backing sheet: the backing
    // sheet does not ship without its host.
    let unticked = resolve_ids(&state, &[1, backing]);
    assert_eq!(unticked.indices, vec![1], "the backing sheet must not ship without its range");
    assert!(unticked.ids.backing.is_empty(), "a backing sheet travels without its host: {:?}", unticked.ids);

    let host_only = resolve(&state, vec![0], &Default::default());
    assert_eq!(sorted(host_only.indices), vec![0, backing], "it still travels WITH its host");
    let host_by_id = resolve_ids(&state, &[0]);
    assert_eq!(sorted(host_by_id.indices), vec![0, backing], "by id, it still travels WITH its host");

    // A chart on Sheet2 reading the range's cells brings the range's owner.
    chart_on(&state, 1, backing, "From the range");
    let through_owner = resolve(&state, vec![1], &Default::default());
    assert_eq!(sorted(through_owner.indices), vec![0, 1, backing]);
    assert_eq!(through_owner.auto_included, vec!["Sheet1".to_string()], "the OWNER is disclosed");
}

/// THE PRUNING PATH, end to end: the carrier is collected from the pivot store
/// the way the assembly collects it, pruned by the production function, handed
/// to core publish, and the warnings are composed as `calp_publish` composes
/// them. A pivot left behind for its unselected SOURCE sheet used to make the
/// slicer that filtered it go silent and the timeline blame a pivot "this
/// workbook no longer has"; both now name the pivot and the sheet.
///
/// SABOTAGE: return an empty list from `prune_unpublished_pivots` -- the
/// warnings fall back to the blind ones and the slicer assertion fails.
#[test]
fn a_pruned_pivot_is_named_with_the_sheet_that_kept_it_home() {
    let state = workbook_with_sheets(3); // Sheet1 dashboard, Sheet2 pivots, Sheet3 data
    let pivot_state = crate::pivot::types::PivotState::new();
    let seed = crate::document_effect::test_seed_effect();
    let pivot = new_entity();
    {
        let mut def = pivot_engine::PivotDefinition::new(pivot, (0, 0), (9, 2));
        def.name = Some("Revenue".to_string());
        def.destination_sheet = Some("Sheet2".to_string());
        def.source_sheet = Some("Sheet3".to_string());
        pivot_state
            .pivot_tables
            .write(&seed)
            .unwrap()
            .insert(pivot, (def, pivot_engine::PivotCache::new(pivot, 3)));
    }

    let mut wb = ::persistence::Workbook::default();
    let ids = state.sheet_ids.read().unwrap().clone();
    let names = state.sheet_names.read().unwrap().clone();
    wb.sheets = names
        .iter()
        .zip(ids.iter())
        .map(|(name, id)| {
            let mut sheet = ::persistence::Sheet::new(name.clone());
            sheet.id = *id;
            sheet
        })
        .collect();
    crate::persistence::collect_pivot_definitions(&pivot_state, &state, &mut wb);
    assert_eq!(wb.pivot_definitions.len(), 1, "precondition: the carrier holds the pivot");
    let dash = ids[0];
    wb.slicers = vec![::persistence::SavedSlicer {
        id: new_entity(),
        name: "Region".to_string(),
        header_text: None,
        sheet_id: dash,
        x: 0.0,
        y: 0.0,
        width: 180.0,
        height: 220.0,
        source_type: ::persistence::SavedSlicerSourceType::Pivot,
        cache_source_id: pivot,
        field_name: "Region".to_string(),
        selected_items: None,
        show_header: true,
        columns: 1,
        style_preset: "SlicerStyleLight1".to_string(),
        selection_mode: ::persistence::SavedSlicerSelectionMode::default(),
        hide_no_data: false,
        indicate_no_data: true,
        sort_no_data_last: true,
        force_selection: false,
        show_select_all: false,
        arrangement: ::persistence::SavedSlicerArrangement::default(),
        rows: 0,
        item_gap: 4.0,
        autogrid: true,
        item_padding: 0.0,
        button_radius: 2.0,
        computed_properties: Vec::new(),
        connected_sources: Vec::new(),
        filter_level: 1,
        data_source_id: None,
        container: None,
    }];
    wb.timeline_slicers = vec![::persistence::SavedTimelineSlicer {
        id: new_entity(),
        name: "Dates".to_string(),
        header_text: None,
        sheet_id: dash,
        x: 0.0,
        y: 0.0,
        width: 300.0,
        height: 120.0,
        source_type: ::persistence::SavedTimelineSourceType::Pivot,
        source_id: pivot,
        field_name: "OrderDate".to_string(),
        level: ::persistence::SavedTimelineLevel::Months,
        selection_start: None,
        selection_end: None,
        show_header: true,
        show_level_selector: true,
        show_scrollbar: true,
        style_preset: "TimelineStyleLight1".to_string(),
        connected_pivot_ids: Vec::new(),
        container: None,
    }];

    // Sheet3 (the source) was withheld: the pivot's page travels, its data not.
    let indices = vec![0usize, 1];
    let unpublished = crate::calp_commands::prune_unpublished_pivots(
        &mut wb,
        &indices,
        &std::collections::HashMap::new(),
    );
    assert!(wb.pivot_definitions.is_empty(), "the pivot is pruned for its missing source");
    assert_eq!(unpublished.len(), 1);
    assert_eq!(unpublished[0].id, pivot);
    assert_eq!(unpublished[0].name, "Revenue");
    assert_eq!(unpublished[0].missing_sheet, "Sheet3");

    // Core publish over the pruned carrier, exactly as `calp_publish` calls it.
    let prof = tempfile::TempDir::new().unwrap();
    let memory = calp::MemoryWorkspace::new();
    let request = calp::publish::PublishRequest {
        workbook: &wb,
        package_name: "pruned".to_string(),
        version: calp::SemVer::new(1, 0, 0),
        kind: "report".to_string(),
        mode: calp::PushMode::CreateNew,
        change_summary: String::new(),
        sheet_indices: indices.clone(),
        now: "2026-09-25T00:00:00Z".to_string(),
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
        identity_policy: None,
        min_app_version: String::new(),
    };
    let result = calp::publish::publish(&memory, &request, prof.path()).unwrap();
    assert!(
        result.warnings.iter().any(|w| w.contains("no longer has")),
        "precondition: core alone gives the false reason: {:#?}",
        result.warnings
    );

    let warnings = crate::calp_commands::with_unpublished_pivot_reasons(
        result.warnings,
        &wb,
        &indices,
        &unpublished,
    );
    let joined = warnings.join("\n");
    assert!(!joined.contains("no longer has"), "the false reason is gone: {joined}");
    let slicer = warnings.iter().find(|w| w.starts_with("Slicer \"Region\"")).expect(&joined);
    assert!(
        slicer.contains("pivot table \"Revenue\"") && slicer.contains("sheet \"Sheet3\""),
        "{slicer}"
    );
    let timeline = warnings.iter().find(|w| w.starts_with("Timeline \"Dates\"")).expect(&joined);
    assert!(timeline.contains("\"Sheet3\"") && timeline.contains("left out"), "{timeline}");
    assert_eq!(
        result.timeline_slicers_published, 0,
        "and the timeline indeed stays home with its pivot"
    );
}

// ---------------------------------------------------------------------------
// G. A hold-back acts on what the PUSH CARRIES (review round 11, RV11-TS-1)
// ---------------------------------------------------------------------------
//
// The push dialog decided which of the author's unticks act from the rows it
// TICKED, and a push carries more sheets than that: a floating range's hidden
// backing sheet travels with its host, and a chart's source sheet is added by
// the selection. An untick on such a sheet stopped acting -- its row showed
// ticked again, a line said the change was "on a sheet not in this push" -- and
// the push shipped the author's value under their key. Rust, which decides
// what ships, now decides this too: `calp_hold_back_cells` resolves the push's
// own request through the push's own resolver (`plan_hold_back_for_push`) and
// holds back exactly the cells on the sheets that push carries. WHERE the
// command asks is pinned in `scoped_undo_tests`.

/// One untick, as the push dialog sends it: the diff row's sheet id, and the cell.
fn untick(state: &AppState, sheet: usize, row: u32, col: u32) -> crate::calp_commands::HoldBackCellRef {
    crate::calp_commands::HoldBackCellRef { sheet_id: sheet_id_at(state, sheet).to_string(), row, col }
}

/// The plan `calp_hold_back_cells` acts on for `requested`, in the push's kind
/// ("report") and with no filter objects.
fn hold_back_plan_for(
    state: &AppState,
    requested: RequestedSheets,
    cells: &[crate::calp_commands::HoldBackCellRef],
) -> Result<crate::calp_commands::HoldBackPlan, String> {
    crate::calp_commands::plan_hold_back_for_push(
        state,
        &crate::slicer::SlicerState::new(),
        &crate::timeline_slicer::TimelineSlicerState::new(),
        &crate::pivot::types::PivotState::new(),
        "report",
        requested,
        cells,
    )
}

/// The request of a push that ticked the sheets at `ticked`, BY ID, as the
/// push dialog sends it.
fn ticked_by_id(state: &AppState, ticked: &[usize]) -> RequestedSheets {
    RequestedSheets::ById(ticked.iter().map(|&i| sheet_id_at(state, i).to_string()).collect())
}

/// The hold-back plan of a push that ticked the sheets at `ticked`.
fn hold_back_plan(
    state: &AppState,
    ticked: &[usize],
    cells: &[crate::calp_commands::HoldBackCellRef],
) -> Result<crate::calp_commands::HoldBackPlan, String> {
    hold_back_plan_for(state, ticked_by_id(state, ticked), cells)
}

/// The selection `calp_publish` itself resolves for `requested`.
fn push_selection(
    state: &AppState,
    requested: RequestedSheets,
) -> Result<crate::calp_commands::PublishSelection, String> {
    crate::calp_commands::resolve_publish_selection(
        state,
        &crate::slicer::SlicerState::new(),
        &crate::timeline_slicer::TimelineSlicerState::new(),
        &crate::pivot::types::PivotState::new(),
        "report",
        requested,
        "published",
    )
}

/// THE DEFECT, for a floating grid. Sheet1 is a page hosting a floating grid
/// backed by Float1; the author unticks Float1!B2 and pushes both user sheets.
/// The dialog has no Float1 row to tick -- the push carries Float1 with its
/// host -- and that was exactly the untick that stopped acting. It acts now.
/// With the host unticked the range stays home, and its untick is skipped and
/// counted, never refused.
///
/// SABOTAGE: judge `HoldBackPlan::for_carried` by `carried.sheets` alone (the
/// user sheets): the backing sheet's untick is skipped, and its cell ships.
#[test]
fn a_hold_back_acts_on_a_floating_ranges_backing_sheet_when_its_host_is_ticked() {
    let state = workbook_with_sheets(2);
    let backing = floating_range_on(&state, 0, "Float1");
    make_working_copy(&state, &[0, 1, backing], "sales", r"\\share\ws");
    let float = sheet_id_at(&state, backing);
    let pushed = push_selection(&state, ticked_by_id(&state, &[0, 1])).expect("the push's selection resolves");
    assert_eq!(pushed.ids.backing, vec![float], "fixture: the push carries the backing sheet with its host");

    let b2 = untick(&state, backing, 1, 1);
    let plan = hold_back_plan(&state, &[0, 1], std::slice::from_ref(&b2)).expect("the push's selection resolves");
    assert_eq!(
        plan.sheets,
        vec![(float, vec![(1, 1)])],
        "the untick on the floating grid's backing sheet does not act, although the push carries that sheet with its host"
    );
    assert_eq!(plan.skipped, 0);

    let host_home = hold_back_plan(&state, &[1], std::slice::from_ref(&b2)).expect("the push's selection resolves");
    assert!(
        host_home.sheets.is_empty(),
        "an untick acted on the backing sheet of a host the push leaves home: {host_home:?}"
    );
    assert_eq!(host_home.skipped, 1, "the untick the push does not carry is skipped -- and counted");
}

/// THE DEFECT, for a chart source. A chart on Sheet1 reads Sheet2; the author
/// unticks Sheet2!C3, then unticks Sheet2 itself. The selection adds Sheet2
/// back for the chart, so the push ships it -- and the untick must still act.
///
/// SABOTAGE: plan by the sheets the request NAMED (the dialog's ticks) instead
/// of the resolved `selection.ids`: the source sheet's untick is skipped, and
/// its cell ships.
#[test]
fn a_hold_back_acts_on_a_chart_source_the_push_adds_although_it_is_unticked() {
    let state = workbook_with_sheets(2);
    chart_on(&state, 0, 1, "Revenue");
    make_working_copy(&state, &[0, 1], "sales", r"\\share\ws");
    let data = sheet_id_at(&state, 1);
    let pushed = push_selection(&state, ticked_by_id(&state, &[0])).expect("the push's selection resolves");
    assert_eq!(pushed.auto_included, vec!["Sheet2".to_string()], "fixture: the push adds the chart's source sheet");

    let plan = hold_back_plan(&state, &[0], &[untick(&state, 1, 2, 2)]).expect("the push's selection resolves");
    assert_eq!(
        plan.sheets,
        vec![(data, vec![(2, 2)])],
        "the untick on the sheet the push adds for its chart does not act, although the push ships that sheet"
    );
    assert_eq!(plan.skipped, 0);
}

/// An untick on a sheet the push does NOT carry -- unticked, and nothing on a
/// ticked sheet reads it -- is skipped and counted, never refused and never
/// written. Alone it leaves the plan EMPTY, which `calp_hold_back_cells`
/// answers with no write and no undo entry, before it even reads the base
/// (pinned in `scoped_undo_tests`); beside unticks that act, only those are
/// held back.
///
/// SABOTAGE: let `HoldBackPlan::for_carried` keep every cell whose sheet id
/// parses: Sheet3's untick is planned, and its sheet is rolled back for a push
/// that does not ship it.
#[test]
fn a_hold_back_skips_a_cell_on_a_sheet_the_push_does_not_carry() {
    let state = workbook_with_sheets(3);
    make_working_copy(&state, &[0, 1, 2], "sales", r"\\share\ws");

    let alone = hold_back_plan(&state, &[0, 1], &[untick(&state, 2, 0, 0)]).expect("the push's selection resolves");
    assert_eq!(
        alone,
        crate::calp_commands::HoldBackPlan { sheets: Vec::new(), skipped: 1 },
        "a lone untick on a sheet the push leaves home must plan nothing -- and count itself"
    );

    let mixed = hold_back_plan(
        &state,
        &[0, 1],
        &[untick(&state, 2, 0, 0), untick(&state, 1, 4, 4), untick(&state, 2, 1, 0), untick(&state, 1, 4, 5)],
    )
    .expect("the push's selection resolves");
    assert_eq!(
        mixed.sheets,
        vec![(sheet_id_at(&state, 1), vec![(4, 4), (4, 5)])],
        "only the unticks on the carried sheet act"
    );
    assert_eq!(mixed.skipped, 2);
}

/// A cell on a sheet NO LONGER IN THE WORKBOOK is skipped, never refused
/// (`CALP_HOLDBACK_NO_SHEET` is gone): the push cannot ship that sheet, so there
/// is nothing to hold back on it. Whether it went before the push resolved its
/// selection, or after -- between the resolution and the grid copy the write
/// indexes (`HoldBackPlan::locate`). A sheet that only MOVED is found where it
/// now sits, and one deleted is never handed to a sheet that took its place.
///
/// SABOTAGE: stop counting in `HoldBackPlan::locate` (`None => {}`): the
/// deleted sheet's cells vanish from both counts, and the answer stops adding
/// up to the request.
#[test]
fn a_hold_back_skips_a_cell_on_a_sheet_no_longer_in_the_workbook() {
    let state = crate::create_app_state();
    let setup = FileState::default();
    for name in ["Data", "Notes", "Extra"] {
        crate::sheets::add_sheet_inner(&state, &setup, Some(name.to_string()), ::persistence::SheetKind::Worksheet)
            .expect("add");
    }
    make_working_copy(&state, &[0, 1, 2, 3], "sales", r"\\share\ws");
    let (data, notes) = (sheet_id_at(&state, 1), sheet_id_at(&state, 2));
    let on_notes = untick(&state, 2, 0, 0);
    let on_data = untick(&state, 1, 3, 3);

    // 1. Notes goes before the push resolves its selection.
    delete_through_the_impl(&state, &setup, 2, Some(notes)).expect("delete Notes");
    let plan = hold_back_plan(&state, &[0, 1], &[on_notes, on_data])
        .expect("a cell on a deleted sheet refused the hold-back");
    assert_eq!(plan.sheets, vec![(data, vec![(3, 3)])]);
    assert_eq!(plan.skipped, 1, "the deleted sheet's untick is skipped -- and counted");
    let no_sheet = crate::calp_commands::HoldBackCellRef { sheet_id: "not a sheet id".to_string(), row: 0, col: 0 };
    assert_eq!(
        hold_back_plan(&state, &[0, 1], &[no_sheet]).expect("the push's selection resolves"),
        crate::calp_commands::HoldBackPlan { sheets: Vec::new(), skipped: 1 },
        "an id that names no sheet is skipped too"
    );

    // 2. Data MOVES after the selection was resolved: found where it now sits.
    crate::sheets::move_sheet_impl(
        &state,
        &setup,
        &crate::slicer::SlicerState::new(),
        &crate::timeline_slicer::TimelineSlicerState::new(),
        &crate::ribbon_filter::RibbonFilterState::new(),
        1,
        2,
    )
    .expect("move Data");
    let ids = state.sheet_ids.read().unwrap().clone();
    let now_at = ids.iter().position(|id| *id == data).expect("Data is still here");
    assert_ne!(now_at, 1, "fixture: Data moved");
    assert_eq!(plan.locate(&ids), (vec![(now_at, data, vec![(3, 3)])], 0), "a moved sheet is not found by its id");

    // 3. ...and is deleted: skipped and counted, never handed to the sheet now
    //    at either of its old positions.
    delete_through_the_impl(&state, &setup, now_at, Some(data)).expect("delete Data");
    let ids = state.sheet_ids.read().unwrap().clone();
    assert_eq!(
        plan.locate(&ids),
        (Vec::new(), 1),
        "a cell on a sheet deleted since the resolution must be skipped, and counted"
    );
}

/// A REFUSAL OF THE PUSH'S SELECTION COMES BACK UNCHANGED. A push that ticked a
/// sheet since deleted is refused exactly as the push itself would refuse it --
/// the code, the sentence, the sheet's name from the link -- and so is one that
/// names a position no list shows. `calp_hold_back_cells` asks this before it
/// reads the base or copies a grid, so nothing is written (pinned in
/// `scoped_undo_tests`).
///
/// SABOTAGE: answer a refused selection in `plan_hold_back_for_push` with an
/// empty one (`.unwrap_or_default()`): every untick is skipped in silence, and
/// the author learns of the gone sheet only from the push that follows -- if
/// it still refuses.
#[test]
fn a_hold_back_whose_ticked_sheet_is_gone_refuses_as_the_push_would() {
    use crate::calp_commands::{CALP_PUSH_SHEET_GONE, CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE};
    let state = crate::create_app_state();
    let setup = FileState::default();
    for name in ["Data", "Notes"] {
        crate::sheets::add_sheet_inner(&state, &setup, Some(name.to_string()), ::persistence::SheetKind::Worksheet)
            .expect("add");
    }
    make_working_copy(&state, &[0, 1, 2], "sales", r"\\share\ws");
    let notes = sheet_id_at(&state, 2);
    let cells = [untick(&state, 1, 0, 0)];
    delete_through_the_impl(&state, &setup, 2, Some(notes)).expect("delete Notes");

    let ticked = || RequestedSheets::ById(vec![sheet_id_at(&state, 0).to_string(), notes.to_string()]);
    let refusal = hold_back_plan_for(&state, ticked(), &cells).expect_err("a push naming a gone sheet planned a hold-back");
    let pushed = push_selection(&state, ticked()).map(|s| s.ids).expect_err("fixture: the push refuses it");
    assert_eq!(refusal, pushed, "the hold-back's refusal is not the push's own");
    assert!(refusal.starts_with(&format!("{CALP_PUSH_SHEET_GONE}:")), "{refusal}");
    assert!(refusal.contains("'Notes'") && refusal.contains("nothing was published"), "{refusal}");

    let past = || RequestedSheets::ByPosition(vec![0, 7]);
    let refusal = hold_back_plan_for(&state, past(), &cells).expect_err("a position no list shows planned a hold-back");
    assert_eq!(refusal, push_selection(&state, past()).map(|s| s.ids).expect_err("fixture: the push refuses it"));
    assert!(refusal.starts_with(&format!("{CALP_PUSH_SHEET_INDEX_OUT_OF_RANGE}:")), "{refusal}");
}

/// THE WORKING-COPY DIFF NAMES EVERY SHEET ITS PUSH CARRIES, and no sheet it
/// drops (`WorkingCopyDiff::carried_sheet_ids`) -- what the push dialog sorts
/// its unticks by, because the rows cannot say it. Sheet1 carries a chart that
/// reads Data; Page hosts a floating grid backed by Float1; Notes is a base
/// sheet the author unticked. Pushing Sheet1 and Page carries Sheet1, Page,
/// Data (for the chart) and Float1 (with its host), in publish order -- and NOT
/// Notes, which the diff lists `removed`, every cell a row with a checkbox.
/// Data and Float1 are unchanged, so they have no row at all.
///
/// Driven through the very in-memory publish `calp_diff_working_copy` compares
/// (`publish_into_for_preview`), read the way the command reads it (pinned
/// below).
///
/// SABOTAGE: let `carried_sheet_ids` default an id the map does not name to
/// nothing (`unwrap_or_default()`): a working copy's answer names no sheet.
#[test]
fn the_working_copy_diff_names_every_sheet_its_push_carries_and_none_it_drops() {
    use calp::transport::WorkspaceTransport;
    const PKG: &str = "rv11-carried-sheets";
    let state = crate::create_app_state();
    let setup = FileState::default();
    for name in ["Data", "Notes", "Page"] {
        crate::sheets::add_sheet_inner(&state, &setup, Some(name.to_string()), ::persistence::SheetKind::Worksheet)
            .expect("add");
    }
    chart_on(&state, 0, 1, "Revenue");
    let backing = floating_range_on(&state, 3, "Float1");
    state.grids.write(&crate::document_effect::test_seed_effect()).unwrap()[2]
        .set_cell(0, 0, engine::Cell::new_text("private".to_string()));
    let [summary, data, notes, page, float] = [0, 1, 2, 3, backing].map(|i| sheet_id_at(&state, i));

    let publish = |memory: &calp::MemoryWorkspace, version: calp::SemVer, ticked: &[identity::SheetId]| {
        crate::calp_commands::publish_into_for_preview(
            &state,
            &crate::bi::types::BiState::new(),
            &crate::pivot::types::PivotState::new(),
            &crate::scripting::types::ScriptState::new(),
            &crate::slicer::SlicerState::new(),
            &crate::ribbon_filter::RibbonFilterState::new(),
            &crate::pane_control::PaneControlState::new(),
            &crate::persistence::UserFilesState::default(),
            &crate::timeline_slicer::TimelineSlicerState::new(),
            memory,
            "",
            PKG,
            version.clone(),
            "report",
            RequestedSheets::ById(ticked.iter().map(|id| id.to_string()).collect()),
            false,
            Some(Vec::new()),
            &HashMap::new(),
            "compared",
            &[],
        )
        .expect("the in-memory publish");
        memory.get_version_manifest(PKG, &version.to_string()).expect("the manifest it wrote")
    };
    let base_memory = calp::MemoryWorkspace::new();
    let base = publish(&base_memory, calp::SemVer::new(1, 0, 0), &[summary, data, notes, page]);
    let push_memory = calp::MemoryWorkspace::new();
    let push = publish(&push_memory, calp::SemVer::new(0, 0, 0), &[summary, page]);

    let carried = crate::calp_diff::carried_sheet_ids(&push, &HashMap::new());
    assert_eq!(
        carried,
        [summary, page, data, float].map(|id| id.to_string()).to_vec(),
        "the carried sheets are the ticked ones, the chart's source and the floating grid's backing sheet, in publish order"
    );

    let base_artifacts = base_memory.artifacts_of(PKG, "1.0.0");
    let push_artifacts = push_memory.artifacts_of(PKG, "0.0.0");
    let diff = calp::diff::diff_sides(
        &calp::diff::DiffSide::InMemory { manifest: &base, artifacts: &base_artifacts },
        &calp::diff::DiffSide::InMemory { manifest: &push, artifacts: &push_artifacts },
        &calp::diff::DiffOptions::default(),
    )
    .expect("the diff");
    let row = |id: identity::SheetId| diff.sheets.iter().find(|s| s.sheet_id == id.to_string());
    let removed = row(notes).expect("fixture: the base sheet the push drops is listed");
    assert_eq!(removed.change, "removed", "fixture: as removed");
    assert!(!removed.sample.is_empty(), "fixture: its cells are rows, each with a checkbox");
    assert!(!carried.contains(&notes.to_string()), "a base sheet the push drops is said to be carried");
    assert!(
        row(data).is_none() && row(float).is_none(),
        "fixture: the carried sheets nobody changed have no row -- the rows cannot say what is carried"
    );

    // A SUBSCRIBER's carried sheets are spelled as its rows are: through the
    // local -> application map, a sheet the map does not name keeping its own.
    let map: HashMap<String, String> =
        [(summary.to_string(), "application-summary".to_string())].into_iter().collect();
    let spelled = crate::calp_diff::carried_sheet_ids(&push, &map);
    assert_eq!(spelled[0], "application-summary");
    assert_eq!(spelled[1..], carried[1..]);

    // On the wire: `carriedSheetIds`, beside the rows.
    let answer = crate::calp_diff::WorkingCopyDiff {
        package_name: PKG.to_string(),
        base_version: "1.0.0".to_string(),
        diff,
        carried_sheet_ids: carried.clone(),
        code: None,
    };
    let json = serde_json::to_value(&answer).expect("the answer serializes");
    assert_eq!(json["carriedSheetIds"], serde_json::json!(carried));
}

/// `calp_diff_working_copy` answers with what ITS in-memory publish wrote: the
/// carried sheets are read off the manifest that publish left, through the id
/// map the diff applies, and travel in the answer -- never rebuilt from the
/// rows or the request.
///
/// SABOTAGE: build `carried_sheet_ids` in the command from `diff.sheets`.
#[test]
fn the_working_copy_diff_reads_its_carried_sheets_off_its_own_publish() {
    let diff_src = strip_line_comments(include_str!("calp_diff.rs"));
    let start = diff_src.find("pub fn calp_diff_working_copy(").expect("the command moved");
    let body = &diff_src[start..start + diff_src[start..].find("\n}\n").expect("its end")];
    let at = |needle: &str| body.find(needle).unwrap_or_else(|| panic!("`{needle}` is gone from calp_diff_working_copy"));
    let wrote = at("let mut working_manifest = memory");
    let carried = at("let carried_sheet_ids = carried_sheet_ids(&working_manifest, &sheet_id_map);");
    let diffed = at("&DiffOptions { sheet_id_map, ..DiffOptions::default() }");
    assert!(wrote < carried && carried < diffed, "the carried sheets are not read off the publish, through the rows' map");
    assert!(at("Ok(WorkingCopyDiff {") < at("        carried_sheet_ids,\n"), "the answer does not carry them");
    assert_eq!(body.matches("carried_sheet_ids").count(), 3, "a second source of the carried sheets");
}

/// THE WIRE the push dialog sends: the push's own `kind` (required) and its
/// sheets -- `sheetIds` taking precedence over `sheetIndices`, as on the push --
/// and the answer's `cellsSkipped`, all camelCase through `rename_all`.
///
/// SABOTAGE: drop `#[serde(default)]` from `sheet_indices` (a request naming no
/// positions -- by id, or the default -- stops parsing), or rename
/// `cells_skipped`. (Not `sheet_ids`: serde reads an absent `Option` as `None`
/// with or without the attribute, so that sabotage would change nothing.)
#[test]
fn the_hold_back_takes_the_pushs_own_selection_on_the_wire() {
    use crate::calp_commands::{HoldBackCellsParams, HoldBackCellsResponse};
    let request = |extra: serde_json::Value| -> Result<HoldBackCellsParams, serde_json::Error> {
        let mut json = serde_json::json!({
            "registryPath": r"\\share\ws",
            "packageName": "sales",
            "baseVersion": "1.0.0",
            "cells": [{ "sheetId": "id-float", "row": 1, "col": 1 }],
        });
        json.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        serde_json::from_value(json)
    };
    let by_id = request(serde_json::json!({ "kind": "report", "sheetIndices": [0, 1], "sheetIds": ["id-a", "id-b"] }))
        .expect("the dialog's request parses");
    assert_eq!(by_id.kind, "report");
    assert_eq!(by_id.cells.len(), 1);
    assert_eq!(
        RequestedSheets::from_wire(by_id.sheet_ids, by_id.sheet_indices),
        RequestedSheets::ById(vec!["id-a".to_string(), "id-b".to_string()])
    );
    let ids_alone = request(serde_json::json!({ "kind": "report", "sheetIds": ["id-a"] })).expect("ids alone parse");
    assert_eq!(
        RequestedSheets::from_wire(ids_alone.sheet_ids, ids_alone.sheet_indices),
        RequestedSheets::ById(vec!["id-a".to_string()])
    );
    let by_position = request(serde_json::json!({ "kind": "report", "sheetIndices": [2] })).expect("positions alone parse");
    assert_eq!(
        RequestedSheets::from_wire(by_position.sheet_ids, by_position.sheet_indices),
        RequestedSheets::ByPosition(vec![2])
    );
    let default = request(serde_json::json!({ "kind": "library" })).expect("no sheets parses: the default selection");
    assert!(RequestedSheets::from_wire(default.sheet_ids, default.sheet_indices).names_no_sheet());
    let no_kind = request(serde_json::json!({})).expect_err("a request without the push's kind parsed");
    assert!(no_kind.to_string().contains("kind"), "{no_kind}");

    let answer = HoldBackCellsResponse { cells_held_back: 2, cells_skipped: 1, undo_recorded: true, undo_seq: Some(7) };
    assert_eq!(
        serde_json::to_value(&answer).expect("serializes"),
        serde_json::json!({ "cellsHeldBack": 2, "cellsSkipped": 1, "undoRecorded": true, "undoSeq": 7 })
    );
}
