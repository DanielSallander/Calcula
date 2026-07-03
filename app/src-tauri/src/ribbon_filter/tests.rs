//! FILENAME: app/src-tauri/src/ribbon_filter/tests.rs
//! PURPOSE: Unit tests for ribbon filter types, state, and CRUD logic.

#[cfg(test)]
mod tests {
    use crate::ribbon_filter::types::*;
    use identity::EntityId;

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
            display_mode: RibbonFilterDisplayMode::Checklist,
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
        let filters = state.filters.lock().unwrap();
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
            state.filters.lock().unwrap().insert(id, filter);
        }

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

        for i in 0..5 {
            let id = mint_id();
            let mut filter = make_filter(id, mint_id(), &format!("Filter{}", i));
            filter.field_name = format!("t.field{}", i);
            filter.order = i as u32;
            state.filters.lock().unwrap().insert(id, filter);
        }

        let filters = state.filters.lock().unwrap();
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
        state.filters.lock().unwrap().insert(id_a, make_filter(id_a, conn_a, "A"));
        state.filters.lock().unwrap().insert(id_b, make_filter(id_b, conn_b, "B"));

        let filters = state.filters.lock().unwrap();
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
        state.filters.lock().unwrap().insert(id_pkg, pkg_filter);
        state.filters.lock().unwrap().insert(id_local, local_filter);

        let new_conn = mint_id();
        let mut ds_to_conn = std::collections::HashMap::new();
        ds_to_conn.insert("ds-1".to_string(), new_conn);
        crate::ribbon_filter::commands::remap_ribbon_filter_connections(&state, &ds_to_conn);

        let filters = state.filters.lock().unwrap();
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
}
