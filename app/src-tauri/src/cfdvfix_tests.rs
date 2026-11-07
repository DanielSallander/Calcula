//! FILENAME: app/src-tauri/src/cfdvfix_tests.rs
//! PURPOSE: Lane `cfdvfix` (ledger programme 2, wave 3) -- conditional-format
//! and data-validation follow-ups, driven through the real bodies:
//!   * BUG-0743: an edit on the sheet a rule REFERS to splits it; and Excel
//!     splits by meaning only when the edit reaches the columns the rule's
//!     references name (a relative part left of the anchor never counts),
//!     otherwise each piece the edit cut keeps what its first cell reads;
//!   * a pending FORMULA entry is judged by its value;
//!   * the dropdown shows numbers in the app locale;
//!   * Circle Invalid Data reads a growing (mixed-anchor) list source by index.
//! A child module of `cfdvb_tests` (its fixture `Fx` is reused).
//!
//! Every Excel fact is [LIVE, Excel 16, 2026-11-06, cfdvfix/probe1-7.ps1 and
//! verify-cfdvb/probeV1-2.ps1]; the case ids are the probes'.

use super::*;

impl Fx {
    /// Run `edit` with `sheet` active, then make Sheet1 active again.
    fn on_sheet(&self, sheet: usize, edit: impl FnOnce(&Fx)) {
        crate::sheets::activate_sheet(&self.state, sheet).expect("activate");
        edit(self);
        crate::sheets::activate_sheet(&self.state, 0).expect("back to Sheet1");
    }

    /// The list a cell's dropdown shows.
    fn dropdown(&self, a1: &str) -> Vec<String> {
        let (r, c) = at(a1);
        crate::data_validation::get_validation_list_values_on(&self.state, r, c).unwrap_or_default()
    }
}

/// A rule set as the test compares it: sheet quotes dropped (`='S2'!B12` and
/// `=S2!B12` are one reference).
fn unquoted(items: HashSet<(String, String)>) -> HashSet<(String, String)> {
    items.into_iter().map(|(a, f)| (a, f.replace('\'', ""))).collect()
}

fn custom(formula: &str) -> DataValidationRule {
    DataValidationRule::Custom(CustomRule { formula: formula.to_string() })
}

/// verify-cfdvb P1/P2/P3 and cfdvfix S13: an edit on the sheet a rule REFERS
/// to splits it as an edit on its own sheet does; a rule whose references the
/// edit does not reach in Excel's sense keeps one formula.
/// SABOTAGE (cfdvfix-oth): `shift_other_sheets_rule_formulas` never splits.
#[test]
fn an_edit_on_the_sheet_a_rule_refers_to_splits_the_rule() {
    // P1: =S2!B12>0 on B2:B10, delete S2 row 12.
    let fx = Fx::with_sheets(&["S2"]);
    let s2 = fx.index_of("S2");
    fx.expression("=S2!B12>0", &["B2:B10"]);
    fx.on_sheet(s2, |fx| fx.rows(false, 11, 1));
    let rules = unquoted(fx.rules());
    assert_eq!(rules.len(), 2, "{:?}", rules);
    assert!(rules.contains(&("B3:B10".to_string(), "=S2!B12>0".to_string())), "{:?}", rules);
    assert!(rules.iter().any(|(a, f)| a == "B2" && f.contains("#REF!")), "{:?}", rules);
    assert!(fx.rule_ids_unique());

    // P2: =S2!D1>0 on D2:D10, insert S2 row 5.
    let fx = Fx::with_sheets(&["S2"]);
    let s2 = fx.index_of("S2");
    fx.expression("=S2!D1>0", &["D2:D10"]);
    fx.on_sheet(s2, |fx| fx.rows(true, 4, 1));
    assert_eq!(unquoted(fx.rules()), set(&[("D2:D5", "=S2!D1>0"), ("D6:D10", "=S2!D6>0")]));

    // P3: a custom validation =S2!F12>0 on F2:F10, delete S2 row 12.
    let fx = Fx::with_sheets(&["S2"]);
    let s2 = fx.index_of("S2");
    fx.validate("F2:F10", custom("=S2!F12>0"));
    fx.on_sheet(s2, |fx| fx.rows(false, 11, 1));
    let f2 = fx.validation_at("F2").expect("F2 keeps a rule");
    assert_eq!(f2.0, "F2", "{:?}", fx.validations());
    assert!(f2.1.contains("#REF!"), "{:?}", f2);
    assert_eq!(
        fx.validation_at("F3").map(|(r, f)| (r, f.replace('\'', ""))),
        Some(("F3:F10".to_string(), "=S2!F12>0".to_string()))
    );

    // S13: =S2!K1>0 on M2:M6 (a reference LEFT of the anchor), delete S2
    // row 3 -> one rule, unchanged.
    let fx = Fx::with_sheets(&["S2"]);
    let s2 = fx.index_of("S2");
    fx.expression("=S2!K1>0", &["M2:M6"]);
    fx.on_sheet(s2, |fx| fx.rows(false, 2, 1));
    assert_eq!(unquoted(fx.rules()), set(&[("M2:M6", "=S2!K1>0")]));
}

/// Excel looks at each cell's own targets only when the edit reaches the
/// columns the references name, a relative part LEFT of the anchor never
/// counting; otherwise the rule is cut where its own cells were cut and each
/// piece keeps what its first cell reads. R9/W1/X1, R1/T1, T6, XB, R4;
/// Q1/Q2/Q4/Q5 (verify-cfdvb probeV2).
/// SABOTAGE (cfdvfix-col): `edit_reaches_formula_columns` always answers true.
#[test]
fn a_rule_splits_by_meaning_only_when_the_edit_reaches_its_columns() {
    use crate::commands::structure::structure_cells::CellShift;

    // R9: =K8>0 on M2:M6, delete row 10 -> ONE validation; M4 reads K10.
    let fx = Fx::new();
    fx.validate("M2:M6", custom("=K8>0"));
    fx.rows(false, 9, 1);
    assert_eq!(fx.validation_at("M4"), Some(("M2:M6".to_string(), "=K8>0".to_string())));
    // W1: =O8>0 (right of the anchor) splits M4 off.
    let fx = Fx::new();
    fx.validate("M2:M6", custom("=O8>0"));
    fx.rows(false, 9, 1);
    assert_eq!(fx.validation_at("M4").map(|v| v.1.contains("#REF!")), Some(true), "{:?}", fx.validations());
    assert_eq!(fx.validation_at("M5"), Some(("M5:M6".to_string(), "=O10>0".to_string())));
    // X1: an ABSOLUTE column counts wherever it is.
    let fx = Fx::new();
    fx.expression("=$K8>0", &["M2:M6"]);
    fx.rows(false, 9, 1);
    assert_eq!(fx.rules(), set(&[("M2:M3", "=$K8>0"), ("M4", "=#REF!>0"), ("M5:M6", "=$K10>0")]));
    // V1 (wave 4, [LIVE] verify-cfdvfix/vprobe1 V1): a row edit compares ROWS
    // too. =AND(K8>0,O1>0) on M2:M6 reads O1:O5, above row 10, and K is left
    // of the anchor: deleting row 10 keeps ONE rule.
    let fx = Fx::new();
    fx.expression("=AND(K8>0,O1>0)", &["M2:M6"]);
    fx.rows(false, 9, 1);
    assert_eq!(fx.rules(), set(&[("M2:M6", "=AND(K8>0,O1>0)")]), "ROWS NOT COMPARED: the rule split");
    // V11: =AND(O8>0,K8>0) reads O8:O12, which row 10 reaches: it splits.
    let fx = Fx::new();
    fx.expression("=AND(O8>0,K8>0)", &["M2:M6"]);
    fx.rows(false, 9, 1);
    assert!(fx.rules().len() > 1, "{:?}", fx.rules());
    // V13 ([LIVE] vprobe2 V13): a range one end of which is a relative column
    // part LEFT of the anchor does not count: =SUM(K8:O8)>0 keeps one rule.
    let fx = Fx::new();
    fx.expression("=SUM(K8:O8)>0", &["M2:M6"]);
    fx.rows(false, 9, 1);
    assert_eq!(fx.rules(), set(&[("M2:M6", "=SUM(K8:O8)>0")]), "LEFT END COUNTED: the rule split");

    // R1/T1: =K1>0 on M2:M6, delete row 3 -> M2 keeps =K1, the rest reads
    // what the old M4 read: the deleted K3.
    let fx = Fx::new();
    fx.expression("=K1>0", &["M2:M6"]);
    fx.rows(false, 2, 1);
    assert_eq!(fx.rules(), set(&[("M2", "=K1>0"), ("M3:M5", "=#REF!>0")]));

    // T6: =K1>0 on M2:M6, insert row 4 -> the inserted row joins the part
    // above; the moved part reads what the old M4 read.
    let fx = Fx::new();
    fx.expression("=K1>0", &["M2:M6"]);
    fx.rows(true, 3, 1);
    assert_eq!(fx.rules(), set(&[("M2:M4", "=K1>0"), ("M5:M7", "=K3>0")]));

    // XB: =A2>0 on C2:G2, delete column B -> one rule.
    let fx = Fx::new();
    fx.expression("=A2>0", &["C2:G2"]);
    fx.cols(false, 1, 1);
    assert_eq!(fx.rules(), set(&[("B2:F2", "=A2>0")]));

    // R4: =K3>0 on M2:M6, Delete Cells K3 up -> one rule, all #REF!.
    let fx = Fx::new();
    fx.expression("=K3>0", &["M2:M6"]);
    fx.cells("K3", CellShift::Up);
    let rules = fx.rules();
    assert_eq!(rules.len(), 1, "{:?}", rules);
    assert!(rules.iter().all(|(a, f)| a == "M2:M6" && f.contains("#REF!")), "{:?}", rules);

    // Q1/Q2/Q4/Q5 with K1:K8 = a..h.
    let seeded = || {
        let fx = Fx::new();
        for (i, v) in ["a", "b", "c", "d", "e", "f", "g", "h"].iter().enumerate() {
            fx.text(0, &format!("K{}", i + 1), v);
        }
        fx
    };
    // Q1: list =K1:K2 on M2:M4, delete row 3 -> M3 lists K3:K3 (d).
    let fx = seeded();
    fx.validate("M2:M4", list_range("K1:K2", ALL_RELATIVE, Some(0)));
    fx.rows(false, 2, 1);
    assert!(!fx.pending("M3", "b") && fx.pending("M3", "d"), "{:?}", fx.validations());
    // Q4: list =K1:K2 on M2:M4, delete row 1 -> ONE rule from M1's K1:K1,
    // so M2 lists K2:K2 (c), not K1:K2.
    let fx = seeded();
    fx.validate("M2:M4", list_range("K1:K2", ALL_RELATIVE, Some(0)));
    fx.rows(false, 0, 1);
    assert!(!fx.pending("M2", "b") && fx.pending("M2", "c"), "{:?}", fx.validations());
    // Q2: =COUNTA(K1:K2)=2 the same way -> one validation M1:M3.
    let fx = seeded();
    fx.validate("M2:M4", custom("=COUNTA(K1:K2)=2"));
    fx.rows(false, 0, 1);
    assert_eq!(fx.validation_at("M2"), Some(("M1:M3".to_string(), "=COUNTA(K1:K1)=2".to_string())));
    // Q5: list =K1 on M2:M6, Delete Cells K3 up -> nothing adjusts: M4 still
    // lists K3 (now d).
    let fx = seeded();
    fx.validate("M2:M6", list_range("K1", ALL_RELATIVE, Some(0)));
    fx.cells("K3", CellShift::Up);
    assert_eq!(fx.validations().len(), 1, "{:?}", fx.validations());
    assert!(fx.pending("M4", "d") && !fx.pending("M4", "c"), "{:?}", fx.validations());
}

/// probe7 E1/E4/E7/E8: a FORMULA entry is judged by its value.
/// SABOTAGE (cfdvfix-fml): a pending formula is assumed valid again.
#[test]
fn a_pending_formula_is_judged_by_its_value() {
    let fx = Fx::new();
    fx.validate(
        "A1:A5",
        DataValidationRule::WholeNumber(NumericRule { formula1: 1.0, formula2: Some(3.0), operator: DataValidationOperator::Between }),
    );
    assert!(!fx.pending("A1", "=5"), "=5 is outside 1..3");
    assert!(fx.pending("A2", "=1+1"));
    fx.num(0, "B1", 7.0);
    assert!(!fx.pending("A3", "=B1"), "B1 is 7");
    fx.validate("D1", custom("=D1>5"));
    assert!(!fx.pending("D1", "=3"));
    assert!(fx.pending("D1", "=9"));
}

/// The dropdown shows its numbers in the APP locale, and the entry check
/// still compares them (sv-SE: `1,5`).
/// SABOTAGE (cfdvfix-loc): the dropdown shows the invariant text again.
#[test]
fn the_dropdown_shows_numbers_in_the_app_locale() {
    let fx = Fx::new();
    fx.num(0, "F1", 1.5);
    fx.num(0, "F2", 2.0);
    fx.text(0, "F3", "x");
    fx.validate("H1", list_range("F1:F3", ListRelative::default(), Some(0)));
    *fx.state.locale.lock().unwrap() = engine::LocaleSettings::from_locale_id("sv-SE");
    assert_eq!(fx.dropdown("H1"), vec!["1,5".to_string(), "2".to_string(), "x".to_string()]);
    assert!(fx.pending("H1", "1,5"), "the item picked is entered as the number it shows");
}

/// A list source with mixed anchors grows with each cell (`=$F1:F$2`):
/// Circle Invalid Data answers each cell from one index and agrees with the
/// entry check, cell by cell.
/// SABOTAGE (cfdvfix-idx): the index answers every lookup "found".
#[test]
fn circle_invalid_data_reads_a_growing_list_source_by_index() {
    let fx = Fx::new();
    for i in 0..40u32 {
        fx.text(0, &format!("F{}", i + 1), &format!("v{}", i + 1));
    }
    let mixed = ListRelative { start_row: true, start_col: false, end_row: false, end_col: true };
    // J(2+d) reads $F(1+d):F$2: J2 F1:F2, J3 F2, J4 F2:F3, J40 F2:F39.
    fx.validate("J2:J40", list_range("F1:F2", mixed, Some(0)));
    let value = |i: u32| if i % 2 == 0 { format!("v{}", i - 1) } else { format!("v{}", i + 2) };
    for i in 2..=40u32 {
        fx.text(0, &format!("J{}", i), &value(i));
    }
    let invalid: HashSet<(u32, u32)> = crate::data_validation::get_invalid_cells_on(&fx.state).cells.into_iter().collect();
    for i in 2..=40u32 {
        let a1 = format!("J{}", i);
        let allowed = fx.pending(&a1, &value(i));
        assert_eq!(!invalid.contains(&at(&a1)), allowed, "{} = {}: the scan and the entry check disagree", a1, value(i));
    }
    assert!(invalid.contains(&at("J3")), "J3 lists F2 alone, not v5");
    assert!(!invalid.contains(&at("J4")), "J4 lists F2:F3, so v3");
}

/// A custom rule that reads a cell on ANOTHER sheet which follows the entry
/// judges the entry: Calc!B2 = Sheet1!H2*2, `=Calc!B2>10` on H2 takes 8 and
/// refuses 3 (Excel calculates before it judges, cfdvb/probe4 E1/E2).
/// SABOTAGE (cfdvfix-xsd): the other sheets are not re-evaluated.
#[test]
fn a_pending_entry_recalculates_its_readers_on_other_sheets_first() {
    let fx = Fx::with_sheets(&["Calc"]);
    let calc = fx.index_of("Calc");
    fx.put(calc, "B2", engine::Cell::new_formula("Sheet1!H2*2".to_string()));
    fx.state
        .cross_sheet_dependents
        .lock()
        .unwrap()
        .entry(("Sheet1".to_string(), 1, 7))
        .or_default()
        .insert((calc, 1, 1));
    fx.validate("H2", custom("=Calc!B2>10"));
    assert!(fx.pending("H2", "8"), "Calc!B2 would be 16: its stale 0 must not decide");
    assert!(!fx.pending("H2", "3"), "Calc!B2 would be 6");
}

/// Ledger programme 2 wave 4 (dtcf4, the Rules Manager's other sheets):
/// Excel's Conditional Formatting Rules Manager, "Show formatting rules for"
/// another worksheet, edits THAT sheet's rules -- New, Edit, Delete and the
/// order -- without switching to it. The CF write commands acted on the
/// active sheet (or an object) only; each now takes an optional sheet index.
/// A named sheet that does not exist, or is protected without Format Cells,
/// refuses, and the document stays clean.
///
/// SABOTAGE (dtcf4-cfs): make `cf_write_sheet` ignore `sheet_index` -- fails
/// at "WROTE THE ACTIVE SHEET".
#[test]
fn the_rules_manager_edits_another_sheets_rules_by_index() {
    use crate::conditional_formatting as cf;
    let fx = Fx::with_sheets(&["S2"]);
    let s2 = fx.index_of("S2");
    let add = |formula: &str| {
        cf::add_conditional_format_in(
            &fx.state,
            &fx.file,
            AddCFParams {
                rule: ConditionalFormatRule::Expression(ExpressionRule { formula: formula.to_string() }),
                format: ConditionalFormat::default(),
                ranges: vec![rect("B2:B4")],
                stop_if_true: false,
                target: None,
            },
            Some(s2),
        )
    };
    let on = |sheet: usize| -> Vec<(u64, String)> {
        let store = fx.state.conditional_formats.read().unwrap();
        store
            .get(&sheet)
            .map(|rules| {
                rules
                    .iter()
                    .map(|r| {
                        let mut rule = r.rule.clone();
                        (r.id, rule_formulas_mut(&mut rule)[0].clone())
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    let first = add("=B2>1");
    assert!(first.success, "{:?}", first.error);
    let second = add("=B2>2");
    assert!(second.success, "{:?}", second.error);
    assert!(on(0).is_empty(), "WROTE THE ACTIVE SHEET: {:?}", on(0));
    let (a, b) = (first.rule.unwrap().id, second.rule.unwrap().id);
    assert_eq!(on(s2), vec![(a, "=B2>1".to_string()), (b, "=B2>2".to_string())]);

    let edited = cf::update_conditional_format_in(
        &fx.state,
        &fx.file,
        UpdateCFParams {
            rule_id: a,
            rule: Some(ConditionalFormatRule::Expression(ExpressionRule { formula: "=B2>5".to_string() })),
            format: None,
            ranges: None,
            stop_if_true: None,
            enabled: None,
            target: None,
        },
        Some(s2),
    );
    assert!(edited.success, "{:?}", edited.error);
    assert!(cf::reorder_conditional_formats_in(&fx.state, &fx.file, vec![b, a], None, Some(s2)).success);
    assert_eq!(on(s2), vec![(b, "=B2>2".to_string()), (a, "=B2>5".to_string())]);
    assert!(cf::delete_conditional_format_in(&fx.state, &fx.file, b, None, Some(s2)).success);
    assert_eq!(on(s2), vec![(a, "=B2>5".to_string())]);
    // Ctrl+Z puts the other sheet's rule back.
    let step = fx.state.undo_stack.lock().unwrap().pop_undo().expect("the delete's step");
    let _ = crate::undo_commands::apply_changes(
        &fx.state, &fx.file, &fx.files, &fx.pivots, &fx.slicer, &fx.filters, &fx.pane, &fx.timeline, step, true,
    );
    assert_eq!(on(s2).len(), 2, "Ctrl+Z did not bring the other sheet's rule back");

    // A sheet that does not exist, and a protected one, refuse.
    assert!(!cf::delete_conditional_format_in(&fx.state, &fx.file, a, None, Some(9)).success);
    fx.state
        .sheet_protection
        .write(&crate::document_effect::test_seed_effect())
        .unwrap()
        .insert(s2, crate::protection::SheetProtection { protected: true, ..Default::default() });
    crate::document_effect::mark_saved(&fx.file);
    let refused = cf::delete_conditional_format_in(&fx.state, &fx.file, a, None, Some(s2));
    assert!(!refused.success, "a protected sheet's rule was deleted");
    assert!(!fx.file.is_dirty(), "a refusal dirtied the document");
    assert_eq!(on(s2).len(), 2);
}

/// Ledger programme 2 wave 5 (misc5): the pending check writes the entry and
/// its readers' values into SCRATCH copies of the sheets (`scratch_grid`,
/// `reader_scratch_grid`) -- which is why the recalculation and spill-map
/// censuses list `validate_pending_value_on` as exempt. This pins the reason:
/// a check that re-evaluates a same-sheet dependent (G2 = H2*2) AND a reader
/// on another sheet (Calc!B2 = Sheet1!H2*3) leaves every document cell as it
/// was, the active-sheet mirror too, the document clean and the undo stack
/// where it stood.
///
/// SABOTAGE (misc5-dvs): install the scratch grid into `state.grids` before
/// the check returns -- fails at "SCRATCH REACHED THE DOCUMENT".
#[test]
fn a_pending_check_leaves_the_document_untouched() {
    let fx = Fx::with_sheets(&["Calc"]);
    let calc = fx.index_of("Calc");
    fx.put(0, "G2", engine::Cell::new_formula("H2*2".to_string()));
    fx.state.dependents.lock().unwrap().entry(at("H2")).or_default().insert(at("G2"));
    fx.put(calc, "B2", engine::Cell::new_formula("Sheet1!H2*3".to_string()));
    fx.state
        .cross_sheet_dependents
        .lock()
        .unwrap()
        .entry(("Sheet1".to_string(), 1, 7))
        .or_default()
        .insert((calc, 1, 1));
    fx.validate("H2", custom("=AND(G2>10,Calc!B2>20)"));
    crate::document_effect::mark_saved(&fx.file);
    let snapshot = |fx: &Fx| -> (Vec<String>, String) {
        let grids = fx.state.grids.read().unwrap();
        let cells = |g: &engine::Grid| {
            let mut v: Vec<String> = g.cells.iter().map(|(k, c)| format!("{:?}={:?}", k, c.value)).collect();
            v.sort();
            v.join(";")
        };
        (grids.iter().map(cells).collect(), cells(&fx.state.grid.read().unwrap()))
    };
    let before = snapshot(&fx);
    let depth = fx.state.undo_stack.lock().unwrap().undo_depth();
    assert!(fx.pending("H2", "8"), "precondition: G2 would be 16 and Calc!B2 24, so the readers WERE re-evaluated");
    assert!(!fx.pending("H2", "3"), "precondition: G2 would be 6");
    assert_eq!(snapshot(&fx), before, "SCRATCH REACHED THE DOCUMENT: a pending check changed a stored cell");
    assert!(!fx.file.is_dirty(), "a pending check dirtied the document");
    assert_eq!(fx.state.undo_stack.lock().unwrap().undo_depth(), depth, "a pending check recorded an undo step");
}
