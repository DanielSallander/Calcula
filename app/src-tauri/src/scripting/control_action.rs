//! FILENAME: app/src-tauri/src/scripting/control_action.rs
//! PURPOSE: THE ONE BUTTON RULE, in Rust (M6, phase 4 of BUG-0257): what a
//! click on a button runs, decided from the backend's own store -- never from
//! text the page composes.
//! CONTEXT: The rule used to live in the renderer
//! (`app/extensions/_shared/lib/buttonScriptRun.ts`): the page read a button's
//! `onSelect`, composed the user's own modules around it, and sent the result
//! to `run_script`, which treats a source no stored module carries as an
//! ad-hoc run and lets it through. That was sound only while nothing an
//! application shipped could sit on a button as code. Phase 4 lets an
//! application's inline button code travel -- held, stamped, and run only after
//! an approval that showed it -- so the page must no longer be the thing that
//! decides what a click runs.
//!
//! This module is that decision, ported case for case from the TypeScript
//! planners it replaced (`planInlineButtonRun`, `planStoredModuleRun`, deleted
//! from the page when every click moved to this door -- M6 Task D). Every button
//! surface now names the button and says the door's answer
//! (`app/extensions/_shared/lib/buttonClickDoor.ts`):
//!
//! * [`plan_own_inline`] -- the user's OWN inline code. Their own modules are
//!   wrapped as callable functions and prepended; a module that came with an
//!   application is never composed with anything. A bare `Name()` that exactly
//!   one application module answers to runs that module's stored source,
//!   verbatim, so the approval can be asked of exactly those bytes.
//! * [`plan_held_inline`] -- an application's HELD inline code. Never a
//!   preamble. A `Name()` resolves ONLY among that application's modules: never
//!   the user's (the confused deputy by name), never another application's.
//! * [`plan_cell_action`] -- a button CELL's action (`script` / `command`).
//!
//! The planners are PURE over plain inputs. The door below them,
//! [`run_control_action`], is the one route a button click takes: it reads the
//! clicked button from the backend's own store, plans from that copy, asks
//! `application_code_gate::button_run_gate` whose code the plan's final source
//! is (the approval of its exact bytes, the working-copy private-sheet rule, a
//! row for every run and refusal of an application's code), then Script
//! Security, and only then hands the source to the interpreter.
//!
//! A button CELL of an application's that names a Calcula COMMAND (plan_M8 S1)
//! runs nothing here -- only the page can run an extension command. The door
//! asks `application_code_gate::button_command_gate` (Rust's list, the approval
//! under `button-commands:<application>`, the private-sheet rule; every refusal
//! recorded) and answers `command` with the application. The page checks the
//! command's LIVE registration opts in, then asks [`authorize_button_command`]
//! -- the same gate again, from the store, and the run row -- before it runs it.

use std::collections::{BTreeMap, HashSet};

use serde::Serialize;
use serde_json::Value;

use super::application_code_gate::{
    button_command_gate, button_command_mismatch_refusal, button_run_gate, record_button_code_refused,
    record_button_command_mismatch, record_button_run, record_button_run_refused, ButtonAttribution,
    ButtonGateAnswer, CommandGatePhase, HeldCode, APPLICATION_CODE_TRIGGER_MISMATCH,
};
use super::commands::{check_script_security, is_reserved_script_id, run_in_interpreter, SCRIPTS_DISABLED};
use super::types::{
    AuthorizeButtonCommandRequest, ControlActionKind, ControlActionOutcome, RunControlActionRequest, ScriptRunTrigger,
    ScriptRunTriggerKind, ScriptState,
};
use crate::button_cells::{CellStamp, DISTRIBUTABLE_BUTTON_COMMANDS};
use crate::controls::{
    holds_application_code, ControlMetadata, HELD_FROM_PROPERTY, HELD_MACRO_REF_PROPERTY, HELD_ON_SELECT_PROPERTY,
    MACRO_REF_PROPERTY, ON_SELECT_PROPERTY,
};
use crate::held_button_code::{a1, HeldFrom, MacroLinkKind};
use crate::persistence::{FileState, UserFilesState};
use crate::AppState;

/// The consent-record id prefix of a piece of inline button code: the approval
/// id of held code is `buttonAction:<sha256 of its exact bytes>`, under the
/// application's BARE record (the one that also holds its object scripts and
/// macros). Reserved: a pull refuses a module, notebook or object script whose
/// id starts with it (`refuse_reserved_distributed_script_ids`), so nothing
/// else can claim -- or block -- that approval. The TypeScript mirror is drift-
/// tested against this spelling.
pub(crate) const BUTTON_ACTION_CONSENT_PREFIX: &str = "buttonAction:";

/// The approval id of one piece of inline button code.
pub(crate) fn button_action_consent_id(code: &str) -> String {
    format!("{BUTTON_ACTION_CONSENT_PREFIX}{}", calp::integrity::sha256_hex(code.as_bytes()))
}

// ============================================================================
// The module a planner sees
// ============================================================================

/// One stored module script, as the planners see it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ModuleView {
    pub id: String,
    pub name: String,
    pub source: String,
    /// The application this module came with; `None` for the user's own. The
    /// ONLY authority on whose code it is (stamped by the pull).
    pub source_package: Option<String>,
    /// The module's description, which carries the Macro Recorder's runtime
    /// marker (`runtime=objectScript` / `runtime=notebook`).
    pub description: Option<String>,
}

impl ModuleView {
    /// True when the module came with an application.
    pub fn is_distributed(&self) -> bool {
        self.source_package.is_some()
    }

    /// The application the module came with, or `None` for the user's own.
    pub fn application(&self) -> Option<&str> {
        self.source_package.as_deref()
    }

    /// True when the module runs only in a Worker realm the renderer builds (the
    /// Macro Recorder's default target), never in the Rust interpreter.
    pub fn runs_as_object_script(&self) -> bool {
        parse_module_runtime(self.description.as_deref()) == Some(ModuleRuntime::ObjectScript)
    }
}

/// Every stored module, as the planners see them: reserved internal records
/// (`__calcula_`) left out -- they are data, not code, and the Script Editor
/// hides them too -- and sorted by (name, id), so a duplicate name has ONE
/// fixed winner. `list_scripts`' HashMap order used to make it depend on the
/// launch.
pub(crate) fn module_views(scripts: &std::collections::HashMap<String, super::types::WorkbookScript>) -> Vec<ModuleView> {
    let mut views: Vec<ModuleView> = scripts
        .values()
        .filter(|s| !is_reserved_script_id(&s.id))
        .map(|s| ModuleView {
            id: s.id.clone(),
            name: s.name.clone(),
            source: s.source.clone(),
            source_package: s.source_package.clone(),
            description: s.description.clone(),
        })
        .collect();
    views.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
    views
}

/// The runtime a module targets, as the Macro Recorder's marker says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ModuleRuntime {
    /// Synchronous `Calcula.*` in the Rust interpreter -- what a button runs.
    Notebook,
    /// The async object-script `api`, which exists only inside a mounted realm.
    ObjectScript,
}

/// ASCII word character, as a JavaScript regex `\b` sees one (no `u` flag).
fn is_js_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// `parseModuleScriptRuntime` (@api/workbookScripts.ts): the FIRST match of
/// `\bruntime=(objectScript|notebook)\b` in the description, with JavaScript's
/// ASCII-only word boundary. Written out rather than a Rust regex, whose `\b`
/// is Unicode-aware and would disagree next to a non-ASCII character. Pinned
/// against the TypeScript regex by the shared fixture.
pub(crate) fn parse_module_runtime(description: Option<&str>) -> Option<ModuleRuntime> {
    let text = description?;
    let bytes = text.as_bytes();
    const KEY: &str = "runtime=";
    let mut from = 0;
    while let Some(offset) = text[from..].find(KEY) {
        let at = from + offset;
        let boundary_before = at == 0 || !is_js_word_byte(bytes[at - 1]);
        if boundary_before {
            let value_at = at + KEY.len();
            for (word, runtime) in [("objectScript", ModuleRuntime::ObjectScript), ("notebook", ModuleRuntime::Notebook)] {
                if text[value_at..].starts_with(word) {
                    let end = value_at + word.len();
                    if end == bytes.len() || !is_js_word_byte(bytes[end]) {
                        return Some(runtime);
                    }
                }
            }
        }
        from = at + 1;
    }
    None
}

// ============================================================================
// Identifiers
// ============================================================================

/// Sanitize a module name into the identifier a button's `Name()` calls it by.
///
/// Per UTF-16 CODE UNIT, exactly as `CodePropertyInput.sanitizeScriptName`
/// does (the Properties pane writes the `Name()` text with it): the JavaScript
/// regex `/[^a-zA-Z0-9_]/g` replaces each unit, so an emoji -- a surrogate
/// pair -- becomes TWO underscores. A char-wise port would write one and drift.
pub(crate) fn sanitize_script_name(name: &str) -> String {
    let mut sanitized: String = name
        .encode_utf16()
        .map(|unit| match char::from_u32(u32::from(unit)) {
            Some(c) if c.is_ascii_alphanumeric() || c == '_' => c,
            _ => '_',
        })
        .collect();
    if sanitized.starts_with(|c: char| c.is_ascii_digit()) {
        sanitized.insert(0, '_');
    }
    if sanitized.is_empty() {
        "_unnamed".to_string()
    } else {
        sanitized
    }
}

/// The whitespace a `Name()` invocation may carry around it: space, tab, CR and
/// LF, written out. JavaScript's `\s` and Rust's `char::is_whitespace` disagree
/// (U+FEFF, U+0085), so neither is used: a call with anything else around it is
/// plain code, not an invocation.
fn is_call_space(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\r' | b'\n')
}

fn is_ident_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_' || b == b'$'
}

fn is_ident_continue(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$'
}

/// The module name an inline action INVOKES, when that is all it does: one
/// complete zero-argument call and nothing else -- `Name()` or `Name();`.
/// Anything else (an argument, a second statement, a condition, a member
/// expression) is code, not an invocation.
pub(crate) fn single_module_call_name(code: &str) -> Option<String> {
    let b = code.as_bytes();
    let mut i = 0;
    let skip = |mut i: usize| {
        while i < b.len() && is_call_space(b[i]) {
            i += 1;
        }
        i
    };
    i = skip(i);
    let start = i;
    if i >= b.len() || !is_ident_start(b[i]) {
        return None;
    }
    i += 1;
    while i < b.len() && is_ident_continue(b[i]) {
        i += 1;
    }
    let name = &code[start..i];
    i = skip(i);
    if b.get(i) != Some(&b'(') {
        return None;
    }
    i = skip(i + 1);
    if b.get(i) != Some(&b')') {
        return None;
    }
    i = skip(i + 1);
    if b.get(i) == Some(&b';') {
        i += 1;
    }
    i = skip(i);
    (i == b.len()).then(|| name.to_string())
}

/// Every identifier-shaped token in an inline action (`/[A-Za-z_$][A-Za-z0-9_$]*/g`),
/// for "did the code mention X?".
fn referenced_identifiers(code: &str) -> HashSet<String> {
    let b = code.as_bytes();
    let mut out = HashSet::new();
    let mut i = 0;
    while i < b.len() {
        if is_ident_start(b[i]) {
            let start = i;
            i += 1;
            while i < b.len() && is_ident_continue(b[i]) {
                i += 1;
            }
            out.insert(code[start..i].to_string());
        } else {
            i += 1;
        }
    }
    out
}

/// A single JavaScript identifier and nothing else (ASCII, as the TypeScript
/// check was).
fn is_bare_identifier(text: &str) -> bool {
    let b = text.as_bytes();
    !b.is_empty() && is_ident_start(b[0]) && b[1..].iter().all(|c| is_ident_continue(*c))
}

/// Blank as JavaScript's `String.prototype.trim` sees it: nothing but
/// whitespace, the byte-order mark included.
fn is_blank(text: &str) -> bool {
    text.chars().all(|c| c.is_whitespace() || c == '\u{feff}')
}

// ============================================================================
// What a plan is
// ============================================================================

/// A module a button's code names but cannot call, and why, as one sentence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnavailableModule {
    pub id: String,
    pub name: String,
    /// `distributed` (it came with an application, so it is never composed) or
    /// `objectScript` (it runs only as an object script).
    pub reason: String,
    pub message: String,
}

/// Why a planner will not run anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanRefusal {
    /// More than one module answers to the `Name()`.
    Ambiguous,
    /// The target module runs only as an object script.
    ObjectScriptMacro,
    /// A button from an application names a macro that is not its application's.
    MacroNotFromApplication,
    /// The cell's script action names no module this workbook holds.
    ModuleNotFound,
    /// "Function to call" is not an identifier.
    NotAFunctionName,
    /// "Function to call" would append a call to an application's module.
    ComposesApplicationCode,
}

impl PlanRefusal {
    /// The wire spelling, the same one the refusal's audit row carries.
    pub fn as_str(&self) -> &'static str {
        match self {
            PlanRefusal::Ambiguous => "ambiguous",
            PlanRefusal::ObjectScriptMacro => "objectScriptMacro",
            PlanRefusal::MacroNotFromApplication => "macroNotFromApplication",
            PlanRefusal::ModuleNotFound => "moduleNotFound",
            PlanRefusal::NotAFunctionName => "notAFunctionName",
            PlanRefusal::ComposesApplicationCode => "composesApplicationCode",
        }
    }
}

/// What a click should run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Plan {
    Run {
        /// Exactly what the interpreter is handed.
        source: String,
        filename: String,
        /// The ONE stored module whose source runs unchanged, when that is
        /// what the plan is -- the only shape an approval can be asked of.
        module: Option<ModuleView>,
        unavailable: Vec<UnavailableModule>,
    },
    Refuse {
        reason: PlanRefusal,
        message: String,
        /// The module the refusal is about, when there is one.
        module: Option<ModuleView>,
    },
}

/// What a button CELL's action asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CellPlan {
    /// A script action: run, or refused.
    Script(Plan),
    /// The user's own command: only the page can run an extension command.
    Command { command_id: String },
    /// A command named by a button from an application: the command gate
    /// (`application_code_gate::button_command_gate`) decides whether it may
    /// run -- the planner knows neither the list nor the approvals.
    ApplicationCommand { command_id: String },
    /// A macro that runs only as an object script (the Macro Recorder's default
    /// target). The interpreter a button hands code to has no `api`, so the
    /// page's macro seam runs it, behind the approval and the run gate, with
    /// the button cell as its trigger (owner decision B, follow-up F6). Only a
    /// whole macro: a "Function to call" inside one is refused.
    ObjectScriptMacro { macro_id: String },
    /// No action it can run, said.
    Nothing { message: String },
}

// ============================================================================
// Sentences
// ============================================================================

fn application_label(module: &ModuleView) -> &str {
    module.application().unwrap_or("an application")
}

fn distributed_unavailable(module: &ModuleView) -> UnavailableModule {
    let fn_name = sanitize_script_name(&module.name);
    UnavailableModule {
        id: module.id.clone(),
        name: module.name.clone(),
        reason: "distributed".to_string(),
        message: format!(
            "The script module \"{}\" arrived in the application \"{}\", so this button cannot mix it into \
             other code -- that would run a publisher's code without your approval, and `{fn_name}()` is \
             therefore not defined here. A button can run it only as the published module itself: set the \
             button's action to exactly \"{fn_name}()\".",
            module.name,
            application_label(module),
        ),
    }
}

fn object_script_unavailable(module: &ModuleView) -> UnavailableModule {
    UnavailableModule {
        id: module.id.clone(),
        name: module.name.clone(),
        reason: "objectScript".to_string(),
        message: object_script_refusal_text(module),
    }
}

/// The refusal for a button that calls, by name, a macro that runs as an
/// object script (the Macro Recorder's default target): the interpreter a
/// button runs in has no `api`, so the honest answer is to say which route
/// reaches it (owner decision Q1: refuse by name, tell the author to link it).
pub(crate) fn object_script_refusal_text(module: &ModuleView) -> String {
    format!(
        "{} runs as an object script, so a button can reach it only by linking the macro (Properties > Macro), \
         not by calling it by name.",
        module.name
    )
}

/// The refusal for a `Name()` that MORE THAN ONE module answers to. Listed
/// sorted by (application, name, id), so the sentence is the same on every
/// launch -- the disclosure must not inherit the nondeterminism it discloses.
fn ambiguous_message(called: &str, candidates: &[&ModuleView]) -> String {
    let mut described: Vec<(String, String, String)> = candidates
        .iter()
        .map(|m| (application_label(m).to_string(), m.name.clone(), m.id.clone()))
        .collect();
    described.sort();
    let named: Vec<String> = described
        .iter()
        .map(|(app, name, _)| format!("\"{name}\" from the application \"{app}\""))
        .collect();
    format!(
        "{} script modules answer to {called}(): {}. This button will not pick one of them for you, so it \
         will not run. Bind the button to one module directly -- a button cell whose action names the module \
         -- or rename one of the modules so the names differ.",
        named.len(),
        named.join(", and "),
    )
}

/// THE ONE SENTENCE for "a button from an application named a macro that is
/// not that application's" -- byte for byte the TypeScript
/// `describeMacroNotFromApplication`, which the macro-run seam still uses for a
/// held macro LINK (drift-tested against this template by
/// `app/extensions/_shared/lib/__tests__/buttonSentenceDrift.test.ts`). `owner`
/// is the application the macro came with, or `None` for the user's own.
pub(crate) fn describe_macro_not_from_application(
    from_application: &str,
    macro_name: &str,
    owner: Option<&str>,
) -> String {
    format!(
        "This button came with the application \"{from_application}\", and the macro \"{macro_name}\" it names {}. \
         A button from an application runs only that application's own macros, so it did not run.",
        match owner {
            None => "is one of your own".to_string(),
            Some(owner) => format!("came with a different application, \"{owner}\""),
        }
    )
}

// ============================================================================
// The planners
// ============================================================================

/// The planner for the user's OWN inline code (a button control's live
/// `onSelect`): what the page's deleted `planInlineButtonRun` did.
///
/// 1. A bare `Name()` of a module of the user's own runs through the preamble
///    below ("local wins"). When the only module of the user's own answering to
///    it runs as an object script, it is refused by name.
/// 2. A bare `Name()` of exactly ONE application module (and none of the
///    user's own) runs that module's stored source, verbatim -- the only shape
///    its approval can be asked of. Two answers -> a refusal.
/// 3. Anything else is the user's own code, with the user's own modules
///    wrapped as callable functions and prepended -- and nothing of an
///    application's, ever. A mentioned application module gets one notice per
///    NAME; so does a mentioned module of the user's own that runs only as an
///    object script (it is not wrapped: the interpreter could not run it).
pub(crate) fn plan_own_inline(code: &str, modules: &[ModuleView]) -> Plan {
    let local: Vec<&ModuleView> = modules.iter().filter(|m| !m.is_distributed()).collect();
    let distributed: Vec<&ModuleView> = modules.iter().filter(|m| m.is_distributed()).collect();
    // Only a local module that has a body shadows an application's namesake --
    // an empty one would define nothing.
    let shadowing: Vec<&ModuleView> = local.iter().copied().filter(|m| !is_blank(&m.source)).collect();
    let local_names: HashSet<String> = shadowing.iter().map(|m| sanitize_script_name(&m.name)).collect();
    // What the preamble actually defines: a local module with a body the
    // interpreter can run.
    let wrapped: Vec<&ModuleView> = local
        .iter()
        .copied()
        .filter(|m| !m.source.is_empty() && !m.runs_as_object_script())
        .collect();
    let defined: HashSet<String> = wrapped.iter().map(|m| sanitize_script_name(&m.name)).collect();

    if let Some(called) = single_module_call_name(code) {
        if local_names.contains(&called) {
            // LOCAL WINS. But a name only an object-script module of the user's
            // own answers to would call nothing: say so instead.
            if !defined.contains(&called) {
                if let Some(target) = shadowing
                    .iter()
                    .find(|m| sanitize_script_name(&m.name) == called && m.runs_as_object_script())
                {
                    return Plan::Refuse {
                        reason: PlanRefusal::ObjectScriptMacro,
                        message: object_script_refusal_text(target),
                        module: Some((*target).clone()),
                    };
                }
            }
        } else {
            let candidates: Vec<&ModuleView> =
                distributed.iter().copied().filter(|m| sanitize_script_name(&m.name) == called).collect();
            if candidates.len() > 1 {
                return Plan::Refuse {
                    reason: PlanRefusal::Ambiguous,
                    message: ambiguous_message(&called, &candidates),
                    module: None,
                };
            }
            if let Some(target) = candidates.first() {
                if target.runs_as_object_script() {
                    return Plan::Refuse {
                        reason: PlanRefusal::ObjectScriptMacro,
                        message: object_script_refusal_text(target),
                        module: Some((*target).clone()),
                    };
                }
                return Plan::Run {
                    source: target.source.clone(),
                    filename: format!("button_module_{}.js", target.id),
                    module: Some((*target).clone()),
                    unavailable: Vec::new(),
                };
            }
        }
    }

    // The user's own code, with the user's own modules available as functions.
    let preamble: String = wrapped
        .iter()
        .map(|m| format!("function {}() {{\n{}\n}}\n", sanitize_script_name(&m.name), m.source))
        .collect();
    let referenced = referenced_identifiers(code);
    let mut unavailable: Vec<UnavailableModule> = Vec::new();
    // ONE notice per NAME, not per module: two applications shipping a
    // `Report` must not be told twice to "set the action to exactly Report()"
    // -- the one thing the planner then refuses as ambiguous.
    let mut by_name: BTreeMap<String, Vec<&ModuleView>> = BTreeMap::new();
    for module in &distributed {
        let fn_name = sanitize_script_name(&module.name);
        if referenced.contains(&fn_name) && !local_names.contains(&fn_name) {
            by_name.entry(fn_name).or_default().push(module);
        }
    }
    for (fn_name, group) in &by_name {
        if group.len() == 1 {
            unavailable.push(distributed_unavailable(group[0]));
        } else {
            let mut ids: Vec<&str> = group.iter().map(|m| m.id.as_str()).collect();
            ids.sort_unstable();
            unavailable.push(UnavailableModule {
                id: ids.join("+"),
                name: fn_name.clone(),
                reason: "distributed".to_string(),
                message: ambiguous_message(fn_name, group),
            });
        }
    }
    // A mentioned module of the user's own that runs only as an object script
    // is not defined here either -- said, not left as a bare ReferenceError.
    let mut told: HashSet<String> = HashSet::new();
    for module in &local {
        let fn_name = sanitize_script_name(&module.name);
        if module.runs_as_object_script()
            && referenced.contains(&fn_name)
            && !defined.contains(&fn_name)
            && told.insert(fn_name)
        {
            unavailable.push(object_script_unavailable(module));
        }
    }
    Plan::Run {
        source: format!("{preamble}{code}"),
        filename: "button_onSelect.js".to_string(),
        module: None,
        unavailable,
    }
}

/// The planner for an application's HELD inline code (a button control's
/// `heldOnSelect`, stamped with `application`).
///
/// NEVER a preamble: the held bytes are what was approved, and they run as
/// themselves. A bare `Name()` resolves ONLY among `application`'s own modules
/// -- never a module of the user's own (a local module used to win a `Name()`,
/// which for held code is a confused deputy by name) and never another
/// application's. Two answers -> a refusal. No answer -> the code runs
/// verbatim, and a `Name()` of the user's own module then fails with "is not
/// defined", which is the honest answer.
pub(crate) fn plan_held_inline(code: &str, application: &str, modules: &[ModuleView]) -> Plan {
    if let Some(called) = single_module_call_name(code) {
        let candidates: Vec<&ModuleView> = modules
            .iter()
            .filter(|m| m.application() == Some(application) && sanitize_script_name(&m.name) == called)
            .collect();
        if candidates.len() > 1 {
            return Plan::Refuse {
                reason: PlanRefusal::Ambiguous,
                message: ambiguous_message(&called, &candidates),
                module: None,
            };
        }
        if let Some(target) = candidates.first() {
            if target.runs_as_object_script() {
                return Plan::Refuse {
                    reason: PlanRefusal::ObjectScriptMacro,
                    message: object_script_refusal_text(target),
                    module: Some((*target).clone()),
                };
            }
            return Plan::Run {
                source: target.source.clone(),
                filename: format!("button_module_{}.js", target.id),
                module: Some((*target).clone()),
                unavailable: Vec::new(),
            };
        }
    }
    Plan::Run {
        source: code.to_string(),
        filename: "button_onSelect.js".to_string(),
        module: None,
        unavailable: Vec::new(),
    }
}

/// The planner for a button CELL's action (`{kind:"script", scriptId,
/// functionName?}` or `{kind:"command", commandId}`): what the page's deleted
/// `planStoredModuleRun` did, plus the command split.
///
/// `from_application` is the application the BUTTON came with (its
/// `fromApplication` stamp), or `None` for the user's own button: it may run
/// only its application's modules, and a command only through the command gate
/// (`CellPlan::ApplicationCommand`; the planner knows neither the list nor the
/// approvals).
pub(crate) fn plan_cell_action(action: &Value, from_application: Option<&str>, modules: &[ModuleView]) -> CellPlan {
    let kind = action.get("kind").and_then(Value::as_str).unwrap_or("");
    let text = |key: &str| action.get(key).and_then(Value::as_str).unwrap_or("").to_string();

    if kind == "command" && !text("commandId").is_empty() {
        let command_id = text("commandId");
        return match from_application {
            Some(_) => CellPlan::ApplicationCommand { command_id },
            None => CellPlan::Command { command_id },
        };
    }

    if kind == "script" && !text("scriptId").is_empty() {
        let script_id = text("scriptId");
        let Some(module) = modules.iter().find(|m| m.id == script_id) else {
            return CellPlan::Script(Plan::Refuse {
                reason: PlanRefusal::ModuleNotFound,
                message: "Button script not found in this workbook".to_string(),
                module: None,
            });
        };
        // A button from an application runs only a module that came with THE
        // SAME application (BUG-0260): refused before anything else, so no call
        // is ever composed onto a module the button's application does not own.
        if let Some(app) = from_application {
            if module.application() != Some(app) {
                return CellPlan::Script(Plan::Refuse {
                    reason: PlanRefusal::MacroNotFromApplication,
                    message: format!(
                        "{} To run this macro from a button, give the button an action of your own \
                         (Insert > Cell Type > Button).",
                        describe_macro_not_from_application(app, &module.name, module.application())
                    ),
                    module: Some(module.clone()),
                });
            }
        }
        if module.source.is_empty() {
            return CellPlan::Script(Plan::Refuse {
                reason: PlanRefusal::ModuleNotFound,
                message: "Button script not found in this workbook".to_string(),
                module: Some(module.clone()),
            });
        }
        let function = text("functionName").trim().to_string();
        // A macro that runs only as an object script is the macro seam's to run
        // (owner decision B, F6): this door's interpreter has no `api`. As a
        // WHOLE macro only -- there is no program here to append a call to.
        if module.runs_as_object_script() {
            if !function.is_empty() {
                return CellPlan::Script(Plan::Refuse {
                    reason: PlanRefusal::ObjectScriptMacro,
                    message: format!(
                        "{} runs as an object script, so this button cell runs it as a whole macro: it cannot call \
                         the function \"{function}\" inside it. Clear the button's \"Function to call\" field to run \
                         the macro.",
                        module.name
                    ),
                    module: Some(module.clone()),
                });
            }
            return CellPlan::ObjectScriptMacro { macro_id: module.id.clone() };
        }
        let filename = format!("button_{}.js", if module.name.is_empty() { "script" } else { module.name.as_str() });
        if function.is_empty() {
            return CellPlan::Script(Plan::Run {
                source: module.source.clone(),
                filename,
                module: Some(module.clone()),
                unavailable: Vec::new(),
            });
        }
        // A free-text field, and the button's params can themselves have arrived
        // in an application -- so it is an IDENTIFIER or it is nothing.
        if !is_bare_identifier(&function) {
            return CellPlan::Script(Plan::Refuse {
                reason: PlanRefusal::NotAFunctionName,
                message: format!(
                    "\"{function}\" is not a function name, so this button will not run. The \"Function to \
                     call\" field takes a single name, e.g. RunReport."
                ),
                module: Some(module.clone()),
            });
        }
        if module.is_distributed() {
            return CellPlan::Script(Plan::Refuse {
                reason: PlanRefusal::ComposesApplicationCode,
                message: format!(
                    "This button asks to call {function}() inside \"{}\", which arrived in the application \"{}\". \
                     Code from an application runs only as its published module, unchanged -- adding a call to it \
                     is code you have not approved. Clear the button's \"Function to call\" field to run the module \
                     as published.",
                    module.name,
                    application_label(module)
                ),
                module: Some(module.clone()),
            });
        }
        // The composition is allowed ONLY for a module of the user's own.
        return CellPlan::Script(Plan::Run {
            source: format!("{}\n{function}();", module.source),
            filename,
            module: None,
            unavailable: Vec::new(),
        });
    }

    CellPlan::Nothing {
        message: match from_application {
            Some(app) => format!(
                "This button came with the application '{app}' and has no action it can run in this workbook. \
                 To give it one of your own, use Insert > Cell Type > Button."
            ),
            None => "This button has no action configured (right-click > Cell Type)".to_string(),
        },
    }
}

// ============================================================================
// The door: `run_control_action`
// ============================================================================
//
// A click names a BUTTON -- its kind and its cell -- and nothing else. What it
// runs is read here, from the backend's own store, under one short guard; the
// plan is made from that copy; and whose code the plan's FINAL source is
// decides what is asked of it (`application_code_gate::button_run_gate`):
//
// * an application's held inline bytes: the approval of exactly those bytes
//   (`buttonAction:<sha256>` under the application's bare record);
// * a source a stored module of an application carries: that module's own
//   approval -- also when the user's OWN `Name()` or own button cell is what
//   asked for it, because this door does not pass through `run_script`'s gate;
// * either way, the working-copy private-sheet rule, and a row for every run
//   and every refusal, naming the button.
//
// Only a purely local composition (the user's own modules around the user's own
// code) is ungated; its `ScriptExecuted` rows name the button. Script Security
// is asked only of a run, after the gates and before the run row.

/// What a click on a button is about to do, decided from the store and the
/// stored modules -- before any approval is asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Decision {
    /// Run `source`, once the gate has ruled on whose code it is.
    Run(PlannedRun),
    /// The button links a macro: the page's phase-3 route runs it (the store's
    /// bytes, verified by Rust against the link). The door runs nothing.
    Link,
    /// A button cell whose action is a macro that runs only as an object
    /// script: the page's macro seam runs it, naming this cell as its trigger
    /// (owner decision B, F6). `application` is the BUTTON's stamp. The door
    /// runs nothing.
    Macro { macro_id: String, application: Option<String> },
    /// The user's own command: only the page can run an extension command.
    Command { command_id: String },
    /// A button CELL from `application` naming a Calcula command: the command
    /// gate decides (asked by the door with the consent file, which `decide`
    /// does not read); the button is as the store describes it.
    ApplicationCommand { command_id: String, application: String, button: ButtonAttribution },
    /// Nothing on the button to run (the page goes on to its object scripts).
    Nothing { message: Option<String> },
    /// Refused before any approval was asked.
    Refuse(DoorRefusal),
}

/// A run the planners produced, with the button it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PlannedRun {
    /// Exactly what the interpreter will be handed.
    pub source: String,
    pub unavailable: Vec<UnavailableModule>,
    /// The button, as the store describes it.
    pub button: ButtonAttribution,
    /// The application's held inline bytes this run is, when it is one.
    pub held: Option<HeldCode>,
}

/// A refusal the door answers before any approval is asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DoorRefusal {
    pub reason: String,
    pub message: String,
    pub row: RefusalRow,
}

/// Which audit row a refusal writes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RefusalRow {
    /// The user's own button, and nothing of an application's was asked for.
    Unrecorded,
    /// The button came with an application: `ButtonCodeRefused`, through the
    /// same core the page's own refusals use, so the viewer's labels do not fork.
    ButtonCode { refused: String },
    /// An application's code was asked for: `ApplicationCodeRefused`, naming
    /// the button.
    ApplicationCode {
        button: ButtonAttribution,
        application: String,
        ids: Vec<String>,
        source_hash: Option<String>,
    },
}

fn refuse(reason: &str, message: String, row: RefusalRow) -> Decision {
    Decision::Refuse(DoorRefusal { reason: reason.to_string(), message, row })
}

/// The row for a planner's refusal that names `module`: an application's
/// module is application code that was asked for; the user's own is not.
fn row_for_module(button: &ButtonAttribution, module: Option<&ModuleView>) -> RefusalRow {
    match module {
        Some(module) if module.is_distributed() => RefusalRow::ApplicationCode {
            button: button.clone(),
            application: module.application().unwrap_or_default().to_string(),
            ids: vec![module.id.clone()],
            source_hash: Some(calp::integrity::sha256_hex(module.source.as_bytes())),
        },
        _ => RefusalRow::Unrecorded,
    }
}

/// The ONE sentence for a click on a button cell whose action a checkout HELD.
/// The page's TypeScript copy (`describeHeldCellButtonClick`) was deleted when
/// the click moved to this door: this is the sentence's only speaker.
fn describe_held_cell_click(application: Option<&str>, version: &str) -> String {
    format!(
        "This button's action came with the application '{}'{} and does not run in a working copy: it runs a \
         macro the application did not bring in, or a command that is not on Calcula's list of commands such \
         buttons may run. A push publishes it unchanged, after checking it against the signed version. To give \
         the button an action of your own, use Insert > Cell Type > Button on this cell.",
        application.unwrap_or("an application"),
        if version.is_empty() { String::new() } else { format!(" (v{version})") }
    )
}

/// Decide what a click on the button at `request`'s cell runs.
///
/// LOCKS: the sheet names are cloned first; then ONE guard on the button's own
/// store (controls, or cell types) copies the button; the plan -- and the hash
/// the approval is asked of -- is made from that copy.
pub(crate) fn decide(
    state: &AppState,
    modules: &[ModuleView],
    request: &RunControlActionRequest,
) -> Result<Decision, String> {
    let sheet_name = state
        .sheet_names
        .read()
        .map_err(|e| e.to_string())?
        .get(request.sheet_index)
        .cloned()
        .unwrap_or_else(|| format!("Sheet{}", request.sheet_index + 1));
    let cell = format!("{}!{}", sheet_name, a1(request.row, request.col));
    let key = (request.sheet_index, request.row, request.col);
    match request.kind {
        ControlActionKind::Control => {
            let meta = state.controls.read().map_err(|e| e.to_string())?.get(&key).cloned();
            Ok(decide_control(meta, cell, modules))
        }
        ControlActionKind::Cell => {
            let assignment = state.cell_types.read().map_err(|e| e.to_string())?.get(&key).cloned();
            Ok(decide_cell(assignment, cell, modules))
        }
    }
}

/// A button CONTROL: precedence exactly as the click has always read it -- a
/// link (live, else held) first, then the user's own inline code, then the
/// application's held inline code.
fn decide_control(meta: Option<ControlMetadata>, cell: String, modules: &[ModuleView]) -> Decision {
    let Some(meta) = meta else {
        return Decision::Nothing { message: None };
    };
    let slot = |key: &str| meta.properties.get(key).filter(|p| !p.value.is_empty()).cloned();
    let came_with_application = holds_application_code(&meta) || meta.properties.contains_key(HELD_FROM_PROPERTY);
    // Only a button runs code when it is clicked. The admission holds ANY
    // control's code, so a push restores it faithfully -- and this refuses it.
    if meta.control_type != "button" {
        return refuse(
            "notAButton",
            format!(
                "The control at {cell} is a '{}', and only a button runs code when it is clicked, so nothing ran.",
                meta.control_type
            ),
            if came_with_application {
                RefusalRow::ButtonCode { refused: "its code".to_string() }
            } else {
                RefusalRow::Unrecorded
            },
        );
    }
    if slot(MACRO_REF_PROPERTY).is_some() || slot(HELD_MACRO_REF_PROPERTY).is_some() {
        return Decision::Link;
    }
    let caption = meta.properties.get("text").map(|p| p.value.clone()).unwrap_or_default();

    if let Some(live) = slot(ON_SELECT_PROPERTY) {
        let button = ButtonAttribution { kind: MacroLinkKind::Control, cell, caption, application: None, held: false };
        return match plan_own_inline(&live.value, modules) {
            Plan::Run { source, unavailable, .. } => Decision::Run(PlannedRun { source, unavailable, button, held: None }),
            Plan::Refuse { reason, message, module } => {
                let row = row_for_module(&button, module.as_ref());
                refuse(reason.as_str(), message, row)
            }
        };
    }

    let Some(held) = slot(HELD_ON_SELECT_PROPERTY) else {
        return Decision::Nothing { message: None };
    };
    let Some(from) = meta.properties.get(HELD_FROM_PROPERTY).and_then(|p| HeldFrom::decode(&p.value)) else {
        return refuse(
            "stampUnreadable",
            format!(
                "The button at {cell} holds code that came with an application, but its record of which \
                 application that was cannot be read, so it did not run."
            ),
            RefusalRow::ButtonCode { refused: "its inline code".to_string() },
        );
    };
    // Only STATIC code is approvable: the approval is of exact bytes that run
    // as themselves. A formula-typed slot (kept for a faithful push) is not.
    if held.value_type != "static" || from.value_type_of(ON_SELECT_PROPERTY) != "static" {
        return refuse(
            "unsupportedValueType",
            format!(
                "The action of the button at {cell} came with the application '{}' as a formula, which Calcula \
                 does not run as button code, so it did not run.",
                from.application
            ),
            RefusalRow::ButtonCode { refused: "its inline code".to_string() },
        );
    }
    let button = ButtonAttribution {
        kind: MacroLinkKind::Control,
        cell,
        caption,
        application: Some(from.application.clone()),
        held: true,
    };
    let code = held.value;
    match plan_held_inline(&code, &from.application, modules) {
        Plan::Run { source, unavailable, .. } => Decision::Run(PlannedRun {
            source,
            unavailable,
            button,
            held: Some(HeldCode { application: from.application, code }),
        }),
        Plan::Refuse { reason, message, module } => {
            let mut ids = vec![button_action_consent_id(&code)];
            if let Some(module) = &module {
                ids.push(module.id.clone());
            }
            let row = RefusalRow::ApplicationCode {
                button,
                application: from.application,
                ids,
                source_hash: Some(calp::integrity::sha256_hex(code.as_bytes())),
            };
            refuse(reason.as_str(), message, row)
        }
    }
}

/// A button CELL: a held action never runs (a working copy), a stamp that
/// cannot be read is not the user's own, and the rest is `plan_cell_action`.
fn decide_cell(
    assignment: Option<crate::cell_types::CellTypeAssignment>,
    cell: String,
    modules: &[ModuleView],
) -> Decision {
    let Some(assignment) = assignment.filter(|a| a.type_id == crate::button_cells::BUTTON_CELL_TYPE_ID) else {
        return Decision::Nothing { message: None };
    };
    let params = &assignment.params;
    let present = |key: &str| params.get(key).filter(|v| !v.is_null());
    let action = present(crate::button_cells::ACTION_PARAM);
    // The stamp, read the ONE way the click's audit core reads it too, so a
    // refusal and its row never name two different applications.
    let stamp = crate::button_cells::cell_stamp(params);
    if action.is_none() && present(crate::button_cells::HELD_ACTION_PARAM).is_some() {
        let (application, version) = match &stamp {
            CellStamp::Application { application, version } => (Some(application.as_str()), version.as_str()),
            CellStamp::Own | CellStamp::Unreadable => (None, ""),
        };
        return refuse(
            "heldInWorkingCopy",
            describe_held_cell_click(application, version),
            RefusalRow::ButtonCode { refused: "its held action".to_string() },
        );
    }
    let application = match stamp {
        CellStamp::Own => None,
        CellStamp::Application { application, .. } => Some(application),
        CellStamp::Unreadable => {
            return refuse(
                "stampUnreadable",
                format!(
                    "The button cell at {cell} carries a record of which application it came with that cannot \
                     be read, so it did not run. To give it an action of your own, use Insert > Cell Type > \
                     Button."
                ),
                RefusalRow::ButtonCode { refused: "its action".to_string() },
            );
        }
    };
    let caption = params.get("label").and_then(Value::as_str).unwrap_or_default().to_string();
    let button = ButtonAttribution {
        kind: MacroLinkKind::Cell,
        cell,
        caption,
        application: application.clone(),
        held: false,
    };
    let none = Value::Null;
    let action = action.unwrap_or(&none);
    match plan_cell_action(action, application.as_deref(), modules) {
        CellPlan::Command { command_id } => Decision::Command { command_id },
        CellPlan::ApplicationCommand { command_id } => Decision::ApplicationCommand {
            command_id,
            // `plan_cell_action` answers ApplicationCommand only for a stamped
            // button, so the application is always there.
            application: application.clone().unwrap_or_default(),
            button,
        },
        // The BUTTON's stamp travels with the answer: the page asks the macro
        // seam for exactly that application's macro (`requirePackage`), and the
        // run gate checks the same stamp from this store (`verify_trigger`).
        CellPlan::ObjectScriptMacro { macro_id } => Decision::Macro { macro_id, application: application.clone() },
        CellPlan::Nothing { message } => Decision::Nothing { message: Some(message) },
        CellPlan::Script(Plan::Run { source, unavailable, .. }) => {
            Decision::Run(PlannedRun { source, unavailable, button, held: None })
        }
        CellPlan::Script(Plan::Refuse { reason, message, module }) => {
            let about_application_code = matches!(
                reason,
                PlanRefusal::ObjectScriptMacro | PlanRefusal::Ambiguous | PlanRefusal::ComposesApplicationCode
            ) && module.as_ref().is_some_and(ModuleView::is_distributed);
            let row = if about_application_code {
                row_for_module(&button, module.as_ref())
            } else if application.is_some() {
                // A stamped COMMAND never gets here: it is the command gate's.
                let what = format!(
                    "the macro \"{}\"",
                    module
                        .as_ref()
                        .map(|m| m.name.clone())
                        .or_else(|| action.get("scriptId").and_then(Value::as_str).map(str::to_string))
                        .unwrap_or_default()
                );
                RefusalRow::ButtonCode { refused: what }
            } else {
                row_for_module(&button, module.as_ref())
            };
            refuse(reason.as_str(), message, row)
        }
    }
}

/// Write the row a door refusal names.
fn record_door_refusal(state: &AppState, request: &RunControlActionRequest, refusal: &DoorRefusal) {
    match &refusal.row {
        RefusalRow::Unrecorded => {}
        RefusalRow::ButtonCode { refused } => {
            let kind = match request.kind {
                ControlActionKind::Control => MacroLinkKind::Control,
                ControlActionKind::Cell => MacroLinkKind::Cell,
            };
            if let Err(why) = crate::button_cells::audit_button_refusal_core(
                state,
                kind,
                request.sheet_index,
                request.row,
                request.col,
                refused,
                &refusal.reason,
            ) {
                log::warn!("[button door] the refusal of a click could not be recorded: {why}");
            }
        }
        RefusalRow::ApplicationCode { button, application, ids, source_hash } => {
            record_button_code_refused(
                state,
                application,
                ids.clone(),
                source_hash.clone(),
                &refusal.reason,
                refusal_phrase(&refusal.reason),
                button,
                Vec::new(),
            );
        }
    }
}

/// The short "why" a refusal row's description carries.
fn refusal_phrase(reason: &str) -> &'static str {
    match reason {
        "objectScriptMacro" => "it calls by name a macro that runs as an object script",
        "ambiguous" => "more than one module answers to the name it calls",
        "composesApplicationCode" => "it would add a call to the application's module",
        _ => "the button may not run it",
    }
}

/// What the door does next, decided without the interpreter.
#[derive(Debug)]
pub(crate) enum DoorAnswer {
    /// Answered without running anything (a link, a macro for the seam, a
    /// command, nothing, or a refusal that has already been recorded).
    Answer(ControlActionOutcome),
    /// Approved, ruled, admitted by Script Security and -- for an application's
    /// code -- recorded: hand this to the interpreter.
    Run(ApprovedClick),
}

/// A run the door has admitted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ApprovedClick {
    pub source: String,
    pub filename: String,
    /// The button's cell ("Dashboard!B2"): the `ScriptExecuted` rows' surface id.
    pub surface_id: String,
    pub unavailable: Vec<UnavailableModule>,
}

/// The body of [`run_control_action`] up to the interpreter, over plain
/// references for the unit tier. Order: decide (from the store) -> the gate
/// (whose code; the approval; the private-sheet rule; every refusal recorded)
/// -> Script Security (a run only: a link, a macro for the seam, a command and
/// nothing are answered before it -- the seam asks Script Security itself) ->
/// the run row.
///
/// An application's command is judged against THE list,
/// `button_cells::DISTRIBUTABLE_BUTTON_COMMANDS`.
pub(crate) fn run_control_action_core(
    state: &AppState,
    script_state: &ScriptState,
    user_files: &UserFilesState,
    request: &RunControlActionRequest,
) -> Result<DoorAnswer, String> {
    run_control_action_core_with(state, script_state, user_files, request, DISTRIBUTABLE_BUTTON_COMMANDS)
}

/// [`run_control_action_core`] with the command list as a parameter, so the
/// unit tier can prove the command route with a list that is not empty.
/// Production passes `DISTRIBUTABLE_BUTTON_COMMANDS` and nothing else (pinned
/// by a census).
pub(crate) fn run_control_action_core_with(
    state: &AppState,
    script_state: &ScriptState,
    user_files: &UserFilesState,
    request: &RunControlActionRequest,
    allowed_commands: &[&str],
) -> Result<DoorAnswer, String> {
    // The stored modules under ONE short guard: the planners' view, and the
    // ownership triples the approval question is asked over.
    let (modules, scripts) = {
        let map = script_state.workbook_scripts.read().map_err(|e| e.to_string())?;
        let triples: Vec<(Option<String>, String, String)> =
            map.values().map(|s| (s.source_package.clone(), s.id.clone(), s.source.clone())).collect();
        (module_views(&map), triples)
    };
    let planned = match decide(state, &modules, request)? {
        Decision::Run(planned) => planned,
        Decision::Link => return Ok(DoorAnswer::Answer(ControlActionOutcome::Link)),
        Decision::Macro { macro_id, application } => {
            return Ok(DoorAnswer::Answer(ControlActionOutcome::Macro { macro_id, application }));
        }
        Decision::Command { command_id } => {
            return Ok(DoorAnswer::Answer(ControlActionOutcome::Command { command_id, application: None }));
        }
        // An application's command: the command gate's CHECK -- the list, the
        // approval under its own key, the private-sheet rule, every refusal
        // recorded and no run row (the page has not checked its half yet; the
        // run row is `authorize_button_command`'s). Answered before Script
        // Security, like the user's own command: what runs is Calcula's own
        // command, not a script.
        Decision::ApplicationCommand { command_id, application, button } => {
            let consent_file = crate::calp_commands::read_script_consent_file_in(user_files);
            let outcome = match button_command_gate(
                state,
                consent_file.as_ref(),
                &button,
                &application,
                &command_id,
                allowed_commands,
                CommandGatePhase::Check,
            ) {
                Ok(()) => ControlActionOutcome::Command { command_id, application: Some(application) },
                Err(refusal) => {
                    ControlActionOutcome::Refused { reason: refusal.reason.to_string(), message: refusal.message }
                }
            };
            return Ok(DoorAnswer::Answer(outcome));
        }
        Decision::Nothing { message } => return Ok(DoorAnswer::Answer(ControlActionOutcome::Nothing { message })),
        Decision::Refuse(refusal) => {
            record_door_refusal(state, request, &refusal);
            return Ok(DoorAnswer::Answer(ControlActionOutcome::Refused {
                reason: refusal.reason,
                message: refusal.message,
            }));
        }
    };
    // The approvals THIS computer sealed, and nothing else.
    let consent_file = crate::calp_commands::read_script_consent_file_in(user_files);
    let ruled = match button_run_gate(
        state,
        &scripts,
        consent_file.as_ref(),
        &planned.button,
        planned.held.as_ref(),
        &planned.source,
    ) {
        Ok(ruled) => ruled,
        Err(refusal) => {
            return Ok(DoorAnswer::Answer(ControlActionOutcome::Refused {
                reason: refusal.reason.to_string(),
                message: refusal.message,
            }));
        }
    };
    // Script Security's prompt sentinel is unchanged, so the page's
    // prompt-and-retry still works, and that is not recorded: the page asks
    // and the retry is recorded as what it then is. Scripts DISABLED is a final
    // answer -- for an application's approved code it is a refusal of that
    // code, and on the trail like every other one.
    if let Err(security) = check_script_security(script_state) {
        if let ButtonGateAnswer::Application(run) = &ruled {
            if security.starts_with(SCRIPTS_DISABLED) {
                record_button_run_refused(
                    state,
                    run,
                    &planned.button,
                    "scriptsDisabled",
                    "Script Security is set to disable scripts",
                );
            }
        }
        return Err(security);
    }
    if let ButtonGateAnswer::Application(run) = &ruled {
        record_button_run(state, run, &planned.button);
    }
    Ok(DoorAnswer::Run(ApprovedClick {
        filename: format!("button_{}.js", planned.button.cell.replace('!', "_")),
        surface_id: planned.button.cell.clone(),
        source: planned.source,
        unavailable: planned.unavailable,
    }))
}

/// Run what a click on a button asks for: the ONE door every button click
/// takes (phase 4 of BUG-0257). The request names the button -- its kind and
/// its cell -- and NEVER code (`deny_unknown_fields`): the code is read from
/// the backend's own store, approved by the hash of its exact bytes when it
/// came with an application, ruled by the working-copy private-sheet rule, and
/// audited, run and refusal alike. Main window only. Denylisted for non-trusted
/// callers under `codeExecution` (backendCommands.ts).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn run_control_action(
    state: tauri::State<AppState>,
    script_state: tauri::State<ScriptState>,
    file_state: tauri::State<FileState>,
    user_files_state: tauri::State<UserFilesState>,
    pivot_state: tauri::State<'_, crate::pivot::PivotState>,
    pane_control_state: tauri::State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: tauri::State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: RunControlActionRequest,
    window: tauri::Window,
) -> Result<ControlActionOutcome, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    match run_control_action_core(&state, &script_state, &user_files_state, &request)? {
        DoorAnswer::Answer(outcome) => Ok(outcome),
        DoorAnswer::Run(click) => {
            let result = run_in_interpreter(
                &state,
                &file_state,
                &user_files_state,
                &pivot_state,
                &pane_control_state,
                &ribbon_filter_state,
                &click.source,
                &click.filename,
                request.view_state.as_ref(),
                None,
                None,
                "button",
                &click.surface_id,
            )?;
            Ok(ControlActionOutcome::Ran { result, unavailable: click.unavailable })
        }
    }
}

// ============================================================================
// An application's button command: the second question (plan_M8 S1)
// ============================================================================

/// What the button cell at the claimed position holds, in words, for a claim
/// it does not back.
fn describe_stored_cell_action(params: &Value, cell: &str) -> String {
    let present = |key: &str| params.get(key).filter(|v| !v.is_null());
    match present(crate::button_cells::ACTION_PARAM) {
        Some(action) => match action.get("kind").and_then(Value::as_str) {
            Some("command") => format!(
                "the button cell at {cell} runs the command \"{}\"",
                action.get("commandId").and_then(Value::as_str).unwrap_or_default()
            ),
            Some("script") => format!("the button cell at {cell} runs a macro, not a command"),
            _ => format!("the button cell at {cell} has an action this version of Calcula does not recognise"),
        },
        None if present(crate::button_cells::HELD_ACTION_PARAM).is_some() => {
            format!("the button cell at {cell} holds its action for a working copy, where it does not run")
        }
        None => format!("the button cell at {cell} has no action"),
    }
}

/// The body of [`authorize_button_command`] over plain references, for the
/// unit tier. `allowed` is the command list; production passes
/// `DISTRIBUTABLE_BUTTON_COMMANDS` and nothing else (pinned by a census).
///
/// Order -- STORAGE first, then the gate:
///
/// 1. The claimed cell must be a button cell. None there: refused, and no row
///    -- there is no application to name.
/// 2. Its stamp, read the ONE way (`button_cells::cell_stamp`): a button of
///    the user's own is refused with no row (its command runs without asking,
///    so the page never asks for one); a stamp that cannot be read is refused
///    and recorded as such (`ButtonCodeRefused`, `stampUnreadable`).
/// 3. Its LIVE action must be exactly `{kind: "command", commandId}` with the
///    claimed id. Anything else -- another command, a macro, no action, an
///    action held for a working copy -- is refused `triggerMismatch`, the
///    claim recorded as `claimedTrigger`.
/// 4. `application_code_gate::button_command_gate`, phase `Admitted`: the list,
///    the approval under `button-commands:<application>`, the private-sheet
///    rule, and -- only when all pass -- the always-on run row.
pub(crate) fn authorize_button_command_core(
    state: &AppState,
    user_files: &UserFilesState,
    request: &AuthorizeButtonCommandRequest,
    allowed: &[&str],
) -> Result<(), String> {
    let sheet_name = state
        .sheet_names
        .read()
        .map_err(|e| e.to_string())?
        .get(request.sheet_index)
        .cloned()
        .unwrap_or_else(|| format!("Sheet{}", request.sheet_index + 1));
    let cell = format!("{}!{}", sheet_name, a1(request.row, request.col));
    let key = (request.sheet_index, request.row, request.col);
    // ONE short guard on the store; everything below judges this copy.
    let assignment = state.cell_types.read().map_err(|e| e.to_string())?.get(&key).cloned();
    let Some(assignment) = assignment.filter(|a| a.type_id == crate::button_cells::BUTTON_CELL_TYPE_ID) else {
        return Err(format!(
            "{APPLICATION_CODE_TRIGGER_MISMATCH}: there is no button cell at {cell}, so the command \"{}\" did not run.",
            request.command_id
        ));
    };
    let params = &assignment.params;
    let application = match crate::button_cells::cell_stamp(params) {
        CellStamp::Own => {
            return Err(format!(
                "{APPLICATION_CODE_TRIGGER_MISMATCH}: the button cell at {cell} did not come with an application, so \
                 there is no application's command to allow there. A button of your own runs its command without \
                 asking; nothing ran."
            ));
        }
        CellStamp::Unreadable => {
            let refused = format!("the command \"{}\"", request.command_id);
            if let Err(why) = crate::button_cells::audit_button_refusal_core(
                state,
                MacroLinkKind::Cell,
                request.sheet_index,
                request.row,
                request.col,
                &refused,
                "stampUnreadable",
            ) {
                log::warn!("[button door] the refusal of a command could not be recorded: {why}");
            }
            return Err(format!(
                "The button cell at {cell} carries a record of which application it came with that cannot be read, \
                 so the command \"{}\" did not run.",
                request.command_id
            ));
        }
        CellStamp::Application { application, .. } => application,
    };
    let stored = params
        .get(crate::button_cells::ACTION_PARAM)
        .filter(|a| a.get("kind").and_then(Value::as_str) == Some("command"))
        .and_then(|a| a.get("commandId"))
        .and_then(Value::as_str);
    if stored != Some(request.command_id.as_str()) {
        let why = describe_stored_cell_action(params, &cell);
        let trigger = ScriptRunTrigger {
            kind: ScriptRunTriggerKind::ButtonCell,
            sheet_index: request.sheet_index,
            row: request.row,
            col: request.col,
        };
        record_button_command_mismatch(state, &application, &request.command_id, &trigger, &why);
        return Err(button_command_mismatch_refusal(&application, &request.command_id, &why));
    }
    let button = ButtonAttribution {
        kind: MacroLinkKind::Cell,
        cell,
        caption: params.get("label").and_then(Value::as_str).unwrap_or_default().to_string(),
        application: Some(application.clone()),
        held: false,
    };
    // The approvals THIS computer sealed, and nothing else.
    let consent_file = crate::calp_commands::read_script_consent_file_in(user_files);
    button_command_gate(
        state,
        consent_file.as_ref(),
        &button,
        &application,
        &request.command_id,
        allowed,
        CommandGatePhase::Admitted,
    )
    .map_err(|refusal| refusal.message)
}

/// THE SECOND QUESTION of an application's button command (plan_M8 S1). The
/// button door answered `command` with the application for the button cell
/// the click named; the page has since checked that the command's LIVE
/// registration opts in (`distributableTrigger`) and is not shadowed. Before it
/// runs the command it asks this: the cell must still hold exactly that
/// command under an application's stamp, and the command gate is asked again
/// -- Rust's list, the approval under `button-commands:<application>`, the
/// working-copy private-sheet rule -- and only then is the always-on run row
/// written. `Ok(())` is the only answer the page may run the command on; every
/// refusal is already recorded.
///
/// The request names a cell and a command id and nothing else
/// (`deny_unknown_fields`): the application is read from the cell's stamp.
/// Main window only. Denylisted for non-trusted callers under `codeExecution`
/// (backendCommands.ts). It writes only the audit trail, whose writer decides
/// its own `DocumentEffect` (`deliberately_clean(AuditTrail)`).
#[tauri::command]
pub fn authorize_button_command(
    state: tauri::State<AppState>,
    user_files_state: tauri::State<UserFilesState>,
    request: AuthorizeButtonCommandRequest,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    authorize_button_command_core(&state, &user_files_state, &request, DISTRIBUTABLE_BUTTON_COMMANDS)
}

#[cfg(test)]
#[path = "control_action_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "control_action_door_tests.rs"]
mod door_tests;
