//! FILENAME: app/src-tauri/src/object_bindings/mod.rs
// PURPOSE: Object property BINDINGS (D-BIND, WP-D): one workbook store of
//          overlay rows `{object:{kind,id}, path, formula, model?}` that make a
//          property of a chart / control / slicer / timeline / canvas page follow
//          a formula. Rust owns the store, the bindable-path catalog, the object
//          JSON the paths point into, evaluation and validation.
// CONTEXT: A LITERAL stays in the object's own record (typed). A BINDING is an
//          overlay row here, persisted as `bindings.json` (.cala v10). Resolved
//          values are TRANSIENT: never saved, never undone, never dirty.
//
// LOCK ORDER (also on the two AppState fields). The binding store and its
// runtime are LEAVES below every canonical workbook lock:
//
//   grid -> grids -> (other canonical locks) -> undo_stack
//        -> object_bindings (store) -> object_binding_runtime
//
// While holding the store or the runtime, NOTHING else is acquired except the
// runtime under the store: no grid/grids/sheet_names/undo_stack/family-store
// lock, no `.await`. Anyone may take the store (then optionally the runtime)
// while holding a canonical lock -- that is what the structural shift does.
// Family stores (charts, controls, slicers, timelines, pivots, floating
// ranges, sheet kinds) are read and RELEASED before the store is taken
// (`object_json::locate`, `object_json::live_object_refs`).

pub mod audit;
pub mod carriage;
pub mod cascade;
pub mod catalog;
pub mod container_literal;
pub mod eval;
pub mod formula;
pub mod literal;
pub mod measures;
pub mod migrate;
pub mod object_json;
pub mod page_overrides;
pub mod store;
pub mod trace;

#[cfg(test)]
mod carriage_tests;
#[cfg(test)]
mod cascade_tests;
#[cfg(test)]
mod catalog_tests;
#[cfg(test)]
mod container_literal_tests;
#[cfg(test)]
mod command_tests;
#[cfg(test)]
mod eval_tests;
#[cfg(test)]
mod formula_tests;
#[cfg(test)]
mod measures_tests;
#[cfg(test)]
mod migrate_tests;
#[cfg(test)]
mod object_json_tests;
#[cfg(test)]
mod page_overrides_tests;
#[cfg(test)]
mod store_tests;

use std::sync::OnceLock;

use crate::api_types::{
    BindingEditSource, BindingFormulaAnalysis, BindingModelMeasures, ChangedCellRef, ObjectBindingInfo,
    ObjectBindingKind, ObjectBindingRef, ObjectBindingsChangedPayload, ObjectBindingsRequest,
    ObjectBindingsResponse, PageFilterPageWire, ResolvedBinding,
};
use crate::document_effect::DocumentEffect;
use crate::persistence::FileState;
use crate::AppState;

use formula::{FormulaWorld, NormalizedFormula};
use object_json::{ObjectLocation, ObjectStores};
use store::{BindingKey, StoredBinding};

/// The ONE Tauri event the binding surface emits. The TS mirror is
/// `BACKEND_OBJECT_BINDINGS_EVENT` in `app/src/api/objectBindings/bridge.ts`.
pub const OBJECT_BINDINGS_CHANGED_EVENT: &str = "object-bindings:changed";

/// The app handle used to announce binding changes. Installed once from
/// `run()`; absent in unit tests, where announcing is a no-op (the
/// `document_effect::DIRTY_ANNOUNCER` precedent).
static BINDINGS_ANNOUNCER: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Install the handle [`announce`] emits through. Called once from `run()`,
/// beside `document_effect::install_dirty_announcer`.
pub fn install_bindings_announcer(app: tauri::AppHandle) {
    let _ = BINDINGS_ANNOUNCER.set(app);
}

/// Emit [`OBJECT_BINDINGS_CHANGED_EVENT`] to every window. Takes NO AppState
/// lock (it is an `emit` on the stored handle), so it is legal under any guard.
/// No-op before the handle is installed.
pub(crate) fn announce(payload: ObjectBindingsChangedPayload) {
    if let Some(app) = BINDINGS_ANNOUNCER.get() {
        use tauri::Emitter;
        let _ = app.emit(OBJECT_BINDINGS_CHANGED_EVENT, payload);
    }
}

/// Announce that the binding SET changed (load, create, clear, undo, cascade,
/// rename): the frontend seam re-lists and re-resolves.
pub(crate) fn announce_reload() {
    announce(ObjectBindingsChangedPayload { values: Vec::new(), reload: true });
}

impl ObjectBindingKind {
    /// Every kind, in declaration order.
    pub const ALL: [ObjectBindingKind; 7] = [
        ObjectBindingKind::Chart,
        ObjectBindingKind::Control,
        ObjectBindingKind::Slicer,
        ObjectBindingKind::TimelineSlicer,
        ObjectBindingKind::Pivot,
        ObjectBindingKind::FloatingRange,
        ObjectBindingKind::CanvasPage,
    ];

    /// The wire / on-disk name (`SavedObjectRef::kind`). Equal to the serde
    /// spelling, which `kind_wire_names_match_serde` pins.
    pub fn wire_name(self) -> &'static str {
        match self {
            ObjectBindingKind::Chart => "chart",
            ObjectBindingKind::Control => "control",
            ObjectBindingKind::Slicer => "slicer",
            ObjectBindingKind::TimelineSlicer => "timelineSlicer",
            ObjectBindingKind::Pivot => "pivot",
            ObjectBindingKind::FloatingRange => "floatingRange",
            ObjectBindingKind::CanvasPage => "canvasPage",
        }
    }

    /// Parse a wire / on-disk name; `None` for a name this build does not know.
    pub fn from_wire(name: &str) -> Option<ObjectBindingKind> {
        ObjectBindingKind::ALL.into_iter().find(|k| k.wire_name() == name)
    }

    /// How a sentence names this kind ("a chart", "a canvas page").
    pub fn label(self) -> &'static str {
        match self {
            ObjectBindingKind::Chart => "chart",
            ObjectBindingKind::Control => "control",
            ObjectBindingKind::Slicer => "slicer",
            ObjectBindingKind::TimelineSlicer => "timeline slicer",
            ObjectBindingKind::Pivot => "PivotTable",
            ObjectBindingKind::FloatingRange => "floating range",
            ObjectBindingKind::CanvasPage => "canvas page",
        }
    }
}

// ===========================================================================
// THE COMMAND (D §3.9): one Tauri command, an op enum, so the whole binding
// surface costs ONE entry in `generate_handler!` (the 32 MB dispatch frame).
// ===========================================================================

/// The restricted-tier clamp's refusal. The first sentence mirrors
/// `RESTRICTED_SHEET_CLAMP_MESSAGE` in `app/src/api/scriptHost/host.ts`, the
/// executor that IS the gate (D §3.19); the Rust re-check that uses this is
/// defence in depth over a renderer-supplied label (D §3.9), never the boundary.
pub const RESTRICTED_BINDING_CLAMP_MESSAGE: &str = "Restricted scripts can only reach the sheet you are looking at; \
     naming another sheet requires unlocked access -- a restricted script may bind only to cells on the sheet \
     in front of the user.";

/// Everything an op reaches, borrowed. The unit tier builds one from plain
/// states; the command builds one from its `tauri::State`s.
pub struct BindingCx<'a> {
    pub state: &'a AppState,
    pub file_state: &'a FileState,
    pub slicers: &'a crate::slicer::SlicerState,
    pub timelines: &'a crate::timeline_slicer::TimelineSlicerState,
    pub pivots: &'a crate::pivot::types::PivotState,
    pub pane: &'a crate::pane_control::PaneControlState,
    pub ribbon: &'a crate::ribbon_filter::RibbonFilterState,
}

impl BindingCx<'_> {
    pub fn stores(&self) -> ObjectStores<'_> {
        ObjectStores { state: self.state, slicers: self.slicers, timelines: self.timelines, pivots: self.pivots }
    }

    pub fn literal_ctx(&self) -> literal::LiteralWriteCtx<'_> {
        literal::LiteralWriteCtx {
            state: self.state,
            file_state: self.file_state,
            slicers: self.slicers,
            timelines: self.timelines,
            pivots: self.pivots,
        }
    }
}

/// An op's answer plus the canvas-layout announcement a page literal write
/// owes (emitted by the command once every guard is dropped).
#[derive(Debug)]
pub struct Handled {
    pub response: ObjectBindingsResponse,
    pub layout: Option<crate::sheets::CanvasLayoutChanged>,
}

fn plain(response: ObjectBindingsResponse) -> Handled {
    Handled { response, layout: None }
}

/// THE binding command. Every op body is a `_core` over plain references
/// ([`handle_request`]); the async parts -- reading the models' measure lists
/// and running the measure pass, which wait on engine locks and queries --
/// run in [`handle_request_async`] with no std guard held across an `.await`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn object_bindings(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    file_state: tauri::State<'_, FileState>,
    bi_state: tauri::State<'_, crate::bi::types::BiState>,
    slicer_state: tauri::State<'_, crate::slicer::SlicerState>,
    timeline_state: tauri::State<'_, crate::timeline_slicer::TimelineSlicerState>,
    pivot_state: tauri::State<'_, crate::pivot::types::PivotState>,
    pane_control_state: tauri::State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: tauri::State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: ObjectBindingsRequest,
) -> Result<ObjectBindingsResponse, String> {
    let cx = BindingCx {
        state: state.inner(),
        file_state: file_state.inner(),
        slicers: slicer_state.inner(),
        timelines: timeline_state.inner(),
        pivots: pivot_state.inner(),
        pane: pane_control_state.inner(),
        ribbon: ribbon_filter_state.inner(),
    };
    // Boxed: the dispatcher nests the design-query path and then the
    // evaluator; its state lives on the heap, not in the worker's 2 MB stack.
    let handled = Box::pin(handle_request_async(&cx, bi_state.inner(), request)).await?;
    if let Some(layout) = handled.layout {
        use tauri::Emitter;
        let _ = app.emit(crate::sheets::CANVAS_LAYOUT_EVENT, layout);
    }
    Ok(handled.response)
}

/// Every connected model of the workbook and its measures, as a binding names
/// them: the model KEY is the stable one (a package connection's data-source
/// id, else the connection's own id -- never a session id). With exactly one
/// model it is the default. The PAGE-scoped list a binding is validated
/// against is [`measures::page_models`].
pub async fn workbook_models(bi: &crate::bi::types::BiState) -> Vec<BindingModelMeasures> {
    measures::workbook_models(bi).await
}

/// The models a binding on `object` may read: those its PAGE uses, else the
/// workbook's (D §3.6 rule 4). Empty for an object that does not exist (the op
/// then says so).
async fn models_for(
    cx: &BindingCx<'_>,
    bi: &crate::bi::types::BiState,
    object: &ObjectBindingRef,
) -> Vec<BindingModelMeasures> {
    let stores = cx.stores();
    match measures::sheet_index_of(&stores, object) {
        Some(sheet_index) => measures::page_models(&stores, bi, sheet_index).await,
        None => Vec::new(),
    }
}

/// Dispatch one request WITH the BI state: the ops that read model metadata or
/// measure values do their async work here, each step holding no std guard
/// across an `.await` (the leaf census reads this body too), then run the
/// same `_core` the synchronous [`handle_request`] runs.
///
/// - `Set`: the page's models validate the formula; when the stored formula
///   reads a measure or a CUBE function, the measure pass fetches what its page
///   is missing and the page is re-evaluated, so the answer carries the value
///   rather than `pending`.
/// - `SetPageFilters`: the mirror is replaced, the changed pages' measures are
///   re-read under their new filters, THEN those pages are re-evaluated.
/// - `RefreshMeasures`: every measure and CUBE call of the page (or of every
///   page) is re-read, then re-evaluated.
/// - `ResolveAll`: whatever is missing (a reload, an undo that brought a
///   binding back) is fetched first, so a reload never leaves a measure pending.
pub async fn handle_request_async(
    cx: &BindingCx<'_>,
    bi: &crate::bi::types::BiState,
    request: ObjectBindingsRequest,
) -> Result<Handled, String> {
    match request {
        ObjectBindingsRequest::Set { object, path, formula, model, invariant, source } => {
            let models = models_for(cx, bi, &object).await;
            let request = SetRequest {
                object,
                path,
                formula,
                model,
                invariant: invariant.unwrap_or(false),
                source: source.unwrap_or(BindingEditSource::User),
            };
            let binding = set_core(cx, &models, request)?;
            let binding = Box::pin(fetch_for_binding(cx, bi, binding)).await;
            Ok(plain(ObjectBindingsResponse::Binding { binding }))
        }
        ObjectBindingsRequest::Analyze { object, formula, invariant, model } => {
            let models = models_for(cx, bi, &object).await;
            analyze_core_with_model(cx, &models, &object, &formula, invariant.unwrap_or(false), model.as_deref())
                .map(|analysis| plain(ObjectBindingsResponse::Analysis { analysis }))
        }
        ObjectBindingsRequest::Measures { object } => {
            let models = models_for(cx, bi, &object).await;
            measures_core(cx, &models, &object).map(|models| plain(ObjectBindingsResponse::Measures { models }))
        }
        ObjectBindingsRequest::SetPageFilters { pages } => {
            Box::pin(set_page_filters_async(cx, bi, pages)).await;
            Ok(plain(ObjectBindingsResponse::Ack))
        }
        ObjectBindingsRequest::RefreshMeasures { sheet_index } => {
            Box::pin(refresh_measures_async(cx, bi, sheet_index)).await;
            Ok(plain(ObjectBindingsResponse::Ack))
        }
        ObjectBindingsRequest::ResolveAll => {
            Box::pin(measures::refresh_measures(&cx.stores(), bi, &measures::FetchScope::missing(None))).await;
            Ok(plain(ObjectBindingsResponse::Resolved { values: resolve_all_core(cx) }))
        }
        other => handle_request(cx, &[], other),
    }
}

/// After a `Set`: fetch what the binding's page is missing (its measures under
/// the page's current filters, its CUBE calls), re-evaluate the page if
/// anything arrived, and answer with the binding as it resolves NOW.
async fn fetch_for_binding(
    cx: &BindingCx<'_>,
    bi: &crate::bi::types::BiState,
    binding: ObjectBindingInfo,
) -> ObjectBindingInfo {
    let stores = cx.stores();
    let Some(page) = measures::page_of(&stores, &binding.object) else { return binding };
    if !Box::pin(measures::refresh_measures(&stores, bi, &measures::FetchScope::missing(Some(vec![page])))).await {
        return binding;
    }
    eval::reevaluate(&stores, cx.pane, cx.ribbon, eval::Scope::Pages(vec![page]));
    binding_info(cx.state, &binding_key(&binding.object, &binding.path)).unwrap_or(binding)
}

/// `SetPageFilters` with the measure pass between the mirror and the
/// re-evaluation (D §3.8): the changed pages' measures are re-read under their
/// new filters first, so a slicer click goes from the old value to the new one
/// (or to `pending` while the query runs), never to a stale number.
pub async fn set_page_filters_async(
    cx: &BindingCx<'_>,
    bi: &crate::bi::types::BiState,
    pages: Vec<PageFilterPageWire>,
) -> Vec<identity::SheetId> {
    let changed = measures::replace_page_filters(cx.state, pages);
    if changed.is_empty() {
        return changed;
    }
    let stores = cx.stores();
    Box::pin(measures::refresh_measures(&stores, bi, &measures::FetchScope::filters_changed(changed.clone()))).await;
    eval::reevaluate(&stores, cx.pane, cx.ribbon, eval::Scope::Pages(changed.clone()));
    changed
}

/// `RefreshMeasures`: re-read every measure and CUBE call of one page (`Some`)
/// or of every page, then re-evaluate them.
pub async fn refresh_measures_async(
    cx: &BindingCx<'_>,
    bi: &crate::bi::types::BiState,
    sheet_index: Option<usize>,
) {
    let stores = cx.stores();
    let pages = match sheet_index {
        None => None,
        Some(index) => match sheet_id_at(cx.state, index) {
            Some(id) => Some(vec![id]),
            None => return,
        },
    };
    Box::pin(measures::refresh_measures(&stores, bi, &measures::FetchScope::refresh(pages.clone()))).await;
    let scope = match pages {
        None => eval::Scope::All,
        Some(pages) => eval::Scope::Pages(pages),
    };
    eval::reevaluate(&stores, cx.pane, cx.ribbon, scope);
}

/// Dispatch one request WITHOUT the BI state (the unit tier; the command goes
/// through [`handle_request_async`]). `models` is the model list a
/// Set/Analyze/Measures validates against. With no BI state the measure pass
/// cannot run: `SetPageFilters` / `RefreshMeasures` maintain the mirror and
/// re-evaluate from what the runtime already holds.
pub fn handle_request(
    cx: &BindingCx<'_>,
    models: &[BindingModelMeasures],
    request: ObjectBindingsRequest,
) -> Result<Handled, String> {
    match request {
        ObjectBindingsRequest::List { object } => {
            Ok(plain(ObjectBindingsResponse::Bindings { bindings: list_core(cx, object.as_ref()) }))
        }
        ObjectBindingsRequest::Set { object, path, formula, model, invariant, source } => {
            let request = SetRequest {
                object,
                path,
                formula,
                model,
                invariant: invariant.unwrap_or(false),
                source: source.unwrap_or(BindingEditSource::User),
            };
            set_core(cx, models, request).map(|binding| plain(ObjectBindingsResponse::Binding { binding }))
        }
        ObjectBindingsRequest::Clear { object, path, source } => {
            let source = source.unwrap_or(BindingEditSource::User);
            clear_core(cx, &object, &path, &source).map(|removed| plain(ObjectBindingsResponse::Cleared { removed }))
        }
        ObjectBindingsRequest::SetLiteral { object, path, value, source } => {
            let source = source.unwrap_or(BindingEditSource::User);
            set_literal_core(cx, &object, &path, value, &source)
        }
        ObjectBindingsRequest::ResolveAll => Ok(plain(ObjectBindingsResponse::Resolved { values: resolve_all_core(cx) })),
        ObjectBindingsRequest::CellsChanged { cells } => {
            Ok(plain(ObjectBindingsResponse::Resolved { values: cells_changed_core(cx, cells) }))
        }
        ObjectBindingsRequest::SetPageFilters { pages } => {
            set_page_filters_core(cx, pages);
            Ok(plain(ObjectBindingsResponse::Ack))
        }
        ObjectBindingsRequest::RefreshMeasures { sheet_index } => {
            refresh_measures_core(cx, sheet_index);
            Ok(plain(ObjectBindingsResponse::Ack))
        }
        ObjectBindingsRequest::Analyze { object, formula, invariant, model } => {
            analyze_core_with_model(cx, models, &object, &formula, invariant.unwrap_or(false), model.as_deref())
                .map(|analysis| plain(ObjectBindingsResponse::Analysis { analysis }))
        }
        ObjectBindingsRequest::ObjectJson { object } => object_json::object_json(&cx.stores(), &object)
            .map(|json| plain(ObjectBindingsResponse::ObjectJson { json })),
        ObjectBindingsRequest::Measures { object } => {
            measures_core(cx, models, &object).map(|models| plain(ObjectBindingsResponse::Measures { models }))
        }
        ObjectBindingsRequest::Locate { objects } => {
            Ok(plain(ObjectBindingsResponse::Located { places: locate_core(cx, &objects) }))
        }
    }
}

/// Where each of `objects` is (sheet, name), in the order asked; an object
/// that does not exist is left out. One walk of the stores, each released.
pub fn locate_core(cx: &BindingCx<'_>, objects: &[ObjectBindingRef]) -> Vec<crate::api_types::ObjectBindingPlace> {
    let all: std::collections::HashMap<ObjectBindingRef, ObjectLocation> =
        object_json::object_locations(&cx.stores()).into_iter().collect();
    objects
        .iter()
        .filter_map(|object| {
            all.get(object).map(|loc| crate::api_types::ObjectBindingPlace {
                object: object.clone(),
                name: loc.name.clone(),
                sheet_index: loc.sheet_index,
                sheet_name: loc.sheet_name.clone(),
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

fn not_found(object: &ObjectBindingRef) -> String {
    format!("There is no {} with id '{}' in this workbook.", object.kind.label(), object.id)
}

fn binding_key(object: &ObjectBindingRef, path: &str) -> BindingKey {
    BindingKey { object: object.clone(), path: path.to_string() }
}

/// The id of the sheet at `index`, if there is one. Sheet table only.
fn sheet_id_at(state: &AppState, index: usize) -> Option<identity::SheetId> {
    state.sheet_ids.read().ok().and_then(|ids| ids.get(index).copied())
}

/// The stored binding `key` as the frontend sees it, with its current resolved
/// value. Store (released), then the runtime.
fn binding_info(state: &AppState, key: &BindingKey) -> Option<ObjectBindingInfo> {
    let stored = state.object_bindings.read().ok()?.bindings.get(key).cloned()?;
    Some(info_for(state, key, &stored, &workbook_locale(state)))
}

fn workbook_locale(state: &AppState) -> engine::LocaleSettings {
    state
        .locale
        .lock()
        .map(|g| g.clone())
        .unwrap_or_else(|_| engine::LocaleSettings::invariant())
}

/// A binding on an object of a SUBSCRIBED sheet would be overwritten by the
/// next refresh of the application that owns the sheet -- refused, naming the
/// application and the remedy (the `ensure_unsubscribed_sheet` sentence shape).
fn ensure_unsubscribed(state: &AppState, sheet_index: usize) -> Result<(), String> {
    let provenance = crate::sheets::SheetProvenance::snapshot(state)?;
    match provenance.origin(sheet_index) {
        None => Ok(()),
        Some(origin) => Err(format!(
            "Cannot bind a property of an object on sheet '{}': it came from the application '{}' and is \
             still connected to it. Detach it first (right-click the tab > Detach from '{}').",
            origin.sheet_name, origin.package_name, origin.package_name
        )),
    }
}

/// The definition text of chart `id` (the IPC `spec_json`), if it exists.
fn chart_definition(state: &AppState, id: &str) -> Option<String> {
    let charts = state.charts.read().ok()?;
    charts.iter().find(|c| c.id.to_string() == id).map(|c| c.spec_json.clone())
}

/// D §3.6: normalise `formula` for a binding on `object` at `location`.
#[allow(clippy::too_many_arguments)]
fn normalize_for(
    cx: &BindingCx<'_>,
    world: &FormulaWorld,
    models: &[BindingModelMeasures],
    object: &ObjectBindingRef,
    location: &ObjectLocation,
    formula: &str,
    invariant: bool,
    model: Option<&str>,
) -> Result<NormalizedFormula, String> {
    let chart_sheet = match object.kind {
        ObjectBindingKind::Chart => chart_definition(cx.state, &object.id)
            .and_then(|spec| formula::chart_data_sheet(&spec, &world.sheet_names, &world.sheet_ids)),
        _ => None,
    };
    let model_measures: Vec<(String, Vec<String>)> =
        models.iter().map(|m| (m.model_key.clone(), m.measures.clone())).collect();
    let default_model = models.iter().find(|m| m.is_default).map(|m| m.model_key.as_str());
    let fcx = world.context(location.sheet_index, chart_sheet, &model_measures, default_model)?;
    formula::normalize_entered(formula, invariant, &fcx, model)
}

/// The restricted-tier clamp, re-checked in Rust when a call is LABELLED as a
/// restricted script (D §3.9 -- defence in depth only: the label comes from the
/// renderer, so the TS executor is the gate). A restricted script may bind only
/// to cells of the sheet in front of the user, and reads no defined name, no
/// table and nothing indirect. Measure refs need `bi.query`, a grant only the
/// executor can see.
fn restricted_clamp(state: &AppState, analysis: &BindingFormulaAnalysis) -> Result<(), String> {
    let active = state.active_sheet.read().map(|g| *g).unwrap_or(0);
    let off_sheet = analysis.sheets.iter().any(|s| *s != active);
    if off_sheet || analysis.uses_names || analysis.uses_table_refs || analysis.uses_indirect {
        return Err(RESTRICTED_BINDING_CLAMP_MESSAGE.to_string());
    }
    Ok(())
}

/// One binding as the frontend, scripts and AI see it, with its current
/// resolved value from the runtime (runtime only).
fn info_for(
    state: &AppState,
    key: &BindingKey,
    stored: &StoredBinding,
    locale: &engine::LocaleSettings,
) -> ObjectBindingInfo {
    let resolved = state
        .object_binding_runtime
        .lock()
        .ok()
        .and_then(|runtime| runtime.resolved.get(key).cloned());
    ObjectBindingInfo {
        object: key.object.clone(),
        path: key.path.clone(),
        formula: stored.formula.clone(),
        display_formula: formula::display_formula(&stored.formula, locale),
        model: stored.model.clone(),
        resolved,
    }
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/// Every binding (of `object`, when given), sorted by (object, path), each with
/// its current resolved value. Rebuilds the runtime first if the store moved.
pub fn list_core(cx: &BindingCx<'_>, object: Option<&ObjectBindingRef>) -> Vec<ObjectBindingInfo> {
    eval::ensure_prepared(&cx.stores());
    let locale = workbook_locale(cx.state);
    let rows: Vec<(BindingKey, StoredBinding)> = match cx.state.object_bindings.read() {
        Ok(store) => store
            .bindings
            .iter()
            .filter(|(k, _)| object.map_or(true, |o| &k.object == o))
            .map(|(k, b)| (k.clone(), b.clone()))
            .collect(),
        Err(_) => Vec::new(),
    };
    rows.iter().map(|(key, stored)| info_for(cx.state, key, stored, &locale)).collect()
}

// ---------------------------------------------------------------------------
// Set
// ---------------------------------------------------------------------------

/// A `Set` request, defaults applied.
#[derive(Debug, Clone)]
pub struct SetRequest {
    pub object: ObjectBindingRef,
    pub path: String,
    pub formula: String,
    pub model: Option<String>,
    pub invariant: bool,
    pub source: BindingEditSource,
}

/// Bind `path` of `object` to `formula` (D §3.9). A script or AI source leaves
/// an audit row, accepted or refused.
pub fn set_core(
    cx: &BindingCx<'_>,
    models: &[BindingModelMeasures],
    request: SetRequest,
) -> Result<ObjectBindingInfo, String> {
    let result = set_inner(cx, models, &request);
    if request.source != BindingEditSource::User {
        let text = match &result {
            Ok(info) => info.formula.as_str(),
            Err(_) => request.formula.as_str(),
        };
        audit::record_binding_edit(
            cx.state,
            &request.source,
            audit::ACTION_BINDING_SET,
            &request.object,
            &request.path,
            text,
            result.as_ref().err().map(String::as_str),
        );
    }
    result
}

/// `Set`, in the D §3.9 order: every gate and the whole normalisation BEFORE
/// the store is taken; then, under ONE hold of the store, "changed?" decided
/// and only then the effect; the undo step recorded with the store DROPPED;
/// then the one re-evaluation entry point and the reload announcement.
fn set_inner(
    cx: &BindingCx<'_>,
    models: &[BindingModelMeasures],
    request: &SetRequest,
) -> Result<ObjectBindingInfo, String> {
    let row = catalog::match_path(request.object.kind, &request.path)?;
    let stores = cx.stores();
    let location = object_json::locate(&stores, &request.object).ok_or_else(|| not_found(&request.object))?;
    ensure_unsubscribed(cx.state, location.sheet_index)?;
    literal::check_literal_gates(cx.state, &request.object, row, &location)?;
    // A per-button navigator path binds a setting of a LIVE page of a Page
    // Navigator (D §3.18a); one whose page later goes away stays, dormant.
    page_overrides::check_binding_target(cx.state, &request.object, &request.path)?;
    let world = FormulaWorld::read(cx.state);
    let normalized = normalize_for(
        cx,
        &world,
        models,
        &request.object,
        &location,
        &request.formula,
        request.invariant,
        request.model.as_deref(),
    )?;
    if let BindingEditSource::Script { unlocked: false, .. } = &request.source {
        restricted_clamp(cx.state, &normalized.analysis)?;
    }

    let key = binding_key(&request.object, &request.path);
    let stored = StoredBinding { formula: normalized.text.clone(), model: normalized.analysis.model.clone() };
    let previous = {
        let pending = cx.state.object_bindings.lock_pending().map_err(|e| e.to_string())?;
        if pending.bindings.get(&key) == Some(&stored) {
            None
        } else {
            let effect = DocumentEffect::mutates(cx.file_state);
            let mut store = pending.authorize(&effect);
            let previous = store.snapshot();
            store.bindings.insert(key.clone(), stored.clone());
            store.bump_generation();
            Some(previous)
        }
    };
    let changed = previous.is_some();
    if let Some(previous) = previous {
        crate::undo_commands::record_bindings_undo(cx.state, previous, "Bind property");
    }
    eval::reevaluate(&stores, cx.pane, cx.ribbon, eval::Scope::Keys(vec![key.clone()]));
    if changed {
        announce_reload();
    }
    Ok(info_for(cx.state, &key, &stored, &world.locale))
}

// ---------------------------------------------------------------------------
// Clear
// ---------------------------------------------------------------------------

/// Remove the binding of `path` on `object`. `Ok(false)` when there was none
/// (nothing dirtied, no undo step).
pub fn clear_core(
    cx: &BindingCx<'_>,
    object: &ObjectBindingRef,
    path: &str,
    source: &BindingEditSource,
) -> Result<bool, String> {
    let result = clear_inner(cx, object, path);
    if *source != BindingEditSource::User {
        let text = match &result {
            Ok(Some(removed)) => removed.formula.clone(),
            _ => String::new(),
        };
        audit::record_binding_edit(
            cx.state,
            source,
            audit::ACTION_BINDING_CLEAR,
            object,
            path,
            &text,
            result.as_ref().err().map(String::as_str),
        );
    }
    result.map(|removed| removed.is_some())
}

fn clear_inner(cx: &BindingCx<'_>, object: &ObjectBindingRef, path: &str) -> Result<Option<StoredBinding>, String> {
    catalog::pointer_segments(path)?;
    let stores = cx.stores();
    // A LIVE object: removing a binding changes what is painted exactly as
    // setting one does, so the same gates apply. An ORPHAN (its object is gone)
    // skips them: there is nothing left to protect.
    if let Some(location) = object_json::locate(&stores, object) {
        ensure_unsubscribed(cx.state, location.sheet_index)?;
        if let Ok(row) = catalog::match_path(object.kind, path) {
            literal::check_literal_gates(cx.state, object, row, &location)?;
        }
    }
    let key = binding_key(object, path);
    let removed = {
        let pending = cx.state.object_bindings.lock_pending().map_err(|e| e.to_string())?;
        if !pending.bindings.contains_key(&key) {
            None
        } else {
            let effect = DocumentEffect::mutates(cx.file_state);
            let mut store = pending.authorize(&effect);
            let previous = store.snapshot();
            let removed = store.bindings.remove(&key);
            store.bump_generation();
            removed.map(|r| (previous, r))
        }
    };
    let Some((previous, removed)) = removed else {
        return Ok(None);
    };
    crate::undo_commands::record_bindings_undo(cx.state, previous, "Remove property binding");
    eval::reevaluate(&stores, cx.pane, cx.ribbon, eval::Scope::Keys(vec![key]));
    announce_reload();
    Ok(Some(removed))
}

// ---------------------------------------------------------------------------
// SetLiteral
// ---------------------------------------------------------------------------

/// Write the LITERAL of a catalog path through the family's own core
/// (`literal::write_literal`). A script or AI source leaves an audit row.
pub fn set_literal_core(
    cx: &BindingCx<'_>,
    object: &ObjectBindingRef,
    path: &str,
    value: serde_json::Value,
    source: &BindingEditSource,
) -> Result<Handled, String> {
    let shown = value.to_string();
    let result = literal::write_literal(&cx.literal_ctx(), object, path, value);
    if *source != BindingEditSource::User {
        audit::record_binding_edit(
            cx.state,
            source,
            audit::ACTION_LITERAL_SET,
            object,
            path,
            &shown,
            result.as_ref().err().map(String::as_str),
        );
    }
    Ok(match result? {
        literal::LiteralWriteOutcome::Written { domains, layout } => Handled {
            response: ObjectBindingsResponse::LiteralSet { domains: domains.into_iter().map(str::to_string).collect() },
            layout,
        },
        literal::LiteralWriteOutcome::Unchanged => plain(ObjectBindingsResponse::LiteralSet { domains: Vec::new() }),
    })
}

// ---------------------------------------------------------------------------
// Runtime-only ops: never dirty, never undo (resolved values are transient)
// ---------------------------------------------------------------------------

/// Every resolved value, sorted by (object, path).
fn all_resolved(state: &AppState) -> Vec<ResolvedBinding> {
    let mut values: Vec<ResolvedBinding> = match state.object_binding_runtime.lock() {
        Ok(runtime) => runtime.resolved.values().cloned().collect(),
        Err(_) => Vec::new(),
    };
    values.sort_by(|a, b| (&a.object, &a.path).cmp(&(&b.object, &b.path)));
    values
}

/// Re-evaluate EVERY binding and return EVERY current value (the seam's answer
/// to a reload: it refills its cache from this).
pub fn resolve_all_core(cx: &BindingCx<'_>) -> Vec<ResolvedBinding> {
    eval::reevaluate(&cx.stores(), cx.pane, cx.ribbon, eval::Scope::All);
    all_resolved(cx.state)
}

/// The frontend saw cells change (`None` = it cannot say which). Returns the
/// values that CHANGED (also announced on the event).
pub fn cells_changed_core(cx: &BindingCx<'_>, cells: Option<Vec<ChangedCellRef>>) -> Vec<ResolvedBinding> {
    let scope = match cells {
        None => eval::Scope::All,
        Some(cells) => {
            let ids: Vec<identity::SheetId> = cx.state.sheet_ids.read().map(|g| g.clone()).unwrap_or_default();
            eval::Scope::Cells(
                cells
                    .iter()
                    .filter_map(|c| ids.get(c.sheet_index).map(|id| (*id, c.row, c.col)))
                    .collect(),
            )
        }
    };
    eval::reevaluate(&cx.stores(), cx.pane, cx.ribbon, scope)
}

/// REPLACE the page-filter mirror with the frontend's full snapshot (D §3.8:
/// `@api/pageFilters` stays the authority; this is a derived copy, so it
/// constructs no `DocumentEffect` -- D §9 D1), then re-evaluate the pages
/// whose filters changed from what the runtime holds. The command goes through
/// [`set_page_filters_async`], which runs the measure pass in between.
pub fn set_page_filters_core(cx: &BindingCx<'_>, pages: Vec<PageFilterPageWire>) -> Vec<identity::SheetId> {
    let changed = measures::replace_page_filters(cx.state, pages);
    if !changed.is_empty() {
        eval::reevaluate(&cx.stores(), cx.pane, cx.ribbon, eval::Scope::Pages(changed.clone()));
    }
    changed
}

/// Re-evaluate one page (`Some(sheet)`) or every page from what the runtime
/// holds. The command goes through [`refresh_measures_async`], which re-reads
/// the measures first.
pub fn refresh_measures_core(cx: &BindingCx<'_>, sheet_index: Option<usize>) {
    let scope = match sheet_index {
        None => eval::Scope::All,
        Some(index) => match sheet_id_at(cx.state, index) {
            Some(id) => eval::Scope::Pages(vec![id]),
            None => return,
        },
    };
    eval::reevaluate(&cx.stores(), cx.pane, cx.ribbon, scope);
}

// ---------------------------------------------------------------------------
// Reads: Analyze, Measures
// ---------------------------------------------------------------------------

/// What `formula` would be stored as on `object`, and what it reads. A formula
/// the rules refuse is NOT an `Err`: the analysis carries the sentence
/// (`error`), which the editor shows inline. A missing object is an `Err`.
pub fn analyze_core(
    cx: &BindingCx<'_>,
    models: &[BindingModelMeasures],
    object: &ObjectBindingRef,
    formula_text: &str,
    invariant: bool,
) -> Result<BindingFormulaAnalysis, String> {
    analyze_core_with_model(cx, models, object, formula_text, invariant, None)
}

/// `analyze_core` for the model a `Set` would name: the analysis a caller gates
/// on must be the one `Set` will apply. With no model, `[Measure]` on a page
/// that offers several models is refused ("say which one"), while the `Set`
/// that names one is not -- so the script executor (D §3.19), which decides
/// `bi.query` and the restricted clamp from this analysis, sends the model too.
pub fn analyze_core_with_model(
    cx: &BindingCx<'_>,
    models: &[BindingModelMeasures],
    object: &ObjectBindingRef,
    formula_text: &str,
    invariant: bool,
    model: Option<&str>,
) -> Result<BindingFormulaAnalysis, String> {
    let location = object_json::locate(&cx.stores(), object).ok_or_else(|| not_found(object))?;
    let world = FormulaWorld::read(cx.state);
    match normalize_for(cx, &world, models, object, &location, formula_text, invariant, model) {
        Ok(normalized) => Ok(normalized.analysis),
        Err(why) => {
            let stored = formula::to_invariant(formula_text.trim(), invariant, &world.locale);
            Ok(BindingFormulaAnalysis {
                display_normalized: formula::display_formula(&stored, &world.locale),
                normalized: stored,
                sheets: Vec::new(),
                uses_names: false,
                uses_table_refs: false,
                uses_indirect: false,
                uses_cube: false,
                measure_refs: Vec::new(),
                model: None,
                error: Some(why),
                warning: None,
            })
        }
    }
}

/// The models (and their measures) a binding on `object` could read.
pub fn measures_core(
    cx: &BindingCx<'_>,
    models: &[BindingModelMeasures],
    object: &ObjectBindingRef,
) -> Result<Vec<BindingModelMeasures>, String> {
    object_json::locate(&cx.stores(), object).ok_or_else(|| not_found(object))?;
    Ok(models.to_vec())
}
