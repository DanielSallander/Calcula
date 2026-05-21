//! FILENAME: core/calp/src/manifest.rs
//! PURPOSE: .calp manifest types — package-level and version-level.

use std::collections::HashMap;

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
    /// Forward-compatibility: preserves unknown fields from future format versions.
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
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
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
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
            extra: HashMap::new(),
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
    /// Writeback region declarations. Present when the publisher designates
    /// regions as subscriber-fillable. v1.0 parses and round-trips these but
    /// does not interpret the semantic sub-fields.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub writeback_regions: Option<Vec<crate::writeback::WritebackRegionDeclaration>>,
    /// Object scripts bundled with the package. Scripts travel with the package
    /// and are loaded on the subscriber side. Subscribers cannot edit these
    /// scripts but can add their own script layers on top.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub object_scripts: Vec<PublishedObjectScript>,
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

/// An object script bundled with a .calp package.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedObjectScript {
    /// Script ID (stable across versions).
    pub id: String,
    /// Human-readable name.
    pub name: String,
    /// Object type: "workbook", "sheet", "cell", "slicer", etc.
    pub object_type: String,
    /// For component objects: the instance ID. None for primitive objects.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    /// Script description.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// A sheet entry in the version manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedSheet {
    pub sheet_id: SheetId,
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

/// A named range included in the published package.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedNamedRange {
    pub name: String,
    pub refers_to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheet_id: Option<SheetId>,
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

/// A cell marked as locked-no-override.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockedCell {
    pub sheet_id: SheetId,
    pub cell_id: identity::CellId,
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Subscription metadata stored in a .cala file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionManifest {
    pub format_version: u32,
    pub subscriptions: Vec<Subscription>,
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

impl Default for SubscriptionManifest {
    fn default() -> Self {
        Self {
            format_version: 1,
            subscriptions: Vec::new(),
            extra: HashMap::new(),
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
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
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
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_manifest_without_writeback_loads() {
        // A manifest with no writeback_regions field — must load normally.
        let json = serde_json::json!({
            "formatVersion": 1,
            "packageName": "test",
            "version": "1.0.0",
            "kind": "report",
            "publishedAt": "2026-01-01T00:00:00Z",
            "sheets": [],
        });
        let vm: VersionManifest = serde_json::from_value(json).unwrap();
        assert!(vm.writeback_regions.is_none());
        assert!(vm.extra.is_empty());
    }

    #[test]
    fn version_manifest_with_writeback_roundtrips() {
        let sid = SheetId::from_bytes(identity::generate_uuid_v7());
        let json = serde_json::json!({
            "formatVersion": 1,
            "packageName": "test",
            "version": "1.0.0",
            "kind": "report",
            "publishedAt": "2026-01-01T00:00:00Z",
            "sheets": [],
            "writebackRegions": [
                {
                    "id": "region-1",
                    "selector": {
                        "sheetId": sid.to_string(),
                        "rowStart": 0,
                        "rowEnd": 10,
                        "colStart": 0,
                        "colEnd": 5
                    },
                    "mode": "per_subscriber",
                    "schema": {"valueType": "number"}
                }
            ]
        });

        let vm: VersionManifest = serde_json::from_value(json).unwrap();
        assert!(vm.writeback_regions.is_some());
        let regions = vm.writeback_regions.as_ref().unwrap();
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].id, "region-1");

        // Round-trip
        let re_json = serde_json::to_value(&vm).unwrap();
        let vm2: VersionManifest = serde_json::from_value(re_json).unwrap();
        let regions2 = vm2.writeback_regions.unwrap();
        assert_eq!(regions2[0].mode, Some(crate::writeback::WritebackMode::PerSubscriber));
    }

    #[test]
    fn flatten_extras_preserve_unknown_fields() {
        // Simulate a future format with extra fields on VersionManifest
        let json = serde_json::json!({
            "formatVersion": 1,
            "packageName": "test",
            "version": "1.0.0",
            "kind": "report",
            "publishedAt": "2026-01-01T00:00:00Z",
            "sheets": [],
            "futureField": "some-value",
            "anotherFuture": 42
        });
        let vm: VersionManifest = serde_json::from_value(json).unwrap();
        assert_eq!(vm.extra.get("futureField").unwrap(), "some-value");

        // Round-trip preserves
        let re_json = serde_json::to_value(&vm).unwrap();
        assert_eq!(re_json["futureField"], "some-value");
        assert_eq!(re_json["anotherFuture"], 42);
    }

    #[test]
    fn subscription_extras_roundtrip() {
        let json = serde_json::json!({
            "packageName": "pkg",
            "registryUrl": "file:///reg",
            "versionPin": "^1.0",
            "resolvedVersion": "1.0.0",
            "resolvedAt": "2026-01-01T00:00:00Z",
            "sheets": [],
            "newV11Field": {"nested": true}
        });
        let sub: Subscription = serde_json::from_value(json).unwrap();
        assert!(sub.extra.contains_key("newV11Field"));

        let re_json = serde_json::to_value(&sub).unwrap();
        assert_eq!(re_json["newV11Field"]["nested"], true);
    }

    #[test]
    fn cell_override_extras_roundtrip() {
        let json = serde_json::json!({
            "sheetId": SheetId::from_bytes(identity::generate_uuid_v7()).to_string(),
            "cellId": identity::CellId::from_bytes(identity::generate_uuid_v7()).to_string(),
            "position": [0, 0],
            "baseline": {"type": "value", "display": "100"},
            "current": {"type": "value", "display": "200"},
            "createdAt": "2026-01-01T00:00:00Z",
            "modifiedAt": "2026-01-01T00:00:00Z",
            "futureWritebackRef": "wb-region-1"
        });
        let ovr: crate::overrides::CellOverride = serde_json::from_value(json).unwrap();
        assert!(ovr.extra.contains_key("futureWritebackRef"));

        let re_json = serde_json::to_value(&ovr).unwrap();
        assert_eq!(re_json["futureWritebackRef"], "wb-region-1");
    }
}
