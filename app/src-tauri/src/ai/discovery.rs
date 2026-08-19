//! FILENAME: app/src-tauri/src/ai/discovery.rs
//! PURPOSE: Find an inference runtime already running on this machine, and list
//!          the models a provider can serve.
//! CONTEXT: §4a — Calcula ships no weights and compiles no GPU backend, so it
//!          has no hardware matrix to support. An M3 Max, a 5090, an Arc A770
//!          and a CPU-only laptop all present the same HTTP interface, and the
//!          user's runtime already solved layer offload. Discovery is therefore
//!          four loopback GETs, not a driver probe.
//!
//!          §11.1 — a runtime already running is the SILENT happy path: probe,
//!          offer its models, say nothing else. The "set up a local model" copy
//!          only appears when nothing answers.

use serde::Serialize;

use super::providers::{self, ProviderDef, ProviderKind};

/// Short on purpose: this runs on panel open, and a runtime that is not up
/// should cost the user a blink, not a spinner.
const PROBE_TIMEOUT_MS: u64 = 700;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredRuntime {
    pub provider_id: String,
    pub label: String,
    pub base_url: String,
    /// Models it reported. Empty means "answered, but listed nothing" — which is
    /// a real state for a freshly installed runtime with no model pulled yet,
    /// and the UI must say something different about it than "not found".
    pub models: Vec<String>,
}

fn client(timeout_ms: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))
}

/// Parse an OpenAI-style `{ "data": [ { "id": ... } ] }` model list.
///
/// Split out and unit-tested because every OpenAI-compatible runtime returns
/// this shape and a silent mis-parse would present the user an empty picker
/// while the runtime is plainly running.
pub fn parse_openai_models(raw: &serde_json::Value) -> Vec<String> {
    raw.get("data")
        .and_then(|d| d.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Probe every local provider in the registry, concurrently.
pub async fn discover() -> Vec<DiscoveredRuntime> {
    let locals: Vec<ProviderDef> = providers::registry().into_iter().filter(|p| p.is_local).collect();
    let Ok(http) = client(PROBE_TIMEOUT_MS) else {
        return Vec::new();
    };

    // Concurrent, not sequential: four probes at 700 ms each would cost 2.8 s
    // in the common case where nothing is installed, and this runs on panel
    // open. JoinSet rather than `futures::join_all` because `futures` is not a
    // dependency of this crate and tokio's `rt` feature already provides it.
    let mut set = tokio::task::JoinSet::new();
    for def in locals {
        let http = http.clone();
        set.spawn(async move {
            let url = format!("{}/models", def.base_url.trim_end_matches('/'));
            let resp = http.get(&url).send().await.ok()?;
            if !resp.status().is_success() {
                return None;
            }
            let raw: serde_json::Value = resp.json().await.ok()?;
            Some(DiscoveredRuntime {
                provider_id: def.id,
                label: def.label,
                base_url: def.base_url,
                models: parse_openai_models(&raw),
            })
        });
    }

    let mut found = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok(Some(runtime)) = joined {
            found.push(runtime);
        }
    }
    // Stable order regardless of which answered first, so the picker does not
    // reshuffle between openings.
    found.sort_by(|a, b| a.provider_id.cmp(&b.provider_id));
    found
}

/// List the models one provider can serve.
pub async fn list_models(
    def: &ProviderDef,
    base: &str,
    key: Option<&str>,
) -> Result<Vec<String>, String> {
    let http = client(10_000)?;
    let base = base.trim_end_matches('/');

    let (url, req) = match def.kind {
        ProviderKind::Anthropic => {
            let k = key.ok_or_else(|| format!("No API key stored for {}.", def.label))?;
            let url = format!("{}/v1/models", base);
            let r = http
                .get(&url)
                .header("anthropic-version", "2023-06-01")
                .header("x-api-key", k);
            (url, r)
        }
        ProviderKind::OpenAiCompat => {
            let url = format!("{}/models", base);
            let mut r = http.get(&url);
            if let Some(k) = key {
                r = r.header("authorization", format!("Bearer {}", k));
            }
            (url, r)
        }
    };

    let resp = req
        .send()
        .await
        .map_err(|e| format!("Could not reach {} at {}: {}", def.label, url, e))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("{} error {}: {}", def.label, status.as_u16(), text));
    }
    let raw: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("Parsing the model list failed: {}", e))?;

    let mut models = parse_openai_models(&raw);
    models.sort();
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_openai_style_model_list_parses() {
        let raw = json!({ "object": "list", "data": [
            { "id": "qwen3-coder:30b", "object": "model" },
            { "id": "llama3.3:70b", "object": "model" }
        ]});
        assert_eq!(parse_openai_models(&raw), vec!["qwen3-coder:30b", "llama3.3:70b"]);
    }

    #[test]
    fn a_runtime_with_no_models_parses_as_empty_rather_than_failing() {
        // Real state: a freshly installed Ollama with nothing pulled. It ANSWERED,
        // which is different from "not running", and the UI says different things
        // about the two.
        assert_eq!(parse_openai_models(&json!({ "object": "list", "data": [] })), Vec::<String>::new());
    }

    #[test]
    fn a_shape_we_do_not_recognize_yields_nothing_instead_of_panicking() {
        assert!(parse_openai_models(&json!({ "models": ["a"] })).is_empty());
        assert!(parse_openai_models(&json!(null)).is_empty());
        assert!(parse_openai_models(&json!({ "data": "not-an-array" })).is_empty());
        // An entry with no id is skipped, not rendered as an empty option.
        assert_eq!(parse_openai_models(&json!({ "data": [{ "object": "model" }, { "id": "ok" }] })), vec!["ok"]);
    }

    #[test]
    fn discovery_only_ever_probes_loopback() {
        // The privacy claim rests on this: "discover what is already running"
        // must never become an outbound request to a vendor.
        for def in providers::registry().into_iter().filter(|p| p.is_local) {
            assert!(def.base_url.starts_with("http://127.0.0.1:"), "{} is not loopback", def.id);
        }
    }
}
