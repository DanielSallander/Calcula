//! FILENAME: app/src-tauri/src/sheet_rename_repair_tests.rs
//! PURPOSE: A sheet RENAME carries every formula that names the sheet, whatever
//!          node the reference sits in and whatever store holds the formula.
//!
//! Two defects, one door (`rename_sheet_inner`):
//!
//!   * `repair_3d_rename_recursive` (lib.rs) fell through to "leaf" for every
//!     node it did not name, so a reference WRAPPED in an implicit
//!     intersection (`@Data!A1:A3`), a spill (`Data!A1#`), an index access
//!     (`Data!A1[0]`) or an array constant (`{Data!A1,2}`) kept the old sheet
//!     name. The formula then answered `#REF!` (the evaluator's answer for an
//!     unknown sheet) or, worse, a SAME-NAMED sheet created later.
//!   * the rename never touched the `.calp` OVERRIDE LAYER. An override's
//!     baseline, its current formula and a conflict's upstream value are
//!     formula TEXT naming sheets. Since BUG-0151 a refresh rewrites upstream
//!     text to the subscriber's CURRENT tab name, so an override whose baseline
//!     still spelled the old name became a false conflict at the next refresh,
//!     and the override's own formula kept reading the old name.
//!   * (wave-B fix-up) the rename never touched the RULE stores either:
//!     conditional formats, custom validations and control formula
//!     properties. Pane-control dropdown sources go through the same walker
//!     (`rename_pane_control_references`), but the `rename_sheet` command does
//!     not yet receive `PaneControlState` to call it -- the one store this
//!     file pins ahead of its wiring.
//!
//! Included from `sheets.rs` (`#[path]`), so `super` is the sheets module.

use super::*;
use crate::document_effect::test_seed_effect;

/// A two-sheet workbook: Sheet1 (active) and "Data".
fn two_sheets() -> (AppState, FileState, PivotState) {
    let state = crate::create_app_state();
    let file = FileState::default();
    add_sheet_inner(&state, &file, Some("Data".to_string()), ::persistence::SheetKind::Worksheet)
        .expect("add Data");
    // add_sheet activates the new sheet; go back to Sheet1 so the formula cells
    // below live on the ACTIVE sheet (grid mirror and grids[0] alike).
    activate_sheet(&state, 0).expect("back to Sheet1");
    let file = FileState::default();
    (state, file, PivotState::new())
}

/// Put `formula` at (row, 0) on the ACTIVE sheet (Sheet1), mirror included.
fn put_formula(state: &AppState, row: u32, formula: &str) {
    let cell = engine::Cell::new_formula(formula.to_string());
    assert!(cell.ast.is_some(), "fixture: `{}` must parse", formula);
    state.grid.write(&test_seed_effect()).unwrap().set_cell(row, 0, cell.clone());
    state.grids.write(&test_seed_effect()).unwrap()[0].set_cell(row, 0, cell);
}

fn formula_at(state: &AppState, row: u32) -> String {
    state
        .grid
        .read()
        .unwrap()
        .get_cell(row, 0)
        .and_then(|c| c.formula_string_raw())
        .unwrap_or_default()
}

/// Does the parsed formula contain a node the predicate accepts? Keeps each
/// case honest: a fixture that stopped parsing into the node it names would
/// pass the rename check vacuously.
fn contains_node(expr: &engine::Expression, pred: &dyn Fn(&engine::Expression) -> bool) -> bool {
    use engine::Expression as E;
    if pred(expr) {
        return true;
    }
    match expr {
        E::Range { start, end, .. } => contains_node(start, pred) || contains_node(end, pred),
        E::Sheet3DRef { reference, .. } => contains_node(reference, pred),
        E::BinaryOp { left, right, .. } => contains_node(left, pred) || contains_node(right, pred),
        E::UnaryOp { operand, .. } | E::ImplicitIntersection { operand } => contains_node(operand, pred),
        E::FunctionCall { args, .. } => args.iter().any(|a| contains_node(a, pred)),
        E::IndexAccess { target, index } => contains_node(target, pred) || contains_node(index, pred),
        E::ArrayLiteral { rows } => rows.iter().flatten().any(|e| contains_node(e, pred)),
        E::ListLiteral { elements } => elements.iter().any(|e| contains_node(e, pred)),
        E::DictLiteral { entries } => entries.iter().any(|(k, v)| contains_node(k, pred) || contains_node(v, pred)),
        E::SpillRef { cell, .. } => contains_node(cell, pred),
        _ => false,
    }
}

/// The wrapped-reference shapes, each with the node it must exercise.
fn wrapped_cases() -> Vec<(&'static str, &'static str, Box<dyn Fn(&engine::Expression) -> bool>)> {
    use engine::Expression as E;
    vec![
        ("=@Data!A1:A3", "implicit intersection", Box::new(|e| matches!(e, E::ImplicitIntersection { .. }))),
        ("=SUM(Data!A1#)", "spill reference", Box::new(|e| matches!(e, E::SpillRef { .. }))),
        ("=Data!A1[0]", "index access", Box::new(|e| matches!(e, E::IndexAccess { .. }))),
        ("={1,Data!A1}", "array constant", Box::new(|e| matches!(e, E::ArrayLiteral { .. }))),
    ]
}

#[test]
fn a_rename_reaches_references_wrapped_in_every_node() {
    for (formula, node, is_node) in wrapped_cases() {
        let ast = engine::Cell::new_formula(formula.to_string())
            .ast
            .unwrap_or_else(|| panic!("fixture: `{}` must parse", formula));
        assert!(contains_node(&ast, &*is_node), "fixture: `{}` is not a {}", formula, node);

        let repaired = crate::repair_3d_refs_on_rename(formula, "Data", "Facts");
        assert!(
            repaired.to_uppercase().contains("FACTS!") && !repaired.to_uppercase().contains("DATA!"),
            "a reference inside a {} kept the old sheet name: `{}` -> `{}`",
            node,
            formula,
            repaired
        );
        let back = engine::Cell::new_formula(repaired.clone());
        assert!(back.ast.is_some(), "the repaired `{}` must re-parse", repaired);
    }
}

#[test]
fn renaming_a_sheet_carries_wrapped_references_on_every_sheet() {
    let (state, file, pivots) = two_sheets();
    let cases = wrapped_cases();
    for (row, (formula, _, _)) in cases.iter().enumerate() {
        put_formula(&state, row as u32, formula);
    }
    rename_sheet_inner(&state, &file, &pivots, 1, "Facts".to_string(), false).expect("rename Data");
    for (row, (formula, node, _)) in cases.iter().enumerate() {
        let now = formula_at(&state, row as u32).to_uppercase();
        assert!(
            now.contains("FACTS!") && !now.contains("DATA!"),
            "after renaming Data to Facts, the {} `{}` reads `{}`",
            node,
            formula,
            now
        );
    }
}

fn override_on(sheet_id: identity::SheetId, baseline: &str, current: &str, upstream: Option<&str>) -> calp::overrides::CellOverride {
    calp::overrides::CellOverride {
        sheet_id,
        cell_id: identity::CellId::from_bytes(identity::generate_uuid_v7()),
        position: (0, 0),
        baseline: calp::OverrideValue::Formula { formula: baseline.to_string() },
        current: calp::OverrideValue::Formula { formula: current.to_string() },
        created_at: String::new(),
        modified_at: String::new(),
        author: String::new(),
        conflict: upstream.is_some(),
        upstream_new: upstream.map(|f| calp::OverrideValue::Formula { formula: f.to_string() }),
        extra: Default::default(),
    }
}

fn formula_text(v: &calp::OverrideValue) -> String {
    match v {
        calp::OverrideValue::Formula { formula } => formula.clone(),
        other => panic!("expected a formula, got {:?}", other),
    }
}

#[test]
fn renaming_a_sheet_repairs_every_formula_in_the_override_layer() {
    let (state, file, pivots) = two_sheets();
    let sheet1 = state.sheet_ids.read().unwrap()[0];
    {
        let mut layer = state.override_layer.write(&test_seed_effect()).unwrap();
        layer.overrides.push(override_on(sheet1, "DATA!A1*2", "Data!A1*3", Some("Data!A1*4")));
        // A formula that names another sheet keeps its exact bytes.
        layer.overrides.push(override_on(sheet1, "Other!A1*2", "b1+1", None));
    }
    rename_sheet_inner(&state, &file, &pivots, 1, "Facts".to_string(), false).expect("rename Data");

    let layer = state.override_layer.read().unwrap();
    let renamed = &layer.overrides[0];
    for (what, text) in [
        ("baseline", formula_text(&renamed.baseline)),
        ("current", formula_text(&renamed.current)),
        ("upstream", formula_text(renamed.upstream_new.as_ref().expect("upstream kept"))),
    ] {
        let upper = text.to_uppercase();
        assert!(
            upper.contains("FACTS!A1") && !upper.contains("DATA!"),
            "the override's {} still names the renamed sheet: `{}`",
            what,
            text
        );
        // The layer's convention (no leading `=`, as `override_value_from_saved`
        // and `override_value_from_cell` record it) is kept.
        assert!(!text.starts_with('='), "the override's {} gained a leading `=`: `{}`", what, text);
    }
    let untouched = &layer.overrides[1];
    assert_eq!(formula_text(&untouched.baseline), "Other!A1*2", "an unrelated override formula was re-spelled");
    assert_eq!(formula_text(&untouched.current), "b1+1", "an unrelated override formula was re-spelled");
}

// ---------------------------------------------------------------------------
// The RULE stores (wave-B fix-up): conditional formats, data validations and
// the formula properties of cell-anchored controls name sheets too.
// ---------------------------------------------------------------------------
//
// Wave-B B4 made a collision rename on PULL rewrite these payloads, and a
// user's own rename then left exactly the same payloads alone: a CF rule
// `=A1>Data!$B$1` kept reading "Data" after Data became Facts -- the formula
// named a sheet that no longer existed, so the highlight silently vanished --
// and a custom validation or a button's text formula read a missing sheet the
// same way. Excel carries all of these through a rename. The local rename now
// goes through the SAME per-payload walkers the pull does
// (`calp::sheet_renames`), so the two can no longer disagree about which
// strings are formulas.

fn cf_def(id: u64, rule: crate::conditional_formatting::ConditionalFormatRule) -> crate::conditional_formatting::ConditionalFormatDefinition {
    crate::conditional_formatting::ConditionalFormatDefinition {
        id,
        priority: id as u32,
        rule,
        format: crate::conditional_formatting::ConditionalFormat::default(),
        ranges: vec![],
        stop_if_true: false,
        enabled: true,
    }
}

fn control_prop(value_type: &str, value: &str) -> crate::controls::ControlPropertyValue {
    crate::controls::ControlPropertyValue { value_type: value_type.to_string(), value: value.to_string() }
}

#[test]
fn renaming_a_sheet_repairs_conditional_formats_validations_and_control_formulas() {
    use crate::conditional_formatting as cf;
    use crate::data_validation as dv;
    let (state, file, pivots) = two_sheets();
    let seed = test_seed_effect();
    state.conditional_formats.write(&seed).unwrap().insert(
        0,
        vec![
            cf_def(1, cf::ConditionalFormatRule::Expression(cf::ExpressionRule { formula: "=A1>Data!$B$1".to_string() })),
            cf_def(
                2,
                cf::ConditionalFormatRule::DataBar(cf::DataBarRule {
                    min_formula: Some("Data!C1".to_string()),
                    max_formula: Some("=MAX(Other!C:C)".to_string()),
                    ..cf::DataBarRule::default()
                }),
            ),
        ],
    );
    state.data_validations.write(&seed).unwrap().insert(
        0,
        vec![dv::ValidationRange {
            start_row: 0,
            start_col: 0,
            end_row: 9,
            end_col: 0,
            validation: dv::DataValidation {
                rule: dv::DataValidationRule::Custom(dv::CustomRule { formula: "=COUNTIF(Data!A:A,A1)=1".to_string() }),
                ..dv::DataValidation::default()
            },
        }],
    );
    {
        let mut properties = HashMap::new();
        properties.insert("text".to_string(), control_prop("formula", "=Data!A1"));
        properties.insert("fill".to_string(), control_prop("static", "Data!A1"));
        state.controls.write(&seed).unwrap().insert(
            (0, 1, 1),
            crate::controls::ControlMetadata { control_type: "button".to_string(), properties },
        );
    }

    rename_sheet_inner(&state, &file, &pivots, 1, "Facts".to_string(), false).expect("rename Data");

    let cfs = state.conditional_formats.read().unwrap();
    match &cfs[&0][0].rule {
        cf::ConditionalFormatRule::Expression(r) => {
            assert_eq!(r.formula, "=A1>Facts!$B$1", "a CF expression kept the old sheet name")
        }
        other => panic!("{:?}", other),
    }
    match &cfs[&0][1].rule {
        cf::ConditionalFormatRule::DataBar(r) => {
            assert_eq!(r.min_formula.as_deref(), Some("Facts!C1"), "a data-bar bound kept the old sheet name");
            assert_eq!(r.max_formula.as_deref(), Some("=MAX(Other!C:C)"), "an unrelated bound was re-spelled");
        }
        other => panic!("{:?}", other),
    }
    let dvs = state.data_validations.read().unwrap();
    match &dvs[&0][0].validation.rule {
        dv::DataValidationRule::Custom(r) => {
            assert_eq!(r.formula, "=COUNTIF(Facts!A:A,A1)=1", "a custom validation kept the old sheet name")
        }
        other => panic!("{:?}", other),
    }
    let controls = state.controls.read().unwrap();
    let props = &controls[&(0, 1, 1)].properties;
    assert_eq!(props["text"].value, "=Facts!A1", "a control's formula property kept the old sheet name");
    assert_eq!(props["fill"].value, "Data!A1", "a STATIC control property is a literal");
}

/// The fourth rule store, pinned ahead of its wiring (see
/// `rename_pane_control_references`): a dropdown's cell-range source follows
/// the rename, a static list's items are data.
#[test]
fn a_pane_dropdowns_cell_range_source_follows_a_rename() {
    use crate::pane_control::{DropdownSource, PaneControl, PaneControlConfig, PaneControlState, PaneControlType};
    let pane = PaneControlState::new();
    let dropdown = |name: &str, source: DropdownSource| PaneControl {
        id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        name: name.to_string(),
        control_type: PaneControlType::Dropdown,
        config: PaneControlConfig::Dropdown { source, placeholder: None, chart_param_target: None },
        value: None,
        order: 0,
    };
    let ranged = dropdown("Region", DropdownSource::CellRange { reference: "Data!A1:A5".to_string() });
    let listed = dropdown("Fixed", DropdownSource::Static { items: vec!["Data!A1".to_string()] });
    let (ranged_id, listed_id) = (ranged.id, listed.id);
    {
        let mut controls = pane.controls.lock().unwrap();
        controls.insert(ranged_id, ranged);
        controls.insert(listed_id, listed);
    }
    let renames = calp::sheet_renames::SheetRenames::new([("Data", "My Facts")]);
    assert_eq!(rename_pane_control_references(&pane, &renames), 1);
    let controls = pane.controls.lock().unwrap();
    match &controls[&ranged_id].config {
        PaneControlConfig::Dropdown { source: DropdownSource::CellRange { reference }, .. } => {
            assert_eq!(reference, "'My Facts'!A1:A5", "a dropdown's range source kept the old sheet name")
        }
        other => panic!("{:?}", other),
    }
    match &controls[&listed_id].config {
        PaneControlConfig::Dropdown { source: DropdownSource::Static { items }, .. } => {
            assert_eq!(items, &vec!["Data!A1".to_string()], "a static item is data")
        }
        other => panic!("{:?}", other),
    }
}
