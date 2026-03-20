//! FILENAME: app/src-tauri/src/mcp/mod.rs
//! MCP (Model Context Protocol) server for Calcula.
//!
//! Exposes spreadsheet tools over Streamable HTTP so external AI clients
//! (Claude Desktop, Claude Code) can read/write the running workbook.
//! Managed via Tauri commands: start, stop, get status.

mod server;
mod tools;

use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

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
}

impl McpState {
    pub fn new() -> Self {
        Self {
            running: Mutex::new(false),
            cancel_token: Mutex::new(None),
            port: Mutex::new(DEFAULT_MCP_PORT),
        }
    }
}

/// Start the MCP server on the configured port.
#[tauri::command]
pub fn mcp_start(app_handle: AppHandle, state: tauri::State<'_, McpState>) -> Result<String, String> {
    let mut running = state.running.lock().map_err(|e| e.to_string())?;
    if *running {
        return Err("MCP server is already running".to_string());
    }

    let port = *state.port.lock().map_err(|e| e.to_string())?;
    let cancel_token = CancellationToken::new();
    let token_clone = cancel_token.clone();

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
            if let Err(e) = run_server(handle, port, token_clone).await {
                eprintln!("[MCP] Server error: {}", e);
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
        }
    });

    Ok(format!("MCP server started on port {}", port))
}

/// Stop the running MCP server.
#[tauri::command]
pub fn mcp_stop(state: tauri::State<'_, McpState>) -> Result<String, String> {
    let running = state.running.lock().map_err(|e| e.to_string())?;
    if !*running {
        return Err("MCP server is not running".to_string());
    }

    let ct = state.cancel_token.lock().map_err(|e| e.to_string())?;
    if let Some(token) = ct.as_ref() {
        token.cancel();
    }

    Ok("MCP server stopping...".to_string())
}

/// Get the current MCP server status.
#[tauri::command]
pub fn mcp_status(state: tauri::State<'_, McpState>) -> Result<McpStatusResponse, String> {
    let running = *state.running.lock().map_err(|e| e.to_string())?;
    let port = *state.port.lock().map_err(|e| e.to_string())?;
    Ok(McpStatusResponse { running, port })
}

/// Set the MCP server port. Only takes effect on next start.
#[tauri::command]
pub fn mcp_set_port(port: u16, state: tauri::State<'_, McpState>) -> Result<String, String> {
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
}

// ============================================================================
// Internal server runner
// ============================================================================

async fn run_server(
    app_handle: AppHandle,
    port: u16,
    cancel_token: CancellationToken,
) -> Result<(), Box<dyn std::error::Error>> {
    let app_handle = Arc::new(app_handle);
    let router = server::create_router(app_handle);

    let addr = format!("127.0.0.1:{}", port);
    let listener = TcpListener::bind(&addr).await?;
    eprintln!("[MCP] Server listening on http://{}/mcp", addr);

    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            cancel_token.cancelled().await;
            eprintln!("[MCP] Server shutting down");
        })
        .await?;

    Ok(())
}
