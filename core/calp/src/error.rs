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

    #[error("Package {package}@{version} is signed by {got}, but nobody on this computer has ever agreed to trust that publisher for '{package}' from {scope}. Subscribe to the package (Data > Subscribe to Package) to review the publisher and trust it — a signature alone is not trust.")]
    PublisherNotPinned { package: String, version: String, scope: String, got: String },

    #[error("The package name '{package}' is already trusted on this computer from a DIFFERENT registry: {other_scope} is pinned to publisher {pinned}, but {scope} is offering {package}@{version} signed by {got}. Two registries claiming one name is exactly what a package hijack looks like. Review both publishers before accepting this one.")]
    PublisherNameConflict {
        package: String,
        version: String,
        /// The registry being contacted now, in the USER'S spelling.
        scope: String,
        /// The registry that already holds a pin for this name, in the user's
        /// spelling.
        other_scope: String,
        /// The key pinned for the other registry.
        pinned: String,
        /// The key this registry is offering.
        got: String,
    },

    // -- Compatibility contract --------------------------------------------

    #[error("This package needs a newer version of Calcula: {package}@{version} requires app v{required} but this app is v{current}. Please update Calcula.")]
    AppTooOld { package: String, version: String, required: String, current: String },
}
