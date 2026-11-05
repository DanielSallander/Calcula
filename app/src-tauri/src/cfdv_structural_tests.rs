//! FILENAME: app/src-tauri/src/cfdv_structural_tests.rs
//! PURPOSE: Lane `cfdv` -- conditional-format and data-validation RULE
//! FORMULAS through structural edits (NEW-cfdv-structural-shift) and the
//! entry refusal of a structured reference in either (NEW-cfdv-structured-refs),
//! driven through the real command bodies (`insert_rows_impl` and the other
//! three whole-line edits, `shift_cells_impl`, `add_conditional_format_impl`,
//! `set_data_validation_impl`). A child module of `conditional_formatting`
//! (declared with `#[path]` there).
//!
//! Every Excel fact is [LIVE, Excel 16, 2026-11-05, cfdv/probe1.ps1]; the
//! case ids (C1.., V1..) are the probe's.

use crate::commands::structure::structure_cells::{shift_cells_impl, CellShift};
use crate::conditional_formatting::*;
use crate::data_validation::{
    CustomRule, DataValidation, DataValidationRule, ListRule, ListSource, ValidationRange,
};
use crate::persistence::FileState;
use crate::pivot::types::PivotState;
use std::collections::{HashMap, HashSet};

struct Fx {
    state: crate::AppState,
    file: FileState,
    files: crate::persistence::UserFilesState,
    pivots: PivotState,
    pane: crate::pane_control::PaneControlState,
    filters: crate::ribbon_filter::RibbonFilterState,
    slicer: crate::slicer::SlicerState,
    timeline: crate::timeline_slicer::TimelineSlicerState,
}

/// `B2:B10` style rectangle, 0-based.
fn rect(sr: u32, sc: u32, er: u32, ec: u32) -> ConditionalFormatRange {
    ConditionalFormatRange { start_row: sr, start_col: sc, end_row: er, end_col: ec }
}

impl Fx {
    /// Sheet1 (active) and Other.
    fn new() -> Self {
        let state = crate::create_app_state();
        let seed = crate::document_effect::test_seed_effect();
        state.grids.write(&seed).unwrap().push(engine::Grid::new());
        state.sheet_names.write(&seed).unwrap().push("Other".to_string());
        state.all_column_widths.write(&seed).unwrap().push(HashMap::new());
        state.all_row_heights.write(&seed).unwrap().push(HashMap::new());
        state.all_user_hidden_rows.write(&seed).unwrap().push(HashSet::new());
        state.all_user_hidden_cols.write(&seed).unwrap().push(HashSet::new());
        state.sheet_ids.write(&seed).unwrap().push(identity::SheetId::from_bytes(identity::generate_uuid_v7()));
        {
            let mut all = state.all_merged_regions.write(&seed).unwrap();
            while all.len() < 2 {
                all.push(HashSet::new());
            }
        }
        Fx {
            state,
            file: FileState::default(),
            files: crate::persistence::UserFilesState::default(),
            pivots: PivotState::new(),
            pane: crate::pane_control::PaneControlState::new(),
            filters: crate::ribbon_filter::RibbonFilterState::new(),
            slicer: crate::slicer::SlicerState::new(),
            timeline: crate::timeline_slicer::TimelineSlicerState::new(),
        }
    }

    fn add_rule(&self, rule: ConditionalFormatRule, ranges: Vec<ConditionalFormatRange>) -> CFResult {
        add_conditional_format_impl(
            &self.state,
            &self.file,
            AddCFParams { rule, format: ConditionalFormat::default(), ranges, stop_if_true: false, target: None },
        )
    }

    fn expression(&self, formula: &str) {
        let r = self.add_rule(
            ConditionalFormatRule::Expression(ExpressionRule { formula: formula.to_string() }),
            vec![rect(1, 1, 9, 1)],
        );
        assert!(r.success, "{:?}", r.error);
    }

    fn validate(&self, sr: u32, sc: u32, er: u32, ec: u32, rule: DataValidationRule) -> crate::data_validation::DataValidationResult {
        crate::data_validation::set_data_validation_impl(
            &self.state,
            &self.file,
            sr,
            sc,
            er,
            ec,
            DataValidation { rule, ..DataValidation::default() },
            None,
        )
    }

    /// Sheet1's rules as `(ranges, formulas)`.
    fn rules(&self, sheet: usize) -> Vec<(Vec<(u32, u32, u32, u32)>, Vec<String>)> {
        let store = self.state.conditional_formats.read().unwrap();
        store
            .get(&sheet)
            .map(|rules| {
                rules
                    .iter()
                    .map(|r| {
                        let mut rule = r.rule.clone();
                        (
                            r.ranges.iter().map(|g| (g.start_row, g.start_col, g.end_row, g.end_col)).collect(),
                            rule_formulas_mut(&mut rule).into_iter().map(|f| f.clone()).collect(),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn only_rule(&self) -> (Vec<(u32, u32, u32, u32)>, String) {
        let rules = self.rules(0);
        assert_eq!(rules.len(), 1, "{:?}", rules);
        (rules[0].0.clone(), rules[0].1[0].clone())
    }

    fn validations(&self, sheet: usize) -> Vec<ValidationRange> {
        self.state.data_validations.read().unwrap().get(&sheet).cloned().unwrap_or_default()
    }

    fn rows(&self, insert: bool, at: u32, count: u32, sheet: Option<usize>) {
        let r = if insert {
            crate::commands::structure::insert_rows_impl(
                &self.state, &self.file, &self.pivots, &self.files, &self.pane, &self.filters, &self.slicer,
                &self.timeline, at, count, sheet,
            )
        } else {
            crate::commands::structure::delete_rows_impl(
                &self.state, &self.file, &self.pivots, &self.files, &self.pane, &self.filters, &self.slicer,
                &self.timeline, at, count, sheet,
            )
        };
        r.expect("row edit");
    }

    fn cols(&self, insert: bool, at: u32, count: u32) {
        let r = if insert {
            crate::commands::structure::insert_columns_impl(
                &self.state, &self.file, &self.pivots, &self.files, &self.pane, &self.filters, &self.slicer,
                &self.timeline, at, count, None,
            )
        } else {
            crate::commands::structure::delete_columns_impl(
                &self.state, &self.file, &self.pivots, &self.files, &self.pane, &self.filters, &self.slicer,
                &self.timeline, at, count, None,
            )
        };
        r.expect("column edit");
    }

    fn cells(&self, sr: u32, sc: u32, er: u32, ec: u32, shift: CellShift) {
        shift_cells_impl(
            &self.state, &self.file, &self.pivots, &self.files, &self.pane, &self.filters, &self.slicer,
            &self.timeline, sr, sc, er, ec, shift, false,
        )
        .expect("cell shift");
    }

    fn undo(&self) {
        let transaction = self.state.undo_stack.lock().unwrap().pop_undo().expect("nothing to undo");
        crate::undo_commands::apply_changes(
            &self.state, &self.file, &self.files, &self.pivots, &self.slicer, &self.filters, &self.pane,
            &self.timeline, transaction, true,
        );
    }
}

/// C1-C6, C14: `=B2>$D$1` on B2:B10 through whole-row and whole-column edits,
/// and ONE Ctrl+Z puts range and formula back together. Calcula moved the
/// range and left the formula reading the old cells.
/// SABOTAGE (cfdv-shift): `rebase_rule_formula` returns its input unchanged.
#[test]
fn a_rule_formula_follows_whole_line_edits_as_excels_does() {
    let b2_b10 = vec![(1, 1, 9, 1)];

    // C1: insert row 1 -> B3:B11 `=B3>$D$2`; one undo restores both.
    let fx = Fx::new();
    fx.expression("=B2>$D$1");
    fx.rows(true, 0, 1, None);
    assert_eq!(fx.only_rule(), (vec![(2, 1, 10, 1)], "=B3>$D$2".to_string()));
    fx.undo();
    assert_eq!(fx.only_rule(), (b2_b10.clone(), "=B2>$D$1".to_string()));

    // C2: insert a column before D -> `=B2>$E$1`, range unchanged.
    let fx = Fx::new();
    fx.expression("=B2>$D$1");
    fx.cols(true, 3, 1);
    assert_eq!(fx.only_rule(), (b2_b10.clone(), "=B2>$E$1".to_string()));

    // C3: delete row 1 -> B1:B9 `=B1>#REF!`.
    let fx = Fx::new();
    fx.expression("=B2>$D$1");
    fx.rows(false, 0, 1, None);
    assert_eq!(fx.only_rule(), (vec![(0, 1, 8, 1)], "=B1>#REF!".to_string()));

    // C4: delete the ANCHOR's row 2 -> B2:B9 `=B2>$D$1` (old B3's formula).
    let fx = Fx::new();
    fx.expression("=B2>$D$1");
    fx.rows(false, 1, 1, None);
    assert_eq!(fx.only_rule(), (vec![(1, 1, 8, 1)], "=B2>$D$1".to_string()));

    // C6: delete the row the absolute reference names -> `#REF!`.
    let fx = Fx::new();
    fx.expression("=B2>$D$20");
    fx.rows(false, 19, 1, None);
    assert_eq!(fx.only_rule(), (b2_b10.clone(), "=B2>#REF!".to_string()));

    // C14: delete column D -> `#REF!`.
    let fx = Fx::new();
    fx.expression("=B2>$D$1");
    fx.cols(false, 3, 1);
    assert_eq!(fx.only_rule(), (b2_b10.clone(), "=B2>#REF!".to_string()));

    // C8: `=$C2>100` with a column inserted at C -> B2:C10 `=$D2>100`.
    let fx = Fx::new();
    fx.expression("=$C2>100");
    fx.cols(true, 2, 1);
    assert_eq!(fx.only_rule(), (vec![(1, 1, 9, 2)], "=$D2>100".to_string()));
}

/// C10-C12, C17: Insert/Delete Cells move a rule formula's references through
/// the same band rule the cells use.
/// SABOTAGE (cfdv-shift) as above.
#[test]
fn a_rule_formula_follows_insert_and_delete_cells() {
    // C10: Insert Cells D1 down -> `$D$2`, range unchanged.
    let fx = Fx::new();
    fx.expression("=B2>$D$1");
    fx.cells(0, 3, 0, 3, CellShift::Down);
    assert_eq!(fx.only_rule(), (vec![(1, 1, 9, 1)], "=B2>$D$2".to_string()));

    // C17: Insert Cells B2 down -> B3:B11 `=B3>$D$1` (column D does not move).
    let fx = Fx::new();
    fx.expression("=B2>$D$1");
    fx.cells(1, 1, 1, 1, CellShift::Down);
    assert_eq!(fx.only_rule(), (vec![(2, 1, 10, 1)], "=B3>$D$1".to_string()));

    // C11: Delete Cells B1 up -> B1:B9 `=B1>$D$1`.
    let fx = Fx::new();
    fx.expression("=B2>$D$1");
    fx.cells(0, 1, 0, 1, CellShift::Up);
    assert_eq!(fx.only_rule(), (vec![(0, 1, 8, 1)], "=B1>$D$1".to_string()));

    // C12: Delete Cells C1 left -> `$C$1`.
    let fx = Fx::new();
    fx.expression("=B2>$D$1");
    fx.cells(0, 2, 0, 2, CellShift::Left);
    assert_eq!(fx.only_rule(), (vec![(1, 1, 9, 1)], "=B2>$C$1".to_string()));
}

/// C9, C13: a cell-value rule's `=$D$1` and a colour scale's formula point
/// move too; a bare literal operand is a value and is never rewritten.
/// SABOTAGE (cfdv-shift) as above.
#[test]
fn cell_value_and_threshold_formulas_follow_the_edit() {
    let fx = Fx::new();
    let cell_value = ConditionalFormatRule::CellValue(CellValueRule {
        operator: CellValueOperator::Between,
        value1: "=$D$1".to_string(),
        value2: Some("5".to_string()),
    });
    assert!(fx.add_rule(cell_value, vec![rect(1, 1, 9, 1)]).success);
    let point = |formula: Option<&str>| ColorScalePoint {
        value_type: if formula.is_some() { CFValueType::Formula } else { CFValueType::Min },
        value: None,
        formula: formula.map(str::to_string),
        color: "#FF0000".to_string(),
    };
    let scale = ConditionalFormatRule::ColorScale(ColorScaleRule {
        min_point: point(Some("=$D$1")),
        mid_point: None,
        max_point: point(None),
    });
    assert!(fx.add_rule(scale, vec![rect(1, 1, 9, 1)]).success);
    fx.rows(true, 0, 1, None);
    let rules = fx.rules(0);
    assert_eq!(rules[0].1, vec!["=$D$2".to_string()], "{:?}", rules);
    assert_eq!(rules[1].1, vec!["=$D$2".to_string()], "{:?}", rules);
    let store = fx.state.conditional_formats.read().unwrap();
    match &store[&0][0].rule {
        ConditionalFormatRule::CellValue(cv) => assert_eq!(cv.value2.as_deref(), Some("5")),
        other => panic!("{:?}", other),
    }
}

/// V1-V5, V11: a list source `=$F$1:$F$5` and a custom formula `=H2>$D$1` on
/// H2:H10. A source every cell of which is deleted becomes an empty list,
/// which refuses every entry as Excel's `=#REF!` source does.
/// SABOTAGE (cfdv-dv): `rebase_validation_formulas` returns false at once.
#[test]
fn validation_formulas_and_list_sources_follow_the_edit() {
    let list = || {
        DataValidationRule::List(ListRule {
            source: ListSource::Range { sheet_index: None, start_row: 0, start_col: 5, end_row: 4, end_col: 5 },
            in_cell_dropdown: true,
        })
    };
    let source = |fx: &Fx| match &fx.validations(0)[0].validation.rule {
        DataValidationRule::List(l) => match &l.source {
            ListSource::Range { start_row, start_col, end_row, end_col, .. } => Some((*start_row, *start_col, *end_row, *end_col)),
            ListSource::Values(v) => {
                assert!(v.is_empty(), "{:?}", v);
                None
            }
        },
        other => panic!("{:?}", other),
    };

    // V1: insert row 1 -> $F$2:$F$6.
    let fx = Fx::new();
    assert!(fx.validate(1, 7, 9, 7, list()).success);
    fx.rows(true, 0, 1, None);
    assert_eq!(source(&fx), Some((1, 5, 5, 5)));
    // V2: insert a column at F -> $G$1:$G$5 (the validated range moves to I).
    let fx = Fx::new();
    assert!(fx.validate(1, 7, 9, 7, list()).success);
    fx.cols(true, 5, 1);
    assert_eq!(source(&fx), Some((0, 6, 4, 6)));
    // V4: delete row 3 -> $F$1:$F$4.
    let fx = Fx::new();
    assert!(fx.validate(1, 7, 9, 7, list()).success);
    fx.rows(false, 2, 1, None);
    assert_eq!(source(&fx), Some((0, 5, 3, 5)));
    // V3: delete rows 1:5 -> `=#REF!`, here an empty list.
    let fx = Fx::new();
    assert!(fx.validate(1, 7, 9, 7, list()).success);
    fx.rows(false, 0, 5, None);
    assert_eq!(source(&fx), None);
    // V8: Insert Cells F1 down -> $F$2:$F$6.
    let fx = Fx::new();
    assert!(fx.validate(1, 7, 9, 7, list()).success);
    fx.cells(0, 5, 0, 5, CellShift::Down);
    assert_eq!(source(&fx), Some((1, 5, 5, 5)));

    let custom = || DataValidationRule::Custom(CustomRule { formula: "=H2>$D$1".to_string() });
    let formula = |fx: &Fx| match &fx.validations(0)[0].validation.rule {
        DataValidationRule::Custom(c) => c.formula.clone(),
        other => panic!("{:?}", other),
    };
    // V5: insert row 1 -> `=H3>$D$2`, and Ctrl+Z restores it.
    let fx = Fx::new();
    assert!(fx.validate(1, 7, 9, 7, custom()).success);
    fx.rows(true, 0, 1, None);
    assert_eq!(formula(&fx), "=H3>$D$2");
    fx.undo();
    assert_eq!(formula(&fx), "=H2>$D$1");
    // V11: delete row 1 -> `=H1>#REF!`.
    let fx = Fx::new();
    assert!(fx.validate(1, 7, 9, 7, custom()).success);
    fx.rows(false, 0, 1, None);
    assert_eq!(formula(&fx), "=H1>#REF!");
}

/// C7, V6: rules on Sheet1 that read Other follow a row inserted ON OTHER
/// (Other is not the active sheet, the off-sheet path) -- in that edit's one
/// undo step -- while Sheet1's own unqualified references stay.
/// SABOTAGE (cfdv-other): `shift_other_sheets_rule_formulas` returns at once.
#[test]
fn rules_reading_another_sheet_follow_an_edit_there() {
    let fx = Fx::new();
    fx.expression("=B2>Other!$A$1");
    let r = fx.validate(
        1,
        7,
        9,
        7,
        DataValidationRule::List(ListRule {
            source: ListSource::Range { sheet_index: Some(1), start_row: 0, start_col: 0, end_row: 2, end_col: 0 },
            in_cell_dropdown: true,
        }),
    );
    assert!(r.success);
    fx.rows(true, 0, 1, Some(1));
    assert_eq!(fx.only_rule(), (vec![(1, 1, 9, 1)], "=B2>Other!$A$2".to_string()));
    match &fx.validations(0)[0].validation.rule {
        DataValidationRule::List(l) => match &l.source {
            ListSource::Range { start_row, end_row, .. } => assert_eq!((*start_row, *end_row), (1, 3)),
            other => panic!("{:?}", other),
        },
        other => panic!("{:?}", other),
    }
    assert_eq!(fx.validations(0)[0].start_row, 1, "the validation's own range is on Sheet1 and stays");
    fx.undo();
    assert_eq!(fx.only_rule().1, "=B2>Other!$A$1");
}

/// C20-C22: a structured reference in a rule or a custom validation is
/// refused at entry with Excel's sentence, and the document stays clean;
/// ordinary references and a table's bare NAME (`=COUNT(T1)>0`, accepted by
/// Excel) are not refused.
/// SABOTAGE (cfdv-sref): `expression_names_structured_reference` answers
/// false for a `TableRef`.
#[test]
fn a_structured_reference_is_refused_in_a_rule_and_a_validation() {
    let fx = Fx::new();
    for formula in ["=T1[@A]>1", "=SUM(T1[A])>1", "=T1[[#This Row],[A]]>1", "=[@A]>1"] {
        let r = fx.add_rule(
            ConditionalFormatRule::Expression(ExpressionRule { formula: formula.to_string() }),
            vec![rect(0, 7, 2, 7)],
        );
        assert!(!r.success, "{} was accepted", formula);
        assert_eq!(r.error.as_deref(), Some(CF_STRUCTURED_REFERENCE_REFUSAL), "{}", formula);
    }
    let threshold = ConditionalFormatRule::CellValue(CellValueRule {
        operator: CellValueOperator::GreaterThan,
        value1: "=SUM(T1[A])".to_string(),
        value2: None,
    });
    assert!(!fx.add_rule(threshold, vec![rect(0, 7, 2, 7)]).success);
    let custom = |f: &str| DataValidationRule::Custom(CustomRule { formula: f.to_string() });
    let refused = fx.validate(0, 8, 0, 8, custom("=T1[@A]>1"));
    assert!(!refused.success);
    assert_eq!(refused.error.as_deref(), Some(crate::data_validation::DV_STRUCTURED_REFERENCE_REFUSAL));
    assert!(!fx.file.is_dirty(), "a refused rule dirtied the document");
    assert!(fx.rules(0).is_empty());
    assert!(fx.validations(0).is_empty());

    // An update that would put one in is refused the same way.
    for formula in ["=SUM($A$2:$A$3)>1", "=COUNT(T1)>0"] {
        let r = fx.add_rule(
            ConditionalFormatRule::Expression(ExpressionRule { formula: formula.to_string() }),
            vec![rect(0, 7, 2, 7)],
        );
        assert!(r.success, "{} was refused: {:?}", formula, r.error);
    }
    let id = fx.state.conditional_formats.read().unwrap()[&0][0].id;
    let updated = update_conditional_format_impl(
        &fx.state,
        &fx.file,
        UpdateCFParams {
            rule_id: id,
            rule: Some(ConditionalFormatRule::Expression(ExpressionRule { formula: "=T1[@A]>1".to_string() })),
            format: None,
            ranges: None,
            stop_if_true: None,
            enabled: None,
            target: None,
        },
    );
    assert_eq!(updated.error.as_deref(), Some(CF_STRUCTURED_REFERENCE_REFUSAL));
    assert!(fx.validate(0, 8, 0, 8, custom("=SUM($A$2:$A$3)>0")).success);
}

/// K: Copy Sheet carries the conditional formats, the validations, the note
/// and the threaded comment (Calcula's copy had none). A rule or validation
/// naming the source sheet reads the copy's own cells; one naming another
/// sheet keeps reading it; each copied rule has a fresh id.
/// SABOTAGE (cfdv-copy): `copy_rules_and_annotations_to_copied_sheet`
/// returns at once.
#[test]
fn copying_a_sheet_copies_its_rules_validations_comments_and_notes() {
    let fx = Fx::new();
    for formula in ["=A1>$B$1", "=A1>Other!$A$1", "=A1>Sheet1!$B$1"] {
        let r = fx.add_rule(
            ConditionalFormatRule::Expression(ExpressionRule { formula: formula.to_string() }),
            vec![rect(0, 0, 2, 0)],
        );
        assert!(r.success, "{:?}", r.error);
    }
    let list = |sheet_index: Option<usize>, col: u32| {
        DataValidationRule::List(ListRule {
            source: ListSource::Range { sheet_index, start_row: 0, start_col: col, end_row: 2, end_col: col },
            in_cell_dropdown: true,
        })
    };
    assert!(fx.validate(0, 2, 2, 2, list(Some(0), 3)).success);
    assert!(fx.validate(0, 4, 0, 4, list(None, 3)).success);
    assert!(fx.validate(0, 5, 0, 5, list(Some(1), 0)).success);
    assert!(fx
        .validate(4, 6, 4, 6, DataValidationRule::Custom(CustomRule { formula: "=G5>Sheet1!$A$1".to_string() }))
        .success);
    {
        let seed = crate::document_effect::test_seed_effect();
        fx.state.notes.write(&seed).unwrap().entry(0).or_default().insert(
            (0, 0),
            crate::notes::Note::new(0, 0, 0, "me".to_string(), "note on A1".to_string()),
        );
        fx.state.comments.write(&seed).unwrap().entry(0).or_default().insert(
            (1, 0),
            crate::comments::Comment::new(1, 0, 0, "me@x".to_string(), "me".to_string(), "thread on A2".to_string()),
        );
    }

    let copied = crate::sheets::copy_sheet_impl(&fx.state, &fx.file, &fx.slicer, &fx.timeline, &fx.filters, 0, None)
        .expect("copy");
    assert_eq!(copied.active_index, 1);
    let names = fx.state.sheet_names.read().unwrap().clone();
    assert_eq!(names[1], "Sheet1 (2)");

    let source_rules = fx.rules(0);
    let copy_rules = fx.rules(1);
    assert_eq!(copy_rules.len(), 3, "the copy has no conditional formats");
    let upper = |v: &Vec<String>| v.iter().map(|f| f.to_ascii_uppercase()).collect::<Vec<_>>();
    assert_eq!(copy_rules[0], (vec![(0, 0, 2, 0)], vec!["=A1>$B$1".to_string()]));
    assert_eq!(upper(&copy_rules[1].1), vec!["=A1>OTHER!$A$1".to_string()]);
    assert_eq!(upper(&copy_rules[2].1), vec!["=A1>'SHEET1 (2)'!$B$1".to_string()], "the copy's rule still reads the source");
    assert_eq!(upper(&source_rules[2].1), vec!["=A1>SHEET1!$B$1".to_string()], "the source's own rule changed");
    {
        let store = fx.state.conditional_formats.read().unwrap();
        let ids: HashSet<u64> = store.values().flatten().map(|r| r.id).collect();
        assert_eq!(ids.len(), 6, "a copied rule kept its source's id");
    }

    let copy_dv = fx.validations(1);
    assert_eq!(copy_dv.len(), 4, "the copy has no validations");
    let source_of = |v: &ValidationRange| match &v.validation.rule {
        DataValidationRule::List(l) => match &l.source {
            ListSource::Range { sheet_index, .. } => format!("{:?}", sheet_index),
            other => format!("{:?}", other),
        },
        DataValidationRule::Custom(c) => c.formula.to_ascii_uppercase(),
        other => format!("{:?}", other),
    };
    let by_col: HashMap<u32, String> = copy_dv.iter().map(|v| (v.start_col, source_of(v))).collect();
    assert_eq!(by_col[&2], "Some(1)", "a list on the source sheet must read the copy");
    assert_eq!(by_col[&4], "None");
    assert_eq!(by_col[&5], "Some(2)", "a list on Other keeps reading Other (now index 2)");
    assert_eq!(by_col[&6], "=G5>'SHEET1 (2)'!$A$1");
    let source_by_col: HashMap<u32, String> = fx.validations(0).iter().map(|v| (v.start_col, source_of(v))).collect();
    assert_eq!(source_by_col[&2], "Some(0)");
    assert_eq!(source_by_col[&5], "Some(2)");

    let notes = fx.state.notes.read().unwrap();
    let note = notes.get(&1).and_then(|m| m.get(&(0, 0))).expect("the copy has no note");
    assert_eq!((note.content.as_str(), note.sheet_index), ("note on A1", 1));
    assert_ne!(note.id, notes[&0][&(0, 0)].id);
    let comments = fx.state.comments.read().unwrap();
    let comment = comments.get(&1).and_then(|m| m.get(&(1, 0))).expect("the copy has no comment");
    assert_eq!((comment.content.as_str(), comment.sheet_index), ("thread on A2", 1));
    assert_ne!(comment.id, comments[&0][&(1, 0)].id);
}
