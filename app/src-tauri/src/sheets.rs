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

fn build_sheet_list(
    sheet_names: &[String],
    freeze_configs: &[FreezeConfig],
    tab_colors: &[String],
    sheet_visibility: &[String],
) -> Vec<SheetInfo> {
    sheet_names
        .iter()
        .enumerate()
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

fn ensure_vec_len_with<T, F: Fn() -> T>(v: &mut Vec<T>, min_len: usize, make: F) {
    while v.len() < min_len {
        v.push(make());
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
    // QUEUED UNDO ENTRIES FIRST.
    //
    // Every `obj_*` CustomRestore payload identifies its target sheet by INDEX,
    // and this function is called precisely when those indices are renumbered.
    // The live stores below were always remapped; the undo stack never was, so
    // undoing past a sheet delete replayed a restore into whatever sheet had
    // since taken that index — silently corrupting it, with no error and
    // nothing to see.
    //
    // Done generically over the JSON rather than per-kind: every snapshot spells
    // the field `sheet_index` at the top level, so one rewrite covers all of
    // them and any kind added later. A payload whose sheet is GONE is replaced
    // with a no-op empty object: dropping the change would desynchronise the
    // transaction's inverse, and leaving it would let it fire on the wrong sheet.
    if let Ok(mut undo) = state.undo_stack.lock() {
        undo.visit_custom_restores(|kind, data| {
            let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(data) else {
                return; // Not JSON we understand; leave it untouched.
            };
            let Some(obj) = value.as_object_mut() else { return };

            // obj_controls is the one kind whose sheet indices do NOT sit in a
            // top-level `sheet_index`: they live inside every `(sheet,row,col)`
            // key tuple AND inside `control-<sheet>-<row>-<col>` instance-id
            // strings. The generic rewrite below would skip it entirely.
            if kind == "obj_controls" {
                if let Some(controls) = obj.get_mut("controls").and_then(|v| v.as_array_mut()) {
                    controls.retain_mut(|entry| {
                        let Some(key) = entry
                            .as_array_mut()
                            .and_then(|pair| pair.first_mut())
                            .and_then(|k| k.as_array_mut())
                        else {
                            return true;
                        };
                        let Some(old) = key.first().and_then(|v| v.as_u64()) else {
                            return true;
                        };
                        match remap(old as usize) {
                            Some(new_index) => {
                                key[0] = serde_json::json!(new_index);
                                true
                            }
                            None => false, // Sheet deleted: drop the entry.
                        }
                    });
                }
                if let Some(ids) = obj.get_mut("script_instance_ids").and_then(|v| v.as_array_mut()) {
                    for entry in ids.iter_mut() {
                        let Some(prev) = entry.as_array_mut().and_then(|pair| pair.get_mut(1)) else {
                            continue;
                        };
                        let Some(s) = prev.as_str() else { continue };
                        match remap_control_instance_id(s, &remap) {
                            Some(Some(new_id)) => *prev = serde_json::json!(new_id),
                            Some(None) => *prev = serde_json::Value::Null,
                            None => {}
                        }
                    }
                }
                if let Ok(bytes) = serde_json::to_vec(&value) {
                    *data = bytes;
                }
                return;
            }

            let Some(old) = obj.get("sheet_index").and_then(|v| v.as_u64()) else { return };
            match remap(old as usize) {
                Some(new_index) => {
                    obj.insert("sheet_index".into(), serde_json::json!(new_index));
                }
                None => {
                    // Sheet deleted: neutralise the payload. The restore arm
                    // fails to deserialize it, logs, and returns without
                    // touching any store.
                    *obj = serde_json::Map::new();
                }
            }
            if let Ok(bytes) = serde_json::to_vec(&value) {
                *data = bytes;
            }
        });
    }

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

#[tauri::command]
pub fn add_sheet(
    state: State<AppState>,
    file_state: State<FileState>,
    name: Option<String>,
) -> Result<SheetsResult, String> {
    crate::protection::check_workbook_structure(&state, "add a sheet")?;
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

    sheet_names.push(new_name);
    let new_grid = engine::grid::Grid::new();
    grids.push(new_grid.clone());
    freeze_configs.push(FreezeConfig::default());
    {
        let mut split_configs = state.split_configs.write(&effect).unwrap();
        split_configs.push(SplitConfig::default());
    }
    {
        let mut scroll_areas = state.scroll_areas.lock().unwrap();
        scroll_areas.push(None);
    }
    {
        let mut sheet_zooms = state.sheet_zooms.write(&effect).unwrap();
        sheet_zooms.push(persistence::DEFAULT_SHEET_ZOOM_PERCENT);
    }
    {
        // Keep page_setups parallel to the sheet list — open_file
        // materializes a default for every sheet, so a missing entry here
        // shows up as a save/reload digest diff.
        let mut page_setups = state.page_setups.write(&effect).unwrap();
        page_setups.push(crate::api_types::PageSetup::default());
    }
    {
        let mut sheet_ids = state.sheet_ids.write(&effect).unwrap();
        sheet_ids.push(identity::SheetId::from_bytes(identity::generate_uuid_v7()));
    }
    tab_colors.push(String::new());
    sheet_visibility.push("visible".to_string());
    // New sheet shows gridlines by default
    {
        let mut gridlines = state.show_gridlines.write(&effect).unwrap();
        gridlines.push(true);
    }
    {
        let mut display_flags = state.sheet_display_flags.write(&effect).unwrap();
        display_flags.push(crate::api_types::SheetDisplayFlags::default());
    }
    // New sheet gets empty dimensions and merged regions
    all_column_widths.push(HashMap::new());
    all_row_heights.push(HashMap::new());
    crate::commands::dimensions::stash_active_user_hidden(&state, old_index);
    crate::commands::dimensions::push_user_hidden_sheet(&state, &effect);
    {
        let mut all_merged = state.all_merged_regions.write(&effect).unwrap();
        // Save current sheet's merged regions before switching
        let mut current_merged = state.merged_regions.write(&effect).unwrap();
        while all_merged.len() <= old_index {
            all_merged.push(HashSet::new());
        }
        all_merged[old_index] = std::mem::take(&mut *current_merged);
        all_merged.push(HashSet::new());
    }

    let new_index = sheet_names.len() - 1;
    *active_sheet = new_index;
    *current_grid = new_grid;

    SheetsResult {
        sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &sheet_visibility),
        active_index: *active_sheet,
    }
    }; // drop all locks before rebuilding dependency maps

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
    crate::protection::check_workbook_structure(&state, "delete a sheet")?;

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
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    // Tables and pivots removed BECAUSE their sheet went, collected inside the
    // guarded block and cascaded after every lock is released (§3bn): objects on
    // OTHER sheets can be bound to them.
    let mut removed_sources: Vec<crate::object_deps::DeletedSource> = Vec::new();
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

    Ok(result)
}

#[tauri::command]
pub fn rename_sheet(
    state: State<AppState>,
    file_state: State<crate::persistence::FileState>,
    index: usize,
    new_name: String,
) -> Result<SheetsResult, String> {
    crate::protection::check_workbook_structure(&state, "rename a sheet")?;
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

    // Helper: rotate an element in a Vec from `from` to `to`
    fn rotate_element<T>(v: &mut Vec<T>, from: usize, to: usize) {
        if from < to {
            // Move right: rotate left the subslice [from..=to]
            v[from..=to].rotate_left(1);
        } else {
            // Move left: rotate right the subslice [to..=from]
            v[to..=from].rotate_right(1);
        }
    }

    // Ensure all per-sheet vecs are long enough
    ensure_vec_len(&mut freeze_configs, count);
    ensure_vec_len(&mut tab_colors, count);
    ensure_vec_len(&mut sheet_visibility, count);
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

    Ok(SheetsResult {
        sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &sheet_visibility),
        active_index: new_active,
    })
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
    ensure_vec_len(&mut sheet_visibility, count);
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

    Ok(SheetsResult {
        sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &sheet_visibility),
        active_index: new_index,
    })
}

/// Hide a sheet. Cannot hide the last visible sheet.
/// `level` controls the visibility: "hidden" (default, unhidable from UI) or "veryHidden"
/// (only unhidable via code/VBA, not from the UI).
/// Returns the recommended new active_index (frontend should call set_active_sheet if it changed).
#[tauri::command]
pub fn hide_sheet(
    state: State<AppState>,
    file_state: State<FileState>,
    index: usize,
    level: Option<String>,
) -> Result<SheetsResult, String> {
    crate::protection::check_workbook_structure(&state, "hide a sheet")?;
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

    // Past the structure gate and both validations. `sheet.visibility` is persisted.
    // The last-visible-sheet check below can still refuse; it is a pure read of the
    // store, so a refused hide leaves the data untouched but the flag set -- a false
    // positive, which is the cheap direction. Every refusal that CAN be resolved
    // before the decision is.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut sheet_visibility = state.sheet_visibility.write(&effect).unwrap();

    ensure_vec_len(&mut sheet_visibility, sheet_names.len());

    // Check: at least one visible sheet must remain
    let visible_count = sheet_visibility.iter().enumerate()
        .filter(|(i, vis)| vis.as_str() == "visible" && *i != index)
        .count();
    if visible_count == 0 {
        return Err("Cannot hide the last visible sheet".to_string());
    }

    sheet_visibility[index] = hide_level;

    // If hiding the active sheet, recommend the nearest visible sheet
    let recommended_active = if index == active_sheet {
        (0..sheet_names.len())
            .find(|&i| sheet_visibility[i] == "visible")
            .unwrap_or(0)
    } else {
        active_sheet
    };

    Ok(SheetsResult {
        sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &sheet_visibility),
        active_index: recommended_active,
    })
}

/// Unhide a sheet.
#[tauri::command]
pub fn unhide_sheet(
    state: State<AppState>,
    file_state: State<FileState>,
    index: usize,
) -> Result<SheetsResult, String> {
    let sheet_names = state.sheet_names.read().unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();
    let freeze_configs = state.freeze_configs.read().unwrap();
    let tab_colors = state.tab_colors.read().unwrap();

    if index >= sheet_names.len() {
        return Err(format!("Sheet index {} out of range", index));
    }

    // Past the range check; `sheet.visibility` is persisted.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut sheet_visibility = state.sheet_visibility.write(&effect).unwrap();

    ensure_vec_len(&mut sheet_visibility, sheet_names.len());
    sheet_visibility[index] = "visible".to_string();

    Ok(SheetsResult {
        sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &sheet_visibility),
        active_index: active_sheet,
    })
}

/// Set the tab color for a sheet.
#[tauri::command]
pub fn set_tab_color(
    state: State<AppState>,
    file_state: State<FileState>,
    index: usize,
    color: String,
) -> Result<SheetsResult, String> {
    let sheet_names = state.sheet_names.read().unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();
    let freeze_configs = state.freeze_configs.read().unwrap();
    let sheet_visibility = state.sheet_visibility.read().unwrap();

    if index >= sheet_names.len() {
        return Err(format!("Sheet index {} out of range", index));
    }

    // Past the range check; `sheet.tab_color` is persisted.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut tab_colors = state.tab_colors.write(&effect).unwrap();

    ensure_vec_len(&mut tab_colors, sheet_names.len());
    tab_colors[index] = color;

    Ok(SheetsResult {
        sheets: build_sheet_list(&sheet_names, &freeze_configs, &tab_colors, &sheet_visibility),
        active_index: active_sheet,
    })
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
