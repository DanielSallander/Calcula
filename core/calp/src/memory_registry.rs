//! FILENAME: core/calp/src/memory_registry.rs
//! PURPOSE: A `RegistryTransport` that lives in memory.
//! CONTEXT: Two jobs, and the first is the reason it exists.
//!
//! **Diffing a working copy against its base.** The push dialog wants to show
//! "what your push changes" before anything is written. The naive way is a
//! second serializer that walks the workbook and produces something
//! diff-shaped — which is a second definition of what a package contains, and
//! it drifts from the real one on the first artifact type somebody adds. The
//! honest way is to run the REAL `publish()` against a registry that keeps its
//! bytes in a `HashMap`, and diff that. There is then exactly one answer to
//! "what would this publish write", because the preview and the publish are the
//! same code.
//!
//! **Fixtures.** A test that needs two versions of a package no longer needs a
//! temp directory and a filesystem.
//!
//! It is NOT a general-purpose registry: it holds no lock (there is nobody to
//! contend with) and no blob store (there is nothing to dedup against on disk).

use std::collections::BTreeMap;
use std::sync::Mutex;

use crate::error::CalpError;
use crate::manifest::{PackageManifest, VersionManifest};
use crate::transport::RegistryTransport;
use crate::version::{SemVer, VersionPin};
use crate::writeback::{ReviewEvent, WritebackSubmission};

#[derive(Default)]
struct Inner {
    packages: BTreeMap<String, PackageManifest>,
    /// (package, version) -> manifest
    versions: BTreeMap<(String, String), VersionManifest>,
    /// (package, version, rel_path) -> bytes
    artifacts: BTreeMap<(String, String, String), Vec<u8>>,
}

/// An in-memory registry. Cheap to create, holds everything written to it.
pub struct MemoryRegistry {
    inner: Mutex<Inner>,
}

impl Default for MemoryRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryRegistry {
    pub fn new() -> Self {
        Self { inner: Mutex::new(Inner::default()) }
    }

    /// The ARTIFACTS of one version, as `rel_path -> bytes`.
    ///
    /// This is what a caller hands to [`crate::diff::DiffSide::InMemory`] after
    /// running a publish into this registry, and it must therefore describe the
    /// same set a published version's signed `artifact_checksums` map does —
    /// which excludes the version manifest (the integrity root cannot list
    /// itself), its detached signature, and the post-publish writeback
    /// subtrees. Returning the raw store instead reported the manifest and its
    /// signature as two ADDED artifacts in every working-copy diff, and made
    /// them look like pieces a merge had to reconcile.
    pub fn artifacts_of(&self, package: &str, version: &str) -> BTreeMap<String, Vec<u8>> {
        let listed: std::collections::BTreeSet<String> = self
            .list_artifacts(package, version)
            .unwrap_or_default()
            .into_iter()
            .collect();
        let inner = self.inner.lock().expect("memory registry poisoned");
        inner
            .artifacts
            .iter()
            .filter(|((p, v, rel), _)| p == package && v == version && listed.contains(rel))
            .map(|((_, _, rel), bytes)| (rel.clone(), bytes.clone()))
            .collect()
    }
}

impl RegistryTransport for MemoryRegistry {
    fn list_packages(&self) -> Result<Vec<String>, CalpError> {
        let inner = self.inner.lock().expect("poisoned");
        Ok(inner.packages.keys().cloned().collect())
    }

    fn get_package_manifest(&self, package_name: &str) -> Result<PackageManifest, CalpError> {
        let inner = self.inner.lock().expect("poisoned");
        inner
            .packages
            .get(package_name)
            .cloned()
            .ok_or_else(|| CalpError::PackageNotFound(package_name.to_string()))
    }

    fn write_package_manifest(&self, manifest: &PackageManifest) -> Result<(), CalpError> {
        let mut inner = self.inner.lock().expect("poisoned");
        inner.packages.insert(manifest.name.clone(), manifest.clone());
        Ok(())
    }

    fn get_version_manifest(
        &self,
        package_name: &str,
        version: &str,
    ) -> Result<VersionManifest, CalpError> {
        let inner = self.inner.lock().expect("poisoned");
        inner
            .versions
            .get(&(package_name.to_string(), version.to_string()))
            .cloned()
            .ok_or_else(|| CalpError::VersionNotFound {
                package: package_name.to_string(),
                version: version.to_string(),
            })
    }

    fn write_version_manifest(
        &self,
        package_name: &str,
        version: &str,
        manifest: &VersionManifest,
    ) -> Result<(), CalpError> {
        let mut inner = self.inner.lock().expect("poisoned");
        inner.versions.insert(
            (package_name.to_string(), version.to_string()),
            manifest.clone(),
        );
        // A version manifest is ALSO an artifact — publish reads its raw bytes
        // back to sign them, and the signature must cover exactly what a reader
        // would see. Serializing it the same way the local registry does keeps
        // that true here too.
        let bytes = serde_json::to_string_pretty(manifest)?.into_bytes();
        inner.artifacts.insert(
            (
                package_name.to_string(),
                version.to_string(),
                crate::integrity::VERSION_MANIFEST_FILE.to_string(),
            ),
            bytes,
        );
        Ok(())
    }

    fn version_exists(&self, package_name: &str, version: &str) -> bool {
        let inner = self.inner.lock().expect("poisoned");
        inner
            .versions
            .contains_key(&(package_name.to_string(), version.to_string()))
    }

    fn resolve_version(
        &self,
        package_name: &str,
        pin: &VersionPin,
    ) -> Result<SemVer, CalpError> {
        let manifest = self.get_package_manifest(package_name)?;
        pin.resolve(&manifest.parsed_versions())
            .cloned()
            .ok_or_else(|| CalpError::NoMatchingVersion {
                package: package_name.to_string(),
                pin: format!("{pin:?}"),
            })
    }

    fn list_versions(&self, package_name: &str) -> Result<Vec<SemVer>, CalpError> {
        let manifest = self.get_package_manifest(package_name)?;
        let mut versions = manifest.parsed_versions();
        versions.sort();
        Ok(versions)
    }

    fn write_artifact(
        &self,
        package_name: &str,
        version: &str,
        rel_path: &str,
        content: &[u8],
    ) -> Result<(), CalpError> {
        let mut inner = self.inner.lock().expect("poisoned");
        inner.artifacts.insert(
            (package_name.to_string(), version.to_string(), rel_path.to_string()),
            content.to_vec(),
        );
        Ok(())
    }

    fn read_artifact(
        &self,
        package_name: &str,
        version: &str,
        rel_path: &str,
    ) -> Result<Option<Vec<u8>>, CalpError> {
        let inner = self.inner.lock().expect("poisoned");
        Ok(inner
            .artifacts
            .get(&(package_name.to_string(), version.to_string(), rel_path.to_string()))
            .cloned())
    }

    fn list_artifacts(
        &self,
        package_name: &str,
        version: &str,
    ) -> Result<Vec<String>, CalpError> {
        let inner = self.inner.lock().expect("poisoned");
        Ok(inner
            .artifacts
            .keys()
            .filter(|(p, v, _)| p == package_name && v == version)
            .map(|(_, _, rel)| rel.clone())
            // The same exclusions the on-disk registry applies: the manifest is
            // the integrity root and cannot list itself, its signature is not
            // covered either, and post-publish subtrees are a separate trust
            // domain.
            .filter(|rel| {
                rel != crate::integrity::VERSION_MANIFEST_FILE
                    && rel != crate::integrity::VERSION_MANIFEST_SIG_FILE
                    && !crate::integrity::POST_PUBLISH_DIRS
                        .iter()
                        .any(|d| rel.starts_with(&format!("{d}/")))
            })
            .collect())
    }

    fn clear_version(&self, package_name: &str, version: &str) -> Result<(), CalpError> {
        let mut inner = self.inner.lock().expect("poisoned");
        inner
            .artifacts
            .retain(|(p, v, _), _| !(p == package_name && v == version));
        inner
            .versions
            .remove(&(package_name.to_string(), version.to_string()));
        Ok(())
    }

    // ---- Writeback: an in-memory registry collects nothing ----------------
    // These are not "unimplemented": a preview/fixture registry genuinely has
    // no submitters, and answering with an empty set is the truthful answer.

    fn save_submission(
        &self,
        _package_name: &str,
        _version: &str,
        _submission: &WritebackSubmission,
    ) -> Result<(), CalpError> {
        Err(CalpError::Registry(
            "an in-memory registry collects no writeback submissions".to_string(),
        ))
    }

    fn save_review(
        &self,
        _package_name: &str,
        _version: &str,
        _review: &ReviewEvent,
    ) -> Result<(), CalpError> {
        Err(CalpError::Registry(
            "an in-memory registry records no writeback reviews".to_string(),
        ))
    }

    fn load_review_events(
        &self,
        _package_name: &str,
        _version: &str,
    ) -> Result<Vec<ReviewEvent>, CalpError> {
        Ok(Vec::new())
    }

    fn load_current_submissions_by(
        &self,
        _package_name: &str,
        _version: &str,
        _submitter_id: &str,
    ) -> Result<Vec<WritebackSubmission>, CalpError> {
        Ok(Vec::new())
    }

    fn load_current_region_submissions(
        &self,
        _package_name: &str,
        _version: &str,
        _region_id: &str,
    ) -> Result<Vec<WritebackSubmission>, CalpError> {
        Ok(Vec::new())
    }

    fn load_current_submissions(
        &self,
        _package_name: &str,
        _version: &str,
    ) -> Result<Vec<WritebackSubmission>, CalpError> {
        Ok(Vec::new())
    }

    fn lock(&self) -> Result<Box<dyn std::any::Any>, CalpError> {
        // Nothing to serialize against: this registry is not shared.
        Ok(Box::new(()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::publish::{self, PublishRequest, PushMode};
    use engine::cell::Cell;
    use persistence::{SavedCell, Sheet, Workbook};
    use tempfile::TempDir;

    fn workbook(text: &str) -> Workbook {
        let mut sheet = Sheet::new("Dashboard".to_string());
        sheet
            .cells
            .insert((0, 0), SavedCell::from_cell(&Cell::new_text(text.to_string())));
        let mut wb = Workbook::default();
        wb.sheets = vec![sheet];
        wb
    }

    fn publish_into(
        reg: &dyn RegistryTransport,
        prof: &std::path::Path,
        wb: &Workbook,
    ) -> Result<(), CalpError> {
        let request = PublishRequest {
            workbook: wb,
            package_name: "mem".to_string(),
            version: SemVer::new(1, 0, 0),
            kind: "report".to_string(),
            mode: PushMode::CreateNew,
            change_summary: "in-memory".to_string(),
            sheet_indices: vec![0],
            now: "2026-08-29T00:00:00Z".to_string(),
            published_by: "author".to_string(),
            writeback_regions: None,
            model_writebacks: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments: false,
            min_app_version: String::new(),
        };
        publish::publish(reg, &request, prof).map(|_| ())
    }

    #[test]
    fn the_real_publish_runs_against_memory_and_produces_the_same_artifacts_as_disk() {
        // The property the working-copy diff depends on: publishing into memory
        // is publishing. If these two ever disagree, the push preview is
        // describing a package the push would not write.
        let prof = TempDir::new().unwrap();
        let disk_dir = TempDir::new().unwrap();
        let disk = crate::registry::LocalRegistry::open(disk_dir.path()).unwrap();
        let mem = MemoryRegistry::new();

        let wb = workbook("hello");
        publish_into(&disk, prof.path(), &wb).unwrap();
        publish_into(&mem, prof.path(), &wb).unwrap();

        let on_disk = disk.get_version_manifest("mem", "1.0.0").unwrap();
        let in_mem = mem.get_version_manifest("mem", "1.0.0").unwrap();
        assert_eq!(
            on_disk.artifact_checksums, in_mem.artifact_checksums,
            "the same workbook must produce the same artifacts wherever it is published"
        );
    }

    #[test]
    fn the_version_manifest_is_readable_back_as_an_artifact() {
        // publish() signs the manifest by reading its written bytes back. A
        // transport that stored the manifest but could not return it would
        // fail there, so this is the property that keeps publish working.
        let prof = TempDir::new().unwrap();
        let mem = MemoryRegistry::new();
        publish_into(&mem, prof.path(), &workbook("x")).unwrap();
        let bytes = mem
            .read_artifact("mem", "1.0.0", crate::integrity::VERSION_MANIFEST_FILE)
            .unwrap();
        assert!(bytes.is_some(), "the manifest must be readable as an artifact");
        let sig = mem
            .read_artifact("mem", "1.0.0", crate::integrity::VERSION_MANIFEST_SIG_FILE)
            .unwrap();
        assert!(sig.is_some(), "and the publish must have signed it");
    }

    #[test]
    fn artifacts_of_matches_what_a_published_version_would_checksum() {
        // The set handed to a diff must be the set a published version attests,
        // or the diff reports the manifest and its signature as two artifacts
        // that "appeared" — and a merge then treats them as pieces.
        let prof = TempDir::new().unwrap();
        let mem = MemoryRegistry::new();
        publish_into(&mem, prof.path(), &workbook("x")).unwrap();

        let manifest = mem.get_version_manifest("mem", "1.0.0").unwrap();
        let artifacts = mem.artifacts_of("mem", "1.0.0");
        let handed: std::collections::BTreeSet<&String> = artifacts.keys().collect();
        let attested: std::collections::BTreeSet<&String> =
            manifest.artifact_checksums.keys().collect();
        assert_eq!(
            handed, attested,
            "artifacts_of must describe exactly the checksum map's set"
        );
    }

    #[test]
    fn list_artifacts_excludes_the_manifest_and_its_signature() {
        let prof = TempDir::new().unwrap();
        let mem = MemoryRegistry::new();
        publish_into(&mem, prof.path(), &workbook("x")).unwrap();
        let listed = mem.list_artifacts("mem", "1.0.0").unwrap();
        assert!(!listed.iter().any(|r| r == crate::integrity::VERSION_MANIFEST_FILE));
        assert!(!listed.iter().any(|r| r == crate::integrity::VERSION_MANIFEST_SIG_FILE));
        assert!(listed.iter().any(|r| r.starts_with("sheets/")), "but it lists content");
    }
}
