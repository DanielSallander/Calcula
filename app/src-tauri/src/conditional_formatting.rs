//! FILENAME: app/src-tauri/src/conditional_formatting.rs
//! PURPOSE: Backend storage and evaluation for conditional formatting rules.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::State;

use crate::AppState;

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

    let mut result = Vec::new();

    for row in min_row..=max_row {
        for col in min_col..=max_col {
            // Find first matching rule for this cell
            for rule_def in rules.iter().filter(|r| r.enabled) {
                // Check if this cell is in any of the rule's ranges
                let in_range = rule_def.ranges.iter().any(|r| r.contains(row, col));
                if !in_range {
                    continue;
                }

                // Evaluate the rule
                if let Some(cf) = evaluate_rule(grid, &rule_def.rule, &rule_def.format, row, col) {
                    result.push(cf);

                    // Stop if true
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

    // Remove rules whose ranges are entirely within the specified range
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
// RULE EVALUATION
// ============================================================================

/// Evaluate a single rule for a cell
fn evaluate_rule(
    grid: &engine::Grid,
    rule: &ConditionalFormatRule,
    format: &ConditionalFormat,
    row: u32,
    col: u32,
) -> Option<CellConditionalFormat> {
    let cell = grid.cells.get(&(row, col));
    let cell_value = cell.map(|c| &c.value);

    let matches = match rule {
        ConditionalFormatRule::BlankCells => {
            cell_value.map(|v| matches!(v, engine::CellValue::Empty)).unwrap_or(true)
        }
        ConditionalFormatRule::NoBlanks => {
            cell_value.map(|v| !matches!(v, engine::CellValue::Empty)).unwrap_or(false)
        }
        ConditionalFormatRule::ErrorCells => {
            cell_value.map(|v| matches!(v, engine::CellValue::Error(_))).unwrap_or(false)
        }
        ConditionalFormatRule::NoErrors => {
            cell_value.map(|v| !matches!(v, engine::CellValue::Error(_))).unwrap_or(true)
        }
        ConditionalFormatRule::ContainsText(text_rule) => {
            evaluate_text_rule(cell_value, text_rule)
        }
        ConditionalFormatRule::CellValue(value_rule) => {
            evaluate_cell_value_rule(cell_value, value_rule)
        }
        // For complex rules that need more context, just return true for now
        // Full implementation would need access to more grid data
        ConditionalFormatRule::ColorScale(_) => true,
        ConditionalFormatRule::DataBar(_) => true,
        ConditionalFormatRule::IconSet(_) => true,
        ConditionalFormatRule::TopBottom(_) => true,
        ConditionalFormatRule::AboveAverage(_) => true,
        ConditionalFormatRule::DuplicateValues => true,
        ConditionalFormatRule::UniqueValues => true,
        ConditionalFormatRule::Expression(_) => true,
        ConditionalFormatRule::TimePeriod(_) => true,
    };

    if matches {
        Some(CellConditionalFormat {
            row,
            col,
            format: format.clone(),
            data_bar_percent: None,
            icon_index: None,
            color_scale_color: None,
        })
    } else {
        None
    }
}

/// Evaluate a text-based rule
fn evaluate_text_rule(
    cell_value: Option<&engine::CellValue>,
    rule: &ContainsTextRule,
) -> bool {
    let text = match cell_value {
        Some(engine::CellValue::Text(s)) => s.to_lowercase(),
        Some(engine::CellValue::Number(n)) => crate::format_number_simple(*n).to_lowercase(),
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
fn evaluate_cell_value_rule(
    cell_value: Option<&engine::CellValue>,
    rule: &CellValueRule,
) -> bool {
    let num_value = match cell_value {
        Some(engine::CellValue::Number(n)) => *n,
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
