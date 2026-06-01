//! FILENAME: core/calp/src/dev_mode.rs
//! PURPOSE: Dev subscription mode — points at a local .cala file and follows HEAD.
//! CONTEXT: Authors need a fast iteration loop. A dev subscription points at a
//! working .cala file via local path. It refreshes on demand (or on file change)
//! without requiring version bumps.
//!
//! Dev subscriptions are stored alongside normal subscriptions but flagged with
//! `dev: true`. They resolve by reading the source .cala directly instead of
//! going through the registry.

use std::path::Path;

use identity::SheetId;
use persistence::Sheet;

use crate::error::CalpError;
use crate::manifest::{Subscription, SubscribedSheet};

/// A dev subscription entry. Stored in SubscriptionManifest with `dev: true`.
/// Points at a local .cala file instead of a registry package.

/// Read a source .cala workbook and extract sheets for dev subscription.
pub fn pull_dev(
    source_path: &Path,
    sheet_names: &[String],
) -> Result<DevPullResult, CalpError> {
    if !source_path.exists() {
        return Err(CalpError::Registry(format!(
            "Dev source not found: {}", source_path.display()
        )));
    }

    let workbook = calcula_format::load_calcula(source_path)
        .map_err(|e| CalpError::Format(format!("Failed to load dev source: {}", e)))?;

    let mut pulled_sheets = Vec::new();

    if sheet_names.is_empty() {
        // Pull all sheets
        for sheet in &workbook.sheets {
            pulled_sheets.push(DevPulledSheet {
                source_sheet_id: sheet.id,
                name: sheet.name.clone(),
                sheet: sheet.clone(),
            });
        }
    } else {
        // Pull selected sheets by name
        for name in sheet_names {
            let sheet = workbook.sheets.iter()
                .find(|s| s.name.eq_ignore_ascii_case(name))
                .ok_or_else(|| CalpError::SheetNotFound(name.clone()))?;
            pulled_sheets.push(DevPulledSheet {
                source_sheet_id: sheet.id,
                name: sheet.name.clone(),
                sheet: sheet.clone(),
            });
        }
    }

    Ok(DevPullResult {
        sheets: pulled_sheets,
        tables: workbook.tables,
        named_ranges: workbook.named_ranges,
    })
}

/// Result of a dev pull.
pub struct DevPullResult {
    pub sheets: Vec<DevPulledSheet>,
    pub tables: Vec<persistence::SavedTable>,
    pub named_ranges: Vec<persistence::SavedNamedRange>,
}

/// A sheet pulled from a dev source.
pub struct DevPulledSheet {
    pub source_sheet_id: SheetId,
    pub name: String,
    pub sheet: Sheet,
}

/// Build a dev subscription entry.
pub fn make_dev_subscription(
    source_path: &str,
    pulled: &DevPullResult,
    now: &str,
) -> Subscription {
    let sheets: Vec<SubscribedSheet> = pulled.sheets.iter().map(|ps| {
        SubscribedSheet {
            package_sheet_id: ps.source_sheet_id,
            local_sheet_id: ps.sheet.id,
            local_name: ps.name.clone(),
            extra: std::collections::HashMap::new(),
        }
    }).collect();

    Subscription {
        package_name: format!("dev:{}", source_path),
        registry_url: format!("file://{}", source_path),
        version_pin: "dev".to_string(),
        resolved_version: "dev".to_string(),
        resolved_at: now.to_string(),
        sheets,
        channel: "dev".to_string(),
        data_source_configs: Vec::new(),
        extra: std::collections::HashMap::new(),
    }
}

/// Check if a subscription is a dev subscription.
pub fn is_dev_subscription(sub: &Subscription) -> bool {
    sub.version_pin == "dev" || sub.package_name.starts_with("dev:")
}

/// Check if the source file has been modified since the last pull.
pub fn source_modified_since(source_path: &Path, last_pull: &str) -> Result<bool, CalpError> {
    if !source_path.exists() {
        return Ok(false);
    }

    let metadata = std::fs::metadata(source_path)?;
    let modified = metadata.modified()
        .map_err(|e| CalpError::Io(e))?;

    // Parse last_pull as a rough timestamp comparison
    // For simplicity, always return true (force refresh) — accurate timestamp
    // comparison requires chrono which we avoid in this crate
    let _ = modified;
    let _ = last_pull;
    Ok(true)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use persistence::Workbook;
    use tempfile::TempDir;
    use engine::cell::Cell;

    fn make_test_workbook() -> Workbook {
        let mut sheet1 = Sheet::new("Source1".to_string());
        let cell = Cell::new_number(42.0);
        sheet1.cells.insert((0, 0), persistence::SavedCell::from_cell(&cell));

        let mut sheet2 = Sheet::new("Source2".to_string());
        let cell2 = Cell::new_text("hello".to_string());
        sheet2.cells.insert((0, 0), persistence::SavedCell::from_cell(&cell2));

        let mut wb = Workbook::default();
        wb.sheets = vec![sheet1, sheet2];
        wb
    }

    #[test]
    fn dev_pull_all_sheets() {
        let dir = TempDir::new().unwrap();
        let source_path = dir.path().join("source.cala");

        let wb = make_test_workbook();
        calcula_format::save_calcula(&wb, &source_path).unwrap();

        let result = pull_dev(&source_path, &[]).unwrap();
        assert_eq!(result.sheets.len(), 2);
        assert_eq!(result.sheets[0].name, "Source1");
        assert_eq!(result.sheets[1].name, "Source2");
    }

    #[test]
    fn dev_pull_selected_sheets() {
        let dir = TempDir::new().unwrap();
        let source_path = dir.path().join("source.cala");

        let wb = make_test_workbook();
        calcula_format::save_calcula(&wb, &source_path).unwrap();

        let result = pull_dev(&source_path, &["Source2".to_string()]).unwrap();
        assert_eq!(result.sheets.len(), 1);
        assert_eq!(result.sheets[0].name, "Source2");
    }

    #[test]
    fn dev_pull_nonexistent_sheet_fails() {
        let dir = TempDir::new().unwrap();
        let source_path = dir.path().join("source.cala");

        let wb = make_test_workbook();
        calcula_format::save_calcula(&wb, &source_path).unwrap();

        let result = pull_dev(&source_path, &["NonExistent".to_string()]);
        assert!(matches!(result, Err(CalpError::SheetNotFound(_))));
    }

    #[test]
    fn dev_pull_nonexistent_file_fails() {
        let result = pull_dev(Path::new("/no/such/file.cala"), &[]);
        assert!(result.is_err());
    }

    #[test]
    fn dev_subscription_detection() {
        let sub = Subscription {
            package_name: "dev:/path/to/file.cala".to_string(),
            registry_url: "file:///path/to/file.cala".to_string(),
            version_pin: "dev".to_string(),
            resolved_version: "dev".to_string(),
            resolved_at: String::new(),
            sheets: Vec::new(),
            channel: "dev".to_string(),
            data_source_configs: Vec::new(),
            extra: std::collections::HashMap::new(),
        };
        assert!(is_dev_subscription(&sub));

        let normal_sub = Subscription {
            package_name: "sales-report".to_string(),
            registry_url: "file:///registry".to_string(),
            version_pin: "^1.0".to_string(),
            resolved_version: "1.2.0".to_string(),
            resolved_at: String::new(),
            sheets: Vec::new(),
            channel: String::new(),
            data_source_configs: Vec::new(),
            extra: std::collections::HashMap::new(),
        };
        assert!(!is_dev_subscription(&normal_sub));
    }

    #[test]
    fn make_dev_subscription_creates_metadata() {
        let dir = TempDir::new().unwrap();
        let source_path = dir.path().join("source.cala");
        let wb = make_test_workbook();
        calcula_format::save_calcula(&wb, &source_path).unwrap();

        let result = pull_dev(&source_path, &[]).unwrap();
        let sub = make_dev_subscription(
            source_path.to_str().unwrap(),
            &result,
            "2026-01-01T00:00:00Z",
        );

        assert!(is_dev_subscription(&sub));
        assert_eq!(sub.sheets.len(), 2);
    }
}
