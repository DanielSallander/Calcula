//! FILENAME: app/src-tauri/src/hyperlinks.rs
//! PURPOSE: Cell hyperlinks feature - URL, file, internal reference, and email links.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::State;

use crate::AppState;

// ============================================================================
// HYPERLINK TYPES
// ============================================================================

/// The type of hyperlink target
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HyperlinkType {
    /// External URL (http://, https://, etc.)
    Url,
    /// Link to a file (local or network path)
    File,
    /// Link to a cell/range in this workbook
    InternalReference,
    /// Email link (mailto:)
    Email,
}

/// Internal reference details for sheet/cell navigation
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalReference {
    /// Target sheet name (optional, current sheet if None)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sheet_name: Option<String>,
    /// Target cell reference (e.g., "A1" or "A1:B10")
    pub cell_reference: String,
}

// ============================================================================
// HYPERLINK DEFINITION
// ============================================================================

/// A hyperlink attached to a cell
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hyperlink {
    /// Row of the cell (0-based)
    pub row: u32,
    /// Column of the cell (0-based)
    pub col: u32,
    /// Sheet index where the hyperlink resides
    pub sheet_index: usize,
    /// The link type
    pub link_type: HyperlinkType,
    /// The target (URL, file path, or internal reference as string)
    pub target: String,
    /// Parsed internal reference (if applicable)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub internal_ref: Option<InternalReference>,
    /// Display text (overrides cell value when rendering)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_text: Option<String>,
    /// Tooltip/screen tip text
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tooltip: Option<String>,
}

impl Hyperlink {
    /// Create a URL hyperlink
    pub fn new_url(row: u32, col: u32, sheet_index: usize, url: String) -> Self {
        Self {
            row,
            col,
            sheet_index,
            link_type: HyperlinkType::Url,
            target: url,
            internal_ref: None,
            display_text: None,
            tooltip: None,
        }
    }

    /// Create a file hyperlink
    pub fn new_file(row: u32, col: u32, sheet_index: usize, path: String) -> Self {
        Self {
            row,
            col,
            sheet_index,
            link_type: HyperlinkType::File,
            target: path,
            internal_ref: None,
            display_text: None,
            tooltip: None,
        }
    }

    /// Create an internal reference hyperlink
    pub fn new_internal(
        row: u32,
        col: u32,
        sheet_index: usize,
        target_sheet: Option<String>,
        cell_reference: String,
    ) -> Self {
        let target = match &target_sheet {
            Some(name) => format!("'{}'!{}", name, cell_reference),
            None => cell_reference.clone(),
        };
        Self {
            row,
            col,
            sheet_index,
            link_type: HyperlinkType::InternalReference,
            target,
            internal_ref: Some(InternalReference {
                sheet_name: target_sheet,
                cell_reference,
            }),
            display_text: None,
            tooltip: None,
        }
    }

    /// Create an email hyperlink
    pub fn new_email(
        row: u32,
        col: u32,
        sheet_index: usize,
        email: String,
        subject: Option<String>,
    ) -> Self {
        let target = match &subject {
            Some(subj) => format!("mailto:{}?subject={}", email, percent_encode(subj)),
            None => format!("mailto:{}", email),
        };
        Self {
            row,
            col,
            sheet_index,
            link_type: HyperlinkType::Email,
            target,
            internal_ref: None,
            display_text: None,
            tooltip: None,
        }
    }
}

// ============================================================================
// STORAGE
// ============================================================================

/// Storage: sheet_index -> (row, col) -> Hyperlink
pub type HyperlinkStorage = HashMap<usize, HashMap<(u32, u32), Hyperlink>>;

// ============================================================================
// RESULT TYPES
// ============================================================================

/// Result returned from hyperlink commands
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HyperlinkResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hyperlink: Option<Hyperlink>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl HyperlinkResult {
    pub fn ok(hyperlink: Hyperlink) -> Self {
        Self {
            success: true,
            hyperlink: Some(hyperlink),
            error: None,
        }
    }

    pub fn ok_empty() -> Self {
        Self {
            success: true,
            hyperlink: None,
            error: None,
        }
    }

    pub fn err(message: impl Into<String>) -> Self {
        Self {
            success: false,
            hyperlink: None,
            error: Some(message.into()),
        }
    }
}

/// Indicator for cells with hyperlinks (for rendering)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HyperlinkIndicator {
    pub row: u32,
    pub col: u32,
    pub link_type: HyperlinkType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tooltip: Option<String>,
}

impl From<&Hyperlink> for HyperlinkIndicator {
    fn from(h: &Hyperlink) -> Self {
        Self {
            row: h.row,
            col: h.col,
            link_type: h.link_type,
            tooltip: h.tooltip.clone(),
        }
    }
}

// ============================================================================
// PARAMS
// ============================================================================

/// Parameters for adding a hyperlink
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddHyperlinkParams {
    pub row: u32,
    pub col: u32,
    pub link_type: HyperlinkType,
    pub target: String,
    #[serde(default)]
    pub display_text: Option<String>,
    #[serde(default)]
    pub tooltip: Option<String>,
    /// For internal references: target sheet name
    #[serde(default)]
    pub sheet_name: Option<String>,
    /// For internal references: target cell reference
    #[serde(default)]
    pub cell_reference: Option<String>,
    /// For email: subject line
    #[serde(default)]
    pub email_subject: Option<String>,
}

/// Parameters for updating a hyperlink
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateHyperlinkParams {
    pub row: u32,
    pub col: u32,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub display_text: Option<String>,
    #[serde(default)]
    pub tooltip: Option<String>,
}

// ============================================================================
// COMMANDS
// ============================================================================

/// Add a hyperlink to a cell
#[tauri::command]
pub fn add_hyperlink(
    state: State<AppState>,
    params: AddHyperlinkParams,
) -> HyperlinkResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut hyperlinks = state.hyperlinks.lock().unwrap();

    // Create the hyperlink based on type
    let mut hyperlink = match params.link_type {
        HyperlinkType::Url => {
            Hyperlink::new_url(params.row, params.col, active_sheet, params.target)
        }
        HyperlinkType::File => {
            Hyperlink::new_file(params.row, params.col, active_sheet, params.target)
        }
        HyperlinkType::InternalReference => {
            let cell_ref = params.cell_reference.unwrap_or(params.target);
            Hyperlink::new_internal(
                params.row,
                params.col,
                active_sheet,
                params.sheet_name,
                cell_ref,
            )
        }
        HyperlinkType::Email => {
            // Extract email from target if it's a mailto: URL
            let email = if params.target.starts_with("mailto:") {
                params.target.trim_start_matches("mailto:").split('?').next().unwrap_or(&params.target).to_string()
            } else {
                params.target.clone()
            };
            Hyperlink::new_email(
                params.row,
                params.col,
                active_sheet,
                email,
                params.email_subject,
            )
        }
    };

    // Apply optional display text and tooltip
    hyperlink.display_text = params.display_text;
    hyperlink.tooltip = params.tooltip;

    // Store the hyperlink
    let sheet_hyperlinks = hyperlinks.entry(active_sheet).or_insert_with(HashMap::new);
    sheet_hyperlinks.insert((params.row, params.col), hyperlink.clone());

    HyperlinkResult::ok(hyperlink)
}

/// Update an existing hyperlink
#[tauri::command]
pub fn update_hyperlink(
    state: State<AppState>,
    params: UpdateHyperlinkParams,
) -> HyperlinkResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut hyperlinks = state.hyperlinks.lock().unwrap();

    let sheet_hyperlinks = match hyperlinks.get_mut(&active_sheet) {
        Some(h) => h,
        None => return HyperlinkResult::err("No hyperlinks on this sheet"),
    };

    let hyperlink = match sheet_hyperlinks.get_mut(&(params.row, params.col)) {
        Some(h) => h,
        None => return HyperlinkResult::err("No hyperlink at this cell"),
    };

    // Update fields if provided
    if let Some(target) = params.target {
        hyperlink.target = target;
    }
    if params.display_text.is_some() {
        hyperlink.display_text = params.display_text;
    }
    if params.tooltip.is_some() {
        hyperlink.tooltip = params.tooltip;
    }

    HyperlinkResult::ok(hyperlink.clone())
}

/// Remove a hyperlink from a cell
#[tauri::command]
pub fn remove_hyperlink(
    state: State<AppState>,
    row: u32,
    col: u32,
) -> HyperlinkResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut hyperlinks = state.hyperlinks.lock().unwrap();

    let sheet_hyperlinks = match hyperlinks.get_mut(&active_sheet) {
        Some(h) => h,
        None => return HyperlinkResult::err("No hyperlinks on this sheet"),
    };

    match sheet_hyperlinks.remove(&(row, col)) {
        Some(removed) => HyperlinkResult::ok(removed),
        None => HyperlinkResult::err("No hyperlink at this cell"),
    }
}

/// Get hyperlink at a specific cell
#[tauri::command]
pub fn get_hyperlink(
    state: State<AppState>,
    row: u32,
    col: u32,
) -> Option<Hyperlink> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let hyperlinks = state.hyperlinks.lock().unwrap();

    hyperlinks
        .get(&active_sheet)
        .and_then(|sheet_hyperlinks| sheet_hyperlinks.get(&(row, col)).cloned())
}

/// Get all hyperlinks in the current sheet
#[tauri::command]
pub fn get_all_hyperlinks(state: State<AppState>) -> Vec<Hyperlink> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let hyperlinks = state.hyperlinks.lock().unwrap();

    hyperlinks
        .get(&active_sheet)
        .map(|sheet_hyperlinks| sheet_hyperlinks.values().cloned().collect())
        .unwrap_or_default()
}

/// Get hyperlink indicators for rendering (shows which cells have hyperlinks)
#[tauri::command]
pub fn get_hyperlink_indicators(state: State<AppState>) -> Vec<HyperlinkIndicator> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let hyperlinks = state.hyperlinks.lock().unwrap();

    hyperlinks
        .get(&active_sheet)
        .map(|sheet_hyperlinks| {
            sheet_hyperlinks.values().map(HyperlinkIndicator::from).collect()
        })
        .unwrap_or_default()
}

/// Get hyperlink indicators within a specific range
#[tauri::command]
pub fn get_hyperlinks_in_range(
    state: State<AppState>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> Vec<HyperlinkIndicator> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let hyperlinks = state.hyperlinks.lock().unwrap();

    let min_row = start_row.min(end_row);
    let max_row = start_row.max(end_row);
    let min_col = start_col.min(end_col);
    let max_col = start_col.max(end_col);

    hyperlinks
        .get(&active_sheet)
        .map(|sheet_hyperlinks| {
            sheet_hyperlinks
                .values()
                .filter(|h| {
                    h.row >= min_row && h.row <= max_row && h.col >= min_col && h.col <= max_col
                })
                .map(HyperlinkIndicator::from)
                .collect()
        })
        .unwrap_or_default()
}

/// Check if a cell has a hyperlink
#[tauri::command]
pub fn has_hyperlink(
    state: State<AppState>,
    row: u32,
    col: u32,
) -> bool {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let hyperlinks = state.hyperlinks.lock().unwrap();

    hyperlinks
        .get(&active_sheet)
        .map(|sheet_hyperlinks| sheet_hyperlinks.contains_key(&(row, col)))
        .unwrap_or(false)
}

/// Clear all hyperlinks in a range
#[tauri::command]
pub fn clear_hyperlinks_in_range(
    state: State<AppState>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> u32 {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut hyperlinks = state.hyperlinks.lock().unwrap();

    let min_row = start_row.min(end_row);
    let max_row = start_row.max(end_row);
    let min_col = start_col.min(end_col);
    let max_col = start_col.max(end_col);

    let sheet_hyperlinks = match hyperlinks.get_mut(&active_sheet) {
        Some(h) => h,
        None => return 0,
    };

    // Collect keys to remove (can't modify while iterating)
    let keys_to_remove: Vec<(u32, u32)> = sheet_hyperlinks
        .keys()
        .filter(|(r, c)| *r >= min_row && *r <= max_row && *c >= min_col && *c <= max_col)
        .cloned()
        .collect();

    let count = keys_to_remove.len() as u32;
    for key in keys_to_remove {
        sheet_hyperlinks.remove(&key);
    }

    count
}

/// Move a hyperlink from one cell to another
#[tauri::command]
pub fn move_hyperlink(
    state: State<AppState>,
    from_row: u32,
    from_col: u32,
    to_row: u32,
    to_col: u32,
) -> HyperlinkResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut hyperlinks = state.hyperlinks.lock().unwrap();

    let sheet_hyperlinks = match hyperlinks.get_mut(&active_sheet) {
        Some(h) => h,
        None => return HyperlinkResult::err("No hyperlinks on this sheet"),
    };

    // Check if destination already has a hyperlink
    if sheet_hyperlinks.contains_key(&(to_row, to_col)) {
        return HyperlinkResult::err("Destination cell already has a hyperlink");
    }

    // Remove from source and update coordinates
    match sheet_hyperlinks.remove(&(from_row, from_col)) {
        Some(mut hyperlink) => {
            hyperlink.row = to_row;
            hyperlink.col = to_col;
            let result = hyperlink.clone();
            sheet_hyperlinks.insert((to_row, to_col), hyperlink);
            HyperlinkResult::ok(result)
        }
        None => HyperlinkResult::err("No hyperlink at source cell"),
    }
}

/// Get hyperlinks for a specific sheet (internal use)
pub fn get_hyperlinks_for_sheet(
    hyperlinks: &HyperlinkStorage,
    sheet_index: usize,
) -> Vec<Hyperlink> {
    hyperlinks
        .get(&sheet_index)
        .map(|sheet_hyperlinks| sheet_hyperlinks.values().cloned().collect())
        .unwrap_or_default()
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/// Simple percent-encoding for URL query parameters
fn percent_encode(s: &str) -> String {
    let mut result = String::with_capacity(s.len() * 3);
    for c in s.chars() {
        match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => {
                result.push(c);
            }
            ' ' => {
                result.push_str("%20");
            }
            _ => {
                for byte in c.to_string().as_bytes() {
                    result.push_str(&format!("%{:02X}", byte));
                }
            }
        }
    }
    result
}

/// Validate a URL format (basic check)
pub fn is_valid_url(url: &str) -> bool {
    url.starts_with("http://")
        || url.starts_with("https://")
        || url.starts_with("ftp://")
        || url.starts_with("file://")
}

/// Validate an email format (basic check)
pub fn is_valid_email(email: &str) -> bool {
    email.contains('@') && email.contains('.')
}

/// Parse a cell reference string into row/col (e.g., "A1" -> (0, 0))
pub fn parse_cell_reference(cell_ref: &str) -> Option<(u32, u32)> {
    let cell_ref = cell_ref.trim().to_uppercase();

    // Find where letters end and numbers begin
    let mut col_end = 0;
    for (i, c) in cell_ref.chars().enumerate() {
        if c.is_ascii_digit() {
            col_end = i;
            break;
        }
    }

    if col_end == 0 {
        return None;
    }

    let col_str = &cell_ref[..col_end];
    let row_str = &cell_ref[col_end..];

    // Convert column letters to index
    let mut col: u32 = 0;
    for c in col_str.chars() {
        col = col * 26 + (c as u32 - 'A' as u32 + 1);
    }
    col = col.saturating_sub(1); // 0-indexed

    // Parse row number
    let row: u32 = row_str.parse().ok()?;
    let row = row.saturating_sub(1); // 0-indexed

    Some((row, col))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hyperlink_new_url() {
        let h = Hyperlink::new_url(0, 0, 0, "https://example.com".to_string());
        assert_eq!(h.link_type, HyperlinkType::Url);
        assert_eq!(h.target, "https://example.com");
    }

    #[test]
    fn test_hyperlink_new_internal() {
        let h = Hyperlink::new_internal(0, 0, 0, Some("Sheet2".to_string()), "A1".to_string());
        assert_eq!(h.link_type, HyperlinkType::InternalReference);
        assert_eq!(h.target, "'Sheet2'!A1");
        assert!(h.internal_ref.is_some());
    }

    #[test]
    fn test_hyperlink_new_email() {
        let h = Hyperlink::new_email(0, 0, 0, "test@example.com".to_string(), Some("Hello".to_string()));
        assert_eq!(h.link_type, HyperlinkType::Email);
        assert!(h.target.starts_with("mailto:test@example.com"));
    }

    #[test]
    fn test_parse_cell_reference() {
        assert_eq!(parse_cell_reference("A1"), Some((0, 0)));
        assert_eq!(parse_cell_reference("B2"), Some((1, 1)));
        assert_eq!(parse_cell_reference("AA10"), Some((9, 26)));
        assert_eq!(parse_cell_reference("Z100"), Some((99, 25)));
    }

    #[test]
    fn test_is_valid_url() {
        assert!(is_valid_url("https://example.com"));
        assert!(is_valid_url("http://example.com"));
        assert!(is_valid_url("ftp://files.example.com"));
        assert!(!is_valid_url("example.com"));
    }

    #[test]
    fn test_is_valid_email() {
        assert!(is_valid_email("test@example.com"));
        assert!(!is_valid_email("test@"));
        assert!(!is_valid_email("test"));
    }
}
