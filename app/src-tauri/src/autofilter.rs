//! FILENAME: app/src-tauri/src/autofilter.rs
//! PURPOSE: AutoFilter for worksheets - Excel-compatible filtering of data ranges.
//! CONTEXT: Implements FilterOn types, FilterCriteria, DynamicFilterCriteria,
//! and AutoFilter management with full Excel API compatibility.

use crate::api_types::CellData;
use crate::{format_cell_value, AppState};
use engine::{CellValue, Grid};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tauri::State;

// ============================================================================
// FILTER ON ENUM
// ============================================================================

/// Specifies what aspect of the cell to filter on.
/// Matches Excel's FilterOn enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FilterOn {
    /// Filter by cell values (default)
    Values,
    /// Filter by top N items
    TopItems,
    /// Filter by top N percent
    TopPercent,
    /// Filter by bottom N items
    BottomItems,
    /// Filter by bottom N percent
    BottomPercent,
    /// Filter by cell background color
    CellColor,
    /// Filter by font color
    FontColor,
    /// Filter using dynamic criteria (dates, averages)
    Dynamic,
    /// Custom filter with wildcards or operators
    Custom,
    /// Filter by cell icon (conditional formatting)
    Icon,
}

impl Default for FilterOn {
    fn default() -> Self {
        FilterOn::Values
    }
}

// ============================================================================
// DYNAMIC FILTER CRITERIA
// ============================================================================

/// Dynamic filter criteria for date and average-based filtering.
/// Matches Excel's DynamicFilterCriteria enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DynamicFilterCriteria {
    /// Filter for above average values
    AboveAverage,
    /// Filter for below average values
    BelowAverage,
    /// Filter for today's date
    Today,
    /// Filter for tomorrow's date
    Tomorrow,
    /// Filter for yesterday's date
    Yesterday,
    /// Filter for dates in this week
    ThisWeek,
    /// Filter for dates in last week
    LastWeek,
    /// Filter for dates in next week
    NextWeek,
    /// Filter for dates in this month
    ThisMonth,
    /// Filter for dates in last month
    LastMonth,
    /// Filter for dates in next month
    NextMonth,
    /// Filter for dates in this quarter
    ThisQuarter,
    /// Filter for dates in last quarter
    LastQuarter,
    /// Filter for dates in next quarter
    NextQuarter,
    /// Filter for dates in this year
    ThisYear,
    /// Filter for dates in last year
    LastYear,
    /// Filter for dates in next year
    NextYear,
    /// Filter for dates from start of year to today
    YearToDate,
    /// Filter for dates in January
    AllDatesInPeriodJanuary,
    /// Filter for dates in February
    AllDatesInPeriodFebruary,
    /// Filter for dates in March
    AllDatesInPeriodMarch,
    /// Filter for dates in April
    AllDatesInPeriodApril,
    /// Filter for dates in May
    AllDatesInPeriodMay,
    /// Filter for dates in June
    AllDatesInPeriodJune,
    /// Filter for dates in July
    AllDatesInPeriodJuly,
    /// Filter for dates in August
    AllDatesInPeriodAugust,
    /// Filter for dates in September
    AllDatesInPeriodSeptember,
    /// Filter for dates in October
    AllDatesInPeriodOctober,
    /// Filter for dates in November
    AllDatesInPeriodNovember,
    /// Filter for dates in December
    AllDatesInPeriodDecember,
    /// Filter for dates in Q1
    AllDatesInPeriodQuarter1,
    /// Filter for dates in Q2
    AllDatesInPeriodQuarter2,
    /// Filter for dates in Q3
    AllDatesInPeriodQuarter3,
    /// Filter for dates in Q4
    AllDatesInPeriodQuarter4,
    /// Unknown/default
    Unknown,
}

impl Default for DynamicFilterCriteria {
    fn default() -> Self {
        DynamicFilterCriteria::Unknown
    }
}

// ============================================================================
// FILTER OPERATOR
// ============================================================================

/// Operator for combining criterion1 and criterion2 in custom filters.
/// Matches Excel's FilterOperator enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FilterOperator {
    /// Both criteria must be true
    And,
    /// Either criterion can be true
    Or,
}

impl Default for FilterOperator {
    fn default() -> Self {
        FilterOperator::And
    }
}

// ============================================================================
// ICON FILTER
// ============================================================================

/// Icon filter criteria for conditional formatting icons.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IconFilter {
    /// The icon set name (e.g., "3Arrows", "4TrafficLights")
    pub icon_set: String,
    /// The icon index within the set (0-based)
    pub icon_index: u32,
}

// ============================================================================
// FILTER CRITERIA
// ============================================================================

/// Filter criteria for a single column.
/// Matches Excel's FilterCriteria interface.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterCriteria {
    /// First criterion value (string for values, number for top/bottom items/percent)
    /// For custom filters, this is the first comparison value (e.g., "=*e" for ends with "e")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub criterion1: Option<String>,

    /// Second criterion value (used with custom filters when operator is specified)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub criterion2: Option<String>,

    /// What aspect of the cell to filter on
    #[serde(default)]
    pub filter_on: FilterOn,

    /// Dynamic filter criteria (when filter_on is Dynamic)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dynamic_criteria: Option<DynamicFilterCriteria>,

    /// Operator for combining criterion1 and criterion2 (for custom filters)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operator: Option<FilterOperator>,

    /// Color to filter by (CSS color string, when filter_on is CellColor or FontColor)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,

    /// Icon to filter by (when filter_on is Icon)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<IconFilter>,

    /// Specific values to filter (when filter_on is Values)
    /// If empty, all values are shown
    #[serde(default)]
    pub values: Vec<String>,

    /// Values to exclude from the filter (blanks handling)
    #[serde(default)]
    pub filter_out_blanks: bool,
}

impl Default for FilterCriteria {
    fn default() -> Self {
        FilterCriteria {
            criterion1: None,
            criterion2: None,
            filter_on: FilterOn::Values,
            dynamic_criteria: None,
            operator: None,
            color: None,
            icon: None,
            values: Vec::new(),
            filter_out_blanks: false,
        }
    }
}

// ============================================================================
// AUTO FILTER DEFINITION
// ============================================================================

/// Column filter state within an AutoFilter.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnFilter {
    /// Column index relative to the AutoFilter range (0-based)
    pub column_index: u32,
    /// The filter criteria for this column
    pub criteria: FilterCriteria,
}

/// AutoFilter definition for a worksheet.
/// Each sheet can have at most one AutoFilter.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoFilter {
    /// Start row of the AutoFilter range (0-based, typically header row)
    pub start_row: u32,
    /// Start column of the AutoFilter range (0-based)
    pub start_col: u32,
    /// End row of the AutoFilter range (0-based)
    pub end_row: u32,
    /// End column of the AutoFilter range (0-based)
    pub end_col: u32,
    /// Filter criteria for each column (keyed by relative column index)
    pub column_filters: HashMap<u32, ColumnFilter>,
    /// Set of hidden rows (filtered out)
    #[serde(default)]
    pub hidden_rows: HashSet<u32>,
    /// Whether the AutoFilter is enabled (showing filter dropdowns)
    pub enabled: bool,
}

impl AutoFilter {
    /// Create a new AutoFilter for a range.
    pub fn new(start_row: u32, start_col: u32, end_row: u32, end_col: u32) -> Self {
        AutoFilter {
            start_row: start_row.min(end_row),
            start_col: start_col.min(end_col),
            end_row: start_row.max(end_row),
            end_col: start_col.max(end_col),
            column_filters: HashMap::new(),
            hidden_rows: HashSet::new(),
            enabled: true,
        }
    }

    /// Check if the AutoFilter has any active filter criteria.
    pub fn is_data_filtered(&self) -> bool {
        !self.column_filters.is_empty()
    }

    /// Get the number of columns in the AutoFilter range.
    pub fn column_count(&self) -> u32 {
        self.end_col - self.start_col + 1
    }

    /// Get the number of rows in the AutoFilter range (including header).
    pub fn row_count(&self) -> u32 {
        self.end_row - self.start_row + 1
    }
}

// ============================================================================
// STORAGE
// ============================================================================

/// Storage for AutoFilters per sheet.
/// Key is sheet index, value is the AutoFilter for that sheet (if any).
pub type AutoFilterStorage = HashMap<usize, AutoFilter>;

// ============================================================================
// RESULT TYPES
// ============================================================================

/// Result of an AutoFilter operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoFilterResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_filter: Option<AutoFilterInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Rows that are now hidden (filtered out)
    #[serde(default)]
    pub hidden_rows: Vec<u32>,
    /// Rows that are now visible
    #[serde(default)]
    pub visible_rows: Vec<u32>,
}

/// Serializable AutoFilter info for the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoFilterInfo {
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
    pub enabled: bool,
    pub is_data_filtered: bool,
    /// Filter criteria array (indexed by column)
    pub criteria: Vec<Option<FilterCriteria>>,
}

impl From<&AutoFilter> for AutoFilterInfo {
    fn from(af: &AutoFilter) -> Self {
        let col_count = af.column_count() as usize;
        let mut criteria = vec![None; col_count];

        for (col_idx, col_filter) in &af.column_filters {
            let idx = *col_idx as usize;
            if idx < col_count {
                criteria[idx] = Some(col_filter.criteria.clone());
            }
        }

        AutoFilterInfo {
            start_row: af.start_row,
            start_col: af.start_col,
            end_row: af.end_row,
            end_col: af.end_col,
            enabled: af.enabled,
            is_data_filtered: af.is_data_filtered(),
            criteria,
        }
    }
}

/// Parameters for applying an AutoFilter.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyAutoFilterParams {
    /// Start row (0-based)
    pub start_row: u32,
    /// Start column (0-based)
    pub start_col: u32,
    /// End row (0-based)
    pub end_row: u32,
    /// End column (0-based)
    pub end_col: u32,
    /// Column index to apply filter to (relative to start_col, 0-based)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column_index: Option<u32>,
    /// Filter criteria for the column
    #[serde(skip_serializing_if = "Option::is_none")]
    pub criteria: Option<FilterCriteria>,
}

/// Result of getting unique values for a column.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UniqueValuesResult {
    pub success: bool,
    pub values: Vec<UniqueValue>,
    pub has_blanks: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A unique value in a column with its count.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UniqueValue {
    pub value: String,
    pub count: u32,
}

// ============================================================================
// FILTER LOGIC
// ============================================================================

/// Get the display value of a cell for filtering purposes.
fn get_cell_filter_value(grid: &Grid, row: u32, col: u32, style_registry: &engine::StyleRegistry) -> String {
    if let Some(cell) = grid.cells.get(&(row, col)) {
        let style = style_registry.get(cell.style_index);
        format_cell_value(&cell.value, style)
    } else {
        String::new()
    }
}

/// Get the raw value of a cell for numeric comparisons.
fn get_cell_numeric_value(grid: &Grid, row: u32, col: u32) -> Option<f64> {
    if let Some(cell) = grid.cells.get(&(row, col)) {
        match &cell.value {
            CellValue::Number(n) => Some(*n),
            CellValue::Text(s) => s.parse::<f64>().ok(),
            _ => None,
        }
    } else {
        None
    }
}

/// Check if a cell value matches a custom filter criterion.
fn matches_custom_criterion(value: &str, criterion: &str) -> bool {
    let criterion = criterion.trim();

    // Handle operators
    if criterion.starts_with(">=") {
        if let (Ok(val), Ok(crit)) = (value.parse::<f64>(), criterion[2..].trim().parse::<f64>()) {
            return val >= crit;
        }
        return value >= criterion[2..].trim();
    }
    if criterion.starts_with("<=") {
        if let (Ok(val), Ok(crit)) = (value.parse::<f64>(), criterion[2..].trim().parse::<f64>()) {
            return val <= crit;
        }
        return value <= criterion[2..].trim();
    }
    if criterion.starts_with("<>") || criterion.starts_with("!=") {
        let crit = criterion[2..].trim();
        return !value.eq_ignore_ascii_case(crit);
    }
    if criterion.starts_with('>') {
        if let (Ok(val), Ok(crit)) = (value.parse::<f64>(), criterion[1..].trim().parse::<f64>()) {
            return val > crit;
        }
        return value > criterion[1..].trim();
    }
    if criterion.starts_with('<') {
        if let (Ok(val), Ok(crit)) = (value.parse::<f64>(), criterion[1..].trim().parse::<f64>()) {
            return val < crit;
        }
        return value < criterion[1..].trim();
    }
    if criterion.starts_with('=') {
        let pattern = criterion[1..].trim();
        return matches_wildcard(value, pattern);
    }

    // Default: exact match or wildcard
    matches_wildcard(value, criterion)
}

/// Check if a value matches a wildcard pattern (* and ? supported).
fn matches_wildcard(value: &str, pattern: &str) -> bool {
    let value_lower = value.to_lowercase();
    let pattern_lower = pattern.to_lowercase();

    // No wildcards: exact match
    if !pattern_lower.contains('*') && !pattern_lower.contains('?') {
        return value_lower == pattern_lower;
    }

    // Convert to regex-like matching
    wildcard_match(&value_lower, &pattern_lower)
}

/// Simple wildcard matching (supports * and ?).
fn wildcard_match(value: &str, pattern: &str) -> bool {
    let v: Vec<char> = value.chars().collect();
    let p: Vec<char> = pattern.chars().collect();

    fn helper(v: &[char], vi: usize, p: &[char], pi: usize) -> bool {
        if pi == p.len() {
            return vi == v.len();
        }
        if p[pi] == '*' {
            // * matches zero or more characters
            for i in vi..=v.len() {
                if helper(v, i, p, pi + 1) {
                    return true;
                }
            }
            return false;
        }
        if vi < v.len() && (p[pi] == '?' || p[pi] == v[vi]) {
            return helper(v, vi + 1, p, pi + 1);
        }
        false
    }

    helper(&v, 0, &p, 0)
}

/// Calculate average of numeric values in a column.
fn calculate_column_average(grid: &Grid, col: u32, start_row: u32, end_row: u32) -> Option<f64> {
    let mut sum = 0.0;
    let mut count = 0;

    for row in start_row..=end_row {
        if let Some(cell) = grid.cells.get(&(row, col)) {
            if let CellValue::Number(n) = cell.value {
                sum += n;
                count += 1;
            }
        }
    }

    if count > 0 {
        Some(sum / count as f64)
    } else {
        None
    }
}

/// Check if a row should be visible based on all column filters.
fn should_row_be_visible(
    grid: &Grid,
    style_registry: &engine::StyleRegistry,
    row: u32,
    auto_filter: &AutoFilter,
) -> bool {
    // Header row is always visible
    if row == auto_filter.start_row {
        return true;
    }

    // Check each column filter
    for (rel_col, col_filter) in &auto_filter.column_filters {
        let abs_col = auto_filter.start_col + rel_col;
        let cell_value = get_cell_filter_value(grid, row, abs_col, style_registry);
        let is_blank = cell_value.is_empty();

        let criteria = &col_filter.criteria;

        // Handle blank filtering
        if is_blank && criteria.filter_out_blanks {
            return false;
        }

        match criteria.filter_on {
            FilterOn::Values => {
                if !criteria.values.is_empty() {
                    // Check if cell value is in the allowed values
                    let cell_upper = cell_value.to_uppercase();
                    let found = criteria.values.iter().any(|v| {
                        if v == "(Blanks)" {
                            is_blank
                        } else {
                            v.to_uppercase() == cell_upper
                        }
                    });
                    if !found {
                        return false;
                    }
                }
            }
            FilterOn::Custom => {
                let matches_c1 = criteria.criterion1.as_ref()
                    .map(|c| matches_custom_criterion(&cell_value, c))
                    .unwrap_or(true);

                let matches_c2 = criteria.criterion2.as_ref()
                    .map(|c| matches_custom_criterion(&cell_value, c))
                    .unwrap_or(true);

                let passes = match criteria.operator.unwrap_or(FilterOperator::And) {
                    FilterOperator::And => matches_c1 && matches_c2,
                    FilterOperator::Or => matches_c1 || matches_c2,
                };

                if !passes {
                    return false;
                }
            }
            FilterOn::TopItems | FilterOn::TopPercent | FilterOn::BottomItems | FilterOn::BottomPercent => {
                // These filters are applied during reapply, not per-row
                // The hidden_rows set is computed separately
            }
            FilterOn::Dynamic => {
                if let Some(dyn_criteria) = criteria.dynamic_criteria {
                    match dyn_criteria {
                        DynamicFilterCriteria::AboveAverage => {
                            if let (Some(value), Some(avg)) = (
                                get_cell_numeric_value(grid, row, abs_col),
                                calculate_column_average(grid, abs_col, auto_filter.start_row + 1, auto_filter.end_row),
                            ) {
                                if value <= avg {
                                    return false;
                                }
                            } else {
                                return false;
                            }
                        }
                        DynamicFilterCriteria::BelowAverage => {
                            if let (Some(value), Some(avg)) = (
                                get_cell_numeric_value(grid, row, abs_col),
                                calculate_column_average(grid, abs_col, auto_filter.start_row + 1, auto_filter.end_row),
                            ) {
                                if value >= avg {
                                    return false;
                                }
                            } else {
                                return false;
                            }
                        }
                        // TODO: Implement date-based dynamic filters
                        _ => {}
                    }
                }
            }
            FilterOn::CellColor | FilterOn::FontColor | FilterOn::Icon => {
                // TODO: Implement color and icon filtering when we have style access
            }
        }
    }

    true
}

/// Apply top/bottom N filters and return the set of rows to hide.
fn apply_top_bottom_filter(
    grid: &Grid,
    auto_filter: &AutoFilter,
    rel_col: u32,
    criteria: &FilterCriteria,
) -> HashSet<u32> {
    let abs_col = auto_filter.start_col + rel_col;
    let mut hidden = HashSet::new();

    // Collect all numeric values with their rows
    let mut values: Vec<(u32, f64)> = Vec::new();
    for row in (auto_filter.start_row + 1)..=auto_filter.end_row {
        if let Some(n) = get_cell_numeric_value(grid, row, abs_col) {
            values.push((row, n));
        }
    }

    if values.is_empty() {
        return hidden;
    }

    let n: usize = criteria.criterion1
        .as_ref()
        .and_then(|s| s.parse().ok())
        .unwrap_or(10);

    let total = values.len();
    let keep_count = match criteria.filter_on {
        FilterOn::TopItems => n.min(total),
        FilterOn::BottomItems => n.min(total),
        FilterOn::TopPercent => ((n as f64 / 100.0) * total as f64).ceil() as usize,
        FilterOn::BottomPercent => ((n as f64 / 100.0) * total as f64).ceil() as usize,
        _ => total,
    };

    // Sort values
    match criteria.filter_on {
        FilterOn::TopItems | FilterOn::TopPercent => {
            values.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        }
        FilterOn::BottomItems | FilterOn::BottomPercent => {
            values.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        }
        _ => {}
    }

    // Mark rows to hide (those not in the top/bottom N)
    for (i, (row, _)) in values.iter().enumerate() {
        if i >= keep_count {
            hidden.insert(*row);
        }
    }

    hidden
}

/// Recompute hidden rows based on all column filters.
fn recompute_hidden_rows(
    grid: &Grid,
    style_registry: &engine::StyleRegistry,
    auto_filter: &mut AutoFilter,
) {
    let mut hidden = HashSet::new();

    // First pass: apply top/bottom filters
    for (rel_col, col_filter) in &auto_filter.column_filters {
        match col_filter.criteria.filter_on {
            FilterOn::TopItems | FilterOn::TopPercent | FilterOn::BottomItems | FilterOn::BottomPercent => {
                let top_bottom_hidden = apply_top_bottom_filter(grid, auto_filter, *rel_col, &col_filter.criteria);
                hidden.extend(top_bottom_hidden);
            }
            _ => {}
        }
    }

    // Second pass: check each row against all other filters
    for row in (auto_filter.start_row + 1)..=auto_filter.end_row {
        if !should_row_be_visible(grid, style_registry, row, auto_filter) {
            hidden.insert(row);
        }
    }

    auto_filter.hidden_rows = hidden;
}

// ============================================================================
// TAURI COMMANDS
// ============================================================================

/// Apply an AutoFilter to a range, optionally with initial column filter.
#[tauri::command]
pub fn apply_auto_filter(
    state: State<AppState>,
    params: ApplyAutoFilterParams,
) -> AutoFilterResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut auto_filters = state.auto_filters.lock().unwrap();
    let grids = state.grids.lock().unwrap();
    let style_registry = state.style_registry.lock().unwrap();

    // Normalize coordinates
    let start_row = params.start_row.min(params.end_row);
    let end_row = params.start_row.max(params.end_row);
    let start_col = params.start_col.min(params.end_col);
    let end_col = params.start_col.max(params.end_col);

    // Get or create the AutoFilter for this sheet
    let auto_filter = auto_filters.entry(active_sheet).or_insert_with(|| {
        AutoFilter::new(start_row, start_col, end_row, end_col)
    });

    // Update the range if it differs
    auto_filter.start_row = start_row;
    auto_filter.start_col = start_col;
    auto_filter.end_row = end_row;
    auto_filter.end_col = end_col;
    auto_filter.enabled = true;

    // Apply column filter if specified
    if let (Some(col_idx), Some(criteria)) = (params.column_index, params.criteria) {
        if col_idx <= end_col - start_col {
            auto_filter.column_filters.insert(col_idx, ColumnFilter {
                column_index: col_idx,
                criteria,
            });
        }
    }

    // Recompute hidden rows
    if active_sheet < grids.len() {
        recompute_hidden_rows(&grids[active_sheet], &style_registry, auto_filter);
    }

    let hidden_rows: Vec<u32> = auto_filter.hidden_rows.iter().copied().collect();
    let all_rows: HashSet<u32> = ((auto_filter.start_row + 1)..=auto_filter.end_row).collect();
    let visible_rows: Vec<u32> = all_rows.difference(&auto_filter.hidden_rows).copied().collect();

    AutoFilterResult {
        success: true,
        auto_filter: Some((&*auto_filter).into()),
        error: None,
        hidden_rows,
        visible_rows,
    }
}

/// Clear filter criteria for a specific column.
#[tauri::command]
pub fn clear_column_criteria(
    state: State<AppState>,
    column_index: u32,
) -> AutoFilterResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut auto_filters = state.auto_filters.lock().unwrap();
    let grids = state.grids.lock().unwrap();
    let style_registry = state.style_registry.lock().unwrap();

    if let Some(auto_filter) = auto_filters.get_mut(&active_sheet) {
        auto_filter.column_filters.remove(&column_index);

        // Recompute hidden rows
        if active_sheet < grids.len() {
            recompute_hidden_rows(&grids[active_sheet], &style_registry, auto_filter);
        }

        let hidden_rows: Vec<u32> = auto_filter.hidden_rows.iter().copied().collect();
        let all_rows: HashSet<u32> = ((auto_filter.start_row + 1)..=auto_filter.end_row).collect();
        let visible_rows: Vec<u32> = all_rows.difference(&auto_filter.hidden_rows).copied().collect();

        AutoFilterResult {
            success: true,
            auto_filter: Some((&*auto_filter).into()),
            error: None,
            hidden_rows,
            visible_rows,
        }
    } else {
        AutoFilterResult {
            success: false,
            auto_filter: None,
            error: Some("No AutoFilter exists for this sheet".to_string()),
            hidden_rows: Vec::new(),
            visible_rows: Vec::new(),
        }
    }
}

/// Clear all filter criteria (but keep the AutoFilter range).
#[tauri::command]
pub fn clear_auto_filter_criteria(
    state: State<AppState>,
) -> AutoFilterResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut auto_filters = state.auto_filters.lock().unwrap();

    if let Some(auto_filter) = auto_filters.get_mut(&active_sheet) {
        auto_filter.column_filters.clear();
        auto_filter.hidden_rows.clear();

        let all_rows: Vec<u32> = ((auto_filter.start_row + 1)..=auto_filter.end_row).collect();

        AutoFilterResult {
            success: true,
            auto_filter: Some((&*auto_filter).into()),
            error: None,
            hidden_rows: Vec::new(),
            visible_rows: all_rows,
        }
    } else {
        AutoFilterResult {
            success: false,
            auto_filter: None,
            error: Some("No AutoFilter exists for this sheet".to_string()),
            hidden_rows: Vec::new(),
            visible_rows: Vec::new(),
        }
    }
}

/// Reapply the AutoFilter (refresh filtering with current data).
#[tauri::command]
pub fn reapply_auto_filter(
    state: State<AppState>,
) -> AutoFilterResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut auto_filters = state.auto_filters.lock().unwrap();
    let grids = state.grids.lock().unwrap();
    let style_registry = state.style_registry.lock().unwrap();

    if let Some(auto_filter) = auto_filters.get_mut(&active_sheet) {
        // Recompute hidden rows
        if active_sheet < grids.len() {
            recompute_hidden_rows(&grids[active_sheet], &style_registry, auto_filter);
        }

        let hidden_rows: Vec<u32> = auto_filter.hidden_rows.iter().copied().collect();
        let all_rows: HashSet<u32> = ((auto_filter.start_row + 1)..=auto_filter.end_row).collect();
        let visible_rows: Vec<u32> = all_rows.difference(&auto_filter.hidden_rows).copied().collect();

        AutoFilterResult {
            success: true,
            auto_filter: Some((&*auto_filter).into()),
            error: None,
            hidden_rows,
            visible_rows,
        }
    } else {
        AutoFilterResult {
            success: false,
            auto_filter: None,
            error: Some("No AutoFilter exists for this sheet".to_string()),
            hidden_rows: Vec::new(),
            visible_rows: Vec::new(),
        }
    }
}

/// Remove the AutoFilter from the sheet entirely.
#[tauri::command]
pub fn remove_auto_filter(
    state: State<AppState>,
) -> AutoFilterResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut auto_filters = state.auto_filters.lock().unwrap();

    if let Some(auto_filter) = auto_filters.remove(&active_sheet) {
        let all_rows: Vec<u32> = ((auto_filter.start_row + 1)..=auto_filter.end_row).collect();

        AutoFilterResult {
            success: true,
            auto_filter: None,
            error: None,
            hidden_rows: Vec::new(),
            visible_rows: all_rows,
        }
    } else {
        AutoFilterResult {
            success: true,
            auto_filter: None,
            error: None,
            hidden_rows: Vec::new(),
            visible_rows: Vec::new(),
        }
    }
}

/// Get the current AutoFilter for the active sheet.
#[tauri::command]
pub fn get_auto_filter(
    state: State<AppState>,
) -> Option<AutoFilterInfo> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let auto_filters = state.auto_filters.lock().unwrap();

    auto_filters.get(&active_sheet).map(|af| af.into())
}

/// Get the AutoFilter range for the active sheet.
#[tauri::command]
pub fn get_auto_filter_range(
    state: State<AppState>,
) -> Option<(u32, u32, u32, u32)> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let auto_filters = state.auto_filters.lock().unwrap();

    auto_filters.get(&active_sheet).map(|af| (af.start_row, af.start_col, af.end_row, af.end_col))
}

/// Get all hidden (filtered) rows for the active sheet.
#[tauri::command]
pub fn get_hidden_rows(
    state: State<AppState>,
) -> Vec<u32> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let auto_filters = state.auto_filters.lock().unwrap();

    auto_filters.get(&active_sheet)
        .map(|af| af.hidden_rows.iter().copied().collect())
        .unwrap_or_default()
}

/// Check if a specific row is hidden by the AutoFilter.
#[tauri::command]
pub fn is_row_filtered(
    state: State<AppState>,
    row: u32,
) -> bool {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let auto_filters = state.auto_filters.lock().unwrap();

    auto_filters.get(&active_sheet)
        .map(|af| af.hidden_rows.contains(&row))
        .unwrap_or(false)
}

/// Get unique values for a column in the AutoFilter range.
#[tauri::command]
pub fn get_filter_unique_values(
    state: State<AppState>,
    column_index: u32,
) -> UniqueValuesResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let auto_filters = state.auto_filters.lock().unwrap();
    let grids = state.grids.lock().unwrap();
    let style_registry = state.style_registry.lock().unwrap();

    let auto_filter = match auto_filters.get(&active_sheet) {
        Some(af) => af,
        None => {
            return UniqueValuesResult {
                success: false,
                values: Vec::new(),
                has_blanks: false,
                error: Some("No AutoFilter exists for this sheet".to_string()),
            };
        }
    };

    if active_sheet >= grids.len() {
        return UniqueValuesResult {
            success: false,
            values: Vec::new(),
            has_blanks: false,
            error: Some("Invalid sheet index".to_string()),
        };
    }

    let abs_col = auto_filter.start_col + column_index;
    if abs_col > auto_filter.end_col {
        return UniqueValuesResult {
            success: false,
            values: Vec::new(),
            has_blanks: false,
            error: Some("Column index out of range".to_string()),
        };
    }

    let grid = &grids[active_sheet];
    let mut value_counts: HashMap<String, u32> = HashMap::new();
    let mut has_blanks = false;

    // Skip header row, collect values from data rows
    for row in (auto_filter.start_row + 1)..=auto_filter.end_row {
        let value = get_cell_filter_value(grid, row, abs_col, &style_registry);
        if value.is_empty() {
            has_blanks = true;
        } else {
            *value_counts.entry(value).or_insert(0) += 1;
        }
    }

    let mut values: Vec<UniqueValue> = value_counts
        .into_iter()
        .map(|(value, count)| UniqueValue { value, count })
        .collect();

    // Sort by value
    values.sort_by(|a, b| a.value.cmp(&b.value));

    UniqueValuesResult {
        success: true,
        values,
        has_blanks,
        error: None,
    }
}

/// Set filter criteria for a specific column using value selection.
#[tauri::command]
pub fn set_column_filter_values(
    state: State<AppState>,
    column_index: u32,
    values: Vec<String>,
    include_blanks: bool,
) -> AutoFilterResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut auto_filters = state.auto_filters.lock().unwrap();
    let grids = state.grids.lock().unwrap();
    let style_registry = state.style_registry.lock().unwrap();

    if let Some(auto_filter) = auto_filters.get_mut(&active_sheet) {
        let mut filter_values = values;
        if include_blanks {
            filter_values.push("(Blanks)".to_string());
        }

        let criteria = FilterCriteria {
            filter_on: FilterOn::Values,
            values: filter_values,
            filter_out_blanks: !include_blanks,
            ..Default::default()
        };

        auto_filter.column_filters.insert(column_index, ColumnFilter {
            column_index,
            criteria,
        });

        // Recompute hidden rows
        if active_sheet < grids.len() {
            recompute_hidden_rows(&grids[active_sheet], &style_registry, auto_filter);
        }

        let hidden_rows: Vec<u32> = auto_filter.hidden_rows.iter().copied().collect();
        let all_rows: HashSet<u32> = ((auto_filter.start_row + 1)..=auto_filter.end_row).collect();
        let visible_rows: Vec<u32> = all_rows.difference(&auto_filter.hidden_rows).copied().collect();

        AutoFilterResult {
            success: true,
            auto_filter: Some((&*auto_filter).into()),
            error: None,
            hidden_rows,
            visible_rows,
        }
    } else {
        AutoFilterResult {
            success: false,
            auto_filter: None,
            error: Some("No AutoFilter exists for this sheet".to_string()),
            hidden_rows: Vec::new(),
            visible_rows: Vec::new(),
        }
    }
}

/// Set a custom filter for a specific column.
#[tauri::command]
pub fn set_column_custom_filter(
    state: State<AppState>,
    column_index: u32,
    criterion1: String,
    criterion2: Option<String>,
    operator: Option<FilterOperator>,
) -> AutoFilterResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut auto_filters = state.auto_filters.lock().unwrap();
    let grids = state.grids.lock().unwrap();
    let style_registry = state.style_registry.lock().unwrap();

    if let Some(auto_filter) = auto_filters.get_mut(&active_sheet) {
        let criteria = FilterCriteria {
            filter_on: FilterOn::Custom,
            criterion1: Some(criterion1),
            criterion2,
            operator,
            ..Default::default()
        };

        auto_filter.column_filters.insert(column_index, ColumnFilter {
            column_index,
            criteria,
        });

        // Recompute hidden rows
        if active_sheet < grids.len() {
            recompute_hidden_rows(&grids[active_sheet], &style_registry, auto_filter);
        }

        let hidden_rows: Vec<u32> = auto_filter.hidden_rows.iter().copied().collect();
        let all_rows: HashSet<u32> = ((auto_filter.start_row + 1)..=auto_filter.end_row).collect();
        let visible_rows: Vec<u32> = all_rows.difference(&auto_filter.hidden_rows).copied().collect();

        AutoFilterResult {
            success: true,
            auto_filter: Some((&*auto_filter).into()),
            error: None,
            hidden_rows,
            visible_rows,
        }
    } else {
        AutoFilterResult {
            success: false,
            auto_filter: None,
            error: Some("No AutoFilter exists for this sheet".to_string()),
            hidden_rows: Vec::new(),
            visible_rows: Vec::new(),
        }
    }
}

/// Set a top/bottom filter for a specific column.
#[tauri::command]
pub fn set_column_top_bottom_filter(
    state: State<AppState>,
    column_index: u32,
    filter_on: FilterOn,
    value: u32,
) -> AutoFilterResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut auto_filters = state.auto_filters.lock().unwrap();
    let grids = state.grids.lock().unwrap();
    let style_registry = state.style_registry.lock().unwrap();

    // Validate filter_on
    let valid_filter = matches!(
        filter_on,
        FilterOn::TopItems | FilterOn::TopPercent | FilterOn::BottomItems | FilterOn::BottomPercent
    );
    if !valid_filter {
        return AutoFilterResult {
            success: false,
            auto_filter: None,
            error: Some("Invalid filter_on value for top/bottom filter".to_string()),
            hidden_rows: Vec::new(),
            visible_rows: Vec::new(),
        };
    }

    if let Some(auto_filter) = auto_filters.get_mut(&active_sheet) {
        let criteria = FilterCriteria {
            filter_on,
            criterion1: Some(value.to_string()),
            ..Default::default()
        };

        auto_filter.column_filters.insert(column_index, ColumnFilter {
            column_index,
            criteria,
        });

        // Recompute hidden rows
        if active_sheet < grids.len() {
            recompute_hidden_rows(&grids[active_sheet], &style_registry, auto_filter);
        }

        let hidden_rows: Vec<u32> = auto_filter.hidden_rows.iter().copied().collect();
        let all_rows: HashSet<u32> = ((auto_filter.start_row + 1)..=auto_filter.end_row).collect();
        let visible_rows: Vec<u32> = all_rows.difference(&auto_filter.hidden_rows).copied().collect();

        AutoFilterResult {
            success: true,
            auto_filter: Some((&*auto_filter).into()),
            error: None,
            hidden_rows,
            visible_rows,
        }
    } else {
        AutoFilterResult {
            success: false,
            auto_filter: None,
            error: Some("No AutoFilter exists for this sheet".to_string()),
            hidden_rows: Vec::new(),
            visible_rows: Vec::new(),
        }
    }
}

/// Set a dynamic filter for a specific column.
#[tauri::command]
pub fn set_column_dynamic_filter(
    state: State<AppState>,
    column_index: u32,
    dynamic_criteria: DynamicFilterCriteria,
) -> AutoFilterResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut auto_filters = state.auto_filters.lock().unwrap();
    let grids = state.grids.lock().unwrap();
    let style_registry = state.style_registry.lock().unwrap();

    if let Some(auto_filter) = auto_filters.get_mut(&active_sheet) {
        let criteria = FilterCriteria {
            filter_on: FilterOn::Dynamic,
            dynamic_criteria: Some(dynamic_criteria),
            ..Default::default()
        };

        auto_filter.column_filters.insert(column_index, ColumnFilter {
            column_index,
            criteria,
        });

        // Recompute hidden rows
        if active_sheet < grids.len() {
            recompute_hidden_rows(&grids[active_sheet], &style_registry, auto_filter);
        }

        let hidden_rows: Vec<u32> = auto_filter.hidden_rows.iter().copied().collect();
        let all_rows: HashSet<u32> = ((auto_filter.start_row + 1)..=auto_filter.end_row).collect();
        let visible_rows: Vec<u32> = all_rows.difference(&auto_filter.hidden_rows).copied().collect();

        AutoFilterResult {
            success: true,
            auto_filter: Some((&*auto_filter).into()),
            error: None,
            hidden_rows,
            visible_rows,
        }
    } else {
        AutoFilterResult {
            success: false,
            auto_filter: None,
            error: Some("No AutoFilter exists for this sheet".to_string()),
            hidden_rows: Vec::new(),
            visible_rows: Vec::new(),
        }
    }
}
