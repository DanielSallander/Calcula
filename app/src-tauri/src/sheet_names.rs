//! FILENAME: app/src-tauri/src/sheet_names.rs
//! PURPOSE: ONE rule for what a sheet may be called, and one place that spells
//!          the refusal.
//!
//! CONTEXT (register F6 / §3bc, the product half). The serialiser half of F6 is
//! fixed: `ast_render::quote_sheet_name` wraps anything that is not
//! identifier-shaped in apostrophes and doubles the ones inside, so a formula
//! referring to `John's` or `Q1-2026` or `2026` now round-trips. That made those
//! names SAFE. It did not make every name legal, and nothing validated at entry:
//! `rename_sheet` refused an empty name and a duplicate spelled identically, and
//! accepted everything else — `[`, `]`, `*`, `?`, `/`, `\`, `:`, a leading
//! apostrophe, 400 characters, and `sheet1` beside an existing `Sheet1`.
//!
//! EXCEL DECIDES THE RULE, per the standing parity rule. Excel's Rename Sheet
//! refuses, with a message, when a name:
//!
//!   * is blank,
//!   * is longer than 31 characters,
//!   * contains any of `:` `\` `/` `?` `*` `[` `]`,
//!   * begins or ends with an apostrophe,
//!   * is `History` (reserved for the change-history sheet of a shared
//!     workbook), or
//!   * is already used by another sheet, compared WITHOUT REGARD TO CASE.
//!
//! Everything else Excel allows, and so does this — including `John's`,
//! `Q1-2026` and `2026`, the three names the hunt measured. They are legal in
//! Excel, they are quoted correctly by the renderer now, and refusing them would
//! be a divergence, not a fix.
//!
//! ENTRY REFUSES; LOAD ACCEPTS AND CARRIES. A workbook already on disk may hold
//! a name this rule rejects — one written before the rule existed, or one an
//! `.xlsx`/`.calp` publisher produced. Refusing it at load would mean refusing
//! to open the user's file, which trades a cosmetic problem for a total one.
//! Loading therefore accepts anything and only records what it saw
//! (`load_violation`); the next time the user renames that sheet, the rule
//! applies.
//!
//! GENERATED names never refuse: `sanitize_sheet_name` COERCES. A name the app
//! builds out of data (the pivot "Show Report Filter Pages" command names a
//! sheet after a field value) has no user to show a message to.

/// Excel's limit, in CHARACTERS — not bytes. `Résumé` is six.
pub const MAX_SHEET_NAME_CHARS: usize = 31;

/// The characters Excel forbids in a sheet name. `[` and `]` are the structured
/// -reference brackets, `:` the range operator, `'` is handled separately
/// (legal inside a name, illegal at either end).
pub const ILLEGAL_SHEET_NAME_CHARS: [char; 7] = [':', '\\', '/', '?', '*', '[', ']'];

/// Reserved by Excel for the change-history sheet of a shared workbook.
pub const RESERVED_SHEET_NAME: &str = "History";

/// Validate a name a USER typed. Returns the name to store -- exactly as
/// typed -- or the message to show them.
///
/// NOT TRIMMED (Excel parity). Excel keeps a leading or trailing space, and a
/// name of spaces only, through every door [LIVE, Excel 16, 2026-10-31,
/// protfill/probe2-3.ps1]: Home > Format > Rename Sheet typed ` Data ` names the
/// sheet ` Data ` (six characters) and typed two spaces names it `  `;
/// `Worksheet.Name` accepts ` 'x`, `x' ` and a leading tab; ` Data ` and `Data`
/// are two different sheets (` DATA ` beside ` Data ` is the duplicate); a
/// formula spells it `=' Data '!A1`; and Copy Sheet makes ` Data  (2)`. Only
/// the empty name is refused. This used to trim, so such a name could not be
/// typed and a copy of a loaded one lost its spaces.
pub fn validate_sheet_name(raw: &str) -> Result<String, String> {
    let name = raw;
    if name.is_empty() {
        return Err("Sheet name cannot be empty".to_string());
    }
    let length = name.chars().count();
    if length > MAX_SHEET_NAME_CHARS {
        return Err(format!(
            "Sheet name cannot be longer than {} characters (this one is {})",
            MAX_SHEET_NAME_CHARS, length
        ));
    }
    if let Some(bad) = name.chars().find(|c| ILLEGAL_SHEET_NAME_CHARS.contains(c)) {
        return Err(format!(
            "Sheet name cannot contain '{}' -- the characters : \\ / ? * [ ] are not allowed",
            bad
        ));
    }
    if name.starts_with('\'') || name.ends_with('\'') {
        return Err("Sheet name cannot begin or end with an apostrophe".to_string());
    }
    if identity::sheet_names_equal(name, RESERVED_SHEET_NAME) {
        return Err(format!(
            "\"{}\" is reserved and cannot be used as a sheet name",
            RESERVED_SHEET_NAME
        ));
    }
    Ok(name.to_string())
}

/// Refuse a name another sheet already has.
///
/// CASE-INSENSITIVELY, which is the half the old check got wrong: sheet lookup
/// is case-insensitive everywhere else in this crate (`index_of_sheet`, the
/// cross-sheet dependency keys, the rename's reference repair), so
/// allowing `sheet1` beside `Sheet1` created two sheets that every consumer
/// downstream believed were one. `ignore_index` is the sheet being renamed —
/// renaming `Data` to `Data` is not a collision with itself.
///
/// BY EXCEL'S CASE RULE, beyond ASCII and no further (rev6A#8, then the
/// sheet-name round). The comparison was first `eq_ignore_ascii_case`, so
/// `Ärende` and `ärende` could coexist, which Excel refuses [LIVE]; it then
/// became "uppercases alike" with Rust's FULL uppercasing, which also refused
/// `STRASSE` beside `Straße` (`ß` uppercases to `SS`) -- a pair Excel ACCEPTS
/// [LIVE] -- and still let `ß` stand beside `ẞ`, which Excel refuses. The rule
/// is now `identity::sheet_names_equal`, Excel's measured per-character case
/// equivalence (see `core/identity/src/sheet_name_case.rs` for the probe), and
/// every sheet-name lookup in the engine keys by the same rule
/// (`identity::sheet_name_key`), so two names this accepts are never one sheet
/// to a lookup.
pub fn ensure_sheet_name_is_free(
    name: &str,
    existing: &[String],
    ignore_index: Option<usize>,
) -> Result<(), String> {
    for (i, other) in existing.iter().enumerate() {
        if Some(i) == ignore_index {
            continue;
        }
        if identity::sheet_names_equal(other, name) {
            return Err(format!("Sheet '{}' already exists", other));
        }
    }
    Ok(())
}

/// Make a list of sheet names that came from a FILE unique by Excel's rule,
/// renaming in place. Returns `(index, old name, new name)` per rename.
///
/// A document can hold two names the rule calls one: a `.cala` saved while
/// the rule was ASCII-only (`Ärende` beside `ärende`), one saved while `ß` and
/// `ẞ` were allowed together, or a workbook a third-party writer produced.
/// Loading refuses nothing (module note), so the document opens -- but every
/// lookup keys by `identity::sheet_name_key`, and two sheets with one key
/// would leave one of them unreachable by name. So DETERMINISTICALLY: the
/// sheet with the LOWER tab index keeps its name, and each later one is
/// renamed the way Excel names a copy -- `ärende (2)`, `(3)`, ... -- with
/// `unique_sheet_name` against every name already settled. A formula that
/// pointed at the renamed sheet must follow it; `settle_loaded_sheet_names`
/// does that with `rename_grid_qualifiers_exactly`, which re-points only
/// qualifiers spelled EXACTLY (case-sensitively) as the renamed sheet was AND
/// in a spelling the lexer cannot have produced from a bare name -- the only
/// evidence of which of the two a formula meant. A bare ASCII qualifier is
/// stored uppercased whatever was typed, so it stays with the keeper.
pub fn dedupe_loaded_sheet_names(names: &mut [String]) -> Vec<(usize, String, String)> {
    let mut renames = Vec::new();
    for i in 1..names.len() {
        let clashes = names[..i].iter().any(|earlier| identity::sheet_names_equal(earlier, &names[i]));
        if !clashes {
            continue;
        }
        // Settled names: every earlier one, plus every later one (a later
        // sheet's own name must not be taken by this rename either).
        let others: Vec<String> = names
            .iter()
            .enumerate()
            .filter(|(j, _)| *j != i)
            .map(|(_, n)| n.clone())
            .collect();
        let old = names[i].clone();
        let new = unique_sheet_name(&old, &others);
        names[i] = new.clone();
        renames.push((i, old, new));
    }
    renames
}

/// The LOAD step `open_file` runs over a file's sheet names and grids (index
/// for index): `dedupe_loaded_sheet_names`, then every formula spelled exactly
/// as a renamed sheet was follows it. Returns the names to install. A file
/// whose names are already unique comes back untouched.
pub fn settle_loaded_sheet_names(mut names: Vec<String>, grids: &mut [engine::Grid]) -> Vec<String> {
    let renames = dedupe_loaded_sheet_names(&mut names);
    follow_loaded_renames_in_grids(&renames, grids);
    names
}

/// What the load-time rename did, for the ONE notice the user is given on
/// open (`load_rename_notice`).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct LoadedRenameReport {
    /// `(old name, new name)` per renamed sheet, in tab order.
    pub renamed: Vec<(String, String)>,
    /// Cell formulas that followed a renamed sheet.
    pub cell_formulas: usize,
    /// Every other reference that followed: defined names, chart sources,
    /// conditional formats, validations, page targets, pane dropdowns,
    /// slicer formulas, property bindings and pivot sheet names.
    pub other_references: usize,
}

/// The LOAD step `open_file` runs: [`settle_loaded_sheet_names`] over the
/// file's grids AND every other store of the file that names a sheet, BEFORE
/// any of them is installed. Returns the names to install and what moved.
///
/// The rename used to reach cell formulas only (it was a log line besides):
/// a defined name, a chart's source, a conditional format or validation, a
/// navigate button's page target, a pane dropdown, a slicer formula, a
/// property binding or a pivot spelled exactly as the renamed sheet kept the
/// OLD spelling -- which every lookup now resolves, by Excel's rule, to the
/// sheet that KEPT the name. So the cell `='ärende'!B1` read the renamed sheet
/// while the name `Rate` (`='ärende'!$B$1`) read the other one. Every kind now
/// follows by the same evidence (`calp::sheet_renames::SheetRenames::
/// exact_spelling`), and `workbook.sheets` carries the new names so a restore
/// that maps by name agrees.
pub fn settle_loaded_workbook_sheet_names(
    workbook: &mut persistence::Workbook,
    grids: &mut [engine::Grid],
) -> (Vec<String>, LoadedRenameReport) {
    let mut names: Vec<String> = workbook.sheets.iter().map(|s| s.name.clone()).collect();
    let renames = dedupe_loaded_sheet_names(&mut names);
    if renames.is_empty() {
        return (names, LoadedRenameReport::default());
    }
    let cell_formulas = follow_loaded_renames_in_grids(&renames, grids);
    let other_references = follow_loaded_renames_in_workbook(workbook, &renames);
    for (index, _, new) in &renames {
        if let Some(sheet) = workbook.sheets.get_mut(*index) {
            sheet.name = new.clone();
        }
    }
    let report = LoadedRenameReport {
        renamed: renames.iter().map(|(_, old, new)| (old.clone(), new.clone())).collect(),
        cell_formulas,
        other_references,
    };
    (names, report)
}

/// Every NON-GRID reference in `workbook` spelled exactly as a renamed sheet
/// was follows it (see [`settle_loaded_workbook_sheet_names`]). Returns how
/// many references changed.
pub fn follow_loaded_renames_in_workbook(
    workbook: &mut persistence::Workbook,
    renames: &[(usize, String, String)],
) -> usize {
    let set = calp::sheet_renames::SheetRenames::exact_spelling(
        renames.iter().map(|(_, old, new)| (old.as_str(), new.as_str())),
    );
    if set.is_empty() {
        return 0;
    }
    let mut changed = 0usize;
    for nr in workbook.named_ranges.iter_mut() {
        if let Some(renamed) = set.rename_formula(&nr.refers_to) {
            nr.refers_to = renamed;
            changed += 1;
        }
    }
    for chart in workbook.charts.iter_mut() {
        if calp::chart_refs::rename_chart_spec_sheet_names(&mut chart.spec, &set) {
            changed += 1;
        }
    }
    let rules = set.rename_pulled_rules(calp::sheet_renames::PulledRules {
        conditional_formats: &mut workbook.conditional_formats,
        data_validations: &mut workbook.data_validations,
        controls: &mut workbook.controls,
        pane_controls: &mut workbook.pane_controls,
    });
    changed += rules.conditional_formats + rules.data_validations + rules.controls + rules.pane_controls;
    changed += set.rename_slicer_formulas(&mut workbook.slicers);
    changed += set.rename_binding_formulas(&mut workbook.object_bindings);
    // A pivot names its destination and source sheets as plain strings in its
    // saved definition (`PivotDefinition.destination_sheet` / `source_sheet`,
    // snake_case on disk). Raw strings keep their case, so the exact spelling
    // is evidence here as it is for a chart source.
    for saved in workbook.pivot_definitions.iter_mut() {
        for field in ["destination_sheet", "source_sheet"] {
            if let Some(serde_json::Value::String(name)) = saved.definition.get_mut(field) {
                if let Some(to) = set.target(name) {
                    *name = to.to_string();
                    changed += 1;
                }
            }
        }
    }
    changed
}

/// The one non-blocking notice `open_file` gives when it renamed a sheet on
/// load, or `None` when it renamed none.
pub fn load_rename_notice(report: &LoadedRenameReport) -> Option<String> {
    if report.renamed.is_empty() {
        return None;
    }
    let pairs: Vec<String> =
        report.renamed.iter().map(|(old, new)| format!("'{}' is now '{}'", old, new)).collect();
    Some(format!(
        "This workbook had sheets whose names Excel treats as the same name, so {} renamed on open: {}. \
         References spelled exactly as the renamed sheet followed it ({} formula(s), {} other reference(s)).",
        if report.renamed.len() == 1 { "one was" } else { "some were" },
        pairs.join("; "),
        report.cell_formulas,
        report.other_references
    ))
}

/// The grid half of the load-time rename. Returns how many formulas followed.
fn follow_loaded_renames_in_grids(renames: &[(usize, String, String)], grids: &mut [engine::Grid]) -> usize {
    let mut total = 0usize;
    for (index, old, new) in renames {
        let followed: usize = grids
            .iter_mut()
            .map(|g| rename_grid_qualifiers_exactly(g, old, new))
            .sum();
        crate::log_warn!(
            "LOAD",
            "sheet {} '{}' shares its name with an earlier sheet by Excel's case rule; \
             renamed to '{}' ({} formula(s) spelled exactly '{}' follow it)",
            index,
            old,
            new,
            followed,
            old
        );
        total += followed;
    }
    total
}

/// COERCE an arbitrary string into a legal sheet name. Never fails.
///
/// For names the app GENERATES rather than accepts — the pivot "Show Report
/// Filter Pages" command builds one per field value, and a field value can be
/// anything at all. Illegal characters become `_`, the result is cut to the
/// length limit and loses any apostrophe at either end, and a name that
/// coerces away to nothing becomes `Sheet`. Spaces are KEPT, at the ends too:
/// they are legal in Excel (see `validate_sheet_name`), and `unique_sheet_name`
/// builds a COPY's name from the source sheet's through here -- Excel copies
/// ` Data ` as ` Data  (2)` [LIVE].
///
/// THE RESULT IS ALWAYS A NAME `validate_sheet_name` ACCEPTS, unchanged -- the
/// promise every caller builds on (Show Report Filter Pages plans its pages
/// out of these names and the add path then validates them again).
pub fn sanitize_sheet_name(raw: &str) -> String {
    let replaced: String = raw
        .chars()
        .map(|c| if ILLEGAL_SHEET_NAME_CHARS.contains(&c) { '_' } else { c })
        .collect();
    // Truncate FIRST, then strip: cutting at 31 characters can leave a
    // trailing apostrophe that the strip below has to remove.
    let truncated: String = replaced.chars().take(MAX_SHEET_NAME_CHARS).collect();
    // Only APOSTROPHES at the very ends are illegal; spaces are not, so one
    // strip of apostrophes leaves a name with none at either end (`' 'x`
    // becomes ` 'x`, which Excel accepts [LIVE]). The old loop also trimmed
    // whitespace, until nothing moved, because a trimmed space could expose an
    // apostrophe (fix round 5); with spaces kept, nothing is exposed.
    let trimmed: &str = truncated.trim_matches('\'');
    if trimmed.is_empty() {
        return "Sheet".to_string();
    }
    if identity::sheet_names_equal(trimmed, RESERVED_SHEET_NAME) {
        // One character shorter than the limit is always available here.
        return format!("{}_", trimmed);
    }
    trimmed.to_string()
}

/// A unique, legal name built from `base` — for the app's own generated names.
/// Suffixes are `(2)`, `(3)`, ... , the spelling a sheet COPY uses, and the base is
/// SHORTENED to make room, because `format!("{} ({})", base, n)` on a base that
/// is already 31 characters produces a name the rule would refuse.
///
/// The cut stem is NOT trimmed: Excel keeps a space the cut leaves [LIVE,
/// Worksheet.Copy]: `ABCDEFGHIJKLMNOPQRSTUVWXYZ 1234` copies as
/// `ABCDEFGHIJKLMNOPQRSTUVWXYZ  (2)`, two spaces -- the same spelling
/// `calp::pull::collision_sheet_name` gives a pulled sheet.
///
/// A NAME THAT ALREADY ENDS IN A COPY NUMBER counts on from it, as Excel does
/// [LIVE, Excel 16, Worksheet.Copy]: `Data (2)` copies as `Data (3)` (with or
/// without a `Data` beside it), `Data (2)` beside `Data (3)` as `Data (4)`,
/// `Data(2)` as `Data(3)`, `Data (02)` and `Data ( 2)` as `Data (3)`, `Data ()`
/// as `Data (1)`, `Data (5)` as `Data (6)` -- never `Data (2) (2)`. See
/// [`copy_number_suffix`] for what counts as a copy number; anything else
/// (`Data (x)`, `Data (+2)`, `Data (2.5)`, `Data (40000)`) gets ` (2)` appended.
/// The counted-on name keeps the stem exactly (`stem(n)`); when that is longer
/// than the limit, the stem is cut and the suffix spelled ` (n)`, as for any
/// copy: `ABCDEFGHIJKLMNOPQRSTUVWXYZA (9)` copies as
/// `ABCDEFGHIJKLMNOPQRSTUVWXYZ (10)`.
pub fn unique_sheet_name(base: &str, existing: &[String]) -> String {
    let base = sanitize_sheet_name(base);
    if ensure_sheet_name_is_free(&base, existing, None).is_ok() {
        return base;
    }
    if let Some((stem, number)) = copy_number_suffix(&base) {
        let mut n = number as usize + 1;
        loop {
            let counted = format!("{stem}({n})");
            let candidate = if counted.chars().count() <= MAX_SHEET_NAME_CHARS {
                counted
            } else {
                calp::pull::collision_sheet_name(stem, n)
            };
            if ensure_sheet_name_is_free(&candidate, existing, None).is_ok() {
                return candidate;
            }
            n += 1;
            if n > number as usize + existing.len() + 2 && n > 100_000 {
                return format!("Sheet{}", n);
            }
        }
    }
    let mut counter = 2usize;
    loop {
        // One spelling of a copy name for the whole product: the install door
        // (`calp::pull`) and this one cut the stem the same way.
        let candidate = calp::pull::collision_sheet_name(&base, counter);
        if ensure_sheet_name_is_free(&candidate, existing, None).is_ok() {
            return candidate;
        }
        counter += 1;
        // `existing` is finite, so this terminates; the guard is against a
        // pathological base that truncates to the same stem forever.
        if counter > existing.len() + 2 && counter > 1000 {
            return format!("Sheet{}", counter);
        }
    }
}

/// The copy number a sheet name already ends in, as Excel's Copy Sheet reads it
/// [LIVE, Excel 16]: `(stem, n)` when the name ends in `(`, optional spaces,
/// optional ASCII digits, optional spaces, `)`, with the value at most 32767 --
/// `stem` is everything before that `(`, kept exactly. Empty digits are 0
/// (`Data ()` copies as `Data (1)`), leading zeros are read (`Data (02)` as
/// `Data (3)`). Not a copy number: a sign, a decimal point, an exponent, a
/// space between digits, a value above 32767 (`Data (32767)` copies as
/// `Data (32768)` but `Data (32768)` as `Data (32768) (2)`).
fn copy_number_suffix(name: &str) -> Option<(&str, u32)> {
    let rest = name.strip_suffix(')')?;
    let open = rest.rfind('(')?;
    let inner = rest[open + 1..].trim_matches(' ');
    if !inner.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let digits = inner.trim_start_matches('0');
    let number: u32 = if digits.is_empty() {
        0
    } else if digits.len() > 5 {
        return None;
    } else {
        digits.parse().ok()?
    };
    if number > 32767 {
        return None;
    }
    Some((&rest[..open], number))
}

/// Why a name that arrived from a FILE would have been refused at entry, or
/// `None` if it is a name the rule allows.
///
/// Loading never refuses (see the module note). This exists so the load path can
/// say what it carried, in one line per workbook rather than one per sheet.
pub fn load_violation(name: &str) -> Option<String> {
    validate_sheet_name(name).err()
}

// ============================================================================
// SHEET-QUALIFIER CASING  (§2ai — the third restamp)
// ============================================================================

/// Re-spell every SHEET QUALIFIER in `ast` the way the workbook's own tab
/// spells it, in place.
///
/// WHY THIS IS NEEDED AT ALL. The lexer normalises bare identifiers to
/// UPPERCASE (`core/parser/src/lexer.rs`), so `=Data!A1` is parsed, stored and
/// shown as `=DATA!A1` while `='Q1-2026'!A1` — quoted, so never an identifier —
/// round-trips exactly. The two spellings therefore disagree with each other as
/// well as with the sheet tab, and it is reachable without typing a qualifier at
/// all: any formula that mentions another sheet shows it shouting.
///
/// This is §2t's recipe with a third authority. `restamp_name_casing` re-spells
/// defined names from the Name Manager, `table_deps::restamp_table_casing`
/// re-spells tables from the table registry, and this re-spells sheets from
/// `AppState::sheet_names`. All three run at the same two moments — when a
/// formula ENTERS the document, and when one comes BACK from a file — because a
/// formula the lexer has touched is a formula that needs all three.
///
/// A QUALIFIER NAMING A SHEET THAT DOES NOT EXIST IS LEFT EXACTLY AS IT IS, and
/// that is the whole delicacy of this function: re-spelling it would let a
/// dangling reference acquire a plausible-looking sheet name it never had. Only
/// an EXACT case-insensitive match against the live list re-spells.
///
/// PURELY COSMETIC BY CONSTRUCTION. Every sheet lookup on every path compares
/// case-insensitively (`normalize_cross_sheet_refs`, `sheet_index_of` in the
/// calculation planner, `find_sheet_index`), so no resolution, edge or value can
/// depend on the spelling stored here.
pub fn restamp_sheet_casing(ast: &mut parser::ast::Expression, sheet_names: &[String]) {
    if sheet_names.is_empty() {
        return;
    }
    restamp(ast, sheet_names);
}

/// The same restamp over every stored formula of one sheet's grid — the LOAD
/// half, exactly as `restamp_grid_name_casing` is the load half of
/// `restamp_name_casing`.
///
/// NOT A CELL WRITE: it mutates the AST a cell already holds in place, calls
/// neither `set_cell` nor `clear_cell` and creates no value, so it is not a
/// member of the recalculation census's population. Returns how many formulas
/// were respelled, for logging.
pub fn restamp_grid_sheet_casing(grid: &mut engine::Grid, sheet_names: &[String]) -> usize {
    if sheet_names.is_empty() {
        return 0;
    }
    let mut changed = 0usize;
    for cell in grid.cells.values_mut() {
        let Some(ast) = cell.ast.as_deref_mut() else { continue };
        if !has_sheet_qualifier(ast) {
            continue;
        }
        let before = engine::ast_render::render_formula_raw(ast);
        restamp(ast, sheet_names);
        if engine::ast_render::render_formula_raw(ast) != before {
            changed += 1;
        }
    }
    changed
}

/// Re-point every sheet qualifier in `grid` spelled EXACTLY `old`
/// (case-sensitively) to `new` -- the formula half of
/// `dedupe_loaded_sheet_names`. Returns how many formulas changed.
///
/// Exact, not by Excel's rule: the load-time rename exists because two sheets
/// had names the rule calls one, so the rule cannot tell a formula's two
/// candidates apart; the exact spelling is the only evidence there is. A
/// qualifier spelled some third way (`ÄRENDE` beside `Ärende` and `ärende`)
/// stays with the sheet that kept the name -- deterministic, and the same
/// answer every lookup now gives it.
///
/// AND ONLY A SPELLING THAT SURVIVES THE LEXER (`spelling_survives_the_lexer`,
/// rev10C). A bare qualifier is stored uppercased, so in a file holding `Data`
/// (kept) and `DATA` (renamed) every bare `=Data!A1` is stored `DATA` -- the
/// exact old name -- and was moved to `DATA (2)`, so formulas meant for the
/// keeper read the other sheet with no error. An all-uppercase spelling a bare
/// name parses to is no evidence, and stays with the keeper like any other.
pub fn rename_grid_qualifiers_exactly(grid: &mut engine::Grid, old: &str, new: &str) -> usize {
    let mut changed = 0usize;
    for cell in grid.cells.values_mut() {
        let Some(ast) = cell.ast.as_deref_mut() else { continue };
        if !has_sheet_qualifier(ast) {
            continue;
        }
        let mut hit = false;
        rename_exact(ast, old, new, &mut hit);
        if hit {
            changed += 1;
        }
    }
    changed
}

fn rename_exact_slot(slot: &mut String, old: &str, new: &str, hit: &mut bool) {
    if slot == old && spelling_survives_the_lexer(slot) {
        *slot = new.to_string();
        *hit = true;
    }
}

/// Whether a stored qualifier's exact spelling is EVIDENCE of which sheet the
/// formula meant (rev10C). ONE definition, shared with the load-time rename of
/// every other store (`calp::sheet_renames::SheetRenames::exact_spelling`), so
/// a cell and a defined name cannot disagree about it -- see
/// `calp::sheet_renames::spelling_survives_the_lexer`.
fn spelling_survives_the_lexer(spelling: &str) -> bool {
    calp::sheet_renames::spelling_survives_the_lexer(spelling)
}

fn rename_exact(ast: &mut parser::ast::Expression, old: &str, new: &str, hit: &mut bool) {
    use parser::ast::Expression as E;
    match ast {
        E::CellRef { sheet, .. } | E::ColumnRef { sheet, .. } | E::RowRef { sheet, .. } => {
            if let Some(s) = sheet {
                rename_exact_slot(s, old, new, hit);
            }
        }
        E::Range { sheet, start, end, .. } => {
            if let Some(s) = sheet {
                rename_exact_slot(s, old, new, hit);
            }
            rename_exact(start, old, new, hit);
            rename_exact(end, old, new, hit);
        }
        E::Sheet3DRef { start_sheet, end_sheet, reference, .. } => {
            rename_exact_slot(start_sheet, old, new, hit);
            rename_exact_slot(end_sheet, old, new, hit);
            rename_exact(reference, old, new, hit);
        }
        E::Literal(_) | E::NamedRef { .. } | E::TableRef { .. } => {}
        E::BinaryOp { left, right, .. } => {
            rename_exact(left, old, new, hit);
            rename_exact(right, old, new, hit);
        }
        E::UnaryOp { operand, .. } => rename_exact(operand, old, new, hit),
        E::FunctionCall { args, .. } => {
            for a in args {
                rename_exact(a, old, new, hit);
            }
        }
        E::IndexAccess { target, index } => {
            rename_exact(target, old, new, hit);
            rename_exact(index, old, new, hit);
        }
        E::ArrayLiteral { rows } => {
            for e in rows.iter_mut().flatten() {
                rename_exact(e, old, new, hit);
            }
        }
        E::ListLiteral { elements } => {
            for e in elements {
                rename_exact(e, old, new, hit);
            }
        }
        E::DictLiteral { entries } => {
            for (k, v) in entries {
                rename_exact(k, old, new, hit);
                rename_exact(v, old, new, hit);
            }
        }
        E::SpillRef { cell, .. } => rename_exact(cell, old, new, hit),
        E::ImplicitIntersection { operand } => rename_exact(operand, old, new, hit),
    }
}

/// The gate: does this tree mention a sheet at all? Allocation-free, so the
/// dominant case (no cross-sheet reference anywhere) never reaches the renderer.
fn has_sheet_qualifier(ast: &parser::ast::Expression) -> bool {
    use parser::ast::Expression as E;
    match ast {
        E::CellRef { sheet, .. } | E::ColumnRef { sheet, .. } | E::RowRef { sheet, .. } => {
            sheet.is_some()
        }
        E::Range { sheet, start, end, .. } => {
            sheet.is_some() || has_sheet_qualifier(start) || has_sheet_qualifier(end)
        }
        E::Sheet3DRef { .. } => true,
        E::Literal(_) | E::NamedRef { .. } | E::TableRef { .. } => false,
        E::BinaryOp { left, right, .. } => has_sheet_qualifier(left) || has_sheet_qualifier(right),
        E::UnaryOp { operand, .. } => has_sheet_qualifier(operand),
        E::FunctionCall { args, .. } => args.iter().any(has_sheet_qualifier),
        E::IndexAccess { target, index } => {
            has_sheet_qualifier(target) || has_sheet_qualifier(index)
        }
        E::ArrayLiteral { rows } => rows.iter().flatten().any(has_sheet_qualifier),
        E::ListLiteral { elements } => elements.iter().any(has_sheet_qualifier),
        E::DictLiteral { entries } => entries
            .iter()
            .any(|(k, v)| has_sheet_qualifier(k) || has_sheet_qualifier(v)),
        E::SpillRef { cell, .. } => has_sheet_qualifier(cell),
        E::ImplicitIntersection { operand } => has_sheet_qualifier(operand),
    }
}

/// The workbook's own spelling of `qualifier`, when a sheet by that name exists
/// and is spelled differently. `None` means "leave it alone" — either because it
/// already matches, or because no such sheet exists.
fn official_spelling(qualifier: &str, sheet_names: &[String]) -> Option<String> {
    let found = sheet_names
        .iter()
        .find(|n| identity::sheet_names_equal(n, qualifier))?;
    (found != qualifier).then(|| found.clone())
}

fn respell(slot: &mut Option<String>, sheet_names: &[String]) {
    if let Some(name) = slot {
        if let Some(official) = official_spelling(name, sheet_names) {
            *name = official;
        }
    }
}

fn restamp(ast: &mut parser::ast::Expression, sheet_names: &[String]) {
    use parser::ast::Expression as E;
    match ast {
        E::CellRef { sheet, .. } | E::ColumnRef { sheet, .. } | E::RowRef { sheet, .. } => {
            respell(sheet, sheet_names);
        }
        E::Range { sheet, start, end, .. } => {
            respell(sheet, sheet_names);
            restamp(start, sheet_names);
            restamp(end, sheet_names);
        }
        E::Sheet3DRef { start_sheet, end_sheet, reference, .. } => {
            if let Some(official) = official_spelling(start_sheet, sheet_names) {
                *start_sheet = official;
            }
            if let Some(official) = official_spelling(end_sheet, sheet_names) {
                *end_sheet = official;
            }
            restamp(reference, sheet_names);
        }
        E::Literal(_) | E::NamedRef { .. } | E::TableRef { .. } => {}
        E::BinaryOp { left, right, .. } => {
            restamp(left, sheet_names);
            restamp(right, sheet_names);
        }
        E::UnaryOp { operand, .. } => restamp(operand, sheet_names),
        E::FunctionCall { args, .. } => {
            for a in args {
                restamp(a, sheet_names);
            }
        }
        E::IndexAccess { target, index } => {
            restamp(target, sheet_names);
            restamp(index, sheet_names);
        }
        E::ArrayLiteral { rows } => {
            for e in rows.iter_mut().flatten() {
                restamp(e, sheet_names);
            }
        }
        E::ListLiteral { elements } => {
            for e in elements {
                restamp(e, sheet_names);
            }
        }
        E::DictLiteral { entries } => {
            for (k, v) in entries {
                restamp(k, sheet_names);
                restamp(v, sheet_names);
            }
        }
        E::SpillRef { cell, .. } => restamp(cell, sheet_names),
        E::ImplicitIntersection { operand } => restamp(operand, sheet_names),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // The three names the hunt measured are LEGAL. Excel accepts all three, the
    // renderer quotes all three, and a validation rule that rejected them would
    // be this register inventing a restriction Excel does not have.
    // -----------------------------------------------------------------------
    #[test]
    fn the_three_measured_names_are_accepted() {
        for name in ["John's", "Q1-2026", "2026"] {
            assert_eq!(
                validate_sheet_name(name).as_deref(),
                Ok(name),
                "`{}` is a legal sheet name in Excel and must stay legal here -- \
                 the renderer quotes it correctly now",
                name
            );
        }
    }

    #[test]
    fn a_legal_name_survives_the_quoting_round_trip() {
        // The pair that matters: what entry accepts, the serialiser must be able
        // to write into a formula that lexes again -- and re-rendering that must
        // be STABLE, or a save/reload cycle keeps rewriting the same formula.
        //
        // CASE IS NOT PART OF THE CLAIM, and that is a finding rather than an
        // omission: the lexer upper-cases a BARE sheet qualifier (`Data!A1` ->
        // `DATA!A1`) exactly as it upper-cases a bare defined name, and section
        // 2t's restamp covers defined names only. A quoted qualifier keeps its
        // case, so the two spellings disagree. Recorded in the register.
        for name in ["John's", "Q1-2026", "2026", "Data", "Sheet 1", "a.b"] {
            let quoted = engine::ast_render::quote_sheet_name(name);
            let formula = format!("={}!A1", quoted);
            let parsed = parser::parse(&formula).unwrap_or_else(|e| {
                panic!("`{}` rendered `{}` which does not lex: {}", name, formula, e)
            });
            let rendered = format!("={}", engine::ast_render::render_formula_raw(&parsed));
            assert!(
                rendered.eq_ignore_ascii_case(&formula),
                "`{}` does not survive the render/parse round trip: `{}` -> `{}`",
                name,
                formula,
                rendered
            );
            // STABILITY: rendering the re-parsed form again must not move.
            let reparsed = parser::parse(&rendered).expect("the rendered form lexes");
            assert_eq!(
                format!("={}", engine::ast_render::render_formula_raw(&reparsed)),
                rendered,
                "`{}` keeps changing every time it goes through the serialiser",
                name
            );
        }
    }

    #[test]
    fn every_character_excel_forbids_is_refused() {
        for bad in ILLEGAL_SHEET_NAME_CHARS {
            let name = format!("Da{}ta", bad);
            assert!(
                validate_sheet_name(&name).is_err(),
                "`{}` contains `{}`, which Excel forbids in a sheet name",
                name,
                bad
            );
        }
    }

    #[test]
    fn the_length_limit_counts_characters_not_bytes() {
        let thirty_one = "a".repeat(31);
        assert!(validate_sheet_name(&thirty_one).is_ok());
        assert!(validate_sheet_name(&"a".repeat(32)).is_err());
        // 31 two-byte characters is 62 bytes and still a legal name.
        let accented = "é".repeat(31);
        assert!(
            validate_sheet_name(&accented).is_ok(),
            "the limit was measured in bytes, not characters"
        );
    }

    #[test]
    fn an_apostrophe_is_legal_inside_and_illegal_at_the_ends() {
        assert!(validate_sheet_name("John's").is_ok());
        assert!(validate_sheet_name("'Data").is_err());
        assert!(validate_sheet_name("Data'").is_err());
    }

    #[test]
    /// Excel [LIVE, Excel 16, 2026-10-31, protfill/probe2-3.ps1]: the Rename
    /// UI keeps ` Data ` (six characters) and accepts a name of two spaces;
    /// only the empty name is refused. Entry used to trim and refuse both.
    fn only_the_empty_name_is_refused_and_spaces_are_kept_like_excel() {
        assert!(validate_sheet_name("").is_err());
        assert_eq!(validate_sheet_name("  ").as_deref(), Ok("  "), "Excel's Rename UI accepts two spaces");
        assert_eq!(validate_sheet_name(" Data ").as_deref(), Ok(" Data "), "Excel keeps the spaces at both ends");
        assert_eq!(validate_sheet_name(" 'x").as_deref(), Ok(" 'x"), "an apostrophe after a space is not at the end");
        assert!(validate_sheet_name(" Data'").is_err(), "an apostrophe at the end is still refused");
        // ` Data ` and `Data` are two sheets; ` DATA ` is the duplicate.
        let existing = vec![" Data ".to_string()];
        assert!(ensure_sheet_name_is_free("Data", &existing, None).is_ok());
        assert!(ensure_sheet_name_is_free(" DATA ", &existing, None).is_err());
        // Copy Sheet keeps the stem's spaces: Excel copies ` Data ` as ` Data  (2)`.
        assert_eq!(unique_sheet_name(" Data ", &existing), " Data  (2)");
        assert_eq!(unique_sheet_name("  ", &["  ".to_string()]), "   (2)", "Excel copies `  ` as `   (2)`");
    }

    #[test]
    fn the_reserved_name_is_refused_in_any_casing() {
        assert!(validate_sheet_name("History").is_err());
        assert!(validate_sheet_name("history").is_err());
        assert!(validate_sheet_name("HISTORY").is_err());
        // Only the exact word is reserved.
        assert!(validate_sheet_name("History 2026").is_ok());
    }

    #[test]
    fn a_duplicate_is_refused_ignoring_case() {
        let existing = vec!["Sheet1".to_string(), "Data".to_string()];
        assert!(ensure_sheet_name_is_free("sheet1", &existing, None).is_err());
        assert!(ensure_sheet_name_is_free("DATA", &existing, None).is_err());
        // Renaming a sheet to the case-variant of its OWN name is not a clash.
        assert!(ensure_sheet_name_is_free("SHEET1", &existing, Some(0)).is_ok());
        assert!(ensure_sheet_name_is_free("Report", &existing, None).is_ok());
    }

    /// rev6A#8: the comparison was ASCII-only, so `Ärende` and `ärende` could
    /// coexist. Excel refuses the pair [LIVE]. The sheet-name round then made
    /// the rule EXACTLY Excel's: `STRASSE` beside `Straße` was refused while
    /// the rule folded with Rust's full uppercasing (`ß` -> `SS`), and Excel
    /// ACCEPTS it [LIVE] -- that assertion is deliberately inverted here --
    /// while `ß` beside `ẞ`, and the Kelvin sign beside `K`, are refused.
    #[test]
    fn a_duplicate_is_refused_ignoring_case_beyond_ascii() {
        let existing = vec!["\u{c4}rende".to_string(), "Stra\u{df}e".to_string()];
        assert!(ensure_sheet_name_is_free("\u{e4}rende", &existing, None).is_err(), "Ärende beside ärende");
        assert!(ensure_sheet_name_is_free("\u{c4}RENDE", &existing, None).is_err());
        assert!(
            ensure_sheet_name_is_free("STRASSE", &existing, None).is_ok(),
            "Excel accepts STRASSE beside Stra\u{df}e [LIVE]: case folding never expands"
        );
        assert!(
            ensure_sheet_name_is_free("STRA\u{1e9e}E", &existing, None).is_err(),
            "Excel refuses STRA\u{1e9e}E (capital sharp s) beside Stra\u{df}e [LIVE]"
        );
        let kelvin = vec!["K".to_string()];
        assert!(ensure_sheet_name_is_free("\u{212a}", &kelvin, None).is_err(), "Excel refuses the Kelvin sign beside K");
        assert!(
            ensure_sheet_name_is_free("\u{130}", &["i".to_string()], None).is_ok(),
            "Excel has no Turkish rule: dotted capital I beside i is accepted"
        );
        assert!(ensure_sheet_name_is_free("\u{e4}rende", &existing, Some(0)).is_ok(), "its own case-variant");
        assert!(ensure_sheet_name_is_free("\u{c5}rende", &existing, None).is_ok(), "another letter is another name");
        assert_eq!(
            unique_sheet_name("\u{e4}rende", &existing),
            "\u{e4}rende (2)",
            "a generated name steps past the case-variant too"
        );
    }

    /// A document saved under an older rule can hold two names the rule now
    /// calls one. It still opens: the lower tab index keeps its name, every
    /// later one is renamed like a copy, and only qualifiers spelled exactly as
    /// the renamed sheet was follow it.
    #[test]
    fn a_loaded_pair_the_rule_calls_one_is_renamed_deterministically() {
        let loaded = vec![
            "\u{c4}rende".to_string(),
            "Data".to_string(),
            "\u{e4}rende".to_string(),
            "STRASSE".to_string(),
            "Stra\u{df}e".to_string(),
            "\u{e4}rende (2)".to_string(),
        ];
        let mut probe = loaded.clone();
        let renames = dedupe_loaded_sheet_names(&mut probe);
        assert_eq!(
            renames,
            vec![(2, "\u{e4}rende".to_string(), "\u{e4}rende (3)".to_string())],
            "only the later case-variant is renamed, past the (2) a later sheet already holds; \
             STRASSE beside Stra\u{df}e is two names"
        );

        // The step `open_file` runs, over the file's grids: Data's formulas.
        let mut grids: Vec<engine::Grid> = (0..loaded.len()).map(|_| engine::Grid::new()).collect();
        for (row, text) in ["='\u{e4}rende'!A1", "='\u{c4}rende'!A1", "=SUM('\u{e4}rende:Data'!B2)", "=Data!A1"]
            .iter()
            .enumerate()
        {
            let ast = parser::parse(text).expect("fixture formula parses");
            let mut cell = engine::Cell::new_formula(text.to_string());
            cell.ast = Some(Box::new(ast));
            grids[1].set_cell(row as u32, 0, cell);
        }
        let names = settle_loaded_sheet_names(loaded.clone(), &mut grids);
        assert_eq!(names[0], "\u{c4}rende", "the lower tab index keeps its name");
        assert_eq!(names[2], "\u{e4}rende (3)");
        for (i, a) in names.iter().enumerate() {
            for b in &names[i + 1..] {
                assert!(!identity::sheet_names_equal(a, b), "{a:?} and {b:?} are still one name");
            }
        }
        let grid = &grids[1];
        let shown = |row: u32| {
            engine::ast_render::render_formula_raw(grid.get_cell(row, 0).unwrap().ast.as_deref().unwrap())
        };
        assert!(shown(0).contains("\u{e4}rende (3)"), "{}", shown(0));
        assert!(!shown(1).contains("(3)"), "the keeper's own spelling stays: {}", shown(1));
        assert!(shown(2).contains("\u{e4}rende (3)"), "{}", shown(2));
    }

    /// rev10C: the lexer uppercases a BARE qualifier, so in a file holding
    /// `Data` (kept) and `DATA` (renamed) every bare `=Data!A1` is stored
    /// `DATA` -- the renamed sheet's exact old name -- and the exact-spelling
    /// rule moved the keeper's references to `DATA (2)`. An uppercase spelling
    /// a bare name parses to is no evidence; one only quoting can produce is.
    #[test]
    fn a_loaded_ascii_pair_leaves_bare_references_with_the_keeper() {
        let loaded = vec!["Data".to_string(), "DATA".to_string(), "Report".to_string(), "data".to_string()];
        let mut grids: Vec<engine::Grid> = (0..loaded.len()).map(|_| engine::Grid::new()).collect();
        let fixtures = [
            "=Data!A1",          // bare: stored DATA -- meant for the keeper
            "=DATA!A1",          // bare: stored DATA -- no evidence either way
            "=SUM(Data:Report!A1)", // bare 3-D: stored DATA:REPORT
            "='data'!A1",        // quoted lowercase: only quoting keeps it
        ];
        for (row, text) in fixtures.iter().enumerate() {
            let ast = parser::parse(text).expect("fixture formula parses");
            let mut cell = engine::Cell::new_formula(text.to_string());
            cell.ast = Some(Box::new(ast));
            grids[2].set_cell(row as u32, 0, cell);
        }
        let names = settle_loaded_sheet_names(loaded, &mut grids);
        assert_eq!(names, vec!["Data", "DATA (2)", "Report", "data (3)"], "deterministic: later ones renamed");
        let grid = &grids[2];
        let shown = |row: u32| {
            engine::ast_render::render_formula_raw(grid.get_cell(row, 0).unwrap().ast.as_deref().unwrap())
        };
        for row in 0..3 {
            assert!(
                !shown(row).contains("(2)"),
                "a bare reference stays with the keeper Data, not the renamed DATA (2): {}",
                shown(row)
            );
        }
        assert!(shown(3).contains("data (3)"), "a quoted lowercase spelling is evidence: {}", shown(3));
    }

    /// names2 remaining (round 13): the load-time rename reached cell formulas
    /// only. A defined name, a chart source, a conditional format, a navigate
    /// button's page target and a pivot spelled exactly as the renamed sheet
    /// kept the old spelling -- which every lookup resolves, by Excel's rule,
    /// to the KEEPER -- so `='ärende'!B1` in a cell read the renamed sheet and
    /// the name `Rate` (`='ärende'!$B$1`) read the other one. Every kind now
    /// follows by the same evidence, references to the keeper stay, and the
    /// user gets one notice.
    #[test]
    fn a_load_time_rename_carries_every_reference_kind_and_says_so() {
        use serde_json::json;
        let mut wb = persistence::Workbook::new();
        wb.sheets = vec![
            persistence::Sheet::new("\u{c4}rende".to_string()),
            persistence::Sheet::new("\u{e4}rende".to_string()),
            persistence::Sheet::new("Report".to_string()),
        ];
        let sid = wb.sheets[2].id;
        let named = |name: &str, refers_to: &str| persistence::SavedNamedRange {
            name: name.to_string(),
            refers_to: refers_to.to_string(),
            sheet_id: None,
            comment: None,
            folder: None,
        };
        let entity = || identity::EntityId::from_bytes(identity::generate_uuid_v7());
        wb.named_ranges = vec![named("Rate", "='\u{e4}rende'!$B$1"), named("Keep", "='\u{c4}rende'!$B$1")];
        wb.charts = vec![persistence::SavedChart {
            id: entity(),
            sheet_id: sid,
            spec: json!({ "mark": "bar", "data": "'\u{e4}rende'!A1:A3" }),
        }];
        wb.conditional_formats = vec![persistence::SavedSheetConditionalFormats {
            sheet_id: sid,
            rules: json!([
                { "rule": { "type": "expression", "formula": "='\u{e4}rende'!$A$1>0" } },
                { "rule": { "type": "expression", "formula": "='\u{c4}rende'!$A$1>0" } }
            ]),
        }];
        wb.controls = vec![persistence::SavedSheetControls {
            sheet_id: sid,
            controls: json!([{
                "controlType": "button",
                "properties": {
                    "action": { "valueType": "static", "value": "navigate" },
                    "actionTargetName": { "valueType": "static", "value": "\u{e4}rende" }
                }
            }]),
        }];
        wb.pivot_definitions = vec![persistence::SavedPivotDefinition {
            id: entity(),
            source_type: "grid".to_string(),
            source_sheet_index: Some(0),
            definition: json!({ "destination_sheet": "\u{e4}rende", "source_sheet": "\u{c4}rende" }),
        }];
        let mut grids: Vec<engine::Grid> = (0..3).map(|_| engine::Grid::new()).collect();

        let (names, report) = settle_loaded_workbook_sheet_names(&mut wb, &mut grids);

        assert_eq!(names, vec!["\u{c4}rende", "\u{e4}rende (2)", "Report"]);
        assert_eq!(wb.sheets[1].name, "\u{e4}rende (2)", "the restores that map by name see the new name");
        assert_eq!(wb.named_ranges[0].refers_to, "='\u{e4}rende (2)'!$B$1", "the defined name follows its sheet");
        assert_eq!(wb.named_ranges[1].refers_to, "='\u{c4}rende'!$B$1", "the keeper's name stays");
        assert_eq!(wb.charts[0].spec["data"], json!("'\u{e4}rende (2)'!A1:A3"), "the chart source follows");
        assert_eq!(wb.conditional_formats[0].rules[0]["rule"]["formula"], json!("='\u{e4}rende (2)'!$A$1>0"));
        assert_eq!(wb.conditional_formats[0].rules[1]["rule"]["formula"], json!("='\u{c4}rende'!$A$1>0"));
        assert_eq!(
            wb.controls[0].controls[0]["properties"]["actionTargetName"]["value"],
            json!("\u{e4}rende (2)"),
            "a navigate button's page target follows"
        );
        assert_eq!(wb.pivot_definitions[0].definition["destination_sheet"], json!("\u{e4}rende (2)"));
        assert_eq!(wb.pivot_definitions[0].definition["source_sheet"], json!("\u{c4}rende"));
        assert_eq!(report.other_references, 5, "name, chart, CF, page target, pivot destination");

        let notice = load_rename_notice(&report).expect("a rename is told to the user");
        assert!(notice.contains("'\u{e4}rende' is now '\u{e4}rende (2)'"), "{notice}");
        assert_eq!(load_rename_notice(&LoadedRenameReport::default()), None, "no rename, no notice");
    }

    /// NEW-unique-sheet-name-trims-cut-stem (calpkey): the cut stem kept a
    /// trailing space in Excel [LIVE, Worksheet.Copy] and was trimmed here.
    #[test]
    fn a_generated_copy_name_is_cut_like_excels() {
        let spaced = "ABCDEFGHIJKLMNOPQRSTUVWXYZ 1234";
        assert_eq!(spaced.chars().count(), 31, "fixture");
        assert_eq!(
            unique_sheet_name(spaced, &[spaced.to_string()]),
            "ABCDEFGHIJKLMNOPQRSTUVWXYZ  (2)",
            "Excel keeps the space the cut leaves: two spaces before (2) [LIVE]"
        );
        let a31 = "A".repeat(31);
        let a27 = "A".repeat(27);
        assert_eq!(unique_sheet_name(&a31, &[a31.clone()]), format!("{a27} (2)"));
        assert_eq!(unique_sheet_name(&a31, &[a31.clone(), format!("{a27} (2)")]), format!("{a27} (3)"));
        let digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZ12345";
        assert_eq!(unique_sheet_name(digits, &[digits.to_string()]), "ABCDEFGHIJKLMNOPQRSTUVWXYZ1 (2)");
        assert_eq!(unique_sheet_name("Short", &["Short".to_string()]), "Short (2)");
    }

    /// rev12C: Copy Sheet of a name that already ends in a copy number counted
    /// on from it in Excel and appended a second suffix here (`Data (2) (2)`).
    /// Every expectation is Excel 16's Worksheet.Copy result [LIVE, 2026-10-30].
    ///
    /// SABOTAGE: `copy_number_suffix` returns `None` at once -- `Data (2)`
    /// copies as `Data (2) (2)`.
    #[test]
    fn copying_a_numbered_name_counts_on_like_excel() {
        let copy = |source: &str, sheets: &[&str]| {
            let existing: Vec<String> = sheets.iter().map(|s| s.to_string()).collect();
            unique_sheet_name(source, &existing)
        };
        assert_eq!(copy("Data (2)", &["Data", "Data (2)"]), "Data (3)");
        assert_eq!(copy("Data (2)", &["Data (2)"]), "Data (3)");
        assert_eq!(copy("Data (2)", &["Data (2)", "Data (3)"]), "Data (4)");
        assert_eq!(copy("data (2)", &["data (2)", "DATA (3)"]), "data (4)", "taken case-insensitively");
        assert_eq!(copy("Data", &["Data", "Data (2)"]), "Data (3)");
        assert_eq!(copy("Data(2)", &["Data(2)"]), "Data(3)", "the stem is kept exactly");
        assert_eq!(copy("Data  (2)", &["Data  (2)"]), "Data  (3)");
        assert_eq!(copy("Data (02)", &["Data (02)"]), "Data (3)");
        assert_eq!(copy("Data ( 2)", &["Data ( 2)"]), "Data (3)");
        assert_eq!(copy("Data (2 )", &["Data (2 )"]), "Data (3)");
        assert_eq!(copy("Data ()", &["Data ()"]), "Data (1)");
        assert_eq!(copy("Data ( )", &["Data ( )"]), "Data (1)");
        assert_eq!(copy("Data (0)", &["Data (0)"]), "Data (1)");
        assert_eq!(copy("Data (1)", &["Data (1)"]), "Data (2)");
        assert_eq!(copy("Data (5)", &["Data (5)"]), "Data (6)");
        assert_eq!(copy("(2)", &["(2)"]), "(3)");
        assert_eq!(copy("Data (2) (2)", &["Data (2) (2)"]), "Data (2) (3)");
        assert_eq!(copy("Data (2", &["Data (2", "Data (2 (2)"]), "Data (2 (3)");
        assert_eq!(copy("Data (32767)", &["Data (32767)"]), "Data (32768)");
        // Not a copy number: a suffix is appended.
        for (source, expected) in [
            ("Data (x)", "Data (x) (2)"),
            ("Data (2)x", "Data (2)x (2)"),
            ("Data (+2)", "Data (+2) (2)"),
            ("Data (2.5)", "Data (2.5) (2)"),
            ("Data (1e2)", "Data (1e2) (2)"),
            ("Data (2 3)", "Data (2 3) (2)"),
            ("Data (32768)", "Data (32768) (2)"),
            ("Data (65535)", "Data (65535) (2)"),
            ("Data (2147483647)", "Data (2147483647) (2)"),
        ] {
            assert_eq!(copy(source, &[source]), expected, "copy of {source:?}");
        }
        // Too long to count on in place: cut, and spelled ` (n)`.
        assert_eq!(
            copy("ABCDEFGHIJKLMNOPQRSTUVWXYZA (2)", &["ABCDEFGHIJKLMNOPQRSTUVWXYZA (2)"]),
            "ABCDEFGHIJKLMNOPQRSTUVWXYZA (3)"
        );
        assert_eq!(
            copy("ABCDEFGHIJKLMNOPQRSTUVWXYZA (9)", &["ABCDEFGHIJKLMNOPQRSTUVWXYZA (9)"]),
            "ABCDEFGHIJKLMNOPQRSTUVWXYZ (10)"
        );
        assert_eq!(
            copy("ABCDEFGHIJKLMNOPQRSTUVWXYZAB(9)", &["ABCDEFGHIJKLMNOPQRSTUVWXYZAB(9)"]),
            "ABCDEFGHIJKLMNOPQRSTUVWXYZ (10)"
        );
        assert_eq!(
            copy("ABCDEFGHIJKLMNOPQRSTUVWXYZ  (9)", &["ABCDEFGHIJKLMNOPQRSTUVWXYZ  (9)"]),
            "ABCDEFGHIJKLMNOPQRSTUVWXYZ (10)"
        );
    }

    #[test]
    fn sanitizing_always_produces_a_name_the_rule_accepts() {
        for raw in [
            "",
            "   ",
            "'quoted'",
            "History",
            "a/b\\c:d?e*f[g]h",
            &"z".repeat(200),
            "''",
        ] {
            let cleaned = sanitize_sheet_name(raw);
            assert!(
                validate_sheet_name(&cleaned).is_ok(),
                "sanitizing `{}` produced `{}`, which entry would refuse",
                raw,
                cleaned
            );
        }
    }

    /// EVERY mix of spaces, tabs, apostrophes, an illegal character and a
    /// letter, up to six characters long, alone and at both ends of a name
    /// long enough to be truncated: the cleaned name is one entry accepts AS IT
    /// IS, and cleaning it again changes nothing. One pass of trimming turned
    /// `' 'x` into `'x` (fix round 5), a name entry refuses; the fixed list
    /// above never tried a space BETWEEN two apostrophes.
    #[test]
    fn sanitizing_leaves_no_apostrophe_at_either_end_and_keeps_spaces() {
        // Spaces are legal at the ends (Excel [LIVE]); only an END apostrophe
        // is stripped, and nothing is left to expose another one.
        assert_eq!(sanitize_sheet_name("' 'x"), " 'x");
        assert_eq!(sanitize_sheet_name("x' '"), "x' ");
        assert_eq!(sanitize_sheet_name(" Data "), " Data ");
        assert_eq!(sanitize_sheet_name("'History'"), "History_");
        assert_eq!(sanitize_sheet_name("'''"), "Sheet");

        const ALPHABET: [char; 5] = [' ', '\'', '\t', ':', 'x'];
        let mut words: Vec<String> = vec![String::new()];
        let mut frontier: Vec<String> = vec![String::new()];
        for _ in 0..6 {
            let mut next = Vec::with_capacity(frontier.len() * ALPHABET.len());
            for word in &frontier {
                for c in ALPHABET {
                    next.push(format!("{word}{c}"));
                }
            }
            words.extend(next.iter().cloned());
            frontier = next;
        }
        assert_eq!(words.len(), 19_531, "fixture: every word of up to six characters");
        let pad = "a".repeat(27);
        let mut checked = 0usize;
        for word in &words {
            for raw in [word.clone(), format!("{pad}{word}"), format!("{word}{pad}")] {
                let cleaned = sanitize_sheet_name(&raw);
                assert_eq!(
                    validate_sheet_name(&cleaned).as_deref(),
                    Ok(cleaned.as_str()),
                    "sanitizing {raw:?} produced {cleaned:?}, which entry refuses or rewrites"
                );
                assert_eq!(
                    sanitize_sheet_name(&cleaned),
                    cleaned,
                    "sanitizing {raw:?} is not finished: cleaning {cleaned:?} again changes it"
                );
                checked += 1;
            }
        }
        assert_eq!(checked, 3 * 19_531);
    }

    #[test]
    fn a_generated_unique_name_fits_inside_the_length_limit() {
        // A 31-character base plus " (2)" is 35 -- the old `format!` produced a
        // name the new rule refuses, which would have made "Duplicate Sheet"
        // fail on any sheet with a long name.
        let base = "a".repeat(31);
        let existing = vec![base.clone()];
        let generated = unique_sheet_name(&base, &existing);
        assert!(
            validate_sheet_name(&generated).is_ok(),
            "generated `{}` ({} chars)",
            generated,
            generated.chars().count()
        );
        assert!(ensure_sheet_name_is_free(&generated, &existing, None).is_ok());
    }

    #[test]
    fn load_reports_a_violation_instead_of_refusing() {
        assert!(load_violation("Data").is_none());
        assert!(load_violation("Q1/Q2").is_some());
        assert!(load_violation(&"a".repeat(40)).is_some());
    }
}
