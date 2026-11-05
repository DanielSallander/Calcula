//! FILENAME: core/calcula-format/src/manifest.rs
//! Manifest (manifest.json) — the root descriptor of a .cala file.

use identity::SheetId;
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
///
/// v9 adds CANVAS SHEETS — the per-sheet `kind` in metadata.json
/// (`CANVAS_SHEET_MIN_FORMAT_VERSION`).
///
/// v10 adds OBJECT PROPERTY BINDINGS — `bindings.json`
/// (`OBJECT_BINDINGS_MIN_FORMAT_VERSION`) — and the chart spec EMBEDDED as a
/// JSON object in `charts.json` (`CHART_SPEC_OBJECT_MIN_FORMAT_VERSION`).
///
/// v11 adds HIDDEN LINES ON A FLOATING GRID -- `hiddenRows` / `hiddenCols` on
/// the rows of `floating_ranges.json`
/// (`FLOATING_GRID_HIDDEN_LINES_MIN_FORMAT_VERSION`).
///
/// v12 adds the INCOMPLETE-CALCULATION mark -- `calc_state.json`
/// (`CALCULATION_INCOMPLETE_MIN_FORMAT_VERSION`), Excel's `calcCompleted="0"`.
///
/// v13 adds LIVE DATA TABLES -- body cells holding the `TABLE(row, col)`
/// marker (`DATA_TABLE_MIN_FORMAT_VERSION`), Excel's `{=TABLE()}`.
pub const CALA_MAX_SUPPORTED_FORMAT_VERSION: u32 = 13;

/// Minimum `.cala` format version a reader must be to handle a LIVE DATA
/// TABLE: cells whose formula is the `TABLE(row_input, col_input)` marker the
/// What-If Data Table command writes over its body (BUG-0652; Excel's
/// `{=TABLE(,A1)}`, `<f t="dataTable">` in `.xlsx`). The body's values are the
/// table formula's answers with the input substituted, which only a reader
/// that knows the marker computes (`engine::data_table`).
///
/// THE TEST THIS PASSES: would an older reader MISHANDLE the document? Yes --
/// "a stale body shown as live". An older build parses `TABLE` as an unknown
/// function, and its load seeds every root call of one with the SAVED value
/// (the results cache), so each body cell keeps answering the number it was
/// saved with -- while its formula bar shows `=TABLE(,A1)` and its input
/// values and model are edited around it. Nothing turns `#NAME?`; the table
/// simply never moves again, looking calculated. Stamped ONLY when some cell
/// holds the marker, so a workbook without a data table keeps the lowest
/// version that can express it.
pub const DATA_TABLE_MIN_FORMAT_VERSION: u32 = 13;

/// Manifest FEATURE ID declared beside [`DATA_TABLE_MIN_FORMAT_VERSION`]'s
/// stamp, so a reader can say WHICH feature raised the version.
pub const DATA_TABLE_FEATURE: &str = "data_tables";

/// Minimum `.cala` format version a reader must be to handle
/// `calc_state.json` -- the workbook was saved with values that may be stale
/// for their formulas (`Workbook::calculation_incomplete`, BUG-0615#2): a
/// manual-calculation workbook edited and saved without recalculating. Excel
/// writes the same fact as `<calcPr calcCompleted="0">` and marks the dirty
/// cells, reopens the stale values as they are and reports the workbook as
/// needing calculation (`Application.CalculationState` = xlPending) until F9
/// [LIVE, Excel 16, 2026-10-30].
///
/// THE TEST THIS PASSES: would an older reader MISHANDLE the document? Yes,
/// the lie class CLAUDE.md names first -- "a stale workbook that comes back
/// looking calculated": an older reader ignores the file, vouches for the
/// stale values, and its Calculate Now keeps a stale cube or custom-function
/// value as current. Stamped ONLY when the mark is set, so a calculated
/// workbook keeps the lowest version that can express it.
pub const CALCULATION_INCOMPLETE_MIN_FORMAT_VERSION: u32 = 12;

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

/// Minimum `.cala` format version a reader must be to handle CANVAS SHEETS —
/// the per-sheet `kind` (with its page, snap grid and stacking layout) in
/// metadata.json.
///
/// THE TEST THIS PASSES: would an older reader MISHANDLE the document? Yes.
/// An older reader ignores the unknown `kind` and presents the canvas as an
/// ordinary, EDITABLE worksheet: an empty cell grid with the canvas's charts,
/// slicers and controls drawn over it, and the hidden pivot output a canvas
/// pivot writes suddenly visible as loose cells. On its next save the kind is
/// gone for good, so the canvas silently becomes a worksheet -- the same
/// "comes back looking like a different document, with no error anywhere"
/// class that earned zoom (v5) and the display flags (v6) their links.
/// Refusing the open is the honest failure.
///
/// Stamped ONLY when some sheet actually is a canvas, so an ordinary workbook
/// keeps the lowest version that can express it.
pub const CANVAS_SHEET_MIN_FORMAT_VERSION: u32 = 9;

/// Minimum `.cala` format version a reader must be to handle OBJECT PROPERTY
/// BINDINGS — `bindings.json`, the overlay that makes a property of a chart,
/// control, slicer, timeline, pivot, floating range or canvas page a FORMULA
/// (a KPI goal read from a cell, a title that follows a measure).
///
/// THE TEST THIS PASSES: would an older reader MISHANDLE the document? Yes, in
/// the lie class. The literal stays on the object's own record, so an older
/// reader that drops `bindings.json` still paints a value -- the FROZEN literal
/// of a property that LOOKS live. A title that should read this month's figure
/// shows last quarter's, with no error anywhere, and the next save drops the
/// binding for good. Refusing the open is the honest failure.
///
/// Stamped ONLY when some binding exists, so a workbook without one keeps the
/// lowest version that can express it.
pub const OBJECT_BINDINGS_MIN_FORMAT_VERSION: u32 = 10;

/// Manifest FEATURE ID declared when `bindings.json` is written. The READ is
/// unconditional (the `named_ranges` precedent): a manifest that forgot the id
/// loses nothing. The VERSION link above is what keeps older readers out.
pub const OBJECT_BINDINGS_FEATURE: &str = "object_bindings";

/// Minimum `.cala` format version a reader must be to read `charts.json` rows
/// whose `spec` is a JSON OBJECT (before v10 it was the `specJson` STRING).
///
/// THE TEST THIS PASSES, in its strongest form: an older reader does not lose
/// something, it cannot parse the row at all (its `SavedChart` requires
/// `specJson` with no serde default, and the charts read propagates the error),
/// so the WHOLE open would fail with a raw serde sentence. Stamping turns that
/// into the reader's clean "saved by a newer version" refusal. Stamped whenever
/// `charts.json` is non-empty. No feature id: the shape change is not an
/// optional feature.
pub const CHART_SPEC_OBJECT_MIN_FORMAT_VERSION: u32 = 10;

/// Minimum `.cala` format version a reader must be to handle the HIDDEN LINES
/// of a floating grid -- `hiddenRows` / `hiddenCols` on a row of
/// `floating_ranges.json` (Home > Format > Hide & Unhide on the grid's cells).
///
/// THE TEST THIS PASSES: would an older reader MISHANDLE the document? Yes, in
/// the lie class CLAUDE.md names: "rows hidden to keep working data out of a
/// distributed report coming back VISIBLE". An older reader ignores the two
/// unknown fields (`SavedFloatingRange` has no `deny_unknown_fields`), shows
/// every window row and column the author hid, raises no error anywhere, and
/// drops the sets for good on its next save. Refusing the open is the honest
/// failure. The same reasoning gave the sheet-level hides their own link
/// (`USER_HIDDEN_MIN_FORMAT_VERSION`).
///
/// Stamped ONLY when some floating range carries a non-empty set, so a
/// workbook whose floating grids hide nothing keeps the lowest version that
/// can express it.
pub const FLOATING_GRID_HIDDEN_LINES_MIN_FORMAT_VERSION: u32 = 11;

/// Manifest FEATURE ID declared when some canvas carries a WALLPAPER (the
/// colour of the area outside its page, `CanvasLayout::wallpaper`).
///
/// DELIBERATELY NO LINK IN THE FORMAT-VERSION CHAIN. The chain's test (above):
/// would an older reader MISHANDLE the document, or merely lose something? An
/// older reader ignores the unknown field (`CanvasLayout` reads with
/// `#[serde(default)]` and no `deny_unknown_fields`) and paints the theme's
/// colour around the page -- a visible, cosmetic loss on a page that is
/// otherwise exactly the author's. Stamping a version would make every such
/// canvas unopenable by that build instead, a strictly worse trade (the
/// `media` precedent in zip_io.rs). The id still lets `read_calcula_manifest`
/// answer "does a page here carry a wallpaper?" without materializing the
/// workbook. The READ is unconditional: the field rides each sheet's own
/// metadata.json, so a manifest that forgot the id loses nothing.
pub const CANVAS_WALLPAPER_FEATURE: &str = "canvas_wallpaper";

/// Manifest FEATURE ID declared when the workbook was saved under MANUAL
/// calculation (`Workbook::calculation_manual`, `calc_mode.json`) -- Excel's
/// `<calcPr calcMode="manual"/>`, which the opening application adopts.
///
/// DELIBERATELY NO LINK IN THE FORMAT-VERSION CHAIN. An older reader ignores
/// the file and opens the workbook in whatever mode its session has: it LOSES
/// the author's mode, which the user sees at once (Formulas > Calculation
/// Options, and an edit that does or does not recalculate), but no value is
/// shown as something it is not -- whether the values are current is the
/// separate `calc_state.json` mark, which has its own link (12). The READ is
/// unconditional, so a manifest that forgot the id loses nothing.
pub const CALCULATION_MODE_FEATURE: &str = "calculation_mode";

/// A sheet carries its own STANDARD row height and/or column width
/// (`defaultRowHeight` / `defaultColumnWidth` in its metadata.json): Excel's
/// per-sheet `<sheetFormatPr>`, what Select All + Row Height and Format >
/// Default Width set (BUG-0352/0353). A feature id, NOT a version link: an
/// older reader ignores the two fields and shows the sheet at the standard
/// sizes -- geometry visibly lost, never a value misread or hidden content
/// shown (rows and columns the author HID stay hidden; they are their own
/// authority).
pub const SHEET_DEFAULT_SIZES_FEATURE: &str = "sheet_default_sizes";

/// Manifest FEATURE ID declared when some canvas has LOCK OBJECTS on
/// (`CanvasLayout::objects_locked`, Power BI's View > Lock objects).
///
/// No format-version link, for the reason [`CANVAS_WALLPAPER_FEATURE`] gives:
/// an older reader hands back a page whose objects can be dragged again. The
/// lock is an authoring convenience, not a protection (sheet protection is
/// the protection, and it has its own persisted state), so the loss is a
/// convenience the user notices at the first drag -- never a document that
/// silently says something it did not. Same unconditional read.
pub const CANVAS_OBJECTS_LOCKED_FEATURE: &str = "canvas_objects_locked";

/// Manifest FEATURE ID declared when some canvas carries VISUAL INTERACTIONS
/// (`CanvasLayout::interactions`, Power BI's Format > Edit interactions): a
/// page-wide default mode or at least one explicit source -> target pair.
///
/// No format-version link, AS DECIDED (round 2, P4). An older reader ignores
/// the unknown field and every visual on the page cross-filters every other by
/// the defaults -- view behaviour, visible at the first click. RECORDED OWNER
/// QUESTION (P4 DC-1, open-items): one pair kind is not purely view state. A
/// model slicer -> BI pivot pair set to `none` decides whether the page fold
/// writes the slicer's selection into that pivot's PERSISTED `hidden_items`,
/// so an older reader that drops the pair re-folds the slicer on the pivot's
/// next refresh and the pivot (and every GETPIVOTDATA reading it) comes back
/// filtered under an unchanged title. If the owner wants that closed, the fix
/// is one conditional stamp at the next free version, written only when some
/// pair has a model-slicer source, a pivot target and mode `none`. The READ is
/// unconditional: interactions ride each sheet's own metadata.json.
pub const CANVAS_INTERACTIONS_FEATURE: &str = "canvas_interactions";

/// Manifest FEATURE ID declared when some ribbon filter targets non-pivot
/// model visuals in "Selected visuals" mode (`connectedVisuals` on its
/// `ribbon_filters/filter_{id}.json`).
///
/// No format-version link: an older reader drops the list, so the filter stops
/// reaching those charts/cards/KPIs/gauges, which then paint unfiltered. Those
/// visuals are queried live and store no filtered result, so no cell, pivot
/// definition or GETPIVOTDATA answer changes; the pivots the filter targets
/// keep `connectedPivots` and stay filtered (P4 DC-3 keeps them in that list
/// for exactly this reason). Read unconditionally with the rest of the filter
/// record.
pub const RIBBON_FILTER_VISUAL_TARGETS_FEATURE: &str = "ribbon_filter_visual_targets";

// PAGE_NAVIGATOR_CONTROL_TYPE itself lives in crate::page_navigator; zip_io reads it there.

/// Manifest FEATURE ID declared when some sheet carries a Page Navigator
/// control (`controlType == "pageNavigator"`).
///
/// DELIBERATELY NO LINK IN THE FORMAT-VERSION CHAIN: an older build paints the
/// unknown control type as a grey "Button" that does nothing (the Controls
/// renderer falls through to the button painter) -- a visible loss, never a
/// lie. Stamping a version would make every report with a navigator
/// unopenable by that build instead, the strictly worse trade the `media`
/// precedent in zip_io.rs records. The READ is unconditional: `controls.json`
/// is an opaque per-sheet payload, so a manifest that forgot the id loses
/// nothing.
pub const PAGE_NAVIGATOR_FEATURE: &str = "page_navigator";

/// Manifest FEATURE ID declared when some sparkline group holds more than one
/// AREA (a `moreAreas` entry in a sheet's opaque `groups_json`): a structural
/// edit that parts a group's sparklines keeps them ONE group, as Excel does
/// (app/src-tauri/src/chart_range_shift.rs, GROUP IDENTITY).
///
/// DELIBERATELY NO LINK IN THE FORMAT-VERSION CHAIN: an older build draws the
/// group's first area only -- the other sparklines are missing, a visible
/// loss, never a lie (no cell shows a sparkline it does not have). The READ is
/// unconditional: `sparklines.json` carries the groups as opaque text.
pub const SPARKLINE_GROUP_AREAS_FEATURE: &str = "sparkline_group_areas";

/// Manifest FEATURE ID declared when some table column remembers a TOTALS ROW
/// LABEL (`totalsRowLabel` on its column in `tables/table_{id}.json`): the
/// constant a column with no totals function showed in its totals row when
/// the row was hidden, put back when it is shown again, as Excel does
/// (NEW-totals-label-persist; [LIVE] cfdv/probe2.ps1).
///
/// DELIBERATELY NO LINK IN THE FORMAT-VERSION CHAIN: an older reader drops the
/// field, so showing the totals row again leaves that cell empty -- the
/// user's constant is LOST, visibly, but nothing shows as something it is not
/// (the totals function stays None, so no subtotal appears in its place). The
/// READ is unconditional: the label rides the table's own record.
pub const TABLE_TOTALS_ROW_LABEL_FEATURE: &str = "table_totals_row_label";

/// Manifest FEATURE ID declared when some object carries a VISUAL CONTAINER
/// (D-FORMAT: padding, title, subtitle, divider, background, border, shadow)
/// -- a slicer / timeline / floating grid `container`, a canvas pivot's
/// `canvas_frame.container`, a chart spec's `container`, or a control with a
/// non-empty `container*` property.
///
/// Feature id, DELIBERATELY NO format-version link: an older reader drops a
/// border, a shadow, a title or a background -- a visible, cosmetic loss,
/// never a lie (the [`CANVAS_WALLPAPER_FEATURE`] reasoning). Stamping a version
/// would make every formatted report unopenable by that build instead. The
/// READ is unconditional: the container rides each object's own record.
pub const VISUAL_CONTAINER_FEATURE: &str = "visual_container";

/// Manifest FEATURE ID declared when some pivot definition carries a persisted
/// PivotTable STYLE (`style`, the Design tab gallery choice; session-only
/// before WP-C).
///
/// Feature id, DELIBERATELY NO format-version link: an older reader paints the
/// pivot in the default style -- a visible, cosmetic loss, never a lie. The
/// READ is unconditional: the style rides the pivot's own definition JSON.
pub const PIVOT_STYLE_FEATURE: &str = "pivot_style";

/// Manifest FEATURE ID declared when some pivot definition sorts a row or
/// column field by the VALUES of a data field (`value_sort`, Excel's AutoSort
/// by a data field -- BUG-0459).
///
/// Feature id, DELIBERATELY NO format-version link: an older reader shows the
/// items in label order -- a visible loss, never a lie. The READ is
/// unconditional: the sort rides the field in the pivot's own definition JSON.
pub const PIVOT_VALUE_SORT_FEATURE: &str = "pivot_value_sort";

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
    // The standard row height / column width are PER SHEET (each sheet's
    // metadata.json, `SHEET_DEFAULT_SIZES_FEATURE`), as in Excel. They were two
    // workbook-wide fields here (BUG-0352).
}

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
