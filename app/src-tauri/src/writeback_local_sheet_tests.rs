//! FILENAME: app/src-tauri/src/writeback_local_sheet_tests.rs
//! PURPOSE: A subscriber's writeback regions live on the subscriber's LOCAL
//!          sheets, detaching orphans nothing, and a discard puts back what was
//!          sent.
//! CONTEXT: The defect behind the owner's report ("I cannot see if it was
//!          written back", 2026-10-21). A published region names the
//!          PUBLISHER's sheet id; `pull()` gives every subscribed sheet a fresh
//!          local id. The index was built from the declarations as published,
//!          so every guard (keyed by the local active sheet id) missed, the
//!          regions were reported at sheet index 0 (a blank `Sheet1` in a new
//!          workbook), and typing into the subscribed sheet made plain cell
//!          edits with no draft behind them -- nothing to submit.
//!
//!          Every fixture here gives the subscribed sheet a local id DIFFERENT
//!          from its package id and puts it at a sheet index OTHER than 0, which
//!          is the shape that hid the defect: no earlier fixture subscribed to an
//!          application with writeback regions at all.

use std::collections::{HashMap, HashSet};

use calp::writeback::{
    RegionSelector, SubmissionPolicy, SubmissionState, SubmissionValue, VisibilityPolicy,
    WritebackRegionDeclaration, WritebackSubmission,
};
use engine::{Cell, CellValue};

use crate::calp_commands::{
    discard_writeback_drafts_inner, ensure_range_unclaimed, ensure_writeback_draft_before_write,
    ensure_writeback_draft_before_write_on_sheets, install_writeback_index,
    reproject_writeback_layer_onto_grids, writeback_layer_cells_on_sheets, writeback_region_at,
    writeback_region_entries, WritebackCellRef,
};
use crate::document_effect::test_seed_effect;
use crate::persistence::{FileState, UserFilesState};
use crate::AppState;

const APP: &str = "writeback-test";
const WORKSPACE: &str = r"\\share\writeback-test";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/// A workbook with `count` user sheets, seeded the way a load does.
fn workbook_with_sheets(count: usize) -> AppState {
    let state = crate::create_app_state();
    for i in 1..count {
        state.grids.write(&test_seed_effect()).unwrap().push(engine::Grid::new());
        state
            .sheet_names
            .write(&test_seed_effect())
            .unwrap()
            .push(format!("Sheet{}", i + 1));
        state.all_column_widths.write(&test_seed_effect()).unwrap().push(HashMap::new());
        state.all_row_heights.write(&test_seed_effect()).unwrap().push(HashMap::new());
        state.all_user_hidden_rows.write(&test_seed_effect()).unwrap().push(HashSet::new());
        state.all_user_hidden_cols.write(&test_seed_effect()).unwrap().push(HashSet::new());
        state.all_merged_regions.write(&test_seed_effect()).unwrap().push(HashSet::new());
        state
            .sheet_ids
            .write(&test_seed_effect())
            .unwrap()
            .push(identity::SheetId::from_bytes(identity::generate_uuid_v7()));
    }
    state
}

fn local_id(state: &AppState, index: usize) -> identity::SheetId {
    state.sheet_ids.read().unwrap()[index]
}

/// Record that the sheets at `indices` were materialized by the application,
/// each under a FRESH package id (as `pull()` does), and return the
/// subscription plus the package id of each sheet, in order.
fn subscribe(state: &AppState, indices: &[usize]) -> (calp::manifest::Subscription, Vec<identity::SheetId>) {
    let mut package_ids = Vec::new();
    let sheets: Vec<calp::manifest::SubscribedSheet> = indices
        .iter()
        .map(|&i| {
            let package_sheet_id = identity::SheetId::from_bytes(identity::generate_uuid_v7());
            package_ids.push(package_sheet_id);
            calp::manifest::SubscribedSheet {
                package_sheet_id,
                local_sheet_id: local_id(state, i),
                local_name: state.sheet_names.read().unwrap()[i].clone(),
                extra: HashMap::new(),
            }
        })
        .collect();
    let sub = calp::manifest::Subscription {
        package_name: APP.to_string(),
        registry_url: WORKSPACE.to_string(),
        version_pin: "latest".to_string(),
        resolved_version: "1.0.0".to_string(),
        resolved_at: "2026-10-21T00:00:00Z".to_string(),
        sheets,
        environment: None,
        data_source_configs: Vec::new(),
        objects: Vec::new(),
        detached_sheets: Vec::new(),
        detached_local_sheets: Vec::new(),
        upstream_removed_sheets: Vec::new(),
        extra: HashMap::new(),
    };
    state
        .subscriptions
        .write(&test_seed_effect())
        .unwrap()
        .subscriptions
        .push(sub.clone());
    for (pkg, &i) in package_ids.iter().zip(indices) {
        assert_ne!(*pkg, local_id(state, i), "the fixture must differ, as a real pull does");
    }
    (sub, package_ids)
}

/// The owner's region: B3:B5 (rows 2..=4, column 1), on_submit,
/// own_plus_aggregate, declared on the PUBLISHER's sheet id.
fn region(id: &str, package_sheet_id: identity::SheetId) -> WritebackRegionDeclaration {
    WritebackRegionDeclaration {
        id: id.to_string(),
        selector: RegionSelector {
            sheet_id: package_sheet_id,
            row_start: 2,
            row_end: 4,
            col_start: 1,
            col_end: 1,
        },
        mode: None,
        schema: None,
        visibility: Some(VisibilityPolicy::OwnPlusAggregate),
        submission_policy: Some(SubmissionPolicy::OnSubmit),
        version_binding: None,
        lifecycle: None,
        aggregation_hint: None,
        expected_respondents: Vec::new(),
        extra: HashMap::new(),
    }
}

fn entry(region_id: &str, row: u32, col: u32, value: f64, state: SubmissionState) -> WritebackSubmission {
    WritebackSubmission {
        id: format!("{region_id}-{row}-{col}-{value}"),
        region_id: region_id.to_string(),
        cell_row: row,
        cell_col: col,
        cell_id: None,
        submitter: calp::SubmitterIdentity {
            display_name: "Subscriber".to_string(),
            id: "subscriber-1".to_string(),
            extra: HashMap::new(),
        },
        value: SubmissionValue::Number { value },
        state,
        created_at: "2026-10-21T00:00:00Z".to_string(),
        updated_at: "2026-10-21T00:00:00Z".to_string(),
        submitted_at: None,
        review_reason: None,
        reviewed_by: None,
        environment: String::new(),
        model_key: None,
        extra: HashMap::new(),
    }
}

fn put_in_layer(state: &AppState, e: WritebackSubmission) {
    state.writeback_layer.write(&test_seed_effect()).unwrap().set_draft(e);
}

fn set_number(state: &AppState, sheet: usize, row: u32, col: u32, v: f64) {
    state.grids.write(&test_seed_effect()).unwrap()[sheet].set_cell(row, col, Cell::new_number(v));
    if *state.active_sheet.read().unwrap() == sheet {
        state.grid.write(&test_seed_effect()).unwrap().set_cell(row, col, Cell::new_number(v));
    }
}

fn value_at(state: &AppState, sheet: usize, row: u32, col: u32) -> Option<CellValue> {
    state.grids.read().unwrap()[sheet].get_cell(row, col).map(|c| c.value.clone())
}

// ---------------------------------------------------------------------------
// D1. The index is keyed by the LOCAL sheet
// ---------------------------------------------------------------------------

/// THE REPORTED DEFECT. The subscribed sheet is at index 1 with its own local
/// id; the region must be reported THERE, carry its application, and arm the
/// guards on that sheet -- and only that sheet.
///
/// SABOTAGE (proved 2026-10-21): make `install_writeback_index` build the index
/// from the declarations as published (`from_declarations(&all_decls)`). The
/// region then lands on the publisher's id: no entry is reported (no local
/// sheet carries that id) and the guard on the subscribed sheet lets a raw
/// write through.
#[test]
fn a_subscribers_region_is_reported_on_the_local_sheet_and_guards_fire_there() {
    let state = workbook_with_sheets(3);
    let (sub, pkg) = subscribe(&state, &[1]);
    install_writeback_index(&state, &[(sub, vec![region("r", pkg[0])])], Vec::new(), Vec::new());

    let entries = writeback_region_entries(&state).unwrap();
    assert_eq!(entries.len(), 1, "one region, on a sheet that is here: {:?}", entries);
    let e = &entries[0];
    assert_eq!(e.sheet_index, 1, "the SUBSCRIBED sheet, not sheet 0");
    assert_eq!(e.sheet_id, local_id(&state, 1), "the LOCAL id, not the publisher's");
    assert_eq!(e.sheet_name.as_deref(), Some("Sheet2"));
    assert_eq!(e.package_name.as_deref(), Some(APP), "the ledger enrichment matches now");
    assert_eq!(e.registry_url.as_deref(), Some(WORKSPACE));
    assert_eq!(e.submission_policy, Some(SubmissionPolicy::OnSubmit));
    assert_eq!(e.visibility, Some(VisibilityPolicy::OwnPlusAggregate));
    assert_eq!((e.row_start, e.row_end, e.col_start, e.col_end), (2, 4, 1, 1));

    assert_eq!(writeback_region_at(&state, local_id(&state, 1), 3, 1).as_deref(), Some("r"));
    assert_eq!(writeback_region_at(&state, pkg[0], 3, 1), None, "never the publisher's id");

    // The guard on the SUBSCRIBED sheet refuses a raw write with no draft...
    *state.active_sheet.write(&test_seed_effect()).unwrap() = 1;
    let err = ensure_writeback_draft_before_write(&state, 2, 1)
        .expect_err("a raw write into the subscribed sheet's B3 must be refused");
    assert!(err.contains("Cell B3 collects input for 'writeback-test'"), "got: {}", err);
    assert!(ensure_writeback_draft_before_write_on_sheets(&state, &[1], 4, 1).is_err());
    // The RANGE refusal (clear / sort / merge / shift) speaks to the subscriber:
    // the application, the A1 range, the gesture that works -- no zero-based
    // coordinates, no script capability jargon.
    let err = ensure_range_unclaimed(&state, "clear these cells", 0, 0, 9, 9)
        .expect_err("a clear over the region must be refused");
    assert!(err.contains("B3:B5 collects input for 'writeback-test'"), "got: {}", err);
    assert!(err.contains("press Delete"), "says how to clear one cell: {}", err);
    assert!(!err.contains("cellGuard") && !err.contains("capability"), "got: {}", err);
    // ...and a draft lets the commit through.
    put_in_layer(&state, entry("r", 2, 1, 1.0, SubmissionState::Draft));
    assert!(ensure_writeback_draft_before_write(&state, 2, 1).is_ok());

    // The blank first sheet is NOT claimed (it used to be: sheetIndex 0).
    *state.active_sheet.write(&test_seed_effect()).unwrap() = 0;
    assert!(ensure_writeback_draft_before_write(&state, 3, 1).is_ok());
    assert!(ensure_writeback_draft_before_write_on_sheets(&state, &[0, 2], 3, 1).is_ok());

    // The declaration MIRROR keeps the publisher's id (its readers look the
    // sheet up in the signed manifest).
    let decls = state.writeback_declarations.lock().unwrap();
    assert_eq!(decls.len(), 1);
    assert_eq!(decls[0].selector.sheet_id, pkg[0]);
}

/// A region whose sheet is not in the ledger is DROPPED -- never kept on the
/// publisher's id, never reported at sheet 0.
#[test]
fn a_region_on_a_sheet_that_is_not_subscribed_is_not_installed() {
    let state = workbook_with_sheets(2);
    let (sub, _pkg) = subscribe(&state, &[1]);
    let elsewhere = identity::SheetId::from_bytes(identity::generate_uuid_v7());
    install_writeback_index(&state, &[(sub, vec![region("ghost", elsewhere)])], Vec::new(), Vec::new());

    assert!(writeback_region_entries(&state).unwrap().is_empty());
    assert!(state.writeback_index.lock().unwrap().is_empty());
    *state.active_sheet.write(&test_seed_effect()).unwrap() = 0;
    assert!(ensure_writeback_draft_before_write(&state, 2, 1).is_ok());
}

// ---------------------------------------------------------------------------
// D9. Detaching a sheet orphans nothing
// ---------------------------------------------------------------------------

/// Detaching a subscribed sheet drops its regions AND the layer entries of
/// those regions; another subscribed sheet's drafts survive even though the
/// rebuild cannot reach the (fixture) workspace to re-install its region.
///
/// SABOTAGE: drop the orphan `retain` in `detach_sheet_inner` -- the r1 draft
/// survives the detach.
#[test]
fn detaching_a_sheet_drops_its_regions_and_their_orphaned_drafts() {
    let state = workbook_with_sheets(3);
    let (sub, pkg) = subscribe(&state, &[1, 2]);
    install_writeback_index(
        &state,
        &[(sub, vec![region("r1", pkg[0]), region("r2", pkg[1])])],
        Vec::new(),
        Vec::new(),
    );
    put_in_layer(&state, entry("r1", 2, 1, 1.0, SubmissionState::Draft));
    put_in_layer(&state, entry("r1", 3, 1, 2.0, SubmissionState::Submitted));
    put_in_layer(&state, entry("r2", 2, 1, 5.0, SubmissionState::Draft));

    let file_state = FileState::default();
    crate::calp_commands::detach_sheet_inner(
        &state,
        &file_state,
        &crate::pivot::types::PivotState::new(),
        &crate::slicer::SlicerState::new(),
        &crate::timeline_slicer::TimelineSlicerState::new(),
        1,
    )
    .unwrap();

    let layer = state.writeback_layer.read().unwrap();
    assert!(
        layer.drafts.iter().all(|d| d.region_id != "r1"),
        "the detached sheet's entries can never be submitted: {:?}",
        layer.drafts
    );
    assert!(
        layer.drafts.iter().any(|d| d.region_id == "r2"),
        "an unreachable workspace is not a reason to drop the OTHER sheet's unsent work"
    );
    drop(layer);
    // The detach's rebuild can be SUPERSEDED in this test binary: the rebuild
    // sequence is process-global and other tests rebuild their own AppState in
    // parallel, so "a newer rebuild started" may be another test's. The orphan
    // drop above does not depend on the rebuild (it reads the ledger); the
    // index does, so it is re-asked until a pass installs.
    for _ in 0..50 {
        if !state.writeback_index.lock().unwrap().contains_region("r1") {
            break;
        }
        crate::calp_commands::rebuild_writeback_index(&state);
    }
    assert!(!state.writeback_index.lock().unwrap().contains_region("r1"));
    assert!(writeback_region_entries(&state).unwrap().iter().all(|e| e.region_id != "r1"));
}

// ---------------------------------------------------------------------------
// R3. Discard unsent drafts
// ---------------------------------------------------------------------------

/// Install the owner's region on sheet 1 (NOT the active sheet), with two
/// drafts (B3 = 10, B4 = 20) and one sent value (B5 = 30, submitted).
fn discard_fixture() -> AppState {
    let state = workbook_with_sheets(2);
    let (sub, pkg) = subscribe(&state, &[1]);
    install_writeback_index(&state, &[(sub, vec![region("r", pkg[0])])], Vec::new(), Vec::new());
    set_number(&state, 1, 2, 1, 10.0);
    set_number(&state, 1, 3, 1, 20.0);
    set_number(&state, 1, 4, 1, 30.0);
    // A dependent of the region on the same sheet.
    state.grids.write(&test_seed_effect()).unwrap()[1]
        .set_cell(0, 2, Cell::new_formula("SUM(B3:B5)".to_string()));
    put_in_layer(&state, entry("r", 2, 1, 10.0, SubmissionState::Draft));
    put_in_layer(&state, entry("r", 3, 1, 20.0, SubmissionState::Draft));
    put_in_layer(&state, entry("r", 4, 1, 30.0, SubmissionState::Submitted));
    state
}

fn discard(
    state: &AppState,
    file_state: &FileState,
    region_id: &str,
    cells: Option<&[WritebackCellRef]>,
    sent: Result<HashMap<(u32, u32), WritebackSubmission>, String>,
) -> Result<crate::calp_commands::DiscardWritebackDraftsResult, String> {
    discard_writeback_drafts_inner(
        state,
        file_state,
        &UserFilesState::default(),
        &crate::pivot::types::PivotState::new(),
        &crate::pane_control::PaneControlState::new(),
        &crate::ribbon_filter::RibbonFilterState::new(),
        region_id,
        cells,
        move |_, _| sent,
    )
}

/// B3 had been sent (7, approved) and then typed over; B4 was never sent. A
/// discard puts B3 back to 7 -- approved again -- blanks B4, leaves the sent B5
/// alone, and recalculates the dependent.
#[test]
fn discard_puts_back_what_was_sent_and_blanks_what_never_was() {
    let state = discard_fixture();
    let file_state = FileState::default();
    let mut sent = HashMap::new();
    sent.insert((2, 1), entry("r", 2, 1, 7.0, SubmissionState::Approved));

    let result = discard(&state, &file_state, "r", None, Ok(sent)).unwrap();

    assert_eq!(result.discarded, 2);
    assert_eq!(result.restored_cells.len(), 2);
    let b3 = &result.restored_cells[0];
    assert_eq!((b3.sheet_index, b3.row, b3.col), (1, 2, 1));
    assert_eq!(b3.restored_state, Some(SubmissionState::Approved));
    assert_eq!(b3.value, SubmissionValue::Number { value: 7.0 });
    let b4 = &result.restored_cells[1];
    assert_eq!((b4.row, b4.col), (3, 1));
    assert_eq!(b4.restored_state, None);
    assert_eq!(b4.value, SubmissionValue::Empty);

    assert_eq!(value_at(&state, 1, 2, 1), Some(CellValue::Number(7.0)));
    assert_eq!(value_at(&state, 1, 3, 1), None, "never sent: blank again");
    assert_eq!(value_at(&state, 1, 4, 1), Some(CellValue::Number(30.0)), "a sent value is untouched");
    assert_eq!(
        value_at(&state, 1, 0, 2),
        Some(CellValue::Number(37.0)),
        "the dependent recalculated over the restored cells"
    );

    let layer = state.writeback_layer.read().unwrap();
    assert_eq!(layer.get_draft("r", 2, 1).unwrap().state, SubmissionState::Approved);
    assert!(layer.get_draft("r", 3, 1).is_none());
    assert_eq!(layer.get_draft("r", 4, 1).unwrap().state, SubmissionState::Submitted);
    assert!(file_state.is_dirty(), "a discard changes the document");
}

/// `cells` narrows the discard; a cell outside the region is refused.
#[test]
fn discard_can_be_narrowed_to_cells_and_refuses_a_cell_outside_the_region() {
    let state = discard_fixture();
    let file_state = FileState::default();

    let err = discard(
        &state,
        &file_state,
        "r",
        Some(&[WritebackCellRef { row: 9, col: 9 }]),
        Ok(HashMap::new()),
    )
    .expect_err("J10 is not in B3:B5");
    assert!(err.contains("J10"), "got: {}", err);
    assert!(!file_state.is_dirty(), "a refusal leaves the document clean");

    let result = discard(
        &state,
        &file_state,
        "r",
        Some(&[WritebackCellRef { row: 3, col: 1 }]),
        Ok(HashMap::new()),
    )
    .unwrap();
    assert_eq!(result.discarded, 1);
    assert_eq!(value_at(&state, 1, 2, 1), Some(CellValue::Number(10.0)), "B3 not named, kept");
    assert_eq!(value_at(&state, 1, 3, 1), None);
    let layer = state.writeback_layer.read().unwrap();
    assert_eq!(layer.get_draft("r", 2, 1).unwrap().state, SubmissionState::Draft);
    assert!(layer.get_draft("r", 3, 1).is_none());
}

/// "I could not look up what was sent" is never "nothing was sent": the
/// discard is refused and nothing changes.
#[test]
fn discard_is_refused_whole_when_the_workspace_cannot_be_read() {
    let state = discard_fixture();
    let file_state = FileState::default();
    let err = discard(&state, &file_state, "r", None, Err("workspace offline".to_string()))
        .expect_err("an unreadable workspace must refuse");
    assert!(err.contains("workspace offline"), "got: {}", err);
    assert!(!file_state.is_dirty());
    assert_eq!(value_at(&state, 1, 2, 1), Some(CellValue::Number(10.0)));
    assert_eq!(value_at(&state, 1, 3, 1), Some(CellValue::Number(20.0)));
    let layer = state.writeback_layer.read().unwrap();
    assert_eq!(layer.unsent_draft_slots("r", None), vec![(2, 1), (3, 1)]);
}

/// Nothing unsent is an honest zero that does not dirty the document; an
/// unknown region is refused.
#[test]
fn discard_with_nothing_unsent_is_a_clean_zero_and_an_unknown_region_is_refused() {
    let state = discard_fixture();
    let file_state = FileState::default();
    discard(&state, &file_state, "r", None, Ok(HashMap::new())).unwrap();
    let file_state = FileState::default();
    let again = discard(&state, &file_state, "r", None, Ok(HashMap::new())).unwrap();
    assert_eq!(again.discarded, 0);
    assert!(again.restored_cells.is_empty());
    assert!(!file_state.is_dirty(), "nothing changed, nothing dirtied");

    assert!(discard(&state, &file_state, "nope", None, Ok(HashMap::new())).is_err());
    assert!(!file_state.is_dirty());
}

/// A discard that changed something ENDS THE UNDO HISTORY and leaves an audit
/// row. The step that typed the discarded value would otherwise still be on
/// the history: Ctrl+Z then Ctrl+Y would write it back into the cell with no
/// draft behind it.
///
/// SABOTAGE: drop the `end_undo_history_after_discard(state)` call -- the
/// typing step survives and `can_undo` stays true.
#[test]
fn discard_ends_the_undo_history_and_is_audited() {
    let state = discard_fixture();
    {
        let mut undo = state.undo_stack.lock().unwrap();
        let txn = undo.begin_owned_transaction("Type 10 into B3");
        undo.record_custom_restore("fixture".to_string(), Vec::new(), "Type 10 into B3");
        undo.commit_owned(txn);
        assert!(undo.can_undo(), "fixture: the typing step is on the history");
    }
    state.audit_log.write(&test_seed_effect()).unwrap().enabled = true;

    let file_state = FileState::default();
    let result = discard(&state, &file_state, "r", None, Ok(HashMap::new())).unwrap();
    assert_eq!(result.discarded, 2);

    assert!(
        !state.undo_stack.lock().unwrap().can_undo(),
        "the typing step must not survive to be redone into a draft-less cell"
    );
    let audit = state.audit_log.read().unwrap();
    let row = audit
        .entries
        .iter()
        .find(|e| matches!(e.event, calp::audit::AuditEvent::WritebackInvalidated))
        .expect("a discard is recorded");
    assert!(row.description.contains("Discarded 2 unsent writeback values"), "got: {}", row.description);
    assert!(row.description.contains("B3") && row.description.contains("B4"), "got: {}", row.description);
}

/// A discard whose drafts were emptied WHILE the workspace was being read (a
/// concurrent submit) is an honest zero: the document is not dirtied, the
/// history is kept, and nothing is audited.
///
/// SABOTAGE: construct `mutates` before re-deriving the slots under the layer
/// lock -- the document is dirtied for a no-op.
#[test]
fn a_discard_overtaken_by_a_submit_is_a_clean_zero() {
    let state = discard_fixture();
    {
        let mut undo = state.undo_stack.lock().unwrap();
        let txn = undo.begin_owned_transaction("Type 10 into B3");
        undo.record_custom_restore("fixture".to_string(), Vec::new(), "Type 10 into B3");
        undo.commit_owned(txn);
    }
    let file_state = FileState::default();
    let result = discard_writeback_drafts_inner(
        &state,
        &file_state,
        &UserFilesState::default(),
        &crate::pivot::types::PivotState::new(),
        &crate::pane_control::PaneControlState::new(),
        &crate::ribbon_filter::RibbonFilterState::new(),
        "r",
        None,
        |state, _| {
            // The "concurrent submit": every draft of the region is sent.
            state
                .writeback_layer
                .write(&test_seed_effect())
                .unwrap()
                .drafts
                .iter_mut()
                .for_each(|d| d.state = SubmissionState::Submitted);
            Ok(HashMap::new())
        },
    )
    .unwrap();
    assert_eq!(result.discarded, 0);
    assert!(!file_state.is_dirty(), "nothing changed, nothing dirtied");
    assert!(state.undo_stack.lock().unwrap().can_undo(), "a no-op keeps the history");
    assert_eq!(value_at(&state, 1, 2, 1), Some(CellValue::Number(10.0)));
}

/// A refresh replaces a subscribed sheet's cells with the publisher's content.
/// The writeback layer goes back on top: the cell shows what the subscriber
/// typed (a draft wins over an older sent entry for the same cell) or sent,
/// with the cell's style kept -- never a blank cell under a live draft.
///
/// SABOTAGE: return early from `reproject_writeback_layer_onto_grids` -- B3:B5
/// stay blank after the "refresh".
#[test]
fn a_refresh_puts_the_writeback_values_back_on_the_replaced_grid() {
    let state = discard_fixture();
    // B3 has a draft (10) and B5 a sent value (30); a newer draft for B5 wins.
    put_in_layer(&state, entry("r", 4, 1, 31.0, SubmissionState::Draft));
    // The "refresh": sheet 1's grid is replaced with the publisher's content,
    // which has nothing in B3:B5 but a style on B3.
    {
        let mut fresh = engine::Grid::new();
        let mut styled = Cell::new();
        styled.style_index = 3;
        fresh.set_cell(2, 1, styled);
        state.grids.write(&test_seed_effect()).unwrap()[1] = fresh;
    }
    assert_eq!(value_at(&state, 1, 2, 1), Some(CellValue::Empty), "fixture: blanked");

    let sheets: HashSet<identity::SheetId> = [local_id(&state, 1)].into_iter().collect();
    let cells = writeback_layer_cells_on_sheets(&state, &sheets);
    assert_eq!(cells.len(), 3, "B3, B4 and B5: {:?}", cells);
    let written = reproject_writeback_layer_onto_grids(&state, &test_seed_effect(), &sheets);
    assert_eq!(written.len(), 3);

    assert_eq!(value_at(&state, 1, 2, 1), Some(CellValue::Number(10.0)));
    assert_eq!(value_at(&state, 1, 3, 1), Some(CellValue::Number(20.0)));
    assert_eq!(value_at(&state, 1, 4, 1), Some(CellValue::Number(31.0)), "the draft wins");
    assert_eq!(
        state.grids.read().unwrap()[1].get_cell(2, 1).unwrap().style_index,
        3,
        "the publisher's style on the cell is kept"
    );

    // Another sheet is never touched.
    let other: HashSet<identity::SheetId> = [local_id(&state, 0)].into_iter().collect();
    assert!(reproject_writeback_layer_onto_grids(&state, &test_seed_effect(), &other).is_empty());
}

/// The index never held the sheet's regions (an HTTP subscription whose
/// rebuild was deferred, or one that was mid-rebuild), but the declaration
/// mirror did: detaching the sheet still drops that region's orphaned drafts,
/// read through the ledger BEFORE it changes.
///
/// SABOTAGE: take `regions_on_claimed` from the index alone -- the r1 draft
/// survives the detach forever.
#[test]
fn detaching_drops_orphans_the_index_never_held() {
    let state = workbook_with_sheets(3);
    let (sub, pkg) = subscribe(&state, &[1, 2]);
    // Nothing installed in the index; the mirror alone knows r1 (publisher id).
    let _ = sub;
    *state.writeback_declarations.lock().unwrap() = vec![region("r1", pkg[0])];
    put_in_layer(&state, entry("r1", 2, 1, 1.0, SubmissionState::Draft));
    put_in_layer(&state, entry("other", 2, 1, 5.0, SubmissionState::Draft));
    assert!(state.writeback_index.lock().unwrap().is_empty(), "fixture: index never held it");

    crate::calp_commands::detach_sheet_inner(
        &state,
        &FileState::default(),
        &crate::pivot::types::PivotState::new(),
        &crate::slicer::SlicerState::new(),
        &crate::timeline_slicer::TimelineSlicerState::new(),
        1,
    )
    .unwrap();

    let layer = state.writeback_layer.read().unwrap();
    assert!(layer.drafts.iter().all(|d| d.region_id != "r1"), "got: {:?}", layer.drafts);
    assert!(
        layer.drafts.iter().any(|d| d.region_id == "other"),
        "an entry the detach cannot attribute is kept"
    );
}
