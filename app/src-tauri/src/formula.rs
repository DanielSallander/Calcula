//! FILENAME: app/src-tauri/src/formula.rs
// PURPOSE: Formula library commands - function catalog, templates, and expression evaluation
// FORMAT: seq|level|category|message

use crate::api_types::{FunctionInfo, FunctionListResult};
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