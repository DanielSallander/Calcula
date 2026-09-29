//! FILENAME: app/src-tauri/src/sheets.rs
// PURPOSE: Sheet management commands for multi-sheet workbook support.
// CONTEXT: Provides Tauri commands for creating, switching, renaming, deleting,
//          moving, copying, hiding/unhiding sheets, tab colors, and freeze panes.

use std::collections::{HashMap, HashSet};
use tauri::State;
use crate::AppState;
use crate::persistence::FileState;
use identity;
use crate::pivot::types::PivotState;
use pivot_engine::PivotId;
use serde::{Deserialize, Serialize};

/// Freeze panes configuration for a sheet
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FreezeConfig {
    pub freeze_row: Option<u32>,
    pub freeze_col: Option<u32>,
}

/// Split window configuration for a sheet.
/// Unlike freeze panes, split windows allow independent scrolling in each quadrant.
/// The split position is stored as a row/column index.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SplitConfig {
    pub split_row: Option<u32>,
    pub split_col: Option<u32>,
}

/// Information about a single sheet (sent to frontend)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetInfo {
    pub index: usize,
    pub name: String,
    pub freeze_row: Option<u32>,
    pub freeze_col: Option<u32>,
    /// Tab color as CSS hex string (e.g., "#ff0000"). Empty = no color.
    #[serde(default)]
    pub tab_color: String,
    /// Sheet visibility: "visible", "hidden", or "veryHidden"
    #[serde(default = "default_visibility")]
    pub visibility: String,
    /// The workbook's stable sheet uuid, as a canonical 36-char string.
    ///
    /// THE ONLY SAFE KEY for anything that must follow a sheet: indices shift on
    /// insert/delete/move and names shift on rename. It rides in the SAME payload
    /// that gives a consumer its sheet list, which is the point — resolving it
    /// through a separate `get_sheet_ids` round trip lets the two answers tear
    /// against each other while a `.calp` pull is appending sheets, and a mark
    /// landing on the wrong tab is worse than no mark at all.
    #[serde(default)]
    pub sheet_id: String,
    /// The sheet's KIND as a plain string: `"worksheet"` or `"canvas"`
    /// (`SheetKind::wire_name`). It rides in the same payload as `sheet_id` for
    /// the same reason: the tab strip, the Core surface switch and the Canvas
    /// ribbon tab all need it together with the list, and a separate round
    /// trip could tear against a `.calp` pull appending sheets.
    #[serde(default = "default_sheet_kind")]
    pub kind: String,
    /// The canvas's page / snap-grid / stacking layout; absent for a worksheet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canvas_layout: Option<::persistence::CanvasLayout>,
}

fn default_visibility() -> String {
    "visible".to_string()
}

fn default_sheet_kind() -> String {
    "worksheet".to_string()
}

/// Result of get_sheets command
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetsResult {
    pub sheets: Vec<SheetInfo>,
    pub active_index: usize,
}

// ============================================================================
// Helper: build SheetInfo list from state vectors
// ============================================================================

pub(crate) fn build_sheet_list(
    sheet_names: &[String],
    freeze_configs: &[FreezeConfig],
    tab_colors: &[String],
    sheet_visibility: &[String],
    sheet_ids: &[identity::SheetId],
    sheet_kinds: &[::persistence::SheetKind],
) -> Vec<SheetInfo> {
    sheet_names
        .iter()
        .enumerate()
        // OBJECT-BACKED SHEETS ARE NOT IN THE LIST. Every `getSheets()` surface
        // (tab bar, unhide dialog, sheet pickers, script/MCP enumerations)
        // consumes this one builder, so filtering here is what keeps a floating
        // range's backing sheet out of ALL of them at once. `index` stays the
        // TRUE position in the state vectors — consumers must match by
        // `s.index`, never by list position.
        .filter(|(index, _)| is_user_sheet(sheet_visibility, *index))
        .map(|(index, name)| {
            let freeze = freeze_configs.get(index).cloned().unwrap_or_default();
            let vis = sheet_visibility.get(index).cloned().unwrap_or_else(|| "visible".to_string());
            SheetInfo {
                index,
                name: name.clone(),
                freeze_row: freeze.freeze_row,
                freeze_col: freeze.freeze_col,
                tab_color: tab_colors.get(index).cloned().unwrap_or_default(),
                visibility: vis,
                // `.get(index)`, NEVER a zip over the filtered iterator: the
                // filter above drops object-backed sheets but `index` stays the
                // TRUE position, and `sheet_ids` is parallel to the UNFILTERED
                // state vectors. Zipping after filtering would shift every id by
                // the number of floating-range backing sheets ahead of it.
                sheet_id: sheet_ids
                    .get(index)
                    .map(|id| id.to_string())
                    .unwrap_or_default(),
                // `.get(index)` for the same reason as `sheet_id`: the vector
                // is parallel to the UNFILTERED state. A short vector reads as
                // a worksheet, the padding default.
                kind: sheet_kinds
                    .get(index)
                    .map(|k| k.wire_name())
                    .unwrap_or("worksheet")
                    .to_string(),
                canvas_layout: sheet_kinds
                    .get(index)
                    .and_then(|k| k.canvas_layout())
                    .cloned(),
            }
        })
        .collect()
}

/// Helper to ensure per-sheet Vec has enough entries, pushing defaults.
fn ensure_vec_len<T: Default>(v: &mut Vec<T>, min_len: usize) {
    while v.len() < min_len {
        v.push(T::default());
    }
}

/// Pad the tab-colour vector to one entry per sheet (empty = no colour).
///
/// `pub(crate)` for the `"sheet_tab_state"` undo restore, which re-pads after
/// swapping the whole vector back in. One padding rule, not two — the LENGTH of
/// these vectors is state (`build_sheet_list` reads them by index), so a restore
/// that padded differently from the command would make a sheet's colour depend
/// on which direction you arrived from.
pub(crate) fn ensure_tab_color_len(v: &mut Vec<String>, min_len: usize) {
    ensure_vec_len(v, min_len);
}

/// Is sheet `index` visible? A SHORT `sheet_visibility` counts as visible,
/// exactly as `build_sheet_list` reads it — and a slot that exists but holds
/// something other than `"visible"` does not, which is what makes the padding
/// rule below load-bearing.
pub(crate) fn sheet_is_visible(sheet_visibility: &[String], index: usize) -> bool {
    sheet_visibility
        .get(index)
        .map(|v| v == "visible")
        .unwrap_or(true)
}

/// The visibility value marking a sheet as OBJECT-BACKED: a real engine sheet
/// that exists only as the cell store of a workbook object (a Floating Range),
/// never as a tab the user can visit.
///
/// It rides in `sheet_visibility` rather than a new parallel vector because
/// every existing "is it visible" predicate (`sheet_is_visible`,
/// `nearest_visible_sheet`, `visible_sheets_after_removing`, the tab bar's
/// client-side filter, `next_sheet`/`previous_sheet`) already treats any
/// non-`"visible"` string as unlandable — so an object sheet can never become
/// the delete-landing target or the next/previous stop without a single new
/// check. What DOES need a new predicate is the user-sheet boundary below.
pub(crate) const OBJECT_SHEET_VISIBILITY: &str = "object";

/// Is sheet `index` a USER sheet — one the user may activate, hide, move,
/// rename, copy or delete through the sheet commands? Object-backed sheets
/// (`OBJECT_SHEET_VISIBILITY`) are mutated only through their owning object's
/// commands (`floating_range.rs`), so every sheet-lifecycle command and every
/// user-facing enumeration filters through THIS predicate — one filter, not
/// one per surface.
pub(crate) fn is_user_sheet(sheet_visibility: &[String], index: usize) -> bool {
    sheet_visibility
        .get(index)
        .map(|v| v != OBJECT_SHEET_VISIBILITY)
        .unwrap_or(true)
}

/// The standard refusal for a sheet command aimed at an object-backed sheet.
/// The message names the object system on purpose: the caller reached a real
/// sheet index, and "out of range" would be a lie the log cannot act on.
pub(crate) fn ensure_user_sheet(
    sheet_visibility: &[String],
    index: usize,
    action: &str,
) -> Result<(), String> {
    if is_user_sheet(sheet_visibility, index) {
        Ok(())
    } else {
        Err(format!(
            "Cannot {} sheet {}: it is the backing store of a floating range object. \
             Use the floating range commands instead.",
            action, index
        ))
    }
}

// ============================================================================
// Sheet provenance — which sheets came from a subscribed application
// ============================================================================

/// Where one sheet came from, when it did not come from the user.
#[derive(Debug, Clone)]
pub(crate) struct SheetOrigin {
    pub package_name: String,
    pub registry_url: String,
    pub resolved_version: String,
    /// The environment the subscription follows, or None for the line.
    pub environment: Option<String>,
    /// The LIVE workbook name, NOT `SubscribedSheet::local_name` — a subscriber
    /// may rename a subscribed sheet, and a refusal must name the tab the user
    /// is actually looking at.
    pub sheet_name: String,
    pub local_sheet_id: identity::SheetId,
    /// The PUBLISHER's id for this sheet. A different uuid from the local one on
    /// a subscriber (pull mints fresh ids), and the key every published artifact
    /// and every diff row is named by — so anything that has to line a local
    /// sheet up against published content needs this and not `local_sheet_id`.
    pub package_sheet_id: identity::SheetId,
    /// The UPSTREAM version this workbook is on no longer publishes this sheet.
    ///
    /// It keeps its provenance — still the publisher's content, and a later
    /// version can bring it back — but nothing refreshes it meanwhile, so any
    /// surface that says "refreshed from the workspace" has to say otherwise.
    pub upstream_removed: bool,
}

/// Which local sheet INDICES came from a subscribed `.calp` application.
///
/// Snapshotted ONCE per command from the two stores that answer it (`sheet_ids`
/// and `subscriptions`), because the alternative is an O(sheets x subscriptions)
/// re-walk at four call sites — publish, the delete guard, per-sheet detach and
/// the tab badge — each free to decide for itself what "subscribed" means. That
/// is exactly how the publish path came to know nothing about subscriptions at
/// all, and shipped other publishers' sheets under the author's key.
///
/// LOCK ORDER: takes `sheet_ids` then `subscriptions`, both READ, both released
/// before it returns. Call it holding neither.
#[derive(Debug, Default, Clone)]
pub(crate) struct SheetProvenance {
    by_index: HashMap<usize, SheetOrigin>,
}

impl SheetProvenance {
    pub(crate) fn snapshot(state: &AppState) -> Result<Self, String> {
        let sheet_ids = state.sheet_ids.read().map_err(|e| e.to_string())?.clone();
        let sheet_names = state.sheet_names.read().map_err(|e| e.to_string())?.clone();
        let subs = state.subscriptions.read().map_err(|e| e.to_string())?;

        let mut by_index = HashMap::new();
        for (index, sid) in sheet_ids.iter().enumerate() {
            // A SHEET THE UPSTREAM VERSION DROPPED KEEPS ITS PROVENANCE. It is
            // still the publisher's content and a later version can bring it
            // back; treating it as unowned lost the badge, the delete guard and
            // the publish exclusion at once.
            if let Some((sub, removed)) = subs.upstream_removed_sheet(*sid) {
                by_index.insert(
                    index,
                    SheetOrigin {
                        package_name: sub.package_name.clone(),
                        registry_url: sub.registry_url.clone(),
                        resolved_version: sub.resolved_version.clone(),
                        environment: sub.environment.clone(),
                        sheet_name: sheet_names
                            .get(index)
                            .cloned()
                            .unwrap_or_else(|| removed.local_name.clone()),
                        local_sheet_id: removed.local_sheet_id,
                        package_sheet_id: removed.package_sheet_id,
                        upstream_removed: true,
                    },
                );
                continue;
            }
            if let Some((sub, sheet)) = subs.subscribed_sheet(*sid) {
                by_index.insert(
                    index,
                    SheetOrigin {
                        package_name: sub.package_name.clone(),
                        registry_url: sub.registry_url.clone(),
                        resolved_version: sub.resolved_version.clone(),
                        environment: sub.environment.clone(),
                        sheet_name: sheet_names
                            .get(index)
                            .cloned()
                            .unwrap_or_else(|| sheet.local_name.clone()),
                        local_sheet_id: sheet.local_sheet_id,
                        package_sheet_id: sheet.package_sheet_id,
                        // A LIVE subscribed sheet. The tombstone branch above
                        // claims this index first, so reaching here means the
                        // publisher still ships it.
                        upstream_removed: false,
                    },
                );
            }
        }
        Ok(Self { by_index })
    }

    pub(crate) fn origin(&self, index: usize) -> Option<&SheetOrigin> {
        self.by_index.get(&index)
    }

    pub(crate) fn is_subscribed(&self, index: usize) -> bool {
        self.by_index.contains_key(&index)
    }

}

/// The standard refusal for a sheet command aimed at a SUBSCRIBED sheet — the
/// sibling of [`ensure_user_sheet`].
///
/// Names the application AND the remedy, because unlike an object sheet this is a
/// real tab the user right-clicked: the message is the whole interaction.
pub(crate) fn ensure_unsubscribed_sheet(
    provenance: &SheetProvenance,
    index: usize,
    action: &str,
) -> Result<(), String> {
    match provenance.origin(index) {
        None => Ok(()),
        Some(origin) => Err(format!(
            "Cannot {} sheet '{}': it came from the application '{}' and is still \
             connected to it. Detach it first (right-click the tab > Detach from \
             '{}'), then {} it.",
            action, origin.sheet_name, origin.package_name, origin.package_name, action
        )),
    }
}

/// How many sheets would still be VISIBLE if `removing` were deleted.
///
/// "At least one sheet" and "at least one VISIBLE sheet" are different tests,
/// and `delete_sheet` only ever made the first (BUG-0046's family). Hide
/// Sheet1, delete Sheet2, and the workbook is left with one HIDDEN sheet: no
/// tab to click, and an active index naming a sheet the user cannot look at.
/// `hide_sheet` has always refused the mirror image ("Cannot hide the last
/// visible sheet").
pub(crate) fn visible_sheets_after_removing(
    sheet_visibility: &[String],
    sheet_count: usize,
    removing: usize,
) -> usize {
    (0..sheet_count)
        .filter(|&i| i != removing)
        .filter(|&i| sheet_is_visible(sheet_visibility, i))
        .count()
}

/// `preferred` if it is visible, otherwise the first visible sheet there is.
///
/// The index arithmetic a delete performs is pure bookkeeping, so it can land
/// on a hidden sheet; this is the step that makes the landing legal. Falls back
/// to `preferred` when nothing is visible, which the caller's refusal has
/// already ruled out.
pub(crate) fn nearest_visible_sheet(
    sheet_visibility: &[String],
    sheet_count: usize,
    preferred: usize,
) -> usize {
    if sheet_is_visible(sheet_visibility, preferred) {
        return preferred;
    }
    (0..sheet_count)
        .find(|&i| sheet_is_visible(sheet_visibility, i))
        .unwrap_or(preferred)
}

/// Pad `sheet_visibility` — and it may NOT go through `ensure_vec_len`.
///
/// `String::default()` is `""`, and every reader of this vector compares
/// against the literal `"visible"`: `SheetTabs` renders
/// `sheets.filter(s => s.visibility === "visible")`, `hide_sheet` counts the
/// visible sheets that way, and `next_sheet` / `previous_sheet` skip anything
/// that is not that string. So a padded entry is a sheet with NO TAB that the
/// workbook nonetheless believes is neither hidden nor visible — and
/// `build_sheet_list`'s `.unwrap_or("visible")` cannot repair it, because a
/// padded slot is `Some("")` rather than `None`.
///
/// Found by `the_sheet_it_lands_on_is_visible`: a three-sheet workbook whose
/// visibility vector had not been grown refused "hide Sheet1" with "Cannot hide
/// the last visible sheet", because the padding had made the other two invisible
/// to the count.
/// Pad the visibility vector to one entry per sheet ("visible" is the default —
/// see `build_sheet_list`, which reads a MISSING entry as visible too).
///
/// `pub(crate)` for the `"sheet_tab_state"` undo restore; see
/// `ensure_tab_color_len` for why the restore reuses these rather than padding
/// its own way.
pub(crate) fn ensure_visibility_len(v: &mut Vec<String>, min_len: usize) {
    ensure_vec_len_with(v, min_len, || "visible".to_string());
}

fn ensure_vec_len_with<T, F: Fn() -> T>(v: &mut Vec<T>, min_len: usize, make: F) {
    while v.len() < min_len {
        v.push(make());
    }
}

/// Rotate an element in a Vec from `from` to `to`, shifting everything between
/// by one. Shared by `move_sheet` and `add_sheet`'s partition-keeping branch.
fn rotate_element<T>(v: &mut Vec<T>, from: usize, to: usize) {
    if from < to {
        // Move right: rotate left the subslice [from..=to]
        v[from..=to].rotate_left(1);
    } else {
        // Move left: rotate right the subslice [to..=from]
        v[to..=from].rotate_right(1);
    }
}

// ============================================================================
// Undo history vs. workbook structure (BUG-0005)
// ============================================================================

/// EXCEL PARITY: a change to the workbook's STRUCTURE ends the undo history.
///
/// # Why the history cannot simply survive
///
/// An undo entry names its sheet by INDEX (`CellChange::SetCell { sheet, .. }`,
/// and the `sheet_index` inside every `CustomRestore` payload). An index is a
/// POSITION, not an identity: deleting, moving or copying a sheet renumbers
/// every index after the affected one, so a queued entry silently comes to
/// describe a DIFFERENT sheet than the one it was recorded on. Undo then
/// restores a value onto a sheet the user never edited, and does it with no
/// error and nothing on screen to see. That is the same missing-dimension root
/// that made cross-sheet recalculation wrong (BUG-0019) and that
/// `CellChange::SetCell`'s `sheet` field was added for — one level up, at the
/// sheet-list level rather than the cell level.
///
/// Two of the four hazards are not about indices at all, which is why "remap
/// the indices" was never a complete answer:
///
///   * a RENAME shifts no index, but rewrites every formula in the workbook.
///     The `previous` cells sitting in the undo stack still hold ASTs spelling
///     the OLD sheet name, so undoing across a rename restores a reference to a
///     sheet that no longer answers to it;
///   * the width/height/merge/snapshot changes carry no sheet dimension AT ALL
///     — they are implicitly "the active sheet" — so no amount of remapping can
///     aim them.
///
/// # What Excel does, which settles it
///
/// Excel does not let a sheet structural operation be undone, and ending the
/// history is how it avoids exactly this problem. Deleting a worksheet is the
/// famous case — Excel warns "You can't undo deleting sheets" and the Undo
/// command goes unavailable — and no undo entry exists for inserting,
/// renaming, moving or copying one either. Under the project's standing "Excel
/// parity wins any design question" rule that is Calcula's behaviour too. It
/// also answers, without inventing anything, the question of what an undo
/// should do when its target sheet has since been DELETED: the question cannot
/// arise, because the delete ended the history that could have asked it.
///
/// The MCP tool layer has been TELLING callers this all along — `add_sheet`
/// returns "Sheet structure changes are NOT undoable", `delete_sheet` and
/// `rename_sheet` and `move_sheet` each end with "NOT undoable" — while the
/// stack was in fact left intact behind them. This makes the claim true.
///
/// # Contract
///
/// Call from EVERY command that adds, deletes, renames, moves or copies a
/// sheet, AFTER the last gate that can still refuse (a refused operation must
/// not cost the user their history) and with NO other state lock held, so
/// clearing the history adds no edge to the lock order at all. (This comment
/// used to call `undo_stack` BEFORE `grid`/`grids` the crate's canonical
/// order; the lock-order census showed the opposite -- every cell writer takes
/// the stack while it holds the grid locks, and `undo_commands::apply_changes`
/// now does too, fix round 4.) `sheet_structure_commands_invalidate_the_undo_history` in
/// `undo_sheet_structure_tests` reads this file and fails the build if one of
/// the five stops calling it.
pub(crate) fn invalidate_undo_history_for_sheet_structure(state: &AppState, action: &str) {
    let Ok(mut undo) = state.undo_stack.lock() else {
        crate::log_error!(
            "SHEET",
            "{}: the undo history lock is poisoned; history NOT cleared",
            action
        );
        return;
    };
    let before = undo.cleared_total();
    undo.clear();
    let discarded = undo.cleared_total() - before;
    // Released before logging for the same reason the guard releases before it
    // announces: a listener's first act is to read the stack back.
    drop(undo);
    if discarded > 0 {
        crate::log_info!(
            "SHEET",
            "{} ended the undo history (Excel parity): {} transaction(s) discarded",
            action,
            discarded
        );
    }
}

// ============================================================================
// Per-sheet HashMap store remapping (sheet move / delete / copy)
// ============================================================================
//
// Most per-sheet state lives in index-aligned Vecs that the structural sheet
// commands rotate/remove/insert in place above. A second family of stores is
// keyed by sheet INDEX in HashMaps — comments, scenarios, outlines,
// conditional formats, data validations, cell-type assignments, on-grid
// controls, advanced-filter hidden rows, and the spill-tracking pair — and
// was historically NOT remapped, so after a move/delete/copy those entries
// silently pointed at whatever sheet inherited the old index.
// `remap_sheet_keyed_stores` applies the same index mapping the Vec stores
// received; `None` drops the entry (deleted sheet).

/// Re-key a `sheet_index -> V` store through `remap` (None = drop the entry).
fn remap_indexed_map<V>(
    map: &mut HashMap<usize, V>,
    remap: impl Fn(usize) -> Option<usize>,
) {
    let old = std::mem::take(map);
    for (index, value) in old {
        if let Some(new_index) = remap(index) {
            map.insert(new_index, value);
        }
    }
}

/// Rewrite the sheet index inside a `control-<sheet>-<row>-<col>` instance id.
///
/// Returns `None` when the string is not a derived control id (leave it alone),
/// `Some(None)` when its sheet was deleted (the binding is now orphaned), and
/// `Some(Some(new_id))` with the renumbered sheet otherwise.
pub(crate) fn remap_control_instance_id(
    id: &str,
    remap: &impl Fn(usize) -> Option<usize>,
) -> Option<Option<String>> {
    let rest = id.strip_prefix("control-")?;
    let mut parts = rest.split('-');
    let sheet: usize = parts.next()?.parse().ok()?;
    let row: u32 = parts.next()?.parse().ok()?;
    let col: u32 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(remap(sheet).map(|new_sheet| format!("control-{}-{}-{}", new_sheet, row, col)))
}

/// Re-key a `(sheet_index, row, col) -> V` store through `remap` (None =
/// drop the entry).
fn remap_cell_keyed_map<V>(
    map: &mut HashMap<(usize, u32, u32), V>,
    remap: impl Fn(usize) -> Option<usize>,
) {
    let old = std::mem::take(map);
    for ((index, row, col), value) in old {
        if let Some(new_index) = remap(index) {
            map.insert((new_index, row, col), value);
        }
    }
}

/// Re-aim the SOURCE of every list validation in `ranges` through `remap`
/// (found with wave C's W10). A list rule names its source range by sheet
/// INDEX (`ListSource::Range.sheet_index`; `None` = the validated range's own
/// sheet), and no sheet operation had ever remapped it: after a delete or a
/// move the dropdown listed -- and validated against -- whichever sheet
/// inherited the index, with no error anywhere. A source whose sheet is gone
/// (`remap` answers `None`) becomes an EMPTY list: every entry is refused, as
/// Excel refuses one against a `#REF!` source -- never another sheet's cells.
/// Returns whether anything changed. Also resolves a PULLED list source's
/// application position to its local sheet (`calp_commands.rs`, W11).
pub(crate) fn remap_list_sources(
    ranges: &mut [crate::data_validation::ValidationRange],
    remap: &dyn Fn(usize) -> Option<usize>,
) -> bool {
    use crate::data_validation::{DataValidationRule, ListSource};
    let mut changed = false;
    for range in ranges.iter_mut() {
        let DataValidationRule::List(list) = &mut range.validation.rule else { continue };
        let ListSource::Range { sheet_index: Some(old), .. } = &mut list.source else { continue };
        match remap(*old) {
            Some(new) if new == *old => {}
            Some(new) => {
                *old = new;
                changed = true;
            }
            None => {
                list.source = ListSource::Values(Vec::new());
                changed = true;
            }
        }
    }
    changed
}

/// [`remap_list_sources`] over every sheet's validations.
fn remap_list_validation_sources(
    store: &mut HashMap<usize, Vec<crate::data_validation::ValidationRange>>,
    remap: &impl Fn(usize) -> Option<usize>,
) {
    for ranges in store.values_mut() {
        remap_list_sources(ranges, remap);
    }
}

/// Apply `remap` to every sheet-index-keyed HashMap store, re-stamping the
/// `sheet_index` field carried INSIDE Comment and Scenario payloads (the same
/// re-stamp load_file performs when it materializes them). Takes each store's
/// lock briefly, one at a time; callers must not hold any of these locks.
fn remap_sheet_keyed_stores(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    remap: impl Fn(usize) -> Option<usize>,
) {
    // QUEUED UNDO ENTRIES ARE NOT REMAPPED HERE ANY MORE — THEY NO LONGER EXIST.
    //
    // This block used to rewrite the sheet index inside every queued
    // `CustomRestore` payload, because renumbering the sheets under a queued
    // undo entry made it replay into whatever sheet had taken its index. That
    // repaired half of the problem: the `CellChange::SetCell { sheet, .. }`
    // indices sitting beside those payloads in the very same transactions were
    // never touched, so an ordinary cell edit undone after a sheet delete still
    // landed on the wrong sheet (BUG-0005's family).
    //
    // Excel's answer to the whole family is that a change to the workbook's
    // STRUCTURE ends the undo history: deleting a sheet is famously not
    // undoable, and neither adding, renaming, moving nor copying one is either.
    // Under "Excel parity wins" that is now Calcula's answer too, applied at the
    // five structural commands through
    // `invalidate_undo_history_for_sheet_structure`. There is nothing left in
    // the stack for this function to re-aim.
    {
        let mut comments = state.comments.write(effect).unwrap();
        remap_indexed_map(&mut comments, &remap);
        for (index, sheet_comments) in comments.iter_mut() {
            for comment in sheet_comments.values_mut() {
                comment.sheet_index = *index;
            }
        }
    }
    {
        let mut scenarios = state.scenarios.write(effect).unwrap();
        remap_indexed_map(&mut scenarios, &remap);
        for (index, sheet_scenarios) in scenarios.iter_mut() {
            for scenario in sheet_scenarios.iter_mut() {
                scenario.sheet_index = *index;
            }
        }
    }
    remap_indexed_map(&mut state.outlines.write(effect).unwrap(), &remap);
    remap_indexed_map(&mut state.conditional_formats.write(effect).unwrap(), &remap);
    {
        let mut validations = state.data_validations.write(effect).unwrap();
        remap_indexed_map(&mut validations, &remap);
        remap_list_validation_sources(&mut validations, &remap);
    }
    remap_cell_keyed_map(&mut state.cell_types.write(effect).unwrap(), &remap);
    // On-grid controls (buttons/checkboxes) share the cell-type key shape.
    remap_cell_keyed_map(&mut state.controls.write(effect).unwrap(), &remap);
    // Object-script bindings name controls by the DERIVED id
    // `control-<sheet>-<row>-<col>`. The control store above just changed those
    // coordinates, so the live bindings must be re-keyed in lockstep — exactly
    // as shift_controls does for row/column edits.
    if let Ok(mut scripts) = state.object_scripts.write(effect) {
        for script in scripts.iter_mut() {
            let Some(current) = script.instance_id.as_deref() else { continue };
            if let Some(new_id) = remap_control_instance_id(current, &remap) {
                script.instance_id = new_id;
            }
        }
    }
    // Advanced-filter hidden rows: per-sheet session state that is never
    // recomputed on sheet ops (and shows up in the state digest).
    remap_indexed_map(&mut state.advanced_filter_hidden_rows.write(effect).unwrap(), &remap);
    // Spill tracking is a TWIN pair maintained in lockstep in commands/data.rs
    // (spill_hosts: spill cell -> origin; spill_ranges: origin -> its spill
    // cells; both origins and spill cells are in-sheet coords). It is updated
    // incrementally per ACTIVE sheet — never rebuilt on sheet ops — so both
    // sides remap together (remapping one alone would desync the pair and
    // mis-target spill protection).
    remap_cell_keyed_map(&mut state.spill_hosts.lock().unwrap(), &remap);
    remap_cell_keyed_map(&mut state.spill_ranges.write(effect).unwrap(), &remap);
    // Protection stores are sheet-index-keyed like CF/DV. Without remapping,
    // deleting/reordering sheets leaves protection attached to the WRONG index
    // — and now that protection persists, a stale index serializes under a
    // freshly-minted bogus SheetId and reattaches to sheet 0 on reopen.
    remap_indexed_map(&mut state.sheet_protection.write(effect).unwrap(), &remap);
    // AutoFilters are sheet-index-keyed too and were the one store missing
    // here: deleting or moving a sheet left every filter attached to the wrong
    // index, so its criteria hid rows on an unrelated sheet and the owning
    // table's id no longer matched anything on its own sheet.
    remap_indexed_map(&mut state.auto_filters.write(effect).unwrap(), &remap);
    // COMPUTED PROPERTIES are sheet-index-keyed too, and their two derived
    // indexes carry the sheet inside a cell key. Unremapped, a move or delete
    // left one sheet's row/column/cell properties re-evaluated -- and WRITTEN,
    // as fills, styles and dimensions -- onto whichever sheet inherited the
    // index: a canvas included, whose hidden grid then held styled cells.
    remap_indexed_map(&mut state.computed_properties.write(effect).unwrap(), &remap);
    remap_cell_keyed_map(&mut state.computed_prop_dependents.lock().unwrap(), &remap);
    {
        let mut deps = state.computed_prop_dependencies.lock().unwrap();
        for cells in deps.values_mut() {
            *cells = cells
                .drain()
                .filter_map(|(s, r, c)| remap(s).map(|n| (n, r, c)))
                .collect();
        }
    }
    // CROSS-SHEET DEPENDENCY EDGES. Neither map was ever remapped, and both
    // carry a sheet INDEX: `cross_sheet_dependencies` in its KEY, and
    // `cross_sheet_dependents` in the values of its sets. Moving or deleting a
    // sheet renumbers those indices under them, so the cascade either walked to
    // the WRONG sheet or (once an index ran past `grids.len()`) dropped the
    // dependent entirely -- a formula on another sheet silently stopped
    // recalculating, and the stale number was what got saved.
    //
    // `rebuild_all_dependencies` cannot stand in for this: it deliberately
    // rebuilds only the ACTIVE sheet's cross-sheet edges (clearing the rest
    // would orphan every other sheet's), so it repairs at most one of the
    // sheets a renumbering just invalidated.
    remap_cross_sheet_dependency_indices(state, &remap);
    // DEFINED NAMES. A sheet-scoped name carries the sheet it is scoped to as
    // an INDEX, and no sheet operation had ever remapped it: moving or deleting
    // a sheet silently re-scoped every sheet-local name onto whichever sheet
    // inherited the index, so `=SUM(Sales)` on one sheet started resolving to a
    // different sheet's name -- or, for a deleted sheet, to a name that could
    // never match again.
    {
        let mut names = state.named_ranges.write(effect).unwrap();
        names.retain(|_, nr| match nr.sheet_index {
            None => true, // workbook-scoped: no index to move
            Some(old) => match remap(old) {
                Some(new) => {
                    nr.sheet_index = Some(new);
                    true
                }
                // The sheet the name was scoped to is gone, and so is the name.
                None => false,
            },
        });
    }
}

/// Re-key the TABLE store after sheet indices are renumbered, re-stamping the
/// `sheet_index` each `Table` carries.
///
/// `tables` is NOT in `remap_sheet_keyed_stores`, and the reason is historical
/// rather than principled: `delete_sheet` re-keys it inline, in the same pass
/// that drops the deleted sheet's table NAMES out of `table_names` (a generic
/// remap cannot do that half). `move_sheet` and `copy_sheet` were therefore the
/// two structural commands with NO table remap at all — so moving a sheet left
/// every table on it registered under the index that now holds a DIFFERENT
/// sheet.
///
/// MEASURED (BUG-0047), soak seed 1786446166374 minimized to nine actions: add
/// a sheet, create a table on it, hide it, move the other sheet past it. The
/// sheet's AutoFilter moved with it (`auto_filters` IS in
/// `remap_sheet_keyed_stores`) and its table did not, so on reload
/// `relink_autofilter_owner` looked for the table under the filter's index,
/// found none, and the link was gone. The lost link is only the visible half:
/// the table itself is now attached to another sheet, which is what every
/// structured reference (`=SUM(Table1[Amount])`) resolves through.
pub(crate) fn remap_tables_store(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    remap: impl Fn(usize) -> Option<usize>,
) {
    let mut tables = state.tables.write(effect).unwrap();
    let old = std::mem::take(&mut *tables);
    for (index, mut sheet_tables) in old {
        if let Some(new_index) = remap(index) {
            for table in sheet_tables.values_mut() {
                table.sheet_index = new_index;
            }
            tables.insert(new_index, sheet_tables);
        }
    }
}

/// Re-key the NOTE and HYPERLINK stores through `remap`, re-stamping the
/// `sheet_index` each payload carries.
///
/// Both are `sheet_index -> (row, col) -> T` maps that `remap_sheet_keyed_stores`
/// has never reached. Kept separate (and used only by
/// `restore_partition_invariant`) because the structural sheet commands have
/// their own history with these two stores; widening the shared remap would
/// change what a move or delete does to them in the same breath.
fn remap_note_and_hyperlink_stores(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    remap: &impl Fn(usize) -> Option<usize>,
) {
    {
        let mut notes = state.notes.write(effect).unwrap();
        remap_indexed_map(&mut notes, remap);
        for (index, sheet_notes) in notes.iter_mut() {
            for note in sheet_notes.values_mut() {
                note.sheet_index = *index;
            }
        }
    }
    {
        let mut hyperlinks = state.hyperlinks.write(effect).unwrap();
        remap_indexed_map(&mut hyperlinks, remap);
        for (index, sheet_links) in hyperlinks.iter_mut() {
            for link in sheet_links.values_mut() {
                link.sheet_index = *index;
            }
        }
    }
}

/// The rotations that make user sheets a contiguous PREFIX again, planned from
/// the visibility vector alone.
///
/// Each `(from, to)` is one `rotate_element(v, from, to)` with `from > to`: the
/// next user sheet found past the first object slot moves down to that slot and
/// the object sheets in between shift up by one. Applied in order, the result is
/// a STABLE partition -- user sheets keep their relative order, and so do the
/// object sheets. Empty when the sheets are already partitioned.
pub(crate) fn partition_rotations(sheet_visibility: &[String], count: usize) -> Vec<(usize, usize)> {
    let mut is_user: Vec<bool> = (0..count).map(|i| is_user_sheet(sheet_visibility, i)).collect();
    let mut rotations: Vec<(usize, usize)> = Vec::new();
    // `next_user_slot` is where the next user sheet belongs: every slot below it
    // already holds a user sheet.
    let mut next_user_slot = 0usize;
    for j in 0..count {
        if !is_user[j] {
            continue;
        }
        if j != next_user_slot {
            rotations.push((j, next_user_slot));
            rotate_element(&mut is_user, j, next_user_slot);
        }
        next_user_slot += 1;
    }
    rotations
}

/// RESTORE THE PARTITION INVARIANT: user sheets a contiguous prefix, object-backed
/// sheets (`OBJECT_SHEET_VISIBILITY`) at the tail.
///
/// `add_sheet_inner`'s rotation branch keeps the invariant for ONE appended
/// sheet. A `.calp` pull appends a whole block at once -- and the block lands
/// AFTER any object tail the workbook already has (a floating range of the
/// subscriber's own, or the application's own from an earlier version on every
/// refresh that adds a sheet), so the pulled user sheets would sit between object
/// sheets. This is the same rotation, generalized: every sheet-aligned vector
/// is rotated exactly as `add_sheet_inner` rotates it, and then the
/// sheet-index-keyed stores are re-keyed through the resulting old -> new map
/// (`remap_sheet_keyed_stores`, `remap_tables_store`, and the note/hyperlink
/// stores that remap misses), together with `active_sheet`.
///
/// Returns `Some(old_to_new)` -- `old_to_new[old_index] == new_index` for every
/// sheet -- when anything moved, and `None` when the sheets were already
/// partitioned (nothing is locked for writing in that case beyond the planning
/// read, and nothing changes).
///
/// THE OBJECTS THAT NAME THEIR SHEET BY AN INDEX FIELD FOLLOW TOO: charts,
/// slicers, timelines, sparklines, ribbon filters' connected sheets (through
/// `object_deps::cascade_sheet_removed`, the walk `move_sheet` and
/// `delete_sheet` use), reports (`remap_report_sheets`) and every protected
/// region. The remap is TOTAL -- a rotation deletes nothing -- so for an object
/// on a sheet that did not move this is a no-op, and for one that did it is the
/// re-anchor.
///
/// It used to rest on a precondition instead ("call it before anything anchored
/// by index exists on a moved sheet"), and the precondition does not hold for
/// every caller: a REFRESH writes the publisher's visibility onto sheets it
/// already had before this runs, so a v2 that turns one of them into an object
/// sheet (or back) moves EXISTING user sheets -- and their charts, slicers and
/// timelines, created by earlier versions, were left on whichever sheet
/// inherited the old index. Refusing there instead would fail a refresh half
/// way through its writes, so the helper re-anchors rather than refuses.
///
/// Callers must hold NO AppState lock. Lock order is `add_sheet_inner`'s:
/// `grids`, then `sheet_names`, then everything else -- the object stores
/// last, under the held sheet locks, exactly as `move_sheet` takes them.
pub(crate) fn restore_partition_invariant(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    slicer_state: &crate::slicer::SlicerState,
    timeline_state: &crate::timeline_slicer::TimelineSlicerState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
) -> Result<Option<Vec<usize>>, String> {
    // A read-only plan first, so an already-partitioned workbook takes no write
    // lock at all. Re-planned under the write locks below, which is the answer
    // that is acted on.
    {
        let sheet_names = state.sheet_names.read().map_err(|e| e.to_string())?;
        let sheet_visibility = state.sheet_visibility.read().map_err(|e| e.to_string())?;
        if partition_rotations(&sheet_visibility, sheet_names.len()).is_empty() {
            return Ok(None);
        }
    }

    let old_to_new = {
        // CANONICAL LOCK ORDER: `grids`, then `sheet_names`, then everything else
        // (`add_sheet_inner`'s order, minus the `grid` mirror this never touches).
        let mut grids = state.grids.write(effect).map_err(|e| e.to_string())?;
        let mut sheet_names = state.sheet_names.write(effect).map_err(|e| e.to_string())?;
        let mut active_sheet = state.active_sheet.write(effect).map_err(|e| e.to_string())?;
        let mut freeze_configs = state.freeze_configs.write(effect).map_err(|e| e.to_string())?;
        let mut tab_colors = state.tab_colors.write(effect).map_err(|e| e.to_string())?;
        let mut sheet_visibility = state.sheet_visibility.write(effect).map_err(|e| e.to_string())?;
        let mut all_column_widths = state.all_column_widths.write(effect).map_err(|e| e.to_string())?;
        let mut all_row_heights = state.all_row_heights.write(effect).map_err(|e| e.to_string())?;

        let count = sheet_names.len();
        let rotations = partition_rotations(&sheet_visibility, count);
        if rotations.is_empty() {
            return Ok(None);
        }

        // PAD BEFORE ROTATING, with `append_sheet_stores`' defaults: a vector shorter
        // than the sheet list would make `rotate_element` slice out of range, and a
        // blind rotation of a short vector would move a DIFFERENT sheet's value.
        ensure_vec_len_with(&mut grids, count, engine::grid::Grid::new);
        ensure_vec_len(&mut freeze_configs, count);
        ensure_tab_color_len(&mut tab_colors, count);
        ensure_visibility_len(&mut sheet_visibility, count);
        ensure_vec_len(&mut all_column_widths, count);
        ensure_vec_len(&mut all_row_heights, count);

        for &(from, to) in &rotations {
            rotate_element(&mut *sheet_names, from, to);
            rotate_element(&mut *grids, from, to);
            rotate_element(&mut *freeze_configs, from, to);
            rotate_element(&mut *tab_colors, from, to);
            rotate_element(&mut *sheet_visibility, from, to);
            rotate_element(&mut *all_column_widths, from, to);
            rotate_element(&mut *all_row_heights, from, to);
        }
        {
            let mut split_configs = state.split_configs.write(effect).map_err(|e| e.to_string())?;
            ensure_vec_len(&mut split_configs, count);
            for &(from, to) in &rotations {
                rotate_element(&mut *split_configs, from, to);
            }
        }
        {
            let mut scroll_areas = state.scroll_areas.lock().map_err(|e| e.to_string())?;
            ensure_vec_len(&mut scroll_areas, count);
            for &(from, to) in &rotations {
                rotate_element(&mut *scroll_areas, from, to);
            }
        }
        {
            let mut sheet_zooms = state.sheet_zooms.write(effect).map_err(|e| e.to_string())?;
            ensure_vec_len_with(&mut sheet_zooms, count, || persistence::DEFAULT_SHEET_ZOOM_PERCENT);
            for &(from, to) in &rotations {
                rotate_element(&mut *sheet_zooms, from, to);
            }
        }
        {
            let mut page_setups = state.page_setups.write(effect).map_err(|e| e.to_string())?;
            ensure_vec_len(&mut page_setups, count);
            for &(from, to) in &rotations {
                rotate_element(&mut *page_setups, from, to);
            }
        }
        {
            let mut sheet_ids = state.sheet_ids.write(effect).map_err(|e| e.to_string())?;
            ensure_vec_len_with(&mut sheet_ids, count, || {
                identity::SheetId::from_bytes(identity::generate_uuid_v7())
            });
            for &(from, to) in &rotations {
                rotate_element(&mut *sheet_ids, from, to);
            }
        }
        {
            let mut gridlines = state.show_gridlines.write(effect).map_err(|e| e.to_string())?;
            ensure_vec_len_with(&mut gridlines, count, || true);
            for &(from, to) in &rotations {
                rotate_element(&mut *gridlines, from, to);
            }
        }
        {
            let mut display_flags = state.sheet_display_flags.write(effect).map_err(|e| e.to_string())?;
            ensure_vec_len(&mut display_flags, count);
            for &(from, to) in &rotations {
                rotate_element(&mut *display_flags, from, to);
            }
        }
        {
            let mut sheet_kinds = state.sheet_kinds.write(effect).map_err(|e| e.to_string())?;
            ensure_vec_len(&mut sheet_kinds, count);
            for &(from, to) in &rotations {
                rotate_element(&mut *sheet_kinds, from, to);
            }
        }
        {
            let mut all_merged = state.all_merged_regions.write(effect).map_err(|e| e.to_string())?;
            ensure_vec_len(&mut all_merged, count);
            for &(from, to) in &rotations {
                rotate_element(&mut *all_merged, from, to);
            }
        }
        for &(from, to) in &rotations {
            crate::commands::dimensions::rotate_user_hidden_sheet(state, effect, from, to, count);
        }

        // The composite permutation, by replaying the same rotations over the
        // identity: `order[new] == old`.
        let mut order: Vec<usize> = (0..count).collect();
        for &(from, to) in &rotations {
            rotate_element(&mut order, from, to);
        }
        let mut old_to_new = vec![0usize; count];
        for (new_index, &old_index) in order.iter().enumerate() {
            old_to_new[old_index] = new_index;
        }

        // The active sheet follows its sheet. (The `grid` mirror and the other
        // active-sheet mirrors describe that same sheet, so they stay as they are.)
        if let Some(&new_active) = old_to_new.get(*active_sheet) {
            *active_sheet = new_active;
        }

        // Re-key the sheet-index-keyed stores under the held sheet locks, exactly
        // as `add_sheet_inner` does: its cross-sheet dependency edges and spill maps
        // above all, then tables, then the note/hyperlink stores that remap misses.
        let remap = |i: usize| -> Option<usize> { Some(old_to_new.get(i).copied().unwrap_or(i)) };
        remap_sheet_keyed_stores(state, effect, remap);
        remap_tables_store(state, effect, remap);
        remap_note_and_hyperlink_stores(state, effect, &remap);

        // The index-FIELD objects, through the same total remap (see the header).
        // Every protected region moves with its sheet -- pivot, BI and report
        // alike: a region is WHERE generated output sits, and a region left on
        // the old index would guard a different sheet's cells.
        {
            let mut regions = state.protected_regions.lock().map_err(|e| e.to_string())?;
            for region in regions.iter_mut() {
                if let Some(new_index) = remap(region.sheet_index) {
                    region.sheet_index = new_index;
                }
            }
        }
        crate::report::remap_report_sheets(state, effect, remap);
        crate::object_deps::cascade_sheet_removed(
            state,
            slicer_state,
            timeline_state,
            ribbon_filter_state,
            effect,
            &remap,
        );

        old_to_new
    }; // every sheet lock released here

    // THE ROTATION IS A STRUCTURAL CHANGE (BUG-0005). It renumbered the object
    // sheets it moved, and a queued undo entry names its sheet by INDEX -- a
    // floating-range cell edit recorded on the old backing index would undo
    // onto whichever sheet holds that index now. Excel's answer, and so this
    // crate's: a change to the workbook's structure ends the undo history.
    // Taken with every lock above released (see the contract on
    // `invalidate_undo_history_for_sheet_structure`), and only when something
    // moved.
    invalidate_undo_history_for_sheet_structure(state, "restore the sheet partition");

    Ok(Some(old_to_new))
}

/// Re-key the two cross-sheet dependency maps after sheet indices are
/// renumbered. `remap` returns the new index for an old one, or `None` when
/// that sheet is gone.
///
/// Locks in the same order as `rebuild_all_dependencies_from_grid`
/// (dependents, then dependencies) so the two can never deadlock against each
/// other.
#[cfg(test)]
pub(crate) fn remap_cross_sheet_dependency_indices_for_test(
    state: &AppState,
    remap: &impl Fn(usize) -> Option<usize>,
) {
    remap_cross_sheet_dependency_indices(state, remap)
}

fn remap_cross_sheet_dependency_indices(
    state: &AppState,
    remap: &impl Fn(usize) -> Option<usize>,
) {
    let mut dependents = state.cross_sheet_dependents.lock().unwrap();
    let mut dependencies = state.cross_sheet_dependencies.lock().unwrap();

    // Dependents: the sheet index sits in the VALUES. A dependent on a deleted
    // sheet is dropped; an emptied source key is dropped with it so the map
    // does not accumulate dead entries across repeated sheet operations.
    dependents.retain(|_source, deps| {
        let moved: rustc_hash::FxHashSet<(usize, u32, u32)> = deps
            .iter()
            .filter_map(|&(idx, r, c)| remap(idx).map(|new_idx| (new_idx, r, c)))
            .collect();
        *deps = moved;
        !deps.is_empty()
    });

    // Dependencies: the sheet index is the first element of the KEY.
    let moved: crate::CrossSheetDependenciesMap = dependencies
        .drain()
        .filter_map(|((idx, r, c), refs)| remap(idx).map(|new_idx| ((new_idx, r, c), refs)))
        .collect();
    *dependencies = moved;
}

/// Repair the `refers_to` formula of every defined name after a sheet is
/// renamed or deleted, using the SAME repair the grid formulas go through.
///
/// Nothing touched the name table on any sheet operation. A name is a formula
/// STRING re-parsed at every evaluation, so `Sales = Sheet1!$A$1:$A$10` outlived
/// its sheet verbatim -- and because an unknown sheet used to resolve to the
/// formula's OWN sheet, `=SUM(Sales)` on another sheet quietly summed that
/// sheet's A1:A10 instead. The evaluator now answers `#REF!` for an unknown
/// sheet, so the worst case became visible rather than wrong; this makes the
/// name follow its sheet instead, which is what the user asked for.
///
/// `repair` returns `None` when the name can no longer be resolved (its sheet
/// was deleted); the name's text is then set to `#REF!` so it reports the same
/// error a cell would, rather than being deleted out from under formulas that
/// still mention it.
#[cfg(test)]
pub(crate) fn repair_named_ranges_for_test(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    repair: &dyn Fn(&str) -> Option<String>,
) {
    repair_named_ranges(state, effect, repair)
}

#[cfg(test)]
pub(crate) fn remap_sheet_keyed_stores_for_test(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    remap: impl Fn(usize) -> Option<usize>,
) {
    remap_sheet_keyed_stores(state, effect, remap)
}

/// Pre-flight the whole-workbook formula repair over the grids AS THE REPAIR
/// WILL SEE THEM, and refuse before anything is mutated.
///
/// TWO SUBTLETIES, both of which a naive `check_formulas_repairable(&grids, ..)`
/// gets wrong:
///
/// 1. `state.grid` is the AUTHORITATIVE copy of the active sheet and
///    `grids[active]` can lag behind it (BUG-0016) — both sheet commands sync
///    them just before repairing. Checking `grids` alone would miss a formula
///    the user typed since the last sheet switch, which is exactly the formula
///    most likely to be unusual.
/// 2. A sheet being DELETED is skipped: its formulas are about to cease to
///    exist, so refusing the delete on account of one of them would be a
///    refusal the user cannot act on.
fn check_workbook_repairable(
    grids: &[engine::Grid],
    active_grid: &engine::Grid,
    active_sheet: usize,
    deleted_sheet: Option<usize>,
    repair: &dyn Fn(&str) -> Option<String>,
) -> Result<(), crate::FormulaRepairRefusal> {
    let mut skip: Vec<usize> = Vec::new();
    if let Some(d) = deleted_sheet {
        skip.push(d);
    }
    if active_sheet < grids.len() {
        skip.push(active_sheet);
    }
    crate::check_formulas_repairable(grids, &skip, repair)?;
    if active_sheet < grids.len() && deleted_sheet != Some(active_sheet) {
        // The active sheet, from the copy that is actually authoritative. Its
        // refusal comes back carrying index 0 (it was checked as a one-sheet
        // slice), so re-stamp it with the real sheet index or the message names
        // the wrong sheet.
        crate::check_formulas_repairable(std::slice::from_ref(active_grid), &[], repair).map_err(
            |mut refusal| {
                refusal.sheet_index = active_sheet;
                refusal
            },
        )?;
    }
    Ok(())
}

fn repair_named_ranges(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    repair: &dyn Fn(&str) -> Option<String>,
) {
    let mut names = state.named_ranges.write(effect).unwrap();
    for nr in names.values_mut() {
        match repair(&nr.refers_to) {
            Some(repaired) => nr.refers_to = repaired,
            None => nr.refers_to = "=#REF!".to_string(),
        }
    }
}

/// Repair every FORMULA in the `.calp` override layer -- each record's
/// `current` through `repair_current`, its `baseline` and conflict
/// `upstream_new` through `repair_upstream`. A rename passes the closure the
/// grid formulas and defined names go through for both.
///
/// A DELETE passes two (review C): `current` is the subscriber's own text, and
/// the next refresh writes it over the cell (`apply_override_value_to_grid`),
/// so it must read exactly as the cell's own repair left the cell; `baseline`
/// and `upstream_new` are UPSTREAM text, which the next refresh compares with
/// its own rewrite of the untouched upstream (`RefreshSheetNames::renames`),
/// so they follow that rewrite -- or every refresh reads a false conflict.
///
/// The layer records formulas WITHOUT a leading `=` (`override_value_from_saved`
/// and the app's `override_value_from_cell` both do), and the repair renders a
/// changed formula WITH one; the layer's own spelling is kept. A formula the
/// repair does not change keeps its bytes (the repair returns the original
/// text then), and a layer with no formula referring to the sheet is left
/// exactly as it was. Takes `override_layer` alone, after every sheet guard.
fn repair_override_formulas(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    repair_current: &dyn Fn(&str) -> String,
    repair_upstream: &dyn Fn(&str) -> String,
) {
    let fix = |value: &mut calp::OverrideValue, repair: &dyn Fn(&str) -> String| {
        let calp::OverrideValue::Formula { formula } = value else { return };
        let repaired = repair(formula);
        if repaired == *formula {
            return;
        }
        *formula = if formula.trim_start().starts_with('=') {
            repaired
        } else {
            repaired.strip_prefix('=').map(str::to_string).unwrap_or(repaired)
        };
    };
    let Ok(mut layer) = state.override_layer.write(effect) else { return };
    for ovr in layer.overrides.iter_mut() {
        fix(&mut ovr.baseline, repair_upstream);
        fix(&mut ovr.current, repair_current);
        if let Some(upstream) = ovr.upstream_new.as_mut() {
            fix(upstream, repair_upstream);
        }
    }
}

/// Run one typed rule-store value through a `calp::sheet_renames` payload
/// rename: serialized to the JSON the payload walker reads (the shape a
/// `.calp` carries it in), renamed, and deserialized back ONLY when the walker
/// changed something. True when `value` changed. A renamed payload that no
/// longer deserializes is left exactly as it was and logged -- a rename must
/// never destroy a rule.
fn rename_typed_payload<T: Serialize + serde::de::DeserializeOwned>(
    value: &mut T,
    rename: impl FnOnce(&mut serde_json::Value) -> usize,
) -> bool {
    let Ok(mut json) = serde_json::to_value(&*value) else { return false };
    if rename(&mut json) == 0 {
        return false;
    }
    match serde_json::from_value::<T>(json) {
        Ok(renamed) => {
            *value = renamed;
            true
        }
        Err(e) => {
            crate::log_error!("SHEET", "a renamed rule payload no longer deserializes ({}); left as it was", e);
            false
        }
    }
}

/// Rename the sheet references inside the RULE stores a sheet rename must
/// carry besides cells, names and overrides: every conditional-formatting
/// formula, every custom data-validation formula, and every formula property
/// of a cell-anchored control (wave-B fix-up).
///
/// Each names sheets by NAME exactly as a cell formula does, and a rename left
/// them alone: a CF rule `=A1>Data!$B$1` kept reading "Data" after Data became
/// Facts -- the formula named a sheet that no longer existed, so the highlight
/// silently vanished -- and a custom validation or a button's text formula read
/// a missing sheet the same way. Excel carries all of them through a rename.
///
/// Goes through the SAME per-payload walkers a `.calp` pull's collision rename
/// does (`calp::sheet_renames`), so a user's rename and a pull cannot disagree
/// about which strings are formulas -- a CF expression with or without its
/// `=`, a cell-value bound or a control property only with one (the host reads
/// the rest as literals). Each store is taken alone, after every sheet guard.
fn rename_rule_references(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    renames: &calp::sheet_renames::SheetRenames,
) {
    if renames.is_empty() {
        return;
    }
    rewrite_rule_formulas(state, effect, &|text| renames.rename_formula(text));
}

/// Run every formula slot of the three RULE stores -- conditional formats,
/// data validations, cell-anchored controls -- through `rewrite` (`None` =
/// leave the slot as it is). The slots are the ones the `.calp` payload
/// visitors reach (`calp::sheet_renames::visit_*_formulas`), the one
/// definition of which strings are formulas that a rename, a pull and a delete
/// share. Each store is taken alone.
fn rewrite_rule_formulas(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    rewrite: &dyn Fn(&str) -> Option<String>,
) {
    let mut slot = |text: &mut String| match rewrite(text.as_str()) {
        Some(rewritten) => {
            *text = rewritten;
            true
        }
        None => false,
    };
    if let Ok(mut store) = state.conditional_formats.write(effect) {
        for defs in store.values_mut() {
            rename_typed_payload(defs, |json| calp::sheet_renames::visit_cf_rule_formulas(json, &mut slot));
        }
    }
    if let Ok(mut store) = state.data_validations.write(effect) {
        for ranges in store.values_mut() {
            rename_typed_payload(ranges, |json| calp::sheet_renames::visit_validation_formulas(json, &mut slot));
        }
    }
    if let Ok(mut store) = state.controls.write(effect) {
        for (&(_, row, col), meta) in store.iter_mut() {
            // The walker reads the `.calp` shape (`Vec<SavedControlEntry>`).
            let mut entries = vec![crate::controls::SavedControlEntry {
                row,
                col,
                control_type: meta.control_type.clone(),
                properties: meta.properties.clone(),
            }];
            if rename_typed_payload(&mut entries, |json| {
                calp::sheet_renames::visit_control_formulas(json, &mut slot)
            }) {
                if let Some(entry) = entries.pop() {
                    meta.properties = entry.properties;
                }
            }
        }
    }
}

/// The DELETE twin of [`rename_rule_references`], plus the override layer
/// (wave C, W10/W11): every reference to the deleted sheet in a conditional
/// format, a custom validation, a control's formula property, a pane
/// dropdown's range source and a `.calp` override record becomes `#REF!` --
/// except a 3D reference that loses one endpoint, which keeps the rest of its
/// range exactly as a cell's does (below).
///
/// Before this, a delete repaired cell formulas and defined names only: a CF
/// rule `=A1>Data!$B$1` kept naming Data after Data was deleted -- the
/// evaluator resolves an unknown sheet name to the rule's OWN sheet, so the
/// highlight silently read a local cell, and a sheet created later under the
/// old name captured every such rule. The same held for validations, button
/// captions and dropdowns, and for override formulas, whose baseline then
/// disagreed with the refresh's own rewrite of the upstream text (a gone
/// sheet's references become `#REF!` there -- `RefreshSheetNames`) and read as
/// a conflict.
///
/// TWO RULES, by whose text it is (review C). A formula the workbook itself
/// evaluates -- a rule formula, an override's CURRENT text, which the next
/// refresh writes over its cell -- is repaired as the CELLS were: a 3D
/// reference that loses one endpoint keeps the rest of its range
/// (`SUM(Mid:Data!B1)` becomes `SUM(Mid:Mid!B1)`), and anything else naming
/// the deleted sheet becomes `#REF!` in place, as Excel writes a rule
/// (`=A1>#REF!`) -- `crate::repair_formula_text_on_delete_at`. The gone-walker
/// alone had turned the 3D reference into `#REF!` beside a cell that still
/// summed Mid, and the override's current text then broke that working cell
/// at the next refresh. An override's BASELINE and conflict UPSTREAM are
/// upstream text, and keep the `.calp` gone-walker -- the rule a refresh
/// applies to a sheet the subscriber deleted -- because the refresh compares
/// its own rewrite of the untouched upstream with the baseline
/// (`repair_override_formulas`). A pane dropdown's source is a plain A1
/// reference, for which the two rules agree. Each store is taken alone, after
/// every sheet guard.
fn delete_rule_references(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    pane_control_state: &crate::pane_control::PaneControlState,
    deleted_name: &str,
    deleted_index: usize,
    sheet_names_after: &[String],
) {
    let gone = calp::sheet_renames::SheetRenames::default().with_gone([deleted_name]);
    if gone.is_empty() {
        return;
    }
    let as_the_cells_were = |formula: &str| {
        crate::repair_formula_text_on_delete_at(formula, deleted_name, deleted_index, sheet_names_after)
    };
    rewrite_rule_formulas(state, effect, &as_the_cells_were);
    rename_pane_control_references(pane_control_state, &gone);
    repair_override_formulas(
        state,
        effect,
        &|formula| as_the_cells_were(formula).unwrap_or_else(|| formula.to_string()),
        &|formula| gone.rename_formula(formula).unwrap_or_else(|| formula.to_string()),
    );
}

/// Rename the sheet prefix of every pane-control dropdown's cell-range source
/// (`"Data!A1:A5"`) for a sheet rename -- the fourth rule store a rename must
/// carry, through the same walker a `.calp` pull uses. Returns how many changed.
///
/// Called by every rename door through [`with_pane_controls_following_rename`]
/// (pane controls live in their own managed state, `PaneControlState`, which
/// `rename_sheet_inner` does not receive), and by a sheet DELETE with a
/// `SheetRenames::with_gone` set, which turns a dropdown sourced from the
/// deleted sheet into `#REF!` (`delete_rule_references`).
pub fn rename_pane_control_references(
    pane_state: &crate::pane_control::PaneControlState,
    renames: &calp::sheet_renames::SheetRenames,
) -> usize {
    if renames.is_empty() {
        return 0;
    }
    let Ok(mut controls) = pane_state.controls.lock() else { return 0 };
    let mut changed = 0;
    for control in controls.values_mut() {
        if rename_typed_payload(&mut control.config, |json| renames.rename_pane_control_config(json)) {
            changed += 1;
        }
    }
    changed
}

/// Re-key the two cross-sheet dependency maps after a sheet is RENAMED.
///
/// The other half of the same defect. `cross_sheet_dependents` is keyed by
/// sheet NAME under the workbook's official spelling (see
/// `normalize_cross_sheet_refs`), and `rename_sheet` changed that spelling
/// without touching the map. The cascade then looked up the NEW name, missed,
/// and every dependent on another sheet stopped updating: `Sheet2!B1 =
/// Sheet1!A1`, rename Sheet1 to Data, edit Data!A1 -- B1 kept its old value and
/// saved it. Visiting Sheet2 rebuilt that one sheet's edges but did not
/// re-evaluate anything, so the wrong value simply persisted.
pub(crate) fn rename_cross_sheet_dependency_keys(state: &AppState, old_name: &str, new_name: &str) {
    let mut dependents = state.cross_sheet_dependents.lock().unwrap();
    let mut dependencies = state.cross_sheet_dependencies.lock().unwrap();

    let renamed: crate::CrossSheetDependentsMap = dependents
        .drain()
        .map(|((sheet, r, c), deps)| {
            let sheet = if sheet.eq_ignore_ascii_case(old_name) {
                new_name.to_string()
            } else {
                sheet
            };
            ((sheet, r, c), deps)
        })
        .collect();
    *dependents = renamed;

    // The reverse index holds the same names inside its value sets; the two are
    // maintained in lockstep everywhere else and must move together here.
    for refs in dependencies.values_mut() {
        let renamed: rustc_hash::FxHashSet<(String, u32, u32)> = refs
            .drain()
            .map(|(sheet, r, c)| {
                let sheet = if sheet.eq_ignore_ascii_case(old_name) {
                    new_name.to_string()
                } else {
                    sheet
                };
                (sheet, r, c)
            })
            .collect();
        *refs = renamed;
    }
}

// ============================================================================
// Existing Commands (updated for tab_color / hidden)
// ============================================================================

#[tauri::command]
pub fn get_sheets(state: State<AppState>) -> SheetsResult {
    let sheet_names = state.sheet_names.read().unwrap();
    let active_index = *state.active_sheet.read().unwrap();
    let freeze_configs = state.freeze_configs.read().unwrap();
    let tab_colors = state.tab_colors.read().unwrap();
    let sheet_visibility = state.sheet_visibility.read().unwrap();

    SheetsResult {
        sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &sheet_visibility, &state.sheet_ids.read().unwrap(), &state.sheet_kinds.read().unwrap()),
        active_index,
    }
}

#[tauri::command]
pub fn get_active_sheet(state: State<AppState>) -> usize {
    *state.active_sheet.read().unwrap()
}

/// The workbook's stable sheet uuids in index order. Lets per-sheet
/// distributable-object providers fill `DistributableObjectPayload.sheetId`
/// (the publish flow maps it to the package sheet id; the pull flow hands the
/// provider a REMAPPED local sheet index).
#[tauri::command]
pub fn get_sheet_ids(state: State<AppState>) -> Vec<String> {
    state
        .sheet_ids
        .read()
        .unwrap()
        .iter()
        .map(|id| id.to_string())
        .collect()
}

/// Get the gridlines visibility setting for the active sheet.
#[tauri::command]
pub fn get_show_gridlines(state: State<AppState>) -> bool {
    let active = *state.active_sheet.read().unwrap();
    let gridlines = state.show_gridlines.read().unwrap();
    gridlines.get(active).copied().unwrap_or(true)
}

/// Read the DISPLAY FLAGS for the active sheet.
#[tauri::command]
pub fn get_sheet_display_flags(state: State<AppState>) -> crate::api_types::SheetDisplayFlags {
    let active = *state.active_sheet.read().unwrap();
    let flags = state.sheet_display_flags.read().unwrap();
    flags.get(active).cloned().unwrap_or_default()
}

/// The Tauri event announcing that the active sheet's display flags CHANGED.
///
/// WHY THE SETTER HAS TO ANNOUNCE. These four flags have a backend authority that
/// round-trips the `.cala`, but the thing that DRAWS them is frontend Core state, fed
/// by the `DISPLAY_*_TOGGLED` app events the View menu emits. Anything that reaches
/// this command WITHOUT going through that menu -- a script, an MCP tool, a `.calp`
/// materialisation, an E2E spec restoring state -- moved the authority and left the
/// renderer describing the previous document. Measured on the running app: after one
/// spec restored the flags here, the whole session painted with the row/column
/// headings switched OFF while `get_sheet_display_flags` reported them ON.
///
/// Bridged onto the `@api` bus by `app/src/shell/sheetDisplayFlagsBridge.ts`, exactly
/// like `document:dirty-changed`. The payload is the RESULT of applying the patch, not
/// the patch, so a subscriber never has to merge.
pub const SHEET_DISPLAY_FLAGS_EVENT: &str = "sheet:display-flags-changed";

/// Set the DISPLAY FLAGS for the active sheet.
///
/// ONE command for all four flags rather than four commands: they are a single
/// user-facing unit, a partial patch keeps a caller from clobbering flags it does not
/// know about, and the `generate_handler!` dispatch frame is already close to its
/// 32MB main-thread stack budget (see `build.rs`), so four new entries would be four
/// times the cost for no benefit.
#[tauri::command]
pub fn set_sheet_display_flags(
    app: tauri::AppHandle,
    state: State<AppState>,
    file_state: State<crate::persistence::FileState>,
    patch: crate::api_types::SheetDisplayFlagsPatch,
) {
    let active = *state.active_sheet.read().unwrap();
    // Persisted per-sheet view state dirties, exactly like `set_show_gridlines` and
    // `set_split_window`; the only exception is navigation (see `set_active_sheet`).
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let announced = {
        let mut flags = state.sheet_display_flags.write(&effect).unwrap();
        while flags.len() <= active {
            flags.push(crate::api_types::SheetDisplayFlags::default());
        }
        let entry = &mut flags[active];
        if let Some(v) = patch.display_zeros {
            entry.display_zeros = v;
        }
        if let Some(v) = patch.show_formulas {
            entry.show_formulas = v;
        }
        if let Some(v) = patch.view_mode {
            entry.view_mode = v;
        }
        if let Some(v) = patch.display_headings {
            entry.display_headings = v;
        }
        entry.clone()
    };
    // Announce AFTER the guard is dropped: a subscriber that answers by calling
    // `get_sheet_display_flags` would deadlock against a still-held write lock.
    use tauri::Emitter;
    let _ = app.emit(SHEET_DISPLAY_FLAGS_EVENT, announced);
}

/// The Tauri event announcing that a canvas sheet's LAYOUT changed (page, snap
/// grid, background, stacking). Same reason `SHEET_DISPLAY_FLAGS_EVENT` exists:
/// the authority lives here, but the canvas surface that draws it is frontend
/// state, and a script, an MCP tool or a `.calp` refresh can move the authority
/// without going through the ribbon. Bridged onto the `@api` bus as
/// `AppEvents.CANVAS_LAYOUT_CHANGED` by `app/src/shell/canvasLayoutBridge.ts`
/// (pinned by its test). The payload names the sheet and carries the RESULT of
/// the patch; the bridge drops it and subscribers re-read `get_sheets`.
pub const CANVAS_LAYOUT_EVENT: &str = "sheet:canvas-layout-changed";

/// The payload of [`CANVAS_LAYOUT_EVENT`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasLayoutChanged {
    pub sheet_index: usize,
    pub sheet_id: String,
    pub layout: ::persistence::CanvasLayout,
}

/// The undo restore kind for a canvas's STACKING and LOCKS (`z_order`,
/// `locked`). The other layout settings (page, snap grid, background) stay
/// view state with no undo (decision D1); Excel's Bring to Front / Send to
/// Back and object locking ARE undoable, so these two are (W5, = M4).
/// Registered in `undo_commands::RESTORE_REGISTRY` with the `Sheets` domain:
/// the Shell fans that out to `SHEET_CHANGED`, on which the CanvasSheet
/// extension re-reads every canvas layout and repaints in the restored order.
pub(crate) const CANVAS_STACKING_RESTORE_KIND: &str = "canvas_stacking";

/// A canvas's stacking and locks before a change, by sheet IDENTITY (an index
/// would name another sheet after a move or a delete in between).
#[derive(Serialize, Deserialize)]
struct CanvasStackingSnapshot {
    sheet_id: identity::SheetId,
    z_order: Vec<::persistence::CanvasObjectRef>,
    locked: Vec<::persistence::CanvasObjectRef>,
}

/// The `canvas_stacking` restore payload of a canvas's CURRENT stacking.
fn canvas_stacking_restore_bytes(
    sheet_id: identity::SheetId,
    layout: &::persistence::CanvasLayout,
) -> Vec<u8> {
    serde_json::to_vec(&CanvasStackingSnapshot {
        sheet_id,
        z_order: layout.z_order.clone(),
        locked: layout.locked.clone(),
    })
    .unwrap_or_default()
}

/// Restore a canvas's `z_order` and `locked` from a `canvas_stacking`
/// snapshot, pushing the CURRENT ones as the inverse (redo). A canvas that no
/// longer exists (or is no longer a canvas) restores nothing and pushes no
/// inverse. LOCKS: `sheet_ids` is read and released before `sheet_kinds` is
/// written -- the order `set_canvas_layout_inner` takes them in.
pub(crate) fn apply_canvas_stacking_restore(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    data: &[u8],
    inverse: &mut engine::Transaction,
) {
    let Ok(snap) = serde_json::from_slice::<CanvasStackingSnapshot>(data) else {
        crate::log_error!("UNDO", "bad canvas_stacking snapshot; nothing restored");
        return;
    };
    let Some(index) = state.sheet_ids.read().unwrap().iter().position(|id| *id == snap.sheet_id) else {
        return;
    };
    let mut kinds = state.sheet_kinds.write(effect).unwrap();
    let Some(::persistence::SheetKind::Canvas(layout)) = kinds.get_mut(index) else { return };
    let current = CanvasStackingSnapshot {
        sheet_id: snap.sheet_id,
        z_order: std::mem::replace(&mut layout.z_order, snap.z_order),
        locked: std::mem::replace(&mut layout.locked, snap.locked),
    };
    inverse.add_change(engine::CellChange::CustomRestore {
        kind: CANVAS_STACKING_RESTORE_KIND.to_string(),
        data: serde_json::to_vec(&current).unwrap_or_default(),
    });
}

/// Change a canvas sheet's LAYOUT (page, snap grid, background, stacking).
///
/// ONE command for the whole layout (a partial patch), for the reason
/// `set_sheet_display_flags` is one command: the dispatch frame's stack budget.
/// Addresses a sheet by index so a script can lay out a canvas that is not on
/// screen; `None` means the active sheet. Refused for a worksheet, and for a
/// patch whose result fails `CanvasLayout::validate` -- both BEFORE the effect,
/// in the same critical section as the write (`lock_pending`), so a refusal
/// leaves the document clean and a concurrent patch cannot slip in between.
///
/// UNDO: a change to the STACKING (Bring to Front / Send to Back) or the LOCKS
/// is ONE undo step (W5, see `set_canvas_layout_inner`). The page, snap grid
/// and background are not undoable, like zoom and the display flags: they are
/// view/layout state.
#[tauri::command]
pub fn set_canvas_layout(
    app: tauri::AppHandle,
    state: State<AppState>,
    file_state: State<FileState>,
    sheet_index: Option<usize>,
    patch: crate::api_types::CanvasLayoutPatch,
) -> Result<::persistence::CanvasLayout, String> {
    let changed = set_canvas_layout_inner(&state, &file_state, sheet_index, &patch)?;
    let layout = changed.layout.clone();
    // Announce AFTER every guard is dropped (see SHEET_DISPLAY_FLAGS_EVENT).
    use tauri::Emitter;
    let _ = app.emit(CANVAS_LAYOUT_EVENT, changed);
    Ok(layout)
}

/// Command body over plain references (unit-testable without a Tauri State).
///
/// A change to the STACKING (`z_order`) or the LOCKS (`locked`) is ONE undo
/// step (W5): Bring to Front / Send to Back and Lock are Excel-undoable, so
/// each records a `canvas_stacking` restore of the previous lists -- JOINING
/// the caller's open transaction (a cross-family arrange) or as a step of its
/// own. Every other layout setting stays non-undoable view state (decision
/// D1), and a patch that leaves both lists as they were records nothing. A
/// patch that changes nothing at all leaves the document clean.
/// Recorded after the `sheet_kinds` guard drops: the undo stack is never
/// taken while holding a store.
pub(crate) fn set_canvas_layout_inner(
    state: &AppState,
    file_state: &FileState,
    sheet_index: Option<usize>,
    patch: &crate::api_types::CanvasLayoutPatch,
) -> Result<CanvasLayoutChanged, String> {
    let index = match sheet_index {
        Some(i) => i,
        None => *state.active_sheet.read().unwrap(),
    };
    // Layout edits are object-scope: allowed on a protected sheet only when
    // the protection options allow editing objects.
    crate::protection::check_sheet_action(state, index, "editObjects", "change the canvas layout")?;
    let sheet_id = state
        .sheet_ids
        .read()
        .unwrap()
        .get(index)
        .map(|id| id.to_string())
        .unwrap_or_default();
    let kinds = state.sheet_kinds.lock_pending().unwrap();
    let current = match kinds.get(index) {
        Some(::persistence::SheetKind::Canvas(layout)) => layout.clone(),
        _ => {
            return Err(format!(
                "Sheet {} is not a canvas sheet; only a canvas has a page layout.",
                index
            ))
        }
    };
    let next = patch.apply(current.clone())?;
    if next == current {
        // A patch that changes NOTHING (a script re-sending the page, snap
        // grid or stacking already there) mints no effect and records no step:
        // the effect is constructed only in the branch that changes something.
        return Ok(CanvasLayoutChanged {
            sheet_index: index,
            sheet_id,
            layout: next,
        });
    }
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    let mut kinds = kinds.authorize(&effect);
    kinds[index] = ::persistence::SheetKind::Canvas(next.clone());
    drop(kinds);
    let reordered = current.z_order != next.z_order;
    if reordered || current.locked != next.locked {
        // Bound FIRST, so the `sheet_ids` guard drops here: in an `if let`
        // scrutinee (edition 2021) it would live through the whole body --
        // held while the recorder waits for the undo stack.
        let id = state.sheet_ids.read().unwrap().get(index).copied();
        if let Some(id) = id {
            let description = if reordered { "Reorder objects" } else { "Lock objects" };
            crate::undo_commands::record_restores_joining_open_transaction(
                state,
                description,
                vec![(CANVAS_STACKING_RESTORE_KIND, canvas_stacking_restore_bytes(id, &current))],
            );
        }
    }
    Ok(CanvasLayoutChanged {
        sheet_index: index,
        sheet_id,
        layout: next,
    })
}

/// Set the gridlines visibility for the active sheet.
#[tauri::command]
pub fn set_show_gridlines(
    state: State<AppState>,
    file_state: State<FileState>,
    visible: bool,
) {
    let active = *state.active_sheet.read().unwrap();
    // `sheet.show_gridlines` is persisted (enrich_workbook_metadata). Persisted view
    // state dirties -- the only exception is navigation (see `set_active_sheet`).
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut gridlines = state.show_gridlines.write(&effect).unwrap();
    while gridlines.len() <= active {
        gridlines.push(true);
    }
    gridlines[active] = visible;
}

#[tauri::command]
pub fn set_active_sheet(state: State<AppState>, index: usize) -> Result<SheetsResult, String> {
    activate_sheet(&state, index)
}

/// Make `index` the active sheet -- the WHOLE swap, not the flag.
///
/// The command above is a one-line delegation to this, and the split exists
/// because the backend now initiates a sheet switch of its own: Excel keeps one
/// undo history and switches to the sheet the undone action happened on, so
/// `undo_commands::apply_changes` has to perform a real activation. It holds an
/// `&AppState`, not a `State<AppState>`, and a second implementation of "swap
/// the mirrors" is exactly how the per-sheet stores drift apart -- the grid, the
/// column widths, the row heights, the merged regions and the user-hidden sets
/// all have to move together, and each one that a copy forgot would be that
/// sheet's state leaking onto the other.
///
/// CALLERS MUST HOLD NO STATE LOCK. This takes the canonical order (`grid`,
/// `grids`, then everything else) and then, with every guard dropped, rebuilds
/// the dependency maps.
pub(crate) fn activate_sheet(state: &AppState, index: usize) -> Result<SheetsResult, String> {
    // AUDITED OPT-OUT. `workbook.active_sheet` IS persisted, and Excel does dirty on a
    // sheet switch -- we deliberately diverge, because merely LOOKING at a workbook must
    // never make it dirty or the close prompt stops meaning anything. Declared rather
    // than omitted: `rg deliberately_clean` lists every such decision. When
    // `active_sheet` is onboarded to `Persisted<T>` this is the effect it will pass.
    let effect = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::Navigation,
    );
    let (result, switched) = {
    // CANONICAL LOCK ORDER: `grid`, then `grids`, then everything else --
    // including `sheet_names`. The recalculation pass takes `sheet_names` only
    // AFTER both grid locks and runs on a background thread, so holding it here
    // and then waiting for a grid lock closes a cycle that hangs the app.
    let mut current_grid = state.grid.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    let sheet_names = state.sheet_names.read().unwrap();
    let mut active_sheet = state.active_sheet.write(&effect).unwrap();
    let freeze_configs = state.freeze_configs.read().unwrap();
    let tab_colors = state.tab_colors.read().unwrap();
    let sheet_visibility = state.sheet_visibility.read().unwrap();
    let mut column_widths = state.column_widths.write(&effect).unwrap();
    let mut row_heights = state.row_heights.write(&effect).unwrap();
    let mut all_column_widths = state.all_column_widths.write(&effect).unwrap();
    let mut all_row_heights = state.all_row_heights.write(&effect).unwrap();
    let mut merged_regions = state.merged_regions.write(&effect).unwrap();
    let mut all_merged_regions = state.all_merged_regions.write(&effect).unwrap();

    if index >= sheet_names.len() {
        return Err(format!("Sheet index {} out of range", index));
    }

    // An object-backed sheet can never be ACTIVE. The `state.grid` mirror, the
    // active-sheet dependency maps, and the cascade's seeding all lean on that
    // invariant — and every caller that switches sheets for the user's benefit
    // (tab clicks, undo's switch-to-target, Find navigation) has a user sheet
    // to land on instead. Callers that restore into a floating range go through
    // `grids[backing]` directly and never activate it.
    ensure_user_sheet(&sheet_visibility, index, "activate")?;

    // ...and a USER-HIDDEN sheet can never be active either. Excel says so first:
    // `Worksheets("x").Activate` on a hidden sheet raises run-time error 1004.
    //
    // ORDER IS LOAD-BEARING. `OBJECT_SHEET_VISIBILITY` is "object", which is also
    // not "visible", so a visibility check placed BEFORE `ensure_user_sheet` would
    // swallow the floating-range case and hand back the wrong message
    // (`object_sheet_tests.rs` asserts the error names "floating range").
    //
    // WHY IT MATTERS BEYOND PARITY: the tab strip cannot show a hidden sheet, so
    // an activation that succeeded would leave the canvas painting a sheet with no
    // tab while every keystroke wrote into it — the torn state from the other
    // direction. Five callers had already hand-rolled this rule (`activation_target`,
    // the sheet-tab-state restore, the open path's `nearest_visible_sheet`,
    // `delete_sheet`'s landing, `hide_sheet_inner`'s `switch_to`); this is the one
    // place that enforces it.
    //
    // The escape hatch is VBA's own, and Calcula ships it: make the sheet visible
    // first (Unhide, or `api.setSheetVisibility`).
    if !sheet_is_visible(&sheet_visibility, index) {
        return Err(format!(
            "Sheet '{}' is hidden and cannot be activated. Unhide it first              (Format > Sheet > Unhide, or api.setSheetVisibility).",
            sheet_names.get(index).map(|s| s.as_str()).unwrap_or("?")
        ));
    }

    while grids.len() <= index {
        grids.push(engine::grid::Grid::new());
    }

    // Ensure per-sheet dimension storage is large enough
    while all_column_widths.len() <= index {
        all_column_widths.push(HashMap::new());
    }
    while all_row_heights.len() <= index {
        all_row_heights.push(HashMap::new());
    }
    while all_merged_regions.len() <= index {
        all_merged_regions.push(HashSet::new());
    }

    let old_index = *active_sheet;

    if old_index != index {
        if old_index < grids.len() {
            grids[old_index] = current_grid.clone();
        }
        *current_grid = grids[index].clone();

        // Swap dimensions: save current to old sheet, load from new sheet
        if old_index < all_column_widths.len() {
            all_column_widths[old_index] = std::mem::take(&mut *column_widths);
        }
        if old_index < all_row_heights.len() {
            all_row_heights[old_index] = std::mem::take(&mut *row_heights);
        }
        *column_widths = std::mem::take(&mut all_column_widths[index]);
        *row_heights = std::mem::take(&mut all_row_heights[index]);

        // User-hidden rows/cols ride along with the dimensions: they are the
        // same kind of per-sheet, index-keyed view state.
        crate::commands::dimensions::stash_active_user_hidden(&state, old_index);
        crate::commands::dimensions::load_active_user_hidden(&state, index);

        // Swap merged regions: save current to old sheet, load from new sheet
        if old_index < all_merged_regions.len() {
            all_merged_regions[old_index] = std::mem::take(&mut *merged_regions);
        }
        *merged_regions = std::mem::take(&mut all_merged_regions[index]);
    }

    let switched = old_index != index;
    *active_sheet = index;

    (
        SheetsResult {
            sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &sheet_visibility, &state.sheet_ids.read().unwrap(), &state.sheet_kinds.read().unwrap()),
            active_index: index,
        },
        switched,
    )
    }; // drop all locks before rebuilding dependency maps

    // The dependency maps are keyed by (row, col) without a sheet dimension —
    // they only ever describe ONE sheet. Rebuild them for the newly active
    // sheet, otherwise edits here recalc against the previous sheet's edges
    // (BUG-0016: stale dependents -> silently wrong totals).
    if switched {
        crate::undo_commands::rebuild_all_dependencies(&state);
    }

    Ok(result)
}

/// Append one sheet entry to EVERY per-sheet store, returning its index and
/// freshly minted `SheetId`.
///
/// This is the single spelling of "a sheet now exists" — extracted from
/// `add_sheet` so that `create_floating_range` (which appends an OBJECT-backed
/// sheet, `OBJECT_SHEET_VISIBILITY`) cannot drift from it. A second copy of
/// this push list is exactly how a per-sheet store gets forgotten and shows up
/// as a save/reload digest diff or an index-out-of-bounds panic months later.
///
/// The caller holds the SEVEN outer write guards (canonical order: `grid`
/// implied first by the caller, then `grids`, `sheet_names`, and the rest) and
/// passes their `&mut` targets; the remaining per-sheet stores are acquired
/// here in short nested scopes, exactly as `add_sheet` always has. Does NOT
/// touch `active_sheet`, the `state.grid` mirror, or any stash/activate
/// bookkeeping — appending a sheet and LOOKING at it are different acts, and
/// an object-backed sheet is never looked at.
#[allow(clippy::too_many_arguments)]
pub(crate) fn append_sheet_stores(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    name: String,
    visibility: &str,
    kind: ::persistence::SheetKind,
    sheet_names: &mut Vec<String>,
    grids: &mut Vec<engine::Grid>,
    freeze_configs: &mut Vec<FreezeConfig>,
    tab_colors: &mut Vec<String>,
    sheet_visibility: &mut Vec<String>,
    all_column_widths: &mut Vec<HashMap<u32, f64>>,
    all_row_heights: &mut Vec<HashMap<u32, f64>>,
) -> (usize, identity::SheetId) {
    // PAD-BEFORE-PUSH: a state seeded by a test, a legacy file, or a partial
    // restore can hold per-sheet vectors SHORTER than the sheet list. A blind
    // `push` onto a short vector lands the new sheet's entry on the wrong
    // index — for `sheet_visibility` that would mark a DIFFERENT sheet as
    // object-backed. Pad every vector to one-entry-per-existing-sheet first,
    // with the same defaults `build_sheet_list` assumes for missing entries.
    let existing = sheet_names.len();
    ensure_vec_len_with(grids, existing, engine::grid::Grid::new);
    ensure_vec_len(freeze_configs, existing);
    ensure_tab_color_len(tab_colors, existing);
    ensure_visibility_len(sheet_visibility, existing);
    ensure_vec_len(all_column_widths, existing);
    ensure_vec_len(all_row_heights, existing);

    sheet_names.push(name);
    grids.push(engine::grid::Grid::new());
    freeze_configs.push(FreezeConfig::default());
    {
        let mut split_configs = state.split_configs.write(effect).unwrap();
        ensure_vec_len(&mut split_configs, existing);
        split_configs.push(SplitConfig::default());
    }
    {
        let mut scroll_areas = state.scroll_areas.lock().unwrap();
        ensure_vec_len(&mut scroll_areas, existing);
        scroll_areas.push(None);
    }
    {
        let mut sheet_zooms = state.sheet_zooms.write(effect).unwrap();
        ensure_vec_len_with(&mut sheet_zooms, existing, || {
            persistence::DEFAULT_SHEET_ZOOM_PERCENT
        });
        sheet_zooms.push(persistence::DEFAULT_SHEET_ZOOM_PERCENT);
    }
    {
        // Keep page_setups parallel to the sheet list — open_file
        // materializes a default for every sheet, so a missing entry here
        // shows up as a save/reload digest diff.
        let mut page_setups = state.page_setups.write(effect).unwrap();
        ensure_vec_len(&mut page_setups, existing);
        page_setups.push(crate::api_types::PageSetup::default());
    }
    let sheet_id = identity::SheetId::from_bytes(identity::generate_uuid_v7());
    {
        let mut sheet_ids = state.sheet_ids.write(effect).unwrap();
        ensure_vec_len_with(&mut sheet_ids, existing, || {
            identity::SheetId::from_bytes(identity::generate_uuid_v7())
        });
        sheet_ids.push(sheet_id);
    }
    tab_colors.push(String::new());
    sheet_visibility.push(visibility.to_string());
    // A worksheet shows gridlines and headings by default. A CANVAS shows
    // neither: the frontend already skips its cell passes by kind, but the
    // flags are set too so every consumer that reads only the flags (print,
    // the AI context, xlsx export) sees the right defaults for a canvas.
    let is_canvas = kind.is_canvas();
    {
        let mut gridlines = state.show_gridlines.write(effect).unwrap();
        ensure_vec_len_with(&mut gridlines, existing, || true);
        gridlines.push(!is_canvas);
    }
    {
        let mut display_flags = state.sheet_display_flags.write(effect).unwrap();
        ensure_vec_len(&mut display_flags, existing);
        let mut flags = crate::api_types::SheetDisplayFlags::default();
        if is_canvas {
            flags.display_headings = false;
        }
        display_flags.push(flags);
    }
    {
        let mut sheet_kinds = state.sheet_kinds.write(effect).unwrap();
        ensure_vec_len(&mut sheet_kinds, existing);
        sheet_kinds.push(kind);
    }
    // New sheet gets empty dimensions and merged regions
    all_column_widths.push(HashMap::new());
    all_row_heights.push(HashMap::new());
    crate::commands::dimensions::push_user_hidden_sheet(state, effect);
    {
        let mut all_merged = state.all_merged_regions.write(effect).unwrap();
        ensure_vec_len(&mut all_merged, existing);
        all_merged.push(HashSet::new());
    }
    (sheet_names.len() - 1, sheet_id)
}

/// Parse a sheet kind from its wire name. `None` and `"worksheet"` are a
/// worksheet; `"canvas"` is a canvas with the default layout. Anything else is
/// refused by name, so a typo from a script or an MCP client cannot silently
/// create a worksheet the caller did not ask for.
pub(crate) fn parse_sheet_kind(kind: Option<&str>) -> Result<::persistence::SheetKind, String> {
    match kind.map(str::trim) {
        None | Some("") | Some("worksheet") => Ok(::persistence::SheetKind::Worksheet),
        Some("canvas") => Ok(::persistence::SheetKind::new_canvas()),
        Some(other) => Err(format!(
            "Unknown sheet kind '{}'. Use 'worksheet' or 'canvas'.",
            other
        )),
    }
}

/// Is sheet `index` a CANVAS? A missing slot reads as a worksheet, the padding
/// default, exactly as `build_sheet_list` reads it.
pub(crate) fn is_canvas_sheet(sheet_kinds: &[::persistence::SheetKind], index: usize) -> bool {
    sheet_kinds.get(index).is_some_and(|k| k.is_canvas())
}

/// The standard refusal for a CELL writer aimed at a canvas sheet: a canvas
/// shows no cells, so a value written into its (hidden) grid would be
/// invisible and undeletable from the UI. The sibling of `ensure_user_sheet`;
/// the message names the canvas so the log can act on it. `action` reads as a
/// verb phrase ("edit cells", "paste", "create a table").
pub(crate) fn ensure_not_canvas(
    sheet_kinds: &[::persistence::SheetKind],
    index: usize,
    action: &str,
) -> Result<(), String> {
    if is_canvas_sheet(sheet_kinds, index) {
        Err(format!(
            "Cannot {} on sheet {}: it is a canvas sheet, which holds objects only. \
             Put the data on a worksheet and reference it from the canvas.",
            action, index
        ))
    } else {
        Ok(())
    }
}

/// `ensure_not_canvas` reading the kinds from state. Takes ONLY the
/// `sheet_kinds` read lock and releases it before returning, so a caller may
/// run it before its own locks without adding an edge to the lock order.
pub(crate) fn ensure_not_canvas_in_state(
    state: &AppState,
    index: usize,
    action: &str,
) -> Result<(), String> {
    let kinds = state.sheet_kinds.read().unwrap();
    ensure_not_canvas(&kinds, index, action)
}

#[tauri::command]
pub fn add_sheet(
    state: State<AppState>,
    file_state: State<FileState>,
    name: Option<String>,
    kind: Option<String>,
) -> Result<SheetsResult, String> {
    let kind = parse_sheet_kind(kind.as_deref())?;
    add_sheet_inner(&state, &file_state, name, kind)
}

/// Command body over plain references, so the partition-keeping branch has a
/// unit tier (`State<T>` cannot be built in a test). Same split as
/// `hide_sheet_inner` below.
///
/// `kind` is fixed for the sheet's whole life: there is no worksheet <->
/// canvas conversion, so the kind needs no undo arm (adding a sheet already
/// ends the undo history, below).
pub(crate) fn add_sheet_inner(
    state: &AppState,
    file_state: &FileState,
    name: Option<String>,
    kind: ::persistence::SheetKind,
) -> Result<SheetsResult, String> {
    let name = match name {
        Some(requested) => NewSheetName::Exact(requested),
        None => NewSheetName::Default,
    };
    let added = append_user_sheet(
        state,
        file_state,
        NewUserSheet { name, kind, cells: None, activate: true },
        "add a sheet",
    )?;

    // EXCEL PARITY: adding a sheet ends the undo history (BUG-0005). Runs with
    // every lock above released — see the function for the order that requires.
    invalidate_undo_history_for_sheet_structure(&state, "add a sheet");

    // The new (empty) sheet is now active — rebuild the single-sheet
    // dependency maps for it (see set_active_sheet / BUG-0016).
    crate::undo_commands::rebuild_all_dependencies(&state);

    Ok(added.result)
}

/// What a sheet added through [`append_user_sheet`] is called.
pub(crate) enum NewSheetName {
    /// A name the CALLER chose. It goes through Excel's rule
    /// (`validate_sheet_name`) before the document is touched, and is refused
    /// when another sheet already has it, ignoring case.
    Exact(String),
    /// `base`, else `base2`, `base3`, ... -- the first one no sheet has,
    /// ignoring case. For a sheet a command names itself (a drill-through's
    /// detail rows), where there is nobody to refuse. `base` must itself be a
    /// legal sheet name.
    FirstFree(String),
    /// `Sheet{n}`: `add_sheet`'s default.
    Default,
}

/// One user sheet for [`append_user_sheet`] to add.
pub(crate) struct NewUserSheet {
    pub name: NewSheetName,
    pub kind: ::persistence::SheetKind,
    /// The cells it starts with -- a drill-through's detail rows, a report
    /// filter page. `None` is an empty sheet.
    pub cells: Option<engine::grid::Grid>,
    /// Switch to it (`add_sheet`, a drill-through), or leave the user on the
    /// sheet they are looking at (Show Report Filter Pages).
    pub activate: bool,
}

/// What [`append_user_sheet`] added.
pub(crate) struct AppendedUserSheet {
    /// Where it landed: the end of the USER prefix, which is not the end of
    /// the sheet list once a floating range's object sheet exists.
    pub index: usize,
    pub name: String,
    pub result: SheetsResult,
}

/// THE ONE PATH BY WHICH A COMMAND ADDS A USER SHEET.
///
/// `add_sheet`, a pivot's drill-through and Show Report Filter Pages all come
/// through here. The last two used to push only `sheet_names` and `grids`
/// (fix round 4, B4), and a sheet made that way had no id, kind, visibility,
/// freeze, zoom, page setup, gridline or row/column-size entry -- every
/// per-sheet store fell one short of the sheet list, so the next sheet added
/// paired each store with its neighbour's value. A drill-through also switched
/// to its sheet without stashing the one it left, so a column width set there
/// was lost; both appended BEHIND a floating range's object sheet, breaking
/// the "user sheets first" partition the sheet list and every 3D reference
/// rely on; and a protected workbook structure stopped neither.
///
/// In order: the workbook-structure gate, Excel's rule for a caller's name,
/// the name's uniqueness under the held sheet locks -- every refusal BEFORE
/// the `DocumentEffect`, so a refused add leaves the document clean -- then
/// every per-sheet store through `append_sheet_stores`, the partition
/// rotation, the cells, and (when `activate`) the stash of the sheet being
/// left and the switch. Lock order is the crate's canonical one: `grid`,
/// `grids`, `sheet_names`, then everything else.
///
/// Returns with every lock released, and ends NOTHING: the caller ends the
/// undo history (`invalidate_undo_history_for_sheet_structure`, Excel parity,
/// BUG-0005) and, when it activated the sheet, rebuilds the dependency maps
/// for it -- `add_sheet_inner` above is the worked example.
pub(crate) fn append_user_sheet(
    state: &AppState,
    file_state: &FileState,
    sheet: NewUserSheet,
    action: &str,
) -> Result<AppendedUserSheet, String> {
    crate::protection::check_workbook_structure(state, action)?;
    let NewUserSheet { name, kind, cells, activate } = sheet;
    // Excel's rule, checked BEFORE the document is marked modified: a refused
    // name must not dirty the workbook. The uniqueness half needs the sheet
    // list and is checked under the lock below -- still before the effect.
    let name = match name {
        NewSheetName::Exact(requested) => {
            NewSheetName::Exact(crate::sheet_names::validate_sheet_name(&requested)?)
        }
        other => other,
    };

    let appended = {
    // CANONICAL LOCK ORDER: `grid`, then `grids`, then everything else --
    // including `sheet_names`. The recalculation pass takes `sheet_names` only
    // AFTER both grid locks and runs on a background thread, so holding it here
    // and then waiting for a grid lock closes a cycle that hangs the app.
    // PENDING until the name is known to be free: the duplicate refusal below
    // must leave the document clean.
    let current_grid = state.grid.lock_pending().unwrap();
    let grids = state.grids.lock_pending().unwrap();
    let sheet_names = state.sheet_names.lock_pending().unwrap();

    // The duplicate check is case-INSENSITIVE (`crate::sheet_names`) -- sheet
    // lookup is case-insensitive everywhere else, so `sheet1` beside `Sheet1`
    // was two sheets the rest of the crate believed were one.
    let is_free = |candidate: &str| {
        crate::sheet_names::ensure_sheet_name_is_free(candidate, &sheet_names, None).is_ok()
    };
    let new_name = match name {
        NewSheetName::Exact(requested) => {
            crate::sheet_names::ensure_sheet_name_is_free(&requested, &sheet_names, None)?;
            requested
        }
        NewSheetName::FirstFree(base) => {
            let mut counter = 1usize;
            loop {
                let candidate = if counter == 1 {
                    base.clone()
                } else {
                    format!("{}{}", base, counter)
                };
                if is_free(&candidate) {
                    break candidate;
                }
                counter += 1;
            }
        }
        NewSheetName::Default => {
            let mut counter = sheet_names.len() + 1;
            loop {
                let candidate = format!("Sheet{}", counter);
                if is_free(&candidate) {
                    break candidate;
                }
                counter += 1;
            }
        }
    };

    // Past every gate. Adding a sheet appends to every per-sheet persisted vector.
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    let mut current_grid = current_grid.authorize(&effect);
    let mut grids = grids.authorize(&effect);
    let mut sheet_names = sheet_names.authorize(&effect);
    let mut active_sheet = state.active_sheet.write(&effect).unwrap();
    let mut freeze_configs = state.freeze_configs.write(&effect).unwrap();
    let mut tab_colors = state.tab_colors.write(&effect).unwrap();
    let mut sheet_visibility = state.sheet_visibility.write(&effect).unwrap();
    let mut column_widths = state.column_widths.write(&effect).unwrap();
    let mut row_heights = state.row_heights.write(&effect).unwrap();
    let mut all_column_widths = state.all_column_widths.write(&effect).unwrap();
    let mut all_row_heights = state.all_row_heights.write(&effect).unwrap();

    let old_index = *active_sheet;

    // Stash the ACTIVE sheet's view state before switching to the new one —
    // this is activation bookkeeping, deliberately outside `append_sheet_stores`
    // (an appended object sheet is never activated, so it must not stash; nor
    // does a sheet added without switching to it).
    if activate {
        if old_index < grids.len() {
            grids[old_index] = current_grid.clone();
        }

        // Save current sheet's dimensions before switching
        while all_column_widths.len() <= old_index {
            all_column_widths.push(HashMap::new());
        }
        while all_row_heights.len() <= old_index {
            all_row_heights.push(HashMap::new());
        }
        all_column_widths[old_index] = std::mem::take(&mut *column_widths);
        all_row_heights[old_index] = std::mem::take(&mut *row_heights);

        crate::commands::dimensions::stash_active_user_hidden(&state, old_index);
        {
            let mut all_merged = state.all_merged_regions.write(&effect).unwrap();
            // Save current sheet's merged regions before switching
            let mut current_merged = state.merged_regions.write(&effect).unwrap();
            while all_merged.len() <= old_index {
                all_merged.push(HashSet::new());
            }
            all_merged[old_index] = std::mem::take(&mut *current_merged);
        }
    }

    let (appended_at, _sheet_id) = append_sheet_stores(
        &state,
        &effect,
        new_name.clone(),
        "visible",
        kind,
        &mut sheet_names,
        &mut grids,
        &mut freeze_configs,
        &mut tab_colors,
        &mut sheet_visibility,
        &mut all_column_widths,
        &mut all_row_heights,
    );

    // PARTITION INVARIANT: user sheets are a contiguous PREFIX; object-backed
    // sheets (floating range cell stores, `OBJECT_SHEET_VISIBILITY`) stay at
    // the tail. This is what keeps two whole surface families correct with no
    // filtering at all: (1) `MultiSheetContext.sheet_order` is `sheet_names`
    // verbatim, so a 3D range with user-sheet endpoints can never span a
    // backing sheet; (2) `build_sheet_list`'s filtered output has
    // `sheets[i].index == i` for every user sheet, so no positional consumer
    // anywhere in the frontend can drift. The invariant has exactly one
    // maintenance site — this branch — because every other mutation preserves
    // it: `copy_sheet` inserts at `source+1` with a user-sheet source,
    // `move_sheet` refuses object endpoints, deletion preserves order, and
    // `create_floating_range` appends to the tail.
    let new_index = match sheet_visibility[..appended_at]
        .iter()
        .position(|v| v == OBJECT_SHEET_VISIBILITY)
    {
        None => appended_at,
        Some(k) => {
            // Rotate the just-appended user sheet from the tail into `k`; the
            // object sheets in [k..appended_at) shift up by one.
            rotate_element(&mut *sheet_names, appended_at, k);
            rotate_element(&mut *grids, appended_at, k);
            rotate_element(&mut *freeze_configs, appended_at, k);
            rotate_element(&mut *tab_colors, appended_at, k);
            rotate_element(&mut *sheet_visibility, appended_at, k);
            rotate_element(&mut *all_column_widths, appended_at, k);
            rotate_element(&mut *all_row_heights, appended_at, k);
            {
                let mut split_configs = state.split_configs.write(&effect).unwrap();
                rotate_element(&mut *split_configs, appended_at, k);
            }
            {
                let mut scroll_areas = state.scroll_areas.lock().unwrap();
                rotate_element(&mut *scroll_areas, appended_at, k);
            }
            {
                let mut sheet_zooms = state.sheet_zooms.write(&effect).unwrap();
                rotate_element(&mut *sheet_zooms, appended_at, k);
            }
            {
                let mut page_setups = state.page_setups.write(&effect).unwrap();
                rotate_element(&mut *page_setups, appended_at, k);
            }
            {
                let mut sheet_ids = state.sheet_ids.write(&effect).unwrap();
                rotate_element(&mut *sheet_ids, appended_at, k);
            }
            {
                let mut gridlines = state.show_gridlines.write(&effect).unwrap();
                rotate_element(&mut *gridlines, appended_at, k);
            }
            {
                let mut display_flags = state.sheet_display_flags.write(&effect).unwrap();
                rotate_element(&mut *display_flags, appended_at, k);
            }
            {
                let mut sheet_kinds = state.sheet_kinds.write(&effect).unwrap();
                rotate_element(&mut *sheet_kinds, appended_at, k);
            }
            {
                let mut all_merged = state.all_merged_regions.write(&effect).unwrap();
                rotate_element(&mut *all_merged, appended_at, k);
            }
            crate::commands::dimensions::rotate_user_hidden_sheet(
                &state,
                &effect,
                appended_at,
                k,
                appended_at + 1,
            );

            // Re-key the sheet-index-keyed stores for the shifted object
            // sheets. The new sheet (old index `appended_at`) has no entries
            // anywhere yet, so the mapping only ever moves object-sheet
            // entries — their cross-sheet dependency edges and spill maps in
            // particular. The floating-object stores (slicers, charts,
            // sparklines: `cascade_sheet_removed`), reports and protected
            // regions are NOT re-keyed here on an argued exception: those
            // objects live on user sheets only (they are created on the
            // active sheet, and an object-backed sheet can never be active),
            // and no user sheet changes index in this rotation.
            let shift = |i: usize| -> Option<usize> {
                if i >= k && i < appended_at {
                    Some(i + 1)
                } else {
                    Some(i)
                }
            };
            remap_sheet_keyed_stores(&state, &effect, shift);
            remap_tables_store(&state, &effect, shift);
            k
        }
    };

    // The cells, at the sheet's FINAL index (after the rotation). An active
    // sheet is a USER sheet, so it sits before `k` and the rotation never
    // moved it: `*active_sheet` still names the sheet the user is on.
    let cells = cells.unwrap_or_else(engine::grid::Grid::new);
    if activate {
        grids[new_index] = cells.clone();
        *active_sheet = new_index;
        *current_grid = cells;
    } else {
        grids[new_index] = cells;
    }

    AppendedUserSheet {
        index: new_index,
        name: new_name,
        result: SheetsResult {
            sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &sheet_visibility, &state.sheet_ids.read().unwrap(), &state.sheet_kinds.read().unwrap()),
            active_index: *active_sheet,
        },
    }
    }; // every lock above released here

    Ok(appended)
}

#[tauri::command]
pub fn delete_sheet(
    app: tauri::AppHandle,
    state: State<AppState>,
    file_state: State<FileState>,
    pivot_state: State<'_, PivotState>,
    // Injected by Tauri; needed only for the recalculation at the end, which
    // deleting a sheet owes because it turns formulas into `#REF!`.
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    slicer_state: State<'_, crate::slicer::SlicerState>,
    timeline_state: State<'_, crate::timeline_slicer::TimelineSlicerState>,
    index: usize,
) -> Result<SheetsResult, String> {
    // OWNER DECISION 3 for the slicers that go WITH the sheet: deleting ANY
    // slicer removes its filter, and a sheet delete deletes every slicer on
    // it. Before this only `delete_slicer` cleared -- a pivot slicer on a
    // dashboard sheet driving a BI pivot on another sheet left its mask
    // behind when the dashboard was deleted: no slicer, nothing on screen
    // showing the filter, saved with the pivot, and (a sheet delete ends the
    // undo history) no Ctrl+Z out of it. The targets are resolved BEFORE the
    // delete (the indices still mean what they meant) and cleared AFTER it,
    // with every lock released. The floating-range path calls
    // `delete_sheet_impl` directly: an object sheet hosts no slicers.
    let doomed = crate::slicer::commands::filter_targets_of_slicers_on_sheet(
        &state,
        &pivot_state,
        &slicer_state,
        index,
    );
    let result = delete_sheet_impl(
        &state,
        &file_state,
        &pivot_state,
        &user_files_state,
        &pane_control_state,
        &ribbon_filter_state,
        &slicer_state,
        &timeline_state,
        index,
        false,
    )?;
    let requery = crate::slicer::commands::clear_filters_of_deleted_slicers(
        &state,
        &file_state,
        &pivot_state,
        crate::pivot::operations::PivotRecalcStates {
            pane: &pane_control_state,
            ribbon: &ribbon_filter_state,
            user_files: &user_files_state,
        },
        &doomed,
    );
    // A removed slicer's PIN lived inside a BI pivot's query: that pivot's
    // records were fetched with it, so they must be fetched again. This
    // command runs on the main thread and cannot await the engine; the
    // re-query runs in the background and repaints when it lands.
    crate::pivot::commands::spawn_quiet_bi_requery(app, requery);
    Ok(result)
}

/// Command body over plain references, with the ONE parameterized gate:
/// `delete_floating_range` removes its OBJECT-backed sheet through this exact
/// machinery — the repairable pre-flight, the store removals, the `#REF!`
/// repair, the cross-map re-keying, the workbook recalculation — because a
/// backing sheet IS a sheet and a second copy of this walk would drift. Every
/// other caller passes `allow_object = false` and object sheets are refused.
#[allow(clippy::too_many_arguments)]
pub(crate) fn delete_sheet_impl(
    state: &AppState,
    file_state: &FileState,
    pivot_state: &PivotState,
    user_files_state: &crate::persistence::UserFilesState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    slicer_state: &crate::slicer::SlicerState,
    timeline_state: &crate::timeline_slicer::TimelineSlicerState,
    index: usize,
    allow_object: bool,
) -> Result<SheetsResult, String> {
    crate::protection::check_workbook_structure(state, "delete a sheet")?;

    // MAY this sheet be deleted, before "can the workbook survive it".
    //
    // A subscribed sheet is somebody else's content, still tracked and still
    // refreshed; deleting it silently would leave the subscription pointing at a
    // sheet that no longer exists. `detach` is the deliberate way to make it
    // yours, and the message says so.
    //
    // POSITION IS LOAD-BEARING, and it is why this does not sit beside
    // `ensure_user_sheet` further down even though the two read alike:
    // `DocumentEffect::mutates` dirties the document AT CONSTRUCTION, and that
    // construction is below. `ensure_user_sheet` therefore already dirties the
    // file on a refusal — a pre-existing wart this guard must not copy, because
    // unlike an object sheet (unreachable from any UI, so hitting it is a
    // programming error) a subscribed sheet is a real tab a user right-clicked,
    // and a refusal they can act on must not leave the file modified.
    //
    // It also runs before the repairability walk, which parses every formula on
    // every sheet: refusing for a formula reason a sheet that may not be deleted
    // at all is both wasteful and confusing.
    {
        let provenance = SheetProvenance::snapshot(state)?;
        ensure_unsubscribed_sheet(&provenance, index, "delete")?;
    }

    // PRE-FLIGHT, under READ locks, before the document is marked dirty and
    // before a single store is touched.
    //
    // The repair itself runs far below, after this command has already removed
    // the sheet from a dozen index-aligned stores; by then there is nothing to
    // refuse INTO. So the question "does every formula in this workbook survive
    // the delete" is asked here, while the workbook is still whole, and a
    // formula whose repaired text cannot be read back stops the delete instead
    // of being quietly emptied (register §3bc — Excel refuses the operation
    // rather than corrupting the file). The cost is parsing the repaired text
    // twice on a command that already walks every formula on every sheet.
    {
        // CANONICAL LOCK ORDER: both grid locks first, then `sheet_names`.
        let current_grid = state.grid.read().map_err(|e| e.to_string())?;
        let grids = state.grids.read().map_err(|e| e.to_string())?;
        let sheet_names = state.sheet_names.read().map_err(|e| e.to_string())?;
        let active = *state.active_sheet.read().map_err(|e| e.to_string())?;
        if index < sheet_names.len() && sheet_names.len() > 1 {
            let deleted_name = sheet_names[index].clone();
            let names_after: Vec<String> = sheet_names
                .iter()
                .enumerate()
                .filter(|(i, _)| *i != index)
                .map(|(_, n)| n.clone())
                .collect();
            let repair = |formula: &str| {
                crate::repair_3d_refs_on_delete_at(formula, &deleted_name, index, &names_after)
            };
            if let Err(refusal) =
                check_workbook_repairable(&grids, &current_grid, active, Some(index), &repair)
            {
                crate::log_error!("SHEET", "delete_sheet refused: {}", refusal);
                return Err(refusal.message(
                    &format!("delete sheet '{}'", deleted_name),
                    &sheet_names,
                ));
            }
        }
    }

    // Deleting a sheet rewrites persisted per-sheet stores.
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    // Tables and pivots removed BECAUSE their sheet went, collected inside the
    // guarded block and cascaded after every lock is released (§3bn): objects on
    // OTHER sheets can be bound to them.
    let mut removed_sources: Vec<crate::object_deps::DeletedSource> = Vec::new();
    // The deleted sheet's stable id, captured inside the guarded block (the
    // vector entry is removed further down) and consumed after every lock is
    // released: floating ranges HOSTED on this sheet die with it. Deferred
    // init — every path that reaches the consumer passed the assignment.
    let deleted_sheet_stable_id: Option<identity::SheetId>;
    // The deleted sheet's NAME and the tab order without it, for the rule
    // stores and the override layer repaired after the guarded block
    // (W10/W11). Deferred init, like the id.
    let deleted_sheet_name: String;
    let deleted_sheet_names_after: Vec<String>;
    let result = {
    // CANONICAL LOCK ORDER: `grid`, then `grids`, then everything else --
    // including `sheet_names`. The recalculation pass takes `sheet_names` only
    // AFTER both grid locks and runs on a background thread, so holding it here
    // and then waiting for a grid lock closes a cycle that hangs the app.
    let mut current_grid = state.grid.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    let mut sheet_names = state.sheet_names.write(&effect).unwrap();
    let mut active_sheet = state.active_sheet.write(&effect).unwrap();
    let mut freeze_configs = state.freeze_configs.write(&effect).unwrap();
    let mut tab_colors = state.tab_colors.write(&effect).unwrap();
    let mut sheet_visibility = state.sheet_visibility.write(&effect).unwrap();
    let mut tables = state.tables.write(&effect).unwrap();
    let mut table_names = state.table_names.write(&effect).unwrap();
    let mut column_widths = state.column_widths.write(&effect).unwrap();
    let mut row_heights = state.row_heights.write(&effect).unwrap();
    let mut all_column_widths = state.all_column_widths.write(&effect).unwrap();
    let mut all_row_heights = state.all_row_heights.write(&effect).unwrap();

    if sheet_names.len() <= 1 {
        return Err("Cannot delete the last sheet".to_string());
    }

    if index >= sheet_names.len() {
        return Err(format!("Sheet index {} out of range", index));
    }

    // A floating range's backing sheet is deleted by `delete_floating_range`,
    // which also removes the object row and knows what the delete owes the
    // workbook. Reaching it through the sheet command would leave the object
    // row behind, pointing at nothing.
    if !allow_object {
        ensure_user_sheet(&sheet_visibility, index, "delete")?;
    }

    // EXCEL PARITY: a workbook must keep at least one VISIBLE worksheet, and
    // "at least one sheet" is not the same test (BUG-0046's family). Hide
    // Sheet1, delete Sheet2, and the guard above is satisfied while the
    // workbook is left with a single HIDDEN sheet — no tab to click, and an
    // active index naming a sheet the user cannot be looking at. `hide_sheet`
    // has always refused the mirror image of this ("Cannot hide the last
    // visible sheet"); the delete side never asked.
    //
    // A short `sheet_visibility` counts as visible, exactly as
    // `build_sheet_list` reads it.
    if visible_sheets_after_removing(&sheet_visibility, sheet_names.len(), index) == 0 {
        return Err("Cannot delete the last visible sheet".to_string());
    }

    let old_active = *active_sheet;
    let deleted_name = sheet_names[index].clone();
    deleted_sheet_name = deleted_name.clone();

    if old_active < grids.len() {
        grids[old_active] = current_grid.clone();
    }

    // Save current dimensions to per-sheet storage before deletion
    while all_column_widths.len() <= old_active {
        all_column_widths.push(HashMap::new());
    }
    while all_row_heights.len() <= old_active {
        all_row_heights.push(HashMap::new());
    }
    all_column_widths[old_active] = std::mem::take(&mut *column_widths);
    all_row_heights[old_active] = std::mem::take(&mut *row_heights);

    // Remove tables on the deleted sheet and update name registry.
    // The ids are KEPT (§3bn): slicers on OTHER sheets can be bound to a table
    // that lived here, and a table removed as a side effect of a sheet delete
    // orphans them exactly as `delete_table` did.
    if let Some(sheet_tables) = tables.remove(&index) {
        for table in sheet_tables.values() {
            table_names.remove(&table.name.to_uppercase());
            removed_sources.push(crate::object_deps::DeletedSource::table(table.id));
        }
    }

    // Drop author-side writeback DRAFT regions on the deleted sheet, same rule
    // as tables and pivots above. `RegionSelector.sheet_id` is a stable SheetId,
    // so these would otherwise survive as a configured collection surface
    // pointing at a sheet that no longer exists — and publish a selector for it.
    // (Read before the sheet_ids entry is removed further down.)
    {
        let deleted_sheet_id = state.sheet_ids.read().ok().and_then(|ids| ids.get(index).copied());
        deleted_sheet_stable_id = deleted_sheet_id;
        if let Some(sid) = deleted_sheet_id {
            if let Ok(mut regions) = state.writeback_draft_regions.write(&effect) {
                let before = regions.len();
                regions.retain(|r| r.selector.sheet_id != sid);
                let dropped = before - regions.len();
                if dropped > 0 {
                    crate::log_warn!(
                        "CALP",
                        "Deleting sheet '{}' removed {} writeback draft region(s) on it",
                        deleted_name,
                        dropped
                    );
                }
            }
        }
    }

    // Remove pivot tables whose destination is the deleted sheet
    {
        let mut pivot_tables = pivot_state.pivot_tables.write(&effect).unwrap();
        let pivots_to_delete: Vec<PivotId> = pivot_tables
            .iter()
            .filter(|(_, (def, _))| {
                def.destination_sheet.as_deref() == Some(deleted_name.as_str())
            })
            .map(|(&id, _)| id)
            .collect();

        for pivot_id in &pivots_to_delete {
            pivot_tables.remove(pivot_id);
            removed_sources.push(crate::object_deps::DeletedSource::pivot(*pivot_id));
        }
        drop(pivot_tables);

        // Clean up associated pivot state
        if !pivots_to_delete.is_empty() {
            let mut views = pivot_state.views.lock().unwrap();
            let mut bi_metadata = pivot_state.bi_metadata.write(&effect).unwrap();
            let mut cancellation_tokens = pivot_state.cancellation_tokens.lock().unwrap();
            let mut previous_states = pivot_state.previous_states.lock().unwrap();
            let mut active = pivot_state.active_pivot_id.lock().unwrap();

            for pivot_id in &pivots_to_delete {
                views.remove(pivot_id);
                bi_metadata.remove(pivot_id);
                cancellation_tokens.remove(pivot_id);
                previous_states.remove(pivot_id);
                if *active == Some(*pivot_id) {
                    *active = None;
                }
            }
        }

        // Remove protected regions for deleted pivots and shift sheet indices
        let mut regions = state.protected_regions.lock().unwrap();
        regions.retain(|r| {
            if r.sheet_index == index {
                // Remove all protected regions on the deleted sheet
                return false;
            }
            true
        });
        // Shift sheet indices for regions on sheets above the deleted one
        for r in regions.iter_mut() {
            if r.sheet_index > index {
                r.sheet_index -= 1;
            }
        }
    }

    // Reports: drop definitions on the deleted sheet and shift the indices of
    // those above it (their regions were handled by the generic cleanup above).
    // Without this, the next refresh would materialize a deleted-sheet report
    // onto whichever sheet inherited its index.
    crate::report::remap_report_sheets(&state, &effect, |i| {
        if i == index {
            None
        } else if i > index {
            Some(i - 1)
        } else {
            Some(i)
        }
    });

    // The sheet-index-keyed HashMap stores (comments, scenarios, outlines,
    // conditional formats, data validations, cell types, on-grid controls,
    // advanced-filter hidden rows, spill tracking) are not index-aligned
    // Vecs: drop the deleted sheet's entries and shift the indices above it
    // down by one, exactly like the report/table remaps around this. Comment
    // and Scenario payloads carry a sheet_index field too — re-stamped inside.
    remap_sheet_keyed_stores(&state, &effect, |i| {
        if i == index {
            None
        } else if i > index {
            Some(i - 1)
        } else {
            Some(i)
        }
    });

    // §3bn — THE FLOATING OBJECT STORES, which `remap_sheet_keyed_stores` does
    // NOT cover because they are not keyed by sheet: slicers, timeline slicers,
    // charts and sparklines each carry a `sheet_index` FIELD, and none of them
    // was ever touched by a sheet operation. Two defects at once: an object on
    // the deleted sheet survived invisibly, and every object ABOVE it kept an
    // index that now names a DIFFERENT sheet — so a chart authored on Sheet3
    // started painting on Sheet2 and a click there edited it. Ribbon filters in
    // bySheet mode resolve their targets from `connectedSheets`, so those
    // indices move with everything else.
    let sheet_cascade = crate::object_deps::cascade_sheet_removed(
        &state,
        &slicer_state,
        &timeline_state,
        &ribbon_filter_state,
        &effect,
        &|i| {
            if i == index {
                None
            } else if i > index {
                Some(i - 1)
            } else {
                Some(i)
            }
        },
    );
    if !sheet_cascade.is_empty() {
        crate::log_info!(
            "SHEET",
            "delete_sheet '{}' removed {} slicer(s), {} timeline(s), {} chart(s) on it",
            deleted_name,
            sheet_cascade.deleted_slicers.len(),
            sheet_cascade.deleted_timelines.len(),
            sheet_cascade.deleted_charts.len()
        );
    }

    // A CASCADE THAT DELETES AN OBJECT MUST RUN THAT OBJECT'S OWN CASCADE.
    //
    // Found by the transitive domain walk added in §3cd, not by anybody reading
    // this function: `delete_chart` prunes the pane-control slider bound to the
    // chart (`chart -> paneControl.config.chartParamTarget.chartId`), and the
    // charts deleted a few lines above went out through a completely different
    // path that had never run it. So deleting the SHEET a chart lived on left
    // every slider still claiming to drive it -- the §3bn orphan exactly, on a
    // path §3bt did not reach, because the census asked "does delete_chart run
    // this?" and never "does anything ELSE that deletes a chart run it?".
    //
    // Object scripts go the same way and for the reason C10 gives: the
    // instanceId IS the object id, so a script that outlives its chart is
    // inherited by whatever is next minted at that id.
    if !sheet_cascade.deleted_charts.is_empty() {
        let dead_chart_ids: Vec<identity::EntityId> = sheet_cascade
            .deleted_charts
            .iter()
            .map(|chart| chart.id)
            .collect();
        crate::object_deps::cascade_deleted_charts(&pane_control_state, &dead_chart_ids);
        for id in &dead_chart_ids {
            crate::scripting::object_script_commands::prune_scripts_for_instance(
                &state,
                &effect,
                &id.to_string(),
            );
        }
    }

    // Re-key tables for sheets above the deleted index (shift down by 1)
    let keys_to_shift: Vec<usize> = tables.keys().filter(|&&k| k > index).cloned().collect();
    for old_key in keys_to_shift {
        if let Some(sheet_tables) = tables.remove(&old_key) {
            let new_key = old_key - 1;
            for table in sheet_tables.values() {
                if let Some(entry) = table_names.get_mut(&table.name.to_uppercase()) {
                    entry.0 = new_key;
                }
            }
            let mut updated_tables = sheet_tables;
            for table in updated_tables.values_mut() {
                table.sheet_index = new_key;
            }
            tables.insert(new_key, updated_tables);
        }
    }

    sheet_names.remove(index);
    if index < grids.len() {
        grids.remove(index);
    }
    {
        let mut sheet_ids = state.sheet_ids.write(&effect).unwrap();
        if index < sheet_ids.len() {
            sheet_ids.remove(index);
        }
    }

    // Repair 3D reference bookends AND plain cross-sheet references in all
    // formulas. A reference to the deleted sheet becomes #REF!.
    let names_after = sheet_names.clone();
    deleted_sheet_names_after = names_after.clone();
    // UNREACHABLE BY CONSTRUCTION: the pre-flight at the top of this command ran
    // the identical closure over the identical formulas and nothing between
    // there and here rewrites a cell. If it ever does fire, the repair wrote
    // NOTHING (it is all-or-nothing), so no formula has been corrupted — the
    // workbook is left with the sheet removed and a refusal the log names.
    if let Err(refusal) = crate::repair_all_formulas(&mut grids, &|formula| {
        crate::repair_3d_refs_on_delete_at(formula, &deleted_name, index, &names_after)
    }) {
        crate::log_error!(
            "SHEET",
            "delete_sheet repair failed AFTER its pre-flight passed: {}",
            refusal
        );
        return Err(refusal.message(&format!("delete sheet '{}'", deleted_name), &sheet_names));
    }
    // Defined names hold their target as formula TEXT and go through the same
    // repair; one whose sheet just vanished becomes `=#REF!`.
    repair_named_ranges(&state, &effect, &|refers_to| {
        crate::repair_3d_refs_on_delete_at(refers_to, &deleted_name, index, &names_after)
    });
    if index < freeze_configs.len() {
        freeze_configs.remove(index);
    }
    {
        let mut split_configs = state.split_configs.write(&effect).unwrap();
        if index < split_configs.len() {
            split_configs.remove(index);
        }
    }
    {
        let mut scroll_areas = state.scroll_areas.lock().unwrap();
        if index < scroll_areas.len() {
            scroll_areas.remove(index);
        }
    }
    {
        let mut sheet_zooms = state.sheet_zooms.write(&effect).unwrap();
        if index < sheet_zooms.len() {
            sheet_zooms.remove(index);
        }
    }
    if index < tab_colors.len() {
        tab_colors.remove(index);
    }
    if index < sheet_visibility.len() {
        sheet_visibility.remove(index);
    }
    {
        let mut gridlines = state.show_gridlines.write(&effect).unwrap();
        if index < gridlines.len() {
            gridlines.remove(index);
        }
    }
    {
        let mut display_flags = state.sheet_display_flags.write(&effect).unwrap();
        if index < display_flags.len() {
            display_flags.remove(index);
        }
    }
    {
        let mut sheet_kinds = state.sheet_kinds.write(&effect).unwrap();
        if index < sheet_kinds.len() {
            sheet_kinds.remove(index);
        }
    }
    {
        // page_setups is parallel to the sheet list like every vector above.
        // It was once missed here, so every sheet after a deleted one saved
        // its NEIGHBOUR's page setup (the lifecycle guard now pins it).
        let mut page_setups = state.page_setups.write(&effect).unwrap();
        if index < page_setups.len() {
            page_setups.remove(index);
        }
    }
    if index < all_column_widths.len() {
        all_column_widths.remove(index);
    }
    if index < all_row_heights.len() {
        all_row_heights.remove(index);
    }
    crate::commands::dimensions::stash_active_user_hidden(&state, old_active);
    crate::commands::dimensions::remove_user_hidden_sheet(&state, &effect, index);
    {
        let mut all_merged = state.all_merged_regions.write(&effect).unwrap();
        // Save current merged regions before deleting
        let mut current_merged = state.merged_regions.write(&effect).unwrap();
        while all_merged.len() <= old_active {
            all_merged.push(HashSet::new());
        }
        all_merged[old_active] = std::mem::take(&mut *current_merged);
        if index < all_merged.len() {
            all_merged.remove(index);
        }
    }

    let new_active = if old_active >= sheet_names.len() {
        sheet_names.len() - 1
    } else if old_active > index {
        old_active - 1
    } else if old_active == index {
        if index < sheet_names.len() {
            index
        } else {
            sheet_names.len() - 1
        }
    } else {
        old_active
    };

    // ...AND THE SHEET IT LANDS ON MUST BE VISIBLE. The arithmetic above is
    // pure index bookkeeping, so deleting the sheet next to a hidden one leaves
    // the active index on the hidden one — a sheet with no tab, showing its
    // data under nobody's tab (BUG-0046's family; the refusal above guarantees
    // there is a visible sheet to find). `sheet_visibility` has already had the
    // deleted entry removed, so these indices are the post-delete ones.
    let new_active = nearest_visible_sheet(&sheet_visibility, sheet_names.len(), new_active);

    *active_sheet = new_active;

    if new_active < grids.len() {
        *current_grid = grids[new_active].clone();
    } else {
        *current_grid = engine::grid::Grid::new();
    }

    // Load new active sheet's dimensions
    if new_active < all_column_widths.len() {
        *column_widths = std::mem::take(&mut all_column_widths[new_active]);
    }
    if new_active < all_row_heights.len() {
        *row_heights = std::mem::take(&mut all_row_heights[new_active]);
    }
    crate::commands::dimensions::load_active_user_hidden(&state, new_active);
    // Load new active sheet's merged regions
    {
        let mut all_merged = state.all_merged_regions.write(&effect).unwrap();
        let mut current_merged = state.merged_regions.write(&effect).unwrap();
        if new_active < all_merged.len() {
            *current_merged = std::mem::take(&mut all_merged[new_active]);
        }
    }

    SheetsResult {
        sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &sheet_visibility, &state.sheet_ids.read().unwrap(), &state.sheet_kinds.read().unwrap()),
        active_index: *active_sheet,
    }
    }; // drop all locks before rebuilding dependency maps

    // THE RULE STORES AND THE OVERRIDE LAYER (wave C, W10/W11): references to
    // the deleted sheet are repaired there too, by the rule every cell formula
    // and defined name just went through (a 3D endpoint moves inward, anything
    // else becomes `#REF!`). Each store taken alone, with every sheet guard
    // above released.
    delete_rule_references(
        &state,
        &effect,
        &pane_control_state,
        &deleted_sheet_name,
        index,
        &deleted_sheet_names_after,
    );

    // §3bn — the SECOND half of the sheet cascade, and the one the sheet-index
    // walk above cannot do: a slicer on Sheet1 bound to a table that lived on
    // the sheet just deleted is still on a live sheet, so it survives the index
    // remap — pointing at an id that resolves to nothing. Deleting a table by
    // deleting its SHEET must leave the same world behind as deleting the table.
    // Runs here because every guard the block held is released.
    let source_cascade = crate::object_deps::cascade_deleted_sources(
        &state,
        &slicer_state,
        &timeline_state,
        &ribbon_filter_state,
        &effect,
        &removed_sources,
    );
    if !source_cascade.is_empty() {
        crate::log_info!(
            "SHEET",
            "delete_sheet cascaded through its objects: {}",
            source_cascade.describe()
        );
    }
    // No undo is recorded, deliberately: Excel does not let a sheet delete be
    // undone and neither does this command, so a cascade that recorded restores
    // would put slicers back onto a sheet that cannot come back.
    //
    // And nothing ALREADY on the stack may survive either (BUG-0005). Every
    // queued entry names its sheet by index, and the delete just renumbered
    // every index above this one — so undoing across the delete restored onto
    // whichever sheet inherited the number. Excel ends the history here, and so
    // does this.
    invalidate_undo_history_for_sheet_structure(&state, "delete a sheet");

    // The active sheet (or its index) changed — rebuild the single-sheet
    // dependency maps (see set_active_sheet / BUG-0016).
    crate::undo_commands::rebuild_all_dependencies(&state);

    // A formula the delete really DID rewrite came back out of the renderer with
    // every bare identifier in capitals — §2t's `BudgetTotal` -> `BUDGETTOTAL`,
    // on a path §2t's fix (which lives on `open_file`) never reached. Same
    // function as the load path and as `rename_sheet`, so the three cannot
    // disagree about what a name is called. Must run AFTER the locks above are
    // dropped: it takes `grid` and `grids` for writing itself.
    crate::persistence::restamp_workbook_name_casing(&state, &effect);

    // RECALCULATE THE WORKBOOK. Deleting a sheet is the one structural edit
    // that changes VALUES it does not write: `repair_all_formulas` above turned
    // every formula referencing the deleted sheet into `#REF!`, and everything
    // downstream of those cells still held the number it computed while the
    // sheet existed. Nothing recalculated, so the stale values simply stayed --
    // and were what a save then wrote.
    //
    // Whole-workbook rather than a seeded cascade: the repaired cells are
    // spread across every sheet, this is a rare and already-heavyweight
    // operation, and it is the same treatment the load path gives a workbook
    // whose formulas it has just re-read. Runs LAST, after every lock above is
    // dropped and after the dependency rebuild, so the pass sees the finished
    // workbook.
    let sheet_count = state.sheet_names.read().unwrap().len();
    for idx in 0..sheet_count {
        crate::calculation::recalculate_sheet_values(
            &state,
            &user_files_state,
            &pivot_state,
            idx,
            Some((&*pane_control_state, &*ribbon_filter_state)),
        );
    }

    // Floating ranges HOSTED on the deleted sheet die with it — the cascade
    // declared in `object_deps::DEPENDENCY_MATRIX` (Sheet →
    // floatingRange.hostSheet). Runs last, with every lock long released; each
    // orphaned object deletes its own backing sheet back through THIS function
    // (`allow_object = true`), and a backing sheet hosts nothing, so the
    // recursion is depth one.
    if let Some(host_id) = deleted_sheet_stable_id {
        crate::floating_range::delete_floating_ranges_for_host(
            state,
            file_state,
            pivot_state,
            user_files_state,
            pane_control_state,
            ribbon_filter_state,
            slicer_state,
            timeline_state,
            host_id,
        );
    }

    Ok(result)
}

#[tauri::command]
pub fn rename_sheet(
    state: State<AppState>,
    file_state: State<crate::persistence::FileState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    index: usize,
    new_name: String,
) -> Result<SheetsResult, String> {
    let sheet_id = state.sheet_ids.read().map_err(|e| e.to_string())?.get(index).copied();
    with_pane_controls_following_rename(&state, &pane_control_state, sheet_id, || {
        rename_sheet_inner(&state, &file_state, &pivot_state, index, new_name, false)
    })
}

/// Run a sheet rename (`rename`) and carry the PANE-CONTROL dropdown sources
/// that name the sheet with it (wave C, W7) -- the fourth rule store, which
/// `rename_sheet_inner` cannot reach: pane controls live in their own managed
/// state (`PaneControlState`), and `rename_sheet_inner` keeps the signature its
/// many callers share.
///
/// The sheet is followed by its STABLE ID (`sheet_id`, read by the caller
/// before the rename): its name before and after is read by id, so a sheet
/// operation landing between the id read and the rename can never make a
/// dropdown follow a DIFFERENT sheet's name -- at worst (the id no longer
/// names the renamed sheet) nothing is carried. A refused rename carries
/// nothing. Every rename door goes through here: the `rename_sheet` command,
/// the MCP `rename_sheet` tool and `rename_floating_range` (a floating range's
/// name IS its backing sheet's name). LOCKS: `sheet_ids` then `sheet_names`,
/// each read and released, before and after; the pane store alone after.
pub(crate) fn with_pane_controls_following_rename<T>(
    state: &AppState,
    pane_control_state: &crate::pane_control::PaneControlState,
    sheet_id: Option<identity::SheetId>,
    rename: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let name_of = |id: identity::SheetId| -> Option<String> {
        let index = state.sheet_ids.read().ok()?.iter().position(|s| *s == id)?;
        state.sheet_names.read().ok()?.get(index).cloned()
    };
    let before = sheet_id.and_then(|id| name_of(id).map(|name| (id, name)));
    let out = rename()?;
    if let Some((id, old)) = before {
        if let Some(new) = name_of(id) {
            rename_pane_control_references(
                pane_control_state,
                &calp::sheet_renames::SheetRenames::new([(old.as_str(), new.as_str())]),
            );
        }
    }
    Ok(out)
}

/// Command body over plain references (the `hide_sheet_inner` split), plus the
/// ONE parameterized gate: `rename_floating_range` renames its OBJECT-backed
/// sheet through this exact machinery — validation, the workbook-repairable
/// gate, `repair_all_formulas`, cross-map re-keying, name-casing restamp —
/// because a floating range's name IS its backing sheet's name. Every other
/// caller passes `allow_object = false` and object sheets are refused.
pub(crate) fn rename_sheet_inner(
    state: &AppState,
    file_state: &FileState,
    pivot_state: &PivotState,
    index: usize,
    new_name: String,
    allow_object: bool,
) -> Result<SheetsResult, String> {
    crate::protection::check_workbook_structure(state, "rename a sheet")?;
    // CANONICAL LOCK ORDER: `grid`, then `grids`, then everything else --
    // `sheet_names` included. The calculation pass (`calculate_now`, an async
    // command, so off the main thread) takes `grid`, `grids` and only then
    // `sheet_names`; this took `sheet_names`, `freeze_configs`, `tab_colors`
    // and `sheet_visibility` FIRST and waited for both grid locks while holding
    // them, so a rename that overlapped an F9 hung the app (fix round 4, B2;
    // invisible to the lock-order census until it learned `lock_pending`).
    //
    // Locked but UNDECIDED: the three validation gates below can still refuse,
    // and this command previously took no `FileState` at all -- renaming a sheet
    // rewrote every cross-sheet formula in the workbook and left the document
    // looking clean. `lock_pending` lets the gates read under the lock they
    // already hold and postpones the dirty decision past the last `return Err`.
    let current_grid = state.grid.lock_pending().unwrap();
    let grids = state.grids.lock_pending().unwrap();
    let sheet_names = state.sheet_names.lock_pending().unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();
    let freeze_configs = state.freeze_configs.read().unwrap();
    let tab_colors = state.tab_colors.read().unwrap();
    let sheet_visibility = state.sheet_visibility.read().unwrap();

    if index >= sheet_names.len() {
        return Err(format!("Sheet index {} out of range", index));
    }

    // A floating range's name is renamed through `rename_floating_range`, which
    // shares this command's repair machinery but also owns the object's
    // identity. The sheet-command door stays closed to object sheets.
    if !allow_object {
        ensure_user_sheet(&sheet_visibility, index, "rename")?;
    }

    // EXCEL'S RULE, at the one place a user names a sheet (register F6, product
    // half): 1-31 characters, none of `: \ / ? * [ ]`, no leading or trailing
    // apostrophe, not the reserved `History`, and not a name another sheet
    // already has IGNORING CASE. `John's`, `Q1-2026` and `2026` remain legal --
    // Excel allows them and the renderer quotes them correctly.
    let trimmed_name = crate::sheet_names::validate_sheet_name(&new_name)?;
    crate::sheet_names::ensure_sheet_name_is_free(&trimmed_name, &sheet_names, Some(index))?;

    // THE FOURTH GATE, and the reason the three above hold `lock_pending`
    // guards: renaming a sheet re-renders every formula in the workbook, and a
    // repaired formula that cannot be read back used to become a cell with a
    // stale value and an empty formula bar (register §3bc). Excel refuses the
    // rename rather than corrupting the workbook, so this refuses too — here,
    // while the document is still undecided and nothing has been written.
    {
        let old_name = sheet_names[index].clone();
        let repair = |formula: &str| {
            Some(crate::repair_3d_refs_on_rename(formula, &old_name, &trimmed_name))
        };
        if let Err(refusal) =
            check_workbook_repairable(&grids, &current_grid, active_sheet, None, &repair)
        {
            crate::log_error!("SHEET", "rename_sheet refused: {}", refusal);
            return Err(refusal.message(
                &format!("rename sheet '{}' to '{}'", old_name, trimmed_name),
                &sheet_names,
            ));
        }
    }

    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut grids = grids.authorize(&effect);
    let mut current_grid = current_grid.authorize(&effect);
    let mut sheet_names = sheet_names.authorize(&effect);

    let old_name = sheet_names[index].clone();
    sheet_names[index] = trimmed_name.clone();

    // Sync current grid before repairing formulas
    if active_sheet < grids.len() {
        grids[active_sheet] = current_grid.clone();
    }

    // Repair cross-sheet and 3D reference bookends in all formulas
    let old = old_name.clone();
    let new_n = trimmed_name.clone();
    // UNREACHABLE BY CONSTRUCTION (the gate above ran this exact closure over
    // these exact formulas), and handled anyway: the repair is all-or-nothing,
    // so no formula has been rewritten. Put the sheet's name back and refuse —
    // a rename that cannot carry the formulas with it must not happen at all.
    if let Err(refusal) = crate::repair_all_formulas(&mut grids, &|formula| {
        Some(crate::repair_3d_refs_on_rename(formula, &old, &new_n))
    }) {
        crate::log_error!(
            "SHEET",
            "rename_sheet repair failed AFTER its gate passed: {}",
            refusal
        );
        sheet_names[index] = old_name.clone();
        return Err(refusal.message(
            &format!("rename sheet '{}' to '{}'", old_name, trimmed_name),
            &sheet_names,
        ));
    }

    // Sync back the active grid
    if active_sheet < grids.len() {
        *current_grid = grids[active_sheet].clone();
    }

    let result = SheetsResult {
        sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &sheet_visibility, &state.sheet_ids.read().unwrap(), &state.sheet_kinds.read().unwrap()),
        active_index: active_sheet,
    };

    // DROP EVERY LOCK before touching the dependency maps: both helpers below
    // take their own, and `rebuild_all_dependencies` takes the grid and the
    // name tables as well.
    drop(current_grid);
    drop(grids);
    drop(sheet_names);
    drop(sheet_visibility);
    drop(tab_colors);
    drop(freeze_configs);

    // PIVOTS NAME THEIR SHEETS, and nothing carried those names through a
    // rename: `PivotDefinition.destination_sheet` / `source_sheet` kept the old
    // spelling, the destination stopped resolving, and the resolver's fallback
    // then aimed the next refresh at some OTHER sheet -- once, the first
    // worksheet, over the pivot's own source data. Taken here, with every sheet
    // guard above already released: `pivot_tables` is taken alone.
    crate::pivot::operations::rename_pivot_sheet_references(
        pivot_state,
        &effect,
        &old_name,
        &trimmed_name,
    );

    // The cross-sheet dependents map is keyed by sheet NAME, and the name just
    // changed. Without this the cascade looks up the new spelling, misses, and
    // every dependent living on another sheet silently stops recalculating.
    rename_cross_sheet_dependency_keys(&state, &old_name, &trimmed_name);
    // Defined names hold their target as formula TEXT and must follow the
    // rename exactly as the grid formulas just did.
    {
        let old = old_name.clone();
        let new_n = trimmed_name.clone();
        repair_named_ranges(&state, &effect, &|refers_to| {
            Some(crate::repair_3d_refs_on_rename(refers_to, &old, &new_n))
        });
        // ...and so do the `.calp` OVERRIDE records, whose baseline, current
        // and conflict-upstream values are formula TEXT too. Left alone, an
        // override on a pulled sheet's formula kept the old tab name: its own
        // formula read a sheet that no longer answers to it, and (since a
        // refresh rewrites upstream text to the subscriber's CURRENT tab names,
        // BUG-0151) its baseline no longer matched an untouched upstream -- a
        // false conflict at the next refresh.
        let renamed = |formula: &str| crate::repair_3d_refs_on_rename(formula, &old, &new_n);
        repair_override_formulas(&state, &effect, &renamed, &renamed);
        // ...and so do the RULE stores: conditional formats, custom
        // validations and control formula properties, through the walkers a
        // `.calp` pull's collision rename uses (`rename_rule_references`).
        rename_rule_references(
            &state,
            &effect,
            &calp::sheet_renames::SheetRenames::new([(old.as_str(), new_n.as_str())]),
        );
    }
    // A formula the rename really DID rewrite came back out of the renderer with
    // every bare identifier in capitals, so `=Anchor+Data!A1` became
    // `=ANCHOR+Facts!A1`. That is §2t (`BudgetTotal` -> `BUDGETTOTAL`) on a path
    // §2t's fix never reached — it is called from `open_file`. Same function
    // here, so entry, reload and a sheet rename cannot disagree about what a
    // name is called. Costs nothing when the workbook defines no names (the
    // restamp returns on the first `is_empty()`).
    crate::persistence::restamp_workbook_name_casing(&state, &effect);
    // EXCEL PARITY, and here it is a CORRECTNESS matter rather than only a
    // parity one (BUG-0005). A rename shifts no sheet index, but the repair
    // above rewrote every formula in the workbook — while the undo stack still
    // holds `previous` cells whose ASTs spell the OLD sheet name. Undoing
    // across the rename would put those back, re-introducing references to a
    // sheet that no longer answers to that name. Excel does not offer an undo
    // for a sheet rename at all.
    invalidate_undo_history_for_sheet_structure(&state, "rename a sheet");
    // `repair_all_formulas` above rewrote formula ASTs across every sheet, so
    // the ACTIVE sheet's sheet-less dependency maps describe the pre-repair
    // trees. This is the same call `delete_sheet` and `add_sheet` already make.
    crate::undo_commands::rebuild_all_dependencies(&state);

    Ok(result)
}

#[tauri::command]
pub fn set_freeze_panes(
    state: State<AppState>,
    file_state: State<FileState>,
    freeze_row: Option<u32>,
    freeze_col: Option<u32>,
) -> Result<SheetsResult, String> {
    set_freeze_panes_impl(&state, &file_state, freeze_row, freeze_col)
}

/// Command body over plain references, so the dirty-flag contract is unit-testable
/// without a Tauri `State` (see `document_effect_wave2_tests`).
pub(crate) fn set_freeze_panes_impl(
    state: &AppState,
    file_state: &FileState,
    freeze_row: Option<u32>,
    freeze_col: Option<u32>,
) -> Result<SheetsResult, String> {
    // Freeze panes ARE persisted (`sheet.freeze_row` / `freeze_col`), and
    // `set_split_window` below -- the same kind of per-sheet view state, written by the
    // same save path -- has always dirtied and says so in its doc comment. This one did
    // not: the two contradicted each other inside one file, and a workbook whose only
    // change was a freeze closed "clean" with the layout silently discarded.
    //
    // A canvas has no rows or columns to freeze. Refused BEFORE the effect, so the
    // refusal does not dirty the document. The index is copied out FIRST: a
    // `read()` temporary inside the call would hold `active_sheet` while the gate
    // takes `sheet_kinds`, the reverse of `get_sheet_summary` (an ABBA deadlock).
    let active_sheet = *state.active_sheet.read().unwrap();
    ensure_not_canvas_in_state(state, active_sheet, "freeze panes")?;
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let sheet_names = state.sheet_names.read().unwrap();
    let mut freeze_configs = state.freeze_configs.write(&effect).unwrap();
    let tab_colors = state.tab_colors.read().unwrap();
    let sheet_visibility = state.sheet_visibility.read().unwrap();

    // Ensure freeze_configs has enough entries
    while freeze_configs.len() <= active_sheet {
        freeze_configs.push(FreezeConfig::default());
    }

    // Pre-mutation snapshot for undo (BUG-0017; user decision:
    // undo-everything, deliberately better than Excel here).
    let previous = freeze_configs[active_sheet].clone();

    freeze_configs[active_sheet] = FreezeConfig {
        freeze_row,
        freeze_col,
    };

    let result = SheetsResult {
        sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &sheet_visibility, &state.sheet_ids.read().unwrap(), &state.sheet_kinds.read().unwrap()),
        active_index: active_sheet,
    };
    drop(freeze_configs);
    crate::undo_commands::record_freeze_undo(&state, active_sheet, previous, "Freeze panes");

    Ok(result)
}

#[tauri::command]
pub fn get_freeze_panes(state: State<AppState>) -> FreezeConfig {
    let active_sheet = *state.active_sheet.read().unwrap();
    let freeze_configs = state.freeze_configs.read().unwrap();

    freeze_configs.get(active_sheet).cloned().unwrap_or_default()
}

// ============================================================================
// Split Window Commands
// ============================================================================

/// Set the ACTIVE sheet's split bars.
///
/// Marks the workbook dirty: the split now lives in the .cala and is written
/// only by the save path, so without this a workbook whose only change was a
/// split closes "clean" and the layout is silently discarded (the exact rule
/// in `mark_workbook_modified`).
#[tauri::command]
pub fn set_split_window(
    state: State<AppState>,
    file_state: State<crate::persistence::FileState>,
    split_row: Option<u32>,
    split_col: Option<u32>,
) -> Result<(), String> {
    let active_sheet = *state.active_sheet.read().unwrap();
    // A canvas has no rows or columns to split at. Refused before the effect.
    ensure_not_canvas_in_state(&state, active_sheet, "split the window")?;
    // Nothing below can refuse, so the effect is minted here and the write it
    // authorises is the same statement that sets the flag.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    {
        let mut split_configs = state.split_configs.write(&effect).unwrap();

        // Ensure split_configs has enough entries
        while split_configs.len() <= active_sheet {
            split_configs.push(SplitConfig::default());
        }

        split_configs[active_sheet] = SplitConfig {
            split_row,
            split_col,
        };
    }

    Ok(())
}

#[tauri::command]
pub fn get_split_window(state: State<AppState>) -> SplitConfig {
    let active_sheet = *state.active_sheet.read().unwrap();
    let split_configs = state.split_configs.read().unwrap();

    split_configs.get(active_sheet).cloned().unwrap_or_default()
}

// ============================================================================
// Zoom Commands
// ============================================================================

/// Set the ACTIVE sheet's zoom, as a REAL PERCENT (100 = 100%).
///
/// Out-of-range values are rejected rather than clamped: a caller asking for
/// 0% or 5000% has a bug, and silently substituting a different number hides
/// it. The accepted band matches `script_engine::types::ZOOM_MIN/MAX_PERCENT`
/// so the script API and the UI cannot disagree about what is legal.
///
/// Marks the workbook dirty (Excel does too): zoom now lives in the .cala and
/// is written only by the save path, so a workbook whose only change was a
/// zoom would otherwise close "clean" and lose it — which is the very bug this
/// state exists to fix. A no-op write (same zoom) does NOT dirty the document,
/// so re-reading the value on a sheet switch cannot fake a change.
#[tauri::command]
pub fn set_sheet_zoom(
    state: State<AppState>,
    file_state: State<crate::persistence::FileState>,
    zoom: f64,
) -> Result<(), String> {
    set_sheet_zoom_inner(&state, &file_state, zoom)?;
    Ok(())
}

/// The zoom write itself. Split out from the command so it can be tested:
/// a `tauri::State` cannot be constructed in a unit test, and the validation
/// plus the "did it actually change?" answer are the parts worth pinning.
///
/// Returns whether the stored value actually changed.
pub(crate) fn set_sheet_zoom_inner(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    zoom: f64,
) -> Result<bool, String> {
    if !zoom.is_finite()
        || !(script_engine::types::ZOOM_MIN_PERCENT..=script_engine::types::ZOOM_MAX_PERCENT)
            .contains(&zoom)
    {
        return Err(format!(
            "zoom must be a percent between {} and {} (got {zoom})",
            script_engine::types::ZOOM_MIN_PERCENT,
            script_engine::types::ZOOM_MAX_PERCENT
        ));
    }
    let active_sheet = *state.active_sheet.read().map_err(|e| e.to_string())?;
    // `lock_pending`, and the no-op case returns WITHOUT writing at all: the
    // "re-writing the same zoom is not a change" rule used to live in the
    // command (which decided whether to call `mutates` from this bool). With
    // the store gated, the rule and the write are one statement apart and
    // cannot drift -- and the read-decide-write stays in one critical section.
    let sheet_zooms = state.sheet_zooms.lock_pending().map_err(|e| e.to_string())?;
    let changed = match sheet_zooms.get(active_sheet) {
        Some(current) => (current - zoom).abs() >= 1e-9,
        None => true,
    };
    if !changed {
        return Ok(false);
    }
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    let mut sheet_zooms = sheet_zooms.authorize(&effect);
    while sheet_zooms.len() <= active_sheet {
        sheet_zooms.push(persistence::DEFAULT_SHEET_ZOOM_PERCENT);
    }
    sheet_zooms[active_sheet] = zoom;
    Ok(true)
}

/// Read the ACTIVE sheet's zoom as a REAL PERCENT.
#[tauri::command]
pub fn get_sheet_zoom(state: State<AppState>) -> f64 {
    let active_sheet = *state.active_sheet.read().unwrap();
    let sheet_zooms = state.sheet_zooms.read().unwrap();
    sheet_zooms
        .get(active_sheet)
        .copied()
        .unwrap_or(persistence::DEFAULT_SHEET_ZOOM_PERCENT)
}

// ============================================================================
// New Commands: Move, Copy, Hide/Unhide, Tab Color
// ============================================================================

/// Move a sheet from one position to another.
#[tauri::command]
pub fn move_sheet(
    state: State<AppState>,
    file_state: State<FileState>,
    slicer_state: State<'_, crate::slicer::SlicerState>,
    timeline_state: State<'_, crate::timeline_slicer::TimelineSlicerState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    from_index: usize,
    to_index: usize,
) -> Result<SheetsResult, String> {
    move_sheet_impl(
        &state,
        &file_state,
        &slicer_state,
        &timeline_state,
        &ribbon_filter_state,
        from_index,
        to_index,
    )
}

/// `move_sheet` without the Tauri `State` wrappers, so tests can drive the
/// real rotation of every per-sheet vector.
pub(crate) fn move_sheet_impl(
    state: &AppState,
    file_state: &FileState,
    slicer_state: &crate::slicer::SlicerState,
    timeline_state: &crate::timeline_slicer::TimelineSlicerState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    from_index: usize,
    to_index: usize,
) -> Result<SheetsResult, String> {
    crate::protection::check_workbook_structure(&state, "move a sheet")?;
    // Deleting/moving/copying a sheet rewrites persisted per-sheet stores.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    // CANONICAL LOCK ORDER: `grid`, then `grids`, then everything else --
    // including `sheet_names`. The recalculation pass takes `sheet_names` only
    // AFTER both grid locks and runs on a background thread, so holding it here
    // and then waiting for a grid lock closes a cycle that hangs the app.
    let mut current_grid = state.grid.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    let mut sheet_names = state.sheet_names.write(&effect).unwrap();
    let mut active_sheet = state.active_sheet.write(&effect).unwrap();
    let mut freeze_configs = state.freeze_configs.write(&effect).unwrap();
    let mut tab_colors = state.tab_colors.write(&effect).unwrap();
    let mut sheet_visibility = state.sheet_visibility.write(&effect).unwrap();
    let mut column_widths = state.column_widths.write(&effect).unwrap();
    let mut row_heights = state.row_heights.write(&effect).unwrap();
    let mut all_column_widths = state.all_column_widths.write(&effect).unwrap();
    let mut all_row_heights = state.all_row_heights.write(&effect).unwrap();
    let mut page_setups = state.page_setups.write(&effect).unwrap();

    let count = sheet_names.len();
    if from_index >= count {
        return Err(format!("Source sheet index {} out of range", from_index));
    }
    if to_index >= count {
        return Err(format!("Target sheet index {} out of range", to_index));
    }
    // Object-backed sheets have no tab, so they can be neither the sheet being
    // moved nor the position moved onto. (Moving a USER sheet across one is
    // fine: the rotate below renumbers the object sheet with everything else,
    // and its owning object row is SheetId-keyed, not index-keyed.)
    ensure_user_sheet(&sheet_visibility, from_index, "move")?;
    ensure_user_sheet(&sheet_visibility, to_index, "move onto")?;
    if from_index == to_index {
        return Ok(SheetsResult {
            sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &sheet_visibility, &state.sheet_ids.read().unwrap(), &state.sheet_kinds.read().unwrap()),
            active_index: *active_sheet,
        });
    }

    // Sync active grid to storage first
    let old_active = *active_sheet;
    if old_active < grids.len() {
        grids[old_active] = current_grid.clone();
    }
    ensure_vec_len(&mut all_column_widths, count);
    ensure_vec_len(&mut all_row_heights, count);
    if old_active < all_column_widths.len() {
        all_column_widths[old_active] = std::mem::take(&mut *column_widths);
    }
    if old_active < all_row_heights.len() {
        all_row_heights[old_active] = std::mem::take(&mut *row_heights);
    }

    // Ensure all per-sheet vecs are long enough
    ensure_vec_len(&mut freeze_configs, count);
    ensure_vec_len(&mut tab_colors, count);
    ensure_visibility_len(&mut sheet_visibility, count);
    ensure_vec_len(&mut page_setups, count);

    rotate_element(&mut *sheet_names, from_index, to_index);
    rotate_element(&mut *grids, from_index, to_index);
    rotate_element(&mut *freeze_configs, from_index, to_index);
    {
        let mut split_configs = state.split_configs.write(&effect).unwrap();
        ensure_vec_len(&mut split_configs, count);
        rotate_element(&mut *split_configs, from_index, to_index);
    }
    {
        let mut scroll_areas = state.scroll_areas.lock().unwrap();
        ensure_vec_len(&mut scroll_areas, count);
        rotate_element(&mut *scroll_areas, from_index, to_index);
    }
    {
        let mut sheet_zooms = state.sheet_zooms.write(&effect).unwrap();
        ensure_vec_len_with(&mut *sheet_zooms, count, || persistence::DEFAULT_SHEET_ZOOM_PERCENT);
        rotate_element(&mut *sheet_zooms, from_index, to_index);
    }
    {
        let mut sheet_ids = state.sheet_ids.write(&effect).unwrap();
        ensure_vec_len_with(&mut *sheet_ids, count, || identity::SheetId::from_bytes(identity::generate_uuid_v7()));
        rotate_element(&mut *sheet_ids, from_index, to_index);
    }
    rotate_element(&mut *tab_colors, from_index, to_index);
    rotate_element(&mut *sheet_visibility, from_index, to_index);
    rotate_element(&mut *all_column_widths, from_index, to_index);
    rotate_element(&mut *all_row_heights, from_index, to_index);
    crate::commands::dimensions::stash_active_user_hidden(&state, old_active);
    crate::commands::dimensions::rotate_user_hidden_sheet(&state, &effect, from_index, to_index, count);
    rotate_element(&mut *page_setups, from_index, to_index);
    {
        let mut gridlines = state.show_gridlines.write(&effect).unwrap();
        while gridlines.len() < count {
            gridlines.push(true);
        }
        rotate_element(&mut *gridlines, from_index, to_index);
    }
    {
        let mut display_flags = state.sheet_display_flags.write(&effect).unwrap();
        while display_flags.len() < count {
            display_flags.push(crate::api_types::SheetDisplayFlags::default());
        }
        rotate_element(&mut *display_flags, from_index, to_index);
    }
    {
        let mut sheet_kinds = state.sheet_kinds.write(&effect).unwrap();
        ensure_vec_len(&mut sheet_kinds, count);
        rotate_element(&mut *sheet_kinds, from_index, to_index);
    }
    {
        let mut all_merged = state.all_merged_regions.write(&effect).unwrap();
        let mut current_merged = state.merged_regions.write(&effect).unwrap();
        ensure_vec_len(&mut all_merged, count);
        all_merged[old_active] = std::mem::take(&mut *current_merged);
        rotate_element(&mut *all_merged, from_index, to_index);
    }

    // Update active_sheet to follow the moved sheet
    let new_active = if old_active == from_index {
        to_index
    } else if from_index < to_index {
        // Moved right: sheets in [from+1..=to] shifted left by 1
        if old_active > from_index && old_active <= to_index {
            old_active - 1
        } else {
            old_active
        }
    } else {
        // Moved left: sheets in [to..from-1] shifted right by 1
        if old_active >= to_index && old_active < from_index {
            old_active + 1
        } else {
            old_active
        }
    };

    *active_sheet = new_active;
    *current_grid = grids[new_active].clone();
    *column_widths = std::mem::take(&mut all_column_widths[new_active]);
    *row_heights = std::mem::take(&mut all_row_heights[new_active]);
    crate::commands::dimensions::load_active_user_hidden(&state, new_active);
    {
        let mut all_merged = state.all_merged_regions.write(&effect).unwrap();
        let mut current_merged = state.merged_regions.write(&effect).unwrap();
        if new_active < all_merged.len() {
            *current_merged = std::mem::take(&mut all_merged[new_active]);
        }
    }

    // Reports follow their sheet through the move: remap the sheet_index of
    // report definitions and their protected regions to the rotated order —
    // otherwise the next refresh materializes onto whatever sheet now holds the
    // old index. (Pivot regions keep their historical no-remap behavior so they
    // stay consistent with pivot definitions.)
    {
        let remap = |i: usize| -> usize {
            if i == from_index {
                to_index
            } else if from_index < to_index && i > from_index && i <= to_index {
                i - 1
            } else if to_index < from_index && i >= to_index && i < from_index {
                i + 1
            } else {
                i
            }
        };
        {
            // A BI query result block's region moves too (BUG-0138): it is WHERE
            // the block sits, and left on the old index it would refuse edits to
            // another sheet's cells while leaving the block's own unguarded.
            // The refresh re-derives the block's sheet from its identity.
            let mut regions = state.protected_regions.lock().unwrap();
            for r in regions.iter_mut() {
                if r.region_type == "report" || r.region_type == "bi" {
                    r.sheet_index = remap(r.sheet_index);
                }
            }
        }
        crate::report::remap_report_sheets(&state, &effect, |i| Some(remap(i)));

        // Same remap for the sheet-index-keyed HashMap stores (comments,
        // scenarios, outlines, conditional formats, data validations, cell
        // types, on-grid controls, advanced-filter hidden rows, spill
        // tracking) — historically missed here, which left their entries
        // pointing at whatever sheet inherited the old index after a move.
        remap_sheet_keyed_stores(&state, &effect, |i| Some(remap(i)));

        // TABLES, which `remap_sheet_keyed_stores` does not reach (see
        // `remap_tables_store`). Without this a table stayed under the index its
        // sheet used to occupy while its AutoFilter — which IS in that helper —
        // moved with the sheet (BUG-0047).
        remap_tables_store(&state, &effect, |i| Some(remap(i)));

        // The floating object stores carry a sheet_index FIELD rather than a
        // sheet KEY, so nothing above reaches them (§3bn). A move renumbers
        // sheets under them exactly as a delete does: without this, moving a
        // sheet left every slicer, timeline, chart and sparkline pointing at
        // whichever sheet inherited its old index. The remap is total here --
        // a move deletes nothing -- so this is a pure re-anchor.
        crate::object_deps::cascade_sheet_removed(
            &state,
            &slicer_state,
            &timeline_state,
            &ribbon_filter_state,
            &effect,
            &|i| Some(remap(i)),
        );
    }

    let result = SheetsResult {
        sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &sheet_visibility, &state.sheet_ids.read().unwrap(), &state.sheet_kinds.read().unwrap()),
        active_index: new_active,
    };

    // EVERY GUARD RELEASED, in one move, before the undo history is touched:
    // `invalidate_undo_history_for_sheet_structure`'s contract is that it runs
    // with nothing else held, so it adds no edge to the lock order.
    drop((
        current_grid,
        grids,
        sheet_names,
        active_sheet,
        freeze_configs,
        tab_colors,
        sheet_visibility,
        column_widths,
        row_heights,
        all_column_widths,
        all_row_heights,
        page_setups,
    ));

    // EXCEL PARITY: moving a sheet ends the undo history (BUG-0005). The
    // rotation above renumbered the sheets under every queued entry.
    invalidate_undo_history_for_sheet_structure(&state, "move a sheet");

    Ok(result)
}

/// Copy a sheet to a new position.
#[tauri::command]
pub fn copy_sheet(
    state: State<AppState>,
    file_state: State<FileState>,
    slicer_state: State<'_, crate::slicer::SlicerState>,
    timeline_state: State<'_, crate::timeline_slicer::TimelineSlicerState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    source_index: usize,
    new_name: Option<String>,
) -> Result<SheetsResult, String> {
    copy_sheet_impl(
        &state,
        &file_state,
        &slicer_state,
        &timeline_state,
        &ribbon_filter_state,
        source_index,
        new_name,
    )
}

/// `copy_sheet` without the Tauri `State` wrappers, so tests can drive the
/// real insertion into every per-sheet vector.
pub(crate) fn copy_sheet_impl(
    state: &AppState,
    file_state: &FileState,
    slicer_state: &crate::slicer::SlicerState,
    timeline_state: &crate::timeline_slicer::TimelineSlicerState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    source_index: usize,
    new_name: Option<String>,
) -> Result<SheetsResult, String> {
    crate::protection::check_workbook_structure(&state, "copy a sheet")?;
    // A canvas cannot be copied yet: copy_sheet clones the grid and the view
    // state but NONE of the object stores (charts, slicers, floating ranges,
    // pivots), so the copy of a canvas would be an empty page presented as a
    // duplicate. Refusing is the honest failure until a deep copy exists.
    if is_canvas_sheet(&state.sheet_kinds.read().unwrap(), source_index) {
        return Err(
            "A canvas sheet cannot be duplicated yet: its objects would not be copied. \
             Add a new canvas and recreate or move the objects instead."
                .to_string(),
        );
    }

    // NAME GATES FIRST, under a read lock, so a refused name cannot leave the
    // document marked modified (`DocumentEffect::mutates` on ordering). The
    // checks are repeated under the write lock below, which is the
    // authoritative pair; this one exists to refuse cleanly.
    let requested_name = match new_name {
        Some(requested) => Some(crate::sheet_names::validate_sheet_name(&requested)?),
        None => None,
    };
    {
        let sheet_names = state.sheet_names.read().map_err(|e| e.to_string())?;
        if source_index >= sheet_names.len() {
            return Err(format!("Source sheet index {} out of range", source_index));
        }
        if let Some(name) = &requested_name {
            crate::sheet_names::ensure_sheet_name_is_free(name, &sheet_names, None)?;
        }
    }

    // Deleting/moving/copying a sheet rewrites persisted per-sheet stores.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    // CANONICAL LOCK ORDER: `grid`, then `grids`, then everything else --
    // including `sheet_names`. The recalculation pass takes `sheet_names` only
    // AFTER both grid locks and runs on a background thread, so holding it here
    // and then waiting for a grid lock closes a cycle that hangs the app.
    let mut current_grid = state.grid.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    let mut sheet_names = state.sheet_names.write(&effect).unwrap();
    let mut active_sheet = state.active_sheet.write(&effect).unwrap();
    let mut freeze_configs = state.freeze_configs.write(&effect).unwrap();
    let mut tab_colors = state.tab_colors.write(&effect).unwrap();
    let mut sheet_visibility = state.sheet_visibility.write(&effect).unwrap();
    let mut column_widths = state.column_widths.write(&effect).unwrap();
    let mut row_heights = state.row_heights.write(&effect).unwrap();
    let mut all_column_widths = state.all_column_widths.write(&effect).unwrap();
    let mut all_row_heights = state.all_row_heights.write(&effect).unwrap();
    let mut page_setups = state.page_setups.write(&effect).unwrap();

    let count = sheet_names.len();
    if source_index >= count {
        return Err(format!("Source sheet index {} out of range", source_index));
    }

    // A floating range's backing sheet cannot be copied as a sheet: the copy
    // would be an object sheet with no owning object row (invisible everywhere,
    // reachable by nothing). Duplicating a floating range is its own object
    // operation, when it exists.
    ensure_user_sheet(&sheet_visibility, source_index, "copy")?;

    // Sync active grid
    let old_active = *active_sheet;
    if old_active < grids.len() {
        grids[old_active] = current_grid.clone();
    }
    ensure_vec_len(&mut all_column_widths, count);
    ensure_vec_len(&mut all_row_heights, count);
    if old_active < all_column_widths.len() {
        all_column_widths[old_active] = std::mem::take(&mut *column_widths);
    }
    if old_active < all_row_heights.len() {
        all_row_heights[old_active] = std::mem::take(&mut *row_heights);
    }

    // Generate copy name. A name the caller SUPPLIED goes through Excel's rule;
    // a generated one is built to satisfy it -- `format!("{} (2)", base)` on a
    // 31-character base produced a 35-character name, which the rule refuses.
    let copy_name = match requested_name {
        Some(requested) => requested,
        None => crate::sheet_names::unique_sheet_name(&sheet_names[source_index], &sheet_names),
    };

    crate::sheet_names::ensure_sheet_name_is_free(&copy_name, &sheet_names, None)?;

    // Clone source data
    let cloned_grid = grids[source_index].clone();
    ensure_vec_len(&mut freeze_configs, count);
    ensure_vec_len(&mut tab_colors, count);
    ensure_visibility_len(&mut sheet_visibility, count);
    ensure_vec_len(&mut page_setups, count);

    let cloned_freeze = freeze_configs[source_index].clone();
    let cloned_tab_color = tab_colors[source_index].clone();
    let cloned_widths = all_column_widths[source_index].clone();
    let cloned_heights = all_row_heights[source_index].clone();
    let cloned_page_setup = page_setups[source_index].clone();

    // Insert right after the source
    let insert_at = source_index + 1;
    sheet_names.insert(insert_at, copy_name);
    grids.insert(insert_at, cloned_grid.clone());
    freeze_configs.insert(insert_at, cloned_freeze);
    {
        let mut split_configs = state.split_configs.write(&effect).unwrap();
        ensure_vec_len(&mut split_configs, count);
        let cloned_split = split_configs[source_index].clone();
        split_configs.insert(insert_at, cloned_split);
    }
    {
        let mut scroll_areas = state.scroll_areas.lock().unwrap();
        ensure_vec_len(&mut scroll_areas, count);
        let cloned_scroll = scroll_areas[source_index].clone();
        scroll_areas.insert(insert_at, cloned_scroll);
    }
    {
        // A copied sheet keeps the original's zoom — the copy is meant to look
        // like what was copied.
        let mut sheet_zooms = state.sheet_zooms.write(&effect).unwrap();
        ensure_vec_len_with(&mut *sheet_zooms, count, || persistence::DEFAULT_SHEET_ZOOM_PERCENT);
        let cloned_zoom = sheet_zooms[source_index];
        sheet_zooms.insert(insert_at, cloned_zoom);
    }
    tab_colors.insert(insert_at, cloned_tab_color);
    sheet_visibility.insert(insert_at, "visible".to_string()); // Copy is always visible
    {
        let mut sheet_ids = state.sheet_ids.write(&effect).unwrap();
        ensure_vec_len_with(&mut *sheet_ids, count, || identity::SheetId::from_bytes(identity::generate_uuid_v7()));
        // Copy gets a fresh ID (it's a new distinct sheet)
        sheet_ids.insert(insert_at, identity::SheetId::from_bytes(identity::generate_uuid_v7()));
    }
    {
        let mut gridlines = state.show_gridlines.write(&effect).unwrap();
        while gridlines.len() < count {
            gridlines.push(true);
        }
        let cloned_gridlines = gridlines[source_index];
        gridlines.insert(insert_at, cloned_gridlines);
    }
    {
        let mut display_flags = state.sheet_display_flags.write(&effect).unwrap();
        while display_flags.len() < count {
            display_flags.push(crate::api_types::SheetDisplayFlags::default());
        }
        let cloned_flags = display_flags[source_index].clone();
        display_flags.insert(insert_at, cloned_flags);
    }
    {
        // copy_sheet refuses a canvas up front, so the copy is always a
        // worksheet; cloning the slot keeps the rule in one place anyway.
        let mut sheet_kinds = state.sheet_kinds.write(&effect).unwrap();
        ensure_vec_len(&mut sheet_kinds, count);
        let cloned_kind = sheet_kinds[source_index].clone();
        sheet_kinds.insert(insert_at, cloned_kind);
    }
    all_column_widths.insert(insert_at, cloned_widths);
    all_row_heights.insert(insert_at, cloned_heights);
    crate::commands::dimensions::stash_active_user_hidden(&state, old_active);
    crate::commands::dimensions::duplicate_user_hidden_sheet(&state, &effect, source_index, insert_at);
    page_setups.insert(insert_at, cloned_page_setup);
    {
        let mut all_merged = state.all_merged_regions.write(&effect).unwrap();
        let mut current_merged = state.merged_regions.write(&effect).unwrap();
        ensure_vec_len(&mut all_merged, count);
        all_merged[old_active] = std::mem::take(&mut *current_merged);
        let cloned_merged = all_merged[source_index].clone();
        all_merged.insert(insert_at, cloned_merged);
    }

    // Switch to the new copy
    let new_index = insert_at;
    *active_sheet = new_index;
    *current_grid = cloned_grid;
    *column_widths = std::mem::take(&mut all_column_widths[new_index]);
    *row_heights = std::mem::take(&mut all_row_heights[new_index]);
    crate::commands::dimensions::load_active_user_hidden(&state, new_index);
    {
        let mut all_merged = state.all_merged_regions.write(&effect).unwrap();
        let mut current_merged = state.merged_regions.write(&effect).unwrap();
        if new_index < all_merged.len() {
            *current_merged = std::mem::take(&mut all_merged[new_index]);
        }
    }

    // The insert shifted every sheet at/above insert_at up by one: follow with
    // the report definitions and their protected regions. The COPY itself gets
    // no report definition — its report cells become plain grid content.
    // (Pivot regions keep their historical no-remap behavior.)
    {
        {
            // BI result blocks' regions shift with their sheets too (BUG-0138).
            let mut regions = state.protected_regions.lock().unwrap();
            for r in regions.iter_mut() {
                if (r.region_type == "report" || r.region_type == "bi") && r.sheet_index >= insert_at {
                    r.sheet_index += 1;
                }
            }
        }
        crate::report::remap_report_sheets(&state, &effect, |i| {
            Some(if i >= insert_at { i + 1 } else { i })
        });

        // Same shift for the sheet-index-keyed HashMap stores (comments,
        // scenarios, outlines, conditional formats, data validations, cell
        // types, on-grid controls, advanced-filter hidden rows, spill
        // tracking): indices at/above the insertion point move up by one. The
        // copy itself starts with none of this state (mirroring reports).
        remap_sheet_keyed_stores(&state, &effect, |i| {
            Some(if i >= insert_at { i + 1 } else { i })
        });

        // TABLES, for the same reason and by the same shift — they are not in
        // the helper above (see `remap_tables_store`, BUG-0047). The copy gets
        // none of its own, mirroring reports; this re-anchors the originals the
        // insertion pushed up.
        remap_tables_store(&state, &effect, |i| {
            Some(if i >= insert_at { i + 1 } else { i })
        });

        // Same shift for the floating object stores (slicers, timelines,
        // charts, sparklines, bySheet filter targets), which are keyed by a
        // sheet_index FIELD and were missed here for the same reason (§3bn).
        // The COPY itself gets none of them -- mirroring reports -- so this
        // only re-anchors the originals the insertion pushed up.
        crate::object_deps::cascade_sheet_removed(
            &state,
            &slicer_state,
            &timeline_state,
            &ribbon_filter_state,
            &effect,
            &|i| Some(if i >= insert_at { i + 1 } else { i }),
        );
    }

    let result = SheetsResult {
        sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &sheet_visibility, &state.sheet_ids.read().unwrap(), &state.sheet_kinds.read().unwrap()),
        active_index: new_index,
    };

    // Every guard released before the undo history is touched — see the
    // identical drop in `move_sheet` for the lock order that requires.
    drop((
        current_grid,
        grids,
        sheet_names,
        active_sheet,
        freeze_configs,
        tab_colors,
        sheet_visibility,
        column_widths,
        row_heights,
        all_column_widths,
        all_row_heights,
        page_setups,
    ));

    // EXCEL PARITY: copying a sheet ends the undo history (BUG-0005). The copy
    // is INSERTED, so every index at or above the insertion point moved up by
    // one under every queued entry.
    invalidate_undo_history_for_sheet_structure(&state, "copy a sheet");

    Ok(result)
}

/// Hide a sheet. Cannot hide the last visible sheet.
/// `level` controls the visibility: "hidden" (default, unhidable from UI) or "veryHidden"
/// (only unhidable via code/VBA, not from the UI).
///
/// HIDING THE ACTIVE SHEET PERFORMS THE SWITCH (BUG-0046). It used only to
/// RECOMMEND one — "frontend should call set_active_sheet if it changed", said
/// the doc comment — and not one of the three callers did:
///
///   * `SheetTabs.handleHide` passes `backendHandledSwitch: true`, which means
///     literally "the backend already swapped grids/state, do NOT call
///     setActiveSheetApi";
///   * `ScriptNotebook/lib/deferredActionHost.setSheetVisibility` says in as
///     many words "Hiding the active sheet makes the backend switch";
///   * the broker's `api.setSheetVisibility` goes through
///     `announceSheetsChanged`, which dispatches `setActiveSheet` into the
///     frontend store and emits SHEET_CHANGED.
///
/// So all three moved the FRONTEND to the recommended sheet while
/// `state.active_sheet` still named the sheet that had just been hidden — and
/// every cell read and every cell write goes to the active sheet. The tab strip
/// highlighted Sheet2, the canvas painted Sheet1's data, and typing wrote into
/// the hidden sheet. Excel's rule is simply that a hidden sheet cannot be
/// active, so the switch belongs here, in the one place all three routes pass
/// through, and it goes through `activate_sheet` — the single implementation
/// that moves the grid mirror, the widths, the heights, the merges and the
/// user-hidden sets together.
#[tauri::command]
pub fn hide_sheet(
    state: State<AppState>,
    file_state: State<FileState>,
    index: usize,
    level: Option<String>,
) -> Result<SheetsResult, String> {
    hide_sheet_inner(&state, &file_state, index, level)
}

/// Command body over plain references, so the switch it now performs has a unit
/// tier (`State<T>` cannot be built in a test). Same split as
/// `set_sheet_zoom_inner` below.
pub(crate) fn hide_sheet_inner(
    state: &AppState,
    file_state: &FileState,
    index: usize,
    level: Option<String>,
) -> Result<SheetsResult, String> {
    crate::protection::check_workbook_structure(state, "hide a sheet")?;

    // Every guard is scoped to this block: `activate_sheet` below takes the
    // canonical order for itself and CALLERS MUST HOLD NO STATE LOCK.
    let (result, switch_to, previous_visibility, previous_active) = {
        let sheet_names = state.sheet_names.read().unwrap();
        let active_sheet = *state.active_sheet.read().unwrap();
        let freeze_configs = state.freeze_configs.read().unwrap();
        let tab_colors = state.tab_colors.read().unwrap();

        if index >= sheet_names.len() {
            return Err(format!("Sheet index {} out of range", index));
        }

        let hide_level = level.unwrap_or_else(|| "hidden".to_string());
        if hide_level != "hidden" && hide_level != "veryHidden" {
            return Err(format!("Invalid visibility level '{}'. Use 'hidden' or 'veryHidden'.", hide_level));
        }

        // An object-backed sheet is not on any tab and cannot change visibility
        // level: overwriting its `"object"` marker would orphan the floating
        // range that owns it. (Checked with a plain read before the effect is
        // constructed — a refused hide must not dirty.)
        {
            let sheet_visibility = state.sheet_visibility.read().unwrap();
            ensure_user_sheet(&sheet_visibility, index, "hide")?;
        }

        // Past the structure gate and both validations. `sheet.visibility` is persisted.
        // The last-visible-sheet check below can still refuse; it is a pure read of the
        // store, so a refused hide leaves the data untouched but the flag set -- a false
        // positive, which is the cheap direction. Every refusal that CAN be resolved
        // before the decision is.
        let effect = crate::document_effect::DocumentEffect::mutates(file_state);
        let mut sheet_visibility = state.sheet_visibility.write(&effect).unwrap();

        ensure_visibility_len(&mut sheet_visibility, sheet_names.len());

        // Check: at least one visible sheet must remain
        let visible_count = sheet_visibility.iter().enumerate()
            .filter(|(i, vis)| vis.as_str() == "visible" && *i != index)
            .count();
        if visible_count == 0 {
            return Err("Cannot hide the last visible sheet".to_string());
        }

        // Captured AFTER the last refusal and BEFORE the write. Recording the
        // entry itself happens outside this block: `record_custom_restore` takes
        // `undo_stack`, and it is taken with these sheet guards released, as
        // `invalidate_undo_history_for_sheet_structure` documents for its own
        // caller contract -- the one recorded inversion around the stack was a
        // sheet-keyed store held while it was taken.
        // `None` when the sheet was already at that level: a no-op must not
        // burn an undo step. Excel does not push an entry for a change that
        // changed nothing, and a step that restores the state it is already in
        // is indistinguishable, from the keyboard, from an undo that was
        // swallowed.
        let previous_visibility =
            (sheet_visibility[index] != hide_level).then(|| sheet_visibility.clone());

        sheet_visibility[index] = hide_level;

        // Hiding the ACTIVE sheet moves to the nearest visible one. The check
        // above guarantees there is one.
        let switch_to = if index == active_sheet {
            (0..sheet_names.len()).find(|&i| sheet_visibility[i] == "visible")
        } else {
            None
        };

        let result = SheetsResult {
            sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &sheet_visibility, &state.sheet_ids.read().unwrap(), &state.sheet_kinds.read().unwrap()),
            active_index: switch_to.unwrap_or(active_sheet),
        };
        (result, switch_to, previous_visibility, active_sheet)
    };

    // UNDOABLE (BUG-0050). See `SheetTabStateSnapshot` for why these three
    // record an entry where the five structural commands END the history.
    //
    // The active sheet is recorded because a hide of the ACTIVE sheet moves the
    // user off it; undoing has to put them back, or the sheet comes out of
    // hiding somewhere the user cannot see it happen.
    if let Some(previous_visibility) = previous_visibility {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.record_custom_restore(
            crate::undo_commands::SHEET_TAB_STATE_RESTORE_KIND.to_string(),
            crate::undo_commands::sheet_tab_state_snapshot_bytes(
                Some(previous_visibility),
                None,
                Some(previous_active),
            ),
            "Hide sheet",
        );
    }

    match switch_to {
        // The REAL activation, with every guard above released. Its own
        // `SheetsResult` is the authoritative one: it is built after the swap
        // and reports the active index the backend actually holds.
        Some(target) => activate_sheet(state, target),
        None => Ok(result),
    }
}

/// Unhide a sheet.
#[tauri::command]
pub fn unhide_sheet(
    state: State<AppState>,
    file_state: State<FileState>,
    index: usize,
) -> Result<SheetsResult, String> {
    unhide_sheet_inner(&state, &file_state, index)
}

/// Command body over plain references, so the undo entry it now records has a
/// unit tier (`State<T>` cannot be built in a test). Same split as
/// `hide_sheet_inner` above.
pub(crate) fn unhide_sheet_inner(
    state: &AppState,
    file_state: &FileState,
    index: usize,
) -> Result<SheetsResult, String> {
    // Every guard is scoped to this block: the undo entry below takes
    // `undo_stack`, and it is taken with none of these held (the one recorded
    // inversion around the stack was a sheet-keyed store held while it was taken).
    let (result, previous_visibility) = {
        let sheet_names = state.sheet_names.read().unwrap();
        let active_sheet = *state.active_sheet.read().unwrap();
        let freeze_configs = state.freeze_configs.read().unwrap();
        let tab_colors = state.tab_colors.read().unwrap();

        if index >= sheet_names.len() {
            return Err(format!("Sheet index {} out of range", index));
        }

        // Unhiding an object-backed sheet would put a floating range's cell
        // store on the tab bar as if it were a worksheet. Its visibility
        // belongs to the owning object, not to this command. (Plain read
        // before the effect — a refusal must not dirty.)
        {
            let sheet_visibility = state.sheet_visibility.read().unwrap();
            ensure_user_sheet(&sheet_visibility, index, "unhide")?;
        }

        // Past the range check; `sheet.visibility` is persisted.
        let effect = crate::document_effect::DocumentEffect::mutates(file_state);
        let mut sheet_visibility = state.sheet_visibility.write(&effect).unwrap();

        ensure_visibility_len(&mut sheet_visibility, sheet_names.len());
        // `None` when it was already visible — see `hide_sheet_inner`.
        let previous_visibility =
            (sheet_visibility[index] != "visible").then(|| sheet_visibility.clone());
        sheet_visibility[index] = "visible".to_string();

        let result = SheetsResult {
            sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &sheet_visibility, &state.sheet_ids.read().unwrap(), &state.sheet_kinds.read().unwrap()),
            active_index: active_sheet,
        };
        (result, previous_visibility)
    };

    // UNDOABLE (BUG-0050). No `active_sheet`: an unhide never moves the user, so
    // undoing it must not move them either.
    if let Some(previous_visibility) = previous_visibility {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.record_custom_restore(
            crate::undo_commands::SHEET_TAB_STATE_RESTORE_KIND.to_string(),
            crate::undo_commands::sheet_tab_state_snapshot_bytes(
                Some(previous_visibility),
                None,
                None,
            ),
            "Unhide sheet",
        );
    }

    Ok(result)
}

/// Set the tab color for a sheet.
#[tauri::command]
pub fn set_tab_color(
    state: State<AppState>,
    file_state: State<FileState>,
    index: usize,
    color: String,
) -> Result<SheetsResult, String> {
    set_tab_color_inner(&state, &file_state, index, color)
}

/// Command body over plain references, so the undo entry it now records has a
/// unit tier (`State<T>` cannot be built in a test). Same split as
/// `hide_sheet_inner` above.
pub(crate) fn set_tab_color_inner(
    state: &AppState,
    file_state: &FileState,
    index: usize,
    color: String,
) -> Result<SheetsResult, String> {
    // Every guard is scoped to this block: the undo entry below takes
    // `undo_stack`, and it is taken with none of these held (the one recorded
    // inversion around the stack was a sheet-keyed store held while it was taken).
    let (result, previous_tab_colors) = {
        let sheet_names = state.sheet_names.read().unwrap();
        let active_sheet = *state.active_sheet.read().unwrap();
        let freeze_configs = state.freeze_configs.read().unwrap();
        let sheet_visibility = state.sheet_visibility.read().unwrap();

        if index >= sheet_names.len() {
            return Err(format!("Sheet index {} out of range", index));
        }

        // Past the range check; `sheet.tab_color` is persisted.
        let effect = crate::document_effect::DocumentEffect::mutates(file_state);
        let mut tab_colors = state.tab_colors.write(&effect).unwrap();

        ensure_tab_color_len(&mut tab_colors, sheet_names.len());
        // `None` when the colour was already that — see `hide_sheet_inner`.
        let previous_tab_colors = (tab_colors[index] != color).then(|| tab_colors.clone());
        tab_colors[index] = color;

        let result = SheetsResult {
            sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &sheet_visibility, &state.sheet_ids.read().unwrap(), &state.sheet_kinds.read().unwrap()),
            active_index: active_sheet,
        };
        (result, previous_tab_colors)
    };

    // UNDOABLE (BUG-0050). No `active_sheet`: a recolour never moves the user.
    if let Some(previous_tab_colors) = previous_tab_colors {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.record_custom_restore(
            crate::undo_commands::SHEET_TAB_STATE_RESTORE_KIND.to_string(),
            crate::undo_commands::sheet_tab_state_snapshot_bytes(
                None,
                Some(previous_tab_colors),
                None,
            ),
            "Tab color",
        );
    }

    Ok(result)
}

/// Navigate to the next visible sheet (wraps around).
#[tauri::command]
pub fn next_sheet(state: State<AppState>) -> Result<SheetsResult, String> {
    let sheet_names = state.sheet_names.read().unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();
    let sheet_visibility = state.sheet_visibility.read().unwrap();

    let count = sheet_names.len();
    if count == 0 {
        return Err("No sheets available".to_string());
    }

    // Find the next visible sheet after the current one, wrapping around
    let mut next_index = None;
    for offset in 1..count {
        let candidate = (active_sheet + offset) % count;
        let vis = sheet_visibility.get(candidate).map(|s| s.as_str()).unwrap_or("visible");
        if vis == "visible" {
            next_index = Some(candidate);
            break;
        }
    }

    match next_index {
        Some(idx) => {
            drop(sheet_names);
            drop(sheet_visibility);
            set_active_sheet(state, idx)
        }
        None => Err("No other visible sheet to navigate to".to_string()),
    }
}

// ============================================================================
// Scroll Area Commands
// ============================================================================

/// Set the scrollable area restriction for the active sheet.
/// `scroll_area` is an A1-style range like "A1:Z100", or None to clear.
#[tauri::command]
pub fn set_scroll_area(state: State<AppState>, scroll_area: Option<String>) -> Result<(), String> {
    set_scroll_area_impl(&state, scroll_area)
}

/// Command body over a plain reference.
///
/// Takes NO `FileState` on purpose, and that is the whole point: `scroll_areas` is not
/// collected by `assemble_workbook_for_save` and `persistence::Sheet` has no
/// `scroll_area` field, so this cannot reach the .cala and must not dirty. Not taking
/// the `FileState` at all is a stronger statement than taking it and not using it --
/// which is exactly the failure mode five commands already exhibited.
pub(crate) fn set_scroll_area_impl(
    state: &AppState,
    scroll_area: Option<String>,
) -> Result<(), String> {
    let active_sheet = *state.active_sheet.read().unwrap();
    let mut scroll_areas = state.scroll_areas.lock().unwrap();

    ensure_vec_len(&mut scroll_areas, active_sheet + 1);
    scroll_areas[active_sheet] = scroll_area;

    Ok(())
}

/// Get the scrollable area restriction for the active sheet.
/// Returns None if no restriction is set.
#[tauri::command]
pub fn get_scroll_area(state: State<AppState>) -> Option<String> {
    let active_sheet = *state.active_sheet.read().unwrap();
    let scroll_areas = state.scroll_areas.lock().unwrap();

    scroll_areas.get(active_sheet).cloned().flatten()
}

/// Navigate to the previous visible sheet (wraps around).
#[tauri::command]
pub fn previous_sheet(state: State<AppState>) -> Result<SheetsResult, String> {
    let sheet_names = state.sheet_names.read().unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();
    let sheet_visibility = state.sheet_visibility.read().unwrap();

    let count = sheet_names.len();
    if count == 0 {
        return Err("No sheets available".to_string());
    }

    // Find the previous visible sheet before the current one, wrapping around
    let mut prev_index = None;
    for offset in 1..count {
        let candidate = (active_sheet + count - offset) % count;
        let vis = sheet_visibility.get(candidate).map(|s| s.as_str()).unwrap_or("visible");
        if vis == "visible" {
            prev_index = Some(candidate);
            break;
        }
    }

    match prev_index {
        Some(idx) => {
            drop(sheet_names);
            drop(sheet_visibility);
            set_active_sheet(state, idx)
        }
        None => Err("No other visible sheet to navigate to".to_string()),
    }
}

// ============================================================================
// Tests: per-sheet HashMap store remapping
// ============================================================================

#[cfg(test)]
mod remap_tests {
    use super::*;

    #[test]
    fn indexed_map_delete_drops_and_shifts_down() {
        // Deleting sheet 1 of [0, 1, 2, 3]: entry 1 drops, 2 -> 1, 3 -> 2.
        let mut map: HashMap<usize, &str> =
            [(0, "a"), (1, "b"), (2, "c"), (3, "d")].into_iter().collect();
        let deleted = 1usize;
        remap_indexed_map(&mut map, |i| {
            if i == deleted {
                None
            } else if i > deleted {
                Some(i - 1)
            } else {
                Some(i)
            }
        });
        let expected: HashMap<usize, &str> =
            [(0, "a"), (1, "c"), (2, "d")].into_iter().collect();
        assert_eq!(map, expected);
    }

    #[test]
    fn indexed_map_move_follows_rotation() {
        // move_sheet(0 -> 2) over [0, 1, 2]: 0 -> 2, 1 -> 0, 2 -> 1 (the same
        // mapping the rotated Vec stores and report definitions receive).
        let (from_index, to_index) = (0usize, 2usize);
        let remap = |i: usize| -> usize {
            if i == from_index {
                to_index
            } else if from_index < to_index && i > from_index && i <= to_index {
                i - 1
            } else if to_index < from_index && i >= to_index && i < from_index {
                i + 1
            } else {
                i
            }
        };
        let mut map: HashMap<usize, &str> =
            [(0, "a"), (1, "b"), (2, "c")].into_iter().collect();
        remap_indexed_map(&mut map, |i| Some(remap(i)));
        let expected: HashMap<usize, &str> =
            [(2, "a"), (0, "b"), (1, "c")].into_iter().collect();
        assert_eq!(map, expected);
    }

    #[test]
    fn indexed_map_insert_shifts_up_at_and_above() {
        // copy_sheet inserting at index 1: 0 stays, 1 -> 2, 2 -> 3; the new
        // sheet (index 1) starts with no entry.
        let insert_at = 1usize;
        let mut map: HashMap<usize, &str> =
            [(0, "a"), (1, "b"), (2, "c")].into_iter().collect();
        remap_indexed_map(&mut map, |i| Some(if i >= insert_at { i + 1 } else { i }));
        let expected: HashMap<usize, &str> =
            [(0, "a"), (2, "b"), (3, "c")].into_iter().collect();
        assert_eq!(map, expected);
        assert!(!map.contains_key(&insert_at));
    }

    #[test]
    fn cell_keyed_map_remaps_sheet_component_only() {
        // Shared shape of cell_types, on-grid controls, and spill_hosts:
        // (sheet_index, row, col) keys where only the sheet component remaps.
        let mut map: HashMap<(usize, u32, u32), &str> = [
            ((0, 5, 5), "keep"),
            ((1, 2, 3), "dropped"),
            ((2, 9, 9), "shifted"),
        ]
        .into_iter()
        .collect();
        let deleted = 1usize;
        remap_cell_keyed_map(&mut map, |i| {
            if i == deleted {
                None
            } else if i > deleted {
                Some(i - 1)
            } else {
                Some(i)
            }
        });
        let expected: HashMap<(usize, u32, u32), &str> =
            [((0, 5, 5), "keep"), ((1, 9, 9), "shifted")].into_iter().collect();
        assert_eq!(map, expected);
    }

    #[test]
    fn advanced_filter_shaped_map_survives_delete_shift() {
        // HashMap<usize, Vec<u32>> — the advanced_filter_hidden_rows shape;
        // hidden-row lists follow their sheet, the deleted sheet's list drops.
        let mut map: HashMap<usize, Vec<u32>> =
            [(0, vec![1, 2]), (1, vec![7]), (2, vec![9])].into_iter().collect();
        let deleted = 1usize;
        remap_indexed_map(&mut map, |i| {
            if i == deleted {
                None
            } else if i > deleted {
                Some(i - 1)
            } else {
                Some(i)
            }
        });
        let expected: HashMap<usize, Vec<u32>> =
            [(0, vec![1, 2]), (1, vec![9])].into_iter().collect();
        assert_eq!(map, expected);
    }

    #[test]
    fn spill_twin_pair_remaps_consistently_under_the_same_mapping() {
        // spill_hosts (spill cell -> origin) and spill_ranges (origin -> its
        // spill cells) are maintained in lockstep; both sides must remap with
        // the SAME mapping or spill protection mis-targets. Simulate
        // move_sheet(2 -> 0) over three sheets.
        let (from_index, to_index) = (2usize, 0usize);
        let remap = |i: usize| -> usize {
            if i == from_index {
                to_index
            } else if from_index < to_index && i > from_index && i <= to_index {
                i - 1
            } else if to_index < from_index && i >= to_index && i < from_index {
                i + 1
            } else {
                i
            }
        };
        // Origin (2, 0, 0) spills into (2, 1, 0) and (2, 2, 0); an unrelated
        // spill lives on sheet 0 (shifts to 1 when sheet 2 moves in front).
        let mut hosts: HashMap<(usize, u32, u32), (u32, u32)> = [
            ((2, 1, 0), (0, 0)),
            ((2, 2, 0), (0, 0)),
            ((0, 4, 4), (3, 4)),
        ]
        .into_iter()
        .collect();
        let mut ranges: HashMap<(usize, u32, u32), Vec<(u32, u32)>> = [
            ((2, 0, 0), vec![(1, 0), (2, 0)]),
            ((0, 3, 4), vec![(4, 4)]),
        ]
        .into_iter()
        .collect();
        remap_cell_keyed_map(&mut hosts, |i| Some(remap(i)));
        remap_cell_keyed_map(&mut ranges, |i| Some(remap(i)));

        // The moved sheet's spill state follows it to index 0; the twin pair
        // stays consistent: every spill cell's origin range still lists it.
        assert!(ranges.contains_key(&(0, 0, 0)));
        assert!(ranges.contains_key(&(1, 3, 4)));
        for (&(sheet, row, col), &(origin_r, origin_c)) in &hosts {
            let cells = ranges
                .get(&(sheet, origin_r, origin_c))
                .expect("every spill cell's origin range survives on the same sheet");
            assert!(cells.contains(&(row, col)));
        }
    }
}

#[cfg(test)]
mod sheet_zoom_tests {
    //! `sheet_zooms` is a per-sheet vector kept PARALLEL to `sheet_names`, like
    //! `freeze_configs` / `split_configs` / `show_gridlines`. Every parallel
    //! vector has the same failure mode: one of the four lifecycle sites is
    //! missed, the vectors desynchronise, and from then on every sheet reads
    //! its neighbour's setting. There is no way to build a `tauri::State` in a
    //! unit test, so the lifecycle sites are guarded at the SOURCE level --
    //! which is the level the mistake is actually made at.

    const SHEETS_SRC: &str = include_str!("sheets.rs");

    /// Return the body of a `pub fn NAME(` in this file, up to the next
    /// top-level `pub fn`. A `pub(crate) fn NAME(` (the partition helper, which
    /// is no command) ends at its OWN closing brace instead: the next `pub fn`
    /// after it is a long way off, and a span that swallowed a neighbour's
    /// rotation would let the census pass over a helper that rotates nothing.
    fn function_body(name: &str) -> &'static str {
        let needle = format!("pub fn {name}(");
        if let Some(start) = SHEETS_SRC.find(&needle) {
            let rest = &SHEETS_SRC[start + needle.len()..];
            return match rest.find("\npub fn ") {
                Some(end) => &rest[..end],
                None => rest,
            };
        }
        let needle = format!("pub(crate) fn {name}(");
        let start = SHEETS_SRC
            .find(&needle)
            .unwrap_or_else(|| panic!("sheets.rs no longer defines `pub fn {name}(`"));
        let rest = &SHEETS_SRC[start + needle.len()..];
        match rest.find("\n}\n") {
            Some(end) => &rest[..end],
            None => rest,
        }
    }

    /// The lifecycle sites that must keep every per-sheet vector aligned. The
    /// fifth is not a command: `restore_partition_invariant` rotates the whole
    /// sheet list when a `.calp` pull lands a block behind an object tail, and
    /// a vector it forgot would pair every moved sheet with its neighbour's
    /// value.
    const LIFECYCLE_OPS: [&str; 5] = [
        "add_sheet",
        "delete_sheet",
        "move_sheet",
        "copy_sheet",
        "restore_partition_invariant",
    ];

    /// Every sheet lifecycle operation must maintain `sheet_zooms` alongside
    /// the split configs it sits next to. Adding a sheet and forgetting this is
    /// how sheet 3 ends up rendering at sheet 2's zoom.
    #[test]
    fn every_sheet_lifecycle_op_maintains_the_zoom_vector() {
        for op in LIFECYCLE_OPS {
            let body = function_body(op);
            assert!(
                body.contains("split_configs"),
                "test is out of date: `{op}` no longer touches split_configs"
            );
            assert!(
                body.contains("sheet_zooms"),
                "`{op}` maintains split_configs but NOT sheet_zooms -- the \
                 per-sheet vectors will desynchronise and every sheet after \
                 the change will read its neighbour's zoom"
            );
        }
    }

    /// The CODE of a body: every line whose first non-blank text is `//` is
    /// dropped, so a comment that names a store cannot stand in for the
    /// statement that maintains it.
    fn code_lines(body: &str) -> String {
        body.lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The statement each lifecycle op must contain to keep a per-sheet vector
    /// aligned. Merely NAMING the store is not enough: every op's span already
    /// names `sheet_kinds` through its `build_sheet_list(..)` call, which is how
    /// the first version of this census stayed green with the move rotation
    /// deleted.
    fn maintaining_statement(store: &str, op: &str) -> String {
        match op {
            "add_sheet" | "move_sheet" | "restore_partition_invariant" => {
                format!("rotate_element(&mut *{store}")
            }
            "delete_sheet" => format!("{store}.remove("),
            "copy_sheet" => format!("{store}.insert("),
            other => panic!("no maintaining statement known for `{other}`"),
        }
    }

    fn assert_maintains(body: &str, store: &str, op: &str) -> Result<(), String> {
        let needle = maintaining_statement(store, op);
        if code_lines(body).contains(&needle) {
            Ok(())
        } else {
            Err(format!(
                "`{op}` does not maintain `{store}` (no `{needle}` outside comments) -- \
                 every sheet after the change would read its neighbour's value"
            ))
        }
    }

    /// Same guard for the per-sheet KIND vector. Desynchronising it would turn a
    /// worksheet into a canvas (its cells vanish from the screen and every
    /// write to it is refused) or a canvas into a worksheet (its hidden pivot
    /// cells appear under its objects) -- on the sheet NEXT to the one changed.
    #[test]
    fn every_sheet_lifecycle_op_maintains_the_sheet_kinds_vector() {
        for op in LIFECYCLE_OPS {
            assert_maintains(function_body(op), "sheet_kinds", op).unwrap();
        }
    }

    /// Same guard for `page_setups`. `delete_sheet` once removed every per-sheet
    /// vector EXCEPT this one, so each sheet after a deleted one saved its
    /// neighbour's page setup, and nothing failed.
    #[test]
    fn every_sheet_lifecycle_op_maintains_the_page_setups_vector() {
        for op in LIFECYCLE_OPS {
            assert_maintains(function_body(op), "page_setups", op).unwrap();
        }
    }

    /// Every vector `add_sheet`'s partition branch rotates, the pull-side
    /// partition helper rotates too -- DERIVED from `add_sheet`'s own body, so a
    /// sixteenth aligned vector added there cannot be forgotten here. The two
    /// are one rule applied to one sheet and to a block.
    #[test]
    fn the_partition_helper_rotates_every_vector_add_sheet_rotates() {
        let add = code_lines(function_body("add_sheet"));
        let helper = code_lines(function_body("restore_partition_invariant"));
        let mut rotated: Vec<String> = Vec::new();
        for piece in add.split("rotate_element(&mut *").skip(1) {
            let name: String = piece
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            if !name.is_empty() && !rotated.contains(&name) {
                rotated.push(name);
            }
        }
        assert!(
            rotated.len() >= 16,
            "the parse no longer sees add_sheet's rotations (found {rotated:?}) -- \
             this census would pass over nothing"
        );
        let missing: Vec<&String> = rotated
            .iter()
            .filter(|name| !helper.contains(&format!("rotate_element(&mut *{name}")))
            .collect();
        assert!(
            missing.is_empty(),
            "restore_partition_invariant does not rotate {missing:?}, which add_sheet \
             does -- a pull behind an object tail would pair every moved sheet with \
             its neighbour's value"
        );
        assert!(
            helper.contains("rotate_user_hidden_sheet(") && add.contains("rotate_user_hidden_sheet("),
            "the user-hidden row/column vectors rotate through their own helper, in both"
        );
        for rekey in ["remap_sheet_keyed_stores(", "remap_tables_store(", "remap_note_and_hyperlink_stores("] {
            assert!(helper.contains(rekey), "restore_partition_invariant must call {rekey}");
        }
    }

    /// The census has teeth: a body that only NAMES the store -- in a comment,
    /// or through a `build_sheet_list(..)` read -- fails it.
    #[test]
    fn the_maintenance_census_rejects_a_body_that_only_names_the_store() {
        let named_only = "\n    // sheet_kinds.remove(index) happens elsewhere\n    \
            sheets: build_sheet_list(&names, &state.sheet_kinds.read().unwrap()),\n";
        assert!(assert_maintains(named_only, "sheet_kinds", "delete_sheet").is_err());
        let real = "\n    sheet_kinds.remove(index);\n";
        assert!(assert_maintains(real, "sheet_kinds", "delete_sheet").is_ok());
    }

    /// Same guard for the per-sheet DISPLAY FLAGS vector. It is the newest parallel
    /// vector and therefore the likeliest one to be missed when a fifth lifecycle site
    /// appears; desynchronising it makes a sheet show its neighbour's display mode
    /// (e.g. formulas visible on the wrong sheet).
    #[test]
    fn every_sheet_lifecycle_op_maintains_the_display_flags_vector() {
        for op in LIFECYCLE_OPS {
            let body = function_body(op);
            assert!(
                body.contains("show_gridlines"),
                "test is out of date: `{op}` no longer touches show_gridlines"
            );
            assert!(
                body.contains("sheet_display_flags"),
                "`{op}` maintains show_gridlines but NOT sheet_display_flags -- the                  per-sheet vectors will desynchronise and every sheet after the                  change will read its neighbour's display mode"
            );
        }
    }

    /// The four flags are ONE unit: they must persist together, or a partial landing
    /// reproduces exactly the bug this closed (three flags survive a reload and the
    /// fourth silently resets).
    #[test]
    fn all_four_display_flags_round_trip_through_sheet_metadata() {
        let mut sheet = ::persistence::Sheet::new("S".to_string());
        sheet.display_zeros = false;
        sheet.show_formulas = true;
        sheet.view_mode = "pageBreakPreview".to_string();
        sheet.display_headings = false;

        let meta = calcula_format::sheet_metadata::SheetMetadata::from_sheet(&sheet);
        let json = serde_json::to_string(&meta).unwrap();
        let back: calcula_format::sheet_metadata::SheetMetadata = serde_json::from_str(&json).unwrap();
        let mut restored = ::persistence::Sheet::new("S".to_string());
        back.apply_to_sheet(&mut restored);

        assert!(!restored.display_zeros, "displayZeros lost in round-trip");
        assert!(restored.show_formulas, "showFormulas lost in round-trip");
        assert_eq!(restored.view_mode, "pageBreakPreview", "viewMode lost in round-trip");
        assert!(!restored.display_headings, "displayHeadings lost in round-trip");

        // camelCase over the IPC/file boundary, per the golden rule.
        assert!(json.contains("\"displayZeros\""), "camelCase key expected: {json}");
        assert!(json.contains("\"showFormulas\""), "camelCase key expected: {json}");
        assert!(json.contains("\"viewMode\""), "camelCase key expected: {json}");
        assert!(json.contains("\"displayHeadings\""), "camelCase key expected: {json}");
    }

    /// A sheet at the defaults must NOT write the keys at all -- that is what keeps an
    /// ordinary workbook below the v6 format link and openable by older builds.
    #[test]
    fn default_display_flags_are_omitted_so_ordinary_workbooks_stay_pre_v6() {
        let sheet = ::persistence::Sheet::new("S".to_string());
        let meta = calcula_format::sheet_metadata::SheetMetadata::from_sheet(&sheet);
        let json = serde_json::to_string(&meta).unwrap();
        assert!(!json.contains("displayZeros"), "default must be omitted: {json}");
        assert!(!json.contains("showFormulas"), "default must be omitted: {json}");
        assert!(!json.contains("viewMode"), "default must be omitted: {json}");
        assert!(!json.contains("displayHeadings"), "default must be omitted: {json}");
        assert!(!meta.has_non_default_display_flags());
    }

    /// The setter must reject nonsense rather than clamp it: a caller asking
    /// for 0% or 5000% has a bug, and substituting a different number hides it.
    /// The band must be the SAME one the script API enforces.
    #[test]
    fn the_zoom_setter_shares_one_band_with_the_script_api() {
        let body = function_body("set_sheet_zoom");
        assert!(
            body.contains("ZOOM_MIN_PERCENT") && body.contains("ZOOM_MAX_PERCENT"),
            "set_sheet_zoom must validate against script_engine's band, not a \
             re-typed literal -- the UI and the script API disagreeing about \
             the legal range is the split-brain this replaced"
        );
        assert!(
            body.contains("return Err("),
            "set_sheet_zoom must REJECT an out-of-range zoom, not clamp it"
        );
    }

    /// The percent band itself: 10..400, matching Excel and `api.setZoom`.
    #[test]
    fn the_zoom_band_is_ten_to_four_hundred_percent() {
        assert_eq!(script_engine::types::ZOOM_MIN_PERCENT, 10.0);
        assert_eq!(script_engine::types::ZOOM_MAX_PERCENT, 400.0);
    }

    /// Writing a zoom stores it on the ACTIVE sheet and reports the change, so
    /// the command knows to dirty the workbook. Re-writing the SAME zoom
    /// reports no change — otherwise the sheet-switch hydration, which reads a
    /// value and hands it straight back, would dirty a document nobody edited
    /// and produce a spurious "save your changes?" on close.
    #[test]
    fn writing_a_zoom_reports_a_real_change_but_a_no_op_write_does_not() {
        let state = crate::create_app_state();
        let fs = crate::persistence::FileState::default();
        {
            let mut names = state
                .sheet_names
                .write(&crate::document_effect::test_seed_effect())
                .unwrap();
            *names = vec!["Sheet1".into(), "Sheet2".into()];
        }
        {
            let mut zooms = state
                .sheet_zooms
                .write(&crate::document_effect::test_seed_effect())
                .unwrap();
            *zooms = vec![100.0, 100.0];
        }
        *state.active_sheet.write(&crate::document_effect::test_seed_effect()).unwrap() = 1;

        assert!(super::set_sheet_zoom_inner(&state, &fs, 60.0).unwrap());
        assert!(
            !super::set_sheet_zoom_inner(&state, &fs, 60.0).unwrap(),
            "re-writing the same zoom is not a change"
        );

        let zooms = state.sheet_zooms.read().unwrap();
        assert_eq!(zooms[0], 100.0, "only the ACTIVE sheet may be written");
        assert_eq!(zooms[1], 60.0);
    }

    /// Out-of-band and non-finite zooms are REJECTED, not clamped and not
    /// silently stored — a NaN zoom reaching the renderer blanks the grid.
    #[test]
    fn an_illegal_zoom_is_refused_and_leaves_the_stored_value_alone() {
        let state = crate::create_app_state();
        let fs = crate::persistence::FileState::default();
        for bad in [0.0, 9.9, 400.1, 5000.0, f64::NAN, f64::INFINITY] {
            assert!(
                super::set_sheet_zoom_inner(&state, &fs, bad).is_err(),
                "{bad} must be refused"
            );
        }
        assert_eq!(
            *state.sheet_zooms.read().unwrap(),
            vec![persistence::DEFAULT_SHEET_ZOOM_PERCENT]
        );

        // The edges themselves are legal.
        assert!(super::set_sheet_zoom_inner(&state, &fs, 10.0).is_ok());
        assert!(super::set_sheet_zoom_inner(&state, &fs, 400.0).is_ok());
    }
}

// ---------------------------------------------------------------------------
// BUG-0047 — tables must follow their sheet through a move and a copy
// ---------------------------------------------------------------------------
//
// `tables` is the one sheet-index-keyed store that is NOT in
// `remap_sheet_keyed_stores`: `delete_sheet` re-keys it inline, because the
// same pass has to drop the deleted sheet's table NAMES out of `table_names`
// and a generic remap cannot do that half. The consequence was that `move_sheet`
// and `copy_sheet` re-keyed every OTHER per-sheet store and left this one where
// it was.
//
// MEASURED: soak seed 1786446166374, minimized by the shrinker to nine actions
// (add a sheet, create a table on it, hide it, move the other sheet past it).
// The sheet's AutoFilter moved with it and its table did not, so on reload
// `relink_autofilter_owner` found no table under the filter's index and the
// link was gone. The lost link is the visible half; the table itself was left
// attached to another sheet, which is what every structured reference resolves
// through.

#[cfg(test)]
mod tables_remap_tests {
    use super::*;
    use crate::tables::Table;

    fn table_on(sheet: usize, name: &str) -> Table {
        Table {
            id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            name: name.to_string(),
            sheet_index: sheet,
            start_row: 0,
            start_col: 0,
            end_row: 5,
            end_col: 3,
            columns: vec![],
            style_options: crate::tables::TableStyleOptions::default(),
            style_name: "TableStyleMedium2".to_string(),
            auto_filter_id: None,
        }
    }

    fn store_with(sheets: &[usize]) -> AppState {
        let state = crate::create_app_state();
        let effect = crate::document_effect::test_seed_effect();
        let mut tables = state.tables.write(&effect).unwrap();
        for (n, &s) in sheets.iter().enumerate() {
            let t = table_on(s, &format!("Table{}", n + 1));
            tables.entry(s).or_default().insert(t.id, t);
        }
        drop(tables);
        state
    }

    fn keys_and_stamps(state: &AppState) -> Vec<(usize, usize)> {
        let tables = state.tables.read().unwrap();
        let mut out: Vec<(usize, usize)> = tables
            .iter()
            .flat_map(|(k, m)| m.values().map(move |t| (*k, t.sheet_index)))
            .collect();
        out.sort();
        out
    }

    #[test]
    fn a_move_carries_the_table_and_re_stamps_its_sheet_index() {
        // Sheet 1 moves to position 0: its table must move with it, KEY and
        // FIELD together. A key that moved without the field is the same
        // divergence one layer down.
        let state = store_with(&[0, 1]);
        let effect = crate::document_effect::test_seed_effect();
        // move_sheet's own rotation remap for from=1, to=0.
        remap_tables_store(&state, &effect, |i| {
            Some(match i {
                1 => 0,
                0 => 1,
                other => other,
            })
        });
        assert_eq!(keys_and_stamps(&state), vec![(0, 0), (1, 1)]);
    }

    #[test]
    fn a_copy_shifts_everything_at_or_above_the_insertion_point() {
        let state = store_with(&[0, 1, 2]);
        let effect = crate::document_effect::test_seed_effect();
        let insert_at = 1usize;
        remap_tables_store(&state, &effect, |i| {
            Some(if i >= insert_at { i + 1 } else { i })
        });
        assert_eq!(keys_and_stamps(&state), vec![(0, 0), (2, 2), (3, 3)]);
    }

    #[test]
    fn a_dropped_sheet_takes_its_tables_with_it() {
        // The `None` arm, which `delete_sheet` uses inline today but which this
        // helper has to honour if it is ever adopted there.
        let state = store_with(&[0, 1]);
        let effect = crate::document_effect::test_seed_effect();
        remap_tables_store(&state, &effect, |i| if i == 1 { None } else { Some(i) });
        assert_eq!(keys_and_stamps(&state), vec![(0, 0)]);
    }

    #[test]
    fn the_identity_remap_changes_nothing() {
        // Non-vacuity: a helper that emptied the store would satisfy the drop
        // test above and lose every table.
        let state = store_with(&[0, 1, 2]);
        let effect = crate::document_effect::test_seed_effect();
        remap_tables_store(&state, &effect, Some);
        assert_eq!(keys_and_stamps(&state), vec![(0, 0), (1, 1), (2, 2)]);
    }

    /// Brace-matched body of a free function in this file.
    fn body_of(signature: &str) -> String {
        let src = include_str!("sheets.rs");
        let at = src
            .find(signature)
            .unwrap_or_else(|| panic!("{signature} not found — it was renamed"));
        let open = src[at..].find('{').expect("no body") + at;
        let bytes = src.as_bytes();
        let mut depth = 0usize;
        for i in open..src.len() {
            match bytes[i] {
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return src[open..=i].to_string();
                    }
                }
                _ => {}
            }
        }
        src[open..].to_string()
    }

    #[test]
    fn every_structural_command_re_keys_the_table_store() {
        // The census. `remap_sheet_keyed_stores` does not reach `tables`, so
        // "it is a sheet-keyed store" is not enough to keep the three commands
        // honest — each one has to be checked for it by name.
        // The commands' bodies live in the `_impl` testability split.
        let move_body = body_of("pub(crate) fn move_sheet_impl(");
        assert!(
            move_body.contains("remap_tables_store("),
            "`move_sheet` no longer re-keys the table store, so a table stays \
             registered under the index its sheet used to occupy (BUG-0047)."
        );
        let copy_body = body_of("pub(crate) fn copy_sheet_impl(");
        assert!(
            copy_body.contains("remap_tables_store("),
            "`copy_sheet` no longer shifts the table store, so an insertion \
             leaves every table above it on the wrong sheet (BUG-0047)."
        );
        // `delete_sheet` does it inline, in the pass that also drops the
        // deleted sheet's names out of `table_names`. Pinned by its own shape
        // rather than by the helper's name.
        // The command's body lives in the `_impl` testability split.
        let delete_body = body_of("pub(crate) fn delete_sheet_impl(");
        assert!(
            delete_body.contains("table.sheet_index = new_key"),
            "`delete_sheet` no longer re-stamps table sheet indices."
        );
    }
}

#[cfg(test)]
#[path = "hidden_active_sheet_tests.rs"]
mod hidden_active_sheet_tests;

#[cfg(test)]
#[path = "sheet_tab_state_undo_tests.rs"]
mod sheet_tab_state_undo_tests;

#[cfg(test)]
#[path = "object_sheet_tests.rs"]
mod object_sheet_tests;

#[cfg(test)]
#[path = "sheet_rename_repair_tests.rs"]
mod sheet_rename_repair_tests;

#[cfg(test)]
#[path = "sheet_structure_repair_tests.rs"]
mod sheet_structure_repair_tests;

#[cfg(test)]
mod rename_lock_order_tests {
    //! FIX ROUND 4, B2. `rename_sheet_inner` took `sheet_names`,
    //! `freeze_configs`, `tab_colors` and `sheet_visibility`, and only then
    //! `grids` and `grid`. The calculation pass takes `grid`, `grids` and then
    //! `sheet_names`, on a background thread, so the two could each hold what
    //! the other waited for.
    use super::*;
    use crate::document_effect::test_seed_effect;
    use std::time::Duration;

    #[test]
    fn renaming_a_sheet_never_holds_sheet_names_while_it_waits_for_the_grid_locks() {
        let state = crate::create_app_state();
        let file = FileState::default();
        let pivots = PivotState::new();
        let (parked, reached, result) = std::thread::scope(|scope| {
            // The pass at its third step: both grid locks held...
            let grid_guard = state.grid.write(&test_seed_effect()).unwrap();
            let grids_guard = state.grids.write(&test_seed_effect()).unwrap();
            let runner = scope.spawn(|| rename_sheet_inner(&state, &file, &pivots, 0, "Renamed".to_string(), false));
            std::thread::sleep(Duration::from_millis(300));
            // The rename needs the grid locks, so it cannot have finished.
            let parked = !runner.is_finished();
            // ...and `sheet_names` next. That must not wait on the rename.
            let (tx, rx) = std::sync::mpsc::channel();
            let state_ref = &state;
            let taker = scope.spawn(move || {
                let _g = state_ref.sheet_names.read().unwrap();
                let _ = tx.send(());
            });
            let reached = rx.recv_timeout(Duration::from_secs(3)).is_ok();
            drop(grids_guard); // let everyone finish, whatever happened
            drop(grid_guard);
            let result = runner.join().unwrap();
            taker.join().unwrap();
            (parked, reached, result)
        });
        result.expect("the rename");
        assert!(parked, "fixture: the rename did not wait for the grid locks");
        assert_eq!(state.sheet_names.read().unwrap()[0], "Renamed", "fixture: the rename landed");
        assert!(
            reached,
            "rename_sheet held sheet_names while it waited for grid/grids (ABBA against the calculation pass)"
        );
    }
}

#[cfg(test)]
mod append_user_sheet_tests {
    //! Found while routing fix round 4's B4 through `append_user_sheet`:
    //! `add_sheet` minted its document effect BEFORE the name's uniqueness
    //! check, so a refused duplicate name marked the document changed. The name
    //! is now resolved under PENDING guards and the effect minted after it.
    use super::*;

    #[test]
    fn a_refused_duplicate_sheet_name_leaves_the_document_clean() {
        let state = crate::create_app_state();
        let file = FileState::default();
        let err = add_sheet_inner(&state, &file, Some("sheet1".to_string()), ::persistence::SheetKind::Worksheet)
            .expect_err("a name another sheet has, ignoring case, must be refused");
        assert!(err.contains("already exists"), "got: {err}");
        assert!(!file.is_dirty(), "a refused duplicate sheet name marked the document changed");
        assert_eq!(state.sheet_names.read().unwrap().len(), 1, "a sheet was added anyway");
    }
}
