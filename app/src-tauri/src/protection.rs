//! FILENAME: app/src-tauri/src/protection.rs
//! PURPOSE: Sheet and cell protection feature - password protection, locked cells, allow-edit ranges.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::State;

use crate::AppState;

// ============================================================================
// PROTECTION OPTIONS
// ============================================================================

/// Sheet protection options - what users can do when sheet is protected
///
/// `PartialEq` so the save path can tell "author customized the options" from
/// "still the defaults"; do NOT switch the manual `Default` below to a derive —
/// two of its fields default to `true`, not `false`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetProtectionOptions {
    /// Allow users to select locked cells
    pub allow_select_locked_cells: bool,
    /// Allow users to select unlocked cells
    pub allow_select_unlocked_cells: bool,
    /// Allow users to format cells
    pub allow_format_cells: bool,
    /// Allow users to format columns
    pub allow_format_columns: bool,
    /// Allow users to format rows
    pub allow_format_rows: bool,
    /// Allow users to insert columns
    pub allow_insert_columns: bool,
    /// Allow users to insert rows
    pub allow_insert_rows: bool,
    /// Allow users to insert hyperlinks
    pub allow_insert_hyperlinks: bool,
    /// Allow users to delete columns
    pub allow_delete_columns: bool,
    /// Allow users to delete rows
    pub allow_delete_rows: bool,
    /// Allow users to sort
    pub allow_sort: bool,
    /// Allow users to use AutoFilter
    pub allow_auto_filter: bool,
    /// Allow users to use PivotTable reports
    pub allow_pivot_tables: bool,
    /// Allow users to edit objects
    pub allow_edit_objects: bool,
    /// Allow users to edit scenarios
    pub allow_edit_scenarios: bool,
}

impl Default for SheetProtectionOptions {
    fn default() -> Self {
        Self {
            allow_select_locked_cells: true,
            allow_select_unlocked_cells: true,
            allow_format_cells: false,
            allow_format_columns: false,
            allow_format_rows: false,
            allow_insert_columns: false,
            allow_insert_rows: false,
            allow_insert_hyperlinks: false,
            allow_delete_columns: false,
            allow_delete_rows: false,
            allow_sort: false,
            allow_auto_filter: false,
            allow_pivot_tables: false,
            allow_edit_objects: false,
            allow_edit_scenarios: false,
        }
    }
}

// ============================================================================
// ALLOW EDIT RANGE
// ============================================================================

/// A range that can be edited even when the sheet is protected
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllowEditRange {
    /// Unique title/name for this range
    pub title: String,
    /// Start row (0-based)
    pub start_row: u32,
    /// Start column (0-based)
    pub start_col: u32,
    /// End row (0-based, inclusive)
    pub end_row: u32,
    /// End column (0-based, inclusive)
    pub end_col: u32,
    /// Password hash (optional, None = no password required)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password_hash: Option<String>,
    /// Salt for password hashing
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password_salt: Option<String>,
}

impl AllowEditRange {
    /// Check if a cell is within this range
    pub fn contains(&self, row: u32, col: u32) -> bool {
        row >= self.start_row
            && row <= self.end_row
            && col >= self.start_col
            && col <= self.end_col
    }
}

// ============================================================================
// SHEET PROTECTION
// ============================================================================

/// Sheet-level protection settings
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetProtection {
    /// Whether protection is enabled
    pub protected: bool,
    /// Password hash (SHA-256 of password + salt)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password_hash: Option<String>,
    /// Salt for password hashing
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password_salt: Option<String>,
    /// Protection options (what is allowed when protected)
    pub options: SheetProtectionOptions,
    /// Ranges that can be edited even when protected
    pub allow_edit_ranges: Vec<AllowEditRange>,
}

impl Default for SheetProtection {
    fn default() -> Self {
        Self {
            protected: false,
            password_hash: None,
            password_salt: None,
            options: SheetProtectionOptions::default(),
            allow_edit_ranges: Vec::new(),
        }
    }
}

impl SheetProtection {
    /// Check if a cell can be edited (considering protection, cell lock status, and allow-edit ranges)
    pub fn can_edit_cell(&self, row: u32, col: u32, is_cell_locked: bool) -> bool {
        // If not protected, all cells can be edited
        if !self.protected {
            return true;
        }

        // Check if cell is in an allow-edit range
        for range in &self.allow_edit_ranges {
            if range.contains(row, col) {
                return true;
            }
        }

        // Otherwise, only unlocked cells can be edited
        !is_cell_locked
    }

    /// Check if a specific action is allowed when protected
    pub fn is_action_allowed(&self, action: &str) -> bool {
        if !self.protected {
            return true;
        }

        match action {
            "selectLockedCells" => self.options.allow_select_locked_cells,
            "selectUnlockedCells" => self.options.allow_select_unlocked_cells,
            "formatCells" => self.options.allow_format_cells,
            "formatColumns" => self.options.allow_format_columns,
            "formatRows" => self.options.allow_format_rows,
            "insertColumns" => self.options.allow_insert_columns,
            "insertRows" => self.options.allow_insert_rows,
            "insertHyperlinks" => self.options.allow_insert_hyperlinks,
            "deleteColumns" => self.options.allow_delete_columns,
            "deleteRows" => self.options.allow_delete_rows,
            "sort" => self.options.allow_sort,
            "autoFilter" => self.options.allow_auto_filter,
            "pivotTables" => self.options.allow_pivot_tables,
            "editObjects" => self.options.allow_edit_objects,
            "editScenarios" => self.options.allow_edit_scenarios,
            _ => false,
        }
    }
}

// ============================================================================
// CELL PROTECTION
// ============================================================================

/// Cell-level protection properties (stored in style)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CellProtection {
    /// Whether the cell is locked (cannot be edited when sheet is protected)
    /// Default is true (Excel behavior - all cells locked by default)
    pub locked: bool,
    /// Whether the formula is hidden (shows result only when sheet is protected)
    pub formula_hidden: bool,
}

impl CellProtection {
    /// Default cell protection (locked, formula visible)
    pub fn default_locked() -> Self {
        Self {
            locked: true,
            formula_hidden: false,
        }
    }

    /// Unlocked cell protection
    pub fn unlocked() -> Self {
        Self {
            locked: false,
            formula_hidden: false,
        }
    }
}

// ============================================================================
// STORAGE
// ============================================================================

/// Storage: sheet_index -> SheetProtection
pub type ProtectionStorage = HashMap<usize, SheetProtection>;

/// Storage for cell-level protection: sheet_index -> (row, col) -> CellProtection
/// Only stores non-default values (cells that differ from default locked state)

// ============================================================================
// RESULT TYPES
// ============================================================================

/// Result returned from protection commands
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectionResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protection: Option<SheetProtection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ProtectionResult {
    pub fn ok(protection: SheetProtection) -> Self {
        Self {
            success: true,
            protection: Some(protection),
            error: None,
        }
    }

    pub fn ok_empty() -> Self {
        Self {
            success: true,
            protection: None,
            error: None,
        }
    }

    pub fn err(message: impl Into<String>) -> Self {
        Self {
            success: false,
            protection: None,
            error: Some(message.into()),
        }
    }
}

/// Result of checking if an action can be performed
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectionCheckResult {
    pub can_edit: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Protection status summary
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectionStatus {
    pub is_protected: bool,
    pub has_password: bool,
    pub options: SheetProtectionOptions,
    pub allow_edit_range_count: usize,
}

// ============================================================================
// PARAMS
// ============================================================================

/// Parameters for protecting a sheet
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectSheetParams {
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub options: Option<SheetProtectionOptions>,
}

/// Parameters for adding an allow-edit range
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddAllowEditRangeParams {
    pub title: String,
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
    #[serde(default)]
    pub password: Option<String>,
}

/// Parameters for setting cell protection
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCellProtectionParams {
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
    #[serde(default)]
    pub locked: Option<bool>,
    #[serde(default)]
    pub formula_hidden: Option<bool>,
}

// ============================================================================
// PASSWORD HASHING
// ============================================================================

// Argon2id, via the same crate that backs .cala whole-file encryption. This
// used to be `DefaultHasher` (SipHash-1-3, 64-bit, not memory-hard) over a salt
// built from `SystemTime::now().as_nanos()` — the file's own timestamps narrowed
// the salt to a guessable range, and the digest itself was brute-forceable at
// enormous rates. The code's own comment said "in production, use bcrypt or
// argon2"; argon2 was already a dependency one crate over.
//
// See `calcula_crypto::hash_verifier` for why these parameters are deliberately
// lighter than the file-encryption KDF.

/// Hash a protection password under `salt`.
///
/// Returns an empty string if hashing fails, which `verify_password` can never
/// match — a password that could not be hashed must not become a password that
/// anything satisfies.
fn hash_password(password: &str, salt: &str) -> String {
    calcula_crypto::hash_verifier(password, salt).unwrap_or_default()
}

/// Generate a cryptographically random salt.
fn generate_salt() -> String {
    calcula_crypto::generate_verifier_salt()
}

/// Verify a password against a stored hash.
fn verify_password(password: &str, salt: &str, hash: &str) -> bool {
    // An empty stored hash means hashing failed when the password was set;
    // refuse rather than accept anything against it.
    if hash.is_empty() {
        return false;
    }
    calcula_crypto::verify_verifier(password, salt, hash)
}

// ============================================================================
// BACKEND ENFORCEMENT
// ============================================================================
//
// Until this existed, sheet protection was enforced ONLY by a frontend commit
// guard at a single call site — `can_edit_cell` was a Tauri command that no Rust
// write path ever called. Anything that did not go through inline cell editing
// (scripts, MCP tools, sort, fill, cross-sheet writes) wrote straight through a
// protected sheet.
//
// WHICH PATHS ARE EXEMPT, AND WHY. Enforcement belongs on paths that carry a
// USER'S INTENT TO EDIT. These do not, and deliberately do not call the gates
// below — this list is the authoritative record, so a path missing a gate is
// either on this list or is a bug:
//
//   * Undo / redo replay. An undo may legitimately revert an edit that was made
//     BEFORE the sheet was protected; gating it would strand the document in a
//     state the user cannot leave. The mutation being replayed was already
//     gated when it was first made.
//   * File load, auto-recover, and `new_file`. These install a document rather
//     than edit one, and they install the protection record itself.
//   * Recalculation and spill writes. Engine-driven consequences of an edit that
//     was already gated at its own entry point. Gating them would make a
//     protected sheet's formulas stop updating.
//   * `.calp` subscription reset / refresh. The subscriber asked for the
//     publisher's content wholesale; protection on those sheets is the
//     subscriber's own and is re-installed by the reset.
//   * Report writeback. A writeback value reaches the grid through the ordinary
//     edit path (Distribution's commit guard allows the commit and the normal
//     `update_cell` runs), so it is gated there like any other user edit —
//     nothing separate to exempt.
//   * `solver_revert`. The undo of `solver_solve`, restoring values the sheet
//     already held; `solver_solve` is gated, so nothing reaches revert that was
//     not already allowed. Gating it would strand the user with Solver's output
//     if the sheet were protected in between.
//
// Everything else that writes cells on a user's behalf MUST call a gate.

/// Resolve whether one cell is locked.
///
/// Lock state is a CELL FORMAT attribute, resolved through the row/column style
/// tiers exactly like any other formatting — `Grid::effective_style_index`
/// applies cell > row > column > default. That is what lets a whole column be
/// unlocked with ONE entry instead of a materialized cell per row.
///
/// "Absence means locked" survives in two forms, and both land on the same
/// answer because `engine::CellStyle::default()` has `locked: true`: a cell that is not
/// in the grid at all, and a cell whose style_index is 0 with no tier above it.
pub(crate) fn cell_is_locked(
    grid: &engine::Grid,
    styles: &engine::StyleRegistry,
    row: u32,
    col: u32,
) -> bool {
    styles.get(grid.effective_style_index(row, col)).locked
}

/// Whether this cell's FORMULA must be withheld.
///
/// `formula_hidden` is the second half of Excel's cell protection, and it only
/// bites while the sheet is protected. It was stored, persisted and round-tripped
/// through xlsx but enforced nowhere: the formula bar blanked it for display,
/// while `get_cell` happily returned the formula string over IPC — so any script,
/// AI tool or extension read it straight out. Display-blanking is not hiding.
///
/// Takes borrowed state for the same reason the gates do: callers hold the grid.
pub(crate) fn formula_is_hidden(
    protection_storage: &ProtectionStorage,
    grid: &engine::Grid,
    styles: &engine::StyleRegistry,
    sheet_index: usize,
    row: u32,
    col: u32,
) -> bool {
    let Some(protection) = protection_storage.get(&sheet_index) else {
        return false;
    };
    if !protection.protected {
        return false;
    }
    styles.get(grid.effective_style_index(row, col)).formula_hidden
}

/// `AppState` form of [`formula_is_hidden`] for callers holding no locks.
///
/// Returns a closure-friendly snapshot: whether the sheet is protected at all,
/// so a caller reading many cells pays the lock cost once.
pub(crate) fn sheet_is_protected(state: &AppState, sheet_index: usize) -> bool {
    state
        .sheet_protection
        .lock()
        .ok()
        .and_then(|p| p.get(&sheet_index).map(|s| s.protected))
        .unwrap_or(false)
}

/// The single decision procedure for "may this cell be written?".
///
/// Both the `can_edit_cell` command and the backend gates below route through
/// this, so the frontend's answer and the backend's answer cannot drift.
/// Returns `None` when the write is allowed, or `Some(reason)` when refused.
///
/// Takes the grid BORROWED rather than reaching into `AppState`: several
/// callers (find/replace, the script apply path) already hold the grid and the
/// style registry when they gate, and `std::sync::Mutex` is not reentrant.
pub(crate) fn refusal_reason_for_cell(
    protection_storage: &ProtectionStorage,
    grid: &engine::Grid,
    styles: &engine::StyleRegistry,
    sheet_index: usize,
    row: u32,
    col: u32,
) -> Option<String> {
    let protection = protection_storage.get(&sheet_index)?;
    if !protection.protected {
        return None;
    }
    let locked = cell_is_locked(grid, styles, row, col);
    if protection.can_edit_cell(row, col, locked) {
        None
    } else {
        // Full sentence, not "Cell is locked". The frontend guard does
        // `result.reason || <long fallback>`, so a terse reason is always
        // truthy and permanently shadows the friendly message the warning
        // dialog was written for — users only ever saw the two-word string.
        Some(protection_error(row, col))
    }
}

/// Human-facing refusal text. This string IS the UX on every path that surfaces
/// a Tauri rejection, so it names the cell and says how to proceed.
fn protection_error(row: u32, col: u32) -> String {
    format!(
        "Cannot change cell {}{}: it is locked on a protected sheet. \
         Unprotect the sheet to edit it (Review > Unprotect Sheet).",
        crate::pivot::utils::col_index_to_letter(col),
        row + 1
    )
}

/// Reject a write when ANY target cell is locked on a protected sheet.
///
/// Mirrors `check_region_cells_protection` in `commands::data` — same shape,
/// same early-out, so the two protection families read alike at call sites.
/// Takes an explicit `sheet_index`: unlike the `can_edit_cell` command, many
/// backend writers target a sheet other than the active one.
/// Pure form: decide against ALREADY-BORROWED state.
///
/// Exists because the gate now needs the grid and the style registry, and
/// several callers hold one or both when they gate — find/replace holds
/// `grid` + `style_registry`, the script apply path holds `grids`. A wrapper
/// that re-locked those would self-deadlock (`std::sync::Mutex` is not
/// reentrant), so those callers pass their borrows straight through.
pub(crate) fn check_sheet_protection_cells_in<'a>(
    protection_storage: &ProtectionStorage,
    grid: &engine::Grid,
    styles: &engine::StyleRegistry,
    sheet_index: usize,
    mut cells: impl Iterator<Item = (u32, u32)> + 'a,
) -> Result<(), String> {
    match protection_storage.get(&sheet_index) {
        Some(p) if p.protected => {}
        _ => return Ok(()),
    }
    if let Some((row, col)) = cells.find(|(row, col)| {
        refusal_reason_for_cell(protection_storage, grid, styles, sheet_index, *row, *col).is_some()
    }) {
        return Err(protection_error(row, col));
    }
    Ok(())
}

/// Reject a write when ANY target cell is locked on a protected sheet.
///
/// Mirrors `check_region_cells_protection` in `commands::data` — same shape,
/// same early-out, so the two protection families read alike at call sites.
/// Takes an explicit `sheet_index`: unlike the `can_edit_cell` command, many
/// backend writers target a sheet other than the active one.
///
/// LOCK ORDER. The dominant order across the app's commands is
/// `grid -> grids -> style_registry -> ...`, and callers that hold the grid
/// while gating take `sheet_protection` AFTER `style_registry`. This wrapper
/// must not invert that, or two threads deadlock: one holding the grid waiting
/// on protection, one holding protection waiting on the grid. So the cheap
/// "is this sheet even protected?" probe takes `sheet_protection` in a scope
/// that RELEASES it, and the real check then acquires in canonical order.
pub(crate) fn check_sheet_protection_cells<'a>(
    state: &AppState,
    sheet_index: usize,
    cells: impl Iterator<Item = (u32, u32)> + 'a,
) -> Result<(), String> {
    // Probe and release. The overwhelmingly common case is an unprotected
    // sheet, and this runs on every batch write — not worth locking the grid.
    let protected = {
        let p = state.sheet_protection.lock().unwrap();
        p.get(&sheet_index).map(|s| s.protected).unwrap_or(false)
    };
    if !protected {
        return Ok(());
    }

    let active_sheet = *state.active_sheet.lock().unwrap();
    // `state.grid` is the authoritative mirror for the ACTIVE sheet;
    // `grids[active_sheet]` is documented as stale.
    if sheet_index == active_sheet {
        let grid = state.grid.lock().unwrap();
        let styles = state.style_registry.lock().unwrap();
        let protection_storage = state.sheet_protection.lock().unwrap();
        check_sheet_protection_cells_in(&protection_storage, &grid, &styles, sheet_index, cells)
    } else {
        let grids = state.grids.lock().unwrap();
        let styles = state.style_registry.lock().unwrap();
        let protection_storage = state.sheet_protection.lock().unwrap();
        let Some(grid) = grids.get(sheet_index) else {
            return Ok(());
        };
        check_sheet_protection_cells_in(&protection_storage, grid, &styles, sheet_index, cells)
    }
}

/// Range form of [`check_sheet_protection_cells`].
///
/// Deliberately does NOT enumerate the rectangle in the common case. A whole-
/// column Delete is 1,048,576 cells and a select-all clear is far more; walking
/// that product under three global mutexes would freeze the app on exactly the
/// gestures users reach for.
///
/// The reason it can avoid that: on a protected sheet the DEFAULT is locked
/// (`engine::CellStyle::default().locked == true`, and index 0 is the default style).
/// So a position is writable only if something positively grants it — an
/// allow-edit range, an unlocked column tier, an unlocked row tier, or the
/// cell's own unlocked style. Everything else is locked, which means finding a
/// refusal is a matter of finding ONE position nothing grants.
pub(crate) fn check_sheet_protection_range(
    state: &AppState,
    sheet_index: usize,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> Result<(), String> {
    // Probe and release, then acquire in canonical order — see the lock-order
    // note on `check_sheet_protection_cells`.
    let protected = {
        let p = state.sheet_protection.lock().unwrap();
        p.get(&sheet_index).map(|s| s.protected).unwrap_or(false)
    };
    if !protected {
        return Ok(());
    }

    let active_sheet = *state.active_sheet.lock().unwrap();
    if sheet_index == active_sheet {
        let grid = state.grid.lock().unwrap();
        let styles = state.style_registry.lock().unwrap();
        let protection_storage = state.sheet_protection.lock().unwrap();
        check_sheet_protection_range_in(
            &protection_storage, &grid, &styles, sheet_index,
            start_row, start_col, end_row, end_col,
        )
    } else {
        let grids = state.grids.lock().unwrap();
        let styles = state.style_registry.lock().unwrap();
        let protection_storage = state.sheet_protection.lock().unwrap();
        let Some(grid) = grids.get(sheet_index) else {
            return Ok(());
        };
        check_sheet_protection_range_in(
            &protection_storage, grid, &styles, sheet_index,
            start_row, start_col, end_row, end_col,
        )
    }
}

/// Pure form of [`check_sheet_protection_range`], over borrowed state.
pub(crate) fn check_sheet_protection_range_in(
    protection_storage: &ProtectionStorage,
    grid: &engine::Grid,
    styles: &engine::StyleRegistry,
    sheet_index: usize,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> Result<(), String> {
    let protection = match protection_storage.get(&sheet_index) {
        Some(p) if p.protected => p,
        _ => return Ok(()),
    };

    let in_allow_range = |row: u32, col: u32| {
        protection.allow_edit_ranges.iter().any(|r| r.contains(row, col))
    };
    let tier_unlocked = |idx: usize| idx != 0 && !styles.get(idx).locked;

    // FAST PATH 1 — every column in the rectangle carries an unlocked column
    // tier. This is the case the whole tier design exists for: "unlock the input
    // column, then protect the sheet". O(columns), so a whole-column selection
    // costs ONE probe rather than a million.
    let all_cols_unlocked = (start_col..=end_col)
        .all(|c| grid.column_styles.get(&c).copied().is_some_and(tier_unlocked));

    // FAST PATH 2 — same for rows. Guarded by a row count, because evaluating it
    // for a tall rectangle would itself be the walk we are avoiding.
    let row_span = end_row.saturating_sub(start_row) as u64 + 1;
    let all_rows_unlocked = row_span <= 4096
        && (start_row..=end_row)
            .all(|r| grid.row_styles.get(&r).copied().is_some_and(tier_unlocked));

    if all_cols_unlocked || all_rows_unlocked {
        // The background grants every position. Only a cell with its OWN locked
        // style can still refuse, and those are sparse — scan the populated
        // cells, not the rectangle.
        if let Some((&(row, col), _)) = grid.cells.iter().find(|(&(r, c), cell)| {
            r >= start_row && r <= end_row && c >= start_col && c <= end_col
                && cell.style_index != 0
                && styles.get(cell.style_index).locked
                && !in_allow_range(r, c)
        }) {
            return Err(protection_error(row, col));
        }
        return Ok(());
    }

    // Otherwise SOME position has no tier granting it, so the default (locked)
    // applies there unless an allow-edit range or the cell's own style grants
    // it. Find the first such position. On a protected sheet this is almost
    // always the very first cell examined, because "locked" is the default —
    // the scan only runs long when the author has unlocked a lot of individual
    // cells, i.e. it is bounded by real authored data rather than by the
    // address space.
    for row in start_row..=end_row {
        for col in start_col..=end_col {
            if refusal_reason_for_cell(protection_storage, grid, styles, sheet_index, row, col)
                .is_some()
            {
                return Err(protection_error(row, col));
            }
        }
    }
    Ok(())
}

/// Reject an ACTION that a protected sheet's options disallow.
///
/// The per-cell gates above answer "may this cell be written?". This answers the
/// second, independent question Excel asks: "is this KIND of operation allowed
/// at all while the sheet is protected?" — sorting, inserting rows, formatting,
/// and so on. The two are additive: an operation must pass both.
///
/// `action` uses the same names as `SheetProtection::is_action_allowed`, which
/// is the single mapping from option flag to action.
pub(crate) fn check_sheet_action(
    state: &AppState,
    sheet_index: usize,
    action: &str,
    what: &str,
) -> Result<(), String> {
    let protection_storage = state.sheet_protection.lock().unwrap();
    let Some(protection) = protection_storage.get(&sheet_index) else {
        return Ok(());
    };
    if protection.is_action_allowed(action) {
        return Ok(());
    }
    Err(format!(
        "Cannot {} on a protected sheet. Unprotect the sheet first \
         (Review > Unprotect Sheet), or allow it in the protection options.",
        what
    ))
}

/// Reject a change to the PROTECTION SETTINGS of a sheet that is protected.
///
/// This closes the hole that made write enforcement pointless: until now
/// `update_protection_options`, `add_allow_edit_range`, `remove_allow_edit_range`
/// and `set_cell_protection` took no password and never checked `protected`, so
/// anything that could reach them — including any script or MCP tool — could
/// unlock every cell of a password-protected sheet and then edit freely.
///
/// Excel's rule, which this follows: protection settings are not editable while
/// the sheet is protected. Unprotect first (which DOES verify the password),
/// change the settings, protect again. That keeps the password check in exactly
/// one place instead of threading a password through every settings command.
fn require_sheet_unprotected(state: &AppState, sheet_index: usize, what: &str) -> Result<(), String> {
    let protection_storage = state.sheet_protection.lock().unwrap();
    match protection_storage.get(&sheet_index) {
        Some(p) if p.protected => Err(format!(
            "Cannot change {} while the sheet is protected. \
             Unprotect the sheet first (Review > Unprotect Sheet).",
            what
        )),
        _ => Ok(()),
    }
}

// ============================================================================
// COMMANDS
// ============================================================================

/// Record undo for a sheet-protection mutation and mark the workbook dirty.
///
/// Every mutating command here goes through this. Before it existed, protection
/// was neither undoable nor dirty-marking: Ctrl+Z could not take a protect back,
/// and protecting a sheet on an otherwise-clean document was silently discarded
/// at close (the close prompt and auto-recover both gate on `is_modified`).
///
/// MUST be called after the `sheet_protection` guard is dropped — this takes the
/// undo-stack lock, and holding both invites a lock-order inversion with the
/// restore path, which takes the store lock while replaying.
fn record_protection_undo(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    sheet_index: usize,
    previous: Option<SheetProtection>,
    description: &str,
) {
    crate::undo_commands::record_sheet_protection_record_undo(
        state,
        sheet_index,
        previous,
        description,
    );
    crate::persistence::mark_workbook_modified(file_state);
}

/// Protect the current sheet
#[tauri::command]
pub fn protect_sheet(
    state: State<AppState>,
    file_state: State<crate::persistence::FileState>,
    params: ProtectSheetParams,
) -> ProtectionResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut protection_storage = state.sheet_protection.lock().unwrap();

    // Capture the record as it stands BEFORE any mutation, including its
    // absence, so undo can put the sheet back exactly as it was.
    let previous = protection_storage.get(&active_sheet).cloned();

    let mut protection = previous.clone().unwrap_or_default();

    // Already protected?
    if protection.protected {
        return ProtectionResult::err("Sheet is already protected");
    }

    protection.protected = true;

    // Set password if provided
    if let Some(password) = params.password {
        if !password.is_empty() {
            let salt = generate_salt();
            protection.password_hash = Some(hash_password(&password, &salt));
            protection.password_salt = Some(salt);
        }
    }

    // Apply options if provided
    if let Some(options) = params.options {
        protection.options = options;
    }

    protection_storage.insert(active_sheet, protection.clone());
    drop(protection_storage);

    record_protection_undo(&state, &file_state, active_sheet, previous, "Protect sheet");
    ProtectionResult::ok(protection)
}

/// Unprotect the current sheet
#[tauri::command]
pub fn unprotect_sheet(
    state: State<AppState>,
    file_state: State<crate::persistence::FileState>,
    password: Option<String>,
) -> ProtectionResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut protection_storage = state.sheet_protection.lock().unwrap();

    let protection = match protection_storage.get(&active_sheet) {
        Some(p) => p.clone(),
        None => return ProtectionResult::err("Sheet is not protected"),
    };

    if !protection.protected {
        return ProtectionResult::err("Sheet is not protected");
    }

    // Check password if required
    if let (Some(hash), Some(salt)) = (&protection.password_hash, &protection.password_salt) {
        let provided = password.unwrap_or_default();
        if !verify_password(&provided, salt, hash) {
            return ProtectionResult::err("Incorrect password");
        }
    }

    // Remove protection. The allow-edit ranges are deliberately kept — Excel
    // reuses them when the sheet is protected again, and the save path now
    // persists an unprotected record that still carries them.
    let mut new_protection = protection.clone();
    new_protection.protected = false;
    new_protection.password_hash = None;
    new_protection.password_salt = None;

    protection_storage.insert(active_sheet, new_protection.clone());
    drop(protection_storage);

    record_protection_undo(
        &state,
        &file_state,
        active_sheet,
        Some(protection),
        "Unprotect sheet",
    );
    ProtectionResult::ok(new_protection)
}

/// Update protection options for the current sheet
#[tauri::command]
pub fn update_protection_options(
    state: State<AppState>,
    file_state: State<crate::persistence::FileState>,
    options: SheetProtectionOptions,
) -> ProtectionResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    if let Err(e) = require_sheet_unprotected(&state, active_sheet, "protection options") {
        return ProtectionResult::err(&e);
    }

    let mut protection_storage = state.sheet_protection.lock().unwrap();

    let previous = protection_storage.get(&active_sheet).cloned();

    let protection = protection_storage
        .entry(active_sheet)
        .or_insert_with(SheetProtection::default);

    protection.options = options;
    let updated = protection.clone();
    drop(protection_storage);

    record_protection_undo(
        &state,
        &file_state,
        active_sheet,
        previous,
        "Change protection options",
    );
    ProtectionResult::ok(updated)
}

/// Add an allow-edit range to the current sheet
#[tauri::command]
pub fn add_allow_edit_range(
    state: State<AppState>,
    file_state: State<crate::persistence::FileState>,
    params: AddAllowEditRangeParams,
) -> ProtectionResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    // An allow-edit range is a hole in the protection boundary. Punching one
    // while the sheet is protected would let anything that can reach this
    // command open up the whole sheet without the password.
    if let Err(e) = require_sheet_unprotected(&state, active_sheet, "allow-edit ranges") {
        return ProtectionResult::err(&e);
    }

    let mut protection_storage = state.sheet_protection.lock().unwrap();

    let previous = protection_storage.get(&active_sheet).cloned();

    // Validate BEFORE `entry()`: the duplicate-title check used to run after it,
    // so a rejected add still left a freshly inserted default record behind —
    // with no undo entry, since the error path returns before recording.
    if let Some(existing) = protection_storage.get(&active_sheet) {
        if existing.allow_edit_ranges.iter().any(|r| r.title == params.title) {
            return ProtectionResult::err("A range with this title already exists");
        }
    }

    let protection = protection_storage
        .entry(active_sheet)
        .or_insert_with(SheetProtection::default);

    let mut range = AllowEditRange {
        title: params.title,
        start_row: params.start_row.min(params.end_row),
        start_col: params.start_col.min(params.end_col),
        end_row: params.start_row.max(params.end_row),
        end_col: params.start_col.max(params.end_col),
        password_hash: None,
        password_salt: None,
    };

    // Set password if provided
    if let Some(password) = params.password {
        if !password.is_empty() {
            let salt = generate_salt();
            range.password_hash = Some(hash_password(&password, &salt));
            range.password_salt = Some(salt);
        }
    }

    protection.allow_edit_ranges.push(range);
    let updated = protection.clone();
    drop(protection_storage);

    record_protection_undo(
        &state,
        &file_state,
        active_sheet,
        previous,
        "Add allow-edit range",
    );
    ProtectionResult::ok(updated)
}

/// Remove an allow-edit range by title
#[tauri::command]
pub fn remove_allow_edit_range(
    state: State<AppState>,
    file_state: State<crate::persistence::FileState>,
    title: String,
) -> ProtectionResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    if let Err(e) = require_sheet_unprotected(&state, active_sheet, "allow-edit ranges") {
        return ProtectionResult::err(&e);
    }

    let mut protection_storage = state.sheet_protection.lock().unwrap();

    let protection = match protection_storage.get_mut(&active_sheet) {
        Some(p) => p,
        None => return ProtectionResult::err("No protection settings for this sheet"),
    };

    let previous = protection.clone();
    let initial_len = protection.allow_edit_ranges.len();
    protection.allow_edit_ranges.retain(|r| r.title != title);

    if protection.allow_edit_ranges.len() == initial_len {
        return ProtectionResult::err("Range not found");
    }

    let updated = protection.clone();
    drop(protection_storage);

    record_protection_undo(
        &state,
        &file_state,
        active_sheet,
        Some(previous),
        "Remove allow-edit range",
    );
    ProtectionResult::ok(updated)
}

/// Get all allow-edit ranges for the current sheet
#[tauri::command]
pub fn get_allow_edit_ranges(state: State<AppState>) -> Vec<AllowEditRange> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let protection_storage = state.sheet_protection.lock().unwrap();

    protection_storage
        .get(&active_sheet)
        .map(|p| p.allow_edit_ranges.clone())
        .unwrap_or_default()
}

/// Get protection status for the current sheet
#[tauri::command]
pub fn get_protection_status(state: State<AppState>) -> ProtectionStatus {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let protection_storage = state.sheet_protection.lock().unwrap();

    let protection = protection_storage.get(&active_sheet);

    match protection {
        Some(p) => ProtectionStatus {
            is_protected: p.protected,
            has_password: p.password_hash.is_some(),
            options: p.options.clone(),
            allow_edit_range_count: p.allow_edit_ranges.len(),
        },
        None => ProtectionStatus {
            is_protected: false,
            has_password: false,
            options: SheetProtectionOptions::default(),
            allow_edit_range_count: 0,
        },
    }
}

/// Check if the current sheet is protected
#[tauri::command]
pub fn is_sheet_protected(state: State<AppState>) -> bool {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let protection_storage = state.sheet_protection.lock().unwrap();

    protection_storage
        .get(&active_sheet)
        .map(|p| p.protected)
        .unwrap_or(false)
}

/// Check if a specific cell can be edited
#[tauri::command]
pub fn can_edit_cell(
    state: State<AppState>,
    row: u32,
    col: u32,
) -> ProtectionCheckResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    // Canonical order: grid -> style_registry -> sheet_protection. See the
    // lock-order note on `check_sheet_protection_cells`.
    let grid = state.grid.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let protection_storage = state.sheet_protection.lock().unwrap();

    // Routed through the SAME decision procedure the backend gates use, so the
    // frontend's answer and the backend's answer cannot drift. This used to be a
    // second inline copy of the rule.
    match refusal_reason_for_cell(
        &protection_storage,
        &grid,
        &styles,
        active_sheet,
        row,
        col,
    ) {
        Some(reason) => ProtectionCheckResult {
            can_edit: false,
            reason: Some(reason),
        },
        None => ProtectionCheckResult {
            can_edit: true,
            reason: None,
        },
    }
}

/// Check if a specific action can be performed
#[tauri::command]
pub fn can_perform_action(
    state: State<AppState>,
    action: String,
) -> ProtectionCheckResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let protection_storage = state.sheet_protection.lock().unwrap();

    let protection = match protection_storage.get(&active_sheet) {
        Some(p) => p,
        None => {
            return ProtectionCheckResult {
                can_edit: true,
                reason: None,
            };
        }
    };

    if protection.is_action_allowed(&action) {
        ProtectionCheckResult {
            can_edit: true,
            reason: None,
        }
    } else {
        ProtectionCheckResult {
            can_edit: false,
            reason: Some(format!("Action '{}' is not allowed when sheet is protected", action)),
        }
    }
}

/// Set cell protection for a range
#[tauri::command]
pub fn set_cell_protection(
    state: State<AppState>,
    file_state: State<crate::persistence::FileState>,
    params: SetCellProtectionParams,
) -> ProtectionResult {
    let active_sheet = *state.active_sheet.lock().unwrap();

    let min_row = params.start_row.min(params.end_row);
    let max_row = params.start_row.max(params.end_row);
    let min_col = params.start_col.min(params.end_col);
    let max_col = params.start_col.max(params.end_col);

    // Lock state is now a CELL FORMAT attribute, so this command applies a style
    // delta rather than writing a side map — the same thing `apply_formatting`
    // does, and the reason Format Painter and Paste-Formats carry protection for
    // free.
    //
    // WHOLE-COLUMN / WHOLE-ROW selections take the tier instead of per-cell
    // styles. "Unlock the input column, then protect the sheet" is the canonical
    // Excel workflow, and doing it per cell would materialize 1,048,576 cells,
    // push max_row to the sheet limit and persist all of it.
    // Excel's sheet limits. A selection reaching the last row/column from 0 is
    // a whole-column / whole-row selection, which is how the grid reports
    // clicking a column or row header.
    const MAX_ROW_INDEX: u32 = 1_048_575;
    const MAX_COL_INDEX: u32 = 16_383;
    let whole_columns = min_row == 0 && max_row >= MAX_ROW_INDEX;
    let whole_rows = min_col == 0 && max_col >= MAX_COL_INDEX;

    // PASS 1 — decide, without mutating.
    //
    // Touch a cell ONLY when its effective protection actually changes. Format
    // Cells sends this command on every OK, whether or not the user opened the
    // Protection tab, so the common case is a call that changes nothing: a blind
    // write would push a second, invisible undo step onto every Ctrl+1 (the
    // first Ctrl+Z appearing to do nothing) and dirty a clean workbook.
    let apply_delta = |style: &engine::CellStyle| {
        let mut next = style.clone();
        if let Some(locked) = params.locked {
            next.locked = locked;
        }
        if let Some(hidden) = params.formula_hidden {
            next.formula_hidden = hidden;
        }
        next
    };

    enum Plan {
        /// (col_or_row_index, new_style)
        Tier(Vec<(u32, engine::CellStyle)>, bool /* is_column */),
        /// ((row, col), new_style)
        Cells(Vec<((u32, u32), engine::CellStyle)>),
    }

    let plan = {
        let grid = state.grid.lock().unwrap();
        let styles = state.style_registry.lock().unwrap();

        if whole_columns || whole_rows {
            let is_column = whole_columns;
            let range: Vec<u32> = if is_column {
                (min_col..=max_col).collect()
            } else {
                (min_row..=max_row).collect()
            };
            let mut changes = Vec::new();
            for idx in range {
                let current_idx = if is_column {
                    grid.column_styles.get(&idx).copied().unwrap_or(0)
                } else {
                    grid.row_styles.get(&idx).copied().unwrap_or(0)
                };
                let current = styles.get(current_idx);
                let next = apply_delta(current);
                if &next != current {
                    changes.push((idx, next));
                }
            }
            Plan::Tier(changes, is_column)
        } else {
            let mut changes = Vec::new();
            for row in min_row..=max_row {
                for col in min_col..=max_col {
                    let current = styles.get(grid.effective_style_index(row, col));
                    let next = apply_delta(current);
                    if &next != current {
                        changes.push(((row, col), next));
                    }
                }
            }
            Plan::Cells(changes)
        }
    };

    let nothing_to_do = match &plan {
        Plan::Tier(v, _) => v.is_empty(),
        Plan::Cells(v) => v.is_empty(),
    };
    if nothing_to_do {
        return ProtectionResult::ok_empty();
    }

    // Gate only a REAL change, and gate before touching anything — deciding
    // first means a refusal needs no rollback. Excel greys out the Protection
    // tab on a protected sheet rather than failing the whole dialog, so a no-op
    // call (the Format Cells case above) is still accepted.
    if let Err(e) = require_sheet_unprotected(&state, active_sheet, "cell locking") {
        return ProtectionResult::err(&e);
    }

    // PASS 2 — apply.
    {
        let mut grid = state.grid.lock().unwrap();
        let mut grids = state.grids.lock().unwrap();
        let mut styles = state.style_registry.lock().unwrap();
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.begin_transaction("Change cell protection".to_string());

        match plan {
            Plan::Tier(changes, is_column) => {
                for (idx, style) in changes {
                    let style_index = styles.get_or_create(style);
                    // BOTH mirrors: `state.grid` is authoritative for the active
                    // sheet, but several read paths resolve tiers against
                    // `grids[active_sheet]`. Letting them diverge would make the
                    // tier invisible to those readers.
                    if is_column {
                        grid.set_column_style(idx, style_index);
                        if active_sheet < grids.len() {
                            grids[active_sheet].set_column_style(idx, style_index);
                        }
                    } else {
                        grid.set_row_style(idx, style_index);
                        if active_sheet < grids.len() {
                            grids[active_sheet].set_row_style(idx, style_index);
                        }
                    }
                }
            }
            Plan::Cells(changes) => {
                for ((row, col), style) in changes {
                    // EXPLICIT: a per-cell protection change must never land on
                    // index 0, which a cell reads as "inherit". Otherwise
                    // re-locking one cell inside a tier-unlocked column would
                    // resolve straight back to the unlocked tier.
                    let style_index = styles.get_or_create_explicit(style);
                    let previous_cell = grid.get_cell(row, col).cloned();
                    let mut cell = previous_cell.clone().unwrap_or_else(|| engine::Cell {
                        value: engine::CellValue::Empty,
                        ast: None,
                        style_index: 0,
                        rich_text: None,
                    });
                    cell.style_index = style_index;
                    grid.set_cell(row, col, cell.clone());
                    if active_sheet < grids.len() {
                        grids[active_sheet].set_cell(row, col, cell);
                    }
                    undo_stack.record_cell_change(row, col, previous_cell);
                }
            }
        }

        undo_stack.commit_transaction();
    }

    crate::persistence::mark_workbook_modified(&file_state);

    ProtectionResult::ok_empty()
}

/// Get cell protection for a specific cell
#[tauri::command]
pub fn get_cell_protection(
    state: State<AppState>,
    row: u32,
    col: u32,
) -> CellProtection {
    let grid = state.grid.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();

    // Lock state is a cell FORMAT attribute, resolved through the row/column
    // style tiers. A cell that is absent, or whose style_index is 0 with no
    // tier above it, resolves to the default style — which is locked.
    let style = styles.get(grid.effective_style_index(row, col));
    CellProtection {
        locked: style.locked,
        formula_hidden: style.formula_hidden,
    }
}

/// Verify password for an allow-edit range
#[tauri::command]
pub fn verify_edit_range_password(
    state: State<AppState>,
    title: String,
    password: String,
) -> bool {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let protection_storage = state.sheet_protection.lock().unwrap();

    let protection = match protection_storage.get(&active_sheet) {
        Some(p) => p,
        None => return false,
    };

    let range = match protection.allow_edit_ranges.iter().find(|r| r.title == title) {
        Some(r) => r,
        None => return false,
    };

    // If no password is set, any password works
    if range.password_hash.is_none() {
        return true;
    }

    if let (Some(hash), Some(salt)) = (&range.password_hash, &range.password_salt) {
        verify_password(&password, salt, hash)
    } else {
        true
    }
}

/// Get sheet protection settings (for internal use)
pub fn get_sheet_protection(
    protection_storage: &ProtectionStorage,
    sheet_index: usize,
) -> Option<&SheetProtection> {
    protection_storage.get(&sheet_index)
}

// ============================================================================
// WORKBOOK PROTECTION
// ============================================================================

/// Workbook-level structural protection (prevents adding/deleting/renaming/moving sheets)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookProtection {
    /// Whether workbook structure protection is enabled
    pub protected: bool,
    /// Password hash (SHA-256 of password + salt)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password_hash: Option<String>,
    /// Salt for password hashing
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password_salt: Option<String>,
}

impl Default for WorkbookProtection {
    fn default() -> Self {
        Self {
            protected: false,
            password_hash: None,
            password_salt: None,
        }
    }
}

/// Result of a workbook protection operation
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookProtectionResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl WorkbookProtectionResult {
    pub fn ok() -> Self {
        Self {
            success: true,
            error: None,
        }
    }

    pub fn err(message: impl Into<String>) -> Self {
        Self {
            success: false,
            error: Some(message.into()),
        }
    }
}

/// Workbook protection status summary
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookProtectionStatus {
    pub is_protected: bool,
    pub has_password: bool,
}

// ============================================================================
// WORKBOOK PROTECTION COMMANDS
// ============================================================================

/// Record undo for a workbook-protection mutation and mark the workbook dirty.
///
/// The workbook-level twin of [`record_protection_undo`]. `WorkbookProtection`
/// is persisted by `collect_protection_for_save` and restored by `load_file`,
/// so it had the same two gaps as the sheet-level commands: not undoable, and
/// silently discarded at close on an otherwise-clean document.
///
/// MUST be called after the `workbook_protection` guard is dropped.
fn record_workbook_protection_undo(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    previous: WorkbookProtection,
    description: &str,
) {
    crate::undo_commands::record_workbook_protection_undo(state, previous, description);
    crate::persistence::mark_workbook_modified(file_state);
}

/// Protect the workbook structure
#[tauri::command]
pub fn protect_workbook(
    state: State<AppState>,
    file_state: State<crate::persistence::FileState>,
    password: Option<String>,
) -> WorkbookProtectionResult {
    let mut wb_protection = state.workbook_protection.lock().unwrap();

    if wb_protection.protected {
        return WorkbookProtectionResult::err("Workbook is already protected");
    }

    let previous = wb_protection.clone();
    wb_protection.protected = true;

    if let Some(pwd) = password {
        if !pwd.is_empty() {
            let salt = generate_salt();
            wb_protection.password_hash = Some(hash_password(&pwd, &salt));
            wb_protection.password_salt = Some(salt);
        }
    }
    drop(wb_protection);

    record_workbook_protection_undo(&state, &file_state, previous, "Protect workbook");
    WorkbookProtectionResult::ok()
}

/// Unprotect the workbook structure
#[tauri::command]
pub fn unprotect_workbook(
    state: State<AppState>,
    file_state: State<crate::persistence::FileState>,
    password: Option<String>,
) -> WorkbookProtectionResult {
    let mut wb_protection = state.workbook_protection.lock().unwrap();

    if !wb_protection.protected {
        return WorkbookProtectionResult::err("Workbook is not protected");
    }

    // Check password if required
    if let (Some(hash), Some(salt)) = (&wb_protection.password_hash, &wb_protection.password_salt) {
        let provided = password.unwrap_or_default();
        if !verify_password(&provided, salt, hash) {
            return WorkbookProtectionResult::err("Incorrect password");
        }
    }

    let previous = wb_protection.clone();
    wb_protection.protected = false;
    wb_protection.password_hash = None;
    wb_protection.password_salt = None;
    drop(wb_protection);

    record_workbook_protection_undo(&state, &file_state, previous, "Unprotect workbook");
    WorkbookProtectionResult::ok()
}

/// Check if the workbook is protected
#[tauri::command]
pub fn is_workbook_protected(state: State<AppState>) -> bool {
    state.workbook_protection.lock().unwrap().protected
}

/// Get workbook protection status
#[tauri::command]
pub fn get_workbook_protection_status(state: State<AppState>) -> WorkbookProtectionStatus {
    let wb_protection = state.workbook_protection.lock().unwrap();
    WorkbookProtectionStatus {
        is_protected: wb_protection.protected,
        has_password: wb_protection.password_hash.is_some(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Allow-edit ranges through a structural edit ---
    //
    // These pin the SECURITY property of the shift in commands/structure.rs:
    // an allow-edit range is an exception carved out of protection, so drift
    // must never leave a stale rectangle keeping unintended cells writable.

    fn protected_with(ranges: Vec<AllowEditRange>) -> SheetProtection {
        SheetProtection {
            protected: true,
            allow_edit_ranges: ranges,
            ..Default::default()
        }
    }

    fn range(start_row: u32, end_row: u32, start_col: u32, end_col: u32) -> AllowEditRange {
        AllowEditRange {
            title: "r".to_string(),
            start_row,
            start_col,
            end_row,
            end_col,
            password_hash: None,
            password_salt: None,
        }
    }

    #[test]
    fn shifted_allow_edit_range_still_covers_the_same_logical_cells() {
        use crate::commands::coord_shift::{shift_allow_edit_ranges, StructuralEdit};

        // Rows 5..9 are the exception; two rows inserted at row 0 push it down.
        let mut ranges = vec![range(5, 9, 0, 3)];
        assert!(shift_allow_edit_ranges(
            &mut ranges,
            StructuralEdit::RowInsert { at: 0, count: 2 }
        ));
        assert_eq!((ranges[0].start_row, ranges[0].end_row), (7, 11));

        // The cell that was editable must still be editable at its new home,
        // and whatever slid into the OLD position must not be.
        let after = protected_with(ranges);
        assert!(after.can_edit_cell(7, 0, true), "moved with its rows");
        assert!(
            !after.can_edit_cell(5, 0, true),
            "the old position must NOT stay writable — that is the drift bug"
        );
    }

    #[test]
    fn dropping_a_vanished_allow_edit_range_fails_safe() {
        use crate::commands::coord_shift::{shift_allow_edit_ranges, StructuralEdit};

        // Deleting every row of an exception drops it. That TIGHTENS protection
        // (one fewer exception), which is the safe direction; keeping a stale
        // rectangle would leave cells writable the author never opened up.
        let mut ranges = vec![range(5, 9, 0, 3)];
        assert!(protected_with(ranges.clone()).can_edit_cell(5, 0, true));

        assert!(shift_allow_edit_ranges(
            &mut ranges,
            StructuralEdit::RowDelete { at: 5, count: 5 }
        ));
        assert!(ranges.is_empty(), "a fully deleted exception is dropped");

        let dropped = protected_with(ranges);
        assert!(
            !dropped.can_edit_cell(5, 0, true),
            "a locked cell must be locked again once its exception is gone"
        );
        // Unlocked cells are unaffected either way.
        assert!(dropped.can_edit_cell(5, 0, false));
    }

    #[test]
    fn column_delete_narrows_an_allow_edit_range_without_widening_it() {
        use crate::commands::coord_shift::{shift_allow_edit_ranges, StructuralEdit};

        // Exception spans cols 2..6. Deleting cols 4..5 must narrow it to 2..4,
        // never leave it spanning cells that were outside it before.
        let mut ranges = vec![range(0, 3, 2, 6)];
        assert!(shift_allow_edit_ranges(
            &mut ranges,
            StructuralEdit::ColDelete { at: 4, count: 2 }
        ));
        assert_eq!((ranges[0].start_col, ranges[0].end_col), (2, 4));
        assert_eq!((ranges[0].start_row, ranges[0].end_row), (0, 3), "rows untouched");

        let after = protected_with(ranges);
        assert!(after.can_edit_cell(0, 4, true));
        assert!(
            !after.can_edit_cell(0, 5, true),
            "the range must not cover a column it never covered"
        );
    }

    #[test]
    fn an_edit_that_misses_every_range_reports_no_change() {
        use crate::commands::coord_shift::{shift_allow_edit_ranges, StructuralEdit};

        // Rows inserted BELOW the exception leave it alone. The false return is
        // load-bearing: the caller skips recording an undo entry, so a no-op
        // edit must not push one.
        let mut ranges = vec![range(5, 9, 0, 3)];
        assert!(!shift_allow_edit_ranges(
            &mut ranges,
            StructuralEdit::RowInsert { at: 20, count: 3 }
        ));
        assert_eq!((ranges[0].start_row, ranges[0].end_row), (5, 9));
    }

    // --- Backend enforcement: the shared decision procedure ---
    //
    // `refusal_reason_for_cell` is the ONE rule both the can_edit_cell command
    // and every backend gate consult, so these pin the semantics for both.

    /// Build (protection record, grid, style registry) for the tests.
    ///
    /// Lock state now rides on the cell's STYLE, so "this cell is unlocked"
    /// means "this cell points at a style whose `locked` is false" — the same
    /// resolution the gates perform. `cells` lists the positions to unlock.
    fn stores(
        prot: Option<(usize, SheetProtection)>,
        cells: Vec<(usize, (u32, u32), CellProtection)>,
    ) -> (ProtectionStorage, engine::Grid, engine::StyleRegistry) {
        let mut p = ProtectionStorage::new();
        if let Some((idx, sp)) = prot {
            p.insert(idx, sp);
        }
        let mut grid = engine::Grid::new();
        let mut styles = engine::StyleRegistry::new();
        for (_sheet, (row, col), cp) in cells {
            let mut style = engine::CellStyle::new();
            style.locked = cp.locked;
            style.formula_hidden = cp.formula_hidden;
            let idx = styles.get_or_create(style);
            let mut cell = engine::Cell::new();
            cell.style_index = idx;
            grid.set_cell(row, col, cell);
        }
        (p, grid, styles)
    }

    fn unlocked() -> CellProtection {
        let mut cp = CellProtection::default_locked();
        cp.locked = false;
        cp
    }

    #[test]
    fn a_sheet_with_no_protection_record_allows_everything() {
        let (p, g, st) = stores(None, vec![]);
        assert!(refusal_reason_for_cell(&p, &g, &st, 0, 5, 5).is_none());
    }

    #[test]
    fn an_unprotected_record_allows_everything() {
        let (p, g, st) = stores(Some((0, SheetProtection::default())), vec![]);
        assert!(refusal_reason_for_cell(&p, &g, &st, 0, 5, 5).is_none());
    }

    #[test]
    fn a_locked_cell_on_a_protected_sheet_is_refused() {
        // Absence means locked, so this cell has no entry at all.
        let (p, g, st) = stores(Some((0, protected_with(vec![]))), vec![]);
        assert!(refusal_reason_for_cell(&p, &g, &st, 0, 5, 5).is_some());
    }

    #[test]
    fn an_unlocked_cell_on_a_protected_sheet_is_allowed() {
        let (p, g, st) = stores(
            Some((0, protected_with(vec![]))),
            vec![(0, (5, 5), unlocked())],
        );
        assert!(refusal_reason_for_cell(&p, &g, &st, 0, 5, 5).is_none());
        // Its neighbour, with no entry, is still locked.
        assert!(refusal_reason_for_cell(&p, &g, &st, 0, 5, 6).is_some());
    }

    #[test]
    fn a_locked_cell_inside_an_allow_edit_range_is_allowed() {
        let (p, g, st) = stores(Some((0, protected_with(vec![range(5, 9, 0, 3)]))), vec![]);
        assert!(refusal_reason_for_cell(&p, &g, &st, 0, 7, 1).is_none(), "inside");
        assert!(refusal_reason_for_cell(&p, &g, &st, 0, 7, 9).is_some(), "outside");
    }

    #[test]
    fn protection_is_resolved_per_sheet_not_globally() {
        // The whole reason the gates take an explicit sheet_index: many backend
        // writers target a sheet other than the active one, and the old
        // can_edit_cell command could only ever answer for the active sheet.
        let (p, g, st) = stores(Some((1, protected_with(vec![]))), vec![]);
        assert!(refusal_reason_for_cell(&p, &g, &st, 1, 0, 0).is_some(), "sheet 1 protected");
        assert!(refusal_reason_for_cell(&p, &g, &st, 0, 0, 0).is_none(), "sheet 0 is not");
    }
    // --- Range gate over the style tiers ---
    //
    // The range gate must never walk the rectangle in the allow case: a
    // whole-column Delete is >1M positions. It relies on the default being
    // LOCKED, so a position is writable only if something positively grants it
    // — an allow-edit range, an unlocked column tier, an unlocked row tier, or
    // the cell's own unlocked style.

    /// A protected sheet plus a grid/registry, with an optional unlocked tier.
    fn tiered(
        unlocked_cols: Vec<u32>,
        unlocked_rows: Vec<u32>,
    ) -> (ProtectionStorage, engine::Grid, engine::StyleRegistry) {
        let mut p = ProtectionStorage::new();
        p.insert(0, protected_with(vec![]));
        let mut grid = engine::Grid::new();
        let mut styles = engine::StyleRegistry::new();
        let mut open = engine::CellStyle::new();
        open.locked = false;
        let open_idx = styles.get_or_create(open);
        for c in unlocked_cols {
            grid.set_column_style(c, open_idx);
        }
        for r in unlocked_rows {
            grid.set_row_style(r, open_idx);
        }
        (p, grid, styles)
    }

    #[test]
    fn a_whole_column_unlocked_by_its_tier_is_writable() {
        // The case the tier exists for: "unlock the input column, then protect".
        // Decided without touching a single one of the million positions.
        let (p, g, st) = tiered(vec![4], vec![]);
        assert!(
            check_sheet_protection_range_in(&p, &g, &st, 0, 0, 4, 1_048_575, 4).is_ok(),
            "an unlocked column tier grants the whole column"
        );
    }

    #[test]
    fn a_neighbouring_column_stays_locked() {
        let (p, g, st) = tiered(vec![4], vec![]);
        assert!(
            check_sheet_protection_range_in(&p, &g, &st, 0, 0, 5, 10, 5).is_err(),
            "column 5 has no tier, so the default (locked) applies"
        );
    }

    #[test]
    fn a_cell_relocked_by_its_own_style_refuses_inside_an_unlocked_column() {
        // Precedence is cell > row > column, so an individually re-locked cell
        // must still refuse even though its column is open. This is the case the
        // sparse override scan exists for.
        let (p, mut g, mut st) = tiered(vec![4], vec![]);
        // get_or_create_explicit, not get_or_create: "locked and otherwise
        // default" IS the default style, so plain interning returns index 0 —
        // which a cell reads as "inherit" and would resolve back to the
        // unlocked column. This is exactly the hole the explicit variant closes.
        let shut = st.get_or_create_explicit(engine::CellStyle::new()); // locked: true
        assert_ne!(shut, 0, "an explicit style must not be the inherit sentinel");
        let mut cell = engine::Cell::new();
        cell.style_index = shut;
        g.set_cell(7, 4, cell);
        assert!(
            check_sheet_protection_range_in(&p, &g, &st, 0, 0, 4, 1_048_575, 4).is_err(),
            "one re-locked cell refuses the range"
        );
    }

    #[test]
    fn an_unlocked_row_tier_grants_its_row() {
        let (p, g, st) = tiered(vec![], vec![2]);
        assert!(check_sheet_protection_range_in(&p, &g, &st, 0, 2, 0, 2, 500).is_ok());
        assert!(
            check_sheet_protection_range_in(&p, &g, &st, 0, 3, 0, 3, 500).is_err(),
            "row 3 has no tier"
        );
    }

    #[test]
    fn an_unprotected_sheet_is_never_refused() {
        let mut p = ProtectionStorage::new();
        p.insert(0, SheetProtection::default()); // protected: false
        let g = engine::Grid::new();
        let st = engine::StyleRegistry::new();
        assert!(check_sheet_protection_range_in(&p, &g, &st, 0, 0, 0, 1_048_575, 16_383).is_ok());
    }


    // --- formula_hidden: withholding, not blanking ---

    fn hidden_fixture(protected: bool, hidden: bool)
        -> (ProtectionStorage, engine::Grid, engine::StyleRegistry)
    {
        let mut p = ProtectionStorage::new();
        let mut sp = SheetProtection::default();
        sp.protected = protected;
        p.insert(0, sp);

        let mut grid = engine::Grid::new();
        let mut styles = engine::StyleRegistry::new();
        let mut style = engine::CellStyle::new();
        style.formula_hidden = hidden;
        let idx = styles.get_or_create_explicit(style);
        let mut cell = engine::Cell::new();
        cell.style_index = idx;
        grid.set_cell(1, 1, cell);
        (p, grid, styles)
    }

    #[test]
    fn a_hidden_formula_is_withheld_on_a_protected_sheet() {
        let (p, g, st) = hidden_fixture(true, true);
        assert!(formula_is_hidden(&p, &g, &st, 0, 1, 1));
    }

    #[test]
    fn hiding_does_nothing_until_the_sheet_is_protected() {
        // Excel semantics: the Hidden attribute is inert on an unprotected
        // sheet. Marking cells hidden while designing must not blank them.
        let (p, g, st) = hidden_fixture(false, true);
        assert!(!formula_is_hidden(&p, &g, &st, 0, 1, 1));
    }

    #[test]
    fn a_protected_sheet_does_not_hide_unmarked_cells() {
        let (p, g, st) = hidden_fixture(true, false);
        assert!(!formula_is_hidden(&p, &g, &st, 0, 1, 1));
    }

    #[test]
    fn hiding_follows_the_row_column_tier_like_any_other_format() {
        // formula_hidden is a style attribute, so a column marked hidden covers
        // cells that carry no style of their own.
        let mut p = ProtectionStorage::new();
        p.insert(0, protected_with(vec![]));
        let mut grid = engine::Grid::new();
        let mut styles = engine::StyleRegistry::new();
        let mut style = engine::CellStyle::new();
        style.formula_hidden = true;
        let idx = styles.get_or_create_explicit(style);
        grid.set_column_style(2, idx);

        assert!(formula_is_hidden(&p, &grid, &styles, 0, 500, 2), "via column tier");
        assert!(!formula_is_hidden(&p, &grid, &styles, 0, 500, 3), "other column");
    }

    #[test]
    fn a_sheet_with_no_protection_record_hides_nothing() {
        let p = ProtectionStorage::new();
        let g = engine::Grid::new();
        let st = engine::StyleRegistry::new();
        assert!(!formula_is_hidden(&p, &g, &st, 0, 0, 0));
    }

    // --- Option flags: the second, independent axis ---
    //
    // Per-cell locking answers "may this cell be written?". These answer "is
    // this KIND of operation allowed at all?" — the Protect Sheet checkboxes.
    // Both must pass. Until now all 15 were inert on both sides of the bridge.

    #[test]
    fn options_are_inert_until_the_sheet_is_protected() {
        let mut p = SheetProtection::default(); // protected: false
        p.options.allow_sort = false;
        assert!(p.is_action_allowed("sort"), "unprotected allows everything");
    }

    #[test]
    fn a_disallowed_action_is_refused_on_a_protected_sheet() {
        let mut p = protected_with(vec![]);
        p.options.allow_sort = false;
        p.options.allow_insert_rows = true;
        assert!(!p.is_action_allowed("sort"));
        assert!(p.is_action_allowed("insertRows"), "other flags unaffected");
    }

    #[test]
    fn an_unknown_action_name_is_refused_not_allowed() {
        // Fail-safe: a typo in a call site must not silently grant permission.
        let p = protected_with(vec![]);
        assert!(!p.is_action_allowed("notARealAction"));
    }

    #[test]
    fn the_action_axis_is_independent_of_cell_locking() {
        // A sheet can allow sorting yet still refuse it because a target cell is
        // locked, and vice versa — which is why both gates run.
        let mut p = protected_with(vec![]);
        p.options.allow_sort = true;
        assert!(p.is_action_allowed("sort"), "action permitted");
        // ...while a locked cell still refuses the write.
        assert!(!p.can_edit_cell(0, 0, true), "cell still locked");
    }

    // --- What the save path must keep ---
    //
    // These pin the predicate in `persistence::collect_protection_for_save`.
    // They are written against the same four conditions so a change to either
    // side shows up as a failing test rather than as silent data loss.

    fn is_worth_saving(prot: &SheetProtection) -> bool {
        !(!prot.protected
            && prot.password_hash.is_none()
            && prot.allow_edit_ranges.is_empty()
            && prot.options == SheetProtectionOptions::default())
    }

    #[test]
    fn unprotected_sheet_keeps_its_allow_edit_ranges_at_save() {
        // The normal authoring order is: define the exceptions, THEN protect.
        // The old predicate tested only protected/password_hash, so the ranges
        // were silently dropped at the next save.
        let mut prot = SheetProtection::default();
        prot.allow_edit_ranges = vec![range(5, 9, 0, 3)];
        assert!(!prot.protected && prot.password_hash.is_none());
        assert!(is_worth_saving(&prot), "ranges alone must keep the record");
    }

    #[test]
    fn unprotected_sheet_keeps_custom_options_at_save() {
        // The old comment claimed options were considered; the condition never
        // looked at them.
        let mut prot = SheetProtection::default();
        prot.options.allow_sort = !prot.options.allow_sort;
        assert!(is_worth_saving(&prot), "customized options must keep the record");
    }

    #[test]
    fn a_truly_empty_protection_record_is_still_dropped_at_save() {
        // The filter must stay a filter — a default record carries no authored
        // intent and should not bloat every save.
        assert!(!is_worth_saving(&SheetProtection::default()));
    }

    // --- set_cell_protection must not record a no-op ---
    //
    // Format Cells sends set_cell_protection on EVERY OK, whether or not the
    // user opened the Protection tab. Now that the command is undoable, writing
    // blindly would push a second, invisible undo step onto every Ctrl+1. These
    // pin the "did anything actually change" decision the command makes.

    /// Mirror of the per-cell decision in `set_cell_protection`: returns the new
    /// value to store, or None when the cell's effective protection is unchanged.
    fn next_if_changed(
        stored: Option<CellProtection>,
        locked: Option<bool>,
        formula_hidden: Option<bool>,
    ) -> Option<CellProtection> {
        let effective = stored.unwrap_or_else(CellProtection::default_locked);
        let mut next = effective;
        if let Some(l) = locked {
            next.locked = l;
        }
        if let Some(h) = formula_hidden {
            next.formula_hidden = h;
        }
        (next != effective).then_some(next)
    }

    #[test]
    fn writing_the_default_over_an_absent_cell_is_a_no_op() {
        // Absence resolves to default_locked() in get_cell_protection, so
        // "locked = true" on a cell with no entry changes nothing and must not
        // materialize one.
        let d = CellProtection::default_locked();
        assert!(next_if_changed(None, Some(d.locked), Some(d.formula_hidden)).is_none());
    }

    #[test]
    fn rewriting_a_cell_with_its_current_values_is_a_no_op() {
        let mut stored = CellProtection::default_locked();
        stored.locked = false;
        stored.formula_hidden = true;
        assert!(next_if_changed(Some(stored), Some(false), Some(true)).is_none());
    }

    #[test]
    fn a_real_protection_change_is_detected() {
        let stored = CellProtection::default_locked();
        let next = next_if_changed(Some(stored), Some(!stored.locked), None)
            .expect("flipping locked is a change");
        assert_eq!(next.locked, !stored.locked);
        // Unlocking a cell that had no entry is also a change.
        assert!(next_if_changed(None, Some(false), None).is_some());
    }

    #[test]
    fn omitted_params_leave_the_cell_untouched() {
        // Both params None: nothing to apply, so nothing changes even though
        // the command still walks the range.
        assert!(next_if_changed(None, None, None).is_none());
        assert!(next_if_changed(Some(CellProtection::default_locked()), None, None).is_none());
    }

    #[test]
    fn default_protection_options_are_not_all_false() {
        // Guards the `PartialEq` comparison above: SheetProtectionOptions has a
        // MANUAL Default with two true fields. Switching it to #[derive(Default)]
        // would flip them and silently change what counts as "customized".
        let d = SheetProtectionOptions::default();
        assert!(d.allow_select_locked_cells);
        assert!(d.allow_select_unlocked_cells);
    }

    #[test]
    fn shift_preserves_each_range_password_gate() {
        use crate::commands::coord_shift::{shift_allow_edit_ranges, StructuralEdit};

        // Each AllowEditRange carries its OWN password hash/salt. That is why
        // the undo snapshot can be scoped to the Vec alone: a range restored
        // from it comes back with its gate intact.
        let mut gated = range(5, 9, 0, 3);
        gated.password_hash = Some("hash".to_string());
        gated.password_salt = Some("salt".to_string());

        let mut ranges = vec![gated];
        assert!(shift_allow_edit_ranges(
            &mut ranges,
            StructuralEdit::RowInsert { at: 0, count: 1 }
        ));
        assert_eq!(ranges[0].start_row, 6);
        assert_eq!(ranges[0].password_hash.as_deref(), Some("hash"));
        assert_eq!(ranges[0].password_salt.as_deref(), Some("salt"));
    }

    #[test]
    fn test_default_protection_options() {
        let options = SheetProtectionOptions::default();
        assert!(options.allow_select_locked_cells);
        assert!(options.allow_select_unlocked_cells);
        assert!(!options.allow_format_cells);
        assert!(!options.allow_insert_rows);
        assert!(!options.allow_delete_columns);
    }

    #[test]
    fn test_sheet_protection_default() {
        let protection = SheetProtection::default();
        assert!(!protection.protected);
        assert!(protection.password_hash.is_none());
        assert!(protection.allow_edit_ranges.is_empty());
    }

    #[test]
    fn test_can_edit_unprotected() {
        let protection = SheetProtection::default();
        assert!(protection.can_edit_cell(0, 0, true));
        assert!(protection.can_edit_cell(0, 0, false));
    }

    #[test]
    fn test_can_edit_protected_locked() {
        let mut protection = SheetProtection::default();
        protection.protected = true;

        assert!(!protection.can_edit_cell(0, 0, true)); // Locked cell
        assert!(protection.can_edit_cell(0, 0, false)); // Unlocked cell
    }

    #[test]
    fn test_can_edit_with_allow_range() {
        let mut protection = SheetProtection::default();
        protection.protected = true;
        protection.allow_edit_ranges.push(AllowEditRange {
            title: "EditableArea".to_string(),
            start_row: 5,
            start_col: 5,
            end_row: 10,
            end_col: 10,
            password_hash: None,
            password_salt: None,
        });

        // Outside range - depends on lock status
        assert!(!protection.can_edit_cell(0, 0, true));

        // Inside range - always editable
        assert!(protection.can_edit_cell(5, 5, true));
        assert!(protection.can_edit_cell(7, 7, true));
        assert!(protection.can_edit_cell(10, 10, true));
    }

    #[test]
    fn test_allow_edit_range_contains() {
        let range = AllowEditRange {
            title: "Test".to_string(),
            start_row: 5,
            start_col: 5,
            end_row: 10,
            end_col: 10,
            password_hash: None,
            password_salt: None,
        };

        assert!(range.contains(5, 5));
        assert!(range.contains(7, 7));
        assert!(range.contains(10, 10));
        assert!(!range.contains(4, 5));
        assert!(!range.contains(5, 4));
        assert!(!range.contains(11, 10));
    }

    #[test]
    fn test_password_hashing() {
        let password = "secret123";
        let salt = generate_salt();
        let hash = hash_password(password, &salt);

        assert!(verify_password(password, &salt, &hash));
        assert!(!verify_password("wrong", &salt, &hash));
    }

    #[test]
    fn test_is_action_allowed() {
        let mut protection = SheetProtection::default();
        protection.protected = true;

        // Default options
        assert!(protection.is_action_allowed("selectLockedCells"));
        assert!(protection.is_action_allowed("selectUnlockedCells"));
        assert!(!protection.is_action_allowed("formatCells"));
        assert!(!protection.is_action_allowed("insertRows"));

        // Enable some options
        protection.options.allow_format_cells = true;
        protection.options.allow_insert_rows = true;

        assert!(protection.is_action_allowed("formatCells"));
        assert!(protection.is_action_allowed("insertRows"));
    }

    #[test]
    fn test_cell_protection_default() {
        let cp = CellProtection::default_locked();
        assert!(cp.locked);
        assert!(!cp.formula_hidden);

        let cp2 = CellProtection::unlocked();
        assert!(!cp2.locked);
        assert!(!cp2.formula_hidden);
    }

    #[test]
    fn test_workbook_protection_default() {
        let wb = WorkbookProtection::default();
        assert!(!wb.protected);
        assert!(wb.password_hash.is_none());
        assert!(wb.password_salt.is_none());
    }
}

/// Reject a WORKBOOK-STRUCTURE change while the workbook is protected.
///
/// Workbook protection guards the shape of the workbook — adding, deleting,
/// renaming, moving, copying or hiding sheets — as distinct from sheet
/// protection, which guards cell contents. It was enforced nowhere in the
/// backend: the only guard was a frontend handler that greys out three sheet-tab
/// context-menu items, so every one of these operations went straight through
/// from a script, an MCP tool, a keyboard shortcut, or any surface that did not
/// route via that menu.
pub(crate) fn check_workbook_structure(state: &AppState, what: &str) -> Result<(), String> {
    let wb = state.workbook_protection.lock().unwrap();
    if !wb.protected {
        return Ok(());
    }
    Err(format!(
        "Cannot {} while the workbook structure is protected. \
         Unprotect the workbook first (Review > Unprotect Workbook).",
        what
    ))
}
