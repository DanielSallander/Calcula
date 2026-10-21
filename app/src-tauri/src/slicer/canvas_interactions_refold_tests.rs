//! FILENAME: app/src-tauri/src/slicer/canvas_interactions_refold_tests.rs
//! PURPOSE: P4 S4d -- a canvas's visual interactions in the BACKEND paths a
//!          model slicer drives: the page fold (`page_model_slicers`: a
//!          slicer -> pivot `none` pair keeps that pivot unfolded through
//!          every rebuild), the slicer's own has-data shading (a slicer ->
//!          slicer `none` pair; other visuals' selections as
//!          `visual_constraints`, exact for tuples, capped), and the DC-9
//!          re-fold: changing a slicer -> pivot pair to or from `none`
//!          rebuilds that pivot IN THE SAME UNDO STEP as the layout change,
//!          on every door (`set_canvas_layout`, the `object_bindings`
//!          `/interactions` literal), all or nothing.
//! CONTEXT: A child of `model_slicer_tests`, so it drives the same REAL cores
//!          over the same in-memory model (`Sales(region, year, amount)`:
//!          East/Y1, West/Y1, East/Y2, North/Y2) through its `Fx`.

use super::*;
use ::persistence::{CanvasInteraction, CanvasInteractions, CanvasObjectRef, VisualInteractionMode};
use crate::api_types::{CanvasLayoutPatch, SlicerVisualConstraints, TupleFilterWire};

/// The canvas every test lays its objects on (sheet 0 is a worksheet).
const PAGE: usize = 1;

fn slicer_ref(id: EntityId) -> CanvasObjectRef {
    CanvasObjectRef { kind: "slicer".to_string(), id: id.to_string() }
}

fn pivot_ref(id: EntityId) -> CanvasObjectRef {
    CanvasObjectRef { kind: "pivot".to_string(), id: id.to_string() }
}

fn chart_ref(id: &str) -> CanvasObjectRef {
    CanvasObjectRef { kind: "chart".to_string(), id: id.to_string() }
}

fn pairs(list: &[(CanvasObjectRef, CanvasObjectRef, VisualInteractionMode)]) -> CanvasInteractions {
    CanvasInteractions {
        default_mode: None,
        pairs: list
            .iter()
            .map(|(source, target, mode)| CanvasInteraction { source: source.clone(), target: target.clone(), mode: *mode })
            .collect(),
    }
}

fn none(source: CanvasObjectRef, target: CanvasObjectRef) -> CanvasInteractions {
    pairs(&[(source, target, VisualInteractionMode::None)])
}

fn interactions_patch(interactions: CanvasInteractions) -> CanvasLayoutPatch {
    CanvasLayoutPatch { interactions: Some(interactions), ..Default::default() }
}

impl Fx {
    /// Store the page's interactions through the LAYOUT core alone (no
    /// re-fold): what an older door or a loaded file leaves behind.
    fn store_interactions(&self, interactions: CanvasInteractions) {
        crate::sheets::set_canvas_layout_inner(&self.state, &self.file, Some(PAGE), &interactions_patch(interactions))
            .expect("store the interactions");
    }

    /// Change them through THE door (`set_canvas_layout`'s body).
    async fn set_interactions(&self, interactions: CanvasInteractions) -> Result<crate::sheets::CanvasLayoutDone, String> {
        let ctx = self.ctx();
        let patch = interactions_patch(interactions);
        Box::pin(crate::sheets::set_canvas_layout_refolding(&ctx, &self.timelines, Some(PAGE), &patch)).await
    }

    fn interactions(&self) -> CanvasInteractions {
        crate::sheets::canvas_interactions_of(&self.state, PAGE).expect("the page is a canvas")
    }

    fn unfiltered(&self, pivot: EntityId) -> bool {
        self.hidden_on(pivot, "region").map_or(true, |h| h.is_empty())
    }

    fn page_sheet_id(&self) -> String {
        self.state.sheet_ids.read().unwrap()[PAGE].to_string()
    }

    fn binding_cx(&self) -> crate::object_bindings::BindingCx<'_> {
        crate::object_bindings::BindingCx {
            state: &self.state,
            file_state: &self.file,
            slicers: &self.slicer,
            timelines: &self.timelines,
            pivots: &self.pivots,
            pane: &self.pane,
            ribbon: &self.filters,
            user_files: &self.files,
        }
    }

    fn open_transaction(&self) -> bool {
        self.state.undo_stack.lock().unwrap().has_open_transaction()
    }

    fn top_description(&self) -> Option<String> {
        self.state.undo_stack.lock().unwrap().undo_description().map(str::to_string)
    }

    async fn region_items(&self, slicer: EntityId, constraints: Option<SlicerVisualConstraints>) -> Vec<SlicerItem> {
        get_slicer_items_core(&self.state, &self.pivots, &self.slicer, &self.filters, &self.bi, slicer, constraints)
            .await
            .expect("the slicer's items")
    }
}

fn no_data(items: &[SlicerItem]) -> Vec<String> {
    let mut out: Vec<String> = items.iter().filter(|i| !i.has_data).map(|i| i.key.clone()).collect();
    out.sort();
    out
}

// ============================================================================
// The page fold (pure)
// ============================================================================

/// The page is matched by sheet IDENTITY: a slicer is on the pivot's page when
/// `sheet_ids[slicer.sheet_index]` is the pivot's page id -- an index that
/// names another sheet, or none, is not.
#[test]
fn the_page_fold_matches_the_page_by_sheet_id() {
    let meta = pure_meta();
    let conn = meta.connection_id;
    let ids = test_sheet_ids(3);
    let here = slicer_on(2, conn, "Sales.region", Some(&["East"]));
    let elsewhere = slicer_on(1, conn, "Sales.region", Some(&["East"]));
    let past_the_list = slicer_on(7, conn, "Sales.region", Some(&["East"]));
    let all = vec![here.clone(), elsewhere, past_the_list];
    let pivot = pivot_ref(new_id());

    let fold = page_model_slicers(all.iter(), &meta, ids[2], &ids, &pivot, None);
    assert_eq!(fold.apply.iter().map(|p| p.slicer_id).collect::<Vec<_>>(), vec![here.id]);
    assert!(fold.clear.is_empty());

    // The same slicers, the page moved: the id decides, not the index.
    let moved = vec![ids[0], ids[2], ids[1]];
    let fold = page_model_slicers(all.iter(), &meta, ids[2], &moved, &pivot, None);
    assert_eq!(fold.apply.len(), 1);
    assert_ne!(fold.apply[0].slicer_id, here.id, "the slicer at index 1 is on the page now");
}

/// A `none` pair moves the slicer from `apply` to `clear` for THAT pivot only;
/// `filter` and `highlight` pairs (and a pair to another pivot) keep it applying.
#[test]
fn a_none_pair_moves_the_slicer_to_the_clear_list_for_that_pivot_only() {
    let meta = pure_meta();
    let ids = test_sheet_ids(2);
    let s = slicer_on(1, meta.connection_id, "Sales.region", Some(&["East"]));
    let mine = pivot_ref(new_id());
    let other = pivot_ref(new_id());
    let interactions = pairs(&[
        (slicer_ref(s.id), mine.clone(), VisualInteractionMode::None),
        (slicer_ref(s.id), other.clone(), VisualInteractionMode::Highlight),
    ]);

    let fold = page_model_slicers([s.clone()].iter(), &meta, ids[1], &ids, &mine, Some(&interactions));
    assert!(fold.apply.is_empty(), "a none pair still applied: {fold:?}");
    assert_eq!(fold.clear.iter().map(|p| p.slicer_id).collect::<Vec<_>>(), vec![s.id]);

    let fold = page_model_slicers([s.clone()].iter(), &meta, ids[1], &ids, &other, Some(&interactions));
    assert_eq!(fold.apply.len(), 1, "a highlight pair is not a none pair");
    assert!(fold.clear.is_empty());
}

// ============================================================================
// The page fold through a REAL rebuild
// ============================================================================

/// SABOTAGE (spec): drop the `explicit(..) == none` split in
/// `page_model_slicers` -- the ignored pivot comes out filtered.
#[tokio::test]
async fn a_none_pair_keeps_its_pivot_unfolded_through_a_rebuild_while_another_pivot_folds() {
    let fx = Fx::new(1).await;
    let ignored = fx.add_bi_pivot(PAGE).await;
    let folded = fx.add_bi_pivot(PAGE).await;
    let slicer = fx.model_slicer(PAGE, "Sales.region", Some(vec!["East"]));
    fx.store_interactions(none(slicer_ref(slicer), pivot_ref(ignored)));

    fx.lay_out(ignored, &["year"], &[]).await;
    fx.lay_out(folded, &["year"], &[]).await;
    assert!(fx.unfiltered(ignored), "a pivot the slicer must not filter came out filtered: {:?}", fx.hidden_on(ignored, "region"));
    assert_eq!(fx.hidden_on(folded, "region"), Some(strings(&["North", "West"])), "the other pivot lost the fold");

    // And again through a refresh.
    crate::pivot::commands::refresh_bi_pivot_core(&fx.ctx(), ignored).await.unwrap();
    assert!(fx.unfiltered(ignored), "a refresh re-applied the ignored slicer");
}

/// The pin a PINNED slicer owns is dropped on a `none` pair; a pin nobody owns
/// (a ribbon filter's) is left alone.
#[tokio::test]
async fn a_none_pair_drops_only_the_pin_its_slicer_owns() {
    let fx = Fx::new(1).await;
    let pivot = fx.add_bi_pivot(PAGE).await;
    fx.lay_out(pivot, &["year"], &[]).await;
    let slicer = fx.model_slicer(PAGE, "Sales.region", Some(vec!["East"]));
    fx.set_level(slicer, 2);
    fx.lay_out(pivot, &["year"], &[]).await;
    assert!(
        fx.definition(pivot).engine_filters.iter().any(|ef| ef.slicer_id.as_deref() == Some(slicer.to_string().as_str())),
        "precondition: the pinned slicer's pin rides the definition"
    );
    // A pin with no slicer owner on another column.
    {
        let mut tables = fx.pivots.pivot_tables.write(&test_seed_effect()).unwrap();
        tables.get_mut(&pivot).unwrap().0.engine_filters.push(pivot_engine::EngineFilter {
            field_name: "year".to_string(),
            table: "Sales".to_string(),
            column: "year".to_string(),
            selected_items: strings(&["Y1", "Y2"]),
            level: 2,
            slicer_id: None,
        });
    }

    fx.store_interactions(none(slicer_ref(slicer), pivot_ref(pivot)));
    fx.lay_out(pivot, &["year"], &[]).await;
    let pins = fx.definition(pivot).engine_filters;
    assert!(
        !pins.iter().any(|ef| ef.slicer_id.as_deref() == Some(slicer.to_string().as_str())),
        "the ignored slicer's pin survived: {pins:?}"
    );
    assert!(pins.iter().any(|ef| ef.column == "year" && ef.slicer_id.is_none()), "the unowned pin was dropped: {pins:?}");
}

// ============================================================================
// Has-data shading
// ============================================================================

/// A slicer -> slicer `none` pair: the source no longer dims the target's
/// items. The positive control is the same page without the pair.
#[tokio::test]
async fn a_slicer_to_slicer_none_pair_leaves_the_targets_has_data_alone() {
    let fx = Fx::new(1).await;
    let region = fx.model_slicer(PAGE, "Sales.region", None);
    let year = fx.model_slicer(PAGE, "Sales.year", Some(vec!["Y2"]));
    assert_eq!(no_data(&fx.region_items(region, None).await), strings(&["West"]), "precondition: Y2 dims West");

    fx.store_interactions(none(slicer_ref(year), slicer_ref(region)));
    assert!(no_data(&fx.region_items(region, None).await).is_empty(), "an ignored slicer still dimmed the target");

    // The reverse pair does not stop year -> region.
    fx.store_interactions(none(slicer_ref(region), slicer_ref(year)));
    assert_eq!(no_data(&fx.region_items(region, None).await), strings(&["West"]));
}

fn tuple(fields: &[&str], tuples: &[&[&str]]) -> TupleFilterWire {
    TupleFilterWire { fields: strings(fields), tuples: tuples.iter().map(|t| strings(t)).collect() }
}

/// `visual_constraints`: plain filters join the constraint list; a tuple
/// filter is answered EXACTLY as the union over its tuples -- never as the
/// per-column IN projection, which would admit (West, Y1) and (North, Y2)
/// for the tuples (West, Y2) and (North, Y1) that have no rows at all.
#[tokio::test]
async fn visual_constraints_filters_narrow_and_tuples_give_the_exact_union() {
    let fx = Fx::new(1).await;
    let year = fx.model_slicer(PAGE, "Sales.year", None);
    let items = |c: SlicerVisualConstraints| {
        let fx = &fx;
        async move { no_data(&fx.region_items(year, Some(c)).await) }
    };

    // A plain filter: region West has rows only in Y1.
    let west = SlicerVisualConstraints {
        filters: vec![crate::bi::types::BiValueConstraint {
            table: "Sales".into(),
            column: "region".into(),
            values: strings(&["West"]),
        }],
        tuples: vec![],
    };
    assert_eq!(items(west).await, strings(&["Y2"]));

    // Tuples whose union is EMPTY although each column alone matches rows.
    let crossed = SlicerVisualConstraints {
        filters: vec![],
        tuples: vec![tuple(&["Sales.region", "Sales.year"], &[&["West", "Y2"], &["North", "Y1"]])],
    };
    assert_eq!(items(crossed).await, strings(&["Y1", "Y2"]), "the projection was used instead of the exact union");

    // A union: (West, Y1) or (North, Y2) -- both years have data.
    let union = SlicerVisualConstraints {
        filters: vec![],
        tuples: vec![tuple(&["Sales.region", "Sales.year"], &[&["West", "Y1"], &["North", "Y2"]])],
    };
    assert!(items(union).await.is_empty());

    // One tuple: only its year.
    let single = SlicerVisualConstraints {
        filters: vec![],
        tuples: vec![tuple(&["Sales.region", "Sales.year"], &[&["East", "Y2"]])],
    };
    assert_eq!(items(single).await, strings(&["Y1"]));

    // An empty tuple list keeps nothing.
    let nothing = SlicerVisualConstraints { filters: vec![], tuples: vec![tuple(&["Sales.region", "Sales.year"], &[])] };
    assert_eq!(items(nothing).await, strings(&["Y1", "Y2"]));
}

/// Above the cap the tuples are not applied (logged): every item has data
/// rather than one being hidden wrongly.
#[tokio::test]
async fn visual_constraints_over_the_tuple_cap_answer_every_item_has_data() {
    let fx = Fx::new(1).await;
    let year = fx.model_slicer(PAGE, "Sales.year", None);
    let names: Vec<(String, String)> =
        (0..=crate::slicer::commands::SLICER_TUPLE_HAS_DATA_CAP).map(|i| (format!("Nowhere{i}"), format!("Y{}", 100 + i))).collect();
    let over = SlicerVisualConstraints {
        filters: vec![],
        tuples: vec![TupleFilterWire {
            fields: strings(&["Sales.region", "Sales.year"]),
            tuples: names.iter().map(|(r, y)| vec![r.clone(), y.clone()]).collect(),
        }],
    };
    assert!(no_data(&fx.region_items(year, Some(over.clone())).await).is_empty(), "the cap hid items");

    // Positive control: the same kind of selection UNDER the cap is applied
    // (it matches no row, so nothing has data).
    let mut under = over;
    under.tuples[0].tuples.truncate(crate::slicer::commands::SLICER_TUPLE_HAS_DATA_CAP);
    assert_eq!(no_data(&fx.region_items(year, Some(under)).await), strings(&["Y1", "Y2"]));
}

// ============================================================================
// DC-9: the re-fold, one undo step, all or nothing
// ============================================================================

/// Two pivots on a page filtered by one model slicer.
async fn filtered_page() -> (Fx, EntityId, EntityId, EntityId) {
    let fx = Fx::new(1).await;
    let pv = fx.add_bi_pivot(PAGE).await;
    let other = fx.add_bi_pivot(PAGE).await;
    fx.lay_out(pv, &["year"], &[]).await;
    fx.lay_out(other, &["year"], &[]).await;
    let slicer = fx.model_slicer(PAGE, "Sales.region", Some(vec!["East"]));
    fx.lay_out(pv, &["year"], &[]).await;
    fx.lay_out(other, &["year"], &[]).await;
    assert_eq!(fx.hidden_on(pv, "region"), Some(strings(&["North", "West"])), "precondition: the page fold filters PV");
    (fx, pv, other, slicer)
}

/// Setting S -> PV to `none` through `set_canvas_layout` leaves PV's real view
/// unfiltered -- no hidden items, no pin -- in ONE undo step with the layout;
/// the neighbour stays filtered. Undo restores the pair AND the fold; redo
/// re-applies both.
#[tokio::test]
async fn a_none_pair_set_through_the_layout_door_refolds_in_one_step_and_undo_restores_both() {
    let (fx, pv, other, slicer) = filtered_page().await;
    let depth = fx.undo_depth();

    let done = fx.set_interactions(none(slicer_ref(slicer), pivot_ref(pv))).await.expect("the pair is set");
    assert_eq!(done.refreshed, vec![pv], "only the paired pivot is re-folded");
    assert!(fx.unfiltered(pv), "PV still filtered: {:?}", fx.hidden_on(pv, "region"));
    assert!(fx.definition(pv).engine_filters.iter().all(|ef| ef.slicer_id.is_none()));
    assert_eq!(fx.hidden_on(other, "region"), Some(strings(&["North", "West"])), "the neighbour was touched");
    assert_eq!(fx.undo_depth(), depth + 1, "the layout and the re-fold are ONE step");
    assert_eq!(fx.top_description().as_deref(), Some(crate::sheets::CHANGE_VISUAL_INTERACTION));
    assert!(!fx.open_transaction(), "the door left its step open");

    fx.undo_once();
    assert!(fx.interactions().is_default(), "undo did not take the pair back");
    assert_eq!(fx.hidden_on(pv, "region"), Some(strings(&["North", "West"])), "undo did not restore the fold");

    fx.redo_once();
    assert_eq!(fx.interactions(), none(slicer_ref(slicer), pivot_ref(pv)));
    assert!(fx.unfiltered(pv), "redo did not re-apply the unfold");

    // Back to `filter` (the pair removed) re-folds again, one more step.
    let done = fx.set_interactions(CanvasInteractions::default()).await.unwrap();
    assert_eq!(done.refreshed, vec![pv]);
    assert_eq!(fx.hidden_on(pv, "region"), Some(strings(&["North", "West"])), "moving FROM none did not re-fold");
}

/// The MCP / script door: `object_bindings` `setLiteral` of the page's
/// `/interactions` takes the same door -- the pivot is re-folded in the same
/// step and the answer names the pivot domain.
#[tokio::test]
async fn the_object_bindings_interactions_literal_refolds_through_the_same_door() {
    let (fx, pv, other, slicer) = filtered_page().await;
    let depth = fx.undo_depth();
    let cx = fx.binding_cx();
    let request: crate::api_types::ObjectBindingsRequest = serde_json::from_value(serde_json::json!({
        "op": "setLiteral",
        "object": { "kind": "canvasPage", "id": fx.page_sheet_id() },
        "path": "/interactions",
        "value": { "pairs": [{
            "source": { "kind": "slicer", "id": slicer.to_string() },
            "target": { "kind": "pivot", "id": pv.to_string() },
            "mode": "none"
        }] },
        "source": { "kind": "ai", "tool": "set_object_property" }
    }))
    .expect("the request deserializes");
    let handled = crate::object_bindings::handle_request_async(&cx, &fx.bi, request).await.expect("written");
    assert_eq!(handled.refreshed_pivots, vec![pv]);
    match &handled.response {
        crate::api_types::ObjectBindingsResponse::LiteralSet { domains } => {
            assert!(domains.iter().any(|d| d == "sheets") && domains.iter().any(|d| d == "pivot"), "{domains:?}");
        }
        other => panic!("unexpected answer {other:?}"),
    }
    assert!(handled.layout.is_some(), "the layout change is announced");
    assert!(fx.unfiltered(pv));
    assert_eq!(fx.hidden_on(other, "region"), Some(strings(&["North", "West"])));
    assert_eq!(fx.undo_depth(), depth + 1, "ONE step through this door too");

    fx.undo_once();
    assert!(fx.interactions().is_default());
    assert_eq!(fx.hidden_on(pv, "region"), Some(strings(&["North", "West"])));
}

/// A dropped connection is refused BEFORE anything is written: the layout is
/// unchanged, no step is recorded, and a clean document stays clean.
#[tokio::test]
async fn a_dropped_connection_refuses_the_change_and_leaves_a_clean_document_clean() {
    let (fx, pv, _other, slicer) = filtered_page().await;
    crate::document_effect::mark_saved(&fx.file);
    let depth = fx.undo_depth();
    let removed = fx.bi.connections.lock().unwrap().remove(&fx.conn);
    assert!(removed.is_some());

    let err = fx.set_interactions(none(slicer_ref(slicer), pivot_ref(pv))).await.expect_err("refused");
    assert!(err.starts_with("The interaction was not changed: PivotTable '"), "{err}");
    assert!(fx.interactions().is_default(), "the layout changed");
    assert_eq!(fx.hidden_on(pv, "region"), Some(strings(&["North", "West"])), "the pivot changed");
    assert_eq!(fx.undo_depth(), depth, "a refusal recorded a step");
    assert!(!fx.file.is_dirty(), "a refusal dirtied a clean document");
    assert!(!fx.open_transaction());
}

/// A refresh that fails AFTER an earlier pivot was re-folded takes back the
/// whole step: the layout and that pivot. Nothing is left on the stack.
#[tokio::test]
async fn a_refresh_failure_part_way_takes_back_the_layout_and_every_pivot_already_refolded() {
    let (fx, pv, other, slicer) = filtered_page().await;
    let depth = fx.undo_depth();
    let both = pairs(&[
        (slicer_ref(slicer), pivot_ref(pv), VisualInteractionMode::None),
        (slicer_ref(slicer), pivot_ref(other), VisualInteractionMode::None),
    ]);

    crate::sheets::FAIL_REFOLD_AT_FOR_TEST.with(|f| f.set(Some(1)));
    let result = fx.set_interactions(both).await;
    crate::sheets::FAIL_REFOLD_AT_FOR_TEST.with(|f| f.set(None));
    let err = result.expect_err("the second refresh failed");
    assert!(err.starts_with("The interaction was not changed: PivotTable '"), "{err}");

    assert!(fx.interactions().is_default(), "the layout survived the failed re-fold");
    assert_eq!(fx.hidden_on(pv, "region"), Some(strings(&["North", "West"])), "the first pivot's re-fold survived");
    assert_eq!(fx.hidden_on(other, "region"), Some(strings(&["North", "West"])));
    assert_eq!(fx.undo_depth(), depth, "a failed change left a step");
    assert!(!fx.open_transaction(), "the door left its step open");
}

/// Inside a caller's open step (a granted macro run, a script batch) the door
/// JOINS it and commits nothing: the caller's commit makes one step of all.
#[tokio::test]
async fn the_door_joins_a_callers_open_step() {
    let (fx, pv, _other, slicer) = filtered_page().await;
    let depth = fx.undo_depth();
    fx.begin("Run macro");
    fx.set_interactions(none(slicer_ref(slicer), pivot_ref(pv))).await.unwrap();
    assert!(fx.open_transaction(), "the door closed the caller's step");
    assert_eq!(fx.undo_depth(), depth, "nothing was committed yet");
    fx.commit();
    assert_eq!(fx.undo_depth(), depth + 1);
    assert_eq!(fx.top_description().as_deref(), Some("Run macro"));
    fx.undo_once();
    assert!(fx.interactions().is_default());
    assert_eq!(fx.hidden_on(pv, "region"), Some(strings(&["North", "West"])));
}

/// A pair between a slicer and a CHART (or two slicers) re-folds nothing: the
/// pivots' definitions are untouched, and the step is the layout's alone.
#[tokio::test]
async fn a_slicer_to_chart_pair_refreshes_nothing() {
    let (fx, pv, other, slicer) = filtered_page().await;
    let json = |p: EntityId| serde_json::to_value(fx.definition(p)).unwrap();
    let before = (json(pv), json(other));
    let depth = fx.undo_depth();
    let done = fx.set_interactions(none(slicer_ref(slicer), chart_ref("chart-1"))).await.unwrap();
    assert!(done.refreshed.is_empty(), "a chart pair re-folded {:?}", done.refreshed);
    assert_eq!(json(pv), before.0, "a pivot was re-folded");
    assert_eq!(json(other), before.1, "a pivot was re-folded");
    assert_eq!(fx.undo_depth(), depth + 1, "the layout change is still its own step");
}
