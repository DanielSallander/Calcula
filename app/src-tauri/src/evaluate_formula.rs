//! FILENAME: app/src-tauri/src/evaluate_formula.rs
//! PURPOSE: Step-by-step formula evaluation debugger (Evaluate Formula dialog).
//! CONTEXT: Provides session-based Tauri commands that let the user step through
//!          formula evaluation one sub-expression at a time, similar to Excel's
//!          "Evaluate Formula" feature under the Formulas tab.

use std::collections::HashMap;
use std::sync::Mutex;

use engine::{
    BinaryOperator, BuiltinFunction, CellValue, Evaluator, Expression,
    UnaryOperator, Value,
};
use engine::coord::{col_to_index, index_to_col};
use parser::parse as parse_formula;
use tauri::State;

use crate::api_types::EvalStepState;
use crate::{convert_expr, format_cell_value_simple, AppState};

// ============================================================================
// Managed State
// ============================================================================

/// Managed state for evaluate-formula sessions.
pub struct EvalFormulaState {
    sessions: Mutex<HashMap<String, EvalSession>>,
    next_id: Mutex<u64>,
}

impl EvalFormulaState {
    pub fn new() -> Self {
        EvalFormulaState {
            sessions: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
        }
    }

    fn new_session_id(&self) -> String {
        let mut id = self.next_id.lock().unwrap();
        let session_id = format!("eval-{}", *id);
        *id += 1;
        session_id
    }
}

// ============================================================================
// Session Data Structures
// ============================================================================

/// A single frame in the evaluation stack (for Step In / Step Out).
struct StepFrame {
    /// Cell reference for display (e.g., "$A$1")
    cell_ref: String,
    /// Row/col of the cell this frame is evaluating (0-based)
    row: u32,
    col: u32,
    /// Sheet index
    sheet_index: usize,
    /// The original formula text
    original_formula: String,
    /// The working AST - nodes get replaced with Literals as they are resolved
    ast: Expression,
}

/// A step-evaluation session.
struct EvalSession {
    /// Stack of frames; last element is the current frame
    frames: Vec<StepFrame>,
}

// ============================================================================
// AST Utilities
// ============================================================================

/// Result of finding the next node to evaluate.
struct NextNode {
    /// Path to the node (indices into children)
    path: Vec<usize>,
    /// Whether this node is a cell reference (eligible for Step In)
    is_cell_ref: bool,
    /// If cell ref, the sheet/col/row
    cell_ref_info: Option<(Option<String>, String, u32)>,
}

/// Find the next (innermost, leftmost) unresolved node in the AST.
/// Returns None if the entire AST is a single Literal (evaluation complete).
fn find_next_eval_node(expr: &Expression) -> Option<NextNode> {
    let mut path = Vec::new();
    find_next_recursive(expr, &mut path)
}

fn find_next_recursive(expr: &Expression, path: &mut Vec<usize>) -> Option<NextNode> {
    match expr {
        // Already resolved - nothing to evaluate
        Expression::Literal(_) => None,

        // Cell references need resolving
        Expression::CellRef { sheet, col, row } => Some(NextNode {
            path: path.clone(),
            is_cell_ref: true,
            cell_ref_info: Some((sheet.clone(), col.clone(), *row)),
        }),

        // Ranges need resolving
        Expression::Range { .. }
        | Expression::ColumnRef { .. }
        | Expression::RowRef { .. } => Some(NextNode {
            path: path.clone(),
            is_cell_ref: false,
            cell_ref_info: None,
        }),

        // Binary operations: check left, then right, then this node
        Expression::BinaryOp { left, right, .. } => {
            path.push(0);
            if let Some(result) = find_next_recursive(left, path) {
                return Some(result);
            }
            path.pop();

            path.push(1);
            if let Some(result) = find_next_recursive(right, path) {
                return Some(result);
            }
            path.pop();

            // Both sides are resolved - this operation is next
            Some(NextNode {
                path: path.clone(),
                is_cell_ref: false,
                cell_ref_info: None,
            })
        }

        // Unary operations: check operand, then this node
        Expression::UnaryOp { operand, .. } => {
            path.push(0);
            if let Some(result) = find_next_recursive(operand, path) {
                return Some(result);
            }
            path.pop();

            Some(NextNode {
                path: path.clone(),
                is_cell_ref: false,
                cell_ref_info: None,
            })
        }

        // Table references should be resolved before step evaluation.
        // If still present, treat as a non-cell-ref node to resolve.
        Expression::TableRef { .. } => Some(NextNode {
            path: path.clone(),
            is_cell_ref: false,
            cell_ref_info: None,
        }),

        // 3D references: treat as a single node to resolve
        Expression::Sheet3DRef { .. } => Some(NextNode {
            path: path.clone(),
            is_cell_ref: false,
            cell_ref_info: None,
        }),

        // Function calls: special handling for IF short-circuit
        Expression::FunctionCall { func, args } => {
            if matches!(func, BuiltinFunction::If) && args.len() >= 2 {
                // IF: evaluate condition first
                path.push(0);
                if let Some(result) = find_next_recursive(&args[0], path) {
                    return Some(result);
                }
                path.pop();

                // Condition is resolved - determine which branch to evaluate
                if let Expression::Literal(val) = &args[0] {
                    let is_true = match val {
                        Value::Boolean(b) => *b,
                        Value::Number(n) => *n != 0.0,
                        _ => false,
                    };
                    let branch_idx = if is_true { 1 } else { 2 };

                    if branch_idx < args.len() {
                        path.push(branch_idx);
                        if let Some(result) = find_next_recursive(&args[branch_idx], path) {
                            return Some(result);
                        }
                        path.pop();
                    }
                }

                // All relevant args resolved - evaluate the function
                Some(NextNode {
                    path: path.clone(),
                    is_cell_ref: false,
                    cell_ref_info: None,
                })
            } else {
                // Regular function: check each arg left to right
                for (i, arg) in args.iter().enumerate() {
                    path.push(i);
                    if let Some(result) = find_next_recursive(arg, path) {
                        return Some(result);
                    }
                    path.pop();
                }

                // All args resolved - evaluate the function
                Some(NextNode {
                    path: path.clone(),
                    is_cell_ref: false,
                    cell_ref_info: None,
                })
            }
        }
    }
}

/// Navigate to a node in the AST by path and return a mutable reference.
fn get_node_mut<'a>(ast: &'a mut Expression, path: &[usize]) -> &'a mut Expression {
    let mut current = ast;
    for &idx in path {
        current = match current {
            Expression::BinaryOp { left, right, .. } => {
                if idx == 0 { left.as_mut() } else { right.as_mut() }
            }
            Expression::UnaryOp { operand, .. } => operand.as_mut(),
            Expression::FunctionCall { args, .. } => &mut args[idx],
            Expression::Range { start, end, .. } => {
                if idx == 0 { start.as_mut() } else { end.as_mut() }
            }
            _ => current,
        };
    }
    current
}

/// Navigate to a node in the AST by path and return a reference.
fn get_node<'a>(ast: &'a Expression, path: &[usize]) -> &'a Expression {
    let mut current = ast;
    for &idx in path {
        current = match current {
            Expression::BinaryOp { left, right, .. } => {
                if idx == 0 { left.as_ref() } else { right.as_ref() }
            }
            Expression::UnaryOp { operand, .. } => operand.as_ref(),
            Expression::FunctionCall { args, .. } => &args[idx],
            Expression::Range { start, end, .. } => {
                if idx == 0 { start.as_ref() } else { end.as_ref() }
            }
            _ => current,
        };
    }
    current
}

// ============================================================================
// AST to Display String
// ============================================================================

/// Convert the AST to display with proper underline tracking.
/// Returns (display_string, underline_start, underline_end).
fn build_display(ast: &Expression, target_path: &[usize]) -> (String, usize, usize) {
    let mut result = String::new();
    let mut underline = (0_usize, 0_usize);
    build_display_recursive(ast, target_path, &[], &mut result, &mut underline);
    (result, underline.0, underline.1)
}

fn build_display_recursive(
    expr: &Expression,
    target_path: &[usize],
    current_path: &[usize],
    output: &mut String,
    underline: &mut (usize, usize),
) {
    let is_target = current_path == target_path;
    let start_pos = output.len();

    match expr {
        Expression::Literal(val) => {
            output.push_str(&value_to_display(val));
        }

        Expression::CellRef { sheet, col, row, .. } => {
            if let Some(sheet_name) = sheet {
                if sheet_name.contains(' ') {
                    output.push_str(&format!("'{}'!", sheet_name));
                } else {
                    output.push_str(&format!("{}!", sheet_name));
                }
            }
            output.push_str(col);
            output.push_str(&row.to_string());
        }

        Expression::Range { sheet, start, end } => {
            if let Some(sheet_name) = sheet {
                if sheet_name.contains(' ') {
                    output.push_str(&format!("'{}'!", sheet_name));
                } else {
                    output.push_str(&format!("{}!", sheet_name));
                }
            }
            let mut child_path = current_path.to_vec();
            child_path.push(0);
            build_display_recursive(start, target_path, &child_path, output, underline);
            output.push(':');
            child_path.pop();
            child_path.push(1);
            build_display_recursive(end, target_path, &child_path, output, underline);
        }

        Expression::ColumnRef { sheet, start_col, end_col, .. } => {
            if let Some(sheet_name) = sheet {
                output.push_str(&format!("{}!", sheet_name));
            }
            output.push_str(start_col);
            output.push(':');
            output.push_str(end_col);
        }

        Expression::RowRef { sheet, start_row, end_row, .. } => {
            if let Some(sheet_name) = sheet {
                output.push_str(&format!("{}!", sheet_name));
            }
            output.push_str(&start_row.to_string());
            output.push(':');
            output.push_str(&end_row.to_string());
        }

        Expression::BinaryOp { left, op, right } => {
            let mut child_path = current_path.to_vec();
            child_path.push(0);
            build_display_recursive(left, target_path, &child_path, output, underline);

            let op_str = match op {
                BinaryOperator::Add => "+",
                BinaryOperator::Subtract => "-",
                BinaryOperator::Multiply => "*",
                BinaryOperator::Divide => "/",
                BinaryOperator::Power => "^",
                BinaryOperator::Concat => "&",
                BinaryOperator::Equal => "=",
                BinaryOperator::NotEqual => "<>",
                BinaryOperator::LessThan => "<",
                BinaryOperator::GreaterThan => ">",
                BinaryOperator::LessEqual => "<=",
                BinaryOperator::GreaterEqual => ">=",
            };
            output.push_str(op_str);

            child_path.pop();
            child_path.push(1);
            build_display_recursive(right, target_path, &child_path, output, underline);
        }

        Expression::UnaryOp { op, operand } => {
            let op_str = match op {
                UnaryOperator::Negate => "-",
            };
            output.push_str(op_str);

            let mut child_path = current_path.to_vec();
            child_path.push(0);
            build_display_recursive(operand, target_path, &child_path, output, underline);
        }

        Expression::FunctionCall { func, args } => {
            output.push_str(&builtin_fn_name(func));
            output.push('(');
            for (i, arg) in args.iter().enumerate() {
                if i > 0 {
                    output.push_str(", ");
                }
                let mut child_path = current_path.to_vec();
                child_path.push(i);
                build_display_recursive(arg, target_path, &child_path, output, underline);
            }
            output.push(')');
        }

        Expression::TableRef { table_name, specifier } => {
            output.push_str(table_name);
            output.push('[');
            output.push_str(&table_specifier_to_display(specifier));
            output.push(']');
        }

        Expression::Sheet3DRef { start_sheet, end_sheet, reference } => {
            // Format sheet range prefix
            if start_sheet.contains(' ') || end_sheet.contains(' ') {
                output.push_str(&format!("'{}:{}'!", start_sheet, end_sheet));
            } else {
                output.push_str(&format!("{}:{}!", start_sheet, end_sheet));
            }
            let mut child_path = current_path.to_vec();
            child_path.push(0);
            build_display_recursive(reference, target_path, &child_path, output, underline);
        }
    }

    if is_target {
        *underline = (start_pos, output.len());
    }
}

fn value_to_display(val: &Value) -> String {
    match val {
        Value::Number(n) => {
            if n.fract() == 0.0 && n.abs() < 1e15 {
                format!("{}", *n as i64)
            } else {
                let s = format!("{:.10}", n);
                s.trim_end_matches('0').trim_end_matches('.').to_string()
            }
        }
        Value::String(s) => format!("\"{}\"", s),
        Value::Boolean(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
    }
}

fn table_specifier_to_display(spec: &engine::TableSpecifier) -> String {
    match spec {
        engine::TableSpecifier::Column(col) => col.clone(),
        engine::TableSpecifier::ThisRow(col) => format!("@{}", col),
        engine::TableSpecifier::ColumnRange(start, end) => format!("{}:{}", start, end),
        engine::TableSpecifier::ThisRowRange(start, end) => format!("@{}:@{}", start, end),
        engine::TableSpecifier::AllRows => "#All".to_string(),
        engine::TableSpecifier::DataRows => "#Data".to_string(),
        engine::TableSpecifier::Headers => "#Headers".to_string(),
        engine::TableSpecifier::Totals => "#Totals".to_string(),
        engine::TableSpecifier::SpecialColumn(special, col) => {
            format!("{},{}", table_specifier_to_display(special), col)
        }
    }
}

fn builtin_fn_name(func: &BuiltinFunction) -> String {
    match func {
        BuiltinFunction::Sum => "SUM".to_string(),
        BuiltinFunction::Average => "AVERAGE".to_string(),
        BuiltinFunction::Min => "MIN".to_string(),
        BuiltinFunction::Max => "MAX".to_string(),
        BuiltinFunction::Count => "COUNT".to_string(),
        BuiltinFunction::CountA => "COUNTA".to_string(),
        BuiltinFunction::If => "IF".to_string(),
        BuiltinFunction::And => "AND".to_string(),
        BuiltinFunction::Or => "OR".to_string(),
        BuiltinFunction::Not => "NOT".to_string(),
        BuiltinFunction::True => "TRUE".to_string(),
        BuiltinFunction::False => "FALSE".to_string(),
        BuiltinFunction::Abs => "ABS".to_string(),
        BuiltinFunction::Round => "ROUND".to_string(),
        BuiltinFunction::Floor => "FLOOR".to_string(),
        BuiltinFunction::Ceiling => "CEILING".to_string(),
        BuiltinFunction::Sqrt => "SQRT".to_string(),
        BuiltinFunction::Power => "POWER".to_string(),
        BuiltinFunction::Mod => "MOD".to_string(),
        BuiltinFunction::Int => "INT".to_string(),
        BuiltinFunction::Sign => "SIGN".to_string(),
        BuiltinFunction::Len => "LEN".to_string(),
        BuiltinFunction::Upper => "UPPER".to_string(),
        BuiltinFunction::Lower => "LOWER".to_string(),
        BuiltinFunction::Trim => "TRIM".to_string(),
        BuiltinFunction::Concatenate => "CONCATENATE".to_string(),
        BuiltinFunction::Left => "LEFT".to_string(),
        BuiltinFunction::Right => "RIGHT".to_string(),
        BuiltinFunction::Mid => "MID".to_string(),
        BuiltinFunction::Rept => "REPT".to_string(),
        BuiltinFunction::Text => "TEXT".to_string(),
        BuiltinFunction::IsNumber => "ISNUMBER".to_string(),
        BuiltinFunction::IsText => "ISTEXT".to_string(),
        BuiltinFunction::IsBlank => "ISBLANK".to_string(),
        BuiltinFunction::IsError => "ISERROR".to_string(),
        BuiltinFunction::XLookup => "XLOOKUP".to_string(),
        BuiltinFunction::XLookups => "XLOOKUPS".to_string(),

        BuiltinFunction::GetRowHeight => "GET.ROW.HEIGHT".to_string(),
        BuiltinFunction::GetColumnWidth => "GET.COLUMN.WIDTH".to_string(),
        BuiltinFunction::GetCellFillColor => "GET.CELL.FILLCOLOR".to_string(),
        BuiltinFunction::Row => "ROW".to_string(),
        BuiltinFunction::Column => "COLUMN".to_string(),
        BuiltinFunction::Custom(name) => name.clone(),
    }
}

// ============================================================================
// Evaluate a Single Node
// ============================================================================

/// Evaluate a single node in the AST and return its result as a Value literal.
fn evaluate_single_node(
    expr: &Expression,
    grids: &[engine::Grid],
    sheet_names: &[String],
    sheet_index: usize,
) -> Value {
    let engine_ast = expr.clone();
    let current_grid = &grids[sheet_index];
    let current_sheet_name = &sheet_names[sheet_index];

    let context = crate::create_multi_sheet_context(grids, sheet_names, current_sheet_name);

    let evaluator = Evaluator::with_multi_sheet(current_grid, context);
    let result = evaluator.evaluate(&engine_ast);

    eval_result_to_value(&result)
}

fn eval_result_to_value(result: &engine::EvalResult) -> Value {
    match result {
        engine::EvalResult::Number(n) => Value::Number(*n),
        engine::EvalResult::Text(s) => Value::String(s.clone()),
        engine::EvalResult::Boolean(b) => Value::Boolean(*b),
        engine::EvalResult::Error(e) => {
            Value::String(format!("#{}", format!("{:?}", e).to_uppercase()))
        }
        engine::EvalResult::Array(arr) => {
            // For display purposes, show array as first value
            if let Some(first) = arr.first() {
                eval_result_to_value(first)
            } else {
                Value::Number(0.0)
            }
        }
    }
}

// ============================================================================
// Helper: format cell reference for display
// ============================================================================

fn format_cell_ref(row: u32, col: u32) -> String {
    let col_letter = index_to_col(col);
    format!("${}${}", col_letter, row + 1)
}

/// Check if a cell at given coordinates has a formula.
fn cell_has_formula(
    grids: &[engine::Grid],
    sheet_index: usize,
    row: u32,
    col: u32,
) -> bool {
    if sheet_index >= grids.len() {
        return false;
    }
    if let Some(cell) = grids[sheet_index].get_cell(row, col) {
        cell.formula.is_some()
    } else {
        false
    }
}

/// Check if a cell reference points to a formula cell.
/// Returns (sheet_index, row_0based, col_0based, has_formula).
fn check_step_in_target(
    cell_ref_info: &(Option<String>, String, u32),
    grids: &[engine::Grid],
    sheet_names: &[String],
    current_sheet_index: usize,
) -> (usize, u32, u32, bool) {
    let (ref sheet, ref col_str, row_1based) = *cell_ref_info;
    let col_idx = col_to_index(col_str);
    let row_idx = row_1based - 1; // Convert to 0-based

    let target_sheet = if let Some(sheet_name) = sheet {
        sheet_names
            .iter()
            .position(|n| n.to_uppercase() == sheet_name.to_uppercase())
            .unwrap_or(current_sheet_index)
    } else {
        current_sheet_index
    };

    let has_formula = cell_has_formula(grids, target_sheet, row_idx, col_idx);
    (target_sheet, row_idx, col_idx, has_formula)
}

// ============================================================================
// Build State Response
// ============================================================================

fn build_step_state(
    session_id: &str,
    session: &EvalSession,
    grids: &[engine::Grid],
    sheet_names: &[String],
) -> EvalStepState {
    let frame = session.frames.last().unwrap();

    // Find next node to evaluate
    let next = find_next_eval_node(&frame.ast);

    match next {
        None => {
            // Evaluation is complete - the entire AST is a single Literal
            let result_str = match &frame.ast {
                Expression::Literal(val) => value_to_display(val),
                _ => "?".to_string(),
            };

            EvalStepState {
                session_id: session_id.to_string(),
                formula_display: result_str.clone(),
                underline_start: 0,
                underline_end: result_str.len(),
                can_evaluate: false,
                can_step_in: false,
                can_step_out: session.frames.len() > 1,
                is_complete: true,
                cell_reference: frame.cell_ref.clone(),
                step_in_target: None,
                evaluation_result: Some(result_str),
                error: None,
            }
        }
        Some(next_node) => {
            // Build display string with underline
            let (display, ul_start, ul_end) = build_display(&frame.ast, &next_node.path);

            // Check if Step In is available
            let (can_step_in, step_in_target) = if next_node.is_cell_ref {
                if let Some(ref info) = next_node.cell_ref_info {
                    let (_target_sheet, row_0, col_0, has_formula) =
                        check_step_in_target(info, grids, sheet_names, frame.sheet_index);
                    if has_formula {
                        (true, Some(format_cell_ref(row_0, col_0)))
                    } else {
                        (false, None)
                    }
                } else {
                    (false, None)
                }
            } else {
                (false, None)
            };

            EvalStepState {
                session_id: session_id.to_string(),
                formula_display: format!("={}", display),
                underline_start: ul_start + 1, // +1 for the "=" prefix
                underline_end: ul_end + 1,
                can_evaluate: true,
                can_step_in,
                can_step_out: session.frames.len() > 1,
                is_complete: false,
                cell_reference: frame.cell_ref.clone(),
                step_in_target,
                evaluation_result: None,
                error: None,
            }
        }
    }
}

fn error_state(session_id: &str, msg: &str) -> EvalStepState {
    EvalStepState {
        session_id: session_id.to_string(),
        formula_display: String::new(),
        underline_start: 0,
        underline_end: 0,
        can_evaluate: false,
        can_step_in: false,
        can_step_out: false,
        is_complete: true,
        cell_reference: String::new(),
        step_in_target: None,
        evaluation_result: None,
        error: Some(msg.to_string()),
    }
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Initialize a formula evaluation session for the given cell.
#[tauri::command]
pub fn eval_formula_init(
    state: State<AppState>,
    eval_state: State<EvalFormulaState>,
    row: u32,
    col: u32,
) -> EvalStepState {
    let session_id = eval_state.new_session_id();

    let grids = state.grids.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();

    if active_sheet >= grids.len() {
        return error_state(&session_id, "Invalid active sheet.");
    }

    // Get the cell's formula
    let formula = match grids[active_sheet].get_cell(row, col) {
        Some(cell) => match &cell.formula {
            Some(f) => f.clone(),
            None => return error_state(&session_id, "Cell does not contain a formula."),
        },
        None => return error_state(&session_id, "Cell is empty."),
    };

    // Parse the formula into an engine AST (resolve table refs first)
    let ast = match parse_formula(&formula) {
        Ok(parser_ast) => {
            // Resolve named references
            let resolved = if crate::ast_has_named_refs(&parser_ast) {
                let named_ranges_map = state.named_ranges.lock().unwrap();
                let mut visited = std::collections::HashSet::new();
                let r = crate::resolve_names_in_ast(&parser_ast, &named_ranges_map, active_sheet, &mut visited);
                drop(named_ranges_map);
                r
            } else {
                parser_ast
            };
            // Resolve table references
            let resolved = if crate::ast_has_table_refs(&resolved) {
                let tables_map = state.tables.lock().unwrap();
                let table_names_map = state.table_names.lock().unwrap();
                let ctx = crate::TableRefContext {
                    tables: &tables_map,
                    table_names: &table_names_map,
                    current_sheet_index: active_sheet,
                    current_row: row,
                };
                let r = crate::resolve_table_refs_in_ast(&resolved, &ctx);
                drop(table_names_map);
                drop(tables_map);
                r
            } else {
                resolved
            };
            convert_expr(&resolved)
        }
        Err(e) => return error_state(&session_id, &format!("Parse error: {}", e)),
    };

    let cell_ref = format_cell_ref(row, col);

    let session = EvalSession {
        frames: vec![StepFrame {
            cell_ref: cell_ref.clone(),
            row,
            col,
            sheet_index: active_sheet,
            original_formula: formula,
            ast,
        }],
    };

    // Build initial state before storing session
    let result = build_step_state(&session_id, &session, &grids, &sheet_names);

    // Store session
    eval_state
        .sessions
        .lock()
        .unwrap()
        .insert(session_id.clone(), session);

    result
}

/// Evaluate the currently underlined sub-expression and advance.
#[tauri::command]
pub fn eval_formula_evaluate(
    state: State<AppState>,
    eval_state: State<EvalFormulaState>,
    session_id: String,
) -> EvalStepState {
    let grids = state.grids.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();

    let mut sessions = eval_state.sessions.lock().unwrap();
    let session = match sessions.get_mut(&session_id) {
        Some(s) => s,
        None => return error_state(&session_id, "Session not found."),
    };

    let frame = match session.frames.last_mut() {
        Some(f) => f,
        None => return error_state(&session_id, "No active frame."),
    };

    // Find the next node
    let next = match find_next_eval_node(&frame.ast) {
        Some(n) => n,
        None => {
            return build_step_state(&session_id, session, &grids, &sheet_names);
        }
    };

    // Evaluate the node
    let node = get_node(&frame.ast, &next.path);
    let result_value = evaluate_single_node(node, &grids, &sheet_names, frame.sheet_index);

    // Replace the node with a Literal
    let target = get_node_mut(&mut frame.ast, &next.path);
    *target = Expression::Literal(result_value);

    build_step_state(&session_id, session, &grids, &sheet_names)
}

/// Step into a cell reference (push current frame, load referenced cell's formula).
#[tauri::command]
pub fn eval_formula_step_in(
    state: State<AppState>,
    eval_state: State<EvalFormulaState>,
    session_id: String,
) -> EvalStepState {
    let grids = state.grids.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();

    let mut sessions = eval_state.sessions.lock().unwrap();
    let session = match sessions.get_mut(&session_id) {
        Some(s) => s,
        None => return error_state(&session_id, "Session not found."),
    };

    let frame = match session.frames.last() {
        Some(f) => f,
        None => return error_state(&session_id, "No active frame."),
    };

    // Find the next node - must be a cell ref
    let next = match find_next_eval_node(&frame.ast) {
        Some(n) if n.is_cell_ref => n,
        _ => return error_state(&session_id, "Cannot step in: not a cell reference."),
    };

    let cell_ref_info = match &next.cell_ref_info {
        Some(info) => info.clone(),
        None => return error_state(&session_id, "No cell reference info."),
    };

    let (target_sheet, row_0, col_0, has_formula) =
        check_step_in_target(&cell_ref_info, &grids, &sheet_names, frame.sheet_index);

    if !has_formula {
        return error_state(&session_id, "Target cell does not contain a formula.");
    }

    // Get the target cell's formula
    let target_formula = match grids[target_sheet].get_cell(row_0, col_0) {
        Some(cell) => match &cell.formula {
            Some(f) => f.clone(),
            None => return error_state(&session_id, "Target cell has no formula."),
        },
        None => return error_state(&session_id, "Target cell is empty."),
    };

    // Parse the target formula (resolve table refs)
    let target_ast = match parse_formula(&target_formula) {
        Ok(parser_ast) => {
            let resolved = if crate::ast_has_table_refs(&parser_ast) {
                let tables_map = state.tables.lock().unwrap();
                let table_names_map = state.table_names.lock().unwrap();
                let ctx = crate::TableRefContext {
                    tables: &tables_map,
                    table_names: &table_names_map,
                    current_sheet_index: target_sheet,
                    current_row: row_0,
                };
                let r = crate::resolve_table_refs_in_ast(&parser_ast, &ctx);
                drop(table_names_map);
                drop(tables_map);
                r
            } else {
                parser_ast
            };
            convert_expr(&resolved)
        }
        Err(e) => return error_state(&session_id, &format!("Parse error: {}", e)),
    };

    let cell_ref = format_cell_ref(row_0, col_0);

    // Push new frame
    session.frames.push(StepFrame {
        cell_ref,
        row: row_0,
        col: col_0,
        sheet_index: target_sheet,
        original_formula: target_formula,
        ast: target_ast,
    });

    // Enforce max depth
    if session.frames.len() > 32 {
        session.frames.pop();
        return error_state(&session_id, "Maximum step-in depth exceeded.");
    }

    build_step_state(&session_id, session, &grids, &sheet_names)
}

/// Step out: fully evaluate current frame, pop stack, replace cell ref in parent.
#[tauri::command]
pub fn eval_formula_step_out(
    state: State<AppState>,
    eval_state: State<EvalFormulaState>,
    session_id: String,
) -> EvalStepState {
    let grids = state.grids.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();

    let mut sessions = eval_state.sessions.lock().unwrap();
    let session = match sessions.get_mut(&session_id) {
        Some(s) => s,
        None => return error_state(&session_id, "Session not found."),
    };

    if session.frames.len() <= 1 {
        return error_state(&session_id, "Cannot step out: already at top level.");
    }

    // Fully evaluate the current frame's AST
    let child_frame = session.frames.pop().unwrap();
    let final_value = evaluate_single_node(
        &child_frame.ast,
        &grids,
        &sheet_names,
        child_frame.sheet_index,
    );

    // In the parent frame, find the cell ref that was stepped into and replace it
    let parent_frame = session.frames.last_mut().unwrap();
    let next = find_next_eval_node(&parent_frame.ast);
    if let Some(next_node) = next {
        let target = get_node_mut(&mut parent_frame.ast, &next_node.path);
        *target = Expression::Literal(final_value);
    }

    build_step_state(&session_id, session, &grids, &sheet_names)
}

/// Restart the evaluation from the beginning.
#[tauri::command]
pub fn eval_formula_restart(
    state: State<AppState>,
    eval_state: State<EvalFormulaState>,
    session_id: String,
) -> EvalStepState {
    let grids = state.grids.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();

    let mut sessions = eval_state.sessions.lock().unwrap();
    let session = match sessions.get_mut(&session_id) {
        Some(s) => s,
        None => return error_state(&session_id, "Session not found."),
    };

    // Get the bottom frame's info
    let bottom = &session.frames[0];
    let formula = bottom.original_formula.clone();
    let cell_ref = bottom.cell_ref.clone();
    let row = bottom.row;
    let col = bottom.col;
    let sheet_index = bottom.sheet_index;

    // Re-parse the formula (resolve table refs)
    let ast = match parse_formula(&formula) {
        Ok(parser_ast) => {
            let resolved = if crate::ast_has_table_refs(&parser_ast) {
                let tables_map = state.tables.lock().unwrap();
                let table_names_map = state.table_names.lock().unwrap();
                let ctx = crate::TableRefContext {
                    tables: &tables_map,
                    table_names: &table_names_map,
                    current_sheet_index: sheet_index,
                    current_row: row,
                };
                let r = crate::resolve_table_refs_in_ast(&parser_ast, &ctx);
                drop(table_names_map);
                drop(tables_map);
                r
            } else {
                parser_ast
            };
            convert_expr(&resolved)
        }
        Err(e) => return error_state(&session_id, &format!("Parse error: {}", e)),
    };

    // Reset to a single frame
    session.frames.clear();
    session.frames.push(StepFrame {
        cell_ref,
        row,
        col,
        sheet_index,
        original_formula: formula,
        ast,
    });

    build_step_state(&session_id, session, &grids, &sheet_names)
}

/// Close and clean up a session.
#[tauri::command]
pub fn eval_formula_close(
    eval_state: State<EvalFormulaState>,
    session_id: String,
) -> bool {
    eval_state
        .sessions
        .lock()
        .unwrap()
        .remove(&session_id)
        .is_some()
}
