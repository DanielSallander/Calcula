//! FILENAME: app/src-tauri/src/object_bindings/measures.rs
// PURPOSE: The MEASURE PASS and the page-filter mirror (D §3.8, WP-D S4): what
//          a `[Measure]` reference in a bound property reads, under the page's
//          model slicers, exactly the way a Card reads it; the literal-argument
//          CUBE prefetch; the model a binding names; and the models a binding on
//          a page may read.
// CONTEXT: Everything here is DERIVED and TRANSIENT. The mirror and the caches
//          live in the bare-`Mutex` runtime (`eval::BindingRuntime`, D §9 D1);
//          nothing constructs a `DocumentEffect` or writes the persisted store.
//          Values feed `eval::reevaluate`, which only the command (mod.rs) and
//          the MCP tool call -- never this file.
//
// THE QUERY. Per (page, connection, filter signature) ONE measure-only design
// query (`pivot::headless::compute_design_query_view`, the exact Card path,
// CONTRACT-CANVAS 4.8, host-mask fallback included) with every measure those
// bindings read in VALUES, the mirrored model filters as `page_filter_fields`
// and other visuals' selections as `tuple_filters` (P4). An object whose
// interaction differs from the page default (a `none` pair) carries its own
// OVERRIDE set and is queried under it, so it fetches apart from its siblings. A failed batch is retried one measure at a time (at
// most `MAX_SEPARATE_MEASURE_QUERIES`) so one bad measure fails one binding.
//
// THE CACHE KEY. (page, connection id, UPPERCASE measure, filter signature).
// A pass reads only the entry under the CURRENT signature of the binding's
// object (its override, else its page's set), so after a slicer click a
// measure is PENDING until its new value arrives -- never the previous
// filter's number shown as current.
//
// CUBE. Literal-argument CUBE calls are prefetched through the same resolvers
// a cube CELL uses (`bi::cube::resolve_value` / `resolve_object`), keyed by
// `engine::cube_call_key`, with no script id (no capability row -- the
// workbook evaluates them, as it does a cell) and NOT filtered by the page.
//
// LOCKS. No std guard is ever held across an `.await`: every async function
// here calls a SYNC helper that copies what it needs (taking and releasing
// each lock), awaits with nothing held, then a sync helper writes the runtime.
// The leaf census `binding_locks_are_leaves` (eval_tests.rs) scans this file.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::Arc;

use engine::{BuiltinFunction, CellValue, CubeBinding, CubeCallResult, CubeResolver, Expression, LocaleSettings};

use crate::api_types::{BindingModelMeasures, ObjectBindingRef, PageFilterPageWire, PageFilterWire, TupleFilterWire};
use crate::bi::types::{BiState, ConnectionId};
use crate::pivot::headless::{DesignQueryColumn, DesignQueryFieldRef, DesignQueryRequest, DesignQueryTupleFilter};
use crate::pivot::types::BiValueFieldRef;
use crate::AppState;

use super::eval::MeasureOutcome;
use super::object_json::{self, ObjectLocation, ObjectStores};

/// (page, connection id, UPPERCASE measure, filter signature) -- see the
/// module header.
pub type MeasureKey = (identity::SheetId, String, String, u64);

/// A failed batch is retried one measure at a time, at most this many queries;
/// the measures beyond it keep the batch's error.
pub const MAX_SEPARATE_MEASURE_QUERIES: usize = 50;

type EngineArc = Arc<tokio::sync::Mutex<bi_engine::Engine>>;

// ---------------------------------------------------------------------------
// Signature, model resolution
// ---------------------------------------------------------------------------

/// The model filters ONE (page, connection) -- or one object's override on it
/// -- applies to a bound measure: the ordinary per-column filters and the
/// OR-of-AND tuple filters of another visual's selection (P4).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PageFilterSet {
    pub filters: Vec<PageFilterWire>,
    pub tuple_filters: Vec<TupleFilterWire>,
}

impl PageFilterSet {
    pub fn new(filters: Vec<PageFilterWire>, tuple_filters: Vec<TupleFilterWire>) -> PageFilterSet {
        PageFilterSet { filters, tuple_filters }
    }

    /// No filter of either kind (the unfiltered page).
    pub fn is_empty(&self) -> bool {
        self.filters.is_empty() && self.tuple_filters.is_empty()
    }
}

/// The empty set (no filters at all), for a page or object with none mirrored.
pub static NO_FILTERS: PageFilterSet = PageFilterSet { filters: Vec::new(), tuple_filters: Vec::new() };

/// An object's own filters on one connection (P4: an interaction other than
/// the page default), with the page it was mirrored under -- so a moved
/// override reports its page as changed even after it is gone.
#[derive(Debug, Clone, PartialEq)]
pub struct ObjectFilterOverride {
    pub page: identity::SheetId,
    pub set: PageFilterSet,
}

/// A filter set as one number: each filter's (field, level, items sorted) and
/// each tuple filter's (fields, tuples sorted), all sorted -- the
/// `signatures()` rule of `@api/reportFilters`: order of publication, of items
/// and of tuples is not meaning. No filters at all has a signature too (the
/// unfiltered page), and an empty tuple list (keeps nothing) is not "no tuple
/// filter".
pub fn filter_signature(set: &PageFilterSet) -> u64 {
    let mut parts: Vec<String> = set
        .filters
        .iter()
        .map(|f| {
            let mut items = f.included_items.clone();
            items.sort();
            serde_json::json!([f.field, f.filter_level, items]).to_string()
        })
        .collect();
    parts.extend(set.tuple_filters.iter().map(|t| {
        let mut tuples = t.tuples.clone();
        tuples.sort();
        serde_json::json!(["tuple", t.fields, tuples]).to_string()
    }));
    parts.sort();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    parts.hash(&mut hasher);
    hasher.finish()
}

/// The STABLE key a binding stores for a connection's model: a package
/// connection's data-source id (its session uuid changes on every load), else
/// the connection's own id (stable for a local connection).
pub fn model_key_of(connection: &crate::bi::types::Connection) -> String {
    connection
        .package_data_source_id
        .clone()
        .unwrap_or_else(|| connection.id.to_string())
}

/// The connection a stored model key names: a connection whose own id is the
/// key (local), else one whose `package_data_source_id` is (package -- the
/// model-slicer rule, `slicer/types.rs`). With several package connections of
/// one data source, the lowest id answers, so the choice is stable.
pub fn resolve_model(bi: &BiState, model_key: &str) -> Option<ConnectionId> {
    let connections = bi.connections.lock().ok()?;
    if let Some(local) = connections.values().find(|c| c.id.to_string() == model_key) {
        return Some(local.id);
    }
    let mut package: Vec<ConnectionId> = connections
        .values()
        .filter(|c| c.package_data_source_id.as_deref() == Some(model_key))
        .map(|c| c.id)
        .collect();
    package.sort_by_key(|id| id.to_string());
    package.into_iter().next()
}

/// The engine of `connection`, when it has a loaded model. Connection table
/// taken and released.
fn engine_of(bi: &BiState, connection: ConnectionId) -> Option<EngineArc> {
    bi.connections.lock().ok()?.get(&connection).and_then(|c| c.engine.clone())
}

// ---------------------------------------------------------------------------
// The models a binding may read (D §3.6 rule 4)
// ---------------------------------------------------------------------------

/// One connected model before its measure list is read.
#[derive(Clone)]
struct ModelCandidate {
    model_key: String,
    connection_id: String,
    name: String,
    engine: EngineArc,
}

/// Every connection with a loaded model. Connection table taken and released.
fn connected_models(bi: &BiState) -> Vec<ModelCandidate> {
    match bi.connections.lock() {
        Ok(connections) => connections
            .values()
            .filter_map(|c| {
                let engine = c.engine.clone()?;
                Some(ModelCandidate {
                    model_key: model_key_of(c),
                    connection_id: c.id.to_string(),
                    name: c.name.clone(),
                    engine,
                })
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// Each candidate with its measures (awaiting each engine's lock with no std
/// guard held), sorted by name, one entry per model key; the only one is the
/// default.
async fn with_measures(candidates: Vec<ModelCandidate>) -> Vec<BindingModelMeasures> {
    let mut out: Vec<BindingModelMeasures> = Vec::new();
    for candidate in candidates {
        let measures: Vec<String> = {
            let guard = candidate.engine.lock().await;
            guard.model().measures().iter().map(|m| m.name().to_string()).collect()
        };
        out.push(BindingModelMeasures {
            model_key: candidate.model_key,
            connection_id: candidate.connection_id,
            name: candidate.name,
            measures,
            is_default: false,
        });
    }
    out.sort_by(|a, b| (a.name.as_str(), a.model_key.as_str()).cmp(&(b.name.as_str(), b.model_key.as_str())));
    out.dedup_by(|a, b| a.model_key == b.model_key);
    if out.len() == 1 {
        out[0].is_default = true;
    }
    out
}

/// Every connected model of the workbook and its measures.
pub async fn workbook_models(bi: &BiState) -> Vec<BindingModelMeasures> {
    with_measures(connected_models(bi)).await
}

/// The connection ids the objects ON sheet `sheet_index` read: design-query
/// charts (`spec.data.connectionId`), model slicers (`cache_source_id`) and BI
/// pivots (their metadata's connection). Each family store taken and released.
pub fn page_connection_ids(cx: &ObjectStores<'_>, sheet_index: usize) -> HashSet<String> {
    let mut out: HashSet<String> = HashSet::new();
    if let Ok(charts) = cx.state.charts.read() {
        for chart in charts.iter().filter(|c| c.sheet_index == sheet_index) {
            if let Some(id) = design_query_connection(&chart.spec_json) {
                out.insert(id);
            }
        }
    }
    if let Ok(slicers) = cx.slicers.slicers.read() {
        for slicer in slicers.values().filter(|s| s.sheet_index == sheet_index && s.is_model_slicer()) {
            out.insert(slicer.cache_source_id.to_string());
        }
    }
    let names: Vec<String> = cx.state.sheet_names.read().map(|g| g.clone()).unwrap_or_default();
    let pivots_here: Vec<identity::EntityId> = match cx.pivots.pivot_tables.read() {
        Ok(pivots) => pivots
            .iter()
            .filter(|(_, (def, _))| {
                let index = match def.destination_sheet.as_deref() {
                    Some(name) => crate::pivot::operations::index_of_sheet(&names, name),
                    None => Some(0),
                };
                index == Some(sheet_index)
            })
            .map(|(id, _)| *id)
            .collect(),
        Err(_) => Vec::new(),
    };
    if !pivots_here.is_empty() {
        if let Ok(meta) = cx.pivots.bi_metadata.read() {
            for id in &pivots_here {
                if let Some(m) = meta.get(id) {
                    out.insert(m.connection_id.to_string());
                }
            }
        }
    }
    out
}

/// The connection a design-query chart's definition (the IPC envelope, or a
/// bare spec) reads, if it is one.
fn design_query_connection(spec_json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(spec_json).ok()?;
    let inner = match value.get("spec") {
        Some(spec) if spec.is_object() => spec,
        _ => &value,
    };
    let data = inner.get("data")?;
    if data.get("type").and_then(|t| t.as_str()) != Some("designQuery") {
        return None;
    }
    data.get("connectionId")
        .and_then(|c| c.as_str())
        .filter(|c| !c.is_empty())
        .map(str::to_string)
}

/// The models a binding on sheet `sheet_index` may read (D §3.6 rule 4): the
/// models the objects ON that page use; when the page uses none, every model
/// of the workbook. Exactly one entry is the default (the page's only model,
/// else the workbook's only model) -- with several, a formula must say which.
pub async fn page_models(cx: &ObjectStores<'_>, bi: &BiState, sheet_index: usize) -> Vec<BindingModelMeasures> {
    let on_page = page_connection_ids(cx, sheet_index);
    let all = connected_models(bi);
    let here: Vec<ModelCandidate> = all.iter().filter(|c| on_page.contains(&c.connection_id)).cloned().collect();
    with_measures(if here.is_empty() { all } else { here }).await
}

// ---------------------------------------------------------------------------
// The page-filter mirror
// ---------------------------------------------------------------------------

/// REPLACE the page-filter mirror with the frontend's full snapshot (the seam
/// sends every page) and return the pages whose filters changed, sorted: a
/// page whose own set moved, or on which some object's OVERRIDE appeared,
/// moved or went away (P4). The frontend (`@api/reportFilters`) stays the
/// authority; this is a derived copy, so nothing is dirtied (D §9 D1). Pages
/// arrive by SHEET ID (P4 DC-4), so no sheet table is read: the runtime lock
/// only. A sheet id the runtime's last build did not know is kept (it is inert
/// until such a page exists) and said in the log once.
pub fn replace_page_filters(state: &AppState, pages: Vec<PageFilterPageWire>) -> Vec<identity::SheetId> {
    let mut mirror: HashMap<(identity::SheetId, String), PageFilterSet> = HashMap::new();
    let mut overrides: HashMap<ObjectBindingRef, HashMap<String, ObjectFilterOverride>> = HashMap::new();
    for page in pages {
        for object in page.objects {
            overrides.entry(object.object).or_default().insert(
                page.connection_id.clone(),
                ObjectFilterOverride { page: page.sheet_id, set: PageFilterSet::new(object.filters, object.tuple_filters) },
            );
        }
        mirror.insert((page.sheet_id, page.connection_id), PageFilterSet::new(page.filters, page.tuple_filters));
    }
    let mut changed: Vec<identity::SheetId> = {
        let Ok(mut runtime) = state.object_binding_runtime.lock() else { return Vec::new() };
        if runtime.built {
            let unknown: Vec<identity::SheetId> = mirror
                .keys()
                .map(|(page, _)| *page)
                .filter(|page| !runtime.built_for_sheets.contains(page))
                .collect();
            for page in unknown {
                if runtime.warned_unknown_sheets.insert(page) {
                    crate::log_warn!(
                        "BINDINGS",
                        "page filters arrived for sheet id {page}, which is not a sheet of this workbook (yet);                          they reach no bound property until it is"
                    );
                }
            }
        }
        let mut changed: Vec<identity::SheetId> = Vec::new();
        for (key, set) in &mirror {
            if runtime.page_filters.get(key) != Some(set) {
                changed.push(key.0);
            }
        }
        for key in runtime.page_filters.keys() {
            if !mirror.contains_key(key) {
                changed.push(key.0);
            }
        }
        // An override that appeared, moved or went away changes the page it is
        // (or was) mirrored under.
        for (object, by_connection) in &overrides {
            let before = runtime.object_filters.get(object);
            for (connection, now) in by_connection {
                let was = before.and_then(|b| b.get(connection));
                if was != Some(now) {
                    changed.push(now.page);
                    if let Some(was) = was {
                        changed.push(was.page);
                    }
                }
            }
        }
        for (object, by_connection) in &runtime.object_filters {
            let now = overrides.get(object);
            for (connection, was) in by_connection {
                if now.and_then(|n| n.get(connection)).is_none() {
                    changed.push(was.page);
                }
            }
        }
        runtime.page_filters = mirror;
        runtime.object_filters = overrides;
        changed
    };
    changed.sort();
    changed.dedup();
    changed
}

/// The mirrored filters of one (page, connection) as the design query's
/// `page_filter_fields`: `"Table.Column"` split against the model's own tables
/// (table names contain dots). A field naming no table of the model is skipped
/// and said in the log -- the `mergePageFilters` rule: a column the model does
/// not have cannot be kept, and sending it would fail every measure.
pub fn page_filter_fields(filters: &[PageFilterWire], table_names: &[String]) -> Vec<DesignQueryFieldRef> {
    let mut out = Vec::new();
    for filter in filters {
        let (table, column) =
            crate::pivot::commands::split_bi_field_key(&filter.field, table_names.iter().map(String::as_str));
        if table.is_empty() || column.is_empty() || !table_names.iter().any(|t| *t == table) {
            crate::log_warn!(
                "BINDINGS",
                "a page filter on '{}' was not applied to bound measures: the model has no such table",
                filter.field
            );
            continue;
        }
        out.push(DesignQueryFieldRef {
            table,
            column,
            is_lookup: false,
            hidden_items: None,
            included_items: Some(filter.included_items.clone()),
            level: (filter.filter_level > 1).then_some(filter.filter_level),
        });
    }
    out
}

/// The mirrored TUPLE filters of one (page, connection) as the design query's
/// `tuple_filters`, each field split against the model's own tables like
/// [`page_filter_fields`]. A tuple filter with ANY field the model does not
/// have is skipped WHOLE and said in the log (BUG-0527, the `mergeTupleFilters`
/// rule): dropping one column of a tuple would widen the selection to rows it
/// never named. Keys go in as KEYS -- `engine_tuple_filters` re-spells them
/// for the engine (the blank key `""`, a float key), never this function.
pub fn tuple_filter_fields(tuples: &[TupleFilterWire], table_names: &[String]) -> Vec<DesignQueryTupleFilter> {
    let mut out = Vec::new();
    'filters: for tuple in tuples {
        let mut fields = Vec::with_capacity(tuple.fields.len());
        for field in &tuple.fields {
            let (table, column) =
                crate::pivot::commands::split_bi_field_key(field, table_names.iter().map(String::as_str));
            if table.is_empty() || column.is_empty() || !table_names.iter().any(|t| *t == table) {
                crate::log_warn!(
                    "BINDINGS",
                    "a selection on ({}) was not applied to bound measures: the model has no table for '{}'",
                    tuple.fields.join(", "),
                    field
                );
                continue 'filters;
            }
            fields.push(DesignQueryColumn { table, column });
        }
        out.push(DesignQueryTupleFilter { fields, tuples: tuple.tuples.clone(), level: None });
    }
    out
}

// ---------------------------------------------------------------------------
// CUBE calls of a binding
// ---------------------------------------------------------------------------

/// One literal-argument CUBE call of a binding formula, with the key the
/// evaluator will look its result up by.
#[derive(Debug, Clone, PartialEq)]
pub struct CubeCall {
    pub key: String,
    pub func: BuiltinFunction,
    pub args: Vec<Expression>,
}

/// A resolver for literal arguments: no cell is a cube object and no cell has
/// text (a binding's CUBE arguments are literals, D §3.6 rule 5). The
/// evaluator's own resolver agrees on every literal, so the keys match.
struct NoCells;

impl CubeResolver for NoCells {
    fn binding_at(&self, _row: u32, _col: u32) -> Option<&CubeBinding> {
        None
    }
    fn cell_text(&self, _row: u32, _col: u32) -> Option<String> {
        None
    }
}

/// Every CUBE call in `ast` whose key can be computed from its literals,
/// deduplicated by key, in walk order. A call whose key cannot be computed is
/// left to the evaluator, which answers it with the same error a cell would.
pub fn cube_calls(ast: &Expression) -> Vec<CubeCall> {
    let mut found: Vec<(BuiltinFunction, Vec<Expression>)> = Vec::new();
    crate::bi::cube::collect_cube_calls(ast, &mut found);
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for (func, args) in found {
        let Some(name) = engine::cube_function_name(&func) else { continue };
        let Ok(key) = engine::cube_call_key(name, &args, &NoCells) else { continue };
        if seen.insert(key.clone()) {
            out.push(CubeCall { key, func, args });
        }
    }
    out
}

/// Resolve each call the way a cube CELL's prefetch does (`build_cube_prefetch`
/// phase B), with no script id: the workbook evaluates these, not a script.
async fn prefetch_cube(bi: &BiState, calls: &[CubeCall]) -> HashMap<String, CubeCallResult> {
    let mut out: HashMap<String, CubeCallResult> = HashMap::new();
    if calls.is_empty() {
        return out;
    }
    let mut ctx = crate::bi::cube::CubeCtx::new(bi);
    for call in calls {
        if out.contains_key(&call.key) {
            continue;
        }
        let result = if crate::bi::cube::is_object_func(&call.func) {
            match crate::bi::cube::resolve_object(&mut ctx, &call.func, &call.args, &NoCells).await {
                Ok(binding) => CubeCallResult::Object { caption: binding.caption },
                Err(e) => CubeCallResult::Error(e),
            }
        } else {
            match crate::bi::cube::resolve_value(&mut ctx, &call.func, &call.args, &NoCells).await {
                Ok(result) => result,
                Err(e) => CubeCallResult::Error(e),
            }
        };
        out.insert(call.key.clone(), result);
    }
    out
}

// ---------------------------------------------------------------------------
// The measure-only query
// ---------------------------------------------------------------------------

/// One measure's value as the query answered it, before formatting.
#[derive(Debug, Clone, PartialEq)]
pub enum MeasureValue {
    Number(f64),
    Text(String),
    Blank,
}

/// The grand-total row of a measure-only view, one value per entry of the
/// request's `value_fields` (matched through each cell's `value_field_index`,
/// which indexes the definition's value fields -- one per measure on this
/// path). A measure the row does not carry is Blank.
pub fn measure_only_values(
    view: &pivot_engine::PivotView,
    def: &pivot_engine::PivotDefinition,
    count: usize,
) -> Vec<MeasureValue> {
    let mut out = vec![MeasureValue::Blank; count];
    let Some(row) = view.rows.iter().find(|r| r.row_type == pivot_engine::PivotRowType::GrandTotal) else {
        return out;
    };
    let Some(cells) = view.cells.get(row.view_row) else { return out };
    for cell in cells {
        let Some(k) = cell.value_field_index else { continue };
        if k >= count || k >= def.value_fields.len() {
            continue;
        }
        out[k] = match &cell.value {
            pivot_engine::PivotCellValue::Number(n) if n.is_finite() => MeasureValue::Number(*n),
            pivot_engine::PivotCellValue::Text(s) => MeasureValue::Text(s.clone()),
            _ => MeasureValue::Blank,
        };
    }
    out
}

/// Run ONE measure-only design query for `measures` on `connection` under
/// `page_fields` and `tuple_fields`: the Card path.
async fn run_measure_only(
    bi: &BiState,
    connection: ConnectionId,
    measures: &[String],
    page_fields: &[DesignQueryFieldRef],
    tuple_fields: &[DesignQueryTupleFilter],
) -> Result<Vec<MeasureValue>, String> {
    let request = DesignQueryRequest {
        connection_id: connection,
        row_fields: Vec::new(),
        column_fields: Vec::new(),
        value_fields: measures
            .iter()
            .map(|m| BiValueFieldRef { measure_name: m.clone(), custom_name: None, number_format: None })
            .collect(),
        filter_fields: Vec::new(),
        page_filter_fields: page_fields.to_vec(),
        tuple_filters: tuple_fields.to_vec(),
        calculated_fields: None,
        value_column_order: None,
        layout: None,
    };
    let (def, _cache, view) = Box::pin(crate::pivot::headless::compute_design_query_view(bi, &request)).await?;
    Ok(measure_only_values(&view, &def, measures.len()))
}

/// Was `measure`'s failure the model's SECURITY refusing it? Asked of the
/// TYPED engine error (`bi::cube::is_security_refusal`) with a bare query under
/// the connection's role -- never by matching message text (the design-query
/// path returns a sentence, and two message-matching branches here were dead
/// for their whole life).
async fn refused_by_security(bi: &BiState, connection: ConnectionId, measure: &str) -> bool {
    let Some(engine_arc) = engine_of(bi, connection) else { return false };
    let mut engine = engine_arc.lock().await;
    crate::bi::commands::apply_connection_role(&mut engine, bi, connection);
    let request = bi_engine::QueryRequest { measures: vec![measure.to_string()], ..Default::default() };
    match engine.query_with_meta(request).await {
        Err(e) => crate::bi::cube::is_security_refusal(&e),
        Ok(_) => false,
    }
}

/// A measure that failed alone: refused or failed, with the query's sentence.
async fn classify_failure(bi: &BiState, connection: ConnectionId, measure: &str, message: String) -> MeasureOutcome {
    if refused_by_security(bi, connection, measure).await {
        MeasureOutcome::Refused(message)
    } else {
        MeasureOutcome::Failed(message)
    }
}

/// A measure's value as a bound property shows it: formatted with the
/// model's `format_string` (an Excel format code) in the user's locale, else
/// the plain number.
pub(super) fn format_measure(value: f64, format: Option<&str>, locale: &LocaleSettings) -> String {
    match format.map(str::trim).filter(|f| !f.is_empty()) {
        Some(code) => engine::format_number(
            value,
            &crate::commands::styles::parse_number_format_with_locale(code, locale),
            locale,
        ),
        None => crate::format_cell_value_display(&CellValue::Number(value), locale),
    }
}

fn outcome_of(value: MeasureValue, format: Option<&str>, locale: &LocaleSettings) -> MeasureOutcome {
    match value {
        MeasureValue::Number(n) => MeasureOutcome::Number(n, format_measure(n, format, locale)),
        MeasureValue::Text(s) => MeasureOutcome::Text(s),
        MeasureValue::Blank => MeasureOutcome::Blank,
    }
}

/// Every measure of `measures` on `connection` under `filters` (the page's set,
/// or one object's override): ONE query, and on its failure one query per
/// measure (at most [`MAX_SEPARATE_MEASURE_QUERIES`]) so a bad measure fails
/// only itself. A tuple filter the engine refuses for a measure (a compound
/// measure that clears part of it) fails that measure with the engine's
/// sentence -- never an unfiltered number.
pub async fn query_page_measures(
    bi: &BiState,
    connection: ConnectionId,
    measures: &[String],
    filters: &PageFilterSet,
    locale: &LocaleSettings,
) -> Vec<(String, MeasureOutcome)> {
    let Some(engine_arc) = engine_of(bi, connection) else {
        let why = "The model this measure is read from is not loaded.".to_string();
        return measures.iter().map(|m| (m.clone(), MeasureOutcome::NotConnected(why.clone()))).collect();
    };
    let (table_names, formats): (Vec<String>, HashMap<String, String>) = {
        let engine = engine_arc.lock().await;
        let model = engine.model();
        let tables = model.tables().iter().map(|t| t.name().to_string()).collect();
        let formats = model
            .measures()
            .iter()
            .filter_map(|m| Some((m.name().to_uppercase(), m.format_string()?.to_string())))
            .collect();
        (tables, formats)
    };
    let fields = page_filter_fields(&filters.filters, &table_names);
    let tuple_fields = tuple_filter_fields(&filters.tuple_filters, &table_names);
    let format_of = |m: &str| formats.get(&m.to_uppercase()).map(String::as_str);

    match run_measure_only(bi, connection, measures, &fields, &tuple_fields).await {
        Ok(values) => measures
            .iter()
            .zip(values)
            .map(|(m, v)| (m.clone(), outcome_of(v, format_of(m), locale)))
            .collect(),
        Err(batch_error) if measures.len() == 1 => {
            let measure = &measures[0];
            vec![(measure.clone(), classify_failure(bi, connection, measure, batch_error).await)]
        }
        Err(batch_error) => {
            let mut out = Vec::with_capacity(measures.len());
            for (i, measure) in measures.iter().enumerate() {
                if i >= MAX_SEPARATE_MEASURE_QUERIES {
                    out.push((measure.clone(), MeasureOutcome::Failed(batch_error.clone())));
                    continue;
                }
                let one = std::slice::from_ref(measure);
                let outcome = match run_measure_only(bi, connection, one, &fields, &tuple_fields).await {
                    Ok(mut values) => outcome_of(values.pop().unwrap_or(MeasureValue::Blank), format_of(measure), locale),
                    Err(error) => classify_failure(bi, connection, measure, error).await,
                };
                out.push((measure.clone(), outcome));
            }
            out
        }
    }
}

// ---------------------------------------------------------------------------
// The pass: plan (sync) -> fetch (async, nothing held) -> install (sync)
// ---------------------------------------------------------------------------

/// What one run of the measure pass covers.
#[derive(Debug, Clone, PartialEq)]
pub struct FetchScope {
    /// Only bindings on these pages; `None` = every page.
    pub pages: Option<Vec<identity::SheetId>>,
    /// Fetch `[Measure]` values (filtered by each page).
    pub measures: bool,
    /// Prefetch literal-argument CUBE calls (never filtered by the page).
    pub cube: bool,
    /// Fetch only what the runtime does not hold yet for the CURRENT filters
    /// (a Set, a ResolveAll after a reload). `false` re-reads everything in
    /// scope (the model changed or was refreshed).
    pub only_missing: bool,
}

impl FetchScope {
    /// Re-read every measure and CUBE call of `pages` (`None` = all).
    pub fn refresh(pages: Option<Vec<identity::SheetId>>) -> FetchScope {
        FetchScope { pages, measures: true, cube: true, only_missing: false }
    }

    /// Fetch what is missing on `pages` (`None` = all).
    pub fn missing(pages: Option<Vec<identity::SheetId>>) -> FetchScope {
        FetchScope { pages, measures: true, cube: true, only_missing: true }
    }

    /// The page filters of `pages` changed: re-read their measures (CUBE is
    /// not filtered by the page, so it is left alone).
    pub fn filters_changed(pages: Vec<identity::SheetId>) -> FetchScope {
        FetchScope { pages: Some(pages), measures: true, cube: false, only_missing: false }
    }
}

/// The measures one group of bindings on a page reads from one model key. The
/// bindings of a group share the same object OVERRIDES (P4), so they read the
/// same filters once the model's connection is known: one Card under a `none`
/// pair and its neighbour under the selection are two needs.
#[derive(Debug, Clone)]
struct MeasureNeed {
    page: identity::SheetId,
    model_key: String,
    /// The overrides of the group's object(s), by connection id (empty: the
    /// page's own set on every connection).
    overrides: BTreeMap<String, PageFilterSet>,
    measures: Vec<String>,
}

/// One query the fetch runs: a need resolved to its connection, under the
/// object's EFFECTIVE set (its override, else the page's) and that set's
/// signature -- the cache key the values are installed under.
#[derive(Debug, Clone)]
struct MeasureQuery {
    page: identity::SheetId,
    connection: ConnectionId,
    signature: u64,
    filters: PageFilterSet,
    measures: Vec<String>,
}

/// Everything a fetch needs, COPIED out of the runtime (released).
#[derive(Debug, Default)]
struct FetchPlan {
    needs: Vec<MeasureNeed>,
    filters: HashMap<(identity::SheetId, String), PageFilterSet>,
    cube: Vec<CubeCall>,
    /// Every CUBE key a binding still reads (for pruning on a full refresh).
    live_cube_keys: HashSet<String>,
    prune_cube: bool,
    locale: Option<LocaleSettings>,
}

impl FetchPlan {
    fn is_empty(&self) -> bool {
        self.needs.is_empty() && self.cube.is_empty() && !self.prune_cube
    }
}

/// What a fetch brought back.
#[derive(Debug, Default)]
struct Fetched {
    /// Model key -> its connection id, or `None` = not connected.
    models: HashMap<String, Option<String>>,
    /// (page, connection id, signature fetched under, values).
    pages: Vec<(identity::SheetId, String, u64, Vec<(String, MeasureOutcome)>)>,
    cube: HashMap<String, CubeCallResult>,
}

/// The override identity a need groups by: each connection's override
/// signature, in connection order.
fn override_identity(overrides: &BTreeMap<String, PageFilterSet>) -> Vec<(String, u64)> {
    overrides.iter().map(|(c, set)| (c.clone(), filter_signature(set))).collect()
}

/// (page, model key, override identity) -- how `plan_fetch` groups bindings.
type NeedKey = (identity::SheetId, String, Vec<(String, u64)>);

/// Plan a fetch (sync): the runtime is rebuilt if the store moved, the object
/// locations and locale are copied, then the runtime alone is read and
/// released.
fn plan_fetch(cx: &ObjectStores<'_>, scope: &FetchScope) -> FetchPlan {
    super::eval::ensure_prepared(cx);
    let locations: HashMap<ObjectBindingRef, ObjectLocation> =
        object_json::object_locations(cx).into_iter().collect();
    let locale = cx.state.locale.lock().map(|g| g.clone()).unwrap_or_else(|_| LocaleSettings::invariant());

    let Ok(runtime) = cx.state.object_binding_runtime.lock() else { return FetchPlan::default() };
    let mut grouped: BTreeMap<NeedKey, (BTreeMap<String, PageFilterSet>, Vec<String>)> = BTreeMap::new();
    let mut cube: Vec<CubeCall> = Vec::new();
    let mut cube_seen: HashSet<String> = HashSet::new();
    let mut live_cube_keys: HashSet<String> = HashSet::new();
    let mut keys: Vec<&super::store::BindingKey> = runtime.prepared.keys().collect();
    keys.sort();
    for key in keys {
        let Some(prepared) = runtime.prepared.get(key) else { continue };
        for call in &prepared.cube_calls {
            live_cube_keys.insert(call.key.clone());
        }
        let Some(location) = locations.get(&key.object) else { continue };
        let in_scope = scope.pages.as_ref().map_or(true, |pages| pages.contains(&location.sheet_id));
        if !in_scope || prepared.error.is_some() {
            continue;
        }
        if scope.cube {
            for call in &prepared.cube_calls {
                let have = runtime.cube_prefetch.results.contains_key(&call.key);
                if (!scope.only_missing || !have) && cube_seen.insert(call.key.clone()) {
                    cube.push(call.clone());
                }
            }
        }
        if !scope.measures || prepared.measure_refs.is_empty() {
            continue;
        }
        let Some(model) = &prepared.model else { continue };
        let overrides: BTreeMap<String, PageFilterSet> = runtime
            .object_filters
            .get(&key.object)
            .map(|by_connection| by_connection.iter().map(|(c, o)| (c.clone(), o.set.clone())).collect())
            .unwrap_or_default();
        let group: NeedKey = (location.sheet_id, model.clone(), override_identity(&overrides));
        let entry = grouped.entry(group).or_insert_with(|| (overrides, Vec::new()));
        for measure in &prepared.measure_refs {
            let wanted = !scope.only_missing
                || runtime.measure_outcome(location.sheet_id, &key.object, model, measure).is_none();
            if wanted && !entry.1.iter().any(|m| m.eq_ignore_ascii_case(measure)) {
                entry.1.push(measure.clone());
            }
        }
    }
    let needs: Vec<MeasureNeed> = grouped
        .into_iter()
        .filter(|(_, (_, measures))| !measures.is_empty())
        .map(|((page, model_key, _), (overrides, measures))| MeasureNeed { page, model_key, overrides, measures })
        .collect();
    FetchPlan {
        filters: if needs.is_empty() { HashMap::new() } else { runtime.page_filters.clone() },
        needs,
        cube,
        live_cube_keys,
        prune_cube: scope.cube && !scope.only_missing && scope.pages.is_none(),
        locale: Some(locale),
    }
}

/// Resolve each need to its connection and EFFECTIVE filter set, and merge the
/// needs that end up reading the same (page, connection, signature) into one
/// query. A model key that names no loaded model is recorded in `models` and
/// produces no query. Connection table taken and released per lookup.
fn resolve_queries(bi: &BiState, plan: &FetchPlan, models: &mut HashMap<String, Option<String>>) -> Vec<MeasureQuery> {
    let mut resolved: HashMap<String, Option<ConnectionId>> = HashMap::new();
    let mut queries: Vec<MeasureQuery> = Vec::new();
    for need in &plan.needs {
        let connection_id = match resolved.get(&need.model_key) {
            Some(known) => *known,
            None => {
                let id = resolve_model(bi, &need.model_key).filter(|id| engine_of(bi, *id).is_some());
                resolved.insert(need.model_key.clone(), id);
                models.insert(need.model_key.clone(), id.map(|i| i.to_string()));
                id
            }
        };
        // Not connected: `measure_models` says so for every measure of it.
        let Some(connection_id) = connection_id else { continue };
        let connection = connection_id.to_string();
        let filters = match need.overrides.get(&connection) {
            Some(set) => set.clone(),
            None => plan.filters.get(&(need.page, connection)).cloned().unwrap_or_default(),
        };
        let signature = filter_signature(&filters);
        match queries
            .iter_mut()
            .find(|q| q.page == need.page && q.connection == connection_id && q.signature == signature)
        {
            Some(query) => {
                for measure in &need.measures {
                    if !query.measures.iter().any(|m| m.eq_ignore_ascii_case(measure)) {
                        query.measures.push(measure.clone());
                    }
                }
            }
            None => queries.push(MeasureQuery {
                page: need.page,
                connection: connection_id,
                signature,
                filters,
                measures: need.measures.clone(),
            }),
        }
    }
    queries
}

/// Run a plan (async; holds no std guard).
async fn fetch(bi: &BiState, plan: &FetchPlan) -> Fetched {
    let locale = plan.locale.clone().unwrap_or_else(LocaleSettings::invariant);
    let mut fetched = Fetched::default();
    let queries = resolve_queries(bi, plan, &mut fetched.models);
    for query in queries {
        let values =
            Box::pin(query_page_measures(bi, query.connection, &query.measures, &query.filters, &locale)).await;
        fetched.pages.push((query.page, query.connection.to_string(), query.signature, values));
    }
    fetched.cube = prefetch_cube(bi, &plan.cube).await;
    fetched
}

/// Write what a fetch brought into the runtime (sync, runtime only). For each
/// (page, connection) fetched, entries are kept only under a signature this
/// fetch brought or one that is CURRENT for some object on that page (the
/// page's own set, or an object's override -- P4); every other entry of that
/// (page, connection) is dropped. A filter that moved on while the query ran
/// keeps its own newer values.
fn install(state: &AppState, plan: &FetchPlan, fetched: Fetched) {
    let Ok(mut runtime) = state.object_binding_runtime.lock() else { return };
    for (model, connection) in fetched.models {
        runtime.measure_models.insert(model, connection);
    }
    let mut keep: HashMap<(identity::SheetId, String), HashSet<u64>> = HashMap::new();
    for (page, connection, signature, _) in &fetched.pages {
        keep.entry((*page, connection.clone()))
            .or_insert_with(|| runtime.current_signatures(*page, connection))
            .insert(*signature);
    }
    runtime.measure_cache.retain(|(p, c, _, s), _| match keep.get(&(*p, c.clone())) {
        Some(signatures) => signatures.contains(s),
        None => true,
    });
    for (page, connection, signature, values) in fetched.pages {
        for (measure, outcome) in values {
            runtime.measure_cache.insert((page, connection.clone(), measure.to_uppercase(), signature), outcome);
        }
    }
    if !fetched.cube.is_empty() || plan.prune_cube {
        let mut prefetch = (*runtime.cube_prefetch).clone();
        prefetch.results.extend(fetched.cube);
        if plan.prune_cube {
            prefetch.results.retain(|key, _| plan.live_cube_keys.contains(key));
        }
        runtime.cube_prefetch = Arc::new(prefetch);
    }
}

/// THE MEASURE PASS: fetch what `scope` covers and write it into the runtime.
/// Returns true when anything was fetched (the caller then re-evaluates the
/// scope through `eval::reevaluate` -- this file never does). Holds no std
/// guard across an `.await`.
pub async fn refresh_measures(cx: &ObjectStores<'_>, bi: &BiState, scope: &FetchScope) -> bool {
    let plan = plan_fetch(cx, scope);
    if plan.is_empty() {
        return false;
    }
    let fetched = fetch(bi, &plan).await;
    install(cx.state, &plan, fetched);
    true
}

/// The page (sheet id) `object` is on, when it exists.
pub fn page_of(cx: &ObjectStores<'_>, object: &ObjectBindingRef) -> Option<identity::SheetId> {
    object_json::locate(cx, object).map(|l| l.sheet_id)
}

/// The sheet INDEX `object` is on, when it exists (what `page_models` takes).
pub fn sheet_index_of(cx: &ObjectStores<'_>, object: &ObjectBindingRef) -> Option<usize> {
    object_json::locate(cx, object).map(|l| l.sheet_index)
}
