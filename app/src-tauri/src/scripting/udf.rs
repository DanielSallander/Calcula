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

/// Map a `CellError` to its Excel-standard display string. We deliberately do
/// NOT reuse the app's `format!("#{:?}", e).to_uppercase()` rendering (which
/// yields "#DIV0", "#REF", etc.) because the UDF wire format is a contract with
/// the JS side and must use the canonical Excel error literals that round-trip
/// cleanly through `parse_cell_error`.
fn cell_error_to_str(e: &CellError) -> &'static str {
    match e {
        CellError::Div0 => "#DIV/0!",
        CellError::Ref => "#REF!",
        CellError::Name => "#NAME?",
        CellError::Value => "#VALUE!",
        CellError::NA => "#N/A",
        CellError::Parse => "#VALUE!", // no distinct Excel literal; surface as #VALUE!
        CellError::Circular => "#CIRCULAR!",
        CellError::Conflict => "#CONFLICT",
        CellError::Blocked => "#BLOCKED!",
    }
}

/// Inverse of `cell_error_to_str`. Unrecognized strings fall back to
/// `CellError::Value` (per spec). Matching is case-insensitive on the literal.
fn parse_cell_error(s: &str) -> CellError {
    match s.trim().to_uppercase().as_str() {
        "#DIV/0!" => CellError::Div0,
        "#REF!" => CellError::Ref,
        "#NAME?" => CellError::Name,
        "#VALUE!" => CellError::Value,
        "#N/A" => CellError::NA,
        "#CIRCULAR!" => CellError::Circular,
        "#CONFLICT" => CellError::Conflict,
        "#BLOCKED!" => CellError::Blocked,
        _ => CellError::Value,
    }
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
            EvalResult::List(value.iter().map(udf_to_eval).collect())
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

/// Pre-fetch COLLECT: discover which UDF calls a pending edit (and the formula
/// cells that might transitively depend on a UDF) would make, so the frontend
/// can resolve them off-thread before APPLY.
///
/// This is strictly read-only: it clones the grids into a scratch copy, applies
/// the pending edit there, and evaluates against the scratch with a COLLECTING
/// udf_fn. It never mutates undo, dependents maps, or any real cell.
///
/// Returns the `UdfCall`s discovered this round, EXCLUDING any whose key is
/// already present in `known` (those are already resolved). Callers feed the
/// growing `known` table back across rounds until this returns an empty Vec
/// (a fixed point), at which point all transitively-needed UDF calls are known.
#[tauri::command]
pub fn collect_udf_calls(
    state: State<AppState>,
    _file_state: State<FileState>,
    user_files_state: State<UserFilesState>,
    _slicer_state: State<SlicerState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    row: u32,
    col: u32,
    value: String,
    udf_names: Vec<String>,
    known: HashMap<String, UdfValue>,
) -> Result<Vec<UdfCall>, String> {
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
    let locale = state.locale.lock().unwrap();
    // The edited cell is always on the ACTIVE sheet (update_cell edits there),
    // so mirror that rather than trusting a caller-supplied index.
    let sheet_index = *state.active_sheet.lock().unwrap();

    if sheet_index >= grids.len() || sheet_index >= sheet_names.len() {
        return Err(format!(
            "[collect_udf_calls] sheet_index {} out of range (grids={}, names={})",
            sheet_index,
            grids.len(),
            sheet_names.len()
        ));
    }

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

    // --- SCRATCH copy of grids; apply the pending edit there so dependents see
    // the new value. Parse `value` exactly the way update_cell does.
    let mut scratch: Vec<engine::Grid> = grids.clone();

    // Uppercase the UDF name set defensively (caller is expected to uppercase).
    let udf_name_set: HashSet<String> =
        udf_names.iter().map(|n| n.to_uppercase()).collect();

    // Build the edited cell, including its cached AST if it's a formula, using
    // the same pipeline as update_cell (named/table/spill ref resolution).
    {
        let active_sheet = sheet_index;
        if value.trim().is_empty() {
            scratch[active_sheet].clear_cell(row, col);
        } else {
            let mut cell = parse_cell_input(&value, &locale);
            if let Some(existing) = scratch[active_sheet].get_cell(row, col) {
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
                            active_sheet,
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
                            current_sheet_index: active_sheet,
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
                            active_sheet,
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
            scratch[active_sheet].set_cell(row, col, cell);
        }
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

    // --- Evaluate every formula cell whose text mentions any UDF name (case-
    // insensitive substring is exact-enough for discovery), plus always the
    // edited cell. We use cached ASTs where present, parsing otherwise.
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

    // Iterate formula cells across every sheet; evaluate those that textually
    // reference a UDF name. (A cell can only call a UDF if its name appears in
    // the formula text, so this substring scan is exact for discovery.)
    for sheet in 0..scratch.len() {
        // Collect the candidate coordinates first to avoid borrow issues while
        // evaluating (eval reads the whole scratch slice).
        let mut candidates: Vec<(u32, u32)> = Vec::new();
        for (&(r, c), cell) in scratch[sheet].cells.iter() {
            if cell.get_cached_ast().is_none() {
                continue;
            }
            if let Some(formula) = cell.formula_string() {
                let upper_formula = formula.to_uppercase();
                if udf_name_set
                    .iter()
                    .any(|n| upper_formula.contains(n.as_str()))
                {
                    candidates.push((r, c));
                }
            }
        }
        // Only the active sheet shares index space with `eval_cell`'s sheet_index
        // assumption; for other sheets we evaluate with their own sheet index.
        for (r, c) in candidates {
            if sheet == sheet_index {
                eval_cell(&scratch, r, c);
            } else {
                // Evaluate a formula cell on a non-active sheet.
                if let Some(cell) = scratch[sheet].get_cell(r, c) {
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
                            &scratch,
                            &sheet_names,
                            sheet,
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
            }
        }
    }

    // Always evaluate the edited cell itself (it may be brand new and thus not
    // discovered by the substring scan above if its formula was just set).
    eval_cell(&scratch, row, col);

    // --- Return collected calls, excluding any already-known keys.
    let result: Vec<UdfCall> = collected
        .into_inner()
        .into_values()
        .filter(|c| !known.contains_key(&c.key))
        .collect();
    Ok(result)
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
        // Array converts back to a List (contained, non-spilling).
        assert_eq!(
            udf_to_eval(&u),
            EvalResult::List(vec![
                EvalResult::Number(1.0),
                EvalResult::Text("x".to_string()),
                EvalResult::Boolean(false),
            ])
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
