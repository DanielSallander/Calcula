//! FILENAME: core/calp/src/overrides.rs
//! PURPOSE: Override layer for consumer-side modifications to subscribed content.
//! CONTEXT: When a consumer edits a cell that originates from an upstream .calp
//! package, the edit is recorded as an override rather than a raw value change.
//! Overrides are anchored to cell IDs and survive structural shifts.
//!
//! The override layer stores:
//! - What the upstream value/formula was when the override was created (baseline)
//! - What the consumer changed it to (current override)
//! - Which cell it targets (by stable identity)
//! - When it was created
//! - Conflict state (if upstream changed the cell since the override was created)

use std::collections::HashMap;

use identity::{CellId, SheetId};
use serde::{Deserialize, Serialize};

/// A single cell value in the override layer. Can be a plain value or a formula.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum OverrideValue {
    /// A plain value (number, text, boolean, etc.)
    #[serde(rename = "value")]
    Value { display: String },
    /// A formula (stored as the formula string for portability)
    #[serde(rename = "formula")]
    Formula { formula: String },
    /// An empty cell
    #[serde(rename = "empty")]
    Empty,
}

/// A single override record: one consumer-side modification to an upstream cell.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellOverride {
    /// The sheet containing this cell.
    pub sheet_id: SheetId,
    /// The cell's stable identity.
    pub cell_id: CellId,
    /// The cell's position at the time the override was created.
    /// Used for display and for resolving overrides on cells that lost their ID.
    pub position: (u32, u32),
    /// What the upstream value/formula was when the override was created.
    pub baseline: OverrideValue,
    /// The consumer's overridden value/formula.
    pub current: OverrideValue,
    /// ISO 8601 timestamp of when the override was created.
    pub created_at: String,
    /// ISO 8601 timestamp of last modification.
    pub modified_at: String,
    /// Author who created the override (if multi-user context).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub author: String,
    /// Whether this override is in conflict with a newer upstream change.
    #[serde(default)]
    pub conflict: bool,
    /// If in conflict, what the new upstream value is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_new: Option<OverrideValue>,
    /// Forward-compatibility: preserves unknown fields from future format versions.
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

/// The complete override layer for a workbook.
/// Stored in the .cala file as `overrides.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverrideLayer {
    pub format_version: u32,
    /// All overrides, keyed by (sheet_id, cell_id) for efficient lookup.
    /// The Vec form is used for serialization; the runtime uses the HashMap.
    pub overrides: Vec<CellOverride>,
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

impl OverrideLayer {
    pub fn new() -> Self {
        Self {
            format_version: 1,
            overrides: Vec::new(),
            extra: HashMap::new(),
        }
    }

    /// Build a lookup index from the override list.
    pub fn index(&self) -> OverrideIndex {
        let mut map = HashMap::new();
        for (i, ovr) in self.overrides.iter().enumerate() {
            map.insert((ovr.sheet_id, ovr.cell_id), i);
        }
        OverrideIndex { map }
    }

    /// Get an override by cell identity.
    pub fn get(&self, sheet_id: SheetId, cell_id: CellId) -> Option<&CellOverride> {
        self.overrides.iter()
            .find(|o| o.sheet_id == sheet_id && o.cell_id == cell_id)
    }

    /// Get a mutable override by cell identity.
    pub fn get_mut(&mut self, sheet_id: SheetId, cell_id: CellId) -> Option<&mut CellOverride> {
        self.overrides.iter_mut()
            .find(|o| o.sheet_id == sheet_id && o.cell_id == cell_id)
    }

    /// Create or update an override for a cell.
    pub fn set_override(&mut self, override_entry: CellOverride) {
        let sheet_id = override_entry.sheet_id;
        let cell_id = override_entry.cell_id;

        if let Some(existing) = self.get_mut(sheet_id, cell_id) {
            *existing = override_entry;
        } else {
            self.overrides.push(override_entry);
        }
    }

    /// Remove an override (revert to upstream).
    pub fn remove_override(&mut self, sheet_id: SheetId, cell_id: CellId) -> bool {
        let len_before = self.overrides.len();
        self.overrides.retain(|o| !(o.sheet_id == sheet_id && o.cell_id == cell_id));
        self.overrides.len() < len_before
    }

    /// Get all overrides for a given sheet.
    pub fn overrides_for_sheet(&self, sheet_id: SheetId) -> Vec<&CellOverride> {
        self.overrides.iter()
            .filter(|o| o.sheet_id == sheet_id)
            .collect()
    }

    /// Get all overrides that are in conflict.
    pub fn conflicts(&self) -> Vec<&CellOverride> {
        self.overrides.iter()
            .filter(|o| o.conflict)
            .collect()
    }

    /// Count of overrides.
    pub fn count(&self) -> usize {
        self.overrides.len()
    }

    /// Count of conflicts.
    pub fn conflict_count(&self) -> usize {
        self.overrides.iter().filter(|o| o.conflict).count()
    }

    /// Auto-clear overrides whose current value matches the new upstream value.
    /// Returns the number of overrides cleared.
    pub fn auto_clear_matching(&mut self) -> usize {
        let len_before = self.overrides.len();
        self.overrides.retain(|o| {
            if let Some(ref upstream_new) = o.upstream_new {
                // If the override value now matches upstream, clear it
                if o.current == *upstream_new {
                    return false; // remove
                }
            }
            // Also clear if current matches baseline (consumer undid their change)
            if o.current == o.baseline {
                return false;
            }
            true
        });
        len_before - self.overrides.len()
    }

    /// Rebase overrides after a refresh. For each override:
    /// - If upstream changed the cell → mark as conflict, record new upstream value
    /// - If upstream didn't change → update baseline to new upstream value (no conflict)
    /// - If override now matches new upstream → auto-clear
    ///
    /// `upstream_values` maps (sheet_id, cell_id) to the new upstream value.
    /// Returns (conflicts_created, overrides_auto_cleared).
    pub fn rebase(
        &mut self,
        upstream_values: &HashMap<(SheetId, CellId), OverrideValue>,
    ) -> (usize, usize) {
        let mut conflicts = 0;

        for ovr in self.overrides.iter_mut() {
            let key = (ovr.sheet_id, ovr.cell_id);
            if let Some(new_upstream) = upstream_values.get(&key) {
                if *new_upstream != ovr.baseline {
                    // Upstream changed — conflict
                    ovr.conflict = true;
                    ovr.upstream_new = Some(new_upstream.clone());
                    conflicts += 1;
                } else {
                    // Upstream unchanged — no conflict, clear any prior conflict
                    ovr.conflict = false;
                    ovr.upstream_new = None;
                }
            }
        }

        let cleared = self.auto_clear_matching();
        (conflicts, cleared)
    }

    /// Resolve a conflict by accepting the upstream value (discard override).
    pub fn accept_upstream(&mut self, sheet_id: SheetId, cell_id: CellId) -> bool {
        self.remove_override(sheet_id, cell_id)
    }

    /// Resolve a conflict by keeping the override (rebase onto new upstream baseline).
    pub fn keep_override(&mut self, sheet_id: SheetId, cell_id: CellId) -> bool {
        if let Some(ovr) = self.get_mut(sheet_id, cell_id) {
            if let Some(new_upstream) = ovr.upstream_new.take() {
                ovr.baseline = new_upstream;
                ovr.conflict = false;
                return true;
            }
        }
        false
    }

    /// Check if a cell is locked (no-override) based on the version manifest's lock lists.
    pub fn is_locked(
        sheet_id: SheetId,
        cell_id: CellId,
        locked_sheets: &[SheetId],
        locked_cells: &[(SheetId, CellId)],
    ) -> bool {
        if locked_sheets.contains(&sheet_id) {
            return true;
        }
        locked_cells.contains(&(sheet_id, cell_id))
    }

    /// Remove all overrides for a given sheet (used when a sheet is deleted from upstream).
    pub fn remove_sheet_overrides(&mut self, sheet_id: SheetId) -> usize {
        let len_before = self.overrides.len();
        self.overrides.retain(|o| o.sheet_id != sheet_id);
        len_before - self.overrides.len()
    }
}

/// Efficient lookup index for overrides.
pub struct OverrideIndex {
    map: HashMap<(SheetId, CellId), usize>,
}

impl OverrideIndex {
    pub fn contains(&self, sheet_id: SheetId, cell_id: CellId) -> bool {
        self.map.contains_key(&(sheet_id, cell_id))
    }

    pub fn get_index(&self, sheet_id: SheetId, cell_id: CellId) -> Option<usize> {
        self.map.get(&(sheet_id, cell_id)).copied()
    }
}

/// Export format for overrides — a standalone patch that can be applied to
/// any .cala subscribed to the same upstream package.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverridePatch {
    pub format_version: u32,
    /// Which package these overrides apply to.
    pub package_name: String,
    /// The version the overrides were created against.
    pub baseline_version: String,
    /// The overrides themselves.
    pub overrides: Vec<CellOverride>,
    /// ISO 8601 timestamp of export.
    pub exported_at: String,
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

impl OverridePatch {
    /// Create a patch from the current override layer.
    pub fn from_layer(
        layer: &OverrideLayer,
        package_name: &str,
        baseline_version: &str,
        now: &str,
    ) -> Self {
        Self {
            format_version: 1,
            package_name: package_name.to_string(),
            baseline_version: baseline_version.to_string(),
            overrides: layer.overrides.clone(),
            exported_at: now.to_string(),
            extra: HashMap::new(),
        }
    }

    /// Apply this patch to an override layer.
    /// Overrides in the patch replace any existing override for the same cell.
    pub fn apply_to(&self, layer: &mut OverrideLayer) {
        for ovr in &self.overrides {
            layer.set_override(ovr.clone());
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_ids() -> (SheetId, CellId) {
        (
            SheetId::from_bytes(identity::generate_uuid_v7()),
            CellId::from_bytes(identity::generate_uuid_v7()),
        )
    }

    fn make_override(sheet_id: SheetId, cell_id: CellId, baseline: &str, current: &str) -> CellOverride {
        CellOverride {
            sheet_id,
            cell_id,
            position: (0, 0),
            baseline: OverrideValue::Value { display: baseline.to_string() },
            current: OverrideValue::Value { display: current.to_string() },
            created_at: "2026-01-01T00:00:00Z".to_string(),
            modified_at: "2026-01-01T00:00:00Z".to_string(),
            author: String::new(),
            conflict: false,
            upstream_new: None,
            extra: HashMap::new(),
        }
    }

    #[test]
    fn create_and_retrieve_override() {
        let mut layer = OverrideLayer::new();
        let (s, c) = make_ids();

        layer.set_override(make_override(s, c, "100", "200"));

        assert_eq!(layer.count(), 1);
        let ovr = layer.get(s, c).unwrap();
        assert_eq!(ovr.current, OverrideValue::Value { display: "200".to_string() });
    }

    #[test]
    fn update_existing_override() {
        let mut layer = OverrideLayer::new();
        let (s, c) = make_ids();

        layer.set_override(make_override(s, c, "100", "200"));
        layer.set_override(make_override(s, c, "100", "300"));

        assert_eq!(layer.count(), 1);
        assert_eq!(layer.get(s, c).unwrap().current,
            OverrideValue::Value { display: "300".to_string() });
    }

    #[test]
    fn remove_override() {
        let mut layer = OverrideLayer::new();
        let (s, c) = make_ids();

        layer.set_override(make_override(s, c, "100", "200"));
        assert!(layer.remove_override(s, c));
        assert_eq!(layer.count(), 0);
        assert!(layer.get(s, c).is_none());
    }

    #[test]
    fn overrides_for_sheet() {
        let mut layer = OverrideLayer::new();
        let s1 = SheetId::from_bytes(identity::generate_uuid_v7());
        let s2 = SheetId::from_bytes(identity::generate_uuid_v7());
        let c1 = CellId::from_bytes(identity::generate_uuid_v7());
        let c2 = CellId::from_bytes(identity::generate_uuid_v7());
        let c3 = CellId::from_bytes(identity::generate_uuid_v7());

        layer.set_override(make_override(s1, c1, "a", "b"));
        layer.set_override(make_override(s1, c2, "c", "d"));
        layer.set_override(make_override(s2, c3, "e", "f"));

        assert_eq!(layer.overrides_for_sheet(s1).len(), 2);
        assert_eq!(layer.overrides_for_sheet(s2).len(), 1);
    }

    #[test]
    fn auto_clear_matching_baseline() {
        let mut layer = OverrideLayer::new();
        let (s, c) = make_ids();

        // Override where current == baseline (consumer undid their change)
        layer.set_override(make_override(s, c, "100", "100"));
        let cleared = layer.auto_clear_matching();
        assert_eq!(cleared, 1);
        assert_eq!(layer.count(), 0);
    }

    #[test]
    fn auto_clear_matching_new_upstream() {
        let mut layer = OverrideLayer::new();
        let (s, c) = make_ids();

        let mut ovr = make_override(s, c, "100", "200");
        ovr.upstream_new = Some(OverrideValue::Value { display: "200".to_string() });
        layer.set_override(ovr);

        let cleared = layer.auto_clear_matching();
        assert_eq!(cleared, 1);
        assert_eq!(layer.count(), 0);
    }

    #[test]
    fn rebase_creates_conflicts() {
        let mut layer = OverrideLayer::new();
        let (s, c1) = make_ids();
        let c2 = CellId::from_bytes(identity::generate_uuid_v7());

        // Two overrides
        layer.set_override(make_override(s, c1, "100", "200")); // baseline=100
        layer.set_override(make_override(s, c2, "AAA", "BBB")); // baseline=AAA

        // Upstream changes c1 from 100 to 150, but c2 stays at AAA
        let mut upstream = HashMap::new();
        upstream.insert((s, c1), OverrideValue::Value { display: "150".to_string() });
        upstream.insert((s, c2), OverrideValue::Value { display: "AAA".to_string() });

        let (conflicts, cleared) = layer.rebase(&upstream);
        assert_eq!(conflicts, 1); // c1 is conflicted
        assert_eq!(cleared, 0);

        assert!(layer.get(s, c1).unwrap().conflict);
        assert!(!layer.get(s, c2).unwrap().conflict);
    }

    #[test]
    fn accept_upstream_resolves_conflict() {
        let mut layer = OverrideLayer::new();
        let (s, c) = make_ids();

        let mut ovr = make_override(s, c, "100", "200");
        ovr.conflict = true;
        ovr.upstream_new = Some(OverrideValue::Value { display: "150".to_string() });
        layer.set_override(ovr);

        assert!(layer.accept_upstream(s, c));
        assert_eq!(layer.count(), 0);
    }

    #[test]
    fn keep_override_resolves_conflict() {
        let mut layer = OverrideLayer::new();
        let (s, c) = make_ids();

        let mut ovr = make_override(s, c, "100", "200");
        ovr.conflict = true;
        ovr.upstream_new = Some(OverrideValue::Value { display: "150".to_string() });
        layer.set_override(ovr);

        assert!(layer.keep_override(s, c));
        let resolved = layer.get(s, c).unwrap();
        assert!(!resolved.conflict);
        // Baseline updated to new upstream value
        assert_eq!(resolved.baseline, OverrideValue::Value { display: "150".to_string() });
        // Consumer's value preserved
        assert_eq!(resolved.current, OverrideValue::Value { display: "200".to_string() });
    }

    #[test]
    fn locked_cell_detection() {
        let s1 = SheetId::from_bytes(identity::generate_uuid_v7());
        let s2 = SheetId::from_bytes(identity::generate_uuid_v7());
        let c1 = CellId::from_bytes(identity::generate_uuid_v7());
        let c2 = CellId::from_bytes(identity::generate_uuid_v7());

        let locked_sheets = vec![s1];
        let locked_cells = vec![(s2, c2)];

        // Any cell on s1 is locked
        assert!(OverrideLayer::is_locked(s1, c1, &locked_sheets, &locked_cells));
        assert!(OverrideLayer::is_locked(s1, c2, &locked_sheets, &locked_cells));

        // Specific cell on s2
        assert!(OverrideLayer::is_locked(s2, c2, &locked_sheets, &locked_cells));
        assert!(!OverrideLayer::is_locked(s2, c1, &locked_sheets, &locked_cells));
    }

    #[test]
    fn remove_sheet_overrides() {
        let mut layer = OverrideLayer::new();
        let s1 = SheetId::from_bytes(identity::generate_uuid_v7());
        let s2 = SheetId::from_bytes(identity::generate_uuid_v7());
        let c1 = CellId::from_bytes(identity::generate_uuid_v7());
        let c2 = CellId::from_bytes(identity::generate_uuid_v7());

        layer.set_override(make_override(s1, c1, "a", "b"));
        layer.set_override(make_override(s1, c2, "c", "d"));
        layer.set_override(make_override(s2, c1, "e", "f"));

        let removed = layer.remove_sheet_overrides(s1);
        assert_eq!(removed, 2);
        assert_eq!(layer.count(), 1);
    }

    #[test]
    fn override_index_lookup() {
        let mut layer = OverrideLayer::new();
        let (s, c1) = make_ids();
        let c2 = CellId::from_bytes(identity::generate_uuid_v7());

        layer.set_override(make_override(s, c1, "a", "b"));

        let idx = layer.index();
        assert!(idx.contains(s, c1));
        assert!(!idx.contains(s, c2));
    }

    #[test]
    fn override_patch_export_import() {
        let mut layer = OverrideLayer::new();
        let (s, c) = make_ids();
        layer.set_override(make_override(s, c, "100", "200"));

        let patch = OverridePatch::from_layer(&layer, "my-pkg", "1.0.0", "2026-01-01T00:00:00Z");
        assert_eq!(patch.overrides.len(), 1);
        assert_eq!(patch.package_name, "my-pkg");

        // Roundtrip via JSON
        let json = serde_json::to_string(&patch).unwrap();
        let deserialized: OverridePatch = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.overrides.len(), 1);

        // Apply to a new empty layer
        let mut new_layer = OverrideLayer::new();
        deserialized.apply_to(&mut new_layer);
        assert_eq!(new_layer.count(), 1);
        assert_eq!(new_layer.get(s, c).unwrap().current,
            OverrideValue::Value { display: "200".to_string() });
    }

    #[test]
    fn serde_roundtrip() {
        let mut layer = OverrideLayer::new();
        let (s, c) = make_ids();

        let mut ovr = make_override(s, c, "100", "200");
        ovr.conflict = true;
        ovr.upstream_new = Some(OverrideValue::Formula { formula: "SUM(A1:A10)".to_string() });
        layer.set_override(ovr);

        let json = serde_json::to_string_pretty(&layer).unwrap();
        let deserialized: OverrideLayer = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.count(), 1);
        let d_ovr = deserialized.get(s, c).unwrap();
        assert!(d_ovr.conflict);
        assert_eq!(d_ovr.upstream_new, Some(OverrideValue::Formula { formula: "SUM(A1:A10)".to_string() }));
    }
}
