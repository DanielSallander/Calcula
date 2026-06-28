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

    #[tool(description = "Execute a JavaScript script in the spreadsheet's script engine. The script has access to the Calcula API: Calcula.getCellValue(row, col), Calcula.setCellValue(row, col, value), Calcula.getRange(startRow, startCol, endRow, endCol), Calcula.setRange(startRow, startCol, valuesJson).")]
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
        let result = tools::execute_script(&self.app_handle, &p.code);
        match result {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
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
