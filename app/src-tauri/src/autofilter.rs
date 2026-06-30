//! FILENAME: app/src-tauri/src/autofilter.rs
//! PURPOSE: AutoFilter for worksheets - Excel-compatible filtering of data ranges.
//! CONTEXT: Implements FilterOn types, FilterCriteria, DynamicFilterCriteria,
//! and AutoFilter management with full Excel API compatibility.

use crate::{format_cell_value, AppState};
use chrono::{Datelike, Local, NaiveDate};
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
fn get_cell_filter_value(grid: &Grid, row: u32, col: u32, style_registry: &engine::StyleRegistry, locale: &engine::LocaleSettings) -> String {
    if let Some(cell) = grid.cells.get(&(row, col)) {
        let style = style_registry.get(cell.style_index);
        format_cell_value(&cell.value, style, locale)
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

/// Convert an Excel date serial number to a chrono NaiveDate.
/// Excel epoch: 1899-12-30 (serial 0). Day 1 = 1900-01-01.
fn serial_to_date(serial: f64) -> Option<NaiveDate> {
    let base = NaiveDate::from_ymd_opt(1899, 12, 30)?;
    let days = serial.floor() as i64;
    base.checked_add_signed(chrono::Duration::days(days))
}

/// Check if a cell's date serial number matches a date-based dynamic filter criterion.
fn matches_date_dynamic_filter(serial: f64, criteria: DynamicFilterCriteria) -> bool {
    let cell_date = match serial_to_date(serial) {
        Some(d) => d,
        None => return false,
    };

    let today = Local::now().date_naive();

    match criteria {
        DynamicFilterCriteria::Today => cell_date == today,
        DynamicFilterCriteria::Yesterday => {
            cell_date == today.pred_opt().unwrap_or(today)
        }
        DynamicFilterCriteria::Tomorrow => {
            cell_date == today.succ_opt().unwrap_or(today)
        }
        DynamicFilterCriteria::ThisWeek => {
            let weekday_num = today.weekday().num_days_from_monday();
            let week_start = today - chrono::Duration::days(weekday_num as i64);
            let week_end = week_start + chrono::Duration::days(6);
            cell_date >= week_start && cell_date <= week_end
        }
        DynamicFilterCriteria::LastWeek => {
            let weekday_num = today.weekday().num_days_from_monday();
            let this_week_start = today - chrono::Duration::days(weekday_num as i64);
            let last_week_start = this_week_start - chrono::Duration::days(7);
            let last_week_end = this_week_start - chrono::Duration::days(1);
            cell_date >= last_week_start && cell_date <= last_week_end
        }
        DynamicFilterCriteria::NextWeek => {
            let weekday_num = today.weekday().num_days_from_monday();
            let this_week_start = today - chrono::Duration::days(weekday_num as i64);
            let next_week_start = this_week_start + chrono::Duration::days(7);
            let next_week_end = next_week_start + chrono::Duration::days(6);
            cell_date >= next_week_start && cell_date <= next_week_end
        }
        DynamicFilterCriteria::ThisMonth => {
            cell_date.year() == today.year() && cell_date.month() == today.month()
        }
        DynamicFilterCriteria::LastMonth => {
            let (y, m) = if today.month() == 1 {
                (today.year() - 1, 12)
            } else {
                (today.year(), today.month() - 1)
            };
            cell_date.year() == y && cell_date.month() == m
        }
        DynamicFilterCriteria::NextMonth => {
            let (y, m) = if today.month() == 12 {
                (today.year() + 1, 1)
            } else {
                (today.year(), today.month() + 1)
            };
            cell_date.year() == y && cell_date.month() == m
        }
        DynamicFilterCriteria::ThisQuarter => {
            let q = (today.month() - 1) / 3;
            let cq = (cell_date.month() - 1) / 3;
            cell_date.year() == today.year() && cq == q
        }
        DynamicFilterCriteria::LastQuarter => {
            let q = (today.month() - 1) / 3;
            let (y, lq) = if q == 0 {
                (today.year() - 1, 3)
            } else {
                (today.year(), q - 1)
            };
            let cq = (cell_date.month() - 1) / 3;
            cell_date.year() == y && cq == lq
        }
        DynamicFilterCriteria::NextQuarter => {
            let q = (today.month() - 1) / 3;
            let (y, nq) = if q == 3 {
                (today.year() + 1, 0)
            } else {
                (today.year(), q + 1)
            };
            let cq = (cell_date.month() - 1) / 3;
            cell_date.year() == y && cq == nq
        }
        DynamicFilterCriteria::ThisYear => {
            cell_date.year() == today.year()
        }
        DynamicFilterCriteria::LastYear => {
            cell_date.year() == today.year() - 1
        }
        DynamicFilterCriteria::NextYear => {
            cell_date.year() == today.year() + 1
        }
        DynamicFilterCriteria::YearToDate => {
            let jan1 = NaiveDate::from_ymd_opt(today.year(), 1, 1).unwrap_or(today);
            cell_date >= jan1 && cell_date <= today
        }
        // AllDatesInPeriod month variants - match the month regardless of year
        DynamicFilterCriteria::AllDatesInPeriodJanuary => cell_date.month() == 1,
        DynamicFilterCriteria::AllDatesInPeriodFebruary => cell_date.month() == 2,
        DynamicFilterCriteria::AllDatesInPeriodMarch => cell_date.month() == 3,
        DynamicFilterCriteria::AllDatesInPeriodApril => cell_date.month() == 4,
        DynamicFilterCriteria::AllDatesInPeriodMay => cell_date.month() == 5,
        DynamicFilterCriteria::AllDatesInPeriodJune => cell_date.month() == 6,
        DynamicFilterCriteria::AllDatesInPeriodJuly => cell_date.month() == 7,
        DynamicFilterCriteria::AllDatesInPeriodAugust => cell_date.month() == 8,
        DynamicFilterCriteria::AllDatesInPeriodSeptember => cell_date.month() == 9,
        DynamicFilterCriteria::AllDatesInPeriodOctober => cell_date.month() == 10,
        DynamicFilterCriteria::AllDatesInPeriodNovember => cell_date.month() == 11,
        DynamicFilterCriteria::AllDatesInPeriodDecember => cell_date.month() == 12,
        // AllDatesInPeriod quarter variants - match the quarter regardless of year
        DynamicFilterCriteria::AllDatesInPeriodQuarter1 => {
            let m = cell_date.month();
            m >= 1 && m <= 3
        }
        DynamicFilterCriteria::AllDatesInPeriodQuarter2 => {
            let m = cell_date.month();
            m >= 4 && m <= 6
        }
        DynamicFilterCriteria::AllDatesInPeriodQuarter3 => {
            let m = cell_date.month();
            m >= 7 && m <= 9
        }
        DynamicFilterCriteria::AllDatesInPeriodQuarter4 => {
            let m = cell_date.month();
            m >= 10 && m <= 12
        }
        // AboveAverage/BelowAverage/Unknown handled elsewhere
        _ => false,
    }
}

/// Check if a row should be visible based on all column filters.
fn should_row_be_visible(
    grid: &Grid,
    style_registry: &engine::StyleRegistry,
    theme: &engine::ThemeDefinition,
    row: u32,
    auto_filter: &AutoFilter,
    locale: &engine::LocaleSettings,
) -> bool {
    // Header row is always visible
    if row == auto_filter.start_row {
        return true;
    }

    // Check each column filter
    for (rel_col, col_filter) in &auto_filter.column_filters {
        let abs_col = auto_filter.start_col + rel_col;
        let cell_value = get_cell_filter_value(grid, row, abs_col, style_registry, locale);
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
                        DynamicFilterCriteria::Today
                        | DynamicFilterCriteria::Yesterday
                        | DynamicFilterCriteria::Tomorrow
                        | DynamicFilterCriteria::ThisWeek
                        | DynamicFilterCriteria::LastWeek
                        | DynamicFilterCriteria::NextWeek
                        | DynamicFilterCriteria::ThisMonth
                        | DynamicFilterCriteria::LastMonth
                        | DynamicFilterCriteria::NextMonth
                        | DynamicFilterCriteria::ThisQuarter
                        | DynamicFilterCriteria::LastQuarter
                        | DynamicFilterCriteria::NextQuarter
                        | DynamicFilterCriteria::ThisYear
                        | DynamicFilterCriteria::LastYear
                        | DynamicFilterCriteria::NextYear
                        | DynamicFilterCriteria::YearToDate
                        | DynamicFilterCriteria::AllDatesInPeriodJanuary
                        | DynamicFilterCriteria::AllDatesInPeriodFebruary
                        | DynamicFilterCriteria::AllDatesInPeriodMarch
                        | DynamicFilterCriteria::AllDatesInPeriodApril
                        | DynamicFilterCriteria::AllDatesInPeriodMay
                        | DynamicFilterCriteria::AllDatesInPeriodJune
                        | DynamicFilterCriteria::AllDatesInPeriodJuly
                        | DynamicFilterCriteria::AllDatesInPeriodAugust
                        | DynamicFilterCriteria::AllDatesInPeriodSeptember
                        | DynamicFilterCriteria::AllDatesInPeriodOctober
                        | DynamicFilterCriteria::AllDatesInPeriodNovember
                        | DynamicFilterCriteria::AllDatesInPeriodDecember
                        | DynamicFilterCriteria::AllDatesInPeriodQuarter1
                        | DynamicFilterCriteria::AllDatesInPeriodQuarter2
                        | DynamicFilterCriteria::AllDatesInPeriodQuarter3
                        | DynamicFilterCriteria::AllDatesInPeriodQuarter4 => {
                            if let Some(serial) = get_cell_numeric_value(grid, row, abs_col) {
                                if !matches_date_dynamic_filter(serial, dyn_criteria) {
                                    return false;
                                }
                            } else {
                                // Non-numeric cells never match date filters
                                return false;
                            }
                        }
                        DynamicFilterCriteria::Unknown => {}
                    }
                }
            }
            FilterOn::CellColor => {
                if let Some(target_color) = &criteria.color {
                    let target_css = target_color.to_lowercase();
                    let cell_bg_css = if let Some(cell) = grid.cells.get(&(row, abs_col)) {
                        let style = style_registry.get(cell.style_index);
                        style.fill.background_color().to_css(theme).to_lowercase()
                    } else {
                        // Empty cell uses default background
                        engine::ThemeColor::default_background().to_css(theme).to_lowercase()
                    };
                    if cell_bg_css != target_css {
                        return false;
                    }
                }
            }
            FilterOn::FontColor => {
                if let Some(target_color) = &criteria.color {
                    let target_css = target_color.to_lowercase();
                    let cell_font_css = if let Some(cell) = grid.cells.get(&(row, abs_col)) {
                        let style = style_registry.get(cell.style_index);
                        style.font.color.to_css(theme).to_lowercase()
                    } else {
                        // Empty cell uses default text color
                        engine::ThemeColor::default_text().to_css(theme).to_lowercase()
                    };
                    if cell_font_css != target_css {
                        return false;
                    }
                }
            }
            FilterOn::Icon => {
                // Icon filtering depends on conditional formatting evaluation context,
                // which determines which icon is displayed for each cell based on CF rules.
                // This requires resolving CF icon sets at filter time, which is not yet
                // integrated. For now, icon-filtered rows are always shown.
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
    theme: &engine::ThemeDefinition,
    auto_filter: &mut AutoFilter,
    locale: &engine::LocaleSettings,
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
        if !should_row_be_visible(grid, style_registry, theme, row, auto_filter, locale) {
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
    let locale = state.locale.lock().unwrap();
    let theme = state.theme.lock().unwrap();

    // Pre-mutation snapshot for undo (BUG-0003: autofilter changes bypassed
    // the undo system).
    let undo_previous = auto_filters.get(&active_sheet).cloned();

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
        recompute_hidden_rows(&grids[active_sheet], &style_registry, &theme, auto_filter, &locale);
    }

    let hidden_rows: Vec<u32> = auto_filter.hidden_rows.iter().copied().collect();
    let all_rows: HashSet<u32> = ((auto_filter.start_row + 1)..=auto_filter.end_row).collect();
    let visible_rows: Vec<u32> = all_rows.difference(&auto_filter.hidden_rows).copied().collect();

    let result = AutoFilterResult {
        success: true,
        auto_filter: Some((&*auto_filter).into()),
        error: None,
        hidden_rows,
        visible_rows,
    };
    drop(auto_filters);
    drop(grids);
    crate::undo_commands::record_autofilter_undo(&state, active_sheet, undo_previous, "Apply AutoFilter");
    result
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
    let locale = state.locale.lock().unwrap();
    let theme = state.theme.lock().unwrap();

    let undo_previous = auto_filters.get(&active_sheet).cloned();
    if let Some(auto_filter) = auto_filters.get_mut(&active_sheet) {
        auto_filter.column_filters.remove(&column_index);

        // Recompute hidden rows
        if active_sheet < grids.len() {
            recompute_hidden_rows(&grids[active_sheet], &style_registry, &theme, auto_filter, &locale);
        }

        let hidden_rows: Vec<u32> = auto_filter.hidden_rows.iter().copied().collect();
        let all_rows: HashSet<u32> = ((auto_filter.start_row + 1)..=auto_filter.end_row).collect();
        let visible_rows: Vec<u32> = all_rows.difference(&auto_filter.hidden_rows).copied().collect();

        let result = AutoFilterResult {
            success: true,
            auto_filter: Some((&*auto_filter).into()),
            error: None,
            hidden_rows,
            visible_rows,
        };
        drop(auto_filters);
        drop(grids);
        crate::undo_commands::record_autofilter_undo(&state, active_sheet, undo_previous, "Clear column filter");
        result
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

    let undo_previous = auto_filters.get(&active_sheet).cloned();
    if let Some(auto_filter) = auto_filters.get_mut(&active_sheet) {
        auto_filter.column_filters.clear();
        auto_filter.hidden_rows.clear();

        let all_rows: Vec<u32> = ((auto_filter.start_row + 1)..=auto_filter.end_row).collect();

        let result = AutoFilterResult {
            success: true,
            auto_filter: Some((&*auto_filter).into()),
            error: None,
            hidden_rows: Vec::new(),
            visible_rows: all_rows,
        };
        drop(auto_filters);
        crate::undo_commands::record_autofilter_undo(&state, active_sheet, undo_previous, "Clear filter criteria");
        result
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
    let locale = state.locale.lock().unwrap();
    let theme = state.theme.lock().unwrap();

    // Pre-mutation snapshot for undo (BUG-0003).
    let undo_previous = auto_filters.get(&active_sheet).cloned();
    if let Some(auto_filter) = auto_filters.get_mut(&active_sheet) {
        // Recompute hidden rows
        if active_sheet < grids.len() {
            recompute_hidden_rows(&grids[active_sheet], &style_registry, &theme, auto_filter, &locale);
        }

        let hidden_rows: Vec<u32> = auto_filter.hidden_rows.iter().copied().collect();
        let all_rows: HashSet<u32> = ((auto_filter.start_row + 1)..=auto_filter.end_row).collect();
        let visible_rows: Vec<u32> = all_rows.difference(&auto_filter.hidden_rows).copied().collect();

        let result = AutoFilterResult {
            success: true,
            auto_filter: Some((&*auto_filter).into()),
            error: None,
            hidden_rows,
            visible_rows,
        };
        drop(auto_filters);
        drop(grids);
        crate::undo_commands::record_autofilter_undo(&state, active_sheet, undo_previous, "Filter");
        result
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

        drop(auto_filters);
        crate::undo_commands::record_autofilter_undo(
            &state,
            active_sheet,
            Some(auto_filter),
            "Remove AutoFilter",
        );

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
/// Returns the union of auto-filter hidden rows and advanced-filter hidden rows.
#[tauri::command]
pub fn get_hidden_rows(
    state: State<AppState>,
) -> Vec<u32> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let auto_filters = state.auto_filters.lock().unwrap();
    let adv_hidden = state.advanced_filter_hidden_rows.lock().unwrap();

    let mut result: HashSet<u32> = HashSet::new();

    if let Some(af) = auto_filters.get(&active_sheet) {
        result.extend(af.hidden_rows.iter());
    }
    if let Some(rows) = adv_hidden.get(&active_sheet) {
        result.extend(rows.iter());
    }

    result.into_iter().collect()
}

/// Set hidden rows for the Advanced Filter on the active sheet.
#[tauri::command]
pub fn set_advanced_filter_hidden_rows(
    state: State<AppState>,
    rows: Vec<u32>,
) {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut adv_hidden = state.advanced_filter_hidden_rows.lock().unwrap();
    if rows.is_empty() {
        adv_hidden.remove(&active_sheet);
    } else {
        adv_hidden.insert(active_sheet, rows);
    }
}

/// Clear advanced filter hidden rows for the active sheet.
#[tauri::command]
pub fn clear_advanced_filter_hidden_rows(
    state: State<AppState>,
) {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut adv_hidden = state.advanced_filter_hidden_rows.lock().unwrap();
    adv_hidden.remove(&active_sheet);
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
    let locale = state.locale.lock().unwrap();
    let _theme = state.theme.lock().unwrap();

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
        let value = get_cell_filter_value(grid, row, abs_col, &style_registry, &locale);
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
    let locale = state.locale.lock().unwrap();
    let theme = state.theme.lock().unwrap();

    // Pre-mutation snapshot for undo (BUG-0003).
    let undo_previous = auto_filters.get(&active_sheet).cloned();
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
            recompute_hidden_rows(&grids[active_sheet], &style_registry, &theme, auto_filter, &locale);
        }

        let hidden_rows: Vec<u32> = auto_filter.hidden_rows.iter().copied().collect();
        let all_rows: HashSet<u32> = ((auto_filter.start_row + 1)..=auto_filter.end_row).collect();
        let visible_rows: Vec<u32> = all_rows.difference(&auto_filter.hidden_rows).copied().collect();

        let result = AutoFilterResult {
            success: true,
            auto_filter: Some((&*auto_filter).into()),
            error: None,
            hidden_rows,
            visible_rows,
        };
        drop(auto_filters);
        drop(grids);
        crate::undo_commands::record_autofilter_undo(&state, active_sheet, undo_previous, "Filter");
        result
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
    let locale = state.locale.lock().unwrap();
    let theme = state.theme.lock().unwrap();

    // Pre-mutation snapshot for undo (BUG-0003).
    let undo_previous = auto_filters.get(&active_sheet).cloned();
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
            recompute_hidden_rows(&grids[active_sheet], &style_registry, &theme, auto_filter, &locale);
        }

        let hidden_rows: Vec<u32> = auto_filter.hidden_rows.iter().copied().collect();
        let all_rows: HashSet<u32> = ((auto_filter.start_row + 1)..=auto_filter.end_row).collect();
        let visible_rows: Vec<u32> = all_rows.difference(&auto_filter.hidden_rows).copied().collect();

        let result = AutoFilterResult {
            success: true,
            auto_filter: Some((&*auto_filter).into()),
            error: None,
            hidden_rows,
            visible_rows,
        };
        drop(auto_filters);
        drop(grids);
        crate::undo_commands::record_autofilter_undo(&state, active_sheet, undo_previous, "Filter");
        result
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
    let locale = state.locale.lock().unwrap();
    let theme = state.theme.lock().unwrap();

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

    // Pre-mutation snapshot for undo (BUG-0003).
    let undo_previous = auto_filters.get(&active_sheet).cloned();
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
            recompute_hidden_rows(&grids[active_sheet], &style_registry, &theme, auto_filter, &locale);
        }

        let hidden_rows: Vec<u32> = auto_filter.hidden_rows.iter().copied().collect();
        let all_rows: HashSet<u32> = ((auto_filter.start_row + 1)..=auto_filter.end_row).collect();
        let visible_rows: Vec<u32> = all_rows.difference(&auto_filter.hidden_rows).copied().collect();

        let result = AutoFilterResult {
            success: true,
            auto_filter: Some((&*auto_filter).into()),
            error: None,
            hidden_rows,
            visible_rows,
        };
        drop(auto_filters);
        drop(grids);
        crate::undo_commands::record_autofilter_undo(&state, active_sheet, undo_previous, "Filter");
        result
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
// ============================================================================
// ADVANCED FILTER (Excel-style criteria-range matching)
//
// Server-side matching engine for the Advanced Filter (dogfooding: "Rust owns
// computation"). The TS extension previously parsed criteria and matched rows in
// TypeScript; that engine is retired in favor of this one. The matcher MIRRORS the
// prior TS semantics EXACTLY (case-insensitive string compares, JS-`parseFloat`
// numeric coercion, anchored * / ? wildcards) so existing behavior is preserved —
// it deliberately does NOT reuse AutoFilter's `matches_custom_criterion`, which
// differs (raw &str ordering, strict numeric parse, `=` is string-only). The
// recursive `wildcard_match` and `get_cell_filter_value` helpers ARE shared.
// ============================================================================

/// Parameters for `run_advanced_filter` (mirrors the TS `AdvancedFilterParams`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvancedFilterParams {
    /// list (data) range incl. headers: (startRow, startCol, endRow, endCol), 0-based inclusive.
    pub list_range: (u32, u32, u32, u32),
    /// criteria range incl. headers: (startRow, startCol, endRow, endCol).
    pub criteria_range: (u32, u32, u32, u32),
    /// "filterInPlace" | "copyToLocation".
    pub action: String,
    /// Destination top-left (row, col) for copyToLocation.
    #[serde(default)]
    pub copy_to: Option<(u32, u32)>,
    pub unique_records_only: bool,
}

/// Result of `run_advanced_filter`. `matched_rows` (absolute data-row indices) lets
/// the TS layer perform the copyToLocation cell writes through the existing
/// undoable batch path; `hidden_rows` mirrors what was stored for filterInPlace.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvancedFilterResult {
    pub success: bool,
    pub match_count: u32,
    pub affected_rows: u32,
    pub matched_rows: Vec<u32>,
    pub hidden_rows: Vec<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A single criterion parsed from one criteria cell (mirrors TS `ParsedCriterion`).
#[derive(Debug, Clone)]
struct AdvParsedCriterion {
    operator: String,
    value: String,
    has_wildcard: bool,
}

/// Replicate JavaScript `parseFloat` leniency: skip leading whitespace, parse an
/// optional sign + the longest leading numeric prefix (digits, one decimal point,
/// optional exponent), stopping at the first invalid char. `None` if no digits.
/// Faithful to the prior TS engine, which used `parseFloat` for numeric coercion
/// (e.g. "42abc" -> 42, "2025-01-15" -> 2025, "1,234" -> 1, "" -> None).
fn js_parse_float(s: &str) -> Option<f64> {
    let s = s.trim_start();
    let b = s.as_bytes();
    let n = b.len();
    let mut i = 0;
    if i < n && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let mut has_digits = false;
    while i < n && b[i].is_ascii_digit() {
        i += 1;
        has_digits = true;
    }
    if i < n && b[i] == b'.' {
        i += 1;
        while i < n && b[i].is_ascii_digit() {
            i += 1;
            has_digits = true;
        }
    }
    if !has_digits {
        return None;
    }
    // Optional exponent — only consumed if it has at least one digit.
    if i < n && (b[i] == b'e' || b[i] == b'E') {
        let mut j = i + 1;
        if j < n && (b[j] == b'+' || b[j] == b'-') {
            j += 1;
        }
        let mut exp_digits = false;
        while j < n && b[j].is_ascii_digit() {
            j += 1;
            exp_digits = true;
        }
        if exp_digits {
            i = j;
        }
    }
    s[..i].parse::<f64>().ok()
}

/// Parse a criteria cell value into operator + value + wildcard flag (mirrors the
/// TS `parseCriterion`). Operator order matters: `>=`/`<=`/`<>` before `>`/`<`.
fn parse_criterion(cell_value: &str) -> AdvParsedCriterion {
    let trimmed = cell_value.trim();
    if trimmed.is_empty() {
        return AdvParsedCriterion { operator: "=".to_string(), value: String::new(), has_wildcard: false };
    }
    for op in [">=", "<=", "<>", ">", "<", "="] {
        if let Some(rest) = trimmed.strip_prefix(op) {
            let val = rest.trim().to_string();
            let has_wildcard = (op == "=" || op == "<>") && (val.contains('*') || val.contains('?'));
            return AdvParsedCriterion { operator: op.to_string(), value: val, has_wildcard };
        }
    }
    let has_wildcard = trimmed.contains('*') || trimmed.contains('?');
    AdvParsedCriterion { operator: "=".to_string(), value: trimmed.to_string(), has_wildcard }
}

/// Anchored, case-insensitive wildcard match (`*` = any run, `?` = one char), with
/// all other chars literal — equivalent to the TS `wildcardToRegex(...).test(...)`.
/// Reuses the recursive `wildcard_match` helper.
fn af_wildcard_match(pattern: &str, value: &str) -> bool {
    wildcard_match(&value.to_lowercase(), &pattern.to_lowercase())
}

/// Compare a cell value against a parsed criterion (mirrors the TS `matchesCriterion`).
fn matches_criterion(cell_value: &str, c: &AdvParsedCriterion) -> bool {
    // Empty criterion matches everything.
    if c.value.is_empty() && c.operator == "=" {
        return true;
    }
    let cv = cell_value.trim();
    let cv_lower = cv.to_lowercase();
    let crit_lower = c.value.to_lowercase();
    let cell_num = js_parse_float(cv);
    let crit_num = js_parse_float(&c.value);
    let both_numeric = cell_num.is_some() && crit_num.is_some() && !cv.is_empty() && !c.value.is_empty();

    match c.operator.as_str() {
        "=" => {
            if c.has_wildcard {
                return af_wildcard_match(&c.value, cv);
            }
            if both_numeric {
                return cell_num.unwrap() == crit_num.unwrap();
            }
            cv_lower == crit_lower
        }
        "<>" => {
            if c.has_wildcard {
                return !af_wildcard_match(&c.value, cv);
            }
            if both_numeric {
                return cell_num.unwrap() != crit_num.unwrap();
            }
            cv_lower != crit_lower
        }
        ">" => {
            if both_numeric { cell_num.unwrap() > crit_num.unwrap() } else { cv_lower > crit_lower }
        }
        "<" => {
            if both_numeric { cell_num.unwrap() < crit_num.unwrap() } else { cv_lower < crit_lower }
        }
        ">=" => {
            if both_numeric { cell_num.unwrap() >= crit_num.unwrap() } else { cv_lower >= crit_lower }
        }
        "<=" => {
            if both_numeric { cell_num.unwrap() <= crit_num.unwrap() } else { cv_lower <= crit_lower }
        }
        _ => false,
    }
}

/// True if `values` (by relative col index) satisfies ALL conditions in a criteria
/// row (AND across columns).
fn row_matches_row(values: &[String], conditions: &HashMap<u32, AdvParsedCriterion>) -> bool {
    for (col_idx, criterion) in conditions {
        let cell_value = values.get(*col_idx as usize).map(|s| s.as_str()).unwrap_or("");
        if !matches_criterion(cell_value, criterion) {
            return false;
        }
    }
    true
}

/// True if `values` satisfies ANY criteria row (OR between rows). No rows => match all.
fn row_matches_any(values: &[String], criteria_rows: &[HashMap<u32, AdvParsedCriterion>]) -> bool {
    if criteria_rows.is_empty() {
        return true;
    }
    criteria_rows.iter().any(|cr| row_matches_row(values, cr))
}

/// Execute an Excel-style Advanced Filter entirely server-side: read the list +
/// criteria ranges (display values), match rows, and either store the hidden-row
/// set (filterInPlace, mirroring `set_advanced_filter_hidden_rows`) or return the
/// matched absolute row indices (copyToLocation; the TS layer does the cell writes
/// through the undoable batch path).
#[tauri::command]
pub fn run_advanced_filter(
    state: State<AppState>,
    params: AdvancedFilterParams,
) -> AdvancedFilterResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let (l_start_row, l_start_col, l_end_row, l_end_col) = params.list_range;
    let (cr_start_row, cr_start_col, cr_end_row, cr_end_col) = params.criteria_range;

    let err = |msg: &str| AdvancedFilterResult {
        success: false,
        match_count: 0,
        affected_rows: 0,
        matched_rows: Vec::new(),
        hidden_rows: Vec::new(),
        error: Some(msg.to_string()),
    };

    // Read list + criteria into owned values under the grid/style/locale locks,
    // then drop them before touching advanced_filter_hidden_rows.
    let (data_rows, criteria_rows): (Vec<(u32, Vec<String>)>, Vec<HashMap<u32, AdvParsedCriterion>>) = {
        let grids = state.grids.lock().unwrap();
        let style_registry = state.style_registry.lock().unwrap();
        let locale = state.locale.lock().unwrap();
        if active_sheet >= grids.len() {
            return err("Invalid sheet index");
        }
        let grid = &grids[active_sheet];

        // List headers (lowercased, trimmed) -> relative col index. Last col with a
        // given header name wins (mirrors the TS Map.set overwrite).
        let mut list_headers: HashMap<String, u32> = HashMap::new();
        for col in l_start_col..=l_end_col {
            let h = get_cell_filter_value(grid, l_start_row, col, &style_registry, &locale)
                .trim()
                .to_lowercase();
            if !h.is_empty() {
                list_headers.insert(h, col - l_start_col);
            }
        }
        if list_headers.is_empty() {
            return err("No headers found in list range.");
        }

        // Map each criteria column (whose header matches a list header) to its list
        // relative col, in ascending criteria-col order.
        let mut criteria_header_map: Vec<(u32, u32)> = Vec::new();
        for col in cr_start_col..=cr_end_col {
            let h = get_cell_filter_value(grid, cr_start_row, col, &style_registry, &locale)
                .trim()
                .to_lowercase();
            if !h.is_empty() {
                if let Some(&list_col) = list_headers.get(&h) {
                    criteria_header_map.push((col, list_col));
                }
            }
        }

        // Criteria rows (below the header). Keyed by list relative col so two
        // criteria columns mapping to the same list col collapse last-wins (mirrors
        // the TS `conditions` Map keyed by listColIdx). AND within a row.
        let mut criteria_rows: Vec<HashMap<u32, AdvParsedCriterion>> = Vec::new();
        if cr_end_row > cr_start_row {
            for row in (cr_start_row + 1)..=cr_end_row {
                let mut conditions: HashMap<u32, AdvParsedCriterion> = HashMap::new();
                for &(cr_col, list_col) in &criteria_header_map {
                    let raw = get_cell_filter_value(grid, row, cr_col, &style_registry, &locale);
                    if !raw.trim().is_empty() {
                        conditions.insert(list_col, parse_criterion(raw.trim()));
                    }
                }
                if !conditions.is_empty() {
                    criteria_rows.push(conditions);
                }
            }
        }

        // Data rows (below the list header): owned display values per relative col.
        let mut data_rows: Vec<(u32, Vec<String>)> = Vec::new();
        if l_end_row > l_start_row {
            for row in (l_start_row + 1)..=l_end_row {
                // saturating_sub: defensive against an inverted column range (the
                // header loop above already early-returns "no headers" for that
                // case, but this avoids any u32 underflow in the capacity hint).
                let mut values: Vec<String> = Vec::with_capacity((l_end_col.saturating_sub(l_start_col) + 1) as usize);
                for col in l_start_col..=l_end_col {
                    values.push(get_cell_filter_value(grid, row, col, &style_registry, &locale));
                }
                data_rows.push((row, values));
            }
        }

        (data_rows, criteria_rows)
    };

    // Match rows (OR across criteria rows, AND within), with optional unique dedup.
    let mut matched_rows: Vec<u32> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (abs_row, values) in &data_rows {
        if !row_matches_any(values, &criteria_rows) {
            continue;
        }
        if params.unique_records_only {
            let key = values.iter().map(|v| v.to_lowercase()).collect::<Vec<_>>().join("\u{0}");
            if !seen.insert(key) {
                continue;
            }
        }
        matched_rows.push(*abs_row);
    }

    match params.action.as_str() {
        "filterInPlace" => {
            let matched_set: HashSet<u32> = matched_rows.iter().copied().collect();
            let hidden_rows: Vec<u32> = data_rows
                .iter()
                .map(|(r, _)| *r)
                .filter(|r| !matched_set.contains(r))
                .collect();
            {
                let mut adv_hidden = state.advanced_filter_hidden_rows.lock().unwrap();
                if hidden_rows.is_empty() {
                    adv_hidden.remove(&active_sheet);
                } else {
                    adv_hidden.insert(active_sheet, hidden_rows.clone());
                }
            }
            AdvancedFilterResult {
                success: true,
                match_count: matched_rows.len() as u32,
                affected_rows: hidden_rows.len() as u32,
                matched_rows,
                hidden_rows,
                error: None,
            }
        }
        "copyToLocation" if params.copy_to.is_some() => AdvancedFilterResult {
            success: true,
            match_count: matched_rows.len() as u32,
            affected_rows: matched_rows.len() as u32,
            matched_rows,
            hidden_rows: Vec::new(),
            error: None,
        },
        _ => err("Invalid action or missing copy-to location."),
    }
}

#[cfg(test)]
mod advanced_filter_tests {
    use super::*;

    /// Parse + match, mirroring the TS `matches(cellValue, criterionStr)` helper.
    fn matches(cell_value: &str, criterion_str: &str) -> bool {
        matches_criterion(cell_value, &parse_criterion(criterion_str))
    }

    #[test]
    fn parse_criterion_operators_and_wildcards() {
        let p = parse_criterion("hello");
        assert_eq!((p.operator.as_str(), p.value.as_str(), p.has_wildcard), ("=", "hello", false));
        let p = parse_criterion("=100");
        assert_eq!((p.operator.as_str(), p.value.as_str()), ("=", "100"));
        assert_eq!(parse_criterion("<>abc").operator, "<>");
        assert_eq!(parse_criterion(">50").operator, ">");
        assert_eq!(parse_criterion("<50").operator, "<");
        let p = parse_criterion(">=50");
        assert_eq!((p.operator.as_str(), p.value.as_str()), (">=", "50"));
        let p = parse_criterion("<=50");
        assert_eq!((p.operator.as_str(), p.value.as_str()), ("<=", "50"));
        let p = parse_criterion("");
        assert_eq!((p.operator.as_str(), p.value.as_str(), p.has_wildcard), ("=", "", false));
        assert!(parse_criterion("=A*").has_wildcard);
        assert!(parse_criterion("=A?B").has_wildcard);
        assert!(parse_criterion("<>*test").has_wildcard);
        assert!(!parse_criterion(">A*").has_wildcard);
        assert!(!parse_criterion("<A?").has_wildcard);
        assert!(!parse_criterion(">=X*").has_wildcard);
        assert!(!parse_criterion("<=Y?").has_wildcard);
        let p = parse_criterion("  >= 100  ");
        assert_eq!((p.operator.as_str(), p.value.as_str()), (">=", "100"));
        let p = parse_criterion("<>=5");
        assert_eq!((p.operator.as_str(), p.value.as_str()), ("<>", "=5"));
    }

    #[test]
    fn equals_matching_all_types() {
        assert!(matches("Apple", "=Apple"));
        assert!(matches("apple", "=Apple"));
        assert!(matches("APPLE", "=apple"));
        assert!(matches("42", "=42"));
        assert!(!matches("42", "=43"));
        assert!(matches("3.14", "=3.14"));
        assert!(matches("-10", "=-10"));
        assert!(matches("2025-01-15", "=2025-01-15"));
        assert!(matches("2025-01-15", "=2025-01-16")); // both parse to 2025
        assert!(!matches("Jan-15", "=Feb-15"));
        assert!(matches("", ""));
        assert!(matches("anything", ""));
        assert!(matches("test", "="));
        assert!(matches("TRUE", "=true"));
        assert!(matches("false", "=FALSE"));
        assert!(matches("Hello", "Hello"));
        assert!(matches("Hello", "hello"));
        assert!(matches("100", "100"));
        assert!(matches("42abc", "=42")); // parseFloat leniency
        assert!(matches("007", "=7"));
    }

    #[test]
    fn not_equal_matching() {
        assert!(!matches("Apple", "<>Apple"));
        assert!(!matches("apple", "<>APPLE"));
        assert!(matches("Orange", "<>Apple"));
        assert!(!matches("42", "<>42"));
        assert!(matches("43", "<>42"));
        assert!(!matches("2025-01-15", "<>2025-01-16")); // both 2025
        assert!(!matches("2025-01-15", "<>2025-01-15"));
        assert!(matches("Jan-15", "<>Feb-15"));
        assert!(matches("TRUE", "<>FALSE"));
    }

    #[test]
    fn ordered_comparisons() {
        assert!(matches("10", ">5"));
        assert!(!matches("5", ">5"));
        assert!(!matches("3", ">5"));
        assert!(matches("3.15", ">3.14"));
        assert!(matches("-1", ">-5"));
        assert!(!matches("-10", ">-5"));
        assert!(matches("banana", ">apple"));
        assert!(!matches("apple", ">banana"));
        assert!(matches("3", "<5"));
        assert!(!matches("5", "<5"));
        assert!(matches("-10", "<-5"));
        assert!(matches("apple", "<banana"));
        assert!(matches("5", ">=5"));
        assert!(matches("6", ">=5"));
        assert!(!matches("4", ">=5"));
        assert!(matches("banana", ">=banana"));
        assert!(matches("5", "<=5"));
        assert!(matches("4", "<=5"));
        assert!(!matches("6", "<=5"));
        assert!(matches("banana", "<=banana"));
        assert!(matches("Banana", ">apple"));
        assert!(matches("BANANA", ">apple"));
    }

    #[test]
    fn wildcard_patterns() {
        assert!(matches("Apple", "=App*"));
        assert!(matches("Application", "=App*"));
        assert!(!matches("Banana", "=App*"));
        assert!(matches("Pineapple", "=*apple"));
        assert!(matches("apple", "=*apple"));
        assert!(!matches("banana", "=*apple"));
        assert!(matches("Pineapple juice", "=*apple*"));
        assert!(!matches("banana", "=*apple*"));
        assert!(matches("abcdef", "=ab*ef"));
        assert!(matches("abef", "=ab*ef"));
        assert!(matches("abXYZef", "=ab*ef"));
        assert!(!matches("abXYZeg", "=ab*ef"));
        assert!(matches("cat", "=ca?"));
        assert!(!matches("ca", "=ca?"));
        assert!(!matches("cats", "=ca?"));
        assert!(matches("bat", "=?at"));
        assert!(!matches("at", "=?at"));
        assert!(matches("cat", "=c?t"));
        assert!(!matches("ct", "=c?t"));
        assert!(matches("axxb", "=a??b"));
        assert!(!matches("axb", "=a??b"));
        assert!(!matches("axxxb", "=a??b"));
        assert!(matches("abcXdef", "=a?c*f"));
        assert!(matches("abcf", "=a?c*f"));
        assert!(!matches("acXdef", "=a?c*f"));
        assert!(!matches("Apple", "<>App*"));
        assert!(matches("Banana", "<>App*"));
        assert!(matches("APPLE", "=app*"));
        assert!(matches("apple", "=APP*"));
        assert!(matches("anything", "=*"));
        assert!(matches("", "=*"));
        assert!(matches("a", "=?"));
        assert!(!matches("ab", "=?"));
        assert!(!matches("", "=?"));
        assert!(matches("a.b", "=a.b"));
        assert!(!matches("axb", "=a.b"));
    }

    #[test]
    fn only_operator_no_value() {
        let gt = parse_criterion(">");
        assert!(matches_criterion("a", &gt));
        assert!(!matches_criterion("", &gt));
        let lt = parse_criterion("<");
        assert!(!matches_criterion("a", &lt));
        assert!(!matches_criterion("", &lt));
        let ne = parse_criterion("<>");
        assert!(matches_criterion("hello", &ne));
        assert!(!matches_criterion("", &ne));
        let ge = parse_criterion(">=");
        assert!(matches_criterion("a", &ge));
        assert!(matches_criterion("", &ge));
        let le = parse_criterion("<=");
        assert!(matches_criterion("", &le));
        assert!(!matches_criterion("a", &le));
    }

    #[test]
    fn numeric_precision_and_whitespace() {
        let sum = 0.1_f64 + 0.2_f64;
        assert!(!matches(&format!("{}", sum), "=0.3"));
        assert!(matches("0.3", "=0.3"));
        assert!(matches("1000000000", ">999999999"));
        assert!(matches("0.0001", "<0.001"));
        assert!(matches("  hello  ", "=hello"));
        assert!(matches("hello", "=  hello  "));
        assert!(!matches("", ">5"));
        assert!(matches("", "<5")); // "" < "5" lexicographically
    }

    #[test]
    fn js_parse_float_semantics() {
        assert_eq!(js_parse_float("42abc"), Some(42.0));
        assert_eq!(js_parse_float("2025-01-15"), Some(2025.0));
        assert_eq!(js_parse_float("007"), Some(7.0));
        assert_eq!(js_parse_float("-10"), Some(-10.0));
        assert_eq!(js_parse_float("3.14"), Some(3.14));
        assert_eq!(js_parse_float("1e3"), Some(1000.0));
        assert_eq!(js_parse_float(".5"), Some(0.5));
        assert_eq!(js_parse_float("  12.5 "), Some(12.5));
        assert_eq!(js_parse_float("abc"), None);
        assert_eq!(js_parse_float(""), None);
    }

    #[test]
    fn row_matching_and_or() {
        let mut and_row: HashMap<u32, AdvParsedCriterion> = HashMap::new();
        and_row.insert(0, parse_criterion(">5"));
        and_row.insert(1, parse_criterion("=Bikes"));
        let rows = vec![and_row];
        assert!(row_matches_any(&["10".to_string(), "bikes".to_string()], &rows));
        assert!(!row_matches_any(&["10".to_string(), "Cars".to_string()], &rows));
        assert!(!row_matches_any(&["3".to_string(), "Bikes".to_string()], &rows));
        assert!(row_matches_any(&["x".to_string()], &[]));
        let mut r1: HashMap<u32, AdvParsedCriterion> = HashMap::new();
        r1.insert(0, parse_criterion("=Bikes"));
        let mut r2: HashMap<u32, AdvParsedCriterion> = HashMap::new();
        r2.insert(0, parse_criterion("=Cars"));
        let or_rows = vec![r1, r2];
        assert!(row_matches_any(&["bikes".to_string()], &or_rows));
        assert!(row_matches_any(&["cars".to_string()], &or_rows));
        assert!(!row_matches_any(&["planes".to_string()], &or_rows));
    }
}

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
    let locale = state.locale.lock().unwrap();
    let theme = state.theme.lock().unwrap();

    // Pre-mutation snapshot for undo (BUG-0003).
    let undo_previous = auto_filters.get(&active_sheet).cloned();
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
            recompute_hidden_rows(&grids[active_sheet], &style_registry, &theme, auto_filter, &locale);
        }

        let hidden_rows: Vec<u32> = auto_filter.hidden_rows.iter().copied().collect();
        let all_rows: HashSet<u32> = ((auto_filter.start_row + 1)..=auto_filter.end_row).collect();
        let visible_rows: Vec<u32> = all_rows.difference(&auto_filter.hidden_rows).copied().collect();

        let result = AutoFilterResult {
            success: true,
            auto_filter: Some((&*auto_filter).into()),
            error: None,
            hidden_rows,
            visible_rows,
        };
        drop(auto_filters);
        drop(grids);
        crate::undo_commands::record_autofilter_undo(&state, active_sheet, undo_previous, "Filter");
        result
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
