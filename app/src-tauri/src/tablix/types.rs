//! FILENAME: app/src-tauri/src/tablix/types.rs
//! Type definitions for Tablix API.
//! All TypeScript-facing types use camelCase via serde rename_all.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use pivot_engine::PivotCache;
use tablix_engine::TablixDefinition;

pub type TablixId = u32;

// ============================================================================
// DATA FIELD MODE
// ============================================================================

/// How a data field displays: aggregated or detail.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DataFieldModeType {
    Aggregated,
    Detail,
}

// ============================================================================
// GROUP LAYOUT
// ============================================================================

/// How row groups are arranged on the grid.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum GroupLayoutType {
    /// Groups in same column with indentation.
    Stepped,
    /// Each group level in its own column.
    #[default]
    Block,
}

// ============================================================================
// REQUEST TYPES
// ============================================================================

/// Request to create a new tablix.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTablixRequest {
    pub source_range: String,
    pub destination_cell: String,
    pub source_sheet: Option<usize>,
    pub destination_sheet: Option<usize>,
    pub has_headers: Option<bool>,
    pub name: Option<String>,
}

/// Data field configuration for tablix updates.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TablixDataFieldConfig {
    pub source_index: usize,
    pub name: String,
    /// "aggregated" or "detail"
    pub mode: String,
    /// Aggregation type (only when mode = "aggregated")
    pub aggregation: Option<String>,
    pub number_format: Option<String>,
}

/// Field configuration for tablix row/column groups.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TablixFieldConfig {
    pub source_index: usize,
    pub name: String,
    pub sort_order: Option<String>,
    pub show_subtotals: Option<bool>,
    pub collapsed: Option<bool>,
    pub hidden_items: Option<Vec<String>>,
}

/// Tablix layout configuration.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TablixLayoutConfig {
    pub show_row_grand_totals: Option<bool>,
    pub show_column_grand_totals: Option<bool>,
    pub group_layout: Option<String>,
    pub repeat_group_labels: Option<bool>,
    pub show_empty_groups: Option<bool>,
}

/// Request to update tablix fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTablixFieldsRequest {
    pub tablix_id: TablixId,
    pub row_groups: Option<Vec<TablixFieldConfig>>,
    pub column_groups: Option<Vec<TablixFieldConfig>>,
    pub data_fields: Option<Vec<TablixDataFieldConfig>>,
    pub filter_fields: Option<Vec<TablixFieldConfig>>,
    pub layout: Option<TablixLayoutConfig>,
}

/// Request to toggle a tablix group.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToggleTablixGroupRequest {
    pub tablix_id: TablixId,
    pub is_row: bool,
    pub field_index: usize,
    pub value: Option<String>,
}

/// Request to convert between pivot and tablix.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertRequest {
    pub id: u32,
}

// ============================================================================
// RESPONSE TYPES
// ============================================================================

/// Response containing the tablix view data.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TablixViewResponse {
    pub tablix_id: TablixId,
    pub version: u64,
    pub row_count: usize,
    pub col_count: usize,
    pub row_group_col_count: usize,
    pub column_header_row_count: usize,
    pub filter_row_count: usize,
    pub filter_rows: Vec<TablixFilterRowData>,
    pub rows: Vec<TablixRowData>,
    pub columns: Vec<TablixColumnData>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TablixFilterRowData {
    pub field_index: usize,
    pub field_name: String,
    pub selected_values: Vec<String>,
    pub unique_values: Vec<String>,
    pub display_value: String,
    pub view_row: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TablixRowData {
    pub view_row: usize,
    pub row_type: String,
    pub depth: u8,
    pub visible: bool,
    pub source_row: Option<u32>,
    pub cells: Vec<TablixCellData>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TablixCellData {
    pub cell_type: String,
    pub value: TablixCellValueData,
    pub formatted_value: String,
    pub indent_level: u8,
    pub is_bold: bool,
    pub is_expandable: bool,
    pub is_collapsed: bool,
    pub is_spanned: bool,
    pub row_span: u16,
    pub col_span: u16,
    pub background_style: String,
    pub number_format: Option<String>,
    pub filter_field_index: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum TablixCellValueData {
    Empty,
    Number(f64),
    Text(String),
    Boolean(bool),
    Error(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TablixColumnData {
    pub view_col: usize,
    pub col_type: String,
    pub depth: u8,
    pub width_hint: u16,
}

/// Source field info (same as pivot).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TablixSourceFieldInfo {
    pub index: usize,
    pub name: String,
    pub is_numeric: bool,
}

/// Zone field info for the editor.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TablixZoneFieldInfo {
    pub source_index: usize,
    pub name: String,
    pub is_numeric: bool,
    pub mode: Option<String>,
    pub aggregation: Option<String>,
}

/// Current field configuration for the tablix editor.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TablixFieldConfiguration {
    pub row_groups: Vec<TablixZoneFieldInfo>,
    pub column_groups: Vec<TablixZoneFieldInfo>,
    pub data_fields: Vec<TablixZoneFieldInfo>,
    pub filter_fields: Vec<TablixZoneFieldInfo>,
    pub layout: TablixLayoutConfig,
}

/// Tablix region check response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TablixRegionInfo {
    pub tablix_id: TablixId,
    pub is_empty: bool,
    pub source_fields: Vec<TablixSourceFieldInfo>,
    pub field_configuration: TablixFieldConfiguration,
    pub filter_zones: Vec<TablixFilterZoneInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TablixFilterZoneInfo {
    pub row: u32,
    pub col: u32,
    pub field_index: usize,
    pub field_name: String,
}

/// Tablix region data for overlay registration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TablixRegionData {
    pub tablix_id: TablixId,
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
    pub is_empty: bool,
}

/// Response from conversion commands.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionResponse {
    pub new_id: u32,
    pub migrated_detail_fields: Vec<String>,
}

/// Field unique values response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TablixFieldUniqueValuesResponse {
    pub field_index: usize,
    pub field_name: String,
    pub unique_values: Vec<String>,
}

// ============================================================================
// STATE
// ============================================================================

/// Managed state for the tablix extension.
pub struct TablixState {
    /// Tablix storage: id -> (definition, cache)
    pub tablix_tables: Mutex<HashMap<TablixId, (TablixDefinition, PivotCache)>>,
    /// Next available tablix ID
    pub next_tablix_id: Mutex<TablixId>,
    /// Currently active tablix ID
    pub active_tablix_id: Mutex<Option<TablixId>>,
}

impl TablixState {
    pub fn new() -> Self {
        TablixState {
            tablix_tables: Mutex::new(HashMap::new()),
            next_tablix_id: Mutex::new(1),
            active_tablix_id: Mutex::new(None),
        }
    }
}
