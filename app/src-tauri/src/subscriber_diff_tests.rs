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

// ---------------------------------------------------------------------------
// D. Per-cell reset: the four conditions that make it correct
// ---------------------------------------------------------------------------
//
// Unticking a row in the reset diff means "keep my value here, restore the
// rest". That is sound on the reset side — unlike the push side, where the
// receiver never recalculates — but only if four things hold. Each has a guard.

/// AN EXCLUSION SET, NEVER AN INCLUSION SET.
///
/// The diff rows are a bounded sample (50 changed cells per sheet), so a changed
/// cell may have no row for anyone to tick. Storing what was opted OUT of makes
/// every unseen cell keep the default, and makes an untouched dialog reset
/// exactly what a whole-sheet reset always did.
///
/// SABOTAGE: rename the field to `included_cells` and invert the test. An empty
/// list then resets NOTHING, and every cell past the 50th is silently spared.
#[test]
fn the_reset_selection_is_an_exclusion_set() {
    let body = body_of("pub struct ResetSubscriptionParams {");
    assert!(
        body.contains("excluded_cells"),
        "the reset selection stopped being an exclusion set — a cell with no row \
         would then default to NOT being reset"
    );
    let cmd = body_of("pub fn calp_reset_subscription(");
    assert!(
        cmd.contains("#[serde(default)]") || body.contains("#[serde(default)]"),
        "an omitted list must deserialize, so a caller that sends none keeps the \
         whole-sheet behaviour"
    );
}

/// THE OVERRIDE LEDGER MUST FOLLOW THE CELLS.
///
/// Reset used to clear every override on the reset sheets. With a partial reset
/// that is wrong in the direction that loses work: an override on a cell the
/// author KEPT is still true — the grid holds their value, the ledger records
/// what upstream had — and dropping it leaves a local edit with nothing to say
/// it is one. Invisible in the Overrides pane, and republished as the
/// publisher's own content by the next person who checks the application out.
///
/// SABOTAGE: restore the old `retain(|o| !local_sheet_ids.contains(&o.sheet_id))`.
#[test]
fn a_kept_cell_keeps_its_override() {
    let body = body_of("pub fn calp_reset_subscription(");
    assert!(
        body.contains("excluded_by_sheet"),
        "the override sweep no longer consults the exclusion set, so it clears \
         overrides for cells the reset deliberately did not touch"
    );
    assert!(
        body.contains("cell_position("),
        "the override's position must come from the id registry first — an \
         override is id-anchored so it survives a structural shift, and its \
         recorded position is only the fallback"
    );
}

/// A PARTIAL RESET MUST RECALCULATE, IN THE COMMAND.
///
/// A whole-sheet reset installed a coherent published sheet. A partial one
/// installs a MIXTURE, and a formula reading across that boundary holds a number
/// computed from neither state. The frontend does call `calculateNow`, but
/// inside a try/catch that logs and continues — and nothing on any receiving
/// side would ever repair it, because neither a pull, nor a checkout, nor
/// opening the file evaluates a cell.
///
/// SABOTAGE: delete the `recalculate_sheet_values` loop and lean on the
/// frontend.
#[test]
fn a_reset_recalculates_the_sheets_it_mixed() {
    let body = body_of("pub fn calp_reset_subscription(");
    assert!(
        body.contains("recalculate_sheet_values("),
        "the reset stopped recalculating — a partial reset then leaves formulas \
         holding values computed from neither the local nor the published state"
    );
}

/// A DYNAMIC ARRAY IS ONE THING.
///
/// Keeping the author's formula at a spill ORIGIN while the published extents
/// are installed leaves the origin claiming a rectangle the published version
/// decided, computed from a formula it does not have. Refused by name: this is
/// rare, and the wrong answer corrupts a block rather than a cell.
///
/// SABOTAGE: delete the `CALP_RESET_SPILL_CELL` block.
#[test]
fn a_spill_origin_cannot_be_half_kept() {
    let body = body_of("pub fn calp_reset_subscription(");
    assert!(
        body.contains("CALP_RESET_SPILL_CELL"),
        "a spill origin can now be excluded, leaving the array's shape and its \
         formula disagreeing"
    );
    assert!(
        body.contains("spill_ranges"),
        "the local origins must come from `spill_ranges` — `engine::Cell` \
         carries no spill of its own, so a cell-level test would always be false"
    );
}

// ---------------------------------------------------------------------------
// E. A local rename does not travel upstream
// ---------------------------------------------------------------------------

/// THE LEAK. Checkout is ADDITIVE, so pulling an application's "Sheet1" into a
/// workbook that already has one renames the INCOMING sheet to "Sheet1 (2)" — a
/// collision in THIS author's workbook and nowhere else. Publishing the LIVE
/// name then renamed that sheet for every subscriber.
///
/// It needed no author action: the default push selection is exactly
/// `base_sheets`, `assemble_publish_workbook` names sheets from the live
/// `state.sheet_names`, and `publish()` copies `sheet.name` into the manifest.
///
/// And names are the formula reference key — cross-sheet refs inside a package
/// are stored as raw text and resolved by a FIRST-MATCH case-insensitive name
/// lookup, so a renamed sheet re-points every `=Sheet1!A1` in the package at
/// whatever the subscriber calls "Sheet1", silently.
///
/// SABOTAGE: delete the `renamed_for_publish` block from
/// `assemble_publish_workbook`.
#[test]
fn a_published_sheet_keeps_the_name_the_application_knows_it_by() {
    let body = body_of("fn assemble_publish_workbook(");
    assert!(
        body.contains("renamed_for_publish"),
        "the publish assembly stopped restoring published sheet names, so a \
         local collision rename ships upstream again"
    );
    assert!(
        body.contains("base_sheets"),
        "the published name must come from the working-copy LINK — it is the \
         only record of what the application calls the sheet"
    );
}

/// IT MUST RUN BEFORE THE NAME IS READ FOR ANYTHING ELSE. The pivot-retention
/// set is built from the workbook's sheet names, so restoring the names after
/// it would compare a restored name against a set of local ones and silently
/// drop every pivot on a renamed sheet.
///
/// SABOTAGE: move the `renamed_for_publish` block below `let published_names`.
#[test]
fn the_name_restoration_precedes_everything_that_reads_a_sheet_name() {
    let body = body_of("fn assemble_publish_workbook(");
    let restore = body
        .find("renamed_for_publish")
        .expect("the restoration is gone");
    let names = body
        .find("let published_names")
        .expect("the pivot-retention set is gone");
    assert!(
        restore < names,
        "the pivot-retention set is built from sheet names, so the restoration \
         must happen first or every pivot on a renamed sheet is dropped"
    );
}

/// A PIVOT FOLLOWS ITS SHEET. `destination_sheet` records the LOCAL tab; if the
/// sheet publishes under a different name the pivot has to be rewritten too, or
/// the published pivot names a sheet the package does not contain.
///
/// SABOTAGE: delete the `destination_sheet` rewrite.
#[test]
fn a_pivot_is_repointed_at_the_published_sheet_name() {
    let body = body_of("fn assemble_publish_workbook(");
    let rewrite = body
        .find("renamed_for_publish.get(&local)")
        .expect("the pivot destination rewrite is gone");
    let check = body
        .find("map_or(true, |name| published_names.contains")
        .expect("the pivot retention check moved");
    assert!(
        rewrite < check,
        "the pivot must be repointed BEFORE the retention check reads its \
         destination, or the rewrite happens to a pivot already dropped"
    );
}

/// SHEET NAMES ARE COMPARED CASE-INSENSITIVELY, everywhere. The lexer uppercases
/// bare identifiers, so `Data` and `data` are one name to a formula. This set
/// was matched case-SENSITIVELY, which silently dropped a pivot whose
/// `destination_sheet` was recorded as `data` from a tab spelled `Data`.
///
/// SABOTAGE: drop the `.to_ascii_lowercase()` from either side.
#[test]
fn the_pivot_retention_set_is_case_insensitive_like_every_other_name_compare() {
    let body = body_of("fn assemble_publish_workbook(");
    assert!(
        body.contains("s.name.to_ascii_lowercase()"),
        "the published-name set is case-sensitive again"
    );
    assert!(
        body.contains("published_names.contains(&name.to_ascii_lowercase())"),
        "the lookup side is case-sensitive again — both halves have to agree"
    );
}
