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
#[derive(Debug, Clone, Serialize, Deserialize)]
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

/// Protect the current sheet
#[tauri::command]
pub fn protect_sheet(
    state: State<AppState>,
    params: ProtectSheetParams,
) -> ProtectionResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut protection_storage = state.sheet_protection.lock().unwrap();

    let mut protection = protection_storage
        .entry(active_sheet)
        .or_insert_with(SheetProtection::default)
        .clone();

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
    ProtectionResult::ok(protection)
}

/// Unprotect the current sheet
#[tauri::command]
pub fn unprotect_sheet(
    state: State<AppState>,
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

    // Remove protection
    let mut new_protection = protection.clone();
    new_protection.protected = false;
    new_protection.password_hash = None;
    new_protection.password_salt = None;

    protection_storage.insert(active_sheet, new_protection.clone());
    ProtectionResult::ok(new_protection)
}

/// Update protection options for the current sheet
#[tauri::command]
pub fn update_protection_options(
    state: State<AppState>,
    options: SheetProtectionOptions,
) -> ProtectionResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut protection_storage = state.sheet_protection.lock().unwrap();

    let protection = protection_storage
        .entry(active_sheet)
        .or_insert_with(SheetProtection::default);

    protection.options = options;
    ProtectionResult::ok(protection.clone())
}

/// Add an allow-edit range to the current sheet
#[tauri::command]
pub fn add_allow_edit_range(
    state: State<AppState>,
    params: AddAllowEditRangeParams,
) -> ProtectionResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut protection_storage = state.sheet_protection.lock().unwrap();

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
    ProtectionResult::ok(protection.clone())
}

/// Remove an allow-edit range by title
#[tauri::command]
pub fn remove_allow_edit_range(
    state: State<AppState>,
    title: String,
) -> ProtectionResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut protection_storage = state.sheet_protection.lock().unwrap();

    let protection = match protection_storage.get_mut(&active_sheet) {
        Some(p) => p,
        None => return ProtectionResult::err("No protection settings for this sheet"),
    };

    let initial_len = protection.allow_edit_ranges.len();
    protection.allow_edit_ranges.retain(|r| r.title != title);

    if protection.allow_edit_ranges.len() == initial_len {
        return ProtectionResult::err("Range not found");
    }

    ProtectionResult::ok(protection.clone())
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
    params: SetCellProtectionParams,
) -> ProtectionResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut cell_protection_storage = state.cell_protection.lock().unwrap();

    let sheet_protection = cell_protection_storage
        .entry(active_sheet)
        .or_insert_with(HashMap::new);

    let min_row = params.start_row.min(params.end_row);
    let max_row = params.start_row.max(params.end_row);
    let min_col = params.start_col.min(params.end_col);
    let max_col = params.start_col.max(params.end_col);

    for row in min_row..=max_row {
        for col in min_col..=max_col {
            let current = sheet_protection
                .entry((row, col))
                .or_insert(CellProtection::default_locked());

            if let Some(locked) = params.locked {
                current.locked = locked;
            }
            if let Some(hidden) = params.formula_hidden {
                current.formula_hidden = hidden;
            }
        }
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
