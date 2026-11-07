//! FILENAME: app/src-tauri/src/autofilter_sort_state_tests.rs
//! PURPOSE: BUG-0740 -- an AutoFilter remembers the sort its data was sorted
//!          by, and Data > Reapply re-filters AND re-sorts by it, as Excel's
//!          `AutoFilter.ApplyFilter` does; a sort of filtered data moves only
//!          the rows the filter shows.
//! CONTEXT: A `#[path]` child of `autofilter`.
//!
//! [LIVE, Excel 16, 2026-11-06, lane tabxlsx probe1] A1:B7 = K/V with
//! k0..k5 = 5, 2, 8, 1, 9, 3; `AutoFilter 2, ">1"`; `AutoFilter.Sort` on V
//! descending: V reads 9, 8, 5, 1 (hidden), 3, 2 -- the hidden row stays on
//! row 5. Then B7 = 100, B2 = 0 and `AutoFilter.ApplyFilter`: k4:0 (hidden),
//! k1:100, k2:8, k3:1 (hidden), k0:5, k5:3.

use super::*;
use crate::api_types::{SortField, SortOrientation, SortRangeParams};
use crate::persistence::{FileState, UserFilesState};

struct Aux {
    file: FileState,
    files: UserFilesState,
    pivots: crate::pivot::PivotState,
    pane: crate::pane_control::PaneControlState,
    filters: crate::ribbon_filter::RibbonFilterState,
}

fn aux() -> Aux {
    Aux {
        file: FileState::default(),
        files: UserFilesState::default(),
        pivots: crate::pivot::PivotState::new(),
        pane: crate::pane_control::PaneControlState::new(),
        filters: crate::ribbon_filter::RibbonFilterState::new(),
    }
}

fn set(state: &AppState, row: u32, col: u32, cell: engine::Cell) {
    let effect = crate::document_effect::test_seed_effect();
    state.grid.write(&effect).unwrap().set_cell(row, col, cell.clone());
    state.grids.write(&effect).unwrap()[0].set_cell(row, col, cell);
}

fn text_at(state: &AppState, row: u32, col: u32) -> String {
    let grids = state.grids.read().unwrap();
    match grids[0].get_cell(row, col).map(|c| c.value.clone()) {
        Some(CellValue::Number(n)) => format!("{}", n),
        Some(CellValue::Text(t)) => t.to_string(),
        other => format!("{:?}", other),
    }
}

/// The probe's sheet, filtered on V > 1.
fn filtered_state() -> AppState {
    let state = crate::create_app_state();
    set(&state, 0, 0, engine::Cell::new_text("K".to_string()));
    set(&state, 0, 1, engine::Cell::new_text("V".to_string()));
    for (i, v) in [5.0, 2.0, 8.0, 1.0, 9.0, 3.0].iter().enumerate() {
        set(&state, i as u32 + 1, 0, engine::Cell::new_text(format!("k{}", i)));
        set(&state, i as u32 + 1, 1, engine::Cell::new_number(*v));
    }
    let mut af = AutoFilter::new(0, 0, 6, 1);
    af.column_filters.insert(
        1,
        ColumnFilter {
            column_index: 1,
            criteria: FilterCriteria { criterion1: Some(">1".to_string()), filter_on: FilterOn::Custom, ..Default::default() },
        },
    );
    state.auto_filters.write(&crate::document_effect::test_seed_effect()).unwrap().insert(0, af);
    let a = aux();
    let result = reapply_auto_filter_inner(&state, &a.file);
    assert!(result.success, "{:?}", result.error);
    state
}

fn v_descending() -> SortRangeParams {
    SortRangeParams {
        start_row: 0,
        start_col: 0,
        end_row: 6,
        end_col: 1,
        fields: vec![SortField {
            key: 1,
            ascending: false,
            sort_on: Default::default(),
            color: None,
            icon: None,
            data_option: Default::default(),
            sub_field: None,
            custom_order: None,
        }],
        match_case: false,
        has_headers: true,
        orientation: SortOrientation::Rows,
        sheet_index: None,
        target: None,
    }
}

fn column(state: &AppState, col: u32) -> Vec<String> {
    (1..=6).map(|r| text_at(state, r, col)).collect()
}

/// A sort over the filter's whole range moves only the rows it shows and is
/// remembered on the filter; Reapply after two edits re-filters and re-sorts,
/// exactly as Excel's rows read.
///
/// SABOTAGE (tabxlsx-reapply): `reapply_auto_filter_with_sort` skips the sort;
/// V then keeps the edited order 0, 8, 5, 1, 3, 100.
/// SABOTAGE (tabxlsx-sortrec): `sort_state_for` answers `None`; nothing is
/// remembered and Reapply cannot re-sort.
#[test]
fn reapply_re_filters_and_re_sorts_the_visible_rows_as_excel_does() {
    let state = filtered_state();
    let a = aux();
    let hidden: Vec<u32> = {
        let filters = state.auto_filters.read().unwrap();
        let mut h: Vec<u32> = filters[&0].hidden_rows.iter().copied().collect();
        h.sort_unstable();
        h
    };
    assert_eq!(hidden, vec![4], "V = 1 (row 5) is hidden");

    let sorted = crate::commands::data::sort_range_core(&state, &a.file, &a.files, &a.pivots, &a.pane, &a.filters, v_descending())
        .expect("the sort runs");
    assert!(sorted.success, "{:?}", sorted.error);
    assert_eq!(column(&state, 1), ["9", "8", "5", "1", "3", "2"], "the hidden row keeps its place");
    {
        let filters = state.auto_filters.read().unwrap();
        let remembered = filters[&0].sort_state.as_ref().expect("the filter remembers the sort");
        assert_eq!(remembered.fields.len(), 1);
        assert_eq!(remembered.fields[0].key, 1);
        assert!(!remembered.fields[0].ascending);
    }

    // The edits that break the order: B7 = 100, B2 = 0.
    set(&state, 6, 1, engine::Cell::new_number(100.0));
    set(&state, 1, 1, engine::Cell::new_number(0.0));
    let result = reapply_auto_filter_with_sort(&state, &a.file, &a.files, &a.pivots, &a.pane, &a.filters);
    assert!(result.success && result.error.is_none(), "{:?}", result.error);
    assert_eq!(column(&state, 1), ["0", "100", "8", "1", "5", "3"]);
    assert_eq!(column(&state, 0), ["k4", "k1", "k2", "k3", "k0", "k5"]);
    let mut hidden: Vec<u32> = state.auto_filters.read().unwrap()[&0].hidden_rows.iter().copied().collect();
    hidden.sort_unstable();
    assert_eq!(hidden, vec![1, 4], "0 and 1 fail V > 1");
}

/// A sort of PART of the filter's range is not the filter's sort: nothing is
/// remembered (Excel's `AutoFilter.Sort` is the filter's whole data range).
#[test]
fn a_sort_of_part_of_the_filter_is_not_remembered() {
    let state = filtered_state();
    let a = aux();
    let mut part = v_descending();
    part.end_row = 3;
    crate::commands::data::sort_range_core(&state, &a.file, &a.files, &a.pivots, &a.pane, &a.filters, part).expect("the sort runs");
    assert!(state.auto_filters.read().unwrap()[&0].sort_state.is_none());
}

fn slicers() -> (crate::slicer::SlicerState, crate::timeline_slicer::TimelineSlicerState) {
    (crate::slicer::SlicerState::new(), crate::timeline_slicer::TimelineSlicerState::new())
}

fn remembered_keys(state: &AppState, sheet: usize) -> Option<Vec<u32>> {
    state.auto_filters.read().unwrap()[&sheet].sort_state.as_ref().map(|s| s.fields.iter().map(|f| f.key).collect())
}

/// The remembered sort FOLLOWS a column edit inside the filter, as Excel's
/// does. [LIVE, Excel 16, 2026-11-06, verify-tabxlsx probe1 P2] a column
/// inserted in front of the sorted V moves the key with it (A1:C7, key C) and
/// Reapply re-sorts by C; [LIVE, lane tab4 probe1 Q1/Q2] deleting a column
/// left of a key moves it left, and deleting the KEY column drops that level
/// (one of two levels left; with none left there is no sort to reapply).
///
/// SABOTAGE (tab4-rekey): `rekey_columns` leaves the sort's levels alone; the
/// key stays at 1 after the insert.
#[test]
fn a_column_edit_inside_the_filter_moves_the_remembered_sort_as_excel_does() {
    let state = filtered_state();
    let a = aux();
    let (slicer, timeline) = slicers();
    let sorted = crate::commands::data::sort_range_core(&state, &a.file, &a.files, &a.pivots, &a.pane, &a.filters, v_descending())
        .expect("the sort runs");
    assert!(sorted.success, "{:?}", sorted.error);

    // Insert a column at B: V moves to C, and so does the sort's key.
    crate::commands::structure::insert_columns_impl(
        &state, &a.file, &a.pivots, &a.files, &a.pane, &a.filters, &slicer, &timeline, 1, 1, None,
    )
    .expect("insert a column");
    {
        let filters = state.auto_filters.read().unwrap();
        assert_eq!((filters[&0].start_col, filters[&0].end_col), (0, 2), "the filter grows over the new column");
    }
    assert_eq!(remembered_keys(&state, 0), Some(vec![2]), "the key follows V into column C");

    // The edits that break the order, then Reapply: it sorts by V (column C).
    set(&state, 6, 2, engine::Cell::new_number(100.0));
    set(&state, 1, 2, engine::Cell::new_number(0.0));
    let result = reapply_auto_filter_with_sort(&state, &a.file, &a.files, &a.pivots, &a.pane, &a.filters);
    assert!(result.success && result.error.is_none(), "{:?}", result.error);
    assert_eq!(column(&state, 2), ["0", "100", "8", "1", "5", "3"]);
    assert_eq!(column(&state, 0), ["k4", "k1", "k2", "k3", "k0", "k5"]);

    // Delete the empty column B (left of the key): the key moves back to B.
    crate::commands::structure::delete_columns_impl(
        &state, &a.file, &a.pivots, &a.files, &a.pane, &a.filters, &slicer, &timeline, 1, 1, None,
    )
    .expect("delete a column");
    assert_eq!(remembered_keys(&state, 0), Some(vec![1]), "the key moves left with V");

    // Delete V itself: its level goes, and with it the only level.
    crate::commands::structure::delete_columns_impl(
        &state, &a.file, &a.pivots, &a.files, &a.pane, &a.filters, &slicer, &timeline, 1, 1, None,
    )
    .expect("delete the key column");
    assert_eq!(remembered_keys(&state, 0), None, "a sort with no level left is forgotten");
}

/// Data > Clear on a SHEET filter forgets its sort; a TABLE's filter keeps it.
/// [LIVE, Excel 16, 2026-11-06, verify-tabxlsx probe1 P1/P3] after
/// `AutoFilter.Sort`, `ShowAllData` leaves `Sort.SortFields.Count` 0 on a sheet
/// filter and 1 on a table, whose ApplyFilter then re-sorts.
///
/// SABOTAGE (tab4-clear): the clear keeps every sort; the sheet filter's
/// survives.
#[test]
fn data_clear_forgets_a_sheet_filters_sort_but_a_tables_keeps_it() {
    let state = filtered_state();
    let a = aux();
    crate::commands::data::sort_range_core(&state, &a.file, &a.files, &a.pivots, &a.pane, &a.filters, v_descending())
        .expect("the sort runs");
    assert!(remembered_keys(&state, 0).is_some());
    let cleared = clear_auto_filter_criteria_inner(&state, &a.file);
    assert!(cleared.success, "{:?}", cleared.error);
    assert_eq!(remembered_keys(&state, 0), None, "a sheet filter's sort is forgotten by Clear");

    // The same data as a table, which owns its filter.
    state.auto_filters.write(&crate::document_effect::test_seed_effect()).unwrap().clear();
    let created = crate::tables::create_table_core(
        &state,
        &a.file,
        &a.files,
        &a.pivots,
        &a.pane,
        &a.filters,
        crate::tables::CreateTableParams {
            name: "T".to_string(),
            start_row: 0,
            start_col: 0,
            end_row: 6,
            end_col: 1,
            has_headers: true,
            style_options: None,
            style_name: None,
        },
    );
    assert!(created.success, "{:?}", created.error);
    crate::commands::data::sort_range_core(&state, &a.file, &a.files, &a.pivots, &a.pane, &a.filters, v_descending())
        .expect("the sort runs");
    assert_eq!(remembered_keys(&state, 0), Some(vec![1]), "the table's filter remembers the sort");
    let cleared = clear_auto_filter_criteria_inner(&state, &a.file);
    assert!(cleared.success, "{:?}", cleared.error);
    assert_eq!(remembered_keys(&state, 0), Some(vec![1]), "a table's filter keeps its sort through Clear");
}

/// A re-sort that Reapply cannot run is SAID: a merge that entered the range
/// since the sort makes `sort_range_core` answer `Ok` with `success: false`,
/// and that answer used to be dropped -- the rows were re-filtered, left
/// unsorted, and nothing told the user.
///
/// SABOTAGE (tab4-sorterr): the reapply ignores an unsuccessful `Ok`.
#[test]
fn a_reapply_whose_re_sort_is_refused_says_why() {
    let state = filtered_state();
    let a = aux();
    crate::commands::data::sort_range_core(&state, &a.file, &a.files, &a.pivots, &a.pane, &a.filters, v_descending())
        .expect("the sort runs");
    // B7:C7 merged: it straddles the filter's right edge.
    state
        .merged_regions
        .write(&crate::document_effect::test_seed_effect())
        .unwrap()
        .insert(crate::api_types::MergedRegion { start_row: 6, start_col: 1, end_row: 6, end_col: 2 });
    let result = reapply_auto_filter_with_sort(&state, &a.file, &a.files, &a.pivots, &a.pane, &a.filters);
    assert!(result.success, "the filter itself is reapplied: {:?}", result.error);
    assert_eq!(
        result.error.as_deref(),
        Some("Cannot sort a range that partially overlaps with merged cells"),
        "the refused re-sort is reported"
    );
}

/// A script's sort of a filtered sheet that is NOT the active one follows the
/// same rules as the active path: the rows the filter hides keep their places
/// and a sort of the filter's whole range is remembered for Reapply.
///
/// SABOTAGE (tab4-offsheet): the off-sheet path sorts every data row again.
#[test]
fn an_off_sheet_sort_moves_only_the_visible_rows_and_is_remembered() {
    let state = filtered_state();
    let a = aux();
    crate::sheets::add_sheet_inner(&state, &a.file, Some("Other".to_string()), ::persistence::SheetKind::Worksheet)
        .expect("add a sheet");
    crate::sheets::activate_sheet(&state, 1).expect("Other is active");
    assert_eq!(*state.active_sheet.read().unwrap(), 1);
    let mut params = v_descending();
    params.sheet_index = Some(0);
    let sorted = crate::commands::data::sort_range_core(&state, &a.file, &a.files, &a.pivots, &a.pane, &a.filters, params)
        .expect("the off-sheet sort runs");
    assert!(sorted.success, "{:?}", sorted.error);
    assert_eq!(column(&state, 1), ["9", "8", "5", "1", "3", "2"], "the hidden row keeps its place");
    assert_eq!(remembered_keys(&state, 0), Some(vec![1]), "the filter remembers the off-sheet sort");
}
