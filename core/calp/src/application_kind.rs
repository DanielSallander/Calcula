//! FILENAME: core/calp/src/application_kind.rs
//! PURPOSE: Application kind declarations and kind-specific refresh defaults.
//! CONTEXT: A .calp declares its kind: template, dataset, or report.
//! Kind affects refresh defaults and override semantics.

use serde::{Deserialize, Serialize};

/// Application kind determines refresh behavior and override semantics.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApplicationKind {
    /// Structure and formulas, no/minimal data. Refresh changes structure
    /// and formulas; data is consumer-supplied.
    Template,
    /// Data only (e.g., a published dataset of reference values).
    /// Refresh changes data; structure is stable.
    Dataset,
    /// Structure, formulas, and data together. Default.
    Report,
}

impl ApplicationKind {
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "template" => ApplicationKind::Template,
            "dataset" => ApplicationKind::Dataset,
            _ => ApplicationKind::Report,
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            ApplicationKind::Template => "template",
            ApplicationKind::Dataset => "dataset",
            ApplicationKind::Report => "report",
        }
    }
}

/// Refresh defaults for an application kind.
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
    /// Get the defaults for an application kind.
    pub fn for_kind(kind: &ApplicationKind) -> Self {
        match kind {
            ApplicationKind::Template => RefreshDefaults {
                refresh_formulas: true,
                refresh_data: false, // data is consumer-supplied
                refresh_structure: true,
                preserve_consumer_data: true,
            },
            ApplicationKind::Dataset => RefreshDefaults {
                refresh_formulas: false, // no formulas in a dataset
                refresh_data: true,
                refresh_structure: false, // structure is stable
                preserve_consumer_data: false,
            },
            ApplicationKind::Report => RefreshDefaults {
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
        assert_eq!(ApplicationKind::from_str("template"), ApplicationKind::Template);
        assert_eq!(ApplicationKind::from_str("DATASET"), ApplicationKind::Dataset);
        assert_eq!(ApplicationKind::from_str("report"), ApplicationKind::Report);
        assert_eq!(ApplicationKind::from_str("unknown"), ApplicationKind::Report); // default
    }

    #[test]
    fn kind_roundtrip() {
        for kind in [ApplicationKind::Template, ApplicationKind::Dataset, ApplicationKind::Report] {
            assert_eq!(ApplicationKind::from_str(kind.as_str()), kind);
        }
    }

    #[test]
    fn template_preserves_consumer_data() {
        let defaults = RefreshDefaults::for_kind(&ApplicationKind::Template);
        assert!(defaults.refresh_formulas);
        assert!(!defaults.refresh_data);
        assert!(defaults.preserve_consumer_data);
    }

    #[test]
    fn dataset_refreshes_data_only() {
        let defaults = RefreshDefaults::for_kind(&ApplicationKind::Dataset);
        assert!(!defaults.refresh_formulas);
        assert!(defaults.refresh_data);
        assert!(!defaults.refresh_structure);
    }

    #[test]
    fn report_refreshes_everything() {
        let defaults = RefreshDefaults::for_kind(&ApplicationKind::Report);
        assert!(defaults.refresh_formulas);
        assert!(defaults.refresh_data);
        assert!(defaults.refresh_structure);
    }

    #[test]
    fn serde_roundtrip() {
        let kind = ApplicationKind::Template;
        let json = serde_json::to_string(&kind).unwrap();
        assert_eq!(json, "\"template\"");
        let deserialized: ApplicationKind = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized, ApplicationKind::Template);
    }
}
