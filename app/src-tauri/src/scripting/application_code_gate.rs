//! FILENAME: app/src-tauri/src/scripting/application_code_gate.rs
//! PURPOSE: The run gate for an APPLICATION's code (phase 3 of BUG-0257): the
//! checks that sit between "the user clicked a button that links an
//! application's macro" and that macro actually running, and the audit trail
//! of every run and every refusal.
//! CONTEXT: Phase 3 lets a button control keep a link to its application's
//! macro -- held and stamped at a subscribe, refresh or checkout -- and run it
//! after the application's approval. Every route by which that code runs
//! reaches Rust through one of two doors: `run_script` (the module runtime) and
//! `check_distributed_mount_consent` (a worker-realm mount, which is how the
//! one-off runner starts a macro). Both now go through this module:
//!
//! 1. THE APPROVAL (unchanged): the hash-keyed consent the application's
//!    macros already need (`distributed_module_refusal`, and for a mount
//!    `distributed_mount_refusal`). Its refusal text is exactly what it was.
//! 2. THE WORKING-COPY PRIVATE-SHEET RULE. In a workbook that is a working copy
//!    of an application, code that CAME WITH an application runs only when none
//!    of the developer's own sheets sit beside the application's. Checkout is
//!    additive, so a teammate's approved macro could otherwise copy a private
//!    sheet into a very-hidden application sheet, and the developer's next push
//!    would sign it and ship it to every subscriber.
//! 3. THE BUTTON. A run a click asked for names its button (`trigger`). That is
//!    a claim the renderer makes, and it is verified here against the backend's
//!    own store: the button at that cell must link exactly the code that is
//!    about to run, under that application's stamp. A claim can only NARROW
//!    what runs; a hostile renderer can OMIT it (the run is then still gated
//!    and audited, without the button) -- phase 4's Rust button door closes that.
//! 4. THE TRAIL. Every run of an application's code, and every refusal, is an
//!    always-on audit row (`ApplicationCodeRun` / `ApplicationCodeRefused`)
//!    naming the application, the macro and -- when a button asked and storage
//!    backs it -- the button. On the mount door an EXPLICIT run (the one-off
//!    runner: Developer > Macros > Run, the CLI, a button) is asked twice: once
//!    before Script Security (`MountGatePhase::RunCheck`: every refusal
//!    recorded, no run row -- the run has not been admitted yet) and once after
//!    it (`RunAdmitted`: the run row), so the trail never says code ran that a
//!    later gate stopped. Local and ad-hoc runs are neither gated nor recorded
//!    here: they are the user's own code.
//! 5. THE RULE HOLDS WHILE CODE RUNS, not only when it mounts. A standing realm
//!    (an object script, a library) that mounted in a clean working copy asks
//!    again (`MountGatePhase::Standing`) before each thing it does and each event
//!    it is told, so a private sheet that appears later -- the rule's own remedy
//!    followed by an added or pasted sheet, or a blank sheet typed into -- stops
//!    it: the host ends the realm, and only a new, fully gated mount brings it back.
//! 6. THE BUTTON DOOR (phase 4, `control_action::run_control_action`) asks
//!    [`button_run_gate`] of the FINAL source a click's plan runs: an
//!    application's held inline bytes need the approval of exactly those bytes
//!    (`buttonAction:<sha256>`), a source an application's stored module carries
//!    needs that module's approval -- also when the user's own button asked for
//!    it -- and both meet the private-sheet rule and leave a row. A button CELL
//!    of an application's that names a Calcula COMMAND is asked
//!    [`button_command_gate`] instead (plan_M8 S1): on Rust's list, approved
//!    under its own key, the private-sheet rule -- by the door, and again with
//!    the run row by `authorize_button_command` once the page has checked the
//!    live registration.
//! 7. A RUN A SCRIPT STARTS (owner decision B, follow-up F10). An APPROVED
//!    application macro the user runs EXPLICITLY -- Developer > Macros > Run,
//!    a button that runs it, the command line -- gets the same cell access in
//!    either runtime; standing object scripts and any run a script starts stay
//!    restricted. The module runtime has no tiers: an application's module
//!    macro runs with its full `Calcula.*` reach or not at all. So the
//!    module-runtime door refuses it -- and records the refusal -- unless the
//!    request names a person's act (`RunScriptRequest.started_by`, see
//!    [`not_started_by_you`]). The user's own and ad-hoc code is not asked.
//! 8. THE BACKSTOP: an application's held button code is not the user's own
//!    just because no stored module carries it. Exactly three routes run an
//!    unnamed source as the user's own and ask it: `run_script`'s ad-hoc
//!    branch, a cell of a notebook of the user's own (or of no stored notebook,
//!    `notebook_commands::own_notebook_cell_backstop`), and the mount door's
//!    application-floor-only branch. Each refuses a source that is, or
//!    carries, held code ([`held_code_outside_its_button`]). It is a heuristic
//!    against a route that mistakes held bytes for the user's own, NOT a
//!    boundary against a hostile page -- which may run any ad-hoc code of its
//!    own -- and it does not cover MCP / AI `execute_script` (a follow-up) or a
//!    LIVE `onSelect` the page writes onto a button (the user's own code by
//!    definition). See the section below for what it matches.

use std::collections::{HashMap, HashSet};

use identity::SheetId;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::commands::{
    distributed_module_refusal, distributed_mount_refusal, MountConsentArtifact, DISTRIBUTED_SCRIPT_NOT_CONSENTED,
};
use super::explicit_run_audit::{ExplicitRunGrants, GrantedRun};
use super::types::{ExplicitRunClaim, ExplicitRunDoor, RunDoor, RunStartedBy, ScriptRunTrigger, ScriptRunTriggerKind};
use crate::held_button_code::{a1, HeldFrom, MacroLinkKind};
use crate::AppState;

/// Error sentinel: an application's code refused beside the developer's own
/// sheets in a working copy.
pub const APPLICATION_CODE_BESIDE_PRIVATE_SHEETS: &str = "APPLICATION_CODE_BESIDE_PRIVATE_SHEETS";
/// Error sentinel: a click claimed a button the backend's store does not back.
pub const APPLICATION_CODE_TRIGGER_MISMATCH: &str = "APPLICATION_CODE_TRIGGER_MISMATCH";
/// Error sentinel: an application's module macro that no person started (owner
/// decision B, follow-up F10). Mirrored in `app/src/api/workbookScripts.ts`.
pub const APPLICATION_MACRO_NOT_STARTED_BY_YOU: &str = "APPLICATION_MACRO_NOT_STARTED_BY_YOU";

/// The mount surfaces the private-sheet rule GATES: their code can write the
/// grid, so what it copies out of a private sheet lands in the application's
/// sheets and goes out with the next push. Every `CONSENT_SURFACES` row is in
/// exactly one of this list and [`PRIVATE_SHEET_RULE_EXEMPT`], so a new surface
/// has to be decided (pinned by
/// `every_consent_surface_decides_the_private_sheet_rule`).
pub(crate) const PRIVATE_SHEET_RULE_SURFACES: &[&str] = &["object-script", "lib"];

/// The mount surfaces the private-sheet rule does NOT gate, each with why.
pub(crate) const PRIVATE_SHEET_RULE_EXEMPT: &[(&str, &str)] = &[
    (
        "chart-marks",
        "paint only: the mount declares an empty ceiling and hands back an image and hit geometry for \
         the chart's own plot area; it writes no cell",
    ),
    (
        "chart-transforms",
        "a data-to-data transform over the chart's own series: its result feeds the chart, not a cell",
    ),
    (
        "custom-functions",
        "a function hands a value back to the formula that called it, and that formula -- which decides \
         where the value lands -- travels with the application anyway",
    ),
    (
        "writeback-validators",
        "the authoritative run sees one submitted value over an empty cloned grid and answers accept or \
         a message; it writes no cell",
    ),
];

/// Does the private-sheet rule gate this mount surface?
pub(crate) fn private_sheet_rule_gates(surface: &str) -> bool {
    PRIVATE_SHEET_RULE_SURFACES.contains(&surface.trim())
}

/// Which question the mount door (`check_distributed_mount_consent`) is asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MountGatePhase {
    /// A STANDING mount -- a workbook's approved charts, functions, object
    /// scripts and libraries, mounted on every load. Gated in full; only a
    /// private-sheet refusal (and a claim storage does not back) is recorded,
    /// because a row per load would drown the trail.
    #[default]
    Mount,
    /// An EXPLICIT run (the one-off runner), asked BEFORE Script Security: gated
    /// in full, every refusal recorded, and NO run row -- Script Security may
    /// still refuse it, and a row saying it ran would then be false.
    RunCheck,
    /// The same run AFTER Script Security admitted it: gated again (nothing may
    /// have changed in between), then the always-on `ApplicationCodeRun` row --
    /// with or without a button.
    RunAdmitted,
    /// A realm already MOUNTED, about to act (a broker call) or be told something
    /// (an event): the private-sheet rule only, for the surfaces it gates.
    Standing,
}

/// What the mount door answers when it admits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MountGateAnswer {
    /// The host must ask again (`MountGatePhase::Standing`) while this code
    /// runs: the workbook is a working copy and the surface is one the
    /// private-sheet rule gates, so the rule can start refusing after the
    /// mount. Rust decides -- the host keeps no surface list of its own.
    pub recheck_while_running: bool,
    /// This admitted run of an application's macro may read and change cells
    /// on any sheet while it runs (owner decision B, follow-up F3): a person
    /// ran it through one of the doors that give that access, and everything
    /// Rust can see agrees ([`explicit_run_cell_access`]). Only ever `true` on
    /// `RunAdmitted`; the always-on run row says the same. The page grants the
    /// access only when this says so (an absent field is no grant).
    pub cell_access: bool,
    /// The id of that grant, which the page's ONE report of what the run wrote
    /// presents (`explicit_run_audit::audit_explicit_run_writes`, F15). `Some`
    /// exactly when `cell_access`.
    pub grant_id: Option<u64>,
}

impl MountGateAnswer {
    /// An admission that grants nothing beyond the code's own tier.
    fn admitted(recheck_while_running: bool) -> Self {
        MountGateAnswer { recheck_while_running, cell_access: false, grant_id: None }
    }
}

// ============================================================================
// The working-copy private-sheet rule
// ============================================================================

/// One sheet of the open workbook, as the private-sheet rule sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SheetFacts {
    pub id: SheetId,
    pub name: String,
    /// The sheet holds at least one cell. A BLANK sheet has nothing to copy --
    /// and every new workbook starts with one, so counting it would make the
    /// rule's own remedy ("open the application for editing in a new
    /// workbook") refuse exactly like the workbook it replaced.
    pub holds_cells: bool,
}

/// The sheets of the open workbook, for the private-sheet rule.
///
/// LOCKS: one at a time, each released before the next -- the active-sheet
/// mirror (`grid`) before `grids`, the crate's canonical order, then the names
/// and the ids. A sheet whose grid cannot be found counts as holding cells:
/// the rule fails closed.
pub(crate) fn workbook_sheet_facts(state: &AppState) -> Result<Vec<SheetFacts>, String> {
    let active = *state.active_sheet.read().map_err(|e| e.to_string())?;
    // `grid` is the authoritative copy of the ACTIVE sheet; `grids[active]` may
    // lag behind it (BUG-0016), so a sheet the user just typed into is judged
    // by the mirror too.
    let active_holds = !state.grid.read().map_err(|e| e.to_string())?.cells.is_empty();
    let holds: Vec<bool> = state
        .grids
        .read()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|g| !g.cells.is_empty())
        .collect();
    let names: Vec<String> = state.sheet_names.read().map_err(|e| e.to_string())?.clone();
    let ids: Vec<SheetId> = state.sheet_ids.read().map_err(|e| e.to_string())?.clone();
    Ok(ids
        .iter()
        .enumerate()
        .map(|(i, id)| SheetFacts {
            id: *id,
            name: names.get(i).cloned().unwrap_or_else(|| format!("Sheet{}", i + 1)),
            holds_cells: holds.get(i).copied().unwrap_or(true) || (i == active && active_holds),
        })
        .collect())
}

/// The names of the sheets a working copy holds BESIDE its application: every
/// sheet not among the link's base sheets (a floating range's backing sheet
/// included) that holds a cell. Empty when the workbook is not a working copy.
pub(crate) fn private_sheets(link: Option<&calp::WorkingCopyLink>, sheets: &[SheetFacts]) -> Vec<String> {
    let Some(link) = link else { return Vec::new() };
    let base: HashSet<SheetId> = link.base_sheets.iter().map(|s| s.sheet_id).collect();
    sheets
        .iter()
        .filter(|s| s.holds_cells && !base.contains(&s.id))
        .map(|s| s.name.clone())
        .collect()
}

/// THE PRIVATE-SHEET RULE, pure: `Some(refusal)` when code that came with the
/// application `application` may not run because this workbook is a working
/// copy that also holds the developer's own sheets.
///
/// Applies ONLY in a working copy (`link` is `Some`), and only to DISTRIBUTED
/// code -- the caller decides that, since only it knows whose code this is. A
/// sheet the developer added and has not pushed yet counts as their own until
/// it is pushed (a push makes it a base sheet) or removed.
pub(crate) fn private_sheet_refusal(
    link: Option<&calp::WorkingCopyLink>,
    sheets: &[SheetFacts],
    application: &str,
    artifact: &str,
) -> Option<String> {
    let link = link?;
    let private = private_sheets(Some(link), sheets);
    if private.is_empty() {
        return None;
    }
    let named: Vec<&str> = private.iter().take(3).map(String::as_str).collect();
    let more = private.len() - named.len();
    Some(format!(
        "{APPLICATION_CODE_BESIDE_PRIVATE_SHEETS}: \"{artifact}\" came with the application \"{application}\". \
         This workbook is a working copy of \"{}\" and also holds sheets that are not part of it ({}{}). \
         Code from an application can read every sheet, and what it writes into the application's sheets \
         goes out with your next push, so it does not run here while your own sheets sit beside it. Move \
         them to another workbook, or open the application for editing in a new workbook.",
        link.package_name,
        named.join(", "),
        if more > 0 { format!(", +{more} more") } else { String::new() }
    ))
}

// ============================================================================
// The button a click claims
// ============================================================================

/// The button a run came from, as the backend's own store describes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ButtonAttribution {
    pub kind: MacroLinkKind,
    /// The button's cell, e.g. "Dashboard!B2".
    pub cell: String,
    /// What the button says: a control's `text`, a cell's `label`.
    pub caption: String,
    /// The application the BUTTON came with (its stamp); `None` for a button of
    /// the author's own.
    pub application: Option<String>,
    /// The link is the application's, held for it (as opposed to a live link of
    /// the author's own).
    pub held: bool,
}

/// Verify a click's claim against the backend's store: the button at the
/// trigger's cell must link one of `artifact_ids`, and a stamped button must
/// have come with `package`.
///
/// * A button CONTROL passes when its own live `macroRef` names the code (a
///   link of the author's own -- the click reads it first), or when it has no
///   live link and its held `heldMacroRef` names the code under a stamp
///   (`heldFrom`) whose application is `package`.
/// * A button CELL passes when its script action (live, or held) names the code
///   and its stamp (`fromApplication`) names `package` -- or, for a live action,
///   it carries no stamp at all (the author's own button, which the click runs
///   exactly like a control's own live link).
///
/// Everything else is a refusal naming the cell and why. LOCKS: the sheet
/// names are cloned out first, then the one store is read under a short guard.
pub(crate) fn verify_trigger(
    state: &AppState,
    trigger: &ScriptRunTrigger,
    package: &str,
    artifact_ids: &[&str],
) -> Result<ButtonAttribution, String> {
    let sheet_name = state
        .sheet_names
        .read()
        .map_err(|e| e.to_string())?
        .get(trigger.sheet_index)
        .cloned()
        .unwrap_or_else(|| format!("Sheet{}", trigger.sheet_index + 1));
    let cell = format!("{}!{}", sheet_name, a1(trigger.row, trigger.col));
    let key = (trigger.sheet_index, trigger.row, trigger.col);
    let names = |ids: &[&str]| -> String {
        if ids.is_empty() {
            "nothing it names".to_string()
        } else {
            ids.iter().map(|id| format!("'{id}'")).collect::<Vec<_>>().join(", ")
        }
    };
    match trigger.kind {
        ScriptRunTriggerKind::ButtonControl => {
            let meta = state.controls.read().map_err(|e| e.to_string())?.get(&key).cloned();
            let Some(meta) = meta else {
                return Err(format!("there is no button control at {cell}"));
            };
            let value = |k: &str| {
                meta.properties.get(k).map(|p| p.value.clone()).filter(|v| !v.is_empty())
            };
            let caption = value("text").unwrap_or_default();
            // The live link wins, exactly as it does on the click.
            if let Some(live) = value(crate::controls::MACRO_REF_PROPERTY) {
                if artifact_ids.contains(&live.as_str()) {
                    return Ok(ButtonAttribution {
                        kind: MacroLinkKind::Control,
                        cell,
                        caption,
                        application: None,
                        held: false,
                    });
                }
                return Err(format!(
                    "the button at {cell} links the macro '{live}', not {}",
                    names(artifact_ids)
                ));
            }
            let Some(held) = value(crate::controls::HELD_MACRO_REF_PROPERTY) else {
                return Err(format!("the button at {cell} links no macro"));
            };
            let stamp = meta
                .properties
                .get(crate::controls::HELD_FROM_PROPERTY)
                .and_then(|p| HeldFrom::decode(&p.value));
            match stamp {
                None => Err(format!(
                    "the button at {cell} holds a link whose record of which application it came with is \
                     missing or unreadable"
                )),
                Some(from) if from.application != package => Err(format!(
                    "the button at {cell} came with the application '{}', and this code came with '{package}'",
                    from.application
                )),
                Some(_) if !artifact_ids.contains(&held.as_str()) => Err(format!(
                    "the button at {cell} links the macro '{held}', not {}",
                    names(artifact_ids)
                )),
                Some(from) => Ok(ButtonAttribution {
                    kind: MacroLinkKind::Control,
                    cell,
                    caption,
                    application: Some(from.application),
                    held: true,
                }),
            }
        }
        ScriptRunTriggerKind::ButtonCell => {
            let assignment = state.cell_types.read().map_err(|e| e.to_string())?.get(&key).cloned();
            let Some(assignment) =
                assignment.filter(|a| a.type_id == crate::button_cells::BUTTON_CELL_TYPE_ID)
            else {
                return Err(format!("there is no button cell at {cell}"));
            };
            let params = &assignment.params;
            let caption = params.get("label").and_then(Value::as_str).unwrap_or_default().to_string();
            let script_of = |k: &str| -> Option<String> {
                let action = params.get(k)?;
                if action.get("kind").and_then(Value::as_str) != Some("script") {
                    return None;
                }
                action.get("scriptId").and_then(Value::as_str).map(str::to_string)
            };
            // The stamp, read the ONE way the button door and the click's
            // audit core read it too.
            let stamp = crate::button_cells::cell_stamp(params);
            let (id, held) = match (script_of(crate::button_cells::ACTION_PARAM), script_of(crate::button_cells::HELD_ACTION_PARAM)) {
                (Some(live), _) => (live, false),
                (None, Some(held)) => (held, true),
                (None, None) => return Err(format!("the button cell at {cell} runs no macro")),
            };
            if !artifact_ids.contains(&id.as_str()) {
                return Err(format!("the button cell at {cell} runs the macro '{id}', not {}", names(artifact_ids)));
            }
            match stamp {
                // The author's own button (no stamp): a LIVE action only -- a
                // held action exists only under an application's stamp.
                crate::button_cells::CellStamp::Own if !held => Ok(ButtonAttribution {
                    kind: MacroLinkKind::Cell,
                    cell,
                    caption,
                    application: None,
                    held,
                }),
                crate::button_cells::CellStamp::Own | crate::button_cells::CellStamp::Unreadable => Err(format!(
                    "the button cell at {cell} has no readable record of which application it came with"
                )),
                crate::button_cells::CellStamp::Application { application: app, .. } if app != package => Err(format!(
                    "the button cell at {cell} came with the application '{app}', and this code came with \
                     '{package}'"
                )),
                crate::button_cells::CellStamp::Application { application: app, .. } => Ok(ButtonAttribution {
                    kind: MacroLinkKind::Cell,
                    cell,
                    caption,
                    application: Some(app),
                    held,
                }),
            }
        }
    }
}

fn mismatch_refusal(application: &str, code: &str, why: &str) -> String {
    format!(
        "{APPLICATION_CODE_TRIGGER_MISMATCH}: \"{code}\" from the application \"{application}\" was asked \
         for by a button, and {why}. A button runs only what it links, so nothing ran."
    )
}

// ============================================================================
// The trail
// ============================================================================

/// One piece of an application's code about to run: what the audit row names.
struct CodeRun<'a> {
    /// `moduleRuntime` for `run_script`, the mount's wire surface otherwise.
    surface: &'a str,
    application: &'a str,
    /// The macro (or the mount's named artifacts), first one leading.
    ids: Vec<String>,
    /// sha256 of the exact source, when the gate was handed it.
    source_hash: Option<String>,
}

impl CodeRun<'_> {
    fn label(&self) -> String {
        self.ids.first().cloned().unwrap_or_else(|| self.application.to_string())
    }

    /// An application's button asking for a Calcula COMMAND: what runs is
    /// Calcula's own code, and only WHEN it runs is the application's say.
    fn is_command(&self) -> bool {
        self.surface == BUTTON_COMMAND_SURFACE
    }

    /// What the row's description says ran or was refused.
    fn subject(&self) -> String {
        if self.is_command() {
            format!("the command '{}' for a button from the application '{}'", self.label(), self.application)
        } else {
            format!("'{}' from the application '{}'", self.label(), self.application)
        }
    }

    fn extra(&self) -> HashMap<String, Value> {
        let mut extra: HashMap<String, Value> = HashMap::new();
        extra.insert("surface".into(), Value::from(self.surface));
        extra.insert("application".into(), Value::from(self.application));
        // A command is no macro: its row names it as what it is.
        extra.insert(if self.is_command() { "commandId" } else { "macroId" }.into(), Value::from(self.label()));
        if self.ids.len() > 1 {
            extra.insert("artifactIds".into(), serde_json::json!(self.ids));
        }
        if let Some(hash) = &self.source_hash {
            extra.insert("sourceHash".into(), Value::from(hash.as_str()));
        }
        extra
    }
}

fn button_phrase(button: &ButtonAttribution) -> String {
    let kind = match button.kind {
        MacroLinkKind::Control => "button",
        MacroLinkKind::Cell => "button cell",
    };
    if button.caption.is_empty() {
        format!(" ({kind} {})", button.cell)
    } else {
        format!(" ({kind} {} \"{}\")", button.cell, button.caption)
    }
}

/// WHO started a run of an application's code and WHAT it could reach, as its
/// run row says it (owner decision B, follow-up F3). The trail used to say only
/// that the code ran; since a person's run of an application's object-script
/// macro may change cells on any sheet, the row has to say whether this one
/// could, and through which door a person started it.
///
/// `startedBy` on every row means one thing: `"you"` when a person's door is
/// one Rust vouches for (the module runtime refuses any other start; the mount
/// door granted cell access), `"script"` otherwise -- a script started it, or
/// nothing names a person's act (a debug session from the Object Script
/// Editor's Run or Debug is one of those). A door the page claimed and Rust
/// could not honour is recorded as `claimedDoor`, never as `door`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RunAccess<'a> {
    /// The module runtime: an application's macro runs there only when a
    /// person started it (F10), with that runtime's own reach.
    ModuleRuntime { door: RunDoor },
    /// The one-off runner WITH cell access: the door, and the grant whose
    /// writes the page reports once the run settles (F15).
    CellAccess { door: ExplicitRunDoor, grant_id: u64 },
    /// The one-off runner WITHOUT cell access, and why -- with the door the
    /// page claimed, when it claimed one Rust could not honour.
    Restricted { why: &'a str, claimed: Option<ExplicitRunDoor> },
}

/// The wire spelling of a person's door, as the rows record it.
pub(crate) fn door_label(door: RunDoor) -> &'static str {
    match door {
        RunDoor::MacrosDialog => "macrosDialog",
        RunDoor::Button => "button",
        RunDoor::CommandLine => "commandLine",
        RunDoor::ViewBookmark => "viewBookmark",
    }
}

/// A person's door in words, for "you started it from ...".
pub(crate) fn door_phrase(door: RunDoor) -> &'static str {
    match door {
        RunDoor::MacrosDialog => "Developer > Macros > Run",
        RunDoor::Button => "its button",
        RunDoor::CommandLine => "the command line",
        RunDoor::ViewBookmark => "a view bookmark of yours",
    }
}

/// The always-on row for a RUN.
fn record_run(state: &AppState, run: &CodeRun<'_>, button: Option<&ButtonAttribution>, access: Option<&RunAccess<'_>>) {
    let mut extra = run.extra();
    if let Some(button) = button {
        extra.insert("button".into(), serde_json::to_value(button).unwrap_or(Value::Null));
    }
    let tail = match access {
        None => String::new(),
        Some(RunAccess::ModuleRuntime { door }) => {
            extra.insert("startedBy".into(), Value::from("you"));
            extra.insert("door".into(), Value::from(door_label(*door)));
            format!(" -- you started it from {}", door_phrase(*door))
        }
        Some(RunAccess::CellAccess { door, grant_id }) => {
            let door = RunDoor::from(*door);
            extra.insert("startedBy".into(), Value::from("you"));
            extra.insert("door".into(), Value::from(door_label(door)));
            extra.insert("cellAccess".into(), Value::from(true));
            extra.insert("grantId".into(), Value::from(*grant_id));
            format!(
                " -- you started it from {}, so it could read and change cells on any sheet while it ran",
                door_phrase(door)
            )
        }
        Some(RunAccess::Restricted { why, claimed }) => {
            extra.insert("startedBy".into(), Value::from("script"));
            extra.insert("cellAccess".into(), Value::from(false));
            extra.insert("noCellAccess".into(), Value::from(*why));
            if let Some(door) = claimed {
                extra.insert("claimedDoor".into(), Value::from(door_label(RunDoor::from(*door))));
            }
            format!(" -- restricted, without cell access, because {why}")
        }
    };
    crate::calp_commands::record_audit_event_with_extra(
        state,
        calp::audit::AuditEvent::ApplicationCodeRun,
        format!("Ran {}{}{}", run.subject(), button.map(button_phrase).unwrap_or_default(), tail),
        extra,
    );
}

/// The always-on row for a REFUSAL. A button the click claimed is named when
/// the store backs it, and otherwise recorded as the unverified claim it is.
fn record_refused(
    state: &AppState,
    run: &CodeRun<'_>,
    reason: &str,
    why: &str,
    trigger: Option<&ScriptRunTrigger>,
    extra_fields: Vec<(&str, Value)>,
) {
    let ids: Vec<&str> = run.ids.iter().map(String::as_str).collect();
    let button = trigger.and_then(|t| verify_trigger(state, t, run.application, &ids).ok());
    record_refused_core(state, run, reason, why, button.as_ref(), trigger, extra_fields);
}

/// The refusal row itself: `button` when the store backs one (read by the
/// caller -- the run gate verifies a click's claim, the button door reads its
/// own store), else the claimed `trigger` as the unverified claim it is.
fn record_refused_core(
    state: &AppState,
    run: &CodeRun<'_>,
    reason: &str,
    why: &str,
    button: Option<&ButtonAttribution>,
    trigger: Option<&ScriptRunTrigger>,
    extra_fields: Vec<(&str, Value)>,
) {
    let mut extra = run.extra();
    extra.insert("reason".into(), Value::from(reason));
    match (button, trigger) {
        (Some(button), _) => {
            extra.insert("button".into(), serde_json::to_value(button).unwrap_or(Value::Null));
        }
        (None, Some(trigger)) => {
            extra.insert("claimedTrigger".into(), serde_json::to_value(trigger).unwrap_or(Value::Null));
        }
        (None, None) => {}
    }
    for (k, v) in extra_fields {
        extra.insert(k.to_string(), v);
    }
    crate::calp_commands::record_audit_event_with_extra(
        state,
        calp::audit::AuditEvent::ApplicationCodeRefused,
        format!("Refused {}{}: {why}", run.subject(), button.map(button_phrase).unwrap_or_default()),
        extra,
    );
}

// ============================================================================
// The backstop: an application's held button code runs only from its button
// ============================================================================
//
// Since phase 4 an application's inline button code sits in the store, held
// (`heldOnSelect`), and the page can READ it (`get_control_metadata`). The
// button door runs it only after the approval of its exact bytes; but a route
// that runs an unnamed source as the user's own would run those bytes
// unapproved if it were handed them. Exactly four routes do that, and each
// asks this:
//
// * `run_script`'s AD-HOC branch (no stored module carries the source);
// * a cell of a notebook of the user's own, or of no stored notebook
//   (`notebook_commands::own_notebook_cell_backstop`);
// * the mount door's application-floor-only branch (a mount that names no
//   artifacts is admitted on ANY approval of the application);
// * the MCP / AI script route (`mcp/tools.rs run_script_isolated`, behind
//   `execute_script` and the in-app AI chat's `run_script` tool), which since
//   the review of M6b asks the whole module-runtime gate as a run a SCRIPT
//   started (`distributed_run_gate` with `RunStartedBy::Script`): an
//   application's module macro run verbatim is refused like any script-started
//   run of one, and held button code by this backstop.
//
// NOT covered, deliberately: the button door's own-code path, which runs a LIVE
// `onSelect` -- code on a button is the user's own once it is in the live slot,
// and refusing live code because an application's button happens to hold the
// same bytes would let a publisher forbid the user common code like
// `Report()`; and a hostile page, which can run any ad-hoc code of its own
// anyway. This is a heuristic against a route that MISTAKES held bytes for the
// user's own; the door is the control.
//
// WHAT IT MATCHES. A source that IS held code (trimmed) is refused at any
// length. Inside a longer source only SPECIFIC held code counts -- at least
// `HELD_CODE_SUBSTRING_MIN_CHARS` characters over at least
// `HELD_CODE_SUBSTRING_MIN_LINES` non-blank lines -- which still catches the
// splice the old click route made (the user's modules prepended to the
// button's code) and one added byte, but not one ordinary line a user's own
// program shares with an application's button: a publisher could otherwise
// ship `const sheet = Calcula.getActiveSheet().getName();` as button code and
// refuse every subscriber program that contains that line. And held code that
// one of the user's OWN stored modules also carries is the user's too (the
// copy-it-to-your-own rule): the remedy the refusal names. A one-line snippet
// composed into a longer program is therefore not caught.

/// Error sentinel: an application's held button code was handed to a run that
/// is not its button's.
pub const APPLICATION_CODE_OUTSIDE_ITS_BUTTON: &str = "APPLICATION_CODE_OUTSIDE_ITS_BUTTON";

/// Held code at least this long (trimmed, in characters), over at least
/// [`HELD_CODE_SUBSTRING_MIN_LINES`] non-blank lines, is refused not only as a
/// whole source but also INSIDE one.
pub(crate) const HELD_CODE_SUBSTRING_MIN_CHARS: usize = 40;

/// See [`HELD_CODE_SUBSTRING_MIN_CHARS`]: one line, however long, can be a line
/// the user's own program shares with an application's button.
pub(crate) const HELD_CODE_SUBSTRING_MIN_LINES: usize = 2;

/// One piece of an application's held inline code, and the button it sits on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HeldSnippet {
    /// The application its stamp names ("" when the stamp cannot be read).
    pub application: String,
    pub button: ButtonAttribution,
    pub code: String,
}

/// THE BACKSTOP, pure: the held snippet `source` is, or carries, if any.
/// `own_sources` are the sources of the user's OWN stored modules: held code
/// one of them also carries is the user's too, and is never matched.
pub(crate) fn held_code_outside_its_button<'a>(
    source: &str,
    held: &'a [HeldSnippet],
    own_sources: &[&str],
) -> Option<&'a HeldSnippet> {
    let whole = source.trim();
    held.iter().find(|snippet| {
        let code = snippet.code.trim();
        if code.is_empty() || own_sources.iter().any(|own| own.contains(code)) {
            return false;
        }
        whole == code || (is_specific_held_code(code) && source.contains(code))
    })
}

/// Held code specific enough to be refused INSIDE a longer source.
fn is_specific_held_code(code: &str) -> bool {
    code.chars().count() >= HELD_CODE_SUBSTRING_MIN_CHARS
        && code.lines().filter(|line| !line.trim().is_empty()).count() >= HELD_CODE_SUBSTRING_MIN_LINES
}

/// The sources of the user's OWN stored modules, out of the ownership triples
/// every gate is handed.
pub(crate) fn own_module_sources(scripts: &[(Option<String>, String, String)]) -> Vec<&str> {
    scripts.iter().filter(|(package, _, _)| package.is_none()).map(|(_, _, source)| source.as_str()).collect()
}

/// Every held inline snippet in the store, in cell order. LOCKS: the sheet
/// names are cloned first, then one guard on the controls.
pub(crate) fn held_snippets(state: &AppState) -> Result<Vec<HeldSnippet>, String> {
    let names: Vec<String> = state.sheet_names.read().map_err(|e| e.to_string())?.clone();
    let controls = state.controls.read().map_err(|e| e.to_string())?;
    let mut snippets: Vec<HeldSnippet> = controls
        .iter()
        .filter_map(|((sheet, row, col), meta)| {
            let code = meta
                .properties
                .get(crate::controls::HELD_ON_SELECT_PROPERTY)
                .map(|p| p.value.clone())
                .filter(|v| !v.trim().is_empty())?;
            let application = meta
                .properties
                .get(crate::controls::HELD_FROM_PROPERTY)
                .and_then(|p| HeldFrom::decode(&p.value))
                .map(|from| from.application);
            let sheet_name = names.get(*sheet).cloned().unwrap_or_else(|| format!("Sheet{}", sheet + 1));
            Some(HeldSnippet {
                application: application.clone().unwrap_or_default(),
                button: ButtonAttribution {
                    kind: MacroLinkKind::Control,
                    cell: format!("{}!{}", sheet_name, a1(*row, *col)),
                    caption: meta.properties.get("text").map(|p| p.value.clone()).unwrap_or_default(),
                    application,
                    held: true,
                },
                code,
            })
        })
        .collect();
    snippets.sort_by(|a, b| a.button.cell.cmp(&b.button.cell));
    Ok(snippets)
}

/// Refuse -- and record, always-on -- a run whose source is, or carries, an
/// application's held button code. `own_sources`: the user's own stored
/// modules ([`own_module_sources`]).
pub(crate) fn refuse_held_code_outside_its_button(
    state: &AppState,
    surface: &str,
    source: &str,
    trigger: Option<&ScriptRunTrigger>,
    own_sources: &[&str],
) -> Result<(), String> {
    let held = held_snippets(state)?;
    let Some(snippet) = held_code_outside_its_button(source, &held, own_sources) else {
        return Ok(());
    };
    let application = if snippet.application.is_empty() { "an application" } else { snippet.application.as_str() };
    let run = CodeRun {
        surface,
        application,
        ids: vec![super::control_action::button_action_consent_id(&snippet.code)],
        source_hash: Some(calp::integrity::sha256_hex(source.as_bytes())),
    };
    record_refused_core(
        state,
        &run,
        "heldCodeOutsideButton",
        "it is an application's button code, which runs only from its own button",
        Some(&snippet.button),
        trigger,
        Vec::new(),
    );
    Err(format!(
        "{APPLICATION_CODE_OUTSIDE_ITS_BUTTON}: this code is, or carries, the code of the button at {cell} that \
         came with the application '{application}'. An application's button code runs only from its own button, \
         after an approval that showed it, so nothing ran. If this is code of your own, save it as a script of \
         your own first; deleting the application's button at {cell} also clears this.",
        cell = snippet.button.cell
    ))
}

// ============================================================================
// The two doors
// ============================================================================

/// The application(s) whose stored module IS this source, or `None` for a local
/// script (one of the user's own carries the same bytes) or an ad-hoc run (no
/// stored module does). The same ownership question
/// `distributed_module_refusal` asks, so the two can never disagree about
/// whether this is an application's code.
fn distributed_owners(scripts: &[(Option<String>, String, String)], source: &str) -> Option<Vec<(String, String)>> {
    if scripts.iter().any(|(pkg, _, src)| src == source && pkg.is_none()) {
        return None;
    }
    let owners: Vec<(String, String)> = scripts
        .iter()
        .filter(|(_, _, src)| src == source)
        .filter_map(|(pkg, id, _)| pkg.as_ref().map(|p| (p.clone(), id.clone())))
        .collect();
    (!owners.is_empty()).then_some(owners)
}

/// WHY an application's module macro may NOT run on this request, or `None`
/// when a person's act started it (owner decision B, follow-up F10). Pure.
///
/// A person's door must also agree with the trigger, as the object-script
/// grant requires (`explicitRunCellsFor`, app/src/api/scriptHost/host.ts): the
/// button door comes with the button the click names (verified against the
/// store below), and no other door names a button. A contradiction is not a
/// person's act -- it is a request nothing can vouch for.
pub(crate) fn not_started_by_you(
    started_by: &RunStartedBy,
    trigger: Option<&ScriptRunTrigger>,
) -> Option<&'static str> {
    match started_by {
        RunStartedBy::Script => Some("it was not started by you -- a script started it, or nothing says who did"),
        RunStartedBy::You { door: RunDoor::Button } if trigger.is_none() => {
            Some("it says a button was clicked, but names no button")
        }
        RunStartedBy::You { door } if *door != RunDoor::Button && trigger.is_some() => {
            Some("it names a button, but says it was not started by clicking one")
        }
        RunStartedBy::You { .. } => None,
    }
}

/// The refusal a run of an application's module macro that no person started
/// gets. Says what happened, why the runtime cannot do less, and how to run it.
pub(crate) fn not_started_by_you_refusal(application: &str, macro_id: &str) -> String {
    format!(
        "{APPLICATION_MACRO_NOT_STARTED_BY_YOU}: '{macro_id}' came with the application '{application}', and \
         nothing shows that you started this run. A run another script starts (api.runMacro, or a view bookmark \
         a script activated) never gets an application macro's reach, and this runtime cannot run it with less. \
         Run it yourself -- from Developer > Macros > Run, a button that runs it, or the command line. Nothing ran."
    )
}

/// What the refusal row of a run no person's act can be named for records
/// about who started it ([`RunAccess`] says what `startedBy` means): never
/// `"you"` -- Rust vouches for no door here -- plus the door the page claimed,
/// when it claimed one that contradicts the trigger.
fn not_started_by_you_fields(started_by: &RunStartedBy) -> Vec<(&'static str, Value)> {
    let mut fields = vec![("startedBy", Value::from("script"))];
    if let Some(door) = started_by.door() {
        fields.push(("claimedDoor", Value::from(door_label(door))));
    }
    fields
}

/// THE MODULE-RUNTIME DOOR (`run_script`): the approval, then who started the
/// run (a person, for an application's macro), then the private-sheet rule,
/// then the button a click claims, then the run row.
///
/// Local and ad-hoc runs pass untouched and unrecorded: this gate is about
/// whose code it is, and theirs is the user's. The approval's refusal text is
/// exactly `distributed_module_refusal`'s.
pub(crate) fn distributed_run_gate(
    state: &AppState,
    scripts: &[(Option<String>, String, String)],
    consent_file: Option<&Value>,
    source: &str,
    trigger: Option<&ScriptRunTrigger>,
    started_by: &RunStartedBy,
) -> Result<(), String> {
    let Some(owners) = distributed_owners(scripts, source) else {
        // AD-HOC: no stored module carries exactly this source. (A module of
        // the user's own that does is the copy-it-to-your-own rule, and runs
        // untouched.) An application's HELD button code is not the user's own
        // just because no module carries it: it runs only from its button,
        // through the button door, after the approval of its exact bytes.
        if !scripts.iter().any(|(_, _, src)| src == source) {
            refuse_held_code_outside_its_button(state, "moduleRuntime", source, trigger, &own_module_sources(scripts))?;
        }
        return Ok(());
    };
    let source_hash = calp::integrity::sha256_hex(source.as_bytes());
    if let Some(refusal) = distributed_module_refusal(scripts, consent_file, source) {
        let (application, id) = &owners[0];
        let run = CodeRun {
            surface: "moduleRuntime",
            application,
            ids: vec![id.clone()],
            source_hash: Some(source_hash),
        };
        record_refused(state, &run, "notConsented", "its code is not approved", trigger, Vec::new());
        return Err(refusal);
    }
    // The owners whose approval admitted it (at least one, or the gate above
    // would have refused).
    let consented: Vec<&(String, String)> = owners
        .iter()
        .filter(|(pkg, id)| {
            consent_file.is_some_and(|f| crate::calp_commands::consent_granted_in(f, pkg, id, &source_hash))
        })
        .collect();
    let (application, id) = consented.first().copied().unwrap_or(&owners[0]);

    // OWNER DECISION B (follow-up F10): approved is not enough here. This
    // runtime has no tiers, so an application's macro runs with its full reach
    // or not at all -- and a run a script starts never gets that reach. Asked
    // after the approval (unapproved code keeps its own refusal and text) and
    // before anything else, so the row says why it really did not run.
    if let Some(why) = not_started_by_you(started_by, trigger) {
        let run = CodeRun {
            surface: "moduleRuntime",
            application,
            ids: vec![id.clone()],
            source_hash: Some(source_hash),
        };
        record_refused(state, &run, "notStartedByYou", why, trigger, not_started_by_you_fields(started_by));
        return Err(not_started_by_you_refusal(application, id));
    }
    // A person's door, from here on: `not_started_by_you` refused every other
    // start. Named on the run row (F3), so the trail says how it was started.
    let access = started_by.door().map(|door| RunAccess::ModuleRuntime { door });

    let link: Option<calp::WorkingCopyLink> =
        state.working_copy_link.read().map_err(|e| e.to_string())?.clone();
    if link.is_some() {
        let sheets = workbook_sheet_facts(state)?;
        if let Some(refusal) = private_sheet_refusal(link.as_ref(), &sheets, application, id) {
            let run = CodeRun {
                surface: "moduleRuntime",
                application,
                ids: vec![id.clone()],
                source_hash: Some(source_hash),
            };
            record_refused(
                state,
                &run,
                "privateSheets",
                "the working copy holds sheets that are not the application's",
                trigger,
                vec![("privateSheets", serde_json::json!(private_sheets(link.as_ref(), &sheets)))],
            );
            return Err(refusal);
        }
    }

    let Some(trigger) = trigger else {
        let run = CodeRun { surface: "moduleRuntime", application, ids: vec![id.clone()], source_hash: Some(source_hash) };
        record_run(state, &run, None, access.as_ref());
        return Ok(());
    };
    // Any consented owner the stored button backs: a click runs what IT links.
    let mut first_refusal: Option<(String, String, String)> = None;
    for (pkg, owner_id) in &consented {
        match verify_trigger(state, trigger, pkg, &[owner_id.as_str()]) {
            Ok(button) => {
                let run = CodeRun {
                    surface: "moduleRuntime",
                    application: pkg,
                    ids: vec![owner_id.clone()],
                    source_hash: Some(source_hash.clone()),
                };
                record_run(state, &run, Some(&button), access.as_ref());
                return Ok(());
            }
            Err(why) => {
                if first_refusal.is_none() {
                    first_refusal = Some((pkg.clone(), owner_id.clone(), why));
                }
            }
        }
    }
    let (pkg, owner_id, why) =
        first_refusal.unwrap_or_else(|| (application.clone(), id.clone(), "no stored button backs it".to_string()));
    let run = CodeRun { surface: "moduleRuntime", application: &pkg, ids: vec![owner_id.clone()], source_hash: Some(source_hash) };
    record_refused(state, &run, "triggerMismatch", &why, Some(trigger), Vec::new());
    Err(mismatch_refusal(&pkg, &owner_id, &why))
}

/// THE NOTEBOOK DOOR: a cell of a notebook that came with an application and
/// was APPROVED (`notebook_commands::distributed_notebook_refusal` let it
/// through) is application code with grid write-back like any macro, so it
/// meets the same private-sheet rule and leaves the same always-on rows.
///
/// Notebooks run in the Rust interpreter over cloned grids, so this is asked
/// once per cell, before the clone -- and Run All / Run From funnel every cell
/// through it. Today no surface WRITES a notebook approval (a distributed
/// notebook is delivered to be read), so this is the rule waiting at the door
/// for the day one does, rather than a hole that opens with it.
pub(crate) fn notebook_run_gate(
    state: &AppState,
    application: &str,
    consent_id: &str,
    source: &str,
) -> Result<(), String> {
    let run = CodeRun {
        surface: "notebook",
        application,
        ids: vec![consent_id.to_string()],
        source_hash: Some(calp::integrity::sha256_hex(source.as_bytes())),
    };
    let link: Option<calp::WorkingCopyLink> = state.working_copy_link.read().map_err(|e| e.to_string())?.clone();
    if link.is_some() {
        let sheets = workbook_sheet_facts(state)?;
        if let Some(refusal) = private_sheet_refusal(link.as_ref(), &sheets, application, consent_id) {
            record_refused(
                state,
                &run,
                "privateSheets",
                "the working copy holds sheets that are not the application's",
                None,
                vec![("privateSheets", serde_json::json!(private_sheets(link.as_ref(), &sheets)))],
            );
            return Err(refusal);
        }
    }
    record_run(state, &run, None, None);
    Ok(())
}

/// The one surface whose explicit runs can be granted cell access: the one-off
/// runner mounts an application's macro under it.
pub(crate) const OBJECT_SCRIPT_SURFACE: &str = "object-script";

/// Why an admitted run of an application's object-script macro has no cell
/// access when the page claimed no person's door for it.
pub(crate) const NO_PERSONS_DOOR: &str = "nothing shows that you started it from Developer > Macros > Run, a \
     button that runs it or the command line (a script may have started it, or the Object Script Editor's Run \
     or Debug)";

/// The claim a person's run carries to the mount door, and the ledger a grant
/// is kept in until the page reports what the run wrote.
#[derive(Clone, Copy)]
pub(crate) struct ExplicitRunAsk<'a> {
    pub claim: &'a ExplicitRunClaim,
    pub grants: &'a ExplicitRunGrants,
}

/// WHETHER AN ADMITTED RUN GETS CELL ACCESS (owner decision B: "an APPROVED
/// application macro that the user runs EXPLICITLY -- a button click,
/// Developer > Macros > Run, the command line -- gets the same CELL access in
/// either runtime"; follow-up F3: Rust co-decides and names it). Pure. Asked
/// of a run already admitted by every gate, on the object-script surface.
///
/// `Ok(door)` only when everything Rust can see agrees with the page's claim:
///  1. there IS a claim: the page holds a pass a person's door minted;
///  2. the code is an object-script macro (the one-off runner's surface);
///  3. the mount names exactly ONE approved artifact, and it is the macro the
///     claim names -- a pass is for one macro;
///  4. what the realm runs is exactly that artifact's bytes, the bytes whose
///     hash the approval was checked against (a composed prelude is not);
///  5. the door agrees with the trigger: the button door comes with the button
///     the click names, verified against the store (`button_verified`, by
///     [`verify_trigger`]); no other door names a button.
///
/// Otherwise `Err(why)`, finishing the run row's "because ...". The page grants
/// nothing Rust did not, and asks for nothing it would not grant itself (the
/// realm's tier and context shape, which Rust cannot see, are its half).
pub(crate) fn explicit_run_cell_access(
    claim: Option<&ExplicitRunClaim>,
    wire: &str,
    artifacts: Option<&[MountConsentArtifact]>,
    source: &str,
    trigger: Option<&ScriptRunTrigger>,
    button_verified: bool,
) -> Result<ExplicitRunDoor, &'static str> {
    let Some(claim) = claim else { return Err(NO_PERSONS_DOOR) };
    if wire != OBJECT_SCRIPT_SURFACE {
        return Err("it is not a macro written as an object script");
    }
    let [artifact] = artifacts.unwrap_or(&[]) else {
        return Err("it is not exactly one approved macro");
    };
    if artifact.id != claim.macro_id {
        return Err("the run was started for another macro");
    }
    if artifact.source != source {
        return Err("what was about to run is not exactly the approved macro");
    }
    match claim.door {
        ExplicitRunDoor::Button if trigger.is_none() => Err("it says a button was clicked, but names no button"),
        ExplicitRunDoor::Button if !button_verified => Err("the button it names does not run it"),
        ExplicitRunDoor::Button => Ok(ExplicitRunDoor::Button),
        _ if trigger.is_some() => Err("it names a button, but says it was not started by clicking one"),
        door => Ok(door),
    }
}

/// THE MOUNT DOOR (`check_distributed_mount_consent`): both approval questions
/// exactly as before, then the private-sheet rule for the surfaces whose code
/// can write the grid, then -- when a click asked -- the button, and, for an
/// admitted explicit run, the run row. See [`MountGatePhase`] for what each
/// phase records.
///
/// A STANDING MOUNT records only a private-sheet refusal (and a claim storage
/// does not back): a workbook mounts its approved charts, functions and
/// standing object scripts on every load, and a row per mount would drown the
/// trail it exists to keep readable. An EXPLICIT run records every refusal and
/// -- once Script Security has admitted it too -- its run, with or without a
/// button, exactly as the module-runtime door does.
///
/// CELL ACCESS (owner decision B, follow-up F3) is decided last, on
/// `RunAdmitted` only, by [`explicit_run_cell_access`] over the page's claim
/// (`claimed`); a grant is opened in the ledger the claim brings, and the
/// run row names it -- door, `cellAccess`, `grantId` -- or says why the run had
/// none. Every other phase answers `cell_access: false`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn mount_run_gate(
    state: &AppState,
    scripts: &[(Option<String>, String, String)],
    consent_file: Option<&Value>,
    package_name: &str,
    source: &str,
    surface: Option<&str>,
    artifacts: Option<&[MountConsentArtifact]>,
    trigger: Option<&ScriptRunTrigger>,
    phase: MountGatePhase,
    claimed: Option<ExplicitRunAsk<'_>>,
) -> Result<MountGateAnswer, String> {
    let wire = surface.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("mount");
    let ids: Vec<String> = artifacts.map(|a| a.iter().map(|x| x.id.clone()).collect()).unwrap_or_default();
    let run = CodeRun { surface: wire, application: package_name, ids: ids.clone(), source_hash: None };
    let explicit_run = matches!(phase, MountGatePhase::RunCheck | MountGatePhase::RunAdmitted);

    if phase != MountGatePhase::Standing {
        let refusal = distributed_module_refusal(scripts, consent_file, source)
            .or_else(|| distributed_mount_refusal(consent_file, package_name, surface, artifacts));
        if let Some(refusal) = refusal {
            if explicit_run || trigger.is_some() {
                record_refused(state, &run, "notConsented", "its code is not approved", trigger, Vec::new());
            }
            return Err(refusal);
        }
        // THE APPLICATION FLOOR ALONE (the mount names no artifacts) admits an
        // unnamed source on the strength of ANY approval of the application --
        // so it must not admit the application's held button code. A mount that
        // names its artifacts is held to their exact hashes instead, and its
        // composed source would match only approved code.
        if artifacts.is_none() && !scripts.iter().any(|(_, _, src)| src == source) {
            refuse_held_code_outside_its_button(state, wire, source, trigger, &own_module_sources(scripts))?;
        }
    }

    let link: Option<calp::WorkingCopyLink> = state.working_copy_link.read().map_err(|e| e.to_string())?.clone();
    let gated = private_sheet_rule_gates(wire) && link.is_some();
    let mut answer = MountGateAnswer::admitted(gated);
    if gated {
        let sheets = workbook_sheet_facts(state)?;
        if let Some(refusal) = private_sheet_refusal(link.as_ref(), &sheets, package_name, &run.label()) {
            let (why, standing) = if phase == MountGatePhase::Standing {
                ("sheets that are not the application's appeared beside it while it was running", true)
            } else {
                ("the working copy holds sheets that are not the application's", false)
            };
            let mut extra = vec![("privateSheets", serde_json::json!(private_sheets(link.as_ref(), &sheets)))];
            if standing {
                extra.push(("stoppedWhileRunning", Value::from(true)));
            }
            record_refused(state, &run, "privateSheets", why, trigger, extra);
            return Err(refusal);
        }
    }
    if phase == MountGatePhase::Standing {
        return Ok(answer);
    }

    let button = match trigger {
        None => None,
        Some(trigger) => {
            let id_refs: Vec<&str> = ids.iter().map(String::as_str).collect();
            match verify_trigger(state, trigger, package_name, &id_refs) {
                Ok(button) => Some(button),
                Err(why) => {
                    record_refused(state, &run, "triggerMismatch", &why, Some(trigger), Vec::new());
                    return Err(mismatch_refusal(package_name, &run.label(), &why));
                }
            }
        }
    };
    if phase != MountGatePhase::RunAdmitted {
        return Ok(answer);
    }

    // THE ADMITTED RUN: cell access (owner decision B, F3), then its row. Only
    // an object-script run is about cell access; any other surface's row says
    // what it always said.
    let access = if wire == OBJECT_SCRIPT_SURFACE {
        let claim = claimed.map(|c| c.claim);
        Some(match explicit_run_cell_access(claim, wire, artifacts, source, trigger, button.is_some()) {
            Ok(door) => {
                let opened = claimed.and_then(|c| {
                    c.grants.open(GrantedRun {
                        application: package_name.to_string(),
                        macro_id: c.claim.macro_id.clone(),
                        door,
                        button: button.clone(),
                    })
                });
                match opened {
                    Some(grant_id) => {
                        answer.cell_access = true;
                        answer.grant_id = Some(grant_id);
                        RunAccess::CellAccess { door, grant_id }
                    }
                    // A grant that cannot be recorded is not given: its writes
                    // could not be put on the trail.
                    None => RunAccess::Restricted {
                        why: "Calcula could not keep the record a run with cell access needs",
                        claimed: Some(door),
                    },
                }
            }
            Err(why) => RunAccess::Restricted { why, claimed: claim.map(|c| c.door) },
        })
    } else {
        None
    };
    record_run(state, &run, button.as_ref(), access.as_ref());
    Ok(answer)
}

// ============================================================================
// The button door (phase 4: `control_action::run_control_action`)
// ============================================================================

/// The surface the button door's rows name.
pub(crate) const BUTTON_SURFACE: &str = "button";

/// An application's HELD inline button code: the exact bytes, and the
/// application whose stamp they carry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HeldCode {
    pub application: String,
    pub code: String,
}

/// An application's code the button door is about to run, approved and ruled:
/// what its run row names, once Script Security has admitted the run too.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ApprovedButtonRun {
    pub application: String,
    /// The approvals the run was admitted under, the leading one first:
    /// `buttonAction:<sha256>` for held inline code, then the id of the stored
    /// module whose source runs, when one does.
    pub ids: Vec<String>,
    /// sha256 of the exact source the interpreter is handed.
    pub source_hash: String,
}

impl ApprovedButtonRun {
    fn code_run(&self) -> CodeRun<'_> {
        CodeRun {
            surface: BUTTON_SURFACE,
            application: &self.application,
            ids: self.ids.clone(),
            source_hash: Some(self.source_hash.clone()),
        }
    }
}

/// Whose code a click is about to run, as the button door's gate rules.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ButtonGateAnswer {
    /// The user's own code -- their own inline code with their own modules
    /// around it, or a module of their own: no approval is asked and no
    /// application row is written (D6).
    Own,
    /// An application's code, approved and admitted by the private-sheet rule:
    /// record the run once Script Security has admitted it too.
    Application(ApprovedButtonRun),
}

/// A refusal of the button door's gate. Already recorded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ButtonGateRefusal {
    pub reason: &'static str,
    pub message: String,
}

/// What a click on held code that was never approved says (D12: the approval
/// screen comes back at the next open or update; there is no "ask me now").
pub(crate) fn held_code_not_approved(application: &str, cell: &str) -> String {
    format!(
        "{DISTRIBUTED_SCRIPT_NOT_CONSENTED}: the button at {cell} came with the application '{application}', and \
         you have not approved its code, so it did not run. The approval screen, which shows the code, comes back \
         the next time this workbook is opened or the application is updated."
    )
}

/// THE BUTTON DOOR'S GATE, asked of the FINAL source a click's plan runs --
/// never only of the label the plan carries, because the door hands its source
/// to the interpreter directly and `run_script`'s gate is not on that path:
///
/// 1. HELD inline bytes (`held`): the approval of exactly those bytes,
///    `buttonAction:<sha256>` under the stamp's application, in its BARE record
///    (the one that holds its object scripts and macros), asked over the
///    VERIFIED consent view.
/// 2. A source a stored module of an APPLICATION carries exactly (the same
///    ownership rule `distributed_run_gate` uses, `distributed_owners`, so the
///    two doors can never disagree about whose code a source is): that
///    module's own approval (`distributed_module_refusal`, its text unchanged).
///    This is what holds the user's OWN `Report()` that delegates to an
///    application module, and an own or stamped button CELL whose module came
///    with an application, to that module's approval.
/// 3. For either, the working-copy private-sheet rule.
///
/// Every refusal writes `ApplicationCodeRefused` naming the button the door
/// read from its own store. A purely local composition answers `Own`.
pub(crate) fn button_run_gate(
    state: &AppState,
    scripts: &[(Option<String>, String, String)],
    consent_file: Option<&Value>,
    button: &ButtonAttribution,
    held: Option<&HeldCode>,
    source: &str,
) -> Result<ButtonGateAnswer, ButtonGateRefusal> {
    let owners = distributed_owners(scripts, source);
    if held.is_none() && owners.is_none() {
        return Ok(ButtonGateAnswer::Own);
    }
    let source_hash = calp::integrity::sha256_hex(source.as_bytes());
    let mut ids: Vec<String> = Vec::new();
    let mut application: Option<String> = held.map(|h| h.application.clone());

    // 1. The held bytes' own approval.
    if let Some(held) = held {
        let id = super::control_action::button_action_consent_id(&held.code);
        let code_hash = calp::integrity::sha256_hex(held.code.as_bytes());
        ids.push(id.clone());
        let approved =
            consent_file.is_some_and(|f| crate::calp_commands::consent_granted_in(f, &held.application, &id, &code_hash));
        if !approved {
            let run = ApprovedButtonRun { application: held.application.clone(), ids, source_hash };
            record_refused_core(state, &run.code_run(), "notConsented", "its code is not approved", Some(button), None, Vec::new());
            return Err(ButtonGateRefusal {
                reason: "notConsented",
                message: held_code_not_approved(&held.application, &button.cell),
            });
        }
    }

    // 2. A stored application module's approval.
    if let Some(owners) = &owners {
        if let Some(refusal) = distributed_module_refusal(scripts, consent_file, source) {
            let (package, id) = &owners[0];
            if !ids.contains(id) {
                ids.push(id.clone());
            }
            let run = ApprovedButtonRun {
                application: application.clone().unwrap_or_else(|| package.clone()),
                ids,
                source_hash,
            };
            record_refused_core(state, &run.code_run(), "notConsented", "its code is not approved", Some(button), None, Vec::new());
            return Err(ButtonGateRefusal { reason: "notConsented", message: refusal });
        }
        let (package, id) = owners
            .iter()
            .find(|(package, id)| {
                consent_file.is_some_and(|f| crate::calp_commands::consent_granted_in(f, package, id, &source_hash))
            })
            .unwrap_or(&owners[0]);
        if !ids.contains(id) {
            ids.push(id.clone());
        }
        if application.is_none() {
            application = Some(package.clone());
        }
    }
    let run = ApprovedButtonRun { application: application.unwrap_or_default(), ids, source_hash };

    // 3. The working-copy private-sheet rule. A store that cannot be read is a
    //    refusal: the rule fails closed -- and, like every refusal of an
    //    application's code, it is on the trail.
    let unavailable = |why: String| {
        record_refused_core(
            state,
            &run.code_run(),
            "stateUnavailable",
            "the workbook's sheets could not be read, so the working-copy rule could not be checked",
            Some(button),
            None,
            vec![("error", Value::from(why.as_str()))],
        );
        ButtonGateRefusal { reason: "stateUnavailable", message: why }
    };
    let link: Option<calp::WorkingCopyLink> =
        state.working_copy_link.read().map_err(|e| unavailable(e.to_string()))?.clone();
    if link.is_some() {
        let sheets = workbook_sheet_facts(state).map_err(unavailable)?;
        if let Some(refusal) = private_sheet_refusal(link.as_ref(), &sheets, &run.application, &run.code_run().label()) {
            record_refused_core(
                state,
                &run.code_run(),
                "privateSheets",
                "the working copy holds sheets that are not the application's",
                Some(button),
                None,
                vec![("privateSheets", serde_json::json!(private_sheets(link.as_ref(), &sheets)))],
            );
            return Err(ButtonGateRefusal { reason: "privateSheets", message: refusal });
        }
    }
    Ok(ButtonGateAnswer::Application(run))
}

/// How the button door's rows name the run's door (review of M6b): a click on
/// a button, the module runtime's reach. `startedBy` means what it means on
/// every row ([`RunAccess`]): the button is the one the store holds at the
/// cell the click named -- exactly what the module-runtime door vouches for on
/// a button run -- and that a PERSON pressed it rests on who can reach the
/// door at all (the census of its callers, src/api/__tests__/explicitMacroRun.test.ts).
const BUTTON_DOOR_ACCESS: RunAccess<'static> = RunAccess::ModuleRuntime { door: RunDoor::Button };

/// The always-on run row for a button door run of an application's code. It
/// names its door (`startedBy`, `door`), like the module runtime's and the
/// mount door's run rows, so a reader filtering the trail by door sees every
/// run of an application's code a button started -- held inline code and
/// `Name()` calls included (review of M6b).
pub(crate) fn record_button_run(state: &AppState, run: &ApprovedButtonRun, button: &ButtonAttribution) {
    record_run(state, &run.code_run(), Some(button), Some(&BUTTON_DOOR_ACCESS));
}

/// The always-on refusal row for an application's code the gate APPROVED and a
/// later step refused (Script Security set to disable scripts): the trail must
/// not be silent about a click on an application's button that ran nothing.
/// It names the door, as the run row would have.
pub(crate) fn record_button_run_refused(
    state: &AppState,
    run: &ApprovedButtonRun,
    button: &ButtonAttribution,
    reason: &str,
    why: &str,
) {
    record_refused_core(
        state,
        &run.code_run(),
        reason,
        why,
        Some(button),
        None,
        vec![("startedBy", Value::from("you")), ("door", Value::from(door_label(RunDoor::Button)))],
    );
}

/// The always-on refusal row for an application's code a click asked for and
/// the door refused before its gate (a planner's refusal: an object-script
/// macro called by name, an ambiguous name, a composition of an application's
/// module), naming the button the door read.
#[allow(clippy::too_many_arguments)]
pub(crate) fn record_button_code_refused(
    state: &AppState,
    application: &str,
    ids: Vec<String>,
    source_hash: Option<String>,
    reason: &str,
    why: &str,
    button: &ButtonAttribution,
    extra_fields: Vec<(&str, Value)>,
) {
    let run = CodeRun { surface: BUTTON_SURFACE, application, ids, source_hash };
    record_refused_core(state, &run, reason, why, Some(button), None, extra_fields);
}

// ============================================================================
// An application's button COMMAND (plan_M8 S1)
// ============================================================================
//
// A button CELL that came with an application may name a Calcula command. What
// runs is then Calcula's own code; what the application decides is WHEN. That
// is still the application's say over this workbook, so it meets the same rules
// as its code: on a list Rust owns, approved by the person, held to the
// working-copy private-sheet rule, and on the trail -- run and refusal alike.
//
// Two doors ask, in two phases (the mount door's RunCheck / RunAdmitted
// precedent, so the trail never says a command ran that a later check stopped):
// the button door asks `Check` -- every refusal recorded, no run row -- and
// answers `command` with the application; the page then checks the LIVE
// registration of the command opts in (only the page can see it), and
// `authorize_button_command` asks `Admitted` from the store again and writes
// the run row. The page runs the command only after that answer.
//
// WHAT IT IS WORTH. An extension command is renderer code: a compromised
// renderer can run any command without asking Rust. This makes an HONEST click
// listed, approved and audited; it is not a wall against a hostile page. The
// list bounds which ids an application's button can reach, never whose code
// answers to an id -- that is the page's second yes.

/// The surface the rows of an application's button command name.
pub(crate) const BUTTON_COMMAND_SURFACE: &str = "buttonCommand";

/// Error sentinel: an application's button names a command that is not on
/// Calcula's list (`button_cells::DISTRIBUTABLE_BUTTON_COMMANDS`).
pub const APPLICATION_COMMAND_NOT_ALLOWED: &str = "APPLICATION_COMMAND_NOT_ALLOWED";
/// Error sentinel: an application's button command the person has not approved.
pub const APPLICATION_COMMAND_NOT_APPROVED: &str = "APPLICATION_COMMAND_NOT_APPROVED";

/// Which question [`button_command_gate`] is asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CommandGatePhase {
    /// The button door, before the page has looked at the live registration:
    /// every refusal recorded, and NO run row -- the page may still refuse.
    Check,
    /// `authorize_button_command`, right before the page runs the command:
    /// asked again (the store may have moved since the door answered), then the
    /// always-on run row.
    Admitted,
}

/// THE COMMAND GATE, asked of a button CELL whose stamp names `application` and
/// whose LIVE action the caller has just read from the store as exactly the
/// command `command_id` (the door reads it; `authorize_button_command` compares
/// the page's claim with it first). In this order:
///
/// 1. THE LIST: `command_id` must be on `allowed` -- in production always
///    `button_cells::DISTRIBUTABLE_BUTTON_COMMANDS`, the list the admission
///    reads too (reason `notAllowlisted`).
/// 2. THE APPROVAL: a record under `button-commands:<application>`
///    (`button_cells::button_command_consent_key`) approving `command_id` at
///    the sha256 of its own bytes, in the VERIFIED consent view -- never the
///    application's bare record, which is the object-script mount floor's key
///    (reason `notConsented`).
/// 3. THE WORKING-COPY PRIVATE-SHEET RULE, failing closed on a store it cannot
///    read (reasons `privateSheets`, `stateUnavailable`).
/// 4. On [`CommandGatePhase::Admitted`] only: the always-on `ApplicationCodeRun`
///    row (surface `buttonCommand`, `commandId`, the button, its door).
///
/// Every refusal writes `ApplicationCodeRefused` naming the button.
pub(crate) fn button_command_gate(
    state: &AppState,
    consent_file: Option<&Value>,
    button: &ButtonAttribution,
    application: &str,
    command_id: &str,
    allowed: &[&str],
    phase: CommandGatePhase,
) -> Result<(), ButtonGateRefusal> {
    let command_hash = calp::integrity::sha256_hex(command_id.as_bytes());
    let run = CodeRun {
        surface: BUTTON_COMMAND_SURFACE,
        application,
        ids: vec![command_id.to_string()],
        source_hash: Some(command_hash.clone()),
    };
    let refuse = |reason: &'static str, why: &str, message: String, extra: Vec<(&str, Value)>| {
        record_refused_core(state, &run, reason, why, Some(button), None, extra);
        ButtonGateRefusal { reason, message }
    };
    let cell = &button.cell;

    // 1. The list.
    if !allowed.contains(&command_id) {
        return Err(refuse(
            "notAllowlisted",
            "it is not on Calcula's list of commands a button from an application may run",
            format!(
                "{APPLICATION_COMMAND_NOT_ALLOWED}: the button cell at {cell} came with the application \
                 '{application}' and asks to run the command \"{command_id}\", which is not on Calcula's list of \
                 commands a button from an application may run, so it did not run. To run it yourself, give the \
                 button an action of your own (Insert > Cell Type > Button)."
            ),
            Vec::new(),
        ));
    }

    // 2. The approval, under the command key -- never the bare record.
    let key = crate::button_cells::button_command_consent_key(application);
    let approved =
        consent_file.is_some_and(|f| crate::calp_commands::consent_granted_in(f, &key, command_id, &command_hash));
    if !approved {
        return Err(refuse(
            "notConsented",
            "it is not approved",
            format!(
                "{APPLICATION_COMMAND_NOT_APPROVED}: the button cell at {cell} came with the application \
                 '{application}' and asks to run the command \"{command_id}\", and you have not approved that, so \
                 it did not run. The approval screen comes back the next time this workbook is opened or the \
                 application is updated."
            ),
            Vec::new(),
        ));
    }

    // 3. The working-copy private-sheet rule. A store that cannot be read is a
    //    refusal, and on the trail like every other one.
    let unavailable = |why: String| {
        refuse(
            "stateUnavailable",
            "the workbook's sheets could not be read, so the working-copy rule could not be checked",
            why.clone(),
            vec![("error", Value::from(why.as_str()))],
        )
    };
    let link: Option<calp::WorkingCopyLink> =
        state.working_copy_link.read().map_err(|e| unavailable(e.to_string()))?.clone();
    if link.is_some() {
        let sheets = workbook_sheet_facts(state).map_err(unavailable)?;
        let artifact = format!("{cell}: the command {command_id}");
        if let Some(refusal) = private_sheet_refusal(link.as_ref(), &sheets, application, &artifact) {
            return Err(refuse(
                "privateSheets",
                "the working copy holds sheets that are not the application's",
                refusal,
                vec![("privateSheets", serde_json::json!(private_sheets(link.as_ref(), &sheets)))],
            ));
        }
    }

    // 4. The run row -- only once the page has checked its half too.
    if phase == CommandGatePhase::Admitted {
        record_run(state, &run, Some(button), Some(&BUTTON_DOOR_ACCESS));
    }
    Ok(())
}

/// The always-on refusal row for an `authorize_button_command` whose claim the
/// store does not back: the stamped button cell there does not run exactly
/// that command (it runs another, a macro, nothing, or holds its action for a
/// working copy). Recorded as the unverified claim it is (`claimedTrigger`).
pub(crate) fn record_button_command_mismatch(
    state: &AppState,
    application: &str,
    command_id: &str,
    trigger: &ScriptRunTrigger,
    why: &str,
) {
    let run = CodeRun {
        surface: BUTTON_COMMAND_SURFACE,
        application,
        ids: vec![command_id.to_string()],
        source_hash: Some(calp::integrity::sha256_hex(command_id.as_bytes())),
    };
    record_refused_core(state, &run, "triggerMismatch", why, None, Some(trigger), Vec::new());
}

/// What an `authorize_button_command` whose claim the store does not back says.
pub(crate) fn button_command_mismatch_refusal(application: &str, command_id: &str, why: &str) -> String {
    format!(
        "{APPLICATION_CODE_TRIGGER_MISMATCH}: the command \"{command_id}\" was asked for by a button from the \
         application \"{application}\", and {why}. A button runs only what it holds, so nothing ran."
    )
}

/// The always-on refusal row for an application's object-script macro the
/// one-off runner refused BEFORE it started (owner decision B, follow-up F8):
/// a person ran it, and it also calls `methods`, which are outside the cell
/// access such a run gets -- so nothing ran (`explicit_run_audit`). Named like
/// every other refusal of an application's code: surface, application, macro,
/// the hash of the source that was about to run, the reason.
pub(crate) fn record_explicit_run_refused(
    state: &AppState,
    application: &str,
    macro_id: &str,
    source_hash: String,
    methods: &[String],
) {
    let run = CodeRun {
        surface: OBJECT_SCRIPT_SURFACE,
        application,
        ids: vec![macro_id.to_string()],
        source_hash: Some(source_hash),
    };
    let why = format!(
        "it also calls {}, which is outside the cell access a macro you run yourself gets, so it was stopped \
         before it started and nothing was changed",
        methods.join(", ")
    );
    record_refused_core(
        state,
        &run,
        "outsideCellAccess",
        &why,
        None,
        None,
        vec![("methods", serde_json::json!(methods))],
    );
}

/// The always-on refusal row for an application's object-script macro a
/// person ran whose code is NOT approved, refused by the one-off runner before
/// the mount gate was asked (review of M6b: `explicit_run_audit` asks the
/// approval before the pre-flight's own reason). The row the mount gate writes
/// for the same refusal: reason `notConsented`, "its code is not approved".
pub(crate) fn record_explicit_run_not_approved(state: &AppState, application: &str, macro_id: &str, source_hash: String) {
    let run = CodeRun {
        surface: OBJECT_SCRIPT_SURFACE,
        application,
        ids: vec![macro_id.to_string()],
        source_hash: Some(source_hash),
    };
    record_refused_core(state, &run, "notConsented", "its code is not approved", None, None, Vec::new());
}

#[cfg(test)]
#[path = "application_code_gate_tests.rs"]
mod tests;
