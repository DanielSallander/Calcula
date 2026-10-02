//! FILENAME: core/calp/src/code_summary.rs
//! PURPOSE: What CODE changes between the version an environment points at and
//! the version a promotion would point it at -- and, for each change, what it
//! means for that environment's subscribers.
//! CONTEXT: plan_M8 Task B (BUG-0257 phase 5). The Promote dialog showed the
//! whole version diff, where a changed macro sat among cell edits; a FIRST
//! promotion showed nothing at all; custom functions diffed as one raw JSON
//! module, notebooks without their sources, and a changed writeback validator
//! not at all (`diff_writeback_declarations` compares regions by id). The
//! promoter decides what code every subscriber of an environment receives, so
//! this is the list they decide on, read before anything else.
//!
//! # What it reads
//!
//! Only CODE, and only the way a subscriber's pull reads it -- MANIFEST-DRIVEN:
//! the modules, object scripts and notebooks the signed manifest lists, the
//! button controls in `controls.json` (the only controls artifact a pull
//! reads), the `cellType` custom objects that hold button cells, and the
//! writeback regions' validators (which live in the manifest, not in an
//! artifact). No sheet data, chart, model or media artifact is ever read, so a
//! summary of a large application is a handful of small reads -- and through a
//! [`DiffSide::PublishedChecked`] side every one of them is checked against the
//! signed checksum map.
//!
//! # What it predicts, and what it cannot know
//!
//! An approval is keyed by the HASH of the code it approves
//! (`consent_granted_in` in the app): a macro, an object script and a button's
//! inline code by `(id, sha256(bytes))` in the application's own record, a
//! notebook per cell, the custom functions as ONE approval over the
//! application's whole set (`custom-functions:<application>`), a button
//! command under `button-commands:<application>`, a writeback validator under
//! `<application>::writeback-validators`. So code that is new or changed asks
//! everyone again -- unless the very same approval is already part of the
//! version the environment holds (a button whose code moved, a second button
//! with the same code). It cannot see a subscriber's own id collisions, a local
//! copy, or an earlier Deny: it is a prediction from the two versions, and the
//! sentences built on it say so.
//!
//! # Two of a thing under one key
//!
//! Publish never writes a version with two modules under one id, or two
//! controls at one cell; a hand-built version signed by an authorised developer
//! can, and nothing at pull refuses it. So the summary settles each such pair
//! the way the subscriber's materializer does (`later_entry_wins`) -- the row
//! with the plain id shows the code subscribers actually receive -- and lists
//! the other one too, under `<id>#duplicate-<n>`, as code that never runs. A
//! promotion review must not be able to show the benign body while every
//! subscriber receives the other.
//!
//! The rules mirror the app's admission (`held_button_code::admit_wiring`,
//! `button_cells::admit_button_cells`), its button door
//! (`control_action::decide_control`) and the subscribe refusal of reserved
//! ids (`calp_commands::refuse_reserved_distributed_script_ids`). The constants
//! below are pinned to the app's own by a host test
//! (`calp_environments_tests::the_code_summary_mirrors_the_apps_constants`).

use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::diff::{a1_of, truncate, DiffOptions, DiffSide};
use crate::error::CalpError;
use crate::manifest::VersionManifest;

// ---------------------------------------------------------------------------
// Mirrored constants (pinned to the app's by a host test)
// ---------------------------------------------------------------------------

/// The reserved module id the Custom Functions library is published under
/// (`calp_push_scope::CUSTOM_FUNCTIONS_LIB_ID`).
pub const CUSTOM_FUNCTIONS_LIB_ID: &str = "__calcula_custom_functions__";
/// Calcula's reserved script-id namespace (`scripting::commands::RESERVED_SCRIPT_PREFIX`).
pub const RESERVED_SCRIPT_PREFIX: &str = "__calcula_";
/// The namespace of button-code approvals (`control_action::BUTTON_ACTION_CONSENT_PREFIX`).
pub const BUTTON_ACTION_PREFIX: &str = "buttonAction:";
/// A button control's inline code slot (`controls::ON_SELECT_PROPERTY`).
pub const ON_SELECT_SLOT: &str = "onSelect";
/// A button control's macro-link slot (`controls::MACRO_REF_PROPERTY`).
pub const MACRO_REF_SLOT: &str = "macroRef";
/// The held twins a package must never carry (`controls::HELD_CODE_PROPERTIES`).
pub const HELD_CONTROL_CODE_SLOTS: &[&str] = &["heldOnSelect", "heldMacroRef"];
/// The custom-object kind button cells publish under.
pub const CELL_TYPE_OBJECT_KIND: &str = "cellType";
/// The button cell type (`button_cells::BUTTON_CELL_TYPE_ID`).
pub const BUTTON_CELL_TYPE_ID: &str = "calcula.button";
/// A button cell's live action (`button_cells::ACTION_PARAM`).
pub const CELL_ACTION_PARAM: &str = "action";
/// A button cell's held action, which a package must never carry
/// (`button_cells::HELD_ACTION_PARAM`).
pub const CELL_HELD_ACTION_PARAM: &str = "heldAction";

/// What marks the row of an entry a version carries under a key ANOTHER entry
/// already holds (`mod-a#duplicate-1`): the live entry keeps the plain id.
pub const DUPLICATE_ID_MARK: &str = "#duplicate-";

/// The approval id of one button control's inline code
/// (`control_action::button_action_consent_id`).
pub fn button_action_approval_id(code: &str) -> String {
    format!("{BUTTON_ACTION_PREFIX}{}", crate::integrity::sha256_hex(code.as_bytes()))
}

/// The approval id of one notebook cell (`notebook_commands::notebook_consent_script_id`).
pub fn notebook_cell_approval_id(notebook_id: &str, cell_id: &str) -> String {
    format!("notebook:{notebook_id}:{cell_id}")
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/// What kind of code a row is about. The wire value is the camelCase variant
/// name; the Promote dialog keys its labels by it (a drift test reads this
/// enum).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodeKind {
    /// A module script (a macro).
    Macro,
    /// A script attached to an object.
    ObjectScript,
    /// One function of the application's custom-function library.
    CustomFunction,
    /// A notebook (its cells' sources).
    Notebook,
    /// A button CONTROL's inline code or macro link.
    ButtonCode,
    /// A button CELL's action.
    ButtonCellAction,
    /// A writeback region's custom validator.
    WritebackValidator,
    /// A script under an id Calcula reserves: subscribers refuse the version.
    ReservedScript,
}

impl CodeKind {
    pub const ALL: [CodeKind; 8] = [
        CodeKind::Macro,
        CodeKind::ObjectScript,
        CodeKind::CustomFunction,
        CodeKind::Notebook,
        CodeKind::ButtonCode,
        CodeKind::ButtonCellAction,
        CodeKind::WritebackValidator,
        CodeKind::ReservedScript,
    ];
}

/// What happened to the piece of code between the two versions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodeChangeKind {
    Added,
    Removed,
    Modified,
    /// Only for a [`CodeKind::ReservedScript`]: it blocks the target version
    /// whether or not it changed, so it is listed either way.
    Unchanged,
}

impl CodeChangeKind {
    pub const ALL: [CodeChangeKind; 4] = [
        CodeChangeKind::Added,
        CodeChangeKind::Removed,
        CodeChangeKind::Modified,
        CodeChangeKind::Unchanged,
    ];
}

/// What the change means for the environment's subscribers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SubscriberConsequence {
    /// New or changed code: everyone is asked to approve it before it runs.
    AsksApprovalAgain,
    /// Runs once approved, and asks nothing new of its own: a link to a
    /// macro, a button cell's script action, or code whose exact approval is
    /// already part of the version the environment holds.
    RunsAfterApproval,
    /// Removed: it no longer runs for anyone.
    StopsRunning,
    /// The subscriber's admission removes it on arrival.
    RemovedOnArrival,
    /// It arrives but nothing ever runs it (or it never ran: a removal of
    /// code that never reached subscribers).
    NeverRuns,
    /// Subscribers cannot take the target version at all.
    RefusesVersion,
    /// Every submit to the writeback region it guards is refused.
    BlocksSubmit,
}

impl SubscriberConsequence {
    pub const ALL: [SubscriberConsequence; 7] = [
        SubscriberConsequence::AsksApprovalAgain,
        SubscriberConsequence::RunsAfterApproval,
        SubscriberConsequence::StopsRunning,
        SubscriberConsequence::RemovedOnArrival,
        SubscriberConsequence::NeverRuns,
        SubscriberConsequence::RefusesVersion,
        SubscriberConsequence::BlocksSubmit,
    ];
}

/// One piece of code that changes, named the way a person would name it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeChange {
    pub kind: CodeKind,
    /// Stable within its kind: a script id, a function name, a button's
    /// `sheetId!A1:slot`, a writeback region id.
    pub id: String,
    pub name: String,
    pub sheet_name: Option<String>,
    pub change: CodeChangeKind,
    /// One line on THIS item: what it links, why it will not run, which
    /// approval it reuses.
    pub detail: String,
    pub consequence: SubscriberConsequence,
    /// The code before and after, capped at `DiffOptions::max_source_bytes`.
    pub before: Option<String>,
    pub after: Option<String>,
    pub before_truncated: bool,
    pub after_truncated: bool,
    /// Capabilities an object script gains, from the SIGNED manifest's
    /// declaration (the ceiling a subscriber's pull applies, never the source).
    pub added_capabilities: Vec<String>,
}

/// The code changes of one promotion.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeSummary {
    pub changes: Vec<CodeChange>,
    /// Whether any subscriber who approved this application's code will be
    /// asked to approve again before (some of) it runs.
    pub asks_approval_again: bool,
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/// The code summary between `from` (the version the environment holds; `None`
/// for a FIRST promotion, where every piece of code of `to` is new) and `to`.
///
/// `allowed_button_commands` is the app's `DISTRIBUTABLE_BUTTON_COMMANDS`: a
/// button cell's command survives the subscriber's admission only when it is
/// on that list.
pub fn code_summary(
    from: Option<&DiffSide>,
    to: &DiffSide,
    opts: &DiffOptions,
    allowed_button_commands: &[&str],
) -> Result<CodeSummary, CalpError> {
    let before = match from {
        Some(side) => inventory(side, allowed_button_commands)?,
        None => BTreeMap::new(),
    };
    let after = inventory(to, allowed_button_commands)?;

    // The approvals subscribers of the environment were already asked for.
    let approved_before: HashSet<Approval> = before
        .values()
        .flat_map(|item| match &item.status {
            Status::Approve(list) => list.clone(),
            _ => Vec::new(),
        })
        .collect();

    let keys: BTreeSet<&(CodeKind, String)> = before.keys().chain(after.keys()).collect();
    let mut changes: Vec<CodeChange> = Vec::new();
    for key in keys {
        match (before.get(key), after.get(key)) {
            (None, Some(a)) => changes.push(row(CodeChangeKind::Added, None, Some(a), &approved_before, opts)),
            (Some(b), None) => {
                // A reserved script leaving the target unblocks it: nothing a
                // subscriber had stops, so it is not a row.
                if b.kind != CodeKind::ReservedScript {
                    changes.push(row(CodeChangeKind::Removed, Some(b), None, &approved_before, opts));
                }
            }
            (Some(b), Some(a)) if b.fingerprint != a.fingerprint => {
                changes.push(row(CodeChangeKind::Modified, Some(b), Some(a), &approved_before, opts))
            }
            (Some(b), Some(a)) if a.kind == CodeKind::ReservedScript => {
                changes.push(row(CodeChangeKind::Unchanged, Some(b), Some(a), &approved_before, opts))
            }
            _ => {}
        }
    }

    // THE CUSTOM FUNCTIONS ARE ONE APPROVAL. Their consent source covers the
    // application's whole set (`customFunctionConsentSource` in the app), so a
    // removal re-asks for the functions that remain, too.
    let functions_remain = after.values().any(|i| matches!(i.status, Status::FunctionSet));
    let function_set_changed = changes.iter().any(|c| c.kind == CodeKind::CustomFunction);
    if function_set_changed && functions_remain {
        for c in changes.iter_mut() {
            if c.kind == CodeKind::CustomFunction && c.change == CodeChangeKind::Removed {
                c.detail = join(&c.detail, "the application's remaining custom functions are asked for again");
            }
        }
    }

    let asks_approval_again = changes
        .iter()
        .any(|c| c.consequence == SubscriberConsequence::AsksApprovalAgain)
        || (function_set_changed && functions_remain);

    changes.sort_by(|a, b| {
        a.kind
            .cmp(&b.kind)
            .then(a.sheet_name.cmp(&b.sheet_name))
            .then(a.name.cmp(&b.name))
            .then(a.id.cmp(&b.id))
    });
    Ok(CodeSummary { changes, asks_approval_again })
}

// ---------------------------------------------------------------------------
// The inventory of one side
// ---------------------------------------------------------------------------

/// One approval a subscriber gives: (record namespace, artifact id, hash).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct Approval {
    namespace: &'static str,
    id: String,
    hash: String,
}

/// What happens to one piece of code when a subscriber's pull brings it in.
#[derive(Debug, Clone, PartialEq)]
enum Status {
    /// Runs only after these exact approvals (one per notebook cell).
    Approve(Vec<Approval>),
    /// One function of the custom-function set: one approval over the whole set.
    FunctionSet,
    /// Runs after the approval of OTHER code; the sentence says which.
    RunsAfter(String),
    RemovedOnArrival(String),
    NeverRuns(String),
    RefusesVersion(String),
    BlocksSubmit(String),
}

impl Status {
    /// The class a change compares (with the code): the same bytes that stop
    /// arriving, or start running, are a change for subscribers.
    fn class(&self) -> &'static str {
        match self {
            Status::Approve(_) => "approve",
            Status::FunctionSet => "functionSet",
            Status::RunsAfter(_) => "runsAfter",
            Status::RemovedOnArrival(_) => "removedOnArrival",
            Status::NeverRuns(_) => "neverRuns",
            Status::RefusesVersion(_) => "refusesVersion",
            Status::BlocksSubmit(_) => "blocksSubmit",
        }
    }

    /// Did this code ever run for a subscriber who approved it?
    fn runs(&self) -> bool {
        matches!(self, Status::Approve(_) | Status::FunctionSet | Status::RunsAfter(_))
    }
}

/// One piece of code on one side.
#[derive(Debug, Clone)]
struct Item {
    kind: CodeKind,
    id: String,
    name: String,
    sheet_name: Option<String>,
    /// What the row shows as before/after.
    shown: String,
    /// What a change compares: the code, plus the status class.
    fingerprint: String,
    status: Status,
    capabilities: Vec<String>,
    /// A fragment describing the item itself ("runs on the workbook").
    describe: String,
}

type Inventory = BTreeMap<(CodeKind, String), Item>;

fn sha256(text: &str) -> String {
    crate::integrity::sha256_hex(text.as_bytes())
}

fn join(a: &str, b: &str) -> String {
    match (a.is_empty(), b.is_empty()) {
        (true, _) => b.to_string(),
        (_, true) => a.to_string(),
        _ => format!("{a}; {b}"),
    }
}

/// The id falls in a namespace a subscriber's pull refuses for this kind of
/// script (`refuse_reserved_distributed_script_ids`).
fn reserved_reason(kind: CodeKind, id: &str) -> Option<String> {
    if id.starts_with(BUTTON_ACTION_PREFIX) {
        return Some(format!(
            "its id starts with '{BUTTON_ACTION_PREFIX}', the namespace of button-code approvals, so \
             subscribers refuse the whole version"
        ));
    }
    let internal = match kind {
        CodeKind::Macro => id.starts_with(RESERVED_SCRIPT_PREFIX) && id != CUSTOM_FUNCTIONS_LIB_ID,
        CodeKind::Notebook => id.starts_with(RESERVED_SCRIPT_PREFIX),
        _ => false,
    };
    internal.then(|| {
        format!(
            "its id starts with '{RESERVED_SCRIPT_PREFIX}', which Calcula reserves for its own records, \
             so subscribers refuse the whole version"
        )
    })
}

/// Which of two entries a version carries under ONE key a subscriber's pull
/// keeps -- the summary must show THAT one as the code subscribers get.
///
/// * The LAST: `materialize_distributed_scripts` inserts a module or a notebook
///   by the id in its FILE, and an entry of the same application is no
///   conflict, so a later one overwrites an earlier one; controls and cell types
///   land by CELL (`materialize_saved_controls`, `materialize_saved_cell_types`
///   insert), so the last entry at a cell stands (the button passes settle
///   that per cell before anything reaches `put`).
/// * The FIRST: an object script whose id is already present is skipped
///   (`materialize_pull_result`); a custom function whose name is taken is not
///   applied (`merge_custom_function_library`); a submit finds the first region
///   with its id; a reserved id refuses the version either way.
fn later_entry_wins(kind: CodeKind) -> bool {
    match kind {
        CodeKind::Macro | CodeKind::Notebook | CodeKind::ButtonCode | CodeKind::ButtonCellAction => true,
        CodeKind::ObjectScript | CodeKind::CustomFunction | CodeKind::WritebackValidator | CodeKind::ReservedScript => {
            false
        }
    }
}

/// The row of an entry another entry under the same key displaces: listed, so
/// a version cannot hide a body behind a benign one, but asking nothing -- it
/// never reaches a subscriber (or, for a region, never runs).
fn displaced(mut item: Item, n: usize, why: &str) -> Item {
    item.id = format!("{}{DUPLICATE_ID_MARK}{n}", item.id);
    item.fingerprint = format!("{}\0displaced", item.fingerprint);
    item.status = Status::NeverRuns(why.to_string());
    item.capabilities = Vec::new();
    item.describe = String::new();
    item
}

/// The live entry of a key that has others: it says so.
fn noted_as_live(mut item: Item) -> Item {
    const NOTE: &str = "this version carries more than one entry under this id, and subscribers receive this one";
    if !item.describe.contains(NOTE) {
        item.describe = join(&item.describe, NOTE);
    }
    item
}

fn inventory(side: &DiffSide, allowed_button_commands: &[&str]) -> Result<Inventory, CalpError> {
    let manifest = side.manifest();
    let mut items: Inventory = BTreeMap::new();
    let mut displaced_count: BTreeMap<(CodeKind, String), usize> = BTreeMap::new();
    // NEVER A SILENT DROP. A second entry under a key keeps (or loses) its place
    // the way the subscriber's materializer settles it, and the one that loses
    // is still a row.
    let mut put = |item: Item| {
        let key = (item.kind, item.id.clone());
        let Some(standing) = items.remove(&key) else {
            items.insert(key, item);
            return;
        };
        if item.kind == CodeKind::ReservedScript {
            // Either one refuses the whole version; one row says so.
            items.insert(key, standing);
            return;
        }
        let later_wins = later_entry_wins(item.kind);
        let (live, other) = if later_wins { (item, standing) } else { (standing, item) };
        let n = displaced_count.entry(key.clone()).or_insert(0);
        *n += 1;
        let why = if later_wins {
            "a later entry in this version has the same id and replaces this one, so subscribers never receive it"
        } else {
            "an earlier entry in this version has the same id and is the one subscribers use, so this one never runs"
        };
        let other = displaced(other, *n, why);
        items.insert((other.kind, other.id.clone()), other);
        items.insert(key, noted_as_live(live));
    };

    // The macros a link or a button cell's script action can reach: the ids of
    // the modules THIS version lands for the application -- the ids in their
    // FILES, which is what a subscriber's materializer applies
    // (`landed_macros: applied_module_ids`), never the manifest's listing.
    let shipped_macros = modules(side, manifest, &mut put)?;
    object_scripts(side, manifest, &mut put)?;
    notebooks(side, manifest, &mut put)?;
    button_controls(side, manifest, &shipped_macros, &mut put)?;
    button_cells(side, manifest, &shipped_macros, allowed_button_commands, &mut put)?;
    writeback_validators(manifest, &mut put);
    Ok(items)
}

/// A sheet id as a subscriber's materializer resolves it: parsed, so two
/// spellings of one sheet are one sheet.
fn canonical_sheet(raw: &str) -> String {
    identity::SheetId::parse(raw).map(|s| s.to_string()).unwrap_or_else(|| raw.to_string())
}

fn sheet_name_of(manifest: &VersionManifest, sheet_id: &str) -> Option<String> {
    manifest
        .sheets
        .iter()
        .find(|s| s.sheet_id.to_string() == sheet_id)
        .map(|s| s.name.clone())
}

fn read_json(side: &DiffSide, rel: &str) -> Result<Option<Result<Value, String>>, CalpError> {
    Ok(side.read(rel)?.map(|bytes| serde_json::from_slice::<Value>(&bytes).map_err(|e| e.to_string())))
}

/// An artifact the pull would fail to parse: subscribers cannot take the version.
fn unreadable(kind: CodeKind, id: &str, name: &str, why: &str) -> Item {
    Item {
        kind,
        id: id.to_string(),
        name: name.to_string(),
        sheet_name: None,
        shown: String::new(),
        fingerprint: format!("unreadable\0{why}"),
        status: Status::RefusesVersion(format!(
            "its file cannot be read ({why}), so subscribers cannot take this version"
        )),
        capabilities: Vec::new(),
        describe: String::new(),
    }
}

fn reserved(id: &str, name: &str, source: String, reason: String) -> Item {
    Item {
        kind: CodeKind::ReservedScript,
        id: id.to_string(),
        name: name.to_string(),
        sheet_name: None,
        fingerprint: source.clone(),
        shown: source,
        status: Status::RefusesVersion(reason),
        capabilities: Vec::new(),
        describe: String::new(),
    }
}

/// The module scripts; returns the ids of the macros they land (the ids in the
/// FILES, reserved ones and the function library excluded).
fn modules(
    side: &DiffSide,
    manifest: &VersionManifest,
    put: &mut impl FnMut(Item),
) -> Result<HashSet<String>, CalpError> {
    let mut landed: HashSet<String> = HashSet::new();
    let mut function_libraries = 0usize;
    for listed in &manifest.module_scripts {
        let rel = format!("modules/{}.json", listed.id);
        let Some(parsed) = read_json(side, &rel)? else { continue };
        let def = parsed.and_then(|v| {
            serde_json::from_value::<calcula_format::features::scripts::ScriptDef>(v).map_err(|e| e.to_string())
        });
        let def = match def {
            Ok(def) => def,
            Err(why) => {
                put(unreadable(CodeKind::Macro, &listed.id, &listed.name, &why));
                continue;
            }
        };
        if def.id == CUSTOM_FUNCTIONS_LIB_ID {
            // A pull merges the FIRST library it finds
            // (`materialize_distributed_scripts`: `.find(..)`); any other one is
            // listed whole, and none of its functions are claimed.
            if function_libraries == 0 {
                custom_functions(&def.source, put);
            } else {
                put(Item {
                    kind: CodeKind::CustomFunction,
                    id: format!("{CUSTOM_FUNCTIONS_LIB_ID}{DUPLICATE_ID_MARK}{function_libraries}"),
                    name: "Custom functions (a second library)".to_string(),
                    sheet_name: None,
                    fingerprint: format!("{}\0displaced", def.source),
                    shown: def.source.clone(),
                    status: Status::NeverRuns(
                        "this version carries another custom-function library before this one, and subscribers \
                         take only the first, so none of these functions arrive"
                            .to_string(),
                    ),
                    capabilities: Vec::new(),
                    describe: String::new(),
                });
            }
            function_libraries += 1;
            continue;
        }
        if let Some(reason) = reserved_reason(CodeKind::Macro, &def.id) {
            put(reserved(&def.id, &def.name, def.source.clone(), reason));
            continue;
        }
        let sheet_name = match &def.scope {
            calcula_format::features::scripts::ScriptScopeDef::Sheet { name } => Some(name.clone()),
            calcula_format::features::scripts::ScriptScopeDef::Workbook => None,
        };
        landed.insert(def.id.clone());
        put(Item {
            kind: CodeKind::Macro,
            id: def.id.clone(),
            name: def.name.clone(),
            sheet_name,
            fingerprint: def.source.clone(),
            status: Status::Approve(vec![Approval {
                namespace: "",
                id: def.id.clone(),
                hash: sha256(&def.source),
            }]),
            shown: def.source,
            capabilities: Vec::new(),
            describe: String::new(),
        });
    }
    Ok(landed)
}

fn object_scripts(side: &DiffSide, manifest: &VersionManifest, put: &mut impl FnMut(Item)) -> Result<(), CalpError> {
    for listed in &manifest.object_scripts {
        let rel = format!("object_scripts/{}.json", listed.id);
        let Some(parsed) = read_json(side, &rel)? else { continue };
        let def = parsed.and_then(|v| {
            serde_json::from_value::<calcula_format::features::object_scripts::ObjectScriptDef>(v)
                .map_err(|e| e.to_string())
        });
        let def = match def {
            Ok(def) => def,
            Err(why) => {
                put(unreadable(CodeKind::ObjectScript, &listed.id, &listed.name, &why));
                continue;
            }
        };
        if let Some(reason) = reserved_reason(CodeKind::ObjectScript, &def.id) {
            put(reserved(&def.id, &def.name, def.source.clone(), reason));
            continue;
        }
        // THE CEILING IS THE MANIFEST'S: a subscriber's pull sets a distributed
        // script's capabilities from the signed declaration, never from the
        // (tamperable) source (`pull.rs`, R19). Read the one way the version
        // diff reads it too.
        let capabilities = listed.capability_ceiling();
        let runs_on = match &listed.instance_id {
            Some(instance) if !instance.is_empty() => format!("runs on {} {instance}", listed.object_type),
            _ => format!("runs on the {}", listed.object_type),
        };
        put(Item {
            kind: CodeKind::ObjectScript,
            id: def.id.clone(),
            name: def.name.clone(),
            sheet_name: None,
            fingerprint: format!("{}\0{}\0{}", def.source, capabilities.join(","), runs_on),
            status: Status::Approve(vec![Approval {
                namespace: "",
                id: def.id.clone(),
                hash: sha256(&def.source),
            }]),
            shown: def.source,
            capabilities,
            describe: runs_on,
        });
    }
    Ok(())
}

fn notebooks(side: &DiffSide, manifest: &VersionManifest, put: &mut impl FnMut(Item)) -> Result<(), CalpError> {
    for listed in &manifest.notebooks {
        let rel = format!("notebooks/{}.json", listed.id);
        let Some(parsed) = read_json(side, &rel)? else { continue };
        let def = parsed.and_then(|v| {
            serde_json::from_value::<calcula_format::features::notebooks::NotebookDef>(v).map_err(|e| e.to_string())
        });
        let def = match def {
            Ok(def) => def,
            Err(why) => {
                put(unreadable(CodeKind::Notebook, &listed.id, &listed.name, &why));
                continue;
            }
        };
        // The cells' sources, in order: what the notebook RUNS.
        let shown: String = def
            .cells
            .iter()
            .map(|c| format!("// cell {}\n{}\n", c.id, c.source))
            .collect();
        if let Some(reason) = reserved_reason(CodeKind::Notebook, &def.id) {
            put(reserved(&def.id, &def.name, shown, reason));
            continue;
        }
        // One approval per CELL (`notebook_consent_script_id`).
        let approvals: Vec<Approval> = def
            .cells
            .iter()
            .map(|c| Approval {
                namespace: "",
                id: notebook_cell_approval_id(&def.id, &c.id),
                hash: sha256(&c.source),
            })
            .collect();
        let status = if approvals.is_empty() {
            Status::NeverRuns("it has no cells".to_string())
        } else {
            Status::Approve(approvals)
        };
        put(Item {
            kind: CodeKind::Notebook,
            id: def.id.clone(),
            name: def.name.clone(),
            sheet_name: None,
            fingerprint: shown.clone(),
            describe: format!("{} cell(s)", def.cells.len()),
            shown,
            status,
            capabilities: Vec::new(),
        });
    }
    Ok(())
}

/// The app's rule for a function name a merge accepts
/// (`merge_custom_function_library::is_valid_function_name`).
fn is_valid_function_name(name: &str) -> bool {
    let up = name.trim().to_uppercase();
    let mut chars = up.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '$' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

/// THE CUSTOM FUNCTIONS, ONE ROW PER FUNCTION. The library is one JSON module
/// (`api/customFunctions.ts`: `functions[].name/params/body`, `capabilities`);
/// a subscriber's merge takes it apart by name, so the summary does too. A
/// library this cannot read as functions is ONE row with the whole text,
/// rather than none.
fn custom_functions(source: &str, put: &mut impl FnMut(Item)) {
    let parsed: Option<Vec<Value>> = serde_json::from_str::<Value>(source)
        .ok()
        .and_then(|v| v.get("functions").and_then(|f| f.as_array()).cloned());
    let Some(functions) = parsed else {
        put(Item {
            kind: CodeKind::CustomFunction,
            id: CUSTOM_FUNCTIONS_LIB_ID.to_string(),
            name: "Custom functions".to_string(),
            sheet_name: None,
            shown: source.to_string(),
            fingerprint: source.to_string(),
            status: Status::FunctionSet,
            capabilities: Vec::new(),
            describe: "the library could not be read as functions, so it is shown whole".to_string(),
        });
        return;
    };
    for f in functions {
        let Some(raw_name) = f.get("name").and_then(|n| n.as_str()) else { continue };
        let name = raw_name.trim().to_uppercase();
        let params: Vec<String> = f
            .get("params")
            .and_then(|p| p.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        let body = f.get("body").and_then(|b| b.as_str()).unwrap_or("");
        let description = f.get("description").and_then(|d| d.as_str()).unwrap_or("");
        let volatile = f.get("volatile").and_then(|v| v.as_bool()).unwrap_or(false);
        let signature = format!("{name}({})", params.join(", "));
        let mut shown = format!("function {signature} {{\n{body}\n}}");
        if !description.is_empty() {
            shown = format!("// {description}\n{shown}");
        }
        if volatile {
            shown = format!("// volatile\n{shown}");
        }
        // What the approval is over (`canonicalFunction` in the app): the name,
        // the parameters, the body, the description and the volatile flag.
        let fingerprint = serde_json::json!({
            "name": name, "params": params, "body": body, "description": description, "volatile": volatile,
        })
        .to_string();
        let status = if is_valid_function_name(raw_name) {
            Status::FunctionSet
        } else {
            Status::RemovedOnArrival(
                "its name is not a valid function name, so subscribers do not receive it".to_string(),
            )
        };
        put(Item {
            kind: CodeKind::CustomFunction,
            id: name.clone(),
            name: signature,
            sheet_name: None,
            fingerprint: format!("{fingerprint}\0{}", status.class()),
            shown,
            status,
            capabilities: Vec::new(),
            describe: String::new(),
        });
    }
}

/// A1 of a cell in a JSON entry, and the entry's caption-ish text.
fn cell_of(entry: &Value) -> (u64, u64) {
    (
        entry.get("row").and_then(|r| r.as_u64()).unwrap_or(0),
        entry.get("col").and_then(|c| c.as_u64()).unwrap_or(0),
    )
}

fn button_name(a1: &str, caption: &str) -> String {
    if caption.is_empty() {
        a1.to_string()
    } else {
        format!("{a1} \"{caption}\"")
    }
}

/// THE BUTTON CONTROLS, one row per code slot. Rules: a subscriber's
/// admission holds a STATIC `onSelect` (it runs through the button door after
/// the approval of its exact bytes) and removes a formula-typed one; a
/// `macroRef` survives only when it names a macro the application lands; a
/// package's held keys are discarded. The door runs code only on a button, and
/// a link wins over inline code -- a link that SURVIVES the admission: the two
/// slots are judged separately, so when the link is removed a click runs the
/// inline code (`control_action::decide_control`).
///
/// A control lands by CELL, and the LAST entry at a cell stands
/// (`materialize_saved_controls`), whatever its kind: the code of an earlier
/// entry at that cell never arrives, and is listed as such.
fn button_controls(
    side: &DiffSide,
    manifest: &VersionManifest,
    shipped_macros: &HashSet<String>,
    put: &mut impl FnMut(Item),
) -> Result<(), CalpError> {
    let Some(parsed) = read_json(side, "controls.json")? else { return Ok(()) };
    let sheets = match parsed {
        Ok(Value::Array(sheets)) => sheets,
        Ok(_) => return Ok(()),
        Err(why) => {
            put(unreadable(CodeKind::ButtonCode, "controls.json", "Button controls", &why));
            return Ok(());
        }
    };
    // Every entry in the order a pull materializes them, with its sheet.
    let mut entries: Vec<(String, &Value)> = Vec::new();
    for sheet in &sheets {
        let sheet_id = canonical_sheet(sheet.get("sheetId").and_then(|s| s.as_str()).unwrap_or(""));
        let Some(list) = sheet.get("controls").and_then(|c| c.as_array()) else { continue };
        entries.extend(list.iter().map(|entry| (sheet_id.clone(), entry)));
    }
    let at_cell = |sheet_id: &str, entry: &Value| {
        let (row, col) = cell_of(entry);
        (sheet_id.to_string(), row, col)
    };
    let last_at: BTreeMap<(String, u64, u64), usize> =
        entries.iter().enumerate().map(|(i, (sheet_id, entry))| (at_cell(sheet_id, entry), i)).collect();
    let mut replaced_at: BTreeMap<(String, u64, u64), usize> = BTreeMap::new();

    for (i, (sheet_id, entry)) in entries.iter().enumerate() {
        let cell = at_cell(sheet_id, entry);
        // REPLACED when a later entry sits at its cell: the n-th code at the
        // cell that never arrives.
        let replaced = last_at.get(&cell) != Some(&i);
        let n = if replaced {
            let n = replaced_at.entry(cell.clone()).or_insert(0);
            *n += 1;
            *n
        } else {
            0
        };
        let shared = replaced || replaced_at.contains_key(&cell);
        let Some(props) = entry.get("properties").and_then(|p| p.as_object()) else { continue };
        let sheet_name = sheet_name_of(manifest, sheet_id);
        let (row, col) = (cell.1, cell.2);
        let a1 = a1_of(row, col);
        let control_type = entry.get("controlType").and_then(|t| t.as_str()).unwrap_or("");
        let caption = props
            .get("text")
            .and_then(|t| t.get("value"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let text_of = |slot: &str| -> Option<(String, String)> {
            let p = props.get(slot)?;
            let text = p.get("value").and_then(|v| v.as_str())?;
            if text.is_empty() {
                return None;
            }
            let value_type = p.get("valueType").and_then(|t| t.as_str()).unwrap_or("static");
            Some((text.to_string(), value_type.to_string()))
        };
        let not_a_button = (control_type != "button").then(|| {
            format!("only a button runs code when it is clicked, and this control is a '{control_type}'")
        });
        let link = text_of(MACRO_REF_SLOT);
        // Does the link survive the subscriber's admission (a macro it lands)?
        let link_lands = link.as_ref().is_some_and(|(target, _)| shipped_macros.contains(target.as_str()));

        let mut slot_item = |slot: &str, shown: String, fingerprint_code: String, status: Status, describe: &str| {
            let item = Item {
                kind: CodeKind::ButtonCode,
                id: format!("{sheet_id}!{a1}:{slot}"),
                name: button_name(&a1, caption),
                sheet_name: sheet_name.clone(),
                fingerprint: format!("{fingerprint_code}\0{}", status.class()),
                shown,
                status,
                capabilities: Vec::new(),
                describe: describe.to_string(),
            };
            put(if replaced {
                displaced(
                    item,
                    n,
                    "another control at this cell comes later in this version and replaces this one, so subscribers \
                     never receive its code",
                )
            } else if shared {
                noted_as_live(item)
            } else {
                item
            });
        };

        if let Some((code, value_type)) = text_of(ON_SELECT_SLOT) {
            let mut describe = "inline code";
            let status = if let Some(why) = &not_a_button {
                Status::NeverRuns(why.clone())
            } else if link_lands {
                Status::NeverRuns("the button also links a macro, and a link is what a click runs".to_string())
            } else if value_type != "static" {
                Status::RemovedOnArrival(
                    "its action is a formula, which Calcula does not run as button code, so subscribers \
                     remove it"
                        .to_string(),
                )
            } else {
                if link.is_some() {
                    describe = "inline code; the button's macro link is removed on arrival, so a click runs this code";
                }
                Status::Approve(vec![Approval {
                    namespace: "",
                    id: button_action_approval_id(&code),
                    hash: sha256(&code),
                }])
            };
            let shown = if value_type == "static" { code.clone() } else { format!("({value_type}) {code}") };
            slot_item(ON_SELECT_SLOT, shown, format!("{value_type}\0{code}"), status, describe);
        }
        if let Some((target, value_type)) = &link {
            let status = if let Some(why) = &not_a_button {
                Status::NeverRuns(why.clone())
            } else if link_lands {
                Status::RunsAfter(format!("runs the application's macro '{target}' once that macro is approved"))
            } else {
                Status::RemovedOnArrival(format!(
                    "links the macro '{target}', which this version does not carry, so subscribers remove \
                     the link"
                ))
            };
            slot_item(
                MACRO_REF_SLOT,
                format!("runs macro {target}"),
                format!("{value_type}\0{target}"),
                status,
                "macro link",
            );
        }
        for held in HELD_CONTROL_CODE_SLOTS {
            if let Some((code, value_type)) = text_of(held) {
                slot_item(
                    held,
                    code.clone(),
                    format!("{value_type}\0{code}"),
                    Status::RemovedOnArrival(format!(
                        "'{held}' is written only by a checkout on the receiving computer, never by a \
                         package, so subscribers discard it"
                    )),
                    "held-code key",
                );
            }
        }
    }
    Ok(())
}

/// THE BUTTON CELLS (`calcula.button` in a `cellType` custom object), one row
/// per action. Rules (`button_cells::admit_button_cells`): a script action
/// survives only when it names a macro the application ships, and runs after
/// that macro's approval; a command survives only when it is on Calcula's list,
/// and then asks its own approval; anything else is removed; a package's held
/// action is discarded.
///
/// A cell type lands by CELL, every `cellType` object of a sheet in turn, and
/// the LAST entry at a cell stands (`materialize_saved_cell_types`), whatever
/// its type: the action of an earlier button at that cell never arrives, and is
/// listed as such.
fn button_cells(
    side: &DiffSide,
    manifest: &VersionManifest,
    shipped_macros: &HashSet<String>,
    allowed_button_commands: &[&str],
    put: &mut impl FnMut(Item),
) -> Result<(), CalpError> {
    // Every entry of every per-sheet cell-type object, in the order a pull
    // materializes them.
    let mut payloads: Vec<(String, Vec<Value>)> = Vec::new();
    for object in &manifest.custom_objects {
        if object.kind != CELL_TYPE_OBJECT_KIND {
            continue;
        }
        // A pull materializes only per-sheet cell types.
        let Some(sheet) = object.sheet_id else { continue };
        let Some(parsed) = read_json(side, &object.payload_path)? else { continue };
        let Ok(Value::Array(entries)) = parsed else { continue };
        payloads.push((sheet.to_string(), entries));
    }
    let entries: Vec<(&str, &Value)> = payloads
        .iter()
        .flat_map(|(sheet_id, list)| list.iter().map(move |entry| (sheet_id.as_str(), entry)))
        .collect();
    let at_cell = |sheet_id: &str, entry: &Value| {
        let (row, col) = cell_of(entry);
        (sheet_id.to_string(), row, col)
    };
    let last_at: BTreeMap<(String, u64, u64), usize> =
        entries.iter().enumerate().map(|(i, (sheet_id, entry))| (at_cell(sheet_id, entry), i)).collect();
    let mut replaced_at: BTreeMap<(String, u64, u64), usize> = BTreeMap::new();

    for (i, (sheet_id, entry)) in entries.iter().enumerate() {
        let cell = at_cell(sheet_id, entry);
        let replaced = last_at.get(&cell) != Some(&i);
        let n = if replaced {
            let n = replaced_at.entry(cell.clone()).or_insert(0);
            *n += 1;
            *n
        } else {
            0
        };
        let shared = replaced || replaced_at.contains_key(&cell);
        let sheet_name = sheet_name_of(manifest, sheet_id);
        if entry.get("typeId").and_then(|t| t.as_str()) != Some(BUTTON_CELL_TYPE_ID) {
            continue;
        }
        let Some(params) = entry.get("params").and_then(|p| p.as_object()) else { continue };
        let (row, col) = (cell.1, cell.2);
        let a1 = a1_of(row, col);
        let label = params.get("label").and_then(|l| l.as_str()).unwrap_or("");
        let mut action_item = |slot: &str, action: &Value, status: Status, describe: &str| {
            let text = |key: &str| action.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let what = match action.get("kind").and_then(|k| k.as_str()) {
                Some("script") if !text("functionName").is_empty() => {
                    format!("runs macro {}, then calls {}()", text("scriptId"), text("functionName"))
                }
                Some("script") => format!("runs macro {}", text("scriptId")),
                Some("command") => format!("runs command {}", text("commandId")),
                _ => "an action of an unknown kind".to_string(),
            };
            // Canonical JSON (keys sorted): the bytes the host hashes.
            let exact = serde_json::to_string(action).unwrap_or_default();
            let item = Item {
                kind: CodeKind::ButtonCellAction,
                id: format!("{sheet_id}!{a1}:{slot}"),
                name: button_name(&a1, label),
                sheet_name: sheet_name.clone(),
                fingerprint: format!("{exact}\0{}", status.class()),
                shown: format!("{what}\n{exact}"),
                status,
                capabilities: Vec::new(),
                describe: describe.to_string(),
            };
            put(if replaced {
                displaced(
                    item,
                    n,
                    "another cell type at this cell comes later in this version and replaces this button, so \
                     subscribers never receive its action",
                )
            } else if shared {
                noted_as_live(item)
            } else {
                item
            });
        };
        if let Some(action) = params.get(CELL_ACTION_PARAM).filter(|a| !a.is_null()) {
            let text = |key: &str| action.get(key).and_then(|v| v.as_str());
            let status = match action.get("kind").and_then(|k| k.as_str()) {
                Some("script") => match text("scriptId") {
                    Some(id) if shipped_macros.contains(id) => Status::RunsAfter(format!(
                        "runs the application's macro '{id}' once that macro is approved"
                    )),
                    Some(id) => Status::RemovedOnArrival(format!(
                        "runs the macro '{id}', which this version does not carry, so subscribers remove \
                         the action"
                    )),
                    None => Status::RemovedOnArrival(
                        "has an action this version of Calcula does not recognise, so subscribers remove it"
                            .to_string(),
                    ),
                },
                Some("command") => match text("commandId") {
                    Some(id) if allowed_button_commands.contains(&id) => Status::Approve(vec![Approval {
                        namespace: "button-commands",
                        id: id.to_string(),
                        hash: sha256(id),
                    }]),
                    id => Status::RemovedOnArrival(format!(
                        "runs the command '{}', which is not on Calcula's list of commands a button from an \
                         application may run, so subscribers remove the action",
                        id.unwrap_or("")
                    )),
                },
                _ => Status::RemovedOnArrival(
                    "has an action this version of Calcula does not recognise, so subscribers remove it"
                        .to_string(),
                ),
            };
            action_item(CELL_ACTION_PARAM, action, status, "");
        }
        if let Some(held) = params.get(CELL_HELD_ACTION_PARAM).filter(|a| !a.is_null()) {
            action_item(
                CELL_HELD_ACTION_PARAM,
                held,
                Status::RemovedOnArrival(format!(
                    "'{CELL_HELD_ACTION_PARAM}' is written only by a checkout on the receiving computer, \
                     never by a package, so subscribers discard it"
                )),
                "held action",
            );
        }
    }
    Ok(())
}

/// THE WRITEBACK VALIDATORS. They are code too, and they live in the MANIFEST:
/// a region's schema `extra` carries `customValidator` (the name) and
/// `customValidatorSource` (the body). Approved per (name, sha256 of the
/// trimmed body) at the next submit (`declared_validator` / `validator_consented`
/// in the app). A name with no body refuses every submit to its region.
fn writeback_validators(manifest: &VersionManifest, put: &mut impl FnMut(Item)) {
    for region in manifest.writeback_regions.iter().flatten() {
        let Some(schema) = &region.schema else { continue };
        let text = |key: &str| {
            schema
                .extra
                .get(key)
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        };
        let Some(name) = text("customValidator") else { continue };
        let source = text("customValidatorSource");
        let status = match &source {
            Some(body) => Status::Approve(vec![Approval {
                namespace: "writeback-validators",
                id: format!("writeback-validator:{name}"),
                hash: sha256(body),
            }]),
            None => Status::BlocksSubmit(format!(
                "declares the validator '{name}' but ships no code for it, so every submit to this region is \
                 refused"
            )),
        };
        let body = source.unwrap_or_default();
        put(Item {
            kind: CodeKind::WritebackValidator,
            id: region.id.clone(),
            name: name.clone(),
            sheet_name: sheet_name_of(manifest, &region.selector.sheet_id.to_string()),
            fingerprint: format!("{name}\0{body}\0{}", status.class()),
            shown: body,
            status,
            capabilities: Vec::new(),
            describe: format!("checks what subscribers submit to region {}", region.id),
        });
    }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

fn row(
    change: CodeChangeKind,
    before: Option<&Item>,
    after: Option<&Item>,
    approved_before: &HashSet<Approval>,
    opts: &DiffOptions,
) -> CodeChange {
    let latest = after.or(before).expect("a row has at least one side");
    let (consequence, reason): (SubscriberConsequence, String) = match after {
        // Gone from the target.
        None => {
            let b = before.expect("a removal has a before side");
            if b.status.runs() {
                (SubscriberConsequence::StopsRunning, String::new())
            } else {
                (SubscriberConsequence::NeverRuns, "it never ran for subscribers".to_string())
            }
        }
        Some(a) => match &a.status {
            Status::Approve(list) if list.iter().all(|ap| approved_before.contains(ap)) => (
                SubscriberConsequence::RunsAfterApproval,
                "the same code is already in the version this environment holds, so an approval given to it \
                 there still counts"
                    .to_string(),
            ),
            Status::Approve(_) => (SubscriberConsequence::AsksApprovalAgain, String::new()),
            Status::FunctionSet => (SubscriberConsequence::AsksApprovalAgain, String::new()),
            Status::RunsAfter(why) => (SubscriberConsequence::RunsAfterApproval, why.clone()),
            Status::RemovedOnArrival(why) => (SubscriberConsequence::RemovedOnArrival, why.clone()),
            Status::NeverRuns(why) => (SubscriberConsequence::NeverRuns, why.clone()),
            Status::RefusesVersion(why) => (SubscriberConsequence::RefusesVersion, why.clone()),
            Status::BlocksSubmit(why) => (SubscriberConsequence::BlocksSubmit, why.clone()),
        },
    };
    let text = |item: Option<&Item>| item.map(|i| truncate(&i.shown, opts.max_source_bytes));
    let (before_text, after_text) = (text(before), text(after));
    let added_capabilities: Vec<String> = match (before, after) {
        (_, None) => Vec::new(),
        (b, Some(a)) => {
            let had: BTreeSet<&String> = b.map(|b| b.capabilities.iter().collect()).unwrap_or_default();
            a.capabilities.iter().filter(|c| !had.contains(c)).cloned().collect()
        }
    };
    CodeChange {
        kind: latest.kind,
        id: latest.id.clone(),
        name: latest.name.clone(),
        sheet_name: latest.sheet_name.clone(),
        change,
        detail: join(&latest.describe, &reason),
        consequence,
        before_truncated: before_text.as_ref().is_some_and(|(_, t)| *t),
        after_truncated: after_text.as_ref().is_some_and(|(_, t)| *t),
        before: before_text.map(|(s, _)| s),
        after: after_text.map(|(s, _)| s),
        added_capabilities,
    }
}

#[cfg(test)]
#[path = "code_summary_tests.rs"]
mod tests;
