//! FILENAME: app/src-tauri/src/net_commands.rs
//! PURPOSE: The application's FIRST and ONLY outbound network egress:
//!          `script_http_fetch`, plus the grant/revoke commands that feed the
//!          authoritative backend capability store.
//! CONTEXT: docs/design/script-sandbox-architecture.md §8 (R9) + §11 (Phase 4).
//!
//! SECURITY MODEL (this file is the gate):
//! The renderer can be compromised, so Rust is the authoritative permission
//! check and NEVER trusts frontend-supplied permission. `script_http_fetch`
//! re-derives the origin from the request URL and checks it against the backend
//! `CapabilityStore` — it never infers permission from the request itself.
//! Enforced here, in Rust:
//!   - https only (http / file / data / anything else rejected)
//!   - userinfo (user:pass@) rejected
//!   - origin re-checked against the store, not the request
//!   - 10 fetches / minute / script rate limit
//!   - method allowlist (GET/POST/PUT/PATCH/DELETE/HEAD)
//!   - no redirects (a redirect could target a non-granted origin)
//!   - no cookie jar
//!   - Authorization / Cookie request headers stripped (credentials never attach)
//!   - 30s timeout
//!   - 5 MB response cap (streamed, aborts early)
//!   - set-cookie response headers dropped
//!   - every call (success, denial, error) audited with script_id + method + url

use std::collections::HashMap;
use std::time::Duration;

use tauri::{State, Window};

use crate::scripting::CapabilityStore;
use crate::scripting::capability_store::{normalize_origin, parse_url};
use crate::AppState;
use crate::{log_info, log_warn};

/// Max number of fetches per script per rolling minute.
const MAX_FETCH_PER_MIN: usize = 10;
/// Hard cap on response body size (5 MB). Streamed; aborts once exceeded.
const MAX_RESPONSE_BYTES: usize = 5_242_880;
/// Per-request timeout.
const REQUEST_TIMEOUT_SECS: u64 = 30;

// ============================================================================
// IPC types (camelCase on the wire via struct-level rename_all)
// ============================================================================

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpFetchRequest {
    pub script_id: String,
    pub url: String,
    pub method: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub body: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpFetchResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

// ============================================================================
// Grant / revoke (called only from the main window on consent-grant)
// ============================================================================

/// Mirror a consent-granted net.fetch origin into the authoritative backend
/// store. The frontend's persistent consent store is the system of record;
/// this re-establishes the in-memory grant the Rust gate checks. Rejects any
/// non-https or unparseable origin so the store can only ever hold https
/// origins.
#[tauri::command]
pub fn grant_script_net_origin(
    cap_store: State<CapabilityStore>,
    script_id: String,
    origin: String,
    window: Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;

    let parsed = parse_url(&origin)
        .map_err(|e| format!("InvalidOrigin: {}", e))?;
    if parsed.scheme != "https" {
        return Err("InvalidOrigin: only https origins may be granted".to_string());
    }
    if parsed.has_userinfo {
        return Err("InvalidOrigin: origin must not contain userinfo".to_string());
    }
    let normalized = normalize_origin(&parsed);
    cap_store.grant_net_origin(&script_id, &normalized);
    log_info!(
        "SECURITY",
        "grant_script_net_origin: script={} origin={}",
        script_id,
        normalized
    );
    Ok(())
}

/// Mirror a consent-granted BI capability ("bi.query" / "bi.sql") into the
/// authoritative backend store. The frontend's consent store is the system of
/// record; this re-establishes the in-memory grant that `bi_query` /
/// `script_bi_sql` re-check per call. Only the main window may grant.
#[tauri::command]
pub fn grant_script_bi(
    cap_store: State<CapabilityStore>,
    script_id: String,
    capability: String,
    window: Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    if capability != "bi.query" && capability != "bi.sql" {
        return Err(format!("InvalidCapability: {} (expected bi.query or bi.sql)", capability));
    }
    cap_store.grant_bi(&script_id, &capability);
    log_info!(
        "SECURITY",
        "grant_script_bi: script={} capability={}",
        script_id,
        capability
    );
    Ok(())
}

/// Record a broker-mediated capability call into the per-workbook audit log
/// (the always-on script-activity trail, `AuditEvent::CapabilityCall`), so
/// capability use — not just grid mutations — survives reload. `detail` is an
/// optional NON-SENSITIVE specifier (e.g. a net origin or a SQL prefix); never
/// the full URL/SQL, which may carry query strings / credentials.
pub(crate) fn record_capability_call(
    audit_log: &std::sync::Mutex<calp::audit::AuditLog>,
    capability: &str,
    script_id: &str,
    ok: bool,
    detail: Option<&str>,
    error: Option<&str>,
) {
    use serde_json::json;
    let now = chrono::Utc::now().to_rfc3339();
    let mut extra: std::collections::HashMap<String, serde_json::Value> = std::collections::HashMap::new();
    extra.insert("capability".into(), json!(capability));
    if !script_id.is_empty() {
        extra.insert("scriptId".into(), json!(script_id));
    }
    extra.insert("ok".into(), json!(ok));
    if let Some(d) = detail {
        extra.insert("detail".into(), json!(d));
    }
    if let Some(e) = error {
        extra.insert("error".into(), json!(e));
    }
    let desc = match (ok, detail) {
        (true, Some(d)) => format!("{} → {}", capability, d),
        (true, None) => format!("{} call", capability),
        (false, _) => format!(
            "{} DENIED{}",
            capability,
            error.map(|e| format!(" ({})", e)).unwrap_or_default()
        ),
    };
    if let Ok(mut audit) = audit_log.lock() {
        audit.record_with_extra(calp::audit::AuditEvent::CapabilityCall, &desc, "local", &now, extra);
    }
}

/// Write-through sink for the frontend broker's audit ring: persists a
/// capability-call outcome into the per-workbook audit log so it survives reload.
/// Called fire-and-forget from `broker.ts` for the capabilities NOT recorded
/// authoritatively server-side (the frontend-only caps — storage / ui.html /
/// formula.udf — and broker-side policy denials). The backend-reaching caps
/// (net.fetch / bi.query / bi.sql) record themselves in their Rust gates, so the
/// broker skips those to avoid double-recording. Main-window only.
#[tauri::command]
pub fn audit_record_capability(
    state: State<AppState>,
    script_id: String,
    capability: String,
    ok: bool,
    detail: Option<String>,
    error: Option<String>,
    window: Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    record_capability_call(
        &state.audit_log,
        &capability,
        &script_id,
        ok,
        detail.as_deref(),
        error.as_deref(),
    );
    Ok(())
}

/// Drop all backend capability state for a script. Called on unmount / revoke.
#[tauri::command]
pub fn revoke_script_capabilities(
    cap_store: State<CapabilityStore>,
    script_id: String,
    window: Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    cap_store.revoke_script(&script_id);
    log_info!("SECURITY", "revoke_script_capabilities: script={}", script_id);
    Ok(())
}

// ============================================================================
// The gate: script_http_fetch
// ============================================================================

/// Whether a request header name is a credential header that must never be
/// forwarded (case-insensitive).
fn is_credential_header(name: &str) -> bool {
    name.eq_ignore_ascii_case("authorization") || name.eq_ignore_ascii_case("cookie")
}

#[tauri::command]
pub async fn script_http_fetch(
    cap_store: State<'_, CapabilityStore>,
    app_state: State<'_, AppState>,
    request: HttpFetchRequest,
    window: Window,
) -> Result<HttpFetchResponse, String> {
    // (a) window guard — main window only.
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;

    let script_id = request.script_id.clone();

    // (b) Parse + scheme/userinfo checks. https only.
    let parsed = match parse_url(&request.url) {
        Ok(p) => p,
        Err(e) => {
            log_warn!(
                "SECURITY",
                "script_http_fetch DENIED (unparseable url): script={} url={} reason={}",
                script_id,
                request.url,
                e
            );
            return Err(format!("PermissionDenied: invalid URL ({})", e));
        }
    };
    if parsed.scheme != "https" {
        log_warn!(
            "SECURITY",
            "script_http_fetch DENIED (non-https): script={} url={}",
            script_id,
            request.url
        );
        return Err("PermissionDenied: only https is allowed".to_string());
    }
    if parsed.has_userinfo {
        log_warn!(
            "SECURITY",
            "script_http_fetch DENIED (userinfo present): script={} url={}",
            script_id,
            request.url
        );
        return Err("PermissionDenied: URL must not contain credentials".to_string());
    }

    // (c) Re-derive origin and check the STORE, never the request.
    let origin = normalize_origin(&parsed);
    if !cap_store.is_net_origin_granted(&script_id, &origin) {
        log_warn!(
            "SECURITY",
            "script_http_fetch DENIED (origin not granted): script={} origin={} url={}",
            script_id,
            origin,
            request.url
        );
        record_capability_call(&app_state.audit_log, "net.fetch", &script_id, false, Some(&origin), Some("origin not granted"));
        return Err(format!("PermissionDenied: net.fetch not granted for {}", origin));
    }

    // (d) Rate limit: 10/min/script.
    if let Err(e) = cap_store.check_and_record_rate(&script_id, MAX_FETCH_PER_MIN) {
        log_warn!(
            "SECURITY",
            "script_http_fetch DENIED (rate limited): script={} origin={}",
            script_id,
            origin
        );
        record_capability_call(&app_state.audit_log, "net.fetch", &script_id, false, Some(&origin), Some("rate limited"));
        return Err(e);
    }

    // (e) Method allowlist.
    let method_str = request
        .method
        .as_deref()
        .unwrap_or("GET")
        .to_ascii_uppercase();
    let method = match method_str.as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        "HEAD" => reqwest::Method::HEAD,
        other => {
            log_warn!(
                "SECURITY",
                "script_http_fetch DENIED (method not allowed): script={} method={} url={}",
                script_id,
                other,
                request.url
            );
            return Err(format!("PermissionDenied: method {} is not allowed", other));
        }
    };

    // (f) Per-call client: 30s timeout, NO redirects, NO cookie jar.
    // The `cookies` reqwest feature is NOT enabled (see Cargo.toml), so the
    // client has no cookie store at all — there is nothing to disable and no
    // `.cookie_store(...)` builder method exists. This is strictly stronger
    // than `.cookie_store(false)`: a cookie jar cannot be constructed.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("HostError: {}", e))?;

    let mut builder = client.request(method, &request.url);

    // (g) Apply caller headers, but NEVER forward Authorization / Cookie.
    if let Some(headers) = &request.headers {
        for (name, value) in headers {
            if is_credential_header(name) {
                continue;
            }
            builder = builder.header(name, value);
        }
    }

    // (h) Attach body if present and send.
    if let Some(body) = request.body {
        builder = builder.body(body);
    }

    let resp = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            log_warn!(
                "SECURITY",
                "script_http_fetch ERROR (send failed): script={} url={} err={}",
                script_id,
                request.url,
                e
            );
            return Err(format!("HostError: {}", e));
        }
    };

    let status = resp.status().as_u16();

    // (j) Collect response headers (drop set-cookie).
    let mut out_headers: HashMap<String, String> = HashMap::new();
    for (name, value) in resp.headers().iter() {
        if name.as_str().eq_ignore_ascii_case("set-cookie") {
            continue;
        }
        if let Ok(v) = value.to_str() {
            out_headers.insert(name.as_str().to_string(), v.to_string());
        }
    }

    // (i) Read the body with a 5 MB cap by streaming chunks. `Response::chunk`
    // is an inherent reqwest method (no external Stream trait needed), giving
    // the same bounded-streaming semantics as `bytes_stream()` without pulling
    // in `futures-util` (not a direct dependency). Abort once the cap is passed.
    let mut buf: Vec<u8> = Vec::new();
    let mut resp = resp;
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                if buf.len() + chunk.len() > MAX_RESPONSE_BYTES {
                    log_warn!(
                        "SECURITY",
                        "script_http_fetch ABORTED (response too large): script={} url={} status={}",
                        script_id,
                        request.url,
                        status
                    );
                    return Err("ResponseTooLarge: exceeds 5MB".to_string());
                }
                buf.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(e) => {
                log_warn!(
                    "SECURITY",
                    "script_http_fetch ERROR (body read failed): script={} url={} err={}",
                    script_id,
                    request.url,
                    e
                );
                return Err(format!("HostError: {}", e));
            }
        }
    }

    let body = String::from_utf8_lossy(&buf).into_owned();

    // (k) Audit success — debug log + the persisted per-workbook trail (origin
    // only, never the full URL/query).
    log_info!(
        "SECURITY",
        "script_http_fetch OK: script={} method={} url={} status={} bytes={}",
        script_id,
        method_str,
        request.url,
        status,
        buf.len()
    );
    record_capability_call(&app_state.audit_log, "net.fetch", &script_id, true, Some(&origin), None);

    Ok(HttpFetchResponse {
        status,
        headers: out_headers,
        body,
    })
}
