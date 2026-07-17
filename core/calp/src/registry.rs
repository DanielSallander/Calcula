//! FILENAME: core/calp/src/registry.rs
//! PURPOSE: Local filesystem registry adapter.
//! CONTEXT: A registry is a directory on disk that hosts .calp packages.
//! Each package is a subdirectory containing calp-manifest.json and
//! version directories with the published content.

use std::path::{Path, PathBuf};
use std::fs;
use std::time::Duration;

use crate::error::CalpError;
use crate::integrity::{VERSION_MANIFEST_FILE, VERSION_MANIFEST_SIG_FILE};
use crate::manifest::PackageManifest;
#[cfg(test)]
use crate::manifest::VersionEntry;
use crate::manifest::VersionManifest;
use crate::transport::RegistryTransport;
use crate::version::{SemVer, VersionPin};
use crate::writeback::WritebackSubmission;

// ---------------------------------------------------------------------------
// D7 — registry robustness primitives
// ---------------------------------------------------------------------------

/// Validate a single path component (package name, version, submitter id) that
/// originates from a third-party package manifest or a spoofable identity file
/// before it is joined into a filesystem path. Rejects anything that could
/// escape the registry root or otherwise be unsafe as a directory name:
/// empty, `.`/`..`, path separators, drive/root markers, and control chars.
pub fn validate_component(component: &str, kind: &str) -> Result<(), CalpError> {
    let invalid = |reason: &str| {
        Err(CalpError::Registry(format!(
            "Invalid {kind} '{component}': {reason}"
        )))
    };
    if component.is_empty() {
        return invalid("must not be empty");
    }
    if component == "." || component == ".." {
        return invalid("must not be '.' or '..'");
    }
    if component.contains('/') || component.contains('\\') {
        return invalid("must not contain a path separator");
    }
    if component.contains('\0') {
        return invalid("must not contain a null byte");
    }
    // A leading drive letter ("C:") or other colon, and any control char, are
    // rejected — they enable absolute/alternate-stream paths on Windows.
    if component.contains(':') {
        return invalid("must not contain ':'");
    }
    if component.chars().any(|c| c.is_control()) {
        return invalid("must not contain control characters");
    }
    Ok(())
}

/// Atomically write `content` to `path` by writing a sibling temp file and
/// renaming it into place, so a crash or concurrent reader never observes a
/// torn/partial file. The temp file lives in the SAME directory as the target
/// so the rename stays on one filesystem (rename across filesystems fails).
fn atomic_write(path: &Path, content: &[u8]) -> Result<(), CalpError> {
    let parent = path
        .parent()
        .ok_or_else(|| CalpError::Registry(format!("path has no parent: {}", path.display())))?;
    fs::create_dir_all(parent)?;
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| CalpError::Registry(format!("path has no file name: {}", path.display())))?;
    let tmp = parent.join(format!(".{file_name}.tmp"));
    fs::write(&tmp, content)?;
    // rename is atomic on the same filesystem; on Windows it also replaces an
    // existing destination (fs::rename uses MoveFileEx with REPLACE_EXISTING).
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e.into())
        }
    }
}

/// A best-effort cross-process advisory lock over a registry, used to serialize
/// the package-manifest read-modify-write so concurrent publishes don't lose a
/// version-list update. Acquired by exclusively creating a lockfile; released on
/// drop. A lockfile older than `STALE` is treated as abandoned (crashed holder)
/// and stolen so a crash can never deadlock the registry forever.
pub struct RegistryLock {
    path: PathBuf,
}

impl RegistryLock {
    const STALE: Duration = Duration::from_secs(30);

    pub fn acquire(root: &Path) -> Result<Self, CalpError> {
        let path = root.join(".calp-lock");
        let start = std::time::Instant::now();
        // Wait up to STALE + a margin: within this window a LIVE holder either
        // releases (we then create the lock) or its lockfile ages past STALE and
        // we steal it. Bounding the wait by STALE — not a fixed iteration count —
        // means we never fail spuriously while another process legitimately holds
        // the lock (the bug was a 5s iteration budget vs a 30s stale threshold).
        let max_wait = Self::STALE + Duration::from_secs(5);
        loop {
            match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(_) => return Ok(RegistryLock { path }),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    // Steal an abandoned lock (holder crashed) rather than wait forever.
                    if let Ok(meta) = fs::metadata(&path) {
                        if let Ok(modified) = meta.modified() {
                            if modified.elapsed().map(|d| d > Self::STALE).unwrap_or(false) {
                                let _ = fs::remove_file(&path);
                                continue;
                            }
                        }
                    }
                    if start.elapsed() > max_wait {
                        return Err(CalpError::Registry(
                            "could not acquire registry lock (timed out)".to_string(),
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(e) => return Err(e.into()),
            }
        }
    }
}

impl Drop for RegistryLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

/// Local filesystem registry adapter.
///
/// Directory layout:
/// ```text
/// {registry_root}/
///   {package-name}/
///     calp-manifest.json
///     {version}/
///       version-manifest.json
///       sheets/...
///       named_ranges.json
///       tables/...
/// ```
pub struct LocalRegistry {
    root: PathBuf,
}

impl LocalRegistry {
    /// Open or create a registry at the given path.
    pub fn open(root: &Path) -> Result<Self, CalpError> {
        if !root.exists() {
            fs::create_dir_all(root)?;
        }
        Ok(Self { root: root.to_path_buf() })
    }

    /// Get the root path of this registry.
    pub fn root(&self) -> &Path {
        &self.root
    }

    // -----------------------------------------------------------------------
    // Package operations
    // -----------------------------------------------------------------------

    /// List all package names in the registry.
    pub fn list_packages(&self) -> Result<Vec<String>, CalpError> {
        let mut names = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                let manifest_path = entry.path().join("calp-manifest.json");
                if manifest_path.exists() {
                    if let Some(name) = entry.file_name().to_str() {
                        names.push(name.to_string());
                    }
                }
            }
        }
        names.sort();
        Ok(names)
    }

    /// Get the package manifest for a named package.
    pub fn get_package_manifest(&self, package_name: &str) -> Result<PackageManifest, CalpError> {
        let path = self.package_dir(package_name)?.join("calp-manifest.json");
        if !path.exists() {
            return Err(CalpError::PackageNotFound(package_name.to_string()));
        }
        let content = fs::read_to_string(&path)?;
        let manifest: PackageManifest = serde_json::from_str(&content)?;
        Ok(manifest)
    }

    /// Write a package manifest (atomically — D7).
    pub fn write_package_manifest(&self, manifest: &PackageManifest) -> Result<(), CalpError> {
        let path = self.package_dir(&manifest.name)?.join("calp-manifest.json");
        let content = serde_json::to_string_pretty(manifest)?;
        atomic_write(&path, content.as_bytes())
    }

    /// Acquire the registry's cross-process advisory lock (D7). Hold it across a
    /// package-manifest read-modify-write (get_package_manifest -> mutate ->
    /// write_package_manifest) so concurrent publishes can't lose a version-list
    /// update. Released when the returned guard is dropped.
    pub fn lock(&self) -> Result<RegistryLock, CalpError> {
        RegistryLock::acquire(&self.root)
    }

    // -----------------------------------------------------------------------
    // Version operations
    // -----------------------------------------------------------------------

    /// Get the version manifest for a specific version.
    pub fn get_version_manifest(
        &self,
        package_name: &str,
        version: &str,
    ) -> Result<VersionManifest, CalpError> {
        let path = self.version_dir(package_name, version)?.join("version-manifest.json");
        if !path.exists() {
            return Err(CalpError::VersionNotFound {
                package: package_name.to_string(),
                version: version.to_string(),
            });
        }
        let content = fs::read_to_string(&path)?;
        let manifest: VersionManifest = serde_json::from_str(&content)?;
        Ok(manifest)
    }

    /// Write a version manifest atomically and create the version directory (D7).
    pub fn write_version_manifest(
        &self,
        package_name: &str,
        version: &str,
        manifest: &VersionManifest,
    ) -> Result<(), CalpError> {
        let path = self.version_dir(package_name, version)?.join("version-manifest.json");
        let content = serde_json::to_string_pretty(manifest)?;
        atomic_write(&path, content.as_bytes())
    }

    /// Get the directory path for a version's sheet data. (sheet_id is a UUID v7,
    /// already path-safe; package_name/version are validated by version_dir.)
    pub fn sheet_dir(
        &self,
        package_name: &str,
        version: &str,
        sheet_id: &identity::SheetId,
    ) -> Result<PathBuf, CalpError> {
        Ok(self
            .version_dir(package_name, version)?
            .join("sheets")
            .join(sheet_id.to_string()))
    }

    /// Get the tables directory for a version.
    pub fn tables_dir(&self, package_name: &str, version: &str) -> Result<PathBuf, CalpError> {
        Ok(self.version_dir(package_name, version)?.join("tables"))
    }

    /// Get the object scripts directory for a version.
    pub fn scripts_dir(&self, package_name: &str, version: &str) -> Result<PathBuf, CalpError> {
        Ok(self.version_dir(package_name, version)?.join("object_scripts"))
    }

    /// Get the standalone module-scripts directory for a version (C8).
    /// Each module script is stored as `modules/{id}.json` (ScriptDef JSON).
    pub fn modules_dir(&self, package_name: &str, version: &str) -> Result<PathBuf, CalpError> {
        Ok(self.version_dir(package_name, version)?.join("modules"))
    }

    /// Get the standalone notebooks directory for a version (C8).
    /// Each notebook is stored as `notebooks/{id}.json` (NotebookDef JSON,
    /// execution metadata stripped at publish time).
    pub fn notebooks_dir(&self, package_name: &str, version: &str) -> Result<PathBuf, CalpError> {
        Ok(self.version_dir(package_name, version)?.join("notebooks"))
    }

    /// Resolve a version pin to the best matching version.
    pub fn resolve_version(
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

    /// List all available versions for a package (as SemVer, sorted).
    pub fn list_versions(&self, package_name: &str) -> Result<Vec<SemVer>, CalpError> {
        let manifest = self.get_package_manifest(package_name)?;
        let mut versions = manifest.parsed_versions();
        versions.sort();
        Ok(versions)
    }

    /// Check if a specific version exists.
    pub fn version_exists(&self, package_name: &str, version: &str) -> bool {
        self.version_dir(package_name, version)
            .map(|d| d.join("version-manifest.json").exists())
            .unwrap_or(false)
    }

    // -----------------------------------------------------------------------
    // Submission storage — append-only event log
    //
    // Every submission and every publisher review decision is its own
    // immutable file; nothing under `submissions/` or `reviews/` is ever
    // rewritten or deleted in normal operation, and each path has exactly ONE
    // writer (a submission event: the owning submitter; a review event: the
    // publisher). Shared/synced storage (SMB, Dropbox) therefore can never
    // lose an update or produce a meaningful "conflicted copy" — a sync
    // client only ever sees new files appear. Current state is derived by the
    // deterministic fold (`crate::fold::fold_submissions`); there is
    // deliberately NO locking anywhere on these paths (locks are what break
    // sync clients).
    // -----------------------------------------------------------------------

    /// Charset gate for id-like filename fragments that originate from
    /// third-party content (region ids, submission/review ids).
    fn path_safe_fragment(s: &str) -> bool {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    }

    /// Append a submission EVENT (creates the submitter directory if needed).
    ///
    /// The filename embeds the submission id, so every save — including a
    /// re-submit of the same cell — is a NEW file. Grid events are named
    /// `{region}_{row}_{col}_{id}.json`; model-keyed events (writeback
    /// COLUMNS, engine v21) are named `{region}_{key-hash16}_{id}.json` so a
    /// row's history sorts together on disk (cosmetic; loaders re-derive
    /// grouping from `model_key`). The fold collapses grid slots to the
    /// newest event; model events all remain records.
    pub fn save_submission(
        &self,
        package_name: &str,
        version: &str,
        submission: &crate::writeback::WritebackSubmission,
    ) -> Result<(), CalpError> {
        // Both filename fragments originate from third-party content — reject
        // anything that could escape the submissions directory. (Package /
        // version / submitter components get the same treatment under the D7
        // boundary work, via `submissions_dir`.)
        if !Self::path_safe_fragment(&submission.region_id) {
            return Err(CalpError::Registry(format!(
                "Invalid writeback region id '{}': only alphanumerics, '-' and '_' are allowed",
                submission.region_id
            )));
        }
        if !Self::path_safe_fragment(&submission.id) {
            return Err(CalpError::Registry(format!(
                "Invalid submission id '{}': only alphanumerics, '-' and '_' are allowed",
                submission.id
            )));
        }

        let file_name = match submission.model_key.as_deref() {
            None => format!(
                "{}_{}_{}_{}.json",
                submission.region_id, submission.cell_row, submission.cell_col, submission.id
            ),
            Some(key) => {
                // Stable 16-hex digest of the canonical key tuple.
                use std::hash::{Hash, Hasher};
                let mut hasher = std::collections::hash_map::DefaultHasher::new();
                for part in key {
                    part.hash(&mut hasher);
                    0x1fu8.hash(&mut hasher); // unit separator: ["ab","c"] != ["a","bc"]
                }
                format!(
                    "{}_{:016x}_{}.json",
                    submission.region_id,
                    hasher.finish(),
                    submission.id
                )
            }
        };

        let sub_dir = self.submissions_dir(package_name, version, &submission.submitter.id)?;
        let content = serde_json::to_string_pretty(submission)?;
        atomic_write(&sub_dir.join(file_name), content.as_bytes())
    }

    /// Append a publisher REVIEW event: `reviews/{id}.json` under the version
    /// directory — the publisher-written subtree, never a submitter's. The
    /// decision applies to exactly one submission event (by id); the fold
    /// ignores reviews whose target has been superseded by a re-submit.
    pub fn save_review(
        &self,
        package_name: &str,
        version: &str,
        review: &crate::writeback::ReviewEvent,
    ) -> Result<(), CalpError> {
        if !Self::path_safe_fragment(&review.id) {
            return Err(CalpError::Registry(format!(
                "Invalid review id '{}': only alphanumerics, '-' and '_' are allowed",
                review.id
            )));
        }
        let path = self
            .version_dir(package_name, version)?
            .join("reviews")
            .join(format!("{}.json", review.id));
        let content = serde_json::to_string_pretty(review)?;
        atomic_write(&path, content.as_bytes())
    }

    /// Load the RAW submission events written by one submitter, hygiene
    /// filtered. Acceptance is strict and everything else is SKIPPED, never an
    /// error — a single torn write, sync-client "conflicted copy" rename,
    /// `.tmp` debris file, or legacy/foreign file must never take down the
    /// publisher inbox, GATHER, or a BI feed:
    /// - the filename must end `.json` and not start with `.`
    /// - the content must parse as a `WritebackSubmission`
    /// - the filename stem must end `_{content.id}` (a renamed duplicate —
    ///   e.g. "x (conflicted copy).json" — no longer matches its content)
    /// - the content's `submitter.id` must equal the directory name (a file
    ///   cannot claim another submitter's identity)
    pub fn load_submission_events_by(
        &self,
        package_name: &str,
        version: &str,
        submitter_id: &str,
    ) -> Result<Vec<WritebackSubmission>, CalpError> {
        let sub_dir = self.submissions_dir(package_name, version, submitter_id)?;
        let mut events = Vec::new();
        if !sub_dir.exists() {
            return Ok(events);
        }
        for entry in fs::read_dir(&sub_dir)? {
            let Ok(entry) = entry else { continue };
            let path = entry.path();
            if !path.extension().map_or(false, |ext| ext == "json") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if stem.starts_with('.') {
                continue;
            }
            let Ok(content) = fs::read_to_string(&path) else {
                continue;
            };
            let Ok(sub) = serde_json::from_str::<WritebackSubmission>(&content) else {
                continue;
            };
            if sub.id.is_empty() || !stem.ends_with(&format!("_{}", sub.id)) {
                continue;
            }
            if sub.submitter.id != submitter_id {
                continue;
            }
            events.push(sub);
        }
        Ok(events)
    }

    /// Load the RAW submission events for a package version across all
    /// submitter directories in one tree scan (hygiene filtered; see
    /// `load_submission_events_by`).
    pub fn load_submission_events(
        &self,
        package_name: &str,
        version: &str,
    ) -> Result<Vec<WritebackSubmission>, CalpError> {
        let base = self.version_dir(package_name, version)?.join("submissions");
        let mut all = Vec::new();
        if !base.exists() {
            return Ok(all);
        }
        for entry in fs::read_dir(&base)? {
            let Ok(entry) = entry else { continue };
            let Ok(file_type) = entry.file_type() else { continue };
            if !file_type.is_dir() {
                continue;
            }
            let submitter_id = entry.file_name().to_string_lossy().to_string();
            // The submitter-id directory name is untrusted input read off
            // disk — skip any that wouldn't pass the boundary validator.
            if validate_component(&submitter_id, "submitter id").is_err() {
                continue;
            }
            all.extend(self.load_submission_events_by(package_name, version, &submitter_id)?);
        }
        Ok(all)
    }

    /// Load the RAW review events for a package version (hygiene filtered:
    /// `.json`, non-dot, parseable, filename stem == content id).
    pub fn load_review_events(
        &self,
        package_name: &str,
        version: &str,
    ) -> Result<Vec<crate::writeback::ReviewEvent>, CalpError> {
        let dir = self.version_dir(package_name, version)?.join("reviews");
        let mut reviews = Vec::new();
        if !dir.exists() {
            return Ok(reviews);
        }
        for entry in fs::read_dir(&dir)? {
            let Ok(entry) = entry else { continue };
            let path = entry.path();
            if !path.extension().map_or(false, |ext| ext == "json") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if stem.starts_with('.') {
                continue;
            }
            let Ok(content) = fs::read_to_string(&path) else {
                continue;
            };
            let Ok(review) = serde_json::from_str::<crate::writeback::ReviewEvent>(&content)
            else {
                continue;
            };
            if review.id != stem {
                continue;
            }
            reviews.push(review);
        }
        Ok(reviews)
    }

    /// Load the CURRENT submissions for a package version: the raw events
    /// folded through `crate::fold::fold_submissions` (grid slots collapse to
    /// the newest event, model events all remain, review state is derived
    /// from review events — see the fold's doc for the exact rules). Callers
    /// that need several regions should use this and bucket by region_id —
    /// the region variant rescans the whole tree each time.
    pub fn load_current_submissions(
        &self,
        package_name: &str,
        version: &str,
    ) -> Result<Vec<WritebackSubmission>, CalpError> {
        let events = self.load_submission_events(package_name, version)?;
        let reviews = self.load_review_events(package_name, version)?;
        Ok(crate::fold::fold_submissions(events, &reviews))
    }

    /// Current submissions by one submitter (the fold scoped to their events;
    /// reviews are loaded version-wide).
    pub fn load_current_submissions_by(
        &self,
        package_name: &str,
        version: &str,
        submitter_id: &str,
    ) -> Result<Vec<WritebackSubmission>, CalpError> {
        let events = self.load_submission_events_by(package_name, version, submitter_id)?;
        let reviews = self.load_review_events(package_name, version)?;
        Ok(crate::fold::fold_submissions(events, &reviews))
    }

    /// Current submissions for one region across all submitters.
    pub fn load_current_region_submissions(
        &self,
        package_name: &str,
        version: &str,
        region_id: &str,
    ) -> Result<Vec<WritebackSubmission>, CalpError> {
        Ok(self
            .load_current_submissions(package_name, version)?
            .into_iter()
            .filter(|s| s.region_id == region_id)
            .collect())
    }

    // -----------------------------------------------------------------------
    // Artifact storage (D8 — RegistryTransport surface)
    // -----------------------------------------------------------------------

    /// Resolve a version-relative artifact path (forward slashes) to an absolute
    /// on-disk path under the version directory. `package_name`/`version` are
    /// validated at the registry boundary (D7) via `version_dir`. The rel_path
    /// itself is a publisher-controlled string, so reject any component that
    /// could escape the version directory ('..', absolute markers, etc.) — the
    /// same boundary the directory names get.
    fn artifact_path(
        &self,
        package_name: &str,
        version: &str,
        rel_path: &str,
    ) -> Result<PathBuf, CalpError> {
        let mut path = self.version_dir(package_name, version)?;
        let mut any = false;
        for component in rel_path.split('/') {
            if component.is_empty() {
                continue;
            }
            // Each segment is validated like any other untrusted path component:
            // rejects "", ".", "..", separators, ':', null/control chars.
            validate_component(component, "artifact path component")?;
            path.push(component);
            any = true;
        }
        if !any {
            return Err(CalpError::Registry(format!(
                "Invalid artifact path '{rel_path}': must name a file"
            )));
        }
        Ok(path)
    }

    /// Write an artifact atomically at a version-relative path.
    pub fn write_artifact(
        &self,
        package_name: &str,
        version: &str,
        rel_path: &str,
        bytes: &[u8],
    ) -> Result<(), CalpError> {
        let path = self.artifact_path(package_name, version, rel_path)?;
        atomic_write(&path, bytes)
    }

    /// Read an artifact at a version-relative path; `Ok(None)` when absent.
    ///
    /// Dir-first, blob-fallback: at publish time (before dedup) artifacts live in
    /// the version directory; after publish they are moved to the shared
    /// content-addressed blob store, so on a dir miss we resolve `rel_path` ->
    /// hash via the (signed) version manifest and read the blob. Callers
    /// (pull/integrity) are unchanged — the dedup is transparent.
    pub fn read_artifact(
        &self,
        package_name: &str,
        version: &str,
        rel_path: &str,
    ) -> Result<Option<Vec<u8>>, CalpError> {
        let path = self.artifact_path(package_name, version, rel_path)?;
        match fs::read(&path) {
            Ok(bytes) => return Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        // Deduped artifact: resolve via the manifest's checksum map (rel -> hash)
        // and read the blob. A missing manifest means the artifact is absent.
        let manifest = match self.get_version_manifest(package_name, version) {
            Ok(m) => m,
            Err(_) => return Ok(None),
        };
        match manifest.artifact_checksums.get(rel_path) {
            Some(hash) => self.read_blob(hash),
            None => Ok(None),
        }
    }

    /// Path of a content-addressed blob. Blobs are shared across ALL packages and
    /// versions, so identical artifact bytes are stored once. Sharded by the
    /// first two hex chars to keep directories small. The hash is validated as
    /// hex so it can never escape the blob root.
    fn blob_path(&self, hash: &str) -> Result<PathBuf, CalpError> {
        if hash.len() < 4 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(CalpError::Registry(format!("invalid blob hash '{hash}'")));
        }
        Ok(self.root.join(".blobs").join(&hash[0..2]).join(hash))
    }

    /// Write a blob, keyed by its content hash. Idempotent: a blob that already
    /// exists is left as-is (the dedup that makes org-scale storage bounded).
    pub fn write_blob(&self, hash: &str, bytes: &[u8]) -> Result<(), CalpError> {
        let path = self.blob_path(hash)?;
        if path.exists() {
            return Ok(());
        }
        atomic_write(&path, bytes)
    }

    /// Read a blob by content hash; `Ok(None)` when absent.
    pub fn read_blob(&self, hash: &str) -> Result<Option<Vec<u8>>, CalpError> {
        let path = self.blob_path(hash)?;
        match fs::read(&path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Move a version's per-version artifacts into the content-addressed blob
    /// store (dedup) and remove the per-version copies, leaving only the manifest
    /// and its signature in the version directory. Idempotent: an artifact whose
    /// per-version copy is already gone (re-run) is skipped.
    pub fn commit_artifacts_as_blobs(
        &self,
        package_name: &str,
        version: &str,
        checksums: &std::collections::BTreeMap<String, String>,
    ) -> Result<(), CalpError> {
        for (rel, hash) in checksums {
            let path = self.artifact_path(package_name, version, rel)?;
            let bytes = match fs::read(&path) {
                Ok(b) => b,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e.into()),
            };
            self.write_blob(hash, &bytes)?;
            let _ = fs::remove_file(&path);
        }
        Ok(())
    }

    /// List ALL checksummable artifact rel-paths under a version (forward
    /// slashes), EXCLUDING `version-manifest.json`, `version-manifest.sig`, and
    /// the post-publish `submissions/` + `reviews/` subtrees — the exact set
    /// the integrity walk hashes.
    pub fn list_artifacts(
        &self,
        package_name: &str,
        version: &str,
    ) -> Result<Vec<String>, CalpError> {
        let base = self.version_dir(package_name, version)?;
        let mut out = Vec::new();
        if !base.exists() {
            return Ok(out);
        }
        for entry in fs::read_dir(&base)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if file_type.is_file() {
                // The manifest is the integrity root; its detached signature
                // seals that root. Neither is a listed artifact.
                if name_str == VERSION_MANIFEST_FILE || name_str == VERSION_MANIFEST_SIG_FILE {
                    continue;
                }
                out.push(name_str.into_owned());
            } else if file_type.is_dir() {
                // Post-publish event subtrees (subscriber submissions,
                // publisher reviews) are a separate trust domain.
                if crate::integrity::POST_PUBLISH_DIRS.contains(&name_str.as_ref()) {
                    continue;
                }
                Self::list_artifacts_walk(&entry.path(), &base, &mut out)?;
            }
        }
        out.sort();
        Ok(out)
    }

    fn list_artifacts_walk(
        dir: &Path,
        base: &Path,
        out: &mut Vec<String>,
    ) -> Result<(), CalpError> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            let path = entry.path();
            if file_type.is_dir() {
                Self::list_artifacts_walk(&path, base, out)?;
            } else if file_type.is_file() {
                let rel = path.strip_prefix(base).map_err(|e| {
                    CalpError::Registry(format!(
                        "Artifact path {} escapes version directory: {}",
                        path.display(),
                        e
                    ))
                })?;
                let rel_str = rel
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/");
                out.push(rel_str);
            }
        }
        Ok(())
    }

    /// Remove a version's artifacts (used to clear crashed-publish debris before
    /// a republish). No-op if the version directory does not exist.
    pub fn clear_version(&self, package_name: &str, version: &str) -> Result<(), CalpError> {
        let ver_dir = self.version_dir(package_name, version)?;
        if ver_dir.exists() {
            fs::remove_dir_all(&ver_dir)?;
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Helper paths
    // -----------------------------------------------------------------------

    fn package_dir(&self, package_name: &str) -> Result<PathBuf, CalpError> {
        validate_component(package_name, "package name")?;
        Ok(self.root.join(package_name))
    }

    /// Get the directory path for a specific package version.
    /// Public so publish/pull can write and verify artifacts in place.
    /// Validates `package_name` + `version` at the registry boundary (D7).
    pub fn version_dir(&self, package_name: &str, version: &str) -> Result<PathBuf, CalpError> {
        validate_component(version, "version")?;
        Ok(self.package_dir(package_name)?.join(version))
    }

    fn submissions_dir(
        &self,
        package_name: &str,
        version: &str,
        submitter_id: &str,
    ) -> Result<PathBuf, CalpError> {
        validate_component(submitter_id, "submitter id")?;
        Ok(self
            .version_dir(package_name, version)?
            .join("submissions")
            .join(submitter_id))
    }
}

// ---------------------------------------------------------------------------
// D8 — LocalRegistry is one RegistryTransport implementation behind the seam.
// Every method delegates to the inherent fs implementation above; an HTTP
// transport is a later effort (out of scope) and slots in here without
// touching publish/pull/integrity, which operate on `&dyn RegistryTransport`.
// ---------------------------------------------------------------------------
impl RegistryTransport for LocalRegistry {
    fn list_packages(&self) -> Result<Vec<String>, CalpError> {
        LocalRegistry::list_packages(self)
    }

    fn get_package_manifest(&self, package_name: &str) -> Result<PackageManifest, CalpError> {
        LocalRegistry::get_package_manifest(self, package_name)
    }

    fn write_package_manifest(&self, manifest: &PackageManifest) -> Result<(), CalpError> {
        LocalRegistry::write_package_manifest(self, manifest)
    }

    fn get_version_manifest(
        &self,
        package_name: &str,
        version: &str,
    ) -> Result<VersionManifest, CalpError> {
        LocalRegistry::get_version_manifest(self, package_name, version)
    }

    fn write_version_manifest(
        &self,
        package_name: &str,
        version: &str,
        manifest: &VersionManifest,
    ) -> Result<(), CalpError> {
        LocalRegistry::write_version_manifest(self, package_name, version, manifest)
    }

    fn version_exists(&self, package_name: &str, version: &str) -> bool {
        LocalRegistry::version_exists(self, package_name, version)
    }

    fn resolve_version(
        &self,
        package_name: &str,
        pin: &VersionPin,
    ) -> Result<SemVer, CalpError> {
        LocalRegistry::resolve_version(self, package_name, pin)
    }

    fn list_versions(&self, package_name: &str) -> Result<Vec<SemVer>, CalpError> {
        LocalRegistry::list_versions(self, package_name)
    }

    fn write_artifact(
        &self,
        package_name: &str,
        version: &str,
        rel_path: &str,
        bytes: &[u8],
    ) -> Result<(), CalpError> {
        LocalRegistry::write_artifact(self, package_name, version, rel_path, bytes)
    }

    fn read_artifact(
        &self,
        package_name: &str,
        version: &str,
        rel_path: &str,
    ) -> Result<Option<Vec<u8>>, CalpError> {
        LocalRegistry::read_artifact(self, package_name, version, rel_path)
    }

    fn list_artifacts(
        &self,
        package_name: &str,
        version: &str,
    ) -> Result<Vec<String>, CalpError> {
        LocalRegistry::list_artifacts(self, package_name, version)
    }

    fn clear_version(&self, package_name: &str, version: &str) -> Result<(), CalpError> {
        LocalRegistry::clear_version(self, package_name, version)
    }

    fn commit_artifacts_as_blobs(
        &self,
        package_name: &str,
        version: &str,
        checksums: &std::collections::BTreeMap<String, String>,
    ) -> Result<(), CalpError> {
        LocalRegistry::commit_artifacts_as_blobs(self, package_name, version, checksums)
    }

    fn local_artifact_path(
        &self,
        package_name: &str,
        version: &str,
        rel_path: &str,
    ) -> Result<Option<PathBuf>, CalpError> {
        // Validated like any artifact path (D7 boundary). Dir-first (pre-dedup),
        // blob-fallback: after dedup the bytes live in the content-addressed blob
        // store, so resolve rel-path -> hash via the manifest and hand out the
        // blob path. Keeps the lazy model.json read working post-dedup.
        let dir_path = self.artifact_path(package_name, version, rel_path)?;
        if dir_path.exists() {
            return Ok(Some(dir_path));
        }
        let manifest = match self.get_version_manifest(package_name, version) {
            Ok(m) => m,
            Err(_) => return Ok(Some(dir_path)),
        };
        match manifest.artifact_checksums.get(rel_path) {
            Some(hash) => Ok(Some(self.blob_path(hash)?)),
            None => Ok(Some(dir_path)),
        }
    }

    fn save_submission(
        &self,
        package_name: &str,
        version: &str,
        submission: &WritebackSubmission,
    ) -> Result<(), CalpError> {
        LocalRegistry::save_submission(self, package_name, version, submission)
    }

    fn save_review(
        &self,
        package_name: &str,
        version: &str,
        review: &crate::writeback::ReviewEvent,
    ) -> Result<(), CalpError> {
        LocalRegistry::save_review(self, package_name, version, review)
    }

    fn load_review_events(
        &self,
        package_name: &str,
        version: &str,
    ) -> Result<Vec<crate::writeback::ReviewEvent>, CalpError> {
        LocalRegistry::load_review_events(self, package_name, version)
    }

    fn load_current_submissions_by(
        &self,
        package_name: &str,
        version: &str,
        submitter_id: &str,
    ) -> Result<Vec<WritebackSubmission>, CalpError> {
        LocalRegistry::load_current_submissions_by(self, package_name, version, submitter_id)
    }

    fn load_current_region_submissions(
        &self,
        package_name: &str,
        version: &str,
        region_id: &str,
    ) -> Result<Vec<WritebackSubmission>, CalpError> {
        LocalRegistry::load_current_region_submissions(self, package_name, version, region_id)
    }

    fn load_current_submissions(
        &self,
        package_name: &str,
        version: &str,
    ) -> Result<Vec<WritebackSubmission>, CalpError> {
        LocalRegistry::load_current_submissions(self, package_name, version)
    }

    fn lock(&self) -> Result<Box<dyn std::any::Any>, CalpError> {
        Ok(Box::new(RegistryLock::acquire(&self.root)?))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_test_registry() -> (TempDir, LocalRegistry) {
        let dir = TempDir::new().unwrap();
        let reg = LocalRegistry::open(dir.path()).unwrap();
        (dir, reg)
    }

    fn create_test_package(reg: &LocalRegistry, name: &str) -> PackageManifest {
        let mut manifest = PackageManifest::new(name, "report", "test-author", "2026-01-01T00:00:00Z");
        manifest.description = format!("Test package: {}", name);
        reg.write_package_manifest(&manifest).unwrap();
        manifest
    }

    #[test]
    fn list_empty_registry() {
        let (_dir, reg) = create_test_registry();
        assert_eq!(reg.list_packages().unwrap(), Vec::<String>::new());
    }

    #[test]
    fn create_and_list_packages() {
        let (_dir, reg) = create_test_registry();
        create_test_package(&reg, "alpha");
        create_test_package(&reg, "beta");

        let packages = reg.list_packages().unwrap();
        assert_eq!(packages, vec!["alpha", "beta"]);
    }

    #[test]
    fn read_package_manifest() {
        let (_dir, reg) = create_test_registry();
        create_test_package(&reg, "my-package");

        let manifest = reg.get_package_manifest("my-package").unwrap();
        assert_eq!(manifest.name, "my-package");
        assert_eq!(manifest.kind, "report");
        assert_eq!(manifest.author, "test-author");
    }

    #[test]
    fn package_not_found() {
        let (_dir, reg) = create_test_registry();
        let result = reg.get_package_manifest("nonexistent");
        assert!(matches!(result, Err(CalpError::PackageNotFound(_))));
    }

    #[test]
    fn write_and_read_version_manifest() {
        let (_dir, reg) = create_test_registry();
        create_test_package(&reg, "pkg");

        let sheet_id = identity::SheetId::from_bytes(identity::generate_uuid_v7());
        let ver_manifest = VersionManifest {
            model_writebacks: None,
            format_version: 1,
            package_name: "pkg".to_string(),
            version: "1.0.0".to_string(),
            kind: "report".to_string(),
            published_at: "2026-01-01T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            publisher_key: String::new(),
            publisher_name: String::new(),
            min_app_version: String::new(),
            sheets: vec![crate::manifest::PublishedSheet {
                sheet_id,
                name: "Dashboard".to_string(),
                description: String::new(),
                extra: std::collections::HashMap::new(),
            }],
            named_ranges: Vec::new(),
            tables: Vec::new(),
            locked_sheets: Vec::new(),
            locked_cells: Vec::new(),
            writeback_regions: None,
            object_scripts: Vec::new(),
            module_scripts: Vec::new(),
            notebooks: Vec::new(),
            data_sources: Vec::new(),
            custom_objects: Vec::new(),
            artifact_checksums: std::collections::BTreeMap::new(),
            extra: std::collections::HashMap::new(),
        };

        reg.write_version_manifest("pkg", "1.0.0", &ver_manifest).unwrap();

        let read_back = reg.get_version_manifest("pkg", "1.0.0").unwrap();
        assert_eq!(read_back.version, "1.0.0");
        assert_eq!(read_back.sheets.len(), 1);
        assert_eq!(read_back.sheets[0].name, "Dashboard");
        assert_eq!(read_back.sheets[0].sheet_id, sheet_id);
    }

    #[test]
    fn version_not_found() {
        let (_dir, reg) = create_test_registry();
        create_test_package(&reg, "pkg");

        let result = reg.get_version_manifest("pkg", "9.9.9");
        assert!(matches!(result, Err(CalpError::VersionNotFound { .. })));
    }

    #[test]
    fn resolve_version_pin() {
        let (_dir, reg) = create_test_registry();
        let mut manifest = create_test_package(&reg, "pkg");
        manifest.versions = vec![
            VersionEntry { version: "1.0.0".to_string(), published_at: "2026-01-01T00:00:00Z".to_string(), published_by: String::new(), extra: std::collections::HashMap::new() },
            VersionEntry { version: "1.1.0".to_string(), published_at: "2026-01-02T00:00:00Z".to_string(), published_by: String::new(), extra: std::collections::HashMap::new() },
            VersionEntry { version: "1.2.0".to_string(), published_at: "2026-01-03T00:00:00Z".to_string(), published_by: String::new(), extra: std::collections::HashMap::new() },
            VersionEntry { version: "2.0.0".to_string(), published_at: "2026-01-04T00:00:00Z".to_string(), published_by: String::new(), extra: std::collections::HashMap::new() },
        ];
        reg.write_package_manifest(&manifest).unwrap();

        // ^1.0 should resolve to 1.2.0
        let pin = VersionPin::Caret(SemVer::new(1, 0, 0));
        let resolved = reg.resolve_version("pkg", &pin).unwrap();
        assert_eq!(resolved, SemVer::new(1, 2, 0));

        // latest should resolve to 2.0.0
        let pin = VersionPin::Latest;
        let resolved = reg.resolve_version("pkg", &pin).unwrap();
        assert_eq!(resolved, SemVer::new(2, 0, 0));

        // =1.1.0 exact
        let pin = VersionPin::Exact(SemVer::new(1, 1, 0));
        let resolved = reg.resolve_version("pkg", &pin).unwrap();
        assert_eq!(resolved, SemVer::new(1, 1, 0));
    }

    #[test]
    fn version_exists_check() {
        let (_dir, reg) = create_test_registry();
        create_test_package(&reg, "pkg");

        assert!(!reg.version_exists("pkg", "1.0.0"));

        let ver_manifest = VersionManifest {
            model_writebacks: None,
            format_version: 1,
            package_name: "pkg".to_string(),
            version: "1.0.0".to_string(),
            kind: "report".to_string(),
            published_at: "2026-01-01T00:00:00Z".to_string(),
            published_by: String::new(),
            publisher_key: String::new(),
            publisher_name: String::new(),
            min_app_version: String::new(),
            sheets: Vec::new(),
            named_ranges: Vec::new(),
            tables: Vec::new(),
            locked_sheets: Vec::new(),
            locked_cells: Vec::new(),
            writeback_regions: None,
            object_scripts: Vec::new(),
            module_scripts: Vec::new(),
            notebooks: Vec::new(),
            data_sources: Vec::new(),
            custom_objects: Vec::new(),
            artifact_checksums: std::collections::BTreeMap::new(),
            extra: std::collections::HashMap::new(),
        };
        reg.write_version_manifest("pkg", "1.0.0", &ver_manifest).unwrap();

        assert!(reg.version_exists("pkg", "1.0.0"));
    }

    // --- Submission storage tests ---

    fn make_test_submission(region_id: &str, submitter_name: &str) -> crate::writeback::WritebackSubmission {
        crate::writeback::WritebackSubmission {
        model_key: None,
            id: format!("sub-{}-{}", region_id, submitter_name),
            region_id: region_id.to_string(),
            cell_row: 0,
            cell_col: 0,
            cell_id: None,
            submitter: crate::identity_provider::SubmitterIdentity {
                display_name: submitter_name.to_string(),
                id: format!("id-{}", submitter_name),
                extra: std::collections::HashMap::new(),
            },
            value: crate::writeback::SubmissionValue::Number { value: 42.0 },
            state: crate::writeback::SubmissionState::Submitted,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
            submitted_at: Some("2026-01-01T00:00:00Z".to_string()),
            review_reason: None,
            reviewed_by: None,
            extra: std::collections::HashMap::new(),
        }
    }

    fn make_test_review(
        id: &str,
        target: &str,
        state: crate::writeback::SubmissionState,
        reviewed_at: &str,
    ) -> crate::writeback::ReviewEvent {
        crate::writeback::ReviewEvent {
            id: id.to_string(),
            target_submission_id: target.to_string(),
            region_id: "r1".to_string(),
            submitter_id: "id-alice".to_string(),
            new_state: state,
            review_reason: Some("reason".to_string()),
            reviewed_by: Some("Publisher".to_string()),
            reviewed_at: reviewed_at.to_string(),
            extra: std::collections::HashMap::new(),
        }
    }

    // Model-keyed submissions are APPEND-ONLY history: two saves for the SAME
    // row key yield two files, both stay current (never collapsed), and
    // approval is a separate review EVENT — no submission file is ever
    // rewritten.
    #[test]
    fn model_submission_append_semantics() {
        let (_dir, reg) = create_test_registry();
        create_test_package(&reg, "pkg");

        let mut first = make_test_submission("wb-col-1", "alice");
        first.id = "sub-1".to_string();
        first.model_key = Some(vec!["7".to_string()]);
        let mut second = make_test_submission("wb-col-1", "alice");
        second.id = "sub-2".to_string();
        second.model_key = Some(vec!["7".to_string()]); // same row key
        second.value = crate::writeback::SubmissionValue::Number { value: 99.0 };

        reg.save_submission("pkg", "1.0.0", &first).unwrap();
        reg.save_submission("pkg", "1.0.0", &second).unwrap();
        let loaded = reg.load_current_submissions("pkg", "1.0.0").unwrap();
        assert_eq!(loaded.len(), 2, "same-key saves must both stay current");

        // Approval = a review event targeting sub-2; the submission files are
        // untouched, the folded view carries the derived state.
        reg.save_review(
            "pkg",
            "1.0.0",
            &make_test_review(
                "rev-1",
                "sub-2",
                crate::writeback::SubmissionState::Approved,
                "2026-01-02T00:00:00Z",
            ),
        )
        .unwrap();
        let loaded = reg.load_current_submissions("pkg", "1.0.0").unwrap();
        assert_eq!(loaded.len(), 2);
        assert!(loaded.iter().any(|s| s.id == "sub-2"
            && matches!(s.state, crate::writeback::SubmissionState::Approved)));
        assert!(loaded.iter().any(|s| s.id == "sub-1"
            && matches!(s.state, crate::writeback::SubmissionState::Submitted)));
    }

    // Review events live in their own publisher-written subtree and are
    // hygiene-filtered on load exactly like submission events.
    #[test]
    fn review_events_save_load_and_hygiene() {
        let (_dir, reg) = create_test_registry();
        create_test_package(&reg, "pkg");

        let review = make_test_review(
            "rev-1",
            "sub-1",
            crate::writeback::SubmissionState::Rejected,
            "2026-01-02T00:00:00Z",
        );
        reg.save_review("pkg", "1.0.0", &review).unwrap();

        // Junk beside it: filename/content id mismatch, torn JSON, dotfile.
        let reviews_dir = reg.version_dir("pkg", "1.0.0").unwrap().join("reviews");
        let mut renamed = review.clone();
        renamed.id = "rev-1".to_string();
        fs::write(
            reviews_dir.join("rev-1 (conflicted copy).json"),
            serde_json::to_string(&renamed).unwrap(),
        )
        .unwrap();
        fs::write(reviews_dir.join("torn.json"), "{\"id\": \"to").unwrap();
        fs::write(reviews_dir.join(".rev-9.json.tmp"), "{}").unwrap();

        let loaded = reg.load_review_events("pkg", "1.0.0").unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0], review);

        // A hostile review id cannot escape the reviews directory.
        let mut evil = review.clone();
        evil.id = "..\\escape".to_string();
        assert!(reg.save_review("pkg", "1.0.0", &evil).is_err());
    }

    #[test]
    fn submission_save_and_load() {
        let (_dir, reg) = create_test_registry();
        create_test_package(&reg, "pkg");

        // Create a version directory
        let ver_manifest = VersionManifest {
            model_writebacks: None,
            format_version: 1,
            package_name: "pkg".to_string(),
            version: "1.0.0".to_string(),
            kind: "report".to_string(),
            published_at: "2026-01-01T00:00:00Z".to_string(),
            published_by: String::new(),
            publisher_key: String::new(),
            publisher_name: String::new(),
            min_app_version: String::new(),
            sheets: Vec::new(),
            named_ranges: Vec::new(),
            tables: Vec::new(),
            locked_sheets: Vec::new(),
            locked_cells: Vec::new(),
            writeback_regions: None,
            object_scripts: Vec::new(),
            module_scripts: Vec::new(),
            notebooks: Vec::new(),
            data_sources: Vec::new(),
            custom_objects: Vec::new(),
            artifact_checksums: std::collections::BTreeMap::new(),
            extra: std::collections::HashMap::new(),
        };
        reg.write_version_manifest("pkg", "1.0.0", &ver_manifest).unwrap();

        let sub = make_test_submission("region-1", "alice");
        reg.save_submission("pkg", "1.0.0", &sub).unwrap();

        let loaded = reg.load_current_submissions_by("pkg", "1.0.0", "id-alice").unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, sub.id);
        assert_eq!(loaded[0].submitter.display_name, "alice");
    }

    #[test]
    fn load_submissions_empty_when_none() {
        let (_dir, reg) = create_test_registry();
        let result = reg.load_current_submissions_by("pkg", "1.0.0", "nobody").unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn load_region_submissions_across_submitters() {
        let (_dir, reg) = create_test_registry();
        create_test_package(&reg, "pkg");
        let ver_manifest = VersionManifest {
            model_writebacks: None,
            format_version: 1,
            package_name: "pkg".to_string(),
            version: "1.0.0".to_string(),
            kind: "report".to_string(),
            published_at: "2026-01-01T00:00:00Z".to_string(),
            published_by: String::new(),
            publisher_key: String::new(),
            publisher_name: String::new(),
            min_app_version: String::new(),
            sheets: Vec::new(),
            named_ranges: Vec::new(),
            tables: Vec::new(),
            locked_sheets: Vec::new(),
            locked_cells: Vec::new(),
            writeback_regions: None,
            object_scripts: Vec::new(),
            module_scripts: Vec::new(),
            notebooks: Vec::new(),
            data_sources: Vec::new(),
            custom_objects: Vec::new(),
            artifact_checksums: std::collections::BTreeMap::new(),
            extra: std::collections::HashMap::new(),
        };
        reg.write_version_manifest("pkg", "1.0.0", &ver_manifest).unwrap();

        reg.save_submission("pkg", "1.0.0", &make_test_submission("r1", "alice")).unwrap();
        reg.save_submission("pkg", "1.0.0", &make_test_submission("r1", "bob")).unwrap();
        reg.save_submission("pkg", "1.0.0", &make_test_submission("r2", "alice")).unwrap();

        let r1_subs = reg.load_current_region_submissions("pkg", "1.0.0", "r1").unwrap();
        assert_eq!(r1_subs.len(), 2);

        let r2_subs = reg.load_current_region_submissions("pkg", "1.0.0", "r2").unwrap();
        assert_eq!(r2_subs.len(), 1);
    }

    #[test]
    fn resubmission_appends_event_but_folds_to_newest() {
        let (_dir, reg) = create_test_registry();
        create_test_package(&reg, "pkg");

        // Same logical slot (region r1, cell 0,0, submitter alice), two
        // submit cycles with different submission ids and values.
        let mut first = make_test_submission("r1", "alice");
        first.id = "sub-rev-1".to_string();
        reg.save_submission("pkg", "1.0.0", &first).unwrap();

        let mut second = make_test_submission("r1", "alice");
        second.id = "sub-rev-2".to_string();
        second.updated_at = "2026-01-02T00:00:00Z".to_string();
        second.value = crate::writeback::SubmissionValue::Number { value: 99.0 };
        reg.save_submission("pkg", "1.0.0", &second).unwrap();

        // Append-only: BOTH event files exist on disk (nothing is ever
        // rewritten)...
        let raw = reg.load_submission_events("pkg", "1.0.0").unwrap();
        assert_eq!(raw.len(), 2, "every submit is a new immutable event file");

        // ...but the folded view collapses the slot to the newest event, so
        // GATHER aggregation never double-counts.
        let subs = reg.load_current_region_submissions("pkg", "1.0.0", "r1").unwrap();
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].id, "sub-rev-2");
        assert!(matches!(
            subs[0].value,
            crate::writeback::SubmissionValue::Number { value } if value == 99.0
        ));
    }

    // The hygiene contract: junk beside real events — legacy slot files,
    // sync-client "conflicted copy" renames, torn JSON, tmp debris, foreign
    // attribution, byte-duplicated events — is skipped, never an error, and
    // never double-counts.
    #[test]
    fn loaders_skip_junk_and_survive_torn_files() {
        let (_dir, reg) = create_test_registry();
        create_test_package(&reg, "pkg");

        let mut real = make_test_submission("r1", "alice");
        real.id = "sub-real".to_string();
        reg.save_submission("pkg", "1.0.0", &real).unwrap();

        let alice_dir = reg
            .version_dir("pkg", "1.0.0")
            .unwrap()
            .join("submissions")
            .join("id-alice");

        // Legacy slot file (pre-event-log naming): content id doesn't match
        // the filename grammar -> skipped.
        fs::write(
            alice_dir.join("r1_0_0.json"),
            serde_json::to_string(&real).unwrap(),
        )
        .unwrap();
        // Sync-client conflicted-copy rename of the real event -> skipped
        // (stem no longer ends with the content id).
        fs::write(
            alice_dir.join("r1_0_0_sub-real (conflicted copy 2026-07-17).json"),
            serde_json::to_string(&real).unwrap(),
        )
        .unwrap();
        // Torn/partial write and tmp debris -> skipped.
        fs::write(alice_dir.join("r1_0_0_sub-torn.json"), "{\"id\": \"sub-t").unwrap();
        fs::write(alice_dir.join(".r1_0_0_sub-x.json.tmp"), "{}").unwrap();
        // Non-JSON artifact (the parquet rollup lives under submissions/) is
        // invisible to submission loading.
        fs::write(alice_dir.join("_rollup.parquet"), b"PAR1").unwrap();
        // A file claiming another submitter's identity inside alice's dir ->
        // skipped (attribution must match the directory).
        let mut foreign = make_test_submission("r1", "mallory");
        foreign.id = "sub-forged".to_string();
        fs::write(
            alice_dir.join("r1_0_0_sub-forged.json"),
            serde_json::to_string(&foreign).unwrap(),
        )
        .unwrap();
        // A byte-identical duplicate of the real event under a second VALID
        // name (same id embedded) -> deduped by event id in the fold.
        fs::write(
            alice_dir.join("r1_9_9_sub-real.json"),
            serde_json::to_string(&real).unwrap(),
        )
        .unwrap();

        let current = reg.load_current_submissions("pkg", "1.0.0").unwrap();
        assert_eq!(current.len(), 1, "exactly the one real event survives");
        assert_eq!(current[0].id, "sub-real");
    }

    #[test]
    fn save_submission_rejects_path_traversal_region_id() {
        let (_dir, reg) = create_test_registry();
        create_test_package(&reg, "pkg");

        let evil = make_test_submission("..\\..\\escape", "alice");
        assert!(reg.save_submission("pkg", "1.0.0", &evil).is_err());

        let slashy = make_test_submission("a/b", "alice");
        assert!(reg.save_submission("pkg", "1.0.0", &slashy).is_err());

        // The submission id is a filename fragment now — same gate.
        let mut evil_id = make_test_submission("r1", "alice");
        evil_id.id = "..\\escape".to_string();
        assert!(reg.save_submission("pkg", "1.0.0", &evil_id).is_err());
    }

    #[test]
    fn load_all_submissions_spans_submitters_and_regions() {
        let (_dir, reg) = create_test_registry();
        create_test_package(&reg, "pkg");

        reg.save_submission("pkg", "1.0.0", &make_test_submission("r1", "alice")).unwrap();
        reg.save_submission("pkg", "1.0.0", &make_test_submission("r2", "alice")).unwrap();
        reg.save_submission("pkg", "1.0.0", &make_test_submission("r1", "bob")).unwrap();

        let all = reg.load_current_submissions("pkg", "1.0.0").unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all.iter().filter(|s| s.region_id == "r1").count(), 2);
        assert_eq!(all.iter().filter(|s| s.region_id == "r2").count(), 1);
    }

    // --- D7: registry robustness ---

    #[test]
    fn validate_component_rejects_traversal_and_junk() {
        for bad in ["", ".", "..", "a/b", "a\\b", "../escape", "C:\\Windows", "a:b", "a\u{0}b"] {
            assert!(validate_component(bad, "x").is_err(), "should reject {bad:?}");
        }
        for ok in ["pkg", "my-package", "1.0.0", "id-alice", "a_b.c"] {
            assert!(validate_component(ok, "x").is_ok(), "should accept {ok:?}");
        }
    }

    #[test]
    fn path_methods_reject_hostile_package_version_and_submitter() {
        let (_dir, reg) = create_test_registry();
        assert!(reg.get_package_manifest("../escape").is_err());
        assert!(reg.version_dir("../escape", "1.0.0").is_err());
        assert!(reg.version_dir("pkg", "../1.0.0").is_err());
        assert!(reg.sheet_dir("pkg", "..", &identity::SheetId::ZERO).is_err());

        // A hostile submitter id must not escape the submissions directory.
        let mut evil = make_test_submission("region-1", "evil");
        evil.submitter.id = "..\\..\\escape".to_string();
        assert!(reg.save_submission("pkg", "1.0.0", &evil).is_err());
    }

    #[test]
    fn atomic_write_replaces_and_leaves_no_temp() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("sub").join("f.json");
        atomic_write(&path, b"v1").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "v1");
        atomic_write(&path, b"v2-updated").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "v2-updated");
        assert!(!dir.path().join("sub").join(".f.json.tmp").exists());
    }

    #[test]
    fn registry_lock_releases_on_drop() {
        let dir = TempDir::new().unwrap();
        let lockfile = dir.path().join(".calp-lock");
        {
            let _g = RegistryLock::acquire(dir.path()).unwrap();
            assert!(lockfile.exists(), "lockfile present while held");
        }
        assert!(!lockfile.exists(), "lockfile removed on drop");
        // Re-acquire after release works.
        let _g2 = RegistryLock::acquire(dir.path()).unwrap();
    }

    // --- D8: RegistryTransport seam ---

    #[test]
    fn transport_artifact_roundtrip_and_list_exclusions() {
        let (_dir, reg) = create_test_registry();
        // Drive the registry purely through the trait object.
        let t: &dyn RegistryTransport = &reg;

        // write_artifact -> read_artifact round-trip (version-relative path).
        t.write_artifact("pkg", "1.0.0", "sheets/abc/data.json", b"hello")
            .unwrap();
        assert_eq!(
            t.read_artifact("pkg", "1.0.0", "sheets/abc/data.json").unwrap(),
            Some(b"hello".to_vec())
        );
        // Absent artifact -> None (not an error).
        assert_eq!(
            t.read_artifact("pkg", "1.0.0", "sheets/abc/missing.json").unwrap(),
            None
        );

        // The integrity root, its signature, and the post-publish event
        // subtrees (submissions + reviews) are all present on disk but
        // excluded from list_artifacts.
        t.write_artifact("pkg", "1.0.0", VERSION_MANIFEST_FILE, b"{}").unwrap();
        t.write_artifact("pkg", "1.0.0", VERSION_MANIFEST_SIG_FILE, b"deadbeef").unwrap();
        t.write_artifact("pkg", "1.0.0", "named_ranges.json", b"[]").unwrap();
        t.write_artifact("pkg", "1.0.0", "submissions/user-1/r1_0_0_s1.json", b"{}").unwrap();
        t.write_artifact("pkg", "1.0.0", "reviews/rev-1.json", b"{}").unwrap();

        let listed = t.list_artifacts("pkg", "1.0.0").unwrap();
        assert_eq!(listed, vec!["named_ranges.json", "sheets/abc/data.json"]);

        // A hostile rel_path cannot escape the version directory.
        assert!(t.write_artifact("pkg", "1.0.0", "../escape.json", b"x").is_err());
        assert!(t.read_artifact("pkg", "1.0.0", "../escape.json").is_err());

        // clear_version removes the version's artifacts.
        t.clear_version("pkg", "1.0.0").unwrap();
        assert!(t.list_artifacts("pkg", "1.0.0").unwrap().is_empty());
    }

    #[test]
    fn transport_lock_returns_guard_that_releases_on_drop() {
        let (_dir, reg) = create_test_registry();
        let t: &dyn RegistryTransport = &reg;
        let lockfile = reg.root().join(".calp-lock");
        {
            let _g = t.lock().unwrap();
            assert!(lockfile.exists(), "lockfile present while the trait guard is held");
        }
        assert!(!lockfile.exists(), "lockfile removed when the boxed guard drops");
        // Re-acquire after release works through the trait.
        let _g2 = t.lock().unwrap();
    }
}
