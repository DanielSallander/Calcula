//! FILENAME: app/src-tauri/src/mcp/server.rs
//! MCP server definition with tool routing.
//! Implements the MCP protocol so external AI clients can interact with Calcula.

use std::sync::Arc;
use axum::Router;
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
        let result = tools::read_cell_range(
            &self.app_handle,
            p.start_row,
            p.start_col,
            p.end_row,
            p.end_col,
        );
        match result {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(description = "Set the value or formula for a single cell. Use '=' prefix for formulas (e.g., '=SUM(A1:A10)').")]
    async fn set_cell_value(
        &self,
        params: Parameters<SetCellValueParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        let result = tools::write_cell(
            &self.app_handle,
            p.row,
            p.col,
            &p.value,
        );
        match result {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(description = "Set values for multiple cells at once. More efficient than calling set_cell_value repeatedly.")]
    async fn set_cell_range(
        &self,
        params: Parameters<SetCellRangeParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        let result = tools::write_cell_range(&self.app_handle, &p.cells);
        match result {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(description = "Get an AI-optimized summary of the workbook including sheet dimensions, column types, formula patterns, and sample data.")]
    async fn get_sheet_summary(
        &self,
        params: Parameters<GetSheetSummaryParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        let result = tools::get_sheet_summary(&self.app_handle, p.max_chars);
        match result {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(description = "Apply formatting to a range of cells. Supports bold, italic, text color, background color, number format, and text alignment.")]
    async fn apply_formatting(
        &self,
        params: Parameters<ApplyFormattingParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        let result = tools::apply_cell_formatting(&self.app_handle, &p);
        match result {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
        }
    }

    #[tool(description = "Execute a JavaScript script in the spreadsheet's script engine. The script has access to the Calcula API: Calcula.getCellValue(row, col), Calcula.setCellValue(row, col, value), Calcula.getRange(startRow, startCol, endRow, endCol), Calcula.setRange(startRow, startCol, valuesJson).")]
    async fn run_script(
        &self,
        params: Parameters<RunScriptParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        let result = tools::execute_script(&self.app_handle, &p.code);
        match result {
            Ok(text) => Ok(CallToolResult::success(vec![Content::text(text)])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
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
// Router Creation
// ============================================================================

pub fn create_router(app_handle: Arc<AppHandle>) -> Router {
    let service: StreamableHttpService<CalculaMcpServer, LocalSessionManager> =
        StreamableHttpService::new(
            move || Ok(CalculaMcpServer::new(app_handle.clone())),
            Default::default(),
            Default::default(),
        );

    Router::new().nest_service("/mcp", service)
}
