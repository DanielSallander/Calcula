//! FILENAME: app/src-tauri/src/conditional_formatting.rs
//! PURPOSE: Backend storage and evaluation for conditional formatting rules.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::State;

use crate::document_effect::DocumentEffect;
use crate::persistence::FileState;
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
    /// Formula string when min_value_type is Formula
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_formula: Option<String>,
    pub max_value_type: CFValueType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_value: Option<f64>,
    /// Formula string when max_value_type is Formula
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_formula: Option<String>,
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
            min_formula: None,
            max_value_type: CFValueType::AutoMax,
            max_value: None,
            max_formula: None,
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
    /// Formula string when value_type is Formula
    #[serde(skip_serializing_if = "Option::is_none")]
    pub formula: Option<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border_top_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border_top_style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border_bottom_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border_bottom_style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border_left_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border_left_style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border_right_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border_right_style: Option<String>,
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
    /// For data bars: the bar's LENGTH as a fraction (0.0 to 1.0) of the cell's
    /// bar area, measured from the axis when `data_bar_axis` is set and from the
    /// start edge otherwise (see `data_bar_geometry`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_bar_percent: Option<f64>,
    /// For data bars: where the AXIS sits, as a fraction (0.0 to 1.0) of the bar
    /// area from its start edge (the left, or the right under right-to-left).
    /// Absent when the bar has no axis: no negative values under Automatic, or
    /// the rule's axis is None.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_bar_axis: Option<f64>,
    /// For data bars: the value is NEGATIVE, so the bar runs from the axis toward
    /// the start edge and is painted in the rule's negative colours.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_bar_negative: Option<bool>,
    /// The rule hides the cell's VALUE and shows only its glyph: a data bar's
    /// "Show Bar Only" (`show_value` false) or an icon set's "Show Icon Only".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hide_value: Option<bool>,
    /// For icon sets: icon index
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_index: Option<u32>,
    /// For icon sets: WHICH icon set the index belongs to.
    ///
    /// Carried with the index because the two together are the icon, and apart
    /// they were a bug (BUG-0107): the frontend used to re-derive the set with its
    /// own rule search that matched on type and geometry only — no `enabled`, no
    /// `stop_if_true`, no priority — so a DISABLED five-icon rule could supply the
    /// glyph family for an index produced by an enabled three-icon rule, and a
    /// cell with no resolvable rule silently fell back to traffic lights.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_set: Option<IconSetType>,
    /// The rule this result came from. Set by the caller, which is the only place
    /// that knows the rule's identity, and kept so a consumer can attribute a
    /// result without searching for a rule that "looks like" the right one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule_id: Option<u64>,
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
    /// An OBJECT's cells (P3: a floating grid). The rule is stored under the
    /// object's BACKING sheet and its ranges are in the object's coordinates.
    #[serde(default)]
    pub target: Option<crate::api_types::CellTargetRef>,
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
    /// An OBJECT's cells (P3): the rule is looked up on the object's BACKING
    /// sheet, never the active sheet.
    #[serde(default)]
    pub target: Option<crate::api_types::CellTargetRef>,
}

// ============================================================================
// ENTRY CHECKS
// ============================================================================

/// What a conditional-format rule naming a structured reference is refused
/// with (NEW-cfdv-structured-refs). The refusal itself is [LIVE, Excel 16,
/// 2026-11-05, cfdv/probe1.ps1 C20]: `FormatConditions.Add` refuses
/// `=T1[@A]>1`, `=SUM(T1[A])>1` and `=T1[[#This Row],[A]]>1` while it accepts
/// `=SUM($A$2:$A$3)>1` and `=COUNT(T1)>0` (a table's bare NAME is an ordinary
/// name there). COM reports only E_INVALIDARG, so the sentence is Excel's
/// dialog text for a reference a rule cannot hold, not a measured string.
pub(crate) const CF_STRUCTURED_REFERENCE_REFUSAL: &str =
    "This type of reference cannot be used in a Conditional Formatting formula. \
     Change the reference to a single cell, or use the reference with a worksheet function, such as =SUM(A1:E5).";

/// Whether a rule formula names a structured reference (`Table1[Col]`,
/// `[@Col]`, `Table1[#All]`, ...). A text that does not parse is not one: the
/// rule's own evaluation reports it, as before.
pub(crate) fn formula_names_structured_reference(formula: &str) -> bool {
    let text = formula.trim();
    if text.is_empty() {
        return false;
    }
    let text = if text.starts_with('=') { text.to_string() } else { format!("={}", text) };
    match parser::parse(&text) {
        Ok(expr) => expression_names_structured_reference(&expr),
        Err(_) => false,
    }
}

/// Exhaustive on purpose: a new expression kind is a compile error here, not
/// a silent "no structured reference".
fn expression_names_structured_reference(expr: &engine::Expression) -> bool {
    use engine::Expression as X;
    match expr {
        X::TableRef { .. } => true,
        X::Literal(_) | X::CellRef { .. } | X::ColumnRef { .. } | X::RowRef { .. } | X::NamedRef { .. } => false,
        X::Range { start, end, .. } => {
            expression_names_structured_reference(start) || expression_names_structured_reference(end)
        }
        X::BinaryOp { left, right, .. } => {
            expression_names_structured_reference(left) || expression_names_structured_reference(right)
        }
        X::UnaryOp { operand, .. } | X::ImplicitIntersection { operand } => expression_names_structured_reference(operand),
        X::FunctionCall { args, .. } => args.iter().any(expression_names_structured_reference),
        X::Sheet3DRef { reference, .. } => expression_names_structured_reference(reference),
        X::IndexAccess { target, index } => {
            expression_names_structured_reference(target) || expression_names_structured_reference(index)
        }
        X::ArrayLiteral { rows } => rows.iter().flatten().any(expression_names_structured_reference),
        X::ListLiteral { elements } => elements.iter().any(expression_names_structured_reference),
        X::DictLiteral { entries } => entries
            .iter()
            .any(|(k, v)| expression_names_structured_reference(k) || expression_names_structured_reference(v)),
        X::SpillRef { cell, .. } => expression_names_structured_reference(cell),
    }
}

/// Every formula a rule carries, for the entry check and the structural
/// shift alike: the expression, a cell-value comparison's operands when they
/// are formulas (`=` first; a bare literal is a value), and the formula
/// thresholds of colour scales, data bars and icon sets.
pub(crate) fn rule_formulas_mut(rule: &mut ConditionalFormatRule) -> Vec<&mut String> {
    let mut out: Vec<&mut String> = Vec::new();
    match rule {
        ConditionalFormatRule::Expression(e) => out.push(&mut e.formula),
        ConditionalFormatRule::CellValue(cv) => {
            if cv.value1.trim_start().starts_with('=') {
                out.push(&mut cv.value1);
            }
            if let Some(v2) = cv.value2.as_mut() {
                if v2.trim_start().starts_with('=') {
                    out.push(v2);
                }
            }
        }
        ConditionalFormatRule::ColorScale(cs) => {
            out.extend(cs.min_point.formula.as_mut());
            if let Some(mid) = cs.mid_point.as_mut() {
                out.extend(mid.formula.as_mut());
            }
            out.extend(cs.max_point.formula.as_mut());
        }
        ConditionalFormatRule::DataBar(db) => {
            out.extend(db.min_formula.as_mut());
            out.extend(db.max_formula.as_mut());
        }
        ConditionalFormatRule::IconSet(is) => {
            for t in is.thresholds.iter_mut() {
                out.extend(t.formula.as_mut());
            }
        }
        ConditionalFormatRule::ContainsText(_)
        | ConditionalFormatRule::TopBottom(_)
        | ConditionalFormatRule::AboveAverage(_)
        | ConditionalFormatRule::DuplicateValues
        | ConditionalFormatRule::UniqueValues
        | ConditionalFormatRule::BlankCells
        | ConditionalFormatRule::NoBlanks
        | ConditionalFormatRule::ErrorCells
        | ConditionalFormatRule::NoErrors
        | ConditionalFormatRule::TimePeriod(_) => {}
    }
    out
}

/// The entry refusal for a rule: Excel's sentence when any of its formulas
/// names a structured reference, before any lock or effect.
pub(crate) fn rule_entry_refusal(rule: &ConditionalFormatRule) -> Option<String> {
    let mut probe = rule.clone();
    rule_formulas_mut(&mut probe)
        .into_iter()
        .any(|f| formula_names_structured_reference(f))
        .then(|| CF_STRUCTURED_REFERENCE_REFUSAL.to_string())
}

// ============================================================================
// COMMANDS
// ============================================================================

/// Resolve an optional 0-based sheet index: None = the active sheet, Some(i)
/// must be in range. The CF storage is a HashMap keyed by sheet index, so
/// without this an out-of-range index would silently read (or clear) a phantom
/// sheet's rule list instead of erroring.
fn resolve_cf_sheet(state: &AppState, sheet_index: Option<usize>) -> Result<usize, String> {
    let active = *state.active_sheet.read().unwrap();
    match sheet_index {
        None => Ok(active),
        Some(idx) => {
            let count = state.sheet_names.read().unwrap().len();
            if idx < count {
                Ok(idx)
            } else {
                Err(format!(
                    "Sheet index {} out of range: workbook has {} sheet(s)",
                    idx, count
                ))
            }
        }
    }
}

/// The sheet a CF command acts on when it names an OBJECT's cells (P3): the
/// object's BACKING sheet, resolved by id in the one resolver. A MUTATION
/// (`writes: true`) also asks the HOST's protection -- conditional formatting
/// is a cell-format act, so a protected host refuses it without Format Cells,
/// as Excel does -- and refuses a range outside the object's write extent.
/// Call holding nothing.
fn cf_target_sheet(
    state: &AppState,
    target: &crate::api_types::CellTargetRef,
    ranges: &[ConditionalFormatRange],
    writes: bool,
) -> Result<usize, String> {
    let t = crate::cell_target::resolve_cell_target(state, target)?;
    for r in ranges {
        crate::cell_target::ensure_in_extent(&t, r.start_row, r.start_col, r.end_row, r.end_col)?;
    }
    if writes {
        crate::cell_target::gate_host_action(
            state,
            t.host_index,
            t.backing_index,
            "formatCells",
            "change conditional formatting",
        )?;
    }
    Ok(t.backing_index)
}

/// The sheet a CF write acts on: an OBJECT's backing sheet (`target`), a
/// sheet named by index (`sheet_index`: the Rules Manager's "Show formatting
/// rules for" another worksheet, which edits that sheet's rules as Excel's
/// does), or the active sheet. A named sheet must exist and, being formatted,
/// is asked its protection's Format Cells. Call holding nothing.
fn cf_write_sheet(
    state: &AppState,
    target: Option<&crate::api_types::CellTargetRef>,
    sheet_index: Option<usize>,
    ranges: &[ConditionalFormatRange],
) -> Result<usize, String> {
    if let Some(target) = target {
        return cf_target_sheet(state, target, ranges, true);
    }
    let active = *state.active_sheet.read().unwrap();
    let sheet = resolve_cf_sheet(state, sheet_index)?;
    if sheet != active {
        crate::protection::check_sheet_action(state, sheet, "formatCells", "change conditional formatting")?;
    }
    Ok(sheet)
}

/// Add a conditional format rule (on `sheet_index` when given, see
/// [`cf_write_sheet`]).
#[tauri::command]
pub fn add_conditional_format(
    state: State<AppState>,
    file_state: State<FileState>,
    params: AddCFParams,
    sheet_index: Option<usize>,
) -> CFResult {
    add_conditional_format_in(&state, &file_state, params, sheet_index)
}

/// Command body over plain references, so the dirty-flag contract is unit-testable
/// without a Tauri `State` (see `document_effect_pilot_tests`).
pub(crate) fn add_conditional_format_impl(
    state: &AppState,
    file_state: &FileState,
    params: AddCFParams,
) -> CFResult {
    add_conditional_format_in(state, file_state, params, None)
}

/// [`add_conditional_format_impl`] on a sheet named by index ([`cf_write_sheet`]).
pub(crate) fn add_conditional_format_in(
    state: &AppState,
    file_state: &FileState,
    params: AddCFParams,
    sheet_index: Option<usize>,
) -> CFResult {
    // A structured reference in any of the rule's formulas: Excel's refusal,
    // before any lock or effect (NEW-cfdv-structured-refs).
    if let Some(refusal) = rule_entry_refusal(&params.rule) {
        return CFResult::err(refusal);
    }
    // An OBJECT's cells (P3): the rule lives on its backing sheet. Every gate
    // runs before the effect below, so a refusal leaves the document clean.
    let active_sheet = match cf_write_sheet(state, params.target.as_ref(), sheet_index, &params.ranges) {
        Ok(sheet) => sheet,
        Err(e) => return CFResult::err(e),
    };
    // Rules live in `workbook.conditional_formats` and are written only by the save
    // path, so adding one changes what a save would write.
    let effect = DocumentEffect::mutates(file_state);
    let mut cf_storage = state.conditional_formats.write(&effect).unwrap();
    let mut next_id = state.next_cf_rule_id.lock().unwrap();

    let previous = cf_storage.get(&active_sheet).cloned().unwrap_or_default();
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

    // BUG-0020. Conditional formatting was the one persisted store whose own
    // commands recorded NOTHING: adding a rule was invisible to Ctrl+Z, which
    // Excel has always undone. `next_cf_rule_id` is deliberately NOT rolled
    // back — ids must stay unique across an undo/redo/re-add cycle, exactly as
    // the sheet-id and entity-id counters do.
    drop(next_id);
    drop(cf_storage);
    crate::undo_commands::record_conditional_formats_undo(
        state,
        active_sheet,
        previous,
        "Add conditional format",
    );

    CFResult::ok(rule)
}

/// Update a conditional format rule
#[tauri::command]
pub fn update_conditional_format(
    state: State<AppState>,
    file_state: State<FileState>,
    params: UpdateCFParams,
    sheet_index: Option<usize>,
) -> CFResult {
    update_conditional_format_in(&state, &file_state, params, sheet_index)
}

/// Command body over plain references, so the undo contract is unit-testable
/// without a Tauri `State`.
pub(crate) fn update_conditional_format_impl(
    state: &AppState,
    file_state: &FileState,
    params: UpdateCFParams,
) -> CFResult {
    update_conditional_format_in(state, file_state, params, None)
}

/// [`update_conditional_format_impl`] on a sheet named by index ([`cf_write_sheet`]).
pub(crate) fn update_conditional_format_in(
    state: &AppState,
    file_state: &FileState,
    params: UpdateCFParams,
    sheet_index: Option<usize>,
) -> CFResult {
    // The same entry refusal as `add` (NEW-cfdv-structured-refs), first.
    if let Some(refusal) = params.rule.as_ref().and_then(rule_entry_refusal) {
        return CFResult::err(refusal);
    }
    let ranges = params.ranges.clone().unwrap_or_default();
    let active_sheet = match cf_write_sheet(state, params.target.as_ref(), sheet_index, &ranges) {
        Ok(sheet) => sheet,
        Err(e) => return CFResult::err(e),
    };
    // Gate and mutation in ONE critical section (`lock_pending` then
    // `authorize`), and the effect only AFTER every refusal below
    // (NEW-cf-update-dirty): "No conditional formats" and "Rule not found"
    // change nothing, so they must leave the document clean.
    let pending = state.conditional_formats.lock_pending().unwrap();
    match pending.get(&active_sheet) {
        None => return CFResult::err("No conditional formats on this sheet"),
        Some(rules) if !rules.iter().any(|r| r.id == params.rule_id) => {
            return CFResult::err("Rule not found");
        }
        Some(_) => {}
    }
    let effect = DocumentEffect::mutates(file_state);
    let mut cf_storage = pending.authorize(&effect);
    let rules = cf_storage.get_mut(&active_sheet).expect("presence checked above");
    // Snapshot only once the rule is known to exist: a refusal must leave the
    // undo stack untouched, or Ctrl+Z starts consuming entries that undo
    // nothing.
    let previous = rules.clone();
    let rule = rules
        .iter_mut()
        .find(|r| r.id == params.rule_id)
        .expect("presence checked above");

    let rule_given = params.rule.is_some();
    if let Some(new_rule) = params.rule {
        rule.rule = new_rule;
    }
    if let Some(new_format) = params.format {
        rule.format = new_format;
    }
    if let Some(new_ranges) = params.ranges {
        // New ranges alone keep the rule's meaning, as Excel's
        // `ModifyAppliesToRange` does [LIVE, cfeval/probe1.ps1 P14]: the formula
        // is re-stated for the new anchor. A caller that sends the rule too
        // states its formula for the new ranges itself.
        if !rule_given {
            restate_rule_for_ranges(&mut rule.rule, &rule.ranges, &new_ranges);
        }
        rule.ranges = new_ranges;
    }
    if let Some(stop) = params.stop_if_true {
        rule.stop_if_true = stop;
    }
    if let Some(enabled) = params.enabled {
        rule.enabled = enabled;
    }

    let updated = rule.clone();
    drop(cf_storage);
    crate::undo_commands::record_conditional_formats_undo(
        state,
        active_sheet,
        previous,
        "Edit conditional format",
    );

    CFResult::ok(updated)
}

/// Delete a conditional format rule
#[tauri::command]
pub fn delete_conditional_format(
    state: State<AppState>,
    file_state: State<FileState>,
    rule_id: u64,
    target: Option<crate::api_types::CellTargetRef>,
    sheet_index: Option<usize>,
) -> CFResult {
    delete_conditional_format_in(&state, &file_state, rule_id, target.as_ref(), sheet_index)
}

/// Command body over plain references, so the undo contract is unit-testable
/// without a Tauri `State`.
pub(crate) fn delete_conditional_format_impl(
    state: &AppState,
    file_state: &FileState,
    rule_id: u64,
) -> CFResult {
    delete_conditional_format_on(state, file_state, rule_id, None)
}

/// [`delete_conditional_format_impl`] with an optional OBJECT target (P3):
/// the rule is removed from the object's backing sheet.
pub(crate) fn delete_conditional_format_on(
    state: &AppState,
    file_state: &FileState,
    rule_id: u64,
    target: Option<&crate::api_types::CellTargetRef>,
) -> CFResult {
    delete_conditional_format_in(state, file_state, rule_id, target, None)
}

/// [`delete_conditional_format_on`] on a sheet named by index ([`cf_write_sheet`]).
pub(crate) fn delete_conditional_format_in(
    state: &AppState,
    file_state: &FileState,
    rule_id: u64,
    target: Option<&crate::api_types::CellTargetRef>,
    sheet_index: Option<usize>,
) -> CFResult {
    let active_sheet = match cf_write_sheet(state, target, sheet_index, &[]) {
        Ok(sheet) => sheet,
        Err(e) => return CFResult::err(e),
    };
    // The refusals first, in the same critical section as the delete, and the
    // effect only after them: a refusal leaves the document clean.
    let pending = state.conditional_formats.lock_pending().unwrap();
    match pending.get(&active_sheet) {
        None => return CFResult::err("No conditional formats on this sheet"),
        Some(rules) if !rules.iter().any(|r| r.id == rule_id) => {
            return CFResult::err("Rule not found");
        }
        Some(_) => {}
    }
    let effect = DocumentEffect::mutates(file_state);
    let mut cf_storage = pending.authorize(&effect);
    let rules = cf_storage.get_mut(&active_sheet).expect("presence checked above");

    let previous = rules.clone();
    rules.retain(|r| r.id != rule_id);

    drop(cf_storage);
    crate::undo_commands::record_conditional_formats_undo(
        state,
        active_sheet,
        previous,
        "Delete conditional format",
    );

    CFResult::ok_empty()
}

/// Reorder conditional format rules
#[tauri::command]
pub fn reorder_conditional_formats(
    state: State<AppState>,
    file_state: State<FileState>,
    rule_ids: Vec<u64>,
    target: Option<crate::api_types::CellTargetRef>,
    sheet_index: Option<usize>,
) -> CFResult {
    reorder_conditional_formats_in(&state, &file_state, rule_ids, target.as_ref(), sheet_index)
}

/// Command body over plain references, so the undo contract is unit-testable
/// without a Tauri `State`.
pub(crate) fn reorder_conditional_formats_impl(
    state: &AppState,
    file_state: &FileState,
    rule_ids: Vec<u64>,
) -> CFResult {
    reorder_conditional_formats_on(state, file_state, rule_ids, None)
}

/// [`reorder_conditional_formats_impl`] with an optional OBJECT target (P3):
/// the object's backing sheet's rules are reordered.
pub(crate) fn reorder_conditional_formats_on(
    state: &AppState,
    file_state: &FileState,
    rule_ids: Vec<u64>,
    target: Option<&crate::api_types::CellTargetRef>,
) -> CFResult {
    reorder_conditional_formats_in(state, file_state, rule_ids, target, None)
}

/// [`reorder_conditional_formats_on`] on a sheet named by index ([`cf_write_sheet`]).
pub(crate) fn reorder_conditional_formats_in(
    state: &AppState,
    file_state: &FileState,
    rule_ids: Vec<u64>,
    target: Option<&crate::api_types::CellTargetRef>,
    sheet_index: Option<usize>,
) -> CFResult {
    let active_sheet = match cf_write_sheet(state, target, sheet_index, &[]) {
        Ok(sheet) => sheet,
        Err(e) => return CFResult::err(e),
    };
    // The refusal first, in the same critical section as the reorder, and the
    // effect only after it: a sheet with no rules leaves the document clean.
    let pending = state.conditional_formats.lock_pending().unwrap();
    if pending.get(&active_sheet).is_none() {
        return CFResult::err("No conditional formats on this sheet");
    }
    let effect = DocumentEffect::mutates(file_state);
    let mut cf_storage = pending.authorize(&effect);
    let rules = cf_storage.get_mut(&active_sheet).expect("presence checked above");

    let previous = rules.clone();
    let order_before: Vec<(u64, u32)> = rules.iter().map(|r| (r.id, r.priority)).collect();

    // Assign new priorities based on order in rule_ids
    for (priority, id) in rule_ids.iter().enumerate() {
        if let Some(rule) = rules.iter_mut().find(|r| r.id == *id) {
            rule.priority = priority as u32;
        }
    }

    // Sort by new priority
    rules.sort_by_key(|r| r.priority);

    let order_after: Vec<(u64, u32)> = rules.iter().map(|r| (r.id, r.priority)).collect();
    let changed = order_before != order_after;
    drop(cf_storage);
    // A reorder that reorders nothing records nothing: an undo entry that
    // restores an identical list is a Ctrl+Z that visibly does nothing.
    if changed {
        crate::undo_commands::record_conditional_formats_undo(
            state,
            active_sheet,
            previous,
            "Reorder conditional formats",
        );
    }

    CFResult::ok_empty()
}

/// Get a specific conditional format rule
#[tauri::command]
pub fn get_conditional_format(
    state: State<AppState>,
    rule_id: u64,
) -> Option<ConditionalFormatDefinition> {
    let active_sheet = *state.active_sheet.read().unwrap();
    let cf_storage = state.conditional_formats.read().unwrap();

    cf_storage
        .get(&active_sheet)
        .and_then(|rules| rules.iter().find(|r| r.id == rule_id).cloned())
}

/// Get all conditional format rules for the current sheet (or `sheet_index`).
#[tauri::command]
pub fn get_all_conditional_formats(
    state: State<AppState>,
    sheet_index: Option<usize>,
    target: Option<crate::api_types::CellTargetRef>,
) -> Result<Vec<ConditionalFormatDefinition>, String> {
    get_all_conditional_formats_on(&state, sheet_index, target.as_ref())
}

/// [`get_all_conditional_formats`] over plain references. With an OBJECT
/// target (P3): the object's backing sheet's rules, never the active sheet's.
pub(crate) fn get_all_conditional_formats_on(
    state: &AppState,
    sheet_index: Option<usize>,
    target: Option<&crate::api_types::CellTargetRef>,
) -> Result<Vec<ConditionalFormatDefinition>, String> {
    let target_sheet = match target {
        Some(t) => {
            if sheet_index.is_some() {
                return Err("Pass a floating grid target or a sheet, not both.".to_string());
            }
            cf_target_sheet(state, t, &[], false)?
        }
        None => resolve_cf_sheet(state, sheet_index)?,
    };
    let cf_storage = state.conditional_formats.read().unwrap();

    Ok(cf_storage
        .get(&target_sheet)
        .cloned()
        .unwrap_or_default())
}

/// WHICH icon a cell displays: the set it belongs to and the index within it.
///
/// The value sorting and filtering compare. Both halves are needed — an index
/// alone is meaningless across sets, which is the mistake BUG-0107 was.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IconRef {
    pub icon_set: IconSetType,
    pub icon_index: u32,
}

/// A snapshot of one sheet's conditional-format rules, taken and released in a
/// single expression.
///
/// Exists to kill a whole class of lock-ordering question rather than to answer
/// it. Sorting holds the grid guards for its entire two-phase pass, and undo
/// restore takes `conditional_formats.write(effect)`; a CF guard held across
/// either is a deadlock waiting for the right interleaving. Callers take this
/// BEFORE any long-lived guard, the same way `sheet_names` is cloned before the
/// sort's own locks.
pub(crate) fn rules_snapshot(state: &AppState, sheet: usize) -> Vec<ConditionalFormatDefinition> {
    state
        .conditional_formats
        .read()
        .ok()
        .and_then(|store| store.get(&sheet).cloned())
        .unwrap_or_default()
}

/// The icon each requested cell DISPLAYS, or `None` where it displays none.
///
/// Used by sort and filter, which must agree with the screen: "sort by the icon
/// I can see" is only meaningful if this returns exactly what the renderer draws.
///
/// FOUR THINGS THIS GETS RIGHT that a naive loop would not:
///
/// 1. THE MAP IS TOTAL. Every requested cell has an entry, and `None` means
///    "genuinely no icon" rather than "not computed". A caller that had to
///    distinguish a missing key from an empty value would eventually get it
///    wrong, and the wrong answer is a silently mis-ordered sort.
/// 2. PRIORITY IS EXPLICIT, not inherited from vec order. `add` and `reorder`
///    keep the store sorted, but the `.cala` restore `extend`s without
///    re-sorting — so trusting the order would make a document's icon order
///    depend on whether it had just been loaded.
/// 3. THE CASCADE, not one rule: `enabled` is honoured, `stop_if_true` stops, and
///    the FIRST icon produced wins — the same answer the renderer takes.
/// 4. THE INDEX IS CLAMPED to the set's own icon count. Nothing validates that a
///    rule's threshold list matches its set size, and only the frontend clamped,
///    so an over-long list would otherwise sort on an icon nobody ever saw.
///
/// The `surface` parameter is load-bearing and NOT cosmetic: repainting installs
/// `Transient`, where a tripped fuel budget costs a highlight. On a sort it would
/// cost a wrong ORDER, so sort/filter pass `Interactive` — the user typed this
/// and is waiting.
pub(crate) fn resolve_icons(
    grid: &Grid,
    grids: &[Grid],
    sheet_names: &[String],
    sheet_index: usize,
    rules: &[ConditionalFormatDefinition],
    cells: &[(u32, u32)],
    surface: crate::eval_budget::EvalSurface,
    // The workbook's names, tables and spill map (BUG-0748): without them a
    // rule naming one answered #NAME? here while the screen formatted it, so a
    // sort or filter by its icon matched nothing. `None` only in tests.
    names: Option<crate::name_resolution::NameTables<'_>>,
) -> HashMap<(u32, u32), Option<IconRef>> {
    let _governor = crate::eval_budget::install(surface);
    // Each rule formula parsed once for the pass, evaluated per cell relative
    // to its rule's anchor (NEW-cf-relative-eval).
    let formulas = match names {
        Some(tables) => RuleFormulas::resolved(grids, sheet_names, sheet_index, tables),
        None => RuleFormulas::new(grids, sheet_names, sheet_index, None),
    };

    // Priority order, explicitly. Lower priority value = higher precedence.
    let mut ordered: Vec<&ConditionalFormatDefinition> =
        rules.iter().filter(|r| r.enabled).collect();
    ordered.sort_by_key(|r| r.priority);

    // One RangeStats per rule for the whole pass — a property of the rule's
    // ranges, not of the cell being asked about.
    let stats: Vec<Option<RangeStats>> = ordered
        .iter()
        .map(|r| {
            if needs_range_stats(&r.rule) {
                Some(collect_range_stats(grid, &r.ranges))
            } else {
                None
            }
        })
        .collect();

    let mut out: HashMap<(u32, u32), Option<IconRef>> = HashMap::with_capacity(cells.len());
    for &(row, col) in cells {
        // Every requested cell gets an entry, whatever happens below.
        let mut found: Option<IconRef> = None;
        for (idx, rule_def) in ordered.iter().enumerate() {
            if !rule_def.ranges.iter().any(|r| r.contains(row, col)) {
                continue;
            }
            let anchor = rule_anchor(&rule_def.ranges).unwrap_or((row, col));
            if let Some(cf) = evaluate_rule(
                grid,
                &formulas,
                anchor,
                &rule_def.rule,
                &rule_def.format,
                row,
                col,
                stats[idx].as_ref(),
            ) {
                if let (Some(set), Some(index)) = (cf.icon_set, cf.icon_index) {
                    let limit = get_icon_count(&set).saturating_sub(1);
                    found = Some(IconRef {
                        icon_set: set,
                        icon_index: index.min(limit),
                    });
                    break;
                }
                // A non-icon rule matched. `stop_if_true` still applies: the
                // renderer would stop here too, so an icon rule below it does
                // NOT draw, and must not sort as though it did.
                if rule_def.stop_if_true {
                    break;
                }
            }
        }
        out.insert((row, col), found);
    }
    out
}

/// Evaluate conditional formats over a rectangle, for an EXPLICITLY NAMED sheet
/// and an explicit rule list.
///
/// The distinct icons a range actually SHOWS, for the Sort dialog's icon picker.
///
/// WHY THIS IS A COMMAND AND NOT A FRONTEND SCAN OVER
/// `evaluate_conditional_formats`. The two paths disagree, and the disagreement
/// is invisible from the frontend:
///
///   - `evaluate_conditional_formats_for` pushes ONE RESULT PER MATCHING RULE
///     and breaks only on `stop_if_true`, in the rules' STORAGE order.
///   - `resolve_icons` — which sorting and filtering key on — sorts by PRIORITY
///     and takes the FIRST icon-producing rule, then stops.
///
/// So over a column covered by two enabled icon-set rules, a flat scan of the
/// evaluate results lists icons from the second rule as well. Those icons can
/// never be what a cell shows, so choosing one yields a sort that matches no
/// rows, moves nothing, and reports success — BUG-0104's own defect class,
/// recreated one layer up in the fix for it.
///
/// Asking the ONE evaluator the sort keys on removes the possibility by
/// construction: every icon this returns is an icon a sort can match.
///
/// `Interactive` for the same reason the sort passes it: the user opened a
/// dropdown and is waiting, and a tripped fuel budget here costs a missing
/// OPTION rather than a missing highlight.
///
/// `target` (BUG-0514): the range is a floating grid's cells -- the icons its
/// BACKING sheet's rules show there (the same `resolve_icons` the targeted sort
/// keys on), with the rectangle CLIPPED to the object's write extent (a read
/// past it is not an error, there is simply nothing there). Never the active
/// sheet's icons at the object's coordinates.
#[tauri::command]
pub fn get_range_icons(
    state: State<AppState>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
    target: Option<crate::api_types::CellTargetRef>,
) -> Result<Vec<IconRef>, String> {
    get_range_icons_on(&state, start_row, start_col, end_row, end_col, target.as_ref())
}

/// [`get_range_icons`] over plain references (tests drive the real body).
pub(crate) fn get_range_icons_on(
    state: &AppState,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
    target: Option<&crate::api_types::CellTargetRef>,
) -> Result<Vec<IconRef>, String> {
    let min_row = start_row.min(end_row);
    let mut max_row = start_row.max(end_row);
    let min_col = start_col.min(end_col);
    let mut max_col = start_col.max(end_col);
    // The sheet whose icons are asked: the object's backing sheet (resolved by
    // id, holding nothing), else the active sheet.
    let resolved = match target {
        Some(target) => {
            let t = crate::cell_target::resolve_cell_target(state, target)?;
            if t.extent_rows == 0 || t.extent_cols == 0 || min_row >= t.extent_rows || min_col >= t.extent_cols {
                return Ok(Vec::new());
            }
            max_row = max_row.min(t.extent_rows - 1);
            max_col = max_col.min(t.extent_cols - 1);
            Some(t)
        }
        None => None,
    };
    let sheet = match &resolved {
        Some(t) => t.backing_index,
        None => *state.active_sheet.read().unwrap(),
    };
    // Taken and released before the grid guards, the way this module's other
    // callers do it, so no CF guard is alive across a long-lived grid borrow.
    let rules = match state.conditional_formats.read().unwrap().get(&sheet) {
        Some(r) => r.clone(),
        None => return Ok(Vec::new()),
    };
    if rules.is_empty() {
        return Ok(Vec::new());
    }
    // Names and tables, snapshotted before the grid guards (BUG-0748).
    let names = snapshot_rule_names(state);

    let grids = state.grids.read().unwrap();
    if let Some(t) = &resolved {
        // The backing sheet may have been renumbered since it was resolved:
        // re-checked under the held `grids` guard (`sheet_ids` after `grids`).
        crate::cell_target::ensure_target_still_at(state, t)?;
    }
    let sheet_names = state.sheet_names.read().unwrap();
    let grid = match grids.get(sheet) {
        Some(g) => g,
        None => return Ok(Vec::new()),
    };
    let mut cells: Vec<(u32, u32)> = Vec::new();
    for row in min_row..=max_row {
        for col in min_col..=max_col {
            cells.push((row, col));
        }
    }

    let shown = resolve_icons(
        grid,
        &grids,
        &sheet_names,
        sheet,
        &rules,
        &cells,
        crate::eval_budget::EvalSurface::Interactive,
        Some(names.tables(&sheet_names)),
    );

    // Distinct, and ordered by set then by the icon's own position within it, so
    // the dropdown reads the way the set does rather than in scan order.
    let mut seen: Vec<IconRef> = Vec::new();
    for icon in shown.into_values().flatten() {
        if !seen.contains(&icon) {
            seen.push(icon);
        }
    }
    seen.sort_by(|a, b| {
        format!("{:?}", a.icon_set)
            .cmp(&format!("{:?}", b.icon_set))
            .then(a.icon_index.cmp(&b.icon_index))
    });
    Ok(seen)
}

/// The pure twin of the `evaluate_conditional_formats` command, which is wired to
/// `State<AppState>` and to the ACTIVE sheet. Two things need this shape:
///
///   - a unit test, which cannot build a `State<AppState>`, so the cascade
///     (`enabled`, priority, `stop_if_true`) had no direct coverage at all; and
///   - sorting and filtering by icon, which must resolve icons for the sheet they
///     were asked about rather than whichever one is on screen.
///
/// Takes plain refs and acquires no locks, so a caller may already hold the grid
/// guards it passes in.
///
/// TEST-ONLY since BUG-0748: it resolves no defined name, table or spill
/// reference, so a production path through it formatted differently from the
/// screen. Production callers use [`evaluate_conditional_formats_resolved`].
#[cfg(test)]
pub(crate) fn evaluate_conditional_formats_for(
    grid: &Grid,
    grids: &[Grid],
    sheet_names: &[String],
    sheet_index: usize,
    rules: &[ConditionalFormatDefinition],
    start_row: u32,
    end_row: u32,
    start_col: u32,
    end_col: u32,
) -> Vec<CellConditionalFormat> {
    evaluate_conditional_formats_with_names(
        grid, grids, sheet_names, sheet_index, None, rules, start_row, end_row, start_col, end_col,
    )
}

/// [`evaluate_conditional_formats_for`] with the workbook's defined names, so
/// a rule formula that names one (`=A1>Thr`) resolves it as a cell would.
#[allow(clippy::too_many_arguments)]
pub(crate) fn evaluate_conditional_formats_with_names(
    grid: &Grid,
    grids: &[Grid],
    sheet_names: &[String],
    sheet_index: usize,
    named_ranges: Option<&HashMap<String, crate::named_ranges::NamedRange>>,
    rules: &[ConditionalFormatDefinition],
    start_row: u32,
    end_row: u32,
    start_col: u32,
    end_col: u32,
) -> Vec<CellConditionalFormat> {
    // Each rule formula parsed once for the pass, evaluated per cell relative
    // to its rule's anchor (NEW-cf-relative-eval).
    let formulas = RuleFormulas::new(grids, sheet_names, sheet_index, named_ranges);
    evaluate_conditional_formats_over(grid, &formulas, rules, start_row, end_row, start_col, end_col)
}

/// The production evaluation: rule formulas resolved through the workbook's
/// names, tables and live spill map (`tables`), exactly as a cell's formula is
/// (BUG-0748). The painter, the floating-grid painter and every test of them
/// go through here.
#[allow(clippy::too_many_arguments)]
pub(crate) fn evaluate_conditional_formats_resolved(
    grid: &Grid,
    grids: &[Grid],
    sheet_names: &[String],
    sheet_index: usize,
    tables: crate::name_resolution::NameTables<'_>,
    rules: &[ConditionalFormatDefinition],
    start_row: u32,
    end_row: u32,
    start_col: u32,
    end_col: u32,
) -> Vec<CellConditionalFormat> {
    let formulas = RuleFormulas::resolved(grids, sheet_names, sheet_index, tables);
    evaluate_conditional_formats_over(grid, &formulas, rules, start_row, end_row, start_col, end_col)
}

/// The shared body of the two above, over a built [`RuleFormulas`].
fn evaluate_conditional_formats_over(
    grid: &Grid,
    formulas: &RuleFormulas,
    rules: &[ConditionalFormatDefinition],
    start_row: u32,
    end_row: u32,
    start_col: u32,
    end_col: u32,
) -> Vec<CellConditionalFormat> {
    let min_row = start_row.min(end_row);
    let max_row = start_row.max(end_row);
    let min_col = start_col.min(end_col);
    let max_col = start_col.max(end_col);
    let anchors: Vec<Option<(u32, u32)>> = rules.iter().map(|r| rule_anchor(&r.ranges)).collect();

    // One RangeStats per rule for the whole pass, never per cell: the stats are a
    // property of the rule's ranges, not of the cell being asked about.
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
                if !rule_def.ranges.iter().any(|r| r.contains(row, col)) {
                    continue;
                }
                if let Some(cf) = evaluate_rule(
                    grid,
                    formulas,
                    anchors[idx].unwrap_or((row, col)),
                    &rule_def.rule,
                    &rule_def.format,
                    row,
                    col,
                    rule_stats[idx].as_ref(),
                ) {
                    // Stamped here because this loop is the only place that knows
                    // WHICH rule produced the result, and it is the loop that
                    // applies `enabled`, priority and `stop_if_true` — so the id is
                    // the correctly-cascaded one by construction.
                    let mut cf = cf;
                    cf.rule_id = Some(rule_def.id);
                    result.push(cf);

                    if rule_def.stop_if_true {
                        break;
                    }
                }
            }
        }
    }
    result
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
    let active_sheet = *state.active_sheet.read().unwrap();
    // The defined names a rule formula may read, taken and released BEFORE the
    // grid guards (a snapshot: no names guard is ever held across them).
    // Names and tables included (BUG-0748): a rule's table or spill reference
    // resolves as in a cell.
    let names = snapshot_rule_names(&state);
    // CANONICAL LOCK ORDER: `grids` FIRST, then everything else.
    let grids = state.grids.read().unwrap();
    let sheet_names = state.sheet_names.read().unwrap();
    let cf_storage = state.conditional_formats.read().unwrap();

    let rules = match cf_storage.get(&active_sheet) {
        Some(r) => r,
        None => return EvaluateCFResult { cells: Vec::new() },
    };

    let grid = match grids.get(active_sheet) {
        Some(g) => g,
        None => return EvaluateCFResult { cells: Vec::new() },
    };

    // ONE implementation, shared with the sort/filter paths and with the tests.
    let result = evaluate_conditional_formats_resolved(
        grid,
        &grids,
        &sheet_names,
        active_sheet,
        names.tables(&sheet_names),
        rules,
        start_row,
        end_row,
        start_col,
        end_col,
    );

    EvaluateCFResult { cells: result }
}

/// Clear conditional formats in a range (on the active sheet, or `sheet_index`).
#[tauri::command]
pub fn clear_conditional_formats_in_range(
    state: State<AppState>,
    file_state: State<FileState>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
    sheet_index: Option<usize>,
    target: Option<crate::api_types::CellTargetRef>,
) -> Result<u32, String> {
    match target {
        Some(target) => clear_conditional_formats_in_range_on_target(
            &state, &file_state, start_row, start_col, end_row, end_col, sheet_index, &target,
        ),
        None => clear_conditional_formats_in_range_impl(
            &state, &file_state, start_row, start_col, end_row, end_col, sheet_index,
        ),
    }
}

/// Clear Rules from Selected Cells on an OBJECT's cells (P3): the cut is in
/// the object's coordinates, applied to its BACKING sheet's rules, after the
/// host's Format Cells gate and the extent check.
#[allow(clippy::too_many_arguments)]
pub(crate) fn clear_conditional_formats_in_range_on_target(
    state: &AppState,
    file_state: &FileState,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
    sheet_index: Option<usize>,
    target: &crate::api_types::CellTargetRef,
) -> Result<u32, String> {
    if sheet_index.is_some() {
        return Err("Pass a floating grid target or a sheet, not both.".to_string());
    }
    let cut = ConditionalFormatRange {
        start_row: start_row.min(end_row),
        start_col: start_col.min(end_col),
        end_row: start_row.max(end_row),
        end_col: start_col.max(end_col),
    };
    let backing = cf_target_sheet(state, target, std::slice::from_ref(&cut), true)?;
    clear_conditional_formats_in_range_impl(
        state, file_state, start_row, start_col, end_row, end_col, Some(backing),
    )
}

/// Command body over plain references, so the undo contract is unit-testable
/// without a Tauri `State`.
///
/// EXCEL'S CLEAR RULES FROM SELECTED CELLS CUTS THE SELECTION OUT OF EVERY RULE.
/// This used to remove a rule only when EVERY one of its ranges lay inside the
/// selection, so with a rule on A1:A10 and A1:A5 selected nothing happened at
/// all and nothing said so. Now each range loses the selected cells (what is
/// left is re-described as at most four rectangles: above, below, left and
/// right of the cut), and a rule left with no cell is removed. A rule's
/// formula is its anchor's (`rule_anchor`), so when the cut moves the anchor
/// the formula is re-stated for the new one (`restate_rule_for_ranges`) and
/// every remaining cell still tests what it tested before, as in Excel.
///
/// Returns the number of rules that changed (cut or removed). The
/// `DocumentEffect` is constructed only once something is known to change: a
/// selection that touches no rule leaves the document clean.
pub(crate) fn clear_conditional_formats_in_range_impl(
    state: &AppState,
    file_state: &FileState,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
    sheet_index: Option<usize>,
) -> Result<u32, String> {
    let target_sheet = resolve_cf_sheet(state, sheet_index)?;
    let cut = ConditionalFormatRange {
        start_row: start_row.min(end_row),
        start_col: start_col.min(end_col),
        end_row: start_row.max(end_row),
        end_col: start_col.max(end_col),
    };

    let cf_storage = state.conditional_formats.lock_pending().unwrap();
    let Some(rules) = cf_storage.get(&target_sheet) else {
        return Ok(0);
    };
    let previous = rules.clone();
    let mut next: Vec<ConditionalFormatDefinition> = Vec::with_capacity(rules.len());
    let mut changed: u32 = 0;
    for rule in rules {
        if !rule.ranges.iter().any(|r| ranges_intersect(r, &cut)) {
            next.push(rule.clone());
            continue;
        }
        changed += 1;
        let ranges: Vec<ConditionalFormatRange> =
            rule.ranges.iter().flat_map(|r| subtract_range(r, &cut)).collect();
        if !ranges.is_empty() {
            let mut kept = rule.clone();
            // The rule keeps its MEANING when its anchor moves: [LIVE, Excel
            // 16, cfeval/probe1.ps1 P13] clearing A1:A2 of `=$B1>5` on A1:A5
            // leaves A3:A5 testing B3..B5 (its formula is now `=$B3>5`).
            restate_rule_for_ranges(&mut kept.rule, &rule.ranges, &ranges);
            kept.ranges = ranges;
            next.push(kept);
        }
    }
    if changed == 0 {
        return Ok(0);
    }

    // Something changes: the document is dirty from here.
    let effect = DocumentEffect::mutates(file_state);
    let mut cf_storage = cf_storage.authorize(&effect);
    cf_storage.insert(target_sheet, next);
    drop(cf_storage);
    crate::undo_commands::record_conditional_formats_undo(
        state,
        target_sheet,
        previous,
        "Clear conditional formats",
    );

    Ok(changed)
}

// ============================================================================
// STRUCTURAL EDITS: RULE FORMULAS (NEW-cfdv-structural-shift)
// ============================================================================
//
// [LIVE, Excel 16, 2026-11-05, cfdv/probe1.ps1 C1-C19, V1-V11] a rule's
// formula is the formula of its ANCHOR cell -- the top-left of the rectangle
// bounding its ranges (`rule_anchor`; [LIVE] cfeval probe3 Q1-Q3 for several
// ranges) -- and every other cell of the range reads it moved by its offset, as
// a copied cell formula would be. A structural edit treats each cell's formula
// as that cell's own and then re-states the rule from its new top-left:
//   * insert row 1 under `=B2>$D$1` on B2:B10 -> B3:B11 `=B3>$D$2`; insert a
//     column before D -> `=B2>$E$1`; on another sheet `=B2>Other!$A$1` follows
//     a row inserted on Other -> `Other!$A$2`;
//   * delete row 1 -> B1:B9 `=B1>#REF!`; delete the row an absolute reference
//     names -> `#REF!`; delete the ANCHOR's row 2 -> B2:B9 `=B2>$D$1` (the old
//     B3's formula, now at B2 -- never `#REF!`);
//   * Insert Cells D1 down -> `$D$2`; Insert Cells B2 down -> B3:B11
//     `=B3>$D$1`; Delete Cells B1 up -> B1:B9 `=B1>$D$1`, C1 left -> `$C$1`;
//   * a cell-value rule's `=$D$1`, a colour scale's formula point and a list
//     validation's source `=$F$1:$F$5` (-> `$F$2:$F$6`, `$G$1:$G$5`, `#REF!`
//     when every row of it goes) follow the same rule, and so does a custom
//     validation `=H2>$D$1` (-> `=H3>$D$2`).
// When the edit leaves SOME cells' relative references deleted or moved and
// others not (`=B12>0` on B2:B10, delete row 12), Excel splits the rule (B2
// `=#REF!>0`, B3:B10 `=B12>0`); so does this, by `split_rule_by_meaning`
// (BUG-0743).

/// Whether `band` is a whole-line edit (Insert/Delete Sheet Rows/Columns).
fn is_whole_lines(band: &crate::commands::structure::structure_cells::BandEdit) -> bool {
    let full = if band.moves_rows() { engine::EXCEL_MAX_COL_INDEX } else { engine::EXCEL_MAX_ROW_INDEX };
    band.band_start == 0 && band.band_end >= full
}

/// One formula through a structural edit, by the shifter the CELLS use: the
/// sheet-aware whole-line shifters for Insert/Delete Rows and Columns,
/// `shift_formula_in_band` for Insert/Delete Cells. `formula_sheet` is the
/// sheet the rule lives on (what an unqualified reference means).
pub(crate) fn shift_rule_formula(
    formula: &str,
    formula_sheet: &str,
    edited_sheet: &str,
    band: &crate::commands::structure::structure_cells::BandEdit,
) -> String {
    use calp::writeback::StructuralEdit as SE;
    use crate::commands::structure::{shift_formula_cols_sheet_aware, shift_formula_rows_sheet_aware};
    if !is_whole_lines(band) {
        return crate::commands::structure::structure_cells::shift_formula_in_band(
            formula, formula_sheet, edited_sheet, band,
        );
    }
    match band.edit {
        SE::RowInsert { at, count } => shift_formula_rows_sheet_aware(formula, formula_sheet, edited_sheet, at, count as i32),
        SE::RowDelete { at, count } => shift_formula_rows_sheet_aware(formula, formula_sheet, edited_sheet, at, -(count as i32)),
        SE::ColInsert { at, count } => shift_formula_cols_sheet_aware(formula, formula_sheet, edited_sheet, at, count as i32),
        SE::ColDelete { at, count } => shift_formula_cols_sheet_aware(formula, formula_sheet, edited_sheet, at, -(count as i32)),
    }
}

/// Where the cell that sits at `(row, col)` AFTER `band` was before it. A cell
/// an insertion created is its neighbour's continuation (the line before the
/// insertion, Excel's "Format Same As Above / Left"), `None` only when the
/// insertion was at the first line.
pub(crate) fn band_origin(
    band: &crate::commands::structure::structure_cells::BandEdit,
    row: u32,
    col: u32,
) -> Option<(u32, u32)> {
    let rows = band.moves_rows();
    let (along, perp) = if rows { (row, col) } else { (col, row) };
    if perp < band.band_start || perp > band.band_end {
        return Some((row, col));
    }
    let (at, count) = (band.at() as u64, band.count() as u64);
    let a = along as u64;
    let origin = if band.inserting() {
        if a < at {
            a
        } else if a >= at + count {
            a - count
        } else if at > 0 {
            at - 1
        } else {
            return None;
        }
    } else if a >= at {
        a + count
    } else {
        a
    };
    let origin = u32::try_from(origin).ok()?;
    Some(if rows { (origin, perp) } else { (perp, origin) })
}

/// A rule formula anchored at `old_anchor` through `band`, re-stated from
/// `new_anchor` (the rule's top-left AFTER the edit): the formula of the cell
/// that moved to `new_anchor` -- the anchor's formula moved by that cell's
/// offset, as a copy would move it -- shifted as that cell's own formula.
pub(crate) fn rebase_rule_formula(
    formula: &str,
    old_anchor: (u32, u32),
    new_anchor: (u32, u32),
    formula_sheet: &str,
    edited_sheet: &str,
    band: &crate::commands::structure::structure_cells::BandEdit,
) -> String {
    let origin = band_origin(band, new_anchor.0, new_anchor.1).unwrap_or(old_anchor);
    let translated = if origin == old_anchor {
        formula.to_string()
    } else {
        crate::commands::structure::shift_formula_internal(
            formula,
            origin.0 as i32 - old_anchor.0 as i32,
            origin.1 as i32 - old_anchor.1 as i32,
        )
    };
    shift_rule_formula(&translated, formula_sheet, edited_sheet, band)
}

/// `formula` moved by (`drow`, `dcol`) the way Excel moves a rule or
/// validation formula to a new anchor: relative parts move, absolute ones
/// stay, and a part pushed past an edge WRAPS round the sheet -- never
/// `#REF!` (BUG-0743). [LIVE, Excel 16, 2026-11-06, cfdvb/probe1.ps1 B1-B4]
/// `=A1048576>0` on A1:A10, clear A1 -> A2:A10 `=A1>0`; `=XFD1>0` on A1:C1,
/// clear A1 -> B1:C1 `=A1>0`; ModifyAppliesToRange(A3:A10) -> `=A2>0`.
///
/// The fill shifter keeps the text as written whenever it can (no reference
/// crosses an edge); only a crossing re-renders the formula from its parse.
pub(crate) fn move_rule_formula_wrapping(formula: &str, drow: i64, dcol: i64) -> String {
    if drow == 0 && dcol == 0 {
        return formula.to_string();
    }
    let fits = |d: i64| d.abs() <= i32::MAX as i64;
    let shifted = if fits(drow) && fits(dcol) {
        let s = crate::commands::structure::shift_formula_internal(formula, drow as i32, dcol as i32);
        if s.matches("#REF!").count() <= formula.matches("#REF!").count() {
            return s;
        }
        Some(s)
    } else {
        None
    };
    match parser::parse(formula) {
        Ok(ast) => format!("={}", engine::ast_render::render_formula(&shift_relative_refs(&ast, drow, dcol))),
        Err(_) => shifted.unwrap_or_else(|| formula.to_string()),
    }
}

/// Whether a structural edit on `edited_sheet` reaches the cells a rule's
/// formulas name -- Excel's test for re-stating a rule cell by cell
/// ([`split_rule_by_meaning`]; [LIVE] cfdvfix/probe1-6.ps1, verify-cfdvfix
/// vprobe1-2.ps1). Each reference covers a rectangle, over the rule's rows
/// `old_rows` and columns `old_cols`:
///   * COLUMNS: an absolute column part's own column; a relative part's
///     columns moved by its offset from the anchor when that offset is zero or
///     more. A relative column part LEFT of the anchor takes the whole
///     reference out (`=K8` on M2:M6 never counts, `=O8` and `=$K8` do:
///     R9/W1/X1; `=A2` on C2:G2 through Delete Column B keeps one rule, XB),
///     and so does either END of a range or column range being one
///     (`=SUM(K8:O8)>0` on M2:M6, delete row 10, keeps ONE rule, V13). A row
///     reference (`2:2`) names every column.
///   * ROWS: an absolute row part's own row; a relative part's rows moved by
///     its offset, above the anchor included (WE: `=G1` on B2:F2, Delete
///     Column H, splits). A column reference names every row.
/// The edit covers, for a row edit, the band's columns and every row at or
/// below the edit (the rows it deletes or moves); for a column edit, every
/// column at or right of the edit and the band's rows (every row for Delete
/// Sheet Columns). So `=AND(K8>0,O1>0)` on M2:M6, delete row 10, keeps ONE
/// rule -- O1 reads O1:O5, above row 10 (V1) -- where `=AND(O8>0,K8>0)` splits,
/// O8:O12 reaching it (V11). Only references that name the edited sheet count
/// (an unqualified one names `formula_sheet`).
#[allow(clippy::too_many_arguments)]
fn edit_reaches_formula_columns(
    formulas: &[String],
    old_anchor: (u32, u32),
    old_rows: (u32, u32),
    old_cols: (u32, u32),
    formula_sheet: &str,
    edited_sheet: &str,
    band: &crate::commands::structure::structure_cells::BandEdit,
) -> bool {
    use engine::Expression as E;
    let (max_r, max_c) = (SHEET_ROWS - 1, SHEET_COLS - 1);
    // The edit's rectangle: (rows, columns).
    let edit: ((i64, i64), (i64, i64)) = if band.moves_rows() {
        ((band.at() as i64, max_r), (band.band_start as i64, band.band_end as i64))
    } else {
        ((band.band_start as i64, band.band_end as i64), (band.at() as i64, max_c))
    };
    type Extent = ((i64, i64), (i64, i64));
    struct Ctx<'a> {
        anchor: (i64, i64),
        rows: (i64, i64),
        cols: (i64, i64),
        formula_sheet: &'a str,
        edited_sheet: &'a str,
        max_r: i64,
        max_c: i64,
    }
    fn names_edited(ctx: &Ctx, sheet: Option<&str>) -> bool {
        identity::sheet_names_equal(sheet.unwrap_or(ctx.formula_sheet), ctx.edited_sheet)
    }
    /// A column part's columns; `None` when it takes the reference out (a
    /// relative part left of the anchor, or no column at all).
    fn col_part(ctx: &Ctx, col: &str, absolute: bool) -> Option<(i64, i64)> {
        if col.is_empty() || !col.chars().all(|c| c.is_ascii_alphabetic()) {
            return None;
        }
        let c = engine::col_to_index(col) as i64;
        if absolute {
            return Some((c, c));
        }
        let d = c - ctx.anchor.1;
        if d < 0 {
            return None;
        }
        Some((ctx.cols.0 + d, (ctx.cols.1 + d).min(ctx.max_c)))
    }
    /// A row part's rows (`row` is 1-based); `None` for no row at all.
    fn row_part(ctx: &Ctx, row: u32, absolute: bool) -> Option<(i64, i64)> {
        if row == 0 {
            return None;
        }
        let r = row as i64 - 1;
        if absolute {
            return Some((r, r));
        }
        let d = r - ctx.anchor.0;
        let (lo, hi) = ((ctx.rows.0 + d).max(0), (ctx.rows.1 + d).min(ctx.max_r));
        (lo <= hi).then_some((lo, hi))
    }
    fn both(a: Option<(i64, i64)>, b: Option<(i64, i64)>) -> Option<(i64, i64)> {
        Some((a?.0.min(b?.0), a?.1.max(b?.1)))
    }
    fn walk(e: &E, ctx: &Ctx, inherited: Option<&str>, out: &mut Vec<Extent>) {
        match e {
            E::CellRef { sheet, col, row, col_absolute, row_absolute, .. } => {
                let sheet = sheet.as_deref().or(inherited);
                if names_edited(ctx, sheet) {
                    if let (Some(c), Some(r)) = (col_part(ctx, col, *col_absolute), row_part(ctx, *row, *row_absolute)) {
                        out.push((r, c));
                    }
                }
            }
            E::Range { sheet, start, end, .. } => {
                let sheet = sheet.as_deref().or(inherited);
                match (start.as_ref(), end.as_ref()) {
                    (
                        E::CellRef { col: c0, row: r0, col_absolute: ca0, row_absolute: ra0, sheet: s0, .. },
                        E::CellRef { col: c1, row: r1, col_absolute: ca1, row_absolute: ra1, .. },
                    ) => {
                        if names_edited(ctx, s0.as_deref().or(sheet)) {
                            let cols = both(col_part(ctx, c0, *ca0), col_part(ctx, c1, *ca1));
                            let rows = both(row_part(ctx, *r0, *ra0), row_part(ctx, *r1, *ra1));
                            if let (Some(c), Some(r)) = (cols, rows) {
                                out.push((r, c));
                            }
                        }
                    }
                    _ => {
                        walk(start, ctx, sheet, out);
                        walk(end, ctx, sheet, out);
                    }
                }
            }
            E::ColumnRef { sheet, start_col, end_col, start_absolute, end_absolute, .. } => {
                if names_edited(ctx, sheet.as_deref().or(inherited)) {
                    if let Some(c) = both(col_part(ctx, start_col, *start_absolute), col_part(ctx, end_col, *end_absolute)) {
                        out.push(((0, ctx.max_r), c));
                    }
                }
            }
            E::RowRef { sheet, start_row, end_row, start_absolute, end_absolute, .. } => {
                if names_edited(ctx, sheet.as_deref().or(inherited)) {
                    if let Some(r) = both(row_part(ctx, *start_row, *start_absolute), row_part(ctx, *end_row, *end_absolute)) {
                        out.push((r, (0, ctx.max_c)));
                    }
                }
            }
            // A 3-D reference may span the edited sheet: counted.
            E::Sheet3DRef { reference, .. } => {
                let mut inner = Vec::new();
                let all = Ctx { edited_sheet: ctx.formula_sheet, ..*ctx };
                walk(reference, &all, None, &mut inner);
                out.extend(inner);
            }
            E::BinaryOp { left, right, .. } => {
                walk(left, ctx, inherited, out);
                walk(right, ctx, inherited, out);
            }
            E::UnaryOp { operand, .. } => walk(operand, ctx, inherited, out),
            E::FunctionCall { args, .. } => args.iter().for_each(|a| walk(a, ctx, inherited, out)),
            E::IndexAccess { target, index } => {
                walk(target, ctx, inherited, out);
                walk(index, ctx, inherited, out);
            }
            E::ArrayLiteral { rows } => rows.iter().flatten().for_each(|x| walk(x, ctx, inherited, out)),
            E::ListLiteral { elements } => elements.iter().for_each(|x| walk(x, ctx, inherited, out)),
            E::DictLiteral { entries } => entries.iter().for_each(|(k, v)| {
                walk(k, ctx, inherited, out);
                walk(v, ctx, inherited, out);
            }),
            E::SpillRef { cell, .. } => walk(cell, ctx, inherited, out),
            E::ImplicitIntersection { operand } => walk(operand, ctx, inherited, out),
            E::Literal(_) | E::NamedRef { .. } | E::TableRef { .. } => {}
        }
    }
    let ctx = Ctx {
        anchor: (old_anchor.0 as i64, old_anchor.1 as i64),
        rows: (old_rows.0 as i64, old_rows.1 as i64),
        cols: (old_cols.0 as i64, old_cols.1 as i64),
        formula_sheet,
        edited_sheet,
        max_r,
        max_c,
    };
    let mut extents = Vec::new();
    for f in formulas {
        if let Ok(ast) = parser::parse(f) {
            walk(&ast, &ctx, None, &mut extents);
        }
    }
    let meets = |a: (i64, i64), b: (i64, i64)| a.0 <= b.1 && a.1 >= b.0;
    extents.iter().any(|&(rows, cols)| meets(rows, edit.0) && meets(cols, edit.1))
}

/// Every RELATIVE row and column part of `expr` as an offset from `anchor`
/// (target line minus anchor line), for [`split_rule_by_meaning`].
fn collect_relative_offsets(expr: &engine::Expression, anchor: (u32, u32), rows: &mut Vec<i64>, cols: &mut Vec<i64>) {
    use engine::Expression as E;
    let mut walk = |e: &E, rows: &mut Vec<i64>, cols: &mut Vec<i64>| collect_relative_offsets(e, anchor, rows, cols);
    match expr {
        E::CellRef { col, row, col_absolute, row_absolute, .. } => {
            if !*row_absolute && *row > 0 {
                rows.push(*row as i64 - 1 - anchor.0 as i64);
            }
            if !*col_absolute && !col.is_empty() && col.chars().all(|c| c.is_ascii_alphabetic()) {
                cols.push(engine::col_to_index(col) as i64 - anchor.1 as i64);
            }
        }
        E::Range { start, end, .. } => {
            walk(start, rows, cols);
            walk(end, rows, cols);
        }
        E::ColumnRef { start_col, end_col, start_absolute, end_absolute, .. } => {
            for (c, abs) in [(start_col, start_absolute), (end_col, end_absolute)] {
                if !*abs && !c.is_empty() && c.chars().all(|ch| ch.is_ascii_alphabetic()) {
                    cols.push(engine::col_to_index(c) as i64 - anchor.1 as i64);
                }
            }
        }
        E::RowRef { start_row, end_row, start_absolute, end_absolute, .. } => {
            for (r, abs) in [(start_row, start_absolute), (end_row, end_absolute)] {
                if !*abs && *r > 0 {
                    rows.push(*r as i64 - 1 - anchor.0 as i64);
                }
            }
        }
        E::BinaryOp { left, right, .. } => {
            walk(left, rows, cols);
            walk(right, rows, cols);
        }
        E::UnaryOp { operand, .. } => walk(operand, rows, cols),
        E::FunctionCall { args, .. } => args.iter().for_each(|a| walk(a, rows, cols)),
        E::Sheet3DRef { reference, .. } => walk(reference, rows, cols),
        E::IndexAccess { target, index } => {
            walk(target, rows, cols);
            walk(index, rows, cols);
        }
        E::ArrayLiteral { rows: r } => r.iter().flatten().for_each(|e| walk(e, rows, cols)),
        E::ListLiteral { elements } => elements.iter().for_each(|e| walk(e, rows, cols)),
        E::DictLiteral { entries } => entries.iter().for_each(|(k, v)| {
            walk(k, rows, cols);
            walk(v, rows, cols);
        }),
        E::SpillRef { cell, .. } => walk(cell, rows, cols),
        E::ImplicitIntersection { operand } => walk(operand, rows, cols),
        E::Literal(_) | E::NamedRef { .. } | E::TableRef { .. } => {}
    }
}

/// The cells of a rule (or validation) that a structural edit leaves meaning
/// DIFFERENT things, grouped (BUG-0743).
///
/// A rule's formula is its anchor's; every other cell reads it moved by its
/// own offset. When an edit deletes (or moves past) the cells only SOME
/// cells' relative references point to, those cells' formulas change in a
/// way the others' do not, and one anchored formula can no longer say what
/// each cell tests. Excel SPLITS the rule: [LIVE, Excel 16, 2026-11-06,
/// cfdvb/probe1.ps1 A1-A12, probe2.ps1 I1-I7, V1]
///   * `=B12>0` on B2:B10, delete row 12 -> B2 `=#REF!>0`, B3:B10 `=B12>0`;
///   * `=B1>0` on B2:B10, delete row 5 -> B2:B4,B6:B9 `=B1>0`, B5 `=#REF!>0`
///     (cells meaning the same thing share ONE rule, over several areas);
///   * `=G2>0` on B2:F2, delete column H -> B2 `=G2>0`, C2 `=#REF!>0`,
///     D2:F2 `=H2>0`; delete row 14 under `=B12>0` -> three rules;
///   * inserts split too: `=B1>0` on B2:B10, insert row 5 -> B2:B5,B7:B11
///     `=B1>0`, B6 `=B4>0` (the inserted row continues the row above it);
///     `=B12>0`, insert row 5 -> B2:B5 `=B13>0`, B6:B11 `=B16>0`;
///   * a custom VALIDATION splits the same way (V1).
///
/// `formulas` are the rule's formulas written for `old_anchor` (the rule's
/// cells' top-left before the edit), `pieces` its ranges AFTER the edit
/// (`BandEdit::rule_range_pieces`). Returns `None` when every cell still means
/// the same thing (the common case: the caller keeps its one re-stated rule);
/// otherwise the groups, each its ranges and its formulas written for the
/// sheet's top-left cell (A1) -- place them at a group's own anchor with
/// [`move_rule_formula_wrapping`]. The anchor's group comes first, then the
/// rest in reading order.
///
/// COST: the formula is re-stated once per SEGMENT, not per cell. A cell's
/// meaning can only change where the cell, or one of its relative targets,
/// crosses the edit's lines or the band's edges (or the sheet's edge), so the
/// pieces are cut at the images of those lines and one representative cell
/// decides each sub-rectangle. A whole-column rule costs a handful of
/// re-statements, never a million.
///
/// WHEN EXCEL LOOKS AT THE TARGETS AT ALL (cfdvfix, [LIVE] Excel 16,
/// 2026-11-06, cfdvfix/probe1-6.ps1). Excel splits by meaning only when the
/// edit reaches the COLUMNS the formula's references name
/// ([`edit_reaches_formula_columns`]), and a relative column part to the LEFT
/// of the anchor never counts: `=K8<>""` on M2:M6, delete row 10, keeps ONE
/// rule and M4 reads `=K10` (the old K11) where `=O8<>""` splits M4 off as
/// `#REF!` (R9/W1, the same for a rule, UE/WB); `=$K8` splits (X1). Otherwise
/// the rule is cut only where its OWN cells were cut by the edit, and each
/// piece keeps what its own first cell reads: `=K1` on M2:M6, delete row 3,
/// gives M2 `=K1` and M3:M5 `=#REF!` (R1, a rule the same, T1);
/// `=COUNTA(K1:K2)=2` on M2:M4, delete row 1, stays one rule `=COUNTA(K1:K1)=2`
/// (Q2/R13). A data validation and a conditional format follow the same rule.
///
/// `edited_sheet` is the sheet the edit happened on and `cells_move` whether
/// the rule's own cells are on it (false for a rule on ANOTHER sheet that
/// refers to the edited one: its cells stay where they are and only the
/// references qualified with the edited sheet move, [LIVE] verify-cfdvb
/// P1-P3). `old_rows` and `old_cols` are the row and column spans of the rule's
/// ranges before the edit.
#[allow(clippy::too_many_arguments)]
pub(crate) fn split_rule_by_meaning(
    formulas: &[String],
    old_anchor: (u32, u32),
    old_rows: (u32, u32),
    old_cols: (u32, u32),
    pieces: &[crate::commands::coord_shift::CellRange],
    formula_sheet: &str,
    edited_sheet: &str,
    cells_move: bool,
    band: &crate::commands::structure::structure_cells::BandEdit,
) -> Option<Vec<(Vec<crate::commands::coord_shift::CellRange>, Vec<String>)>> {
    use crate::commands::coord_shift::CellRange;
    if formulas.is_empty() || pieces.is_empty() {
        return None;
    }
    let by_meaning = edit_reaches_formula_columns(formulas, old_anchor, old_rows, old_cols, formula_sheet, edited_sheet, band);
    if !by_meaning && !cells_move {
        // Nothing of the rule was cut: one formula, re-stated from its anchor.
        return None;
    }
    let (mut drows, mut dcols) = (Vec::new(), Vec::new());
    if by_meaning {
        for f in formulas {
            if let Ok(ast) = parser::parse(f) {
                collect_relative_offsets(&ast, old_anchor, &mut drows, &mut dcols);
            }
        }
        if drows.is_empty() && dcols.is_empty() {
            return None;
        }
    }
    let rows_move = band.moves_rows();
    let (at, count) = (band.at() as i64, band.count() as i64);
    let (along_offsets, perp_offsets, along_size, perp_size) = if rows_move {
        (&drows, &dcols, SHEET_ROWS, SHEET_COLS)
    } else {
        (&dcols, &drows, SHEET_COLS, SHEET_ROWS)
    };
    // Old-coordinate lines where a cell's meaning may change, on each axis.
    let mut along_old: Vec<i64> = if cells_move { vec![at, at + count] } else { Vec::new() };
    for &d in along_offsets {
        along_old.extend([at - d, at + count - d, along_size - d, -d]);
    }
    let (bs, be) = (band.band_start as i64, band.band_end as i64 + 1);
    let mut perp_cuts: Vec<i64> = if cells_move { vec![bs, be] } else { Vec::new() };
    for &d in perp_offsets {
        perp_cuts.extend([bs - d, be - d, perp_size - d, -d]);
    }
    // Their images in NEW coordinates; an insertion's own block is a segment
    // when meaning decides, and joins the line before it when only the
    // rule's own cut does (Excel's inserted line continues the one above).
    // A rule on another sheet does not move: its lines are its own.
    let mut along_cuts: Vec<i64> = Vec::new();
    for b in along_old {
        let b = b.rem_euclid(along_size);
        along_cuts.push(if !cells_move {
            b
        } else if band.inserting() {
            if b < at { b } else { b + count }
        } else if b < at {
            b
        } else if b < at + count {
            at
        } else {
            b - count
        });
    }
    if !by_meaning {
        // Only the rule's own cut: the moved part starts at `at` after a
        // delete, after the inserted block (which joins the part before it)
        // after an insert.
        along_cuts = vec![if band.inserting() { at + count } else { at }];
    } else if cells_move && band.inserting() {
        along_cuts.extend([at, at + count]);
    }
    let clean = |v: &mut Vec<i64>, size: i64| {
        v.retain(|&x| x > 0 && x < size);
        v.sort_unstable();
        v.dedup();
    };
    clean(&mut along_cuts, along_size);
    let mut perp_cuts: Vec<i64> = perp_cuts.into_iter().map(|x| x.rem_euclid(perp_size)).collect();
    clean(&mut perp_cuts, perp_size);
    let segments = |lo: u32, hi: u32, cuts: &[i64]| -> Vec<(u32, u32)> {
        let mut out = Vec::new();
        let mut start = lo as i64;
        for &c in cuts {
            if c > start && c <= hi as i64 {
                out.push((start as u32, (c - 1) as u32));
                start = c;
            }
        }
        out.push((start as u32, hi));
        out
    };
    // One canonical text per sub-rectangle: the formula its top-left cell
    // reads after the edit, moved to A1 (so equal texts mean equal meaning).
    let canonical_at = |row: u32, col: u32| -> Vec<String> {
        // The cell this one was before the edit; an inserted cell continues
        // the line before the insertion (Excel's Format Same As Above / Left).
        let (origin, origin_now) = if cells_move {
            let origin = band_origin(band, row, col).unwrap_or((row, col));
            (origin, band.shift_cell(origin.0, origin.1).unwrap_or((row, col)))
        } else {
            ((row, col), (row, col))
        };
        formulas
            .iter()
            .map(|f| {
                let at_origin = move_rule_formula_wrapping(
                    f,
                    origin.0 as i64 - old_anchor.0 as i64,
                    origin.1 as i64 - old_anchor.1 as i64,
                );
                let after = shift_rule_formula(&at_origin, formula_sheet, edited_sheet, band);
                let here = move_rule_formula_wrapping(
                    &after,
                    row as i64 - origin_now.0 as i64,
                    col as i64 - origin_now.1 as i64,
                );
                let canonical = move_rule_formula_wrapping(&here, -(row as i64), -(col as i64));
                // One spelling per meaning, whichever path each step took.
                match parser::parse(&canonical) {
                    Ok(ast) => format!("={}", engine::ast_render::render_formula(&ast)),
                    Err(_) => canonical,
                }
            })
            .collect()
    };
    let mut groups: Vec<(Vec<CellRange>, Vec<String>)> = Vec::new();
    for p in pieces {
        let (along_lo, along_hi, perp_lo, perp_hi) = if rows_move {
            (p.start_row, p.end_row, p.start_col, p.end_col)
        } else {
            (p.start_col, p.end_col, p.start_row, p.end_row)
        };
        for (q0, q1) in segments(perp_lo, perp_hi, &perp_cuts) {
            // Without meaning, only cells the edit MOVED are cut from the
            // rest: outside the band nothing moved ([LIVE] R4: `=K3` on
            // M2:M6, Delete Cells K3 up, stays one rule, all `#REF!`).
            let moved = q0 >= band.band_start && q1 <= band.band_end;
            let along = if by_meaning || moved { segments(along_lo, along_hi, &along_cuts) } else { vec![(along_lo, along_hi)] };
            for (a0, a1) in along {
                let sub = if rows_move {
                    CellRange { start_row: a0, end_row: a1, start_col: q0, end_col: q1 }
                } else {
                    CellRange { start_row: q0, end_row: q1, start_col: a0, end_col: a1 }
                };
                let key = canonical_at(sub.start_row, sub.start_col);
                match groups.iter_mut().find(|(_, k)| *k == key) {
                    Some((ranges, _)) => ranges.push(sub),
                    None => groups.push((vec![sub], key)),
                }
            }
        }
    }
    if groups.len() < 2 {
        return None;
    }
    for (ranges, _) in groups.iter_mut() {
        *ranges = merge_adjacent_ranges(std::mem::take(ranges));
    }
    // The group holding the anchor's own image first, the rest in reading
    // order (Excel's list order is cosmetic: the groups never share a cell).
    let anchor_now = if cells_move { band.shift_cell(old_anchor.0, old_anchor.1) } else { Some(old_anchor) };
    groups.sort_by_key(|(ranges, _)| {
        let holds_anchor = anchor_now.map_or(false, |(r, c)| {
            ranges.iter().any(|g| r >= g.start_row && r <= g.end_row && c >= g.start_col && c <= g.end_col)
        });
        let first = ranges.iter().map(|g| (g.start_row, g.start_col)).min().unwrap_or((0, 0));
        (!holds_anchor, first)
    });
    Some(groups)
}

/// Rectangles joined where two share a full edge (same columns and touching
/// rows, or same rows and touching columns), until none do.
fn merge_adjacent_ranges(mut ranges: Vec<crate::commands::coord_shift::CellRange>) -> Vec<crate::commands::coord_shift::CellRange> {
    loop {
        let mut merged = false;
        'outer: for i in 0..ranges.len() {
            for j in 0..ranges.len() {
                if i == j {
                    continue;
                }
                let (a, b) = (ranges[i], ranges[j]);
                let vertical = a.start_col == b.start_col && a.end_col == b.end_col && a.end_row as u64 + 1 == b.start_row as u64;
                let horizontal = a.start_row == b.start_row && a.end_row == b.end_row && a.end_col as u64 + 1 == b.start_col as u64;
                if vertical || horizontal {
                    ranges[i] = crate::commands::coord_shift::CellRange {
                        start_row: a.start_row,
                        end_row: b.end_row,
                        start_col: a.start_col,
                        end_col: b.end_col,
                    };
                    ranges.remove(j);
                    merged = true;
                    break 'outer;
                }
            }
        }
        if !merged {
            ranges.sort_by_key(|g| (g.start_row, g.start_col));
            return ranges;
        }
    }
}

/// Every formula of a rule ON THE EDITED SHEET, rebased from `old_anchor` to
/// `new_anchor`. Returns whether any changed.
pub(crate) fn rebase_rule_formulas(
    rule: &mut ConditionalFormatRule,
    old_anchor: (u32, u32),
    new_anchor: (u32, u32),
    formula_sheet: &str,
    edited_sheet: &str,
    band: &crate::commands::structure::structure_cells::BandEdit,
) -> bool {
    let mut changed = false;
    for formula in rule_formulas_mut(rule) {
        let next = rebase_rule_formula(formula, old_anchor, new_anchor, formula_sheet, edited_sheet, band);
        if next != *formula {
            *formula = next;
            changed = true;
        }
    }
    changed
}

/// The rules and validations on every sheet OTHER than the edited one: their
/// ranges stay, and only a reference QUALIFIED with the edited sheet's name
/// can reach it (`=B2>Other!$A$1`, a list source on the edited sheet).
/// Records one restore per store per sheet that changed, into the caller's
/// open transaction.
pub(crate) fn shift_other_sheets_rule_formulas(
    state: &AppState,
    effect: &DocumentEffect,
    undo_stack: &mut engine::UndoStack,
    edited_sheet: usize,
    sheet_names: &[String],
    band: &crate::commands::structure::structure_cells::BandEdit,
) {
    let Some(edited_name) = sheet_names.get(edited_sheet) else { return };
    if let Ok(mut store) = state.conditional_formats.write(effect) {
        for (&sheet, rules) in store.iter_mut() {
            if sheet == edited_sheet {
                continue;
            }
            let Some(formula_sheet) = sheet_names.get(sheet) else { continue };
            let previous = rules.clone();
            let mut changed = false;
            let mut split_any = false;
            let mut kept: Vec<ConditionalFormatDefinition> = Vec::with_capacity(rules.len());
            for mut rule in std::mem::take(rules) {
                // BUG-0743 (verify-cfdvb P1/P2, [LIVE]): an edit on the sheet a
                // rule REFERS to splits it as an edit on its own sheet does --
                // `=S2!B12>0` on B2:B10, delete S2 row 12 -> B2 `='S2'!#REF!>0`,
                // B3:B10 `='S2'!B12>0` -- though its cells stay where they are.
                let mut probe = rule.rule.clone();
                let formulas: Vec<String> = rule_formulas_mut(&mut probe).into_iter().map(|f| f.clone()).collect();
                if let Some(old) = rule_anchor(&rule.ranges).filter(|_| formulas.iter().any(|f| f.contains('!'))) {
                    let pieces: Vec<crate::commands::coord_shift::CellRange> = rule
                        .ranges
                        .iter()
                        .map(|r| crate::commands::coord_shift::CellRange {
                            start_row: r.start_row.min(r.end_row),
                            end_row: r.start_row.max(r.end_row),
                            start_col: r.start_col.min(r.end_col),
                            end_col: r.start_col.max(r.end_col),
                        })
                        .collect();
                    if let Some(groups) = split_rule_by_meaning(
                        &formulas,
                        old,
                        rule_row_span(&rule.ranges),
                        rule_column_span(&rule.ranges),
                        &pieces,
                        formula_sheet,
                        edited_name,
                        false,
                        band,
                    ) {
                        changed = true;
                        split_any = true;
                        for (index, (ranges, canonical)) in groups.into_iter().enumerate() {
                            let mut piece = rule.clone();
                            if index > 0 {
                                let mut next_id = state.next_cf_rule_id.lock().unwrap();
                                piece.id = *next_id;
                                *next_id += 1;
                            }
                            piece.ranges = ranges
                                .iter()
                                .map(|p| ConditionalFormatRange { start_row: p.start_row, start_col: p.start_col, end_row: p.end_row, end_col: p.end_col })
                                .collect();
                            if let Some(anchor) = rule_anchor(&piece.ranges) {
                                for (slot, text) in rule_formulas_mut(&mut piece.rule).into_iter().zip(canonical) {
                                    *slot = move_rule_formula_wrapping(&text, anchor.0 as i64, anchor.1 as i64);
                                }
                            }
                            kept.push(piece);
                        }
                        continue;
                    }
                }
                for formula in rule_formulas_mut(&mut rule.rule) {
                    let next = shift_rule_formula(formula, formula_sheet, edited_name, band);
                    if next != *formula {
                        *formula = next;
                        changed = true;
                    }
                }
                kept.push(rule);
            }
            *rules = kept;
            if split_any {
                for (index, rule) in rules.iter_mut().enumerate() {
                    rule.priority = index as u32 + 1;
                }
            }
            if changed {
                undo_stack.record_custom_restore(
                    "obj_conditional_formats".to_string(),
                    crate::undo_commands::conditional_formats_snapshot_bytes(sheet, previous),
                    "Shift conditional formats",
                );
            }
        }
    }
    if let Ok(mut store) = state.data_validations.write(effect) {
        for (&sheet, ranges) in store.iter_mut() {
            if sheet == edited_sheet {
                continue;
            }
            let Some(formula_sheet) = sheet_names.get(sheet) else { continue };
            let previous = ranges.clone();
            let mut changed = false;
            let mut split: Vec<crate::data_validation::ValidationRange> = Vec::new();
            ranges.retain(|range| {
                // BUG-0743 (verify-cfdvb P3, [LIVE]): a custom validation (or a
                // relative list source) on another sheet splits as a rule does.
                let formulas = crate::data_validation::validation_formulas(&range.validation, sheet, sheet_names);
                if !formulas.iter().any(|f| f.contains('!')) {
                    return true;
                }
                let rect = crate::commands::coord_shift::CellRange {
                    start_row: range.start_row,
                    end_row: range.end_row,
                    start_col: range.start_col,
                    end_col: range.end_col,
                };
                let Some(groups) = split_rule_by_meaning(
                    &formulas,
                    (range.start_row, range.start_col),
                    (range.start_row.min(range.end_row), range.start_row.max(range.end_row)),
                    (range.start_col, range.end_col),
                    &[rect],
                    formula_sheet,
                    edited_name,
                    false,
                    band,
                ) else {
                    return true;
                };
                for (rects, canonical) in groups {
                    for p in rects {
                        let mut piece = range.clone();
                        piece.start_row = p.start_row;
                        piece.end_row = p.end_row;
                        piece.start_col = p.start_col;
                        piece.end_col = p.end_col;
                        let placed: Vec<String> = canonical
                            .iter()
                            .map(|text| move_rule_formula_wrapping(text, p.start_row as i64, p.start_col as i64))
                            .collect();
                        crate::data_validation::set_validation_formulas(&mut piece.validation, &placed);
                        split.push(piece);
                    }
                }
                false
            });
            if !split.is_empty() {
                changed = true;
            }
            for range in ranges.iter_mut() {
                let anchor = (range.start_row, range.start_col);
                changed |= crate::data_validation::rebase_validation_formulas(
                    &mut range.validation,
                    sheet,
                    edited_sheet,
                    anchor,
                    anchor,
                    formula_sheet,
                    edited_name,
                    sheet_names,
                    band,
                );
            }
            ranges.extend(split);
            if changed {
                undo_stack.record_custom_restore(
                    "obj_validation".to_string(),
                    crate::undo_commands::validation_snapshot_bytes(sheet, previous),
                    "Shift data validations",
                );
            }
        }
    }
}

/// Do two rectangles share a cell?
fn ranges_intersect(a: &ConditionalFormatRange, b: &ConditionalFormatRange) -> bool {
    a.start_row <= b.end_row && b.start_row <= a.end_row && a.start_col <= b.end_col && b.start_col <= a.end_col
}

/// `range` minus `cut`, as at most four rectangles: the full-width bands above
/// and below the cut, then the parts left and right of it within the cut's
/// rows. Empty when the cut covers the whole range.
fn subtract_range(range: &ConditionalFormatRange, cut: &ConditionalFormatRange) -> Vec<ConditionalFormatRange> {
    if !ranges_intersect(range, cut) {
        return vec![range.clone()];
    }
    let mut out = Vec::with_capacity(4);
    if range.start_row < cut.start_row {
        out.push(ConditionalFormatRange {
            start_row: range.start_row,
            end_row: cut.start_row - 1,
            start_col: range.start_col,
            end_col: range.end_col,
        });
    }
    if range.end_row > cut.end_row {
        out.push(ConditionalFormatRange {
            start_row: cut.end_row + 1,
            end_row: range.end_row,
            start_col: range.start_col,
            end_col: range.end_col,
        });
    }
    let mid_start = range.start_row.max(cut.start_row);
    let mid_end = range.end_row.min(cut.end_row);
    if range.start_col < cut.start_col {
        out.push(ConditionalFormatRange {
            start_row: mid_start,
            end_row: mid_end,
            start_col: range.start_col,
            end_col: cut.start_col - 1,
        });
    }
    if range.end_col > cut.end_col {
        out.push(ConditionalFormatRange {
            start_row: mid_start,
            end_row: mid_end,
            start_col: cut.end_col + 1,
            end_col: range.end_col,
        });
    }
    out
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
        CellValue::List(items) => format!("[List({})]", items.len()),
        CellValue::Dict(entries) => format!("[Dict({})]", entries.len()),
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

    use chrono::{Datelike, Local};
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
// RELATIVE RULE FORMULAS (NEW-cf-relative-eval, NEW-cf-cellvalue-formula-operand)
// ============================================================================
//
// A rule's formula is the formula of ONE cell, its ANCHOR, and every other
// cell of the rule reads it moved by its own offset, as a copied cell formula
// would be. Measured [LIVE, Excel 16, 2026-11-05, cfeval/probe1.ps1 ..
// probe3.ps1, fresh instance, new unsaved workbook, DisplayFormat read back
// and the saved sheet XML inspected]:
//   * `=$C2>100` on A2:E10 (C = 30 x row): A2/A3/D3 not formatted, A4, E7 and
//     B10 formatted -- row 7 tests $C7 (P1). `=B$1>$A2` on B2:C3 reads C$1 in
//     column C and $A3 in row 3 (P3).
//   * THE ANCHOR IS THE TOP-LEFT OF THE RECTANGLE BOUNDING EVERY RANGE, not
//     the first range's: sqref `C1:C2 A5:A6` saved with `C1=1` means "two
//     columns right" (C1 reads E1, A5 reads C5) -- written for A1, a cell in
//     neither range (Q1, Q2); `C3:D3 E1:F1` saved with `C1=1` means the cell
//     itself, written for C1 (Q3); `B5:B6 B1:B2` with `A1>0` reads the left
//     neighbour, written for B1 (P2, the file reopened: R-P2).
//   * A reference moved past an edge of the sheet WRAPS round to the other
//     side, never `#REF!`: `=B1048576=1` on A1:A3 formats A2 (it reads B1),
//     `=ISERROR(B1048576)` formats nothing, and `=XFD7=1` on A7:B7 makes B7
//     read A7 (P4, P4b, P4d).
//   * A reference to another sheet moves the same (`=Other!A1>0` on B1:B3:
//     B2 reads Other!A2, P5); a whole column or row moves (`=SUM(C:C)>5` reads
//     D:D in column B, `=SUM(3:3)>0` reads 4:4 one row down, P8); ROW() and
//     COLUMN() are the evaluated cell's (`=MOD(ROW(),2)=0` formats rows 2, 4;
//     probe2 P9, in Swedish `=REST(RAD();2)=0`).
//   * A defined name resolves as in a cell (`=A1>Thr`, Thr = `$D$1`, P6). A
//     name whose own definition is RELATIVE (`=RC[-1]`) is relative to the
//     evaluated cell in Excel (P7, cells and rules alike); Calcula's names are
//     positionless everywhere, so here it is too (reported, not chased).
//   * A CELL VALUE rule's operand is a formula too, relative to the cell the
//     same way (`> =B1` on C1:C3: C2 compares with B2, P10b), compared the way
//     Excel's operators compare: `> $D$1` (5) formats 7 AND the text "x" (text
//     sorts above every number) but not a blank; `< 5` formats 3 and a BLANK
//     (it is 0) but not "x"; `= "abc"` formats "abc" and "ABC" but not 5;
//     `> "a"` formats "b" and "Z" but not 100; `= TRUE` formats TRUE but not
//     1; an error cell or an error operand formats nothing; `between =H1 and
//     =H1*5` reads H in the cell's own row (P10a-P10i).
//   * A custom VALIDATION formula is relative to its range's top-left the same
//     way (`=B1>A1` on B1:B3: B2 valid against A2, B3 invalid, P11).

/// The cell a rule's formula is written FOR: the top-left of the rectangle
/// bounding every range of the rule (see the section note). `None` for a rule
/// with no range.
pub(crate) fn rule_anchor(ranges: &[ConditionalFormatRange]) -> Option<(u32, u32)> {
    let row = ranges.iter().map(|r| r.start_row.min(r.end_row)).min()?;
    let col = ranges.iter().map(|r| r.start_col.min(r.end_col)).min()?;
    Some((row, col))
}

/// The rows a rule's ranges span, first to last (`(0, 0)` for none), for
/// [`split_rule_by_meaning`].
pub(crate) fn rule_row_span(ranges: &[ConditionalFormatRange]) -> (u32, u32) {
    let lo = ranges.iter().map(|r| r.start_row.min(r.end_row)).min().unwrap_or(0);
    let hi = ranges.iter().map(|r| r.start_row.max(r.end_row)).max().unwrap_or(0);
    (lo, hi)
}

/// The columns a rule's ranges span, first to last (`(0, 0)` for none), for
/// [`split_rule_by_meaning`].
pub(crate) fn rule_column_span(ranges: &[ConditionalFormatRange]) -> (u32, u32) {
    let lo = ranges.iter().map(|r| r.start_col.min(r.end_col)).min().unwrap_or(0);
    let hi = ranges.iter().map(|r| r.start_col.max(r.end_col)).max().unwrap_or(0);
    (lo, hi)
}

/// A rule whose ranges change from `old` to `new` KEEPS ITS MEANING: when the
/// anchor moves, every formula is re-stated for the new anchor, the way a copy
/// to it would move it. [LIVE, Excel 16, cfeval/probe1.ps1] clearing A1:A2 of
/// `=$B1>5` on A1:A5 (P13) and `ModifyAppliesToRange(A3:A5)` (P14) both leave
/// A3 testing B3, saved as `$B3>5`. Returns whether any formula changed.
pub(crate) fn restate_rule_for_ranges(
    rule: &mut ConditionalFormatRule,
    old: &[ConditionalFormatRange],
    new: &[ConditionalFormatRange],
) -> bool {
    let (Some(from), Some(to)) = (rule_anchor(old), rule_anchor(new)) else { return false };
    if from == to {
        return false;
    }
    let (drow, dcol) = (to.0 as i64 - from.0 as i64, to.1 as i64 - from.1 as i64);
    let mut changed = false;
    for formula in rule_formulas_mut(rule) {
        // Wrapping at the sheet's edge, never `#REF!` (BUG-0743).
        let next = move_rule_formula_wrapping(formula, drow, dcol);
        if next != *formula {
            *formula = next;
            changed = true;
        }
    }
    changed
}

const SHEET_ROWS: i64 = engine::EXCEL_MAX_ROW_INDEX as i64 + 1;
const SHEET_COLS: i64 = engine::EXCEL_MAX_COL_INDEX as i64 + 1;

/// A 0-based line index moved by `delta`, wrapped round the sheet's edge.
fn wrap_line(index: i64, delta: i64, size: i64) -> i64 {
    (index + delta).rem_euclid(size)
}

/// A column spelling moved by `dcol` unless it is absolute.
fn shift_col_letters(col: &str, absolute: bool, dcol: i64) -> String {
    if absolute || dcol == 0 || col.is_empty() || !col.chars().all(|c| c.is_ascii_alphabetic()) {
        return col.to_string();
    }
    let index = engine::col_to_index(col) as i64;
    engine::index_to_col(wrap_line(index, dcol, SHEET_COLS) as u32)
}

/// A 1-based row moved by `drow` unless it is absolute.
fn shift_row_number(row: u32, absolute: bool, drow: i64) -> u32 {
    if absolute || drow == 0 || row == 0 {
        return row;
    }
    (wrap_line(row as i64 - 1, drow, SHEET_ROWS) + 1) as u32
}

/// Put a range's two cell corners back in top-left / bottom-right order after
/// a wrap moved one past the other (`A1048576:A2` is the rectangle A2:A1048576).
fn order_range_corners(start: &mut engine::Expression, end: &mut engine::Expression) {
    use engine::Expression as E;
    if let (
        E::CellRef { col: c1, row: r1, col_absolute: ca1, row_absolute: ra1, .. },
        E::CellRef { col: c2, row: r2, col_absolute: ca2, row_absolute: ra2, .. },
    ) = (start, end)
    {
        if *r1 > *r2 {
            std::mem::swap(r1, r2);
            std::mem::swap(ra1, ra2);
        }
        if engine::col_to_index(c1) > engine::col_to_index(c2) {
            std::mem::swap(c1, c2);
            std::mem::swap(ca1, ca2);
        }
    }
}

/// `expr` as the cell `drow` rows below and `dcol` columns right of the cell
/// it is written for reads it: every RELATIVE row and column part moves, an
/// absolute (`$`) one stays, and a part moved past an edge wraps round the
/// sheet (Excel's rule for conditional formats and validations; see the
/// section note). Names, structured references and literals are untouched.
pub(crate) fn shift_relative_refs(expr: &engine::Expression, drow: i64, dcol: i64) -> engine::Expression {
    use engine::Expression as E;
    let shift = |e: &E| shift_relative_refs(e, drow, dcol);
    match expr {
        E::CellRef { sheet, col, row, col_absolute, row_absolute, ref_site_id } => E::CellRef {
            sheet: sheet.clone(),
            col: shift_col_letters(col, *col_absolute, dcol),
            row: shift_row_number(*row, *row_absolute, drow),
            col_absolute: *col_absolute,
            row_absolute: *row_absolute,
            ref_site_id: ref_site_id.clone(),
        },
        E::Range { sheet, start, end, ref_site_id } => {
            let mut start = shift(start);
            let mut end = shift(end);
            order_range_corners(&mut start, &mut end);
            E::Range { sheet: sheet.clone(), start: Box::new(start), end: Box::new(end), ref_site_id: ref_site_id.clone() }
        }
        E::ColumnRef { sheet, start_col, end_col, start_absolute, end_absolute, ref_site_id } => {
            let mut a = (shift_col_letters(start_col, *start_absolute, dcol), *start_absolute);
            let mut b = (shift_col_letters(end_col, *end_absolute, dcol), *end_absolute);
            if engine::col_to_index(&a.0) > engine::col_to_index(&b.0) {
                std::mem::swap(&mut a, &mut b);
            }
            E::ColumnRef {
                sheet: sheet.clone(),
                start_col: a.0,
                end_col: b.0,
                start_absolute: a.1,
                end_absolute: b.1,
                ref_site_id: ref_site_id.clone(),
            }
        }
        E::RowRef { sheet, start_row, end_row, start_absolute, end_absolute, ref_site_id } => {
            let mut a = (shift_row_number(*start_row, *start_absolute, drow), *start_absolute);
            let mut b = (shift_row_number(*end_row, *end_absolute, drow), *end_absolute);
            if a.0 > b.0 {
                std::mem::swap(&mut a, &mut b);
            }
            E::RowRef {
                sheet: sheet.clone(),
                start_row: a.0,
                end_row: b.0,
                start_absolute: a.1,
                end_absolute: b.1,
                ref_site_id: ref_site_id.clone(),
            }
        }
        E::BinaryOp { left, op, right } => E::BinaryOp { left: Box::new(shift(left)), op: *op, right: Box::new(shift(right)) },
        E::UnaryOp { op, operand } => E::UnaryOp { op: *op, operand: Box::new(shift(operand)) },
        E::FunctionCall { func, args, ref_site_id } => E::FunctionCall {
            func: func.clone(),
            args: args.iter().map(shift).collect(),
            ref_site_id: ref_site_id.clone(),
        },
        E::Sheet3DRef { start_sheet, end_sheet, reference, ref_site_id } => E::Sheet3DRef {
            start_sheet: start_sheet.clone(),
            end_sheet: end_sheet.clone(),
            reference: Box::new(shift(reference)),
            ref_site_id: ref_site_id.clone(),
        },
        E::IndexAccess { target, index } => E::IndexAccess { target: Box::new(shift(target)), index: Box::new(shift(index)) },
        E::ArrayLiteral { rows } => E::ArrayLiteral { rows: rows.iter().map(|r| r.iter().map(shift).collect()).collect() },
        E::ListLiteral { elements } => E::ListLiteral { elements: elements.iter().map(shift).collect() },
        E::DictLiteral { entries } => E::DictLiteral { entries: entries.iter().map(|(k, v)| (shift(k), shift(v))).collect() },
        E::SpillRef { cell, ref_site_id } => E::SpillRef { cell: Box::new(shift(cell)), ref_site_id: ref_site_id.clone() },
        E::ImplicitIntersection { operand } => E::ImplicitIntersection { operand: Box::new(shift(operand)) },
        E::Literal(_) | E::NamedRef { .. } | E::TableRef { .. } => expr.clone(),
    }
}

/// Everything a rule or validation formula reads, for ONE evaluation pass:
/// the workbook's grids, the sheet the rule lives on, the defined names (when
/// the caller has them), and each formula PARSED ONCE per pass -- never once
/// per cell, which is what a viewport of a million-row rule would otherwise
/// cost. Build one per pass and drop it; it borrows the caller's guards.
pub(crate) struct RuleFormulas<'a> {
    pub grids: &'a [Grid],
    pub sheet_names: &'a [String],
    pub sheet_index: usize,
    pub named_ranges: Option<&'a HashMap<String, crate::named_ranges::NamedRange>>,
    /// The workbook's names, tables and LIVE spill map (BUG-0748): when
    /// present a rule formula is expanded by the ONE resolver a cell's formula
    /// uses (`name_resolution::eval_ast`), so `=A1#`, a bare table name and a
    /// name whose definition is a table or a spill all resolve as in a cell.
    /// `None` keeps the names-only path above (tests, positionless callers).
    tables: Option<crate::name_resolution::NameTables<'a>>,
    /// The rule's own sheet as it WOULD be (BUG-0746): a pending entry
    /// judged before it is committed is read through this grid in place of
    /// `grids[sheet_index]`, by every reference that reaches it.
    current_override: Option<&'a Grid>,
    /// OTHER sheets as they would be (cfdvfix): the cells there that read a
    /// pending entry, re-evaluated before a custom rule is judged.
    other_overrides: Vec<(usize, &'a Grid)>,
    parsed: std::cell::RefCell<HashMap<String, Option<std::rc::Rc<engine::Expression>>>>,
}

/// The workbook's defined names and tables, taken and released one store at a
/// time (never held across a grid guard), plus the live spill map a rule's
/// `A1#` reads -- everything [`RuleFormulas::resolved`] needs (BUG-0748).
///
/// Every production CF / validation evaluation path builds its formulas from
/// one of these: the painter, the floating-grid painter, sort-by-icon,
/// filter-by-icon, the Sort dialog's icon list and the validation checks. A
/// path that evaluated with `named_ranges: None` answered `#NAME?` for a rule
/// the screen formatted, so a sort or filter by its icon matched no rows.
pub(crate) struct RuleNames<'s> {
    named_ranges: HashMap<String, crate::named_ranges::NamedRange>,
    tables: crate::tables::TableStorage,
    table_names: crate::tables::TableNameRegistry,
    spill_ranges: &'s crate::document_effect::Persisted<crate::SpillRangeMap>,
}

/// Snapshot the name and table stores for rule formulas ([`RuleNames`]).
/// Takes each read lock and releases it at once; the spill map is read per
/// evaluated cell, inside `eval_ast`, so the caller must NOT hold
/// `spill_ranges`. A FREE function with a name of its own, not an associated
/// `RuleNames::take`, so the lock-order censuses
/// (`state_digest_lock_order_tests.rs`) see every caller take the three name
/// stores: call it BEFORE any grid or undo guard (verify-cfdvb finding 4).
pub(crate) fn snapshot_rule_names(state: &AppState) -> RuleNames<'_> {
    RuleNames {
        named_ranges: state.named_ranges.read().map(|n| (*n).clone()).unwrap_or_default(),
        tables: state.tables.read().map(|t| (*t).clone()).unwrap_or_default(),
        table_names: state.table_names.read().map(|t| (*t).clone()).unwrap_or_default(),
        spill_ranges: &state.spill_ranges,
    }
}

impl<'s> RuleNames<'s> {

    /// For a test: these stores, with `spill_ranges` as the live spill map.
    #[cfg(test)]
    pub(crate) fn from_parts(
        named_ranges: HashMap<String, crate::named_ranges::NamedRange>,
        spill_ranges: &'s crate::document_effect::Persisted<crate::SpillRangeMap>,
    ) -> Self {
        RuleNames { named_ranges, tables: Default::default(), table_names: Default::default(), spill_ranges }
    }

    /// The tables pointed at this workbook's `sheet_names`.
    pub(crate) fn tables<'a>(&'a self, sheet_names: &'a [String]) -> crate::name_resolution::NameTables<'a>
    where
        's: 'a,
    {
        crate::name_resolution::NameTables {
            named_ranges: &self.named_ranges,
            tables: &self.tables,
            table_names: &self.table_names,
            sheet_names,
            spill_ranges: self.spill_ranges,
        }
    }
}

impl<'a> RuleFormulas<'a> {
    pub(crate) fn new(
        grids: &'a [Grid],
        sheet_names: &'a [String],
        sheet_index: usize,
        named_ranges: Option<&'a HashMap<String, crate::named_ranges::NamedRange>>,
    ) -> Self {
        RuleFormulas {
            grids,
            sheet_names,
            sheet_index,
            named_ranges,
            tables: None,
            current_override: None,
            other_overrides: Vec::new(),
            parsed: Default::default(),
        }
    }

    /// Formulas resolved through `tables` exactly as a cell's formula is:
    /// defined names (relative ones at the evaluated cell), structured and bare
    /// table references, and spill references (`A1#`) against the live map.
    pub(crate) fn resolved(
        grids: &'a [Grid],
        sheet_names: &'a [String],
        sheet_index: usize,
        tables: crate::name_resolution::NameTables<'a>,
    ) -> Self {
        RuleFormulas {
            grids,
            sheet_names,
            sheet_index,
            named_ranges: Some(tables.named_ranges),
            tables: Some(tables),
            current_override: None,
            other_overrides: Vec::new(),
            parsed: Default::default(),
        }
    }

    /// These formulas read `grid` as the rule's own sheet (see
    /// `current_override`): a validation judging a value not yet entered.
    pub(crate) fn reading_sheet_as(mut self, grid: &'a Grid) -> Self {
        self.current_override = Some(grid);
        self
    }

    /// These formulas read each (sheet, grid) pair as that sheet: other sheets
    /// as a pending entry would leave them (see `other_overrides`).
    pub(crate) fn reading_other_sheets_as(mut self, overrides: Vec<(usize, &'a Grid)>) -> Self {
        self.other_overrides = overrides;
        self
    }

    /// The grid sheet `i` is read as: its override when it has one.
    fn grid_for(&self, i: usize) -> Option<&'a Grid> {
        if i == self.sheet_index {
            if let Some(current) = self.current_override {
                return Some(current);
            }
        }
        self.other_overrides.iter().find(|(s, _)| *s == i).map(|(_, g)| *g).or_else(|| self.grids.get(i))
    }

    /// Evaluate a resolved AST on the rule's sheet, through the override
    /// when there is one (also for a reference QUALIFIED with this sheet).
    fn evaluate_resolved(&self, ast: &engine::Expression, ctx: engine::EvalContext) -> CellValue {
        if self.current_override.is_none() && self.other_overrides.is_empty() {
            return crate::evaluate_formula_with_context(self.grids, self.sheet_names, self.sheet_index, ast, ctx, None);
        }
        let grid_of = |i: usize| self.grid_for(i);
        if self.sheet_index >= self.grids.len() || self.sheet_index >= self.sheet_names.len() {
            return CellValue::Error(engine::CellError::Ref);
        }
        let Some(current) = grid_of(self.sheet_index) else {
            return CellValue::Error(engine::CellError::Ref);
        };
        let mut context = engine::MultiSheetContext::new(self.sheet_names[self.sheet_index].clone());
        for i in 0..self.grids.len() {
            if i < self.sheet_names.len() {
                if let Some(grid) = grid_of(i) {
                    context.add_grid(self.sheet_names[i].clone(), grid);
                }
            }
        }
        context.sheet_order = self.sheet_names.to_vec();
        let mut evaluator = engine::Evaluator::with_context(current, context, ctx);
        crate::eval_budget::apply(&mut evaluator);
        evaluator.evaluate(ast).to_cell_value()
    }

    /// How many distinct formulas this pass has parsed (tests pin "once per
    /// pass, not once per cell").
    #[cfg(test)]
    pub(crate) fn cached_parses(&self) -> usize {
        self.parsed.borrow().len()
    }

    /// `formula` parsed, from this pass's cache. `None` when it does not parse
    /// (such a rule matches nothing, as before).
    fn parsed(&self, formula: &str) -> Option<std::rc::Rc<engine::Expression>> {
        if let Some(hit) = self.parsed.borrow().get(formula) {
            return hit.clone();
        }
        let ast = parser::parse(formula).ok().map(|a| std::rc::Rc::new(crate::convert_expr(&a)));
        self.parsed.borrow_mut().insert(formula.to_string(), ast.clone());
        ast
    }

    /// `ast` with this workbook's defined names spliced in, as a cell's formula
    /// has them: a RELATIVE name is read from `at`, the cell being evaluated
    /// (Excel [LIVE, round E namese p1]: `=ROW(rel)=21` on F20:F22 colours F21
    /// only). A positionless threshold passes (0, 0), the name as written.
    fn with_names<'e>(&self, ast: std::borrow::Cow<'e, engine::Expression>, at: (u32, u32)) -> std::borrow::Cow<'e, engine::Expression> {
        use std::borrow::Cow;
        if let Some(tables) = &self.tables {
            let ctx = tables.at(self.sheet_index, at.0, at.1);
            return match ast {
                Cow::Borrowed(stored) => crate::name_resolution::eval_ast(stored, &ctx),
                Cow::Owned(stored) => {
                    let expanded = match crate::name_resolution::eval_ast(&stored, &ctx) {
                        Cow::Owned(e) => Some(e),
                        Cow::Borrowed(_) => None,
                    };
                    Cow::Owned(expanded.unwrap_or(stored))
                }
            };
        }
        match self.named_ranges {
            Some(names) if crate::name_resolution::needs_name_resolution(&ast, names) => {
                let mut visited = std::collections::HashSet::new();
                std::borrow::Cow::Owned(crate::resolve_names_in_ast_at(&ast, names, self.sheet_index, at, &mut visited))
            }
            _ => ast,
        }
    }

    /// The value of `ast`, written for `anchor`, at the cell (`row`, `col`):
    /// moved by the cell's offset from the anchor and evaluated AT the cell, so
    /// ROW(), COLUMN() and `@` are the cell's own.
    fn eval_ast_at(&self, ast: &engine::Expression, anchor: (u32, u32), row: u32, col: u32) -> CellValue {
        let drow = row as i64 - anchor.0 as i64;
        let dcol = col as i64 - anchor.1 as i64;
        let moved = if drow == 0 && dcol == 0 {
            std::borrow::Cow::Borrowed(ast)
        } else {
            std::borrow::Cow::Owned(shift_relative_refs(ast, drow, dcol))
        };
        let resolved = self.with_names(moved, (row, col));
        let ctx = engine::EvalContext { current_row: Some(row), current_col: Some(col), ..Default::default() };
        self.evaluate_resolved(&resolved, ctx)
    }

    /// The value of a CELL's own stored formula `ast` at (`row`, `col`), its
    /// names resolved there -- how a validation re-evaluates the cells that
    /// depend on an entry not yet committed (BUG-0746).
    pub(crate) fn value_of_cell_formula(&self, ast: &engine::Expression, row: u32, col: u32) -> CellValue {
        let resolved = self.with_names(std::borrow::Cow::Borrowed(ast), (row, col));
        let ctx = engine::EvalContext { current_row: Some(row), current_col: Some(col), ..Default::default() };
        self.evaluate_resolved(&resolved, ctx)
    }

    /// The value of `formula`, written for `anchor`, at the cell (`row`, `col`).
    /// `#VALUE!` when it does not parse.
    pub(crate) fn value_at(&self, formula: &str, anchor: (u32, u32), row: u32, col: u32) -> CellValue {
        match self.parsed(formula) {
            Some(ast) => self.eval_ast_at(&ast, anchor, row, col),
            None => CellValue::Error(engine::CellError::Value),
        }
    }

    /// The value of a POSITIONLESS formula (a colour scale's, data bar's or
    /// icon set's threshold: Excel refuses relative references there).
    fn value(&self, formula: &str) -> CellValue {
        let Some(ast) = self.parsed(formula) else {
            return CellValue::Error(engine::CellError::Value);
        };
        let resolved = self.with_names(std::borrow::Cow::Borrowed(&*ast), (0, 0));
        if self.current_override.is_some() || !self.other_overrides.is_empty() {
            return self.evaluate_resolved(&resolved, engine::EvalContext::default());
        }
        crate::evaluate_formula_multi_sheet_with_ast(self.grids, self.sheet_names, self.sheet_index, &resolved)
    }

    /// Whether the cell (`row`, `col`) passes a CELL VALUE rule written for
    /// `anchor`: the cell compared with each operand by Excel's own comparison
    /// operators (see the section note). An error on either side, or an operand
    /// that is missing or does not parse, matches nothing.
    fn cell_value_rule_matches(&self, rule: &CellValueRule, anchor: (u32, u32), row: u32, col: u32) -> bool {
        use engine::BinaryOperator as Op;
        let Some(v1) = self.operand(&rule.value1) else { return false };
        // The cell itself, absolute, so it never moves.
        let me = engine::Expression::CellRef {
            sheet: None,
            col: engine::index_to_col(col),
            row: row + 1,
            col_absolute: true,
            row_absolute: true,
            ref_site_id: Default::default(),
        };
        let compare = |op: Op, operand: &engine::Expression| -> Option<bool> {
            let test = engine::Expression::BinaryOp { left: Box::new(me.clone()), op, right: Box::new(operand.clone()) };
            match self.eval_ast_at(&test, anchor, row, col) {
                CellValue::Boolean(b) => Some(b),
                _ => None,
            }
        };
        let between = |v2: &engine::Expression| -> Option<bool> {
            // Order-free, as before: `between 10 and 2` is `between 2 and 10`.
            let ge1 = compare(Op::GreaterEqual, &v1)?;
            let le2 = compare(Op::LessEqual, v2)?;
            let ge2 = compare(Op::GreaterEqual, v2)?;
            let le1 = compare(Op::LessEqual, &v1)?;
            Some((ge1 && le2) || (ge2 && le1))
        };
        let answer = match rule.operator {
            CellValueOperator::Equal => compare(Op::Equal, &v1),
            CellValueOperator::NotEqual => compare(Op::NotEqual, &v1),
            CellValueOperator::GreaterThan => compare(Op::GreaterThan, &v1),
            CellValueOperator::GreaterThanOrEqual => compare(Op::GreaterEqual, &v1),
            CellValueOperator::LessThan => compare(Op::LessThan, &v1),
            CellValueOperator::LessThanOrEqual => compare(Op::LessEqual, &v1),
            CellValueOperator::Between | CellValueOperator::NotBetween => {
                let Some(v2) = rule.value2.as_deref().and_then(|t| self.operand(t)) else { return false };
                let inside = between(&v2);
                if rule.operator == CellValueOperator::NotBetween {
                    inside.map(|b| !b)
                } else {
                    inside
                }
            }
        };
        answer.unwrap_or(false)
    }

    /// A cell-value rule's operand as an expression: `=...` is a formula, a
    /// number is that number, TRUE / FALSE that boolean, anything else the TEXT
    /// itself (Excel's dialog turns a typed `abc` into `="abc"`). `None` for an
    /// empty operand or a formula that does not parse.
    fn operand(&self, text: &str) -> Option<engine::Expression> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return None;
        }
        if trimmed.starts_with('=') {
            return self.parsed(trimmed).map(|ast| (*ast).clone());
        }
        if let Ok(n) = trimmed.parse::<f64>() {
            if n.is_finite() {
                return Some(engine::Expression::Literal(engine::Value::Number(n)));
            }
        }
        if trimmed.eq_ignore_ascii_case("TRUE") {
            return Some(engine::Expression::Literal(engine::Value::Boolean(true)));
        }
        if trimmed.eq_ignore_ascii_case("FALSE") {
            return Some(engine::Expression::Literal(engine::Value::Boolean(false)));
        }
        Some(engine::Expression::Literal(engine::Value::String(text.to_string())))
    }
}

// ============================================================================
// RULE EVALUATION
// ============================================================================

/// Evaluate a single rule for a cell. `anchor` is the cell the rule's
/// formulas are written for ([`rule_anchor`] of its ranges).
#[allow(clippy::too_many_arguments)]
fn evaluate_rule(
    grid: &Grid,
    formulas: &RuleFormulas,
    anchor: (u32, u32),
    rule: &ConditionalFormatRule,
    format: &ConditionalFormat,
    row: u32,
    col: u32,
    stats: Option<&RangeStats>,
) -> Option<CellConditionalFormat> {
    // TRANSIENT. A rule decides whether a cell is highlighted; nothing here is
    // ever written into a cell, so the tighter ceiling is safe — a trip costs a
    // highlight, never a value — and it is WANTED, because these run once per
    // visible cell on every repaint, where a multi-second formula reads as a
    // frozen scroll rather than as a slow calculation.
    let _governor = crate::eval_budget::install(crate::eval_budget::EvalSurface::Transient);
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
            if formulas.cell_value_rule_matches(value_rule, anchor, row, col) {
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
            // Relative to the cell (NEW-cf-relative-eval): the formula is the
            // anchor's, and this cell reads it moved by its own offset.
            let result = formulas.value_at(&expr_rule.formula, anchor, row, col);
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

            let ctx = formulas;
            let min_val = resolve_cf_point_value(&cs_rule.min_point, stats, ctx);
            let max_val = resolve_cf_point_value(&cs_rule.max_point, stats, ctx);

            if (max_val - min_val).abs() < f64::EPSILON {
                // All values are the same; use min color
                let mut cf = make_cf(row, col, format);
                cf.color_scale_color = Some(cs_rule.min_point.color.clone());
                return Some(cf);
            }

            let fraction = ((num - min_val) / (max_val - min_val)).clamp(0.0, 1.0);

            let color = if let Some(ref mid_point) = cs_rule.mid_point {
                // 3-color scale
                let mid_val = resolve_cf_point_value(mid_point, stats, &ctx);
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

            let ctx = formulas;

            // AUTOMATIC is not LOWEST VALUE (measured [LIVE], see
            // `data_bar_geometry`): Excel's automatic shortest bar is zero when
            // every value is positive, so 5 beside 10 is HALF a bar, where
            // Lowest Value makes it no bar at all. The same for the longest bar
            // and all-negative values.
            let min_val = match db_rule.min_value_type {
                CFValueType::AutoMin => stats.min.min(0.0),
                CFValueType::Min => stats.min,
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
                CFValueType::Formula => {
                    if let Some(ref formula) = db_rule.min_formula {
                        evaluate_cf_formula(formula, &ctx, db_rule.min_value.unwrap_or(stats.min))
                    } else {
                        db_rule.min_value.unwrap_or(stats.min)
                    }
                }
                _ => stats.min,
            };

            let max_val = match db_rule.max_value_type {
                CFValueType::AutoMax => stats.max.max(0.0),
                CFValueType::Max => stats.max,
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
                CFValueType::Formula => {
                    if let Some(ref formula) = db_rule.max_formula {
                        evaluate_cf_formula(formula, &ctx, db_rule.max_value.unwrap_or(stats.max))
                    } else {
                        db_rule.max_value.unwrap_or(stats.max)
                    }
                }
                _ => stats.max,
            };

            let geometry = data_bar_geometry(db_rule.axis_position, num, min_val, max_val);

            let mut cf = make_cf(row, col, format);
            cf.data_bar_percent = Some(geometry.length);
            cf.data_bar_axis = geometry.axis;
            cf.data_bar_negative = geometry.negative.then_some(true);
            cf.hide_value = (!db_rule.show_value).then_some(true);
            Some(cf)
        }

        // ---- IconSet ----
        ConditionalFormatRule::IconSet(is_rule) => {
            let stats = stats?;
            let num = get_numeric_value(cell_value?)?;
            if stats.sorted_values.is_empty() {
                return None;
            }

            let ctx = formulas;
            let icon_count = get_icon_count(&is_rule.icon_set);
            let thresholds = &is_rule.thresholds;

            // Determine which icon index this value falls into.
            // Thresholds define boundaries between icons. thresholds[0] is between
            // icon 0 (bottom) and icon 1, etc.
            // We iterate from highest threshold to lowest.
            let mut icon_index = 0u32; // Default to lowest icon

            for (i, threshold) in thresholds.iter().enumerate().rev() {
                let threshold_val = resolve_threshold_value(threshold, stats, &ctx);
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
            // The set travels WITH the index, from the rule that produced it.
            cf.icon_set = Some(is_rule.icon_set);
            // Show Icon Only hides the value (the painters read `hide_value`).
            cf.hide_value = is_rule.show_icon_only.then_some(true);
            Some(cf)
        }
    }
}

/// Where one data bar goes inside its cell, as fractions of the bar area.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct DataBarGeometry {
    /// The bar's length, from the axis when there is one, else from the start edge.
    pub length: f64,
    /// The axis, from the start edge; `None` when no axis is drawn.
    pub axis: Option<f64>,
    /// The value is negative: the bar runs from the axis toward the start edge.
    pub negative: bool,
}

/// Excel's data-bar geometry for `num` on a rule whose shortest and longest
/// bars resolved to `min_val` / `max_val`.
///
/// MEASURED [LIVE] 2026-11-04 (Excel 16, fresh hidden instance, new unsaved
/// workbook, solid bars, the sheet exported to PDF and the bar rectangles read
/// back; 51pt columns):
///   - Automatic axis, -5 / 10 / 5 / 0: a dashed axis one third in (|min| /
///     (|min| + max)); -5 a red bar from the axis LEFTWARDS (15.5pt), 10 a bar
///     from the axis to the right end (31.8pt), 5 half of that, 0 none.
///   - Automatic, 5 / 10 / 2.5 (no negatives): no axis, bars from the left edge
///     at 24.1 / 48.2 / 12.1pt -- proportional to the value, so the automatic
///     minimum is ZERO, not the lowest value.
///   - Automatic, -5 / -10 / -2.5 (all negative): bars from the RIGHT edge
///     leftwards at 24.1 / 48.2 / 12.1pt, no axis line drawn.
///   - Cell midpoint, -5 / 10 / 5: the axis at the middle; 10 fills the right
///     half, 5 a quarter of the cell, -5 a quarter leftwards (scale =
///     max(|min|, |max|)).
///   - Axis None, -5 / 10 / 5: no axis, bars from the left edge, -5 none and 5
///     two thirds: the plain (num - min) / (max - min).
///   - Lowest / Highest Value, 5 / 10 / 7.5: 5 no bar, 7.5 half.
///   - Right-to-left mirrors all of it (axis two thirds from the left, -5 to the
///     right of it); the PAINTER mirrors, so it is not an input here.
pub(crate) fn data_bar_geometry(
    axis_position: DataBarAxisPosition,
    num: f64,
    min_val: f64,
    max_val: f64,
) -> DataBarGeometry {
    let span = max_val - min_val;
    let plain = |num: f64| -> f64 {
        if span.abs() > f64::EPSILON {
            ((num - min_val) / span).clamp(0.0, 1.0)
        } else {
            0.5
        }
    };
    match axis_position {
        DataBarAxisPosition::None => DataBarGeometry {
            length: plain(num),
            axis: None,
            negative: num < 0.0,
        },
        DataBarAxisPosition::CellMidpoint => {
            let scale = min_val.abs().max(max_val.abs());
            let length = if scale > f64::EPSILON {
                (0.5 * num.abs() / scale).clamp(0.0, 0.5)
            } else {
                0.0
            };
            DataBarGeometry { length, axis: Some(0.5), negative: num < 0.0 }
        }
        DataBarAxisPosition::Automatic => {
            if min_val >= 0.0 || span.abs() <= f64::EPSILON {
                // No negative values in the scale: an axis-less bar from the
                // start edge, exactly the pre-axis geometry.
                return DataBarGeometry { length: plain(num), axis: None, negative: false };
            }
            if max_val <= 0.0 {
                // Every value negative: the axis is the far edge and every bar
                // runs back from it, |num - max| of |min - max| long.
                let length = ((max_val - num) / span).clamp(0.0, 1.0);
                return DataBarGeometry { length, axis: Some(1.0), negative: true };
            }
            // Both signs: the axis splits the cell in proportion, and each bar
            // is its distance from zero on the same scale.
            let axis = -min_val / span;
            if num < 0.0 {
                let length = (num.abs() / span).clamp(0.0, axis);
                DataBarGeometry { length, axis: Some(axis), negative: true }
            } else {
                let length = (num / span).clamp(0.0, 1.0 - axis);
                DataBarGeometry { length, axis: Some(axis), negative: false }
            }
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
        data_bar_axis: None,
        data_bar_negative: None,
        hide_value: None,
        icon_index: None,
        icon_set: None,
        rule_id: None,
        color_scale_color: None,
    }
}

/// Context needed for formula evaluation within CF threshold resolution: the
/// pass's [`RuleFormulas`] (each threshold formula parsed once per pass).
type CFFormulaContext<'a> = RuleFormulas<'a>;

/// Evaluate a formula string and return its numeric result, or a fallback value
fn evaluate_cf_formula(
    formula: &str,
    ctx: &CFFormulaContext,
    fallback: f64,
) -> f64 {
    // Transient for the same reason as `evaluate_rule` — this resolves a rule's
    // threshold expression and feeds a colour decision, not a cell.
    let _governor = crate::eval_budget::install(crate::eval_budget::EvalSurface::Transient);
    let result = ctx.value(formula);
    match result {
        CellValue::Number(n) => n,
        CellValue::Boolean(b) => if b { 1.0 } else { 0.0 },
        _ => fallback,
    }
}

/// Resolve a ColorScalePoint's effective numeric value given range stats
fn resolve_cf_point_value(
    point: &ColorScalePoint,
    stats: &RangeStats,
    ctx: &CFFormulaContext,
) -> f64 {
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
            if let Some(formula) = point.formula.as_deref() {
                evaluate_cf_formula(formula, ctx, point.value.unwrap_or(stats.min))
            } else {
                // No formula string provided; fall back to literal value
                point.value.unwrap_or(stats.min)
            }
        }
    }
}

/// Resolve an icon set threshold value given range stats
fn resolve_threshold_value(
    threshold: &IconSetThreshold,
    stats: &RangeStats,
    ctx: &CFFormulaContext,
) -> f64 {
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
        CFValueType::Formula => {
            if let Some(formula) = threshold.formula.as_deref() {
                evaluate_cf_formula(formula, ctx, threshold.value)
            } else {
                threshold.value
            }
        }
        _ => threshold.value,
    }
}

/// Get the number of icons in an icon set type
pub(crate) fn get_icon_count(icon_set: &IconSetType) -> u32 {
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

    // ------------------------------------------------------------------
    // Data bars: negatives, the axis, automatic ends, Show Bar Only
    // (BUG-0511; Excel's geometry measured [LIVE], see data_bar_geometry)
    // ------------------------------------------------------------------

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn data_bar_automatic_axis_splits_the_cell_by_the_negative_share() {
        // -5 / 10: the axis one third in; -5 runs left from it, 10 to the end.
        let neg = data_bar_geometry(DataBarAxisPosition::Automatic, -5.0, -5.0, 10.0);
        assert!(close(neg.axis.unwrap(), 1.0 / 3.0));
        assert!(neg.negative);
        assert!(close(neg.length, 1.0 / 3.0), "-5 fills the whole negative share");
        let full = data_bar_geometry(DataBarAxisPosition::Automatic, 10.0, -5.0, 10.0);
        assert!(!full.negative);
        assert!(close(full.length, 2.0 / 3.0), "10 fills the whole positive share");
        let half = data_bar_geometry(DataBarAxisPosition::Automatic, 5.0, -5.0, 10.0);
        assert!(close(half.length, 1.0 / 3.0), "5 is half of 10's bar");
        let zero = data_bar_geometry(DataBarAxisPosition::Automatic, 0.0, -5.0, 10.0);
        assert!(close(zero.length, 0.0));
    }

    #[test]
    fn data_bar_all_negative_runs_back_from_the_far_edge() {
        let g = data_bar_geometry(DataBarAxisPosition::Automatic, -5.0, -10.0, 0.0);
        assert_eq!(g.axis, Some(1.0));
        assert!(g.negative);
        assert!(close(g.length, 0.5));
    }

    #[test]
    fn data_bar_without_negatives_has_no_axis_and_the_plain_fraction() {
        let g = data_bar_geometry(DataBarAxisPosition::Automatic, 5.0, 0.0, 10.0);
        assert_eq!(g, DataBarGeometry { length: 0.5, axis: None, negative: false });
    }

    #[test]
    fn data_bar_cell_midpoint_scales_by_the_larger_magnitude() {
        let pos = data_bar_geometry(DataBarAxisPosition::CellMidpoint, 5.0, -5.0, 10.0);
        assert_eq!(pos.axis, Some(0.5));
        assert!(close(pos.length, 0.25));
        let neg = data_bar_geometry(DataBarAxisPosition::CellMidpoint, -5.0, -5.0, 10.0);
        assert!(neg.negative);
        assert!(close(neg.length, 0.25));
    }

    #[test]
    fn data_bar_axis_none_is_the_plain_fraction_from_the_left() {
        let g = data_bar_geometry(DataBarAxisPosition::None, 5.0, -5.0, 10.0);
        assert_eq!(g.axis, None);
        assert!(close(g.length, 2.0 / 3.0));
    }

    fn data_bar_results(values: &[f64], rule: DataBarRule) -> Vec<CellConditionalFormat> {
        let mut grid = Grid::new();
        for (i, v) in values.iter().enumerate() {
            grid.set_cell(i as u32, 0, engine::Cell::new_number(*v));
        }
        let ranges = vec![range(0, 0, values.len() as u32 - 1, 0)];
        let stats = collect_range_stats(&grid, &ranges);
        let rule = ConditionalFormatRule::DataBar(rule);
        (0..values.len() as u32)
            .map(|row| {
                evaluate_rule(&grid, &RuleFormulas::new(std::slice::from_ref(&grid), &["Sheet1".to_string()], 0, None), (0, 0), &rule, &ConditionalFormat::default(), row, 0, Some(&stats))
                    .expect("a numeric cell gets a bar")
            })
            .collect()
    }

    /// Excel's AUTOMATIC shortest bar is zero for positive data ([LIVE]: 5 / 10
    /// / 2.5 gave 24.1 / 48.2 / 12.1pt bars). It was the lowest value, so 2.5
    /// had no bar and 5 a third of one.
    #[test]
    fn automatic_data_bar_ends_include_zero() {
        let rule = DataBarRule { min_value_type: CFValueType::AutoMin, max_value_type: CFValueType::AutoMax, ..DataBarRule::default() };
        let out = data_bar_results(&[5.0, 10.0, 2.5], rule);
        let lengths: Vec<f64> = out.iter().map(|cf| cf.data_bar_percent.unwrap()).collect();
        assert!(close(lengths[0], 0.5), "5 is half of 10: {:?}", lengths);
        assert!(close(lengths[1], 1.0));
        assert!(close(lengths[2], 0.25));
        // Lowest Value keeps the old meaning: 5 is the shortest bar.
        let lowest = DataBarRule { min_value_type: CFValueType::Min, max_value_type: CFValueType::Max, ..DataBarRule::default() };
        let out = data_bar_results(&[5.0, 10.0, 7.5], lowest);
        assert!(close(out[0].data_bar_percent.unwrap(), 0.0));
        assert!(close(out[2].data_bar_percent.unwrap(), 0.5));
    }

    #[test]
    fn a_negative_value_reports_its_axis_and_sign_and_show_bar_only_hides_the_value() {
        let rule = DataBarRule {
            min_value_type: CFValueType::AutoMin,
            max_value_type: CFValueType::AutoMax,
            show_value: false,
            ..DataBarRule::default()
        };
        let out = data_bar_results(&[-5.0, 10.0], rule);
        assert_eq!(out[0].data_bar_negative, Some(true));
        assert!(close(out[0].data_bar_axis.unwrap(), 1.0 / 3.0));
        assert_eq!(out[1].data_bar_negative, None, "a positive value carries no sign flag");
        assert_eq!(out[0].hide_value, Some(true));
        // Shown values carry no flag at all (the wire stays small).
        let shown = data_bar_results(&[1.0, 2.0], DataBarRule::default());
        assert_eq!(shown[0].hide_value, None);
    }

    /// Show Icon Only hides the value; it had no reader anywhere in the app.
    #[test]
    fn show_icon_only_hides_the_value() {
        let mut grid = Grid::new();
        grid.set_cell(0, 0, engine::Cell::new_number(1.0));
        grid.set_cell(1, 0, engine::Cell::new_number(9.0));
        let ranges = vec![range(0, 0, 1, 0)];
        let stats = collect_range_stats(&grid, &ranges);
        let eval = |show_icon_only: bool| {
            let rule = ConditionalFormatRule::IconSet(IconSetRule {
                icon_set: IconSetType::ThreeArrows,
                thresholds: vec![],
                reverse_icons: false,
                show_icon_only,
            });
            evaluate_rule(&grid, &RuleFormulas::new(std::slice::from_ref(&grid), &["Sheet1".to_string()], 0, None), (0, 0), &rule, &ConditionalFormat::default(), 1, 0, Some(&stats))
                .expect("an icon")
        };
        assert_eq!(eval(true).hide_value, Some(true));
        assert_eq!(eval(false).hide_value, None);
    }

    #[test]
    fn test_icon_set_type_default() {
        assert_eq!(IconSetType::default(), IconSetType::ThreeTrafficLights1);
    }

    // ------------------------------------------------------------------
    // Clear Rules from Selected Cells (Excel cuts the selection out)
    // ------------------------------------------------------------------

    fn range(sr: u32, sc: u32, er: u32, ec: u32) -> ConditionalFormatRange {
        ConditionalFormatRange { start_row: sr, start_col: sc, end_row: er, end_col: ec }
    }

    fn cells(ranges: &[ConditionalFormatRange]) -> std::collections::HashSet<(u32, u32)> {
        let mut out = std::collections::HashSet::new();
        for r in ranges {
            for row in r.start_row..=r.end_row {
                for col in r.start_col..=r.end_col {
                    out.insert((row, col));
                }
            }
        }
        out
    }

    #[test]
    fn subtracting_a_cut_leaves_exactly_the_cells_outside_it() {
        // A hole in the middle: eight cells, four pieces.
        let left = subtract_range(&range(0, 0, 2, 2), &range(1, 1, 1, 1));
        assert_eq!(left.len(), 4);
        let mut expected = cells(&[range(0, 0, 2, 2)]);
        expected.remove(&(1, 1));
        assert_eq!(cells(&left), expected);
        // The cut covers the range: nothing left.
        assert!(subtract_range(&range(2, 2, 3, 3), &range(0, 0, 9, 9)).is_empty());
        // A disjoint cut leaves the range as it was.
        assert_eq!(cells(&subtract_range(&range(0, 0, 9, 0), &range(0, 2, 9, 2))), cells(&[range(0, 0, 9, 0)]));
    }

    struct Book {
        state: AppState,
        file: FileState,
    }

    fn book_with_rule(ranges: Vec<ConditionalFormatRange>) -> Book {
        let book = Book { state: crate::create_app_state(), file: FileState::default() };
        let added = add_conditional_format_impl(
            &book.state,
            &book.file,
            AddCFParams {
                target: None,
                rule: ConditionalFormatRule::CellValue(CellValueRule {
                    operator: CellValueOperator::GreaterThan,
                    value1: "5".to_string(),
                    value2: None,
                }),
                format: ConditionalFormat { background_color: Some("#FFC7CE".to_string()), ..Default::default() },
                ranges,
                stop_if_true: false,
            },
        );
        assert!(added.success, "{:?}", added.error);
        crate::document_effect::mark_saved(&book.file);
        book
    }

    fn rule_ranges(book: &Book) -> Vec<ConditionalFormatRange> {
        book.state.conditional_formats.read().unwrap().get(&0).map(|rules| rules.iter().flat_map(|r| r.ranges.clone()).collect()).unwrap_or_default()
    }

    /// Survey note C, reproduced: rule A1:A10, A1:A5 selected. It used to
    /// remove nothing (the rule's range is not wholly inside the selection) and
    /// say nothing; Excel leaves the rule on A6:A10.
    #[test]
    fn clear_rules_from_selected_cells_cuts_the_selection_out_of_every_rule() {
        let book = book_with_rule(vec![range(0, 0, 9, 0)]);
        let changed = clear_conditional_formats_in_range_impl(&book.state, &book.file, 0, 0, 4, 0, None).unwrap();
        assert_eq!(changed, 1);
        assert_eq!(cells(&rule_ranges(&book)), cells(&[range(5, 0, 9, 0)]), "A6:A10 keeps the rule");
        assert!(book.file.is_dirty());

        // ONE undo step restores the rule's whole range.
        let transaction = book.state.undo_stack.lock().unwrap().pop_undo().expect("the clear recorded an undo step");
        crate::undo_commands::apply_changes(
            &book.state,
            &book.file,
            &crate::persistence::UserFilesState::default(),
            &crate::pivot::types::PivotState::new(),
            &crate::slicer::SlicerState::new(),
            &crate::ribbon_filter::RibbonFilterState::new(),
            &crate::pane_control::PaneControlState::new(),
            &crate::timeline_slicer::TimelineSlicerState::new(),
            transaction,
            true,
        );
        assert_eq!(cells(&rule_ranges(&book)), cells(&[range(0, 0, 9, 0)]));
    }

    #[test]
    fn a_rule_whose_every_cell_is_selected_is_removed() {
        let book = book_with_rule(vec![range(2, 2, 3, 3), range(8, 8, 8, 8)]);
        assert_eq!(clear_conditional_formats_in_range_impl(&book.state, &book.file, 0, 0, 9, 9, None).unwrap(), 1);
        assert!(book.state.conditional_formats.read().unwrap().get(&0).unwrap().is_empty());
    }

    /// The `DocumentEffect` is built only inside the branch that changes
    /// something: a clear that touches no rule leaves the document clean and
    /// records nothing.
    #[test]
    fn a_clear_that_touches_no_rule_leaves_the_document_clean() {
        let book = book_with_rule(vec![range(0, 0, 9, 0)]);
        let depth = book.state.undo_stack.lock().unwrap().undo_depth();
        assert_eq!(clear_conditional_formats_in_range_impl(&book.state, &book.file, 0, 2, 4, 2, None).unwrap(), 0);
        assert!(!book.file.is_dirty(), "nothing changed, so the document must stay clean");
        assert_eq!(book.state.undo_stack.lock().unwrap().undo_depth(), depth);
        assert_eq!(cells(&rule_ranges(&book)), cells(&[range(0, 0, 9, 0)]));
    }
}


#[cfg(test)]
#[path = "cfdv_structural_tests.rs"]
mod cfdv_structural_tests;

#[cfg(test)]
#[path = "cfeval_tests.rs"]
mod cfeval_tests;

#[cfg(test)]
#[path = "cfdvb_tests.rs"]
mod cfdvb_tests;
