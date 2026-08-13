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

/// Save sparkline groups for a specific sheet (upsert by sheet_index).
#[tauri::command]
pub fn save_sparklines(
    state: State<AppState>,
    file_state: State<FileState>,
    entry: SparklineEntry,
) -> Result<(), String> {
    save_sparklines_impl(&state, &file_state, entry)
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

/// Command body over plain references (see `document_effect_wave2_tests`).
pub(crate) fn save_sparklines_impl(
    state: &AppState,
    file_state: &FileState,
    entry: SparklineEntry,
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
    let previous = {
        let sparklines = state.sparklines.read().map_err(|e| e.to_string())?;
        sparklines
            .iter()
            .find(|s| s.sheet_index == sheet_index)
            .map(|s| s.groups_json.clone())
    };
    if sparklines_unchanged(previous.as_deref(), &entry.groups_json) {
        return Ok(());
    }

    let effect = DocumentEffect::mutates(&file_state);
    {
        let mut sparklines = state.sparklines.write(&effect).map_err(|e| e.to_string())?;
        if let Some(existing) = sparklines
            .iter_mut()
            .find(|s| s.sheet_index == sheet_index)
        {
            *existing = entry;
        } else {
            sparklines.push(entry);
        }
    }
    crate::undo_commands::record_sparklines_undo(&state, sheet_index, previous, "Edit sparklines");
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
