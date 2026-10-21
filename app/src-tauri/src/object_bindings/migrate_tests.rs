//! FILENAME: app/src-tauri/src/object_bindings/migrate_tests.rs
// PURPOSE: WP-D S5a (D §3.13). The two old spellings of "this property follows
//          a formula" -- a formula-typed control property and a chart's `=A1`
//          title / axis title / series name -- become bindings; code slots stay
//          byte-identical; a non-bindable formula-typed key becomes STATIC text,
//          never blank; a formula that cannot be normalised is kept with its
//          error; the migration is idempotent, dirties nothing on the load path,
//          and the load path runs it.

use std::collections::HashMap;

use engine::{Cell, CellValue};
use serde_json::{json, Value};

use super::migrate::{is_cell_reference_text, migrate_legacy_formulas, ChartTextFields, MigrationReport};
use super::store::{BindingKey, StoredBinding};
use super::*;
use crate::controls::{ControlMetadata, ControlPropertyValue, HELD_FROM_PROPERTY, HELD_MACRO_REF_PROPERTY, HELD_ON_SELECT_PROPERTY};
use crate::document_effect::{test_seed_effect, CleanReason};

const DATA: usize = 0;
const INPUTS: usize = 1;
const REPORT: usize = 2;

fn stat(v: &str) -> ControlPropertyValue {
    ControlPropertyValue { value_type: "static".into(), value: v.into() }
}

fn formula(v: &str) -> ControlPropertyValue {
    ControlPropertyValue { value_type: "formula".into(), value: v.into() }
}

fn load_effect() -> DocumentEffect {
    DocumentEffect::deliberately_clean(CleanReason::LoadingFromDisk)
}

/// Data and Inputs are worksheets (Data active), Report is a canvas page.
struct Wb {
    state: AppState,
    file: FileState,
    slicers: crate::slicer::SlicerState,
    timelines: crate::timeline_slicer::TimelineSlicerState,
    pivots: crate::pivot::types::PivotState,
    pane: crate::pane_control::PaneControlState,
    ribbon: crate::ribbon_filter::RibbonFilterState,
}

impl Wb {
    fn new() -> Wb {
        let state = crate::create_app_state();
        let seed = test_seed_effect();
        *state.sheet_names.write(&seed).unwrap() = vec!["Data".into(), "Inputs".into(), "Report".into()];
        *state.sheet_ids.write(&seed).unwrap() =
            (0..3).map(|_| identity::SheetId::from_bytes(identity::generate_uuid_v7())).collect();
        *state.sheet_kinds.write(&seed).unwrap() = vec![
            ::persistence::SheetKind::Worksheet,
            ::persistence::SheetKind::Worksheet,
            ::persistence::SheetKind::new_canvas(),
        ];
        *state.sheet_visibility.write(&seed).unwrap() = vec!["visible".to_string(); 3];
        *state.grids.write(&seed).unwrap() = vec![engine::Grid::new(), engine::Grid::new(), engine::Grid::new()];
        Wb {
            state,
            file: FileState::default(),
            slicers: crate::slicer::SlicerState::new(),
            timelines: crate::timeline_slicer::TimelineSlicerState::new(),
            pivots: crate::pivot::types::PivotState::new(),
            pane: crate::pane_control::PaneControlState::new(),
            ribbon: crate::ribbon_filter::RibbonFilterState::new(),
        }
    }

    fn cx(&self) -> BindingCx<'_> {
        BindingCx {
            state: &self.state,
            file_state: &self.file,
            slicers: &self.slicers,
            timelines: &self.timelines,
            pivots: &self.pivots,
            pane: &self.pane,
            ribbon: &self.ribbon,
            user_files: Box::leak(Box::new(crate::persistence::UserFilesState::default())),
        }
    }

    fn set_cell(&self, sheet: usize, row: u32, col: u32, cell: Cell) {
        let seed = test_seed_effect();
        if sheet == DATA {
            self.state.grid.write(&seed).unwrap().set_cell(row, col, cell.clone());
        }
        self.state.grids.write(&seed).unwrap()[sheet].set_cell(row, col, cell);
    }

    fn control(&self, key: (usize, u32, u32), control_type: &str, uid: &str, props: &[(&str, ControlPropertyValue)]) {
        self.state.controls.write(&test_seed_effect()).unwrap().insert(
            key,
            ControlMetadata {
                control_type: control_type.into(),
                uid: uid.into(),
                properties: props.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(),
            },
        );
    }

    fn props(&self, key: (usize, u32, u32)) -> HashMap<String, ControlPropertyValue> {
        self.state.controls.read().unwrap()[&key].properties.clone()
    }

    fn chart(&self, sheet: usize, spec: Value) -> String {
        let id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
        let envelope = json!({ "chartId": id.to_string(), "name": "Revenue chart", "sheetIndex": sheet, "spec": spec });
        self.state.charts.write(&test_seed_effect()).unwrap().push(crate::api_types::ChartEntry {
            id,
            sheet_index: sheet,
            spec_json: envelope.to_string(),
        });
        id.to_string()
    }

    fn chart_definition(&self, id: &str) -> Value {
        let charts = self.state.charts.read().unwrap();
        serde_json::from_str(&charts.iter().find(|c| c.id.to_string() == id).unwrap().spec_json).unwrap()
    }

    fn binding(&self, kind: ObjectBindingKind, id: &str, path: &str) -> Option<String> {
        let key = BindingKey { object: ObjectBindingRef { kind, id: id.into() }, path: path.into() };
        self.state.object_bindings.read().unwrap().bindings.get(&key).map(|b| b.formula.clone())
    }

    fn binding_count(&self) -> usize {
        self.state.object_bindings.read().unwrap().bindings.len()
    }

    /// The migration as it runs on a PRE-bindings file (charts included).
    fn migrate(&self) -> MigrationReport {
        migrate_legacy_formulas(&self.state, &load_effect(), ChartTextFields::LegacyCellReferences)
    }

    /// The migration as it runs on a file of `format_version`.
    fn migrate_file_of_version(&self, format_version: u32) -> MigrationReport {
        migrate_legacy_formulas(&self.state, &load_effect(), ChartTextFields::for_format_version(format_version))
    }

    fn resolved(&self, kind: ObjectBindingKind, id: &str, path: &str) -> crate::api_types::ResolvedBinding {
        resolve_all_core(&self.cx())
            .into_iter()
            .find(|r| r.object.kind == kind && r.object.id == id && r.path == path)
            .unwrap_or_else(|| panic!("no resolved value for {id} {path}"))
    }
}

/// The code slots of a control as (key, value type, value), sorted -- the
/// material `calp::code_summary` fingerprints a button's code from.
fn code_slots(props: &HashMap<String, ControlPropertyValue>) -> Vec<(String, String, String)> {
    let mut out: Vec<(String, String, String)> = props
        .iter()
        .filter(|(k, _)| crate::controls::is_code_slot(k))
        .map(|(k, p)| (k.clone(), p.value_type.clone(), p.value.clone()))
        .collect();
    out.sort();
    out
}

fn code_hash(props: &HashMap<String, ControlPropertyValue>) -> String {
    calp::integrity::sha256_hex(serde_json::to_string(&code_slots(props)).unwrap().as_bytes())
}

// ===========================================================================
// Controls
// ===========================================================================

/// A formula-typed bindable property becomes a binding (qualified with the
/// control's OWN sheet, the old evaluator's rule), its literal is emptied, and
/// the value it resolves to is what the old evaluator displayed.
///
/// SABOTAGE: skip the `new_bindings.push` in `migrate_controls` (no binding).
#[test]
fn a_formula_property_becomes_a_binding_that_shows_what_the_old_evaluator_showed() {
    let wb = Wb::new();
    wb.set_cell(DATA, 0, 0, Cell::new_number(42.0));
    wb.set_cell(INPUTS, 0, 1, Cell::new_number(14.0));
    wb.control((DATA, 3, 3), "shape", "u-shape", &[("text", formula("=A1")), ("fontSize", formula("=Inputs!B1")), ("fill", stat("#ffffff"))]);

    let report = wb.migrate();
    assert_eq!(report.control_bindings, 2, "{report:?}");
    assert_eq!(wb.binding(ObjectBindingKind::Control, "u-shape", "/properties/text").as_deref(), Some("=Data!A1"));
    assert_eq!(wb.binding(ObjectBindingKind::Control, "u-shape", "/properties/fontSize").as_deref(), Some("=Inputs!B1"));
    let props = wb.props((DATA, 3, 3));
    for key in ["text", "fontSize"] {
        assert_eq!((props[key].value_type.as_str(), props[key].value.as_str()), ("static", ""), "{key}: the literal is emptied");
    }
    assert_eq!(props["fill"].value, "#ffffff", "a static property is untouched");

    resolve_all_core(&wb.cx());
    let shown = crate::controls::resolve_control_properties_core(&wb.state, DATA, 3, 3);
    // The old evaluator displayed `format_cell_value_simple` of the result.
    assert_eq!(shown["text"], crate::format_cell_value_simple(&CellValue::Number(42.0)));
    assert_eq!(shown["fontSize"], crate::format_cell_value_simple(&CellValue::Number(14.0)));
    assert!(!wb.file.is_dirty(), "a load-path migration dirties nothing");
    assert_eq!(wb.state.undo_stack.lock().unwrap().undo_depth(), 0, "and records no undo step");
}

/// On a CANVAS the old evaluator read an unqualified reference on the canvas
/// itself (it has no cells), so the faithful migration qualifies with the
/// canvas: the same (empty) answer as before, never a silently different one.
#[test]
fn a_canvas_controls_unqualified_reference_keeps_the_old_sheet() {
    let wb = Wb::new();
    wb.control((REPORT, 0, 0), "shape", "u-c", &[("text", formula("=A1"))]);
    wb.migrate();
    assert_eq!(wb.binding(ObjectBindingKind::Control, "u-c", "/properties/text").as_deref(), Some("=Report!A1"));
}

/// SABOTAGE: drop the `is_code_slot` filter from `control_needs_migration` and
/// `migrate_controls` (onSelect then becomes static text).
#[test]
fn formula_typed_onselect_survives_migration_unchanged() {
    let wb = Wb::new();
    wb.control(
        (DATA, 1, 1),
        "button",
        "u-b",
        &[
            ("onSelect", formula("=A1")),
            ("macroRef", formula("macro-1")),
            ("action", formula("navigate")),
            ("actionTarget", formula("=B1")),
            ("text", stat("Go")),
        ],
    );
    let before = wb.props((DATA, 1, 1));
    let report = wb.migrate();
    assert_eq!(report, MigrationReport::default(), "nothing to migrate on a button whose only formulas are code");
    let after = wb.props((DATA, 1, 1));
    assert_eq!(code_slots(&after), code_slots(&before), "code slots byte-identical, value types included");
    assert_eq!(wb.binding_count(), 0, "code is never bound");
}

#[test]
fn held_slots_survive_migration_unchanged() {
    let wb = Wb::new();
    let stamp = crate::held_button_code::HeldFrom {
        workspace: "ws".into(),
        application: "sales".into(),
        version: "1.0.0".into(),
        value_types: [("onSelect".to_string(), "formula".to_string())].into_iter().collect(),
    };
    wb.control(
        (DATA, 2, 2),
        "button",
        "u-h",
        &[
            (HELD_ON_SELECT_PROPERTY, formula("=A1")),
            (HELD_MACRO_REF_PROPERTY, formula("macro-x")),
            (HELD_FROM_PROPERTY, ControlPropertyValue { value_type: "formula".into(), value: stamp.encode() }),
            ("text", formula("=A1")),
        ],
    );
    let before = wb.props((DATA, 2, 2));
    let report = wb.migrate();
    assert_eq!(report.control_bindings, 1, "the caption migrates (non-vacuity): {report:?}");
    let after = wb.props((DATA, 2, 2));
    for key in [HELD_ON_SELECT_PROPERTY, HELD_MACRO_REF_PROPERTY, HELD_FROM_PROPERTY] {
        assert_eq!(
            (after[key].value_type.as_str(), after[key].value.as_str()),
            (before[key].value_type.as_str(), before[key].value.as_str()),
            "{key} is byte-identical"
        );
    }
}

/// A PULLED button (checked out: its code moved into the held compartment,
/// stamped with the package's value types) keeps the same code hash through
/// the migration, while its formula caption does become a binding.
///
/// SABOTAGE: let `migrate_controls` set `value_type = "static"` on every
/// non-static property, code slots included.
#[test]
fn a_pulled_buttons_code_hash_is_unchanged_by_migration() {
    let wb = Wb::new();
    let sheet_id = wb.state.sheet_ids.read().unwrap()[DATA];
    let package = vec![::persistence::SavedSheetControls {
        sheet_id,
        controls: json!([{
            "row": 4, "col": 2, "controlType": "button", "uid": "app-button-1",
            "properties": {
                "onSelect": { "valueType": "formula", "value": "=Report()" },
                "macroRef": { "valueType": "static", "value": "mod-1" },
                "text": { "valueType": "formula", "value": "=Data!A1" },
                "action": { "valueType": "formula", "value": "navigate" },
                "actionTarget": { "valueType": "formula", "value": "=Detail" }
            }
        }]),
    }];
    let stamp = crate::held_button_code::HeldFrom {
        workspace: "ws".into(),
        application: "sales".into(),
        version: "1.0.0".into(),
        value_types: Default::default(),
    };
    let (admitted, admission) =
        crate::held_button_code::admit_wiring(&package, &crate::held_button_code::DistributedWiring::Hold(stamp));
    assert!(admission.held >= 1, "precondition: the checkout held the code: {admission:?}");
    {
        let mut controls = wb.state.controls.write(&test_seed_effect()).unwrap();
        crate::controls::materialize_saved_controls(&admitted, &mut controls, |_| Some(DATA), &crate::controls::PageTargetRemap::identity());
    }
    let before = wb.props((DATA, 4, 2));
    assert!(!code_slots(&before).is_empty(), "precondition: the pulled button carries code");
    assert!(
        code_slots(&before).iter().any(|(_, value_type, _)| value_type == "formula"),
        "precondition: a code slot keeps a non-static value type through the checkout: {:?}",
        code_slots(&before)
    );
    let hash_before = code_hash(&before);

    let report = wb.migrate();
    assert_eq!(report.control_bindings, 1, "{report:?}");
    assert_eq!(wb.binding(ObjectBindingKind::Control, "app-button-1", "/properties/text").as_deref(), Some("=Data!A1"));
    assert_eq!(code_hash(&wb.props((DATA, 4, 2))), hash_before, "the button's code hash is unchanged");
}

/// A formula-typed key the catalog does not accept -- identity (`name`), a
/// position, a script-declared key -- and a "formula" that is no formula
/// become STATIC text of the original, never blank.
///
/// SABOTAGE: blank the value in the else branch of `migrate_controls`.
#[test]
fn formula_typed_name_becomes_static_text_not_blank() {
    let wb = Wb::new();
    wb.control(
        (DATA, 5, 5),
        "shape",
        "u-n",
        &[("name", formula("=A1")), ("x", formula("=B1")), ("myDeclaredKey", formula("=C1")), ("text", formula("Hello"))],
    );
    let report = wb.migrate();
    assert_eq!((report.control_literals, report.control_bindings), (4, 0), "{report:?}");
    let props = wb.props((DATA, 5, 5));
    for (key, value) in [("name", "=A1"), ("x", "=B1"), ("myDeclaredKey", "=C1"), ("text", "Hello")] {
        assert_eq!((props[key].value_type.as_str(), props[key].value.as_str()), ("static", value), "{key}");
    }
    assert_eq!(wb.binding_count(), 0);
}

/// A formula that fails normalisation is still a binding -- of the ORIGINAL
/// text -- and its resolved error says why; never silently dropped.
#[test]
fn a_formula_that_cannot_be_normalised_is_kept_with_its_error() {
    let wb = Wb::new();
    wb.control((DATA, 6, 6), "shape", "u-x", &[("text", formula("=Nowhere!A1"))]);
    wb.migrate();
    assert_eq!(wb.binding(ObjectBindingKind::Control, "u-x", "/properties/text").as_deref(), Some("=Nowhere!A1"));
    assert_eq!(wb.props((DATA, 6, 6))["text"].value, "", "the literal is emptied all the same");
    let r = wb.resolved(ObjectBindingKind::Control, "u-x", "/properties/text");
    let why = r.error.expect("an error that says why");
    assert!(why.to_lowercase().contains("nowhere"), "{why}");
}

/// A control with no uid (a file written before uids) gets one, and its
/// migrated binding names it.
#[test]
fn a_control_without_a_uid_gets_one_before_it_is_bound() {
    let wb = Wb::new();
    wb.control((DATA, 7, 7), "shape", "", &[("text", formula("=A1"))]);
    let report = wb.migrate();
    assert_eq!((report.uids_minted, report.control_bindings), (1, 1));
    let uid = wb.state.controls.read().unwrap()[&(DATA, 7, 7)].uid.clone();
    assert!(identity::EntityId::parse(&uid).is_some());
    assert_eq!(wb.binding(ObjectBindingKind::Control, &uid, "/properties/text").as_deref(), Some("=Data!A1"));
}

// ===========================================================================
// Charts
// ===========================================================================

#[test]
fn the_cell_reference_rule_is_the_charts_extension_rule() {
    for yes in ["=A3", "=Sheet1!B5", "='My Sheet'!C1", "=$A$1", "= B2"] {
        assert!(is_cell_reference_text(yes), "{yes}");
    }
    for no in ["A3", "=", "=A1:B2", "=Total sales", "=SUM(A1)", "=A1+1", "Revenue", ""] {
        assert!(!is_cell_reference_text(no), "{no}");
    }
}

/// A chart's `=A1` title / axis title / series name becomes a binding with the
/// reference qualified to the chart's DATA sheet (the `specReferenceSheet`
/// rule) -- on a canvas too -- and canonical sheet case; the literal becomes
/// null (title) or "" (the rest); text that is not one cell is left as typed.
///
/// SABOTAGE: drop the `chart_data_sheet` branch of `chart_reference_sheet`.
#[test]
fn chart_cell_reference_fields_become_bindings_on_the_data_sheet() {
    let wb = Wb::new();
    wb.set_cell(DATA, 0, 0, Cell::new_text("Revenue by region".to_string()));
    let id = wb.chart(
        REPORT,
        json!({
            "mark": "bar",
            "data": "Data!A1:B5",
            "title": "=A1",
            "xAxis": { "title": "=inputs!B1" },
            "yAxis": { "title": "Amount" },
            "series": [{ "name": "=B1" }, { "name": "=Total" }]
        }),
    );

    let report = wb.migrate();
    assert_eq!(report.chart_bindings, 3, "{report:?}");
    let chart = ObjectBindingKind::Chart;
    assert_eq!(wb.binding(chart, &id, "/spec/title").as_deref(), Some("=Data!A1"), "the canvas chart reads its DATA sheet");
    assert_eq!(wb.binding(chart, &id, "/spec/xAxis/title").as_deref(), Some("=Inputs!B1"), "canonical sheet case");
    assert_eq!(wb.binding(chart, &id, "/spec/series/0/name").as_deref(), Some("=Data!B1"));
    let def = wb.chart_definition(&id);
    assert_eq!(def.pointer("/spec/title"), Some(&Value::Null), "the title literal becomes null");
    assert_eq!(def.pointer("/spec/xAxis/title"), Some(&json!("")));
    assert_eq!(def.pointer("/spec/series/0/name"), Some(&json!("")));
    assert_eq!(def.pointer("/spec/yAxis/title"), Some(&json!("Amount")), "a literal title is untouched");
    assert_eq!(def.pointer("/spec/series/1/name"), Some(&json!("=Total")), "not one cell: left as typed");
    assert_eq!(def.pointer("/spec/data"), Some(&json!("Data!A1:B5")), "the rest of the spec is untouched");

    let title = wb.resolved(chart, &id, "/spec/title");
    assert_eq!(title.value, json!("Revenue by region"), "the bound title shows the cell, as the old reader did");
}

/// A worksheet chart whose data has no sheet reads its OWN sheet; a qualified
/// reference keeps its sheet.
#[test]
fn a_worksheet_charts_unqualified_title_reads_its_own_sheet() {
    let wb = Wb::new();
    let id = wb.chart(INPUTS, json!({ "mark": "bar", "data": "A1:B5", "title": "=C1", "yAxis": { "title": "=data!A2" } }));
    wb.migrate();
    assert_eq!(wb.binding(ObjectBindingKind::Chart, &id, "/spec/title").as_deref(), Some("=Inputs!C1"));
    assert_eq!(wb.binding(ObjectBindingKind::Chart, &id, "/spec/yAxis/title").as_deref(), Some("=Data!A2"));
}

/// An existing binding at a migrated path wins; the old spelling is still
/// retired.
#[test]
fn an_existing_binding_wins_over_the_old_spelling() {
    let wb = Wb::new();
    let id = wb.chart(DATA, json!({ "mark": "bar", "data": "Data!A1:B5", "title": "=A1" }));
    let key = BindingKey {
        object: ObjectBindingRef { kind: ObjectBindingKind::Chart, id: id.clone() },
        path: "/spec/title".into(),
    };
    wb.state
        .object_bindings
        .write(&test_seed_effect())
        .unwrap()
        .bindings
        .insert(key, StoredBinding { formula: "=Inputs!A9".into(), model: None });
    let report = wb.migrate();
    assert_eq!(report.kept_existing, 1, "{report:?}");
    assert_eq!(wb.binding(ObjectBindingKind::Chart, &id, "/spec/title").as_deref(), Some("=Inputs!A9"));
    assert_eq!(wb.chart_definition(&id).pointer("/spec/title"), Some(&Value::Null));
}

// ===========================================================================
// Idempotence and the load path
// ===========================================================================

/// SABOTAGE: stop emptying the control literal (the second run then binds it
/// again and reports work).
#[test]
fn the_migration_is_idempotent() {
    let wb = Wb::new();
    wb.control((DATA, 1, 1), "shape", "u-i", &[("text", formula("=A1")), ("name", formula("=B1"))]);
    let id = wb.chart(DATA, json!({ "mark": "bar", "data": "Data!A1:B5", "title": "=A1" }));
    let first = wb.migrate();
    assert!(first.changed_anything());
    let rows = wb.state.object_bindings.read().unwrap().snapshot();
    let generation = wb.state.object_bindings.read().unwrap().generation;
    let props = wb.props((DATA, 1, 1));
    let def = wb.chart_definition(&id);

    let second = wb.migrate();
    assert_eq!(second, MigrationReport::default(), "a second run finds nothing");
    assert_eq!(wb.state.object_bindings.read().unwrap().snapshot(), rows);
    assert_eq!(wb.state.object_bindings.read().unwrap().generation, generation, "no store write at all");
    let after = wb.props((DATA, 1, 1));
    for (k, p) in &props {
        assert_eq!((&after[k].value_type, &after[k].value), (&p.value_type, &p.value), "{k}");
    }
    assert_eq!(wb.chart_definition(&id), def);
}

/// `open_file` cannot be driven in-process (it takes `State<AppState>`), so its
/// ONE call is pinned from source: the migration runs, and runs AFTER the
/// controls, the charts and the bindings are restored.
///
/// SABOTAGE: delete the `migrate_legacy_formulas` call from `open_file`.
#[test]
fn the_load_path_runs_the_migration_after_controls_charts_and_bindings() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/persistence.rs");
    let src = std::fs::read_to_string(&path).expect("persistence.rs");
    let body = super::eval_tests::functions(&src)
        .into_iter()
        .find(|(name, _)| name == "open_file")
        .map(|(_, body)| body)
        .expect("persistence.rs defines open_file");
    let at = |needle: &str| body.find(needle).unwrap_or_else(|| panic!("open_file no longer calls {needle}"));
    let migrate = at("migrate_legacy_formulas(");
    for earlier in ["materialize_saved_controls(", "restore_charts(", "restore_bindings_from_disk("] {
        assert!(at(earlier) < migrate, "the migration must run after {earlier}");
    }
    let call: String = body[migrate..].chars().take(300).collect();
    assert!(call.contains("LoadingFromDisk"), "the load path migrates under LoadingFromDisk: {call}");
}

// ===========================================================================
// A bindings-era literal "=B2" is TEXT (BUG: the migration ran on every open)
// ===========================================================================

/// Since bindings exist a chart field that starts with `=` is TEXT: a script
/// `setLiteral` or an MCP `set_object_property(chart, "/spec/title", "=B2")`
/// stores it and it paints as typed. Re-opening the v10 file must not turn it
/// into a binding nobody created (the title would show B2's VALUE). A file a
/// pre-bindings writer produced (v9, or an .xlsx = 0) still migrates.
///
/// SABOTAGE: drop the `chart_fields == LegacyCellReferences` guard around
/// `migrate_charts` in `migrate_legacy_formulas` -- the v10 run binds the
/// title and empties it.
#[test]
fn a_v10_files_literal_equals_chart_title_stays_text_on_reopen() {
    let spec = json!({
        "mark": "bar",
        "data": "Data!A1:B5",
        "title": "=B2",
        "xAxis": { "title": "=A1" },
        "series": [{ "name": "=B1" }]
    });
    let wb = Wb::new();
    wb.set_cell(DATA, 1, 1, Cell::new_number(99.0));
    let id = wb.chart(DATA, spec.clone());
    let before = wb.chart_definition(&id);

    let report = wb.migrate_file_of_version(calcula_format::CHART_SPEC_OBJECT_MIN_FORMAT_VERSION);
    assert_eq!(report.chart_bindings, 0, "{report:?}");
    assert_eq!(wb.binding_count(), 0, "no binding appears that nobody created");
    assert_eq!(wb.chart_definition(&id), before, "the literal text is kept exactly");
    assert_eq!(wb.chart_definition(&id).pointer("/spec/title"), Some(&json!("=B2")));

    // A pre-bindings file (v9) and an .xlsx (0) keep the old rule.
    for legacy in [calcula_format::CHART_SPEC_OBJECT_MIN_FORMAT_VERSION - 1, 0] {
        let old = Wb::new();
        let old_id = old.chart(DATA, spec.clone());
        let report = old.migrate_file_of_version(legacy);
        assert_eq!(report.chart_bindings, 3, "v{legacy}: {report:?}");
        assert_eq!(old.binding(ObjectBindingKind::Chart, &old_id, "/spec/title").as_deref(), Some("=Data!B2"));
    }
}

/// The two doors that decide the chart reading, pinned from source: the load
/// path derives it from the archive's own format version, and every `.calp`
/// pull/refresh call passes `Literals` (a pull parses only the bindings-era
/// chart shape).
///
/// SABOTAGE: pass `ChartTextFields::LegacyCellReferences` at either
/// `calp_commands.rs` call -- the count of `Literals` calls drops.
#[test]
fn the_load_path_and_the_calp_doors_choose_the_chart_reading() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let persistence = std::fs::read_to_string(root.join("persistence.rs")).expect("persistence.rs");
    let open = super::eval_tests::functions(&persistence)
        .into_iter()
        .find(|(name, _)| name == "open_file")
        .map(|(_, body)| body)
        .expect("persistence.rs defines open_file");
    let at = open.find("migrate_legacy_formulas(").expect("open_file migrates");
    let call: String = open[at..].chars().take(400).collect();
    assert!(
        call.contains("ChartTextFields::for_format_version(workbook.format_version)"),
        "the load path reads charts by the archive's version: {call}"
    );

    let calp = std::fs::read_to_string(root.join("calp_commands.rs")).expect("calp_commands.rs");
    let calls: Vec<String> = calp
        .match_indices("migrate::migrate_legacy_formulas(")
        .map(|(i, _)| calp[i..].chars().take(200).collect())
        .collect();
    assert_eq!(calls.len(), 2, "the pull and the refresh door: {calls:#?}");
    for call in &calls {
        assert!(call.contains("ChartTextFields::Literals"), "a .calp door never migrates chart literals: {call}");
    }
}
