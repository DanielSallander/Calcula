//! FILENAME: core/calp/src/manifest.rs
//! PURPOSE: .calp manifest types — package-level and version-level.

use identity::{EntityId, SheetId};
use serde::{Deserialize, Serialize};
use crate::version::SemVer;

/// Package-level manifest (calp-manifest.json).
/// Lives at the root of a package directory. Lists all published versions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageManifest {
    pub format_version: u32,
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// Package kind: "report", "template", or "dataset".
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub author: String,
    pub created: String,
    pub versions: Vec<VersionEntry>,
}

fn default_kind() -> String { "report".to_string() }

/// An entry in the package manifest's version list.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionEntry {
    pub version: String,
    pub published_at: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub published_by: String,
}

impl PackageManifest {
    pub fn new(name: &str, kind: &str, author: &str, now: &str) -> Self {
        Self {
            format_version: 1,
            name: name.to_string(),
            description: String::new(),
            kind: kind.to_string(),
            author: author.to_string(),
            created: now.to_string(),
            versions: Vec::new(),
        }
    }

    /// Get all version strings parsed as SemVer.
    pub fn parsed_versions(&self) -> Vec<SemVer> {
        self.versions.iter()
            .filter_map(|e| SemVer::parse(&e.version).ok())
            .collect()
    }

    /// Get the latest version entry (last in the list).
    pub fn latest_version(&self) -> Option<&VersionEntry> {
        self.versions.last()
    }
}

/// Version-level manifest (version-manifest.json).
/// Describes the content of a specific published version.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionManifest {
    pub format_version: u32,
    pub package_name: String,
    pub version: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    pub published_at: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub published_by: String,
    pub sheets: Vec<PublishedSheet>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub named_ranges: Vec<PublishedNamedRange>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tables: Vec<EntityId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub locked_sheets: Vec<SheetId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub locked_cells: Vec<LockedCell>,
}

/// A sheet entry in the version manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedSheet {
    pub sheet_id: SheetId,
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
}

/// A named range included in the published package.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedNamedRange {
    pub name: String,
    pub refers_to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheet_id: Option<SheetId>,
}

/// A cell marked as locked-no-override.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockedCell {
    pub sheet_id: SheetId,
    pub cell_id: identity::CellId,
}

/// Subscription metadata stored in a .cala file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionManifest {
    pub format_version: u32,
    pub subscriptions: Vec<Subscription>,
}

impl Default for SubscriptionManifest {
    fn default() -> Self {
        Self {
            format_version: 1,
            subscriptions: Vec::new(),
        }
    }
}

/// A single subscription entry within a .cala workbook.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    pub package_name: String,
    pub registry_url: String,
    pub version_pin: String,
    pub resolved_version: String,
    pub resolved_at: String,
    pub sheets: Vec<SubscribedSheet>,
    /// Named channel for this subscription (e.g., "dev", "test", "staging", "prod").
    /// Empty string means the default/production channel.
    /// Channels let teams maintain parallel subscription environments —
    /// the same workbook can subscribe to different sources per channel,
    /// and the active channel determines which source is used.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub channel: String,
}

/// Mapping from a package sheet to its local representation in the consumer's workbook.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribedSheet {
    /// The sheet's ID in the package.
    pub package_sheet_id: SheetId,
    /// The sheet's ID in the local workbook.
    pub local_sheet_id: SheetId,
    /// The sheet's name in the local workbook (may differ from package name).
    pub local_name: String,
}
