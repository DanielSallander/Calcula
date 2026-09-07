//! FILENAME: app/src-tauri/src/ai/mod.rs
//! PURPOSE: The AI chat backend: a provider registry, per-provider key storage,
//!          local-runtime discovery, model listing, and one provider-aware
//!          completion command.
//! CONTEXT: Replaces the single-vendor `ai_chat.rs`. That module hardcoded the
//!          endpoint, ONE credential slot (`Calcula:aikey|anthropic`), Anthropic's
//!          auth headers and an Opus-only `thinking` flag — and the extension
//!          built Anthropic's JSON itself, so "use a different model" was a
//!          rewrite rather than a setting. Worse, the model was not selectable
//!          even within Anthropic: `ai_chat_complete` took a `model` parameter
//!          the caller never passed, so every request in the product was
//!          `claude-opus-4-8`.
//!
//! SECURITY: keys live in the Windows Credential Manager (DPAPI, login-bound),
//!          one slot per provider, never returned to JS, never logged, never
//!          written to the workbook. Cloud calls use a dedicated reqwest path —
//!          NOT the sandboxed `script_http_fetch`, which strips auth headers.
//!          Local providers are loopback-only by construction (asserted in
//!          providers.rs), so selecting one means nothing leaves the machine.

pub mod discovery;
pub mod dryrun;
pub mod preview_eval;
pub mod providers;
pub mod stream;
pub mod tools;
pub mod wire;

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use serde_json::Value;
use windows::core::PWSTR;
use windows::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_FLAGS,
    CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
};

use providers::{ProviderDef, ProviderKind};
use wire::{ChatRequest, ChatResponse};

const ANTHROPIC_VERSION: &str = "2023-06-01";
/// How long one completion may take, end to end.
///
/// WAS 180, AND THAT WAS TOO SHORT. Reported 2026-08-24 driving the guided
/// authoring loop against a local qwen3.5:9b: attempt 1 took 1m12s, attempt 2
/// started, and the run died at exactly 4m12s — 180 seconds later, to the
/// second. A repair round is the WORST case for this budget, because its prompt
/// carries the API surface AND the previous attempt AND the errors, so it is
/// several times the size of the first, on a model that is already the slowest
/// thing in the system.
///
/// Ten minutes is chosen against the machine this was measured on rather than
/// against a feeling: a 9B on CPU at the observed rate needs low single-digit
/// minutes for a long repair prompt, and a cloud model never comes close to any
/// of this. The cost of the ceiling being too HIGH is that a genuinely wedged
/// request holds one slot for longer — and Stop already exists for that, which
/// is what makes the generous number affordable.
const REQUEST_TIMEOUT_SECS: u64 = 600;
/// How long to wait for the TCP/TLS handshake alone.
///
/// Separate from the overall timeout because the two failures are nothing alike.
/// "Ollama is not running" is answerable in milliseconds on loopback, and it used
/// to present as the chat sitting silent for the full three minutes — the single
/// worst case of the dead air this module now reports on. A generous ten seconds
/// still covers a cold cloud TLS handshake on a bad connection.
const CONNECT_TIMEOUT_SECS: u64 = 10;

/// Turn a reqwest failure into something that names what actually went wrong.
///
/// WHY THIS EXISTS. `format!("{}", e)` on a `reqwest::Error` renders only the
/// OUTERMOST layer — "error sending request for url (http://127.0.0.1:11434/...)"
/// — and drops the source chain that says *why*. So a request that hit the
/// timeout reported the same sentence as one that could not connect at all. The
/// reporter on 2026-08-24 reasonably read that as a server problem, went to the
/// URL in a browser, got `405 method not allowed` (which is CORRECT: the
/// endpoint is POST-only and a browser sends GET) and was sent hunting a bug
/// that did not exist. The real cause was the 180-second ceiling above.
///
/// `is_timeout()` / `is_connect()` are asked instead of matching on a string,
/// because they are reqwest's own classification; the chain is walked after so
/// nothing is hidden regardless.
///
/// THE ORDER IS LOAD-BEARING, and the obvious order is wrong. Both flags can be
/// TRUE at once: on Windows a connection to a dead port does not get refused,
/// it stalls until `CONNECT_TIMEOUT_SECS` elapses, and reqwest then reports
/// `is_connect() && is_timeout()`. Asking about the timeout first told the user
/// "the model did not answer within 600 seconds" about a request that gave up
/// after ten — naming the wrong number, the wrong stage and the wrong fix. This
/// was caught by the test below, which is why it drives a real socket rather
/// than a hand-built error: a fabricated one would only have proved that my
/// model of reqwest agreed with itself.
fn describe_request_error(label: &str, url: &str, e: &reqwest::Error) -> String {
    let cause = error_chain(e);
    if e.is_connect() {
        return format!(
            "Could not reach {} at {} (gave up after {} seconds). Check the runtime is running \
             and the base URL is right. ({})",
            label, url, CONNECT_TIMEOUT_SECS, cause,
        );
    }
    if e.is_timeout() {
        return format!(
            "{} accepted the request but did not answer within {} seconds. A local model writing \
             a long script can legitimately need minutes — the connection was still open when \
             Calcula gave up, so this is slowness, not a server that is down. Try a smaller task, \
             a faster model, or check the runtime is not swapping. ({})",
            label, REQUEST_TIMEOUT_SECS, cause,
        );
    }
    format!("Request to {} failed: {}", label, cause)
}

/// Every layer of an error, outermost first.
///
/// `std::error::Error::source` is a chain and Display shows one link of it. A
/// timeout arrives as `Request -> TimedOut`, and the second link is the entire
/// information content.
fn error_chain(e: &dyn std::error::Error) -> String {
    let mut parts = vec![e.to_string()];
    let mut cursor = e.source();
    // Bounded: a cyclic source chain would otherwise hang the formatter, and
    // nothing here is worth trusting to be acyclic.
    while let Some(next) = cursor {
        let text = next.to_string();
        if !parts.contains(&text) {
            parts.push(text);
        }
        if parts.len() >= 6 {
            break;
        }
        cursor = next.source();
    }
    parts.join(": ")
}

fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

// ---------------------------------------------------------------------------
// Per-provider key storage
// ---------------------------------------------------------------------------

fn set_key(target: &str, key: &str) -> Result<(), String> {
    let secret = key.as_bytes();
    let mut target_wide = to_wide(target);
    let mut user_wide = to_wide("calcula-ai"); // label only, never the key
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

fn get_key(target: &str) -> Option<String> {
    let target_wide = to_wide(target);
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
                let blob =
                    std::slice::from_raw_parts(cred.CredentialBlob, cred.CredentialBlobSize as usize);
                let secret = String::from_utf8_lossy(blob).to_string();
                CredFree(cred_ptr as *const std::ffi::c_void);
                Some(secret)
            }
            Err(_) => None,
        }
    }
}

fn delete_key(target: &str) {
    let target_wide = to_wide(target);
    unsafe {
        let _ = CredDeleteW(
            windows::core::PCWSTR(target_wide.as_ptr()),
            CRED_TYPE_GENERIC,
            None,
        );
    }
}

// ---------------------------------------------------------------------------
// Commands: registry + keys
// ---------------------------------------------------------------------------

/// One row of the model picker: the provider plus whether it is usable NOW.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    #[serde(flatten)]
    pub def: ProviderDef,
    /// A key is stored for it. Always true for a provider needing none.
    pub has_key: bool,
}

#[tauri::command]
pub fn ai_providers_list(window: tauri::Window) -> Result<Vec<ProviderStatus>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    Ok(providers::registry()
        .into_iter()
        .map(|def| {
            let has_key = !def.requires_key || get_key(&providers::credential_target(&def.id)).is_some();
            ProviderStatus { def, has_key }
        })
        .collect())
}

#[tauri::command]
pub fn ai_provider_set_key(provider_id: String, key: String, window: tauri::Window) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err("API key is empty.".to_string());
    }
    providers::find(&provider_id).ok_or_else(|| format!("Unknown provider '{}'.", provider_id))?;
    set_key(&providers::credential_target(&provider_id), trimmed)
}

#[tauri::command]
pub fn ai_provider_has_key(provider_id: String, window: tauri::Window) -> Result<bool, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    Ok(get_key(&providers::credential_target(&provider_id)).is_some())
}

#[tauri::command]
pub fn ai_provider_delete_key(provider_id: String, window: tauri::Window) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    delete_key(&providers::credential_target(&provider_id));
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands: discovery + models
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn ai_discover_local_runtimes(
    window: tauri::Window,
) -> Result<Vec<discovery::DiscoveredRuntime>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    Ok(discovery::discover().await)
}

#[tauri::command]
pub async fn ai_list_models(
    provider_id: String,
    base_url_override: Option<String>,
    window: tauri::Window,
) -> Result<Vec<String>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let def = providers::find(&provider_id)
        .ok_or_else(|| format!("Unknown provider '{}'.", provider_id))?;
    let base = resolve_base(&def, base_url_override.as_deref())?;
    let key = get_key(&providers::credential_target(&provider_id));
    discovery::list_models(&def, &base, key.as_deref()).await
}

// ---------------------------------------------------------------------------
// Command: completion
// ---------------------------------------------------------------------------

fn resolve_base(def: &ProviderDef, override_url: Option<&str>) -> Result<String, String> {
    let base = override_url
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or(def.base_url.as_str());
    if base.is_empty() {
        return Err(format!(
            "{} needs a base URL. Set one in the model picker.",
            def.label
        ));
    }
    Ok(base.trim_end_matches('/').to_string())
}

/// Send one turn to the selected provider and return Calcula's normalized shape.
///
/// The provider is named by the CALLER on every request: the backend keeps no
/// selected-model state at all. That is deliberate — the choice is a user
/// preference, not document state, so it lives in extension settings and can
/// never be written into a `.cala` where opening a colleague's workbook would
/// silently repoint the AI at a model you have no key for.
#[tauri::command]
pub async fn ai_chat_complete(
    request: ChatRequest,
    base_url_override: Option<String>,
    window: tauri::Window,
) -> Result<ChatResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;

    let def = providers::find(&request.provider_id)
        .ok_or_else(|| format!("Unknown provider '{}'.", request.provider_id))?;
    let base = resolve_base(&def, base_url_override.as_deref())?;

    if request.model.trim().is_empty() {
        return Err(format!("No model selected for {}.", def.label));
    }

    let key = get_key(&providers::credential_target(&def.id));
    if def.requires_key && key.is_none() {
        return Err(format!(
            "No API key stored for {}. Add one in the AI Chat panel.",
            def.label
        ));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let (url, body) = match def.kind {
        ProviderKind::Anthropic => (
            format!("{}/v1/messages", base),
            wire::anthropic_request_body(&request),
        ),
        ProviderKind::OpenAiCompat => (
            format!("{}/chat/completions", base),
            wire::openai_request_body(&request),
        ),
    };

    let mut req = client.post(&url).header("content-type", "application/json");
    req = match def.kind {
        ProviderKind::Anthropic => {
            let k = key.expect("checked above: anthropic requires a key");
            req.header("anthropic-version", ANTHROPIC_VERSION).header("x-api-key", k)
        }
        ProviderKind::OpenAiCompat => match key {
            Some(k) => req.header("authorization", format!("Bearer {}", k)),
            // A local runtime takes no key, and sending an empty Bearer header
            // makes some of them 401 rather than ignore it.
            None => req,
        },
    };

    let resp = req
        .json(&body)
        .send()
        .await
        .map_err(|e| describe_request_error(&def.label, &url, &e))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("Reading the {} response failed: {}", def.label, e))?;
    if !status.is_success() {
        return Err(format!("{} error {}: {}", def.label, status.as_u16(), text));
    }
    let raw: Value = serde_json::from_str(&text)
        .map_err(|e| format!("Parsing the {} response failed: {}", def.label, e))?;

    let parsed = match def.kind {
        ProviderKind::Anthropic => wire::anthropic_parse_response(&raw)?,
        ProviderKind::OpenAiCompat => wire::openai_parse_response(&raw)?,
    };
    // A schema-constrained request to Anthropic comes back as a forced TOOL
    // CALL. Unwrapping it here means a caller reads JSON text whichever vendor
    // answered, and needs to know nothing about the difference.
    Ok(wire::normalize_schema_response(&request, parsed))
}

// ---------------------------------------------------------------------------
// Command: streaming completion
// ---------------------------------------------------------------------------

/// The event name every stream chunk is emitted on.
///
/// One channel with a `streamId` rather than a per-stream event name: Tauri
/// listeners are global, so a name-per-stream would leak a listener per turn and
/// the frontend would have to unregister precisely. A correlation id in the
/// payload is the same information with none of that.
pub const AI_STREAM_EVENT: &str = "ai:chat-stream";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamEnvelope<'a> {
    stream_id: &'a str,
    #[serde(flatten)]
    event: &'a stream::StreamEvent,
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

/// Stream ids the user has asked to stop.
///
/// A process-global set rather than managed state, for the same reason the draft
/// queue is: this is transport bookkeeping that outlives nothing, persists
/// nowhere, and has no business in the workbook's state graph. Ids are removed
/// when observed, so the set holds only the requests in flight.
fn cancelled_streams() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static CANCELLED: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    CANCELLED.get_or_init(Default::default)
}

/// Consume a cancellation request. True exactly once per `ai_chat_cancel_stream`.
fn take_cancel(stream_id: &str) -> bool {
    cancelled_streams()
        .lock()
        .map(|mut s| s.remove(stream_id))
        .unwrap_or(false)
}

/// Ask a streaming turn to stop at its next chunk boundary.
///
/// HONEST ABOUT WHAT IT DOES. This aborts Calcula's side: the response body is
/// dropped, the partial answer is discarded rather than fed back to the model as
/// though the turn had finished, and the UI is freed. It does NOT reach into the
/// provider — a local runtime keeps generating until it notices the closed
/// socket, and a cloud vendor has already been billed. The UI says so.
///
/// Checked at chunk boundaries, which is where a wedged turn actually sits: a
/// model producing tokens slowly, or an agentic loop the user has changed their
/// mind about. A request that has not yet connected is covered by
/// `CONNECT_TIMEOUT_SECS` instead.
///
/// No `DocumentEffect`: nothing persisted changes.
#[tauri::command]
pub fn ai_chat_cancel_stream(stream_id: String, window: tauri::Window) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    cancelled_streams()
        .lock()
        .map_err(|e| e.to_string())?
        .insert(stream_id);
    Ok(())
}

/// The message a cancelled turn fails with. Matched by the frontend so it can be
/// shown as a neutral status line rather than as an error the user must worry
/// about.
pub const STREAM_CANCELLED: &str = "The turn was stopped.";

/// Stream one turn, emitting deltas as they arrive and returning the same
/// `ChatResponse` the non-streaming command returns.
///
/// The RETURN VALUE is what the agentic loop uses; the events are for the eye.
/// That split is deliberate: it keeps streaming a transport detail rather than a
/// second conversation implementation, so a provider that cannot stream (or a
/// user who turns it off) changes nothing about how the loop behaves.
#[tauri::command]
pub async fn ai_chat_complete_stream(
    app: AppHandle,
    request: ChatRequest,
    stream_id: String,
    base_url_override: Option<String>,
    window: tauri::Window,
) -> Result<ChatResponse, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;

    let def = providers::find(&request.provider_id)
        .ok_or_else(|| format!("Unknown provider '{}'.", request.provider_id))?;
    let base = resolve_base(&def, base_url_override.as_deref())?;
    if request.model.trim().is_empty() {
        return Err(format!("No model selected for {}.", def.label));
    }
    let key = get_key(&providers::credential_target(&def.id));
    if def.requires_key && key.is_none() {
        return Err(format!(
            "No API key stored for {}. Add one in the AI Chat panel.",
            def.label
        ));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .connect_timeout(std::time::Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let (url, mut body) = match def.kind {
        ProviderKind::Anthropic => (
            format!("{}/v1/messages", base),
            wire::anthropic_request_body(&request),
        ),
        ProviderKind::OpenAiCompat => (
            format!("{}/chat/completions", base),
            wire::openai_request_body(&request),
        ),
    };
    body["stream"] = Value::Bool(true);

    let mut req = client
        .post(&url)
        .header("content-type", "application/json")
        .header("accept", "text/event-stream");
    req = match def.kind {
        ProviderKind::Anthropic => {
            let k = key.expect("checked above: anthropic requires a key");
            req.header("anthropic-version", ANTHROPIC_VERSION).header("x-api-key", k)
        }
        ProviderKind::OpenAiCompat => match key {
            Some(k) => req.header("authorization", format!("Bearer {}", k)),
            None => req,
        },
    };

    // DECLARED BEFORE THE SEND, not after it. This closure used to be defined
    // below the request, which meant the earliest event of any kind reached the
    // UI from inside the chunk loop — everything before the first token was a
    // literal "…" with no way to tell a loading model from a dead runtime.
    let emit = |event: &stream::StreamEvent| {
        let _ = app.emit(
            AI_STREAM_EVENT,
            StreamEnvelope { stream_id: &stream_id, event },
        );
    };

    // Last thing the user hears if the runtime is unreachable, so it names the
    // endpoint that was tried.
    emit(&stream::StreamEvent::Requested {
        model: request.model.clone(),
        endpoint: url.clone(),
    });

    let mut resp = req
        .json(&body)
        .send()
        .await
        .map_err(|e| describe_request_error(&def.label, &url, &e))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("{} error {}: {}", def.label, status.as_u16(), text));
    }

    // Accepted. The gap between here and the first TextDelta is the model
    // thinking or loading — on a cold local model, minutes of it.
    emit(&stream::StreamEvent::Opened { status: status.as_u16() });

    let mut decoder = stream::SseDecoder::new();
    let mut acc = stream::StreamAccumulator::new();
    let mut failure: Option<String> = None;

    // A cancellation that arrived while the request was in flight, before a
    // single chunk landed, must still be honoured.
    if take_cancel(&stream_id) {
        return Err(STREAM_CANCELLED.to_string());
    }

    // `Response::chunk` rather than `bytes_stream()`, matching net_commands.rs:
    // it is an inherent reqwest method, so no external Stream trait and no
    // futures-util (not a direct dependency of this crate).
    loop {
        // Between chunks, which is where a wedged turn sits. Dropping `resp`
        // closes the body; the partial answer is DISCARDED rather than returned,
        // because a partial turn fed back to the model as complete is the
        // silent-corruption case `Failed` exists to prevent.
        if take_cancel(&stream_id) {
            return Err(STREAM_CANCELLED.to_string());
        }
        match resp.chunk().await {
            Ok(Some(bytes)) => {
                for frame in decoder.push(&bytes) {
                    if stream::is_done_sentinel(&frame.data) {
                        continue;
                    }
                    let Some(payload) = stream::frame_json(&frame.data) else {
                        continue;
                    };
                    let events = match def.kind {
                        ProviderKind::Anthropic => {
                            stream::push_anthropic(&mut acc, &frame.event, &payload)
                        }
                        ProviderKind::OpenAiCompat => stream::push_openai(&mut acc, &payload),
                    };
                    for event in &events {
                        if let stream::StreamEvent::Failed { message } = event {
                            failure = Some(message.clone());
                        }
                        emit(event);
                    }
                }
            }
            Ok(None) => break,
            Err(e) => {
                // A mid-stream transport failure must NOT be reported as a
                // finished turn: the partial answer would be fed back to the
                // model as if it were complete.
                let message = format!("Stream from {} failed: {}", def.label, e);
                emit(&stream::StreamEvent::Failed { message: message.clone() });
                return Err(message);
            }
        }
    }

    // A stop that raced the last chunk still stops: returning a finished turn
    // the user has just abandoned would append an answer under their Stop click.
    // This also drops the id, so a request that arrives at the very end cannot
    // sit in the set forever.
    if take_cancel(&stream_id) {
        return Err(STREAM_CANCELLED.to_string());
    }

    if let Some(message) = failure {
        return Err(message);
    }

    // Normalized BEFORE the Done event, so a streamed schema reply and a
    // buffered one are the same shape to every listener.
    let response = wire::normalize_schema_response(&request, acc.finish());
    emit(&stream::StreamEvent::Done { response: response.clone() });
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stream_envelope_carries_the_correlation_id_beside_the_event() {
        // Flattened, so the frontend reads `{ streamId, type, text }` rather
        // than having to unwrap a nested event object.
        let event = stream::StreamEvent::TextDelta { text: "hi".into() };
        let v = serde_json::to_value(StreamEnvelope { stream_id: "s1", event: &event }).unwrap();
        assert_eq!(v["streamId"], serde_json::json!("s1"));
        assert_eq!(v["type"], serde_json::json!("textDelta"));
        assert_eq!(v["text"], serde_json::json!("hi"));
    }

    #[test]
    fn a_base_url_override_wins_and_trailing_slashes_are_trimmed() {
        let def = providers::find("ollama").unwrap();
        assert_eq!(resolve_base(&def, Some("http://127.0.0.1:9999/v1/")).unwrap(), "http://127.0.0.1:9999/v1");
        assert_eq!(resolve_base(&def, None).unwrap(), "http://127.0.0.1:11434/v1");
        // Blank is not an override; it falls back rather than producing "".
        assert_eq!(resolve_base(&def, Some("   ")).unwrap(), "http://127.0.0.1:11434/v1");
    }

    #[test]
    fn a_cancel_request_is_observed_exactly_once() {
        // The set must not hold an id after it has been acted on, or the NEXT
        // turn with a recycled id would stop before it started.
        let id = "s-cancel-once";
        assert!(!take_cancel(id), "nothing pending to begin with");
        cancelled_streams().lock().unwrap().insert(id.to_string());
        assert!(take_cancel(id), "the pending request is observed");
        assert!(!take_cancel(id), "and only once");
    }

    #[test]
    fn cancelling_one_stream_does_not_stop_another() {
        // Two panes, or a turn racing one the user just abandoned.
        cancelled_streams().lock().unwrap().insert("s-a".to_string());
        assert!(!take_cancel("s-b"), "an unrelated turn must be untouched");
        assert!(take_cancel("s-a"));
    }

    #[test]
    fn the_cancelled_message_is_the_one_the_frontend_matches() {
        // Shown as a neutral status line rather than an error, so the string is
        // part of the contract with ChatView.
        assert_eq!(STREAM_CANCELLED, "The turn was stopped.");
    }

    #[test]
    fn the_connect_timeout_is_far_shorter_than_the_request_timeout() {
        // "Ollama is not running" used to present as three minutes of silence.
        assert!(CONNECT_TIMEOUT_SECS < REQUEST_TIMEOUT_SECS / 10);
    }

    #[test]
    fn the_request_budget_survives_a_slow_local_repair_round() {
        // Measured 2026-08-24: qwen3.5:9b on CPU took 1m12s for a FIRST attempt.
        // A repair round carries the API surface, the previous attempt and the
        // errors, so it is several times that prompt on the same model — and the
        // old 180s ceiling killed exactly that request, at 4m12s on the nose.
        assert!(
            REQUEST_TIMEOUT_SECS >= 480,
            "a repair round on a local model needs minutes, not seconds",
        );
    }

    /// A real reqwest timeout, produced by a socket that accepts and never
    /// answers. Asserting against a HAND-BUILT error would only prove that my
    /// model of reqwest matches itself — and my model of it is exactly what was
    /// wrong: `{}` on the error hides the cause, which is why a timeout read as
    /// a connection failure.
    #[tokio::test]
    async fn a_timeout_is_reported_as_a_timeout_and_not_as_a_dead_server() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        // Accept and hold: no response is ever written, so the client can only
        // end this by timing out.
        tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                // Held for the life of the task; dropping it would let the
                // client see a clean close instead of a stall.
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                drop(stream);
            }
        });

        let url = format!("http://{}/v1/chat/completions", addr);
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(400))
            .connect_timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap();
        let err = client
            .post(&url)
            .json(&serde_json::json!({ "hello": "world" }))
            .send()
            .await
            .expect_err("a server that never answers must not produce a response");

        assert!(err.is_timeout(), "reqwest should classify this as a timeout");
        assert!(!err.is_connect(), "the connection itself SUCCEEDED");

        let message = describe_request_error("Ollama", &url, &err);
        assert!(message.contains("did not answer within"), "got: {}", message);
        assert!(
            !message.contains("Could not reach"),
            "a slow answer must never be reported as an unreachable server: {}",
            message,
        );
        // And the underlying cause survives, which plain Display drops.
        assert!(
            message.to_lowercase().contains("timed out") || message.to_lowercase().contains("timeout"),
            "the cause must not be swallowed: {}",
            message,
        );
    }

    /// An unreachable endpoint must be reported as unreachable, even though
    /// reqwest ALSO marks it as a timeout.
    ///
    /// THE CASE THAT CORRECTED THE IMPLEMENTATION. On Windows a connection to a
    /// dead port is not refused — it stalls until the CONNECT timeout elapses,
    /// and the resulting error has `is_connect()` AND `is_timeout()` both true.
    /// Checking the timeout first (the obvious order) produced "the model did
    /// not answer within 600 seconds" for a request that gave up after two:
    /// wrong number, wrong stage, wrong fix.
    #[tokio::test]
    async fn an_unreachable_endpoint_is_not_reported_as_a_slow_model() {
        let url = "http://127.0.0.1:1/v1/chat/completions";
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .connect_timeout(std::time::Duration::from_secs(1))
            .build()
            .unwrap();
        let err = client
            .post(url)
            .json(&serde_json::json!({}))
            .send()
            .await
            .expect_err("nothing listens on port 1");

        assert!(err.is_connect(), "expected a connect failure, got: {}", err);
        let message = describe_request_error("Ollama", url, &err);
        assert!(message.contains("Could not reach Ollama"), "got: {}", message);
        assert!(message.contains(url), "the URL is what the user has to check: {}", message);
        assert!(
            !message.contains("did not answer within"),
            "a connect failure must not quote the RESPONSE budget: {}",
            message,
        );
    }

    #[test]
    fn the_error_chain_keeps_every_layer_and_terminates() {
        #[derive(Debug)]
        struct Layer(&'static str, Option<Box<Layer>>);
        impl std::fmt::Display for Layer {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "{}", self.0)
            }
        }
        impl std::error::Error for Layer {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                self.1.as_deref().map(|l| l as &(dyn std::error::Error + 'static))
            }
        }

        let e = Layer("outer", Some(Box::new(Layer("middle", Some(Box::new(Layer("inner", None)))))));
        assert_eq!(error_chain(&e), "outer: middle: inner");

        // A duplicated message is not repeated — several reqwest layers stringify
        // identically and "x: x: x" tells the reader nothing.
        let dup = Layer("same", Some(Box::new(Layer("same", None))));
        assert_eq!(error_chain(&dup), "same");
    }

    #[test]
    fn the_custom_provider_refuses_to_run_without_a_base_url() {
        let def = providers::find("custom-openai").unwrap();
        let err = resolve_base(&def, None).expect_err("no base url must be an error, not a request to \"\"");
        assert!(err.contains("base URL"), "got: {}", err);
        assert!(resolve_base(&def, Some("https://example.test/v1")).is_ok());
    }
}
