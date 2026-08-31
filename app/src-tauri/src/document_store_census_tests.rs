//! FILENAME: app/src-tauri/src/document_store_census_tests.rs
//! PURPOSE: The DOCUMENT-SCOPED STORE CENSUS — every store the save path reads,
//!          AND every field of every State, must be reset when the document is
//!          replaced or carry a written reason why it is not the document's.
//! CONTEXT: The acceptance test for a whole defect class. See the module docs below.

//! # The invariants — there are two, and the second one is why the first was
//! # not enough
//!
//! > 1. **A store that either PROJECTION path reads — the `.cala` save
//! >    (`assemble_workbook_for_save`) or the `.calp` publish
//! >    (`assemble_publish_workbook`) — is reset by the document-replacing
//! >    paths.**
//! > 2. **Every field of every State those paths reset is either reset by the
//! >    shared function, or written down as session- or machine-scoped.**
//!
//! Invariant 1 shipped first and could never have caught defect 4a. The UNDO
//! STACK is not a save source, so the save path's sources — however completely
//! enumerated — do not contain it. It nevertheless belongs to the document:
//! an `UndoTransaction` records (sheet, row, col) and a before-value and names
//! no document at all. `new_file` cleared it inline, in a block honestly
//! labelled *"session state that is NOT a save source"*; `open_file` had no
//! equivalent. So: open A, edit a cell, open B, press Ctrl+Z once — and B's cell
//! is overwritten with A's value, and saved that way. Measured on the bytes.
//!
//! That is the shape invariant 2 answers. It asks the question the save path
//! cannot ask ("is this field the DOCUMENT's?") of a set nothing can hide in
//! (every field of every State), and it forces the answer to be written down.
//! `SESSION_SCOPED` is the list of things that really are not the document's,
//! and it is small, argued and dangerous to get wrong in either direction:
//! `ScriptState.permission_grants` must NOT be reset (it would re-arm scripts
//! the user turned off), and `AppState.undo_stack` must be, and "session state"
//! reads like a reason for both.
//!
//! # Why this file exists rather than three more `clear()` calls
//!
//! `new_file` did not take `PivotState`, `RibbonFilterState` or `BiState`, and
//! nothing else reset them. The save path nevertheless projects all three into
//! the workbook. So: give workbook A a model connection, a pivot and a ribbon
//! filter; File > New; type one cell; save as B — and B physically contains A's
//! pivot, A's ribbon filter and A's WHOLE EMBEDDED MODEL. Confirmed on the bytes,
//! cold, before this census existed.
//!
//! Two of the three leaked only across File > New, because `restore_pivot_definitions`
//! and `restore_ribbon_filters` happen to clear before refilling. `BiState` leaked
//! across Open too — `restore_local_bi_connections` only ADDS — so connections
//! accumulated for the lifetime of the process and every save embedded all of them.
//!
//! This is data INJECTION, the mirror image of a lost write, which is why the
//! sweeps that hunted for lost writes walked straight past it. It has a
//! confidentiality edge those did not: a workbook you send someone can silently
//! carry a connection, and an entire semantic model, from an unrelated one.
//!
//! Fixing the three by hand would have left the fourth to be found the same way.
//! The three answers that were wrong were wrong for the same reason — nothing
//! ever compared the save path's inputs against the reset paths' outputs — and
//! that comparison is a test. Hence this census: it ENUMERATES the crate, so it
//! fails for the store nobody thought of.
//!
//! # The hardening lessons — two inherited, one bought here, one paid for twice
//!
//! 1. **It must see through a delegating helper.** Both sides delegate: the save
//!    path reads `BiState` only inside `capture_local_bi_connections`, and the
//!    reset reaches it only inside `reset_bi_connections`. A census that read
//!    just the two top-level bodies would see neither and pass while both halves
//!    were missing.
//! 2. **A commented-out call must not satisfy it.** Every call site here is
//!    wrapped in a comment explaining it, so a careless deletion leaves the name
//!    behind as text. Both sides therefore read comment-stripped code.
//! 3. **A free function is not an `impl` method.** `parse_fn_header` takes
//!    indentation 0 only, because at `indent <= 4` a `Drop` impl's `fn drop`
//!    resolves as the `drop(guard)` every lock release calls and walks the call
//!    graph out of the save path entirely.
//! 4. **A method chain broken across lines is still a read.** Added when 4a was
//!    fixed, and it was not theoretical: `collect_protection_for_save` and
//!    `attach_pending_recalc_for_save` are both written as wrapped chains, so
//!    the census had never seen either — two save sources, one of them a live
//!    leak, behind a scanner that read one line at a time. See
//!    `join_method_chains`.
//!
//! All four are asserted, on synthetic sources, by
//! `the_census_detector_actually_fires` and `the_field_census_detector_actually_fires`
//! below — so they run on every build instead of once in somebody's head.
//!
//! # The delegation invariant
//!
//! The collapse buys one more property, and it is the cheapest of the lot to
//! check: **both document-replacing paths run the same function, so anything
//! either of them resets outside it is a bug.** `new_file` must therefore touch
//! no store at all (`new_file_delegates_every_store_reset`) and `open_file` must
//! touch no store the reset does not also cover
//! (`open_file_touches_no_store_the_reset_does_not_cover`). Defect 4a is
//! precisely a violation of the first: ~50 lines of resets `new_file` kept to
//! itself, none of which `open_file` ever ran.

use std::collections::{BTreeMap, BTreeSet};

// ---------------------------------------------------------------------------
// The census
// ---------------------------------------------------------------------------

/// The receivers that name a document-scoped store, and the store they name.
///
/// Keyed on the parameter NAME because that is what the crate is written in:
/// `state` is always the `AppState`, `bi_state` is always the `BiState`, in the
/// save path and in the reset alike. A receiver not in this table (a local
/// guard, a `Connection`, a `Workbook`) is not a store and is ignored.
const RECEIVERS: &[(&str, &str)] = &[
    ("state", "AppState"),
    ("app_state", "AppState"),
    ("user_files_state", "UserFilesState"),
    ("slicer_state", "SlicerState"),
    ("ribbon_filter_state", "RibbonFilterState"),
    ("pane_control_state", "PaneControlState"),
    ("script_state", "ScriptState"),
    ("pivot_state", "PivotState"),
    ("bi_state", "BiState"),
    ("timeline_slicer_state", "TimelineSlicerState"),
];

/// THE ROOTS OF THE SAVE-SOURCE CENSUS — both of them.
///
/// The census used to root at `assemble_workbook_for_save` alone, because the
/// `.cala` save is the path §2w's leak was measured on. It is not the only path
/// that PROJECTS the live stores into a file somebody else opens.
/// `assemble_publish_workbook` is the other: it builds the `.calp` carrier for
/// `calp_publish`, and a `.calp` is by construction sent to other people, so it
/// carries the confidentiality edge that made §2w matter *more* than the save
/// path does, not less. A store the publish path reads and the reset does not
/// clear would put the previous document's content into a package a subscriber
/// pulls, and until now nothing would have failed.
///
/// **Rooting it here was measured to cost nothing**, which is the whole reason
/// it can be done as a one-line hardening instead of a project: the two paths'
/// source sets overlap almost completely (publish calls
/// `build_workbook_for_save_with_slicers`, `collect_pane_controls_for_save`,
/// `collect_scripts_for_save`, `collect_notebooks_for_save`,
/// `collect_pivot_definitions` and `capture_local_bi_connections` — the save
/// path's own collectors), and every store only the publish path reads was
/// already reset. `the_two_projection_roots_are_both_real_and_the_publish_root_adds_no_demands`
/// pins that measurement so the claim is re-checked on every build rather than
/// believed because it was true once.
///
/// A THIRD projection path (a new export format, a new package kind) belongs
/// here the day it is written. The test below asserts each name resolves to
/// exactly one free function, so a rename cannot silently drop a root and leave
/// the census passing over half the surface.
const SAVE_ROOTS: &[&str] = &["assemble_workbook_for_save", "assemble_publish_workbook"];

/// The reset, and the helpers it delegates to.
///
/// A SHORT EXPLICIT LIST, not a transitive walk, and that is deliberate: the
/// reset side must not be able to count a function that merely *reads* a store
/// as having reset it. Every name here exists only to reset. The list cannot
/// drift, because `the_reset_delegates_to_every_helper_the_census_credits`
/// asserts that `reset_document_scoped_stores` really calls each of the others —
/// an entry that stopped being part of the reset would stop being called, and
/// the census would notice before it silently started excusing a store.
const RESET_FUNCTIONS: &[&str] = &[
    "reset_document_scoped_stores",
    "reset_default_geometry",
    "init_builtin_named_styles",
    "reset_bi_connections",
];

/// The two commands that replace the open document, both of which must run the
/// reset. Enumerated rather than asserted in prose because §2w's whole cause was
/// a claim about two call sites nobody had compared.
///
/// This IS the complete list, and the enumeration that produced it is recorded
/// here so the next reader does not have to redo it. A document-replacing path
/// is one that ends holding a DIFFERENT document than it started with; both of
/// these are `#[tauri::command]`s with no in-crate callers, and there is no
/// third. In particular:
///
/// * **AutoRecover restore is `open_file`.** A `.calar` snapshot is routed to the
///   Calcula reader by `format_extension` and opened through the ordinary open
///   path — there is no separate restore command (pinned by
///   `autorecover_snapshots_route_to_the_calcula_reader`).
/// * **`.calp` pull, refresh and reset-to-published are NOT document-replacing.**
///   They materialize package content INTO the open document and are the one
///   flow that legitimately SUPPLIES a BI connection: a subscribed report needs
///   its model, and `load_embedded_data_sources` is the only thing that ever
///   creates one for a package data source. Running the reset there would delete
///   the connection the pull had just created. The connection therefore lives
///   exactly as long as the document that pulled it, which is the correct
///   lifetime and the one this census enforces at both ends.
/// `calp_checkout` is the third: opening a published package as a WORKING COPY
/// replaces the document exactly as File > Open does — the package's sheets,
/// scripts, model and controls become the workbook. It differs from the other
/// two only in where the content comes from and in ending DIRTY (the working
/// copy has no file of its own yet), neither of which changes what has to be
/// torn down first.
const DOCUMENT_REPLACING_PATHS: &[&str] = &["new_file", "open_file", "calp_checkout"];

/// Stores the save path reads that the reset deliberately does not touch.
///
/// EMPTY, and it should stay that way. It exists because an exemption is a
/// DECISION, and the mechanism for recording one has to be present before it is
/// needed — a census with no way to say "no, deliberately" gets a `#[ignore]`
/// bolted onto it the first time somebody disagrees with it. Every entry must
/// carry a reason somebody wrote; `every_exemption_carries_a_written_reason`
/// refuses an empty one.
const EXEMPT: &[(&str, &str)] = &[];

// ---------------------------------------------------------------------------
// The FIELD census — the other half, and the one the save-path census could
// never have covered
// ---------------------------------------------------------------------------

/// Where each State is declared: `(store name, file, struct name)`.
///
/// This is the set of States `reset_document_scoped_stores` is handed, which is
/// the set a document-replacing path can put back to blank. It is checked
/// against the reset's own signature by
/// `the_field_census_covers_every_state_the_reset_is_given`, so a ninth State
/// cannot be added to the reset without appearing here.
const STATE_FIELD_SOURCES: &[(&str, &str, &str)] = &[
    ("AppState", "lib.rs", "AppState"),
    ("UserFilesState", "persistence.rs", "UserFilesState"),
    ("SlicerState", "slicer/types.rs", "SlicerState"),
    ("RibbonFilterState", "ribbon_filter/types.rs", "RibbonFilterState"),
    ("PaneControlState", "pane_control/types.rs", "PaneControlState"),
    ("ScriptState", "scripting/types.rs", "ScriptState"),
    ("PivotState", "pivot/types.rs", "PivotState"),
    ("BiState", "bi/types.rs", "BiState"),
    ("TimelineSlicerState", "timeline_slicer/types.rs", "TimelineSlicerState"),
];

/// Fields the reset clears through a call that is not `read`/`write`/`lock`.
///
/// The escape hatch for a store whose teardown is a METHOD rather than a guard,
/// and it is deliberately the narrowest one available: the entry names the exact
/// call text, and the field census credits it only if that text appears in the
/// comment-stripped reset closure. A comment cannot satisfy it and a rename
/// cannot silently keep it satisfied.
const RESET_BY_METHOD_CALL: &[(&str, &str)] = &[
    (
        "BiState.engine_registry",
        "bi_state.engine_registry.release(",
    ),
    (
        "ScriptState.notebook_executor",
        "script_state.notebook_executor.reset_detached(",
    ),
];

/// Fields that are NOT the document's, with the reason each one is not.
///
/// THE OTHER HALF OF THE CENSUS, and the half that would have caught defect 4a.
/// `EXEMPT` above answers "the save path reads this and the reset does not clear
/// it — why?". This list answers the question the save path cannot even ask:
/// **a field nothing serialises can still belong to the document**, and the undo
/// stack is the proof. It was invisible to the save-source census by
/// construction, and the fix for it is worthless if the next such field goes in
/// unnoticed. So every field of every State is either reset by the shared
/// function or listed here with a written reason.
///
/// The line is "is this the DOCUMENT's?", never "is this stateful?". A wrong
/// entry here is a silent re-arm — `ScriptState.permission_grants` is the
/// standing example: clearing it would re-ask nothing and quietly restore
/// execute consent the user had withdrawn. Behaviour-side counterweights for
/// these live in `document_store_reset_tests.rs`
/// (`the_reset_leaves_application_state_alone`).
const SESSION_SCOPED: &[(&str, &str)] = &[
    // -- Application preferences: the user's, not the workbook's --------------
    // None of these is persisted, which is the same fact from the other side:
    // if one ever becomes a save source, the save-path census demands a reset
    // and its exemption here has to go.
    (
        "AppState.calculation_mode",
        "Automatic vs Manual is an application preference in Calcula (nothing serialises it), and it is a choice the user makes ABOUT their session. Resetting it would silently put a user who had switched to Manual — usually because automatic recalculation was too slow — back on Automatic at every File > Open",
    ),
    (
        "AppState.iteration_enabled",
        "iterative calculation is an application preference; already named as deliberately untouched when the reset was collapsed",
    ),
    (
        "AppState.max_iterations",
        "the iteration limit travels with iteration_enabled and is the same preference",
    ),
    (
        "AppState.max_change",
        "the convergence threshold travels with iteration_enabled and is the same preference",
    ),
    (
        "AppState.locale",
        "decimal/list separators and date format are the machine's regional settings; a document does not carry them, and resetting would reformat the user's numbers on File > New",
    ),
    (
        "AppState.reference_style",
        "A1 vs R1C1 is how the USER wants references written to them, not a property of the workbook being read; nothing serialises it, and swapping the formula bar's notation because a file was opened would be the app editing the user's preferences",
    ),
    (
        "AppState.precision_as_displayed",
        "an application-level calculation toggle here (nothing serialises it). It is destructive when on, so flipping it as a side effect of opening a file is the one behaviour worse than leaving it",
    ),
    (
        "AppState.calculate_before_save",
        "an application preference about what saving does, not a property of the thing being saved",
    ),
    (
        "AppState.auto_recover_enabled",
        "AutoRecover is a machine-level safety net; turning it back on (or off) because the user opened a file would be a setting that changes itself",
    ),
    (
        "AppState.auto_recover_interval_ms",
        "the AutoRecover period travels with auto_recover_enabled and is the same setting",
    ),
    // -- Machine identity and transient control flags -------------------------
    (
        "AppState.subscriber_identity",
        "the WHO of writeback submissions: loaded from (or created in) the Calcula profile directory by `get_subscriber_identity` and cached here. It identifies the person at the machine, not the open document, and re-reading it per document would only re-do the same disk read",
    ),
    (
        "AppState.calc_cancel",
        "the Ctrl+Break flag, an `Arc<AtomicBool>` deliberately outside any Mutex so `cancel_calculation` cannot block on a lock the recalculation holds. It cannot carry a stale cancel across documents: `eval_budget::PassToken::claim` resets it at the start of every governed pass that owns one",
    ),
    // -- Script security: session and machine scope, NOT document scope -------
    (
        "ScriptState.permission_grants",
        "the SESSION-scoped execute approval. Consent is granted per script for as long as the app is running, and clearing it on File > Open would silently re-arm scripts the user had turned off — the reset would be undoing a security decision, in the dangerous direction, with no prompt",
    ),
    (
        "ScriptState.security_level",
        "Script Security (disabled/prompt/enabled) is a machine setting; a document must never be able to change it, least of all by being opened",
    ),
    (
        "ScriptState.mcp_access_level",
        "the AI tool-surface ceiling (read/mutate/script) is a machine setting for the same reason as security_level",
    ),
    (
        "ScriptState.notebook_exec_lock",
        "a `tokio::sync::Mutex<()>` that serialises notebook execution. It is a concurrency primitive holding no value at all — there is nothing in it to be scoped to anything",
    ),
];

/// The `pub` field names of `struct <name>` in `file`, in declaration order.
///
/// Parsed rather than listed, because a hand-written field list is the thing
/// this census exists to replace: it must fail for the field nobody thought of,
/// and a field added to `AppState` tomorrow is exactly that field.
fn struct_fields(sources: &[(String, String)], file: &str, struct_name: &str) -> Vec<String> {
    let text = sources
        .iter()
        .find(|(f, _)| f == file)
        .map(|(_, t)| t.as_str())
        .unwrap_or_else(|| panic!("the census cannot read `{}` — has it moved?", file));
    let header = format!("pub struct {} {{", struct_name);
    let start = text.lines().position(|l| l.trim() == header).unwrap_or_else(|| {
        panic!(
            "`{}` no longer declares `{}` — the field census is pointed at the wrong file",
            file, struct_name
        )
    });
    let mut out = Vec::new();
    for line in text.lines().skip(start + 1) {
        if line == "}" {
            return out;
        }
        // Fields sit at exactly one level of indentation; anything deeper is
        // inside a type argument or a nested literal.
        let Some(rest) = line.strip_prefix("    pub ") else {
            continue;
        };
        if rest.starts_with(' ') {
            continue;
        }
        let name: String = rest
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect();
        if !name.is_empty() && rest[name.len()..].starts_with(':') {
            out.push(name);
        }
    }
    panic!(
        "`struct {}` in `{}` has no closing brace at column 0 — the field walk is broken",
        struct_name, file
    );
}

/// One `fn` item: its name, the file it came from, and its body lines.
#[derive(Clone)]
struct FnDef {
    name: String,
    file: String,
    body: Vec<String>,
    /// Carries `#[tauri::command]`, so the frontend can call it directly.
    is_command: bool,
}

impl FnDef {
    /// The body with comment LINES removed. Comments are not code: a body that
    /// merely mentions a call does not make it.
    fn code(&self) -> String {
        self.body
            .iter()
            .filter(|l| !l.trim_start().starts_with("//"))
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The signature, up to the return arrow — where the injected `State<_>`
    /// parameters are declared.
    fn signature(&self) -> String {
        let code = self.code();
        match code.find(") ->") {
            Some(i) => code[..=i].to_string(),
            None => code,
        }
    }
}

/// `(indentation, name)` if `line` opens a free `fn` item.
///
/// Indentation 0 only. An `impl` method sits at 4 and would let a `Drop` impl's
/// `fn drop` be mistaken for the `drop` every guard release calls — which, when
/// this was first written with the recalculation census's `indent <= 4`, walked
/// the call graph out of the save path and into the script executor.
fn parse_fn_header(line: &str) -> Option<String> {
    if line.starts_with(' ') || line.starts_with('\t') {
        return None;
    }
    let mut rest = line;
    loop {
        let before = rest;
        for prefix in ["pub(crate) ", "pub(super) ", "pub(self) ", "pub ", "async ", "const ", "unsafe "] {
            if let Some(stripped) = rest.strip_prefix(prefix) {
                rest = stripped;
            }
        }
        if rest == before {
            break;
        }
    }
    let rest = rest.strip_prefix("fn ")?;
    let name: String = rest
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// The source with top-level `#[cfg(test)] mod ... { ... }` blocks blanked out.
fn strip_test_modules(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = text.lines().map(|l| l.to_string()).collect();
    let len = lines.len();
    let mut i = 0;
    while i < lines.len() {
        if lines[i].trim() == "#[cfg(test)]" {
            let mut j = i + 1;
            while j < lines.len()
                && (lines[j].trim_start().starts_with("#[") || lines[j].trim_start().starts_with("//"))
            {
                j += 1;
            }
            let is_mod = j < lines.len() && {
                let t = lines[j].trim_start();
                t.starts_with("mod ") || t.starts_with("pub mod ")
            };
            if is_mod {
                let mut k = j;
                while k < lines.len() && lines[k] != "}" {
                    k += 1;
                }
                for line in lines.iter_mut().take((k + 1).min(len)).skip(i) {
                    line.clear();
                }
                i = k + 1;
                continue;
            }
        }
        i += 1;
    }
    lines
}

/// Every free `fn` in `(file, source)` pairs, with its body.
fn index_functions(sources: &[(String, String)]) -> Vec<FnDef> {
    let mut out: Vec<FnDef> = Vec::new();
    for (file, text) in sources {
        let lines = strip_test_modules(text);
        let starts: Vec<(usize, String)> = lines
            .iter()
            .enumerate()
            .filter_map(|(n, l)| parse_fn_header(l).map(|name| (n, name)))
            .collect();
        for (start, name) in starts {
            // A free function ends at the first line that is exactly `}` — how
            // every item in this crate is written.
            let end = lines[start + 1..]
                .iter()
                .position(|l| l == "}")
                .map(|off| start + 1 + off)
                .unwrap_or(lines.len() - 1);
            // Walk back over the attribute + doc-comment block to see whether
            // this is a Tauri command. The frontend can only reach the backend
            // through one, so a document-replacing path is necessarily one of
            // these.
            let mut is_command = false;
            let mut a = start;
            while a > 0 {
                let prev = lines[a - 1].trim_start();
                if prev.starts_with("#[") || prev.starts_with("//") {
                    if prev.starts_with("#[tauri::command") {
                        is_command = true;
                    }
                    a -= 1;
                } else {
                    break;
                }
            }
            out.push(FnDef {
                name,
                file: file.clone(),
                body: lines[start..=end].to_vec(),
                is_command,
            });
        }
    }
    out
}

/// Every function reachable from `roots` by a call whose name resolves to a free
/// function in this crate.
///
/// THIS IS THE HALF THAT SEES THROUGH A DELEGATING HELPER. `assemble_workbook_for_save`
/// contains not one `bi_state.` or `pivot_state.` access of its own: it calls
/// `capture_local_bi_connections`, `collect_local_bi_caches`,
/// `collect_bi_connection_roles` and `collect_pivot_definitions`, and the reads
/// live there. A census that read only the root's body would have credited the
/// save path with reading nothing and passed forever.
fn call_closure(fns: &[FnDef], roots: &[&str]) -> Vec<FnDef> {
    let by_name: BTreeMap<&str, Vec<&FnDef>> = {
        let mut m: BTreeMap<&str, Vec<&FnDef>> = BTreeMap::new();
        for f in fns {
            m.entry(f.name.as_str()).or_default().push(f);
        }
        m
    };
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut queue: Vec<String> = roots.iter().map(|r| r.to_string()).collect();
    let mut out: Vec<FnDef> = Vec::new();
    while let Some(name) = queue.pop() {
        if !seen.insert(name.clone()) {
            continue;
        }
        let Some(defs) = by_name.get(name.as_str()) else {
            continue;
        };
        for def in defs {
            out.push((*def).clone());
            for callee in called_names(&def.code()) {
                if callee != name && by_name.contains_key(callee.as_str()) && !seen.contains(&callee) {
                    queue.push(callee);
                }
            }
        }
    }
    out
}

/// Every `ident(` in `code` — the call sites, resolved by name.
fn called_names(code: &str) -> Vec<String> {
    let bytes: Vec<char> = code.chars().collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c.is_alphabetic() || c == '_' {
            let start = i;
            while i < bytes.len() && (bytes[i].is_alphanumeric() || bytes[i] == '_') {
                i += 1;
            }
            // Skip whitespace between the identifier and a `(`.
            let mut j = i;
            while j < bytes.len() && bytes[j] == ' ' {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == '(' {
                let name: String = bytes[start..i].iter().collect();
                if name.chars().next().is_some_and(|c| c.is_lowercase() || c == '_') {
                    out.push(name);
                }
            }
        } else {
            i += 1;
        }
    }
    out
}

/// `Store.field -> the functions that touch it`, over `defs`.
///
/// Matches `<receiver>.<field>.<accessor>(`, the one shape every store in this
/// crate is reached through: `Persisted<T>` exposes `read`/`write`, a plain
/// `Mutex` exposes `lock`.
fn store_accesses(defs: &[FnDef]) -> BTreeMap<String, BTreeSet<String>> {
    let mut out: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for def in defs {
        let code = def.code();
        for (key, _) in scan_store_accesses(&code) {
            out.entry(key).or_default().insert(def.name.clone());
        }
    }
    out
}

/// Method chains folded onto one line: `state\n    .workbook_protection\n    .read()`
/// becomes `state.workbook_protection.read()`.
///
/// THE THIRD BLIND SPOT, and it was live. `scan_store_accesses` reads one line
/// at a time, and rustfmt breaks a chain across lines the moment the receiver
/// and the field do not fit together — which is exactly how
/// `collect_protection_for_save` and `attach_pending_recalc_for_save` are
/// written. Both are save sources. The census read NEITHER and reported an
/// empty `EXEMPT` with a clean bill, and behind the blind spot sat two real
/// leaks: `AppState.pending_recalc` (a blank document inheriting, and SAVING,
/// the previous workbook's "these cells were never calculated" marker) and
/// `AppState.workbook_protection` (reset only by `new_file`'s inline block).
///
/// Whitespace is dropped on BOTH sides of every `.`, so the shape the scanner
/// matches is independent of how the formatter chose to wrap.
fn join_method_chains(code: &str) -> String {
    let mut out = String::with_capacity(code.len());
    let mut pending_ws = String::new();
    for ch in code.chars() {
        if ch.is_whitespace() {
            pending_ws.push(ch);
            continue;
        }
        if ch == '.' {
            pending_ws.clear();
            out.push('.');
            continue;
        }
        if out.ends_with('.') {
            pending_ws.clear();
        }
        out.push_str(&pending_ws);
        pending_ws.clear();
        out.push(ch);
    }
    out.push_str(&pending_ws);
    out
}

/// The `Store.field` keys mentioned in one comment-stripped body.
fn scan_store_accesses(code: &str) -> Vec<(String, String)> {
    // `lock_pending` belongs here as much as the other three. It was missing, so
    // every gate-then-decide site -- the shape `Persisted::lock_pending` exists to
    // support, used wherever a no-op must not dirty -- was INVISIBLE to both
    // censuses in this file. Added 2026-08-17 while gating the save sources, after
    // converting `advanced_filter_hidden_rows` to exactly that shape and noticing
    // the census stopped seeing it.
    const ACCESSORS: [&str; 4] = ["read", "write", "lock", "lock_pending"];
    let joined = join_method_chains(code);
    let code = joined.as_str();
    let mut out: Vec<(String, String)> = Vec::new();
    for line in code.lines() {
        let chars: Vec<char> = line.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            if !(chars[i].is_alphabetic() || chars[i] == '_') {
                i += 1;
                continue;
            }
            // A receiver must not be the tail of a longer path (`self.state`,
            // `crate::state`): require the char before it to be a separator.
            let ok_before = i == 0 || !(chars[i - 1].is_alphanumeric() || chars[i - 1] == '_' || chars[i - 1] == '.' || chars[i - 1] == ':');
            let start = i;
            while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            if !ok_before {
                continue;
            }
            let recv: String = chars[start..i].iter().collect();
            let Some((_, store)) = RECEIVERS.iter().find(|(r, _)| *r == recv) else {
                continue;
            };
            // `.field.accessor(`
            let rest: String = chars[i..].iter().collect();
            let Some(after_dot) = rest.strip_prefix('.') else {
                continue;
            };
            let field: String = after_dot
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            if field.is_empty() {
                continue;
            }
            let tail = &after_dot[field.len()..];
            let Some(after_second_dot) = tail.strip_prefix('.') else {
                continue;
            };
            let accessor: String = after_second_dot
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            if !ACCESSORS.contains(&accessor.as_str()) {
                continue;
            }
            if !after_second_dot[accessor.len()..].starts_with('(') {
                continue;
            }
            out.push((format!("{}.{}", store, field), recv));
        }
    }
    out
}

/// Every `.rs` file under `dir`, recursively, minus the test sources.
fn read_crate_sources() -> Vec<(String, String)> {
    let src_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    assert!(
        src_root.is_dir(),
        "the crate source tree is not readable at {} — this census cannot run \
         from a list, so it reads the tree",
        src_root.display()
    );
    let mut paths: Vec<std::path::PathBuf> = Vec::new();
    collect_rs_files(&src_root, &mut paths);
    assert!(
        paths.len() > 50,
        "only {} source files found under {} — the walk is broken, not the crate",
        paths.len(),
        src_root.display()
    );
    let mut out = Vec::new();
    for path in paths {
        let rel = path
            .strip_prefix(&src_root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        if rel.ends_with("_tests.rs") || rel == "tests.rs" || rel.starts_with("tests/") {
            continue;
        }
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        out.push((rel, text));
    }
    out
}

fn collect_rs_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rs_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

// ---------------------------------------------------------------------------
// 1. THE CENSUS
// ---------------------------------------------------------------------------

/// EVERY store either PROJECTION path reads, classified — the census the
/// hand-written list cannot be.
///
/// A new store read by `assemble_workbook_for_save` or `assemble_publish_workbook`
/// (or by anything either calls) fails this test until somebody decides, in
/// writing, whether replacing the document must reset it.
#[test]
fn every_store_the_save_path_reads_is_reset_when_the_document_is_replaced() {
    let sources = read_crate_sources();
    let fns = index_functions(&sources);

    let save_closure = call_closure(&fns, SAVE_ROOTS);
    let reads = store_accesses(&save_closure);
    let reset_closure = call_closure(&fns, RESET_FUNCTIONS);
    let resets = store_accesses(&reset_closure);

    let unreset: Vec<String> = reads
        .keys()
        .filter(|k| !resets.contains_key(*k))
        .filter(|k| !EXEMPT.iter().any(|(name, _)| *name == k.as_str()))
        .cloned()
        .collect();

    assert!(
        unreset.is_empty(),
        "these stores are projected into every saved workbook or published \
         package but are NOT reset when the document is replaced:\n  {}\n\nThis \
         is the PivotState / RibbonFilterState / BiState class: an unreset store \
         is an UNSCOPED store, and neither projection path can tell the \
         difference — the next document the user saves, or PUBLISHES, will \
         physically contain this one's content. Either reset it in \
         `persistence::reset_document_scoped_stores` (which both `new_file` and \
         `open_file` run) or add it to EXEMPT with the reason it needs no reset.",
        unreset.join("\n  ")
    );

    // The exemption list must not outlive its entries: a stale name reads as a
    // considered decision about code that no longer exists.
    let stale: Vec<&str> = EXEMPT
        .iter()
        .map(|(name, _)| *name)
        .filter(|name| !reads.contains_key(*name))
        .collect();
    assert!(
        stale.is_empty(),
        "EXEMPT names stores no projection path reads any more:\n  {}",
        stale.join("\n  ")
    );

    // NON-VACUITY. The census must be finding the members it was built for —
    // the three §2w named, plus the two the enumeration itself turned up, plus
    // one the PUBLISH root contributes and the save root does not
    // (`protected_regions`, read to build the package's excluded regions).
    for known in [
        "PivotState.pivot_tables",
        "RibbonFilterState.filters",
        "BiState.connections",
        "AppState.sheet_ids",
        "AppState.model_writeback",
        "AppState.advanced_filter_hidden_rows",
        "AppState.protected_regions",
    ] {
        assert!(
            reads.contains_key(known),
            "the census did not even find `{}` among the projection paths' \
             sources — it is not measuring what it claims to",
            known
        );
    }
    assert!(
        reads.len() > 50,
        "the projection paths were found to read only {} stores; they read \
         dozens, so the walk is broken rather than the crate",
        reads.len()
    );
}

/// BOTH ROOTS ARE REAL, AND THE SECOND ONE COSTS NOTHING — measured, not assumed.
///
/// Two separate claims, and both are load-bearing.
///
/// **(a) Each root resolves to exactly one free function.** `SAVE_ROOTS` is
/// hand-written, and `call_closure` silently yields nothing for a name it cannot
/// resolve — so a rename (or a root turned into an `impl` method, which
/// `parse_fn_header` deliberately does not index) would leave the census passing
/// over half the surface with no signal at all. That is the exact failure mode
/// this whole file exists to make impossible.
///
/// **(b) The publish root adds no unreset store today.** This is the claim that
/// justified rooting the census at both paths as a hardening rather than as a
/// project: the `.calp` carrier is built from the save path's own collectors, so
/// its sources are nearly the same set, and the ones that differ were already
/// reset. MEASURED when this was added, rather than assumed: the save root
/// reaches **70** stores, both roots together reach **71**, and the single
/// publish-only store is `AppState.protected_regions` (read to compute the
/// package's excluded regions), which `reset_document_scoped_stores` already
/// clears. So the second root demanded nothing on the day it was added — which
/// is exactly why it must be added on a day when it demands nothing. Asserting
/// it keeps the claim honest: the day publish starts reading a store the save
/// path does not, this test says so by name and the census above demands the
/// decision.
#[test]
fn the_two_projection_roots_are_both_real_and_the_publish_root_adds_no_demands() {
    let sources = read_crate_sources();
    let fns = index_functions(&sources);

    for root in SAVE_ROOTS {
        let defs: Vec<&FnDef> = fns.iter().filter(|f| f.name == *root).collect();
        assert_eq!(
            defs.len(),
            1,
            "`{}` is a census ROOT and resolves to {} free functions. \
             `call_closure` yields nothing for a name it cannot resolve, so a \
             root that has been renamed, deleted or turned into an `impl` method \
             does not fail the census — it silently shrinks it.",
            root,
            defs.len()
        );
    }

    let save_only = store_accesses(&call_closure(&fns, &["assemble_workbook_for_save"]));
    let both = store_accesses(&call_closure(&fns, SAVE_ROOTS));
    let resets = store_accesses(&call_closure(&fns, RESET_FUNCTIONS));

    // The publish root really does reach stores of its own — otherwise this
    // test would be asserting "nothing changed" about a root that contributes
    // nothing, which is a vacuous pass dressed as a measurement.
    let publish_only: Vec<&String> = both.keys().filter(|k| !save_only.contains_key(*k)).collect();
    assert!(
        !publish_only.is_empty(),
        "the publish root contributed no store the save path does not already \
         read. Either `assemble_publish_workbook` no longer builds the package \
         carrier, or the walk is not reaching it — a root that adds nothing \
         cannot fail for anything"
    );

    let publish_only_unreset: Vec<&str> = publish_only
        .iter()
        .map(|k| k.as_str())
        .filter(|k| !resets.contains_key(*k))
        .filter(|k| !EXEMPT.iter().any(|(name, _)| name == k))
        .collect();
    assert!(
        publish_only_unreset.is_empty(),
        "these stores are read ONLY by the `.calp` publish path and are not \
         reset when the document is replaced:\n  {}\n\nA package is sent to \
         other people, so this is the §2w leak with the confidentiality edge \
         turned up: a subscriber would pull content from a document the \
         publisher had already closed. Reset it in \
         `persistence::reset_document_scoped_stores`, or EXEMPT it with a reason.",
        publish_only_unreset.join("\n  ")
    );
}

/// The reset must actually be RUN by every path that replaces the document.
///
/// Half a census is worthless: `reset_document_scoped_stores` could reset every
/// store in the crate and still leak all of them if nobody called it. Read from
/// the comment-stripped bodies, so commenting the call out fails here too.
#[test]
fn every_document_replacing_path_runs_the_reset() {
    let sources = read_crate_sources();
    let fns = index_functions(&sources);

    for path in DOCUMENT_REPLACING_PATHS {
        let defs: Vec<&FnDef> = fns.iter().filter(|f| f.name == *path).collect();
        assert_eq!(
            defs.len(),
            1,
            "expected exactly one `{}`, found {} — the census is looking at the \
             wrong function",
            path,
            defs.len()
        );
        assert!(
            called_names(&defs[0].code()).iter().any(|c| c == "reset_document_scoped_stores"),
            "`{}` replaces the open document but does not call \
             `reset_document_scoped_stores`. Everything the save path reads and \
             this path does not overwrite will be written into the next \
             document the user saves.",
            path
        );
    }
}

/// `RESET_FUNCTIONS` may only name helpers the reset really delegates to.
///
/// The list is what lets the census see through a delegating helper, so it is
/// also the one place a store could be quietly excused: adding a name that
/// merely READS a store would make the census credit a reset that never happens.
/// Pinning the delegation closes that — a function that stopped being part of
/// the reset stops being called, and this fails.
#[test]
fn the_reset_delegates_to_every_helper_the_census_credits() {
    let sources = read_crate_sources();
    let fns = index_functions(&sources);
    let root: Vec<&FnDef> = fns
        .iter()
        .filter(|f| f.name == "reset_document_scoped_stores")
        .collect();
    assert_eq!(root.len(), 1, "expected exactly one `reset_document_scoped_stores`");
    let called = called_names(&root[0].code());

    for helper in RESET_FUNCTIONS.iter().filter(|h| **h != "reset_document_scoped_stores") {
        assert!(
            called.iter().any(|c| c == *helper),
            "RESET_FUNCTIONS credits `{}` with resetting stores, but \
             `reset_document_scoped_stores` does not call it. Either it is no \
             longer part of the reset (remove it from the list) or the call was \
             lost (restore it) — leaving both would let the census excuse every \
             store that function touches.",
            helper
        );
    }

    // The one save source that is not a `State` field: the scheduled-job
    // registry is a module-level store, so `persist_scheduled_jobs` reads it
    // through no receiver the census can see. It is named here instead.
    assert!(
        root[0].code().contains("scheduler::reset_jobs("),
        "`reset_document_scoped_stores` no longer drops the scheduled-job \
         registry. It is a save source (`scheduled_jobs.json`) that this census \
         cannot see by shape, because it lives in a module-level store rather \
         than on a State — so the previous document's schedule would be written \
         into the next one with nothing failing."
    );
}

/// Commands with document-wide reach that are NOT document-replacing, and why.
///
/// The counterpart to `DOCUMENT_REPLACING_PATHS`, and the reason that list is
/// allowed to be hand-written. See
/// `no_command_with_document_wide_reach_is_unclassified`.
const NOT_DOCUMENT_REPLACING: &[(&str, &str)] = &[
    // -- Reads the whole document; never replaces it --------------------------
    ("save_file", "writes the open document out; the stores it reads are exactly the ones the census enumerates"),
    ("auto_recover_save", "a snapshot of the open document to a side file; the document itself is untouched"),
    ("xlsx_save_loss_report", "a dry run of the xlsx writer, reporting what a save would drop"),
    ("calp_publish", "packages the open document; nothing in it changes"),
    ("calp_publish_preview", "a dry run of publish"),
    ("calp_diff_working_copy", "runs the publish assembly against an IN-MEMORY registry to compare the open document with the version it was authored from. It holds the same states `calp_publish` does for the same reason — it is a publish, just not to a real registry — and, like the dry run, writes nothing anywhere"),
    ("calp_push_merge_analyze", "diffs the registry head and the open document against a common base to decide whether two people's changes overlap. Read-only: it runs the publish assembly in memory, exactly as the working-copy diff does"),
    ("calp_push_merge_apply", "brings the intervening version's CELL changes into the open document and moves the workspace link's base forward. It edits the current document — it does not replace it — and the writes go through `apply_script_modified_grids`, which is the ordinary edit pipeline (undo, recalculation, dirty flag, events)"),
    ("calp_get_application_objects", "reads a package's inventory to show it"),
    // -- Materializes package content INTO the open document ------------------
    ("calp_pull", "SUBSCRIBING adds a package's sheets and data sources to the CURRENT document. It is the one flow that legitimately CREATES a BI connection (`load_embedded_data_sources`), so running the reset here would delete the connection the pull had just made"),
    ("calp_refresh_apply", "advances an existing subscription in place; same document, newer package content"),
    // -- Pivot operations on the open document --------------------------------
    ("update_pivot_fields", "edits one pivot"),
    ("update_bi_pivot_fields", "edits one BI pivot"),
    ("refresh_pivot_cache", "re-queries one pivot's source"),
    ("refresh_all_pivot_tables", "re-queries every pivot's source; the definitions are unchanged"),
    ("apply_pivot_filter", "sets one pivot's filter"),
    ("clear_pivot_filter", "clears one pivot's filter"),
    ("get_slicer_items", "reads a slicer's item list; holds BiState only to fetch the full \
      value domain of a PINNED slicer from the model (the pivot cache is pin-filtered)"),
    ("drill_through_to_sheet", "adds a sheet of detail rows"),
    ("create_pivot_from_bi_model", "adds a pivot"),
    // -- BI / report / script surfaces ----------------------------------------
    ("bi_insert_result", "writes a query result into a range"),
    ("bi_refresh_connection", "re-fetches one connection's tables"),
    ("create_report", "adds a report"),
    ("refresh_report", "re-materializes one report"),
    ("script_distribution", "the sandboxed gateway for the `.calp` script API; every route it reaches is one of the commands already classified here"),
];

/// NOTHING BECOMES A THIRD DOCUMENT-REPLACING PATH WITHOUT A DECISION.
///
/// `DOCUMENT_REPLACING_PATHS` is hand-written, and a hand-written list cannot
/// fail for the command nobody thought of — which is the failure mode this whole
/// census exists to answer. So the list is guarded: every `#[tauri::command]`
/// that takes BOTH `PivotState` and `BiState` must be classified, either as a
/// document-replacing path (and then `every_document_replacing_path_runs_the_reset`
/// makes it run the reset) or as `NOT_DOCUMENT_REPLACING` with a written reason.
///
/// WHY THAT SIGNAL. A command cannot replace the document without putting those
/// two stores back to blank, and it cannot do that without being handed them.
/// The frontend reaches the backend only through `#[tauri::command]`, so the
/// candidate set really is closed. The signal is deliberately WIDE — it catches
/// twenty-odd commands that merely read or edit the document — because a
/// classification list that is annoying to extend is doing its job, and each
/// entry took one sentence to decide.
#[test]
fn no_command_with_document_wide_reach_is_unclassified() {
    let sources = read_crate_sources();
    let fns = index_functions(&sources);

    let candidates: Vec<&FnDef> = fns
        .iter()
        .filter(|f| f.is_command)
        .filter(|f| {
            let sig = f.signature();
            sig.contains("PivotState") && sig.contains("BiState")
        })
        .collect();

    assert!(
        candidates.len() > 10,
        "only {} commands were found holding both PivotState and BiState — the \
         signature scan is broken, not the crate",
        candidates.len()
    );

    let unclassified: Vec<String> = candidates
        .iter()
        .filter(|f| !DOCUMENT_REPLACING_PATHS.contains(&f.name.as_str()))
        .filter(|f| !NOT_DOCUMENT_REPLACING.iter().any(|(n, _)| *n == f.name))
        .map(|f| format!("{}::{}", f.file, f.name))
        .collect();
    assert!(
        unclassified.is_empty(),
        "these commands hold both `PivotState` and `BiState` — enough reach to \
         replace the open document — and nobody has said whether they do:\n  \
         {}\n\nIf the command replaces the document, add it to \
         DOCUMENT_REPLACING_PATHS and make it call \
         `reset_document_scoped_stores`; otherwise add it to \
         NOT_DOCUMENT_REPLACING with the reason it does not.",
        unclassified.join("\n  ")
    );

    // Neither list may outlive its entries.
    let stale: Vec<&str> = NOT_DOCUMENT_REPLACING
        .iter()
        .map(|(n, _)| *n)
        .filter(|n| !candidates.iter().any(|f| f.name == *n))
        .collect();
    assert!(
        stale.is_empty(),
        "NOT_DOCUMENT_REPLACING names commands that no longer hold both states \
         (renamed, deleted, or their signature narrowed):\n  {}",
        stale.join("\n  ")
    );

    // ...and a path cannot be in both lists.
    for path in DOCUMENT_REPLACING_PATHS {
        assert!(
            !NOT_DOCUMENT_REPLACING.iter().any(|(n, _)| n == path),
            "`{}` is listed as both document-replacing and not",
            path
        );
    }

    // Every reason is a reason somebody wrote.
    const SELF: &str = include_str!("document_store_census_tests.rs");
    let start = SELF
        .find("const NOT_DOCUMENT_REPLACING:")
        .expect("the classification list must still be declared");
    let end = SELF[start..]
        .find("\n];")
        .map(|o| start + o)
        .expect("the classification list must still terminate");
    for line in SELF[start..end].lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("(\"") {
            assert!(
                !trimmed.contains(", \"\")"),
                "a NOT_DOCUMENT_REPLACING entry carries an empty reason:\n  {}",
                trimmed
            );
        }
    }
}

// ---------------------------------------------------------------------------
// 1b. THE FIELD CENSUS — every field of every State, saved or not
// ---------------------------------------------------------------------------

/// The stores the reset is credited with, by `Store.field` key.
///
/// Shared by the three tests below so they cannot disagree about what "reset"
/// means. `RESET_BY_METHOD_CALL` is folded in here and nowhere else.
fn reset_coverage(fns: &[FnDef]) -> BTreeSet<String> {
    let closure = call_closure(fns, RESET_FUNCTIONS);
    let mut covered: BTreeSet<String> = store_accesses(&closure).keys().cloned().collect();
    let closure_code: String = closure
        .iter()
        .map(|f| join_method_chains(&f.code()))
        .collect::<Vec<_>>()
        .join("\n");
    for (field, call) in RESET_BY_METHOD_CALL {
        if closure_code.contains(call) {
            covered.insert((*field).to_string());
        }
    }
    covered
}

/// EVERY FIELD OF EVERY STATE IS RESET OR EXEMPT — the half of the census the
/// save path could not see, and the half defect 4a lived in.
///
/// `every_store_the_save_path_reads_is_reset_when_the_document_is_replaced`
/// asks its question of the stores that reach the archive. The undo stack does
/// not reach the archive. It is still the document's — an `UndoTransaction`
/// names (sheet, row, col) and a before-value and nothing else — so a stack that
/// outlives its document applies workbook A's before-image to workbook B's
/// coordinates on the first Ctrl+Z, and the next save writes that in. The save
/// census could not have failed for it, no matter how well it was written.
///
/// So this one enumerates the FIELDS, which is a set nothing can hide in: a
/// field is reset by the shared function, or it is `SESSION_SCOPED` with a
/// written reason. There is no third answer and no "not applicable".
#[test]
fn every_state_field_is_reset_or_exempt() {
    let sources = read_crate_sources();
    let fns = index_functions(&sources);
    let covered = reset_coverage(&fns);

    let mut all_fields: Vec<String> = Vec::new();
    let mut unclassified: Vec<String> = Vec::new();
    for (store, file, struct_name) in STATE_FIELD_SOURCES {
        let fields = struct_fields(&sources, file, struct_name);
        assert!(
            !fields.is_empty(),
            "no fields parsed out of `struct {}` in `{}` — the field walk is \
             broken, and a broken walk passes this test vacuously",
            struct_name,
            file
        );
        for field in fields {
            let key = format!("{}.{}", store, field);
            all_fields.push(key.clone());
            if covered.contains(&key) {
                continue;
            }
            if SESSION_SCOPED.iter().any(|(name, _)| *name == key) {
                continue;
            }
            unclassified.push(key);
        }
    }

    assert!(
        unclassified.is_empty(),
        "these fields belong to a State the document-replacing paths reset, and \
         nobody has said whether they belong to the DOCUMENT:\n  {}\n\nThis is \
         the class defect 4a was in. The undo stack was one of these: not a save \
         source, so the save-path census could never fail for it, and it \
         survived File > Open — one Ctrl+Z then overwrote a cell of the workbook \
         on screen with a value from a workbook that was no longer open, and \
         saved it there. Either reset the field in \
         `persistence::reset_document_scoped_stores`, or add it to \
         SESSION_SCOPED with the reason it is the user's or the machine's rather \
         than the document's.",
        unclassified.join("\n  ")
    );

    // Neither list may outlive its fields: a stale entry reads as a considered
    // decision about a field that no longer exists.
    let stale: Vec<&str> = SESSION_SCOPED
        .iter()
        .map(|(name, _)| *name)
        .filter(|name| !all_fields.iter().any(|f| f == name))
        .collect();
    assert!(
        stale.is_empty(),
        "SESSION_SCOPED names fields that no longer exist:\n  {}",
        stale.join("\n  ")
    );
    let stale_calls: Vec<&str> = RESET_BY_METHOD_CALL
        .iter()
        .map(|(name, _)| *name)
        .filter(|name| !all_fields.iter().any(|f| f == name))
        .collect();
    assert!(
        stale_calls.is_empty(),
        "RESET_BY_METHOD_CALL names fields that no longer exist:\n  {}",
        stale_calls.join("\n  ")
    );

    // Every method-call credit must really be in the reset. Without this the
    // list is a way to declare a field reset by writing its name down.
    for (field, call) in RESET_BY_METHOD_CALL {
        assert!(
            covered.contains(*field),
            "RESET_BY_METHOD_CALL credits `{}` to the call `{}`, which does not \
             appear in the reset. Either the call was lost or it was renamed; \
             leaving the entry excuses the field either way",
            field,
            call
        );
    }

    // NON-VACUITY. The walk must be finding the fields it was built for — the
    // 4a defect itself, its two neighbours, and the two that the enumeration
    // turned up on its own.
    for known in [
        "AppState.undo_stack",
        "AppState.spill_ranges",
        "AppState.spill_hosts",
        "ScriptState.notebook_runtime",
        "AppState.animation_snapshots",
    ] {
        assert!(
            all_fields.iter().any(|f| f == known),
            "the field census did not even enumerate `{}`",
            known
        );
        assert!(
            covered.contains(known),
            "`{}` is document-scoped and the reset no longer clears it",
            known
        );
    }
    assert!(
        all_fields.len() > 100,
        "only {} fields enumerated across {} States — the struct walk is broken, \
         not the crate",
        all_fields.len(),
        STATE_FIELD_SOURCES.len()
    );
}

/// The field census must cover every State the reset is HANDED.
///
/// `STATE_FIELD_SOURCES` is hand-written, and this is what stops it being the
/// by-name list this register keeps recording the failure of: a ninth State
/// added to `reset_document_scoped_stores` is a ninth family of fields nobody
/// is enumerating, and it fails here on the day the parameter is added.
#[test]
fn the_field_census_covers_every_state_the_reset_is_given() {
    let sources = read_crate_sources();
    let fns = index_functions(&sources);
    let reset: Vec<&FnDef> = fns
        .iter()
        .filter(|f| f.name == "reset_document_scoped_stores")
        .collect();
    assert_eq!(reset.len(), 1, "expected exactly one `reset_document_scoped_stores`");
    let signature = reset[0].signature();

    for (store, _, struct_name) in STATE_FIELD_SOURCES {
        assert!(
            signature.contains(struct_name),
            "the field census enumerates `{}`, but the reset is not given one — \
             a State it never sees is a State it cannot reset",
            store
        );
    }

    // ...and the reverse: a parameter whose fields nobody enumerates.
    for param in signature.lines() {
        let Some((_, ty)) = param.split_once(':') else {
            continue;
        };
        let Some(state_name) = ty
            .rsplit("::")
            .next()
            .map(|s| s.trim().trim_start_matches('&').trim_end_matches(',').trim_end_matches('>'))
        else {
            continue;
        };
        if !state_name.ends_with("State") || state_name == "FileState" {
            continue;
        }
        assert!(
            STATE_FIELD_SOURCES.iter().any(|(s, _, _)| *s == state_name),
            "`reset_document_scoped_stores` is handed a `{}` whose fields the \
             field census does not enumerate. Add it to STATE_FIELD_SOURCES \
             with the file that declares it, or the next unreset field on it \
             will be found the way the undo stack was",
            state_name
        );
    }
}

/// `new_file` RESETS NOTHING OF ITS OWN — the invariant the collapse buys.
///
/// After the fix, both document-replacing paths run the same function, so
/// anything either path resets OUTSIDE that function is by definition something
/// the other path does not get. `new_file` is the strict case and can be
/// asserted exactly: it must touch no store at all. Everything it does to a
/// document is `reset_document_scoped_stores`; everything else it does is
/// `FileState` (which document is now open), and `FileState` is not a store.
///
/// This is the check that would have caught 4a on the day it was written.
/// `new_file` had ~50 lines of resets after the shared call — the undo stack
/// among them — and `open_file` had none of them.
#[test]
fn new_file_delegates_every_store_reset() {
    let sources = read_crate_sources();
    let fns = index_functions(&sources);
    let defs: Vec<&FnDef> = fns.iter().filter(|f| f.name == "new_file").collect();
    assert_eq!(defs.len(), 1, "expected exactly one `new_file`");

    let touched: BTreeSet<String> = scan_store_accesses(&defs[0].code())
        .into_iter()
        .map(|(key, _)| key)
        .collect();
    assert!(
        touched.is_empty(),
        "`new_file` reaches these stores itself:\n  {}\n\nEvery one of them is a \
         reset `open_file` does NOT get, because `open_file` runs \
         `reset_document_scoped_stores` and nothing else. That asymmetry IS \
         defect 4a: the undo stack sat in this list, so opening a workbook left \
         the previous one's stack live and the first Ctrl+Z wrote a foreign \
         value into the open document. Move the reset into \
         `reset_document_scoped_stores`, which both paths run.",
        touched.into_iter().collect::<Vec<_>>().join("\n  ")
    );
}

/// `open_file` touches no store the shared reset does not also cover.
///
/// The looser half of the same invariant, and it has to be looser: `open_file`
/// legitimately RESTORES some fifty stores from the file it just read, so
/// "touches nothing" is not available. What is available — and is the property
/// that matters — is that every store it reaches is one the reset already put
/// back to blank, so no store depends on `open_file`'s restore being careful.
/// "Most restores clear before refilling" was the shape of the original defect;
/// a store `open_file` knows about and the reset does not is the next one.
#[test]
fn open_file_touches_no_store_the_reset_does_not_cover() {
    /// Stores `open_file` reaches that the reset deliberately leaves alone AND
    /// that `SESSION_SCOPED` does not already argue for.
    ///
    /// Empty, and that is the healthy state. It used to hold `AppState.locale`,
    /// whose reason ended "(see SESSION_SCOPED)" — i.e. it was a second copy of
    /// an argument already made elsewhere, and a second copy is a second thing
    /// to keep true. Now this test consults `SESSION_SCOPED` directly, so a
    /// store argued there needs no restatement here, and an entry that appears
    /// here means something genuinely different: the open path reaches a
    /// DOCUMENT store that the reset does not put back.
    const OPEN_FILE_MAY_TOUCH: &[(&str, &str)] = &[];

    let sources = read_crate_sources();
    let fns = index_functions(&sources);
    let covered = reset_coverage(&fns);

    let defs: Vec<&FnDef> = fns.iter().filter(|f| f.name == "open_file").collect();
    assert_eq!(defs.len(), 1, "expected exactly one `open_file`");
    // Through the CALL CLOSURE, not the one body — lesson 1 in this file's own
    // header, applied here after it caught something: `open_file`'s return
    // projection was moved into `collect_active_sheet_cells` (so `calp_checkout`
    // could return the identical shape), and a body-only scan promptly reported
    // the locale read as a stale exemption. The store was still being read; only
    // the line had moved. A census that a refactor can walk out of is a census
    // that stops asking its question the first time someone tidies up.
    let touched: BTreeSet<String> = call_closure(&fns, &["open_file"])
        .iter()
        .flat_map(|f| scan_store_accesses(&f.code()))
        .map(|(key, _)| key)
        .collect();

    assert!(
        touched.len() > 30,
        "`open_file` was found to touch only {} stores; it restores dozens, so \
         the scan is broken rather than the command",
        touched.len()
    );

    let uncovered: Vec<&String> = touched
        .iter()
        .filter(|k| !covered.contains(*k))
        // A store already argued as the SESSION's rather than the DOCUMENT's,
        // with a written reason, is not reset by design — asking for a second
        // exemption in a second list would mean maintaining one argument in two
        // places, and the two would eventually disagree.
        .filter(|k| !SESSION_SCOPED.iter().any(|(n, _)| *n == k.as_str()))
        .filter(|k| !OPEN_FILE_MAY_TOUCH.iter().any(|(n, _)| *n == k.as_str()))
        .collect();
    assert!(
        uncovered.is_empty(),
        "`open_file` reaches these stores, and the shared reset does not:\n  \
         {}\n\nA store only the open path knows about is a store whose blank \
         value depends on this one command remembering to write it — which is \
         the arrangement that let `new_file` and `open_file` disagree about the \
         undo stack. Reset it in `reset_document_scoped_stores`.",
        uncovered
            .iter()
            .map(|k| k.as_str())
            .collect::<Vec<_>>()
            .join("\n  ")
    );

    let stale: Vec<&str> = OPEN_FILE_MAY_TOUCH
        .iter()
        .map(|(n, _)| *n)
        .filter(|n| !touched.contains(*n))
        .collect();
    assert!(
        stale.is_empty(),
        "OPEN_FILE_MAY_TOUCH names stores `open_file` no longer reaches:\n  {}",
        stale.join("\n  ")
    );
    for (name, reason) in OPEN_FILE_MAY_TOUCH {
        assert!(
            reason.len() > 40,
            "the exemption for `{}` is not a reason anybody wrote",
            name
        );
    }
}

/// Every exemption carries a reason somebody wrote.
///
/// An empty string is how an entry gets parked "temporarily" and then stays
/// forever. Reads the list back out of this file's own source so the check
/// cannot drift from the constant it checks.
#[test]
fn every_exemption_carries_a_written_reason() {
    const SELF: &str = include_str!("document_store_census_tests.rs");
    let start = SELF
        .find("const EXEMPT:")
        .expect("the census must still declare an EXEMPT list");
    let end = SELF[start..]
        .find("];")
        .map(|o| start + o)
        .expect("the EXEMPT list must still terminate");
    for line in SELF[start..end].lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("(\"") {
            continue;
        }
        assert!(
            !trimmed.contains(", \"\")"),
            "an EXEMPT entry carries an empty reason:\n  {}\n\nAn exemption is a \
             decision, and a decision nobody wrote down is indistinguishable \
             from an oversight",
            trimmed
        );
    }

    // SESSION_SCOPED is the exemption list that actually has entries, so it is
    // the one where a one-word reason would do real damage — "session state" as
    // a reason for the undo stack would have read perfectly and been wrong. The
    // bar is a SENTENCE, checked on the constant itself rather than on the
    // source text, so no reformatting can slip past it.
    for (field, reason) in SESSION_SCOPED {
        assert!(
            reason.len() > 60,
            "the SESSION_SCOPED entry for `{}` is not a reason anybody wrote:\n  \
             {:?}\n\nSay WHOSE it is (the user's? the machine's?) and what \
             resetting it would break. `{}` is exempted from a check that exists \
             because a field everybody assumed was session state turned out to \
             be the document's.",
            field,
            reason,
            field
        );
    }

    // A field cannot be both exempt and reset-by-method: that is two answers to
    // a question this census allows exactly one answer to.
    for (field, _) in RESET_BY_METHOD_CALL {
        assert!(
            !SESSION_SCOPED.iter().any(|(n, _)| n == field),
            "`{}` is listed as both session-scoped and reset by a method call",
            field
        );
    }

    // A method-call credit must name its own field, or the list becomes a way
    // to satisfy one field with another field's teardown.
    for (field, call) in RESET_BY_METHOD_CALL {
        let short = field.split('.').nth(1).expect("keys are Store.field");
        assert!(
            call.contains(short),
            "RESET_BY_METHOD_CALL credits `{}` to `{}`, which does not even \
             mention the field",
            field,
            call
        );
    }
}

// ---------------------------------------------------------------------------
// 2. THE CENSUS HAS TEETH — asserted, not trusted
// ---------------------------------------------------------------------------

/// The detector FIRES, and both hardening lessons hold.
///
/// The manual version of this is "delete one reset and confirm the census names
/// the right store" — which is exactly what this does, on synthetic sources, so
/// it runs on every build.
#[test]
fn the_census_detector_actually_fires() {
    fn analyse(save: &str, reset: &str) -> Vec<String> {
        let sources = vec![
            ("save.rs".to_string(), save.to_string()),
            ("reset.rs".to_string(), reset.to_string()),
        ];
        let fns = index_functions(&sources);
        let reads = store_accesses(&call_closure(&fns, &["assemble_workbook_for_save"]));
        let resets = store_accesses(&call_closure(&fns, &["reset_document_scoped_stores"]));
        reads
            .keys()
            .filter(|k| !resets.contains_key(*k))
            .cloned()
            .collect()
    }

    // 1. A store the save path reads and the reset does not touch is REPORTED.
    const SAVE_DIRECT: &str = "\
pub fn assemble_workbook_for_save(state: &State<AppState>) -> Workbook {
    workbook.pivot_layouts = state.pivot_layouts.read().unwrap().clone();
}
";
    const RESET_EMPTY: &str = "\
pub fn reset_document_scoped_stores(state: &AppState) {
    state.grid.write(effect).unwrap().clear();
}
";
    assert_eq!(
        analyse(SAVE_DIRECT, RESET_EMPTY),
        vec!["AppState.pivot_layouts".to_string()],
        "the census did not flag a store the save path writes out and the reset \
         leaves alone — it would pass the §2w leak unchanged"
    );

    // 2. ...and is NOT reported once the reset touches it. A census that reports
    //    everything is ignored, which is the same as having none.
    const RESET_COVERS: &str = "\
pub fn reset_document_scoped_stores(state: &AppState) {
    state.pivot_layouts.write(effect).unwrap().clear();
}
";
    assert!(
        analyse(SAVE_DIRECT, RESET_COVERS).is_empty(),
        "the census flagged a store the reset demonstrably clears"
    );

    // 3. LESSON ONE — IT SEES THROUGH A DELEGATING HELPER, on the SAVE side.
    //    `assemble_workbook_for_save` touches no `bi_state` of its own; the read
    //    is inside `capture_local_bi_connections`. A census reading only the
    //    root's body would credit the save path with reading nothing.
    const SAVE_VIA_HELPER: &str = "\
pub fn assemble_workbook_for_save(state: &State<AppState>) -> Workbook {
    workbook.bi_connections = capture_local_bi_connections(bi_state);
}
pub fn capture_local_bi_connections(bi_state: &BiState) -> Vec<Saved> {
    let connections = bi_state.connections.lock().unwrap();
}
";
    assert_eq!(
        analyse(SAVE_VIA_HELPER, RESET_EMPTY),
        vec!["BiState.connections".to_string()],
        "a store the save path reads ONLY through a delegating helper was not \
         enumerated. That is how `BiState` reached the archive: \
         `assemble_workbook_for_save` mentions it nowhere."
    );

    // 4. LESSON ONE AGAIN — the RESET side delegates too, and must be followed
    //    the same way, or the fix would look absent to the census that checks it.
    const RESET_VIA_HELPER: &str = "\
pub fn reset_document_scoped_stores(bi_state: &BiState) {
    reset_bi_connections(bi_state);
}
pub fn reset_bi_connections(bi_state: &BiState) {
    let mut connections = bi_state.connections.lock().unwrap();
}
";
    assert!(
        analyse(SAVE_VIA_HELPER, RESET_VIA_HELPER).is_empty(),
        "a reset performed through a delegating helper was not credited — the \
         census would demand a second, inline clear of a store already torn down"
    );

    // 5. LESSON TWO — A COMMENTED-OUT RESET DOES NOT COUNT. This is the likeliest
    //    shape of a real removal: every call site here is wrapped in a comment
    //    naming it, so the name survives a careless delete either way.
    const RESET_COMMENTED_OUT: &str = "\
pub fn reset_document_scoped_stores(state: &AppState) {
    // state.pivot_layouts.write(effect).unwrap().clear();
}
";
    assert_eq!(
        analyse(SAVE_DIRECT, RESET_COMMENTED_OUT),
        vec!["AppState.pivot_layouts".to_string()],
        "a COMMENTED-OUT reset satisfied the census. Comments are not code."
    );

    // 6. ...including the prose form, which is how every real reset here
    //    documents itself.
    const RESET_MENTIONED_IN_PROSE: &str = "\
pub fn reset_document_scoped_stores(state: &AppState) {
    // The caller is expected to clear state.pivot_layouts.write(...) itself.
}
";
    assert_eq!(
        analyse(SAVE_DIRECT, RESET_MENTIONED_IN_PROSE),
        vec!["AppState.pivot_layouts".to_string()],
        "a prose mention of the store satisfied the census"
    );

    // 7. The SAVE side must ignore comments too, or a deleted-but-commented read
    //    would keep demanding a reset for a store nothing writes any more.
    const SAVE_COMMENTED_OUT: &str = "\
pub fn assemble_workbook_for_save(state: &State<AppState>) -> Workbook {
    // workbook.pivot_layouts = state.pivot_layouts.read().unwrap().clone();
}
";
    assert!(
        analyse(SAVE_COMMENTED_OUT, RESET_EMPTY).is_empty(),
        "a commented-out read counted as a save source"
    );

    // 8. A receiver that is not a store is not a store. `workbook.pivot_layouts`
    //    is the DESTINATION, not the source, and counting it would make the
    //    census report fields of the archive it is trying to protect.
    const SAVE_NON_STORE_RECEIVER: &str = "\
pub fn assemble_workbook_for_save(state: &State<AppState>) -> Workbook {
    let seen = workbook.pivot_layouts.read().unwrap();
    let conn = subscription.connections.lock().unwrap();
}
";
    assert!(
        analyse(SAVE_NON_STORE_RECEIVER, RESET_EMPTY).is_empty(),
        "a non-store receiver was enumerated as a document store"
    );

    // 9. LESSON THREE — A CHAIN BROKEN ACROSS LINES IS STILL A READ. This is not
    //    hypothetical and it is not cosmetic: `collect_protection_for_save` and
    //    `attach_pending_recalc_for_save` are both written exactly like this,
    //    and the census read neither for as long as it existed. It reported an
    //    empty EXEMPT the whole time.
    const SAVE_MULTILINE_CHAIN: &str = "\
pub fn assemble_workbook_for_save(state: &State<AppState>) -> Workbook {
    workbook.workbook_protection = state
        .workbook_protection
        .read()
        .ok()
        .map(|p| p.clone());
}
";
    assert_eq!(
        analyse(SAVE_MULTILINE_CHAIN, RESET_EMPTY),
        vec!["AppState.workbook_protection".to_string()],
        "a save-path read written as a WRAPPED method chain was not enumerated. \
         rustfmt wraps every chain that does not fit, so a line-at-a-time \
         scanner sees a censored version of the crate"
    );

    // 10. ...and the same on the RESET side, or the census would demand a second
    //     inline clear of a store the reset already handles in wrapped form.
    const RESET_MULTILINE_CHAIN: &str = "\
pub fn reset_document_scoped_stores(state: &AppState) {
    *state
        .workbook_protection
        .write(effect)
        .map_err(|e| e.to_string())? = WorkbookProtection::default();
}
";
    assert!(
        analyse(SAVE_MULTILINE_CHAIN, RESET_MULTILINE_CHAIN).is_empty(),
        "a reset written as a wrapped method chain was not credited"
    );

    // 11. Joining chains must not invent an access out of two unrelated
    //     statements. Nothing here is `state.<field>.<accessor>(`.
    const SAVE_ADJACENT_STATEMENTS: &str = "\
pub fn assemble_workbook_for_save(state: &State<AppState>) -> Workbook {
    let n = state;
    workbook.undo_stack.len();
}
";
    assert!(
        analyse(SAVE_ADJACENT_STATEMENTS, RESET_EMPTY).is_empty(),
        "the chain join fabricated a store access across two statements"
    );
}

/// THE FIELD CENSUS FIRES — the same demonstration, for the half that is new.
///
/// The manual version is "delete a reset, add an unreset field, watch it name
/// the right one", which is exactly what was done to the real tree when this
/// landed (both sabotages are recorded in the register). This is that, on
/// synthetic sources, so it runs on every build instead of once.
#[test]
fn the_field_census_detector_actually_fires() {
    // A tiny State, and a reset that covers one of its two fields.
    const STATE_SRC: &str = "\
pub struct AppState {
    pub document_thing: Mutex<u32>,
    pub undo_stack: Mutex<UndoStack>,
}
";
    const RESET_ONE: &str = "\
pub fn reset_document_scoped_stores(state: &AppState) {
    state.document_thing.lock().unwrap().clear();
}
";
    fn classify(state_src: &str, reset_src: &str, exempt: &[&str]) -> Vec<String> {
        let sources = vec![
            ("probe_app_state.rs".to_string(), state_src.to_string()),
            ("reset.rs".to_string(), reset_src.to_string()),
        ];
        let fns = index_functions(&sources);
        let covered: BTreeSet<String> =
            store_accesses(&call_closure(&fns, &["reset_document_scoped_stores"]))
                .keys()
                .cloned()
                .collect();
        struct_fields(&sources, "probe_app_state.rs", "AppState")
            .into_iter()
            .map(|f| format!("AppState.{}", f))
            .filter(|k| !covered.contains(k))
            .filter(|k| !exempt.contains(&k.as_str()))
            .collect()
    }

    // 1. THE 4a SHAPE. A field the reset does not touch is NAMED — and note
    //    that nothing here is a save source, so the save-path census would
    //    have reported nothing at all.
    assert_eq!(
        classify(STATE_SRC, RESET_ONE, &[]),
        vec!["AppState.undo_stack".to_string()],
        "the field census did not name a State field the reset leaves alone. \
         That is defect 4a exactly: the undo stack was not a save source, so \
         the only census that existed could not fail for it"
    );

    // 2. ...and stops naming it once the reset covers it.
    const RESET_BOTH: &str = "\
pub fn reset_document_scoped_stores(state: &AppState) {
    state.document_thing.lock().unwrap().clear();
    *state.undo_stack.lock().unwrap() = UndoStack::new();
}
";
    assert!(
        classify(STATE_SRC, RESET_BOTH, &[]).is_empty(),
        "the field census flagged a field the reset demonstrably clears"
    );

    // 3. ...or once somebody has written down why it is not the document's.
    assert!(
        classify(STATE_SRC, RESET_ONE, &["AppState.undo_stack"]).is_empty(),
        "an exempted field was still reported"
    );

    // 4. A NEW FIELD IS THE POINT. Adding one to the struct and nothing else
    //    fails immediately — the field census's whole reason for existing is
    //    that a hand-written list cannot fail for the field nobody thought of.
    const STATE_SRC_GROWN: &str = "\
pub struct AppState {
    pub document_thing: Mutex<u32>,
    pub undo_stack: Mutex<UndoStack>,
    pub freshly_added: Mutex<Vec<u8>>,
}
";
    assert_eq!(
        classify(STATE_SRC_GROWN, RESET_BOTH, &[]),
        vec!["AppState.freshly_added".to_string()],
        "a field added to a State with no decision about it was not reported"
    );

    // 5. A COMMENTED-OUT reset does not count here either.
    const RESET_COMMENTED: &str = "\
pub fn reset_document_scoped_stores(state: &AppState) {
    state.document_thing.lock().unwrap().clear();
    // *state.undo_stack.lock().unwrap() = UndoStack::new();
}
";
    assert_eq!(
        classify(STATE_SRC, RESET_COMMENTED, &[]),
        vec!["AppState.undo_stack".to_string()],
        "a commented-out reset satisfied the field census"
    );

    // 6. The field parse takes `pub` fields at ONE level of indentation and
    //    nothing else — not the `impl` below it, not a nested type argument.
    const STATE_WITH_IMPL: &str = "\
pub struct AppState {
    pub document_thing: Mutex<HashMap<String, Vec<u8>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self { document_thing: Mutex::new(HashMap::new()) }
    }
}
";
    let sources = vec![("probe_app_state.rs".to_string(), STATE_WITH_IMPL.to_string())];
    assert_eq!(
        struct_fields(&sources, "probe_app_state.rs", "AppState"),
        vec!["document_thing".to_string()],
        "the field walk read past the struct's closing brace"
    );
}

/// `new_file` and `open_file` are read for what they RESET, and the detector
/// fires for a reset either of them keeps to itself.
#[test]
fn the_delegation_detector_actually_fires() {
    fn touched(src: &str, name: &str) -> Vec<String> {
        let sources = vec![("persistence.rs".to_string(), src.to_string())];
        let fns = index_functions(&sources);
        let def = fns
            .iter()
            .find(|f| f.name == name)
            .expect("the probe source must declare the function");
        let mut keys: Vec<String> = scan_store_accesses(&def.code())
            .into_iter()
            .map(|(k, _)| k)
            .collect();
        keys.sort();
        keys.dedup();
        keys
    }

    // THE 4a SOURCE, in miniature: the shared call, then a private reset.
    const NEW_FILE_WITH_PRIVATE_RESET: &str = "\
pub fn new_file(state: State<AppState>) -> Result<(), String> {
    reset_document_scoped_stores(state.inner())?;
    *state.undo_stack.lock().map_err(|e| e.to_string())? = UndoStack::new();
    *file_state.current_path.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}
";
    assert_eq!(
        touched(NEW_FILE_WITH_PRIVATE_RESET, "new_file"),
        vec!["AppState.undo_stack".to_string()],
        "a reset `new_file` performs itself — the exact shape of defect 4a — \
         was not reported. `file_state` is correctly ignored: it is not a store, \
         it is the answer to which document is open"
    );

    // The fixed shape reports nothing.
    const NEW_FILE_DELEGATING: &str = "\
pub fn new_file(state: State<AppState>) -> Result<(), String> {
    reset_document_scoped_stores(state.inner())?;
    *file_state.current_path.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}
";
    assert!(
        touched(NEW_FILE_DELEGATING, "new_file").is_empty(),
        "a `new_file` that delegates every store reset was still reported"
    );

    // ...and a COMMENTED-OUT private reset must not be reported, or the fix
    // would have to delete the explanation along with the code.
    const NEW_FILE_COMMENTED: &str = "\
pub fn new_file(state: State<AppState>) -> Result<(), String> {
    reset_document_scoped_stores(state.inner())?;
    // *state.undo_stack.lock().unwrap() = UndoStack::new();
    Ok(())
}
";
    assert!(
        touched(NEW_FILE_COMMENTED, "new_file").is_empty(),
        "a commented-out reset was read as a private reset"
    );
}

/// The `fn` walk itself, pinned — the census is only as good as its parse.
#[test]
fn the_function_walk_reads_free_functions_and_not_impl_methods() {
    assert_eq!(
        parse_fn_header("pub(crate) fn reset_bi_connections(bi_state: &BiState) {").as_deref(),
        Some("reset_bi_connections")
    );
    assert_eq!(
        parse_fn_header("pub async fn open_file(").as_deref(),
        Some("open_file")
    );
    // An `impl` method is indented. Accepting one lets a `Drop` impl's `fn drop`
    // be resolved as the `drop(guard)` every lock release calls, which walks the
    // call graph clean out of the save path — measured, when this census was
    // first written against the recalculation census's `indent <= 4` rule, into
    // the script executor and its unrelated `AppState` reads.
    assert_eq!(parse_fn_header("    fn drop(&mut self) {"), None);
    assert_eq!(parse_fn_header("    pub fn new() -> Self {"), None);
    assert_eq!(parse_fn_header("struct FnDef {"), None);

    // A body ends at the first column-0 `}`.
    let sources = vec![(
        "x.rs".to_string(),
        "pub fn a() {\n    let x = 1;\n}\n\npub fn b() {\n    let y = 2;\n}\n".to_string(),
    )];
    let fns = index_functions(&sources);
    assert_eq!(fns.len(), 2);
    assert_eq!(fns[0].name, "a");
    assert_eq!(fns[0].body.len(), 3);
    assert_eq!(fns[1].name, "b");
    assert_eq!(fns[1].file, "x.rs");
    assert!(!fns[0].is_command, "a plain fn is not a Tauri command");

    // The `#[tauri::command]` attribute is found THROUGH the doc comment and
    // any other attributes between it and the header — which is how every
    // command in this crate is actually written, and what
    // `no_command_with_document_wide_reach_is_unclassified` depends on.
    let commands = index_functions(&vec![(
        "y.rs".to_string(),
        "/// Docs.\n#[tauri::command]\n#[allow(clippy::too_many_arguments)]\npub fn c(\n    pivot_state: State<PivotState>,\n    bi_state: State<BiState>,\n) -> Result<(), String> {\n    Ok(())\n}\n"
            .to_string(),
    )]);
    assert_eq!(commands.len(), 1);
    assert!(commands[0].is_command, "the command attribute was not found");
    assert!(
        commands[0].signature().contains("PivotState")
            && commands[0].signature().contains("BiState")
            && !commands[0].signature().contains("Ok(())"),
        "the signature scan must stop at the return arrow, or a body mentioning \
         a state type would classify as holding it"
    );
}

// ============================================================================
// THE XLSX LOSS-REPORT CENSUS
// ============================================================================
//
// `xlsx_save_loss_report` tells the user what a .xlsx save will destroy. It was
// a hand-maintained list of 24 checks with NOTHING tying it to the thing it
// describes, and it had drifted exactly the way every unpinned list does: eight
// stores were dropped in silence, including `Workbook::controls` -- the
// cell-anchored control store, where every embedded IMAGE lives. (The report
// did have a "Pane controls" line, but that reads `PaneControlState.controls`,
// a different store entirely, so a workbook full of pictures reported no loss.)
//
// This is the producer the list never had: the field names come out of
// `persistence::Workbook` at TEST TIME, so a new field cannot be added without
// deciding whether an .xlsx save loses it.

#[cfg(test)]
mod xlsx_loss_census {
    /// The `pub` field names of `persistence::Workbook`, read from source.
    fn workbook_fields() -> Vec<String> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../core/persistence/src/lib.rs");
        let src = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("cannot read {}: {}", path.display(), e));

        let anchor = "pub struct Workbook {";
        let start = src
            .find(anchor)
            .unwrap_or_else(|| panic!("`{}` not found -- the struct was renamed", anchor))
            + anchor.len();

        let mut depth = 1usize;
        let mut end = start;
        for (i, ch) in src[start..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = start + i;
                        break;
                    }
                }
                _ => {}
            }
        }
        assert!(end > start, "unbalanced braces in Workbook");

        let mut fields = Vec::new();
        for line in src[start..end].lines() {
            let line = line.trim();
            // Skip attributes, comments and doc comments.
            if line.starts_with('#') || line.starts_with("//") {
                continue;
            }
            let Some(rest) = line.strip_prefix("pub ") else { continue };
            let Some((name, _)) = rest.split_once(':') else { continue };
            let name = name.trim();
            if !name.is_empty() && name.chars().all(|c| c.is_ascii_lowercase() || c == '_' || c.is_ascii_digit()) {
                fields.push(name.to_string());
            }
        }
        assert!(
            fields.len() > 20,
            "parsed only {} fields out of Workbook -- the struct shape changed",
            fields.len()
        );
        fields
    }

    #[test]
    fn the_loss_report_covers_every_workbook_field() {
        let covered: std::collections::HashMap<&str, &str> =
            crate::persistence::XLSX_LOSS_COVERAGE.iter().copied().collect();

        let mut missing = Vec::new();
        for field in workbook_fields() {
            if !covered.contains_key(field.as_str()) {
                missing.push(field);
            }
        }
        assert!(
            missing.is_empty(),
            "these `persistence::Workbook` fields have no entry in \
             XLSX_LOSS_COVERAGE, so nobody has decided whether saving as .xlsx \
             destroys them:\n  {}\n\nAdd each one as WRITTEN (the writer emits \
             it), REPORTED (dropped, and `xlsx_save_loss_report` says so), or \
             SILENT (dropped, WITH the reason it needs no line).",
            missing.join("\n  ")
        );
    }

    #[test]
    fn the_coverage_table_names_no_field_that_no_longer_exists() {
        let fields: std::collections::HashSet<String> = workbook_fields().into_iter().collect();
        let stale: Vec<&str> = crate::persistence::XLSX_LOSS_COVERAGE
            .iter()
            .map(|(f, _)| *f)
            .filter(|f| !fields.contains(*f))
            .collect();
        assert!(
            stale.is_empty(),
            "XLSX_LOSS_COVERAGE names fields that are not on \
             `persistence::Workbook` any more: {:?}. A stale entry is how a \
             REAL field ends up looking covered.",
            stale
        );
    }

    #[test]
    fn every_coverage_entry_states_a_verdict() {
        for (field, reason) in crate::persistence::XLSX_LOSS_COVERAGE {
            assert!(
                reason.starts_with("WRITTEN")
                    || reason.starts_with("REPORTED")
                    || reason.starts_with("SILENT"),
                "coverage entry for `{}` must start with WRITTEN, REPORTED or \
                 SILENT so the verdict is readable at a glance; got {:?}",
                field,
                reason
            );
            // A SILENT verdict is the only one that can hide data loss, so it
            // has to argue for itself rather than just assert.
            if reason.starts_with("SILENT") {
                assert!(
                    reason.len() > 40,
                    "the SILENT verdict for `{}` needs a written reason, not a \
                     label: {:?}",
                    field,
                    reason
                );
            }
        }
    }

    /// The census must be able to SEE an uncovered field.
    #[test]
    fn the_loss_census_detector_actually_fires() {
        let covered: std::collections::HashSet<&str> = crate::persistence::XLSX_LOSS_COVERAGE
            .iter()
            .map(|(f, _)| *f)
            .collect();
        assert!(
            !covered.contains("a_field_nobody_declared"),
            "sanity: the coverage set must not contain an invented name"
        );
        // And the real parse must find the field that started all this.
        let fields = workbook_fields();
        assert!(
            fields.iter().any(|f| f == "controls"),
            "the field parser no longer sees `controls` -- the store whose \
             omission destroyed every embedded image without a warning"
        );
        assert!(
            fields.iter().any(|f| f == "media"),
            "the field parser no longer sees `media`"
        );
    }

    // ========================================================================
    // THE .calp PUBLISH-COVERAGE CENSUS
    // ========================================================================
    //
    // The same producer, for the OTHER distribution path, and it was missing for
    // the same reason: `compute_publish_report` is a hand-maintained account of
    // what a package carries and what it leaves behind, with nothing tying it to
    // `persistence::Workbook`. It had drifted. `cell_behaviors` was neither
    // carried nor mentioned, so a published report's typed cells arrived inert;
    // `workbook_protection`, `bi_connection_roles` and the two workbook-wide
    // grid defaults were dropped with no line anywhere admitting it.
    //
    // A .calp is sent to somebody else, so a silent drop is worse here than in
    // the xlsx case: the subscriber cannot tell an incomplete report from a
    // complete one.

    #[test]
    fn the_publish_report_covers_every_workbook_field() {
        let covered: std::collections::HashMap<&str, &str> =
            crate::calp_commands::CALP_PUBLISH_COVERAGE.iter().copied().collect();

        let mut missing = Vec::new();
        for field in workbook_fields() {
            if !covered.contains_key(field.as_str()) {
                missing.push(field);
            }
        }
        assert!(
            missing.is_empty(),
            "these `persistence::Workbook` fields have no entry in \
             CALP_PUBLISH_COVERAGE, so nobody has decided whether publishing a \
             .calp carries them:\n  {}\n\nAdd each one as CARRIED (the publish \
             writes it into the package), EXCLUDED (dropped, and \
             `compute_publish_report` says so), or SILENT (dropped, WITH the \
             reason it needs no line).",
            missing.join("\n  ")
        );
    }

    #[test]
    fn the_publish_coverage_table_names_no_field_that_no_longer_exists() {
        let fields: std::collections::HashSet<String> = workbook_fields().into_iter().collect();
        let stale: Vec<&str> = crate::calp_commands::CALP_PUBLISH_COVERAGE
            .iter()
            .map(|(f, _)| *f)
            .filter(|f| !fields.contains(*f))
            .collect();
        assert!(
            stale.is_empty(),
            "CALP_PUBLISH_COVERAGE names fields that are not on \
             `persistence::Workbook` any more: {:?}. A stale entry is how a REAL \
             field ends up looking covered.",
            stale
        );
    }

    #[test]
    fn every_publish_coverage_entry_states_a_verdict() {
        for (field, reason) in crate::calp_commands::CALP_PUBLISH_COVERAGE {
            assert!(
                reason.starts_with("CARRIED")
                    || reason.starts_with("EXCLUDED")
                    || reason.starts_with("SILENT"),
                "coverage entry for `{}` must start with CARRIED, EXCLUDED or \
                 SILENT so the verdict is readable at a glance; got {:?}",
                field,
                reason
            );
            // SILENT is the only verdict that can hide a loss from BOTH the
            // author and the subscriber, so it has to argue rather than assert.
            if reason.starts_with("SILENT") {
                assert!(
                    reason.len() > 60,
                    "the SILENT verdict for `{}` needs a written reason, not a \
                     label: {:?}",
                    field,
                    reason
                );
            }
        }
    }

    /// Every EXCLUDED verdict names the report category the author actually
    /// sees, and that category has to EXIST in `compute_publish_report`.
    ///
    /// This is the half a plain coverage list cannot check. "EXCLUDED: reported
    /// 'gridDefaults'" is a claim about another function, and a claim about
    /// another function is exactly the kind of statement that silently stops
    /// being true — which is how `protection` came to be the only exclusion line
    /// while three more categories were being dropped without one.
    #[test]
    fn every_excluded_verdict_names_a_category_the_report_emits() {
        let report_src = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/calp_commands.rs"),
        )
        .expect("cannot read calp_commands.rs");

        let mut unbacked = Vec::new();
        for (field, reason) in crate::calp_commands::CALP_PUBLISH_COVERAGE {
            if !reason.starts_with("EXCLUDED") && !reason.contains("EXCLUDED and reported") {
                continue;
            }
            // The category is the single-quoted name in the verdict.
            let Some(open) = reason.find('\'') else {
                unbacked.push(format!("{}: EXCLUDED verdict names no category", field));
                continue;
            };
            let rest = &reason[open + 1..];
            let Some(close) = rest.find('\'') else {
                unbacked.push(format!("{}: unterminated category name", field));
                continue;
            };
            let category = &rest[..close];
            let needle = format!("&mut excluded, \"{}\"", category);
            if !report_src.contains(&needle) {
                unbacked.push(format!(
                    "{}: claims the report emits an `excluded` category {:?}, and \
                     `compute_publish_report` has no such line",
                    field, category
                ));
            }
        }
        assert!(
            unbacked.is_empty(),
            "these EXCLUDED verdicts are not backed by the transparency report \
             they cite:\n  {}",
            unbacked.join("\n  ")
        );
    }

    /// The publish census must be able to SEE an uncovered field, and the
    /// EXCLUDED-verdict check must be able to see an unbacked claim.
    #[test]
    fn the_publish_census_detectors_actually_fire() {
        let covered: std::collections::HashSet<&str> =
            crate::calp_commands::CALP_PUBLISH_COVERAGE
                .iter()
                .map(|(f, _)| *f)
                .collect();
        assert!(
            !covered.contains("a_field_nobody_declared"),
            "sanity: the coverage set must not contain an invented name"
        );
        // The field that started this one: a behaviour binding is the only piece
        // of granular-brick content that never travelled in a package.
        let fields = workbook_fields();
        assert!(
            fields.iter().any(|f| f == "cell_behaviors"),
            "the field parser no longer sees `cell_behaviors` -- the store whose \
             omission shipped reports full of inert typed cells"
        );

        // SABOTAGE the EXCLUDED-verdict check: a category the report does not
        // emit must be reported as unbacked. Same parse, fake input.
        let report_src = "item(&mut excluded, \"workbookFiles\", 1, \"...\");";
        let verdict = "EXCLUDED: reported 'aCategoryNobodyEmits'";
        let open = verdict.find('\'').expect("test verdict has a quote");
        let rest = &verdict[open + 1..];
        let close = rest.find('\'').expect("test verdict closes its quote");
        let needle = format!("&mut excluded, \"{}\"", &rest[..close]);
        assert!(
            !report_src.contains(&needle),
            "the EXCLUDED-verdict detector cannot see an unbacked category, so \
             it would pass on a report that stopped emitting one"
        );
    }
}

/// **EVERY `AppState` STORE THE SAVE PATH READS MUST BE `Persisted<T>`** — the
/// gating twin of `every_store_the_save_path_reads_is_reset_when_the_document_is_replaced`.
///
/// WHY THIS BELONGS HERE and not beside `DocumentEffect`. The population is
/// already computed in this file, exactly and defensibly:
/// `store_accesses(call_closure(&fns, SAVE_ROOTS))` IS "every store a saved
/// workbook or a published package is projected from". A second reachability
/// walk elsewhere would be a second source of truth for the same fact, and the
/// first thing two copies of a fact do is disagree.
///
/// WHY IT IS NOT ALREADY COVERED. The reset census above asks a different
/// question — is this store CLEARED when the document is replaced — and both
/// halves are needed for different failures:
///
/// | census | failure it prevents |
/// |---|---|
/// | reset (above) | the next document you save physically contains the previous one's content |
/// | gating (here) | a command changes what lands on disk without deciding whether the document is dirty, so the close prompt and AutoRecover both lie |
///
/// A store can pass one and fail the other, and on 2026-08-17 three did:
/// `spill_ranges`, `advanced_filter_hidden_rows` and `pending_recalc` were all
/// correctly RESET — so the census above was green — while sitting on bare
/// `Mutex`es that no `DocumentEffect` guarded. The audit that found the first two
/// missed the third; this census found it.
///
/// WHY `every_persisted_appstate_store_is_gated_not_a_bare_mutex` (in
/// `document_effect.rs`) did not catch them either: its list is 22 HAND-WRITTEN
/// field names, so it proves those 22 have not regressed and is structurally
/// blind to everything else. Derive the population, do not list it.
///
/// THE EXEMPTION LIST HAS EXACTLY ONE ENTRY, and it is none of the three. All
/// three offenders were PROMOTED rather than excused. The single exemption is
/// `protected_regions`, and it earns it on a fact rather than an opinion: it never
/// reaches a `.cala` save at all (`rg protected_regions src/persistence.rs`
/// returns one hit, the reset), so no change to it can make a saved document
/// stale, and its own declaration says the extensions that own it — pivot tables,
/// charts — re-register it every session. `DocumentEffect::mutates` would be a
/// false statement about it.
///
/// Before adding a second entry, read `spill_restore.rs`. `spill_ranges` looked
/// exactly like a derived cache that needed no gate, and that module header
/// explains why it is the opposite: a spilled `2` and a typed `2` are the same
/// bytes, so ownership cannot be recomputed at any price. "It looks derived" is
/// not a reason; "it is never written to disk" is.
#[test]
fn every_store_the_save_path_reads_is_gated_by_a_document_effect() {
    let sources = read_crate_sources();
    let fns = index_functions(&sources);
    let reads = store_accesses(&call_closure(&fns, SAVE_ROOTS));

    // The declarations, with WRAPPED ones joined: `application_connection_restore_skips`
    // puts its type on a continuation line, and a per-line reading of the struct
    // mistakes it for a field with no lock at all.
    let lib = sources
        .iter()
        .find(|(p, _)| p.ends_with("lib.rs"))
        .map(|(_, t)| t.clone())
        .expect("the crate walk must include lib.rs");
    let mut decls: BTreeMap<String, String> = BTreeMap::new();
    let mut in_struct = false;
    let mut pending: Option<(String, String)> = None;
    for line in lib.lines() {
        if !in_struct {
            if line.starts_with("pub struct AppState") {
                in_struct = true;
            }
            continue;
        }
        if line == "}" {
            break;
        }
        let t = line.trim();
        if t.starts_with("//") {
            continue;
        }
        if t.starts_with("pub ") && t.contains(':') {
            if let Some((n, ty)) = pending.take() {
                decls.insert(n, ty);
            }
            let rest = &t["pub ".len()..];
            let colon = rest.find(':').expect("a declaration has a colon");
            pending = Some((
                rest[..colon].trim().to_string(),
                rest[colon + 1..].trim().to_string(),
            ));
        } else if let Some((_, ty)) = pending.as_mut() {
            ty.push(' ');
            ty.push_str(t);
        }
    }
    if let Some((n, ty)) = pending.take() {
        decls.insert(n, ty);
    }
    assert!(
        decls.len() > 90,
        "parsed only {} AppState fields — the struct parse has broken and this \
         census would pass vacuously",
        decls.len()
    );

    // NON-VACUITY, and it is the load-bearing half of this test. The three stores
    // this census was built for must be inside its own population; otherwise a
    // green result means nothing.
    for field in ["spill_ranges", "advanced_filter_hidden_rows", "pending_recalc"] {
        let must = &format!("AppState.{}", field);
        assert!(
            reads.contains_key(must),
            "`{}` is a save source this census exists to gate, and the population \
             does not contain it. Either SAVE_ROOTS has drifted or the store is now \
             reached through a path `call_closure` cannot see — fix that before \
             trusting any pass of this test.",
            must
        );
    }

    // (field, why it needs no `DocumentEffect`). Deliberately minimal; the doc
    // comment above states the bar an entry has to clear.
    const PUBLISH_ONLY_DERIVED: &[(&str, &str)] = &[(
        "protected_regions",
        "publish-only and never written to a .cala (persistence.rs touches it once,          to reset it), and re-registered every session by the extensions that own          it (pivots, charts). A change to it cannot make a SAVED document stale,          which is the only thing is_modified claims.",
    )];

    let mut ungated: Vec<String> = Vec::new();
    for (key, via) in &reads {
        // Keys are `<StructName>.<field>`; only `AppState` is `Persisted`-gated.
        // The other receivers (`SlicerState`, `RibbonFilterState`, ...) carry their
        // own discipline and are not this census's subject.
        let Some(field) = key.strip_prefix("AppState.") else {
            continue;
        };
        let Some(ty) = decls.get(field) else {
            continue; // a local binding, or a field this parse did not see
        };
        if PUBLISH_ONLY_DERIVED.iter().any(|(n, _)| *n == field) {
            continue;
        }
        if !ty.contains("Persisted<") {
            let mut who: Vec<&str> = via.iter().map(|s| s.as_str()).collect();
            who.sort_unstable();
            who.truncate(3);
            ungated.push(format!("{} : {}   (via {})", field, ty, who.join(", ")));
        }
    }
    ungated.sort();

    assert!(
        ungated.is_empty(),
        "these AppState stores are read by the SAVE or PUBLISH path while sitting \
         on a bare lock, so a command can change what lands on disk without any \
         `DocumentEffect` having decided whether the document is dirty — which \
         breaks the close prompt and AutoRecover together, silently:\n  {}\n\n\
         Promote each to `Persisted<T>`. Do NOT add an exemption without first \
         reading `spill_restore.rs` on why a store that looks derived may be the \
         opposite.",
        ungated.join("\n  ")
    );

    // AN EXEMPTION MUST NOT OUTLIVE ITS SUBJECT. A stale name reads as a
    // considered decision about code that no longer exists -- the failure a
    // suppression list in this repo already had once, where an entry outlived its
    // bug and blinded a walker. Same check the reset census applies to its EXEMPT.
    let stale: Vec<&str> = PUBLISH_ONLY_DERIVED
        .iter()
        .map(|(n, _)| *n)
        .filter(|n| !reads.contains_key(&format!("AppState.{}", n)))
        .collect();
    assert!(
        stale.is_empty(),
        "PUBLISH_ONLY_DERIVED names stores no projection path reads any more, so \
         the exemption is now a claim about nothing:\n  {}",
        stale.join("\n  ")
    );

    // ...and it must not excuse something that has since become gated anyway.
    let redundant: Vec<&str> = PUBLISH_ONLY_DERIVED
        .iter()
        .map(|(n, _)| *n)
        .filter(|n| decls.get(*n).is_some_and(|t| t.contains("Persisted<")))
        .collect();
    assert!(
        redundant.is_empty(),
        "these are exempted but are already Persisted<T>, so the exemption is dead \
         weight that weakens the list:\n  {}",
        redundant.join("\n  ")
    );
}


// ============================================================================
// INVARIANT 3 — the population of STATES is itself derived, not listed
// ============================================================================
// Invariants 1 and 2 both take the set of States as GIVEN. Invariant 1 asks
// which stores the SAVE path reads; invariant 2 asks about every field of every
// State `those paths reset`. Both populations are downstream of a list somebody
// maintains by hand — `STATE_FIELD_SOURCES` — and a store that is in NEITHER the
// save path NOR the reset function is outside both. It is therefore invisible to
// this file, which is the one file whose whole job is to see it.
//
// That is not hypothetical. Measured 2026-08-18: `TimelineSlicerState` is managed
// at `lib.rs:4839` and is
//   - never saved      (/timeline/i occurs ZERO times in persistence.rs), so
//                      invariant 1's save-source population cannot contain it, and
//   - never reset      (it is not a parameter of `reset_document_scoped_stores`),
//                      so invariant 2's field population cannot contain it either.
// Consequence: a timeline slicer from document A survives File > New / Open into
// document B — the exact data-INJECTION class this census was built to end, in a
// store the census could not look at. Filed as BUG-0103.
//
// So the population comes from the one place that cannot omit a store: the
// `.manage(...)` calls that hand a State to Tauri. Every managed State must be
// either CENSUSED (it appears in `STATE_FIELD_SOURCES`, so invariant 2 walks its
// fields) or NOT_DOCUMENT_SCOPED with a written reason. There is no third answer,
// and adding a `.manage(...)` line without choosing one fails this test on the
// commit that adds it.

/// Managed States that are deliberately NOT the document's, each with the reason.
///
/// Getting an entry wrong here is dangerous in BOTH directions, exactly as with
/// `SESSION_SCOPED`: wrongly listing a store here reopens the leak class, and
/// wrongly omitting one forces a reset that throws away the user's own settings.
const NOT_DOCUMENT_SCOPED: &[(&str, &str)] = &[
    (
        "FileState",
        "the document's IDENTITY and dirty flag, not its content. It is what the          document-replacing paths SET (mark_saved / the DirtyFlag transition);          resetting it from inside the shared reset would be circular.",
    ),
    (
        "CapabilityStore",
        "the user's standing permission grants. Resetting it on File > Open would          silently RE-ARM capabilities the user turned off, which is the same          argument that keeps ScriptState.permission_grants out of the reset.",
    ),
    (
        "EvalFormulaState",
        "a per-call scratch buffer for the evaluate_formula command, refilled on          every invocation and read by nothing else. It carries no document state          between calls.",
    ),
    (
        "McpState",
        "the MCP server's own session: listeners, tool registration and transport.          Machine-scoped — it outlives any one document on purpose.",
    ),
    (
        "ManagedAppearanceState",
        "enterprise appearance POLICY, read from the machine at startup. It is the          administrator's, not the document's.",
    ),
];

/// Every `.manage(...)` State is censused or explicitly not the document's.
#[test]
fn every_managed_state_is_classified() {
    let lib = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs"),
    )
    .expect("lib.rs must be readable");

    // The type name handed to `.manage(...)`, taken as the last path segment
    // before the constructor call, so `slicer::SlicerState::new()` reads as
    // `SlicerState` and `FileState::default()` reads as `FileState`.
    let mut managed: Vec<String> = Vec::new();
    for line in lib.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("//") {
            continue;
        }
        let Some(rest) = trimmed.strip_prefix(".manage(") else {
            continue;
        };
        // `create_app_state()` is a factory rather than a type path; it returns
        // AppState, which is the name the rest of this file uses.
        if rest.starts_with("create_app_state") {
            managed.push("AppState".to_string());
            continue;
        }
        let head: String = rest
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == ':')
            .collect();
        let name = head.rsplit("::").find(|s| !s.is_empty()).unwrap_or("");
        // Skip the constructor segment when the spelling is `path::Type::new`.
        let name = if name == "new" || name == "default" {
            let parts: Vec<&str> = head
                .split("::")
                .filter(|s| !s.is_empty() && *s != "new" && *s != "default")
                .collect();
            parts.last().copied().unwrap_or("")
        } else {
            name
        };
        if !name.is_empty() {
            managed.push(name.to_string());
        }
    }

    // Non-vacuity: a parse that found nothing would make every assertion below
    // pass while checking no store at all.
    assert!(
        managed.len() >= 10,
        "only {} managed States were parsed out of lib.rs, so this census is          checking almost nothing — the `.manage(...)` spelling has probably          changed:\n  {}",
        managed.len(),
        managed.join("\n  ")
    );

    let censused: Vec<&str> = STATE_FIELD_SOURCES.iter().map(|(n, _, _)| *n).collect();
    let unclassified: Vec<&String> = managed
        .iter()
        .filter(|m| {
            !censused.contains(&m.as_str())
                && !NOT_DOCUMENT_SCOPED.iter().any(|(n, _)| n == &m.as_str())
        })
        .collect();

    assert!(
        unclassified.is_empty(),
        "these States are handed to Tauri by `.manage(...)` but are NEITHER          censused (STATE_FIELD_SOURCES, so invariant 2 walks their fields) NOR          listed in NOT_DOCUMENT_SCOPED with a reason:\n  {}\n\n         A store in neither set is invisible to this whole file: it is not a save          source, so invariant 1 cannot see it, and it is not reset, so invariant 2          cannot see it. That is how a timeline slicer came to survive File > New          into the next document (BUG-0103). Choose one — enrol it in          `reset_document_scoped_stores` and add it to STATE_FIELD_SOURCES, or write          down why it is not the document's.",
        unclassified
            .iter()
            .map(|s| s.as_str())
            .collect::<Vec<_>>()
            .join("\n  ")
    );

    // ...and the exemption list may not outlive its stores, the same rule
    // SESSION_SCOPED carries: a stale entry is a hole nobody can see.
    let stale: Vec<&str> = NOT_DOCUMENT_SCOPED
        .iter()
        .map(|(n, _)| *n)
        .filter(|n| !managed.iter().any(|m| m == n))
        .collect();
    assert!(
        stale.is_empty(),
        "NOT_DOCUMENT_SCOPED names States that are no longer managed:\n  {}",
        stale.join("\n  ")
    );

    // Every reason must be a reason, not a label.
    for (name, reason) in NOT_DOCUMENT_SCOPED {
        assert!(
            reason.len() > 60,
            "{name}'s exemption reason is too short to be an argument: {reason:?}"
        );
    }
}
