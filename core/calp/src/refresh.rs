//! FILENAME: core/calp/src/refresh.rs
//! PURPOSE: Refresh workflow — atomic update of subscriptions with preview,
//! conflict detection, and rollback support.
//! CONTEXT: When the consumer refreshes, we:
//! 1. Compute a preview (what would change)
//! 2. The consumer confirms
//! 3. Apply atomically (all subscriptions or none)
//! 4. Rebase overrides, detect conflicts

use std::collections::HashMap;

use identity::{CellId, SheetId};
use serde::{Deserialize, Serialize};

use crate::error::CalpError;
use crate::manifest::Subscription;
use crate::overrides::{OverrideLayer, OverrideValue};
use crate::pull::{self, PullRequest, PullResult};
use crate::registry::LocalRegistry;
use crate::version::VersionPin;

// ============================================================================
// Refresh Preview
// ============================================================================

/// A preview of what a refresh would change, computed before applying.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshPreview {
    /// Per-subscription preview.
    pub subscription_previews: Vec<SubscriptionPreview>,
    /// Total counts across all subscriptions.
    pub total_cells_changed: usize,
    pub total_sheets_added: usize,
    pub total_sheets_removed: usize,
    pub total_overrides_conflicted: usize,
    pub total_overrides_auto_cleared: usize,
}

/// Preview for a single subscription's refresh.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionPreview {
    pub package_name: String,
    pub current_version: String,
    pub new_version: String,
    /// Sheets that would be added (new in upstream).
    pub sheets_added: Vec<SheetChangeInfo>,
    /// Sheets that would be removed (deleted in upstream).
    pub sheets_removed: Vec<SheetChangeInfo>,
    /// Sheets that exist in both versions (updated).
    pub sheets_updated: Vec<SheetChangeInfo>,
    /// Cells that changed upstream.
    pub cells_changed: usize,
    /// Overrides that would become conflicts.
    pub overrides_conflicted: usize,
    /// Overrides that would auto-clear (match new upstream).
    pub overrides_auto_cleared: usize,
}

/// Info about a sheet change in a refresh preview.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetChangeInfo {
    pub sheet_id: SheetId,
    pub name: String,
    /// Number of overrides on this sheet that would be affected.
    pub override_count: usize,
}

// ============================================================================
// Structural Conflicts
// ============================================================================

/// A structural conflict: upstream deleted a sheet that has local overrides.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuralConflict {
    pub sheet_id: SheetId,
    pub sheet_name: String,
    pub override_count: usize,
}

/// Resolution for a structural conflict.
#[derive(Debug, Clone)]
pub enum StructuralResolution {
    /// Save the sheet locally (detach from upstream).
    SaveLocally,
    /// Accept deletion (discard overrides).
    AcceptDeletion,
}

// ============================================================================
// Refresh Result
// ============================================================================

/// Result of applying a refresh.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshResult {
    pub subscriptions_refreshed: usize,
    pub sheets_added: usize,
    pub sheets_removed: usize,
    pub sheets_updated: usize,
    pub conflicts_created: usize,
    pub overrides_auto_cleared: usize,
    pub structural_conflicts: Vec<StructuralConflict>,
}

// ============================================================================
// Compute Preview
// ============================================================================

/// Compute a refresh preview for all subscriptions without applying changes.
pub fn compute_preview(
    registry: &LocalRegistry,
    subscriptions: &[Subscription],
    override_layer: &OverrideLayer,
) -> Result<RefreshPreview, CalpError> {
    let mut sub_previews = Vec::new();
    let mut total_cells = 0;
    let mut total_added = 0;
    let mut total_removed = 0;
    let mut total_conflicts = 0;
    let total_cleared = 0;

    for sub in subscriptions {
        let pin = VersionPin::parse(&sub.version_pin)?;
        let resolved = registry.resolve_version(&sub.package_name, &pin)?;
        let new_version_str = resolved.to_string();

        if new_version_str == sub.resolved_version {
            // No update available
            continue;
        }

        let new_manifest = registry.get_version_manifest(&sub.package_name, &new_version_str)?;

        // Determine sheet changes
        let old_sheet_ids: Vec<SheetId> = sub.sheets.iter()
            .map(|s| s.package_sheet_id)
            .collect();
        let new_sheet_ids: Vec<SheetId> = new_manifest.sheets.iter()
            .map(|s| s.sheet_id)
            .collect();

        let mut sheets_added = Vec::new();
        let mut sheets_removed = Vec::new();
        let mut sheets_updated = Vec::new();

        for new_sheet in &new_manifest.sheets {
            if !old_sheet_ids.contains(&new_sheet.sheet_id) {
                sheets_added.push(SheetChangeInfo {
                    sheet_id: new_sheet.sheet_id,
                    name: new_sheet.name.clone(),
                    override_count: 0,
                });
            } else {
                // Find local sheet ID for override counting
                let local_sid = sub.sheets.iter()
                    .find(|s| s.package_sheet_id == new_sheet.sheet_id)
                    .map(|s| s.local_sheet_id);

                let ovr_count = local_sid
                    .map(|sid| override_layer.overrides_for_sheet(sid).len())
                    .unwrap_or(0);

                sheets_updated.push(SheetChangeInfo {
                    sheet_id: new_sheet.sheet_id,
                    name: new_sheet.name.clone(),
                    override_count: ovr_count,
                });
            }
        }

        for old_sub_sheet in &sub.sheets {
            if !new_sheet_ids.contains(&old_sub_sheet.package_sheet_id) {
                let ovr_count = override_layer
                    .overrides_for_sheet(old_sub_sheet.local_sheet_id).len();
                sheets_removed.push(SheetChangeInfo {
                    sheet_id: old_sub_sheet.package_sheet_id,
                    name: old_sub_sheet.local_name.clone(),
                    override_count: ovr_count,
                });
            }
        }

        // Estimate conflict count from overrides on updated sheets
        let conflict_estimate: usize = sheets_updated.iter()
            .map(|s| s.override_count)
            .sum();

        let preview = SubscriptionPreview {
            package_name: sub.package_name.clone(),
            current_version: sub.resolved_version.clone(),
            new_version: new_version_str,
            cells_changed: 0, // Would require full diff — expensive, skip for preview
            overrides_conflicted: conflict_estimate,
            overrides_auto_cleared: 0,
            sheets_added: sheets_added.clone(),
            sheets_removed: sheets_removed.clone(),
            sheets_updated: sheets_updated.clone(),
        };

        total_cells += preview.cells_changed;
        total_added += sheets_added.len();
        total_removed += sheets_removed.len();
        total_conflicts += conflict_estimate;

        sub_previews.push(preview);
    }

    Ok(RefreshPreview {
        subscription_previews: sub_previews,
        total_cells_changed: total_cells,
        total_sheets_added: total_added,
        total_sheets_removed: total_removed,
        total_overrides_conflicted: total_conflicts,
        total_overrides_auto_cleared: total_cleared,
    })
}

// ============================================================================
// Apply Refresh
// ============================================================================

/// The pulled data for one subscription, ready to be applied.
pub struct RefreshPayload {
    pub subscription_index: usize,
    pub pull_result: PullResult,
}

/// Pull new versions for all subscriptions that have updates available.
/// Returns payloads ready for atomic application, or an error if any pull fails
/// (in which case nothing should be applied — all-or-nothing).
pub fn pull_all_updates(
    registry: &LocalRegistry,
    subscriptions: &[Subscription],
) -> Result<Vec<RefreshPayload>, CalpError> {
    let mut payloads = Vec::new();

    for (i, sub) in subscriptions.iter().enumerate() {
        let pin = VersionPin::parse(&sub.version_pin)?;
        let resolved = registry.resolve_version(&sub.package_name, &pin)?;
        let new_version_str = resolved.to_string();

        if new_version_str == sub.resolved_version {
            continue; // No update
        }

        let request = PullRequest {
            package_name: sub.package_name.clone(),
            registry_url: sub.registry_url.clone(),
            version_pin: pin,
            now: String::new(), // Caller sets this
        };

        let result = pull::pull(registry, &request)?;

        payloads.push(RefreshPayload {
            subscription_index: i,
            pull_result: result,
        });
    }

    Ok(payloads)
}

/// Apply refresh payloads and rebase overrides.
/// This is called after the user confirms the preview.
///
/// `upstream_values` maps each existing override's (sheet_id, cell_id) to the
/// NEW upstream value for that cell, so the rebase can mark conflicts and
/// auto-clear overrides that now match upstream. The caller builds this map
/// from the pulled payloads (the Tauri layer resolves override positions via
/// the identity registry).
///
/// Returns: updated subscriptions, structural conflicts, and the rebase results.
pub fn apply_refresh(
    payloads: Vec<RefreshPayload>,
    subscriptions: &mut Vec<Subscription>,
    override_layer: &mut OverrideLayer,
    upstream_values: &HashMap<(SheetId, CellId), OverrideValue>,
    now: &str,
) -> RefreshResult {
    let mut sheets_added = 0;
    let mut sheets_removed = 0;
    let mut sheets_updated = 0;
    let mut structural_conflicts = Vec::new();

    for payload in &payloads {
        let sub = &mut subscriptions[payload.subscription_index];
        let pull = &payload.pull_result;

        let old_package_sheet_ids: Vec<SheetId> = sub.sheets.iter()
            .map(|s| s.package_sheet_id)
            .collect();
        let new_package_sheet_ids: Vec<SheetId> = pull.sheets.iter()
            .map(|s| s.package_sheet_id)
            .collect();

        // Detect removed sheets (structural conflicts if they have overrides)
        for old_sub_sheet in &sub.sheets {
            if !new_package_sheet_ids.contains(&old_sub_sheet.package_sheet_id) {
                let ovr_count = override_layer
                    .overrides_for_sheet(old_sub_sheet.local_sheet_id).len();
                if ovr_count > 0 {
                    structural_conflicts.push(StructuralConflict {
                        sheet_id: old_sub_sheet.local_sheet_id,
                        sheet_name: old_sub_sheet.local_name.clone(),
                        override_count: ovr_count,
                    });
                }
                sheets_removed += 1;
            }
        }

        // Count added sheets
        for pulled in &pull.sheets {
            if !old_package_sheet_ids.contains(&pulled.package_sheet_id) {
                sheets_added += 1;
            } else {
                sheets_updated += 1;
            }
        }

        // Update subscription metadata. Preserve the existing local sheet
        // mapping for sheets that were already subscribed: pull() minted
        // fresh local ids, but the materialized grids, the override layer,
        // and the workbook's sheet list keep using the original ones.
        let mut new_sheets = pull.subscription.sheets.clone();
        for new_sheet in new_sheets.iter_mut() {
            if let Some(old) = sub.sheets.iter()
                .find(|s| s.package_sheet_id == new_sheet.package_sheet_id)
            {
                new_sheet.local_sheet_id = old.local_sheet_id;
                new_sheet.local_name = old.local_name.clone();
            }
        }
        sub.resolved_version = pull.resolved_version.to_string();
        sub.resolved_at = now.to_string();
        sub.sheets = new_sheets;
    }

    // Rebase overrides against the new upstream values
    let (conflicts_created, overrides_cleared) = override_layer.rebase(upstream_values);

    RefreshResult {
        subscriptions_refreshed: payloads.len(),
        sheets_added,
        sheets_removed,
        sheets_updated,
        conflicts_created,
        overrides_auto_cleared: overrides_cleared,
        structural_conflicts,
    }
}

/// Detach a workbook from all upstream subscriptions.
/// Strips the subscription manifest and override layer.
pub fn detach(
    subscriptions: &mut Vec<Subscription>,
    override_layer: &mut OverrideLayer,
) {
    subscriptions.clear();
    *override_layer = OverrideLayer::new();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use persistence::SavedCell;
    use crate::manifest::SubscribedSheet;
    use tempfile::TempDir;
    use crate::publish::{self, PublishRequest};
    use crate::version::SemVer;

    fn make_workbook() -> persistence::Workbook {
        let mut sheet = persistence::Sheet::new("Sheet1".to_string());
        let cell = engine::cell::Cell::new_number(100.0);
        sheet.cells.insert((0, 0), SavedCell::from_cell(&cell));

        let mut wb = persistence::Workbook::default();
        wb.sheets = vec![sheet];
        wb
    }

    fn setup_registry_with_versions(dir: &TempDir) -> LocalRegistry {
        let reg = LocalRegistry::open(dir.path()).unwrap();
        let wb = make_workbook();

        for ver in [(1, 0, 0), (1, 1, 0)] {
            let request = PublishRequest {
                workbook: &wb,
                package_name: "test-pkg".to_string(),
                version: SemVer::new(ver.0, ver.1, ver.2),
                kind: "report".to_string(),
                sheet_indices: vec![0],
                now: "2026-01-01T00:00:00Z".to_string(),
                published_by: "tester".to_string(),
                writeback_regions: None,
                object_scripts: None,
                data_sources: Vec::new(),
                excluded_regions: Vec::new(),
            };
            publish::publish(&reg, &request).unwrap();
        }
        reg
    }

    #[test]
    fn preview_detects_available_update() {
        let dir = TempDir::new().unwrap();
        let reg = setup_registry_with_versions(&dir);

        let sub = Subscription {
            package_name: "test-pkg".to_string(),
            registry_url: format!("file://{}", dir.path().display()),
            version_pin: "^1.0.0".to_string(),
            resolved_version: "1.0.0".to_string(),
            resolved_at: "2026-01-01T00:00:00Z".to_string(),
            sheets: vec![SubscribedSheet {
                package_sheet_id: SheetId::from_bytes(identity::generate_uuid_v7()),
                local_sheet_id: SheetId::from_bytes(identity::generate_uuid_v7()),
                local_name: "Sheet1".to_string(),
                extra: std::collections::HashMap::new(),
            }],
            channel: String::new(),
            data_source_configs: Vec::new(),
            extra: std::collections::HashMap::new(),
        };

        let layer = OverrideLayer::new();
        let preview = compute_preview(&reg, &[sub], &layer).unwrap();

        assert_eq!(preview.subscription_previews.len(), 1);
        assert_eq!(preview.subscription_previews[0].new_version, "1.1.0");
        assert_eq!(preview.subscription_previews[0].current_version, "1.0.0");
    }

    #[test]
    fn preview_no_update_when_current() {
        let dir = TempDir::new().unwrap();
        let reg = setup_registry_with_versions(&dir);

        let sub = Subscription {
            package_name: "test-pkg".to_string(),
            registry_url: String::new(),
            version_pin: "=1.1.0".to_string(),
            resolved_version: "1.1.0".to_string(), // already at latest matching
            resolved_at: "2026-01-01T00:00:00Z".to_string(),
            sheets: Vec::new(),
            channel: String::new(),
            data_source_configs: Vec::new(),
            extra: std::collections::HashMap::new(),
        };

        let layer = OverrideLayer::new();
        let preview = compute_preview(&reg, &[sub], &layer).unwrap();
        assert!(preview.subscription_previews.is_empty());
    }

    #[test]
    fn pull_all_updates_atomic() {
        let dir = TempDir::new().unwrap();
        let reg = setup_registry_with_versions(&dir);

        let sub = Subscription {
            package_name: "test-pkg".to_string(),
            registry_url: String::new(),
            version_pin: "^1.0.0".to_string(),
            resolved_version: "1.0.0".to_string(),
            resolved_at: "2026-01-01T00:00:00Z".to_string(),
            sheets: Vec::new(),
            channel: String::new(),
            data_source_configs: Vec::new(),
            extra: std::collections::HashMap::new(),
        };

        let payloads = pull_all_updates(&reg, &[sub]).unwrap();
        assert_eq!(payloads.len(), 1);
        assert_eq!(payloads[0].pull_result.resolved_version, SemVer::new(1, 1, 0));
    }

    #[test]
    fn apply_refresh_updates_subscription() {
        let dir = TempDir::new().unwrap();
        let reg = setup_registry_with_versions(&dir);

        let mut subs = vec![Subscription {
            package_name: "test-pkg".to_string(),
            registry_url: String::new(),
            version_pin: "^1.0.0".to_string(),
            resolved_version: "1.0.0".to_string(),
            resolved_at: "2026-01-01T00:00:00Z".to_string(),
            sheets: Vec::new(),
            channel: String::new(),
            data_source_configs: Vec::new(),
            extra: std::collections::HashMap::new(),
        }];

        let payloads = pull_all_updates(&reg, &subs).unwrap();
        let mut layer = OverrideLayer::new();

        let result = apply_refresh(
            payloads, &mut subs, &mut layer, &HashMap::new(), "2026-01-02T00:00:00Z",
        );

        assert_eq!(result.subscriptions_refreshed, 1);
        assert_eq!(subs[0].resolved_version, "1.1.0");
    }

    #[test]
    fn apply_refresh_detects_conflicts_and_preserves_local_sheet_ids() {
        let dir = TempDir::new().unwrap();
        let reg = setup_registry_with_versions(&dir);

        // Subscribe at 1.0.0
        let pull_result = pull::pull(&reg, &PullRequest {
            package_name: "test-pkg".to_string(),
            registry_url: format!("file://{}", dir.path().display()),
            version_pin: VersionPin::parse("^1.0").unwrap(),
            now: "2026-01-01T00:00:00Z".to_string(),
        }).unwrap();
        let mut subs = vec![pull_result.subscription.clone()];
        // Pin behind so 1.1.0 counts as an update
        subs[0].resolved_version = "1.0.0".to_string();
        let original_local_id = subs[0].sheets[0].local_sheet_id;

        // Consumer overrides a cell; upstream 1.1.0 changed the same cell.
        let mut layer = OverrideLayer::new();
        let cell_id = identity::CellId::from_bytes(identity::generate_uuid_v7());
        layer.set_override(crate::overrides::CellOverride {
            sheet_id: original_local_id,
            cell_id,
            position: (0, 0),
            baseline: OverrideValue::Value { display: "100".to_string() },
            current: OverrideValue::Value { display: "999".to_string() },
            created_at: "2026-01-01T00:00:00Z".to_string(),
            modified_at: "2026-01-01T00:00:00Z".to_string(),
            author: String::new(),
            conflict: false,
            upstream_new: None,
            extra: HashMap::new(),
        });

        let payloads = pull_all_updates(&reg, &subs).unwrap();
        // New upstream value differs from the override's baseline -> conflict.
        let mut upstream = HashMap::new();
        upstream.insert(
            (original_local_id, cell_id),
            OverrideValue::Value { display: "150".to_string() },
        );

        let result = apply_refresh(payloads, &mut subs, &mut layer, &upstream, "2026-01-02T00:00:00Z");

        assert_eq!(result.conflicts_created, 1);
        assert!(layer.get(original_local_id, cell_id).unwrap().conflict);
        // The pre-existing sheet keeps its original local id across refresh.
        assert_eq!(subs[0].sheets[0].local_sheet_id, original_local_id);
    }

    #[test]
    fn detach_clears_everything() {
        let mut subs = vec![Subscription {
            package_name: "pkg".to_string(),
            registry_url: String::new(),
            version_pin: "^1.0".to_string(),
            resolved_version: "1.0.0".to_string(),
            resolved_at: String::new(),
            sheets: Vec::new(),
            channel: String::new(),
            data_source_configs: Vec::new(),
            extra: std::collections::HashMap::new(),
        }];
        let mut layer = OverrideLayer::new();
        let (s, c) = (
            SheetId::from_bytes(identity::generate_uuid_v7()),
            CellId::from_bytes(identity::generate_uuid_v7()),
        );
        layer.set_override(crate::overrides::CellOverride {
            sheet_id: s,
            cell_id: c,
            position: (0, 0),
            baseline: OverrideValue::Value { display: "1".to_string() },
            current: OverrideValue::Value { display: "2".to_string() },
            created_at: String::new(),
            modified_at: String::new(),
            author: String::new(),
            conflict: false,
            upstream_new: None,
            extra: std::collections::HashMap::new(),
        });

        detach(&mut subs, &mut layer);

        assert!(subs.is_empty());
        assert_eq!(layer.count(), 0);
    }
}
