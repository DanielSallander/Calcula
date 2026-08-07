//! FILENAME: app/src-tauri/src/document_effect_pilot_tests.rs
//! PURPOSE: Pin the dirty-flag contract for the `DocumentEffect` pilot surfaces.
//!
//! These are behaviour tests, not mechanism tests (the mechanism's own tests live in
//! `document_effect`). They exist because the failure they guard against is SILENT: a
//! command that forgets `is_modified` produces no error, no log line and no visible
//! symptom until the user closes the window without a prompt and the work is gone.
//!
//! Coverage mirrors the four arms of the design:
//!   * mutates          -- add_conditional_format, create_named_range (both previously
//!                         did not even take FileState, so they COULD not dirty)
//!   * deliberately_clean(LoadingFromDisk) -- the open_file / new_file store rebuild
//!   * deliberately_clean(Navigation)      -- set_active_sheet
//!   * transient        -- anim_apply_frame / anim_restore, plus the negative proof
//!                         that scenario_show's shape cannot claim the exemption

use crate::conditional_formatting::{
    add_conditional_format_impl, AddCFParams, CellValueOperator, CellValueRule,
    ConditionalFormat, ConditionalFormatDefinition, ConditionalFormatRange,
    ConditionalFormatRule,
};
use crate::document_effect::{CleanReason, DocumentEffect, TransientScope};
use crate::named_ranges::create_named_range_impl;
use crate::persistence::FileState;
use crate::{create_app_state, AppState};

fn dirty(fs: &FileState) -> bool {
    fs.is_dirty()
}

fn cf_params() -> AddCFParams {
    AddCFParams {
        rule: ConditionalFormatRule::CellValue(CellValueRule {
            operator: CellValueOperator::GreaterThan,
            value1: "10".to_string(),
            value2: None,
        }),
        format: ConditionalFormat::default(),
        ranges: vec![ConditionalFormatRange {
            start_row: 0,
            start_col: 0,
            end_row: 9,
            end_col: 0,
        }],
        stop_if_true: false,
    }
}

// ---------------------------------------------------------------------------
// mutates -- the two reported reproducers
// ---------------------------------------------------------------------------

#[test]
fn add_conditional_format_marks_the_workbook_dirty() {
    let state = create_app_state();
    let fs = FileState::default();
    assert!(!dirty(&fs), "a fresh document starts clean");

    let result = add_conditional_format_impl(&state, &fs, cf_params());

    assert!(result.success, "rule should be added");
    assert_eq!(
        state.conditional_formats.read().unwrap().get(&0).map(|v| v.len()),
        Some(1),
        "the rule is in the persisted store"
    );
    // THE REGRESSION. Before the DocumentEffect gate this command did not take
    // FileState at all: adding a rule then clicking X closed without a prompt and
    // AutoRecover had refused to snapshot it either.
    assert!(dirty(&fs), "adding a conditional format must dirty the workbook");
}

#[test]
fn create_named_range_marks_the_workbook_dirty() {
    let state = create_app_state();
    let fs = FileState::default();
    assert!(!dirty(&fs));

    let result = create_named_range_impl(
        &state,
        &fs,
        "TaxRate".to_string(),
        None,
        "=0.25".to_string(),
        None,
        None,
    );

    assert!(result.success, "name should be created: {:?}", result.error);
    assert!(state.named_ranges.read().unwrap().contains_key("TAXRATE"));
    assert!(dirty(&fs), "defining a name must dirty the workbook");
}

#[test]
fn a_refused_named_range_leaves_the_document_clean() {
    // ORDERING CONTRACT. `DocumentEffect::mutates` sets the flag eagerly, so it must be
    // constructed AFTER the validation gates. "A1" is a cell reference and is rejected
    // before the store is touched -- a refusal must not leave a spuriously dirty
    // document that then prompts the user to save nothing.
    let state = create_app_state();
    let fs = FileState::default();

    let result = create_named_range_impl(
        &state,
        &fs,
        "A1".to_string(),
        None,
        "=Sheet1!$A$1".to_string(),
        None,
        None,
    );

    assert!(!result.success, "a cell-reference name is invalid");
    assert!(!dirty(&fs), "a refused mutation must not dirty the document");
}

// ---------------------------------------------------------------------------
// deliberately_clean -- the negative cases, as explicit as the positive ones
// ---------------------------------------------------------------------------

#[test]
fn loading_from_disk_rebuilds_the_stores_without_dirtying() {
    // The shape open_file / new_file use: every persisted store is rewritten, and the
    // load command assigns is_modified = false as its last act. If this dirtied, every
    // freshly opened workbook would prompt to save.
    let state = create_app_state();
    let fs = FileState::default();

    let effect = DocumentEffect::deliberately_clean(CleanReason::LoadingFromDisk);
    state.named_ranges.write(&effect).unwrap().clear();
    state.conditional_formats.write(&effect).unwrap().clear();

    assert!(!effect.marks_dirty());
    assert!(!dirty(&fs), "rebuilding state FROM disk is not an edit TO the document");
}

#[test]
fn navigation_is_audited_as_deliberately_clean() {
    // set_active_sheet's decision, pinned. `workbook.active_sheet` IS persisted and
    // Excel dirties on a sheet switch; we deliberately diverge, because merely looking
    // at a workbook must never make it dirty.
    let fs = FileState::default();
    let effect = DocumentEffect::deliberately_clean(CleanReason::Navigation);
    assert!(!effect.marks_dirty());
    assert_eq!(effect.label(), "navigation");
    assert!(!dirty(&fs));
}

// ---------------------------------------------------------------------------
// transient -- first-class, and checkable
// ---------------------------------------------------------------------------

fn register_snapshot(state: &AppState, token: &str) {
    state
        .animation_snapshots
        .lock()
        .unwrap()
        .insert(token.to_string(), Vec::new());
}

#[test]
fn an_animation_frame_is_transient_and_does_not_dirty() {
    let state = create_app_state();
    let fs = FileState::default();
    register_snapshot(&state, "anim-clock-1");

    let effect = crate::animation_commands::frame_effect(&state, "anim-clock-1")
        .expect("a frame whose snapshot is on file is allowed");

    assert!(!effect.marks_dirty());
    assert_eq!(effect.label(), "transient");
    assert!(
        !dirty(&fs),
        "animation frames write cells but are restored on stop; they must never dirty"
    );
}

#[test]
fn a_frame_without_a_registered_restore_is_refused() {
    // The exemption is PROVEN, not asserted. No snapshot means no restore, which means
    // the write is not transient -- so it is refused rather than silently escaping the
    // dirty flag by being forgotten.
    let state = create_app_state();
    let err = crate::animation_commands::frame_effect(&state, "no-such-run")
        .expect_err("a frame with no restore buffer must be refused");
    assert!(err.contains("no restore snapshot is registered"), "got: {}", err);
}

#[test]
fn scenario_shows_shape_cannot_claim_the_transient_exemption() {
    // THE TRAP. docs/design/animation-simulation.md cites scenario_show as the
    // transient-write precedent, and it is -- in the UNDO sense. But there is no
    // scenario_restore anywhere in scenario_manager.rs: the values it applies stay in
    // the cells and get saved. Copying animation's exemption to it would be a data-loss
    // bug, so the type refuses: with nothing registered, no TransientScope exists.
    let state = create_app_state();
    let snapshots = state.animation_snapshots.lock().unwrap();
    assert!(
        TransientScope::prove_restore_registered(&snapshots, "scenario-show").is_err(),
        "a surface with no restore command cannot construct a TransientScope"
    );
}

// ---------------------------------------------------------------------------
// The gate itself
// ---------------------------------------------------------------------------

#[test]
fn reads_of_a_persisted_store_never_dirty() {
    // `Persisted::read` requires no decision precisely because reading changes nothing.
    // If reads needed an effect the friction would push authors toward the opt-out.
    let state = create_app_state();
    let fs = FileState::default();

    let _ = state.named_ranges.read().unwrap().len();
    let _ = state.conditional_formats.read().unwrap().len();

    assert!(!dirty(&fs));
}

#[test]
fn one_effect_authorises_every_write_of_a_single_command() {
    // Ergonomics contract for the ~164-site rollout: a command decides ONCE and passes
    // `&effect` to each store it touches. If each write needed its own decision the
    // rollout would be unbearable and people would route around it.
    let state = create_app_state();
    let fs = FileState::default();

    let effect = DocumentEffect::mutates(&fs);
    state.named_ranges.write(&effect).unwrap().insert(
        "A".to_string(),
        crate::named_ranges::NamedRange {
            name: "A".to_string(),
            sheet_index: None,
            refers_to: "=1".to_string(),
            comment: None,
            folder: None,
        },
    );
    state
        .conditional_formats
        .write(&effect)
        .unwrap()
        .insert(0, Vec::<ConditionalFormatDefinition>::new());

    assert!(dirty(&fs));
}
