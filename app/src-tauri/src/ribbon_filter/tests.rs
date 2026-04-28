//! FILENAME: app/src-tauri/src/ribbon_filter/tests.rs
//! PURPOSE: Unit tests for ribbon filter types, state, and CRUD logic.

#[cfg(test)]
mod tests {
    use crate::ribbon_filter::types::*;
    use crate::slicer::types::{SlicerSourceType, SlicerConnection};

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
        let filter = RibbonFilter {
            id: 42,
            name: "Test Filter".to_string(),
            source_type: SlicerSourceType::BiConnection,
            cache_source_id: 1,
            field_name: "dim_customer.city".to_string(),
            connection_mode: ConnectionMode::Workbook,
            connected_sources: vec![
                SlicerConnection {
                    source_type: SlicerSourceType::Pivot,
                    source_id: 5,
                },
            ],
            connected_sheets: vec![0, 2],
            display_mode: RibbonFilterDisplayMode::Checklist,
            selected_items: Some(vec!["New York".to_string(), "London".to_string()]),
            cross_filter_enabled: true,
            order: 3,
            button_columns: 2,
            button_rows: 0,
        };

        let json = serde_json::to_string(&filter).unwrap();
        let deserialized: RibbonFilter = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.id, 42);
        assert_eq!(deserialized.name, "Test Filter");
        assert_eq!(deserialized.field_name, "dim_customer.city");
        assert_eq!(deserialized.connection_mode, ConnectionMode::Workbook);
        assert_eq!(deserialized.connected_sheets, vec![0, 2]);
        assert_eq!(deserialized.selected_items.as_ref().unwrap().len(), 2);
        assert_eq!(deserialized.connected_sources.len(), 1);
        assert_eq!(deserialized.connected_sources[0].source_id, 5);
    }

    #[test]
    fn test_ribbon_filter_camel_case_field_names() {
        let filter = RibbonFilter {
            id: 1,
            name: "f".to_string(),
            source_type: SlicerSourceType::Table,
            cache_source_id: 1,
            field_name: "col".to_string(),
            connection_mode: ConnectionMode::Manual,
            connected_sources: vec![],
            connected_sheets: vec![],
            display_mode: RibbonFilterDisplayMode::Checklist,
            selected_items: None,
            cross_filter_enabled: true,
            order: 0,
            button_columns: 2,
            button_rows: 0,
        };

        let json = serde_json::to_string(&filter).unwrap();
        // Verify camelCase field names
        assert!(json.contains("\"sourceType\""));
        assert!(json.contains("\"cacheSourceId\""));
        assert!(json.contains("\"fieldName\""));
        assert!(json.contains("\"connectionMode\""));
        assert!(json.contains("\"displayMode\""));
        assert!(json.contains("\"selectedItems\""));
        assert!(json.contains("\"crossFilterEnabled\""));
        assert!(json.contains("\"buttonColumns\""));
        assert!(json.contains("\"buttonRows\""));
        // Should NOT contain snake_case
        assert!(!json.contains("\"source_type\""));
        assert!(!json.contains("\"cache_source_id\""));
        assert!(!json.contains("\"field_name\""));
    }

    #[test]
    fn test_ribbon_filter_defaults() {
        // Deserialize minimal JSON — all optional fields should get defaults
        let json = r#"{
            "id": 1,
            "name": "test",
            "sourceType": "table",
            "cacheSourceId": 10,
            "fieldName": "col",
            "selectedItems": null
        }"#;

        let filter: RibbonFilter = serde_json::from_str(json).unwrap();
        assert_eq!(filter.connection_mode, ConnectionMode::Manual);
        assert_eq!(filter.display_mode, RibbonFilterDisplayMode::Checklist);
        assert!(filter.cross_filter_enabled);
        assert_eq!(filter.order, 0);
        assert_eq!(filter.button_columns, 2);
        assert_eq!(filter.button_rows, 0);
        assert!(filter.connected_sources.is_empty());
        assert!(filter.connected_sheets.is_empty());
    }

    #[test]
    fn test_bi_connection_source_type_serde() {
        let filter = RibbonFilter {
            id: 1,
            name: "bi".to_string(),
            source_type: SlicerSourceType::BiConnection,
            cache_source_id: 1,
            field_name: "t.c".to_string(),
            connection_mode: ConnectionMode::Workbook,
            connected_sources: vec![],
            connected_sheets: vec![],
            display_mode: RibbonFilterDisplayMode::Checklist,
            selected_items: None,
            cross_filter_enabled: true,
            order: 0,
            button_columns: 2,
            button_rows: 0,
        };

        let json = serde_json::to_string(&filter).unwrap();
        assert!(json.contains("\"biConnection\""));
        let back: RibbonFilter = serde_json::from_str(&json).unwrap();
        assert_eq!(back.source_type, SlicerSourceType::BiConnection);
    }

    // ========================================================================
    // State management tests
    // ========================================================================

    #[test]
    fn test_ribbon_filter_state_new() {
        let state = RibbonFilterState::new();
        let filters = state.filters.lock().unwrap();
        assert!(filters.is_empty());
        let next_id = state.next_id.lock().unwrap();
        assert_eq!(*next_id, 1);
    }

    #[test]
    fn test_ribbon_filter_state_crud() {
        let state = RibbonFilterState::new();

        // Create
        let id = {
            let mut next_id = state.next_id.lock().unwrap();
            let id = *next_id;
            *next_id += 1;
            let filter = RibbonFilter {
                id,
                name: "Region".to_string(),
                source_type: SlicerSourceType::Table,
                cache_source_id: 1,
                field_name: "Region".to_string(),
                connection_mode: ConnectionMode::Manual,
                connected_sources: vec![SlicerConnection {
                    source_type: SlicerSourceType::Table,
                    source_id: 1,
                }],
                connected_sheets: vec![],
                display_mode: RibbonFilterDisplayMode::Checklist,
                selected_items: None,
                cross_filter_enabled: true,
                order: 0,
                button_columns: 2,
                button_rows: 0,
            };
            state.filters.lock().unwrap().insert(id, filter);
            id
        };

        // Read
        {
            let filters = state.filters.lock().unwrap();
            assert_eq!(filters.len(), 1);
            let f = filters.get(&id).unwrap();
            assert_eq!(f.name, "Region");
            assert!(f.selected_items.is_none());
        }

        // Update selection
        {
            let mut filters = state.filters.lock().unwrap();
            let f = filters.get_mut(&id).unwrap();
            f.selected_items = Some(vec!["North".to_string(), "South".to_string()]);
        }
        {
            let filters = state.filters.lock().unwrap();
            let f = filters.get(&id).unwrap();
            assert_eq!(f.selected_items.as_ref().unwrap().len(), 2);
        }

        // Clear
        {
            let mut filters = state.filters.lock().unwrap();
            let f = filters.get_mut(&id).unwrap();
            f.selected_items = None;
            assert!(f.selected_items.is_none());
        }

        // Delete
        {
            let mut filters = state.filters.lock().unwrap();
            filters.remove(&id);
            assert!(filters.is_empty());
        }
    }

    #[test]
    fn test_ribbon_filter_state_multiple_filters() {
        let state = RibbonFilterState::new();
        let mut next_id = state.next_id.lock().unwrap();

        for i in 0..5 {
            let id = *next_id;
            *next_id += 1;
            let filter = RibbonFilter {
                id,
                name: format!("Filter{}", i),
                source_type: SlicerSourceType::Table,
                cache_source_id: 1,
                field_name: format!("field{}", i),
                connection_mode: ConnectionMode::Workbook,
                connected_sources: vec![],
                connected_sheets: vec![],
                display_mode: RibbonFilterDisplayMode::Checklist,
                selected_items: None,
                cross_filter_enabled: true,
                order: i as u32,
                button_columns: 2,
                button_rows: 0,
            };
            state.filters.lock().unwrap().insert(id, filter);
        }

        let filters = state.filters.lock().unwrap();
        assert_eq!(filters.len(), 5);
        assert_eq!(*next_id, 6);
    }

    #[test]
    fn test_connection_mode_update() {
        let state = RibbonFilterState::new();
        let id = 1u64;
        let filter = RibbonFilter {
            id,
            name: "test".to_string(),
            source_type: SlicerSourceType::BiConnection,
            cache_source_id: 1,
            field_name: "dim.col".to_string(),
            connection_mode: ConnectionMode::Manual,
            connected_sources: vec![],
            connected_sheets: vec![],
            display_mode: RibbonFilterDisplayMode::Checklist,
            selected_items: None,
            cross_filter_enabled: true,
            order: 0,
            button_columns: 2,
            button_rows: 0,
        };
        state.filters.lock().unwrap().insert(id, filter);

        // Switch to bySheet
        {
            let mut filters = state.filters.lock().unwrap();
            let f = filters.get_mut(&id).unwrap();
            f.connection_mode = ConnectionMode::BySheet;
            f.connected_sheets = vec![0, 1];
        }

        let filters = state.filters.lock().unwrap();
        let f = filters.get(&id).unwrap();
        assert_eq!(f.connection_mode, ConnectionMode::BySheet);
        assert_eq!(f.connected_sheets, vec![0, 1]);
    }

    // ========================================================================
    // Create params deserialization test
    // ========================================================================

    #[test]
    fn test_create_params_deserialization() {
        let json = r#"{
            "name": "City",
            "sourceType": "biConnection",
            "cacheSourceId": 3,
            "fieldName": "dim_customer.city",
            "connectionMode": "workbook"
        }"#;

        let params: CreateRibbonFilterParams = serde_json::from_str(json).unwrap();
        assert_eq!(params.name, "City");
        assert_eq!(params.source_type, SlicerSourceType::BiConnection);
        assert_eq!(params.cache_source_id, 3);
        assert_eq!(params.field_name, "dim_customer.city");
        assert_eq!(params.connection_mode, ConnectionMode::Workbook);
        assert!(params.connected_sources.is_empty());
        assert!(params.connected_sheets.is_empty());
    }

    #[test]
    fn test_update_params_deserialization() {
        let json = r#"{
            "connectionMode": "bySheet",
            "connectedSheets": [0, 2, 4]
        }"#;

        let params: UpdateRibbonFilterParams = serde_json::from_str(json).unwrap();
        assert_eq!(params.connection_mode, Some(ConnectionMode::BySheet));
        assert_eq!(params.connected_sheets, Some(vec![0, 2, 4]));
        assert!(params.name.is_none());
        assert!(params.display_mode.is_none());
    }
}
