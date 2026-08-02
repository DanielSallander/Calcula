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
use calp::registry_id::RegistryScope;
use calp::signing::{self, PinKey};
use calp::skin_pack::{self, SkinPack, SkinTrust};
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
    /// "verified" | "firstUse" | "notPinned" | "unsigned" | "unknown".
    pub trust: String,
    pub publisher_fingerprint: String,
    pub version: String,
    /// Non-empty when the machine policy itself is misconfigured, e.g. it names
    /// a `skinPackage` + `registryUrl` but no `publisherKey`. Surfaced in the
    /// Appearance panel rather than swallowed: the org skin pull now runs under
    /// `PinPolicy::RequirePinned`, so without a `publisherKey` to seed the pin
    /// there is nothing to trust and the result is NO skin. That must read as
    /// "your policy.json is incomplete", not as a silent nothing-happened.
    pub policy_error: String,
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
            policy_error: String::new(),
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

/// Wire string for `SkinTrust`. EXHAUSTIVE (no `_` arm) so a new trust state
/// cannot reach the Appearance panel before it has a presentation row there —
/// see `app/src/api/appearancePolicy.ts` (`SkinTrust`) and `AppearancePanel`.
fn trust_str(t: SkinTrust) -> String {
    match t {
        SkinTrust::Verified => "verified",
        SkinTrust::FirstUse => "firstUse",
        SkinTrust::FirstUseKnownPublisher => "firstUseKnownPublisher",
        SkinTrust::FirstUseAcceptedNameConflict => "firstUseAcceptedNameConflict",
        SkinTrust::NotPinned => "notPinned",
        SkinTrust::NotPinnedNameConflict => "notPinnedNameConflict",
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
    //
    // THIS is the org-skin trust decision, and the only one. `%PROGRAMDATA%` is
    // admin-writable only, so an administrator authoring `publisherKey` IS the
    // human deciding to trust that publisher. Everything downstream
    // (`skin_pull`) therefore runs `PinPolicy::RequirePinned` and can only ever
    // CHECK this pin.
    //
    // SCOPED to `registryUrl`, using the SAME derivation `skin_pull` will use to
    // read it back. If the pre-pin and the pull disagreed about the registry's
    // identity the pin would be written in one scope and looked up in another,
    // and under `RequirePinned` that means silently NO org skin. That is exactly
    // what two divergent `file://` strippers used to risk, which is why there is
    // now one (`calp::registry_id`) and both sides call it.
    let registry_scope = registry_scope_for_policy(policy);
    if !policy.publisher_key.is_empty() && !policy.skin_package.is_empty() {
        if let Some(scope) = registry_scope.as_ref() {
            let _ = signing::pin_publisher(
                profile_dir,
                &PinKey::calp(scope, &policy.skin_package),
                &scope.label,
                &policy.publisher_key,
            );
        }
    }

    // Validate the policy BEFORE trying to use it. Previously a policy naming a
    // skin package + registry but NO publisher key still produced a skin: the
    // pre-pin above was skipped and `skin_pull` supplied the missing pin from
    // whatever the registry served, at app launch, and displayed it as
    // "verified". Refusing that is correct — but refusing it silently would
    // just look like a broken feature, so the misconfiguration is named.
    let policy_error = if !policy.skin_package.is_empty() && policy.publisher_key.is_empty() {
        let msg = format!(
            "policy.json names skinPackage '{}' but no publisherKey. Calcula will not trust a \
             publisher key merely because a registry served it at startup, so no org skin is \
             applied. Add the org's Ed25519 publisher key (hex) to policy.json.",
            policy.skin_package
        );
        eprintln!("[APPEARANCE] {msg}");
        msg
    } else if !policy.skin_package.is_empty()
        && !policy.registry_url.is_empty()
        && registry_scope.is_none()
    {
        // A publisher pin is filed under the registry it came from, so a
        // registryUrl with no derivable identity is a registryUrl whose trust
        // decision could not be recorded. Naming it beats a silent no-op.
        let msg = format!(
            "policy.json names registryUrl '{}', which Calcula cannot resolve to a registry \
             identity, so the org publisher key could not be pre-trusted and no org skin is \
             applied. Use a filesystem path, a UNC path, or an http(s) URL.",
            policy.registry_url
        );
        eprintln!("[APPEARANCE] {msg}");
        msg
    } else {
        String::new()
    };

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
        policy_error,
    }
}

/// Resolve the org skin: remote registry pull -> last-good cache -> local
/// pre-installed file -> none. Each step degrades gracefully; the registry is
/// never allowed to block startup or fail the resolve hard.
fn resolve_skin(policy: &ManagedPolicy, profile_dir: &Path) -> (Option<SkinPack>, String) {
    if policy.skin_package.is_empty() {
        return (None, "unsigned".to_string());
    }

    let cache = SkinCachePaths::for_package(profile_dir, &policy.skin_package);

    // 1. Remote registry pull (filesystem / UNC registries only; HTTP is a
    //    future transport). Manual refresh uses the cache unless it is missing.
    if let (Some(reg_path), Some(scope)) = (
        local_registry_path(&policy.registry_url),
        registry_scope_for_policy(policy),
    ) {
        let want_pull = policy.refresh != RefreshMode::Manual || !cache.is_complete();
        if want_pull {
            match try_remote_pull(&reg_path, &scope, profile_dir, policy) {
                Ok(pulled) => {
                    // Report the trust the pull actually established, not a
                    // hard-coded "verified". Under RequirePinned that is always
                    // `Verified` today — but hard-coding the badge is precisely
                    // how `skin_pull` used to render a first-contact key as
                    // verified, so the value now travels instead of being
                    // asserted.
                    let trust = trust_str(pulled.trust);
                    let _ = cache.write(&pulled);
                    return (Some(pulled.skin), trust);
                }
                Err(e) => {
                    eprintln!("[APPEARANCE] org skin pull failed ({e}); falling back to cache/local");
                }
            }
        }
    }

    // 2. Last-good cache from a prior successful pull — RE-VERIFIED, never
    //    assumed. This directory is in the per-user profile and is writable by
    //    anything running as the user, so believing it would hand the machine's
    //    branding to whoever last wrote a file there: the pull above may run
    //    under RequirePinned, but a fabricated cache used to walk straight past
    //    it and render as "verified". `verify_cached_skin` re-checks the
    //    publisher signature and the payload digest against the administrator's
    //    `publisherKey` from %PROGRAMDATA%, so the cache is only ever as
    //    trustworthy as the admin-authored key that vouches for it.
    match cache.read_verified(&policy.publisher_key) {
        Ok(Some(skin)) => return (Some(skin), "verified".to_string()),
        Ok(None) => {}
        Err(e) => {
            eprintln!(
                "[APPEARANCE] cached org skin failed verification ({e}); discarding it. \
                 The cache is not trusted merely because it is local."
            );
            cache.discard();
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
    scope: &RegistryScope,
    profile_dir: &Path,
    policy: &ManagedPolicy,
) -> Result<skin_pack::PulledSkin, calp::CalpError> {
    let registry = LocalRegistry::open(reg_path)?;
    let pin = VersionPin::parse(&policy.skin_version_pin)?;
    // RequirePinned: this runs at APP LAUNCH, before any user interaction. The
    // administrator's `publisherKey` (pre-pinned in `resolve_effective_policy`)
    // is the only thing that may authorize the org key; a registry cannot
    // nominate itself.
    let pulled = skin_pack::skin_pull(
        &registry,
        profile_dir,
        &policy.skin_package,
        scope,
        &pin,
        calp::integrity::PinPolicy::RequirePinned,
    )?;
    Ok(pulled)
}

/// The three files that make the org-skin cache re-verifiable offline: the raw
/// published payload, the signed manifest that names its digest, and the
/// detached signature over that manifest.
///
/// Caching only the payload (what this used to do) leaves nothing to check it
/// against, which is why the read path had no choice but to assert "verified".
/// Storing the proof alongside the payload is what lets step 2 of `resolve_skin`
/// be a verification instead of an act of faith.
struct SkinCachePaths {
    skin: PathBuf,
    manifest: PathBuf,
    signature: PathBuf,
}

impl SkinCachePaths {
    fn for_package(profile_dir: &Path, package: &str) -> Self {
        let dir = profile_dir.join("skins-cache");
        Self {
            skin: dir.join(format!("{package}.json")),
            manifest: dir.join(format!("{package}.manifest.json")),
            signature: dir.join(format!("{package}.manifest.sig")),
        }
    }

    /// A cache is usable only if ALL THREE parts are present. A payload without
    /// its proof is not a cache hit — it is an unverifiable file that happens to
    /// sit in the cache directory, and treating it as a hit is what let a
    /// `refresh: "manual"` install skip the registry entirely.
    fn is_complete(&self) -> bool {
        self.skin.is_file() && self.manifest.is_file() && self.signature.is_file()
    }

    fn write(&self, pulled: &skin_pack::PulledSkin) -> std::io::Result<()> {
        if let Some(parent) = self.skin.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&self.skin, &pulled.skin_bytes)?;
        std::fs::write(&self.manifest, &pulled.manifest_bytes)?;
        std::fs::write(&self.signature, pulled.manifest_sig_hex.as_bytes())
    }

    /// `Ok(None)` = nothing cached (not an error). `Err` = something IS cached
    /// and it does not verify, which is a fact worth logging and acting on.
    fn read_verified(&self, expected_publisher_key: &str) -> Result<Option<SkinPack>, calp::CalpError> {
        if !self.is_complete() {
            return Ok(None);
        }
        let skin_bytes = std::fs::read(&self.skin)?;
        let manifest_bytes = std::fs::read(&self.manifest)?;
        let sig_hex = std::fs::read_to_string(&self.signature)?;
        skin_pack::verify_cached_skin(
            &skin_bytes,
            &manifest_bytes,
            &sig_hex,
            expected_publisher_key,
        )
        .map(Some)
    }

    /// Remove a cache that failed verification so it cannot be re-offered (and
    /// cannot keep suppressing the pull under `refresh: "manual"`).
    fn discard(&self) {
        let _ = std::fs::remove_file(&self.skin);
        let _ = std::fs::remove_file(&self.manifest);
        let _ = std::fs::remove_file(&self.signature);
    }
}

/// Map a policy `registryUrl` to a local filesystem path, or None for an HTTP
/// URL (no HTTP transport yet) or an empty value. Supports plain paths, UNC
/// (`\\server\share`), and best-effort `file://` URLs.
fn local_registry_path(url: &str) -> Option<PathBuf> {
    if url.is_empty() {
        return None;
    }
    if calp::registry_id::is_http_location(url) {
        return None; // HTTP registry transport is a future effort.
    }
    // ONE `file://` stripper for the whole codebase. This function used to carry
    // its own, subtly different from the one in `calp_registry` — so the org skin
    // could be pinned under one spelling of a location and read under another.
    Some(PathBuf::from(calp::registry_id::strip_file_scheme(url)))
}

/// The pin scope for a machine policy's `registryUrl`, or `None` when the policy
/// names no registry (or one with no derivable identity).
///
/// Derived from the CONFIGURED STRING, never from a transport: this runs before
/// any registry is opened (it is what seeds the pin the pull then requires), and
/// an identity a server could influence is not an identity worth pinning to.
fn registry_scope_for_policy(policy: &ManagedPolicy) -> Option<RegistryScope> {
    if policy.registry_url.is_empty() {
        return None;
    }
    calp::registry_id::registry_scope(&policy.registry_url).ok()
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

    /// The key pinned for a package in ONE registry, addressed the way
    /// production addresses it: scope derived from the configured location.
    fn pinned_key(profile: &Path, registry_location: &str, package: &str) -> Option<String> {
        let scope = calp::registry_id::registry_scope(registry_location).unwrap();
        calp::signing::load_pins(profile)
            .unwrap()
            .get(&PinKey::calp(&scope, package))
            .map(|r| r.publisher_key.clone())
    }

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

    /// THERE IS ONE `file://` STRIPPER.
    ///
    /// This module used to carry its own, subtly different from
    /// `calp_registry`'s: it trimmed ALL leading slashes, so
    /// `file://server/share` became `server/share` rather than a UNC path. With
    /// pins scoped to a registry that divergence stops being cosmetic — the
    /// admin pre-pin would be filed under one identity and the pull would look
    /// it up under another, and `RequirePinned` would then silently produce no
    /// org skin at all. Both sides now call `calp::registry_id`.
    #[test]
    fn the_file_scheme_is_stripped_by_the_one_shared_implementation() {
        let src = include_str!("managed_policy.rs");
        let prod = src.split("#[cfg(test)]").next().unwrap();
        assert!(
            !prod.contains("strip_prefix(\"file://\")"),
            "managed_policy must not carry its own file:// stripper — use \
             calp::registry_id::strip_file_scheme"
        );
        assert!(
            prod.contains("calp::registry_id::strip_file_scheme(url)"),
            "the shared stripper must be the one used"
        );
        assert!(
            prod.contains("calp::registry_id::registry_scope(&policy.registry_url)"),
            "the pre-pin scope must be derived from the CONFIGURED registryUrl"
        );
    }

    /// Publish the org skin and return the publisher's public key — the value
    /// a real administrator puts in policy.json's `publisherKey`. Without it
    /// there is no pin, and `skin_pull` (RequirePinned) refuses.
    fn publish_brand(reg_dir: &Path, pub_profile: &Path) -> String {
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
        calp::signing::PublisherKeypair::load_or_create(pub_profile)
            .unwrap()
            .public_key_hex()
    }

    #[test]
    fn resolve_pulls_signed_skin_from_registry_and_caches() {
        let reg = tempfile::TempDir::new().unwrap();
        let pub_profile = tempfile::TempDir::new().unwrap();
        let sub_profile = tempfile::TempDir::new().unwrap();
        let org_key = publish_brand(reg.path(), pub_profile.path());

        let mut policy = ManagedPolicy::default();
        policy.default_skin_id = "acme.brand".to_string();
        policy.skin_package = "acme-brand".to_string();
        policy.registry_url = reg.path().to_string_lossy().to_string();
        policy.skin_version_pin = "latest".to_string();
        // The administrator's trust decision. `resolve_effective_policy`
        // pre-pins it, and only that pin lets the RequirePinned pull succeed.
        policy.publisher_key = org_key;

        let resolved = resolve_effective_policy(&policy, sub_profile.path());
        assert!(resolved.managed);
        assert_eq!(resolved.trust, "verified");
        assert_eq!(resolved.policy_error, "", "a complete policy has no error");
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
        let org_key = publish_brand(reg.path(), pub_profile.path());

        let mut policy = ManagedPolicy::default();
        policy.default_skin_id = "acme.brand".to_string();
        policy.skin_package = "acme-brand".to_string();
        policy.registry_url = reg.path().to_string_lossy().to_string();
        policy.skin_version_pin = "latest".to_string();
        policy.publisher_key = org_key;

        // First resolve pulls + caches.
        resolve_effective_policy(&policy, sub_profile.path());

        // Now point at a non-existent registry — resolve must use the cache.
        policy.registry_url = reg.path().join("gone").to_string_lossy().to_string();
        let resolved = resolve_effective_policy(&policy, sub_profile.path());
        let skin = resolved.skin.expect("cached skin used");
        assert_eq!(skin.id, "acme.brand");
        assert_eq!(resolved.trust, "verified");
    }

    /// THE CACHE IS NOT A TRUST ROOT.
    ///
    /// `skins-cache/` lives in the per-user profile, so anything running as the
    /// user can write it. It used to be read back, applied, and labelled
    /// "verified" with no check at all — a plain JSON file dropped in that
    /// directory took over the machine's branding under a green badge, walking
    /// straight past the `PinPolicy::RequirePinned` gate on the pull. The cache
    /// is now re-verified against the administrator's `publisherKey`.
    #[test]
    fn a_forged_cache_file_is_refused_and_discarded() {
        let sub_profile = tempfile::TempDir::new().unwrap();
        let cache_dir = sub_profile.path().join("skins-cache");
        std::fs::create_dir_all(&cache_dir).unwrap();

        // The attacker forges all three parts, signing the manifest with a key
        // of their own — cryptographically valid, and irrelevant, because it is
        // not the key the administrator authored.
        let evil_profile = tempfile::TempDir::new().unwrap();
        let evil_kp = calp::signing::PublisherKeypair::load_or_create(evil_profile.path()).unwrap();
        let evil_skin = br#"{"schemaVersion":1,"id":"evil.brand","name":"Evil","base":"dark"}"#;
        let mut checksums = std::collections::BTreeMap::new();
        checksums.insert(
            "skin-pack.json".to_string(),
            calp::integrity::sha256_hex(evil_skin),
        );
        let manifest = serde_json::json!({
            "formatVersion": 1,
            "packageName": "acme-brand",
            "version": "9.9.9",
            "kind": "skin",
            "publishedAt": "2026-07-31T00:00:00Z",
            "publishedBy": "evil",
            "publisherKey": evil_kp.public_key_hex(),
            "publisherName": "evil",
            "minAppVersion": "",
            "sheets": [], "namedRanges": [], "tables": [],
            "lockedSheets": [], "lockedCells": [],
            "objectScripts": [], "moduleScripts": [], "notebooks": [],
            "dataSources": [], "customObjects": [],
            "artifactChecksums": checksums,
        });
        let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
        std::fs::write(cache_dir.join("acme-brand.json"), evil_skin).unwrap();
        std::fs::write(cache_dir.join("acme-brand.manifest.json"), &manifest_bytes).unwrap();
        std::fs::write(
            cache_dir.join("acme-brand.manifest.sig"),
            evil_kp.sign(&manifest_bytes),
        )
        .unwrap();

        // The administrator's policy names a DIFFERENT publisher key, and the
        // registry is unreachable so the cache is the only candidate.
        let admin_profile = tempfile::TempDir::new().unwrap();
        let admin_key = calp::signing::PublisherKeypair::load_or_create(admin_profile.path())
            .unwrap()
            .public_key_hex();
        let mut policy = ManagedPolicy::default();
        policy.default_skin_id = "acme.brand".to_string();
        policy.skin_package = "acme-brand".to_string();
        policy.registry_url = sub_profile.path().join("no-such-registry").to_string_lossy().to_string();
        policy.publisher_key = admin_key;

        let resolved = resolve_effective_policy(&policy, sub_profile.path());
        assert!(
            resolved.skin.is_none(),
            "a cache signed by an unexpected key must not be applied"
        );
        assert_ne!(resolved.trust, "verified");
        // ...and it is gone, so it cannot keep suppressing the pull.
        assert!(!cache_dir.join("acme-brand.json").exists());
        assert!(!cache_dir.join("acme-brand.manifest.json").exists());
        assert!(!cache_dir.join("acme-brand.manifest.sig").exists());
    }

    /// The payload half of the same chain: a genuine, admin-signed manifest with
    /// the skin bytes swapped underneath it. The signature still verifies — the
    /// artifact digest is what catches this.
    #[test]
    fn a_cache_with_swapped_payload_bytes_is_refused() {
        let reg = tempfile::TempDir::new().unwrap();
        let pub_profile = tempfile::TempDir::new().unwrap();
        let sub_profile = tempfile::TempDir::new().unwrap();
        let org_key = publish_brand(reg.path(), pub_profile.path());

        let mut policy = ManagedPolicy::default();
        policy.default_skin_id = "acme.brand".to_string();
        policy.skin_package = "acme-brand".to_string();
        policy.registry_url = reg.path().to_string_lossy().to_string();
        policy.publisher_key = org_key;

        // A legitimate pull populates the cache with real proof material.
        resolve_effective_policy(&policy, sub_profile.path());
        let cache_dir = sub_profile.path().join("skins-cache");
        assert!(cache_dir.join("acme-brand.manifest.sig").exists());

        // Swap ONLY the payload, leaving the authentic manifest + signature.
        std::fs::write(
            cache_dir.join("acme-brand.json"),
            br#"{"schemaVersion":1,"id":"evil.brand","name":"Evil","base":"dark"}"#,
        )
        .unwrap();

        policy.registry_url = reg.path().join("gone").to_string_lossy().to_string();
        let resolved = resolve_effective_policy(&policy, sub_profile.path());
        assert!(
            resolved.skin.is_none(),
            "swapped payload bytes must not be applied under the publisher's signature"
        );
    }

    /// Structural guard: the cache read must go through verification, and the
    /// only literal `"verified"` the resolver may produce for a cache hit must
    /// sit on the far side of `read_verified`. The old code reached the same
    /// label by asserting it, which is why this is checked in source and not
    /// only in behaviour.
    #[test]
    fn the_cache_path_cannot_regain_an_asserted_trust_label() {
        let src = include_str!("managed_policy.rs");
        let prod = src.split("#[cfg(test)]").next().unwrap();

        assert!(
            prod.contains("cache.read_verified(&policy.publisher_key)"),
            "the cached org skin must be re-verified against the administrator's publisherKey"
        );
        // The pre-fix shape: parse the cache file and hand it back as verified.
        assert!(
            !prod.contains("serde_json::from_slice::<SkinPack>(&bytes)"),
            "the cache must not be deserialized straight into a trusted skin"
        );
        // A failed verification must DELETE the cache, or a `refresh: manual`
        // policy keeps skipping the pull because a (bad) cache file exists.
        assert!(
            prod.contains("cache.discard()"),
            "a cache that fails verification must be discarded, not merely ignored"
        );
        // And the completeness test gates the pull-suppression decision.
        assert!(
            prod.contains("!cache.is_complete()"),
            "only a COMPLETE (payload + manifest + signature) cache may suppress the pull"
        );
    }

    /// A cache that is only PARTLY present is not a cache hit. This matters
    /// beyond tidiness: under `refresh: "manual"` an existing cache file
    /// suppresses the registry pull entirely, so a lone attacker-written payload
    /// would otherwise be able to stop the genuine skin from ever being fetched.
    #[test]
    fn a_payload_only_cache_does_not_suppress_the_pull() {
        let reg = tempfile::TempDir::new().unwrap();
        let pub_profile = tempfile::TempDir::new().unwrap();
        let sub_profile = tempfile::TempDir::new().unwrap();
        let org_key = publish_brand(reg.path(), pub_profile.path());

        // Only the payload, no proof — the shape the OLD cache wrote.
        let cache_dir = sub_profile.path().join("skins-cache");
        std::fs::create_dir_all(&cache_dir).unwrap();
        std::fs::write(
            cache_dir.join("acme-brand.json"),
            br#"{"schemaVersion":1,"id":"evil.brand","name":"Evil","base":"dark"}"#,
        )
        .unwrap();

        let mut policy = ManagedPolicy::default();
        policy.default_skin_id = "acme.brand".to_string();
        policy.skin_package = "acme-brand".to_string();
        policy.registry_url = reg.path().to_string_lossy().to_string();
        policy.publisher_key = org_key;
        policy.refresh = RefreshMode::Manual;

        let resolved = resolve_effective_policy(&policy, sub_profile.path());
        let skin = resolved.skin.expect("the genuine skin must still be pulled");
        assert_eq!(
            skin.id, "acme.brand",
            "the real registry skin must win over an unverifiable cache file"
        );
    }

    /// A policy that names a skin package + registry but NO publisherKey used
    /// to work: the pre-pin was skipped and `skin_pull` silently supplied the
    /// missing pin from whatever key the registry served — at APP LAUNCH,
    /// before any user interaction, and it was then displayed as "verified".
    ///
    /// That is a machine-wide squat with no gesture behind it. It is now
    /// refused, and — because a silent refusal just looks like a broken
    /// feature — the incomplete policy is NAMED.
    #[test]
    fn a_policy_without_a_publisher_key_gets_no_skin_and_an_explicit_error() {
        let reg = tempfile::TempDir::new().unwrap();
        let pub_profile = tempfile::TempDir::new().unwrap();
        let sub_profile = tempfile::TempDir::new().unwrap();
        publish_brand(reg.path(), pub_profile.path());

        let mut policy = ManagedPolicy::default();
        policy.default_skin_id = "acme.brand".to_string();
        policy.skin_package = "acme-brand".to_string();
        policy.registry_url = reg.path().to_string_lossy().to_string();
        policy.skin_version_pin = "latest".to_string();
        // publisher_key deliberately left empty.

        let resolved = resolve_effective_policy(&policy, sub_profile.path());
        assert!(resolved.managed);
        assert!(resolved.skin.is_none(), "no key means no org skin");
        assert!(
            resolved.policy_error.contains("publisherKey"),
            "the misconfiguration must be surfaced, got: {:?}",
            resolved.policy_error
        );
        // Nothing was pinned, so a later legitimate policy is still a clean
        // first use rather than a "publisher changed" alarm.
        assert!(
            calp::signing::load_pins(sub_profile.path()).unwrap().is_empty(),
            "startup must never pin a key the administrator did not name"
        );
    }

    /// A COMPLETE policy whose publisherKey does not match the key the registry
    /// serves is a hijack (or a stale policy), and must be refused rather than
    /// re-pinned.
    #[test]
    fn a_registry_serving_a_different_key_than_the_policy_is_refused() {
        let reg = tempfile::TempDir::new().unwrap();
        let pub_profile = tempfile::TempDir::new().unwrap();
        let other_profile = tempfile::TempDir::new().unwrap();
        let sub_profile = tempfile::TempDir::new().unwrap();
        publish_brand(reg.path(), pub_profile.path());
        // The admin pinned a DIFFERENT org key.
        let other_key = calp::signing::PublisherKeypair::load_or_create(other_profile.path())
            .unwrap()
            .public_key_hex();

        let mut policy = ManagedPolicy::default();
        policy.default_skin_id = "acme.brand".to_string();
        policy.skin_package = "acme-brand".to_string();
        policy.registry_url = reg.path().to_string_lossy().to_string();
        policy.skin_version_pin = "latest".to_string();
        policy.publisher_key = other_key.clone();

        let resolved = resolve_effective_policy(&policy, sub_profile.path());
        assert!(resolved.skin.is_none(), "a key mismatch must not apply a skin");
        // The admin's pin is intact — the registry did not get to overwrite it.
        assert_eq!(
            pinned_key(sub_profile.path(), &reg.path().to_string_lossy(), "acme-brand"),
            Some(other_key)
        );
    }

    /// THE PRE-PIN MUST BE WRITTEN UNDER THE SCOPE THE PULL READS.
    ///
    /// A publisher pin is now filed under `(registry, package)`. The
    /// administrator's pre-pin and `skin_pull` derive that registry identity
    /// independently, from the same `registryUrl` string — so if the two
    /// derivations ever disagree the pin lands in one scope, the pull looks in
    /// another, `RequirePinned` finds nothing, and the org skin silently stops
    /// working. This is the test that catches a second canonicalizer.
    #[test]
    fn the_prepin_scope_matches_the_scope_the_pull_reads() {
        let reg = tempfile::TempDir::new().unwrap();
        let pub_profile = tempfile::TempDir::new().unwrap();
        let sub_profile = tempfile::TempDir::new().unwrap();
        let org_key = publish_brand(reg.path(), pub_profile.path());

        // The administrator spells the registry differently from its canonical
        // form: forward slashes, upper case, a trailing separator, and a
        // `file://` scheme. All four are things a real policy.json contains.
        let admin_spelling = format!(
            "file://{}/",
            reg.path().to_string_lossy().replace('\\', "/").to_uppercase()
        );

        let mut policy = ManagedPolicy::default();
        policy.default_skin_id = "acme.brand".to_string();
        policy.skin_package = "acme-brand".to_string();
        policy.registry_url = admin_spelling;
        policy.skin_version_pin = "latest".to_string();
        policy.publisher_key = org_key.clone();

        let resolved = resolve_effective_policy(&policy, sub_profile.path());
        assert_eq!(
            resolved.trust, "verified",
            "a differently-spelled registryUrl must still resolve to the pinned scope"
        );
        assert!(resolved.skin.is_some(), "the org skin must be applied");
        assert_eq!(resolved.policy_error, "");

        // And the canonical spelling reads the SAME pin — one registry, one row.
        assert_eq!(
            pinned_key(sub_profile.path(), &reg.path().to_string_lossy(), "acme-brand"),
            Some(org_key)
        );
        assert_eq!(
            calp::signing::load_pins(sub_profile.path()).unwrap().len(),
            1,
            "one registry spelled twice must not produce two pins"
        );
    }

    /// TWO registries may hold the same skin package name without colliding —
    /// an org `acme-brand` at a corporate share and a personal one in a local
    /// registry used to overwrite each other's row in a flat name -> key map.
    #[test]
    fn an_org_and_a_personal_registry_can_hold_the_same_skin_name() {
        let org_reg = tempfile::TempDir::new().unwrap();
        let org_pub = tempfile::TempDir::new().unwrap();
        let sub_profile = tempfile::TempDir::new().unwrap();
        let org_key = publish_brand(org_reg.path(), org_pub.path());

        let mine_reg = tempfile::TempDir::new().unwrap();
        let mine_pub = tempfile::TempDir::new().unwrap();
        let my_key = publish_brand(mine_reg.path(), mine_pub.path());
        assert_ne!(org_key, my_key);

        // The administrator's policy pre-pins the ORG key for the ORG registry.
        let mut policy = ManagedPolicy::default();
        policy.default_skin_id = "acme.brand".to_string();
        policy.skin_package = "acme-brand".to_string();
        policy.registry_url = org_reg.path().to_string_lossy().to_string();
        policy.publisher_key = org_key.clone();
        let resolved = resolve_effective_policy(&policy, sub_profile.path());
        assert_eq!(resolved.trust, "verified");

        // A personal registry serving the same package NAME under a different
        // key holds its own, independent pin slot — the org pin is untouched.
        calp::signing::pin_publisher(
            sub_profile.path(),
            &PinKey::calp(
                &calp::registry_id::registry_scope(&mine_reg.path().to_string_lossy()).unwrap(),
                "acme-brand",
            ),
            &mine_reg.path().to_string_lossy(),
            &my_key,
        )
        .unwrap();

        assert_eq!(
            pinned_key(sub_profile.path(), &org_reg.path().to_string_lossy(), "acme-brand"),
            Some(org_key)
        );
        assert_eq!(
            pinned_key(sub_profile.path(), &mine_reg.path().to_string_lossy(), "acme-brand"),
            Some(my_key)
        );
    }

    /// A `registryUrl` with no derivable identity cannot be pinned under, so it
    /// gets no org skin AND an explicit misconfiguration message — the same rule
    /// as a missing `publisherKey`: refuse, but never refuse silently.
    #[test]
    fn an_unscopeable_registry_url_is_named_rather_than_silently_ignored() {
        let sub_profile = tempfile::TempDir::new().unwrap();
        let admin_profile = tempfile::TempDir::new().unwrap();
        let admin_key = calp::signing::PublisherKeypair::load_or_create(admin_profile.path())
            .unwrap()
            .public_key_hex();

        let mut policy = ManagedPolicy::default();
        policy.default_skin_id = "acme.brand".to_string();
        policy.skin_package = "acme-brand".to_string();
        policy.registry_url = "ftp://corp/registry".to_string();
        policy.publisher_key = admin_key;

        let resolved = resolve_effective_policy(&policy, sub_profile.path());
        assert!(resolved.skin.is_none());
        assert!(
            resolved.policy_error.contains("registryUrl"),
            "the unusable registryUrl must be named, got: {:?}",
            resolved.policy_error
        );
        assert!(
            calp::signing::load_pins(sub_profile.path()).unwrap().is_empty(),
            "a location with no identity must not be pinned under some fallback"
        );
    }
}
