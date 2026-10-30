//! FILENAME: app/src-tauri/src/scripting/script_rebind.rs
//! PURPOSE: THE one door through which the backend moves a stored object
//!          script to another object instance (a RE-BIND), and tells every
//!          window it did.
//! CONTEXT: An object script is bound by its object's instance id, and several
//!          routes move that id under it: a named range's rename
//!          (`named_ranges::repoint_named_range_scripts`) and its undo / redo
//!          (the `obj_object_scripts_by_id` restore); a control moving with its
//!          cells -- Insert / Delete Rows and Columns on any sheet
//!          (`commands/structure.rs` `shift_controls`) and Insert / Delete
//!          Cells (`structure_cells.rs` `shift_controls_in_band`); a control
//!          moved to another cell (`controls::move_control_core`); a sheet
//!          move, delete, copy or partition repair renumbering
//!          `control-<sheet>-<row>-<col>` (`sheets.rs`
//!          `remap_sheet_keyed_stores`); and the undo / redo of a control step
//!          (the `obj_controls` restore). A re-bind has two consequences outside
//!          the script store. The script's SCHEDULED JOBS address its exposed
//!          method by the binding (`scheduler::rebind_script_jobs`). And a LIVE
//!          mount in the main window keeps the binding it was mounted with until
//!          it hears "rebound" (`followReboundScripts.ts` ->
//!          `hostRebindMountedScript`). Only the rename did both (rev4B#1,
//!          rev4B#2): every other route left the jobs on the old address -- a
//!          FAILED run on every tick after the next reopen -- and the mount on
//!          the old id, so a shape script's later html went to a control that
//!          no longer existed (rev6B#2, NEW-control-rekey-live-script-mount).
//!          Every route now re-binds through [`rebind_script`] and announces
//!          through [`announce_rebinds`].

use crate::document_effect::DocumentEffect;

/// One script the backend re-bound: its id, the binding it had and the one it
/// has now (`None` = unbound: its control was deleted with its cells or sheet).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ScriptRebound {
    pub(crate) id: String,
    pub(crate) from: Option<String>,
    pub(crate) to: Option<String>,
}

/// Re-bind `script` to `to`, and move the scheduled jobs it registered on its
/// old binding with it, in the same step. `None` when it is bound there
/// already (nothing moved, nothing to announce).
///
/// Takes the route's `DocumentEffect`: the jobs ride in the `.cala`, so moving
/// them is part of the document change the route already decided on. The
/// scheduler lock is a leaf, so this is legal under the script store's guard
/// and under any other AppState guard the route holds.
pub(crate) fn rebind_script(
    effect: &DocumentEffect,
    script: &mut persistence::SavedObjectScript,
    to: Option<String>,
) -> Option<ScriptRebound> {
    if script.instance_id == to {
        return None;
    }
    let from = std::mem::replace(&mut script.instance_id, to.clone());
    crate::scripting::scheduler::rebind_script_jobs(effect, &script.id, from.as_deref(), to.as_deref());
    Some(ScriptRebound { id: script.id.clone(), from, to })
}

/// Tell every window that each of `rebinds` moved ("rebound", with the binding
/// it has now), in the order the route made them.
///
/// WHEN. A route calls this once it has RELEASED the script store's guard: the
/// Object Script Editor answers the announcement with `getObjectScript`, which
/// reads that store. The announcement itself takes no AppState lock and never
/// waits on a listener -- an emit is delivered to the webviews asynchronously,
/// and nothing in Rust listens for it -- so a guard the route's CALLER may
/// still hold (a structural command's grids and undo stack) cannot deadlock
/// it; a listener's command simply queues behind that guard. The main window
/// asks nothing at all: it re-keys from the payload.
pub(crate) fn announce_rebinds(rebinds: &[ScriptRebound]) {
    for rebound in rebinds {
        crate::scripting::object_script_commands::announce_object_script_rebound(
            &rebound.id,
            rebound.to.as_deref(),
        );
    }
}

#[cfg(test)]
mod tests {
    //! Every route that moves a script's binding moves its scheduled jobs with
    //! it and announces the move, through the real commands and their undo.

    use super::*;
    use crate::controls::{ControlMetadata, ControlPropertyValue};
    use crate::document_effect::test_seed_effect;
    use crate::scripting::object_script_commands::{take_object_script_announcements, ObjectScriptsChangedPayload};
    use crate::AppState;
    use std::collections::HashMap;

    struct Harness {
        state: AppState,
        file: crate::persistence::FileState,
        files: crate::persistence::UserFilesState,
        slicer: crate::slicer::SlicerState,
        pivots: crate::pivot::types::PivotState,
        pane: crate::pane_control::PaneControlState,
        filters: crate::ribbon_filter::RibbonFilterState,
        timeline: crate::timeline_slicer::TimelineSlicerState,
        /// Every job seeded so far (see `scripted_button`).
        jobs: std::cell::RefCell<Vec<calcula_format::features::scheduled_jobs::ScheduledJobDef>>,
    }

    impl Harness {
        /// `sheets` sheets, Sheet1 active.
        fn new(sheets: usize) -> Self {
            let state = crate::create_app_state();
            let seed = test_seed_effect();
            for n in 1..sheets {
                state.grids.write(&seed).unwrap().push(engine::Grid::new());
                state.sheet_names.write(&seed).unwrap().push(format!("Sheet{}", n + 1));
                state.all_column_widths.write(&seed).unwrap().push(HashMap::new());
                state.all_row_heights.write(&seed).unwrap().push(HashMap::new());
                state.all_user_hidden_rows.write(&seed).unwrap().push(std::collections::HashSet::new());
                state.all_user_hidden_cols.write(&seed).unwrap().push(std::collections::HashSet::new());
                state.sheet_ids.write(&seed).unwrap().push(identity::SheetId::from_bytes(identity::generate_uuid_v7()));
            }
            {
                let mut all = state.all_merged_regions.write(&seed).unwrap();
                while all.len() < sheets {
                    all.push(std::collections::HashSet::new());
                }
            }
            Harness {
                state,
                file: crate::persistence::FileState::default(),
                files: crate::persistence::UserFilesState::default(),
                slicer: crate::slicer::SlicerState::new(),
                pivots: crate::pivot::types::PivotState::new(),
                pane: crate::pane_control::PaneControlState::new(),
                filters: crate::ribbon_filter::RibbonFilterState::new(),
                timeline: crate::timeline_slicer::TimelineSlicerState::new(),
                jobs: std::cell::RefCell::new(Vec::new()),
            }
        }

        /// A button at (sheet, row, col) with an object script `script_id`
        /// bound to it, and one scheduled job of that script on its address.
        fn scripted_button(&self, sheet: usize, row: u32, col: u32, script_id: &str, job_id: &str) {
            let mut properties = HashMap::new();
            properties.insert(
                "text".to_string(),
                ControlPropertyValue { value_type: "static".to_string(), value: "Run".to_string() },
            );
            let meta = ControlMetadata {
                control_type: "button".to_string(),
                uid: crate::controls::mint_control_uid(),
                properties,
            };
            self.state.controls.write(&test_seed_effect()).unwrap().insert((sheet, row, col), meta);
            let address = crate::controls::control_instance_id(sheet, row, col);
            self.state.object_scripts.write(&test_seed_effect()).unwrap().push(persistence::SavedObjectScript {
                id: script_id.to_string(),
                name: format!("Script {}", script_id),
                object_type: persistence::ScriptableObjectType::Button,
                instance_id: Some(address.clone()),
                source: "export function refresh() {}\n".to_string(),
                access_level: persistence::ScriptAccessLevel::Restricted,
                description: None,
                provenance: persistence::ScriptProvenance::Local,
                package_name: None,
                package_version: None,
                declared_capabilities: Vec::new(),
            });
            // An import REPLACES the registry (a workbook load), so every job
            // this harness seeded is imported again together.
            let mut jobs = self.jobs.borrow_mut();
            jobs.push(calcula_format::features::scheduled_jobs::ScheduledJobDef {
                id: job_id.to_string(),
                script_id: script_id.to_string(),
                script_hash: "h".to_string(),
                surface: "object-script".to_string(),
                object_type: "button".to_string(),
                instance_id: Some(address),
                handler: "refresh".to_string(),
                cadence: crate::scripting::scheduler::CADENCE_EVERY.to_string(),
                interval_secs: 3600,
                minute_of_day: 0,
                next_run_ms: 0,
                enabled: true,
                label: None,
                last_run_ms: 0,
                last_ok: false,
                last_error: None,
                run_count: 0,
            });
            let hashes: HashMap<String, String> =
                jobs.iter().map(|j| (j.script_id.clone(), "h".to_string())).collect();
            let restored = crate::scripting::scheduler::import_jobs_for_workbook(jobs.clone(), &hashes);
            assert_eq!(restored.restored, jobs.len(), "the jobs are in the registry");
        }

        fn binding_of(&self, script_id: &str) -> Option<String> {
            self.state
                .object_scripts
                .read()
                .unwrap()
                .iter()
                .find(|s| s.id == script_id)
                .and_then(|s| s.instance_id.clone())
        }

        /// What a SAVE writes for the script's jobs: (job id, the address it calls).
        fn saved_jobs(&self, script_id: &str) -> Vec<(String, Option<String>)> {
            let hashes: HashMap<String, String> = [(script_id.to_string(), "h".to_string())].into_iter().collect();
            let mut jobs: Vec<(String, Option<String>)> = crate::scripting::scheduler::export_jobs_for_workbook(&hashes)
                .into_iter()
                .filter(|d| d.script_id == script_id)
                .map(|d| (d.id, d.instance_id))
                .collect();
            jobs.sort();
            jobs
        }

        fn undo(&self) {
            let transaction = self.state.undo_stack.lock().unwrap().pop_undo().expect("nothing to undo");
            crate::undo_commands::apply_changes(
                &self.state, &self.file, &self.files, &self.pivots, &self.slicer, &self.filters, &self.pane,
                &self.timeline, transaction, true,
            );
        }

        fn redo(&self) {
            let transaction = self.state.undo_stack.lock().unwrap().pop_redo().expect("nothing to redo");
            crate::undo_commands::apply_changes(
                &self.state, &self.file, &self.files, &self.pivots, &self.slicer, &self.filters, &self.pane,
                &self.timeline, transaction, false,
            );
        }
    }

    fn rebound(id: &str, to: Option<&str>) -> ObjectScriptsChangedPayload {
        ObjectScriptsChangedPayload {
            id: id.to_string(),
            change: "rebound".to_string(),
            instance_id: Some(to.map(str::to_string)),
        }
    }

    fn at(address: &str) -> Option<String> {
        Some(address.to_string())
    }

    /// The door itself: the binding, the script's own jobs on that binding and
    /// nothing else move; a re-bind to where it already is moves nothing.
    #[test]
    fn the_door_moves_the_binding_and_that_scripts_jobs_on_it_and_nothing_else() {
        let _jobs = crate::persistence::scheduler_test_guard();
        let h = Harness::new(1);
        h.scripted_button(0, 5, 2, "s-door", "sched-door");
        h.scripted_button(0, 9, 2, "s-door-other", "sched-door-other");
        let effect = test_seed_effect();
        {
            let mut scripts = h.state.object_scripts.write(&effect).unwrap();
            let script = scripts.iter_mut().find(|s| s.id == "s-door").unwrap();
            assert_eq!(rebind_script(&effect, script, at("control-0-5-2")), None, "already bound there");
            assert_eq!(
                rebind_script(&effect, script, at("control-0-6-2")),
                Some(ScriptRebound { id: "s-door".to_string(), from: at("control-0-5-2"), to: at("control-0-6-2") }),
            );
        }
        assert_eq!(h.saved_jobs("s-door"), vec![("sched-door".to_string(), at("control-0-6-2"))]);
        assert_eq!(h.saved_jobs("s-door-other"), vec![("sched-door-other".to_string(), at("control-0-9-2"))]);
        crate::scripting::scheduler::reset_jobs();
    }

    /// Insert Rows above a scripted button (rev6B#2): the backend re-keys the
    /// control and its script, and the script's scheduled job used to keep the
    /// old address -- after a save and reopen every tick was a FAILED run
    /// ("does not expose refresh() on button control-0-5-2"). And nothing told
    /// the main window, so the live mount kept the old id
    /// (NEW-control-rekey-live-script-mount). Ctrl+Z (the `obj_controls`
    /// restore) must move both back, and redo forward again.
    ///
    /// SABOTAGE: in `shift_controls`, assign `script.instance_id` directly
    /// instead of calling `rebind_script` -- the job stays on control-0-5-2.
    /// In the `obj_controls` restore arm, do the same -- the undo leaves the
    /// job on control-0-6-2.
    #[test]
    fn insert_rows_moves_a_control_scripts_jobs_and_announces_it_and_undo_moves_them_back() {
        let _jobs = crate::persistence::scheduler_test_guard();
        let h = Harness::new(1);
        h.scripted_button(0, 5, 2, "s-ins", "sched-ins");
        let _ = take_object_script_announcements();

        crate::commands::structure::insert_rows_impl(
            &h.state, &h.file, &h.pivots, &h.files, &h.pane, &h.filters, &h.slicer, &h.timeline, 2, 1, None,
        )
        .expect("insert_rows");
        assert_eq!(h.binding_of("s-ins"), at("control-0-6-2"), "the script moved with its control");
        assert_eq!(
            h.saved_jobs("s-ins"),
            vec![("sched-ins".to_string(), at("control-0-6-2"))],
            "the saved job calls the method where the script is bound now"
        );
        assert_eq!(
            take_object_script_announcements(),
            vec![rebound("s-ins", Some("control-0-6-2"))],
            "every window is told the script moved, and where"
        );

        h.undo();
        assert_eq!(h.binding_of("s-ins"), at("control-0-5-2"));
        assert_eq!(
            h.saved_jobs("s-ins"),
            vec![("sched-ins".to_string(), at("control-0-5-2"))],
            "one Ctrl+Z puts the job back with the script"
        );
        assert_eq!(
            take_object_script_announcements(),
            vec![rebound("s-ins", Some("control-0-5-2"))],
            "the undo announces the move back"
        );

        h.redo();
        assert_eq!(h.saved_jobs("s-ins"), vec![("sched-ins".to_string(), at("control-0-6-2"))]);
        assert_eq!(take_object_script_announcements(), vec![rebound("s-ins", Some("control-0-6-2"))]);
        crate::scripting::scheduler::reset_jobs();
    }

    /// A delete that takes the control's row unbinds its script: the jobs
    /// follow to no address, and the main window hears `instanceId: null`.
    /// Undo binds both back.
    #[test]
    fn deleting_a_controls_row_unbinds_its_script_and_jobs_and_undo_binds_them_back() {
        let _jobs = crate::persistence::scheduler_test_guard();
        let h = Harness::new(1);
        h.scripted_button(0, 5, 2, "s-del", "sched-del");
        let _ = take_object_script_announcements();

        crate::commands::structure::delete_rows_impl(
            &h.state, &h.file, &h.pivots, &h.files, &h.pane, &h.filters, &h.slicer, &h.timeline, 5, 1, None,
        )
        .expect("delete_rows");
        assert_eq!(h.binding_of("s-del"), None);
        assert_eq!(h.saved_jobs("s-del"), vec![("sched-del".to_string(), None)]);
        assert_eq!(take_object_script_announcements(), vec![rebound("s-del", None)]);

        h.undo();
        assert_eq!(h.binding_of("s-del"), at("control-0-5-2"));
        assert_eq!(h.saved_jobs("s-del"), vec![("sched-del".to_string(), at("control-0-5-2"))]);
        assert_eq!(take_object_script_announcements(), vec![rebound("s-del", Some("control-0-5-2"))]);
        crate::scripting::scheduler::reset_jobs();
    }

    /// The same edit OFF the sheet on screen (a script's or the command
    /// line's `sheetIndex`: `off_sheet_structural_edit`).
    #[test]
    fn an_insert_on_another_sheet_moves_that_sheets_control_script_jobs_and_announces_it() {
        let _jobs = crate::persistence::scheduler_test_guard();
        let h = Harness::new(2);
        h.scripted_button(1, 5, 2, "s-off", "sched-off");
        let _ = take_object_script_announcements();

        crate::commands::structure::insert_rows_impl(
            &h.state, &h.file, &h.pivots, &h.files, &h.pane, &h.filters, &h.slicer, &h.timeline, 0, 2, Some(1),
        )
        .expect("insert_rows on Sheet2");
        assert_eq!(h.binding_of("s-off"), at("control-1-7-2"));
        assert_eq!(h.saved_jobs("s-off"), vec![("sched-off".to_string(), at("control-1-7-2"))]);
        assert_eq!(take_object_script_announcements(), vec![rebound("s-off", Some("control-1-7-2"))]);
        crate::scripting::scheduler::reset_jobs();
    }

    /// Insert Cells, shift down, over the control's column
    /// (`shift_controls_in_band`).
    ///
    /// SABOTAGE: in `shift_controls_in_band`, assign `script.instance_id`
    /// directly instead of calling `rebind_script` -- the job stays put.
    #[test]
    fn insert_cells_moves_a_control_scripts_jobs_and_announces_it() {
        let _jobs = crate::persistence::scheduler_test_guard();
        let h = Harness::new(1);
        h.scripted_button(0, 5, 2, "s-band", "sched-band");
        let _ = take_object_script_announcements();

        let result = crate::commands::structure::structure_cells::shift_cells_impl(
            &h.state, &h.file, &h.pivots, &h.files, &h.pane, &h.filters, &h.slicer, &h.timeline, 1, 2, 1, 2,
            crate::commands::structure::structure_cells::CellShift::Down, false,
        )
        .expect("insert_cells");
        assert!(result.applied, "the cell shift was applied");
        assert_eq!(h.binding_of("s-band"), at("control-0-6-2"));
        assert_eq!(h.saved_jobs("s-band"), vec![("sched-band".to_string(), at("control-0-6-2"))]);
        assert_eq!(take_object_script_announcements(), vec![rebound("s-band", Some("control-0-6-2"))]);

        h.undo();
        assert_eq!(h.saved_jobs("s-band"), vec![("sched-band".to_string(), at("control-0-5-2"))]);
        assert_eq!(take_object_script_announcements(), vec![rebound("s-band", Some("control-0-5-2"))]);
        crate::scripting::scheduler::reset_jobs();
    }

    /// A control moved to another cell (the in-cell toggle; `move_control`).
    ///
    /// SABOTAGE: in `rekey_control_bindings`, assign `script.instance_id`
    /// directly instead of calling `rebind_script` -- the job stays put.
    #[test]
    fn moving_a_control_moves_its_scripts_jobs_and_announces_it() {
        let _jobs = crate::persistence::scheduler_test_guard();
        let h = Harness::new(1);
        h.scripted_button(0, 2, 1, "s-move", "sched-move");
        let _ = take_object_script_announcements();

        crate::controls::move_control_core(&h.state, &h.file, 0, (2, 1), (6, 3), HashMap::new()).expect("move");
        assert_eq!(h.binding_of("s-move"), at("control-0-6-3"));
        assert_eq!(h.saved_jobs("s-move"), vec![("sched-move".to_string(), at("control-0-6-3"))]);
        assert_eq!(take_object_script_announcements(), vec![rebound("s-move", Some("control-0-6-3"))]);

        h.undo();
        assert_eq!(h.saved_jobs("s-move"), vec![("sched-move".to_string(), at("control-0-2-1"))]);
        assert_eq!(take_object_script_announcements(), vec![rebound("s-move", Some("control-0-2-1"))]);
        crate::scripting::scheduler::reset_jobs();
    }

    /// A sheet move renumbers `control-<sheet>-...` (`remap_sheet_keyed_stores`).
    ///
    /// SABOTAGE: in `remap_sheet_keyed_stores`, assign `script.instance_id`
    /// directly instead of calling `rebind_script` -- the job keeps sheet 1.
    #[test]
    fn moving_a_sheet_renumbers_its_control_scripts_jobs_and_announces_it() {
        let _jobs = crate::persistence::scheduler_test_guard();
        let h = Harness::new(2);
        h.scripted_button(1, 4, 0, "s-sheet", "sched-sheet");
        let _ = take_object_script_announcements();

        crate::sheets::move_sheet_impl(&h.state, &h.file, &h.slicer, &h.timeline, &h.filters, 1, 0).expect("move sheet");
        assert_eq!(h.binding_of("s-sheet"), at("control-0-4-0"));
        assert_eq!(h.saved_jobs("s-sheet"), vec![("sched-sheet".to_string(), at("control-0-4-0"))]);
        assert_eq!(take_object_script_announcements(), vec![rebound("s-sheet", Some("control-0-4-0"))]);
        crate::scripting::scheduler::reset_jobs();
    }

    /// The wire: a "rebound" carries the binding (null for none); every other
    /// change carries no `instanceId` at all, so the frontend can tell "moved
    /// to nothing" from "not a move".
    #[test]
    fn a_rebound_payload_carries_the_binding_and_no_other_change_does() {
        let moved = serde_json::to_value(rebound("s", Some("control-0-6-2"))).unwrap();
        assert_eq!(moved, serde_json::json!({ "id": "s", "change": "rebound", "instanceId": "control-0-6-2" }));
        let unbound = serde_json::to_value(rebound("s", None)).unwrap();
        assert_eq!(unbound, serde_json::json!({ "id": "s", "change": "rebound", "instanceId": null }));
        let deleted = serde_json::to_value(ObjectScriptsChangedPayload {
            id: "s".to_string(),
            change: "deleted".to_string(),
            instance_id: None,
        })
        .unwrap();
        assert_eq!(deleted, serde_json::json!({ "id": "s", "change": "deleted" }));
    }
}
