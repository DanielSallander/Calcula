//! FILENAME: app/src-tauri/src/cfdvb_tests.rs
//! PURPOSE: Lane `cfdvb` (ledger programme 2, wave 2) -- conditional-format
//! and data-validation backend residuals, driven through the real bodies:
//!   * BUG-0748: every CF evaluation path resolves defined names, tables and
//!     spill references (`A1#`) as a cell does -- the painter body, filter by
//!     icon, sort by icon (the floating-grid painter is in `cell_target_tests`);
//!   * BUG-0743: a structural edit that leaves a rule's cells meaning
//!     different things SPLITS the rule (and a validation), and a clear that
//!     moves the anchor past an edge WRAPS instead of writing `#REF!`;
//!   * BUG-0745: a relative list source is read per cell;
//!   * BUG-0746: a pending entry is judged, not the value it replaces;
//!   * BUG-0747: set / clear over part of a validation cuts it;
//!   * BUG-0750: a list source on a deleted sheet keeps its rectangle as
//!     `#REF!` and refuses every entry.
//! A child module of `conditional_formatting` (declared with `#[path]` there).
//!
//! Every Excel fact is [LIVE, Excel 16, 2026-11-06, cfdvb/probe1.ps1 and
//! probe2.ps1]; the case ids (A1.., B1.., C1.., E1.., F1, I1.., V1) are the
//! probes'.

use crate::conditional_formatting::*;
use crate::data_validation::{
    CustomRule, DataValidation, DataValidationRule, ListRelative, ListRule, ListSource, NumericRule,
    DataValidationOperator, ValidationRange,
};
use crate::persistence::FileState;
use crate::pivot::types::PivotState;
use std::collections::{HashMap, HashSet};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

/// `A1`-style address -> 0-based (row, col).
fn at(a1: &str) -> (u32, u32) {
    let letters: String = a1.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
    let digits: String = a1.chars().skip_while(|c| c.is_ascii_alphabetic()).collect();
    (digits.parse::<u32>().unwrap() - 1, engine::col_to_index(&letters))
}

/// `B2:B10` -> 0-based rectangle (a single cell is allowed).
fn rect(a1: &str) -> ConditionalFormatRange {
    let mut parts = a1.split(':');
    let a = at(parts.next().unwrap());
    let b = parts.next().map(at).unwrap_or(a);
    ConditionalFormatRange { start_row: a.0, start_col: a.1, end_row: b.0, end_col: b.1 }
}

fn addr(r: &ConditionalFormatRange) -> String {
    let a = format!("{}{}", engine::index_to_col(r.start_col), r.start_row + 1);
    let b = format!("{}{}", engine::index_to_col(r.end_col), r.end_row + 1);
    if a == b {
        a
    } else {
        format!("{}:{}", a, b)
    }
}

impl Fx {
    /// Sheet1 (active) only.
    fn new() -> Self {
        Fx {
            state: crate::create_app_state(),
            file: FileState::default(),
            files: crate::persistence::UserFilesState::default(),
            pivots: PivotState::new(),
            pane: crate::pane_control::PaneControlState::new(),
            filters: crate::ribbon_filter::RibbonFilterState::new(),
            slicer: crate::slicer::SlicerState::new(),
            timeline: crate::timeline_slicer::TimelineSlicerState::new(),
        }
    }

    /// Sheet1 (active) plus `extra` sheets.
    fn with_sheets(extra: &[&str]) -> Self {
        let fx = Fx::new();
        for name in extra {
            crate::sheets::add_sheet_inner(&fx.state, &fx.file, Some(name.to_string()), ::persistence::SheetKind::Worksheet)
                .expect("add a sheet");
        }
        crate::sheets::activate_sheet(&fx.state, 0).expect("back to Sheet1");
        fx
    }

    fn index_of(&self, name: &str) -> usize {
        self.state.sheet_names.read().unwrap().iter().position(|n| n == name).expect("sheet")
    }

    /// Put a cell on `sheet`: into `grids`, and into the active-sheet mirror
    /// `grid` too when it is the active sheet (a structural edit works on it).
    fn put(&self, sheet: usize, a1: &str, cell: engine::Cell) {
        let (r, c) = at(a1);
        let seed = crate::document_effect::test_seed_effect();
        if *self.state.active_sheet.read().unwrap() == sheet {
            self.state.grid.write(&seed).unwrap().set_cell(r, c, cell.clone());
        }
        self.state.grids.write(&seed).unwrap()[sheet].set_cell(r, c, cell);
    }

    fn num(&self, sheet: usize, a1: &str, v: f64) {
        self.put(sheet, a1, engine::Cell::new_number(v));
    }

    fn text(&self, sheet: usize, a1: &str, v: &str) {
        self.put(sheet, a1, engine::Cell::new_text(v.to_string()));
    }

    fn name(&self, name: &str, refers_to: &str) {
        self.state.named_ranges.write(&crate::document_effect::test_seed_effect()).unwrap().insert(
            crate::name_resolution::name_key(name),
            crate::named_ranges::NamedRange {
                name: name.to_string(),
                sheet_index: None,
                refers_to: refers_to.to_string(),
                comment: None,
                folder: None,
            },
        );
    }

    fn expression(&self, formula: &str, ranges: &[&str]) {
        let r = add_conditional_format_impl(
            &self.state,
            &self.file,
            AddCFParams {
                rule: ConditionalFormatRule::Expression(ExpressionRule { formula: formula.to_string() }),
                format: ConditionalFormat::default(),
                ranges: ranges.iter().map(|a| rect(a)).collect(),
                stop_if_true: false,
                target: None,
            },
        );
        assert!(r.success, "{:?}", r.error);
    }

    /// Sheet1's rules as a set of ("B2:B4,B6:B9", formula).
    fn rules(&self) -> HashSet<(String, String)> {
        let store = self.state.conditional_formats.read().unwrap();
        store
            .get(&0)
            .map(|rules| {
                rules
                    .iter()
                    .map(|r| {
                        let mut rule = r.rule.clone();
                        let mut ranges: Vec<&ConditionalFormatRange> = r.ranges.iter().collect();
                        ranges.sort_by_key(|g| (g.start_row, g.start_col));
                        (
                            ranges.iter().map(|g| addr(g)).collect::<Vec<_>>().join(","),
                            rule_formulas_mut(&mut rule)[0].clone(),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn rule_ids_unique(&self) -> bool {
        let store = self.state.conditional_formats.read().unwrap();
        let rules = store.get(&0).cloned().unwrap_or_default();
        let ids: HashSet<u64> = rules.iter().map(|r| r.id).collect();
        ids.len() == rules.len()
    }

    fn validate(&self, range: &str, rule: DataValidationRule) {
        let g = rect(range);
        let r = crate::data_validation::set_data_validation_impl(
            &self.state,
            &self.file,
            g.start_row,
            g.start_col,
            g.end_row,
            g.end_col,
            DataValidation { rule, ..DataValidation::default() },
            None,
        );
        assert!(r.success, "{:?}", r.error);
    }

    fn clear_validation(&self, range: &str) {
        let g = rect(range);
        let r = crate::data_validation::clear_data_validation_impl(
            &self.state, &self.file, g.start_row, g.start_col, g.end_row, g.end_col, None,
        );
        assert!(r.success, "{:?}", r.error);
    }

    fn validations(&self) -> Vec<ValidationRange> {
        self.state.data_validations.read().unwrap().get(&0).cloned().unwrap_or_default()
    }

    /// The validation at a cell: (its range, a short description of its rule).
    fn validation_at(&self, a1: &str) -> Option<(String, String)> {
        let (r, c) = at(a1);
        self.validations().into_iter().find(|v| r >= v.start_row && r <= v.end_row && c >= v.start_col && c <= v.end_col).map(
            |v| {
                let range = addr(&ConditionalFormatRange {
                    start_row: v.start_row,
                    start_col: v.start_col,
                    end_row: v.end_row,
                    end_col: v.end_col,
                });
                let what = match &v.validation.rule {
                    DataValidationRule::Custom(c) => c.formula.clone(),
                    DataValidationRule::WholeNumber(_) => "whole".to_string(),
                    DataValidationRule::List(_) => "list".to_string(),
                    other => format!("{:?}", other),
                };
                (range, what)
            },
        )
    }

    fn pending(&self, a1: &str, value: &str) -> bool {
        let (r, c) = at(a1);
        crate::data_validation::validate_pending_value_on(&self.state, r, c, value.to_string()).is_valid
    }

    fn rows(&self, insert: bool, at: u32, count: u32) {
        let r = if insert {
            crate::commands::structure::insert_rows_impl(
                &self.state, &self.file, &self.pivots, &self.files, &self.pane, &self.filters, &self.slicer,
                &self.timeline, at, count, None,
            )
        } else {
            crate::commands::structure::delete_rows_impl(
                &self.state, &self.file, &self.pivots, &self.files, &self.pane, &self.filters, &self.slicer,
                &self.timeline, at, count, None,
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

    fn cells(&self, range: &str, shift: crate::commands::structure::structure_cells::CellShift) {
        let g = rect(range);
        crate::commands::structure::structure_cells::shift_cells_impl(
            &self.state, &self.file, &self.pivots, &self.files, &self.pane, &self.filters, &self.slicer,
            &self.timeline, g.start_row, g.start_col, g.end_row, g.end_col, shift, false,
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

fn set(items: &[(&str, &str)]) -> HashSet<(String, String)> {
    items.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
}

fn list_range(a1: &str, relative: ListRelative, sheet_index: Option<usize>) -> DataValidationRule {
    let g = rect(a1);
    DataValidationRule::List(ListRule {
        source: ListSource::Range {
            sheet_index,
            start_row: g.start_row,
            start_col: g.start_col,
            end_row: g.end_row,
            end_col: g.end_col,
            relative,
            sheet_gone: false,
        },
        in_cell_dropdown: true,
    })
}

const ALL_RELATIVE: ListRelative = ListRelative { start_row: true, start_col: true, end_row: true, end_col: true };

// ---------------------------------------------------------------------------
// BUG-0748: names, tables and spill references on every evaluation path
// ---------------------------------------------------------------------------

/// The painter's body: `=SUM($D$1#)>2` reads the whole spilled array D1:D3.
/// Unresolved, the spill reference is an error and nothing is formatted.
/// SABOTAGE (cfdvb-res): `RuleFormulas::resolved` drops its tables.
#[test]
fn the_painter_resolves_a_spill_reference_in_a_rule() {
    let mut g = engine::Grid::new();
    for r in 0..3u32 {
        g.set_cell(r, 3, engine::Cell::new_number(1.0));
    }
    g.set_cell(0, 0, engine::Cell::new_number(0.0));
    let grids = vec![g];
    let names = vec!["Sheet1".to_string()];
    let mut map: crate::SpillRangeMap = HashMap::new();
    map.insert((0, 0, 3), vec![(1, 3), (2, 3)]);
    let spill = crate::document_effect::Persisted::new(map);
    let rule_names = RuleNames::from_parts(HashMap::new(), &spill);
    let rules = vec![ConditionalFormatDefinition {
        id: 1,
        priority: 1,
        rule: ConditionalFormatRule::Expression(ExpressionRule { formula: "=SUM($D$1#)>2".to_string() }),
        format: ConditionalFormat { background_color: Some("#FF0000".to_string()), ..Default::default() },
        ranges: vec![rect("A1")],
        stop_if_true: false,
        enabled: true,
    }];
    let out = evaluate_conditional_formats_resolved(&grids[0], &grids, &names, 0, rule_names.tables(&names), &rules, 0, 0, 0, 0);
    assert_eq!(out.len(), 1, "SUM(D1#) = 3 > 2 formats A1: {:?}", out);
}

fn lim_icon_rules() -> Vec<ConditionalFormatDefinition> {
    vec![ConditionalFormatDefinition {
        id: 1,
        priority: 1,
        rule: ConditionalFormatRule::IconSet(IconSetRule {
            icon_set: IconSetType::ThreeArrows,
            thresholds: vec![IconSetThreshold {
                value_type: CFValueType::Formula,
                // The fallback a failed formula answers: above every value.
                value: 1000.0,
                operator: ThresholdOperator::GreaterThanOrEqual,
                formula: Some("=Lim".to_string()),
            }],
            reverse_icons: false,
            show_icon_only: false,
        }),
        format: ConditionalFormat::default(),
        ranges: vec![rect("A2:A5")],
        stop_if_true: false,
        enabled: true,
    }]
}

/// Filter by icon: an icon set whose threshold is the defined name `Lim` (5).
/// A2:A5 = 1, 10, 2, 20: rows 3 and 5 show the upper icon. Without names the
/// threshold fell back and every row showed the lowest icon, so filtering by
/// the icon on screen hid every row.
/// SABOTAGE (cfdvb-fil): `resolve_filter_icons` passes no names.
#[test]
fn filter_by_icon_resolves_a_defined_name_in_a_threshold() {
    let fx = Fx::new();
    for (a, v) in [("A2", 1.0), ("A3", 10.0), ("A4", 2.0), ("A5", 20.0)] {
        fx.num(0, a, v);
    }
    fx.name("Lim", "=5");
    let rules = lim_icon_rules();
    let mut af = crate::autofilter::AutoFilter::new(0, 0, 4, 0);
    af.column_filters.insert(
        0,
        crate::autofilter::ColumnFilter {
            column_index: 0,
            criteria: crate::autofilter::FilterCriteria {
                filter_on: crate::autofilter::FilterOn::Icon,
                ..Default::default()
            },
        },
    );
    let grids = fx.state.grids.read().unwrap().clone();
    let names = fx.state.sheet_names.read().unwrap().clone();
    let icons = crate::autofilter::resolve_filter_icons(&fx.state, &grids[0], &grids, &names, 0, &rules, &af);
    let col = &icons[&0];
    let upper: Vec<u32> = (1..=4u32).filter(|r| col.get(r).copied().flatten().map(|i| i.icon_index) == Some(1)).collect();
    assert_eq!(upper, vec![2, 4], "rows 3 and 5 (>= Lim) show the upper icon: {:?}", col);
}

/// Sort by icon, the same rule: sorting A2:A5 by the upper icon on top puts
/// 10 and 20 first. Without names no row showed it and the sort was refused
/// or moved nothing.
/// SABOTAGE (cfdvb-srt): `build_icon_match_sets` passes no names.
#[test]
fn sort_by_icon_resolves_a_defined_name_in_a_threshold() {
    let fx = Fx::new();
    for (a, v) in [("A2", 1.0), ("A3", 10.0), ("A4", 2.0), ("A5", 20.0)] {
        fx.num(0, a, v);
    }
    fx.name("Lim", "=5");
    fx.state.conditional_formats.write(&crate::document_effect::test_seed_effect()).unwrap().insert(0, lim_icon_rules());
    let params = crate::api_types::SortRangeParams {
        start_row: 1,
        start_col: 0,
        end_row: 4,
        end_col: 0,
        fields: vec![crate::api_types::SortField {
            key: 0,
            ascending: true,
            sort_on: crate::api_types::SortOn::Icon,
            color: None,
            icon: Some(IconRef { icon_set: IconSetType::ThreeArrows, icon_index: 1 }),
            data_option: Default::default(),
            sub_field: None,
            custom_order: None,
        }],
        match_case: false,
        has_headers: false,
        orientation: Default::default(),
        sheet_index: None,
        target: None,
    };
    crate::commands::data::sort_range_off_sheet(&fx.state, &fx.file, &fx.files, &fx.pivots, &fx.pane, &fx.filters, 0, params)
        .expect("sort by icon");
    let grids = fx.state.grids.read().unwrap();
    let top: Vec<f64> = (1..=2u32)
        .map(|r| match grids[0].get_cell(r, 0).map(|c| c.value.clone()) {
            Some(engine::CellValue::Number(n)) => n,
            other => panic!("{:?}", other),
        })
        .collect();
    let mut top_sorted = top.clone();
    top_sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    assert_eq!(top_sorted, vec![10.0, 20.0], "the rows showing the upper icon come first: {:?}", top);
}

// ---------------------------------------------------------------------------
// BUG-0743: split on a partial structural delete or insert; wrap on clear
// ---------------------------------------------------------------------------

/// A1, A2, A4, I1, I3, I7 and the one-undo contract.
/// SABOTAGE (cfdvb-spl): `split_rule_by_meaning` always answers `None`.
#[test]
fn a_rule_splits_where_an_edit_leaves_its_cells_meaning_different_things() {
    use crate::commands::structure::structure_cells::CellShift;

    // A1: =B12>0 on B2:B10, delete row 12.
    let fx = Fx::new();
    fx.expression("=B12>0", &["B2:B10"]);
    fx.rows(false, 11, 1);
    assert_eq!(fx.rules(), set(&[("B2", "=#REF!>0"), ("B3:B10", "=B12>0")]));
    assert!(fx.rule_ids_unique());
    fx.undo();
    assert_eq!(fx.rules(), set(&[("B2:B10", "=B12>0")]), "one undo puts the one rule back");

    // A2: =B1>0 on B2:B10, delete row 5 -> one rule over two areas + B5.
    let fx = Fx::new();
    fx.expression("=B1>0", &["B2:B10"]);
    fx.rows(false, 4, 1);
    assert_eq!(fx.rules(), set(&[("B2:B4,B6:B9", "=B1>0"), ("B5", "=#REF!>0")]));

    // A4: =G2>0 on B2:F2, delete column H -> three rules.
    let fx = Fx::new();
    fx.expression("=G2>0", &["B2:F2"]);
    fx.cols(false, 7, 1);
    assert_eq!(fx.rules(), set(&[("B2", "=G2>0"), ("C2", "=#REF!>0"), ("D2:F2", "=H2>0")]));

    // I1: =B1>0 on B2:B10, insert row 5 -> the inserted row continues row 4.
    let fx = Fx::new();
    fx.expression("=B1>0", &["B2:B10"]);
    fx.rows(true, 4, 1);
    assert_eq!(fx.rules(), set(&[("B2:B5,B7:B11", "=B1>0"), ("B6", "=B4>0")]));

    // I3: =B12>0 on B2:B10, insert row 5.
    let fx = Fx::new();
    fx.expression("=B12>0", &["B2:B10"]);
    fx.rows(true, 4, 1);
    assert_eq!(fx.rules(), set(&[("B2:B5", "=B13>0"), ("B6:B11", "=B16>0")]));

    // I7: =C1>0 on B2:C10, Insert Cells C5 down.
    let fx = Fx::new();
    fx.expression("=C1>0", &["B2:C10"]);
    fx.cells("C5", CellShift::Down);
    assert_eq!(fx.rules(), set(&[("B2:C5", "=C1>0"), ("C6:C11", "=D4>0"), ("B6:B10", "=C6>0")]));

    // A rule every cell of which keeps its meaning is NOT split (C1-style).
    let fx = Fx::new();
    fx.expression("=B2>$D$1", &["B2:B10"]);
    fx.rows(false, 4, 1);
    assert_eq!(fx.rules(), set(&[("B2:B9", "=B2>$D$1")]));
}

/// V1: a custom validation splits the same way.
/// SABOTAGE (cfdvb-spl) as above.
#[test]
fn a_custom_validation_splits_where_an_edit_leaves_its_cells_meaning_different_things() {
    let fx = Fx::new();
    fx.validate("B2:B10", DataValidationRule::Custom(CustomRule { formula: "=B12>0".to_string() }));
    fx.rows(false, 11, 1);
    assert_eq!(fx.validation_at("B2"), Some(("B2".to_string(), "=#REF!>0".to_string())));
    assert_eq!(fx.validation_at("B3"), Some(("B3:B10".to_string(), "=B12>0".to_string())));
}

/// B1, B2, B4: a clear or a range edit that moves the anchor so a relative
/// reference would cross the sheet's edge WRAPS it.
/// SABOTAGE (cfdvb-wrp): `move_rule_formula_wrapping` returns the fill
/// shifter's `#REF!` text.
#[test]
fn a_clear_that_moves_the_anchor_past_an_edge_wraps() {
    let fx = Fx::new();
    fx.expression("=A1048576>0", &["A1:A10"]);
    clear_conditional_formats_in_range_impl(&fx.state, &fx.file, 0, 0, 0, 0, None).expect("clear A1");
    assert_eq!(fx.rules(), set(&[("A2:A10", "=A1>0")]));

    let fx = Fx::new();
    fx.expression("=XFD1>0", &["A1:C1"]);
    clear_conditional_formats_in_range_impl(&fx.state, &fx.file, 0, 0, 0, 0, None).expect("clear A1");
    assert_eq!(fx.rules(), set(&[("B1:C1", "=A1>0")]));

    // A validation cut the same way (BUG-0747's restate).
    let fx = Fx::new();
    fx.validate("A1:A10", DataValidationRule::Custom(CustomRule { formula: "=A1048576>0".to_string() }));
    fx.clear_validation("A1");
    assert_eq!(fx.validation_at("A2"), Some(("A2:A10".to_string(), "=A1>0".to_string())));
}

// ---------------------------------------------------------------------------
// BUG-0747: set / clear over part of a validation cuts it
// ---------------------------------------------------------------------------

/// E1-E5, undo, and a clear that touches nothing.
/// SABOTAGE (cfdvb-cut): `cut_validations` keeps every range whole.
#[test]
fn setting_or_clearing_part_of_a_validation_cuts_the_old_rule() {
    let fx = Fx::new();
    let whole = DataValidationRule::WholeNumber(NumericRule {
        formula1: 1.0,
        formula2: Some(10.0),
        operator: DataValidationOperator::Between,
    });
    fx.validate("A1:A10", whole.clone());
    fx.validate("A3:A4", list_range("K1:K2", ListRelative::default(), Some(0)));
    assert_eq!(fx.validation_at("A1").map(|v| v.1), Some("whole".to_string()));
    assert_eq!(fx.validation_at("A3").map(|v| v.1), Some("list".to_string()));
    assert_eq!(fx.validation_at("A5").map(|v| v.1), Some("whole".to_string()));
    assert_eq!(fx.validations().len(), 3, "A1:A2, A5:A10 and the list: {:?}", fx.validations());

    // E3/E4: clearing keeps each other cell testing its own cell.
    fx.validate("C1:C10", DataValidationRule::Custom(CustomRule { formula: "=C1>0".to_string() }));
    fx.clear_validation("C1:C2");
    assert_eq!(fx.validation_at("C2"), None);
    assert_eq!(fx.validation_at("C3"), Some(("C3:C10".to_string(), "=C3>0".to_string())));
    fx.clear_validation("C5:C6");
    assert_eq!(fx.validation_at("C4"), Some(("C3:C4".to_string(), "=C3>0".to_string())));
    assert_eq!(fx.validation_at("C7"), Some(("C7:C10".to_string(), "=C7>0".to_string())));

    // E5: a hole in the middle.
    fx.validate("D1:F3", DataValidationRule::Custom(CustomRule { formula: "=D1>0".to_string() }));
    fx.clear_validation("E2");
    assert_eq!(fx.validation_at("E2"), None);
    // Whatever piece holds F3, it tests F3 itself.
    let (piece, formula) = fx.validation_at("F3").unwrap();
    let anchor = at(piece.split(':').next().unwrap());
    let expected = format!("={}{}>0", engine::index_to_col(anchor.1), anchor.0 + 1);
    assert_eq!(formula, expected, "the piece {} states the formula for its own top-left", piece);

    // Undo the last clear: D1:F3 whole again.
    fx.undo();
    assert_eq!(fx.validation_at("E2"), Some(("D1:F3".to_string(), "=D1>0".to_string())));

    // A clear over no validation leaves the document clean.
    let clean = Fx::new();
    clean.clear_validation("Z1:Z5");
    assert!(!clean.file.is_dirty(), "a clear that clears nothing must not dirty the document");
}

// ---------------------------------------------------------------------------
// BUG-0746: the pending entry is what is judged
// ---------------------------------------------------------------------------

/// `=A1>5` on A1 with A1 = 10: typing 3 is refused, typing 7 over 1 allowed;
/// `=SUM($B$1:$B$3)<=10` counts the entry; a name naming the cell reads it;
/// and the typed text is read in the app locale (`1,5` is 1.5 in sv-SE).
/// SABOTAGE (cfdvb-pnd): the custom formula reads the committed grid.
#[test]
fn a_pending_entry_is_judged_not_the_value_it_replaces() {
    let fx = Fx::new();
    fx.num(0, "A1", 10.0);
    fx.validate("A1", DataValidationRule::Custom(CustomRule { formula: "=A1>5".to_string() }));
    assert!(!fx.pending("A1", "3"), "3 > 5 is false: the old 10 must not decide");
    fx.num(0, "A1", 1.0);
    assert!(fx.pending("A1", "7"), "7 > 5: the old 1 must not decide");

    fx.num(0, "B1", 5.0);
    fx.num(0, "B2", 4.0);
    fx.validate("B1:B3", DataValidationRule::Custom(CustomRule { formula: "=SUM($B$1:$B$3)<=10".to_string() }));
    assert!(!fx.pending("B3", "2"), "5 + 4 + 2 = 11 > 10");
    assert!(fx.pending("B3", "1"), "5 + 4 + 1 = 10");

    // E1/E2: a cell that DEPENDS on the entry is re-calculated before the
    // rule is judged. G2 = H2*2, `=G2>10` on H2.
    fx.put(0, "G2", engine::Cell::new_formula("H2*2".to_string()));
    fx.state.dependents.lock().unwrap().entry(at("H2")).or_default().insert(at("G2"));
    fx.validate("H2", DataValidationRule::Custom(CustomRule { formula: "=G2>10".to_string() }));
    assert!(fx.pending("H2", "8"), "G2 would be 16: the stale G2 (0) must not decide");
    assert!(!fx.pending("H2", "3"), "G2 would be 6");

    fx.name("Me", "=Sheet1!$C$1");
    fx.validate("C1", DataValidationRule::Custom(CustomRule { formula: "=Me>5".to_string() }));
    assert!(fx.pending("C1", "9"), "the name reads the entry, not the empty cell");

    *fx.state.locale.lock().unwrap() = engine::LocaleSettings::from_locale_id("sv-SE");
    fx.validate(
        "D1",
        DataValidationRule::Decimal(NumericRule { formula1: 1.0, formula2: Some(2.0), operator: DataValidationOperator::Between }),
    );
    assert!(fx.pending("D1", "1,5"), "1,5 is 1.5 in the Swedish app locale");
}

// ---------------------------------------------------------------------------
// BUG-0745: a relative list source is read per cell
// ---------------------------------------------------------------------------

/// C1-C3, C5: `=F1:F2` on H2:H4 lists b, c at H3; `=$F1:F$2` at J4 is F2:F3;
/// `=Other!A1:A2` moves too; an inserted row keeps each cell's list.
/// SABOTAGE (cfdvb-rel): `list_rect_at` ignores the relative flags.
#[test]
fn a_relative_list_source_is_read_at_each_cell() {
    let fx = Fx::with_sheets(&["Other"]);
    for (i, v) in ["a", "b", "c", "d", "e", "f"].iter().enumerate() {
        fx.text(0, &format!("F{}", i + 1), v);
    }
    let other = fx.index_of("Other");
    for (i, v) in ["o1", "o2", "o3"].iter().enumerate() {
        fx.text(other, &format!("A{}", i + 1), v);
    }
    fx.validate("H2:H4", list_range("F1:F2", ALL_RELATIVE, Some(0)));
    assert!(!fx.pending("H3", "a"), "H3 lists F2:F3");
    assert!(fx.pending("H3", "c"));
    assert!(fx.pending("H4", "d"), "H4 lists F3:F4");

    let mixed = ListRelative { start_row: true, start_col: false, end_row: false, end_col: true };
    fx.validate("J2:J4", list_range("F1:F2", mixed, Some(0)));
    assert!(fx.pending("J4", "b") && fx.pending("J4", "c"), "J4 lists $F3:F$2 = F2:F3");
    assert!(!fx.pending("J4", "a"));

    fx.validate("L1:L2", list_range("A1:A2", ALL_RELATIVE, Some(other)));
    assert!(fx.pending("L2", "o3") && !fx.pending("L2", "o1"), "L2 lists Other!A2:A3");

    // The invalid-data scan reads per cell too.
    fx.text(0, "H3", "a");
    fx.text(0, "H4", "c");
    let invalid = crate::data_validation::get_invalid_cells_on(&fx.state).cells;
    assert!(invalid.contains(&at("H3")), "a is not in F2:F3: {:?}", invalid);
    assert!(!invalid.contains(&at("H4")), "c is in F3:F4: {:?}", invalid);

    // C5: insert row 1 -> H3:H5, and H4 (old H3) still lists b, c.
    fx.rows(true, 0, 1);
    assert!(fx.pending("H4", "c") && !fx.pending("H4", "a"), "{:?}", fx.validations());
}

// ---------------------------------------------------------------------------
// BUG-0750 (DV): a list source on a deleted sheet
// ---------------------------------------------------------------------------

/// F0/F1: the rule stays a list over its rectangle, marked gone, and refuses
/// every entry -- including the value it allowed before.
/// SABOTAGE (cfdvb-gone): the remap writes an empty literal list again.
#[test]
fn a_list_source_on_a_deleted_sheet_keeps_its_rectangle_as_ref_error() {
    let fx = Fx::with_sheets(&["Src"]);
    let src = fx.index_of("Src");
    for (i, v) in ["p", "q", "r"].iter().enumerate() {
        fx.text(src, &format!("A{}", i + 1), v);
    }
    fx.validate("H1:H3", list_range("A1:A3", ListRelative::default(), Some(src)));
    assert!(fx.pending("H2", "p"));
    crate::sheets::delete_sheet_impl(
        &fx.state, &fx.file, &fx.pivots, &fx.files, &fx.pane, &fx.filters, &fx.slicer, &fx.timeline, src, false, None,
    )
    .expect("delete Src");
    let v = fx.validations();
    match &v[0].validation.rule {
        DataValidationRule::List(list) => match &list.source {
            ListSource::Range { sheet_gone, start_row, end_row, .. } => {
                assert!(*sheet_gone, "{:?}", list.source);
                assert_eq!((*start_row, *end_row), (0, 2), "the rectangle Excel shows as =#REF!$A$1:$A$3");
            }
            other => panic!("the source lost its rectangle: {:?}", other),
        },
        other => panic!("{:?}", other),
    }
    assert!(!fx.pending("H2", "p"), "every entry is refused, the old value included");
    assert!(!fx.pending("H2", "zzz"));
}

// Lane cfdvfix's tests reuse this fixture.
#[path = "cfdvfix_tests.rs"]
mod cfdvfix_tests;
