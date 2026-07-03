//! FILENAME: core/calcula-format/src/features/pane_control_tests.rs
//! PURPOSE: Tests for pane control (Controls Pane) persistence roundtrip.

#[cfg(test)]
mod tests {
    use crate::features::pane_controls::*;
    use identity::EntityId;
    use persistence::SavedPaneControl;

    /// Helper to mint a fresh EntityId for tests.
    fn mint_id() -> EntityId {
        EntityId::from_bytes(identity::generate_uuid_v7())
    }

    fn make_test_saved_control() -> SavedPaneControl {
        SavedPaneControl {
            id: mint_id(),
            name: "Growth Rate".to_string(),
            control_type: "slider".to_string(),
            config: serde_json::json!({
                "type": "slider",
                "min": 0.0,
                "max": 1.0,
                "step": 0.05,
                "showValue": true
            }),
            value: serde_json::json!({ "type": "number", "value": 0.25 }),
            order: 5,
        }
    }

    fn make_valueless_saved_control() -> SavedPaneControl {
        SavedPaneControl {
            id: mint_id(),
            name: "Refresh".to_string(),
            control_type: "button".to_string(),
            config: serde_json::json!({ "type": "button", "label": "Refresh data" }),
            value: serde_json::Value::Null,
            order: 0,
        }
    }

    #[test]
    fn test_saved_to_def_roundtrip() {
        let saved = make_test_saved_control();
        let def = PaneControlDef::from(&saved);

        // Check conversion to def
        assert_eq!(def.id, saved.id);
        assert_eq!(def.name, "Growth Rate");
        assert_eq!(def.control_type, "slider");
        assert_eq!(def.config, saved.config);
        assert_eq!(def.value, saved.value);
        assert_eq!(def.order, 5);

        // Convert back to saved
        let back = SavedPaneControl::from(&def);
        assert_eq!(back.id, saved.id);
        assert_eq!(back.name, saved.name);
        assert_eq!(back.control_type, saved.control_type);
        assert_eq!(back.config, saved.config);
        assert_eq!(back.value, saved.value);
        assert_eq!(back.order, saved.order);
    }

    #[test]
    fn test_json_roundtrip() {
        let saved = make_test_saved_control();
        let def = PaneControlDef::from(&saved);

        // Serialize to JSON
        let json = serde_json::to_string_pretty(&def).unwrap();
        // Fields must be present in camelCase
        assert!(json.contains("\"controlType\""));
        assert!(json.contains("\"config\""));
        assert!(json.contains("\"value\""));
        assert!(json.contains("\"order\""));

        // Deserialize back
        let def_back: PaneControlDef = serde_json::from_str(&json).unwrap();

        // Convert to saved
        let saved_back = SavedPaneControl::from(&def_back);
        assert_eq!(saved_back.id, saved.id);
        assert_eq!(saved_back.name, saved.name);
        assert_eq!(saved_back.control_type, saved.control_type);
        assert_eq!(saved_back.config, saved.config);
        assert_eq!(saved_back.value, saved.value);
        assert_eq!(saved_back.order, saved.order);
    }

    #[test]
    fn test_config_and_value_are_opaque_passthrough() {
        // Arbitrarily nested app-owned JSON must survive untouched — the
        // format layer never inspects config/value.
        let mut saved = make_test_saved_control();
        saved.control_type = "custom".to_string();
        saved.config = serde_json::json!({
            "type": "custom",
            "properties": {
                "series": [1, 2, 3, { "nested": { "deep": [true, null, "x"] } }],
                "unicode": "héllo — ✓"
            }
        });
        saved.value = serde_json::json!(["multi", "select", "list"]);

        let def = PaneControlDef::from(&saved);
        let json = serde_json::to_string(&def).unwrap();
        let def_back: PaneControlDef = serde_json::from_str(&json).unwrap();
        let back = SavedPaneControl::from(&def_back);

        assert_eq!(back.config, saved.config);
        assert_eq!(back.value, saved.value);
    }

    #[test]
    fn test_valueless_control_roundtrip() {
        // A value-less control (button) stores value: null and must round-trip.
        let saved = make_valueless_saved_control();
        let def = PaneControlDef::from(&saved);
        assert!(def.value.is_null());

        let json = serde_json::to_string(&def).unwrap();
        let def_back: PaneControlDef = serde_json::from_str(&json).unwrap();
        let back = SavedPaneControl::from(&def_back);
        assert!(back.value.is_null());
        assert_eq!(back.control_type, "button");
    }

    #[test]
    fn test_missing_optional_fields_default() {
        // config/value/order carry #[serde(default)] — a minimal JSON without
        // them must still deserialize (null config/value, order 0).
        let id = mint_id();
        let json = format!(
            "{{ \"id\": \"{}\", \"name\": \"Bare\", \"controlType\": \"checkbox\" }}",
            id
        );
        let def: PaneControlDef = serde_json::from_str(&json).unwrap();
        assert_eq!(def.id, id);
        assert_eq!(def.name, "Bare");
        assert_eq!(def.control_type, "checkbox");
        assert!(def.config.is_null());
        assert!(def.value.is_null());
        assert_eq!(def.order, 0);
    }
}
