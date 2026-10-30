//! FILENAME: app/src-tauri/src/sparkline_commands.rs
//! Tauri commands for sparkline persistence.
//! Sparkline groups are stored as opaque JSON blobs (SparklineEntry) in AppState,
//! keyed by sheet index.
//! All mutations record obj_sparklines undo snapshots (BUG-0002: sparkline
//! lifecycle used to bypass the undo system entirely).

use crate::api_types::SparklineEntry;
use crate::document_effect::DocumentEffect;
use crate::persistence::FileState;
use crate::AppState;
use tauri::State;

// SPARKLINES ARE PERSISTED (`workbook.sparklines`), so all three mutators dirty the
// document. Like charts they already recorded undo entries -- an unambiguous
// declaration that the change is user-meaningful and must survive -- while marking
// nothing dirty, so drawing a sparkline group and closing lost it with no prompt, and
// AutoRecover declined to snapshot it either.
//
// ORDERING: `DocumentEffect::mutates` sets the flag in its constructor, so the
// "is there anything to change?" question is answered under a READ guard first.
// A delete/clear that finds nothing then returns having touched nothing and having
// left the document exactly as clean as it was.

/// Get all sparkline entries (all sheets).
#[tauri::command]
pub fn get_sparklines(state: State<AppState>) -> Vec<SparklineEntry> {
    state.sparklines.read().unwrap().clone()
}

/// The refusal [`save_sparklines`] answers when the save was made against
/// groups the store no longer holds for that sheet (its `base`). The
/// Sparklines store (extensions/Sparklines/store.ts) matches this prefix,
/// re-reads the sheet's groups, merges its change into them by group id and
/// saves again.
pub(crate) const SPARKLINE_GROUPS_CHANGED: &str = "SPARKLINE_GROUPS_CHANGED";

/// Save sparkline groups for a specific sheet (upsert by sheet_index).
///
/// `base`: the sheet's groups blob exactly as the caller last saw it stored
/// (`""` for "none stored"). When given and the store now holds anything else,
/// the save is refused with [`SPARKLINE_GROUPS_CHANGED`] and changes nothing
/// -- clean, no undo step. The store saves its WHOLE group list, and the
/// backend rewrites the stored list on its own in between: a structural edit
/// moves, splits or drops groups (BUG-0357, `chart_range_shift.rs`), an undo
/// puts an older list back. A save made before such a rewrite and landing
/// after it -- a sparkline change made while an Insert Rows runs -- used to
/// put the old ranges back over the moved ones (revF#4 item 2), the gap
/// `update_chart`'s `base` closed for charts.
#[tauri::command]
pub fn save_sparklines(
    state: State<AppState>,
    file_state: State<FileState>,
    entry: SparklineEntry,
    base: Option<String>,
) -> Result<(), String> {
    save_sparklines_against(&state, &file_state, entry, base.as_deref())
}

/// Is this stored blob "no sparklines at all"?
///
/// An ABSENT entry and an entry holding the empty list are the same document.
/// The frontend store serialises its (possibly empty) group list with
/// `JSON.stringify`, so a sheet that has never had a sparkline arrives here as
/// `"[]"`, while a sheet the backend has never heard of has no entry at all.
/// Treating those as different is what made a sheet switch a document change.
fn is_empty_sparkline_blob(blob: &str) -> bool {
    matches!(blob.trim(), "" | "[]" | "null")
}

/// Would writing `next` over `previous` change anything?
fn sparklines_unchanged(previous: Option<&str>, next: &str) -> bool {
    match previous {
        Some(prev) => prev == next || (is_empty_sparkline_blob(prev) && is_empty_sparkline_blob(next)),
        None => is_empty_sparkline_blob(next),
    }
}

/// Command body over plain references with no `base` (an unconditional save),
/// see `document_effect_wave2_tests`.
pub(crate) fn save_sparklines_impl(
    state: &AppState,
    file_state: &FileState,
    entry: SparklineEntry,
) -> Result<(), String> {
    save_sparklines_against(state, file_state, entry, None)
}

/// [`save_sparklines`] over plain references, `base` included.
pub(crate) fn save_sparklines_against(
    state: &AppState,
    file_state: &FileState,
    entry: SparklineEntry,
    base: Option<&str>,
) -> Result<(), String> {
    let sheet_index = entry.sheet_index;

    // PER-SHEET STATE MUST NAME A SHEET THAT EXISTS (BUG-0041).
    //
    // This extension saves on every SHEET_CHANGED (see the note below), and
    // SHEET_CHANGED also fires when the sheet COLLECTION changes -- add, rename,
    // move, DELETE. Delete the sheet a group lives on and that save arrives
    // naming the deleted index, re-inserting the very entry
    // `cascade_sheet_removed` had just dropped.
    //
    // The resurrected entry then had nowhere to go: on save `sheet_index_to_id`
    // minted a brand-new random id for the out-of-range index, and on load
    // `sheet_id_to_index` could not find that id and answered 0 -- so a
    // sparkline drawn on a DELETED sheet came back ON ANOTHER SHEET after a
    // reopen. Both of those fallbacks are gone now (persistence.rs), but the
    // first defence belongs here: the backend is the authority on which sheets
    // exist, so it does not take the caller's word for it.
    //
    // Refusing is silent and CLEAN on purpose -- the write is spurious, nothing
    // changed, and a document nobody edited must not be dirtied by it.
    {
        let sheet_count = state.sheet_names.read().map_err(|e| e.to_string())?.len();
        if sheet_index >= sheet_count {
            log::warn!(
                "[sparklines] refused a save naming sheet index {} ({} sheet(s) exist)",
                sheet_index,
                sheet_count
            );
            return Ok(());
        }
    }

    // AN UPSERT THAT CHANGES NOTHING IS NOT A DOCUMENT CHANGE.
    //
    // Resolved under a READ guard, before any `DocumentEffect::mutates` exists,
    // for the reason stated at the top of this file: `mutates` dirties in its
    // constructor, so the "is there anything to change?" question has to be
    // answered first or the answer no longer matters.
    //
    // This is not a micro-optimisation. The Sparklines extension saves
    // unconditionally on every SHEET_CHANGED (`saveNow()` in
    // `extensions/Sparklines/index.ts`), so before this guard existed a plain
    // sheet switch on a workbook with NO sparklines both dirtied a
    // just-saved document and pushed an undo entry ("Edit sparklines") that
    // restored nothing. Two user-visible consequences, measured on the running
    // app: the close prompt fired on a document nobody had edited, and the
    // user's next Ctrl+Z silently popped the junk entry instead of undoing
    // their last edit. `set_active_sheet` deliberately declares itself clean
    // for exactly this reason; an extension must not be able to overrule that
    // by writing back what it just read.
    //
    // THE BASE CHECK, THE NO-CHANGE CHECK AND THE WRITE IN ONE CRITICAL
    // SECTION (`lock_pending`): a rewrite landing between a check under a read
    // guard and a later write lock would be overwritten all the same. Both
    // refusals come before the effect, so they leave the document clean; the
    // list put on the undo stack is the one actually replaced.
    let previous = {
        let pending = state.sparklines.lock_pending().map_err(|e| e.to_string())?;
        let previous = pending
            .iter()
            .find(|s| s.sheet_index == sheet_index)
            .map(|s| s.groups_json.clone());
        if let Some(base) = base {
            // The same equivalence as the no-change check: an absent entry
            // and an empty list are one state, so a store that saw "none"
            // matches either.
            if !sparklines_unchanged(previous.as_deref(), base) {
                return Err(format!(
                    "{SPARKLINE_GROUPS_CHANGED}: the sparklines of sheet {} changed in the workbook \
                     after this edit was made; the edit was not written over them.",
                    sheet_index
                ));
            }
        }
        if sparklines_unchanged(previous.as_deref(), &entry.groups_json) {
            return Ok(());
        }
        let effect = DocumentEffect::mutates(file_state);
        let mut sparklines = pending.authorize(&effect);
        if let Some(existing) = sparklines
            .iter_mut()
            .find(|s| s.sheet_index == sheet_index)
        {
            *existing = entry;
        } else {
            sparklines.push(entry);
        }
        previous
    };
    crate::undo_commands::record_sparklines_undo(state, sheet_index, previous, "Edit sparklines");
    Ok(())
}

/// Delete sparkline data for a specific sheet.
#[tauri::command]
pub fn delete_sparklines(
    state: State<AppState>,
    file_state: State<FileState>,
    sheet_index: usize,
) -> Result<(), String> {
    delete_sparklines_impl(&state, &file_state, sheet_index)
}

/// Command body over plain references, so the "a delete that finds nothing stays clean"
/// contract is unit-testable (see `document_effect_wave2_tests`).
pub(crate) fn delete_sparklines_impl(
    state: &AppState,
    file_state: &FileState,
    sheet_index: usize,
) -> Result<(), String> {
    // Resolve under a read guard first: deleting sparklines from a sheet that has
    // none changes nothing and must not dirty the document.
    let previous = {
        let sparklines = state.sparklines.read().map_err(|e| e.to_string())?;
        sparklines
            .iter()
            .find(|s| s.sheet_index == sheet_index)
            .map(|s| s.groups_json.clone())
    };
    let Some(previous) = previous else {
        return Ok(());
    };
    let effect = DocumentEffect::mutates(&file_state);
    {
        let mut sparklines = state.sparklines.write(&effect).map_err(|e| e.to_string())?;
        sparklines.retain(|s| s.sheet_index != sheet_index);
    }
    crate::undo_commands::record_sparklines_undo(
        &state,
        sheet_index,
        Some(previous),
        "Delete sparklines",
    );
    Ok(())
}

/// Clear all sparkline data (all sheets).
#[tauri::command]
pub fn clear_all_sparklines(
    state: State<AppState>,
    file_state: State<FileState>,
) -> Result<(), String> {
    // Same read-first ordering: clearing an already-empty store is a no-op.
    if state.sparklines.read().map_err(|e| e.to_string())?.is_empty() {
        return Ok(());
    }
    let effect = DocumentEffect::mutates(&file_state);
    let entries = {
        let mut sparklines = state.sparklines.write(&effect).map_err(|e| e.to_string())?;
        let entries: Vec<SparklineEntry> = sparklines.drain(..).collect();
        entries
    };
    for entry in entries {
        crate::undo_commands::record_sparklines_undo(
            &state,
            entry.sheet_index,
            Some(entry.groups_json),
            "Clear sparklines",
        );
    }
    Ok(())
}

#[cfg(test)]
mod base_check_tests {
    //! revF#4 item 2: the Sparklines store saves a sheet's WHOLE group list, and
    //! a save made before the backend rewrote that list (a structural edit's
    //! range shift, an undo) could land after it and put the old ranges back.
    //! `save_sparklines`' `base` names the list the save was made against, and
    //! a save whose base the store no longer holds is refused.
    use super::{save_sparklines_against, SPARKLINE_GROUPS_CHANGED};
    use crate::api_types::SparklineEntry;
    use crate::document_effect::test_seed_effect;

    /// One line group, E{row0 + 1}:E{row1 + 1} over A:C, in the given colour.
    fn groups(row0: u32, row1: u32, color: &str) -> String {
        format!(
            r##"[{{"id":1,"location":{{"startRow":{row0},"startCol":4,"endRow":{row1},"endCol":4}},"dataRange":{{"startRow":{row0},"startCol":0,"endRow":{row1},"endCol":2}},"type":"line","color":"{color}"}}]"##
        )
    }

    fn stored(state: &crate::AppState) -> Option<String> {
        state.sparklines.read().unwrap().iter().find(|e| e.sheet_index == 0).map(|e| e.groups_json.clone())
    }

    /// SABOTAGE: skip the base comparison (`if false && ...`) -- the stale
    /// recolour is written over the moved ranges and `unwrap_err` panics.
    #[test]
    fn a_save_against_groups_the_store_no_longer_holds_is_refused_and_changes_nothing() {
        let state = crate::create_app_state();
        let fs = crate::persistence::FileState::default();
        let seen = groups(1, 4, "#4472C4");
        state
            .sparklines
            .write(&test_seed_effect())
            .unwrap()
            .push(SparklineEntry { sheet_index: 0, groups_json: seen.clone() });
        // The backend moves the ranges (an Insert Rows) after the store read them.
        let moved = groups(1, 5, "#4472C4");
        state.sparklines.write(&test_seed_effect()).unwrap()[0].groups_json = moved.clone();

        // The store's recolour, made against the list it SAW.
        let edit = SparklineEntry { sheet_index: 0, groups_json: groups(1, 4, "#000000") };
        let refused = save_sparklines_against(&state, &fs, edit, Some(&seen)).unwrap_err();
        assert!(refused.starts_with(SPARKLINE_GROUPS_CHANGED), "{refused}");
        assert_eq!(stored(&state), Some(moved.clone()), "the moved ranges are kept");
        assert!(!fs.is_dirty(), "a refused save leaves the document clean");
        assert!(!state.undo_stack.lock().unwrap().can_undo(), "and records no undo step");

        // Made against what IS stored: written, dirty, one undo step.
        let rebased = groups(1, 5, "#000000");
        save_sparklines_against(
            &state,
            &fs,
            SparklineEntry { sheet_index: 0, groups_json: rebased.clone() },
            Some(&moved),
        )
        .expect("the base matches");
        assert_eq!(stored(&state), Some(rebased));
        assert!(fs.is_dirty());
        assert!(state.undo_stack.lock().unwrap().can_undo());

        // No base: the save is unconditional, as every other caller's is.
        let unconditional = groups(9, 9, "#FF0000");
        save_sparklines_against(
            &state,
            &fs,
            SparklineEntry { sheet_index: 0, groups_json: unconditional.clone() },
            None,
        )
        .expect("no base, no check");
        assert_eq!(stored(&state), Some(unconditional));
    }

    /// "None stored" is one state however it is spelled: a store that saw no
    /// entry sends `""`, and the sheet may hold no entry or an empty list. A
    /// first group on such a sheet is written; once a group IS stored, a save
    /// made against "none" is refused.
    #[test]
    fn a_save_against_nothing_stored_matches_an_absent_or_empty_entry() {
        let state = crate::create_app_state();
        let fs = crate::persistence::FileState::default();
        let first = groups(1, 4, "#4472C4");
        save_sparklines_against(
            &state,
            &fs,
            SparklineEntry { sheet_index: 0, groups_json: first.clone() },
            Some(""),
        )
        .expect("no entry stored matches the empty base");
        assert_eq!(stored(&state), Some(first.clone()));

        let stale = save_sparklines_against(
            &state,
            &fs,
            SparklineEntry { sheet_index: 0, groups_json: groups(2, 3, "#000000") },
            Some(""),
        )
        .unwrap_err();
        assert!(stale.starts_with(SPARKLINE_GROUPS_CHANGED), "{stale}");
        assert_eq!(stored(&state), Some(first));

        state.sparklines.write(&test_seed_effect()).unwrap()[0].groups_json = "[]".to_string();
        save_sparklines_against(
            &state,
            &fs,
            SparklineEntry { sheet_index: 0, groups_json: groups(2, 3, "#000000") },
            Some(""),
        )
        .expect("an empty stored list is the same as none");
    }

    #[test]
    fn the_base_travels_as_an_optional_string() {
        // `invoke("save_sparklines", { entry, base })`: `base` is the stored
        // blob, `""` for none, and absent for an unconditional save.
        #[derive(serde::Deserialize)]
        #[allow(dead_code)]
        struct Args {
            entry: SparklineEntry,
            base: Option<String>,
        }
        let with: Args = serde_json::from_value(serde_json::json!({
            "entry": { "sheetIndex": 0, "groupsJson": "[]" }, "base": ""
        }))
        .unwrap();
        assert_eq!(with.base.as_deref(), Some(""));
        let without: Args =
            serde_json::from_value(serde_json::json!({ "entry": { "sheetIndex": 0, "groupsJson": "[]" } })).unwrap();
        assert!(without.base.is_none());
    }
}
