//! FILENAME: app/src-tauri/src/object_bindings/eval.rs
// PURPOSE: The DERIVED half of the binding surface and THE ONE re-evaluation
//          entry point (D §3.7): the runtime that holds the prepared formulas,
//          the dependency maps, the resolved values and the page-filter mirror;
//          `ensure_prepared` (store -> runtime), `reevaluate` (scope -> changed
//          values), `evaluate_one` and the grid-locking `evaluate_pass`.
// CONTEXT: Resolved values are TRANSIENT: never saved, never undone, never
//          dirty -- nothing here constructs a `DocumentEffect` or writes a
//          persisted store. The runtime is a bare `Mutex` (a derived cache, D §9 D1).
//
// Rebuild rule: the runtime is rebuilt LAZILY from the store whenever
// `built_for_generation != BindingStore::generation`, the sheet list changed,
// or something marked it stale (a defined name moved: its dependency boxes
// moved with it). That is what lets a writer holding canonical locks (a
// structural shift, a cascade, the undo arm) touch ONLY the store.
//
// LOCK ORDER (D §3.3; pinned by `binding_locks_are_leaves` in eval_tests.rs).
// The binding store and runtime are LEAVES. No function here takes a grid,
// `grids`, `sheet_names` or `undo_stack` lock after taking the store or the
// runtime, and the one function that takes the grid locks (`evaluate_pass`)
// never names either. A pass therefore runs as:
//   1. copy out (sheet table, family stores, naming authorities) -- each lock
//      taken and released;
//   2. store -> runtime: read what is prepared, RELEASE;
//   3. build the GET.CONTROLVALUE snapshot (its own locks);
//   4. grid -> grids -> active_sheet -> sheet_names -> style_registry ->
//      tables -> table_names -> named_ranges: evaluate, RELEASE;
//   5. runtime alone: write the resolved values, diff, release; announce.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use engine::{CellValue, EvalContext, Evaluator, Expression, Grid, LocaleSettings, MultiSheetContext};
use serde_json::Value;

use crate::api_types::{ObjectBindingRef, ObjectBindingsChangedPayload, PageFilterWire, ResolvedBinding};
use crate::control_values::ControlValuesMap;
use crate::pane_control::PaneControlState;
use crate::ribbon_filter::RibbonFilterState;
use crate::AppState;

use super::catalog::{self, BindableValueType};
use super::formula::{self, FormulaWorld};
use super::object_json::{self, ObjectLocation, ObjectStores};
use super::store::{BindingKey, StoredBinding};

/// Longest text a bound TEXT property resolves to, in characters.
pub const MAX_RESOLVED_TEXT_CHARS: usize = 1_024;

/// One stored binding, parsed and analysed for evaluation. Rebuilt from the
/// store by [`ensure_prepared`]; never saved.
#[derive(Debug, Clone)]
pub struct PreparedBinding {
    /// The stored formula (invariant).
    pub formula: String,
    /// The stored model key.
    pub model: Option<String>,
    /// The qualified AST, wildcard sheets expanded; measure refs are still
    /// table-less `TableRef`s (substituted per pass). `None` when `error` is set.
    pub ast: Option<Expression>,
    /// The catalog type of the bound property, `None` when `error` is set.
    pub value_type: Option<BindableValueType>,
    /// Why this binding cannot evaluate at all (its path left the catalog, its
    /// formula no longer parses or names a sheet that is gone) -- a sentence.
    pub error: Option<String>,
    /// The formula is exactly one cell: its display is that cell's formatted text.
    pub single_cell: Option<(identity::SheetId, u32, u32)>,
    /// The formula is exactly one measure ref (its display uses the model format).
    pub single_measure: Option<String>,
    /// Table-less `[Name]` refs (measures of `model`), deduplicated.
    pub measure_refs: Vec<String>,
    /// Single cells read (after defined names are expanded).
    pub cells: Vec<(identity::SheetId, u32, u32)>,
    /// Ranges / whole columns / whole rows read, as boxes
    /// (sheet, start_row, start_col, end_row, end_col).
    pub boxes: Vec<(identity::SheetId, u32, u32, u32, u32)>,
    /// Defined names read (UPPERCASE), defined or not yet defined.
    pub names: Vec<String>,
    /// Reads cells the formula text does not name, or whose extent moves
    /// (INDIRECT, OFFSET over a computed start, GETPIVOTDATA, GET.CONTROLVALUE,
    /// a table or spill reference, a volatile function): re-evaluated on every
    /// cell change.
    pub volatile: bool,
    /// The literal-argument CUBE calls of the formula, each with the key the
    /// evaluator will look it up by (`measures::cube_calls`). The measure pass
    /// prefetches them; a key with no prefetched result yet is PENDING.
    pub cube_calls: Vec<super::measures::CubeCall>,
}

/// What a measure ref resolves to in one pass. Produced by the measure pass
/// (`measures.rs`, which owns the cache and its filter signature); consumed
/// here by [`evaluate_one`].
#[derive(Debug, Clone, PartialEq)]
pub enum MeasureOutcome {
    /// A number and the model-formatted text of it.
    Number(f64, String),
    Text(String),
    /// The measure has no value under the page's filters.
    Blank,
    /// The engine refused the read (row-level security, a policy) -- a sentence.
    Refused(String),
    /// The read failed (query error, unknown measure) -- a sentence.
    Failed(String),
    /// The binding's model key names no connection with a loaded model -- a
    /// sentence. Displayed as "(model not connected)".
    NotConnected(String),
}

/// What a bound property shows while its model is not connected.
pub const MODEL_NOT_CONNECTED_DISPLAY: &str = "(model not connected)";

/// What a bound property shows when the model's security refused the read.
pub const REFUSED_DISPLAY: &str = "(Refused)";

/// Binding state derived from the store and the session. Never saved; reset on
/// File > New / Open; held in a bare `Mutex` (a derived cache, D §9 D1).
#[derive(Debug, Default)]
pub struct BindingRuntime {
    /// Every stored binding, prepared for evaluation.
    pub prepared: HashMap<BindingKey, PreparedBinding>,
    /// Single-cell dependencies: (sheet, row, col) -> the bindings that read it.
    pub cell_dependents: HashMap<(identity::SheetId, u32, u32), HashSet<BindingKey>>,
    /// Ranges / whole columns / whole rows as boxes:
    /// (sheet, start_row, start_col, end_row, end_col, binding).
    pub range_dependents: Vec<(identity::SheetId, u32, u32, u32, u32, BindingKey)>,
    /// Defined-name dependencies: UPPERCASE name -> the bindings that read it.
    pub name_dependents: HashMap<String, HashSet<BindingKey>>,
    /// Bindings that read cells their text does not name (see
    /// [`PreparedBinding::volatile`]): part of every cell-change scope.
    pub volatile_dependents: HashSet<BindingKey>,
    /// The last value of every binding, diffed by `reevaluate` before it announces.
    pub resolved: HashMap<BindingKey, ResolvedBinding>,
    /// The page-filter mirror: (page, connection id) -> its filters. The
    /// frontend (`@api/pageFilters`) stays the authority; this is a copy.
    pub page_filters: HashMap<(identity::SheetId, String), Vec<PageFilterWire>>,
    /// Measure values fetched by the measure pass, keyed by (page, connection
    /// id, UPPERCASE measure, filter signature of the page's filters when
    /// fetched). A pass reads ONLY the entry of the page's CURRENT signature,
    /// so a filter change shows `pending` until the new value arrives, never
    /// the old filter's number.
    pub measure_cache: HashMap<super::measures::MeasureKey, MeasureOutcome>,
    /// How the measure pass last resolved each binding MODEL KEY: the
    /// connection id it names, or `None` = no connection with a loaded model
    /// (the binding shows "(model not connected)"). A key absent here has not
    /// been resolved yet (its measures are pending).
    pub measure_models: HashMap<String, Option<String>>,
    /// Literal-argument CUBE results prefetched for the bindings (NOT filtered
    /// by the page, exactly as in a cell), keyed by `engine::cube_call_key`.
    pub cube_prefetch: Arc<engine::CubePrefetch>,
    /// The sheet list the dependency maps were built for.
    pub built_for_sheets: Vec<identity::SheetId>,
    /// `BindingStore::generation` the maps were built for.
    pub built_for_generation: u64,
    /// False until the first build, and again whenever something the prepared
    /// maps depend on moved without a store write (a defined name repointed).
    pub built: bool,
}

impl BindingRuntime {
    /// True when this runtime was built from the store generation `generation`
    /// over the sheet list `sheets` -- i.e. no rebuild is needed.
    pub fn is_current(&self, generation: u64, sheets: &[identity::SheetId]) -> bool {
        self.built && self.built_for_generation == generation && self.built_for_sheets == sheets
    }

    /// Install a fresh preparation: the prepared map, every dependency map, and
    /// the resolved cache pruned to the bindings that still exist.
    fn install(&mut self, prepared: HashMap<BindingKey, PreparedBinding>, generation: u64, sheets: Vec<identity::SheetId>) {
        self.cell_dependents.clear();
        self.range_dependents.clear();
        self.name_dependents.clear();
        self.volatile_dependents.clear();
        for (key, p) in &prepared {
            for cell in &p.cells {
                self.cell_dependents.entry(*cell).or_default().insert(key.clone());
            }
            for (sheet, r0, c0, r1, c1) in &p.boxes {
                self.range_dependents.push((*sheet, *r0, *c0, *r1, *c1, key.clone()));
            }
            for name in &p.names {
                self.name_dependents.entry(name.clone()).or_default().insert(key.clone());
            }
            if p.volatile {
                self.volatile_dependents.insert(key.clone());
            }
        }
        self.resolved.retain(|k, _| prepared.contains_key(k));
        self.prepared = prepared;
        self.built_for_generation = generation;
        self.built_for_sheets = sheets;
        self.built = true;
    }

    /// The fetched value of measure `name` of model `model` on `page`, under
    /// the page's CURRENT filters -- `None` when it has not been fetched for
    /// them (pending). A model key the pass resolved to no connection answers
    /// [`MeasureOutcome::NotConnected`] for every measure.
    pub fn measure_outcome(&self, page: identity::SheetId, model: &str, name: &str) -> Option<MeasureOutcome> {
        match self.measure_models.get(model)? {
            None => Some(MeasureOutcome::NotConnected(format!(
                "The model '{model}' that [{name}] is read from is not connected to this workbook. \
                 Connect it (Model > Connections) and the value follows."
            ))),
            Some(connection) => {
                let filters = self
                    .page_filters
                    .get(&(page, connection.clone()))
                    .map(Vec::as_slice)
                    .unwrap_or(&[]);
                let signature = super::measures::filter_signature(filters);
                self.measure_cache
                    .get(&(page, connection.clone(), name.to_uppercase(), signature))
                    .cloned()
            }
        }
    }

    /// The bindings a change of the cells `changed` can reach.
    fn keys_for_cells(&self, changed: &[(identity::SheetId, u32, u32)]) -> HashSet<BindingKey> {
        let mut out: HashSet<BindingKey> = self.volatile_dependents.clone();
        for cell in changed {
            if let Some(keys) = self.cell_dependents.get(cell) {
                out.extend(keys.iter().cloned());
            }
            let (sheet, row, col) = *cell;
            for (s, r0, c0, r1, c1, key) in &self.range_dependents {
                if *s == sheet && row >= *r0 && row <= *r1 && col >= *c0 && col <= *c1 {
                    out.insert(key.clone());
                }
            }
        }
        out
    }
}

/// What a pass re-evaluates.
#[derive(Debug, Clone, PartialEq)]
pub enum Scope {
    /// Every binding.
    All,
    /// The bindings that read any of these cells (plus every volatile one).
    Cells(Vec<(identity::SheetId, u32, u32)>),
    /// The bindings that read any of these defined names (any case). The names'
    /// definitions moved, so the dependency maps are rebuilt first.
    Names(Vec<String>),
    /// Exactly these bindings.
    Keys(Vec<BindingKey>),
    /// Every binding on these pages (a page-filter or measure change).
    Pages(Vec<identity::SheetId>),
}

// ---------------------------------------------------------------------------
// Preparation (store -> runtime)
// ---------------------------------------------------------------------------

/// The runtime is current for the store as it is now? Store -> runtime, both
/// released before returning.
fn runtime_is_current(state: &AppState, sheets: &[identity::SheetId]) -> bool {
    let Ok(store) = state.object_bindings.read() else { return true };
    let generation = store.generation;
    match state.object_binding_runtime.lock() {
        Ok(runtime) => runtime.is_current(generation, sheets),
        Err(_) => true,
    }
}

/// The stored rows and the generation they belong to. Store only.
fn store_rows(state: &AppState) -> Option<(u64, Vec<(BindingKey, StoredBinding)>)> {
    let store = state.object_bindings.read().ok()?;
    let rows = store.bindings.iter().map(|(k, b)| (k.clone(), b.clone())).collect();
    Some((store.generation, rows))
}

/// Install a preparation. Runtime only.
fn install_prepared(
    state: &AppState,
    prepared: HashMap<BindingKey, PreparedBinding>,
    generation: u64,
    sheets: Vec<identity::SheetId>,
) {
    if let Ok(mut runtime) = state.object_binding_runtime.lock() {
        runtime.install(prepared, generation, sheets);
    }
}

/// Mark the dependency maps stale (a defined name was repointed: the boxes it
/// expanded to moved without any store write). Runtime only.
fn mark_dependencies_stale(state: &AppState) {
    if let Ok(mut runtime) = state.object_binding_runtime.lock() {
        runtime.built = false;
    }
}

/// The data sheet of every chart that is bound, keyed by chart id.
fn chart_data_sheets(
    state: &AppState,
    rows: &[(BindingKey, StoredBinding)],
    world: &FormulaWorld,
) -> HashMap<String, usize> {
    let wanted: HashSet<&str> = rows
        .iter()
        .filter(|(k, _)| k.object.kind == crate::api_types::ObjectBindingKind::Chart)
        .map(|(k, _)| k.object.id.as_str())
        .collect();
    if wanted.is_empty() {
        return HashMap::new();
    }
    let specs: Vec<(String, String)> = match state.charts.read() {
        Ok(charts) => charts
            .iter()
            .filter(|c| wanted.contains(c.id.to_string().as_str()))
            .map(|c| (c.id.to_string(), c.spec_json.clone()))
            .collect(),
        Err(_) => Vec::new(),
    };
    specs
        .into_iter()
        .filter_map(|(id, spec)| {
            formula::chart_data_sheet(&spec, &world.sheet_names, &world.sheet_ids).map(|i| (id, i))
        })
        .collect()
}

/// Rebuild the runtime from the store when it is not current (D §3.3 rule 4):
/// the sheet table, the object locations and the naming authorities are copied
/// OUT first, each lock released; then the store is read and released; the
/// formulas are prepared holding nothing; the runtime alone is written last.
///
/// Called at the top of [`reevaluate`] and of every runtime READ (trace,
/// summary, list_object_properties).
pub fn ensure_prepared(cx: &ObjectStores<'_>) {
    let sheet_ids: Vec<identity::SheetId> = cx.state.sheet_ids.read().map(|g| g.clone()).unwrap_or_default();
    if runtime_is_current(cx.state, &sheet_ids) {
        return;
    }
    let world = FormulaWorld::read(cx.state);
    let locations: HashMap<ObjectBindingRef, ObjectLocation> =
        object_json::object_locations(cx).into_iter().collect();
    let Some((generation, rows)) = store_rows(cx.state) else { return };
    let chart_sheets = chart_data_sheets(cx.state, &rows, &world);

    let prepared: HashMap<BindingKey, PreparedBinding> = rows
        .iter()
        .map(|(key, stored)| {
            let host = locations.get(&key.object).map(|l| l.sheet_index);
            let chart_sheet = chart_sheets.get(&key.object.id).copied();
            (key.clone(), prepare_one(key, stored, host, chart_sheet, &world))
        })
        .collect();
    install_prepared(cx.state, prepared, generation, world.sheet_ids.clone());
}

/// Prepare one stored binding. Pure.
///
/// `host` is the object's sheet when it exists; an object that does not exist
/// (yet: an undo may bring it back) is prepared against the first worksheet so
/// its dependencies are still known, and simply not evaluated while absent.
pub fn prepare_one(
    key: &BindingKey,
    stored: &StoredBinding,
    host: Option<usize>,
    chart_data_sheet: Option<usize>,
    world: &FormulaWorld,
) -> PreparedBinding {
    let mut out = PreparedBinding {
        formula: stored.formula.clone(),
        model: stored.model.clone(),
        ast: None,
        value_type: None,
        error: None,
        single_cell: None,
        single_measure: None,
        measure_refs: Vec::new(),
        cells: Vec::new(),
        boxes: Vec::new(),
        names: Vec::new(),
        volatile: false,
        cube_calls: Vec::new(),
    };
    match catalog::match_path(key.object.kind, &key.path) {
        Ok(row) => out.value_type = Some(row.value_type),
        Err(reason) => {
            out.error = Some(reason);
            return out;
        }
    }
    let host_index = host.unwrap_or(0);
    let no_models: [(String, Vec<String>); 0] = [];
    let cx = match world.context(host_index, chart_data_sheet, &no_models, None) {
        Ok(cx) => cx,
        Err(reason) => {
            out.error = Some(reason);
            return out;
        }
    };
    let normalized = match formula::prepare_stored(&stored.formula, &cx, stored.model.as_deref()) {
        Ok(n) => n,
        Err(reason) => {
            out.error = Some(reason);
            return out;
        }
    };
    let mut ast = normalized.ast;
    crate::expand_wildcard_sheets(&mut ast);

    out.single_cell = match &ast {
        Expression::CellRef { sheet: Some(s), col, row, .. } => world
            .sheet_names
            .iter()
            .position(|n| n.eq_ignore_ascii_case(s))
            .and_then(|i| world.sheet_ids.get(i))
            .map(|id| (*id, row.saturating_sub(1), col_index(col))),
        _ => None,
    };
    out.single_measure = formula::measure_ref_name(&ast).map(str::to_string);
    out.measure_refs = normalized.analysis.measure_refs.clone();
    if normalized.analysis.uses_cube {
        out.cube_calls = super::measures::cube_calls(&ast);
    }

    // Dependencies are read through the names: `=Rate*2` with Rate = Inputs!B1
    // depends on Inputs!B1, and on the NAME (so repointing Rate re-evaluates).
    let mut names = HashSet::new();
    crate::name_resolution::collect_names(&ast, &mut names);
    let mut names: Vec<String> = names.into_iter().collect();
    names.sort();
    out.names = names;
    let expanded = if crate::name_resolution::needs_name_resolution(&ast, &world.named_ranges) {
        let mut visited = HashSet::new();
        crate::resolve_names_in_ast(&ast, &world.named_ranges, host_index, &mut visited)
    } else {
        ast.clone()
    };
    let host_id = world.sheet_ids.get(host_index).copied();
    let mut deps = Deps { names: &world.sheet_names, ids: &world.sheet_ids, host: host_id, cells: Vec::new(), boxes: Vec::new(), volatile: false };
    deps.walk(&expanded);
    out.cells = deps.cells;
    out.boxes = deps.boxes;
    out.volatile = deps.volatile;
    out.ast = Some(ast);
    out
}

/// Excel column letters to a 0-based index (`A` -> 0, `AA` -> 26).
fn col_index(col: &str) -> u32 {
    let mut n: u32 = 0;
    for c in col.chars() {
        if c.is_ascii_alphabetic() {
            n = n * 26 + (c.to_ascii_uppercase() as u32 - 'A' as u32 + 1);
        }
    }
    n.saturating_sub(1)
}

/// The dependency walk over a name-expanded AST. Keys are SheetId-based and
/// sheet names are matched case-insensitively against the workbook's list (the
/// lexer upper-cases bare names; `normalize_cross_sheet_refs`'s rule), so a
/// rename -- of case or of anything -- keeps the edge.
struct Deps<'a> {
    names: &'a [String],
    ids: &'a [identity::SheetId],
    host: Option<identity::SheetId>,
    cells: Vec<(identity::SheetId, u32, u32)>,
    boxes: Vec<(identity::SheetId, u32, u32, u32, u32)>,
    volatile: bool,
}

impl Deps<'_> {
    fn sheet(&self, name: Option<&String>) -> Option<identity::SheetId> {
        match name {
            None => self.host,
            Some(n) => self.names.iter().position(|s| s.eq_ignore_ascii_case(n)).and_then(|i| self.ids.get(i).copied()),
        }
    }

    fn sheets_between(&self, a: &str, b: &str) -> Vec<identity::SheetId> {
        // `'*'!A1` (expanded to a 3D reference over `*`) reads every sheet, so
        // a change on ANY sheet reaches it -- an empty edge list would freeze it.
        if formula::is_all_sheets_wildcard(a) || formula::is_all_sheets_wildcard(b) {
            return self.ids.to_vec();
        }
        let ia = self.names.iter().position(|s| s.eq_ignore_ascii_case(a));
        let ib = self.names.iter().position(|s| s.eq_ignore_ascii_case(b));
        match (ia, ib) {
            (Some(x), Some(y)) => (x.min(y)..=x.max(y)).filter_map(|i| self.ids.get(i).copied()).collect(),
            _ => Vec::new(),
        }
    }

    /// The box a positional reference covers, with no sheet.
    fn shape(expr: &Expression) -> Option<(u32, u32, u32, u32)> {
        match expr {
            Expression::CellRef { col, row, .. } => {
                let (r, c) = (row.saturating_sub(1), col_index(col));
                Some((r, c, r, c))
            }
            Expression::Range { start, end, .. } => match (start.as_ref(), end.as_ref()) {
                (
                    Expression::CellRef { col: c0, row: r0, .. },
                    Expression::CellRef { col: c1, row: r1, .. },
                ) => {
                    let (r0, r1) = (r0.saturating_sub(1), r1.saturating_sub(1));
                    let (c0, c1) = (col_index(c0), col_index(c1));
                    Some((r0.min(r1), c0.min(c1), r0.max(r1), c0.max(c1)))
                }
                _ => None,
            },
            Expression::ColumnRef { start_col, end_col, .. } => {
                let (a, b) = (col_index(start_col), col_index(end_col));
                Some((0, a.min(b), u32::MAX, a.max(b)))
            }
            Expression::RowRef { start_row, end_row, .. } => {
                let (a, b) = (start_row.saturating_sub(1), end_row.saturating_sub(1));
                Some((a.min(b), 0, a.max(b), u32::MAX))
            }
            _ => None,
        }
    }

    fn add(&mut self, sheet: Option<identity::SheetId>, shape: (u32, u32, u32, u32)) {
        let Some(sheet) = sheet else {
            // A sheet that does not exist reads nothing (#REF!), so nothing to watch.
            return;
        };
        let (r0, c0, r1, c1) = shape;
        if r0 == r1 && c0 == c1 {
            self.cells.push((sheet, r0, c0));
        } else {
            self.boxes.push((sheet, r0, c0, r1, c1));
        }
    }

    fn walk(&mut self, expr: &Expression) {
        match expr {
            Expression::CellRef { sheet, .. } | Expression::ColumnRef { sheet, .. } | Expression::RowRef { sheet, .. } => {
                let id = self.sheet(sheet.as_ref());
                if let Some(shape) = Self::shape(expr) {
                    self.add(id, shape);
                }
            }
            Expression::Range { sheet, start, end, .. } => match Self::shape(expr) {
                Some(shape) => {
                    let id = self.sheet(sheet.as_ref());
                    self.add(id, shape);
                }
                None => {
                    // A corner computed by a function: its extent is not in the text.
                    self.volatile = true;
                    self.walk(start);
                    self.walk(end);
                }
            },
            Expression::Sheet3DRef { start_sheet, end_sheet, reference, .. } => match Self::shape(reference) {
                Some(shape) => {
                    for id in self.sheets_between(start_sheet, end_sheet) {
                        self.add(Some(id), shape);
                    }
                }
                None => self.volatile = true,
            },
            Expression::FunctionCall { func, args, .. } => {
                if engine::volatility::is_volatile_builtin(func) || formula::is_indirect_call(func, args) {
                    self.volatile = true;
                }
                for a in args {
                    self.walk(a);
                }
            }
            // A table's extent and a spilled array's extent move without the
            // formula changing: re-read on every cell change.
            Expression::TableRef { table_name, .. } => {
                if !table_name.is_empty() {
                    self.volatile = true;
                }
            }
            Expression::SpillRef { cell, .. } => {
                self.volatile = true;
                self.walk(cell);
            }
            Expression::BinaryOp { left, right, .. } => {
                self.walk(left);
                self.walk(right);
            }
            Expression::UnaryOp { operand, .. } => self.walk(operand),
            Expression::IndexAccess { target, index } => {
                self.walk(target);
                self.walk(index);
            }
            Expression::ArrayLiteral { rows } => {
                for e in rows.iter().flatten() {
                    self.walk(e);
                }
            }
            Expression::ListLiteral { elements } => {
                for e in elements {
                    self.walk(e);
                }
            }
            Expression::DictLiteral { entries } => {
                for (k, v) in entries {
                    self.walk(k);
                    self.walk(v);
                }
            }
            Expression::ImplicitIntersection { operand } => self.walk(operand),
            Expression::Literal(_) | Expression::NamedRef { .. } => {}
        }
    }
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/// One binding as a pass evaluates it: everything copied, nothing borrowed
/// from a lock.
#[derive(Debug, Clone)]
pub struct PassInput {
    pub key: BindingKey,
    pub ast: Option<Expression>,
    pub error: Option<String>,
    pub value_type: BindableValueType,
    /// The object's sheet: name scope and the evaluator's current sheet.
    pub host_sheet_index: usize,
    /// The single cell the formula is, as a sheet INDEX (resolved this pass).
    pub single_cell: Option<(usize, u32, u32)>,
    pub single_measure: Option<String>,
    /// UPPERCASE measure name -> its value this pass. A measure ref with no
    /// entry is PENDING.
    pub measures: HashMap<String, MeasureOutcome>,
    /// The prefetched CUBE results, when the formula calls a CUBE function.
    pub cube: Option<Arc<engine::CubePrefetch>>,
    /// A CUBE call of the formula has no prefetched result yet.
    pub cube_pending: bool,
    /// The model's security refused a CUBE call of the formula -- a sentence.
    pub cube_refusal: Option<String>,
}

/// The measure values a pass substitutes for one binding's `[Measure]` refs,
/// read from the runtime's `measure_cache` (filled by `measures.rs`) under the
/// page's CURRENT filter signature. A measure with no entry is left out: the
/// ref evaluates as pending -- never a stale number presented as current.
fn cached_measures(
    runtime: &BindingRuntime,
    page: identity::SheetId,
    model: Option<&str>,
    measures: &[String],
) -> HashMap<String, MeasureOutcome> {
    let mut out = HashMap::new();
    for name in measures {
        let outcome = match model {
            Some(model) => runtime.measure_outcome(page, model, name),
            // Every row Set stores names its model; a row without one (edited
            // by hand) cannot be read from any model.
            None => Some(MeasureOutcome::Failed(format!(
                "[{name}] names a model measure, but this binding does not say which model to read it from. \
                 Bind the property again to choose one."
            ))),
        };
        if let Some(outcome) = outcome {
            out.insert(name.to_uppercase(), outcome);
        }
    }
    out
}

/// What the prefetched CUBE results say about one binding's calls: whether one
/// is still missing (pending) and whether the model refused one.
fn cube_state(runtime: &BindingRuntime, calls: &[super::measures::CubeCall]) -> (bool, Option<String>) {
    let mut pending = false;
    let mut refusal = None;
    for call in calls {
        match runtime.cube_prefetch.results.get(&call.key) {
            None => pending = true,
            Some(engine::CubeCallResult::Error(engine::CubeError::Refused)) => {
                refusal.get_or_insert_with(|| crate::bi::cube::cube_err_message(engine::CubeError::Refused));
            }
            Some(_) => {}
        }
    }
    (pending, refusal)
}

/// The keys `scope` reaches, from the runtime's maps.
fn keys_in_scope(
    runtime: &BindingRuntime,
    scope: &Scope,
    locations: &HashMap<ObjectBindingRef, ObjectLocation>,
) -> Vec<BindingKey> {
    let mut keys: Vec<BindingKey> = match scope {
        Scope::All => runtime.prepared.keys().cloned().collect(),
        Scope::Cells(cells) => runtime.keys_for_cells(cells).into_iter().collect(),
        Scope::Names(names) => {
            let mut out: HashSet<BindingKey> = HashSet::new();
            for n in names {
                if let Some(keys) = runtime.name_dependents.get(&n.to_uppercase()) {
                    out.extend(keys.iter().cloned());
                }
            }
            out.into_iter().collect()
        }
        Scope::Keys(keys) => keys.iter().filter(|k| runtime.prepared.contains_key(*k)).cloned().collect(),
        Scope::Pages(pages) => runtime
            .prepared
            .keys()
            .filter(|k| locations.get(&k.object).is_some_and(|l| pages.contains(&l.sheet_id)))
            .cloned()
            .collect(),
    };
    keys.sort();
    keys
}

/// What one pass works on, copied out of the runtime.
struct PassSelection {
    /// The bindings to evaluate.
    inputs: Vec<PassInput>,
    /// Bindings whose object does not exist: their stale values are dropped.
    orphans: Vec<BindingKey>,
    /// DORMANT bindings (D §3.18a): a Page Navigator's per-button binding whose
    /// page key names no live report page. Resolved to nothing -- not pending,
    /// no value, no error -- and never evaluated; kept, so an undo that brings
    /// the page back brings the binding back.
    dormant: Vec<ResolvedBinding>,
}

/// Is `key` a per-button navigator binding whose page is not live?
fn is_dormant(key: &BindingKey, pages: &super::page_overrides::ReportPages) -> bool {
    key.object.kind == crate::api_types::ObjectBindingKind::Control
        && super::page_overrides::per_button_path(&key.path).is_some_and(|p| pages.resolve(&p.page_key).is_none())
}

/// Copy out what a pass evaluates (D §3.7 step 1). Runtime only, released on
/// return. Bindings whose object does not exist are returned separately: their
/// stale resolved values are dropped, never evaluated; dormant ones resolve to
/// nothing.
fn select_for_pass(
    state: &AppState,
    scope: &Scope,
    locations: &HashMap<ObjectBindingRef, ObjectLocation>,
    sheet_ids: &[identity::SheetId],
    pages: &super::page_overrides::ReportPages,
) -> PassSelection {
    let mut selection = PassSelection { inputs: Vec::new(), orphans: Vec::new(), dormant: Vec::new() };
    let Ok(runtime) = state.object_binding_runtime.lock() else { return selection };
    let PassSelection { inputs, orphans, dormant } = &mut selection;
    for key in keys_in_scope(&runtime, scope, locations) {
        let Some(p) = runtime.prepared.get(&key) else { continue };
        let Some(loc) = locations.get(&key.object) else {
            orphans.push(key);
            continue;
        };
        if is_dormant(&key, pages) {
            dormant.push(resolved(&key, Value::Null, String::new(), None, false));
            continue;
        }
        let single_cell = p.single_cell.and_then(|(id, r, c)| {
            sheet_ids.iter().position(|s| *s == id).map(|i| (i, r, c))
        });
        let measures = if p.measure_refs.is_empty() {
            HashMap::new()
        } else {
            cached_measures(&runtime, loc.sheet_id, p.model.as_deref(), &p.measure_refs)
        };
        let (cube, cube_pending, cube_refusal) = if p.cube_calls.is_empty() {
            (None, false, None)
        } else {
            let (pending, refusal) = cube_state(&runtime, &p.cube_calls);
            (Some(runtime.cube_prefetch.clone()), pending, refusal)
        };
        inputs.push(PassInput {
            key: key.clone(),
            ast: p.ast.clone(),
            error: p.error.clone(),
            value_type: p.value_type.unwrap_or(BindableValueType::Text),
            host_sheet_index: loc.sheet_index,
            single_cell,
            single_measure: p.single_measure.clone(),
            measures,
            cube,
            cube_pending,
            cube_refusal,
        });
    }
    drop(runtime);
    selection
}

/// Write the pass's values into the runtime and return the ones that CHANGED
/// (D §3.7 step 7). Runtime only.
fn write_back(state: &AppState, results: Vec<ResolvedBinding>, orphans: &[BindingKey]) -> Vec<ResolvedBinding> {
    let Ok(mut runtime) = state.object_binding_runtime.lock() else { return Vec::new() };
    for key in orphans {
        runtime.resolved.remove(key);
    }
    let mut changed = Vec::new();
    for value in results {
        let key = BindingKey { object: value.object.clone(), path: value.path.clone() };
        if !runtime.prepared.contains_key(&key) {
            // Unbound while the pass ran: its value must not come back.
            continue;
        }
        if runtime.resolved.get(&key) != Some(&value) {
            runtime.resolved.insert(key, value.clone());
            changed.push(value);
        }
    }
    changed
}

/// The media hashes of the document, copied -- only when a Media-typed binding
/// is about to be evaluated (a binding may REFERENCE media, never introduce it).
fn media_hashes(state: &AppState, inputs: &[PassInput]) -> Option<HashSet<String>> {
    if !inputs.iter().any(|i| i.value_type == BindableValueType::Media) {
        return None;
    }
    state.media.read().ok().map(|m| m.keys().cloned().collect())
}

/// THE ONE re-evaluation entry point (D §3.7). Rebuilds the runtime if the
/// store moved, evaluates `scope`, diffs against the last values, announces
/// only real changes (`reload: false`) and returns them.
///
/// Callers are pinned by the S3b census `reevaluate_has_only_the_declared_callers`:
/// the `object_bindings` command ops and the MCP binding tool. Never the load
/// path, the undo arm, a cascade or a structural shift (they hold canonical
/// locks or no pane/filter state; they bump the generation and announce a
/// reload instead).
pub fn reevaluate(
    cx: &ObjectStores<'_>,
    pane_control_state: &PaneControlState,
    ribbon_filter_state: &RibbonFilterState,
    scope: Scope,
) -> Vec<ResolvedBinding> {
    if matches!(scope, Scope::Names(_)) {
        mark_dependencies_stale(cx.state);
    }
    ensure_prepared(cx);

    let locations: HashMap<ObjectBindingRef, ObjectLocation> =
        object_json::object_locations(cx).into_iter().collect();
    let sheet_ids: Vec<identity::SheetId> = cx.state.sheet_ids.read().map(|g| g.clone()).unwrap_or_default();
    // The live report pages (each sheet-table lock released): a navigator's
    // per-button binding on a page that is gone is dormant (D §3.18a).
    let pages = super::page_overrides::ReportPages::read(cx.state);
    let locale = cx
        .state
        .locale
        .lock()
        .map(|g| g.clone())
        .unwrap_or_else(|_| LocaleSettings::invariant());
    let PassSelection { inputs, orphans, dormant } = select_for_pass(cx.state, &scope, &locations, &sheet_ids, &pages);
    if inputs.is_empty() && orphans.is_empty() && dormant.is_empty() {
        return Vec::new();
    }
    let media = media_hashes(cx.state, &inputs);
    let control_values = if inputs.is_empty() {
        Arc::new(ControlValuesMap::new())
    } else {
        crate::control_values::build_control_values(cx.state, pane_control_state, ribbon_filter_state)
    };
    let mut results = if inputs.is_empty() {
        Vec::new()
    } else {
        evaluate_pass(cx.state, &inputs, &control_values, &locale, media.as_ref())
    };
    results.extend(dormant);
    let changed = write_back(cx.state, results, &orphans);
    if !changed.is_empty() {
        super::announce(ObjectBindingsChangedPayload { values: changed.clone(), reload: false });
    }
    changed
}

/// Everything one pass holds while the grid locks are held. Borrowed from the
/// guards `evaluate_pass` took.
pub struct PassContext<'a> {
    /// One grid per sheet, the ACTIVE sheet's slot being the live `state.grid`
    /// mirror (`grids[active]` is stale while the sheet is active).
    pub slots: Vec<&'a Grid>,
    pub sheet_names: &'a [String],
    pub styles: &'a engine::StyleRegistry,
    pub name_tables: crate::name_resolution::NameTables<'a>,
    pub control_values: &'a Arc<ControlValuesMap>,
    pub locale: &'a LocaleSettings,
    pub media: Option<&'a HashSet<String>>,
}

impl PassContext<'_> {
    fn multi_sheet(&self, current: usize) -> MultiSheetContext<'_> {
        let current_name = self.sheet_names.get(current).cloned().unwrap_or_default();
        let mut context = MultiSheetContext::new(current_name);
        for (i, grid) in self.slots.iter().enumerate() {
            if let Some(name) = self.sheet_names.get(i) {
                context.add_grid(name.clone(), *grid);
            }
        }
        context.sheet_order = self.sheet_names.to_vec();
        context
    }

    /// A cell's formatted display (its number format, the user's locale).
    fn cell_display(&self, sheet: usize, row: u32, col: u32) -> Option<String> {
        let grid = self.slots.get(sheet)?;
        Some(match grid.get_cell(row, col) {
            Some(cell) => crate::format_cell_value(
                &cell.value,
                self.styles.get(grid.effective_style_index(row, col)),
                self.locale,
            ),
            None => String::new(),
        })
    }
}

/// The grid-locking pass (D §3.7 steps 3-6). Takes ONLY copied inputs and NEVER
/// names the binding store or its runtime (`binding_locks_are_leaves`). Lock
/// order: grid -> grids -> active_sheet -> sheet_names -> style_registry ->
/// tables -> table_names -> named_ranges (the recalculation pass's), every
/// guard released on return.
fn evaluate_pass(
    state: &AppState,
    inputs: &[PassInput],
    control_values: &Arc<ControlValuesMap>,
    locale: &LocaleSettings,
    media: Option<&HashSet<String>>,
) -> Vec<ResolvedBinding> {
    if inputs.is_empty() {
        return Vec::new();
    }
    let unavailable = |why: &str| -> Vec<ResolvedBinding> {
        inputs
            .iter()
            .map(|i| failed(&i.key, "#VALUE!", format!("The workbook could not be read ({why}).")))
            .collect()
    };
    let _governor = crate::eval_budget::install(crate::eval_budget::EvalSurface::Transient);
    let grid = match state.grid.read() {
        Ok(g) => g,
        Err(e) => return unavailable(&e.to_string()),
    };
    let grids = match state.grids.read() {
        Ok(g) => g,
        Err(e) => return unavailable(&e.to_string()),
    };
    let active = state.active_sheet.read().map(|g| *g).unwrap_or(0);
    let sheet_names = match state.sheet_names.read() {
        Ok(g) => g,
        Err(e) => return unavailable(&e.to_string()),
    };
    let styles = match state.style_registry.read() {
        Ok(g) => g,
        Err(e) => return unavailable(&e.to_string()),
    };
    let tables = match state.tables.read() {
        Ok(g) => g,
        Err(e) => return unavailable(&e.to_string()),
    };
    let table_names = match state.table_names.read() {
        Ok(g) => g,
        Err(e) => return unavailable(&e.to_string()),
    };
    let named_ranges = match state.named_ranges.read() {
        Ok(g) => g,
        Err(e) => return unavailable(&e.to_string()),
    };

    let slots: Vec<&Grid> = (0..grids.len())
        .map(|i| if i == active { &*grid } else { &grids[i] })
        .collect();
    let pass = PassContext {
        slots,
        sheet_names: &sheet_names,
        styles: &styles,
        name_tables: crate::name_resolution::NameTables {
            named_ranges: &named_ranges,
            tables: &tables,
            table_names: &table_names,
            sheet_names: &sheet_names,
            spill_ranges: &state.spill_ranges,
        },
        control_values,
        locale,
        media,
    };
    inputs.iter().map(|input| evaluate_one(&pass, input)).collect()
}

fn resolved(key: &BindingKey, value: Value, display: String, error: Option<String>, pending: bool) -> ResolvedBinding {
    ResolvedBinding { object: key.object.clone(), path: key.path.clone(), value, display, error, pending }
}

fn failed(key: &BindingKey, display: &str, error: String) -> ResolvedBinding {
    resolved(key, Value::Null, display.to_string(), Some(error), false)
}

/// Replace every measure ref by its value this pass. Returns the refusal /
/// failure sentence that decides the whole binding, and whether any ref was
/// still pending.
fn substitute_measures(
    expr: &mut Expression,
    measures: &HashMap<String, MeasureOutcome>,
    pending: &mut bool,
    stop: &mut Option<(String, String)>,
) {
    let measure: Option<String> = formula::measure_ref_name(expr).map(str::to_uppercase);
    if let Some(name) = measure {
        let literal = match measures.get(&name) {
            Some(MeasureOutcome::Number(n, _)) => engine::Value::Number(*n),
            Some(MeasureOutcome::Text(s)) => engine::Value::String(s.clone()),
            Some(MeasureOutcome::Blank) => engine::Value::String(String::new()),
            Some(MeasureOutcome::Refused(why)) => {
                stop.get_or_insert((REFUSED_DISPLAY.to_string(), why.clone()));
                engine::Value::Error("#N/A".to_string())
            }
            Some(MeasureOutcome::Failed(why)) => {
                stop.get_or_insert(("#N/A".to_string(), why.clone()));
                engine::Value::Error("#N/A".to_string())
            }
            Some(MeasureOutcome::NotConnected(why)) => {
                stop.get_or_insert((MODEL_NOT_CONNECTED_DISPLAY.to_string(), why.clone()));
                engine::Value::Error("#N/A".to_string())
            }
            None => {
                *pending = true;
                engine::Value::Error("#N/A".to_string())
            }
        };
        *expr = Expression::Literal(literal);
        return;
    }
    match expr {
        Expression::Range { start, end, .. } => {
            substitute_measures(start, measures, pending, stop);
            substitute_measures(end, measures, pending, stop);
        }
        Expression::BinaryOp { left, right, .. } => {
            substitute_measures(left, measures, pending, stop);
            substitute_measures(right, measures, pending, stop);
        }
        Expression::UnaryOp { operand, .. } | Expression::ImplicitIntersection { operand } => {
            substitute_measures(operand, measures, pending, stop)
        }
        Expression::FunctionCall { args, .. } => {
            for a in args {
                substitute_measures(a, measures, pending, stop);
            }
        }
        Expression::IndexAccess { target, index } => {
            substitute_measures(target, measures, pending, stop);
            substitute_measures(index, measures, pending, stop);
        }
        Expression::ArrayLiteral { rows } => {
            for e in rows.iter_mut().flatten() {
                substitute_measures(e, measures, pending, stop);
            }
        }
        Expression::ListLiteral { elements } => {
            for e in elements {
                substitute_measures(e, measures, pending, stop);
            }
        }
        Expression::DictLiteral { entries } => {
            for (k, v) in entries {
                substitute_measures(k, measures, pending, stop);
                substitute_measures(v, measures, pending, stop);
            }
        }
        _ => {}
    }
}

/// Evaluate ONE prepared binding inside a pass (D §3.7 steps 4-6).
pub fn evaluate_one(pass: &PassContext<'_>, input: &PassInput) -> ResolvedBinding {
    let key = &input.key;
    if let Some(reason) = &input.error {
        return failed(key, "#VALUE!", reason.clone());
    }
    let Some(mut ast) = input.ast.clone() else {
        return failed(key, "#VALUE!", "This binding has no formula to evaluate.".to_string());
    };
    let mut pending = false;
    let mut stop: Option<(String, String)> = None;
    substitute_measures(&mut ast, &input.measures, &mut pending, &mut stop);
    if let Some((display, why)) = stop {
        return failed(key, &display, why);
    }
    if let Some(why) = &input.cube_refusal {
        return failed(key, REFUSED_DISPLAY, why.clone());
    }
    if pending || input.cube_pending {
        return resolved(key, Value::Null, String::new(), None, true);
    }
    let host = input.host_sheet_index;
    let Some(current_grid) = pass.slots.get(host).or_else(|| pass.slots.first()).copied() else {
        return failed(key, "#REF!", "The workbook has no sheets to read.".to_string());
    };
    let names = pass.name_tables.at(host, 0, 0);
    let expanded = crate::name_resolution::eval_ast(&ast, &names);
    let mut evaluator = Evaluator::with_context(
        current_grid,
        pass.multi_sheet(host),
        EvalContext {
            control_values: Some(pass.control_values.clone()),
            cube_prefetch: input.cube.clone(),
            ..EvalContext::default()
        },
    );
    crate::eval_budget::apply(&mut evaluator);
    evaluator.set_styles(pass.styles);
    let value = evaluator.evaluate(&expanded).to_cell_value();

    let display = match (&input.single_cell, &input.single_measure) {
        (Some((sheet, row, col)), _) => pass
            .cell_display(*sheet, *row, *col)
            .unwrap_or_else(|| crate::format_cell_value_simple(&value)),
        (None, Some(measure)) => match input.measures.get(&measure.to_uppercase()) {
            Some(MeasureOutcome::Number(_, formatted)) => formatted.clone(),
            _ => crate::format_cell_value_simple(&value),
        },
        _ => crate::format_cell_value_simple(&value),
    };
    let coerced = coerce(input.value_type, &value, &display, pass.media);
    // A container colour paints only as hex (`visual_format::is_safe_color`):
    // a bound `rgb(...)` is converted here rather than ignored by the resolver.
    let value = super::container_literal::normalize_if_container_colour(key.object.kind, &key.path, coerced.value);
    resolved(key, value, coerced.display, coerced.error, false)
}

// ---------------------------------------------------------------------------
// Coercion (D §3.7 step 5)
// ---------------------------------------------------------------------------

/// A value made into the catalog type of its property.
#[derive(Debug, Clone, PartialEq)]
pub struct Coerced {
    /// Typed per the row (number, string, bool); `Null` on error.
    pub value: Value,
    /// What a text slot shows.
    pub display: String,
    /// A full sentence when the value cannot be of the row's type.
    pub error: Option<String>,
}

fn ok(value: Value, display: String) -> Coerced {
    Coerced { value, display, error: None }
}

fn bad(display: &str, error: String) -> Coerced {
    Coerced { value: Value::Null, display: display.to_string(), error: Some(error) }
}

fn cap_text(s: &str) -> String {
    if s.chars().count() <= MAX_RESOLVED_TEXT_CHARS {
        s.to_string()
    } else {
        s.chars().take(MAX_RESOLVED_TEXT_CHARS).collect()
    }
}

fn number_of(value: &CellValue) -> Result<f64, String> {
    match value {
        CellValue::Number(n) if n.is_finite() => Ok(*n),
        CellValue::Number(_) => Err("The formula returns a number that is not finite.".to_string()),
        CellValue::Boolean(b) => Ok(if *b { 1.0 } else { 0.0 }),
        CellValue::Empty => Ok(0.0),
        CellValue::Text(s) => {
            let t = s.trim();
            if t.is_empty() {
                return Ok(0.0);
            }
            t.parse::<f64>()
                .ok()
                .filter(|n| n.is_finite())
                .ok_or_else(|| format!("'{}' is not a number.", cap_text(s)))
        }
        CellValue::List(_) | CellValue::Dict(_) => Err("The formula returns a collection, not a number.".to_string()),
        CellValue::Error(e) => Err(format!("The formula returns {}.", crate::cell_error_display(e))),
    }
}

fn text_of(value: &CellValue) -> Option<String> {
    match value {
        CellValue::Text(s) => Some(s.trim().to_string()),
        _ => None,
    }
}

/// `#RRGGBB`, `#RRGGBBAA`, `rgb(r, g, b)` or `rgba(r, g, b, a)` -- the colour
/// spellings a bound colour property accepts.
pub fn is_binding_color(s: &str) -> bool {
    let s = s.trim();
    if let Some(hex) = s.strip_prefix('#') {
        return (hex.len() == 6 || hex.len() == 8) && hex.chars().all(|c| c.is_ascii_hexdigit());
    }
    let lower = s.to_ascii_lowercase();
    let (body, want) = if let Some(b) = lower.strip_prefix("rgba(") {
        (b, 4)
    } else if let Some(b) = lower.strip_prefix("rgb(") {
        (b, 3)
    } else {
        return false;
    };
    let Some(body) = body.strip_suffix(')') else { return false };
    let parts: Vec<&str> = body.split(',').map(str::trim).collect();
    if parts.len() != want {
        return false;
    }
    let channel_ok = |p: &str| p.parse::<u16>().is_ok_and(|n| n <= 255);
    if !parts[..3].iter().all(|p| channel_ok(p)) {
        return false;
    }
    if want == 4 {
        return parts[3].parse::<f64>().is_ok_and(|a| (0.0..=1.0).contains(&a));
    }
    true
}

/// Make `value` (with its `display`) the catalog type `value_type`.
pub fn coerce(
    value_type: BindableValueType,
    value: &CellValue,
    display: &str,
    media: Option<&HashSet<String>>,
) -> Coerced {
    if let CellValue::Error(e) = value {
        let literal = crate::cell_error_display(e);
        return bad(&literal, format!("The formula returns {literal}."));
    }
    match value_type {
        BindableValueType::Text => {
            let text = cap_text(display);
            ok(Value::String(text.clone()), text)
        }
        BindableValueType::Number => match number_of(value) {
            Ok(n) => ok(serde_json::json!(n), display.to_string()),
            Err(why) => bad("#VALUE!", why),
        },
        BindableValueType::Integer => match number_of(value) {
            // f64::round is half AWAY from zero (2.5 -> 3, -2.5 -> -3).
            Ok(n) if n.abs() < 9.0e15 => ok(serde_json::json!(n.round() as i64), display.to_string()),
            Ok(_) => bad("#VALUE!", "The formula returns a number too large for a whole-number property.".to_string()),
            Err(why) => bad("#VALUE!", why),
        },
        BindableValueType::Boolean => match value {
            CellValue::Boolean(b) => ok(Value::Bool(*b), display.to_string()),
            CellValue::Number(n) => ok(Value::Bool(*n != 0.0), display.to_string()),
            CellValue::Empty => ok(Value::Bool(false), display.to_string()),
            CellValue::Text(s) if s.trim().eq_ignore_ascii_case("true") => ok(Value::Bool(true), display.to_string()),
            CellValue::Text(s) if s.trim().eq_ignore_ascii_case("false") || s.trim().is_empty() => {
                ok(Value::Bool(false), display.to_string())
            }
            CellValue::Text(s) => bad("#VALUE!", format!("'{}' is not TRUE or FALSE.", cap_text(s))),
            _ => bad("#VALUE!", "The formula returns a collection, not TRUE or FALSE.".to_string()),
        },
        BindableValueType::Color => match text_of(value) {
            Some(s) if is_binding_color(&s) => ok(Value::String(s.clone()), s),
            Some(s) => bad(
                "#VALUE!",
                format!("'{}' is not a colour: write #RRGGBB, #RRGGBBAA or rgb(r, g, b).", cap_text(&s)),
            ),
            None => bad("#VALUE!", "A colour property needs text such as #1F77B4.".to_string()),
        },
        BindableValueType::Enum(members) => {
            let text = text_of(value).unwrap_or_else(|| display.trim().to_string());
            match members.iter().find(|m| m.eq_ignore_ascii_case(&text)) {
                Some(m) => ok(Value::String((*m).to_string()), (*m).to_string()),
                None => bad(
                    "#VALUE!",
                    format!("'{}' is not one of: {}.", cap_text(&text), members.join(", ")),
                ),
            }
        }
        BindableValueType::Media => {
            let Some(s) = text_of(value) else {
                return bad("#VALUE!", "A picture property needs a media handle such as media:... .".to_string());
            };
            if s.to_ascii_lowercase().starts_with("data:") {
                return bad(
                    "#VALUE!",
                    "A bound picture must name media already in this document (media:...); a data: URI is never accepted."
                        .to_string(),
                );
            }
            match calcula_format::media::parse_media_ref(&s) {
                Some(hash) if media.is_some_and(|m| m.contains(hash)) =>ok(Value::String(s.clone()), s),
                Some(_) => bad("#VALUE!", format!("'{s}' names no media in this document.")),
                None => bad(
                    "#VALUE!",
                    format!("'{}' is not a media handle (media: followed by 64 hex digits).", cap_text(&s)),
                ),
            }
        }
        BindableValueType::Scalar => match value {
            CellValue::Number(n) if n.is_finite() => ok(serde_json::json!(n), display.to_string()),
            CellValue::Number(_) => bad("#VALUE!", "The formula returns a number that is not finite.".to_string()),
            CellValue::Boolean(b) => ok(Value::Bool(*b), display.to_string()),
            CellValue::Text(s) => {
                let t = cap_text(s);
                ok(Value::String(t.clone()), t)
            }
            CellValue::Empty => ok(serde_json::json!(0.0), display.to_string()),
            _ => bad("#VALUE!", "The formula returns a collection, not a single value.".to_string()),
        },
    }
}
