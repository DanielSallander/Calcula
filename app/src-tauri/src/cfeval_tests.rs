//! FILENAME: app/src-tauri/src/cfeval_tests.rs
//! PURPOSE: Lane `cfeval` -- conditional-format and data-validation rule
//! formulas evaluated RELATIVE TO EACH CELL (NEW-cf-relative-eval), cell-value
//! rules whose operand is a formula or text (NEW-cf-cellvalue-formula-operand),
//! a rule keeping its meaning when its ranges change, and the CF command
//! refusals leaving the document clean (NEW-cf-update-dirty). A child module
//! of `conditional_formatting` (declared with `#[path]` there).
//!
//! Every Excel fact is [LIVE, Excel 16, 2026-11-05, cfeval/probe1.ps1 ..
//! probe3.ps1]; the case ids (P1.., Q1..) are the probes'.

use crate::conditional_formatting::*;
use crate::data_validation::{CustomRule, DataValidation, DataValidationRule};
use crate::persistence::FileState;
use engine::{Cell, Grid};
use std::collections::{HashMap, HashSet};

fn rect(sr: u32, sc: u32, er: u32, ec: u32) -> ConditionalFormatRange {
    ConditionalFormatRange { start_row: sr, start_col: sc, end_row: er, end_col: ec }
}

/// `A1`-style address -> 0-based (row, col).
fn at(a1: &str) -> (u32, u32) {
    let letters: String = a1.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
    let digits: String = a1.chars().skip_while(|c| c.is_ascii_alphabetic()).collect();
    (digits.parse::<u32>().unwrap() - 1, engine::col_to_index(&letters))
}

fn num(grid: &mut Grid, a1: &str, v: f64) {
    let (r, c) = at(a1);
    grid.set_cell(r, c, Cell::new_number(v));
}

fn text(grid: &mut Grid, a1: &str, v: &str) {
    let (r, c) = at(a1);
    grid.set_cell(r, c, Cell::new_text(v.to_string()));
}

fn def(id: u64, rule: ConditionalFormatRule, ranges: Vec<ConditionalFormatRange>) -> ConditionalFormatDefinition {
    ConditionalFormatDefinition {
        id,
        priority: id as u32,
        rule,
        format: ConditionalFormat { background_color: Some("#FF0000".to_string()), ..Default::default() },
        ranges,
        stop_if_true: false,
        enabled: true,
    }
}

fn expression(formula: &str) -> ConditionalFormatRule {
    ConditionalFormatRule::Expression(ExpressionRule { formula: formula.to_string() })
}

fn cell_value(operator: CellValueOperator, v1: &str, v2: Option<&str>) -> ConditionalFormatRule {
    ConditionalFormatRule::CellValue(CellValueRule {
        operator,
        value1: v1.to_string(),
        value2: v2.map(str::to_string),
    })
}

/// The cells of `grids[0]` (named `names[0]`) a rule formats, over rows
/// 0..=rows-1 and cols 0..=cols-1, as a set of A1 addresses.
fn formatted(
    grids: &[Grid],
    names: &[String],
    named: Option<&HashMap<String, crate::named_ranges::NamedRange>>,
    rules: &[ConditionalFormatDefinition],
    rows: u32,
    cols: u32,
) -> HashSet<String> {
    evaluate_conditional_formats_with_names(&grids[0], grids, names, 0, named, rules, 0, rows - 1, 0, cols - 1)
        .into_iter()
        .map(|cf| format!("{}{}", engine::index_to_col(cf.col), cf.row + 1))
        .collect()
}

fn set(addrs: &[&str]) -> HashSet<String> {
    addrs.iter().map(|s| s.to_string()).collect()
}

fn one_sheet() -> Vec<String> {
    vec!["Sheet1".to_string()]
}

/// P1: `=$C2>100` on A2:E10 with C = 30 x row. Row 7 tests $C7: A4..E10 are
/// formatted (C4 = 120), rows 2-3 are not. Calcula evaluated the stored
/// `=$C2>100` for EVERY cell, so C2 = 60 decided the whole range (nothing).
/// SABOTAGE (cfeval-rel): `eval_ast_at` never moves the formula.
#[test]
fn an_expression_rule_reads_each_cells_own_row() {
    let mut g = Grid::new();
    for r in 1..=10u32 {
        num(&mut g, &format!("C{}", r), 30.0 * r as f64);
    }
    let rules = vec![def(1, expression("=$C2>100"), vec![rect(1, 0, 9, 4)])];
    let got = formatted(&[g], &one_sheet(), None, &rules, 10, 5);
    for a in ["A4", "E7", "B10", "D4"] {
        assert!(got.contains(a), "{} must be formatted: {:?}", a, got);
    }
    for a in ["A2", "A3", "D3", "E2"] {
        assert!(!got.contains(a), "{} must not be formatted: {:?}", a, got);
    }
}

/// P3: `=B$1>$A2` on B2:C3 -- the column part moves across, the row part
/// down; B1 = 5, C1 = 50, A2 = 10, A3 = 1: B2 no, C2 / B3 / C3 yes.
#[test]
fn mixed_references_move_only_their_relative_parts() {
    let mut g = Grid::new();
    num(&mut g, "B1", 5.0);
    num(&mut g, "C1", 50.0);
    num(&mut g, "A2", 10.0);
    num(&mut g, "A3", 1.0);
    let rules = vec![def(1, expression("=B$1>$A2"), vec![rect(1, 1, 2, 2)])];
    assert_eq!(formatted(&[g], &one_sheet(), None, &rules, 3, 3), set(&["C2", "B3", "C3"]));
}

/// Q1/Q2/Q3 + P2: the anchor is the top-left of the rectangle BOUNDING every
/// range, whatever order the ranges come in. Saved `C1=1` on `C1:C2 A5:A6`
/// means "two columns right" (C1 reads E1, A5 reads C5); `A1>0` on
/// `B5:B6 B1:B2` means the left neighbour (B1 reads A1, B6 reads A6).
/// SABOTAGE (cfeval-anchor): `rule_anchor` returns the FIRST range's top-left.
#[test]
fn the_anchor_of_several_ranges_is_their_bounding_top_left() {
    let mut g = Grid::new();
    num(&mut g, "E1", 1.0);
    num(&mut g, "C5", 1.0);
    let rules = vec![def(1, expression("=C1=1"), vec![rect(0, 2, 1, 2), rect(4, 0, 5, 0)])];
    assert_eq!(formatted(&[g.clone()], &one_sheet(), None, &rules, 6, 5), set(&["C1", "A5"]));
    let rules = vec![def(1, expression("=C1=1"), vec![rect(4, 0, 5, 0), rect(0, 2, 1, 2)])];
    assert_eq!(formatted(&[g], &one_sheet(), None, &rules, 6, 5), set(&["C1", "A5"]));

    let mut g = Grid::new();
    num(&mut g, "A1", 1.0);
    num(&mut g, "A2", 0.0);
    num(&mut g, "A5", 0.0);
    num(&mut g, "A6", 1.0);
    let rules = vec![def(1, expression("=A1>0"), vec![rect(4, 1, 5, 1), rect(0, 1, 1, 1)])];
    assert_eq!(formatted(&[g], &one_sheet(), None, &rules, 6, 2), set(&["B1", "B6"]));
}

/// P4 / P4b / P4d: a reference moved past the sheet's edge WRAPS, never
/// `#REF!`: `=B1048576=1` on A1:A3 makes A2 read B1; `=XFD7=1` on A7:B7 makes
/// B7 read A7; `=ISERROR(B1048576)` formats nothing.
#[test]
fn a_reference_moved_past_the_edge_wraps_round_the_sheet() {
    let mut g = Grid::new();
    num(&mut g, "B1", 1.0);
    num(&mut g, "B2", 0.0);
    num(&mut g, "A7", 1.0);
    let rules = vec![
        def(1, expression("=B1048576=1"), vec![rect(0, 0, 2, 0)]),
        def(2, expression("=XFD7=1"), vec![rect(6, 0, 6, 1)]),
        def(3, expression("=ISERROR(B1048576)"), vec![rect(0, 3, 2, 3)]),
    ];
    assert_eq!(formatted(&[g], &one_sheet(), None, &rules, 7, 4), set(&["A2", "B7"]));
}

/// P5: `=Other!A1>0` on B1:B3 reads Other!A2 in B2. P8: `=SUM(C:C)>5` on
/// A1:B2 reads D:D in column B; `=SUM(3:3)>0` on F1:F2 reads row 4 in F2.
#[test]
fn other_sheet_whole_column_and_whole_row_references_move_too() {
    let mut sheet = Grid::new();
    num(&mut sheet, "C1", 4.0);
    num(&mut sheet, "C2", 6.0);
    num(&mut sheet, "Z4", 1.0);
    let mut other = Grid::new();
    num(&mut other, "A1", 0.0);
    num(&mut other, "A2", 1.0);
    num(&mut other, "A3", 0.0);
    let names = vec!["Sheet1".to_string(), "Other".to_string()];
    let rules = vec![
        def(1, expression("=Other!A1>0"), vec![rect(0, 7, 2, 7)]),
        def(2, expression("=SUM(C:C)>5"), vec![rect(0, 0, 1, 1)]),
        def(3, expression("=SUM(3:3)>0"), vec![rect(0, 5, 1, 5)]),
    ];
    assert_eq!(formatted(&[sheet, other], &names, None, &rules, 3, 8), set(&["H2", "A1", "A2", "F2"]));
}

/// probe2 P9: ROW() is the evaluated cell's (`=MOD(ROW(),2)=0` on A1:A4
/// formats A2 and A4). Evaluated positionless, ROW() was #VALUE! and banding
/// formatted nothing.
#[test]
fn row_and_column_are_the_evaluated_cells() {
    let rules = vec![
        def(1, expression("=MOD(ROW(),2)=0"), vec![rect(0, 0, 3, 0)]),
        def(2, expression("=COLUMN()=8"), vec![rect(0, 6, 0, 8)]),
    ];
    assert_eq!(formatted(&[Grid::new()], &one_sheet(), None, &rules, 4, 9), set(&["A2", "A4", "H1"]));
}

/// P6: a defined name resolves in a rule as in a cell (`=A1>Thr`, Thr =
/// `$D$1` = 5; A1 = 1, A2 = 10). Unresolved it was #NAME? and formatted nothing.
#[test]
fn a_defined_name_resolves_in_a_rule() {
    let mut g = Grid::new();
    num(&mut g, "D1", 5.0);
    num(&mut g, "A1", 1.0);
    num(&mut g, "A2", 10.0);
    let mut named = HashMap::new();
    named.insert(
        "THR".to_string(),
        crate::named_ranges::NamedRange {
            name: "Thr".to_string(),
            sheet_index: None,
            refers_to: "=Sheet1!$D$1".to_string(),
            comment: None,
            folder: None,
        },
    );
    let rules = vec![def(1, expression("=A1>Thr"), vec![rect(0, 0, 2, 0)])];
    assert_eq!(formatted(&[g], &one_sheet(), Some(&named), &rules, 3, 1), set(&["A2"]));
}

/// Round E (namese p1) [LIVE]: a RELATIVE name in a rule is read from each
/// evaluated cell, as a cell's formula reads it. `rel = Sheet1!A1` means the
/// cell that uses it, so `=ROW(rel)=2` on A1:A3 colours A2 only. Read as
/// written (anchored at A1), every cell would see ROW(A1) = 1 and none colour.
#[test]
fn a_relative_name_in_a_rule_is_read_from_each_cell() {
    let mut g = Grid::new();
    num(&mut g, "A1", 1.0);
    let mut named = HashMap::new();
    named.insert(
        "REL".to_string(),
        crate::named_ranges::NamedRange {
            name: "rel".to_string(),
            sheet_index: None,
            refers_to: "=Sheet1!A1".to_string(),
            comment: None,
            folder: None,
        },
    );
    let rules = vec![def(1, expression("=ROW(rel)=2"), vec![rect(0, 0, 2, 0)])];
    assert_eq!(formatted(&[g], &one_sheet(), Some(&named), &rules, 3, 1), set(&["A2"]));
}

/// P10a-P10i: a cell-value rule compares the CELL with each operand by Excel's
/// operators, and an operand may be a formula (relative to the cell like an
/// expression rule) or text. Calcula only parsed the operands as numbers, so
/// `=$D$1`, `=B1` and `"abc"` never matched and text cells never did either.
/// SABOTAGE (cfeval-cv): `operand` treats every `=` formula as missing.
#[test]
fn a_cell_value_rule_compares_by_excels_operators_with_formula_and_text_operands() {
    let mut g = Grid::new();
    // a: > $D$1 (5) over 3, 7, "x", blank.
    num(&mut g, "D1", 5.0);
    num(&mut g, "A1", 3.0);
    num(&mut g, "A2", 7.0);
    text(&mut g, "A3", "x");
    // b: > B1 relative over C = 3, 7, 0 against B = 10, 1, 1.
    num(&mut g, "B1", 10.0);
    num(&mut g, "B2", 1.0);
    num(&mut g, "B3", 1.0);
    num(&mut g, "C1", 3.0);
    num(&mut g, "C2", 7.0);
    num(&mut g, "C3", 0.0);
    // c: = "abc" over abc, ABC, x, 5, blank (E1:E5).
    text(&mut g, "E1", "abc");
    text(&mut g, "E2", "ABC");
    text(&mut g, "E3", "x");
    num(&mut g, "E4", 5.0);
    // d: < 5 over 3, 7, "x", blank (F1:F4).
    num(&mut g, "F1", 3.0);
    num(&mut g, "F2", 7.0);
    text(&mut g, "F3", "x");
    // e: between =H1 and =H1*5 over 3, 7, 12 with H = 2 (G1:G3).
    num(&mut g, "G1", 3.0);
    num(&mut g, "G2", 7.0);
    num(&mut g, "G3", 12.0);
    for r in 1..=3 {
        num(&mut g, &format!("H{}", r), 2.0);
    }
    // f: > "a" over "b", "Z", 100 (I1:I3).
    text(&mut g, "I1", "b");
    text(&mut g, "I2", "Z");
    num(&mut g, "I3", 100.0);
    // g: = TRUE over TRUE, 1 (J1:J2).
    let (r, c) = at("J1");
    g.set_cell(r, c, Cell::new_boolean(true));
    num(&mut g, "J2", 1.0);
    let rules = vec![
        def(1, cell_value(CellValueOperator::GreaterThan, "=$D$1", None), vec![rect(0, 0, 3, 0)]),
        def(2, cell_value(CellValueOperator::GreaterThan, "=B1", None), vec![rect(0, 2, 2, 2)]),
        def(3, cell_value(CellValueOperator::Equal, "abc", None), vec![rect(0, 4, 4, 4)]),
        def(4, cell_value(CellValueOperator::LessThan, "5", None), vec![rect(0, 5, 3, 5)]),
        def(5, cell_value(CellValueOperator::Between, "=H1", Some("=H1*5")), vec![rect(0, 6, 2, 6)]),
        def(6, cell_value(CellValueOperator::GreaterThan, "a", None), vec![rect(0, 8, 2, 8)]),
        def(7, cell_value(CellValueOperator::Equal, "TRUE", None), vec![rect(0, 9, 1, 9)]),
    ];
    let got = formatted(&[g], &one_sheet(), None, &rules, 5, 10);
    let want = set(&[
        "A2", "A3", // a
        "C2", // b
        "E1", "E2", // c
        "F1", "F4", // d
        "G1", "G2", // e
        "I1", "I2", // f
        "J1", // g
    ]);
    assert_eq!(got, want);
}

/// P10h/P10i: an error cell, or an operand that is an error, matches nothing;
/// a not-between with an error operand does not match either.
#[test]
fn an_error_on_either_side_of_a_cell_value_rule_matches_nothing() {
    let mut g = Grid::new();
    let (r, c) = at("K1");
    g.set_cell(r, c, Cell { value: engine::CellValue::Error(engine::CellError::Div0), ..Cell::new() });
    num(&mut g, "K2", 9.0);
    num(&mut g, "L1", 9.0);
    let rules = vec![
        def(1, cell_value(CellValueOperator::GreaterThan, "1", None), vec![rect(0, 10, 1, 10)]),
        def(2, cell_value(CellValueOperator::GreaterThan, "=1/0", None), vec![rect(0, 11, 0, 11)]),
        def(3, cell_value(CellValueOperator::NotBetween, "=1/0", Some("3")), vec![rect(1, 11, 1, 11)]),
    ];
    assert_eq!(formatted(&[g], &one_sheet(), None, &rules, 2, 12), set(&["K2"]));
}

// ---------------------------------------------------------------------------
// Command bodies
// ---------------------------------------------------------------------------

struct Book {
    state: crate::AppState,
    file: FileState,
}

impl Book {
    fn new() -> Self {
        Book { state: crate::create_app_state(), file: FileState::default() }
    }

    fn put(&self, a1: &str, v: f64) {
        let (r, c) = at(a1);
        let seed = crate::document_effect::test_seed_effect();
        self.state.grids.write(&seed).unwrap()[0].set_cell(r, c, Cell::new_number(v));
        self.state.grid.write(&seed).unwrap().set_cell(r, c, Cell::new_number(v));
    }

    fn add(&self, rule: ConditionalFormatRule, ranges: Vec<ConditionalFormatRange>) -> u64 {
        let r = add_conditional_format_impl(
            &self.state,
            &self.file,
            AddCFParams {
                rule,
                format: ConditionalFormat { background_color: Some("#FF0000".to_string()), ..Default::default() },
                ranges,
                stop_if_true: false,
                target: None,
            },
        );
        assert!(r.success, "{:?}", r.error);
        r.rule.unwrap().id
    }

    fn formatted(&self, rows: u32, cols: u32) -> HashSet<String> {
        let rules = self.state.conditional_formats.read().unwrap().get(&0).cloned().unwrap_or_default();
        let grids = self.state.grids.read().unwrap();
        let names = self.state.sheet_names.read().unwrap();
        formatted(&grids, &names, None, &rules, rows, cols)
    }

    fn formula(&self, id: u64) -> String {
        let store = self.state.conditional_formats.read().unwrap();
        match &store.get(&0).unwrap().iter().find(|r| r.id == id).unwrap().rule {
            ConditionalFormatRule::Expression(e) => e.formula.clone(),
            other => panic!("not an expression rule: {:?}", other),
        }
    }
}

/// P13: clearing A1:A2 of `=$B1>5` on A1:A5 (B = 10, 10, 0, 0, 10) leaves
/// A3:A5 testing B3..B5 -- only A5 formatted, the rule saved as `$B3>5`. The
/// clear used to keep `=$B1>5` against the new top-left A3, so A3 read B1.
/// SABOTAGE (cfeval-restate): `restate_rule_for_ranges` returns false at once.
#[test]
fn clearing_part_of_a_rule_keeps_what_the_rest_tests() {
    let book = Book::new();
    for (r, v) in [10.0, 10.0, 0.0, 0.0, 10.0].iter().enumerate() {
        book.put(&format!("B{}", r + 1), *v);
    }
    let id = book.add(expression("=$B1>5"), vec![rect(0, 0, 4, 0)]);
    assert_eq!(clear_conditional_formats_in_range_impl(&book.state, &book.file, 0, 0, 1, 0, None).unwrap(), 1);
    assert_eq!(book.formula(id), "=$B3>5");
    assert_eq!(book.formatted(5, 1), set(&["A5"]));
}

/// P14: new ranges alone (Excel's `ModifyAppliesToRange(A3:A5)`) keep the
/// rule's meaning too; a caller that sends the rule with them states it for
/// the new ranges itself.
#[test]
fn new_ranges_alone_keep_the_rules_meaning() {
    let book = Book::new();
    for (r, v) in [10.0, 10.0, 0.0, 0.0, 10.0].iter().enumerate() {
        book.put(&format!("B{}", r + 1), *v);
    }
    let id = book.add(expression("=$B1>5"), vec![rect(0, 0, 4, 0)]);
    let r = update_conditional_format_impl(
        &book.state,
        &book.file,
        UpdateCFParams { rule_id: id, rule: None, format: None, ranges: Some(vec![rect(2, 0, 4, 0)]), stop_if_true: None, enabled: None, target: None },
    );
    assert!(r.success, "{:?}", r.error);
    assert_eq!(book.formula(id), "=$B3>5");
    assert_eq!(book.formatted(5, 1), set(&["A5"]));

    let r = update_conditional_format_impl(
        &book.state,
        &book.file,
        UpdateCFParams {
            rule_id: id,
            rule: Some(expression("=$B1>5")),
            format: None,
            ranges: Some(vec![rect(0, 0, 4, 0)]),
            stop_if_true: None,
            enabled: None,
            target: None,
        },
    );
    assert!(r.success, "{:?}", r.error);
    assert_eq!(book.formula(id), "=$B1>5", "a stated rule is kept as stated");
}

/// NEW-cf-update-dirty: `update_conditional_format_impl` minted the effect
/// before its "No conditional formats" / "Rule not found" refusals, so a
/// refused edit marked the document modified (the close prompt and
/// AutoRecover then guard a document nothing changed). Delete and reorder had
/// the same order. Each refusal must leave the document clean.
/// SABOTAGE (cfeval-dirty): the update's effect minted before its gates.
#[test]
fn a_refused_rule_edit_leaves_the_document_clean() {
    let book = Book::new();
    let update = |id: u64| {
        update_conditional_format_impl(
            &book.state,
            &book.file,
            UpdateCFParams { rule_id: id, rule: None, format: None, ranges: None, stop_if_true: Some(true), enabled: None, target: None },
        )
    };
    // No rules on the sheet at all.
    assert!(!update(7).success);
    assert!(!book.file.is_dirty(), "update: 'No conditional formats' dirtied the document");
    assert!(!delete_conditional_format_impl(&book.state, &book.file, 7).success);
    assert!(!book.file.is_dirty(), "delete: 'No conditional formats' dirtied the document");
    assert!(!reorder_conditional_formats_impl(&book.state, &book.file, vec![7]).success);
    assert!(!book.file.is_dirty(), "reorder: 'No conditional formats' dirtied the document");

    // A rule exists, but not this one.
    let id = book.add(expression("=A1>0"), vec![rect(0, 0, 0, 0)]);
    crate::document_effect::mark_saved(&book.file);
    let depth = book.state.undo_stack.lock().unwrap().undo_depth();
    assert!(!update(id + 100).success);
    assert!(!book.file.is_dirty(), "update: 'Rule not found' dirtied the document");
    assert!(!delete_conditional_format_impl(&book.state, &book.file, id + 100).success);
    assert!(!book.file.is_dirty(), "delete: 'Rule not found' dirtied the document");
    assert_eq!(book.state.undo_stack.lock().unwrap().undo_depth(), depth);

    // Positive control: the real edit still dirties and records.
    assert!(update(id).success);
    assert!(book.file.is_dirty());
}

/// P11: a CUSTOM validation formula is relative to its range's top-left:
/// `=B1>A1` on B1:B3 (B = 1, 1, -1 against A = 5, 0, 0) holds B1 and B3
/// invalid and B2 valid. Calcula tested `B1>A1` for every cell, so all three
/// were invalid. Driven through `get_invalid_cells_on`.
/// SABOTAGE (cfeval-dv): `custom_formula_value` evaluates at the anchor.
#[test]
fn a_custom_validation_formula_is_relative_to_its_ranges_top_left() {
    let book = Book::new();
    for (a1, v) in [("A1", 5.0), ("A2", 0.0), ("A3", 0.0), ("B1", 1.0), ("B2", 1.0), ("B3", -1.0)] {
        book.put(a1, v);
    }
    let set_dv = crate::data_validation::set_data_validation_impl(
        &book.state,
        &book.file,
        0,
        1,
        2,
        1,
        DataValidation {
            rule: DataValidationRule::Custom(CustomRule { formula: "=B1>A1".to_string() }),
            ..DataValidation::default()
        },
        None,
    );
    assert!(set_dv.success, "{:?}", set_dv.error);
    let invalid = crate::data_validation::get_invalid_cells_on(&book.state);
    let mut cells = invalid.cells.clone();
    cells.sort();
    assert_eq!(cells, vec![(0, 1), (2, 1)]);
}

/// The formula is parsed ONCE per pass, not once per cell: a pass over many
/// cells of one rule leaves one cached parse.
#[test]
fn a_pass_parses_each_rule_formula_once() {
    let grids = vec![Grid::new()];
    let names = one_sheet();
    let formulas = RuleFormulas::new(&grids, &names, 0, None);
    for row in 0..50 {
        let _ = formulas.value_at("=A1+1", (0, 0), row, 0);
    }
    assert_eq!(formulas.cached_parses(), 1);
}
