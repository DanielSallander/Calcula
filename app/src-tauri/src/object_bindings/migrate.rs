//! FILENAME: app/src-tauri/src/object_bindings/migrate.rs
// PURPOSE: Turn the two OLD spellings of "this property follows a formula"
//          into bindings (D-BIND: one spelling per fact, D §3.13):
//            - a control property stored `{ valueType: "formula", value: "=..." }`
//            - a chart title / axis title / series name stored as the text
//              "=A1" (the `isCellReference` rule of the Charts extension).
// CONTEXT: Called by the load path (`persistence::open_file`) after controls,
//          charts and bindings are restored, under
//          `CleanReason::LoadingFromDisk` -- opening a file is not an edit. The
//          `.calp` materializer runs it over pulled controls (S6), with that
//          door's own effect. IDEMPOTENT: a second run finds nothing.
//
// CHARTS ONLY FROM A PRE-BINDINGS WRITER. A chart field starting with `=` is a
// LITERAL in a bindings-era document (`ChartTextFields`): the chart half runs
// only for a `.cala` below format v10 (or an `.xlsx`), never on a v10 file and
// never on a `.calp` pull -- a pull parses only the embedded-object chart shape,
// which no pre-bindings publisher wrote -- so a deliberate literal `"=B2"`
// title is never turned into a binding behind the user's back.
//
// WHAT IS NEVER TOUCHED. A CODE slot -- executable (`onSelect`, `macroRef`),
// the held compartment (`heldOnSelect`, `heldMacroRef`, `heldFrom`) or a
// button's action wiring (`action*`) -- stays BYTE-IDENTICAL, value type
// included: it is code or code wiring (held code carries its application's
// value type), and a migration that touched it would rewrite signed
// application code on every pull. `controls::is_code_slot` decides, from the
// constants, never a re-typed list.
//
// A control property that is not code is decided by the CATALOG
// (`catalog::match_path(Control, "/properties/<key>")`):
//   - accepted, formula-typed `=...`: a binding `{control uid, /properties/<key>,
//     the formula qualified with the control's OWN sheet}` -- the old
//     evaluator's rule (it evaluated against the control's sheet) -- and the
//     literal becomes `{static, ""}`;
//   - anything else (`name`, a script-declared key, a position, a value that
//     does not start with `=`): `{static, <the original text>}` -- never
//     blanked -- with one log line naming the control and the key.
// A formula that fails normalisation is kept as a binding of the ORIGINAL text;
// the evaluator reports why it cannot evaluate (never silently dropped).
//
// LOCKS: the copied formula world first (each lock released), then the control
// store, released; then the chart store, released; the binding store (a leaf)
// last, with nothing else held.

use std::collections::BTreeMap;

use engine::Expression;
use serde_json::Value;

use crate::api_types::{ObjectBindingKind, ObjectBindingRef};
use crate::document_effect::DocumentEffect;
use crate::AppState;

use super::catalog;
use super::formula::{self, FormulaContext, FormulaWorld};
use super::store::{BindingKey, StoredBinding};

/// What one migration run did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MigrationReport {
    /// Control properties that became bindings.
    pub control_bindings: usize,
    /// Formula-typed control properties that became STATIC text (not
    /// bindable, or not a formula).
    pub control_literals: usize,
    /// Controls that had no uid and were given one.
    pub uids_minted: usize,
    /// Chart text fields (`=A1` titles, axis titles, series names) that became
    /// bindings.
    pub chart_bindings: usize,
    /// Bindings NOT added because the store already held one at that path (the
    /// stored binding wins; the old spelling is still retired).
    pub kept_existing: usize,
}

impl MigrationReport {
    /// Did the run change anything?
    pub fn changed_anything(&self) -> bool {
        self.control_bindings + self.control_literals + self.uids_minted + self.chart_bindings > 0
    }
}

/// The chart text fields an `=A1` used to be read into (`resolveSpecReferences`
/// in the Charts extension): their pointers in the ChartDefinition ENVELOPE,
/// and the literal each takes once it is a binding.
const CHART_TITLE_POINTER: &str = "/spec/title";

/// Is `text` the old "this chart field reads a cell" spelling: `=` followed by
/// ONE cell reference (`=A3`, `=Sheet1!B5`, `='My Sheet'!C1`)? The Charts
/// extension's `isCellReference` rule; anything else was shown as typed.
pub fn is_cell_reference_text(text: &str) -> bool {
    let Some(rest) = text.strip_prefix('=') else { return false };
    if rest.trim().is_empty() {
        return false;
    }
    matches!(parser::parse(text.trim()), Ok(Expression::CellRef { .. }))
}

/// A formula context whose unqualified references read `default_sheet`.
fn context_for<'a>(world: &'a FormulaWorld, host: usize, default_sheet: usize) -> FormulaContext<'a> {
    FormulaContext {
        host_sheet_index: host,
        default_ref_sheet_index: default_sheet,
        default_ref_warning: None,
        sheet_names: &world.sheet_names,
        named_ranges: &world.named_ranges,
        tables: &world.tables,
        table_names: &world.table_names,
        model_measures: &[],
        default_model: None,
        locale: &world.locale,
    }
}

/// The stored text of a migrated formula: normalised (qualified, invariant,
/// canonical sheet case) when it can be, else the ORIGINAL text, so the
/// evaluator states why it cannot evaluate it.
fn stored_formula(original: &str, cx: &FormulaContext<'_>, what: &str) -> String {
    match formula::normalize(original, cx, None) {
        Ok(normalized) => normalized.text,
        Err(reason) => {
            crate::log_warn!(
                "BINDINGS",
                "migrating {}: the formula {:?} cannot be normalised ({}); it is kept as written",
                what,
                original,
                reason
            );
            original.trim().to_string()
        }
    }
}

/// How the chart text fields (title, axis titles, series names) of the
/// workbook being migrated are to be read.
///
/// Since bindings exist, a chart field that STARTS WITH `=` is plain TEXT: the
/// interactive editor turns a typed `=` into a binding, so a literal `"=B2"`
/// can only have been stored deliberately (a script `setLiteral`, an MCP
/// `set_object_property`) and paints exactly as typed. Re-reading it as the
/// old `=A1` spelling on the next open would silently turn the user's text
/// into a live binding nobody created. So the chart half of the migration runs
/// ONLY over charts a pre-bindings writer produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChartTextFields {
    /// Written before bindings existed: an `=A1` field is the old "reads a
    /// cell" spelling and becomes a binding.
    LegacyCellReferences,
    /// Written by a bindings-era writer: every field is a literal, never
    /// re-interpreted.
    Literals,
}

impl ChartTextFields {
    /// The reading for a `.cala` archive of `format_version`. Every writer that
    /// embeds the chart spec as a JSON object (format v10,
    /// `CHART_SPEC_OBJECT_MIN_FORMAT_VERSION`) stamps that version whenever ANY
    /// chart exists, so an archive below it that carries charts was written
    /// before bindings; an `.xlsx` import reports 0 and keeps the old rule.
    pub fn for_format_version(format_version: u32) -> ChartTextFields {
        if format_version < calcula_format::CHART_SPEC_OBJECT_MIN_FORMAT_VERSION {
            ChartTextFields::LegacyCellReferences
        } else {
            ChartTextFields::Literals
        }
    }
}

/// Migrate every old formula spelling of the workbook into bindings. See the
/// module header for the rules. `effect` is the caller's: `LoadingFromDisk` on
/// the load path. `chart_fields` says whether the charts' `=A1` text fields are
/// the old spelling (a pre-bindings file) or literals (see [`ChartTextFields`]);
/// the control half always runs -- a bindings-era writer can no longer produce
/// a formula-typed control property.
pub fn migrate_legacy_formulas(
    state: &AppState,
    effect: &DocumentEffect,
    chart_fields: ChartTextFields,
) -> MigrationReport {
    let world = FormulaWorld::read(state);
    let mut report = MigrationReport::default();
    let mut new_bindings: Vec<(BindingKey, StoredBinding)> = Vec::new();

    migrate_controls(state, effect, &world, &mut report, &mut new_bindings);
    if chart_fields == ChartTextFields::LegacyCellReferences {
        migrate_charts(state, effect, &world, &mut report, &mut new_bindings);
    }

    if !new_bindings.is_empty() {
        let mut added = 0usize;
        match state.object_bindings.write(effect) {
            Ok(mut store) => {
                for (key, binding) in new_bindings {
                    if store.bindings.contains_key(&key) {
                        report.kept_existing += 1;
                        continue;
                    }
                    store.bindings.insert(key, binding);
                    added += 1;
                }
                if added > 0 {
                    store.bump_generation();
                }
            }
            Err(e) => {
                crate::log_warn!("BINDINGS", "the binding store is unwritable; migrated bindings were lost: {}", e);
            }
        }
        if added > 0 {
            super::announce_reload();
        }
    }
    if report.changed_anything() {
        crate::log_info!(
            "BINDINGS",
            "migrated old formula properties: {} control binding(s), {} control literal(s), {} chart binding(s), {} uid(s) minted, {} kept existing",
            report.control_bindings,
            report.control_literals,
            report.chart_bindings,
            report.uids_minted,
            report.kept_existing
        );
    }
    report
}

/// Does this control need the migration (no uid, or a non-code property that
/// is not static)?
fn control_needs_migration(meta: &crate::controls::ControlMetadata) -> bool {
    meta.uid.is_empty()
        || meta
            .properties
            .iter()
            .any(|(k, p)| p.value_type != "static" && !crate::controls::is_code_slot(k))
}

/// Does any control of the workbook need the migration? Control store only,
/// released before returning.
fn any_control_needs_migration(state: &AppState) -> bool {
    match state.controls.read() {
        Ok(controls) => controls.values().any(control_needs_migration),
        Err(_) => false,
    }
}

fn migrate_controls(
    state: &AppState,
    effect: &DocumentEffect,
    world: &FormulaWorld,
    report: &mut MigrationReport,
    new_bindings: &mut Vec<(BindingKey, StoredBinding)>,
) {
    // Decided under a read guard released inside the helper, so a workbook
    // with nothing to migrate is never written at all.
    if !any_control_needs_migration(state) {
        return;
    }
    let Ok(mut controls) = state.controls.write(effect) else { return };
    let mut keys: Vec<crate::controls::ControlKey> =
        controls.iter().filter(|(_, m)| control_needs_migration(m)).map(|(k, _)| *k).collect();
    keys.sort_unstable();
    for key in keys {
        let (sheet, row, col) = key;
        if controls.get(&key).is_some_and(|m| m.uid.is_empty()) {
            let uid = crate::controls::assign_uid(&controls, key, "");
            if let Some(meta) = controls.get_mut(&key) {
                meta.uid = uid;
                report.uids_minted += 1;
            }
        }
        let Some(meta) = controls.get_mut(&key) else { continue };
        let uid = meta.uid.clone();
        let mut names: Vec<String> = meta
            .properties
            .iter()
            .filter(|(k, p)| p.value_type != "static" && !crate::controls::is_code_slot(k))
            .map(|(k, _)| k.clone())
            .collect();
        names.sort();
        for name in names {
            let Some(prop) = meta.properties.get_mut(&name) else { continue };
            let what = format!(
                "the {} at sheet {} r{}c{}, property '{}'",
                meta.control_type, sheet, row, col, name
            );
            let path = format!("/properties/{}", catalog::escape_segment(&name));
            let bindable = catalog::match_path(ObjectBindingKind::Control, &path).is_ok();
            let is_formula = prop.value_type == "formula" && prop.value.trim_start().starts_with('=');
            if bindable && is_formula {
                // The old evaluator read an unqualified reference on the
                // control's OWN sheet.
                let cx = context_for(world, sheet, sheet);
                let text = stored_formula(&prop.value, &cx, &what);
                new_bindings.push((
                    BindingKey { object: ObjectBindingRef { kind: ObjectBindingKind::Control, id: uid.clone() }, path },
                    StoredBinding { formula: text, model: None },
                ));
                prop.value_type = "static".to_string();
                prop.value = String::new();
                report.control_bindings += 1;
            } else {
                crate::log_info!(
                    "BINDINGS",
                    "{} was {}-typed and is not a bindable formula; it is kept as static text {:?}",
                    what,
                    prop.value_type,
                    prop.value
                );
                prop.value_type = "static".to_string();
                report.control_literals += 1;
            }
        }
    }
}

/// The sheet an unqualified `=A1` in a chart field reads: the chart's DATA
/// sheet (the `specReferenceSheet` rule), else the chart's own worksheet, else
/// -- a canvas chart whose data names no sheet -- the first visible worksheet.
fn chart_reference_sheet(world: &FormulaWorld, host: usize, spec_json: &str) -> usize {
    if let Some(data) = formula::chart_data_sheet(spec_json, &world.sheet_names, &world.sheet_ids) {
        if !world.sheet_kinds.get(data).is_some_and(|k| k.is_canvas()) {
            return data;
        }
    }
    formula::default_ref_sheet(host, None, &world.sheets()).map(|(i, _)| i).unwrap_or(host)
}

/// The `=A1` text fields of one chart definition envelope: (pointer, the
/// literal the field takes once it is a binding, the text).
fn chart_reference_fields(definition: &Value) -> Vec<(String, Value, String)> {
    let mut out: Vec<(String, Value, String)> = Vec::new();
    let Some(spec) = definition.get("spec").filter(|s| s.is_object()) else { return out };
    let mut field = |pointer: String, literal: Value| {
        if let Some(text) = definition.pointer(&pointer).and_then(Value::as_str) {
            if is_cell_reference_text(text) {
                out.push((pointer, literal, text.to_string()));
            }
        }
    };
    field(CHART_TITLE_POINTER.to_string(), Value::Null);
    field("/spec/xAxis/title".to_string(), Value::String(String::new()));
    field("/spec/yAxis/title".to_string(), Value::String(String::new()));
    let series = spec.get("series").and_then(Value::as_array).map_or(0, Vec::len);
    for i in 0..series {
        field(format!("/spec/series/{i}/name"), Value::String(String::new()));
    }
    out
}

fn migrate_charts(
    state: &AppState,
    effect: &DocumentEffect,
    world: &FormulaWorld,
    report: &mut MigrationReport,
    new_bindings: &mut Vec<(BindingKey, StoredBinding)>,
) {
    // Decide from a copy; write only the charts that change.
    let entries: Vec<crate::api_types::ChartEntry> = match state.charts.read() {
        Ok(charts) => charts.clone(),
        Err(_) => return,
    };
    let mut rewritten: BTreeMap<String, String> = BTreeMap::new();
    for entry in &entries {
        let Ok(mut definition) = serde_json::from_str::<Value>(&entry.spec_json) else { continue };
        let fields = chart_reference_fields(&definition);
        if fields.is_empty() {
            continue;
        }
        let default_sheet = chart_reference_sheet(world, entry.sheet_index, &entry.spec_json);
        let cx = context_for(world, entry.sheet_index, default_sheet);
        let id = entry.id.to_string();
        for (pointer, literal, text) in fields {
            let what = format!("chart {} field {}", id, pointer);
            let stored = stored_formula(&text, &cx, &what);
            if let Some(slot) = definition.pointer_mut(&pointer) {
                *slot = literal;
            }
            new_bindings.push((
                BindingKey { object: ObjectBindingRef { kind: ObjectBindingKind::Chart, id: id.clone() }, path: pointer },
                StoredBinding { formula: stored, model: None },
            ));
            report.chart_bindings += 1;
        }
        rewritten.insert(id, definition.to_string());
    }
    if rewritten.is_empty() {
        return;
    }
    if let Ok(mut charts) = state.charts.write(effect) {
        for chart in charts.iter_mut() {
            if let Some(text) = rewritten.remove(&chart.id.to_string()) {
                chart.spec_json = text;
            }
        }
    }
}
