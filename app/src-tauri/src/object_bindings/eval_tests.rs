//! FILENAME: app/src-tauri/src/object_bindings/eval_tests.rs
// PURPOSE: The evaluator and THE ONE re-evaluation entry point (D §3.7): scoped
//          re-evaluation touches only dependents, SheetId-keyed cross-sheet
//          edges survive a rename, the active sheet is read through its live
//          mirror, a generation bump rebuilds, coercion per catalog type, and
//          the lock discipline (D §3.3) -- a source census and a two-thread
//          probe with a deadline.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use engine::{Cell, CellStyle, CellValue, NumberFormat};
use serde_json::{json, Value};

use super::catalog::BindableValueType;
use super::eval::*;
use super::object_json::ObjectStores;
use super::store::{BindingKey, StoredBinding};
use crate::api_types::{ObjectBindingKind, ObjectBindingRef, ResolvedBinding};
use crate::document_effect::test_seed_effect;
use crate::AppState;

const DATA: usize = 0;
const INPUTS: usize = 1;
const REPORT: usize = 2;

fn new_id() -> [u8; 16] {
    identity::generate_uuid_v7()
}

/// Data and Inputs are worksheets (Data active), Report is a canvas page.
struct Wb {
    state: Arc<AppState>,
    slicers: crate::slicer::SlicerState,
    timelines: crate::timeline_slicer::TimelineSlicerState,
    pivots: crate::pivot::types::PivotState,
    pane: crate::pane_control::PaneControlState,
    ribbon: crate::ribbon_filter::RibbonFilterState,
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
        Wb {
            state: Arc::new(state),
            slicers: crate::slicer::SlicerState::new(),
            timelines: crate::timeline_slicer::TimelineSlicerState::new(),
            pivots: crate::pivot::types::PivotState::new(),
            pane: crate::pane_control::PaneControlState::new(),
            ribbon: crate::ribbon_filter::RibbonFilterState::new(),
            ids,
        }
    }

    fn stores(&self) -> ObjectStores<'_> {
        ObjectStores { state: &self.state, slicers: &self.slicers, timelines: &self.timelines, pivots: &self.pivots }
    }

    fn reevaluate(&self, scope: Scope) -> Vec<ResolvedBinding> {
        reevaluate(&self.stores(), &self.pane, &self.ribbon, scope)
    }

    /// Write a cell the way the app keeps it: on the ACTIVE sheet (Data) both
    /// the live mirror and its `grids` slot, elsewhere the `grids` slot.
    fn set(&self, sheet: usize, row: u32, col: u32, cell: Cell) {
        let seed = test_seed_effect();
        if sheet == DATA {
            self.state.grid.write(&seed).unwrap().set_cell(row, col, cell.clone());
        }
        self.state.grids.write(&seed).unwrap()[sheet].set_cell(row, col, cell);
    }

    fn chart(&self, sheet: usize, spec: Value) -> String {
        let id = identity::EntityId::from_bytes(new_id());
        let envelope = json!({ "chartId": id.to_string(), "name": "Chart", "sheetIndex": sheet, "spec": spec });
        self.state.charts.write(&test_seed_effect()).unwrap().push(crate::api_types::ChartEntry {
            id,
            sheet_index: sheet,
            spec_json: envelope.to_string(),
        });
        id.to_string()
    }

    fn bind(&self, kind: ObjectBindingKind, id: &str, path: &str, formula: &str) -> BindingKey {
        self.bind_model(kind, id, path, formula, None)
    }

    fn bind_model(&self, kind: ObjectBindingKind, id: &str, path: &str, formula: &str, model: Option<&str>) -> BindingKey {
        let key = BindingKey { object: ObjectBindingRef { kind, id: id.to_string() }, path: path.to_string() };
        let mut store = self.state.object_bindings.write(&test_seed_effect()).unwrap();
        store
            .bindings
            .insert(key.clone(), StoredBinding { formula: formula.to_string(), model: model.map(str::to_string) });
        store.bump_generation();
        key
    }

    fn resolved(&self, key: &BindingKey) -> Option<ResolvedBinding> {
        self.state.object_binding_runtime.lock().unwrap().resolved.get(key).cloned()
    }

    fn value(&self, key: &BindingKey) -> Value {
        self.resolved(key).map(|r| r.value).unwrap_or(Value::Null)
    }
}

fn text(s: &str) -> Cell {
    Cell::new_text(s.to_string())
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

#[test]
fn reevaluate_resolves_a_binding_and_announces_only_changes() {
    let wb = Wb::new();
    wb.set(DATA, 0, 0, text("Revenue"));
    let chart = wb.chart(DATA, json!({ "title": "static" }));
    let key = wb.bind(ObjectBindingKind::Chart, &chart, "/spec/title", "=Data!A1");

    let changed = wb.reevaluate(Scope::All);
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0].value, json!("Revenue"));
    assert_eq!(changed[0].display, "Revenue");
    assert!(changed[0].error.is_none() && !changed[0].pending);

    assert!(wb.reevaluate(Scope::All).is_empty(), "nothing changed, so nothing is announced");

    wb.set(DATA, 0, 0, text("Margin"));
    let changed = wb.reevaluate(Scope::All);
    assert_eq!(changed.iter().map(|r| r.value.clone()).collect::<Vec<_>>(), vec![json!("Margin")]);
    assert_eq!(wb.value(&key), json!("Margin"));
}

#[test]
fn reevaluate_cells_touches_only_dependents() {
    let wb = Wb::new();
    wb.set(DATA, 0, 0, Cell::new_number(1.0));
    wb.set(INPUTS, 1, 1, Cell::new_number(10.0));
    for r in 0..3 {
        wb.set(DATA, r, 3, Cell::new_number(1.0));
    }
    let a = wb.chart(DATA, json!({}));
    let b = wb.chart(DATA, json!({}));
    let c = wb.chart(DATA, json!({}));
    let on_a1 = wb.bind(ObjectBindingKind::Chart, &a, "/spec/xAxis/min", "=Data!A1");
    let on_b2 = wb.bind(ObjectBindingKind::Chart, &b, "/spec/xAxis/min", "=Inputs!B2");
    let on_range = wb.bind(ObjectBindingKind::Chart, &c, "/spec/xAxis/min", "=SUM(Data!D1:D3)");
    wb.reevaluate(Scope::All);
    assert_eq!((wb.value(&on_a1), wb.value(&on_b2), wb.value(&on_range)), (json!(1.0), json!(10.0), json!(3.0)));

    // Both cells move, but the scope names only Data!A1.
    wb.set(DATA, 0, 0, Cell::new_number(2.0));
    wb.set(INPUTS, 1, 1, Cell::new_number(20.0));
    let changed = wb.reevaluate(Scope::Cells(vec![(wb.ids[DATA], 0, 0)]));
    let keys: Vec<String> = changed.iter().map(|r| r.object.id.clone()).collect();
    assert_eq!(keys, vec![a.clone()], "only the binding that reads Data!A1 is re-evaluated");
    assert_eq!(wb.value(&on_b2), json!(10.0), "Inputs!B2 was not in scope: its value is untouched");

    // A cell inside a range reaches the binding that reads the range.
    wb.set(DATA, 1, 3, Cell::new_number(5.0));
    let changed = wb.reevaluate(Scope::Cells(vec![(wb.ids[DATA], 1, 3)]));
    assert_eq!(changed.iter().map(|r| r.object.id.clone()).collect::<Vec<_>>(), vec![c.clone()]);
    assert_eq!(wb.value(&on_range), json!(7.0));

    // A cell nothing reads reaches nothing.
    assert!(wb.reevaluate(Scope::Cells(vec![(wb.ids[INPUTS], 40, 40)])).is_empty());
}

#[test]
fn an_all_sheets_wildcard_binding_follows_a_change_on_any_sheet() {
    let wb = Wb::new();
    wb.set(DATA, 0, 0, Cell::new_number(1.0));
    wb.set(INPUTS, 0, 0, Cell::new_number(10.0));
    let chart = wb.chart(DATA, json!({}));
    let key = wb.bind(ObjectBindingKind::Chart, &chart, "/spec/xAxis/max", "=SUM('*'!A1)");
    wb.reevaluate(Scope::All);
    assert_eq!(wb.value(&key), json!(11.0), "the wildcard reads A1 of every sheet");

    // A cell change on a sheet the text never names still reaches it: its
    // edges cover every sheet, so it is never frozen at its first value.
    wb.set(INPUTS, 0, 0, Cell::new_number(20.0));
    let changed = wb.reevaluate(Scope::Cells(vec![(wb.ids[INPUTS], 0, 0)]));
    assert_eq!(changed.len(), 1, "Inputs!A1 is read through the wildcard");
    assert_eq!(wb.value(&key), json!(21.0));
}

#[test]
fn a_cross_sheet_dependency_survives_a_rename_of_case() {
    let wb = Wb::new();
    wb.set(INPUTS, 0, 0, Cell::new_number(1.0));
    let chart = wb.chart(DATA, json!({}));
    let key = wb.bind(ObjectBindingKind::Chart, &chart, "/spec/yAxis/max", "=Inputs!A1");
    wb.reevaluate(Scope::All);
    assert_eq!(wb.value(&key), json!(1.0));

    wb.state.sheet_names.write(&test_seed_effect()).unwrap()[INPUTS] = "INPUTS".to_string();
    wb.set(INPUTS, 0, 0, Cell::new_number(2.0));
    let changed = wb.reevaluate(Scope::Cells(vec![(wb.ids[INPUTS], 0, 0)]));
    assert_eq!(changed.len(), 1, "the edge is keyed by the SheetId, not by the spelling");
    assert_eq!(wb.value(&key), json!(2.0));
}

#[test]
fn an_active_sheet_edit_is_read_through_the_live_mirror() {
    let wb = Wb::new();
    wb.set(DATA, 0, 0, Cell::new_number(1.0));
    let chart = wb.chart(DATA, json!({}));
    let key = wb.bind(ObjectBindingKind::Chart, &chart, "/spec/xAxis/max", "=Data!A1");
    wb.reevaluate(Scope::All);

    // Edit ONLY the mirror: `grids[active]` is stale while the sheet is active.
    wb.state.grid.write(&test_seed_effect()).unwrap().set_cell(0, 0, Cell::new_number(42.0));
    wb.reevaluate(Scope::Cells(vec![(wb.ids[DATA], 0, 0)]));
    assert_eq!(wb.value(&key), json!(42.0), "the stale grids slot would have answered 1");
}

#[test]
fn a_generation_bump_makes_the_next_reevaluate_rebuild() {
    let wb = Wb::new();
    wb.set(DATA, 0, 0, text("first"));
    wb.set(DATA, 1, 0, text("second"));
    let chart = wb.chart(DATA, json!({}));
    let key = wb.bind(ObjectBindingKind::Chart, &chart, "/spec/title", "=Data!A1");
    wb.reevaluate(Scope::All);
    assert_eq!(wb.value(&key), json!("first"));

    // Rewrite the row WITHOUT a bump: the runtime is still "current" and keeps
    // the formula it prepared. (Every real writer bumps -- this is the teeth.)
    let seed = test_seed_effect();
    wb.state.object_bindings.write(&seed).unwrap().bindings.get_mut(&key).unwrap().formula = "=Data!A2".to_string();
    wb.reevaluate(Scope::All);
    assert_eq!(wb.value(&key), json!("first"), "no bump, no rebuild");

    wb.state.object_bindings.write(&seed).unwrap().bump_generation();
    wb.reevaluate(Scope::All);
    assert_eq!(wb.value(&key), json!("second"), "the bump makes the next reevaluate prepare the new formula");
}

#[test]
fn a_canvas_chart_reads_an_unqualified_ref_on_its_data_sheet() {
    let wb = Wb::new();
    wb.set(INPUTS, 0, 0, text("from Inputs"));
    wb.set(DATA, 0, 0, text("from Data"));
    let chart = wb.chart(REPORT, json!({ "data": "Inputs!A1:B5" }));
    // A hand-written stored row with an unqualified ref (Set always qualifies).
    let key = wb.bind(ObjectBindingKind::Chart, &chart, "/spec/title", "=A1");
    wb.reevaluate(Scope::All);
    assert_eq!(wb.value(&key), json!("from Inputs"));
    let prepared = wb.state.object_binding_runtime.lock().unwrap().prepared.get(&key).cloned().unwrap();
    assert_eq!(prepared.cells, vec![(wb.ids[INPUTS], 0, 0)], "the dependency is on the data sheet");
}

#[test]
fn a_canvas_page_colour_binding_is_coerced() {
    let wb = Wb::new();
    wb.set(INPUTS, 0, 2, text("#FF0000"));
    let page = wb.ids[REPORT].to_string();
    let key = wb.bind(ObjectBindingKind::CanvasPage, &page, "/background", "=Inputs!C1");
    wb.reevaluate(Scope::All);
    assert_eq!(wb.value(&key), json!("#FF0000"));

    wb.set(INPUTS, 0, 2, text("red"));
    wb.reevaluate(Scope::All);
    let r = wb.resolved(&key).unwrap();
    assert_eq!(r.value, Value::Null);
    assert!(r.error.unwrap().contains("not a colour"));
}

#[test]
fn the_display_of_a_single_cell_uses_the_cells_number_format() {
    let wb = Wb::new();
    // Pinned: `create_app_state` starts on the MACHINE's regional format, and
    // a computed binding's display is General in the app locale (P2 S5) --
    // "0,5" on a Swedish machine. This test is about single cell vs computed.
    *wb.state.locale.lock().unwrap() = engine::LocaleSettings::invariant();
    let percent = wb
        .state
        .style_registry
        .write(&test_seed_effect())
        .unwrap()
        .get_or_create(CellStyle::new().with_number_format(NumberFormat::Percentage { decimal_places: 0 }));
    let mut cell = Cell::new_number(0.5);
    cell.style_index = percent;
    wb.set(DATA, 0, 0, cell);
    let chart = wb.chart(DATA, json!({}));
    let title = wb.bind(ObjectBindingKind::Chart, &chart, "/spec/title", "=Data!A1");
    let min = wb.bind(ObjectBindingKind::Chart, &chart, "/spec/xAxis/min", "=Data!A1");
    let sum = wb.bind(ObjectBindingKind::Chart, &chart, "/spec/yAxis/title", "=Data!A1+0");
    wb.reevaluate(Scope::All);

    assert_eq!(wb.value(&title), json!("50%"), "a linked title shows the cell as the grid does");
    let r = wb.resolved(&min).unwrap();
    assert_eq!((r.value, r.display.as_str()), (json!(0.5), "50%"), "a number keeps its value, shows the format");
    assert_eq!(wb.value(&sum), json!("0.5"), "a computed formula is not one cell: plain display");
}

#[test]
fn a_bound_text_is_capped() {
    let wb = Wb::new();
    let chart = wb.chart(DATA, json!({}));
    let key = wb.bind(ObjectBindingKind::Chart, &chart, "/spec/title", r#"=REPT("x",2000)"#);
    wb.reevaluate(Scope::All);
    let v = wb.value(&key);
    assert_eq!(v.as_str().map(|s| s.chars().count()), Some(MAX_RESOLVED_TEXT_CHARS));
}

#[test]
fn a_defined_name_is_a_dependency_and_repointing_it_rebuilds_the_edges() {
    let wb = Wb::new();
    let seed = test_seed_effect();
    let name = |refers_to: &str| crate::named_ranges::NamedRange {
        name: "Rate".to_string(),
        sheet_index: None,
        refers_to: refers_to.to_string(),
        comment: None,
        folder: None,
    };
    wb.state.named_ranges.write(&seed).unwrap().insert("RATE".to_string(), name("=Inputs!$A$1"));
    wb.set(INPUTS, 0, 0, Cell::new_number(2.0));
    wb.set(INPUTS, 1, 0, Cell::new_number(3.0));
    let chart = wb.chart(DATA, json!({}));
    let key = wb.bind(ObjectBindingKind::Chart, &chart, "/spec/xAxis/max", "=Rate*10");
    wb.reevaluate(Scope::All);
    assert_eq!(wb.value(&key), json!(20.0));

    // The name's cell is an edge of the binding.
    wb.set(INPUTS, 0, 0, Cell::new_number(4.0));
    assert_eq!(wb.reevaluate(Scope::Cells(vec![(wb.ids[INPUTS], 0, 0)])).len(), 1);
    assert_eq!(wb.value(&key), json!(40.0));

    // Repoint the name: a Names scope re-evaluates AND moves the edge.
    wb.state.named_ranges.write(&seed).unwrap().insert("RATE".to_string(), name("=Inputs!$A$2"));
    wb.reevaluate(Scope::Names(vec!["rate".to_string()]));
    assert_eq!(wb.value(&key), json!(30.0));
    wb.set(INPUTS, 1, 0, Cell::new_number(5.0));
    assert_eq!(wb.reevaluate(Scope::Cells(vec![(wb.ids[INPUTS], 1, 0)])).len(), 1, "the edge followed the name");
    assert_eq!(wb.value(&key), json!(50.0));
}

#[test]
fn a_measure_ref_with_nothing_fetched_is_pending_never_a_number() {
    let wb = Wb::new();
    let chart = wb.chart(REPORT, json!({}));
    let key = wb.bind_model(ObjectBindingKind::Chart, &chart, "/spec/title", "=[Revenue]", Some("m1"));
    wb.reevaluate(Scope::All);
    let r = wb.resolved(&key).unwrap();
    assert!(r.pending, "until the measure pass (S4) fills the cache the value is pending");
    assert_eq!((r.value, r.error), (Value::Null, None));
}

#[test]
fn a_binding_that_cannot_evaluate_says_why_and_an_orphan_has_no_value() {
    let wb = Wb::new();
    let chart = wb.chart(DATA, json!({}));
    let off_catalog = wb.bind(ObjectBindingKind::Chart, &chart, "/spec/notBindable", "=1");
    let gone_sheet = wb.bind(ObjectBindingKind::Chart, &chart, "/spec/title", "=Deleted!A1");
    let orphan = wb.bind(ObjectBindingKind::Chart, "no-such-chart", "/spec/title", "=1");
    wb.reevaluate(Scope::All);
    let r = wb.resolved(&off_catalog).unwrap();
    assert!(r.error.unwrap().contains("not a bindable property"));
    let r = wb.resolved(&gone_sheet).unwrap();
    assert!(r.error.unwrap().contains("no sheet named"));
    assert!(wb.resolved(&orphan).is_none(), "an object that does not exist paints nothing");

    // A value that existed is dropped when its object goes.
    wb.state.charts.write(&test_seed_effect()).unwrap().clear();
    wb.reevaluate(Scope::All);
    assert!(wb.resolved(&off_catalog).is_none() && wb.resolved(&gone_sheet).is_none());
}

#[test]
fn keys_and_pages_scopes_select_exactly_their_bindings() {
    let wb = Wb::new();
    wb.set(DATA, 0, 0, Cell::new_number(1.0));
    let on_data = wb.chart(DATA, json!({}));
    let on_report = wb.chart(REPORT, json!({}));
    let k1 = wb.bind(ObjectBindingKind::Chart, &on_data, "/spec/xAxis/min", "=Data!A1");
    let k2 = wb.bind(ObjectBindingKind::Chart, &on_report, "/spec/xAxis/min", "=Data!A1");
    wb.reevaluate(Scope::All);
    wb.set(DATA, 0, 0, Cell::new_number(9.0));

    let changed = wb.reevaluate(Scope::Pages(vec![wb.ids[REPORT]]));
    assert_eq!(changed.iter().map(|r| r.object.id.clone()).collect::<Vec<_>>(), vec![on_report.clone()]);
    assert_eq!(wb.value(&k1), json!(1.0));
    let changed = wb.reevaluate(Scope::Keys(vec![k1.clone()]));
    assert_eq!(changed.len(), 1);
    assert_eq!((wb.value(&k1), wb.value(&k2)), (json!(9.0), json!(9.0)));
}

// ---------------------------------------------------------------------------
// Coercion (D §3.7 step 5)
// ---------------------------------------------------------------------------

#[test]
fn coercion_table_per_type() {
    use BindableValueType as T;
    let n = |v: f64| CellValue::Number(v);
    let t = |s: &str| CellValue::Text(s.to_string());
    let c = |ty: T, v: CellValue| coerce(ty, &v, &crate::format_cell_value_simple(&v), None);

    assert_eq!(c(T::Number, n(2.5)).value, json!(2.5));
    assert_eq!(c(T::Number, t(" 12 ")).value, json!(12.0));
    assert_eq!(c(T::Number, CellValue::Boolean(true)).value, json!(1.0));
    assert!(c(T::Number, t("abc")).error.unwrap().contains("not a number"));

    assert_eq!(c(T::Integer, n(2.5)).value, json!(3), "half away from zero");
    assert_eq!(c(T::Integer, n(-2.5)).value, json!(-3));
    assert_eq!(c(T::Integer, n(2.4)).value, json!(2));

    assert_eq!(c(T::Boolean, CellValue::Boolean(false)).value, json!(false));
    assert_eq!(c(T::Boolean, n(3.0)).value, json!(true), "non-zero is TRUE");
    assert_eq!(c(T::Boolean, n(0.0)).value, json!(false));
    assert_eq!(c(T::Boolean, t("True")).value, json!(true));
    assert!(c(T::Boolean, t("yes")).error.is_some());

    for ok in ["#1F77B4", "#1f77b4cc", "rgb(10, 20, 30)", "rgba(10,20,30,0.5)"] {
        assert_eq!(c(T::Color, t(ok)).value, json!(ok), "{ok}");
    }
    for bad in ["red", "#12345", "rgb(300,0,0)", "rgba(1,2,3)", "rgba(1,2,3,2)"] {
        assert!(c(T::Color, t(bad)).error.is_some(), "{bad}");
    }
    assert!(c(T::Color, n(5.0)).error.is_some(), "a number is no colour");

    let units = T::Enum(&["auto", "none", "thousands"]);
    assert_eq!(c(units, t("THOUSANDS")).value, json!("thousands"), "case-insensitive, canonical spelling");
    assert!(c(units, t("lakhs")).error.unwrap().contains("auto, none, thousands"));

    assert_eq!(c(T::Scalar, n(4.0)).value, json!(4.0));
    assert_eq!(c(T::Scalar, t("x")).value, json!("x"));
    assert_eq!(c(T::Scalar, CellValue::Boolean(true)).value, json!(true));

    assert_eq!(c(T::Text, n(4.0)).value, json!("4"), "text is the display");

    let err = c(T::Number, CellValue::Error(engine::CellError::Ref));
    assert_eq!((err.value, err.display.as_str()), (Value::Null, "#REF!"));
    assert_eq!(err.error.as_deref(), Some("The formula returns #REF!."));
    let err = c(T::Text, CellValue::Error(engine::CellError::Div0));
    assert_eq!((err.value, err.display.as_str()), (Value::Null, "#DIV/0!"), "a text slot shows the error");
}

#[test]
fn media_must_already_exist_and_a_data_uri_is_refused() {
    let hash = "a".repeat(64);
    let handle = format!("media:{hash}");
    let present: HashSet<String> = [hash.clone()].into_iter().collect();
    let empty: HashSet<String> = HashSet::new();
    let t = CellValue::Text(handle.clone());

    let ok = coerce(BindableValueType::Media, &t, &handle, Some(&present));
    assert_eq!((ok.value, ok.error), (json!(handle.clone()), None));

    let missing = coerce(BindableValueType::Media, &t, &handle, Some(&empty));
    assert_eq!(missing.value, Value::Null);
    assert!(missing.error.unwrap().contains("names no media"));

    let uri = CellValue::Text("data:image/png;base64,AAAA".to_string());
    let refused = coerce(BindableValueType::Media, &uri, "", Some(&present));
    assert_eq!(refused.value, Value::Null);
    assert!(refused.error.unwrap().contains("data: URI is never accepted"));

    let junk = CellValue::Text("media:../../etc/passwd".to_string());
    assert!(coerce(BindableValueType::Media, &junk, "", Some(&present)).error.unwrap().contains("not a media handle"));
}

#[test]
fn a_text_value_is_capped_at_1024_characters() {
    let long = "y".repeat(5_000);
    let r = coerce(BindableValueType::Text, &CellValue::Text(long.clone()), &long, None);
    assert_eq!(r.value.as_str().unwrap().chars().count(), MAX_RESOLVED_TEXT_CHARS);
    assert_eq!(r.display.chars().count(), MAX_RESOLVED_TEXT_CHARS);
}

// ---------------------------------------------------------------------------
// The lock discipline (D §3.3)
// ---------------------------------------------------------------------------

/// Code only: the part of each line before a `//` that is not inside a string.
/// Shared with the S3b source censuses (`command_tests.rs`).
pub(super) fn strip_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        let mut in_str = false;
        let mut prev = '\0';
        let mut cut = line.len();
        for (i, ch) in line.char_indices() {
            if ch == '"' && prev != '\\' {
                in_str = !in_str;
            }
            if !in_str && ch == '/' && prev == '/' {
                cut = i - 1;
                break;
            }
            prev = ch;
        }
        out.push_str(&line[..cut]);
        out.push('\n');
    }
    out
}

/// Every function of `text` (free functions AND methods, by any start
/// spelling) as (name, body up to the next function start).
pub(super) fn functions(text: &str) -> Vec<(String, String)> {
    let code = strip_comments(text);
    let mut out: Vec<(String, String)> = Vec::new();
    for line in code.lines() {
        let trimmed = line.trim_start();
        let starts = crate::formula_serialisation_tests::FN_START_SPELLINGS
            .iter()
            .any(|p| trimmed.starts_with(p));
        if starts {
            let name = trimmed
                .split("fn ")
                .nth(1)
                .map(|r| r.split(['(', '<']).next().unwrap_or("").to_string())
                .unwrap_or_default();
            out.push((name, String::new()));
        }
        if let Some((_, body)) = out.last_mut() {
            body.push_str(line);
            body.push('\n');
        }
    }
    out
}

/// The leaf-rule violations of one function body: a canonical lock (or an
/// `.await`) AFTER the binding store or runtime was taken.
fn leaf_violations(body: &str) -> Vec<String> {
    let store = "object_bindings";
    let runtime = "object_binding_runtime";
    let acquisitions = [
        format!("{store}.read("),
        format!("{store}.write("),
        format!("{store}.lock_pending("),
        format!("{runtime}.lock("),
    ];
    let Some(first) = acquisitions.iter().filter_map(|n| body.find(n.as_str())).min() else {
        return Vec::new();
    };
    let after = &body[first..];
    let mut forbidden: Vec<String> = Vec::new();
    for field in ["grid", "grids", "sheet_names"] {
        for op in ["read(", "write(", "lock_pending("] {
            forbidden.push(format!(".{field}.{op}"));
        }
    }
    forbidden.push(".undo_stack.".to_string());
    forbidden.push(".await".to_string());
    forbidden.into_iter().filter(|n| after.contains(n.as_str())).collect()
}

fn binding_module_sources() -> Vec<(String, String)> {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("object_bindings");
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).expect("the object_bindings module directory").flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".rs") && !name.ends_with("_tests.rs") {
            out.push((name, std::fs::read_to_string(entry.path()).unwrap_or_default()));
        }
    }
    assert!(out.len() >= 5, "the scan found only {} module files", out.len());
    out
}

#[test]
fn binding_locks_are_leaves() {
    let mut offenders: Vec<String> = Vec::new();
    let mut holders = 0usize;
    let mut saw_pass = false;
    for (file, text) in binding_module_sources() {
        for (name, body) in functions(&text) {
            if !leaf_violations(&body).is_empty() {
                offenders.push(format!("{file}::{name} takes {:?} after the binding store/runtime", leaf_violations(&body)));
            }
            if body.contains("object_bindings.") || body.contains("object_binding_runtime.") {
                holders += 1;
            }
            if name == "evaluate_pass" {
                saw_pass = true;
                assert!(body.contains(".grid.read(") && body.contains(".grids.read("), "the pass no longer takes the grid locks -- re-derive this census");
                assert!(
                    !body.contains("object_bindings") && !body.contains("object_binding_runtime"),
                    "evaluate_pass holds the grid locks; it must never name the binding store or runtime"
                );
            }
        }
    }
    assert!(saw_pass, "evaluate_pass was not found -- the census is not reading eval.rs");
    assert!(holders >= 6, "only {holders} functions touch the store/runtime -- the scan is not seeing them");
    assert!(
        offenders.is_empty(),
        "the binding store and its runtime are LEAVES (D §3.3): nothing canonical may be locked after \
         them, and no .await may run while they are held.\n{}",
        offenders.join("\n")
    );
}

#[test]
fn the_leaf_detector_fires_on_a_planted_body() {
    let planted = "fn bad(state: &AppState) {\n    let s = state.object_bindings.read().unwrap();\n    let g = state.grid.read().unwrap();\n}\n";
    let found = functions(planted);
    assert_eq!(found.len(), 1);
    assert_eq!(leaf_violations(&found[0].1), vec![".grid.read(".to_string()]);
    let canonical = "fn good(state: &AppState) {\n    let g = state.grid.read().unwrap();\n    let s = state.object_bindings.read().unwrap();\n}\n";
    assert!(leaf_violations(&functions(canonical)[0].1).is_empty(), "grid THEN store is the canonical order");
    let commented = "fn quiet(state: &AppState) {\n    let s = state.object_binding_runtime.lock().unwrap();\n    // state.grids.read() is discussed here, not taken\n}\n";
    assert!(leaf_violations(&functions(commented)[0].1).is_empty(), "comments are prose, not acquisitions");
}

/// D risk 7: `reevaluate` (store -> runtime, then grid -> grids) running
/// against a writer that holds `grid` and `grids` and then takes the store --
/// the structural shift's legal shape (D §3.3 rule 2) -- on two threads, with a
/// deadline, so a deadlock is REPORTED rather than joined.
#[test]
fn reevaluate_and_a_grid_holding_store_writer_do_not_deadlock() {
    let wb = Wb::new();
    wb.set(DATA, 0, 0, Cell::new_number(1.0));
    let chart = wb.chart(DATA, json!({}));
    wb.bind(ObjectBindingKind::Chart, &chart, "/spec/xAxis/min", "=Data!A1");

    const ROUNDS: usize = 200;
    let writer_done = Arc::new(AtomicBool::new(false));
    let reader_rounds = Arc::new(AtomicUsize::new(0));

    let writer = {
        let state = Arc::clone(&wb.state);
        let done = Arc::clone(&writer_done);
        std::thread::spawn(move || {
            let seed = test_seed_effect();
            for i in 0..ROUNDS {
                let mut grid = state.grid.write(&seed).unwrap();
                let mut grids = state.grids.write(&seed).unwrap();
                grid.set_cell(0, 0, Cell::new_number(i as f64));
                grids[0].set_cell(0, 0, Cell::new_number(i as f64));
                {
                    let mut store = state.object_bindings.write(&seed).unwrap();
                    store.bump_generation();
                }
                drop(grids);
                drop(grid);
            }
            done.store(true, Ordering::SeqCst);
        })
    };
    let reader = {
        let state = Arc::clone(&wb.state);
        let rounds = Arc::clone(&reader_rounds);
        std::thread::spawn(move || {
            let slicers = crate::slicer::SlicerState::new();
            let timelines = crate::timeline_slicer::TimelineSlicerState::new();
            let pivots = crate::pivot::types::PivotState::new();
            let pane = crate::pane_control::PaneControlState::new();
            let ribbon = crate::ribbon_filter::RibbonFilterState::new();
            let stores = ObjectStores { state: &state, slicers: &slicers, timelines: &timelines, pivots: &pivots };
            for _ in 0..ROUNDS {
                reevaluate(&stores, &pane, &ribbon, Scope::All);
                rounds.fetch_add(1, Ordering::SeqCst);
            }
        })
    };

    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline
        && !(writer_done.load(Ordering::SeqCst) && reader_rounds.load(Ordering::SeqCst) == ROUNDS)
    {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        writer_done.load(Ordering::SeqCst) && reader_rounds.load(Ordering::SeqCst) == ROUNDS,
        "DEADLOCK: after 60 s the writer finished={} and reevaluate ran {}/{} rounds",
        writer_done.load(Ordering::SeqCst),
        reader_rounds.load(Ordering::SeqCst),
        ROUNDS
    );
    writer.join().unwrap();
    reader.join().unwrap();
}

#[test]
fn reevaluate_with_no_bindings_does_nothing() {
    let wb = Wb::new();
    assert!(wb.reevaluate(Scope::All).is_empty());
    let runtime = wb.state.object_binding_runtime.lock().unwrap();
    assert!(runtime.built, "the empty store was still prepared (and is now current)");
    assert!(runtime.prepared.is_empty());
}
