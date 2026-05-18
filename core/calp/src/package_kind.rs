//! FILENAME: core/calp/src/package_kind.rs
//! PURPOSE: Package kind declarations and kind-specific refresh defaults.
//! CONTEXT: A .calp declares its kind: template, dataset, or report.
//! Kind affects refresh defaults and override semantics.

use serde::{Deserialize, Serialize};

/// Package kind determines refresh behavior and override semantics.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PackageKind {
    /// Structure and formulas, no/minimal data. Refresh changes structure
    /// and formulas; data is consumer-supplied.
    Template,
    /// Data only (e.g., a published dataset of reference values).
    /// Refresh changes data; structure is stable.
    Dataset,
    /// Structure, formulas, and data together. Default.
    Report,
}

impl PackageKind {
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "template" => PackageKind::Template,
            "dataset" => PackageKind::Dataset,
            _ => PackageKind::Report,
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            PackageKind::Template => "template",
            PackageKind::Dataset => "dataset",
            PackageKind::Report => "report",
        }
    }
}

/// Refresh defaults for a package kind.
#[derive(Debug, Clone)]
pub struct RefreshDefaults {
    /// Whether formulas from upstream should be refreshed.
    pub refresh_formulas: bool,
    /// Whether data values from upstream should be refreshed.
    pub refresh_data: bool,
    /// Whether structure (new/deleted sheets, new/deleted columns) should be refreshed.
    pub refresh_structure: bool,
    /// Whether consumer-supplied data cells should be preserved (not overwritten by upstream).
    pub preserve_consumer_data: bool,
}

impl RefreshDefaults {
    /// Get the defaults for a package kind.
    pub fn for_kind(kind: &PackageKind) -> Self {
        match kind {
            PackageKind::Template => RefreshDefaults {
                refresh_formulas: true,
                refresh_data: false, // data is consumer-supplied
                refresh_structure: true,
                preserve_consumer_data: true,
            },
            PackageKind::Dataset => RefreshDefaults {
                refresh_formulas: false, // no formulas in a dataset
                refresh_data: true,
                refresh_structure: false, // structure is stable
                preserve_consumer_data: false,
            },
            PackageKind::Report => RefreshDefaults {
                refresh_formulas: true,
                refresh_data: true,
                refresh_structure: true,
                preserve_consumer_data: false,
            },
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_kind_from_string() {
        assert_eq!(PackageKind::from_str("template"), PackageKind::Template);
        assert_eq!(PackageKind::from_str("DATASET"), PackageKind::Dataset);
        assert_eq!(PackageKind::from_str("report"), PackageKind::Report);
        assert_eq!(PackageKind::from_str("unknown"), PackageKind::Report); // default
    }

    #[test]
    fn kind_roundtrip() {
        for kind in [PackageKind::Template, PackageKind::Dataset, PackageKind::Report] {
            assert_eq!(PackageKind::from_str(kind.as_str()), kind);
        }
    }

    #[test]
    fn template_preserves_consumer_data() {
        let defaults = RefreshDefaults::for_kind(&PackageKind::Template);
        assert!(defaults.refresh_formulas);
        assert!(!defaults.refresh_data);
        assert!(defaults.preserve_consumer_data);
    }

    #[test]
    fn dataset_refreshes_data_only() {
        let defaults = RefreshDefaults::for_kind(&PackageKind::Dataset);
        assert!(!defaults.refresh_formulas);
        assert!(defaults.refresh_data);
        assert!(!defaults.refresh_structure);
    }

    #[test]
    fn report_refreshes_everything() {
        let defaults = RefreshDefaults::for_kind(&PackageKind::Report);
        assert!(defaults.refresh_formulas);
        assert!(defaults.refresh_data);
        assert!(defaults.refresh_structure);
    }

    #[test]
    fn serde_roundtrip() {
        let kind = PackageKind::Template;
        let json = serde_json::to_string(&kind).unwrap();
        assert_eq!(json, "\"template\"");
        let deserialized: PackageKind = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized, PackageKind::Template);
    }
}
