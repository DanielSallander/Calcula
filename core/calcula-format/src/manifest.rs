//! FILENAME: core/calcula-format/src/manifest.rs
//! Manifest (manifest.json) — the root descriptor of a .cala file.

use identity::SheetId;
use persistence::{DEFAULT_COLUMN_WIDTH_PX, DEFAULT_ROW_HEIGHT_PX};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Format version chain
// ---------------------------------------------------------------------------
//
// The `.cala` archive carries ONE `format_version` in its manifest, and the
// rule mirrors the BI model's stamp chain (`stamp_feature_format_version` in
// bi/commands.rs): the writer stamps the HIGHEST minimum any feature actually
// present in this document requires, raising it and never lowering it, and the
// reader refuses anything above what it understands.
//
// Why a feature ever gets a link in this chain: not because it is new, but
// because an older reader would MISHANDLE it. Simply ignoring an unknown
// section is usually fine — the section is dropped on the next save, and the
// user loses cosmetic state. That calculus changes for persisted automation:
// silently dropping `scheduled_jobs.json` disarms schedules the user still
// believes are running, with no error anywhere. So the scheduler takes a link
// (see `features::scheduled_jobs::SCHEDULED_JOBS_MIN_FORMAT_VERSION`) and an
// older build fails the open loudly instead.

/// The floor every `.cala` carries: the original archive layout.
pub const CALA_BASE_FORMAT_VERSION: u32 = 1;

/// The highest `format_version` THIS build knows how to read. A file stamped
/// above this is refused rather than partially understood.
///
/// v3 adds the cancelled-recalculation staleness marker
/// (`PENDING_RECALC_MIN_FORMAT_VERSION`), which takes a link for the same
/// reason the scheduler did: an older reader would not merely ignore it, it
/// would drop it on the next save and the workbook would come back looking
/// fully calculated while still holding pre-recalculation values.
///
/// v4 adds the user-hidden row/column sets
/// (`USER_HIDDEN_MIN_FORMAT_VERSION`).
///
/// v5 adds the per-sheet view state -- zoom and split bars
/// (`SHEET_VIEW_MIN_FORMAT_VERSION`).
///
/// v6 adds the per-sheet DISPLAY FLAGS -- display-zeros, show-formulas, view mode and
/// display-headings (`SHEET_DISPLAY_FLAGS_MIN_FORMAT_VERSION`). These could NOT ride v5:
/// a build that stamps v5 today knows nothing about the four new fields, so it would
/// drop them on its next save, which is precisely the mishandling a version link exists
/// to prevent.
///
/// v7 adds the DYNAMIC-ARRAY SPILL EXTENT on each array origin
/// (`SPILL_EXTENT_MIN_FORMAT_VERSION`).
///
/// v8 adds PINNED FILTER LEVELS — `filterLevel` on slicers and ribbon
/// filters, and `engine_filters` on pivot definitions
/// (`PINNED_FILTER_MIN_FORMAT_VERSION`).
pub const CALA_MAX_SUPPORTED_FORMAT_VERSION: u32 = 8;

/// Minimum `.cala` format version a reader must be to handle
/// `pending_recalc.json` — the record of which cells a cancelled
/// recalculation never reached.
///
/// THE TEST THIS PASSES (and most new sections do not): would an older reader
/// MISHANDLE the document, rather than merely lose some cosmetic state? Yes.
/// Dropping this section turns a workbook that is openly, visibly stale into
/// one that silently claims to be calculated. Refusing the open is the honest
/// failure; quietly laundering wrong numbers into trustworthy-looking ones is
/// not.
pub const PENDING_RECALC_MIN_FORMAT_VERSION: u32 = 3;

/// Minimum `.cala` format version a reader must be to handle the per-sheet
/// `userHiddenRows` / `userHiddenCols` sets in `metadata.json` — the rows and
/// columns the user hid BY HAND, as opposed to the derived `hiddenRows` cache
/// a filter or an outline produces.
///
/// THE TEST THIS PASSES: would an older reader MISHANDLE the document? Yes,
/// and not cosmetically. An older reader drops the section, then rebuilds
/// `hiddenRows` from filter+outline alone on its next save — so the manual
/// hides are gone permanently, and the rows come back VISIBLE. A row is very
/// often hidden precisely to keep working data out of a distributed report;
/// silently resurrecting it is a disclosure, not a lost preference. Refusing
/// the open is the honest failure.
///
/// Stamped ONLY when some sheet actually carries a user hide, so an ordinary
/// workbook still writes v1-v3 and stays openable by older builds.
pub const USER_HIDDEN_MIN_FORMAT_VERSION: u32 = 4;

/// Minimum `.cala` format version a reader must be to handle the per-sheet
/// VIEW state: `zoom` and the split-bar position.
///
/// Same test as the sets above, and it passes for the same reason: zoom and
/// split live nowhere else. An older reader does not merely ignore them, it
/// drops them on its next save -- a 60%-zoomed overview sheet comes back at
/// 100% and a two-pane comparison layout comes back as one pane, with no
/// error anywhere. Stamped only when a sheet actually carries a non-default
/// zoom or a split, so ordinary workbooks stay openable by older builds.
pub const SHEET_VIEW_MIN_FORMAT_VERSION: u32 = 5;

/// Minimum `.cala` format version a reader must be to handle the per-sheet DISPLAY
/// FLAGS: `displayZeros`, `showFormulas`, `viewMode` and `displayHeadings`.
///
/// Before this these four lived ONLY in the frontend Core grid state -- there was no
/// authoritative Rust copy at all, so they were never written to the archive and every
/// one of them silently reset on reload.
///
/// Same test as the sets above, and it passes for the same reason zoom and split did:
/// an older reader does not merely ignore them, it drops them on its next save. A sheet
/// deliberately showing formulas instead of results, or hiding zeros so a report reads
/// cleanly, comes back looking like a different document with no error anywhere.
/// `showFormulas` is the sharpest case: the sheet returns showing VALUES where the
/// author left FORMULAS on screen for review.
///
/// Stamped ONLY when some sheet actually carries a non-default flag, so an ordinary
/// workbook still writes v1-v5 and stays openable by older builds.
pub const SHEET_DISPLAY_FLAGS_MIN_FORMAT_VERSION: u32 = 6;

/// Minimum `.cala` format version a reader must be to handle the DYNAMIC-ARRAY
/// SPILL EXTENT — the `sp` field on an array origin's cell entry, which records
/// which rectangle that origin's array owns (`SavedCell::spill`).
///
/// SAME TEST AS THE SETS ABOVE, and it passes harder than any of them: an older
/// reader does not merely ignore `sp`, it drops it and then re-saves the
/// workbook without it. The spilled VALUES are still written -- they are
/// ordinary cells -- so the file comes back looking correct and is not. The
/// array is no longer owned by anything; its cells are individually editable
/// with nothing on screen to say they were ever part of an array; and the first
/// re-evaluation of the origin finds its own footprint occupied by values it
/// does not own and collapses the whole array to an error. Register §2ab has
/// the measured sequence: open, touch any precedent, `#VALUE!`, press F9, looks
/// repaired, touch anything, `#VALUE!`, indefinitely -- and when the array's
/// LENGTH has changed, F9 leaves stale literals under a live origin presented
/// as its output, which is a wrong answer carrying no error at all. That is the
/// silent-corruption class this chain exists for.
///
/// Stamped ONLY when some cell actually carries an extent, so a workbook with
/// no dynamic array still writes v1-v6 and stays openable by older builds.
pub const SPILL_EXTENT_MIN_FORMAT_VERSION: u32 = 7;

/// Minimum `.cala` format version a reader must be to handle PINNED FILTER
/// LEVELS — `filterLevel` (> 1) on a slicer or ribbon filter, and the
/// `engine_filters` a pinned selection writes into a BI pivot definition.
///
/// THE TEST THIS PASSES: would an older reader MISHANDLE the document? Yes,
/// in the wrong-numbers class. An older reader drops both fields on its next
/// save: the slicer comes back at level 1 and the pivot loses its
/// engine-routed filter. A pin exists precisely so that measures using
/// `CLEAR`/`RESET` keep respecting the filter — un-pinned, those measures
/// silently start stripping it, and the pivot additionally comes back
/// UNFILTERED on the pinned field (the pin's host-side mask is deliberately
/// empty). Numbers change with no error anywhere. Refusing the open is the
/// honest failure.
///
/// Stamped ONLY when some slicer/ribbon filter is actually pinned (level
/// > 1) or some pivot carries an engine filter, so an ordinary workbook
/// keeps the lowest version that can express it.
pub const PINNED_FILTER_MIN_FORMAT_VERSION: u32 = 8;

/// Raise (never lower) a manifest's `format_version` to the minimum a present
/// feature requires. Idempotent, and safe to call once per feature.
pub fn stamp_feature_format_version(manifest: &mut Manifest, minimum: u32) {
    if minimum > manifest.format_version {
        manifest.format_version = minimum;
    }
}

/// Root manifest for a .cala file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    /// Format version: `CALA_BASE_FORMAT_VERSION`, raised by
    /// `stamp_feature_format_version` to the highest minimum any feature
    /// present in this document requires.
    pub format_version: u32,
    /// Application identifier.
    pub application: String,
    /// ISO 8601 creation timestamp.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
    /// ISO 8601 last modified timestamp.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified: Option<String>,
    /// Sheet entries in order.
    pub sheets: Vec<SheetEntry>,
    /// Index of the active sheet.
    pub active_sheet: usize,
    /// Declares which optional feature sections are present in the archive.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub features: Vec<String>,
    /// Default row height in pixels (omitted when `DEFAULT_ROW_HEIGHT_PX`).
    #[serde(default = "default_row_height", skip_serializing_if = "is_default_row_height")]
    pub default_row_height: f64,
    /// Default column width in pixels (omitted when `DEFAULT_COLUMN_WIDTH_PX`).
    #[serde(default = "default_column_width", skip_serializing_if = "is_default_column_width")]
    pub default_column_width: f64,
}

fn default_row_height() -> f64 { DEFAULT_ROW_HEIGHT_PX }
fn default_column_width() -> f64 { DEFAULT_COLUMN_WIDTH_PX }
fn is_default_row_height(v: &f64) -> bool { (*v - DEFAULT_ROW_HEIGHT_PX).abs() < f64::EPSILON }
fn is_default_column_width(v: &f64) -> bool { (*v - DEFAULT_COLUMN_WIDTH_PX).abs() < 1e-6 }

/// Entry for a single sheet in the manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetEntry {
    /// Sheet index (0-based).
    pub index: usize,
    /// Display name of the sheet.
    pub name: String,
    /// Folder name inside sheets/ (e.g., "0_Sales").
    pub folder: String,
    /// Stable sheet identity (UUID v7). Optional for backward compat with old .cala files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheet_id: Option<SheetId>,
}

impl Manifest {
    /// Create a manifest for a workbook with the given sheet names and IDs.
    pub fn from_sheets(names: &[String], ids: &[SheetId], active_sheet: usize) -> Self {
        let sheets = names
            .iter()
            .zip(ids.iter())
            .enumerate()
            .map(|(i, (name, id))| {
                let folder = format!("{}_{}", i, sanitize_folder_name(name));
                SheetEntry {
                    index: i,
                    name: name.clone(),
                    folder,
                    sheet_id: Some(*id),
                }
            })
            .collect();

        Manifest {
            format_version: CALA_BASE_FORMAT_VERSION,
            application: "Calcula".to_string(),
            created: None,
            modified: None,
            sheets,
            active_sheet,
            features: Vec::new(),
            default_row_height: DEFAULT_ROW_HEIGHT_PX,
            default_column_width: DEFAULT_COLUMN_WIDTH_PX,
        }
    }

    /// Create a manifest for a workbook with the given sheet names (mints no IDs — for tests).
    pub fn from_sheet_names(names: &[String], active_sheet: usize) -> Self {
        let sheets = names
            .iter()
            .enumerate()
            .map(|(i, name)| {
                let folder = format!("{}_{}", i, sanitize_folder_name(name));
                SheetEntry {
                    index: i,
                    name: name.clone(),
                    folder,
                    sheet_id: None,
                }
            })
            .collect();

        Manifest {
            format_version: CALA_BASE_FORMAT_VERSION,
            application: "Calcula".to_string(),
            created: None,
            modified: None,
            sheets,
            active_sheet,
            features: Vec::new(),
            default_row_height: DEFAULT_ROW_HEIGHT_PX,
            default_column_width: DEFAULT_COLUMN_WIDTH_PX,
        }
    }
}

/// Sanitize a sheet name for use as a folder name.
/// Replaces characters that are problematic in file paths.
fn sanitize_folder_name(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_manifest_serialization() {
        let manifest = Manifest::from_sheet_names(
            &["Sales".to_string(), "Summary".to_string()],
            0,
        );
        let json = serde_json::to_string_pretty(&manifest).unwrap();
        let parsed: Manifest = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.format_version, 1);
        assert_eq!(parsed.sheets.len(), 2);
        assert_eq!(parsed.sheets[0].folder, "0_Sales");
        assert_eq!(parsed.sheets[1].folder, "1_Summary");
    }

    #[test]
    fn test_sanitize_folder_name() {
        assert_eq!(sanitize_folder_name("Sheet1"), "Sheet1");
        assert_eq!(sanitize_folder_name("Q1/Q2 Report"), "Q1_Q2 Report");
        assert_eq!(sanitize_folder_name("Data:Raw"), "Data_Raw");
    }
}
