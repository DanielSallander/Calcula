//! FILENAME: app/src-tauri/src/writeback_local_sheet_tests.rs
//! PURPOSE: A subscriber's writeback regions live on the subscriber's LOCAL
//!          sheets, detaching orphans nothing, a discard puts back what was
//!          sent, and a reconcile shows a subscriber what they last sent -- in a
//!          brand-new workbook too (BUG-0554).
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
    adopt_own_sent_values_inner, discard_writeback_drafts_inner, ensure_range_unclaimed, ensure_writeback_draft_before_write,
    ensure_writeback_draft_before_write_on_sheets, install_writeback_index,
    reproject_writeback_layer_onto_grids, writeback_layer_cells_on_sheets, writeback_region_at,
    writeback_region_entries, AdoptOutcome, OwnSentRecords, WritebackCellRef,
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
            principal_name: String::new(),
            provider: Default::default(),
            scope: Default::default(),
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
        seal: None,
        sender: Default::default(),
        identity: Default::default(),
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
/// SABOTAGE: drop the `end_undo_history_after_writeback_rewrite(state, ..)` call in the discard -- the
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

// ---------------------------------------------------------------------------
// BUG-0554. A subscriber sees what THEY last sent -- on subscribe, reopen and
// refresh -- never over an unsent draft
// ---------------------------------------------------------------------------

/// A record the way the WORKSPACE holds it: its own id and timestamp.
fn sent_record(
    id: &str,
    row: u32,
    col: u32,
    value: f64,
    state: SubmissionState,
) -> WritebackSubmission {
    let mut rec = entry("r", row, col, value, state);
    rec.id = id.to_string();
    rec.updated_at = "2026-10-21T18:52:00Z".to_string();
    // What the fold concludes about a record this subscriber's key signed
    // (identity phase 1): only such a record is "mine".
    rec.sender = calp::SenderCheck::Signed;
    rec
}

/// The fixture subscriber's identity -- the id `entry` files records under.
fn fixture_identity() -> calp::SubmitterIdentity {
    entry("r", 0, 0, 0.0, SubmissionState::Draft).submitter
}

/// The owner's region on the subscribed sheet (index 1, NOT active, a local
/// id different from the publisher's), a dependent `C1 = SUM(B3:B5)` beside
/// it, and an EMPTY writeback layer -- the shape of a brand-new workbook that
/// just subscribed.
fn fresh_subscriber() -> AppState {
    let state = workbook_with_sheets(2);
    let (sub, pkg) = subscribe(&state, &[1]);
    install_writeback_index(&state, &[(sub, vec![region("r", pkg[0])])], Vec::new(), Vec::new());
    state.grids.write(&test_seed_effect()).unwrap()[1]
        .set_cell(0, 2, Cell::new_formula("SUM(B3:B5)".to_string()));
    assert!(state.writeback_layer.read().unwrap().drafts.is_empty(), "fixture: a new workbook");
    // This computer sends as the fixture subscriber.
    *state.subscriber_identity.lock().unwrap() = Some(fixture_identity());
    state
}

fn adopt(
    state: &AppState,
    file_state: &FileState,
    sent: HashMap<(u32, u32), WritebackSubmission>,
    complete: bool,
) -> AdoptOutcome {
    adopt_own_sent_values_inner(
        state,
        file_state,
        &UserFilesState::default(),
        &crate::pivot::types::PivotState::new(),
        &crate::pane_control::PaneControlState::new(),
        &crate::ribbon_filter::RibbonFilterState::new(),
        move |_, region_id| {
            assert_eq!(region_id, "r", "only the index's region is asked about");
            Ok(OwnSentRecords { by_cell: sent.clone(), complete })
        },
    )
    .unwrap()
}

/// THE OWNER'S CASE. A new workbook subscribes to the application the same
/// person already answered from another workbook: B3:B5 show what they last
/// sent, with each value's state, on the SUBSCRIBED sheet -- and the dependent
/// recalculates. Nothing lands on the blank `Sheet1`.
///
/// SABOTAGE (proved 2026-10-21): make the `None if held.is_empty()` arm of
/// `adopt_own_sent_values_inner` push nothing -- the pre-fix behaviour, where
/// reconcile only ever looked at cells the layer already held. B3:B5 stay
/// blank and this test fails at the first value assertion.
#[test]
fn a_fresh_subscribe_shows_the_values_this_subscriber_last_sent() {
    let state = fresh_subscriber();
    state.audit_log.write(&test_seed_effect()).unwrap().enabled = false;
    let file_state = FileState::default();
    let mut sent = HashMap::new();
    sent.insert((2, 1), sent_record("s-b3", 2, 1, 4.0, SubmissionState::Submitted));
    sent.insert((3, 1), sent_record("s-b4", 3, 1, 5.0, SubmissionState::Approved));
    sent.insert((4, 1), sent_record("s-b5", 4, 1, 6.0, SubmissionState::Rejected));

    let outcome = adopt(&state, &file_state, sent, true);

    assert_eq!(outcome.cells_written, 3);
    assert_eq!(outcome.entries_changed, 3);
    assert_eq!(value_at(&state, 1, 2, 1), Some(CellValue::Number(4.0)));
    assert_eq!(value_at(&state, 1, 3, 1), Some(CellValue::Number(5.0)));
    assert_eq!(value_at(&state, 1, 4, 1), Some(CellValue::Number(6.0)));
    assert_eq!(
        value_at(&state, 1, 0, 2),
        Some(CellValue::Number(15.0)),
        "the dependent recalculated over the shown values"
    );
    for row in 2..=4 {
        assert_eq!(value_at(&state, 0, row, 1), None, "the blank Sheet1 is untouched");
    }
    let layer = state.writeback_layer.read().unwrap();
    assert_eq!(layer.get_draft("r", 2, 1).unwrap().state, SubmissionState::Submitted);
    assert_eq!(layer.get_draft("r", 3, 1).unwrap().state, SubmissionState::Approved);
    assert_eq!(layer.get_draft("r", 4, 1).unwrap().state, SubmissionState::Rejected);
    assert_eq!(layer.get_draft("r", 2, 1).unwrap().id, "s-b3", "the workspace's own record");
    drop(layer);
    assert!(file_state.is_dirty(), "the workbook now holds values it did not hold");

    // Recorded even with collaboration auditing OFF: the cells changed with no
    // keystroke, so the trail must say where the values came from.
    let audit = state.audit_log.read().unwrap();
    let row = audit
        .entries
        .iter()
        .find(|e| matches!(e.event, calp::audit::AuditEvent::WritebackRestored))
        .expect("showing sent values is recorded");
    assert!(row.description.contains("'writeback-test'"), "got: {}", row.description);
    assert!(row.description.contains("B3, B4, B5"), "got: {}", row.description);
    assert!(row.description.contains("Sheet2"), "got: {}", row.description);
}

/// IDENTITY PHASE 1 (open-items 2.am): a record PLANTED under my id -- written
/// by hand into my folder, not signed by my key -- and a record under another
/// id are never shown as "what you last sent", and a planted newer record never
/// REPLACES a value the workbook holds.
///
/// SABOTAGE: drop the `is_mine` clause from `adopt_own_sent_values_inner`'s
/// filter -- B3 shows 666.
#[test]
fn a_record_planted_under_my_id_is_never_adopted() {
    let state = fresh_subscriber();
    state.audit_log.write(&test_seed_effect()).unwrap().enabled = false;
    put_in_layer(&state, sent_record("s-real", 4, 1, 6.0, SubmissionState::Submitted));
    let mut sent = HashMap::new();
    let mut planted = sent_record("s-plant", 2, 1, 666.0, SubmissionState::Approved);
    planted.sender = calp::SenderCheck::BeforeSignIn;
    sent.insert((2, 1), planted);
    let mut foreign = sent_record("s-foreign", 3, 1, 777.0, SubmissionState::Submitted);
    foreign.submitter.id = "someone-else".to_string();
    sent.insert((3, 1), foreign);
    let mut newer_plant = sent_record("s-newer", 4, 1, 999.0, SubmissionState::Approved);
    newer_plant.sender = calp::SenderCheck::Unchecked;
    sent.insert((4, 1), newer_plant);

    let outcome = adopt(&state, &FileState::default(), sent, true);
    assert_eq!(outcome.cells_written, 0, "{outcome:?}");
    assert_eq!(outcome.entries_changed, 0);
    let layer = state.writeback_layer.read().unwrap();
    assert!(layer.get_draft("r", 2, 1).is_none());
    assert!(layer.get_draft("r", 3, 1).is_none());
    assert_eq!(layer.get_draft("r", 4, 1).unwrap().id, "s-real", "the held value is not replaced");
}

/// The subscribed sheet is the ACTIVE one: the value reaches `grid` (what the
/// active sheet is read from) as well as `grids[active]`.
#[test]
fn a_shown_value_reaches_the_active_sheets_grid_too() {
    let state = fresh_subscriber();
    *state.active_sheet.write(&test_seed_effect()).unwrap() = 1;
    let mut sent = HashMap::new();
    sent.insert((2, 1), sent_record("s-b3", 2, 1, 4.0, SubmissionState::Submitted));
    let outcome = adopt(&state, &FileState::default(), sent, true);
    assert_eq!(outcome.cells_written, 1);
    assert_eq!(
        state.grid.read().unwrap().get_cell(2, 1).map(|c| c.value.clone()),
        Some(CellValue::Number(4.0)),
        "the active sheet's own grid shows it"
    );
    assert_eq!(value_at(&state, 1, 2, 1), Some(CellValue::Number(4.0)));
}

/// An UNSENT draft always wins, even over a newer sent record: it is what the
/// subscriber typed last.
#[test]
fn a_shown_value_never_overwrites_an_unsent_draft() {
    let state = fresh_subscriber();
    put_in_layer(&state, entry("r", 4, 1, 9.0, SubmissionState::Draft));
    set_number(&state, 1, 4, 1, 9.0);
    let file_state = FileState::default();
    let mut sent = HashMap::new();
    sent.insert((4, 1), sent_record("s-b5", 4, 1, 6.0, SubmissionState::Approved));

    let outcome = adopt(&state, &file_state, sent, true);

    assert_eq!(outcome, AdoptOutcome::default());
    assert!(!file_state.is_dirty(), "nothing changed, nothing dirtied");
    assert_eq!(value_at(&state, 1, 4, 1), Some(CellValue::Number(9.0)));
    let layer = state.writeback_layer.read().unwrap();
    let held = layer.get_draft("r", 4, 1).unwrap();
    assert_eq!(held.state, SubmissionState::Draft);
    assert_eq!(held.value, SubmissionValue::Number { value: 9.0 });
}

/// THE SECOND DEFECT. This workbook sent 1 for B3; later the same person sent 4
/// from another workbook and the publisher approved the 4. Reconcile used to
/// copy only the STATE of the newest record, so B3 showed "1, approved" -- a
/// value that was never approved. The entry is now replaced WHOLE, the cell
/// shows 4, and the undo history ends (the step that typed the 1 must not be
/// redone into a cell whose entry says 4).
///
/// SABOTAGE (proved 2026-10-21): make the `None if read.complete` arm copy only the state onto the
/// held entry (the old behaviour) -- B3 keeps 1 and its id.
#[test]
fn a_newer_value_sent_from_another_workbook_replaces_the_stale_one_whole() {
    let state = fresh_subscriber();
    let mut mine = entry("r", 2, 1, 1.0, SubmissionState::Submitted);
    mine.id = "sent-from-this-workbook".to_string();
    put_in_layer(&state, mine);
    set_number(&state, 1, 2, 1, 1.0);
    {
        let mut undo = state.undo_stack.lock().unwrap();
        let txn = undo.begin_owned_transaction("Type 1 into B3");
        undo.record_custom_restore("fixture".to_string(), Vec::new(), "Type 1 into B3");
        undo.commit_owned(txn);
    }
    let file_state = FileState::default();
    let mut sent = HashMap::new();
    sent.insert((2, 1), sent_record("sent-from-another-workbook", 2, 1, 4.0, SubmissionState::Approved));

    let outcome = adopt(&state, &file_state, sent, true);

    assert_eq!(outcome.cells_written, 1);
    // The history ending is REPORTED, with the cell, so the user is told: no
    // keystroke of theirs caused it.
    assert!(outcome.undo_history_ended);
    assert_eq!(outcome.replaced_cells, vec!["Sheet2!B3".to_string()]);
    assert_eq!(value_at(&state, 1, 2, 1), Some(CellValue::Number(4.0)));
    let layer = state.writeback_layer.read().unwrap();
    let held: Vec<_> = layer.drafts.iter().filter(|d| d.cell_row == 2 && d.cell_col == 1).collect();
    assert_eq!(held.len(), 1, "one entry per cell: {:?}", held);
    assert_eq!(held[0].id, "sent-from-another-workbook");
    assert_eq!(held[0].value, SubmissionValue::Number { value: 4.0 });
    assert_eq!(held[0].state, SubmissionState::Approved);
    drop(layer);
    assert!(file_state.is_dirty());
    assert!(
        !state.undo_stack.lock().unwrap().can_undo(),
        "the step that typed the replaced 1 must not survive to be redone"
    );
}

/// A PARTIAL read (some version could not be read) may fill a blank cell but
/// never replaces a sent value the workbook holds: the unreadable version may
/// be exactly where that value lives.
#[test]
fn a_partial_read_fills_blanks_but_never_replaces_a_sent_value() {
    let state = fresh_subscriber();
    let mut mine = entry("r", 2, 1, 1.0, SubmissionState::Submitted);
    mine.id = "sent-here".to_string();
    put_in_layer(&state, mine);
    set_number(&state, 1, 2, 1, 1.0);
    let mut sent = HashMap::new();
    sent.insert((2, 1), sent_record("older-elsewhere", 2, 1, 4.0, SubmissionState::Approved));
    sent.insert((3, 1), sent_record("s-b4", 3, 1, 5.0, SubmissionState::Submitted));

    let outcome = adopt(&state, &FileState::default(), sent, false);

    assert_eq!(outcome.cells_written, 1, "only the blank B4");
    assert_eq!(value_at(&state, 1, 2, 1), Some(CellValue::Number(1.0)), "B3 kept");
    assert_eq!(value_at(&state, 1, 3, 1), Some(CellValue::Number(5.0)), "B4 filled");
    let layer = state.writeback_layer.read().unwrap();
    assert_eq!(layer.get_draft("r", 2, 1).unwrap().id, "sent-here");
    assert_eq!(layer.get_draft("r", 2, 1).unwrap().state, SubmissionState::Submitted);
}

/// The return leg is kept: the SAME submission approved by the publisher
/// changes only the entry's state, reason and reviewer -- no cell is written.
#[test]
fn the_same_submission_only_takes_its_review_state() {
    let state = fresh_subscriber();
    let mine = sent_record("s-b3", 2, 1, 4.0, SubmissionState::Submitted);
    put_in_layer(&state, mine);
    set_number(&state, 1, 2, 1, 4.0);
    let file_state = FileState::default();
    let mut reviewed = sent_record("s-b3", 2, 1, 4.0, SubmissionState::Rejected);
    reviewed.review_reason = Some("too high".to_string());
    reviewed.reviewed_by = Some("Publisher".to_string());
    let mut sent = HashMap::new();
    sent.insert((2, 1), reviewed);

    let outcome = adopt(&state, &file_state, sent, true);

    assert_eq!(outcome, AdoptOutcome { cells_written: 0, entries_changed: 1, ..AdoptOutcome::default() });
    let layer = state.writeback_layer.read().unwrap();
    let held = layer.get_draft("r", 2, 1).unwrap();
    assert_eq!(held.state, SubmissionState::Rejected);
    assert_eq!(held.review_reason.as_deref(), Some("too high"));
    assert_eq!(held.reviewed_by.as_deref(), Some("Publisher"));
    drop(layer);
    assert!(file_state.is_dirty(), "the review state is saved with the workbook");
}

/// Nothing new -- or a workspace that cannot be read -- leaves the document
/// CLEAN. The reconcile runs on every open; dirtying here made the close
/// prompt fire on a workbook that was merely looked at.
///
/// SABOTAGE: construct `mutates` before the `plan.is_empty()` return -- the
/// first assertion on `is_dirty` fails.
#[test]
fn nothing_new_to_show_leaves_the_document_clean() {
    let state = fresh_subscriber();
    put_in_layer(&state, sent_record("s-b3", 2, 1, 4.0, SubmissionState::Approved));
    set_number(&state, 1, 2, 1, 4.0);
    let file_state = FileState::default();
    let mut sent = HashMap::new();
    sent.insert((2, 1), sent_record("s-b3", 2, 1, 4.0, SubmissionState::Approved));
    assert_eq!(adopt(&state, &file_state, sent, true), AdoptOutcome::default());
    assert!(!file_state.is_dirty(), "the layer already agrees with the workspace");

    assert_eq!(adopt(&state, &file_state, HashMap::new(), true), AdoptOutcome::default());
    assert!(!file_state.is_dirty(), "nothing sent, nothing to show");

    let unreadable = adopt_own_sent_values_inner(
        &state,
        &file_state,
        &UserFilesState::default(),
        &crate::pivot::types::PivotState::new(),
        &crate::pane_control::PaneControlState::new(),
        &crate::ribbon_filter::RibbonFilterState::new(),
        |_, _| Err("workspace offline".to_string()),
    )
    .expect("offline is normal: the region is skipped, not an error");
    // ...but never in silence: the reason comes back, so Check Status can say
    // it could not reach the workspace instead of "Status updated".
    assert_eq!(
        unreadable,
        AdoptOutcome {
            unreadable: vec![("r".to_string(), "workspace offline".to_string())],
            ..AdoptOutcome::default()
        }
    );
    assert!(!file_state.is_dirty());
    assert_eq!(value_at(&state, 1, 2, 1), Some(CellValue::Number(4.0)));

    // A workbook with no subscribed region never asks the workspace at all.
    let plain = workbook_with_sheets(1);
    let asked = std::cell::Cell::new(false);
    let none = adopt_own_sent_values_inner(
        &plain,
        &file_state,
        &UserFilesState::default(),
        &crate::pivot::types::PivotState::new(),
        &crate::pane_control::PaneControlState::new(),
        &crate::ribbon_filter::RibbonFilterState::new(),
        |_, _| {
            asked.set(true);
            Ok(OwnSentRecords { by_cell: HashMap::new(), complete: true })
        },
    )
    .unwrap();
    assert_eq!(none, AdoptOutcome::default());
    assert!(!asked.get(), "no region, no workspace read");
}

/// A record the CURRENT declaration refuses is never shown: a cell outside the
/// region (the region shrank since), a value its type check rejects (carried
/// forward from a version whose type changed), a model-keyed record, and a
/// record that claims to be an unsent draft.
#[test]
fn a_record_the_current_region_refuses_is_not_shown() {
    let state = workbook_with_sheets(2);
    // This computer sends as the fixture subscriber (identity phase 1: only
    // what is mine is ever shown).
    *state.subscriber_identity.lock().unwrap() = Some(fixture_identity());
    let (sub, pkg) = subscribe(&state, &[1]);
    let mut decl = region("r", pkg[0]);
    decl.schema = Some(calp::writeback::ValueSchema {
        value_type: calp::writeback::ValueType::Integer,
        required: false,
        min: None,
        max: None,
        enum_values: Vec::new(),
        max_length: None,
        pattern: None,
        extra: HashMap::new(),
    });
    install_writeback_index(&state, &[(sub, vec![decl])], Vec::new(), Vec::new());
    let file_state = FileState::default();
    let mut sent = HashMap::new();
    // Outside B3:B5.
    sent.insert((9, 1), sent_record("outside", 9, 1, 1.0, SubmissionState::Submitted));
    // The current type is an integer.
    sent.insert((2, 1), sent_record("fraction", 2, 1, 2.5, SubmissionState::Submitted));
    // Model-keyed.
    let mut keyed = sent_record("keyed", 3, 1, 3.0, SubmissionState::Submitted);
    keyed.model_key = Some(vec!["k".to_string()]);
    sent.insert((3, 1), keyed);
    // A "draft" in the workspace.
    sent.insert((4, 1), sent_record("drafty", 4, 1, 4.0, SubmissionState::Draft));

    assert_eq!(adopt(&state, &file_state, sent, true), AdoptOutcome::default());
    assert!(!file_state.is_dirty());
    assert!(state.writeback_layer.read().unwrap().drafts.is_empty());
    assert_eq!(value_at(&state, 1, 9, 1), None);
    assert_eq!(value_at(&state, 1, 2, 1), None);

    // A value the type check accepts is shown.
    let mut ok = HashMap::new();
    ok.insert((2, 1), sent_record("whole", 2, 1, 3.0, SubmissionState::Submitted));
    assert_eq!(adopt(&state, &file_state, ok, true).cells_written, 1);
    assert_eq!(value_at(&state, 1, 2, 1), Some(CellValue::Number(3.0)));
}

/// The publisher made a cell a FORMULA in this version: the record enters the
/// layer (a later version may free the cell again) but the formula is never
/// overwritten -- the rule `reproject_writeback_layer_onto_grids` follows.
#[test]
fn a_shown_value_never_overwrites_a_publisher_formula() {
    let state = fresh_subscriber();
    state.grids.write(&test_seed_effect()).unwrap()[1]
        .set_cell(3, 1, Cell::new_formula("1+1".to_string()));
    let mut sent = HashMap::new();
    sent.insert((3, 1), sent_record("s-b4", 3, 1, 5.0, SubmissionState::Submitted));

    let outcome = adopt(&state, &FileState::default(), sent, true);

    assert_eq!(outcome, AdoptOutcome { cells_written: 0, entries_changed: 1, ..AdoptOutcome::default() });
    assert!(state.grids.read().unwrap()[1].get_cell(3, 1).unwrap().has_formula());
    assert!(state.writeback_layer.read().unwrap().get_draft("r", 3, 1).is_some());
}

/// The reconcile command reads through `adopt_own_sent_values_inner`, so every
/// path that reconciles (subscribe, open, refresh, environment switch) shows
/// what was sent; and the command tells the grid to RE-READ its cells (the
/// frontend's own repaint only repaints cached cells).
#[test]
fn the_reconcile_command_adopts_and_asks_the_grid_to_reread() {
    let src = include_str!("calp_commands.rs");
    let start = src.find("fn reconcile_writeback_layer_internal(").expect("reconcile");
    let body = &src[start..start + src[start..].find("\n}\n").unwrap()];
    assert!(body.contains("adopt_own_sent_values_inner("), "reconcile must adopt sent values");
    assert!(
        body.contains("own_sent_records_by_region(state)") && !body.contains("own_current_records_for_region("),
        "the reader reads every region ONCE per pass, never a strict-then-lenient walk per region"
    );
    let start = src.find("pub fn calp_reconcile_writeback(").expect("command");
    let body = &src[start..start + src[start..].find("\n}\n").unwrap()];
    assert!(body.contains("emit(\"grid:refresh\""), "the grid must re-read the shown values");
}

/// A DRAFT THE WORKSPACE ALREADY HOLDS WAS SENT. The workbook was saved with an
/// unsent draft, submitted, and closed without saving: on reopen the layer
/// holds Draft id X while the workspace holds Submitted id X with the same
/// value (a submit keeps the draft's id; every edit mints a new one). The
/// entry takes the workspace's state, so the unsent marker and the tab badge
/// go and Submit does not send X again. A Draft with a DIFFERENT id is a real
/// unsent edit and still wins.
///
/// SABOTAGE: restore the old guard `if held.iter().any(|d| d.state ==
/// SubmissionState::Draft) { continue; }` -- the entry stays a Draft and the
/// first assertion fails.
#[test]
fn a_draft_the_workspace_already_holds_is_shown_as_sent() {
    let state = fresh_subscriber();
    put_in_layer(&state, sent_record("s-b3", 2, 1, 4.0, SubmissionState::Draft));
    set_number(&state, 1, 2, 1, 4.0);
    // A real unsent edit beside it: a different id than the workspace's record.
    put_in_layer(&state, sent_record("typed-after", 3, 1, 8.0, SubmissionState::Draft));
    set_number(&state, 1, 3, 1, 8.0);
    let file_state = FileState::default();
    let mut sent = HashMap::new();
    sent.insert((2, 1), sent_record("s-b3", 2, 1, 4.0, SubmissionState::Submitted));
    sent.insert((3, 1), sent_record("s-b4-earlier", 3, 1, 5.0, SubmissionState::Submitted));

    let outcome = adopt(&state, &file_state, sent, true);

    let layer = state.writeback_layer.read().unwrap();
    assert_eq!(
        layer.get_draft("r", 2, 1).unwrap().state,
        SubmissionState::Submitted,
        "the draft the workspace holds under its own id was sent"
    );
    let typed = layer.get_draft("r", 3, 1).unwrap();
    assert_eq!(typed.state, SubmissionState::Draft, "a real unsent edit still wins");
    assert_eq!(typed.value, SubmissionValue::Number { value: 8.0 });
    drop(layer);
    assert_eq!(outcome.cells_written, 0, "no value changed");
    assert_eq!(outcome.entries_changed, 1);
    assert_eq!(value_at(&state, 1, 3, 1), Some(CellValue::Number(8.0)));
}

/// THE LOCAL ENTRY OF A SUBMIT CARRIES ITS STREAM. Only the clone sent to the
/// workspace was stamped, so a sent entry read "" (the development line) in
/// the layer while an ADOPTED one carried its record's stream.
#[test]
fn the_submit_stamps_the_local_entry_with_its_stream_too() {
    let src = include_str!("calp_commands.rs");
    let start = src.find("fn submit_region_internal(").expect("submit");
    let body = &src[start..start + src[start..].find("\n}\n").unwrap()];
    let advance = body.find("submit_region(region_id, &now)").expect("the layer advances");
    let stamp = body.find("entry.environment = environment.clone()").expect("the local stamp");
    assert!(advance < stamp, "the entries the submit advanced are stamped");
}

/// Copy a workspace folder (the "temp copy" the owner's answers are tested on).
fn copy_tree(from: &std::path::Path, to: &std::path::Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap().flatten() {
        let target = to.join(entry.file_name());
        if entry.path().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).unwrap();
        }
    }
}

/// IDENTITY PHASE 1, END TO END ON A COPY OF A WORKSPACE. This computer
/// really sends B3 = 4 (signed with its key) into a temp workspace; the
/// workspace is COPIED; and in the copy three records are planted under MY
/// sender id -- an unsigned newer B3 = 666, a B4 = 777 signed by Mallory's key,
/// and my OWN signed B5 = 888 lifted out of another version (a replay). Read
/// back through the real reader (`own_records_by_region_in`, what reconcile and
/// a fresh subscribe use) and shown through the real adopt path, only my 4 is
/// "what you last sent"; B4 and B5 stay empty.
///
/// SABOTAGE: drop the `is_mine` filter in `own_records_by_region_in` AND make
/// the fold keep forged answers -- 666/777/888 reach the cells. (Either guard
/// alone holds, as `only_what_my_key_signed_is_mine` documents.)
#[test]
fn a_planted_answer_in_a_copy_of_the_workspace_never_seeds_my_cells() {
    let prof = tempfile::TempDir::new().unwrap();
    crate::profile_dir::with_test_profile(prof.path(), || {
        let original = tempfile::TempDir::new().unwrap();
        let me = crate::submitter_identity::current_identity().unwrap();
        let mine_signed = |id: &str, row: u32, value: f64, version: &str, at: &str| {
            let mut s = entry("r", row, 1, value, SubmissionState::Submitted);
            s.id = id.to_string();
            s.submitter = me.clone();
            s.updated_at = at.to_string();
            s.submitted_at = Some(at.to_string());
            crate::submitter_identity::seal_outgoing(&mut s, APP, version, calp::SubmissionOrigin::Interactive)
                .unwrap();
            s
        };
        let real = mine_signed("s-mine", 2, 4.0, "1.0.0", "2026-10-22T09:00:00Z");
        let reg = calp::workspace::LocalWorkspace::open(original.path()).unwrap();
        reg.save_submission(APP, "1.0.0", &real).unwrap();

        let copy = tempfile::TempDir::new().unwrap();
        copy_tree(original.path(), copy.path());
        let copied = calp::workspace::LocalWorkspace::open(copy.path()).unwrap();

        // (1) Unsigned, newer, under my id.
        let mut plant = real.clone();
        plant.id = "s-plant".into();
        plant.updated_at = "2030-01-01T00:00:00Z".into();
        plant.value = SubmissionValue::Number { value: 666.0 };
        plant.seal = None;
        copied.save_submission(APP, "1.0.0", &plant).unwrap();
        // (2) Signed by Mallory's key, under my id.
        let mut mallory = real.clone();
        mallory.id = "s-mallory".into();
        mallory.cell_row = 3;
        mallory.value = SubmissionValue::Number { value: 777.0 };
        let mallory_seed = [42u8; 32];
        let mut as_mallory = mallory.clone();
        as_mallory.submitter = calp::identity_provider::identity_for(
            calp::IdentityProviderKind::Windows,
            &calp::identity_provider::AccountFacts {
                subject: "S-1-5-21-1-2-3-6666".into(),
                principal_name: "CORP\\mallory".into(),
                display_name: "Mallory".into(),
                scope: calp::AccountScope::Domain,
            },
            &calp::submission_seal::public_key_of_seed(&mallory_seed),
        )
        .unwrap();
        calp::submission_seal::seal_submission(
            &mut as_mallory,
            APP,
            "1.0.0",
            &mallory_seed,
            calp::SubmissionOrigin::Interactive,
        )
        .unwrap();
        mallory.seal = as_mallory.seal;
        copied.save_submission(APP, "1.0.0", &mallory).unwrap();
        // (3) My own answer for ANOTHER version, replayed into 1.0.0.
        let replay = mine_signed("s-replay", 4, 888.0, "9.9.9", "2030-01-02T00:00:00Z");
        copied.save_submission(APP, "1.0.0", &replay).unwrap();

        let (by_region, unread) = crate::calp_commands::own_records_by_region_in(
            &copied,
            APP,
            &["1.0.0".to_string()],
            "",
            &me,
            &calp::ReviewAuthority::none(),
        );
        assert!(unread.is_empty(), "{unread:?}");
        let records = by_region.get("r").cloned().unwrap_or_default();
        assert_eq!(records.len(), 1, "only what my key signed for this version: {:?}", records.keys());
        assert_eq!(records.get(&(2, 1)).map(|s| s.id.as_str()), Some("s-mine"));

        let state = fresh_subscriber();
        state.audit_log.write(&test_seed_effect()).unwrap().enabled = false;
        *state.subscriber_identity.lock().unwrap() = Some(me.clone());
        let outcome = adopt(&state, &FileState::default(), records, true);
        assert_eq!(outcome.cells_written, 1, "{outcome:?}");
        assert_eq!(value_at(&state, 1, 2, 1), Some(CellValue::Number(4.0)), "my real answer, not 666");
        assert_eq!(value_at(&state, 1, 3, 1), None, "Mallory's 777 never seeds my cell");
        assert_eq!(value_at(&state, 1, 4, 1), None, "the replayed 888 never seeds my cell");
    });
}
