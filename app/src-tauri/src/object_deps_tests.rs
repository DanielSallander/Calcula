//! FILENAME: app/src-tauri/src/object_deps_tests.rs
//! PURPOSE: One test per (owner, dependent) pair in `DEPENDENCY_MATRIX` whose
//!          policy is not a no-op — the behaviour the census only checks the
//!          EXISTENCE of.
//! CONTEXT: §3bn in docs/design/open-decisions-2026-08.md.
//!
//! The census (`object_deps_census_tests`) proves a cascade is CALLED. These
//! prove it does the right thing, which is a different question and the one the
//! measured defect was about: the orphaned slicer's binding was intact, so any
//! test that only asked "was cleanup invoked?" would have passed.
//!
//! Each test names the pair it covers, so a row deleted from the matrix leaves
//! an obviously-orphaned test behind rather than silently reducing coverage.

use crate::object_deps::*;
use crate::pane_control::{
    ChartParamTarget, PaneControl, PaneControlConfig, PaneControlState, PaneControlType,
};
use crate::ribbon_filter::{ConnectionMode, RibbonFilter, RibbonFilterState};
use crate::slicer::types::{
    Slicer, SlicerArrangement, SlicerConnection, SlicerSelectionMode, SlicerSourceType, SlicerState,
};
use crate::timeline_slicer::types::{
    TimelineLevel, TimelineSlicer, TimelineSlicerState, TimelineSourceType,
};
use identity::EntityId;

fn id() -> EntityId {
    EntityId::from_bytes(identity::generate_uuid_v7())
}

fn effect() -> crate::document_effect::DocumentEffect {
    crate::document_effect::test_seed_effect()
}

/// An empty workbook, for the cascades that must also prune the OBJECT SCRIPTS
/// attached to what they delete (C10). Added with the transitive fix in 3cd:
/// `cascade_deleted_sources` now runs the deleted slicers' and timelines' own
/// cascades, and those reach `state.object_scripts`.
fn app_state() -> crate::AppState {
    crate::create_app_state()
}

fn slicer(name: &str, source_type: SlicerSourceType, cache: EntityId, connected: Vec<EntityId>) -> Slicer {
    Slicer {
        id: id(),
        name: name.to_string(),
        header_text: None,
        sheet_index: 0,
        x: 10.0,
        y: 10.0,
        width: 180.0,
        height: 240.0,
        source_type,
        cache_source_id: cache,
        field_name: "Region".to_string(),
        selected_items: None,
        show_header: true,
        columns: 1,
        style_preset: "SlicerStyleLight1".to_string(),
        selection_mode: SlicerSelectionMode::default(),
        hide_no_data: false,
        indicate_no_data: true,
        sort_no_data_last: true,
        force_selection: false,
        show_select_all: false,
        arrangement: SlicerArrangement::default(),
        rows: 0,
        item_gap: 4.0,
        autogrid: true,
        item_padding: 0.0,
        button_radius: 2.0,
        connected_sources: connected
            .into_iter()
            .map(|source_id| SlicerConnection { source_type, source_id })
            .collect(),
    }
}

fn timeline(name: &str, source: EntityId, connected: Vec<EntityId>) -> TimelineSlicer {
    TimelineSlicer {
        id: id(),
        name: name.to_string(),
        header_text: None,
        sheet_index: 0,
        x: 10.0,
        y: 10.0,
        width: 350.0,
        height: 100.0,
        source_type: TimelineSourceType::Pivot,
        source_id: source,
        field_name: "OrderDate".to_string(),
        level: TimelineLevel::default(),
        selection_start: None,
        selection_end: None,
        show_header: true,
        show_level_selector: true,
        show_scrollbar: true,
        style_preset: "TimelineStyleLight1".to_string(),
        connected_pivot_ids: connected,
    }
}

fn ribbon_filter(name: &str) -> RibbonFilter {
    RibbonFilter {
        id: id(),
        name: name.to_string(),
        connection_id: id(),
        data_source_id: None,
        field_name: "Sales.Region".to_string(),
        field_data_type: "text".to_string(),
        connection_mode: ConnectionMode::Manual,
        connected_pivots: vec![],
        connected_sheets: vec![],
        display_mode: Default::default(),
        selected_items: None,
        cross_filter_targets: vec![],
        cross_filter_slicer_targets: vec![],
        advanced_filter: None,
        hide_no_data: false,
        indicate_no_data: true,
        sort_no_data_last: true,
        show_select_all: false,
        single_select: false,
        order: 0,
        button_columns: 2,
        button_rows: 0,
    }
}

fn slider_bound_to(chart_id: &str) -> PaneControl {
    PaneControl {
        id: id(),
        name: "Growth".to_string(),
        control_type: PaneControlType::Slider,
        config: PaneControlConfig::Slider {
            min: 0.0,
            max: 100.0,
            step: 1.0,
            show_value: true,
            chart_param_target: Some(ChartParamTarget {
                chart_id: chart_id.to_string(),
                param: "growth".to_string(),
            }),
        },
        value: Some(engine::ControlValue::Number(42.0)),
        order: 0,
    }
}

// ===========================================================================
// PAIR: table -> slicer.cacheSourceId   (THE MEASURED DEFECT)
// ===========================================================================

/// tables = 0, slicers = 1, binding intact. The exact shape the invariant
/// runner kept hitting and that was written off as a monkey flake three times.
#[test]
fn deleting_a_table_deletes_the_slicer_that_had_only_that_table() {
    let slicer_state = SlicerState::new();
    let timeline_state = TimelineSlicerState::new();
    let filter_state = RibbonFilterState::new();
    let e = effect();

    let table_id = id();
    let s = slicer("Region", SlicerSourceType::Table, table_id, vec![table_id]);
    let slicer_id = s.id;
    slicer_state.slicers.write(&e).unwrap().insert(slicer_id, s);

    let cascade = cascade_deleted_sources(
        &app_state(),
        &slicer_state,
        &timeline_state,
        &filter_state,
        &e,
        &[DeletedSource::table(table_id)],
    );

    assert!(
        slicer_state.slicers.read().unwrap().is_empty(),
        "the slicer survived its only table — this is the orphan: it answers \
         'Table not found' on every item fetch and its overlay goes on eating \
         clicks"
    );
    assert_eq!(cascade.deleted_slicers.len(), 1);
    assert_eq!(cascade.deleted_slicers[0].name, "Region");
}

/// The rebind half of the SAME rule: Excel keeps a slicer that still has a live
/// Report Connection. Deleting one of two sources must not delete the slicer.
#[test]
fn deleting_one_of_two_sources_repoints_the_slicer_instead_of_deleting_it() {
    let slicer_state = SlicerState::new();
    let timeline_state = TimelineSlicerState::new();
    let filter_state = RibbonFilterState::new();
    let e = effect();

    let dead = id();
    let alive = id();
    let s = slicer("Region", SlicerSourceType::Table, dead, vec![dead, alive]);
    let slicer_id = s.id;
    slicer_state.slicers.write(&e).unwrap().insert(slicer_id, s);

    let cascade = cascade_deleted_sources(
        &app_state(),
        &slicer_state,
        &timeline_state,
        &filter_state,
        &e,
        &[DeletedSource::table(dead)],
    );

    let slicers = slicer_state.slicers.read().unwrap();
    let survivor = slicers.get(&slicer_id).expect("slicer must survive");
    assert_eq!(
        survivor.cache_source_id, alive,
        "the cache source must be repointed at the surviving connection, or the \
         item list resolves against a dead id while the slicer is still on screen"
    );
    assert_eq!(survivor.connected_sources.len(), 1);
    assert_eq!(survivor.connected_sources[0].source_id, alive);
    assert_eq!(cascade.rebound_slicers.len(), 1);
    assert_eq!(
        cascade.rebound_slicers[0].cache_source_id, dead,
        "the cascade must report the PREVIOUS binding — that is what undo restores"
    );
}

/// A slicer sourced from a MODEL CONNECTION must not be touched by a table or
/// pivot delete: its `cacheSourceId` names a connection, so an id match would
/// be a coincidence.
#[test]
fn a_model_connection_slicer_is_untouched_by_a_table_delete() {
    let slicer_state = SlicerState::new();
    let timeline_state = TimelineSlicerState::new();
    let filter_state = RibbonFilterState::new();
    let e = effect();

    let shared = id();
    let s = slicer("Region", SlicerSourceType::BiConnection, shared, vec![shared]);
    let slicer_id = s.id;
    slicer_state.slicers.write(&e).unwrap().insert(slicer_id, s);

    cascade_deleted_sources(
        &app_state(),
        &slicer_state,
        &timeline_state,
        &filter_state,
        &e,
        &[DeletedSource::table(shared)],
    );

    assert!(
        slicer_state.slicers.read().unwrap().contains_key(&slicer_id),
        "a BI-connection slicer was deleted because a TABLE happened to carry \
         the same id — the cascade must key on source_type as well"
    );
}

/// Deleting a TABLE must not disturb a slicer bound to a PIVOT with the same
/// id. (Ids are v7 UUIDs so a real collision is impossible; this pins the type
/// check that makes the impossibility irrelevant.)
#[test]
fn a_pivot_slicer_is_untouched_by_a_table_delete_of_the_same_id() {
    let slicer_state = SlicerState::new();
    let timeline_state = TimelineSlicerState::new();
    let filter_state = RibbonFilterState::new();
    let e = effect();

    let shared = id();
    let s = slicer("Region", SlicerSourceType::Pivot, shared, vec![shared]);
    let slicer_id = s.id;
    slicer_state.slicers.write(&e).unwrap().insert(slicer_id, s);

    cascade_deleted_sources(
        &app_state(),
        &slicer_state,
        &timeline_state,
        &filter_state,
        &e,
        &[DeletedSource::table(shared)],
    );

    assert!(slicer_state.slicers.read().unwrap().contains_key(&slicer_id));
}

// ===========================================================================
// PAIR: pivot -> timelineSlicer.sourceId
// ===========================================================================

#[test]
fn deleting_a_pivot_deletes_the_timeline_that_had_only_that_pivot() {
    let slicer_state = SlicerState::new();
    let timeline_state = TimelineSlicerState::new();
    let filter_state = RibbonFilterState::new();
    let e = effect();

    let pivot_id = id();
    let tl = timeline("Dates", pivot_id, vec![pivot_id]);
    let tl_id = tl.id;
    timeline_state.timelines.write(&e).unwrap().insert(tl_id, tl);

    let cascade = cascade_deleted_sources(
        &app_state(),
        &slicer_state,
        &timeline_state,
        &filter_state,
        &e,
        &[DeletedSource::pivot(pivot_id)],
    );

    assert!(timeline_state.timelines.read().unwrap().is_empty());
    assert_eq!(cascade.deleted_timelines.len(), 1);
}

#[test]
fn a_timeline_with_a_surviving_pivot_is_repointed() {
    let slicer_state = SlicerState::new();
    let timeline_state = TimelineSlicerState::new();
    let filter_state = RibbonFilterState::new();
    let e = effect();

    let dead = id();
    let alive = id();
    let tl = timeline("Dates", dead, vec![dead, alive]);
    let tl_id = tl.id;
    timeline_state.timelines.write(&e).unwrap().insert(tl_id, tl);

    cascade_deleted_sources(
        &app_state(),
        &slicer_state,
        &timeline_state,
        &filter_state,
        &e,
        &[DeletedSource::pivot(dead)],
    );

    let timelines = timeline_state.timelines.read().unwrap();
    let survivor = timelines.get(&tl_id).expect("timeline must survive");
    assert_eq!(survivor.source_id, alive);
    assert_eq!(survivor.connected_pivot_ids, vec![alive]);
}

/// A timeline can only be sourced from a pivot, so a TABLE delete must be a
/// complete no-op for it.
#[test]
fn deleting_a_table_never_touches_a_timeline() {
    let slicer_state = SlicerState::new();
    let timeline_state = TimelineSlicerState::new();
    let filter_state = RibbonFilterState::new();
    let e = effect();

    let shared = id();
    let tl = timeline("Dates", shared, vec![shared]);
    let tl_id = tl.id;
    timeline_state.timelines.write(&e).unwrap().insert(tl_id, tl);

    cascade_deleted_sources(
        &app_state(),
        &slicer_state,
        &timeline_state,
        &filter_state,
        &e,
        &[DeletedSource::table(shared)],
    );

    assert!(timeline_state.timelines.read().unwrap().contains_key(&tl_id));
}

// ===========================================================================
// PAIR: pivot -> ribbonFilter.connectedPivots
// ===========================================================================

#[test]
fn deleting_a_pivot_prunes_it_from_every_ribbon_filter_but_keeps_the_filter() {
    let slicer_state = SlicerState::new();
    let timeline_state = TimelineSlicerState::new();
    let filter_state = RibbonFilterState::new();
    let e = effect();

    let dead = id();
    let alive = id();
    let mut f = ribbon_filter("Region");
    f.connected_pivots = vec![dead, alive];
    f.cross_filter_targets = vec![dead];
    let filter_id = f.id;
    filter_state.filters.write(&e).unwrap().insert(filter_id, f);

    let cascade = cascade_deleted_sources(
        &app_state(),
        &slicer_state,
        &timeline_state,
        &filter_state,
        &e,
        &[DeletedSource::pivot(dead)],
    );

    let filters = filter_state.filters.read().unwrap();
    let f = filters.get(&filter_id).expect("the FILTER must survive");
    assert_eq!(
        f.connected_pivots,
        vec![alive],
        "the dead target must go and the live one must stay"
    );
    assert!(f.cross_filter_targets.is_empty());
    assert_eq!(cascade.rebound_filters.len(), 1);
    assert_eq!(
        cascade.rebound_filters[0].connected_pivots,
        vec![dead, alive],
        "the cascade must report the PREVIOUS target list for undo"
    );
}

// ===========================================================================
// PAIR: slicer -> ribbonFilter.crossFilterSlicerTargets
// ===========================================================================

#[test]
fn deleting_a_slicer_prunes_it_from_ribbon_filter_cross_links() {
    let filter_state = RibbonFilterState::new();
    let e = effect();

    let dead = id();
    let alive = id();
    let mut f = ribbon_filter("Region");
    f.cross_filter_slicer_targets = vec![dead, alive];
    let filter_id = f.id;
    filter_state.filters.write(&e).unwrap().insert(filter_id, f);

    let previous = cascade_deleted_slicers(&filter_state, &e, &[dead]);

    let filters = filter_state.filters.read().unwrap();
    assert_eq!(
        filters[&filter_id].cross_filter_slicer_targets,
        vec![alive]
    );
    assert_eq!(previous.len(), 1);
    assert_eq!(previous[0].cross_filter_slicer_targets, vec![dead, alive]);
}

#[test]
fn a_filter_that_names_no_deleted_slicer_is_not_reported_for_undo() {
    let filter_state = RibbonFilterState::new();
    let e = effect();
    let mut f = ribbon_filter("Region");
    f.cross_filter_slicer_targets = vec![id()];
    filter_state.filters.write(&e).unwrap().insert(f.id, f);

    let previous = cascade_deleted_slicers(&filter_state, &e, &[id()]);
    assert!(
        previous.is_empty(),
        "an untouched filter must not produce an undo record — a no-op restore \
         that fires on Ctrl+Z is how an undo stack starts lying"
    );
}

// ===========================================================================
// PAIR: ribbonFilter -> sibling ribbonFilter.crossFilterTargets
// ===========================================================================

#[test]
fn deleting_a_ribbon_filter_prunes_it_from_its_siblings_cross_links() {
    let filter_state = RibbonFilterState::new();
    let e = effect();

    let dead = id();
    let mut sibling = ribbon_filter("Category");
    sibling.cross_filter_targets = vec![dead];
    let sibling_id = sibling.id;
    filter_state.filters.write(&e).unwrap().insert(sibling_id, sibling);

    let previous = cascade_deleted_filters(&filter_state, &e, &[dead]);

    let filters = filter_state.filters.read().unwrap();
    assert!(filters[&sibling_id].cross_filter_targets.is_empty());
    assert_eq!(previous.len(), 1);
}

// ===========================================================================
// PAIR: chart -> paneControl.config.chartParamTarget
// ===========================================================================

#[test]
fn deleting_a_chart_clears_the_binding_but_keeps_the_control_and_its_value() {
    let pane_state = PaneControlState::new();
    let chart_id = id();
    let control = slider_bound_to(&chart_id.to_string());
    let control_id = control.id;
    pane_state.controls.lock().unwrap().insert(control_id, control);

    let previous = cascade_deleted_charts(&pane_state, &[chart_id]);

    let controls = pane_state.controls.lock().unwrap();
    let survivor = controls.get(&control_id).expect(
        "deleting a chart must NOT delete the slider that drove it — the \
         control has a name, a value and GET.CONTROLVALUE readers",
    );
    match &survivor.config {
        PaneControlConfig::Slider { chart_param_target, .. } => {
            assert!(
                chart_param_target.is_none(),
                "the dead chart binding survived; every drag would drive an id \
                 that resolves to nothing"
            );
        }
        other => panic!("config changed shape: {:?}", other),
    }
    assert_eq!(
        survivor.value,
        Some(engine::ControlValue::Number(42.0)),
        "the control's VALUE must be untouched — formulas read it by name"
    );
    assert_eq!(previous.len(), 1, "the previous config must be recorded for undo");
}

#[test]
fn a_control_bound_to_a_different_chart_is_untouched() {
    let pane_state = PaneControlState::new();
    let control = slider_bound_to(&id().to_string());
    let control_id = control.id;
    pane_state.controls.lock().unwrap().insert(control_id, control);

    let previous = cascade_deleted_charts(&pane_state, &[id()]);
    assert!(previous.is_empty());
    let controls = pane_state.controls.lock().unwrap();
    match &controls[&control_id].config {
        PaneControlConfig::Slider { chart_param_target, .. } => {
            assert!(chart_param_target.is_some())
        }
        other => panic!("config changed shape: {:?}", other),
    }
}

// ===========================================================================
// PAIR: sheet -> slicer.sheetIndex / timelineSlicer.sheetIndex
//       (and the quieter half: objects ABOVE the deleted sheet)
// ===========================================================================

/// The remap closure `delete_sheet` passes for "sheet 1 was deleted".
fn deleted_sheet_1(i: usize) -> Option<usize> {
    if i == 1 {
        None
    } else if i > 1 {
        Some(i - 1)
    } else {
        Some(i)
    }
}

#[test]
fn deleting_a_sheet_removes_the_slicers_on_it_and_re_anchors_those_above() {
    let state = crate::create_app_state();
    let slicer_state = SlicerState::new();
    let timeline_state = TimelineSlicerState::new();
    let filter_state = RibbonFilterState::new();
    let e = effect();

    let mut on_deleted = slicer("OnDeleted", SlicerSourceType::Table, id(), vec![]);
    on_deleted.sheet_index = 1;
    let on_deleted_id = on_deleted.id;
    let mut above = slicer("Above", SlicerSourceType::Table, id(), vec![]);
    above.sheet_index = 2;
    let above_id = above.id;
    {
        let mut slicers = slicer_state.slicers.write(&e).unwrap();
        slicers.insert(on_deleted_id, on_deleted);
        slicers.insert(above_id, above);
    }

    let cascade = cascade_sheet_removed(
        &state,
        &slicer_state,
        &timeline_state,
        &filter_state,
        &e,
        &deleted_sheet_1,
    );

    let slicers = slicer_state.slicers.read().unwrap();
    assert!(
        !slicers.contains_key(&on_deleted_id),
        "a slicer on the deleted sheet survived — invisible, but still in the \
         saved file and still claiming a rectangle"
    );
    assert_eq!(
        slicers[&above_id].sheet_index, 1,
        "a slicer ABOVE the deleted sheet kept its old index, which now names a \
         DIFFERENT sheet — it would paint over the wrong one"
    );
    assert_eq!(cascade.deleted_slicers.len(), 1);
}

#[test]
fn deleting_a_sheet_removes_the_charts_on_it_and_re_anchors_those_above() {
    let state = crate::create_app_state();
    let slicer_state = SlicerState::new();
    let timeline_state = TimelineSlicerState::new();
    let filter_state = RibbonFilterState::new();
    let e = effect();

    let on_deleted = crate::api_types::ChartEntry {
        id: id(),
        sheet_index: 1,
        spec_json: "{}".to_string(),
    };
    let above = crate::api_types::ChartEntry {
        id: id(),
        sheet_index: 3,
        spec_json: "{}".to_string(),
    };
    let above_id = above.id;
    {
        let mut charts = state.charts.write(&e).unwrap();
        charts.push(on_deleted);
        charts.push(above);
    }

    let cascade = cascade_sheet_removed(
        &state,
        &slicer_state,
        &timeline_state,
        &filter_state,
        &e,
        &deleted_sheet_1,
    );

    let charts = state.charts.read().unwrap();
    assert_eq!(charts.len(), 1, "the chart on the deleted sheet must go");
    assert_eq!(charts[0].id, above_id);
    assert_eq!(charts[0].sheet_index, 2);
    assert_eq!(cascade.deleted_charts.len(), 1);
}

#[test]
fn deleting_a_sheet_re_anchors_sparklines_and_drops_the_deleted_sheets_group() {
    let state = crate::create_app_state();
    let slicer_state = SlicerState::new();
    let timeline_state = TimelineSlicerState::new();
    let filter_state = RibbonFilterState::new();
    let e = effect();

    {
        let mut sparks = state.sparklines.write(&e).unwrap();
        sparks.push(crate::api_types::SparklineEntry {
            sheet_index: 1,
            groups_json: "[\"gone\"]".to_string(),
        });
        sparks.push(crate::api_types::SparklineEntry {
            sheet_index: 4,
            groups_json: "[\"kept\"]".to_string(),
        });
    }

    cascade_sheet_removed(
        &state,
        &slicer_state,
        &timeline_state,
        &filter_state,
        &e,
        &deleted_sheet_1,
    );

    let sparks = state.sparklines.read().unwrap();
    assert_eq!(sparks.len(), 1);
    assert_eq!(sparks[0].sheet_index, 3);
    assert_eq!(sparks[0].groups_json, "[\"kept\"]");
}

#[test]
fn deleting_a_sheet_prunes_it_from_by_sheet_ribbon_filter_targets() {
    let state = crate::create_app_state();
    let slicer_state = SlicerState::new();
    let timeline_state = TimelineSlicerState::new();
    let filter_state = RibbonFilterState::new();
    let e = effect();

    let mut f = ribbon_filter("Region");
    f.connection_mode = ConnectionMode::BySheet;
    f.connected_sheets = vec![0, 1, 2];
    let filter_id = f.id;
    filter_state.filters.write(&e).unwrap().insert(filter_id, f);

    cascade_sheet_removed(
        &state,
        &slicer_state,
        &timeline_state,
        &filter_state,
        &e,
        &deleted_sheet_1,
    );

    let filters = filter_state.filters.read().unwrap();
    assert_eq!(
        filters[&filter_id].connected_sheets,
        vec![0, 1],
        "sheet 1 must go and sheet 2 must become sheet 1 — a stale index \
         silently retargets a bySheet filter at another sheet's pivots"
    );
}

/// A sheet MOVE renumbers sheets exactly as a delete does. The remap is total
/// (nothing is deleted), so this must be a pure re-anchor.
#[test]
fn moving_a_sheet_re_anchors_objects_without_deleting_any() {
    let state = crate::create_app_state();
    let slicer_state = SlicerState::new();
    let timeline_state = TimelineSlicerState::new();
    let filter_state = RibbonFilterState::new();
    let e = effect();

    let mut s = slicer("Region", SlicerSourceType::Table, id(), vec![]);
    s.sheet_index = 2;
    let slicer_id = s.id;
    slicer_state.slicers.write(&e).unwrap().insert(slicer_id, s);

    // Sheet 2 moved to position 0: 2 -> 0, 0 -> 1, 1 -> 2.
    let cascade = cascade_sheet_removed(
        &state,
        &slicer_state,
        &timeline_state,
        &filter_state,
        &e,
        &|i| Some(match i {
            2 => 0,
            0 => 1,
            1 => 2,
            other => other,
        }),
    );

    assert!(cascade.deleted_slicers.is_empty(), "a MOVE must delete nothing");
    assert_eq!(
        slicer_state.slicers.read().unwrap()[&slicer_id].sheet_index,
        0
    );
}

// ===========================================================================
// The cascade is a no-op when nothing points at the deleted object
// ===========================================================================

#[test]
fn a_delete_with_no_dependents_reports_an_empty_cascade() {
    let slicer_state = SlicerState::new();
    let timeline_state = TimelineSlicerState::new();
    let filter_state = RibbonFilterState::new();
    let e = effect();

    let s = slicer("Region", SlicerSourceType::Table, id(), vec![]);
    slicer_state.slicers.write(&e).unwrap().insert(s.id, s);

    let cascade = cascade_deleted_sources(
        &app_state(),
        &slicer_state,
        &timeline_state,
        &filter_state,
        &e,
        &[DeletedSource::table(id())],
    );

    assert!(cascade.is_empty());
    assert_eq!(cascade.describe(), "");
    assert_eq!(
        slicer_state.slicers.read().unwrap().len(),
        1,
        "an unrelated delete must not disturb anything"
    );
}

/// The log line the delete commands print. It has to NAME the objects, which is
/// the whole standard `list_controls_referencing_macro` set: never a silent
/// orphan, and never a silent cascade either.
#[test]
fn the_cascade_description_names_the_objects_it_touched() {
    let slicer_state = SlicerState::new();
    let timeline_state = TimelineSlicerState::new();
    let filter_state = RibbonFilterState::new();
    let e = effect();

    let table_id = id();
    let s = slicer("RegionSlicer", SlicerSourceType::Table, table_id, vec![table_id]);
    slicer_state.slicers.write(&e).unwrap().insert(s.id, s);

    let cascade = cascade_deleted_sources(
        &app_state(),
        &slicer_state,
        &timeline_state,
        &filter_state,
        &e,
        &[DeletedSource::table(table_id)],
    );

    let text = cascade.describe();
    assert!(text.contains("RegionSlicer"), "the log line said: {}", text);
    assert!(text.contains("deleted slicer"), "the log line said: {}", text);
}

// ===========================================================================
// PAIR: slicer -> its computed properties (the shared helper)
// ===========================================================================

#[test]
fn a_cascaded_slicer_delete_drops_its_computed_properties_too() {
    use crate::slicer::computed::SlicerComputedProperty;

    let slicer_state = SlicerState::new();
    let timeline_state = TimelineSlicerState::new();
    let filter_state = RibbonFilterState::new();
    let e = effect();

    let table_id = id();
    let s = slicer("Region", SlicerSourceType::Table, table_id, vec![table_id]);
    let slicer_id = s.id;
    slicer_state.slicers.write(&e).unwrap().insert(slicer_id, s);
    slicer_state.computed_properties.write(&e).unwrap().insert(
        slicer_id,
        vec![SlicerComputedProperty {
            id: id(),
            slicer_id,
            attribute: "headerText".to_string(),
            formula: "=A1".to_string(),
            cached_ast: None,
            cached_value: None,
        }],
    );

    cascade_deleted_sources(
        &app_state(),
        &slicer_state,
        &timeline_state,
        &filter_state,
        &e,
        &[DeletedSource::table(table_id)],
    );

    assert!(
        slicer_state
            .computed_properties
            .read()
            .unwrap()
            .get(&slicer_id)
            .is_none(),
        "the slicer went and its computed properties stayed — they would be \
         re-evaluated forever against a slicer that does not exist, and they \
         are PERSISTED, so a save writes them"
    );
}
