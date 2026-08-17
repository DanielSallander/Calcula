//! FILENAME: app/src-tauri/src/commands/spill_persistence_tests.rs
//! PURPOSE: §2ab — a dynamic array's OWNERSHIP survives a save and a reload.
//!
//! A child module of `commands::data` (declared with `#[path]` there) so it
//! reaches `recalc_after_active_sheet_bulk_rewrite` and the `Workbook` harness
//! `cross_sheet_recalc_tests` owns. Reusing that harness rather than copying
//! one is the rule this whole family follows: a copied harness drifts, and a
//! drifted harness is how this class of defect hides.
//!
//! # What these tests do that the §2y tests do not
//!
//! §2y's tests reproduce the reload STATE (maps empty, values present). These
//! do a REAL `.cala` round trip: `write_calcula_bytes` -> ZIP bytes ->
//! `read_calcula_bytes`, through the same serialiser `save_file` and
//! `open_file` use, so the `sp` field, its `format_version` stamp and the
//! restore that reads it are all exercised on the actual archive.
//!
//! # The defect, and what "fixed" means
//!
//! Before this, `.cala` stored a dynamic array's spilled cells as ordinary
//! literals and stored NOTHING about which origin owned them, while
//! `reset_document_scoped_stores` cleared the spill map on every open. The
//! reopened workbook looked right and was not: the array was owned by nothing,
//! its cells were individually editable, and the first re-evaluation of the
//! origin found its own footprint occupied by values it no longer owned and
//! collapsed the whole array to `#VALUE!`. F9 appeared to repair it and did
//! not — and when the array's LENGTH had changed since the save, F9 left the
//! stale literals sitting under a live origin, presented as that origin's
//! output.
//!
//! Fixed means: the extent round-trips (`SavedCell::spill` -> the `sp` field ->
//! back), the map comes back on load, and the origin survives re-evaluation.

use super::cross_sheet_recalc_tests::{body_of, Workbook};
use super::*;
use engine::{CellError, CellValue};

// ---------------------------------------------------------------------------
// Harness: a REAL .cala round trip on the harness workbook
// ---------------------------------------------------------------------------

/// Build the `persistence::Workbook` a save would build, spill extents and all.
///
/// This is `build_workbook_for_save`'s cell half: the same `Sheet::from_grid`
/// followed by the same `apply_spill_extents_to_sheet`. It cannot call that
/// function itself — it takes `State<AppState>`, which cannot be constructed
/// in-process — so `the_save_path_still_stamps_spill_extents` pins from source
/// that the real one still does these two things in this order.
fn workbook_for_save(wb: &Workbook) -> persistence::Workbook {
    let styles = wb.state.style_registry.read().unwrap();
    let names = wb.state.sheet_names.read().unwrap();
    let ids = wb.state.sheet_ids.read().unwrap();
    let active = *wb.state.active_sheet.read().unwrap();
    let mirror = wb.state.grid.read().unwrap();
    let grids = wb.state.grids.read().unwrap();
    let dimensions = persistence::DimensionData::default();

    let mut workbook = persistence::Workbook::new();
    workbook.sheets.clear();
    for i in 0..names.len() {
        // The active-sheet MIRROR is the source of truth; grids[i] may lag it.
        // `build_workbook_for_save` makes the same choice.
        let grid_ref = if i == active { &*mirror } else { &grids[i] };
        let mut sheet =
            persistence::Sheet::from_grid(ids[i], names[i].clone(), grid_ref, &styles, &dimensions);
        crate::persistence::apply_spill_extents_to_sheet(&wb.state, &mut sheet, i);
        workbook.sheets.push(sheet);
    }
    workbook
}

/// Save to real `.cala` bytes and read them back — the whole archive, not a
/// hand-built struct.
pub(super) fn round_trip(wb: &Workbook) -> persistence::Workbook {
    let saved = workbook_for_save(wb);
    let bytes = calcula_format::write_calcula_bytes(&saved).expect("write_calcula_bytes failed");
    calcula_format::read_calcula_bytes(&bytes).expect("read_calcula_bytes failed")
}

/// The `format_version` the archive was stamped with.
fn stamped_version(wb: &Workbook) -> u32 {
    let saved = workbook_for_save(wb);
    let bytes = calcula_format::write_calcula_bytes(&saved).expect("write_calcula_bytes failed");
    calcula_format::read_calcula_manifest(&bytes)
        .expect("read_calcula_manifest failed")
        .format_version
}

/// Everything `open_file` does to the stores these tests observe: clear the
/// spill maps (which `reset_document_scoped_stores` does for the OUTGOING
/// document), install the incoming grids and styles, then restore the spill
/// ownership.
///
/// `open_file` is a `#[tauri::command]` and cannot be invoked in-process, so
/// this reproduces its sequence and
/// `the_open_path_still_restores_the_spill_map` pins from source that the real
/// one still calls the restore.
pub(super) fn reopen(wb: &Workbook, loaded: &persistence::Workbook) {
    let effect = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::LoadingFromDisk,
    );

    // --- reset_document_scoped_stores, the two lines this file is about ---
    wb.state.spill_ranges.write(&crate::document_effect::test_seed_effect()).unwrap().clear();
    wb.state.spill_hosts.lock().unwrap().clear();

    // --- the incoming document's grids and styles -------------------------
    {
        let mut shared_styles = engine::style::StyleRegistry::new();
        let mut all_grids: Vec<engine::Grid> = Vec::with_capacity(loaded.sheets.len());
        for sheet in &loaded.sheets {
            let (mut grid, local_styles) = sheet.to_grid();
            let remap = shared_styles.merge_remap(&local_styles);
            grid.remap_style_indices(&remap);
            all_grids.push(grid);
        }
        let active = *wb.state.active_sheet.read().unwrap();
        *wb.state.grid.write(&effect).unwrap() = all_grids[active].clone();
        *wb.state.grids.write(&effect).unwrap() = all_grids;
        *wb.state.style_registry.write(&effect).unwrap() = shared_styles;
        wb.state.dependents.lock().unwrap().clear();
    }
    crate::undo_commands::rebuild_all_dependencies(&wb.state);

    // --- the half that did not exist ---------------------------------------
    crate::spill_restore::restore_spill_map_on_load(
        &wb.state,
        &wb.files,
        &loaded.sheets,
        loaded.format_version,
    );
}

/// The spill map as `get_spill_ranges` would report it.
fn spill_ranges_of(wb: &Workbook) -> Vec<((usize, u32, u32), Vec<(u32, u32)>)> {
    let mut out: Vec<((usize, u32, u32), Vec<(u32, u32)>)> = wb
        .state
        .spill_ranges
        .write(&crate::document_effect::test_seed_effect())
        .unwrap()
        .iter()
        .map(|(k, v)| {
            let mut cells = v.clone();
            cells.sort_unstable();
            (*k, cells)
        })
        .collect();
    out.sort_unstable();
    out
}

fn spill_hosts_of(wb: &Workbook) -> Vec<((usize, u32, u32), (u32, u32))> {
    let mut out: Vec<((usize, u32, u32), (u32, u32))> = wb
        .state
        .spill_hosts
        .lock()
        .unwrap()
        .iter()
        .map(|(k, v)| (*k, *v))
        .collect();
    out.sort_unstable();
    out
}

/// Re-evaluate the origin through the SHARED cascade — the gesture that used to
/// destroy the array. `recalc_after_active_sheet_bulk_rewrite` is what every
/// bulk rewrite ends at, and `reevaluate_formula_cell` under it is the only
/// function in the crate that writes the spill map.
fn recalc_origin(wb: &Workbook, row: u32, col: u32) {
    let mut updated = Vec::new();
    recalc_after_active_sheet_bulk_rewrite(
        &wb.state,
        &wb.files,
        &wb.pane,
        &wb.filters,
        &[(row, col)],
        &mut updated,
    );
}

/// `B1 = 4`, `A1 = "=SEQUENCE(B1)"` — an array whose LENGTH is a cell, so a
/// test can change it and watch what the reload does about the difference.
fn workbook_with_a_sized_spill(length: f64) -> Workbook {
    let wb = Workbook::new(2);
    wb.set(0, 1, &length.to_string());
    wb.set(0, 0, "=SEQUENCE(B1)");
    assert_eq!(
        wb.value(0, 0, 0),
        CellValue::Number(1.0),
        "precondition: A1 did not spill, so nothing below tests what it claims"
    );
    wb
}

// ---------------------------------------------------------------------------
// 1. The round trip
// ---------------------------------------------------------------------------

/// THE CORE CLAIM. Save an array, read the bytes back, and the map is there.
#[test]
fn a_saved_array_carries_its_extent_and_the_map_comes_back() {
    let wb = workbook_with_a_sized_spill(4.0);
    assert_eq!(
        spill_ranges_of(&wb),
        vec![((0, 0, 0), vec![(1, 0), (2, 0), (3, 0)])]
    );

    // The extent is on the ORIGIN, and only on the origin.
    let saved = workbook_for_save(&wb);
    assert_eq!(
        saved.sheets[0].cells[&(0, 0)].spill,
        Some((3, 0)),
        "A1 must carry the bottom-right of A1:A4"
    );
    for cell in [(1, 0), (2, 0), (3, 0), (0, 1)] {
        assert_eq!(
            saved.sheets[0].cells[&cell].spill, None,
            "{:?} is not an origin and must carry no extent",
            cell
        );
    }

    // ...and it survives the ZIP.
    let loaded = round_trip(&wb);
    assert_eq!(loaded.sheets[0].cells[&(0, 0)].spill, Some((3, 0)));

    reopen(&wb, &loaded);
    assert_eq!(
        spill_ranges_of(&wb),
        vec![((0, 0, 0), vec![(1, 0), (2, 0), (3, 0)])],
        "the reopened workbook must own its array again"
    );
    assert_eq!(
        spill_hosts_of(&wb),
        vec![
            ((0, 1, 0), (0, 0)),
            ((0, 2, 0), (0, 0)),
            ((0, 3, 0), (0, 0)),
        ],
        "every spilled cell must name its origin, which is what protects it"
    );
}

/// §2ab's exact sequence, on the fixed build. The edit that used to kill the
/// array does not change a single value — it writes `4` over a cell that
/// already holds `4` — and that was enough.
#[test]
fn the_2ab_reproduction_start_to_finish() {
    let wb = workbook_with_a_sized_spill(4.0);
    let loaded = round_trip(&wb);
    reopen(&wb, &loaded);

    // 2. Reopened: the values are back AND so is the ownership.
    for (row, expected) in [(0, 1.0), (1, 2.0), (2, 3.0), (3, 4.0)] {
        assert_eq!(wb.value(0, row, 0), CellValue::Number(expected));
    }
    assert!(!spill_ranges_of(&wb).is_empty(), "the map must not be empty");

    // 3. The touch that used to collapse it: rewrite B1 with the SAME value.
    wb.set(0, 1, "4");
    assert_eq!(
        wb.value(0, 0, 0),
        CellValue::Number(1.0),
        "re-evaluating the origin after a reload must not produce #VALUE!"
    );
    assert_eq!(wb.value(0, 3, 0), CellValue::Number(4.0));
    assert_eq!(
        spill_ranges_of(&wb),
        vec![((0, 0, 0), vec![(1, 0), (2, 0), (3, 0)])]
    );

    // 5. ...and again, because the old failure repeated indefinitely.
    wb.set(0, 1, "4");
    assert_eq!(wb.value(0, 0, 0), CellValue::Number(1.0));
    assert_eq!(
        spill_ranges_of(&wb),
        vec![((0, 0, 0), vec![(1, 0), (2, 0), (3, 0)])]
    );
}

/// The SHARED CASCADE, called directly on a reopened workbook — the same entry
/// point `spill_map_tests`'s characterisation test used to prove the collapse.
/// Nothing about the workbook changed; the origin was merely re-evaluated,
/// which is what an edit to any precedent does.
#[test]
fn re_evaluating_a_reopened_origin_through_the_shared_cascade_keeps_the_array() {
    let wb = workbook_with_a_sized_spill(4.0);
    let loaded = round_trip(&wb);
    reopen(&wb, &loaded);

    recalc_origin(&wb, 0, 0);

    assert_eq!(
        wb.value(0, 0, 0),
        CellValue::Number(1.0),
        "the origin collapsed to an error on a bare re-evaluation — §2ab is back"
    );
    for (row, expected) in [(1, 2.0), (2, 3.0), (3, 4.0)] {
        assert_eq!(wb.value(0, row, 0), CellValue::Number(expected));
    }
    assert_eq!(
        spill_ranges_of(&wb),
        vec![((0, 0, 0), vec![(1, 0), (2, 0), (3, 0)])]
    );
}

/// A reopened array is PROTECTED, which is the half a user notices first.
/// Typing into a spilled cell is refused, and the refusal names the origin.
#[test]
fn a_reopened_array_refuses_an_edit_to_one_of_its_cells() {
    let wb = workbook_with_a_sized_spill(4.0);
    let loaded = round_trip(&wb);
    reopen(&wb, &loaded);

    let spill_hosts = wb.state.spill_hosts.lock().unwrap();
    let err = check_spill_protection(&spill_hosts, 0, 2, 0, 2, 0, SpillOriginPolicy::Refuse)
        .expect_err("A3 is a spilled cell of a reopened array and must refuse an edit");
    drop(spill_hosts);
    assert!(
        err.contains("A1"),
        "the refusal must name the origin so the user knows what to edit: {}",
        err
    );
}

// ---------------------------------------------------------------------------
// 2. The array's LENGTH changed since the save
// ---------------------------------------------------------------------------

/// THE WORST OUTCOME §2ab NAMED, and the one an error value would have been
/// better than: with the map gone, an origin re-evaluated to a SHORTER array
/// left the tail literals on the grid, presented as part of its output.
///
/// With the extent restored the tear-down knows exactly which cells were the
/// array's and erases the ones the new array does not reach.
#[test]
fn an_array_that_shrinks_after_a_reload_erases_the_cells_it_gave_up() {
    let wb = workbook_with_a_sized_spill(4.0);
    let loaded = round_trip(&wb);
    reopen(&wb, &loaded);

    wb.set(0, 1, "2");

    assert_eq!(wb.value(0, 0, 0), CellValue::Number(1.0));
    assert_eq!(wb.value(0, 1, 0), CellValue::Number(2.0));
    assert_eq!(
        wb.value(0, 2, 0),
        CellValue::Empty,
        "A3 was the old array's third cell and must be erased, not left as a \
         stale literal under a live origin"
    );
    assert_eq!(wb.value(0, 3, 0), CellValue::Empty, "A4, likewise");
    assert_eq!(
        spill_ranges_of(&wb),
        vec![((0, 0, 0), vec![(1, 0)])],
        "the map must shrink with the array"
    );
}

/// The other direction: a reopened array that GROWS takes the cells it needs,
/// which it can only do because it owns the ones it already had.
#[test]
fn an_array_that_grows_after_a_reload_takes_the_cells_it_needs() {
    let wb = workbook_with_a_sized_spill(3.0);
    let loaded = round_trip(&wb);
    reopen(&wb, &loaded);

    wb.set(0, 1, "5");

    for (row, expected) in [(0, 1.0), (1, 2.0), (2, 3.0), (3, 4.0), (4, 5.0)] {
        assert_eq!(
            wb.value(0, row, 0),
            CellValue::Number(expected),
            "row {} of the grown array",
            row
        );
    }
    assert_eq!(
        spill_ranges_of(&wb),
        vec![((0, 0, 0), vec![(1, 0), (2, 0), (3, 0), (4, 0)])]
    );
}

// ---------------------------------------------------------------------------
// 3. The origin can no longer produce the array
// ---------------------------------------------------------------------------

/// A precedent came back `#REF!`, the function changed, the build has a
/// different function set — whatever the cause, the origin no longer produces
/// an array. Excel's answer is that the array is torn down and the origin shows
/// its error; what must NOT happen is the old literals staying on the grid
/// beside it, which is exactly what an empty map produced.
///
/// Driven here by replacing the origin's formula with one that cannot spill.
#[test]
fn an_origin_that_stops_producing_an_array_takes_its_old_cells_with_it() {
    let wb = workbook_with_a_sized_spill(4.0);
    let loaded = round_trip(&wb);
    reopen(&wb, &loaded);

    wb.set(0, 0, "=B1*10");

    assert_eq!(wb.value(0, 0, 0), CellValue::Number(40.0));
    for row in 1..=3 {
        assert_eq!(
            wb.value(0, row, 0),
            CellValue::Empty,
            "row {} held the old array and must be erased, not left orphaned",
            row
        );
    }
    assert!(
        spill_ranges_of(&wb).is_empty() && spill_hosts_of(&wb).is_empty(),
        "the map must let go of an origin that no longer spills"
    );
}

/// A DEPENDENCY that can no longer produce the array — `SEQUENCE`'s length
/// argument became text. Excel shows `#VALUE!` on the origin and takes the
/// spill down with it; what must NOT happen is the old numbers staying on the
/// grid beside the error, which is what an empty map produced.
#[test]
fn an_origin_whose_dependency_broke_reports_the_error_and_releases_its_cells() {
    let wb = workbook_with_a_sized_spill(4.0);
    let loaded = round_trip(&wb);
    reopen(&wb, &loaded);

    wb.set(0, 1, "not a number");

    assert_eq!(
        wb.value(0, 0, 0),
        CellValue::Error(CellError::Value),
        "SEQUENCE of a non-number must report an error on the origin"
    );
    for row in 1..=3 {
        assert_eq!(
            wb.value(0, row, 0),
            CellValue::Empty,
            "row {} must not keep the dead array's value beside a #VALUE! origin",
            row
        );
    }
    assert!(spill_ranges_of(&wb).is_empty() && spill_hosts_of(&wb).is_empty());
}

/// A WORKBOOK WRITTEN BY A BUILD WITH A DIFFERENT FUNCTION SET — the brief's
/// third failure mode, and the one whose answer is NOT the obvious one.
///
/// An unknown function name is not an error here: `preserved_udf_value`
/// (evaluator.rs) deliberately keeps the cell's last stored value rather than
/// clobbering a working custom function to `#NAME?` on an unrelated recalc.
/// That is right for a scalar UDF and it is what makes this case worth pinning,
/// because it means the ORIGIN keeps a stale-looking number.
///
/// What the restored map buys is the other half: the preserved value is a
/// SCALAR, so the tear-down runs and the array's other cells are released
/// rather than left behind as orphan literals under it. Before this, they
/// stayed — and stayed uneditable and undeletable, naming an origin that no
/// longer produced them.
#[test]
fn an_origin_whose_function_this_build_lacks_still_releases_its_cells() {
    let wb = workbook_with_a_sized_spill(4.0);
    let loaded = round_trip(&wb);
    reopen(&wb, &loaded);

    wb.set(0, 0, "=NOT_A_REAL_FUNCTION_AT_ALL(1)");

    assert_eq!(
        wb.value(0, 0, 0),
        CellValue::Number(1.0),
        "an unknown function preserves the cell's last value (see          `preserved_udf_value`); if this becomes #NAME? that is a deliberate          change and this test should follow it, not be deleted"
    );
    for row in 1..=3 {
        assert_eq!(
            wb.value(0, row, 0),
            CellValue::Empty,
            "row {} is no longer produced by anything and must be released",
            row
        );
    }
    assert!(
        spill_ranges_of(&wb).is_empty() && spill_hosts_of(&wb).is_empty(),
        "the map must let go even when the origin's value was preserved"
    );
}

// ---------------------------------------------------------------------------
// 4. The format-version chain
// ---------------------------------------------------------------------------

/// The stamp is CONDITIONAL, so a workbook with no dynamic array is still
/// openable by a build that predates the extent. Same rule the user-hidden
/// sets, the view state and the display flags follow.
#[test]
fn only_a_workbook_with_an_array_is_stamped_v7() {
    let plain = Workbook::new(1);
    plain.set(0, 0, "42");
    plain.set(0, 1, "=A1*2");
    assert!(
        stamped_version(&plain) < calcula_format::SPILL_EXTENT_MIN_FORMAT_VERSION,
        "a workbook with no array must not be stamped for the extent"
    );

    let spilled = workbook_with_a_sized_spill(4.0);
    assert_eq!(
        stamped_version(&spilled),
        calcula_format::SPILL_EXTENT_MIN_FORMAT_VERSION,
        "a workbook with an array must be stamped so an older build refuses it \
         rather than silently dropping the extent on its next save"
    );
}

/// The chain's own invariant: the newest link must be readable by this build.
#[test]
fn the_extent_link_is_within_what_this_build_reads() {
    assert!(
        calcula_format::SPILL_EXTENT_MIN_FORMAT_VERSION
            <= calcula_format::CALA_MAX_SUPPORTED_FORMAT_VERSION
    );
    assert!(
        calcula_format::SPILL_EXTENT_MIN_FORMAT_VERSION
            > calcula_format::SHEET_DISPLAY_FLAGS_MIN_FORMAT_VERSION,
        "a new link must be ABOVE the previous one — sharing a version means an \
         older build that stamps the previous one drops the new section"
    );
}

// ---------------------------------------------------------------------------
// 5. The legacy corpus: files written BEFORE the extent existed
// ---------------------------------------------------------------------------

/// THE EXISTING CORPUS. A `.cala` written by the pre-extent build carries the
/// spilled literals and nothing that says who owns them. The recovery pass
/// proves each array against the file's own values and claims only what it can
/// prove.
///
/// The legacy file is produced by taking a real saved workbook and STRIPPING
/// the extents — byte for byte what the previous build wrote, because
/// `SavedCell::spill` is the only field it did not have.
#[test]
fn a_pre_extent_workbook_recovers_its_spill_map_by_evaluation() {
    let wb = workbook_with_a_sized_spill(4.0);
    let mut legacy = workbook_for_save(&wb);
    for sheet in &mut legacy.sheets {
        for cell in sheet.cells.values_mut() {
            cell.spill = None;
        }
    }
    let bytes = calcula_format::write_calcula_bytes(&legacy).unwrap();
    assert!(
        calcula_format::read_calcula_manifest(&bytes)
            .unwrap()
            .format_version
            < calcula_format::SPILL_EXTENT_MIN_FORMAT_VERSION,
        "stripping the extents must drop the stamp back below the gate, which \
         is what routes this file to the recovery"
    );
    let loaded = calcula_format::read_calcula_bytes(&bytes).unwrap();
    assert_eq!(
        loaded.sheets[0].cells[&(0, 0)].spill, None,
        "precondition: this file carries no extent"
    );

    reopen(&wb, &loaded);

    assert_eq!(
        spill_ranges_of(&wb),
        vec![((0, 0, 0), vec![(1, 0), (2, 0), (3, 0)])],
        "the recovery must re-derive the ownership the file never recorded"
    );

    // ...and the recovered array behaves like a restored one.
    wb.set(0, 1, "2");
    assert_eq!(wb.value(0, 0, 0), CellValue::Number(1.0));
    assert_eq!(wb.value(0, 2, 0), CellValue::Empty);
}

/// THE RECOVERY NEVER GUESSES. Where the file's values disagree with what the
/// formula produces now — a different build, a changed function — it claims
/// nothing rather than overwriting cells on the strength of a guess about which
/// of them used to be an array's.
#[test]
fn the_recovery_declines_when_the_stored_values_disagree() {
    let wb = workbook_with_a_sized_spill(4.0);
    let mut legacy = workbook_for_save(&wb);
    for sheet in &mut legacy.sheets {
        for cell in sheet.cells.values_mut() {
            cell.spill = None;
        }
    }
    // What a build with a different function set leaves behind: the origin's
    // formula still says SEQUENCE, but the cached third value is not 3.
    legacy.sheets[0]
        .cells
        .get_mut(&(2, 0))
        .unwrap()
        .value = persistence::SavedCellValue::Number(999.0);

    let bytes = calcula_format::write_calcula_bytes(&legacy).unwrap();
    let loaded = calcula_format::read_calcula_bytes(&bytes).unwrap();
    reopen(&wb, &loaded);

    assert!(
        spill_ranges_of(&wb).is_empty(),
        "the recovery must not claim a footprint whose stored values it cannot \
         match — claiming it would delete A3's 999 on the next tear-down"
    );
    assert_eq!(
        wb.value(0, 2, 0),
        CellValue::Number(999.0),
        "and it must not have written anything either"
    );
}

/// A GENUINE BLOCKER must not be swallowed. A literal a user typed inside what
/// would be the array's footprint is not the array's, and the recovery must
/// leave it alone.
#[test]
fn the_recovery_leaves_a_genuine_blocker_alone() {
    let wb = Workbook::new(1);
    wb.set(0, 1, "4");
    // A2 typed FIRST, so `=SEQUENCE(B1)` in A1 is blocked and never spills.
    wb.set(1, 0, "typed by hand");
    wb.set(0, 0, "=SEQUENCE(B1)");
    assert_eq!(
        wb.value(0, 0, 0),
        CellValue::Error(CellError::Spill),
        "precondition: the spill must be blocked"
    );

    let mut legacy = workbook_for_save(&wb);
    for sheet in &mut legacy.sheets {
        for cell in sheet.cells.values_mut() {
            cell.spill = None;
        }
    }
    let bytes = calcula_format::write_calcula_bytes(&legacy).unwrap();
    let loaded = calcula_format::read_calcula_bytes(&bytes).unwrap();
    reopen(&wb, &loaded);

    assert!(
        spill_ranges_of(&wb).is_empty(),
        "nothing to claim: the array never spilled"
    );
    assert_eq!(
        wb.value(0, 1, 0),
        CellValue::Text("typed by hand".to_string()),
        "the user's own cell must survive the recovery untouched"
    );
}

/// The recovery is skipped entirely for a v7 file, which is what keeps the open
/// path cheap: no evaluation at all when the extents are already there.
#[test]
fn a_v7_workbook_pays_for_no_evaluation_on_load() {
    let wb = workbook_with_a_sized_spill(4.0);
    let loaded = round_trip(&wb);
    wb.state.spill_ranges.write(&crate::document_effect::test_seed_effect()).unwrap().clear();
    wb.state.spill_hosts.lock().unwrap().clear();

    let report = crate::spill_restore::restore_spill_map_on_load(
        &wb.state,
        &wb.files,
        &loaded.sheets,
        loaded.format_version,
    );
    assert_eq!(report.restored, 1);
    assert_eq!(
        report.evaluated, 0,
        "a v7 file must read its extents, never re-derive them"
    );
}

// ---------------------------------------------------------------------------
// 6. Malformed and hostile extents
// ---------------------------------------------------------------------------

/// An extent on a cell that no longer holds a formula is REFUSED. Honouring it
/// would hand ownership of real cells to something with nothing to re-derive
/// them from, and the first tear-down would delete them.
#[test]
fn an_extent_without_a_formula_is_refused() {
    let wb = workbook_with_a_sized_spill(4.0);
    let mut tampered = workbook_for_save(&wb);
    let origin = tampered.sheets[0].cells.get_mut(&(0, 0)).unwrap();
    origin.formula = None;
    assert!(origin.spill.is_some());

    let report = {
        wb.state.spill_ranges.write(&crate::document_effect::test_seed_effect()).unwrap().clear();
        wb.state.spill_hosts.lock().unwrap().clear();
        crate::spill_restore::restore_spill_map_from_workbook(&wb.state, &tampered.sheets)
    };
    assert_eq!(report.restored, 0);
    assert_eq!(report.rejected, 1);
    assert!(spill_hosts_of(&wb).is_empty());
}

/// Two extents claiming the same cell: the second is refused whole rather than
/// partially applied, so one origin's tear-down can never erase another's
/// output.
#[test]
fn overlapping_extents_are_refused_rather_than_interleaved() {
    let wb = Workbook::new(1);
    let mut tampered = workbook_for_save(&wb);
    let sheet = &mut tampered.sheets[0];
    sheet.cells.insert(
        (0, 0),
        persistence::SavedCell {
            value: persistence::SavedCellValue::Number(1.0),
            formula: Some("SEQUENCE(4)".to_string()),
            style_index: 0,
            rich_text: None,
            spill: Some((3, 0)),
        },
    );
    sheet.cells.insert(
        (2, 0),
        persistence::SavedCell {
            value: persistence::SavedCellValue::Number(9.0),
            formula: Some("SEQUENCE(4)".to_string()),
            style_index: 0,
            rich_text: None,
            spill: Some((5, 0)),
        },
    );

    wb.state.spill_ranges.write(&crate::document_effect::test_seed_effect()).unwrap().clear();
    wb.state.spill_hosts.lock().unwrap().clear();
    let report = crate::spill_restore::restore_spill_map_from_workbook(&wb.state, &tampered.sheets);

    assert_eq!(report.restored, 1, "exactly one of the two may be honoured");
    assert_eq!(report.rejected, 1);
    assert_eq!(
        spill_ranges_of(&wb),
        vec![((0, 0, 0), vec![(1, 0), (2, 0), (3, 0)])],
        "A1's claim is honoured (it sorts first); A3's overlapping one is \
         dropped whole, not trimmed"
    );
}

/// A reversed or degenerate extent is discarded at the FORMAT boundary, before
/// the host ever sees it, so `range_from_a1` is the only place that has to
/// know the rule.
#[test]
fn a_reversed_extent_never_reaches_the_host() {
    let wb = workbook_with_a_sized_spill(4.0);
    let saved = workbook_for_save(&wb);
    let mut data = calcula_format::sheet_data::cells_to_sheet_data(&saved.sheets[0].cells);
    assert_eq!(data.cells["A1"].sp.as_deref(), Some("A1:A4"));

    for bad in ["A4:A1", "A1", "", "B1:B4", "nonsense"] {
        data.cells.get_mut("A1").unwrap().sp = Some(bad.to_string());
        let cells = calcula_format::sheet_data::sheet_data_to_cells(&data);
        assert_eq!(
            cells[&(0, 0)].spill, None,
            "`{}` is not a valid extent for A1 and must be discarded",
            bad
        );
    }
}

// ---------------------------------------------------------------------------
// 7. The two commands this file reproduces still do what it says they do
// ---------------------------------------------------------------------------

/// `build_workbook_for_save` cannot be called in-process (it takes
/// `State<AppState>`), so this pins from SOURCE that it still stamps the
/// extents, and stamps them AFTER `Sheet::from_grid` has produced the cells
/// they attach to.
#[test]
fn the_save_path_still_stamps_spill_extents() {
    let src = include_str!("../persistence.rs");
    let body = body_of(src, "build_workbook_for_save");
    let from_grid = body
        .find("Sheet::from_grid")
        .expect("build_workbook_for_save no longer builds sheets from the grid");
    let stamp = body.find("apply_spill_extents_to_sheet").expect(
        "build_workbook_for_save no longer stamps spill extents — a save that \
         drops them re-creates §2ab in full: the array's cells persist, its \
         OWNERSHIP does not, and the reopened workbook collapses the array on \
         the first re-evaluation of its origin",
    );
    assert!(
        from_grid < stamp,
        "the extents must be stamped onto the cells `Sheet::from_grid` \
         produced, which means after it"
    );
}

/// ...and the same for the load half.
#[test]
fn the_open_path_still_restores_the_spill_map() {
    let src = include_str!("../persistence.rs");
    let body = body_of(src, "open_file");
    assert!(
        body.contains("restore_spill_map_on_load"),
        "open_file no longer restores the spill map. `reset_document_scoped_\
         stores` still CLEARS it for the outgoing document, so removing this \
         leaves every reopened workbook's dynamic arrays owned by nothing — \
         §2ab exactly"
    );
    let rebuild = body
        .find("rebuild_all_dependencies")
        .expect("open_file no longer rebuilds the dependency maps");
    let restore = body.find("restore_spill_map_on_load").unwrap();
    assert!(
        rebuild < restore,
        "the spill restore must run after the grids, names, tables and \
         dependency maps are in place — the recovery path evaluates formulas \
         through all of them"
    );
}

/// The `.calp` subscriber gets the same answer, and by the same route: the
/// pulled sheet carries the same extents, and every path that installs one
/// reaches the restore.
#[test]
fn every_calp_sheet_install_restores_the_spill_extents() {
    let src = include_str!("../calp_commands.rs");
    let installs = src.matches("pulled.sheet.to_grid()").count();
    let restores = src
        .matches("spill_restore::restore_spill_extents_for_sheet")
        .count();
    assert!(
        installs > 0,
        "the .calp sheet-install sites moved — re-derive this test"
    );
    assert!(
        restores >= installs,
        "{} `.calp` path(s) install a pulled sheet's grid but only {} restore \
         its spill extents. A pulled array with no extent is §2ab on the \
         subscriber's machine; a REPLACED sheet that keeps the old claims is \
         §2x's class, an edit refused in the name of a formula that is no \
         longer there",
        installs,
        restores
    );
}

// ---------------------------------------------------------------------------
// 8. What the load path COSTS
// ---------------------------------------------------------------------------

/// BENCHMARK, not an assertion. `cargo test --lib -- --ignored --nocapture
/// bench_the_load_path_cost_of_spill_ownership`.
///
/// The question the design turns on: how much does a workbook pay, on open,
/// for its arrays to be owned? Two answers, because there are two paths.
///
/// * **v7 and later** — read the extents. No evaluation at all; the work is one
///   map insert per SPILLED CELL, and it is independent of how many ordinary
///   formulas the workbook has. This is why Excel stores `ref` rather than
///   recomputing, and why this design does the same.
/// * **v1..v6 and `.xlsx`** — the recovery. One evaluation per formula cell
///   that could still be an origin, which is the same order of work as one F9,
///   paid ONCE: the first save stamps the extents and the file is v7 from then
///   on.
///
/// The workbook is built by writing the grid directly rather than through
/// `update_cell`, because a cascade per cell would make the SETUP the thing
/// being measured.
#[test]
#[ignore = "benchmark: run with --ignored --nocapture"]
fn bench_the_load_path_cost_of_spill_ownership() {
    use std::time::Instant;

    // (ordinary formula cells, array origins, cells per array)
    for &(formulas, arrays, array_len) in &[
        // The COMMON case first: a big workbook with no dynamic array at all,
        // which must pay nothing worth measuring on the v7 path.
        (50_000usize, 0usize, 1u32),
        (1_000, 10, 100),
        (10_000, 50, 200),
        (50_000, 100, 500),
    ] {
        let wb = Workbook::new(1);
        {
            let effect = crate::document_effect::DocumentEffect::deliberately_clean(
                crate::document_effect::CleanReason::LoadingFromDisk,
            );
            let mut grid = wb.state.grid.write(&effect).unwrap();
            // Column A: ordinary formulas, each with the value a save would
            // have cached. Dense, so the below-neighbour prune never fires --
            // the worst case for the recovery.
            for row in 0..formulas as u32 {
                let mut cell = engine::Cell::new_formula("1+1".to_string());
                cell.value = CellValue::Number(2.0);
                grid.set_cell(row, 0, cell);
            }
            // Arrays in their own columns, each with the literals the pre-v7
            // save wrote for it.
            for a in 0..arrays as u32 {
                let col = 2 + a;
                let mut origin = engine::Cell::new_formula(format!("SEQUENCE({})", array_len));
                origin.value = CellValue::Number(1.0);
                grid.set_cell(0, col, origin);
                for i in 1..array_len {
                    grid.set_cell(i, col, engine::Cell::new_number(f64::from(i + 1)));
                }
            }
            let mut grids = wb.state.grids.write(&effect).unwrap();
            grids[0] = grid.clone();
        }

        // --- the pre-v7 path: prove every array by evaluating ---------------
        let started = Instant::now();
        let recovery = crate::spill_restore::recover_spill_map_by_evaluation(&wb.state, &wb.files);
        let recovery_ms = started.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(
            recovery.restored, arrays,
            "the benchmark must actually recover the arrays it built"
        );

        // --- the v7 path: read the extents the save wrote -------------------
        let saved = workbook_for_save(&wb);
        wb.state.spill_ranges.write(&crate::document_effect::test_seed_effect()).unwrap().clear();
        wb.state.spill_hosts.lock().unwrap().clear();
        let started = Instant::now();
        let restore = crate::spill_restore::restore_spill_map_from_workbook(&wb.state, &saved.sheets);
        let restore_ms = started.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(restore.restored, arrays);
        assert_eq!(restore.evaluated, 0);

        println!(
            "[SPILL BENCH] {:>6} formulas + {:>3} arrays x {:>3} cells ({:>6} spilled cells): \
             recovery(pre-v7) {:>8.2} ms over {:>6} evaluations | restore(v7) {:>8.3} ms",
            formulas,
            arrays,
            array_len,
            arrays * (array_len as usize - 1),
            recovery_ms,
            recovery.evaluated,
            restore_ms,
        );
    }
}

// ---------------------------------------------------------------------------
// 9. §3bf — `A1#` is a LIVE reference (was: frozen at entry)
// ---------------------------------------------------------------------------

/// §3bf, FIXED — this was a CHARACTERISATION test asserting the defect, and it
/// is now inverted.
///
/// `split_entered_formula` used to turn a typed `A1#` into a plain `Range` in
/// the form the cell STORES, not merely in the form it evaluates. So a spill
/// reference was a snapshot of the array's extent at the moment it was typed:
/// `=SUM(A1#)` was kept, rendered in the formula bar and saved as
/// `=SUM(A1:A4)`, and did not follow the array afterwards. In Excel `A1#` is a
/// LIVE reference to whatever the array currently spans, which is its entire
/// purpose — and the formula bar showed the frozen range, so nothing on screen
/// said the `#` had ever been there.
///
/// The stated reason for freezing it ("neither can be re-derived later from the
/// cell alone") stopped holding when v7 persisted the extent and the map came
/// back on load. It is now resolved at EVALUATION by
/// `name_resolution::eval_ast`, the same recipe D2 uses for a defined name and
/// §2aj for a structured reference.
#[test]
fn a_spill_reference_follows_its_array_3bf() {
    let wb = Workbook::new(1);
    wb.set(0, 1, "4");
    wb.set(0, 0, "=SEQUENCE(B1)");
    wb.set(0, 2, "=SUM(A1#)");
    assert_eq!(wb.value(0, 0, 2), CellValue::Number(10.0), "1+2+3+4");

    // The `#` is KEPT: it is what the cell stores, renders and saves.
    let stored = wb
        .state
        .grid
        .read()
        .unwrap()
        .get_cell(0, 2)
        .and_then(|c| c.formula_string_raw());
    assert_eq!(
        stored.as_deref(),
        Some("SUM(A1#)"),
        "the stored formula must keep the `#`. If it says `SUM(A1:A4)` the \
         reference has been frozen at entry again and §3bf is back"
    );

    // Grow the array: the reference follows it. Excel reads 15.
    wb.set(0, 1, "5");
    assert_eq!(wb.value(0, 4, 0), CellValue::Number(5.0), "the array grew");
    assert_eq!(
        wb.value(0, 0, 2),
        CellValue::Number(15.0),
        "the spill reference must follow the array it names: 1+2+3+4+5"
    );

    // ...and shrinking it too. The extent assertion is what makes this
    // direction real: a frozen `A1:A5` over a shrunk array reads the same 3,
    // because the cells it gave up are empty.
    wb.set(0, 1, "2");
    assert_eq!(wb.value(0, 2, 0), CellValue::Empty, "the array shrank");
    assert_eq!(
        spill_ranges_of(&wb),
        vec![((0, 0, 0), vec![(1, 0)])],
        "the extent the reference resolves against"
    );
    assert_eq!(wb.value(0, 0, 2), CellValue::Number(3.0), "1+2");
}

// ---------------------------------------------------------------------------
// §3bg — a BLOCKED dynamic array is #SPILL!, and it names what blocks it
// ---------------------------------------------------------------------------
//
// It used to be `#VALUE!`, which is the wrong instruction. `#VALUE!` means
// "an argument has the wrong type -- fix the argument", and every argument of
// a blocked array is correct: the problem is a cell somewhere ELSE. Excel has
// `#SPILL!` for exactly this and its error menu offers "Select Obstructing
// Cells", because the remedy needs an address.

/// The obstruction's address, as `error_checking` will read it.
fn block_at(wb: &Workbook, sheet: usize, row: u32, col: u32) -> Option<(u32, u32)> {
    wb.state
        .spill_blocks
        .lock()
        .unwrap()
        .get(&(sheet, row, col))
        .copied()
}

#[test]
fn an_array_blocked_on_entry_is_spill_not_value() {
    let wb = Workbook::new(1);
    wb.set(2, 0, "in the way");
    wb.set(0, 0, "=SEQUENCE(4)");

    assert_eq!(
        wb.value(0, 0, 0),
        CellValue::Error(CellError::Spill),
        "a dynamic array that cannot write its result is #SPILL!, not #VALUE! \
         -- #VALUE! sends the user to inspect arguments that are all correct"
    );
    assert_eq!(
        block_at(&wb, 0, 0, 0),
        Some((2, 0)),
        "the obstruction's ADDRESS is what makes #SPILL! actionable; without \
         it the message can only say 'something is in the way'"
    );
    // The blocker itself is untouched -- a blocked spill must not eat data.
    assert_eq!(wb.value(0, 2, 0), CellValue::Text("in the way".to_string()));
}

#[test]
fn an_array_blocked_by_a_later_edit_is_spill_too() {
    // The RECALCULATION path, which is a different one of the three spill
    // decision sites from the entry path above.
    let wb = Workbook::new(1);
    wb.set(0, 1, "4");
    wb.set(0, 0, "=SEQUENCE(B1)");
    assert_eq!(wb.value(0, 3, 0), CellValue::Number(4.0), "spilled to A4");

    // Drop a value into what the array would need if it grew, then grow it.
    wb.set(4, 0, "blocker");
    wb.set(0, 1, "5");

    assert_eq!(
        wb.value(0, 0, 0),
        CellValue::Error(CellError::Spill),
        "growing into an occupied cell is #SPILL!"
    );
    assert_eq!(block_at(&wb, 0, 0, 0), Some((4, 0)));
}

#[test]
fn clearing_the_obstruction_re_spills_and_forgets_the_block() {
    let wb = Workbook::new(1);
    wb.set(2, 0, "in the way");
    wb.set(0, 0, "=SEQUENCE(4)");
    assert_eq!(wb.value(0, 0, 0), CellValue::Error(CellError::Spill));

    wb.set(2, 0, "");

    assert_eq!(
        wb.value(0, 0, 0),
        CellValue::Number(1.0),
        "with the obstruction gone the array spills again"
    );
    assert_eq!(wb.value(0, 3, 0), CellValue::Number(4.0));
    assert_eq!(
        block_at(&wb, 0, 0, 0),
        None,
        "the recorded obstruction must be CLEARED on the success branch, or \
         the next block reports a stale address"
    );
}

#[test]
fn spill_survives_a_save_and_reload_as_spill() {
    // `#SPILL!` has to be in BOTH `as_literal` and `from_literal` or a blocked
    // array silently becomes a different error on reload -- the exact failure
    // `every_error_literal_survives_a_save_and_reload` guards in general,
    // checked here on the real archive.
    assert_eq!(CellError::from_literal("#SPILL!"), CellError::Spill);
    assert_eq!(CellError::Spill.as_literal(), "#SPILL!");

    let wb = Workbook::new(1);
    wb.set(2, 0, "in the way");
    wb.set(0, 0, "=SEQUENCE(4)");
    assert_eq!(wb.value(0, 0, 0), CellValue::Error(CellError::Spill));

    let reloaded = round_trip(&wb);
    let a1 = reloaded.sheets[0]
        .cells
        .get(&(0u32, 0u32))
        .expect("A1 survives the round trip");
    assert!(
        matches!(&a1.value, persistence::SavedCellValue::Error(e) if e == "#SPILL!"),
        "A1 round-tripped as {:?} -- a blocked array must not come back as a          different error",
        a1.value
    );
}

// ---------------------------------------------------------------------------
// The cascade the CLEAR branch used to skip
// ---------------------------------------------------------------------------

/// CLEARING A CELL MUST RECALCULATE ITS DEPENDENTS.
///
/// Found while giving a blocked dynamic array its `#SPILL!` recovery, and far
/// bigger than the thing that found it: `update_cell_impl`'s empty-value branch
/// ended in `return Ok(...)` placed ABOVE the recalculation block, so every
/// dependent of a cleared cell kept the value it had before the clear.
///
/// Measured before the fix: `A1 = 5`, `B1 = =A1+1` reads 6; clearing A1 left B1
/// reading 6, where Excel reads 1. Delete and Backspace both commit an empty
/// value through this exact path (`useSpreadsheetEditing` calls
/// `startEditing("")` then `handleCommitEdit`), so this was the single
/// most-used editing key in the product leaving the grid inconsistent -- and
/// the stale number is what the next save writes, not merely what the screen
/// shows.
#[test]
fn clearing_a_cell_recalculates_its_dependents() {
    let wb = Workbook::new(1);
    wb.set(0, 0, "5");
    wb.set(0, 1, "=A1+1");
    assert_eq!(wb.value(0, 0, 1), CellValue::Number(6.0), "precondition");

    wb.set(0, 0, "");

    assert_eq!(wb.value(0, 0, 0), CellValue::Empty, "A1 is cleared");
    assert_eq!(
        wb.value(0, 0, 1),
        CellValue::Number(1.0),
        "B1 must follow the clear -- an empty cell reads as 0, so =A1+1 is 1.          If this is 6 again, the clear branch has stopped reaching the cascade"
    );
}

/// The same thing one edge further out: a chain, and a formula that reads the
/// cleared cell as TEXT. Both go stale from the same missing cascade, and a
/// one-hop test would not have noticed the transitive half.
#[test]
fn clearing_a_cell_recalculates_the_whole_chain() {
    let wb = Workbook::new(1);
    wb.set(0, 0, "5");
    wb.set(0, 1, "=A1*2");
    wb.set(0, 2, "=B1+1");
    // `&`, not a multi-argument function: this harness runs under the machine
    // locale (sv-SE), whose argument separator is `;`, and a comma-separated
    // call would be stored as TEXT rather than parsed.
    wb.set(1, 0, "=A1&\"!\"");
    assert_eq!(wb.value(0, 0, 2), CellValue::Number(11.0), "precondition");
    assert_eq!(
        wb.value(0, 1, 0),
        CellValue::Text("5!".to_string()),
        "precondition"
    );

    wb.set(0, 0, "");

    assert_eq!(wb.value(0, 0, 1), CellValue::Number(0.0), "B1 = 0*2");
    assert_eq!(wb.value(0, 0, 2), CellValue::Number(1.0), "C1 = 0+1");
    assert_eq!(
        wb.value(0, 1, 0),
        CellValue::Text("!".to_string()),
        "a non-arithmetic dependent follows the clear too. THE `0` IS GONE, and \
         its absence is the point: this assertion used to read \"0!\" and carried \
         a note saying the engine read an empty cell as the NUMBER zero in every \
         context, that Excel gives \"!\", and that the gap was filed and pinned \
         here so a fix would have to come past this test rather than silently \
         change what it proves. That is exactly what happened -- open-items 1.5 \
         gave blanks their own evaluation result, so a blank is now \"\" in a \
         concatenation. What this test proves is unchanged: the dependent \
         RE-EVALUATED"
    );
}

/// Clearing a cell must still put the WRITE path's work on the undo stack and
/// must not double-record: the restructure that gave the clear branch a cascade
/// turned an early return into an `else`, and the failure mode of getting that
/// wrong is two undo entries for one keystroke.
#[test]
fn clearing_a_cell_records_exactly_one_undo_entry() {
    let wb = Workbook::new(1);
    wb.set(0, 0, "5");
    let before = wb.state.undo_stack.lock().unwrap().undo_depth();
    wb.set(0, 0, "");
    let after = wb.state.undo_stack.lock().unwrap().undo_depth();
    assert_eq!(after, before + 1, "one keystroke, one undo entry");
}

// ---------------------------------------------------------------------------
// 10. §3bm — SAVING must not collapse an array
// ---------------------------------------------------------------------------
//
// `calculate_before_save` defaults to TRUE, so `save_file` runs the WORKBOOK
// recalculation pass before it assembles the archive. That pass used to write
// `EvalResult::to_cell_value()`, which collapses an array to its first element
// -- so the act of pressing Ctrl+S replaced a `#SPILL!` with a plausible `1`
// and wrote THAT to disk. The file was wrong, not merely the screen, and
// nothing on screen said so.
//
// These tests run the same pass the save path runs and then do the same REAL
// `.cala` round trip the rest of this file does.

/// The workbook pass, exactly as `save_file` invokes it (F9 scope).
fn calculate_before_save(wb: &Workbook) {
    crate::calculation::run_calculation_pass(
        crate::calculation::CalcScope::Workbook,
        None,
        &wb.state,
        &wb.files,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        None,
    )
    .expect("the calculate-before-save pass failed");
}

/// A BLOCKED array must still be blocked in the file.
#[test]
fn saving_does_not_turn_a_blocked_array_into_a_number() {
    let wb = Workbook::new(1);
    wb.set(2, 0, "in the way");
    wb.set(0, 0, "=SEQUENCE(4)");
    // COUNTERWEIGHT: an array that is not blocked, so "arrays stopped working"
    // cannot pass this test.
    wb.set(0, 2, "=SEQUENCE(2)");
    assert_eq!(
        wb.value(0, 0, 0),
        CellValue::Error(CellError::Spill),
        "precondition: entry must produce #SPILL!"
    );

    calculate_before_save(&wb);

    assert_eq!(
        wb.value(0, 0, 0),
        CellValue::Error(CellError::Spill),
        "the calculate-before-save pass collapsed a blocked array to its first \
         element -- this is §3bm, and the collapsed number is what the archive \
         below would contain"
    );
    assert_eq!(
        wb.value(0, 1, 2),
        CellValue::Number(2.0),
        "COUNTERWEIGHT: the unblocked array still spilled"
    );

    let loaded = round_trip(&wb);
    let a1 = loaded.sheets[0]
        .cells
        .get(&(0u32, 0u32))
        .expect("A1 survives the round trip");
    assert!(
        matches!(&a1.value, persistence::SavedCellValue::Error(e) if e == "#SPILL!"),
        "A1 was written to the archive as {:?}, not #SPILL!",
        a1.value
    );

    reopen(&wb, &loaded);
    assert_eq!(
        wb.value(0, 0, 0),
        CellValue::Error(CellError::Spill),
        "#SPILL! did not survive the save/reload"
    );
    assert_eq!(
        wb.value(0, 2, 0),
        CellValue::Text("in the way".to_string()),
        "the blocker's own text must survive"
    );
}

/// A LIVE array must come back the same size it went in, and the extent the
/// save stamped must be the one the pass just re-laid -- not the one it had
/// before the pass ran.
#[test]
fn saving_stamps_the_extent_the_recalculation_just_laid() {
    let wb = Workbook::new(1);
    wb.set(0, 1, "4");
    wb.set(0, 0, "=SEQUENCE(B1)");
    wb.set(0, 5, "=B1*10");
    assert_eq!(wb.value(0, 3, 0), CellValue::Number(4.0), "precondition: A4");

    // Manual mode, so only the save's own pass can put the array right --
    // exactly the state a user leaves behind by turning automatic off.
    *wb.state.calculation_mode.lock().unwrap() = "manual".to_string();
    wb.set(0, 1, "2");
    assert_eq!(
        wb.value(0, 3, 0),
        CellValue::Number(4.0),
        "precondition: the stale tail must still be there for the save to clear"
    );

    calculate_before_save(&wb);
    assert_eq!(wb.number(0, 0, 5), 20.0, "CONTROL: the pass really ran");

    let loaded = round_trip(&wb);
    let saved_extent = loaded.sheets[0]
        .cells
        .get(&(0u32, 0u32))
        .and_then(|c| c.spill.clone());
    assert!(
        saved_extent.is_some(),
        "the array's extent was not stamped into the archive"
    );
    assert!(
        !loaded.sheets[0].cells.contains_key(&(2u32, 0u32)),
        "A3 was saved as a literal: the pass did not release the cells the \
         array gave up, so the file carries orphans under a live origin"
    );
    assert!(!loaded.sheets[0].cells.contains_key(&(3u32, 0u32)), "A4 likewise");

    reopen(&wb, &loaded);
    assert_eq!(wb.value(0, 1, 0), CellValue::Number(2.0), "A2");
    assert_eq!(wb.value(0, 2, 0), CellValue::Empty, "A3");
    assert_eq!(
        spill_ranges_of(&wb),
        vec![((0, 0, 0), vec![(1, 0)])],
        "the reopened workbook must own exactly the new extent"
    );
}

/// The save path still runs the pass. If somebody makes calculate-before-save
/// stop calling it, the two tests above go green for the wrong reason.
#[test]
fn the_save_path_still_recalculates_before_it_assembles() {
    let src = include_str!("../persistence.rs");
    let body = body_of(src, "save_file");
    let calc = body.find("calculation::calculate_now").expect(
        "save_file no longer recalculates before saving. It is not only a \
         staleness question: the pass is where a dynamic array's rectangle is \
         re-laid (§3bm), so a save that skips it can write an array's stale \
         tail as literals",
    );
    let assemble = body
        .find("assemble_workbook_for_save")
        .expect("save_file no longer assembles a workbook");
    assert!(
        calc < assemble,
        "the recalculation must run BEFORE the workbook is assembled, or the \
         archive is built from the values the pass was about to replace"
    );
}

// ---------------------------------------------------------------------------
// 11. What the SAVE path costs, now that it decides spills
// ---------------------------------------------------------------------------

/// BENCHMARK, not an assertion. `cargo test --lib -- --ignored --nocapture
/// bench_the_save_path_cost_of_the_spill_decision`.
///
/// The question: `calculate_before_save` defaults to TRUE, so this pass runs on
/// every Ctrl+S, and §3bm's fix put a spill decision inside its per-cell loop.
/// What does a workbook with NO dynamic array now pay for that? One
/// `spill_ranges` lock and one `is_empty()` (`take_spills_where` returns before
/// it looks at anything else) plus one `spill_blocks` lock, per formula cell.
///
/// The grid is written directly rather than through `update_cell`, because a
/// cascade per cell would make the SETUP the thing being measured.
#[test]
#[ignore = "benchmark: run with --ignored --nocapture"]
fn bench_the_save_path_cost_of_the_spill_decision() {
    use std::time::Instant;

    for &(formulas, arrays, array_len) in &[
        (10_000usize, 0usize, 1u32),
        (50_000, 0, 1),
        (50_000, 100, 50),
    ] {
        let wb = Workbook::new(1);
        {
            let effect = crate::document_effect::DocumentEffect::deliberately_clean(
                crate::document_effect::CleanReason::LoadingFromDisk,
            );
            let mut grid = wb.state.grid.write(&effect).unwrap();
            for row in 0..formulas as u32 {
                let mut cell = engine::Cell::new_formula("1+1".to_string());
                cell.value = CellValue::Number(2.0);
                grid.set_cell(row, 0, cell);
            }
            for a in 0..arrays as u32 {
                let col = 2 + a;
                let mut origin = engine::Cell::new_formula(format!("SEQUENCE({})", array_len));
                origin.value = CellValue::Number(1.0);
                grid.set_cell(0, col, origin);
            }
            let mut grids = wb.state.grids.write(&effect).unwrap();
            grids[0] = grid.clone();
        }

        // Warm: the FIRST pass lays every array, the second is the steady state
        // a repeated Ctrl+S pays.
        calculate_before_save(&wb);
        let started = Instant::now();
        calculate_before_save(&wb);
        let ms = started.elapsed().as_secs_f64() * 1000.0;

        let spilled: usize = wb
            .state
            .spill_ranges
            .write(&crate::document_effect::test_seed_effect())
            .unwrap()
            .values()
            .map(|v| v.len())
            .sum();
        println!(
            "[SAVE BENCH] {:>6} formulas + {:>3} arrays x {:>3} cells ({:>6} spilled): \
             calculate-before-save {:>8.2} ms ({:>6.3} us/formula cell)",
            formulas,
            arrays,
            array_len,
            spilled,
            ms,
            ms * 1000.0 / (formulas + arrays) as f64,
        );
    }
}
