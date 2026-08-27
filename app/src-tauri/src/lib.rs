//! FILENAME: app/src-tauri/src/lib.rs
// PURPOSE: Main library entry point (Tauri Bridge).
// CONTEXT: Uses a generic ProtectedRegion system for extension-owned cell regions.

use tauri::Manager;
use engine::{
    format_number_with_color, format_text_with_color, format_color_to_css,
    Cell, CellError, CellStyle, CellValue, EvalResult, Evaluator, Grid, NumberFormat,
    StyleRegistry, MultiSheetContext,
};
// Engine re-exports parser AST types — they are the same types.
// No conversion needed between parser and engine expressions.
use engine::{
    BuiltinFunction, Expression, Value,
};
use parser::ast::TableSpecifier;

// Legacy aliases — these are all identical types since engine re-exports parser's AST.
// Retained temporarily to avoid mass-renaming across the file.
// TODO(phase1): Remove these aliases; use Expression/BuiltinFunction/etc. directly.
// Legacy aliases — these are all identical types since engine re-exports parser's AST.
// All point to the same type: e.g., ParserExpr == EngineExpr == Expression.
// Retained to avoid mass-renaming across this large file.
type EngineExpr = Expression;
type ParserExpr = Expression;

type ParserBuiltinFn = BuiltinFunction;
type ParserTableSpecifier = TableSpecifier;
type ParserValue = Value;
use parser::parse as parse_formula;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use rustc_hash::{FxHashMap, FxHashSet};

// ============================================================================
// HOT-PATH COLLECTION ALIASES
// ============================================================================
// Coordinate-keyed maps on the recalculation hot path use FxHash: the default
// SipHash costs 2-3x more per probe for these tiny keys, and its DoS
// resistance buys nothing for our own coordinates.

/// Set of same-sheet cell coordinates (row, col).
pub type CoordSet = FxHashSet<(u32, u32)>;
/// cell -> set of cells (dependencies/dependents graphs).
pub type DependencyMap = FxHashMap<(u32, u32), CoordSet>;
/// column/row index -> dependent formula cells (whole-column/row references).
pub type StripeDependentsMap = FxHashMap<u32, CoordSet>;
/// formula cell -> column/row indices it depends on (for cleanup).
pub type StripeDependenciesMap = FxHashMap<(u32, u32), FxHashSet<u32>>;
/// (sheet_name, row, col) -> dependent formula cells on other sheets.
pub type CrossSheetDependentsMap =
    FxHashMap<(String, u32, u32), FxHashSet<(usize, u32, u32)>>;
/// formula cell (sheet_index, row, col) -> cross-sheet cells it depends on.
pub type CrossSheetDependenciesMap =
    FxHashMap<(usize, u32, u32), FxHashSet<(String, u32, u32)>>;
use persistence::{FileState, UserFilesState};
use engine::UndoStack;
pub use identity;

pub mod persistence;
/// The dirty-flag forcing function: `DocumentEffect` + `Persisted<T>`.
/// A write to persisted state cannot be expressed without deciding whether it
/// dirties the document. See the module docs for the design rationale.
pub mod document_effect;
pub mod api_types;
pub mod calculation;
/// The LOAD half of dynamic-array spill ownership (§2ab): restore the spill
/// map from the extents a v7+ `.cala` carries, or recover it by evaluation for
/// anything written before the extent existed.
pub mod spill_restore;
pub mod eval_budget;
pub mod commands;
pub mod formula;
pub mod logging;
pub mod sheets;
pub mod floating_range;
/// The ONE rule for what a sheet may be called (register F6, product half).
pub mod sheet_names;
pub mod undo_commands;
pub mod undo_history;
pub mod merge_commands;
pub mod pivot;
pub mod bi;
pub mod scripting;
pub mod named_ranges;
/// Excel-parity named-range resolution: a stored formula keeps its NAME and the
/// name is expanded at EVALUATION, with a name -> dependents edge of its own.
pub mod name_resolution;
pub mod table_deps;
pub mod object_deps;
pub mod data_validation;
pub mod comments;
pub mod notes;
pub mod autofilter;
pub mod hyperlinks;
pub mod protection;
pub mod grouping;
// pub mod linked_sheets; // Removed: replaced by .calp distribution system (Phase 2+)
pub mod conditional_formatting;
pub mod tables;
pub mod goal_seek;
pub mod scenario_manager;
pub mod animation_commands;
pub mod data_tables;
pub mod solver;
pub mod theme_commands;
pub mod tracing;
pub mod evaluate_formula;
pub mod formula_eval_plan;
pub mod consolidate;
pub mod status_bar;
pub mod computed_properties;
pub mod controls;
pub mod media;
pub mod cell_types;
pub mod cell_behaviors;
pub mod slicer;
pub mod ribbon_filter;
pub mod pane_control;
pub mod report;
pub mod control_values;
pub mod row_visibility;
pub mod timeline_slicer;
pub mod mcp;
pub mod locale_commands;
/// Windows regional settings -> `engine::LocaleSettings` (open-items 1.3).
pub mod os_locale;
pub mod error_checking;
pub mod named_styles_cmd;
pub mod chart_commands;
pub mod sparkline_commands;
pub mod json_view;
pub mod r1c1;
pub mod calp_commands;
pub mod calp_inspector;
pub mod library_commands;
pub mod extension_install;
pub mod extension_audit;
pub mod calp_registry;
pub mod managed_policy;
pub mod state_digest;
pub mod security;
pub mod net_commands;
pub mod file_keychain;
pub mod ai;

pub use api_types::{CellData, StyleData, DimensionData, FormattingParams, MergedRegion};
pub use logging::{init_log_file, get_log_path, next_seq, write_log, write_log_raw};
pub use engine::{Transaction, CellChange};
pub use sheets::FreezeConfig;
pub use sheets::SplitConfig;
pub use named_ranges::{NamedRange, NamedRangeResult, ApplyNamesResult};
pub use data_validation::{
    DataValidation, DataValidationType, DataValidationOperator, DataValidationAlertStyle,
    DataValidationRule, DataValidationErrorAlert, DataValidationPrompt,
    ValidationRange, DataValidationResult, InvalidCellsResult, CellValidationResult,
    NumericRule, DateRule, TimeRule, ListRule, ListSource, CustomRule,
    ValidationStorage,
};
pub use comments::{
    Comment, CommentReply, CommentMention, CommentContentType,
    CommentResult, ReplyResult, CommentIndicator, CommentStorage,
    AddCommentParams, UpdateCommentParams, AddReplyParams, UpdateReplyParams,
};
pub use autofilter::{
    FilterOn, FilterOperator, FilterCriteria, DynamicFilterCriteria,
    AutoFilter, AutoFilterInfo, AutoFilterResult, AutoFilterStorage,
    ColumnFilter, IconFilter, UniqueValuesResult, UniqueValue,
    ApplyAutoFilterParams,
};
pub use hyperlinks::{
    Hyperlink, HyperlinkType, HyperlinkResult, HyperlinkStorage,
    HyperlinkIndicator, InternalReference,
    AddHyperlinkParams, UpdateHyperlinkParams,
};
pub use protection::{
    SheetProtection, SheetProtectionOptions, AllowEditRange, CellProtection,
    ProtectionResult, ProtectionCheckResult, ProtectionStatus,
    ProtectionStorage,
    ProtectSheetParams, AddAllowEditRangeParams, SetCellProtectionParams,
    WorkbookProtection, WorkbookProtectionResult, WorkbookProtectionStatus,
};
pub use grouping::{
    RowGroup, ColumnGroup, SheetOutline, OutlineSettings, SummaryPosition,
    GroupResult, OutlineInfo, RowOutlineSymbol, ColOutlineSymbol,
    OutlineStorage, GroupRowsParams, GroupColumnsParams,
    MAX_OUTLINE_LEVEL,
};
pub use conditional_formatting::{
    CFValueType, ColorScalePoint, ColorScaleRule, DataBarDirection, DataBarAxisPosition,
    DataBarRule, IconSetType, ThresholdOperator, IconSetThreshold, IconSetRule,
    CellValueOperator, CellValueRule, TextRuleType, ContainsTextRule,
    TopBottomType, TopBottomRule, AverageRuleType, AboveAverageRule,
    TimePeriod, TimePeriodRule, ExpressionRule, ConditionalFormat,
    ConditionalFormatRule, ConditionalFormatRange, ConditionalFormatDefinition,
    ConditionalFormatStorage, CFResult, CellConditionalFormat, EvaluateCFResult,
    AddCFParams, UpdateCFParams,
};
pub use tables::{
    TotalsRowFunction, TableStyleOptions, TableColumn, Table,
    TableStorage, TableNameRegistry, TableResult, ResolvedStructuredRef,
    StructuredRefResult, CreateTableParams, ResizeTableParams,
    UpdateTableStyleParams, SetTotalsRowFunctionParams,
};

#[cfg(test)]
mod tests;

#[cfg(test)]
mod eval_budget_tests;

/// BUG-0103 consequence 2 — a timeline survives undo AND redo, including as
/// cascade collateral.
#[cfg(test)]
mod timeline_undo_tests;

/// BUG-0106 — a malformed autofilters.json must not delete the filters that ARE
/// readable, and must never be swallowed silently.
#[cfg(test)]
mod autofilter_recovery_tests;

/// BUG-0107 — the icon a cell shows must be ONE value from the CASCADED rule,
/// never a glyph family borrowed from a disabled one.
#[cfg(test)]
mod icon_glyph_resolution_tests;

/// BUG-0104 — filtering by conditional-formatting icon keeps the right rows and
/// refuses what it cannot honour.
#[cfg(test)]
mod icon_filter_tests;

#[cfg(test)]
mod error_display_tests;

#[cfg(test)]
mod name_casing_reload_tests;

#[cfg(test)]
mod document_effect_pilot_tests;

#[cfg(test)]
mod document_effect_wave2_tests;

#[cfg(test)]
mod document_effect_objects_tests;

#[cfg(test)]
mod document_store_census_tests;

#[cfg(test)]
mod document_store_reset_tests;

#[cfg(test)]
mod script_security_census_tests;

#[cfg(test)]
mod object_deps_census_tests;

#[cfg(test)]
mod object_deps_tests;

#[cfg(test)]
mod defined_name_sheet_ops_tests;

#[cfg(test)]
mod formula_serialisation_tests;

#[cfg(test)]
mod state_digest_lock_order_tests;

// ============================================================================
// APPLICATION STATE
// ============================================================================

/// A generic protected region on a sheet, registered by any extension (e.g., pivot, chart).
/// Extensions register regions through this struct; the kernel remains feature-agnostic.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ProtectedRegion {
    /// Unique identifier (e.g., "pivot-1", "chart-3")
    pub id: String,
    /// Region type (e.g., "pivot", "chart")
    pub region_type: String,
    /// Owner entity ID within the extension's namespace
    pub owner_id: identity::EntityId,
    pub sheet_index: usize,
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
}

pub struct AppState {
    /// Cell data, one `Grid` per sheet. THE document.
    ///
    /// PERSISTED (`Sheet::cells`, every save) -> `Persisted<T>`. This was the last
    /// bare `Mutex` on the document's own contents, and it was what BLOCKED making
    /// `FileState::is_modified` private: call sites could reach `&mut Vec<Grid>`
    /// without producing a `DocumentEffect`, so "every grid write decides about
    /// dirtiness" was a convention enforced at the commit helpers rather than by
    /// the type. Both are now closed -- `read()` is free, `write(&effect)` is the
    /// only route to `&mut`, and the flag is private with `document_effect` its
    /// sole writer.
    pub grids: document_effect::Persisted<Vec<Grid>>,
    /// Sheet names in order
    pub sheet_names: document_effect::Persisted<Vec<String>>,
    /// Currently active sheet index.
    ///
    /// PERSISTED (`workbook.active_sheet`) -> `Persisted<T>`, and ONBOARDED IN
    /// ORDER TO SAY NO. Excel dirties on a sheet switch; Calcula deliberately
    /// does not, because merely LOOKING at a workbook must never raise the
    /// close prompt. Before this the divergence was a comment on
    /// `set_active_sheet`; it is now a decision the type demands.
    ///
    /// There are 358 reads and SEVEN writers, which is the whole argument for
    /// gating this field rather than trusting the convention. The pure switch
    /// (`set_active_sheet`) writes under `CleanReason::Navigation`. The other
    /// six ride an effect that is already `mutates` for a different reason --
    /// add / delete / move / copy sheet and pivot drill-through all change
    /// WHICH SHEETS EXIST, so the index landing somewhere new is a consequence
    /// of a real document change, not a navigation of the old document. The
    /// load path writes under `LoadingFromDisk`.
    pub active_sheet: document_effect::Persisted<usize>,
    /// The active sheet's grid, mirroring `grids[active_sheet]`.
    ///
    /// PERSISTED for the same reason `grids` is -- it is the same cells. It is a
    /// `Persisted<Grid>` and not a bare `Mutex<Grid>` precisely because it is a
    /// MIRROR: a writer that reached `&mut Grid` here without a `DocumentEffect`
    /// would dirty the document just as thoroughly as one writing `grids`, and
    /// leaving one half of the pair ungated would have made the guarantee a
    /// half-guarantee that reads as a whole one.
    pub grid: document_effect::Persisted<Grid>,
    pub style_registry: document_effect::Persisted<StyleRegistry>,
    /// Column widths for the currently active sheet (swapped on sheet switch)
    pub column_widths: document_effect::Persisted<HashMap<u32, f64>>,
    /// Row heights for the currently active sheet (swapped on sheet switch)
    pub row_heights: document_effect::Persisted<HashMap<u32, f64>>,
    /// Per-sheet column widths storage (indexed by sheet index)
    pub all_column_widths: document_effect::Persisted<Vec<HashMap<u32, f64>>>,
    /// Per-sheet row heights storage (indexed by sheet index)
    pub all_row_heights: document_effect::Persisted<Vec<HashMap<u32, f64>>>,
    /// Rows the USER hid by hand on the currently active sheet (swapped on
    /// sheet switch, exactly like `row_heights`).
    ///
    /// Named `user_hidden` and NOT `hidden` on purpose: `Sheet::hidden_rows` in
    /// the persistence crate is a DERIVED cache rebuilt at every save from the
    /// filter + outline authorities. This is a third, independent authority —
    /// the only hidden-ness with nowhere else to live — and the composition
    /// rule is a union, never an overwrite:
    ///   effectiveHidden(row) = userHidden OR filterHidden OR outlineHidden
    /// (see `commands::nav::collect_hidden_rows_for_sheet`).
    pub user_hidden_rows: document_effect::Persisted<HashSet<u32>>,
    /// Columns the user hid by hand on the active sheet (see `user_hidden_rows`).
    pub user_hidden_cols: document_effect::Persisted<HashSet<u32>>,
    /// Per-sheet user-hidden rows storage (indexed by sheet index)
    pub all_user_hidden_rows: document_effect::Persisted<Vec<HashSet<u32>>>,
    /// Per-sheet user-hidden columns storage (indexed by sheet index)
    pub all_user_hidden_cols: document_effect::Persisted<Vec<HashSet<u32>>>,
    /// Default row height for rows without custom heights (pixels)
    pub default_row_height: document_effect::Persisted<f64>,
    /// Default column width for columns without custom widths (pixels)
    pub default_column_width: document_effect::Persisted<f64>,
    pub dependents: Mutex<DependencyMap>,
    pub dependencies: Mutex<DependencyMap>,
    /// Calculation mode: "automatic" or "manual"
    pub calculation_mode: Mutex<String>,
    /// Iterative calculation: allow circular references to converge
    pub iteration_enabled: Mutex<bool>,
    /// Maximum number of iterations for circular reference resolution
    pub max_iterations: Mutex<u32>,
    /// Maximum change threshold for convergence (stop when delta < this value)
    pub max_change: Mutex<f64>,
    /// Column-level dependencies: column index -> set of formula cells that depend on entire column
    pub column_dependents: Mutex<StripeDependentsMap>,
    /// Row-level dependencies: row index -> set of formula cells that depend on entire row
    pub row_dependents: Mutex<StripeDependentsMap>,
    /// Track which columns each formula cell depends on (for cleanup)
    pub column_dependencies: Mutex<StripeDependenciesMap>,
    /// Track which rows each formula cell depends on (for cleanup)
    pub row_dependencies: Mutex<StripeDependenciesMap>,
    /// DEFINED-NAME dependencies: UPPERCASE name -> formula cells on the ACTIVE
    /// sheet that resolve through it.
    ///
    /// A name is not a cell, so it appears in none of the four maps above — and
    /// a formula now STORES the name rather than the reference it expands to
    /// (Excel parity, D2). Without this edge, repointing `RATE` would leave
    /// every formula reading it holding the number it computed from the old
    /// definition. See `name_resolution`.
    pub name_dependents: Mutex<name_resolution::NameDependentsMap>,
    /// Track which names each formula cell resolves through (for cleanup).
    pub name_dependencies: Mutex<name_resolution::NameDependenciesMap>,
    /// STRUCTURED-REFERENCE dependencies: UPPERCASE table name -> formula cells
    /// on the ACTIVE sheet that read it.
    ///
    /// The table twin of `name_dependents`, and it exists for the same reason
    /// (§2aj). A formula now STORES `Sales[Amount]` rather than the rectangle it
    /// expanded to at entry, so growing, shrinking, renaming or deleting the
    /// table changes what the formula MEANS without touching any cell its
    /// cell-level edges mention. See `table_deps`.
    pub table_dependents: Mutex<table_deps::TableDependentsMap>,
    /// Track which tables each formula cell reads (for cleanup).
    pub table_dependencies: Mutex<table_deps::TableDependenciesMap>,
    /// Cross-sheet dependencies: (sheet_name, row, col) -> set of (sheet_index, row, col) that depend on it
    pub cross_sheet_dependents: Mutex<CrossSheetDependentsMap>,
    /// Track which cross-sheet cells each formula depends on (for cleanup)
    pub cross_sheet_dependencies: Mutex<CrossSheetDependenciesMap>,
    /// The undo/redo history. `undo_history::UndoHistory`, not a bare
    /// `Mutex<UndoStack>`: it is `Mutex`-shaped (so every existing `.lock()`
    /// site is unchanged) and announces `document:undo-state-changed` whenever
    /// `(can_undo, can_redo)` actually MOVES. That is what lets the ribbon's
    /// Undo/Redo buttons and the Edit menu items be greyed out the way Excel
    /// greys them, including for mutations that never touched the frontend.
    pub undo_stack: undo_history::UndoHistory,
    /// Freeze pane configurations per sheet
    pub freeze_configs: document_effect::Persisted<Vec<FreezeConfig>>,
    /// Split window configurations per sheet
    pub split_configs: document_effect::Persisted<Vec<SplitConfig>>,
    /// Per-sheet zoom as a REAL PERCENT (100 = 100%) — Excel's `zoomScale`.
    ///
    /// A per-sheet Vec kept parallel to `sheet_names`, exactly like
    /// `freeze_configs` / `split_configs` / `show_gridlines`: pushed on sheet
    /// add, removed on delete, rotated on move, cloned on copy, rebuilt on
    /// load. No "active mirror" companion — that pattern exists only where a
    /// legacy single-sheet field had to keep working, and duplicating a value
    /// is how it gets to disagree with itself.
    ///
    /// PERCENT, not the frontend's render factor. The public script contract
    /// (`Calcula.getZoom()` / `api.setZoom`) and Excel both speak percent; the
    /// factor is a rendering detail converted at the UI boundary, and storing
    /// it here is what produced the factor-vs-percent split-brain that Wave 4
    /// had to heal.
    pub sheet_zooms: document_effect::Persisted<Vec<f64>>,
    /// Per-sheet gridlines visibility (default true)
    pub show_gridlines: document_effect::Persisted<Vec<bool>>,
    /// Per-sheet DISPLAY FLAGS (display-zeros, show-formulas, view mode, headings).
    ///
    /// PERSISTED (`Sheet::display_zeros` et al, .cala v6) -> `Persisted<T>`. Landed as
    /// ONE store rather than four parallel `Vec`s because they are one user-facing unit
    /// and four vectors would be four chances to forget to resize on sheet insert.
    pub sheet_display_flags: document_effect::Persisted<Vec<api_types::SheetDisplayFlags>>,
    /// Merged cell regions for the current (active) sheet
    pub merged_regions: document_effect::Persisted<HashSet<MergedRegion>>,
    /// Merged cell regions for ALL sheets (swapped on sheet switch)
    pub all_merged_regions: document_effect::Persisted<Vec<HashSet<MergedRegion>>>,
    /// Protected regions - cells in these regions cannot be edited directly.
    /// Registered by extensions (e.g., pivot tables, charts).
    pub protected_regions: Mutex<Vec<ProtectedRegion>>,
    /// Named ranges for formula references (key is uppercase name).
    /// PERSISTED (`workbook.named_ranges`) -> `Persisted<T>`: writes need a
    /// `DocumentEffect`. See `document_effect`.
    pub named_ranges: document_effect::Persisted<HashMap<String, named_ranges::NamedRange>>,
    /// Data validation rules per sheet
    pub data_validations: document_effect::Persisted<data_validation::ValidationStorage>,
    /// Comments per sheet: sheet_index -> (row, col) -> Comment
    pub comments: document_effect::Persisted<comments::CommentStorage>,
    /// Notes per sheet: sheet_index -> (row, col) -> Note
    pub notes: document_effect::Persisted<notes::NoteStorage>,
    /// AutoFilters per sheet: sheet_index -> AutoFilter
    pub auto_filters: document_effect::Persisted<autofilter::AutoFilterStorage>,
    /// Hyperlinks per sheet: sheet_index -> (row, col) -> Hyperlink
    pub hyperlinks: document_effect::Persisted<hyperlinks::HyperlinkStorage>,
    /// Sheet protection settings per sheet
    pub sheet_protection: document_effect::Persisted<protection::ProtectionStorage>,
    /// Workbook-level structural protection (prevents add/delete/rename/move sheets)
    pub workbook_protection: document_effect::Persisted<protection::WorkbookProtection>,
    /// Row/column grouping (outlines) per sheet
    pub outlines: document_effect::Persisted<grouping::OutlineStorage>,
    /// Conditional formatting rules per sheet.
    /// PERSISTED (`workbook.conditional_formats`) -> `Persisted<T>`: writes need a
    /// `DocumentEffect`. See `document_effect`.
    pub conditional_formats: document_effect::Persisted<conditional_formatting::ConditionalFormatStorage>,
    /// Next conditional format rule ID
    pub next_cf_rule_id: Mutex<u64>,
    /// Tables per sheet: sheet_index -> table_id -> Table
    /// PERSISTED (`workbook.tables` via `collect_tables_for_save`) -> `Persisted<T>`.
    pub tables: crate::document_effect::Persisted<tables::TableStorage>,
    /// Table name registry: table_name (uppercase) -> (sheet_index, table_id)
    /// PERSISTED alongside `tables` (the name registry is rebuilt from it on load).
    pub table_names: crate::document_effect::Persisted<tables::TableNameRegistry>,
    /// Computed properties per sheet: sheet_index -> SheetComputedProperties
    pub computed_properties: document_effect::Persisted<computed_properties::ComputedPropertiesStorage>,
    /// Next computed property ID (auto-incremented)
    pub next_computed_prop_id: Mutex<u64>,
    /// Computed property dependencies: prop_id -> set of cells the formula references
    pub computed_prop_dependencies: Mutex<computed_properties::ComputedPropDependencies>,
    /// Reverse map: cell -> set of prop_ids that depend on it (for re-evaluation triggers)
    pub computed_prop_dependents: Mutex<computed_properties::ComputedPropDependents>,
    /// Control metadata: (sheet_index, row, col) -> ControlMetadata
    pub controls: document_effect::Persisted<controls::ControlStorage>,
    /// Content-addressed binary media for the open document: sha256 hex -> raw
    /// validated bytes. Everything in here passed `calcula_format::media`, and
    /// the document refers to it only by the opaque handle `media:{sha256}`.
    ///
    /// NOT pruned during a session, on purpose — see `media::sweep_unreferenced_media`
    /// for why undo depends on that.
    pub media: document_effect::Persisted<media::MediaStore>,
    /// Cell-type assignments: (sheet_index, row, col) -> { typeId, params }
    pub cell_types: document_effect::Persisted<cell_types::CellTypeStorage>,
    /// Cell-behavior bindings: binding id -> { range target, scriptId, dispatch metadata }
    pub cell_behaviors: document_effect::Persisted<cell_behaviors::CellBehaviorStorage>,
    /// Page setup settings per sheet (indexed by sheet index)
    pub page_setups: document_effect::Persisted<Vec<crate::api_types::PageSetup>>,
    /// Tab colors per sheet (CSS hex string, empty = no color)
    pub tab_colors: document_effect::Persisted<Vec<String>>,
    /// Visibility state per sheet: "visible", "hidden", or "veryHidden"
    pub sheet_visibility: document_effect::Persisted<Vec<String>>,
    /// Spill tracking: maps (sheet_index, origin_row, origin_col) to list of (row, col) spill cells
    /// Used by dynamic array functions (FILTER, SORT, UNIQUE, SEQUENCE)
    ///
    /// PERSISTED (`SavedCell::spill`, the `sp` field, .cala format version 7) ->
    /// `Persisted<T>`. It looks like a derived cache and is NOT one: `spill_restore.rs`
    /// explains why at length -- a spilled `2` and a typed `2` are the same bytes, so
    /// "which cells belong to which origin" cannot be recovered from the grid at any
    /// price short of re-evaluating every formula in the workbook. The extent is
    /// therefore written at save (`apply_spill_extents_to_sheet`, the only authority for
    /// which origin owns which cells) and restored directly on load. That makes it a SAVE
    /// SOURCE, and a save source on a bare `Mutex` can change what lands on disk without
    /// any command having decided whether the document is dirty -- the exact hole
    /// `DocumentEffect` exists to close.
    pub spill_ranges: document_effect::Persisted<SpillRangeMap>,
    /// Reverse spill map: (sheet_index, row, col) -> (origin_row, origin_col)
    /// Used to detect #SPILL! errors when a spill cell is occupied
    pub spill_hosts: Mutex<HashMap<(usize, u32, u32), (u32, u32)>>,
    /// WHAT BLOCKED a `#SPILL!`: (sheet_index, origin_row, origin_col) ->
    /// (blocking_row, blocking_col), the FIRST occupied cell the array needed.
    ///
    /// `CellValue::Error` carries no payload, so the obstruction's address has
    /// to live somewhere for the error-checking pane to name it — and naming it
    /// is the whole point of `#SPILL!` over `#VALUE!`: the remedy is "clear
    /// THAT cell", which is unsayable without the address. Excel shows the same
    /// thing (its error menu offers "Select Obstructing Cells").
    ///
    /// STALENESS IS UNOBSERVABLE, which is why this needs no tear-down of its
    /// own: the map is only ever READ for a cell whose value is
    /// `CellError::Spill`, and a cell can only hold that value from an
    /// evaluation that wrote this entry in the same breath. An entry left
    /// behind by a deleted origin belongs to a cell that is no longer
    /// `#SPILL!`, so nothing looks it up. It is reset with the other two spill
    /// maps when the document is replaced.
    pub spill_blocks: Mutex<HashMap<(usize, u32, u32), (u32, u32)>>,
    /// Hidden rows set by the Advanced Filter extension (per sheet)
    ///
    /// PERSISTED -> `Persisted<T>`: unioned into `Sheet::hidden_rows` at save
    /// (`persistence.rs`), so it decides which rows a distributed report ships as
    /// hidden. Its writers already hand-rolled `DocumentEffect::mutates` with a comment
    /// saying "both arms change what a save writes"; a discarded `let _effect` is a
    /// convention, and this makes it a compiler-enforced fact instead.
    pub advanced_filter_hidden_rows: document_effect::Persisted<HashMap<usize, Vec<u32>>>,
    /// Document theme (colors + fonts). Defaults to Office theme.
    /// PERSISTED (`workbook.theme`) -> `Persisted<T>`: the document theme restyles the
    /// whole workbook and is written into the .cala.
    pub theme: crate::document_effect::Persisted<engine::ThemeDefinition>,
    /// Scenario Manager: per-sheet list of scenarios
    pub scenarios: document_effect::Persisted<HashMap<usize, Vec<api_types::Scenario>>>,
    /// Animation playback transient snapshots: token -> saved (cell coord, prior
    /// Cell). Used by the anim_* commands to apply transient frame writes and
    /// restore the model on stop WITHOUT touching the undo stack. Never serialized.
    pub animation_snapshots: Mutex<HashMap<String, Vec<((u32, u32), Option<engine::Cell>)>>>,
    // linked_sheets removed: replaced by .calp distribution system (Phase 2+)
    /// Locale/regional settings (decimal separator, list separator, date format, etc.)
    pub locale: Mutex<engine::LocaleSettings>,
    /// Auto-recover enabled (background save to prevent data loss)
    pub auto_recover_enabled: Mutex<bool>,
    /// Auto-recover interval in milliseconds (default: 300000 = 5 minutes)
    pub auto_recover_interval_ms: Mutex<u64>,
    /// Named cell styles: name -> NamedCellStyle
    pub named_styles: document_effect::Persisted<HashMap<String, api_types::NamedCellStyle>>,
    /// Workbook document properties (author, title, subject, etc.)
    pub workbook_properties: document_effect::Persisted<api_types::WorkbookProperties>,
    /// Use displayed precision for calculations (default: false)
    pub precision_as_displayed: Mutex<bool>,
    /// Recalculate before saving (default: true)
    pub calculate_before_save: Mutex<bool>,
    /// Chart entries: persisted chart definitions (opaque JSON)
    pub charts: document_effect::Persisted<Vec<api_types::ChartEntry>>,
    /// Floating ranges: shape-like objects whose cells live in OBJECT-backed
    /// engine sheets (`sheets::OBJECT_SHEET_VISIBILITY`). The row is pure
    /// object state (stable ids + geometry + window); the cells themselves are
    /// ordinary sheets in `grids`. PERSISTED (`floating_ranges.json`).
    pub floating_ranges: document_effect::Persisted<Vec<api_types::FloatingRange>>,
    /// Sparkline entries: persisted sparkline groups per sheet (opaque JSON)
    pub sparklines: document_effect::Persisted<Vec<api_types::SparklineEntry>>,
    /// Scroll area restriction per sheet (A1-style range like "A1:Z100", or None for unrestricted).
    ///
    /// SESSION-ONLY, and deliberately a plain `Mutex` rather than a `Persisted<T>`:
    /// `assemble_workbook_for_save` never reads this and `persistence::Sheet` has no
    /// `scroll_area` field, so the value is cleared on every open/new and never reaches
    /// the .cala. `set_scroll_area` must therefore NOT dirty the document -- a dirty
    /// flag on state that is not saved makes the close prompt lie in the other
    /// direction ("save to keep this", then it is gone anyway).
    ///
    /// The missing PERSISTENCE is a real, separate gap (Excel stores ScrollArea per
    /// sheet). Fix that first, then move this to `Persisted<T>` -- not the reverse.
    pub scroll_areas: Mutex<Vec<Option<String>>>,
    /// Reference style: "A1" (default) or "R1C1"
    pub reference_style: Mutex<String>,
    /// Saved pivot layout configurations (persisted in .cala)
    pub pivot_layouts: document_effect::Persisted<Vec<::persistence::SavedPivotLayout>>,
    // NOTE: grid report definitions are DELIBERATELY not a field here. They live
    // in `extension_data["calcula.reports"]` and nowhere else, reached through
    // `report::read_reports` / `report::with_reports_mut`. The field this comment
    // replaces was a second copy of that slot, hand-synced by a call every
    // mutation site had to remember; the saved bytes came from the slot, so a
    // forgotten sync lost the user's report at save with no error. Re-adding a
    // cached `Vec<SavedReport>` here re-opens that. See src/report.rs.
    /// Object scripts for scriptable objects (primitive + component scripts)
    pub object_scripts: document_effect::Persisted<Vec<::persistence::SavedObjectScript>>,
    /// AI script-authoring transcript: runs by script id (or by `draft-` id
    /// before a draft is saved). What the author asked for, what the model said,
    /// what the checks found, and what the author then decided.
    /// PERSISTED (user_files/script_authoring.json) -> `Persisted<T>`. It is the
    /// user's own words about their own scripts; losing it at close would
    /// discard the one fact a later run cannot reconstruct about itself.
    pub script_authoring:
        document_effect::Persisted<calcula_format::features::script_authoring::ScriptAuthoringLog>,
    /// Generic per-extension persisted state (extension id -> arbitrary JSON).
    /// Round-trips through the .cala extension-data part. Any extension
    /// (built-in or third-party) can persist workbook state here without a new
    /// typed file-format field — see persistence::Workbook::extension_data.
    pub extension_data: document_effect::Persisted<std::collections::HashMap<String, serde_json::Value>>,
    /// Stable sheet identifiers, one per sheet (parallel to sheet_names / grids)
    pub sheet_ids: document_effect::Persisted<Vec<identity::SheetId>>,
    /// Subscription metadata for .calp packages linked to this workbook
    /// PERSISTED (user_files/subscriptions.json) -> `Persisted<T>`.
    pub subscriptions: crate::document_effect::Persisted<calp::manifest::SubscriptionManifest>,
    /// Override layer: consumer-side edits to subscribed (.calp) cells
    /// PERSISTED (user_files/overrides.json) -> `Persisted<T>`.
    pub override_layer: crate::document_effect::Persisted<calp::OverrideLayer>,
    /// Audit log for subscription events (opt-in, stored in .cala as audit_log.json)
    /// PERSISTED (user_files/audit_log.json) -> `Persisted<T>`. The transparency trail:
    /// losing it at close would silently discard recorded capability use.
    pub audit_log: crate::document_effect::Persisted<calp::audit::AuditLog>,
    /// Writeback index: positional lookup for cells in publisher-designated
    /// writeback regions. Rebuilt on subscription pull/refresh/removal.
    pub writeback_index: Mutex<calp::WritebackIndex>,
    /// Full writeback region declarations (for schema validation lookups).
    pub writeback_declarations: Mutex<Vec<calp::WritebackRegionDeclaration>>,
    /// Full MODEL writeback COLUMN declarations, mirrored from the same
    /// signature-verified manifests as `writeback_declarations`. Model
    /// writebacks carry no local drafts, so this exists to give refresh a
    /// pre/post snapshot: a column that disappears or narrows silently stops
    /// counting collected submissions, and the user has to be told.
    pub model_writeback_declarations: Mutex<Vec<calp::ModelWritebackDeclaration>>,
    /// Why the last writeback-index rebuild could NOT install a subscription's
    /// regions (unreachable registry, unpinned publisher, bad manifest, or an
    /// HTTP registry still loading in the background). Without this, "declares
    /// no writeback" and "writeback regions unknown, so its protections are not
    /// in force" are the same observable state. Surfaced by
    /// `calp_get_writeback_rebuild_skips`.
    pub writeback_rebuild_skips: Mutex<Vec<crate::calp_commands::WritebackRebuildSkip>>,
    /// Why opening this workbook could NOT re-materialize a subscribed
    /// package's BI connections (same failure vocabulary as
    /// `writeback_rebuild_skips`). Package connections are not stored in the
    /// `.cala` — they are rebuilt from the subscription ledger + the local
    /// package cache under `PinPolicy::RequirePinned` — so "this package has no
    /// data source" and "this package's model could not be verified here" would
    /// otherwise be the same observable state: a pivot with no connection.
    /// Surfaced by `calp_get_package_connection_skips`.
    pub package_connection_restore_skips:
        Mutex<Vec<crate::calp_commands::PackageConnectionRestoreSkip>>,
    /// Subscriber identity for writeback submissions.
    pub subscriber_identity: Mutex<Option<calp::SubmitterIdentity>>,
    /// Central cell identity registry for stable CellId tracking.
    pub id_registry: Mutex<identity::IdRegistry>,
    /// Author-side draft writeback regions (not yet published).
    /// Persisted only when the author publishes a new package version.
    /// PERSISTED draft regions -> `Persisted<T>`.
    pub writeback_draft_regions: crate::document_effect::Persisted<Vec<calp::WritebackRegionDeclaration>>,
    /// Writeback layer: local drafts for writeback cells (stored in .cala).
    /// PERSISTED (writeback layer rides in user_files) -> `Persisted<T>`.
    pub writeback_layer: crate::document_effect::Persisted<calp::writeback::WritebackLayer>,
    /// THE GATHER pre-fetch map, and the only thing `build_gather_data` ever
    /// reads. That function runs on every edit/recalc pass, so it must never do
    /// registry I/O: it serves whatever is here (even past the TTL) and queues a
    /// background rebuild instead. `None` means "nothing known yet" — GATHER
    /// reads empty until the worker lands, which then recalculates and repaints.
    /// Invalidated explicitly on submit/refresh/pull/open/detach, and refreshed
    /// on a TTL so other subscribers' new submissions still appear.
    /// See `calp_commands::build_gather_data` / `queue_gather_refresh`.
    pub gather_cache: Mutex<Option<(std::time::Instant, std::collections::HashMap<String, engine::GatherRegionData>)>>,
    /// Collected entries of model writeback COLUMNS (engine v21), keyed by
    /// writeback column id. Append-only history; persisted in .cala
    /// user_files (`model_writeback_values.json`). See bi::writeback.
    ///
    /// PERSISTED -> `Persisted<T>`. It was the LAST store the save path
    /// serialises that was still a bare `Mutex`, which is why it is here
    /// rather than in the list of session state below: leaving one serialised
    /// store ungated turns "every persisted store is gated" back into a
    /// convention, and a convention with one known exception is the shape the
    /// dirty-flag census started from.
    pub model_writeback: document_effect::Persisted<crate::bi::writeback::ModelWritebackStore>,
    /// Session floor (ISO timestamp) for Blank-projection writeback columns:
    /// entries before it are hidden ("blank on reload"). Reset at workbook
    /// open/new.
    pub model_writeback_floor: Mutex<String>,
    /// THE Ctrl+Break flag. Shared with every evaluator a governed pass builds
    /// (eval_budget.rs), so `cancel_calculation` can stop a running
    /// recalculation without touching a single lock the recalculation holds.
    ///
    /// Deliberately NOT behind a Mutex: the whole point is that the command
    /// that sets it cannot block on anything the recalc owns. It is an
    /// `Arc<AtomicBool>` internally.
    pub calc_cancel: engine::CancelToken,
    /// Cells a CANCELLED recalculation never reached. `None` = the workbook is
    /// fully calculated. See `eval_budget::PendingRecalc` for why the remainder
    /// is recorded rather than rolled back.
    /// PERSISTED (`workbook.pending_recalc`) -> `Persisted<T>`. Found 2026-08-17 by the
    /// save-source census, not by the audit that preceded it: `attach_pending_recalc_for_save`
    /// writes it straight into the saved workbook. The failure mode is the one the .cala
    /// versioning rule names explicitly as a LIE rather than a loss -- "a stale workbook
    /// that comes back looking calculated" -- so a command that changes which cells are
    /// known-stale without deciding about dirtiness is exactly the hole `DocumentEffect`
    /// closes.
    pub pending_recalc: document_effect::Persisted<Option<crate::eval_budget::PendingRecalc>>,
}

impl AppState {
    // `get_active_grid()` used to live here, returning a raw
    // `MutexGuard<'_, Grid>` -- i.e. unconditional mutable access to the active
    // sheet with no `DocumentEffect` in sight. It had no callers, so it was
    // deleted rather than ported: the whole point of `Persisted<Grid>` is that
    // there is no way to reach `&mut Grid` without deciding about dirtiness, and
    // a convenience method that hands one out is that decision's only loophole.

    /// Check if a cell is within any protected region.
    /// Returns the first matching region, or None.
    pub fn get_region_at_cell(&self, sheet_index: usize, row: u32, col: u32) -> Option<ProtectedRegion> {
        let regions = self.protected_regions.lock().unwrap();
        for region in regions.iter() {
            if region.sheet_index == sheet_index
                && row >= region.start_row
                && row <= region.end_row
                && col >= region.start_col
                && col <= region.end_col
            {
                return Some(region.clone());
            }
        }
        None
    }
}

pub fn create_app_state() -> AppState {
    log_info!("SYS", "Creating AppState");
    let initial_grid = Grid::new();
    let app_state = AppState {
        grids: document_effect::Persisted::new(vec![initial_grid.clone()]),
        sheet_names: document_effect::Persisted::new(vec!["Sheet1".to_string()]),
        active_sheet: document_effect::Persisted::new(0),
        grid: document_effect::Persisted::new(initial_grid),
        style_registry: document_effect::Persisted::new(StyleRegistry::new()),
        column_widths: document_effect::Persisted::new(HashMap::new()),
        row_heights: document_effect::Persisted::new(HashMap::new()),
        all_column_widths: document_effect::Persisted::new(vec![HashMap::new()]),
        all_row_heights: document_effect::Persisted::new(vec![HashMap::new()]),
        user_hidden_rows: document_effect::Persisted::new(HashSet::new()),
        user_hidden_cols: document_effect::Persisted::new(HashSet::new()),
        all_user_hidden_rows: document_effect::Persisted::new(vec![HashSet::new()]),
        all_user_hidden_cols: document_effect::Persisted::new(vec![HashSet::new()]),
        // ONE definition of these, in `persistence` -- see
        // DEFAULT_ROW_HEIGHT_PX. `new_file` used to re-type them as 24 / 100
        // and File > New silently handed out a differently-scaled grid than
        // app launch.
        default_row_height: document_effect::Persisted::new(::persistence::DEFAULT_ROW_HEIGHT_PX),
        default_column_width: document_effect::Persisted::new(::persistence::DEFAULT_COLUMN_WIDTH_PX),
        dependents: Mutex::new(DependencyMap::default()),
        dependencies: Mutex::new(DependencyMap::default()),
        calculation_mode: Mutex::new("automatic".to_string()),
        iteration_enabled: Mutex::new(false),
        max_iterations: Mutex::new(100),
        max_change: Mutex::new(0.001),
        column_dependents: Mutex::new(StripeDependentsMap::default()),
        row_dependents: Mutex::new(StripeDependentsMap::default()),
        column_dependencies: Mutex::new(StripeDependenciesMap::default()),
        row_dependencies: Mutex::new(StripeDependenciesMap::default()),
        name_dependents: Mutex::new(name_resolution::NameDependentsMap::default()),
        name_dependencies: Mutex::new(name_resolution::NameDependenciesMap::default()),
        table_dependents: Mutex::new(table_deps::TableDependentsMap::default()),
        table_dependencies: Mutex::new(table_deps::TableDependenciesMap::default()),
        cross_sheet_dependents: Mutex::new(CrossSheetDependentsMap::default()),
        cross_sheet_dependencies: Mutex::new(CrossSheetDependenciesMap::default()),
        undo_stack: undo_history::UndoHistory::new(UndoStack::new()),
        freeze_configs: document_effect::Persisted::new(vec![FreezeConfig::default()]),
        split_configs: document_effect::Persisted::new(vec![SplitConfig::default()]),
        sheet_zooms: document_effect::Persisted::new(vec![::persistence::DEFAULT_SHEET_ZOOM_PERCENT]),
        show_gridlines: document_effect::Persisted::new(vec![true]),
        sheet_display_flags: document_effect::Persisted::new(vec![api_types::SheetDisplayFlags::default()]),
        merged_regions: document_effect::Persisted::new(HashSet::new()),
        all_merged_regions: document_effect::Persisted::new(Vec::new()),
        protected_regions: Mutex::new(Vec::new()),
        named_ranges: document_effect::Persisted::new(HashMap::new()),
        data_validations: document_effect::Persisted::new(HashMap::new()),
        comments: document_effect::Persisted::new(HashMap::new()),
        notes: document_effect::Persisted::new(HashMap::new()),
        auto_filters: document_effect::Persisted::new(HashMap::new()),
        hyperlinks: document_effect::Persisted::new(HashMap::new()),
        sheet_protection: document_effect::Persisted::new(HashMap::new()),
        workbook_protection: document_effect::Persisted::new(protection::WorkbookProtection::default()),
        outlines: document_effect::Persisted::new(HashMap::new()),
        conditional_formats: document_effect::Persisted::new(HashMap::new()),
        next_cf_rule_id: Mutex::new(1),
        tables: crate::document_effect::Persisted::new(HashMap::new()),
        table_names: crate::document_effect::Persisted::new(HashMap::new()),
        computed_properties: document_effect::Persisted::new(HashMap::new()),
        next_computed_prop_id: Mutex::new(1),
        computed_prop_dependencies: Mutex::new(HashMap::new()),
        computed_prop_dependents: Mutex::new(HashMap::new()),
        controls: document_effect::Persisted::new(HashMap::new()),
        media: document_effect::Persisted::new(HashMap::new()),
        cell_types: document_effect::Persisted::new(HashMap::new()),
        cell_behaviors: document_effect::Persisted::new(HashMap::new()),
        page_setups: document_effect::Persisted::new(vec![crate::api_types::PageSetup::default()]),
        tab_colors: document_effect::Persisted::new(vec![String::new()]),
        sheet_visibility: document_effect::Persisted::new(vec!["visible".to_string()]),
        spill_ranges: document_effect::Persisted::new(HashMap::new()),
        spill_hosts: Mutex::new(HashMap::new()),
        spill_blocks: Mutex::new(HashMap::new()),
        advanced_filter_hidden_rows: document_effect::Persisted::new(HashMap::new()),
        theme: crate::document_effect::Persisted::new(engine::ThemeDefinition::default()),
        scenarios: document_effect::Persisted::new(HashMap::new()),
        animation_snapshots: Mutex::new(HashMap::new()),
        // linked_sheets removed
        locale: Mutex::new({
            // THE REGIONAL FORMAT, NOT THE DISPLAY LANGUAGE. This used to be
            // `sys_locale::get_locale()`, which is `GetUserPreferredUILanguages`
            // -- the language Windows shows its own menus in. The separators,
            // date patterns and currency symbol Excel uses come from the
            // REGIONAL FORMAT, a different setting entirely, so an
            // English-display machine with a Swedish region got `.` decimals
            // and `,` formula separators while Excel beside it used `,` and
            // `;`. See os_locale.rs (open-items 1.3).
            let locale = crate::os_locale::system_locale_settings();
            log_info!("SYS", "Detected system regional format: {}", locale.locale_id);
            // Mirror it where every `Evaluator` can see it. `TEXT(value,
            // format)` is the one formula that formats for display, and the
            // alternative to a mirror is a locale parameter on the ~19
            // `evaluate_formula*` wrappers — the same trade `eval_budget`
            // already made for the work budget, and for the same reason.
            crate::eval_budget::set_formula_locale(locale.clone());
            locale
        }),
        auto_recover_enabled: Mutex::new(true),
        auto_recover_interval_ms: Mutex::new(300_000), // 5 minutes
        named_styles: document_effect::Persisted::new(HashMap::new()),
        workbook_properties: document_effect::Persisted::new({
            let author = std::env::var("USERNAME")
                .or_else(|_| std::env::var("USER"))
                .unwrap_or_default();
            let now = chrono::Utc::now().to_rfc3339();
            api_types::WorkbookProperties {
                author,
                created: now.clone(),
                last_modified: now,
                ..Default::default()
            }
        }),
        precision_as_displayed: Mutex::new(false),
        calculate_before_save: Mutex::new(true),
        charts: document_effect::Persisted::new(Vec::new()),
        floating_ranges: document_effect::Persisted::new(Vec::new()),
        sparklines: document_effect::Persisted::new(Vec::new()),
        scroll_areas: Mutex::new(vec![None]),
        reference_style: Mutex::new("A1".to_string()),
        pivot_layouts: document_effect::Persisted::new(Vec::new()),
        object_scripts: document_effect::Persisted::new(Vec::new()),
        script_authoring: document_effect::Persisted::new(Default::default()),
        extension_data: document_effect::Persisted::new(std::collections::HashMap::new()),
        sheet_ids: document_effect::Persisted::new(vec![identity::SheetId::from_bytes(identity::generate_uuid_v7())]),
        subscriptions: crate::document_effect::Persisted::new(calp::manifest::SubscriptionManifest::default()),
        override_layer: crate::document_effect::Persisted::new(calp::OverrideLayer::new()),
        audit_log: crate::document_effect::Persisted::new(calp::audit::AuditLog::new()),
        writeback_index: Mutex::new(calp::WritebackIndex::default()),
        writeback_declarations: Mutex::new(Vec::new()),
        model_writeback_declarations: Mutex::new(Vec::new()),
        writeback_rebuild_skips: Mutex::new(Vec::new()),
        package_connection_restore_skips: Mutex::new(Vec::new()),
        gather_cache: Mutex::new(None),
        subscriber_identity: Mutex::new(None),
        id_registry: Mutex::new(identity::IdRegistry::new()),
        writeback_draft_regions: crate::document_effect::Persisted::new(Vec::new()),
        writeback_layer: crate::document_effect::Persisted::new(calp::writeback::WritebackLayer::new()),
        model_writeback: document_effect::Persisted::new(crate::bi::writeback::ModelWritebackStore::default()),
        model_writeback_floor: Mutex::new(chrono::Utc::now().to_rfc3339()),
        calc_cancel: engine::CancelToken::new(),
        pending_recalc: document_effect::Persisted::new(None),
    };

    // Register the initial sheet in the IdRegistry
    {
        let sheet_ids = app_state.sheet_ids.read().unwrap();
        let sheet_names = app_state.sheet_names.read().unwrap();
        let mut id_reg = app_state.id_registry.lock().unwrap();
        for (i, &sid) in sheet_ids.iter().enumerate() {
            if let Some(name) = sheet_names.get(i) {
                id_reg.register_sheet_with_id(name, sid);
            }
        }
    }

    // Populate built-in named styles
    named_styles_cmd::init_builtin_named_styles(&app_state);

    app_state
}

// ============================================================================
// CELL FORMATTING
// ============================================================================

/// Result of formatting a cell value: display text + optional color from format.
pub struct CellDisplayResult {
    pub text: String,
    pub color: Option<String>,
    /// When set, the cell uses accounting layout with split rendering.
    pub accounting: Option<AccountingLayoutData>,
    /// Which of Excel's overflow rules the VALUE behind `text` is entitled to.
    ///
    /// Carried here because this is the one place that holds both the
    /// `CellValue` and the `CellStyle`; `text` alone has already discarded the
    /// type and the sign that the decision needs (BUG-0066).
    pub overflow: crate::api_types::OverflowClass,
}

/// Accounting layout data for split rendering (symbol left, value right).
#[derive(Debug, Clone)]
pub struct AccountingLayoutData {
    pub symbol: String,
    pub symbol_before: bool,
    pub value: String,
}

pub fn format_cell_value(value: &CellValue, style: &CellStyle, locale: &engine::LocaleSettings) -> String {
    format_cell_value_with_color(value, style, locale).text
}

/// The display text AND the overflow class the value is entitled to.
///
/// Exists so that a `CellData` construction site cannot bind the two to
/// DIFFERENT cells. The alternative -- `format_cell_value(&a.value, ..)` beside
/// `overflow_class_for(&b.value, ..)` -- type-checks perfectly while describing
/// two different values, and the mistake would show up only as a missing or
/// spurious '####' in one workbook.
pub fn format_cell_value_and_class(
    value: &CellValue,
    style: &CellStyle,
    locale: &engine::LocaleSettings,
) -> (String, crate::api_types::OverflowClass) {
    let r = format_cell_value_with_color(value, style, locale);
    (r.text, r.overflow)
}

/// Render a `CellError` the way the GRID renders it.
///
/// IT FORWARDS TO THE ENGINE. There is one authority on the spelling of a cell
/// error — `CellError::as_literal` in `core/engine/src/cell.rs` — and this is a
/// named forwarder to it, kept because ~8 call sites read better saying "render
/// this the way the grid does" than reaching into the engine's inherent impl.
/// It is the same relationship `scripting::udf::cell_error_to_str` has, and the
/// three surfaces now agree by construction rather than by comment.
///
/// WHAT THIS REPLACED (D7, 2026-08-09). This function used to list four
/// variants explicitly and send the other six to `format!("#{:?}", e)`, so the
/// grid painted the Rust variant NAME uppercased:
///
/// | variant    | grid painted | Excel / engine canonical |
/// |------------|--------------|--------------------------|
/// | `Div0`     | `#DIV0`      | `#DIV/0!`                |
/// | `Ref`      | `#REF`       | `#REF!`                  |
/// | `Name`     | `#NAME`      | `#NAME?`                 |
/// | `Value`    | `#VALUE`     | `#VALUE!`                |
/// | `Circular` | `#CIRCULAR`  | `#CIRCULAR!`             |
/// | `Parse`    | `#PARSE`     | — (variant deleted)      |
///
/// Two consequences, both closed by the forwarding:
///
///  1. **The grid did not render those cells as errors at all.** The renderer
///     decides via `isErrorValue` in `gridRenderer/styles/cellFormatting.ts`,
///     which matches against the CANONICAL literals. `#DIV0` does not start
///     with `#DIV/0!`, so a division-by-zero cell was painted as ORDINARY
///     LEFT-ALIGNED BLACK TEXT — indistinguishable from a user-typed string.
///     Only `#NAME` matched (`#NAME?` minus its `?`), by accident.
///  2. **`#PARSE` was an internal enum name no other layer could parse back.**
///     `CellError::Parse` was never constructed anywhere in the product — an
///     unparseable formula is stored as TEXT by `Cell::new_formula`, and the
///     evaluate-formula surfaces answer with the string `#SYNTAX!` — so the
///     variant existed only to be rendered wrong. It has been deleted rather
///     than given a spelling for a state that cannot occur.
///
/// The special case that mattered and is now structural: `Limit`, `Blocked`,
/// `Conflict` and `NA` had to be listed explicitly here, because the `#{Debug}`
/// arm would have dropped their trailing punctuation and the frontend's
/// `normalizeCellErrorLiteral` collapses anything it does not recognise to
/// `#VALUE!` — turning the one error a user most needs to find back into the
/// one it was given its own variant to be distinguished from. With no Debug arm
/// left there is nothing for them to fall through to. `error_display_tests.rs`
/// still pins all four by name, because the requirement outlives this
/// implementation of it.
pub fn cell_error_display(e: &CellError) -> String {
    e.as_literal().to_string()
}

/// Format a cell value and return both display text and optional color override.
/// The color is only populated for Custom formats that include [Color] tokens.
/// THE overflow class is stamped here, in ONE place, rather than in each arm
/// below: this function is the only one in the app that holds a `CellValue` and
/// its `CellStyle` together, and an arm that forgot to stamp it would silently
/// fall back to `Text` (no marker) for a value Excel refuses outright.
pub fn format_cell_value_with_color(value: &CellValue, style: &CellStyle, locale: &engine::LocaleSettings) -> CellDisplayResult {
    let mut result = format_cell_value_parts(value, style, locale);
    result.overflow = crate::api_types::overflow_class_for(value, style);
    result
}

fn format_cell_value_parts(value: &CellValue, style: &CellStyle, locale: &engine::LocaleSettings) -> CellDisplayResult {
    match value {
        CellValue::Empty => CellDisplayResult { text: String::new(), color: None, accounting: None, overflow: Default::default() },
        CellValue::Number(n) => {
            let result = format_number_with_color(*n, &style.number_format, locale);
            if !matches!(style.number_format, NumberFormat::General) {
                log_debug!("FMT", "num={} fmt={:?} --> {}", n, style.number_format, result.text);
            }
            let accounting = result.accounting.map(|p| AccountingLayoutData {
                symbol: p.symbol,
                symbol_before: p.symbol_before,
                value: p.value,
            });
            CellDisplayResult {
                text: result.text,
                color: result.color.map(|c| format_color_to_css(&c).to_string()),
                accounting, overflow: Default::default(),
            }
        },
        CellValue::Text(s) => {
            let result = format_text_with_color(s, &style.number_format);
            CellDisplayResult {
                text: result.text,
                color: result.color.map(|c| format_color_to_css(&c).to_string()),
                accounting: None, overflow: Default::default(),
            }
        },
        CellValue::Boolean(b) => CellDisplayResult {
            text: if *b { "TRUE" } else { "FALSE" }.to_string(),
            color: None,
            accounting: None, overflow: Default::default(),
        },
        CellValue::Error(e) => CellDisplayResult {
            text: cell_error_display(e),
            color: None,
            accounting: None, overflow: Default::default(),
        },
        CellValue::List(items) => CellDisplayResult {
            text: format!("[List({})]", items.len()),
            color: None,
            accounting: None, overflow: Default::default(),
        },
        CellValue::Dict(entries) => CellDisplayResult {
            text: format!("[Dict({})]", entries.len()),
            color: None,
            accounting: None, overflow: Default::default(),
        },
    }
}

pub fn format_cell_value_simple(value: &CellValue) -> String {
    match value {
        CellValue::Empty => String::new(),
        CellValue::Number(n) => format_number_simple(*n),
        CellValue::Text(s) => s.clone(),
        CellValue::Boolean(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
        CellValue::Error(e) => cell_error_display(e),
        CellValue::List(items) => format!("[List({})]", items.len()),
        CellValue::Dict(entries) => format!("[Dict({})]", entries.len()),
    }
}

pub fn format_number_simple(n: f64) -> String {
    if n.fract() == 0.0 {
        format!("{:.0}", n)
    } else {
        let s = format!("{:.10}", n);
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

// ============================================================================
// AST POST-PROCESSING
// ============================================================================

/// Expand wildcard '*' sheet references to Sheet3DRef nodes.
/// The wildcard sheet is a Calcula-specific feature where '*' means "all sheets."
/// This is applied after parsing, before evaluation.
pub fn expand_wildcard_sheets(expr: &mut engine::Expression) {
    // Helper: check if a sheet field contains the wildcard
    fn is_wildcard(sheet: &Option<String>) -> bool {
        sheet.as_deref() == Some("*")
    }

    // We need to take ownership to restructure, so use a replace strategy.
    // Only descend into children for non-wildcard nodes.
    match expr {
        engine::Expression::CellRef { sheet, .. }
        | engine::Expression::Range { sheet, .. }
        | engine::Expression::ColumnRef { sheet, .. }
        | engine::Expression::RowRef { sheet, .. } => {
            if is_wildcard(sheet) {
                // Take the node out and wrap it in Sheet3DRef
                let mut inner = engine::Expression::Literal(engine::Value::Boolean(false)); // placeholder
                std::mem::swap(&mut inner, expr);
                // Clear the sheet from the inner node
                match &mut inner {
                    engine::Expression::CellRef { sheet, .. }
                    | engine::Expression::Range { sheet, .. }
                    | engine::Expression::ColumnRef { sheet, .. }
                    | engine::Expression::RowRef { sheet, .. } => {
                        *sheet = None;
                    }
                    _ => {}
                }
                // Recursively process inner children
                expand_wildcard_sheets(&mut inner);
                *expr = engine::Expression::Sheet3DRef {
                    start_sheet: "*".to_string(),
                    end_sheet: "*".to_string(),
                    reference: Box::new(inner),
                    ref_site_id: Default::default(),
                };
            } else {
                // Recurse into Range children
                if let engine::Expression::Range { start, end, .. } = expr {
                    expand_wildcard_sheets(start);
                    expand_wildcard_sheets(end);
                }
            }
        }
        engine::Expression::BinaryOp { left, right, .. } => {
            expand_wildcard_sheets(left);
            expand_wildcard_sheets(right);
        }
        engine::Expression::UnaryOp { operand, .. } => {
            expand_wildcard_sheets(operand);
        }
        engine::Expression::FunctionCall { args, .. } => {
            for arg in args.iter_mut() {
                expand_wildcard_sheets(arg);
            }
        }
        engine::Expression::Sheet3DRef { reference, .. } => {
            expand_wildcard_sheets(reference);
        }
        engine::Expression::IndexAccess { target, index } => {
            expand_wildcard_sheets(target);
            expand_wildcard_sheets(index);
        }
        engine::Expression::ArrayLiteral { rows } => {
            for e in rows.iter_mut().flatten() {
                expand_wildcard_sheets(e);
            }
        }
        engine::Expression::ListLiteral { elements } => {
            for e in elements.iter_mut() {
                expand_wildcard_sheets(e);
            }
        }
        engine::Expression::DictLiteral { entries } => {
            for (k, v) in entries.iter_mut() {
                expand_wildcard_sheets(k);
                expand_wildcard_sheets(v);
            }
        }
        engine::Expression::SpillRef { cell, .. } => {
            expand_wildcard_sheets(cell);
        }
        engine::Expression::ImplicitIntersection { operand } => {
            expand_wildcard_sheets(operand);
        }
        // Leaf nodes — nothing to expand
        engine::Expression::Literal(_)
        | engine::Expression::NamedRef { .. }
        | engine::Expression::TableRef { .. } => {}
    }
}

/// Backward-compatible wrapper: clones the expression and expands wildcards.
/// Callers should migrate to using the parsed AST directly with
/// `expand_wildcard_sheets()` applied in-place.
pub fn convert_expr(expr: &engine::Expression) -> engine::Expression {
    let mut result = expr.clone();
    expand_wildcard_sheets(&mut result);
    result
}

fn col_letter_to_index(col: &str) -> u32 {
    let mut result: u32 = 0;
    for c in col.chars() {
        let val = (c.to_ascii_uppercase() as u32) - ('A' as u32) + 1;
        result = result * 26 + val;
    }
    result.saturating_sub(1)
}

pub fn column_index_to_letter(mut idx: u32) -> String {
    let mut result = String::new();
    loop {
        result.insert(0, (b'A' + (idx % 26) as u8) as char);
        if idx < 26 {
            break;
        }
        idx = idx / 26 - 1;
    }
    result
}

/// `(sheet, origin row, origin col) -> the cells that array spilled INTO`.
///
/// The authoritative extent of every dynamic array in the workbook. Not
/// persisted as state — `.cala` v7 stamps each origin's extent onto the cell and
/// `spill_restore` rebuilds this on load — and written in exactly one place,
/// `commands::data::apply_spill_decision`.
pub type SpillRangeMap = HashMap<(usize, u32, u32), Vec<(u32, u32)>>;

/// Checks if an AST contains any SpillRef nodes that need resolution.
pub fn ast_has_spill_refs(ast: &ParserExpr) -> bool {
    match ast {
        ParserExpr::SpillRef { .. } => true,
        ParserExpr::BinaryOp { left, right, .. } => {
            ast_has_spill_refs(left) || ast_has_spill_refs(right)
        }
        ParserExpr::UnaryOp { operand, .. } => ast_has_spill_refs(operand),
        ParserExpr::FunctionCall { args, .. } => args.iter().any(ast_has_spill_refs),
        ParserExpr::Range { start, end, .. } => {
            ast_has_spill_refs(start) || ast_has_spill_refs(end)
        }
        ParserExpr::IndexAccess { target, index } => {
            ast_has_spill_refs(target) || ast_has_spill_refs(index)
        }
        ParserExpr::ImplicitIntersection { operand } => ast_has_spill_refs(operand),
        ParserExpr::Sheet3DRef { reference, .. } => ast_has_spill_refs(reference),
        ParserExpr::ArrayLiteral { rows } => rows.iter().flatten().any(ast_has_spill_refs),
        ParserExpr::ListLiteral { elements } => elements.iter().any(ast_has_spill_refs),
        ParserExpr::DictLiteral { entries } => {
            entries.iter().any(|(k, v)| ast_has_spill_refs(k) || ast_has_spill_refs(v))
        }
        _ => false,
    }
}

/// Resolves SpillRef nodes in the AST by replacing them with Range expressions
/// based on the current spill_ranges state.
///
/// `sheet_names` is what makes a QUALIFIED spill ref work. The lookup key used
/// to be `(current_sheet_index, row, col)` unconditionally, while the ref's own
/// `sheet` was copied into the Range that got built -- so `=SUM(Sheet2!A1#)`
/// looked the anchor up in the ACTIVE sheet's spill map, missed, and fell back
/// to the bare single cell. The formula silently became `=SUM(Sheet2!A1)`: one
/// cell instead of the whole array, no error, a different number. An unqualified
/// ref keeps using `current_sheet_index`, which is the same behaviour as before.
///
/// A qualifier naming a sheet that does not exist resolves to no index and takes
/// the same miss path it always did -- it must NOT silently fall back to the
/// active sheet, which would answer with a different sheet's array.
pub fn resolve_spill_refs_in_ast(
    ast: &ParserExpr,
    spill_ranges: &HashMap<(usize, u32, u32), Vec<(u32, u32)>>,
    current_sheet_index: usize,
    sheet_names: &[String],
) -> ParserExpr {
    match ast {
        ParserExpr::SpillRef { cell, .. } => {
            // Extract the cell reference coordinates
            if let ParserExpr::CellRef { sheet, col, row, col_absolute, row_absolute, .. } = cell.as_ref() {
                let col_idx = col_letter_to_index(col);
                let row_idx = row - 1; // Convert to 0-based

                // Look up the spill range for this cell, on the sheet the REF
                // names rather than the one that happens to be active.
                let anchor_sheet = match sheet {
                    Some(name) => {
                        match sheet_names.iter().position(|s| s.eq_ignore_ascii_case(name)) {
                            Some(idx) => idx,
                            // Unknown sheet: leave the ref alone (the fallback
                            // below returns the single cell), rather than
                            // resolving against a sheet the user did not name.
                            None => usize::MAX,
                        }
                    }
                    None => current_sheet_index,
                };
                let key = (anchor_sheet, row_idx, col_idx);
                if let Some(spill_cells) = spill_ranges.get(&key) {
                    // Compute the bounding box (origin + all spill cells)
                    let mut min_row = row_idx;
                    let mut max_row = row_idx;
                    let mut min_col = col_idx;
                    let mut max_col = col_idx;
                    for &(sr, sc) in spill_cells {
                        min_row = min_row.min(sr);
                        max_row = max_row.max(sr);
                        min_col = min_col.min(sc);
                        max_col = max_col.max(sc);
                    }

                    // Build a Range expression
                    ParserExpr::Range {
                        sheet: sheet.clone(),
                        start: Box::new(ParserExpr::CellRef {
                            sheet: None,
                            col: column_index_to_letter(min_col),
                            row: min_row + 1,
                            col_absolute: *col_absolute,
                            row_absolute: *row_absolute,
                            ref_site_id: Default::default(),
                        }),
                        end: Box::new(ParserExpr::CellRef {
                            sheet: None,
                            col: column_index_to_letter(max_col),
                            row: max_row + 1,
                            col_absolute: *col_absolute,
                            row_absolute: *row_absolute,
                            ref_site_id: Default::default(),
                        }),
                        ref_site_id: Default::default(),
                    }
                } else {
                    // No spill range at this cell - just return the single cell ref
                    cell.as_ref().clone()
                }
            } else {
                // SpillRef on non-CellRef is invalid
                ast.clone()
            }
        }
        ParserExpr::BinaryOp { left, op, right } => ParserExpr::BinaryOp {
            left: Box::new(resolve_spill_refs_in_ast(left, spill_ranges, current_sheet_index, sheet_names)),
            op: op.clone(),
            right: Box::new(resolve_spill_refs_in_ast(right, spill_ranges, current_sheet_index, sheet_names)),
        },
        ParserExpr::UnaryOp { op, operand } => ParserExpr::UnaryOp {
            op: op.clone(),
            operand: Box::new(resolve_spill_refs_in_ast(operand, spill_ranges, current_sheet_index, sheet_names)),
        },
        ParserExpr::FunctionCall { func, args, .. } => ParserExpr::FunctionCall {
            func: func.clone(),
            args: args.iter().map(|a| resolve_spill_refs_in_ast(a, spill_ranges, current_sheet_index, sheet_names)).collect(),
            ref_site_id: Default::default(),
        },
        ParserExpr::Range { sheet, start, end, .. } => ParserExpr::Range {
            sheet: sheet.clone(),
            start: Box::new(resolve_spill_refs_in_ast(start, spill_ranges, current_sheet_index, sheet_names)),
            end: Box::new(resolve_spill_refs_in_ast(end, spill_ranges, current_sheet_index, sheet_names)),
            ref_site_id: Default::default(),
        },
        ParserExpr::IndexAccess { target, index } => ParserExpr::IndexAccess {
            target: Box::new(resolve_spill_refs_in_ast(target, spill_ranges, current_sheet_index, sheet_names)),
            index: Box::new(resolve_spill_refs_in_ast(index, spill_ranges, current_sheet_index, sheet_names)),
        },
        ParserExpr::ImplicitIntersection { operand } => ParserExpr::ImplicitIntersection {
            operand: Box::new(resolve_spill_refs_in_ast(operand, spill_ranges, current_sheet_index, sheet_names)),
        },
        ParserExpr::Sheet3DRef { start_sheet, end_sheet, reference, .. } => ParserExpr::Sheet3DRef {
            start_sheet: start_sheet.clone(),
            end_sheet: end_sheet.clone(),
            reference: Box::new(resolve_spill_refs_in_ast(reference, spill_ranges, current_sheet_index, sheet_names)),
            ref_site_id: Default::default(),
        },
        ParserExpr::ArrayLiteral { rows } => ParserExpr::ArrayLiteral {
            rows: rows.iter().map(|r| r.iter().map(|e| resolve_spill_refs_in_ast(e, spill_ranges, current_sheet_index, sheet_names)).collect()).collect(),
        },
        ParserExpr::ListLiteral { elements } => ParserExpr::ListLiteral {
            elements: elements.iter().map(|e| resolve_spill_refs_in_ast(e, spill_ranges, current_sheet_index, sheet_names)).collect(),
        },
        ParserExpr::DictLiteral { entries } => ParserExpr::DictLiteral {
            entries: entries.iter().map(|(k, v)| (
                resolve_spill_refs_in_ast(k, spill_ranges, current_sheet_index, sheet_names),
                resolve_spill_refs_in_ast(v, spill_ranges, current_sheet_index, sheet_names),
            )).collect(),
        },
        // All other nodes (Literal, CellRef, ColumnRef, RowRef, NamedRef, TableRef) pass through
        _ => ast.clone(),
    }
}

// ============================================================================
// FORMULA EVALUATION
// ============================================================================

/// Result of extracting references from a formula expression
pub struct ExtractedRefs {
    /// Individual cell references (row, col) on the current sheet - 0-indexed
    pub cells: CoordSet,
    /// Column references (column indices)
    pub columns: FxHashSet<u32>,
    /// Row references (row indices) - 0-indexed
    pub rows: FxHashSet<u32>,
    /// Cross-sheet cell references (sheet_name, row, col) - row is 0-indexed
    pub cross_sheet_cells: FxHashSet<(String, u32, u32)>,
}

impl ExtractedRefs {
    pub fn new() -> Self {
        ExtractedRefs {
            cells: CoordSet::default(),
            columns: FxHashSet::default(),
            rows: FxHashSet::default(),
            cross_sheet_cells: FxHashSet::default(),
        }
    }
}

pub fn extract_references(expr: &ParserExpr, grid: &Grid) -> CoordSet {
    let refs = extract_all_references(expr, grid);
    refs.cells
}

pub fn extract_all_references(expr: &ParserExpr, grid: &Grid) -> ExtractedRefs {
    let mut refs = ExtractedRefs::new();
    extract_references_recursive(expr, grid, &mut refs);
    refs
}

/// The references a **stored** formula reads — the only correct way to ask that
/// question of a cell now that the document keeps indirections.
///
/// `extract_references_recursive` cannot see through a `NamedRef` or a
/// `TableRef`: neither carries cell coordinates, so both are skipped and the
/// formula looks like it reads nothing. That was harmless while both were
/// spliced away at entry, and it is not harmless now — D2 left the name case
/// exposed at the ORDERING walks, and §2aj would have added every structured
/// reference to the same population.
///
/// What "exposed" means concretely: `build_workbook_plan` orders F9's whole
/// workbook from these edges, so a `=SUM(Sales[Amount])` with no precedent edge
/// sorts as an input rather than as a dependent, and computes from whatever the
/// table's own formula cells held BEFORE the pass. The value then depends on
/// hash-iteration order, which is the exact class this program exists to close.
///
/// Expanding first costs one tree clone per formula that actually uses an
/// indirection; `eval_ast` returns `Cow::Borrowed` for every other formula, so
/// a workbook with no names and no tables pays two `is_empty()` checks per cell.
pub fn stored_ast_references(
    ast: &ParserExpr,
    grid: &Grid,
    name_tables: name_resolution::NameTables<'_>,
    sheet_index: usize,
    row: u32,
    col: u32,
) -> ExtractedRefs {
    let expanded = name_resolution::eval_ast(ast, &name_tables.at(sheet_index, row, col));
    extract_all_references(&expanded, grid)
}

fn extract_references_recursive(expr: &ParserExpr, grid: &Grid, refs: &mut ExtractedRefs) {
    match expr {
        ParserExpr::Literal(_) => {}
        ParserExpr::CellRef { sheet, col, row, .. } => {
            let col_idx = col_letter_to_index(col);
            let row_idx = row.saturating_sub(1);
            if let Some(sheet_name) = sheet {
                refs.cross_sheet_cells.insert((sheet_name.clone(), row_idx, col_idx));
            } else {
                refs.cells.insert((row_idx, col_idx));
            }
        }
        ParserExpr::Range { sheet, start, end, .. } => {
            if let (
                ParserExpr::CellRef { col: start_col, row: start_row, .. },
                ParserExpr::CellRef { col: end_col, row: end_row, .. },
            ) = (start.as_ref(), end.as_ref())
            {
                let sc = col_letter_to_index(start_col);
                let ec = col_letter_to_index(end_col);
                let sr = start_row.saturating_sub(1);
                let er = end_row.saturating_sub(1);
                
                if let Some(sheet_name) = sheet {
                    for r in sr.min(er)..=sr.max(er) {
                        for c in sc.min(ec)..=sc.max(ec) {
                            refs.cross_sheet_cells.insert((sheet_name.clone(), r, c));
                        }
                    }
                } else {
                    for r in sr.min(er)..=sr.max(er) {
                        for c in sc.min(ec)..=sc.max(ec) {
                            refs.cells.insert((r, c));
                        }
                    }
                }
            } else {
                extract_references_recursive(start, grid, refs);
                extract_references_recursive(end, grid, refs);
            }
        }
        ParserExpr::ColumnRef { start_col, end_col, .. } => {
            let sc = col_letter_to_index(start_col);
            let ec = col_letter_to_index(end_col);
            let min_col = sc.min(ec);
            let max_col = sc.max(ec);
            
            for col in min_col..=max_col {
                refs.columns.insert(col);
            }
            
            for ((r, c), _) in grid.cells.iter() {
                if *c >= min_col && *c <= max_col {
                    refs.cells.insert((*r, *c));
                }
            }
        }
        ParserExpr::RowRef { start_row, end_row, .. } => {
            let min_row = start_row.saturating_sub(1).min(end_row.saturating_sub(1));
            let max_row = start_row.saturating_sub(1).max(end_row.saturating_sub(1));
            
            for row in min_row..=max_row {
                refs.rows.insert(row);
            }
            
            for ((r, c), _) in grid.cells.iter() {
                if *r >= min_row && *r <= max_row {
                    refs.cells.insert((*r, *c));
                }
            }
        }
        ParserExpr::BinaryOp { left, right, .. } => {
            extract_references_recursive(left, grid, refs);
            extract_references_recursive(right, grid, refs);
        }
        ParserExpr::UnaryOp { operand, .. } => {
            extract_references_recursive(operand, grid, refs);
        }
        ParserExpr::FunctionCall { args, .. } => {
            for arg in args {
                extract_references_recursive(arg, grid, refs);
            }
        }
        // 3D cross-sheet reference: tag inner cells with each bookend sheet
        ParserExpr::Sheet3DRef { start_sheet, end_sheet, reference, .. } => {
            // Extract the inner reference's cells (without sheet context)
            let mut inner_refs = ExtractedRefs::new();
            extract_references_recursive(reference, grid, &mut inner_refs);
            // Tag each cell with both bookend sheets as cross-sheet dependencies
            for (row, col) in &inner_refs.cells {
                refs.cross_sheet_cells.insert((start_sheet.clone(), *row, *col));
                refs.cross_sheet_cells.insert((end_sheet.clone(), *row, *col));
            }
        }
        // NamedRef nodes should be resolved before reference extraction.
        // If one is still present, it means the name couldn't be resolved — skip.
        ParserExpr::NamedRef { .. } => {}
        // TableRef nodes should be resolved before reference extraction.
        // If still present, skip (will produce #NAME? during evaluation).
        ParserExpr::TableRef { .. } => {}
        // IndexAccess: recurse into both target and index
        ParserExpr::IndexAccess { target, index } => {
            extract_references_recursive(target, grid, refs);
            extract_references_recursive(index, grid, refs);
        }
        // ArrayLiteral: recurse into every cell of every row
        ParserExpr::ArrayLiteral { rows } => {
            for elem in rows.iter().flatten() {
                extract_references_recursive(elem, grid, refs);
            }
        }
        // ListLiteral: recurse into all elements
        ParserExpr::ListLiteral { elements } => {
            for elem in elements {
                extract_references_recursive(elem, grid, refs);
            }
        }
        // DictLiteral: recurse into all keys and values
        ParserExpr::DictLiteral { entries } => {
            for (key, value) in entries {
                extract_references_recursive(key, grid, refs);
                extract_references_recursive(value, grid, refs);
            }
        }
        ParserExpr::SpillRef { cell, .. } => {
            extract_references_recursive(cell, grid, refs);
        }
        ParserExpr::ImplicitIntersection { operand } => {
            extract_references_recursive(operand, grid, refs);
        }
    }
}

// ============================================================================
// NAMED REFERENCE RESOLUTION (AST SPLICING)
// ============================================================================

/// Resolves all `NamedRef` nodes in a parser AST by splicing in the parsed
/// `refers_to` sub-ASTs from the named ranges map. This implements "macro-expansion"
/// style name resolution: `=SUM(SalesData)` where SalesData = `=Sheet1!$A$1:$A$10`
/// becomes `SUM(Range(Sheet1!A1:A10))`.
///
/// Circular references are detected via the `visited` set. If a name refers to
/// itself (directly or indirectly), the NamedRef is replaced with an error literal.
pub fn resolve_names_in_ast(
    ast: &ParserExpr,
    named_ranges: &HashMap<String, named_ranges::NamedRange>,
    current_sheet_index: usize,
    visited: &mut HashSet<String>,
) -> ParserExpr {
    match ast {
        ParserExpr::NamedRef { name, .. } => {
            let key = name.to_uppercase();

            // Circular reference detection
            if visited.contains(&key) {
                return ParserExpr::Literal(ParserValue::Number(f64::NAN));
            }

            // Look up the name (scope-aware: prefer sheet-scoped, then workbook-scoped)
            let nr = named_ranges
                .values()
                .find(|nr| {
                    let nr_key = nr.name.to_uppercase();
                    if nr_key != key {
                        return false;
                    }
                    // Sheet-scoped name matching current sheet
                    nr.sheet_index == Some(current_sheet_index)
                })
                .or_else(|| {
                    // Fall back to workbook-scoped
                    named_ranges.values().find(|nr| {
                        let nr_key = nr.name.to_uppercase();
                        nr_key == key && nr.sheet_index.is_none()
                    })
                });

            match nr {
                Some(nr) => {
                    // Parse the refers_to formula
                    match parse_formula(&nr.refers_to) {
                        Ok(sub_ast) => {
                            // Recursively resolve names in the sub-AST
                            visited.insert(key.clone());
                            let resolved = resolve_names_in_ast(
                                &sub_ast,
                                named_ranges,
                                current_sheet_index,
                                visited,
                            );
                            visited.remove(&key);
                            resolved
                        }
                        Err(_) => {
                            // Parse error in refers_to — treat as #NAME? error
                            ParserExpr::Literal(ParserValue::Number(f64::NAN))
                        }
                    }
                }
                None => {
                    // Name not found — leave as NamedRef (will become #NAME? in convert_expr)
                    ast.clone()
                }
            }
        }
        ParserExpr::Literal(_) => ast.clone(),
        ParserExpr::CellRef { .. } => ast.clone(),
        ParserExpr::ColumnRef { .. } => ast.clone(),
        ParserExpr::RowRef { .. } => ast.clone(),
        ParserExpr::BinaryOp { left, op, right } => ParserExpr::BinaryOp {
            left: Box::new(resolve_names_in_ast(left, named_ranges, current_sheet_index, visited)),
            op: *op,
            right: Box::new(resolve_names_in_ast(right, named_ranges, current_sheet_index, visited)),
        },
        ParserExpr::UnaryOp { op, operand } => ParserExpr::UnaryOp {
            op: *op,
            operand: Box::new(resolve_names_in_ast(operand, named_ranges, current_sheet_index, visited)),
        },
        ParserExpr::FunctionCall { func, args, .. } => {
            // For LAMBDA and LET, parameter name positions must NOT be resolved
            // as named ranges — they are local bindings that shadow global names.
            match func {
                ParserBuiltinFn::Lambda if args.len() >= 2 => {
                    // LAMBDA(param1, param2, ..., body)
                    // Collect parameter names to shadow them in the body
                    let mut param_names: Vec<String> = Vec::new();
                    for p_arg in &args[..args.len() - 1] {
                        if let ParserExpr::NamedRef { name, .. } = p_arg {
                            param_names.push(name.to_uppercase());
                        }
                    }
                    let mut resolved_args: Vec<ParserExpr> = Vec::with_capacity(args.len());
                    // Parameter name arguments: keep as-is (don't resolve)
                    for p_arg in &args[..args.len() - 1] {
                        resolved_args.push(p_arg.clone());
                    }
                    // Body: resolve names EXCEPT parameter names
                    let body = args.last().unwrap();
                    resolved_args.push(resolve_names_in_ast_with_shadows(
                        body, named_ranges, current_sheet_index, visited, &param_names,
                    ));
                    ParserExpr::FunctionCall {
                        func: func.clone(),
                        args: resolved_args,
                        ref_site_id: Default::default(),
                    }
                }
                ParserBuiltinFn::Let if args.len() >= 3 && args.len() % 2 == 1 => {
                    // LET(name1, value1, name2, value2, ..., calculation)
                    // Collect all LET-bound names to shadow in value exprs and body
                    let pair_count = (args.len() - 1) / 2;
                    let mut let_names: Vec<String> = Vec::new();
                    for i in 0..pair_count {
                        if let ParserExpr::NamedRef { name, .. } = &args[i * 2] {
                            let_names.push(name.to_uppercase());
                        }
                    }
                    let mut resolved_args: Vec<ParserExpr> = Vec::with_capacity(args.len());
                    for (idx, arg) in args.iter().enumerate() {
                        if idx % 2 == 0 && idx < args.len() - 1 {
                            // Name positions: keep as-is
                            resolved_args.push(arg.clone());
                        } else {
                            // Value and body positions: resolve with shadows
                            resolved_args.push(resolve_names_in_ast_with_shadows(
                                arg, named_ranges, current_sheet_index, visited, &let_names,
                            ));
                        }
                    }
                    ParserExpr::FunctionCall {
                        func: func.clone(),
                        args: resolved_args,
                        ref_site_id: Default::default(),
                    }
                }
                _ => {
                    // Check if a Custom function name is actually a named range
                    // (e.g., =testing(5,9) where "testing" is a named LAMBDA).
                    // If so, resolve it and wrap as __INVOKE__(resolved_lambda, args...).
                    if let ParserBuiltinFn::Custom(ref custom_name) = func {
                        let key = custom_name.to_uppercase();
                        let nr = named_ranges
                            .values()
                            .find(|nr| {
                                let nr_key = nr.name.to_uppercase();
                                nr_key == key && nr.sheet_index == Some(current_sheet_index)
                            })
                            .or_else(|| {
                                named_ranges.values().find(|nr| {
                                    let nr_key = nr.name.to_uppercase();
                                    nr_key == key && nr.sheet_index.is_none()
                                })
                            });
                        if let Some(nr) = nr {
                            if let Ok(sub_ast) = parse_formula(&nr.refers_to) {
                                visited.insert(key.clone());
                                let resolved_callee = resolve_names_in_ast(
                                    &sub_ast, named_ranges, current_sheet_index, visited,
                                );
                                visited.remove(&key);
                                // Build __INVOKE__(displayName, resolved_lambda, arg1, ...).
                                // The leading string literal records the user-facing
                                // function name so the formula bar renders `Name(args)`
                                // instead of the expanded LAMBDA. It is inert for
                                // evaluation (the evaluator skips it) and re-parses
                                // cleanly, so persistence round-trips the resolved form.
                                let mut invoke_args = vec![
                                    ParserExpr::Literal(ParserValue::String(nr.name.clone())),
                                    resolved_callee,
                                ];
                                for a in args {
                                    invoke_args.push(resolve_names_in_ast(
                                        a, named_ranges, current_sheet_index, visited,
                                    ));
                                }
                                return ParserExpr::FunctionCall {
                                    func: ParserBuiltinFn::Custom("__INVOKE__".to_string()),
                                    args: invoke_args,
                                    ref_site_id: Default::default(),
                                };
                            }
                        }
                    }
                    ParserExpr::FunctionCall {
                        func: func.clone(),
                        args: args
                            .iter()
                            .map(|a| resolve_names_in_ast(a, named_ranges, current_sheet_index, visited))
                            .collect(),
                        ref_site_id: Default::default(),
                    }
                },
            }
        }
        ParserExpr::Range { sheet, start, end, .. } => ParserExpr::Range {
            sheet: sheet.clone(),
            start: Box::new(resolve_names_in_ast(start, named_ranges, current_sheet_index, visited)),
            end: Box::new(resolve_names_in_ast(end, named_ranges, current_sheet_index, visited)),
            ref_site_id: Default::default(),
        },
        // 3D cross-sheet reference: recurse into inner reference
        ParserExpr::Sheet3DRef { start_sheet, end_sheet, reference, .. } => ParserExpr::Sheet3DRef {
            start_sheet: start_sheet.clone(),
            end_sheet: end_sheet.clone(),
            reference: Box::new(resolve_names_in_ast(reference, named_ranges, current_sheet_index, visited)),
            ref_site_id: Default::default(),
        },
        // TableRef is resolved separately by resolve_table_refs_in_ast — pass through
        ParserExpr::TableRef { .. } => ast.clone(),
        ParserExpr::IndexAccess { target, index } => ParserExpr::IndexAccess {
            target: Box::new(resolve_names_in_ast(target, named_ranges, current_sheet_index, visited)),
            index: Box::new(resolve_names_in_ast(index, named_ranges, current_sheet_index, visited)),
        },
        ParserExpr::ArrayLiteral { rows } => ParserExpr::ArrayLiteral {
            rows: rows.iter().map(|r| r.iter().map(|e| resolve_names_in_ast(e, named_ranges, current_sheet_index, visited)).collect()).collect(),
        },
        ParserExpr::ListLiteral { elements } => ParserExpr::ListLiteral {
            elements: elements.iter().map(|e| resolve_names_in_ast(e, named_ranges, current_sheet_index, visited)).collect(),
        },
        ParserExpr::DictLiteral { entries } => ParserExpr::DictLiteral {
            entries: entries.iter().map(|(k, v)| (
                resolve_names_in_ast(k, named_ranges, current_sheet_index, visited),
                resolve_names_in_ast(v, named_ranges, current_sheet_index, visited),
            )).collect(),
        },
        ParserExpr::SpillRef { cell, .. } => ParserExpr::SpillRef {
            cell: Box::new(resolve_names_in_ast(cell, named_ranges, current_sheet_index, visited)),
            ref_site_id: Default::default(),
        },
        ParserExpr::ImplicitIntersection { operand } => ParserExpr::ImplicitIntersection {
            operand: Box::new(resolve_names_in_ast(operand, named_ranges, current_sheet_index, visited)),
        },
    }
}

/// Like `resolve_names_in_ast`, but skips resolution for NamedRef nodes
/// whose uppercased name is in the `shadows` set. Used for LAMBDA/LET parameters
/// which should NOT be resolved as global named ranges.
fn resolve_names_in_ast_with_shadows(
    ast: &ParserExpr,
    named_ranges: &HashMap<String, named_ranges::NamedRange>,
    current_sheet_index: usize,
    visited: &mut HashSet<String>,
    shadows: &[String],
) -> ParserExpr {
    match ast {
        ParserExpr::NamedRef { name, .. } => {
            let key = name.to_uppercase();
            // If the name is shadowed by a LAMBDA/LET param, keep it as NamedRef
            if shadows.iter().any(|s| s == &key) {
                return ast.clone();
            }
            // Otherwise, delegate to the normal resolver
            resolve_names_in_ast(ast, named_ranges, current_sheet_index, visited)
        }
        ParserExpr::Literal(_) | ParserExpr::CellRef { .. }
        | ParserExpr::ColumnRef { .. } | ParserExpr::RowRef { .. }
        | ParserExpr::TableRef { .. } => ast.clone(),
        ParserExpr::BinaryOp { left, op, right } => ParserExpr::BinaryOp {
            left: Box::new(resolve_names_in_ast_with_shadows(left, named_ranges, current_sheet_index, visited, shadows)),
            op: *op,
            right: Box::new(resolve_names_in_ast_with_shadows(right, named_ranges, current_sheet_index, visited, shadows)),
        },
        ParserExpr::UnaryOp { op, operand } => ParserExpr::UnaryOp {
            op: *op,
            operand: Box::new(resolve_names_in_ast_with_shadows(operand, named_ranges, current_sheet_index, visited, shadows)),
        },
        ParserExpr::FunctionCall { func, args, .. } => {
            // For nested LAMBDA/LET inside a shadowed context, extend shadows
            match func {
                ParserBuiltinFn::Lambda if args.len() >= 2 => {
                    let mut inner_shadows: Vec<String> = shadows.to_vec();
                    for p_arg in &args[..args.len() - 1] {
                        if let ParserExpr::NamedRef { name, .. } = p_arg {
                            inner_shadows.push(name.to_uppercase());
                        }
                    }
                    let mut resolved_args: Vec<ParserExpr> = Vec::with_capacity(args.len());
                    for p_arg in &args[..args.len() - 1] {
                        resolved_args.push(p_arg.clone());
                    }
                    resolved_args.push(resolve_names_in_ast_with_shadows(
                        args.last().unwrap(), named_ranges, current_sheet_index, visited, &inner_shadows,
                    ));
                    ParserExpr::FunctionCall { func: func.clone(), args: resolved_args, ref_site_id: Default::default() }
                }
                ParserBuiltinFn::Let if args.len() >= 3 && args.len() % 2 == 1 => {
                    let pair_count = (args.len() - 1) / 2;
                    let mut inner_shadows: Vec<String> = shadows.to_vec();
                    for i in 0..pair_count {
                        if let ParserExpr::NamedRef { name, .. } = &args[i * 2] {
                            inner_shadows.push(name.to_uppercase());
                        }
                    }
                    let mut resolved_args: Vec<ParserExpr> = Vec::with_capacity(args.len());
                    for (idx, arg) in args.iter().enumerate() {
                        if idx % 2 == 0 && idx < args.len() - 1 {
                            resolved_args.push(arg.clone());
                        } else {
                            resolved_args.push(resolve_names_in_ast_with_shadows(
                                arg, named_ranges, current_sheet_index, visited, &inner_shadows,
                            ));
                        }
                    }
                    ParserExpr::FunctionCall { func: func.clone(), args: resolved_args, ref_site_id: Default::default() }
                }
                _ => {
                    // Check if a Custom function name is actually a named range
                    // (e.g., =testing(5,9) where "testing" is a named LAMBDA).
                    if let ParserBuiltinFn::Custom(ref custom_name) = func {
                        let key = custom_name.to_uppercase();
                        // Don't resolve if shadowed by a LAMBDA/LET parameter
                        if !shadows.iter().any(|s| s == &key) {
                            let nr = named_ranges
                                .values()
                                .find(|nr| {
                                    let nr_key = nr.name.to_uppercase();
                                    nr_key == key && nr.sheet_index == Some(current_sheet_index)
                                })
                                .or_else(|| {
                                    named_ranges.values().find(|nr| {
                                        let nr_key = nr.name.to_uppercase();
                                        nr_key == key && nr.sheet_index.is_none()
                                    })
                                });
                            if let Some(nr) = nr {
                                if let Ok(sub_ast) = parse_formula(&nr.refers_to) {
                                    visited.insert(key.clone());
                                    let resolved_callee = resolve_names_in_ast_with_shadows(
                                        &sub_ast, named_ranges, current_sheet_index, visited, shadows,
                                    );
                                    visited.remove(&key);
                                    // See the non-shadowed branch: a leading display-name
                                    // literal lets the formula bar render `Name(args)`.
                                    let mut invoke_args = vec![
                                        ParserExpr::Literal(ParserValue::String(nr.name.clone())),
                                        resolved_callee,
                                    ];
                                    for a in args {
                                        invoke_args.push(resolve_names_in_ast_with_shadows(
                                            a, named_ranges, current_sheet_index, visited, shadows,
                                        ));
                                    }
                                    return ParserExpr::FunctionCall {
                                        func: ParserBuiltinFn::Custom("__INVOKE__".to_string()),
                                        args: invoke_args,
                                        ref_site_id: Default::default(),
                                    };
                                }
                            }
                        }
                    }
                    ParserExpr::FunctionCall {
                        func: func.clone(),
                        args: args.iter().map(|a| resolve_names_in_ast_with_shadows(a, named_ranges, current_sheet_index, visited, shadows)).collect(),
                        ref_site_id: Default::default(),
                    }
                },
            }
        }
        ParserExpr::Range { sheet, start, end, .. } => ParserExpr::Range {
            sheet: sheet.clone(),
            start: Box::new(resolve_names_in_ast_with_shadows(start, named_ranges, current_sheet_index, visited, shadows)),
            end: Box::new(resolve_names_in_ast_with_shadows(end, named_ranges, current_sheet_index, visited, shadows)),
            ref_site_id: Default::default(),
        },
        ParserExpr::Sheet3DRef { start_sheet, end_sheet, reference, .. } => ParserExpr::Sheet3DRef {
            start_sheet: start_sheet.clone(),
            end_sheet: end_sheet.clone(),
            reference: Box::new(resolve_names_in_ast_with_shadows(reference, named_ranges, current_sheet_index, visited, shadows)),
            ref_site_id: Default::default(),
        },
        ParserExpr::IndexAccess { target, index } => ParserExpr::IndexAccess {
            target: Box::new(resolve_names_in_ast_with_shadows(target, named_ranges, current_sheet_index, visited, shadows)),
            index: Box::new(resolve_names_in_ast_with_shadows(index, named_ranges, current_sheet_index, visited, shadows)),
        },
        ParserExpr::ArrayLiteral { rows } => ParserExpr::ArrayLiteral {
            rows: rows.iter().map(|r| r.iter().map(|e| resolve_names_in_ast_with_shadows(e, named_ranges, current_sheet_index, visited, shadows)).collect()).collect(),
        },
        ParserExpr::ListLiteral { elements } => ParserExpr::ListLiteral {
            elements: elements.iter().map(|e| resolve_names_in_ast_with_shadows(e, named_ranges, current_sheet_index, visited, shadows)).collect(),
        },
        ParserExpr::DictLiteral { entries } => ParserExpr::DictLiteral {
            entries: entries.iter().map(|(k, v)| (
                resolve_names_in_ast_with_shadows(k, named_ranges, current_sheet_index, visited, shadows),
                resolve_names_in_ast_with_shadows(v, named_ranges, current_sheet_index, visited, shadows),
            )).collect(),
        },
        ParserExpr::SpillRef { cell, .. } => ParserExpr::SpillRef {
            cell: Box::new(resolve_names_in_ast_with_shadows(cell, named_ranges, current_sheet_index, visited, shadows)),
            ref_site_id: Default::default(),
        },
        ParserExpr::ImplicitIntersection { operand } => ParserExpr::ImplicitIntersection {
            operand: Box::new(resolve_names_in_ast_with_shadows(operand, named_ranges, current_sheet_index, visited, shadows)),
        },
    }
}

// ============================================================================
// ONE TYPED FORMULA, TWO FORMS  (D2 — defined names; §2aj — structured refs)
// ============================================================================

/// The two forms a freshly typed formula takes.
///
/// **`stored` is what the document keeps** and what the formula bar shows: the
/// tree the user typed, with **defined names and structured table references
/// left exactly as typed** and only SPILL references (`A1#`) resolved.
///
/// `expanded` is the same tree with the names spliced in and the specifiers
/// flattened to ranges. It is what this edit evaluates and what
/// `extract_all_references` reads, and it is `None` when the formula has neither
/// a name nor a structured reference, so the overwhelmingly common case pays no
/// clone.
///
/// WHY THE SPLIT EXISTS. `update_cell` used to store the EXPANDED tree: with
/// `RATE` = `$D$5`, typing `=RATE` left the cell holding `$D$5`. Excel stores the
/// name and resolves it while calculating, so repointing a name moves every
/// formula that uses it; storing the expansion makes a defined name a one-shot
/// typing macro instead. See `name_resolution` for the evaluation half and for
/// the dependency edge that keeps the two in step.
///
/// **A STRUCTURED REFERENCE IS THE SAME DEFECT** (§2aj), so it now takes the
/// same route. `=SUM(Sales[Amount])` used to be stored as `=SUM($A$2:$A$4)` — a
/// fixed rectangle in absolute coordinates, which is precisely what a
/// structured reference exists NOT to be. Adding a row to `Sales` left the
/// total at its old number with nothing saying so. The cell now keeps the
/// specifier, `name_resolution::eval_ast` resolves it against the table's
/// CURRENT extent on every evaluation, and `table_deps` carries the
/// table -> formula edge that makes a resize a recalculation. See `table_deps`.
///
/// SPILL REFERENCES STAY RESOLVED AT ENTRY, and that is not an inconsistency
/// left standing by accident: resolving one needs `state.spill_ranges`, a Mutex
/// the evaluator would have to take once per evaluated dependent, and the
/// register tracks it separately as §3bf.
pub struct EnteredFormula {
    /// The form the cell keeps. Names and structured references intact.
    pub stored: ParserExpr,
    /// The form this edit evaluates. `None` when it would equal `stored`.
    expanded: Option<ParserExpr>,
}

impl EnteredFormula {
    /// The tree to evaluate and to extract cell references from.
    pub fn evaluated(&self) -> &ParserExpr {
        self.expanded.as_ref().unwrap_or(&self.stored)
    }
}

/// Flatten every structured table reference in `ast` against the workbook's
/// CURRENT tables.
///
/// `sheet_names` is passed IN, and for the deadlock reason
/// [`resolve_spill_refs_at_entry`] documents rather than for convenience: every
/// caller already holds `state.sheet_names.read()` across this call. It is used
/// to QUALIFY a reference to a table on another sheet.
fn resolve_table_refs_now(
    state: &AppState,
    ast: &ParserExpr,
    sheet_index: usize,
    row: u32,
    col: u32,
    sheet_names: &[String],
) -> ParserExpr {
    if !ast_has_table_refs(ast) {
        return ast.clone();
    }
    let tables_map = state.tables.read().unwrap();
    let table_names_map = state.table_names.read().unwrap();
    let ctx = TableRefContext {
        tables: &tables_map,
        table_names: &table_names_map,
        current_sheet_index: sheet_index,
        current_row: row,
        current_col: col,
        sheet_names,
    };
    let r = resolve_table_refs_in_ast(ast, &ctx);
    drop(table_names_map);
    drop(tables_map);
    r
}

/// Expand `A1#` for the tree THIS edit evaluates — never for the tree the cell
/// stores (§3bf: the stored form keeps the `#`, and `name_resolution::eval_ast`
/// re-expands it against the live map on every later evaluation).
///
/// `sheet_names` is passed IN rather than read off `state`. Every caller
/// already holds `state.sheet_names.read()` across this call, and
/// `std::sync::RwLock` does not promise a recursive read is safe -- on Windows
/// (SRWLock) a second read on the same thread deadlocks outright as soon as a
/// writer is queued. Taking the lock here hung the suite.
fn resolve_spill_refs_at_entry(
    state: &AppState,
    ast: &ParserExpr,
    sheet_index: usize,
    sheet_names: &[String],
) -> ParserExpr {
    if !ast_has_spill_refs(ast) {
        return ast.clone();
    }
    let spill_ranges_map = state.spill_ranges.read().unwrap();
    let r = resolve_spill_refs_in_ast(ast, &spill_ranges_map, sheet_index, sheet_names);
    drop(spill_ranges_map);
    r
}

/// Split ONE parsed formula into the form the cell stores and the form this
/// edit evaluates. The single recipe behind `update_cell`, `update_cells_batch`
/// and `fill_range`, so all three agree about what a name and a structured
/// reference mean.
pub fn split_entered_formula(
    state: &AppState,
    parsed: &ParserExpr,
    sheet_index: usize,
    row: u32,
    col: u32,
    sheet_names: &[String],
) -> EnteredFormula {
    // §3bf. THE `#` IS KEPT. It used to be resolved into a fixed `Range` right
    // here, in the form the cell STORES — so `=SUM(A1#)` was kept, rendered in
    // the formula bar and saved as `=SUM(A1:A4)`, and stopped following its
    // array the instant the array changed length. In Excel `A1#` is a LIVE
    // reference to whatever the array currently spans, which is the whole point
    // of the operator; the stated blocker (the extent could not be re-derived
    // from the cell later) went away when v7 started persisting it.
    //
    // Same recipe as a defined name (D2) and a structured reference (§2aj):
    // keep the indirection in `stored`, expand it only into the tree THIS edit
    // evaluates, and let `name_resolution::eval_ast` re-expand it against the
    // live map on every later evaluation.
    let mut stored = parsed.clone();

    // The lexer UPPERCASES bare identifiers, which never showed while the name
    // was expanded away at entry. Now that the cell keeps it, put the name back
    // in the capitalisation the Name Manager holds — cosmetic only (every lookup
    // uppercases), and it is what Excel's formula bar shows.
    {
        let named_ranges_map = state.named_ranges.read().unwrap();
        name_resolution::restamp_name_casing(&mut stored, &named_ranges_map);
    }
    // Same argument, one authority over: the lexer shouts a table name and
    // `parse_bracket_content` shouts the column, so `Sales[Amount]` would be
    // kept as `SALES[AMOUNT]` (§2t, for tables).
    if ast_has_table_refs(&stored) {
        let tables_map = state.tables.read().unwrap();
        let table_names_map = state.table_names.read().unwrap();
        table_deps::restamp_table_casing(&mut stored, &tables_map, &table_names_map);
    }
    // And once more for the SHEET qualifier (§2ai): `=Data!A1` lexes as
    // `DATA!A1`, and the workbook's own sheet list is the authority.
    sheet_names::restamp_sheet_casing(&mut stored, sheet_names);

    let needs_names = ast_has_named_refs(&stored);
    let needs_tables = ast_has_table_refs(&stored);
    // A spill ref makes the expanded form MANDATORY: the evaluator resolves
    // neither `A1#` nor a name, so a formula that is nothing but `=SUM(A1#)`
    // would reach it unexpanded and answer nonsense.
    let needs_spills = ast_has_spill_refs(&stored);
    let expanded = if needs_names || needs_tables || needs_spills {
        let spliced = if needs_names {
            let named_ranges_map = state.named_ranges.read().unwrap();
            let mut visited = HashSet::new();
            let out =
                resolve_names_in_ast(&stored, &named_ranges_map, sheet_index, &mut visited);
            drop(named_ranges_map);
            out
        } else {
            stored.clone()
        };
        // The table pass runs AFTER the name splice, not instead of it: a
        // name's `refers_to` may itself be a structured reference
        // (`=Table1[Amount]`) that only becomes visible once the name is
        // expanded, and a spill ref may arrive the same way.
        let flattened =
            resolve_table_refs_now(state, &spliced, sheet_index, row, col, sheet_names);
        Some(resolve_spill_refs_at_entry(state, &flattened, sheet_index, sheet_names))
    } else {
        None
    };

    EnteredFormula { stored, expanded }
}

/// Checks if a parser AST contains any NamedRef nodes that need resolution.
pub fn ast_has_named_refs(ast: &ParserExpr) -> bool {
    match ast {
        ParserExpr::NamedRef { .. } => true,
        ParserExpr::Literal(_) | ParserExpr::CellRef { .. }
        | ParserExpr::ColumnRef { .. } | ParserExpr::RowRef { .. }
        | ParserExpr::TableRef { .. } => false,
        ParserExpr::BinaryOp { left, right, .. } => {
            ast_has_named_refs(left) || ast_has_named_refs(right)
        }
        ParserExpr::UnaryOp { operand, .. } => ast_has_named_refs(operand),
        ParserExpr::FunctionCall { func, args, .. } => {
            // Custom function names might be named ranges pointing to LAMBDAs
            if matches!(func, ParserBuiltinFn::Custom(_)) {
                return true;
            }
            args.iter().any(ast_has_named_refs)
        }
        ParserExpr::Range { start, end, .. } => {
            ast_has_named_refs(start) || ast_has_named_refs(end)
        }
        ParserExpr::Sheet3DRef { reference, .. } => ast_has_named_refs(reference),
        ParserExpr::IndexAccess { target, index } => {
            ast_has_named_refs(target) || ast_has_named_refs(index)
        }
        ParserExpr::ArrayLiteral { rows } => rows.iter().flatten().any(ast_has_named_refs),
        ParserExpr::ListLiteral { elements } => elements.iter().any(ast_has_named_refs),
        ParserExpr::DictLiteral { entries } => entries.iter().any(|(k, v)| ast_has_named_refs(k) || ast_has_named_refs(v)),
        ParserExpr::SpillRef { cell, .. } => ast_has_named_refs(cell),
        ParserExpr::ImplicitIntersection { operand } => ast_has_named_refs(operand),
    }
}

/// Checks if a parser AST contains any TableRef nodes that need resolution.
pub fn ast_has_table_refs(ast: &ParserExpr) -> bool {
    match ast {
        ParserExpr::TableRef { .. } => true,
        ParserExpr::Literal(_) | ParserExpr::CellRef { .. }
        | ParserExpr::ColumnRef { .. } | ParserExpr::RowRef { .. }
        | ParserExpr::NamedRef { .. } => false,
        ParserExpr::IndexAccess { target, index } => {
            ast_has_table_refs(target) || ast_has_table_refs(index)
        }
        ParserExpr::BinaryOp { left, right, .. } => {
            ast_has_table_refs(left) || ast_has_table_refs(right)
        }
        ParserExpr::UnaryOp { operand, .. } => ast_has_table_refs(operand),
        ParserExpr::FunctionCall { args, .. } => args.iter().any(ast_has_table_refs),
        ParserExpr::Range { start, end, .. } => {
            ast_has_table_refs(start) || ast_has_table_refs(end)
        }
        ParserExpr::Sheet3DRef { reference, .. } => ast_has_table_refs(reference),
        ParserExpr::ArrayLiteral { rows } => rows.iter().flatten().any(ast_has_table_refs),
        ParserExpr::ListLiteral { elements } => elements.iter().any(ast_has_table_refs),
        ParserExpr::DictLiteral { entries } => entries.iter().any(|(k, v)| ast_has_table_refs(k) || ast_has_table_refs(v)),
        ParserExpr::SpillRef { cell, .. } => ast_has_table_refs(cell),
        ParserExpr::ImplicitIntersection { operand } => ast_has_table_refs(operand),
    }
}

// ============================================================================
// TABLE REFERENCE RESOLUTION (AST SPLICING)
// ============================================================================

/// Context needed to resolve structured table references.
#[derive(Clone, Copy)]
pub struct TableRefContext<'a> {
    /// All tables indexed by sheet_index -> table_id -> Table
    pub tables: &'a tables::TableStorage,
    /// Table name registry: uppercase_name -> (sheet_index, table_id)
    pub table_names: &'a tables::TableNameRegistry,
    /// The sheet index where the formula cell lives
    pub current_sheet_index: usize,
    /// The row of the formula cell (0-indexed) — needed for @ (this-row) references
    pub current_row: u32,
    /// The column of the formula cell (0-indexed).
    ///
    /// Needed for the SAME reason as `current_row`, and it was missing. A bare
    /// `[@Amount]` means "the table THIS CELL IS IN", and `find_table_at_cell`
    /// decided that on the row range alone — so a formula in a far column on the
    /// same rows resolved against a table it is not in, answering with a
    /// plausible NUMBER where Excel answers `#NAME?`. A cell is inside a
    /// rectangle on BOTH axes or it is not inside it.
    pub current_col: u32,
    /// The workbook's sheet names, in index order.
    ///
    /// NOT decoration, and NOT for casing. A table's NAME is workbook-wide, so
    /// `=SUM(Sales[Amount])` is legal on any sheet — but the range it resolves
    /// to was built with `sheet: None`, which means "the sheet the formula is
    /// on". Written on Sheet2 against a table on Sheet1, that silently read
    /// Sheet2's `A2:A4`: the right rectangle on the wrong sheet, with no error
    /// anywhere. This is what lets the resolution QUALIFY the range when the
    /// table lives elsewhere.
    pub sheet_names: &'a [String],
}

/// Resolves all `TableRef` nodes in a parser AST by converting them to
/// `CellRef` or `Range` nodes based on the table definitions.
///
/// Table references like `Table1[Revenue]` become `Range(CellRef(data_start_row, col)..CellRef(data_end_row, col))`.
/// This-row references like `[@Revenue]` become `CellRef(current_row, col)`.
pub fn resolve_table_refs_in_ast(
    ast: &ParserExpr,
    ctx: &TableRefContext,
) -> ParserExpr {
    match ast {
        ParserExpr::TableRef { table_name, specifier, .. } => {
            resolve_single_table_ref(table_name, specifier, ctx)
        }
        ParserExpr::Literal(_) => ast.clone(),
        ParserExpr::CellRef { .. } => ast.clone(),
        ParserExpr::ColumnRef { .. } => ast.clone(),
        ParserExpr::RowRef { .. } => ast.clone(),
        ParserExpr::NamedRef { .. } => ast.clone(),
        ParserExpr::BinaryOp { left, op, right } => ParserExpr::BinaryOp {
            left: Box::new(resolve_table_refs_in_ast(left, ctx)),
            op: *op,
            right: Box::new(resolve_table_refs_in_ast(right, ctx)),
        },
        ParserExpr::UnaryOp { op, operand } => ParserExpr::UnaryOp {
            op: *op,
            operand: Box::new(resolve_table_refs_in_ast(operand, ctx)),
        },
        ParserExpr::FunctionCall { func, args, .. } => ParserExpr::FunctionCall {
            func: func.clone(),
            args: args.iter().map(|a| resolve_table_refs_in_ast(a, ctx)).collect(),
            ref_site_id: Default::default(),
        },
        ParserExpr::Range { sheet, start, end, .. } => ParserExpr::Range {
            sheet: sheet.clone(),
            start: Box::new(resolve_table_refs_in_ast(start, ctx)),
            end: Box::new(resolve_table_refs_in_ast(end, ctx)),
            ref_site_id: Default::default(),
        },
        // 3D cross-sheet reference: recurse into inner reference
        ParserExpr::Sheet3DRef { start_sheet, end_sheet, reference, .. } => ParserExpr::Sheet3DRef {
            start_sheet: start_sheet.clone(),
            end_sheet: end_sheet.clone(),
            reference: Box::new(resolve_table_refs_in_ast(reference, ctx)),
            ref_site_id: Default::default(),
        },
        ParserExpr::IndexAccess { target, index } => ParserExpr::IndexAccess {
            target: Box::new(resolve_table_refs_in_ast(target, ctx)),
            index: Box::new(resolve_table_refs_in_ast(index, ctx)),
        },
        ParserExpr::ArrayLiteral { rows } => ParserExpr::ArrayLiteral {
            rows: rows.iter().map(|r| r.iter().map(|e| resolve_table_refs_in_ast(e, ctx)).collect()).collect(),
        },
        ParserExpr::ListLiteral { elements } => ParserExpr::ListLiteral {
            elements: elements.iter().map(|e| resolve_table_refs_in_ast(e, ctx)).collect(),
        },
        ParserExpr::DictLiteral { entries } => ParserExpr::DictLiteral {
            entries: entries.iter().map(|(k, v)| (
                resolve_table_refs_in_ast(k, ctx),
                resolve_table_refs_in_ast(v, ctx),
            )).collect(),
        },
        ParserExpr::SpillRef { cell, .. } => ParserExpr::SpillRef {
            cell: Box::new(resolve_table_refs_in_ast(cell, ctx)),
            ref_site_id: Default::default(),
        },
        ParserExpr::ImplicitIntersection { operand } => ParserExpr::ImplicitIntersection {
            operand: Box::new(resolve_table_refs_in_ast(operand, ctx)),
        },
    }
}

/// Rewrite the TABLE NAME of every `TableRef` naming `old_name_upper` to
/// `new_name`, leaving the rest of the expression untouched.
///
/// This is what makes a table rename non-destructive. Renaming only re-keyed
/// the name registry, so `=SUM(Old[Amount])` no longer resolved — and an
/// unresolvable table ref degrades to a `NamedRef`, which the evaluator turns
/// into `#NAME?`. The app's own totals-row formulas (`SUBTOTAL(109,Old[Col])`)
/// broke the same way.
///
/// Unlike [`resolve_table_refs_in_ast`] this does NOT flatten anything: refs
/// stay structured, and refs to other tables are left completely alone. Bare
/// this-row refs (`[@Col]`, empty table name) are also untouched — they resolve
/// via the containing table, which a rename does not change.
///
/// Returns `(new_ast, changed)`.
pub fn rename_table_refs_in_ast(
    ast: &ParserExpr,
    old_name_upper: &str,
    new_name: &str,
) -> (ParserExpr, bool) {
    let mut changed = false;
    let out = rename_walk(ast, old_name_upper, new_name, &mut changed);
    (out, changed)
}

fn rename_walk(
    ast: &ParserExpr,
    old_upper: &str,
    new_name: &str,
    changed: &mut bool,
) -> ParserExpr {
    let rec = |e: &ParserExpr, changed: &mut bool| rename_walk(e, old_upper, new_name, changed);
    match ast {
        ParserExpr::TableRef { table_name, specifier, ref_site_id } => {
            if !table_name.is_empty() && table_name.to_uppercase() == old_upper {
                *changed = true;
                ParserExpr::TableRef {
                    table_name: new_name.to_string(),
                    specifier: specifier.clone(),
                    ref_site_id: *ref_site_id,
                }
            } else {
                ast.clone()
            }
        }
        ParserExpr::Literal(_)
        | ParserExpr::CellRef { .. }
        | ParserExpr::ColumnRef { .. }
        | ParserExpr::RowRef { .. }
        | ParserExpr::NamedRef { .. } => ast.clone(),
        ParserExpr::BinaryOp { left, op, right } => ParserExpr::BinaryOp {
            left: Box::new(rec(left, changed)),
            op: *op,
            right: Box::new(rec(right, changed)),
        },
        ParserExpr::UnaryOp { op, operand } => ParserExpr::UnaryOp {
            op: *op,
            operand: Box::new(rec(operand, changed)),
        },
        ParserExpr::FunctionCall { func, args, ref_site_id } => ParserExpr::FunctionCall {
            func: func.clone(),
            args: args.iter().map(|a| rec(a, changed)).collect(),
            ref_site_id: *ref_site_id,
        },
        ParserExpr::Range { sheet, start, end, ref_site_id } => ParserExpr::Range {
            sheet: sheet.clone(),
            start: Box::new(rec(start, changed)),
            end: Box::new(rec(end, changed)),
            ref_site_id: *ref_site_id,
        },
        ParserExpr::Sheet3DRef { start_sheet, end_sheet, reference, ref_site_id } => {
            ParserExpr::Sheet3DRef {
                start_sheet: start_sheet.clone(),
                end_sheet: end_sheet.clone(),
                reference: Box::new(rec(reference, changed)),
                ref_site_id: *ref_site_id,
            }
        }
        ParserExpr::IndexAccess { target, index } => ParserExpr::IndexAccess {
            target: Box::new(rec(target, changed)),
            index: Box::new(rec(index, changed)),
        },
        ParserExpr::ArrayLiteral { rows } => ParserExpr::ArrayLiteral {
            rows: rows
                .iter()
                .map(|r| r.iter().map(|e| rec(e, changed)).collect())
                .collect(),
        },
        ParserExpr::ListLiteral { elements } => ParserExpr::ListLiteral {
            elements: elements.iter().map(|e| rec(e, changed)).collect(),
        },
        ParserExpr::DictLiteral { entries } => ParserExpr::DictLiteral {
            entries: entries
                .iter()
                .map(|(k, v)| (rec(k, changed), rec(v, changed)))
                .collect(),
        },
        ParserExpr::SpillRef { cell, ref_site_id } => ParserExpr::SpillRef {
            cell: Box::new(rec(cell, changed)),
            ref_site_id: *ref_site_id,
        },
        ParserExpr::ImplicitIntersection { operand } => ParserExpr::ImplicitIntersection {
            operand: Box::new(rec(operand, changed)),
        },
    }
}

/// Resolves a single TableRef node to CellRef/Range based on table metadata.
fn resolve_single_table_ref(
    table_name: &str,
    specifier: &ParserTableSpecifier,
    ctx: &TableRefContext,
) -> ParserExpr {
    // Find the table
    // A BARE `[@Col]` means "the table this cell is in", so it is by definition
    // on the current sheet and carries no qualifier. A NAMED reference may name
    // a table anywhere in the workbook.
    let found = if table_name.is_empty() {
        find_table_at_cell(
            ctx.tables,
            ctx.current_sheet_index,
            ctx.current_row,
            ctx.current_col,
        )
        .map(|t| (t, ctx.current_sheet_index))
    } else {
        find_table_by_name(table_name, ctx.tables, ctx.table_names)
    };

    // The sheet qualifier every range below is built with: `None` when the table
    // is on the formula's own sheet (which is the overwhelmingly common case and
    // the only one that used to work), the sheet's OFFICIAL name otherwise.
    let qualifier: Option<String> = found.and_then(|(_, sheet)| {
        (sheet != ctx.current_sheet_index)
            .then(|| ctx.sheet_names.get(sheet).cloned())
            .flatten()
    });

    let table = match found.map(|(t, _)| t) {
        Some(t) => t,
        None => {
            // Table not found — leave as unresolvable (will become #NAME?)
            return ParserExpr::NamedRef {
                name: if table_name.is_empty() {
                    "TABLE_REF".to_string()
                } else {
                    table_name.to_string()
                },
                ref_site_id: Default::default(),
            };
        }
    };

    // Convert 0-based grid columns to 1-based A1 column letters
    match specifier {
        ParserTableSpecifier::Column(col_name) => {
            resolve_column_ref(&table, col_name, qualifier)
        }
        ParserTableSpecifier::ThisRow(col_name) => {
            resolve_this_row_ref(&table, col_name, ctx.current_row, qualifier)
        }
        ParserTableSpecifier::ColumnRange(start_col, end_col) => {
            resolve_column_range(&table, start_col, end_col, qualifier)
        }
        ParserTableSpecifier::ThisRowRange(start_col, end_col) => {
            resolve_this_row_range(&table, start_col, end_col, ctx.current_row, qualifier)
        }
        ParserTableSpecifier::AllRows => {
            make_range(qualifier, table.start_row, table.start_col, table.end_row, table.end_col)
        }
        ParserTableSpecifier::DataRows => {
            make_range(qualifier, table.data_start_row(), table.start_col, table.data_end_row(), table.end_col)
        }
        ParserTableSpecifier::Headers => {
            if table.style_options.header_row {
                make_range(qualifier, table.start_row, table.start_col, table.start_row, table.end_col)
            } else {
                // No header row — return error
                ParserExpr::NamedRef { name: "_UNRESOLVED_HEADERS".to_string(), ref_site_id: Default::default() }
            }
        }
        ParserTableSpecifier::Totals => {
            if table.style_options.total_row {
                make_range(qualifier, table.end_row, table.start_col, table.end_row, table.end_col)
            } else {
                ParserExpr::NamedRef { name: "_UNRESOLVED_TOTALS".to_string(), ref_site_id: Default::default() }
            }
        }
        ParserTableSpecifier::SpecialColumn(special_spec, col_name) => {
            resolve_special_column(&table, special_spec, col_name, qualifier)
        }
    }
}

/// Finds a table by name using the name registry, WITH the sheet it lives on.
///
/// The sheet index comes from the registry rather than from `Table::sheet_index`
/// deliberately: the registry is the authority the lookup already went through,
/// so the pair cannot disagree with itself.
fn find_table_by_name<'a>(
    name: &str,
    tables: &'a tables::TableStorage,
    table_names: &tables::TableNameRegistry,
) -> Option<(&'a tables::Table, usize)> {
    let key = name.to_uppercase();
    let (sheet_index, table_id) = table_names.get(&key)?;
    Some((tables.get(sheet_index)?.get(table_id)?, *sheet_index))
}

/// Finds the table that CONTAINS the given cell (for implicit table name
/// resolution — the bare `[@Column]` form, which means "the table this cell is
/// in").
///
/// BOTH AXES. This used to match on the row range alone, which made every cell
/// on a table's rows — however far to the side — look like part of it. A bare
/// specifier in a far column then resolved against a table the formula is not
/// in and returned a NUMBER; Excel returns `#NAME?`, because the unqualified
/// form is only legal inside the table (from anywhere else the reference must
/// name its table, `Sales[@Amount]`).
///
/// The ADJACENT column is not this case and must not be confused with it:
/// `check_table_auto_expand` absorbs a cell one column past `end_col` INTO the
/// table, so by the time a formula there is resolved the table really does
/// contain it. That is Excel's behaviour too, and it is handled by extending
/// the rectangle rather than by matching outside it.
fn find_table_at_cell(
    tables: &tables::TableStorage,
    sheet_index: usize,
    current_row: u32,
    current_col: u32,
) -> Option<&tables::Table> {
    // Look through all tables on the current sheet
    if let Some(sheet_tables) = tables.get(&sheet_index) {
        for table in sheet_tables.values() {
            if current_row >= table.start_row
                && current_row <= table.end_row
                && current_col >= table.start_col
                && current_col <= table.end_col
            {
                return Some(table);
            }
        }
    }
    None
}

/// Converts a 0-indexed column number to 1-based A1-style column letters.
fn index_to_col_letters(col_index: u32) -> String {
    let mut result = String::new();
    let mut n = col_index + 1; // Convert to 1-based
    while n > 0 {
        n -= 1;
        result.insert(0, (b'A' + (n % 26) as u8) as char);
        n /= 26;
    }
    result
}

/// Resolves Table1[Column] to a Range over the data rows of that column.
fn resolve_column_ref(
    table: &tables::Table,
    col_name: &str,
    sheet: Option<String>,
) -> ParserExpr {
    match table.get_column_index(col_name) {
        Some(col_idx) => {
            let abs_col = table.start_col + col_idx as u32;
            make_range(
                sheet,
                table.data_start_row(),
                abs_col,
                table.data_end_row(),
                abs_col,
            )
        }
        None => ParserExpr::NamedRef {
            name: format!("_UNRESOLVED_{}_{}", table.name, col_name),
            ref_site_id: Default::default(),
        },
    }
}

/// Resolves [@Column] to a single CellRef at the current row.
fn resolve_this_row_ref(
    table: &tables::Table,
    col_name: &str,
    current_row: u32,
    sheet: Option<String>,
) -> ParserExpr {
    // THE BARE `[#This Row]`: the formula's row across the WHOLE table, naming
    // no column at all. An empty column name is that spelling's marker — it is
    // unforgeable because `parse_bracket_content` refuses an empty name, so
    // `[@]` and `[]` are parse errors and nothing else can produce one.
    //
    // Without this the name falls through to `get_column_index("")`, finds
    // nothing, and degrades to `_UNRESOLVED_…` — which the user sees as #NAME?.
    // (Before the parser was fixed it was worse than an error: `[#This Row]` was
    // aliased to `[#Data]` and evaluated over EVERY data row.)
    if col_name.is_empty() {
        return make_range(
            sheet,
            current_row,
            table.start_col,
            current_row,
            table.end_col,
        );
    }
    match table.get_column_index(col_name) {
        Some(col_idx) => {
            let abs_col = table.start_col + col_idx as u32;
            let col_letters = index_to_col_letters(abs_col);
            // Row is 1-indexed in the AST
            ParserExpr::CellRef {
                sheet,
                col: col_letters,
                row: current_row + 1,
                col_absolute: true,
                row_absolute: true,
                ref_site_id: Default::default(),
            }
        }
        None => ParserExpr::NamedRef {
            name: format!("_UNRESOLVED_{}_{}", table.name, col_name),
            ref_site_id: Default::default(),
        },
    }
}

/// Resolves Table1[[Col1]:[Col2]] to a Range spanning those columns.
fn resolve_column_range(
    table: &tables::Table,
    start_col: &str,
    end_col: &str,
    sheet: Option<String>,
) -> ParserExpr {
    let start_idx = table.get_column_index(start_col);
    let end_idx = table.get_column_index(end_col);

    match (start_idx, end_idx) {
        (Some(si), Some(ei)) => {
            let abs_start_col = table.start_col + si as u32;
            let abs_end_col = table.start_col + ei as u32;
            make_range(
                sheet,
                table.data_start_row(),
                abs_start_col,
                table.data_end_row(),
                abs_end_col,
            )
        }
        _ => ParserExpr::NamedRef {
            name: format!("_UNRESOLVED_{}_RANGE", table.name),
            ref_site_id: Default::default(),
        },
    }
}

/// Resolves [@Col1]:[@Col2] to a Range on the current row spanning those columns.
fn resolve_this_row_range(
    table: &tables::Table,
    start_col: &str,
    end_col: &str,
    current_row: u32,
    sheet: Option<String>,
) -> ParserExpr {
    let start_idx = table.get_column_index(start_col);
    let end_idx = table.get_column_index(end_col);

    match (start_idx, end_idx) {
        (Some(si), Some(ei)) => {
            let abs_start_col = table.start_col + si as u32;
            let abs_end_col = table.start_col + ei as u32;
            make_range(
                sheet,
                current_row,
                abs_start_col,
                current_row,
                abs_end_col,
            )
        }
        _ => ParserExpr::NamedRef {
            name: format!("_UNRESOLVED_{}_RANGE", table.name),
            ref_site_id: Default::default(),
        },
    }
}

/// Resolves [#Headers],[Column] or [#Totals],[Column] combinations.
fn resolve_special_column(
    table: &tables::Table,
    special: &ParserTableSpecifier,
    col_name: &str,
    sheet: Option<String>,
) -> ParserExpr {
    let col_idx = match table.get_column_index(col_name) {
        Some(idx) => idx,
        None => {
            return ParserExpr::NamedRef {
                name: format!("_UNRESOLVED_{}_{}", table.name, col_name),
                ref_site_id: Default::default(),
            };
        }
    };
    let abs_col = table.start_col + col_idx as u32;

    match special {
        ParserTableSpecifier::Headers => {
            if table.style_options.header_row {
                make_range(sheet, table.start_row, abs_col, table.start_row, abs_col)
            } else {
                ParserExpr::NamedRef { name: "_UNRESOLVED_HEADERS".to_string(), ref_site_id: Default::default() }
            }
        }
        ParserTableSpecifier::Totals => {
            if table.style_options.total_row {
                make_range(sheet, table.end_row, abs_col, table.end_row, abs_col)
            } else {
                ParserExpr::NamedRef { name: "_UNRESOLVED_TOTALS".to_string(), ref_site_id: Default::default() }
            }
        }
        ParserTableSpecifier::AllRows => {
            make_range(sheet, table.start_row, abs_col, table.end_row, abs_col)
        }
        ParserTableSpecifier::DataRows => {
            make_range(sheet, table.data_start_row(), abs_col, table.data_end_row(), abs_col)
        }
        _ => ParserExpr::NamedRef {
            name: format!("_UNRESOLVED_SPECIAL_{}", table.name),
            ref_site_id: Default::default(),
        },
    }
}

/// Creates a Range expression from 0-indexed row/col coordinates.
/// Uses absolute references ($) for stability.
fn make_range(
    sheet: Option<String>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> ParserExpr {
    let start_col_letters = index_to_col_letters(start_col);
    let end_col_letters = index_to_col_letters(end_col);

    // If it's a single cell, return CellRef instead of Range
    if start_row == end_row && start_col == end_col {
        return ParserExpr::CellRef {
            sheet,
            col: start_col_letters,
            row: start_row + 1, // AST uses 1-indexed rows
            col_absolute: true,
            row_absolute: true,
            ref_site_id: Default::default(),
        };
    }

    ParserExpr::Range {
        sheet,
        start: Box::new(ParserExpr::CellRef {
            sheet: None,
            col: start_col_letters,
            row: start_row + 1, // AST uses 1-indexed rows
            col_absolute: true,
            row_absolute: true,
            ref_site_id: Default::default(),
        }),
        end: Box::new(ParserExpr::CellRef {
            sheet: None,
            col: end_col_letters,
            row: end_row + 1,
            col_absolute: true,
            row_absolute: true,
            ref_site_id: Default::default(),
        }),
        ref_site_id: Default::default(),
    }
}

// ============================================================================
// AST-to-formula serialization (for Convert to Range, etc.)
// ============================================================================

/// Converts a parser AST node back to a formula string.
/// Used by Convert to Range to rewrite table references as A1-style references.
/// Converts a parser AST node back to a formula string.
///
/// DELEGATES to the engine's canonical renderer. This file used to carry a
/// SECOND, hand-maintained serialiser: 224 explicit function-name arms plus
/// `other => format!("{:?}", other)`, a debug-format catch-all that covered 247
/// more. That fallback printed the RUST VARIANT NAME, so `CELL` was written
/// `CellFn`, `FORECAST` became `ForecastLinear` and `STDEV.S` became `StdevS` —
/// 47 built-ins whose rendered text is not an accepted spelling. Re-parsing
/// turned each into `Custom("CELLFN")`, an unknown user function, so every
/// sheet rename or delete silently converted those formulas into `#NAME?`
/// across the whole workbook. Two explicit arms had drifted as well
/// (`STDEV.P`/`VAR.P` against the canonical `STDEVP`/`VARP`), which made
/// `repair_all_formulas` rewrite untouched cells on every sheet operation
/// because the two serialisers disagreed about text they both round-tripped.
///
/// One renderer removes that whole class. `render_formula_raw` is the same
/// function persistence and the formula bar use, so what a sheet rename writes
/// is now what a save writes and what the user is shown.
pub fn expression_to_formula(expr: &ParserExpr) -> String {
    engine::ast_render::render_formula_raw(expr)
}


// ============================================================================
// 3D REFERENCE BOOKEND REPAIR
// ============================================================================

/// Repairs 3D reference bookends in a formula after a sheet is deleted.
/// - If the deleted sheet is a bookend, shrink to the adjacent sheet.
/// - If both bookends become invalid (single-sheet 3D ref deleted), returns None
///   to indicate the formula should show #REF!.
/// Returns Some(new_formula) if the formula was modified, None if it should become #REF!,
/// or the original formula unchanged if no 3D refs were affected.
pub fn repair_3d_refs_on_delete(
    formula: &str,
    deleted_name: &str,
    sheet_names_after: &[String],
) -> Option<String> {
    let ast = match parse_formula(formula) {
        Ok(ast) => ast,
        Err(_) => return Some(formula.to_string()),
    };

    let (new_ast, had_ref_error) = repair_3d_delete_recursive(&ast, deleted_name, sheet_names_after);
    if had_ref_error {
        return None; // Entire formula becomes #REF!
    }

    let new_formula = format!("={}", expression_to_formula(&new_ast));
    Some(unchanged_or(formula, &ast, new_formula))
}

/// The repaired text, or the CALLER'S ORIGINAL TEXT when the repair changed
/// nothing.
///
/// WHY THIS EXISTS. Both sheet repairs re-render the whole formula whether or
/// not they touched it, and the render is not the identity on text a user
/// typed: the lexer upper-cases every bare identifier, so `=Anchor` came back
/// `=ANCHOR` and `=LAMBDA(x, x*2)` came back `=LAMBDA(X,X*2)`. `repair_all_
/// formulas` then sees text that DIFFERS and rewrites the cell, so renaming or
/// deleting ANY sheet re-spelled every defined-name reference in the workbook —
/// including on sheets the operation never mentioned. That is §2t's defect
/// (`BudgetTotal` -> `BUDGETTOTAL`) on a path §2t's fix does not reach:
/// `restamp_workbook_name_casing` is called from `open_file`, not from here.
///
/// The test is on the AST, not on the text, so this is not "skip if the strings
/// look similar": if the repair produced the same tree it was given, the repair
/// did nothing, and doing nothing must leave the user's own spelling alone.
/// Formulas the rename really does touch are still rewritten — and their names
/// are put back into the Name Manager's spelling by the restamp the two callers
/// now run, which is the same function `open_file` uses.
fn unchanged_or(original_text: &str, original_ast: &ParserExpr, repaired: String) -> String {
    if format!("={}", expression_to_formula(original_ast)) == repaired {
        original_text.to_string()
    } else {
        repaired
    }
}

/// Recursively walks a parser AST and repairs Sheet3DRef bookends after sheet deletion.
/// Returns (new_ast, had_ref_error).
fn repair_3d_delete_recursive(
    ast: &ParserExpr,
    deleted_name: &str,
    sheet_names_after: &[String],
) -> (ParserExpr, bool) {
    match ast {
        ParserExpr::Sheet3DRef { start_sheet, end_sheet, reference, .. } => {
            let del_upper = deleted_name.to_uppercase();
            let start_is_deleted = start_sheet.to_uppercase() == del_upper;
            let end_is_deleted = end_sheet.to_uppercase() == del_upper;

            if start_is_deleted && end_is_deleted {
                // Both bookends are the deleted sheet — #REF!
                return (ast.clone(), true);
            }

            let new_start = if start_is_deleted {
                // Find the next sheet after the deleted one in the post-delete order
                // The "next" sheet is the one that was immediately after the deleted sheet
                // in the original order. In the post-delete list, we look for the sheet
                // that's now adjacent to where the deleted sheet was.
                find_adjacent_sheet(deleted_name, end_sheet, sheet_names_after, true)
            } else {
                Some(start_sheet.clone())
            };

            let new_end = if end_is_deleted {
                find_adjacent_sheet(deleted_name, start_sheet, sheet_names_after, false)
            } else {
                Some(end_sheet.clone())
            };

            match (new_start, new_end) {
                (Some(s), Some(e)) => {
                    let (new_ref, err) = repair_3d_delete_recursive(reference, deleted_name, sheet_names_after);
                    if err { return (ast.clone(), true); }
                    (ParserExpr::Sheet3DRef {
                        start_sheet: s,
                        end_sheet: e,
                        reference: Box::new(new_ref),
                        ref_site_id: Default::default(),
                    }, false)
                }
                _ => (ast.clone(), true), // Can't find replacement — #REF!
            }
        }
        ParserExpr::BinaryOp { left, op, right } => {
            let (new_left, l_err) = repair_3d_delete_recursive(left, deleted_name, sheet_names_after);
            let (new_right, r_err) = repair_3d_delete_recursive(right, deleted_name, sheet_names_after);
            (ParserExpr::BinaryOp {
                left: Box::new(new_left),
                op: *op,
                right: Box::new(new_right),
            }, l_err || r_err)
        }
        ParserExpr::UnaryOp { op, operand } => {
            let (new_op, err) = repair_3d_delete_recursive(operand, deleted_name, sheet_names_after);
            (ParserExpr::UnaryOp { op: *op, operand: Box::new(new_op) }, err)
        }
        ParserExpr::FunctionCall { func, args, .. } => {
            let mut new_args = Vec::new();
            let mut any_err = false;
            for arg in args {
                let (new_arg, err) = repair_3d_delete_recursive(arg, deleted_name, sheet_names_after);
                any_err = any_err || err;
                new_args.push(new_arg);
            }
            (ParserExpr::FunctionCall { func: func.clone(), args: new_args, ref_site_id: Default::default() }, any_err)
        }
        ParserExpr::Range { sheet, start, end, .. } => {
            if names_deleted_sheet(sheet, deleted_name) {
                return (ast.clone(), true);
            }
            let (new_start, s_err) = repair_3d_delete_recursive(start, deleted_name, sheet_names_after);
            let (new_end, e_err) = repair_3d_delete_recursive(end, deleted_name, sheet_names_after);
            (ParserExpr::Range {
                sheet: sheet.clone(),
                start: Box::new(new_start),
                end: Box::new(new_end),
                ref_site_id: Default::default(),
            }, s_err || e_err)
        }

        // PLAIN CROSS-SHEET REFERENCES.
        //
        // These four arms used to fall through to the `_` leaf arm below, so
        // `=Sheet2!A1` survived Sheet2's deletion VERBATIM. Nothing then
        // reported an error: the evaluator's `get_grid_for_sheet` resolved the
        // now-unknown name to the formula's OWN sheet, so the cell quietly
        // reported the local A1 instead of `#REF!` and saved that number to
        // disk. The rename twin (`repair_3d_rename_recursive`) has always
        // handled all four; the asymmetry between the two was the tell.
        ParserExpr::CellRef { sheet, .. }
        | ParserExpr::ColumnRef { sheet, .. }
        | ParserExpr::RowRef { sheet, .. }
            if names_deleted_sheet(sheet, deleted_name) =>
        {
            (ast.clone(), true)
        }

        // Leaf nodes — no 3D refs to repair
        _ => (ast.clone(), false),
    }
}

/// True when a reference's sheet qualifier names the sheet being deleted.
/// Case-insensitive, matching how sheets are resolved everywhere else.
fn names_deleted_sheet(sheet: &Option<String>, deleted_name: &str) -> bool {
    sheet
        .as_ref()
        .is_some_and(|s| s.to_uppercase() == deleted_name.to_uppercase())
}

/// Finds the sheet adjacent to the deleted one, constrained by the other bookend.
/// If `toward_start` is true, finds the first sheet in post-delete order.
/// If `toward_start` is false, finds the last sheet before the other bookend.
fn find_adjacent_sheet(
    _deleted_name: &str,
    other_bookend: &str,
    sheet_names_after: &[String],
    toward_start: bool,
) -> Option<String> {
    // The remaining bookend is `other_bookend`. We just need the first (or last)
    // sheet in the post-delete order. Since the deleted sheet is already removed
    // from sheet_names_after, the adjacent sheet is the first/last in the range
    // that includes the other bookend.
    let other_upper = other_bookend.to_uppercase();
    let other_idx = sheet_names_after.iter()
        .position(|s| s.to_uppercase() == other_upper)?;

    if toward_start {
        // The start bookend was deleted — new start is the sheet at the same position
        // (which was the next sheet after the deleted one in the original order)
        // In the simplest case, the first sheet in the remaining names works
        if other_idx > 0 {
            Some(sheet_names_after[0].clone())
        } else {
            Some(sheet_names_after[0].clone())
        }
    } else {
        // The end bookend was deleted — new end is the sheet just before other_bookend's position
        // in the post-delete order, or the last sheet
        if other_idx < sheet_names_after.len() - 1 {
            Some(sheet_names_after[sheet_names_after.len() - 1].clone())
        } else {
            Some(sheet_names_after[sheet_names_after.len() - 1].clone())
        }
    }
}

/// Repairs 3D reference bookends in a formula after a sheet is renamed.
/// Updates any bookend that matches the old name to use the new name.
pub fn repair_3d_refs_on_rename(formula: &str, old_name: &str, new_name: &str) -> String {
    let ast = match parse_formula(formula) {
        Ok(ast) => ast,
        Err(_) => return formula.to_string(),
    };

    let new_ast = repair_3d_rename_recursive(&ast, old_name, new_name);
    // See `unchanged_or`: a rename that touches nothing must not re-spell the
    // formula the user typed.
    unchanged_or(formula, &ast, format!("={}", expression_to_formula(&new_ast)))
}

/// Recursively walks a parser AST and updates Sheet3DRef bookend names.
fn repair_3d_rename_recursive(ast: &ParserExpr, old_name: &str, new_name: &str) -> ParserExpr {
    let old_upper = old_name.to_uppercase();
    match ast {
        ParserExpr::Sheet3DRef { start_sheet, end_sheet, reference, .. } => {
            let new_start = if start_sheet.to_uppercase() == old_upper {
                new_name.to_string()
            } else {
                start_sheet.clone()
            };
            let new_end = if end_sheet.to_uppercase() == old_upper {
                new_name.to_string()
            } else {
                end_sheet.clone()
            };
            ParserExpr::Sheet3DRef {
                start_sheet: new_start,
                end_sheet: new_end,
                reference: Box::new(repair_3d_rename_recursive(reference, old_name, new_name)),
                ref_site_id: Default::default(),
            }
        }
        // Also update regular cross-sheet refs (CellRef, Range, ColumnRef, RowRef with sheet=Some)
        ParserExpr::CellRef { sheet: Some(s), col, row, col_absolute, row_absolute, .. } => {
            let new_sheet = if s.to_uppercase() == old_upper {
                new_name.to_string()
            } else {
                s.clone()
            };
            ParserExpr::CellRef {
                sheet: Some(new_sheet),
                col: col.clone(),
                row: *row,
                col_absolute: *col_absolute,
                row_absolute: *row_absolute,
                ref_site_id: Default::default(),
            }
        }
        ParserExpr::Range { sheet: Some(s), start, end, .. } => {
            let new_sheet = if s.to_uppercase() == old_upper {
                new_name.to_string()
            } else {
                s.clone()
            };
            ParserExpr::Range {
                sheet: Some(new_sheet),
                start: Box::new(repair_3d_rename_recursive(start, old_name, new_name)),
                end: Box::new(repair_3d_rename_recursive(end, old_name, new_name)),
                ref_site_id: Default::default(),
            }
        }
        ParserExpr::ColumnRef { sheet: Some(s), start_col, end_col, start_absolute, end_absolute, .. } => {
            let new_sheet = if s.to_uppercase() == old_upper {
                new_name.to_string()
            } else {
                s.clone()
            };
            ParserExpr::ColumnRef {
                sheet: Some(new_sheet),
                start_col: start_col.clone(),
                end_col: end_col.clone(),
                start_absolute: *start_absolute,
                end_absolute: *end_absolute,
                ref_site_id: Default::default(),
            }
        }
        ParserExpr::RowRef { sheet: Some(s), start_row, end_row, start_absolute, end_absolute, .. } => {
            let new_sheet = if s.to_uppercase() == old_upper {
                new_name.to_string()
            } else {
                s.clone()
            };
            ParserExpr::RowRef {
                sheet: Some(new_sheet),
                start_row: *start_row,
                end_row: *end_row,
                start_absolute: *start_absolute,
                end_absolute: *end_absolute,
                ref_site_id: Default::default(),
            }
        }
        ParserExpr::BinaryOp { left, op, right } => ParserExpr::BinaryOp {
            left: Box::new(repair_3d_rename_recursive(left, old_name, new_name)),
            op: *op,
            right: Box::new(repair_3d_rename_recursive(right, old_name, new_name)),
        },
        ParserExpr::UnaryOp { op, operand } => ParserExpr::UnaryOp {
            op: *op,
            operand: Box::new(repair_3d_rename_recursive(operand, old_name, new_name)),
        },
        ParserExpr::FunctionCall { func, args, .. } => ParserExpr::FunctionCall {
            func: func.clone(),
            args: args.iter().map(|a| repair_3d_rename_recursive(a, old_name, new_name)).collect(),
            ref_site_id: Default::default(),
        },
        ParserExpr::Range { sheet: None, start, end, .. } => ParserExpr::Range {
            sheet: None,
            start: Box::new(repair_3d_rename_recursive(start, old_name, new_name)),
            end: Box::new(repair_3d_rename_recursive(end, old_name, new_name)),
            ref_site_id: Default::default(),
        },
        // Leaf nodes — no changes
        _ => ast.clone(),
    }
}

/// One cell whose REPAIRED formula text cannot be read back.
///
/// WHY THIS TYPE EXISTS (register §3bc, the `.ok()` leftover). The repair used
/// to store `parser::parse(&new_formula).ok().map(Box::new)`: a repaired
/// formula that failed to re-parse became `ast = None`, which is a cell with a
/// stale value, an EMPTY formula bar and no error anywhere. That swallow is the
/// mechanism that made every renderer defect silent — the 47 debug-formatted
/// function names, the missing parentheses, the sheet-name quoting, the `""`
/// escape — for however long each of them existed. Each produced text that
/// would not lex, and each was turned into a quietly deleted formula instead of
/// a visible failure.
///
/// EXCEL DECIDES THE SHAPE, per the standing parity rule: Excel refuses the
/// operation rather than corrupting the workbook. So does this — the repair is
/// PLAN-THEN-COMMIT and writes nothing at all unless every repaired formula in
/// the workbook re-parses, and the refusal names the cell so whoever can act on
/// it (the user, and the log) is told which formula stopped it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormulaRepairRefusal {
    /// Index into the `grids` slice the repair was given.
    pub sheet_index: usize,
    pub row: u32,
    pub col: u32,
    /// The formula as it stands in the workbook now (raw form).
    pub original: String,
    /// The text the repair produced, which is what would not parse.
    pub repaired: String,
    pub parse_error: String,
}

impl FormulaRepairRefusal {
    /// A message for the user. `sheet_names` is the caller's own sheet list,
    /// indexed the same way as the grids it passed in; an out-of-range index
    /// degrades to the number rather than panicking.
    pub fn message(&self, operation: &str, sheet_names: &[String]) -> String {
        let sheet = sheet_names
            .get(self.sheet_index)
            .cloned()
            .unwrap_or_else(|| format!("#{}", self.sheet_index));
        format!(
            "Cannot {}: the formula in {}!{} would be rewritten to `{}`, which cannot be read back ({}). \
             Nothing was changed.",
            operation,
            sheet,
            calcula_format::cell_ref::to_a1(self.row, self.col),
            self.repaired,
            self.parse_error,
        )
    }
}

impl std::fmt::Display for FormulaRepairRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "sheet #{} {} : `{}` -> `{}` ({})",
            self.sheet_index,
            calcula_format::cell_ref::to_a1(self.row, self.col),
            self.original,
            self.repaired,
            self.parse_error
        )
    }
}

/// What a planned repair does to one cell once the whole plan is accepted.
enum PlannedRepair {
    /// Replace the cell's AST with this already-parsed tree.
    Rewrite(Box<ParserExpr>),
    /// The formula's reference is gone: the cell becomes `#REF!`.
    RefError,
}

/// PLAN the repair of every formula in every grid WITHOUT touching any of them.
///
/// Every repaired formula is parsed HERE, before anything is written, so the
/// caller learns about an unreadable result while the workbook is still intact.
/// `skip_sheets` omits grids from the walk. Two callers need it: `delete_sheet`
/// pre-flights the repair before it removes the doomed sheet, and formulas on
/// that sheet are about to cease to exist, so refusing the delete because of one
/// of them would be a false refusal; and both sheet commands check the ACTIVE
/// sheet from `state.grid` instead, because `grids[active]` can lag behind it.
fn plan_formula_repair(
    grids: &[Grid],
    skip_sheets: &[usize],
    repair_fn: &dyn Fn(&str) -> Option<String>,
) -> Result<Vec<(usize, u32, u32, PlannedRepair)>, FormulaRepairRefusal> {
    let mut plan: Vec<(usize, u32, u32, PlannedRepair)> = Vec::new();
    for (sheet_index, grid) in grids.iter().enumerate() {
        if skip_sheets.contains(&sheet_index) {
            continue;
        }
        // RAW, not the display form. `formula_string()` COLLAPSES the internal
        // `__INVOKE__("MyFn", <lambda>, args)` marker a named LAMBDA call
        // carries down to `MyFn(args)`. Repairing that text and re-parsing it
        // produced `Custom("MYFN")` with no lambda attached, and since the
        // upper-cased result differs from the mixed-case original the cell was
        // REWRITTEN -- so renaming or deleting any sheet silently destroyed
        // every named-function call in the workbook, on every sheet, whether or
        // not it mentioned the sheet being changed. The raw form round-trips
        // through the repair untouched.
        let mut formula_cells: Vec<((u32, u32), String)> = grid.cells.iter()
            .filter_map(|((r, c), cell)| {
                cell.formula_string_raw().map(|f| ((*r, *c), f))
            })
            .collect();
        // Deterministic order so a workbook with two unreadable results always
        // refuses on the same one and the message does not depend on hash order.
        formula_cells.sort_by_key(|((r, c), _)| (*r, *c));

        for ((row, col), formula) in formula_cells {
            match repair_fn(&formula) {
                Some(new_formula) => {
                    if new_formula != formula {
                        match parser::parse(&new_formula) {
                            Ok(ast) => plan.push((
                                sheet_index,
                                row,
                                col,
                                PlannedRepair::Rewrite(Box::new(ast)),
                            )),
                            Err(e) => {
                                return Err(FormulaRepairRefusal {
                                    sheet_index,
                                    row,
                                    col,
                                    original: formula.clone(),
                                    repaired: new_formula,
                                    parse_error: e.to_string(),
                                })
                            }
                        }
                    }
                }
                // Formula should become #REF!
                None => plan.push((sheet_index, row, col, PlannedRepair::RefError)),
            }
        }
    }
    Ok(plan)
}

/// Would the repair go through? Answers without writing anything.
///
/// This is the PRE-FLIGHT for a caller that has destructive work to do before
/// the repair itself can run (`delete_sheet` removes the sheet first). Calling
/// it means the repair is parsed twice, which is the price of being able to
/// refuse the whole command before the first mutation — and both sheet
/// operations are already whole-workbook walks.
pub fn check_formulas_repairable(
    grids: &[Grid],
    skip_sheets: &[usize],
    repair_fn: &dyn Fn(&str) -> Option<String>,
) -> Result<(), FormulaRepairRefusal> {
    plan_formula_repair(grids, skip_sheets, repair_fn).map(|_| ())
}

/// Scans all formula cells across all grids and applies a repair function.
/// Used by sheet delete/rename to update 3D reference bookends.
///
/// ALL OR NOTHING. Every repaired formula is parsed before ANY cell is written;
/// if one of them cannot be read back the workbook is left exactly as it was
/// and the offending cell is returned. A caller that has already mutated other
/// state must undo that mutation, or refuse before it makes it — see
/// `check_formulas_repairable`.
pub fn repair_all_formulas(
    grids: &mut [Grid],
    repair_fn: &dyn Fn(&str) -> Option<String>,
) -> Result<(), FormulaRepairRefusal> {
    let plan = plan_formula_repair(grids, &[], repair_fn)?;
    for (sheet_index, row, col, outcome) in plan {
        let Some(grid) = grids.get_mut(sheet_index) else { continue };
        let Some(cell) = grid.cells.get_mut(&(row, col)) else { continue };
        match outcome {
            PlannedRepair::Rewrite(ast) => cell.ast = Some(ast),
            PlannedRepair::RefError => {
                cell.value = CellValue::Error(CellError::Ref);
                cell.ast = None;
            }
        }
    }
    Ok(())
}

pub fn evaluate_formula(grid: &Grid, formula: &str) -> CellValue {
    match parse_formula(formula) {
        Ok(parser_ast) => {
            let engine_ast = convert_expr(&parser_ast);
            let mut evaluator = Evaluator::new(grid);
            eval_budget::apply(&mut evaluator);
            let result = evaluator.evaluate(&engine_ast);
            result.to_cell_value()
        }
        Err(e) => {
            log_error!("EVAL", "parse_err formula={} err={}", formula, e);
            CellValue::Error(CellError::Value)
        }
    }
}

/// Evaluates a formula using a pre-parsed AST. More efficient than evaluate_formula
/// when the AST is already available (e.g., from cell's cached_ast).
pub fn evaluate_formula_with_ast(grid: &Grid, ast: &EngineExpr) -> CellValue {
    let mut evaluator = Evaluator::new(grid);
    eval_budget::apply(&mut evaluator);
    let result = evaluator.evaluate(ast);
    result.to_cell_value()
}

pub fn evaluate_formula_multi_sheet(
    grids: &[Grid],
    sheet_names: &[String],
    current_sheet_index: usize,
    formula: &str,
) -> CellValue {
    if current_sheet_index >= grids.len() || current_sheet_index >= sheet_names.len() {
        return CellValue::Error(CellError::Ref);
    }

    match parse_formula(formula) {
        Ok(parser_ast) => {
            let engine_ast = convert_expr(&parser_ast);

            let current_grid = &grids[current_sheet_index];
            let current_sheet_name = &sheet_names[current_sheet_index];

            let context = create_multi_sheet_context(grids, sheet_names, current_sheet_name);

            let mut evaluator = Evaluator::with_multi_sheet(current_grid, context);
            eval_budget::apply(&mut evaluator);
            evaluator.evaluate(&engine_ast).to_cell_value()
        }
        Err(e) => {
            log_error!("EVAL", "parse_err formula={} err={}", formula, e);
            CellValue::Error(CellError::Value)
        }
    }
}

/// Evaluates a formula using a pre-parsed AST with multi-sheet support.
/// This is the most efficient evaluation path when the AST is already cached.
pub fn evaluate_formula_multi_sheet_with_ast(
    grids: &[Grid],
    sheet_names: &[String],
    current_sheet_index: usize,
    ast: &EngineExpr,
) -> CellValue {
    if current_sheet_index >= grids.len() || current_sheet_index >= sheet_names.len() {
        return CellValue::Error(CellError::Ref);
    }

    let current_grid = &grids[current_sheet_index];
    let current_sheet_name = &sheet_names[current_sheet_index];

    let context = create_multi_sheet_context(grids, sheet_names, current_sheet_name);

    let mut evaluator = Evaluator::with_multi_sheet(current_grid, context);
    eval_budget::apply(&mut evaluator);
    evaluator.evaluate(ast).to_cell_value()
}

/// Evaluates a formula AST with EvalContext and optional StyleRegistry.
/// Used when the formula may need current cell position or style access (for GET.* functions).
pub fn evaluate_formula_with_context(
    grids: &[Grid],
    sheet_names: &[String],
    current_sheet_index: usize,
    ast: &EngineExpr,
    eval_ctx: engine::EvalContext,
    style_registry: Option<&engine::StyleRegistry>,
) -> CellValue {
    if current_sheet_index >= grids.len() || current_sheet_index >= sheet_names.len() {
        return CellValue::Error(CellError::Ref);
    }

    let current_grid = &grids[current_sheet_index];
    let current_sheet_name = &sheet_names[current_sheet_index];
    let context = create_multi_sheet_context(grids, sheet_names, current_sheet_name);
    let mut evaluator = Evaluator::with_context(current_grid, context, eval_ctx);
    eval_budget::apply(&mut evaluator);
    if let Some(sr) = style_registry {
        evaluator.set_styles(sr);
    }
    evaluator.evaluate(ast).to_cell_value()
}

/// Like `evaluate_formula_with_context` but with file reader support.
pub fn evaluate_formula_with_context_and_files(
    grids: &[Grid],
    sheet_names: &[String],
    current_sheet_index: usize,
    ast: &EngineExpr,
    eval_ctx: engine::EvalContext,
    style_registry: Option<&engine::StyleRegistry>,
    user_files: &HashMap<String, Vec<u8>>,
) -> CellValue {
    if current_sheet_index >= grids.len() || current_sheet_index >= sheet_names.len() {
        return CellValue::Error(CellError::Ref);
    }

    let current_grid = &grids[current_sheet_index];
    let current_sheet_name = &sheet_names[current_sheet_index];
    let context = create_multi_sheet_context(grids, sheet_names, current_sheet_name);
    let reader = |path: &str| -> Option<String> {
        user_files.get(path).and_then(|bytes| String::from_utf8(bytes.clone()).ok())
    };
    let mut evaluator = Evaluator::with_context(current_grid, context, eval_ctx);
    eval_budget::apply(&mut evaluator);
    if let Some(sr) = style_registry {
        evaluator.set_styles(sr);
    }
    evaluator.set_file_reader(&reader);
    evaluator.evaluate(ast).to_cell_value()
}

/// Like `evaluate_formula_with_context_and_files` but with pivot data lookup
/// and GATHER writeback-submission lookup support.
pub fn evaluate_formula_with_pivot(
    grids: &[Grid],
    sheet_names: &[String],
    current_sheet_index: usize,
    ast: &EngineExpr,
    eval_ctx: engine::EvalContext,
    style_registry: Option<&engine::StyleRegistry>,
    user_files: &HashMap<String, Vec<u8>>,
    pivot_data_fn: Option<&dyn Fn(&str, u32, u32, &[(&str, &str)]) -> Option<f64>>,
    gather_fn: Option<&dyn Fn(&str) -> engine::GatherRegionData>,
) -> CellValue {
    evaluate_formula_raw_with_files_and_pivot(
        grids, sheet_names, current_sheet_index, ast, eval_ctx,
        style_registry, user_files, pivot_data_fn, gather_fn, None,
    )
    .to_cell_value()
}

/// Evaluates a formula AST with context, returning the raw EvalResult.
/// Used for dynamic array functions that need spill handling.
pub fn evaluate_formula_raw(
    grids: &[Grid],
    sheet_names: &[String],
    current_sheet_index: usize,
    ast: &EngineExpr,
    eval_ctx: engine::EvalContext,
    style_registry: Option<&engine::StyleRegistry>,
) -> EvalResult {
    if current_sheet_index >= grids.len() || current_sheet_index >= sheet_names.len() {
        return EvalResult::Error(CellError::Ref);
    }

    let current_grid = &grids[current_sheet_index];
    let current_sheet_name = &sheet_names[current_sheet_index];
    let context = create_multi_sheet_context(grids, sheet_names, current_sheet_name);
    let mut evaluator = Evaluator::with_context(current_grid, context, eval_ctx);
    eval_budget::apply(&mut evaluator);
    if let Some(sr) = style_registry {
        evaluator.set_styles(sr);
    }
    evaluator.evaluate(ast)
}

/// Like `evaluate_formula_raw` but with file reader support.
pub fn evaluate_formula_raw_with_files(
    grids: &[Grid],
    sheet_names: &[String],
    current_sheet_index: usize,
    ast: &EngineExpr,
    eval_ctx: engine::EvalContext,
    style_registry: Option<&engine::StyleRegistry>,
    user_files: &HashMap<String, Vec<u8>>,
) -> EvalResult {
    evaluate_formula_raw_with_files_and_pivot(
        grids, sheet_names, current_sheet_index, ast, eval_ctx,
        style_registry, user_files, None, None, None,
    )
}

/// Like `evaluate_formula_raw_with_files` but also supports GETPIVOTDATA via an optional closure.
pub fn evaluate_formula_raw_with_files_and_pivot(
    grids: &[Grid],
    sheet_names: &[String],
    current_sheet_index: usize,
    ast: &EngineExpr,
    eval_ctx: engine::EvalContext,
    style_registry: Option<&engine::StyleRegistry>,
    user_files: &HashMap<String, Vec<u8>>,
    pivot_data_fn: Option<&dyn Fn(&str, u32, u32, &[(&str, &str)]) -> Option<f64>>,
    gather_fn: Option<&dyn Fn(&str) -> engine::GatherRegionData>,
    udf_fn: Option<&dyn Fn(&str, &[EvalResult]) -> Option<EvalResult>>,
) -> EvalResult {
    if current_sheet_index >= grids.len() || current_sheet_index >= sheet_names.len() {
        return EvalResult::Error(CellError::Ref);
    }

    let current_grid = &grids[current_sheet_index];
    let current_sheet_name = &sheet_names[current_sheet_index];
    let context = create_multi_sheet_context(grids, sheet_names, current_sheet_name);
    let reader = |path: &str| -> Option<String> {
        user_files.get(path).and_then(|bytes| String::from_utf8(bytes.clone()).ok())
    };
    let mut evaluator = Evaluator::with_context(current_grid, context, eval_ctx);
    eval_budget::apply(&mut evaluator);
    if let Some(sr) = style_registry {
        evaluator.set_styles(sr);
    }
    evaluator.set_file_reader(&reader);
    if let Some(pf) = pivot_data_fn {
        evaluator.set_pivot_data_fn(pf);
    }
    if let Some(gf) = gather_fn {
        evaluator.set_gather_fn(gf);
    }
    if let Some(uf) = udf_fn {
        evaluator.set_udf_fn(uf);
    }
    evaluator.evaluate(ast)
}

/// Evaluates a formula AST using a pre-built evaluator. This is the fastest path
/// for batch operations where the same evaluator can be reused across many formulas.
pub fn evaluate_ast_with_evaluator(evaluator: &Evaluator, ast: &EngineExpr) -> CellValue {
    evaluator.evaluate(ast).to_cell_value()
}

/// Creates an Evaluator with multi-sheet context. Reuse this for batch evaluations
/// to avoid recreating the context (HashMap + string cloning) for each formula.
pub fn create_evaluator_for_sheet<'a>(
    grids: &'a [Grid],
    sheet_names: &[String],
    current_sheet_index: usize,
) -> Option<Evaluator<'a>> {
    if current_sheet_index >= grids.len() || current_sheet_index >= sheet_names.len() {
        return None;
    }

    let current_grid = &grids[current_sheet_index];
    let current_sheet_name = &sheet_names[current_sheet_index];
    let context = create_multi_sheet_context(grids, sheet_names, current_sheet_name);
    let mut evaluator = Evaluator::with_multi_sheet(current_grid, context);
    eval_budget::apply(&mut evaluator);
    Some(evaluator)
}

/// Creates an Evaluator with multi-sheet context and file reader support.
pub fn create_evaluator_with_files<'a>(
    grids: &'a [Grid],
    sheet_names: &[String],
    current_sheet_index: usize,
    file_reader: Option<&'a dyn Fn(&str) -> Option<String>>,
) -> Option<Evaluator<'a>> {
    if current_sheet_index >= grids.len() || current_sheet_index >= sheet_names.len() {
        return None;
    }

    let current_grid = &grids[current_sheet_index];
    let current_sheet_name = &sheet_names[current_sheet_index];
    let context = create_multi_sheet_context(grids, sheet_names, current_sheet_name);
    let mut evaluator = Evaluator::with_multi_sheet(current_grid, context);
    eval_budget::apply(&mut evaluator);
    if let Some(reader) = file_reader {
        evaluator.set_file_reader(reader);
    }
    Some(evaluator)
}

/// Like `evaluate_formula_multi_sheet` but with file reader support for FILEREAD/FILELINES/FILEEXISTS.
pub fn evaluate_formula_multi_sheet_with_files(
    grids: &[Grid],
    sheet_names: &[String],
    current_sheet_index: usize,
    formula: &str,
    user_files: &HashMap<String, Vec<u8>>,
) -> CellValue {
    if current_sheet_index >= grids.len() || current_sheet_index >= sheet_names.len() {
        return CellValue::Error(CellError::Ref);
    }

    match parse_formula(formula) {
        Ok(parser_ast) => {
            let engine_ast = convert_expr(&parser_ast);
            let current_grid = &grids[current_sheet_index];
            let current_sheet_name = &sheet_names[current_sheet_index];
            let context = create_multi_sheet_context(grids, sheet_names, current_sheet_name);
            let reader = |path: &str| -> Option<String> {
                user_files.get(path).and_then(|bytes| String::from_utf8(bytes.clone()).ok())
            };
            let mut evaluator = Evaluator::with_multi_sheet(current_grid, context);
            eval_budget::apply(&mut evaluator);
            evaluator.set_file_reader(&reader);
            evaluator.evaluate(&engine_ast).to_cell_value()
        }
        Err(e) => {
            log_error!("EVAL", "parse_err formula={} err={}", formula, e);
            CellValue::Error(CellError::Value)
        }
    }
}

/// Like `evaluate_formula_multi_sheet_with_ast` but with file reader support.
pub fn evaluate_formula_multi_sheet_with_ast_and_files(
    grids: &[Grid],
    sheet_names: &[String],
    current_sheet_index: usize,
    ast: &EngineExpr,
    user_files: &HashMap<String, Vec<u8>>,
) -> CellValue {
    evaluate_formula_raw_with_ast_and_files(grids, sheet_names, current_sheet_index, ast, user_files, None)
        .to_cell_value()
}

/// Like evaluate_formula_multi_sheet_with_ast_and_files but returns the raw EvalResult,
/// preserving array/spill information needed for cascade spill recalculation.
///
/// `udf_fn` (Wave 3 / C1): the dependent-recalc cascade routes through here, so a
/// dependent cell like B1=MYFN(A1) must serve the pre-fetched UDF table too, or
/// editing A1 would recompute B1 to #NAME?. Pivot/gather/styles remain
/// unthreaded here (unchanged limitation); only the UDF resolver is added.
pub fn evaluate_formula_raw_with_ast_and_files(
    grids: &[Grid],
    sheet_names: &[String],
    current_sheet_index: usize,
    ast: &EngineExpr,
    user_files: &HashMap<String, Vec<u8>>,
    udf_fn: Option<&dyn Fn(&str, &[EvalResult]) -> Option<EvalResult>>,
) -> EvalResult {
    evaluate_formula_raw_with_ast_files_and_cube(
        grids, sheet_names, current_sheet_index, ast, user_files, udf_fn, None,
        None, // GET.CONTROLVALUE unavailable here (v1)
    )
}

/// Like `evaluate_formula_raw_with_ast_and_files` but also threads the pre-fetched
/// CUBE data, so a dependent cube cell (e.g. C1=CUBEVALUE(.., B2)) recomputes
/// correctly when its precedent (B2=CUBEMEMBER(..)) is edited.
pub fn evaluate_formula_raw_with_ast_files_and_cube(
    grids: &[Grid],
    sheet_names: &[String],
    current_sheet_index: usize,
    ast: &EngineExpr,
    user_files: &HashMap<String, Vec<u8>>,
    udf_fn: Option<&dyn Fn(&str, &[EvalResult]) -> Option<EvalResult>>,
    cube: Option<std::sync::Arc<engine::CubePrefetch>>,
    control_values: Option<std::sync::Arc<crate::control_values::ControlValuesMap>>,
) -> EvalResult {
    if current_sheet_index >= grids.len() || current_sheet_index >= sheet_names.len() {
        return EvalResult::Error(CellError::Ref);
    }

    let current_grid = &grids[current_sheet_index];
    let current_sheet_name = &sheet_names[current_sheet_index];
    let context = create_multi_sheet_context(grids, sheet_names, current_sheet_name);
    let reader = |path: &str| -> Option<String> {
        user_files.get(path).and_then(|bytes| String::from_utf8(bytes.clone()).ok())
    };
    let mut evaluator = Evaluator::with_multi_sheet(current_grid, context);
    eval_budget::apply(&mut evaluator);
    evaluator.set_file_reader(&reader);
    if let Some(uf) = udf_fn {
        evaluator.set_udf_fn(uf);
    }
    if let Some(c) = cube {
        evaluator.set_cube_prefetch(c);
    }
    if let Some(cv) = control_values { evaluator.set_control_values(cv); }
    evaluator.evaluate(ast)
}

/// Parses a formula and converts it to the engine AST.
/// Returns the engine AST suitable for caching in a Cell.
pub fn parse_formula_to_engine_ast(formula: &str) -> Result<EngineExpr, String> {
    match parse_formula(formula) {
        Ok(parser_ast) => Ok(convert_expr(&parser_ast)),
        Err(e) => Err(format!("{}", e)),
    }
}

/// Creates a reusable MultiSheetContext for batch formula evaluation.
/// This is more efficient than creating a new context for each formula.
pub fn create_multi_sheet_context<'a>(
    grids: &'a [Grid],
    sheet_names: &[String],
    current_sheet_name: &str,
) -> MultiSheetContext<'a> {
    let mut context = MultiSheetContext::new(current_sheet_name.to_string());
    for (i, grid) in grids.iter().enumerate() {
        if i < sheet_names.len() {
            context.add_grid(sheet_names[i].clone(), grid);
        }
    }
    // Populate sheet_order for 3D reference evaluation
    context.sheet_order = sheet_names.to_vec();
    context
}

/// Batch evaluates multiple formulas efficiently by reusing the context.
/// Returns a vector of (row, col, result) tuples.
pub fn batch_evaluate_formulas(
    grids: &[Grid],
    sheet_names: &[String],
    current_sheet_index: usize,
    formulas: &[((u32, u32), &str)], // ((row, col), formula)
) -> Vec<((u32, u32), CellValue)> {
    if current_sheet_index >= grids.len() || current_sheet_index >= sheet_names.len() {
        return formulas
            .iter()
            .map(|((r, c), _)| ((*r, *c), CellValue::Error(CellError::Ref)))
            .collect();
    }

    let current_grid = &grids[current_sheet_index];
    let current_sheet_name = &sheet_names[current_sheet_index];

    // Build context once for all formulas
    let context = create_multi_sheet_context(grids, sheet_names, current_sheet_name);
    let mut evaluator = Evaluator::with_multi_sheet(current_grid, context);
    eval_budget::apply(&mut evaluator);

    formulas
        .iter()
        .map(|((row, col), formula)| {
            let result = match parse_formula(formula) {
                Ok(parser_ast) => {
                    let engine_ast = convert_expr(&parser_ast);
                    evaluator.evaluate(&engine_ast).to_cell_value()
                }
                Err(_) => CellValue::Error(CellError::Value),
            };
            ((*row, *col), result)
        })
        .collect()
}

pub fn parse_cell_input(input: &str, locale: &engine::LocaleSettings) -> Cell {
    parse_cell_input_with_format(input, locale).0
}

/// `parse_cell_input`, plus the number format the ENTRY ITSELF implies.
///
/// A `Cell` carries a `style_index`, not a format, and this function cannot see
/// the workbook's `StyleRegistry` — so it cannot apply the format it discovers.
/// It hands it back instead, because the VALUE alone is not the whole answer:
/// "2020-06-01" stored as serial 43983 and displayed as `43983` is not what the
/// user typed, and "50%" has had exactly that defect from the beginning (it
/// stores 0.5 and displays "0.5" unless the cell already carried a percentage
/// format).
///
/// Applying it is the caller's job, because the caller is what owns the style
/// registry: intern `styles.get(existing_index).clone().with_number_format(fmt)`
/// through `StyleRegistry::get_or_create` and assign the returned index — and
/// only when the cell's current format is `General`, so an explicit format the
/// user already chose is never overwritten by what they typed into it.
///
/// NO DESTINATION IN VIEW. This spelling cannot see where the entry lands, so
/// the Text-format rung of the ladder is dead for it. That is right for the
/// callers that genuinely have no cell (CSV/BI value conversion, the UDF edit
/// list); an entry path that DOES have one must pass it — see
/// `parse_cell_input_in_format`.
pub fn parse_cell_input_with_format(
    input: &str,
    locale: &engine::LocaleSettings,
) -> (Cell, Option<NumberFormat>) {
    parse_cell_input_in_format(input, locale, None)
}

/// Whether a number format is Excel's Text format — the `@` code, and only it.
///
/// A custom code that merely CONTAINS an `@` section (`"id "@`) is not the Text
/// category: it says how to draw text that is already there, not that whatever
/// is entered here IS text. The same one-character test decides the overflow
/// class in `api_types::overflow_class_for`, and the two must agree — a cell
/// whose entry is stored as text but whose digits are then marked '####' is a
/// contradiction visible on screen.
pub fn is_text_format(format: &NumberFormat) -> bool {
    matches!(format, NumberFormat::Custom { format } if format == "@")
}

/// The number format an entry at (row, col) actually lands in.
///
/// `Grid::effective_style_index` and NOT `cell.style_index`, because a cell's
/// own index stays 0 until something formats that exact cell — and formatting a
/// whole COLUMN as Text is how a column of ZIP codes or part numbers is
/// protected. Reading the cell's own index would make the Text format work only
/// where someone had ALSO formatted each cell individually, which is the case
/// that needs it least.
pub fn entry_format_at(
    grid: &Grid,
    styles: &StyleRegistry,
    row: u32,
    col: u32,
) -> NumberFormat {
    styles
        .get(grid.effective_style_index(row, col))
        .number_format
        .clone()
}

/// The typed-entry ladder, told which number format the entry is landing in.
///
/// `target_format` is the format that ACTUALLY applies at the destination
/// (`entry_format_at`), or `None` where there is no destination.
///
/// THE ORDER, rung by rung, and why each one sits where it does:
///
/// 1. **empty** — an empty entry is an empty cell, never a text cell.
/// 2. **leading `'`** — Excel's escape: "store the rest as text, and do not show
///    me the apostrophe". FIRST, because it overrides everything below it
///    INCLUDING rung 3: `'123` in a Text-formatted cell must store `123`, not a
///    visible apostrophe. `''abc` therefore stores `'abc`, which is Excel's own
///    way to type a literal leading apostrophe, and falls out of "the rest,
///    verbatim" rather than being a case of its own.
/// 3. **the Text format** — an entry into an `@` cell is stored as TEXT,
///    verbatim. Above `=` because Excel stores a formula typed into a
///    Text-formatted cell as the literal string too, and above the number rung
///    because that is the whole point: `007` typed into a Text cell used to be
///    stored as the NUMBER 7 and then re-rendered through `General`, so the cell
///    displayed "7" — the leading zeros destroyed, silently, which is precisely
///    the loss (part numbers, ZIP codes) the Text format exists to prevent.
/// 4. **`=` formula**.
/// 5. **TRUE/FALSE**.
/// 6. **an error literal** — `#N/A`, `#DIV/0!` and the rest; see
///    [`typed_error_literal`]. Below the Text format and the apostrophe (both of
///    which are the user saying "this is a string"), above the number rung,
///    where it cannot collide because no error literal is also a number.
/// 7. **number (and `%`)** — before dates, because a bare `43983` is the number
///    43983 and not a date.
/// 8. **date/time**.
/// 9. **leading `+`/`-` formula** — the Lotus habit; after the number rung so
///    that `-5` stays a number and only `-A1` becomes a formula. It requires
///    something to actually FOLLOW the sign; see the rung.
/// 10. **text**.
///
/// Rungs 3 and 7/8 are mirror images and must not fight: rung 3 is the FORMAT
/// deciding the value, rungs 7/8 are the VALUE implying a format. They cannot
/// both fire — rung 3 returns before them and reports no implied format, so a
/// Text-formatted cell can never have its own format overwritten by what was
/// typed into it.
pub fn parse_cell_input_in_format(
    input: &str,
    locale: &engine::LocaleSettings,
    target_format: Option<&NumberFormat>,
) -> (Cell, Option<NumberFormat>) {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return (Cell::new(), None);
    }
    // RUNG 2. The rest is stored VERBATIM — and the escape is read off the
    // input BEFORE the trailing trim, because `trimmed` is the wrong string to
    // read it from. Typing `'  007  ` is the user saying "keep exactly these
    // characters"; taking the apostrophe off `trimmed` honoured the LEADING
    // spaces and silently ate the TRAILING ones, so the one entry form that
    // exists to preserve whitespace preserved half of it. `trim_start` only, so
    // an apostrophe typed after a stray leading space is still the escape it
    // was before.
    if let Some(rest) = input.trim_start().strip_prefix('\'') {
        return (
            Cell::new_text(rest.to_string()),
            apostrophe_implied_format(rest, locale),
        );
    }
    // RUNG 3. See the ladder doc: this is the half that used to lose data.
    if target_format.is_some_and(is_text_format) {
        return (Cell::new_text(trimmed.to_string()), None);
    }
    if trimmed.starts_with('=') {
        // Delocalize the formula: convert locale separators to invariant format for storage
        let invariant = engine::delocalize_formula(trimmed, locale);
        return (Cell::new_formula(invariant), None);
    }
    let upper = trimmed.to_uppercase();
    if upper == "TRUE" {
        return (Cell::new_boolean(true), None);
    }
    if upper == "FALSE" {
        return (Cell::new_boolean(false), None);
    }
    // ERROR LITERALS. Without this rung `#N/A` was stored as the TEXT "#N/A" —
    // a cell that LOOKS exactly right and is wrong to every test over it:
    // `ISNA` FALSE, `IFERROR` passing it straight through, `ISTEXT` TRUE and
    // `COUNTA` counting a string. See `typed_error_literal`.
    if let Some(error) = typed_error_literal(&upper) {
        return (error_cell(error), None);
    }
    if let Some(num) = parse_number(trimmed, locale) {
        return (Cell::new_number(num), implied_percentage_format(trimmed, locale));
    }
    // DATES AND TIMES. A typed date used to stay LITERAL TEXT: "2020-06-01" was
    // a string, so every date function, every date axis and every sort treated
    // it as one, and the cell right-aligned like text. Placed AFTER
    // `parse_number` (a bare `43983` is the number 43983, not a date) and
    // before the leading +/- rule, so `-1-2` is still a formula.
    if let Some((serial, format)) = parse_date_time_input(trimmed, locale) {
        return (Cell::new_number(serial), Some(format));
    }
    // A LEADING `+` OR `-` THAT IS NOT A NUMBER STARTS A FORMULA, as it does in
    // Excel — another Lotus 1-2-3 habit it never dropped, and one a lot of
    // people still type. Placed AFTER `parse_number` so the ordinary cases keep
    // winning: `-5` and `+1,5` are numbers, `-A1` and `+SUM(A1:A9)` are not.
    //
    // ONLY WHEN SOMETHING FOLLOWS THE SIGN. `+` on its own used to reach here,
    // get an `=` prepended, and hand `Cell::new_formula` the unparsable "=+" —
    // whose error arm stores the STRING, so the cell ended up literally showing
    // `=+`, an equals sign the user never typed. Excel refuses a bare sign; the
    // fall-through below stores the one character that was actually typed.
    if (trimmed.starts_with('+') || trimmed.starts_with('-'))
        && !trimmed[1..].trim().is_empty()
    {
        let invariant = engine::delocalize_formula(trimmed, locale);
        return (Cell::new_formula(format!("={}", invariant)), None);
    }
    (Cell::new_text(trimmed.to_string()), None)
}

/// The error a typed entry SPELLS, or `None` if it merely starts with a `#`.
///
/// THE LIST IS THE LEXER'S, not a copy of it. `parser::lexer::ERROR_LITERALS` is
/// what makes `=#N/A` parse inside a formula, and a second table here would
/// drift the moment either side learned a spelling: the typed `#SPILL!` and the
/// evaluated one would then be different cells. `CellError::from_literal` maps
/// the text to the variant — but it CANNOT be the membership test on its own,
/// because its documented contract is to fall back to `Value` for anything it
/// does not recognise, which would turn the perfectly ordinary text
/// `#NOTANERROR` into `#VALUE!`.
///
/// `upper` is the already-uppercased entry, so `#n/a` is the same error as
/// `#N/A` — as it is in Excel, which re-spells what you type.
fn typed_error_literal(upper: &str) -> Option<CellError> {
    if parser::lexer::ERROR_LITERALS.contains(&upper) {
        Some(CellError::from_literal(upper))
    } else {
        None
    }
}

/// A literal error cell: a value with no AST, like a typed number or boolean.
///
/// `Cell` has constructors for number, text, boolean and formula but not for an
/// error, because until this rung existed nothing could type one.
fn error_cell(error: CellError) -> Cell {
    let mut cell = Cell::new();
    cell.value = CellValue::Error(error);
    cell
}

/// What a leading apostrophe implies about the CELL, not just about this entry.
///
/// Excel remembers the apostrophe itself — it exposes it as
/// `Range.PrefixCharacter` and leaves the cell on `General`. Calcula does NOT
/// store a prefix flag, and records the same intent as the Text format instead.
///
/// WHY NOT A STORED FLAG. The one thing the prefix drives here is the "Number
/// Stored as Text" indicator, and `error_checking.rs` derives that from the
/// VALUE (a `CellValue::Text` whose contents parse as a number), never from a
/// prefix — so a stored flag would be a second source of truth for an answer the
/// value already gives, carried on every cell of a 1M-row grid, plus a `.cala`
/// shape change to persist it.
///
/// WHAT THE FORMAT BUYS INSTEAD is the round trip, which is where the prefix
/// character earns its keep in Excel: nothing in a `CellValue::Text("123")` says
/// an apostrophe was ever typed, so the editor re-opens on `123`, and pressing
/// Enter on an OTHERWISE UNTOUCHED cell would store the number 123 and lose the
/// text. With the cell now formatted as Text, rung 3 of the ladder catches that
/// re-entry and the value survives. The price is a deliberate deviation: after
/// `'123`, typing `456` into that same cell stays text here where Excel would
/// make it a number. One is a surprise the user can undo from Format Cells; the
/// other is a leading zero nobody notices is gone.
///
/// ONLY WHEN THE APOSTROPHE CHANGED THE ANSWER. `'hello` implies nothing —
/// `hello` was already text, so formatting the cell would restrict it for no
/// gain. `'123`, `'TRUE`, `'=A1+1` and `'2020-06-01` each would have become
/// something else, and each implies Text.
///
/// `'#N/A` IS NOW IN THE FIRST GROUP, and it moved without a line changing here
/// — which is the point of asking the ladder instead of listing the cases. It
/// used to be in the second group because an unprefixed `#N/A` was already
/// text, so the apostrophe changed nothing; now that the ladder has an error
/// rung the apostrophe is the only thing standing between the string and a real
/// `#N/A` error, so the cell has to remember it or the next Enter over an
/// untouched cell turns the text into the error.
fn apostrophe_implied_format(
    rest: &str,
    locale: &engine::LocaleSettings,
) -> Option<NumberFormat> {
    // THE LADDER ITSELF decides what `rest` would have been. A second copy of
    // "does this look like a number/date/formula" is exactly the kind of
    // duplicate that drifts on the first locale change. It terminates because
    // `rest` is strictly shorter than the input that reached here, so `''x`
    // recurses once and stops.
    let (would_be, _) = parse_cell_input_in_format(rest, locale, None);
    if would_be.has_formula() {
        return Some(NumberFormat::Custom { format: "@".to_string() });
    }
    match would_be.value {
        // `Empty` is the lone apostrophe (`'`), which needs no protection.
        CellValue::Text(_) | CellValue::Empty => None,
        _ => Some(NumberFormat::Custom { format: "@".to_string() }),
    }
}

/// Parse cell input that is already in invariant (US) format.
/// Formulas are stored as-is without delocalization; numbers use '.' as decimal separator.
pub fn parse_cell_input_invariant(input: &str, locale: &engine::LocaleSettings) -> Cell {
    parse_cell_input_invariant_in_format(input, locale, None)
}

/// `parse_cell_input_invariant`, told which number format the entry lands in.
///
/// The apostrophe, the `@` format and the error literals are all DIALECT-FREE —
/// none of them reads a decimal separator — so they are the same three rungs
/// here as in the localized ladder, and a script's only way to write the text
/// "123" (or the text "#N/A") is the same escape a user types.
///
/// It returns no implied format, because this whole spelling reports none: a
/// script that means to write a date says so with a format of its own rather
/// than having one inferred from the string it passed. The consequence for the
/// apostrophe is that a script's `'123` stores text WITHOUT formatting the cell
/// as Text, so it does not get the re-entry round trip an interactive `'123`
/// does.
pub fn parse_cell_input_invariant_in_format(
    input: &str,
    locale: &engine::LocaleSettings,
    target_format: Option<&NumberFormat>,
) -> Cell {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Cell::new();
    }
    // Same reading as the localized ladder: the escape comes off the UNTRIMMED
    // input so a pasted `'  007  ` keeps both ends of its whitespace.
    if let Some(rest) = input.trim_start().strip_prefix('\'') {
        return Cell::new_text(rest.to_string());
    }
    if target_format.is_some_and(is_text_format) {
        return Cell::new_text(trimmed.to_string());
    }
    if trimmed.starts_with('=') {
        // Formula is already in invariant format — store directly
        return Cell::new_formula(trimmed.to_string());
    }
    let upper = trimmed.to_uppercase();
    if upper == "TRUE" {
        return Cell::new_boolean(true);
    }
    if upper == "FALSE" {
        return Cell::new_boolean(false);
    }
    // ERROR LITERALS, on this path too — because this is the path a COPY of an
    // error cell comes back through. The clipboard carries `#N/A` as text, and
    // storing it as text is how a pasted column of errors turned into a column
    // that `ISNA` calls FALSE. A script that means the string says so with the
    // same apostrophe a user types.
    if let Some(error) = typed_error_literal(&upper) {
        return error_cell(error);
    }
    // Try invariant number parsing first (dot decimal), then locale-aware
    if let Ok(n) = trimmed.parse::<f64>() {
        if n.is_finite() {
            return Cell::new_number(n);
        }
    }
    if let Some(num) = parse_number(trimmed, locale) {
        return Cell::new_number(num);
    }
    Cell::new_text(trimmed.to_string())
}

/// The NUMBER rung of the typed-entry ladder.
///
/// ONE GRAMMAR, TWO POLICIES. This is `engine::number_text::parse` — the same
/// parser `EvalResult::as_number` reaches for when text meets an operator —
/// under [`ParsePolicy::ENTRY`], which differs from the coercion policy on
/// exactly two questions (ISO dates and currency signs) for reasons stated on
/// those two enums. It used to be a second, independent implementation, and the
/// three defects that cost were measured before it was replaced:
///
///   * **`"1,5"` in en-US was FIFTEEN.** The old code stripped the group
///     separator and parsed what was left, so a European's one-and-a-half
///     became 15 in a cell with no error on it. Grouping is now VALIDATED
///     (`groups_are_well_formed`), so `"1,23"` and `"1,5"` are text, as they
///     are in Excel.
///   * **`"inf%"` stored a NON-FINITE number.** The old percent branch was the
///     one path that never checked `is_finite`, so `inf/100` went straight into
///     a cell that `ISNUMBER` then called TRUE. `inf` is now structurally
///     unreachable rather than filtered.
///   * **`"1 000"` failed in sv-SE** while `"1\u{00A0}000"` worked — the locale's
///     group separator is a NON-BREAKING space and the keyboard makes an
///     ordinary one, so the separator read off the user's own regional settings
///     rejected the way that user types it.
///
/// The deliberate NARROWING that came with it: in a comma-decimal locale the
/// old code also accepted the ANGLO spelling (`"1.5"` was 1.5 in sv-SE, while
/// `"1,5"` — the spelling that locale actually uses — was reached only by a
/// second branch). Excel refuses the foreign spelling, and so does this now.
/// Scripts and imports are unaffected: they go through
/// `parse_cell_input_invariant*`, which tries the invariant dot FIRST.
fn parse_number(s: &str, locale: &engine::LocaleSettings) -> Option<f64> {
    engine::number_text::parse(
        s,
        engine::number_text::NumberTextLocale::of(locale),
        engine::number_text::ParsePolicy::ENTRY,
    )
}

// ============================================================================
// TYPED DATES AND TIMES
// ============================================================================
// Everything below turns what a user TYPES into an Excel date serial. Three
// rules shape it:
//
// 1. Every conversion goes through `engine::date_serial`. The 1900 leap-year
//    fiction lives there, and a second implementation of the arithmetic would
//    drift from it on the one date that matters most for compatibility.
// 2. A string that is not clearly a date stays TEXT. A wrong date is worse
//    than no date because it LOOKS right: nothing about the cell says the part
//    number "1-2-3" was read as the 2nd of January 2003.
// 3. The locale decides the numeric order, and it is read off
//    `LocaleSettings::date_format` — this build's default locale is sv-SE, so
//    a hard-coded month-first reading would be wrong for the users it ships to.
//
// ACCEPTED: `2020-06-01` (and any four-digit-year-first form), the locale's
// short-date order for `/`, `.` and `-` when a two- or four-digit year is
// present, the locale's own month names ("1 Jun 2020", "1 juni 2020",
// "Jun 1, 2020"), `13:45`, `13:45:30`, `1:45 PM` where the locale has a
// meridiem, and any date and time together (`2020-06-01 13:45`,
// `2020-06-01T13:45:00`).
//
// REFUSED, deliberately: a date with no year ("3/4", "1-2", "12/25" — Excel
// guesses the current year, which silently changes meaning in January); a
// one- or three-digit year ("1-2-3" is a part number far more often than it is
// a date, and typing the year in full is the escape hatch); a non-year-first
// numeric date in a locale whose short date IS year-first (nothing in the
// regional settings says whether "6/1/2020" is June or January there); an
// impossible calendar day ("2020-02-31"); a year before 1900 or after 9999;
// elapsed times past 23:59:59 ("36:00"); and month names from any language but
// the locale's own.

/// The three characters a numeric date may be written with. One entry must use
/// exactly one of them — "2020-06/01" is not a date.
const DATE_SEPARATORS: [char; 3] = ['-', '/', '.'];

/// Which order the locale writes a NUMERIC date in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShortDateOrder {
    Ymd,
    Dmy,
    Mdy,
}

/// Read the locale's numeric date order off `LocaleSettings::date_format`.
///
/// The struct carries no dedicated order field; that pattern ("MM/DD/YYYY",
/// "DD.MM.YYYY", "YYYY-MM-DD") is the only thing in it that says whether
/// `06/01/2020` is June 1st or January 6th.
fn locale_short_date_order(locale: &engine::LocaleSettings) -> ShortDateOrder {
    let pattern = locale.date_format.to_ascii_uppercase();
    match (pattern.find('Y'), pattern.find('M'), pattern.find('D')) {
        (Some(y), Some(m), Some(d)) if y < m && y < d => ShortDateOrder::Ymd,
        (Some(_), Some(m), Some(d)) if d < m => ShortDateOrder::Dmy,
        (Some(_), Some(_), Some(_)) => ShortDateOrder::Mdy,
        // An unreadable pattern is treated as year-first, which is the arm that
        // REFUSES an ambiguous entry instead of guessing at it.
        _ => ShortDateOrder::Ymd,
    }
}

/// Excel's two-digit-year window for TYPED text: 00-29 is 2000-2029, 30-99 is
/// 1930-1999.
///
/// THE ENGINE DOES NOT OWN THIS RULE — `date_serial.rs` has no year window at
/// all, and the two-digit rule the engine does implement is a DIFFERENT one:
/// `fn_date` in `evaluator.rs` adds 1900 to a small YEAR ARGUMENT, because that
/// is what Excel's `DATE(99,1,1)` does. Expressing typed dates in terms of that
/// rule would date every `.../20` entry to 1920.
fn expand_two_digit_year(yy: i32) -> i32 {
    if yy <= 29 {
        2000 + yy
    } else {
        1900 + yy
    }
}

/// A month, day, hour, minute or second component: one or two ASCII digits.
fn parse_two_digit_component(text: &str) -> Option<u32> {
    if text.is_empty() || text.len() > 2 || !text.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    text.parse::<u32>().ok()
}

/// A year component: four digits as written, two digits through Excel's window.
/// One and three digits are refused — see the REFUSED list above.
fn parse_year_component(text: &str) -> Option<i32> {
    if !text.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    match text.len() {
        4 => text.parse::<i32>().ok(),
        2 => text.parse::<i32>().ok().map(expand_two_digit_year),
        _ => None,
    }
}

/// Is this a date Excel can hold, on a calendar that exists?
///
/// `date_to_serial` validates NOTHING: it normalizes month overflow and adds
/// the day straight in, so `2020-02-31` returns the serial for March 2nd — a
/// SILENTLY WRONG date, not an error. The calendar check has to happen here,
/// before the conversion.
fn valid_ymd(year: i32, month: u32, day: u32) -> bool {
    if !(1900..=9999).contains(&year) || !(1..=12).contains(&month) || day < 1 {
        return false;
    }
    // Excel's phantom 1900-02-29 (serial 60) is a real date to Excel and to
    // `date_to_serial`, which uses the Lotus leap rule; `days_in_month` gives
    // the honest Gregorian 28. This is the one date where they disagree, and
    // Excel accepts it, so it is spelled out rather than rejected.
    if year == 1900 && month == 2 && day == 29 {
        return true;
    }
    day <= engine::date_serial::days_in_month(year, month)
}

/// Split a typed entry into its date part and its time part.
///
/// The split point is the separator immediately before the first ':' — the
/// space of "2020-06-01 13:45" or the 'T' of "2020-06-01T13:45:00". An entry
/// with no ':' is all date; a ':' with nothing usable before it is all time.
/// 'T' only splits when a DIGIT precedes it, so the 't' inside a month name
/// (and inside "Meeting: 5") never cuts an entry in half.
fn split_date_and_time(text: &str) -> (Option<&str>, Option<&str>) {
    let colon = match text.find(':') {
        Some(i) => i,
        None => return (Some(text), None),
    };
    let head = &text[..colon];
    let boundary = head.char_indices().rev().find(|&(i, c)| {
        c.is_whitespace()
            || ((c == 'T' || c == 't')
                && head[..i]
                    .chars()
                    .next_back()
                    .is_some_and(|prev| prev.is_ascii_digit()))
    });
    match boundary {
        Some((i, c)) => {
            let date = text[..i].trim();
            let time = text[i + c.len_utf8()..].trim();
            if date.is_empty() {
                (None, Some(time))
            } else {
                (Some(date), Some(time))
            }
        }
        None => (None, Some(text)),
    }
}

/// Parse a numeric date ("2020-06-01", "01.06.2020", "6/1/20").
fn parse_numeric_date(text: &str, locale: &engine::LocaleSettings) -> Option<(i32, u32, u32)> {
    let separator = text.chars().find(|c| DATE_SEPARATORS.contains(c))?;
    if text
        .chars()
        .any(|c| DATE_SEPARATORS.contains(&c) && c != separator)
    {
        return None;
    }
    let parts: Vec<&str> = text.split(separator).collect();
    // THREE components or nothing. "3/4" is a fraction, a score, a part number
    // or March 4th depending on who typed it, and Excel's answer (the current
    // year) changes meaning every New Year's Day.
    if parts.len() != 3 {
        return None;
    }
    if parts
        .iter()
        .any(|p| p.is_empty() || !p.chars().all(|c| c.is_ascii_digit()))
    {
        return None;
    }
    // A four-digit LEADING component is a year in every locale: no short-date
    // pattern anywhere starts with a four-digit day or month.
    let (year_text, month_text, day_text) = if parts[0].len() == 4 {
        (parts[0], parts[1], parts[2])
    } else {
        match locale_short_date_order(locale) {
            ShortDateOrder::Mdy => (parts[2], parts[0], parts[1]),
            ShortDateOrder::Dmy => (parts[2], parts[1], parts[0]),
            // The locale's short date is year-first (sv-SE "YYYY-MM-DD") and
            // this entry is not, so the regional settings say nothing about
            // whether "6/1/2020" is June 1st or January 6th. Refuse.
            ShortDateOrder::Ymd => return None,
        }
    };
    let year = parse_year_component(year_text)?;
    let month = parse_two_digit_component(month_text)?;
    let day = parse_two_digit_component(day_text)?;
    if !valid_ymd(year, month, day) {
        return None;
    }
    Some((year, month, day))
}

/// Match a token against the LOCALE's month names — the same table the
/// custom-format engine renders `mmm`/`mmmm` from. A trailing '.' is ignored on
/// both sides, because several locales abbreviate as "jan." and the tokenizer
/// has already split that dot off.
fn month_index(calendar: &engine::CalendarNames, token: &str) -> Option<u32> {
    let needle = token.trim_end_matches('.').to_lowercase();
    if needle.is_empty() {
        return None;
    }
    for m in 0..12usize {
        for name in [calendar.months_full[m], calendar.months_short[m]] {
            let name = name.trim_end_matches('.');
            // Length prefilter before the case fold: this runs on every
            // three-token text cell of a paste, and 24 `to_lowercase`
            // allocations per token would be paid for by every "Total sales
            // 2020" in the clipboard.
            if name.len() == needle.len() && name.to_lowercase() == needle {
                return Some(m as u32 + 1);
            }
        }
    }
    None
}

/// Parse a date written with a month NAME ("1 Jun 2020", "Jun 1, 2020",
/// "1. juni 2020"). The name makes the order unambiguous, so both arrangements
/// are safe — but only in the locale's own language, since accepting every
/// language's names would make one locale's month collide with another's word.
fn parse_month_name_date(text: &str, locale: &engine::LocaleSettings) -> Option<(i32, u32, u32)> {
    let calendar = locale.calendar();
    let tokens: Vec<&str> = text
        .split(|c: char| c.is_whitespace() || c == ',' || c == '.' || c == '-' || c == '/')
        .filter(|t| !t.is_empty())
        .collect();
    if tokens.len() != 3 {
        return None;
    }
    let month_at = tokens
        .iter()
        .position(|t| month_index(calendar, t).is_some())?;
    let month = month_index(calendar, tokens[month_at])?;
    let (day_text, year_text) = match month_at {
        0 => (tokens[1], tokens[2]), // "Jun 1, 2020"
        1 => (tokens[0], tokens[2]), // "1 Jun 2020"
        _ => return None,            // nobody writes "1 2020 Jun"
    };
    let day = parse_two_digit_component(day_text)?;
    let year = parse_year_component(year_text)?;
    if !valid_ymd(year, month, day) {
        return None;
    }
    Some((year, month, day))
}

fn parse_date_part(text: &str, locale: &engine::LocaleSettings) -> Option<(i32, u32, u32)> {
    parse_numeric_date(text, locale).or_else(|| parse_month_name_date(text, locale))
}

/// Parse a clock time into a fraction of a day, and report whether SECONDS were
/// typed — the caller picks the short or the long time pattern from that.
fn parse_clock_time(text: &str, locale: &engine::LocaleSettings) -> Option<(f64, bool)> {
    let upper = text.to_ascii_uppercase();
    // AM/PM only where the locale HAS a meridiem: sv-SE's time pattern is
    // "hh:mm:ss" with no designator, so "1:45 PM" is not a Swedish time.
    let locale_has_meridiem = locale.time_format.to_ascii_uppercase().contains("AM/PM");
    let (body, pm) = if let Some(rest) = upper.trim().strip_suffix("PM") {
        (rest.trim_end(), Some(true))
    } else if let Some(rest) = upper.trim().strip_suffix("AM") {
        (rest.trim_end(), Some(false))
    } else {
        (upper.trim(), None)
    };
    if pm.is_some() && !locale_has_meridiem {
        return None;
    }
    let parts: Vec<&str> = body.split(':').collect();
    // A bare "13" is the NUMBER 13 and never reaches here, so a time needs at
    // least hours and minutes.
    if parts.len() < 2 || parts.len() > 3 {
        return None;
    }
    let hour_typed = parse_two_digit_component(parts[0])?;
    let minute = parse_two_digit_component(parts[1])?;
    let second = match parts.get(2) {
        Some(s) => parse_two_digit_component(s)?,
        None => 0,
    };
    if minute > 59 || second > 59 {
        return None;
    }
    let hour = match pm {
        // 12-hour clock: 12 AM is midnight, 12 PM is noon.
        Some(true) => match hour_typed {
            12 => 12,
            1..=11 => hour_typed + 12,
            _ => return None,
        },
        Some(false) => match hour_typed {
            12 => 0,
            1..=11 => hour_typed,
            _ => return None,
        },
        // 24-hour clock. Excel would also take "36:00" as an ELAPSED time and
        // format it `[h]:mm`; that is a third format decision, so hours past 23
        // stay text here.
        None => {
            if hour_typed > 23 {
                return None;
            }
            hour_typed
        }
    };
    let seconds_of_day = hour as f64 * 3600.0 + minute as f64 * 60.0 + second as f64;
    Some((seconds_of_day / 86400.0, parts.len() == 3))
}

/// The time pattern a typed time implies. Excel shows what you typed: no
/// seconds typed, no seconds displayed — so the locale's long time pattern
/// (which always carries `ss`, see `LocaleSettings::time_format`) loses its
/// seconds field for a "13:45".
fn implied_time_pattern(locale: &engine::LocaleSettings, had_seconds: bool) -> String {
    if had_seconds {
        return locale.time_format.clone();
    }
    let lowered = locale.time_format.to_ascii_lowercase();
    match lowered.find(":ss") {
        Some(pos) => {
            let mut short = locale.time_format.clone();
            short.replace_range(pos..pos + 3, "");
            short
        }
        None => locale.time_format.clone(),
    }
}

/// The format a typed percentage implies: "50%" is `0%`, "12.5%" is `0.0%`.
/// Returns `None` for anything that is not a percentage, which is what makes it
/// safe to call on every number the parser accepts.
fn implied_percentage_format(text: &str, locale: &engine::LocaleSettings) -> Option<NumberFormat> {
    let trimmed = text.trim();
    // EITHER END. The shared number parser reads a percent sign on either side
    // (`"%5"` is 0.05, as in Excel), and a rung that only recognised the
    // trailing one would store 0.05 under `General` and DISPLAY "0.05" — the
    // percent the user typed silently gone from a cell that is nonetheless a
    // percentage. Recognising only what the parser accepts is what keeps the
    // value and its format one decision.
    let body = match trimmed.strip_suffix('%') {
        Some(body) => body.trim_end(),
        None => trimmed.strip_prefix('%')?.trim_start(),
    };
    let decimals = match body.rsplit_once(locale.decimal_separator) {
        Some((_, fraction)) => fraction.chars().filter(|c| c.is_ascii_digit()).count(),
        None => 0,
    };
    Some(NumberFormat::Percentage {
        // Excel's own ceiling for decimal places in a format.
        decimal_places: decimals.min(30) as u8,
    })
}

/// Recognise a typed date, time, or date and time, and return the Excel serial
/// together with the number format the entry implies.
fn parse_date_time_input(
    text: &str,
    locale: &engine::LocaleSettings,
) -> Option<(f64, NumberFormat)> {
    let (date_text, time_text) = split_date_and_time(text);
    let date = match date_text {
        Some(d) => Some(parse_date_part(d, locale)?),
        None => None,
    };
    let time = match time_text {
        Some(t) => Some(parse_clock_time(t, locale)?),
        None => None,
    };
    match (date, time) {
        (Some((y, m, d)), None) => Some((
            engine::date_serial::date_to_serial(y, m as i32, d as i32),
            NumberFormat::Date {
                format: locale.date_format.clone(),
            },
        )),
        (None, Some((fraction, had_seconds))) => Some((
            fraction,
            NumberFormat::Time {
                format: implied_time_pattern(locale, had_seconds),
            },
        )),
        (Some((y, m, d)), Some((fraction, had_seconds))) => Some((
            engine::date_serial::date_to_serial(y, m as i32, d as i32) + fraction,
            // A combined value is a DATE format that carries time tokens, the
            // way Excel's own "m/d/yyyy h:mm" is. The custom-format engine
            // resolves the m/mm ambiguity by adjacency, so the `MM` after the
            // year stays a month and the one after `hh` becomes minutes.
            NumberFormat::Date {
                format: format!(
                    "{} {}",
                    locale.date_format,
                    implied_time_pattern(locale, had_seconds)
                ),
            },
        )),
        (None, None) => None,
    }
}

// ============================================================================
// DEPENDENCY TRACKING
// ============================================================================

pub fn update_dependencies(
    cell_pos: (u32, u32),
    new_refs: CoordSet,
    dependencies: &mut DependencyMap,
    dependents: &mut DependencyMap,
) {
    let old_refs = dependencies.remove(&cell_pos).unwrap_or_default();

    for old_ref in &old_refs {
        if let Some(deps) = dependents.get_mut(old_ref) {
            deps.remove(&cell_pos);
            if deps.is_empty() {
                dependents.remove(old_ref);
            }
        }
    }
    for new_ref in &new_refs {
        dependents
            .entry(*new_ref)
            .or_default()
            .insert(cell_pos);
    }
    if !new_refs.is_empty() {
        dependencies.insert(cell_pos, new_refs);
    }
}

pub fn update_column_dependencies(
    cell_pos: (u32, u32),
    new_cols: FxHashSet<u32>,
    column_dependencies: &mut StripeDependenciesMap,
    column_dependents: &mut StripeDependentsMap,
) {
    let old_cols = column_dependencies.remove(&cell_pos).unwrap_or_default();

    for old_col in &old_cols {
        if let Some(deps) = column_dependents.get_mut(old_col) {
            deps.remove(&cell_pos);
            if deps.is_empty() {
                column_dependents.remove(old_col);
            }
        }
    }

    for new_col in &new_cols {
        column_dependents
            .entry(*new_col)
            .or_default()
            .insert(cell_pos);
    }

    if !new_cols.is_empty() {
        column_dependencies.insert(cell_pos, new_cols);
    }
}

pub fn update_row_dependencies(
    cell_pos: (u32, u32),
    new_rows: FxHashSet<u32>,
    row_dependencies: &mut StripeDependenciesMap,
    row_dependents: &mut StripeDependentsMap,
) {
    let old_rows = row_dependencies.remove(&cell_pos).unwrap_or_default();

    for old_row in &old_rows {
        if let Some(deps) = row_dependents.get_mut(old_row) {
            deps.remove(&cell_pos);
            if deps.is_empty() {
                row_dependents.remove(old_row);
            }
        }
    }

    for new_row in &new_rows {
        row_dependents
            .entry(*new_row)
            .or_default()
            .insert(cell_pos);
    }

    if !new_rows.is_empty() {
        row_dependencies.insert(cell_pos, new_rows);
    }
}

/// Canonicalise the sheet names in a set of parsed cross-sheet references.
///
/// `CrossSheetDependentsMap` is keyed by sheet NAME, and the cascade
/// (`cascade_cross_sheet_dependents`) looks a cell up under the workbook's
/// OFFICIAL name — `sheet_names[index]`. The AST, by contrast, NEVER holds that
/// spelling for an unquoted reference: the lexer uppercases every bare
/// identifier (`parser/src/lexer.rs`), so `=Sheet1!A2` is stored as `SHEET1!A2`
/// and keys as `("SHEET1", ..)` while the cascade asks for `("Sheet1", ..)`.
/// An un-canonicalised key is therefore not an edge case, it is a dependent
/// that will never be found — and registering references straight from the AST
/// on a sheet switch silently stopped ALL cross-sheet recalculation for the rest
/// of the session (proved live 2026-08-07 — see the sheet-revisit test in
/// commands/cross_sheet_recalc_tests.rs). Quoted references (`='Sheet1'!A2`)
/// lex as `QuotedIdentifier` and keep their case, which is why the failure
/// looked arbitrary from the outside.
///
/// A name with no match in `sheet_names` is passed through unchanged, so a
/// reference to a sheet that does not exist stays exactly as written rather
/// than being silently retargeted.
///
/// THIS IS THE ONE COPY. Every site that registers cross-sheet dependencies
/// must call it — `update_cell`, the batch/paste path, fill, the structural
/// reference shift, and the dependency rebuild. There used to be four
/// hand-copied inline versions and one place that simply forgot.
pub fn normalize_cross_sheet_refs(
    parsed_refs: &FxHashSet<(String, u32, u32)>,
    sheet_names: &[String],
) -> FxHashSet<(String, u32, u32)> {
    parsed_refs
        .iter()
        .map(|(parsed_sheet_name, r, c)| {
            let canonical = sheet_names
                .iter()
                .find(|name| name.eq_ignore_ascii_case(parsed_sheet_name))
                .cloned()
                .unwrap_or_else(|| parsed_sheet_name.clone());
            (canonical, *r, *c)
        })
        .collect()
}

pub fn update_cross_sheet_dependencies(
    formula_cell: (usize, u32, u32),
    new_refs: FxHashSet<(String, u32, u32)>,
    cross_sheet_dependencies: &mut CrossSheetDependenciesMap,
    cross_sheet_dependents: &mut CrossSheetDependentsMap,
) {
    let old_refs = cross_sheet_dependencies.remove(&formula_cell).unwrap_or_default();

    for old_ref in &old_refs {
        if let Some(deps) = cross_sheet_dependents.get_mut(old_ref) {
            deps.remove(&formula_cell);
            if deps.is_empty() {
                cross_sheet_dependents.remove(old_ref);
            }
        }
    }

    for new_ref in &new_refs {
        cross_sheet_dependents
            .entry(new_ref.clone())
            .or_default()
            .insert(formula_cell);
    }

    if !new_refs.is_empty() {
        cross_sheet_dependencies.insert(formula_cell, new_refs);
    }
}

/// Topological recalc order for a single edited cell: all transitive
/// dependents, precedents before dependents. The changed cell itself is NOT
/// included (it was just evaluated) unless a dependency cycle leads back to it.
pub fn get_recalculation_order(
    changed_cell: (u32, u32),
    dependents: &DependencyMap,
) -> Vec<(u32, u32)> {
    recalc_order_from_seeds(&[changed_cell], dependents, false)
}

/// Multi-root topological recalc ordering over the dependents graph (Kahn's
/// algorithm on the induced subgraph). Shared by the single-cell edit cascade,
/// batch edits (paste/fill) and the control-value recalc.
///
/// `include_seeds`:
/// - `true`  — the seeds are members of the ordering (batch edits: formula
///   cells written by the batch are re-evaluated AFTER the batch cells they
///   read, fixing in-batch stale values; a seed fed by another member is
///   ordered after its precedents).
/// - `false` — the seeds are expansion roots only (single-cell edit: the
///   edited cell was already evaluated); a seed still appears in the result
///   if a dependency cycle reaches back to it.
///
/// Ordering is deterministic: zero-degree seeds first (call order), then
/// remaining zero-degree members sorted by coordinate; cycle members are
/// appended sorted at the end so they are still recalculated once.
pub fn recalc_order_from_seeds(
    seeds: &[(u32, u32)],
    dependents: &DependencyMap,
    include_seeds: bool,
) -> Vec<(u32, u32)> {
    // Member set: everything reachable from the seeds via dependent edges
    // (plus the seeds themselves when include_seeds).
    let mut members = CoordSet::default();
    let mut queue: std::collections::VecDeque<(u32, u32)> = std::collections::VecDeque::new();
    if include_seeds {
        for &seed in seeds {
            if members.insert(seed) {
                queue.push_back(seed);
            }
        }
    } else {
        queue.extend(seeds.iter().copied());
    }
    while let Some(cell) = queue.pop_front() {
        if let Some(deps) = dependents.get(&cell) {
            for &dep in deps {
                if members.insert(dep) {
                    queue.push_back(dep);
                }
            }
        }
    }

    if members.is_empty() {
        return Vec::new();
    }

    // In-degree over the induced subgraph: only member -> member edges impose
    // ordering. Edges from non-member seeds are deliberately NOT counted —
    // those sources are already up to date when the cascade runs. (Counting
    // them would leave every member with in-degree >= 1 and an empty Kahn
    // seed queue — the bug this rewrite fixes.)
    let mut in_degree: FxHashMap<(u32, u32), u32> =
        members.iter().map(|c| (*c, 0)).collect();
    for cell in &members {
        if let Some(deps) = dependents.get(cell) {
            for dep in deps {
                if dep == cell {
                    continue; // self-loop: handled by the cycle fallback
                }
                if let Some(deg) = in_degree.get_mut(dep) {
                    *deg += 1;
                }
            }
        }
    }

    // Kahn's algorithm. Deterministic start order: seeds first (call order),
    // then remaining zero-degree members sorted by coordinate.
    let mut queued = CoordSet::default();
    let mut ready: std::collections::VecDeque<(u32, u32)> = std::collections::VecDeque::new();
    for &seed in seeds {
        if in_degree.get(&seed) == Some(&0) && queued.insert(seed) {
            ready.push_back(seed);
        }
    }
    let mut rest: Vec<(u32, u32)> = members
        .iter()
        .copied()
        .filter(|c| in_degree[c] == 0 && !queued.contains(c))
        .collect();
    rest.sort_unstable();
    for c in rest {
        queued.insert(c);
        ready.push_back(c);
    }

    let mut result = Vec::with_capacity(members.len());
    while let Some(cell) = ready.pop_front() {
        result.push(cell);
        if let Some(deps) = dependents.get(&cell) {
            for dep in deps {
                if let Some(deg) = in_degree.get_mut(dep) {
                    if *deg > 0 {
                        *deg -= 1;
                        if *deg == 0 && queued.insert(*dep) {
                            ready.push_back(*dep);
                        }
                    }
                }
            }
        }
    }

    // Members not emitted are on dependency cycles: append them (sorted, so
    // the order is deterministic) so they still get recalculated once.
    // O(n) via the emitted-set — never Vec::contains per cell.
    if result.len() < members.len() {
        let done: CoordSet = result.iter().copied().collect();
        let mut leftovers: Vec<(u32, u32)> = members
            .iter()
            .copied()
            .filter(|c| !done.contains(c))
            .collect();
        leftovers.sort_unstable();
        result.extend(leftovers);
    }

    result
}

pub fn get_column_row_dependents(
    changed_cell: (u32, u32),
    column_dependents: &StripeDependentsMap,
    row_dependents: &StripeDependentsMap,
) -> CoordSet {
    let (row, col) = changed_cell;
    let mut result = CoordSet::default();
    
    if let Some(col_deps) = column_dependents.get(&col) {
        for dep in col_deps {
            if *dep != changed_cell {
                result.insert(*dep);
            }
        }
    }
    
    if let Some(row_deps) = row_dependents.get(&row) {
        for dep in row_deps {
            if *dep != changed_cell {
                result.insert(*dep);
            }
        }
    }
    
    result
}

// ============================================================================
// Third-Party Extension Loading
// ============================================================================

/// Extension file entry returned by scan_extension_directory.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionFileEntry {
    /// File name (e.g., "my-extension.js")
    pub file_name: String,
    /// Full absolute path
    pub path: String,
    /// File content (the JavaScript source)
    pub content: String,
    /// Raw JSON of the sidecar manifest (`<base>.manifest.json`), if present.
    /// Lets the host read workerSupport + the declared-capability ceiling WITHOUT
    /// importing/executing the bundle (Wave 3 / S8-C7 follow-up).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest_json: Option<String>,
    /// Ed25519 signature trust over the sidecar manifest (mirrors .calp / S5).
    /// The SCAN vocabulary is `extension_install::EXTENSION_TRUST_STATUSES`
    /// minus `firstUse` (an installer-only promise): "unsigned" | "invalid" |
    /// "codeUnverified" | "trustUnavailable" | "publisherChanged" |
    /// "notInstalled" | "verified". The host grants the manifest's declared
    /// ceiling ONLY for statuses in `trust_grants_capabilities`.
    pub trust_status: String,
}

/// Read + verify an extension's sidecar manifest (`<base>.manifest.json` +
/// detached `<base>.manifest.sig`). Reuses the .calp Ed25519 signing + TOFU
/// store (keyed `ext:<id>`). Returns (raw manifest JSON, trust_status).
fn verify_extension_manifest(
    manifest_path: &std::path::Path,
    sig_path: &std::path::Path,
    profile_dir: &std::path::Path,
) -> (Option<String>, String) {
    let manifest_bytes = match std::fs::read(manifest_path) {
        Ok(b) => b,
        Err(_) => return (None, "unsigned".to_string()), // no sidecar manifest
    };
    let manifest_json = String::from_utf8_lossy(&manifest_bytes).to_string();

    let parsed: serde_json::Value = match serde_json::from_slice(&manifest_bytes) {
        Ok(v) => v,
        Err(_) => return (Some(manifest_json), "invalid".to_string()),
    };
    let id = parsed.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let version = parsed.get("version").and_then(|v| v.as_str()).unwrap_or("0.0.0").to_string();
    let publisher_key = parsed.get("publisherKey").and_then(|v| v.as_str()).unwrap_or("").to_string();

    let sig_hex = std::fs::read_to_string(sig_path)
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    // ONE decision, shared with the installer
    // (extension_install::decide_extension_trust, reached here through its
    // scan-side wrapper): signature over the RAW on-disk manifest bytes, then the
    // publisher pin, then what the signature actually COVERS.
    //
    // The code-hash half is re-checked on EVERY scan, not just at install: the
    // threat is a program file swapped under an add-in the user already trusted,
    // and an install-time-only check would never see that. A mismatch is not a
    // weaker kind of signed — the claim about the code is broken — and a signed
    // manifest with no codeHash at all is not "signed" in any sense that covers
    // what will execute. Both land outside `verified`/`firstUse`, which is what
    // zeroes the capability ceiling frontend-side, taking formula.udf with it.
    let bundle = calp::signing::extension_layout_for_manifest(manifest_path).map(|l| l.bundle);
    // THE SCAN VERIFIES A PIN. IT NEVER CREATES ONE.
    //
    // This function used to answer `firstUse` for a publisher this machine had
    // never seen and then SILENTLY PIN the key — trust-on-first-use with nobody
    // present to be the "first use". It granted nothing directly (the capability
    // ceiling is a separate frontend gate, and consent for distributed scripts is
    // separate again), but it handed an attacker a free primitive: drop a bundle
    // into %APPDATA%/…/extensions signed with your own key under someone else's
    // add-in id, and you own the pin for that id. The real publisher's next
    // release then reads `publisherChanged`, and the honest author is the one
    // wearing the warning badge.
    //
    // Now that `install_extension` exists, pinning belongs there — behind a
    // dialog that shows the key, the capabilities and the contributions BEFORE
    // anything is trusted. Here, first contact is reported as what it is
    // (`notInstalled`: present on disk, never installed through Calcula, no
    // record of anyone agreeing to this key) and lands outside
    // `trust_grants_capabilities`, so the add-in loads with an EMPTY ceiling
    // until the user installs it properly.
    let (status, _pinned) = crate::extension_install::decide_extension_trust_for_scan(
        profile_dir,
        &id,
        &version,
        &publisher_key,
        &manifest_bytes,
        &parsed,
        &sig_hex,
        bundle.as_deref(),
    );
    (Some(manifest_json), status)
}

#[cfg(test)]
mod ext_manifest_tests {
    use super::*;

    fn write(dir: &std::path::Path, name: &str, content: &str) -> std::path::PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, content).unwrap();
        p
    }

    /// Write `<stem>.js` and return the manifest fields that make a signature
    /// COVER it: `codeHash`, as calcula-sign stamps before signing.
    ///
    /// These fixtures used to have no bundle at all, so every one of them
    /// exercised the `notDeclared` path — which is exactly the path the
    /// adversarial pass closed. Without a real bundle they would now all report
    /// `codeUnverified` and prove nothing about the states they are named for.
    fn bundle_with_hash(dir: &std::path::Path, stem: &str, code: &str) -> String {
        let path = dir.join(format!("{}.js", stem));
        std::fs::write(&path, code).unwrap();
        format!(
            r#","codeHash":"{}""#,
            calp::signing::extension_code_hash(&path).unwrap()
        )
    }

    #[test]
    fn unsigned_when_no_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let (json, status) = verify_extension_manifest(
            &dir.path().join("x.manifest.json"),
            &dir.path().join("x.manifest.sig"),
            dir.path(),
        );
        assert!(json.is_none());
        assert_eq!(status, "unsigned");
    }

    #[test]
    fn unsigned_when_manifest_but_no_sig() {
        let dir = tempfile::tempdir().unwrap();
        let mp = write(
            dir.path(),
            "x.manifest.json",
            r#"{"id":"e.x","version":"1.0.0","publisherKey":"abcd"}"#,
        );
        let (json, status) =
            verify_extension_manifest(&mp, &dir.path().join("x.manifest.sig"), dir.path());
        assert!(json.is_some());
        assert_eq!(status, "unsigned"); // has key but no signature file
    }

    /// Pin a publisher key the way `install_extension` does, so a scan test can
    /// set up "the user already installed this" without re-implementing the
    /// installer. The scan itself no longer pins anything.
    fn pin(profile: &std::path::Path, id: &str, key: &str) {
        calp::signing::pin_publisher(profile, &calp::signing::PinKey::extension(id), "", key)
            .unwrap();
    }

    /// The pinned key for an extension id, or None. Extension pins are
    /// machine-global BY DECISION (`PinKey::extension` carries no registry
    /// scope) — see the reasoning on `extension_install::publisher_trust`.
    fn ext_pin(profile: &std::path::Path, id: &str) -> Option<String> {
        calp::signing::load_pins(profile)
            .unwrap()
            .get(&calp::signing::PinKey::extension(id))
            .map(|r| r.publisher_key.clone())
    }

    /// The scan VERIFIES a pin; it never CREATES one.
    ///
    /// Before this wave the first scan of an unknown publisher answered
    /// `firstUse` and silently pinned, so scanning the same bundle twice walked
    /// firstUse -> verified with nobody ever having been asked. Now first
    /// contact is `notInstalled` and stays `notInstalled` no matter how many
    /// times the app launches: a file that was copied into the extensions
    /// folder cannot promote itself.
    #[test]
    fn a_scan_never_pins_and_first_contact_stays_untrusted() {
        let dir = tempfile::tempdir().unwrap();
        let profile = tempfile::tempdir().unwrap();
        let kp = calp::signing::PublisherKeypair::load_or_create(profile.path()).unwrap();
        let code_hash = bundle_with_hash(dir.path(), "s", "export default {};\n");
        let manifest = format!(
            r#"{{"id":"e.signed","version":"1.0.0","workerSupport":true,"capabilities":["storage"],"publisherKey":"{}"{}}}"#,
            kp.public_key_hex(),
            code_hash
        );
        let mp = write(dir.path(), "s.manifest.json", &manifest);
        let sig = kp.sign(&std::fs::read(&mp).unwrap());
        let sp = write(dir.path(), "s.manifest.sig", &sig);

        // Scan after scan after scan: still not installed, still not pinned.
        for _ in 0..3 {
            assert_eq!(
                verify_extension_manifest(&mp, &sp, profile.path()).1,
                crate::extension_install::TRUST_NOT_INSTALLED,
            );
        }
        assert!(
            ext_pin(profile.path(), "e.signed").is_none(),
            "the scan must never create a pin — that is the installer's job"
        );
        // ...and the ceiling stays empty, so a hand-copied add-in gets no
        // capabilities (no formula.udf, no storage, no network) until installed.
        assert!(!crate::extension_install::trust_grants_capabilities(
            crate::extension_install::TRUST_NOT_INSTALLED
        ));
    }

    #[test]
    fn signed_and_pinned_is_verified_then_tamper_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let profile = tempfile::tempdir().unwrap();
        let kp = calp::signing::PublisherKeypair::load_or_create(profile.path()).unwrap();
        let code_hash = bundle_with_hash(dir.path(), "s", "export default {};\n");
        let manifest = format!(
            r#"{{"id":"e.signed","version":"1.0.0","workerSupport":true,"capabilities":["storage"],"publisherKey":"{}"{}}}"#,
            kp.public_key_hex(),
            code_hash
        );
        let mp = write(dir.path(), "s.manifest.json", &manifest);
        let sig = kp.sign(&std::fs::read(&mp).unwrap());
        let sp = write(dir.path(), "s.manifest.sig", &sig);

        // The user installed it, so the key is pinned.
        pin(profile.path(), "e.signed", &kp.public_key_hex());
        assert_eq!(verify_extension_manifest(&mp, &sp, profile.path()).1, "verified");

        // Swapping the PROGRAM FILE under an already-trusted add-in — the threat
        // an install-time-only check never sees — breaks the signed codeHash.
        std::fs::write(dir.path().join("s.js"), "/* evil */").unwrap();
        assert_eq!(verify_extension_manifest(&mp, &sp, profile.path()).1, "invalid");
        std::fs::write(dir.path().join("s.js"), "export default {};\n").unwrap();
        assert_eq!(verify_extension_manifest(&mp, &sp, profile.path()).1, "verified");

        // Tampering the manifest invalidates the detached signature.
        write(dir.path(), "s.manifest.json", &manifest.replace("storage", "net.fetch"));
        assert_eq!(verify_extension_manifest(&mp, &sp, profile.path()).1, "invalid");
    }

    #[test]
    fn publisher_changed_when_key_differs_from_pin() {
        let dir = tempfile::tempdir().unwrap();
        let profile = tempfile::tempdir().unwrap();
        let kp_a = calp::signing::PublisherKeypair::load_or_create(profile.path()).unwrap();
        let code_hash = bundle_with_hash(dir.path(), "p", "export default {};\n");
        let m_a = format!(
            r#"{{"id":"e.pc","version":"1.0.0","publisherKey":"{}"{}}}"#,
            kp_a.public_key_hex(),
            code_hash
        );
        let mp = write(dir.path(), "p.manifest.json", &m_a);
        let sp = write(dir.path(), "p.manifest.sig", &kp_a.sign(&std::fs::read(&mp).unwrap()));
        // Publisher A's release was INSTALLED (the only thing that pins).
        pin(profile.path(), "e.pc", &kp_a.public_key_hex());
        assert_eq!(verify_extension_manifest(&mp, &sp, profile.path()).1, "verified");

        // A DIFFERENT publisher re-signs the same id with their own key.
        let profile_b = tempfile::tempdir().unwrap();
        let kp_b = calp::signing::PublisherKeypair::load_or_create(profile_b.path()).unwrap();
        let m_b = format!(
            r#"{{"id":"e.pc","version":"1.0.0","publisherKey":"{}"{}}}"#,
            kp_b.public_key_hex(),
            code_hash
        );
        write(dir.path(), "p.manifest.json", &m_b);
        write(dir.path(), "p.manifest.sig", &kp_b.sign(&std::fs::read(&mp).unwrap()));
        // The profile still has publisher A pinned for ext:e.pc.
        assert_eq!(verify_extension_manifest(&mp, &sp, profile.path()).1, "publisherChanged");
    }

    /// THE SQUAT THIS CLOSES, end to end.
    ///
    /// An attacker who can write `%APPDATA%/…/extensions` drops a bundle signed
    /// with THEIR key under an id they do not own. Under scan-time TOFU the next
    /// launch pinned that key for the id, and the genuine publisher's later
    /// release then read `publisherChanged` — the real author wearing the
    /// warning badge, the attacker wearing "Signed". Now the dropped bundle
    /// stays `notInstalled` forever and the real publisher's install is a clean
    /// first contact.
    #[test]
    fn a_dropped_bundle_cannot_squat_the_pin_for_an_id_it_does_not_own() {
        let ext = tempfile::tempdir().unwrap();
        let user_profile = tempfile::tempdir().unwrap();

        // The ATTACKER's key, generated in their own profile.
        let attacker_profile = tempfile::tempdir().unwrap();
        let attacker = calp::signing::PublisherKeypair::load_or_create(attacker_profile.path()).unwrap();
        let code_hash = bundle_with_hash(ext.path(), "acme-tax", "export default {};\n");
        let m = format!(
            r#"{{"id":"acme.tax-tools","version":"9.9.9","workerSupport":true,"capabilities":["formula.udf"],"publisherKey":"{}"{}}}"#,
            attacker.public_key_hex(),
            code_hash
        );
        let mp = write(ext.path(), "acme-tax.manifest.json", &m);
        let sp = write(
            ext.path(),
            "acme-tax.manifest.sig",
            &attacker.sign(&std::fs::read(&mp).unwrap()),
        );

        // Every launch from now on.
        for _ in 0..5 {
            let (_, status) = verify_extension_manifest(&mp, &sp, user_profile.path());
            assert_eq!(
                status,
                crate::extension_install::TRUST_NOT_INSTALLED,
                "a dropped bundle must never become trusted by being scanned"
            );
        }
        assert!(
            calp::signing::load_pins(user_profile.path()).unwrap().is_empty(),
            "the attacker's key must not be pinned for acme.tax-tools"
        );

        // The GENUINE publisher later ships the same id. It is first contact,
        // not a publisher change, so the real author is not the one flagged.
        let acme_profile = tempfile::tempdir().unwrap();
        let acme = calp::signing::PublisherKeypair::load_or_create(acme_profile.path()).unwrap();
        assert_ne!(acme.public_key_hex(), attacker.public_key_hex());
        let real = tempfile::tempdir().unwrap();
        let real_hash = bundle_with_hash(real.path(), "acme-tax", "export default { real: true };\n");
        let m2 = format!(
            r#"{{"id":"acme.tax-tools","version":"1.0.0","workerSupport":true,"capabilities":["formula.udf"],"publisherKey":"{}"{}}}"#,
            acme.public_key_hex(),
            real_hash
        );
        let mp2 = write(real.path(), "acme-tax.manifest.json", &m2);
        let sp2 = write(
            real.path(),
            "acme-tax.manifest.sig",
            &acme.sign(&std::fs::read(&mp2).unwrap()),
        );
        let (_, status) = verify_extension_manifest(&mp2, &sp2, user_profile.path());
        assert_eq!(
            status,
            crate::extension_install::TRUST_NOT_INSTALLED,
            "the genuine publisher must read as first contact, NOT as a publisher change"
        );
    }

    /// A signature that verifies but makes NO claim about the program file is
    /// not trusted, and — critically — does not pin. The scan is the launch-time
    /// gate on the capability ceiling, so this is where "signed" has to mean the
    /// code or it means nothing.
    #[test]
    fn signed_without_a_code_hash_is_not_trusted_and_does_not_pin() {
        let dir = tempfile::tempdir().unwrap();
        let profile = tempfile::tempdir().unwrap();
        let kp = calp::signing::PublisherKeypair::load_or_create(profile.path()).unwrap();
        std::fs::write(dir.path().join("n.js"), "export default {};\n").unwrap();
        let manifest = format!(
            r#"{{"id":"e.nohash","version":"1.0.0","workerSupport":true,"capabilities":["storage"],"publisherKey":"{}"}}"#,
            kp.public_key_hex()
        );
        let mp = write(dir.path(), "n.manifest.json", &manifest);
        let sp = write(dir.path(), "n.manifest.sig", &kp.sign(&std::fs::read(&mp).unwrap()));

        let (_, status) = verify_extension_manifest(&mp, &sp, profile.path());
        assert_eq!(status, crate::extension_install::TRUST_CODE_UNVERIFIED);
        assert!(!crate::extension_install::trust_grants_capabilities(&status));
        assert!(
            ext_pin(profile.path(), "e.nohash").is_none(),
            "a key we will not trust must not become the pin a later release is measured against"
        );
    }
}

/// Scan a directory for third-party extension bundles (.js files).
/// Returns the file name, path, and content of each found extension.
#[tauri::command]
fn scan_extension_directory(dir: String, window: tauri::Window) -> Result<Vec<ExtensionFileEntry>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let path = std::path::Path::new(&dir);
    if !path.exists() {
        // Directory doesn't exist — not an error, just no extensions
        return Ok(vec![]);
    }
    if !path.is_dir() {
        return Err(format!("'{}' is not a directory", dir));
    }

    let mut entries = Vec::new();
    let read_dir = std::fs::read_dir(path).map_err(|e| format!("Failed to read directory: {}", e))?;
    let profile_dir = crate::calp_commands::calcula_profile_dir();

    for entry in read_dir {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let file_path = entry.path();

        // Only load .js files (pre-built extension bundles)
        if file_path.extension().and_then(|e| e.to_str()) == Some("js") {
            let file_name = file_path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown")
                .to_string();
            let content = std::fs::read_to_string(&file_path)
                .map_err(|e| format!("Failed to read '{}': {}", file_name, e))?;
            // Sidecar manifest + signature: "<base>.manifest.json" / ".manifest.sig".
            let stem = file_path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let manifest_path = file_path.with_file_name(format!("{}.manifest.json", stem));
            let sig_path = file_path.with_file_name(format!("{}.manifest.sig", stem));
            let (manifest_json, trust_status) =
                verify_extension_manifest(&manifest_path, &sig_path, &profile_dir);
            entries.push(ExtensionFileEntry {
                file_name,
                path: file_path.to_string_lossy().to_string(),
                content,
                manifest_json,
                trust_status,
            });
        }

        // Also support directories with an index.js entry point
        if file_path.is_dir() {
            let index_path = file_path.join("index.js");
            if index_path.exists() {
                let dir_name = file_path.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("unknown")
                    .to_string();
                let content = std::fs::read_to_string(&index_path)
                    .map_err(|e| format!("Failed to read '{}/index.js': {}", dir_name, e))?;
                // Sidecar manifest for a directory extension.
                let manifest_path = file_path.join("extension.manifest.json");
                let sig_path = file_path.join("extension.manifest.sig");
                let (manifest_json, trust_status) =
                    verify_extension_manifest(&manifest_path, &sig_path, &profile_dir);
                entries.push(ExtensionFileEntry {
                    file_name: format!("{}/index.js", dir_name),
                    path: index_path.to_string_lossy().to_string(),
                    content,
                    manifest_json,
                    trust_status,
                });
            }
        }
    }

    Ok(entries)
}

/// Get the default path for third-party extensions (next to the app data dir).
#[tauri::command]
fn get_extensions_directory(app_handle: tauri::AppHandle, window: tauri::Window) -> Result<String, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    use tauri::Manager;
    let app_data = app_handle.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let ext_dir = app_data.join("extensions");
    // Create the directory if it doesn't exist
    if !ext_dir.exists() {
        std::fs::create_dir_all(&ext_dir)
            .map_err(|e| format!("Failed to create extensions dir: {}", e))?;
    }
    Ok(ext_dir.to_string_lossy().to_string())
}

/// Resolve the on-disk targets to delete when uninstalling an extension bundle,
/// rejecting any `file_name` that could escape `ext_dir`. Pure (no fs) so it is
/// unit-testable. `file_name` is the value `scan_extension_directory` reported:
/// "<bundle>.js" for a single-file bundle, or "<dir>/index.js" for a directory
/// bundle. Returns candidate paths to remove (the directory for a dir bundle; the
/// bundle + its two sidecars for a file bundle — some may not exist on disk).
fn resolve_uninstall_targets(
    ext_dir: &std::path::Path,
    file_name: &str,
) -> Result<Vec<std::path::PathBuf>, String> {
    // Reject anything that could traverse out of the extensions directory.
    if file_name.is_empty()
        || file_name.contains("..")
        || file_name.contains('\\')
        || file_name.starts_with('/')
    {
        return Err("Invalid extension name".to_string());
    }

    if let Some(dir) = file_name.strip_suffix("/index.js") {
        // Directory bundle: remove the whole "<dir>/" folder.
        if dir.is_empty() || dir.contains('/') {
            return Err("Invalid extension directory name".to_string());
        }
        Ok(vec![ext_dir.join(dir)])
    } else {
        // Single-file bundle: "<stem>.js" + its two sidecars.
        if file_name.contains('/') {
            return Err("Invalid extension file name".to_string());
        }
        let stem = file_name
            .strip_suffix(".js")
            .ok_or_else(|| "Not an extension bundle (.js expected)".to_string())?;
        if stem.is_empty() {
            return Err("Invalid extension file name".to_string());
        }
        Ok(vec![
            ext_dir.join(format!("{}.js", stem)),
            ext_dir.join(format!("{}.manifest.json", stem)),
            ext_dir.join(format!("{}.manifest.sig", stem)),
        ])
    }
}

/// Read whatever identity the about-to-be-removed bundle still carries, so the
/// machine-scoped trail can name WHAT was removed rather than only which file
/// disappeared. Read BEFORE the delete, obviously — afterwards there is nothing
/// left to read — and entirely best-effort: an unreadable or absent sidecar
/// yields an empty description, never a refusal to uninstall.
fn describe_installed_extension(
    ext_dir: &std::path::Path,
    file_name: &str,
) -> (String, String, String, String) {
    let manifest_path = match file_name.strip_suffix("/index.js") {
        Some(dir) => ext_dir.join(dir).join("extension.manifest.json"),
        None => match file_name.strip_suffix(".js") {
            Some(stem) => ext_dir.join(format!("{}.manifest.json", stem)),
            None => return (String::new(), String::new(), String::new(), String::new()),
        },
    };
    let parsed = std::fs::read(&manifest_path)
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .unwrap_or(serde_json::Value::Null);
    let s = |k: &str| {
        parsed
            .get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string()
    };
    (s("id"), s("name"), s("version"), s("publisherKey"))
}

/// Uninstall a third-party extension by deleting its bundle + sidecar files (or
/// its directory) from the extensions directory (C7). The extensions directory is
/// ALWAYS app_data/extensions (never caller-supplied); `file_name` is the value
/// reported by `scan_extension_directory` and is validated to stay within it. The
/// TOFU publisher pin (`ext:{id}`) is intentionally left in place so a later
/// re-install of the same id from the same key still verifies — which is exactly
/// why the removal is recorded in the machine-scoped trail: the pin outlives the
/// add-in, so the record of why it exists has to as well.
#[tauri::command]
fn uninstall_extension(
    app_handle: tauri::AppHandle,
    window: tauri::Window,
    file_name: String,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    use tauri::Manager;
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let ext_dir = app_data.join("extensions");
    let ext_dir_canon = ext_dir
        .canonicalize()
        .map_err(|e| format!("Extensions directory not available: {}", e))?;

    let (id, name, version, publisher_key) = describe_installed_extension(&ext_dir, &file_name);

    let targets = resolve_uninstall_targets(&ext_dir, &file_name)?;

    let mut removed_any = false;
    for target in targets {
        if !target.exists() {
            continue;
        }
        // Defense in depth: the target's parent must canonicalize to within the
        // extensions directory before anything is deleted.
        let parent_canon = target
            .parent()
            .and_then(|p| p.canonicalize().ok())
            .ok_or_else(|| "Failed to resolve extension path".to_string())?;
        if !parent_canon.starts_with(&ext_dir_canon) {
            return Err("Refusing to delete outside the extensions directory".to_string());
        }
        if target.is_dir() {
            std::fs::remove_dir_all(&target)
                .map_err(|e| format!("Failed to remove '{}': {}", target.display(), e))?;
        } else {
            std::fs::remove_file(&target)
                .map_err(|e| format!("Failed to remove '{}': {}", target.display(), e))?;
        }
        removed_any = true;
    }

    if !removed_any {
        return Err(format!("Extension '{}' not found", file_name));
    }

    // Machine-scoped, append-only, and written only for a removal that actually
    // happened. The publisher pin is deliberately NOT revoked here, so this row
    // is the only thing that explains why a key for a long-gone add-in is still
    // trusted on this machine.
    crate::extension_audit::record(
        &crate::calp_commands::calcula_profile_dir(),
        crate::extension_audit::ExtensionAuditEntry {
            at: crate::extension_audit::now_rfc3339(),
            action: crate::extension_audit::ACTION_REMOVED.to_string(),
            id: id.clone(),
            name: name.clone(),
            version,
            bundle_file_name: file_name.clone(),
            publisher_key,
            detail: format!(
                "Removed '{}' from this computer. Its trusted publisher key was kept, so \
                 reinstalling the same add-in from the same publisher will still verify.",
                if name.is_empty() { file_name } else { name },
            ),
            ..Default::default()
        },
    );
    Ok(())
}

#[cfg(test)]
mod uninstall_extension_tests {
    use super::resolve_uninstall_targets;
    use std::path::Path;

    #[test]
    fn file_bundle_resolves_bundle_plus_two_sidecars() {
        let t = resolve_uninstall_targets(Path::new("/ext"), "myext.js").unwrap();
        assert_eq!(t.len(), 3);
        assert!(t[0].ends_with("myext.js"));
        assert!(t[1].ends_with("myext.manifest.json"));
        assert!(t[2].ends_with("myext.manifest.sig"));
    }

    #[test]
    fn directory_bundle_resolves_the_directory() {
        let t = resolve_uninstall_targets(Path::new("/ext"), "my-ext/index.js").unwrap();
        assert_eq!(t.len(), 1);
        assert!(t[0].ends_with("my-ext"));
    }

    #[test]
    fn rejects_path_traversal_and_junk() {
        for bad in [
            "../evil.js", "..\\evil.js", "/etc/passwd.js", "a/b.js",
            "sub/../../x.js", "../../index.js", "x/../../y/index.js",
            "/index.js", "", ".js", "notjs.txt",
        ] {
            assert!(
                resolve_uninstall_targets(Path::new("/ext"), bad).is_err(),
                "should reject {bad}",
            );
        }
    }
}

// ============================================================================
// TAURI APP ENTRY
// ============================================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    match init_log_file() {
        Ok(path) => {
            eprintln!("[LOG_INIT] SUCCESS - Log file: {:?}", path);
            log_info!("SYS", "Tauri backend starting, log={}", path.display());
        }
        Err(e) => {
            eprintln!("[LOG_INIT] FAILED: {}", e);
            eprintln!("[LOG_INIT] Continuing with console-only logging");
        }
    }

    // Load log filter config (muted categories/levels)
    match logging::load_log_filter_config() {
        Ok(_) => {}
        Err(e) => {
            eprintln!("[LOG_FILTER] Failed to load config: {}", e);
        }
    }

    // Record this app's version so the .calp compatibility gate can refuse a
    // package that requires a newer Calcula (honest "update the app").
    calp::set_host_app_version(env!("CARGO_PKG_VERSION"));

    // Resolve the machine-wide ADVISORY appearance policy once at startup (reads
    // %PROGRAMDATA%\Calcula\policy.json; missing = unmanaged). This pre-trusts a
    // signed corporate skin and seeds the org default for the frontend resolver.
    let appearance_policy = managed_policy::resolve_effective_policy(
        &managed_policy::read_managed_policy(),
        &crate::calp_commands::calcula_profile_dir(),
    );

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(create_app_state())
        .manage(FileState::default())
        .manage(UserFilesState::default())
        .manage(pivot::PivotState::new())
        .manage(bi::BiState::new())
        .manage(evaluate_formula::EvalFormulaState::new())
        .manage(scripting::ScriptState::new())
        .manage(scripting::CapabilityStore::new())
        .manage(slicer::SlicerState::new())
        .manage(ribbon_filter::RibbonFilterState::new())
        .manage(pane_control::PaneControlState::new())
        .manage(timeline_slicer::TimelineSlicerState::new())
        .manage(mcp::McpState::new())
        .manage(managed_policy::ManagedAppearanceState(std::sync::Mutex::new(appearance_policy)))
        .invoke_handler(tauri::generate_handler![
            // Grid commands
            commands::get_viewport_cells,
            commands::get_spill_ranges,
            commands::get_cell,
            commands::get_watch_cells,
            commands::get_range_cells_typed,
            commands::get_cell_collection,
            commands::get_collection_texts,
            commands::update_cell,
            commands::update_cells_batch,
            scripting::collect_udf_calls,
            commands::clear_cell,
            commands::clear_range,
            commands::clear_range_with_options,
            commands::sort_range,
            commands::fill_range,
            commands::update_cell_on_sheets,
            commands::recalculate_sheets_after_script_write,
            commands::clear_range_on_sheets,
            commands::remove_duplicates,
            commands::get_grid_bounds,
            commands::get_cell_count,
            commands::get_used_range,
            commands::get_cells_in_rows,
            commands::get_cells_in_cols,
            commands::has_content_in_range,
            // Navigation commands
            commands::find_ctrl_arrow_target,
            commands::detect_data_region,
            commands::get_current_region,
            commands::get_range_edge,
            commands::go_to_special,
            commands::get_special_cells,
            // Dimension commands
            commands::set_column_width,
            commands::get_column_width,
            commands::get_all_column_widths,
            commands::set_row_height,
            commands::get_row_height,
            commands::get_all_row_heights,
            commands::set_rows_hidden,
            commands::set_cols_hidden,
            commands::get_user_hidden_rows,
            commands::get_user_hidden_cols,
            commands::get_hidden_rows_info,
            commands::get_hidden_cols_info,
            commands::get_default_dimensions,
            commands::set_default_row_height,
            commands::set_default_column_width,
            // Style commands
            commands::get_style,
            commands::get_all_styles,
            commands::set_cell_style,
            commands::set_cell_rich_text,
            commands::apply_formatting,
            commands::apply_formatting_to_sheets,
            commands::apply_border_preset,
            commands::preview_number_format,
            commands::get_ribbon_number_formats,
            commands::get_style_count,
            commands::insert_rows,
            commands::insert_columns,
            commands::delete_rows,
            commands::delete_columns,
            commands::shift_formula_for_fill,
            commands::shift_formulas_batch,
            commands::relocate_cell_references,
            // Undo/Redo commands
            undo_commands::begin_undo_transaction,
            undo_commands::commit_undo_transaction,
            undo_commands::cancel_undo_transaction,
            undo_commands::get_undo_state,
            undo_commands::undo,
            undo_commands::redo,
            // Testing oracle commands
            state_digest::get_workbook_state_digest,
            // Logging commands
            logging::log_frontend,
            logging::log_frontend_atomic,
            logging::get_next_seq,
            logging::sort_log_file,
            logging::get_log_filter_config,
            logging::set_log_filter,
            logging::set_debug_logging,
            // Calculation mode commands
            calculation::set_calculation_mode,
            calculation::get_calculation_mode,
            calculation::calculate_now,
            calculation::calculate_sheet,
            calculation::get_iteration_settings,
            calculation::set_iteration_settings,
            calculation::get_calculation_state,
            // Cancellation (the Ctrl+Break analogue). cancel_calculation takes
            // no lock a running recalc could hold, so it stays reachable while
            // the recalc owns the grid.
            calculation::cancel_calculation,
            calculation::get_pending_recalc,
            calculation::clear_pending_recalc,
            calculation::get_precision_as_displayed,
            calculation::set_precision_as_displayed,
            calculation::get_calculate_before_save,
            calculation::set_calculate_before_save,
            // SUBTOTAL/AGGREGATE depend on row VISIBILITY, which no cell write
            // dirties — every surface that hides or reveals rows must ask for
            // this cascade or those totals go stale.
            calculation::recalc_visibility_dependents,
            // Formula library commands
            formula::get_functions_by_category,
            formula::get_all_functions,
            formula::get_function_template,
            formula::evaluate_expressions,
            formula::evaluate_formula_typed,
            formula::evaluate_scoped,
            // File commands
            persistence::save_file,
            persistence::get_extension_data,
            persistence::set_extension_data,
            persistence::set_extension_data_undoable,
            persistence::open_file,
            persistence::new_file,
            persistence::get_current_file_path,
            persistence::is_file_modified,
            persistence::mark_file_modified,
            persistence::is_document_encrypted,
            persistence::set_session_password,
            persistence::clear_session_password,
            file_keychain::keychain_set_password,
            file_keychain::keychain_get_password,
            file_keychain::keychain_delete_password,
            file_keychain::keychain_has_password,
            ai::ai_providers_list,
            ai::ai_provider_set_key,
            ai::ai_provider_has_key,
            ai::ai_provider_delete_key,
            ai::ai_discover_local_runtimes,
            ai::ai_list_models,
            ai::ai_chat_complete,
            ai::ai_chat_complete_stream,
            ai::ai_chat_cancel_stream,
            ai::dryrun::ai_dry_run_script,
            ai::preview_eval::preview_evaluate_formulas,
            ai::tools::ai_chat_run_tool,
            persistence::list_virtual_files,
            persistence::read_virtual_file,
            persistence::create_virtual_file,
            persistence::create_virtual_folder,
            persistence::delete_virtual_file,
            persistence::rename_virtual_file,
            persistence::get_ai_context,
            persistence::read_text_file,
            persistence::write_text_file,
            persistence::get_auto_recover_settings,
            persistence::set_auto_recover_settings,
            persistence::auto_recover_save,
            persistence::xlsx_save_loss_report,
            persistence::get_workbook_properties,
            persistence::set_workbook_properties,
            // Sheet commands
            sheets::get_sheets,
            sheets::get_active_sheet,
            sheets::get_sheet_ids,
            sheets::get_show_gridlines,
            sheets::set_show_gridlines,
            sheets::get_sheet_display_flags,
            sheets::set_sheet_display_flags,
            sheets::set_active_sheet,
            sheets::add_sheet,
            sheets::delete_sheet,
            sheets::rename_sheet,
            floating_range::create_floating_range,
            floating_range::list_floating_ranges,
            floating_range::update_floating_range,
            floating_range::update_floating_range_cell,
            floating_range::get_floating_range_cells,
            floating_range::rename_floating_range,
            floating_range::delete_floating_range,
            sheets::set_freeze_panes,
            sheets::get_freeze_panes,
            sheets::set_split_window,
            sheets::get_split_window,
            sheets::set_sheet_zoom,
            sheets::get_sheet_zoom,
            sheets::move_sheet,
            sheets::copy_sheet,
            sheets::hide_sheet,
            sheets::unhide_sheet,
            sheets::set_tab_color,
            sheets::next_sheet,
            sheets::previous_sheet,
            sheets::set_scroll_area,
            sheets::get_scroll_area,
            // Find & Replace commands
            commands::find_all,
            commands::count_matches,
            commands::replace_all,
            commands::replace_single,
            // Merge cell commands
            merge_commands::merge_cells,
            merge_commands::unmerge_cells,
            merge_commands::get_merged_regions,
            merge_commands::get_merge_info,
            // Pivot table commands - Core operations
            pivot::create_pivot_table,
            pivot::update_pivot_fields,
            pivot::toggle_pivot_group,
            pivot::get_pivot_view,
            pivot::get_pivot_cell_window,
            pivot::cancel_pivot_operation,
            pivot::revert_pivot_operation,
            pivot::undo_pivot_overwrite,
            pivot::delete_pivot_table,
            pivot::relocate_pivot,
            pivot::get_pivot_source_data,
            pivot::refresh_pivot_cache,
            pivot::get_pivot_at_cell,
            pivot::get_pivot_data_formula,
            pivot::get_pivot_regions_for_sheet,
            pivot::get_pivot_field_unique_values,
            // Pivot table commands - Excel-compatible API
            pivot::get_pivot_table_info,
            pivot::update_pivot_properties,
            pivot::change_pivot_data_source,
            pivot::get_pivot_layout_ranges,
            pivot::update_pivot_layout,
            pivot::get_pivot_hierarchies,
            pivot::add_pivot_hierarchy,
            pivot::remove_pivot_hierarchy,
            pivot::move_pivot_field,
            pivot::set_pivot_aggregation,
            pivot::set_pivot_number_format,
            pivot::apply_pivot_filter,
            pivot::clear_pivot_filter,
            pivot::sort_pivot_field,
            pivot::get_pivot_field_info,
            pivot::set_pivot_item_visibility,
            pivot::get_all_pivot_tables,
            pivot::get_pivot_bi_metadata,
            pivot::get_pivots_for_bi_connection,
            pivot::refresh_all_pivot_tables,
            pivot::set_pivot_item_expanded,
            pivot::expand_collapse_level,
            pivot::expand_collapse_all,
            pivot::group_pivot_field,
            pivot::create_manual_group,
            pivot::ungroup_pivot_field,
            pivot::drill_through_to_sheet,
            pivot::set_pivot_drill_behavior,
            pivot::set_pivot_perspective,
            pivot::get_pivot_drill_behavior,
            pivot::create_pivot_from_bi_model,
            pivot::update_bi_pivot_fields,
            pivot::headless::run_design_query,
            pivot::headless::get_connection_bi_model,
            report::create_report,
            report::refresh_report,
            report::delete_report,
            report::list_reports,
            report::restore_report,
            pivot::set_bi_lookup_columns,
            pivot::show_report_filter_pages,
            pivot::add_calculated_field,
            pivot::update_calculated_field,
            pivot::remove_calculated_field,
            pivot::add_calculated_item,
            pivot::remove_calculated_item,
            // Pivot layout commands
            pivot::layout_commands::save_pivot_layout,
            pivot::layout_commands::get_pivot_layouts,
            pivot::layout_commands::delete_pivot_layout,
            // Named range commands
            named_ranges::create_named_range,
            named_ranges::update_named_range,
            named_ranges::delete_named_range,
            named_ranges::get_named_range,
            named_ranges::get_all_named_ranges,
            named_ranges::get_named_range_for_selection,
            named_ranges::resolve_named_range_coords,
            named_ranges::rename_named_range,
            named_ranges::apply_names_to_formulas,
            // BI (Business Intelligence) commands
            bi::bi_create_connection,
            bi::bi_delete_connection,
            bi::bi_update_connection,
            bi::bi_get_connections,
            bi::bi_get_connection,
            bi::bi_connect,
            bi::bi_disconnect,
            bi::bi_bind_table,
            bi::bi_query,
            bi::script_bi_sql,
            bi::bi_insert_result,
            bi::bi_refresh_connection,
            bi::bi_refresh_all_in_memory,
            bi::bi_get_model_info,
            bi::bi_set_active_role,
            bi::bi_get_active_role,
            bi::bi_get_column_values,
            bi::bi_get_column_available_values,
            bi::bi_get_region_at_cell,
            bi::bi_save_all_caches,
            bi::cube::cube_prefetch,
            bi::cube::cube_prefetch_all,
            bi::cube::cube_udf_value,
            bi::cube::cube_udf_kpi,
            bi::cube::cube_udf_members,
            bi::measures::bi_get_calculated_measures,
            bi::measures::bi_set_calculated_measures,
            bi::model_editor::bi_model_get_measures,
            bi::model_editor::bi_model_validate_measure,
            bi::model_editor::bi_model_upsert_measure,
            bi::model_editor::bi_model_delete_measure,
            bi::model_editor::bi_model_measure_lineage,
            bi::model_editor::bi_model_dependency_graph,
            bi::model_editor::bi_model_get_overview,
            bi::model_editor::bi_model_update_table,
            bi::model_editor::bi_model_update_column,
            bi::model_editor::bi_model_upsert_model_column,
            bi::model_editor::bi_model_delete_calc_column,
            bi::model_editor::bi_model_upsert_relationship,
            bi::model_editor::bi_model_delete_relationship,
            bi::model_editor::bi_model_upsert_hierarchy,
            bi::model_editor::bi_model_delete_hierarchy,
            bi::model_editor::bi_model_upsert_kpi,
            bi::model_editor::bi_model_delete_kpi,
            bi::model_editor::bi_model_upsert_role,
            bi::model_editor::bi_model_upsert_perspective,
            bi::model_editor::bi_model_delete_perspective,
            bi::model_editor::bi_model_upsert_culture,
            bi::model_editor::bi_model_delete_culture,
            bi::model_editor::bi_model_delete_role,
            bi::model_editor::bi_model_upsert_calc_group,
            bi::model_editor::bi_model_delete_calc_group,
            bi::model_editor::bi_model_upsert_global_variable,
            bi::model_editor::bi_model_delete_global_variable,
            bi::model_editor::bi_model_calculated_table_dependents,
            bi::model_editor::bi_model_materialize_calculated_table,
            bi::model_editor::bi_model_upsert_table_variable,
            bi::model_editor::bi_model_delete_table_variable,
            bi::model_editor::bi_model_upsert_script_function,
            bi::model_editor::bi_model_delete_script_function,
            bi::model_editor::bi_model_upsert_context,
            bi::model_editor::bi_model_validate_context,
            bi::model_editor::bi_model_delete_context,
            bi::model_editor::bi_model_upsert_context_column,
            bi::model_editor::bi_model_delete_context_column,
            bi::model_editor::bi_model_set_date_table,
            bi::model_editor::bi_model_set_default_lookup_resolution,
            bi::model_editor::bi_model_set_metadata,
            bi::model_editor::bi_model_set_table_storage_mode,
            bi::model_editor::bi_model_set_table_refresh,
            bi::model_editor::bi_model_refresh_table,
            bi::model_editor::bi_model_extension_data,
            bi::model_editor::bi_model_transform,
            bi::model_editor::bi_model_source_secrets,
            bi::macro_capture::macro_model_recording_set_armed,
            bi::macro_capture::macro_model_recording_armed,
            bi::model_editor::script_bi_model,
            bi::script_source::bi_script_source,
            bi::script_source::connector_secrets,
            bi::model_editor::bi_model_function_catalog,
            bi::model_editor::bi_model_function_docs,
            bi::model_editor::bi_model_undo,
            bi::model_editor::bi_model_redo,
            bi::model_editor::bi_model_undo_state,
            bi::model_editor::bi_model_batch_begin,
            bi::model_editor::bi_model_batch_end,
            bi::model_editor::bi_model_batch_cancel,
            bi::model_editor::bi_model_validate,
            bi::model_editor::bi_model_test_query,
            bi::model_editor::bi_model_cancel_query,
            bi::model_editor::bi_model_list_source_tables,
            bi::model_editor::bi_model_import_tables,
            bi::model_editor::bi_model_create_blank,
            bi::model_editor::bi_model_test_connection,
            bi::model_editor::bi_model_connect,
            bi::model_editor::bi_model_export_to_file,
            bi::model_editor::bi_model_import_from_file,
            bi::model_editor::bi_model_import_sql_source,
            bi::model_editor::bi_model_delete_table,
            bi::model_editor::bi_model_upsert_source,
            bi::model_editor::bi_model_delete_source,
            bi::model_editor::bi_model_set_table_source_binding,
            bi::model_editor::bi_model_connect_source,
            bi::model_editor::bi_model_source_saved_user,
            bi::model_editor::bi_model_forget_source_credentials,
            bi::model_editor::bi_model_auto_connect_sources,
            // Writeback dataset commands (writeback submissions as model tables)
            bi::writeback_source::bi_list_writeback_tables,
            bi::writeback_source::bi_import_writeback_tables,
            bi::writeback_source::bi_refresh_writeback_data,
            // Model writeback COLUMN commands (engine v21)
            bi::writeback::bi_writeback_set_value,
            bi::writeback::bi_writeback_get_values,
            bi::writeback::bi_writeback_list_columns,
            calp_commands::calp_list_model_submissions,
            calp_commands::calp_set_model_submission_state,
            bi::model_editor::bi_model_upsert_writeback_column,
            bi::model_editor::bi_model_delete_writeback_column,
            // Data validation commands
            data_validation::set_data_validation,
            data_validation::clear_data_validation,
            data_validation::get_data_validation,
            data_validation::get_all_data_validations,
            data_validation::validate_cell,
            data_validation::get_validation_prompt,
            data_validation::get_invalid_cells,
            data_validation::get_validation_list_values,
            data_validation::has_in_cell_dropdown,
            data_validation::validate_pending_value,
            // Comment commands
            comments::add_comment,
            comments::update_comment,
            comments::delete_comment,
            comments::get_comment,
            comments::get_comment_by_id,
            comments::get_all_comments,
            comments::get_comments_for_sheet,
            comments::get_comment_indicators,
            comments::get_comment_indicators_in_range,
            comments::resolve_comment,
            comments::add_reply,
            comments::update_reply,
            comments::delete_reply,
            comments::move_comment,
            comments::get_comment_count,
            comments::has_comment,
            comments::clear_all_comments,
            comments::clear_comments_in_range,
            // Note commands
            notes::add_note,
            notes::update_note,
            notes::delete_note,
            notes::get_note,
            notes::get_note_by_id,
            notes::get_all_notes,
            notes::get_note_indicators,
            notes::get_note_indicators_in_range,
            notes::resize_note,
            notes::toggle_note_visibility,
            notes::show_all_notes,
            notes::move_note,
            notes::has_note,
            notes::clear_all_notes,
            notes::clear_notes_in_range,
            notes::convert_note_to_comment,
            // AutoFilter commands
            autofilter::apply_auto_filter,
            autofilter::clear_column_criteria,
            autofilter::clear_auto_filter_criteria,
            autofilter::reapply_auto_filter,
            autofilter::remove_auto_filter,
            autofilter::get_auto_filter,
            autofilter::get_auto_filter_range,
            autofilter::get_hidden_rows,
            autofilter::set_advanced_filter_hidden_rows,
            autofilter::clear_advanced_filter_hidden_rows,
            autofilter::run_advanced_filter,
            autofilter::is_row_filtered,
            autofilter::get_filter_unique_values,
            autofilter::set_column_filter_values,
            autofilter::set_column_custom_filter,
            autofilter::set_column_top_bottom_filter,
            autofilter::set_column_dynamic_filter,
            // Hyperlink commands
            hyperlinks::add_hyperlink,
            hyperlinks::update_hyperlink,
            hyperlinks::remove_hyperlink,
            hyperlinks::get_hyperlink,
            hyperlinks::get_all_hyperlinks,
            hyperlinks::get_hyperlink_indicators,
            hyperlinks::get_hyperlinks_in_range,
            hyperlinks::has_hyperlink,
            hyperlinks::clear_hyperlinks_in_range,
            hyperlinks::move_hyperlink,
            // Protection commands
            protection::protect_sheet,
            protection::unprotect_sheet,
            protection::update_protection_options,
            protection::add_allow_edit_range,
            protection::remove_allow_edit_range,
            protection::get_allow_edit_ranges,
            protection::get_protection_status,
            protection::is_sheet_protected,
            protection::can_edit_cell,
            protection::can_perform_action,
            protection::set_cell_protection,
            protection::get_cell_protection,
            protection::verify_edit_range_password,
            // Workbook protection commands
            protection::protect_workbook,
            protection::unprotect_workbook,
            protection::is_workbook_protected,
            protection::get_workbook_protection_status,
            // Grouping (Outline) commands
            grouping::group_rows,
            grouping::ungroup_rows,
            grouping::group_columns,
            grouping::ungroup_columns,
            grouping::collapse_row_group,
            grouping::expand_row_group,
            grouping::collapse_column_group,
            grouping::expand_column_group,
            grouping::show_outline_level,
            grouping::get_outline_info,
            grouping::get_outline_settings,
            grouping::set_outline_settings,
            grouping::clear_outline,
            grouping::is_row_hidden_by_group,
            grouping::is_col_hidden_by_group,
            grouping::get_hidden_rows_by_group,
            grouping::get_hidden_cols_by_group,
            // Conditional Formatting commands
            conditional_formatting::add_conditional_format,
            conditional_formatting::update_conditional_format,
            conditional_formatting::delete_conditional_format,
            conditional_formatting::reorder_conditional_formats,
            conditional_formatting::get_conditional_format,
            conditional_formatting::get_all_conditional_formats,
            conditional_formatting::evaluate_conditional_formats,
            conditional_formatting::clear_conditional_formats_in_range,
            // Table commands
            tables::create_table,
            tables::delete_table,
            tables::rename_table,
            tables::update_table_style,
            tables::add_table_column,
            tables::remove_table_column,
            tables::rename_table_column,
            tables::set_totals_row_function,
            tables::toggle_totals_row,
            tables::resize_table,
            tables::convert_to_range,
            tables::check_table_auto_expand,
            tables::enforce_table_header,
            tables::set_calculated_column,
            tables::get_table,
            tables::get_table_by_id,
            tables::add_table_row,
            tables::get_table_by_name,
            tables::get_table_at_cell,
            tables::get_all_tables,
            tables::get_tables_for_sheet,
            tables::get_tables_all_sheets,
            tables::resolve_structured_reference,
            tables::convert_formula_to_table_refs,
            // Goal Seek command
            goal_seek::goal_seek,
            // Scenario Manager commands
            scenario_manager::scenario_list,
            scenario_manager::scenario_add,
            scenario_manager::scenario_delete,
            scenario_manager::scenario_show,
            scenario_manager::scenario_summary,
            scenario_manager::scenario_merge,
            // Animation playback (transient frame writes)
            animation_commands::anim_snapshot,
            animation_commands::anim_apply_frame,
            animation_commands::anim_restore,
            animation_commands::anim_reroll_and_read,
            animation_commands::export_gif,
            // Data Tables commands
            data_tables::data_table_one_var,
            data_tables::data_table_two_var,
            // Solver commands
            solver::solver_solve,
            solver::solver_revert,
            // Data Consolidation command
            consolidate::consolidate_data,
            // Tracing commands (Trace Precedents / Trace Dependents)
            tracing::trace_precedents,
            tracing::trace_dependents,
            // Evaluate Formula commands (step-by-step formula debugger)
            evaluate_formula::eval_formula_init,
            evaluate_formula::eval_formula_evaluate,
            evaluate_formula::eval_formula_step_in,
            evaluate_formula::eval_formula_step_out,
            evaluate_formula::eval_formula_restart,
            evaluate_formula::eval_formula_close,
            // Formula evaluation plan (visual formula debugger)
            formula_eval_plan::get_formula_eval_plan,
            // Status bar aggregation command
            status_bar::get_selection_aggregations,
            // Computed Properties commands
            computed_properties::get_computed_properties,
            computed_properties::get_available_attributes,
            computed_properties::add_computed_property,
            computed_properties::update_computed_property,
            computed_properties::remove_computed_property,
            // Scripting commands
            scripting::run_script,
            scripting::get_script_security_level,
            scripting::set_script_security_level,
            scripting::get_mcp_access_level,
            scripting::set_mcp_access_level,
            scripting::script_execution_status,
            scripting::grant_script_session_approval,
            scripting::list_scripts,
            scripting::get_script,
            scripting::save_script,
            scripting::delete_script,
            // Notebook commands
            scripting::notebook_create,
            scripting::notebook_save,
            scripting::notebook_load,
            scripting::notebook_list,
            scripting::notebook_delete,
            scripting::notebook_run_cell,
            scripting::notebook_run_all,
            scripting::notebook_rewind,
            scripting::notebook_run_from,
            scripting::notebook_reset_runtime,
            // Object script commands (scriptable objects)
            scripting::list_object_scripts,
            scripting::get_object_script,
            scripting::get_object_script_by_target,
            scripting::save_object_script,
            scripting::delete_object_script,
            scripting::delete_object_scripts_for_instance,
            // AI script-authoring transcript (what was asked, what came back,
            // what the author decided). Appended ONLY on a decision.
            scripting::get_script_authoring_runs,
            scripting::append_script_authoring_run,
            scripting::adopt_script_authoring_runs,
            scripting::clear_script_authoring_runs,
            // Script network capability commands (Phase 4 — net.fetch egress)
            net_commands::grant_script_net_origin,
            net_commands::audit_record_capability,
            net_commands::revoke_script_capabilities,
            net_commands::list_script_capability_grants,
            net_commands::script_http_fetch,
            // Writeback / distribution automation gateway (distribution.writeback).
            // ONE action-multiplexed command on purpose — see the module header:
            // the debug dispatch frame for ~660 commands nearly exhausts the
            // 32MB main-thread stack reserve set in build.rs.
            scripting::grant_script_capability,
            scripting::script_writeback,
            // .calp distribution gateway (distribution.publish OUTBOUND /
            // distribution.subscribe INBOUND — two capabilities, one command,
            // for the same stack-headroom reason).
            scripting::script_distribution,
            // Persistent consented scheduler (the `schedule` capability — the
            // Application.OnTime replacement). Likewise ONE op-multiplexed
            // command for the same stack-headroom reason.
            scripting::script_scheduler,
            // Object template commands (scriptable objects templates)
            scripting::list_object_templates,
            scripting::save_object_template,
            scripting::load_object_template,
            scripting::delete_object_template,
            // Control metadata commands
            controls::get_control_metadata,
            controls::set_control_property,
            controls::set_control_metadata,
            controls::remove_control_metadata,
            controls::get_all_controls,
            controls::list_controls_referencing_macro,
            controls::resolve_control_properties,
            media::read_media_file,
            media::resolve_media_ref,
            // Cell-type assignment commands (granular bricks)
            cell_types::set_cell_type,
            cell_types::set_cell_type_range,
            cell_types::clear_cell_type,
            cell_types::clear_cell_type_range,
            cell_types::get_cell_type,
            cell_types::get_all_cell_types,
            // Cell-behavior binding commands (granular bricks phase 2)
            cell_behaviors::set_cell_behavior,
            cell_behaviors::remove_cell_behavior,
            cell_behaviors::set_cell_behavior_enabled,
            cell_behaviors::get_cell_behavior,
            cell_behaviors::get_all_cell_behaviors,
            // Print commands
            commands::get_page_setup,
            commands::set_page_setup,
            commands::get_print_data,
            commands::write_binary_file,
            commands::insert_row_page_break,
            commands::remove_row_page_break,
            commands::insert_col_page_break,
            commands::remove_col_page_break,
            commands::reset_all_page_breaks,
            commands::set_print_area,
            commands::clear_print_area,
            commands::set_print_title_rows,
            commands::clear_print_title_rows,
            commands::set_print_title_cols,
            commands::clear_print_title_cols,
            commands::move_page_break,
            // MCP server commands
            mcp::mcp_start,
            mcp::mcp_stop,
            mcp::mcp_status,
            mcp::mcp_set_port,
            // Linked Sheet commands removed: replaced by .calp distribution system (Phase 2+)
            // Slicer commands
            slicer::create_slicer,
            slicer::delete_slicer,
            object_deps::list_object_dependents,
            slicer::update_slicer,
            slicer::get_slicer,
            slicer::clear_slicer_filter,
            slicer::set_slicer_item_selected,
            slicer::update_slicer_position,
            slicer::update_slicer_selection,
            slicer::get_all_slicers,
            slicer::get_slicers_for_sheet,
            slicer::get_slicer_items,
            slicer::get_slicer_computed_properties,
            slicer::get_slicer_available_attributes,
            slicer::add_slicer_computed_property,
            slicer::update_slicer_computed_property,
            slicer::remove_slicer_computed_property,
            slicer::get_slicer_computed_attributes,
            // Ribbon filter commands
            ribbon_filter::create_ribbon_filter,
            ribbon_filter::delete_ribbon_filter,
            ribbon_filter::update_ribbon_filter,
            ribbon_filter::update_ribbon_filter_selection,
            ribbon_filter::get_all_ribbon_filters,
            ribbon_filter::get_ribbon_filter,
            ribbon_filter::clear_ribbon_filter,
            ribbon_filter::set_ribbon_filter_item_selected,
            // Pane control commands (Controls pane)
            pane_control::create_pane_control,
            pane_control::delete_pane_control,
            pane_control::update_pane_control,
            pane_control::set_pane_control_value,
            pane_control::get_all_pane_controls,
            pane_control::get_pane_control,
            pane_control::get_all_control_values,
            control_values::recalc_control_dependents,
            // Timeline slicer commands
            timeline_slicer::create_timeline_slicer,
            timeline_slicer::delete_timeline_slicer,
            timeline_slicer::update_timeline_slicer,
            timeline_slicer::update_timeline_position,
            timeline_slicer::update_timeline_selection,
            timeline_slicer::update_timeline_connections,
            timeline_slicer::get_all_timeline_slicers,
            timeline_slicer::get_timeline_slicers_for_sheet,
            timeline_slicer::get_timeline_data,
            timeline_slicer::get_timeline_selected_items,
            timeline_slicer::get_pivot_date_fields,
            // Theme commands
            theme_commands::get_document_theme,
            theme_commands::set_document_theme,
            theme_commands::list_builtin_themes,
            theme_commands::get_theme_color_palette,
            // Locale / regional settings
            locale_commands::get_locale_settings,
            locale_commands::set_locale,
            locale_commands::get_supported_locales,
            // Named cell styles commands
            named_styles_cmd::get_named_styles,
            named_styles_cmd::create_named_style,
            named_styles_cmd::delete_named_style,
            named_styles_cmd::apply_named_style,
            named_styles_cmd::apply_named_style_range,
            // Error checking indicators
            error_checking::get_error_indicators,
            // Chart persistence commands
            chart_commands::get_charts,
            chart_commands::save_chart,
            chart_commands::update_chart,
            chart_commands::delete_chart,
            // Sparkline persistence commands
            sparkline_commands::get_sparklines,
            sparkline_commands::save_sparklines,
            sparkline_commands::delete_sparklines,
            sparkline_commands::clear_all_sparklines,
            // JSON View commands (generic object inspection/editing)
            json_view::get_object_json,
            json_view::set_object_json,
            json_view::list_objects,
            json_view::get_workbook_tree,
            // R1C1 reference style commands
            r1c1::get_reference_style,
            r1c1::set_reference_style,
            r1c1::convert_formula_style,
            // Third-party extension loading
            scan_extension_directory,
            get_extensions_directory,
            uninstall_extension,
            extension_install::install_extension,
            extension_audit::list_extension_audit,
            // .calp distribution commands
            calp_commands::calp_publish,
            calp_commands::calp_publish_preview,
            calp_commands::calp_publish_model,
            calp_commands::calp_pull,
            calp_commands::calp_browse_registry,
            // Registry providers (distribution brick 1): saved-registry catalog
            calp_registry::calp_list_registries,
            calp_registry::calp_add_registry,
            calp_registry::calp_remove_registry,
            calp_commands::calp_inspect_package,
            // Package Inspector window (read-only deep inspection)
            calp_inspector::calp_inspector_resolve_location,
            calp_inspector::calp_inspector_overview,
            calp_inspector::calp_inspector_sheet,
            calp_inspector::calp_inspector_scripts,
            calp_inspector::calp_inspector_model,
            calp_inspector::calp_inspector_writeback,
            calp_inspector::calp_inspector_artifact,
            calp_inspector::calp_inspector_verify_artifacts,
            library_commands::library_resolve,
            calp_commands::calp_get_subscriptions,
            calp_commands::calp_get_writeback_rebuild_skips,
            calp_commands::calp_get_package_connection_skips,
            calp_commands::calp_subscription_trust,
            calp_commands::calp_list_trusted_publishers,
            calp_commands::calp_get_package_objects,
            calp_commands::calp_get_overrides,
            calp_commands::calp_revert_override,
            calp_commands::calp_accept_upstream,
            calp_commands::calp_keep_override,
            calp_commands::calp_export_overrides,
            calp_commands::calp_import_overrides,
            calp_commands::calp_refresh_preview,
            calp_commands::calp_refresh_apply,
            calp_commands::calp_reset_subscription,
            calp_commands::calp_detach,
            calp_commands::calp_dev_subscribe,
            calp_commands::calp_dev_refresh,
            calp_commands::calp_rename_cell_id,
            calp_commands::calp_merge_cell_ids,
            calp_commands::calp_next_version,
            calp_commands::calp_get_audit_log,
            calp_commands::calp_set_audit_enabled,
            calp_commands::calp_clear_audit_log,
            calp_commands::calp_get_writeback_regions,
            calp_commands::calp_get_subscriber_identity,
            calp_commands::calp_get_cell_id,
            calp_commands::calp_get_sheet_id,
            calp_commands::calp_get_writeback_draft_regions,
            calp_commands::calp_add_writeback_region,
            calp_commands::calp_remove_writeback_region,
            calp_commands::calp_update_writeback_region,
            calp_commands::calp_save_writeback_draft,
            calp_commands::calp_get_writeback_layer,
            calp_commands::calp_reconcile_writeback,
            calp_commands::calp_submit_region,
            calp_commands::calp_submit_all_regions,
            calp_commands::calp_export_region_submissions_csv,
            calp_commands::calp_export_region_submissions_parquet,
            calp_commands::calp_get_writeback_rollup,
            calp_commands::calp_set_writeback_rollup,
            calp_commands::calp_region_response_status,
            calp_commands::calp_preview_region_submission,
            calp_commands::calp_export_package_html,
            calp_commands::calp_set_submission_state,
            calp_commands::calp_load_region_submissions,
            calp_commands::calp_refresh_data,
            calp_commands::calp_save_data_source_config,
            calp_commands::calp_get_data_sources,
            // Managed appearance policy (advisory org default)
            managed_policy::get_effective_appearance_policy,
            managed_policy::refresh_managed_appearance,
            managed_policy::publish_skin_pack,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Apply the persisted Script Security level (B5) before the app runs, so the
    // user's choice survives relaunch instead of resetting to "prompt".
    scripting::hydrate_security_level(app.handle());

    // Install the handle for the writeback->BI dataset refresh hook, so deep
    // writeback mutation paths (which only see &AppState) can re-provision the
    // BI writeback source without threading an AppHandle everywhere.
    bi::writeback_source::set_app_handle(app.handle().clone());

    // Install the handle the workbook dirty flag announces transitions through.
    // Without it `DirtyFlag` still tracks the flag correctly but emits nothing,
    // and the title-bar asterisk goes back to lagging every backend-only
    // mutation -- the defect this closes. Must be installed BEFORE `app.run`,
    // since a package pull or a script can dirty the document during startup.
    document_effect::install_dirty_announcer(app.handle().clone());

    // Install the handle the undo history announces availability transitions
    // through. Without it `UndoHistory` still tracks the stack correctly but
    // emits nothing, and the Undo/Redo affordances go back to being always
    // enabled -- offering the user an undo that does not exist. Installed
    // BEFORE `app.run` for the same reason as the dirty flag: a package pull or
    // a startup script can push undo entries during startup.
    undo_history::install_undo_announcer(app.handle().clone());

    app.run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // Shut down the MCP server gracefully if running
                if let Some(state) = app_handle.try_state::<mcp::McpState>() {
                    if let Ok(ct) = state.cancel_token.lock() {
                        if let Some(token) = ct.as_ref() {
                            token.cancel();
                        }
                    }
                }

                // Save all BI engine caches to disk before exit
                if let Some(bi_state) = app_handle.try_state::<bi::BiState>() {
                    let saved = bi_state.engine_registry.save_all_caches();
                    if saved > 0 {
                        eprintln!("[BI] Shutdown: saved {} engine cache(s) to disk", saved);
                    }
                }
            }
        });
}
#[cfg(test)]
mod named_function_display_tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    fn make_fn(name: &str, refers_to: &str) -> named_ranges::NamedRange {
        named_ranges::NamedRange {
            name: name.to_string(),
            sheet_index: None,
            refers_to: refers_to.to_string(),
            comment: None,
            folder: Some("_Functions".to_string()),
        }
    }

    /// End-to-end for the reported bug: a named LAMBDA function invoked in a cell
    /// must show as its friendly `Name(args)` call in the formula bar, while the
    /// resolved `__INVOKE__(...)` marker (needed for evaluation and persisted so
    /// dependencies survive reload) lives only behind the raw renderer.
    #[test]
    fn named_function_call_displays_friendly_but_persists_raw() {
        let mut ranges: HashMap<String, named_ranges::NamedRange> = HashMap::new();
        ranges.insert("TEST".to_string(), make_fn("Test", "=LAMBDA(param1, param1*2)"));

        // The parser turns `Test(D4)` into a Custom("TEST") call; resolution
        // rewrites it into the named-invoke marker.
        let parsed = parse_formula("Test(D4)").expect("parse Test(D4)");
        let mut visited = HashSet::new();
        let resolved = resolve_names_in_ast(&parsed, &ranges, 0, &mut visited);

        // Raw form keeps the resolved marker + lambda (round-trips through save).
        let raw = engine::ast_render::render_formula_raw(&resolved);
        assert!(raw.contains("__INVOKE__"), "raw kept marker: {raw}");
        assert!(raw.contains("LAMBDA"), "raw kept lambda: {raw}");

        // Display collapses back to the authored call — no `__INVOKE__` leak.
        let display = engine::ast_render::render_formula(&resolved);
        assert_eq!(display, "Test(D4)");
        assert!(!display.contains("__INVOKE__"));
    }

    /// A multi-parameter named function collapses with all of its arguments.
    #[test]
    fn multi_param_named_function_collapses_with_all_args() {
        let mut ranges: HashMap<String, named_ranges::NamedRange> = HashMap::new();
        ranges.insert("ADD".to_string(), make_fn("Add", "=LAMBDA(a, b, a+b)"));

        let parsed = parse_formula("Add(A1,B2)").expect("parse Add(A1,B2)");
        let mut visited = HashSet::new();
        let resolved = resolve_names_in_ast(&parsed, &ranges, 0, &mut visited);

        assert_eq!(engine::ast_render::render_formula(&resolved), "Add(A1,B2)");
    }
}

