//! FILENAME: core/calp/src/lib.rs
//! PURPOSE: .calp package format — publish, pull, and version management.
//! CONTEXT: This crate handles the on-disk format for .calp packages,
//! local-filesystem registry operations, version pinning and resolution,
//! and the publish/pull workflows.

pub mod audit;
pub mod channels;
pub mod cross_package;
pub mod dev_mode;
pub mod error;
pub mod identity_provider;
pub mod integrity;
pub mod manifest;
pub mod overrides;
pub mod package_kind;
pub mod refresh;
pub mod registry;
pub mod version;
pub mod publish;
pub mod pull;
pub mod writeback;

pub use error::CalpError;
pub use identity_provider::SubmitterIdentity;
pub mod data_refresh;

pub use manifest::{
    PackageManifest, VersionEntry, VersionManifest, PublishedSheet,
    PackageDataSource, PackageBinding, SubscriberDataSourceConfig,
};
pub use overrides::{OverrideLayer, CellOverride, OverrideValue, OverridePatch};
pub use registry::LocalRegistry;
pub use version::{VersionPin, SemVer};
pub use writeback::{GatherCache, WritebackIndex, WritebackRegionDeclaration, WritebackRegionEntry};
