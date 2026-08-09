//! FILENAME: app/src-tauri/src/name_casing_reload_tests.rs
//! PURPOSE: Pin the RELOAD half of D2's name handling - a stored defined name
//!          must come back spelled the way the Name Manager spells it.
//! CONTEXT: 2t in docs/design/open-decisions-2026-08.md. D2 made a typed
//!          formula keep its NAME, which is Excel parity and right. It also
//!          exposed a path that had never been exercised: a cell keeps only its
//!          AST (`engine::Cell` has no raw-formula field), so a `.cala` stores
//!          rendered text and a reload RE-PARSES it - through a lexer that
//!          normalises bare identifiers to UPPER CASE. `=BudgetTotal` was saved
//!          and reopened as `=BUDGETTOTAL`; the save/reload oracle in the
//!          scenario suite fired on it and aborted `budget-model`.
//!
//! WHY THESE LIVE IN THEIR OWN `_tests.rs` FILE rather than beside the code:
//! the recalculation census (`bulk_rewrite_recalc_tests.rs`) enumerates every
//! function whose body contains a `set_cell` call, and skips files named
//! `*_tests.rs` because test sources are not the product. These fixtures build
//! grids that way, so keeping them here is what stops four test helpers from
//! appearing in the census as unclassified cell writers.
//!
//! TEETH: the first test asserts the SHOUTED spelling as a PRECONDITION, so it
//! cannot pass against a parser that never upper-cased anything.

use std::collections::HashMap;

use crate::name_resolution::restamp_grid_name_casing;
use crate::named_ranges::NamedRange;

fn name_table(defined: &[&str]) -> HashMap<String, NamedRange> {
    let mut nr: HashMap<String, NamedRange> = HashMap::new();
    for d in defined {
        nr.insert(
            d.to_uppercase(),
            NamedRange {
                name: (*d).to_string(),
                sheet_index: None,
                refers_to: "=$D$5".to_string(),
                comment: None,
                folder: None,
            },
        );
    }
    nr
}

/// The exact defect, at the exact seam: a `.cala` stores formula TEXT, the
/// load re-parses it, and the lexer normalises the identifier to upper case.
/// The pre-condition is asserted first so the test cannot pass on a parser
/// that never shouted in the first place.
#[test]
fn a_reloaded_grid_gets_the_name_managers_capitalisation_back() {
    let mut grid = engine::Grid::new();
    // Exactly what `SavedCell::to_cell` does on the way back in.
    grid.set_cell(2, 5, engine::Cell::new_formula("=BudgetTotal*2".to_string()));

    // TEETH: the reload really does shout, or this test proves nothing.
    assert_eq!(
        grid.get_cell(2, 5).unwrap().formula_string().unwrap(),
        "BUDGETTOTAL*2",
        "precondition: re-parsing a saved formula upper-cases the name"
    );

    let nr = name_table(&["BudgetTotal"]);
    let n = restamp_grid_name_casing(&mut grid, &nr);

    assert_eq!(n, 1, "one formula was respelled");
    assert_eq!(
        grid.get_cell(2, 5).unwrap().formula_string().unwrap(),
        "BudgetTotal*2",
        "the reloaded formula reads as the Name Manager spells it"
    );
}

/// It is the DEFINED spelling that wins, not the one that was typed — which
/// is Excel's rule, and the reason this is a restamp rather than a
/// "preserve what the user wrote".
#[test]
fn the_defined_spelling_wins_over_whatever_was_typed() {
    let mut grid = engine::Grid::new();
    grid.set_cell(0, 0, engine::Cell::new_formula("=budgettotal+1".to_string()));
    let nr = name_table(&["BudgetTotal"]);
    restamp_grid_name_casing(&mut grid, &nr);
    assert_eq!(
        grid.get_cell(0, 0).unwrap().formula_string().unwrap(),
        "BudgetTotal+1"
    );
}

/// Cosmetic by construction: nothing that is not a defined name moves, and
/// a workbook with no names at all pays nothing and changes nothing.
#[test]
fn nothing_but_defined_names_is_touched_by_the_reload_restamp() {
    let mut grid = engine::Grid::new();
    grid.set_cell(0, 0, engine::Cell::new_formula("=SUM(A1:A10)+B2".to_string()));
    // COMMA, not the semicolon the app uses under sv-SE: the LOCALISED
    // separator is applied on the way to and from the UI (`localize_formula`),
    // and `parser::parse` — which is what `Cell::new_formula` calls, and what a
    // reload calls — takes the canonical form. A semicolon here parses as
    // nothing, `new_formula` stores the string as TEXT, and the fixture then
    // has no AST to restamp: the test would be asserting on a cell that is not
    // a formula at all.
    grid.set_cell(0, 1, engine::Cell::new_formula("=LET(rate, 2, rate*10)".to_string()));
    grid.set_cell(0, 2, engine::Cell::new_formula("=UnknownName*3".to_string()));

    // Every fixture must really be a FORMULA, or "nothing moved" is trivially
    // true of three text cells.
    let before: Vec<String> = (0..3)
        .map(|c| {
            grid.get_cell(0, c)
                .unwrap_or_else(|| panic!("fixture cell {c} exists"))
                .formula_string()
                .unwrap_or_else(|| panic!("fixture cell {c} parsed as a FORMULA, not text"))
        })
        .collect();

    // A name table that DOES define `rate` — the LET binding is a local and
    // must not be respelled after it.
    let nr = name_table(&["Rate"]);
    let n = restamp_grid_name_casing(&mut grid, &nr);

    let after: Vec<String> = (0..3)
        .map(|c| grid.get_cell(0, c).unwrap().formula_string().unwrap())
        .collect();
    assert_eq!(n, 0, "nothing was respelled");
    assert_eq!(before, after, "no formula moved");
}

/// An empty name table is the dominant case and must be a no-op that costs
/// nothing — the early return, pinned so it cannot be deleted silently.
#[test]
fn a_workbook_with_no_names_is_left_exactly_alone() {
    let mut grid = engine::Grid::new();
    grid.set_cell(0, 0, engine::Cell::new_formula("=BudgetTotal*2".to_string()));
    let n = restamp_grid_name_casing(&mut grid, &HashMap::new());
    assert_eq!(n, 0);
    assert_eq!(
        grid.get_cell(0, 0).unwrap().formula_string().unwrap(),
        "BUDGETTOTAL*2",
        "with no names defined there is nothing to restamp against"
    );
}
