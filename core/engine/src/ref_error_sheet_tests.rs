//! FILENAME: core/engine/src/ref_error_sheet_tests.rs
//! PURPOSE: A reference whose SHEET WAS DELETED -- Excel's `=#REF!A1` -- renders
//!          back as Excel writes it and evaluates `#REF!` in every context.
//!
//! Excel [LIVE, Excel 16, 2026-11-05, sheetspill/probe1.ps1] keeps a formula
//! that read a deleted sheet and replaces only the sheet: `=Sheet2!A1` becomes
//! `=#REF!A1`, `=SUM(Sheet2!A1:A3)+1` `=SUM(#REF!A1:A3)+1`. Calcula turned the
//! whole cell into a `#REF!` CONSTANT instead (the formula was lost). The
//! parser now reads `#REF!A1` into the reference node with
//! `parser::ast::REF_ERROR_SHEET` as its sheet; these pin the other two halves.
//! Sheet1!A1 holds 100 in every fixture, so a reader that fell back to the
//! formula's OWN sheet would answer a plausible number instead of the error.

use crate::ast_render::render_formula_raw;
use crate::cell::{Cell, CellError};
use crate::evaluator::{EvalResult, Evaluator, MultiSheetContext};
use crate::grid::Grid;

fn local_grid() -> Grid {
    let mut grid = Grid::new();
    for row in 0..3u32 {
        grid.set_cell(row, 0, Cell::new_number(100.0 + row as f64));
        grid.set_cell(row, 1, Cell::new_number(1.0));
    }
    grid
}

/// Evaluate `formula` on Sheet1 with Sheet2 present, and with no sheet table at
/// all (the single-sheet evaluator, whose qualified references have always
/// read the current grid).
fn both_ways(formula: &str) -> [EvalResult; 2] {
    let s1 = local_grid();
    let s2 = local_grid();
    let ast = parser::parse(formula).unwrap_or_else(|e| panic!("`{formula}` must parse: {e}"));
    let mut ctx = MultiSheetContext::new("Sheet1".to_string());
    ctx.add_grid("Sheet1".to_string(), &s1);
    ctx.add_grid("Sheet2".to_string(), &s2);
    ctx.sheet_order = vec!["Sheet1".to_string(), "Sheet2".to_string()];
    let multi = Evaluator::with_multi_sheet(&s1, ctx).evaluate(&ast);
    let single = Evaluator::new(&s1).evaluate(&ast);
    [multi, single]
}

#[test]
fn a_deleted_sheets_reference_renders_as_excel_writes_it() {
    for text in [
        "#REF!A1",
        "#REF!$A$1",
        "SUM(#REF!A1:A3)+1",
        // (the lexer folds a bare sheet name, so the fixture spells it folded)
        "#REF!$A$1+SHEET3!A1",
        "SUM(#REF!A:A)",
        "SUM(#REF!1:1)",
        "SUM(#REF!D1#)",
        "INDEX(#REF!A1:B2,1,1)",
        "SUM(#REF!A1,#REF!A2)",
        "ISREF(#REF!A1)",
        "#REF!A1:A2 #REF!A1:B1",
        "@#REF!A1:A3",
        "A1>#REF!$B$1",
    ] {
        let ast = parser::parse(&format!("={text}")).unwrap_or_else(|e| panic!("`={text}` must parse: {e}"));
        assert_eq!(render_formula_raw(&ast), text, "`={text}` did not render back as Excel writes it");
    }
    // A sheet CALLED `#REF!` keeps its quotes: it is a real sheet, not the marker.
    let quoted = parser::parse("='#REF!'!A1").unwrap();
    assert_eq!(render_formula_raw(&quoted), "'#REF!'!A1");
}

#[test]
fn a_deleted_sheets_reference_is_ref_with_or_without_a_sheet_table() {
    for formula in [
        "=#REF!A1",
        "=#REF!$A$1",
        "=SUM(#REF!A1:A3)+1",
        "=SUM(#REF!A:A)",
        "=SUM(#REF!1:1)",
        "=INDEX(#REF!A1:B2,1,1)",
        "=SUM(#REF!A1,#REF!A2)",
        "=#REF!A1+Sheet2!A1",
    ] {
        for (how, result) in ["with Sheet2 present", "single-sheet"].iter().zip(both_ways(formula)) {
            assert!(
                matches!(result, EvalResult::Error(CellError::Ref)),
                "`{formula}` ({how}) answered {result:?}; Excel answers #REF!"
            );
        }
    }
    // The control: the same shapes on a sheet that EXISTS read it.
    let [multi, _] = both_ways("=SUM(Sheet2!A1:A3)+1");
    assert!(matches!(multi, EvalResult::Number(n) if n == 304.0), "control: {multi:?}");
}

#[test]
fn isref_of_a_deleted_sheets_reference_is_false() {
    // [LIVE] `=ISREF(#REF!A1)` is FALSE in Excel once the sheet is gone.
    for result in both_ways("=ISREF(#REF!A1)") {
        assert!(matches!(result, EvalResult::Boolean(false)), "ISREF(#REF!A1) answered {result:?}");
    }
    let [multi, _] = both_ways("=ISREF(Sheet2!A1)");
    assert!(matches!(multi, EvalResult::Boolean(true)), "control: ISREF(Sheet2!A1) answered {multi:?}");
}
