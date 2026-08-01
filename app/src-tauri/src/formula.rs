//! FILENAME: app/src-tauri/src/formula.rs
// PURPOSE: Formula library commands - function catalog, templates, and expression evaluation
// FORMAT: seq|level|category|message

use crate::api_types::{FunctionInfo, FunctionListResult, TypedEvalResult};
use crate::logging::{log_enter, log_exit};
use crate::AppState;
use crate::persistence::UserFilesState;
use tauri::State;
use parser::BuiltinFunction;
use parser::FunctionMeta;
use parser::parse as parse_formula;
use engine::{Evaluator, EvalResult};

/// Build the complete function catalog from the parser's single source of truth.
/// Aliases (e.g. AVG, CEIL) are excluded from the user-facing catalog.
fn build_full_catalog() -> Vec<FunctionInfo> {
    BuiltinFunction::all_catalog_entries()
        .into_iter()
        .filter(|m| !m.is_alias)
        .map(|m| FunctionInfo {
            name: m.name.to_string(),
            syntax: m.syntax.to_string(),
            description: m.description.to_string(),
            category: m.category.to_string(),
        })
        .collect()
}

/// Generate a formula template from a FunctionMeta's syntax string.
///
/// Algorithm:
///   1. If `template_override` is set, use it.
///   2. Extract the function name (before '(') and parameter list (between parens).
///   3. Split params by ',', keep all named params, discard '...' entries.
///   4. Replace each param with an empty slot, join with ", ".
///
/// Examples:
///   "SUM(number1, [number2], ...)"  -> "=SUM()"          (1 required + 1 optional + variadic)
///   "ROUND(number, num_digits)"     -> "=ROUND(, )"      (2 required)
///   "PI()"                          -> "=PI()"            (no params)
fn generate_template(meta: &FunctionMeta) -> String {
    if let Some(t) = meta.template_override {
        return t.to_string();
    }

    let syntax = meta.syntax;
    let open = match syntax.find('(') {
        Some(i) => i,
        None => return format!("={}()", meta.name),
    };
    let close = match syntax.rfind(')') {
        Some(i) => i,
        None => return format!("={}()", meta.name),
    };
    let name = &syntax[..open];
    let params_str = syntax[open + 1..close].trim();

    if params_str.is_empty() {
        return format!("={}()", name);
    }

    let slots: Vec<&str> = params_str
        .split(',')
        .map(|p| p.trim())
        .filter(|p| !p.contains("..."))
        .map(|_| "")
        .collect();

    format!("={}({})", name, slots.join(", "))
}

/// Get list of available functions by category.
#[tauri::command]
pub fn get_functions_by_category(category: String) -> FunctionListResult {
    log_enter!("CMD", "get_functions_by_category", "category={}", category);

    let all = build_full_catalog();
    let cat_lower = category.to_lowercase();
    let functions: Vec<FunctionInfo> = all.into_iter().filter(|f| {
        let fc = f.category.to_lowercase();
        match cat_lower.as_str() {
            "autosum" | "math" => fc == "math",
            "lookup" | "lookup & reference" => fc == "lookup & reference",
            "info" | "information" => fc == "information",
            "date" | "date & time" => fc == "date & time",
            "dynamic" | "dynamic array" => fc == "dynamic array",
            other => fc == other,
        }
    }).collect();

    log_exit!("CMD", "get_functions_by_category", "count={}", functions.len());
    FunctionListResult { functions }
}

/// Get all available functions.
#[tauri::command]
pub fn get_all_functions() -> FunctionListResult {
    log_enter!("CMD", "get_all_functions");
    let functions = build_full_catalog();
    log_exit!("CMD", "get_all_functions", "count={}", functions.len());
    FunctionListResult { functions }
}

/// Generate a formula template for insertion.
/// Looks up the function in the catalog and auto-generates the template from its syntax.
#[tauri::command]
pub fn get_function_template(function_name: String) -> String {
    log_enter!("CMD", "get_function_template", "name={}", function_name);

    let upper = function_name.to_uppercase();
    let catalog = BuiltinFunction::all_catalog_entries();
    let template = catalog
        .iter()
        .find(|m| m.name == upper)
        .map(|m| generate_template(m))
        .unwrap_or_else(|| format!("={}()", upper));

    log_exit!("CMD", "get_function_template", "template={}", template);
    template
}

// ============================================================================
// Expression Evaluation (for file template resolution)
// ============================================================================

/// Evaluate a batch of formula expressions against the current grid state.
/// Used by the file template system to resolve {{ expression }} blocks.
/// Each expression is parsed and evaluated independently; errors are returned
/// as error strings (e.g., "#REF!", "#NAME?") rather than Rust errors.
#[tauri::command]
pub fn evaluate_expressions(
    expressions: Vec<String>,
    state: State<AppState>,
    user_files_state: State<UserFilesState>,
) -> Result<Vec<String>, String> {
    log_enter!("CMD", "evaluate_expressions", "count={}", expressions.len());

    let grids = state.grids.lock().map_err(|e| e.to_string())?;
    let sheet_names = state.sheet_names.lock().map_err(|e| e.to_string())?;
    let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;
    let user_files = user_files_state.files.lock().map_err(|e| e.to_string())?;

    if active_sheet >= grids.len() || active_sheet >= sheet_names.len() {
        return Err("Invalid active sheet index".to_string());
    }

    let current_grid = &grids[active_sheet];
    let current_sheet_name = &sheet_names[active_sheet];

    // Build multi-sheet context once for all expressions
    let context = crate::create_multi_sheet_context(&grids, &sheet_names, current_sheet_name);
    let reader = |path: &str| -> Option<String> {
        user_files.get(path).and_then(|bytes| String::from_utf8(bytes.clone()).ok())
    };

    // Pre-fetch writeback submission data for GATHER functions
    let gather_data = crate::calp_commands::build_gather_data(&state);
    let gather_fn = |region_id: &str| -> engine::GatherRegionData {
        gather_data.get(region_id).cloned().unwrap_or_default()
    };

    let mut evaluator = Evaluator::with_multi_sheet(current_grid, context);
    evaluator.set_file_reader(&reader);
    evaluator.set_gather_fn(&gather_fn);

    let results: Vec<String> = expressions
        .iter()
        .map(|expr_str| {
            // Strip leading = if present (user might write {{ =SUM() }} or {{ SUM() }})
            let formula = expr_str.trim();
            let formula = if formula.starts_with('=') { &formula[1..] } else { formula };

            match parse_formula(formula) {
                Ok(parser_ast) => {
                    let engine_ast = crate::convert_expr(&parser_ast);
                    let result = evaluator.evaluate(&engine_ast);
                    eval_result_to_display(&result)
                }
                Err(_) => "#SYNTAX!".to_string(),
            }
        })
        .collect();

    log_exit!("CMD", "evaluate_expressions", "count={}", results.len());
    Ok(results)
}

/// Convert an EvalResult to a display string for template resolution.
fn eval_result_to_display(result: &EvalResult) -> String {
    match result {
        EvalResult::Number(n) => {
            if n.fract() == 0.0 && n.abs() < 1e15 {
                format!("{}", *n as i64)
            } else {
                format!("{}", n)
            }
        }
        EvalResult::Text(s) => s.clone(),
        EvalResult::Boolean(b) => if *b { "TRUE".to_string() } else { "FALSE".to_string() },
        EvalResult::Error(e) => format!("#{}", format!("{:?}", e).to_uppercase()),
        EvalResult::Array(arr) => {
            if let Some(first) = arr.first() {
                eval_result_to_display(first)
            } else {
                String::new()
            }
        }
        EvalResult::List(items) => format!("[List({})]", items.len()),
        EvalResult::Dict(entries) => format!("[Dict({})]", entries.len()),
        EvalResult::Lambda { .. } => "#LAMBDA".to_string(),
    }
}

// ============================================================================
// Typed grid-backed evaluation (the WorksheetFunction bridge)
// ============================================================================
// `evaluate_expressions` above answers with DISPLAY STRINGS, which is right for
// the file-template system (it splices text) and useless for a caller that
// needs to know whether the answer was the number 5 or the text "5". This is the
// typed counterpart: the same grid, the same evaluator, the engine's own typing.
//
// WHAT IT DELIBERATELY DOES NOT WIRE UP, and why:
//   - the UDF hook. A user-defined function's implementation is JavaScript
//     running in ANOTHER script's worker realm. Resolving one here would let a
//     script re-enter a second script's realm synchronously, from inside a
//     lock-held evaluation, through a door nobody consented to. An unknown name
//     therefore answers #NAME? — the same answer `evaluate_expressions` gives.
//   - pivot data / control values. `evaluate_expressions` does not supply them
//     either; GETPIVOTDATA and GET.CONTROLVALUE fall back to their no-source
//     behaviour. Parity with the existing command beats a second, subtly
//     different evaluation context.
// Both absences are documented on the script-facing surface, because a bridge
// that quietly answers differently from the same formula in a cell is worse
// than one that says where it stops.

/// Map an `EvalResult` onto the `TypedEvalResult` triple. `display` is produced
/// by the SAME formatter the grid uses (default style + workbook locale), so an
/// evaluated 1234.5 reads exactly as it would in a cell.
fn eval_result_to_typed(
    result: &EvalResult,
    styles: &engine::StyleRegistry,
    locale: &engine::LocaleSettings,
) -> TypedEvalResult {
    let kind = match result {
        EvalResult::Number(_) => "number",
        EvalResult::Text(_) => "text",
        EvalResult::Boolean(_) => "boolean",
        EvalResult::Error(_) => "error",
        // An array/list/dict/lambda has no scalar type; it reports as "text"
        // with its rendered form, exactly as a List/Dict CELL does in
        // `typed_cell_value` (commands/data.rs).
        _ => "text",
    };
    let value = match result {
        EvalResult::Array(_) | EvalResult::List(_) | EvalResult::Dict(_) | EvalResult::Lambda { .. } => {
            serde_json::Value::String(eval_result_to_display(result))
        }
        // The REAL Excel literal ("#DIV/0!"), from the same helper the typed
        // CELL read uses (commands/data.rs typed_cell_value). The older
        // `eval_result_to_json` below renders `#{:?}` uppercased, which yields
        // "#DIV0" — close enough for a template splice, wrong for an API whose
        // whole promise is that an error is reported the way the grid reports
        // it. Two paths that answer differently for the same failure is exactly
        // how a script ends up matching on a string that never appears.
        EvalResult::Error(e) => serde_json::Value::String(
            crate::scripting::udf::cell_error_to_str(e).to_string(),
        ),
        other => eval_result_to_json(other),
    };
    let display = match result {
        // A scalar renders through the real number formatter (default style);
        // the aggregate forms have no CellValue equivalent to hand it.
        EvalResult::Number(n) => {
            crate::format_cell_value(&engine::CellValue::Number(*n), styles.get(0), locale)
        }
        EvalResult::Boolean(b) => {
            crate::format_cell_value(&engine::CellValue::Boolean(*b), styles.get(0), locale)
        }
        EvalResult::Error(e) => crate::scripting::udf::cell_error_to_str(e).to_string(),
        other => eval_result_to_display(other),
    };
    TypedEvalResult { value, display, r#type: kind.to_string() }
}

/// Evaluate formula expressions against the live grid and return TYPED results.
///
/// `sheet_index` selects the sheet whose grid unqualified references resolve
/// against (defaults to the active sheet); qualified references ("Sheet2!A1")
/// work regardless. A leading `=` is optional. An expression that does not parse
/// yields `#SYNTAX!` in its own slot instead of failing the batch.
#[tauri::command]
pub fn evaluate_formula_typed(
    expressions: Vec<String>,
    sheet_index: Option<usize>,
    state: State<AppState>,
    user_files_state: State<UserFilesState>,
) -> Result<Vec<TypedEvalResult>, String> {
    log_enter!("CMD", "evaluate_formula_typed", "count={}", expressions.len());

    let grids = state.grids.lock().map_err(|e| e.to_string())?;
    let sheet_names = state.sheet_names.lock().map_err(|e| e.to_string())?;
    let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let locale = state.locale.lock().map_err(|e| e.to_string())?;
    let user_files = user_files_state.files.lock().map_err(|e| e.to_string())?;

    let target_sheet = sheet_index.unwrap_or(active_sheet);
    if target_sheet >= grids.len() || target_sheet >= sheet_names.len() {
        return Err(format!("sheet index out of range: {}", target_sheet));
    }

    let current_grid = &grids[target_sheet];
    let current_sheet_name = &sheet_names[target_sheet];

    let context = crate::create_multi_sheet_context(&grids, &sheet_names, current_sheet_name);
    let reader = |path: &str| -> Option<String> {
        user_files.get(path).and_then(|bytes| String::from_utf8(bytes.clone()).ok())
    };
    let gather_data = crate::calp_commands::build_gather_data(&state);
    let gather_fn = |region_id: &str| -> engine::GatherRegionData {
        gather_data.get(region_id).cloned().unwrap_or_default()
    };

    let mut evaluator = Evaluator::with_multi_sheet(current_grid, context);
    evaluator.set_file_reader(&reader);
    evaluator.set_gather_fn(&gather_fn);

    let results: Vec<TypedEvalResult> = expressions
        .iter()
        .map(|expr_str| {
            let formula = expr_str.trim();
            let formula = formula.strip_prefix('=').unwrap_or(formula);
            match parse_formula(formula) {
                Ok(parser_ast) => {
                    let engine_ast = crate::convert_expr(&parser_ast);
                    let result = evaluator.evaluate(&engine_ast);
                    eval_result_to_typed(&result, &styles, &locale)
                }
                Err(_) => TypedEvalResult {
                    value: serde_json::Value::String("#SYNTAX!".to_string()),
                    display: "#SYNTAX!".to_string(),
                    r#type: "error".to_string(),
                },
            }
        })
        .collect();

    log_exit!("CMD", "evaluate_formula_typed", "count={}", results.len());
    Ok(results)
}

// ============================================================================
// Scope-injected expression evaluation
// ============================================================================
// Dogfooding: extensions can evaluate Excel-like expressions over per-row
// variable scopes through the REAL engine (parser + evaluator), instead of
// shipping a hand-rolled TS parser/evaluator (e.g. Charts' chartFormula.ts).
// Bare identifiers resolve to the injected scope, exactly like LET/LAMBDA.

/// Convert a JSON scope value into an engine value (scalars only).
fn scope_value_to_eval(value: &serde_json::Value) -> EvalResult {
    match value {
        serde_json::Value::Number(n) => EvalResult::Number(n.as_f64().unwrap_or(0.0)),
        serde_json::Value::String(s) => EvalResult::Text(s.clone()),
        serde_json::Value::Bool(b) => EvalResult::Boolean(*b),
        serde_json::Value::Null => EvalResult::Text(String::new()),
        other => EvalResult::Text(other.to_string()),
    }
}

/// Convert an engine result into a JSON value for the frontend.
fn eval_result_to_json(result: &EvalResult) -> serde_json::Value {
    match result {
        EvalResult::Number(n) => serde_json::Number::from_f64(*n)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        EvalResult::Text(s) => serde_json::Value::String(s.clone()),
        EvalResult::Boolean(b) => serde_json::Value::Bool(*b),
        EvalResult::Error(e) => {
            serde_json::Value::String(format!("#{}", format!("{:?}", e).to_uppercase()))
        }
        EvalResult::Array(items) | EvalResult::List(items) => {
            serde_json::Value::Array(items.iter().map(eval_result_to_json).collect())
        }
        EvalResult::Dict(_) | EvalResult::Lambda { .. } => serde_json::Value::Null,
    }
}

/// Parse `expression` once, then evaluate it against each scope (name -> value).
/// Cell references are not resolved (no grid) and yield errors.
fn evaluate_scoped_impl(
    expression: &str,
    scopes: &[std::collections::HashMap<String, serde_json::Value>],
) -> Result<Vec<serde_json::Value>, String> {
    let formula = expression.trim();
    let formula = if let Some(rest) = formula.strip_prefix('=') { rest } else { formula };

    let parsed = match parse_formula(formula) {
        Ok(ast) => crate::convert_expr(&ast),
        Err(_) => return Err("Syntax error in expression".to_string()),
    };

    let grid = engine::Grid::new();
    let results = scopes
        .iter()
        .map(|scope| {
            let evaluator = Evaluator::new(&grid);
            for (name, value) in scope {
                evaluator.bind_name(name, scope_value_to_eval(value));
            }
            eval_result_to_json(&evaluator.evaluate(&parsed))
        })
        .collect();
    Ok(results)
}

/// Evaluate one Excel-like expression repeatedly against a list of variable
/// scopes. Parsed once, evaluated per scope (efficient for per-row chart
/// `calculate`/`filter`). Bare identifiers resolve to the scope; `=` prefix
/// optional. Errors surface as Excel-style strings (e.g. "#DIV/0!").
#[tauri::command]
pub fn evaluate_scoped(
    expression: String,
    scopes: Vec<std::collections::HashMap<String, serde_json::Value>>,
) -> Result<Vec<serde_json::Value>, String> {
    evaluate_scoped_impl(&expression, &scopes)
}

#[cfg(test)]
mod typed_eval_tests {
    use super::*;

    fn typed(result: EvalResult) -> TypedEvalResult {
        let styles = engine::StyleRegistry::new();
        let locale = engine::LocaleSettings::invariant();
        eval_result_to_typed(&result, &styles, &locale)
    }

    /// The whole point of the typed shape: a caller can tell the NUMBER 5 from
    /// the TEXT "5", which a display string can never express.
    #[test]
    fn scalars_keep_the_engines_typing() {
        let n = typed(EvalResult::Number(5.0));
        assert_eq!(n.r#type, "number");
        assert_eq!(n.value, serde_json::json!(5.0));

        let t = typed(EvalResult::Text("5".to_string()));
        assert_eq!(t.r#type, "text");
        assert_eq!(t.value, serde_json::json!("5"));

        let b = typed(EvalResult::Boolean(true));
        assert_eq!(b.r#type, "boolean");
        assert_eq!(b.value, serde_json::json!(true));
    }

    /// An error is an ERROR, not a cell that happens to contain "#DIV/0!" — and
    /// it carries the SAME literal a typed cell read reports. Two paths that
    /// spell the same failure differently ("#DIV/0!" here, "#DIV0" there) is how
    /// a script ends up matching on a string that never appears.
    #[test]
    fn an_error_reports_as_an_error_with_the_real_excel_literal() {
        for (err, literal) in [
            (engine::CellError::Div0, "#DIV/0!"),
            (engine::CellError::Name, "#NAME?"),
            (engine::CellError::Ref, "#REF!"),
            (engine::CellError::Value, "#VALUE!"),
        ] {
            let e = typed(EvalResult::Error(err));
            assert_eq!(e.r#type, "error");
            assert_eq!(e.value, serde_json::json!(literal));
            assert_eq!(e.display, literal);
        }
    }

    /// Display goes through the REAL formatter, so an evaluated number reads the
    /// way the same number reads in a cell.
    #[test]
    fn display_is_formatted_not_debug_printed() {
        assert_eq!(typed(EvalResult::Number(1234.0)).display, "1234");
        assert_eq!(typed(EvalResult::Boolean(false)).display, "FALSE");
        assert_eq!(typed(EvalResult::Text("hi".to_string())).display, "hi");
    }

    /// An array/list has no JSON scalar form; it reports as text with its
    /// rendered value rather than as `null`, which a caller could not
    /// distinguish from an empty cell.
    #[test]
    fn aggregate_results_report_as_text() {
        let a = typed(EvalResult::Array(vec![
            EvalResult::Number(1.0),
            EvalResult::Number(2.0),
        ]));
        assert_eq!(a.r#type, "text");
        assert!(a.value.is_string());
    }

    /// A batch must never lose its other answers to one bad expression: the
    /// syntax failure is a VALUE in its own slot, not a rejected command.
    #[test]
    fn a_syntax_error_is_a_value_not_a_rejection() {
        // Mirrors the command's per-expression fallback exactly.
        assert!(parse_formula("1 +").is_err());
        let fallback = TypedEvalResult {
            value: serde_json::Value::String("#SYNTAX!".to_string()),
            display: "#SYNTAX!".to_string(),
            r#type: "error".to_string(),
        };
        assert_eq!(fallback.r#type, "error");
    }

    /// The UDF hook is deliberately NOT wired: a UDF body is another script's
    /// JavaScript, and resolving one from inside a lock-held evaluation would
    /// re-enter that realm through a door nobody consented to.
    #[test]
    fn the_command_never_installs_a_udf_resolver() {
        let src = include_str!("formula.rs");
        let start = src
            .find("pub fn evaluate_formula_typed")
            .expect("command not found");
        let body = &src[start..start + 3000];
        assert!(!body.contains("set_udf_fn"));
    }
}

#[cfg(test)]
mod scoped_eval_tests {
    use super::*;
    use std::collections::HashMap;

    fn scope(pairs: &[(&str, serde_json::Value)]) -> HashMap<String, serde_json::Value> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    #[test]
    fn arithmetic_over_scopes() {
        let scopes = vec![
            scope(&[("Revenue", serde_json::json!(100)), ("Cost", serde_json::json!(40))]),
            scope(&[("Revenue", serde_json::json!(50)), ("Cost", serde_json::json!(50))]),
        ];
        let out = evaluate_scoped_impl("Revenue - Cost", &scopes).unwrap();
        assert_eq!(out, vec![serde_json::json!(60.0), serde_json::json!(0.0)]);
    }

    #[test]
    fn functions_and_comparison() {
        let scopes = vec![scope(&[("x", serde_json::json!(9))])];
        assert_eq!(
            evaluate_scoped_impl("IF(x > 5, \"big\", \"small\")", &scopes).unwrap(),
            vec![serde_json::json!("big")]
        );
        assert_eq!(
            evaluate_scoped_impl("ROUND(SQRT(x), 2)", &scopes).unwrap(),
            vec![serde_json::json!(3.0)]
        );
    }

    #[test]
    fn names_are_case_insensitive() {
        let scopes = vec![scope(&[("Total", serde_json::json!(10))])];
        assert_eq!(
            evaluate_scoped_impl("total * 2", &scopes).unwrap(),
            vec![serde_json::json!(20.0)]
        );
    }

    #[test]
    fn string_concat() {
        let scopes = vec![scope(&[
            ("first", serde_json::json!("Ann")),
            ("last", serde_json::json!("Lee")),
        ])];
        assert_eq!(
            evaluate_scoped_impl("first & \" \" & last", &scopes).unwrap(),
            vec![serde_json::json!("Ann Lee")]
        );
    }

    #[test]
    fn syntax_error_is_reported() {
        assert!(evaluate_scoped_impl("1 +", &[scope(&[])]).is_err());
    }
}