//! FILENAME: core/calp/src/lib.rs
//! PURPOSE: .calp application format — publish, pull, and version management.
//! CONTEXT: This crate handles the on-disk format for .calp applications,
//! local-filesystem workspace operations, version pinning and resolution,
//! and the publish/pull workflows.

pub mod audit;
pub mod checkout;
pub mod compat;
pub mod diff;
pub mod dev_mode;
pub mod error;
pub mod fold;
pub mod html_export;
pub mod identity_provider;
pub mod integrity;
pub mod manifest;
pub mod memory_workspace;
pub mod merge;
pub mod overrides;
pub mod application_kind;
pub mod refresh;
pub mod workspace;
pub mod workspace_id;
pub mod signing;
pub mod skin_pack;
pub mod transport;
pub mod version;
pub mod publish;
pub mod publishers;
pub mod pull;
pub mod working_copy;
pub mod writeback;

pub use compat::{check_min_app_version, host_app_version, set_host_app_version};
pub use error::CalpError;
pub use html_export::{render_application_html, HtmlExportMode, HtmlExportOptions};
pub use identity_provider::SubmitterIdentity;
pub mod data_refresh;

pub use manifest::{
    ApplicationManifest, VersionEntry, VersionManifest, PublishedSheet,
    ApplicationDataSource, TableBinding, SubscriberDataSourceConfig,
};
pub use publish::{head_version, resolve_authorized_keys, PushMode};
pub use checkout::checkout;
pub use diff::{diff_sheet_cells, diff_sides, DiffOptions, DiffSide, VersionDiff};
pub use memory_workspace::MemoryWorkspace;
pub use merge::{analyze as analyze_merge, Collision, MergeAnalysis, MergeVerdict, PieceKey};
pub use publishers::{AuthorizedKey, PublisherList};
pub use pull::SheetIdMode;
pub use working_copy::{WorkingCopyLink, WorkingCopySheetRef};
pub use overrides::{OverrideLayer, CellOverride, OverrideValue, OverridePatch};
pub use workspace::LocalWorkspace;
pub use workspace_id::{workspace_scope, WorkspaceScope};
pub use transport::WorkspaceTransport;
pub use version::{VersionPin, SemVer};
pub use fold::fold_submissions;
pub use writeback::{
    ModelWritebackDeclaration, ReviewEvent, WritebackIndex, WritebackRegionDeclaration,
    WritebackRegionEntry,
};
