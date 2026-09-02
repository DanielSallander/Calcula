//! FILENAME: core/calp/src/refresh.rs
//! PURPOSE: Refresh workflow — atomic update of subscriptions with preview,
//! conflict detection, and rollback support.
//! CONTEXT: When the consumer refreshes, we:
//! 1. Compute a preview (what would change)
//! 2. The consumer confirms
//! 3. Apply atomically (all subscriptions or none)
//! 4. Rebase overrides, detect conflicts

use std::collections::HashMap;
use std::path::Path;

use identity::{CellId, SheetId};
use serde::{Deserialize, Serialize};

use crate::error::CalpError;
use crate::integrity::PinPolicy;
use crate::manifest::Subscription;
use crate::overrides::{OverrideLayer, OverrideValue};
use crate::pull::{self, PullRequest, PullResult};
use crate::workspace_id::WorkspaceScope;
use crate::transport::WorkspaceTransport;
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
    /// False when any subscription's cell count was capped by a budget. The
    /// dialog must then say "at least N" rather than "N".
    pub total_cells_changed_exact: bool,
    /// True when EVERY override-bearing sheet was examined, so the conflict
    /// list is the whole truth. False gates Apply: the user cannot be asked to
    /// resolve a list that silently omits rows.
    pub conflicts_exact: bool,
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
    /// Cells that changed upstream. Exact unless `cells_changed_exact` is
    /// false, in which case it is a floor ("at least this many").
    pub cells_changed: usize,
    /// Whether `cells_changed` is the whole truth or a bounded floor.
    pub cells_changed_exact: bool,
    /// How many sheets had a changed data artifact — meaningful even when the
    /// cell count had to be capped.
    pub sheets_with_data_changes: usize,
    /// Overrides that would become conflicts.
    pub overrides_conflicted: usize,
    /// Overrides that would auto-clear (match new upstream).
    pub overrides_auto_cleared: usize,
    /// EVERY conflict this refresh would create, one row per cell, carrying the
    /// full three-way triple the resolver needs: baseline (base), current
    /// (mine), upstream_new (theirs).
    ///
    /// Computed with the same predicate the apply uses
    /// ([`crate::overrides::classify_rebase`]), from the same artifact, so the
    /// dialog cannot ask about cells the apply will not touch. `overrides_conflicted`
    /// is `conflicts.len()` — it used to be "every override on a changed sheet",
    /// a number nobody had computed.
    pub conflicts: Vec<ConflictPreviewCell>,
    /// Sheets whose artifacts could not be examined, so their conflicts are
    /// unknown. NEVER a silent cap: `calp_refresh_apply` refuses while this is
    /// non-empty, because a resolver that silently omits rows would tell the
    /// user they had decided everything.
    pub unexamined_sheets: Vec<UnexaminedSheet>,
}

/// One conflicted cell, ready for a three-way resolver.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictPreviewCell {
    /// The LOCAL sheet id — the key `accept_upstream` / `keep_override` take,
    /// and the one the workbook actually holds. The publisher's id is a
    /// different uuid on a subscriber.
    pub local_sheet_id: SheetId,
    pub cell_id: CellId,
    /// The LIVE local sheet name.
    ///
    /// From `local_sheet_names`, NOT from `SubscribedSheet.local_name` — that is
    /// stamped at subscribe and never restamped, and renaming a subscribed sheet
    /// is allowed, so the ledger's copy names a tab that may not be on screen.
    /// The resolver puts this in front of a destructive decision, so it has to
    /// be the tab the user is looking at.
    pub sheet_name: String,
    /// (row, col) as resolved for the refresh — the id registry's answer where
    /// it has one, the override's recorded position otherwise.
    pub position: (u32, u32),
    /// A1 of `position`, so the dialog does not re-implement the conversion.
    pub a1: String,
    /// base — what upstream held when the override was made.
    pub baseline: OverrideValue,
    /// mine — what the subscriber typed.
    pub current: OverrideValue,
    /// theirs — what upstream holds now.
    pub upstream_new: OverrideValue,
}

/// A sheet the preview could not read, and why.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnexaminedSheet {
    pub package_sheet_id: SheetId,
    pub sheet_name: String,
    /// `"unreadable"` — the artifact is missing, too large to parse, or the
    /// workspace went away mid-preview.
    pub reason: String,
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
///
/// `override_positions` is the ONE input the preview lacked and the apply has:
/// where each override's cell actually sits now. The apply resolves it as
/// `id_registry.cell_position(sheet, cell).unwrap_or(ovr.position)`, and the id
/// registry lives in the app's `AppState`, not here — so the caller resolves it
/// and hands it over. Absent entries fall back to the override's recorded
/// position, exactly as the apply's `unwrap_or` does.
///
/// Without it the preview cannot name a cell's upstream value, which is why the
/// conflict figure was a fabricated estimate (every override on a changed sheet)
/// for as long as it was.
pub fn compute_preview(
    registry: &dyn WorkspaceTransport,
    subscriptions: &[Subscription],
    override_layer: &OverrideLayer,
    override_positions: &HashMap<(SheetId, CellId), (u32, u32)>,
    // LIVE local sheet names by local sheet id. The ledger name is stamped at
    // subscribe and never restamped, so it goes stale the moment a subscriber
    // renames the tab.
    local_sheet_names: &HashMap<SheetId, String>,
) -> Result<RefreshPreview, CalpError> {
    let mut sub_previews = Vec::new();
    let mut total_cells = 0;
    let mut total_added = 0;
    let mut total_removed = 0;
    let mut total_conflicts = 0;
    let total_cleared = 0;
    let mut total_cells_exact = true;
    let mut conflicts_exact = true;

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
            // A DETACHED SHEET IS NOT AN ADDITION. Detaching drops the sheet
            // from `sub.sheets` and records its package id in `detached_sheets`
            // precisely so a later refresh does not re-adopt it — `apply_refresh`
            // honours that. The PREVIEW did not, so it counted the sheet as
            // "added" on every refresh, forever, promising to bring back
            // something the apply would never touch.
            if sub.detached_sheets.contains(&new_sheet.sheet_id) {
                continue;
            }
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

        // THE REAL CONFLICTS, not an estimate.
        //
        // This was `sheets_updated.iter().map(|s| s.override_count).sum()` —
        // every override on any sheet whose artifact changed, whether or not
        // upstream had touched that particular cell. On a sheet where the
        // publisher edited one cell and the subscriber had edited twenty
        // others, the dialog reported twenty conflicts and the apply created
        // one. The number was never computed; it was inferred from a proxy.
        let (conflicts, unexamined_sheets) = collect_conflicts(
            registry,
            &sub.package_name,
            &new_version_str,
            sub,
            &sheets_updated,
            override_layer,
            override_positions,
            local_sheet_names,
        );

        // REAL cell counts, bounded.
        //
        // This used to be `cells_changed: 0` with a comment saying a full diff
        // would be expensive — so the confirm dialog showed the user a number
        // nobody had computed, and asked them to approve it. A budgeted exact
        // count with an honest `exact` flag beside it is strictly better than a
        // fabricated zero: past the budget the dialog says "at least N", which
        // is a true sentence.
        let (cells_changed, cells_exact, sheets_with_data_changes) = count_upstream_cell_changes(
            registry,
            &sub.package_name,
            &sub.resolved_version,
            &new_version_str,
            &new_manifest,
        );

        let preview = SubscriptionPreview {
            package_name: sub.package_name.clone(),
            current_version: sub.resolved_version.clone(),
            new_version: new_version_str,
            cells_changed,
            cells_changed_exact: cells_exact,
            sheets_with_data_changes,
            overrides_conflicted: conflicts.len(),
            overrides_auto_cleared: 0,
            sheets_added: sheets_added.clone(),
            sheets_removed: sheets_removed.clone(),
            sheets_updated: sheets_updated.clone(),
            conflicts,
            unexamined_sheets,
        };

        if !cells_exact {
            total_cells_exact = false;
        }
        if !preview.unexamined_sheets.is_empty() {
            conflicts_exact = false;
        }
        total_cells += preview.cells_changed;
        total_added += sheets_added.len();
        total_removed += sheets_removed.len();
        total_conflicts += preview.overrides_conflicted;

        sub_previews.push(preview);
    }

    Ok(RefreshPreview {
        subscription_previews: sub_previews,
        total_cells_changed: total_cells,
        total_sheets_added: total_added,
        total_sheets_removed: total_removed,
        total_overrides_conflicted: total_conflicts,
        total_overrides_auto_cleared: total_cleared,
        total_cells_changed_exact: total_cells_exact,
        conflicts_exact,
    })
}

/// Every conflict one subscription's refresh would create, plus the sheets that
/// could not be read.
///
/// Reaches the SAME verdict the apply does, by construction rather than by
/// coincidence: it reads the new version's `data.json`, runs it through
/// `sheet_data_to_cells` — the exact conversion `pull()` uses — and asks
/// [`crate::overrides::classify_rebase`], the predicate `rebase` itself now asks.
///
/// NOT budgeted by sheet count, deliberately, and this is the one place that
/// differs from `count_upstream_cell_changes`. A cell count may honestly be "at
/// least N"; a list of decisions the user is about to make may not be "some of
/// them". Anything unreadable is REPORTED as unexamined rather than skipped, and
/// the apply refuses while that list is non-empty.
#[allow(clippy::too_many_arguments)]
fn collect_conflicts(
    registry: &dyn WorkspaceTransport,
    package: &str,
    new_version: &str,
    sub: &Subscription,
    sheets_updated: &[SheetChangeInfo],
    override_layer: &OverrideLayer,
    override_positions: &HashMap<(SheetId, CellId), (u32, u32)>,
    local_sheet_names: &HashMap<SheetId, String>,
) -> (Vec<ConflictPreviewCell>, Vec<UnexaminedSheet>) {
    /// Per-sheet cap on a data artifact, matching `count_upstream_cell_changes`.
    const MAX_BYTES: usize = 4 * 1024 * 1024;

    let mut conflicts = Vec::new();
    let mut unexamined = Vec::new();

    for changed in sheets_updated {
        // A sheet with no local edits cannot produce a conflict, and reading its
        // artifact would buy nothing. This is a skip that costs no honesty.
        if changed.override_count == 0 {
            continue;
        }
        let Some(sheet_sub) = sub
            .sheets
            .iter()
            .find(|s| s.package_sheet_id == changed.sheet_id)
        else {
            continue;
        };
        let local_sid = sheet_sub.local_sheet_id;

        let rel = format!("sheets/{}/data.json", changed.sheet_id);
        let parsed: Option<calcula_format::sheet_data::SheetData> =
            match registry.read_artifact(package, new_version, &rel) {
                Ok(Some(bytes)) if bytes.len() <= MAX_BYTES => serde_json::from_slice(&bytes).ok(),
                _ => None,
            };
        let Some(data) = parsed else {
            unexamined.push(UnexaminedSheet {
                package_sheet_id: changed.sheet_id,
                sheet_name: changed.name.clone(),
                reason: "unreadable".to_string(),
            });
            continue;
        };

        // THE SAME CONVERSION THE PULL USES (pull.rs feeds `sheet_data_to_cells`
        // into the payload the apply then reads), so the two sides cannot
        // disagree about what upstream holds at a cell.
        let upstream_cells = calcula_format::sheet_data::sheet_data_to_cells(&data);

        for ovr in override_layer.overrides_for_sheet(local_sid) {
            let pos = override_positions
                .get(&(local_sid, ovr.cell_id))
                .copied()
                .unwrap_or(ovr.position);
            let upstream_new =
                crate::overrides::override_value_from_saved(upstream_cells.get(&pos));
            if crate::overrides::classify_rebase(ovr, &upstream_new)
                != crate::overrides::RebaseOutcome::Conflict
            {
                continue;
            }
            conflicts.push(ConflictPreviewCell {
                local_sheet_id: local_sid,
                cell_id: ovr.cell_id,
                sheet_name: local_sheet_names
                    .get(&local_sid)
                    .cloned()
                    .unwrap_or_else(|| sheet_sub.local_name.clone()),
                position: pos,
                a1: calcula_format::cell_ref::to_a1(pos.0, pos.1),
                baseline: ovr.baseline.clone(),
                current: ovr.current.clone(),
                upstream_new,
            });
        }
    }

    (conflicts, unexamined)
}

/// How many cells actually changed between the version a subscriber is on and
/// the one they would move to.
///
/// Returns `(cells_changed, exact, sheets_with_data_changes)`.
///
/// BUDGETED, and honest about it. The old code returned a hardcoded zero with a
/// comment explaining that a real diff would be expensive — which meant the
/// confirmation dialog displayed a number nobody had computed. The budget below
/// keeps the cost bounded; the `exact` flag keeps the answer true when the
/// budget bites, so the dialog can say "at least N" instead of inventing one.
///
/// Degrades rather than failing: an old version whose manifest is unreadable
/// (pruned, or a workspace that has gone away mid-preview) yields
/// `(0, false, 0)` — "unknown", never "nothing".
fn count_upstream_cell_changes(
    registry: &dyn WorkspaceTransport,
    package: &str,
    old_version: &str,
    new_version: &str,
    new_manifest: &crate::manifest::VersionManifest,
) -> (usize, bool, usize) {
    /// Sheet data artifacts worth parsing for one subscription's preview.
    const MAX_SHEETS: usize = 16;
    /// Per-side cap on a single sheet's data artifact.
    const MAX_BYTES: usize = 4 * 1024 * 1024;

    let Ok(old_manifest) = registry.get_version_manifest(package, old_version) else {
        return (0, false, 0);
    };

    // L1: which sheet data artifacts differ at all. Signed hashes on both
    // sides, so this costs nothing beyond the two manifests already in hand.
    let changed: Vec<&String> = new_manifest
        .artifact_checksums
        .iter()
        .filter(|(rel, hash)| {
            rel.starts_with("sheets/")
                && rel.ends_with("/data.json")
                && old_manifest.artifact_checksums.get(*rel).is_some_and(|old| old != *hash)
        })
        .map(|(rel, _)| rel)
        .collect();

    let sheets_with_data_changes = changed.len();
    let mut total = 0usize;
    let mut exact = true;

    for (i, rel) in changed.iter().enumerate() {
        if i >= MAX_SHEETS {
            exact = false;
            break;
        }
        let read = |version: &str| -> Option<calcula_format::sheet_data::SheetData> {
            match registry.read_artifact(package, version, rel) {
                Ok(Some(bytes)) if bytes.len() <= MAX_BYTES => serde_json::from_slice(&bytes).ok(),
                _ => None,
            }
        };
        match (read(old_version), read(new_version)) {
            (Some(before), Some(after)) => {
                // EVERY difference, derived values included — a different
                // question from the one the PUSH diff asks.
                //
                // `count_sheet_data_changes` hides formula cells whose formula
                // did not change, because on a push those are the consequence of
                // an edit that has its own row. On a REFRESH there is no such
                // consolation: nothing on the receiving side recalculates, so
                // the published cached value is what lands on the subscriber's
                // screen. A publisher who edits one input and recomputes 500
                // formula cells would have had this dialog say "1 cell(s)
                // changed" before 501 of them moved — and where the changed
                // precedent was outside the published set entirely, "0".
                total += crate::diff::count_all_cell_differences(&before, &after);
            }
            // Too large to parse, or unreadable: the sheet still changed, but
            // by how much is not something to guess at.
            _ => exact = false,
        }
    }

    (total, exact, sheets_with_data_changes)
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
///
/// `policy` is threaded straight through to `pull()` rather than chosen here,
/// because "refresh" is not one trust situation. Production (`calp_refresh_apply`)
/// passes `PinPolicy::RequirePinned`: a refresh is a request for a NEWER version
/// of something already trusted, so a subscription whose publisher this machine
/// has never pinned — the shape you get from a `.cala` that arrived by email —
/// fails with `PublisherNotPinned` instead of quietly minting the pin under the
/// label "get the latest version".
///
/// `scope` is the workspace these subscriptions live in — every subscription in
/// one batch comes from one workspace (the app groups them by scope before
/// calling), so the pin each refresh is measured against is the pin the original
/// subscribe wrote.
pub fn pull_all_updates(
    registry: &dyn WorkspaceTransport,
    subscriptions: &[Subscription],
    scope: &WorkspaceScope,
    profile_dir: &Path,
    policy: PinPolicy,
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
            version_pin: pin,
            now: String::new(), // Caller sets this
        };

        // Shares pull()'s ORIGIN + INTEGRITY gates (signature, TOFU,
        // checksums). The same TOFU pin store (profile_dir) is used, so a
        // refresh to a version signed by a changed publisher key fails here —
        // and, under RequirePinned, so does a refresh of an application this machine
        // never agreed to trust in the first place.
        let result = pull::pull(registry, &request, scope, profile_dir, policy)?;

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

        // Count added sheets. A DETACHED sheet is neither added nor updated: the
        // subscriber took it, so upstream no longer speaks for it. Without this
        // it counts as added every single refresh, forever, and the app layer
        // re-materializes it beside the copy the user detached.
        for pulled in &pull.sheets {
            if sub.detached_sheets.contains(&pulled.package_sheet_id) {
                continue;
            }
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
        // ...and drop the detached ones entirely, or the ledger would re-adopt a
        // sheet the user deliberately made theirs.
        new_sheets.retain(|s| !sub.detached_sheets.contains(&s.package_sheet_id));
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
    use crate::workspace::LocalWorkspace;
    use tempfile::TempDir;
    use crate::publish::{self, PublishRequest, PushMode};
    use crate::version::SemVer;

    /// The scope a real call site derives from the workspace's location.
    fn scope_of(dir: &TempDir) -> WorkspaceScope {
        crate::workspace_id::workspace_scope(&dir.path().to_string_lossy()).unwrap()
    }

    fn make_workbook() -> persistence::Workbook {
        let mut sheet = persistence::Sheet::new("Sheet1".to_string());
        let cell = engine::cell::Cell::new_number(100.0);
        sheet.cells.insert((0, 0), SavedCell::from_cell(&cell));

        let mut wb = persistence::Workbook::default();
        wb.sheets = vec![sheet];
        wb
    }

    fn setup_registry_with_versions(dir: &TempDir, prof: &std::path::Path) -> LocalWorkspace {
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        let wb = make_workbook();

        for ver in [(1, 0, 0), (1, 1, 0)] {
            let request = PublishRequest {
            model_writebacks: None,
                workbook: &wb,
                package_name: "test-pkg".to_string(),
                version: SemVer::new(ver.0, ver.1, ver.2),
                kind: "report".to_string(),
                mode: crate::publish::test_mode_for(&reg, "test-pkg"),
                change_summary: "test push".to_string(),
                sheet_indices: vec![0],
                now: "2026-01-01T00:00:00Z".to_string(),
                published_by: "tester".to_string(),
                writeback_regions: None,
                object_scripts: None,
                module_scripts: None,
                notebooks: None,
                data_sources: Vec::new(),
                excluded_regions: Vec::new(),
                custom_objects: Vec::new(),
                include_comments: false,
                min_app_version: String::new(),
            };
            publish::publish(&reg, &request, prof).unwrap();
        }
        reg
    }

    #[test]
    fn preview_detects_available_update() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = setup_registry_with_versions(&dir, prof.path());

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
            objects: Vec::new(),
            detached_sheets: Vec::new(),
            extra: std::collections::HashMap::new(),
        };

        let layer = OverrideLayer::new();
        let preview = compute_preview(&reg, &[sub], &layer, &HashMap::new(), &HashMap::new()).unwrap();

        assert_eq!(preview.subscription_previews.len(), 1);
        assert_eq!(preview.subscription_previews[0].new_version, "1.1.0");
        assert_eq!(preview.subscription_previews[0].current_version, "1.0.0");
    }

    /// The preview reports a REAL cell count, not a placeholder.
    ///
    /// This number is shown in a confirmation dialog. It was hardcoded to 0
    /// with a comment saying a diff would be expensive, which meant the user
    /// was asked to approve a figure nobody had computed — the diff was
    /// fabricated, not merely coarse.
    #[test]
    fn preview_reports_the_cells_that_actually_changed() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();

        // v1.0.0, then v1.1.0 with two cells edited and one added.
        let wb = make_workbook();
        let sheet_id = wb.sheets[0].id;
        let publish_it = |wb: &persistence::Workbook, version: SemVer| {
            let request = PublishRequest {
                model_writebacks: None,
                workbook: wb,
                package_name: "counted".to_string(),
                version,
                kind: "report".to_string(),
                mode: crate::publish::test_mode_for(&reg, "counted"),
                change_summary: "test push".to_string(),
                sheet_indices: vec![0],
                now: "2026-01-01T00:00:00Z".to_string(),
                published_by: "tester".to_string(),
                writeback_regions: None,
                object_scripts: None,
                module_scripts: None,
                notebooks: None,
                data_sources: Vec::new(),
                excluded_regions: Vec::new(),
                custom_objects: Vec::new(),
                include_comments: false,
                min_app_version: String::new(),
            };
            publish::publish(&reg, &request, prof.path()).unwrap();
        };
        publish_it(&wb, SemVer::new(1, 0, 0));

        let mut v2 = wb.clone();
        v2.sheets[0].cells.insert(
            (0, 0),
            persistence::SavedCell::from_cell(&engine::cell::Cell::new_number(4242.0)),
        );
        v2.sheets[0].cells.insert(
            (9, 9),
            persistence::SavedCell::from_cell(&engine::cell::Cell::new_text("new".to_string())),
        );
        publish_it(&v2, SemVer::new(1, 1, 0));

        let sub = Subscription {
            package_name: "counted".to_string(),
            registry_url: format!("file://{}", dir.path().display()),
            version_pin: "^1.0.0".to_string(),
            resolved_version: "1.0.0".to_string(),
            resolved_at: "2026-01-01T00:00:00Z".to_string(),
            sheets: vec![SubscribedSheet {
                package_sheet_id: sheet_id,
                local_sheet_id: SheetId::from_bytes(identity::generate_uuid_v7()),
                local_name: "Sheet1".to_string(),
                extra: std::collections::HashMap::new(),
            }],
            channel: String::new(),
            data_source_configs: Vec::new(),
            objects: Vec::new(),
            detached_sheets: Vec::new(),
            extra: std::collections::HashMap::new(),
        };

        let preview =
            compute_preview(&reg, &[sub], &OverrideLayer::new(), &HashMap::new(), &HashMap::new()).unwrap();
        let p = &preview.subscription_previews[0];
        assert_eq!(p.cells_changed, 2, "one edited cell and one added cell");
        assert!(p.cells_changed_exact, "small package: the count is the whole truth");
        assert_eq!(p.sheets_with_data_changes, 1);
        assert_eq!(preview.total_cells_changed, 2);
        assert!(preview.total_cells_changed_exact);
    }

    /// The positive control for the above: an update that changes no CELLS
    /// (only the version) must report zero, so the fixed count is not just
    /// "always nonzero".
    #[test]
    fn preview_reports_zero_when_only_the_version_moved() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = setup_registry_with_versions(&dir, prof.path());

        let sub = Subscription {
            package_name: "test-pkg".to_string(),
            registry_url: format!("file://{}", dir.path().display()),
            version_pin: "^1.0.0".to_string(),
            resolved_version: "1.0.0".to_string(),
            resolved_at: "2026-01-01T00:00:00Z".to_string(),
            sheets: Vec::new(),
            channel: String::new(),
            data_source_configs: Vec::new(),
            objects: Vec::new(),
            detached_sheets: Vec::new(),
            extra: std::collections::HashMap::new(),
        };

        let preview =
            compute_preview(&reg, &[sub], &OverrideLayer::new(), &HashMap::new(), &HashMap::new()).unwrap();
        let p = &preview.subscription_previews[0];
        assert_eq!(p.new_version, "1.1.0", "an update IS available");
        assert_eq!(p.cells_changed, 0, "…but the same workbook was republished");
        assert!(
            p.cells_changed_exact,
            "and zero here is a MEASURED zero, which is the whole difference \
             from the placeholder this replaced"
        );
    }

    #[test]
    fn preview_no_update_when_current() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = setup_registry_with_versions(&dir, prof.path());

        let sub = Subscription {
            package_name: "test-pkg".to_string(),
            registry_url: String::new(),
            version_pin: "=1.1.0".to_string(),
            resolved_version: "1.1.0".to_string(), // already at latest matching
            resolved_at: "2026-01-01T00:00:00Z".to_string(),
            sheets: Vec::new(),
            channel: String::new(),
            data_source_configs: Vec::new(),
            objects: Vec::new(),
            detached_sheets: Vec::new(),
            extra: std::collections::HashMap::new(),
        };

        let layer = OverrideLayer::new();
        let preview = compute_preview(&reg, &[sub], &layer, &HashMap::new(), &HashMap::new()).unwrap();
        assert!(preview.subscription_previews.is_empty());
    }

    #[test]
    fn pull_all_updates_atomic() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = setup_registry_with_versions(&dir, prof.path());

        let sub = Subscription {
            package_name: "test-pkg".to_string(),
            registry_url: String::new(),
            version_pin: "^1.0.0".to_string(),
            resolved_version: "1.0.0".to_string(),
            resolved_at: "2026-01-01T00:00:00Z".to_string(),
            sheets: Vec::new(),
            channel: String::new(),
            data_source_configs: Vec::new(),
            objects: Vec::new(),
            detached_sheets: Vec::new(),
            extra: std::collections::HashMap::new(),
        };

        let payloads = pull_all_updates(&reg, &[sub], &scope_of(&dir), prof.path(), PinPolicy::PinOnFirstUse).unwrap();
        assert_eq!(payloads.len(), 1);
        assert_eq!(payloads[0].pull_result.resolved_version, SemVer::new(1, 1, 0));
    }

    #[test]
    fn pull_all_updates_detects_tampering() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = setup_registry_with_versions(&dir, prof.path());

        // Tamper with an artifact of the NEW version (1.1.0) the refresh
        // would pull. The refresh path shares pull()'s integrity gate.
        let sheets_dir = reg.version_dir("test-pkg", "1.1.0").unwrap().join("sheets");
        let sheet_subdir = std::fs::read_dir(&sheets_dir).unwrap()
            .next().unwrap().unwrap().path();
        std::fs::write(sheet_subdir.join("data.json"), "tampered").unwrap();

        let sub = Subscription {
            package_name: "test-pkg".to_string(),
            registry_url: String::new(),
            version_pin: "^1.0.0".to_string(),
            resolved_version: "1.0.0".to_string(),
            resolved_at: "2026-01-01T00:00:00Z".to_string(),
            sheets: Vec::new(),
            channel: String::new(),
            data_source_configs: Vec::new(),
            objects: Vec::new(),
            detached_sheets: Vec::new(),
            extra: std::collections::HashMap::new(),
        };

        // unwrap_err() requires Debug on the Ok type; RefreshPayload has no
        // Debug derive (wraps PullResult), so match instead.
        let err = match pull_all_updates(&reg, &[sub], &scope_of(&dir), prof.path(), PinPolicy::PinOnFirstUse) {
            Ok(_) => panic!("refresh pull unexpectedly succeeded"),
            Err(e) => e,
        };
        assert!(matches!(err, CalpError::ChecksumMismatch { .. }));
        let msg = err.to_string();
        assert!(msg.contains("test-pkg@1.1.0"), "msg: {}", msg);
        assert!(msg.contains("does not match its published checksum"), "msg: {}", msg);
    }

    #[test]
    fn refresh_pull_carries_the_new_versions_pane_controls() {
        // v1 ships a slider; v1.1 reconfigures it AND adds a checkbox. The
        // refresh pull must hand the app layer the FULL v1.1 set in application
        // order (the replace-exactly-application-owned materialization happens
        // app-side; a refresh that dropped pane_controls left subscribers on
        // first-pull pane controls forever).
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(dir.path()).unwrap();

        let slider_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        let checkbox_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        let slider = |max: f64| persistence::SavedPaneControl {
            id: slider_id,
            name: "Rate".to_string(),
            control_type: "slider".to_string(),
            config: serde_json::json!({
                "type": "slider", "min": 0.0, "max": max, "step": 1.0, "showValue": true
            }),
            value: serde_json::json!({ "kind": "number", "value": 5.0 }),
            order: 0,
        };
        let checkbox = persistence::SavedPaneControl {
            id: checkbox_id,
            name: "Show details".to_string(),
            control_type: "checkbox".to_string(),
            config: serde_json::json!({ "type": "checkbox", "label": "Show details" }),
            value: serde_json::Value::Null,
            order: 1,
        };

        for (version, controls) in [
            (SemVer::new(1, 0, 0), vec![slider(10.0)]),
            (SemVer::new(1, 1, 0), vec![slider(100.0), checkbox]),
        ] {
            let mut wb = make_workbook();
            wb.pane_controls = controls;
            let request = PublishRequest {
            model_writebacks: None,
                workbook: &wb,
                package_name: "pane-refresh".to_string(),
                version,
                kind: "report".to_string(),
                mode: crate::publish::test_mode_for(&reg, "pane-refresh"),
                change_summary: "test push".to_string(),
                sheet_indices: vec![0],
                now: "2026-01-01T00:00:00Z".to_string(),
                published_by: "tester".to_string(),
                writeback_regions: None,
                object_scripts: None,
                module_scripts: None,
                notebooks: None,
                data_sources: Vec::new(),
                excluded_regions: Vec::new(),
                custom_objects: Vec::new(),
                include_comments: false,
                min_app_version: String::new(),
            };
            publish::publish(&reg, &request, prof.path()).unwrap();
        }

        let sub = Subscription {
            package_name: "pane-refresh".to_string(),
            registry_url: String::new(),
            version_pin: "^1.0.0".to_string(),
            resolved_version: "1.0.0".to_string(),
            resolved_at: "2026-01-01T00:00:00Z".to_string(),
            sheets: Vec::new(),
            channel: String::new(),
            data_source_configs: Vec::new(),
            objects: Vec::new(),
            detached_sheets: Vec::new(),
            extra: std::collections::HashMap::new(),
        };

        let payloads = pull_all_updates(&reg, &[sub], &scope_of(&dir), prof.path(), PinPolicy::PinOnFirstUse).unwrap();
        assert_eq!(payloads.len(), 1);
        let controls = &payloads[0].pull_result.pane_controls;
        assert_eq!(controls.len(), 2, "refresh payload carries the FULL v1.1 set");
        assert_eq!(controls[0].id, slider_id);
        assert_eq!(controls[0].config["max"], 100.0, "updated config replaces v1's");
        assert_eq!(controls[1].id, checkbox_id, "control ADDED in v1.1 arrives");
        assert_eq!(controls[1].name, "Show details");
    }

    #[test]
    fn apply_refresh_updates_subscription() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = setup_registry_with_versions(&dir, prof.path());

        let mut subs = vec![Subscription {
            package_name: "test-pkg".to_string(),
            registry_url: String::new(),
            version_pin: "^1.0.0".to_string(),
            resolved_version: "1.0.0".to_string(),
            resolved_at: "2026-01-01T00:00:00Z".to_string(),
            sheets: Vec::new(),
            channel: String::new(),
            data_source_configs: Vec::new(),
            objects: Vec::new(),
            detached_sheets: Vec::new(),
            extra: std::collections::HashMap::new(),
        }];

        let payloads = pull_all_updates(&reg, &subs, &scope_of(&dir), prof.path(), PinPolicy::PinOnFirstUse).unwrap();
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
        let prof = TempDir::new().unwrap();
        let reg = setup_registry_with_versions(&dir, prof.path());

        // Subscribe at 1.0.0
        let pull_result = pull::pull(&reg, &PullRequest {
            package_name: "test-pkg".to_string(),
            version_pin: VersionPin::parse("^1.0").unwrap(),
            now: "2026-01-01T00:00:00Z".to_string(),
        }, &scope_of(&dir), prof.path(), PinPolicy::PinOnFirstUse).unwrap();
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

        let payloads = pull_all_updates(&reg, &subs, &scope_of(&dir), prof.path(), PinPolicy::PinOnFirstUse).unwrap();
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
            objects: Vec::new(),
            detached_sheets: Vec::new(),
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
    // ======================================================================
    // The preview and the apply must name the SAME conflicts
    // ======================================================================

    /// Publish two versions of a one-cell sheet, the second holding `after`.
    fn two_versions(
        dir: &TempDir,
        prof: &std::path::Path,
        before: f64,
        after: f64,
    ) -> (LocalWorkspace, SheetId) {
        let reg = LocalWorkspace::open(dir.path()).unwrap();
        let mut wb = persistence::Workbook::default();
        let mut sheet = persistence::Sheet::new("Sheet1".to_string());
        sheet
            .cells
            .insert((0, 0), SavedCell::from_cell(&engine::cell::Cell::new_number(before)));
        wb.sheets = vec![sheet];
        let sheet_id = wb.sheets[0].id;

        let publish_it = |wb: &persistence::Workbook, version: SemVer| {
            let request = PublishRequest {
                model_writebacks: None,
                workbook: wb,
                package_name: "parity".to_string(),
                version,
                kind: "report".to_string(),
                mode: crate::publish::test_mode_for(&reg, "parity"),
                change_summary: "test push".to_string(),
                sheet_indices: vec![0],
                now: "2026-01-01T00:00:00Z".to_string(),
                published_by: "tester".to_string(),
                writeback_regions: None,
                object_scripts: None,
                module_scripts: None,
                notebooks: None,
                data_sources: Vec::new(),
                excluded_regions: Vec::new(),
                custom_objects: Vec::new(),
                include_comments: false,
                min_app_version: String::new(),
            };
            publish::publish(&reg, &request, prof).unwrap();
        };
        publish_it(&wb, SemVer::new(1, 0, 0));

        let mut v2 = wb.clone();
        v2.sheets[0].cells.insert(
            (0, 0),
            SavedCell::from_cell(&engine::cell::Cell::new_number(after)),
        );
        publish_it(&v2, SemVer::new(1, 1, 0));
        (reg, sheet_id)
    }

    /// One override at `position`, upstream once held `baseline`, the subscriber
    /// typed `current`.
    fn parity_override(
        sheet_id: SheetId,
        cell_id: CellId,
        position: (u32, u32),
        baseline: &str,
        current: &str,
    ) -> crate::overrides::CellOverride {
        crate::overrides::CellOverride {
            sheet_id,
            cell_id,
            position,
            baseline: OverrideValue::Value { display: baseline.to_string() },
            current: OverrideValue::Value { display: current.to_string() },
            created_at: "2026-01-01T00:00:00Z".to_string(),
            modified_at: "2026-01-01T00:00:00Z".to_string(),
            author: String::new(),
            conflict: false,
            upstream_new: None,
            extra: std::collections::HashMap::new(),
        }
    }

    fn parity_subscription(
        dir: &TempDir,
        package_sheet_id: SheetId,
        local_sheet_id: SheetId,
    ) -> Subscription {
        Subscription {
            package_name: "parity".to_string(),
            registry_url: format!("file://{}", dir.path().display()),
            version_pin: "^1.0.0".to_string(),
            resolved_version: "1.0.0".to_string(),
            resolved_at: "2026-01-01T00:00:00Z".to_string(),
            sheets: vec![SubscribedSheet {
                package_sheet_id,
                local_sheet_id,
                local_name: "Sheet1".to_string(),
                extra: std::collections::HashMap::new(),
            }],
            channel: String::new(),
            data_source_configs: Vec::new(),
            objects: Vec::new(),
            detached_sheets: Vec::new(),
            extra: std::collections::HashMap::new(),
        }
    }

    /// THE GUARD THIS WHOLE CHANGE RESTS ON. The refresh dialog now asks the
    /// user to decide, cell by cell, what happens to their edits. If the preview
    /// names a different set of cells than the apply acts on, the dialog is
    /// worse than useless: the user resolves conflicts that do not exist and is
    /// never shown the ones that do.
    ///
    /// The two sides used entirely different code — the preview inferred a count
    /// from "overrides on a changed sheet", the apply compared values — so this
    /// could not even be asked before. They now share
    /// `overrides::classify_rebase` and both feed it from `sheet_data_to_cells`.
    ///
    /// SABOTAGE: in `collect_conflicts`, drop the `classify_rebase` filter and
    /// push every override. The preview then reports 1 and the apply 0.
    #[test]
    fn the_preview_and_the_apply_agree_a_cell_is_not_a_conflict() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        // Upstream moved 100 -> 100: the cell did not actually change.
        let (reg, pkg_sheet) = two_versions(&dir, prof.path(), 100.0, 100.0);
        let local_sheet = SheetId::from_bytes(identity::generate_uuid_v7());
        let cell_id = CellId::from_bytes(identity::generate_uuid_v7());

        let mut layer = OverrideLayer::new();
        layer.set_override(parity_override(local_sheet, cell_id, (0, 0), "100", "999"));

        let sub = parity_subscription(&dir, pkg_sheet, local_sheet);
        let preview = compute_preview(&reg, &[sub], &layer, &HashMap::new(), &HashMap::new()).unwrap();
        let p = &preview.subscription_previews[0];
        assert_eq!(
            p.conflicts.len(),
            0,
            "upstream did not touch this cell — the OLD code reported it as a \
             conflict purely because the sheet's artifact changed"
        );
        assert_eq!(p.overrides_conflicted, 0);

        // And the apply, from the same artifact, reaches the same verdict.
        let mut upstream = HashMap::new();
        upstream.insert(
            (local_sheet, cell_id),
            OverrideValue::Value { display: "100".to_string() },
        );
        let (conflicts, _) = layer.rebase(&upstream);
        assert_eq!(conflicts, 0, "the apply must agree with the preview");
    }

    /// The positive control: a cell upstream really did change appears in BOTH,
    /// with the full three-way triple the resolver renders.
    ///
    /// SABOTAGE: make `collect_conflicts` read the OLD version's artifact
    /// instead of the new one — `upstream_new` then equals `baseline` and the
    /// list empties.
    #[test]
    fn the_preview_and_the_apply_agree_a_cell_is_a_conflict() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let (reg, pkg_sheet) = two_versions(&dir, prof.path(), 100.0, 150.0);
        let local_sheet = SheetId::from_bytes(identity::generate_uuid_v7());
        let cell_id = CellId::from_bytes(identity::generate_uuid_v7());

        let mut layer = OverrideLayer::new();
        layer.set_override(parity_override(local_sheet, cell_id, (0, 0), "100", "999"));

        let sub = parity_subscription(&dir, pkg_sheet, local_sheet);
        let preview = compute_preview(&reg, &[sub], &layer, &HashMap::new(), &HashMap::new()).unwrap();
        let p = &preview.subscription_previews[0];
        assert_eq!(p.conflicts.len(), 1, "upstream changed a cell the user had edited");

        let c = &p.conflicts[0];
        assert_eq!(
            c.local_sheet_id, local_sheet,
            "the LOCAL id — the key the resolver sends back"
        );
        assert_eq!(c.cell_id, cell_id);
        assert_eq!(c.a1, "A1");
        assert_eq!(c.baseline, OverrideValue::Value { display: "100".to_string() }, "base");
        assert_eq!(c.current, OverrideValue::Value { display: "999".to_string() }, "mine");
        assert_eq!(
            c.upstream_new,
            OverrideValue::Value { display: "150".to_string() },
            "theirs"
        );

        // The apply agrees, from the value the preview reported as "theirs".
        let mut upstream = HashMap::new();
        upstream.insert((local_sheet, cell_id), c.upstream_new.clone());
        let (conflicts, _) = layer.rebase(&upstream);
        assert_eq!(conflicts, 1);
    }

    /// A cell where the subscriber independently typed what upstream now says is
    /// NOT a conflict — `auto_clear_matching` drops the override entirely. The
    /// preview must not offer a decision about a cell that will silently vanish,
    /// and the apply must not COUNT it: `rebase` used to increment for every
    /// changed-upstream cell including the ones it deleted two lines later.
    ///
    /// SABOTAGE: reorder `classify_rebase` to test `upstream != baseline` before
    /// the auto-clear branch.
    #[test]
    fn a_cell_the_subscriber_already_agreed_with_is_not_a_conflict() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let (reg, pkg_sheet) = two_versions(&dir, prof.path(), 100.0, 150.0);
        let local_sheet = SheetId::from_bytes(identity::generate_uuid_v7());
        let cell_id = CellId::from_bytes(identity::generate_uuid_v7());

        let mut layer = OverrideLayer::new();
        // The subscriber typed 150 before the publisher did.
        layer.set_override(parity_override(local_sheet, cell_id, (0, 0), "100", "150"));

        let sub = parity_subscription(&dir, pkg_sheet, local_sheet);
        let preview = compute_preview(&reg, &[sub], &layer, &HashMap::new(), &HashMap::new()).unwrap();
        assert_eq!(preview.subscription_previews[0].conflicts.len(), 0);

        let mut upstream = HashMap::new();
        upstream.insert(
            (local_sheet, cell_id),
            OverrideValue::Value { display: "150".to_string() },
        );
        let (conflicts, cleared) = layer.rebase(&upstream);
        assert_eq!(conflicts, 0, "counted only when it SURVIVES auto-clear");
        assert_eq!(cleared, 1);
        assert_eq!(layer.count(), 0);
    }

    /// The preview follows the ID REGISTRY, not the recorded position, exactly
    /// as the apply does. An override is id-anchored so it survives structural
    /// shifts; reading the recorded position would look at whatever now occupies
    /// the old coordinates.
    ///
    /// SABOTAGE: ignore `override_positions` in `collect_conflicts` and always
    /// use `ovr.position`.
    #[test]
    fn the_preview_reads_the_cell_the_id_registry_points_at() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        // A1 = 100 -> 150. The override CLAIMS to live at B2, which is empty
        // upstream, but the registry says it is really at A1.
        let (reg, pkg_sheet) = two_versions(&dir, prof.path(), 100.0, 150.0);
        let local_sheet = SheetId::from_bytes(identity::generate_uuid_v7());
        let cell_id = CellId::from_bytes(identity::generate_uuid_v7());

        let mut layer = OverrideLayer::new();
        layer.set_override(parity_override(local_sheet, cell_id, (1, 1), "100", "999"));

        let sub = parity_subscription(&dir, pkg_sheet, local_sheet);

        // Without the registry: reads B2, which is empty, so it reports a
        // conflict against the wrong "theirs".
        let blind = compute_preview(&reg, &[sub.clone()], &layer, &HashMap::new(), &HashMap::new()).unwrap();
        assert_eq!(
            blind.subscription_previews[0].conflicts[0].upstream_new,
            OverrideValue::Empty,
            "the recorded position points at an empty cell"
        );

        // With it: reads A1 and reports the real upstream value.
        let mut positions = HashMap::new();
        positions.insert((local_sheet, cell_id), (0u32, 0u32));
        let seeing = compute_preview(&reg, &[sub], &layer, &positions, &HashMap::new()).unwrap();
        let c = &seeing.subscription_previews[0].conflicts[0];
        assert_eq!(c.position, (0, 0));
        assert_eq!(c.a1, "A1");
        assert_eq!(c.upstream_new, OverrideValue::Value { display: "150".to_string() });
    }

    /// A sheet whose artifact cannot be read makes the conflict list INCOMPLETE,
    /// and says so. The dialog blocks Apply on this, because resolving a partial
    /// list silently decides the rows nobody was shown.
    ///
    /// SABOTAGE: `continue` instead of pushing to `unexamined` — the list then
    /// looks complete and Apply unblocks.
    #[test]
    fn an_unreadable_sheet_makes_the_conflict_list_inexact() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let (reg, pkg_sheet) = two_versions(&dir, prof.path(), 100.0, 150.0);
        let local_sheet = SheetId::from_bytes(identity::generate_uuid_v7());
        let cell_id = CellId::from_bytes(identity::generate_uuid_v7());

        let mut layer = OverrideLayer::new();
        layer.set_override(parity_override(local_sheet, cell_id, (0, 0), "100", "999"));

        // Make the new version's data artifact unreadable. Artifacts are
        // content-addressed and deduped into `.blobs`, so there may be no
        // per-version copy to delete — resolve the hash through the manifest,
        // exactly as `read_artifact` does, and remove BOTH forms.
        let rel = format!("sheets/{}/data.json", pkg_sheet);
        let manifest = reg.get_version_manifest("parity", "1.1.0").unwrap();
        let hash = manifest
            .artifact_checksums
            .get(&rel)
            .expect("the sheet's data artifact is not in the manifest")
            .clone();
        let blob = dir.path().join(".blobs").join(&hash[0..2]).join(&hash);
        let per_version = dir.path().join("parity").join("1.1.0").join(&rel);
        let removed = std::fs::remove_file(&blob).is_ok()
            | std::fs::remove_file(&per_version).is_ok();
        assert!(
            removed,
            "neither the blob ({}) nor the per-version copy ({}) existed — the \
             workspace layout moved",
            blob.display(),
            per_version.display()
        );

        let sub = parity_subscription(&dir, pkg_sheet, local_sheet);
        let preview = compute_preview(&reg, &[sub], &layer, &HashMap::new(), &HashMap::new()).unwrap();
        let p = &preview.subscription_previews[0];
        assert_eq!(p.unexamined_sheets.len(), 1);
        assert_eq!(p.unexamined_sheets[0].reason, "unreadable");
        assert!(
            !preview.conflicts_exact,
            "an incomplete list must NOT be presented as a complete set of decisions"
        );
    }

}
