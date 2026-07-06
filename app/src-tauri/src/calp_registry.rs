//! FILENAME: app/src-tauri/src/calp_registry.rs
// PURPOSE: Registry transport selection + the HTTP registry (granular bricks —
//          distribution brick 1). The core `calp` crate defines the
//          `RegistryTransport` seam and ships only `LocalRegistry`; the HTTP
//          implementation lives HERE (app crate) so `core/calp` stays
//          dependency-free (no HTTP client). `open_registry()` routes a
//          location string to the right transport by URL scheme, so every calp
//          command constructs its registry through one choke point.
// SECURITY: HTTP registries are READ-ONLY in v1 (publish/write methods error).
//          Signing/TOFU/integrity are unchanged — a package pulled over HTTP is
//          verified exactly like a local one (the manifest signature + per-
//          artifact SHA-256 are checked through the same transport-agnostic
//          path). A malicious server can therefore serve a package but cannot
//          forge a publisher's signature or tamper an artifact undetected.

use calp::error::CalpError;
use calp::manifest::{PackageManifest, VersionManifest};
use calp::registry::LocalRegistry;
use calp::transport::RegistryTransport;
use calp::version::{SemVer, VersionPin};
use calp::writeback::WritebackSubmission;

// ============================================================================
// Transport factory (the single construction choke point)
// ============================================================================

/// Whether a location string denotes an HTTP(S) registry.
pub fn is_http_location(location: &str) -> bool {
    location.starts_with("http://") || location.starts_with("https://")
}

/// Open a registry transport for a location string, routing by scheme:
/// - `http://` / `https://` -> read-only `HttpRegistry`
/// - `file://<path>` or a bare path -> `LocalRegistry`
///
/// Returned as a boxed trait object; publish/pull/refresh all accept
/// `&dyn RegistryTransport`, so callers pass `registry.as_ref()`.
pub fn open_registry(location: &str) -> Result<Box<dyn RegistryTransport>, CalpError> {
    if is_http_location(location) {
        Ok(Box::new(HttpRegistry::new(location)))
    } else {
        let path = location.strip_prefix("file://").unwrap_or(location);
        let reg = LocalRegistry::open(std::path::Path::new(path))?;
        Ok(Box::new(reg))
    }
}

// ============================================================================
// HTTP registry (read-only)
// ============================================================================

/// A read-only `.calp` registry served over HTTP(S). Any static file host that
/// lays packages out as `<base>/<package>/calp-manifest.json`,
/// `<base>/<package>/<version>/version-manifest.json`, and
/// `<base>/<package>/<version>/<artifact-rel-path>` is a valid registry — so an
/// S3 bucket, nginx dir, or GitHub Pages site works with no server code.
///
/// Uses `reqwest::blocking` (the app already links reqwest with native TLS, so
/// no new C toolchain is needed). Safe to call from a sync Tauri command
/// thread: those run OFF the async runtime, so the blocking client's internal
/// runtime does not nest.
pub struct HttpRegistry {
    base_url: String,
    client: reqwest::blocking::Client,
}

impl HttpRegistry {
    pub fn new(base_url: &str) -> Self {
        // A static-file .calp registry has a flat, predictable layout
        // (base/pkg/calp-manifest.json, base/pkg/ver/version-manifest.json,
        // base/pkg/ver/artifact) and legitimately needs NO redirects. Following
        // them turns every registry GET into a blind SSRF/port-probe primitive:
        // a hostile registry could redirect a fetch to http://169.254.169.254/…
        // or an intranet host. Disable redirect-following entirely.
        //
        // NOTE: `.unwrap_or_default()` would fall back to a default client that
        // DOES follow redirects, silently reintroducing the hole — so fail loudly
        // instead. The builder only fails on TLS-backend init, which is fatal
        // for an HTTP registry anyway.
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("HttpRegistry: failed to build reqwest client");
        HttpRegistry {
            base_url: base_url.trim_end_matches('/').to_string(),
            client,
        }
    }

    fn url(&self, rel: &str) -> String {
        format!("{}/{}", self.base_url, rel.trim_start_matches('/'))
    }

    /// GET a URL, returning the body bytes, or None on 404.
    fn get_bytes(&self, rel: &str) -> Result<Option<Vec<u8>>, CalpError> {
        let resp = self
            .client
            .get(self.url(rel))
            .send()
            .map_err(|e| CalpError::Registry(format!("GET {rel}: {e}")))?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Err(CalpError::Registry(format!(
                "GET {rel}: HTTP {}",
                resp.status().as_u16()
            )));
        }
        let bytes = resp
            .bytes()
            .map_err(|e| CalpError::Registry(format!("read body of {rel}: {e}")))?;
        Ok(Some(bytes.to_vec()))
    }

    fn get_json<T: serde::de::DeserializeOwned>(&self, rel: &str) -> Result<Option<T>, CalpError> {
        match self.get_bytes(rel)? {
            Some(bytes) => {
                let value = serde_json::from_slice(&bytes)
                    .map_err(|e| CalpError::Registry(format!("parse {rel}: {e}")))?;
                Ok(Some(value))
            }
            None => Ok(None),
        }
    }

    fn read_only_err(op: &str) -> CalpError {
        CalpError::Registry(format!(
            "HTTP registries are read-only ({op} is not supported); publish to a local registry"
        ))
    }
}

impl RegistryTransport for HttpRegistry {
    // -- package ops --

    fn list_packages(&self) -> Result<Vec<String>, CalpError> {
        // Optional catalog file; absent -> empty (browsing by name still works).
        Ok(self.get_json::<Vec<String>>("packages.json")?.unwrap_or_default())
    }

    fn get_package_manifest(&self, package_name: &str) -> Result<PackageManifest, CalpError> {
        self.get_json(&format!("{package_name}/calp-manifest.json"))?
            .ok_or_else(|| CalpError::PackageNotFound(package_name.to_string()))
    }

    fn write_package_manifest(&self, _manifest: &PackageManifest) -> Result<(), CalpError> {
        Err(Self::read_only_err("write package manifest"))
    }

    // -- version ops --

    fn get_version_manifest(
        &self,
        package_name: &str,
        version: &str,
    ) -> Result<VersionManifest, CalpError> {
        self.get_json(&format!("{package_name}/{version}/version-manifest.json"))?
            .ok_or_else(|| CalpError::VersionNotFound {
                package: package_name.to_string(),
                version: version.to_string(),
            })
    }

    fn write_version_manifest(
        &self,
        _package_name: &str,
        _version: &str,
        _manifest: &VersionManifest,
    ) -> Result<(), CalpError> {
        Err(Self::read_only_err("write version manifest"))
    }

    fn version_exists(&self, package_name: &str, version: &str) -> bool {
        self.get_bytes(&format!("{package_name}/{version}/version-manifest.json"))
            .map(|opt| opt.is_some())
            .unwrap_or(false)
    }

    fn resolve_version(
        &self,
        package_name: &str,
        pin: &VersionPin,
    ) -> Result<SemVer, CalpError> {
        let pkg_manifest = self.get_package_manifest(package_name)?;
        let available = pkg_manifest.parsed_versions();
        pin.resolve(&available)
            .cloned()
            .ok_or_else(|| CalpError::NoMatchingVersion {
                package: package_name.to_string(),
                pin: pin.to_string(),
            })
    }

    fn list_versions(&self, package_name: &str) -> Result<Vec<SemVer>, CalpError> {
        let manifest = self.get_package_manifest(package_name)?;
        let mut versions = manifest.parsed_versions();
        versions.sort();
        Ok(versions)
    }

    // -- artifacts --

    fn write_artifact(
        &self,
        _package_name: &str,
        _version: &str,
        _rel_path: &str,
        _bytes: &[u8],
    ) -> Result<(), CalpError> {
        Err(Self::read_only_err("write artifact"))
    }

    fn read_artifact(
        &self,
        package_name: &str,
        version: &str,
        rel_path: &str,
    ) -> Result<Option<Vec<u8>>, CalpError> {
        self.get_bytes(&format!("{package_name}/{version}/{rel_path}"))
    }

    fn list_artifacts(
        &self,
        package_name: &str,
        version: &str,
    ) -> Result<Vec<String>, CalpError> {
        // The manifest's checksum map IS the canonical artifact set (it already
        // excludes the integrity root, its signature, and the submissions
        // subtree). Integrity then re-fetches + re-hashes each of these, so a
        // tampered artifact on the server is still caught.
        let manifest = self.get_version_manifest(package_name, version)?;
        let mut artifacts: Vec<String> = manifest.artifact_checksums.keys().cloned().collect();
        artifacts.sort();
        Ok(artifacts)
    }

    fn clear_version(&self, _package_name: &str, _version: &str) -> Result<(), CalpError> {
        Err(Self::read_only_err("clear version"))
    }

    // -- submissions (writeback). A read-only HTTP registry has no submission
    //    store; saving errors, and loading yields nothing. --

    fn save_submission(
        &self,
        _package_name: &str,
        _version: &str,
        _submission: &WritebackSubmission,
    ) -> Result<(), CalpError> {
        Err(Self::read_only_err("save submission"))
    }

    fn load_submissions(
        &self,
        _package_name: &str,
        _version: &str,
        _submitter_id: &str,
    ) -> Result<Vec<WritebackSubmission>, CalpError> {
        Ok(Vec::new())
    }

    fn load_region_submissions(
        &self,
        _package_name: &str,
        _version: &str,
        _region_id: &str,
    ) -> Result<Vec<WritebackSubmission>, CalpError> {
        Ok(Vec::new())
    }

    fn load_all_submissions(
        &self,
        _package_name: &str,
        _version: &str,
    ) -> Result<Vec<WritebackSubmission>, CalpError> {
        Ok(Vec::new())
    }

    // -- lock: no cross-process publish contention for a read-only transport --

    fn lock(&self) -> Result<Box<dyn std::any::Any>, CalpError> {
        Ok(Box::new(()))
    }
}

// ============================================================================
// Saved registries (a per-machine catalog, like trusted-publishers.json)
// ============================================================================
// A small list of known registries so users pick from a dropdown instead of
// typing a path/URL blind. Stored in the profile dir (NOT the workbook — a
// document must not carry your machine's registry list). No credentials are
// stored here; v1 HTTP registries are anonymous read-only.

/// One saved registry the user has added.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedRegistry {
    pub id: String,
    pub name: String,
    /// A location string understood by `open_registry` (a path, `file://…`, or
    /// `https://…`).
    pub location: String,
}

fn registries_file() -> std::path::PathBuf {
    crate::calp_commands::calcula_profile_dir().join("registries.json")
}

fn load_saved_registries_from_disk() -> Vec<SavedRegistry> {
    match std::fs::read(registries_file()) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn persist_saved_registries(list: &[SavedRegistry]) -> Result<(), String> {
    let path = registries_file();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec_pretty(list).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

/// List the machine's saved registries.
#[tauri::command]
pub fn calp_list_registries() -> Result<Vec<SavedRegistry>, String> {
    Ok(load_saved_registries_from_disk())
}

/// Add (or replace by id) a saved registry. Returns the full list.
#[tauri::command]
pub fn calp_add_registry(registry: SavedRegistry) -> Result<Vec<SavedRegistry>, String> {
    let mut list = load_saved_registries_from_disk();
    if let Some(existing) = list.iter_mut().find(|r| r.id == registry.id) {
        *existing = registry;
    } else {
        list.push(registry);
    }
    persist_saved_registries(&list)?;
    Ok(list)
}

/// Remove a saved registry by id. Returns the full list.
#[tauri::command]
pub fn calp_remove_registry(id: String) -> Result<Vec<SavedRegistry>, String> {
    let mut list = load_saved_registries_from_disk();
    list.retain(|r| r.id != id);
    persist_saved_registries(&list)?;
    Ok(list)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scheme_routing() {
        assert!(is_http_location("http://example.com/reg"));
        assert!(is_http_location("https://example.com/reg"));
        assert!(!is_http_location("file:///c/registry"));
        assert!(!is_http_location("C:/registry"));
        assert!(!is_http_location("/home/user/registry"));
    }

    #[test]
    fn http_registry_is_read_only() {
        let reg = HttpRegistry::new("https://example.com/reg/");
        // base_url trailing slash trimmed
        assert_eq!(reg.base_url, "https://example.com/reg");
        assert!(reg
            .write_artifact("pkg", "1.0.0", "sheets/x.json", b"{}")
            .is_err());
        assert!(reg.clear_version("pkg", "1.0.0").is_err());
        // Loading submissions from a read-only registry yields nothing.
        assert!(reg
            .load_all_submissions("pkg", "1.0.0")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn url_join_normalizes_slashes() {
        let reg = HttpRegistry::new("https://host/base/");
        assert_eq!(reg.url("pkg/1.0.0/data.json"), "https://host/base/pkg/1.0.0/data.json");
        assert_eq!(reg.url("/pkg/x.json"), "https://host/base/pkg/x.json");
    }
}
