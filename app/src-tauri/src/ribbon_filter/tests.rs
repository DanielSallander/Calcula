//! FILENAME: app/src-tauri/src/ribbon_filter/tests.rs
//! PURPOSE: Unit tests for ribbon filter types, state, and CRUD logic.

#[cfg(test)]
mod tests {
    use crate::ribbon_filter::types::*;
    use identity::EntityId;

    /// Seed the filter store directly. Not a document edit: these tests drive the
    /// store, not the commands, and nothing is saved afterwards.
    fn seed() -> crate::document_effect::DocumentEffect {
        crate::document_effect::DocumentEffect::deliberately_clean(
            crate::document_effect::CleanReason::LoadingFromDisk,
        )
    }

    /// Helper to mint a fresh EntityId for tests.
    fn mint_id() -> EntityId {
        EntityId::from_bytes(identity::generate_uuid_v7())
    }

    /// Helper: a filter with the given connection and defaults everywhere else.
    fn make_filter(id: EntityId, connection_id: EntityId, name: &str) -> RibbonFilter {
        RibbonFilter {
            id,
            name: name.to_string(),
            connection_id,
            data_source_id: None,
            field_name: "dim_customer.city".to_string(),
            field_data_type: "text".to_string(),
            connection_mode: ConnectionMode::Workbook,
            connected_pivots: vec![],
            connected_sheets: vec![],
            connected_visuals: vec![],
            display_mode: RibbonFilterDisplayMode::Checklist,
            selected_items: None,
            dependent_filters: vec![],
            dependent_slicers: vec![],
            advanced_filter: None,
            hide_no_data: false,
            indicate_no_data: true,
            sort_no_data_last: true,
            show_select_all: false,
            single_select: false,
            order: 0,
            button_columns: 2,
            button_rows: 0,
            filter_level: 1,
        }
    }

    // ========================================================================
    // Type serialization tests
    // ========================================================================

    #[test]
    fn test_connection_mode_serde_roundtrip() {
        let modes = vec![ConnectionMode::Manual, ConnectionMode::BySheet, ConnectionMode::Workbook];
        for mode in modes {
            let json = serde_json::to_string(&mode).unwrap();
            let deserialized: ConnectionMode = serde_json::from_str(&json).unwrap();
            assert_eq!(mode, deserialized);
        }
    }

    #[test]
    fn test_connection_mode_camel_case() {
        assert_eq!(serde_json::to_string(&ConnectionMode::Manual).unwrap(), "\"manual\"");
        assert_eq!(serde_json::to_string(&ConnectionMode::BySheet).unwrap(), "\"bySheet\"");
        assert_eq!(serde_json::to_string(&ConnectionMode::Workbook).unwrap(), "\"workbook\"");
    }

    #[test]
    fn test_display_mode_serde_roundtrip() {
        let modes = vec![
            RibbonFilterDisplayMode::Checklist,
            RibbonFilterDisplayMode::Buttons,
            RibbonFilterDisplayMode::Dropdown,
        ];
        for mode in modes {
            let json = serde_json::to_string(&mode).unwrap();
            let deserialized: RibbonFilterDisplayMode = serde_json::from_str(&json).unwrap();
            assert_eq!(mode, deserialized);
        }
    }

    #[test]
    fn test_ribbon_filter_serde_roundtrip() {
        let filter_id = mint_id();
        let connection_id = mint_id();
        let pivot_id = mint_id();
        let mut filter = make_filter(filter_id, connection_id, "Test Filter");
        filter.connection_mode = ConnectionMode::Manual;
        filter.connected_pivots = vec![pivot_id];
        filter.connected_sheets = vec![0, 2];
        filter.selected_items = Some(vec!["New York".to_string(), "London".to_string()]);
        filter.order = 3;

        let json = serde_json::to_string(&filter).unwrap();
        let deserialized: RibbonFilter = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.id, filter_id);
        assert_eq!(deserialized.name, "Test Filter");
        assert_eq!(deserialized.connection_id, connection_id);
        assert_eq!(deserialized.field_name, "dim_customer.city");
        assert_eq!(deserialized.connection_mode, ConnectionMode::Manual);
        assert_eq!(deserialized.connected_pivots, vec![pivot_id]);
        assert_eq!(deserialized.connected_sheets, vec![0, 2]);
        assert_eq!(deserialized.selected_items.as_ref().unwrap().len(), 2);
    }

    #[test]
    fn test_ribbon_filter_camel_case_field_names() {
        let mut filter = make_filter(mint_id(), mint_id(), "f");
        filter.connected_pivots = vec![mint_id()];

        let json = serde_json::to_string(&filter).unwrap();
        // Verify camelCase field names
        assert!(json.contains("\"connectionId\""));
        assert!(json.contains("\"connectedPivots\""));
        assert!(json.contains("\"fieldName\""));
        assert!(json.contains("\"connectionMode\""));
        assert!(json.contains("\"displayMode\""));
        assert!(json.contains("\"selectedItems\""));
        assert!(json.contains("\"buttonColumns\""));
        assert!(json.contains("\"buttonRows\""));
        // Should NOT contain snake_case or removed fields
        assert!(!json.contains("\"connection_id\""));
        assert!(!json.contains("\"connected_pivots\""));
        assert!(!json.contains("\"field_name\""));
        assert!(!json.contains("\"sourceType\""));
        assert!(!json.contains("\"cacheSourceId\""));
    }

    // ========================================================================
    // State management tests
    // ========================================================================

    #[test]
    fn test_ribbon_filter_state_new() {
        let state = RibbonFilterState::new();
        let filters = state.filters.read().unwrap();
        assert!(filters.is_empty());
    }

    #[test]
    fn test_ribbon_filter_state_crud() {
        let state = RibbonFilterState::new();

        // Create
        let id = mint_id();
        {
            let mut filter = make_filter(id, mint_id(), "Region");
            filter.field_name = "Sales.Region".to_string();
            filter.connection_mode = ConnectionMode::Manual;
            state.filters.write(&seed()).unwrap().insert(id, filter);
        }

        // Read
        {
            let filters = state.filters.read().unwrap();
            assert_eq!(filters.len(), 1);
            let f = filters.get(&id).unwrap();
            assert_eq!(f.name, "Region");
            assert!(f.selected_items.is_none());
        }

        // Update selection
        {
            let mut filters = state.filters.write(&seed()).unwrap();
            let f = filters.get_mut(&id).unwrap();
            f.selected_items = Some(vec!["North".to_string(), "South".to_string()]);
        }
        {
            let filters = state.filters.read().unwrap();
            let f = filters.get(&id).unwrap();
            assert_eq!(f.selected_items.as_ref().unwrap().len(), 2);
        }

        // Clear
        {
            let mut filters = state.filters.write(&seed()).unwrap();
            let f = filters.get_mut(&id).unwrap();
            f.selected_items = None;
            assert!(f.selected_items.is_none());
        }

        // Delete
        {
            let mut filters = state.filters.write(&seed()).unwrap();
            filters.remove(&id);
            assert!(filters.is_empty());
        }
    }

    #[test]
    fn test_ribbon_filter_state_multiple_filters() {
        let state = RibbonFilterState::new();

        for i in 0..5 {
            let id = mint_id();
            let mut filter = make_filter(id, mint_id(), &format!("Filter{}", i));
            filter.field_name = format!("t.field{}", i);
            filter.order = i as u32;
            state.filters.write(&seed()).unwrap().insert(id, filter);
        }

        let filters = state.filters.read().unwrap();
        assert_eq!(filters.len(), 5);
    }

    #[test]
    fn test_filters_keep_their_own_connection() {
        // Two filters on two different model connections must not
        // share or mix connection ids.
        let state = RibbonFilterState::new();
        let conn_a = mint_id();
        let conn_b = mint_id();
        let id_a = mint_id();
        let id_b = mint_id();
        state.filters.write(&seed()).unwrap().insert(id_a, make_filter(id_a, conn_a, "A"));
        state.filters.write(&seed()).unwrap().insert(id_b, make_filter(id_b, conn_b, "B"));

        let filters = state.filters.read().unwrap();
        assert_eq!(filters.get(&id_a).unwrap().connection_id, conn_a);
        assert_eq!(filters.get(&id_b).unwrap().connection_id, conn_b);
        assert_ne!(
            filters.get(&id_a).unwrap().connection_id,
            filters.get(&id_b).unwrap().connection_id
        );
    }

    #[test]
    fn test_remap_ribbon_filter_connections() {
        // Package-pulled connections mint a new uuid each pull; filters with a
        // stable data_source_id re-bind, filters without one stay untouched.
        let state = RibbonFilterState::new();
        let old_conn = mint_id();
        let id_pkg = mint_id();
        let id_local = mint_id();
        let mut pkg_filter = make_filter(id_pkg, old_conn, "pkg");
        pkg_filter.data_source_id = Some("ds-1".to_string());
        let local_filter = make_filter(id_local, old_conn, "local");
        state.filters.write(&seed()).unwrap().insert(id_pkg, pkg_filter);
        state.filters.write(&seed()).unwrap().insert(id_local, local_filter);

        let new_conn = mint_id();
        let mut ds_to_conn = std::collections::HashMap::new();
        ds_to_conn.insert("ds-1".to_string(), new_conn);
        crate::ribbon_filter::commands::remap_ribbon_filter_connections(&state, &seed(), &ds_to_conn);

        let filters = state.filters.read().unwrap();
        assert_eq!(filters.get(&id_pkg).unwrap().connection_id, new_conn);
        assert_eq!(filters.get(&id_local).unwrap().connection_id, old_conn);
    }

    #[test]
    fn test_connection_mode_update() {
        let state = RibbonFilterState::new();
        let id = mint_id();
        let mut filter = make_filter(id, mint_id(), "test");
        filter.field_name = "dim.col".to_string();
        filter.connection_mode = ConnectionMode::Manual;
        state.filters.write(&seed()).unwrap().insert(id, filter);

        // Switch to bySheet
        {
            let mut filters = state.filters.write(&seed()).unwrap();
            let f = filters.get_mut(&id).unwrap();
            f.connection_mode = ConnectionMode::BySheet;
            f.connected_sheets = vec![0, 1];
        }

        let filters = state.filters.read().unwrap();
        let f = filters.get(&id).unwrap();
        assert_eq!(f.connection_mode, ConnectionMode::BySheet);
        assert_eq!(f.connected_sheets, vec![0, 1]);
    }

    // -----------------------------------------------------------------------
    // P4 S4a: "Selected visuals" (`connected_visuals`)
    // -----------------------------------------------------------------------

    fn visual(kind: &str, id: &str) -> persistence::CanvasObjectRef {
        persistence::CanvasObjectRef { kind: kind.to_string(), id: id.to_string() }
    }

    /// The live -> saved -> live mapping carries the list both ways. SABOTAGE:
    /// drop `connected_visuals` from either mapping -- the round-trip fails.
    #[test]
    fn connected_visuals_round_trip_through_the_save_mapping() {
        let mut filter = make_filter(mint_id(), mint_id(), "Region");
        filter.connection_mode = ConnectionMode::Manual;
        filter.connected_visuals = vec![visual("chart", "c1"), visual("slicer", "s2")];

        let saved = crate::persistence::ribbon_filter_to_saved(&filter);
        assert_eq!(saved.connected_visuals, filter.connected_visuals, "the save mapping carries the list");
        let back = crate::persistence::saved_to_ribbon_filter(&saved);
        assert_eq!(back.connected_visuals, filter.connected_visuals, "the load mapping carries it back");

        // On the wire it is camelCase, and absent while empty.
        let json = serde_json::to_string(&filter).unwrap();
        assert!(json.contains("\"connectedVisuals\""), "{json}");
        filter.connected_visuals.clear();
        assert!(!serde_json::to_string(&filter).unwrap().contains("connectedVisuals"));
    }

    #[test]
    fn connected_visuals_are_normalized_or_refused_by_name() {
        let kept = normalize_connected_visuals(&[visual(" chart", "c1 "), visual("chart", "c1"), visual("pivot", "p1")])
            .expect("padding and a duplicate are normalized, not refused");
        assert_eq!(kept, vec![visual("chart", "c1"), visual("pivot", "p1")]);

        let err = normalize_connected_visuals(&[visual("shape", "x")]).expect_err("a shape is not a visual target");
        assert!(err.contains("'shape'"), "the refusal names the kind: {err}");
        assert!(normalize_connected_visuals(&[visual("chart", " ")]).is_err(), "a blank id is refused");
        let over: Vec<_> =
            (0..=persistence::CANVAS_MAX_OBJECT_REFS).map(|i| visual("chart", &i.to_string())).collect();
        assert!(normalize_connected_visuals(&over).is_err(), "an over-cap list is refused");
    }

    /// The save prune (P4 DC-2): a pair or a "Selected visuals" ref naming an
    /// object that no longer exists is not written; live ones are. A pair is
    /// live only when BOTH ends are on ITS OWN canvas. The prune touches the
    /// workbook being saved, never the live stores.
    ///
    /// SABOTAGE: make `prune_dead_visual_refs_for_save` return at once -- the
    /// dangling pair and the dead ref are written.
    #[test]
    fn a_save_writes_live_visual_refs_and_drops_dead_ones() {
        use crate::api_types::{ObjectBindingKind, ObjectBindingRef};
        use crate::object_bindings::object_json::ObjectLocation;
        use persistence::{CanvasInteraction, CanvasInteractions, CanvasLayout, SheetKind, VisualInteractionMode};

        let mut workbook = persistence::Workbook::new();
        let mut page = persistence::Sheet::new("Page 1".to_string());
        let mut other = persistence::Sheet::new("Page 2".to_string());
        let pair = |s: (&str, &str), t: (&str, &str)| CanvasInteraction {
            source: visual(s.0, s.1),
            target: visual(t.0, t.1),
            mode: VisualInteractionMode::None,
        };
        page.kind = SheetKind::Canvas(CanvasLayout {
            interactions: CanvasInteractions {
                default_mode: Some(VisualInteractionMode::Filter),
                pairs: vec![
                    pair(("slicer", "s1"), ("chart", "c1")),   // live: both on this page
                    pair(("slicer", "s1"), ("chart", "gone")), // dangling target
                    pair(("slicer", "s1"), ("chart", "c2")),   // c2 lives on the OTHER page
                ],
            },
            ..Default::default()
        });
        other.kind = SheetKind::Canvas(CanvasLayout::default());
        let (page_id, other_id) = (page.id, other.id);
        workbook.sheets = vec![page, other];

        let mut filter = make_filter(mint_id(), mint_id(), "Region");
        filter.connection_mode = ConnectionMode::Manual;
        filter.connected_visuals = vec![visual("chart", "c2"), visual("chart", "gone")];
        workbook.ribbon_filters = vec![crate::persistence::ribbon_filter_to_saved(&filter)];

        let at = |kind: ObjectBindingKind, id: &str, sheet_index: usize, sheet_id: identity::SheetId| {
            (
                ObjectBindingRef { kind, id: id.to_string() },
                ObjectLocation { sheet_index, sheet_id, sheet_name: String::new(), name: id.to_string() },
            )
        };
        let locations = vec![
            at(ObjectBindingKind::Slicer, "s1", 0, page_id),
            at(ObjectBindingKind::Chart, "c1", 0, page_id),
            at(ObjectBindingKind::Chart, "c2", 1, other_id),
            // A canvas page itself is not an interaction-capable object.
            at(ObjectBindingKind::CanvasPage, &page_id.to_string(), 0, page_id),
        ];
        crate::persistence::prune_dead_visual_refs_for_save(&mut workbook, &locations);

        let SheetKind::Canvas(layout) = &workbook.sheets[0].kind else { panic!("fixture: page 1 is a canvas") };
        assert_eq!(
            layout.interactions.pairs,
            vec![pair(("slicer", "s1"), ("chart", "c1"))],
            "only the pair whose both ends are on this page is written"
        );
        assert_eq!(
            layout.interactions.default_mode,
            Some(VisualInteractionMode::Filter),
            "the page default is kept"
        );
        assert_eq!(
            workbook.ribbon_filters[0].connected_visuals,
            vec![visual("chart", "c2")],
            "a ribbon filter keeps a live visual on any page and drops a dead one"
        );
    }

    /// The prune runs in BOTH save assemblies, after the ribbon filters are in
    /// the workbook (a prune before `collect_ribbon_filters_for_save` would
    /// prune nothing), from the ONE hoisted live-object walk. Source census.
    /// SABOTAGE: move the `.cala` prune call above
    /// `collect_ribbon_filters_for_save` -- the order assertion fails.
    #[test]
    fn both_save_assemblies_prune_after_the_ribbon_filters_are_collected() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let strip = |src: String| -> String {
            src.replace("\r\n", "\n")
                .lines()
                .map(|l| match l.find("//") {
                    Some(i) => &l[..i],
                    None => l,
                })
                .collect::<Vec<_>>()
                .join("\n")
        };
        // The .cala save: the hoisted walk, then (inside the SAME function) the
        // ribbon filters collected, then the prune. Searched from the walk on:
        // build_workbook_for_save_with_slicers (the .calp carrier's collector)
        // collects the ribbon filters too, earlier in the file.
        let cala = strip(std::fs::read_to_string(root.join("persistence.rs")).unwrap());
        let walk = cala.find("let live_locations = {").expect("the .cala save hoists the walk");
        let after = &cala[walk..];
        let collect = after
            .find("workbook.ribbon_filters = collect_ribbon_filters_for_save(")
            .expect("the .cala save collects the ribbon filters after the walk");
        let prune = after
            .find("prune_dead_visual_refs_for_save(&mut workbook, &live_locations)")
            .expect("the .cala save prunes the visual refs");
        assert!(collect < prune, "the .cala prune must follow the ribbon-filter collect");

        // The .calp carrier: its collector (ribbon filters included) runs first.
        let calp = strip(std::fs::read_to_string(root.join("calp_commands.rs")).unwrap());
        let built = calp
            .find("build_workbook_for_save_with_slicers(")
            .expect("the .calp carrier is built by the shared collector");
        let walk = calp.find("let live_locations = {").expect("the .calp carrier hoists the walk");
        let prune = calp
            .find("crate::persistence::prune_dead_visual_refs_for_save(&mut workbook, &live_locations)")
            .expect("the .calp carrier prunes the visual refs");
        assert!(built < prune, "the .calp prune must follow the collector");
        assert!(walk < prune, "the .calp prune uses the hoisted walk");
    }
}
