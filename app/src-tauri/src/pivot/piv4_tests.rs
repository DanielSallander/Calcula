//! FILENAME: app/src-tauri/src/pivot/piv4_tests.rs
//! PURPOSE: Ledger programme 2, wave 4 (lane piv4), through the real doors.
//!
//!   BUG-0760  follow-up: a pivot over a source error shows the error (the
//!             aggregation dropped it and summed the other rows), and
//!             GETPIVOTDATA finds every cell of a calculated field -- it found
//!             only the column the field's caption heads.
//!   BUG-0733  a grouped field of its own (a manual group's parent) sorts
//!             apart from the field it was grouped from, and an item can be
//!             moved by hand (a stored manual item order).

use super::operations::{build_cache_from_grid, safe_calculate_pivot, PivotRecalcStates};
use super::types::{PivotItemMove, PivotItemMoveTo, PivotState, SortBy, SortPivotFieldRequest};
use crate::document_effect::test_seed_effect;
use crate::persistence::{FileState, UserFilesState};
use crate::AppState;
use engine::{CellError, CellValue};
use pivot_engine::{
    AggregationType, CalculatedField, FieldGrouping, ManualGroup, PivotDefinition, PivotField, PivotId, PivotView,
    SortOrder, ValueField, MANUAL_GROUP_LEVEL,
};

struct Fx {
    state: AppState,
    file: FileState,
    files: UserFilesState,
    slicer: crate::slicer::SlicerState,
    pivots: PivotState,
    pane: crate::pane_control::PaneControlState,
    filters: crate::ribbon_filter::RibbonFilterState,
}

fn fx() -> Fx {
    let state = crate::create_app_state();
    *state.locale.lock().unwrap() = engine::LocaleSettings::from_locale_id("en-US");
    Fx {
        state,
        file: FileState::default(),
        files: UserFilesState::default(),
        slicer: crate::slicer::SlicerState::new(),
        pivots: PivotState::new(),
        pane: crate::pane_control::PaneControlState::new(),
        filters: crate::ribbon_filter::RibbonFilterState::new(),
    }
}

impl Fx {
    fn set(&self, row: u32, col: u32, value: &str) {
        crate::commands::data::update_cell_impl(
            &self.state,
            &self.file,
            &self.files,
            &self.slicer,
            &self.pivots,
            &self.pane,
            &self.filters,
            row,
            col,
            value.to_string(),
            None,
            None,
            None,
        )
        .unwrap_or_else(|e| panic!("update_cell({row},{col}): {e}"));
    }

    fn value(&self, row: u32, col: u32) -> CellValue {
        self.state.grid.read().unwrap().get_cell(row, col).map(|c| c.value.clone()).unwrap_or(CellValue::Empty)
    }

    fn recalc(&self) -> PivotRecalcStates<'_> {
        PivotRecalcStates { pane: &self.pane, ribbon: &self.filters, user_files: &self.files }
    }

    /// The rows the pivot shows, as the first non-empty text of each.
    fn labels(&self, id: PivotId) -> Vec<String> {
        let views = self.pivots.views.lock().unwrap();
        let view = views.get(&id).expect("the view");
        view.cells
            .iter()
            .skip(view.column_header_row_count)
            .map(|row| row.iter().map(|c| c.formatted_value.clone()).find(|s| !s.is_empty()).unwrap_or_default())
            .collect()
    }
}

/// Writes `rows` from A1 and puts a pivot over them at E3 into the store with
/// its view, built by `shape`.
fn pivot_over(fx: &Fx, rows: &[&[&str]], shape: impl FnOnce(&mut PivotDefinition)) -> PivotId {
    for (r, row) in rows.iter().enumerate() {
        for (c, v) in row.iter().enumerate() {
            fx.set(r as u32, c as u32, v);
        }
    }
    let end = ((rows.len() - 1) as u32, (rows[0].len() - 1) as u32);
    let source = fx.state.grid.read().unwrap().clone();
    let (mut cache, headers) = build_cache_from_grid(&source, (0, 0), end, true).expect("the cache");
    for (i, h) in headers.iter().enumerate() {
        cache.set_field_name(i, h.clone());
    }
    let mut def = PivotDefinition::new(identity::EntityId::from_bytes(identity::generate_uuid_v7()), (0, 0), end);
    def.source_has_headers = true;
    def.source_sheet = Some("Sheet1".to_string());
    def.destination_sheet = Some("Sheet1".to_string());
    def.destination = (2, 6);
    shape(&mut def);
    let view = safe_calculate_pivot(&def, &mut cache);
    let id = def.id;
    fx.pivots.pivot_tables.write(&test_seed_effect()).unwrap().insert(id, (def, cache));
    fx.pivots.views.lock().unwrap().insert(id, view);
    id
}

/// The (field, member) a header cell labelled `label` carries.
fn header(view: &PivotView, label: &str) -> (usize, u32) {
    view.cells
        .iter()
        .flatten()
        .find(|c| c.formatted_value == label && !c.group_path.is_empty() && c.value_field_index.is_none())
        .and_then(|c| c.group_path.last().copied())
        .unwrap_or_else(|| panic!("no header {label}"))
}

/// BUG-0760 follow-up, through the real cache build and GETPIVOTDATA: a
/// source `=1/0` makes its group and the grand total #DIV/0! (Excel [LIVE,
/// piv4 probe4]); and a calculated field is found under EVERY column item,
/// in the row grand total and with no field/item pairs. The first fix found
/// only the column its caption heads, so the Y2 cell, the row grand total
/// and the corner all read #REF! (wave-3 verify finding).
///
/// SABOTAGE (piv4-sabC): `names_field` matches a calculated field's cells
/// by nothing -- fails at "CALC Y2".
#[test]
fn getpivotdata_finds_a_calculated_field_under_every_column_and_a_source_error() {
    let fx = fx();
    let id = pivot_over(
        &fx,
        &[
            &["Region", "Year", "Amount"],
            &["East", "Y1", "10"],
            &["East", "Y2", "20"],
            &["West", "Y1", "=1/0"],
            &["West", "Y2", "5"],
        ],
        |def| {
            def.row_fields.push(PivotField::new(0, "Region".to_string()));
            def.column_fields.push(PivotField::new(1, "Year".to_string()));
            def.value_fields.push(ValueField::new(2, "Sum of Amount".to_string(), AggregationType::Sum));
            def.calculated_fields.push(CalculatedField {
                name: "Dbl".to_string(),
                formula: "Amount*2".to_string(),
                number_format: None,
            });
        },
    );
    let _ = id;
    fx.set(0, 15, "=GETPIVOTDATA(\"Sum of Dbl\",$G$3,\"Region\",\"East\",\"Year\",\"Y2\")"); // P1
    fx.set(1, 15, "=GETPIVOTDATA(\"Dbl\",$G$3,\"Region\",\"East\")"); // P2: the row grand total
    fx.set(2, 15, "=GETPIVOTDATA(\"Dbl\",$G$3,\"Region\",\"West\",\"Year\",\"Y2\")"); // P3
    fx.set(3, 15, "=GETPIVOTDATA(\"Sum of Amount\",$G$3,\"Region\",\"West\",\"Year\",\"Y1\")"); // P4
    fx.set(4, 15, "=GETPIVOTDATA(\"Sum of Amount\",$G$3)"); // P5: the grand total
    fx.set(5, 15, "=GETPIVOTDATA(\"Dbl\",$G$3,\"Region\",\"West\")"); // P6
    assert_eq!(fx.value(0, 15), CellValue::Number(40.0), "CALC Y2: East's Y2 Dbl is 2 * 20");
    assert_eq!(fx.value(1, 15), CellValue::Number(60.0), "CALC ROW TOTAL: East's Dbl total is 2 * 30");
    assert_eq!(fx.value(2, 15), CellValue::Number(10.0), "West's Y2 Dbl is 2 * 5");
    assert_eq!(fx.value(3, 15), CellValue::Error(CellError::Div0), "SOURCE ERROR: West Y1 sums a #DIV/0!");
    assert_eq!(fx.value(4, 15), CellValue::Error(CellError::Div0), "the grand total over it is #DIV/0!");
    assert_eq!(fx.value(5, 15), CellValue::Error(CellError::Div0), "a calculated field over the error is the error");
}

/// Region A..D, Group1 = A, B and Group2 = C, D on rows, at G3.
fn grouped(fx: &Fx) -> PivotId {
    pivot_over(
        fx,
        &[&["Region", "Amount"], &["A", "110"], &["B", "100"], &["C", "31"], &["D", "10"]],
        |def| {
            let mut region = PivotField::new(0, "Region".to_string());
            region.grouping = FieldGrouping::ManualGrouping {
                groups: vec![
                    ManualGroup { name: "Group1".into(), members: vec!["A".into(), "B".into()] },
                    ManualGroup { name: "Group2".into(), members: vec!["C".into(), "D".into()] },
                ],
                ungrouped_name: "Other".into(),
            };
            def.row_fields.push(region);
            def.value_fields.push(ValueField::new(1, "Sum of Amount".to_string(), AggregationType::Sum));
        },
    )
}

fn sort(fx: &Fx, id: PivotId, field_index: usize, sort_by: SortBy, by_value: bool, move_item: Option<PivotItemMove>) {
    super::commands::sort_pivot_field_core(
        &fx.state,
        &fx.file,
        &fx.pivots,
        fx.recalc(),
        SortPivotFieldRequest {
            pivot_id: id,
            field_index,
            sort_by,
            values_hierarchy: by_value.then(|| "Sum of Amount".to_string()),
            pivot_item_scope: None,
            scope_group_path: None,
            move_item,
        },
    )
    .expect("the sort");
}

/// BUG-0733 / wave-3 verify: sorting a manual group's parent by value sorts
/// the GROUPS and leaves the regions inside each group in their own order
/// (Excel [LIVE, verify-pivotfix probe3 A_ORDERS]: Region2 sorted, Region's
/// AutoSortOrder stays ascending). The sort went to the field it was grouped
/// from, so A, B inside Group1 became B, A.
///
/// SABOTAGE (piv4-sabL): the sort ignores the virtual field's level and
/// writes the origin field -- fails at "GROUP SORT".
#[test]
fn sorting_a_group_parent_by_value_leaves_its_detail_field_alone() {
    let fx = fx();
    let id = grouped(&fx);
    let group_field = {
        let views = fx.pivots.views.lock().unwrap();
        header(views.get(&id).unwrap(), "Group1").0
    };
    sort(&fx, id, group_field, SortBy::Ascending, true, None);
    assert_eq!(
        fx.labels(id),
        ["Group2", "C", "D", "Group1", "A", "B", "Grand Total"].map(String::from).to_vec(),
        "GROUP SORT: the groups by value, the regions by label"
    );
    let tables = fx.pivots.pivot_tables.read().unwrap();
    let field = &tables.get(&id).unwrap().0.row_fields[0];
    assert_eq!(field.sort_order, SortOrder::Ascending, "the detail field keeps its own sort");
    assert!(field.value_sort.is_none(), "the detail field is not sorted by value");
    assert_eq!(field.level_sort(MANUAL_GROUP_LEVEL).sort_order, SortOrder::Ascending);
    assert!(field.level_sort(MANUAL_GROUP_LEVEL).value_sort.is_some(), "the group level carries the value sort");
}

/// BUG-0733, Excel's Move: moving an item keeps the order the items are
/// shown in, with that item moved, and turns the field Manual (Excel [LIVE,
/// piv4 probe5]: `PivotItems("West").Position = 1` gives West, East, North,
/// South). Excel's Manual radio keeps the current order. Calcula stored no
/// manual order, so Move was a disabled stub.
///
/// SABOTAGE (piv4-sabN): the move is dropped -- fails at "MOVE UP".
#[test]
fn moving_an_item_stores_a_manual_order() {
    let fx = fx();
    let id = pivot_over(
        &fx,
        &[&["Region", "Amount"], &["North", "1"], &["West", "2"], &["East", "3"], &["South", "4"]],
        |def| {
            def.row_fields.push(PivotField::new(0, "Region".to_string()));
            def.value_fields.push(ValueField::new(1, "Sum of Amount".to_string(), AggregationType::Sum));
        },
    );
    assert_eq!(fx.labels(id), ["East", "North", "South", "West", "Grand Total"].map(String::from).to_vec());
    let west = {
        let views = fx.pivots.views.lock().unwrap();
        header(views.get(&id).unwrap(), "West")
    };
    sort(&fx, id, west.0, SortBy::Ascending, false, Some(PivotItemMove { value_id: west.1, to: PivotItemMoveTo::Up }));
    assert_eq!(fx.labels(id), ["East", "North", "West", "South", "Grand Total"].map(String::from).to_vec(), "MOVE UP");
    sort(&fx, id, west.0, SortBy::Ascending, false, Some(PivotItemMove { value_id: west.1, to: PivotItemMoveTo::Beginning }));
    assert_eq!(fx.labels(id), ["West", "East", "North", "South", "Grand Total"].map(String::from).to_vec(), "MOVE TO BEGINNING");
    {
        let tables = fx.pivots.pivot_tables.read().unwrap();
        let field = &tables.get(&id).unwrap().0.row_fields[0];
        assert_eq!(field.sort_order, SortOrder::Manual);
        assert_eq!(field.manual_item_order, ["West", "East", "North", "South"].map(String::from).to_vec());
    }
    // Excel's Manual radio: the current order stays.
    sort(&fx, id, west.0, SortBy::Manual, false, None);
    assert_eq!(fx.labels(id), ["West", "East", "North", "South", "Grand Total"].map(String::from).to_vec(), "MANUAL keeps it");
    // A label sort forgets the manual order.
    sort(&fx, id, west.0, SortBy::Descending, false, None);
    assert_eq!(fx.labels(id), ["West", "South", "North", "East", "Grand Total"].map(String::from).to_vec());
    let tables = fx.pivots.pivot_tables.read().unwrap();
    assert!(tables.get(&id).unwrap().0.row_fields[0].manual_item_order.is_empty());
}
