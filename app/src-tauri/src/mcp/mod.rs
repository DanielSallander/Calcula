//! FILENAME: app/src-tauri/src/mcp/mod.rs
//! MCP (Model Context Protocol) server for Calcula.
//!
//! Exposes spreadsheet tools over Streamable HTTP so external AI clients
//! (Claude Desktop, Claude Code) can read/write the running workbook.
//! Managed via Tauri commands: start, stop, get status.
//!
//! Security model:
//! - Per-session bearer token: generated from OS randomness on every start,
//!   required on every HTTP request (enforced by middleware ahead of the
//!   rmcp service — rmcp session IDs are NOT authentication).
//! - Origin/Host hardening: browser Origins are rejected unless empty/null
//!   or loopback, and the Host header must be loopback (DNS-rebinding defense).
//! - Every tool invocation is logged under the "MCP" category.

// pub(crate) so the in-app AI chat (ai_chat.rs) can reuse the same tool param
// structs (SetCellRangeParams, ApplyFormattingParams, CreatePivotParams, ...) for
// MCP↔chat tool parity.
pub(crate) mod server;
// pub(crate) so the in-app AI chat (ai_chat.rs) can reuse the same tool helpers
// the MCP server exposes (read/write workbook), keeping one tool surface.
pub(crate) mod tools;

use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use crate::{log_error, log_info};

/// Default MCP server port.
const DEFAULT_MCP_PORT: u16 = 8787;

/// Managed state for the MCP server lifecycle.
pub struct McpState {
    /// Whether the server is currently running.
    running: Mutex<bool>,
    /// Cancel token to shut down the running server.
    pub(crate) cancel_token: Mutex<Option<CancellationToken>>,
    /// Configured port (persisted across start/stop).
    port: Mutex<u16>,
    /// Per-session bearer token. Regenerated on every start, cleared on stop.
    token: Mutex<Option<String>>,
}

impl McpState {
    pub fn new() -> Self {
        Self {
            running: Mutex::new(false),
            cancel_token: Mutex::new(None),
            port: Mutex::new(DEFAULT_MCP_PORT),
            token: Mutex::new(None),
        }
    }
}

/// Generate a cryptographically random bearer token for one server session.
///
/// Two concatenated UUIDv4s (the `uuid` crate's v4 generator draws from OS
/// randomness) yield 244 random bits as a 64-char hex string.
/// NOTE: `identity::generate_uuid_v7` is NOT used here — it is a time-seeded
/// xorshift PRNG, fine for entity ids but not for secrets.
fn generate_session_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Start the MCP server on the configured port.
#[tauri::command]
pub fn mcp_start(app_handle: AppHandle, state: tauri::State<'_, McpState>, window: tauri::Window) -> Result<String, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let mut running = state.running.lock().map_err(|e| e.to_string())?;
    if *running {
        return Err("MCP server is already running".to_string());
    }

    let port = *state.port.lock().map_err(|e| e.to_string())?;
    let cancel_token = CancellationToken::new();
    let token_clone = cancel_token.clone();

    // Generate a fresh bearer token for this server session.
    let session_token = generate_session_token();
    {
        let mut t = state.token.lock().map_err(|e| e.to_string())?;
        *t = Some(session_token.clone());
    }

    // Store the cancel token
    {
        let mut ct = state.cancel_token.lock().map_err(|e| e.to_string())?;
        *ct = Some(cancel_token);
    }

    *running = true;
    let handle = app_handle.clone();

    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new()
            .expect("Failed to create Tokio runtime for MCP server");
        rt.block_on(async move {
            if let Err(e) = run_server(handle, port, session_token, token_clone).await {
                log_error!("MCP", "Server error: {}", e);
            }
        });
        // Mark as stopped when the server exits
        // (AppHandle gives us access to state)
        if let Some(state) = app_handle.try_state::<McpState>() {
            if let Ok(mut r) = state.running.lock() {
                *r = false;
            }
            if let Ok(mut ct) = state.cancel_token.lock() {
                *ct = None;
            }
            // Invalidate the session token — a new one is issued on next start.
            if let Ok(mut t) = state.token.lock() {
                *t = None;
            }
        }
    });

    log_info!("MCP", "Server starting on port {} (bearer token issued for this session)", port);
    Ok(format!("MCP server started on port {}", port))
}

/// Stop the running MCP server.
#[tauri::command]
pub fn mcp_stop(state: tauri::State<'_, McpState>, window: tauri::Window) -> Result<String, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let running = state.running.lock().map_err(|e| e.to_string())?;
    if !*running {
        return Err("MCP server is not running".to_string());
    }

    let ct = state.cancel_token.lock().map_err(|e| e.to_string())?;
    if let Some(token) = ct.as_ref() {
        token.cancel();
    }

    log_info!("MCP", "Server stop requested");
    Ok("MCP server stopping...".to_string())
}

/// Get the current MCP server status, including the session bearer token
/// (so the UI can show the user what to paste into their client config).
#[tauri::command]
pub fn mcp_status(state: tauri::State<'_, McpState>, window: tauri::Window) -> Result<McpStatusResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let running = *state.running.lock().map_err(|e| e.to_string())?;
    let port = *state.port.lock().map_err(|e| e.to_string())?;
    let token = state.token.lock().map_err(|e| e.to_string())?.clone();
    Ok(McpStatusResponse { running, port, token })
}

/// Set the MCP server port. Only takes effect on next start.
#[tauri::command]
pub fn mcp_set_port(port: u16, state: tauri::State<'_, McpState>, window: tauri::Window) -> Result<String, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let running = *state.running.lock().map_err(|e| e.to_string())?;
    if running {
        return Err("Cannot change port while server is running. Stop the server first.".to_string());
    }
    let mut p = state.port.lock().map_err(|e| e.to_string())?;
    *p = port;
    Ok(format!("MCP port set to {}", port))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatusResponse {
    pub running: bool,
    pub port: u16,
    /// Session bearer token; `None` while the server is stopped.
    pub token: Option<String>,
}

// ============================================================================
// Internal server runner
// ============================================================================

async fn run_server(
    app_handle: AppHandle,
    port: u16,
    session_token: String,
    cancel_token: CancellationToken,
) -> Result<(), Box<dyn std::error::Error>> {
    let app_handle = Arc::new(app_handle);
    let router = server::create_router(app_handle, session_token);

    let addr = format!("127.0.0.1:{}", port);
    let listener = TcpListener::bind(&addr).await?;
    log_info!("MCP", "Server listening on http://{}/mcp", addr);

    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            cancel_token.cancelled().await;
            log_info!("MCP", "Server shutting down");
        })
        .await?;

    Ok(())
}
