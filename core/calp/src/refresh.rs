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
    /// The sum of the per-subscription figures PLUS the layer-wide sweep for
    /// overrides whose current value equals their own baseline — those clear on
    /// any refresh, including on subscriptions that had no update at all, so
    /// they belong to no single subscription's row.
    pub total_overrides_auto_cleared: usize,
    /// False when any subscription's cell count was capped by a budget. The
    /// dialog must then say "at least N" rather than "N".
    pub total_cells_changed_exact: bool,
    /// True when EVERY override-bearing sheet was examined, so the conflict
    /// list is the whole truth. False gates Apply: the user cannot be asked to
    /// resolve a list that silently omits rows.
    pub conflicts_exact: bool,
    /// Subscriptions that follow the development line while their application
    /// now defines environments.
    ///
    /// NEVER re-targeted silently. The subscriber chose the line — or was on it
    /// before environments existed — and moving them to `prod` would change
    /// which content their workbook accepts without them asking. So it is a
    /// notice with a one-click switch, and it is computed for every line
    /// subscription whether or not it has an update: a subscription with no
    /// update produces no preview row to carry it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub environment_notices: Vec<EnvironmentNotice>,
    /// Subscriptions that could not be resolved at all — an environment that no
    /// longer exists, or one nothing has been promoted into.
    ///
    /// A ROW, not an error for the whole preview. `compute_preview` used to
    /// propagate any resolution failure with `?`, which for a removed
    /// environment would mean one admin's tidy-up blanked every OTHER
    /// subscription's preview in every subscriber's workbook. The apply refuses
    /// while this is non-empty, so nothing is silently skipped either.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unavailable: Vec<UnavailableSubscription>,
}

/// A line-following subscription whose application has since defined
/// environments.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentNotice {
    pub package_name: String,
    pub registry_url: String,
    /// The environments now on offer, in pipeline order. The last is the one
    /// the UI should suggest — it is production by convention.
    pub environments: Vec<String>,
}

/// A subscription this refresh cannot resolve, and why.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnavailableSubscription {
    pub package_name: String,
    pub registry_url: String,
    /// The environment it follows, when that is what went missing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
    /// The refusal, in the words the user should read.
    pub reason: String,
    /// What it could follow instead, in pipeline order. Empty when the
    /// application has no environments at all.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub available: Vec<String>,
}

/// Preview for a single subscription's refresh.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionPreview {
    pub package_name: String,
    /// The workspace this subscription reads, in the user's spelling.
    ///
    /// Part of the subscription's IDENTITY, not decoration: two teams may each
    /// publish `sales` to their own share, and the merged preview the frontend
    /// receives puts both rows in one list. Without this the apply's
    /// previewed-version gate could match a row to the wrong subscription.
    pub registry_url: String,
    /// The environment this subscription follows, or `None` for the line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
    pub current_version: String,
    pub new_version: String,
    /// True when `new_version` is LOWER than `current_version`: the environment
    /// was rolled back.
    ///
    /// The dialog must say "rolled back", not "update available". A subscriber
    /// who reads a downgrade as an update concludes the publisher changed those
    /// cells; what actually happened is that a known-good version was restored,
    /// and the conflict list they are about to resolve is against the OLDER
    /// content.
    #[serde(default)]
    pub is_rollback: bool,
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
    /// Overrides on THIS subscription's sheets that the apply would delete as
    /// redundant — the subscriber's value already equals what upstream now
    /// holds, or they have typed their way back to the baseline.
    ///
    /// Computed from the same `classify_rebase` the conflicts are, over the same
    /// artifact. It was a hardcoded `0` — the identical fabricated-number defect
    /// this file removed from `overrides_conflicted` — so a subscriber asking
    /// "how many of my recorded edits does this refresh discard?" was told none,
    /// and the apply then reported a real number.
    ///
    /// Exact whenever `unexamined_sheets` is empty, which is the same condition
    /// that gates Apply.
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

/// What one subscription's conflict scan found.
///
/// A struct rather than a tuple because the caller needs FOUR facts out of one
/// pass and three of them are counts — `(Vec, Vec, usize, HashSet)` at a call
/// site is a puzzle, and the one that was a bare `0` for as long as it was is
/// exactly the field that has to be hard to forget.
struct ConflictScan {
    conflicts: Vec<ConflictPreviewCell>,
    unexamined: Vec<UnexaminedSheet>,
    /// Overrides this scan proved the apply will DELETE — `classify_rebase`
    /// answering `AutoCleared`.
    auto_cleared: usize,
    /// Every override this scan reached a verdict on, so the layer-wide sweep
    /// below does not count one of them a second time.
    examined: std::collections::HashSet<(SheetId, CellId)>,
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
    let mut total_cleared = 0;
    let mut total_cells_exact = true;
    let mut conflicts_exact = true;
    // Every override some subscription's scan reached a verdict on, so the
    // layer-wide sweep after the loop cannot count one of them twice.
    let mut examined_anywhere: std::collections::HashSet<(SheetId, CellId)> =
        std::collections::HashSet::new();
    let mut environment_notices: Vec<EnvironmentNotice> = Vec::new();
    let mut unavailable: Vec<UnavailableSubscription> = Vec::new();

    for sub in subscriptions {
        let target = sub.target()?;

        // A LINE SUBSCRIPTION ON AN APPLICATION THAT HAS SINCE GROWN A PIPELINE.
        // Computed here, before the update check, because a subscription with
        // no update produces no preview row and would otherwise carry no notice
        // — and "you are following unreleased work" is exactly the thing a
        // subscriber with nothing to apply still needs told. Best-effort: a
        // workspace that will not answer must not block a refresh.
        if matches!(target, crate::manifest::SubscriptionTarget::Line(_)) {
            if let Ok(envs) = crate::environments::environments(registry, &sub.package_name) {
                if !envs.is_empty() {
                    environment_notices.push(EnvironmentNotice {
                        package_name: sub.package_name.clone(),
                        registry_url: sub.registry_url.clone(),
                        environments: envs.iter().map(|e| e.name.clone()).collect(),
                    });
                }
            }
        }

        let resolved =
            match crate::environments::resolve_target(registry, &sub.package_name, &target) {
                Ok(v) => v,
                // ONE ROW, NOT THE WHOLE PREVIEW. A removed or empty
                // environment is a fact about ONE subscription; propagating it
                // would blank every other subscription's preview in the
                // workbook and leave the user unable to refresh anything.
                Err(e @ (CalpError::EnvironmentNotFound { .. }
                    | CalpError::EnvironmentEmpty { .. }
                    | CalpError::PromotionLogInvalid { .. })) => {
                    unavailable.push(UnavailableSubscription {
                        package_name: sub.package_name.clone(),
                        registry_url: sub.registry_url.clone(),
                        environment: sub.environment.clone(),
                        reason: e.to_string(),
                        available: crate::environments::environments(registry, &sub.package_name)
                            .map(|envs| envs.into_iter().map(|x| x.name).collect())
                            .unwrap_or_default(),
                    });
                    continue;
                }
                Err(other) => return Err(other),
            };
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
        let scan = collect_conflicts(
            registry,
            &sub.package_name,
            &new_version_str,
            sub,
            &sheets_updated,
            override_layer,
            override_positions,
            local_sheet_names,
        );
        examined_anywhere.extend(scan.examined.iter().copied());

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
            registry_url: sub.registry_url.clone(),
            environment: sub.environment.clone(),
            current_version: sub.resolved_version.clone(),
            // Compared as SEMVER, not as strings: "1.9.0" > "1.10.0"
            // lexicographically, and a rollback across a two-digit minor is
            // exactly when a subscriber most needs to be told which way they
            // are going.
            is_rollback: match (crate::version::SemVer::parse(&sub.resolved_version), crate::version::SemVer::parse(&new_version_str)) {
                (Ok(current), Ok(next)) => next < current,
                _ => false,
            },
            new_version: new_version_str,
            cells_changed,
            cells_changed_exact: cells_exact,
            sheets_with_data_changes,
            overrides_conflicted: scan.conflicts.len(),
            overrides_auto_cleared: scan.auto_cleared,
            sheets_added: sheets_added.clone(),
            sheets_removed: sheets_removed.clone(),
            sheets_updated: sheets_updated.clone(),
            conflicts: scan.conflicts,
            unexamined_sheets: scan.unexamined,
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
        total_cleared += preview.overrides_auto_cleared;

        sub_previews.push(preview);
    }

    // THE SWEEP THE PER-SUBSCRIPTION SCANS CANNOT SEE.
    //
    // `rebase` ends in `auto_clear_matching`, which runs over the WHOLE layer —
    // not just the overrides an updating subscription supplied a new upstream
    // value for. Its second rule, `current == baseline`, therefore deletes a
    // subscriber's "I typed it back to what it was" record no matter which
    // application it belongs to, including one with no update available at all
    // (`continue`d above, so no scan ever looks at it).
    //
    // Attributed to the refresh rather than to a subscription, because that is
    // whose act it is.
    for ovr in &override_layer.overrides {
        if examined_anywhere.contains(&(ovr.sheet_id, ovr.cell_id)) {
            continue;
        }
        if ovr.current == ovr.baseline {
            total_cleared += 1;
        }
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
        environment_notices,
        unavailable,
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
) -> ConflictScan {
    /// Per-sheet cap on a data artifact, matching `count_upstream_cell_changes`.
    const MAX_BYTES: usize = 4 * 1024 * 1024;

    let mut conflicts = Vec::new();
    let mut unexamined = Vec::new();
    let mut auto_cleared = 0usize;
    let mut examined: std::collections::HashSet<(SheetId, CellId)> =
        std::collections::HashSet::new();

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
            examined.insert((local_sid, ovr.cell_id));
            match crate::overrides::classify_rebase(ovr, &upstream_new) {
                // THE APPLY DELETES THIS OVERRIDE. `rebase` ends in
                // `auto_clear_matching`, which drops every record whose current
                // value now equals upstream — or equals its own baseline. That
                // is the subscriber's recorded edit being discarded, and the
                // preview reported a hardcoded `0` for it while the apply came
                // back with a real number two seconds later.
                crate::overrides::RebaseOutcome::AutoCleared => {
                    auto_cleared += 1;
                    continue;
                }
                crate::overrides::RebaseOutcome::Unchanged => continue,
                crate::overrides::RebaseOutcome::Conflict => {}
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

    ConflictScan { conflicts, unexamined, auto_cleared, examined }
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

/// The versions a refresh PREVIEW put in front of the user, so the apply can
/// refuse to be a different refresh.
///
/// # Why an apply needs this at all
///
/// The preview and the apply each resolve the version pin independently, and
/// the refresh dialog is deliberately non-modal so the user can inspect sheets
/// while deciding. A subscriber who opens it against v1.1, reads
/// `base=100 / mine=999 / theirs=150` for A1, and spends two minutes thinking
/// while the publisher pushes v1.2 where A1 is `7`, then clicks "take theirs" —
/// and lands `7`. Their 999 is discarded for a value the dialog never displayed,
/// under a confirm strip that says the decision is not undoable.
///
/// Refusing is the only honest answer. Silently pulling the version the user was
/// shown would be worse: a refresh means "bring me the current one", and quietly
/// installing a stale version under that label is the same lie pointed the other
/// way. So the apply stops, says the workspace moved, and the user re-previews
/// against what is actually there.
///
/// Keyed by package name only, which is sufficient BECAUSE the caller batches by
/// workspace before it gets here — one `pull_all_updates` call sees one
/// workspace, and a workspace cannot hold two applications of one name.
#[derive(Debug, Clone, Default)]
pub struct PreviewedVersions {
    /// package name -> the version the preview said this refresh would install.
    /// A subscription with no entry was shown as having no update.
    pub by_package: HashMap<String, String>,
}

impl PreviewedVersions {
    fn check(&self, package: &str, current: &str, would_install: &str) -> Result<(), CalpError> {
        let shown = self.by_package.get(package).map(String::as_str);
        let now = if would_install == current { None } else { Some(would_install) };
        if shown == now {
            return Ok(());
        }
        Err(CalpError::RefreshMoved(format!(
            "CALP_REFRESH_MOVED: the workspace changed while you were deciding. \
             '{package}' {}, so the decisions you made no longer describe this \
             refresh. Close and re-open Refresh to see what it holds now.",
            match (shown, now) {
                (Some(a), Some(b)) => format!("now offers {b}, not the {a} you were shown"),
                (Some(a), None) => format!("no longer offers {a}"),
                (None, Some(b)) => format!("now offers {b}, which the preview did not show"),
                (None, None) => unreachable!("equal cases returned above"),
            }
        )))
    }
}

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
    // What the user was SHOWN, by package name, or `None` for a caller that
    // showed them nothing. See `PreviewedVersions`.
    previewed: Option<&PreviewedVersions>,
) -> Result<Vec<RefreshPayload>, CalpError> {
    let mut payloads = Vec::new();

    for (i, sub) in subscriptions.iter().enumerate() {
        let target = sub.target()?;
        let resolved =
            crate::environments::resolve_target(registry, &sub.package_name, &target)?;
        let new_version_str = resolved.to_string();

        if let Some(shown) = previewed {
            shown.check(&sub.package_name, &sub.resolved_version, &new_version_str)?;
        }

        if new_version_str == sub.resolved_version {
            continue; // No update
        }

        let request = PullRequest {
            package_name: sub.package_name.clone(),
            // The subscription's OWN target, so the pull follows what the
            // subscriber chose. `apply_refresh` keeps the existing
            // `version_pin` / `environment` and takes only the sheets and the
            // resolved version from the payload, but handing `pull()` a
            // different target than the subscription holds would still be a
            // second answer to "what does this workbook follow".
            target: target.clone(),
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
        let mut removed_locally: Vec<SheetId> = Vec::new();
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
                // THE SHEET STAYS IN THE WORKBOOK, so say so in the ledger.
                //
                // `calp_refresh_apply` replaces and appends grids; it never
                // removes one. So a sheet the new version drops keeps its tab —
                // which is the kind behaviour — but dropping it from
                // `sub.sheets` alone left it as an ORPHAN: not tracked, and not
                // tombstoned either. The next version that brings the sheet
                // BACK then sees it as newly added and materializes a second
                // copy beside it as `Sheet2 (2)`, with the orphan's overrides
                // pointing at a sheet the ledger no longer knows.
                //
                // Rare while publishers seldom delete sheets. A ROLLBACK makes
                // it ordinary: every sheet added since the version being rolled
                // back to is "removed", and rolling forward again re-adds it.
                removed_locally.push(old_sub_sheet.package_sheet_id);
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
        // Tombstone the sheets this refresh dropped but the workbook keeps.
        // Same list  uses, and for the same reason: without it the next
        // version to bring the sheet back materializes a SECOND copy beside the
        // one still on screen.
        for id in removed_locally {
            if !sub.detached_sheets.contains(&id) {
                sub.detached_sheets.push(id);
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

    // -----------------------------------------------------------------------
    // Environments: a subscription follows a POINTER, not the head
    // -----------------------------------------------------------------------

    /// One subscription to `test-pkg`, following `env` (or the line at `pin`).
    fn env_subscription(dir: &TempDir, env: Option<&str>, pin: &str, at: &str) -> Subscription {
        Subscription {
            package_name: "test-pkg".to_string(),
            registry_url: format!("file://{}", dir.path().display()),
            version_pin: pin.to_string(),
            resolved_version: at.to_string(),
            resolved_at: "2026-01-01T00:00:00Z".to_string(),
            sheets: Vec::new(),
            environment: env.map(|s| s.to_string()),
            data_source_configs: Vec::new(),
            objects: Vec::new(),
            detached_sheets: Vec::new(),
            extra: std::collections::HashMap::new(),
        }
    }

    fn keypair_of(prof: &TempDir) -> crate::signing::PublisherKeypair {
        crate::signing::PublisherKeypair::load_or_create(prof.path()).unwrap()
    }

    fn set_envs(reg: &LocalWorkspace, kp: &crate::signing::PublisherKeypair, list: &[&str]) {
        let names: Vec<String> = list.iter().map(|s| s.to_string()).collect();
        let seq = reg.get_application_manifest("test-pkg").unwrap().promotion_sequence;
        crate::environments::set_pipeline(reg, "test-pkg", &names, seq, kp, "2026-09-05T00:00:00Z")
            .unwrap();
    }

    /// THE WHOLE POINT OF THE FEATURE. A push moves the line's head; a
    /// subscriber of `prod` is offered NOTHING until somebody promotes.
    ///
    /// SABOTAGE: resolve an `Environment` target as `VersionPin::Latest`. Every
    /// end user is then offered every push the moment it lands, which is the
    /// state this work exists to end.
    #[test]
    fn an_environment_subscription_moves_only_when_the_pointer_moves() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        // The workspace holds 1.0.0 and 1.1.0; prod points at 1.0.0.
        let reg = setup_registry_with_versions(&dir, prof.path());
        let kp = keypair_of(&prof);
        set_envs(&reg, &kp, &["prod"]);
        crate::environments::promote(
            &reg, "test-pkg", "prod", Some(SemVer::new(1, 0, 0)), None, &kp,
            "2026-09-05T00:00:00Z",
        )
        .unwrap();

        let sub = env_subscription(&dir, Some("prod"), "", "1.0.0");
        let layer = OverrideLayer::new();
        let preview =
            compute_preview(&reg, &[sub.clone()], &layer, &HashMap::new(), &HashMap::new()).unwrap();
        assert!(
            preview.subscription_previews.is_empty(),
            "1.1.0 is published but prod still points at 1.0.0 — nothing to offer"
        );

        // A line subscription on the same workspace IS offered it, which is what
        // makes the previous assertion mean something.
        let line = env_subscription(&dir, None, "^1.0.0", "1.0.0");
        let line_preview =
            compute_preview(&reg, &[line], &layer, &HashMap::new(), &HashMap::new()).unwrap();
        assert_eq!(line_preview.subscription_previews[0].new_version, "1.1.0");

        // Promote, and now prod's subscriber is offered it.
        crate::environments::promote(
            &reg, "test-pkg", "prod", Some(SemVer::new(1, 1, 0)), None, &kp,
            "2026-09-05T00:00:00Z",
        )
        .unwrap();
        let after =
            compute_preview(&reg, &[sub], &layer, &HashMap::new(), &HashMap::new()).unwrap();
        assert_eq!(after.subscription_previews[0].new_version, "1.1.0");
        assert_eq!(after.subscription_previews[0].environment.as_deref(), Some("prod"));
        assert!(!after.subscription_previews[0].is_rollback);
    }

    /// A ROLLBACK IS A REFRESH IN THE OTHER DIRECTION, and it says so.
    ///
    /// SABOTAGE: guard the update check with `if resolved > current`. The
    /// subscriber is then never offered the rollback at all and stays on the
    /// version the publisher pulled — silently, with no surface saying why.
    /// Second sabotage: compute `is_rollback` by string comparison, and
    /// 1.9.0 → 1.10.0 reports as a rollback.
    #[test]
    fn a_rollback_refreshes_backwards_and_says_so() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = setup_registry_with_versions(&dir, prof.path());
        let kp = keypair_of(&prof);
        set_envs(&reg, &kp, &["prod"]);
        crate::environments::promote(
            &reg, "test-pkg", "prod", Some(SemVer::new(1, 0, 0)), None, &kp, "2026-09-05T00:00:00Z",
        )
        .unwrap();
        crate::environments::promote(
            &reg, "test-pkg", "prod", Some(SemVer::new(1, 1, 0)), None, &kp, "2026-09-05T00:00:00Z",
        )
        .unwrap();
        // ...and back.
        crate::environments::promote(
            &reg, "test-pkg", "prod", Some(SemVer::new(1, 0, 0)), None, &kp, "2026-09-05T00:00:00Z",
        )
        .unwrap();

        // The subscriber is on 1.1.0 and prod is back at 1.0.0.
        let sub = env_subscription(&dir, Some("prod"), "", "1.1.0");
        let layer = OverrideLayer::new();
        let preview =
            compute_preview(&reg, &[sub.clone()], &layer, &HashMap::new(), &HashMap::new()).unwrap();
        let row = &preview.subscription_previews[0];
        assert_eq!(row.current_version, "1.1.0");
        assert_eq!(row.new_version, "1.0.0");
        assert!(row.is_rollback, "going backwards must be flagged as such");

        // And the apply half produces a payload for it.
        let payloads = pull_all_updates(
            &reg, &[sub], &scope_of(&dir), prof.path(), PinPolicy::PinOnFirstUse, None,
        )
        .unwrap();
        assert_eq!(payloads.len(), 1);
        assert_eq!(payloads[0].pull_result.resolved_version.to_string(), "1.0.0");
    }

    /// A REMOVED ENVIRONMENT DEGRADES ONE ROW, not the whole preview.
    ///
    /// SABOTAGE: propagate the resolution error with `?`. One admin tidying up
    /// a pipeline then blanks every OTHER subscription's preview in every
    /// subscriber's workbook, and nobody can refresh anything.
    #[test]
    fn a_removed_environment_is_one_unavailable_row() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = setup_registry_with_versions(&dir, prof.path());
        let kp = keypair_of(&prof);
        set_envs(&reg, &kp, &["staging", "prod"]);
        crate::environments::promote(
            &reg, "test-pkg", "staging", Some(SemVer::new(1, 0, 0)), None, &kp,
            "2026-09-05T00:00:00Z",
        )
        .unwrap();
        // The admin drops staging.
        set_envs(&reg, &kp, &["prod"]);

        let orphan = env_subscription(&dir, Some("staging"), "", "1.0.0");
        let healthy = env_subscription(&dir, None, "^1.0.0", "1.0.0");
        let layer = OverrideLayer::new();
        let preview = compute_preview(
            &reg, &[orphan, healthy], &layer, &HashMap::new(), &HashMap::new(),
        )
        .unwrap();

        assert_eq!(preview.unavailable.len(), 1);
        let row = &preview.unavailable[0];
        assert_eq!(row.environment.as_deref(), Some("staging"));
        assert!(row.reason.contains("staging"), "the refusal names it: {}", row.reason);
        assert_eq!(row.available, vec!["prod"], "and what it could follow instead");

        // The other subscription previewed normally.
        assert_eq!(preview.subscription_previews.len(), 1);
        assert_eq!(preview.subscription_previews[0].new_version, "1.1.0");
    }

    /// An environment nothing has been promoted into refuses by name too — it
    /// is a different sentence from "no such environment" because the remedy is
    /// different (wait for a promotion, not pick another name).
    #[test]
    fn an_empty_environment_is_unavailable_with_its_own_reason() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = setup_registry_with_versions(&dir, prof.path());
        let kp = keypair_of(&prof);
        set_envs(&reg, &kp, &["prod"]);

        let sub = env_subscription(&dir, Some("prod"), "", "1.0.0");
        let layer = OverrideLayer::new();
        let preview =
            compute_preview(&reg, &[sub], &layer, &HashMap::new(), &HashMap::new()).unwrap();
        assert_eq!(preview.unavailable.len(), 1);
        assert!(
            preview.unavailable[0].reason.contains("nothing has been promoted"),
            "{}",
            preview.unavailable[0].reason
        );
    }

    /// A LINE SUBSCRIPTION IS NEVER RE-TARGETED SILENTLY when its application
    /// grows a pipeline. It is told, and the choice stays the subscriber's.
    ///
    /// SABOTAGE: auto-switch to the last environment. Every existing
    /// subscriber's workbook then changes which content it accepts without
    /// anyone asking — and on a rollback, that means their document moves
    /// BACKWARDS on a refresh they thought was routine.
    #[test]
    fn a_line_subscription_is_told_about_environments_not_moved_to_one() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = setup_registry_with_versions(&dir, prof.path());
        let kp = keypair_of(&prof);
        set_envs(&reg, &kp, &["test", "prod"]);
        crate::environments::promote(
            &reg, "test-pkg", "test", Some(SemVer::new(1, 0, 0)), None, &kp, "2026-09-05T00:00:00Z",
        )
        .unwrap();

        let sub = env_subscription(&dir, None, "^1.0.0", "1.0.0");
        let layer = OverrideLayer::new();
        let preview =
            compute_preview(&reg, &[sub], &layer, &HashMap::new(), &HashMap::new()).unwrap();

        // Still following the line: offered the head, not test's pointer.
        assert_eq!(preview.subscription_previews[0].new_version, "1.1.0");
        assert_eq!(preview.subscription_previews[0].environment, None);

        // And told, in pipeline order so the UI can suggest the last one.
        assert_eq!(preview.environment_notices.len(), 1);
        assert_eq!(preview.environment_notices[0].package_name, "test-pkg");
        assert_eq!(preview.environment_notices[0].environments, vec!["test", "prod"]);
    }

    /// The notice appears even when there is NOTHING to apply — a subscription
    /// with no update produces no preview row to carry it, and "you are
    /// following unreleased work" is exactly what a subscriber with nothing to
    /// apply still needs told.
    ///
    /// SABOTAGE: compute the notice inside the update branch.
    #[test]
    fn the_environment_notice_survives_having_no_update() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = setup_registry_with_versions(&dir, prof.path());
        let kp = keypair_of(&prof);
        set_envs(&reg, &kp, &["prod"]);

        // Already at the head: no update, so no preview row.
        let sub = env_subscription(&dir, None, "^1.0.0", "1.1.0");
        let layer = OverrideLayer::new();
        let preview =
            compute_preview(&reg, &[sub], &layer, &HashMap::new(), &HashMap::new()).unwrap();
        assert!(preview.subscription_previews.is_empty());
        assert_eq!(preview.environment_notices.len(), 1);
    }

    /// A DEV subscription never reaches environment resolution: it points at a
    /// local `.cala` file, and there is no workspace to resolve a name against.
    ///
    /// SABOTAGE: rename `channel` to `environment` mechanically, leaving
    /// `make_dev_subscription`'s literal `"dev"` in place. Every dev
    /// subscription then looks for an environment called "dev" in an
    /// application called `dev:C:/...`.
    #[test]
    fn a_dev_subscription_carries_no_environment() {
        let sub = Subscription {
            package_name: "dev:C:/w/book.cala".to_string(),
            registry_url: "file://C:/w/book.cala".to_string(),
            version_pin: "dev".to_string(),
            resolved_version: "dev".to_string(),
            resolved_at: "2026-01-01T00:00:00Z".to_string(),
            sheets: Vec::new(),
            environment: None,
            data_source_configs: Vec::new(),
            objects: Vec::new(),
            detached_sheets: Vec::new(),
            extra: std::collections::HashMap::new(),
        };
        assert!(crate::dev_mode::is_dev_subscription(&sub));
        assert_eq!(sub.environment, None);
        // And the constructor agrees, so this cannot drift.
        let pulled = crate::dev_mode::DevPullResult {
            sheets: Vec::new(),
            tables: Vec::new(),
            named_ranges: Vec::new(),
            controls: Vec::new(),
            media: std::collections::HashMap::new(),
        };
        let made = crate::dev_mode::make_dev_subscription("C:/w/book.cala", &pulled, "now");
        assert_eq!(made.environment, None);
    }

    /// NOTHING ELSE PARSES A PIN OFF A SUBSCRIPTION. One interpretation of
    /// (`version_pin`, `environment`), so a forgotten branch is impossible
    /// rather than merely unlikely — the shape the dead `channel:` prefix had,
    /// where twelve sites each remembered a special case nothing produced.
    ///
    /// SABOTAGE: re-add `VersionPin::parse(&sub.version_pin)` to
    /// `compute_preview` or `pull_all_updates`.
    #[test]
    fn refresh_never_parses_a_subscription_pin_directly() {
        const SELF: &str = include_str!("refresh.rs");
        // Assembled so this test does not match itself.
        let needle = format!("VersionPin::parse(&sub.{})", "version_pin");
        let product = SELF.split("mod tests {").next().unwrap();
        assert!(
            !product.contains(&needle),
            "a resolver is reading the pin directly; go through Subscription::target()"
        );
        assert_eq!(
            product.matches("environments::resolve_target(").count(),
            2,
            "exactly the two resolution sites, both through the one resolver"
        );
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
            environment: None,
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
            environment: None,
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
            environment: None,
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
            environment: None,
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
            environment: None,
            data_source_configs: Vec::new(),
            objects: Vec::new(),
            detached_sheets: Vec::new(),
            extra: std::collections::HashMap::new(),
        };

        let payloads = pull_all_updates(&reg, &[sub], &scope_of(&dir), prof.path(), PinPolicy::PinOnFirstUse, None).unwrap();
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
            environment: None,
            data_source_configs: Vec::new(),
            objects: Vec::new(),
            detached_sheets: Vec::new(),
            extra: std::collections::HashMap::new(),
        };

        // unwrap_err() requires Debug on the Ok type; RefreshPayload has no
        // Debug derive (wraps PullResult), so match instead.
        let err = match pull_all_updates(&reg, &[sub], &scope_of(&dir), prof.path(), PinPolicy::PinOnFirstUse, None) {
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
            environment: None,
            data_source_configs: Vec::new(),
            objects: Vec::new(),
            detached_sheets: Vec::new(),
            extra: std::collections::HashMap::new(),
        };

        let payloads = pull_all_updates(&reg, &[sub], &scope_of(&dir), prof.path(), PinPolicy::PinOnFirstUse, None).unwrap();
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
            environment: None,
            data_source_configs: Vec::new(),
            objects: Vec::new(),
            detached_sheets: Vec::new(),
            extra: std::collections::HashMap::new(),
        }];

        let payloads = pull_all_updates(&reg, &subs, &scope_of(&dir), prof.path(), PinPolicy::PinOnFirstUse, None).unwrap();
        let mut layer = OverrideLayer::new();

        let result = apply_refresh(
            payloads, &mut subs, &mut layer, &HashMap::new(), "2026-01-02T00:00:00Z",
        );

        assert_eq!(result.subscriptions_refreshed, 1);
        assert_eq!(subs[0].resolved_version, "1.1.0");
    }

    /// A refresh that would install a version the user was not shown is
    /// REFUSED, not silently applied.
    ///
    /// The dialog computes its preview once and is non-modal, and the two halves
    /// resolve the version pin independently. A subscriber reading
    /// `base=100 / mine=999 / theirs=150` for a cell, while the publisher pushes
    /// a version where that cell says something else, used to click "take
    /// theirs" and land a value the dialog never displayed — their own edit
    /// discarded, under a strip saying the decision is not undoable.
    ///
    /// Pulling the STALE previewed version instead would be the same lie
    /// pointed the other way: "refresh" means "bring me the current one".
    ///
    /// SABOTAGE: drop the `shown.check(...)` call in `pull_all_updates`.
    #[test]
    fn a_refresh_refuses_to_install_a_version_the_preview_did_not_show() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = setup_registry_with_versions(&dir, prof.path());

        let pull_result = pull::pull(&reg, &PullRequest {
            package_name: "test-pkg".to_string(),
            target: crate::manifest::SubscriptionTarget::Line(VersionPin::parse("^1.0").unwrap()),
            now: "2026-01-01T00:00:00Z".to_string(),
        }, &scope_of(&dir), prof.path(), PinPolicy::PinOnFirstUse).unwrap();
        let mut subs = vec![pull_result.subscription.clone()];
        subs[0].resolved_version = "1.0.0".to_string();

        // The workspace resolves to 1.1.0. The preview showed 1.0.5 — a version
        // that was head when the dialog opened and is not head now.
        let stale = PreviewedVersions {
            by_package: [("test-pkg".to_string(), "1.0.5".to_string())]
                .into_iter()
                .collect(),
        };
        let err = pull_all_updates(
            &reg, &subs, &scope_of(&dir), prof.path(), PinPolicy::PinOnFirstUse, Some(&stale),
        )
        .err()
        .expect("a moved workspace must refuse, not apply stale decisions");
        let text = err.to_string();
        assert!(text.contains("CALP_REFRESH_MOVED"), "refusal was: {text}");
        assert!(text.contains("1.1.0") && text.contains("1.0.5"), "names both versions: {text}");

        // The preview that DID show 1.1.0 goes through.
        let agreeing = PreviewedVersions {
            by_package: [("test-pkg".to_string(), "1.1.0".to_string())]
                .into_iter()
                .collect(),
        };
        let payloads = pull_all_updates(
            &reg, &subs, &scope_of(&dir), prof.path(), PinPolicy::PinOnFirstUse, Some(&agreeing),
        )
        .expect("the version the user was shown is the version that applies");
        assert_eq!(payloads.len(), 1);
    }

    /// The inverse drift, and it is the same defect: a subscription the preview
    /// showed as having NO update, which now has one.
    ///
    /// An empty previewed list is therefore not the same as no list at all — it
    /// says "there was nothing to bring", and a refresh that now has something
    /// is one the user has not seen.
    ///
    /// SABOTAGE: make `check` return `Ok(())` whenever `shown` is `None`.
    #[test]
    fn an_update_that_appeared_after_the_preview_is_refused_too() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = setup_registry_with_versions(&dir, prof.path());

        let pull_result = pull::pull(&reg, &PullRequest {
            package_name: "test-pkg".to_string(),
            target: crate::manifest::SubscriptionTarget::Line(VersionPin::parse("^1.0").unwrap()),
            now: "2026-01-01T00:00:00Z".to_string(),
        }, &scope_of(&dir), prof.path(), PinPolicy::PinOnFirstUse).unwrap();
        let mut subs = vec![pull_result.subscription.clone()];
        subs[0].resolved_version = "1.0.0".to_string();

        // "The preview found nothing to bring." It did — 1.1.0 is there now.
        let nothing = PreviewedVersions::default();
        let err = pull_all_updates(
            &reg, &subs, &scope_of(&dir), prof.path(), PinPolicy::PinOnFirstUse, Some(&nothing),
        )
        .err()
        .expect("an update the preview never mentioned must refuse");
        assert!(err.to_string().contains("which the preview did not show"), "{err}");

        // And `None` — the script gateway, which shows the user nothing and has
        // no stale decision to protect — is unaffected.
        assert!(pull_all_updates(
            &reg, &subs, &scope_of(&dir), prof.path(), PinPolicy::PinOnFirstUse, None,
        )
        .is_ok());
    }

    #[test]
    fn apply_refresh_detects_conflicts_and_preserves_local_sheet_ids() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let reg = setup_registry_with_versions(&dir, prof.path());

        // Subscribe at 1.0.0
        let pull_result = pull::pull(&reg, &PullRequest {
            package_name: "test-pkg".to_string(),
            target: crate::manifest::SubscriptionTarget::Line(VersionPin::parse("^1.0").unwrap()),
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

        let payloads = pull_all_updates(&reg, &subs, &scope_of(&dir), prof.path(), PinPolicy::PinOnFirstUse, None).unwrap();
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
            environment: None,
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
            environment: None,
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
        // AND THE PREVIEW SAYS SO. This was a hardcoded 0 while the apply four
        // lines down returned 1 — the subscriber was told the refresh would
        // discard none of their recorded edits, and it discarded one.
        assert_eq!(preview.subscription_previews[0].overrides_auto_cleared, 1);
        assert_eq!(preview.total_overrides_auto_cleared, 1);

        let mut upstream = HashMap::new();
        upstream.insert(
            (local_sheet, cell_id),
            OverrideValue::Value { display: "150".to_string() },
        );
        let (conflicts, cleared) = layer.rebase(&upstream);
        assert_eq!(conflicts, 0, "counted only when it SURVIVES auto-clear");
        assert_eq!(cleared, 1);
        assert_eq!(layer.count(), 0);
        assert_eq!(
            preview.total_overrides_auto_cleared, cleared,
            "the preview and the apply must reach the same number, not two numbers"
        );
    }

    /// An override the subscriber has typed back to its own baseline clears on
    /// ANY refresh — `auto_clear_matching` sweeps the whole layer, including
    /// sheets no updating subscription supplied an upstream value for. The
    /// preview has to count those too or it under-reports what it discards.
    ///
    /// SABOTAGE: delete the post-loop `if ovr.current == ovr.baseline` sweep in
    /// `compute_preview`; the preview then reports 1 where the apply clears 2.
    #[test]
    fn an_override_typed_back_to_its_baseline_is_counted_even_on_an_untouched_sheet() {
        let dir = TempDir::new().unwrap();
        let prof = TempDir::new().unwrap();
        let (reg, pkg_sheet) = two_versions(&dir, prof.path(), 100.0, 150.0);
        let local_sheet = SheetId::from_bytes(identity::generate_uuid_v7());
        let cell_id = CellId::from_bytes(identity::generate_uuid_v7());
        // A SECOND sheet, on no subscription at all — nothing examines it, and
        // `rebase` never gets an upstream value for it.
        let other_sheet = SheetId::from_bytes(identity::generate_uuid_v7());
        let other_cell = CellId::from_bytes(identity::generate_uuid_v7());

        let mut layer = OverrideLayer::new();
        layer.set_override(parity_override(local_sheet, cell_id, (0, 0), "100", "150"));
        // current == baseline: the subscriber undid their own edit.
        layer.set_override(parity_override(other_sheet, other_cell, (5, 5), "7", "7"));

        let sub = parity_subscription(&dir, pkg_sheet, local_sheet);
        let preview =
            compute_preview(&reg, &[sub], &layer, &HashMap::new(), &HashMap::new()).unwrap();
        assert_eq!(
            preview.subscription_previews[0].overrides_auto_cleared, 1,
            "the subscription's own row counts only its own sheets"
        );
        assert_eq!(
            preview.total_overrides_auto_cleared, 2,
            "the redundant record on the untouched sheet clears too"
        );

        let mut upstream = HashMap::new();
        upstream.insert(
            (local_sheet, cell_id),
            OverrideValue::Value { display: "150".to_string() },
        );
        let (_, cleared) = layer.rebase(&upstream);
        assert_eq!(cleared, 2);
        assert_eq!(preview.total_overrides_auto_cleared, cleared);
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
