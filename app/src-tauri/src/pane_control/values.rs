//! FILENAME: app/src-tauri/src/pane_control/values.rs
//! PURPOSE: Build the GET.CONTROLVALUE snapshot — name -> engine::ControlValue.
//! CONTEXT: Three control families publish named values:
//!            1. pane controls        (PaneControlState)
//!            2. ribbon filters       (RibbonFilterState; selection mapped)
//!            3. named on-grid controls (AppState.controls + the anchor cell)
//!          Collision precedence: pane control > ribbon filter > on-grid,
//!          deterministic within each family; collisions log a warning.
//!
//! LOCK-ORDER REQUIREMENT (deadlock discipline): the extractor helpers take
//! PLAIN DATA (a locked map borrow / a pre-cloned ControlStorage / a grids
//! slice) so the CALLER controls locking. Never hold the pane-controls or
//! ribbon-filters lock while acquiring the grid locks — take each store lock
//! briefly, extract, DROP, and only then read `grids` (clone the on-grid
//! ControlStorage under its own lock first; convention per
//! resolve_control_properties, controls.rs). Inside update_cell-style paths
//! that already hold `grids`, pass the held slice — do not re-lock.

use crate::controls::ControlStorage;
use crate::pane_control::types::PaneControl;
use crate::ribbon_filter::RibbonFilter;
use engine::{CellValue, ControlValue};
use serde::Serialize;
use std::collections::HashMap;

use crate::log_warn;

/// Source tag for a pane control entry.
pub const SOURCE_PANE_CONTROL: &str = "paneControl";
/// Source tag for a ribbon filter entry.
pub const SOURCE_RIBBON_FILTER: &str = "ribbonFilter";
/// Source tag for a named on-grid control entry.
pub const SOURCE_ON_GRID: &str = "onGridControl";

/// One named control with its published value and source attribution.
/// Returned by the get_all_control_values command (feeds the
/// @api/controlValues facade).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedControlValue {
    /// Display name as authored (NOT uppercased).
    pub name: String,
    /// The published value; None for value-less controls (e.g. buttons) —
    /// those never enter the GET.CONTROLVALUE snapshot map.
    pub value: Option<ControlValue>,
    /// Which family published this entry: "paneControl" | "ribbonFilter" |
    /// "onGridControl".
    pub source: String,
    /// Entity id for pane controls and ribbon filters; None for on-grid
    /// controls (they are keyed by cell position, not EntityId).
    pub id: Option<identity::EntityId>,
}

// ============================================================================
// Per-family extractors (caller holds/clones the relevant store)
// ============================================================================

/// Extract pane-control entries from a (locked) pane-control map.
/// Deterministic order: by (order, name) — matches the pane strip.
pub fn pane_control_named_values(
    controls: &HashMap<identity::EntityId, PaneControl>,
) -> Vec<NamedControlValue> {
    let mut list: Vec<&PaneControl> = controls.values().collect();
    list.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.name.cmp(&b.name)));
    list.into_iter()
        .map(|c| NamedControlValue {
            name: c.name.clone(),
            value: c.value.clone(),
            source: SOURCE_PANE_CONTROL.to_string(),
            id: Some(c.id),
        })
        .collect()
}

/// Map one ribbon filter's selection to its GET.CONTROLVALUE value:
/// - `selected_items: None`      -> Text("(All)") (no filter applied)
/// - exactly 1 selected          -> Text(item)
/// - 2+ selected                 -> TextList (vertical spill in the grid)
/// - Some but empty (edge case)  -> TextList(empty) (evaluates to #N/A)
pub fn ribbon_filter_value(filter: &RibbonFilter) -> ControlValue {
    match &filter.selected_items {
        None => ControlValue::Text("(All)".to_string()),
        Some(items) if items.len() == 1 => ControlValue::Text(items[0].clone()),
        Some(items) => ControlValue::TextList(items.clone()),
    }
}

/// Extract ribbon-filter entries from a (locked) filters map.
/// Deterministic order: by (order, name) — matches the pane strip.
pub fn ribbon_filter_named_values(
    filters: &HashMap<identity::EntityId, RibbonFilter>,
) -> Vec<NamedControlValue> {
    let mut list: Vec<&RibbonFilter> = filters.values().collect();
    list.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.name.cmp(&b.name)));
    list.into_iter()
        .map(|f| NamedControlValue {
            name: f.name.clone(),
            value: Some(ribbon_filter_value(f)),
            source: SOURCE_RIBBON_FILTER.to_string(),
            id: Some(f.id),
        })
        .collect()
}

/// Map an anchor cell's value to a ControlValue. Empty (or absent) cells map
/// to Text("") — a named on-grid control always publishes SOMETHING; errors
/// and structured values (List/Dict) publish nothing (None => excluded).
fn cell_to_control_value(value: Option<&CellValue>) -> Option<ControlValue> {
    match value {
        None | Some(CellValue::Empty) => Some(ControlValue::Text(String::new())),
        Some(CellValue::Number(n)) => Some(ControlValue::Number(*n)),
        Some(CellValue::Text(s)) => Some(ControlValue::Text(s.clone())),
        Some(CellValue::Boolean(b)) => Some(ControlValue::Boolean(*b)),
        Some(CellValue::Error(_)) | Some(CellValue::List(_)) | Some(CellValue::Dict(_)) => None,
    }
}

/// Extract entries for NAMED on-grid controls: controls carrying a "name"
/// property with a STATIC value publish their anchor cell's value.
/// Deterministic order: by (sheet, row, col). Unnamed controls, formula-typed
/// name properties, and error/structured anchor values are excluded.
///
/// `controls` should be a CLONE taken under the controls lock (then dropped)
/// or otherwise safe to borrow together with `grids` — see the module-level
/// lock-order requirement.
pub fn on_grid_named_values(
    controls: &ControlStorage,
    grids: &[engine::grid::Grid],
) -> Vec<NamedControlValue> {
    let mut keys: Vec<(usize, u32, u32)> = controls.keys().copied().collect();
    keys.sort();

    let mut result = Vec::new();
    for key in keys {
        let (sheet, row, col) = key;
        let Some(meta) = controls.get(&key) else { continue };
        let Some(name_prop) = meta.properties.get("name") else { continue };
        if name_prop.value_type != "static" {
            continue;
        }
        let name = name_prop.value.trim();
        if name.is_empty() {
            continue;
        }
        let cell_value = grids
            .get(sheet)
            .and_then(|g| g.get_cell(row, col))
            .map(|c| &c.value);
        let Some(value) = cell_to_control_value(cell_value) else {
            continue;
        };
        result.push(NamedControlValue {
            name: name.to_string(),
            value: Some(value),
            source: SOURCE_ON_GRID.to_string(),
            id: None,
        });
    }
    result
}

// ============================================================================
// Snapshot merge
// ============================================================================

/// Merge the three families into the GET.CONTROLVALUE snapshot map.
///
/// Keys are TRIMMED + UPPERCASED (the evaluator's case-insensitive lookup
/// invariant). Insertion precedence: pane controls, then ribbon filters, then
/// on-grid controls — first writer wins (`entry().or_insert()`), collisions
/// log a warning. Entries with `value: None` (value-less controls) and empty
/// names never enter the map.
pub fn collect_control_values(
    pane_entries: &[NamedControlValue],
    filter_entries: &[NamedControlValue],
    on_grid_entries: &[NamedControlValue],
) -> HashMap<String, ControlValue> {
    let mut map: HashMap<String, ControlValue> = HashMap::new();
    for entry in pane_entries
        .iter()
        .chain(filter_entries.iter())
        .chain(on_grid_entries.iter())
    {
        let Some(value) = &entry.value else { continue };
        let key = entry.name.trim().to_uppercase();
        if key.is_empty() {
            continue;
        }
        match map.entry(key) {
            std::collections::hash_map::Entry::Vacant(slot) => {
                slot.insert(value.clone());
            }
            std::collections::hash_map::Entry::Occupied(slot) => {
                log_warn!(
                    "PANE_CONTROL",
                    "Control name collision on \"{}\" ({}): shadowed by an earlier control (precedence: pane control > ribbon filter > on-grid)",
                    slot.key(),
                    entry.source
                );
            }
        }
    }
    map
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::controls::{ControlMetadata, ControlPropertyValue};
    use crate::pane_control::types::{PaneControlConfig, PaneControlType};
    use crate::ribbon_filter::{ConnectionMode, RibbonFilterDisplayMode};
    use engine::grid::Grid;
    use engine::Cell;

    fn new_id() -> identity::EntityId {
        identity::EntityId::from_bytes(identity::generate_uuid_v7())
    }

    fn pane(name: &str, value: Option<ControlValue>, order: u32) -> PaneControl {
        PaneControl {
            id: new_id(),
            name: name.to_string(),
            control_type: PaneControlType::Slider,
            config: PaneControlConfig::Slider {
                min: 0.0,
                max: 100.0,
                step: 1.0,
                show_value: true,
                chart_param_target: None,
            },
            value,
            order,
        }
    }

    fn filter(name: &str, selected: Option<Vec<&str>>, order: u32) -> RibbonFilter {
        RibbonFilter {
            id: new_id(),
            name: name.to_string(),
            connection_id: new_id(),
            data_source_id: None,
            field_name: "Table.Column".to_string(),
            field_data_type: "text".to_string(),
            connection_mode: ConnectionMode::Manual,
            connected_pivots: vec![],
            connected_sheets: vec![],
            display_mode: RibbonFilterDisplayMode::Checklist,
            selected_items: selected.map(|v| v.into_iter().map(String::from).collect()),
            cross_filter_targets: vec![],
            cross_filter_slicer_targets: vec![],
            advanced_filter: None,
            hide_no_data: false,
            indicate_no_data: true,
            sort_no_data_last: true,
            show_select_all: false,
            single_select: false,
            order,
            button_columns: 2,
            button_rows: 0,
        }
    }

    fn on_grid_control(name: Option<&str>) -> ControlMetadata {
        let mut properties = HashMap::new();
        if let Some(n) = name {
            properties.insert(
                "name".to_string(),
                ControlPropertyValue {
                    value_type: "static".to_string(),
                    value: n.to_string(),
                },
            );
        }
        properties.insert(
            "text".to_string(),
            ControlPropertyValue {
                value_type: "static".to_string(),
                value: "Click".to_string(),
            },
        );
        ControlMetadata {
            control_type: "checkbox".to_string(),
            properties,
        }
    }

    #[test]
    fn filter_mapping_none_is_all() {
        let f = filter("Region", None, 0);
        assert_eq!(
            ribbon_filter_value(&f),
            ControlValue::Text("(All)".to_string())
        );
    }

    #[test]
    fn filter_mapping_single_is_text() {
        let f = filter("Region", Some(vec!["North"]), 0);
        assert_eq!(
            ribbon_filter_value(&f),
            ControlValue::Text("North".to_string())
        );
    }

    #[test]
    fn filter_mapping_multi_is_text_list() {
        let f = filter("Region", Some(vec!["North", "South", "East"]), 0);
        assert_eq!(
            ribbon_filter_value(&f),
            ControlValue::TextList(vec![
                "North".to_string(),
                "South".to_string(),
                "East".to_string()
            ])
        );
    }

    #[test]
    fn precedence_pane_beats_filter_beats_on_grid() {
        // Same name in all three families — the pane control wins.
        let pane_entries = vec![NamedControlValue {
            name: "Threshold".to_string(),
            value: Some(ControlValue::Number(10.0)),
            source: SOURCE_PANE_CONTROL.to_string(),
            id: Some(new_id()),
        }];
        let filter_entries = vec![NamedControlValue {
            name: "threshold".to_string(),
            value: Some(ControlValue::Text("filter".to_string())),
            source: SOURCE_RIBBON_FILTER.to_string(),
            id: Some(new_id()),
        }];
        let on_grid_entries = vec![NamedControlValue {
            name: "THRESHOLD".to_string(),
            value: Some(ControlValue::Boolean(true)),
            source: SOURCE_ON_GRID.to_string(),
            id: None,
        }];

        let map = collect_control_values(&pane_entries, &filter_entries, &on_grid_entries);
        assert_eq!(map.len(), 1);
        assert_eq!(map.get("THRESHOLD"), Some(&ControlValue::Number(10.0)));

        // Filter beats on-grid when there is no pane control.
        let map = collect_control_values(&[], &filter_entries, &on_grid_entries);
        assert_eq!(
            map.get("THRESHOLD"),
            Some(&ControlValue::Text("filter".to_string()))
        );
    }

    #[test]
    fn keys_are_trimmed_and_uppercased_and_valueless_excluded() {
        let mut controls: HashMap<identity::EntityId, PaneControl> = HashMap::new();
        let slider = pane("  My Slider ", Some(ControlValue::Number(3.0)), 1);
        let button = PaneControl {
            id: new_id(),
            name: "Run".to_string(),
            control_type: PaneControlType::Button,
            config: PaneControlConfig::Button {
                label: "Run".to_string(),
            },
            value: None, // value-less: absent from the snapshot map
            order: 0,
        };
        controls.insert(slider.id, slider);
        controls.insert(button.id, button);

        let entries = pane_control_named_values(&controls);
        // Enumeration still lists the button (value: None)...
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "Run"); // order 0 first
        assert!(entries[0].value.is_none());

        // ...but the snapshot map excludes it and uppercases/trims the key.
        let map = collect_control_values(&entries, &[], &[]);
        assert_eq!(map.len(), 1);
        assert_eq!(map.get("MY SLIDER"), Some(&ControlValue::Number(3.0)));
    }

    #[test]
    fn on_grid_named_controls_read_anchor_cell_values() {
        let mut storage: ControlStorage = HashMap::new();
        storage.insert((0, 1, 1), on_grid_control(Some("NumCtl")));
        storage.insert((0, 2, 1), on_grid_control(Some("TextCtl")));
        storage.insert((0, 3, 1), on_grid_control(Some("BoolCtl")));
        storage.insert((0, 4, 1), on_grid_control(Some("EmptyCtl")));
        storage.insert((0, 5, 1), on_grid_control(None)); // unnamed: excluded

        let mut grid = Grid::new();
        grid.set_cell(1, 1, Cell::new_number(7.5));
        grid.set_cell(2, 1, Cell::new_text("hello".to_string()));
        let mut bool_cell = Cell::new();
        bool_cell.value = CellValue::Boolean(true);
        grid.set_cell(3, 1, bool_cell);
        // (4,1) left empty on purpose
        let grids = vec![grid];

        let entries = on_grid_named_values(&storage, &grids);
        assert_eq!(entries.len(), 4, "unnamed control must be excluded");
        // Sorted by (sheet, row, col)
        assert_eq!(entries[0].name, "NumCtl");
        assert_eq!(entries[0].value, Some(ControlValue::Number(7.5)));
        assert_eq!(entries[0].source, SOURCE_ON_GRID);
        assert_eq!(entries[0].id, None);
        assert_eq!(
            entries[1].value,
            Some(ControlValue::Text("hello".to_string()))
        );
        assert_eq!(entries[2].value, Some(ControlValue::Boolean(true)));
        assert_eq!(
            entries[3].value,
            Some(ControlValue::Text(String::new())),
            "empty anchor cell publishes Text(\"\")"
        );
    }

    #[test]
    fn on_grid_formula_typed_name_is_excluded() {
        let mut meta = on_grid_control(None);
        meta.properties.insert(
            "name".to_string(),
            ControlPropertyValue {
                value_type: "formula".to_string(),
                value: "=A1".to_string(),
            },
        );
        let mut storage: ControlStorage = HashMap::new();
        storage.insert((0, 0, 0), meta);
        let grids = vec![Grid::new()];
        assert!(on_grid_named_values(&storage, &grids).is_empty());
    }

    #[test]
    fn full_merge_across_families() {
        // Pane: slider "A"; filters: "B" multi-select; on-grid: "C" number.
        let mut pane_map: HashMap<identity::EntityId, PaneControl> = HashMap::new();
        let a = pane("A", Some(ControlValue::Number(1.0)), 0);
        pane_map.insert(a.id, a);

        let mut filter_map: HashMap<identity::EntityId, RibbonFilter> = HashMap::new();
        let b = filter("B", Some(vec!["x", "y"]), 1);
        filter_map.insert(b.id, b);

        let mut storage: ControlStorage = HashMap::new();
        storage.insert((0, 0, 0), on_grid_control(Some("C")));
        let mut grid = Grid::new();
        grid.set_cell(0, 0, Cell::new_number(42.0));
        let grids = vec![grid];

        let map = collect_control_values(
            &pane_control_named_values(&pane_map),
            &ribbon_filter_named_values(&filter_map),
            &on_grid_named_values(&storage, &grids),
        );
        assert_eq!(map.len(), 3);
        assert_eq!(map.get("A"), Some(&ControlValue::Number(1.0)));
        assert_eq!(
            map.get("B"),
            Some(&ControlValue::TextList(vec![
                "x".to_string(),
                "y".to_string()
            ]))
        );
        assert_eq!(map.get("C"), Some(&ControlValue::Number(42.0)));
    }
}
