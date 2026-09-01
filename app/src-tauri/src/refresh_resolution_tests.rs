//! FILENAME: app/src-tauri/src/refresh_resolution_tests.rs
//! PURPOSE: The refresh resolver's three load-bearing properties, which are all
//! properties of ORDER and PLACEMENT rather than of arithmetic.
//!
//! CONTEXT: Reported from live testing as "I clicked refresh subscription and
//! nothing happened", which turned out to be refresh answering a different
//! question (is there a NEWER version?) than the one asked (put the published
//! values back). Fixing the front door meant making Apply a decision the user
//! actually makes, and that put three new ways to be silently wrong into a
//! command that had none:
//!
//!   1. Resolve in the wrong place and "take theirs" paints the local value back
//!      over the publisher's, reporting success.
//!   2. Construct the DocumentEffect too early and a refresh that does nothing
//!      still arms the close-without-saving prompt.
//!   3. Announce nothing and a refresh that ADDS a sheet leaves the tab bar
//!      showing the old list — the same class of defect as the phantom tab.
//!
//! These are source-placement guards. What regressed here is the SHAPE of one
//! very long command, and a behavioural test of it needs a signed workspace on
//! disk and a Tauri `Window`; the ordering is what these pin, and each names the
//! one-line change that makes it red.

/// The body of one function, comment-stripped.
///
/// COMMENTS ARE STRIPPED, and not for tidiness: every guard below is documented
/// AT its site with a comment that names the thing it is ordered against, so a
/// scanner that reads comments finds the phrase in the explanation and reports
/// the correct file as broken.
fn body_of(signature: &str) -> String {
    let src = include_str!("calp_commands.rs");
    let start = src.find(signature).unwrap_or_else(|| {
        panic!("signature not found: {}", signature);
    });
    let rest = &src[start..];
    let end = rest.find("\n}\n").unwrap_or(rest.len());
    strip_line_comments(&rest[..end])
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

/// Byte offset of `needle` in `hay`, or a panic naming what was missing.
fn at(hay: &str, needle: &str, what: &str) -> usize {
    hay.find(needle)
        .unwrap_or_else(|| panic!("{} is gone (looked for `{}`)", what, needle))
}

// ---------------------------------------------------------------------------
// A. The resolution must land in the one window where it means anything
// ---------------------------------------------------------------------------

/// THE ORDERING THAT MAKES "TAKE THEIRS" REAL.
///
/// `apply_refresh` runs `rebase`, which is what SETS `conflict` and
/// `upstream_new`; before it there is nothing to resolve. `to_overlay` is then
/// snapshotted — a CLONE of the surviving overrides — and painted onto the grids
/// forty lines later. An `accept_upstream` after that snapshot removes the
/// override from the layer and changes nothing about the clone, so the local
/// value is still painted over the pristine upstream content: the user picks
/// "take theirs", the dialog says so, and they get "mine".
///
/// SABOTAGE: move the `for r in &resolutions` loop below the `let to_overlay`
/// line. Nothing fails to compile and no count changes — only the grid is wrong.
#[test]
fn the_resolution_loop_sits_between_the_rebase_and_the_overlay_snapshot() {
    let body = body_of("pub fn calp_refresh_apply(");
    let rebase = at(&body, "calp::refresh::apply_refresh(", "the apply_refresh call");
    let loop_at = at(&body, "for r in &resolutions", "the resolution loop");
    let snapshot = at(&body, "let to_overlay", "the to_overlay snapshot");

    assert!(
        rebase < loop_at,
        "the resolution loop must run AFTER apply_refresh: rebase is what sets \
         `conflict` and `upstream_new`, so above it `keep_override` returns false \
         and an accept has no upstream value to accept"
    );
    assert!(
        loop_at < snapshot,
        "the resolution loop must run BEFORE `to_overlay` is collected. That \
         vector is a CLONE painted onto the grids much later; resolving after it \
         removes the override from the layer and repaints the local value anyway"
    );
}

/// The two verbs are the ones the Overrides pane already uses. A third spelling
/// of "discard the local value" would be a second source of truth about what
/// resolution means, and the pane and the dialog would drift.
///
/// SABOTAGE: replace `layer.accept_upstream(...)` with `layer.remove_override(...)`.
/// It behaves identically today and stops tracking the pane's verb.
#[test]
fn resolution_goes_through_the_override_layers_own_verbs() {
    let body = body_of("pub fn calp_refresh_apply(");
    assert!(
        body.contains("layer.accept_upstream("),
        "take-theirs stopped using OverrideLayer::accept_upstream"
    );
    assert!(
        body.contains("layer.keep_override("),
        "keep-mine stopped using OverrideLayer::keep_override"
    );
}

/// NO SECOND LOCK INSIDE THE CRITICAL SECTION. `layer` is a live `Persisted<T>`
/// guard — a std::sync::Mutex, not reentrant — from before `apply_refresh` until
/// after the overlay. Re-acquiring `state.override_layer` in the resolution loop
/// would block this thread forever, which is the rule
/// `apply_override_value_to_grid` documents for the same reason.
///
/// SABOTAGE: write the loop as
/// `state.override_layer.write(&effect)?.accept_upstream(...)`.
#[test]
fn the_resolution_loop_reuses_the_guard_it_is_already_holding() {
    let body = body_of("pub fn calp_refresh_apply(");
    let loop_start = at(&body, "for r in &resolutions", "the resolution loop");
    let loop_end = at(&body, "let to_overlay", "the to_overlay snapshot");
    let section = &body[loop_start..loop_end];
    assert!(
        !section.contains("override_layer"),
        "the resolution loop acquires `state.override_layer` while `layer` is \
         still alive — a non-reentrant Mutex, so this deadlocks rather than fails"
    );
}

// ---------------------------------------------------------------------------
// B. Nothing to do is not a mutation
// ---------------------------------------------------------------------------

/// A REFRESH THAT FINDS NO UPDATE MUST LEAVE THE DOCUMENT CLEAN.
///
/// `DocumentEffect::mutates` dirties AT CONSTRUCTION, and this command used to
/// build it as its first statement. So the exact gesture the user reported —
/// open an up-to-date workbook, click "Refresh Subscriptions", get "All
/// subscriptions are up to date" — armed the close-without-saving prompt for a
/// command that wrote nothing.
///
/// Moving the construction alone is NOT enough and that is why the early return
/// is asserted too: the reset-then-apply blocks further down consume `effect`
/// unconditionally.
///
/// SABOTAGE: delete the `if payloads.is_empty()` early return, or move the
/// `let effect` line back above the payload pull.
#[test]
fn an_empty_refresh_does_not_dirty_the_document() {
    let body = body_of("pub fn calp_refresh_apply(");
    let early_return = at(&body, "if payloads.is_empty()", "the empty-refresh early return");
    let effect = at(
        &body,
        "let effect = crate::document_effect::DocumentEffect::mutates(&file_state);",
        "the DocumentEffect construction",
    );
    assert!(
        early_return < effect,
        "the early return must come FIRST: `mutates` dirties at construction, so \
         a refresh with no updates would arm the close prompt for a command that \
         writes nothing"
    );

    // And the effect is constructed after the pull, which is the last thing that
    // can still refuse.
    let pull = at(&body, "pull_all_updates", "the pull");
    assert!(
        pull < effect,
        "the effect must be constructed after every refusal that precedes a write"
    );
}

/// EXACTLY ONE ARM. The repo rule is one `DocumentEffect` per command; adding a
/// second for the resolution work would be two claims about the same mutation.
///
/// SABOTAGE: construct a second `mutates` for the resolution loop.
#[test]
fn refresh_apply_constructs_exactly_one_document_effect() {
    let body = body_of("pub fn calp_refresh_apply(");
    let n = body.matches("DocumentEffect::mutates(").count();
    assert_eq!(n, 1, "expected exactly one `mutates` arm, found {}", n);
}

// ---------------------------------------------------------------------------
// C. A refresh that changes the sheet list says so
// ---------------------------------------------------------------------------

/// THE TAB BAR HAS TO HEAR ABOUT IT. This command appends sheets — `grids.push`
/// / `sheet_names.push` / `sheet_ids.push` — and for as long as it existed it
/// emitted nothing but `custom-functions:refresh`. `SheetTabs` reloads its list
/// on the `sheets` domain, so a refresh that added a sheet reported "1 added" in
/// the dialog while the tab bar showed the old list until some unrelated click
/// happened to re-fire SHEET_CHANGED.
///
/// Both siblings get this right: SubscribeDialog and the reset handler each
/// announce. Refresh was the only one that did not.
///
/// SABOTAGE: delete the `announce_cascade` call.
#[test]
fn a_refresh_announces_the_sheet_collection_it_changed() {
    let body = body_of("pub fn calp_refresh_apply(");
    assert!(
        body.contains("announce_cascade("),
        "calp_refresh_apply appends sheets and announces nothing — the tab bar \
         keeps the previous list"
    );
    assert!(
        body.contains("ObjectKind::Sheet"),
        "the announcement must name the SHEET domain; that is what SheetTabs listens on"
    );
}

/// AFTER the recalculation, never before. The announcement makes the frontend
/// re-read the sheet list and refetch the grid, and refetching mid-recalc shows
/// half-evaluated cells.
///
/// SABOTAGE: move the `announce_cascade` call above the recalc block.
#[test]
fn the_announcement_comes_after_the_recalculation() {
    let body = body_of("pub fn calp_refresh_apply(");
    let recalc = at(
        &body,
        "crate::calculation::recalculate_sheet_values",
        "the recalculation",
    );
    let announce = at(&body, "announce_cascade(", "the sheet announcement");
    assert!(
        recalc < announce,
        "announcing before the recalculation makes the canvas refetch \
         half-evaluated cells"
    );
}

// ---------------------------------------------------------------------------
// D. The preview asks the same question the apply answers
// ---------------------------------------------------------------------------

/// The preview cannot resolve an override's position without the id registry,
/// and the registry is app state that `core/calp` cannot see. If this command
/// stops handing it over, `compute_preview` silently falls back to the override's
/// RECORDED position and starts reading the wrong upstream cell — which is a
/// conflict list that is wrong rather than absent.
///
/// SABOTAGE: pass `&HashMap::new()` instead of `&override_positions`.
#[test]
fn the_preview_is_handed_the_positions_the_apply_will_use() {
    let body = body_of("pub fn calp_refresh_preview(");
    assert!(
        body.contains("cell_position("),
        "the preview stopped resolving override positions through the id registry"
    );
    assert!(
        body.contains("&override_positions"),
        "the resolved positions are no longer passed to compute_preview"
    );
}

/// The id-registry lock must be RELEASED before the workspace loop: it is a bare
/// `Mutex` on the grid write path, and the loop below does workspace I/O that
/// can be a remote transport.
///
/// SABOTAGE: hoist `let id_reg = ...` out of its block so the guard lives across
/// the loop.
#[test]
fn the_preview_releases_the_id_registry_before_it_touches_a_workspace() {
    let body = body_of("pub fn calp_refresh_preview(");
    let id_lock = at(&body, "state.id_registry.lock()", "the id registry lock");
    let workspace = at(
        &body,
        "open_workspace_scoped",
        "the workspace open in the group loop",
    );
    let scope_end = at(&body, "let mut merged", "the end of the position-map block");
    assert!(
        id_lock < scope_end && scope_end < workspace,
        "the id_registry guard must be dropped before the workspace loop — it is \
         a bare Mutex on the grid write path and the loop can do network I/O"
    );
}
