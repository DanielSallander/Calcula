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

/// Every `.rs` under `src/`, so the scan cannot be fooled by a new file.
fn crate_sources() -> Vec<(std::path::PathBuf, String)> {
    fn walk(dir: &std::path::Path, out: &mut Vec<(std::path::PathBuf, String)>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    out.push((path, text));
                }
            }
        }
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut out = Vec::new();
    walk(&root, &mut out);
    assert!(out.len() > 50, "source walk found only {} files", out.len());
    out
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

/// Drop `//` line comments (including doc comments) so a scan for a code SHAPE
/// is not fooled by prose that describes it. Both surviving `format!("{:?}")`
/// mentions in this crate are doc comments explaining the defect being guarded
/// against, and the first version of this test flagged them.
fn without_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        let bytes = line.as_bytes();
        let mut in_string = false;
        let mut cut = line.len();
        let mut i = 0;
        while i < bytes.len() {
            match bytes[i] {
                b'\\' if in_string => i += 1,
                b'"' => in_string = !in_string,
                b'/' if !in_string && i + 1 < bytes.len() && bytes[i + 1] == b'/' => {
                    cut = i;
                    break;
                }
                _ => {}
            }
            i += 1;
        }
        out.push_str(&line[..cut]);
        out.push('\n');
    }
    out
}

/// The PROPERTY, not three function names.
///
/// The test above scanned ONE file (`lib.rs`) for THREE identifiers, and that is
/// exactly how it missed the real thing: `evaluate_formula.rs` held a complete
/// second renderer (`build_display` / `builtin_fn_name` /
/// `table_specifier_to_display`) and `formula_eval_plan.rs` a third
/// (`build_spans_recursive`), under different names, in different files. Between
/// them they printed 248 of the enum's 472 functions under their RUST VARIANT
/// NAME and dropped every parenthesis. Both are now delegations.
///
/// So this scans the whole crate for the SHAPE of a name table instead:
/// `BuiltinFunction::Name => "TEXT"` arms in bulk, and a Debug-format fallback
/// in a file that is spelling function names by hand. `to_canonical_name` in
/// `parser::ast` is the one place allowed to spell a function name, and the
/// compiler already proves it total over the enum.
///
/// The Debug check is DELIBERATELY conditional on the file also carrying
/// `BuiltinFunction::X => "..."` arms. `calp_commands.rs` has a documented
/// `other => format!("{:?}", other)` over `engine::CellValue` for override
/// comparison, which is a different enum and not this defect; a blanket ban on
/// `{:?}` would have made this test fail for a reason it is not about, and a
/// test that cries wolf gets deleted.
#[test]
fn no_file_in_the_crate_rebuilds_the_function_name_table() {
    // A handful of arms is a legitimate special case (routing IF, naming a
    // couple of volatile functions). Twenty is a table.
    const TABLE_THRESHOLD: usize = 20;
    // Three is already "spelling names by hand" for the purposes of the Debug
    // check below, which only asks whether a fallback sits beside such arms.
    const HAND_SPELLING_THRESHOLD: usize = 3;

    let mut offenders: Vec<String> = Vec::new();
    for (path, raw) in crate_sources() {
        let file = path.file_name().unwrap().to_string_lossy().to_string();
        // This file quotes the banned shapes in order to ban them.
        if file == "formula_serialisation_tests.rs" {
            continue;
        }
        let text = without_comments(&raw);

        let arms = text
            .match_indices("BuiltinFunction::")
            .filter(|(i, _)| {
                let rest = &text[*i..];
                // `BuiltinFunction::Foo => "BAR"` on one line.
                let line_end = rest.find('\n').unwrap_or(rest.len());
                let line = &rest[..line_end];
                line.contains("=>") && line.contains('"')
            })
            .count();

        if arms >= TABLE_THRESHOLD {
            offenders.push(format!(
                "{} has {} `BuiltinFunction::X => \"NAME\"` arms -- that is a \
                 second name table",
                file, arms
            ));
        }

        // A Debug-format fallback is how the 248 leaked: the table covered what
        // someone remembered and `{:?}` silently covered the rest.
        if arms >= HAND_SPELLING_THRESHOLD {
            for marker in ["format!(\"{:?}\", other)", "format!(\"{:?}\", func)"] {
                if text.contains(marker) {
                    offenders.push(format!(
                        "{} spells function names by hand ({} arms) AND contains \
                         `{}` -- the fallback prints Rust variant names for every \
                         variant the table forgot",
                        file, arms, marker
                    ));
                }
            }
        }
    }

    assert!(
        offenders.is_empty(),
        "AST->text and function naming have ONE implementation \
         (`engine::ast_render` / `BuiltinFunction::to_canonical_name`):\n  {}",
        offenders.join("\n  ")
    );
}

/// The Evaluate-Formula surface must SHOW what the formula bar shows.
///
/// Made to fail first against the old walker: `(A1+B1)*C1` came back
/// `A1+B1*C1` and `VLOOKUP(...)` came back `VLookup(...)`.
#[test]
fn the_evaluate_formula_display_is_the_canonical_text() {
    let corpus = [
        "=(A1+B1)*C1",
        "=A1+B1*C1",
        "=(A1+B1)/(C1-D1)",
        "=-(A1+B1)",
        "=(A1^B1)^C1",
        "=A1^(B1^C1)",
        "=VLOOKUP(A1,B:C,2,FALSE)",
        "=STDEV.S(A1:A9)",
        "=NORM.DIST(1,0,1,TRUE)",
        "=T.DIST.2T(1,2)",
        "=XMATCH(A1,B1:B9)",
        "=TEXTSPLIT(A1,\",\")",
        "=BIN2DEC(A1)",
        "=CELL(\"row\",A1)",
        "=SUM(Sales[[#Data],[Revenue]])",
        "=SUM(Sales[[Revenue]:[Cost]])",
        "=IF(A1>0,\"y\",\"n\")",
        "='My Sheet'!A1",
        "=(A1&B1)&C1",
        "=SUM((A1+B1)*C1,D1)",
    ];
    for source in corpus {
        let ast = parser::parse(&source[1..])
            .unwrap_or_else(|e| panic!("corpus formula {} does not parse: {}", source, e));
        let canonical = engine::ast_render::render_formula_raw(&ast);
        let (shown, _, _) = crate::evaluate_formula::build_display(&ast, &[]);
        assert_eq!(
            shown, canonical,
            "Evaluate Formula shows text the formula bar does not, for {}",
            source
        );
        // And the text must still be the same formula.
        let reparsed = parser::parse(&shown)
            .unwrap_or_else(|e| panic!("displayed text {} does not re-parse: {}", shown, e));
        assert_eq!(
            engine::ast_render::render_formula_raw(&reparsed),
            canonical,
            "displayed text {} re-parses to a DIFFERENT formula",
            shown
        );
    }
}

/// Every span must be a real slice of the text it was computed from.
///
/// The old walkers computed offsets against their own (wrong) string, so the
/// "currently evaluating" underline could land on a different sub-expression
/// than the one being evaluated.
#[test]
fn every_span_is_a_valid_slice_of_the_rendered_text() {
    for source in [
        "(A1+B1)*C1",
        "SUM(A1:A10)+MAX(B1:B9)",
        "IF(A1>0,SUM(B1:B9),-C1)",
        "-(A1+B1)^2",
        "SUM('My Sheet'!A1:A9)",
    ] {
        let ast = parser::parse(source).unwrap();
        let (text, spans) = engine::ast_render::render_with_spans(&ast, false);
        assert_eq!(text, engine::ast_render::render_formula_raw(&ast));
        assert!(!spans.is_empty(), "no spans for {}", source);
        for (path, (start, end)) in &spans {
            assert!(
                start <= end && *end <= text.len(),
                "span {:?} for path {:?} is out of range in {:?}",
                (start, end),
                path,
                text
            );
            assert!(
                text.is_char_boundary(*start) && text.is_char_boundary(*end),
                "span {:?} for path {:?} splits a character in {:?}",
                (start, end),
                path,
                text
            );
            // The root span must cover everything.
            if path.is_empty() {
                assert_eq!((*start, *end), (0, text.len()), "root span for {}", source);
            }
        }
    }
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
    })
    .expect("a repair that changes nothing cannot refuse");

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
/// resolve as every `drop(guard)` in the file. "Free" is decided by COLUMN: a
/// declaration that starts at the left margin is a free function, an indented
/// one is a method or a nested helper.
///
/// TWO BUGS THIS FIXES, both found 2026-08-10 by censuses that reported
/// impossible numbers ("0 rebuilders" in a file with five, and one 6,500-line
/// function in a file whose longest is 400):
///
/// 1. THE SPELLINGS. It searched `find("\nfn ").or_else(|| find("\npub fn "))`.
///    `or_else` only runs when the first search finds NOTHING ANYWHERE AHEAD, so
///    in any file with a private `fn` after a `pub fn`, every `pub fn` before it
///    was skipped -- and its body attributed to whichever function the walker
///    did find. `pub(crate) fn` and `pub(super) fn` were invisible outright,
///    which is most of `commands/structure.rs`.
///
/// 2. THE BRACES. It counted `{` and `}` as raw bytes, including inside string
///    literals and comments. `commands/data.rs` contains a string with an
///    unbalanced brace, so `update_cell_impl` swallowed the next 6,000 lines --
///    thirty other functions -- and every census reading it reported THEIR
///    contents under ITS name. A census that names the wrong function is worse
///    than no census: the offender it prints does not contain the offence.
/// `pub(crate)` so a census in another test module reuses THIS walker rather
/// than growing a second one. The two defects recorded above are the reason:
/// both were in the walking, not in the question being asked, so every copy of
/// the walker is a copy of the bugs waiting to be re-found.
pub(crate) fn free_function_bodies(text: &str) -> Vec<(String, String)> {
    const PREFIXES: [&str; 8] = [
        "fn ",
        "async fn ",
        "pub fn ",
        "pub async fn ",
        "pub(crate) fn ",
        "pub(crate) async fn ",
        "pub(super) fn ",
        "pub(super) async fn ",
    ];
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < text.len() {
        // The next declaration at the LEFT MARGIN, whichever spelling comes
        // first in the file -- not whichever spelling is checked first.
        let next = text[i..].match_indices('\n').find_map(|(rel, _)| {
            let line_start = i + rel + 1;
            let rest = &text[line_start..];
            PREFIXES
                .iter()
                .find(|p| rest.starts_with(**p))
                .map(|p| (line_start, *p))
        });
        let Some((line_start, prefix)) = next else { break };
        let after_fn = line_start + prefix.len();
        let name_end = text[after_fn..]
            .find(|c: char| !(c.is_alphanumeric() || c == '_'))
            .map(|k| after_fn + k)
            .unwrap_or(text.len());
        let name = text[after_fn..name_end].to_string();
        let Some(open) = find_body_open_brace(text, name_end) else { break };
        let end = match_closing_brace(text, open);
        out.push((name, text[open..end].to_string()));
        i = end;
    }
    out
}

/// The `{` that opens a function body, skipping any brace that is really part
/// of a string, a comment or a `'{'` literal in the signature.
fn find_body_open_brace(text: &str, from: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut i = from;
    while i < bytes.len() {
        if let Some(next) = skip_non_code(text, i) {
            i = next;
            continue;
        }
        if bytes[i] == b'{' {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Index one past the `}` that closes the block opened at `open`.
fn match_closing_brace(text: &str, open: usize) -> usize {
    let bytes = text.as_bytes();
    let mut depth = 0i32;
    let mut i = open;
    while i < bytes.len() {
        if let Some(next) = skip_non_code(text, i) {
            i = next;
            continue;
        }
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return i + 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    bytes.len()
}

/// If `i` starts a comment, string, raw string or character literal, return the
/// index just past it. Otherwise `None`, meaning "this byte is code".
fn skip_non_code(text: &str, i: usize) -> Option<usize> {
    let b = text.as_bytes();
    if b[i] == b'/' && i + 1 < b.len() {
        if b[i + 1] == b'/' {
            return Some(text[i..].find('\n').map(|k| i + k + 1).unwrap_or(b.len()));
        }
        if b[i + 1] == b'*' {
            let mut j = i + 2;
            let mut depth = 1i32;
            while j + 1 < b.len() {
                if b[j] == b'/' && b[j + 1] == b'*' {
                    depth += 1;
                    j += 2;
                } else if b[j] == b'*' && b[j + 1] == b'/' {
                    depth -= 1;
                    j += 2;
                    if depth == 0 {
                        return Some(j);
                    }
                } else {
                    j += 1;
                }
            }
            return Some(b.len());
        }
    }
    // Raw string: r"..." / r#"..."# / br#"..."#
    let raw_start = if b[i] == b'r' {
        Some(i + 1)
    } else if b[i] == b'b' && i + 1 < b.len() && b[i + 1] == b'r' {
        Some(i + 2)
    } else {
        None
    };
    if let Some(after_r) = raw_start {
        let mut hashes = 0usize;
        let mut j = after_r;
        while j < b.len() && b[j] == b'#' {
            hashes += 1;
            j += 1;
        }
        if j < b.len() && b[j] == b'"' {
            let terminator = format!("\"{}", "#".repeat(hashes));
            return Some(
                text[j + 1..]
                    .find(&terminator)
                    .map(|k| j + 1 + k + terminator.len())
                    .unwrap_or(b.len()),
            );
        }
    }
    if b[i] == b'"' {
        let mut j = i + 1;
        while j < b.len() {
            match b[j] {
                b'\\' => j += 2,
                b'"' => return Some(j + 1),
                _ => j += 1,
            }
        }
        return Some(b.len());
    }
    // A character literal, but NOT a lifetime (`'a`). `'{'` and `'\''` are the
    // shapes that matter here.
    if b[i] == b'\'' && i + 2 < b.len() {
        if b[i + 1] == b'\\' {
            let mut j = i + 2;
            while j < b.len() && b[j] != b'\'' {
                j += 1;
            }
            return Some(j + 1);
        }
        if b[i + 2] == b'\'' {
            return Some(i + 3);
        }
    }
    None
}

#[test]
fn the_function_walker_sees_every_spelling_of_a_free_function() {
    // TEETH for the walker itself. It is the instrument four censuses read
    // through, and it was wrong: `pub fn` before a private `fn` was skipped and
    // its body attributed to the wrong name, and `pub(crate) fn` was invisible.
    const SOURCE: &str = "
pub fn first(x: u32) -> u32 {
    ONE
}

pub(crate) fn second() {
    TWO
}

fn third() {
    THREE
}

pub(super) async fn fourth() {
    FOUR
}

impl Thing {
    pub fn method_should_be_skipped(&self) {
        METHOD
    }
}
";
    let found = free_function_bodies(SOURCE);
    let names: Vec<&str> = found.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(names, vec!["first", "second", "third", "fourth"]);
    // And each body is its OWN body -- the failure mode was attribution, not
    // just omission.
    for (name, body) in &found {
        let expected = match name.as_str() {
            "first" => "ONE",
            "second" => "TWO",
            "third" => "THREE",
            _ => "FOUR",
        };
        assert!(body.contains(expected), "{} got the wrong body: {}", name, body);
        assert!(!body.contains("METHOD"), "{} swallowed an impl method", name);
    }
}

#[test]
fn the_function_walker_is_not_fooled_by_a_brace_inside_a_string_or_a_comment() {
    // THE SECOND WALKER BUG, and the one with the bigger blast radius: raw brace
    // counting made `update_cell_impl` in `commands/data.rs` 6,500 lines long,
    // swallowing thirty other functions, because one string literal in it
    // carries an unbalanced brace. Every census reading that walker then
    // reported those thirty functions' contents under one wrong name.
    const SOURCE: &str = r####"
pub fn opens_a_brace_in_a_string() {
    let s = "a lone { brace";
    let c = '{';
    // a } in a comment
    /* and a { in a block comment */
    let raw = r#"and a } in a raw string"#;
    FIRST
}

fn the_one_after_it() {
    SECOND
}
"####;
    let found = free_function_bodies(SOURCE);
    let names: Vec<&str> = found.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(
        names,
        vec!["opens_a_brace_in_a_string", "the_one_after_it"],
        "the walker lost a function to a brace that is not code"
    );
    assert!(found[0].1.contains("FIRST") && !found[0].1.contains("SECOND"));
    assert!(found[1].1.contains("SECOND"));
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

// ---------------------------------------------------------------------------
// THE `.ok()` SWALLOW (register §3bc). A repaired formula that cannot be read
// back used to be stored as `ast = None` -- a cell holding a stale value with an
// EMPTY formula bar and no error anywhere. That swallow is why every renderer
// defect above was SILENT: each produced text that would not lex, and each was
// turned into a quietly deleted formula instead of a visible failure.
//
// Excel refuses the operation rather than corrupting the workbook, so the repair
// is now PLAN-THEN-COMMIT: nothing is written unless everything re-parses.
// ---------------------------------------------------------------------------

/// A repair that mangles exactly one formula and leaves the rest alone.
fn breaking_repair(formula: &str) -> Option<String> {
    if formula.contains("SUM") {
        // Text that cannot lex: an unclosed call.
        Some("=SUM(".to_string())
    } else {
        Some(formula.to_string())
    }
}

#[test]
fn a_repair_whose_text_cannot_be_read_back_refuses_instead_of_deleting_the_formula() {
    let mut grid = engine::Grid::new();
    grid.set_cell(0, 0, engine::Cell::new_formula("=SUM(A2:A9)".to_string()));
    let mut grids = vec![grid];

    let refusal = crate::repair_all_formulas(&mut grids, &breaking_repair)
        .expect_err("unreadable repaired text must be refused, not stored");

    assert_eq!((refusal.row, refusal.col), (0, 0));
    assert_eq!(refusal.repaired, "=SUM(");
    // THE POINT: the user's formula is still there.
    assert_eq!(
        grids[0].get_cell(0, 0).and_then(|c| c.formula_string_raw()),
        Some("SUM(A2:A9)".to_string()),
        "the formula was swallowed -- this is the `.ok()` defect, which leaves a \
         stale value with an empty formula bar"
    );
}

#[test]
fn a_refusal_writes_nothing_at_all_not_even_the_formulas_that_would_have_survived() {
    // ALL OR NOTHING. A partial rewrite is the worst outcome available: half the
    // workbook follows the operation and half does not, and nothing says which.
    let mut ok_sheet = engine::Grid::new();
    ok_sheet.set_cell(0, 0, engine::Cell::new_formula("=Sheet2!A1".to_string()));
    let mut bad_sheet = engine::Grid::new();
    bad_sheet.set_cell(5, 5, engine::Cell::new_formula("=SUM(B1:B2)".to_string()));
    let mut grids = vec![ok_sheet, bad_sheet];

    let repair = |formula: &str| -> Option<String> {
        if formula.contains("SUM") {
            Some("=SUM(".to_string())
        } else {
            // A real rewrite the good sheet WOULD have taken.
            Some(formula.replace("Sheet2", "Facts"))
        }
    };
    let refusal = crate::repair_all_formulas(&mut grids, &repair).expect_err("must refuse");
    assert_eq!(refusal.sheet_index, 1);

    assert_eq!(
        grids[0].get_cell(0, 0).and_then(|c| c.formula_string_raw()),
        // SHEET2, not Sheet2: the lexer upper-cases a bare SHEET qualifier too,
        // and nothing restamps that (the restamp covers defined names only).
        // Recorded as a separate finding; what this test pins is that the cell
        // holds what it held BEFORE the refused operation.
        Some("SHEET2!A1".to_string()),
        "sheet 1 was rewritten even though the operation was refused"
    );
    assert_eq!(
        grids[1].get_cell(5, 5).and_then(|c| c.formula_string_raw()),
        Some("SUM(B1:B2)".to_string())
    );
}

#[test]
fn the_refusal_message_names_the_sheet_the_cell_and_the_text() {
    // "Visible to whoever can act on it" means the message has to identify the
    // formula. A refusal that says only "something went wrong" is the swallow
    // with extra steps.
    let mut grid = engine::Grid::new();
    grid.set_cell(3, 1, engine::Cell::new_formula("=SUM(A1:A2)".to_string()));
    let mut grids = vec![engine::Grid::new(), grid];

    let refusal =
        crate::repair_all_formulas(&mut grids, &breaking_repair).expect_err("must refuse");
    let message = refusal.message(
        "rename sheet 'Data' to 'Facts'",
        &["Summary".to_string(), "Data".to_string()],
    );
    assert!(message.contains("Data!B4"), "message does not name the cell: {}", message);
    assert!(
        message.contains("rename sheet 'Data' to 'Facts'"),
        "message does not name the operation: {}",
        message
    );
    assert!(
        message.contains("Nothing was changed"),
        "message does not tell the user the workbook is intact: {}",
        message
    );
}

#[test]
fn the_pre_flight_agrees_with_the_repair_and_writes_nothing() {
    let mut grid = engine::Grid::new();
    grid.set_cell(0, 0, engine::Cell::new_formula("=SUM(A2:A9)".to_string()));
    let grids = vec![grid];

    assert!(
        crate::check_formulas_repairable(&grids, &[], &breaking_repair).is_err(),
        "the pre-flight must see what the repair would see"
    );
    // Skipping the only sheet that has the problem makes it pass -- which is
    // exactly what `delete_sheet` needs for the sheet it is about to remove.
    assert!(crate::check_formulas_repairable(&grids, &[0], &breaking_repair).is_ok());
    assert_eq!(
        grids[0].get_cell(0, 0).and_then(|c| c.formula_string_raw()),
        Some("SUM(A2:A9)".to_string()),
        "the pre-flight is not allowed to write"
    );
}

#[test]
fn a_refusal_is_deterministic_when_two_formulas_are_unreadable() {
    // `Grid::cells` is a hash map. Two runs of the same refused operation must
    // name the same cell, or a bug report about it is unreproducible.
    let mut grid = engine::Grid::new();
    grid.set_cell(9, 9, engine::Cell::new_formula("=SUM(A1:A2)".to_string()));
    grid.set_cell(1, 1, engine::Cell::new_formula("=SUM(B1:B2)".to_string()));
    grid.set_cell(4, 4, engine::Cell::new_formula("=SUM(C1:C2)".to_string()));
    let mut grids = vec![grid];

    let first = crate::repair_all_formulas(&mut grids, &breaking_repair).unwrap_err();
    for _ in 0..10 {
        let again = crate::repair_all_formulas(&mut grids, &breaking_repair).unwrap_err();
        assert_eq!(again, first, "the refusal depends on hash order");
    }
    assert_eq!((first.row, first.col), (1, 1), "the lowest cell should be named first");
}

#[test]
fn a_reference_to_a_deleted_sheet_still_becomes_a_ref_error() {
    // THE COUNTERWEIGHT to all of the above: refusing must not have been bought
    // by making the repair timid. `None` from the repair still means `#REF!`.
    let mut grid = engine::Grid::new();
    grid.set_cell(0, 0, engine::Cell::new_formula("=Gone!A1".to_string()));
    grid.set_cell(0, 1, engine::Cell::new_formula("=1+1".to_string()));
    let mut grids = vec![grid];

    crate::repair_all_formulas(&mut grids, &|formula| {
        crate::repair_3d_refs_on_delete(formula, "Gone", &["Sheet1".to_string()])
    })
    .expect("this repair produces readable text everywhere");

    let cell = grids[0].get_cell(0, 0).expect("the cell still exists");
    assert!(cell.ast.is_none(), "a #REF! cell keeps no formula");
    assert_eq!(cell.value, engine::CellValue::Error(engine::CellError::Ref));
    assert_eq!(
        grids[0].get_cell(0, 1).and_then(|c| c.formula_string_raw()),
        Some("1+1".to_string()),
        "the untouched formula beside it was disturbed"
    );
}

// ---------------------------------------------------------------------------
// A CENSUS: every caller of the whole-workbook repair PRE-FLIGHTS it.
//
// The all-or-nothing repair is only half the property. `delete_sheet` runs it
// after it has already removed the sheet from a dozen stores, so "the repair
// wrote nothing" would leave a workbook with the sheet gone and its formulas
// un-repaired. Both callers therefore ask the question BEFORE they mutate, and
// this fails by name when a third one does not.
// ---------------------------------------------------------------------------

#[test]
fn every_caller_of_the_workbook_formula_repair_pre_flights_it() {
    const SHEETS_RS: &str = include_str!("sheets.rs");

    let mut offenders: Vec<String> = Vec::new();
    let mut callers = 0usize;
    for (name, body) in free_function_bodies(SHEETS_RS) {
        if !body.contains("crate::repair_all_formulas(") {
            continue;
        }
        callers += 1;
        if !body.contains("check_workbook_repairable(") {
            offenders.push(name);
        }
    }
    assert_eq!(
        callers, 2,
        "the census expects `delete_sheet` and `rename_sheet` and found {} callers",
        callers
    );
    assert!(
        offenders.is_empty(),
        "these functions run the whole-workbook formula repair without asking \
         first whether it can succeed:\n  {}\n\nThe repair is all-or-nothing, so \
         a caller that has already mutated other state has nothing to refuse \
         INTO -- ask `check_workbook_repairable` before the first mutation and \
         return the refusal.",
        offenders.join("\n  ")
    );
}

#[test]
fn the_pre_flight_census_can_see_a_caller_that_forgets() {
    // TEETH, same shape as the restamp census's.
    const SABOTAGED: &str = "
pub fn delete_sheet_lookalike(state: &AppState) {
    crate::repair_all_formulas(&mut grids, &|f| Some(f.to_string()));
}

pub fn rename_sheet_lookalike(state: &AppState) {
    check_workbook_repairable(&grids, &current_grid, active, None, &repair)?;
    crate::repair_all_formulas(&mut grids, &|f| Some(f.to_string()));
}
";
    let flagged: Vec<String> = free_function_bodies(SABOTAGED)
        .into_iter()
        .filter(|(_, body)| body.contains("crate::repair_all_formulas("))
        .filter(|(_, body)| !body.contains("check_workbook_repairable("))
        .map(|(name, _)| name)
        .collect();
    assert_eq!(flagged, vec!["delete_sheet_lookalike".to_string()]);
}

// ---------------------------------------------------------------------------
// §2t ON THE DISTRIBUTION PATH: a package rebuilds formula ASTs by its own
// route, and that route is `persistence::Sheet::to_grid()` -- stored TEXT
// through the same lexer that upper-cases every bare identifier. Nothing
// restamped it, so a mixed-case defined name arriving in a distributed overlay
// came back SHOUTING, on a path §2t's fix (`open_file`) never reached.
// ---------------------------------------------------------------------------

#[test]
fn rebuilding_a_grid_from_stored_text_is_what_shouts_a_defined_name() {
    // THE MECHANISM, stated where a reader can see it: this is not a claim about
    // `to_grid`, it is a claim about the lexer that every text->AST path uses.
    let parsed = parser::parse("=BudgetTotal*2").expect("parses");
    assert_eq!(
        format!("={}", engine::ast_render::render_formula_raw(&parsed)),
        "=BUDGETTOTAL*2",
        "the lexer no longer upper-cases bare identifiers -- if that is true, the \
         restamp on the pull paths is dead code and should be removed with this test"
    );

    // And the restamp is what puts the Name Manager's spelling back.
    let mut grid = engine::Grid::new();
    grid.set_cell(0, 0, engine::Cell::new_formula("=BUDGETTOTAL*2".to_string()));
    let mut names = std::collections::HashMap::new();
    names.insert(
        "BUDGETTOTAL".to_string(),
        crate::named_ranges::NamedRange {
            name: "BudgetTotal".to_string(),
            sheet_index: None,
            refers_to: "=Sheet1!$A$1".to_string(),
            comment: None,
            folder: None,
        },
    );
    let respelled = crate::name_resolution::restamp_grid_name_casing(&mut grid, &names);
    assert_eq!(respelled, 1);
    assert_eq!(
        grid.get_cell(0, 0).and_then(|c| c.formula_string_raw()),
        Some("BudgetTotal*2".to_string())
    );
}

/// Every free function that rebuilds a workbook grid out of a package's stored
/// formula TEXT must restamp the defined-name casing afterwards.
///
/// This is the §2t residual the register filed: the `.calp` paths never went
/// through `open_file`, so the fix that made a `.cala` reload keep
/// `BudgetTotal` did nothing for a subscriber. `.to_grid()` is the seam -- it is
/// the ONLY way a `persistence::Sheet` becomes a `Grid` -- so requiring the
/// restamp of every function that calls it covers pull, refresh, reset, both dev
/// paths and `open_file` with one rule instead of five call sites.
#[test]
fn every_path_that_rebuilds_a_grid_from_stored_text_restamps_the_name_casing() {
    const CALP: &str = include_str!("calp_commands.rs");
    const PERSISTENCE: &str = include_str!("persistence.rs");

    let mut offenders: Vec<String> = Vec::new();
    let mut rebuilders = 0usize;
    for (file, text) in [("calp_commands.rs", CALP), ("persistence.rs", PERSISTENCE)] {
        for (name, body) in free_function_bodies(text) {
            if !body.contains(".to_grid()") {
                continue;
            }
            rebuilders += 1;
            if !body.contains("restamp_workbook_name_casing") {
                offenders.push(format!("{}::{}", file, name));
            }
        }
    }
    assert!(
        rebuilders >= 6,
        "the census found only {} functions that rebuild a grid from stored text; \
         `calp_pull`, `calp_refresh_apply`, `calp_reset_subscription`, \
         `calp_dev_subscribe`, `calp_dev_refresh` and `open_file` are all \
         rebuilders and must all be visible here",
        rebuilders
    );
    assert!(
        offenders.is_empty(),
        "these functions rebuild formula ASTs from a package's stored TEXT and do \
         NOT restamp the defined-name casing:\n  {}\n\nThe lexer upper-cases every \
         bare identifier, so a publisher's `=BudgetTotal*2` lands in the \
         subscriber's workbook as `=BUDGETTOTAL*2` -- section 2t on the \
         distribution path. Call \
         `crate::persistence::restamp_workbook_name_casing(&state, &effect)` after \
         the sheets (and any pulled names) are installed.",
        offenders.join("\n  ")
    );
}

#[test]
fn the_rebuild_census_can_see_a_path_that_forgets() {
    // TEETH.
    const SABOTAGED: &str = "
pub fn calp_pull_lookalike(state: &AppState) {
    let (mut grid, local_styles) = pulled.sheet.to_grid();
    grids.push(grid);
}

pub fn calp_refresh_lookalike(state: &AppState) {
    let (mut grid, local_styles) = pulled.sheet.to_grid();
    grids.push(grid);
    crate::persistence::restamp_workbook_name_casing(state, &effect);
}
";
    let flagged: Vec<String> = free_function_bodies(SABOTAGED)
        .into_iter()
        .filter(|(_, body)| body.contains(".to_grid()"))
        .filter(|(_, body)| !body.contains("restamp_workbook_name_casing"))
        .map(|(name, _)| name)
        .collect();
    assert_eq!(flagged, vec!["calp_pull_lookalike".to_string()]);
}

/// The overlay's OTHER text->AST route: an override cell.
///
/// A `.calp` override stores its formula as TEXT in the override layer, and
/// `write_override_value` re-parses it — the same lexer, the same shouting, on a
/// path with no `to_grid()` in it at all. It restamps at the write, which is why
/// this census is a second one rather than a widened first.
///
/// ALL THREE AUTHORITIES, since §2aj. The lexer flattens a defined NAME, a TABLE
/// and its column, AND a SHEET qualifier, so an override that restamped only the
/// first would land `=SUM(SALES[AMOUNT])` and `=DATA!A1` in a subscriber's
/// workbook. `WorkbookSpellings::restamp` is the one place that does all three;
/// this pins both that the write calls it and that it really is all three.
#[test]
fn the_override_write_restamps_the_name_casing_it_re_parses() {
    const CALP: &str = include_str!("calp_commands.rs");
    let bodies = free_function_bodies(CALP);
    let body = bodies
        .iter()
        .find(|(name, _)| name == "write_override_value")
        .map(|(_, body)| body.clone())
        .expect("write_override_value must exist");
    assert!(
        body.contains("spellings.restamp("),
        "`write_override_value` re-parses an override's stored formula text and \
         stores the AST; without the restamp a subscriber's overridden cell reads \
         `=BUDGETTOTAL` where the publisher wrote `=BudgetTotal`"
    );

    // ...and the helper it delegates to must still do all three, or the line
    // above becomes a call to a no-op. Read from the whole file rather than from
    // one function body: `restamp` is an inherent method, which
    // `free_function_bodies` does not enumerate.
    for (needle, why) in [
        ("restamp_name_casing", "a defined name comes back SHOUTING (2t)"),
        ("restamp_table_casing", "a structured reference comes back SHOUTING (2aj)"),
        ("restamp_sheet_casing", "a sheet qualifier comes back SHOUTING (2ai)"),
    ] {
        assert!(
            CALP.contains(needle),
            "`WorkbookSpellings::restamp` no longer calls `{}`: {}",
            needle,
            why
        );
    }
}

// ---------------------------------------------------------------------------
// THE SAME TWO DEFECTS, ON THE STRUCTURAL REWRITES (found 2026-08-10 while
// closing §3bc, and NOT on the register's list).
//
// `repair_all_formulas` was fixed to read the RAW formula and to refuse rather
// than swallow. Eleven other call sites do the identical thing -- read a
// formula as text, rewrite the references, store the re-parse -- and had
// neither fix: insert/delete rows and columns, sort (four arms), fill, the
// off-sheet structural edit, and cut/paste relocation.
//
// So inserting a row above a cell that called a named LAMBDA destroyed the
// call, exactly as renaming a sheet used to, on a far more common gesture.
// ---------------------------------------------------------------------------

#[test]
fn a_structural_rewrite_that_reads_the_display_form_destroys_a_named_lambda_call() {
    // THE REPRODUCTION, at the level the defect lives on: which of the two
    // renderings the rewrite reads.
    let cell = engine::Cell::new_formula("=__INVOKE__(\"MyFn\",LAMBDA(x,x*2),A5)".to_string());

    // (a) The DISPLAY form -- what these call sites used to read.
    let display = cell.formula_string().expect("formula");
    assert_eq!(display, "MyFn(A5)", "the display form no longer collapses the marker");
    let shifted_display =
        crate::commands::structure::shift_formula_internal(&display, 1, 0);
    assert_eq!(shifted_display, "MyFn(A6)");
    let reparsed = parser::parse(&shifted_display).expect("parses -- that is the trap");
    assert!(
        !engine::ast_render::render_formula_raw(&reparsed).contains("LAMBDA"),
        "re-parsing the display form is supposed to LOSE the lambda -- if it no \
         longer does, this whole class is gone and the test should say so"
    );

    // (b) The RAW form -- what the shared helper reads now. The lambda survives
    // and the reference still moves.
    let raw = crate::commands::structure::formula_to_rewrite(&cell).expect("formula");
    let shifted_raw = crate::commands::structure::shift_formula_internal(&raw, 1, 0);
    assert!(shifted_raw.contains("LAMBDA"), "the lambda was dropped: {}", shifted_raw);
    assert!(shifted_raw.contains("A6"), "the reference did not move: {}", shifted_raw);
    let reparsed_raw = parser::parse(&shifted_raw).expect("the raw form must re-parse");
    assert!(engine::ast_render::render_formula_raw(&reparsed_raw).contains("__INVOKE__"));
}

#[test]
fn a_structural_rewrite_that_cannot_be_read_back_keeps_the_cells_own_formula() {
    let mut cell = engine::Cell::new_formula("=SUM(A1:A9)".to_string());
    let stored = crate::commands::structure::store_rewritten_formula(
        &mut cell, "=SUM(", "insert rows", 3, 1,
    );
    assert!(!stored, "unreadable text must not be stored");
    assert_eq!(
        cell.formula_string_raw(),
        Some("SUM(A1:A9)".to_string()),
        "the user's formula was blanked -- the `.ok()` defect, one level down"
    );

    // ...and a rewrite that CAN be read back is stored.
    assert!(crate::commands::structure::store_rewritten_formula(
        &mut cell, "=SUM(A2:A10)", "insert rows", 3, 1,
    ));
    assert_eq!(cell.formula_string_raw(), Some("SUM(A2:A10)".to_string()));
}

/// A census over the two files that do the structural rewriting: no cell AST
/// may be built from re-parsed rewritten text with `.ok()`.
///
/// EXEMPT, with the reason, is `fill_range`: its `Err` arm writes `#VALUE!` into
/// the cell, so the failure is VISIBLE in the grid rather than silent, and there
/// is nothing to keep -- the source cell's own AST would point at the wrong
/// cells if it were carried into the target.
#[test]
fn no_structural_rewrite_swallows_a_parse_failure() {
    const STRUCTURE_RS: &str = include_str!("commands/structure.rs");
    const DATA_RS: &str = include_str!("commands/data.rs");
    const EXEMPT: &[(&str, &str)] = &[(
        "fill_range",
        "the Err arm writes #VALUE! into the cell, so the failure is visible",
    )];

    let mut offenders: Vec<String> = Vec::new();
    for (file, text) in [("commands/structure.rs", STRUCTURE_RS), ("commands/data.rs", DATA_RS)] {
        for (name, body) in free_function_bodies(text) {
            if !body.contains(".ok().map(Box::new)") {
                continue;
            }
            if EXEMPT.iter().any(|(exempt, _)| *exempt == name) {
                continue;
            }
            offenders.push(format!("{}::{}", file, name));
        }
    }
    assert!(
        offenders.is_empty(),
        "these functions build a cell AST from re-parsed text and swallow the \
         failure into `ast = None`:\n  {}\n\nThat leaves a cell with a stale \
         value, an EMPTY formula bar and no error anywhere (register §3bc). Use \
         `store_rewritten_formula`, which keeps the cell's own formula and logs \
         at ERROR, or take an exemption here WITH the reason.",
        offenders.join("\n  ")
    );
}

#[test]
fn the_swallow_census_can_see_a_call_site_that_forgets() {
    // TEETH.
    const SABOTAGED: &str = "
pub fn insert_rows_lookalike(grid: &mut Grid) {
    updated_cell.ast = parser::parse(&updated_formula).ok().map(Box::new);
}

pub fn insert_rows_fixed(grid: &mut Grid) {
    store_rewritten_formula(&mut updated_cell, &updated_formula, \"insert rows\", r, c);
}
";
    let flagged: Vec<String> = free_function_bodies(SABOTAGED)
        .into_iter()
        .filter(|(_, body)| body.contains(".ok().map(Box::new)"))
        .map(|(name, _)| name)
        .collect();
    assert_eq!(flagged, vec!["insert_rows_lookalike".to_string()]);
}

/// The READ half of the same class: the text handed to a reference-shifter must
/// be the RAW formula, never the display form.
///
/// The population is not "functions that mention `formula_string`" -- that
/// method has legitimate uses in the same functions (asking whether a cell has a
/// formula, rendering one for the frontend payload, re-evaluating a dependent).
/// It is "text that FLOWS INTO a shifter", so the check reads backwards from
/// each shifter call to see where its input came from.
#[test]
fn every_structural_rewrite_reads_the_raw_formula() {
    const STRUCTURE_RS: &str = include_str!("commands/structure.rs");
    const DATA_RS: &str = include_str!("commands/data.rs");
    const SHIFTERS: [&str; 4] = [
        "shift_formula_internal(",
        "shift_formula_rows_sheet_aware(",
        "shift_formula_cols_sheet_aware(",
        "relocate_references_in_formula(",
    ];
    /// How far back from a shifter call the binding of its input can sit.
    const WINDOW: usize = 12;

    let mut offenders: Vec<String> = Vec::new();
    let mut shifter_calls = 0usize;
    for (file, text) in [("commands/structure.rs", STRUCTURE_RS), ("commands/data.rs", DATA_RS)] {
        for (name, body) in free_function_bodies(text) {
            // The shifters' own definitions take `&str`; they are not readers.
            if SHIFTERS.iter().any(|s| s.trim_end_matches('(') == name) {
                continue;
            }
            let lines: Vec<&str> = body.lines().collect();
            for (i, line) in lines.iter().enumerate() {
                if !SHIFTERS.iter().any(|s| line.contains(s)) {
                    continue;
                }
                shifter_calls += 1;
                let from = i.saturating_sub(WINDOW);
                let bound_display = lines[from..=i].iter().any(|l| {
                    l.contains(".formula_string()")
                        && !l.contains(".is_some()")
                        && !l.contains(".is_none()")
                        && !l.trim_start().starts_with("//")
                });
                if bound_display {
                    offenders.push(format!("{}::{}", file, name));
                }
            }
        }
    }
    assert!(
        shifter_calls >= 10,
        "the census found only {} calls to a reference-shifter; the four \
         insert/delete impls, the four sort arms, fill, the off-sheet edit and \
         the relocation are all callers",
        shifter_calls
    );
    offenders.dedup();
    assert!(
        offenders.is_empty(),
        "these functions hand a reference-shifter the DISPLAY form of a \
         formula:\n  {}\n\n`formula_string()` collapses the \
         `__INVOKE__(\"MyFn\", <lambda>, args)` marker of a named-LAMBDA call to \
         `MyFn(args)`; re-parsing the shifted result yields an unknown user \
         function, so inserting a row above such a call turns it into #NAME?. \
         Read `crate::commands::structure::formula_to_rewrite` instead.",
        offenders.join("\n  ")
    );
}

#[test]
fn the_raw_read_census_can_see_a_call_site_that_forgets() {
    // TEETH. The sabotage is the exact shape the four insert/delete impls had.
    const SABOTAGED: &str = "
pub fn insert_rows_lookalike(grid: &mut Grid) {
    if let Some(formula) = cell.formula_string() {
        let updated = shift_formula_rows_sheet_aware(&formula, a, b, row, delta);
    }
}

pub fn insert_rows_fixed(grid: &mut Grid) {
    if let Some(formula) = formula_to_rewrite(cell) {
        let updated = shift_formula_rows_sheet_aware(&formula, a, b, row, delta);
    }
    let has = cell.formula_string().is_some();
}
";
    let mut flagged: Vec<String> = Vec::new();
    for (name, body) in free_function_bodies(SABOTAGED) {
        let lines: Vec<&str> = body.lines().collect();
        for (i, line) in lines.iter().enumerate() {
            if !line.contains("shift_formula_rows_sheet_aware(") {
                continue;
            }
            let from = i.saturating_sub(12);
            if lines[from..=i]
                .iter()
                .any(|l| l.contains(".formula_string()") && !l.contains(".is_some()"))
            {
                flagged.push(name.clone());
            }
        }
    }
    assert_eq!(flagged, vec!["insert_rows_lookalike".to_string()]);
}

/// THE WIDE CENSUS: a function that re-parses formula text it RENDERED, and
/// stores the result back on a cell, must have rendered the RAW form.
///
/// The shifter census above is the same rule stated over one population. This
/// is the population that finding `tables.rs` added: renaming a TABLE, and
/// rewriting a table's structured references, both read the display form and
/// stored what it re-parsed to, so renaming a table destroyed every
/// named-LAMBDA call in a formula that mentioned it. No shifter is involved,
/// so the narrower census could not see it.
///
/// The detector is deliberately structural rather than clever: a function that
/// BINDS `.formula_string()` (not `.is_some()` / `.is_none()`, which ask a
/// question rather than take the text) AND assigns a parsed AST onto a cell in
/// the same body is doing the round trip.
#[test]
fn no_function_re_parses_the_display_form_and_stores_it_on_a_cell() {
    const FILES: [(&str, &str); 5] = [
        ("commands/structure.rs", include_str!("commands/structure.rs")),
        ("commands/data.rs", include_str!("commands/data.rs")),
        ("tables.rs", include_str!("tables.rs")),
        ("named_ranges.rs", include_str!("named_ranges.rs")),
        ("lib.rs", include_str!("lib.rs")),
    ];
    // EXEMPT, with the reason it is not this defect.
    const EXEMPT: [(&str, &str); 1] = [(
        "update_cell_impl",
        "binds the display form of DEPENDENTS in order to re-evaluate them and \
         to build the frontend payload; the AST it stores on a cell is built \
         from the user's typed text, never from a render of a stored formula",
    )];

    let mut offenders: Vec<String> = Vec::new();
    for (file, text) in FILES {
        for (name, body) in free_function_bodies(text) {
            if EXEMPT.iter().any(|(exempt, _)| *exempt == name) {
                continue;
            }
            let binds_display = body.lines().any(|l| {
                l.contains(".formula_string()")
                    && !l.contains(".is_some()")
                    && !l.contains(".is_none()")
                    && !l.trim_start().starts_with("//")
            });
            if !binds_display {
                continue;
            }
            let stores_ast = body.contains(".ast = Some(")
                || body.contains("ast: Some(")
                || body.contains("store_rewritten_formula(");
            if stores_ast {
                offenders.push(format!("{}::{}", file, name));
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "these functions render a formula, re-parse the render, and store the \
         result on a cell -- while rendering the DISPLAY form:\n  {}\n\n\
         `formula_string()` collapses `__INVOKE__(\"MyFn\", <lambda>, args)` to \
         `MyFn(args)`, which re-parses as an unknown user function, so the \
         round trip destroys every named-LAMBDA call it touches. Render \
         `formula_string_raw()` instead.",
        offenders.join("\n  ")
    );
}
