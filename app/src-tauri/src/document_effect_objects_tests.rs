//! FILENAME: app/src-tauri/src/document_effect_objects_tests.rs
//! PURPOSE: Pin the dirty-flag DECISIONS for the object/annotation half of the census --
//!          the per-sheet content stores (notes, comments, outlines), the workbook-level
//!          object stores (sparklines, named styles, scenarios, extension data, reports),
//!          sheet view state, and the object-script lifecycle.
//!
//! WHAT THESE ARE FOR, AND HOW THEY DIFFER FROM THE OTHER TWO SUITES
//! -----------------------------------------------------------------
//! `document_effect`'s own tests pin the MECHANISM: a `Persisted<T>` cannot be written
//! without a `DocumentEffect`, and `mutates` sets the flag in its constructor.
//! `document_effect_wave2_tests` pins the shared IDIOMS of the filter/print families.
//! These pin the DECISIONS -- for each command family here, which arm was chosen.
//!
//! The mechanism cannot be bypassed, but it also cannot tell you the right answer: it
//! only forces an answer. Picking `deliberately_clean` where `mutates` belonged is
//! exactly as silent as the original 256-command bug, and it is what a future edit can
//! quietly flip. So every judgement call below has a test naming the alternative that
//! was rejected and why.
//!
//! Two shapes appear, and the balance between them is the point:
//!   * "X dirties"      -- the census said mutates-document, and now it does.
//!   * "Y stays clean"  -- a refusal, a genuine no-op, or state that is never saved.
//!     Without these the fix degenerates into "flag everything", the prompt fires for
//!     work that was never done, and users learn to dismiss it -- which costs more than
//!     the bug being fixed.

use crate::document_effect::{CleanReason, DocumentEffect};
use crate::persistence::FileState;
use crate::AppState;

fn dirty(fs: &FileState) -> bool {
    fs.is_dirty()
}

/// A fresh workbook plus a clean `FileState` -- the state every test starts from.
fn fixture() -> (AppState, FileState) {
    (crate::create_app_state(), FileState::default())
}

/// Seed persisted state directly, without going through a command. Not a document
/// edit: nothing is saved afterwards, and the assertions are about what happens next.
fn seed() -> DocumentEffect {
    DocumentEffect::deliberately_clean(CleanReason::LoadingFromDisk)
}

// ============================================================================
// Per-sheet content stores (notes, comments)
// ============================================================================

#[test]
fn adding_a_note_dirties_the_document() {
    let (state, fs) = fixture();
    assert!(!dirty(&fs));

    let result = crate::notes::add_note_impl(
        &state,
        &fs,
        crate::notes::AddNoteParams {
            row: 2,
            col: 3,
            author_name: "Ada".to_string(),
            content: "check this".to_string(),
            rich_content: None,
            width: None,
            height: None,
        },
    );

    assert!(result.success, "{:?}", result.error);
    assert!(
        dirty(&fs),
        "notes ride in `sheet.notes` and are written only by the save path, so adding \
         one and closing used to lose it with no prompt at all"
    );
}

#[test]
fn a_note_refused_for_mutual_exclusivity_leaves_the_document_clean() {
    let (state, fs) = fixture();

    // A comment already occupies the cell (seeded through its own FileState so the
    // assertion below is about `add_note` alone).
    let c = crate::comments::add_comment_impl(
        &state,
        &FileState::default(),
        crate::comments::AddCommentParams {
            row: 2,
            col: 3,
            author_email: "ada@example.com".to_string(),
            author_name: "Ada".to_string(),
            content: "mine".to_string(),
            rich_content: None,
            mentions: None,
        },
    );
    assert!(c.success, "{:?}", c.error);
    assert!(!dirty(&fs));

    let result = crate::notes::add_note_impl(
        &state,
        &fs,
        crate::notes::AddNoteParams {
            row: 2,
            col: 3,
            author_name: "Bob".to_string(),
            content: "mine too".to_string(),
            rich_content: None,
            width: None,
            height: None,
        },
    );

    assert!(!result.success, "a cell cannot hold both a Note and a Comment");
    assert!(
        !dirty(&fs),
        "REFUSAL ORDERING -- the contract most at risk from a mechanical fix. \
         `DocumentEffect::mutates` sets the flag in its own CONSTRUCTOR, so it must be \
         reached only after every gate that can still say no. Paste it at the top of a \
         command instead and every rejected edit dirties the document."
    );
}

#[test]
fn adding_a_comment_dirties_the_document() {
    let (state, fs) = fixture();
    let result = crate::comments::add_comment_impl(
        &state,
        &fs,
        crate::comments::AddCommentParams {
            row: 0,
            col: 0,
            author_email: "ada@example.com".to_string(),
            author_name: "Ada".to_string(),
            content: "hello".to_string(),
            rich_content: None,
            mentions: None,
        },
    );
    assert!(result.success, "{:?}", result.error);
    assert!(dirty(&fs), "`workbook.comments` is persisted");
}

// ============================================================================
// Sheet view state -- the contradiction inside sheets.rs
// ============================================================================

#[test]
fn freezing_panes_dirties_the_document_like_splitting_the_window_always_did() {
    let (state, fs) = fixture();

    crate::sheets::set_freeze_panes_impl(&state, &fs, Some(1), Some(2))
        .expect("freeze should succeed");

    assert!(
        dirty(&fs),
        "sheets.rs contradicted itself: `set_split_window` dirtied and its doc comment \
         explained why, while `set_freeze_panes` 50 lines above -- the same kind of \
         per-sheet view state, persisted by the same save path -- did not. A workbook \
         whose only change was a freeze closed 'clean' and the layout was discarded."
    );

    let configs = state.freeze_configs.read().unwrap();
    assert_eq!(configs[0].freeze_row, Some(1));
    assert_eq!(configs[0].freeze_col, Some(2));
}

#[test]
fn setting_a_scroll_area_does_not_dirty_because_it_is_never_saved() {
    let (state, fs) = fixture();

    crate::sheets::set_scroll_area_impl(&state, Some("A1:Z100".to_string()))
        .expect("set_scroll_area should succeed");

    assert_eq!(
        state.scroll_areas.lock().unwrap()[0].as_deref(),
        Some("A1:Z100"),
        "the value is held for the session"
    );
    assert!(
        !dirty(&fs),
        "JUDGEMENT CALL, against the census's provisional 'mutates-document' (it flagged \
         this one 'verify'). `assemble_workbook_for_save` never reads `scroll_areas` and \
         `persistence::Sheet` has no `scroll_area` field, so it cannot reach the .cala. \
         Flagging state that is not saved makes the prompt lie in the OTHER direction: \
         'save to keep this', and it is gone anyway. `scroll_areas` is therefore \
         deliberately NOT a `Persisted<T>`, and `set_scroll_area_impl` deliberately takes \
         no `FileState` -- not taking it is a stronger statement than taking it and \
         ignoring it, which is the failure mode five commands already exhibited. The \
         missing PERSISTENCE is a real, separate gap."
    );
}

// ============================================================================
// Workbook-level object stores
// ============================================================================

/// The payload the frontend store sends for a sheet that really has a group.
fn one_group_json() -> String {
    r#"[{"id":1,"type":"line","cells":[{"row":0,"col":0}]}]"#.to_string()
}

#[test]
fn saving_sparklines_dirties_and_deleting_nothing_stays_clean() {
    let (state, fs) = fixture();

    crate::sparkline_commands::save_sparklines_impl(
        &state,
        &fs,
        crate::api_types::SparklineEntry {
            sheet_index: 0,
            groups_json: one_group_json(),
        },
    )
    .expect("save should succeed");
    assert!(
        dirty(&fs),
        "`workbook.sparklines` is persisted, and these commands already recorded undo \
         entries -- an unambiguous declaration that the change is user-meaningful -- \
         while marking nothing dirty"
    );

    // A delete that finds nothing must not dirty: the effect is constructed only once
    // we know a mutation will really happen (read-first ordering).
    let clean = FileState::default();
    crate::sparkline_commands::delete_sparklines_impl(&state, &clean, 7)
        .expect("deleting from a sheet with no sparklines is not an error");
    assert!(
        !dirty(&clean),
        "nothing changed, so nothing should prompt"
    );

    // ...but a delete that really removes something does.
    let real = FileState::default();
    crate::sparkline_commands::delete_sparklines_impl(&state, &real, 0)
        .expect("delete should succeed");
    assert!(dirty(&real));
}

/// THE SHEET-SWITCH REGRESSION.
///
/// The Sparklines extension saves unconditionally on every SHEET_CHANGED, so on
/// a workbook with no sparklines a plain sheet switch arrived here as
/// `save_sparklines_impl(sheet, "[]")`. That both dirtied a just-saved document
/// and pushed an undo entry that restored nothing — measured on the running app:
/// two switches took `undoDepth` from 4 to 6 and turned the title asterisk on,
/// so the user's next Ctrl+Z popped a no-op instead of undoing their last edit.
#[test]
fn an_upsert_that_changes_nothing_neither_dirties_nor_records_undo() {
    let (state, _fs) = fixture();

    // 1. A sheet that has never had a sparkline. No entry exists; the frontend
    //    sends the empty list.
    //
    //    THE INDEX HERE MUST NAME A SHEET THAT EXISTS. It used to be 3, which
    //    `create_app_state` (one sheet, "Sheet1") does not have -- so once
    //    `save_sparklines_impl` learned to refuse per-sheet state for a
    //    nonexistent sheet (BUG-0041), this step would have returned early for
    //    THAT reason and passed without ever exercising the unchanged-upsert
    //    logic it exists to pin. Sheet 0 exists and has no entry yet, which is
    //    precisely the case described above.
    let switch = FileState::default();
    let undo_before = state.undo_stack.lock().unwrap().undo_depth();
    crate::sparkline_commands::save_sparklines_impl(
        &state,
        &switch,
        crate::api_types::SparklineEntry {
            sheet_index: 0,
            groups_json: "[]".to_string(),
        },
    )
    .expect("an empty save is not an error");
    assert!(
        !dirty(&switch),
        "switching to a sheet with no sparklines must not dirty the document -- \
         `set_active_sheet` declares itself deliberately clean precisely so that \
         merely LOOKING at a workbook cannot make the close prompt lie, and an \
         extension writing back what it just read must not be able to overrule that"
    );
    assert_eq!(
        state.undo_stack.lock().unwrap().undo_depth(),
        undo_before,
        "and it must not push an undo entry -- one that restores 'no entry' still \
         consumes the user's next Ctrl+Z"
    );

    // 2. A sheet that DOES have a group, re-saved byte-identically.
    let real = FileState::default();
    crate::sparkline_commands::save_sparklines_impl(
        &state,
        &real,
        crate::api_types::SparklineEntry {
            sheet_index: 0,
            groups_json: one_group_json(),
        },
    )
    .expect("save should succeed");
    assert!(dirty(&real), "the first, real save must dirty");
    let undo_after_real = state.undo_stack.lock().unwrap().undo_depth();

    let resave = FileState::default();
    crate::sparkline_commands::save_sparklines_impl(
        &state,
        &resave,
        crate::api_types::SparklineEntry {
            sheet_index: 0,
            groups_json: one_group_json(),
        },
    )
    .expect("an identical re-save is not an error");
    assert!(
        !dirty(&resave),
        "re-saving the identical blob changes nothing and must stay clean"
    );
    assert_eq!(
        state.undo_stack.lock().unwrap().undo_depth(),
        undo_after_real,
        "and must not push a second undo entry"
    );

    // 3. TEETH: a genuinely different payload still dirties and still records.
    let changed = FileState::default();
    crate::sparkline_commands::save_sparklines_impl(
        &state,
        &changed,
        crate::api_types::SparklineEntry {
            sheet_index: 0,
            groups_json: r#"[{"id":1,"type":"column","cells":[{"row":0,"col":0}]}]"#.to_string(),
        },
    )
    .expect("save should succeed");
    assert!(dirty(&changed), "a real change must still dirty");
    assert!(
        state.undo_stack.lock().unwrap().undo_depth() > undo_after_real,
        "a real change must still be undoable -- a guard that suppressed this would \
         have traded a junk undo entry for a lost one"
    );
}

#[test]
fn creating_a_named_style_dirties_but_a_duplicate_name_stays_clean() {
    let (state, fs) = fixture();

    crate::named_styles_cmd::create_named_style_impl(
        &state,
        &fs,
        "Highlight".to_string(),
        0,
        "Custom".to_string(),
    )
    .expect("create should succeed");
    assert!(
        dirty(&fs),
        "custom named styles persist via user_files/named_styles.json -- and \
         `apply_named_style` in the SAME file already dirtied while create/delete did \
         not, an in-file contradiction the census singled out"
    );

    let clean = FileState::default();
    let dup = crate::named_styles_cmd::create_named_style_impl(
        &state,
        &clean,
        "Highlight".to_string(),
        0,
        "Custom".to_string(),
    );
    assert!(dup.is_err(), "duplicate names are refused");
    assert!(
        !dirty(&clean),
        "the duplicate check runs under a READ guard, before the decision"
    );
}

#[test]
fn deleting_a_built_in_or_missing_named_style_is_refused_and_stays_clean() {
    let (state, _fs) = fixture();
    let built_in = state
        .named_styles
        .read()
        .unwrap()
        .values()
        .find(|s| s.built_in)
        .map(|s| s.name.clone())
        .expect("built-in styles are seeded at startup");

    let clean = FileState::default();
    assert!(
        crate::named_styles_cmd::delete_named_style_impl(&state, &clean, built_in).is_err(),
        "built-ins cannot be deleted"
    );
    assert!(
        !dirty(&clean),
        "both refusals resolve under a read guard, before the decision"
    );

    let missing = FileState::default();
    assert!(crate::named_styles_cmd::delete_named_style_impl(
        &state,
        &missing,
        "NoSuchStyle".to_string()
    )
    .is_err());
    assert!(!dirty(&missing));
}

#[test]
fn seeding_the_built_in_named_styles_does_not_dirty_a_brand_new_workbook() {
    let (state, fs) = fixture();
    crate::named_styles_cmd::init_builtin_named_styles(&state);
    assert!(
        !state.named_styles.read().unwrap().is_empty(),
        "the Cell Styles gallery is populated"
    );
    assert!(
        !dirty(&fs),
        "app startup and File > New both run this. A brand-new workbook that already \
         prompts to save is exactly the failure `CleanReason::LoadingFromDisk` exists \
         to prevent."
    );
}

// ============================================================================
// Scenarios -- and the transient-write trap
// ============================================================================

#[test]
fn adding_a_scenario_dirties_and_an_invalid_one_stays_clean() {
    let (state, fs) = fixture();

    let ok = crate::scenario_manager::scenario_add_impl(
        &state,
        &fs,
        crate::api_types::ScenarioAddParams {
            sheet_index: 0,
            name: "Best case".to_string(),
            comment: String::new(),
            changing_cells: vec![crate::api_types::ScenarioCell {
                row: 0,
                col: 0,
                value: "100".to_string(),
            }],
        },
    );
    assert!(ok.success, "{:?}", ok.error);
    assert!(dirty(&fs), "`workbook.scenarios` is persisted");

    // An empty name is rejected BEFORE the store is touched.
    let clean = FileState::default();
    let bad = crate::scenario_manager::scenario_add_impl(
        &state,
        &clean,
        crate::api_types::ScenarioAddParams {
            sheet_index: 0,
            name: "   ".to_string(),
            comment: String::new(),
            changing_cells: vec![crate::api_types::ScenarioCell {
                row: 0,
                col: 0,
                value: "1".to_string(),
            }],
        },
    );
    assert!(!bad.success);
    assert!(
        !dirty(&clean),
        "validation runs before the effect is constructed"
    );

    // So is a scenario with no changing cells.
    let clean2 = FileState::default();
    let bad2 = crate::scenario_manager::scenario_add_impl(
        &state,
        &clean2,
        crate::api_types::ScenarioAddParams {
            sheet_index: 0,
            name: "Empty".to_string(),
            comment: String::new(),
            changing_cells: Vec::new(),
        },
    );
    assert!(!bad2.success);
    assert!(!dirty(&clean2));
}

#[test]
fn scenario_show_cannot_claim_the_animation_transient_exemption() {
    // THE TRAP INSIDE THE TRAP. `docs/design/animation-simulation.md` cites
    // `scenario_show` as the transient-write precedent, and it is -- in the UNDO sense:
    // it applies values without entering the undo stack. But "transient" for the dirty
    // flag means "there is a restore, and it is already registered", and there is no
    // `scenario_restore` anywhere in scenario_manager.rs. The values it applies stay in
    // the cells and get saved, so it must dirty like any other permanent cell write.
    //
    // The distinction is structural rather than remembered: `TransientScope` can only be
    // built by presenting the snapshot registry the paired restore reads back from.
    // Animation has one (`AppState::animation_snapshots`, filled by `anim_snapshot`
    // before any frame is applied). A scenario has nothing to present.
    let (state, _fs) = fixture();

    let registry = state.animation_snapshots.lock().unwrap();
    assert!(
        crate::document_effect::TransientScope::prove_restore_registered(
            &registry,
            "scenario:Best case"
        )
        .is_err(),
        "with no restore buffer a scenario cannot construct the proof that \
         `DocumentEffect::transient` requires, so `mutates` is the only arm available \
         to it -- which is the correct answer, reached structurally"
    );
}

// ============================================================================
// Extension data -- the single hole every extension's state fell through
// ============================================================================

#[test]
fn persisting_extension_data_dirties_the_document() {
    let (state, fs) = fixture();

    crate::persistence::set_extension_data_impl(
        &state,
        &fs,
        "com.example.animation".to_string(),
        Some(serde_json::json!({ "frames": 24 })),
    )
    .expect("set should succeed");

    assert!(
        dirty(&fs),
        "`workbook.extension_data` is THE sanctioned extension persistence tier. Every \
         extension that persists state -- animations, grid reports, third-party add-ins \
         -- went through this one command, so one missing flag lost all of them at once."
    );

    // Clearing a key is a mutation too.
    let clearing = FileState::default();
    crate::persistence::set_extension_data_impl(
        &state,
        &clearing,
        "com.example.animation".to_string(),
        None,
    )
    .expect("clear should succeed");
    assert!(dirty(&clearing));
}

// ============================================================================
// Object scripts -- the frontend-compensation trap
// ============================================================================

#[test]
fn pruning_an_object_script_dirties_through_the_callers_effect() {
    let (state, fs) = fixture();

    {
        let s = seed();
        let mut scripts = state.object_scripts.write(&s).unwrap();
        scripts.push(persistence::SavedObjectScript {
            id: "s1".to_string(),
            name: "chart script".to_string(),
            object_type: persistence::ScriptableObjectType::Chart,
            instance_id: Some("chart-1".to_string()),
            source: "// noop".to_string(),
            access_level: persistence::ScriptAccessLevel::Restricted,
            description: None,
            provenance: persistence::ScriptProvenance::Local,
            package_name: None,
            package_version: None,
            declared_capabilities: Vec::new(),
        });
    }
    assert!(!dirty(&fs), "seeding used a deliberately_clean effect");

    let effect = DocumentEffect::mutates(&fs);
    crate::scripting::object_script_commands::prune_scripts_for_instance(
        &state, &effect, "chart-1",
    );

    assert!(state.object_scripts.read().unwrap().is_empty());
    assert!(
        dirty(&fs),
        "prune takes the CALLER's effect instead of minting its own, which is what \
         forces every object-delete path -- chart, table, named range, pivot, slicer, \
         timeline -- to have made the decision for its own mutation too. Object scripts \
         had no frontend compensation at all, unlike workbook scripts, whose backend gap \
         was masked in manual testing by a markFileModified() call in \
         app/src/api/workbookScripts.ts (the only such call in the whole UI, and one \
         that no script / MCP / scheduler caller ever runs)."
    );
}

// ============================================================================
// Conditional mutation -- dirty on the mutating path only
// ============================================================================

#[test]
fn a_workbook_property_write_that_applies_nothing_stays_clean() {
    let (state, fs) = fixture();
    let mut changes = std::collections::HashMap::new();
    changes.insert("notAPropertyName".to_string(), "x".to_string());

    let applied = crate::scripting::types::apply_workbook_property_changes(&state, &fs, &changes)
        .expect("unknown keys are ignored, not an error");

    assert_eq!(applied, 0);
    assert!(
        !dirty(&fs),
        "CONDITIONAL MUTATION. The properties are edited on a CLONE under a read guard \
         and committed only if something actually changed, so the effect -- and \
         therefore the flag -- is never reached on the no-op path. This preserves the \
         exact semantics the old conditional `mark_workbook_modified` had."
    );

    let mut real = std::collections::HashMap::new();
    real.insert("title".to_string(), "Q3 Report".to_string());
    let applied = crate::scripting::types::apply_workbook_property_changes(&state, &fs, &real)
        .expect("known keys apply");
    assert_eq!(applied, 1);
    assert!(dirty(&fs), "`workbook.properties` is persisted");
}

// ============================================================================
// Reports -- unsaved registry, saved side effects
// ============================================================================

#[test]
fn writing_a_report_dirties_through_the_commands_effect() {
    let (state, fs) = fixture();
    let effect = DocumentEffect::mutates(&fs);

    crate::report::with_reports_mut(&state, &effect, |defs| {
        defs.push(crate::report::tests::a_report(0));
    });

    assert!(
        dirty(&fs),
        "the report store IS `workbook.extension_data[\"calcula.reports\"]` (which is \
         saved), and every report command also writes grid cells -- which is why \
         create/refresh/delete/restore_report were all census misses back when the \
         store looked like an 'unsaved' in-memory registry"
    );
}

#[test]
fn a_no_op_report_pass_does_not_stamp_an_empty_slot() {
    let (state, fs) = fixture();

    // `with_reports_mut` is called on every row/column insert and every sheet
    // reorder, whether or not the workbook has any reports. Minting the effect
    // is the CALLER's decision -- those commands dirty for their own reasons, so
    // the effect here is a real `mutates` -- but the report slot itself must not
    // be stamped with an empty `[]` on the way past.
    let effect = DocumentEffect::mutates(&fs);
    crate::report::with_reports_mut(&state, &effect, |defs| defs.retain(|_| true));

    assert!(
        !state
            .extension_data
            .read()
            .unwrap()
            .contains_key(crate::report::REPORTS_EXT_KEY),
        "a no-op report pass stamped an empty reports slot into extension_data; \
         every workbook that ever had a row inserted would carry one"
    );
}

// ============================================================================
// Grouping -- persisted view state dirties
// ============================================================================

#[test]
fn collapsing_an_outline_group_dirties_because_collapsed_ness_is_saved() {
    let (state, fs) = fixture();

    {
        let s = seed();
        let mut outlines = state.outlines.write(&s).unwrap();
        let outline = outlines.entry(0).or_default();
        outline
            .row_groups
            .push(crate::grouping::RowGroup::new(2, 5, 1));
    }
    assert!(!dirty(&fs));

    let result = crate::grouping::collapse_row_group_inner(&state, &fs, 5);
    assert!(result.success, "{:?}", result.error);

    assert!(
        dirty(&fs),
        "JUDGEMENT CALL: collapsed-ness rides inside the per-sheet outline blob that \
         `workbook.outlines` serializes, so collapsing changes what a save writes. \
         Persisted view state dirties; the single exception is navigation \
         (`set_active_sheet` / next / previous), because merely LOOKING at a workbook \
         must never make it dirty or the prompt loses all meaning."
    );
}

#[test]
fn ungrouping_a_sheet_with_no_outline_is_refused_and_stays_clean() {
    let (state, fs) = fixture();
    let result = crate::grouping::ungroup_rows_inner(&state, &fs, 0, 3);
    assert!(!result.success, "there is no outline to ungroup");
    assert!(
        !dirty(&fs),
        "the not-found refusal returns before anything is written"
    );
}

#[test]
fn updating_a_note_on_a_sheet_with_no_notes_is_refused_and_stays_clean() {
    // REGRESSION GUARD. The first cut of this rollout hoisted
    // `DocumentEffect::mutates` to the top of every command in notes.rs / comments.rs /
    // hyperlinks.rs / grouping.rs, which dirtied the document on the "nothing here"
    // error path -- a prompt to save work that was never done. The sibling test
    // `ungrouping_a_sheet_with_no_outline_is_refused_and_stays_clean` caught it; these
    // pin the same contract for the other three stores.
    let (state, fs) = fixture();

    let result = crate::notes::update_note_impl(
        &state,
        &fs,
        crate::notes::UpdateNoteParams {
            note_id: "does-not-exist".to_string(),
            content: "x".to_string(),
            rich_content: None,
        },
    );

    assert!(!result.success, "there is no such note");
    assert!(
        !dirty(&fs),
        "the existence question is answered under a READ guard, before the decision"
    );
}

#[test]
fn deleting_a_comment_that_is_not_there_is_refused_and_stays_clean() {
    let (state, fs) = fixture();
    let result = crate::comments::delete_comment_impl(&state, &fs, "does-not-exist".to_string());
    assert!(!result.success);
    assert!(!dirty(&fs));
}

#[test]
fn removing_a_hyperlink_from_a_sheet_with_none_is_refused_and_stays_clean() {
    let (state, fs) = fixture();
    let result = crate::hyperlinks::remove_hyperlink_impl(&state, &fs, 0, 0, None);
    assert!(!result.success);
    assert!(!dirty(&fs));
}

// ============================================================================
// Ribbon filters -- two near-identical modules that disagreed
// ============================================================================

#[test]
fn a_ribbon_filter_selection_change_dirties_like_its_pane_control_twin() {
    // The census singled this pair out: `pane_control` and `ribbon_filter` are the same
    // kind of entity, persisted by the same save path, with near-identical command
    // sets -- and pane_control has always dirtied while ribbon_filter never did. Two
    // modules doing the same thing while disagreeing about the flag is precisely the
    // "unpredictable mix" that destroys trust in the close prompt, because the user
    // cannot tell which of the two controls they just touched.
    let state = crate::ribbon_filter::RibbonFilterState::new();
    let fs = FileState::default();

    let id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    {
        let s = seed();
        state.filters.write(&s).unwrap().insert(
            id,
            crate::ribbon_filter::RibbonFilter {
                id,
                name: "Region".to_string(),
                connection_id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
                data_source_id: None,
                field_name: "dim_geo.region".to_string(),
                field_data_type: "text".to_string(),
                connection_mode: crate::ribbon_filter::ConnectionMode::Workbook,
                connected_pivots: vec![],
                connected_sheets: vec![],
                display_mode: crate::ribbon_filter::RibbonFilterDisplayMode::Checklist,
                selected_items: None,
                cross_filter_targets: vec![],
                cross_filter_slicer_targets: vec![],
                advanced_filter: None,
                hide_no_data: false,
                indicate_no_data: true,
                sort_no_data_last: true,
                show_select_all: false,
                single_select: false,
                order: 0,
                button_columns: 2,
                button_rows: 0,
                filter_level: 1,
            },
        );
    }
    assert!(!dirty(&fs));

    let effect = DocumentEffect::mutates(&fs);
    state
        .filters
        .write(&effect)
        .unwrap()
        .get_mut(&id)
        .unwrap()
        .selected_items = Some(vec!["North".to_string()]);

    assert!(
        dirty(&fs),
        "`workbook.ribbon_filters` is persisted, so a selection change changes what a          save writes -- exactly as it always did for pane controls"
    );
}
