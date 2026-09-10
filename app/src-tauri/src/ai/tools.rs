//! FILENAME: app/src-tauri/src/ai/tools.rs
//! PURPOSE: Map one model-requested tool call to the EXISTING mcp::tools helpers,
//!          so the in-app chat and the MCP server expose ONE tool surface with one
//!          set of invariants -- undoable writes, refresh events, and the same
//!          check_script_security gate.
//! CONTEXT: Moved verbatim out of ai_chat.rs when that module became the
//!          multi-provider `ai` module. Nothing here is vendor-specific and
//!          nothing here changed: a tool call is a tool call whichever model
//!          authored it, which is exactly why a local model inherits the entire
//!          safety envelope for free and this design adds no new privileged reach.
//!
//!          The draft arms (draft_object_script / list_script_drafts /
//!          get_script_draft) are the review path: they store source, count its
//!          lines and parse its capability pragmas, and reach no script runtime.
//!          `run_script` above them EXECUTES. The pair is deliberately adjacent.

use serde_json::Value;
use tauri::AppHandle;

use crate::mcp::{drafts, tools};

fn arg_u32(input: &Value, key: &str) -> Result<u32, String> {
    input
        .get(key)
        .and_then(|v| v.as_u64())
        .map(|n| n as u32)
        .ok_or_else(|| format!("Tool argument '{}' must be a non-negative integer.", key))
}

fn arg_str<'a>(input: &'a Value, key: &str) -> Result<&'a str, String> {
    input
        .get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("Tool argument '{}' must be a string.", key))
}

/// Run a Claude-requested tool against the workbook, reusing the same helpers the
/// MCP server exposes. Returns the tool's text result (which the frontend sends
/// back to Claude as a tool_result). Write tools inherit check_script_security +
/// undo + refresh-event behavior. v1 tool set: read + cell write + named range.
#[tauri::command]
pub async fn ai_chat_run_tool(
    handle: AppHandle,
    name: String,
    input: Value,
    window: tauri::Window,
) -> Result<String, String> {
    // Privileged tool dispatcher (writes the workbook + runs scripts): restrict to
    // the MAIN window like every sibling privileged command. ChatView runs in the
    // main window, so this is non-breaking; it closes the gap that a secondary
    // webview could call this directly.
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    match name.as_str() {
        "get_sheet_summary" => {
            let max = input.get("max_chars").and_then(|v| v.as_u64()).unwrap_or(8000) as u32;
            tools::get_sheet_summary(&handle, max)
        }
        "read_cell_range" => tools::read_cell_range(
            &handle,
            arg_u32(&input, "start_row")?,
            arg_u32(&input, "start_col")?,
            arg_u32(&input, "end_row")?,
            arg_u32(&input, "end_col")?,
        ),
        "set_cell_value" => tools::write_cell(
            &handle,
            arg_u32(&input, "row")?,
            arg_u32(&input, "col")?,
            arg_str(&input, "value")?,
        ),
        "list_charts" => tools::list_charts(&handle),
        "list_named_ranges" => tools::list_named_ranges(&handle),
        "list_tables" => tools::list_tables(&handle),
        "list_pivots" => tools::list_pivots(&handle),
        "create_named_range" => tools::create_named_range(
            &handle,
            arg_str(&input, "name")?,
            arg_str(&input, "refers_to")?,
            input.get("sheet_index").and_then(|v| v.as_u64()).map(|n| n as usize),
            input.get("comment").and_then(|v| v.as_str()).map(|s| s.to_string()),
        ),
        "create_table" => tools::create_table(
            &handle,
            arg_u32(&input, "start_row")?,
            arg_u32(&input, "start_col")?,
            arg_u32(&input, "end_row")?,
            arg_u32(&input, "end_col")?,
            input.get("has_headers").and_then(|v| v.as_bool()).unwrap_or(true),
            input.get("name").and_then(|v| v.as_str()),
        ),
        // Parity with the MCP server's tool set — deserialize into the same param
        // structs and call the same shared crate::mcp::tools fns (no duplicated logic).
        "set_cell_range" => {
            let p: crate::mcp::server::SetCellRangeParams =
                serde_json::from_value(input.clone()).map_err(|e| e.to_string())?;
            tools::write_cell_range(&handle, &p.cells)
        }
        "apply_formatting" => {
            let p: crate::mcp::server::ApplyFormattingParams =
                serde_json::from_value(input.clone()).map_err(|e| e.to_string())?;
            tools::apply_cell_formatting(&handle, &p)
        }
        "run_script" => {
            let p: crate::mcp::server::RunScriptParams =
                serde_json::from_value(input.clone()).map_err(|e| e.to_string())?;
            // Async now: the script surface runs on a dedicated thread so the
            // read-only model.* API can bridge to the async BI internals.
            tools::execute_script(&handle, &p.code).await
        }
        // ---- Script drafting: AUTHOR for review, never mount or execute ----
        // Routed to crate::mcp::drafts — the same helpers the MCP server calls,
        // so there is ONE draft queue and one set of invariants, not two. Nothing
        // in this arm runs JavaScript: `draft_object_script` stores the source,
        // counts its lines, and parses its `// @capability` pragmas with the same
        // parser that sets a saved script's R19 ceiling. Promotion to live code is
        // the user's action in the Object Script Editor (`save_object_script`,
        // which is window-guarded and unreachable from here).
        //
        // Deliberately adjacent to `run_script` above: that arm EXECUTES now, this
        // one hands the user something to read. The distinction is the whole point
        // of the pair and it should be visible in one screenful.
        "draft_object_script" => {
            let p: crate::mcp::server::DraftObjectScriptParams =
                serde_json::from_value(input.clone()).map_err(|e| e.to_string())?;
            drafts::draft_object_script(
                &handle,
                &p.name,
                &p.object_type,
                p.instance_id.as_deref(),
                p.description.as_deref(),
                &p.source,
            )
        }
        "list_script_drafts" => drafts::list_script_drafts(&handle),
        "get_script_draft" => {
            let p: crate::mcp::server::GetScriptDraftParams =
                serde_json::from_value(input.clone()).map_err(|e| e.to_string())?;
            drafts::get_script_draft(&handle, &p.draft_id)
        }
        "get_chart" => {
            let p: crate::mcp::server::GetChartParams =
                serde_json::from_value(input.clone()).map_err(|e| e.to_string())?;
            tools::get_chart(&handle, &p.chart_id)
        }
        "create_chart_from_spec" => {
            let p: crate::mcp::server::CreateChartParams =
                serde_json::from_value(input.clone()).map_err(|e| e.to_string())?;
            tools::create_chart_from_spec(&handle, &p.spec, p.sheet_index, p.name.as_deref())
        }
        "create_pivot" => {
            let p: crate::mcp::server::CreatePivotParams =
                serde_json::from_value(input.clone()).map_err(|e| e.to_string())?;
            let value_fields: Vec<(String, String)> =
                p.value_fields.into_iter().map(|v| (v.field, v.aggregation)).collect();
            tools::create_pivot(
                &handle,
                &p.source_range,
                &p.destination_cell,
                p.row_fields,
                value_fields,
                p.source_sheet,
                p.destination_sheet,
                p.has_headers.unwrap_or(true),
                p.name.as_deref(),
            )
        }
        // Read-only BI / cube tools — async (they await the BI engine lock).
        "list_bi_connections" => tools::list_bi_connections(&handle),
        "describe_bi_model" => {
            let conn = arg_str(&input, "connection_id")?.to_string();
            tools::describe_bi_model(&handle, &conn).await
        }
        "run_bi_query" => {
            let p: crate::mcp::server::RunBiQueryParams =
                serde_json::from_value(input.clone()).map_err(|e| e.to_string())?;
            let group_by: Vec<(String, String)> =
                p.group_by.into_iter().map(|g| (g.table, g.column)).collect();
            let filters: Vec<(String, String, String, String)> =
                p.filters.into_iter().map(|f| (f.table, f.column, f.operator, f.value)).collect();
            tools::run_bi_query(&handle, &p.connection_id, p.measures, group_by, filters).await
        }
        "cube_value" => {
            let p: crate::mcp::server::CubeValueParams =
                serde_json::from_value(input.clone()).map_err(|e| e.to_string())?;
            tools::cube_value(&handle, &p.connection, &p.members).await
        }
        "cube_kpi" => {
            let p: crate::mcp::server::CubeKpiParams =
                serde_json::from_value(input.clone()).map_err(|e| e.to_string())?;
            tools::cube_kpi(&handle, &p.connection, &p.kpi, p.property).await
        }
        "cube_members" => {
            let p: crate::mcp::server::CubeMembersParams =
                serde_json::from_value(input.clone()).map_err(|e| e.to_string())?;
            tools::cube_members(&handle, &p.connection, &p.level).await
        }
        // Deterministic analysis — the Tier-0 engine, reached from the chat.
        // Until 2026-09-10 only an EXTERNAL MCP client could ask for these; the
        // in-app chat's 24 tools had no analysis tool, so "what is going on in
        // this data" was answered by a model reading raw cells and reasoning
        // about them — the one job it is least reliable at. Same param structs
        // and the same crate::mcp::tools bodies as the MCP server, so the chat
        // and an external client get byte-identical facts. Read-only: neither
        // takes a `DocumentEffect`.
        "analyze_range" => {
            let p: crate::mcp::server::AnalyzeRangeParams =
                serde_json::from_value(input.clone()).map_err(|e| e.to_string())?;
            tools::analyze_range(
                &handle,
                p.sheet_index,
                p.start_row,
                p.start_col,
                p.end_row,
                p.end_col,
                p.expand_to_region,
            )
        }
        "analyze_model" => {
            let p: crate::mcp::server::AnalyzeModelParams =
                serde_json::from_value(input.clone()).map_err(|e| e.to_string())?;
            tools::analyze_model(&handle, p.connection_id, p.measures).await
        }
        other => Err(format!("Unknown tool '{}'.", other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn arg_helpers_parse_and_error() {
        let v = json!({ "row": 3, "value": "hi" });
        assert_eq!(arg_u32(&v, "row").unwrap(), 3);
        assert_eq!(arg_str(&v, "value").unwrap(), "hi");
        assert!(arg_u32(&v, "value").is_err(), "string is not a u32");
        assert!(arg_str(&v, "row").is_err(), "number is not a string");
        assert!(arg_u32(&v, "missing").is_err());
    }
}
