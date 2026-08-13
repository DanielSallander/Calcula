//! FILENAME: app/src-tauri/src/orphaned_sheet_state_tests.rs
//! PURPOSE: BUG-0041 — per-sheet state that names a sheet which does not exist.
//! CONTEXT: A child module of `persistence` (declared with `#[path]` there), so
//!          it can reach the two private id<->index helpers this is about.
//!
//! THE DEFECT, END TO END
//! ----------------------
//! Three actions found it: add a sheet, draw a sparkline on it, delete the
//! sheet. Save, reopen — and the sparkline is on ANOTHER SHEET. No error, a
//! clean save and a clean load.
//!
//! Four steps, each individually defensible, compose into silent data movement:
//!
//!   1. `cascade_sheet_removed` correctly drops the sparkline entry whose sheet
//!      index no longer resolves. (This part was never broken, which is why the
//!      object-deps census was satisfied while the bug was live — the census
//!      asked "does the cascade walk this store?" and the answer was yes.)
//!   2. The Sparklines extension then saves on SHEET_CHANGED, which also fires
//!      for a sheet COLLECTION change, and its save names the DELETED index —
//!      re-inserting exactly what step 1 removed.
//!   3. On save, `sheet_index_to_id` could not resolve that index, so it MINTED
//!      A FRESH RANDOM `SheetId`. A detectable inconsistency became an
//!      undetectable one: the entry went into the file under an id belonging to
//!      no sheet.
//!   4. On load, `sheet_id_to_index` could not find that id and answered `0`.
//!      The orphan landed on the first sheet.
//!
//! Step 3 and step 4 are the ones that matter beyond sparklines. EVERY
//! per-sheet store routes through that one pair — tables, slicers, charts,
//! conditional formats, data validation, comments, scenarios, outlines, named
//! ranges and sheet PROTECTION. Any of them, orphaned by any means, would have
//! been relocated onto sheet 0 rather than dropped.
//!
//! So the fix is at all three levels and this file pins all three:
//!   * the helpers report "no such sheet" instead of inventing one / answering 0;
//!   * every caller drops the orphan;
//!   * `save_sparklines_impl` refuses the stale write at the authority, so the
//!     orphan never enters the store in the first place.
//!
//! NON-VACUITY
//! -----------
//! Every "returns None" test here has a partner asserting the same helper still
//! answers `Some` for a sheet that DOES exist. A helper that returned `None`
//! unconditionally would satisfy the first half of each pair and lose the
//! feature; it fails the second half.

use super::*;
use crate::api_types::SparklineEntry;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn sheet_id(n: u8) -> SheetId {
    let mut bytes = [0u8; 16];
    bytes[15] = n;
    SheetId::from_bytes(bytes)
}

/// A workbook carrying `count` sheets with deterministic ids.
///
/// `Sheet::new` mints a random id, which is exactly what these tests must not
/// depend on, so each id is overwritten with a known one.
fn workbook_with_sheets(count: u8) -> persistence::Workbook {
    let mut wb = persistence::Workbook::new();
    wb.sheets = (0..count)
        .map(|i| {
            let mut sheet = persistence::Sheet::new(format!("Sheet{}", i + 1));
            sheet.id = sheet_id(i);
            sheet
        })
        .collect();
    wb
}

// ---------------------------------------------------------------------------
// The save direction: an orphan is reported, never invented
// ---------------------------------------------------------------------------

#[test]
fn an_index_past_the_last_sheet_has_no_id() {
    let ids = [sheet_id(0), sheet_id(1)];

    assert_eq!(
        sheet_index_to_id(&ids, 2),
        None,
        "index 2 of a two-sheet workbook names no sheet. This used to MINT A \
         FRESH RANDOM SheetId, which is what let an orphan be written into the \
         file under an identity that matched nothing in it — and, because the \
         id was well-formed, be read back without complaint onto sheet 0."
    );
    assert_eq!(sheet_index_to_id(&ids, 9), None);
}

#[test]
fn an_index_that_names_a_real_sheet_still_resolves() {
    let ids = [sheet_id(0), sheet_id(1)];

    // NON-VACUITY PARTNER for the test above: returning None unconditionally
    // would pass it and would stop every per-sheet object being saved at all.
    assert_eq!(sheet_index_to_id(&ids, 0), Some(sheet_id(0)));
    assert_eq!(sheet_index_to_id(&ids, 1), Some(sheet_id(1)));
}

#[test]
fn the_save_direction_no_longer_manufactures_an_identity() {
    // The precise shape of the old bug: two calls for the same out-of-range
    // index used to produce two DIFFERENT ids, both fresh, both meaningless.
    let ids = [sheet_id(0)];
    assert_eq!(sheet_index_to_id(&ids, 5), sheet_index_to_id(&ids, 5));
    assert_eq!(
        sheet_index_to_id(&ids, 5),
        None,
        "and the value they agree on is 'no such sheet', not a UUID"
    );
}

// ---------------------------------------------------------------------------
// The load direction: an unknown id is dropped, not relocated to sheet 0
// ---------------------------------------------------------------------------

#[test]
fn an_id_that_is_not_in_the_workbook_resolves_to_nothing() {
    let wb = workbook_with_sheets(3);

    assert_eq!(
        sheet_id_to_index(&wb, sheet_id(200)),
        None,
        "an id naming no sheet in this workbook used to answer 0 — THE STEP \
         THAT PUT DATA ON THE WRONG SHEET. Sheet protection, data validation \
         and conditional formatting all travel this path."
    );
}

#[test]
fn an_id_that_is_in_the_workbook_still_resolves_to_its_position() {
    let wb = workbook_with_sheets(3);

    // NON-VACUITY PARTNER: `None` for everything would pass the test above and
    // would silently drop every per-sheet object on every load.
    assert_eq!(sheet_id_to_index(&wb, sheet_id(0)), Some(0));
    assert_eq!(sheet_id_to_index(&wb, sheet_id(1)), Some(1));
    assert_eq!(sheet_id_to_index(&wb, sheet_id(2)), Some(2));
}

#[test]
fn the_two_directions_compose_into_a_dropped_orphan_not_a_moved_one() {
    // The end-to-end amplifier in one test, at the level the two helpers work.
    //
    // BEFORE: save(index 2 of a 2-sheet book) -> a fresh id -> load(that id) ->
    //         0. An object recorded on a sheet that no longer exists came back
    //         on the FIRST sheet.
    // AFTER : the save direction refuses, so nothing is written, so there is
    //         nothing for the load direction to misplace.
    let ids = [sheet_id(0), sheet_id(1)];
    let wb = workbook_with_sheets(2);

    let orphan = sheet_index_to_id(&ids, 2);
    assert_eq!(orphan, None, "the orphan is never given an identity");

    // And the load direction independently refuses an id it does not know, so
    // a file written by any other producer cannot relocate one either.
    assert_eq!(sheet_id_to_index(&wb, sheet_id(77)), None);
}

// ---------------------------------------------------------------------------
// The authority: the backend refuses stale per-sheet state at the door
// ---------------------------------------------------------------------------

/// The payload the frontend store sends for a sheet that really has a group.
fn one_group_json() -> String {
    r#"[{"id":1,"type":"line","cells":[{"row":0,"col":0}]}]"#.to_string()
}

#[test]
fn a_sparkline_save_naming_a_deleted_sheet_is_refused_and_stays_clean() {
    // `create_app_state` is a one-sheet workbook, so index 1 is exactly the
    // situation after the walk's third action: the sheet the group was drawn on
    // has been deleted, and the extension's SHEET_CHANGED save still names it.
    let state = crate::create_app_state();
    let fs = FileState::default();

    crate::sparkline_commands::save_sparklines_impl(
        &state,
        &fs,
        SparklineEntry { sheet_index: 1, groups_json: one_group_json() },
    )
    .expect("a refused write is not an error — the caller did nothing wrong");

    assert!(
        state.sparklines.read().unwrap().is_empty(),
        "the store must not hold per-sheet state for a sheet that does not \
         exist. This is the entry `cascade_sheet_removed` had just dropped, \
         being put straight back by the extension's own SHEET_CHANGED save."
    );
    assert!(
        !fs.is_dirty(),
        "and refusing changes nothing, so it must not dirty the document — a \
         spurious write must not make the close prompt fire on work nobody did"
    );
}

#[test]
fn a_sparkline_save_naming_a_real_sheet_is_still_stored() {
    // NON-VACUITY PARTNER: a guard that refused everything would pass the test
    // above and would break sparklines completely.
    let state = crate::create_app_state();
    let fs = FileState::default();

    crate::sparkline_commands::save_sparklines_impl(
        &state,
        &fs,
        SparklineEntry { sheet_index: 0, groups_json: one_group_json() },
    )
    .expect("save should succeed");

    let stored = state.sparklines.read().unwrap();
    assert_eq!(stored.len(), 1, "the real save must still land");
    assert_eq!(stored[0].sheet_index, 0);
    assert!(fs.is_dirty(), "and a real change must still dirty the document");
}

#[test]
fn the_refusal_reads_the_live_sheet_list_not_a_fixed_bound() {
    // Grow the workbook and the SAME write that was refused must now be taken.
    // A guard hard-coded to "index 0 only", or one reading a stale count, would
    // pass the refusal test and fail this one.
    let state = crate::create_app_state();
    {
        let effect = crate::document_effect::DocumentEffect::deliberately_clean(
            crate::document_effect::CleanReason::LoadingFromDisk,
        );
        state.sheet_names.write(&effect).unwrap().push("Sheet2".to_string());
    }
    let fs = FileState::default();

    crate::sparkline_commands::save_sparklines_impl(
        &state,
        &fs,
        SparklineEntry { sheet_index: 1, groups_json: one_group_json() },
    )
    .expect("save should succeed");

    assert_eq!(
        state.sparklines.read().unwrap().len(),
        1,
        "sheet index 1 exists now, so the same write must be accepted"
    );
}

// ---------------------------------------------------------------------------
// SOURCE CENSUS — the fallbacks must not come back
// ---------------------------------------------------------------------------

/// Both helpers must keep reporting absence. A future edit that restores either
/// fallback — `unwrap_or(0)` on the load side, or minting an id on the save side
/// — is a build-visible failure here rather than a field report, because neither
/// fallback produces an error, a log line or a wrong-looking value at runtime.
#[test]
fn neither_helper_may_regain_a_silent_fallback() {
    let source = include_str!("persistence.rs");

    let save_sig = "fn sheet_index_to_id(sheet_ids: &[SheetId], index: usize) -> Option<SheetId>";
    let load_sig =
        "fn sheet_id_to_index(workbook: &persistence::Workbook, sheet_id: SheetId) -> Option<usize>";

    assert!(
        source.contains(save_sig),
        "sheet_index_to_id must return Option<SheetId>. Returning a bare SheetId \
         means an out-of-range index is being answered with an invented one."
    );
    assert!(
        source.contains(load_sig),
        "sheet_id_to_index must return Option<usize>. Returning a bare usize \
         means an unknown id is being answered with a sheet position — and 0 is \
         the one it used to answer."
    );

    // ...and neither BODY may fall back.
    //
    // Scoped to the two functions rather than searched over the whole file, and
    // that distinction is not pedantry: `persistence.rs` mints a fresh
    // `SheetId` in two other places for good reasons (a sheet that exists but
    // has no registered id, and File > New's blank document). A file-wide
    // search for the minting expression flags both and says nothing about the
    // defect — it was tried here first and fired on exactly those two.
    assert!(
        !body_of(source, save_sig).contains("unwrap_or"),
        "sheet_index_to_id must not fall back. Any `unwrap_or*` here is an \
         answer invented for an index that names no sheet — the original minted \
         a fresh SheetId, and the orphan went into the file under an identity \
         matching nothing in it."
    );
    assert!(
        !body_of(source, load_sig).contains("unwrap_or"),
        "sheet_id_to_index must not fall back. Any `unwrap_or*` here answers an \
         unknown id with a sheet POSITION, and `unwrap_or(0)` is the one it used \
         to answer — the step that moved data onto another sheet."
    );
}

/// The body of a top-level function, from its signature to the closing brace in
/// column 0. Used instead of a file-wide text search so the census can speak
/// about ONE function.
fn body_of<'a>(source: &'a str, signature: &str) -> &'a str {
    let start = source
        .find(signature)
        .unwrap_or_else(|| panic!("signature not found in persistence.rs: {signature}"));
    let after = &source[start + signature.len()..];
    let end = after
        .find("\n}")
        .unwrap_or_else(|| panic!("unterminated function: {signature}"));
    &after[..end]
}

/// NON-VACUITY for the census above: the detector must be capable of failing.
/// A census that searched a string it could never find would pass forever.
#[test]
fn the_source_census_actually_reads_the_file_it_names() {
    let source = include_str!("persistence.rs");

    assert!(
        source.contains("fn sheet_index_to_id"),
        "the census reads persistence.rs and must find the helper it is about; \
         if this fails the file moved and the census above is checking nothing"
    );
    assert!(
        source.contains("fn sheet_id_to_index"),
        "same, for the load direction"
    );
    assert!(
        !source.contains("fn a_function_name_that_is_not_in_persistence_rs"),
        "and it must not match text that is absent, or `contains` is not \
         discriminating and both assertions above are meaningless"
    );

    // THE DETECTOR MUST BE ABLE TO FIRE. `body_of` is given a function that
    // really does carry a fallback, and must report it — otherwise the two
    // `!contains("unwrap_or")` assertions above would pass no matter what was
    // written in the helpers.
    let planted = "fn planted(a: &[u8]) -> u8 {\n    a.first().copied().unwrap_or(0)\n}\n";
    assert!(
        body_of(planted, "fn planted(a: &[u8]) -> u8 {").contains("unwrap_or"),
        "the census extracts a function body and looks for a fallback in it; if \
         it cannot see one that is plainly there, it is checking nothing"
    );

    // ...and must not bleed into the NEXT function, which is the way a
    // body-extracting census usually goes wrong: too greedy, and every body
    // contains every later body's text.
    let two = "fn first() -> u8 {\n    1\n}\n\nfn second() -> u8 {\n    unwrap_or_marker\n}\n";
    assert!(
        !body_of(two, "fn first() -> u8 {").contains("unwrap_or_marker"),
        "the extraction must stop at the first closing brace in column 0, or a \
         clean function inherits the next one's text and the census fires wrongly"
    );
}
