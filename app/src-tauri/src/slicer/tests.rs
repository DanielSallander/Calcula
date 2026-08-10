//! FILENAME: app/src-tauri/src/slicer/tests.rs
//! PURPOSE: Unit tests for slicer types and new API commands.

#[cfg(test)]
mod tests {
    use crate::slicer::types::*;
    use identity::EntityId;

    /// Helper to mint a fresh EntityId for tests.
    fn mint_id() -> EntityId {
        EntityId::from_bytes(identity::generate_uuid_v7())
    }

    // ========================================================================
    // Source type serialization
    // ========================================================================

    #[test]
    fn test_source_type_serde() {
        assert_eq!(serde_json::to_string(&SlicerSourceType::Table).unwrap(), "\"table\"");
        assert_eq!(serde_json::to_string(&SlicerSourceType::Pivot).unwrap(), "\"pivot\"");
        assert_eq!(serde_json::to_string(&SlicerSourceType::BiConnection).unwrap(), "\"biConnection\"");
    }

    #[test]
    fn test_source_type_deserialize() {
        let t: SlicerSourceType = serde_json::from_str("\"table\"").unwrap();
        assert_eq!(t, SlicerSourceType::Table);
        let p: SlicerSourceType = serde_json::from_str("\"pivot\"").unwrap();
        assert_eq!(p, SlicerSourceType::Pivot);
        let b: SlicerSourceType = serde_json::from_str("\"biConnection\"").unwrap();
        assert_eq!(b, SlicerSourceType::BiConnection);
    }

    // ========================================================================
    // Connection serialization
    // ========================================================================

    #[test]
    fn test_slicer_connection_serde() {
        let src_id = mint_id();
        let conn = SlicerConnection {
            source_type: SlicerSourceType::BiConnection,
            source_id: src_id,
        };
        let json = serde_json::to_string(&conn).unwrap();
        assert!(json.contains("\"sourceType\""));
        assert!(json.contains("\"biConnection\""));
        assert!(json.contains("\"sourceId\""));

        let back: SlicerConnection = serde_json::from_str(&json).unwrap();
        assert_eq!(back.source_type, SlicerSourceType::BiConnection);
        assert_eq!(back.source_id, src_id);
    }

    // ========================================================================
    // Slicer state tests
    // ========================================================================

    #[test]
    fn test_slicer_state_new() {
        let state = SlicerState::new();
        let slicers = state.slicers.read().unwrap();
        assert!(slicers.is_empty());
    }

    #[test]
    fn test_slicer_crud() {
        let state = SlicerState::new();
        let slicer_id = mint_id();
        let table_id = mint_id();

        // Create
        let slicer = Slicer {
            id: slicer_id,
            name: "Region".to_string(),
            header_text: None,
            sheet_index: 0,
            x: 100.0,
            y: 200.0,
            width: 180.0,
            height: 240.0,
            source_type: SlicerSourceType::Table,
            cache_source_id: table_id,
            field_name: "Region".to_string(),
            selected_items: None,
            show_header: true,
            columns: 1,
            style_preset: "SlicerStyleLight1".to_string(),
            selection_mode: SlicerSelectionMode::Standard,
            hide_no_data: false,
            indicate_no_data: true,
            sort_no_data_last: true,
            force_selection: false,
            show_select_all: false,
            arrangement: SlicerArrangement::Vertical,
            rows: 0,
            item_gap: 4.0,
            autogrid: true,
            item_padding: 0.0,
            button_radius: 2.0,
            connected_sources: vec![SlicerConnection {
                source_type: SlicerSourceType::Table,
                source_id: table_id,
            }],
        };

        state.slicers.write(&crate::document_effect::DocumentEffect::mutates(&crate::persistence::FileState::default())).unwrap().insert(slicer_id, slicer);
        assert_eq!(state.slicers.write(&crate::document_effect::DocumentEffect::mutates(&crate::persistence::FileState::default())).unwrap().len(), 1);

        // Read
        let s = state.slicers.read().unwrap().get(&slicer_id).unwrap().clone();
        assert_eq!(s.name, "Region");
        assert!(s.selected_items.is_none());

        // Update selection
        {
            let mut slicers = state.slicers.write(&crate::document_effect::DocumentEffect::mutates(&crate::persistence::FileState::default())).unwrap();
            let s = slicers.get_mut(&slicer_id).unwrap();
            s.selected_items = Some(vec!["North".to_string(), "South".to_string()]);
        }
        {
            let slicers = state.slicers.read().unwrap();
            let s = slicers.get(&slicer_id).unwrap();
            assert_eq!(s.selected_items.as_ref().unwrap().len(), 2);
        }

        // Clear filter
        {
            let mut slicers = state.slicers.write(&crate::document_effect::DocumentEffect::mutates(&crate::persistence::FileState::default())).unwrap();
            let s = slicers.get_mut(&slicer_id).unwrap();
            s.selected_items = None;
            assert!(s.selected_items.is_none());
        }

        // Delete
        {
            let mut slicers = state.slicers.write(&crate::document_effect::DocumentEffect::mutates(&crate::persistence::FileState::default())).unwrap();
            slicers.remove(&slicer_id);
            assert!(slicers.is_empty());
        }
    }

    #[test]
    fn test_slicer_bi_connection_source() {
        let slicer_id = mint_id();
        let cache_id = mint_id();
        let slicer = Slicer {
            id: slicer_id,
            name: "BI City".to_string(),
            header_text: Some("City".to_string()),
            sheet_index: 0,
            x: 0.0,
            y: 0.0,
            width: 180.0,
            height: 240.0,
            source_type: SlicerSourceType::BiConnection,
            cache_source_id: cache_id,
            field_name: "dim_customer.city".to_string(),
            selected_items: Some(vec!["London".to_string()]),
            show_header: true,
            columns: 1,
            style_preset: "SlicerStyleLight1".to_string(),
            selection_mode: SlicerSelectionMode::Standard,
            hide_no_data: false,
            indicate_no_data: true,
            sort_no_data_last: true,
            force_selection: false,
            show_select_all: false,
            arrangement: SlicerArrangement::Vertical,
            rows: 0,
            item_gap: 4.0,
            autogrid: true,
            item_padding: 0.0,
            button_radius: 2.0,
            connected_sources: vec![],
        };

        let json = serde_json::to_string(&slicer).unwrap();
        assert!(json.contains("\"biConnection\""));
        assert!(json.contains("\"dim_customer.city\""));

        let back: Slicer = serde_json::from_str(&json).unwrap();
        assert_eq!(back.source_type, SlicerSourceType::BiConnection);
        assert_eq!(back.cache_source_id, cache_id);
    }

    // ========================================================================
    // Selection mode and arrangement defaults
    // ========================================================================

    #[test]
    fn test_selection_mode_default() {
        let mode = SlicerSelectionMode::default();
        assert_eq!(mode, SlicerSelectionMode::Standard);
    }

    #[test]
    fn test_arrangement_default() {
        let arr = SlicerArrangement::default();
        assert_eq!(arr, SlicerArrangement::Vertical);
    }

    #[test]
    fn test_slicer_item_serde() {
        let item = SlicerItem {
            value: "North".to_string(),
            selected: true,
            has_data: false,
        };

        let json = serde_json::to_string(&item).unwrap();
        assert!(json.contains("\"hasData\""));
        assert!(!json.contains("\"has_data\""));

        let back: SlicerItem = serde_json::from_str(&json).unwrap();
        assert_eq!(back.value, "North");
        assert!(back.selected);
        assert!(!back.has_data);
    }
}

// ============================================================================
// RESTORE: a computed property must still be LIVE after save + reload
// ============================================================================
//
// The defect these close: `persistence::restore_slicers` put
// `slicer_state.computed_properties` back but never rebuilt
// `computed_prop_dependencies` / `computed_prop_dependents`, and
// `re_evaluate_slicer_computed_properties` is driven ENTIRELY by that reverse
// index — it looks the changed cells up there and re-evaluates nothing it does
// not find. So a reopened workbook's slicer property was restored, listed in
// the dialog with its formula, and permanently dead: editing the cell the
// formula named never moved the slicer again.
//
// Its AppState sibling (`computed_properties::restore_computed_properties`)
// rebuilt its index on the same load path all along, which is how the
// asymmetry was found. `slicer_property_and_cell_property_restore_alike` pins
// the two siblings against each other so they cannot drift apart again.
//
// These assert BEHAVIOUR (the slicer actually changes), not the presence of a
// map entry — an index rebuilt with wrong keys would satisfy the latter.
#[cfg(test)]
mod restore_tests {
    use crate::document_effect::{CleanReason, DocumentEffect};
    use crate::slicer::types::*;
    use identity::EntityId;
    use std::collections::HashMap;

    fn mint() -> EntityId {
        EntityId::from_bytes(identity::generate_uuid_v7())
    }

    /// The load-path effect every restore uses.
    fn load() -> DocumentEffect {
        DocumentEffect::deliberately_clean(CleanReason::LoadingFromDisk)
    }

    /// An AppState with one sheet whose DA1 (row 0, col 104) holds `text`.
    fn state_with_da1(text: &str) -> crate::AppState {
        let state = crate::create_app_state();
        let effect = load();
        {
            let mut grids = state.grids.write(&effect).unwrap();
            if grids.is_empty() {
                grids.push(engine::Grid::new());
            }
            grids[0].set_cell(0, 104, engine::Cell::new_text(text.to_string()));
        }
        {
            let mut names = state.sheet_names.write(&effect).unwrap();
            if names.is_empty() {
                names.push("Sheet1".to_string());
            }
        }
        state
    }

    /// The `.cala` a workbook with one slicer carrying `headerText = "=DA1"`
    /// serializes to — i.e. exactly what `restore_slicers` is handed on open.
    fn saved_workbook_with_computed_slicer(
        slicer_id: EntityId,
        prop_id: EntityId,
    ) -> ::persistence::Workbook {
        let sheet = ::persistence::Sheet::new("Sheet1".to_string());
        let sheet_id = sheet.id;
        let mut wb = ::persistence::Workbook::default();
        wb.sheets = vec![sheet];
        wb.slicers = vec![::persistence::SavedSlicer {
            id: slicer_id,
            name: "Region".to_string(),
            header_text: Some("stale".to_string()),
            sheet_id,
            x: 0.0,
            y: 0.0,
            width: 180.0,
            height: 240.0,
            source_type: ::persistence::SavedSlicerSourceType::Table,
            cache_source_id: mint(),
            field_name: "Region".to_string(),
            selected_items: None,
            show_header: true,
            columns: 1,
            style_preset: "SlicerStyleLight1".to_string(),
            selection_mode: ::persistence::SavedSlicerSelectionMode::Standard,
            hide_no_data: false,
            indicate_no_data: true,
            sort_no_data_last: true,
            force_selection: false,
            show_select_all: false,
            arrangement: ::persistence::SavedSlicerArrangement::Vertical,
            rows: 0,
            item_gap: 4.0,
            autogrid: true,
            item_padding: 0.0,
            button_radius: 4.0,
            computed_properties: vec![::persistence::SavedSlicerComputedProperty {
                id: prop_id,
                attribute: "headerText".to_string(),
                formula: "=DA1".to_string(),
            }],
            connected_sources: Vec::new(),
        }];
        wb
    }

    /// Drive the production re-evaluation exactly as the cell-edit path does.
    fn edit_da1_and_reevaluate(
        state: &crate::AppState,
        slicer_state: &SlicerState,
        new_text: &str,
    ) {
        let effect = load();
        {
            let mut grids = state.grids.write(&effect).unwrap();
            grids[0].set_cell(0, 104, engine::Cell::new_text(new_text.to_string()));
        }
        let grids = state.grids.read().unwrap();
        let names = state.sheet_names.read().unwrap();
        let row_heights: HashMap<u32, f64> = HashMap::new();
        let column_widths: HashMap<u32, f64> = HashMap::new();
        let styles = state.style_registry.read().unwrap();
        crate::slicer::computed::re_evaluate_slicer_computed_properties(
            &effect,
            &[(0, 0, 104)],
            &grids,
            &names,
            &row_heights,
            &column_widths,
            &styles,
            slicer_state,
            None,
        );
    }

    /// THE REPRODUCTION. Add `headerText "=DA1"`, save, File > New, reopen —
    /// the property comes back intact, and before the fix editing DA1 never
    /// updated the header again.
    #[test]
    fn a_restored_slicer_computed_property_still_re_evaluates() {
        let state = state_with_da1("before");
        let slicer_state = SlicerState::new();
        let slicer_id = mint();
        let wb = saved_workbook_with_computed_slicer(slicer_id, mint());

        crate::persistence::restore_slicers(&wb.slicers, &slicer_state, &wb, &state);

        // The property really was restored (a test that passes on an empty
        // store proves nothing).
        assert_eq!(
            slicer_state
                .computed_properties
                .read()
                .unwrap()
                .get(&slicer_id)
                .map(|p| p.len()),
            Some(1),
            "the computed property itself was not restored"
        );

        edit_da1_and_reevaluate(&state, &slicer_state, "after");

        assert_eq!(
            slicer_state
                .slicers
                .read()
                .unwrap()
                .get(&slicer_id)
                .unwrap()
                .header_text
                .as_deref(),
            Some("after"),
            "a reopened workbook's slicer property is restored but DEAD: editing the \
             cell its formula names no longer moves the slicer"
        );
    }

    /// The index itself, keyed the way the re-evaluation reads it. Separate
    /// from the behaviour test above so a rebuild that produces the right
    /// entries under the WRONG key is distinguishable from one that produces
    /// no entries at all.
    #[test]
    fn restore_rebuilds_the_reverse_index_under_the_cell_key() {
        let state = state_with_da1("before");
        let slicer_state = SlicerState::new();
        let prop_id = mint();
        let wb = saved_workbook_with_computed_slicer(mint(), prop_id);

        crate::persistence::restore_slicers(&wb.slicers, &slicer_state, &wb, &state);

        let rev = slicer_state.computed_prop_dependents.lock().unwrap();
        let at_da1 = rev
            .get(&(0usize, 0u32, 104u32))
            .expect("no reverse-dependency entry for the cell the formula names");
        assert!(at_da1.contains(&prop_id));

        let deps = slicer_state.computed_prop_dependencies.lock().unwrap();
        assert!(
            deps.get(&prop_id).is_some_and(|c| c.contains(&(0, 0, 104))),
            "the forward map is what removal walks to unindex a property"
        );
    }

    /// A restore REPLACES: the previous document's slicer properties and their
    /// index must not survive into the one being opened. (The index half is
    /// new — `computed_properties` was already cleared.)
    #[test]
    fn restore_clears_the_previous_documents_index() {
        let state = state_with_da1("before");
        let slicer_state = SlicerState::new();

        // Workbook A.
        let a_slicer = mint();
        let a_prop = mint();
        let wb_a = saved_workbook_with_computed_slicer(a_slicer, a_prop);
        crate::persistence::restore_slicers(&wb_a.slicers, &slicer_state, &wb_a, &state);
        assert!(!slicer_state
            .computed_prop_dependents
            .lock()
            .unwrap()
            .is_empty());

        // Workbook B carries no slicers at all.
        let wb_b = ::persistence::Workbook::default();
        crate::persistence::restore_slicers(&wb_b.slicers, &slicer_state, &wb_b, &state);

        assert!(
            slicer_state.computed_prop_dependents.lock().unwrap().is_empty(),
            "workbook A's reverse index survived into workbook B, so editing a cell in \
             B would re-evaluate a property belonging to a document that is closed"
        );
        assert!(slicer_state
            .computed_prop_dependencies
            .lock()
            .unwrap()
            .is_empty());
    }

    /// THE SIBLING PIN. The two restore paths for formula-driven properties —
    /// slicer attributes and cell/row/column attributes — must both come back
    /// LIVE. This is the comparison that found the defect; it is now a test so
    /// the next person to add a third property family has a shape to copy.
    #[test]
    fn slicer_property_and_cell_property_restore_alike() {
        let state = state_with_da1("before");
        let slicer_state = SlicerState::new();
        let wb = saved_workbook_with_computed_slicer(mint(), mint());
        crate::persistence::restore_slicers(&wb.slicers, &slicer_state, &wb, &state);

        // The AppState twin, restored from its own artifact over the same grid.
        let saved = serde_json::json!([{
            "sheetIndex": 0,
            "columns": [{
                "index": 2,
                "props": [{ "id": 1, "attribute": "fillColor", "formula": "=DA1" }]
            }],
            "rows": [],
            "cells": []
        }]);
        crate::computed_properties::restore_computed_properties(
            &state,
            Some(serde_json::to_vec(&saved).unwrap().as_slice()),
        );

        let slicer_indexed = !slicer_state
            .computed_prop_dependents
            .lock()
            .unwrap()
            .is_empty();
        let cell_indexed = !state.computed_prop_dependents.lock().unwrap().is_empty();
        assert_eq!(
            slicer_indexed, cell_indexed,
            "the two computed-property restore paths disagree about rebuilding their \
             reverse index — one of them is restoring dead properties"
        );
        assert!(slicer_indexed, "neither path rebuilt its index");
    }
}
