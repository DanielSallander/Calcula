//! FILENAME: core/calp/src/transport.rs
//! PURPOSE: The workspace-transport abstraction (D8).
//! CONTEXT: `.calp` applications live behind a workspace. Today the only
//! workspace is a directory on disk (`LocalWorkspace`). `WorkspaceTransport` is
//! the seam that lets a future HTTP workspace slot in WITHOUT touching
//! publish/pull/integrity: those operate against `&dyn WorkspaceTransport`,
//! never against the filesystem directly. The HTTP implementation + auth are a
//! LATER effort and explicitly out of scope here — this file defines the
//! contract and `LocalWorkspace` satisfies it (see the
//! `impl WorkspaceTransport for LocalWorkspace` in workspace.rs, which keeps
//! access to the local-only path/atomic-write helpers).
//!
//! ARTIFACT ADDRESSING: artifacts are addressed by a version-relative path with
//! FORWARD SLASHES (e.g. `"sheets/{id}/data.json"`, `"modules/{id}.json"`),
//! exactly the keys used in the manifest's `artifact_checksums` map. A transport
//! maps that to its own storage (a path join for local; a URL for HTTP). The
//! checksummable artifact set returned by `list_artifacts` MUST exclude the
//! integrity root (`version-manifest.json`), its detached signature
//! (`version-manifest.sig`), and the post-publish `submissions/` + `reviews/`
//! event subtrees — the same exclusion the integrity walk has always applied.

use crate::error::CalpError;
use crate::manifest::{ApplicationManifest, VersionManifest};
use crate::version::{SemVer, VersionPin};
use crate::writeback::{ReviewEvent, WritebackSubmission};

/// Abstraction over a `.calp` workspace. `LocalWorkspace` is the only
/// implementation today; an HTTP workspace is a future effort (out of scope).
///
/// publish/pull/integrity operate through this trait so the workspace backend is
/// swappable. `&LocalWorkspace` coerces to `&dyn WorkspaceTransport`, so existing
/// callers keep passing a `&LocalWorkspace`.
pub trait WorkspaceTransport {
    // -----------------------------------------------------------------------
    // Application operations
    // -----------------------------------------------------------------------

    /// List all application names hosted by this workspace.
    fn list_applications(&self) -> Result<Vec<String>, CalpError>;

    /// Get the application manifest for a named application.
    fn get_application_manifest(&self, package_name: &str) -> Result<ApplicationManifest, CalpError>;

    /// Write (replace) an application manifest atomically.
    fn write_application_manifest(&self, manifest: &ApplicationManifest) -> Result<(), CalpError>;

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

    /// List all available versions for an application (sorted).
    fn list_versions(&self, package_name: &str) -> Result<Vec<SemVer>, CalpError>;

    // -----------------------------------------------------------------------
    // Artifacts — version-relative, forward-slash addressing
    // -----------------------------------------------------------------------

    /// Write an artifact at `rel_path` (version-relative, forward slashes)
    /// atomically. `pkg`/`ver` are validated at the workspace boundary.
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

    /// Read a file at the APPLICATION root — beside `calp-manifest.json`,
    /// outside any version.
    ///
    /// Versions are immutable, which is exactly right for content and exactly
    /// wrong for a statement about the application as a whole. The co-publisher
    /// list (`publishers.json`) lives here because adding a delegate must not
    /// require publishing a version, and because it applies to every version at
    /// once. It carries its own detached signature rather than riding in the
    /// per-version checksum map.
    ///
    /// Default: absent. A transport with no application-root storage answers
    /// "no list", which is the same as an application that has never had one.
    fn read_application_artifact(
        &self,
        _package_name: &str,
        _rel_path: &str,
    ) -> Result<Option<Vec<u8>>, CalpError> {
        Ok(None)
    }

    /// Write a file at the application root. Default: refuse, so a read-only
    /// transport says so instead of appearing to succeed.
    fn write_application_artifact(
        &self,
        _package_name: &str,
        _rel_path: &str,
        _bytes: &[u8],
    ) -> Result<(), CalpError> {
        Err(CalpError::Workspace(
            "this workspace cannot store application-level files".to_string(),
        ))
    }

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
    /// non-local transport (e.g. a future HTTP workspace, where there is no local
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
    // Submissions (writeback) — a separate trust domain from publisher
    // artifacts, stored as an APPEND-ONLY event log: submission events under
    // `submissions/{submitter}/`, publisher review events under `reviews/`.
    // No event path is ever written twice and no locking is ever used on
    // these paths (single-writer-per-path keeps shared/synced workspaces
    // conflict-free). The `load_current_*` methods return the deterministic
    // fold of those events (`calp::fold::fold_submissions`), which is the
    // ONLY current-state view readers should consume.
    // -----------------------------------------------------------------------

    /// Append a submission event. Every save — including a re-submit of the
    /// same cell — is a new immutable file keyed by the submission id.
    fn save_submission(
        &self,
        package_name: &str,
        version: &str,
        submission: &WritebackSubmission,
    ) -> Result<(), CalpError>;

    /// Append a publisher review event (`reviews/{id}.json`), targeting one
    /// submission event by id.
    fn save_review(
        &self,
        package_name: &str,
        version: &str,
        review: &ReviewEvent,
    ) -> Result<(), CalpError>;

    /// Raw review events for a version (hygiene filtered, never an error for
    /// a bad file).
    fn load_review_events(
        &self,
        package_name: &str,
        version: &str,
    ) -> Result<Vec<ReviewEvent>, CalpError>;

    /// Current (folded) submissions by one submitter.
    fn load_current_submissions_by(
        &self,
        package_name: &str,
        version: &str,
        submitter_id: &str,
    ) -> Result<Vec<WritebackSubmission>, CalpError>;

    /// Current (folded) submissions for one region across all submitters.
    fn load_current_region_submissions(
        &self,
        package_name: &str,
        version: &str,
        region_id: &str,
    ) -> Result<Vec<WritebackSubmission>, CalpError>;

    /// Current (folded) submissions for a whole version in one tree scan.
    fn load_current_submissions(
        &self,
        package_name: &str,
        version: &str,
    ) -> Result<Vec<WritebackSubmission>, CalpError>;

    // -----------------------------------------------------------------------
    // Lock
    // -----------------------------------------------------------------------

    /// Acquire the workspace's cross-process advisory lock, returned as an
    /// opaque guard. Hold it across an application-manifest read-modify-write
    /// so concurrent publishes can't lose a version-list update. Dropping the
    /// guard releases the lock. An HTTP transport would return a no-op guard;
    /// the local transport returns its `WorkspaceLock`.
    fn lock(&self) -> Result<Box<dyn std::any::Any>, CalpError>;
}

/// A boxed transport is itself a transport: forward every call to the inner
/// `dyn WorkspaceTransport`. This lets a factory return `Box<dyn WorkspaceTransport>`
/// (routing local vs HTTP at runtime) and callers keep passing `&workspace` where
/// `&dyn WorkspaceTransport` is expected — `&Box<dyn T>` coerces to `&dyn T` only
/// once `Box<dyn T>: T` holds. (Defaulted trait methods are forwarded explicitly
/// too, so a concrete transport's overrides — e.g. LocalWorkspace's blob dedup —
/// are preserved through the box.)
impl WorkspaceTransport for Box<dyn WorkspaceTransport> {
    fn list_applications(&self) -> Result<Vec<String>, CalpError> {
        (**self).list_applications()
    }
    fn get_application_manifest(&self, package_name: &str) -> Result<ApplicationManifest, CalpError> {
        (**self).get_application_manifest(package_name)
    }
    fn write_application_manifest(&self, manifest: &ApplicationManifest) -> Result<(), CalpError> {
        (**self).write_application_manifest(manifest)
    }
    fn get_version_manifest(
        &self,
        package_name: &str,
        version: &str,
    ) -> Result<VersionManifest, CalpError> {
        (**self).get_version_manifest(package_name, version)
    }
    fn write_version_manifest(
        &self,
        package_name: &str,
        version: &str,
        manifest: &VersionManifest,
    ) -> Result<(), CalpError> {
        (**self).write_version_manifest(package_name, version, manifest)
    }
    fn version_exists(&self, package_name: &str, version: &str) -> bool {
        (**self).version_exists(package_name, version)
    }
    fn resolve_version(
        &self,
        package_name: &str,
        pin: &VersionPin,
    ) -> Result<SemVer, CalpError> {
        (**self).resolve_version(package_name, pin)
    }
    fn list_versions(&self, package_name: &str) -> Result<Vec<SemVer>, CalpError> {
        (**self).list_versions(package_name)
    }
    fn write_artifact(
        &self,
        package_name: &str,
        version: &str,
        rel_path: &str,
        bytes: &[u8],
    ) -> Result<(), CalpError> {
        (**self).write_artifact(package_name, version, rel_path, bytes)
    }
    fn read_artifact(
        &self,
        package_name: &str,
        version: &str,
        rel_path: &str,
    ) -> Result<Option<Vec<u8>>, CalpError> {
        (**self).read_artifact(package_name, version, rel_path)
    }
    fn list_artifacts(
        &self,
        package_name: &str,
        version: &str,
    ) -> Result<Vec<String>, CalpError> {
        (**self).list_artifacts(package_name, version)
    }
    fn clear_version(&self, package_name: &str, version: &str) -> Result<(), CalpError> {
        (**self).clear_version(package_name, version)
    }
    fn commit_artifacts_as_blobs(
        &self,
        package_name: &str,
        version: &str,
        checksums: &std::collections::BTreeMap<String, String>,
    ) -> Result<(), CalpError> {
        (**self).commit_artifacts_as_blobs(package_name, version, checksums)
    }
    fn local_artifact_path(
        &self,
        package_name: &str,
        version: &str,
        rel_path: &str,
    ) -> Result<Option<std::path::PathBuf>, CalpError> {
        (**self).local_artifact_path(package_name, version, rel_path)
    }
    fn save_submission(
        &self,
        package_name: &str,
        version: &str,
        submission: &WritebackSubmission,
    ) -> Result<(), CalpError> {
        (**self).save_submission(package_name, version, submission)
    }
    fn save_review(
        &self,
        package_name: &str,
        version: &str,
        review: &ReviewEvent,
    ) -> Result<(), CalpError> {
        (**self).save_review(package_name, version, review)
    }
    fn load_review_events(
        &self,
        package_name: &str,
        version: &str,
    ) -> Result<Vec<ReviewEvent>, CalpError> {
        (**self).load_review_events(package_name, version)
    }
    fn load_current_submissions_by(
        &self,
        package_name: &str,
        version: &str,
        submitter_id: &str,
    ) -> Result<Vec<WritebackSubmission>, CalpError> {
        (**self).load_current_submissions_by(package_name, version, submitter_id)
    }
    fn load_current_region_submissions(
        &self,
        package_name: &str,
        version: &str,
        region_id: &str,
    ) -> Result<Vec<WritebackSubmission>, CalpError> {
        (**self).load_current_region_submissions(package_name, version, region_id)
    }
    fn load_current_submissions(
        &self,
        package_name: &str,
        version: &str,
    ) -> Result<Vec<WritebackSubmission>, CalpError> {
        (**self).load_current_submissions(package_name, version)
    }
    fn read_application_artifact(
        &self,
        package_name: &str,
        rel_path: &str,
    ) -> Result<Option<Vec<u8>>, CalpError> {
        (**self).read_application_artifact(package_name, rel_path)
    }
    fn write_application_artifact(
        &self,
        package_name: &str,
        rel_path: &str,
        bytes: &[u8],
    ) -> Result<(), CalpError> {
        (**self).write_application_artifact(package_name, rel_path, bytes)
    }
    fn lock(&self) -> Result<Box<dyn std::any::Any>, CalpError> {
        (**self).lock()
    }
}
