//! FILENAME: app/src-tauri/src/bi/cube.rs
//! PURPOSE: Async resolution of the Excel-style CUBE formula family against
//!          Calcula BI models (CUBEVALUE, CUBEMEMBER, CUBESET, CUBESETCOUNT,
//!          CUBERANKEDMEMBER, CUBEMEMBERPROPERTY, CUBEKPIMEMBER).
//!
//! CONTEXT: The formula evaluator (core/engine) is synchronous, but BI model
//! queries are async (`Connection.engine: Arc<TokioMutex<bi_engine::Engine>>`).
//! Following the GETPIVOTDATA / UDF pre-fetch pattern, this module runs an async
//! pass that resolves every cube call in the cells about to recalc and returns a
//! serializable `engine::CubePrefetch`. The frontend forwards that into
//! `update_cell` as the `cube_results` parameter; the synchronous evaluator then
//! serves results without any I/O (see core/engine/src/cube.rs and evaluator.rs).
//!
//! ## Member-expression syntax (Calcula-native)
//! - `[Measure Name]`          -> a model measure
//! - `Table[Column]=Value`     -> a dimension member (value may be 'single-quoted')
//! - `Table[Column]`           -> a level (all members of a column)
//! - `m1, m2`                  -> a tuple (AND of members) within one argument
//! - `{m1, m2, ...}`           -> an explicit set (CUBESET)
//!
//! The connection (first argument of most cube functions) is a Calcula
//! `Connection.name`, resolved by name against `BiState`.
//!
//! ## Known limitations (v1)
//! The async pre-pass and the sync evaluator must compute the SAME lookup key.
//! They agree for the common case — cube arguments that are string literals or
//! direct cell references (to a cube-member cell or a plain text cell). They can
//! DIVERGE (yielding #N/A) for these less common shapes, deferred to a follow-up:
//! - A cube argument that is a NAMED RANGE, a structured TABLE reference, or a
//!   SPILL ref: the pre-pass walks the raw parsed AST while `update_cell` walks a
//!   name/table/spill-RESOLVED AST. Use a literal or a direct cell reference.
//! - A cube argument that is a cell reference to ANOTHER FORMULA cell recomputed
//!   in the same edit (the pre-pass reads the pre-edit snapshot text). Reference
//!   CUBEMEMBER cells or stable inputs instead.
//! Also: CUBEVALUE member filters are column-name-only (the engine FilterCondition
//! carries no table), so member columns should be uniquely named across tables;
//! CUBESET measure ordering (sort_order 1/2) applies to level sets, not explicit
//! `{...}` lists (which support alphabetical sort 3/4); and cube cells that are
//! whole-column/row dependents may show a stale (last) value on an unrelated edit
//! rather than refreshing — they refresh on a direct edit.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;

use engine::{
    col_to_index, cube_call_key, cube_function_name, resolve_cube_arg, BuiltinFunction, CellValue,
    CubeBinding, CubeBindingKind, CubeCallResult, CubeError, CubePrefetch, CubeResolver, Expression,
};

use super::types::{BiState, ConnectionId};
use crate::AppState;

// ===========================================================================
// Tauri command
// ===========================================================================

/// Pre-fetch cube data for a pending cell edit. Called by the frontend BEFORE
/// `update_cell`, mirroring the UDF pre-fetch hook: the returned `CubePrefetch`
/// is forwarded into `update_cell` as `cube_results` and served by the
/// synchronous evaluator.
#[tauri::command]
pub async fn cube_prefetch(
    state: tauri::State<'_, AppState>,
    bi_state: tauri::State<'_, BiState>,
    row: u32,
    col: u32,
    value: String,
) -> Result<CubePrefetch, String> {
    Ok(build_cube_prefetch(&state, &bi_state, Some((row, col, value))).await)
}

/// Pre-fetch cube data for EVERY cube cell on the active sheet (no specific
/// edit). Called by the frontend before a full recalc (`calculate_now`) so cube
/// cells refresh against current model data — e.g. after a calculated measure
/// is added/edited, or on F9.
#[tauri::command]
pub async fn cube_prefetch_all(
    state: tauri::State<'_, AppState>,
    bi_state: tauri::State<'_, BiState>,
) -> Result<CubePrefetch, String> {
    Ok(build_cube_prefetch(&state, &bi_state, None).await)
}

// ===========================================================================
// Script-facing cube API (Layer 1): cube.value / cube.kpi for user scripts
//
// A user script (object script, or a future UDF) can query the BI model with
// CUBE member-expression ergonomics instead of building a QueryRequest. These
// reuse the SAME resolution helpers as the formula path, but take resolved
// STRING arguments (no cell references), so no CubeResolver is involved. They
// are brokered through the `bi.query` capability (model-scoped, read-only).
// ===========================================================================

pub(crate) fn cube_err_message(e: CubeError) -> String {
    match e {
        CubeError::Name => "Unknown BI connection".to_string(),
        CubeError::Value => "Invalid member expression".to_string(),
        CubeError::NotAvailable => "No data available".to_string(),
        CubeError::Reference => "Invalid reference".to_string(),
    }
}

/// Resolve a CUBEVALUE from raw member-expression strings (a measure + member
/// filters). `Ok(None)` means the query ran but returned no value.
pub async fn script_cube_value(
    bi: &BiState,
    connection: &str,
    members: &[String],
) -> Result<Option<f64>, CubeError> {
    let mut ctx = CubeCtx::new(bi);
    let conn_id = ctx.conn(connection).await?;

    let mut measures: Vec<String> = Vec::new();
    let mut filters: Vec<(String, String)> = Vec::new();
    for s in members {
        if s.trim().is_empty() {
            continue;
        }
        for m in parse_members(s)? {
            match m {
                MemberExpr::Measure(name) => measures.push(name),
                MemberExpr::Member { column, value, .. } => filters.push((column, value)),
                MemberExpr::Level { .. } => return Err(CubeError::Value),
            }
        }
    }

    let measure = match measures.first() {
        Some(m) => m.clone(),
        None => match ctx.meta(&conn_id).await.and_then(|m| m.first_measure) {
            Some(m) => m,
            None => return Err(CubeError::NotAvailable),
        },
    };

    match query_scalar(bi, &conn_id, &measure, &filters).await {
        Ok(v) => Ok(Some(v)),
        Err(CubeError::NotAvailable) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Resolve a KPI value/goal/status (property 1/2/3) for a script.
pub async fn script_cube_kpi(
    bi: &BiState,
    connection: &str,
    kpi: &str,
    property: i64,
) -> Result<Option<f64>, CubeError> {
    let mut ctx = CubeCtx::new(bi);
    let conn_id = ctx.conn(connection).await?;
    let kpi_data = fetch_kpi(bi, &conn_id, kpi).await.ok_or(CubeError::NotAvailable)?;
    // Treat "no rows" as no value (null) to match script_cube_value's contract,
    // rather than surfacing it as an error.
    let value = match query_scalar(bi, &conn_id, &kpi_data.base_measure, &[]).await {
        Ok(v) => v,
        Err(CubeError::NotAvailable) => return Ok(None),
        Err(e) => return Err(e),
    };
    let goal = match &kpi_data.target {
        bi_engine::KpiTarget::Constant(v) => *v,
        bi_engine::KpiTarget::Measure(m) => match query_scalar(bi, &conn_id, m, &[]).await {
            Ok(v) => v,
            Err(CubeError::NotAvailable) => return Ok(None),
            Err(e) => return Err(e),
        },
    };
    let result = match property {
        1 => value,
        2 => goal,
        3 => compute_status(value, goal, &kpi_data.bands) as f64,
        _ => return Err(CubeError::NotAvailable),
    };
    Ok(Some(result))
}

/// Distinct members of a level (Table[Column]) for a script to iterate.
pub async fn script_cube_members(
    bi: &BiState,
    connection: &str,
    member_or_level: &str,
) -> Result<Vec<String>, CubeError> {
    let mut ctx = CubeCtx::new(bi);
    let conn_id = ctx.conn(connection).await?;
    match parse_member_expr(member_or_level)? {
        MemberExpr::Level { table, column } => distinct_members(&mut ctx, &conn_id, &table, &column).await,
        _ => Err(CubeError::Value),
    }
}

#[tauri::command]
pub async fn cube_udf_value(
    bi_state: tauri::State<'_, BiState>,
    cap_store: tauri::State<'_, crate::scripting::CapabilityStore>,
    app_state: tauri::State<'_, crate::AppState>,
    connection: String,
    members: Vec<String>,
    script_id: Option<String>,
    window: tauri::Window,
) -> Result<Option<f64>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    // A3.4-S2: authoritative server-side re-check. cube.* maps to the bi.query
    // capability, so a sandboxed script (carries a script_id) must have been
    // granted bi.query — a compromised renderer can't bypass the broker check.
    // A trusted main-window call carries no script_id and passes untouched.
    if let Some(sid) = script_id.as_deref() {
        if !cap_store.is_bi_granted(sid, "bi.query") {
            crate::log_warn!("SECURITY", "cube_udf_value DENIED (bi.query not granted): script={}", sid);
            crate::net_commands::record_capability_call(
                &app_state.audit_log, "bi.query", sid, false, None, Some("bi.query not granted"),
            );
            return Err("PermissionDenied: bi.query not granted for this script".to_string());
        }
    }
    let result = script_cube_value(&bi_state, &connection, &members)
        .await
        .map_err(cube_err_message);
    if let (Some(sid), true) = (script_id.as_deref(), result.is_ok()) {
        crate::net_commands::record_capability_call(
            &app_state.audit_log, "bi.query", sid, true,
            Some(&format!("cube.value connection {}", connection)), None,
        );
    }
    result
}

#[tauri::command]
pub async fn cube_udf_kpi(
    bi_state: tauri::State<'_, BiState>,
    cap_store: tauri::State<'_, crate::scripting::CapabilityStore>,
    app_state: tauri::State<'_, crate::AppState>,
    connection: String,
    kpi: String,
    property: i64,
    script_id: Option<String>,
    window: tauri::Window,
) -> Result<Option<f64>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    if let Some(sid) = script_id.as_deref() {
        if !cap_store.is_bi_granted(sid, "bi.query") {
            crate::log_warn!("SECURITY", "cube_udf_kpi DENIED (bi.query not granted): script={}", sid);
            crate::net_commands::record_capability_call(
                &app_state.audit_log, "bi.query", sid, false, None, Some("bi.query not granted"),
            );
            return Err("PermissionDenied: bi.query not granted for this script".to_string());
        }
    }
    let result = script_cube_kpi(&bi_state, &connection, &kpi, property)
        .await
        .map_err(cube_err_message);
    if let (Some(sid), true) = (script_id.as_deref(), result.is_ok()) {
        crate::net_commands::record_capability_call(
            &app_state.audit_log, "bi.query", sid, true,
            Some(&format!("cube.kpi connection {} kpi {}", connection, kpi)), None,
        );
    }
    result
}

#[tauri::command]
pub async fn cube_udf_members(
    bi_state: tauri::State<'_, BiState>,
    cap_store: tauri::State<'_, crate::scripting::CapabilityStore>,
    app_state: tauri::State<'_, crate::AppState>,
    connection: String,
    level: String,
    script_id: Option<String>,
    window: tauri::Window,
) -> Result<Vec<String>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    if let Some(sid) = script_id.as_deref() {
        if !cap_store.is_bi_granted(sid, "bi.query") {
            crate::log_warn!("SECURITY", "cube_udf_members DENIED (bi.query not granted): script={}", sid);
            crate::net_commands::record_capability_call(
                &app_state.audit_log, "bi.query", sid, false, None, Some("bi.query not granted"),
            );
            return Err("PermissionDenied: bi.query not granted for this script".to_string());
        }
    }
    let result = script_cube_members(&bi_state, &connection, &level)
        .await
        .map_err(cube_err_message);
    if let (Some(sid), true) = (script_id.as_deref(), result.is_ok()) {
        crate::net_commands::record_capability_call(
            &app_state.audit_log, "bi.query", sid, true,
            Some(&format!("cube.members connection {} level {}", connection, level)), None,
        );
    }
    result
}

// ===========================================================================
// Public entry point
// ===========================================================================

/// Resolve all cube formulas affected by an edit (or the whole sheet when
/// `edited` is `None`) into a `CubePrefetch`. All BI `.await` happens here; the
/// returned struct contains only pre-fetched data the synchronous recalc serves.
pub async fn build_cube_prefetch(
    state: &AppState,
    bi: &BiState,
    edited: Option<(u32, u32, String)>,
) -> CubePrefetch {
    // --- 1. Snapshot all needed state synchronously (no std Mutex across await) ---
    let grid = state.grid.lock().unwrap().clone();
    let locale = state.locale.lock().unwrap().clone();
    let dependents = state.dependents.lock().unwrap().clone();

    // The edited cell's new formula isn't in the grid yet — parse it from `value`.
    let edited_ast: Option<((u32, u32), Option<Expression>)> = edited.as_ref().map(|(r, c, v)| {
        let cell = crate::parse_cell_input(v, &locale);
        ((*r, *c), cell.get_ast().cloned())
    });

    // The AST of a cell: edited override, else the grid cell's cached AST.
    let cell_ast = |r: u32, c: u32| -> Option<Expression> {
        if let Some(((er, ec), ast)) = &edited_ast {
            if (*er, *ec) == (r, c) {
                return ast.clone();
            }
        }
        grid.get_cell(r, c).and_then(|cell| cell.get_ast().cloned())
    };

    // Plain display text of cells, for resolving a CellRef member argument that
    // points at a non-cube cell (e.g. a cell literally containing "[Revenue]").
    let mut cell_texts: HashMap<(u32, u32), String> = HashMap::new();
    for ((r, c), cell) in grid.cells.iter() {
        match &cell.value {
            CellValue::Text(s) => {
                cell_texts.insert((*r, *c), s.clone());
            }
            CellValue::Number(n) => {
                cell_texts.insert((*r, *c), format!("{}", n));
            }
            CellValue::Boolean(b) => {
                cell_texts.insert((*r, *c), if *b { "TRUE".into() } else { "FALSE".into() });
            }
            _ => {}
        }
    }

    // --- 2. Find every cube cell on the sheet (+ the edited override) ---
    let mut coords: HashSet<(u32, u32)> = grid
        .cells
        .iter()
        .filter(|(_, cell)| cell.has_formula())
        .map(|(k, _)| *k)
        .collect();
    if let Some(((r, c), _)) = &edited_ast {
        coords.insert((*r, *c));
    }

    // object_cells: cells whose ROOT call is a cube OBJECT (carries a binding).
    let mut object_cells: Vec<((u32, u32), BuiltinFunction, Vec<Expression>)> = Vec::new();
    // cube_cells: every cell that contains at least one cube call.
    let mut cube_cells: HashSet<(u32, u32)> = HashSet::new();
    for &(r, c) in &coords {
        let Some(ast) = cell_ast(r, c) else { continue };
        let mut calls = Vec::new();
        collect_cube_calls(&ast, &mut calls);
        if calls.is_empty() {
            continue;
        }
        cube_cells.insert((r, c));
        if let Expression::FunctionCall { func, args, .. } = &ast {
            if is_object_func(func) {
                object_cells.push(((r, c), func.clone(), args.clone()));
            }
        }
    }

    let mut prefetch = CubePrefetch::default();
    if cube_cells.is_empty() {
        return prefetch;
    }

    let mut ctx = CubeCtx::new(bi);

    // --- 3. Phase A: resolve object-cell bindings in dependency order ---
    // A fixed-point loop: each round resolves any object cell whose referenced
    // cube cells are already resolved. Cube formulas can't form cycles (the
    // dependency graph forbids them), so this converges.
    let object_coords: HashSet<(u32, u32)> = object_cells.iter().map(|(k, _, _)| *k).collect();
    let mut outcomes: HashMap<(u32, u32), Result<CubeBinding, CubeError>> = HashMap::new();
    loop {
        let mut progressed = false;
        for ((r, c), func, args) in &object_cells {
            if outcomes.contains_key(&(*r, *c)) {
                continue;
            }
            if !object_deps_ready(args, &object_coords, &outcomes) {
                continue;
            }
            let outcome = {
                let resolver = AppCubeResolver { outcomes: &outcomes, cell_texts: &cell_texts };
                resolve_object(&mut ctx, func, args, &resolver).await
            };
            outcomes.insert((*r, *c), outcome);
            progressed = true;
        }
        if !progressed || outcomes.len() == object_cells.len() {
            break;
        }
    }

    // Record the per-cell bindings (successful objects only) into the prefetch.
    for ((r, c), outcome) in &outcomes {
        if let Ok(binding) = outcome {
            prefetch.insert_binding(*r, *c, binding.clone());
        }
    }

    // --- 4. Phase B: resolve results for the cells about to recalc ---
    let result_coords: Vec<(u32, u32)> = match &edited {
        Some((r, c, _)) => {
            let mut v = crate::get_recalculation_order((*r, *c), &dependents);
            v.push((*r, *c));
            v
        }
        None => cube_cells.iter().copied().collect(),
    };

    for (r, c) in result_coords {
        let Some(ast) = cell_ast(r, c) else { continue };
        let mut calls = Vec::new();
        collect_cube_calls(&ast, &mut calls);
        for (func, args) in calls {
            let Some(fname) = cube_function_name(&func) else { continue };
            let key = {
                let resolver = AppCubeResolver { outcomes: &outcomes, cell_texts: &cell_texts };
                match cube_call_key(fname, &args, &resolver) {
                    Ok(k) => k,
                    Err(_) => continue,
                }
            };
            if prefetch.results.contains_key(&key) {
                continue;
            }
            let result = if is_object_func(&func) {
                // Reuse the Phase-A binding when this IS the cell's root object call.
                let from_cell = if let Expression::FunctionCall { func: rf, .. } = &ast {
                    if rf == &func {
                        outcomes.get(&(r, c)).map(|o| match o {
                            Ok(b) => CubeCallResult::Object { caption: b.caption.clone() },
                            Err(e) => CubeCallResult::Error(*e),
                        })
                    } else {
                        None
                    }
                } else {
                    None
                };
                match from_cell {
                    Some(res) => res,
                    None => {
                        // A nested object call (rare): resolve it fresh.
                        let resolver =
                            AppCubeResolver { outcomes: &outcomes, cell_texts: &cell_texts };
                        match resolve_object(&mut ctx, &func, &args, &resolver).await {
                            Ok(b) => CubeCallResult::Object { caption: b.caption },
                            Err(e) => CubeCallResult::Error(e),
                        }
                    }
                }
            } else {
                let resolver = AppCubeResolver { outcomes: &outcomes, cell_texts: &cell_texts };
                match resolve_value(&mut ctx, &func, &args, &resolver).await {
                    Ok(res) => res,
                    Err(e) => CubeCallResult::Error(e),
                }
            };
            prefetch.results.insert(key, result);
        }
    }

    prefetch
}

// ===========================================================================
// Resolution context (connection + model-metadata caches)
// ===========================================================================

struct CubeCtx<'a> {
    bi: &'a BiState,
    /// connection name -> id (None = not found).
    conn_ids: HashMap<String, Option<ConnectionId>>,
    /// connections already auto-connected/bound this pass.
    ensured: HashSet<ConnectionId>,
    /// model metadata cache keyed by connection id.
    meta_cache: HashMap<ConnectionId, Option<ModelMeta>>,
}

impl<'a> CubeCtx<'a> {
    fn new(bi: &'a BiState) -> Self {
        Self {
            bi,
            conn_ids: HashMap::new(),
            ensured: HashSet::new(),
            meta_cache: HashMap::new(),
        }
    }

    /// Resolve a connection by name and ensure it is ready to query (auto-connect
    /// + auto-bind when not cache-warm). Unknown name -> #NAME?.
    async fn conn(&mut self, name: &str) -> Result<ConnectionId, CubeError> {
        let id = match self.conn_ids.get(name) {
            Some(cached) => cached.clone(),
            None => {
                let found = conn_id_by_name(self.bi, name);
                self.conn_ids.insert(name.to_string(), found.clone());
                found
            }
        };
        let id = id.ok_or(CubeError::Name)?;
        if !self.ensured.contains(&id) {
            ensure_ready(self.bi, &id).await?;
            self.ensured.insert(id.clone());
        }
        Ok(id)
    }

    async fn meta(&mut self, id: &ConnectionId) -> Option<ModelMeta> {
        if let Some(cached) = self.meta_cache.get(id) {
            return cached.clone();
        }
        let m = fetch_model_meta(self.bi, id).await;
        self.meta_cache.insert(id.clone(), m.clone());
        m
    }
}

#[derive(Debug, Clone)]
struct ModelMeta {
    measures: HashSet<String>,
    columns: HashSet<(String, String)>,
    first_measure: Option<String>,
}

#[derive(Debug, Clone)]
struct KpiData {
    base_measure: String,
    target: bi_engine::KpiTarget,
    bands: Vec<(f64, i32)>,
}

// ===========================================================================
// The pre-pass resolver (mirrors engine's CubeResolver so keys match)
// ===========================================================================

struct AppCubeResolver<'a> {
    outcomes: &'a HashMap<(u32, u32), Result<CubeBinding, CubeError>>,
    cell_texts: &'a HashMap<(u32, u32), String>,
}

impl CubeResolver for AppCubeResolver<'_> {
    fn binding_at(&self, row: u32, col: u32) -> Option<&CubeBinding> {
        self.outcomes.get(&(row, col)).and_then(|o| o.as_ref().ok())
    }
    fn cell_text(&self, row: u32, col: u32) -> Option<String> {
        self.cell_texts.get(&(row, col)).cloned()
    }
}

// ===========================================================================
// Object resolution (CUBEMEMBER / CUBESET / CUBERANKEDMEMBER / CUBEKPIMEMBER)
// ===========================================================================

async fn resolve_object(
    ctx: &mut CubeCtx<'_>,
    func: &BuiltinFunction,
    args: &[Expression],
    resolver: &dyn CubeResolver,
) -> Result<CubeBinding, CubeError> {
    match func {
        BuiltinFunction::CubeMember => resolve_cube_member(ctx, args, resolver).await,
        BuiltinFunction::CubeSet => resolve_cube_set(ctx, args, resolver).await,
        BuiltinFunction::CubeRankedMember => resolve_cube_ranked_member(ctx, args, resolver).await,
        BuiltinFunction::CubeKpiMember => resolve_cube_kpi_member(ctx, args, resolver).await,
        _ => Err(CubeError::Value),
    }
}

async fn resolve_cube_member(
    ctx: &mut CubeCtx<'_>,
    args: &[Expression],
    resolver: &dyn CubeResolver,
) -> Result<CubeBinding, CubeError> {
    if args.len() < 2 {
        return Err(CubeError::Value);
    }
    let conn_name = arg_str(args, 0, resolver)?;
    let conn_id = ctx.conn(&conn_name).await?;
    let member_str = arg_str(args, 1, resolver)?;
    let members = parse_members(&member_str)?;

    // Validate each measure/column exists in the model.
    if let Some(meta) = ctx.meta(&conn_id).await {
        for m in &members {
            match m {
                MemberExpr::Measure(name) => {
                    if !meta.measures.contains(name) {
                        return Err(CubeError::NotAvailable);
                    }
                }
                MemberExpr::Member { table, column, .. } => {
                    if !column_known(&meta, table.as_deref(), column) {
                        return Err(CubeError::NotAvailable);
                    }
                }
                MemberExpr::Level { table, column } => {
                    if !column_known(&meta, Some(table.as_str()), column) {
                        return Err(CubeError::NotAvailable);
                    }
                }
            }
        }
    }

    let caption = match arg_str_opt(args, 2, resolver) {
        Some(c) if !c.is_empty() => c,
        _ => default_caption(&members),
    };
    Ok(CubeBinding {
        connection: conn_name,
        kind: CubeBindingKind::Member,
        expression: member_str,
        caption,
        members: vec![],
        scalar: None,
    })
}

async fn resolve_cube_set(
    ctx: &mut CubeCtx<'_>,
    args: &[Expression],
    resolver: &dyn CubeResolver,
) -> Result<CubeBinding, CubeError> {
    if args.len() < 2 {
        return Err(CubeError::Value);
    }
    let conn_name = arg_str(args, 0, resolver)?;
    let conn_id = ctx.conn(&conn_name).await?;
    let set_str = arg_str(args, 1, resolver)?;

    // sort_order (arg 3): 0 none, 1 asc, 2 desc, 3 alpha-asc, 4 alpha-desc.
    let sort_order = arg_num_opt(args, 3, resolver).unwrap_or(0.0) as i64;
    let sort_by = arg_str_opt(args, 4, resolver).filter(|s| !s.is_empty());

    let mut members =
        resolve_set_members(ctx, &conn_id, &set_str, sort_order, sort_by.clone()).await?;

    // Alphabetical sort modes are independent of a measure.
    if sort_order == 3 {
        members.sort();
    } else if sort_order == 4 {
        members.sort();
        members.reverse();
    }

    let caption = match arg_str_opt(args, 2, resolver) {
        Some(c) if !c.is_empty() => c,
        _ => set_str.clone(),
    };
    // Fold the sort into the set's identity so two CUBESET cells over the same
    // set expression but DIFFERENT sort are distinct objects — otherwise
    // CUBERANKEDMEMBER / CUBESETCOUNT referencing them would key identically.
    let expression = if sort_order != 0 {
        format!("{}\u{1f}sort={}\u{1f}by={}", set_str, sort_order, sort_by.as_deref().unwrap_or(""))
    } else {
        set_str.clone()
    };
    Ok(CubeBinding {
        connection: conn_name,
        kind: CubeBindingKind::Set,
        expression,
        caption,
        members,
        scalar: None,
    })
}

/// Resolve a set expression to an ordered list of member-expression strings.
async fn resolve_set_members(
    ctx: &mut CubeCtx<'_>,
    conn_id: &ConnectionId,
    set_str: &str,
    sort_order: i64,
    sort_by: Option<String>,
) -> Result<Vec<String>, CubeError> {
    let s = set_str.trim();
    // Explicit list: {m1, m2, ...}
    if s.starts_with('{') && s.ends_with('}') {
        let inner = &s[1..s.len() - 1];
        return Ok(split_top_level_commas(inner)
            .into_iter()
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty())
            .collect());
    }

    match parse_member_expr(s)? {
        MemberExpr::Level { table, column } => {
            // Distinct members of the column, optionally ordered by a measure.
            if sort_order == 1 || sort_order == 2 {
                // sort_by may be a bracketed measure expression like "[Revenue]";
                // the engine wants the bare name. With no sort_by, order by the
                // model's default measure rather than silently leaving unordered.
                let measure = match sort_by {
                    Some(m) => Some(measure_name(&m)),
                    None => model_first_measure(ctx, conn_id).await,
                };
                if let Some(measure) = measure {
                    let req = bi_engine::QueryRequest {
                        measures: vec![measure.clone()],
                        group_by: vec![bi_engine::ColumnRef::new(&table, &column)],
                        ..Default::default()
                    };
                    let result = run_query(ctx.bi, conn_id, req).await?;
                    let mut pairs: Vec<(String, f64)> = Vec::new();
                    for row in &result.rows {
                        let member = row.first().and_then(|o| o.clone());
                        let val = row.get(1).and_then(|o| o.as_ref()).and_then(|s| s.parse::<f64>().ok());
                        if let Some(m) = member {
                            if !m.is_empty() {
                                pairs.push((m, val.unwrap_or(0.0)));
                            }
                        }
                    }
                    pairs.sort_by(|a, b| {
                        let o = a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal);
                        if sort_order == 2 { o.reverse() } else { o }
                    });
                    return Ok(pairs
                        .into_iter()
                        .map(|(m, _)| format!("{}[{}]={}", table, column, m))
                        .collect());
                }
            }
            // Unordered (or alpha): just the distinct members.
            let members = distinct_members(ctx, conn_id, &table, &column).await?;
            Ok(members
                .into_iter()
                .map(|m| format!("{}[{}]={}", table, column, m))
                .collect())
        }
        MemberExpr::Member { table, column, value } => {
            let table = table.unwrap_or_default();
            Ok(vec![format!("{}[{}]={}", table, column, value)])
        }
        MemberExpr::Measure(_) => Err(CubeError::Value),
    }
}

async fn resolve_cube_ranked_member(
    ctx: &mut CubeCtx<'_>,
    args: &[Expression],
    resolver: &dyn CubeResolver,
) -> Result<CubeBinding, CubeError> {
    if args.len() < 3 {
        return Err(CubeError::Value);
    }
    let conn_name = arg_str(args, 0, resolver)?;
    let _conn_id = ctx.conn(&conn_name).await?;
    let set = resolve_set_binding(ctx, &args[1], resolver).await?;
    let rank = arg_num(args, 2, resolver)? as i64;
    if rank < 1 || (rank as usize) > set.members.len() {
        return Err(CubeError::Reference);
    }
    let member_expr = set.members[(rank - 1) as usize].clone();
    let members = parse_members(&member_expr).unwrap_or_default();
    let caption = match arg_str_opt(args, 3, resolver) {
        Some(c) if !c.is_empty() => c,
        _ => default_caption(&members),
    };
    Ok(CubeBinding {
        connection: conn_name,
        kind: CubeBindingKind::Member,
        expression: member_expr,
        caption,
        members: vec![],
        scalar: None,
    })
}

async fn resolve_cube_kpi_member(
    ctx: &mut CubeCtx<'_>,
    args: &[Expression],
    resolver: &dyn CubeResolver,
) -> Result<CubeBinding, CubeError> {
    if args.len() < 3 {
        return Err(CubeError::Value);
    }
    let conn_name = arg_str(args, 0, resolver)?;
    let conn_id = ctx.conn(&conn_name).await?;
    let kpi_name = arg_str(args, 1, resolver)?;
    let property = arg_num(args, 2, resolver)? as i64;

    let kpi = fetch_kpi(ctx.bi, &conn_id, &kpi_name)
        .await
        .ok_or(CubeError::NotAvailable)?;
    let value = query_scalar(ctx.bi, &conn_id, &kpi.base_measure, &[]).await?;
    let goal = match &kpi.target {
        bi_engine::KpiTarget::Constant(v) => *v,
        bi_engine::KpiTarget::Measure(m) => query_scalar(ctx.bi, &conn_id, m, &[]).await?,
    };

    let (scalar, caption) = match property {
        1 => (value, format_scalar(value)),
        2 => (goal, format_scalar(goal)),
        3 => {
            let st = compute_status(value, goal, &kpi.bands);
            (st as f64, status_string(st).to_string())
        }
        _ => return Err(CubeError::NotAvailable),
    };

    let caption = match arg_str_opt(args, 3, resolver) {
        Some(c) if !c.is_empty() => c,
        _ => caption,
    };
    Ok(CubeBinding {
        connection: conn_name,
        kind: CubeBindingKind::Member,
        expression: format!("KPI:{}:{}", kpi_name, property),
        caption,
        members: vec![],
        scalar: Some(scalar),
    })
}

// ===========================================================================
// Value resolution (CUBEVALUE / CUBESETCOUNT / CUBEMEMBERPROPERTY)
// ===========================================================================

async fn resolve_value(
    ctx: &mut CubeCtx<'_>,
    func: &BuiltinFunction,
    args: &[Expression],
    resolver: &dyn CubeResolver,
) -> Result<CubeCallResult, CubeError> {
    match func {
        BuiltinFunction::CubeValue => resolve_cube_value(ctx, args, resolver).await,
        BuiltinFunction::CubeSetCount => resolve_cube_set_count(ctx, args, resolver).await,
        BuiltinFunction::CubeMemberProperty => {
            resolve_cube_member_property(ctx, args, resolver).await
        }
        _ => Err(CubeError::Value),
    }
}

async fn resolve_cube_value(
    ctx: &mut CubeCtx<'_>,
    args: &[Expression],
    resolver: &dyn CubeResolver,
) -> Result<CubeCallResult, CubeError> {
    if args.is_empty() {
        return Err(CubeError::Value);
    }
    let conn_name = arg_str(args, 0, resolver)?;
    let conn_id = ctx.conn(&conn_name).await?;

    let mut measures: Vec<String> = Vec::new();
    let mut filters: Vec<(String, String)> = Vec::new();
    let mut scalar_override: Option<f64> = None;

    for (i, a) in args.iter().enumerate().skip(1) {
        // A referenced member carrying a precomputed scalar (e.g. a KPI member).
        if let Expression::CellRef { col, row, .. } = a {
            let r0 = row.saturating_sub(1);
            let c0 = col_to_index(col) as u32;
            if let Some(b) = resolver.binding_at(r0, c0) {
                if let Some(s) = b.scalar {
                    scalar_override = Some(s);
                    continue;
                }
            }
        }
        let s = arg_str(args, i, resolver)?;
        if s.is_empty() {
            continue;
        }
        for m in parse_members(&s)? {
            match m {
                MemberExpr::Measure(name) => measures.push(name),
                MemberExpr::Member { column, value, .. } => filters.push((column, value)),
                MemberExpr::Level { .. } => return Err(CubeError::Value),
            }
        }
    }

    // Choose the measure: explicit > scalar-carrying member > model default.
    let measure = if let Some(m) = measures.first() {
        m.clone()
    } else if let Some(s) = scalar_override {
        return Ok(CubeCallResult::Number(s));
    } else {
        match ctx.meta(&conn_id).await.and_then(|m| m.first_measure) {
            Some(m) => m,
            None => return Err(CubeError::NotAvailable),
        }
    };

    match query_scalar(ctx.bi, &conn_id, &measure, &filters).await {
        Ok(v) => Ok(CubeCallResult::Number(v)),
        Err(e) => Err(e),
    }
}

async fn resolve_cube_set_count(
    ctx: &mut CubeCtx<'_>,
    args: &[Expression],
    resolver: &dyn CubeResolver,
) -> Result<CubeCallResult, CubeError> {
    if args.is_empty() {
        return Err(CubeError::Value);
    }
    // CUBESETCOUNT(set) — the only argument is the set (no connection).
    let set = resolve_set_binding(ctx, &args[0], resolver).await?;
    Ok(CubeCallResult::Number(set.members.len() as f64))
}

async fn resolve_cube_member_property(
    ctx: &mut CubeCtx<'_>,
    args: &[Expression],
    resolver: &dyn CubeResolver,
) -> Result<CubeCallResult, CubeError> {
    if args.len() < 3 {
        return Err(CubeError::Value);
    }
    let conn_name = arg_str(args, 0, resolver)?;
    let conn_id = ctx.conn(&conn_name).await?;
    let member_str = arg_str(args, 1, resolver)?;
    let property = arg_str(args, 2, resolver)?;

    let member = parse_members(&member_str)?
        .into_iter()
        .find_map(|m| match m {
            MemberExpr::Member { table, column, value } => Some((table, column, value)),
            _ => None,
        })
        .ok_or(CubeError::Value)?;
    let (table, column, value) = member;

    let prop_upper = property.trim().to_uppercase();
    if prop_upper == "CAPTION" || prop_upper == "MEMBER_VALUE" || prop_upper == "VALUE" {
        return Ok(CubeCallResult::Text(value));
    }

    // Otherwise the property is another column on the member's table.
    let table = table.ok_or(CubeError::Value)?;
    let req = bi_engine::QueryRequest {
        measures: model_first_measure(ctx, &conn_id).await.into_iter().collect(),
        group_by: vec![bi_engine::ColumnRef::new(&table, &property)],
        filters: vec![bi_engine::FilterCondition::new(
            column.clone(),
            bi_engine::FilterOperator::Equal,
            value.clone(),
        )],
        ..Default::default()
    };
    let result = run_query(ctx.bi, &conn_id, req).await?;
    let cell = result
        .rows
        .first()
        .and_then(|r| r.first())
        .and_then(|o| o.clone());
    match cell {
        Some(s) => match s.parse::<f64>() {
            Ok(n) if n.is_finite() => Ok(CubeCallResult::Number(n)),
            _ => Ok(CubeCallResult::Text(s)),
        },
        None => Err(CubeError::NotAvailable),
    }
}

/// Resolve an argument to a set binding: a CellRef to a CUBESET cell, or a
/// nested CUBESET call.
async fn resolve_set_binding(
    ctx: &mut CubeCtx<'_>,
    arg: &Expression,
    resolver: &dyn CubeResolver,
) -> Result<CubeBinding, CubeError> {
    match arg {
        Expression::CellRef { col, row, .. } => {
            let r0 = row.saturating_sub(1);
            let c0 = col_to_index(col) as u32;
            match resolver.binding_at(r0, c0) {
                Some(b) if b.kind == CubeBindingKind::Set => Ok(b.clone()),
                _ => Err(CubeError::Reference),
            }
        }
        Expression::FunctionCall { func: BuiltinFunction::CubeSet, args, .. } => {
            resolve_cube_set(ctx, args, resolver).await
        }
        _ => Err(CubeError::Reference),
    }
}

// ===========================================================================
// BI engine plumbing
// ===========================================================================

pub(crate) fn conn_id_by_name(bi: &BiState, name: &str) -> Option<ConnectionId> {
    let conns = bi.connections.lock().unwrap();
    if let Some(c) = conns.values().find(|c| c.name == name) {
        return Some(c.id.clone());
    }
    // Fall back to treating the string as a connection id (scripts use ids).
    ConnectionId::parse(name).filter(|id| conns.contains_key(id))
}

fn engine_arc_by_id(
    bi: &BiState,
    id: &ConnectionId,
) -> Option<Arc<TokioMutex<bi_engine::Engine>>> {
    let conns = bi.connections.lock().unwrap();
    conns.get(id).and_then(|c| c.engine.clone())
}

/// Ensure tables are bound (auto-connect + auto-bind) unless already cache-warm.
async fn ensure_ready(bi: &BiState, conn_id: &ConnectionId) -> Result<(), CubeError> {
    let all_tables: Vec<String> = {
        let arc = engine_arc_by_id(bi, conn_id).ok_or(CubeError::NotAvailable)?;
        let engine = arc.lock().await;
        engine.model().tables().iter().map(|t| t.name().to_string()).collect()
    };
    let refs: Vec<&str> = all_tables.iter().map(|s| s.as_str()).collect();
    if !super::commands::bi_tables_cache_warm(bi, conn_id.clone(), &refs).await {
        super::commands::auto_connect_bi_connection(bi, conn_id.clone())
            .await
            .map_err(|_| CubeError::NotAvailable)?;
        super::commands::auto_bind_tables_on_connection(bi, conn_id.clone(), &refs)
            .await
            .map_err(|_| CubeError::NotAvailable)?;
    }
    Ok(())
}

/// Run a query and return the string-rendered result rows.
async fn run_query(
    bi: &BiState,
    conn_id: &ConnectionId,
    req: bi_engine::QueryRequest,
) -> Result<super::types::BiQueryResult, CubeError> {
    let arc = engine_arc_by_id(bi, conn_id).ok_or(CubeError::NotAvailable)?;
    let mut engine = arc.lock().await;
    super::commands::apply_connection_role(&mut engine, bi, conn_id.clone());
    match engine.query_auto_refresh(req).await {
        Ok((batches, _)) => Ok(super::commands::batches_to_result(&batches)),
        Err(_) => Err(CubeError::NotAvailable),
    }
}

/// Compute a single scalar measure value, optionally filtered to members.
async fn query_scalar(
    bi: &BiState,
    conn_id: &ConnectionId,
    measure: &str,
    filters: &[(String, String)],
) -> Result<f64, CubeError> {
    let req = bi_engine::QueryRequest {
        measures: vec![measure.to_string()],
        group_by: vec![],
        filters: filters
            .iter()
            .map(|(col, val)| {
                bi_engine::FilterCondition::new(
                    col.clone(),
                    bi_engine::FilterOperator::Equal,
                    val.clone(),
                )
            })
            .collect(),
        ..Default::default()
    };
    let result = run_query(bi, conn_id, req).await?;
    // A scalar query has one measure column; take the first non-null cell.
    let idx = result
        .columns
        .iter()
        .position(|c| c == measure)
        .unwrap_or(0);
    result
        .rows
        .first()
        .and_then(|r| r.get(idx))
        .and_then(|o| o.as_ref())
        .and_then(|s| s.parse::<f64>().ok())
        // Non-finite (NaN/Inf, e.g. a divide-by-zero measure) cannot cross the
        // JSON IPC boundary; surface it as no-data rather than corrupting the
        // whole CubePrefetch payload.
        .filter(|v| v.is_finite())
        .ok_or(CubeError::NotAvailable)
}

/// Distinct, non-empty values of a column (members of a level).
async fn distinct_members(
    ctx: &mut CubeCtx<'_>,
    conn_id: &ConnectionId,
    table: &str,
    column: &str,
) -> Result<Vec<String>, CubeError> {
    // The engine requires at least one measure even when only grouping.
    let first_measure = model_first_measure(ctx, conn_id).await;
    let req = bi_engine::QueryRequest {
        measures: first_measure.into_iter().collect(),
        group_by: vec![bi_engine::ColumnRef::new(table, column)],
        ..Default::default()
    };
    let result = run_query(ctx.bi, conn_id, req).await?;
    let mut values: Vec<String> = Vec::new();
    for row in &result.rows {
        if let Some(Some(v)) = row.first() {
            if !v.is_empty() {
                values.push(v.clone());
            }
        }
    }
    values.sort();
    values.dedup();
    Ok(values)
}

async fn model_first_measure(ctx: &mut CubeCtx<'_>, conn_id: &ConnectionId) -> Option<String> {
    ctx.meta(conn_id).await.and_then(|m| m.first_measure)
}

async fn fetch_model_meta(bi: &BiState, conn_id: &ConnectionId) -> Option<ModelMeta> {
    let arc = engine_arc_by_id(bi, conn_id)?;
    let engine = arc.lock().await;
    let model = engine.model();
    let measures: HashSet<String> = model.measures().iter().map(|m| m.name().to_string()).collect();
    let mut columns: HashSet<(String, String)> = HashSet::new();
    for t in model.tables() {
        for col in t.columns() {
            columns.insert((t.name().to_string(), col.name().to_string()));
        }
    }
    let first_measure = model.measures().first().map(|m| m.name().to_string());
    Some(ModelMeta { measures, columns, first_measure })
}

async fn fetch_kpi(bi: &BiState, conn_id: &ConnectionId, name: &str) -> Option<KpiData> {
    let arc = engine_arc_by_id(bi, conn_id)?;
    let engine = arc.lock().await;
    let kpi = engine.model().kpi(name)?;
    let bands = kpi
        .status_bands()
        .iter()
        .map(|b| (b.threshold, status_code(b.status)))
        .collect();
    Some(KpiData {
        base_measure: kpi.base_measure().to_string(),
        target: kpi.target().clone(),
        bands,
    })
}

// ===========================================================================
// Member-expression parsing
// ===========================================================================

#[derive(Debug, Clone, PartialEq)]
enum MemberExpr {
    Measure(String),
    Member { table: Option<String>, column: String, value: String },
    Level { table: String, column: String },
}

/// Parse one member expression (no top-level commas).
fn parse_member_expr(raw: &str) -> Result<MemberExpr, CubeError> {
    let s = raw.trim();
    if s.is_empty() {
        return Err(CubeError::Value);
    }
    // Measure: the whole token is `[Name]` with no table prefix and no nesting.
    if s.starts_with('[') {
        if let Some(inner) = s.strip_prefix('[').and_then(|x| x.strip_suffix(']')) {
            if !inner.contains('[') && !inner.contains(']') {
                let name = inner.trim();
                if name.is_empty() {
                    return Err(CubeError::Value);
                }
                return Ok(MemberExpr::Measure(name.to_string()));
            }
        }
        return Err(CubeError::Value);
    }
    // Table[Column] optionally `= value`.
    let lb = s.find('[').ok_or(CubeError::Value)?;
    let rb = s.find(']').ok_or(CubeError::Value)?;
    if rb <= lb {
        return Err(CubeError::Value);
    }
    let table = s[..lb].trim().to_string();
    let column = s[lb + 1..rb].trim().to_string();
    if table.is_empty() || column.is_empty() {
        return Err(CubeError::Value);
    }
    let rest = s[rb + 1..].trim();
    if rest.is_empty() {
        Ok(MemberExpr::Level { table, column })
    } else if let Some(v) = rest.strip_prefix('=') {
        Ok(MemberExpr::Member {
            table: Some(table),
            column,
            value: unquote(v.trim()),
        })
    } else {
        Err(CubeError::Value)
    }
}

/// Parse a (possibly tuple) member argument into its components.
fn parse_members(raw: &str) -> Result<Vec<MemberExpr>, CubeError> {
    let parts = split_top_level_commas(raw);
    let mut out = Vec::new();
    for p in parts {
        let p = p.trim();
        if p.is_empty() {
            continue;
        }
        out.push(parse_member_expr(p)?);
    }
    if out.is_empty() {
        return Err(CubeError::Value);
    }
    Ok(out)
}

/// Strip the surrounding `[ ]` from a bracketed measure expression like
/// `[Revenue]`, yielding the bare measure name the engine expects.
fn measure_name(s: &str) -> String {
    let t = s.trim();
    match t.strip_prefix('[').and_then(|x| x.strip_suffix(']')) {
        Some(inner) => inner.trim().to_string(),
        None => t.to_string(),
    }
}

fn unquote(v: &str) -> String {
    let v = v.trim();
    let bytes = v.as_bytes();
    if v.len() >= 2
        && ((bytes[0] == b'\'' && bytes[v.len() - 1] == b'\'')
            || (bytes[0] == b'"' && bytes[v.len() - 1] == b'"'))
    {
        v[1..v.len() - 1].to_string()
    } else {
        v.to_string()
    }
}

/// Split on commas that are not inside quotes, brackets, or braces. A quote
/// (`'` or `"`) only opens a quoted token at a token boundary (start, or right
/// after `= [ { ( ,`), so a stray apostrophe inside an unquoted value (e.g.
/// `Geo[Name]=O'Brien`) is treated as a literal and does not swallow commas.
fn split_top_level_commas(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    let mut cur = String::new();
    let mut last_significant: Option<char> = None;
    for ch in s.chars() {
        if let Some(q) = quote {
            cur.push(ch);
            if ch == q {
                quote = None;
            }
            if !ch.is_whitespace() {
                last_significant = Some(ch);
            }
            continue;
        }
        match ch {
            '\'' | '"' if is_quote_boundary(last_significant) => {
                quote = Some(ch);
            }
            '[' | '{' | '(' => depth += 1,
            ']' | '}' | ')' => depth -= 1,
            ',' if depth == 0 => {
                out.push(std::mem::take(&mut cur));
                last_significant = None;
                continue;
            }
            _ => {}
        }
        cur.push(ch);
        if !ch.is_whitespace() {
            last_significant = Some(ch);
        }
    }
    if !cur.trim().is_empty() || !out.is_empty() {
        out.push(cur);
    }
    out
}

/// A quote char opens a quoted token only at a token boundary.
fn is_quote_boundary(prev: Option<char>) -> bool {
    match prev {
        None => true,
        Some(c) => matches!(c, '=' | '[' | '{' | '('),
    }
}

fn default_caption(members: &[MemberExpr]) -> String {
    let parts: Vec<String> = members
        .iter()
        .map(|m| match m {
            MemberExpr::Measure(name) => name.clone(),
            MemberExpr::Member { value, .. } => value.clone(),
            MemberExpr::Level { column, .. } => column.clone(),
        })
        .collect();
    parts.join(" ")
}

fn column_known(meta: &ModelMeta, table: Option<&str>, column: &str) -> bool {
    match table {
        Some(t) => meta.columns.contains(&(t.to_string(), column.to_string())),
        None => meta.columns.iter().any(|(_, c)| c == column),
    }
}

// ===========================================================================
// KPI helpers
// ===========================================================================

fn status_code(s: bi_engine::KpiStatus) -> i32 {
    match s {
        bi_engine::KpiStatus::OffTrack => -1,
        bi_engine::KpiStatus::AtRisk => 0,
        bi_engine::KpiStatus::OnTrack => 1,
    }
}

fn status_string(code: i32) -> &'static str {
    match code {
        1 => "On Track",
        0 => "At Risk",
        _ => "Off Track",
    }
}

/// Map a base/target ratio onto the KPI's status bands (-1/0/1).
fn compute_status(value: f64, goal: f64, bands: &[(f64, i32)]) -> i32 {
    let ratio = if goal != 0.0 {
        value / goal
    } else if value >= 0.0 {
        f64::INFINITY
    } else {
        f64::NEG_INFINITY
    };
    if bands.is_empty() {
        return if ratio >= 1.0 {
            1
        } else if ratio >= 0.9 {
            0
        } else {
            -1
        };
    }
    let mut sorted: Vec<&(f64, i32)> = bands.iter().collect();
    sorted.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut status = sorted.first().map(|b| b.1).unwrap_or(-1);
    for (thr, st) in &sorted {
        if ratio >= *thr {
            status = *st;
        }
    }
    status
}

fn format_scalar(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{}", n)
    }
}

// ===========================================================================
// Argument helpers (resolve via the shared engine resolver so keys match)
// ===========================================================================

fn arg_str(
    args: &[Expression],
    i: usize,
    resolver: &dyn CubeResolver,
) -> Result<String, CubeError> {
    let a = args.get(i).ok_or(CubeError::Value)?;
    resolve_cube_arg(a, resolver)
}

fn arg_str_opt(args: &[Expression], i: usize, resolver: &dyn CubeResolver) -> Option<String> {
    args.get(i).and_then(|a| resolve_cube_arg(a, resolver).ok())
}

fn arg_num(args: &[Expression], i: usize, resolver: &dyn CubeResolver) -> Result<f64, CubeError> {
    let s = arg_str(args, i, resolver)?;
    s.trim().parse::<f64>().map_err(|_| CubeError::Value)
}

fn arg_num_opt(args: &[Expression], i: usize, resolver: &dyn CubeResolver) -> Option<f64> {
    arg_str_opt(args, i, resolver).and_then(|s| s.trim().parse::<f64>().ok())
}

// ===========================================================================
// AST walking
// ===========================================================================

fn is_object_func(func: &BuiltinFunction) -> bool {
    matches!(
        func,
        BuiltinFunction::CubeMember
            | BuiltinFunction::CubeSet
            | BuiltinFunction::CubeRankedMember
            | BuiltinFunction::CubeKpiMember
    )
}

/// Collect every cube function call in an expression tree (with its arguments).
/// Recurses into ALL container variants — a missed cube call would be evaluated
/// by the engine but have no pre-fetched result (silent #N/A).
fn collect_cube_calls(expr: &Expression, out: &mut Vec<(BuiltinFunction, Vec<Expression>)>) {
    if let Expression::FunctionCall { func, args, .. } = expr {
        if cube_function_name(func).is_some() {
            out.push((func.clone(), args.clone()));
        }
    }
    for child in child_exprs(expr) {
        collect_cube_calls(child, out);
    }
}

/// Collect the 0-based coordinates of all direct cell references in `args`.
fn collect_cell_refs(args: &[Expression], out: &mut Vec<(u32, u32)>) {
    for a in args {
        collect_cell_refs_expr(a, out);
    }
}

fn collect_cell_refs_expr(expr: &Expression, out: &mut Vec<(u32, u32)>) {
    if let Expression::CellRef { col, row, .. } = expr {
        out.push((row.saturating_sub(1), col_to_index(col) as u32));
    }
    for child in child_exprs(expr) {
        collect_cell_refs_expr(child, out);
    }
}

/// All directly-nested child expressions of `expr`, for generic tree walks.
fn child_exprs(expr: &Expression) -> Vec<&Expression> {
    match expr {
        Expression::FunctionCall { args, .. } => args.iter().collect(),
        Expression::BinaryOp { left, right, .. } => vec![left, right],
        Expression::UnaryOp { operand, .. } => vec![operand],
        Expression::Range { start, end, .. } => vec![start, end],
        Expression::Sheet3DRef { reference, .. } => vec![reference],
        Expression::IndexAccess { target, index } => vec![target, index],
        Expression::ListLiteral { elements } => elements.iter().collect(),
        Expression::DictLiteral { entries } => {
            entries.iter().flat_map(|(k, v)| [k, v]).collect()
        }
        Expression::SpillRef { cell, .. } => vec![cell],
        Expression::ImplicitIntersection { operand } => vec![operand],
        _ => Vec::new(),
    }
}

/// True when every cube cell referenced by `args` already has an outcome.
fn object_deps_ready(
    args: &[Expression],
    object_coords: &HashSet<(u32, u32)>,
    outcomes: &HashMap<(u32, u32), Result<CubeBinding, CubeError>>,
) -> bool {
    let mut refs = Vec::new();
    collect_cell_refs(args, &mut refs);
    refs.iter()
        .all(|coord| !object_coords.contains(coord) || outcomes.contains_key(coord))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_measure() {
        assert_eq!(parse_member_expr("[Revenue]").unwrap(), MemberExpr::Measure("Revenue".into()));
        assert_eq!(
            parse_member_expr("[Total Revenue]").unwrap(),
            MemberExpr::Measure("Total Revenue".into())
        );
    }

    #[test]
    fn parses_member_with_value() {
        assert_eq!(
            parse_member_expr("Geo[Country]=Sweden").unwrap(),
            MemberExpr::Member {
                table: Some("Geo".into()),
                column: "Country".into(),
                value: "Sweden".into()
            }
        );
    }

    #[test]
    fn parses_quoted_value() {
        assert_eq!(
            parse_member_expr("Geo[City]='New York'").unwrap(),
            MemberExpr::Member {
                table: Some("Geo".into()),
                column: "City".into(),
                value: "New York".into()
            }
        );
    }

    #[test]
    fn parses_level() {
        assert_eq!(
            parse_member_expr("Geo[Country]").unwrap(),
            MemberExpr::Level { table: "Geo".into(), column: "Country".into() }
        );
    }

    #[test]
    fn rejects_malformed() {
        assert!(parse_member_expr("").is_err());
        assert!(parse_member_expr("Geo[]=x").is_err());
        assert!(parse_member_expr("[Bad[Nested]]").is_err());
        assert!(parse_member_expr("NoBracket").is_err());
    }

    #[test]
    fn parses_tuple() {
        let members = parse_members("Geo[Country]=Sweden, Date[Year]=2025").unwrap();
        assert_eq!(members.len(), 2);
    }

    #[test]
    fn splits_top_level_commas_respecting_quotes_and_braces() {
        let parts = split_top_level_commas("a, b['x, y'], {c, d}");
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0].trim(), "a");
        assert_eq!(parts[1].trim(), "b['x, y']");
        assert_eq!(parts[2].trim(), "{c, d}");
    }

    #[test]
    fn split_treats_stray_apostrophe_as_literal() {
        // An apostrophe inside an unquoted value must NOT open a quote and swallow
        // the following comma (a quote only opens at a token boundary).
        let parts = split_top_level_commas("Geo[Name]=O'Brien, Date[Year]=2025");
        assert_eq!(parts.len(), 2, "got {:?}", parts);
        assert_eq!(parts[0].trim(), "Geo[Name]=O'Brien");
        assert_eq!(parts[1].trim(), "Date[Year]=2025");
        // A boundary quote still groups commas inside it.
        let quoted = split_top_level_commas("Geo[City]='New, York', X[Y]=1");
        assert_eq!(quoted.len(), 2, "got {:?}", quoted);
        assert_eq!(quoted[0].trim(), "Geo[City]='New, York'");
    }

    #[test]
    fn collect_cube_calls_recurses_containers() {
        // A cube call nested inside a list literal must still be discovered.
        let ast = parser::parse(r#"={CUBEVALUE("S","[R]"), 2}"#).unwrap();
        let mut calls = Vec::new();
        collect_cube_calls(&ast, &mut calls);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, BuiltinFunction::CubeValue);
    }

    #[test]
    fn status_bands_map_ratio() {
        let bands = vec![(0.0, -1), (0.9, 0), (1.0, 1)];
        assert_eq!(compute_status(100.0, 100.0, &bands), 1);
        assert_eq!(compute_status(95.0, 100.0, &bands), 0);
        assert_eq!(compute_status(50.0, 100.0, &bands), -1);
    }

    #[test]
    fn default_caption_uses_values() {
        let members = parse_members("Geo[Country]=Sweden").unwrap();
        assert_eq!(default_caption(&members), "Sweden");
    }
}

#[cfg(test)]
mod integration_tests {
    //! End-to-end resolution against an in-memory BI model (no database):
    //! query building, scalar reading, member enumeration, and KPI computation.
    use super::*;
    use crate::bi::types::{Connection, ConnectionType};
    use arrow::array::{Float64Array, StringArray};
    use arrow::datatypes::{DataType as ArrowType, Field, Schema};
    use arrow::record_batch::RecordBatch;
    use bi_engine::{
        sum_measure, Column, DataModel, DataType, Engine, InMemoryConnector, Kpi, KpiStatus,
        KpiTarget, QueryRequest, SourceBinding, StatusBand, StorageMode, Table,
    };
    use identity::EntityId;
    use std::collections::HashMap;

    struct NoResolver;
    impl CubeResolver for NoResolver {
        fn binding_at(&self, _r: u32, _c: u32) -> Option<&CubeBinding> {
            None
        }
        fn cell_text(&self, _r: u32, _c: u32) -> Option<String> {
            None
        }
    }

    fn sales_batch() -> RecordBatch {
        RecordBatch::try_new(
            Arc::new(Schema::new(vec![
                Field::new("country", ArrowType::Utf8, true),
                Field::new("amount", ArrowType::Float64, true),
            ])),
            vec![
                Arc::new(StringArray::from(vec!["USA", "UK", "USA"])),
                Arc::new(Float64Array::from(vec![100.0, 50.0, 75.0])),
            ],
        )
        .unwrap()
    }

    fn build_model() -> DataModel {
        DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("country", DataType::String),
                        Column::new("amount", DataType::Float64),
                    ],
                )
                .unwrap()
                .with_storage_mode(StorageMode::InMemory),
            )
            .add_measure(sum_measure("Revenue", "Sales", "amount"))
            .add_kpi(
                Kpi::new("Revenue KPI", "Revenue", KpiTarget::Constant(200.0))
                    .with_status_band(StatusBand::new(0.0, KpiStatus::OffTrack))
                    .with_status_band(StatusBand::new(0.9, KpiStatus::AtRisk))
                    .with_status_band(StatusBand::new(1.0, KpiStatus::OnTrack)),
            )
            .build()
            .unwrap()
    }

    async fn make_state() -> (BiState, ConnectionId) {
        let model = build_model();
        let mut engine = Engine::new(model);
        let connector = InMemoryConnector::new().with_table("public", "sales", sales_batch());
        let idx = engine.add_in_memory_source(connector);
        engine.bind_table("Sales", idx, SourceBinding::new("public", "sales"));
        // Warm the in-memory cache so ensure_ready's cache-warm check passes and
        // skips the DB auto-connect (there is no real database here).
        let _ = engine
            .query_auto_refresh(QueryRequest {
                measures: vec!["Revenue".into()],
                group_by: vec![bi_engine::ColumnRef::new("Sales", "country")],
                ..Default::default()
            })
            .await;

        let id = EntityId::from_bytes([7u8; 16]);
        let conn = Connection {
            id,
            name: "Sales".into(),
            description: String::new(),
            connection_type: ConnectionType::PostgreSQL,
            connection_string: String::new(),
            server: String::new(),
            database: String::new(),
            preferred_auth: "Integrated".into(),
            model_path: None,
            engine: Some(Arc::new(TokioMutex::new(engine))),
            model_key: None,
            connector_index: Some(idx),
            bindings: vec![],
            last_refreshed: None,
            created_at: String::new(),
            is_connected: true,
            active_queries: HashMap::new(),
            package_data_source_id: None,
            active_role: None,
            base_model: None,
            calculated_measures: vec![],
        };
        let bi = BiState::new();
        bi.connections.lock().unwrap().insert(id, conn);
        (bi, id)
    }

    fn parse_args(formula: &str) -> Vec<Expression> {
        match parser::parse(formula).unwrap() {
            Expression::FunctionCall { args, .. } => args,
            _ => panic!("expected a function call"),
        }
    }

    #[tokio::test]
    async fn query_scalar_total_and_filtered() {
        let (bi, id) = make_state().await;
        let total = query_scalar(&bi, &id, "Revenue", &[]).await.unwrap();
        assert_eq!(total, 225.0);
        let usa = query_scalar(&bi, &id, "Revenue", &[("country".into(), "USA".into())])
            .await
            .unwrap();
        assert_eq!(usa, 175.0);
    }

    #[tokio::test]
    async fn distinct_members_lists_countries() {
        let (bi, id) = make_state().await;
        let mut ctx = CubeCtx::new(&bi);
        let members = distinct_members(&mut ctx, &id, "Sales", "country").await.unwrap();
        assert_eq!(members, vec!["UK".to_string(), "USA".to_string()]);
    }

    #[tokio::test]
    async fn cubevalue_resolves_measure_with_member_filter() {
        let (bi, _id) = make_state().await;
        let mut ctx = CubeCtx::new(&bi);
        let args = parse_args(r#"=CUBEVALUE("Sales","[Revenue]","Sales[country]=USA")"#);
        let result = resolve_cube_value(&mut ctx, &args, &NoResolver).await.unwrap();
        assert_eq!(result, CubeCallResult::Number(175.0));
    }

    #[tokio::test]
    async fn cubevalue_unknown_connection_is_name_error() {
        let (bi, id) = make_state().await;
        let _ = id;
        let mut ctx = CubeCtx::new(&bi);
        let args = parse_args(r#"=CUBEVALUE("Nope","[Revenue]")"#);
        let err = resolve_cube_value(&mut ctx, &args, &NoResolver).await.unwrap_err();
        assert_eq!(err, CubeError::Name);
    }

    #[tokio::test]
    async fn cubeset_enumerates_and_orders_members() {
        let (bi, id) = make_state().await;
        let _ = id;
        let mut ctx = CubeCtx::new(&bi);
        // Unordered level set -> both countries (sorted alphabetically by distinct).
        let set = parse_args(r#"=CUBESET("Sales","Sales[country]")"#);
        let binding = resolve_cube_set(&mut ctx, &set, &NoResolver).await.unwrap();
        assert_eq!(binding.kind, CubeBindingKind::Set);
        assert_eq!(binding.members.len(), 2);
        assert!(binding.members.iter().any(|m| m.contains("USA")));

        // Ordered by Revenue descending -> USA (175) before UK (50).
        let ordered = parse_args(r#"=CUBESET("Sales","Sales[country]","Top",2,"[Revenue]")"#);
        let ob = resolve_cube_set(&mut ctx, &ordered, &NoResolver).await.unwrap();
        assert_eq!(ob.members.len(), 2);
        assert!(ob.members[0].contains("USA"), "USA should rank first, got {:?}", ob.members);
    }

    #[tokio::test]
    async fn cubekpimember_value_and_status() {
        let (bi, id) = make_state().await;
        let _ = id;
        let mut ctx = CubeCtx::new(&bi);
        // Property 1 = Value -> 225.
        let value = resolve_cube_kpi_member(
            &mut ctx,
            &parse_args(r#"=CUBEKPIMEMBER("Sales","Revenue KPI",1)"#),
            &NoResolver,
        )
        .await
        .unwrap();
        assert_eq!(value.scalar, Some(225.0));

        // Property 3 = Status -> 225/200 = 1.125 -> On Track (1).
        let status = resolve_cube_kpi_member(
            &mut ctx,
            &parse_args(r#"=CUBEKPIMEMBER("Sales","Revenue KPI",3)"#),
            &NoResolver,
        )
        .await
        .unwrap();
        assert_eq!(status.scalar, Some(1.0));
        assert_eq!(status.caption, "On Track");
    }

    // ---- Script-facing API (Layer 1) ----

    #[tokio::test]
    async fn script_value_by_name_and_id() {
        let (bi, id) = make_state().await;
        // By connection NAME.
        let v = script_cube_value(&bi, "Sales", &["[Revenue]".into()]).await.unwrap();
        assert_eq!(v, Some(225.0));
        // By connection ID string (scripts use ids).
        let v2 = script_cube_value(&bi, &id.to_string(), &["[Revenue]".into()]).await.unwrap();
        assert_eq!(v2, Some(225.0));
    }

    #[tokio::test]
    async fn script_value_with_member_filter() {
        let (bi, _id) = make_state().await;
        let v = script_cube_value(
            &bi,
            "Sales",
            &["[Revenue]".into(), "Sales[country]=USA".into()],
        )
        .await
        .unwrap();
        assert_eq!(v, Some(175.0));
    }

    #[tokio::test]
    async fn script_value_unknown_connection_errors() {
        let (bi, _id) = make_state().await;
        let err = script_cube_value(&bi, "Nope", &["[Revenue]".into()]).await.unwrap_err();
        assert_eq!(err, CubeError::Name);
    }

    #[tokio::test]
    async fn script_kpi_value_and_status() {
        let (bi, _id) = make_state().await;
        assert_eq!(script_cube_kpi(&bi, "Sales", "Revenue KPI", 1).await.unwrap(), Some(225.0));
        // 225/200 = 1.125 -> On Track (1).
        assert_eq!(script_cube_kpi(&bi, "Sales", "Revenue KPI", 3).await.unwrap(), Some(1.0));
    }

    #[tokio::test]
    async fn script_members_lists_distinct() {
        let (bi, _id) = make_state().await;
        let members = script_cube_members(&bi, "Sales", "Sales[country]").await.unwrap();
        assert_eq!(members, vec!["UK".to_string(), "USA".to_string()]);
    }
}
