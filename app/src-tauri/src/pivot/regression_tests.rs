//! FILENAME: app/src-tauri/src/pivot/regression_tests.rs
//! PURPOSE: Pivot defects with a reproduction, one section per ledger id.
//!
//!   BUG-0146  GETPIVOTDATA's field/item form answered #REF! on entry (value
//!             cells of a pivot without column fields carried no group path),
//!             and a partial field/item spelling answered an arbitrary leaf.
//!   BUG-0147  a load resolved a pivot's destination by EXACT name with a
//!             sheet-0 fallback and stored no view (GETPIVOTDATA #REF! after
//!             open until something fetched the view); it also held
//!             `pivot_tables` while it waited for `sheet_names`.
//!   BUG-0148  undoing a pivot create (and deleting a pivot) left the merged
//!             ranges its output wrote.
//!   BUG-0184  `update_pivot_fields` rebuilt every field it was sent: a
//!             field-list edit on a RANGE pivot reset sort order, grouping,
//!             subtotals and show-all-items, and an absent hidden-items list
//!             read as CLEAR.
//!   open-items 2.af "the pivot listing has no sheet": `get_all_pivot_tables`
//!             now says which sheet each pivot is on.

use super::commands::{get_all_pivot_tables_core, pivot_data_formula_at};
use super::operations::{
    build_cache_from_grid, finalize_pivot_update, get_pivot_region, lookup_pivot_data, safe_calculate_pivot,
};
use super::types::{PivotFieldConfig, PivotState, UpdatePivotFieldsRequest};
use super::utils::apply_zone_field_configs;
use crate::document_effect::test_seed_effect;
use crate::persistence::FileState;
use crate::AppState;
use pivot_engine::{
    AggregationType, FieldGrouping, PivotCache, PivotDefinition, PivotField, PivotFilter, PivotId, ReportLayout,
    SortOrder, ValueField,
};
use std::time::Duration;

// ============================================================================
// Fixture
// ============================================================================

struct Fx {
    state: AppState,
    file: FileState,
    pivots: PivotState,
}

/// `sheets` worksheets named Sheet1..SheetN through the real add path, with
/// Sheet1 active again afterwards.
fn fx(sheets: usize) -> Fx {
    let state = crate::create_app_state();
    let file = FileState::default();
    for _ in 1..sheets {
        crate::sheets::add_sheet_inner(&state, &file, None, ::persistence::SheetKind::Worksheet)
            .expect("add a sheet");
    }
    let seed = test_seed_effect();
    {
        let mut grids = state.grids.write(&seed).unwrap();
        let mut active = state.active_sheet.write(&seed).unwrap();
        let mut mirror = state.grid.write(&seed).unwrap();
        if *active != 0 {
            grids[*active] = mirror.clone();
            *mirror = grids[0].clone();
            *active = 0;
        }
    }
    Fx { state, file, pivots: PivotState::new() }
}

/// Text / number cells into sheet `sheet` (and the mirror when it is active).
fn put(fx: &Fx, sheet: usize, rows: &[&[&str]]) -> engine::grid::Grid {
    let mut grid = engine::grid::Grid::new();
    for (r, row) in rows.iter().enumerate() {
        for (c, v) in row.iter().enumerate() {
            let cell = match v.parse::<f64>() {
                Ok(n) => engine::Cell::new_number(n),
                Err(_) => engine::Cell::new_text(v.to_string()),
            };
            grid.set_cell(r as u32, c as u32, cell);
        }
    }
    let seed = test_seed_effect();
    fx.state.grids.write(&seed).unwrap()[sheet] = grid.clone();
    if *fx.state.active_sheet.read().unwrap() == sheet {
        *fx.state.grid.write(&seed).unwrap() = grid.clone();
    }
    grid
}

fn cache_of(grid: &engine::grid::Grid, end: (u32, u32)) -> PivotCache {
    let (mut cache, headers) = build_cache_from_grid(grid, (0, 0), end, true).expect("the cache");
    for (i, h) in headers.iter().enumerate() {
        cache.set_field_name(i, h.clone());
    }
    cache
}

fn new_id() -> PivotId {
    identity::EntityId::from_bytes(identity::generate_uuid_v7())
}

/// Region (0) / Product (1) / Sales (2): North 10+5 (Apples 10, Pears 5),
/// South 20 (Apples). Total 35.
const SALES: &[&[&str]] = &[
    &["Region", "Product", "Sales"],
    &["North", "Apples", "10"],
    &["South", "Apples", "20"],
    &["North", "Pears", "5"],
];

fn sales_definition(dest_sheet: &str, destination: (u32, u32), row_fields: &[(usize, &str)]) -> PivotDefinition {
    let mut def = PivotDefinition::new(new_id(), (0, 0), (3, 2));
    def.source_has_headers = true;
    def.source_sheet = Some("Sheet1".to_string());
    def.destination_sheet = Some(dest_sheet.to_string());
    def.destination = destination;
    for (idx, name) in row_fields {
        def.row_fields.push(PivotField::new(*idx, name.to_string()));
    }
    def.value_fields.push(ValueField::new(2, "Sum of Sales".to_string(), AggregationType::Sum));
    def
}

// ============================================================================
// BUG-0146: GETPIVOTDATA's field/item form
// ============================================================================

/// A pivot put in the store with its view, as a create or a refresh leaves it.
fn stored_pivot(fx: &Fx, def: PivotDefinition) -> PivotId {
    let source = fx.state.grids.read().unwrap()[0].clone();
    let mut cache = cache_of(&source, (3, 2));
    let view = safe_calculate_pivot(&def, &mut cache);
    let id = def.id;
    fx.pivots.pivot_tables.write(&test_seed_effect()).unwrap().insert(id, (def, cache));
    fx.pivots.views.lock().unwrap().insert(id, view);
    id
}

fn getpivotdata(fx: &Fx, sheet: &str, cell: (u32, u32), pairs: &[(&str, &str)]) -> Option<f64> {
    let tables = fx.pivots.pivot_tables.read().unwrap();
    let views = fx.pivots.views.lock().unwrap();
    lookup_pivot_data(&tables, &views, "Sum of Sales", Some(sheet), cell.0, cell.1, pairs)
}

/// `=GETPIVOTDATA("Sum of Sales";E1;"Region";"North")` on a pivot with
/// Region on rows and no column field: #REF! (None) on ENTRY, while the
/// grand-total form answered.
#[test]
fn getpivotdata_answers_a_field_item_pair_on_a_pivot_without_column_fields() {
    let fx = fx(1);
    put(&fx, 0, SALES);
    stored_pivot(&fx, sales_definition("Sheet1", (0, 4), &[(0, "Region")]));

    assert_eq!(getpivotdata(&fx, "Sheet1", (0, 4), &[]), Some(35.0), "fixture: the grand-total form answers");
    assert_eq!(getpivotdata(&fx, "Sheet1", (0, 4), &[("Region", "North")]), Some(15.0), "Region=North");
    assert_eq!(getpivotdata(&fx, "Sheet1", (0, 4), &[("region", "SOUTH")]), Some(20.0), "names ignore case");
    assert_eq!(getpivotdata(&fx, "Sheet1", (0, 4), &[("Region", "East")]), None, "an item the pivot does not show");
}

/// Excel answers only a value the pivot SHOWS. On Region > Product,
/// "Region=North" is North's subtotal; "Product=Apples" alone names no cell
/// (no row shows Apples across every region) and is #REF!. Matching on
/// "the path CONTAINS the pairs" answered the first leaf it met instead.
#[test]
fn getpivotdata_answers_only_the_cell_whose_path_names_exactly_the_requested_fields() {
    let fx = fx(1);
    put(&fx, 0, SALES);
    stored_pivot(&fx, sales_definition("Sheet1", (0, 4), &[(0, "Region"), (1, "Product")]));

    assert_eq!(getpivotdata(&fx, "Sheet1", (0, 4), &[("Region", "North")]), Some(15.0), "North's subtotal");
    assert_eq!(
        getpivotdata(&fx, "Sheet1", (0, 4), &[("Region", "North"), ("Product", "Pears")]),
        Some(5.0),
        "one leaf, both fields named"
    );
    assert_eq!(
        getpivotdata(&fx, "Sheet1", (0, 4), &[("Product", "Pears"), ("Region", "North")]),
        Some(5.0),
        "the pairs' order does not matter"
    );
    assert_eq!(
        getpivotdata(&fx, "Sheet1", (0, 4), &[("Product", "Apples")]),
        None,
        "a partial spelling answered an arbitrary leaf instead of #REF!"
    );
}

// ============================================================================
// BUG-0147: the load path
// ============================================================================

fn saved(def: &PivotDefinition) -> ::persistence::SavedPivotDefinition {
    ::persistence::SavedPivotDefinition {
        id: def.id,
        source_type: "grid".to_string(),
        source_sheet_index: Some(0),
        definition: serde_json::to_value(def).expect("the definition serializes"),
    }
}

/// A grid pivot on Sheet2 whose stored destination name's case drifted from
/// its tab (a case-only rename updates no definition). The load wrote its
/// region onto sheet 0, and stored no view, so GETPIVOTDATA read #REF! until
/// something fetched the pivot's view.
#[test]
fn a_loaded_grid_pivot_is_registered_on_its_own_sheet_and_answers_getpivotdata_at_once() {
    let fx = fx(2);
    put(&fx, 0, SALES);
    let def = sales_definition("SHEET2", (2, 3), &[(0, "Region")]);
    let id = def.id;
    let mut workbook = ::persistence::Workbook::new();
    workbook.pivot_definitions.push(saved(&def));

    crate::persistence::restore_pivot_definitions(&workbook, &fx.pivots, &fx.state);

    let region = get_pivot_region(&fx.state, id).expect("the load registers the pivot's region");
    assert_eq!(region.sheet_index, 1, "a case-drifted destination name put the region on sheet 0");
    assert_eq!((region.start_row, region.start_col), (2, 3));
    assert_eq!(
        getpivotdata(&fx, "Sheet2", (2, 3), &[]),
        Some(35.0),
        "GETPIVOTDATA after a load, before anything fetched the view"
    );
    assert_eq!(getpivotdata(&fx, "Sheet2", (2, 3), &[("Region", "South")]), Some(20.0));
}

/// A destination name no sheet answers to is not "sheet 0": the load leaves
/// the pivot unregistered (and says so in the log) rather than protecting
/// cells of an unrelated sheet.
#[test]
fn a_loaded_pivot_whose_destination_sheet_is_gone_protects_no_other_sheets_cells() {
    let fx = fx(2);
    put(&fx, 0, SALES);
    let def = sales_definition("Deleted Sheet", (2, 3), &[(0, "Region")]);
    let id = def.id;
    let mut workbook = ::persistence::Workbook::new();
    workbook.pivot_definitions.push(saved(&def));

    crate::persistence::restore_pivot_definitions(&workbook, &fx.pivots, &fx.state);

    assert!(fx.pivots.pivot_tables.read().unwrap().contains_key(&id), "the definition itself is kept");
    assert_eq!(get_pivot_region(&fx.state, id).map(|r| r.sheet_index), None, "registered on sheet 0 anyway");
}

/// The lock-order watch item: the calculation pass holds `sheet_names` and
/// then takes `pivot_tables`. The load held `pivot_tables` while it waited for
/// `sheet_names` -- harmless only while both stay on the main thread.
#[test]
fn a_load_never_holds_the_pivot_lock_while_it_waits_for_sheet_names() {
    let fx = fx(2);
    put(&fx, 0, SALES);
    let mut workbook = ::persistence::Workbook::new();
    workbook.pivot_definitions.push(saved(&sales_definition("Sheet2", (2, 3), &[(0, "Region")])));

    let (parked, reached) = std::thread::scope(|scope| {
        let names = fx.state.sheet_names.write(&test_seed_effect()).unwrap();
        let load = scope.spawn(|| crate::persistence::restore_pivot_definitions(&workbook, &fx.pivots, &fx.state));
        std::thread::sleep(Duration::from_millis(300));
        let parked = !load.is_finished();
        let (tx, rx) = std::sync::mpsc::channel();
        let pivots = &fx.pivots;
        let taker = scope.spawn(move || {
            let _g = pivots.pivot_tables.read().unwrap();
            let _ = tx.send(());
        });
        let reached = rx.recv_timeout(Duration::from_secs(3)).is_ok();
        drop(names);
        load.join().unwrap();
        taker.join().unwrap();
        (parked, reached)
    });
    assert!(parked, "fixture: the load did not wait for sheet_names");
    assert!(reached, "restore_pivot_definitions held pivot_tables while it waited for sheet_names");
}

// ============================================================================
// BUG-0148: a pivot that goes away takes its merges with it
// ============================================================================

/// Region / Rep / Product / Channel / Sales: three row fields in TABULAR form
/// give three row-label columns, so the Channel report filter's dropdown spans
/// two of them -- a merged range in the pivot's output.
const WIDE: &[&[&str]] = &[
    &["Region", "Rep", "Product", "Channel", "Sales"],
    &["North", "Ann", "Apples", "Web", "10"],
    &["South", "Bo", "Pears", "Store", "20"],
    &["North", "Cy", "Apples", "Store", "5"],
];

fn merges_on(fx: &Fx, sheet: usize) -> Vec<(u32, u32, u32, u32)> {
    let mut out: Vec<(u32, u32, u32, u32)> = crate::report::with_sheet_merges_mut(
        &fx.state,
        &test_seed_effect(),
        sheet,
        |merged| merged.iter().map(|m| (m.start_row, m.start_col, m.end_row, m.end_col)).collect(),
    );
    out.sort();
    out
}

/// Undo of a pivot create (the kind a delete's redo and every create
/// records): the cells went, the merged ranges stayed, so the user's cells
/// there came back merged. A merge OUTSIDE the pivot's block is the user's
/// and stays.
#[test]
fn undoing_a_pivot_create_removes_the_merges_its_output_wrote() {
    let fx = fx(1);
    let source = put(&fx, 0, WIDE);
    let mut def = PivotDefinition::new(new_id(), (0, 0), (3, 4));
    def.source_has_headers = true;
    def.source_sheet = Some("Sheet1".to_string());
    def.destination_sheet = Some("Sheet1".to_string());
    def.destination = (10, 0);
    def.layout.report_layout = ReportLayout::Tabular;
    for (idx, name) in [(0, "Region"), (1, "Rep"), (2, "Product")] {
        def.row_fields.push(PivotField::new(idx, name.to_string()));
    }
    def.filter_fields.push(PivotFilter {
        field: PivotField::new(3, "Channel".to_string()),
        condition: pivot_engine::FilterCondition::ValueList(Vec::new()),
    });
    def.value_fields.push(ValueField::new(4, "Sum of Sales".to_string(), AggregationType::Sum));
    let id = def.id;
    let mut cache = cache_of(&source, (3, 4));
    let view = safe_calculate_pivot(&def, &mut cache);
    let undo_bytes = crate::undo_commands::pivot_delete_snapshot_bytes(id, &def, &cache_of(&source, (3, 4)));
    fx.pivots.pivot_tables.write(&test_seed_effect()).unwrap().insert(id, (def, cache));
    let user_merge = (0, 6, 1, 7);
    crate::report::with_sheet_merges_mut(&fx.state, &test_seed_effect(), 0, |merged| {
        merged.insert(crate::api_types::MergedRegion { start_row: 0, start_col: 6, end_row: 1, end_col: 7 });
    });
    finalize_pivot_update(&fx.state, &test_seed_effect(), &fx.pivots, id, 0, (10, 0), &view, None)
        .expect("the pivot is written");
    let region = get_pivot_region(&fx.state, id).expect("fixture: the region");
    let pivot_merges: Vec<_> = merges_on(&fx, 0).into_iter().filter(|m| *m != user_merge).collect();
    assert!(
        !pivot_merges.is_empty() && pivot_merges.iter().all(|m| m.0 >= region.start_row && m.2 <= region.end_row),
        "fixture: the report filter row writes a merge inside the pivot's block: {:?}",
        merges_on(&fx, 0)
    );

    let mut tx = crate::Transaction::new("Create pivot table");
    tx.add_change(crate::CellChange::CustomRestore { kind: "pivot_create".to_string(), data: undo_bytes });
    crate::undo_commands::apply_changes(
        &fx.state,
        &fx.file,
        &crate::persistence::UserFilesState::default(),
        &fx.pivots,
        &crate::slicer::SlicerState::new(),
        &crate::ribbon_filter::RibbonFilterState::new(),
        &crate::pane_control::PaneControlState::new(),
        &crate::timeline_slicer::TimelineSlicerState::new(),
        tx,
        true,
    );

    assert!(!fx.pivots.pivot_tables.read().unwrap().contains_key(&id), "fixture: the undo removed the pivot");
    assert!(
        fx.state.grid.read().unwrap().get_cell(region.start_row, region.start_col).is_none(),
        "fixture: the undo cleared the pivot's cells"
    );
    assert_eq!(
        merges_on(&fx, 0),
        vec![user_merge],
        "undoing the create left the pivot's merged ranges (and must keep the user's own)"
    );
}

/// `delete_pivot_table` gives a pivot the same end: its merges go with its
/// cells, through the SAME helper. A Tauri command no harness here can call
/// (it takes `State`s), so this is a source-level census, like the crate's
/// other wiring censuses: the call must be CODE (not a comment) inside the
/// branch that clears the pivot's block.
#[test]
fn deleting_a_pivot_clears_its_merges_through_the_shared_helper() {
    let code: String = include_str!("commands.rs")
        .replace("\r\n", "\n")
        .lines()
        .map(|l| match l.find("//") {
            Some(i) => &l[..i],
            None => l,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let start = code.find("pub fn delete_pivot_table(").expect("test out of date: delete_pivot_table not found");
    let body = &code[start..];
    let body = &body[..body.find("\n}\n").expect("test out of date: the fn's end")];
    let branch = body
        .find("if let Some(ref region) = old_region {")
        .expect("test out of date: the region-clearing branch");
    let call = body.find("clear_pivot_merges(&state, &effect, dest_sheet_idx, region);");
    assert!(
        call.is_some_and(|at| at > branch),
        "delete_pivot_table no longer clears the pivot's merges with its cells (BUG-0148)"
    );
}

// ============================================================================
// BUG-0184: a field-list edit keeps per-field settings it does not send
// ============================================================================

fn cfg(source_index: usize, name: &str) -> PivotFieldConfig {
    PivotFieldConfig {
        source_index,
        name: name.to_string(),
        sort_order: None,
        show_subtotals: None,
        collapsed: None,
        hidden_items: None,
        collapsed_items: None,
        show_all_items: None,
        subtotals: None,
        grouping: None,
    }
}

fn request(
    rows: Option<Vec<PivotFieldConfig>>,
    columns: Option<Vec<PivotFieldConfig>>,
    filters: Option<Vec<PivotFieldConfig>>,
) -> UpdatePivotFieldsRequest {
    UpdatePivotFieldsRequest {
        pivot_id: new_id(),
        row_fields: rows,
        column_fields: columns,
        value_fields: None,
        filter_fields: filters,
        layout: None,
        calculated_fields: None,
        value_column_order: None,
    }
}

/// Region on rows with every per-field setting away from its default, and a
/// Channel report filter hiding "Web".
fn tuned_definition() -> PivotDefinition {
    let mut def = PivotDefinition::new(new_id(), (0, 0), (3, 4));
    let mut region = PivotField::new(0, "Region".to_string());
    region.sort_order = SortOrder::Descending;
    region.show_subtotals = false;
    region.show_all_items = true;
    region.hidden_items = vec!["South".to_string()];
    region.collapsed = true;
    region.grouping = FieldGrouping::ManualGrouping {
        groups: vec![pivot_engine::ManualGroup { name: "N".to_string(), members: vec!["North".to_string()] }],
        ungrouped_name: "Other".to_string(),
    };
    def.row_fields.push(region);
    let mut channel = PivotField::new(3, "Channel".to_string());
    channel.hidden_items = vec!["Web".to_string()];
    def.filter_fields.push(PivotFilter {
        field: channel,
        condition: pivot_engine::FilterCondition::ValueList(Vec::new()),
    });
    def
}

fn assert_region_kept(field: &PivotField, context: &str) {
    assert_eq!(field.sort_order, SortOrder::Descending, "{context}: the sort order was reset");
    assert!(!field.show_subtotals, "{context}: the subtotals came back");
    assert!(field.show_all_items, "{context}: show-all-items was reset");
    assert_eq!(field.hidden_items, vec!["South".to_string()], "{context}: the item filter was cleared");
    assert!(field.collapsed, "{context}: the collapse state was reset");
    assert!(
        matches!(field.grouping, FieldGrouping::ManualGrouping { .. }),
        "{context}: the grouping was dropped: {:?}",
        field.grouping
    );
}

/// The traced defect: drag Rep into Columns. The editor sends the zones with
/// no per-field settings; Region's sort, subtotals, show-all-items, grouping
/// and filter were all reset, and the report filter's too.
#[test]
fn a_field_list_edit_keeps_every_setting_it_does_not_send() {
    let mut def = tuned_definition();
    apply_zone_field_configs(
        &mut def,
        &request(Some(vec![cfg(0, "Region")]), Some(vec![cfg(1, "Rep")]), Some(vec![cfg(3, "Channel")])),
    );
    assert_region_kept(&def.row_fields[0], "Region, left where it was");
    assert_eq!(def.column_fields.len(), 1);
    assert_eq!(def.column_fields[0].name, "Rep");
    assert_eq!(def.column_fields[0].sort_order, SortOrder::Ascending, "a NEW field starts at the defaults");
    assert_eq!(def.filter_fields[0].field.hidden_items, vec!["Web".to_string()], "the report filter was cleared");
}

/// A field moved to another zone is the same field (Excel keeps its settings),
/// and a renamed one (the Field Settings dialog's custom name) too.
#[test]
fn a_moved_or_renamed_field_keeps_its_settings() {
    let mut def = tuned_definition();
    apply_zone_field_configs(&mut def, &request(Some(vec![]), Some(vec![cfg(0, "Region")]), None));
    assert!(def.row_fields.is_empty());
    assert_region_kept(&def.column_fields[0], "Region, moved to Columns");

    let mut def = tuned_definition();
    apply_zone_field_configs(&mut def, &request(Some(vec![cfg(0, "Sales Region")]), None, None));
    assert_eq!(def.row_fields[0].name, "Sales Region", "the new name is applied");
    assert_region_kept(&def.row_fields[0], "Region, renamed");
}

/// What IS sent is applied: a sort, a subtotal switch, and the three states of
/// the item filter -- absent keeps, a list sets, `[]` clears.
#[test]
fn a_sent_setting_is_applied_and_an_empty_item_list_clears_the_filter() {
    let mut def = tuned_definition();
    let mut region = cfg(0, "Region");
    region.sort_order = Some("asc".to_string());
    region.show_subtotals = Some(true);
    region.hidden_items = Some(vec![]);
    let mut channel = cfg(3, "Channel");
    channel.hidden_items = Some(vec!["Store".to_string()]);
    apply_zone_field_configs(&mut def, &request(Some(vec![region]), None, Some(vec![channel])));
    let region = &def.row_fields[0];
    assert_eq!(region.sort_order, SortOrder::Ascending);
    assert!(region.show_subtotals);
    assert!(region.hidden_items.is_empty(), "[] must clear the item filter");
    assert!(region.show_all_items, "an unsent setting is kept beside the sent ones");
    assert_eq!(def.filter_fields[0].field.hidden_items, vec!["Store".to_string()]);
}

/// Collapse state is owned by the expand/collapse commands: a field-list edit
/// keeps a placed field's, whatever the request says (script configs send
/// `collapsed: false` by default), exactly as before.
#[test]
fn a_field_list_edit_never_expands_a_collapsed_field() {
    let mut def = tuned_definition();
    let mut region = cfg(0, "Region");
    region.collapsed = Some(false);
    apply_zone_field_configs(&mut def, &request(Some(vec![region]), None, None));
    assert!(def.row_fields[0].collapsed, "a field-list edit expanded a collapsed field");
}

// ============================================================================
// open-items 2.af: the pivot listing says which sheet each pivot is on
// ============================================================================

#[test]
fn the_pivot_listing_names_each_pivots_sheet() {
    let fx = fx(3);
    put(&fx, 0, SALES);
    let on_sheet3 = stored_pivot(&fx, sales_definition("sheet3", (0, 0), &[(0, "Region")]));
    let on_sheet1 = stored_pivot(&fx, sales_definition("Sheet1", (0, 5), &[(0, "Region")]));

    let listing = get_all_pivot_tables_core(&fx.state, &fx.pivots);

    let sheet_of = |id: PivotId| listing.iter().find(|p| p.info.id == id).map(|p| p.sheet_index);
    assert_eq!(sheet_of(on_sheet3), Some(Some(2)), "a case-drifted name still names Sheet3");
    assert_eq!(sheet_of(on_sheet1), Some(Some(0)));
}

// ============================================================================
// Review (wave A): the point-mode GETPIVOTDATA pick
// ============================================================================

/// A pivot put in the store AND written to its sheet with its region, as a
/// create leaves it.
fn placed_pivot(fx: &Fx, def: PivotDefinition, dest_sheet: usize) -> PivotId {
    let id = stored_pivot(fx, def);
    let (destination, view) = {
        let tables = fx.pivots.pivot_tables.read().unwrap();
        let views = fx.pivots.views.lock().unwrap();
        (tables[&id].0.destination, views[&id].clone())
    };
    finalize_pivot_update(&fx.state, &test_seed_effect(), &fx.pivots, id, dest_sheet, destination, &view, None)
        .expect("the pivot is written");
    id
}

/// Every "New Worksheet" pivot is created at A1 of its own sheet, and every
/// canvas's first pivot sits at A1 of its hidden grid: two pivots at ONE
/// address on two sheets is the ordinary case. The pick found the clicked
/// sheet's region, discarded its owner, and described whichever pivot the
/// view map yielded first whose block covered the address -- on ANY sheet.
#[test]
fn the_getpivotdata_pick_describes_the_pivot_on_the_clicked_sheet() {
    let fx = fx(3);
    put(&fx, 0, SALES);
    placed_pivot(&fx, sales_definition("Sheet2", (0, 0), &[(0, "Region")]), 1);
    placed_pivot(&fx, sales_definition("Sheet3", (0, 0), &[(1, "Product")]), 2);

    // B2 on each sheet: the first item's value cell.
    let pick = |sheet: usize| pivot_data_formula_at(&fx.state, &fx.pivots, sheet, 1, 1).map(|p| p.field_item_pairs);
    assert_eq!(
        pick(1),
        Some(vec![("Region".to_string(), "North".to_string())]),
        "Sheet2's pivot has Region on rows"
    );
    assert_eq!(
        pick(2),
        Some(vec![("Product".to_string(), "Apples".to_string())]),
        "Sheet3's pivot has Product on rows"
    );
    assert!(pivot_data_formula_at(&fx.state, &fx.pivots, 0, 1, 1).is_none(), "Sheet1 has no pivot at B2");
}

/// Values on ROWS and no row field: every value cell stands for the whole
/// dataset, so the pick writes the grand-total form with that cell's data
/// field -- never `"Sales";"150"` (the value-field index read as an item).
#[test]
fn the_pick_on_values_on_rows_without_a_row_field_writes_the_grand_total_form() {
    let fx = fx(1);
    put(&fx, 0, SALES);
    let mut def = sales_definition("Sheet1", (0, 5), &[]);
    def.value_fields.push(ValueField::new(2, "Count of Sales".to_string(), AggregationType::Count));
    def.layout.values_position = pivot_engine::ValuesPosition::Rows;
    def.layout.show_row_grand_totals = false;
    let id = placed_pivot(&fx, def, 0);
    let region = get_pivot_region(&fx.state, id).expect("fixture: the region");

    let mut picks = Vec::new();
    for row in region.start_row..=region.end_row {
        for col in region.start_col..=region.end_col {
            if let Some(p) = pivot_data_formula_at(&fx.state, &fx.pivots, 0, row, col) {
                picks.push((p.data_field, p.field_item_pairs));
            }
        }
    }
    let fields: Vec<&str> = picks.iter().map(|(f, _)| f.as_str()).collect();
    assert!(
        fields.contains(&"Sum of Sales") && fields.contains(&"Count of Sales"),
        "fixture: one value cell per value field: {picks:?}"
    );
    assert!(
        picks.iter().all(|(_, pairs)| pairs.is_empty()),
        "a whole-dataset value cell was picked with an item: {picks:?}"
    );
}

// ============================================================================
// Review (wave A): Excel's absolute form reaches every pivot door
// ============================================================================

/// `Sheet2!$A$1:$D$9` is what Excel writes for a picked range. The create
/// door's parser counted no column letters in "$A$1" and refused it ("no
/// column letters"), so only the canvas dialog -- which strips `$` itself --
/// accepted the form; the worksheet dialog, the destination cell and every
/// script door did not.
#[test]
fn a_range_or_cell_in_absolute_form_is_parsed() {
    use super::utils::{parse_cell_ref, parse_range};
    assert_eq!(parse_range("Sheet2!$A$1:$C$4"), Ok(((0, 0), (3, 2))));
    assert_eq!(parse_range("$A1:C$4"), Ok(((0, 0), (3, 2))), "mixed forms");
    assert_eq!(parse_range("'My Sheet'!$B:$C").map(|(s, e)| (s.1, e.1)), Ok((1, 2)), "whole columns");
    assert_eq!(parse_cell_ref("Sheet2!$B$3"), Ok((2, 1)));
    assert!(parse_cell_ref("$$B3").is_err(), "one `$` per part, at most");
    assert!(parse_cell_ref("B3$").is_err(), "a `$` after the row is not a reference");
    assert!(parse_range("$:$C").is_err(), "a `$` alone names no column");
}

/// Through the real create door: an absolute source range and an absolute
/// destination cell build the pivot they name.
#[test]
fn the_create_door_accepts_an_absolute_source_and_destination() {
    let fx = fx(2);
    put(&fx, 0, SALES);
    let recalc = super::operations::PivotRecalcStates {
        pane: &crate::pane_control::PaneControlState::new(),
        ribbon: &crate::ribbon_filter::RibbonFilterState::new(),
        user_files: &crate::persistence::UserFilesState::default(),
    };
    let request = super::types::CreatePivotRequest {
        source_range: "Sheet1!$A$1:$C$4".to_string(),
        destination_cell: "Sheet2!$B$2".to_string(),
        source_sheet: Some(0),
        destination_sheet: Some(1),
        has_headers: Some(true),
        name: None,
        source_table_name: None,
        canvas_frame: None,
    };
    let response = super::commands::create_pivot_core(
        &fx.state,
        &fx.file,
        &fx.pivots,
        recalc,
        request,
        vec!["Region".to_string()],
        vec![("Sales".to_string(), AggregationType::Sum)],
    )
    .expect("an absolute source and destination are accepted");
    let region = get_pivot_region(&fx.state, response.pivot_id).expect("the region");
    assert_eq!((region.sheet_index, region.start_row, region.start_col), (1, 1, 1), "at Sheet2!B2");
    let def = fx.pivots.pivot_tables.read().unwrap()[&response.pivot_id].0.clone();
    assert_eq!((def.source_start, def.source_end), ((0, 0), (3, 2)), "the whole SALES block");
}

// ============================================================================
// WD-X1: the (blank) member is a member -- GETPIVOTDATA names it
// ============================================================================

/// `rows` into sheet 0 (the active one), leaving every "" cell EMPTY -- a
/// blank member, not an empty string.
fn put_leaving_blanks(fx: &Fx, rows: &[&[&str]]) {
    let mut grid = engine::grid::Grid::new();
    for (r, row) in rows.iter().enumerate() {
        for (c, v) in row.iter().enumerate() {
            if v.is_empty() {
                continue;
            }
            let cell = match v.parse::<f64>() {
                Ok(n) => engine::Cell::new_number(n),
                Err(_) => engine::Cell::new_text(v.to_string()),
            };
            grid.set_cell(r as u32, c as u32, cell);
        }
    }
    let seed = test_seed_effect();
    fx.state.grids.write(&seed).unwrap()[0] = grid.clone();
    *fx.state.grid.write(&seed).unwrap() = grid;
}

/// North 10, a BLANK region 30, South 20. Total 60.
const SALES_WITH_A_BLANK_REGION: &[&[&str]] = &[
    &["Region", "Product", "Sales"],
    &["North", "Apples", "10"],
    &["", "Apples", "30"],
    &["South", "Pears", "20"],
];

/// The (blank) member's cell used to read the GRAND TOTAL (its group key was
/// the grand total's) and name nothing in its group path, so
/// `GETPIVOTDATA(...;"Region";"(blank)")` answered #REF! and the point-mode
/// pick at the (blank) row wrote the grand-total form. Now the cell names its
/// member, spelled as the pivot shows it.
#[test]
fn getpivotdata_reads_and_names_the_blank_member() {
    let fx = fx(1);
    put_leaving_blanks(&fx, SALES_WITH_A_BLANK_REGION);
    let id = stored_pivot(&fx, sales_definition("Sheet1", (0, 4), &[(0, "Region")]));

    assert_eq!(getpivotdata(&fx, "Sheet1", (0, 4), &[]), Some(60.0), "the grand total counts the blank rows once");
    assert_eq!(getpivotdata(&fx, "Sheet1", (0, 4), &[("Region", "(blank)")]), Some(30.0), "Region=(blank)");
    assert_eq!(getpivotdata(&fx, "Sheet1", (0, 4), &[("Region", "(Blank)")]), Some(30.0), "the label ignores case");
    assert_eq!(getpivotdata(&fx, "Sheet1", (0, 4), &[("Region", "North")]), Some(10.0), "an interned item");
    assert_eq!(getpivotdata(&fx, "Sheet1", (0, 4), &[("Region", "")]), None, "no item is spelled as an empty string");

    let tables = fx.pivots.pivot_tables.read().unwrap();
    let views = fx.pivots.views.lock().unwrap();
    let view = views.get(&id).expect("the view");
    let blank_row = view
        .cells
        .iter()
        .position(|row| row[0].formatted_value == "(blank)")
        .expect("fixture: a (blank) row");
    // The value column is the one after the row labels (destination col 4).
    let pick = super::operations::resolve_pivot_data_formula(&tables, &views, id, blank_row as u32, 5)
        .map(|p| p.field_item_pairs);
    assert_eq!(
        pick,
        Some(vec![("Region".to_string(), "(blank)".to_string())]),
        "the pick at the (blank) row names the blank member"
    );
}

// ============================================================================
// WD-X4 (NOT REAL, pinned): a source range's sheet prefix never reaches the
// formula parser
// ============================================================================

/// The canvas dialog's `qualifySourceRange` leaves names the formula parser
/// would quote (2024, 2024Budget, TRUE, FALSE) bare. The create and
/// change-source doors read the range with `parse_range`, which drops
/// everything up to the LAST "!", so bare, quoted and unprefixed all read
/// alike. The create door takes the sheet from the request's explicit index;
/// Change Data Source takes it from the prefix (`change_source_sheet_index`),
/// which reads those names bare or quoted alike too.
#[test]
fn a_source_range_with_a_parser_quoted_sheet_name_parses_bare_or_quoted() {
    let names: Vec<String> =
        ["Sheet1", "2024", "2024Budget", "TRUE", "FALSE", "Q1-2026"].iter().map(|s| s.to_string()).collect();
    for (index, name) in names.iter().enumerate().skip(1) {
        for text in [format!("{name}!A1:D10"), format!("'{name}'!A1:D10"), format!("'{name}'!$A$1:$D$10")] {
            assert_eq!(super::utils::parse_range(&text), Ok(((0, 0), (9, 3))), "{text}");
            assert_eq!(
                super::commands::change_source_sheet_index(&names, &text, None, Some("Sheet1"), 0),
                Ok(index),
                "{text}"
            );
        }
    }
}

// ============================================================================
// Change Data Source reads the sheet the range NAMES (wave D fix-up; the
// Change Data Source twin of BUG-0149)
// ============================================================================

/// Region (0) / Product (1) / Sales (2) on the OTHER sheet: totals in the
/// hundreds, so a pivot read from the wrong sheet cannot pass.
const SALES_ELSEWHERE: &[&[&str]] = &[
    &["Region", "Product", "Sales"],
    &["North", "Apples", "100"],
    &["South", "Apples", "200"],
    &["North", "Pears", "500"],
];

/// Make `sheet` the active sheet (the mirror follows), as a tab switch does.
fn activate(fx: &Fx, sheet: usize) {
    let seed = test_seed_effect();
    let mut grids = fx.state.grids.write(&seed).unwrap();
    let mut active = fx.state.active_sheet.write(&seed).unwrap();
    let mut mirror = fx.state.grid.write(&seed).unwrap();
    grids[*active] = mirror.clone();
    *mirror = grids[sheet].clone();
    *active = sheet;
}

/// A pivot on Sheet2 (at E1) over Sheet1!A1:C4 (SALES, total 35), with
/// SALES_ELSEWHERE in Sheet2!A1:C4 and SHEET2 ACTIVE -- the pivot's own
/// sheet, where Change Data Source is opened from.
fn pivot_on_sheet2_over_sheet1() -> (Fx, PivotId) {
    let fx = fx(2);
    put(&fx, 0, SALES);
    put(&fx, 1, SALES_ELSEWHERE);
    let id = stored_pivot(&fx, sales_definition("Sheet2", (0, 4), &[(0, "Region")]));
    activate(&fx, 1);
    (fx, id)
}

fn change_source(fx: &Fx, id: PivotId, range: &str) -> Result<super::types::PivotViewResponse, String> {
    let pane = crate::pane_control::PaneControlState::new();
    let ribbon = crate::ribbon_filter::RibbonFilterState::new();
    let user_files = crate::persistence::UserFilesState::default();
    super::commands::change_pivot_data_source_core(
        &fx.state,
        &fx.file,
        &fx.pivots,
        super::operations::PivotRecalcStates { pane: &pane, ribbon: &ribbon, user_files: &user_files },
        &|_: &str, _: u32, _: u32| {},
        super::types::ChangePivotDataSourceRequest {
            pivot_id: id,
            source_range: range.to_string(),
            source_sheet: None,
        },
    )
}

fn source_sheet_of(fx: &Fx, id: PivotId) -> Option<String> {
    fx.pivots.pivot_tables.read().unwrap()[&id].0.source_sheet.clone()
}

/// `Sheet1!A1:C3` typed with the pivot's own Sheet2 active summarised
/// Sheet2!A1:C3 (300), and the definition kept naming Sheet1.
#[test]
fn change_data_source_reads_the_sheet_the_range_names() {
    let (fx, id) = pivot_on_sheet2_over_sheet1();
    assert_eq!(getpivotdata(&fx, "Sheet2", (0, 4), &[]), Some(35.0), "fixture: the pivot reads Sheet1");

    change_source(&fx, id, "Sheet1!A1:C3").expect("the change applies");
    assert_eq!(getpivotdata(&fx, "Sheet2", (0, 4), &[]), Some(30.0), "Sheet1's North 10 + South 20");
    assert_eq!(source_sheet_of(&fx, id).as_deref(), Some("Sheet1"));

    // Naming the OTHER sheet repoints the pivot there -- and the definition
    // says so, which is where a refresh reads from.
    change_source(&fx, id, "'sheet2'!$A$1:$C$4").expect("the change applies");
    assert_eq!(getpivotdata(&fx, "Sheet2", (0, 4), &[]), Some(800.0), "Sheet2's rows");
    assert_eq!(source_sheet_of(&fx, id).as_deref(), Some("Sheet2"), "the named sheet, as the tab spells it");
}

/// A range with NO sheet reads the pivot's OWN source sheet, never the
/// active one.
#[test]
fn change_data_source_without_a_sheet_keeps_the_pivots_own_source_sheet() {
    let (fx, id) = pivot_on_sheet2_over_sheet1();
    change_source(&fx, id, "A1:C3").expect("the change applies");
    assert_eq!(getpivotdata(&fx, "Sheet2", (0, 4), &[]), Some(30.0), "Sheet1's rows, not the active Sheet2's");
    assert_eq!(source_sheet_of(&fx, id).as_deref(), Some("Sheet1"));
}

/// Every refusal comes before the effect: an unknown sheet, a mistyped
/// range and a data-model pivot leave the pivot as it was and the document
/// CLEAN (the token used to be minted first).
#[test]
fn a_refused_change_data_source_leaves_the_pivot_and_the_document_untouched() {
    let (fx, id) = pivot_on_sheet2_over_sheet1();
    crate::document_effect::mark_saved(&fx.file);
    assert!(!fx.file.is_dirty(), "fixture: a clean document");
    let before = fx.pivots.pivot_tables.read().unwrap()[&id].0.clone();

    let err = change_source(&fx, id, "Nope!A1:C3").expect_err("no such sheet");
    assert!(err.contains("Nope"), "the refusal names the sheet: {err}");
    assert!(!fx.file.is_dirty(), "an unknown sheet dirtied the document");
    change_source(&fx, id, "Sheet1!A1").expect_err("not a range");
    assert!(!fx.file.is_dirty(), "a mistyped range dirtied the document");

    let meta = super::types::BiPivotMetadata {
        connection_id: new_id(),
        data_source_id: None,
        model_tables: vec![],
        measures: vec![],
        hierarchies: vec![],
        calculation_groups: vec![],
        data_as_of: None,
        last_query: None,
        lookup_columns: std::collections::HashSet::new(),
        drill_through: None,
        perspectives: vec![],
        selected_perspective: None,
        cultures: vec![],
    };
    fx.pivots.bi_metadata.write(&test_seed_effect()).unwrap().insert(id, meta);
    let err = change_source(&fx, id, "Sheet1!A1:C3").expect_err("a data-model pivot");
    assert!(err.contains("data model"), "{err}");

    assert!(!fx.file.is_dirty(), "a refused change dirtied the document");
    let after = fx.pivots.pivot_tables.read().unwrap()[&id].0.clone();
    assert_eq!(
        (after.source_start, after.source_end, after.source_sheet.clone(), after.source_range_display.clone()),
        (before.source_start, before.source_end, before.source_sheet.clone(), before.source_range_display.clone()),
    );
}

// ============================================================================
// A declined overwrite takes back its gesture's OWN steps, and nothing named
// by history id (wave E, Y1 -- the Rust half of X7)
// ============================================================================

/// `undo_pivot_overwrite` took a step-naming parameter: one more step to take
/// back AFTER the overwrite steps, by its history id -- a tool that takes back
/// a stranger's step the moment the proof that it is "ours" is wrong. Its last
/// user, the timeline selection, has joined its pivots' step since W1, and the
/// frontend stopped sending it (X7); the parameter, its branch and its test
/// lived on. The door and its core take the gesture's tokens only, and no
/// comment may still describe the removed step-naming or "left open" modes as
/// if they were live. (The names are spelled in pieces so this test does not
/// match itself.)
#[test]
fn a_declined_overwrite_takes_its_tokens_only_and_nothing_describes_the_removed_modes() {
    let dead_param = concat!("then_", "undo_seq");
    let commands = include_str!("commands.rs");
    for sig in ["pub fn undo_pivot_overwrite(", "pub(crate) fn undo_pivot_overwrite_core("] {
        let start = commands.find(sig).unwrap_or_else(|| panic!("{sig} not found in pivot/commands.rs"));
        let end = start + commands[start..].find(") ->").expect("the signature ends");
        assert!(!commands[start..end].contains(dead_param), "{sig}...) still takes the step-naming parameter");
    }
    let dead = [
        dead_param,
        concat!("then", "UndoSeq"),
        concat!("own", "LeftOpen"),
        concat!("joinOr", "LeftOpen"),
        concat!("leaves its step ", "OPEN"),
    ];
    let sites: [(&str, &str); 7] = [
        ("pivot/commands.rs", commands),
        ("slicer/types.rs", include_str!("../slicer/types.rs")),
        ("slicer/commands.rs", include_str!("../slicer/commands.rs")),
        ("slicer/model_slicer_tests.rs", include_str!("../slicer/model_slicer_tests.rs")),
        ("timeline_slicer/commands.rs", include_str!("../timeline_slicer/commands.rs")),
        ("Slicer/lib/slicerFilterBridge.ts", include_str!("../../../extensions/Slicer/lib/slicerFilterBridge.ts")),
        (
            "TimelineSlicer/lib/timelineSlicerStore.ts",
            include_str!("../../../extensions/TimelineSlicer/lib/timelineSlicerStore.ts"),
        ),
    ];
    for (file, text) in sites {
        for d in dead {
            assert!(!text.contains(d), "{file} still names the removed mode `{d}`");
        }
    }
}

// ============================================================================
// Change Data Source takes a TABLE name, and a typed range UNLINKS the table
// (wave E fix-up of Y5/Y6)
// ============================================================================

/// A table in the stores the create door writes (`tables` by sheet, and
/// `table_names` by upper-cased name) -- what `linked_table_source` reads.
fn add_table(fx: &Fx, name: &str, sheet: usize, start: (u32, u32), end: (u32, u32)) {
    let seed = test_seed_effect();
    let table_id = new_id();
    fx.state.tables.write(&seed).unwrap().entry(sheet).or_default().insert(
        table_id,
        crate::tables::Table {
            id: table_id,
            name: name.to_string(),
            sheet_index: sheet,
            start_row: start.0,
            start_col: start.1,
            end_row: end.0,
            end_col: end.1,
            columns: vec![],
            style_options: crate::tables::TableStyleOptions::default(),
            style_name: "TableStyleMedium2".to_string(),
            auto_filter_id: None,
        },
    );
    fx.state.table_names.write(&seed).unwrap().insert(name.to_uppercase(), (sheet, table_id));
}

/// The table grows or shrinks to end at `end_row` (a resize the pivot has
/// not yet been refreshed over).
fn resize_table_rows(fx: &Fx, name: &str, end_row: u32) {
    let (sheet, table_id) = fx.state.table_names.read().unwrap()[&name.to_uppercase()];
    let mut tables = fx.state.tables.write(&test_seed_effect()).unwrap();
    tables.get_mut(&sheet).unwrap().get_mut(&table_id).unwrap().end_row = end_row;
}

/// A pivot on Sheet2 (at E1) over the TABLE Table1 = Sheet1!A1:C4 (SALES,
/// total 35), recorded the way `create_pivot_table` records a table source:
/// `source_table_name` and `source_range_display` both the table's name.
/// SALES_ELSEWHERE is in Sheet2!A1:C4 and Sheet2 is active.
fn pivot_on_sheet2_over_table1() -> (Fx, PivotId) {
    let fx = fx(2);
    put(&fx, 0, SALES);
    put(&fx, 1, SALES_ELSEWHERE);
    add_table(&fx, "Table1", 0, (0, 0), (3, 2));
    let mut def = sales_definition("Sheet2", (0, 4), &[(0, "Region")]);
    def.source_table_name = Some("Table1".to_string());
    def.source_range_display = Some("Table1".to_string());
    let id = stored_pivot(&fx, def);
    activate(&fx, 1);
    (fx, id)
}

/// The source as the definition records it: (start, end, sheet, display, table link).
type RecordedSource = ((u32, u32), (u32, u32), Option<String>, Option<String>, Option<String>);

fn recorded_source(fx: &Fx, id: PivotId) -> RecordedSource {
    let def = fx.pivots.pivot_tables.read().unwrap()[&id].0.clone();
    (def.source_start, def.source_end, def.source_sheet, def.source_range_display, def.source_table_name)
}

/// What the NEXT refresh of the pivot reads -- through `refresh_pivot_cache`'s
/// own rule, not a copy of it.
fn next_refresh_reads(fx: &Fx, id: PivotId) -> ((u32, u32), (u32, u32), usize) {
    let def = fx.pivots.pivot_tables.read().unwrap()[&id].0.clone();
    let names = fx.state.sheet_names.read().unwrap().clone();
    super::commands::grid_refresh_source(&fx.state, &names, &def)
}

/// The dialog pre-fills a table pivot's source as its table's NAME (the
/// create door records `source_range_display` = "Table1"), so pressing OK
/// without typing sends "Table1" -- which the door parsed as a cell range and
/// refused: "Invalid range format: 'Table1'". A table name is a source, as
/// Excel's box treats it: the door reads the table's CURRENT cells on its own
/// sheet and keeps the pivot linked to it, under the table's own spelling.
#[test]
fn ok_on_a_table_pivots_unchanged_source_reads_the_table_and_keeps_it_linked() {
    let (fx, id) = pivot_on_sheet2_over_table1();
    assert_eq!(getpivotdata(&fx, "Sheet2", (0, 4), &[]), Some(35.0), "fixture: the pivot reads Table1");
    // The table shrank to A1:C3 since the pivot last read it.
    resize_table_rows(&fx, "Table1", 2);

    let applied = change_source(&fx, id, "Table1");
    assert!(applied.is_ok(), "OK on the unchanged pre-filled 'Table1' was refused: {:?}", applied.err());
    assert_eq!(getpivotdata(&fx, "Sheet2", (0, 4), &[]), Some(30.0), "Table1's current rows: North 10 + South 20");
    assert_eq!(
        recorded_source(&fx, id),
        (
            (0, 0),
            (2, 2),
            Some("Sheet1".to_string()),
            Some("Table1".to_string()),
            Some("Table1".to_string())
        ),
        "the table's cells on the table's sheet, still linked and still shown by name"
    );
    // Still linked: the table grows back, and the next refresh follows it.
    resize_table_rows(&fx, "Table1", 3);
    assert_eq!(next_refresh_reads(&fx, id), ((0, 0), (3, 2), 0), "the next refresh follows the table");
}

/// A RANGE pivot changed to a table's name reads that table -- on the
/// table's sheet, whatever sheet the pivot read before -- and is linked to
/// it from then on, under the table's own spelling however it was typed.
#[test]
fn a_range_pivot_changed_to_a_table_name_reads_the_table_and_links_it() {
    let (fx, id) = pivot_on_sheet2_over_sheet1();
    add_table(&fx, "Sales2", 1, (0, 0), (3, 2));

    let applied = change_source(&fx, id, "  sales2 ");
    assert!(applied.is_ok(), "a table's name was refused as a source: {:?}", applied.err());
    assert_eq!(getpivotdata(&fx, "Sheet2", (0, 4), &[]), Some(800.0), "Sales2 = Sheet2!A1:C4");
    assert_eq!(
        recorded_source(&fx, id),
        (
            (0, 0),
            (3, 2),
            Some("Sheet2".to_string()),
            Some("Sales2".to_string()),
            Some("Sales2".to_string())
        ),
    );
    // Linked: the table shrinks, and the next refresh follows it.
    resize_table_rows(&fx, "Sales2", 2);
    assert_eq!(next_refresh_reads(&fx, id), ((0, 0), (2, 2), 1), "the next refresh follows Sales2");
}

/// A RANGE typed over a table pivot applied, but the table link stayed --
/// and a refresh lets a linked table's current range win, so the next
/// refresh (or ANY table edit, which refreshes every linked pivot) silently
/// read the table again while the source still read "Sheet2!A1:C4". The
/// typed text is the source: the link goes, as the create door's
/// `sourceTextNamesTable` rule already drops it for a retyped source.
#[test]
fn a_range_typed_over_a_table_pivot_unlinks_it_so_the_next_refresh_reads_the_range() {
    let (fx, id) = pivot_on_sheet2_over_table1();

    change_source(&fx, id, "Sheet2!A1:C4").expect("the change applies");
    assert_eq!(getpivotdata(&fx, "Sheet2", (0, 4), &[]), Some(800.0), "Sheet2's rows");
    assert_eq!(
        recorded_source(&fx, id),
        ((0, 0), (3, 2), Some("Sheet2".to_string()), Some("Sheet2!A1:C4".to_string()), None),
        "the typed range, and no table link left behind"
    );
    assert_eq!(
        next_refresh_reads(&fx, id),
        ((0, 0), (3, 2), 1),
        "the next refresh reads the typed Sheet2 range, not Table1 on Sheet1"
    );
}

/// A bare name that names no table is not a source: refused before the
/// effect, with the pivot -- and its table link -- as it was.
#[test]
fn a_name_that_is_no_table_is_refused_and_leaves_the_link_alone() {
    let (fx, id) = pivot_on_sheet2_over_table1();
    crate::document_effect::mark_saved(&fx.file);
    let before = recorded_source(&fx, id);

    change_source(&fx, id, "Table9").expect_err("no table is named Table9");
    change_source(&fx, id, "Sheet1!Table1").expect_err("a table is named bare, never sheet-qualified");
    assert!(!fx.file.is_dirty(), "a refused change dirtied the document");
    assert_eq!(recorded_source(&fx, id), before);
}

/// The refresh rule itself: a linked table's CURRENT cells win; once the
/// table is gone, the recorded range on the recorded sheet.
#[test]
fn the_next_refresh_of_a_table_linked_pivot_reads_the_tables_current_cells() {
    let (fx, id) = pivot_on_sheet2_over_table1();
    resize_table_rows(&fx, "Table1", 1);
    assert_eq!(next_refresh_reads(&fx, id), ((0, 0), (1, 2), 0), "the table's current extent");

    let seed = test_seed_effect();
    let (sheet, table_id) = fx.state.table_names.write(&seed).unwrap().remove("TABLE1").unwrap();
    fx.state.tables.write(&seed).unwrap().get_mut(&sheet).unwrap().remove(&table_id);
    assert_eq!(next_refresh_reads(&fx, id), ((0, 0), (3, 2), 0), "the recorded Sheet1!A1:C4");
}

// ============================================================================
// Change Data Source refuses a range that covers the pivot's OWN output
// (wave F, Z1 -- the create door's source/destination gate, on this door)
// ============================================================================

/// A pivot on Sheet1 at E1 over SALES in A1:C4, WRITTEN to the sheet with its
/// region, as a create leaves it: E1:F4 (the header row, North, South, Grand
/// Total).
fn pivot_beside_its_source() -> (Fx, PivotId) {
    let fx = fx(1);
    put(&fx, 0, SALES);
    let id = placed_pivot(&fx, sales_definition("Sheet1", (0, 4), &[(0, "Region")]), 0);
    (fx, id)
}

/// Every cell of sheet 0's `start..=end` block, as the sheet holds it.
fn cells_of(fx: &Fx, start: (u32, u32), end: (u32, u32)) -> Vec<String> {
    let grids = fx.state.grids.read().unwrap();
    let mut out = Vec::new();
    for row in start.0..=end.0 {
        for col in start.1..=end.1 {
            out.push(format!("{:?}", grids[0].get_cell(row, col)));
        }
    }
    out
}

/// The create door refuses a destination inside its source
/// (`check_pivot_source_destination_overlap`); Change Data Source never
/// asked. A pivot at Sheet1!E1 over A1:C4 changed to `Sheet1!A1:H20` was
/// accepted: its records were read off its own header and item cells, and
/// every refresh after summarised the pivot's own output. Refused now, before
/// the effect -- for the anchor, and for any cell of the output the pivot
/// holds (a range that stops short of E1 but reaches E2:F4 reads the pivot's
/// item labels and totals just the same), with the document clean and the
/// sheet and the source as they were.
#[test]
fn change_data_source_refuses_a_range_that_covers_the_pivots_own_output() {
    let (fx, id) = pivot_beside_its_source();
    let region = get_pivot_region(&fx.state, id).expect("fixture: the region");
    assert_eq!(
        (region.sheet_index, region.start_row, region.start_col, region.end_row, region.end_col),
        (0, 0, 4, 3, 5),
        "fixture: the output is Sheet1!E1:F4"
    );
    crate::document_effect::mark_saved(&fx.file);
    let source_before = recorded_source(&fx, id);
    let cells_before = cells_of(&fx, (0, 0), (19, 7));

    for text in ["Sheet1!A1:H20", "A1:H20", "'sheet1'!$A$1:$H$20", "Sheet1!A:H", "Sheet1!A2:F10", "Sheet1!F4:G9"] {
        let refused = change_source(&fx, id, text);
        let err = match refused {
            Ok(_) => panic!("{text}: a source covering the pivot's own output was accepted"),
            Err(e) => e,
        };
        assert!(err.contains("own output"), "{text}: refused for another reason: {err}");
        assert!(!fx.file.is_dirty(), "{text}: a refused change dirtied the document");
        assert_eq!(recorded_source(&fx, id), source_before, "{text}: the refused change moved the source");
        assert_eq!(cells_of(&fx, (0, 0), (19, 7)), cells_before, "{text}: the refused change wrote the sheet");
    }

    // Positive controls: a range that stops before the output applies, on the
    // pivot's own sheet.
    change_source(&fx, id, "Sheet1!A1:D4").expect("A1:D4 stops at column D, before the output at E");
    assert_eq!(getpivotdata(&fx, "Sheet1", (0, 4), &[]), Some(35.0), "the pivot still reads SALES");
    change_source(&fx, id, "A1:C3").expect("a smaller range beside the output applies");
    assert_eq!(getpivotdata(&fx, "Sheet1", (0, 4), &[]), Some(30.0), "North 10 + South 20");
}

/// A source on ANOTHER sheet cannot cover the output, whatever its address:
/// the pivot on Sheet2 at E1 takes `Sheet1!A1:H20`, the same cells that are
/// refused on its own sheet.
#[test]
fn change_data_source_to_the_same_address_on_another_sheet_applies() {
    let (fx, id) = pivot_on_sheet2_over_sheet1();
    placed_pivot_region(&fx, id, 1);
    change_source(&fx, id, "Sheet1!A1:H20").expect("another sheet's A1:H20 is not the pivot's output");
    assert_eq!(getpivotdata(&fx, "Sheet2", (0, 4), &[]), Some(35.0), "Sheet1's SALES");
    let err = change_source(&fx, id, "Sheet2!A1:H20").expect_err("its own sheet's A1:H20 covers E1");
    assert!(err.contains("own output"), "{err}");
}

/// Write an already stored pivot to `dest_sheet` with its region (what
/// `placed_pivot` does for a new one).
fn placed_pivot_region(fx: &Fx, id: PivotId, dest_sheet: usize) {
    let (destination, view) = {
        let tables = fx.pivots.pivot_tables.read().unwrap();
        let views = fx.pivots.views.lock().unwrap();
        (tables[&id].0.destination, views[&id].clone())
    };
    finalize_pivot_update(&fx.state, &test_seed_effect(), &fx.pivots, id, dest_sheet, destination, &view, None)
        .expect("the pivot is written");
}

// ============================================================================
// The undo-ticket RESIDUAL note names the style command only as FIXED (wave F,
// Z4 -- the note went stale when Y3 fixed the command it named)
// ============================================================================

/// `undo_commands.rs`'s RESIDUAL note named
/// `named_styles_cmd::apply_named_style_impl` as a command that closes a
/// frontend-opened transaction itself ("its internal begin joined, and it then
/// commits unconditionally"). Since wave E (Y3) that command commits only a
/// transaction it opened, so the note sent a reader after a fixed command and
/// away from the ones that still do it. The note may name it only in the
/// sentence that says it was fixed -- and only while the fix is still there.
#[test]
fn the_undo_residual_note_names_the_style_command_only_as_fixed() {
    let styles = include_str!("../named_styles_cmd.rs");
    assert!(
        styles.contains("    if opened_transaction {\n        undo_stack.commit_transaction();"),
        "fixture: the style command commits only a transaction it opened (Y3)"
    );
    let undo = include_str!("../undo_commands.rs");
    let start = undo.find("// RESIDUAL, named rather than hidden").expect("the RESIDUAL note");
    let note = undo[start..]
        .lines()
        .take_while(|l| l.trim_start().starts_with("//"))
        .map(|l| l.trim_start().trim_start_matches("//").trim())
        .collect::<Vec<_>>()
        .join(" ");
    for sentence in note.split(". ").filter(|s| s.contains("apply_named_style_impl")) {
        assert!(
            sentence.contains("since wave E"),
            "the RESIDUAL note names apply_named_style_impl as a live closer of a frontend \
             transaction: \"{sentence}\""
        );
    }
}

/// Found live 2026-09-29 (e2e fixall-pivot TL-NUM): the Insert Timeline dialog
/// offered SALES as a date field, because every small number is a valid date
/// serial. A grid-sourced pivot offers a numeric column only when its cells are
/// date- or time-formatted (Excel's rule); text dates still count.
#[test]
fn only_a_date_formatted_column_is_offered_to_a_timeline() {
    let fx = fx(2);
    put(
        &fx,
        0,
        &[
            &["Date", "Product", "Sales", "Shipped"],
            &["46032", "A", "10", "2026-01-12"],
            &["46053", "B", "20", "2026-02-03"],
            &["46084", "A", "30", "2026-03-05"],
        ],
    );
    let seed = test_seed_effect();
    let date_style = fx.state.style_registry.write(&seed).unwrap().get_or_create(engine::CellStyle {
        number_format: engine::NumberFormat::Date { format: "yyyy-mm-dd".to_string() },
        ..engine::CellStyle::default()
    });
    for row in 1..=3u32 {
        for grid in [&mut fx.state.grids.write(&seed).unwrap()[0], &mut *fx.state.grid.write(&seed).unwrap()] {
            if let Some(cell) = grid.get_cell(row, 0).cloned() {
                let mut cell = cell;
                cell.style_index = date_style;
                grid.set_cell(row, 0, cell);
            }
        }
    }
    let recalc = super::operations::PivotRecalcStates {
        pane: &crate::pane_control::PaneControlState::new(),
        ribbon: &crate::ribbon_filter::RibbonFilterState::new(),
        user_files: &crate::persistence::UserFilesState::default(),
    };
    let request = super::types::CreatePivotRequest {
        source_range: "Sheet1!A1:D4".to_string(),
        destination_cell: "Sheet2!B2".to_string(),
        source_sheet: Some(0),
        destination_sheet: Some(1),
        has_headers: Some(true),
        name: None,
        source_table_name: None,
        canvas_frame: None,
    };
    let response = super::commands::create_pivot_core(
        &fx.state,
        &fx.file,
        &fx.pivots,
        recalc,
        request,
        vec!["Product".to_string()],
        vec![("Sales".to_string(), AggregationType::Sum)],
    )
    .expect("the pivot");
    let fields = crate::timeline_slicer::commands::pivot_date_fields_core(&fx.state, &fx.pivots, response.pivot_id)
        .expect("the date fields");
    assert_eq!(fields, vec!["Date".to_string(), "Shipped".to_string()], "Sales is a number column, not a date column");
}

/// Found live 2026-09-29 (e2e fixall-pivot R4): with the values on ROWS, no
/// row field and row grand totals off, `=GETPIVOTDATA("Count of Sales";E1)`
/// answered #REF! -- the no-pairs form accepted only a GrandTotal cell, and each
/// value row there IS its field's total.
#[test]
fn getpivotdata_without_pairs_reads_a_values_on_rows_total() {
    let fx = fx(1);
    let grid = put(&fx, 0, SALES);
    let mut cache = cache_of(&grid, (3, 2));
    // Values on rows, no row field: the sales definition WITHOUT its row field,
    // plus a Count.
    let mut def = sales_definition("Sheet1", (10, 4), &[]);
    def.value_fields.push(ValueField::new(2, "Count of Sales".to_string(), AggregationType::Count));
    def.layout.values_position = pivot_engine::ValuesPosition::Rows;
    def.layout.show_row_grand_totals = false;
    let view = pivot_engine::calculate_pivot(&def, &mut cache);
    let id = def.id;
    let mut tables = std::collections::HashMap::new();
    tables.insert(id, (def, cache));
    let mut views = std::collections::HashMap::new();
    views.insert(id, view);
    let count = super::operations::lookup_pivot_data(&tables, &views, "Count of Sales", None, 10, 4, &[]);
    assert_eq!(count, Some(3.0), "the no-pairs form of a values-on-rows pivot read #REF!");
    let sum = super::operations::lookup_pivot_data(&tables, &views, "Sum of Sales", None, 10, 4, &[]);
    assert!(sum.is_some(), "the Sum form too");
}

/// Found 2026-09-29 while fixing e2e fixall-pivot X1: the editor's field info
/// carried neither a value field's Show Values As nor its number format, and
/// the editor sends its whole Values zone back on its next change -- the update
/// REPLACES the value fields -- so the first edit after a reopen cleared both.
#[test]
fn the_values_zone_carries_show_values_as_with_its_base_and_the_number_format() {
    let fx = fx(1);
    let grid = put(&fx, 0, SALES);
    let cache = cache_of(&grid, (3, 2));
    let mut def = sales_definition("Sheet1", (10, 4), &[(0, "Region")]);
    {
        let vf = &mut def.value_fields[0];
        vf.show_values_as = pivot_engine::ShowValuesAs::Difference;
        vf.base_field_index = Some(def.row_fields[0].source_index);
        vf.base_item = Some("(previous)".to_string());
        vf.number_format = Some("0.0%".to_string());
    }
    let zone = super::commands::value_zone_fields(&def, &cache);
    assert_eq!(zone.len(), 1);
    assert_eq!(zone[0].number_format.as_deref(), Some("0.0%"), "the number format is not in the Values zone");
    let rule = zone[0].show_as.as_ref().expect("Show Values As is not in the Values zone");
    assert_eq!(rule.calculation, super::types::ShowAsCalculation::DifferenceFrom);
    assert_eq!(rule.base_field.as_deref(), Some(def.row_fields[0].name.as_str()), "the base field is not named");
    assert_eq!(rule.base_item.as_deref(), Some("(previous)"));

    // A field that shows its values as they are carries no rule.
    def.value_fields[0].show_values_as = pivot_engine::ShowValuesAs::Normal;
    assert!(super::commands::value_zone_fields(&def, &cache)[0].show_as.is_none());
}
