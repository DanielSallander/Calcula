//! FILENAME: app/src-tauri/src/grouping.rs
//! PURPOSE: Row and column grouping (outline) feature for collapsible sections.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tauri::State;

use crate::AppState;

// ============================================================================
// CONSTANTS
// ============================================================================

/// Maximum outline level (Excel limit is 8)
pub const MAX_OUTLINE_LEVEL: u8 = 8;

// ============================================================================
// OUTLINE SETTINGS
// ============================================================================

/// Position of summary row/column relative to detail rows/columns
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SummaryPosition {
    /// Summary row/column is below/right of detail
    BelowRight,
    /// Summary row/column is above/left of detail
    AboveLeft,
}

impl Default for SummaryPosition {
    fn default() -> Self {
        SummaryPosition::BelowRight
    }
}

/// Outline settings for a sheet
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineSettings {
    /// Position of summary rows relative to detail rows
    pub summary_row_position: SummaryPosition,
    /// Position of summary columns relative to detail columns
    pub summary_col_position: SummaryPosition,
    /// Show outline symbols (expand/collapse buttons)
    pub show_outline_symbols: bool,
    /// Automatically apply outline styles
    pub auto_styles: bool,
}

impl Default for OutlineSettings {
    fn default() -> Self {
        Self {
            summary_row_position: SummaryPosition::BelowRight,
            summary_col_position: SummaryPosition::BelowRight,
            show_outline_symbols: true,
            auto_styles: false,
        }
    }
}

// ============================================================================
// GROUP DEFINITIONS
// ============================================================================

/// A row group (horizontal outline)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowGroup {
    /// First row in the group (0-based)
    pub start_row: u32,
    /// Last row in the group (0-based, inclusive)
    pub end_row: u32,
    /// Outline level (1-8)
    pub level: u8,
    /// Whether the group is collapsed
    pub collapsed: bool,
}

impl RowGroup {
    pub fn new(start_row: u32, end_row: u32, level: u8) -> Self {
        Self {
            start_row: start_row.min(end_row),
            end_row: start_row.max(end_row),
            level: level.min(MAX_OUTLINE_LEVEL).max(1),
            collapsed: false,
        }
    }

    /// Check if a row is within this group
    pub fn contains_row(&self, row: u32) -> bool {
        row >= self.start_row && row <= self.end_row
    }

    /// Check if this group overlaps with another
    pub fn overlaps(&self, other: &RowGroup) -> bool {
        !(self.end_row < other.start_row || self.start_row > other.end_row)
    }
}

/// A column group (vertical outline)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnGroup {
    /// First column in the group (0-based)
    pub start_col: u32,
    /// Last column in the group (0-based, inclusive)
    pub end_col: u32,
    /// Outline level (1-8)
    pub level: u8,
    /// Whether the group is collapsed
    pub collapsed: bool,
}

impl ColumnGroup {
    pub fn new(start_col: u32, end_col: u32, level: u8) -> Self {
        Self {
            start_col: start_col.min(end_col),
            end_col: start_col.max(end_col),
            level: level.min(MAX_OUTLINE_LEVEL).max(1),
            collapsed: false,
        }
    }

    /// Check if a column is within this group
    pub fn contains_col(&self, col: u32) -> bool {
        col >= self.start_col && col <= self.end_col
    }

    /// Check if this group overlaps with another
    pub fn overlaps(&self, other: &ColumnGroup) -> bool {
        !(self.end_col < other.start_col || self.start_col > other.end_col)
    }
}

// ============================================================================
// SHEET OUTLINE
// ============================================================================

/// Complete outline data for a sheet
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SheetOutline {
    /// Row groups (sorted by start_row)
    pub row_groups: Vec<RowGroup>,
    /// Column groups (sorted by start_col)
    pub column_groups: Vec<ColumnGroup>,
    /// Outline settings
    pub settings: OutlineSettings,
    /// Maximum row outline level used
    pub max_row_level: u8,
    /// Maximum column outline level used
    pub max_col_level: u8,
}

impl SheetOutline {
    pub fn new() -> Self {
        Self::default()
    }

    /// Get the outline level for a specific row
    pub fn get_row_level(&self, row: u32) -> u8 {
        let mut level = 0u8;
        for group in &self.row_groups {
            if group.contains_row(row) {
                level = level.max(group.level);
            }
        }
        level
    }

    /// Get the outline level for a specific column
    pub fn get_col_level(&self, col: u32) -> u8 {
        let mut level = 0u8;
        for group in &self.column_groups {
            if group.contains_col(col) {
                level = level.max(group.level);
            }
        }
        level
    }

    /// Get hidden rows based on collapsed groups.
    /// The summary row (button row) is excluded so the user can still click +
    /// to expand the group.
    pub fn get_hidden_rows(&self) -> HashSet<u32> {
        let mut hidden = HashSet::new();

        for group in &self.row_groups {
            if group.collapsed {
                let summary_row = match self.settings.summary_row_position {
                    SummaryPosition::BelowRight => group.end_row,
                    SummaryPosition::AboveLeft => group.start_row,
                };
                for row in group.start_row..=group.end_row {
                    if row != summary_row {
                        hidden.insert(row);
                    }
                }
            }
        }

        hidden
    }

    /// Get hidden columns based on collapsed groups.
    /// The summary column (button column) is excluded so the user can still
    /// click + to expand the group.
    pub fn get_hidden_cols(&self) -> HashSet<u32> {
        let mut hidden = HashSet::new();

        for group in &self.column_groups {
            if group.collapsed {
                let summary_col = match self.settings.summary_col_position {
                    SummaryPosition::BelowRight => group.end_col,
                    SummaryPosition::AboveLeft => group.start_col,
                };
                for col in group.start_col..=group.end_col {
                    if col != summary_col {
                        hidden.insert(col);
                    }
                }
            }
        }

        hidden
    }

    /// Recalculate max levels
    fn recalculate_max_levels(&mut self) {
        self.max_row_level = self.row_groups.iter().map(|g| g.level).max().unwrap_or(0);
        self.max_col_level = self.column_groups.iter().map(|g| g.level).max().unwrap_or(0);
    }

    /// Sort groups by start position
    fn sort_groups(&mut self) {
        self.row_groups.sort_by_key(|g| g.start_row);
        self.column_groups.sort_by_key(|g| g.start_col);
    }
}

// ============================================================================
// STORAGE
// ============================================================================

/// Storage: sheet_index -> SheetOutline
pub type OutlineStorage = HashMap<usize, SheetOutline>;

// ============================================================================
// RESULT TYPES
// ============================================================================

/// Result returned from grouping commands
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outline: Option<SheetOutline>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Rows that became hidden or visible
    #[serde(default)]
    pub hidden_rows_changed: Vec<u32>,
    /// Columns that became hidden or visible
    #[serde(default)]
    pub hidden_cols_changed: Vec<u32>,
}

impl GroupResult {
    pub fn ok(outline: SheetOutline) -> Self {
        Self {
            success: true,
            outline: Some(outline),
            error: None,
            hidden_rows_changed: Vec::new(),
            hidden_cols_changed: Vec::new(),
        }
    }

    pub fn ok_with_changes(
        outline: SheetOutline,
        hidden_rows: Vec<u32>,
        hidden_cols: Vec<u32>,
    ) -> Self {
        Self {
            success: true,
            outline: Some(outline),
            error: None,
            hidden_rows_changed: hidden_rows,
            hidden_cols_changed: hidden_cols,
        }
    }

    pub fn err(message: impl Into<String>) -> Self {
        Self {
            success: false,
            outline: None,
            error: Some(message.into()),
            hidden_rows_changed: Vec::new(),
            hidden_cols_changed: Vec::new(),
        }
    }
}

/// Outline symbol information for rendering
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowOutlineSymbol {
    pub row: u32,
    pub level: u8,
    pub is_collapsed: bool,
    /// True if this row shows the expand/collapse button
    pub is_button_row: bool,
    /// True if row is hidden due to grouping
    pub is_hidden: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColOutlineSymbol {
    pub col: u32,
    pub level: u8,
    pub is_collapsed: bool,
    /// True if this column shows the expand/collapse button
    pub is_button_col: bool,
    /// True if column is hidden due to grouping
    pub is_hidden: bool,
}

/// Complete outline info for a viewport
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineInfo {
    pub row_symbols: Vec<RowOutlineSymbol>,
    pub col_symbols: Vec<ColOutlineSymbol>,
    pub max_row_level: u8,
    pub max_col_level: u8,
    pub settings: OutlineSettings,
}

// ============================================================================
// PARAMS
// ============================================================================

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupRowsParams {
    pub start_row: u32,
    pub end_row: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupColumnsParams {
    pub start_col: u32,
    pub end_col: u32,
}

// ============================================================================
// COMMANDS
// ============================================================================

/// Group rows (create or increment outline level)
#[tauri::command]
pub fn group_rows(
    state: State<AppState>,
    params: GroupRowsParams,
) -> GroupResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut outlines = state.outlines.lock().unwrap();

    let outline = outlines.entry(active_sheet).or_insert_with(SheetOutline::new);

    let start = params.start_row.min(params.end_row);
    let end = params.start_row.max(params.end_row);

    // Find existing group at the same range or calculate new level
    let current_max_level = (start..=end)
        .map(|row| outline.get_row_level(row))
        .max()
        .unwrap_or(0);

    let new_level = (current_max_level + 1).min(MAX_OUTLINE_LEVEL);

    if new_level > MAX_OUTLINE_LEVEL {
        return GroupResult::err(format!("Maximum outline level ({}) exceeded", MAX_OUTLINE_LEVEL));
    }

    // Add new group
    outline.row_groups.push(RowGroup::new(start, end, new_level));
    outline.sort_groups();
    outline.recalculate_max_levels();

    GroupResult::ok(outline.clone())
}

/// Ungroup rows – Excel-style partial ungroup.
/// If the selected range is a subset of a group, the group is split: the
/// selected rows are removed from the group and any remaining rows above
/// and/or below stay grouped.
#[tauri::command]
pub fn ungroup_rows(
    state: State<AppState>,
    start_row: u32,
    end_row: u32,
) -> GroupResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut outlines = state.outlines.lock().unwrap();

    let outline = match outlines.get_mut(&active_sheet) {
        Some(o) => o,
        None => return GroupResult::err("No outline exists for this sheet"),
    };

    let sel_start = start_row.min(end_row);
    let sel_end = start_row.max(end_row);

    // Find the highest-level group that overlaps the selection
    let target_level = outline
        .row_groups
        .iter()
        .filter(|g| g.start_row <= sel_end && g.end_row >= sel_start)
        .map(|g| g.level)
        .max()
        .unwrap_or(0);

    if target_level == 0 {
        return GroupResult::err("No group overlaps the selected rows");
    }

    // Process groups at that level that overlap the selection
    let mut new_groups: Vec<RowGroup> = Vec::new();
    let mut modified = false;

    outline.row_groups.retain(|g| {
        if g.level != target_level || g.start_row > sel_end || g.end_row < sel_start {
            return true; // keep unaffected groups
        }

        modified = true;

        // Part above the selection stays grouped
        if g.start_row < sel_start {
            new_groups.push(RowGroup::new(g.start_row, sel_start - 1, g.level));
        }
        // Part below the selection stays grouped
        if g.end_row > sel_end {
            new_groups.push(RowGroup::new(sel_end + 1, g.end_row, g.level));
        }

        false // remove the original group
    });

    if !modified {
        return GroupResult::err("No group at this level overlaps the selected rows");
    }

    outline.row_groups.extend(new_groups);
    outline.sort_groups();
    outline.recalculate_max_levels();

    let hidden_rows: Vec<u32> = outline.get_hidden_rows().into_iter().collect();
    GroupResult::ok_with_changes(outline.clone(), hidden_rows, Vec::new())
}

/// Group columns (create or increment outline level)
#[tauri::command]
pub fn group_columns(
    state: State<AppState>,
    params: GroupColumnsParams,
) -> GroupResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut outlines = state.outlines.lock().unwrap();

    let outline = outlines.entry(active_sheet).or_insert_with(SheetOutline::new);

    let start = params.start_col.min(params.end_col);
    let end = params.start_col.max(params.end_col);

    // Calculate new level
    let current_max_level = (start..=end)
        .map(|col| outline.get_col_level(col))
        .max()
        .unwrap_or(0);

    let new_level = (current_max_level + 1).min(MAX_OUTLINE_LEVEL);

    if new_level > MAX_OUTLINE_LEVEL {
        return GroupResult::err(format!("Maximum outline level ({}) exceeded", MAX_OUTLINE_LEVEL));
    }

    // Add new group
    outline.column_groups.push(ColumnGroup::new(start, end, new_level));
    outline.sort_groups();
    outline.recalculate_max_levels();

    GroupResult::ok(outline.clone())
}

/// Ungroup columns – Excel-style partial ungroup.
/// If the selected range is a subset of a group, the group is split.
#[tauri::command]
pub fn ungroup_columns(
    state: State<AppState>,
    start_col: u32,
    end_col: u32,
) -> GroupResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut outlines = state.outlines.lock().unwrap();

    let outline = match outlines.get_mut(&active_sheet) {
        Some(o) => o,
        None => return GroupResult::err("No outline exists for this sheet"),
    };

    let sel_start = start_col.min(end_col);
    let sel_end = start_col.max(end_col);

    let target_level = outline
        .column_groups
        .iter()
        .filter(|g| g.start_col <= sel_end && g.end_col >= sel_start)
        .map(|g| g.level)
        .max()
        .unwrap_or(0);

    if target_level == 0 {
        return GroupResult::err("No group overlaps the selected columns");
    }

    let mut new_groups: Vec<ColumnGroup> = Vec::new();
    let mut modified = false;

    outline.column_groups.retain(|g| {
        if g.level != target_level || g.start_col > sel_end || g.end_col < sel_start {
            return true;
        }

        modified = true;

        if g.start_col < sel_start {
            new_groups.push(ColumnGroup::new(g.start_col, sel_start - 1, g.level));
        }
        if g.end_col > sel_end {
            new_groups.push(ColumnGroup::new(sel_end + 1, g.end_col, g.level));
        }

        false
    });

    if !modified {
        return GroupResult::err("No group at this level overlaps the selected columns");
    }

    outline.column_groups.extend(new_groups);
    outline.sort_groups();
    outline.recalculate_max_levels();

    let hidden_cols: Vec<u32> = outline.get_hidden_cols().into_iter().collect();
    GroupResult::ok_with_changes(outline.clone(), Vec::new(), hidden_cols)
}

/// Collapse a row group.
/// Only collapses the group whose button (summary) row matches, so that
/// nested groups can be collapsed independently.
#[tauri::command]
pub fn collapse_row_group(
    state: State<AppState>,
    row: u32,
) -> GroupResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut outlines = state.outlines.lock().unwrap();

    let outline = match outlines.get_mut(&active_sheet) {
        Some(o) => o,
        None => return GroupResult::err("No outline exists for this sheet"),
    };

    let before_hidden = outline.get_hidden_rows();

    // Only collapse the group whose button row matches (not all groups
    // containing this row).  This lets nested groups collapse independently.
    let mut found = false;
    for group in &mut outline.row_groups {
        let is_button = match outline.settings.summary_row_position {
            SummaryPosition::BelowRight => group.end_row == row,
            SummaryPosition::AboveLeft => group.start_row == row,
        };
        if is_button && !group.collapsed {
            group.collapsed = true;
            found = true;
        }
    }

    if !found {
        return GroupResult::err("No expandable group at this row");
    }

    let after_hidden = outline.get_hidden_rows();
    let newly_hidden: Vec<u32> = after_hidden.difference(&before_hidden).cloned().collect();

    GroupResult::ok_with_changes(outline.clone(), newly_hidden, Vec::new())
}

/// Expand a row group.
/// Only expands the group whose button (summary) row matches.
#[tauri::command]
pub fn expand_row_group(
    state: State<AppState>,
    row: u32,
) -> GroupResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut outlines = state.outlines.lock().unwrap();

    let outline = match outlines.get_mut(&active_sheet) {
        Some(o) => o,
        None => return GroupResult::err("No outline exists for this sheet"),
    };

    let before_hidden = outline.get_hidden_rows();

    let mut found = false;
    for group in &mut outline.row_groups {
        let is_button = match outline.settings.summary_row_position {
            SummaryPosition::BelowRight => group.end_row == row,
            SummaryPosition::AboveLeft => group.start_row == row,
        };
        if is_button && group.collapsed {
            group.collapsed = false;
            found = true;
        }
    }

    if !found {
        return GroupResult::err("No collapsible group at this row");
    }

    let after_hidden = outline.get_hidden_rows();
    let newly_visible: Vec<u32> = before_hidden.difference(&after_hidden).cloned().collect();

    GroupResult::ok_with_changes(outline.clone(), newly_visible, Vec::new())
}

/// Collapse a column group.
/// Only collapses the group whose button (summary) column matches.
#[tauri::command]
pub fn collapse_column_group(
    state: State<AppState>,
    col: u32,
) -> GroupResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut outlines = state.outlines.lock().unwrap();

    let outline = match outlines.get_mut(&active_sheet) {
        Some(o) => o,
        None => return GroupResult::err("No outline exists for this sheet"),
    };

    let before_hidden = outline.get_hidden_cols();

    let mut found = false;
    for group in &mut outline.column_groups {
        let is_button = match outline.settings.summary_col_position {
            SummaryPosition::BelowRight => group.end_col == col,
            SummaryPosition::AboveLeft => group.start_col == col,
        };
        if is_button && !group.collapsed {
            group.collapsed = true;
            found = true;
        }
    }

    if !found {
        return GroupResult::err("No expandable group at this column");
    }

    let after_hidden = outline.get_hidden_cols();
    let newly_hidden: Vec<u32> = after_hidden.difference(&before_hidden).cloned().collect();

    GroupResult::ok_with_changes(outline.clone(), Vec::new(), newly_hidden)
}

/// Expand a column group.
/// Only expands the group whose button (summary) column matches.
#[tauri::command]
pub fn expand_column_group(
    state: State<AppState>,
    col: u32,
) -> GroupResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut outlines = state.outlines.lock().unwrap();

    let outline = match outlines.get_mut(&active_sheet) {
        Some(o) => o,
        None => return GroupResult::err("No outline exists for this sheet"),
    };

    let before_hidden = outline.get_hidden_cols();

    let mut found = false;
    for group in &mut outline.column_groups {
        let is_button = match outline.settings.summary_col_position {
            SummaryPosition::BelowRight => group.end_col == col,
            SummaryPosition::AboveLeft => group.start_col == col,
        };
        if is_button && group.collapsed {
            group.collapsed = false;
            found = true;
        }
    }

    if !found {
        return GroupResult::err("No collapsible group at this column");
    }

    let after_hidden = outline.get_hidden_cols();
    let newly_visible: Vec<u32> = before_hidden.difference(&after_hidden).cloned().collect();

    GroupResult::ok_with_changes(outline.clone(), Vec::new(), newly_visible)
}

/// Show/hide rows and columns up to a specific outline level
#[tauri::command]
pub fn show_outline_level(
    state: State<AppState>,
    row_level: Option<u8>,
    col_level: Option<u8>,
) -> GroupResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut outlines = state.outlines.lock().unwrap();

    let outline = match outlines.get_mut(&active_sheet) {
        Some(o) => o,
        None => return GroupResult::err("No outline exists for this sheet"),
    };

    let before_row_hidden = outline.get_hidden_rows();
    let before_col_hidden = outline.get_hidden_cols();

    // Apply row level
    if let Some(level) = row_level {
        for group in &mut outline.row_groups {
            group.collapsed = group.level > level;
        }
    }

    // Apply column level
    if let Some(level) = col_level {
        for group in &mut outline.column_groups {
            group.collapsed = group.level > level;
        }
    }

    let after_row_hidden = outline.get_hidden_rows();
    let after_col_hidden = outline.get_hidden_cols();

    let row_changes: Vec<u32> = before_row_hidden
        .symmetric_difference(&after_row_hidden)
        .cloned()
        .collect();
    let col_changes: Vec<u32> = before_col_hidden
        .symmetric_difference(&after_col_hidden)
        .cloned()
        .collect();

    GroupResult::ok_with_changes(outline.clone(), row_changes, col_changes)
}

/// Get outline info for a viewport
#[tauri::command]
pub fn get_outline_info(
    state: State<AppState>,
    start_row: u32,
    end_row: u32,
    start_col: u32,
    end_col: u32,
) -> OutlineInfo {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let outlines = state.outlines.lock().unwrap();

    let outline = match outlines.get(&active_sheet) {
        Some(o) => o,
        None => {
            return OutlineInfo {
                row_symbols: Vec::new(),
                col_symbols: Vec::new(),
                max_row_level: 0,
                max_col_level: 0,
                settings: OutlineSettings::default(),
            };
        }
    };

    let hidden_rows = outline.get_hidden_rows();
    let hidden_cols = outline.get_hidden_cols();

    // Build row symbols
    let row_symbols: Vec<RowOutlineSymbol> = (start_row..=end_row)
        .map(|row| {
            let level = outline.get_row_level(row);
            let is_collapsed = outline.row_groups.iter().any(|g| g.contains_row(row) && g.collapsed);
            let is_button_row = outline.row_groups.iter().any(|g| {
                match outline.settings.summary_row_position {
                    SummaryPosition::BelowRight => g.end_row == row,
                    SummaryPosition::AboveLeft => g.start_row == row,
                }
            });

            RowOutlineSymbol {
                row,
                level,
                is_collapsed,
                is_button_row,
                is_hidden: hidden_rows.contains(&row),
            }
        })
        .collect();

    // Build column symbols
    let col_symbols: Vec<ColOutlineSymbol> = (start_col..=end_col)
        .map(|col| {
            let level = outline.get_col_level(col);
            let is_collapsed = outline.column_groups.iter().any(|g| g.contains_col(col) && g.collapsed);
            let is_button_col = outline.column_groups.iter().any(|g| {
                match outline.settings.summary_col_position {
                    SummaryPosition::BelowRight => g.end_col == col,
                    SummaryPosition::AboveLeft => g.start_col == col,
                }
            });

            ColOutlineSymbol {
                col,
                level,
                is_collapsed,
                is_button_col,
                is_hidden: hidden_cols.contains(&col),
            }
        })
        .collect();

    OutlineInfo {
        row_symbols,
        col_symbols,
        max_row_level: outline.max_row_level,
        max_col_level: outline.max_col_level,
        settings: outline.settings.clone(),
    }
}

/// Get outline settings
#[tauri::command]
pub fn get_outline_settings(state: State<AppState>) -> OutlineSettings {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let outlines = state.outlines.lock().unwrap();

    outlines
        .get(&active_sheet)
        .map(|o| o.settings.clone())
        .unwrap_or_default()
}

/// Set outline settings
#[tauri::command]
pub fn set_outline_settings(
    state: State<AppState>,
    settings: OutlineSettings,
) -> GroupResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut outlines = state.outlines.lock().unwrap();

    let outline = outlines.entry(active_sheet).or_insert_with(SheetOutline::new);
    outline.settings = settings;

    GroupResult::ok(outline.clone())
}

/// Clear all outline/grouping for the current sheet
#[tauri::command]
pub fn clear_outline(state: State<AppState>) -> GroupResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut outlines = state.outlines.lock().unwrap();

    let old_outline = outlines.remove(&active_sheet);

    let (row_changes, col_changes) = match old_outline {
        Some(o) => {
            let rows: Vec<u32> = o.get_hidden_rows().into_iter().collect();
            let cols: Vec<u32> = o.get_hidden_cols().into_iter().collect();
            (rows, cols)
        }
        None => (Vec::new(), Vec::new()),
    };

    GroupResult::ok_with_changes(SheetOutline::new(), row_changes, col_changes)
}

/// Check if a row is hidden due to grouping
#[tauri::command]
pub fn is_row_hidden_by_group(
    state: State<AppState>,
    row: u32,
) -> bool {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let outlines = state.outlines.lock().unwrap();

    outlines
        .get(&active_sheet)
        .map(|o| o.get_hidden_rows().contains(&row))
        .unwrap_or(false)
}

/// Check if a column is hidden due to grouping
#[tauri::command]
pub fn is_col_hidden_by_group(
    state: State<AppState>,
    col: u32,
) -> bool {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let outlines = state.outlines.lock().unwrap();

    outlines
        .get(&active_sheet)
        .map(|o| o.get_hidden_cols().contains(&col))
        .unwrap_or(false)
}

/// Get all hidden rows due to grouping
#[tauri::command]
pub fn get_hidden_rows_by_group(state: State<AppState>) -> Vec<u32> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let outlines = state.outlines.lock().unwrap();

    outlines
        .get(&active_sheet)
        .map(|o| o.get_hidden_rows().into_iter().collect())
        .unwrap_or_default()
}

/// Get all hidden columns due to grouping
#[tauri::command]
pub fn get_hidden_cols_by_group(state: State<AppState>) -> Vec<u32> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let outlines = state.outlines.lock().unwrap();

    outlines
        .get(&active_sheet)
        .map(|o| o.get_hidden_cols().into_iter().collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_row_group_new() {
        let group = RowGroup::new(5, 10, 1);
        assert_eq!(group.start_row, 5);
        assert_eq!(group.end_row, 10);
        assert_eq!(group.level, 1);
        assert!(!group.collapsed);
    }

    #[test]
    fn test_row_group_normalize_order() {
        let group = RowGroup::new(10, 5, 1);
        assert_eq!(group.start_row, 5);
        assert_eq!(group.end_row, 10);
    }

    #[test]
    fn test_row_group_max_level() {
        let group = RowGroup::new(0, 10, 100);
        assert_eq!(group.level, MAX_OUTLINE_LEVEL);
    }

    #[test]
    fn test_row_group_contains() {
        let group = RowGroup::new(5, 10, 1);
        assert!(!group.contains_row(4));
        assert!(group.contains_row(5));
        assert!(group.contains_row(7));
        assert!(group.contains_row(10));
        assert!(!group.contains_row(11));
    }

    #[test]
    fn test_sheet_outline_row_level() {
        let mut outline = SheetOutline::new();
        outline.row_groups.push(RowGroup::new(0, 5, 1));
        outline.row_groups.push(RowGroup::new(2, 4, 2));

        assert_eq!(outline.get_row_level(0), 1);
        assert_eq!(outline.get_row_level(2), 2);
        assert_eq!(outline.get_row_level(3), 2);
        assert_eq!(outline.get_row_level(5), 1);
        assert_eq!(outline.get_row_level(6), 0);
    }

    #[test]
    fn test_sheet_outline_hidden_rows() {
        let mut outline = SheetOutline::new();
        // Default summary position is BelowRight, so end_row is the summary row
        outline.row_groups.push(RowGroup {
            start_row: 1,
            end_row: 3,
            level: 1,
            collapsed: true,
        });
        outline.row_groups.push(RowGroup {
            start_row: 5,
            end_row: 7,
            level: 1,
            collapsed: false,
        });

        let hidden = outline.get_hidden_rows();
        assert!(hidden.contains(&1));
        assert!(hidden.contains(&2));
        // end_row (3) is the summary row and must stay visible
        assert!(!hidden.contains(&3));
        assert!(!hidden.contains(&5));
        assert!(!hidden.contains(&6));
    }

    #[test]
    fn test_summary_position_default() {
        assert_eq!(SummaryPosition::default(), SummaryPosition::BelowRight);
    }

    #[test]
    fn test_column_group_contains() {
        let group = ColumnGroup::new(2, 5, 1);
        assert!(!group.contains_col(1));
        assert!(group.contains_col(2));
        assert!(group.contains_col(4));
        assert!(group.contains_col(5));
        assert!(!group.contains_col(6));
    }
}
