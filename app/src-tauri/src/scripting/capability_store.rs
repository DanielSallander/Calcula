//! FILENAME: app/src-tauri/src/scripting/capability_store.rs
//! PURPOSE: Authoritative, session-scoped backend store of per-script network
//!          capability grants + rate-limit state for `script_http_fetch`.
//! CONTEXT: docs/design/script-sandbox-architecture.md §8 (R9, the `net.fetch`
//!          enforcement row) and §11 (Phase 4). net.fetch origin grants are
//!          mirrored here on consent-grant from the main window, and re-checked
//!          in Rust on every request. This store NEVER trusts frontend-supplied
//!          permission and is the single source of truth for whether a script
//!          may reach a given origin.
//!
//! Persistence lives frontend-side (the consent / .cala store). This store is
//! in-memory only: it does NOT read or write disk. On unmount/revoke the
//! frontend calls `revoke_script` to drop the in-memory entry.
//!
//! The `url` crate is not a direct dependency of this crate (only transitive via
//! tauri), so origin parsing/normalization here is done manually from the raw
//! string rather than via `url::Url`. See `normalize_origin`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Rolling rate-limit window length.
const RATE_WINDOW: Duration = Duration::from_secs(60);

/// Per-script capability state.
#[derive(Default)]
struct ScriptCaps {
    /// Granted origins, normalized as "https://host[:port]" (default :443 omitted).
    net_origins: HashSet<String>,
    /// Recent fetch timestamps used for the rolling per-minute rate limit.
    fetch_calls: VecDeque<Instant>,
}

/// Authoritative in-memory store of per-script network grants and rate state.
pub struct CapabilityStore {
    scripts: Mutex<HashMap<String, ScriptCaps>>,
}

impl CapabilityStore {
    pub fn new() -> Self {
        CapabilityStore {
            scripts: Mutex::new(HashMap::new()),
        }
    }

    /// Grant `origin` (already normalized by the caller) to `script_id`.
    /// Creates the script's entry if it does not yet exist.
    pub fn grant_net_origin(&self, script_id: &str, origin: &str) {
        let mut scripts = self.scripts.lock().unwrap();
        let caps = scripts.entry(script_id.to_string()).or_default();
        caps.net_origins.insert(origin.to_string());
    }

    /// Remove a script's entry entirely. Called on unmount / revoke.
    pub fn revoke_script(&self, script_id: &str) {
        let mut scripts = self.scripts.lock().unwrap();
        scripts.remove(script_id);
    }

    /// Whether `script_id` has been granted `origin` (normalized).
    pub fn is_net_origin_granted(&self, script_id: &str, origin: &str) -> bool {
        let scripts = self.scripts.lock().unwrap();
        scripts
            .get(script_id)
            .map(|c| c.net_origins.contains(origin))
            .unwrap_or(false)
    }

    /// Purge timestamps older than 60s for `script_id`; if the remaining count
    /// is >= `max_per_min` return Err(RateLimited); otherwise record now and Ok.
    pub fn check_and_record_rate(&self, script_id: &str, max_per_min: usize) -> Result<(), String> {
        let now = Instant::now();
        let mut scripts = self.scripts.lock().unwrap();
        let caps = scripts.entry(script_id.to_string()).or_default();

        // Drop timestamps that have aged out of the rolling window.
        while let Some(front) = caps.fetch_calls.front() {
            if now.duration_since(*front) >= RATE_WINDOW {
                caps.fetch_calls.pop_front();
            } else {
                break;
            }
        }

        if caps.fetch_calls.len() >= max_per_min {
            return Err(format!(
                "RateLimited: more than {} fetches per minute for this script",
                max_per_min
            ));
        }

        caps.fetch_calls.push_back(now);
        Ok(())
    }
}

impl Default for CapabilityStore {
    fn default() -> Self {
        Self::new()
    }
}

/// Parsed pieces of a URL needed to compute its origin.
pub struct ParsedUrl {
    pub scheme: String,
    pub has_userinfo: bool,
    pub host: String,
    pub port: Option<u16>,
}

/// Manually parse the scheme, userinfo presence, host, and port from a raw URL
/// string. Returns Err on anything that does not look like a well-formed
/// "scheme://host[:port]..." URL. This is intentionally strict: the only caller
/// that matters is `script_http_fetch`, which is security-critical, so an
/// ambiguous parse must fail closed rather than guess.
pub fn parse_url(raw: &str) -> Result<ParsedUrl, String> {
    // scheme
    let scheme_end = raw
        .find("://")
        .ok_or_else(|| "invalid URL: missing scheme".to_string())?;
    let scheme = raw[..scheme_end].to_ascii_lowercase();
    if scheme.is_empty()
        || !scheme.bytes().all(|b| {
            b.is_ascii_alphanumeric() || b == b'+' || b == b'-' || b == b'.'
        })
    {
        return Err("invalid URL: malformed scheme".to_string());
    }

    let after_scheme = &raw[scheme_end + 3..];

    // authority ends at the first '/', '?', or '#'
    let authority_end = after_scheme
        .find(|c| c == '/' || c == '?' || c == '#')
        .unwrap_or(after_scheme.len());
    let authority = &after_scheme[..authority_end];
    if authority.is_empty() {
        return Err("invalid URL: missing host".to_string());
    }

    // userinfo (user:pass@) — present if an '@' appears before any '/'
    let (has_userinfo, hostport) = match authority.rfind('@') {
        Some(at) => (true, &authority[at + 1..]),
        None => (false, authority),
    };
    if hostport.is_empty() {
        return Err("invalid URL: missing host".to_string());
    }

    // Split host and optional port. IPv6 literals are wrapped in [ ].
    let (host_raw, port_str): (&str, Option<&str>) = if let Some(stripped) = hostport.strip_prefix('[')
    {
        // [ipv6]:port
        let close = stripped
            .find(']')
            .ok_or_else(|| "invalid URL: unterminated IPv6 host".to_string())?;
        let host = &stripped[..close];
        let rest = &stripped[close + 1..];
        let port = if let Some(p) = rest.strip_prefix(':') {
            Some(p)
        } else if rest.is_empty() {
            None
        } else {
            return Err("invalid URL: malformed IPv6 authority".to_string());
        };
        (host, port)
    } else if let Some(colon) = hostport.rfind(':') {
        (&hostport[..colon], Some(&hostport[colon + 1..]))
    } else {
        (hostport, None)
    };

    if host_raw.is_empty() {
        return Err("invalid URL: empty host".to_string());
    }

    let port = match port_str {
        Some(p) => Some(
            p.parse::<u16>()
                .map_err(|_| "invalid URL: malformed port".to_string())?,
        ),
        None => None,
    };

    Ok(ParsedUrl {
        scheme,
        has_userinfo,
        host: host_raw.to_ascii_lowercase(),
        port,
    })
}

/// Compute the normalized origin string "scheme://host[:port]" for a parsed
/// URL. The default https port (443) is omitted, matching the frontend's
/// origin normalization so grants compare equal regardless of an explicit :443.
pub fn normalize_origin(parsed: &ParsedUrl) -> String {
    let default_port = match parsed.scheme.as_str() {
        "https" => Some(443u16),
        "http" => Some(80u16),
        _ => None,
    };
    match parsed.port {
        Some(p) if Some(p) != default_port => {
            format!("{}://{}:{}", parsed.scheme, parsed.host, p)
        }
        _ => format!("{}://{}", parsed.scheme, parsed.host),
    }
}
