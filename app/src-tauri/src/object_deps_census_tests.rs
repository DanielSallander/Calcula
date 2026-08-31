//! FILENAME: app/src-tauri/src/object_deps_census_tests.rs
//! PURPOSE: THE OBJECT-DEPENDENCY CENSUS — every delete command in the crate
//!          must declare what happens to the objects that point at what it
//!          deletes, and every declared cascade must be executed by the command
//!          that owns it.
//! CONTEXT: §3bn in docs/design/open-decisions-2026-08.md. The seventh census.
//!
//! # The invariant, in three parts
//!
//! > 1. **Every `#[tauri::command]` that DELETES is classified** — either it
//! >    names the [`ObjectKind`] it deletes, or it is written down as
//! >    out-of-scope with a reason.
//! > 2. **Every `ObjectKind` has at least one row in [`DEPENDENCY_MATRIX`]** —
//! >    including "nothing points at this", which must be argued rather than
//! >    assumed.
//! > 3. **Every row whose policy needs code names a symbol the owning delete
//! >    command actually calls.** A policy that is only a comment is not a
//! >    policy.
//!
//! # Why a census and not the three `retain` calls the bug asked for
//!
//! The measured defect was one pair: delete a table, its slicer survives with a
//! live binding to a dead id. Fixing that pair alone would have left five
//! siblings that this table found by enumeration — pivot -> timeline slicer,
//! pivot -> ribbon filter targets, slicer -> filter cross-links, filter ->
//! sibling filter cross-links, chart -> pane-control chart binding — plus the
//! whole floating-object family that no sheet operation had ever re-anchored.
//!
//! The reason those were invisible is structural: nothing anywhere compared the
//! set of things that can be deleted against the set of things that hold a
//! reference. That comparison is a test. This is it, and it is written so that
//! it fails for the pair NOBODY THOUGHT OF: adding a delete command without a
//! row fails part 1, adding an object kind without a row fails part 2, and
//! declaring a cascade you did not write fails part 3.
//!
//! # The parse, and the four ways a naive one is wrong
//!
//! All four are asserted below by `the_census_detector_actually_fires`, on
//! synthetic sources, so they run on every build instead of once in somebody's
//! head:
//!
//! 1. **A commented-out call must not satisfy the census.** Both sides read
//!    comment-stripped source, so `// crate::object_deps::cascade_...` is text.
//! 2. **It must see through one level of delegation.** `remove_auto_filter` is
//!    a two-line wrapper around `remove_auto_filter_inner`, and `delete_chart`
//!    reaches its undo through `record_chart_undo`. A census reading only the
//!    command's own body would pass vacuously for the wrapper and fail wrongly
//!    for the delegate.
//! 3. **A free function is not an `impl` method.** The body walk takes
//!    indentation 0 only; at deeper indents a `Drop` impl's `fn drop` resolves
//!    as the `drop(guard)` every lock release calls and drags the whole crate
//!    into the closure.
//! 4. **The walk must be finding something.** A broken scanner reports an empty
//!    command set and every assertion passes vacuously, so the counts are
//!    floor-checked against the crate as it actually is.

use std::collections::{BTreeMap, BTreeSet};

use crate::object_deps::{DeletePolicy, ObjectKind, DEPENDENCY_MATRIX};

// ---------------------------------------------------------------------------
// The classification
// ---------------------------------------------------------------------------

/// EVERY delete command that removes a WORKBOOK OBJECT, and the object it
/// removes.
///
/// `convert_to_range` is in here despite not being spelled like a delete: it
/// destroys the table object outright, which is exactly what every dependent
/// cares about. Excel agrees — Convert to Range removes the table's slicers.
/// Leaving it out was how the identical orphan survived on a second path.
const DELETE_COMMANDS: &[(&str, ObjectKind)] = &[
    ("delete_table", ObjectKind::Table),
    ("convert_to_range", ObjectKind::Table),
    ("remove_table_column", ObjectKind::TableColumn),
    ("delete_pivot_table", ObjectKind::Pivot),
    ("delete_pivot_layout", ObjectKind::PivotLayout),
    ("delete_chart", ObjectKind::Chart),
    ("delete_slicer", ObjectKind::Slicer),
    ("delete_timeline_slicer", ObjectKind::TimelineSlicer),
    ("delete_ribbon_filter", ObjectKind::RibbonFilter),
    ("delete_pane_control", ObjectKind::PaneControl),
    ("remove_control_metadata", ObjectKind::FloatingControl),
    ("delete_named_range", ObjectKind::NamedRange),
    ("delete_named_style", ObjectKind::NamedStyle),
    ("delete_sheet", ObjectKind::Sheet),
    ("delete_floating_range", ObjectKind::FloatingRange),
    ("delete_report", ObjectKind::Report),
    ("delete_script", ObjectKind::Script),
    ("delete_object_script", ObjectKind::ObjectScript),
    ("delete_object_scripts_for_instance", ObjectKind::ObjectScript),
    ("delete_object_template", ObjectKind::ObjectTemplate),
    ("remove_cell_behavior", ObjectKind::CellBehavior),
    ("delete_conditional_format", ObjectKind::ConditionalFormat),
    ("delete_sparklines", ObjectKind::Sparkline),
    ("clear_all_sparklines", ObjectKind::Sparkline),
    ("remove_auto_filter", ObjectKind::AutoFilter),
    ("delete_comment", ObjectKind::Comment),
    ("delete_reply", ObjectKind::Comment),
    ("clear_all_comments", ObjectKind::Comment),
    ("delete_note", ObjectKind::Note),
    ("clear_all_notes", ObjectKind::Note),
    ("remove_hyperlink", ObjectKind::Hyperlink),
    ("remove_computed_property", ObjectKind::ComputedProperty),
    ("remove_slicer_computed_property", ObjectKind::ComputedProperty),
    ("bi_delete_connection", ObjectKind::BiConnection),
];

/// Delete commands that are NOT workbook-object deletions, each with the reason.
///
/// The list is small, argued and dangerous to get wrong in the permissive
/// direction: putting a real object here is exactly how a dependent goes
/// undeclared. `SESSION_SCOPED` in the document-store census is the precedent
/// and the standard — a one-line reason that a reviewer can disagree with.
const OUT_OF_SCOPE: &[(&str, &str)] = &[
    (
        "delete_rows",
        "A RANGE operation, not an object deletion. What it does to objects \
         anchored in the deleted band is the structural-shift machinery \
         (shift_controls, the spill twin maps, shift_writeback_draft_regions), \
         which the recalculation census governs.",
    ),
    (
        "delete_columns",
        "Same as delete_rows.",
    ),
    (
        "remove_duplicates",
        "A data operation over cell VALUES; it deletes no object.",
    ),
    (
        "remove_row_page_break",
        "A print-layout scalar. Nothing can hold a page break.",
    ),
    (
        "remove_col_page_break",
        "Same as remove_row_page_break.",
    ),
    (
        "remove_allow_edit_range",
        "A sub-record of one sheet's protection settings, addressed by its \
         position in that record. It has no id anything else can carry.",
    ),
    (
        "remove_pivot_hierarchy",
        "Edits a pivot's OWN definition (which fields are placed). The pivot \
         object survives; nothing outside it names a placed hierarchy.",
    ),
    (
        "remove_calculated_field",
        "Same as remove_pivot_hierarchy: part of the pivot's definition.",
    ),
    (
        "remove_calculated_item",
        "Same as remove_pivot_hierarchy.",
    ),
    (
        "delete_virtual_file",
        "The user-visible virtual filesystem, which is user-owned BY DESIGN: \
         the Workbook::media doc comment records that the user may delete their \
         own logo out from under a picture. Media that must not vanish is \
         content-addressed in `media`, not here.",
    ),
    (
        "calp_remove_writeback_region",
        "An author-side publish selector. Nothing in the workbook holds a \
         region id -- submissions are keyed by dataset on the SUBSCRIBER side, \
         in a published package, not in this document.",
    ),
    (
        "calp_remove_workspace",
        "An app-level list of package sources (machine scope), not a workbook \
         object.",
    ),
    (
        "keychain_delete_password",
        "A credential in the OS keychain.",
    ),
    (
        "ai_provider_delete_key",
        "A credential in the OS keychain — one slot per AI provider. Nothing in \
         the document points at it, and forgetting a key only means the user is \
         asked for it again. (Was `ai_chat_delete_api_key` until M3 made key \
         storage per-provider; this census is what caught the rename.)",
    ),
];

/// The BI model editor's own delete surface — a separate domain with its own
/// referential integrity, enforced inside the `bi-engine` crate (a measure that
/// a KPI references cannot be dropped there either). Matched by PREFIX so the
/// nineteen of them, and any twentieth, are covered by one written reason
/// instead of nineteen copies of it.
const OUT_OF_SCOPE_PREFIXES: &[(&str, &str)] = &[(
    "bi_model_delete_",
    "The semantic model's own object graph, owned by model-engine-lib and \
     validated there. The HOST-side dependents of the model as a whole are \
     covered by the ObjectKind::BiConnection row.",
)];

// ---------------------------------------------------------------------------
// The parse
// ---------------------------------------------------------------------------

/// Every `.rs` file under the crate's `src`, minus the test sources.
fn read_crate_sources() -> Vec<(String, String)> {
    let src_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    assert!(
        src_root.is_dir(),
        "the crate source tree is not readable at {} — this census reads the \
         tree, not a list",
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
        out.push((rel, strip_comments(&text)));
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

/// Strip `//` line comments and `/* */` blocks, preserving line structure.
///
/// HARDENING 1: a commented-out call must not satisfy the census. Every cascade
/// call site in the crate sits under a comment explaining it, so a careless
/// deletion leaves the symbol behind as prose — and prose would otherwise read
/// as an implementation.
pub(crate) fn strip_comments(source: &str) -> String {
    let bytes: Vec<char> = source.chars().collect();
    let mut out = String::with_capacity(source.len());
    let mut i = 0;
    let mut in_string = false;
    let mut in_char = false;
    while i < bytes.len() {
        let c = bytes[i];
        let next = bytes.get(i + 1).copied().unwrap_or('\0');
        if in_string {
            out.push(c);
            if c == '\\' {
                if let Some(&n) = bytes.get(i + 1) {
                    out.push(n);
                    i += 2;
                    continue;
                }
            }
            if c == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        if in_char {
            out.push(c);
            if c == '\\' {
                if let Some(&n) = bytes.get(i + 1) {
                    out.push(n);
                    i += 2;
                    continue;
                }
            }
            if c == '\'' {
                in_char = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_string = true;
            out.push(c);
            i += 1;
            continue;
        }
        if c == '/' && next == '/' {
            while i < bytes.len() && bytes[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && next == '*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == '*' && bytes[i + 1] == '/') {
                if bytes[i] == '\n' {
                    out.push('\n');
                }
                i += 1;
            }
            i += 2;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// A free function's name and body text, at indentation 0 only.
///
/// HARDENING 3: `indent == 0` is not a style preference. At any deeper indent a
/// `Drop` impl's `fn drop` is picked up, and `drop(guard)` appears at the end of
/// nearly every locking function in the crate — the delegation walk would then
/// pull in the whole crate and the census would pass for anything.
pub(crate) fn free_fn_bodies(source: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let lines: Vec<&str> = source.lines().collect();
    for (idx, line) in lines.iter().enumerate() {
        let Some(name) = parse_fn_header(line) else {
            continue;
        };
        // Body = from this line to the first line that is exactly "}" at
        // column 0, which is where rustfmt puts a free function's close.
        let mut body = String::new();
        for l in lines.iter().skip(idx) {
            body.push_str(l);
            body.push('\n');
            if *l == "}" {
                break;
            }
        }
        out.insert(name, body);
    }
    out
}

/// `pub fn name(` / `fn name(` / `pub(crate) async fn name(` at column 0.
fn parse_fn_header(line: &str) -> Option<String> {
    if line.starts_with(' ') || line.starts_with('\t') {
        return None;
    }
    let mut rest = line;
    for prefix in ["pub(crate) ", "pub(super) ", "pub ", "async ", "unsafe ", "extern "] {
        while let Some(stripped) = rest.strip_prefix(prefix) {
            rest = stripped;
        }
    }
    // `async` can follow `pub`, so try again after the visibility strip.
    while let Some(stripped) = rest.strip_prefix("async ") {
        rest = stripped;
    }
    let rest = rest.strip_prefix("fn ")?;
    let name: String = rest
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    if name.is_empty() {
        return None;
    }
    if !rest[name.len()..].starts_with('(') && !rest[name.len()..].starts_with('<') {
        return None;
    }
    Some(name)
}

/// Every function in the crate that carries `#[tauri::command]`.
fn command_names(sources: &[(String, String)]) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for (_, text) in sources {
        for (idx, line) in text.lines().enumerate() {
            if !line.trim_start().starts_with("#[tauri::command") {
                continue;
            }
            // The header is the next line that parses as a free fn (attributes
            // and doc lines can sit between).
            for candidate in text.lines().skip(idx + 1).take(6) {
                if let Some(name) = parse_fn_header(candidate) {
                    out.insert(name);
                    break;
                }
            }
        }
    }
    out
}

/// The bodies of every free function in the crate, keyed by name.
/// A `Vec` per name and not one body, because NAMES REPEAT ACROSS MODULES and
/// the duplicate is never the irrelevant one: `mcp/objects.rs` defines its own
/// `delete_table` / `delete_sheet` / `move_sheet` wrappers over the Tauri
/// commands of the same name. A first-wins map silently resolved `delete_sheet`
/// to the four-line MCP wrapper, and every cascade the real command runs read
/// as unimplemented. Keeping both is also the honest answer to the question the
/// census asks -- "does the delete path do this?" -- when there are two delete
/// paths.
fn all_bodies(sources: &[(String, String)]) -> BTreeMap<String, Vec<String>> {
    let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (_, text) in sources {
        for (name, body) in free_fn_bodies(text) {
            out.entry(name).or_default().push(body);
        }
    }
    out
}

/// Wrap a single-body map (the self-tests' synthetic sources) in the shape
/// `body_with_one_hop` takes.
fn as_multi(bodies: BTreeMap<String, String>) -> BTreeMap<String, Vec<String>> {
    bodies.into_iter().map(|(k, v)| (k, vec![v])).collect()
}

/// A command's body PLUS the bodies of the crate functions it calls directly.
///
/// HARDENING 2: one hop, not a transitive walk. One hop is what the real
/// delegations need (`remove_auto_filter` -> `remove_auto_filter_inner`,
/// `delete_named_style` -> `delete_named_style_impl`, `delete_chart` ->
/// `record_chart_undo`); a transitive walk would eventually reach everything
/// and the census would stop discriminating.
pub(crate) fn body_with_one_hop(
    command: &str,
    bodies: &BTreeMap<String, Vec<String>>,
) -> String {
    let Some(roots) = bodies.get(command) else {
        return String::new();
    };
    let mut root = roots.join("
");
    // THE `_impl` / `_inner` SPLIT IS PART OF THE ROOT, not a hop. The house
    // pattern for making a `State<T>` command testable is a one-line wrapper
    // over `{command}_impl` / `{command}_inner` (hide_sheet_inner,
    // delete_sheet_impl, add_sheet_inner) — counting that wrapper as the hop
    // would leave zero hops for the cascades the body actually calls, and the
    // census would fail every command the moment it gained a unit tier.
    for suffix in ["_impl", "_inner"] {
        let delegate = format!("{command}{suffix}");
        if root.contains(&format!("{delegate}(")) {
            if let Some(group) = bodies.get(&delegate) {
                for body in group {
                    root.push('\n');
                    root.push_str(body);
                }
            }
        }
    }
    let mut text = root.clone();
    for (name, group) in bodies {
        if name == command {
            continue;
        }
        // `name(` or `name (` as a call. Cheap, and over-inclusive only in the
        // direction that makes the census weaker for ONE hop, which is why the
        // hop count is capped at one.
        if root.contains(&format!("{}(", name)) {
            for body in group {
                text.push('\n');
                text.push_str(body);
            }
        }
    }
    text
}

// ---------------------------------------------------------------------------
// 1. EVERY DELETE COMMAND IS CLASSIFIED
// ---------------------------------------------------------------------------

fn is_delete_verb(name: &str) -> bool {
    name.starts_with("delete_")
        || name.starts_with("remove_")
        || name.starts_with("clear_all_")
        || name.contains("_delete_")
        || name.contains("_remove_")
}

#[test]
fn every_delete_command_declares_what_happens_to_its_dependents() {
    let sources = read_crate_sources();
    let commands = command_names(&sources);
    assert!(
        commands.len() > 300,
        "only {} #[tauri::command] functions found — the scanner is broken, \
         not the crate (it has hundreds)",
        commands.len()
    );

    let declared: BTreeSet<&str> = DELETE_COMMANDS.iter().map(|(n, _)| *n).collect();
    let excused: BTreeSet<&str> = OUT_OF_SCOPE.iter().map(|(n, _)| *n).collect();

    let mut undeclared: Vec<&str> = Vec::new();
    for name in &commands {
        if !is_delete_verb(name) {
            continue;
        }
        if declared.contains(name.as_str()) || excused.contains(name.as_str()) {
            continue;
        }
        if OUT_OF_SCOPE_PREFIXES
            .iter()
            .any(|(prefix, _)| name.starts_with(prefix))
        {
            continue;
        }
        undeclared.push(name.as_str());
    }
    undeclared.sort_unstable();

    assert!(
        undeclared.is_empty(),
        "these delete commands do not say what happens to the objects that \
         point at what they delete: {:?}\n\
         \n\
         FIX: add a row to DELETE_COMMANDS naming the ObjectKind (and give that \
         kind at least one DEPENDENCY_MATRIX row), or add it to OUT_OF_SCOPE \
         with a written reason. A silent orphan is the defect this census \
         exists for (§3bn).",
        undeclared
    );

    // NON-VACUITY: the scanner must be finding the delete surface it was built
    // for. A regex that stopped matching would make the sweep above pass with
    // nothing in it.
    let found_deletes = commands.iter().filter(|n| is_delete_verb(n)).count();
    assert!(
        found_deletes >= 55,
        "only {} delete-shaped commands found; the crate has ~60 and this \
         census is only as good as its scan",
        found_deletes
    );
}

#[test]
fn every_declared_delete_command_still_exists() {
    let sources = read_crate_sources();
    let commands = command_names(&sources);
    let mut missing: Vec<&str> = Vec::new();
    for (name, _) in DELETE_COMMANDS {
        if !commands.contains(*name) {
            missing.push(name);
        }
    }
    for (name, _) in OUT_OF_SCOPE {
        if !commands.contains(*name) {
            missing.push(name);
        }
    }
    assert!(
        missing.is_empty(),
        "DELETE_COMMANDS / OUT_OF_SCOPE name commands that no longer exist: \
         {:?}. A stale row is worse than a missing one — it makes the census \
         look complete while covering nothing.",
        missing
    );
}

// ---------------------------------------------------------------------------
// 2. EVERY OBJECT KIND HAS A DECLARED ANSWER
// ---------------------------------------------------------------------------

#[test]
fn every_object_kind_has_at_least_one_matrix_row() {
    let mut missing: Vec<&str> = Vec::new();
    for kind in ObjectKind::ALL {
        if !DEPENDENCY_MATRIX.iter().any(|r| r.owner == *kind) {
            missing.push(kind.wire_name());
        }
    }
    assert!(
        missing.is_empty(),
        "these object kinds have no row in DEPENDENCY_MATRIX: {:?}\n\
         \n\
         'Nothing points at it' is a legitimate answer — declare it as \
         DeletePolicy::NoDependents with the reason. What is not legitimate is \
         no answer.",
        missing
    );
}

#[test]
fn every_delete_commands_kind_is_a_known_kind() {
    // ObjectKind::ALL is hand-maintained (the enum cannot enumerate itself in
    // stable Rust), so it is checked against the one place every variant must
    // appear: `wire_name`, which the compiler makes exhaustive.
    let names: BTreeSet<&str> = ObjectKind::ALL.iter().map(|k| k.wire_name()).collect();
    assert_eq!(
        names.len(),
        ObjectKind::ALL.len(),
        "two ObjectKind variants share a wire name, or ALL lists one twice"
    );
    for (command, kind) in DELETE_COMMANDS {
        assert!(
            ObjectKind::ALL.contains(kind),
            "{} names an ObjectKind that is missing from ObjectKind::ALL — the \
             exhaustiveness sweep would silently skip it",
            command
        );
    }
}

// ---------------------------------------------------------------------------
// 3. EVERY DECLARED CASCADE IS EXECUTED
// ---------------------------------------------------------------------------

/// Which declared cascades are NOT executed, given the text of EVERY delete
/// command, one entry per command.
///
/// Extracted so `the_census_detector_actually_fires` can drive it with a
/// synthetic body: a detector that is only ever run against passing input is a
/// detector nobody has seen fire.
///
/// # Per COMMAND, not per KIND — and this is the whole point
///
/// The first version of this function keyed on the owner KIND and concatenated
/// the bodies of every delete command that removes that kind. That is unsound
/// for exactly the reason §3bn exists, and it was found by removing the
/// `cascade_deleted_sources` call from `delete_table` and watching the census
/// stay green: `convert_to_range` deletes a Table too, its body was in the same
/// bucket, and one sibling's implementation vouched for the other's.
///
/// Six kinds have more than one delete command (Table, ObjectScript, Sparkline,
/// Comment, Note, ComputedProperty), so six kinds could hide a missing cascade
/// on one of their paths. That is the SAME defect class the section opens with:
/// `convert_to_range` was the second table-delete path that had the identical
/// orphan, and a per-kind census could never have caught it.
///
/// An orphan is created by a COMMAND, so the unit of proof is a command.
fn unimplemented_rules(command_text: &[(&str, &str, String)]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for rule in DEPENDENCY_MATRIX {
        if !rule.policy.needs_implementation() {
            continue;
        }
        if rule.implemented_by.starts_with("frontend:") {
            continue; // checked by the frontend test
        }
        assert!(
            !rule.implemented_by.is_empty(),
            "{} -> {} declares {:?}, which needs code, but names no symbol",
            rule.owner.wire_name(),
            rule.dependent,
            rule.policy
        );
        let owners: Vec<&(&str, &str, String)> = command_text
            .iter()
            .filter(|(_, kind, _)| *kind == rule.owner.wire_name())
            .collect();
        if owners.is_empty() {
            out.push(format!(
                "{} -> {}: the owner has no delete command in DELETE_COMMANDS",
                rule.owner.wire_name(),
                rule.dependent
            ));
            continue;
        }
        for (command, _, text) in owners {
            if !text.contains(rule.implemented_by) {
                out.push(format!(
                    "{} -> {}: declares `{}`, which appears nowhere in the \
                     comment-stripped body of `{}` — every command that \
                     destroys a {} must run the cascade, not just one of them",
                    rule.owner.wire_name(),
                    rule.dependent,
                    rule.implemented_by,
                    command,
                    rule.owner.wire_name()
                ));
            }
        }
    }
    out
}

#[test]
fn every_cascading_rule_names_a_symbol_its_delete_command_calls() {
    let sources = read_crate_sources();
    let bodies = all_bodies(&sources);

    // ONE ENTRY PER COMMAND (body plus one delegation hop). NOT a per-kind
    // union: see `unimplemented_rules`. Concatenating the two table-delete
    // paths let `convert_to_range` vouch for `delete_table`, which is the exact
    // sibling-path blindness this section was opened to remove.
    let mut command_text: Vec<(&str, &str, String)> = Vec::new();
    for (command, kind) in DELETE_COMMANDS {
        let text = body_with_one_hop(command, &bodies);
        assert!(
            !text.is_empty(),
            "no body found for the delete command `{}` — the free-fn walk is \
             broken, and a broken walk passes this test vacuously",
            command
        );
        command_text.push((command, kind.wire_name(), text));
    }

    let unimplemented = unimplemented_rules(&command_text);
    assert!(
        unimplemented.is_empty(),
        "declared cascades with no implementation:\n  {}\n\
         \n\
         A policy that is only a comment is not a policy. Either write the \
         cleanup and call it from the delete command, or change the row's \
         policy to one that needs no code (and say why).",
        unimplemented.join("\n  ")
    );
}

#[test]
fn policies_that_need_no_code_name_no_symbol() {
    let mut wrong: Vec<String> = Vec::new();
    for rule in DEPENDENCY_MATRIX {
        if rule.policy.needs_implementation() {
            continue;
        }
        if !rule.implemented_by.is_empty() {
            wrong.push(format!(
                "{} -> {} is {:?} but names `{}`",
                rule.owner.wire_name(),
                rule.dependent,
                rule.policy,
                rule.implemented_by
            ));
        }
        assert!(
            rule.note.len() > 20,
            "{} -> {} is {:?} — a policy that runs no code must be ARGUED, and \
             a one-word note is not an argument",
            rule.owner.wire_name(),
            rule.dependent,
            rule.policy
        );
    }
    assert!(
        wrong.is_empty(),
        "rows that need no code but name a symbol (the reader will look for a \
         cascade that is not there):\n  {}",
        wrong.join("\n  ")
    );
}

#[test]
fn frontend_owned_cascades_name_a_symbol_that_exists() {
    // Some cleanups can only run on the frontend — unmounting a live worker,
    // or the GET.CONTROLVALUE recalc that has to apply returned cells to the
    // painted grid. Those rows are still checkable: the named symbol must
    // exist in the extension sources.
    let ext_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("extensions");
    assert!(
        ext_root.is_dir(),
        "extension sources not found at {} — this check cannot run",
        ext_root.display()
    );
    let mut texts: Vec<String> = Vec::new();
    collect_ts_sources(&ext_root, &mut texts);
    assert!(
        texts.len() > 100,
        "only {} extension sources read; the walk is broken",
        texts.len()
    );
    let haystack = texts.join("\n");

    let mut missing: Vec<String> = Vec::new();
    for rule in DEPENDENCY_MATRIX {
        let Some(spec) = rule.implemented_by.strip_prefix("frontend:") else {
            continue;
        };
        let symbol = spec.rsplit('.').next().unwrap_or(spec);
        if !haystack.contains(symbol) {
            missing.push(format!(
                "{} -> {} names frontend symbol `{}`, which is nowhere in \
                 app/extensions",
                rule.owner.wire_name(),
                rule.dependent,
                symbol
            ));
        }
    }
    assert!(
        missing.is_empty(),
        "frontend-owned cascades pointing at symbols that do not exist:\n  {}",
        missing.join("\n  ")
    );
}

fn collect_ts_sources(dir: &std::path::Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            if name == "node_modules" || name == "__tests__" {
                continue;
            }
            collect_ts_sources(&path, out);
        } else {
            let ext = path.extension().unwrap_or_default().to_string_lossy().to_string();
            if ext == "ts" || ext == "tsx" {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    out.push(text);
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 3b. A CASCADE THAT DELETES AN OBJECT RUNS THAT OBJECT'S OWN CASCADE  (3cd)
// ---------------------------------------------------------------------------
//
// Part 3 asks, for every row, "does the owner's delete command run this row's
// cleanup?". It never asks the next question, and the next question is where
// three live orphans were: an object deleted AS A DEPENDENT still has
// dependents of its own, and it goes out through a different code path from the
// one the census checked.
//
// Measured, all three found by this rule and not by reading the code:
//
//   * `delete_sheet` deletes the CHARTS on the sheet and never ran
//     `cascade_deleted_charts`, so every pane-control slider bound to one kept
//     claiming to drive a chart that no longer existed.
//   * `cascade_deleted_sources` (the table and pivot delete path) deletes
//     SLICERS and never ran `cascade_deleted_slicers`, so deleting the table a
//     slicer filtered left every ribbon filter still cross-filtering against
//     it -- the 3bn orphan itself, one level down.
//   * Neither path pruned the OBJECT SCRIPTS of what it deleted (C10: the
//     instanceId IS the object id, so the script is inherited by whatever is
//     minted there next).
//
// The rule is mechanical and reads the matrix twice: if (O -> D) DELETES D, and
// D has its own rows that disturb an OBJECT, then O's delete command must
// contain those rows' symbols too.

/// Transitive pairs that need no code, each with the reason.
///
/// The standard is `OUT_OF_SCOPE`'s: a one-line argument a reviewer can
/// disagree with. Putting a real gap here is exactly how the next orphan
/// survives, so each entry says what makes the cleanup unnecessary rather than
/// inconvenient.
const TRANSITIVE_EXEMPT: &[(&str, &str, &str, &str)] = &[
    (
        "delete_sheet",
        "table",
        "clear_table_auto_filter",
        "The table's AutoFilter is a SHEET-KEYED record, and the deleted \
         sheet's entry is dropped wholesale by remap_sheet_keyed_stores a few \
         lines earlier. The other half of clear_table_auto_filter -- unhiding \
         the rows the filter hid -- is moot on rows that no longer exist.",
    ),
];

/// Which transitive cleanups are missing, given the text of every delete
/// command. Extracted so the self-test can drive it with a synthetic world.
fn missing_transitive_cascades(command_text: &[(&str, &str, String)]) -> Vec<String> {
    let exempt: BTreeSet<(&str, &str, &str)> = TRANSITIVE_EXEMPT
        .iter()
        .map(|(c, d, s, _)| (*c, *d, *s))
        .collect();
    let mut out = Vec::new();
    for rule in DEPENDENCY_MATRIX {
        if !matches!(
            rule.policy,
            DeletePolicy::Cascade | DeletePolicy::CascadeOrRebind
        ) {
            continue;
        }
        let Some(dependent) = rule.dependent_kind else {
            continue;
        };
        if dependent == rule.owner {
            continue; // a kind that cascades into its own kind cannot recurse
        }
        for inner in DEPENDENCY_MATRIX.iter().filter(|r| r.owner == dependent) {
            if inner.dependent_kind.is_none() {
                continue; // not an object; nothing paints it
            }
            if !matches!(
                inner.policy,
                DeletePolicy::Cascade | DeletePolicy::CascadeOrRebind | DeletePolicy::Prune
            ) {
                continue;
            }
            if inner.implemented_by.is_empty() || inner.implemented_by.starts_with("frontend:") {
                continue;
            }
            for (command, kind, text) in command_text {
                if *kind != rule.owner.wire_name() {
                    continue;
                }
                if exempt.contains(&(command, dependent.wire_name(), inner.implemented_by)) {
                    continue;
                }
                if text.contains(inner.implemented_by) {
                    continue;
                }
                out.push(format!(
                    "`{}` deletes a {} ({} -> {}), and a deleted {} owes `{}` \
                     ({} -> {}) -- which appears nowhere in its body",
                    command,
                    dependent.wire_name(),
                    rule.owner.wire_name(),
                    rule.dependent,
                    dependent.wire_name(),
                    inner.implemented_by,
                    dependent.wire_name(),
                    inner.dependent,
                ));
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

#[test]
fn a_cascade_that_deletes_an_object_runs_that_objects_own_cascade() {
    let sources = read_crate_sources();
    let bodies = all_bodies(&sources);
    let mut command_text: Vec<(&str, &str, String)> = Vec::new();
    for (command, kind) in DELETE_COMMANDS {
        command_text.push((command, kind.wire_name(), body_with_one_hop(command, &bodies)));
    }
    let missing = missing_transitive_cascades(&command_text);
    assert!(
        missing.is_empty(),
        "an object is deleted as a DEPENDENT and its own cleanup never runs:\n  \
         {}\n\
         \n\
         FIX: call the named cascade from the deleting path (the shared \
         `cascade_deleted_sources` / `cascade_sheet_removed` helpers are where \
         it belongs, so every caller gets it), or add a row to \
         TRANSITIVE_EXEMPT with a written reason.",
        missing.join("\n  ")
    );
}

#[test]
fn the_transitive_detector_actually_fires() {
    // Against a world where nothing is implemented, the three pairs this rule
    // was written for must all be reported. If any of them stops coming back,
    // removing the corresponding call from the crate would pass the build.
    let empty_world: Vec<(&str, &str, String)> = DELETE_COMMANDS
        .iter()
        .map(|(command, kind)| (*command, kind.wire_name(), String::new()))
        .collect();
    let reported = missing_transitive_cascades(&empty_world);
    for needle in [
        "`delete_sheet` deletes a chart",
        "`delete_table` deletes a slicer",
        "`delete_pivot_table` deletes a slicer",
        "`convert_to_range` deletes a slicer",
    ] {
        assert!(
            reported.iter().any(|r| r.starts_with(needle)),
            "the transitive detector did not fire for `{}`. Reported: {:?}",
            needle,
            reported
        );
    }

    // The exemption really exempts (and only the pair it names).
    assert!(
        !reported
            .iter()
            .any(|r| r.contains("`delete_sheet`") && r.contains("clear_table_auto_filter")),
        "TRANSITIVE_EXEMPT is not being honoured"
    );

    // And a world where every symbol is present reports nothing, so the rule
    // discriminates rather than always failing.
    let full_world: Vec<(&str, &str, String)> = DELETE_COMMANDS
        .iter()
        .map(|(command, kind)| {
            (
                *command,
                kind.wire_name(),
                DEPENDENCY_MATRIX
                    .iter()
                    .map(|r| r.implemented_by)
                    .collect::<Vec<_>>()
                    .join(" "),
            )
        })
        .collect();
    assert!(
        missing_transitive_cascades(&full_world).is_empty(),
        "the transitive rule reports gaps even when every cascade is present"
    );
}

#[test]
fn every_transitive_exemption_names_a_real_pair() {
    // A stale exemption is worse than a missing one: it makes the census look
    // complete while covering nothing.
    let commands: BTreeSet<&str> = DELETE_COMMANDS.iter().map(|(n, _)| *n).collect();
    let symbols: BTreeSet<&str> = DEPENDENCY_MATRIX.iter().map(|r| r.implemented_by).collect();
    let kinds: BTreeSet<&str> = ObjectKind::ALL.iter().map(|k| k.wire_name()).collect();
    for (command, dependent, symbol, reason) in TRANSITIVE_EXEMPT {
        assert!(commands.contains(command), "exemption names no such command: {}", command);
        assert!(kinds.contains(dependent), "exemption names no such kind: {}", dependent);
        assert!(symbols.contains(symbol), "exemption names no such cascade: {}", symbol);
        assert!(
            reason.len() > 40,
            "the exemption for {}/{} is not argued",
            command,
            symbol
        );
    }
}

// ---------------------------------------------------------------------------
// 4. EVERY BACKEND-INITIATED CASCADE ANNOUNCES ITSELF  (3cd)
// ---------------------------------------------------------------------------
//
// Part 3 proves the cascade RAN. It says nothing about whether anything on
// screen was TOLD, and every object this matrix cascades into lives in a
// frontend store that caches its own objects and paints its own overlay: a
// slicer the backend deleted goes on rendering, and on claiming the pointer
// events over the cells underneath, until that store re-reads.
//
// WHERE THE BOUNDARY IS, AND WHY IT IS THERE. A `#[tauri::command]` is invoked
// BY the frontend, so the frontend route that called it announces on the way
// back -- that half is `cascadeAnnouncementCensus.test.ts`, and it is not
// re-checked here. What has no frontend call to return from is a mutation
// started INSIDE the backend: the MCP tool surface, which an AI client drives
// directly. Those had a scattering of bespoke per-kind Tauri events instead
// ("charts:refresh", "tables:refresh", "pivots:refresh",
// "named-ranges:refresh", "sheets:refresh"), none of which knew anything about
// cascades -- an AI deleting a table left the slicers bound to it painting, the
// exact 3bn wedge -- and one of which, "sheets:refresh", NOTHING in the app had
// ever listened to, so an AI-created sheet never appeared in the tab bar.
//
// They all now call `object_deps::announce_cascade`, which derives the domain
// list from DEPENDENCY_MATRIX itself.

/// The symbols that mark "this code path runs an object cascade".
///
/// Read out of the matrix rather than listed: a row that DISTURBS a dependent
/// OBJECT (`dependent_kind` is set) and names a backend symbol is exactly a
/// path whose result some frontend store is caching. Rows whose dependent is a
/// formula, a scheduler job or a capability grant are not object cascades and
/// do not belong here -- nothing paints them.
fn object_cascade_symbols() -> BTreeSet<&'static str> {
    DEPENDENCY_MATRIX
        .iter()
        .filter(|r| r.dependent_kind.is_some())
        .filter(|r| {
            matches!(
                r.policy,
                DeletePolicy::Cascade | DeletePolicy::CascadeOrRebind | DeletePolicy::Prune
            )
        })
        .filter(|r| !r.implemented_by.is_empty() && !r.implemented_by.starts_with("frontend:"))
        .map(|r| r.implemented_by)
        .collect()
}

/// Which MCP functions reach an object cascade WITHOUT announcing it.
///
/// Extracted so the self-test can drive it with a synthetic module: a detector
/// that only ever runs against passing input is a detector nobody has seen
/// fire.
///
/// `reach` is the body plus ONE delegation hop (the MCP wrapper is a thin shell
/// over the real command, and by design shares its NAME with it -- `all_bodies`
/// keeps both under that name, so the wrapper's "root" already contains the
/// command it wraps). `own` is the wrapper's own text only: the announcement
/// must be IN the MCP function, or the Tauri command it delegates to would
/// vouch for it, and that command never announces because it does not need to.
fn unannounced_backend_cascades(
    functions: &[(String, String, String)],
    symbols: &BTreeSet<&'static str>,
) -> Vec<String> {
    let mut out = Vec::new();
    for (name, own, reach) in functions {
        let hit = symbols
            .iter()
            .find(|sym| reach.contains(&format!("{}(", sym)));
        let Some(symbol) = hit else { continue };
        if own.contains("announce_cascade(") {
            continue;
        }
        out.push(format!(
            "{}: reaches the cascade `{}` and never calls announce_cascade",
            name, symbol
        ));
    }
    out.sort();
    out
}

/// Every free function defined under `src/mcp/`, as (name, own body, one-hop).
fn mcp_functions(
    sources: &[(String, String)],
    bodies: &BTreeMap<String, Vec<String>>,
) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    for (rel, text) in sources {
        if !rel.starts_with("mcp/") {
            continue;
        }
        for (name, own) in free_fn_bodies(text) {
            // ONLY THE TOOL ENTRY POINTS. An announcement needs an `AppHandle`
            // to emit through, so a private helper that has none structurally
            // cannot make one -- `delete_chart_core` is exactly that, a body
            // shared by the MCP tool and the Tauri command, and demanding an
            // announcement there would be demanding the impossible in the one
            // place it is also WRONG (the Tauri command's caller announces).
            // The entry point that holds the handle is the one that owes it,
            // and the non-vacuity list below pins that the four tools which
            // destroy an object are all still seen.
            if !own.contains("handle: &AppHandle") {
                continue;
            }
            let reach = body_with_one_hop(&name, bodies);
            out.push((format!("mcp::{}", name), own, reach));
        }
    }
    out
}

#[test]
fn every_backend_initiated_cascade_announces_itself() {
    let sources = read_crate_sources();
    let bodies = all_bodies(&sources);
    let symbols = object_cascade_symbols();
    assert!(
        symbols.len() >= 8,
        "only {} object-cascade symbols derived from the matrix; the derivation \
         is broken and this census would pass vacuously",
        symbols.len()
    );

    let functions = mcp_functions(&sources, &bodies);
    assert!(
        functions.len() > 15,
        "only {} functions found under src/mcp/ - the walk is broken, not the \
         crate",
        functions.len()
    );

    // NON-VACUITY. The four MCP tools that destroy a workbook object must be
    // among the ones the scan classifies as reaching a cascade. If the scan
    // stopped seeing them, every assertion below would pass with nothing in it.
    let reaching: BTreeSet<&str> = functions
        .iter()
        .filter(|(_, _, reach)| symbols.iter().any(|s| reach.contains(&format!("{}(", s))))
        .map(|(name, _, _)| name.as_str())
        .collect();
    for expected in [
        "mcp::delete_table",
        "mcp::delete_pivot",
        "mcp::delete_sheet",
        "mcp::delete_chart",
    ] {
        assert!(
            reaching.contains(expected),
            "`{}` is no longer seen to reach an object cascade. Either the MCP \
             surface changed or the one-hop walk broke; a broken walk makes \
             this census green forever. Seen: {:?}",
            expected,
            reaching
        );
    }

    let gaps = unannounced_backend_cascades(&functions, &symbols);
    assert!(
        gaps.is_empty(),
        "backend-initiated mutations that run a cascade and tell nobody:\n  {}\n\
         \n\
         FIX: call `crate::object_deps::announce_cascade(handle, \
         ObjectKind::...)` after the mutation. Nothing on the frontend called \
         these, so nothing on the frontend will announce for them, and the \
         dependent's store keeps its object, paints its overlay and swallows \
         the clicks meant for the cells underneath (3bn).",
        gaps.join("\n  ")
    );
}

#[test]
fn the_backend_announcement_detector_actually_fires() {
    let symbols = object_cascade_symbols();

    // A function that reaches a cascade and says nothing IS reported...
    let silent = vec![(
        "mcp::delete_thing".to_string(),
        "fn delete_thing() { let _ = 1; }".to_string(),
        "fn delete_thing() { cascade_deleted_sources(&a, &b); }".to_string(),
    )];
    let reported = unannounced_backend_cascades(&silent, &symbols);
    assert_eq!(
        reported.len(),
        1,
        "a backend cascade with no announcement was not reported - removing an \
         announce_cascade call would pass the build. Reported: {:?}",
        reported
    );
    assert!(reported[0].contains("cascade_deleted_sources"));

    // ...and the same function WITH the announcement is accepted, so the rule
    // discriminates rather than simply always failing.
    let announced = vec![(
        "mcp::delete_thing".to_string(),
        "fn delete_thing() { announce_cascade(handle, ObjectKind::Table); }".to_string(),
        "fn delete_thing() { cascade_deleted_sources(&a, &b); }".to_string(),
    )];
    assert!(
        unannounced_backend_cascades(&announced, &symbols).is_empty(),
        "an announced cascade was still reported"
    );

    // A DELEGATE'S announcement must not vouch for the wrapper: the reach text
    // carries it, the wrapper's own body does not.
    let delegated = vec![(
        "mcp::delete_thing".to_string(),
        "fn delete_thing() { real_delete_thing(); }".to_string(),
        "fn delete_thing() { real_delete_thing(); }\nfn real_delete_thing() { \
         cascade_deleted_sources(&a, &b); announce_cascade(handle, x); }"
            .to_string(),
    )];
    assert_eq!(
        unannounced_backend_cascades(&delegated, &symbols).len(),
        1,
        "the delegate's announcement satisfied the wrapper. The Tauri command \
         an MCP tool wraps NEVER announces (the frontend that called it does), \
         so an announcement found through the hop is always somebody else's."
    );

    // A commented-out announcement is not an announcement - the sources this
    // runs over are comment-stripped, so prove the stripper is what makes that
    // true rather than luck.
    let commented = strip_comments("fn f() {\n    // announce_cascade(handle, x);\n}\n");
    assert!(
        !commented.contains("announce_cascade("),
        "comment stripping is broken; a cascade could be 'announced' by prose"
    );

    // And a function that touches NO cascade is not dragged in.
    let unrelated = vec![(
        "mcp::list_tables".to_string(),
        "fn list_tables() { read_only(); }".to_string(),
        "fn list_tables() { read_only(); }".to_string(),
    )];
    assert!(
        unannounced_backend_cascades(&unrelated, &symbols).is_empty(),
        "a read-only tool was asked to announce a cascade it does not run"
    );
}

// ---------------------------------------------------------------------------
// 5. THE DERIVED DOMAIN LIST  (3cd)
// ---------------------------------------------------------------------------

#[test]
fn cascade_domains_are_derived_transitively_from_the_matrix() {
    use crate::object_deps::{cascade_domains, UiDomain};

    // A table delete owes the RIBBON FILTER store, and nobody wrote that down:
    // a table cascades into its slicers, and a slicer is pruned out of every
    // ribbon filter that cross-filters it. If the walk stopped at one level
    // this would be {objects, slicer}.
    let table = cascade_domains(ObjectKind::Table);
    assert!(
        table.contains(&"slicer") && table.contains(&"ribbonFilter"),
        "table -> slicer -> ribbonFilter is the transitive edge this walk \
         exists for; got {:?}",
        table
    );
    assert!(
        table.contains(&"objects"),
        "the owner's OWN store is stale too - a backend-initiated delete has \
         nobody to re-read it; got {:?}",
        table
    );

    // A pivot reaches the timeline slicers as well, through the same domain the
    // canvas slicers use.
    let pivot = cascade_domains(ObjectKind::Pivot);
    assert!(
        pivot.contains(&"pivot") && pivot.contains(&"slicer") && pivot.contains(&"ribbonFilter"),
        "got {:?}",
        pivot
    );

    // The sheet is the widest owner in the workbook and must reach every store
    // its cascade touches.
    let sheet = cascade_domains(ObjectKind::Sheet);
    for domain in ["sheets", "objects", "pivot", "slicer", "ribbonFilter"] {
        assert!(
            sheet.contains(&domain),
            "deleting a sheet leaves the `{}` store stale and the walk did not \
             report it; got {:?}",
            domain,
            sheet
        );
    }

    // Pruning does NOT recurse: deleting a chart prunes the pane control that
    // drove it, and the control SURVIVES, so the control's own dependents are
    // untouched.
    let chart = cascade_domains(ObjectKind::Chart);
    assert!(chart.contains(&"paneControl"), "got {:?}", chart);

    // A leaf owner announces only itself.
    assert_eq!(cascade_domains(ObjectKind::Comment), vec!["annotations"]);

    // The walk terminates on the cycles the matrix really has (a ribbon filter
    // prunes its SIBLINGS, i.e. its own kind).
    assert_eq!(cascade_domains(ObjectKind::RibbonFilter), vec!["ribbonFilter"]);

    // Every wire name is a real domain, and `None` really is the absent one.
    assert_eq!(UiDomain::None.wire_name(), None);
    for kind in ObjectKind::ALL {
        if let Some(name) = kind.ui_domain().wire_name() {
            assert!(
                !name.is_empty() && name.chars().all(|c| c.is_alphanumeric()),
                "{} maps to a malformed domain name {:?}",
                kind.wire_name(),
                name
            );
        }
    }
}

#[test]
fn every_object_kind_declares_a_ui_domain_answer() {
    // `ui_domain` is an exhaustive match, so the compiler already forces an
    // answer for every variant. What it cannot force is that the answer is
    // REACHABLE: a domain the Shell translator does not know is dropped on the
    // floor in silence. The frontend census reads these names out of this file
    // and looks each one up in MUTATION_DOMAIN_EVENTS; this half just pins that
    // the kinds a cascade actually deletes are not all answered with `None`.
    let cascaded: BTreeSet<&str> = DEPENDENCY_MATRIX
        .iter()
        .filter(|r| matches!(r.policy, DeletePolicy::Cascade | DeletePolicy::CascadeOrRebind))
        .filter_map(|r| r.dependent_kind)
        .filter(|k| k.ui_domain().wire_name().is_some())
        .map(|k| k.wire_name())
        .collect();
    for expected in ["slicer", "timelineSlicer", "chart", "table", "pivot"] {
        assert!(
            cascaded.contains(expected),
            "`{}` is cascade-deleted by some owner but answers UiDomain::None - \
             nothing would ever refresh the store that paints it. Got {:?}",
            expected,
            cascaded
        );
    }
}

// ---------------------------------------------------------------------------
// THE DETECTOR ACTUALLY FIRES
// ---------------------------------------------------------------------------

/// The four hardening lessons, asserted on synthetic sources.
///
/// A census whose parse is broken passes silently and proves nothing, which is
/// the failure mode every one of the six preceding censuses had to be hardened
/// against. These are the specific ways this one could be broken.
#[test]
fn the_census_detector_actually_fires() {
    // 1. A COMMENTED-OUT CALL IS NOT AN IMPLEMENTATION.
    let commented = "\
pub fn delete_thing() {
    // crate::object_deps::cascade_deleted_sources(&a, &b);
    let _ = 1;
}
";
    let bodies = free_fn_bodies(&strip_comments(commented));
    let body = bodies.get("delete_thing").expect("the fn walk found nothing");
    assert!(
        !body.contains("cascade_deleted_sources"),
        "a commented-out cascade satisfied the census — comment stripping is \
         broken, and every row could then be 'implemented' by a comment"
    );

    // ...while the real call still counts.
    let real = "\
pub fn delete_thing() {
    // Cascade: the slicers bound to it.
    crate::object_deps::cascade_deleted_sources(&a, &b);
}
";
    let bodies = free_fn_bodies(&strip_comments(real));
    assert!(
        bodies["delete_thing"].contains("cascade_deleted_sources"),
        "comment stripping ate the real call as well — the census would now \
         fail for correct code, which is the other way to make it useless"
    );

    // 2. ONE LEVEL OF DELEGATION IS FOLLOWED.
    let delegating = "\
pub fn remove_thing() {
    remove_thing_inner();
}

fn remove_thing_inner() {
    relink_owner();
}

fn unrelated_helper() {
    something_else_entirely();
}
";
    let bodies = as_multi(free_fn_bodies(&strip_comments(delegating)));
    let text = body_with_one_hop("remove_thing", &bodies);
    assert!(
        text.contains("relink_owner"),
        "the delegation hop is broken — a command that is a two-line wrapper \
         (remove_auto_filter is exactly that) would pass vacuously"
    );
    assert!(
        !text.contains("something_else_entirely"),
        "the hop is pulling in functions the command does not call — one more \
         step of this and the closure is the whole crate and the census stops \
         discriminating"
    );

    // 3. A FREE FUNCTION IS NOT AN IMPL METHOD.
    let with_impl = "\
pub fn delete_thing() {
    let g = lock();
    drop(g);
}

impl Drop for Guard {
    fn drop(&mut self) {
        the_whole_world();
    }
}
";
    let bodies = as_multi(free_fn_bodies(&strip_comments(with_impl)));
    assert!(
        !bodies.contains_key("drop"),
        "the fn walk resolved an impl method as a free function; `drop(guard)` \
         appears in nearly every locking function in this crate, so the \
         delegation hop would drag `the_whole_world` into every command"
    );
    let text = body_with_one_hop("delete_thing", &bodies);
    assert!(
        !text.contains("the_whole_world"),
        "the impl method leaked into the one-hop closure anyway"
    );

    // 4. AN UNDECLARED DELETE COMMAND IS CAUGHT.
    let declared: BTreeSet<&str> = DELETE_COMMANDS.iter().map(|(n, _)| *n).collect();
    let excused: BTreeSet<&str> = OUT_OF_SCOPE.iter().map(|(n, _)| *n).collect();
    let invented = "delete_the_thing_nobody_declared";
    assert!(
        is_delete_verb(invented)
            && !declared.contains(invented)
            && !excused.contains(invented)
            && !OUT_OF_SCOPE_PREFIXES
                .iter()
                .any(|(p, _)| invented.starts_with(p)),
        "a plainly undeclared delete command was classified as declared — the \
         classification test would then pass for anything"
    );

    // 5. A DECLARED-BUT-UNIMPLEMENTED CASCADE IS CAUGHT.
    let bodies = as_multi(free_fn_bodies(&strip_comments(
        "pub fn delete_thing() {\n    let _ = 1;\n}\n",
    )));
    let text = body_with_one_hop("delete_thing", &bodies);
    assert!(
        !text.contains("cascade_deleted_sources"),
        "an empty command body reported a cascade it does not run"
    );

    // 6. A REAL PAIR WHOSE IMPLEMENTATION IS REMOVED IS CAUGHT.
    //
    // The strongest form of the question this census exists to answer. The
    // detector is driven against a synthetic world in which every owner's
    // delete command is EMPTY: every rule that needs code must be reported,
    // including the measured defect's own row (table -> slicer). If this comes
    // back short, deleting a cascade call from the crate would not fail the
    // build.
    let empty_world: Vec<(&str, &str, String)> = DELETE_COMMANDS
        .iter()
        .map(|(command, kind)| (*command, kind.wire_name(), String::from("fn x() {}")))
        .collect();
    let reported = unimplemented_rules(&empty_world);
    // One report per (rule, command-that-deletes-the-rule's-owner): a kind with
    // two delete paths owes two proofs.
    let needing_code: usize = DEPENDENCY_MATRIX
        .iter()
        .filter(|r| r.policy.needs_implementation())
        .filter(|r| !r.implemented_by.starts_with("frontend:"))
        .map(|r| {
            DELETE_COMMANDS
                .iter()
                .filter(|(_, kind)| kind.wire_name() == r.owner.wire_name())
                .count()
                .max(1)
        })
        .sum();
    assert_eq!(
        reported.len(),
        needing_code,
        "the implementation detector reported {} of {} cascades as missing \
         against a world where NOTHING is implemented - it is not firing for \
         every row, so removing a cascade call would pass the build",
        reported.len(),
        needing_code
    );
    assert!(
        reported
            .iter()
            .any(|r| r.starts_with("table -> slicer.cacheSourceId")),
        "the detector did not fire for the pair this whole section exists for \
         (table -> slicer). Reported: {:?}",
        reported
    );

    // 7. A SIBLING DELETE PATH MUST NOT VOUCH FOR ITS TWIN.
    //
    // THE HOLE THIS CASE WAS WRITTEN FOR, and it was a live one: the detector
    // used to concatenate every delete command of a kind into one string, so
    // `table -> slicer` was satisfied as long as EITHER `delete_table` or
    // `convert_to_range` called `cascade_deleted_sources`. Removing the call
    // from `delete_table` in the real crate left the census green — measured,
    // not hypothesised.
    //
    // Here `convert_to_range` implements and `delete_table` does not. The
    // detector must name `delete_table`, and must NOT report the pair as
    // satisfied merely because a sibling command runs the cascade.
    let one_sibling_only: Vec<(&str, &str, String)> = DELETE_COMMANDS
        .iter()
        .map(|(command, kind)| {
            // Every command implements everything EXCEPT `delete_table`, so any
            // report that comes back must be about `delete_table` alone.
            let text = if *command == "delete_table" {
                String::from("fn delete_table() {}")
            } else {
                DEPENDENCY_MATRIX
                    .iter()
                    .map(|r| r.implemented_by)
                    .collect::<Vec<_>>()
                    .join(" ")
            };
            (*command, kind.wire_name(), text)
        })
        .collect();
    let sibling_reported = unimplemented_rules(&one_sibling_only);
    assert!(
        !sibling_reported.is_empty(),
        "`convert_to_range` vouched for `delete_table`: the detector is keyed \
         on the object KIND rather than the COMMAND, so a missing cascade on \
         one of a kind's several delete paths is invisible. This is the exact \
         shape of the second table-delete path that carried the original orphan."
    );
    assert!(
        sibling_reported
            .iter()
            .all(|r| r.contains("`delete_table`")),
        "the sibling-path case reported something other than `delete_table`, \
         so it is not measuring what it claims. Reported: {:?}",
        sibling_reported
    );
    assert!(
        sibling_reported
            .iter()
            .any(|r| r.starts_with("table -> slicer.cacheSourceId")),
        "the detector did not name table -> slicer for the delete path that \
         dropped the cascade. Reported: {:?}",
        sibling_reported
    );
}

/// The parse, pinned against the crate as it really is: the commands the census
/// leans on hardest must all be found, with bodies, by the walk.
#[test]
fn the_walk_finds_the_commands_this_census_leans_on() {
    let sources = read_crate_sources();
    let commands = command_names(&sources);
    let bodies = all_bodies(&sources);
    for name in [
        "delete_table",
        "delete_pivot_table",
        "delete_slicer",
        "delete_chart",
        "delete_sheet",
        "delete_ribbon_filter",
        "delete_script",
        "remove_auto_filter",
    ] {
        assert!(
            commands.contains(name),
            "`{}` was not recognised as a #[tauri::command] — the attribute \
             scan is broken",
            name
        );
        let body = bodies.get(name);
        assert!(
            body.is_some_and(|b| b.iter().any(|s| s.len() > 100)),
            "`{}` has no body (or a suspiciously short one) — the free-fn walk \
             is broken",
            name
        );
    }
}

// ---------------------------------------------------------------------------
// THE PRINTED TABLE
// ---------------------------------------------------------------------------

/// Not an assertion — a report. `cargo test -- --nocapture
/// object_dependency_table` prints the matrix so a reviewer can read the
/// decisions without reading the code.
#[test]
fn object_dependency_table() {
    let mut kinds: Vec<&ObjectKind> = ObjectKind::ALL.iter().collect();
    kinds.sort();
    println!("\n=== OBJECT DEPENDENCY MATRIX ===");
    for kind in kinds {
        for rule in DEPENDENCY_MATRIX.iter().filter(|r| r.owner == *kind) {
            println!(
                "{:<16} {:<52} {:?}",
                kind.wire_name(),
                rule.dependent,
                rule.policy
            );
        }
    }
    println!("=== {} rules over {} kinds ===\n", DEPENDENCY_MATRIX.len(), ObjectKind::ALL.len());
    assert_eq!(
        DeletePolicy::Cascade.needs_implementation(),
        true,
        "a cascade that needs no code is not a cascade"
    );
}
