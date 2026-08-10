//! FILENAME: app/src-tauri/src/formula_serialisation_tests.rs
//! PURPOSE: A formula that goes out through the AST->text serialiser must come
//!          back as the SAME formula.
//!
//! CONTEXT: Measured 2026-08-10 (register section 3bc). This crate carried a
//! SECOND serialiser -- `expression_to_formula` -- beside the engine's canonical
//! `render_formula_raw`. It had 224 explicit function-name arms and then
//! `other => format!("{:?}", other)`: a DEBUG-FORMAT catch-all covering 247 more
//! built-ins, which printed the Rust variant name instead of the function name.
//!
//! `CELL` was written `CellFn`. `FORECAST` became `ForecastLinear`. `STDEV.S`
//! became `StdevS`. For 47 built-ins the produced text is not an accepted
//! spelling, and re-parsing turned each into `Custom("CELLFN")` -- an unknown
//! user function, i.e. `#NAME?`. Two further arms had simply drifted
//! (`STDEV.P`/`VAR.P` against the canonical `STDEVP`/`VARP`).
//!
//! That mattered because `repair_all_formulas` runs this serialiser over EVERY
//! formula on EVERY sheet whenever a sheet is renamed or deleted, and it stores
//! whatever comes back. So renaming one sheet silently converted every affected
//! formula in the workbook into a broken call -- and, where the two serialisers
//! merely disagreed about text they both round-tripped, rewrote untouched cells
//! for no reason at all.
//!
//! The fix was to delete the duplicate and delegate. This file is the check that
//! keeps it deleted: it enumerates the function catalogue rather than sampling
//! it, so a re-introduced hand-maintained table fails here on the first function
//! it forgets.

use parser::ast::BuiltinFunction;

/// Every built-in the catalogue knows about. `all_catalog_entries` is the
/// documented single source of truth for the function list, so enumerating it is
/// what makes this a census instead of a sample.
fn catalogue_names() -> Vec<&'static str> {
    BuiltinFunction::all_catalog_entries()
        .into_iter()
        .map(|meta| meta.name)
        .collect()
}

#[test]
fn every_builtin_function_survives_serialisation_as_itself() {
    let names = catalogue_names();
    assert!(
        names.len() > 400,
        "only {} catalogue entries -- the enumeration is broken, not the crate",
        names.len()
    );

    let mut broken: Vec<String> = Vec::new();
    for name in &names {
        // A bare no-argument call is enough: the defect was entirely in how the
        // function NAME was written, and every name is exercised.
        let source = format!("={}()", name);
        let Ok(parsed) = parser::parse(&source) else {
            // A handful of catalogue entries are not callable in this bare form
            // (they need arguments to parse at all). They cannot exercise the
            // name path, so they are not evidence either way.
            continue;
        };
        let rendered = crate::expression_to_formula(&parsed);
        let Ok(reparsed) = parser::parse(&format!("={}", rendered)) else {
            broken.push(format!("{} -> `{}` (does not re-parse)", name, rendered));
            continue;
        };
        if parsed != reparsed {
            broken.push(format!(
                "{} -> `{}` -> a DIFFERENT function ({:?})",
                name,
                rendered,
                function_of(&reparsed)
            ));
        }
    }

    assert!(
        broken.is_empty(),
        "{} of {} built-in functions do not survive the AST->text->AST round \
         trip:\n  {}\n\nThis is the `CellFn` / `ForecastLinear` class: the \
         serialiser wrote something that is not the function's name, so \
         re-parsing produced an unknown `Custom(..)` call. Renaming or deleting \
         a sheet runs every formula in the workbook through this.",
        broken.len(),
        names.len(),
        broken.join("\n  ")
    );
}

fn function_of(expr: &parser::ast::Expression) -> Option<String> {
    match expr {
        parser::ast::Expression::FunctionCall { func, .. } => {
            Some(format!("{:?}", func))
        }
        _ => None,
    }
}

#[test]
fn a_builtin_never_serialises_to_a_custom_function() {
    // The sharpest statement of the same rule, and the one whose failure the
    // old code produced silently: `Custom(..)` means "a user-defined function
    // by this name", so a built-in that renders into one becomes `#NAME?` --
    // no error at render time, no error at parse time, just a dead formula.
    let mut demoted: Vec<String> = Vec::new();
    for name in catalogue_names() {
        let Ok(parsed) = parser::parse(&format!("={}()", name)) else {
            continue;
        };
        // Only interested in names the parser recognises as built-in to begin
        // with; a catalogue alias that is genuinely Custom is not a regression.
        if matches!(
            &parsed,
            parser::ast::Expression::FunctionCall { func: BuiltinFunction::Custom(_), .. }
        ) {
            continue;
        }
        let rendered = crate::expression_to_formula(&parsed);
        if let Ok(parser::ast::Expression::FunctionCall {
            func: BuiltinFunction::Custom(got),
            ..
        }) = parser::parse(&format!("={}", rendered))
        {
            demoted.push(format!("{} -> `{}` -> Custom(\"{}\")", name, rendered, got));
        }
    }
    assert!(
        demoted.is_empty(),
        "{} built-ins were demoted to unknown user functions:\n  {}",
        demoted.len(),
        demoted.join("\n  ")
    );
}

#[test]
fn the_app_crate_has_no_second_serialiser() {
    // The duplicate is gone; this keeps it gone. A hand-maintained name table
    // drifts -- that is not a hypothesis, it is what happened: 247 functions
    // fell through to a debug-format catch-all and two more had been edited on
    // one side only.
    let lib = include_str!("lib.rs");
    for banned in [
        "fn builtin_function_to_name",
        "fn expression_to_formula_no_sheet",
        "fn table_specifier_to_string",
    ] {
        assert!(
            !lib.contains(banned),
            "`{}` is back in lib.rs. AST->text has ONE implementation \
             (`engine::ast_render`); `expression_to_formula` must stay a \
             delegation to it.",
            banned
        );
    }
    assert!(
        lib.contains("engine::ast_render::render_formula_raw(expr)"),
        "expression_to_formula no longer delegates to the canonical renderer"
    );
}

#[test]
fn the_two_serialisers_that_remain_are_the_same_function() {
    // `repair_all_formulas` compares one serialiser's output against the
    // other's and REWRITES the cell when they differ, so any disagreement is a
    // silent edit to formulas that have nothing to do with the sheet being
    // renamed. Equality is now structural, but assert it on real formulas so
    // the property is stated where a future change would break it.
    for source in [
        "=SUM(A1:A10)",
        "=(A1+B1)*C1",
        "=CELL(\"row\",A1)",
        "=FORECAST(A1,B1:B9,C1:C9)",
        "=STDEV.S(A1:A9)",
        "=VAR.P(A1:A9)",
        "='My Sheet'!A1",
        "=IF(A1>0,\"y\",\"n\")",
    ] {
        let ast = parser::parse(source).expect("parses");
        assert_eq!(
            crate::expression_to_formula(&ast),
            engine::ast_render::render_formula_raw(&ast),
            "the two spellings of AST->text disagree on {}",
            source
        );
    }
}

// ---------------------------------------------------------------------------
// Deleting a sheet must break the references to it, not leave them readable
// ---------------------------------------------------------------------------

#[test]
fn deleting_a_sheet_turns_plain_cross_sheet_references_into_ref() {
    // `repair_3d_delete_recursive` handled ONLY `Sheet3DRef`; `CellRef`,
    // `ColumnRef`, `RowRef` and a sheet-qualified `Range` all fell through to
    // its leaf arm, so `=Sheet2!A1` survived Sheet2's deletion verbatim. The
    // rename twin had always handled all four -- the asymmetry was the tell.
    let after = vec!["Sheet1".to_string(), "Sheet3".to_string()];
    for formula in [
        "=Sheet2!A1",
        "=SUM(Sheet2!A1:B2)",
        "=Sheet2!A:A",
        "=Sheet2!1:1",
        "=Sheet2!A1+Sheet1!A1",
    ] {
        assert_eq!(
            crate::repair_3d_refs_on_delete(formula, "Sheet2", &after),
            None,
            "`{}` must become #REF! when Sheet2 is deleted",
            formula
        );
    }
}

#[test]
fn deleting_a_sheet_leaves_references_to_other_sheets_alone() {
    // The guard must not turn every cross-sheet formula in the workbook into
    // #REF! -- which is the obvious way to get the test above to pass.
    let after = vec!["Sheet1".to_string(), "Sheet3".to_string()];
    for formula in ["=Sheet1!A1", "=SUM(Sheet3!A1:B2)", "=A1+B1"] {
        assert!(
            crate::repair_3d_refs_on_delete(formula, "Sheet2", &after).is_some(),
            "`{}` does not mention Sheet2 and must survive its deletion",
            formula
        );
    }
}

// ---------------------------------------------------------------------------
// Sheet names that are not bare identifiers
// ---------------------------------------------------------------------------

#[test]
fn renaming_a_sheet_to_an_awkward_name_does_not_destroy_the_formulas() {
    // `repair_all_formulas` stores `parser::parse(&new_formula).ok()`, so a
    // formula that fails to re-parse loses its AST ENTIRELY and is left as a
    // stale literal value with an empty formula bar. The old quoting rule
    // (space or apostrophe, never escaped) produced exactly that for any name
    // containing an apostrophe, a hyphen, or a leading digit.
    for name in ["John's", "Q1-2026", "2026", "My Sheet", "a b'c"] {
        let repaired = crate::repair_3d_refs_on_rename("=Sheet1!A1", "Sheet1", name);
        let parsed = parser::parse(&repaired).unwrap_or_else(|e| {
            panic!(
                "renaming to `{}` produced `{}`, which does not parse ({:?}) -- \
                 the formula would be destroyed",
                name, repaired, e
            )
        });
        match parsed {
            parser::ast::Expression::CellRef { sheet: Some(got), .. } => assert_eq!(
                got, name,
                "renaming to `{}` produced `{}`, which reads back as a different sheet",
                name, repaired
            ),
            other => panic!("renaming to `{}` produced {:?}", name, other),
        }
    }
}

// ---------------------------------------------------------------------------
// Named LAMBDA calls must survive a sheet operation
// ---------------------------------------------------------------------------

#[test]
fn a_named_lambda_call_survives_a_sheet_rename() {
    // `repair_all_formulas` used to read `formula_string()`, the DISPLAY form,
    // which collapses `__INVOKE__("MyFn", <lambda>, args)` down to `MyFn(args)`.
    // Repairing that and re-parsing gave `Custom("MYFN")` with no lambda -- and
    // because the upper-cased result differs from the mixed-case original, the
    // cell was rewritten. So renaming ANY sheet destroyed every named-function
    // call in the workbook, including calls on sheets the rename never touched.
    let raw = "=__INVOKE__(\"MyFn\",LAMBDA(x,x*2),Sheet1!A1)";
    let repaired = crate::repair_3d_refs_on_rename(raw, "Sheet1", "Data");
    let reparsed = parser::parse(&repaired).expect("the repaired formula must parse");

    let rendered = engine::ast_render::render_formula_raw(&reparsed);
    assert!(
        rendered.contains("__INVOKE__") && rendered.contains("LAMBDA"),
        "the resolved lambda was lost by the repair: `{}`",
        rendered
    );
    assert!(
        rendered.contains("Data!A1") || rendered.contains("DATA!A1"),
        "the rename did not reach the reference inside the call: `{}`",
        rendered
    );
}

#[test]
fn the_repair_reads_the_raw_formula_not_the_display_form() {
    // The unit-level statement of the same rule. A repair that is a NO-OP must
    // produce text identical to what it was given, or `repair_all_formulas`
    // rewrites the cell -- and rewriting it is what loses the lambda.
    let raw = "=__INVOKE__(\"MyFn\",LAMBDA(x,x*2),A1)";
    let ast = parser::parse(raw).expect("parses");
    let raw_text = engine::ast_render::render_formula_raw(&ast);
    let round_tripped = crate::repair_3d_refs_on_rename(
        &format!("={}", raw_text),
        "NoSuchSheet",
        "Irrelevant",
    );
    assert_eq!(
        round_tripped,
        format!("={}", raw_text),
        "a repair that changes nothing must return the formula unchanged"
    );
}

#[test]
fn repair_all_formulas_preserves_a_named_lambda_call_it_does_not_need_to_touch() {
    // THE FIX SITE. `repair_all_formulas` reads each cell's formula, hands the
    // text to the repair, and stores the result when it differs. Reading the
    // DISPLAY form made a no-op repair look like a change for every named
    // LAMBDA call in the workbook -- `MyFn(A1)` in, `MYFN(A1)` out -- so the
    // cell was rewritten and the resolved lambda thrown away.
    let mut grid = engine::Grid::new();
    let invoke = "=__INVOKE__(\"MyFn\",LAMBDA(x,x*2),A1)";
    grid.set_cell(0, 1, engine::Cell::new_formula(invoke.to_string()));
    grid.set_cell(0, 2, engine::Cell::new_formula("=SUM(A1:A9)".to_string()));
    let mut grids = vec![grid];

    // A rename of a sheet this workbook never mentions: nothing should change.
    crate::repair_all_formulas(&mut grids, &|formula| {
        Some(crate::repair_3d_refs_on_rename(formula, "NoSuchSheet", "Irrelevant"))
    });

    let cell = grids[0].get_cell(0, 1).expect("the named call must still exist");
    let stored = cell
        .formula_string_raw()
        .expect("the cell must still be a formula, not a bare value");
    assert!(
        stored.contains("__INVOKE__") && stored.contains("LAMBDA"),
        "the resolved lambda was destroyed by a repair that changed nothing: `{}`",
        stored
    );
    // And the ordinary formula beside it is untouched too.
    assert_eq!(
        grids[0].get_cell(0, 2).and_then(|c| c.formula_string_raw()),
        Some("SUM(A1:A9)".to_string())
    );
}

// ---------------------------------------------------------------------------
// A repair that changes NOTHING must return the caller's own text
//
// Found live 2026-08-10 by driving `rename_sheet` through the running app:
// `=Anchor` came back `=ANCHOR` and a named LAMBDA's `refers_to`, authored as
// `=LAMBDA(x, x*2)`, came back `=LAMBDA(X,X*2)`. Both repairs re-render the
// whole formula whether or not they touched it, and the render is NOT the
// identity on text a user typed -- the lexer upper-cases every bare identifier.
// `repair_all_formulas` then sees text that DIFFERS from what it was given and
// rewrites the cell, so renaming or deleting ANY sheet re-spelled every defined
// name in the workbook, on every sheet, including ones the operation never
// mentioned. That is exactly section 2t (`BudgetTotal` -> `BUDGETTOTAL`) on a
// path section 2t's fix does not reach: `restamp_workbook_name_casing` is
// called from `open_file`.
// ---------------------------------------------------------------------------

#[test]
fn a_rename_that_touches_nothing_leaves_a_defined_names_spelling_alone() {
    let original = "=Anchor*2";
    let repaired = crate::repair_3d_refs_on_rename(original, "NoSuchSheet", "Irrelevant");
    assert_eq!(
        repaired, original,
        "a rename that mentions no sheet in this formula re-spelled the user's \
         defined name; `repair_all_formulas` stores whatever this returns, so the \
         formula bar now SHOUTS a name the Name Manager spells differently"
    );
}

#[test]
fn a_delete_that_touches_nothing_leaves_a_defined_names_spelling_alone() {
    let original = "=Anchor*2";
    let repaired = crate::repair_3d_refs_on_delete(
        original,
        "NoSuchSheet",
        &["Sheet1".to_string()],
    )
    .expect("a formula naming no deleted sheet must not become #REF!");
    assert_eq!(repaired, original, "the delete path has the same defect as the rename path");
}

#[test]
fn a_rename_that_touches_nothing_leaves_a_lambda_parameter_alone() {
    // A defined name's `refers_to` goes through the same repair, and a LAMBDA
    // parameter is a LOCAL binding -- the one thing section 2t's restamp
    // deliberately refuses to re-spell, because renaming a local after a
    // workbook name that merely collides with it tells the reader something
    // false. Re-rendering it does exactly that.
    let original = "=LAMBDA(x, x*2)";
    let repaired = crate::repair_3d_refs_on_rename(original, "NoSuchSheet", "Irrelevant");
    assert_eq!(
        repaired, original,
        "renaming an unrelated sheet rewrote a named LAMBDA's parameter to \
         capitals in the Name Manager"
    );
}

#[test]
fn a_rename_that_does_touch_the_formula_still_repairs_it() {
    // THE COUNTERWEIGHT. The preservation above must not be bought by making
    // the repair a no-op: a formula that really does name the renamed sheet has
    // to follow it.
    let repaired = crate::repair_3d_refs_on_rename("=Data!A1+Anchor", "Data", "Facts");
    assert!(
        repaired.to_uppercase().contains("FACTS!A1"),
        "the rename did not reach the reference it was for: `{}`",
        repaired
    );
    assert_ne!(repaired, "=Data!A1+Anchor", "nothing was repaired at all");
}

#[test]
fn a_delete_that_does_touch_the_formula_still_produces_a_ref_error() {
    assert_eq!(
        crate::repair_3d_refs_on_delete("=Gone!A1", "Gone", &["Sheet1".to_string()]),
        None,
        "a reference to the deleted sheet must still become #REF!",
    );
}

// ---------------------------------------------------------------------------
// A CENSUS, not a list of names: every caller of the whole-workbook formula
// repair must also restamp the name casing.
//
// The two defects above were fixed at two call sites. That is exactly the shape
// this register keeps filing against -- a rule kept in someone's head, holding
// only until a third caller appears. `repair_all_formulas` re-renders formula
// text through the lexer's upper-casing, so ANY future caller re-spells every
// defined name in the workbook unless it runs the same restamp `open_file`
// runs. This fails by name when one does not.
// ---------------------------------------------------------------------------

/// Bodies of the free functions in a Rust source, keyed by name.
///
/// Free functions only: an `impl` block's methods are skipped, for the same
/// reason the recalculation census skips them -- `fn drop` would otherwise
/// resolve as every `drop(guard)` in the file.
fn free_function_bodies(text: &str) -> Vec<(String, String)> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while let Some(rel) = text[i..].find("\nfn ").or_else(|| text[i..].find("\npub fn ")) {
        let start = i + rel + 1;
        let after_fn = match text[start..].find("fn ") {
            Some(k) => start + k + 3,
            None => break,
        };
        let name_end = text[after_fn..]
            .find(|c: char| !(c.is_alphanumeric() || c == '_'))
            .map(|k| after_fn + k)
            .unwrap_or(text.len());
        let name = text[after_fn..name_end].to_string();
        // Walk braces from the first `{` after the signature to its match.
        let Some(open_rel) = text[name_end..].find('{') else { break };
        let open = name_end + open_rel;
        let mut depth = 0i32;
        let mut j = open;
        while j < bytes.len() {
            match bytes[j] {
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                _ => {}
            }
            j += 1;
        }
        let end = j.min(text.len());
        out.push((name, text[open..end].to_string()));
        i = end;
    }
    out
}

#[test]
fn every_caller_of_the_workbook_formula_repair_restamps_the_name_casing() {
    const SHEETS_RS: &str = include_str!("sheets.rs");
    const LIB_RS: &str = include_str!("lib.rs");

    // The repair itself lives in lib.rs; its own definition is not a caller.
    let mut offenders: Vec<String> = Vec::new();
    let mut callers = 0usize;
    for (file, text) in [("sheets.rs", SHEETS_RS), ("lib.rs", LIB_RS)] {
        for (name, body) in free_function_bodies(text) {
            if name == "repair_all_formulas" {
                continue;
            }
            let calls_repair = body.contains("repair_all_formulas(");
            if !calls_repair {
                continue;
            }
            callers += 1;
            if !body.contains("restamp_workbook_name_casing") {
                offenders.push(format!("{}::{}", file, name));
            }
        }
    }

    assert!(
        callers >= 2,
        "the census found {} callers of `repair_all_formulas`, so it is not \
         reading the crate it thinks it is -- `delete_sheet` and `rename_sheet` \
         are both callers and both must be visible here",
        callers
    );
    assert!(
        offenders.is_empty(),
        "these functions run the whole-workbook formula repair and do NOT \
         restamp the name casing afterwards:\n  {}\n\nThe repair re-renders \
         formula text, and the lexer upper-cases every bare identifier, so \
         `=Anchor*2` is stored back as `=ANCHOR*2` -- section 2t's defect \
         (`BudgetTotal` -> `BUDGETTOTAL`) on a path section 2t's fix does not \
         reach. Call `crate::persistence::restamp_workbook_name_casing(&state, \
         &effect)` after the repair, once every grid lock is released.",
        offenders.join("\n  ")
    );
}

#[test]
fn the_restamp_census_can_see_a_caller_that_forgets() {
    // TEETH for the census above. A census nobody has watched fail is a
    // comment. This feeds it a caller that skips the restamp and requires it to
    // be reported by name.
    const SABOTAGED: &str = r#"
pub fn rename_sheet_lookalike(state: &AppState) {
    crate::repair_all_formulas(&mut grids, &|f| Some(f.to_string()));
    crate::undo_commands::rebuild_all_dependencies(state);
}

pub fn delete_sheet_lookalike(state: &AppState) {
    crate::repair_all_formulas(&mut grids, &|f| Some(f.to_string()));
    crate::persistence::restamp_workbook_name_casing(state, &effect);
}
"#;
    let flagged: Vec<String> = free_function_bodies(SABOTAGED)
        .into_iter()
        .filter(|(_, body)| body.contains("repair_all_formulas("))
        .filter(|(_, body)| !body.contains("restamp_workbook_name_casing"))
        .map(|(name, _)| name)
        .collect();
    assert_eq!(
        flagged,
        vec!["rename_sheet_lookalike".to_string()],
        "the census does not distinguish a caller that restamps from one that \
         does not, so it would pass on the defect it exists to catch"
    );
}
