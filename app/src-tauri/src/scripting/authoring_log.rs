//! FILENAME: app/src-tauri/src/scripting/authoring_log.rs
//! PURPOSE: The four commands that read and write the workbook's AI script
//!          authoring transcript — what the author asked for, what the model
//!          said, and what the author decided about it.
//!
//! CONTEXT: 2026-08-26, from one report: "I saw the diff page ... but I could
//!          not see the reasoning or the results from the chat." The live half
//!          of the fix keeps the model's prose instead of throwing it away; this
//!          is the half that makes it survive the window closing.
//!
//! THREE RULES, AND EACH ONE GUARDS A REAL FAILURE:
//!
//! 1. **Nothing REACHES THE FILE except through a decision.** An EDIT run is
//!    appended only when a human presses Accept, Reject or Save — an edit
//!    proposal's ARRIVAL writes nothing, because `objscript:ai-edit-result` is
//!    a Tauri channel a second window emits on, and a channel must not be able
//!    to dirty the user's workbook on its own. A CREATE run is the one
//!    delivery-time write: it is appended under its `draft-*` id the moment
//!    the draft is queued for review, `decision` unset — which is WHY
//!    `AuthoringRun.decision` is `Option` in both languages — and it rides a
//!    SESSION-ONLY bucket: `persist_script_authoring` filters `draft-*`
//!    buckets out of the archive, so being ADOPTED onto the saved script's id
//!    at Save is the only way a draft's runs become persistent.
//!
//! 2. **Idempotency on `run_id` lives HERE, not in the client.**
//!    `replayAiEditResults` re-sends every result on each `EDITOR_READY`
//!    (aiEditBridge.ts:53-58), and a reopened editor window has a fresh React
//!    ref — so a client-side dedupe cannot work by construction. A second append
//!    of the same `run_id` REPLACES the stored run and returns `Ok`.
//!
//! 3. **The effect is constructed after every refusal.** `DocumentEffect::mutates`
//!    dirties the document AT CONSTRUCTION, so possession of one is proof the
//!    flag is set. A refusal that has already minted one leaves a workbook that
//!    claims unsaved changes it does not have — and the user is prompted to save
//!    a document nothing changed.
//!
//! The runs are keyed by script id, or by the `draft-` id a draft carries before
//! it is saved. Any other id is refused against the workbook's own script index,
//! the way `workbook_script_hashes` refuses a schedule bound to a script the
//! workbook does not carry: a store of provenance about scripts that do not exist
//! is not a transparency feature, it is a place to plant fiction.

use tauri::State;

use calcula_format::features::script_authoring::{clamp_log, AuthoringRun, DRAFT_ID_PREFIX};

use crate::document_effect::DocumentEffect;
use crate::persistence::FileState;
use crate::scripting::types::ScriptState;
use crate::AppState;

// The `draft-` id prefix an unsaved AI draft carries is `DRAFT_ID_PREFIX`,
// imported above — ONE spelling, defined beside the schema in
// `calcula_format::features::script_authoring` and shared with the save/load
// filters in persistence.rs.
//
// It is the ONE exception to "the id must name a script this workbook carries",
// and it has to be: a create run is appended at draft DELIVERY, before the
// script it produced has ever been saved, so there is nothing in the index to
// match. The bucket it rides is SESSION-ONLY — the save path filters `draft-*`
// keys out of the archive — and `adopt_script_authoring_runs` re-keying it
// onto the saved script's id is what makes its runs persistent.

/// Is this id one this workbook can legitimately carry runs for?
///
/// Mirrors `workbook_script_hashes` (persistence.rs): object scripts AND module
/// scripts, because either can be authored with AI. Notebooks are absent for the
/// same reason they are absent there — nothing authors one through this path.
pub(crate) fn is_known_script_id(
    state: &AppState,
    script_state: &ScriptState,
    id: &str,
) -> bool {
    if id.starts_with(DRAFT_ID_PREFIX) {
        return true;
    }
    if state
        .object_scripts
        .read()
        .map(|s| s.iter().any(|s| s.id == id))
        .unwrap_or(false)
    {
        return true;
    }
    script_state
        .workbook_scripts
        .read()
        .map(|s| s.contains_key(id))
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// The core, written against plain references so every path is unit-testable
// without a Tauri app handle (the `restore_scheduled_jobs` precedent).
// ---------------------------------------------------------------------------

pub(crate) fn read_runs(state: &AppState, script_id: &str) -> Result<Vec<AuthoringRun>, String> {
    let log = state.script_authoring.read().map_err(|e| e.to_string())?;
    Ok(log.get(script_id).cloned().unwrap_or_default())
}

pub(crate) fn append_run(
    state: &AppState,
    script_state: &ScriptState,
    file_state: &FileState,
    script_id: &str,
    run: AuthoringRun,
) -> Result<(), String> {
    // REFUSE FIRST, under a read guard, so the refusal leaves the document clean.
    if script_id.is_empty() {
        return Err("An authoring run needs a script id.".to_string());
    }
    if run.run_id.is_empty() {
        return Err("An authoring run needs a run id.".to_string());
    }
    if !is_known_script_id(state, script_state, script_id) {
        return Err(format!(
            "This workbook carries no script '{}', so it cannot carry an authoring run for one.",
            script_id
        ));
    }

    // Past every refusal: NOW the document really is about to change.
    let effect = DocumentEffect::mutates(file_state);
    let mut log = state.script_authoring.write(&effect).map_err(|e| e.to_string())?;
    let runs = log.entry(script_id.to_string()).or_default();
    match runs.iter().position(|r| r.run_id == run.run_id) {
        // A REPLAY, not a second run. See rule 2 in the header.
        Some(at) => runs[at] = run,
        None => runs.push(run),
    }
    clamp_log(&mut log);
    Ok(())
}

pub(crate) fn adopt_runs(
    state: &AppState,
    script_state: &ScriptState,
    file_state: &FileState,
    from_id: &str,
    to_id: &str,
) -> Result<(), String> {
    if !from_id.starts_with(DRAFT_ID_PREFIX) {
        return Err(format!(
            "Only a draft's runs can be adopted; '{}' is not a draft id.",
            from_id
        ));
    }
    if to_id.is_empty() || to_id.starts_with(DRAFT_ID_PREFIX) {
        return Err("A draft's runs can only be adopted onto a saved script id.".to_string());
    }
    // The same refusal `append_run` makes, for the same reason: re-keying a
    // bucket onto an id the workbook does not carry is planting provenance for
    // a script that does not exist. Checked BEFORE the empty-bucket return, so
    // an invented target is refused even with nothing to move. (The draft arm
    // of `is_known_script_id` is unreachable here — a draft `to_id` was already
    // refused above.)
    if !is_known_script_id(state, script_state, to_id) {
        return Err(format!(
            "This workbook carries no script '{}', so a draft's runs cannot be adopted onto it.",
            to_id
        ));
    }
    // Nothing to move is not an error: a draft can exist with no recorded runs
    // (the delivery-time append is fire-and-forget, and a draft minted outside
    // the guided author path records none), and the save path calls this
    // unconditionally.
    if !state
        .script_authoring
        .read()
        .map_err(|e| e.to_string())?
        .contains_key(from_id)
    {
        return Ok(());
    }

    let effect = DocumentEffect::mutates(file_state);
    let mut log = state.script_authoring.write(&effect).map_err(|e| e.to_string())?;
    // ONE critical section, so the bucket can never be observed under both keys
    // or under neither.
    if let Some(mut moved) = log.remove(from_id) {
        let target = log.entry(to_id.to_string()).or_default();
        for run in moved.drain(..) {
            match target.iter().position(|r| r.run_id == run.run_id) {
                Some(at) => target[at] = run,
                None => target.push(run),
            }
        }
    }
    clamp_log(&mut log);
    Ok(())
}

/// Forget every run recorded against a script id.
///
/// A store of the user's own words that they cannot remove is not a transparency
/// feature. Deleting a script deletes its history with it (the no-ghosts rule the
/// scheduler already follows), and this is the same door opened deliberately.
pub(crate) fn clear_runs(
    state: &AppState,
    file_state: &FileState,
    script_id: &str,
) -> Result<(), String> {
    if !state
        .script_authoring
        .read()
        .map_err(|e| e.to_string())?
        .contains_key(script_id)
    {
        // Clearing nothing changes nothing, so it must not dirty the document.
        return Ok(());
    }
    let effect = DocumentEffect::mutates(file_state);
    let mut log = state.script_authoring.write(&effect).map_err(|e| e.to_string())?;
    log.remove(script_id);
    Ok(())
}

/// Drop a script's runs as part of a delete the CALLER has already decided is a
/// mutation. Takes the caller's effect for the same reason
/// `prune_scripts_for_instance` does — the delete owns the dirty-flag decision,
/// this is only its sweep. Lock poison is swallowed: cleanup must never turn a
/// successful delete into an error.
pub(crate) fn forget_script_runs(state: &AppState, effect: &DocumentEffect, script_id: &str) {
    if let Ok(mut log) = state.script_authoring.write(effect) {
        log.remove(script_id);
    }
}

// THE ABANDONED DRAFT IS NOT SWEPT HERE, because it does not need to be: a
// `draft-*` bucket is SESSION state. Nothing on this side can tell an abandoned
// draft from one the author is still thinking about — a draft lives in the
// editor window, and the backend sees only ids — so instead of guessing,
// `persist_script_authoring` filters draft buckets out of the serialized copy
// (and the load path drops any arriving from disk). An abandoned draft's runs
// die with the session rather than riding the archive as an orphan no surface
// can list, adopt or clear — a draft id is minted per process and dies with it.
// The one way a draft's runs become persistent is `adopt_script_authoring_runs`
// re-keying the bucket onto the id the draft was just saved as.

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------

/// Every run recorded for one script id. A read: no effect, no dirty flag.
#[tauri::command]
pub fn get_script_authoring_runs(
    state: State<AppState>,
    script_id: String,
    window: tauri::Window,
) -> Result<Vec<AuthoringRun>, String> {
    crate::security::window_guard::require_label(
        &window,
        crate::security::window_guard::MAIN_AND_OBJECT_SCRIPT_EDITOR,
    )?;
    read_runs(&state, &script_id)
}

/// Record one run — at decision time for an EDIT, at draft delivery (under the
/// `draft-*` id, decision unset) for a CREATE.
#[tauri::command]
pub fn append_script_authoring_run(
    state: State<AppState>,
    script_state: State<ScriptState>,
    file_state: State<FileState>,
    script_id: String,
    run: AuthoringRun,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(
        &window,
        crate::security::window_guard::MAIN_AND_OBJECT_SCRIPT_EDITOR,
    )?;
    append_run(&state, &script_state, &file_state, &script_id, run)
}

/// Re-key a draft's runs onto the script id it was just saved as. This is the
/// moment a draft's runs become persistent — the save path filters `draft-*`
/// buckets out of the archive, so an un-adopted bucket dies with the session.
#[tauri::command]
pub fn adopt_script_authoring_runs(
    state: State<AppState>,
    script_state: State<ScriptState>,
    file_state: State<FileState>,
    from_id: String,
    to_id: String,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(
        &window,
        crate::security::window_guard::MAIN_AND_OBJECT_SCRIPT_EDITOR,
    )?;
    adopt_runs(&state, &script_state, &file_state, &from_id, &to_id)
}

/// Forget one script's authoring history.
#[tauri::command]
pub fn clear_script_authoring_runs(
    state: State<AppState>,
    file_state: State<FileState>,
    script_id: String,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(
        &window,
        crate::security::window_guard::MAIN_AND_OBJECT_SCRIPT_EDITOR,
    )?;
    clear_runs(&state, &file_state, &script_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use calcula_format::features::script_authoring::{
        RunAttempt, MAX_REPLY_CHARS, MAX_RUNS_PER_SCRIPT,
    };

    fn stores() -> (AppState, ScriptState, FileState) {
        (
            crate::create_app_state(),
            ScriptState::new(),
            FileState::default(),
        )
    }

    fn run(id: &str) -> AuthoringRun {
        AuthoringRun {
            run_id: id.to_string(),
            kind: "edit".to_string(),
            outcome: "unchanged".to_string(),
            decision: Some("rejected".to_string()),
            decided_at: Some("2026-08-26T10:00:05Z".to_string()),
            started_at: "2026-08-26T10:00:00Z".to_string(),
            elapsed_ms: 5_000,
            instruction: "colour the negatives red".to_string(),
            object_type: "button".to_string(),
            provider_id: "ollama".to_string(),
            model: "qwen3:8b".to_string(),
            tier: "restricted".to_string(),
            surface_tokens: 3_200,
            surface_truncated: false,
            summary: "returned unchanged".to_string(),
            attempts: Vec::new(),
            notices: Vec::new(),
            changed_nothing: true,
            unexercised_hooks: Vec::new(),
            elided: None,
        }
    }

    fn fat_run(id: &str) -> AuthoringRun {
        let mut r = run(id);
        r.attempts = vec![RunAttempt {
            attempt: 1,
            at: 0,
            duration_ms: 10,
            ok: true,
            reply: "r".repeat(MAX_REPLY_CHARS),
            reply_chars: MAX_REPLY_CHARS as u32,
            note: "n".repeat(MAX_REPLY_CHARS),
            reasoning: String::new(),
            reasoning_chars: 0,
            findings: Vec::new(),
            dry_run: None,
        }];
        r
    }

    fn add_object_script(state: &AppState, id: &str) {
        let effect = DocumentEffect::deliberately_clean(
            crate::document_effect::CleanReason::LoadingFromDisk,
        );
        state
            .object_scripts
            .write(&effect)
            .unwrap()
            .push(persistence::SavedObjectScript {
                id: id.to_string(),
                name: format!("Script {}", id),
                object_type: persistence::ScriptableObjectType::Button,
                instance_id: Some("i1".to_string()),
                source: "export function setup(context) {}\n".to_string(),
                access_level: persistence::ScriptAccessLevel::Restricted,
                description: None,
                provenance: persistence::ScriptProvenance::Local,
                package_name: None,
                package_version: None,
                declared_capabilities: Vec::new(),
            });
    }

    // -----------------------------------------------------------------------
    // Test 41 — idempotency, and the two eviction rules
    // -----------------------------------------------------------------------

    #[test]
    fn the_same_run_id_replaces_rather_than_duplicates() {
        // THE WHOLE REASON A REACT REF WAS THE WRONG PLACE FOR THIS.
        // `replayAiEditResults` re-sends on every EDITOR_READY and a reopened
        // window has a fresh ref, so the dedupe has to live on this side.
        let (state, scripts, file) = stores();
        add_object_script(&state, "obj-1");

        append_run(&state, &scripts, &file, "obj-1", run("r1")).unwrap();
        let mut second = run("r1");
        second.decision = Some("accepted".to_string());
        second.summary = "the replay".to_string();
        append_run(&state, &scripts, &file, "obj-1", second).unwrap();

        let runs = read_runs(&state, "obj-1").unwrap();
        assert_eq!(runs.len(), 1, "a replayed run must not become a second run");
        assert_eq!(runs[0].summary, "the replay", "the replay replaces in place");
        assert_eq!(runs[0].decision.as_deref(), Some("accepted"));
    }

    #[test]
    fn forty_runs_leave_the_cap_with_the_first_ever_recorded_still_first() {
        let (state, scripts, file) = stores();
        add_object_script(&state, "obj-1");
        for i in 0..40 {
            append_run(&state, &scripts, &file, "obj-1", run(&format!("r{}", i))).unwrap();
        }
        let runs = read_runs(&state, "obj-1").unwrap();
        assert_eq!(runs.len(), MAX_RUNS_PER_SCRIPT);
        // Identity by run id, not by count: "the first run is still there" is a
        // claim about WHICH run, and a count cannot make it.
        assert_eq!(runs[0].run_id, "r0", "the first run is never evicted");
        assert_eq!(runs[runs.len() - 1].run_id, "r39");
    }

    #[test]
    fn the_byte_cap_never_drops_any_scripts_first_run() {
        let (state, scripts, file) = stores();
        for s in 0..5 {
            add_object_script(&state, &format!("obj-{}", s));
        }
        for s in 0..5 {
            for i in 0..MAX_RUNS_PER_SCRIPT {
                append_run(
                    &state,
                    &scripts,
                    &file,
                    &format!("obj-{}", s),
                    fat_run(&format!("s{}-r{}", s, i)),
                )
                .unwrap();
            }
        }
        for s in 0..5 {
            let runs = read_runs(&state, &format!("obj-{}", s)).unwrap();
            assert!(!runs.is_empty(), "obj-{} lost every run", s);
            assert_eq!(
                runs[0].run_id,
                format!("s{}-r0", s),
                "obj-{}'s first run was evicted to make room",
                s
            );
        }
    }

    // -----------------------------------------------------------------------
    // Test 42 — a refusal leaves no trace at all
    // -----------------------------------------------------------------------

    #[test]
    fn an_unknown_script_id_is_refused_and_leaves_the_document_clean() {
        // The effect is constructed AFTER the id check, so the refusal cannot
        // dirty the workbook. Sabotage: move `DocumentEffect::mutates` above the
        // `is_known_script_id` call and the clean assertion reds.
        let (state, scripts, file) = stores();
        add_object_script(&state, "obj-1");
        assert!(!file.is_dirty(), "the fixture starts clean");

        let before = state.script_authoring.read().unwrap().clone();
        let err = append_run(&state, &scripts, &file, "obj-nope", run("r1")).unwrap_err();
        assert!(err.contains("obj-nope"), "{}", err);

        assert_eq!(
            *state.script_authoring.read().unwrap(),
            before,
            "a refused append must leave the log byte-identical"
        );
        assert!(
            !file.is_dirty(),
            "a refused append must leave the document CLEAN"
        );
    }

    #[test]
    fn a_draft_id_is_the_one_exception_and_a_saved_id_still_has_to_exist() {
        let (state, scripts, file) = stores();
        // A create run is recorded before the script exists at all.
        append_run(&state, &scripts, &file, "draft-abc", run("r1")).unwrap();
        assert_eq!(read_runs(&state, "draft-abc").unwrap().len(), 1);
        // But a bare id that names nothing is still refused.
        assert!(append_run(&state, &scripts, &file, "obj-9", run("r2")).is_err());
    }

    #[test]
    fn a_module_script_id_is_known_too() {
        // `workbook_script_hashes` counts BOTH surfaces; so does this.
        let (state, scripts, file) = stores();
        let effect = DocumentEffect::deliberately_clean(
            crate::document_effect::CleanReason::LoadingFromDisk,
        );
        scripts.workbook_scripts.write(&effect).unwrap().insert(
            "mod-1".to_string(),
            crate::scripting::types::WorkbookScript {
                id: "mod-1".to_string(),
                name: "Module 1".to_string(),
                description: None,
                source: "export function setup(context) {}\n".to_string(),
                scope: crate::scripting::types::ScriptScope::Workbook,
                source_package: None,
            },
        );
        append_run(&state, &scripts, &file, "mod-1", run("r1")).unwrap();
        assert_eq!(read_runs(&state, "mod-1").unwrap().len(), 1);
    }

    #[test]
    fn a_successful_append_does_dirty_the_document() {
        // The positive control for the refusal test above. Without it, a version
        // that never dirties at all would pass that test too.
        let (state, scripts, file) = stores();
        add_object_script(&state, "obj-1");
        append_run(&state, &scripts, &file, "obj-1", run("r1")).unwrap();
        assert!(file.is_dirty());
    }

    // -----------------------------------------------------------------------
    // adopt / clear
    // -----------------------------------------------------------------------

    #[test]
    fn adopting_re_keys_a_draft_bucket_onto_the_saved_script() {
        let (state, scripts, file) = stores();
        append_run(&state, &scripts, &file, "draft-abc", run("r1")).unwrap();
        add_object_script(&state, "obj-7");

        adopt_runs(&state, &scripts, &file, "draft-abc", "obj-7").unwrap();

        assert!(read_runs(&state, "draft-abc").unwrap().is_empty());
        let runs = read_runs(&state, "obj-7").unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].run_id, "r1");
    }

    #[test]
    fn adopting_a_draft_that_recorded_nothing_is_a_clean_no_op() {
        let (state, scripts, file) = stores();
        add_object_script(&state, "obj-7");
        adopt_runs(&state, &scripts, &file, "draft-none", "obj-7").unwrap();
        assert!(
            !file.is_dirty(),
            "an abandoned draft with no runs must not dirty the workbook"
        );
    }

    #[test]
    fn only_a_draft_can_be_adopted_and_only_onto_a_real_id() {
        let (state, scripts, file) = stores();
        assert!(adopt_runs(&state, &scripts, &file, "obj-1", "obj-2").is_err());
        assert!(adopt_runs(&state, &scripts, &file, "draft-a", "draft-b").is_err());
        assert!(adopt_runs(&state, &scripts, &file, "draft-a", "").is_err());
        // An invented target is refused even with NOTHING to move — the id
        // check sits before the empty-bucket return.
        assert!(adopt_runs(&state, &scripts, &file, "draft-a", "obj-invented").is_err());
        assert!(!file.is_dirty(), "every refusal above must leave it clean");
    }

    #[test]
    fn adopting_onto_an_id_the_workbook_does_not_carry_is_refused() {
        // `append_run` refuses an unknown id so nobody can plant provenance for
        // a script that does not exist; before this check, `adopt_runs` was the
        // way around it — re-key a draft bucket onto any invented id, and the
        // planted history rides the .cala. Sabotage: delete the
        // `is_known_script_id` refusal in `adopt_runs` and this reds.
        let (state, scripts, file) = stores();
        append_run(&state, &scripts, &file, "draft-a", run("r1")).unwrap();

        let clean = FileState::default();
        let err = adopt_runs(&state, &scripts, &clean, "draft-a", "obj-invented").unwrap_err();
        assert!(err.contains("obj-invented"), "{}", err);

        let still_there = read_runs(&state, "draft-a").unwrap();
        assert_eq!(still_there.len(), 1, "the bucket must stay under the draft id");
        assert!(
            read_runs(&state, "obj-invented").unwrap().is_empty(),
            "nothing may appear under the invented id"
        );
        assert!(
            !clean.is_dirty(),
            "a refused adopt must leave the document CLEAN"
        );
    }

    #[test]
    fn clearing_removes_the_history_and_clearing_nothing_stays_clean() {
        let (state, scripts, file) = stores();
        add_object_script(&state, "obj-1");
        append_run(&state, &scripts, &file, "obj-1", run("r1")).unwrap();

        clear_runs(&state, &file, "obj-1").unwrap();
        assert!(read_runs(&state, "obj-1").unwrap().is_empty());

        let clean = FileState::default();
        clear_runs(&state, &clean, "obj-1").unwrap();
        assert!(
            !clean.is_dirty(),
            "clearing a history that is not there changes nothing"
        );
    }
}
