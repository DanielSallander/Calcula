//! FILENAME: core/calcula-format/src/page_navigator.rs
//! PURPOSE: The Page Navigator control's wire spellings and its `pageOverrides`
//! value, parsed and re-serialised BYTE-IDENTICALLY to the frontend's
//! `serializePageNavigatorOverrides` (`app/src/api/buttonControlService.ts`).
//! CONTEXT: Two Rust crates rewrite a navigator's per-page overrides on a
//! `.calp` pull: the host remaps their sheet IDS to the subscriber's
//! (`app/src-tauri/src/controls.rs`, `remap_control_page_targets`) and
//! `core/calp` rewrites their sheet NAMES through the one rename authority
//! (`core/calp/src/sheet_renames.rs`, `visit_control_page_target_names`). Both
//! must re-serialise exactly as the frontend writes, or an untouched pull ->
//! push round trip would change the bytes of a signed application, and both
//! already depend on this crate -- so the one parser lives here.
//!
//! A navigator's ITEMS are never stored (they are derived live from the
//! workbook's canvas pages); only these overrides are, keyed by the page's id
//! with its name as the fallback (a subscriber's sheet ids are its own).

use serde::{Deserialize, Serialize};

/// The `controlType` of a Page Navigator. Mirror of
/// `PAGE_NAVIGATOR_CONTROL_TYPE` in `app/src/api/buttonControlService.ts`
/// (pinned by the host's `held_button_code_tests`).
pub const PAGE_NAVIGATOR_CONTROL_TYPE: &str = "pageNavigator";

/// The per-button override property: a JSON array of [`PageOverrideWire`].
/// Mirror of `PAGE_NAVIGATOR_OVERRIDES_PROPERTY`.
pub const PAGE_NAVIGATOR_OVERRIDES_PROPERTY: &str = "pageOverrides";

/// One page's override, in the frontend's CANONICAL key order (serde writes
/// struct fields in declaration order): sheetId, sheetName, text, hidden,
/// fill, color, borderColor. It names the PAGE twice (id first, name as the
/// fallback) and carries NO target: which page an item opens is structural.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageOverrideWire {
    pub sheet_id: String,
    pub sheet_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub border_color: Option<String>,
}

/// Parse a `pageOverrides` value. `None` when it is not a JSON array of
/// objects each carrying a string `sheetId` and `sheetName` (or a field of the
/// wrong type): callers then leave the value exactly as it was. Unknown fields
/// are dropped (the frontend's strict check never writes any).
pub fn parse_page_overrides(value: &str) -> Option<Vec<PageOverrideWire>> {
    serde_json::from_str::<Vec<PageOverrideWire>>(value).ok()
}

/// Compact JSON in the canonical key order; `"[]"` for none. The bytes the
/// frontend's `serializePageNavigatorOverrides` writes for the same list.
pub fn serialize_page_overrides(list: &[PageOverrideWire]) -> String {
    serde_json::to_string(list).unwrap_or_else(|_| "[]".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// THE SHARED FIXTURE: copied VERBATIM from `PAGE_OVERRIDES_WIRE_FIXTURE`
    /// in `app/src/api/__tests__/buttonControlService.test.ts`, which asserts
    /// the frontend's `serializePageNavigatorOverrides` emits it. Exercises
    /// every field, the key order, an escaped quote and backslash, a non-ASCII
    /// letter and an id-less entry. Change it there and here together.
    const TS_SERIALIZER_FIXTURE: &str = r##"[{"sheetId":"7f9c2a64-3b1e-4d5a-9c8e-0a1b2c3d4e5f","sheetName":"Sales","text":"Overview","hidden":false,"fill":"#ffcc00","color":"#123","borderColor":"#11223344"},{"sheetId":"","sheetName":"Détail \"Q1\" \\ 2026","hidden":true}]"##;

    /// SABOTAGE: reorder two fields of `PageOverrideWire` (the key order) or
    /// drop a `skip_serializing_if` (an absent field written as `null`).
    #[test]
    fn the_wire_round_trips_the_ts_serializers_bytes() {
        let parsed = parse_page_overrides(TS_SERIALIZER_FIXTURE).expect("the fixture parses");
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].sheet_name, "Sales");
        assert_eq!(parsed[0].text.as_deref(), Some("Overview"));
        assert_eq!(parsed[0].hidden, Some(false), "an explicit false is kept, not dropped");
        assert_eq!(parsed[0].border_color.as_deref(), Some("#11223344"));
        assert_eq!(parsed[1].sheet_id, "");
        assert_eq!(parsed[1].sheet_name, "Détail \"Q1\" \\ 2026");
        assert_eq!(parsed[1].text, None);
        assert_eq!(parsed[1].hidden, Some(true));
        assert_eq!(serialize_page_overrides(&parsed), TS_SERIALIZER_FIXTURE);
        assert_eq!(serialize_page_overrides(&[]), "[]");
        assert_eq!(parse_page_overrides("[]"), Some(Vec::new()));
    }

    #[test]
    fn unknown_fields_are_dropped_on_the_way_through() {
        let parsed =
            parse_page_overrides(r#"[{"sheetName":"A","extra":1,"sheetId":"x","text":"T"}]"#).unwrap();
        assert_eq!(serialize_page_overrides(&parsed), r#"[{"sheetId":"x","sheetName":"A","text":"T"}]"#);
    }

    #[test]
    fn an_unparseable_value_is_none() {
        for bad in [
            "",
            "not json",
            "{}",
            r#"{"sheetId":"x","sheetName":"A"}"#,
            r#"["A"]"#,
            r#"[{"sheetName":"A"}]"#,
            r#"[{"sheetId":7,"sheetName":"A"}]"#,
            r#"[{"sheetId":"x"}]"#,
            r#"[{"sheetId":"x","sheetName":"A","hidden":"true"}]"#,
        ] {
            assert_eq!(parse_page_overrides(bad), None, "{bad}");
        }
    }
}
