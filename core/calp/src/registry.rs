//! FILENAME: core/calp/src/registry.rs
//! PURPOSE: Local filesystem registry adapter.
//! CONTEXT: A registry is a directory on disk that hosts .calp packages.
//! Each package is a subdirectory containing calp-manifest.json and
//! version directories with the published content.

use std::path::{Path, PathBuf};
use std::fs;
use std::time::Duration;

use crate::error::CalpError;
use crate::manifest::PackageManifest;
#[cfg(test)]
use crate::manifest::VersionEntry;
use crate::manifest::VersionManifest;
use crate::version::{SemVer, VersionPin};

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
    // Submission storage (Phase 14)
    // -----------------------------------------------------------------------

    /// Save a submission to the registry (creates submitter directory if needed).
    ///
    /// The filename is the logical submission SLOT — (region, cell) within the
    /// submitter's directory — not the per-save submission id. Re-submitting a
    /// cell therefore REPLACES the prior file instead of accumulating
    /// duplicates that would double-count in GATHER aggregation.
    pub fn save_submission(
        &self,
        package_name: &str,
        version: &str,
        submission: &crate::writeback::WritebackSubmission,
    ) -> Result<(), CalpError> {
        // The region id is joined raw into the slot filename and originates
        // from third-party package manifests — reject anything that could
        // escape the submissions directory. (Package/submitter path
        // components get the same treatment under the D7 boundary work.)
        if submission.region_id.is_empty()
            || !submission
                .region_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err(CalpError::Registry(format!(
                "Invalid writeback region id '{}': only alphanumerics, '-' and '_' are allowed",
                submission.region_id
            )));
        }

        let sub_dir = self.submissions_dir(package_name, version, &submission.submitter.id)?;
        let path = sub_dir.join(format!(
            "{}_{}_{}.json",
            submission.region_id, submission.cell_row, submission.cell_col
        ));
        let content = serde_json::to_string_pretty(submission)?;
        // Atomic + slot-keyed: re-submitting a cell replaces its file without a
        // torn-write window (D7).
        atomic_write(&path, content.as_bytes())
    }

    /// Load EVERY submission for a package version across all submitters and
    /// regions in a single tree scan. Callers that need several regions
    /// should use this and bucket by region_id — calling
    /// load_region_submissions per region rescans the whole tree each time.
    pub fn load_all_submissions(
        &self,
        package_name: &str,
        version: &str,
    ) -> Result<Vec<crate::writeback::WritebackSubmission>, CalpError> {
        let base = self.version_dir(package_name, version)?.join("submissions");
        if !base.exists() {
            return Ok(Vec::new());
        }

        let mut all = Vec::new();
        for entry in fs::read_dir(&base)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                let submitter_id = entry.file_name().to_string_lossy().to_string();
                // The submitter-id directory name is untrusted input read off
                // disk — skip any that wouldn't pass the boundary validator.
                if validate_component(&submitter_id, "submitter id").is_err() {
                    continue;
                }
                all.extend(self.load_submissions(package_name, version, &submitter_id)?);
            }
        }
        Ok(all)
    }

    /// Load all submissions by a specific submitter for a package version.
    pub fn load_submissions(
        &self,
        package_name: &str,
        version: &str,
        submitter_id: &str,
    ) -> Result<Vec<crate::writeback::WritebackSubmission>, CalpError> {
        let sub_dir = self.submissions_dir(package_name, version, submitter_id)?;
        if !sub_dir.exists() {
            return Ok(Vec::new());
        }

        let mut submissions = Vec::new();
        for entry in fs::read_dir(&sub_dir)? {
            let entry = entry?;
            if entry.path().extension().map_or(false, |ext| ext == "json") {
                let content = fs::read_to_string(entry.path())?;
                let sub: crate::writeback::WritebackSubmission = serde_json::from_str(&content)?;
                submissions.push(sub);
            }
        }
        Ok(submissions)
    }

    /// Load all submissions for a specific region across all submitters.
    pub fn load_region_submissions(
        &self,
        package_name: &str,
        version: &str,
        region_id: &str,
    ) -> Result<Vec<crate::writeback::WritebackSubmission>, CalpError> {
        let base = self.version_dir(package_name, version)?.join("submissions");
        if !base.exists() {
            return Ok(Vec::new());
        }

        let mut all = Vec::new();
        for entry in fs::read_dir(&base)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                let submitter_id = entry.file_name().to_string_lossy().to_string();
                if validate_component(&submitter_id, "submitter id").is_err() {
                    continue;
                }
                let subs = self.load_submissions(package_name, version, &submitter_id)?;
                for sub in subs {
                    if sub.region_id == region_id {
                        all.push(sub);
                    }
                }
            }
        }
        Ok(all)
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
            format_version: 1,
            package_name: "pkg".to_string(),
            version: "1.0.0".to_string(),
            kind: "report".to_string(),
            published_at: "2026-01-01T00:00:00Z".to_string(),
            published_by: "tester".to_string(),
            publisher_key: String::new(),
            publisher_name: String::new(),
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
            format_version: 1,
            package_name: "pkg".to_string(),
            version: "1.0.0".to_string(),
            kind: "report".to_string(),
            published_at: "2026-01-01T00:00:00Z".to_string(),
            published_by: String::new(),
            publisher_key: String::new(),
            publisher_name: String::new(),
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
            artifact_checksums: std::collections::BTreeMap::new(),
            extra: std::collections::HashMap::new(),
        };
        reg.write_version_manifest("pkg", "1.0.0", &ver_manifest).unwrap();

        assert!(reg.version_exists("pkg", "1.0.0"));
    }

    // --- Submission storage tests ---

    fn make_test_submission(region_id: &str, submitter_name: &str) -> crate::writeback::WritebackSubmission {
        crate::writeback::WritebackSubmission {
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
            extra: std::collections::HashMap::new(),
        }
    }

    #[test]
    fn submission_save_and_load() {
        let (_dir, reg) = create_test_registry();
        create_test_package(&reg, "pkg");

        // Create a version directory
        let ver_manifest = VersionManifest {
            format_version: 1,
            package_name: "pkg".to_string(),
            version: "1.0.0".to_string(),
            kind: "report".to_string(),
            published_at: "2026-01-01T00:00:00Z".to_string(),
            published_by: String::new(),
            publisher_key: String::new(),
            publisher_name: String::new(),
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
            artifact_checksums: std::collections::BTreeMap::new(),
            extra: std::collections::HashMap::new(),
        };
        reg.write_version_manifest("pkg", "1.0.0", &ver_manifest).unwrap();

        let sub = make_test_submission("region-1", "alice");
        reg.save_submission("pkg", "1.0.0", &sub).unwrap();

        let loaded = reg.load_submissions("pkg", "1.0.0", "id-alice").unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, sub.id);
        assert_eq!(loaded[0].submitter.display_name, "alice");
    }

    #[test]
    fn load_submissions_empty_when_none() {
        let (_dir, reg) = create_test_registry();
        let result = reg.load_submissions("pkg", "1.0.0", "nobody").unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn load_region_submissions_across_submitters() {
        let (_dir, reg) = create_test_registry();
        create_test_package(&reg, "pkg");
        let ver_manifest = VersionManifest {
            format_version: 1,
            package_name: "pkg".to_string(),
            version: "1.0.0".to_string(),
            kind: "report".to_string(),
            published_at: "2026-01-01T00:00:00Z".to_string(),
            published_by: String::new(),
            publisher_key: String::new(),
            publisher_name: String::new(),
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
            artifact_checksums: std::collections::BTreeMap::new(),
            extra: std::collections::HashMap::new(),
        };
        reg.write_version_manifest("pkg", "1.0.0", &ver_manifest).unwrap();

        reg.save_submission("pkg", "1.0.0", &make_test_submission("r1", "alice")).unwrap();
        reg.save_submission("pkg", "1.0.0", &make_test_submission("r1", "bob")).unwrap();
        reg.save_submission("pkg", "1.0.0", &make_test_submission("r2", "alice")).unwrap();

        let r1_subs = reg.load_region_submissions("pkg", "1.0.0", "r1").unwrap();
        assert_eq!(r1_subs.len(), 2);

        let r2_subs = reg.load_region_submissions("pkg", "1.0.0", "r2").unwrap();
        assert_eq!(r2_subs.len(), 1);
    }

    #[test]
    fn resubmission_replaces_prior_file_no_double_count() {
        let (_dir, reg) = create_test_registry();
        create_test_package(&reg, "pkg");

        // Same logical slot (region r1, cell 0,0, submitter alice), two
        // submit cycles with different submission ids and values.
        let mut first = make_test_submission("r1", "alice");
        first.id = "sub-rev-1".to_string();
        reg.save_submission("pkg", "1.0.0", &first).unwrap();

        let mut second = make_test_submission("r1", "alice");
        second.id = "sub-rev-2".to_string();
        second.value = crate::writeback::SubmissionValue::Number { value: 99.0 };
        reg.save_submission("pkg", "1.0.0", &second).unwrap();

        // The slot-keyed filename means the second submit REPLACED the first.
        let subs = reg.load_region_submissions("pkg", "1.0.0", "r1").unwrap();
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].id, "sub-rev-2");
        assert!(matches!(
            subs[0].value,
            crate::writeback::SubmissionValue::Number { value } if value == 99.0
        ));
    }

    #[test]
    fn save_submission_rejects_path_traversal_region_id() {
        let (_dir, reg) = create_test_registry();
        create_test_package(&reg, "pkg");

        let evil = make_test_submission("..\\..\\escape", "alice");
        assert!(reg.save_submission("pkg", "1.0.0", &evil).is_err());

        let slashy = make_test_submission("a/b", "alice");
        assert!(reg.save_submission("pkg", "1.0.0", &slashy).is_err());
    }

    #[test]
    fn load_all_submissions_spans_submitters_and_regions() {
        let (_dir, reg) = create_test_registry();
        create_test_package(&reg, "pkg");

        reg.save_submission("pkg", "1.0.0", &make_test_submission("r1", "alice")).unwrap();
        reg.save_submission("pkg", "1.0.0", &make_test_submission("r2", "alice")).unwrap();
        reg.save_submission("pkg", "1.0.0", &make_test_submission("r1", "bob")).unwrap();

        let all = reg.load_all_submissions("pkg", "1.0.0").unwrap();
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
}
