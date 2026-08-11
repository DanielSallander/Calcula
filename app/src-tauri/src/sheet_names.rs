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

/// Validate a name a USER typed. Returns the name to store (trimmed), or the
/// message to show them.
///
/// Trimming is deliberate and matches what this command already did: a name
/// typed with a trailing space is a name with a trailing space in every formula
/// that mentions it, and nobody means that.
pub fn validate_sheet_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
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
    if name.eq_ignore_ascii_case(RESERVED_SHEET_NAME) {
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
/// cross-sheet dependency keys, `eq_ignore_ascii_case` in the rename), so
/// allowing `sheet1` beside `Sheet1` created two sheets that every consumer
/// downstream believed were one. `ignore_index` is the sheet being renamed —
/// renaming `Data` to `Data` is not a collision with itself.
pub fn ensure_sheet_name_is_free(
    name: &str,
    existing: &[String],
    ignore_index: Option<usize>,
) -> Result<(), String> {
    for (i, other) in existing.iter().enumerate() {
        if Some(i) == ignore_index {
            continue;
        }
        if other.eq_ignore_ascii_case(name) {
            return Err(format!("Sheet '{}' already exists", other));
        }
    }
    Ok(())
}

/// COERCE an arbitrary string into a legal sheet name. Never fails.
///
/// For names the app GENERATES rather than accepts — the pivot "Show Report
/// Filter Pages" command builds one per field value, and a field value can be
/// anything at all. Illegal characters become `_`, the result is trimmed and cut
/// to the length limit, and a name that coerces away to nothing becomes
/// `Sheet`.
pub fn sanitize_sheet_name(raw: &str) -> String {
    let replaced: String = raw
        .chars()
        .map(|c| if ILLEGAL_SHEET_NAME_CHARS.contains(&c) { '_' } else { c })
        .collect();
    // Truncate FIRST, then trim: cutting at 31 characters can leave a trailing
    // space or apostrophe that the trim below has to remove.
    let truncated: String = replaced.chars().take(MAX_SHEET_NAME_CHARS).collect();
    let trimmed = truncated.trim().trim_matches('\'').trim();
    if trimmed.is_empty() {
        return "Sheet".to_string();
    }
    if trimmed.eq_ignore_ascii_case(RESERVED_SHEET_NAME) {
        // One character shorter than the limit is always available here.
        return format!("{}_", trimmed);
    }
    trimmed.to_string()
}

/// A unique, legal name built from `base` — for the app's own generated names.
/// Suffixes are `(2)`, `(3)`, ... , the spelling a sheet COPY uses, and the base is
/// SHORTENED to make room, because `format!("{} ({})", base, n)` on a base that
/// is already 31 characters produces a name the rule would refuse.
pub fn unique_sheet_name(base: &str, existing: &[String]) -> String {
    let base = sanitize_sheet_name(base);
    if ensure_sheet_name_is_free(&base, existing, None).is_ok() {
        return base;
    }
    let mut counter = 2usize;
    loop {
        let suffix = format!(" ({})", counter);
        let room = MAX_SHEET_NAME_CHARS.saturating_sub(suffix.chars().count());
        let stem: String = base.chars().take(room).collect();
        let stem = stem.trim_end().to_string();
        let candidate = format!("{}{}", stem, suffix);
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
        .find(|n| n.eq_ignore_ascii_case(qualifier))?;
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
    fn blank_and_whitespace_only_names_are_refused_and_others_are_trimmed() {
        assert!(validate_sheet_name("").is_err());
        assert!(validate_sheet_name("   ").is_err());
        assert_eq!(validate_sheet_name("  Data  ").as_deref(), Ok("Data"));
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
