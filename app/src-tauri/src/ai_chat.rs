//! FILENAME: app/src-tauri/src/ai_chat.rs
//! PURPOSE: In-app Claude chat (C1) — three backend pieces:
//!   L1  API-key storage in the Windows Credential Manager (DPAPI), keyed by a
//!       fixed target. Never returned to the frontend, never logged.
//!   L2  ai_chat_complete: a NON-streaming POST to the Anthropic Messages API.
//!       Messages/tools/response are passed through as JSON (the frontend speaks
//!       the Anthropic wire format), so the Tauri layer stays thin.
//!   L4  ai_chat_run_tool: maps a Claude tool_use call to the EXISTING
//!       mcp::tools helpers (same tool surface as the MCP server) — so AI writes
//!       are undoable + emit refresh events, gated by check_script_security.
//! SECURITY: the API key is stored in the OS keychain (DPAPI, login-bound),
//!   never surfaced to JS, never logged, never written to the workbook. The
//!   Anthropic call is a dedicated reqwest path (NOT the sandboxed
//!   script_http_fetch, which strips auth headers).

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;

use serde_json::{json, Value};
use tauri::AppHandle;
use windows::core::PWSTR;
use windows::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_FLAGS,
    CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
};

use crate::mcp::tools;

/// Fixed Credential Manager target for the Anthropic API key.
const TARGET: &str = "Calcula:aikey|anthropic";
/// Default model (the latest/most-capable Claude, per the app's guidance).
const DEFAULT_MODEL: &str = "claude-opus-4-8";
const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
// Raised from 4096: adaptive extended thinking counts toward output, so a tight
// budget could truncate a reasoning+tool-use turn mid-thought.
const DEFAULT_MAX_TOKENS: u32 = 16000;

fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

// ---------------------------------------------------------------------------
// L1: API-key storage (Windows Credential Manager)
// ---------------------------------------------------------------------------

fn set_key(key: &str) -> Result<(), String> {
    let secret = key.as_bytes();
    let mut target_wide = to_wide(TARGET);
    let mut user_wide = to_wide("calcula-anthropic"); // label only, never the key
    let cred = CREDENTIALW {
        Flags: CRED_FLAGS(0),
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(target_wide.as_mut_ptr()),
        Comment: PWSTR::null(),
        LastWritten: Default::default(),
        CredentialBlobSize: secret.len() as u32,
        CredentialBlob: secret.as_ptr() as *mut u8,
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        AttributeCount: 0,
        Attributes: std::ptr::null_mut(),
        TargetAlias: PWSTR::null(),
        UserName: PWSTR(user_wide.as_mut_ptr()),
    };
    unsafe { CredWriteW(&cred, 0) }.map_err(|e| format!("CredWriteW failed: {}", e))
}

fn get_key() -> Option<String> {
    let target_wide = to_wide(TARGET);
    unsafe {
        let mut cred_ptr: *mut CREDENTIALW = std::ptr::null_mut();
        match CredReadW(
            windows::core::PCWSTR(target_wide.as_ptr()),
            CRED_TYPE_GENERIC,
            None,
            &mut cred_ptr,
        ) {
            Ok(()) => {
                let cred = &*cred_ptr;
                let blob = std::slice::from_raw_parts(
                    cred.CredentialBlob,
                    cred.CredentialBlobSize as usize,
                );
                let secret = String::from_utf8_lossy(blob).to_string();
                CredFree(cred_ptr as *const std::ffi::c_void);
                Some(secret)
            }
            Err(_) => None,
        }
    }
}

fn delete_key() {
    let target_wide = to_wide(TARGET);
    unsafe {
        let _ = CredDeleteW(
            windows::core::PCWSTR(target_wide.as_ptr()),
            CRED_TYPE_GENERIC,
            None,
        );
    }
}

/// Store the Anthropic API key for this machine. Refuses an empty key.
#[tauri::command]
pub fn ai_chat_set_api_key(key: String) -> Result<(), String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err("API key is empty.".to_string());
    }
    set_key(trimmed)
}

/// Whether an API key is stored (the key itself is never returned to the UI).
#[tauri::command]
pub fn ai_chat_has_api_key() -> bool {
    get_key().is_some()
}

/// Forget the stored API key.
#[tauri::command]
pub fn ai_chat_delete_api_key() {
    delete_key();
}

// ---------------------------------------------------------------------------
// L2: Anthropic Messages API call (non-streaming)
// ---------------------------------------------------------------------------

/// Call the Anthropic Messages API once. `messages` and `tools` are passed
/// through verbatim (the frontend builds them in Anthropic wire format), and the
/// raw response JSON is returned for the frontend to interpret (text / tool_use
/// blocks, stop_reason). Errors carry the API status + body for display.
#[tauri::command]
pub async fn ai_chat_complete(
    messages: Vec<Value>,
    system: Option<String>,
    tools: Option<Value>,
    model: Option<String>,
    max_tokens: Option<u32>,
) -> Result<Value, String> {
    let key = get_key()
        .ok_or_else(|| "No Anthropic API key set. Add one in the AI Chat panel.".to_string())?;

    let resolved_model = model
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());
    // Adaptive extended thinking — supported on the Opus 4.x family (budget_tokens /
    // temperature would 400 on Opus 4.8, so adaptive only). Gated on the model family
    // so a future non-Opus model picker can't send an unsupported param. ChatView
    // preserves the full assistant `content` array (incl. thinking blocks) across
    // tool-use turns, so thinking round-trips correctly through the agentic loop.
    let supports_adaptive_thinking = resolved_model.starts_with("claude-opus-4");
    let mut body = json!({
        "model": resolved_model,
        "max_tokens": max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
        "messages": messages,
    });
    if supports_adaptive_thinking {
        body["thinking"] = json!({ "type": "adaptive" });
    }
    if let Some(sys) = system.filter(|s| !s.trim().is_empty()) {
        body["system"] = json!(sys);
    }
    if let Some(t) = tools {
        body["tools"] = t;
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let resp = client
        .post(ANTHROPIC_URL)
        .header("content-type", "application/json")
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("x-api-key", key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request to Anthropic failed: {}", e))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("Reading Anthropic response failed: {}", e))?;
    if !status.is_success() {
        return Err(format!("Anthropic API error {}: {}", status.as_u16(), text));
    }
    serde_json::from_str(&text).map_err(|e| format!("Parsing Anthropic response failed: {}", e))
}

// ---------------------------------------------------------------------------
// L4: tool dispatcher — Claude tool_use -> existing mcp::tools helpers
// ---------------------------------------------------------------------------

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
            tools::execute_script(&handle, &p.code)
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
        other => Err(format!("Unknown tool '{}'.", other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
