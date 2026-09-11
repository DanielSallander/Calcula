//! FILENAME: app/src-tauri/src/ai/providers.rs
//! PURPOSE: The provider registry — who Calcula can talk to, how their wire
//!          format is spelled, and where their key lives.
//! CONTEXT: Owner decision 2026-08-19: the user picks the model. Any model, any
//!          vendor, local or cloud, VS-Code-Copilot style. Local is the DEFAULT
//!          because the workbook never leaves the machine, never a cage.
//!
//!          `openai_compat` is the workhorse and is why this list is cheap: one
//!          request/response translation reaches every local runtime AND most
//!          cloud vendors. Anthropic keeps a native impl for thinking-block and
//!          prompt-caching fidelity the compat shim flattens — that is WIRE
//!          FIDELITY, not preferential placement. A user who only ever points at
//!          a local endpoint or at OpenRouter loses nothing that matters to
//!          script authoring.
//!
//!          Design: docs/design/local-model-script-authoring.md §7a.

use serde::{Deserialize, Serialize};

/// How a provider's HTTP wire is spelled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderKind {
    /// `POST {base}/v1/messages`, `x-api-key`, top-level `system`.
    Anthropic,
    /// `POST {base}/chat/completions`, `Authorization: Bearer`, system-as-message.
    OpenAiCompat,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDef {
    pub id: String,
    pub label: String,
    pub kind: ProviderKind,
    /// Base URL. For a local runtime this is the loopback default the user can
    /// override; for a cloud vendor it is fixed unless they run a proxy.
    pub base_url: String,
    /// Whether an API key is required. Local runtimes take none, which is the
    /// whole point: nothing to sign up for, nothing to leak.
    pub requires_key: bool,
    /// Runs on this machine. Drives the "your workbook never leaves" copy AND
    /// the first-run ordering (§11.1: lead with local).
    pub is_local: bool,
    /// One line for the picker.
    pub note: String,
}

/// The on-board runtime's provider id (Tier 1, 2026-09-10).
///
/// The one provider whose server CALCULA runs: `ai::runtime` starts the bundled
/// llama-server on a free loopback port the first time a completion needs it.
/// Its registry entry therefore carries a PLACEHOLDER base URL that nothing
/// ever sends to — `ai::base_for` swaps in the live port — and discovery
/// never probes it, because "already running" means nothing for a server we
/// start ourselves.
pub const BUILTIN_ID: &str = "calcula-builtin";
pub const BUILTIN_LABEL: &str = "Calcula built-in";
/// A loopback URL so the registry's own invariants hold; port 0 so a request
/// that reached it by mistake fails at once rather than hitting a stranger.
pub const BUILTIN_PLACEHOLDER_URL: &str = "http://127.0.0.1:0/v1";

/// Every provider Calcula ships knowing about.
///
/// This list is a CONVENIENCE, not a gate. `custom-openai` accepts any base URL,
/// so a vendor absent here is still reachable — the registry exists to spare the
/// user typing a URL, not to decide who they may talk to.
pub fn registry() -> Vec<ProviderDef> {
    let local = |id: &str, label: &str, port: u16, note: &str| ProviderDef {
        id: id.into(),
        label: label.into(),
        kind: ProviderKind::OpenAiCompat,
        base_url: format!("http://127.0.0.1:{}/v1", port),
        requires_key: false,
        is_local: true,
        note: note.into(),
    };
    let builtin = ProviderDef {
        id: BUILTIN_ID.into(),
        label: BUILTIN_LABEL.into(),
        kind: ProviderKind::OpenAiCompat,
        base_url: BUILTIN_PLACEHOLDER_URL.into(),
        requires_key: false,
        is_local: true,
        note: "Bundled with Calcula: a small model (Qwen2.5-Coder 1.5B, a 1.1 GB download the first \
               time) running on this computer's processor. Your workbook never leaves this machine."
            .into(),
    };
    let cloud = |id: &str, label: &str, base: &str, kind: ProviderKind, note: &str| ProviderDef {
        id: id.into(),
        label: label.into(),
        kind,
        base_url: base.into(),
        requires_key: true,
        is_local: false,
        note: note.into(),
    };

    vec![
        // ---- Local first, deliberately (§11.1) — and the one we ship first of all ----
        builtin,
        local("ollama", "Ollama", 11434, "Runs on this machine. Your workbook never leaves it."),
        local("lmstudio", "LM Studio", 1234, "Runs on this machine. Your workbook never leaves it."),
        local("llamacpp", "llama.cpp server", 8080, "Runs on this machine. Your workbook never leaves it."),
        local("vllm", "vLLM", 8000, "Runs on this machine or your own server."),
        // ---- Cloud ----
        cloud(
            "anthropic",
            "Anthropic",
            "https://api.anthropic.com",
            ProviderKind::Anthropic,
            "Claude models. Sends workbook content to Anthropic.",
        ),
        cloud(
            "openrouter",
            "OpenRouter",
            "https://openrouter.ai/api/v1",
            ProviderKind::OpenAiCompat,
            "One key, hundreds of models across most vendors.",
        ),
        cloud(
            "openai",
            "OpenAI",
            "https://api.openai.com/v1",
            ProviderKind::OpenAiCompat,
            "GPT models. Sends workbook content to OpenAI.",
        ),
        cloud(
            "custom-openai",
            "Custom (OpenAI-compatible)",
            "",
            ProviderKind::OpenAiCompat,
            "Any OpenAI-compatible endpoint. Set the base URL yourself.",
        ),
    ]
}

pub fn find(id: &str) -> Option<ProviderDef> {
    registry().into_iter().find(|p| p.id == id)
}

/// The Credential Manager target for one provider's key.
///
/// Was a single fixed const (`Calcula:aikey|anthropic`), which is why only ONE
/// vendor's key could be stored at a time — switching provider meant re-entering
/// a key you had already given. Per-provider targets let a user hold an
/// Anthropic key, an OpenRouter key and a local endpoint at once and switch
/// between them from the picker.
pub fn credential_target(provider_id: &str) -> String {
    format!("Calcula:aikey|{}", provider_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_provider_has_a_unique_id_and_a_usable_default() {
        let all = registry();
        let mut ids: Vec<&str> = all.iter().map(|p| p.id.as_str()).collect();
        ids.sort();
        let count = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), count, "provider ids must be unique");

        for p in &all {
            assert!(!p.label.is_empty(), "{} has no label", p.id);
            assert!(!p.note.is_empty(), "{} has no note for the picker", p.id);
            // Only the custom entry may ship without a base URL; every other
            // provider must be usable the moment it is selected.
            if p.id != "custom-openai" {
                assert!(!p.base_url.is_empty(), "{} has no base url", p.id);
            }
        }
    }

    #[test]
    fn local_providers_need_no_key_and_cloud_providers_do() {
        for p in registry() {
            assert_eq!(
                p.requires_key, !p.is_local,
                "{}: a local runtime must need no key, a cloud one must",
                p.id
            );
        }
    }

    #[test]
    fn local_providers_are_loopback_only() {
        // A "local" provider that pointed anywhere else would make the privacy
        // claim in its own note a lie.
        for p in registry().iter().filter(|p| p.is_local) {
            assert!(
                p.base_url.starts_with("http://127.0.0.1:"),
                "{} claims to be local but points at {}",
                p.id,
                p.base_url
            );
        }
    }

    #[test]
    fn the_registry_leads_with_local() {
        // §11.1: local is the default posture, so it must come first in the list
        // the picker renders.
        let all = registry();
        let first_cloud = all.iter().position(|p| !p.is_local).unwrap();
        let last_local = all.iter().rposition(|p| p.is_local).unwrap();
        assert!(last_local < first_cloud, "every local provider must precede every cloud one");
    }

    #[test]
    fn credential_targets_are_per_provider() {
        assert_eq!(credential_target("anthropic"), "Calcula:aikey|anthropic");
        assert_ne!(credential_target("anthropic"), credential_target("openrouter"));
        // Every registry entry gets its own slot, so no two can collide.
        let mut targets: Vec<String> = registry().iter().map(|p| credential_target(&p.id)).collect();
        let n = targets.len();
        targets.sort();
        targets.dedup();
        assert_eq!(targets.len(), n);
    }

    #[test]
    fn anthropic_is_the_only_native_wire_and_everything_else_is_compat() {
        // The claim §7a makes: one translation reaches every local runtime and
        // most cloud vendors. If this ever fails, that sentence needs revisiting.
        let native: Vec<String> = registry()
            .into_iter()
            .filter(|p| p.kind == ProviderKind::Anthropic)
            .map(|p| p.id)
            .collect();
        assert_eq!(native, vec!["anthropic".to_string()]);
    }

    #[test]
    fn find_resolves_known_ids_and_refuses_unknown_ones() {
        assert!(find("ollama").is_some());
        assert!(find("anthropic").is_some());
        assert!(find("not-a-provider").is_none());
    }

    #[test]
    fn the_builtin_provider_is_first_local_keyless_and_never_points_at_a_real_port() {
        let all = registry();
        let first = &all[0];
        assert_eq!(first.id, BUILTIN_ID, "the runtime we ship leads the list the picker renders");
        assert!(first.is_local);
        assert!(!first.requires_key);
        assert_eq!(first.kind, ProviderKind::OpenAiCompat, "it is llama-server: the compat wire");
        // Port 0: a request that bypassed `ai::base_for` fails immediately
        // instead of reaching whatever happens to listen on a real port.
        assert_eq!(first.base_url, BUILTIN_PLACEHOLDER_URL);
        assert!(first.base_url.starts_with("http://127.0.0.1:0/"));
        assert!(first.note.contains("1.1 GB"), "the note names the download before anyone clicks: {}", first.note);
        assert!(first.note.contains("never leaves"), "{}", first.note);
    }
}
