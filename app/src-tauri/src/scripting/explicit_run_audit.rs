//! FILENAME: app/src-tauri/src/scripting/explicit_run_audit.rs
//! PURPOSE: The persistent trail of an application macro a PERSON ran with
//! cell access (owner decision B): the grants the mount door opens (follow-up
//! F3), the ONE report of which cells each granted run wrote (F15), and the
//! row for a run the page refused before it started because the macro reaches
//! outside cell access (F8).
//! CONTEXT: A module-runtime run of an application's macro leaves structured,
//! always-on grid-mutation rows (`record_script_grid_mutation`: surface, id,
//! sheet, cell count, bounds), because Rust applies its writes. A granted
//! object-script run writes through the worker realm's broker, one ordinary
//! cell command at a time, so Rust never sees "the run" -- only the page can
//! say which of those writes were the run's. This module is where it says so,
//! and the rows land on the SAME trail in the SAME shape (`ScriptExecuted`,
//! surface `object-script`, the macro as the surface id).
//!
//! WHAT RUST VOUCHES FOR, AND WHAT IT CANNOT. The application, the macro, the
//! door and the button on a writes row come from the grant the mount door
//! opened -- never from the page -- and a grant is reported ONCE: an unknown or
//! already-reported id records nothing and says so. The sheets, cell counts
//! and bounds are the page's account of the writes it brokered (it collects
//! them at the one hook every broker write passes, `recordScriptWrite` in
//! app/src/api/scriptHost/host.ts); they are validated for shape here, and the
//! row says when the run failed or some of its calls did, because then a cell
//! counted may not have changed. A hostile renderer can misreport its own
//! writes, as it can write cells without any script at all; what it cannot do
//! is name an application's macro that was never granted, or report one twice.
//!
//! The F8 refusal reads the application from the module store, never from the
//! page, records only for the bytes the store holds for that macro, and only
//! method names that are well-formed and appear in that source. It asks the
//! APPROVAL first (review of M6b): the pre-flight runs before the mount gate,
//! so a macro whose code was never approved used to be refused as "outside
//! cell access" -- a sentence that implies approved code and sends the person
//! to copy unapproved publisher code into a macro of their own. Such a run is
//! recorded `notConsented`, and the person reads the approval's own refusal.
//!
//! Both doors are main-window only (every person's door that mints a pass is a
//! main-window gesture) and write nothing but the audit trail, whose writes are
//! `deliberately_clean(CleanReason::AuditTrail)` inside the shared helpers.
//! Neither is for third parties: both are on the backend facade's denylist
//! (`codeExecution`, app/src/api/backendCommands.ts), beside the mount door
//! that opens the grants, and a grant id is random (review of M6b): a
//! sequential one let any caller of the report door name the NEXT grant and
//! spend it with an empty report before the run reported.

use std::collections::{HashSet, VecDeque};
use std::sync::Mutex;

use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use super::application_code_gate::{door_label, door_phrase, ButtonAttribution, OBJECT_SCRIPT_SURFACE};
use super::types::{ExplicitRunDoor, RunDoor, ScriptState};
use crate::held_button_code::a1;
use crate::AppState;

/// At most this many grants wait for their report. A grant whose run never
/// reports (the window closed mid-run) is dropped oldest-first, so the ledger
/// cannot grow without bound; the next report of a dropped grant is refused
/// like any unknown id.
pub(crate) const MAX_OPEN_GRANTS: usize = 64;

/// At most this many sheets in one report (a workbook has far fewer).
pub(crate) const MAX_REPORTED_SHEETS: usize = 4096;

/// At most this many method names in one F8 refusal.
pub(crate) const MAX_REFUSED_METHODS: usize = 64;

/// The largest grant id: the page reads an id as a JavaScript number, and
/// accepts only a safe integer (2^53 - 1).
pub(crate) const MAX_GRANT_ID: u64 = (1u64 << 53) - 1;

/// A run the mount door granted cell access, as the gate saw it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GrantedRun {
    /// The application whose approved macro it is (the mount's verified origin).
    pub application: String,
    /// The one approved artifact the run is.
    pub macro_id: String,
    /// The person's door.
    pub door: ExplicitRunDoor,
    /// The button a click ran it from, as the store described it.
    pub button: Option<ButtonAttribution>,
}

#[derive(Debug, Default)]
struct Ledger {
    open: VecDeque<(u64, GrantedRun)>,
}

/// The grants waiting for their one report (`ScriptState::explicit_run_grants`).
#[derive(Debug, Default)]
pub struct ExplicitRunGrants {
    inner: Mutex<Ledger>,
}

/// A fresh grant id: random, from the OS generator, in `1..=MAX_GRANT_ID`,
/// and not one still open. `None` when the generator cannot answer.
fn fresh_grant_id(open: &VecDeque<(u64, GrantedRun)>) -> Option<u64> {
    loop {
        let mut bytes = [0u8; 8];
        OsRng.try_fill_bytes(&mut bytes).ok()?;
        let candidate = u64::from_le_bytes(bytes) & MAX_GRANT_ID;
        if candidate != 0 && !open.iter().any(|(id, _)| *id == candidate) {
            return Some(candidate);
        }
    }
}

impl ExplicitRunGrants {
    /// Open a grant and hand back its id -- UNGUESSABLE, so nothing but the
    /// run it was handed to can report under it; `None` when the ledger cannot
    /// be written or no id can be drawn (the caller then grants nothing).
    pub(crate) fn open(&self, run: GrantedRun) -> Option<u64> {
        let mut ledger = self.inner.lock().ok()?;
        let id = fresh_grant_id(&ledger.open)?;
        while ledger.open.len() >= MAX_OPEN_GRANTS {
            ledger.open.pop_front();
        }
        ledger.open.push_back((id, run));
        Some(id)
    }

    /// Take a grant out for its report: `None` when no grant with that id is
    /// waiting (never opened, already reported, or dropped).
    pub(crate) fn take(&self, id: u64) -> Option<GrantedRun> {
        let mut ledger = self.inner.lock().ok()?;
        let at = ledger.open.iter().position(|(open, _)| *open == id)?;
        ledger.open.remove(at).map(|(_, run)| run)
    }

    /// Close every waiting grant: the document they ran in is gone
    /// (`persistence::reset_document_scoped_stores`), so their writes must not
    /// be reported onto the next one's trail. A closed grant's id is refused
    /// like any unknown one.
    pub(crate) fn clear(&self) -> Result<(), String> {
        self.inner.lock().map_err(|e| e.to_string())?.open.clear();
        Ok(())
    }

    /// How many grants are waiting (tests).
    #[cfg(test)]
    pub(crate) fn waiting(&self) -> usize {
        self.inner.lock().map(|l| l.open.len()).unwrap_or(0)
    }
}

// ============================================================================
// F15: what a granted run wrote
// ============================================================================

/// One sheet a granted run wrote, as the page counted it: distinct cells, and
/// their bounding box (0-based, inclusive).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExplicitRunSheetWrites {
    /// The TRUE state-vector index of the sheet.
    pub sheet: usize,
    pub cells_modified: u32,
    pub first_row: u32,
    pub last_row: u32,
    pub first_col: u32,
    pub last_col: u32,
}

/// The page's ONE report of a granted run's writes, sent when the grant
/// expires (the run's `setup` settled) or the realm ends first.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExplicitRunWritesReport {
    /// The grant the mount door opened (`MountGateAnswer::grant_id`).
    pub grant_id: u64,
    /// The run's `setup` finished without throwing. When it did not, the page
    /// takes back everything it wrote (owner decision B, follow-up F9:
    /// `undo_commands::roll_back_to_undo_savepoint`) and says whether it could.
    pub completed: bool,
    /// The run did not complete and EVERY change it made was taken back, so
    /// the cells counted here hold what they held before it. `false` for a run
    /// that completed, and for one whose changes could not be taken back.
    #[serde(default)]
    pub rolled_back: bool,
    /// Calls of the run that failed (refused by the broker or the backend):
    /// a cell counted for one of them may not have changed.
    pub failed_calls: u32,
    /// The page stopped counting distinct cells at its cap: the counts are
    /// lower bounds (the bounds stay exact).
    #[serde(default)]
    pub counts_capped: bool,
    /// Cells the rollback took back that were NOT the run's own writes: written
    /// by somebody else while it ran (the person typing meanwhile, another
    /// script), and undone with it because they were recorded in the same undo
    /// step (review of M6b). Only for a run that was taken back.
    #[serde(default)]
    pub others_undone: u32,
    /// One entry per sheet written, each sheet at most once. Empty when the
    /// run wrote nothing: the grant is closed, and a run that did not complete
    /// still leaves one row saying it changed no cells (a completed run's run
    /// row already says it ran).
    pub sheets: Vec<ExplicitRunSheetWrites>,
}

/// Record a granted run's writes: one always-on `ScriptExecuted` row per sheet
/// (surface `object-script`, the macro as the surface id, the sheet, the cell
/// count and the bounds -- the module runtime's shape), naming the
/// application, the door and the button from the grant. Answers how many rows
/// were written. Main window only.
#[tauri::command]
pub fn audit_explicit_run_writes(
    state: State<AppState>,
    script_state: State<ScriptState>,
    window: tauri::Window,
    report: ExplicitRunWritesReport,
) -> Result<usize, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    audit_explicit_run_writes_core(&state, &script_state.explicit_run_grants, &report)
}

/// The shape a report must have before it may close its grant.
fn validate_report(report: &ExplicitRunWritesReport) -> Result<(), String> {
    if report.sheets.len() > MAX_REPORTED_SHEETS {
        return Err(format!("The report names {} sheets; nothing was recorded.", report.sheets.len()));
    }
    if report.completed && report.rolled_back {
        return Err("The report says a run that completed was taken back; nothing was recorded.".to_string());
    }
    if report.others_undone > 0 && !report.rolled_back {
        return Err(
            "The report counts other changes undone for a run that was not taken back; nothing was recorded."
                .to_string(),
        );
    }
    let mut seen: HashSet<usize> = HashSet::new();
    for s in &report.sheets {
        if !seen.insert(s.sheet) {
            return Err(format!("The report names sheet {} twice; nothing was recorded.", s.sheet + 1));
        }
        if s.first_row > s.last_row || s.first_col > s.last_col {
            return Err(format!("The report's bounds for sheet {} are inverted; nothing was recorded.", s.sheet + 1));
        }
        let area = (u64::from(s.last_row - s.first_row) + 1) * (u64::from(s.last_col - s.first_col) + 1);
        if s.cells_modified == 0 || u64::from(s.cells_modified) > area {
            return Err(format!(
                "The report counts {} cell(s) on sheet {} inside bounds that hold {area}; nothing was recorded.",
                s.cells_modified,
                s.sheet + 1
            ));
        }
    }
    Ok(())
}

/// [`audit_explicit_run_writes`] over plain references, for the unit tier.
/// A malformed report is refused BEFORE its grant is taken, so it cannot spend
/// one; a well-formed report of an unknown grant records nothing.
pub(crate) fn audit_explicit_run_writes_core(
    state: &AppState,
    grants: &ExplicitRunGrants,
    report: &ExplicitRunWritesReport,
) -> Result<usize, String> {
    validate_report(report)?;
    let run = grants.take(report.grant_id).ok_or_else(|| {
        format!(
            "No run with cell access is waiting to report under grant {}: it was never granted, it was already \
             reported, or it is too old. Nothing was recorded.",
            report.grant_id
        )
    })?;
    if report.sheets.is_empty() && report.completed {
        // It ran and wrote nothing: its run row already says it ran.
        return Ok(0);
    }
    let door = RunDoor::from(run.door);
    let button_phrase = run
        .button
        .as_ref()
        .map(|b| match b.kind {
            crate::held_button_code::MacroLinkKind::Control => format!(" (button {})", b.cell),
            crate::held_button_code::MacroLinkKind::Cell => format!(" (button cell {})", b.cell),
        })
        .unwrap_or_default();
    let others_phrase = |n: u32| {
        format!(
            "{n} other cell change{} made while it ran {} undone with it",
            if n == 1 { "" } else { "s" },
            if n == 1 { "was" } else { "were" }
        )
    };
    if report.sheets.is_empty() {
        // A GRANTED RUN THAT CHANGED NOTHING AND DID NOT COMPLETE (review of
        // M6b): it never started (no undo step could be marked, the mount was
        // superseded) or it stopped before it wrote. The run row written at
        // admission says it ran with cell access; without this row nothing
        // would ever say it changed no cells.
        let mut tail: Vec<String> = Vec::new();
        if report.others_undone > 0 {
            tail.push(others_phrase(report.others_undone));
        }
        if report.failed_calls > 0 {
            tail.push(format!("{} of its calls failed", report.failed_calls));
        }
        let description = format!(
            "'{}' from the application '{}'{}, which you started from {}, changed no cells: it stopped before \
             it finished, or never started{}",
            run.macro_id,
            run.application,
            button_phrase,
            door_phrase(door),
            if tail.is_empty() { String::new() } else { format!("; {}", tail.join("; ")) }
        );
        let mut extra: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
        extra.insert("surface".into(), Value::from(OBJECT_SCRIPT_SURFACE));
        extra.insert("surfaceId".into(), Value::from(run.macro_id.as_str()));
        extra.insert("application".into(), Value::from(run.application.as_str()));
        extra.insert("macroId".into(), Value::from(run.macro_id.as_str()));
        extra.insert("startedBy".into(), Value::from("you"));
        extra.insert("door".into(), Value::from(door_label(door)));
        extra.insert("cellAccess".into(), Value::from(true));
        extra.insert("grantId".into(), Value::from(report.grant_id));
        extra.insert("completed".into(), Value::from(false));
        extra.insert("rolledBack".into(), Value::from(report.rolled_back));
        extra.insert("cellsModified".into(), Value::from(0));
        if report.others_undone > 0 {
            extra.insert("othersUndone".into(), Value::from(report.others_undone));
        }
        if report.failed_calls > 0 {
            extra.insert("failedCalls".into(), Value::from(report.failed_calls));
        }
        if let Some(button) = &run.button {
            extra.insert("button".into(), serde_json::to_value(button).unwrap_or(Value::Null));
        }
        crate::calp_commands::record_audit_event_with_extra(
            state,
            calp::audit::AuditEvent::ScriptExecuted,
            description,
            extra,
        );
        return Ok(1);
    }
    // One short guard: the sheet names, cloned out.
    let names: Vec<String> = state.sheet_names.read().map_err(|e| e.to_string())?.clone();
    let mut caveats: Vec<String> = Vec::new();
    if !report.completed {
        caveats.push(if report.rolled_back {
            let undone = "the run stopped with an error before it finished, and every change it made was undone";
            if report.others_undone > 0 {
                format!("{undone} -- and {}", others_phrase(report.others_undone))
            } else {
                undone.to_string()
            }
        } else {
            "the run stopped with an error before it finished, and its changes could not be undone".to_string()
        });
    }
    if report.failed_calls > 0 {
        caveats.push(format!(
            "{} of its calls failed, so a cell counted here may not have changed",
            report.failed_calls
        ));
    }
    if report.counts_capped {
        caveats.push("the count is a lower bound".to_string());
    }
    let caveat = if caveats.is_empty() { String::new() } else { format!("; {}", caveats.join("; ")) };
    for s in &report.sheets {
        let name = names.get(s.sheet).cloned().unwrap_or_else(|| format!("Sheet{}", s.sheet + 1));
        let range = if s.first_row == s.last_row && s.first_col == s.last_col {
            a1(s.first_row, s.first_col)
        } else {
            format!("{}:{}", a1(s.first_row, s.first_col), a1(s.last_row, s.last_col))
        };
        let description = format!(
            "'{}' from the application '{}'{}, which you started from {}, changed {} cell(s) on {}!{}{}",
            run.macro_id,
            run.application,
            button_phrase,
            door_phrase(door),
            s.cells_modified,
            name,
            range,
            caveat
        );
        let mut extra: Vec<(&str, Value)> = vec![
            ("application", Value::from(run.application.as_str())),
            ("macroId", Value::from(run.macro_id.as_str())),
            ("startedBy", Value::from("you")),
            ("door", Value::from(door_label(door))),
            ("cellAccess", Value::from(true)),
            ("grantId", Value::from(report.grant_id)),
            ("completed", Value::from(report.completed)),
        ];
        if !report.completed {
            extra.push(("rolledBack", Value::from(report.rolled_back)));
        }
        if report.others_undone > 0 {
            extra.push(("othersUndone", Value::from(report.others_undone)));
        }
        if report.failed_calls > 0 {
            extra.push(("failedCalls", Value::from(report.failed_calls)));
        }
        if report.counts_capped {
            extra.push(("countsCapped", Value::from(true)));
        }
        if let Some(button) = &run.button {
            extra.push(("button", serde_json::to_value(button).unwrap_or(Value::Null)));
        }
        super::commands::record_script_grid_mutation_with(
            state,
            &description,
            OBJECT_SCRIPT_SURFACE,
            &run.macro_id,
            s.sheet,
            s.cells_modified,
            Some((s.first_row, s.last_row, s.first_col, s.last_col)),
            extra,
        );
    }
    Ok(report.sheets.len())
}

// ============================================================================
// F8: a granted run refused before it started
// ============================================================================

/// Record that the one-off runner refused an application's object-script
/// macro a person ran BEFORE it started, because it also calls methods outside
/// cell access (the runner's pre-flight, `ungrantedApiCalls` in
/// app/src/api/scriptHost/explicitRunGrant.ts). Until this, that refusal --
/// "Nothing was changed" -- left no row: it happens before the mount door is
/// ever asked. Main window only.
///
/// The APPROVAL is asked first (review of M6b): a macro whose code is not
/// approved is recorded `notConsented`, and the answer hands the page the
/// approval's own refusal to say instead of the pre-flight's sentence.
#[tauri::command]
pub fn audit_explicit_run_refusal(
    state: State<AppState>,
    script_state: State<ScriptState>,
    window: tauri::Window,
    script_id: String,
    source: String,
    methods: Vec<String>,
) -> Result<ExplicitRunRefusalAnswer, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let scripts: Vec<(Option<String>, String, String)> = {
        let map = script_state.workbook_scripts.read().map_err(|e| e.to_string())?;
        map.values().map(|s| (s.source_package.clone(), s.id.clone(), s.source.clone())).collect()
    };
    let consent_file = crate::calp_commands::read_script_consent_file(tauri::Manager::app_handle(&window));
    audit_explicit_run_refusal_core(&state, &scripts, consent_file.as_ref(), &script_id, &source, &methods)
}

/// What the F8 door recorded, for the page to say.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplicitRunRefusalAnswer {
    /// The reason on the row: `outsideCellAccess` (the pre-flight's own), or
    /// `notConsented` when the macro's code is not approved.
    pub reason: &'static str,
    /// For `notConsented`: the approval's refusal -- the very text the mount
    /// gate would have given -- which the person reads INSTEAD of the
    /// pre-flight's sentence. `None` for `outsideCellAccess`.
    pub message: Option<String>,
}

/// A method name as the pre-flight reports it: `api.<name>` or `base.<name>`.
fn is_method_name(method: &str) -> bool {
    let Some((ns, name)) = method.split_once('.') else { return false };
    let mut chars = name.chars();
    matches!(ns, "api" | "base")
        && name.len() <= 64
        && chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

/// [`audit_explicit_run_refusal`] over plain references, for the unit tier:
/// `scripts` are the stored modules as `(source_package, id, source)`, and
/// `consent_file` the workbook's parsed (verified) consent file.
pub(crate) fn audit_explicit_run_refusal_core(
    state: &AppState,
    scripts: &[(Option<String>, String, String)],
    consent_file: Option<&Value>,
    script_id: &str,
    source: &str,
    methods: &[String],
) -> Result<ExplicitRunRefusalAnswer, String> {
    let (package, _, stored) = scripts
        .iter()
        .find(|(_, id, _)| id == script_id)
        .ok_or_else(|| format!("There is no stored macro '{script_id}'; nothing was recorded."))?;
    let application = package
        .clone()
        .filter(|p| !p.trim().is_empty())
        .ok_or_else(|| format!("'{script_id}' did not come with an application; nothing was recorded."))?;
    // The pre-flight reads the bytes the store holds for this macro (the one-off
    // runner runs exactly those); anything else was not about to run.
    if stored != source {
        return Err(format!("'{script_id}' does not hold that source; nothing was recorded."));
    }
    // THE APPROVAL FIRST (review of M6b): unapproved code is refused for THAT,
    // in the approval's own words, whatever else it calls.
    if let Some(refusal) = super::commands::distributed_module_refusal(scripts, consent_file, source) {
        super::application_code_gate::record_explicit_run_not_approved(
            state,
            &application,
            script_id,
            calp::integrity::sha256_hex(source.as_bytes()),
        );
        return Ok(ExplicitRunRefusalAnswer { reason: "notConsented", message: Some(refusal) });
    }
    if methods.is_empty() || methods.len() > MAX_REFUSED_METHODS {
        return Err(format!("A refusal names {} methods; nothing was recorded.", methods.len()));
    }
    let mut named: Vec<String> = Vec::with_capacity(methods.len());
    for method in methods {
        if !is_method_name(method) {
            return Err(format!("'{method}' is not a method name; nothing was recorded."));
        }
        // The pre-flight reads method names out of the source; one that is not
        // in it was not refused for this macro.
        let short = method.split_once('.').map(|(_, n)| n).unwrap_or_default();
        if !source.contains(short) {
            return Err(format!("'{script_id}' does not call {method}; nothing was recorded."));
        }
        if !named.contains(method) {
            named.push(method.clone());
        }
    }
    named.sort();
    super::application_code_gate::record_explicit_run_refused(
        state,
        &application,
        script_id,
        calp::integrity::sha256_hex(source.as_bytes()),
        &named,
    );
    Ok(ExplicitRunRefusalAnswer { reason: "outsideCellAccess", message: None })
}

#[cfg(test)]
#[path = "explicit_run_audit_tests.rs"]
mod tests;
