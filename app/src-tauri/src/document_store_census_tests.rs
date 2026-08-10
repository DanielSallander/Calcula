//! FILENAME: app/src-tauri/src/document_store_census_tests.rs
//! PURPOSE: The DOCUMENT-SCOPED STORE CENSUS — every store `assemble_workbook_for_save`
//!          reads must be reset when the document is replaced.
//! CONTEXT: The acceptance test for a whole defect class. See the module docs below.

//! # The invariant
//!
//! > **A store `assemble_workbook_for_save` reads is reset by the
//! > document-replacing paths.**
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
//! # The two hardening lessons inherited from the recalculation census
//!
//! 1. **It must see through a delegating helper.** Both sides delegate: the save
//!    path reads `BiState` only inside `capture_local_bi_connections`, and the
//!    reset reaches it only inside `reset_bi_connections`. A census that read
//!    just the two top-level bodies would see neither and pass while both halves
//!    were missing.
//! 2. **A commented-out call must not satisfy it.** Every call site here is
//!    wrapped in a comment explaining it, so a careless deletion leaves the name
//!    behind as text. Both sides therefore read comment-stripped code.
//!
//! Both lessons are asserted, on synthetic sources, by
//! `the_census_detector_actually_fires` below — so they run on every build
//! instead of once in somebody's head.

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
];

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
const DOCUMENT_REPLACING_PATHS: &[&str] = &["new_file", "open_file"];

/// Stores the save path reads that the reset deliberately does not touch.
///
/// EMPTY, and it should stay that way. It exists because an exemption is a
/// DECISION, and the mechanism for recording one has to be present before it is
/// needed — a census with no way to say "no, deliberately" gets a `#[ignore]`
/// bolted onto it the first time somebody disagrees with it. Every entry must
/// carry a reason somebody wrote; `every_exemption_carries_a_written_reason`
/// refuses an empty one.
const EXEMPT: &[(&str, &str)] = &[];

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

/// The `Store.field` keys mentioned in one comment-stripped body.
fn scan_store_accesses(code: &str) -> Vec<(String, String)> {
    const ACCESSORS: [&str; 3] = ["read", "write", "lock"];
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

/// EVERY store the save path reads, classified — the census the hand-written
/// list cannot be.
///
/// A new store read by `assemble_workbook_for_save` (or by anything it calls)
/// fails this test until somebody decides, in writing, whether replacing the
/// document must reset it.
#[test]
fn every_store_the_save_path_reads_is_reset_when_the_document_is_replaced() {
    let sources = read_crate_sources();
    let fns = index_functions(&sources);

    let save_closure = call_closure(&fns, &["assemble_workbook_for_save"]);
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
        "these stores are written into every saved workbook but are NOT reset \
         when the document is replaced:\n  {}\n\nThis is the PivotState / \
         RibbonFilterState / BiState class: an unreset store is an UNSCOPED \
         store, and the save path cannot tell the difference — the next \
         document the user saves will physically contain this one's content. \
         Either reset it in `persistence::reset_document_scoped_stores` (which \
         both `new_file` and `open_file` run) or add it to EXEMPT with the \
         reason it needs no reset.",
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
        "EXEMPT names stores the save path no longer reads:\n  {}",
        stale.join("\n  ")
    );

    // NON-VACUITY. The census must be finding the members it was built for —
    // the three §2w named, plus the two the enumeration itself turned up.
    for known in [
        "PivotState.pivot_tables",
        "RibbonFilterState.filters",
        "BiState.connections",
        "AppState.sheet_ids",
        "AppState.model_writeback",
        "AppState.advanced_filter_hidden_rows",
    ] {
        assert!(
            reads.contains_key(known),
            "the census did not even find `{}` among the save path's sources — \
             it is not measuring what it claims to",
            known
        );
    }
    assert!(
        reads.len() > 50,
        "the save path was found to read only {} stores; it reads dozens, so \
         the walk is broken rather than the crate",
        reads.len()
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
    ("calp_get_package_objects", "reads a package's inventory to show it"),
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
