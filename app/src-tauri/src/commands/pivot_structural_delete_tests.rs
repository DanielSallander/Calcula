//! FILENAME: app/src-tauri/src/commands/pivot_structural_delete_tests.rs
//! PURPOSE: BUG-0054 — a row/column delete that fully covers a pivot region
//!          must give the pivot the SAME death `delete_pivot_table` gives one.
//!
//! A child module of `data` (declared with `#[path]` there) so it reuses the
//! `Workbook` harness `cross_sheet_recalc_tests` owns — a copied harness
//! drifts, and BUG-0047 ("it has its own re-key, so it looked handled") is
//! this file's whole subject one store over.
//!
//! THE DEFECT THESE PIN. `shift_pivot_regions_for_row_delete` / `_col_delete`
//! removed a fully-covered pivot RAW: `pivot_tables.remove(&pid)` and nothing
//! else. Compare `delete_pivot_table`, which (1) cascades the slicers,
//! timeline slicers and ribbon-filter targets bound to the pivot, (2) records
//! `pivot_delete` + the cascade restores on the undo stack, and (3) cleans
//! `views` / `active_pivot_id` and prunes the object script. The structural
//! path did NONE of these: slicers survived pointing at a dead pivot id, and
//! undoing the row delete restored the pivot's CELLS (the grid snapshot) but
//! not the pivot OBJECT — a region that looks like a pivot and answers to
//! nothing.

use super::cross_sheet_recalc_tests::Workbook;
use crate::commands::structure::{delete_columns_impl, delete_rows_impl, off_sheet_structural_edit};
use identity::EntityId;
use pivot_engine::{PivotCache, PivotDefinition};

fn seed() -> crate::document_effect::DocumentEffect {
    crate::document_effect::test_seed_effect()
}

/// Seed one pivot the way the live stores hold one: definition + cache in
/// `pivot_tables`, a computed view in `views`, the protected region, and the
/// active-pivot pointer — plus one slicer bound to it.
fn seed_pivot_with_slicer(wb: &Workbook, sheet_index: usize) -> (EntityId, EntityId) {
    let pid = EntityId::from_bytes(identity::generate_uuid_v7());
    let mut def = PivotDefinition::new(pid, (0, 0), (3, 2));
    def.destination = (10, 0);
    def.name = Some("Doomed".to_string());
    if sheet_index != 0 {
        // Stored by NAME (the harness names sheets Sheet1..SheetN).
        def.destination_sheet = Some(format!("Sheet{}", sheet_index + 1));
    }
    let mut cache = PivotCache::new(pid, 2);
    let view = crate::pivot::operations::safe_calculate_pivot(&def, &mut cache);
    wb.pivots.views.lock().unwrap().insert(pid, view);
    wb.pivots
        .pivot_tables
        .write(&seed())
        .unwrap()
        .insert(pid, (def, cache));
    *wb.pivots.active_pivot_id.lock().unwrap() = Some(pid);
    wb.state.protected_regions.lock().unwrap().push(crate::ProtectedRegion {
        id: format!("pivot-{}", pid),
        region_type: "pivot".to_string(),
        owner_id: pid,
        sheet_index,
        start_row: 10,
        start_col: 0,
        end_row: 15,
        end_col: 3,
    });

    let sid = EntityId::from_bytes(identity::generate_uuid_v7());
    let slicer: crate::slicer::Slicer = serde_json::from_value(serde_json::json!({
        "id": sid.to_string(),
        "name": "DoomedSlicer",
        "sheetIndex": sheet_index,
        "x": 0.0, "y": 0.0, "width": 120.0, "height": 160.0,
        "sourceType": "pivot",
        "cacheSourceId": pid.to_string(),
        "fieldName": "F1",
        "selectedItems": null,
        "showHeader": true,
        "columns": 1,
        "stylePreset": "SlicerStyleLight1",
        "connectedSources": [{"sourceType": "pivot", "sourceId": pid.to_string()}]
    }))
    .expect("slicer from json");
    wb.slicer.slicers.write(&seed()).unwrap().insert(sid, slicer);
    (pid, sid)
}

/// Undo through the REAL restore path — same helper as the D8 file (the
/// `undo`/`redo` commands need an AppHandle; `apply_changes` is the body both
/// run).
fn undo(wb: &Workbook) {
    let transaction = wb
        .state
        .undo_stack
        .lock()
        .unwrap()
        .pop_undo()
        .expect("nothing to undo");
    crate::undo_commands::apply_changes(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.slicer, &wb.filters, &wb.pane, transaction,
        true,
    );
}

fn delete_rows_at(wb: &Workbook, row: u32, count: u32, sheet_index: Option<usize>) {
    delete_rows_impl(
        &wb.state, &wb.file, &wb.pivots, &wb.files, &wb.pane, &wb.filters, &wb.slicer,
        &wb.timeline, row, count, sheet_index,
    )
    .expect("delete_rows");
}

fn delete_cols_at(wb: &Workbook, col: u32, count: u32) {
    delete_columns_impl(
        &wb.state, &wb.file, &wb.pivots, &wb.files, &wb.pane, &wb.filters, &wb.slicer,
        &wb.timeline, col, count, None,
    )
    .expect("delete_columns");
}

#[test]
fn a_row_delete_covering_a_pivot_cascades_cleans_and_restores_on_undo() {
    let wb = Workbook::new(1);
    let (pid, sid) = seed_pivot_with_slicer(&wb, 0);

    // Rows 8..=17 fully cover the region (10..=15).
    delete_rows_at(&wb, 8, 10, None);

    assert!(
        !wb.pivots.pivot_tables.read().unwrap().contains_key(&pid),
        "the covered pivot is removed"
    );
    assert!(
        !wb.pivots.views.lock().unwrap().contains_key(&pid),
        "BUG-0054: the cached view must die with the pivot"
    );
    assert_eq!(
        *wb.pivots.active_pivot_id.lock().unwrap(),
        None,
        "BUG-0054: the active-pivot pointer must not survive its pivot"
    );
    assert!(
        !wb.slicer.slicers.read().unwrap().contains_key(&sid),
        "BUG-0054: the slicer bound to the dead pivot must cascade — an \
         orphan pointing at a dead id is the exact thing the cascade exists for"
    );
    assert!(
        !wb.state
            .protected_regions
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.owner_id == pid),
        "the pivot's protected region is removed"
    );

    // One Ctrl+Z restores rows + pivot OBJECT + slicer together.
    undo(&wb);

    let tables = wb.pivots.pivot_tables.read().unwrap();
    let restored = tables.get(&pid);
    assert!(
        restored.is_some(),
        "BUG-0054: undoing the row delete must restore the pivot OBJECT, not \
         only its rendered cells"
    );
    assert_eq!(
        restored.unwrap().0.name.as_deref(),
        Some("Doomed"),
        "the restored definition is the captured one"
    );
    drop(tables);
    assert!(
        wb.slicer.slicers.read().unwrap().contains_key(&sid),
        "the cascaded slicer comes back in the same Ctrl+Z"
    );
    assert!(
        wb.state
            .protected_regions
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.owner_id == pid),
        "the pivot's protected region is re-registered by the restore"
    );
}

#[test]
fn a_column_delete_covering_a_pivot_cascades_and_restores_on_undo() {
    let wb = Workbook::new(1);
    let (pid, sid) = seed_pivot_with_slicer(&wb, 0);

    // Columns 0..=4 fully cover the region (0..=3).
    delete_cols_at(&wb, 0, 5);

    assert!(
        !wb.pivots.pivot_tables.read().unwrap().contains_key(&pid),
        "the covered pivot is removed"
    );
    assert!(
        !wb.slicer.slicers.read().unwrap().contains_key(&sid),
        "BUG-0054 (column twin): the bound slicer must cascade"
    );

    undo(&wb);

    assert!(
        wb.pivots.pivot_tables.read().unwrap().contains_key(&pid),
        "undo restores the pivot object"
    );
    assert!(
        wb.slicer.slicers.read().unwrap().contains_key(&sid),
        "undo restores the cascaded slicer"
    );
}

#[test]
fn an_off_sheet_row_delete_covering_a_pivot_takes_the_same_path() {
    let wb = Workbook::new(2);
    let (pid, sid) = seed_pivot_with_slicer(&wb, 1);

    // Sheet 0 is active; delete on sheet 1 routes through
    // `off_sheet_structural_edit`, whose pivot removal had the same gap.
    off_sheet_structural_edit(
        &wb.state,
        &wb.file,
        &wb.pivots,
        &wb.files,
        &wb.pane,
        &wb.filters,
        &wb.slicer,
        &wb.timeline,
        1,
        calp::writeback::StructuralEdit::RowDelete { at: 8, count: 10 },
    )
    .expect("off-sheet delete");

    assert!(
        !wb.pivots.pivot_tables.read().unwrap().contains_key(&pid),
        "the covered pivot is removed"
    );
    assert!(
        !wb.slicer.slicers.read().unwrap().contains_key(&sid),
        "BUG-0054 (off-sheet): the bound slicer must cascade"
    );

    undo(&wb);

    assert!(
        wb.pivots.pivot_tables.read().unwrap().contains_key(&pid),
        "undo restores the pivot object"
    );
    assert!(
        wb.slicer.slicers.read().unwrap().contains_key(&sid),
        "undo restores the cascaded slicer"
    );
}

/// A delete that only PARTIALLY covers the region must keep the pivot (the
/// shift path handles it) and must NOT touch the slicer — the doom test and
/// the removal test are the same predicate, pinned from both sides.
#[test]
fn a_partial_cover_keeps_the_pivot_and_its_slicer() {
    let wb = Workbook::new(1);
    let (pid, sid) = seed_pivot_with_slicer(&wb, 0);

    // Rows 12..=13: inside the region but not covering it.
    delete_rows_at(&wb, 12, 2, None);

    assert!(
        wb.pivots.pivot_tables.read().unwrap().contains_key(&pid),
        "a partially covered pivot survives (shifted, not deleted)"
    );
    assert!(
        wb.slicer.slicers.read().unwrap().contains_key(&sid),
        "no cascade for a surviving pivot"
    );
}
