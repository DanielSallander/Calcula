//! FILENAME: app/src-tauri/src/named_ranges.rs
//! PURPOSE: Named ranges CRUD operations and resolution for formula references.
//! CONTEXT: Allows users to define names for cell ranges that can be used in formulas.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tauri::State;

use crate::api_types::CellData;
use crate::commands::utils::get_cell_internal_with_merge;
use crate::AppState;

/// A named range definition.
/// Can be workbook-scoped (sheet_index = None) or sheet-scoped.
/// The `refers_to` field stores the formula string (e.g., "=Sheet1!$A$1:$B$10",
/// "=0.25", or "=OFFSET(A1,0,0,COUNTA(A:A),1)").
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedRange {
    /// The name identifier (e.g., "SalesData", "TaxRate")
    pub name: String,
    /// Sheet index for sheet-scoped names, None for workbook-scoped
    pub sheet_index: Option<usize>,
    /// The formula this name refers to (e.g., "=Sheet1!$A$1:$B$10" or "=0.25")
    pub refers_to: String,
    /// Optional comment/description
    pub comment: Option<String>,
    /// Optional folder for organizational grouping in the Name Manager
    pub folder: Option<String>,
}

/// Result of a named range operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedRangeResult {
    pub success: bool,
    pub named_range: Option<NamedRange>,
    pub error: Option<String>,
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
    /// Valid Excel columns are A-XFD (1-16384) and rows are 1-1048576.
    fn looks_like_cell_reference(s: &str) -> bool {
        let upper = s.to_uppercase();
        let bytes = upper.as_bytes();

        // Find where letters end and digits begin
        let mut letter_end = 0;
        for (i, &b) in bytes.iter().enumerate() {
            if b.is_ascii_uppercase() {
                letter_end = i + 1;
            } else {
                break;
            }
        }

        // Must have at least one letter
        if letter_end == 0 {
            return false;
        }

        // Must have at least one digit after the letters
        if letter_end >= bytes.len() {
            return false;
        }

        // All remaining characters must be digits
        for &b in &bytes[letter_end..] {
            if !b.is_ascii_digit() {
                return false;
            }
        }

        // Convert column letters to column number (A=1, B=2, ..., Z=26, AA=27, etc.)
        let col_str = &upper[..letter_end];
        let mut col_num: u32 = 0;
        for c in col_str.chars() {
            col_num = col_num * 26 + (c as u32 - 'A' as u32 + 1);
        }

        // Excel max column is XFD = 16384
        if col_num > 16384 {
            return false;
        }

        // Parse the row number
        let row_str = &upper[letter_end..];
        if let Ok(row_num) = row_str.parse::<u32>() {
            // Row must be between 1 and 1048576
            row_num >= 1 && row_num <= 1048576
        } else {
            false
        }
    }
}

/// Create a new named range.
#[tauri::command]
pub fn create_named_range(
    state: State<AppState>,
    name: String,
    sheet_index: Option<usize>,
    refers_to: String,
    comment: Option<String>,
    folder: Option<String>,
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
        refers_to,
        comment,
        folder,
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
    refers_to: String,
    comment: Option<String>,
    folder: Option<String>,
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
        refers_to,
        comment,
        folder,
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

/// Find a named range that matches the given selection coordinates.
/// Used by NameBox to display the name instead of the cell address.
/// Checks `refers_to` formulas that resolve to simple ranges matching the selection.
#[tauri::command]
pub fn get_named_range_for_selection(
    state: State<AppState>,
    sheet_index: usize,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> Option<NamedRange> {
    let named_ranges = state.named_ranges.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();
    let current_sheet_name = sheet_names.get(sheet_index).cloned().unwrap_or_default();

    // Build the expected refers_to patterns to match against.
    // We try to match by parsing each name's refers_to formula.
    let mut best_match: Option<&NamedRange> = None;

    for nr in named_ranges.values() {
        // Skip sheet-scoped names that don't match the current sheet
        if let Some(scope_sheet) = nr.sheet_index {
            if scope_sheet != sheet_index {
                continue;
            }
        }

        // Try to parse the refers_to formula and see if it matches our coordinates
        let formula = &nr.refers_to;
        if let Ok(parsed) = parser::parse(formula) {
            if range_matches_selection(
                &parsed,
                &current_sheet_name,
                start_row,
                start_col,
                end_row,
                end_col,
            ) {
                // Prefer sheet-scoped matches over workbook-scoped
                if nr.sheet_index.is_some() {
                    return Some(nr.clone());
                }
                best_match = Some(nr);
            }
        }
    }

    best_match.cloned()
}

/// Check if a parsed expression matches the given selection coordinates.
fn range_matches_selection(
    expr: &parser::ast::Expression,
    current_sheet_name: &str,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> bool {
    match expr {
        parser::ast::Expression::CellRef { sheet, col, row, .. } => {
            // Single cell: check if selection is also a single cell
            if start_row != end_row || start_col != end_col {
                return false;
            }
            // Sheet must match (None means current sheet)
            if let Some(s) = sheet {
                if !s.eq_ignore_ascii_case(current_sheet_name) {
                    return false;
                }
            }
            let col_idx = col_letters_to_index(col);
            let row_idx = row.saturating_sub(1); // Parser uses 1-indexed
            row_idx == start_row && col_idx == start_col
        }
        parser::ast::Expression::Range { sheet, start, end } => {
            if let Some(s) = sheet {
                if !s.eq_ignore_ascii_case(current_sheet_name) {
                    return false;
                }
            }
            if let (
                parser::ast::Expression::CellRef { col: sc, row: sr, .. },
                parser::ast::Expression::CellRef { col: ec, row: er, .. },
            ) = (start.as_ref(), end.as_ref())
            {
                let sc_idx = col_letters_to_index(sc);
                let sr_idx = sr.saturating_sub(1);
                let ec_idx = col_letters_to_index(ec);
                let er_idx = er.saturating_sub(1);
                sr_idx == start_row && sc_idx == start_col && er_idx == end_row && ec_idx == end_col
            } else {
                false
            }
        }
        _ => false,
    }
}

/// Convert column letters to 0-based column index.
fn col_letters_to_index(letters: &str) -> u32 {
    let mut result: u32 = 0;
    for ch in letters.chars() {
        let val = (ch.to_ascii_uppercase() as u32) - ('A' as u32) + 1;
        result = result * 26 + val;
    }
    result.saturating_sub(1) // Convert to 0-based
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

/// Result of the apply names operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyNamesResult {
    pub formulas_modified: u32,
    pub cells: Vec<CellData>,
}

/// Parse a `refers_to` string and extract the single-cell reference as (col_letters, row_number).
/// Returns None for range references, constant values, or formulas.
/// Handles formats like "=Sheet1!$B$5", "=$B$5", "=B5", etc.
fn extract_single_cell_ref(refers_to: &str) -> Option<(String, u32)> {
    let formula = refers_to.trim();
    if let Ok(parsed) = parser::parse(formula) {
        match &parsed {
            parser::ast::Expression::CellRef { col, row, .. } => {
                Some((col.to_uppercase(), *row))
            }
            _ => None, // Skip ranges, constants, formulas
        }
    } else {
        None
    }
}

/// Build all possible reference patterns for a cell (col_letters, row_1based).
/// For example, for ("B", 5) this returns: ["$B$5", "B$5", "$B5", "B5"].
fn build_ref_patterns(col: &str, row: u32) -> Vec<String> {
    vec![
        format!("${}${}", col, row),
        format!("{}${}", col, row),
        format!("${}{}", col, row),
        format!("{}{}", col, row),
    ]
}

/// Check if a character is valid to appear immediately before or after a cell reference
/// in a formula. Cell references are bounded by operators, parentheses, commas, etc.
/// Returns true if the character is a valid boundary (i.e., the reference is standalone).
fn is_ref_boundary(ch: char) -> bool {
    matches!(
        ch,
        '+' | '-' | '*' | '/' | '^' | '=' | '<' | '>' | '('
            | ')' | ',' | ' ' | '&' | ':' | ';' | '%' | '!'
            | '{' | '}'
    )
}

/// Replace cell references in a formula string with a named range name.
/// Only replaces standalone references (not part of another reference or name).
fn replace_ref_in_formula(formula: &str, patterns: &[String], name: &str) -> String {
    let mut result = formula.to_string();

    for pattern in patterns {
        let pat_upper = pattern.to_uppercase();
        let pat_len = pattern.len();

        // Search case-insensitively by working on an uppercase copy for matching
        let mut new_result = String::new();
        let mut i = 0;
        let chars: Vec<char> = result.chars().collect();
        let upper_chars: Vec<char> = result.to_uppercase().chars().collect();
        let pat_chars: Vec<char> = pat_upper.chars().collect();

        while i < chars.len() {
            // Check if we're inside a string literal
            if chars[i] == '"' {
                new_result.push(chars[i]);
                i += 1;
                while i < chars.len() && chars[i] != '"' {
                    new_result.push(chars[i]);
                    i += 1;
                }
                if i < chars.len() {
                    new_result.push(chars[i]); // closing quote
                    i += 1;
                }
                continue;
            }

            // Check for pattern match at current position
            if i + pat_len <= chars.len() {
                let segment: Vec<char> = upper_chars[i..i + pat_len].to_vec();
                if segment == pat_chars {
                    // Check boundary before
                    let before_ok = if i == 0 {
                        true
                    } else {
                        is_ref_boundary(chars[i - 1])
                    };

                    // Check boundary after
                    let after_ok = if i + pat_len >= chars.len() {
                        true
                    } else {
                        is_ref_boundary(chars[i + pat_len])
                    };

                    // Also ensure the character before isn't a letter or digit
                    // (which would mean this is part of a larger reference like "Sheet1!B5")
                    // But we DO want to match after '!' (sheet qualifier)
                    let before_not_alnum = if i == 0 {
                        true
                    } else {
                        let prev = chars[i - 1];
                        !prev.is_alphanumeric() && prev != '_'
                    };

                    // After must not be a letter or digit (would be part of a name)
                    let after_not_alnum = if i + pat_len >= chars.len() {
                        true
                    } else {
                        let next = chars[i + pat_len];
                        !next.is_alphanumeric() && next != '_'
                    };

                    if before_ok && after_ok && before_not_alnum && after_not_alnum {
                        // Don't replace if preceded by '!' (sheet-qualified reference like Sheet1!B5)
                        // Those should only be replaced if the sheet matches the named range's scope,
                        // but for simplicity we skip sheet-qualified refs entirely.
                        let preceded_by_bang = i > 0 && chars[i - 1] == '!';
                        if !preceded_by_bang {
                            new_result.push_str(name);
                            i += pat_len;
                            continue;
                        }
                    }
                }
            }

            new_result.push(chars[i]);
            i += 1;
        }

        result = new_result;
    }

    result
}

/// Apply named range names to formulas, replacing cell references with names.
/// This is Excel's "Apply Names" feature.
///
/// - `names`: Which named ranges to apply (empty = all)
/// - `start_row`, `start_col`, `end_row`, `end_col`: Restrict to a cell range (None = entire sheet)
#[tauri::command]
pub fn apply_names_to_formulas(
    state: State<AppState>,
    names: Vec<String>,
    start_row: Option<u32>,
    start_col: Option<u32>,
    end_row: Option<u32>,
    end_col: Option<u32>,
) -> Result<ApplyNamesResult, String> {
    let named_ranges = state.named_ranges.lock().unwrap();
    let mut grid = state.grid.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let merged_regions = state.merged_regions.lock().unwrap();
    let locale = state.locale.lock().unwrap();

    // Build the list of (name, col_letters, row_1based) for single-cell named ranges
    let names_filter: HashSet<String> = names.iter().map(|n| n.to_uppercase()).collect();
    let apply_all = names_filter.is_empty();

    let mut replacements: Vec<(String, Vec<String>)> = Vec::new();

    for nr in named_ranges.values() {
        if !apply_all && !names_filter.contains(&nr.name.to_uppercase()) {
            continue;
        }

        if let Some((col_letters, row_num)) = extract_single_cell_ref(&nr.refers_to) {
            let patterns = build_ref_patterns(&col_letters, row_num);
            replacements.push((nr.name.clone(), patterns));
        }
    }

    if replacements.is_empty() {
        return Ok(ApplyNamesResult {
            formulas_modified: 0,
            cells: Vec::new(),
        });
    }

    // Determine the cell range to scan
    let scan_start_row = start_row.unwrap_or(0);
    let scan_start_col = start_col.unwrap_or(0);
    let scan_end_row = end_row.unwrap_or(grid.max_row);
    let scan_end_col = end_col.unwrap_or(grid.max_col);

    // Collect cells that need modification first (to avoid borrow issues)
    let mut modifications: Vec<(u32, u32, String)> = Vec::new();

    for (&(row, col), cell) in grid.cells.iter() {
        if row < scan_start_row || row > scan_end_row
            || col < scan_start_col || col > scan_end_col
        {
            continue;
        }

        if let Some(ref formula) = cell.formula {
            let mut new_formula = formula.clone();

            for (name, patterns) in &replacements {
                new_formula = replace_ref_in_formula(&new_formula, patterns, name);
            }

            if new_formula != *formula {
                modifications.push((row, col, new_formula));
            }
        }
    }

    // Apply modifications
    let mut updated_cells: Vec<CellData> = Vec::new();

    for (row, col, new_formula) in &modifications {
        if let Some(cell) = grid.cells.get_mut(&(*row, *col)) {
            cell.formula = Some(new_formula.clone());
            // Clear cached AST so it gets re-parsed with the new formula
            cell.cached_ast = None;
        }
    }

    // Build CellData results for the frontend
    for (row, col, _) in &modifications {
        if let Some(cell_data) =
            get_cell_internal_with_merge(&grid, &styles, &merged_regions, *row, *col, &locale)
        {
            updated_cells.push(cell_data);
        }
    }

    Ok(ApplyNamesResult {
        formulas_modified: modifications.len() as u32,
        cells: updated_cells,
    })
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
