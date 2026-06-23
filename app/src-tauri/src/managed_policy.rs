//! FILENAME: app/src-tauri/src/managed_policy.rs
//! PURPOSE: Machine-wide ADVISORY appearance policy. A corporate MSI/MDM/GPO can
//! drop %PROGRAMDATA%\Calcula\policy.json to set the DEFAULT App Skin for an
//! install (and pre-install/pre-trust a signed corporate skin). The user is
//! ALWAYS free to change it — this is advisory only, never a lock.
//! CONTEXT: %PROGRAMDATA% is machine-wide and admin-writable only, so a standard
//! user cannot forge a policy. Reuses the calp Ed25519/TOFU/integrity spine for
//! the (optional) signed skin pack — no new crypto.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use calp::registry::LocalRegistry;
use calp::skin_pack::{self, SkinPack, SkinTrust};
use calp::signing;
use calp::version::VersionPin;

/// How often the client should look for org skin updates (future: remote pull).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RefreshMode {
    #[default]
    Launch,
    Daily,
    Manual,
}

fn default_pin() -> String {
    "latest".to_string()
}

/// The machine-wide managed appearance policy (policy.json). All fields optional;
/// a missing file yields `default()` (= unmanaged).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedPolicy {
    #[serde(default)]
    pub schema_version: u32,
    /// Org display name shown in the provenance banner.
    #[serde(default)]
    pub managed_by: String,
    /// Org .calp registry (file://, UNC; future https://). Reserved for remote pull.
    #[serde(default)]
    pub registry_url: String,
    /// The skin package name (also the local pre-installed file stem).
    #[serde(default)]
    pub skin_package: String,
    /// Version pin for the skin package.
    #[serde(default = "default_pin")]
    pub skin_version_pin: String,
    /// The advisory default skin id (should match the skin pack's id).
    #[serde(default)]
    pub default_skin_id: String,
    /// Org publisher Ed25519 public key (hex) for pre-trust + signature verify.
    #[serde(default)]
    pub publisher_key: String,
    #[serde(default)]
    pub refresh: RefreshMode,
    /// Forward-compat: any extra keys are preserved, not rejected.
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

impl Default for ManagedPolicy {
    fn default() -> Self {
        Self {
            schema_version: 0,
            managed_by: String::new(),
            registry_url: String::new(),
            skin_package: String::new(),
            skin_version_pin: default_pin(),
            default_skin_id: String::new(),
            publisher_key: String::new(),
            refresh: RefreshMode::default(),
            extra: HashMap::new(),
        }
    }
}

/// What the frontend receives from `get_effective_appearance_policy`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveAppearancePolicy {
    pub managed: bool,
    pub managed_by: String,
    pub registry_url: String,
    pub default_skin_id: String,
    /// The resolved org skin (mirrors the frontend Skin shape), or null.
    pub skin: Option<SkinPack>,
    /// "verified" | "unsigned" | "unknown".
    pub trust: String,
    pub publisher_fingerprint: String,
    pub version: String,
}

impl EffectiveAppearancePolicy {
    fn unmanaged() -> Self {
        Self {
            managed: false,
            managed_by: String::new(),
            registry_url: String::new(),
            default_skin_id: String::new(),
            skin: None,
            trust: "unsigned".to_string(),
            publisher_fingerprint: String::new(),
            version: String::new(),
        }
    }
}

/// Tauri state holding the resolved policy. Computed once at startup and
/// refreshable on demand (manual "check for updates"), hence the Mutex.
pub struct ManagedAppearanceState(pub std::sync::Mutex<EffectiveAppearancePolicy>);

/// %PROGRAMDATA%\Calcula (machine-wide, admin-writable only).
fn programdata_calcula_dir() -> PathBuf {
    let pd = std::env::var("PROGRAMDATA").unwrap_or_else(|_| "C:\\ProgramData".to_string());
    PathBuf::from(pd).join("Calcula")
}

fn trust_str(t: SkinTrust) -> String {
    match t {
        SkinTrust::Verified => "verified",
        SkinTrust::Unsigned => "unsigned",
        SkinTrust::Unknown => "unknown",
    }
    .to_string()
}

/// Read the machine policy. Missing file or malformed JSON both yield `default()`
/// (= unmanaged) — never a hard failure that blocks startup.
pub fn read_managed_policy() -> ManagedPolicy {
    let path = programdata_calcula_dir().join("policy.json");
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|e| {
            eprintln!("[APPEARANCE] policy.json malformed, ignoring: {e}");
            ManagedPolicy::default()
        }),
        Err(_) => ManagedPolicy::default(),
    }
}

/// Resolve the effective policy: pre-trust the org key, load + verify the local
/// pre-installed skin pack, and build the payload for the frontend. Best-effort;
/// any failure degrades to an unmanaged/skin-less result rather than blocking.
pub fn resolve_effective_policy(
    policy: &ManagedPolicy,
    profile_dir: &Path,
) -> EffectiveAppearancePolicy {
    let managed = !policy.default_skin_id.is_empty() || !policy.skin_package.is_empty();
    if !managed {
        return EffectiveAppearancePolicy::unmanaged();
    }

    // Pre-trust: seed the TOFU pin from the admin-authored public key, keyed by
    // the package name EXACTLY as the pull's signature check looks it up, so the
    // signed skin verifies as Verified instead of a scary first-use prompt.
    if !policy.publisher_key.is_empty() && !policy.skin_package.is_empty() {
        let _ = signing::pin_publisher(profile_dir, &policy.skin_package, &policy.publisher_key);
    }

    let (skin, trust) = resolve_skin(policy, profile_dir);

    let fingerprint = if policy.publisher_key.len() >= 16 {
        policy.publisher_key[..16].to_string()
    } else {
        policy.publisher_key.clone()
    };

    EffectiveAppearancePolicy {
        managed: true,
        managed_by: policy.managed_by.clone(),
        registry_url: policy.registry_url.clone(),
        default_skin_id: policy.default_skin_id.clone(),
        skin,
        trust,
        publisher_fingerprint: fingerprint,
        version: policy.skin_version_pin.clone(),
    }
}

/// Resolve the org skin: remote registry pull -> last-good cache -> local
/// pre-installed file -> none. Each step degrades gracefully; the registry is
/// never allowed to block startup or fail the resolve hard.
fn resolve_skin(policy: &ManagedPolicy, profile_dir: &Path) -> (Option<SkinPack>, String) {
    if policy.skin_package.is_empty() {
        return (None, "unsigned".to_string());
    }

    let cache_path = profile_dir
        .join("skins-cache")
        .join(format!("{}.json", policy.skin_package));

    // 1. Remote registry pull (filesystem / UNC registries only; HTTP is a
    //    future transport). Manual refresh uses the cache unless it is missing.
    if let Some(reg_path) = local_registry_path(&policy.registry_url) {
        let want_pull = policy.refresh != RefreshMode::Manual || !cache_path.exists();
        if want_pull {
            match try_remote_pull(&reg_path, profile_dir, policy) {
                Ok(skin) => {
                    let _ = write_skin_cache(&cache_path, &skin);
                    return (Some(skin), "verified".to_string());
                }
                Err(e) => {
                    eprintln!("[APPEARANCE] org skin pull failed ({e}); falling back to cache/local");
                }
            }
        }
    }

    // 2. Last-good verified cache (written after a prior successful pull).
    if let Ok(bytes) = std::fs::read(&cache_path) {
        if let Ok(skin) = serde_json::from_slice::<SkinPack>(&bytes) {
            return (Some(skin), "verified".to_string());
        }
    }

    // 3. Local pre-installed file (%PROGRAMDATA%\Calcula\skins\<pkg>.json [+ .sig]).
    let skin_path = programdata_calcula_dir()
        .join("skins")
        .join(format!("{}.json", policy.skin_package));
    if skin_path.exists() {
        return match skin_pack::load_and_verify_skin(&skin_path, &policy.publisher_key) {
            Ok(loaded) => (loaded.skin, trust_str(loaded.trust)),
            Err(_) => (None, "unknown".to_string()),
        };
    }

    let t = if policy.publisher_key.is_empty() { "unsigned" } else { "unknown" };
    (None, t.to_string())
}

fn try_remote_pull(
    reg_path: &Path,
    profile_dir: &Path,
    policy: &ManagedPolicy,
) -> Result<SkinPack, calp::CalpError> {
    let registry = LocalRegistry::open(reg_path)?;
    let pin = VersionPin::parse(&policy.skin_version_pin)?;
    let pulled = skin_pack::skin_pull(&registry, profile_dir, &policy.skin_package, &pin)?;
    Ok(pulled.skin)
}

fn write_skin_cache(cache_path: &Path, skin: &SkinPack) -> std::io::Result<()> {
    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(skin)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    std::fs::write(cache_path, bytes)
}

/// Map a policy `registryUrl` to a local filesystem path, or None for an HTTP
/// URL (no HTTP transport yet) or an empty value. Supports plain paths, UNC
/// (`\\server\share`), and best-effort `file://` URLs.
fn local_registry_path(url: &str) -> Option<PathBuf> {
    if url.is_empty() {
        return None;
    }
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return None; // HTTP registry transport is a future effort.
    }
    if let Some(rest) = url.strip_prefix("file://") {
        // file:///C:/path -> C:/path ; file://server/share -> server/share
        let trimmed = rest.trim_start_matches('/');
        return Some(PathBuf::from(trimmed));
    }
    Some(PathBuf::from(url))
}

/// Frontend entry point — returns the currently-resolved appearance policy.
#[tauri::command]
pub fn get_effective_appearance_policy(
    state: tauri::State<ManagedAppearanceState>,
) -> EffectiveAppearancePolicy {
    state.0.lock().unwrap().clone()
}

/// Manual "check for updates": re-read the machine policy and re-resolve the org
/// skin (re-pulling from the registry per the refresh mode), update the cached
/// state, and return the fresh policy. Used by the Appearance panel's refresh
/// affordance and for `refresh: "manual"` installs.
#[tauri::command]
pub fn refresh_managed_appearance(
    state: tauri::State<ManagedAppearanceState>,
) -> EffectiveAppearancePolicy {
    let resolved = resolve_effective_policy(
        &read_managed_policy(),
        &crate::calp_commands::calcula_profile_dir(),
    );
    if let Ok(mut guard) = state.0.lock() {
        *guard = resolved.clone();
    }
    resolved
}

/// Publish a skin pack to a registry as a signed `skin`-kind package version.
/// The publisher's Ed25519 key (in the per-user profile) signs it, so subscribers
/// verify origin + integrity exactly like any .calp package. This is the admin /
/// authoring side that populates an org registry; clients consume it via the
/// managed policy's `registryUrl`.
#[tauri::command]
pub fn publish_skin_pack(
    registry_path: String,
    package_name: String,
    version: String,
    now: String,
    skin: SkinPack,
) -> Result<(), String> {
    let registry = LocalRegistry::open(Path::new(&registry_path)).map_err(|e| e.to_string())?;
    let profile = crate::calp_commands::calcula_profile_dir();
    skin_pack::skin_publish(&registry, &profile, &package_name, &version, &now, &skin)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_policy_is_unmanaged() {
        // An all-default policy resolves to unmanaged.
        let resolved = resolve_effective_policy(&ManagedPolicy::default(), Path::new("."));
        assert!(!resolved.managed);
        assert!(resolved.skin.is_none());
    }

    #[test]
    fn malformed_extra_keys_preserved() {
        let json = r#"{ "schemaVersion": 1, "defaultSkinId": "acme", "futureKey": 42 }"#;
        let p: ManagedPolicy = serde_json::from_str(json).unwrap();
        assert_eq!(p.default_skin_id, "acme");
        assert_eq!(p.skin_version_pin, "latest"); // default applied
        assert!(p.extra.contains_key("futureKey"));
    }

    #[test]
    fn default_only_policy_is_managed_without_skin_file() {
        let mut p = ManagedPolicy::default();
        p.default_skin_id = "acme".to_string();
        let resolved = resolve_effective_policy(&p, Path::new("."));
        assert!(resolved.managed);
        assert_eq!(resolved.default_skin_id, "acme");
    }

    #[test]
    fn local_registry_path_maps_paths_and_skips_http() {
        assert!(local_registry_path("").is_none());
        assert!(local_registry_path("https://example.com/registry").is_none());
        assert!(local_registry_path("http://example.com/registry").is_none());
        assert_eq!(
            local_registry_path(r"\\server\share\registry").unwrap(),
            PathBuf::from(r"\\server\share\registry")
        );
        assert_eq!(
            local_registry_path("C:/reg").unwrap(),
            PathBuf::from("C:/reg")
        );
        assert_eq!(
            local_registry_path("file:///C:/reg").unwrap(),
            PathBuf::from("C:/reg")
        );
    }

    fn publish_brand(reg_dir: &Path, pub_profile: &Path) {
        let registry = calp::registry::LocalRegistry::open(reg_dir).unwrap();
        let mut tokens = std::collections::BTreeMap::new();
        tokens.insert("--accent-primary".to_string(), "#ff6600".to_string());
        let skin = calp::skin_pack::SkinPack {
            schema_version: 1,
            id: "acme.brand".to_string(),
            name: "Acme".to_string(),
            base: "dark".to_string(),
            tokens: Some(tokens),
            grid: None,
            density: None,
            font_family: None,
            assets: None,
        };
        calp::skin_pack::skin_publish(&registry, pub_profile, "acme-brand", "1.0.0", "2026-06-23T00:00:00Z", &skin).unwrap();
    }

    #[test]
    fn resolve_pulls_signed_skin_from_registry_and_caches() {
        let reg = tempfile::TempDir::new().unwrap();
        let pub_profile = tempfile::TempDir::new().unwrap();
        let sub_profile = tempfile::TempDir::new().unwrap();
        publish_brand(reg.path(), pub_profile.path());

        let mut policy = ManagedPolicy::default();
        policy.default_skin_id = "acme.brand".to_string();
        policy.skin_package = "acme-brand".to_string();
        policy.registry_url = reg.path().to_string_lossy().to_string();
        policy.skin_version_pin = "latest".to_string();

        let resolved = resolve_effective_policy(&policy, sub_profile.path());
        assert!(resolved.managed);
        assert_eq!(resolved.trust, "verified");
        let skin = resolved.skin.expect("skin pulled");
        assert_eq!(skin.id, "acme.brand");
        assert_eq!(skin.base, "dark");

        // The verified pack was cached for offline boot.
        let cache = sub_profile.path().join("skins-cache").join("acme-brand.json");
        assert!(cache.exists(), "skin should be cached after a successful pull");
    }

    #[test]
    fn resolve_falls_back_to_cache_when_registry_unreachable() {
        let reg = tempfile::TempDir::new().unwrap();
        let pub_profile = tempfile::TempDir::new().unwrap();
        let sub_profile = tempfile::TempDir::new().unwrap();
        publish_brand(reg.path(), pub_profile.path());

        let mut policy = ManagedPolicy::default();
        policy.default_skin_id = "acme.brand".to_string();
        policy.skin_package = "acme-brand".to_string();
        policy.registry_url = reg.path().to_string_lossy().to_string();
        policy.skin_version_pin = "latest".to_string();

        // First resolve pulls + caches.
        resolve_effective_policy(&policy, sub_profile.path());

        // Now point at a non-existent registry — resolve must use the cache.
        policy.registry_url = reg.path().join("gone").to_string_lossy().to_string();
        let resolved = resolve_effective_policy(&policy, sub_profile.path());
        let skin = resolved.skin.expect("cached skin used");
        assert_eq!(skin.id, "acme.brand");
    }
}
