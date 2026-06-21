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

    // -- Publisher signing (S5 phase 2: Ed25519 manifest signature + TOFU) --

    #[error("Package {package}@{version} is not signed (missing manifest signature or publisher key) — republish it with a signing-capable publisher")]
    MissingSignature { package: String, version: String },

    #[error("Package integrity check failed: the manifest signature for {package}@{version} is invalid (manifest tampered or signed by a different key)")]
    ManifestSignatureInvalid { package: String, version: String },

    #[error("Publisher key for package {package}@{version} changed since first use: pinned {pinned} but this version is signed by {got} — refusing to trust (possible package hijack)")]
    PublisherKeyChanged { package: String, version: String, pinned: String, got: String },

    // -- Compatibility contract --------------------------------------------

    #[error("This package needs a newer version of Calcula: {package}@{version} requires app v{required} but this app is v{current}. Please update Calcula.")]
    AppTooOld { package: String, version: String, required: String, current: String },
}
