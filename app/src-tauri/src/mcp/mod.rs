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
// UPDATE + DELETE tools for charts / named ranges / tables / pivots, plus sheet
// management. Split out of tools.rs so the create-vs-edit surface stays legible
// and the tier policy has one home (`objects::required_tier`).
pub(crate) mod objects;
// `draft_object_script`: the AI authors a macro, the USER reviews and mounts it.
// Kept in its own module because its store must never be confused with — or
// merged into — the workbook's mount-on-load object scripts.
pub(crate) mod drafts;

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

/// Bind the MCP listener — loopback only, listening (kernel backlog live)
/// from the moment this returns. Split out of `mcp_start` so the two halves
/// of its contract are unit-pinned: a successful return accepts connections
/// immediately, and a port conflict is a caller-visible `Err`.
fn bind_mcp_listener(port: u16) -> Result<std::net::TcpListener, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", port))
        .map_err(|e| format!("Could not bind 127.0.0.1:{}: {}", port, e))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Could not configure the MCP listener: {}", e))?;
    Ok(listener)
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

    // Bind SYNCHRONOUSLY, here in the command, and hand the bound listener to
    // the server thread. Two contracts depend on it (BUG-0063, caught by the
    // full functional pass):
    //  1. Success from this command — and `running: true` from `mcp_status` —
    //     must mean "the port accepts connections NOW". The old code spawned a
    //     thread that created a Tokio runtime and only then bound; under load
    //     a client following start -> status -> connect hit ECONNREFUSED on a
    //     server that claimed to be running (test 265 of 554 lost exactly that
    //     race, and a user pasting the config into an MCP client can lose it
    //     the same way). A bound listener accepts into the kernel backlog even
    //     before the accept loop runs, so the race is structurally gone.
    //  2. A bind FAILURE (port in use) must be THIS command's error — not a
    //     log line from a thread after "started" was already returned, with
    //     `running` flapping back to false in silence.
    let std_listener = bind_mcp_listener(port)?;

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
            if let Err(e) = run_server(handle, std_listener, port, session_token, token_clone).await {
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
    std_listener: std::net::TcpListener,
    port: u16,
    session_token: String,
    cancel_token: CancellationToken,
) -> Result<(), Box<dyn std::error::Error>> {
    let app_handle = Arc::new(app_handle);
    let router = server::create_router(app_handle, session_token);

    // The listener was bound (and set nonblocking) in `mcp_start`, so success
    // there already means "accepting connections" — see the comment at the
    // bind site.
    let listener = TcpListener::from_std(std_listener)?;
    log_info!("MCP", "Server listening on http://127.0.0.1:{}/mcp", port);

    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            cancel_token.cancelled().await;
            log_info!("MCP", "Server shutting down");
        })
        .await?;

    Ok(())
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod bind_tests {
    use super::bind_mcp_listener;

    /// The two halves of the `mcp_start` bind contract (BUG-0063).
    ///
    /// 1. A successful bind accepts connections IMMEDIATELY — before any
    ///    accept loop exists. This is what makes `mcp_start`'s success (and
    ///    `mcp_status`'s `running: true`) mean "you can connect now": the old
    ///    code bound on a freshly-spawned thread's freshly-created runtime,
    ///    and a client following start -> status -> connect could beat it and
    ///    get ECONNREFUSED from a server that claimed to be running.
    /// 2. Binding a port that is already taken is an `Err` naming the port —
    ///    the caller's error, not a background thread's log line after
    ///    "started" was already returned.
    #[test]
    fn a_successful_bind_accepts_before_any_accept_loop_and_a_conflict_is_an_err() {
        // Port 0 = the OS picks a free port; no accept loop is ever started.
        let listener = bind_mcp_listener(0).expect("bind to an OS-chosen free port");
        let port = listener.local_addr().expect("local_addr").port();

        // A client can connect NOW (kernel backlog), with nothing accepting.
        std::net::TcpStream::connect(("127.0.0.1", port))
            .expect("a bound listener must accept connections before the accept loop runs");

        // And a second bind of the same port is a visible error, not a
        // deferred log line.
        let err = bind_mcp_listener(port).expect_err("port conflict must be an Err");
        assert!(err.contains(&port.to_string()), "got: {}", err);
    }
}
