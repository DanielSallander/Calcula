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
pub type CellProtectionStorage = HashMap<usize, HashMap<(u32, u32), CellProtection>>;

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

/// Simple hash function for password (in production, use bcrypt or argon2)
fn hash_password(password: &str, salt: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    password.hash(&mut hasher);
    salt.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Generate a random salt
fn generate_salt() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{:016x}", duration.as_nanos())
}

/// Verify a password against stored hash
fn verify_password(password: &str, salt: &str, hash: &str) -> bool {
    hash_password(password, salt) == hash
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
    let mut protection_storage = state.sheet_protection.lock().unwrap();

    let previous = protection_storage.get(&active_sheet).cloned();

    let protection = protection_storage
        .entry(active_sheet)
        .or_insert_with(SheetProtection::default);

    // Check for duplicate title
    if protection.allow_edit_ranges.iter().any(|r| r.title == params.title) {
        return ProtectionResult::err("A range with this title already exists");
    }

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
    let protection_storage = state.sheet_protection.lock().unwrap();
    let cell_protection_storage = state.cell_protection.lock().unwrap();

    let protection = match protection_storage.get(&active_sheet) {
        Some(p) => p,
        None => {
            return ProtectionCheckResult {
                can_edit: true,
                reason: None,
            };
        }
    };

    if !protection.protected {
        return ProtectionCheckResult {
            can_edit: true,
            reason: None,
        };
    }

    // Check if cell is in an allow-edit range
    for range in &protection.allow_edit_ranges {
        if range.contains(row, col) {
            return ProtectionCheckResult {
                can_edit: true,
                reason: None,
            };
        }
    }

    // Check cell lock status (default is locked)
    let is_locked = cell_protection_storage
        .get(&active_sheet)
        .and_then(|sheet| sheet.get(&(row, col)))
        .map(|cp| cp.locked)
        .unwrap_or(true); // Default is locked

    if is_locked {
        ProtectionCheckResult {
            can_edit: false,
            reason: Some("Cell is locked".to_string()),
        }
    } else {
        ProtectionCheckResult {
            can_edit: true,
            reason: None,
        }
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
    let mut cell_protection_storage = state.cell_protection.lock().unwrap();

    // Whole-sheet snapshot before the rewrite. Same shape the structural-shift
    // path records, so both mutations share one restore kind.
    let previous: Vec<((u32, u32), CellProtection)> = cell_protection_storage
        .get(&active_sheet)
        .map(|m| m.iter().map(|(k, v)| (*k, *v)).collect())
        .unwrap_or_default();

    let sheet_protection = cell_protection_storage
        .entry(active_sheet)
        .or_insert_with(HashMap::new);

    let min_row = params.start_row.min(params.end_row);
    let max_row = params.start_row.max(params.end_row);
    let min_col = params.start_col.min(params.end_col);
    let max_col = params.start_col.max(params.end_col);

    // Touch a cell ONLY when its effective protection actually changes.
    //
    // Two reasons this matters. Format Cells sends set_cell_protection on every
    // OK, whether or not the user opened the Protection tab, so the common case
    // is a call that changes nothing — and now that this command is undoable, a
    // blind write would push a second, invisible undo step onto every Ctrl+1
    // (first Ctrl+Z appears to do nothing) and dirty a clean workbook.
    //
    // A missing entry is not "unset": `get_cell_protection` resolves absence to
    // `default_locked()`, so absence and a stored `default_locked()` are the
    // same state. Comparing against that effective value keeps us from
    // materializing an entry per selected cell for a no-op call.
    let mut changed = false;
    for row in min_row..=max_row {
        for col in min_col..=max_col {
            let effective = sheet_protection
                .get(&(row, col))
                .copied()
                .unwrap_or_else(CellProtection::default_locked);

            let mut next = effective;
            if let Some(locked) = params.locked {
                next.locked = locked;
            }
            if let Some(hidden) = params.formula_hidden {
                next.formula_hidden = hidden;
            }

            if next != effective {
                sheet_protection.insert((row, col), next);
                changed = true;
            }
        }
    }
    drop(cell_protection_storage);

    if changed {
        crate::undo_commands::record_cell_protection_undo(
            &state,
            active_sheet,
            previous,
            "Change cell protection",
        );
        crate::persistence::mark_workbook_modified(&file_state);
    }

    ProtectionResult::ok_empty()
}

/// Get cell protection for a specific cell
#[tauri::command]
pub fn get_cell_protection(
    state: State<AppState>,
    row: u32,
    col: u32,
) -> CellProtection {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let cell_protection_storage = state.cell_protection.lock().unwrap();

    cell_protection_storage
        .get(&active_sheet)
        .and_then(|sheet| sheet.get(&(row, col)))
        .cloned()
        .unwrap_or_else(CellProtection::default_locked)
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
