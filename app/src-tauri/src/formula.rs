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
    let mut evaluator = Evaluator::with_multi_sheet(current_grid, context);
    evaluator.set_file_reader(&reader);

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