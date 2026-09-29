//! FILENAME: app/src-tauri/src/sheet_structure_repair_tests.rs
//! PURPOSE: A sheet RENAME, DELETE or MOVE carries every reference that names
//!          the sheet, in every store that holds one (wave C, W7/W9/W10/W11).
//!
//!   * W7  -- a rename carries PANE-CONTROL dropdown sources (the fourth rule
//!            store, whose helper wave B wrote but nothing called).
//!   * W9  -- a delete or move remaps a chart's INDEX-ONLY data ranges
//!            (`sheetIndex`, no `sheetId`) with the sheets; a range whose sheet
//!            is deleted can no longer resolve to any sheet.
//!   * W10 -- a delete turns conditional-format, validation, control-formula
//!            and pane-dropdown references to the deleted sheet into `#REF!`,
//!            as it already did for cell formulas and defined names.
//!   * W11 -- a delete repairs the `.calp` override layer's formulas the same
//!            way (the rename twin landed in wave B, B1).
//!   * found with W10: a LIST validation names its source range by sheet INDEX
//!            (`ListSource::Range.sheet_index`), and no sheet operation ever
//!            remapped it -- after a delete or move the dropdown listed another
//!            sheet's cells.
//!
//! Included from `sheets.rs` (`#[path]`), so `super` is the sheets module.

use super::*;
use crate::document_effect::test_seed_effect;

/// A workbook with the given sheets, Sheet1 first and active.
fn book(extra: &[&str]) -> (AppState, FileState) {
    let state = crate::create_app_state();
    let file = FileState::default();
    for name in extra {
        add_sheet_inner(&state, &file, Some(name.to_string()), ::persistence::SheetKind::Worksheet)
            .expect("add a sheet");
    }
    activate_sheet(&state, 0).expect("back to Sheet1");
    (state, FileState::default())
}

fn delete(state: &AppState, file: &FileState, pane: &crate::pane_control::PaneControlState, index: usize) {
    delete_sheet_impl(
        state,
        file,
        &PivotState::new(),
        &crate::persistence::UserFilesState::default(),
        pane,
        &crate::ribbon_filter::RibbonFilterState::new(),
        &crate::slicer::SlicerState::new(),
        &crate::timeline_slicer::TimelineSlicerState::new(),
        index,
        false,
    )
    .expect("delete the sheet");
}

fn move_to(state: &AppState, file: &FileState, from: usize, to: usize) {
    move_sheet_impl(
        state,
        file,
        &crate::slicer::SlicerState::new(),
        &crate::timeline_slicer::TimelineSlicerState::new(),
        &crate::ribbon_filter::RibbonFilterState::new(),
        from,
        to,
    )
    .expect("move the sheet");
}

fn index_of(state: &AppState, name: &str) -> usize {
    state.sheet_names.read().unwrap().iter().position(|n| n == name).expect("the sheet")
}

// ---------------------------------------------------------------------------
// W10: the RULE stores after a delete
// ---------------------------------------------------------------------------

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

fn names_ref_not(text: &str, sheet: &str) -> bool {
    let upper = text.to_uppercase();
    upper.contains("#REF!") && !upper.contains(&format!("{}!", sheet.to_uppercase()))
}

#[test]
fn deleting_a_sheet_turns_rule_formulas_naming_it_into_ref() {
    use crate::conditional_formatting as cf;
    use crate::data_validation as dv;
    let (state, file) = book(&["Data", "Other"]);
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

    delete(&state, &file, &crate::pane_control::PaneControlState::new(), 1);

    let cfs = state.conditional_formats.read().unwrap();
    match &cfs[&0][0].rule {
        cf::ConditionalFormatRule::Expression(r) => {
            assert!(names_ref_not(&r.formula, "Data"), "a CF expression still names the deleted sheet: `{}`", r.formula)
        }
        other => panic!("{:?}", other),
    }
    match &cfs[&0][1].rule {
        cf::ConditionalFormatRule::DataBar(r) => {
            let min = r.min_formula.clone().unwrap_or_default();
            assert!(names_ref_not(&min, "Data"), "a data-bar bound still names the deleted sheet: `{}`", min);
            assert_eq!(r.max_formula.as_deref(), Some("=MAX(Other!C:C)"), "an unrelated bound was rewritten");
        }
        other => panic!("{:?}", other),
    }
    let dvs = state.data_validations.read().unwrap();
    match &dvs[&0][0].validation.rule {
        dv::DataValidationRule::Custom(r) => {
            assert!(names_ref_not(&r.formula, "Data"), "a custom validation still names the deleted sheet: `{}`", r.formula)
        }
        other => panic!("{:?}", other),
    }
    let controls = state.controls.read().unwrap();
    let props = &controls[&(0, 1, 1)].properties;
    assert!(
        names_ref_not(&props["text"].value, "Data"),
        "a control's formula property still names the deleted sheet: `{}`",
        props["text"].value
    );
    assert_eq!(props["fill"].value, "Data!A1", "a STATIC control property is a literal");
}

#[test]
fn deleting_a_sheet_turns_a_pane_dropdowns_range_source_into_ref() {
    use crate::pane_control::{DropdownSource, PaneControl, PaneControlConfig, PaneControlState, PaneControlType};
    let (state, file) = book(&["Data", "Other"]);
    let pane = PaneControlState::new();
    let dropdown = |reference: &str| PaneControl {
        id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        name: reference.to_string(),
        control_type: PaneControlType::Dropdown,
        config: PaneControlConfig::Dropdown {
            source: DropdownSource::CellRange { reference: reference.to_string() },
            placeholder: None,
            chart_param_target: None,
        },
        value: None,
        order: 0,
    };
    let gone = dropdown("Data!A1:A5");
    let kept = dropdown("Other!A1:A5");
    let (gone_id, kept_id) = (gone.id, kept.id);
    {
        let mut controls = pane.controls.lock().unwrap();
        controls.insert(gone_id, gone);
        controls.insert(kept_id, kept);
    }
    delete(&state, &file, &pane, 1);
    let reference_of = |id: &identity::EntityId| match &pane.controls.lock().unwrap()[id].config {
        PaneControlConfig::Dropdown { source: DropdownSource::CellRange { reference }, .. } => reference.clone(),
        other => panic!("{:?}", other),
    };
    assert_eq!(reference_of(&gone_id), "#REF!", "a dropdown still lists the deleted sheet's cells");
    assert_eq!(reference_of(&kept_id), "Other!A1:A5", "an unrelated dropdown source was rewritten");
}

// ---------------------------------------------------------------------------
// W11: the override layer after a delete
// ---------------------------------------------------------------------------

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
fn deleting_a_sheet_repairs_every_formula_in_the_override_layer() {
    let (state, file) = book(&["Data", "Other"]);
    let sheet1 = state.sheet_ids.read().unwrap()[0];
    {
        let mut layer = state.override_layer.write(&test_seed_effect()).unwrap();
        layer.overrides.push(override_on(sheet1, "DATA!A1*2", "Data!A1*3", Some("Data!A1*4")));
        layer.overrides.push(override_on(sheet1, "Other!A1*2", "b1+1", None));
    }
    delete(&state, &file, &crate::pane_control::PaneControlState::new(), 1);
    let layer = state.override_layer.read().unwrap();
    let repaired = &layer.overrides[0];
    for (what, text) in [
        ("baseline", formula_text(&repaired.baseline)),
        ("current", formula_text(&repaired.current)),
        ("upstream", formula_text(repaired.upstream_new.as_ref().expect("upstream kept"))),
    ] {
        assert!(names_ref_not(&text, "Data"), "the override's {} still names the deleted sheet: `{}`", what, text);
        assert!(!text.starts_with('='), "the override's {} gained a leading `=`: `{}`", what, text);
    }
    let untouched = &layer.overrides[1];
    assert_eq!(formula_text(&untouched.baseline), "Other!A1*2", "an unrelated override formula was re-spelled");
    assert_eq!(formula_text(&untouched.current), "b1+1", "an unrelated override formula was re-spelled");
}

// ---------------------------------------------------------------------------
// Found with W10: a LIST validation's source range, named by sheet INDEX
// ---------------------------------------------------------------------------

fn list_validation(sheet_index: Option<usize>) -> crate::data_validation::ValidationRange {
    use crate::data_validation as dv;
    dv::ValidationRange {
        start_row: 0,
        start_col: 0,
        end_row: 9,
        end_col: 0,
        validation: dv::DataValidation {
            rule: dv::DataValidationRule::List(dv::ListRule {
                source: dv::ListSource::Range { sheet_index, start_row: 0, start_col: 0, end_row: 4, end_col: 0 },
                in_cell_dropdown: true,
            }),
            ..dv::DataValidation::default()
        },
    }
}

fn list_sources(state: &AppState, sheet: usize) -> Vec<crate::data_validation::ListSource> {
    state.data_validations.read().unwrap()[&sheet]
        .iter()
        .map(|r| match &r.validation.rule {
            crate::data_validation::DataValidationRule::List(l) => l.source.clone(),
            other => panic!("{:?}", other),
        })
        .collect()
}

fn source_sheet(source: &crate::data_validation::ListSource) -> Option<Option<usize>> {
    match source {
        crate::data_validation::ListSource::Range { sheet_index, .. } => Some(*sheet_index),
        crate::data_validation::ListSource::Values(_) => None,
    }
}

#[test]
fn a_list_validations_source_sheet_follows_a_delete_and_a_move() {
    let (state, file) = book(&["Data", "Lists"]);
    let lists = index_of(&state, "Lists");
    state.data_validations.write(&test_seed_effect()).unwrap().insert(
        0,
        vec![list_validation(Some(lists)), list_validation(Some(1)), list_validation(None)],
    );
    delete(&state, &file, &crate::pane_control::PaneControlState::new(), 1);
    let sources = list_sources(&state, 0);
    assert_eq!(
        source_sheet(&sources[0]),
        Some(Some(index_of(&state, "Lists"))),
        "after deleting Data, a dropdown sourced from Lists lists another sheet: {:?}",
        sources[0]
    );
    let dead = &sources[1];
    let live_sheet = matches!(source_sheet(dead), Some(Some(i)) if i < state.sheet_names.read().unwrap().len());
    assert!(!live_sheet, "a dropdown sourced from the deleted sheet now lists a live sheet's cells: {:?}", dead);
    assert_eq!(source_sheet(&sources[2]), Some(None), "a same-sheet source was rewritten");

    move_to(&state, &file, index_of(&state, "Lists"), 0);
    let at = index_of(&state, "Sheet1");
    let sources = list_sources(&state, at);
    assert_eq!(
        source_sheet(&sources[0]),
        Some(Some(index_of(&state, "Lists"))),
        "after moving Lists, the dropdown lists another sheet: {:?}",
        sources[0]
    );
}

// ---------------------------------------------------------------------------
// W9: a chart's INDEX-ONLY data ranges follow the sheets
// ---------------------------------------------------------------------------

fn range_ref(sheet_index: usize) -> serde_json::Value {
    serde_json::json!({ "sheetIndex": sheet_index, "startRow": 0, "startCol": 0, "endRow": 4, "endCol": 1 })
}

//// A chart record whose ranges sit in all four places a spec carries them,
/// each naming its OWN sheet (the source walk deduplicates), plus a second
/// layer naming `dead` and a third already STAMPED with an id.
fn chart_record(data: usize, layer: usize, lookup: usize, child: usize, dead: usize, stamped_id: &str) -> String {
    let mut stamped = range_ref(0);
    stamped["sheetId"] = serde_json::Value::String(stamped_id.to_string());
    serde_json::json!({
        "chartId": "c1",
        "spec": {
            "mark": "bar",
            "data": range_ref(data),
            "layers": [
                { "mark": "line", "data": range_ref(layer) },
                { "mark": "line", "data": range_ref(dead) },
                { "mark": "line", "data": stamped }
            ],
            "transform": [ { "type": "lookup", "from": range_ref(lookup) } ],
            "concat": { "charts": [ { "mark": "bar", "data": range_ref(child) } ] }
        }
    })
    .to_string()
}

fn chart_sources(state: &AppState) -> Vec<calp::chart_refs::ChartSourceSheet> {
    let charts = state.charts.read().unwrap();
    calp::chart_refs::chart_spec_source_sheets(&charts[0].spec_json)
}

fn index_refs(sources: &[calp::chart_refs::ChartSourceSheet]) -> Vec<usize> {
    sources
        .iter()
        .filter_map(|s| match s {
            calp::chart_refs::ChartSourceSheet::Index(i) => Some(*i),
            _ => None,
        })
        .collect()
}

/// Sheet1, Data, then A..D: one sheet per place a range can sit.
fn chart_book() -> (AppState, FileState, String) {
    let (state, file) = book(&["Data", "A", "B", "C", "D"]);
    let stamped_id = state.sheet_ids.read().unwrap()[2].to_string();
    state.charts.write(&test_seed_effect()).unwrap().push(crate::api_types::ChartEntry {
        id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        sheet_index: 0,
        // data -> A, layer -> B, lookup -> C, concat child -> D, one layer -> Data.
        spec_json: chart_record(2, 3, 4, 5, 1, &stamped_id),
    });
    (state, file, stamped_id)
}

#[test]
fn a_charts_index_only_ranges_follow_a_sheet_delete() {
    use calp::chart_refs::ChartSourceSheet;
    let (state, file, stamped_id) = chart_book();
    delete(&state, &file, &crate::pane_control::PaneControlState::new(), 1);
    let sources = chart_sources(&state);
    let want: Vec<usize> = ["A", "B", "C", "D"].iter().map(|n| index_of(&state, n)).collect();
    assert_eq!(
        index_refs(&sources),
        want,
        "after Data was deleted, an index-only range (data, layer, lookup, concat child) names another sheet: {:?}",
        sources
    );
    // The range that named the DELETED sheet must not resolve to any sheet.
    let ids: Vec<String> = state.sheet_ids.read().unwrap().iter().map(|i| i.to_string()).collect();
    let dead = sources
        .iter()
        .filter(|s| matches!(s, ChartSourceSheet::Id(id) if !ids.contains(&id.to_string())))
        .count();
    assert_eq!(dead, 1, "the range on the deleted sheet does not read as gone: {:?}", sources);
    // A range already stamped with an id is left to its id.
    assert!(
        sources.iter().any(|s| matches!(s, ChartSourceSheet::Id(id) if id.to_string() == stamped_id)),
        "a stamped range lost its id: {:?}",
        sources
    );
}

#[test]
fn a_charts_index_only_ranges_follow_a_sheet_move() {
    let (state, file, _) = chart_book();
    move_to(&state, &file, 5, 0);
    let sources = chart_sources(&state);
    // Walk order: data (A), layer (B), layer (Data), lookup (C), child (D).
    let want: Vec<usize> = ["A", "B", "Data", "C", "D"].iter().map(|n| index_of(&state, n)).collect();
    assert_eq!(
        index_refs(&sources),
        want,
        "an index-only range kept the index its sheet had before the move: {:?}",
        sources
    );
}

// ---------------------------------------------------------------------------
// W7: a rename carries pane-control dropdown sources -- through every door
// ---------------------------------------------------------------------------

/// The body of `pub fn <name>(` in `src`, up to the closing brace at column 0.
fn body_of<'a>(src: &'a str, head: &str) -> &'a str {
    let at = src.find(head).unwrap_or_else(|| panic!("`{}` not found", head));
    let end = src[at..].find("\n}\n").map(|e| at + e).expect("its body");
    &src[at..end]
}

/// `body` without its `//` comments (a comment must not satisfy a census).
fn code_of(body: &str) -> String {
    body.lines().map(|l| l.split("//").next().unwrap_or("")).collect::<Vec<_>>().join("\n")
}

#[test]
fn every_rename_door_carries_pane_dropdown_sources() {
    let sheets = include_str!("sheets.rs").replace("\r\n", "\n");
    let mcp = include_str!("mcp/objects.rs").replace("\r\n", "\n");
    let fr = include_str!("floating_range.rs").replace("\r\n", "\n");
    for (door, body) in [
        ("the rename_sheet command", code_of(body_of(&sheets, "pub fn rename_sheet("))),
        ("the rename_floating_range command", code_of(body_of(&fr, "pub fn rename_floating_range("))),
    ] {
        assert!(
            body.contains("with_pane_controls_following_rename("),
            "{} renames a sheet without carrying the pane dropdowns that name it",
            door
        );
    }
    // The MCP tool goes through the COMMAND (so through the same carry), not
    // around it to `rename_sheet_inner`.
    let tool = code_of(body_of(&mcp, "pub fn rename_sheet("));
    assert!(
        tool.contains("crate::sheets::rename_sheet(") && !tool.contains("rename_sheet_inner("),
        "the MCP rename_sheet tool renames a sheet around the command's pane-dropdown carry"
    );
}

/// W7, behaviour: a rename through the carry renames a dropdown's range source
/// (the sheet followed by its id); a refused rename carries nothing.
#[test]
fn a_rename_carries_a_pane_dropdowns_range_source_and_a_refused_one_does_not() {
    use crate::pane_control::{DropdownSource, PaneControl, PaneControlConfig, PaneControlState, PaneControlType};
    let (state, file) = book(&["Data", "Other"]);
    let pane = PaneControlState::new();
    let control = PaneControl {
        id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        name: "Region".to_string(),
        control_type: PaneControlType::Dropdown,
        config: PaneControlConfig::Dropdown {
            source: DropdownSource::CellRange { reference: "Data!A1:A5".to_string() },
            placeholder: None,
            chart_param_target: None,
        },
        value: None,
        order: 0,
    };
    let id = control.id;
    pane.controls.lock().unwrap().insert(id, control);
    let reference = || match &pane.controls.lock().unwrap()[&id].config {
        PaneControlConfig::Dropdown { source: DropdownSource::CellRange { reference }, .. } => reference.clone(),
        other => panic!("{:?}", other),
    };
    let data_id = Some(state.sheet_ids.read().unwrap()[1]);

    // A refused rename (Other's name) carries nothing.
    let refused = with_pane_controls_following_rename(&state, &pane, data_id, || {
        rename_sheet_inner(&state, &file, &PivotState::new(), 1, "Other".to_string(), false)
    });
    assert!(refused.is_err(), "fixture: a duplicate name is refused");
    assert_eq!(reference(), "Data!A1:A5", "a refused rename rewrote a dropdown source");

    with_pane_controls_following_rename(&state, &pane, data_id, || {
        rename_sheet_inner(&state, &file, &PivotState::new(), 1, "My Facts".to_string(), false)
    })
    .expect("rename Data");
    assert_eq!(reference(), "'My Facts'!A1:A5", "a dropdown's range source kept the old sheet name");
}

// ---------------------------------------------------------------------------
// W10/W11 fix-up: a 3D reference whose ENDPOINT is the deleted sheet
// ---------------------------------------------------------------------------
//
// A cell and a defined name keep a 3D reference whose endpoint is deleted by
// moving that endpoint inward (Excel's rule, `repair_3d_refs_on_delete_at`):
// `SUM(Mid:Data!B1)` becomes `SUM(Mid:Mid!B1)`. The rule stores and the
// override layer went through the `.calp` gone-walker alone, which turns such
// a reference into `#REF!` -- so a conditional format read `=SUM(#REF!)>0`
// beside a cell that still summed Mid, and an override's CURRENT text became
// `SUM(#REF!)`, which the next refresh writes back over the working cell
// (`apply_override_value_to_grid`). They now take the cells' rule. The
// override's BASELINE and conflict UPSTREAM keep the refresh's rule on
// purpose: they are upstream text, and a refresh compares its own rewrite of
// the untouched upstream -- which reads a gone endpoint as `#REF!`
// (`RefreshSheetNames::renames`) -- with the baseline; the cells' spelling
// there would be a false conflict at every refresh.

fn same(a: &str, b: &str) -> bool {
    calp::sheet_renames::same_formula_text(a, b)
}

#[test]
fn a_3d_reference_losing_an_endpoint_reads_alike_in_the_cell_and_every_store() {
    use crate::conditional_formatting as cf;
    use crate::data_validation as dv;
    // Sheet1 (formulas), Mid, Data (deleted), Last, Other.
    let (state, file) = book(&["Mid", "Data", "Last", "Other"]);
    let seed = test_seed_effect();
    let cell = engine::Cell::new_formula("=SUM(Mid:Data!B1)".to_string());
    assert!(cell.ast.is_some(), "fixture parses");
    state.grid.write(&seed).unwrap().set_cell(0, 0, cell.clone());
    state.grids.write(&seed).unwrap()[0].set_cell(0, 0, cell);
    state.conditional_formats.write(&seed).unwrap().insert(
        0,
        vec![cf_def(
            1,
            cf::ConditionalFormatRule::Expression(cf::ExpressionRule {
                formula: "=SUM(Mid:Data!B1)>0".to_string(),
            }),
        )],
    );
    state.data_validations.write(&seed).unwrap().insert(
        0,
        vec![dv::ValidationRange {
            start_row: 0,
            start_col: 0,
            end_row: 9,
            end_col: 0,
            validation: dv::DataValidation {
                rule: dv::DataValidationRule::Custom(dv::CustomRule {
                    formula: "=SUM(Data:Last!B1)>A1".to_string(),
                }),
                ..dv::DataValidation::default()
            },
        }],
    );
    {
        let mut properties = HashMap::new();
        properties.insert("text".to_string(), control_prop("formula", "=SUM(Mid:Data!B1)"));
        state.controls.write(&seed).unwrap().insert(
            (0, 1, 1),
            crate::controls::ControlMetadata { control_type: "button".to_string(), properties },
        );
    }
    let sheet1 = state.sheet_ids.read().unwrap()[0];
    state.override_layer.write(&seed).unwrap().overrides.push(override_on(
        sheet1,
        "SUM(Mid:Data!B1)",
        "SUM(Mid:Data!B1)*2",
        Some("SUM(Data:Last!B1)"),
    ));

    delete(&state, &file, &crate::pane_control::PaneControlState::new(), index_of(&state, "Data"));

    let cell_now =
        state.grid.read().unwrap().get_cell(0, 0).and_then(|c| c.formula_string_raw()).unwrap_or_default();
    assert!(same(&cell_now, "SUM(Mid:Mid!B1)"), "fixture: the CELL's endpoint moved inward: `{}`", cell_now);

    let cfs = state.conditional_formats.read().unwrap();
    let rule = match &cfs[&0][0].rule {
        cf::ConditionalFormatRule::Expression(r) => r.formula.clone(),
        other => panic!("{:?}", other),
    };
    assert!(
        same(&rule, "=SUM(Mid:Mid!B1)>0"),
        "the cell kept `{}` but its conditional format became `{}`",
        cell_now,
        rule
    );
    let dvs = state.data_validations.read().unwrap();
    let custom = match &dvs[&0][0].validation.rule {
        dv::DataValidationRule::Custom(r) => r.formula.clone(),
        other => panic!("{:?}", other),
    };
    assert!(same(&custom, "=SUM(Last:Last!B1)>A1"), "a custom validation became `{}`", custom);
    let text = state.controls.read().unwrap()[&(0, 1, 1)].properties["text"].value.clone();
    assert!(same(&text, "=SUM(Mid:Mid!B1)"), "a control's formula property became `{}`", text);

    let layer = state.override_layer.read().unwrap();
    let ovr = &layer.overrides[0];
    let current = formula_text(&ovr.current);
    assert!(
        same(&current, "SUM(Mid:Mid!B1)*2") && !current.starts_with('='),
        "the override's CURRENT text -- written over the cell at the next refresh -- became `{}`",
        current
    );
    for (what, text) in [
        ("baseline", formula_text(&ovr.baseline)),
        ("upstream", formula_text(ovr.upstream_new.as_ref().expect("upstream kept"))),
    ] {
        assert!(
            names_ref_not(&text, "Data") && !text.starts_with('='),
            "the override's {} is UPSTREAM text and follows the refresh's rule (`#REF!`): `{}`",
            what,
            text
        );
    }
}
