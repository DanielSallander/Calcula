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
}

fn default_visibility() -> String {
    "visible".to_string()
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
/// not cost the user their history) and with NO other state lock held. The
/// crate's canonical order takes `undo_stack` BEFORE `grid`/`grids`
/// (`undo_commands::apply_changes`), so taking it here while a grid guard is
/// alive would close a deadlock cycle against the background recalculation
/// pass. `sheet_structure_commands_invalidate_the_undo_history` in
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
fn remap_control_instance_id(
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
    remap_indexed_map(&mut state.data_validations.write(effect).unwrap(), &remap);
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
    remap_indexed_map(&mut state.advanced_filter_hidden_rows.lock().unwrap(), &remap);
    // Spill tracking is a TWIN pair maintained in lockstep in commands/data.rs
    // (spill_hosts: spill cell -> origin; spill_ranges: origin -> its spill
    // cells; both origins and spill cells are in-sheet coords). It is updated
    // incrementally per ACTIVE sheet — never rebuilt on sheet ops — so both
    // sides remap together (remapping one alone would desync the pair and
    // mis-target spill protection).
    remap_cell_keyed_map(&mut state.spill_hosts.lock().unwrap(), &remap);
    remap_cell_keyed_map(&mut state.spill_ranges.lock().unwrap(), &remap);
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
        sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &sheet_visibility),
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
            sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &sheet_visibility),
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
    // New sheet shows gridlines by default
    {
        let mut gridlines = state.show_gridlines.write(effect).unwrap();
        ensure_vec_len_with(&mut gridlines, existing, || true);
        gridlines.push(true);
    }
    {
        let mut display_flags = state.sheet_display_flags.write(effect).unwrap();
        ensure_vec_len(&mut display_flags, existing);
        display_flags.push(crate::api_types::SheetDisplayFlags::default());
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

#[tauri::command]
pub fn add_sheet(
    state: State<AppState>,
    file_state: State<FileState>,
    name: Option<String>,
) -> Result<SheetsResult, String> {
    add_sheet_inner(&state, &file_state, name)
}

/// Command body over plain references, so the partition-keeping branch has a
/// unit tier (`State<T>` cannot be built in a test). Same split as
/// `hide_sheet_inner` below.
pub(crate) fn add_sheet_inner(
    state: &AppState,
    file_state: &FileState,
    name: Option<String>,
) -> Result<SheetsResult, String> {
    crate::protection::check_workbook_structure(state, "add a sheet")?;
    // Excel's rule, checked BEFORE the document is marked modified: a refused
    // name must not dirty the workbook. The uniqueness half needs the sheet
    // list and is checked under the lock below.
    let name = match name {
        Some(requested) => Some(crate::sheet_names::validate_sheet_name(&requested)?),
        None => None,
    };
    // Past the workbook-structure protection gate. Adding a sheet appends to every
    // per-sheet persisted vector.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
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
    let mut column_widths = state.column_widths.write(&effect).unwrap();
    let mut row_heights = state.row_heights.write(&effect).unwrap();
    let mut all_column_widths = state.all_column_widths.write(&effect).unwrap();
    let mut all_row_heights = state.all_row_heights.write(&effect).unwrap();

    // A name the CALLER gave goes through Excel's rule; the default this
    // generates cannot violate it. The duplicate check is case-INSENSITIVE
    // (`crate::sheet_names`) -- sheet lookup is case-insensitive everywhere
    // else, so `sheet1` beside `Sheet1` was two sheets the rest of the crate
    // believed were one.
    let new_name = match name {
        Some(requested) => requested,
        None => {
            let mut counter = sheet_names.len() + 1;
            loop {
                let candidate = format!("Sheet{}", counter);
                if crate::sheet_names::ensure_sheet_name_is_free(&candidate, &sheet_names, None)
                    .is_ok()
                {
                    break candidate;
                }
                counter += 1;
            }
        }
    };

    crate::sheet_names::ensure_sheet_name_is_free(&new_name, &sheet_names, None)?;

    let old_index = *active_sheet;

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

    // Stash the ACTIVE sheet's view state before switching to the new one —
    // this is activation bookkeeping, deliberately outside `append_sheet_stores`
    // (an appended object sheet is never activated, so it must not stash).
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

    let (appended_at, _sheet_id) = append_sheet_stores(
        &state,
        &effect,
        new_name,
        "visible",
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

    *active_sheet = new_index;
    *current_grid = engine::grid::Grid::new();

    SheetsResult {
        sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &sheet_visibility),
        active_index: *active_sheet,
    }
    }; // drop all locks before rebuilding dependency maps

    // EXCEL PARITY: adding a sheet ends the undo history (BUG-0005). Runs with
    // every lock above released — see the function for the order that requires.
    invalidate_undo_history_for_sheet_structure(&state, "add a sheet");

    // The new (empty) sheet is now active — rebuild the single-sheet
    // dependency maps for it (see set_active_sheet / BUG-0016).
    crate::undo_commands::rebuild_all_dependencies(&state);

    Ok(result)
}

#[tauri::command]
pub fn delete_sheet(
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
    delete_sheet_impl(
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
    )
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
                crate::repair_3d_refs_on_delete(formula, &deleted_name, &names_after)
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
    // UNREACHABLE BY CONSTRUCTION: the pre-flight at the top of this command ran
    // the identical closure over the identical formulas and nothing between
    // there and here rewrites a cell. If it ever does fire, the repair wrote
    // NOTHING (it is all-or-nothing), so no formula has been corrupted — the
    // workbook is left with the sheet removed and a refusal the log names.
    if let Err(refusal) = crate::repair_all_formulas(&mut grids, &|formula| {
        crate::repair_3d_refs_on_delete(formula, &deleted_name, &names_after)
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
        crate::repair_3d_refs_on_delete(refers_to, &deleted_name, &names_after)
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
        sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &sheet_visibility),
        active_index: *active_sheet,
    }
    }; // drop all locks before rebuilding dependency maps

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
    index: usize,
    new_name: String,
) -> Result<SheetsResult, String> {
    rename_sheet_inner(&state, &file_state, index, new_name, false)
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
    index: usize,
    new_name: String,
    allow_object: bool,
) -> Result<SheetsResult, String> {
    crate::protection::check_workbook_structure(state, "rename a sheet")?;
    // Same reason the grid pair below is `lock_pending`: the three validation
    // gates can still refuse, and this guard has to be held across them.
    let sheet_names = state.sheet_names.lock_pending().unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();
    let freeze_configs = state.freeze_configs.read().unwrap();
    let tab_colors = state.tab_colors.read().unwrap();
    let sheet_visibility = state.sheet_visibility.read().unwrap();
    // Locked but UNDECIDED: the three validation gates below can still refuse,
    // and this command previously took no `FileState` at all -- renaming a sheet
    // rewrote every cross-sheet formula in the workbook and left the document
    // looking clean. `lock_pending` lets the gates read under the lock they
    // already hold and postpones the dirty decision past the last `return Err`.
    let grids = state.grids.lock_pending().unwrap();
    let current_grid = state.grid.lock_pending().unwrap();

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
        sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &sheet_visibility),
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
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let sheet_names = state.sheet_names.read().unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();
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
        sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &sheet_visibility),
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
            sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &sheet_visibility),
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
            let mut regions = state.protected_regions.lock().unwrap();
            for r in regions.iter_mut() {
                if r.region_type == "report" {
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
        sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &sheet_visibility),
        active_index: new_active,
    };

    // EVERY GUARD RELEASED, in one move, before the undo history is touched.
    // The crate's canonical order takes `undo_stack` BEFORE `grid`/`grids`
    // (`undo_commands::apply_changes`), and the background recalculation pass
    // takes the grid pair — so clearing the history while these are alive would
    // close the same deadlock cycle `state_digest_lock_order_tests` exists for.
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
    crate::protection::check_workbook_structure(&state, "copy a sheet")?;

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
            let mut regions = state.protected_regions.lock().unwrap();
            for r in regions.iter_mut() {
                if r.region_type == "report" && r.sheet_index >= insert_at {
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
        sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &sheet_visibility),
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
        // `undo_stack`, and the crate's canonical order puts `undo_stack` ahead
        // of the grid locks, so taking it under these guards would close a cycle
        // against the background recalculation pass -- the same reason
        // `invalidate_undo_history_for_sheet_structure` documents for its own
        // caller contract.
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
            sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &sheet_visibility),
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
    // `undo_stack`, which the crate's canonical order puts ahead of these.
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
            sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &sheet_visibility),
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
    // `undo_stack`, which the crate's canonical order puts ahead of these.
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
            sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &sheet_visibility),
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
    /// top-level `pub fn`.
    fn function_body(name: &str) -> &'static str {
        let needle = format!("pub fn {name}(");
        let start = SHEETS_SRC
            .find(&needle)
            .unwrap_or_else(|| panic!("sheets.rs no longer defines `pub fn {name}(`"));
        let rest = &SHEETS_SRC[start + needle.len()..];
        match rest.find("\npub fn ") {
            Some(end) => &rest[..end],
            None => rest,
        }
    }

    /// Every sheet lifecycle operation must maintain `sheet_zooms` alongside
    /// the split configs it sits next to. Adding a sheet and forgetting this is
    /// how sheet 3 ends up rendering at sheet 2's zoom.
    #[test]
    fn every_sheet_lifecycle_op_maintains_the_zoom_vector() {
        for op in ["add_sheet", "delete_sheet", "move_sheet", "copy_sheet"] {
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

    /// Same guard for the per-sheet DISPLAY FLAGS vector. It is the newest parallel
    /// vector and therefore the likeliest one to be missed when a fifth lifecycle site
    /// appears; desynchronising it makes a sheet show its neighbour's display mode
    /// (e.g. formulas visible on the wrong sheet).
    #[test]
    fn every_sheet_lifecycle_op_maintains_the_display_flags_vector() {
        for op in ["add_sheet", "delete_sheet", "move_sheet", "copy_sheet"] {
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
        let move_body = body_of("pub fn move_sheet(");
        assert!(
            move_body.contains("remap_tables_store("),
            "`move_sheet` no longer re-keys the table store, so a table stays \
             registered under the index its sheet used to occupy (BUG-0047)."
        );
        let copy_body = body_of("pub fn copy_sheet(");
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
