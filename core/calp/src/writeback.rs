//! FILENAME: core/calp/src/writeback.rs
//! PURPOSE: Writeback region types, semantic enums, and runtime index.
//! CONTEXT: v1.1 introduces writeback — publisher-designated regions where
//! subscribers contribute input. The manifest declarations carry strongly-typed
//! semantic fields (mode, schema, policies) alongside the positional selector.

use std::collections::HashMap;

use identity::SheetId;
use serde::{Deserialize, Serialize};

use crate::error::CalpError;

// ---------------------------------------------------------------------------
// Semantic enums
// ---------------------------------------------------------------------------

/// How subscriber contributions are organized within a writeback region.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WritebackMode {
    /// Each subscriber owns a private slot keyed by their identity.
    PerSubscriber,
    /// Shared list-object cell; each subscriber appends a tagged entry.
    ListObject,
}

/// Allowed value types for a writeback region.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValueType {
    Number,
    Integer,
    Text,
    Date,
    Boolean,
    Enum,
}

/// Schema describing what values a writeback region accepts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueSchema {
    /// The value type accepted by this region.
    pub value_type: ValueType,
    /// Whether a value is required (cannot leave empty).
    #[serde(default)]
    pub required: bool,
    /// Minimum bound for numbers/integers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    /// Maximum bound for numbers/integers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    /// Allowed values for enum type.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub enum_values: Vec<String>,
    /// Maximum text length.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_length: Option<usize>,
    /// Regex pattern for text validation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    /// Forward-compatibility.
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Who can see what within a writeback region.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VisibilityPolicy {
    /// Subscribers see only their own contribution; publisher sees all.
    OwnOnly,
    /// Subscribers see their own + the aggregated rollup; publisher sees all.
    OwnPlusAggregate,
    /// Everyone sees everyone's individual contributions.
    Transparent,
}

/// When a contribution becomes visible to others.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubmissionPolicy {
    /// Visible immediately on save.
    Immediate,
    /// Requires explicit submit action; save without submit is private draft.
    OnSubmit,
    /// Submission queued for publisher approval before joining aggregate.
    OnApproval,
}

/// How submissions are handled across package version changes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VersionBinding {
    /// Submissions invalidated on new version; must be redone.
    Strict,
    /// Submissions carry forward if region schema is compatible.
    Lenient,
}

/// Post-submission re-edit policy.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "policy")]
pub enum LifecyclePolicy {
    /// Re-submission always allowed.
    Always,
    /// Re-submission allowed until a deadline.
    UntilDeadline {
        /// ISO 8601 timestamp. None means no deadline set (effectively Always).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        deadline: Option<String>,
    },
    /// One-shot: no re-submission after initial submit.
    Never,
    /// Publisher must explicitly unlock for re-edit.
    RequiresUnlock,
}

// ---------------------------------------------------------------------------
// Manifest types (persisted in version-manifest.json)
// ---------------------------------------------------------------------------

/// A writeback region declaration in the .calp manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WritebackRegionDeclaration {
    /// Unique region identifier (UUID v7).
    pub id: String,
    /// Positional selector: which sheet and range this region covers.
    pub selector: RegionSelector,
    /// How subscriber contributions are organized.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<WritebackMode>,
    /// What values the region accepts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<ValueSchema>,
    /// Who can see what.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visibility: Option<VisibilityPolicy>,
    /// When contributions become visible.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submission_policy: Option<SubmissionPolicy>,
    /// How submissions are handled across version changes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version_binding: Option<VersionBinding>,
    /// Post-submission re-edit policy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifecycle: Option<LifecyclePolicy>,
    /// Publisher's hint about how they aggregate this region.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aggregation_hint: Option<String>,
    /// Identifiers (names/emails) the publisher expects to respond, for
    /// completion tracking. Matched case-insensitively against each submission's
    /// submitter display name or id. Empty = no tracking.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub expected_respondents: Vec<String>,
    /// Forward-compatibility: preserves unknown fields from future format versions.
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Best-effort date recognizer for writeback validation: accepts common
/// year-first / day-first / month-first formats and the date part of an ISO
/// datetime. Rejects free text — so "1/1/26" is accepted but "garbagexx" is not.
fn parse_date_text(s: &str) -> bool {
    use chrono::NaiveDate;
    let s = s.trim();
    if s.is_empty() {
        return false;
    }
    // ISO 8601 datetime ("2026-01-15T10:00" / "2026-01-15 10:00") -> date part.
    let date_part = s.split(|c| c == 'T' || c == ' ').next().unwrap_or(s);
    const FORMATS: &[&str] = &[
        "%Y-%m-%d", "%Y/%m/%d", "%m/%d/%Y", "%d/%m/%Y", "%m-%d-%Y", "%d-%m-%Y",
        "%d.%m.%Y", "%Y.%m.%d", "%m/%d/%y", "%d/%m/%y",
    ];
    FORMATS
        .iter()
        .any(|f| NaiveDate::parse_from_str(date_part, f).is_ok())
}

impl ValueSchema {
    /// Validate a submission value against this schema.
    /// Returns Ok(()) if valid, Err(message) if invalid.
    pub fn validate(&self, value: &SubmissionValue) -> Result<(), String> {
        // Check required — Empty, or whitespace-only text, both count as blank.
        if self.required {
            let blank = match value {
                SubmissionValue::Empty => true,
                SubmissionValue::Text { value } => value.trim().is_empty(),
                _ => false,
            };
            if blank {
                return Err("This field is required.".to_string());
            }
        }

        // If empty and not required, that's fine
        if matches!(value, SubmissionValue::Empty) {
            return Ok(());
        }

        match self.value_type {
            ValueType::Number | ValueType::Integer => {
                let n = match value {
                    SubmissionValue::Number { value } => *value,
                    SubmissionValue::Text { value } => {
                        value.parse::<f64>().map_err(|_| {
                            format!("Expected a number, got '{}'.", value)
                        })?
                    }
                    _ => return Err("Expected a number.".to_string()),
                };
                if self.value_type == ValueType::Integer && n.fract() != 0.0 {
                    return Err(format!("Expected an integer, got {}.", n));
                }
                if let Some(min) = self.min {
                    if n < min {
                        return Err(format!("Value {} is below the minimum of {}.", n, min));
                    }
                }
                if let Some(max) = self.max {
                    if n > max {
                        return Err(format!("Value {} exceeds the maximum of {}.", n, max));
                    }
                }
            }
            ValueType::Text => {
                let text = match value {
                    SubmissionValue::Text { value } => value.as_str(),
                    _ => return Err("Expected text.".to_string()),
                };
                if let Some(max_len) = self.max_length {
                    // Count Unicode scalar values, not UTF-8 bytes — "café" / "日本語"
                    // must not over-count under a multi-byte encoding.
                    let len = text.chars().count();
                    if len > max_len {
                        return Err(format!(
                            "Text length {} exceeds maximum of {}.",
                            len, max_len,
                        ));
                    }
                }
                if let Some(ref pat) = self.pattern {
                    // A real (anchored) regex match. If the publisher's pattern
                    // fails to compile, fall back to a literal substring check so
                    // a malformed declaration can never crash validation.
                    let matches = match regex::Regex::new(pat) {
                        Ok(re) => re.is_match(text),
                        Err(_) => text.contains(pat.as_str()),
                    };
                    if !matches {
                        return Err(format!("Text does not match pattern '{}'.", pat));
                    }
                }
            }
            ValueType::Boolean => {
                if !matches!(value, SubmissionValue::Boolean { .. }) {
                    return Err("Expected a boolean (TRUE or FALSE).".to_string());
                }
            }
            ValueType::Enum => {
                let text = match value {
                    SubmissionValue::Text { value } => value.as_str(),
                    _ => return Err("Expected one of the allowed values.".to_string()),
                };
                if !self.enum_values.iter().any(|v| v.eq_ignore_ascii_case(text)) {
                    return Err(format!(
                        "Value '{}' is not in the allowed list: {}.",
                        text,
                        self.enum_values.join(", "),
                    ));
                }
            }
            ValueType::Date => match value {
                // A spreadsheet date is commonly stored as a serial number;
                // accept any finite number as a date serial.
                SubmissionValue::Number { value } => {
                    if !value.is_finite() {
                        return Err("Expected a date value.".to_string());
                    }
                }
                SubmissionValue::Text { value } => {
                    if !parse_date_text(value) {
                        return Err(format!("'{}' is not a recognizable date.", value));
                    }
                }
                _ => return Err("Expected a date value.".to_string()),
            },
        }

        Ok(())
    }

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
    /// Region ID for each range, parallel to `regions_by_sheet` values.
    region_ids_by_sheet: HashMap<SheetId, Vec<String>>,
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
        let mut region_ids_by_sheet: HashMap<SheetId, Vec<String>> = HashMap::new();

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
            region_ids_by_sheet.entry(sel.sheet_id).or_default().push(decl.id.clone());
        }

        Ok(Self { regions_by_sheet, region_ids_by_sheet })
    }

    /// Create an empty index (no writeback regions).
    pub fn empty() -> Self {
        Self {
            regions_by_sheet: HashMap::new(),
            region_ids_by_sheet: HashMap::new(),
        }
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

    /// Get the region_id for the region containing a cell, if any.
    pub fn region_id_at(&self, sheet_id: SheetId, row: u32, col: u32) -> Option<&str> {
        if let Some(ranges) = self.regions_by_sheet.get(&sheet_id) {
            if let Some(ids) = self.region_ids_by_sheet.get(&sheet_id) {
                for (i, r) in ranges.iter().enumerate() {
                    if r.contains(row, col) {
                        return ids.get(i).map(|s| s.as_str());
                    }
                }
            }
        }
        None
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
            let ids = self.region_ids_by_sheet.get(&sheet_id);
            for (i, range) in ranges.iter().enumerate() {
                let region_id = ids.and_then(|v| v.get(i))
                    .cloned()
                    .unwrap_or_default();
                entries.push(WritebackRegionEntry {
                    sheet_id,
                    sheet_index,
                    region_id,
                    row_start: range.row_start,
                    row_end: range.row_end,
                    col_start: range.col_start,
                    col_end: range.col_end,
                    // Filled by the app command from the region declarations.
                    value_type: None,
                    required: None,
                    deadline: None,
                    custom_validator: None,
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
    /// The writeback region declaration ID.
    pub region_id: String,
    pub row_start: u32,
    pub row_end: u32,
    pub col_start: u32,
    pub col_end: u32,
    /// Declared value type ("number"|"integer"|"text"|"date"|"boolean"|"enum"),
    /// so the client can coerce typed input to the right SubmissionValue instead
    /// of sniffing it from the string shape. Filled by the app command, not by
    /// `to_flat_list` (the index has no schema).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value_type: Option<String>,
    /// Whether the region's schema marks values required (for the UI).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    /// Submission deadline (ISO 8601) for an `until_deadline` region, surfaced
    /// so the subscriber UI can show a countdown / overdue state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline: Option<String>,
    /// The name of a publisher-declared custom validator (distribution brick 3),
    /// surfaced so the subscriber's client can run it as an ADVISORY as-you-type
    /// check. Hard enforcement stays with the built-in `ValueSchema` gate on the
    /// authoritative Rust submit path; a custom validator only adds a
    /// frontend-side UX check on top (a client without the named validator
    /// registered simply skips it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_validator: Option<String>,
}

// ---------------------------------------------------------------------------
// Schema compatibility (Phase 17)
// ---------------------------------------------------------------------------

impl ValueSchema {
    /// Check if a new schema is compatible with this one (for lenient version binding).
    /// Compatible means: same value type, new bounds are equal or wider.
    pub fn is_compatible_with(&self, new: &ValueSchema) -> bool {
        if self.value_type != new.value_type {
            return false;
        }
        // If old required but new not required, that's compatible (relaxed)
        // If old not required but new required, that's a breaking change
        if new.required && !self.required {
            return false;
        }
        // Check numeric bounds: new min must be <= old min, new max must be >= old max
        if let (Some(old_min), Some(new_min)) = (self.min, new.min) {
            if new_min > old_min { return false; }
        }
        if let (Some(old_max), Some(new_max)) = (self.max, new.max) {
            if new_max < old_max { return false; }
        }
        // For enums: new must contain all old values (case-insensitive, to match
        // validate()'s eq_ignore_ascii_case — otherwise a cosmetic casing change
        // on a version bump silently drops carried-forward answers).
        if self.value_type == ValueType::Enum {
            for val in &self.enum_values {
                if !new.enum_values.iter().any(|n| n.eq_ignore_ascii_case(val)) {
                    return false;
                }
            }
        }
        true
    }
}

/// Result of checking writeback region compatibility across versions.
#[derive(Debug, Clone)]
pub struct RegionCompatibility {
    /// Regions that exist in both old and new versions and are compatible.
    pub compatible: Vec<String>,
    /// Regions that exist in both but have incompatible schema changes.
    pub incompatible: Vec<(String, String)>, // (region_id, reason)
    /// Regions added in the new version.
    pub added: Vec<String>,
    /// Regions removed in the new version.
    pub removed: Vec<String>,
}

/// Compare writeback regions between two version manifests.
pub fn check_region_compatibility(
    old: &[WritebackRegionDeclaration],
    new: &[WritebackRegionDeclaration],
) -> RegionCompatibility {
    let mut result = RegionCompatibility {
        compatible: Vec::new(),
        incompatible: Vec::new(),
        added: Vec::new(),
        removed: Vec::new(),
    };

    let old_ids: std::collections::HashSet<&str> = old.iter().map(|r| r.id.as_str()).collect();
    let new_ids: std::collections::HashSet<&str> = new.iter().map(|r| r.id.as_str()).collect();

    // Added regions
    for id in &new_ids {
        if !old_ids.contains(id) {
            result.added.push(id.to_string());
        }
    }

    // Removed regions
    for id in &old_ids {
        if !new_ids.contains(id) {
            result.removed.push(id.to_string());
        }
    }

    // Compare shared regions
    for old_region in old {
        if let Some(new_region) = new.iter().find(|r| r.id == old_region.id) {
            match (&old_region.schema, &new_region.schema) {
                (Some(old_schema), Some(new_schema)) => {
                    if old_schema.is_compatible_with(new_schema) {
                        result.compatible.push(old_region.id.clone());
                    } else {
                        result.incompatible.push((
                            old_region.id.clone(),
                            "Schema changed incompatibly".to_string(),
                        ));
                    }
                }
                (None, _) | (_, None) => {
                    // No schema to compare — treat as compatible
                    result.compatible.push(old_region.id.clone());
                }
            }
        }
    }

    result
}

// ---------------------------------------------------------------------------
// Gather cache (pre-fetch for GATHER formula functions)
// ---------------------------------------------------------------------------

/// Pre-fetched submission data for GATHER formula evaluation.
/// Built once per evaluation session from registry data.
#[derive(Debug, Clone, Default)]
pub struct GatherCache {
    /// region_id -> list of submissions
    pub data: HashMap<String, Vec<WritebackSubmission>>,
}

impl GatherCache {
    pub fn new() -> Self {
        Self { data: HashMap::new() }
    }

    /// Build a cache from the registry for all writeback regions in the manifest.
    pub fn from_registry(
        registry: &crate::registry::LocalRegistry,
        package_name: &str,
        version: &str,
        regions: &[WritebackRegionDeclaration],
    ) -> Self {
        let mut data = HashMap::new();
        for region in regions {
            match registry.load_region_submissions(package_name, version, &region.id) {
                Ok(subs) => {
                    data.insert(region.id.clone(), subs);
                }
                Err(_) => {
                    data.insert(region.id.clone(), Vec::new());
                }
            }
        }
        Self { data }
    }

    /// Get submissions for a region.
    pub fn get(&self, region_id: &str) -> &[WritebackSubmission] {
        self.data.get(region_id).map(|v| v.as_slice()).unwrap_or(&[])
    }
}

// ---------------------------------------------------------------------------
// Submission types (Phase 14)
// ---------------------------------------------------------------------------

/// State of a writeback submission in its lifecycle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubmissionState {
    /// Saved locally, not yet submitted to the registry.
    Draft,
    /// Submitted to the registry and visible per the region's policies.
    Submitted,
    /// Submitted and approved by the publisher (for on_approval policy).
    Approved,
    /// Submitted but rejected by the publisher.
    Rejected,
}

/// A single cell value in a writeback submission.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SubmissionValue {
    #[serde(rename = "number")]
    Number { value: f64 },
    #[serde(rename = "text")]
    Text { value: String },
    #[serde(rename = "boolean")]
    Boolean { value: bool },
    #[serde(rename = "empty")]
    Empty,
}

/// A writeback submission: one subscriber's contribution to one cell.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WritebackSubmission {
    /// Unique submission ID (UUID v7).
    pub id: String,
    /// Which writeback region this belongs to.
    pub region_id: String,
    /// Cell position within the region.
    pub cell_row: u32,
    pub cell_col: u32,
    /// CellId (minted on first submission for this cell).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cell_id: Option<String>,
    /// Who submitted this.
    pub submitter: crate::identity_provider::SubmitterIdentity,
    /// The submitted value.
    pub value: SubmissionValue,
    /// Current state in the lifecycle.
    pub state: SubmissionState,
    /// ISO 8601 timestamp of creation.
    pub created_at: String,
    /// ISO 8601 timestamp of last update.
    pub updated_at: String,
    /// ISO 8601 timestamp of when it was submitted (state changed to Submitted).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submitted_at: Option<String>,
    /// Publisher's reason when approving/rejecting (the return-leg feedback a
    /// contributor sees — "too high", "wrong unit", etc.).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_reason: Option<String>,
    /// Display name of the publisher who made the approve/reject decision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewed_by: Option<String>,
    /// Forward-compatibility.
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Local writeback layer stored in the subscriber's .cala file.
/// Contains drafts (not yet submitted) and references to submitted data.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WritebackLayer {
    pub format_version: u32,
    /// Local drafts not yet submitted to the registry.
    pub drafts: Vec<WritebackSubmission>,
    /// Forward-compatibility.
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

impl WritebackLayer {
    pub fn new() -> Self {
        Self {
            format_version: 1,
            drafts: Vec::new(),
            extra: HashMap::new(),
        }
    }

    /// Find a draft for a specific cell.
    pub fn get_draft(&self, region_id: &str, row: u32, col: u32) -> Option<&WritebackSubmission> {
        self.drafts.iter().find(|d| {
            d.region_id == region_id && d.cell_row == row && d.cell_col == col
        })
    }

    /// Find a draft for a specific cell (mutable).
    pub fn get_draft_mut(&mut self, region_id: &str, row: u32, col: u32) -> Option<&mut WritebackSubmission> {
        self.drafts.iter_mut().find(|d| {
            d.region_id == region_id && d.cell_row == row && d.cell_col == col
        })
    }

    /// Set or update a draft for a cell. If a draft exists, update it; otherwise create one.
    pub fn set_draft(&mut self, submission: WritebackSubmission) {
        let region_id = submission.region_id.clone();
        let row = submission.cell_row;
        let col = submission.cell_col;
        if let Some(existing) = self.get_draft_mut(&region_id, row, col) {
            *existing = submission;
        } else {
            self.drafts.push(submission);
        }
    }

    /// Remove a draft for a cell.
    pub fn remove_draft(&mut self, region_id: &str, row: u32, col: u32) -> bool {
        let len_before = self.drafts.len();
        self.drafts.retain(|d| {
            !(d.region_id == region_id && d.cell_row == row && d.cell_col == col)
        });
        self.drafts.len() < len_before
    }

    /// Get all drafts for a specific region.
    pub fn drafts_for_region(&self, region_id: &str) -> Vec<&WritebackSubmission> {
        self.drafts.iter().filter(|d| d.region_id == region_id).collect()
    }

    /// Count of drafts.
    pub fn draft_count(&self) -> usize {
        self.drafts.len()
    }

    /// Mark all drafts for a region as Submitted and set the submitted_at timestamp.
    /// Returns the submissions that were advanced (for writing to the registry).
    pub fn submit_region(&mut self, region_id: &str, now: &str) -> Vec<WritebackSubmission> {
        let mut submitted = Vec::new();
        for draft in &mut self.drafts {
            if draft.region_id == region_id && draft.state == SubmissionState::Draft {
                draft.state = SubmissionState::Submitted;
                draft.submitted_at = Some(now.to_string());
                draft.updated_at = now.to_string();
                submitted.push(draft.clone());
            }
        }
        submitted
    }
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
            selector: RegionSelector { sheet_id, row_start: r0, row_end: r1, col_start: c0, col_end: c1 },
            mode: Some(WritebackMode::PerSubscriber),
            schema: None,
            visibility: None,
            submission_policy: None,
            version_binding: None,
            lifecycle: None,
            aggregation_hint: None,
            expected_respondents: Vec::new(),
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
            selector: RegionSelector { sheet_id: s, row_start: 0, row_end: 100, col_start: 0, col_end: 5 },
            mode: Some(WritebackMode::PerSubscriber),
            schema: Some(ValueSchema {
                value_type: ValueType::Number,
                required: false,
                min: Some(0.0),
                max: None,
                enum_values: Vec::new(),
                max_length: None,
                pattern: None,
                extra: HashMap::new(),
            }),
            visibility: Some(VisibilityPolicy::OwnPlusAggregate),
            submission_policy: Some(SubmissionPolicy::OnSubmit),
            version_binding: Some(VersionBinding::Lenient),
            lifecycle: Some(LifecyclePolicy::Always),
            aggregation_hint: Some("SUM of regional forecasts".to_string()),
            expected_respondents: Vec::new(),
            extra: HashMap::new(),
        };

        let json = serde_json::to_string_pretty(&decl).unwrap();
        let roundtripped: WritebackRegionDeclaration = serde_json::from_str(&json).unwrap();

        assert_eq!(roundtripped.id, "test-region-1");
        assert_eq!(roundtripped.selector, decl.selector);
        assert_eq!(roundtripped.mode, Some(WritebackMode::PerSubscriber));
        assert_eq!(roundtripped.visibility, Some(VisibilityPolicy::OwnPlusAggregate));
        assert_eq!(roundtripped.submission_policy, Some(SubmissionPolicy::OnSubmit));
        assert_eq!(roundtripped.version_binding, Some(VersionBinding::Lenient));
        assert_eq!(roundtripped.lifecycle, Some(LifecyclePolicy::Always));
        assert_eq!(roundtripped.aggregation_hint, Some("SUM of regional forecasts".to_string()));
        let schema = roundtripped.schema.unwrap();
        assert_eq!(schema.value_type, ValueType::Number);
        assert_eq!(schema.min, Some(0.0));
    }

    #[test]
    fn declaration_preserves_unknown_extras() {
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
        assert_eq!(decl.mode, Some(WritebackMode::PerSubscriber));
        assert!(decl.extra.contains_key("futureField"));
        assert!(decl.extra.contains_key("anotherFutureField"));

        // Round-trip preserves extras
        let re_json = serde_json::to_value(&decl).unwrap();
        assert_eq!(re_json["futureField"]["nested"], true);
        assert_eq!(re_json["anotherFutureField"], 42);
    }

    #[test]
    fn all_enum_variants_roundtrip() {
        // WritebackMode
        for (json_str, expected) in [
            ("\"per_subscriber\"", WritebackMode::PerSubscriber),
            ("\"list_object\"", WritebackMode::ListObject),
        ] {
            let parsed: WritebackMode = serde_json::from_str(json_str).unwrap();
            assert_eq!(parsed, expected);
            let re = serde_json::to_string(&parsed).unwrap();
            assert_eq!(re, json_str);
        }

        // VisibilityPolicy
        for (json_str, expected) in [
            ("\"own_only\"", VisibilityPolicy::OwnOnly),
            ("\"own_plus_aggregate\"", VisibilityPolicy::OwnPlusAggregate),
            ("\"transparent\"", VisibilityPolicy::Transparent),
        ] {
            let parsed: VisibilityPolicy = serde_json::from_str(json_str).unwrap();
            assert_eq!(parsed, expected);
        }

        // SubmissionPolicy
        for (json_str, expected) in [
            ("\"immediate\"", SubmissionPolicy::Immediate),
            ("\"on_submit\"", SubmissionPolicy::OnSubmit),
            ("\"on_approval\"", SubmissionPolicy::OnApproval),
        ] {
            let parsed: SubmissionPolicy = serde_json::from_str(json_str).unwrap();
            assert_eq!(parsed, expected);
        }

        // VersionBinding
        for (json_str, expected) in [
            ("\"strict\"", VersionBinding::Strict),
            ("\"lenient\"", VersionBinding::Lenient),
        ] {
            let parsed: VersionBinding = serde_json::from_str(json_str).unwrap();
            assert_eq!(parsed, expected);
        }

        // ValueType
        for (json_str, expected) in [
            ("\"number\"", ValueType::Number),
            ("\"integer\"", ValueType::Integer),
            ("\"text\"", ValueType::Text),
            ("\"date\"", ValueType::Date),
            ("\"boolean\"", ValueType::Boolean),
            ("\"enum\"", ValueType::Enum),
        ] {
            let parsed: ValueType = serde_json::from_str(json_str).unwrap();
            assert_eq!(parsed, expected);
        }
    }

    #[test]
    fn lifecycle_policy_variants_roundtrip() {
        // Always
        let json = serde_json::json!({"policy": "always"});
        let parsed: LifecyclePolicy = serde_json::from_value(json).unwrap();
        assert_eq!(parsed, LifecyclePolicy::Always);

        // UntilDeadline with deadline
        let json = serde_json::json!({"policy": "until_deadline", "deadline": "2026-12-31T23:59:59Z"});
        let parsed: LifecyclePolicy = serde_json::from_value(json).unwrap();
        assert_eq!(parsed, LifecyclePolicy::UntilDeadline { deadline: Some("2026-12-31T23:59:59Z".to_string()) });

        // UntilDeadline without deadline (effectively Always)
        let json = serde_json::json!({"policy": "until_deadline"});
        let parsed: LifecyclePolicy = serde_json::from_value(json).unwrap();
        assert_eq!(parsed, LifecyclePolicy::UntilDeadline { deadline: None });

        // Never
        let json = serde_json::json!({"policy": "never"});
        let parsed: LifecyclePolicy = serde_json::from_value(json).unwrap();
        assert_eq!(parsed, LifecyclePolicy::Never);

        // RequiresUnlock
        let json = serde_json::json!({"policy": "requires_unlock"});
        let parsed: LifecyclePolicy = serde_json::from_value(json).unwrap();
        assert_eq!(parsed, LifecyclePolicy::RequiresUnlock);

        // Round-trip all
        for policy in [
            LifecyclePolicy::Always,
            LifecyclePolicy::UntilDeadline { deadline: Some("2026-06-01T00:00:00Z".to_string()) },
            LifecyclePolicy::UntilDeadline { deadline: None },
            LifecyclePolicy::Never,
            LifecyclePolicy::RequiresUnlock,
        ] {
            let json = serde_json::to_value(&policy).unwrap();
            let roundtripped: LifecyclePolicy = serde_json::from_value(json).unwrap();
            assert_eq!(roundtripped, policy);
        }
    }

    #[test]
    fn value_schema_roundtrip() {
        let schema = ValueSchema {
            value_type: ValueType::Enum,
            required: true,
            min: None,
            max: None,
            enum_values: vec!["Low".to_string(), "Medium".to_string(), "High".to_string()],
            max_length: None,
            pattern: None,
            extra: HashMap::new(),
        };
        let json = serde_json::to_value(&schema).unwrap();
        let roundtripped: ValueSchema = serde_json::from_value(json).unwrap();
        assert_eq!(roundtripped.value_type, ValueType::Enum);
        assert_eq!(roundtripped.required, true);
        assert_eq!(roundtripped.enum_values, vec!["Low", "Medium", "High"]);
    }

    #[test]
    fn value_schema_with_extras_roundtrip() {
        let json = serde_json::json!({
            "valueType": "number",
            "required": true,
            "min": 0,
            "max": 100,
            "futureValidation": {"custom": true}
        });
        let schema: ValueSchema = serde_json::from_value(json).unwrap();
        assert_eq!(schema.value_type, ValueType::Number);
        assert!(schema.extra.contains_key("futureValidation"));

        let re_json = serde_json::to_value(&schema).unwrap();
        assert_eq!(re_json["futureValidation"]["custom"], true);
    }

    #[test]
    fn full_declaration_with_typed_fields_roundtrip() {
        let s = make_sheet_id();
        let json = serde_json::json!({
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
                "valueType": "number",
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

        let decl: WritebackRegionDeclaration = serde_json::from_value(json).unwrap();

        assert_eq!(decl.mode, Some(WritebackMode::PerSubscriber));
        assert_eq!(decl.visibility, Some(VisibilityPolicy::OwnPlusAggregate));
        assert_eq!(decl.submission_policy, Some(SubmissionPolicy::OnSubmit));
        assert_eq!(decl.version_binding, Some(VersionBinding::Lenient));
        assert_eq!(decl.lifecycle, Some(LifecyclePolicy::UntilDeadline {
            deadline: Some("2026-12-31T23:59:59Z".to_string()),
        }));
        let schema = decl.schema.as_ref().unwrap();
        assert_eq!(schema.value_type, ValueType::Number);
        assert_eq!(schema.required, true);
        assert_eq!(schema.max, Some(1000000.0));
        // Unknown field preserved via extras
        assert!(decl.extra.contains_key("approvalWorkflow"));

        // Round-trip
        let roundtripped_json = serde_json::to_value(&decl).unwrap();
        assert_eq!(roundtripped_json["mode"], "per_subscriber");
        assert_eq!(roundtripped_json["schema"]["max"], 1000000.0);
        assert_eq!(roundtripped_json["lifecycle"]["deadline"], "2026-12-31T23:59:59Z");
        assert_eq!(roundtripped_json["approvalWorkflow"]["enabled"], true);
    }

    #[test]
    fn missing_optional_fields_deserialize_as_none() {
        let s = make_sheet_id();
        let json = serde_json::json!({
            "id": "minimal",
            "selector": {
                "sheetId": s.to_string(),
                "rowStart": 0,
                "rowEnd": 5,
                "colStart": 0,
                "colEnd": 3
            }
        });
        let decl: WritebackRegionDeclaration = serde_json::from_value(json).unwrap();
        assert_eq!(decl.id, "minimal");
        assert!(decl.mode.is_none());
        assert!(decl.schema.is_none());
        assert!(decl.visibility.is_none());
        assert!(decl.submission_policy.is_none());
        assert!(decl.version_binding.is_none());
        assert!(decl.lifecycle.is_none());
        assert!(decl.aggregation_hint.is_none());
    }

    // --- Schema validation tests ---

    fn make_number_schema(required: bool, min: Option<f64>, max: Option<f64>) -> ValueSchema {
        ValueSchema {
            value_type: ValueType::Number,
            required,
            min,
            max,
            enum_values: Vec::new(),
            max_length: None,
            pattern: None,
            extra: HashMap::new(),
        }
    }

    #[test]
    fn schema_validates_number_in_range() {
        let schema = make_number_schema(true, Some(0.0), Some(100.0));
        assert!(schema.validate(&SubmissionValue::Number { value: 50.0 }).is_ok());
        assert!(schema.validate(&SubmissionValue::Number { value: 0.0 }).is_ok());
        assert!(schema.validate(&SubmissionValue::Number { value: 100.0 }).is_ok());
    }

    #[test]
    fn schema_rejects_number_out_of_range() {
        let schema = make_number_schema(false, Some(0.0), Some(100.0));
        let result = schema.validate(&SubmissionValue::Number { value: -1.0 });
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("below the minimum"));

        let result = schema.validate(&SubmissionValue::Number { value: 101.0 });
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("exceeds the maximum"));
    }

    #[test]
    fn schema_rejects_empty_when_required() {
        let schema = make_number_schema(true, None, None);
        let result = schema.validate(&SubmissionValue::Empty);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("required"));
    }

    #[test]
    fn schema_allows_empty_when_not_required() {
        let schema = make_number_schema(false, None, None);
        assert!(schema.validate(&SubmissionValue::Empty).is_ok());
    }

    #[test]
    fn schema_validates_enum() {
        let schema = ValueSchema {
            value_type: ValueType::Enum,
            required: true,
            min: None,
            max: None,
            enum_values: vec!["Low".to_string(), "Medium".to_string(), "High".to_string()],
            max_length: None,
            pattern: None,
            extra: HashMap::new(),
        };
        assert!(schema.validate(&SubmissionValue::Text { value: "Low".to_string() }).is_ok());
        assert!(schema.validate(&SubmissionValue::Text { value: "low".to_string() }).is_ok()); // case-insensitive

        let result = schema.validate(&SubmissionValue::Text { value: "Critical".to_string() });
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not in the allowed list"));
    }

    #[test]
    fn schema_validates_integer() {
        let schema = ValueSchema {
            value_type: ValueType::Integer,
            required: false,
            min: Some(1.0),
            max: Some(10.0),
            enum_values: Vec::new(),
            max_length: None,
            pattern: None,
            extra: HashMap::new(),
        };
        assert!(schema.validate(&SubmissionValue::Number { value: 5.0 }).is_ok());

        let result = schema.validate(&SubmissionValue::Number { value: 5.5 });
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("integer"));
    }

    #[test]
    fn schema_validates_text_length() {
        let schema = ValueSchema {
            value_type: ValueType::Text,
            required: false,
            min: None,
            max: None,
            enum_values: Vec::new(),
            max_length: Some(10),
            pattern: None,
            extra: HashMap::new(),
        };
        assert!(schema.validate(&SubmissionValue::Text { value: "short".to_string() }).is_ok());

        let result = schema.validate(&SubmissionValue::Text { value: "this is way too long".to_string() });
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("exceeds maximum"));
    }

    fn text_schema(max_length: Option<usize>, pattern: Option<&str>) -> ValueSchema {
        ValueSchema {
            value_type: ValueType::Text,
            required: false,
            min: None,
            max: None,
            enum_values: Vec::new(),
            max_length,
            pattern: pattern.map(|p| p.to_string()),
            extra: HashMap::new(),
        }
    }

    #[test]
    fn schema_max_length_counts_chars_not_bytes() {
        let schema = text_schema(Some(4), None);
        // 4 multi-byte chars are within a 4-CHAR limit (byte length would be >4).
        assert!(schema.validate(&SubmissionValue::Text { value: "café".to_string() }).is_ok());
        assert!(schema.validate(&SubmissionValue::Text { value: "日本語語".to_string() }).is_ok());
        // 5 chars -> rejected.
        assert!(schema.validate(&SubmissionValue::Text { value: "abcde".to_string() }).is_err());
    }

    #[test]
    fn schema_pattern_is_real_regex() {
        let schema = text_schema(None, Some(r"^\d{4}$"));
        assert!(schema.validate(&SubmissionValue::Text { value: "2026".to_string() }).is_ok());
        // The old substring behavior would WRONGLY accept this; real regex rejects.
        assert!(schema.validate(&SubmissionValue::Text { value: "year 2026!".to_string() }).is_err());
        assert!(schema.validate(&SubmissionValue::Text { value: "abcd".to_string() }).is_err());
    }

    #[test]
    fn schema_validates_real_dates() {
        let schema = ValueSchema {
            value_type: ValueType::Date,
            required: false,
            min: None,
            max: None,
            enum_values: Vec::new(),
            max_length: None,
            pattern: None,
            extra: HashMap::new(),
        };
        for ok in ["2026-01-15", "1/15/2026", "15/01/2026", "2026-01-15T10:30", "1/1/26"] {
            assert!(
                schema.validate(&SubmissionValue::Text { value: ok.to_string() }).is_ok(),
                "should accept date {ok}"
            );
        }
        for bad in ["garbagexx", "not a date", "hello123"] {
            assert!(
                schema.validate(&SubmissionValue::Text { value: bad.to_string() }).is_err(),
                "should reject non-date {bad}"
            );
        }
        // A spreadsheet serial number is a valid date.
        assert!(schema.validate(&SubmissionValue::Number { value: 45000.0 }).is_ok());
    }

    #[test]
    fn schema_required_rejects_whitespace_only_text() {
        let mut schema = text_schema(None, None);
        schema.required = true;
        assert!(schema.validate(&SubmissionValue::Text { value: "   ".to_string() }).is_err());
        assert!(schema.validate(&SubmissionValue::Empty).is_err());
        assert!(schema.validate(&SubmissionValue::Text { value: "ok".to_string() }).is_ok());
    }

    fn enum_schema(values: &[&str]) -> ValueSchema {
        ValueSchema {
            value_type: ValueType::Enum,
            required: false,
            min: None,
            max: None,
            enum_values: values.iter().map(|s| s.to_string()).collect(),
            max_length: None,
            pattern: None,
            extra: HashMap::new(),
        }
    }

    #[test]
    fn schema_enum_compatibility_is_case_insensitive() {
        let old = enum_schema(&["Low", "High"]);
        // Same values, different casing + an added one -> still compatible
        // (no silent drop of carried-forward answers on a cosmetic change).
        assert!(old.is_compatible_with(&enum_schema(&["LOW", "high", "Medium"])));
        // Actually dropping a value remains incompatible.
        assert!(!old.is_compatible_with(&enum_schema(&["Low"])));
    }

    #[test]
    fn schema_compatibility_same_type() {
        let old = make_number_schema(false, Some(0.0), Some(100.0));
        let new = make_number_schema(false, Some(0.0), Some(100.0));
        assert!(old.is_compatible_with(&new));
    }

    #[test]
    fn schema_compatibility_wider_bounds() {
        let old = make_number_schema(false, Some(0.0), Some(100.0));
        let new = make_number_schema(false, Some(-10.0), Some(200.0));
        assert!(old.is_compatible_with(&new));
    }

    #[test]
    fn schema_incompatible_narrower_bounds() {
        let old = make_number_schema(false, Some(0.0), Some(100.0));
        let new = make_number_schema(false, Some(10.0), Some(100.0)); // min tightened
        assert!(!old.is_compatible_with(&new));
    }

    #[test]
    fn schema_incompatible_type_change() {
        let old = make_number_schema(false, None, None);
        let new = ValueSchema {
            value_type: ValueType::Text,
            required: false,
            min: None,
            max: None,
            enum_values: Vec::new(),
            max_length: None,
            pattern: None,
            extra: HashMap::new(),
        };
        assert!(!old.is_compatible_with(&new));
    }

    // --- WritebackLayer tests ---

    fn make_submitter(name: &str) -> crate::identity_provider::SubmitterIdentity {
        crate::identity_provider::SubmitterIdentity {
            display_name: name.to_string(),
            id: format!("id-{}", name),
            extra: HashMap::new(),
        }
    }

    fn make_submission(region_id: &str, row: u32, col: u32, value: f64, submitter: &str) -> WritebackSubmission {
        WritebackSubmission {
            id: format!("sub-{}-{}-{}", region_id, row, col),
            region_id: region_id.to_string(),
            cell_row: row,
            cell_col: col,
            cell_id: None,
            submitter: make_submitter(submitter),
            value: SubmissionValue::Number { value },
            state: SubmissionState::Draft,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
            submitted_at: None,
            review_reason: None,
            reviewed_by: None,
            extra: HashMap::new(),
        }
    }

    #[test]
    fn writeback_layer_crud() {
        let mut layer = WritebackLayer::new();
        assert_eq!(layer.draft_count(), 0);

        layer.set_draft(make_submission("r1", 0, 0, 100.0, "alice"));
        assert_eq!(layer.draft_count(), 1);
        assert!(layer.get_draft("r1", 0, 0).is_some());

        // Update existing draft
        layer.set_draft(make_submission("r1", 0, 0, 200.0, "alice"));
        assert_eq!(layer.draft_count(), 1);
        if let SubmissionValue::Number { value } = &layer.get_draft("r1", 0, 0).unwrap().value {
            assert_eq!(*value, 200.0);
        } else {
            panic!("Expected number value");
        }

        // Remove
        assert!(layer.remove_draft("r1", 0, 0));
        assert_eq!(layer.draft_count(), 0);
        assert!(!layer.remove_draft("r1", 0, 0)); // double remove
    }

    #[test]
    fn writeback_layer_drafts_for_region() {
        let mut layer = WritebackLayer::new();
        layer.set_draft(make_submission("r1", 0, 0, 1.0, "alice"));
        layer.set_draft(make_submission("r1", 1, 0, 2.0, "alice"));
        layer.set_draft(make_submission("r2", 0, 0, 3.0, "alice"));

        assert_eq!(layer.drafts_for_region("r1").len(), 2);
        assert_eq!(layer.drafts_for_region("r2").len(), 1);
        assert_eq!(layer.drafts_for_region("r3").len(), 0);
    }

    #[test]
    fn writeback_layer_submit_region() {
        let mut layer = WritebackLayer::new();
        layer.set_draft(make_submission("r1", 0, 0, 1.0, "alice"));
        layer.set_draft(make_submission("r1", 1, 0, 2.0, "alice"));
        layer.set_draft(make_submission("r2", 0, 0, 3.0, "alice"));

        let submitted = layer.submit_region("r1", "2026-06-01T00:00:00Z");
        assert_eq!(submitted.len(), 2);
        for s in &submitted {
            assert_eq!(s.state, SubmissionState::Submitted);
            assert!(s.submitted_at.is_some());
        }

        // r2 draft unchanged
        let r2_drafts = layer.drafts_for_region("r2");
        assert_eq!(r2_drafts[0].state, SubmissionState::Draft);
    }

    #[test]
    fn writeback_layer_serde_roundtrip() {
        let mut layer = WritebackLayer::new();
        layer.set_draft(make_submission("r1", 0, 0, 42.0, "alice"));
        layer.set_draft(make_submission("r1", 1, 0, 99.0, "bob"));

        let json = serde_json::to_string_pretty(&layer).unwrap();
        let roundtripped: WritebackLayer = serde_json::from_str(&json).unwrap();
        assert_eq!(roundtripped.draft_count(), 2);
    }

    #[test]
    fn submission_value_serde_roundtrip() {
        for value in [
            SubmissionValue::Number { value: 42.5 },
            SubmissionValue::Text { value: "hello".to_string() },
            SubmissionValue::Boolean { value: true },
            SubmissionValue::Empty,
        ] {
            let json = serde_json::to_value(&value).unwrap();
            let roundtripped: SubmissionValue = serde_json::from_value(json).unwrap();
            assert_eq!(roundtripped, value);
        }
    }

    // --- Region compatibility tests ---

    #[test]
    fn region_compatibility_all_unchanged() {
        let s = make_sheet_id();
        let regions = vec![make_decl("r1", s, 0, 5, 0, 3)];
        let compat = check_region_compatibility(&regions, &regions);
        assert_eq!(compat.compatible.len(), 1);
        assert!(compat.added.is_empty());
        assert!(compat.removed.is_empty());
        assert!(compat.incompatible.is_empty());
    }

    #[test]
    fn region_compatibility_added_and_removed() {
        let s = make_sheet_id();
        let old = vec![make_decl("r1", s, 0, 5, 0, 3)];
        let new = vec![make_decl("r2", s, 10, 15, 0, 3)];
        let compat = check_region_compatibility(&old, &new);
        assert_eq!(compat.removed, vec!["r1"]);
        assert_eq!(compat.added, vec!["r2"]);
        assert!(compat.compatible.is_empty());
    }

    // --- GatherCache tests ---

    #[test]
    fn gather_cache_empty() {
        let cache = GatherCache::new();
        assert!(cache.get("nonexistent").is_empty());
    }

    #[test]
    fn gather_cache_stores_and_retrieves() {
        let mut cache = GatherCache::new();
        let sub = make_submission("r1", 0, 0, 42.0, "alice");
        cache.data.insert("r1".to_string(), vec![sub]);
        assert_eq!(cache.get("r1").len(), 1);
        assert!(cache.get("r2").is_empty());
    }
}
