//! FILENAME: app/src-tauri/src/held_button_code.rs
//! PURPOSE: The HELD compartment for button code in a working copy (BUG-0257):
//! checkout keeps an application's button code inert, and a push puts it back
//! on the published copy -- only when those exact bytes are in the SIGNED base.
//! CONTEXT: A button control carries its code in two slots, `onSelect` (inline
//! source) and `macroRef` (a macro id). Every door that brings an application
//! into a workbook used to strip both, checkout included, so a developer's
//! untouched push published the application's buttons without their code.
//!
//! The code cannot simply stay live in a working copy: a checkout cannot tell
//! the developer's own code from a colleague's, or from a version somebody
//! planted in the workspace, and live code runs on a click. So:
//!
//! * ADMISSION (`admit_wiring`). A dev pull STRIPS. Checkout HOLDS: each
//!   non-empty executable slot moves into its held key (`heldOnSelect` /
//!   `heldMacroRef`), which no click path reads, and Rust stamps the control
//!   `heldFrom` = (workspace scope, application, version). Subscribe and refresh
//!   hold a LANDED LINK (phase 3): a `macroRef` survives, held and stamped, only
//!   when it names a macro THIS pull actually brought in for the application --
//!   never one skipped on an id clash, which is exactly the id that names the
//!   subscriber's own macro -- and every other link is removed with a notice.
//!   And they hold INLINE code (phase 4): a STATIC `onSelect` moves into
//!   `heldOnSelect`, stamped, exactly as a checkout holds it; a formula-typed one
//!   is removed and named (only exact static bytes can be approved). Either way
//!   a held key a PACKAGE carries is discarded first: the compartment is written
//!   by this machine's admission, never by a publisher. Held slots are always
//!   stored `static`, so nothing evaluates them for display; the type the
//!   package gave a slot is kept in the stamp and restored exactly.
//!
//!   Held code RUNS only through the application's approval. A held link: the
//!   click asks for the macro with the stamp's application as the only
//!   acceptable owner, and the Rust run gate (`scripting::application_code_gate`)
//!   requires the hash-keyed consent. Held inline code: only through the button
//!   door (`scripting::control_action::run_control_action`), which reads it from
//!   the store and asks the approval of its exact bytes. A backstop
//!   (`held_code_outside_its_button`) refuses those bytes on the three routes
//!   that run an unnamed source as the user's own -- `run_script`'s ad-hoc
//!   branch, a cell of the user's own notebook, and the mount door's
//!   application-floor-only branch; it is a heuristic, and MCP / AI
//!   `execute_script` is a named follow-up (see the backstop section of
//!   `scripting::application_code_gate`). Every run and every refusal on those
//!   routes is recorded.
//!
//! * RELEASE (`release_held_code_for_publish`), on the publish CARRIER only --
//!   the live store is never re-armed. A held slot goes back live when the
//!   workbook's link targets this application, the stamp names it, the sheet is
//!   one of its base sheets, the live slot is absent, AND the sha256 of the
//!   slot's (valueType, value) is among the executable values of the SIGNED base
//!   version's `controls.json`, read through the authorised reader. Anything
//!   else REFUSES the push, naming the button: a working copy is a `.cala`, and a
//!   crafted one can carry any held bytes with any stamp. Held keys never reach
//!   `controls.json`. A push that is NOT of the working copy's application
//!   (publish as new, a scripted publish) restores nothing and refuses nothing:
//!   the held code is listed as `withheld`.
//!
//! * LIVE code on a push's published sheets that is NOT in the signed base (the
//!   author's own new code, or bytes a crafted file seeded) is listed as
//!   UNREVIEWED; the push request must acknowledge each one by hash, and the
//!   push preview shows it with the code.

use std::collections::{BTreeMap, HashMap, HashSet};

use identity::SheetId;
use serde::{Deserialize, Serialize};

use crate::controls::{
    held_slot_of, EXECUTABLE_CONTROL_PROPERTIES, HELD_CODE_PROPERTIES, HELD_CONTROL_PROPERTIES,
    HELD_FROM_PROPERTY, MACRO_REF_PROPERTY, ON_SELECT_PROPERTY,
};

// ============================================================================
// The stamp
// ============================================================================

/// Where a button's held code came from. Serialized (JSON) into the
/// `heldFrom` property by checkout; never written by anything else.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeldFrom {
    /// The workspace's pin-scope id (`calp::workspace_scope(..).id`) -- the
    /// normalized key, so two spellings of one workspace compare equal.
    pub workspace: String,
    /// The application the code came with.
    pub application: String,
    /// The version the working copy was checked out from.
    pub version: String,
    /// The value type the package gave each held slot, for any slot whose type
    /// was not `static`. The held slot itself is always `static` (a held value
    /// is never evaluated); this is what lets the push restore it exactly.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub value_types: BTreeMap<String, String>,
}

impl HeldFrom {
    pub fn encode(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    pub fn decode(text: &str) -> Option<Self> {
        serde_json::from_str(text).ok()
    }

    /// The value type `slot` had in the package.
    pub fn value_type_of(&self, slot: &str) -> &str {
        self.value_types.get(slot).map(String::as_str).unwrap_or("static")
    }
}

/// What an admission does with executable wiring.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DistributedWiring {
    /// No origin to hold anything under: remove it. The dev pull (which brings
    /// no modules, so no link could land), `sanitize_distributed_controls` and
    /// `media::migrate_distributed_inline_images`.
    Strip,
    /// Checkout: move every slot into the held compartment, stamped with this.
    /// A held link to a macro the application does not ship can never run --
    /// the click requires the macro to have come with the stamp's application
    /// -- and a push refuses it by name (`refuse_push_on_unshipped_macros`).
    Hold(HeldFrom),
    /// Subscribe and refresh: a `macroRef` naming one of `landed_macros` -- the
    /// module ids THIS pull actually applied for the application, never the
    /// incoming list -- moves into `heldMacroRef`, stamped with `from`; any
    /// other link is removed and named (phase 3). A STATIC `onSelect` moves into
    /// `heldOnSelect`, stamped, to run only through the button door after the
    /// approval of its exact bytes; any other `onSelect` is removed and named
    /// (phase 4).
    LinkLanded {
        from: HeldFrom,
        landed_macros: HashSet<String>,
        /// Application sheet id -> the name it landed under, for the notices.
        sheet_names: HashMap<SheetId, String>,
    },
}

/// What an admission did, for the caller's response.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WiringAdmission {
    /// Slots moved into the held compartment.
    pub held: usize,
    /// Of `held`, the macro LINKS (`macroRef`).
    pub links_held: usize,
    /// Slots removed.
    pub stripped: usize,
    /// Macro links a subscribe or refresh removed because the pull did not
    /// bring their macro in for the application, one sentence each.
    pub links_removed: Vec<String>,
    /// Of `held`, the INLINE code (`onSelect`) slots.
    pub inline_held: usize,
    /// Inline actions a subscribe or refresh removed because they are not
    /// static code (a formula), one sentence each.
    pub inline_removed: Vec<String>,
    /// Held keys a package carried, discarded before anything else.
    pub discarded_held_keys: usize,
}

/// The notice for a link a subscribe or refresh removed.
fn link_removed_notice(cell: &str, macro_id: &str, application: &str) -> String {
    format!(
        "{cell}: links the macro \"{macro_id}\", which the application '{application}' did not bring \
         into this workbook; the link was removed -- a button from an application runs only that \
         application's own macros, never one of yours or another application's with the same id"
    )
}

/// The notice for inline button code a subscribe or refresh removed: only
/// STATIC code can be approved (the approval is of exact bytes that run as
/// themselves), so a formula-typed action is not held.
fn inline_removed_notice(cell: &str) -> String {
    format!("{cell}: its action is a formula, which Calcula does not run as button code; it was removed")
}

/// The identity of one piece of button code: sha256 over its value type and
/// its bytes. The TYPE is part of it because the same text runs differently
/// as a formula and as source, and an acknowledgement names this hash.
pub fn executable_value_hash(value_type: &str, value: &str) -> String {
    let mut bytes = Vec::with_capacity(value_type.len() + 1 + value.len());
    bytes.extend_from_slice(value_type.as_bytes());
    bytes.push(0);
    bytes.extend_from_slice(value.as_bytes());
    calp::integrity::sha256_hex(&bytes)
}

fn static_value(text: &str) -> serde_json::Value {
    serde_json::json!({ "valueType": "static", "value": text })
}

// ============================================================================
// Admission
// ============================================================================

/// Admit a DISTRIBUTED control payload's executable wiring: strip it, or hold
/// it. The one implementation of both, so a checkout and a subscribe can differ
/// in exactly this step and nothing else (media migration, the per-value clamp
/// and the aggregate budget run on every door -- see `media.rs`).
///
/// An EXACTLY empty slot is not wiring and stays live either way (every button
/// the Controls recipe writes carries `onSelect: ""`).
pub fn admit_wiring(
    saved: &[persistence::SavedSheetControls],
    wiring: &DistributedWiring,
) -> (Vec<persistence::SavedSheetControls>, WiringAdmission) {
    let mut report = WiringAdmission::default();
    let admitted = saved
        .iter()
        .map(|sheet_controls| {
            let mut cloned = sheet_controls.clone();
            let sheet = sheet_controls.sheet_id;
            if let serde_json::Value::Array(entries) = &mut cloned.controls {
                for entry in entries {
                    let row = entry.get("row").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                    let col = entry.get("col").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                    let Some(props) = entry.get_mut("properties").and_then(|p| p.as_object_mut())
                    else {
                        continue;
                    };
                    // A PACKAGE NEVER CARRIES A HELD KEY. One that arrived would
                    // be restored at this developer's next push, under their key
                    // -- and at a subscriber it would be a link this machine
                    // never decided to keep.
                    for key in HELD_CONTROL_PROPERTIES {
                        if props.remove(*key).is_some() {
                            report.discarded_held_keys += 1;
                        }
                    }
                    let mut value_types: BTreeMap<String, String> = BTreeMap::new();
                    let mut stamp_with: Option<&HeldFrom> = None;
                    for key in EXECUTABLE_CONTROL_PROPERTIES {
                        let Some(slot) = props.get(*key) else { continue };
                        let text = slot.get("value").and_then(|v| v.as_str()).map(str::to_string);
                        let value_type = slot
                            .get("valueType")
                            .and_then(|v| v.as_str())
                            .unwrap_or("static")
                            .to_string();
                        if text.as_deref() == Some("") {
                            continue;
                        }
                        props.remove(*key);
                        // A slot whose value is not even a string: no click path
                        // could have run it and no push could restore it
                        // faithfully.
                        let Some(text) = text else {
                            report.stripped += 1;
                            continue;
                        };
                        // THE ONE STEP THAT VARIES BY DOOR: under whose stamp,
                        // if any, this slot is kept.
                        let hold_under: Option<&HeldFrom> = match wiring {
                            DistributedWiring::Strip => None,
                            DistributedWiring::Hold(from) => Some(from),
                            DistributedWiring::LinkLanded { from, landed_macros, sheet_names } => {
                                let cell = || {
                                    let sheet_name =
                                        sheet_names.get(&sheet).cloned().unwrap_or_else(|| sheet.to_string());
                                    format!("{}!{}", sheet_name, a1(row, col))
                                };
                                if *key == ON_SELECT_PROPERTY {
                                    // PHASE 4: inline code travels -- HELD and
                                    // stamped, never live. It runs only through
                                    // the button door, after the approval of
                                    // its exact bytes. Only STATIC code is
                                    // approvable; a formula is removed, named.
                                    if value_type == "static" {
                                        Some(from)
                                    } else {
                                        report.inline_removed.push(inline_removed_notice(&cell()));
                                        None
                                    }
                                } else if landed_macros.contains(&text) {
                                    Some(from)
                                } else {
                                    report.links_removed.push(link_removed_notice(&cell(), &text, &from.application));
                                    None
                                }
                            }
                        };
                        match hold_under {
                            Some(from) => {
                                let held = held_slot_of(key)
                                    .expect("every executable slot has a held slot");
                                props.insert(held.to_string(), static_value(&text));
                                if value_type != "static" {
                                    value_types.insert(key.to_string(), value_type);
                                }
                                if *key == MACRO_REF_PROPERTY {
                                    report.links_held += 1;
                                }
                                if *key == ON_SELECT_PROPERTY {
                                    report.inline_held += 1;
                                }
                                report.held += 1;
                                stamp_with = Some(from);
                            }
                            None => report.stripped += 1,
                        }
                    }
                    if let Some(from) = stamp_with {
                        let stamp = HeldFrom { value_types, ..from.clone() };
                        props.insert(HELD_FROM_PROPERTY.to_string(), static_value(&stamp.encode()));
                    }
                }
            }
            cloned
        })
        .collect();
    (admitted, report)
}

// ============================================================================
// Release (push)
// ============================================================================

/// One piece of button code a push restores, refuses or needs acknowledged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ButtonCodeItem {
    /// The APPLICATION sheet id (a working copy's ids are the application's).
    pub sheet_id: String,
    pub sheet_name: String,
    pub row: u32,
    pub col: u32,
    /// The anchor cell in A1 form, for a sentence ("Dashboard!B4").
    pub cell: String,
    /// `onSelect` or `macroRef`.
    pub slot: String,
    pub value_type: String,
    /// The code (`onSelect`) or the macro id (`macroRef`), exactly as it would ship.
    pub code: String,
    /// [`executable_value_hash`] of (`value_type`, `code`): what an
    /// acknowledgement names.
    pub hash: String,
    /// The application held code came with; empty for live code.
    #[serde(default)]
    pub application: String,
    /// Why it is refused, or why it needs review. Empty for restored code.
    #[serde(default)]
    pub reason: String,
}

impl ButtonCodeItem {
    fn locate(&self) -> String {
        format!("{} {}", self.cell, self.slot)
    }
}

/// What the release did to a publish carrier.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ButtonCodeRelease {
    /// Held code put back on the carrier: the signed base carries these bytes.
    pub restored: Vec<ButtonCodeItem>,
    /// Held code that cannot be published. Any entry REFUSES the push.
    pub refused: Vec<ButtonCodeItem>,
    /// Live code the signed base does not carry. The push must acknowledge each
    /// one by hash.
    pub unreviewed: Vec<ButtonCodeItem>,
    /// Held code a push leaves out because it is NOT a push of the application
    /// the workbook is a working copy of (a publish as a new application, a
    /// scripted publish): nothing is ever restored there, so the button goes
    /// out without the application's code -- named, never a refusal. A refusal
    /// here used to block every such push with a remedy that did not apply.
    #[serde(default)]
    pub withheld: Vec<ButtonCodeItem>,
}

impl ButtonCodeRelease {
    /// The push refusal for held code that cannot be published, or `None`.
    pub fn refusal(&self) -> Option<String> {
        if self.refused.is_empty() {
            return None;
        }
        let lines: Vec<String> = self
            .refused
            .iter()
            .map(|item| format!("{}: {}", item.locate(), item.reason))
            .collect();
        Some(format!(
            "CALP_PUSH_HELD_CODE_UNVERIFIED: {} button code slot(s) in this working copy \
             came with an application but cannot be published as that application's code -- \
             {}. Nothing was pushed. Open the application for editing again to take its \
             current button code, or replace the code on those buttons with your own \
             (the Properties pane for a button control, Insert > Cell Type > Button for a \
             button cell) and review it in the push.",
            self.refused.len(),
            lines.join("; ")
        ))
    }

    /// The push refusal for unreviewed code the request did not acknowledge.
    pub fn acknowledgement_refusal(&self, acknowledged: &[String]) -> Option<String> {
        let acked: HashSet<&str> = acknowledged.iter().map(String::as_str).collect();
        let missing: Vec<&ButtonCodeItem> = self
            .unreviewed
            .iter()
            .filter(|item| !acked.contains(item.hash.as_str()))
            .collect();
        if missing.is_empty() {
            return None;
        }
        let lines: Vec<String> = missing.iter().map(|item| item.locate()).collect();
        Some(format!(
            "CALP_PUSH_BUTTON_CODE_UNREVIEWED: this push would publish button code the \
             application's signed version does not have, at {}. Every subscriber runs a \
             button's code only after approving it, but it goes out under YOUR key: review \
             the code in the push dialog and tick it before pushing. Nothing was pushed.",
            lines.join(", ")
        ))
    }
}

/// THE PUSH'S GATE ON THE BUTTONS' CODE, with its trail. Refuses on held code
/// that cannot be proved to be the application's (`CALP_PUSH_HELD_CODE_UNVERIFIED`)
/// and on code the request did not acknowledge (`CALP_PUSH_BUTTON_CODE_UNREVIEWED`),
/// and records each refusal as an always-on `ButtonCodeRefused` row naming the
/// application and the cells ("every refusal of application code is written to
/// the audit trail"). A refusal is what a forged working copy PRODUCES, so it is
/// evidence -- it used to be a returned string and nothing else.
///
/// `acknowledged` is the push REQUEST's own list, which only the push dialog
/// fills, with the code on screen.
pub(crate) fn refuse_push_on_button_code(
    state: &crate::AppState,
    release: &ButtonCodeRelease,
    acknowledged: &[String],
    registry_path: &str,
    application: &str,
) -> Result<(), String> {
    if let Some(refusal) = release.refusal() {
        record_push_refusal(state, registry_path, application, "heldCodeUnverified", &release.refused);
        return Err(refusal);
    }
    if let Some(refusal) = release.acknowledgement_refusal(acknowledged) {
        let acked: HashSet<&str> = acknowledged.iter().map(String::as_str).collect();
        let missing: Vec<ButtonCodeItem> =
            release.unreviewed.iter().filter(|i| !acked.contains(i.hash.as_str())).cloned().collect();
        record_push_refusal(state, registry_path, application, "unreviewed", &missing);
        return Err(refusal);
    }
    Ok(())
}

// ============================================================================
// The push's gate on buttons whose macro it does not publish (M4)
// ============================================================================

/// Which kind of button runs the macro.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MacroLinkKind {
    /// A button CONTROL's `macroRef`.
    Control,
    /// A button CELL's `{kind: "script", scriptId}` action.
    Cell,
}

/// The remedy that WORKS for a button whose macro the push does not publish.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MacroLinkRemedy {
    /// The macro is the author's own and the application never had it: tick
    /// "Include in application" next to it in the push dialog.
    Include,
    /// The macro belongs to another application: a button here cannot run it.
    /// Unlink the button, or copy the macro into one of your own and include that.
    OtherApplication,
    /// No macro with this id can be published from this workbook: unlink the
    /// button, or restore the macro.
    Missing,
}

/// One button on a published sheet that runs a macro the push does not
/// publish, with the remedy that works. The push dialog shows these, and a
/// real push refuses while any remain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnshippedMacroLinkItem {
    /// The button's anchor, e.g. "Dashboard!B4".
    pub cell: String,
    pub kind: MacroLinkKind,
    /// The module-script id the button runs.
    pub macro_id: String,
    /// The macro's name, when this workbook holds it; empty otherwise.
    pub macro_name: String,
    pub remedy: MacroLinkRemedy,
    /// The application the macro belongs to, for `OtherApplication`.
    pub owner: String,
}

impl UnshippedMacroLinkItem {
    /// One clause of the refusal, naming the button, the macro and the remedy.
    fn sentence(&self) -> String {
        let button = match self.kind {
            MacroLinkKind::Control => format!("the button at {}", self.cell),
            MacroLinkKind::Cell => format!("the button cell at {}", self.cell),
        };
        let named = if self.macro_name.is_empty() || self.macro_name == self.macro_id {
            format!("'{}'", self.macro_id)
        } else {
            format!("\"{}\" ({})", self.macro_name, self.macro_id)
        };
        match self.remedy {
            MacroLinkRemedy::Include => format!(
                "{button} runs your macro {named}, which is not part of the application: tick Include \
                 in application next to it in the push dialog (it will be published under your key)"
            ),
            MacroLinkRemedy::OtherApplication => format!(
                "{button} runs {named}, which belongs to the application '{}'; a button in this \
                 application cannot run another application's macro -- unlink it, or copy the macro \
                 to your own and include the copy",
                if self.owner.is_empty() { "another application" } else { self.owner.as_str() }
            ),
            MacroLinkRemedy::Missing => format!(
                "{button} runs the macro {named}, and no macro with this id can be published from this \
                 workbook -- unlink the button, or restore the macro"
            ),
        }
    }
}

/// Every button on a published sheet of this CARRIER -- control or button
/// cell -- that runs a macro the push does not publish, each with its remedy.
///
/// "Publishes" means the carrier's module scripts AFTER the BUG-0261 filter
/// and the request's inclusions: exactly the set core publish writes. Links
/// are read off the RELEASED carrier (the held compartment already restored
/// or withheld), and the remedy is read off what the filter withheld: the
/// author's own includable macro, another application's, or neither. The one
/// classifier the push report and the push's refusal share.
pub(crate) fn unshipped_macro_links(
    assembly: &crate::calp_commands::PublishAssembly,
    sheet_indices: &[usize],
) -> Vec<UnshippedMacroLinkItem> {
    let shipped: HashSet<String> = assembly.workbook.scripts.iter().map(|s| s.id.clone()).collect();
    let sheet_names: HashMap<SheetId, String> =
        assembly.workbook.sheets.iter().map(|s| (s.id, s.name.clone())).collect();
    let controls = calp::publish::unshipped_macro_links(&assembly.workbook, sheet_indices, &shipped)
        .into_iter()
        .map(|link| (MacroLinkKind::Control, link));
    let cells = crate::button_cells::unshipped_cell_macro_links(&assembly.cell_type_objects, &sheet_names, &shipped)
        .into_iter()
        .map(|link| (MacroLinkKind::Cell, link));
    controls
        .chain(cells)
        .map(|(kind, link)| {
            let module = assembly.withheld.iter().find(|w| {
                w.kind == crate::calp_push_scope::WithheldKind::ModuleScript && w.id == link.macro_id
            });
            let (remedy, owner) = match module {
                Some(w) if w.reason == crate::calp_push_scope::WithheldReason::OtherApplication => {
                    (MacroLinkRemedy::OtherApplication, w.owner.clone())
                }
                Some(w) if w.includable => (MacroLinkRemedy::Include, String::new()),
                _ => (MacroLinkRemedy::Missing, String::new()),
            };
            UnshippedMacroLinkItem {
                cell: link.cell,
                kind,
                macro_name: module.map(|w| w.name.clone()).unwrap_or_default(),
                macro_id: link.macro_id,
                remedy,
                owner,
            }
        })
        .collect()
}

/// THE PUSH'S GATE on buttons that run a macro it does not publish, with its
/// trail. Every such button refuses the push by name with its remedy
/// (`CALP_PUSH_BUTTON_MACRO_NOT_SHIPPED`), and the refusal is an always-on
/// `ButtonCodeRefused` row (reason "unshippedMacro"). Runs in `calp_publish`
/// after the button-code gate, before core publish and before any effect.
pub(crate) fn refuse_push_on_unshipped_macros(
    state: &crate::AppState,
    assembly: &crate::calp_commands::PublishAssembly,
    sheet_indices: &[usize],
    registry_path: &str,
    application: &str,
) -> Result<(), String> {
    let links = unshipped_macro_links(assembly, sheet_indices);
    if links.is_empty() {
        return Ok(());
    }
    let rows: Vec<serde_json::Value> = links
        .iter()
        .map(|l| {
            serde_json::json!({
                "cell": l.cell,
                "kind": l.kind,
                "macroId": l.macro_id,
                "remedy": l.remedy,
                "owner": l.owner,
            })
        })
        .collect();
    let named: Vec<&str> = links.iter().map(|l| l.cell.as_str()).take(8).collect();
    let more = links.len().saturating_sub(named.len());
    record_push_gate_refusal(
        state,
        registry_path,
        application,
        "unshippedMacro",
        "cells",
        rows,
        format!(
            "Refused a push of '{application}': {} button(s) run a macro the push does not publish ({}{})",
            links.len(),
            named.join(", "),
            if more > 0 { format!(", +{more} more") } else { String::new() }
        ),
    );
    Err(format!(
        "CALP_PUSH_BUTTON_MACRO_NOT_SHIPPED: {} button(s) on the sheets this push publishes run a macro \
         it does not publish, so every subscriber would get a button that does nothing -- {}. Nothing \
         was pushed.",
        links.len(),
        links.iter().map(UnshippedMacroLinkItem::sentence).collect::<Vec<_>>().join("; ")
    ))
}

// ============================================================================
// The push's gate on what the author included (M4)
// ============================================================================

/// THE PUSH'S GATE on "Include in application": every item the request
/// includes must be on the carrier with the hash the push dialog showed. An
/// item edited since, now another application's, or gone refuses the push by
/// name (`CALP_PUSH_INCLUDED_CHANGED`) -- it would go out under the pusher's key
/// as code they never read, or silently not at all -- and leaves an always-on
/// `ButtonCodeRefused` row (reason "includedChanged"). Runs in `calp_publish`
/// right after the assembly, before core publish and before any effect.
pub(crate) fn refuse_push_on_changed_inclusion(
    state: &crate::AppState,
    assembly: &crate::calp_commands::PublishAssembly,
    requested: &[crate::calp_push_scope::IncludedItem],
    registry_path: &str,
    application: &str,
) -> Result<(), String> {
    let unhonoured = crate::calp_push_scope::unhonoured_inclusions(
        requested,
        &assembly.added_to_application,
        &assembly.withheld,
    );
    if unhonoured.is_empty() {
        return Ok(());
    }
    let rows: Vec<serde_json::Value> = unhonoured
        .iter()
        .map(|u| {
            serde_json::json!({
                "kind": u.item.kind,
                "id": u.item.id,
                "name": u.name,
                "hash": u.item.hash,
                "why": u.why,
            })
        })
        .collect();
    let lines: Vec<String> = unhonoured.iter().map(|u| format!("'{}': {}", u.name, u.why)).collect();
    record_push_gate_refusal(
        state,
        registry_path,
        application,
        "includedChanged",
        "items",
        rows,
        format!(
            "Refused a push of '{application}': {} item(s) included in the application are not what was \
             reviewed ({})",
            unhonoured.len(),
            unhonoured.iter().map(|u| u.name.as_str()).collect::<Vec<_>>().join(", ")
        ),
    );
    Err(format!(
        "CALP_PUSH_INCLUDED_CHANGED: {} item(s) you ticked \"Include in application\" for cannot be \
         published as you reviewed them -- {}. Nothing was pushed: what you add goes out under your key, \
         so it must be exactly what you read. Open the list in the push dialog again, read the code as \
         it is now, and tick it again.",
        unhonoured.len(),
        lines.join("; ")
    ))
}

/// One always-on `ButtonCodeRefused` row for a push gate, naming the door, the
/// application, the base version the working copy declares and what was
/// refused under `key`.
fn record_push_gate_refusal(
    state: &crate::AppState,
    registry_path: &str,
    application: &str,
    reason: &str,
    key: &str,
    rows: Vec<serde_json::Value>,
    description: String,
) {
    let base_version = state
        .working_copy_link
        .read()
        .ok()
        .and_then(|l| l.as_ref().filter(|l| l.targets(registry_path, application)).map(|l| l.base_version.clone()))
        .unwrap_or_default();
    let mut extra: HashMap<String, serde_json::Value> = HashMap::new();
    extra.insert("door".into(), serde_json::json!("push"));
    extra.insert("application".into(), serde_json::json!(application));
    extra.insert("registry".into(), serde_json::json!(registry_path));
    extra.insert("baseVersion".into(), serde_json::json!(base_version));
    extra.insert("reason".into(), serde_json::json!(reason));
    extra.insert(key.into(), serde_json::Value::Array(rows));
    crate::calp_commands::record_audit_event_with_extra(
        state,
        calp::audit::AuditEvent::ButtonCodeRefused,
        description,
        extra,
    );
}

fn record_push_refusal(
    state: &crate::AppState,
    registry_path: &str,
    application: &str,
    reason: &str,
    items: &[ButtonCodeItem],
) {
    let base_version = state
        .working_copy_link
        .read()
        .ok()
        .and_then(|l| l.as_ref().filter(|l| l.targets(registry_path, application)).map(|l| l.base_version.clone()))
        .unwrap_or_default();
    let cells: Vec<serde_json::Value> = items
        .iter()
        .map(|i| {
            serde_json::json!({
                "cell": i.cell,
                "slot": i.slot,
                "hash": i.hash,
                "application": i.application,
                "reason": i.reason,
            })
        })
        .collect();
    let mut extra: HashMap<String, serde_json::Value> = HashMap::new();
    extra.insert("door".into(), serde_json::json!("push"));
    extra.insert("application".into(), serde_json::json!(application));
    extra.insert("registry".into(), serde_json::json!(registry_path));
    extra.insert("baseVersion".into(), serde_json::json!(base_version));
    extra.insert("reason".into(), serde_json::json!(reason));
    extra.insert("cells".into(), serde_json::Value::Array(cells));
    let named: Vec<&str> = items.iter().map(|i| i.cell.as_str()).take(8).collect();
    let more = items.len().saturating_sub(named.len());
    let description = format!(
        "Refused a push of '{application}': {} button code slot(s) {} ({}{})",
        items.len(),
        if reason == "unreviewed" { "not acknowledged" } else { "could not be proved to be the application's" },
        named.join(", "),
        if more > 0 { format!(", +{more} more") } else { String::new() }
    );
    crate::calp_commands::record_audit_event_with_extra(
        state,
        calp::audit::AuditEvent::ButtonCodeRefused,
        description,
        extra,
    );
}

/// The application a push is FOR, when the workbook is its working copy.
pub struct HeldTarget {
    /// The push's workspace, as a pin-scope id.
    pub workspace: String,
    pub application: String,
    /// The working copy's base version (the version the push declares).
    pub base_version: String,
    /// The application sheets the base version carried.
    pub base_sheets: HashSet<SheetId>,
    /// [`executable_value_hash`] of every executable slot in the SIGNED base
    /// version's `controls.json`, or why it could not be read.
    pub base_code: Result<HashSet<String>, String>,
}

/// Every executable (valueType, value) in a control payload, hashed.
pub fn executable_hashes_in(controls: &[persistence::SavedSheetControls]) -> HashSet<String> {
    let mut out = HashSet::new();
    for sheet_controls in controls {
        let Some(entries) = sheet_controls.controls.as_array() else { continue };
        for entry in entries {
            let Some(props) = entry.get("properties").and_then(|p| p.as_object()) else { continue };
            for key in EXECUTABLE_CONTROL_PROPERTIES {
                let Some(slot) = props.get(*key) else { continue };
                let Some(text) = slot.get("value").and_then(|v| v.as_str()) else { continue };
                if text.is_empty() {
                    continue;
                }
                let value_type = slot.get("valueType").and_then(|v| v.as_str()).unwrap_or("static");
                out.insert(executable_value_hash(value_type, text));
            }
        }
    }
    out
}

/// Excel-style A1 for a 0-based (row, col).
pub(crate) fn a1(row: u32, col: u32) -> String {
    let mut letters = String::new();
    let mut c = col as i64;
    loop {
        letters.insert(0, (b'A' + (c % 26) as u8) as char);
        c = c / 26 - 1;
        if c < 0 {
            break;
        }
    }
    format!("{}{}", letters, row + 1)
}

/// Decide whether one held slot may go back live on the carrier. Shared with
/// button CELLS (`button_cells`), whose held action is judged by the same rule
/// against the signed base's button-cell actions.
pub(crate) fn judge_held(
    from: Option<&HeldFrom>,
    target: Option<&HeldTarget>,
    sheet: SheetId,
    value_type: &str,
    code: &str,
) -> Result<(), String> {
    let Some(from) = from else {
        return Err("its record of which application it came with is missing or unreadable".to_string());
    };
    let Some(target) = target else {
        return Err(format!(
            "it came with '{}', and this is not a push of '{}' from its working copy",
            from.application, from.application
        ));
    };
    if from.application != target.application || from.workspace != target.workspace {
        return Err(format!(
            "it came with '{}' from a different workspace or application than '{}'",
            from.application, target.application
        ));
    }
    match (
        calp::version::SemVer::parse(&from.version),
        calp::version::SemVer::parse(&target.base_version),
    ) {
        (Ok(held), Ok(base)) if held <= base => {}
        _ => {
            return Err(format!(
                "its record names v{}, which is not a version this working copy is based on (v{})",
                from.version, target.base_version
            ))
        }
    }
    if !target.base_sheets.contains(&sheet) {
        return Err("the sheet it sits on is not one of the application's sheets".to_string());
    }
    match &target.base_code {
        Err(why) => Err(format!(
            "the signed v{} could not be read to confirm it ({})",
            target.base_version, why
        )),
        Ok(known) if known.contains(&executable_value_hash(value_type, code)) => Ok(()),
        Ok(_) => Err(format!(
            "it does not match any button code in the signed v{} of '{}'",
            target.base_version, target.application
        )),
    }
}

/// Why held code a push that is NOT its working copy's leaves out.
pub(crate) fn not_this_working_copy(application: &str) -> String {
    let application = if application.is_empty() { "its application" } else { application };
    format!(
        "this is not a push of '{application}' from its working copy, so the button goes out \
         without that application's code (it stays held in this workbook)"
    )
}

/// Release the held compartment on a publish CARRIER.
///
/// Held keys are removed from EVERY control, published or not, so none can
/// reach `controls.json`. On a published sheet, each held slot whose live slot
/// is absent is restored when [`judge_held`] allows it and refused otherwise.
/// Without a `target` nothing is restored and nothing refused: the held code is
/// listed as `withheld`.
/// With a `target` (a push of the application the workbook is a working copy
/// of), live code the signed base does not carry is listed as unreviewed.
///
/// Pure over the carrier; never touches the live store.
pub fn release_held_code_for_publish(
    controls: &mut [persistence::SavedSheetControls],
    published: &HashSet<SheetId>,
    sheet_names: &HashMap<SheetId, String>,
    target: Option<&HeldTarget>,
) -> ButtonCodeRelease {
    let mut release = ButtonCodeRelease::default();
    for sheet_controls in controls.iter_mut() {
        let sheet = sheet_controls.sheet_id;
        let is_published = published.contains(&sheet);
        let sheet_name = sheet_names.get(&sheet).cloned().unwrap_or_else(|| sheet.to_string());
        let serde_json::Value::Array(entries) = &mut sheet_controls.controls else { continue };
        for entry in entries {
            let row = entry.get("row").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let col = entry.get("col").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let Some(props) = entry.get_mut("properties").and_then(|p| p.as_object_mut()) else {
                continue;
            };
            // ALWAYS, published or not: a held key never reaches a package.
            let stamp = props
                .remove(HELD_FROM_PROPERTY)
                .and_then(|v| v.get("value").and_then(|t| t.as_str()).map(str::to_string));
            let mut held: Vec<(&'static str, String)> = Vec::new();
            for (live_key, held_key) in EXECUTABLE_CONTROL_PROPERTIES.iter().zip(HELD_CODE_PROPERTIES) {
                if let Some(slot) = props.remove(*held_key) {
                    let text = slot.get("value").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    held.push((*live_key, text));
                }
            }
            if !is_published {
                continue;
            }
            let from = stamp.as_deref().and_then(HeldFrom::decode);
            let item = |slot: &str, value_type: &str, code: &str, application: &str, reason: String| {
                ButtonCodeItem {
                    sheet_id: sheet.to_string(),
                    sheet_name: sheet_name.clone(),
                    row,
                    col,
                    cell: format!("{}!{}", sheet_name, a1(row, col)),
                    slot: slot.to_string(),
                    value_type: value_type.to_string(),
                    code: code.to_string(),
                    hash: executable_value_hash(value_type, code),
                    application: application.to_string(),
                    reason,
                }
            };

            let mut restored: HashSet<&str> = HashSet::new();
            for (live_key, code) in &held {
                let live_key: &'static str = live_key;
                // The live slot wins: the author's own write releases the held
                // compartment, so both present means a file put them there, and
                // the live bytes are judged as live code below.
                if props.contains_key(live_key) {
                    continue;
                }
                let value_type = from.as_ref().map_or("static", |f| f.value_type_of(live_key)).to_string();
                let application = from.as_ref().map(|f| f.application.clone()).unwrap_or_default();
                // NOT A PUSH OF THE WORKING COPY'S APPLICATION: nothing goes
                // back, and the push says so by name instead of refusing.
                if target.is_none() {
                    release.withheld.push(item(
                        live_key,
                        &value_type,
                        code,
                        &application,
                        not_this_working_copy(&application),
                    ));
                    continue;
                }
                match judge_held(from.as_ref(), target, sheet, &value_type, code) {
                    Ok(()) => {
                        props.insert(
                            live_key.to_string(),
                            serde_json::json!({ "valueType": value_type, "value": code }),
                        );
                        restored.insert(live_key);
                        release.restored.push(item(live_key, &value_type, code, &application, String::new()));
                    }
                    Err(reason) => {
                        release.refused.push(item(live_key, &value_type, code, &application, reason));
                    }
                }
            }

            let Some(target) = target else { continue };
            for live_key in EXECUTABLE_CONTROL_PROPERTIES {
                if restored.contains(live_key) {
                    continue;
                }
                let Some(slot) = props.get(*live_key) else { continue };
                let Some(code) = slot.get("value").and_then(|v| v.as_str()) else { continue };
                if code.is_empty() {
                    continue;
                }
                let value_type = slot.get("valueType").and_then(|v| v.as_str()).unwrap_or("static");
                let reason = match &target.base_code {
                    Ok(known) if known.contains(&executable_value_hash(value_type, code)) => continue,
                    Ok(_) => format!(
                        "the signed v{} of '{}' does not have this code here or on any other button",
                        target.base_version, target.application
                    ),
                    Err(why) => format!(
                        "the signed v{} could not be read to compare it ({})",
                        target.base_version, why
                    ),
                };
                release.unreviewed.push(item(live_key, value_type, code, "", reason));
            }
        }
    }
    release
}

// ============================================================================
// The push's view of the workbook
// ============================================================================

/// Does any control on a published sheet carry code, live or held?
fn carries_code(controls: &[persistence::SavedSheetControls], published: &HashSet<SheetId>) -> bool {
    controls.iter().filter(|sc| published.contains(&sc.sheet_id)).any(|sc| {
        sc.controls.as_array().is_some_and(|entries| {
            entries.iter().any(|entry| {
                entry.get("properties").and_then(|p| p.as_object()).is_some_and(|props| {
                    HELD_CODE_PROPERTIES.iter().any(|k| props.contains_key(*k))
                        || EXECUTABLE_CONTROL_PROPERTIES.iter().any(|k| {
                            props
                                .get(*k)
                                .and_then(|s| s.get("value"))
                                .and_then(|v| v.as_str())
                                .is_some_and(|t| !t.is_empty())
                        })
                })
            })
        })
    })
}

/// The working copy's SIGNED base version, opened AT MOST ONCE per publish
/// assembly and shared by every reader that judges code against it -- button
/// controls (`signed_base_code`) and button cells
/// (`button_cells::signed_base_cell_actions`).
///
/// Opened through the AUTHORISED reader (BUG-0262), so a working-copy link that
/// names a planted base cannot launder code: its signer must be an authorised
/// publisher of the application, anchored at the root. The signature is
/// checked, but the per-artifact walk is NOT run here: each reader re-verifies
/// the one artifact it reads against the checksum the verified manifest
/// records ([`SignedBase::verified_artifact`]) -- the same guarantee for those
/// bytes, and also the one that refuses a file swapped after a walk. The two
/// readers used to open and walk the whole version each, data artifacts
/// included, on every preview and every push (review finding).
pub(crate) struct SignedBase {
    registry_path: String,
    package_name: String,
    opened: std::cell::OnceCell<(String, Result<OpenedBase, String>)>,
}

struct OpenedBase {
    registry: Box<dyn calp::transport::WorkspaceTransport>,
    version: String,
    manifest: calp::manifest::VersionManifest,
}

impl SignedBase {
    pub(crate) fn new(registry_path: &str, package_name: &str) -> Self {
        Self {
            registry_path: registry_path.to_string(),
            package_name: package_name.to_string(),
            opened: std::cell::OnceCell::new(),
        }
    }

    fn open(&self, base_version: &str) -> Result<&OpenedBase, String> {
        let (opened_as, opened) = self.opened.get_or_init(|| {
            let opened = crate::calp_inspector::open_authorized_content(
                &self.registry_path,
                &self.package_name,
                &format!("={}", base_version),
                false,
                None,
            )
            .map(|(registry, version, manifest)| OpenedBase { registry, version, manifest });
            (base_version.to_string(), opened)
        });
        if opened_as != base_version {
            return Err(format!(
                "the signed base was opened as v{opened_as}, and this reader asked for v{base_version}"
            ));
        }
        opened.as_ref().map_err(|e| e.clone())
    }

    /// The verified manifest of the signed base.
    pub(crate) fn manifest(&self, base_version: &str) -> Result<&calp::manifest::VersionManifest, String> {
        Ok(&self.open(base_version)?.manifest)
    }

    /// One artifact of the signed base, re-verified against the checksum its
    /// signed manifest records. `Ok(None)` when the manifest does not list it.
    pub(crate) fn verified_artifact(&self, base_version: &str, rel: &str) -> Result<Option<Vec<u8>>, String> {
        let base = self.open(base_version)?;
        let Some(expected) = base.manifest.artifact_checksums.get(rel) else {
            return Ok(None);
        };
        let bytes = base
            .registry
            .read_artifact(&self.package_name, &base.version, rel)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("its signed manifest lists {rel}, and the file is missing"))?;
        if calp::integrity::sha256_hex(&bytes) != *expected {
            return Err(format!("{rel} does not match the checksum its signed manifest records"));
        }
        Ok(Some(bytes))
    }
}

/// The executable code of the SIGNED base version, hashed -- read through
/// [`SignedBase`] (the authorised reader, the checksum re-verified).
pub(crate) fn signed_base_code(base: &SignedBase, base_version: &str) -> Result<HashSet<String>, String> {
    let Some(bytes) = base.verified_artifact(base_version, "controls.json")? else {
        // The signed base has no controls, so it has no button code.
        return Ok(HashSet::new());
    };
    let controls: Vec<persistence::SavedSheetControls> =
        serde_json::from_slice(&bytes).map_err(|e| format!("controls.json is unreadable: {e}"))?;
    Ok(executable_hashes_in(&controls))
}

/// Release the held compartment on `workbook` (a publish carrier) for a push of
/// `package_name` to `registry_path`, publishing `sheet_indices`.
///
/// The ONE call `assemble_publish_workbook` makes, so the publish, the dry-run
/// preview and the working-copy diff release identically. Reads the signed base
/// (through `base`, shared with the button cells' release) only when the push
/// is a working-copy push AND a published control carries code.
pub(crate) fn release_for_push(
    state: &crate::AppState,
    workbook: &mut persistence::Workbook,
    sheet_indices: &[usize],
    registry_path: &str,
    package_name: &str,
    base: &SignedBase,
) -> Result<ButtonCodeRelease, String> {
    let published: HashSet<SheetId> = sheet_indices
        .iter()
        .filter_map(|&i| workbook.sheets.get(i).map(|s| s.id))
        .collect();
    let sheet_names: HashMap<SheetId, String> =
        workbook.sheets.iter().map(|s| (s.id, s.name.clone())).collect();
    let link: Option<calp::WorkingCopyLink> =
        state.working_copy_link.read().map_err(|e| e.to_string())?.clone();
    let target = match link.as_ref().filter(|l| l.targets(registry_path, package_name)) {
        Some(link) => {
            let base_code = if carries_code(&workbook.controls, &published) {
                signed_base_code(base, &link.base_version)
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
    Ok(release_held_code_for_publish(
        &mut workbook.controls,
        &published,
        &sheet_names,
        target.as_ref(),
    ))
}

#[cfg(test)]
#[path = "held_button_code_tests.rs"]
mod tests;
