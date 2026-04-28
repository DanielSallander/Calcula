//! FILENAME: core/calcula-format/src/features/ribbon_filter_tests.rs
//! PURPOSE: Tests for ribbon filter persistence roundtrip.

#[cfg(test)]
mod tests {
    use crate::features::ribbon_filters::*;
    use persistence::*;

    fn make_test_saved_filter() -> SavedRibbonFilter {
        SavedRibbonFilter {
            id: 7,
            name: "City Filter".to_string(),
            source_type: SavedSlicerSourceType::BiConnection,
            cache_source_id: 3,
            field_name: "dim_customer.city".to_string(),
            connection_mode: SavedConnectionMode::BySheet,
            connected_sources: vec![
                SavedSlicerConnection {
                    source_type: SavedSlicerSourceType::Pivot,
                    source_id: 1,
                },
                SavedSlicerConnection {
                    source_type: SavedSlicerSourceType::Table,
                    source_id: 2,
                },
            ],
            connected_sheets: vec![0, 2],
            display_mode: SavedRibbonFilterDisplayMode::Checklist,
            selected_items: Some(vec!["New York".to_string(), "London".to_string()]),
            cross_filter_enabled: true,
            order: 5,
            button_columns: 3,
            button_rows: 4,
        }
    }

    #[test]
    fn test_saved_to_def_roundtrip() {
        let saved = make_test_saved_filter();
        let def = RibbonFilterDef::from(&saved);

        // Check conversion to def
        assert_eq!(def.id, 7);
        assert_eq!(def.name, "City Filter");
        assert_eq!(def.source_type, "biConnection");
        assert_eq!(def.cache_source_id, 3);
        assert_eq!(def.field_name, "dim_customer.city");
        assert_eq!(def.connection_mode, "bySheet");
        assert_eq!(def.connected_sheets, vec![0, 2]);
        assert_eq!(def.connected_sources.len(), 2);
        assert_eq!(def.connected_sources[0].source_type, "pivot");
        assert_eq!(def.connected_sources[0].source_id, 1);
        assert_eq!(def.connected_sources[1].source_type, "table");
        assert_eq!(def.display_mode, "checklist");
        assert_eq!(def.selected_items.as_ref().unwrap().len(), 2);
        assert!(def.cross_filter_enabled);
        assert_eq!(def.order, 5);
        assert_eq!(def.button_columns, 3);
        assert_eq!(def.button_rows, 4);

        // Convert back to saved
        let back = SavedRibbonFilter::from(&def);
        assert_eq!(back.id, saved.id);
        assert_eq!(back.name, saved.name);
        assert_eq!(back.field_name, saved.field_name);
        assert_eq!(back.cache_source_id, saved.cache_source_id);
        assert_eq!(back.connected_sheets, saved.connected_sheets);
        assert_eq!(back.connected_sources.len(), saved.connected_sources.len());
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
            let saved = SavedRibbonFilter {
                id: 1,
                name: "test".to_string(),
                source_type: SavedSlicerSourceType::Table,
                cache_source_id: 1,
                field_name: "col".to_string(),
                connection_mode: mode,
                connected_sources: vec![],
                connected_sheets: vec![],
                display_mode: SavedRibbonFilterDisplayMode::Checklist,
                selected_items: None,
                cross_filter_enabled: true,
                order: 0,
                button_columns: 2,
                button_rows: 0,
            };

            let def = RibbonFilterDef::from(&saved);
            assert_eq!(def.connection_mode, expected_str);

            let back = SavedRibbonFilter::from(&def);
            // Verify roundtrip by converting back to def again
            let def2 = RibbonFilterDef::from(&back);
            assert_eq!(def2.connection_mode, expected_str);
        }
    }

    #[test]
    fn test_source_type_roundtrip_all_variants() {
        let types = vec![
            (SavedSlicerSourceType::Table, "table"),
            (SavedSlicerSourceType::Pivot, "pivot"),
            (SavedSlicerSourceType::BiConnection, "biConnection"),
        ];

        for (src_type, expected_str) in types {
            let saved = SavedRibbonFilter {
                id: 1,
                name: "test".to_string(),
                source_type: src_type,
                cache_source_id: 1,
                field_name: "col".to_string(),
                connection_mode: SavedConnectionMode::Manual,
                connected_sources: vec![],
                connected_sheets: vec![],
                display_mode: SavedRibbonFilterDisplayMode::Checklist,
                selected_items: None,
                cross_filter_enabled: true,
                order: 0,
                button_columns: 2,
                button_rows: 0,
            };

            let def = RibbonFilterDef::from(&saved);
            assert_eq!(def.source_type, expected_str);
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
            let saved = SavedRibbonFilter {
                id: 1,
                name: "test".to_string(),
                source_type: SavedSlicerSourceType::Table,
                cache_source_id: 1,
                field_name: "col".to_string(),
                connection_mode: SavedConnectionMode::Manual,
                connected_sources: vec![],
                connected_sheets: vec![],
                display_mode: mode,
                selected_items: None,
                cross_filter_enabled: true,
                order: 0,
                button_columns: 2,
                button_rows: 0,
            };

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

        // Deserialize back
        let def_back: RibbonFilterDef = serde_json::from_str(&json).unwrap();

        // Convert to saved
        let saved_back = SavedRibbonFilter::from(&def_back);
        assert_eq!(saved_back.id, saved.id);
        assert_eq!(saved_back.name, saved.name);
        assert_eq!(saved_back.field_name, saved.field_name);
        assert_eq!(saved_back.connected_sheets, saved.connected_sheets);
    }

    #[test]
    fn test_empty_optional_fields_not_in_json() {
        let saved = SavedRibbonFilter {
            id: 1,
            name: "minimal".to_string(),
            source_type: SavedSlicerSourceType::Table,
            cache_source_id: 1,
            field_name: "col".to_string(),
            connection_mode: SavedConnectionMode::Manual,
            connected_sources: vec![],
            connected_sheets: vec![],
            display_mode: SavedRibbonFilterDisplayMode::Checklist,
            selected_items: None,
            cross_filter_enabled: true,
            order: 0,
            button_columns: 2,
            button_rows: 0,
        };

        let def = RibbonFilterDef::from(&saved);
        let json = serde_json::to_string(&def).unwrap();

        // Empty vecs should be skipped
        assert!(!json.contains("\"connectedSources\""));
        assert!(!json.contains("\"connectedSheets\""));
        // Null selectedItems should be skipped
        assert!(!json.contains("\"selectedItems\""));
    }
}
