//! FILENAME: app/src-tauri/src/named_ranges.rs
//! PURPOSE: Named ranges CRUD operations and resolution for formula references.
//! CONTEXT: Allows users to define names for cell ranges that can be used in formulas.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;

use crate::AppState;

/// A named range definition.
/// Can be workbook-scoped (sheet_index = None) or sheet-scoped.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedRange {
    /// The name identifier (e.g., "SalesData", "TaxRate")
    pub name: String,
    /// Sheet index for sheet-scoped names, None for workbook-scoped
    pub sheet_index: Option<usize>,
    /// Start row of the range (0-indexed)
    pub start_row: u32,
    /// Start column of the range (0-indexed)
    pub start_col: u32,
    /// End row of the range (0-indexed, inclusive)
    pub end_row: u32,
    /// End column of the range (0-indexed, inclusive)
    pub end_col: u32,
    /// Optional comment/description
    pub comment: Option<String>,
}

/// Result of a named range operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedRangeResult {
    pub success: bool,
    pub named_range: Option<NamedRange>,
    pub error: Option<String>,
}

/// Resolved range coordinates for formula evaluation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedRange {
    pub sheet_index: usize,
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
}

impl NamedRange {
    /// Validate that the name is a valid identifier.
    /// Names must start with a letter or underscore, and contain only
    /// letters, numbers, underscores, and periods.
    pub fn is_valid_name(name: &str) -> bool {
        if name.is_empty() {
            return false;
        }

        let mut chars = name.chars();

        // First character must be letter or underscore
        match chars.next() {
            Some(c) if c.is_alphabetic() || c == '_' => {}
            _ => return false,
        }

        // Remaining characters can be alphanumeric, underscore, or period
        for c in chars {
            if !c.is_alphanumeric() && c != '_' && c != '.' {
                return false;
            }
        }

        // Cannot be a valid cell reference (like A1, B2, etc.)
        if NamedRange::looks_like_cell_reference(name) {
            return false;
        }

        // Cannot be TRUE, FALSE, or reserved words
        let upper = name.to_uppercase();
        if upper == "TRUE" || upper == "FALSE" || upper == "NULL" {
            return false;
        }

        true
    }

    /// Check if a string looks like a cell reference (e.g., A1, BC123).
    fn looks_like_cell_reference(s: &str) -> bool {
        let upper = s.to_uppercase();
        let mut chars = upper.chars().peekable();

        // Must start with letters
        let mut has_letters = false;
        while let Some(&c) = chars.peek() {
            if c.is_ascii_uppercase() {
                has_letters = true;
                chars.next();
            } else {
                break;
            }
        }

        if !has_letters {
            return false;
        }

        // Must end with digits
        let mut has_digits = false;
        for c in chars {
            if c.is_ascii_digit() {
                has_digits = true;
            } else {
                return false;
            }
        }

        has_digits
    }
}

/// Create a new named range.
#[tauri::command]
pub fn create_named_range(
    state: State<AppState>,
    name: String,
    sheet_index: Option<usize>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
    comment: Option<String>,
) -> NamedRangeResult {
    // Validate name
    if !NamedRange::is_valid_name(&name) {
        return NamedRangeResult {
            success: false,
            named_range: None,
            error: Some(format!("Invalid name '{}'. Names must start with a letter or underscore, contain only letters, numbers, underscores, and periods, and cannot be cell references.", name)),
        };
    }

    let mut named_ranges = state.named_ranges.lock().unwrap();

    // Check for duplicate name (case-insensitive)
    let key = name.to_uppercase();
    if named_ranges.contains_key(&key) {
        return NamedRangeResult {
            success: false,
            named_range: None,
            error: Some(format!("A named range '{}' already exists.", name)),
        };
    }

    let named_range = NamedRange {
        name: name.clone(),
        sheet_index,
        start_row,
        start_col,
        end_row,
        end_col,
        comment,
    };

    named_ranges.insert(key, named_range.clone());

    NamedRangeResult {
        success: true,
        named_range: Some(named_range),
        error: None,
    }
}

/// Update an existing named range.
#[tauri::command]
pub fn update_named_range(
    state: State<AppState>,
    name: String,
    sheet_index: Option<usize>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
    comment: Option<String>,
) -> NamedRangeResult {
    let mut named_ranges = state.named_ranges.lock().unwrap();

    let key = name.to_uppercase();
    if !named_ranges.contains_key(&key) {
        return NamedRangeResult {
            success: false,
            named_range: None,
            error: Some(format!("Named range '{}' does not exist.", name)),
        };
    }

    let named_range = NamedRange {
        name: name.clone(),
        sheet_index,
        start_row,
        start_col,
        end_row,
        end_col,
        comment,
    };

    named_ranges.insert(key, named_range.clone());

    NamedRangeResult {
        success: true,
        named_range: Some(named_range),
        error: None,
    }
}

/// Delete a named range.
#[tauri::command]
pub fn delete_named_range(
    state: State<AppState>,
    name: String,
) -> NamedRangeResult {
    let mut named_ranges = state.named_ranges.lock().unwrap();

    let key = name.to_uppercase();
    match named_ranges.remove(&key) {
        Some(removed) => NamedRangeResult {
            success: true,
            named_range: Some(removed),
            error: None,
        },
        None => NamedRangeResult {
            success: false,
            named_range: None,
            error: Some(format!("Named range '{}' does not exist.", name)),
        },
    }
}

/// Get a named range by name.
#[tauri::command]
pub fn get_named_range(
    state: State<AppState>,
    name: String,
) -> Option<NamedRange> {
    let named_ranges = state.named_ranges.lock().unwrap();
    let key = name.to_uppercase();
    named_ranges.get(&key).cloned()
}

/// Get all named ranges.
#[tauri::command]
pub fn get_all_named_ranges(
    state: State<AppState>,
) -> Vec<NamedRange> {
    let named_ranges = state.named_ranges.lock().unwrap();
    named_ranges.values().cloned().collect()
}

/// Resolve a named range to its coordinates for formula evaluation.
/// Takes into account the current sheet context for sheet-scoped names.
#[tauri::command]
pub fn resolve_named_range(
    state: State<AppState>,
    name: String,
    current_sheet_index: usize,
) -> Option<ResolvedRange> {
    let named_ranges = state.named_ranges.lock().unwrap();
    let key = name.to_uppercase();

    if let Some(nr) = named_ranges.get(&key) {
        // For sheet-scoped names, check if it matches the current sheet
        if let Some(scope_sheet) = nr.sheet_index {
            if scope_sheet != current_sheet_index {
                // This sheet-scoped name is not visible from the current sheet
                return None;
            }
        }

        // Determine the actual sheet index
        let sheet_index = nr.sheet_index.unwrap_or(current_sheet_index);

        Some(ResolvedRange {
            sheet_index,
            start_row: nr.start_row,
            start_col: nr.start_col,
            end_row: nr.end_row,
            end_col: nr.end_col,
        })
    } else {
        None
    }
}

/// Rename a named range.
#[tauri::command]
pub fn rename_named_range(
    state: State<AppState>,
    old_name: String,
    new_name: String,
) -> NamedRangeResult {
    // Validate new name
    if !NamedRange::is_valid_name(&new_name) {
        return NamedRangeResult {
            success: false,
            named_range: None,
            error: Some(format!("Invalid name '{}'. Names must start with a letter or underscore, contain only letters, numbers, underscores, and periods, and cannot be cell references.", new_name)),
        };
    }

    let mut named_ranges = state.named_ranges.lock().unwrap();

    let old_key = old_name.to_uppercase();
    let new_key = new_name.to_uppercase();

    // Check if old name exists
    if !named_ranges.contains_key(&old_key) {
        return NamedRangeResult {
            success: false,
            named_range: None,
            error: Some(format!("Named range '{}' does not exist.", old_name)),
        };
    }

    // Check if new name already exists (unless it's the same name with different case)
    if old_key != new_key && named_ranges.contains_key(&new_key) {
        return NamedRangeResult {
            success: false,
            named_range: None,
            error: Some(format!("A named range '{}' already exists.", new_name)),
        };
    }

    // Remove old entry and insert with new name
    if let Some(mut nr) = named_ranges.remove(&old_key) {
        nr.name = new_name.clone();
        named_ranges.insert(new_key, nr.clone());

        NamedRangeResult {
            success: true,
            named_range: Some(nr),
            error: None,
        }
    } else {
        NamedRangeResult {
            success: false,
            named_range: None,
            error: Some("Unexpected error during rename.".to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_names() {
        assert!(NamedRange::is_valid_name("SalesData"));
        assert!(NamedRange::is_valid_name("_private"));
        assert!(NamedRange::is_valid_name("Tax_Rate"));
        assert!(NamedRange::is_valid_name("Q1.Sales"));
        assert!(NamedRange::is_valid_name("Data2024"));
    }

    #[test]
    fn test_invalid_names() {
        assert!(!NamedRange::is_valid_name(""));
        assert!(!NamedRange::is_valid_name("123Data"));  // Starts with number
        assert!(!NamedRange::is_valid_name("A1"));       // Cell reference
        assert!(!NamedRange::is_valid_name("BC123"));    // Cell reference
        assert!(!NamedRange::is_valid_name("TRUE"));     // Reserved word
        assert!(!NamedRange::is_valid_name("false"));    // Reserved word
        assert!(!NamedRange::is_valid_name("Data@2024")); // Invalid character
    }

    #[test]
    fn test_cell_reference_detection() {
        assert!(NamedRange::looks_like_cell_reference("A1"));
        assert!(NamedRange::looks_like_cell_reference("BC123"));
        assert!(NamedRange::looks_like_cell_reference("XFD1048576"));
        assert!(!NamedRange::looks_like_cell_reference("SalesData"));
        assert!(!NamedRange::looks_like_cell_reference("A"));
        assert!(!NamedRange::looks_like_cell_reference("1"));
    }
}
