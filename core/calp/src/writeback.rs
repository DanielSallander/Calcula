//! FILENAME: core/calp/src/writeback.rs
//! PURPOSE: Writeback region types and index for v1.0 readiness.
//! CONTEXT: v1.1 introduces writeback — publisher-designated regions where
//! subscribers contribute input. v1.0 parses the declarations, builds a
//! positional index for guard lookups, and round-trips the opaque sub-fields.
//! No writeback behavior exists in v1.0; only the structural prerequisites.

use std::collections::HashMap;

use identity::SheetId;
use serde::{Deserialize, Serialize};

use crate::error::CalpError;

// ---------------------------------------------------------------------------
// Manifest types (persisted in version-manifest.json)
// ---------------------------------------------------------------------------

/// A writeback region declaration in the .calp manifest.
/// v1.0 interprets only `id` and `selector`; all other fields are opaque
/// JSON values stored and round-tripped without inspection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WritebackRegionDeclaration {
    /// Unique region identifier (UUID v7).
    pub id: String,
    /// Positional selector: which sheet and range this region covers.
    pub selector: RegionSelector,
    // Semantic fields — opaque in v1.0, strongly-typed in v1.1:
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visibility: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submission_policy: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version_binding: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifecycle: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aggregation_hint: Option<String>,
    /// Forward-compatibility: preserves unknown fields from future format versions.
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Positional region selector: a rectangular range on a specific sheet.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionSelector {
    pub sheet_id: SheetId,
    /// First row of the region (0-indexed, inclusive).
    pub row_start: u32,
    /// Last row of the region (0-indexed, inclusive).
    pub row_end: u32,
    /// First column of the region (0-indexed, inclusive).
    pub col_start: u32,
    /// Last column of the region (0-indexed, inclusive).
    pub col_end: u32,
}

// ---------------------------------------------------------------------------
// Positional range (runtime)
// ---------------------------------------------------------------------------

/// A positional range on a sheet, used for runtime lookups.
#[derive(Debug, Clone, PartialEq)]
pub struct PositionalRange {
    pub row_start: u32,
    pub row_end: u32,
    pub col_start: u32,
    pub col_end: u32,
}

impl PositionalRange {
    pub fn contains(&self, row: u32, col: u32) -> bool {
        row >= self.row_start && row <= self.row_end
            && col >= self.col_start && col <= self.col_end
    }

    pub fn overlaps(&self, other: &PositionalRange) -> bool {
        self.row_start <= other.row_end && self.row_end >= other.row_start
            && self.col_start <= other.col_end && self.col_end >= other.col_start
    }
}

// ---------------------------------------------------------------------------
// Writeback index (runtime lookup structure)
// ---------------------------------------------------------------------------

/// Runtime index for fast writeback-region containment checks.
/// Built from manifest declarations at subscription load; rebuilt on refresh.
#[derive(Debug)]
pub struct WritebackIndex {
    /// Per-sheet list of positional ranges that are writeback-designated.
    regions_by_sheet: HashMap<SheetId, Vec<PositionalRange>>,
}

impl WritebackIndex {
    /// Build an index from a slice of declarations.
    /// Validates declarations and returns an error for malformed input:
    /// - `row_end < row_start` or `col_end < col_start`
    /// - Overlapping regions on the same sheet
    pub fn from_declarations(
        decls: &[WritebackRegionDeclaration],
    ) -> Result<Self, CalpError> {
        let mut regions_by_sheet: HashMap<SheetId, Vec<PositionalRange>> = HashMap::new();

        for decl in decls {
            let sel = &decl.selector;

            // Validate range bounds
            if sel.row_end < sel.row_start {
                return Err(CalpError::Format(format!(
                    "Writeback region '{}': row_end ({}) < row_start ({})",
                    decl.id, sel.row_end, sel.row_start,
                )));
            }
            if sel.col_end < sel.col_start {
                return Err(CalpError::Format(format!(
                    "Writeback region '{}': col_end ({}) < col_start ({})",
                    decl.id, sel.col_end, sel.col_start,
                )));
            }

            let range = PositionalRange {
                row_start: sel.row_start,
                row_end: sel.row_end,
                col_start: sel.col_start,
                col_end: sel.col_end,
            };

            // Check for overlaps with existing regions on the same sheet
            let sheet_ranges = regions_by_sheet.entry(sel.sheet_id).or_default();
            for existing in sheet_ranges.iter() {
                if range.overlaps(existing) {
                    return Err(CalpError::Format(format!(
                        "Writeback region '{}': overlaps with an existing region on sheet {}",
                        decl.id, sel.sheet_id,
                    )));
                }
            }

            sheet_ranges.push(range);
        }

        Ok(Self { regions_by_sheet })
    }

    /// Create an empty index (no writeback regions).
    pub fn empty() -> Self {
        Self { regions_by_sheet: HashMap::new() }
    }

    /// Check if a cell is within any writeback region.
    // Linear scan over regions per sheet. For typical N (small number of
    // regions, often whole-sheet), this is fine. Replace with interval tree
    // if region count per sheet exceeds ~50 or batch operations become hot.
    pub fn contains(&self, sheet_id: SheetId, row: u32, col: u32) -> bool {
        match self.regions_by_sheet.get(&sheet_id) {
            Some(ranges) => ranges.iter().any(|r| r.contains(row, col)),
            None => false,
        }
    }

    /// Find all regions that overlap with the given range on a sheet.
    pub fn regions_overlapping(
        &self,
        sheet_id: SheetId,
        query: &PositionalRange,
    ) -> Vec<&PositionalRange> {
        match self.regions_by_sheet.get(&sheet_id) {
            Some(ranges) => ranges.iter().filter(|r| r.overlaps(query)).collect(),
            None => Vec::new(),
        }
    }

    /// Whether the index has any regions at all.
    pub fn is_empty(&self) -> bool {
        self.regions_by_sheet.values().all(|v| v.is_empty())
    }

    /// Get the flat list of all regions (for serialization to the frontend).
    /// `sheet_id_to_index` maps stable SheetIds to local workbook sheet indices.
    pub fn to_flat_list(
        &self,
        sheet_id_to_index: &HashMap<SheetId, usize>,
    ) -> Vec<WritebackRegionEntry> {
        let mut entries = Vec::new();
        for (&sheet_id, ranges) in &self.regions_by_sheet {
            let sheet_index = sheet_id_to_index.get(&sheet_id).copied().unwrap_or(0);
            for range in ranges {
                entries.push(WritebackRegionEntry {
                    sheet_id,
                    sheet_index,
                    row_start: range.row_start,
                    row_end: range.row_end,
                    col_start: range.col_start,
                    col_end: range.col_end,
                });
            }
        }
        entries
    }
}

impl Default for WritebackIndex {
    fn default() -> Self {
        Self::empty()
    }
}

/// Flat entry for Tauri IPC — the frontend builds its own lookup structure.
/// Includes both the stable `sheet_id` and the local `sheet_index` for
/// fast frontend guard evaluation without requiring a separate ID-to-index map.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WritebackRegionEntry {
    pub sheet_id: SheetId,
    /// The local sheet index in the workbook (set by the caller, not by the index).
    #[serde(default)]
    pub sheet_index: usize,
    pub row_start: u32,
    pub row_end: u32,
    pub col_start: u32,
    pub col_end: u32,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_sheet_id() -> SheetId {
        SheetId::from_bytes(identity::generate_uuid_v7())
    }

    fn make_decl(id: &str, sheet_id: SheetId, r0: u32, r1: u32, c0: u32, c1: u32) -> WritebackRegionDeclaration {
        WritebackRegionDeclaration {
            id: id.to_string(),
            selector: RegionSelector {
                sheet_id,
                row_start: r0,
                row_end: r1,
                col_start: c0,
                col_end: c1,
            },
            mode: None,
            schema: None,
            visibility: None,
            submission_policy: None,
            version_binding: None,
            lifecycle: None,
            aggregation_hint: None,
            extra: HashMap::new(),
        }
    }

    #[test]
    fn empty_index() {
        let idx = WritebackIndex::from_declarations(&[]).unwrap();
        assert!(idx.is_empty());
        assert!(!idx.contains(make_sheet_id(), 0, 0));
    }

    #[test]
    fn single_region_containment() {
        let s = make_sheet_id();
        let decls = vec![make_decl("r1", s, 5, 10, 2, 4)];
        let idx = WritebackIndex::from_declarations(&decls).unwrap();

        // Inside
        assert!(idx.contains(s, 5, 2));
        assert!(idx.contains(s, 10, 4));
        assert!(idx.contains(s, 7, 3));

        // Outside
        assert!(!idx.contains(s, 4, 3));
        assert!(!idx.contains(s, 11, 3));
        assert!(!idx.contains(s, 7, 1));
        assert!(!idx.contains(s, 7, 5));

        // Wrong sheet
        assert!(!idx.contains(make_sheet_id(), 7, 3));
    }

    #[test]
    fn multiple_regions_same_sheet() {
        let s = make_sheet_id();
        let decls = vec![
            make_decl("r1", s, 0, 5, 0, 3),
            make_decl("r2", s, 10, 15, 0, 3),
        ];
        let idx = WritebackIndex::from_declarations(&decls).unwrap();

        assert!(idx.contains(s, 2, 1));   // in r1
        assert!(idx.contains(s, 12, 2));  // in r2
        assert!(!idx.contains(s, 7, 1));  // gap between r1 and r2
    }

    #[test]
    fn multiple_sheets() {
        let s1 = make_sheet_id();
        let s2 = make_sheet_id();
        let decls = vec![
            make_decl("r1", s1, 0, 5, 0, 3),
            make_decl("r2", s2, 10, 20, 0, 10),
        ];
        let idx = WritebackIndex::from_declarations(&decls).unwrap();

        assert!(idx.contains(s1, 3, 2));
        assert!(!idx.contains(s1, 15, 5));
        assert!(idx.contains(s2, 15, 5));
        assert!(!idx.contains(s2, 3, 2));
    }

    #[test]
    fn overlapping_query() {
        let s = make_sheet_id();
        let decls = vec![
            make_decl("r1", s, 0, 10, 0, 5),
            make_decl("r2", s, 20, 30, 0, 5),
        ];
        let idx = WritebackIndex::from_declarations(&decls).unwrap();

        let query = PositionalRange { row_start: 5, row_end: 25, col_start: 0, col_end: 5 };
        let overlapping = idx.regions_overlapping(s, &query);
        assert_eq!(overlapping.len(), 2); // both regions overlap

        let query2 = PositionalRange { row_start: 12, row_end: 18, col_start: 0, col_end: 5 };
        let overlapping2 = idx.regions_overlapping(s, &query2);
        assert_eq!(overlapping2.len(), 0); // gap
    }

    #[test]
    fn to_flat_list() {
        let s = make_sheet_id();
        let decls = vec![
            make_decl("r1", s, 0, 5, 0, 3),
            make_decl("r2", s, 10, 15, 0, 3),
        ];
        let idx = WritebackIndex::from_declarations(&decls).unwrap();
        let mut id_map = HashMap::new();
        id_map.insert(s, 0usize);
        let list = idx.to_flat_list(&id_map);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].sheet_index, 0);
    }

    // --- Validation tests ---

    #[test]
    fn rejects_inverted_rows() {
        let s = make_sheet_id();
        let decls = vec![make_decl("bad", s, 10, 5, 0, 3)]; // row_end < row_start
        let result = WritebackIndex::from_declarations(&decls);
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("row_end"));
    }

    #[test]
    fn rejects_inverted_cols() {
        let s = make_sheet_id();
        let decls = vec![make_decl("bad", s, 0, 5, 10, 3)]; // col_end < col_start
        let result = WritebackIndex::from_declarations(&decls);
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("col_end"));
    }

    #[test]
    fn rejects_overlapping_regions() {
        let s = make_sheet_id();
        let decls = vec![
            make_decl("r1", s, 0, 10, 0, 5),
            make_decl("r2", s, 5, 15, 3, 8), // overlaps with r1
        ];
        let result = WritebackIndex::from_declarations(&decls);
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("overlaps"));
    }

    #[test]
    fn allows_adjacent_non_overlapping_regions() {
        let s = make_sheet_id();
        let decls = vec![
            make_decl("r1", s, 0, 5, 0, 3),
            make_decl("r2", s, 6, 10, 0, 3), // adjacent, not overlapping
        ];
        let result = WritebackIndex::from_declarations(&decls);
        assert!(result.is_ok());
    }

    // --- Serde round-trip tests ---

    #[test]
    fn declaration_serde_roundtrip() {
        let s = make_sheet_id();
        let decl = WritebackRegionDeclaration {
            id: "test-region-1".to_string(),
            selector: RegionSelector {
                sheet_id: s,
                row_start: 0,
                row_end: 100,
                col_start: 0,
                col_end: 5,
            },
            mode: Some(serde_json::json!("per_subscriber")),
            schema: Some(serde_json::json!({"type": "number", "min": 0})),
            visibility: Some(serde_json::json!("own_plus_aggregate")),
            submission_policy: Some(serde_json::json!("on_submit")),
            version_binding: Some(serde_json::json!("lenient")),
            lifecycle: Some(serde_json::json!("always")),
            aggregation_hint: Some("SUM of regional forecasts".to_string()),
            extra: HashMap::new(),
        };

        let json = serde_json::to_string_pretty(&decl).unwrap();
        let roundtripped: WritebackRegionDeclaration = serde_json::from_str(&json).unwrap();

        assert_eq!(roundtripped.id, "test-region-1");
        assert_eq!(roundtripped.selector, decl.selector);
        assert_eq!(roundtripped.mode, Some(serde_json::json!("per_subscriber")));
        assert_eq!(roundtripped.aggregation_hint, Some("SUM of regional forecasts".to_string()));
    }

    #[test]
    fn declaration_preserves_unknown_extras() {
        // Simulate a v1.1 manifest with fields v1.0 doesn't know about
        let s = make_sheet_id();
        let json = serde_json::json!({
            "id": "region-x",
            "selector": {
                "sheetId": s.to_string(),
                "rowStart": 0,
                "rowEnd": 10,
                "colStart": 0,
                "colEnd": 5
            },
            "mode": "per_subscriber",
            "futureField": {"nested": true},
            "anotherFutureField": 42
        });

        let decl: WritebackRegionDeclaration = serde_json::from_value(json).unwrap();
        assert_eq!(decl.id, "region-x");
        assert!(decl.extra.contains_key("futureField"));
        assert!(decl.extra.contains_key("anotherFutureField"));

        // Round-trip preserves extras
        let re_json = serde_json::to_value(&decl).unwrap();
        assert_eq!(re_json["futureField"]["nested"], true);
        assert_eq!(re_json["anotherFutureField"], 42);
    }

    #[test]
    fn v11_manifest_roundtrip_through_v10() {
        // Simulate: v1.1 publisher creates a package with full writeback config.
        // v1.0 loads it, round-trips it. All semantic content must survive.
        let s = make_sheet_id();
        let v11_manifest_json = serde_json::json!({
            "id": "budget-input-region",
            "selector": {
                "sheetId": s.to_string(),
                "rowStart": 5,
                "rowEnd": 50,
                "colStart": 1,
                "colEnd": 3
            },
            "mode": "per_subscriber",
            "schema": {
                "type": "number",
                "required": true,
                "min": 0,
                "max": 1000000
            },
            "visibility": "own_plus_aggregate",
            "submissionPolicy": "on_submit",
            "versionBinding": "lenient",
            "lifecycle": {
                "policy": "until_deadline",
                "deadline": "2026-12-31T23:59:59Z"
            },
            "aggregationHint": "SUM for budget consolidation",
            "approvalWorkflow": {
                "enabled": true,
                "approvers": ["finance-lead@corp.com"]
            }
        });

        // v1.0 deserializes
        let decl: WritebackRegionDeclaration =
            serde_json::from_value(v11_manifest_json.clone()).unwrap();

        // v1.0 re-serializes
        let roundtripped = serde_json::to_value(&decl).unwrap();

        // All v1.1 semantic content survives
        assert_eq!(roundtripped["mode"], "per_subscriber");
        assert_eq!(roundtripped["schema"]["type"], "number");
        assert_eq!(roundtripped["schema"]["max"], 1000000);
        assert_eq!(roundtripped["visibility"], "own_plus_aggregate");
        assert_eq!(roundtripped["submissionPolicy"], "on_submit");
        assert_eq!(roundtripped["versionBinding"], "lenient");
        assert_eq!(roundtripped["lifecycle"]["deadline"], "2026-12-31T23:59:59Z");
        assert_eq!(roundtripped["aggregationHint"], "SUM for budget consolidation");
        // Unknown v1.1 field preserved via extras
        assert_eq!(roundtripped["approvalWorkflow"]["enabled"], true);
    }
}
