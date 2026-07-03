//! FILENAME: core/calcula-format/src/features/ribbon_filter_tests.rs
//! PURPOSE: Tests for ribbon filter persistence roundtrip.

#[cfg(test)]
mod tests {
    use crate::features::ribbon_filters::*;
    use identity::EntityId;
    use persistence::*;

    /// Helper to mint a fresh EntityId for tests.
    fn mint_id() -> EntityId {
        EntityId::from_bytes(identity::generate_uuid_v7())
    }

    fn make_test_saved_filter() -> SavedRibbonFilter {
        SavedRibbonFilter {
            id: mint_id(),
            name: "City Filter".to_string(),
            connection_id: mint_id(),
            data_source_id: Some("pkg-ds-1".to_string()),
            field_name: "dim_customer.city".to_string(),
            field_data_type: "unknown".to_string(),
            connection_mode: SavedConnectionMode::BySheet,
            connected_pivots: vec![mint_id(), mint_id()],
            connected_sheets: vec![0, 2],
            display_mode: SavedRibbonFilterDisplayMode::Checklist,
            selected_items: Some(vec!["New York".to_string(), "London".to_string()]),
            cross_filter_targets: vec![],
            cross_filter_slicer_targets: vec![],
            advanced_filter: None,
            hide_no_data: false,
            indicate_no_data: true,
            sort_no_data_last: true,
            show_select_all: false,
            single_select: false,
            order: 5,
            button_columns: 3,
            button_rows: 4,
        }
    }

    fn make_minimal_saved_filter() -> SavedRibbonFilter {
        SavedRibbonFilter {
            id: mint_id(),
            name: "minimal".to_string(),
            connection_id: mint_id(),
            data_source_id: None,
            field_name: "t.col".to_string(),
            field_data_type: "unknown".to_string(),
            connection_mode: SavedConnectionMode::Manual,
            connected_pivots: vec![],
            connected_sheets: vec![],
            display_mode: SavedRibbonFilterDisplayMode::Checklist,
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

    #[test]
    fn test_saved_to_def_roundtrip() {
        let saved = make_test_saved_filter();
        let def = RibbonFilterDef::from(&saved);

        // Check conversion to def
        assert_eq!(def.id, saved.id);
        assert_eq!(def.name, "City Filter");
        assert_eq!(def.connection_id, saved.connection_id);
        assert_eq!(def.field_name, "dim_customer.city");
        assert_eq!(def.connection_mode, "bySheet");
        assert_eq!(def.connected_sheets, vec![0, 2]);
        assert_eq!(def.connected_pivots, saved.connected_pivots);
        assert_eq!(def.display_mode, "checklist");
        assert_eq!(def.selected_items.as_ref().unwrap().len(), 2);
        assert!(def.cross_filter_targets.is_empty());
        assert_eq!(def.order, 5);
        assert_eq!(def.button_columns, 3);
        assert_eq!(def.button_rows, 4);

        // Convert back to saved
        let back = SavedRibbonFilter::from(&def);
        assert_eq!(back.id, saved.id);
        assert_eq!(back.name, saved.name);
        assert_eq!(back.field_name, saved.field_name);
        assert_eq!(back.connection_id, saved.connection_id);
        assert_eq!(back.data_source_id, saved.data_source_id);
        assert_eq!(back.connected_sheets, saved.connected_sheets);
        assert_eq!(back.connected_pivots, saved.connected_pivots);
        assert_eq!(back.selected_items, saved.selected_items);
        assert_eq!(back.order, saved.order);
        assert_eq!(back.button_columns, saved.button_columns);
    }

    #[test]
    fn test_connection_mode_roundtrip_all_variants() {
        let modes = vec![
            (SavedConnectionMode::Manual, "manual"),
            (SavedConnectionMode::BySheet, "bySheet"),
            (SavedConnectionMode::Workbook, "workbook"),
        ];

        for (mode, expected_str) in modes {
            let mut saved = make_minimal_saved_filter();
            saved.connection_mode = mode;

            let def = RibbonFilterDef::from(&saved);
            assert_eq!(def.connection_mode, expected_str);

            let back = SavedRibbonFilter::from(&def);
            // Verify roundtrip by converting back to def again
            let def2 = RibbonFilterDef::from(&back);
            assert_eq!(def2.connection_mode, expected_str);
        }
    }

    #[test]
    fn test_display_mode_roundtrip_all_variants() {
        let modes = vec![
            (SavedRibbonFilterDisplayMode::Checklist, "checklist"),
            (SavedRibbonFilterDisplayMode::Buttons, "buttons"),
            (SavedRibbonFilterDisplayMode::Dropdown, "dropdown"),
        ];

        for (mode, expected_str) in modes {
            let mut saved = make_minimal_saved_filter();
            saved.display_mode = mode;

            let def = RibbonFilterDef::from(&saved);
            assert_eq!(def.display_mode, expected_str);
        }
    }

    #[test]
    fn test_json_roundtrip() {
        let saved = make_test_saved_filter();
        let def = RibbonFilterDef::from(&saved);

        // Serialize to JSON
        let json = serde_json::to_string_pretty(&def).unwrap();
        // The connection reference must be present in camelCase
        assert!(json.contains("\"connectionId\""));

        // Deserialize back
        let def_back: RibbonFilterDef = serde_json::from_str(&json).unwrap();

        // Convert to saved
        let saved_back = SavedRibbonFilter::from(&def_back);
        assert_eq!(saved_back.id, saved.id);
        assert_eq!(saved_back.name, saved.name);
        assert_eq!(saved_back.field_name, saved.field_name);
        assert_eq!(saved_back.connection_id, saved.connection_id);
        assert_eq!(saved_back.connected_sheets, saved.connected_sheets);
        assert_eq!(saved_back.connected_pivots, saved.connected_pivots);
    }

    #[test]
    fn test_empty_optional_fields_not_in_json() {
        let saved = make_minimal_saved_filter();

        let def = RibbonFilterDef::from(&saved);
        let json = serde_json::to_string(&def).unwrap();

        // Empty vecs should be skipped
        assert!(!json.contains("\"connectedPivots\""));
        assert!(!json.contains("\"connectedSheets\""));
        // Null selectedItems should be skipped
        assert!(!json.contains("\"selectedItems\""));
    }
}
