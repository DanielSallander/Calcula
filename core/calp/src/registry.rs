//! FILENAME: core/calp/src/registry.rs
//! PURPOSE: Local filesystem registry adapter.
//! CONTEXT: A registry is a directory on disk that hosts .calp packages.
//! Each package is a subdirectory containing calp-manifest.json and
//! version directories with the published content.

use std::path::{Path, PathBuf};
use std::fs;

use crate::error::CalpError;
use crate::manifest::PackageManifest;
#[cfg(test)]
use crate::manifest::VersionEntry;
use crate::manifest::VersionManifest;
use crate::version::{SemVer, VersionPin};

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
        let path = self.package_dir(package_name).join("calp-manifest.json");
        if !path.exists() {
            return Err(CalpError::PackageNotFound(package_name.to_string()));
        }
        let content = fs::read_to_string(&path)?;
        let manifest: PackageManifest = serde_json::from_str(&content)?;
        Ok(manifest)
    }

    /// Write a package manifest.
    pub fn write_package_manifest(&self, manifest: &PackageManifest) -> Result<(), CalpError> {
        let dir = self.package_dir(&manifest.name);
        fs::create_dir_all(&dir)?;
        let path = dir.join("calp-manifest.json");
        let content = serde_json::to_string_pretty(manifest)?;
        fs::write(&path, content)?;
        Ok(())
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
        let path = self.version_dir(package_name, version).join("version-manifest.json");
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

    /// Write a version manifest and create the version directory.
    pub fn write_version_manifest(
        &self,
        package_name: &str,
        version: &str,
        manifest: &VersionManifest,
    ) -> Result<(), CalpError> {
        let dir = self.version_dir(package_name, version);
        fs::create_dir_all(&dir)?;
        let path = dir.join("version-manifest.json");
        let content = serde_json::to_string_pretty(manifest)?;
        fs::write(&path, content)?;
        Ok(())
    }

    /// Get the directory path for a version's sheet data.
    pub fn sheet_dir(
        &self,
        package_name: &str,
        version: &str,
        sheet_id: &identity::SheetId,
    ) -> PathBuf {
        self.version_dir(package_name, version)
            .join("sheets")
            .join(sheet_id.to_string())
    }

    /// Get the tables directory for a version.
    pub fn tables_dir(&self, package_name: &str, version: &str) -> PathBuf {
        self.version_dir(package_name, version).join("tables")
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
        self.version_dir(package_name, version).join("version-manifest.json").exists()
    }

    // -----------------------------------------------------------------------
    // Helper paths
    // -----------------------------------------------------------------------

    fn package_dir(&self, package_name: &str) -> PathBuf {
        self.root.join(package_name)
    }

    fn version_dir(&self, package_name: &str, version: &str) -> PathBuf {
        self.package_dir(package_name).join(version)
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
            sheets: vec![crate::manifest::PublishedSheet {
                sheet_id,
                name: "Dashboard".to_string(),
                description: String::new(),
            }],
            named_ranges: Vec::new(),
            tables: Vec::new(),
            locked_sheets: Vec::new(),
            locked_cells: Vec::new(),
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
            VersionEntry { version: "1.0.0".to_string(), published_at: "2026-01-01T00:00:00Z".to_string(), published_by: String::new() },
            VersionEntry { version: "1.1.0".to_string(), published_at: "2026-01-02T00:00:00Z".to_string(), published_by: String::new() },
            VersionEntry { version: "1.2.0".to_string(), published_at: "2026-01-03T00:00:00Z".to_string(), published_by: String::new() },
            VersionEntry { version: "2.0.0".to_string(), published_at: "2026-01-04T00:00:00Z".to_string(), published_by: String::new() },
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
            sheets: Vec::new(),
            named_ranges: Vec::new(),
            tables: Vec::new(),
            locked_sheets: Vec::new(),
            locked_cells: Vec::new(),
        };
        reg.write_version_manifest("pkg", "1.0.0", &ver_manifest).unwrap();

        assert!(reg.version_exists("pkg", "1.0.0"));
    }
}
