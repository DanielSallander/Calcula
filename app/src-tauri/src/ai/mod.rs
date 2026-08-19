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
/// Cloud round trips can be slow; a local model on a cold load can be slower.
const REQUEST_TIMEOUT_SECS: u64 = 180;

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
        .map_err(|e| format!("Request to {} failed: {}", def.label, e))?;

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

    match def.kind {
        ProviderKind::Anthropic => wire::anthropic_parse_response(&raw),
        ProviderKind::OpenAiCompat => wire::openai_parse_response(&raw),
    }
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

    let mut resp = req
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request to {} failed: {}", def.label, e))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("{} error {}: {}", def.label, status.as_u16(), text));
    }

    let mut decoder = stream::SseDecoder::new();
    let mut acc = stream::StreamAccumulator::new();
    let mut failure: Option<String> = None;

    let emit = |event: &stream::StreamEvent| {
        let _ = app.emit(
            AI_STREAM_EVENT,
            StreamEnvelope { stream_id: &stream_id, event },
        );
    };

    // `Response::chunk` rather than `bytes_stream()`, matching net_commands.rs:
    // it is an inherent reqwest method, so no external Stream trait and no
    // futures-util (not a direct dependency of this crate).
    loop {
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

    if let Some(message) = failure {
        return Err(message);
    }

    let response = acc.finish();
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
    fn the_custom_provider_refuses_to_run_without_a_base_url() {
        let def = providers::find("custom-openai").unwrap();
        let err = resolve_base(&def, None).expect_err("no base url must be an error, not a request to \"\"");
        assert!(err.contains("base URL"), "got: {}", err);
        assert!(resolve_base(&def, Some("https://example.test/v1")).is_ok());
    }
}
