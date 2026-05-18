//! FILENAME: core/calp/src/lib.rs
//! PURPOSE: .calp package format — publish, pull, and version management.
//! CONTEXT: This crate handles the on-disk format for .calp packages,
//! local-filesystem registry operations, version pinning and resolution,
//! and the publish/pull workflows.

pub mod error;
pub mod manifest;
pub mod overrides;
pub mod refresh;
pub mod registry;
pub mod version;
pub mod publish;
pub mod pull;

pub use error::CalpError;
pub use manifest::{PackageManifest, VersionEntry, VersionManifest, PublishedSheet};
pub use overrides::{OverrideLayer, CellOverride, OverrideValue, OverridePatch};
pub use registry::LocalRegistry;
pub use version::{VersionPin, SemVer};
