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

use crate::persistence::FileState;
use crate::AppState;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

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
        crate::calp_commands::resolve_publish_sheet_indices(&state, "report", Vec::new()).unwrap();

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
        crate::calp_commands::resolve_publish_sheet_indices(&state, "report", vec![1]).unwrap();

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
        crate::calp_commands::resolve_publish_sheet_indices(&state, "report", Vec::new()).unwrap();
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
        crate::calp_commands::resolve_publish_sheet_indices(&state, "report", vec![1]).unwrap();
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
        crate::calp_commands::resolve_publish_sheet_indices(&plain, "report", Vec::new()).unwrap();
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
        crate::calp_commands::resolve_publish_sheet_indices(&state, "library", Vec::new()).unwrap();
    assert!(
        library.indices.is_empty(),
        "a library ships its module scripts, not the author's workbook"
    );

    let report =
        crate::calp_commands::resolve_publish_sheet_indices(&state, "report", Vec::new()).unwrap();
    assert_eq!(report.indices, vec![0, 1, 2]);

    // Explicit selection still wins for a library — the author named sheets.
    let explicit =
        crate::calp_commands::resolve_publish_sheet_indices(&state, "library", vec![1]).unwrap();
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
        crate::calp_commands::resolve_publish_sheet_indices(&state, "report", Vec::new()).unwrap();
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

    crate::sheets::rename_sheet_inner(&state, &file_state, 1, "Vendor KPIs".to_string(), false)
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
        crate::calp_commands::resolve_publish_sheet_indices(&state, "report", Vec::new()).unwrap();
    assert_eq!(before.indices, vec![0, 2], "precondition: withheld while subscribed");

    let result = crate::calp_commands::detach_sheet_inner(&state, &file_state, 1).unwrap();
    assert_eq!(result.package_name, "acme.finance");

    let after =
        crate::calp_commands::resolve_publish_sheet_indices(&state, "report", Vec::new()).unwrap();
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

    crate::calp_commands::detach_sheet_inner(&state, &file_state, 1).unwrap();

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
    let r = crate::calp_commands::detach_sheet_inner(&state, &file_state, 1).unwrap();
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
    let r = crate::calp_commands::detach_sheet_inner(&state, &file_state, 1).unwrap();
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
    let err = crate::calp_commands::detach_sheet_inner(&state, &file_state, 0)
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
        crate::calp_commands::resolve_publish_sheet_indices(&state, "report", Vec::new()).unwrap();

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
        crate::calp_commands::resolve_publish_sheet_indices(&state, "report", vec![1, 2]).unwrap();
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
        crate::calp_commands::resolve_publish_sheet_indices(&state, "report", Vec::new()).unwrap();
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
    let published = crate::calp_commands::resolve_publish_sheet_indices(&state, "report", Vec::new())
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
