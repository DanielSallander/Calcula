//! FILENAME: core/calp/src/channels.rs
//! PURPOSE: Named subscription channels (dev, test, staging, prod, or arbitrary).
//! CONTEXT: Teams can maintain parallel subscription environments. A channel is
//! a named pointer to a source — either a local .cala file (for dev/test) or
//! a registry + version pin (for staging/prod). The active channel determines
//! which source is used for refresh.
//!
//! Examples:
//!   channel "dev"     -> local file /work/model.cala (follows HEAD)
//!   channel "test"    -> registry /shared/test-registry, pin ^1.0
//!   channel "staging" -> registry /shared/staging-registry, pin =1.2.3
//!   channel ""        -> production (default, registry + pin from subscription)
//!
//! Channels are stored on the Subscription struct's `channel` field.
//! Multiple subscriptions with different channels can coexist for the same
//! package — only the active channel's subscription is materialized.

use std::path::Path;

use persistence::Sheet;

use crate::error::CalpError;
use crate::manifest::{Subscription, SubscribedSheet};

/// Pull sheets from a local .cala file (used for non-registry channels like dev/test).
pub fn pull_from_file(
    source_path: &Path,
    sheet_names: &[String],
) -> Result<FilePullResult, CalpError> {
    if !source_path.exists() {
        return Err(CalpError::Registry(format!(
            "Channel source not found: {}", source_path.display()
        )));
    }

    let workbook = calcula_format::load_calcula(source_path)
        .map_err(|e| CalpError::Format(format!("Failed to load source: {}", e)))?;

    let mut pulled_sheets = Vec::new();

    if sheet_names.is_empty() {
        for sheet in &workbook.sheets {
            pulled_sheets.push(PulledSheet {
                source_sheet_id: sheet.id,
                name: sheet.name.clone(),
                sheet: sheet.clone(),
            });
        }
    } else {
        for name in sheet_names {
            let sheet = workbook.sheets.iter()
                .find(|s| s.name.eq_ignore_ascii_case(name))
                .ok_or_else(|| CalpError::SheetNotFound(name.clone()))?;
            pulled_sheets.push(PulledSheet {
                source_sheet_id: sheet.id,
                name: sheet.name.clone(),
                sheet: sheet.clone(),
            });
        }
    }

    Ok(FilePullResult {
        sheets: pulled_sheets,
        tables: workbook.tables,
        named_ranges: workbook.named_ranges,
    })
}

pub struct FilePullResult {
    pub sheets: Vec<PulledSheet>,
    pub tables: Vec<persistence::SavedTable>,
    pub named_ranges: Vec<persistence::SavedNamedRange>,
}

pub struct PulledSheet {
    pub source_sheet_id: identity::SheetId,
    pub name: String,
    pub sheet: Sheet,
}

/// Build a subscription entry for a file-based channel.
pub fn make_file_subscription(
    package_name: &str,
    channel: &str,
    source_path: &str,
    pulled: &FilePullResult,
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
        package_name: package_name.to_string(),
        registry_url: format!("file://{}", source_path),
        version_pin: format!("channel:{}", channel),
        resolved_version: format!("channel:{}", channel),
        resolved_at: now.to_string(),
        sheets,
        channel: channel.to_string(),
        extra: std::collections::HashMap::new(),
    }
}

/// Check if a subscription is a file-based channel (not a registry subscription).
pub fn is_file_channel(sub: &Subscription) -> bool {
    sub.version_pin.starts_with("channel:")
}

/// Get the channel name from a subscription (empty string = default/production).
pub fn channel_name(sub: &Subscription) -> &str {
    &sub.channel
}

/// Filter subscriptions by active channel.
pub fn subscriptions_for_channel<'a>(
    subs: &'a [Subscription],
    channel: &str,
) -> Vec<&'a Subscription> {
    subs.iter().filter(|s| s.channel == channel).collect()
}

/// List all distinct channel names across subscriptions.
pub fn list_channels(subs: &[Subscription]) -> Vec<String> {
    let mut channels: Vec<String> = subs.iter()
        .map(|s| s.channel.clone())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    channels.sort();
    channels
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
    fn pull_from_file_all_sheets() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("source.cala");
        let wb = make_test_workbook();
        calcula_format::save_calcula(&wb, &path).unwrap();

        let result = pull_from_file(&path, &[]).unwrap();
        assert_eq!(result.sheets.len(), 2);
    }

    #[test]
    fn pull_from_file_selected() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("source.cala");
        let wb = make_test_workbook();
        calcula_format::save_calcula(&wb, &path).unwrap();

        let result = pull_from_file(&path, &["Source2".to_string()]).unwrap();
        assert_eq!(result.sheets.len(), 1);
        assert_eq!(result.sheets[0].name, "Source2");
    }

    #[test]
    fn pull_nonexistent_file() {
        let result = pull_from_file(Path::new("/no/such/file.cala"), &[]);
        assert!(result.is_err());
    }

    #[test]
    fn file_channel_detection() {
        let sub = make_file_subscription("pkg", "dev", "/path/to/file.cala",
            &FilePullResult { sheets: vec![], tables: vec![], named_ranges: vec![] },
            "2026-01-01T00:00:00Z");
        assert!(is_file_channel(&sub));
        assert_eq!(channel_name(&sub), "dev");

        let registry_sub = Subscription {
            package_name: "pkg".to_string(),
            registry_url: "file:///registry".to_string(),
            version_pin: "^1.0".to_string(),
            resolved_version: "1.2.0".to_string(),
            resolved_at: String::new(),
            sheets: Vec::new(),
            channel: String::new(),
            extra: std::collections::HashMap::new(),
        };
        assert!(!is_file_channel(&registry_sub));
        assert_eq!(channel_name(&registry_sub), "");
    }

    #[test]
    fn list_and_filter_channels() {
        let subs = vec![
            Subscription {
                package_name: "pkg".to_string(), registry_url: String::new(),
                version_pin: "^1.0".to_string(), resolved_version: "1.0.0".to_string(),
                resolved_at: String::new(), sheets: Vec::new(), channel: String::new(),
                extra: std::collections::HashMap::new(),
            },
            Subscription {
                package_name: "pkg".to_string(), registry_url: String::new(),
                version_pin: "channel:dev".to_string(), resolved_version: "channel:dev".to_string(),
                resolved_at: String::new(), sheets: Vec::new(), channel: "dev".to_string(),
                extra: std::collections::HashMap::new(),
            },
            Subscription {
                package_name: "pkg".to_string(), registry_url: String::new(),
                version_pin: "channel:test".to_string(), resolved_version: "channel:test".to_string(),
                resolved_at: String::new(), sheets: Vec::new(), channel: "test".to_string(),
                extra: std::collections::HashMap::new(),
            },
        ];

        let channels = list_channels(&subs);
        assert_eq!(channels, vec!["", "dev", "test"]);

        let dev_subs = subscriptions_for_channel(&subs, "dev");
        assert_eq!(dev_subs.len(), 1);
        assert_eq!(dev_subs[0].channel, "dev");

        let prod_subs = subscriptions_for_channel(&subs, "");
        assert_eq!(prod_subs.len(), 1);
    }

    #[test]
    fn arbitrary_channel_names() {
        let sub = make_file_subscription("pkg", "staging-eu", "/data/staging.cala",
            &FilePullResult { sheets: vec![], tables: vec![], named_ranges: vec![] },
            "2026-01-01T00:00:00Z");
        assert_eq!(channel_name(&sub), "staging-eu");
        assert!(is_file_channel(&sub));
    }
}
