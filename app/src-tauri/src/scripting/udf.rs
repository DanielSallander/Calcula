//! FILENAME: app/src-tauri/src/scripting/udf.rs
//! PURPOSE: Rust backend half of user-defined formula function (UDF) evaluation.
//!   The frontend resolves UDF JS implementations off-thread; this module defines
//!   the pinned IPC wire format (UdfValue), the (name,args)->result plumbing, the
//!   read-only `collect_udf_calls` pre-fetch command, and the apply-time resolver
//!   that serves a pre-fetched results table back into the synchronous evaluator.
//!
//! CONTEXT: The engine's `Evaluator::set_udf_fn` hook is already done. Here we
//!   build the closures that feed it. The collecting closure (discovery) records
//!   the (name,args) calls a formula would make; the serving closure (apply)
//!   answers them from a pre-fetched table. Both use `udf_key` so keys match.

use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet};

use engine::{CellError, EvalResult};
use tauri::State;

use crate::persistence::{FileState, UserFilesState};
use crate::slicer::SlicerState;
use crate::{parse_cell_input, AppState};

/// A UDF value crossing the IPC boundary. Tagged union; the TS mirror is:
///   { kind:"number", value:number } | { kind:"text", value:string }
///   | { kind:"boolean", value:boolean } | { kind:"error", value:string }
///   | { kind:"array", value: UdfValue[] } | { kind:"empty" }
///
/// With `#[serde(tag="kind", rename_all="camelCase")]` the variant tags
/// serialize as the lowercase kinds "number","text","boolean","error","array",
/// "empty" (single-word variant names are already lowercase under camelCase).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UdfValue {
    Number { value: f64 },
    Text { value: String },
    Boolean { value: bool },
    Error { value: String }, // e.g. "#VALUE!", "#NAME?"
    Array { value: Vec<UdfValue> },
    Empty,
}

/// Map a `CellError` to its Excel-standard display string.
///
/// THIS TABLE USED TO LIVE HERE, and the duplication was the bug: the engine's
/// `display_value` rendered the same errors as "#DIV0" / "#NAME" / "#REF" via a
/// `format!("#{:?}", e)` fallback, and the persistence layer wrote the Rust
/// variant name into the file, so three spellings of one error existed and only
/// this one round-tripped. There is now exactly one authority — `as_literal` /
/// `from_literal` on the engine's `CellError` — and this pair forwards to it, so
/// the UDF wire format, the cell display and the saved file cannot drift apart
/// again.
pub(crate) fn cell_error_to_str(e: &CellError) -> &'static str {
    e.as_literal()
}

/// Inverse of `cell_error_to_str`. Unrecognized strings fall back to
/// `CellError::Value` (per spec). Matching is case-insensitive on the literal.
fn parse_cell_error(s: &str) -> CellError {
    CellError::from_literal(s)
}

/// Convert an evaluated engine result into a wire-format `UdfValue`.
/// - Number/Text/Boolean map 1:1.
/// - Error(e) -> Error{ canonical Excel string }.
/// - Array/List(items) -> Array{ recursively converted }.
/// - Dict -> Array of its values (keys are dropped; v1 keeps it simple).
/// - Lambda -> Empty (a callable cannot cross the IPC boundary).
pub fn eval_to_udf(r: &EvalResult) -> UdfValue {
    match r {
        EvalResult::Number(n) => UdfValue::Number { value: *n },
        EvalResult::Text(s) => UdfValue::Text { value: s.clone() },
        EvalResult::Boolean(b) => UdfValue::Boolean { value: *b },
        EvalResult::Error(e) => UdfValue::Error {
            value: cell_error_to_str(e).to_string(),
        },
        EvalResult::Array(items) | EvalResult::List(items) => UdfValue::Array {
            value: items.iter().map(eval_to_udf).collect(),
        },
        // Dict maps to an Array of its values (drop keys for v1).
        EvalResult::Dict(entries) => UdfValue::Array {
            value: entries.iter().map(|(_, v)| eval_to_udf(v)).collect(),
        },
        // A lambda can't be serialized across IPC; represent it as Empty.
        EvalResult::Lambda { .. } => UdfValue::Empty,
    }
}

/// Convert a wire-format `UdfValue` back into an engine `EvalResult`.
/// - Error{value} parses the cell-error literal back; unrecognized -> #VALUE!.
/// - Array{value} -> `EvalResult::Array` (NOT `List`). This is what makes a JS
///   array return SPILL like a native dynamic array: `spill_dimensions()` /
///   `to_spill_values()` only recognize `Array`, and `List` renders as the
///   opaque "[List(n)]" text. A flat JS array spills down one column; an array
///   of arrays spills as rows x cols. The apply paths (update_cell /
///   update_cells_batch) already run the spill machinery on the raw result.
/// - Empty -> Text("") to represent a blank result (Number(0.0) would be wrong;
///   an empty cell coerces to "" in text contexts and 0 in numeric contexts via
///   EvalResult::as_number, so Text("") is the safest neutral blank).
pub fn udf_to_eval(v: &UdfValue) -> EvalResult {
    match v {
        UdfValue::Number { value } => EvalResult::Number(*value),
        UdfValue::Text { value } => EvalResult::Text(value.clone()),
        UdfValue::Boolean { value } => EvalResult::Boolean(*value),
        UdfValue::Error { value } => EvalResult::Error(parse_cell_error(value)),
        UdfValue::Array { value } => {
            EvalResult::Array(value.iter().map(udf_to_eval).collect())
        }
        UdfValue::Empty => EvalResult::Text(String::new()),
    }
}

/// Stable key for a (name, args) UDF call. `name` is uppercased. Both collect
/// (which returns this key) and the apply-time udf_fn (which recomputes it from
/// the evaluated args) MUST produce identical keys, so build it the same way:
/// uppercase name + JSON of the UdfValue args.
pub fn udf_key(name: &str, args: &[UdfValue]) -> String {
    format!(
        "{}|{}",
        name.to_uppercase(),
        serde_json::to_string(args).unwrap_or_default()
    )
}

/// Call descriptor returned by `collect_udf_calls`: the stable key, the
/// uppercased function name, and the evaluated arguments (wire format).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UdfCall {
    pub key: String,
    pub name: String,
    pub args: Vec<UdfValue>,
}

/// An ACTIVE-SHEET cell coordinate crossing the UDF wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UdfCellRef {
    pub row: u32,
    pub col: u32,
}

/// What one `collect_udf_calls` round returns.
///
/// `volatile_cells` are the active-sheet cells that call a UDF the author
/// marked VOLATILE. They are NOT necessarily dependents of the edit, so the
/// apply paths must splice them into the recalc order explicitly — otherwise
/// "volatile" would only mean "a fresh value was fetched", not "the cell was
/// recomputed". Empty for every workbook with no volatile UDF, which keeps the
/// ordinary edit path byte-for-byte unchanged.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UdfCollectResult {
    pub calls: Vec<UdfCall>,
    pub volatile_cells: Vec<UdfCellRef>,
}

/// Build the udf_fn closure that serves a pre-fetched results table. On each
/// (name, eval_args): convert args to UdfValue, compute `udf_key`, look up; Some
/// -> `udf_to_eval(result)`, None -> None (engine emits #NAME?).
pub fn make_udf_resolver(
    table: &HashMap<String, UdfValue>,
) -> impl Fn(&str, &[EvalResult]) -> Option<EvalResult> + '_ {
    move |name: &str, eval_args: &[EvalResult]| {
        let args: Vec<UdfValue> = eval_args.iter().map(eval_to_udf).collect();
        let key = udf_key(name, &args);
        table.get(&key).map(udf_to_eval)
    }
}

// ============================================================================
// COLLECT COMMAND (read-only discovery, NO state mutation)
// ============================================================================

/// Pre-fetch COLLECT: discover which UDF calls a pending edit (a single cell
/// edit, or a whole paste/fill batch) would make, so the frontend can resolve
/// them off-thread before APPLY.
///
/// This is strictly read-only: it clones the grids into a scratch copy, applies
/// the pending edits there, and evaluates against the scratch with a COLLECTING
/// udf_fn. It never mutates undo, dependents maps, or any real cell.
///
/// WHICH CELLS ARE EVALUATED (the volatility contract):
///  - the edited cells themselves, always;
///  - active-sheet formula cells that mention a UDF name AND lie in the edit's
///    dependency closure — exactly the set the apply cascade re-evaluates with
///    the resolver wired (`recalc_order_from_seeds` + whole-column/row
///    dependents, computed the same way `update_cell`/`update_cells_batch` do);
///  - active-sheet formula cells that mention a VOLATILE UDF name, wherever
///    they are (Excel's `Application.Volatile`).
///
/// It deliberately does NOT scan non-active sheets: their formula cells are
/// recalculated by `cascade_cross_sheet_dependents` / the batch cross-sheet
/// walk, neither of which is handed a UDF resolver, so those cells always take
/// the `preserved_udf_value` path and a collected result for them could never
/// be served. Scanning them was pure work.
///
/// Returns the `UdfCall`s discovered this round, EXCLUDING any whose key is
/// already present in `known` (those are already resolved), plus the volatile
/// cells the apply path must splice into its recalc order. Callers feed the
/// growing `known` table back across rounds until `calls` comes back empty
/// (a fixed point), at which point all transitively-needed calls are known.
#[tauri::command]
pub fn collect_udf_calls(
    state: State<AppState>,
    _file_state: State<FileState>,
    user_files_state: State<UserFilesState>,
    _slicer_state: State<SlicerState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    edits: Vec<crate::api_types::CellUpdateInput>,
    udf_names: Vec<String>,
    volatile_udf_names: Vec<String>,
    known: HashMap<String, UdfValue>,
) -> Result<UdfCollectResult, String> {
    // The UDF DISCOVERY pass: a throwaway evaluation of the edited cells whose
    // only purpose is to find out which UDF calls need pre-fetching. It must
    // evaluate them EXACTLY as `update_cell`'s apply pass will, or the two
    // passes disagree about which UDF calls exist — so it declares the same
    // Interactive surface rather than a tighter one, even though this pass's
    // results are discarded. A `#LIMIT!` here means the apply pass would have
    // tripped too, which is the honest answer.
    let _pass = crate::eval_budget::begin_pass(
        crate::eval_budget::EvalSurface::Interactive,
        &state.calc_cancel,
    );
    // GET.CONTROLVALUE snapshot: built BEFORE the grid locks below, so the
    // discovery pass evaluates cells the same way update_cell's apply will.
    let control_values = crate::control_values::build_control_values(
        &state, &pane_control_state, &ribbon_filter_state,
    );
    // --- Lock the same READ state update_cell uses to evaluate. We take only
    // immutable locks and never write back. Undo / dependents maps are NOT
    // touched (this pass is discarded).
    let user_files = user_files_state.files.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();
    let grids = state.grids.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    // The edited cells are always on the ACTIVE sheet (update_cell(s_batch)
    // edit there), so mirror that rather than trusting a caller-supplied index.
    let sheet_index = *state.active_sheet.lock().unwrap();

    if sheet_index >= grids.len() || sheet_index >= sheet_names.len() {
        return Err(format!(
            "[collect_udf_calls] sheet_index {} out of range (grids={}, names={})",
            sheet_index,
            grids.len(),
            sheet_names.len()
        ));
    }

    // --- Dependency closure of the pending edits, computed with the SAME
    // helpers the apply cascades use so the two sets agree cell-for-cell. The
    // maps are read pre-edit; that is sound because an edit only ever adds
    // edges POINTING AT the edited cells (dependents[precedent] gains the
    // edited cell), and the edited cells are seeds here anyway.
    //
    // Lock order: styles -> dependents -> ... -> locale, matching
    // update_cell_impl. The guards are confined to this block so nothing is
    // held across the evaluation below.
    let seeds: Vec<(u32, u32)> = edits.iter().map(|e| (e.row, e.col)).collect();
    let affected: crate::CoordSet = {
        let dependents = state.dependents.lock().unwrap();
        let column_dependents = state.column_dependents.lock().unwrap();
        let row_dependents = state.row_dependents.lock().unwrap();
        let mut set: crate::CoordSet =
            crate::recalc_order_from_seeds(&seeds, &dependents, true)
                .into_iter()
                .collect();
        for &seed in &seeds {
            set.insert(seed);
            for dep in crate::get_column_row_dependents(seed, &column_dependents, &row_dependents) {
                set.insert(dep);
            }
        }
        set
    };

    let locale = state.locale.lock().unwrap();

    // Pivot data + gather closures, mirroring update_cell's eval setup so the
    // scratch evaluation sees the same external context.
    let pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let pivot_views = pivot_state.views.lock().unwrap();
    let pivot_data_fn = |data_field: &str, pivot_row: u32, pivot_col: u32, pairs: &[(&str, &str)]| -> Option<f64> {
        crate::pivot::operations::lookup_pivot_data(
            &pivot_tables,
            &pivot_views,
            data_field,
            pivot_row,
            pivot_col,
            pairs,
        )
    };
    let gather_data = crate::calp_commands::build_gather_data(&state);
    let gather_fn = |region_id: &str| -> engine::GatherRegionData {
        gather_data.get(region_id).cloned().unwrap_or_default()
    };

    // --- SCRATCH copy of grids; apply the pending edits there so dependents
    // see the new values. Parse each value exactly the way the apply path does
    // (invariant inputs skip delocalization, as in update_cells_batch).
    let mut scratch: Vec<engine::Grid> = grids.clone();

    // Uppercase the UDF name sets defensively (caller is expected to uppercase).
    let udf_name_set: HashSet<String> =
        udf_names.iter().map(|n| n.to_uppercase()).collect();
    let volatile_name_set: HashSet<String> =
        volatile_udf_names.iter().map(|n| n.to_uppercase()).collect();

    // Build each edited cell, including its cached AST if it's a formula, using
    // the same pipeline as update_cell (named/table/spill ref resolution).
    for edit in &edits {
        let (row, col) = (edit.row, edit.col);
        if edit.value.trim().is_empty() {
            scratch[sheet_index].clear_cell(row, col);
            continue;
        }
        let mut cell = if edit.invariant.unwrap_or(false) {
            crate::parse_cell_input_invariant(&edit.value, &locale)
        } else {
            parse_cell_input(&edit.value, &locale)
        };
        if let Some(existing) = scratch[sheet_index].get_cell(row, col) {
            cell.style_index = existing.style_index;
        }
        if let Some(formula) = cell.formula_string() {
            if let Ok(parsed) = parser::parse(&formula) {
                // Resolve named references.
                let resolved = if crate::ast_has_named_refs(&parsed) {
                    let named_ranges_map = state.named_ranges.lock().unwrap();
                    let mut visited = HashSet::new();
                    crate::resolve_names_in_ast(
                        &parsed,
                        &named_ranges_map,
                        sheet_index,
                        &mut visited,
                    )
                } else {
                    parsed
                };
                // Resolve structured table references.
                let resolved = if crate::ast_has_table_refs(&resolved) {
                    let tables_map = state.tables.lock().unwrap();
                    let table_names_map = state.table_names.lock().unwrap();
                    let ctx = crate::TableRefContext {
                        tables: &tables_map,
                        table_names: &table_names_map,
                        current_sheet_index: sheet_index,
                        current_row: row,
                    };
                    crate::resolve_table_refs_in_ast(&resolved, &ctx)
                } else {
                    resolved
                };
                // Resolve spill range references.
                let resolved = if crate::ast_has_spill_refs(&resolved) {
                    let spill_ranges_map = state.spill_ranges.lock().unwrap();
                    crate::resolve_spill_refs_in_ast(
                        &resolved,
                        &spill_ranges_map,
                        sheet_index,
                    )
                } else {
                    resolved
                };
                let engine_ast = crate::convert_expr(&resolved);
                cell.set_cached_ast(engine_ast);
            }
            // On parse error we still store the cell (no AST); it won't
            // surface UDF calls, which is correct.
        }
        scratch[sheet_index].set_cell(row, col, cell);
    }

    // --- COLLECTING udf_fn. Captures the UDF name set, the known table, and a
    // dedup-by-key accumulator. Returning None for unknown calls lets nested
    // discovery still surface inner calls (the cell becomes #NAME? transiently
    // in this discarded pass).
    let collected: RefCell<BTreeMap<String, UdfCall>> = RefCell::new(BTreeMap::new());
    let collecting_udf_fn = |name: &str, eval_args: &[EvalResult]| -> Option<EvalResult> {
        let upper = name.to_uppercase();
        // Not a registered UDF -> let the engine emit #NAME?.
        if !udf_name_set.contains(&upper) {
            return None;
        }
        let args: Vec<UdfValue> = eval_args.iter().map(eval_to_udf).collect();
        let key = udf_key(&upper, &args);
        // Already resolved -> serve it so dependent/nested eval proceeds.
        if let Some(known_val) = known.get(&key) {
            return Some(udf_to_eval(known_val));
        }
        // Record for the frontend to resolve, dedup by key.
        collected
            .borrow_mut()
            .entry(key.clone())
            .or_insert_with(|| UdfCall {
                key,
                name: upper,
                args,
            });
        // Return None so nested discovery still happens.
        None
    };
    let udf_dyn: &dyn Fn(&str, &[EvalResult]) -> Option<EvalResult> = &collecting_udf_fn;

    // --- Candidate scan over the ACTIVE sheet only (see the fn doc). A cell
    // can only call a UDF if the name appears in its formula text, so the
    // case-insensitive substring test is exact for discovery.
    let mut candidates: Vec<(u32, u32)> = Vec::new();
    let mut volatile_cells: Vec<UdfCellRef> = Vec::new();
    for (&(r, c), cell) in scratch[sheet_index].cells.iter() {
        if cell.get_cached_ast().is_none() {
            continue;
        }
        let Some(formula) = cell.formula_string() else {
            continue;
        };
        let upper_formula = formula.to_uppercase();
        if !udf_name_set
            .iter()
            .any(|n| upper_formula.contains(n.as_str()))
        {
            continue;
        }
        let is_volatile = volatile_name_set
            .iter()
            .any(|n| upper_formula.contains(n.as_str()));
        if is_volatile {
            volatile_cells.push(UdfCellRef { row: r, col: c });
        } else if !affected.contains(&(r, c)) {
            // Not reachable from this edit and not volatile: the apply cascade
            // will never re-evaluate it, so resolving it would be wasted work.
            continue;
        }
        candidates.push((r, c));
    }
    // Deterministic evaluation order (cells iterate in hash order otherwise).
    candidates.sort_unstable();
    volatile_cells.sort_unstable_by_key(|v| (v.row, v.col));

    // --- Evaluate each candidate with its OWN position, using the cached AST.
    let eval_cell = |scratch: &[engine::Grid], r: u32, c: u32| {
        if let Some(cell) = scratch[sheet_index].get_cell(r, c) {
            if let Some(ast) = cell.get_cached_ast() {
                let ast = ast.clone();
                let eval_ctx = engine::EvalContext {
                    cube_prefetch: None,
                    current_row: Some(r),
                    current_col: Some(c),
                    row_heights: None,
                    column_widths: None,
                    hidden_rows: None,
                    control_values: Some(control_values.clone()),
                };
                let _ = crate::evaluate_formula_raw_with_files_and_pivot(
                    scratch,
                    &sheet_names,
                    sheet_index,
                    &ast,
                    eval_ctx,
                    Some(&styles),
                    &user_files,
                    Some(&pivot_data_fn),
                    Some(&gather_fn),
                    Some(udf_dyn),
                );
            }
        }
    };

    for (r, c) in &candidates {
        eval_cell(&scratch, *r, *c);
    }

    // Always evaluate the edited cells themselves (a brand-new formula is not
    // in the pre-edit dependents graph, and the scan above only sees it once
    // it has been written into the scratch — which it has, but an edit whose
    // formula parse failed still deserves the explicit pass).
    for &(row, col) in &seeds {
        eval_cell(&scratch, row, col);
    }

    // --- Return collected calls, excluding any already-known keys.
    let calls: Vec<UdfCall> = collected
        .into_inner()
        .into_values()
        .filter(|c| !known.contains_key(&c.key))
        .collect();
    Ok(UdfCollectResult {
        calls,
        volatile_cells,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocked_cell_error_round_trips() {
        // Refused code surfaces as #BLOCKED! (distinct from #VALUE!/#NAME?) and
        // round-trips through the UDF wire format without collapsing to #VALUE!.
        assert_eq!(cell_error_to_str(&CellError::Blocked), "#BLOCKED!");
        assert_eq!(parse_cell_error("#BLOCKED!"), CellError::Blocked);
        assert_eq!(parse_cell_error("#blocked!"), CellError::Blocked); // case-insensitive
        // A blocked UDF error value maps to the Blocked cell error, not Value.
        let u = UdfValue::Error { value: "#BLOCKED!".to_string() };
        assert_eq!(udf_to_eval(&u), EvalResult::Error(CellError::Blocked));
    }

    #[test]
    fn roundtrip_number() {
        let r = EvalResult::Number(42.5);
        let u = eval_to_udf(&r);
        assert_eq!(u, UdfValue::Number { value: 42.5 });
        assert_eq!(udf_to_eval(&u), EvalResult::Number(42.5));
    }

    #[test]
    fn roundtrip_text() {
        let r = EvalResult::Text("hello".to_string());
        let u = eval_to_udf(&r);
        assert_eq!(u, UdfValue::Text { value: "hello".to_string() });
        assert_eq!(udf_to_eval(&u), EvalResult::Text("hello".to_string()));
    }

    #[test]
    fn roundtrip_boolean() {
        let r = EvalResult::Boolean(true);
        let u = eval_to_udf(&r);
        assert_eq!(u, UdfValue::Boolean { value: true });
        assert_eq!(udf_to_eval(&u), EvalResult::Boolean(true));
    }

    #[test]
    fn roundtrip_error() {
        for (err, lit) in [
            (CellError::Div0, "#DIV/0!"),
            (CellError::Ref, "#REF!"),
            (CellError::Name, "#NAME?"),
            (CellError::Value, "#VALUE!"),
            (CellError::NA, "#N/A"),
        ] {
            let r = EvalResult::Error(err.clone());
            let u = eval_to_udf(&r);
            assert_eq!(u, UdfValue::Error { value: lit.to_string() });
            assert_eq!(udf_to_eval(&u), EvalResult::Error(err));
        }
    }

    #[test]
    fn error_unknown_string_falls_back_to_value() {
        let u = UdfValue::Error { value: "#WAT".to_string() };
        assert_eq!(udf_to_eval(&u), EvalResult::Error(CellError::Value));
    }

    #[test]
    fn roundtrip_array() {
        let r = EvalResult::Array(vec![
            EvalResult::Number(1.0),
            EvalResult::Text("x".to_string()),
            EvalResult::Boolean(false),
        ]);
        let u = eval_to_udf(&r);
        assert_eq!(
            u,
            UdfValue::Array {
                value: vec![
                    UdfValue::Number { value: 1.0 },
                    UdfValue::Text { value: "x".to_string() },
                    UdfValue::Boolean { value: false },
                ]
            }
        );
        // Array converts back to an engine Array so the result SPILLS (a List
        // would render as the opaque "[List(n)]" and stay in one cell).
        assert_eq!(
            udf_to_eval(&u),
            EvalResult::Array(vec![
                EvalResult::Number(1.0),
                EvalResult::Text("x".to_string()),
                EvalResult::Boolean(false),
            ])
        );
    }

    #[test]
    fn flat_array_return_spills_down_one_column() {
        // A JS `return [1,2,3]` must behave like a native dynamic array: three
        // rows, one column — NOT the contained "[List(3)]" text.
        let u = UdfValue::Array {
            value: vec![
                UdfValue::Number { value: 1.0 },
                UdfValue::Number { value: 2.0 },
                UdfValue::Number { value: 3.0 },
            ],
        };
        let r = udf_to_eval(&u);
        assert_eq!(r.spill_dimensions(), (3, 1));
        let spilled = r.to_spill_values();
        assert_eq!(spilled.len(), 3);
        assert_eq!(spilled[0], (0, 0, engine::CellValue::Number(1.0)));
        assert_eq!(spilled[2], (2, 0, engine::CellValue::Number(3.0)));
        // And it no longer renders as the opaque list marker.
        assert_ne!(r.as_text(), "[List(3)]");
    }

    #[test]
    fn nested_array_return_spills_as_rows_and_columns() {
        // `return [[1,2],[3,4]]` -> a 2x2 spill.
        let row = |a: f64, b: f64| UdfValue::Array {
            value: vec![UdfValue::Number { value: a }, UdfValue::Number { value: b }],
        };
        let u = UdfValue::Array { value: vec![row(1.0, 2.0), row(3.0, 4.0)] };
        let r = udf_to_eval(&u);
        assert_eq!(r.spill_dimensions(), (2, 2));
        let spilled = r.to_spill_values();
        assert_eq!(spilled.len(), 4);
        assert_eq!(spilled[1], (0, 1, engine::CellValue::Number(2.0)));
        assert_eq!(spilled[3], (1, 1, engine::CellValue::Number(4.0)));
    }

    #[test]
    fn empty_array_return_does_not_spill() {
        // Degenerate but reachable (`return []`): must stay one cell rather
        // than claiming a zero-sized spill range.
        let r = udf_to_eval(&UdfValue::Array { value: vec![] });
        assert_eq!(r, EvalResult::Array(vec![]));
        assert_eq!(r.spill_dimensions(), (1, 1));
    }

    #[test]
    fn array_result_serves_through_the_resolver() {
        // End-to-end through the apply-time resolver: the table entry is an
        // array and the engine receives a spillable Array.
        let mut table = HashMap::new();
        let args = vec![UdfValue::Number { value: 3.0 }];
        table.insert(
            udf_key("MAKELIST", &args),
            UdfValue::Array {
                value: vec![
                    UdfValue::Number { value: 1.0 },
                    UdfValue::Number { value: 2.0 },
                    UdfValue::Number { value: 3.0 },
                ],
            },
        );
        let resolver = make_udf_resolver(&table);
        let hit = resolver("MAKELIST", &[EvalResult::Number(3.0)]).expect("served");
        assert_eq!(hit.spill_dimensions(), (3, 1));
    }

    #[test]
    fn every_engine_cell_error_round_trips_through_the_wire() {
        // A UDF author returning any of these literals must land on the
        // matching CellError, not collapse to #VALUE! (defect: UDFs could not
        // return a specific error value at all).
        for (err, lit) in [
            (CellError::Div0, "#DIV/0!"),
            (CellError::Ref, "#REF!"),
            (CellError::Name, "#NAME?"),
            (CellError::Value, "#VALUE!"),
            (CellError::NA, "#N/A"),
            (CellError::Circular, "#CIRCULAR!"),
            (CellError::Conflict, "#CONFLICT"),
            (CellError::Blocked, "#BLOCKED!"),
            (CellError::Limit, "#LIMIT!"),
        ] {
            let u = UdfValue::Error { value: lit.to_string() };
            assert_eq!(
                udf_to_eval(&u),
                EvalResult::Error(err.clone()),
                "literal {} must parse back to {:?}",
                lit,
                err
            );
            // Lower-case spelling is accepted too (authors type "#n/a").
            let lower = UdfValue::Error { value: lit.to_lowercase() };
            assert_eq!(udf_to_eval(&lower), EvalResult::Error(err));
        }
    }

    #[test]
    fn error_return_serves_through_the_resolver() {
        let mut table = HashMap::new();
        let args = vec![UdfValue::Text { value: "missing".to_string() }];
        table.insert(
            udf_key("LOOKUPX", &args),
            UdfValue::Error { value: "#N/A".to_string() },
        );
        let resolver = make_udf_resolver(&table);
        assert_eq!(
            resolver("LOOKUPX", &[EvalResult::Text("missing".to_string())]),
            Some(EvalResult::Error(CellError::NA))
        );
    }

    #[test]
    fn cell_ref_and_collect_result_serialize_camel_case() {
        // The TS mirror reads `volatileCells: [{row, col}]`.
        let r = UdfCollectResult {
            calls: vec![UdfCall {
                key: "K".to_string(),
                name: "F".to_string(),
                args: vec![],
            }],
            volatile_cells: vec![UdfCellRef { row: 2, col: 5 }],
        };
        let json = serde_json::to_string(&r).unwrap();
        assert_eq!(
            json,
            r#"{"calls":[{"key":"K","name":"F","args":[]}],"volatileCells":[{"row":2,"col":5}]}"#
        );
    }

    #[test]
    fn empty_roundtrips_to_blank_text() {
        assert_eq!(udf_to_eval(&UdfValue::Empty), EvalResult::Text(String::new()));
    }

    #[test]
    fn lambda_maps_to_empty() {
        use engine::Expression;
        let r = EvalResult::Lambda {
            params: vec!["x".to_string()],
            body: Box::new(Expression::Literal(engine::Value::Number(1.0))),
            captured: HashMap::new(),
        };
        assert_eq!(eval_to_udf(&r), UdfValue::Empty);
    }

    #[test]
    fn udf_key_is_deterministic() {
        let args = vec![UdfValue::Number { value: 1.0 }, UdfValue::Text { value: "a".to_string() }];
        let k1 = udf_key("myfunc", &args);
        let k2 = udf_key("MYFUNC", &args);
        // Name is uppercased, so case doesn't matter.
        assert_eq!(k1, k2);
        // Same inputs -> identical key.
        assert_eq!(k1, udf_key("MyFunc", &args));
    }

    #[test]
    fn udf_key_changes_with_args() {
        let a1 = vec![UdfValue::Number { value: 1.0 }, UdfValue::Number { value: 2.0 }];
        let a2 = vec![UdfValue::Number { value: 2.0 }, UdfValue::Number { value: 1.0 }];
        let a3 = vec![UdfValue::Number { value: 1.0 }, UdfValue::Number { value: 3.0 }];
        // Arg order matters.
        assert_ne!(udf_key("F", &a1), udf_key("F", &a2));
        // Arg value matters.
        assert_ne!(udf_key("F", &a1), udf_key("F", &a3));
        // Function name matters.
        assert_ne!(udf_key("F", &a1), udf_key("G", &a1));
    }

    #[test]
    fn resolver_serves_table() {
        let mut table = HashMap::new();
        let args = vec![UdfValue::Number { value: 10.0 }];
        let key = udf_key("DOUBLE", &args);
        table.insert(key, UdfValue::Number { value: 20.0 });

        let resolver = make_udf_resolver(&table);

        // Hit: name (already uppercased by engine) + matching args.
        let hit = resolver("DOUBLE", &[EvalResult::Number(10.0)]);
        assert_eq!(hit, Some(EvalResult::Number(20.0)));

        // Hit also works when the engine passes a lowercase name (defensive
        // uppercasing inside udf_key).
        let hit_lower = resolver("double", &[EvalResult::Number(10.0)]);
        assert_eq!(hit_lower, Some(EvalResult::Number(20.0)));

        // Miss: different args.
        let miss_args = resolver("DOUBLE", &[EvalResult::Number(11.0)]);
        assert_eq!(miss_args, None);

        // Miss: unknown name.
        let miss_name = resolver("TRIPLE", &[EvalResult::Number(10.0)]);
        assert_eq!(miss_name, None);
    }

    #[test]
    fn number_serializes_as_expected_json() {
        let u = UdfValue::Number { value: 3.0 };
        let json = serde_json::to_string(&u).unwrap();
        assert_eq!(json, r#"{"kind":"number","value":3.0}"#);
    }

    #[test]
    fn array_serializes_as_expected_json() {
        let u = UdfValue::Array {
            value: vec![
                UdfValue::Number { value: 1.0 },
                UdfValue::Empty,
            ],
        };
        let json = serde_json::to_string(&u).unwrap();
        assert_eq!(
            json,
            r#"{"kind":"array","value":[{"kind":"number","value":1.0},{"kind":"empty"}]}"#
        );
    }
}
