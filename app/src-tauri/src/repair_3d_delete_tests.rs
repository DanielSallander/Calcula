//! FILENAME: app/src-tauri/src/repair_3d_delete_tests.rs
//! PURPOSE: A sheet DELETE reaches a reference to the deleted sheet whatever
//!          node it sits in (W8, the delete twin of wave B's B3).
//!
//! `repair_3d_delete_recursive` (lib.rs) fell through to its `_` "leaf" arm for
//! every node it did not name, so a reference WRAPPED in an implicit
//! intersection (`@Data!A1:A3`), a spill (`Data!A1#`), an index access
//! (`Data!A1[0]`), an array constant (`{1,Data!A1}`), a dict literal
//! (`{"k": Data!A1}`) or a list literal survived the deletion of Data VERBATIM.
//! Nothing reported an error: the evaluator resolves an unknown sheet name to
//! the formula's OWN sheet, so the cell quietly read a local cell -- or a sheet
//! created later under the old name -- where a cell formula answers `#REF!`.
//! The rename twin (`repair_3d_rename_recursive`) was made exhaustive in wave
//! B; this pins the delete twin to the same shape.
//!
//! A child module of the crate root, so the private recursive walk is in reach.

use super::*;

/// The wrapped-reference shapes a formula TEXT can spell, each with the node it
/// must parse into (a fixture that stopped parsing into its node would pass
/// vacuously).
fn wrapped_cases() -> Vec<(&'static str, &'static str, fn(&ParserExpr) -> bool)> {
    vec![
        ("=@Data!A1:A3", "implicit intersection", |e| matches!(e, ParserExpr::ImplicitIntersection { .. })),
        ("=SUM(Data!A1#)", "spill reference", |e| contains(e, &|n| matches!(n, ParserExpr::SpillRef { .. }))),
        ("=Data!A1[0]", "index access", |e| matches!(e, ParserExpr::IndexAccess { .. })),
        ("={1,Data!A1}", "array constant", |e| matches!(e, ParserExpr::ArrayLiteral { .. })),
        ("={\"k\": Data!A1}", "dict literal", |e| matches!(e, ParserExpr::DictLiteral { .. })),
    ]
}

/// Does `expr` (or a node inside a function call) satisfy `pred`?
fn contains(expr: &ParserExpr, pred: &dyn Fn(&ParserExpr) -> bool) -> bool {
    if pred(expr) {
        return true;
    }
    match expr {
        ParserExpr::FunctionCall { args, .. } => args.iter().any(|a| contains(a, pred)),
        _ => false,
    }
}

#[test]
fn a_delete_turns_a_reference_wrapped_in_every_node_into_ref() {
    let after = vec!["Sheet1".to_string(), "Other".to_string()];
    for (formula, node, is_node) in wrapped_cases() {
        let ast = parse_formula(formula).unwrap_or_else(|e| panic!("fixture: `{}` must parse: {}", formula, e));
        assert!(is_node(&ast), "fixture: `{}` is not a {}", formula, node);
        assert_eq!(
            crate::repair_3d_refs_on_delete(formula, "Data", &after),
            None,
            "deleting Data left the reference inside a {} alive: `{}`",
            node,
            formula
        );
    }
}

/// The same wrappers around a reference to a sheet that STAYS are left alone:
/// the repair is not a blanket `#REF!` for every wrapper.
#[test]
fn a_delete_leaves_wrapped_references_to_other_sheets_alone() {
    let after = vec!["Sheet1".to_string(), "Other".to_string()];
    for (formula, node, _) in wrapped_cases() {
        let kept = formula.replace("Data!", "Other!");
        assert_eq!(
            crate::repair_3d_refs_on_delete(&kept, "Data", &after),
            Some(kept.clone()),
            "deleting Data rewrote a {} that names another sheet",
            node
        );
    }
}

/// A LIST literal has no text spelling any more (`COLLECT()` builds one and
/// cells persist it), so the walk is exercised on the tree itself.
#[test]
fn a_delete_reaches_a_reference_inside_a_list_literal() {
    let data_ref = parse_formula("=Data!A1").expect("a plain cross-sheet reference");
    let list = ParserExpr::ListLiteral { elements: vec![ParserExpr::Literal(parser::ast::Value::Number(1.0)), data_ref] };
    let (_, had_ref_error) = repair_3d_delete_recursive(&list, "Data", None, &["Sheet1".to_string()]);
    assert!(had_ref_error, "deleting Data left the reference inside a list literal alive");
}

/// End to end through the command: a wrapped reference on Sheet1 to the deleted
/// sheet becomes `#REF!`, exactly like a plain one.
#[test]
fn deleting_a_sheet_turns_its_wrapped_references_into_ref() {
    use crate::document_effect::test_seed_effect;
    let state = crate::create_app_state();
    let file = crate::persistence::FileState::default();
    crate::sheets::add_sheet_inner(&state, &file, Some("Data".to_string()), ::persistence::SheetKind::Worksheet)
        .expect("add Data");
    crate::sheets::activate_sheet(&state, 0).expect("back to Sheet1");
    let cases = wrapped_cases();
    for (row, (formula, _, _)) in cases.iter().enumerate() {
        let cell = engine::Cell::new_formula(formula.to_string());
        assert!(cell.ast.is_some(), "fixture: `{}` must parse", formula);
        state.grid.write(&test_seed_effect()).unwrap().set_cell(row as u32, 0, cell.clone());
        state.grids.write(&test_seed_effect()).unwrap()[0].set_cell(row as u32, 0, cell);
    }
    crate::sheets::delete_sheet_impl(
        &state,
        &file,
        &crate::pivot::PivotState::new(),
        &crate::persistence::UserFilesState::default(),
        &crate::pane_control::PaneControlState::new(),
        &crate::ribbon_filter::RibbonFilterState::new(),
        &crate::slicer::SlicerState::new(),
        &crate::timeline_slicer::TimelineSlicerState::new(),
        1,
        false,
    )
    .expect("delete Data");
    let grid = state.grid.read().unwrap();
    for (row, (formula, node, _)) in cases.iter().enumerate() {
        let cell = grid.get_cell(row as u32, 0).expect("the formula cell");
        let now = cell.formula_string_raw().unwrap_or_default();
        // A reference to a deleted sheet turns the whole formula into `#REF!`
        // (`repair_all_formulas`: the error value, no formula left), exactly as
        // a plain `=Data!A1` does.
        assert!(
            matches!(cell.value, CellValue::Error(CellError::Ref)) && !now.to_uppercase().contains("DATA!"),
            "after deleting Data the {} `{}` reads `{}` = {:?}",
            node,
            formula,
            now,
            cell.value
        );
    }
}

// ---------------------------------------------------------------------------
// A 3D reference whose ENDPOINT is the deleted sheet (wave C fix-up)
// ---------------------------------------------------------------------------
//
// Excel moves a deleted endpoint INWARD, to its neighbour inside the range:
// with Sheet1, Mid, Data, Last, Other, deleting Data turns `SUM(Mid:Data!B1)`
// into `SUM(Mid:Mid!B1)` and `SUM(Data:Last!B1)` into `SUM(Last:Last!B1)`.
// `find_adjacent_sheet` answered with the workbook's LAST sheet for a deleted
// end and its FIRST sheet for a deleted start, whatever the range was: the
// first became `SUM(Mid:Other!B1)` and the second `SUM(Sheet1:Last!B1)`, so
// both silently summed sheets the user never put in the range. It never knew
// where the deleted sheet had stood; the repair now takes that position.

/// Sheet1 (formulas), Mid, Data (deleted), Last, Other.
fn endpoint_book() -> AppState {
    let state = crate::create_app_state();
    let file = crate::persistence::FileState::default();
    for name in ["Mid", "Data", "Last", "Other"] {
        crate::sheets::add_sheet_inner(&state, &file, Some(name.to_string()), ::persistence::SheetKind::Worksheet)
            .expect("add a sheet");
    }
    crate::sheets::activate_sheet(&state, 0).expect("back to Sheet1");
    state
}

fn delete_sheet_at(state: &AppState, index: usize) {
    crate::sheets::delete_sheet_impl(
        state,
        &crate::persistence::FileState::default(),
        &crate::pivot::PivotState::new(),
        &crate::persistence::UserFilesState::default(),
        &crate::pane_control::PaneControlState::new(),
        &crate::ribbon_filter::RibbonFilterState::new(),
        &crate::slicer::SlicerState::new(),
        &crate::timeline_slicer::TimelineSlicerState::new(),
        index,
        false,
    )
    .expect("delete the sheet");
}

#[test]
fn a_deleted_3d_endpoint_moves_inward_to_its_neighbour_in_the_range() {
    use crate::document_effect::test_seed_effect;
    let state = endpoint_book();
    // (formula on Sheet1, what it must read after Data is deleted; None = #REF!).
    // `Last:Data` spells the range backwards: Data is still its FIRST tab.
    let cases: [(&str, Option<&str>); 6] = [
        ("=SUM(Mid:Data!B1)", Some("SUM(Mid:Mid!B1)")),
        ("=SUM(Data:Last!B1)", Some("SUM(Last:Last!B1)")),
        ("=SUM(Data:Other!B1)", Some("SUM(Last:Other!B1)")),
        ("=SUM(Mid:Last!B1)", Some("SUM(Mid:Last!B1)")),
        ("=SUM(Last:Data!B1)", Some("SUM(Last:Last!B1)")),
        ("=SUM(Data:Data!B1)", None),
    ];
    for (row, (formula, _)) in cases.iter().enumerate() {
        let cell = engine::Cell::new_formula(formula.to_string());
        assert!(cell.ast.is_some(), "fixture: `{}` must parse", formula);
        state.grid.write(&test_seed_effect()).unwrap().set_cell(row as u32, 0, cell.clone());
        state.grids.write(&test_seed_effect()).unwrap()[0].set_cell(row as u32, 0, cell);
    }
    let data = state.sheet_names.read().unwrap().iter().position(|n| n == "Data").expect("Data");
    delete_sheet_at(&state, data);

    let grid = state.grid.read().unwrap();
    for (row, (formula, expected)) in cases.iter().enumerate() {
        let cell = grid.get_cell(row as u32, 0).expect("the formula cell");
        let now = cell.formula_string_raw().unwrap_or_default();
        match expected {
            Some(expected) => assert!(
                calp::sheet_renames::same_formula_text(&now, expected),
                "deleting Data turned `{}` into `{}`; Excel moves the endpoint inward: `{}`",
                formula,
                now,
                expected
            ),
            None => assert!(
                matches!(cell.value, CellValue::Error(CellError::Ref)) && cell.ast.is_none(),
                "`{}` names ONLY the deleted sheet and must become #REF!, not `{}`",
                formula,
                now
            ),
        }
    }
}

/// Found live 2026-09-29 (e2e fixall-calp W10/W11): Manage Rules showed
/// `=SUM(MID:Mid!B1)>0` after Data was deleted. The endpoint that stayed kept
/// the lexer's upper-cased spelling of a bare name, beside the moved one in
/// the workbook's. Asserted on the exact TEXT -- the spelling-blind comparison
/// the other tests here use is blind to exactly this defect.
#[test]
fn the_endpoint_that_stays_is_spelled_as_the_workbook_spells_it() {
    let after: Vec<String> = ["Sheet1", "Mid", "Last", "Other"].iter().map(|s| s.to_string()).collect();
    // Sheet1, Mid, Data, Last, Other: Data stood at index 2.
    assert_eq!(
        repair_formula_text_on_delete_at("=SUM(Mid:Data!B1)>0", "Data", 2, &after).as_deref(),
        Some("=SUM(Mid:Mid!B1)>0"),
        "a conditional format's rule (the store path)"
    );
    assert_eq!(
        repair_formula_text_on_delete_at("=SUM(Data:Last!B1)>A1", "Data", 2, &after).as_deref(),
        Some("=SUM(Last:Last!B1)>A1"),
        "a custom validation (the store path, the START deleted)"
    );
    assert_eq!(
        repair_3d_refs_on_delete_at("=SUM(Mid:Data!B1)", "Data", 2, &after).as_deref(),
        Some("=SUM(Mid:Mid!B1)"),
        "a cell or defined name (the whole-formula path)"
    );
    // An UNTOUCHED 3D reference keeps the caller's own text.
    assert_eq!(
        repair_3d_refs_on_delete_at("=SUM(mid:last!B1)", "Data", 2, &after).as_deref(),
        Some("=SUM(mid:last!B1)")
    );
}

/// The same rule through the text repair defined names use, which carries the
/// deleted sheet's POSITION (`repair_3d_refs_on_delete_at`).
#[test]
fn a_defined_names_3d_endpoint_moves_inward_too() {
    use crate::document_effect::test_seed_effect;
    let state = endpoint_book();
    state.named_ranges.write(&test_seed_effect()).unwrap().insert(
        "SPAN".to_string(),
        crate::named_ranges::NamedRange {
            name: "Span".to_string(),
            sheet_index: None,
            refers_to: "=SUM(Mid:Data!B1)+SUM(Data:Last!B1)".to_string(),
            comment: None,
            folder: None,
        },
    );
    let data = state.sheet_names.read().unwrap().iter().position(|n| n == "Data").expect("Data");
    delete_sheet_at(&state, data);
    let refers_to = state.named_ranges.read().unwrap()["SPAN"].refers_to.clone();
    assert!(
        calp::sheet_renames::same_formula_text(&refers_to, "=SUM(Mid:Mid!B1)+SUM(Last:Last!B1)"),
        "the defined name reads `{}` after Data was deleted",
        refers_to
    );
}
