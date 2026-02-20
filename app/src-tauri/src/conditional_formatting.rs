//! FILENAME: app/src-tauri/src/conditional_formatting.rs
//! PURPOSE: Backend storage and evaluation for conditional formatting rules.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::State;

use crate::AppState;
use engine::{CellValue, Grid};

// ============================================================================
// VALUE TYPES
// ============================================================================

/// How to interpret the value for color scales, data bars, icon sets
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CFValueType {
    Number,
    Percent,
    Formula,
    Percentile,
    Min,
    Max,
    AutoMin,
    AutoMax,
}

impl Default for CFValueType {
    fn default() -> Self {
        CFValueType::Number
    }
}

// ============================================================================
// COLOR SCALE
// ============================================================================

/// A point in a color scale
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorScalePoint {
    pub value_type: CFValueType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub formula: Option<String>,
    pub color: String, // CSS color
}

/// Color scale rule (2 or 3 color)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorScaleRule {
    pub min_point: ColorScalePoint,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mid_point: Option<ColorScalePoint>,
    pub max_point: ColorScalePoint,
}

// ============================================================================
// DATA BAR
// ============================================================================

/// Data bar direction
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DataBarDirection {
    Context,
    LeftToRight,
    RightToLeft,
}

impl Default for DataBarDirection {
    fn default() -> Self {
        DataBarDirection::Context
    }
}

/// Data bar axis position
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DataBarAxisPosition {
    Automatic,
    CellMidpoint,
    None,
}

impl Default for DataBarAxisPosition {
    fn default() -> Self {
        DataBarAxisPosition::Automatic
    }
}

/// Data bar rule
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataBarRule {
    pub min_value_type: CFValueType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_value: Option<f64>,
    pub max_value_type: CFValueType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_value: Option<f64>,
    pub fill_color: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub negative_fill_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub negative_border_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub axis_color: Option<String>,
    pub axis_position: DataBarAxisPosition,
    pub direction: DataBarDirection,
    pub show_value: bool,
    pub gradient_fill: bool,
}

impl Default for DataBarRule {
    fn default() -> Self {
        Self {
            min_value_type: CFValueType::AutoMin,
            min_value: None,
            max_value_type: CFValueType::AutoMax,
            max_value: None,
            fill_color: "#638EC6".to_string(),
            border_color: None,
            negative_fill_color: Some("#FF0000".to_string()),
            negative_border_color: None,
            axis_color: Some("#000000".to_string()),
            axis_position: DataBarAxisPosition::Automatic,
            direction: DataBarDirection::Context,
            show_value: true,
            gradient_fill: true,
        }
    }
}

// ============================================================================
// ICON SET
// ============================================================================

/// Icon set types
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IconSetType {
    ThreeArrows,
    ThreeArrowsGray,
    ThreeFlags,
    ThreeTrafficLights1,
    ThreeTrafficLights2,
    ThreeSigns,
    ThreeSymbols,
    ThreeSymbols2,
    ThreeStars,
    ThreeTriangles,
    FourArrows,
    FourArrowsGray,
    FourRating,
    FourTrafficLights,
    FourRedToBlack,
    FiveArrows,
    FiveArrowsGray,
    FiveRating,
    FiveQuarters,
    FiveBoxes,
}

impl Default for IconSetType {
    fn default() -> Self {
        IconSetType::ThreeTrafficLights1
    }
}

/// Threshold operator for icon sets
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ThresholdOperator {
    GreaterThan,
    GreaterThanOrEqual,
}

impl Default for ThresholdOperator {
    fn default() -> Self {
        ThresholdOperator::GreaterThanOrEqual
    }
}

/// Icon set threshold
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IconSetThreshold {
    pub value_type: CFValueType,
    pub value: f64,
    pub operator: ThresholdOperator,
}

/// Icon set rule
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IconSetRule {
    pub icon_set: IconSetType,
    pub thresholds: Vec<IconSetThreshold>,
    pub reverse_icons: bool,
    pub show_icon_only: bool,
}

// ============================================================================
// CELL VALUE RULES
// ============================================================================

/// Cell value comparison operator
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CellValueOperator {
    Equal,
    NotEqual,
    GreaterThan,
    GreaterThanOrEqual,
    LessThan,
    LessThanOrEqual,
    Between,
    NotBetween,
}

/// Cell value rule
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellValueRule {
    pub operator: CellValueOperator,
    pub value1: String, // Can be formula or literal
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value2: Option<String>, // For between/not between
}

// ============================================================================
// TEXT RULES
// ============================================================================

/// Text rule type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextRuleType {
    Contains,
    NotContains,
    BeginsWith,
    EndsWith,
}

/// Contains text rule
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainsTextRule {
    pub rule_type: TextRuleType,
    pub text: String,
}

// ============================================================================
// TOP/BOTTOM RULES
// ============================================================================

/// Top/bottom rule type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TopBottomType {
    TopItems,
    TopPercent,
    BottomItems,
    BottomPercent,
}

/// Top/bottom rule
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopBottomRule {
    pub rule_type: TopBottomType,
    pub rank: u32,
}

// ============================================================================
// ABOVE/BELOW AVERAGE
// ============================================================================

/// Above/below average rule type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AverageRuleType {
    AboveAverage,
    BelowAverage,
    EqualOrAboveAverage,
    EqualOrBelowAverage,
    OneStdDevAbove,
    OneStdDevBelow,
    TwoStdDevAbove,
    TwoStdDevBelow,
    ThreeStdDevAbove,
    ThreeStdDevBelow,
}

/// Above/below average rule
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AboveAverageRule {
    pub rule_type: AverageRuleType,
}

// ============================================================================
// TIME PERIOD
// ============================================================================

/// Time period for date-based rules
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TimePeriod {
    Today,
    Yesterday,
    Tomorrow,
    Last7Days,
    ThisWeek,
    LastWeek,
    NextWeek,
    ThisMonth,
    LastMonth,
    NextMonth,
    ThisQuarter,
    LastQuarter,
    NextQuarter,
    ThisYear,
    LastYear,
    NextYear,
}

/// Time period rule
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimePeriodRule {
    pub period: TimePeriod,
}

// ============================================================================
// EXPRESSION (CUSTOM FORMULA)
// ============================================================================

/// Expression/formula rule
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpressionRule {
    /// Formula that evaluates to TRUE when rule applies
    pub formula: String,
}

// ============================================================================
// CONDITIONAL FORMAT (Style applied when rule matches)
// ============================================================================

/// The format/style to apply when a rule matches
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConditionalFormat {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub underline: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strikethrough: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number_format: Option<String>,
}

// ============================================================================
// CONDITIONAL FORMAT RULE (Union type)
// ============================================================================

/// All possible conditional format rule types
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ConditionalFormatRule {
    ColorScale(ColorScaleRule),
    DataBar(DataBarRule),
    IconSet(IconSetRule),
    CellValue(CellValueRule),
    ContainsText(ContainsTextRule),
    TopBottom(TopBottomRule),
    AboveAverage(AboveAverageRule),
    DuplicateValues,
    UniqueValues,
    Expression(ExpressionRule),
    BlankCells,
    NoBlanks,
    ErrorCells,
    NoErrors,
    TimePeriod(TimePeriodRule),
}

// ============================================================================
// CONDITIONAL FORMAT RANGE
// ============================================================================

/// A range where conditional formatting applies
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConditionalFormatRange {
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
}

impl ConditionalFormatRange {
    pub fn contains(&self, row: u32, col: u32) -> bool {
        row >= self.start_row
            && row <= self.end_row
            && col >= self.start_col
            && col <= self.end_col
    }
}

// ============================================================================
// CONDITIONAL FORMAT DEFINITION
// ============================================================================

/// A complete conditional format definition
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConditionalFormatDefinition {
    /// Unique ID for this rule
    pub id: u64,
    /// Priority (lower = higher priority, first match wins)
    pub priority: u32,
    /// The rule type and parameters
    pub rule: ConditionalFormatRule,
    /// The format to apply when rule matches
    pub format: ConditionalFormat,
    /// Ranges this rule applies to
    pub ranges: Vec<ConditionalFormatRange>,
    /// Stop evaluating lower-priority rules if this matches
    pub stop_if_true: bool,
    /// Whether the rule is enabled
    pub enabled: bool,
}

// ============================================================================
// STORAGE
// ============================================================================

/// Storage: sheet_index -> Vec<ConditionalFormatDefinition> (ordered by priority)
pub type ConditionalFormatStorage = HashMap<usize, Vec<ConditionalFormatDefinition>>;

// ============================================================================
// RESULT TYPES
// ============================================================================

/// Result of a conditional formatting operation
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CFResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule: Option<ConditionalFormatDefinition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl CFResult {
    pub fn ok(rule: ConditionalFormatDefinition) -> Self {
        Self {
            success: true,
            rule: Some(rule),
            error: None,
        }
    }

    pub fn ok_empty() -> Self {
        Self {
            success: true,
            rule: None,
            error: None,
        }
    }

    pub fn err(message: impl Into<String>) -> Self {
        Self {
            success: false,
            rule: None,
            error: Some(message.into()),
        }
    }
}

/// Evaluated conditional format for a cell
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellConditionalFormat {
    pub row: u32,
    pub col: u32,
    pub format: ConditionalFormat,
    /// For data bars: fill percentage (0.0 to 1.0)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_bar_percent: Option<f64>,
    /// For icon sets: icon index
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_index: Option<u32>,
    /// For color scales: interpolated color
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color_scale_color: Option<String>,
}

/// Result of evaluating conditional formats for a range
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluateCFResult {
    pub cells: Vec<CellConditionalFormat>,
}

// ============================================================================
// PARAMS
// ============================================================================

/// Parameters for adding a conditional format
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddCFParams {
    pub rule: ConditionalFormatRule,
    pub format: ConditionalFormat,
    pub ranges: Vec<ConditionalFormatRange>,
    #[serde(default)]
    pub stop_if_true: bool,
}

/// Parameters for updating a conditional format
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCFParams {
    pub rule_id: u64,
    #[serde(default)]
    pub rule: Option<ConditionalFormatRule>,
    #[serde(default)]
    pub format: Option<ConditionalFormat>,
    #[serde(default)]
    pub ranges: Option<Vec<ConditionalFormatRange>>,
    #[serde(default)]
    pub stop_if_true: Option<bool>,
    #[serde(default)]
    pub enabled: Option<bool>,
}

// ============================================================================
// COMMANDS
// ============================================================================

/// Add a conditional format rule
#[tauri::command]
pub fn add_conditional_format(
    state: State<AppState>,
    params: AddCFParams,
) -> CFResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut cf_storage = state.conditional_formats.lock().unwrap();
    let mut next_id = state.next_cf_rule_id.lock().unwrap();

    let rules = cf_storage.entry(active_sheet).or_insert_with(Vec::new);

    // Calculate priority (lowest = highest priority, add at end)
    let priority = rules.iter().map(|r| r.priority).max().unwrap_or(0) + 1;

    let rule = ConditionalFormatDefinition {
        id: *next_id,
        priority,
        rule: params.rule,
        format: params.format,
        ranges: params.ranges,
        stop_if_true: params.stop_if_true,
        enabled: true,
    };

    *next_id += 1;
    rules.push(rule.clone());

    // Sort by priority
    rules.sort_by_key(|r| r.priority);

    CFResult::ok(rule)
}

/// Update a conditional format rule
#[tauri::command]
pub fn update_conditional_format(
    state: State<AppState>,
    params: UpdateCFParams,
) -> CFResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut cf_storage = state.conditional_formats.lock().unwrap();

    let rules = match cf_storage.get_mut(&active_sheet) {
        Some(r) => r,
        None => return CFResult::err("No conditional formats on this sheet"),
    };

    let rule = match rules.iter_mut().find(|r| r.id == params.rule_id) {
        Some(r) => r,
        None => return CFResult::err("Rule not found"),
    };

    if let Some(new_rule) = params.rule {
        rule.rule = new_rule;
    }
    if let Some(new_format) = params.format {
        rule.format = new_format;
    }
    if let Some(new_ranges) = params.ranges {
        rule.ranges = new_ranges;
    }
    if let Some(stop) = params.stop_if_true {
        rule.stop_if_true = stop;
    }
    if let Some(enabled) = params.enabled {
        rule.enabled = enabled;
    }

    CFResult::ok(rule.clone())
}

/// Delete a conditional format rule
#[tauri::command]
pub fn delete_conditional_format(
    state: State<AppState>,
    rule_id: u64,
) -> CFResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut cf_storage = state.conditional_formats.lock().unwrap();

    let rules = match cf_storage.get_mut(&active_sheet) {
        Some(r) => r,
        None => return CFResult::err("No conditional formats on this sheet"),
    };

    let initial_len = rules.len();
    rules.retain(|r| r.id != rule_id);

    if rules.len() == initial_len {
        return CFResult::err("Rule not found");
    }

    CFResult::ok_empty()
}

/// Reorder conditional format rules
#[tauri::command]
pub fn reorder_conditional_formats(
    state: State<AppState>,
    rule_ids: Vec<u64>,
) -> CFResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut cf_storage = state.conditional_formats.lock().unwrap();

    let rules = match cf_storage.get_mut(&active_sheet) {
        Some(r) => r,
        None => return CFResult::err("No conditional formats on this sheet"),
    };

    // Assign new priorities based on order in rule_ids
    for (priority, id) in rule_ids.iter().enumerate() {
        if let Some(rule) = rules.iter_mut().find(|r| r.id == *id) {
            rule.priority = priority as u32;
        }
    }

    // Sort by new priority
    rules.sort_by_key(|r| r.priority);

    CFResult::ok_empty()
}

/// Get a specific conditional format rule
#[tauri::command]
pub fn get_conditional_format(
    state: State<AppState>,
    rule_id: u64,
) -> Option<ConditionalFormatDefinition> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let cf_storage = state.conditional_formats.lock().unwrap();

    cf_storage
        .get(&active_sheet)
        .and_then(|rules| rules.iter().find(|r| r.id == rule_id).cloned())
}

/// Get all conditional format rules for the current sheet
#[tauri::command]
pub fn get_all_conditional_formats(
    state: State<AppState>,
) -> Vec<ConditionalFormatDefinition> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let cf_storage = state.conditional_formats.lock().unwrap();

    cf_storage
        .get(&active_sheet)
        .cloned()
        .unwrap_or_default()
}

/// Evaluate conditional formats for a range
/// This returns the computed styles for each cell in the range
#[tauri::command]
pub fn evaluate_conditional_formats(
    state: State<AppState>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> EvaluateCFResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let cf_storage = state.conditional_formats.lock().unwrap();
    let grids = state.grids.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();

    let rules = match cf_storage.get(&active_sheet) {
        Some(r) => r,
        None => return EvaluateCFResult { cells: Vec::new() },
    };

    let grid = match grids.get(active_sheet) {
        Some(g) => g,
        None => return EvaluateCFResult { cells: Vec::new() },
    };

    let min_row = start_row.min(end_row);
    let max_row = start_row.max(end_row);
    let min_col = start_col.min(end_col);
    let max_col = start_col.max(end_col);

    // Pre-compute range stats for rules that need them
    let rule_stats: Vec<Option<RangeStats>> = rules
        .iter()
        .map(|rule_def| {
            if rule_def.enabled && needs_range_stats(&rule_def.rule) {
                Some(collect_range_stats(grid, &rule_def.ranges))
            } else {
                None
            }
        })
        .collect();

    let mut result = Vec::new();

    for row in min_row..=max_row {
        for col in min_col..=max_col {
            for (idx, rule_def) in rules.iter().enumerate() {
                if !rule_def.enabled {
                    continue;
                }

                let in_range = rule_def.ranges.iter().any(|r| r.contains(row, col));
                if !in_range {
                    continue;
                }

                let stats = rule_stats[idx].as_ref();

                if let Some(cf) = evaluate_rule(
                    grid,
                    &grids,
                    &sheet_names,
                    active_sheet,
                    &rule_def.rule,
                    &rule_def.format,
                    row,
                    col,
                    stats,
                ) {
                    result.push(cf);

                    if rule_def.stop_if_true {
                        break;
                    }
                }
            }
        }
    }

    EvaluateCFResult { cells: result }
}

/// Clear conditional formats in a range
#[tauri::command]
pub fn clear_conditional_formats_in_range(
    state: State<AppState>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> u32 {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut cf_storage = state.conditional_formats.lock().unwrap();

    let min_row = start_row.min(end_row);
    let max_row = start_row.max(end_row);
    let min_col = start_col.min(end_col);
    let max_col = start_col.max(end_col);

    let rules = match cf_storage.get_mut(&active_sheet) {
        Some(r) => r,
        None => return 0,
    };

    let initial_len = rules.len();

    rules.retain(|rule| {
        !rule.ranges.iter().all(|r| {
            r.start_row >= min_row
                && r.end_row <= max_row
                && r.start_col >= min_col
                && r.end_col <= max_col
        })
    });

    (initial_len - rules.len()) as u32
}

// ============================================================================
// RANGE STATISTICS (pre-computed for complex rules)
// ============================================================================

/// Pre-computed statistics for a rule's ranges
struct RangeStats {
    /// All numeric values in the ranges, sorted ascending
    sorted_values: Vec<f64>,
    /// Count of each cell value's string representation (for duplicate detection)
    value_counts: HashMap<String, usize>,
    /// Statistical measures
    mean: f64,
    std_dev: f64,
    min: f64,
    max: f64,
}

/// Check if a rule type needs pre-computed range stats
fn needs_range_stats(rule: &ConditionalFormatRule) -> bool {
    matches!(
        rule,
        ConditionalFormatRule::TopBottom(_)
            | ConditionalFormatRule::AboveAverage(_)
            | ConditionalFormatRule::DuplicateValues
            | ConditionalFormatRule::UniqueValues
            | ConditionalFormatRule::ColorScale(_)
            | ConditionalFormatRule::DataBar(_)
            | ConditionalFormatRule::IconSet(_)
    )
}

/// Collect statistics from all cells in the given ranges
fn collect_range_stats(grid: &Grid, ranges: &[ConditionalFormatRange]) -> RangeStats {
    let mut numeric_values = Vec::new();
    let mut value_counts: HashMap<String, usize> = HashMap::new();

    for range in ranges {
        for row in range.start_row..=range.end_row {
            for col in range.start_col..=range.end_col {
                if let Some(cell) = grid.cells.get(&(row, col)) {
                    // Collect string representation for duplicate detection
                    let str_repr = cell_value_to_string(&cell.value);
                    if !str_repr.is_empty() {
                        *value_counts.entry(str_repr).or_insert(0) += 1;
                    }

                    // Collect numeric value
                    if let Some(n) = get_numeric_value(&cell.value) {
                        numeric_values.push(n);
                    }
                }
            }
        }
    }

    numeric_values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let count = numeric_values.len();
    let sum: f64 = numeric_values.iter().sum();
    let mean = if count > 0 { sum / count as f64 } else { 0.0 };
    let variance = if count > 0 {
        numeric_values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / count as f64
    } else {
        0.0
    };
    let std_dev = variance.sqrt();
    let min = numeric_values.first().copied().unwrap_or(0.0);
    let max = numeric_values.last().copied().unwrap_or(0.0);

    RangeStats {
        sorted_values: numeric_values,
        value_counts,
        mean,
        std_dev,
        min,
        max,
    }
}

/// Extract a numeric value from a CellValue
fn get_numeric_value(value: &CellValue) -> Option<f64> {
    match value {
        CellValue::Number(n) => Some(*n),
        CellValue::Boolean(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

/// Convert a CellValue to a string for duplicate detection
fn cell_value_to_string(value: &CellValue) -> String {
    match value {
        CellValue::Empty => String::new(),
        CellValue::Number(n) => crate::format_number_simple(*n),
        CellValue::Text(s) => s.to_lowercase(),
        CellValue::Boolean(b) => b.to_string(),
        CellValue::Error(e) => format!("{:?}", e),
    }
}

// ============================================================================
// COLOR HELPERS
// ============================================================================

/// Parse a hex color string (#RRGGBB) into (R, G, B) components
fn parse_hex_color(color: &str) -> Option<(u8, u8, u8)> {
    let hex = color.trim_start_matches('#');
    if hex.len() != 6 {
        return None;
    }
    let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
    let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
    let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
    Some((r, g, b))
}

/// Linearly interpolate between two hex colors
fn interpolate_color(color1: &str, color2: &str, t: f64) -> String {
    let t = t.clamp(0.0, 1.0);
    let (r1, g1, b1) = parse_hex_color(color1).unwrap_or((255, 255, 255));
    let (r2, g2, b2) = parse_hex_color(color2).unwrap_or((255, 255, 255));

    let r = (r1 as f64 + (r2 as f64 - r1 as f64) * t).round() as u8;
    let g = (g1 as f64 + (g2 as f64 - g1 as f64) * t).round() as u8;
    let b = (b1 as f64 + (b2 as f64 - b1 as f64) * t).round() as u8;

    format!("#{:02X}{:02X}{:02X}", r, g, b)
}

// ============================================================================
// DATE HELPERS (for TimePeriod rules)
// ============================================================================

/// Convert an Excel date serial number to a chrono NaiveDate.
/// Excel epoch: 1899-12-30 (serial 0). Day 1 = 1900-01-01.
fn serial_to_date(serial: f64) -> Option<chrono::NaiveDate> {
    use chrono::NaiveDate;
    let base = NaiveDate::from_ymd_opt(1899, 12, 30)?;
    let days = serial.floor() as i64;
    base.checked_add_signed(chrono::Duration::days(days))
}

/// Evaluate a TimePeriod rule against a cell value
fn evaluate_time_period(cell_value: Option<&CellValue>, period: &TimePeriod) -> bool {
    let num = match cell_value {
        Some(CellValue::Number(n)) => *n,
        _ => return false,
    };

    let cell_date = match serial_to_date(num) {
        Some(d) => d,
        None => return false,
    };

    use chrono::{Datelike, Local, Weekday};
    let today = Local::now().date_naive();

    match period {
        TimePeriod::Today => cell_date == today,
        TimePeriod::Yesterday => {
            cell_date == today.pred_opt().unwrap_or(today)
        }
        TimePeriod::Tomorrow => {
            cell_date == today.succ_opt().unwrap_or(today)
        }
        TimePeriod::Last7Days => {
            let week_ago = today - chrono::Duration::days(7);
            cell_date >= week_ago && cell_date <= today
        }
        TimePeriod::ThisWeek => {
            let weekday_num = today.weekday().num_days_from_monday();
            let week_start = today - chrono::Duration::days(weekday_num as i64);
            let week_end = week_start + chrono::Duration::days(6);
            cell_date >= week_start && cell_date <= week_end
        }
        TimePeriod::LastWeek => {
            let weekday_num = today.weekday().num_days_from_monday();
            let this_week_start = today - chrono::Duration::days(weekday_num as i64);
            let last_week_start = this_week_start - chrono::Duration::days(7);
            let last_week_end = this_week_start - chrono::Duration::days(1);
            cell_date >= last_week_start && cell_date <= last_week_end
        }
        TimePeriod::NextWeek => {
            let weekday_num = today.weekday().num_days_from_monday();
            let this_week_start = today - chrono::Duration::days(weekday_num as i64);
            let next_week_start = this_week_start + chrono::Duration::days(7);
            let next_week_end = next_week_start + chrono::Duration::days(6);
            cell_date >= next_week_start && cell_date <= next_week_end
        }
        TimePeriod::ThisMonth => {
            cell_date.year() == today.year() && cell_date.month() == today.month()
        }
        TimePeriod::LastMonth => {
            let (y, m) = if today.month() == 1 {
                (today.year() - 1, 12)
            } else {
                (today.year(), today.month() - 1)
            };
            cell_date.year() == y && cell_date.month() == m
        }
        TimePeriod::NextMonth => {
            let (y, m) = if today.month() == 12 {
                (today.year() + 1, 1)
            } else {
                (today.year(), today.month() + 1)
            };
            cell_date.year() == y && cell_date.month() == m
        }
        TimePeriod::ThisQuarter => {
            let q = (today.month() - 1) / 3;
            let cq = (cell_date.month() - 1) / 3;
            cell_date.year() == today.year() && cq == q
        }
        TimePeriod::LastQuarter => {
            let q = (today.month() - 1) / 3;
            let (y, lq) = if q == 0 {
                (today.year() - 1, 3)
            } else {
                (today.year(), q - 1)
            };
            let cq = (cell_date.month() - 1) / 3;
            cell_date.year() == y && cq == lq
        }
        TimePeriod::NextQuarter => {
            let q = (today.month() - 1) / 3;
            let (y, nq) = if q == 3 {
                (today.year() + 1, 0)
            } else {
                (today.year(), q + 1)
            };
            let cq = (cell_date.month() - 1) / 3;
            cell_date.year() == y && cq == nq
        }
        TimePeriod::ThisYear => cell_date.year() == today.year(),
        TimePeriod::LastYear => cell_date.year() == today.year() - 1,
        TimePeriod::NextYear => cell_date.year() == today.year() + 1,
    }
}

// ============================================================================
// RULE EVALUATION
// ============================================================================

/// Evaluate a single rule for a cell
fn evaluate_rule(
    grid: &Grid,
    grids: &[Grid],
    sheet_names: &[String],
    active_sheet: usize,
    rule: &ConditionalFormatRule,
    format: &ConditionalFormat,
    row: u32,
    col: u32,
    stats: Option<&RangeStats>,
) -> Option<CellConditionalFormat> {
    let cell = grid.cells.get(&(row, col));
    let cell_value = cell.map(|c| &c.value);

    match rule {
        // ---- Simple boolean rules ----
        ConditionalFormatRule::BlankCells => {
            let matches = cell_value
                .map(|v| matches!(v, CellValue::Empty))
                .unwrap_or(true);
            if matches {
                Some(make_cf(row, col, format))
            } else {
                None
            }
        }
        ConditionalFormatRule::NoBlanks => {
            let matches = cell_value
                .map(|v| !matches!(v, CellValue::Empty))
                .unwrap_or(false);
            if matches {
                Some(make_cf(row, col, format))
            } else {
                None
            }
        }
        ConditionalFormatRule::ErrorCells => {
            let matches = cell_value
                .map(|v| matches!(v, CellValue::Error(_)))
                .unwrap_or(false);
            if matches {
                Some(make_cf(row, col, format))
            } else {
                None
            }
        }
        ConditionalFormatRule::NoErrors => {
            let matches = cell_value
                .map(|v| !matches!(v, CellValue::Error(_)))
                .unwrap_or(true);
            if matches {
                Some(make_cf(row, col, format))
            } else {
                None
            }
        }
        ConditionalFormatRule::ContainsText(text_rule) => {
            if evaluate_text_rule(cell_value, text_rule) {
                Some(make_cf(row, col, format))
            } else {
                None
            }
        }
        ConditionalFormatRule::CellValue(value_rule) => {
            if evaluate_cell_value_rule(cell_value, value_rule) {
                Some(make_cf(row, col, format))
            } else {
                None
            }
        }

        // ---- TopBottom rules ----
        ConditionalFormatRule::TopBottom(tb_rule) => {
            let stats = stats?;
            let num = get_numeric_value(cell_value?)?;
            let len = stats.sorted_values.len();
            if len == 0 {
                return None;
            }

            let matches = match tb_rule.rule_type {
                TopBottomType::TopItems => {
                    let n = (tb_rule.rank as usize).min(len);
                    let threshold = stats.sorted_values[len - n];
                    num >= threshold
                }
                TopBottomType::BottomItems => {
                    let n = (tb_rule.rank as usize).min(len);
                    let threshold = stats.sorted_values[n - 1];
                    num <= threshold
                }
                TopBottomType::TopPercent => {
                    let count =
                        ((tb_rule.rank as f64 / 100.0) * len as f64).ceil() as usize;
                    let n = count.max(1).min(len);
                    let threshold = stats.sorted_values[len - n];
                    num >= threshold
                }
                TopBottomType::BottomPercent => {
                    let count =
                        ((tb_rule.rank as f64 / 100.0) * len as f64).ceil() as usize;
                    let n = count.max(1).min(len);
                    let threshold = stats.sorted_values[n - 1];
                    num <= threshold
                }
            };

            if matches {
                Some(make_cf(row, col, format))
            } else {
                None
            }
        }

        // ---- AboveAverage rules ----
        ConditionalFormatRule::AboveAverage(avg_rule) => {
            let stats = stats?;
            let num = get_numeric_value(cell_value?)?;

            let matches = match avg_rule.rule_type {
                AverageRuleType::AboveAverage => num > stats.mean,
                AverageRuleType::BelowAverage => num < stats.mean,
                AverageRuleType::EqualOrAboveAverage => num >= stats.mean,
                AverageRuleType::EqualOrBelowAverage => num <= stats.mean,
                AverageRuleType::OneStdDevAbove => num > stats.mean + stats.std_dev,
                AverageRuleType::OneStdDevBelow => num < stats.mean - stats.std_dev,
                AverageRuleType::TwoStdDevAbove => num > stats.mean + 2.0 * stats.std_dev,
                AverageRuleType::TwoStdDevBelow => num < stats.mean - 2.0 * stats.std_dev,
                AverageRuleType::ThreeStdDevAbove => num > stats.mean + 3.0 * stats.std_dev,
                AverageRuleType::ThreeStdDevBelow => num < stats.mean - 3.0 * stats.std_dev,
            };

            if matches {
                Some(make_cf(row, col, format))
            } else {
                None
            }
        }

        // ---- DuplicateValues ----
        ConditionalFormatRule::DuplicateValues => {
            let stats = stats?;
            let str_repr = cell_value_to_string(cell_value.unwrap_or(&CellValue::Empty));
            if str_repr.is_empty() {
                return None;
            }
            let count = stats.value_counts.get(&str_repr).copied().unwrap_or(0);
            if count > 1 {
                Some(make_cf(row, col, format))
            } else {
                None
            }
        }

        // ---- UniqueValues ----
        ConditionalFormatRule::UniqueValues => {
            let stats = stats?;
            let str_repr = cell_value_to_string(cell_value.unwrap_or(&CellValue::Empty));
            if str_repr.is_empty() {
                return None;
            }
            let count = stats.value_counts.get(&str_repr).copied().unwrap_or(0);
            if count == 1 {
                Some(make_cf(row, col, format))
            } else {
                None
            }
        }

        // ---- Expression (custom formula) ----
        ConditionalFormatRule::Expression(expr_rule) => {
            let result = crate::evaluate_formula_multi_sheet(
                grids,
                sheet_names,
                active_sheet,
                &expr_rule.formula,
            );
            let truthy = match result {
                CellValue::Number(n) => n != 0.0,
                CellValue::Boolean(b) => b,
                CellValue::Text(s) => !s.is_empty(),
                _ => false,
            };
            if truthy {
                Some(make_cf(row, col, format))
            } else {
                None
            }
        }

        // ---- TimePeriod ----
        ConditionalFormatRule::TimePeriod(tp_rule) => {
            if evaluate_time_period(cell_value, &tp_rule.period) {
                Some(make_cf(row, col, format))
            } else {
                None
            }
        }

        // ---- ColorScale ----
        ConditionalFormatRule::ColorScale(cs_rule) => {
            let stats = stats?;
            let num = get_numeric_value(cell_value?)?;
            if stats.sorted_values.is_empty() {
                return None;
            }

            let min_val = resolve_cf_point_value(&cs_rule.min_point, stats);
            let max_val = resolve_cf_point_value(&cs_rule.max_point, stats);

            if (max_val - min_val).abs() < f64::EPSILON {
                // All values are the same; use min color
                let mut cf = make_cf(row, col, format);
                cf.color_scale_color = Some(cs_rule.min_point.color.clone());
                return Some(cf);
            }

            let fraction = ((num - min_val) / (max_val - min_val)).clamp(0.0, 1.0);

            let color = if let Some(ref mid_point) = cs_rule.mid_point {
                // 3-color scale
                let mid_val = resolve_cf_point_value(mid_point, stats);
                let mid_frac = if (max_val - min_val).abs() > f64::EPSILON {
                    ((mid_val - min_val) / (max_val - min_val)).clamp(0.0, 1.0)
                } else {
                    0.5
                };

                if fraction <= mid_frac {
                    let t = if mid_frac > 0.0 {
                        fraction / mid_frac
                    } else {
                        0.0
                    };
                    interpolate_color(&cs_rule.min_point.color, &mid_point.color, t)
                } else {
                    let t = if (1.0 - mid_frac) > 0.0 {
                        (fraction - mid_frac) / (1.0 - mid_frac)
                    } else {
                        1.0
                    };
                    interpolate_color(&mid_point.color, &cs_rule.max_point.color, t)
                }
            } else {
                // 2-color scale
                interpolate_color(&cs_rule.min_point.color, &cs_rule.max_point.color, fraction)
            };

            let mut cf = make_cf(row, col, format);
            cf.color_scale_color = Some(color);
            Some(cf)
        }

        // ---- DataBar ----
        ConditionalFormatRule::DataBar(db_rule) => {
            let stats = stats?;
            let num = get_numeric_value(cell_value?)?;
            if stats.sorted_values.is_empty() {
                return None;
            }

            let min_val = match db_rule.min_value_type {
                CFValueType::AutoMin | CFValueType::Min => stats.min,
                CFValueType::Number => db_rule.min_value.unwrap_or(stats.min),
                CFValueType::Percent => {
                    let pct = db_rule.min_value.unwrap_or(0.0) / 100.0;
                    stats.min + (stats.max - stats.min) * pct
                }
                CFValueType::Percentile => {
                    let pct = db_rule.min_value.unwrap_or(0.0) / 100.0;
                    let idx = (pct * (stats.sorted_values.len() - 1) as f64).round() as usize;
                    stats.sorted_values[idx.min(stats.sorted_values.len() - 1)]
                }
                _ => stats.min,
            };

            let max_val = match db_rule.max_value_type {
                CFValueType::AutoMax | CFValueType::Max => stats.max,
                CFValueType::Number => db_rule.max_value.unwrap_or(stats.max),
                CFValueType::Percent => {
                    let pct = db_rule.max_value.unwrap_or(100.0) / 100.0;
                    stats.min + (stats.max - stats.min) * pct
                }
                CFValueType::Percentile => {
                    let pct = db_rule.max_value.unwrap_or(100.0) / 100.0;
                    let idx = (pct * (stats.sorted_values.len() - 1) as f64).round() as usize;
                    stats.sorted_values[idx.min(stats.sorted_values.len() - 1)]
                }
                _ => stats.max,
            };

            let range = max_val - min_val;
            let percent = if range.abs() > f64::EPSILON {
                ((num - min_val) / range).clamp(0.0, 1.0)
            } else {
                0.5
            };

            let mut cf = make_cf(row, col, format);
            cf.data_bar_percent = Some(percent);
            Some(cf)
        }

        // ---- IconSet ----
        ConditionalFormatRule::IconSet(is_rule) => {
            let stats = stats?;
            let num = get_numeric_value(cell_value?)?;
            if stats.sorted_values.is_empty() {
                return None;
            }

            let icon_count = get_icon_count(&is_rule.icon_set);
            let thresholds = &is_rule.thresholds;

            // Determine which icon index this value falls into.
            // Thresholds define boundaries between icons. thresholds[0] is between
            // icon 0 (bottom) and icon 1, etc.
            // We iterate from highest threshold to lowest.
            let mut icon_index = 0u32; // Default to lowest icon

            for (i, threshold) in thresholds.iter().enumerate().rev() {
                let threshold_val = resolve_threshold_value(threshold, stats);
                let passes = match threshold.operator {
                    ThresholdOperator::GreaterThanOrEqual => num >= threshold_val,
                    ThresholdOperator::GreaterThan => num > threshold_val,
                };
                if passes {
                    icon_index = (i as u32) + 1;
                    break;
                }
            }

            if is_rule.reverse_icons {
                icon_index = (icon_count - 1).saturating_sub(icon_index);
            }

            let mut cf = make_cf(row, col, format);
            cf.icon_index = Some(icon_index);
            Some(cf)
        }
    }
}

/// Create a basic CellConditionalFormat result
fn make_cf(row: u32, col: u32, format: &ConditionalFormat) -> CellConditionalFormat {
    CellConditionalFormat {
        row,
        col,
        format: format.clone(),
        data_bar_percent: None,
        icon_index: None,
        color_scale_color: None,
    }
}

/// Resolve a ColorScalePoint's effective numeric value given range stats
fn resolve_cf_point_value(point: &ColorScalePoint, stats: &RangeStats) -> f64 {
    match point.value_type {
        CFValueType::Min | CFValueType::AutoMin => stats.min,
        CFValueType::Max | CFValueType::AutoMax => stats.max,
        CFValueType::Number => point.value.unwrap_or(stats.min),
        CFValueType::Percent => {
            let pct = point.value.unwrap_or(50.0) / 100.0;
            stats.min + (stats.max - stats.min) * pct
        }
        CFValueType::Percentile => {
            let pct = point.value.unwrap_or(50.0) / 100.0;
            if stats.sorted_values.is_empty() {
                return stats.min;
            }
            let idx = (pct * (stats.sorted_values.len() - 1) as f64).round() as usize;
            stats.sorted_values[idx.min(stats.sorted_values.len() - 1)]
        }
        CFValueType::Formula => {
            // Formula evaluation would require grid context; fall back to the literal value
            point.value.unwrap_or(stats.min)
        }
    }
}

/// Resolve an icon set threshold value given range stats
fn resolve_threshold_value(threshold: &IconSetThreshold, stats: &RangeStats) -> f64 {
    match threshold.value_type {
        CFValueType::Number => threshold.value,
        CFValueType::Percent => {
            stats.min + (stats.max - stats.min) * (threshold.value / 100.0)
        }
        CFValueType::Percentile => {
            if stats.sorted_values.is_empty() {
                return threshold.value;
            }
            let pct = threshold.value / 100.0;
            let idx = (pct * (stats.sorted_values.len() - 1) as f64).round() as usize;
            stats.sorted_values[idx.min(stats.sorted_values.len() - 1)]
        }
        _ => threshold.value,
    }
}

/// Get the number of icons in an icon set type
fn get_icon_count(icon_set: &IconSetType) -> u32 {
    match icon_set {
        IconSetType::ThreeArrows
        | IconSetType::ThreeArrowsGray
        | IconSetType::ThreeFlags
        | IconSetType::ThreeTrafficLights1
        | IconSetType::ThreeTrafficLights2
        | IconSetType::ThreeSigns
        | IconSetType::ThreeSymbols
        | IconSetType::ThreeSymbols2
        | IconSetType::ThreeStars
        | IconSetType::ThreeTriangles => 3,
        IconSetType::FourArrows
        | IconSetType::FourArrowsGray
        | IconSetType::FourRating
        | IconSetType::FourTrafficLights
        | IconSetType::FourRedToBlack => 4,
        IconSetType::FiveArrows
        | IconSetType::FiveArrowsGray
        | IconSetType::FiveRating
        | IconSetType::FiveQuarters
        | IconSetType::FiveBoxes => 5,
    }
}

/// Evaluate a text-based rule
fn evaluate_text_rule(cell_value: Option<&CellValue>, rule: &ContainsTextRule) -> bool {
    let text = match cell_value {
        Some(CellValue::Text(s)) => s.to_lowercase(),
        Some(CellValue::Number(n)) => crate::format_number_simple(*n).to_lowercase(),
        _ => return false,
    };

    let search = rule.text.to_lowercase();

    match rule.rule_type {
        TextRuleType::Contains => text.contains(&search),
        TextRuleType::NotContains => !text.contains(&search),
        TextRuleType::BeginsWith => text.starts_with(&search),
        TextRuleType::EndsWith => text.ends_with(&search),
    }
}

/// Evaluate a cell value comparison rule
fn evaluate_cell_value_rule(cell_value: Option<&CellValue>, rule: &CellValueRule) -> bool {
    let num_value = match cell_value {
        Some(CellValue::Number(n)) => *n,
        _ => return false,
    };

    let value1: f64 = match rule.value1.parse() {
        Ok(v) => v,
        Err(_) => return false,
    };

    match rule.operator {
        CellValueOperator::Equal => (num_value - value1).abs() < f64::EPSILON,
        CellValueOperator::NotEqual => (num_value - value1).abs() >= f64::EPSILON,
        CellValueOperator::GreaterThan => num_value > value1,
        CellValueOperator::GreaterThanOrEqual => num_value >= value1,
        CellValueOperator::LessThan => num_value < value1,
        CellValueOperator::LessThanOrEqual => num_value <= value1,
        CellValueOperator::Between => {
            if let Some(ref v2_str) = rule.value2 {
                if let Ok(value2) = v2_str.parse::<f64>() {
                    let min = value1.min(value2);
                    let max = value1.max(value2);
                    return num_value >= min && num_value <= max;
                }
            }
            false
        }
        CellValueOperator::NotBetween => {
            if let Some(ref v2_str) = rule.value2 {
                if let Ok(value2) = v2_str.parse::<f64>() {
                    let min = value1.min(value2);
                    let max = value1.max(value2);
                    return num_value < min || num_value > max;
                }
            }
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_conditional_format_range_contains() {
        let range = ConditionalFormatRange {
            start_row: 5,
            start_col: 5,
            end_row: 10,
            end_col: 10,
        };

        assert!(range.contains(5, 5));
        assert!(range.contains(7, 7));
        assert!(range.contains(10, 10));
        assert!(!range.contains(4, 5));
        assert!(!range.contains(5, 11));
    }

    #[test]
    fn test_data_bar_rule_default() {
        let rule = DataBarRule::default();
        assert_eq!(rule.fill_color, "#638EC6");
        assert!(rule.show_value);
        assert!(rule.gradient_fill);
    }

    #[test]
    fn test_cf_value_type_default() {
        assert_eq!(CFValueType::default(), CFValueType::Number);
    }

    #[test]
    fn test_icon_set_type_default() {
        assert_eq!(IconSetType::default(), IconSetType::ThreeTrafficLights1);
    }
}
