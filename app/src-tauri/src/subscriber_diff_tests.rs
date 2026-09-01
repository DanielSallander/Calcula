//! FILENAME: app/src-tauri/src/subscriber_diff_tests.rs
//! PURPOSE: A diff shown before a destructive act must not name a change the act
//! will not make, and must not omit the sheets the act will touch.
//!
//! CONTEXT: "Reset to published" discards every local edit on an application's
//! sheets. It now shows the differences first, which is a better basis for the
//! decision — and a new way to be wrong. A preview that understates or
//! misdescribes a destructive act is worse than no preview, because it
//! manufactures confidence.
//!
//! Three specific lies were found in the machinery before any of it was wired
//! to a user, and each has a guard here:
//!
//!   1. An empty `sheetIndices` means "the publish default", which for a
//!      SUBSCRIBING workbook is every sheet you own EXCEPT the subscribed ones —
//!      the exact inverse of the question. Refused, not substituted.
//!   2. A DETACHED sheet is still in the published manifest but gone from the
//!      ledger, so the raw diff calls it `removed` while the reset skips it. And
//!      a floating range the subscriber added to a subscribed sheet drags its
//!      LOCAL backing sheet into the assembly, where it reads as `added`.
//!      Both are filtered by scope, and the totals recomputed with them.
//!   3. `include_comments` defaults false, so against a base published WITH
//!      comments every comment read as removed. The caller passes true.

use crate::calp_diff::scope_diff;

/// The source text of one function, comment-stripped.
fn body_of(signature: &str) -> String {
    let files = [
        include_str!("calp_diff.rs"),
        include_str!("calp_commands.rs"),
    ];
    for src in files {
        if let Some(start) = src.find(signature) {
            let rest = &src[start..];
            let end = rest.find("\n}\n").unwrap_or(rest.len());
            return strip_line_comments(&rest[..end]);
        }
    }
    panic!("signature not found: {}", signature);
}

fn strip_line_comments(src: &str) -> String {
    src.lines()
        .map(|line| match line.find("//") {
            Some(i) => line[..i].to_string(),
            None => line.to_string(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn sheet(id: &str, change: &str, added: usize, modified: usize) -> calp::diff::SheetDiffSummary {
    calp::diff::SheetDiffSummary {
        sheet_id: id.to_string(),
        name: format!("Sheet-{}", id),
        change: change.to_string(),
        renamed_from: None,
        cells_added: added,
        cells_removed: 0,
        cells_modified: modified,
        formula_changes: 0,
        counts_exact: true,
        style_changed_cells: 0,
        styles_table_changed: false,
        layout_changed: false,
        metadata_changed: false,
        sample: Vec::new(),
        sample_truncated: false,
    }
}

fn diff_of(sheets: Vec<calp::diff::SheetDiffSummary>) -> calp::diff::VersionDiff {
    let cells = sheets
        .iter()
        .map(|s| s.cells_added + s.cells_removed + s.cells_modified)
        .sum();
    calp::diff::VersionDiff {
        package_name: "app".to_string(),
        from_version: "1.0.0".to_string(),
        to_version: "0.0.0".to_string(),
        artifacts: Default::default(),
        totals: calp::diff::DiffTotals {
            objects_added: 0,
            objects_removed: 0,
            objects_modified: 0,
            sheets_changed: sheets.len(),
            cells_changed: cells,
            cells_changed_exact: true,
        },
        sheets,
        objects: Vec::new(),
        manifest_changes: Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// A. The scope filter, and the totals that must follow it
// ---------------------------------------------------------------------------

/// A DETACHED SHEET IS NOT SOMETHING THE RESET WILL REMOVE.
///
/// Detach drops the sheet from the subscription ledger; the published manifest
/// still carries it, so `diff_sides` reports it `removed`. But
/// `calp_reset_subscription` resolves its targets through that same ledger and
/// silently skips it. Without the scope filter the preview announces a deletion
/// that will not happen — and it looks like an ordinary row, so nothing about it
/// invites suspicion.
///
/// SABOTAGE: make `scope_diff` return `diff` unchanged when `scope` is `Some`.
#[test]
fn a_sheet_outside_the_scope_is_dropped_from_the_diff() {
    let diff = diff_of(vec![
        sheet("tracked", "modified", 0, 3),
        sheet("detached", "removed", 0, 0),
    ]);
    let scoped = scope_diff(diff, Some(&["tracked".to_string()]));
    assert_eq!(scoped.sheets.len(), 1);
    assert_eq!(scoped.sheets[0].sheet_id, "tracked");
}

/// A LOCAL floating range's backing sheet joins the publish assembly (the
/// expansion runs on the final selection in every branch) and is absent from the
/// base manifest, so it reads as `added`. The reset creates nothing.
///
/// Same guard, opposite direction — worth its own case because "added" and
/// "removed" reach `scope_diff` down different paths in `diff_sides`.
#[test]
fn a_locally_added_sheet_is_dropped_from_the_diff() {
    let diff = diff_of(vec![
        sheet("tracked", "modified", 0, 1),
        sheet("local-backing", "added", 40, 0),
    ]);
    let scoped = scope_diff(diff, Some(&["tracked".to_string()]));
    assert_eq!(scoped.sheets.len(), 1);
    assert_eq!(scoped.sheets[0].sheet_id, "tracked");
}

/// THE HEADER MUST COUNT WHAT THE LIST SHOWS. A filtered list under carried-over
/// totals is a strip claiming rows the list below does not have — which is how a
/// user concludes the preview is hiding something, or worse, does not notice.
///
/// SABOTAGE: delete the three `diff.totals.*` recomputations, keeping the
/// `retain`. The list looks right and only the numbers lie.
#[test]
fn the_totals_are_recomputed_from_what_survived_the_filter() {
    let diff = diff_of(vec![
        sheet("tracked", "modified", 0, 3),
        sheet("detached", "removed", 0, 0),
        sheet("local-backing", "added", 40, 0),
    ]);
    assert_eq!(diff.totals.cells_changed, 43, "the unfiltered figure");

    let scoped = scope_diff(diff, Some(&["tracked".to_string()]));
    assert_eq!(scoped.totals.cells_changed, 3, "only the tracked sheet's cells");
    assert_eq!(scoped.totals.sheets_changed, 1);
}

/// `None` LEAVES THE DIFF WHOLE. The push preview wants every sheet: there, a
/// sheet genuinely added or removed by the push is precisely what the author
/// needs to see, and filtering it would hide the most consequential row.
///
/// SABOTAGE: treat `None` as an empty scope. The push preview goes blank.
#[test]
fn an_unscoped_diff_is_left_alone() {
    let diff = diff_of(vec![sheet("a", "modified", 0, 2), sheet("b", "added", 5, 0)]);
    let scoped = scope_diff(diff, None);
    assert_eq!(scoped.sheets.len(), 2);
    assert_eq!(scoped.totals.cells_changed, 7);
}

/// An inexact sheet inside the scope keeps the whole answer inexact. Dropping
/// the flag while filtering would turn "at least N" into "N".
#[test]
fn a_capped_sheet_keeps_the_scoped_totals_inexact() {
    let mut capped = sheet("tracked", "modified", 0, 9);
    capped.counts_exact = false;
    let scoped = scope_diff(diff_of(vec![capped]), Some(&["tracked".to_string()]));
    assert!(!scoped.totals.cells_changed_exact);
}

// ---------------------------------------------------------------------------
// B. The refusal that keeps a subscriber diff from answering the inverse question
// ---------------------------------------------------------------------------

/// AN EMPTY SHEET LIST IS THE INVERSE OF THE REQUEST, not a shorthand for it.
///
/// `sheet_indices: []` means "the publish default", and for a workbook that
/// subscribes to this application that default is every user sheet MINUS the
/// subscribed ones. A reset preview built that way would describe sheets the
/// reset does not touch and omit every sheet it does — silently, because both
/// halves look like ordinary rows.
///
/// SABOTAGE: delete the `CALP_DIFF_NEEDS_SHEETS` block.
#[test]
fn a_subscriber_diff_must_name_its_sheets() {
    let body = body_of("pub fn calp_diff_working_copy(");
    assert!(
        body.contains("CALP_DIFF_NEEDS_SHEETS"),
        "the subscriber guard is gone — an empty sheet list would silently \
         diff every sheet EXCEPT the subscribed ones"
    );
}

/// THE GUARD MUST NOT LOOK AT THE WORKING-COPY LINK.
///
/// A workbook can be the working copy of application X *and* a subscriber of
/// application Y at the same time — a first-class state since checkout became
/// additive, and exactly the configuration this feature creates by putting
/// reset, view-changes and push on one tab menu. A `link.is_none()` test sails
/// past for such a workbook and hands it X's `base_sheets` for a diff of Y.
/// What matters is only whether THIS application is subscribed.
///
/// SABOTAGE: add `link.is_none() &&` to the condition. Nothing fails to compile,
/// nothing fails at runtime, and the diff quietly describes another application.
#[test]
fn the_subscriber_guard_asks_about_the_application_not_the_workbook() {
    let body = body_of("pub fn calp_diff_working_copy(");
    let guard_at = body
        .find("CALP_DIFF_NEEDS_SHEETS")
        .expect("the subscriber guard is gone");
    // The condition sits immediately above the message; take a generous window
    // back from it and require the subscription test, not a link test.
    let window_start = guard_at.saturating_sub(400);
    let condition = &body[window_start..guard_at];
    assert!(
        condition.contains("subscription_sheet_map"),
        "the guard must key on whether THIS application is subscribed"
    );
    assert!(
        !condition.contains("link.is_none()"),
        "the guard must not test the working-copy link: a workbook that is a \
         working copy of X and a subscriber of Y would sail past it and be \
         handed X's sheets for a diff of Y"
    );
}

/// The guard must refuse rather than quietly fill in the tracked indices.
/// Substituting would hide a caller bug and make the SCOPE of a diff shown
/// before a destructive act invisible at the call site.
///
/// SABOTAGE: replace the `return Err(...)` with an assignment to
/// `params.sheet_indices`.
#[test]
fn the_subscriber_guard_refuses_rather_than_substituting() {
    let body = body_of("pub fn calp_diff_working_copy(");
    let guard_at = body.find("CALP_DIFF_NEEDS_SHEETS").expect("guard gone");
    let before = &body[guard_at.saturating_sub(120)..guard_at];
    assert!(
        before.contains("return Err(format!("),
        "the guard stopped refusing — a substituted scope is a scope nobody chose"
    );
}

// ---------------------------------------------------------------------------
// C. "Was this sheet in the base version?" is an IDENTITY question
// ---------------------------------------------------------------------------

/// THE PUBLISH DIALOG MUST BE ABLE TO ASK BY ID.
///
/// Reported from live testing: open an application for editing into a workbook
/// that already has a `Sheet1`, change a cell, push — and the dialog listed the
/// application's own sheet as "(new — not in v1.0.0)" while silently treating
/// the author's unrelated `Sheet1` as part of the application.
///
/// The cause was a NAME comparison against `WorkingCopyLink::base_sheets`, whose
/// names are recorded at CHECKOUT — before `resolve_sheet_name_collisions`
/// renames the incoming sheet to `Sheet1 (2)`. Additive checkout makes that
/// collision ordinary rather than exotic. Identity is the sheet id, and a
/// working copy's ids ARE the application's.
///
/// SABOTAGE: drop `sheet_id` from `PublishPreviewSheet`; the frontend then has
/// nothing to compare but the name again.
#[test]
fn the_publish_preview_reports_a_sheet_id() {
    let body = body_of("pub(crate) fn publish_preview_sheet_list(");
    assert!(
        body.contains("sheet_id:"),
        "the publish preview stopped reporting sheet ids, so the dialog can only \
         match base sheets by NAME — which a collision rename breaks"
    );
    assert!(
        body.contains("sheet_ids.get(i)"),
        "the id must come from the state vector BY INDEX: the list filters \
         object-backed sheets while `i` stays the true position, so a zip would \
         hand each row its neighbour's identity"
    );
}
