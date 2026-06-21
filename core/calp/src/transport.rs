//! FILENAME: core/calp/src/transport.rs
//! PURPOSE: The registry-transport abstraction (D8).
//! CONTEXT: `.calp` packages live behind a registry. Today the only registry is
//! a directory on disk (`LocalRegistry`). `RegistryTransport` is the seam that
//! lets a future HTTP registry slot in WITHOUT touching publish/pull/integrity:
//! those operate against `&dyn RegistryTransport`, never against the filesystem
//! directly. The HTTP implementation + auth are a LATER effort and explicitly
//! out of scope here — this file defines the contract and `LocalRegistry`
//! satisfies it (see the `impl RegistryTransport for LocalRegistry` in
//! registry.rs, which keeps access to the local-only path/atomic-write helpers).
//!
//! ARTIFACT ADDRESSING: artifacts are addressed by a version-relative path with
//! FORWARD SLASHES (e.g. `"sheets/{id}/data.json"`, `"modules/{id}.json"`),
//! exactly the keys used in the manifest's `artifact_checksums` map. A transport
//! maps that to its own storage (a path join for local; a URL for HTTP). The
//! checksummable artifact set returned by `list_artifacts` MUST exclude the
//! integrity root (`version-manifest.json`), its detached signature
//! (`version-manifest.sig`), and the subscriber-written `submissions/` subtree —
//! the same exclusion the integrity walk has always applied.

use crate::error::CalpError;
use crate::manifest::{PackageManifest, VersionManifest};
use crate::version::{SemVer, VersionPin};
use crate::writeback::WritebackSubmission;

/// Abstraction over a `.calp` registry. `LocalRegistry` is the only
/// implementation today; an HTTP registry is a future effort (out of scope).
///
/// publish/pull/integrity operate through this trait so the registry backend is
/// swappable. `&LocalRegistry` coerces to `&dyn RegistryTransport`, so existing
/// callers keep passing a `&LocalRegistry`.
pub trait RegistryTransport {
    // -----------------------------------------------------------------------
    // Package operations
    // -----------------------------------------------------------------------

    /// List all package names hosted by this registry.
    fn list_packages(&self) -> Result<Vec<String>, CalpError>;

    /// Get the package manifest for a named package.
    fn get_package_manifest(&self, package_name: &str) -> Result<PackageManifest, CalpError>;

    /// Write (replace) a package manifest atomically.
    fn write_package_manifest(&self, manifest: &PackageManifest) -> Result<(), CalpError>;

    // -----------------------------------------------------------------------
    // Version operations
    // -----------------------------------------------------------------------

    /// Get the version manifest for a specific version.
    fn get_version_manifest(
        &self,
        package_name: &str,
        version: &str,
    ) -> Result<VersionManifest, CalpError>;

    /// Write a version manifest atomically (creating the version if needed).
    fn write_version_manifest(
        &self,
        package_name: &str,
        version: &str,
        manifest: &VersionManifest,
    ) -> Result<(), CalpError>;

    /// Whether a specific version exists (keyed off its version manifest).
    fn version_exists(&self, package_name: &str, version: &str) -> bool;

    /// Resolve a version pin to the best matching concrete version.
    fn resolve_version(
        &self,
        package_name: &str,
        pin: &VersionPin,
    ) -> Result<SemVer, CalpError>;

    /// List all available versions for a package (sorted).
    fn list_versions(&self, package_name: &str) -> Result<Vec<SemVer>, CalpError>;

    // -----------------------------------------------------------------------
    // Artifacts — version-relative, forward-slash addressing
    // -----------------------------------------------------------------------

    /// Write an artifact at `rel_path` (version-relative, forward slashes)
    /// atomically. `pkg`/`ver` are validated at the registry boundary.
    fn write_artifact(
        &self,
        package_name: &str,
        version: &str,
        rel_path: &str,
        bytes: &[u8],
    ) -> Result<(), CalpError>;

    /// Read an artifact at `rel_path`. `Ok(None)` when the artifact is absent.
    fn read_artifact(
        &self,
        package_name: &str,
        version: &str,
        rel_path: &str,
    ) -> Result<Option<Vec<u8>>, CalpError>;

    /// List ALL checksummable artifact rel-paths under a version — forward
    /// slashes — EXCLUDING `version-manifest.json`, `version-manifest.sig`, and
    /// the `submissions/` subtree. This is exactly the set the integrity walk
    /// hashes; the manifest's `artifact_checksums` keys must match it.
    fn list_artifacts(
        &self,
        package_name: &str,
        version: &str,
    ) -> Result<Vec<String>, CalpError>;

    /// Remove a version's artifacts (for republish over crashed-publish debris).
    /// Replaces the `fs::remove_dir_all(ver_dir)` publish used to do directly.
    fn clear_version(&self, package_name: &str, version: &str) -> Result<(), CalpError>;

    /// Move a version's just-written artifacts into a content-addressed blob
    /// store, deduplicating bytes that repeat across versions (org-scale: a
    /// daily-published workbook only re-stores the artifacts that actually
    /// changed). Called by publish AFTER the signed `artifact_checksums` are
    /// computed; `checksums` maps each version-relative artifact path to its
    /// SHA-256, which is exactly the blob name. The manifest is unchanged, so
    /// signing/integrity are unaffected. Default: a no-op (the transport keeps
    /// per-version artifact files); the local transport overrides it to dedup.
    fn commit_artifacts_as_blobs(
        &self,
        _package_name: &str,
        _version: &str,
        _checksums: &std::collections::BTreeMap<String, String>,
    ) -> Result<(), CalpError> {
        Ok(())
    }

    /// Resolve a version-relative artifact path to an ABSOLUTE LOCAL FILESYSTEM
    /// path, when this transport is backed by the local filesystem. `None` for a
    /// non-local transport (e.g. a future HTTP registry, where there is no local
    /// file to hand out). The single fs-coupled escape hatch: the Tauri layer
    /// reads embedded BI model JSON (`models/{ds}/model.json`) lazily by path
    /// after pull. Those bytes are still covered by the integrity gate at pull;
    /// this only exposes WHERE they live for the local case. A future HTTP
    /// transport would instead surface model bytes through `read_artifact`.
    fn local_artifact_path(
        &self,
        _package_name: &str,
        _version: &str,
        _rel_path: &str,
    ) -> Result<Option<std::path::PathBuf>, CalpError> {
        Ok(None)
    }

    // -----------------------------------------------------------------------
    // Submissions (writeback) — a separate trust domain from publisher artifacts
    // -----------------------------------------------------------------------

    fn save_submission(
        &self,
        package_name: &str,
        version: &str,
        submission: &WritebackSubmission,
    ) -> Result<(), CalpError>;

    fn load_submissions(
        &self,
        package_name: &str,
        version: &str,
        submitter_id: &str,
    ) -> Result<Vec<WritebackSubmission>, CalpError>;

    fn load_region_submissions(
        &self,
        package_name: &str,
        version: &str,
        region_id: &str,
    ) -> Result<Vec<WritebackSubmission>, CalpError>;

    fn load_all_submissions(
        &self,
        package_name: &str,
        version: &str,
    ) -> Result<Vec<WritebackSubmission>, CalpError>;

    // -----------------------------------------------------------------------
    // Lock
    // -----------------------------------------------------------------------

    /// Acquire the registry's cross-process advisory lock, returned as an opaque
    /// guard. Hold it across a package-manifest read-modify-write so concurrent
    /// publishes can't lose a version-list update. Dropping the guard releases
    /// the lock. An HTTP transport would return a no-op guard; the local
    /// transport returns its `RegistryLock`.
    fn lock(&self) -> Result<Box<dyn std::any::Any>, CalpError>;
}
