//! FILENAME: app/src-tauri/src/mcp/server.rs
//! MCP server definition with tool routing.
//! Implements the MCP protocol so external AI clients can interact with Calcula.
//!
//! All HTTP requests pass through `guard_request` BEFORE reaching the rmcp
//! service: per-session bearer token auth plus Origin/Host hardening.
//! rmcp's `Mcp-Session-Id` is a protocol session marker, not authentication.

use std::sync::Arc;
use axum::{
    extract::Request,
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    Router,
};
use rmcp::{
    ServerHandler, tool, tool_router, tool_handler,
    handler::server::tool::ToolRouter,
    handler::server::wrapper::Parameters,
    model::*,
    ErrorData,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use rmcp::transport::streamable_http_server::{
    StreamableHttpService,
    session::local::LocalSessionManager,
};

use crate::{log_info, log_warn};
use super::tools;
// The edit half of the object tools, and the script-drafting tools. Aliased so
// every tool body reads `tools*::<fn>` and it is obvious at the call site which
// module owns the implementation.
use super::drafts as tools_drafts;
use super::objects as tools_objects;

// ============================================================================
// Parameter Structs
// ============================================================================

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct GetCellRangeParams {
    #[schemars(description = "Start row (0-based)")]
    pub start_row: u32,
    #[schemars(description = "Start column (0-based, A=0, B=1, ...)")]
    pub start_col: u32,
    #[schemars(description = "End row (0-based, inclusive)")]
    pub end_row: u32,
    #[schemars(description = "End column (0-based, inclusive)")]
    pub end_col: u32,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct SetCellValueParams {
    #[schemars(description = "Row index (0-based)")]
    pub row: u32,
    #[schemars(description = "Column index (0-based, A=0, B=1, ...)")]
    pub col: u32,
    #[schemars(description = "Value to set. Use '=' prefix for formulas (e.g., '=SUM(A1:A10)')")]
    pub value: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct SetCellRangeParams {
    #[schemars(description = "Array of cells to set")]
    pub cells: Vec<CellInput>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct CellInput {
    #[schemars(description = "Row (0-based)")]
    pub row: u32,
    #[schemars(description = "Column (0-based)")]
    pub col: u32,
    #[schemars(description = "Value or formula")]
    pub value: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct GetSheetSummaryParams {
    #[schemars(description = "Maximum characters in the summary (0 = no limit)")]
    #[serde(default = "default_max_chars")]
    pub max_chars: u32,
}

fn default_max_chars() -> u32 {
    8000
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct ApplyFormattingParams {
    #[schemars(description = "Start row (0-based)")]
    pub start_row: u32,
    #[schemars(description = "Start column (0-based)")]
    pub start_col: u32,
    #[schemars(description = "End row (0-based, inclusive)")]
    pub end_row: u32,
    #[schemars(description = "End column (0-based, inclusive)")]
    pub end_col: u32,
    #[schemars(description = "Set bold")]
    #[serde(default)]
    pub bold: Option<bool>,
    #[schemars(description = "Set italic")]
    #[serde(default)]
    pub italic: Option<bool>,
    #[schemars(description = "Text color as hex (e.g., '#FF0000')")]
    #[serde(default)]
    pub text_color: Option<String>,
    #[schemars(description = "Background color as hex")]
    #[serde(default)]
    pub background_color: Option<String>,
    #[schemars(description = "Number format string (e.g., '#,##0.00')")]
    #[serde(default)]
    pub number_format: Option<String>,
    #[schemars(description = "Horizontal text alignment: left, center, right")]
    #[serde(default)]
    pub text_align: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct RunScriptParams {
    #[schemars(description = "JavaScript code to execute in the spreadsheet's script engine")]
    pub code: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct GetChartParams {
    #[schemars(description = "The chart id (UUID) from list_charts")]
    pub chart_id: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct CreateChartParams {
    #[schemars(description = "The ChartSpec as a JSON object. Required: mark (e.g. \"bar\", \"line\", \"pie\"), data (a range string like \"Sheet1!A1:D13\" or a DataRangeRef {sheetIndex,startRow,startCol,endRow,endCol}), series (array; each {name, sourceIndex, color}). Common: hasHeaders, seriesOrientation (\"columns\"|\"rows\"), categoryIndex, title, xAxis/yAxis {title,gridLines,showLabels,labelAngle,min,max}, legend {visible,position}, palette. Call get_chart on an existing chart to see a full example, and get_sheet_summary for the data layout.")]
    pub spec: serde_json::Value,
    #[schemars(description = "Sheet index to place the chart on (0-based). Defaults to the active sheet.")]
    #[serde(default)]
    pub sheet_index: Option<u32>,
    #[schemars(description = "Display name for the chart. Defaults to 'AI Chart'.")]
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct CreateNamedRangeParams {
    #[schemars(description = "The name. Must start with a letter or underscore; letters, digits, underscore, and period only; cannot be a cell reference like A1.")]
    pub name: String,
    #[schemars(description = "What the name refers to, e.g. \"=Sheet1!$A$1:$B$10\" or a constant like \"=0.25\".")]
    pub refers_to: String,
    #[schemars(description = "Sheet index (0-based) for a sheet-scoped name; omit for a workbook-scoped name.")]
    #[serde(default)]
    pub sheet_index: Option<usize>,
    #[schemars(description = "Optional comment/description.")]
    #[serde(default)]
    pub comment: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct McpCreateTableParams {
    #[schemars(description = "Top row of the table range (0-based, inclusive). If has_headers, this row is the header.")]
    pub start_row: u32,
    #[schemars(description = "Left column of the table range (0-based, inclusive).")]
    pub start_col: u32,
    #[schemars(description = "Bottom row of the table range (0-based, inclusive).")]
    pub end_row: u32,
    #[schemars(description = "Right column of the table range (0-based, inclusive).")]
    pub end_col: u32,
    #[schemars(description = "Whether the first row is a header row (true: column names come from it; false: generic Column1..N).")]
    #[serde(default)]
    pub has_headers: bool,
    #[schemars(description = "Optional table name (auto-generated like Table1 if omitted). Must be unique in the workbook.")]
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct PivotValueFieldParam {
    #[schemars(description = "Source column name (from the header row) to aggregate.")]
    pub field: String,
    #[schemars(description = "Aggregation: sum, count, average, min, or max.")]
    pub aggregation: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct CreatePivotParams {
    #[schemars(description = "Source data range in A1, e.g. \"A1:D100\".")]
    pub source_range: String,
    #[schemars(description = "Top-left destination cell in A1, e.g. \"F1\".")]
    pub destination_cell: String,
    #[schemars(description = "Value fields to aggregate (>=1). Each {field: source column name, aggregation: sum|count|average|min|max}.")]
    pub value_fields: Vec<PivotValueFieldParam>,
    #[schemars(description = "Row field column names to group rows by (optional).")]
    #[serde(default)]
    pub row_fields: Vec<String>,
    #[schemars(description = "Source sheet index (0-based). Defaults to the active sheet.")]
    #[serde(default)]
    pub source_sheet: Option<usize>,
    #[schemars(description = "Destination sheet index (0-based). Defaults to the active sheet.")]
    #[serde(default)]
    pub destination_sheet: Option<usize>,
    #[schemars(description = "Whether the source's first row is a header row (default true).")]
    #[serde(default)]
    pub has_headers: Option<bool>,
    #[schemars(description = "Optional pivot table name.")]
    #[serde(default)]
    pub name: Option<String>,
}

// ---- Object UPDATE / DELETE (D5) ----

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct UpdateChartParams {
    #[schemars(description = "The chart id (UUID) from list_charts")]
    pub chart_id: String,
    #[schemars(description = "Replacement ChartSpec JSON object (same shape as create_chart_from_spec). Omit to keep the current spec. Call get_chart first to see what is there.")]
    #[serde(default)]
    pub spec: Option<serde_json::Value>,
    #[schemars(description = "New display name. Omit to keep the current one.")]
    #[serde(default)]
    pub name: Option<String>,
    #[schemars(description = "Move the chart to this sheet index (0-based). Omit to leave it where it is.")]
    #[serde(default)]
    pub sheet_index: Option<u32>,
    #[schemars(description = "New x position in pixels.")]
    #[serde(default)]
    pub x: Option<f64>,
    #[schemars(description = "New y position in pixels.")]
    #[serde(default)]
    pub y: Option<f64>,
    #[schemars(description = "New width in pixels.")]
    #[serde(default)]
    pub width: Option<f64>,
    #[schemars(description = "New height in pixels.")]
    #[serde(default)]
    pub height: Option<f64>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct DeleteChartParams {
    #[schemars(description = "The chart id (UUID) from list_charts")]
    pub chart_id: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct UpdateNamedRangeParams {
    #[schemars(description = "The existing name (case-insensitive), from list_named_ranges")]
    pub name: String,
    #[schemars(description = "Rename the name to this. Omit to keep the current name.")]
    #[serde(default)]
    pub new_name: Option<String>,
    #[schemars(description = "New target, e.g. \"=Sheet1!$A$1:$B$10\" or a constant like \"=0.25\". Omit to keep the current target.")]
    #[serde(default)]
    pub refers_to: Option<String>,
    #[schemars(description = "New comment. Omit to keep the current comment; pass an empty string to clear it.")]
    #[serde(default)]
    pub comment: Option<String>,
    #[schemars(description = "New scope: a sheet index (0-based) for a sheet-scoped name. Omit to keep the current scope.")]
    #[serde(default)]
    pub sheet_index: Option<usize>,
    #[schemars(description = "Set true together with omitting sheet_index to make a sheet-scoped name workbook-scoped.")]
    #[serde(default)]
    pub scope_to_workbook: bool,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct DeleteNamedRangeParams {
    #[schemars(description = "The name to delete (case-insensitive), from list_named_ranges")]
    pub name: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct UpdateTableParams {
    #[schemars(description = "The table id (UUID). Tables are listed by name in list_tables; use get_sheet_summary or list_tables to identify the table, then pass its id.")]
    pub table_id: String,
    #[schemars(description = "New table name. Must be unique and must not collide with a defined name.")]
    #[serde(default)]
    pub new_name: Option<String>,
    #[schemars(description = "New top row of the table range (0-based, inclusive). Provide all four range fields together to resize.")]
    #[serde(default)]
    pub start_row: Option<u32>,
    #[schemars(description = "New left column of the table range (0-based, inclusive).")]
    #[serde(default)]
    pub start_col: Option<u32>,
    #[schemars(description = "New bottom row of the table range (0-based, inclusive).")]
    #[serde(default)]
    pub end_row: Option<u32>,
    #[schemars(description = "New right column of the table range (0-based, inclusive).")]
    #[serde(default)]
    pub end_col: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct DeleteTableParams {
    #[schemars(description = "The table id (UUID) to delete")]
    pub table_id: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct PivotFieldMoveParam {
    #[schemars(description = "Source field (column) name, as shown in list_pivots / the pivot's source header row")]
    pub field: String,
    #[schemars(description = "Target area: row, column, value, filter, or none (removes the field from every area)")]
    pub area: String,
    #[schemars(description = "0-based position within the target area. Omit to append.")]
    #[serde(default)]
    pub position: Option<usize>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct PivotAggregationParam {
    #[schemars(description = "Value-field name as shown in the pivot's values area")]
    pub field: String,
    #[schemars(description = "New aggregation: sum, count, average, min, max, product, countNumbers, stdDev, stdDevP, var, varP, or auto")]
    pub aggregation: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct UpdatePivotParams {
    #[schemars(description = "The pivot id (UUID) from list_pivots")]
    pub pivot_id: String,
    #[schemars(description = "New pivot table name.")]
    #[serde(default)]
    pub name: Option<String>,
    #[schemars(description = "Move the pivot's top-left corner to this A1 cell, e.g. \"H2\".")]
    #[serde(default)]
    pub destination_cell: Option<String>,
    #[schemars(description = "Field placements to apply, each {field, area, position}. Areas: row, column, value, filter, none.")]
    #[serde(default)]
    pub field_moves: Vec<PivotFieldMoveParam>,
    #[schemars(description = "Aggregation changes to apply, each {field, aggregation}.")]
    #[serde(default)]
    pub aggregations: Vec<PivotAggregationParam>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct DeletePivotParams {
    #[schemars(description = "The pivot id (UUID) from list_pivots")]
    pub pivot_id: String,
}

// ---- Sheet management (D5) ----

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct AddSheetParams {
    #[schemars(description = "Name for the new sheet. Omit for an auto-generated Sheet<N>.")]
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct RenameSheetParams {
    #[schemars(description = "Sheet index (0-based) from list_sheets")]
    pub index: usize,
    #[schemars(description = "New sheet name. Must be unique in the workbook.")]
    pub new_name: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct DeleteSheetParams {
    #[schemars(description = "Sheet index (0-based) from list_sheets")]
    pub index: usize,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct MoveSheetParams {
    #[schemars(description = "Current sheet index (0-based)")]
    pub from_index: usize,
    #[schemars(description = "Target sheet index (0-based)")]
    pub to_index: usize,
}

// ---- Script drafting (D5) ----

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct DraftObjectScriptParams {
    #[schemars(description = "Display name for the script, e.g. \"Refresh Sales\"")]
    pub name: String,
    #[schemars(description = "Object type the script attaches to: workbook, sheet, cell, row, column, slicer, chart, pivot, button, textbox, timeline, shape, table, namedRange, panel, or range")]
    pub object_type: String,
    #[schemars(description = "For component objects (chart, pivot, table, button, ...): the target instance id. Omit for primitive objects like workbook or sheet.")]
    #[serde(default)]
    pub instance_id: Option<String>,
    #[schemars(description = "Short description of what the script does, shown to the user during review.")]
    #[serde(default)]
    pub description: Option<String>,
    #[schemars(description = "The JavaScript source. Declare any privileged capability the script needs with a `// @capability <id>` line comment (bi.query, bi.sql, net.fetch, storage, ui.html, ui.dialog, formula.udf, bi.model, bi.connector, distribution.writeback) — the reviewer is shown the declared set before they mount it.")]
    pub source: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct GetScriptDraftParams {
    #[schemars(description = "The draft id from draft_object_script / list_script_drafts")]
    pub draft_id: String,
}

// ---- BI / cube (read-only) ----

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct DescribeBiModelParams {
    #[schemars(description = "The BI connection id (UUID) from list_bi_connections")]
    pub connection_id: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct BiGroupByParam {
    #[schemars(description = "Table name")]
    pub table: String,
    #[schemars(description = "Column name")]
    pub column: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct BiFilterParam {
    #[schemars(description = "Table name")]
    pub table: String,
    #[schemars(description = "Column name")]
    pub column: String,
    #[schemars(description = "Comparison operator: = != > < >= <=")]
    pub operator: String,
    #[schemars(description = "Value to compare against")]
    pub value: String,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct RunBiQueryParams {
    #[schemars(description = "The BI connection id (UUID) from list_bi_connections")]
    pub connection_id: String,
    #[schemars(description = "Measure names to aggregate (from describe_bi_model)")]
    pub measures: Vec<String>,
    #[schemars(description = "Dimensions to group by, each a {table, column}")]
    #[serde(default)]
    pub group_by: Vec<BiGroupByParam>,
    #[schemars(description = "Optional row filters, each a {table, column, operator, value}")]
    #[serde(default)]
    pub filters: Vec<BiFilterParam>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct CubeValueParams {
    #[schemars(description = "BI connection name or id (from list_bi_connections)")]
    pub connection: String,
    #[schemars(description = "CUBE member-expressions, e.g. [\"[Sales Amount]\", \"Product[Category]=Bikes\"]. The first measure expression is the value; the rest filter it.")]
    pub members: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct CubeKpiParams {
    #[schemars(description = "BI connection name or id (from list_bi_connections)")]
    pub connection: String,
    #[schemars(description = "KPI name")]
    pub kpi: String,
    #[schemars(description = "Which KPI part: 1 = value, 2 = goal, 3 = status")]
    pub property: i64,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct CubeMembersParams {
    #[schemars(description = "BI connection name or id (from list_bi_connections)")]
    pub connection: String,
    #[schemars(description = "A level expression Table[Column], e.g. Product[Category]")]
    pub level: String,
}

// ============================================================================
// Helpers
// ============================================================================

/// Truncate a string to `max` chars and collapse newlines, for log summaries.
fn log_summary(s: &str, max: usize) -> String {
    let mut out: String = s.chars().take(max).collect();
    if s.chars().count() > max {
        out.push_str("...");
    }
    out.replace(['\n', '\r'], " ")
}

// ============================================================================
// MCP Server
// ============================================================================

#[derive(Clone)]
pub struct CalculaMcpServer {
    app_handle: Arc<AppHandle>,
    tool_router: ToolRouter<Self>,
}

#[tool_router]
impl CalculaMcpServer {
    pub fn new(app_handle: Arc<AppHandle>) -> Self {
        Self {
            app_handle,
            tool_router: Self::tool_router(),
        }
    }

    #[tool(description = "Read cell values and formulas from a rectangular range. Returns a table of values with formulas listed separately.")]
    async fn get_cell_range(
        &self,
        params: Parameters<GetCellRangeParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        log_info!(
            "MCP",
            "Tool call: get_cell_range r{}c{}..r{}c{}",
            p.start_row, p.start_col, p.end_row, p.end_col
        );
        let result = tools::read_cell_range(
            &self.app_handle,
            p.start_row,
            p.start_col,
            p.end_row,
            p.end_col,
        );
        match result {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: get_cell_range: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    #[tool(description = "Set the value or formula for a single cell. Use '=' prefix for formulas (e.g., '=SUM(A1:A10)').")]
    async fn set_cell_value(
        &self,
        params: Parameters<SetCellValueParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        log_info!(
            "MCP",
            "Tool call: set_cell_value r{}c{} = '{}'",
            p.row, p.col, log_summary(&p.value, 120)
        );
        let result = tools::write_cell(
            &self.app_handle,
            p.row,
            p.col,
            &p.value,
        );
        match result {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: set_cell_value: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    #[tool(description = "Set values for multiple cells at once. More efficient than calling set_cell_value repeatedly.")]
    async fn set_cell_range(
        &self,
        params: Parameters<SetCellRangeParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        log_info!("MCP", "Tool call: set_cell_range ({} cells)", p.cells.len());
        let result = tools::write_cell_range(&self.app_handle, &p.cells);
        match result {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: set_cell_range: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    #[tool(description = "Get an AI-optimized summary of the workbook including sheet dimensions, column types, formula patterns, and sample data.")]
    async fn get_sheet_summary(
        &self,
        params: Parameters<GetSheetSummaryParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        log_info!("MCP", "Tool call: get_sheet_summary (max_chars={})", p.max_chars);
        let result = tools::get_sheet_summary(&self.app_handle, p.max_chars);
        match result {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: get_sheet_summary: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    #[tool(description = "Apply formatting to a range of cells. Supports bold, italic, text color, background color, number format, and text alignment.")]
    async fn apply_formatting(
        &self,
        params: Parameters<ApplyFormattingParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        log_info!(
            "MCP",
            "Tool call: apply_formatting r{}c{}..r{}c{} (bold={:?} italic={:?} textColor={:?} bg={:?} numFmt={:?} align={:?})",
            p.start_row, p.start_col, p.end_row, p.end_col,
            p.bold, p.italic, p.text_color, p.background_color, p.number_format, p.text_align
        );
        let result = tools::apply_cell_formatting(&self.app_handle, &p);
        match result {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: apply_formatting: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    #[tool(description = "Execute a JavaScript script in the spreadsheet's script engine. Grid API: Calcula.getCellValue(row, col), Calcula.setCellValue(row, col, value), Calcula.getRange(startRow, startCol, endRow, endCol), Calcula.setRange(startRow, startCol, valuesJson). Read-only BI model API (same data as run_bi_query, no SQL): model.connections(), model.info(connection), model.query(connection, {measures, groupBy, filters}), model.value(connection, members), model.members(connection, level), model.kpi(connection, kpi, property). Structured output: display.table(rows) returns real columns/rows in structuredContent instead of tab-separated text. Writes are undoable. Requires the AI access level to allow 'script'.")]
    async fn run_script(
        &self,
        params: Parameters<RunScriptParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        log_info!(
            "MCP",
            "Tool call: run_script ({} chars): {}",
            p.code.len(),
            log_summary(&p.code, 160)
        );
        // Structured, not flattened: a display.table() keeps its columns/rows.
        match tools::execute_script_structured(&self.app_handle, &p.code).await {
            Ok(value) => Ok(CallToolResult::structured(value)),
            Err(e) => {
                log_warn!("MCP", "Tool error: run_script: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    #[tool(description = "List every chart in the workbook (id, name, sheet, mark, data range). Use this to discover charts before reading or editing one with get_chart.")]
    async fn list_charts(&self) -> Result<CallToolResult, ErrorData> {
        log_info!("MCP", "Tool call: list_charts");
        match tools::list_charts(&self.app_handle) {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: list_charts: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    #[tool(description = "List every named range in the workbook (name, scope, refersTo formula, comment). Use this to discover workbook-defined names like TaxRate or SalesData before reading or writing the cells they point to.")]
    async fn list_named_ranges(&self) -> Result<CallToolResult, ErrorData> {
        log_info!("MCP", "Tool call: list_named_ranges");
        match tools::list_named_ranges(&self.app_handle) {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: list_named_ranges: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    #[tool(description = "List every structured table in the workbook (name, sheet, A1 range, column/row counts, header/totals flags). Use this to discover tables before reading or writing their cells.")]
    async fn list_tables(&self) -> Result<CallToolResult, ErrorData> {
        log_info!("MCP", "Tool call: list_tables");
        match tools::list_tables(&self.app_handle) {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: list_tables: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    #[tool(description = "List every pivot table in the workbook (id, name, source range, destination cell, linked source table). Use this to discover pivots before reasoning about aggregated data.")]
    async fn list_pivots(&self) -> Result<CallToolResult, ErrorData> {
        log_info!("MCP", "Tool call: list_pivots");
        match tools::list_pivots(&self.app_handle) {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: list_pivots: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    #[tool(description = "Get a single chart's full definition (chartId, name, placement, and ChartSpec) as JSON. Pass a chart id from list_charts. Use this to read or diff-edit a chart's spec.")]
    async fn get_chart(
        &self,
        params: Parameters<GetChartParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        log_info!("MCP", "Tool call: get_chart {}", log_summary(&p.chart_id, 80));
        match tools::get_chart(&self.app_handle, &p.chart_id) {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: get_chart: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    #[tool(description = "Create a NEW chart from a ChartSpec JSON object you author. The spec is validated and the chart is persisted (and appears in the app). Requires the Script Security setting to allow execution. Tip: call list_charts/get_chart for spec examples and get_sheet_summary for the data layout before authoring.")]
    async fn create_chart_from_spec(
        &self,
        params: Parameters<CreateChartParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        log_info!(
            "MCP",
            "Tool call: create_chart_from_spec (sheet={:?} name={:?})",
            p.sheet_index, p.name
        );
        match tools::create_chart_from_spec(&self.app_handle, &p.spec, p.sheet_index, p.name.as_deref()) {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: create_chart_from_spec: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    #[tool(description = "Create a NEW named range (a workbook-defined name). Provide name + refers_to (e.g. \"=Sheet1!$A$1:$B$10\" or a constant like \"=0.25\"); optionally sheet_index for a sheet-scoped name and a comment. Undoable, and appears live in the Name Manager. Requires the Script Security setting to allow execution.")]
    async fn create_named_range(
        &self,
        params: Parameters<CreateNamedRangeParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        log_info!("MCP", "Tool call: create_named_range {}", log_summary(&p.name, 80));
        match tools::create_named_range(&self.app_handle, &p.name, &p.refers_to, p.sheet_index, p.comment) {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: create_named_range: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    #[tool(description = "Create a NEW structured table over a cell range. Provide start/end row+col (0-based, inclusive) and has_headers (true => first row is the header). Optional name (auto-generated if omitted). Created on the ACTIVE sheet. Undoable, appears live. Requires the Script Security setting to allow execution.")]
    async fn create_table(
        &self,
        params: Parameters<McpCreateTableParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        log_info!("MCP", "Tool call: create_table {:?}", p.name);
        match tools::create_table(
            &self.app_handle,
            p.start_row,
            p.start_col,
            p.end_row,
            p.end_col,
            p.has_headers,
            p.name.as_deref(),
        ) {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: create_table: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    #[tool(description = "Create a NEW pivot table configured with row + value fields in one step. source_range (A1, e.g. \"A1:D100\"), destination_cell (A1, e.g. \"F1\"), value_fields (>=1; each {field: source column name, aggregation: sum|count|average|min|max}), optional row_fields (column names), source_sheet/destination_sheet (0-based), has_headers (default true), name. Field names come from the source header row — call get_sheet_summary first to see the data. Undoable, appears live. Requires the Script Security setting to allow execution.")]
    async fn create_pivot(
        &self,
        params: Parameters<CreatePivotParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        log_info!(
            "MCP",
            "Tool call: create_pivot source={} dest={}",
            log_summary(&p.source_range, 40),
            log_summary(&p.destination_cell, 20)
        );
        let value_fields: Vec<(String, String)> =
            p.value_fields.into_iter().map(|v| (v.field, v.aggregation)).collect();
        match tools::create_pivot(
            &self.app_handle,
            &p.source_range,
            &p.destination_cell,
            p.row_fields,
            value_fields,
            p.source_sheet,
            p.destination_sheet,
            p.has_headers.unwrap_or(true),
            p.name.as_deref(),
        ) {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: create_pivot: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    // ---- Object UPDATE / DELETE (D5) ----
    //
    // These are the edit half of the create_* tools above. They are all
    // "mutate" tier: an agent can maintain the objects it created without the
    // user having to raise the AI access level to "script" (arbitrary JS) for
    // what is really a rename or a resize.

    #[tool(description = "Edit an EXISTING chart: replace its ChartSpec, rename it, move it to another sheet, and/or change its pixel placement. Pass a chart id from list_charts, plus at least one field to change; omitted fields are left alone. Call get_chart first to see the current spec. Undoable, appears live.")]
    async fn update_chart(
        &self,
        params: Parameters<UpdateChartParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        log_info!("MCP", "Tool call: update_chart {}", log_summary(&p.chart_id, 80));
        let placement = tools_objects::ChartPlacement {
            x: p.x,
            y: p.y,
            width: p.width,
            height: p.height,
        };
        match tools_objects::update_chart(
            &self.app_handle,
            &p.chart_id,
            p.spec.as_ref(),
            p.name.as_deref(),
            p.sheet_index,
            &placement,
        ) {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: update_chart: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    #[tool(description = "Delete a chart by id (from list_charts). Undoable; any object script attached to the chart is removed with it.")]
    async fn delete_chart(
        &self,
        params: Parameters<DeleteChartParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        log_info!("MCP", "Tool call: delete_chart {}", log_summary(&p.chart_id, 80));
        match tools_objects::delete_chart(&self.app_handle, &p.chart_id) {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: delete_chart: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    #[tool(description = "Edit an EXISTING named range: change what it refers to, its comment, its scope, and/or rename it. Pass the current name plus at least one field to change; omitted fields are left alone. Renaming produces two undo steps (the old name is removed and the new one defined). Appears live in the Name Manager.")]
    async fn update_named_range(
        &self,
        params: Parameters<UpdateNamedRangeParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        log_info!("MCP", "Tool call: update_named_range {}", log_summary(&p.name, 80));
        // Scope is tri-state over the wire: absent = keep, a value = sheet
        // scope, scope_to_workbook = clear it.
        let scope: Option<Option<usize>> = match (p.sheet_index, p.scope_to_workbook) {
            (Some(i), _) => Some(Some(i)),
            (None, true) => Some(None),
            (None, false) => None,
        };
        match tools_objects::update_named_range(
            &self.app_handle,
            &p.name,
            p.new_name.as_deref(),
            p.refers_to.as_deref(),
            p.comment.map(Some),
            scope,
        ) {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: update_named_range: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    #[tool(description = "Delete a named range by name (from list_named_ranges). Undoable; any object script attached to the name is removed with it.")]
    async fn delete_named_range(
        &self,
        params: Parameters<DeleteNamedRangeParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        log_info!("MCP", "Tool call: delete_named_range {}", log_summary(&p.name, 80));
        match tools_objects::delete_named_range(&self.app_handle, &p.name) {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: delete_named_range: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    #[tool(description = "Edit an EXISTING structured table: rename it and/or resize its range. Pass the table id plus new_name and/or all four range fields (start_row, start_col, end_row, end_col; 0-based, inclusive). Each change is its own undo step. Renaming rewrites dependent structured references.")]
    async fn update_table(
        &self,
        params: Parameters<UpdateTableParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        log_info!("MCP", "Tool call: update_table {}", log_summary(&p.table_id, 80));
        let range = match (p.start_row, p.start_col, p.end_row, p.end_col) {
            (Some(sr), Some(sc), Some(er), Some(ec)) => Some((sr, sc, er, ec)),
            (None, None, None, None) => None,
            _ => {
                return Ok(CallToolResult::error(vec![Content::text(
                    "To resize a table, provide ALL of start_row, start_col, end_row and end_col.",
                )]))
            }
        };
        match tools_objects::update_table(&self.app_handle, &p.table_id, p.new_name.as_deref(), range) {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: update_table: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    #[tool(description = "Delete a structured table by id. The cell values stay; the table object, its autofilter and any attached object script are removed. Undoable.")]
    async fn delete_table(
        &self,
        params: Parameters<DeleteTableParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        log_info!("MCP", "Tool call: delete_table {}", log_summary(&p.table_id, 80));
        match tools_objects::delete_table(&self.app_handle, &p.table_id) {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: delete_table: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    #[tool(description = "Reconfigure an EXISTING pivot table in one undo step: rename it, move it to another destination cell, move fields between the row/column/value/filter areas, and/or change a value field's aggregation. Pass a pivot id from list_pivots (which also lists the current rows/cols/values) plus at least one change. Field names come from the pivot's source columns.")]
    async fn update_pivot(
        &self,
        params: Parameters<UpdatePivotParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        log_info!("MCP", "Tool call: update_pivot {}", log_summary(&p.pivot_id, 80));

        let mut field_moves = Vec::with_capacity(p.field_moves.len());
        for m in &p.field_moves {
            match tools_objects::parse_pivot_area(&m.area) {
                Ok(area) => field_moves.push(tools_objects::PivotFieldMove {
                    field: m.field.clone(),
                    area,
                    position: m.position,
                }),
                Err(e) => return Ok(CallToolResult::error(vec![Content::text(e)])),
            }
        }
        let mut aggregations = Vec::with_capacity(p.aggregations.len());
        for a in &p.aggregations {
            match tools_objects::parse_aggregation_function(&a.aggregation) {
                Ok(aggregation) => aggregations.push(tools_objects::PivotAggregationChange {
                    field: a.field.clone(),
                    aggregation,
                }),
                Err(e) => return Ok(CallToolResult::error(vec![Content::text(e)])),
            }
        }

        match tools_objects::update_pivot(
            &self.app_handle,
            &p.pivot_id,
            p.name.as_deref(),
            p.destination_cell.as_deref(),
            field_moves,
            aggregations,
        ) {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: update_pivot: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    #[tool(description = "Delete a pivot table by id (from list_pivots). Its output region is cleared from the grid. Undoable.")]
    async fn delete_pivot(
        &self,
        params: Parameters<DeletePivotParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        log_info!("MCP", "Tool call: delete_pivot {}", log_summary(&p.pivot_id, 80));
        match tools_objects::delete_pivot(&self.app_handle, &p.pivot_id) {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: delete_pivot: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    // ---- Sheet management (D5) ----

    #[tool(description = "List the workbook's sheets with their 0-based indices, names, visibility and which one is active. The indices are what add_sheet/rename_sheet/delete_sheet/move_sheet and the sheet_index arguments elsewhere take. Read-only.")]
    async fn list_sheets(&self) -> Result<CallToolResult, ErrorData> {
        log_info!("MCP", "Tool call: list_sheets");
        match tools_objects::list_sheets(&self.app_handle) {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: list_sheets: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    #[tool(description = "Add a new empty sheet at the end of the workbook. NOTE: sheet structure changes are NOT undoable in Calcula (same as the in-app behavior) — confirm with the user before adding sheets in bulk.")]
    async fn add_sheet(
        &self,
        params: Parameters<AddSheetParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        log_info!("MCP", "Tool call: add_sheet {:?}", p.name);
        match tools_objects::add_sheet(&self.app_handle, p.name.as_deref()) {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: add_sheet: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    #[tool(description = "Rename a sheet by 0-based index (from list_sheets). Cross-sheet and 3D formula references to the old name are repaired automatically. NOT undoable.")]
    async fn rename_sheet(
        &self,
        params: Parameters<RenameSheetParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        log_info!("MCP", "Tool call: rename_sheet {} -> {}", p.index, log_summary(&p.new_name, 60));
        match tools_objects::rename_sheet(&self.app_handle, p.index, &p.new_name) {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: rename_sheet: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    #[tool(description = "Delete a sheet by 0-based index (from list_sheets). DESTRUCTIVE and NOT undoable — the sheet's data is gone. Confirm with the user first.")]
    async fn delete_sheet(
        &self,
        params: Parameters<DeleteSheetParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        log_info!("MCP", "Tool call: delete_sheet {}", p.index);
        match tools_objects::delete_sheet(&self.app_handle, p.index) {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: delete_sheet: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    #[tool(description = "Reorder sheets: move the sheet at from_index to to_index (both 0-based, from list_sheets). NOT undoable.")]
    async fn move_sheet(
        &self,
        params: Parameters<MoveSheetParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        log_info!("MCP", "Tool call: move_sheet {} -> {}", p.from_index, p.to_index);
        match tools_objects::move_sheet(&self.app_handle, p.from_index, p.to_index) {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: move_sheet: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    // ---- Script drafting (D5) ----

    #[tool(description = "DRAFT an object script (a macro attached to a button, chart, sheet, workbook, ...) and hand it to the user for review. This does NOT save the script into the workbook, does NOT mount it, and does NOT run it — the user reads it in the Object Script Editor and decides whether to mount it. Use this to author automation for the user to approve; use run_script only for something that must execute now. Declare privileged capabilities with `// @capability <id>` comments so the reviewer sees what the code would be allowed to do.")]
    async fn draft_object_script(
        &self,
        params: Parameters<DraftObjectScriptParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        log_info!(
            "MCP",
            "Tool call: draft_object_script name={} type={} ({} chars)",
            log_summary(&p.name, 60),
            log_summary(&p.object_type, 20),
            p.source.len()
        );
        match tools_drafts::draft_object_script(
            &self.app_handle,
            &p.name,
            &p.object_type,
            p.instance_id.as_deref(),
            p.description.as_deref(),
            &p.source,
        ) {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: draft_object_script: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    #[tool(description = "List the object scripts drafted in this session and awaiting the user's review (id, name, target object, line count, declared capabilities). None of them are mounted or running. Read-only.")]
    async fn list_script_drafts(&self) -> Result<CallToolResult, ErrorData> {
        log_info!("MCP", "Tool call: list_script_drafts");
        match tools_drafts::list_script_drafts(&self.app_handle) {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: list_script_drafts: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    #[tool(description = "Get one drafted object script's full record (source, target, declared capabilities) so you can iterate on what you wrote. Read-only; the draft is still not mounted.")]
    async fn get_script_draft(
        &self,
        params: Parameters<GetScriptDraftParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        log_info!("MCP", "Tool call: get_script_draft {}", log_summary(&p.draft_id, 80));
        match tools_drafts::get_script_draft(&self.app_handle, &p.draft_id) {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: get_script_draft: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    // ---- BI / cube (read-only) ----

    #[tool(description = "List every BI/cube connection in the workbook (id, name, type, connected state, table/measure counts, server, database). Use this to discover BI models before describe_bi_model or run_bi_query.")]
    async fn list_bi_connections(&self) -> Result<CallToolResult, ErrorData> {
        log_info!("MCP", "Tool call: list_bi_connections");
        match tools::list_bi_connections(&self.app_handle) {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: list_bi_connections: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    #[tool(description = "Describe a BI/cube model's schema (tables + columns with data types, measures, KPIs, relationships) for a connection id from list_bi_connections. Read-only. Call this before run_bi_query to learn valid measure and column names.")]
    async fn describe_bi_model(
        &self,
        params: Parameters<DescribeBiModelParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        log_info!("MCP", "Tool call: describe_bi_model {}", log_summary(&p.connection_id, 80));
        match tools::describe_bi_model(&self.app_handle, &p.connection_id).await {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: describe_bi_model: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    #[tool(description = "Run a READ-ONLY structured BI/cube query: aggregate the given measures grouped by the given [table, column] dimensions, with optional filters. Returns a table of results. Call describe_bi_model first for valid measure/column names.")]
    async fn run_bi_query(
        &self,
        params: Parameters<RunBiQueryParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        log_info!(
            "MCP",
            "Tool call: run_bi_query (conn={} measures={})",
            log_summary(&p.connection_id, 60),
            p.measures.len()
        );
        let group_by: Vec<(String, String)> =
            p.group_by.into_iter().map(|g| (g.table, g.column)).collect();
        let filters: Vec<(String, String, String, String)> =
            p.filters.into_iter().map(|f| (f.table, f.column, f.operator, f.value)).collect();
        match tools::run_bi_query(&self.app_handle, &p.connection_id, p.measures, group_by, filters).await {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: run_bi_query: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    #[tool(description = "Resolve a CUBEVALUE against a BI model: a measure expression plus optional member filters. members is a list of CUBE member-expressions like [\"[Sales Amount]\", \"Product[Category]=Bikes\"]. connection is a connection name or id. Read-only.")]
    async fn cube_value(
        &self,
        params: Parameters<CubeValueParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        log_info!("MCP", "Tool call: cube_value (conn={})", log_summary(&p.connection, 60));
        match tools::cube_value(&self.app_handle, &p.connection, &p.members).await {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: cube_value: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    #[tool(description = "Resolve a KPI value, goal, or status for a BI model. property: 1 = value, 2 = goal, 3 = status. connection is a connection name or id. Read-only.")]
    async fn cube_kpi(
        &self,
        params: Parameters<CubeKpiParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        log_info!(
            "MCP",
            "Tool call: cube_kpi (conn={} kpi={})",
            log_summary(&p.connection, 40),
            log_summary(&p.kpi, 40)
        );
        match tools::cube_kpi(&self.app_handle, &p.connection, &p.kpi, p.property).await {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: cube_kpi: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }

    #[tool(description = "List the distinct members of a level (a Table[Column] expression, e.g. Product[Category]) in a BI model, so you can iterate dimension values. connection is a connection name or id. Read-only.")]
    async fn cube_members(
        &self,
        params: Parameters<CubeMembersParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        log_info!(
            "MCP",
            "Tool call: cube_members (conn={} level={})",
            log_summary(&p.connection, 40),
            log_summary(&p.level, 60)
        );
        match tools::cube_members(&self.app_handle, &p.connection, &p.level).await {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => {
                log_warn!("MCP", "Tool error: cube_members: {}", log_summary(&e, 200));
                Ok(CallToolResult::error(vec![Content::text(e)]))
            }
        }
    }
}

#[tool_handler]
impl ServerHandler for CalculaMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            instructions: Some(
                "Calcula spreadsheet server. Use these tools to read, write, format, \
                 and automate spreadsheet operations in the running Calcula application."
                    .to_string(),
            ),
            capabilities: ServerCapabilities::builder()
                .enable_tools()
                .build(),
            server_info: Implementation {
                name: "calcula-mcp".to_string(),
                version: env!("CARGO_PKG_VERSION").to_string(),
                ..Default::default()
            },
            ..Default::default()
        }
    }
}

// ============================================================================
// Security middleware (runs BEFORE the rmcp service)
// ============================================================================

/// Constant-time byte comparison so token checks don't leak length-prefix
/// timing. (Length mismatch returns early — token length is not secret.)
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// True if a Host header value (optionally with port) is loopback.
fn host_is_loopback(host: &str) -> bool {
    let h = host.trim();
    let without_port = if let Some(rest) = h.strip_prefix('[') {
        // IPv6 literal: "[::1]:8787" or "[::1]"
        rest.split(']').next().unwrap_or("")
    } else {
        // "127.0.0.1:8787" or "localhost" — strip a trailing :port if present
        h.rsplit_once(':').map(|(name, _)| name).unwrap_or(h)
    };
    matches!(
        without_port.to_ascii_lowercase().as_str(),
        "127.0.0.1" | "localhost" | "::1"
    )
}

/// True if a browser Origin header is acceptable.
/// Allowed: empty, "null" (no token leaks to such contexts anyway — they still
/// need the bearer token), and loopback http(s) origins (e.g. MCP Inspector).
/// Everything else is a cross-site request and is rejected (DNS-rebinding and
/// drive-by browser pages send their own page origin here).
fn origin_is_allowed(origin: &str) -> bool {
    let o = origin.trim();
    if o.is_empty() || o.eq_ignore_ascii_case("null") {
        return true;
    }
    let rest = o
        .strip_prefix("http://")
        .or_else(|| o.strip_prefix("https://"));
    match rest {
        Some(host) => host_is_loopback(host),
        None => false,
    }
}

/// Gate every request: Host check, Origin check, then bearer-token auth.
async fn guard_request(token: Arc<String>, req: Request, next: Next) -> Response {
    // --- Host validation (DNS-rebinding defense) ---
    // HTTP/1.1 always carries Host; for HTTP/2 fall back to the URI authority.
    let host_value = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .or_else(|| req.uri().host().map(|h| h.to_string()));
    if let Some(host) = host_value {
        if !host_is_loopback(&host) {
            log_warn!("MCP", "Rejected request: non-local Host '{}'", log_summary(&host, 100));
            return (StatusCode::FORBIDDEN, "Forbidden: non-local Host").into_response();
        }
    }

    // --- Origin validation (reject browser cross-origin requests) ---
    if let Some(origin) = req.headers().get(header::ORIGIN) {
        let origin_str = origin.to_str().unwrap_or("<non-ascii>");
        if !origin_is_allowed(origin_str) {
            log_warn!(
                "MCP",
                "Rejected request: disallowed Origin '{}'",
                log_summary(origin_str, 100)
            );
            return (StatusCode::FORBIDDEN, "Forbidden: disallowed Origin").into_response();
        }
    }

    // --- Per-session bearer token ---
    let authorized = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|presented| constant_time_eq(presented.trim().as_bytes(), token.as_bytes()))
        .unwrap_or(false);
    if !authorized {
        log_warn!("MCP", "Rejected request: missing or invalid bearer token");
        return (
            StatusCode::UNAUTHORIZED,
            [(header::WWW_AUTHENTICATE, "Bearer realm=\"calcula-mcp\"")],
            "Unauthorized: valid bearer token required",
        )
            .into_response();
    }

    next.run(req).await
}

// ============================================================================
// Router Creation
// ============================================================================

pub fn create_router(app_handle: Arc<AppHandle>, session_token: String) -> Router {
    let service: StreamableHttpService<CalculaMcpServer, LocalSessionManager> =
        StreamableHttpService::new(
            move || Ok(CalculaMcpServer::new(app_handle.clone())),
            Default::default(),
            Default::default(),
        );

    let token = Arc::new(session_token);

    Router::new()
        .nest_service("/mcp", service)
        .layer(middleware::from_fn(move |req: Request, next: Next| {
            let token = token.clone();
            async move { guard_request(token, req, next).await }
        }))
}
