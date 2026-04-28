//! FILENAME: app/src-tauri/src/slicer/tests.rs
//! PURPOSE: Unit tests for slicer types and new API commands.

#[cfg(test)]
mod tests {
    use crate::slicer::types::*;

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
        let conn = SlicerConnection {
            source_type: SlicerSourceType::BiConnection,
            source_id: 42,
        };
        let json = serde_json::to_string(&conn).unwrap();
        assert!(json.contains("\"sourceType\""));
        assert!(json.contains("\"biConnection\""));
        assert!(json.contains("\"sourceId\""));

        let back: SlicerConnection = serde_json::from_str(&json).unwrap();
        assert_eq!(back.source_type, SlicerSourceType::BiConnection);
        assert_eq!(back.source_id, 42);
    }

    // ========================================================================
    // Slicer state tests
    // ========================================================================

    #[test]
    fn test_slicer_state_new() {
        let state = SlicerState::new();
        let slicers = state.slicers.lock().unwrap();
        assert!(slicers.is_empty());
        let next_id = state.next_id.lock().unwrap();
        assert_eq!(*next_id, 1);
    }

    #[test]
    fn test_slicer_crud() {
        let state = SlicerState::new();

        // Create
        let slicer = Slicer {
            id: 1,
            name: "Region".to_string(),
            header_text: None,
            sheet_index: 0,
            x: 100.0,
            y: 200.0,
            width: 180.0,
            height: 240.0,
            source_type: SlicerSourceType::Table,
            cache_source_id: 1,
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
                source_id: 1,
            }],
        };

        state.slicers.lock().unwrap().insert(1, slicer);
        assert_eq!(state.slicers.lock().unwrap().len(), 1);

        // Read
        let s = state.slicers.lock().unwrap().get(&1).unwrap().clone();
        assert_eq!(s.name, "Region");
        assert!(s.selected_items.is_none());

        // Update selection
        {
            let mut slicers = state.slicers.lock().unwrap();
            let s = slicers.get_mut(&1).unwrap();
            s.selected_items = Some(vec!["North".to_string(), "South".to_string()]);
        }
        {
            let slicers = state.slicers.lock().unwrap();
            let s = slicers.get(&1).unwrap();
            assert_eq!(s.selected_items.as_ref().unwrap().len(), 2);
        }

        // Clear filter
        {
            let mut slicers = state.slicers.lock().unwrap();
            let s = slicers.get_mut(&1).unwrap();
            s.selected_items = None;
            assert!(s.selected_items.is_none());
        }

        // Delete
        {
            let mut slicers = state.slicers.lock().unwrap();
            slicers.remove(&1);
            assert!(slicers.is_empty());
        }
    }

    #[test]
    fn test_slicer_bi_connection_source() {
        let slicer = Slicer {
            id: 1,
            name: "BI City".to_string(),
            header_text: Some("City".to_string()),
            sheet_index: 0,
            x: 0.0,
            y: 0.0,
            width: 180.0,
            height: 240.0,
            source_type: SlicerSourceType::BiConnection,
            cache_source_id: 5,
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
        assert_eq!(back.cache_source_id, 5);
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
