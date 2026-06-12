//! FILENAME: core/calp/src/error.rs
//! PURPOSE: Error types for .calp operations.

use thiserror::Error;

#[derive(Error, Debug)]
pub enum CalpError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Package not found: {0}")]
    PackageNotFound(String),

    #[error("Version not found: {package} {version}")]
    VersionNotFound { package: String, version: String },

    #[error("No version satisfies constraint '{pin}' for package '{package}'")]
    NoMatchingVersion { package: String, pin: String },

    #[error("Invalid version string: {0}")]
    InvalidVersion(String),

    #[error("Invalid version pin: {0}")]
    InvalidPin(String),

    #[error("Package already exists: {0}")]
    PackageAlreadyExists(String),

    #[error("Version already published: {package} {version}")]
    VersionAlreadyPublished { package: String, version: String },

    #[error("Sheet not found in workbook: {0}")]
    SheetNotFound(String),

    #[error("Registry error: {0}")]
    Registry(String),

    #[error("Format error: {0}")]
    Format(String),

    // -- Package integrity (S5 phase 1: SHA-256 artifact checksums) --------
    // Phase 2 adds manifest signature variants (Ed25519 + TOFU pinning),
    // e.g. ManifestSignatureInvalid / PublisherKeyChanged. See integrity.rs.

    #[error("Package integrity check failed: {file} in {package}@{version} does not match its published checksum")]
    ChecksumMismatch { package: String, version: String, file: String },

    #[error("Package integrity check failed: {file} in {package}@{version} is listed in the manifest but missing from the registry")]
    MissingArtifact { package: String, version: String, file: String },

    #[error("Package integrity check failed: {file} in {package}@{version} is not listed in the published checksums (file added after publish?)")]
    UnlistedArtifact { package: String, version: String, file: String },

    #[error("Package {package}@{version} was published without integrity checksums — republish it")]
    MissingChecksums { package: String, version: String },
}
