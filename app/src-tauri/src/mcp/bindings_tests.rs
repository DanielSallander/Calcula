//! FILENAME: app/src-tauri/src/mcp/bindings_tests.rs
// PURPOSE: The AI binding tools (WP-D S10, D §3.20): list_object_properties
//          reads one object / one sheet; set_object_binding and
//          set_object_property each leave exactly ONE undo step and ONE audit
//          row (accepted or refused), change nothing when nothing changes, and
//          answer with the value the property shows now; the summary's
//          "Canvas objects" / "Bound properties" sections print literals,
//          bindings, errors, cut long values and respect the char budget.

use engine::Cell;
use serde_json::{json, Value};

use super::bindings::*;
use crate::api_types::{ObjectBindingKind, ObjectBindingRef};
use crate::document_effect::test_seed_effect;
use crate::object_bindings::store::{BindingKey, StoredBinding};
use crate::object_bindings::BindingCx;
use crate::persistence::FileState;
use crate::AppState;

const DATA: usize = 0;
const INPUTS: usize = 1;
const REPORT: usize = 2;

fn new_id() -> [u8; 16] {
    identity::generate_uuid_v7()
}

/// Data (active) and Inputs are worksheets, Report is a canvas page.
struct Wb {
    state: AppState,
    file: FileState,
    slicers: crate::slicer::SlicerState,
    timelines: crate::timeline_slicer::TimelineSlicerState,
    pivots: crate::pivot::types::PivotState,
    pane: crate::pane_control::PaneControlState,
    ribbon: crate::ribbon_filter::RibbonFilterState,
    bi: crate::bi::types::BiState,
    ids: Vec<identity::SheetId>,
}

impl Wb {
    fn new() -> Wb {
        let state = crate::create_app_state();
        let seed = test_seed_effect();
        let ids: Vec<identity::SheetId> = (0..3).map(|_| identity::SheetId::from_bytes(new_id())).collect();
        *state.sheet_names.write(&seed).unwrap() =
            vec!["Data".to_string(), "Inputs".to_string(), "Report".to_string()];
        *state.sheet_ids.write(&seed).unwrap() = ids.clone();
        *state.sheet_kinds.write(&seed).unwrap() = vec![
            ::persistence::SheetKind::Worksheet,
            ::persistence::SheetKind::Worksheet,
            ::persistence::SheetKind::new_canvas(),
        ];
        *state.sheet_visibility.write(&seed).unwrap() = vec!["visible".to_string(); 3];
        *state.grids.write(&seed).unwrap() = vec![engine::Grid::new(), engine::Grid::new(), engine::Grid::new()];
        // Displays are locale-formatted; the expected texts are en-US.
        *state.locale.lock().unwrap() = engine::LocaleSettings::invariant();
        Wb {
            state,
            file: FileState::default(),
            slicers: crate::slicer::SlicerState::new(),
            timelines: crate::timeline_slicer::TimelineSlicerState::new(),
            pivots: crate::pivot::types::PivotState::new(),
            pane: crate::pane_control::PaneControlState::new(),
            ribbon: crate::ribbon_filter::RibbonFilterState::new(),
            bi: crate::bi::types::BiState::new(),
            ids,
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

    fn chart(&self, sheet: usize, name: &str, spec: Value) -> ObjectBindingRef {
        let id = identity::EntityId::from_bytes(new_id());
        let envelope = json!({
            "chartId": id.to_string(), "name": name, "sheetIndex": sheet,
            "x": 40, "y": 40, "width": 240, "height": 140, "spec": spec
        });
        self.state.charts.write(&test_seed_effect()).unwrap().push(crate::api_types::ChartEntry {
            id,
            sheet_index: sheet,
            spec_json: envelope.to_string(),
        });
        ObjectBindingRef { kind: ObjectBindingKind::Chart, id: id.to_string() }
    }

    fn chart_spec(&self, object: &ObjectBindingRef) -> Value {
        let charts = self.state.charts.read().unwrap();
        let entry = charts.iter().find(|c| c.id.to_string() == object.id).expect("the chart");
        serde_json::from_str::<Value>(&entry.spec_json).unwrap()["spec"].clone()
    }

    fn control(&self, sheet: usize, uid: &str) -> ObjectBindingRef {
        let meta: crate::controls::ControlMetadata = serde_json::from_value(json!({
            "controlType": "shape",
            "uid": uid,
            "properties": {
                "text": { "valueType": "static", "value": "Hello" },
                "fill": { "valueType": "static", "value": "#336699" },
                "x": { "valueType": "static", "value": "300" },
                "y": { "valueType": "static", "value": "40" },
                "width": { "valueType": "static", "value": "180" },
                "height": { "valueType": "static", "value": "60" },
                "pinToGrid": { "valueType": "static", "value": "false" }
            }
        }))
        .expect("a control");
        self.state.controls.write(&test_seed_effect()).unwrap().insert((sheet, 0, 0), meta);
        ObjectBindingRef { kind: ObjectBindingKind::Control, id: uid.to_string() }
    }

    /// Store a binding row directly (a load), never evaluated.
    fn store(&self, object: &ObjectBindingRef, path: &str, formula: &str) {
        let mut store = self.state.object_bindings.write(&test_seed_effect()).unwrap();
        store.bindings.insert(
            BindingKey { object: object.clone(), path: path.to_string() },
            StoredBinding { formula: formula.to_string(), model: None },
        );
        store.bump_generation();
    }

    fn depth(&self) -> usize {
        self.state.undo_stack.lock().unwrap().undo_depth()
    }

    fn undo_description(&self) -> Option<String> {
        self.state.undo_stack.lock().unwrap().undo_description().map(str::to_string)
    }

    fn dirty(&self) -> bool {
        self.file.is_dirty()
    }

    fn mcp_rows(&self, tool: &str) -> Vec<calp::audit::AuditEntry> {
        self.state
            .audit_log
            .read()
            .unwrap()
            .entries
            .iter()
            .filter(|e| e.extra.get("surface") == Some(&json!("mcp")) && e.extra.get("tool") == Some(&json!(tool)))
            .cloned()
            .collect()
    }

    fn summary(&self) -> Option<String> {
        format_canvas_objects(&gather_object_summary(&self.cx()))
    }
}

// ===========================================================================
// list_object_properties
// ===========================================================================

#[test]
fn one_object_is_read_as_json_with_its_bindable_paths_and_its_bindings() {
    let wb = Wb::new();
    wb.set_cell(INPUTS, 0, 1, Cell::new_text("Revenue 2025".to_string()));
    let chart = wb.chart(REPORT, "Revenue card", json!({ "mark": "card", "title": "Revenue", "series": [{ "name": "2024" }, { "name": "2025" }] }));
    wb.store(&chart, "/spec/xAxis/title", "=Inputs!B1");

    let text = list_object_properties_core(&wb.cx(), Some("chart"), Some(&chart.id), None).expect("one object");
    let v: Value = serde_json::from_str(&text).expect("compact JSON");
    assert_eq!(v["object"], json!({ "kind": "chart", "id": chart.id, "name": "Revenue card", "sheetIndex": REPORT, "sheetName": "Report" }));
    assert_eq!(v["json"]["spec"]["title"], "Revenue", "the object's own JSON");

    let bindable: Vec<&Value> = v["bindable"].as_array().unwrap().iter().collect();
    let paths: Vec<&str> = bindable.iter().map(|b| b["path"].as_str().unwrap()).collect();
    assert!(paths.contains(&"/spec/title"));
    // A `*` row is expanded over what the object has...
    assert!(paths.contains(&"/spec/series/0/name") && paths.contains(&"/spec/series/1/name"), "{paths:?}");
    assert!(!paths.contains(&"/spec/series/*/name"), "an expanded row is not also listed as its pattern");
    // ...and a `*` row with nothing to expand over is listed as its pattern.
    assert!(paths.contains(&"/spec/seriesColors/*"), "{paths:?}");
    let title = bindable.iter().find(|b| b["path"] == "/spec/xAxis/title").unwrap();
    assert_eq!((title["type"].as_str(), title["label"].as_str()), (Some("text"), Some("x axis title")));
    let units = bindable.iter().find(|b| b["path"] == "/spec/markOptions/displayUnits").unwrap();
    assert_eq!(units["type"], "enum");
    assert!(units["values"].as_array().unwrap().contains(&json!("millions")));

    // The binding comes with the value it shows -- evaluated on the way, since
    // nothing had evaluated the row before.
    assert_eq!(
        v["bindings"],
        json!([{ "path": "/spec/xAxis/title", "formula": "=Inputs!B1", "model": null, "display": "Revenue 2025", "error": null, "pending": false }])
    );
    assert!(!wb.dirty() && wb.depth() == 0, "a read changes nothing");
}

#[test]
fn a_sheet_lists_each_object_and_its_bindings() {
    let wb = Wb::new();
    wb.set_cell(INPUTS, 0, 0, Cell::new_text("Europe".to_string()));
    let chart = wb.chart(REPORT, "Revenue card", json!({ "mark": "card" }));
    let control = wb.control(REPORT, "uid-1");
    wb.store(&control, "/properties/text", "=\"Region: \"&Inputs!A1");

    let text = list_object_properties_core(&wb.cx(), None, None, Some(REPORT)).expect("a sheet");
    assert!(text.starts_with("Objects on sheet \"Report\" (index=2, canvas):"), "{text}");
    assert!(text.contains(&format!("- chart id={} name=\"Revenue card\" mark=card at 40,40 size 240x140", chart.id)), "{text}");
    assert!(text.contains("- control id=uid-1 name=\"shape\" type=shape at 300,40 size 180x60 text=\"Hello\""), "{text}");
    assert!(text.contains("    /properties/text := =\"Region: \"&Inputs!A1 -> \"Region: Europe\""), "{text}");
    assert!(text.contains(&format!("- canvasPage id={}", wb.ids[REPORT])), "the page itself is an object: {text}");

    let err = list_object_properties_core(&wb.cx(), None, None, Some(9)).unwrap_err();
    assert!(err.contains("out of range") && err.contains("list_sheets"), "{err}");
}

#[test]
fn a_call_without_a_target_or_with_a_bad_kind_says_what_to_pass() {
    let wb = Wb::new();
    let none = list_object_properties_core(&wb.cx(), None, None, None).unwrap_err();
    assert!(none.contains("get_sheet_summary"), "{none}");
    let half = list_object_properties_core(&wb.cx(), Some("chart"), None, None).unwrap_err();
    assert!(half.contains("BOTH kind and id"), "{half}");
    let kind = list_object_properties_core(&wb.cx(), Some("graph"), Some("x"), None).unwrap_err();
    assert!(kind.contains("'graph' is not an object kind") && kind.contains("timelineSlicer"), "{kind}");
    let missing = list_object_properties_core(&wb.cx(), Some("chart"), Some("nope"), None).unwrap_err();
    assert!(missing.contains("There is no chart with id 'nope'") && missing.contains("get_sheet_summary"), "{missing}");
}

// ===========================================================================
// set_object_binding
// ===========================================================================

#[tokio::test]
async fn set_object_binding_leaves_one_undo_step_one_audit_row_and_answers_with_the_value() {
    let wb = Wb::new();
    wb.set_cell(INPUTS, 0, 1, Cell::new_text("Revenue 2025".to_string()));
    let chart = wb.chart(REPORT, "Revenue card", json!({ "mark": "card", "title": "Revenue" }));

    let reply = set_object_binding_core(&wb.cx(), &wb.bi, "chart", &chart.id, "/spec/title", Some("=Inputs!B1"), None)
        .await
        .expect("bound");
    assert_eq!(reply, "Bound /spec/title of chart Revenue card to =Inputs!B1 -> \"Revenue 2025\" (one undo step).");
    assert_eq!(wb.depth(), 1);
    assert_eq!(wb.undo_description().as_deref(), Some("Bind property"));
    assert!(wb.dirty());
    let rows = wb.mcp_rows(SET_OBJECT_BINDING_TOOL);
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(
        (rows[0].extra["op"].clone(), rows[0].extra["ok"].clone(), rows[0].extra["path"].clone(), rows[0].extra["formula"].clone()),
        (json!("bindingSet"), json!(true), json!("/spec/title"), json!("=Inputs!B1"))
    );

    // The same formula again: nothing changes, no second undo step -- but the
    // attempt is still on the record.
    let again = set_object_binding_core(&wb.cx(), &wb.bi, "chart", &chart.id, "/spec/title", Some("=Inputs!B1"), None)
        .await
        .unwrap();
    assert!(again.ends_with("(it was already bound to that formula; nothing changed)."), "{again}");
    assert_eq!(wb.depth(), 1);
    assert_eq!(wb.mcp_rows(SET_OBJECT_BINDING_TOOL).len(), 2);

    // No formula = clear: one more step, and the reply names what was removed.
    let cleared = set_object_binding_core(&wb.cx(), &wb.bi, "chart", &chart.id, "/spec/title", None, None)
        .await
        .unwrap();
    assert!(cleared.starts_with("Removed the binding of /spec/title on chart Revenue card (it was =Inputs!B1)"), "{cleared}");
    assert_eq!(wb.depth(), 2);
    assert_eq!(wb.undo_description().as_deref(), Some("Remove property binding"));
    let rows = wb.mcp_rows(SET_OBJECT_BINDING_TOOL);
    assert_eq!(rows.last().unwrap().extra["op"], "bindingClear");

    let nothing = set_object_binding_core(&wb.cx(), &wb.bi, "chart", &chart.id, "/spec/title", Some("  "), None)
        .await
        .unwrap();
    assert!(nothing.ends_with("has no binding; nothing changed."), "{nothing}");
    assert_eq!(wb.depth(), 2);
}

#[tokio::test]
async fn a_refused_binding_changes_nothing_and_is_still_audited() {
    let wb = Wb::new();
    let chart = wb.chart(REPORT, "Revenue card", json!({ "mark": "card" }));
    let err = set_object_binding_core(&wb.cx(), &wb.bi, "chart", &chart.id, "/spec/mark", Some("=Inputs!A1"), None)
        .await
        .unwrap_err();
    assert!(err.contains("is not a bindable property of a chart"), "{err}");
    let control = wb.control(REPORT, "uid-1");
    let code = set_object_binding_core(&wb.cx(), &wb.bi, "control", &control.id, "/properties/onSelect", Some("=1"), None)
        .await
        .unwrap_err();
    assert!(code.contains("is code"), "{code}");
    assert!(!wb.dirty() && wb.depth() == 0, "a refusal changes nothing");
    let rows = wb.mcp_rows(SET_OBJECT_BINDING_TOOL);
    assert_eq!(rows.len(), 2, "refused attempts are recorded: {rows:?}");
    assert!(rows.iter().all(|r| r.extra["ok"] == json!(false) && r.extra.get("error").is_some()));
}

// ===========================================================================
// set_object_property
// ===========================================================================

#[test]
fn set_object_property_writes_the_literal_in_one_undo_step_and_audits_it() {
    let wb = Wb::new();
    let chart = wb.chart(REPORT, "Revenue card", json!({ "mark": "card", "title": "Revenue" }));

    let written = set_object_property_core(&wb.cx(), "chart", &chart.id, "/spec/title", json!("=A1")).expect("written");
    assert_eq!(written.reply, "Set /spec/title of chart Revenue card to \"=A1\" (one undo step).");
    assert!(!written.domains.is_empty(), "the frontend is told what to refresh");
    assert_eq!(wb.chart_spec(&chart)["title"], "=A1", "a literal starting with '=' is TEXT");
    assert_eq!(wb.depth(), 1);
    let rows = wb.mcp_rows(SET_OBJECT_PROPERTY_TOOL);
    assert_eq!(rows.len(), 1);
    assert_eq!((rows[0].extra["op"].clone(), rows[0].extra["ok"].clone()), (json!("literalSet"), json!(true)));

    // Unchanged: no step, the reply says so.
    let same = set_object_property_core(&wb.cx(), "chart", &chart.id, "/spec/title", json!("=A1")).unwrap();
    assert!(same.reply.ends_with("nothing changed.") && same.domains.is_empty(), "{}", same.reply);
    assert_eq!(wb.depth(), 1);

    // A bound property: the literal is written, and the reply warns that the
    // binding is what shows.
    wb.store(&chart, "/spec/xAxis/title", "=Inputs!A1");
    let bound = set_object_property_core(&wb.cx(), "chart", &chart.id, "/spec/xAxis/title", json!("Months")).unwrap();
    assert!(bound.reply.contains("this property is bound to =Inputs!A1"), "{}", bound.reply);

    // A control goes through the SetLiteral control arm's own undo record.
    let control = wb.control(REPORT, "uid-2");
    let depth = wb.depth();
    set_object_property_core(&wb.cx(), "control", &control.id, "/properties/fill", json!("#FF0000")).expect("fill");
    assert_eq!(wb.depth(), depth + 1);
    assert_eq!(wb.undo_description().as_deref(), Some("Set property"));
    assert_eq!(wb.mcp_rows(SET_OBJECT_PROPERTY_TOOL).len(), 4);

    // Refused: never bindable, never literal-writable through this door.
    let before = wb.depth();
    let err = set_object_property_core(&wb.cx(), "control", &control.id, "/properties/onSelect", json!("x")).unwrap_err();
    assert!(err.contains("is code"), "{err}");
    assert_eq!(wb.depth(), before);
    assert_eq!(wb.mcp_rows(SET_OBJECT_PROPERTY_TOOL).last().unwrap().extra["ok"], json!(false));
}

// ===========================================================================
// get_sheet_summary's object sections
// ===========================================================================

#[test]
fn the_summary_prints_literals_bindings_errors_and_cuts_long_values() {
    let wb = Wb::new();
    wb.set_cell(INPUTS, 0, 0, Cell::new_number(42.0));
    wb.set_cell(INPUTS, 0, 2, Cell::new_text("not a number".to_string()));
    let long_title = "R".repeat(200);
    let card = wb.chart(REPORT, "Revenue card", json!({ "mark": "card", "title": long_title, "markOptions": { "goal": 10 } }));
    wb.store(&card, "/spec/markOptions/goal", "=Inputs!A1");
    wb.store(&card, "/spec/yAxis/min", "=Inputs!C1");
    let control = wb.control(REPORT, "uid-3");
    // Bound on a worksheet: listed under "Bound properties (worksheets)";
    // an unbound worksheet chart is not (the Charts inventory has it).
    let bound_ws = wb.chart(DATA, "Trend", json!({ "mark": "line" }));
    wb.store(&bound_ws, "/spec/title", "=Inputs!A1&\" units\"");
    let unbound_ws = wb.chart(DATA, "Unbound", json!({ "mark": "bar" }));

    let text = wb.summary().expect("a canvas and bindings");
    let lines: Vec<&str> = text.lines().collect();
    assert!(text.starts_with("\n\n## Canvas objects\n"), "{text}");
    assert!(lines.contains(&"### Report (index=2)"), "{text}");
    assert!(lines.contains(&format!("- chart id={} name=\"Revenue card\" mark=card at 40,40 size 240x140", card.id).as_str()), "{text}");

    // A literal: present at a catalog path, quoted, cut to 80 characters.
    let title = lines.iter().find(|l| l.trim_start().starts_with("/spec/title = ")).expect("the literal title");
    let value = title.trim_start().trim_start_matches("/spec/title = ");
    assert_eq!(value.chars().count(), MAX_SUMMARY_VALUE_CHARS, "{value}");
    assert!(value.ends_with('…') && value.starts_with("\"RRR"), "{value}");

    // A binding wins over its literal, with the value it shows now (evaluated
    // on the way: nothing had evaluated these rows).
    assert!(lines.contains(&"    /spec/markOptions/goal := =Inputs!A1 -> \"42\""), "{text}");
    assert!(!lines.iter().any(|l| l.contains("/spec/markOptions/goal = ")), "a bound path shows no literal line: {text}");
    // An error says so in a sentence.
    let err = lines.iter().find(|l| l.contains("/spec/yAxis/min := =Inputs!C1 -> ERROR: ")).expect("an error line");
    assert!(err.len() > "    /spec/yAxis/min := =Inputs!C1 -> ERROR: ".len() + 5, "{err}");

    assert!(lines.contains(&"- control id=uid-3 name=\"shape\" type=shape at 300,40 size 180x60 text=\"Hello\""), "{text}");
    assert!(lines.contains(&"    /properties/fill = \"#336699\""), "{text}");
    assert!(lines.iter().any(|l| l.starts_with(&format!("- canvasPage id={}", wb.ids[REPORT]))), "{text}");
    let _ = control;

    assert!(lines.contains(&"## Bound properties (worksheets)"), "{text}");
    assert!(lines.contains(&format!("- chart id={} name=\"Trend\" mark=line at 40,40 size 240x140 on sheet \"Data\" (index=0)", bound_ws.id).as_str()), "{text}");
    assert!(lines.contains(&"    /spec/title := =Inputs!A1&\" units\" -> \"42 units\""), "{text}");
    assert!(!text.contains(&unbound_ws.id), "an unbound worksheet chart is not repeated: {text}");
    assert!(!wb.dirty() && wb.depth() == 0, "the summary is a read");
}

#[test]
fn a_workbook_without_canvas_or_bindings_has_no_object_section() {
    let wb = Wb::new();
    *wb.state.sheet_kinds.write(&test_seed_effect()).unwrap() =
        vec![::persistence::SheetKind::Worksheet; 3];
    wb.chart(DATA, "Plain", json!({ "mark": "bar" }));
    assert!(wb.summary().is_none());
}

#[test]
fn sheets_are_filtered_like_the_canvases_section_filters_them() {
    // A user-HIDDEN canvas is still a user sheet: the "## Canvases" section
    // lists it (`format_canvas_inventory`), so its objects are listed too.
    let wb = Wb::new();
    wb.chart(REPORT, "Hidden page chart", json!({ "mark": "card" }));
    wb.state.sheet_visibility.write(&test_seed_effect()).unwrap()[REPORT] = "hidden".to_string();
    assert!(wb.summary().expect("listed").contains("name=\"Hidden page chart\""));

    // An OBJECT-backed sheet (a floating range's cell store) is not a user
    // sheet: it is never summarised as a sheet of its own.
    let wb = Wb::new();
    wb.chart(REPORT, "Never", json!({ "mark": "card" }));
    wb.state.sheet_visibility.write(&test_seed_effect()).unwrap()[REPORT] =
        crate::sheets::OBJECT_SHEET_VISIBILITY.to_string();
    assert!(wb.summary().is_none(), "{:?}", wb.summary());
}

#[test]
fn the_section_is_appended_only_within_the_char_budget() {
    let mut summary = "x".repeat(50);
    assert!(!append_within_budget(&mut summary, &"y".repeat(51), 100), "50 + 51 > 100");
    assert_eq!(summary.len(), 50, "nothing half-appended");
    assert!(append_within_budget(&mut summary, &"y".repeat(50), 100), "50 + 50 fits exactly");
    assert!(append_within_budget(&mut summary, "z", 0), "0 = no budget");
    assert_eq!(summary.len(), 101);
}

// ===========================================================================
// The Locate op the Bound Properties view reads
// ===========================================================================

#[test]
fn locate_names_each_object_and_its_sheet_and_leaves_out_a_missing_one() {
    let wb = Wb::new();
    let chart = wb.chart(REPORT, "Revenue card", json!({ "mark": "card" }));
    let control = wb.control(DATA, "uid-4");
    let gone = ObjectBindingRef { kind: ObjectBindingKind::Slicer, id: "no-such-slicer".to_string() };
    let page = ObjectBindingRef { kind: ObjectBindingKind::CanvasPage, id: wb.ids[REPORT].to_string() };
    let request: crate::api_types::ObjectBindingsRequest = serde_json::from_value(json!({
        "op": "locate", "objects": [control, gone, chart, page]
    }))
    .expect("the wire shape");
    let handled = crate::object_bindings::handle_request(&wb.cx(), &[], request).expect("located");
    let wire = serde_json::to_value(&handled.response).unwrap();
    assert_eq!(wire["kind"], "located");
    assert_eq!(
        wire["places"],
        json!([
            { "object": control, "name": "shape", "sheetIndex": DATA, "sheetName": "Data" },
            { "object": chart, "name": "Revenue card", "sheetIndex": REPORT, "sheetName": "Report" },
            { "object": page, "name": "Report", "sheetIndex": REPORT, "sheetName": "Report" },
        ]),
        "in the order asked, the missing slicer left out"
    );
}

// ===========================================================================
// Pure helpers
// ===========================================================================

#[test]
fn a_pattern_expands_over_what_the_object_has() {
    let json = json!({ "spec": { "series": [{}, {}], "seriesColors": { "North/South": "#fff", "East": "#000" } } });
    assert_eq!(expand_pattern("/spec/series/*/name", &json), vec!["/spec/series/0/name", "/spec/series/1/name"]);
    let mut colors = expand_pattern("/spec/seriesColors/*", &json);
    colors.sort();
    assert_eq!(colors, vec!["/spec/seriesColors/East", "/spec/seriesColors/North~1South"], "keys are escaped");
    assert_eq!(expand_pattern("/spec/params/*/value", &json), Vec::<String>::new());
    assert_eq!(expand_pattern("/spec/title", &json), vec!["/spec/title"], "a plain path is returned present or not");
}

#[test]
fn a_label_reads_the_path_after_its_root() {
    assert_eq!(path_label("/spec/xAxis/title"), "x axis title");
    assert_eq!(path_label("/properties/fontSize"), "font size");
    assert_eq!(path_label("/spec/series/0/name"), "series 0 name");
    assert_eq!(path_label("/headerText"), "header text");
}

#[test]
fn a_value_is_cut_with_an_ellipsis_only_when_it_is_long() {
    assert_eq!(truncate_value("short"), "short");
    let cut = truncate_value(&"a".repeat(81));
    assert_eq!(cut.chars().count(), MAX_SUMMARY_VALUE_CHARS);
    assert!(cut.ends_with('…'));
    assert_eq!(truncate_value(&"a".repeat(80)), "a".repeat(80));
}
