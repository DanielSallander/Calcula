//! FILENAME: app/src-tauri/src/named_ranges.rs
//! PURPOSE: Named ranges CRUD operations and resolution for formula references.
//! CONTEXT: Allows users to define names for cell ranges that can be used in formulas.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tauri::State;

use crate::api_types::CellData;
use crate::commands::utils::get_cell_internal_with_merge;
use crate::document_effect::DocumentEffect;
use crate::persistence::FileState;
use crate::AppState;

/// A named range definition.
/// Can be workbook-scoped (sheet_index = None) or sheet-scoped.
/// The `refers_to` field stores the formula string (e.g., "=Sheet1!$A$1:$B$10",
/// "=0.25", or "=OFFSET(A1,0,0,COUNTA(A:A),1)").
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedRange {
    /// The name identifier (e.g., "SalesData", "TaxRate")
    pub name: String,
    /// Sheet index for sheet-scoped names, None for workbook-scoped
    pub sheet_index: Option<usize>,
    /// The formula this name refers to (e.g., "=Sheet1!$A$1:$B$10" or "=0.25")
    pub refers_to: String,
    /// Optional comment/description
    pub comment: Option<String>,
    /// Optional folder for organizational grouping in the Name Manager
    pub folder: Option<String>,
}

/// Result of a named range operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedRangeResult {
    pub success: bool,
    pub named_range: Option<NamedRange>,
    pub error: Option<String>,
}

/// Resolved grid coordinates for a named range (used by object scripts).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedRangeCoords {
    pub sheet_index: usize,
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
}

impl NamedRange {
    /// Whether `name` is a name Excel would accept as a defined name -- the
    /// whole rule, measured live, is `identity::is_valid_defined_name`.
    /// Delegated rather than kept here so the `.calp` publish and pull doors
    /// (core/calp cannot reach this crate) refuse exactly what this door
    /// refuses: a package's `R1C1` or `Q1` is the name the Name Manager would
    /// not accept, and its `.xlsx` export is a file Excel will not open.
    pub fn is_valid_name(name: &str) -> bool {
        identity::is_valid_defined_name(name)
    }

    /// Whether a string reads as an A1 cell (e.g., A1, BC123).
    #[cfg(test)]
    fn looks_like_cell_reference(s: &str) -> bool {
        identity::defined_name_syntax::looks_like_a1_cell(s)
    }

    /// The key this name is held under in the registry: [`registry_key`].
    pub(crate) fn registry_key(&self) -> String {
        registry_key(self.sheet_index, &self.name)
    }
}

/// The refusal of a name Excel's rule does not take (`NamedRange::is_valid_name`):
/// Excel's own text [LIVE, Excel 16, 2026-11-06, lane namescalp p1.ps1 --
/// `Names.Add("1abc")`, `"a b"` and `"A1"` each raise exactly it], naming the
/// name, since a script or the MCP door has no dialog showing what was typed.
/// It said a name may hold "only letters, numbers, underscores, and periods",
/// which stopped being the rule when `\` and `?` became name characters
/// (BUG-0741); the New Name and New Function dialogs show the same lines
/// (`DefinedNames/lib/invalidNameMessage.ts`).
pub(crate) fn invalid_name_message(name: &str) -> String {
    format!(
        "The syntax of the name '{}' isn't correct.\n\nVerify that the name:\n\
         -Starts with a letter or underscore (_)\n\
         -Doesn't include a space or character that isn't allowed\n\
         -Doesn't conflict with an existing name in the workbook.",
        name
    )
}

// ============================================================================
// THE REGISTRY IS KEYED BY (SCOPE, NAME)  (BUG-0744 -- Excel parity)
// ============================================================================

/// The key a defined name is held under in `AppState::named_ranges`: its
/// SCOPE and its defined-name key (`identity::defined_name_key`).
///
/// Excel holds one name per (scope, spelling): a workbook `Rate` beside a
/// `Sheet1!Rate` beside a `Sheet2!Rate` [LIVE, Excel 16, 2026-11-06, lane
/// names q1.ps1: `Names.Add("Dup", "=1")` and `Sheet1.Names.Add("Dup", "=2")`
/// both stand; `=Dup` on Sheet1 is 2, on Sheet2 1, and `=Sheet1!Dup` on Sheet2
/// is 2], and Copy Sheet makes exactly that state. The registry was keyed by
/// the spelling alone, so a second scope of one spelling could not be held.
///
/// A WORKBOOK name keeps the plain key, so every reader that asks "is there a
/// workbook name spelled so" (the table/name namespace check among them) asks
/// it as before. A SHEET name is `"{sheet index}!{key}"` -- `!` is in no
/// defined name, so the two kinds cannot collide -- and is re-keyed whenever
/// sheet indices move ([`rekey_registry`]).
pub(crate) fn registry_key(sheet_index: Option<usize>, name: &str) -> String {
    let key = identity::defined_name_key(name);
    match sheet_index {
        None => key,
        Some(sheet) => format!("{}!{}", sheet, key),
    }
}

/// The defined-name key part of a registry key (the key itself for a
/// workbook name). Allocation-free, for the hot "is this spelling defined in
/// any scope" questions.
pub(crate) fn name_part_of_registry_key(registry_key: &str) -> &str {
    match registry_key.split_once('!') {
        Some((_, name)) => name,
        None => registry_key,
    }
}

/// The name a bare `name` means in a formula on `sheet`, by Excel's order: the
/// name scoped to that sheet shadows the workbook's [LIVE, q1.ps1].
/// `sheet` `None` asks for the workbook name only.
pub(crate) fn resolve_in_scope<'a>(
    names: &'a HashMap<String, NamedRange>,
    name: &str,
    sheet: Option<usize>,
) -> Option<&'a NamedRange> {
    // Each hit is checked against the scope it was asked for: an entry filed
    // under the wrong key (a direct insert that skipped `registry_key`) must
    // never widen a sheet's name to the whole workbook.
    if let Some(sheet) = sheet {
        if let Some(local) = names.get(&registry_key(Some(sheet), name)).filter(|nr| nr.sheet_index == Some(sheet)) {
            return Some(local);
        }
    }
    names.get(&registry_key(None, name)).filter(|nr| nr.sheet_index.is_none())
}

/// The name a QUALIFIED or bare reference text means on `sheet`: `Sheet2!Rate`
/// is the name scoped to Sheet2 (and only that one -- Excel reads a qualified
/// name in its sheet's scope, falling back to the workbook name of that
/// spelling, as a formula `=Sheet2!Rate` does), `Rate` is
/// [`resolve_in_scope`]. `None` when nothing of that spelling is defined there.
pub(crate) fn resolve_reference_text<'a>(
    names: &'a HashMap<String, NamedRange>,
    sheet_names: &[String],
    text: &str,
    sheet: Option<usize>,
) -> Option<&'a NamedRange> {
    let text = text.trim();
    if let Some((qualifier, bare)) = text.rsplit_once('!') {
        let qualifier = qualifier.trim();
        let unquoted = qualifier
            .strip_prefix('\'')
            .and_then(|q| q.strip_suffix('\''))
            .map(|q| q.replace("''", "'"))
            .unwrap_or_else(|| qualifier.to_string());
        let target = sheet_names.iter().position(|n| identity::sheet_names_equal(n, &unquoted))?;
        return resolve_in_scope(names, bare, Some(target));
    }
    resolve_in_scope(names, text, sheet)
}

/// Is `key` (a defined-name key) defined in ANY scope?
pub(crate) fn defined_in_any_scope(names: &HashMap<String, NamedRange>, key: &str) -> bool {
    names.contains_key(key) || names.keys().any(|k| name_part_of_registry_key(k) == key)
}

/// The entry of spelling `key` (a defined-name key) to read a DISPLAY fact
/// from (its spelling): the workbook name, else the first scoped one in key
/// order. Never a resolution -- for that see [`resolve_in_scope`].
pub(crate) fn any_scope_entry<'a>(names: &'a HashMap<String, NamedRange>, key: &str) -> Option<&'a NamedRange> {
    if let Some(entry) = names.get(key) {
        return Some(entry);
    }
    let mut scoped: Vec<(&String, &NamedRange)> =
        names.iter().filter(|(k, _)| name_part_of_registry_key(k) == key).collect();
    scoped.sort_by(|a, b| a.0.cmp(b.0));
    scoped.first().map(|(_, nr)| *nr)
}

/// Excel's `Workbook.Names("Sales")` -- the registry key of the name a caller
/// with NO scope at all means (an MCP tool, a script's `names.X`): the name
/// is read as the FIRST sheet would read it -- that sheet's own `Sales`, else
/// the workbook's -- and a name scoped only to a later sheet is not found.
///
/// [LIVE, Excel 16, 2026-11-06, lane obj4 n1.ps1 / n2.ps1; tabs Zed, Abc,
/// Third] a workbook `Sales` with a sheet-scoped `Sales` on Abc (tab 2):
/// `Names("Sales")` is the WORKBOOK's; add one on Zed (tab 1): Zed's, ahead of
/// the workbook's; with ONLY Abc's (or Abc's and Third's) it raises
/// 0x800A03EC; move Third to the front and it is Third's. None of it depends
/// on the active sheet or on which name was defined first (with lane
/// namescalp's p1/p3/p4 and the verifier's v3/v4). The rule here used to be
/// "the workbook's, else the lowest sheet index's", which is right only when
/// the first tab holds none.
pub(crate) fn names_item_key(names: &HashMap<String, NamedRange>, name: &str) -> Option<String> {
    let first = registry_key(Some(0), name);
    if names.get(&first).is_some_and(|nr| nr.sheet_index == Some(0)) {
        return Some(first);
    }
    let workbook = registry_key(None, name);
    names.get(&workbook).is_some_and(|nr| nr.sheet_index.is_none()).then_some(workbook)
}

/// The registry key a COMMAND addressed by `name` in `scope` means: the entry
/// of exactly that scope. `None` on the command wire also SPELLS the workbook
/// scope -- the Name Manager sends a workbook name's `sheetIndex` as null -- so
/// it is the workbook's name when one exists; failing that, Excel's
/// `Names(name)` ([`names_item_key`]): the first sheet's own. That differs from
/// Excel's `Names()` in one case only -- the first sheet AND the workbook both
/// hold the spelling -- where the Name Manager's workbook row must not delete
/// or rename the sheet's name. A caller that means `Names()` exactly (the MCP
/// door) asks [`names_item_key`] and passes the scope it found.
///
/// The old "the ONE name of that spelling, else nothing" left every caller
/// asking with no scope empty-handed after a Copy Sheet made two (BUG-0744
/// follow-up, lane namescalp).
pub(crate) fn addressed_key(names: &HashMap<String, NamedRange>, name: &str, scope: Option<usize>) -> Option<String> {
    let exact = registry_key(scope, name);
    if names.contains_key(&exact) {
        return Some(exact);
    }
    if scope.is_some() {
        return None;
    }
    names_item_key(names, name)
}

// ============================================================================
// A RELATIVE NAME DOES NOT FOLLOW A STRUCTURAL EDIT  (BUG-0749 -- Excel parity)
// ============================================================================

/// The name's definition after a row (`rows_axis`) or column edit shifted
/// `before` into `after`, with every RELATIVE part put back as it was.
///
/// [LIVE, Excel 16, 2026-11-06, lane names q9.ps1, names defined at A1] a
/// relative reference in a name is an OFFSET from the cell that uses it, so a
/// structural edit neither moves it nor kills it: `nRel` = `=Alpha!C3`
/// (R[2]C[2]) and `nRng` = `=Alpha!C3:D4` read the same after inserting row
/// 1, inserting column A, deleting row 4 and deleting column D, while `nAbs`
/// = `=Alpha!$C$3` became `$C$4`, `$D$4`, then `#REF!`; a MIXED reference
/// follows in its absolute part only (`$C3` -> `$C3` on the row insert,
/// `$D3` on the column insert, `#REF!` when column D went). Calcula shifted
/// the relative parts like absolute ones (and turned them `#REF!`), so a
/// relative name meant a different offset after every insert above it.
///
/// `after` is the shifter's text; when no relative part moved it is returned
/// unchanged. A reference the shifter turned `#REF!` whose part on the edited
/// axis is relative comes back whole (the other axis is not touched by this
/// edit). Rendered through the raw renderer with the workbook's sheet casing.
pub(crate) fn keep_relative_name_parts(before: &str, after: &str, rows_axis: bool, sheet_names: &[String]) -> String {
    if before == after {
        return after.to_string();
    }
    let (Ok(old), Ok(mut new)) = (parser::parse(before), parser::parse(after)) else {
        return after.to_string();
    };
    let mut changed = false;
    if !restore_relative_parts(&old, &mut new, rows_axis, &mut changed) || !changed {
        return after.to_string();
    }
    crate::sheet_names::restamp_sheet_casing(&mut new, sheet_names);
    // The lexer folds a bare identifier, so the re-render would write every
    // OTHER name of the definition upper-cased (`myRate` -> `MYRATE`). Each
    // name takes back the spelling `before` gave it (lane namescalp; the
    // caller holds the registry mutably, so the definition's own text is the
    // spelling source).
    crate::name_resolution::restamp_name_casing(&mut new, &spellings_in(before));
    format!("={}", engine::ast_render::render_formula_raw(&new))
}

/// Every identifier-shaped word of a formula TEXT outside its string literals
/// and quoted sheet names, as a spelling table for
/// `name_resolution::restamp_name_casing`: key -> the word as written.
fn spellings_in(text: &str) -> HashMap<String, NamedRange> {
    let mut out = HashMap::new();
    let mut chars = text.chars().peekable();
    let mut word = String::new();
    let flush = |word: &mut String, out: &mut HashMap<String, NamedRange>| {
        if !word.is_empty() {
            out.entry(registry_key(None, word)).or_insert_with(|| NamedRange {
                name: word.clone(),
                sheet_index: None,
                refers_to: String::new(),
                comment: None,
                folder: None,
            });
            word.clear();
        }
    };
    while let Some(c) = chars.next() {
        if c == '"' || c == '\'' {
            flush(&mut word, &mut out);
            // Skip to the closing quote; a doubled quote is an escaped one.
            while let Some(d) = chars.next() {
                if d == c {
                    if chars.peek() == Some(&c) {
                        chars.next();
                        continue;
                    }
                    break;
                }
            }
        } else if c.is_alphanumeric() || matches!(c, '_' | '.' | '\\' | '?') {
            word.push(c);
        } else {
            flush(&mut word, &mut out);
        }
    }
    flush(&mut word, &mut out);
    out
}

/// Is `expr` a reference whose part on the edited axis is relative (so the
/// edit cannot have touched it)? A range: both of its ends.
fn relative_on_axis(expr: &parser::ast::Expression, rows_axis: bool) -> bool {
    use parser::ast::Expression as E;
    match expr {
        E::CellRef { row_absolute, col_absolute, .. } => {
            if rows_axis {
                !*row_absolute
            } else {
                !*col_absolute
            }
        }
        E::Range { start, end, .. } => relative_on_axis(start, rows_axis) && relative_on_axis(end, rows_axis),
        E::RowRef { start_absolute, end_absolute, .. } => rows_axis && !*start_absolute && !*end_absolute,
        E::ColumnRef { start_absolute, end_absolute, .. } => !rows_axis && !*start_absolute && !*end_absolute,
        _ => false,
    }
}

/// Walk `old` and `new` in step, putting each relative part of `new` back to
/// `old`'s. `false` when the two trees differ in a way this cannot pair.
fn restore_relative_parts(
    old: &parser::ast::Expression,
    new: &mut parser::ast::Expression,
    rows_axis: bool,
    changed: &mut bool,
) -> bool {
    use parser::ast::Expression as E;
    if std::mem::discriminant(old) != std::mem::discriminant(new) {
        // The shifter turned the reference into something else (`#REF!`): a
        // reference relative on the edited axis was never the edit's to kill.
        if relative_on_axis(old, rows_axis) {
            *new = old.clone();
            *changed = true;
            return true;
        }
        return matches!(new, E::Literal(_));
    }
    match (old, new) {
        (
            E::CellRef { col: oc, row: or, col_absolute: oca, row_absolute: ora, .. },
            E::CellRef { col, row, col_absolute, row_absolute, .. },
        ) => {
            if oca != col_absolute || ora != row_absolute {
                return false;
            }
            if !*ora && row != or {
                *row = *or;
                *changed = true;
            }
            if !*oca && col != oc {
                *col = oc.clone();
                *changed = true;
            }
            true
        }
        (E::Range { start: os, end: oe, .. }, E::Range { start, end, .. }) => {
            restore_relative_parts(os, start, rows_axis, changed) && restore_relative_parts(oe, end, rows_axis, changed)
        }
        (
            E::RowRef { start_row: osr, end_row: oer, start_absolute: osa, end_absolute: oea, .. },
            E::RowRef { start_row, end_row, start_absolute, end_absolute, .. },
        ) => {
            if osa != start_absolute || oea != end_absolute {
                return false;
            }
            if !*osa && start_row != osr {
                *start_row = *osr;
                *changed = true;
            }
            if !*oea && end_row != oer {
                *end_row = *oer;
                *changed = true;
            }
            true
        }
        (
            E::ColumnRef { start_col: osc, end_col: oec, start_absolute: osa, end_absolute: oea, .. },
            E::ColumnRef { start_col, end_col, start_absolute, end_absolute, .. },
        ) => {
            if osa != start_absolute || oea != end_absolute {
                return false;
            }
            if !*osa && start_col != osc {
                *start_col = osc.clone();
                *changed = true;
            }
            if !*oea && end_col != oec {
                *end_col = oec.clone();
                *changed = true;
            }
            true
        }
        (E::BinaryOp { left: ol, right: or, .. }, E::BinaryOp { left, right, .. }) => {
            restore_relative_parts(ol, left, rows_axis, changed) && restore_relative_parts(or, right, rows_axis, changed)
        }
        (E::UnaryOp { operand: oo, .. }, E::UnaryOp { operand, .. }) => restore_relative_parts(oo, operand, rows_axis, changed),
        (E::ImplicitIntersection { operand: oo }, E::ImplicitIntersection { operand }) => {
            restore_relative_parts(oo, operand, rows_axis, changed)
        }
        (E::SpillRef { cell: oc, .. }, E::SpillRef { cell, .. }) => restore_relative_parts(oc, cell, rows_axis, changed),
        (E::Sheet3DRef { reference: or, .. }, E::Sheet3DRef { reference, .. }) => {
            restore_relative_parts(or, reference, rows_axis, changed)
        }
        (E::IndexAccess { target: ot, index: oi }, E::IndexAccess { target, index }) => {
            restore_relative_parts(ot, target, rows_axis, changed) && restore_relative_parts(oi, index, rows_axis, changed)
        }
        (E::FunctionCall { args: oa, .. }, E::FunctionCall { args, .. }) => {
            oa.len() == args.len()
                && oa.iter().zip(args.iter_mut()).all(|(o, n)| restore_relative_parts(o, n, rows_axis, changed))
        }
        // Literals, names, tables, array literals: no reference to restore.
        _ => true,
    }
}

/// Re-key every entry by its CURRENT scope, after a sheet renumbering
/// rewrote the `sheet_index` fields (move, delete, insert, copy).
pub(crate) fn rekey_registry(names: &mut HashMap<String, NamedRange>) {
    if names.iter().all(|(k, nr)| *k == nr.registry_key()) {
        return;
    }
    let entries: Vec<NamedRange> = names.drain().map(|(_, nr)| nr).collect();
    for nr in entries {
        names.insert(nr.registry_key(), nr);
    }
}

// ============================================================================
// A NAME CHANGE IS A VALUE CHANGE  (D2 — Excel parity)
// ============================================================================

/// Recalculate everything that reads the names in `changed`.
///
/// A formula now STORES its defined names and expands them while calculating
/// (see `name_resolution`), which is what makes a name a live indirection rather
/// than a one-shot typing macro — and which makes repointing, redefining,
/// renaming or deleting one a **value change for every formula that reads it**.
/// A name is not a cell, so no cell seed can describe that; `name_dependents` is
/// the edge that can.
///
/// Two halves, both through entry points that already exist — deliberately not a
/// new walk (see the ONE-cascade census in `bulk_rewrite_recalc_tests`):
///
/// * the ACTIVE sheet's readers seed `recalc_after_active_sheet_bulk_rewrite`,
///   which orders them topologically among themselves and continues into their
///   own dependents and across sheet boundaries;
/// * OTHER sheets are found by asking each grid whether any of its formulas
///   mentions a changed name, and only those sheets go through
///   `recalc_after_off_sheet_write`. The per-sheet dependency maps are
///   active-sheet-only, so there is no seed vocabulary for them — but naming the
///   sheets that actually read the name is much narrower than the whole-workbook
///   sweep an undone name definition takes (`RestoreReport::workbook_recalc`).
///
/// CALLERS MUST HOLD NO `AppState` LOCKS: both helpers take their own. This is
/// the second lock phase, exactly as in `apply_changes` and `sort_range`.
pub(crate) fn recalc_after_name_change(
    state: &AppState,
    user_files_state: &crate::persistence::UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    changed: &[String],
) {
    if changed.is_empty() {
        return;
    }
    // THE LIVE DATA TABLES are refreshed by every caller at its tail
    // (`data_tables::refresh_after_edit`), once: the two cascades below do not
    // refresh on their own (NEW-dt-refresh-root; the census in
    // `data_table_refresh_tests` holds each caller to that tail).
    let _deferred = crate::data_tables::defer_refresh_to_caller();
    // MANUAL CALCULATION: the user asked for stale values until F9, and a name
    // change is a value change like any other. Gated HERE rather than relying on
    // the helpers, because only one of the two honours the mode
    // (`recalc_after_active_sheet_bulk_rewrite` does; `recalculate_sheet_values`
    // does not), and half a recalculation is worse than none — it would leave
    // the sheets you are NOT looking at fresh and the one you are looking at
    // stale.
    let changed_keys: HashSet<String> = changed.iter().map(|n| identity::defined_name_key(n)).collect();
    if state
        .calculation_mode
        .lock()
        .map(|m| *m != "automatic")
        .unwrap_or(false)
    {
        // ...and the workbook SAYS so when a formula reads the name
        // (NEW-manual-visibility-pending): Excel [LIVE, backende/probe1.ps1 N1
        // and N2, manual calculation]: repointing a name `=SUM(Vals)` reads
        // gave xlPending, while repointing, adding or deleting a name nothing
        // reads stayed xlDone -- with a data table on the sheet too (N3). This
        // returned without a mark, so a save vouched for the stale readers.
        if name_is_read_anywhere(state, &changed_keys) {
            crate::calculation::note_stored_values_may_be_stale(state);
        }
        return;
    }

    // OFF-SHEET half first, mirroring `apply_changes`: the active-sheet cascade
    // below then reads values the other sheets have already settled on.
    let active_sheet = *state.active_sheet.read().unwrap();
    let off_sheet: Vec<usize> = {
        let grids = state.grids.read().unwrap();
        grids
            .iter()
            .enumerate()
            .filter(|(idx, grid)| {
                *idx != active_sheet
                    && grid.cells.values().any(|cell| {
                        crate::name_resolution::cell_reads_any_name(cell, &changed_keys)
                    })
            })
            .map(|(idx, _)| idx)
            .collect()
    };
    if !off_sheet.is_empty() {
        crate::commands::data::recalc_after_off_sheet_write(
            state,
            user_files_state,
            pivot_state,
            pane_control_state,
            ribbon_filter_state,
            &off_sheet,
        );
    }

    // ACTIVE-sheet half: the readers themselves are the seeds.
    let seeds: Vec<(u32, u32)> = {
        let name_dependents = state.name_dependents.lock().unwrap();
        let mut seen: crate::CoordSet = crate::CoordSet::default();
        let mut out: Vec<(u32, u32)> = Vec::new();
        for key in &changed_keys {
            if let Some(cells) = name_dependents.get(key) {
                for &coord in cells {
                    if seen.insert(coord) {
                        out.push(coord);
                    }
                }
            }
        }
        // Deterministic: the map is a hash set and seed ORDER reaches values
        // through the topological pass.
        out.sort_unstable();
        out
    };
    if seeds.is_empty() {
        return;
    }
    let mut updated_cells: Vec<CellData> = Vec::new();
    crate::commands::data::recalc_after_active_sheet_bulk_rewrite(
        state,
        user_files_state,
        pane_control_state,
        ribbon_filter_state,
        &seeds,
        &mut updated_cells,
    );
    // The cells are not returned: every route into these commands (Name
    // Manager, the Name Box, `NewNameDialog`, a script, MCP) already emits
    // `NAMED_RANGES_CHANGED`, and the DefinedNames extension turns that into one
    // `refreshGridData()`. Widening `NamedRangeResult` would oblige each of
    // those five callers to apply a cell list instead.
}

/// Whether some formula reads one of the names `changed_keys` (folded with
/// `identity::defined_name_key`): the readers [`recalc_after_name_change`]
/// would recalculate under automatic calculation -- the active sheet's through
/// `name_dependents`, every other sheet's by asking its cells. Each lock is
/// taken alone and released.
fn name_is_read_anywhere(state: &AppState, changed_keys: &HashSet<String>) -> bool {
    let active_reads = {
        let name_dependents = state.name_dependents.lock().unwrap();
        changed_keys.iter().any(|key| name_dependents.get(key).is_some_and(|cells| !cells.is_empty()))
    };
    if active_reads {
        return true;
    }
    let active_sheet = *state.active_sheet.read().unwrap();
    let grids = state.grids.read().unwrap();
    grids.iter().enumerate().any(|(idx, grid)| {
        idx != active_sheet
            && grid.cells.values().any(|cell| crate::name_resolution::cell_reads_any_name(cell, changed_keys))
    })
}

/// Create a new named range.
#[tauri::command]
pub fn create_named_range(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    name: String,
    sheet_index: Option<usize>,
    refers_to: String,
    comment: Option<String>,
    folder: Option<String>,
) -> NamedRangeResult {
    let result = create_named_range_impl(
        &state, &file_state, name, sheet_index, refers_to, comment, folder,
    );
    // DEFINING a name is a value change too: every `#NAME?` cell that was
    // waiting for it becomes a number (`collect_names` records edges for names
    // that do not exist yet, precisely so this works).
    if result.success {
        if let Some(nr) = &result.named_range {
            recalc_after_name_change(
                &state,
                &user_files_state,
                &pivot_state,
                &pane_control_state,
                &ribbon_filter_state,
                &[nr.name.clone()],
            );
            // A LIVE DATA TABLE whose model reads the name follows it under
            // automatic calculation (BUG-0652, rev-dt2-1). No guard is held;
            // the grid re-reads on NAMED_RANGES_CHANGED, so the cells are not kept.
            crate::data_tables::refresh_after_edit(
                &state,
                &user_files_state,
                &pivot_state,
                &pane_control_state,
                &ribbon_filter_state,
                &mut Vec::new(),
            );
        }
    }
    result
}

/// Excel's message for a defined name's formula it will not take.
pub(crate) const NAME_FORMULA_REFUSAL: &str = "There's a problem with this formula.";

/// Why a name's formula is refused at ENTRY (Define Name, the Name Manager's
/// edit, the MCP and script doors that run these bodies), or `None`.
///
/// [LIVE, Excel 16, 2026-11-05, rev-parse probes B and G: `Names.Add` refuses
/// `=LAMBDA(a1,a1*2)`, `=LAMBDA(a1,a1+D1)`, `=LAMBDA(a1,a1+Sheet1!$D$1)`,
/// `=LET(a1,5,a1+Sheet1!$D$1)`, `=LET(a1,5,a1+R1C4)` and the same LAMBDA set in
/// R1C1 with "There's a problem with this formula.", and takes
/// `=LAMBDA(x,x*2)`.] A name's formula has no cell to fall back to R1C1 in, so
/// a LET name or LAMBDA parameter spelled like a cell is no name there at all;
/// Calcula defined every one of them. The cell-entry checks
/// (`parser::check_entered_formula`) apply as they do to a typed formula.
///
/// A formula that does not parse is left to the callers as before: only the
/// shapes Excel's own entry refuses are refused here. Excel OPENS a workbook
/// that carries such a name, so the load path never comes through here.
fn refers_to_entry_refusal(refers_to: &str) -> Option<String> {
    let ast = parser::parse(refers_to).ok()?;
    if parser::parser::declares_cell_shaped_name(&ast) {
        return Some(format!(
            "{} A LET name or LAMBDA parameter spelled like a cell (such as A1) cannot be used in a defined name.",
            NAME_FORMULA_REFUSAL
        ));
    }
    parser::check_entered_formula(&ast).err().map(|e| name_formula_refusal_text(&e.message))
}

/// The Name Manager's message for an entry check's refusal: a message that IS
/// one of Excel's own is shown alone, as Excel shows it [LIVE, Excel 16, lane
/// formfix p1.json, `Names.Add`: `=ROUND(1)` "You've entered too few
/// arguments for this function.", `=PI(1)`, `=SUM()`, `=SUM(A1:SUM(A3))`
/// "There's a problem with this formula."]; it was prefixed with "There's a
/// problem with this formula.", which doubled the second. Any other text gets
/// Excel's generic sentence in front of Calcula's explanation.
fn name_formula_refusal_text(message: &str) -> String {
    if message.starts_with(NAME_FORMULA_REFUSAL) || message.starts_with("You've entered too") {
        message.to_string()
    } else {
        format!("{} {}", NAME_FORMULA_REFUSAL, message)
    }
}

/// Command body over plain references, so the dirty-flag contract is unit-testable
/// without a Tauri `State` (see `document_effect_pilot_tests`).
pub(crate) fn create_named_range_impl(
    state: &AppState,
    file_state: &FileState,
    name: String,
    sheet_index: Option<usize>,
    refers_to: String,
    comment: Option<String>,
    folder: Option<String>,
) -> NamedRangeResult {
    // Validate name
    if !NamedRange::is_valid_name(&name) {
        return NamedRangeResult {
            success: false,
            named_range: None,
            error: Some(invalid_name_message(&name)),
        };
    }
    // The formula's own entry checks, before any lock or effect (Excel
    // refuses these in the Name Manager; a loaded name is never put through
    // them).
    if let Some(error) = refers_to_entry_refusal(&refers_to) {
        return NamedRangeResult { success: false, named_range: None, error: Some(error) };
    }

    // The NAME key (the table/name namespace) and the REGISTRY key (scope +
    // name, BUG-0744): a sheet-scoped `Rate` may stand beside the workbook's.
    let key = identity::defined_name_key(&name);
    let reg_key = registry_key(sheet_index, &name);

    // THE LOCKS, IN THE RENAME'S EXACT ORDER (rev3B#6, rev5C#1): `grid`, then
    // `grids`, then the registry, then the undo stack. All three are held
    // from the gates through the undo record, so the rename -- which holds the
    // grid locks and the registry through its own record -- cannot run between
    // this definition and its "Define name" step and land "Rename name" in
    // between.
    //
    // BOTH GRID LOCKS FIRST is what makes holding the registry across the undo
    // stack safe. A function that holds the undo stack while it takes a name
    // store (the cell writers, `update_cell_impl` and the rest) holds `grid`
    // AND `grids` first, so it is serialized with this one instead of closing
    // a cycle. `grid` alone was not enough (rev5C#1): `update_cell_on_sheets_as`
    // -- a floating grid's cell, a grouped-sheet entry, a script writing
    // another sheet -- held `grids` but never `grid` while it read
    // `named_ranges` under the undo stack, so an MCP name write (its own
    // thread) holding `grid` and the registry and waiting for the stack
    // deadlocked against it. That writer now restamps BEFORE it takes the
    // stack, and `no_function_holds_the_undo_stack_and_a_name_store_in_an_order_that_can_cycle`
    // pins both sides. The grids are only held, never written.
    let Ok(grid_hold) = state.grid.lock_pending() else {
        return NamedRangeResult {
            success: false,
            named_range: None,
            error: Some("The workbook is unavailable.".to_string()),
        };
    };
    let Ok(grids_hold) = state.grids.lock_pending() else {
        return NamedRangeResult {
            success: false,
            named_range: None,
            error: Some("The workbook is unavailable.".to_string()),
        };
    };

    // Names and TABLE names share one formula namespace but live in two
    // unrelated registries, so nothing stopped a name from shadowing a table.
    // Which one won then depended on resolution order (names are resolved
    // first, then tables, at every call site) — the same formula could mean
    // different things depending on the path that resolved it.
    if let Ok(table_names) = state.table_names.read() {
        if table_names.contains_key(&key) {
            return NamedRangeResult {
                success: false,
                named_range: None,
                error: Some(format!(
                    "A table named '{}' already exists. Names and tables share one namespace — pick a different name.",
                    name
                )),
            };
        }
    }

    // LOCKED BUT UNDECIDED: the duplicate refusal reads the registry it
    // guards, and `DocumentEffect::mutates` dirties at construction -- minted
    // ahead of that check, defining a name that already existed marked the
    // workbook modified for a command that changed nothing. The check reads
    // through the held lock; the effect is minted once it has passed, in the
    // same critical section.
    let Ok(pending) = state.named_ranges.lock_pending() else {
        return NamedRangeResult {
            success: false,
            named_range: None,
            error: Some("Named ranges are unavailable.".to_string()),
        };
    };

    // Check for duplicate name (case-insensitive) IN THIS SCOPE: Excel holds a
    // workbook `Dup` and a `Sheet1!Dup` side by side [LIVE, q1.ps1].
    if pending.contains_key(&reg_key) {
        return NamedRangeResult {
            success: false,
            named_range: None,
            error: Some(format!("A named range '{}' already exists.", name)),
        };
    }

    let named_range = NamedRange {
        name: name.clone(),
        sheet_index,
        refers_to,
        comment,
        folder,
    };

    // `workbook.named_ranges` is persisted and written only by the save path.
    // Every gate above has passed, so a refusal leaves the document clean.
    let effect = DocumentEffect::mutates(file_state);
    let mut named_ranges = pending.authorize(&effect);
    named_ranges.insert(reg_key.clone(), named_range.clone());

    // BUG-0007 (user decision: undo-everything): name creation is undoable.
    // Recorded UNDER the registry and grid holds (see the lock note above).
    crate::undo_commands::record_named_range_undo(state, &reg_key, None, "Define name");
    drop(named_ranges);
    drop(grids_hold);
    drop(grid_hold);

    NamedRangeResult {
        success: true,
        named_range: Some(named_range),
        error: None,
    }
}

/// Update an existing named range.
#[tauri::command]
pub fn update_named_range(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    name: String,
    sheet_index: Option<usize>,
    refers_to: String,
    comment: Option<String>,
    folder: Option<String>,
) -> NamedRangeResult {
    update_named_range_core(
        &state,
        &file_state,
        &user_files_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        name,
        sheet_index,
        refers_to,
        comment,
        folder,
    )
}

/// `update_named_range` over plain references, so its refusal, its undo step
/// and its recalculation are unit-testable without a Tauri `State` -- and so
/// the MCP tool (`mcp::objects::update_named_range_core`) runs exactly this.
#[allow(clippy::too_many_arguments)]
pub(crate) fn update_named_range_core(
    state: &AppState,
    file_state: &FileState,
    user_files_state: &crate::persistence::UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    name: String,
    sheet_index: Option<usize>,
    refers_to: String,
    comment: Option<String>,
    folder: Option<String>,
) -> NamedRangeResult {
    // The formula's own entry checks, before any lock or effect: see
    // [`refers_to_entry_refusal`].
    if let Some(error) = refers_to_entry_refusal(&refers_to) {
        return NamedRangeResult { success: false, named_range: None, error: Some(error) };
    }
    let mut named_range = NamedRange {
        name: name.clone(),
        sheet_index,
        refers_to,
        comment,
        folder,
    };

    // LOCKED BUT UNDECIDED: `DocumentEffect::mutates` dirties at construction,
    // and the "does not exist" refusal is still ahead -- it used to come after
    // the effect, so editing a name that was not there marked the workbook
    // modified. The gate reads through the held lock; the effect is minted
    // only once it has passed, in the same critical section.
    //
    // `grid` and `grids` FIRST, then the registry, all held THROUGH the undo
    // record (rev3B#6, rev5C#1): released before it, a rename could run in
    // between and land "Rename name" below this "Edit name" step for a key it
    // had already moved -- Ctrl+Z then re-created the old name beside the new
    // one, and the edit itself was never undone. The order and its safety are
    // `create_named_range_impl`'s. The block ENDS every guard before the
    // recalculation (which takes the grids and the dependency maps).
    {
        let Ok(grid_hold) = state.grid.lock_pending() else {
            return NamedRangeResult {
                success: false,
                named_range: None,
                error: Some("The workbook is unavailable.".to_string()),
            };
        };
        let Ok(grids_hold) = state.grids.lock_pending() else {
            return NamedRangeResult {
                success: false,
                named_range: None,
                error: Some("The workbook is unavailable.".to_string()),
            };
        };
        let pending = state.named_ranges.lock_pending().unwrap();
        // THE NAME OF THIS SCOPE (BUG-0744): the entry held at (scope, name).
        // Failing that, Excel's `Names(name)` ([`addressed_key`]) is
        // MOVED to the scope asked for -- the MCP tool's `sheet_index` edit,
        // which Excel's Name Manager does not offer; never onto a name that
        // scope already holds.
        let new_key = registry_key(sheet_index, &name);
        let old_key = if pending.contains_key(&new_key) {
            Some(new_key.clone())
        } else {
            addressed_key(&pending, &name, None)
        };
        let Some(old_key) = old_key else {
            return NamedRangeResult {
                success: false,
                named_range: None,
                error: Some(format!("Named range '{}' does not exist.", name)),
            };
        };
        named_range.sheet_index = sheet_index;
        let effect = DocumentEffect::mutates(file_state);
        let mut named_ranges = pending.authorize(&effect);
        if old_key == new_key {
            let previous = named_ranges.insert(new_key.clone(), named_range.clone());
            crate::undo_commands::record_named_range_undo(state, &new_key, previous, "Edit name");
        } else {
            let previous = named_ranges.remove(&old_key);
            named_ranges.insert(new_key.clone(), named_range.clone());
            let opened = {
                let mut undo_stack = state.undo_stack.lock().unwrap();
                let opened = !undo_stack.has_open_transaction();
                if opened {
                    undo_stack.begin_transaction("Edit name".to_string());
                }
                opened
            };
            crate::undo_commands::record_named_range_undo(state, &new_key, None, "Edit name");
            crate::undo_commands::record_named_range_undo(state, &old_key, previous, "Edit name");
            if opened {
                state.undo_stack.lock().unwrap().commit_transaction();
            }
        }
        drop(named_ranges);
        drop(grids_hold);
        drop(grid_hold);
    }

    // REPOINTING A NAME MOVES EVERY FORMULA THAT READS IT. This is the whole
    // point of D2 — before it, the formulas held the old definition's
    // coordinates and nothing here could reach them.
    recalc_after_name_change(
        state,
        user_files_state,
        pivot_state,
        pane_control_state,
        ribbon_filter_state,
        &[name],
    );
    // A LIVE DATA TABLE whose model reads the name follows it under automatic
    // calculation (BUG-0652, rev-dt2-1). The grid re-reads on
    // NAMED_RANGES_CHANGED, so the cells are not kept.
    crate::data_tables::refresh_after_edit(
        state,
        user_files_state,
        pivot_state,
        pane_control_state,
        ribbon_filter_state,
        &mut Vec::new(),
    );

    NamedRangeResult {
        success: true,
        named_range: Some(named_range),
        error: None,
    }
}

/// Delete a named range.
///
/// EXCEL'S BEHAVIOUR, DELIBERATELY: the formulas are NOT rewritten. Excel leaves
/// `=RATE*B2` saying `RATE` and the cell shows `#NAME?` until the name is
/// defined again — it does not substitute the old definition back in, and it does
/// not blank the formula. That falls straight out of storing the name: the
/// expansion below finds nothing and the evaluator's unresolved-`NamedRef` arm
/// returns `#NAME?`. All this command has to do is make the cells recalculate.
#[tauri::command]
pub fn delete_named_range(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    name: String,
    // The SCOPE of the name to delete (BUG-0744): `None` is the workbook's
    // name, else the first sheet's own (`addressed_key`).
    sheet_index: Option<usize>,
) -> NamedRangeResult {
    delete_named_range_scoped(
        &state,
        &file_state,
        &user_files_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        name,
        sheet_index,
    )
}

/// `delete_named_range` over plain references, for the same reason as
/// [`update_named_range_core`], addressing the name with no scope
/// ([`addressed_key`]).
pub(crate) fn delete_named_range_core(
    state: &AppState,
    file_state: &FileState,
    user_files_state: &crate::persistence::UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    name: String,
) -> NamedRangeResult {
    delete_named_range_scoped(
        state,
        file_state,
        user_files_state,
        pivot_state,
        pane_control_state,
        ribbon_filter_state,
        name,
        None,
    )
}

/// [`delete_named_range_core`] for the name of one SCOPE.
#[allow(clippy::too_many_arguments)]
pub(crate) fn delete_named_range_scoped(
    state: &AppState,
    file_state: &FileState,
    user_files_state: &crate::persistence::UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    name: String,
    sheet_index: Option<usize>,
) -> NamedRangeResult {
    // Decided under the held lock, AFTER the "does not exist" refusal: a
    // delete of a name that is not there changes nothing and must leave the
    // document clean (it used to dirty it).
    //
    // `grid` and `grids` FIRST, then the registry, all held through the script
    // prune and the undo record (rev3B#6, rev5C#1; the order and its safety
    // are `create_named_range_impl`'s): released before the record, a rename
    // could land its "Rename name" step between this delete and its own. The
    // block ENDS every guard before the recalculation.
    // The ids of the scripts the prune took, announced once every guard is
    // released (see `rename_named_range_impl`'s announcement).
    let mut pruned_ids: Vec<String> = Vec::new();
    let removed = {
        let Ok(grid_hold) = state.grid.lock_pending() else {
            return NamedRangeResult {
                success: false,
                named_range: None,
                error: Some("The workbook is unavailable.".to_string()),
            };
        };
        let Ok(grids_hold) = state.grids.lock_pending() else {
            return NamedRangeResult {
                success: false,
                named_range: None,
                error: Some("The workbook is unavailable.".to_string()),
            };
        };
        let pending = state.named_ranges.lock_pending().unwrap();
        let Some(key) = addressed_key(&pending, &name, sheet_index) else {
            return NamedRangeResult {
                success: false,
                named_range: None,
                error: Some(format!("Named range '{}' does not exist.", name)),
            };
        };
        let effect = DocumentEffect::mutates(file_state);
        let mut named_ranges = pending.authorize(&effect);
        let removed = named_ranges.remove(&key);
        // A script is bound to a name by its TEXT, so it is the name's while
        // ANY scope still holds that spelling: only the last one takes them.
        let spelling_remains = defined_in_any_scope(&named_ranges, &identity::defined_name_key(&name));

        if let Some(removed) = &removed {
            // C10 cleanup: prune any object scripts attached to this name so a
            // deleted name leaves no dangling scripts behind. instanceId == the
            // name string (matched case-insensitively to be safe). What the
            // prune took -- and only that -- is kept for the undo. Released
            // before the undo stack is taken (a structural shift holds the
            // stack while it takes `object_scripts`).
            let pruned = match state.object_scripts.write(&effect) {
                Ok(_) if spelling_remains => Vec::new(),
                Ok(mut scripts) => crate::undo_commands::take_object_scripts(&mut scripts, |s| {
                    s.object_type == persistence::ScriptableObjectType::NamedRange
                        && s.instance_id
                            .as_deref()
                            .map(|id| identity::defined_names_equal(id, &name))
                            .unwrap_or(false)
                }),
                Err(_) => Vec::new(),
            };
            pruned_ids = pruned.iter().map(|p| p.script.id.clone()).collect();

            // ONE undo step puts back the name AND the scripts it took with
            // it: recorded as the registry restore alone, Ctrl+Z brought the
            // name back with its macro gone for good. The scripts are recorded
            // BY ID (`OBJECT_SCRIPTS_BY_ID_RESTORE_KIND`): a whole-list
            // snapshot put back every OTHER script as this delete found it,
            // so undoing the delete after the user had edited or created
            // another script (a script save records no undo) reverted or
            // deleted it. Joined into a transaction only when there are any.
            let opened = if pruned.is_empty() {
                false
            } else {
                let mut undo_stack = state.undo_stack.lock().unwrap();
                let opened = !undo_stack.has_open_transaction();
                if opened {
                    undo_stack.begin_transaction("Delete name".to_string());
                }
                undo_stack.record_custom_restore(
                    crate::undo_commands::OBJECT_SCRIPTS_BY_ID_RESTORE_KIND.to_string(),
                    crate::undo_commands::object_scripts_pruned_bytes(pruned),
                    "Restore name scripts",
                );
                opened
            };
            crate::undo_commands::record_named_range_undo(
                state,
                &key,
                Some(removed.clone()),
                "Delete name",
            );
            if opened {
                state.undo_stack.lock().unwrap().commit_transaction();
            }
        }
        drop(named_ranges);
        drop(grids_hold);
        drop(grid_hold);
        removed
    };
    for id in &pruned_ids {
        crate::scripting::object_script_commands::announce_object_script_change(
            id,
            crate::scripting::object_script_commands::SCRIPT_DELETED,
        );
    }

    match removed {
        Some(removed) => {
            recalc_after_name_change(
                state,
                user_files_state,
                pivot_state,
                pane_control_state,
                ribbon_filter_state,
                &[name],
            );
            // A LIVE DATA TABLE whose model read the name follows it under
            // automatic calculation (BUG-0652, rev-dt2-1).
            crate::data_tables::refresh_after_edit(
                state,
                user_files_state,
                pivot_state,
                pane_control_state,
                ribbon_filter_state,
                &mut Vec::new(),
            );

            NamedRangeResult {
                success: true,
                named_range: Some(removed),
                error: None,
            }
        }
        // Unreachable while the gate above holds the same lock; kept so the
        // match stays total.
        None => NamedRangeResult {
            success: false,
            named_range: None,
            error: Some(format!("Named range '{}' does not exist.", name)),
        },
    }
}

/// Get a named range by name.
#[tauri::command]
pub fn get_named_range(
    state: State<AppState>,
    name: String,
    // The sheet the name is ASKED FROM (the Name Box's and Go To's active
    // sheet): its own scoped name shadows the workbook's, as in a formula.
    sheet_index: Option<usize>,
) -> Option<NamedRange> {
    get_named_range_in(&state, &name, sheet_index)
}

/// `get_named_range` over a plain reference (BUG-0744). `Sheet2!Rate` is the
/// name scoped to Sheet2 (else the workbook `Rate`); a bare `Rate` asked from
/// `sheet` is that sheet's own `Rate`, else the workbook's; asked from no
/// sheet it is the workbook's, else the first sheet's own ([`addressed_key`];
/// Excel's `Names(name)` would put the first sheet's ahead of the workbook's,
/// but a null scope is also how the Name Manager spells a workbook name).
pub(crate) fn get_named_range_in(state: &AppState, name: &str, sheet_index: Option<usize>) -> Option<NamedRange> {
    // `sheet_names` before `named_ranges` (BUG-0045).
    let sheet_names = state.sheet_names.read().ok()?.clone();
    let named_ranges = state.named_ranges.read().ok()?;
    if let Some(found) = resolve_reference_text(&named_ranges, &sheet_names, name, sheet_index) {
        return Some(found.clone());
    }
    if sheet_index.is_none() && !name.contains('!') {
        return addressed_key(&named_ranges, name, None).and_then(|k| named_ranges.get(&k).cloned());
    }
    None
}

/// Get all named ranges.
#[tauri::command]
pub fn get_all_named_ranges(
    state: State<AppState>,
) -> Vec<NamedRange> {
    let named_ranges = state.named_ranges.read().unwrap();
    named_ranges.values().cloned().collect()
}

/// Find a named range that matches the given selection coordinates.
/// Used by NameBox to display the name instead of the cell address.
/// Checks `refers_to` formulas that resolve to simple ranges matching the selection.
#[tauri::command]
pub fn get_named_range_for_selection(
    state: State<AppState>,
    sheet_index: usize,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> Option<NamedRange> {
    // `sheet_names` FIRST: the recalculation pass takes it before `named_ranges`
    // and runs on a background thread, so the other order closes a cycle that
    // hangs the app with no panic and no log line (BUG-0045).
    let sheet_names = state.sheet_names.read().unwrap();
    let named_ranges = state.named_ranges.read().unwrap();
    let current_sheet_name = sheet_names.get(sheet_index).cloned().unwrap_or_default();

    // Build the expected refers_to patterns to match against.
    // We try to match by parsing each name's refers_to formula.
    let mut best_match: Option<&NamedRange> = None;

    for nr in named_ranges.values() {
        // Skip sheet-scoped names that don't match the current sheet
        if let Some(scope_sheet) = nr.sheet_index {
            if scope_sheet != sheet_index {
                continue;
            }
        }

        // Try to parse the refers_to formula and see if it matches our coordinates
        let formula = &nr.refers_to;
        if let Ok(parsed) = parser::parse(formula) {
            if range_matches_selection(
                &parsed,
                &current_sheet_name,
                start_row,
                start_col,
                end_row,
                end_col,
            ) {
                // Prefer sheet-scoped matches over workbook-scoped
                if nr.sheet_index.is_some() {
                    return Some(nr.clone());
                }
                best_match = Some(nr);
            }
        }
    }

    best_match.cloned()
}

/// Check if a parsed expression matches the given selection coordinates.
fn range_matches_selection(
    expr: &parser::ast::Expression,
    current_sheet_name: &str,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> bool {
    match expr {
        parser::ast::Expression::CellRef { sheet, col, row, .. } => {
            // Single cell: check if selection is also a single cell
            if start_row != end_row || start_col != end_col {
                return false;
            }
            // Sheet must match (None means current sheet)
            if let Some(s) = sheet {
                if !identity::sheet_names_equal(&s, &current_sheet_name) {
                    return false;
                }
            }
            let col_idx = col_letters_to_index(col);
            let row_idx = row.saturating_sub(1); // Parser uses 1-indexed
            row_idx == start_row && col_idx == start_col
        }
        parser::ast::Expression::Range { sheet, start, end, .. } => {
            if let Some(s) = sheet {
                if !identity::sheet_names_equal(&s, &current_sheet_name) {
                    return false;
                }
            }
            if let (
                parser::ast::Expression::CellRef { col: sc, row: sr, .. },
                parser::ast::Expression::CellRef { col: ec, row: er, .. },
            ) = (start.as_ref(), end.as_ref())
            {
                let sc_idx = col_letters_to_index(sc);
                let sr_idx = sr.saturating_sub(1);
                let ec_idx = col_letters_to_index(ec);
                let er_idx = er.saturating_sub(1);
                sr_idx == start_row && sc_idx == start_col && er_idx == end_row && ec_idx == end_col
            } else {
                false
            }
        }
        _ => false,
    }
}

/// Convert column letters to 0-based column index.
fn col_letters_to_index(letters: &str) -> u32 {
    let mut result: u32 = 0;
    for ch in letters.chars() {
        let val = (ch.to_ascii_uppercase() as u32) - ('A' as u32) + 1;
        result = result * 26 + val;
    }
    result.saturating_sub(1) // Convert to 0-based
}

/// Resolve a parsed `refers_to` expression (a single CellRef or a Range of two
/// CellRefs) to 0-based grid coordinates. Returns the referenced sheet name (if
/// the expression carried one) so the caller can map it to a sheet index.
/// Returns None for constants, formulas, or anything that is not a plain
/// cell/range reference.
fn resolve_ref_to_coords(
    expr: &parser::ast::Expression,
) -> Option<(Option<String>, u32, u32, u32, u32)> {
    use parser::ast::Expression;
    match expr {
        Expression::CellRef { sheet, col, row, .. } => {
            let c = col_letters_to_index(col);
            let r = row.saturating_sub(1);
            Some((sheet.clone(), r, c, r, c))
        }
        Expression::Range { sheet, start, end, .. } => {
            if let (
                Expression::CellRef { col: sc, row: sr, .. },
                Expression::CellRef { col: ec, row: er, .. },
            ) = (start.as_ref(), end.as_ref())
            {
                let sc_idx = col_letters_to_index(sc);
                let sr_idx = sr.saturating_sub(1);
                let ec_idx = col_letters_to_index(ec);
                let er_idx = er.saturating_sub(1);
                Some((
                    sheet.clone(),
                    sr_idx.min(er_idx),
                    sc_idx.min(ec_idx),
                    sr_idx.max(er_idx),
                    sc_idx.max(ec_idx),
                ))
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Resolve a named range to grid coordinates for object scripts.
/// Reuses the existing `refers_to` parsing and extends single-cell handling to
/// full ranges (A1:B10). The sheet is the formula's sheet prefix, matched by
/// Excel's case rule; a `refers_to` with no prefix falls back to the name's
/// scope, then sheet 0.
#[tauri::command]
pub fn resolve_named_range_coords(
    state: State<AppState>,
    name: String,
    // WHERE THE NAME IS ASKED FROM -- the Name Box's and Go To's active sheet
    // and active cell (0-based). Both optional: a script's `names.X` asks from
    // nowhere, and reads the name as written (BUG-0749, see
    // [`resolve_named_range_coords_at`]).
    sheet_index: Option<usize>,
    row: Option<u32>,
    col: Option<u32>,
) -> Result<NamedRangeCoords, String> {
    let at = match (row, col) {
        (Some(r), Some(c)) => Some((r, c)),
        _ => None,
    };
    resolve_named_range_coords_at(&state, &name, sheet_index, at)
}

/// `resolve_named_range_coords` over a plain reference.
///
/// THE SCOPE (BUG-0744): the name the text means on `sheet` --
/// [`get_named_range_in`]'s rule, `Sheet2!Rate` included.
///
/// A RELATIVE NAME IS READ AT THE ACTIVE CELL when one is given (BUG-0749).
/// [LIVE, Excel 16, 2026-11-06, lane names q1.ps1] with `relN` = `=Sheet2!B2`
/// (defined at A1), `Application.Goto "relN"` from D5 selects E6 and from A1
/// selects B2 -- Go To and the Name Box read a relative name from the cell
/// you are on, as a formula in that cell would -- while the object model's
/// `Range("relN")` is B2 from D5 too: a script reads the name as written,
/// anchored at A1, which is what `at` `None` does. Calcula's Name Box read it
/// literally, so `relN` always went to B2.
pub(crate) fn resolve_named_range_coords_at(
    state: &AppState,
    name: &str,
    sheet_index: Option<usize>,
    at: Option<(u32, u32)>,
) -> Result<NamedRangeCoords, String> {
    // `sheet_names` before `named_ranges` — see `get_named_range_for_selection`
    // and BUG-0045.
    let sheet_names = state.sheet_names.read().map_err(|e| e.to_string())?.clone();
    let nr = get_named_range_in(state, name, sheet_index)
        .ok_or_else(|| format!("Named range '{}' does not exist.", name))?;
    named_range_coords_at(&sheet_names, &nr, name, at.unwrap_or((0, 0)))
}

/// The pure half of `resolve_named_range_coords`: `nr`'s rectangle on the
/// sheet its `refers_to` names, against the workbook's `sheet_names`.
///
/// THE SHEET PREFIX IS MATCHED BY EXCEL'S CASE RULE (`identity::sheet_names_equal`),
/// the one every engine lookup uses -- `='ärende'!$B$1` is the sheet `Ärende`,
/// exactly as `=Rate` resolves it in a cell. It used to be
/// `eq_ignore_ascii_case`, which found no sheet for that prefix.
///
/// A PREFIX THAT NAMES NO SHEET IS REFUSED, never resolved somewhere else. The
/// old fallback to the name's scope sheet, or sheet 0, sent a script's
/// `names.Rate` write to `Sheet1!B1` with no error, over the user's data; Excel
/// evaluates a name whose sheet is gone to `#REF!` and selects nothing.
#[cfg(test)]
fn named_range_coords_in(
    sheet_names: &[String],
    nr: &NamedRange,
    name: &str,
) -> Result<NamedRangeCoords, String> {
    named_range_coords_at(sheet_names, nr, name, (0, 0))
}

/// [`named_range_coords_in`] for the name read AT the 0-based cell `at`: its
/// relative references are anchored there (`parser::anchor_name_references`,
/// the rule a formula in that cell reads it by).
fn named_range_coords_at(
    sheet_names: &[String],
    nr: &NamedRange,
    name: &str,
    at: (u32, u32),
) -> Result<NamedRangeCoords, String> {
    let mut parsed = parser::parse(&nr.refers_to)
        .map_err(|_| format!("Named range '{}' does not refer to a parseable range.", name))?;
    if at != (0, 0) {
        parser::anchor_name_references(&mut parsed, at.0, at.1);
    }

    let (sheet_ref, start_row, start_col, end_row, end_col) = resolve_ref_to_coords(&parsed)
        .ok_or_else(|| {
            format!("Named range '{}' does not refer to a cell or range.", name)
        })?;

    let sheet_index = match sheet_ref {
        Some(sname) => sheet_names
            .iter()
            .position(|n| identity::sheet_names_equal(n, &sname))
            .ok_or_else(|| {
                format!(
                    "Named range '{}' refers to the sheet '{}', which is not in this workbook ({}).",
                    name, sname, nr.refers_to
                )
            })?,
        None => nr.sheet_index.unwrap_or(0),
    };

    Ok(NamedRangeCoords {
        sheet_index,
        start_row,
        start_col,
        end_row,
        end_col,
    })
}

// ============================================================================
// RENAME — THE KEY MOVES *AND* THE FORMULAS FOLLOW IT
// ============================================================================

/// One OTHER defined name whose `refers_to` mentions the name being renamed.
///
/// A name may be defined in terms of another (`DOUBLED` = `=BASE*2`), so
/// renaming `BASE` breaks `DOUBLED` exactly the way it used to break a cell —
/// and `DOUBLED`'s readers, which never mentioned `BASE` at all, go `#NAME?`
/// with nothing in the document saying why. `refers_to` is stored as TEXT, so
/// this half is a parse -> walk -> render round trip rather than an in-place AST
/// edit like the grid half.
struct NestedRename {
    /// Uppercase registry key of the OTHER name.
    key: String,
    /// The entry as it was, for the undo record.
    before: NamedRange,
    /// The entry with its `refers_to` repointed.
    after: NamedRange,
}

/// Rename a named range, carrying every formula that reads it.
///
/// EXCEL'S BEHAVIOUR: the Name Manager's rename REPOINTS the references. That is
/// not a nicety here, it is the difference between a working command and a
/// destructive one — D2 stores the NAME inside the formula and resolves it while
/// calculating (`resolve_names_in_ast`), so moving the registry key on its own
/// turns every formula that read the old name into `#NAME?`. This shipped that
/// way once, behind a confirmation dialog; a warning the user can click through
/// is not a substitute for not breaking their workbook.
///
/// FOUR PARTS, IN ORDER, and the order is the contract:
///
/// 1. every gate that can still refuse — the name is legal, it does not collide
///    with a TABLE (one formula namespace, two registries), the old name exists,
///    the new key is free, and every rewritten `refers_to` can be read back;
/// 2. the registry move, under the guard the gates read through
///    (`lock_pending` / `authorize`), so gate and mutation are one critical
///    section and the document is dirtied only once every refusal is behind us;
/// 3. the repoint, over the stored ASTs of every sheet in the name's SCOPE,
///    and of the object scripts bound to the name (they are bound by its text)
///    with their scheduled jobs -- announced to every window once the locks
///    are released (`workbook:object-scripts-changed`, "rebound");
/// 4. ONE undo transaction covering all of it, because a rename that undoes
///    halfway is worse than one that cannot be undone at all.
///
/// The recalculation and the dependency rebuild are the caller's second lock
/// phase, below.
#[tauri::command]
pub fn rename_named_range(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    old_name: String,
    new_name: String,
    // The SCOPE of the name to rename (BUG-0744); `None` as for a delete.
    sheet_index: Option<usize>,
) -> NamedRangeResult {
    rename_named_range_scoped_core(
        &state,
        &file_state,
        &user_files_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        &old_name,
        &new_name,
        sheet_index,
    )
}

/// The WHOLE rename -- the gated move, the repoint of the formulas AND of the
/// name's object scripts, then the second lock phase -- over plain references.
/// The ONE rename every route runs: the Name Manager and the command line
/// through `rename_named_range`, the object-script broker's `namedRange.update`
/// through the same command (`scriptHost/host.ts` `executeNamedRangeUpdate`),
/// and the MCP / AI-chat tool `update_named_range`
/// (`mcp::objects::update_named_range_core`). The last two used to rename by
/// DELETE + CREATE -- the delete deliberately rewrites no formula and the
/// create repoints none, so every reader of the old name came back `#NAME?` --
/// and each carried the name's scripts itself, which the Name Manager never
/// did (it orphaned them). The scripts now move inside the rename, in its one
/// "Rename name" undo step ([`repoint_named_range_scripts`]).
#[allow(clippy::too_many_arguments)]
pub(crate) fn rename_named_range_core(
    state: &AppState,
    file_state: &FileState,
    user_files_state: &crate::persistence::UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    old_name: &str,
    new_name: &str,
) -> NamedRangeResult {
    rename_named_range_scoped_core(
        state,
        file_state,
        user_files_state,
        pivot_state,
        pane_control_state,
        ribbon_filter_state,
        old_name,
        new_name,
        None,
    )
}

/// [`rename_named_range_core`] for the name of one SCOPE (BUG-0744).
#[allow(clippy::too_many_arguments)]
pub(crate) fn rename_named_range_scoped_core(
    state: &AppState,
    file_state: &FileState,
    user_files_state: &crate::persistence::UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    old_name: &str,
    new_name: &str,
    sheet_index: Option<usize>,
) -> NamedRangeResult {
    let result = rename_named_range_scoped_impl(state, file_state, old_name, new_name, sheet_index);
    if result.success {
        // PHASE B, holding nothing: both helpers take their own locks.
        //
        // THE EDGES ARE KEYED BY NAME. `name_dependents` files every reader
        // under the name it read, so after the repoint every edge is filed under
        // a name the workbook no longer has — and the next repoint of the NEW
        // name would reach none of them, leaving exactly these cells holding the
        // number they computed from the old definition. Rebuilding first is what
        // makes the seeding below find them. (Same argument
        // `apply_names_to_formulas` makes for the cells it rewrites, and
        // `recalc_after_table_change` for a renamed table.)
        crate::undo_commands::rebuild_all_dependencies(state);
        // No VALUE moves for a reader that was repointed — the same definition
        // under a new name — but two populations do move: a cell that already
        // said `=NEWNAME` before the name existed was `#NAME?` and is now a
        // number, and a reader OUTSIDE a sheet-scoped name's scope keeps saying
        // the old name. Both spellings are reported so both are reached.
        recalc_after_name_change(
            state,
            user_files_state,
            pivot_state,
            pane_control_state,
            ribbon_filter_state,
            &[old_name.to_string(), new_name.to_string()],
        );
        // A LIVE DATA TABLE whose model reads either spelling follows the
        // rename under automatic calculation (BUG-0652, rev-dt2-1).
        crate::data_tables::refresh_after_edit(
            state,
            user_files_state,
            pivot_state,
            pane_control_state,
            ribbon_filter_state,
            &mut Vec::new(),
        );
    }
    result
}

/// Command body over plain references, so the gates, the repoint and the undo
/// transaction are unit-testable without a Tauri `State` — the same split
/// `create_named_range_impl` uses.
pub(crate) fn rename_named_range_impl(
    state: &AppState,
    file_state: &FileState,
    old_name: &str,
    new_name: &str,
) -> NamedRangeResult {
    rename_named_range_scoped_impl(state, file_state, old_name, new_name, None)
}

/// [`rename_named_range_impl`] for the name of one SCOPE (BUG-0744): the
/// name keeps its scope, and its new spelling must be free IN that scope --
/// a sheet's `Rate` may be renamed `Tax` beside a workbook `Tax`, as Excel's
/// Name Manager allows a second scope of a spelling.
pub(crate) fn rename_named_range_scoped_impl(
    state: &AppState,
    file_state: &FileState,
    old_name: &str,
    new_name: &str,
    scope: Option<usize>,
) -> NamedRangeResult {
    fn refuse(message: String) -> NamedRangeResult {
        NamedRangeResult {
            success: false,
            named_range: None,
            error: Some(message),
        }
    }

    // ---- GATE 1: the new name has to be a name. ----------------------------
    if !NamedRange::is_valid_name(new_name) {
        return refuse(invalid_name_message(new_name));
    }

    let old_key = identity::defined_name_key(old_name);
    let new_key = identity::defined_name_key(new_name);

    // ---- THE LOCKS, IN THE CRATE'S ORDER, BEFORE ANY OTHER (BUG-0592). -----
    // `grid` and `grids` FIRST, then everything else -- the order of every
    // cell writer (`update_cell_impl`, `update_cells_batch_core`, `fill_range`,
    // which the MCP server, the AI chat and the notebook drive off the main
    // thread) and of the recalculation pass. Both are held, PENDING, through
    // the gates, the registry move, the repoint and the undo record, so the
    // rename is ONE critical section for every reader that takes a grid lock
    // first: none can see the registry already saying the new name while the
    // formulas still say the old one (their `#NAME?`), and no cell write can
    // land between the move and the repoint.
    //
    // THE REGISTRY IS HELD TO THE END TOO, across the repoint and the undo
    // record. The name writers -- `create_named_range_impl`,
    // `update_named_range_core`, `delete_named_range_core`, which the MCP tools
    // and the script host reach off the main thread -- took `named_ranges` and
    // NO grid lock, so the grid hold alone did not order them: released at
    // the move, the registry let one define the freed old name and record its
    // "Define name" BELOW this "Rename name" step (or inside it, between its
    // separate undo-stack locks), and undoing the rename then overwrote that
    // definition and the next Ctrl+Z deleted the user's original name. They
    // now take `grid` and `grids` first too, in this order, and hold them and
    // the registry through their own undo record (rev3B#6, rev5C#1), the
    // mirror of this rule.
    // `undo_stack` under `named_ranges` closes no cycle: every function that
    // holds `undo_stack` while it takes a name store (the cell writers) holds
    // `grid` AND `grids` first, which this rename holds, and Undo itself holds
    // the stack alone. `no_function_holds_the_undo_stack_and_a_name_store_in_an_order_that_can_cycle`
    // (state_digest_lock_order_tests.rs) pins both halves crate-wide.
    // `lock_pending` postpones the dirty decision past the last refusal.
    let pending_grid = match state.grid.lock_pending() {
        Ok(guard) => guard,
        Err(_) => return refuse("The workbook is unavailable.".to_string()),
    };
    let pending_grids = match state.grids.lock_pending() {
        Ok(guard) => guard,
        Err(_) => return refuse("The workbook is unavailable.".to_string()),
    };
    // Under the grid hold, so a sheet switch cannot land between this read
    // and the repoint below.
    let Ok(active_sheet) = state.active_sheet.read().map(|active| *active) else {
        return refuse("The workbook is unavailable.".to_string());
    };

    // ---- GATE 2: names and TABLES share ONE formula namespace. -------------
    // `create_named_range` refuses a name a table already holds because which
    // one wins otherwise depends on resolution order — names resolve first, then
    // tables, so the same formula could mean different things down different
    // paths. Rename skipped the check entirely, so a rename could walk a name
    // straight into a table's name. Skipped when the KEY does not move
    // ("total" -> "Total"): that is a re-spelling, not a new claim on the
    // namespace.
    if old_key != new_key {
        if let Ok(table_names) = state.table_names.read() {
            if table_names.contains_key(&new_key) {
                return refuse(format!(
                    "A table named '{}' already exists. Names and tables share one namespace — pick a different name.",
                    new_name
                ));
            }
        }
    }

    // CLONED, not held: `sheet_names` must be taken BEFORE `named_ranges`
    // (BUG-0045 — the recalculation pass takes them in that order on a
    // background thread and the reverse closes a cycle that hangs the app with
    // no panic and no log line), and nothing below needs the lock itself.
    let sheet_names: Vec<String> = match state.sheet_names.read() {
        Ok(names) => names.clone(),
        Err(_) => return refuse("Sheet names are unavailable.".to_string()),
    };

    // ---- GATES 3-5, under the guard the mutation will use. -----------------
    // LOCKED BUT UNDECIDED: `DocumentEffect::mutates` dirties AT CONSTRUCTION,
    // and three of this command's refusals are still ahead. `lock_pending` reads
    // through the held lock and postpones the dirty decision past the last
    // `return`, keeping the gate and the mutation in ONE critical section.
    let pending = match state.named_ranges.lock_pending() {
        Ok(guard) => guard,
        Err(_) => return refuse("Named ranges are unavailable.".to_string()),
    };

    // THE REGISTRY KEYS (scope + name, BUG-0744); `old_key` / `new_key` stay
    // the NAME keys the formulas are matched by.
    let Some(old_reg) = addressed_key(&pending, old_name, scope) else {
        return refuse(format!("Named range '{}' does not exist.", old_name));
    };
    let Some(existing) = pending.get(&old_reg).cloned() else {
        return refuse(format!("Named range '{}' does not exist.", old_name));
    };
    let new_reg = registry_key(existing.sheet_index, new_name);
    if old_reg != new_reg && pending.contains_key(&new_reg) {
        return refuse(format!("A named range '{}' already exists.", new_name));
    }
    // Renaming a name to exactly what it is already called changes nothing, and
    // a command that changes nothing must not dirty the document.
    if existing.name == new_name {
        return NamedRangeResult {
            success: true,
            named_range: Some(existing),
            error: None,
        };
    }

    let mut renamed = existing.clone();
    renamed.name = new_name.to_string();

    // The registry AS IT WILL BE. `plan_nested_renames` restamps the definitions
    // it rewrites against a name table, and against the PRE-rename one a
    // case-only rename ("total" -> "Total") would restamp its own work straight
    // back to the old spelling.
    let mut after_map = (*pending).clone();
    after_map.remove(&old_reg);
    after_map.insert(new_reg.clone(), renamed.clone());

    // The sheets whose OWN name of the old spelling shadows a workbook name
    // being renamed: a formula there reads its sheet's name [LIVE, q1.ps1],
    // so it is not repointed (BUG-0744).
    let shadowed: Vec<usize> = if existing.sheet_index.is_none() {
        pending.values().filter(|nr| nr.sheet_index.is_some() && identity::defined_name_key(&nr.name) == old_key).filter_map(|nr| nr.sheet_index).collect()
    } else {
        Vec::new()
    };
    // Another scope still holding the old spelling keeps the scripts bound to it.
    let old_spelling_remains = defined_in_any_scope(&after_map, &old_key);

    let nested = match plan_nested_renames(&after_map, &sheet_names, &new_reg, &old_key, new_name, &renamed, &shadowed)
    {
        Ok(planned) => planned,
        Err(message) => return refuse(message),
    };

    // Every gate has passed; from here this command commits.
    let effect = DocumentEffect::mutates(file_state);
    let mut grid = pending_grid.authorize(&effect);
    let mut grids = pending_grids.authorize(&effect);
    let mut named_ranges = pending.authorize(&effect);

    named_ranges.remove(&old_reg);
    named_ranges.insert(new_reg.clone(), renamed.clone());
    for entry in &nested {
        named_ranges.insert(entry.key.clone(), entry.after.clone());
    }

    // ---- THE REPOINT, under the same grid hold. ---------------------------
    let touched =
        rename_name_in_grids(&mut grid, &mut grids, active_sheet, &sheet_names, existing.sheet_index, &shadowed, &old_key, new_name);

    // ---- THE NAME'S OBJECT SCRIPTS FOLLOW IT, in the same critical section.
    // Bound by the name's TEXT, so without this every route's rename orphaned
    // them (see `repoint_named_range_scripts`).
    let rebound = if old_spelling_remains {
        Vec::new()
    } else {
        repoint_named_range_scripts(state, &effect, &existing.name, new_name)
    };
    let rebound_scripts: Vec<crate::undo_commands::ScriptRebind> = rebound
        .iter()
        .map(|r| crate::undo_commands::ScriptRebind { id: r.id.clone(), instance_id: r.from.clone() })
        .collect();

    // The undo stack after the grid locks (every cell writer's order), and
    // still under the registry, so no name writer's step can land below or
    // inside this one (see the lock note above).
    record_rename_undo(state, touched, &old_reg, &new_reg, &existing, &nested, rebound_scripts);
    drop(named_ranges);
    drop(grids);
    drop(grid);

    // Every window is told which scripts moved, and where (rev4B#2, rev6B#6):
    // an open Object Script Editor re-reads the binding, and the main window
    // re-keys the live mount from the payload, so neither keeps addressing the
    // old name. Announced HERE, in the one rename every route runs, because the
    // command line and the MCP tools have no frontend event of their own to
    // carry it.
    crate::scripting::script_rebind::announce_rebinds(&rebound);

    NamedRangeResult {
        success: true,
        named_range: Some(renamed),
        error: None,
    }
}

/// Repoint every OTHER name whose `refers_to` mentions the one being renamed.
///
/// Returns the planned rewrites, or the refusal message if one of them cannot be
/// read back — the `apply_names_to_formulas` rule (register §3bc): a definition
/// this command cannot re-parse is a definition it must not write, and it
/// refuses the WHOLE rename rather than leaving the registry half repointed.
/// Called BEFORE the `DocumentEffect` exists, so that refusal leaves the
/// document clean.
///
/// SCOPE. A sheet-scoped name resolves only on its own sheet
/// (`resolve_names_in_ast` prefers a name scoped to the evaluating sheet and
/// falls back to the workbook-scoped one), so a workbook-scoped rename reaches
/// every definition while a sheet-scoped one reaches only definitions with the
/// same scope. Rewriting more than that would repoint text that never denoted
/// this name. And a workbook-scoped rename skips a definition scoped to a
/// sheet that holds its OWN name of the old spelling (`shadowed`, the sheets
/// the grid repoint skips too): there the old spelling reads that sheet's own
/// name [LIVE, Excel 16, 2026-11-06, lane names q1.ps1], so rewriting it would
/// move a definition off the name it reads.
///
/// The two RESTAMPS are the load path's, for the load path's reason: the text
/// goes back through the lexer, which uppercases bare identifiers, so without
/// them a rewritten `=BudgetTotal*2` would come back as `=BUDGETTOTAL*2` and
/// `=Data!A1` as `=DATA!A1`. Purely cosmetic in both cases — every lookup on
/// these paths compares case-insensitively — which is also why a structured
/// reference in a `refers_to` is left to come back shouting: restamping that
/// would mean taking `tables` and `table_names` under `named_ranges`, and the
/// crate's two existing orders for that pair disagree.
fn plan_nested_renames(
    after_map: &std::collections::HashMap<String, NamedRange>,
    sheet_names: &[String],
    new_key: &str,
    old_key: &str,
    new_name: &str,
    renamed: &NamedRange,
    shadowed: &[usize],
) -> Result<Vec<NestedRename>, String> {
    let mut keys: Vec<&String> = after_map.keys().collect();
    // `after_map` is a hash map: sort so the refusal below names the same
    // definition on every run.
    keys.sort();

    let mut planned: Vec<NestedRename> = Vec::new();
    for key in keys {
        // The renamed name itself: a `refers_to` that mentions the old name is a
        // self-reference, which the resolver's cycle guard already answers.
        if key == new_key {
            continue;
        }
        let Some(other) = after_map.get(key) else { continue };
        // A plain spelling in another definition reads the renamed name only
        // from inside its scope and where no sheet name shadows it; a
        // sheet-qualified one by its qualifier (`qualifier_denotes`, lane form4).
        let plain = !(renamed.sheet_index.is_some() && other.sheet_index != renamed.sheet_index)
            && !other.sheet_index.is_some_and(|sheet| shadowed.contains(&sheet));
        let Ok(parsed) = parser::parse(&other.refers_to) else {
            continue; // Unparseable already — leave exactly as it is.
        };
        let qualified_denotes =
            |qualifier: &str| qualifier_denotes(sheet_names, renamed.sheet_index, shadowed, qualifier);
        let (mut rewritten, changed) = crate::name_resolution::rename_name_in_ast_scoped(
            &parsed,
            old_key,
            new_name,
            plain,
            &qualified_denotes,
        );
        if !changed {
            continue;
        }
        crate::name_resolution::restamp_name_casing(&mut rewritten, after_map);
        crate::sheet_names::restamp_sheet_casing(&mut rewritten, sheet_names);
        let text = format!("={}", engine::ast_render::render_formula_raw(&rewritten));
        if let Err(e) = parser::parse(&text) {
            crate::log_error!(
                "NAMES",
                "rename refused: '{}' would be rewritten to `{}` ({})",
                other.name,
                text,
                e
            );
            return Err(format!(
                "Cannot rename: the name '{}' refers to `{}`, which would be rewritten to `{}` and cannot be read back ({}). Nothing was changed.",
                other.name, other.refers_to, text, e
            ));
        }
        let mut after = other.clone();
        after.refers_to = text;
        planned.push(NestedRename {
            key: key.clone(),
            before: other.clone(),
            after,
        });
    }
    Ok(planned)
}

/// Whether `qualifier!old` denotes the name being renamed, whose scope is
/// `scope` (`None` = the workbook): the qualifier's sheet is that scope, or --
/// for a workbook name -- a sheet with no name of its own of that spelling
/// (`shadowed` lists the sheets that have one). An unknown sheet denotes
/// nothing. [LIVE, Excel 16, lane form4 / verify-formfix rename.ps1]
fn qualifier_denotes(sheet_names: &[String], scope: Option<usize>, shadowed: &[usize], qualifier: &str) -> bool {
    let Some(target) = sheet_names.iter().position(|s| identity::sheet_names_equal(s, qualifier)) else {
        return false;
    };
    match scope {
        Some(scope_sheet) => scope_sheet == target,
        None => !shadowed.contains(&target),
    }
}

/// Point every stored formula that reads `old_key` at `new_name`, across the
/// sheets the name's SCOPE reaches. Returns the PRE-mutation cells so the caller
/// can make it undoable.
///
/// OPERATES ON THE AST DIRECTLY rather than round-tripping through formula text,
/// for the reason `rename_table_refs_in_formulas` gives: the stored form IS the
/// AST (`engine::Cell` has no raw formula field — `formula_string()` renders
/// one), so there is no re-parse that could fail and silently demote a formula
/// cell to a value cell. The text the formula bar and `.cala` show is therefore
/// re-rendered from the rewritten tree by construction; the two cannot disagree.
///
/// SCOPE, as in [`plan_nested_renames`]: a sheet-scoped name resolves only on
/// its own sheet, so `=RATE` written on another sheet is a `#NAME?` that never
/// denoted this name and must not be rewritten into one that looks like it did.
///
/// Over the grids the CALLER holds (`rename_named_range_impl` takes both grid
/// locks before the registry and keeps them across the move, this walk and the
/// undo record -- BUG-0592), so it takes no lock of its own.
#[allow(clippy::too_many_arguments)]
fn rename_name_in_grids(
    grid: &mut engine::Grid,
    grids: &mut [engine::Grid],
    active_sheet: usize,
    sheet_names: &[String],
    scope: Option<usize>,
    shadowed: &[usize],
    old_key: &str,
    new_name: &str,
) -> Vec<(usize, u32, u32, Option<engine::Cell>)> {
    // `state.grid` is the AUTHORITATIVE copy of the active sheet and
    // `grids[active]` can lag behind it (BUG-0016) — sync before the walk, the
    // way `rename_sheet` does, or the formula the user typed since the last
    // sheet switch is repointed in the mirror and lost on the next swap.
    if active_sheet < grids.len() {
        grids[active_sheet] = grid.clone();
    }

    let mut wanted = crate::name_resolution::NameSet::default();
    wanted.insert(old_key.to_string());

    // A SHEET-QUALIFIED reader (`=Sheet1!Dup`) can sit on ANY sheet and reads
    // the name in its QUALIFIER's scope (lane form4, [LIVE] verify-formfix
    // rename.ps1): it is repointed exactly when that sheet resolves the old
    // spelling to the name being renamed, wherever the formula is.
    let qualified_denotes = |qualifier: &str| qualifier_denotes(sheet_names, scope, shadowed, qualifier);

    let mut touched: Vec<(usize, u32, u32, Option<engine::Cell>)> = Vec::new();
    for (sheet_idx, sheet_grid) in grids.iter_mut().enumerate() {
        // A PLAIN spelling reads the renamed name only inside its scope, and
        // not on a sheet whose own name of that spelling shadows it.
        let plain = scope.is_none_or(|scope_sheet| scope_sheet == sheet_idx) && !shadowed.contains(&sheet_idx);
        // The gate is the allocation-free, shadow-aware predicate the edge map
        // is built from, so this walk visits exactly the cells the name reaches.
        let candidates: Vec<(u32, u32)> = sheet_grid
            .cells
            .iter()
            .filter(|&(_, cell)| crate::name_resolution::cell_reads_any_name(cell, &wanted))
            .map(|(&coord, _)| coord)
            .collect();

        for (row, col) in candidates {
            let Some(before) = sheet_grid.get_cell(row, col).cloned() else { continue };
            let Some(ast) = before.get_ast() else { continue };
            let (rewritten, changed) = crate::name_resolution::rename_name_in_ast_scoped(
                ast,
                old_key,
                new_name,
                plain,
                &qualified_denotes,
            );
            if !changed {
                continue;
            }
            let mut updated = before.clone();
            updated.ast = Some(Box::new(rewritten));
            sheet_grid.set_cell(row, col, updated);
            touched.push((sheet_idx, row, col, Some(before)));
        }
    }

    if active_sheet < grids.len() {
        *grid = grids[active_sheet].clone();
    }

    // `grid.cells` is a hash map: sort so the undo record — and anything that
    // reads this list — does not depend on hash order.
    touched.sort_by_key(|(sheet, row, col, _)| (*sheet, *row, *col));
    touched
}

/// Re-point every object script bound to the name being renamed at its new
/// spelling, and the SCHEDULED JOBS each of them registered on the old
/// spelling with it (`scheduler::rebind_script_jobs`, rev4B#1).
///
/// A named-range script is bound by the name's TEXT (`instance_id`; the Name
/// Manager's Edit Script keys it by the selected name). The rename used to move
/// the registry key and repoint the formulas but leave the script store alone,
/// so a Name Manager or command-line rename ORPHANED the name's macro: still
/// bound to a name the workbook no longer had, while Edit Script on the renamed
/// name scaffolded a new, empty one. The MCP tool and the script host each
/// carried the scripts themselves; every route now renames through here, so
/// none of them does.
///
/// Matched case-insensitively, as `delete_named_range_core`'s prune matches.
/// Only the binding moves: id, source, provenance and the declared-capability
/// ceiling are carried over untouched, so a distributed script stays
/// distributed.
///
/// LOCKS. Taken while the caller holds `grid`, `grids` and `named_ranges` --
/// `named_ranges` before `object_scripts` is the order
/// `calp_commands::calp_get_application_objects` takes too -- and RELEASED
/// before the caller takes the undo stack: a structural shift holds
/// `undo_stack` while it takes `object_scripts` (`commands/structure.rs`
/// `shift_controls`).
///
/// Returns each re-pointed script with the binding it had -- what the undo
/// puts back -- and the one it has now, which the caller announces once the
/// locks are released (empty when no script was bound).
fn repoint_named_range_scripts(
    state: &AppState,
    effect: &DocumentEffect,
    old_name: &str,
    new_name: &str,
) -> Vec<crate::scripting::script_rebind::ScriptRebound> {
    let bound = |script: &persistence::SavedObjectScript| -> bool {
        script.object_type == persistence::ScriptableObjectType::NamedRange
            && script
                .instance_id
                .as_deref()
                .map(|id| identity::defined_names_equal(id, old_name))
                .unwrap_or(false)
    };
    let Ok(mut scripts) = state.object_scripts.write(effect) else {
        return Vec::new();
    };
    let mut rebound = Vec::new();
    for script in scripts.iter_mut() {
        if bound(script) {
            // Through the one re-bind door (scripting/script_rebind.rs): its
            // SCHEDULED JOBS follow it (rev4B#1) -- a job addresses the exposed
            // method by the binding, so a job left on the old name called
            // nothing after the next reopen while reporting a healthy run. The
            // undo and redo move them back and forth in the
            // `obj_object_scripts_by_id` restore. The scheduler lock is a leaf.
            rebound.extend(crate::scripting::script_rebind::rebind_script(
                effect,
                script,
                Some(new_name.to_string()),
            ));
        }
    }
    rebound
}

/// Record the whole rename — registry entries, rewritten formulas AND the
/// re-pointed object scripts — as ONE undo transaction.
///
/// A rename that undoes halfway is worse than one that cannot be undone at all:
/// putting the old name back while the formulas keep saying the new one produces
/// `#NAME?` everywhere, which is the exact defect the repoint exists to remove,
/// and putting it back while its script stays bound to the new spelling orphans
/// the script all over again. (`rename_table` learned this the same way;
/// `rename_sheet` sidesteps it by ENDING the undo history, which Excel also
/// does for a sheet rename and does not do for a name.)
///
/// CELLS ARE RECORDED FIRST so they restore LAST — a transaction is replayed in
/// reverse — i.e. after the registry is back, which is the order that makes the
/// restored formulas resolve. The scripts are recorded only when the rename
/// moved one, and BY ID: the bindings it moved and nothing else
/// (`OBJECT_SCRIPTS_BY_ID_RESTORE_KIND`). A whole-list snapshot put back every
/// script as the rename found it, so undoing the rename after the user had
/// edited or created a script (a script save records no undo) silently
/// reverted the edit or deleted the new script.
fn record_rename_undo(
    state: &AppState,
    touched: Vec<(usize, u32, u32, Option<engine::Cell>)>,
    old_key: &str,
    new_key: &str,
    before: &NamedRange,
    nested: &[NestedRename],
    rebound_scripts: Vec<crate::undo_commands::ScriptRebind>,
) {
    let opened = {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        let opened = !undo_stack.has_open_transaction();
        if opened {
            undo_stack.begin_transaction("Rename name".to_string());
        }
        let mut by_sheet: std::collections::HashMap<usize, Vec<(u32, u32, Option<engine::Cell>)>> =
            std::collections::HashMap::new();
        for (sheet_idx, row, col, cell) in touched {
            by_sheet.entry(sheet_idx).or_default().push((row, col, cell));
        }
        let mut sheets: Vec<usize> = by_sheet.keys().copied().collect();
        sheets.sort_unstable();
        for sheet_index in sheets {
            let cells = by_sheet.remove(&sheet_index).unwrap_or_default();
            undo_stack.record_custom_restore(
                "script_grid_cells".to_string(),
                crate::undo_commands::script_grid_cells_snapshot_bytes(sheet_index, cells),
                "Restore formulas",
            );
        }
        if !rebound_scripts.is_empty() {
            undo_stack.record_custom_restore(
                crate::undo_commands::OBJECT_SCRIPTS_BY_ID_RESTORE_KIND.to_string(),
                crate::undo_commands::object_scripts_rebound_bytes(rebound_scripts),
                "Restore name scripts",
            );
        }
        opened
    };

    // The registry half, through the SAME helper `create_named_range` and
    // `delete_named_range` use — it JOINS the transaction opened above rather
    // than opening one of its own.
    for entry in nested {
        crate::undo_commands::record_named_range_undo(
            state,
            &entry.key,
            Some(entry.before.clone()),
            "Rename name",
        );
    }
    if old_key != new_key {
        // The new key did not exist before this command (gate 4 refused
        // otherwise), so undoing must REMOVE it, not restore something.
        crate::undo_commands::record_named_range_undo(state, new_key, None, "Rename name");
    }
    crate::undo_commands::record_named_range_undo(
        state,
        old_key,
        Some(before.clone()),
        "Rename name",
    );

    if opened {
        state.undo_stack.lock().unwrap().commit_transaction();
    }
}

/// Result of the apply names operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyNamesResult {
    pub formulas_modified: u32,
    pub cells: Vec<CellData>,
}

/// Parse a `refers_to` string and extract the single-cell reference as (col_letters, row_number).
/// Returns None for range references, constant values, or formulas.
/// Handles formats like "=Sheet1!$B$5", "=$B$5", "=B5", etc.
fn extract_single_cell_ref(refers_to: &str) -> Option<(String, u32)> {
    let formula = refers_to.trim();
    if let Ok(parsed) = parser::parse(formula) {
        match &parsed {
            parser::ast::Expression::CellRef { col, row, .. } => {
                Some((col.to_uppercase(), *row))
            }
            _ => None, // Skip ranges, constants, formulas
        }
    } else {
        None
    }
}

/// Build all possible reference patterns for a cell (col_letters, row_1based).
/// For example, for ("B", 5) this returns: ["$B$5", "B$5", "$B5", "B5"].
fn build_ref_patterns(col: &str, row: u32) -> Vec<String> {
    vec![
        format!("${}${}", col, row),
        format!("{}${}", col, row),
        format!("${}{}", col, row),
        format!("{}{}", col, row),
    ]
}

/// Check if a character is valid to appear immediately before or after a cell reference
/// in a formula. Cell references are bounded by operators, parentheses, commas, etc.
/// Returns true if the character is a valid boundary (i.e., the reference is standalone).
fn is_ref_boundary(ch: char) -> bool {
    matches!(
        ch,
        '+' | '-' | '*' | '/' | '^' | '=' | '<' | '>' | '('
            | ')' | ',' | ' ' | '&' | ':' | ';' | '%' | '!'
            | '{' | '}'
    )
}

/// Replace cell references in a formula string with a named range name.
/// Only replaces standalone references (not part of another reference or name).
fn replace_ref_in_formula(formula: &str, patterns: &[String], name: &str) -> String {
    let mut result = formula.to_string();

    for pattern in patterns {
        let pat_upper = pattern.to_uppercase();
        let pat_len = pattern.len();

        // Search case-insensitively by working on an uppercase copy for matching
        let mut new_result = String::new();
        let mut i = 0;
        let chars: Vec<char> = result.chars().collect();
        let upper_chars: Vec<char> = result.to_uppercase().chars().collect();
        let pat_chars: Vec<char> = pat_upper.chars().collect();

        while i < chars.len() {
            // Check if we're inside a string literal
            if chars[i] == '"' {
                new_result.push(chars[i]);
                i += 1;
                while i < chars.len() && chars[i] != '"' {
                    new_result.push(chars[i]);
                    i += 1;
                }
                if i < chars.len() {
                    new_result.push(chars[i]); // closing quote
                    i += 1;
                }
                continue;
            }

            // Check for pattern match at current position
            if i + pat_len <= chars.len() {
                let segment: Vec<char> = upper_chars[i..i + pat_len].to_vec();
                if segment == pat_chars {
                    // Check boundary before
                    let before_ok = if i == 0 {
                        true
                    } else {
                        is_ref_boundary(chars[i - 1])
                    };

                    // Check boundary after
                    let after_ok = if i + pat_len >= chars.len() {
                        true
                    } else {
                        is_ref_boundary(chars[i + pat_len])
                    };

                    // Also ensure the character before isn't a letter or digit
                    // (which would mean this is part of a larger reference like "Sheet1!B5")
                    // But we DO want to match after '!' (sheet qualifier)
                    let before_not_alnum = if i == 0 {
                        true
                    } else {
                        let prev = chars[i - 1];
                        !prev.is_alphanumeric() && prev != '_'
                    };

                    // After must not be a letter or digit (would be part of a name)
                    let after_not_alnum = if i + pat_len >= chars.len() {
                        true
                    } else {
                        let next = chars[i + pat_len];
                        !next.is_alphanumeric() && next != '_'
                    };

                    if before_ok && after_ok && before_not_alnum && after_not_alnum {
                        // Don't replace if preceded by '!' (sheet-qualified reference like Sheet1!B5)
                        // Those should only be replaced if the sheet matches the named range's scope,
                        // but for simplicity we skip sheet-qualified refs entirely.
                        let preceded_by_bang = i > 0 && chars[i - 1] == '!';
                        if !preceded_by_bang {
                            new_result.push_str(name);
                            i += pat_len;
                            continue;
                        }
                    }
                }
            }

            new_result.push(chars[i]);
            i += 1;
        }

        result = new_result;
    }

    result
}

/// Apply named range names to formulas, replacing cell references with names.
/// This is Excel's "Apply Names" feature.
///
/// - `names`: Which named ranges to apply (empty = all)
/// - `start_row`, `start_col`, `end_row`, `end_col`: Restrict to a cell range (None = entire sheet)
#[tauri::command]
pub fn apply_names_to_formulas(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    names: Vec<String>,
    start_row: Option<u32>,
    start_col: Option<u32>,
    end_row: Option<u32>,
    end_col: Option<u32>,
) -> Result<ApplyNamesResult, String> {
    // Build the list of (name, col_letters, row_1based) for single-cell named
    // ranges -- from the names ALONE, released before any grid lock. This held
    // `named_ranges` while it took `grid`; the calculation pass (an async
    // command, off the main thread) takes `grid` first and `named_ranges` after
    // it, so the two could each hold what the other waited for (fix round 4,
    // found by the lock-order census once it could see `lock_pending`). The
    // names are only read here, to build the text replacements.
    let names_filter: HashSet<String> = names.iter().map(|n| identity::defined_name_key(n)).collect();
    let apply_all = names_filter.is_empty();

    let mut replacements: Vec<(String, Vec<String>)> = Vec::new();
    {
        let named_ranges = state.named_ranges.read().unwrap();
        for nr in named_ranges.values() {
            if !apply_all && !names_filter.contains(&identity::defined_name_key(&nr.name)) {
                continue;
            }

            if let Some((col_letters, row_num)) = extract_single_cell_ref(&nr.refers_to) {
                let patterns = build_ref_patterns(&col_letters, row_num);
                replacements.push((nr.name.clone(), patterns));
            }
        }
    }

    if replacements.is_empty() {
        return Ok(ApplyNamesResult {
            formulas_modified: 0,
            cells: Vec::new(),
        });
    }

    // LOCKED BUT UNDECIDED. This command has three ways to write nothing --
    // no applicable names, no formula that mentions one, and (since the §3bc
    // fix below) a replacement that cannot be read back -- and the dirty
    // decision has to sit AFTER all three, or asking Excel's Apply Names about
    // a workbook it has nothing to do to marks the document modified. Same
    // instrument `rename_sheet` uses: read through the pending guard, then
    // `authorize` once the command has decided to commit.
    let grid = state.grid.lock_pending().unwrap();
    let styles = state.style_registry.read().unwrap();
    let merged_regions = state.merged_regions.read().unwrap();
    let locale = state.locale.lock().unwrap();

    // Determine the cell range to scan
    let scan_start_row = start_row.unwrap_or(0);
    let scan_start_col = start_col.unwrap_or(0);
    let scan_end_row = end_row.unwrap_or(grid.max_row);
    let scan_end_col = end_col.unwrap_or(grid.max_col);

    // Collect cells that need modification first (to avoid borrow issues)
    let mut modifications: Vec<(u32, u32, String, String)> = Vec::new();

    for (&(row, col), cell) in grid.cells.iter() {
        if row < scan_start_row || row > scan_end_row
            || col < scan_start_col || col > scan_end_col
        {
            continue;
        }

        // RAW, not the display form -- the rule `repair_all_formulas` already
        // follows. `formula_string()` COLLAPSES the internal
        // `__INVOKE__("MyFn", <lambda>, args)` marker a named LAMBDA call
        // carries down to `MyFn(args)`; re-parsing that gives `Custom("MYFN")`
        // with no lambda attached, so applying a name inside such a call
        // destroyed the call. The raw form round-trips.
        if let Some(formula) = cell.formula_string_raw() {
            let mut new_formula = formula.clone();

            for (name, patterns) in &replacements {
                new_formula = replace_ref_in_formula(&new_formula, patterns, name);
            }

            if new_formula != formula {
                modifications.push((row, col, formula, new_formula));
            }
        }
    }
    // `grid.cells` is a hash map: sort so the cells the frontend paints -- and
    // the cell a refusal names -- do not depend on hash order.
    modifications.sort_by_key(|(row, col, _, _)| (*row, *col));

    // PARSE EVERY REPLACEMENT BEFORE WRITING ANY OF THEM (register §3bc).
    //
    // This used to be `parser::parse(new_formula).ok().map(Box::new)` at the
    // write site: a replacement that failed to parse set `ast = None`, which is
    // a cell holding a stale value with an EMPTY formula bar and no error
    // anywhere -- the user's formula deleted by a command that says it only
    // renames references. Excel refuses Apply Names rather than damaging a
    // formula, so this refuses too, and refuses the WHOLE command: a partially
    // applied rewrite is not a state the user asked for and not one they can
    // undo, since this command writes no undo entry.
    let mut parsed: Vec<(u32, u32, Box<parser::Expression>)> =
        Vec::with_capacity(modifications.len());
    for (row, col, original, new_formula) in &modifications {
        match parser::parse(new_formula) {
            Ok(ast) => parsed.push((*row, *col, Box::new(ast))),
            Err(e) => {
                let address = calcula_format::cell_ref::to_a1(*row, *col);
                crate::log_error!(
                    "NAMES",
                    "apply_names refused at {}: `{}` -> `{}` ({})",
                    address,
                    original,
                    new_formula,
                    e
                );
                return Err(format!(
                    "Cannot apply names: the formula in {} would be rewritten to `={}`,                      which cannot be read back ({}). No formula was changed.",
                    address, new_formula, e
                ));
            }
        }
    }

    // Nothing to write: answer without touching the document. Minting the
    // effect here would mark a workbook modified for a command that changed no
    // cell in it.
    if parsed.is_empty() {
        return Ok(ApplyNamesResult {
            formulas_modified: 0,
            cells: Vec::new(),
        });
    }

    // Every gate has passed; from here this command commits.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut grid = grid.authorize(&effect);
    let mut updated_cells: Vec<CellData> = Vec::new();

    for (row, col, ast) in parsed {
        if let Some(cell) = grid.cells.get_mut(&(row, col)) {
            cell.ast = Some(ast);
        }
    }

    // Build CellData results for the frontend
    for (row, col, _, _) in &modifications {
        if let Some(cell_data) =
            get_cell_internal_with_merge(&grid, &styles, &merged_regions, *row, *col, &locale)
        {
            updated_cells.push(cell_data);
        }
    }

    // APPLY NAMES IS NOW A REPAIR TOOL, NOT THE WAY IN (D2). Entry keeps the
    // name, so this can no longer "double-apply": a formula that already reads
    // `RATE` has no `$D$5` text left for the replacer to match, which makes the
    // command idempotent by construction rather than by a guard.
    //
    // What it DOES still owe is the dependency edge. Every rewritten cell just
    // gained a name it did not have, and until `name_dependents` knows, a later
    // repoint of that name would leave exactly these cells stale — the defect
    // this whole change exists to remove. No recalculation is seeded: the name
    // and the reference it replaced denote the same cell, so no VALUE moved.
    //
    // Second lock phase, like every other rebuild call: `rebuild_all_dependencies`
    // takes the grid and the dependency maps itself.
    let modified = modifications.len() as u32;
    drop(locale);
    drop(merged_regions);
    drop(styles);
    drop(grid);
    if modified > 0 {
        crate::undo_commands::rebuild_all_dependencies(&state);
    }

    Ok(ApplyNamesResult {
        formulas_modified: modified,
        cells: updated_cells,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_names() {
        assert!(NamedRange::is_valid_name("SalesData"));
        assert!(NamedRange::is_valid_name("_private"));
        assert!(NamedRange::is_valid_name("Tax_Rate"));
        assert!(NamedRange::is_valid_name("Q1.Sales"));
        assert!(NamedRange::is_valid_name("Data2024"));
    }

    #[test]
    fn test_invalid_names() {
        assert!(!NamedRange::is_valid_name(""));
        assert!(!NamedRange::is_valid_name("123Data"));  // Starts with number
        assert!(!NamedRange::is_valid_name("A1"));       // Cell reference
        assert!(!NamedRange::is_valid_name("BC123"));    // Cell reference
        assert!(!NamedRange::is_valid_name("TRUE"));     // Reserved word
        assert!(!NamedRange::is_valid_name("false"));    // Reserved word
        assert!(!NamedRange::is_valid_name("Data@2024")); // Invalid character
    }

    /// Excel refuses every name that reads as a reference in EITHER notation
    /// [LIVE, Excel 16 build 20326, 2026-11-05,
    /// miscb-probe1..4.ps1: `Workbook.Names.Add(name, "=1")` per name]. Calcula
    /// accepted `C`, `R`, `RC`, `R1C1`, `R2C3` and every other R1C1 shape.
    #[test]
    fn names_that_read_as_r1c1_references_are_refused_as_excel_does() {
        let refused = [
            "C", "c", "R", "r", "RC", "rc", "Rc", "R1C1", "r1c1", "R2C3", "R1", "C1", "RC1", "R1C",
            "R1048576C16384", "R1C16385", "R1C99999999", "R1C1A", "R1C1R1C1",
            "R1x", "R5abc", "R5_", "C5x", "C5_", "RC1x", "RC1_", "R1Cx", "R1C_", "RC16384x", "R5C0",
            "R5C0x", "R1048576", "R1048576x", "R01", "R01C01", "RC01", "R1C0", "C16384x", "r1C",
            "R1CC", "RC1C", "R1R", "C1C", "C1R", "R1C1.", "R1C1.x", "R1C.X", "R1C1.A",
            // A1 cells and the constants.
            "A1", "a1", "XFD1048576", "A01", "A001", "Q1", "xR1", "TRUE", "False", "true",
        ];
        for name in refused {
            assert!(!NamedRange::is_valid_name(name), "Excel refuses the name {:?}", name);
        }
        assert_excels_accepted_names();
    }

    /// Lotus-style ranges: an A1 cell, periods, an A1 cell [LIVE, as above].
    #[test]
    fn names_that_read_as_dotted_ranges_are_refused_as_excel_does() {
        let dotted = [
            "A1.B1", "A1..B1", "A1.B1.C1", "A1.B1.x", "a1.b1", "AB1.CD2", "R1.A1", "A1.A1",
            "XFD1048576.A1", "A01.B01", "R1.C1", "R5.C1",
        ];
        for name in dotted {
            assert!(!NamedRange::is_valid_name(name), "Excel refuses the dotted range name {:?}", name);
        }
        assert_excels_accepted_names();
    }

    /// Names Excel ACCEPTS that look close to a reference [LIVE, as above].
    fn assert_excels_accepted_names() {
        let accepted = [
            "R0C0", "R0", "C0", "RC0", "R0C", "R1048577C1", "R1048577", "R99999999C1", "R10485760",
            "RCX", "RC_", "R_1", "CR", "RR", "CC", "_R1C1", "RC.", "C.", "R.", "_C", "C_", "Rr", "RCC",
            "RCR", "Cr", "R5.", "R0C5", "RC0x", "C0x", "R00", "C1048577", "C99999999", "C16385x",
            "C20000x", "RC16385x", "RC1048577", "R1.", "R1.x", "R1.A", "RC1.", "RC1.x", "C1.",
            "C5.x", "R.C1", "x.R1C1", "x.R1", "R0.C1", "RC.C1", "R1.1", "R1._", "RC1.C", "C1.C",
            "R5.5", "x.R1.y", "R1.C1x", "R1048577.C1", "C0.C1", "R1048576.", "C16384.x",
            "A1.R1C1", "x.A1.B1", "A1.B1x", "XFE1.A1", "A1.XFE1", "A0.A1", "A1.B", "A1B", "A1_",
            "XFE1", "A0", "A1048577", "XFD1048577", "AAAA1", "XFD1x", "Null", "NULL", "null",
            "TRUE.x", "x.TRUE", "\u{df}1", "\u{df}", "Q1.Sales", "Data2024", "N", "A", "Z", "x", "_",
        ];
        for name in accepted {
            assert!(NamedRange::is_valid_name(name), "Excel accepts the name {:?}", name);
        }
    }

    /// 255 characters is Excel's longest name; 256 is refused [LIVE].
    #[test]
    fn a_defined_name_is_at_most_255_characters() {
        assert!(NamedRange::is_valid_name(&"a".repeat(255)));
        assert!(!NamedRange::is_valid_name(&"a".repeat(256)));
    }

    /// The create and rename doors both answer with the same rule.
    #[test]
    fn creating_or_renaming_to_an_r1c1_shaped_name_is_refused_and_leaves_the_document_clean() {
        let state = crate::create_app_state();
        let file = FileState::default();
        let refused = create_named_range_impl(&state, &file, "R1C1".to_string(), None, "=1".to_string(), None, None);
        assert!(!refused.success, "R1C1 was defined");
        assert!(!file.is_dirty(), "a refused name dirtied the document");
        let made = create_named_range_impl(&state, &file, "Rate".to_string(), None, "=1".to_string(), None, None);
        assert!(made.success, "positive control: {:?}", made.error);
        let renamed = rename_named_range_impl(&state, &file, "Rate", "RC");
        assert!(!renamed.success, "Rate was renamed to RC");
        assert!(state.named_ranges.read().unwrap().values().any(|n| n.name == "Rate"));
    }

    #[test]
    fn test_cell_reference_detection() {
        assert!(NamedRange::looks_like_cell_reference("A1"));
        assert!(NamedRange::looks_like_cell_reference("BC123"));
        assert!(NamedRange::looks_like_cell_reference("XFD1048576"));
        assert!(!NamedRange::looks_like_cell_reference("SalesData"));
        assert!(!NamedRange::looks_like_cell_reference("A"));
        assert!(!NamedRange::looks_like_cell_reference("1"));
    }

    /// A long alphabetic run followed by digits used to overflow `u32` in the
    /// column accumulator before the 16384 ceiling was ever compared. In a debug
    /// build that panics, and this is reached from a `#[tauri::command]` on a
    /// thread that cannot unwind — so it ABORTED THE WHOLE APPLICATION instead of
    /// answering "no". It was found live, as a crash mid-E2E-run.
    ///
    /// 7 letters is already past `u32::MAX` (26^7 = 8.03e9), and the loop is
    /// exercised well beyond that here.
    #[test]
    fn a_long_letter_run_is_rejected_rather_than_overflowing_the_column_accumulator() {
        for name in [
            "ABCDEFG1",
            "ABCDEFGHIJKLMNOP1",
            "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ999",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1",
        ] {
            assert!(
                !NamedRange::looks_like_cell_reference(name),
                "{} is past column XFD and must be refused, not panic",
                name
            );
            // ...and it is therefore a legal NAME, which is the question the
            // caller was actually asking.
            assert!(NamedRange::is_valid_name(name), "{} should be a usable name", name);
        }
    }

    /// The ceiling is a boundary, not a blanket refusal of long names: the last
    /// real column and the first one past it must land on opposite sides.
    #[test]
    fn the_column_ceiling_is_exact() {
        assert!(NamedRange::looks_like_cell_reference("XFD1"), "XFD = 16384 is the last column");
        assert!(!NamedRange::looks_like_cell_reference("XFE1"), "XFE = 16385 is past it");
    }

    /// rev10C: a script's `names.Rate` resolved its sheet ASCII-only and FELL
    /// BACK to the scope sheet, or sheet 0, when the prefix matched nothing --
    /// so a name defined as `='ärende'!$B$1` beside the tab `Ärende` read and
    /// wrote `Sheet1!B1` with no error. The prefix is matched by Excel's case
    /// rule now, and a prefix naming no sheet is refused.
    #[test]
    fn a_name_resolves_its_sheet_by_excels_case_rule_and_refuses_an_unknown_one() {
        let sheets = vec!["Sheet1".to_string(), "\u{c4}rende".to_string()];
        let named = |refers_to: &str, scope: Option<usize>| NamedRange {
            name: "Rate".to_string(),
            sheet_index: scope,
            refers_to: refers_to.to_string(),
            comment: None,
            folder: None,
        };

        let c = named_range_coords_in(&sheets, &named("='\u{e4}rende'!$B$1", None), "Rate")
            .expect("ärende is the sheet Ärende by Excel's case rule");
        assert_eq!(
            (c.sheet_index, c.start_row, c.start_col),
            (1, 0, 1),
            "='ärende'!$B$1 is Ärende!B1, not Sheet1!B1"
        );
        let c = named_range_coords_in(&sheets, &named("='\u{c4}RENDE'!$A$1:$B$2", None), "Rate")
            .expect("the uppercased spelling is the same sheet");
        assert_eq!(c.sheet_index, 1);
        let c = named_range_coords_in(&sheets, &named("=sheet1!$A$1", Some(1)), "Rate")
            .expect("an ASCII case variant is the same sheet");
        assert_eq!(c.sheet_index, 0, "the prefix wins over the scope");

        // A prefix naming no sheet -- even with a scope that would have caught
        // it -- is refused, never sent to another sheet.
        for scope in [None, Some(0)] {
            let err = named_range_coords_in(&sheets, &named("='Gone'!$B$1", scope), "Rate")
                .expect_err("a sheet that is not in the workbook must be refused");
            assert!(err.contains("'Gone'"), "the refusal names the missing sheet: {err}");
        }
        // No prefix at all: the name's scope, then sheet 0 (unchanged).
        assert_eq!(named_range_coords_in(&sheets, &named("=$C$3", Some(1)), "Rate").unwrap().sheet_index, 1);
        assert_eq!(named_range_coords_in(&sheets, &named("=$C$3", None), "Rate").unwrap().sheet_index, 0);
    }
}

/// RENAME — the key moves, the formulas follow it, and Ctrl+Z brings both back.
///
/// A separate module because it needs a whole `AppState` rather than the pure
/// name-validation helpers above. The `Workbook` harness the D2 tests use is
/// `pub(super)` inside `commands::data`, so it is not reachable from here; this
/// fixture is the same seeding recipe reduced to what a rename touches.
#[cfg(test)]
mod rename_tests {
    use super::*;
    use crate::document_effect::test_seed_effect;
    use crate::persistence::UserFilesState;
    use std::collections::HashMap;

    struct Fixture {
        state: AppState,
        file: FileState,
        files: UserFilesState,
        pivots: crate::pivot::PivotState,
        slicer: crate::slicer::SlicerState,
        pane: crate::pane_control::PaneControlState,
        timelines: crate::timeline_slicer::TimelineSlicerState,
        filters: crate::ribbon_filter::RibbonFilterState,
    }

    impl Fixture {
        /// `sheets` sheets named Sheet1..SheetN, sheet 0 active.
        fn new(sheets: usize) -> Self {
            let state = crate::create_app_state();
            for i in 1..sheets {
                state.grids.write(&test_seed_effect()).unwrap().push(engine::Grid::new());
                state
                    .sheet_names
                    .write(&test_seed_effect())
                    .unwrap()
                    .push(format!("Sheet{}", i + 1));
                state.all_column_widths.write(&test_seed_effect()).unwrap().push(HashMap::new());
                state.all_row_heights.write(&test_seed_effect()).unwrap().push(HashMap::new());
                state.all_user_hidden_rows.write(&test_seed_effect()).unwrap().push(HashSet::new());
                state.all_user_hidden_cols.write(&test_seed_effect()).unwrap().push(HashSet::new());
                state
                    .sheet_ids
                    .write(&test_seed_effect())
                    .unwrap()
                    .push(identity::SheetId::from_bytes(identity::generate_uuid_v7()));
            }
            {
                let mut all = state.all_merged_regions.write(&test_seed_effect()).unwrap();
                while all.len() < sheets {
                    all.push(HashSet::new());
                }
            }
            Fixture {
                state,
                file: FileState::default(),
                files: UserFilesState::default(),
                pivots: crate::pivot::PivotState::new(),
                slicer: crate::slicer::SlicerState::new(),
                pane: crate::pane_control::PaneControlState::new(),
                timelines: crate::timeline_slicer::TimelineSlicerState::new(),
                filters: crate::ribbon_filter::RibbonFilterState::new(),
            }
        }

        fn define(&self, name: &str, refers_to: &str, scope: Option<usize>) {
            self.state.named_ranges.write(&test_seed_effect()).unwrap().insert(
                identity::defined_name_key(name),
                NamedRange {
                    name: name.to_string(),
                    sheet_index: scope,
                    refers_to: refers_to.to_string(),
                    comment: None,
                    folder: None,
                },
            );
        }

        /// Claim a name in the TABLE registry. Only the name matters here: the
        /// gate under test asks `table_names`, not `tables`.
        fn declare_table(&self, name: &str) {
            self.state.table_names.write(&test_seed_effect()).unwrap().insert(
                crate::tables::table_name_key(name),
                (0, identity::EntityId::from_bytes(identity::generate_uuid_v7())),
            );
        }

        /// Put a formula cell straight into a sheet, the way a load does — no
        /// undo entry and no cascade, so what a test asserts afterwards is the
        /// rename's own work.
        fn put_formula(&self, sheet: usize, row: u32, col: u32, formula: &str) {
            let ast = parser::parse(formula).expect("test formula parses");
            let cell = engine::Cell::new_formula_with_ast(ast);
            let active = *self.state.active_sheet.read().unwrap();
            self.state.grids.write(&test_seed_effect()).unwrap()[sheet]
                .set_cell(row, col, cell.clone());
            if sheet == active {
                self.state.grid.write(&test_seed_effect()).unwrap().set_cell(row, col, cell);
            }
        }

        /// The formula the FORMULA BAR would show — rendered from the stored
        /// AST, exactly as `CellData::formula` is. A cell has no separate text
        /// field, so this IS the stored form.
        fn formula(&self, sheet: usize, row: u32, col: u32) -> String {
            let active = *self.state.active_sheet.read().unwrap();
            let cell = if sheet == active {
                self.state.grid.read().unwrap().get_cell(row, col).cloned()
            } else {
                self.state.grids.read().unwrap()[sheet].get_cell(row, col).cloned()
            };
            cell.and_then(|c| c.formula_string()).unwrap_or_default()
        }

        fn rename(&self, old: &str, new: &str) -> NamedRangeResult {
            rename_named_range_impl(&self.state, &self.file, old, new)
        }

        fn name_keys(&self) -> Vec<String> {
            let mut keys: Vec<String> =
                self.state.named_ranges.read().unwrap().keys().cloned().collect();
            keys.sort();
            keys
        }

        fn spelling(&self, key: &str) -> Option<String> {
            self.state.named_ranges.read().unwrap().get(key).map(|n| n.name.clone())
        }

        fn refers_to(&self, key: &str) -> Option<String> {
            self.state.named_ranges.read().unwrap().get(key).map(|n| n.refers_to.clone())
        }

        fn undo_depth(&self) -> usize {
            self.state.undo_stack.lock().unwrap().undo_depth()
        }

        fn undo(&self) {
            let transaction = self
                .state
                .undo_stack
                .lock()
                .unwrap()
                .pop_undo()
                .expect("nothing on the undo stack");
            let _ = crate::undo_commands::apply_changes(
                &self.state,
                &self.file,
                &self.files,
                &self.pivots,
                &self.slicer,
                &self.filters,
                &self.pane,
                &self.timelines,
                transaction,
                true,
            );
        }
    }

    // -----------------------------------------------------------------------
    // 1. The repoint — the whole point
    // -----------------------------------------------------------------------

    #[test]
    fn a_rename_repoints_a_formula_on_another_sheet() {
        let f = Fixture::new(2);
        f.define("RATE", "=$D$5", None);
        f.put_formula(0, 0, 0, "=RATE*100"); // the active sheet
        f.put_formula(1, 2, 1, "=RATE*200"); // Sheet2

        let result = f.rename("RATE", "Fee");
        assert!(result.success, "{:?}", result.error);

        assert_eq!(f.formula(0, 0, 0), "Fee*100");
        assert_eq!(
            f.formula(1, 2, 1),
            "Fee*200",
            "a workbook-scoped name reaches every sheet, so the repoint must \
             too — the off-sheet reader is exactly the cell that used to come \
             back #NAME? with nothing in the document saying why"
        );
        assert_eq!(f.name_keys(), vec!["FEE".to_string()]);
    }

    #[test]
    fn a_shadowed_let_parameter_is_not_repointed() {
        let f = Fixture::new(1);
        f.define("RATE", "=$D$5", None);
        f.put_formula(0, 0, 0, "=LET(rate, 2, rate*10)");
        f.put_formula(0, 1, 0, "=RATE*10");

        assert!(f.rename("RATE", "Fee").success);

        assert_eq!(
            f.formula(0, 0, 0),
            // The LET name keeps its declared spelling (lane formd).
            "LET(rate,2,rate*10)",
            "the binding is a LOCAL that shadows the workbook name during \
             evaluation; rewriting it would change what the formula COMPUTES, \
             not merely how it reads"
        );
        assert_eq!(f.formula(0, 1, 0), "Fee*10", "...and the real reader still moves");
    }

    #[test]
    fn a_sheet_scoped_rename_leaves_the_other_sheets_alone() {
        let f = Fixture::new(2);
        f.define("LOCAL", "=Sheet2!$A$5", Some(1));
        f.put_formula(1, 0, 0, "=LOCAL*2"); // in scope
        f.put_formula(0, 0, 0, "=LOCAL*3"); // out of scope: already a #NAME? cell

        assert!(f.rename("LOCAL", "Fee").success);

        assert_eq!(f.formula(1, 0, 0), "Fee*2");
        assert_eq!(
            f.formula(0, 0, 0),
            "LOCAL*3",
            "a sheet-scoped name is invisible from another sheet, so this \
             reference never denoted it — rewriting it would dress a #NAME? up \
             as a live reference to a name it never read"
        );
    }

    #[test]
    fn a_rename_repoints_another_names_definition() {
        let f = Fixture::new(1);
        f.define("BASE", "=$D$5", None);
        f.define("DOUBLED", "=BASE*2", None);

        assert!(f.rename("BASE", "Foundation").success);

        assert_eq!(
            f.refers_to("DOUBLED").as_deref(),
            Some("=Foundation*2"),
            "a name defined in terms of the renamed one breaks exactly the way a \
             cell does, and its readers never mentioned BASE at all"
        );
    }

    // -----------------------------------------------------------------------
    // 2. A case-only change is a re-spelling, not a move
    // -----------------------------------------------------------------------

    #[test]
    fn a_case_only_rename_does_not_move_the_registry_key() {
        let f = Fixture::new(1);
        f.define("total", "=$A$1", None);
        f.put_formula(0, 0, 1, "=TOTAL*2");

        assert!(f.rename("total", "Total").success);

        assert_eq!(
            f.name_keys(),
            vec!["TOTAL".to_string()],
            "the registry is UPPERCASE-keyed, so a case-only rename re-spells the \
             entry in place — moving the key would drop the name and define a new one"
        );
        assert_eq!(f.spelling("TOTAL").as_deref(), Some("Total"));
        assert_eq!(
            f.formula(0, 0, 1),
            "Total*2",
            "...and the references are re-spelled with it, which is what the \
             formula bar shows"
        );
    }

    #[test]
    fn renaming_a_name_to_exactly_what_it_is_called_changes_nothing() {
        let f = Fixture::new(1);
        f.define("Total", "=$A$1", None);

        assert!(f.rename("Total", "Total").success);
        assert!(
            !f.file.is_dirty(),
            "a command that changes nothing must not mark the workbook modified"
        );
        assert_eq!(f.undo_depth(), 0, "...and must not push an undo entry either");
    }

    // -----------------------------------------------------------------------
    // 3. The gates
    // -----------------------------------------------------------------------

    #[test]
    fn a_rename_that_would_shadow_a_table_is_refused() {
        let f = Fixture::new(1);
        f.define("RATE", "=$D$5", None);
        f.put_formula(0, 0, 0, "=RATE*100");
        f.declare_table("Sales");

        let result = f.rename("RATE", "Sales");

        assert!(!result.success, "names and tables share ONE formula namespace");
        assert!(
            result.error.unwrap_or_default().contains("table"),
            "the refusal has to say WHY, or the user retypes the same name"
        );
        assert_eq!(f.name_keys(), vec!["RATE".to_string()], "the registry did not move");
        assert_eq!(f.formula(0, 0, 0), "RATE*100", "and no formula was rewritten");
        assert!(!f.file.is_dirty(), "a refusal leaves the document clean");
    }

    #[test]
    fn every_refusal_leaves_the_document_clean() {
        // `DocumentEffect::mutates` dirties AT CONSTRUCTION, so a command that
        // builds it before its gates marks a workbook modified for a rename that
        // never happened — the close prompt then lies in the other direction.
        let f = Fixture::new(1);
        f.define("RATE", "=$D$5", None);
        f.define("FEE", "=$D$6", None);

        for (old, new, why) in [
            ("RATE", "1Total", "not a legal name"),
            ("NOPE", "Fee2", "the old name does not exist"),
            ("RATE", "Fee", "the new name is taken"),
        ] {
            let result = f.rename(old, new);
            assert!(!result.success, "rename {} -> {} should refuse ({})", old, new, why);
            assert!(
                !f.file.is_dirty(),
                "refusing `{}` still dirtied the workbook",
                why
            );
        }
        assert_eq!(f.name_keys(), vec!["FEE".to_string(), "RATE".to_string()]);
    }

    #[test]
    fn a_successful_rename_marks_the_workbook_dirty() {
        let f = Fixture::new(1);
        f.define("RATE", "=$D$5", None);
        assert!(!f.file.is_dirty(), "a fresh document starts clean");

        assert!(f.rename("RATE", "Fee").success);
        assert!(
            f.file.is_dirty(),
            "a rename changes saved state; without the flag the close prompt \
             never appears and AutoRecover refuses to snapshot it"
        );
    }

    // -----------------------------------------------------------------------
    // 4. Undo — one step, both halves
    // -----------------------------------------------------------------------

    #[test]
    fn undo_restores_the_old_name_and_the_formulas_together() {
        let f = Fixture::new(2);
        f.define("RATE", "=$D$5", None);
        f.define("DOUBLED", "=RATE*2", None);
        f.put_formula(0, 0, 0, "=RATE*100");
        f.put_formula(1, 2, 1, "=RATE*200");

        assert!(f.rename("RATE", "Fee").success);
        assert_eq!(
            f.undo_depth(),
            1,
            "the registry move and the rewritten formulas are ONE step — a \
             rename that undoes halfway puts the old name back while every \
             formula still says the new one, which is #NAME? everywhere"
        );

        f.undo();

        assert_eq!(f.name_keys(), vec!["DOUBLED".to_string(), "RATE".to_string()]);
        assert_eq!(f.spelling("RATE").as_deref(), Some("RATE"));
        assert_eq!(f.refers_to("DOUBLED").as_deref(), Some("=RATE*2"));
        assert_eq!(f.formula(0, 0, 0), "RATE*100");
        assert_eq!(
            f.formula(1, 2, 1),
            "RATE*200",
            "the off-sheet reader comes back too — it is recorded against the \
             sheet it lives on, not the one in front of the user"
        );
    }

    fn named_range_script(id: &str, instance: &str) -> persistence::SavedObjectScript {
        persistence::SavedObjectScript {
            id: id.to_string(),
            name: format!("Script for {}", instance),
            object_type: persistence::ScriptableObjectType::NamedRange,
            instance_id: Some(instance.to_string()),
            source: "// @capability bi.query\nexport function onChange() {}\n".to_string(),
            access_level: persistence::ScriptAccessLevel::Restricted,
            description: None,
            provenance: persistence::ScriptProvenance::Local,
            package_name: None,
            package_version: None,
            declared_capabilities: vec!["bi.query".to_string()],
        }
    }

    fn binding_of(f: &Fixture, id: &str) -> Option<String> {
        f.state
            .object_scripts
            .read()
            .unwrap()
            .iter()
            .find(|s| s.id == id)
            .and_then(|s| s.instance_id.clone())
    }

    /// A named-range script is bound by the name's TEXT. The Name Manager's
    /// rename (and the command line's: both run `rename_named_range`) moved the
    /// key and repointed the formulas but never touched the script store, so a
    /// script attached to `Rate` was orphaned by a rename to `Tax` -- bound to a
    /// name the workbook no longer had, while Edit Script on `Tax` scaffolded a
    /// new, empty one. The rename now re-points it, case-insensitively and only
    /// for NamedRange scripts of THAT name, inside its one "Rename name" step:
    /// one Ctrl+Z puts the name and the binding back together, and redo moves
    /// both again.
    ///
    /// SABOTAGE: drop the `repoint_named_range_scripts` call from
    /// `rename_named_range_impl` -- the script stays on "rate" and the first
    /// assertion fails. Or drop the script record (`obj_object_scripts_by_id`)
    /// from `record_rename_undo` -- the undo leaves the script on "Tax".
    #[test]
    fn a_rename_carries_the_names_scripts_and_one_undo_puts_both_back() {
        let f = Fixture::new(1);
        f.define("Rate", "=$D$5", None);
        f.put_formula(0, 0, 0, "=Rate*2");
        {
            let mut scripts = f.state.object_scripts.write(&test_seed_effect()).unwrap();
            // Bound in another case: the Name Manager keys by the name as typed.
            scripts.push(named_range_script("s-rate", "rate"));
            scripts.push(named_range_script("s-other", "OtherName"));
            let mut chart_script = named_range_script("s-chart", "Rate");
            chart_script.object_type = persistence::ScriptableObjectType::Chart;
            scripts.push(chart_script);
        }

        // The Name Manager's own command body.
        let result = rename_named_range_core(
            &f.state, &f.file, &f.files, &f.pivots, &f.pane, &f.filters, "Rate", "Tax",
        );
        assert!(result.success, "{:?}", result.error);

        assert_eq!(binding_of(&f, "s-rate").as_deref(), Some("Tax"), "the name's script follows the rename");
        assert_eq!(binding_of(&f, "s-other").as_deref(), Some("OtherName"), "another name's script is untouched");
        assert_eq!(
            binding_of(&f, "s-chart").as_deref(),
            Some("Rate"),
            "a script of another object type is untouched, whatever its id says"
        );
        {
            let scripts = f.state.object_scripts.read().unwrap();
            assert_eq!(scripts.len(), 3, "nothing lost, nothing duplicated");
            let carried = scripts.iter().find(|s| s.id == "s-rate").unwrap();
            assert_eq!(carried.declared_capabilities, vec!["bi.query".to_string()], "only the binding moves");
            assert_eq!(carried.provenance, persistence::ScriptProvenance::Local);
        }
        assert_eq!(f.undo_depth(), 1, "the name, its readers and its script are ONE step");

        f.undo();
        assert_eq!(f.spelling("RATE").as_deref(), Some("Rate"));
        assert_eq!(
            binding_of(&f, "s-rate").as_deref(),
            Some("rate"),
            "one Ctrl+Z puts the binding back with the name -- undone halfway, the script is orphaned again"
        );

        let redo = f.state.undo_stack.lock().unwrap().pop_redo().expect("the undo left a redo step");
        let _ = crate::undo_commands::apply_changes(
            &f.state, &f.file, &f.files, &f.pivots, &f.slicer, &f.filters, &f.pane, &f.timelines, redo, false,
        );
        assert_eq!(f.spelling("TAX").as_deref(), Some("Tax"));
        assert_eq!(binding_of(&f, "s-rate").as_deref(), Some("Tax"), "redo moves the binding again");
    }

    /// A persisted job of the name's script, as the `.cala` carries it.
    fn job_def(id: &str, script: &str, instance: &str, handler: &str) -> calcula_format::features::scheduled_jobs::ScheduledJobDef {
        calcula_format::features::scheduled_jobs::ScheduledJobDef {
            id: id.to_string(),
            script_id: script.to_string(),
            script_hash: "h".to_string(),
            surface: "object-script".to_string(),
            object_type: "namedRange".to_string(),
            instance_id: Some(instance.to_string()),
            handler: handler.to_string(),
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
        }
    }

    /// What a SAVE writes for each job: (job id, the binding it calls).
    fn saved_job_bindings(scripts: &[&str]) -> Vec<(String, Option<String>)> {
        let hashes: HashMap<String, String> = scripts.iter().map(|s| (s.to_string(), "h".to_string())).collect();
        let mut jobs: Vec<(String, Option<String>)> = crate::scripting::scheduler::export_jobs_for_workbook(&hashes)
            .into_iter()
            .map(|d| (d.id, d.instance_id))
            .collect();
        jobs.sort();
        jobs
    }

    /// A named-range script's SCHEDULED JOBS follow the rename (rev4B#1).
    /// A job calls the method the script exposed under its BINDING, and the
    /// rename re-bound the script but left the persisted job on the old name:
    /// after save and reopen the script exposed `refresh` under Tax while the
    /// job still called it under Rate, and every tick did nothing. The jobs
    /// now move in the same step, back on Ctrl+Z, forward again on redo.
    ///
    /// SABOTAGE: make `scheduler::rebind_jobs` match nothing -- the saved job
    /// still calls Rate after the rename. Drop the `rebind_script_jobs` call
    /// from the `obj_object_scripts_by_id` restore arm -- the undo leaves the
    /// jobs on Tax.
    #[test]
    fn a_rename_moves_the_scripts_scheduled_jobs_and_one_undo_moves_them_back() {
        let _jobs = crate::persistence::scheduler_test_guard();
        let f = Fixture::new(1);
        f.define("Rate", "=$D$5", None);
        {
            let mut scripts = f.state.object_scripts.write(&test_seed_effect()).unwrap();
            scripts.push(named_range_script("s-sched-rate", "Rate"));
            scripts.push(named_range_script("s-sched-other", "OtherName"));
        }
        let restored = crate::scripting::scheduler::import_jobs_for_workbook(
            vec![
                job_def("sched-1", "s-sched-rate", "Rate", "refresh"),
                job_def("sched-2", "s-sched-rate", "Rate", "snapshot"),
                job_def("sched-3", "s-sched-other", "OtherName", "refresh"),
            ],
            &["s-sched-rate", "s-sched-other"].iter().map(|s| (s.to_string(), "h".to_string())).collect(),
        );
        assert_eq!(restored.restored, 3, "the jobs are in the registry");

        let result = rename_named_range_core(
            &f.state, &f.file, &f.files, &f.pivots, &f.pane, &f.filters, "Rate", "Tax",
        );
        assert!(result.success, "{:?}", result.error);
        let tax = Some("Tax".to_string());
        let other = Some("OtherName".to_string());
        let rate = Some("Rate".to_string());
        assert_eq!(
            saved_job_bindings(&["s-sched-rate", "s-sched-other"]),
            vec![
                ("sched-1".to_string(), tax.clone()),
                ("sched-2".to_string(), tax.clone()),
                ("sched-3".to_string(), other.clone()),
            ],
            "the saved jobs call the method under the name the script is bound to now"
        );

        f.undo();
        assert_eq!(binding_of(&f, "s-sched-rate"), rate);
        assert_eq!(
            saved_job_bindings(&["s-sched-rate", "s-sched-other"]),
            vec![
                ("sched-1".to_string(), rate.clone()),
                ("sched-2".to_string(), rate.clone()),
                ("sched-3".to_string(), other.clone()),
            ],
            "one Ctrl+Z puts the jobs back on the name with the script"
        );

        redo(&f);
        assert_eq!(
            saved_job_bindings(&["s-sched-rate", "s-sched-other"]),
            vec![
                ("sched-1".to_string(), tax.clone()),
                ("sched-2".to_string(), tax),
                ("sched-3".to_string(), other),
            ],
            "redo moves the jobs again"
        );
        crate::scripting::scheduler::reset_jobs();
    }

    /// Every window is told that the rename, its undo and its redo moved the
    /// name's script (rev4B#2): an open editor saving afterwards used to write
    /// the old binding back, and the main window's live mount kept answering
    /// under the old name. Announced from the one rename every route runs, so
    /// the command line, the MCP tools and Ctrl+Z are covered too.
    ///
    /// SABOTAGE: drop the announcement from `rename_named_range_impl` -- the
    /// first announcement assertion fails. Since round 8 every "rebound" also
    /// carries the binding the script has NOW (rev6B#6: the main window
    /// re-keys the mount from it, with no read in between), so these
    /// assertions name it -- deliberately changed from `{ id, change }`.
    #[test]
    fn a_rename_and_its_undo_announce_the_rebind_to_every_window() {
        let f = Fixture::new(1);
        f.define("Rate", "=$D$5", None);
        {
            let mut scripts = f.state.object_scripts.write(&test_seed_effect()).unwrap();
            scripts.push(named_range_script("s-ann-rename", "Rate"));
            scripts.push(named_range_script("s-ann-bystander", "OtherName"));
        }
        let _ = crate::scripting::object_script_commands::take_object_script_announcements();
        let rebound = |id: &str, to: &str| crate::scripting::object_script_commands::ObjectScriptsChangedPayload {
            id: id.to_string(),
            change: "rebound".to_string(),
            instance_id: Some(Some(to.to_string())),
        };

        let result = rename_named_range_core(
            &f.state, &f.file, &f.files, &f.pivots, &f.pane, &f.filters, "Rate", "Tax",
        );
        assert!(result.success, "{:?}", result.error);
        assert_eq!(
            crate::scripting::object_script_commands::take_object_script_announcements(),
            vec![rebound("s-ann-rename", "Tax")],
            "every window is told the script moved, where, and only that script"
        );

        f.undo();
        assert_eq!(
            crate::scripting::object_script_commands::take_object_script_announcements(),
            vec![rebound("s-ann-rename", "Rate")],
            "the undo announces the move back"
        );

        redo(&f);
        assert_eq!(
            crate::scripting::object_script_commands::take_object_script_announcements(),
            vec![rebound("s-ann-rename", "Tax")],
            "the redo announces the move again"
        );
    }

    /// The delete twin of the announcement: the prune and its undo are told
    /// to every window too, so a status bar or an editor listing the script is
    /// not left showing a script the store no longer has (or lacking one it
    /// has again).
    ///
    /// SABOTAGE: drop the announcement loop from `delete_named_range_core` --
    /// the first announcement assertion fails.
    #[test]
    fn a_name_delete_and_its_undo_announce_the_scripts_they_moved() {
        let f = Fixture::new(1);
        f.define("Rate", "=$D$5", None);
        {
            let mut scripts = f.state.object_scripts.write(&test_seed_effect()).unwrap();
            scripts.push(named_range_script("s-ann-rate", "Rate"));
            scripts.push(named_range_script("s-ann-other", "OtherName"));
        }
        let _ = crate::scripting::object_script_commands::take_object_script_announcements();
        let change = |id: &str, change: &str| crate::scripting::object_script_commands::ObjectScriptsChangedPayload {
            id: id.to_string(),
            change: change.to_string(),
            instance_id: None,
        };

        let result = delete_named_range_core(
            &f.state, &f.file, &f.files, &f.pivots, &f.pane, &f.filters, "Rate".to_string(),
        );
        assert!(result.success, "{:?}", result.error);
        assert_eq!(
            crate::scripting::object_script_commands::take_object_script_announcements(),
            vec![change("s-ann-rate", "deleted")],
            "the prune is announced"
        );

        f.undo();
        assert_eq!(binding_of(&f, "s-ann-rate").as_deref(), Some("Rate"));
        assert_eq!(
            crate::scripting::object_script_commands::take_object_script_announcements(),
            vec![change("s-ann-rate", "saved")],
            "the undo announces the script it put back"
        );
    }

    /// Deleting a name prunes the scripts bound to it (C10), and its undo used
    /// to record the registry alone: Ctrl+Z brought the name back with its
    /// macro gone for good. The prune is now in the same "Delete name" step.
    ///
    /// SABOTAGE: drop the script record (`obj_object_scripts_by_id`) from
    /// `delete_named_range_core` -- the undo leaves the script deleted.
    #[test]
    fn undoing_a_name_delete_puts_its_scripts_back_too() {
        let f = Fixture::new(1);
        f.define("Rate", "=$D$5", None);
        {
            let mut scripts = f.state.object_scripts.write(&test_seed_effect()).unwrap();
            scripts.push(named_range_script("s-rate", "Rate"));
            scripts.push(named_range_script("s-other", "OtherName"));
        }
        let result = delete_named_range_core(
            &f.state, &f.file, &f.files, &f.pivots, &f.pane, &f.filters, "Rate".to_string(),
        );
        assert!(result.success, "{:?}", result.error);
        assert_eq!(binding_of(&f, "s-rate"), None, "the deleted name's script is pruned (C10)");
        assert_eq!(binding_of(&f, "s-other").as_deref(), Some("OtherName"));
        assert_eq!(f.undo_depth(), 1, "the name and its scripts are ONE step");

        f.undo();
        assert_eq!(f.spelling("RATE").as_deref(), Some("Rate"), "the name comes back");
        assert_eq!(
            binding_of(&f, "s-rate").as_deref(),
            Some("Rate"),
            "...and so does its script -- undone halfway, the macro was lost for good"
        );
        assert_eq!(f.state.object_scripts.read().unwrap().len(), 2, "nothing duplicated");
    }

    /// A rename of a name with NO script records no script snapshot and leaves
    /// the script store exactly as it was (a whole-list snapshot recorded for
    /// nothing would make the rename's undo rewind script edits it never made).
    #[test]
    fn a_rename_of_a_name_with_no_script_leaves_the_scripts_alone() {
        let f = Fixture::new(1);
        f.define("Rate", "=$D$5", None);
        f.state
            .object_scripts
            .write(&test_seed_effect())
            .unwrap()
            .push(named_range_script("s-other", "OtherName"));
        assert!(f.rename("Rate", "Tax").success);
        assert_eq!(binding_of(&f, "s-other").as_deref(), Some("OtherName"));
        let step = f.state.undo_stack.lock().unwrap().pop_undo().expect("the rename's step");
        // Either script kind: the by-id record the rename makes now, or the
        // whole-list snapshot it made before (2026-10-29).
        assert!(
            !step.changes.iter().any(|c| matches!(
                c,
                engine::CellChange::CustomRestore { kind, .. }
                    if kind == "obj_object_scripts" || kind == crate::undo_commands::OBJECT_SCRIPTS_BY_ID_RESTORE_KIND
            )),
            "no script record for a name no script is bound to"
        );
    }

    fn source_of(f: &Fixture, id: &str) -> Option<String> {
        f.state.object_scripts.read().unwrap().iter().find(|s| s.id == id).map(|s| s.source.clone())
    }

    /// A script SAVE through `save_object_script`'s own body past its window
    /// guard (`save_object_script_core`): edit in place (keeping the stored
    /// binding) or push -- and, like it, RECORD NO UNDO.
    fn save_script_without_undo(f: &Fixture, script: persistence::SavedObjectScript) {
        let data = crate::scripting::object_script_commands::ObjectScriptData {
            id: script.id,
            name: script.name,
            object_type: "namedRange".to_string(),
            instance_id: script.instance_id,
            source: script.source,
            access_level: "restricted".to_string(),
            description: script.description,
            provenance: None,
            package_name: None,
            package_version: None,
            declared_capabilities: Vec::new(),
        };
        crate::scripting::object_script_commands::save_object_script_core(&f.state, &f.file, &data)
            .expect("the save is accepted");
    }

    fn edited(id: &str, instance: &str, source: &str) -> persistence::SavedObjectScript {
        let mut script = named_range_script(id, instance);
        script.source = source.to_string();
        script
    }

    fn redo(f: &Fixture) {
        let redo = f.state.undo_stack.lock().unwrap().pop_redo().expect("the undo left a redo step");
        let _ = crate::undo_commands::apply_changes(
            &f.state, &f.file, &f.files, &f.pivots, &f.slicer, &f.filters, &f.pane, &f.timelines, redo, false,
        );
    }

    /// A script SAVE records no undo step, so the "Rename name" step's
    /// script record used to be a WHOLE-LIST snapshot of the store as the
    /// rename found it: undoing the rename after the user had edited ANOTHER
    /// script, edited the renamed name's own script, or created a new one put
    /// the whole list back -- the edits silently reverted and the new script
    /// deleted. Lost work, with nothing on screen saying so. The step now
    /// records only the BINDINGS it moved, by script id.
    ///
    /// SABOTAGE: record the whole-list `obj_object_scripts` snapshot in
    /// `record_rename_undo` again -- the edit assertions fail.
    #[test]
    fn undoing_a_rename_keeps_every_script_edit_made_after_it() {
        let f = Fixture::new(1);
        f.define("Rate", "=$D$5", None);
        {
            let mut scripts = f.state.object_scripts.write(&test_seed_effect()).unwrap();
            scripts.push(named_range_script("s-other", "OtherName"));
            scripts.push(named_range_script("s-rate", "Rate"));
        }
        let result = rename_named_range_core(
            &f.state, &f.file, &f.files, &f.pivots, &f.pane, &f.filters, "Rate", "Tax",
        );
        assert!(result.success, "{:?}", result.error);
        assert_eq!(binding_of(&f, "s-rate").as_deref(), Some("Tax"));

        // AFTER the rename the user edits two scripts and creates a third.
        save_script_without_undo(&f, edited("s-other", "OtherName", "// another name's script, edited later"));
        save_script_without_undo(&f, edited("s-rate", "Tax", "// the renamed name's own script, edited later"));
        save_script_without_undo(&f, named_range_script("s-new", "Fresh"));

        f.undo();
        assert_eq!(f.spelling("RATE").as_deref(), Some("Rate"), "the name comes back");
        assert_eq!(binding_of(&f, "s-rate").as_deref(), Some("Rate"), "...and its script's binding with it");
        assert_eq!(
            source_of(&f, "s-other").as_deref(),
            Some("// another name's script, edited later"),
            "undoing the rename reverted an edit to ANOTHER script it never touched -- lost work"
        );
        assert_eq!(
            source_of(&f, "s-rate").as_deref(),
            Some("// the renamed name's own script, edited later"),
            "the undo puts back the BINDING, not the source the script had at the rename"
        );
        assert_eq!(
            binding_of(&f, "s-new").as_deref(),
            Some("Fresh"),
            "undoing the rename deleted a script created after it -- lost work"
        );
        assert_eq!(f.state.object_scripts.read().unwrap().len(), 3, "nothing lost, nothing duplicated");

        redo(&f);
        assert_eq!(binding_of(&f, "s-rate").as_deref(), Some("Tax"), "redo moves the binding again");
        assert_eq!(source_of(&f, "s-other").as_deref(), Some("// another name's script, edited later"));
        assert_eq!(source_of(&f, "s-rate").as_deref(), Some("// the renamed name's own script, edited later"));
        assert_eq!(binding_of(&f, "s-new").as_deref(), Some("Fresh"));
    }

    /// The delete twin: the "Delete name" step's whole-list snapshot put the
    /// store back as the delete found it, so undoing the delete after the user
    /// had edited or created another script reverted or deleted it. The step
    /// now records only the scripts it PRUNED: the undo puts back exactly
    /// those, where they stood, and the redo prunes exactly those again.
    ///
    /// SABOTAGE: record the whole-list `obj_object_scripts` snapshot in
    /// `delete_named_range_core` again -- the edit assertions fail.
    #[test]
    fn undoing_a_name_delete_keeps_every_script_edit_made_after_it() {
        let f = Fixture::new(1);
        f.define("Rate", "=$D$5", None);
        {
            let mut scripts = f.state.object_scripts.write(&test_seed_effect()).unwrap();
            scripts.push(named_range_script("s-first", "First"));
            scripts.push(named_range_script("s-rate", "Rate"));
            scripts.push(named_range_script("s-other", "OtherName"));
        }
        let result = delete_named_range_core(
            &f.state, &f.file, &f.files, &f.pivots, &f.pane, &f.filters, "Rate".to_string(),
        );
        assert!(result.success, "{:?}", result.error);
        assert_eq!(binding_of(&f, "s-rate"), None, "the deleted name's script is pruned (C10)");

        save_script_without_undo(&f, edited("s-other", "OtherName", "// edited after the delete"));
        save_script_without_undo(&f, named_range_script("s-new", "Fresh"));

        f.undo();
        assert_eq!(f.spelling("RATE").as_deref(), Some("Rate"), "the name comes back");
        assert_eq!(binding_of(&f, "s-rate").as_deref(), Some("Rate"), "...and so does its script");
        assert_eq!(
            source_of(&f, "s-other").as_deref(),
            Some("// edited after the delete"),
            "undoing the delete reverted an edit to ANOTHER script -- lost work"
        );
        assert_eq!(
            binding_of(&f, "s-new").as_deref(),
            Some("Fresh"),
            "undoing the delete deleted a script created after it -- lost work"
        );
        let order: Vec<String> = f.state.object_scripts.read().unwrap().iter().map(|s| s.id.clone()).collect();
        assert_eq!(order, vec!["s-first", "s-rate", "s-other", "s-new"], "the script is back where it stood");

        redo(&f);
        assert_eq!(binding_of(&f, "s-rate"), None, "redo prunes the name's script again");
        assert_eq!(source_of(&f, "s-other").as_deref(), Some("// edited after the delete"));
        assert_eq!(binding_of(&f, "s-new").as_deref(), Some("Fresh"));
        assert_eq!(f.state.object_scripts.read().unwrap().len(), 3);
    }

    // -----------------------------------------------------------------------
    // 5. A refusal leaves the document clean
    // -----------------------------------------------------------------------

    /// Editing or deleting a name that does not exist is refused -- and used to
    /// dirty the workbook anyway, because both commands minted
    /// `DocumentEffect::mutates` (which dirties at construction) BEFORE their
    /// "does not exist" gate. The positive control proves the same calls do
    /// dirty it when they change something.
    ///
    /// SABOTAGE: mint the effect ahead of the gate in `update_named_range_core`
    /// again -- the refusal assertion fails.
    #[test]
    fn editing_a_name_that_does_not_exist_leaves_the_document_clean() {
        let f = Fixture::new(1);
        f.define("RATE", "=$D$5", None);

        let edited = update_named_range_core(
            &f.state, &f.file, &f.files, &f.pivots, &f.pane, &f.filters,
            "Nope".to_string(), None, "=$A$1".to_string(), None, None,
        );
        assert!(!edited.success, "an unknown name is refused");
        assert!(!f.file.is_dirty(), "a refused EDIT must leave the workbook clean");
        assert_eq!(f.undo_depth(), 0, "and records no undo step");

        // POSITIVE CONTROL: the same door dirties the workbook when it acts.
        let edited = update_named_range_core(
            &f.state, &f.file, &f.files, &f.pivots, &f.pane, &f.filters,
            "RATE".to_string(), None, "=$A$1".to_string(), None, None,
        );
        assert!(edited.success, "{:?}", edited.error);
        assert!(f.file.is_dirty(), "an edit that changes the name dirties the workbook");
        assert_eq!(f.refers_to("RATE").as_deref(), Some("=$A$1"));
        assert_eq!(f.undo_depth(), 1);
    }

    /// Defining a name that already exists is refused -- and used to dirty the
    /// workbook anyway: `create_named_range_impl` minted `DocumentEffect::mutates`
    /// (which dirties at construction) and THEN checked for the duplicate, so
    /// the close-without-saving prompt and AutoRecover fired for a command that
    /// changed nothing. The positive control proves the same door dirties it
    /// when it defines a name.
    ///
    /// SABOTAGE: mint the effect ahead of the duplicate check in
    /// `create_named_range_impl` again -- the refusal assertion fails.
    #[test]
    fn defining_a_name_that_already_exists_leaves_the_document_clean() {
        let f = Fixture::new(1);
        f.define("RATE", "=$D$5", None);

        let created = create_named_range_impl(&f.state, &f.file, "Rate".to_string(), None, "=$A$1".to_string(), None, None);
        assert!(!created.success, "a duplicate name is refused");
        assert!(!f.file.is_dirty(), "a refused DEFINE must leave the workbook clean");
        assert_eq!(f.undo_depth(), 0, "and records no undo step");
        assert_eq!(f.refers_to("RATE").as_deref(), Some("=$D$5"), "the existing name is untouched");

        // POSITIVE CONTROL.
        let created = create_named_range_impl(&f.state, &f.file, "Fee".to_string(), None, "=$A$1".to_string(), None, None);
        assert!(created.success, "{:?}", created.error);
        assert!(f.file.is_dirty(), "defining a new name dirties the workbook");
        assert_eq!(f.undo_depth(), 1);
    }

    /// The delete twin of `editing_a_name_that_does_not_exist_leaves_the_document_clean`.
    ///
    /// SABOTAGE: mint the effect ahead of the gate in `delete_named_range_core`
    /// again -- the refusal assertion fails.
    #[test]
    fn deleting_a_name_that_does_not_exist_leaves_the_document_clean() {
        let f = Fixture::new(1);
        f.define("RATE", "=$D$5", None);

        let deleted = delete_named_range_core(
            &f.state, &f.file, &f.files, &f.pivots, &f.pane, &f.filters, "Nope".to_string(),
        );
        assert!(!deleted.success, "an unknown name is refused");
        assert!(!f.file.is_dirty(), "a refused DELETE must leave the workbook clean");
        assert_eq!(f.undo_depth(), 0, "and records no undo step");

        // POSITIVE CONTROL.
        let deleted = delete_named_range_core(
            &f.state, &f.file, &f.files, &f.pivots, &f.pane, &f.filters, "RATE".to_string(),
        );
        assert!(deleted.success, "{:?}", deleted.error);
        assert!(f.file.is_dirty(), "a delete that removes the name dirties the workbook");
        assert!(f.name_keys().is_empty());
        assert_eq!(f.undo_depth(), 1);
    }
}
