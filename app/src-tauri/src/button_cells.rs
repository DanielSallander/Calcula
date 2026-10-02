//! FILENAME: app/src-tauri/src/button_cells.rs
//! PURPOSE: BUG-0260 -- a button CELL (Cell Type: Button, `calcula.button`) that
//! arrives with an application may run only a macro that application actually
//! brought into this workbook, or a Calcula command on
//! [`DISTRIBUTABLE_BUTTON_COMMANDS`] (empty today). At a checkout the rest is
//! HELD and a push restores it after matching the signed base, exactly like a
//! button control's code (BUG-0257, `held_button_code`).
//! CONTEXT: A button cell carries its action in its cell-type params:
//! `{ kind: "script", scriptId, functionName? }` or `{ kind: "command",
//! commandId }`. Those params publish as an opaque `cellType` custom object and
//! used to be materialized on every door byte for byte. A click resolves the
//! script id against EVERY module in the workbook, so an application's button
//! naming `macro-report` ran the subscriber's -- or, at a checkout, the
//! developer's -- own `macro-report`, unlocked, with a publisher-chosen call
//! appended to it. A command action fired any registered extension command on
//! one click, outside every approval. That is the confused deputy that got
//! `macroRef` stripped from button controls, live on the other channel.
//!
//! * ADMISSION (`admit_button_cells`), at every door that brings an application
//!   into a workbook -- subscribe, refresh AND checkout (a dev pull carries no
//!   cell types). Rust stamps every button cell `fromApplication` = (workspace
//!   scope id, application, version); a package's own claim to that key, or to
//!   `heldAction`, is discarded first. A script action is kept only when its
//!   `scriptId` is among the modules THIS pull actually applied for this
//!   application -- `materialize_distributed_scripts`' applied list, never the
//!   incoming list: an id skipped on a collision is exactly the id that names
//!   somebody else's macro. A command action is kept only when its `commandId`
//!   is on [`DISTRIBUTABLE_BUTTON_COMMANDS`] -- live and stamped on EVERY door,
//!   a checkout included (a push then judges it like any live action).
//!   Everything else (a macro the pull did not apply, a command not on the
//!   list, an action this build does not recognise) is REMOVED with a notice on
//!   a subscriber's door and HELD (`heldAction`, which no click reads) at a
//!   checkout.
//!
//! * THE CLICK (the Rust button door, `scripting::control_action::plan_cell_action`
//!   behind `run_control_action`; the page only names the cell) refuses a
//!   stamped button whose module did not come with that application. A stamped
//!   COMMAND goes to `application_code_gate::button_command_gate`: it must be on
//!   the list, approved under its own consent key
//!   ([`button_command_consent_key`], never the application's bare record) and
//!   allowed by the working-copy private-sheet rule -- every refusal recorded.
//!   Only then does the door answer `command` with the application, and the
//!   page, after its own check of the LIVE registration, asks
//!   `authorize_button_command` -- the same gate again, from the store, and the
//!   always-on run row -- before it runs the command. The admission is what
//!   removes the action; the click check is the second, independent layer for
//!   anything that reaches the store another way (a sheet copy, a file).
//!
//! * RELEASE (`release_button_cells_for_publish`), on the publish CARRIER only:
//!   the stamp never ships, and a held action goes back live only when the
//!   working copy's link targets this application, the stamp names it and this
//!   workspace at a version no newer than the base, the cell sits on one of the
//!   application's base sheets, it has no live action of its own, and the hash
//!   of the action is among the button-cell actions of the SIGNED base version,
//!   read through the authorised reader. Anything else refuses the push, naming
//!   the cell (`judge_held`, shared with button controls). A push that is not
//!   of the working copy's application restores nothing and refuses nothing: the
//!   held action is listed as withheld. And a LIVE action the signed base does
//!   not carry -- a new or re-pointed button -- is UNREVIEWED, acknowledged by
//!   hash with the action on screen, exactly like a button control's new code
//!   (the design's "any other new button code needs an explicit
//!   acknowledgement"; a review found cell actions skipped it).

use std::collections::{HashMap, HashSet};

use identity::SheetId;
use serde_json::Value;

use crate::held_button_code::{
    a1, executable_value_hash, judge_held, not_this_working_copy, ButtonCodeItem, ButtonCodeRelease,
    HeldFrom, HeldTarget, SignedBase,
};

/// The button cell type's id (`BUTTON_TYPE_ID` in CellTypes/types/button.ts).
pub const BUTTON_CELL_TYPE_ID: &str = "calcula.button";
/// The live action a click reads.
pub const ACTION_PARAM: &str = "action";
/// Where a checkout keeps an application's action no click may run. Written by
/// the admission only; the cell-type write doors refuse it by name.
pub const HELD_ACTION_PARAM: &str = "heldAction";
/// The stamp: which application (workspace, name, version) the button came with.
pub const FROM_APPLICATION_PARAM: &str = "fromApplication";
/// Params a PACKAGE may never carry: the admission writes both.
pub const ADMISSION_OWNED_PARAMS: &[&str] = &[HELD_ACTION_PARAM, FROM_APPLICATION_PARAM];
/// The value type a cell action is hashed under, so the hash of an action can
/// never equal the hash of a control's code of the same text.
pub const CELL_ACTION_VALUE_TYPE: &str = "cellButtonAction";
/// The slot name a cell action is reported under in a `ButtonCodeItem`.
pub const CELL_ACTION_SLOT: &str = "action";

/// THE LIST of Calcula commands a button cell that came with an application may
/// run, and the authority on it: the admission ([`admit_button_cells`], every
/// door) and the click gate (`application_code_gate::button_command_gate`, asked
/// by the button door and again by `authorize_button_command`) both read THIS
/// constant, and nothing else.
///
/// An id is added only by a reviewed owner decision, and only together with
/// `distributableTrigger: true` on that command's TypeScript registration -- the
/// page's second, independent yes, read off the LIVE registered command. A
/// drift test holds the two lists equal.
///
/// EMPTY TODAY, on purpose (plan_M8 S1, owner decision 2026-09-30): none of the
/// commands a button can reach is worth running for a report reader. The
/// cell-type and checkbox commands act on the selection, which the click first
/// sets to the button's own cell (`cellTypes.clear` would erase the button
/// itself); the chart commands need a chart id a button never passes, and the
/// one that takes none restores the last deleted chart; `sparklines.clearAll`
/// wipes every sparkline. So every command an application's button names is
/// still removed (or held at a checkout) and refused at the click, and the
/// owner names the first command.
pub const DISTRIBUTABLE_BUTTON_COMMANDS: &[&str] = &[];

/// The consent-record key prefix of an application's COMMAND approvals:
/// `button-commands:<application>`. Never the application's bare record: that
/// record is the object-script key, and the mount door's application floor
/// (`calp_commands::consent_record_exists_in`) admits a mount that names no
/// artifact on ANY non-empty record under it -- so a command approval recorded
/// there would open that floor. Application names cannot contain ':'
/// (`calp::workspace::validate_component`), so no application's bare key can
/// equal another's `button-commands:` key. Not a mount surface
/// (`scripting::commands::CONSENT_SURFACES` has no row for it).
pub const BUTTON_COMMAND_CONSENT_PREFIX: &str = "button-commands:";

/// The consent key `application`'s command approvals are recorded under.
pub(crate) fn button_command_consent_key(application: &str) -> String {
    format!("{BUTTON_COMMAND_CONSENT_PREFIX}{application}")
}

// ============================================================================
// Admission
// ============================================================================

/// What an admission does with an action it may not keep live.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CellActionWiring {
    /// Subscribe and refresh: remove it, with a notice.
    Remove,
    /// Checkout: move it into `heldAction`, which no click reads.
    Hold,
}

/// One door's admission of button cells.
pub struct ButtonCellDoor<'a> {
    /// The stamp every button cell of this application gets.
    pub from: HeldFrom,
    /// The module ids THIS pull actually applied for this application.
    pub applied_modules: &'a HashSet<String>,
    /// The commands an application's button may run. Every production door
    /// passes [`DISTRIBUTABLE_BUTTON_COMMANDS`] (pinned by a census); the
    /// parameter exists so the unit tier can prove the rule with a list that is
    /// not empty.
    pub allowed_commands: &'a [&'a str],
    pub wiring: CellActionWiring,
    /// Application sheet id -> sheet name, for the notices.
    pub sheet_names: &'a HashMap<SheetId, String>,
}

/// What an admission did, for the caller's response.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ButtonCellAdmission {
    /// Actions kept live: a script action naming a macro this pull applied, or
    /// a command on the list.
    pub kept: usize,
    /// Actions moved into `heldAction` (checkout), one sentence each.
    pub held: Vec<String>,
    /// Actions removed (subscribe, refresh), one sentence each.
    pub removed: Vec<String>,
    /// `heldAction` / `fromApplication` keys a package carried, discarded.
    pub discarded_claims: usize,
}

impl ButtonCellAdmission {
    pub fn absorb(&mut self, other: ButtonCellAdmission) {
        self.kept += other.kept;
        self.held.extend(other.held);
        self.removed.extend(other.removed);
        self.discarded_claims += other.discarded_claims;
    }
}

/// Why an action may not stay live.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Disallowed {
    /// A script action naming a module this pull did not apply for the
    /// application -- absent, or skipped because the id is somebody else's.
    MacroNotApplied(String),
    /// A command action whose command is not on the list a button from an
    /// application may run ([`DISTRIBUTABLE_BUTTON_COMMANDS`]).
    Command(String),
    /// Anything else this build does not recognise.
    Unrecognised,
}

fn judge_action(action: &Value, applied: &HashSet<String>, allowed_commands: &[&str]) -> Result<(), Disallowed> {
    let kind = action.get("kind").and_then(Value::as_str).unwrap_or("");
    match kind {
        "script" => match action.get("scriptId").and_then(Value::as_str) {
            Some(id) if applied.contains(id) => Ok(()),
            Some(id) => Err(Disallowed::MacroNotApplied(id.to_string())),
            None => Err(Disallowed::Unrecognised),
        },
        "command" => match action.get("commandId").and_then(Value::as_str) {
            Some(id) if allowed_commands.contains(&id) => Ok(()),
            id => Err(Disallowed::Command(id.unwrap_or("").to_string())),
        },
        _ => Err(Disallowed::Unrecognised),
    }
}

fn describe(cell: &str, why: &Disallowed, application: &str) -> String {
    match why {
        Disallowed::MacroNotApplied(id) => format!(
            "{cell}: runs the macro '{id}', which the application '{application}' did not bring \
             into this workbook -- a button from an application runs only that application's own \
             macros, never one of yours or another application's with the same id"
        ),
        Disallowed::Command(id) => format!(
            "{cell}: runs the command '{id}', which is not on Calcula's list of commands a button from an \
             application may run"
        ),
        Disallowed::Unrecognised => {
            format!("{cell}: has an action this version of Calcula does not recognise")
        }
    }
}

/// Admit an application's cell-type payloads: stamp every button cell, keep a
/// script action only when it names a module this pull applied and a command
/// action only when its command is on `door.allowed_commands`, and hold or
/// remove every other action. Every other cell type passes through untouched.
///
/// Pure over the payload; the one implementation every door calls.
pub fn admit_button_cells(
    saved: &[persistence::SavedSheetCellTypes],
    door: &ButtonCellDoor<'_>,
) -> (Vec<persistence::SavedSheetCellTypes>, ButtonCellAdmission) {
    let mut report = ButtonCellAdmission::default();
    let stamp = serde_json::to_value(&door.from).unwrap_or(Value::Null);
    let admitted = saved
        .iter()
        .map(|sheet_cells| {
            let mut cloned = sheet_cells.clone();
            let sheet_name = door
                .sheet_names
                .get(&sheet_cells.sheet_id)
                .cloned()
                .unwrap_or_else(|| sheet_cells.sheet_id.to_string());
            let Value::Array(entries) = &mut cloned.cells else { return cloned };
            for entry in entries {
                if entry.get("typeId").and_then(Value::as_str) != Some(BUTTON_CELL_TYPE_ID) {
                    continue;
                }
                let row = entry.get("row").and_then(Value::as_u64).unwrap_or(0) as u32;
                let col = entry.get("col").and_then(Value::as_u64).unwrap_or(0) as u32;
                // A button with no params object has no action to judge, and
                // giving it one would change its bytes for nothing.
                let Some(params) = entry.get_mut("params").and_then(Value::as_object_mut) else {
                    continue;
                };
                // A PACKAGE NEVER CARRIES THE ADMISSION'S KEYS. A held action
                // that arrived would be restored at this developer's next push,
                // and a stamp is what the click trusts.
                for key in ADMISSION_OWNED_PARAMS {
                    if params.remove(*key).is_some() {
                        report.discarded_claims += 1;
                    }
                }
                if let Some(action) = params.remove(ACTION_PARAM) {
                    if action.is_null() {
                        params.insert(ACTION_PARAM.to_string(), action);
                    } else {
                        match judge_action(&action, door.applied_modules, door.allowed_commands) {
                            Ok(()) => {
                                params.insert(ACTION_PARAM.to_string(), action);
                                report.kept += 1;
                            }
                            Err(why) => {
                                let cell = format!("{}!{}", sheet_name, a1(row, col));
                                let notice = describe(&cell, &why, &door.from.application);
                                match door.wiring {
                                    CellActionWiring::Hold => {
                                        params.insert(HELD_ACTION_PARAM.to_string(), action);
                                        report.held.push(notice);
                                    }
                                    CellActionWiring::Remove => report.removed.push(notice),
                                }
                            }
                        }
                    }
                }
                params.insert(FROM_APPLICATION_PARAM.to_string(), stamp.clone());
            }
            cloned
        })
        .collect();
    (admitted, report)
}

/// The cell-type payloads (kind `cellType`) of a pull, as the materializer
/// takes them.
pub fn cell_type_payloads(
    custom_objects: &[calp::pull::PulledCustomObject],
) -> Vec<persistence::SavedSheetCellTypes> {
    custom_objects
        .iter()
        .filter(|co| co.kind == "cellType")
        .filter_map(|co| {
            co.package_sheet_id.map(|sid| persistence::SavedSheetCellTypes {
                sheet_id: sid,
                cells: co.payload.clone(),
            })
        })
        .collect()
}

/// The write doors (`set_cell_type`, `set_cell_type_range`) refuse a held
/// action by name. Whatever sits in `heldAction` is published at the next push
/// under the pusher's key, so only the checkout admission may put it there.
///
/// The stamp (`fromApplication`) is NOT refused: it can only narrow what a
/// click runs (a stamped button runs its application's macros, and a command
/// only when it is on the list and approved, and nothing else), and a future
/// paste of a button cell has to be able to carry it.
pub fn refuse_held_action_write(params: Option<&Value>) -> Result<(), String> {
    if params.and_then(|p| p.get(HELD_ACTION_PARAM)).is_some() {
        return Err(format!(
            "CELL_TYPE_HELD_ACTION: '{HELD_ACTION_PARAM}' holds an application's button action, kept \
             for publishing, and nothing but opening the application for editing may write it: \
             whatever sits there is published at the next push. Give the button an action of your \
             own instead (Insert > Cell Type > Button)."
        ));
    }
    Ok(())
}

// ============================================================================
// Release (push)
// ============================================================================

/// The canonical text of an action: what is hashed, shown and compared.
/// `serde_json` sorts object keys here (no `preserve_order`), so two spellings
/// of one action hash the same.
pub fn canonical_action(action: &Value) -> String {
    serde_json::to_string(action).unwrap_or_default()
}

/// The hash a cell action is judged and acknowledged by.
pub fn cell_action_hash(action: &Value) -> String {
    executable_value_hash(CELL_ACTION_VALUE_TYPE, &canonical_action(action))
}

/// Every button-cell action in one `cellType` payload, hashed.
pub fn cell_action_hashes_in(payload: &Value) -> HashSet<String> {
    let mut out = HashSet::new();
    let Some(entries) = payload.as_array() else { return out };
    for entry in entries {
        if entry.get("typeId").and_then(Value::as_str) != Some(BUTTON_CELL_TYPE_ID) {
            continue;
        }
        if let Some(action) = entry.get("params").and_then(|p| p.get(ACTION_PARAM)) {
            if !action.is_null() {
                out.insert(cell_action_hash(action));
            }
        }
    }
    out
}

/// Does any published button cell hold an action, held or live?
fn carries_action(objects: &[calp::publish::PublishCustomObject]) -> bool {
    objects.iter().filter(|co| co.kind == "cellType").any(|co| {
        co.payload.as_array().is_some_and(|entries| {
            entries.iter().any(|entry| {
                entry.get("typeId").and_then(Value::as_str) == Some(BUTTON_CELL_TYPE_ID)
                    && entry.get("params").is_some_and(|p| {
                        p.get(HELD_ACTION_PARAM).is_some()
                            || p.get(ACTION_PARAM).is_some_and(|a| !a.is_null())
                    })
            })
        })
    })
}

/// Release the button cells of a publish CARRIER's cell-type objects.
///
/// The stamp is removed from every button cell -- it is this machine's record,
/// never the application's. A held action goes back live when [`judge_held`]
/// allows it and refuses the push otherwise; without a `target` it is listed
/// as withheld instead. With a `target`, a LIVE action the signed base does not
/// carry is listed as unreviewed. Pure over the carrier.
pub fn release_button_cells_for_publish(
    objects: &mut [calp::publish::PublishCustomObject],
    sheet_names: &HashMap<SheetId, String>,
    target: Option<&HeldTarget>,
) -> ButtonCodeRelease {
    let mut release = ButtonCodeRelease::default();
    for object in objects.iter_mut().filter(|co| co.kind == "cellType") {
        let sheet = object.sheet_id;
        let sheet_name = sheet
            .and_then(|s| sheet_names.get(&s).cloned())
            .unwrap_or_else(|| sheet.map(|s| s.to_string()).unwrap_or_default());
        let Value::Array(entries) = &mut object.payload else { continue };
        for entry in entries {
            if entry.get("typeId").and_then(Value::as_str) != Some(BUTTON_CELL_TYPE_ID) {
                continue;
            }
            let row = entry.get("row").and_then(Value::as_u64).unwrap_or(0) as u32;
            let col = entry.get("col").and_then(Value::as_u64).unwrap_or(0) as u32;
            let Some(params) = entry.get_mut("params").and_then(Value::as_object_mut) else {
                continue;
            };
            // ALWAYS: neither key ever reaches a package.
            let stamp = params.remove(FROM_APPLICATION_PARAM);
            let held = params.remove(HELD_ACTION_PARAM);
            let live = params.get(ACTION_PARAM).filter(|a| !a.is_null()).cloned();
            let from: Option<HeldFrom> = stamp.and_then(|s| serde_json::from_value(s).ok());
            let item = |code: &str, application: &str, reason: String| ButtonCodeItem {
                sheet_id: sheet.map(|s| s.to_string()).unwrap_or_default(),
                sheet_name: sheet_name.clone(),
                row,
                col,
                cell: format!("{}!{}", sheet_name, a1(row, col)),
                slot: CELL_ACTION_SLOT.to_string(),
                value_type: CELL_ACTION_VALUE_TYPE.to_string(),
                code: code.to_string(),
                hash: executable_value_hash(CELL_ACTION_VALUE_TYPE, code),
                application: application.to_string(),
                reason,
            };

            // A live action wins: only a file puts both on one button (the write
            // doors refuse `heldAction`), and the live one is what would run --
            // it is judged as live code below.
            if let (Some(held), None) = (held, live.as_ref()) {
                let code = canonical_action(&held);
                let application = from.as_ref().map(|f| f.application.clone()).unwrap_or_default();
                if target.is_none() {
                    // Not a push of the working copy's application: nothing goes
                    // back, and the push says so by name instead of refusing.
                    release.withheld.push(item(&code, &application, not_this_working_copy(&application)));
                    continue;
                }
                let verdict = match sheet {
                    Some(sheet) => judge_held(from.as_ref(), target, sheet, CELL_ACTION_VALUE_TYPE, &code),
                    None => Err("it is not on any sheet".to_string()),
                };
                match verdict {
                    Ok(()) => {
                        release.restored.push(item(&code, &application, String::new()));
                        params.insert(ACTION_PARAM.to_string(), held);
                    }
                    Err(reason) => release.refused.push(item(&code, &application, reason)),
                }
                continue;
            }

            // A LIVE action on a working-copy push that the signed base does not
            // carry: a new button, or one re-pointed at another macro. It goes
            // out under the pusher's key, so it is reviewed with the action on
            // screen and acknowledged by hash, like a button control's new code.
            let (Some(target), Some(action)) = (target, live) else { continue };
            let code = canonical_action(&action);
            let reason = match &target.base_code {
                Ok(known) if known.contains(&cell_action_hash(&action)) => continue,
                Ok(_) => format!(
                    "the signed v{} of '{}' does not have this button action here or on any other \
                     button cell",
                    target.base_version, target.application
                ),
                Err(why) => format!(
                    "the signed v{} could not be read to compare it ({})",
                    target.base_version, why
                ),
            };
            release.unreviewed.push(item(&code, "", reason));
        }
    }
    release
}

/// Every published button CELL whose live script action names a macro the
/// push does not publish -- the cell half of
/// `held_button_code::unshipped_macro_links` (a control's `macroRef` is the
/// other half, `calp::publish::unshipped_macro_links`).
///
/// Read off the RELEASED cell-type objects (the stamp removed, a held action
/// restored or withheld), which are exactly what the push ships. A command
/// action names no macro and is not this check's business. Per object, in
/// (row, col) order.
pub(crate) fn unshipped_cell_macro_links(
    objects: &[calp::publish::PublishCustomObject],
    sheet_names: &HashMap<SheetId, String>,
    shipped_module_ids: &HashSet<String>,
) -> Vec<calp::publish::UnshippedMacroLink> {
    let mut out = Vec::new();
    for object in objects.iter().filter(|co| co.kind == "cellType") {
        let Some(sheet) = object.sheet_id else { continue };
        let sheet_name = sheet_names.get(&sheet).cloned().unwrap_or_else(|| sheet.to_string());
        let Some(entries) = object.payload.as_array() else { continue };
        let mut links: Vec<(u32, u32, String)> = entries
            .iter()
            .filter(|entry| entry.get("typeId").and_then(Value::as_str) == Some(BUTTON_CELL_TYPE_ID))
            .filter_map(|entry| {
                let action = entry.get("params")?.get(ACTION_PARAM)?;
                if action.get("kind").and_then(Value::as_str) != Some("script") {
                    return None;
                }
                let id = action.get("scriptId").and_then(Value::as_str).filter(|id| !id.is_empty())?;
                if shipped_module_ids.contains(id) {
                    return None;
                }
                let row = entry.get("row").and_then(Value::as_u64).unwrap_or(0) as u32;
                let col = entry.get("col").and_then(Value::as_u64).unwrap_or(0) as u32;
                Some((row, col, id.to_string()))
            })
            .collect();
        links.sort();
        out.extend(links.into_iter().map(|(row, col, macro_id)| calp::publish::UnshippedMacroLink {
            sheet_id: sheet,
            sheet_name: sheet_name.clone(),
            row,
            col,
            cell: format!("{}!{}", sheet_name, a1(row, col)),
            macro_id,
        }));
    }
    out
}

/// The button-cell actions of the SIGNED base version, hashed -- read through
/// [`SignedBase`] (the authorised reader, opened once per assembly and shared
/// with the button controls), each `cellType` payload re-verified against the
/// checksum the verified manifest records.
pub(crate) fn signed_base_cell_actions(base: &SignedBase, base_version: &str) -> Result<HashSet<String>, String> {
    let payload_paths: Vec<String> = base
        .manifest(base_version)?
        .custom_objects
        .iter()
        .filter(|co| co.kind == "cellType")
        .map(|co| co.payload_path.clone())
        .collect();
    let mut out = HashSet::new();
    for path in payload_paths {
        let bytes = base
            .verified_artifact(base_version, &path)?
            .ok_or_else(|| format!("its signed manifest lists {path} without a checksum"))?;
        let payload: Value =
            serde_json::from_slice(&bytes).map_err(|e| format!("{path} is unreadable: {e}"))?;
        out.extend(cell_action_hashes_in(&payload));
    }
    Ok(out)
}

/// Release the button cells of `objects` (a publish carrier's cell-type
/// objects) for a push of `package_name` to `registry_path`.
///
/// Called ONCE from `assemble_publish_workbook`, so the publish, the dry-run
/// preview and the working-copy diff release identically. Reads the signed base
/// (through `base`, shared with the controls' release) only when the push is a
/// working-copy push AND a published button cell holds an action, held or live.
pub(crate) fn release_cell_buttons_for_push(
    state: &crate::AppState,
    objects: &mut [calp::publish::PublishCustomObject],
    sheet_names: &HashMap<SheetId, String>,
    registry_path: &str,
    package_name: &str,
    base: &SignedBase,
) -> Result<ButtonCodeRelease, String> {
    let link: Option<calp::WorkingCopyLink> =
        state.working_copy_link.read().map_err(|e| e.to_string())?.clone();
    let target = match link.as_ref().filter(|l| l.targets(registry_path, package_name)) {
        Some(link) => {
            let base_code = if carries_action(objects) {
                signed_base_cell_actions(base, &link.base_version)
            } else {
                Ok(HashSet::new())
            };
            Some(HeldTarget {
                workspace: calp::workspace_scope(registry_path).map(|s| s.id).unwrap_or_default(),
                application: link.package_name.clone(),
                base_version: link.base_version.clone(),
                base_sheets: link.base_sheets.iter().map(|s| s.sheet_id).collect(),
                base_code,
            })
        }
        None => None,
    };
    Ok(release_button_cells_for_publish(objects, sheet_names, target.as_ref()))
}

// ============================================================================
// The click's refusals, on the audit trail
// ============================================================================

/// Record a CLICK's refusal of an application's button: a stamped button cell
/// whose action names a macro that did not come with its application
/// (BUG-0260), or whose command the page refused (its live registration does
/// not opt in -- a refusal of a command Rust's gate did not make is the page's
/// to record); a button control whose held macro link cannot be run
/// as its application's macro -- its stamp unreadable, or the macro not that
/// application's (phase 3 of BUG-0257). This is the always-on trail of those
/// refusals ("every run and every refusal of application code is written to the
/// audit trail"). Since phase 4 the Rust button door (`run_control_action`)
/// refuses a cell's action and a control's inline code itself and records
/// through `audit_button_refusal_core`; the page's only remaining caller of the
/// command is the held macro LINK route (Controls' `runButtonMacroLink`).
///
/// The APPLICATION is read from the button's own stamp in the backend store --
/// a cell's `fromApplication`, a control's `heldFrom` -- never taken from the
/// page, and a button that did not come with an application records nothing
/// and says so. Main window only.
///
/// THE BUTTON'S SHEET IS NAMED BY THE CALLER (`sheet_index`, the TRUE
/// state-vector index the run's trigger also carries), never read off the
/// ACTIVE sheet here: the click's refusal is recorded after several awaits,
/// and a sheet switch in between -- or a button on a sheet that is not the
/// active index -- used to find nothing at that cell, so the refusal of an
/// application's code went unrecorded. `verify_trigger` looks buttons up the
/// same way.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn audit_button_refusal(
    state: tauri::State<crate::AppState>,
    kind: crate::held_button_code::MacroLinkKind,
    sheet_index: usize,
    row: u32,
    col: u32,
    refused: String,
    reason: String,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    audit_button_refusal_core(&state, kind, sheet_index, row, col, &refused, &reason)
}

/// What a button CELL's stamp (`fromApplication`) says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CellStamp {
    /// No stamp: the user's own button.
    Own,
    /// A stamp that names no application (no `application` string, or an
    /// empty one): an application's button whose record cannot be read.
    Unreadable,
    /// The application it came with, and its version ("" when the stamp
    /// records none).
    Application { application: String, version: String },
}

/// THE ONE READING of a button cell's stamp, shared by the button door
/// (`scripting::control_action`), the click's audit core
/// ([`audit_button_refusal_core`]) and the run gate's trigger check
/// (`application_code_gate::verify_trigger`), so a refusal and the row that
/// records it can never name two different applications. Lax on purpose: the
/// `application` string is what every reader acts on; the `workspace` a
/// checkout also writes is not needed to say whose button it is.
pub(crate) fn cell_stamp(params: &Value) -> CellStamp {
    let Some(stamp) = params.get(FROM_APPLICATION_PARAM) else {
        return CellStamp::Own;
    };
    match stamp.get("application").and_then(Value::as_str).filter(|a| !a.is_empty()) {
        Some(application) => CellStamp::Application {
            application: application.to_string(),
            version: stamp.get("version").and_then(Value::as_str).unwrap_or_default().to_string(),
        },
        None => CellStamp::Unreadable,
    }
}

/// Which application a clicked button came with, from the backend's store:
/// `(application, version)`, or `None` for an application's button whose stamp
/// cannot be read (which is exactly what a click refuses it for).
fn clicked_button_origin(
    state: &crate::AppState,
    kind: crate::held_button_code::MacroLinkKind,
    sheet_index: usize,
    row: u32,
    col: u32,
) -> Result<Option<(String, String)>, String> {
    use crate::held_button_code::MacroLinkKind;
    let key = (sheet_index, row, col);
    match kind {
        MacroLinkKind::Cell => {
            let cell_types = state.cell_types.read().map_err(|e| e.to_string())?;
            let assignment = cell_types
                .get(&key)
                .filter(|a| a.type_id == BUTTON_CELL_TYPE_ID)
                .ok_or_else(|| "There is no button cell there; nothing was recorded.".to_string())?;
            match cell_stamp(&assignment.params) {
                CellStamp::Application { application, version } => Ok(Some((application, version))),
                // A stamp that names no readable application is still an
                // application's button (exactly what the button door refuses
                // it for), recorded as such -- like a control's unreadable
                // `heldFrom`. So is a HELD action with no stamp at all: a held
                // action exists only under an application's stamp.
                CellStamp::Unreadable => Ok(None),
                CellStamp::Own if assignment.params.get(HELD_ACTION_PARAM).is_some() => Ok(None),
                CellStamp::Own => {
                    Err("That button cell did not come with an application; nothing was recorded.".to_string())
                }
            }
        }
        MacroLinkKind::Control => {
            let controls = state.controls.read().map_err(|e| e.to_string())?;
            let meta = controls
                .get(&key)
                .ok_or_else(|| "There is no button control there; nothing was recorded.".to_string())?;
            let stamp = meta.properties.get(crate::controls::HELD_FROM_PROPERTY);
            match stamp.and_then(|p| HeldFrom::decode(&p.value)) {
                Some(from) => Ok(Some((from.application, from.version))),
                // An application's button (it holds the application's code, or
                // a stamp) whose stamp cannot be read.
                None if stamp.is_some() || crate::controls::holds_application_code(meta) => Ok(None),
                None => Err(
                    "That button did not come with an application; nothing was recorded.".to_string()
                ),
            }
        }
    }
}

/// [`audit_button_refusal`] over a plain reference, for the unit tier.
pub(crate) fn audit_button_refusal_core(
    state: &crate::AppState,
    kind: crate::held_button_code::MacroLinkKind,
    sheet_index: usize,
    row: u32,
    col: u32,
    refused: &str,
    reason: &str,
) -> Result<(), String> {
    // Short, separate guards: the button's store, then the sheet names.
    let origin = clicked_button_origin(state, kind, sheet_index, row, col)?;
    let sheet_name = state
        .sheet_names
        .read()
        .map_err(|e| e.to_string())?
        .get(sheet_index)
        .cloned()
        .unwrap_or_else(|| format!("Sheet{}", sheet_index + 1));
    let cell = format!("{}!{}", sheet_name, a1(row, col));
    let mut extra: HashMap<String, Value> = HashMap::new();
    extra.insert("door".into(), Value::from("click"));
    extra.insert("kind".into(), serde_json::to_value(kind).unwrap_or(Value::Null));
    let (application, version) = origin.clone().unwrap_or_default();
    extra.insert("application".into(), Value::from(application.clone()));
    extra.insert("version".into(), Value::from(version));
    if origin.is_none() {
        extra.insert("stampUnreadable".into(), Value::from(true));
    }
    extra.insert("cells".into(), serde_json::json!([cell.clone()]));
    extra.insert("refused".into(), Value::from(refused));
    extra.insert("reason".into(), Value::from(reason));
    let came_with = if origin.is_some() {
        format!("the button came with '{application}'")
    } else {
        "the button's record of which application it came with is unreadable".to_string()
    };
    crate::calp_commands::record_audit_event_with_extra(
        state,
        calp::audit::AuditEvent::ButtonCodeRefused,
        format!("Refused a click on {cell}: {came_with}, and it may not run {refused}"),
        extra,
    );
    Ok(())
}

#[cfg(test)]
#[path = "button_cells_tests.rs"]
mod tests;
