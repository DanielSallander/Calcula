//! FILENAME: app/src-tauri/src/formula_eval_plan.rs
//! PURPOSE: Generates a complete formula evaluation plan for the visual debugger.
//! CONTEXT: Returns the full expression tree with all intermediate values pre-computed,
//!          evaluation order, and formula reduction steps in a single stateless call.

use std::collections::HashMap;

use engine::{
    BinaryOperator, BuiltinFunction, Expression, Value,
};
use parser::parse as parse_formula;
use tauri::State;

use crate::api_types::{EvalPlanNode, EvalReductionStep, FormulaEvalPlan};
use crate::evaluate_formula::{
    build_display, builtin_fn_name, evaluate_single_node,
    find_next_eval_node, get_node_mut, table_specifier_to_display, value_to_display,
};
use crate::{convert_expr, AppState};

// ============================================================================
// Node ID Assignment
// ============================================================================

/// Intermediate structure for building the node list.
struct NodeInfo {
    id: String,
    node_type: String,
    label: String,
    subtitle: String,
    children: Vec<String>,
    /// Path in the AST (for find_next_eval_node matching)
    path: Vec<usize>,
    is_leaf: bool,
}

/// Walk the AST and assign unique IDs to every node.
/// Returns a flat list of NodeInfo plus a map from AST path -> node_id.
fn assign_node_ids(expr: &Expression) -> (Vec<NodeInfo>, HashMap<Vec<usize>, String>) {
    let mut nodes = Vec::new();
    let mut path_to_id = HashMap::new();
    let mut counter = 0u32;
    assign_ids_recursive(expr, &[], &mut nodes, &mut path_to_id, &mut counter);
    (nodes, path_to_id)
}

fn assign_ids_recursive(
    expr: &Expression,
    current_path: &[usize],
    nodes: &mut Vec<NodeInfo>,
    path_to_id: &mut HashMap<Vec<usize>, String>,
    counter: &mut u32,
) -> String {
    let id = format!("n{}", *counter);
    *counter += 1;
    path_to_id.insert(current_path.to_vec(), id.clone());

    match expr {
        Expression::Literal(val) => {
            let label = value_to_display(val);
            nodes.push(NodeInfo {
                id: id.clone(),
                node_type: "literal".to_string(),
                label: label.clone(),
                subtitle: "constant".to_string(),
                children: vec![],
                path: current_path.to_vec(),
                is_leaf: true,
            });
        }

        Expression::CellRef { sheet, col, row } => {
            let label = if let Some(s) = sheet {
                format!("{}!{}{}", s, col, row)
            } else {
                format!("{}{}", col, row)
            };
            nodes.push(NodeInfo {
                id: id.clone(),
                node_type: "cell_ref".to_string(),
                label,
                subtitle: "cell reference".to_string(),
                children: vec![],
                path: current_path.to_vec(),
                is_leaf: true,
            });
        }

        Expression::Range { sheet, start, end } => {
            // Ranges are leaf nodes (consumed by parent function)
            let mut label = String::new();
            if let Some(s) = sheet {
                label.push_str(&format!("{}!", s));
            }
            label.push_str(&expr_to_short_label(start));
            label.push(':');
            label.push_str(&expr_to_short_label(end));
            nodes.push(NodeInfo {
                id: id.clone(),
                node_type: "range".to_string(),
                label,
                subtitle: "range".to_string(),
                children: vec![],
                path: current_path.to_vec(),
                is_leaf: true,
            });
        }

        Expression::ColumnRef { sheet, start_col, end_col } => {
            let label = if let Some(s) = sheet {
                format!("{}!{}:{}", s, start_col, end_col)
            } else {
                format!("{}:{}", start_col, end_col)
            };
            nodes.push(NodeInfo {
                id: id.clone(),
                node_type: "range".to_string(),
                label,
                subtitle: "column range".to_string(),
                children: vec![],
                path: current_path.to_vec(),
                is_leaf: true,
            });
        }

        Expression::RowRef { sheet, start_row, end_row } => {
            let label = if let Some(s) = sheet {
                format!("{}!{}:{}", s, start_row, end_row)
            } else {
                format!("{}:{}", start_row, end_row)
            };
            nodes.push(NodeInfo {
                id: id.clone(),
                node_type: "range".to_string(),
                label,
                subtitle: "row range".to_string(),
                children: vec![],
                path: current_path.to_vec(),
                is_leaf: true,
            });
        }

        Expression::BinaryOp { left, op, right } => {
            let mut left_path = current_path.to_vec();
            left_path.push(0);
            let left_id = assign_ids_recursive(left, &left_path, nodes, path_to_id, counter);

            let mut right_path = current_path.to_vec();
            right_path.push(1);
            let right_id = assign_ids_recursive(right, &right_path, nodes, path_to_id, counter);

            let op_str = binary_op_str(op);
            let subtitle = format!(
                "{} {} {}",
                short_child_label(left),
                op_str,
                short_child_label(right)
            );
            nodes.push(NodeInfo {
                id: id.clone(),
                node_type: "operator".to_string(),
                label: op_str.to_string(),
                subtitle,
                children: vec![left_id, right_id],
                path: current_path.to_vec(),
                is_leaf: false,
            });
        }

        Expression::UnaryOp { op, operand } => {
            let mut child_path = current_path.to_vec();
            child_path.push(0);
            let child_id = assign_ids_recursive(operand, &child_path, nodes, path_to_id, counter);

            let op_str = unary_op_str(op);
            nodes.push(NodeInfo {
                id: id.clone(),
                node_type: "unary".to_string(),
                label: op_str.to_string(),
                subtitle: "negate".to_string(),
                children: vec![child_id],
                path: current_path.to_vec(),
                is_leaf: false,
            });
        }

        Expression::FunctionCall { func, args } => {
            let fn_name = builtin_fn_name(func);
            let mut child_ids = Vec::new();
            for (i, arg) in args.iter().enumerate() {
                let mut child_path = current_path.to_vec();
                child_path.push(i);
                let child_id = assign_ids_recursive(arg, &child_path, nodes, path_to_id, counter);
                child_ids.push(child_id);
            }

            let subtitle = args
                .iter()
                .map(|a| short_child_label(a))
                .collect::<Vec<_>>()
                .join(", ");

            nodes.push(NodeInfo {
                id: id.clone(),
                node_type: "function".to_string(),
                label: fn_name,
                subtitle,
                children: child_ids,
                path: current_path.to_vec(),
                is_leaf: false,
            });
        }

        Expression::Sheet3DRef { start_sheet, end_sheet, reference } => {
            let mut child_path = current_path.to_vec();
            child_path.push(0);
            let child_id = assign_ids_recursive(reference, &child_path, nodes, path_to_id, counter);

            let label = format!("{}:{}!", start_sheet, end_sheet);
            nodes.push(NodeInfo {
                id: id.clone(),
                node_type: "range".to_string(),
                label,
                subtitle: "3D reference".to_string(),
                children: vec![child_id],
                path: current_path.to_vec(),
                is_leaf: false,
            });
        }

        Expression::TableRef { table_name, specifier } => {
            let label = format!("{}[{}]", table_name, table_specifier_to_display(specifier));
            nodes.push(NodeInfo {
                id: id.clone(),
                node_type: "cell_ref".to_string(),
                label,
                subtitle: "table reference".to_string(),
                children: vec![],
                path: current_path.to_vec(),
                is_leaf: true,
            });
        }

        Expression::IndexAccess { target, index } => {
            let mut target_path = current_path.to_vec();
            target_path.push(0);
            let target_id = assign_ids_recursive(target, &target_path, nodes, path_to_id, counter);

            let mut index_path = current_path.to_vec();
            index_path.push(1);
            let index_id = assign_ids_recursive(index, &index_path, nodes, path_to_id, counter);

            nodes.push(NodeInfo {
                id: id.clone(),
                node_type: "operator".to_string(),
                label: "[]".to_string(),
                subtitle: "index access".to_string(),
                children: vec![target_id, index_id],
                path: current_path.to_vec(),
                is_leaf: false,
            });
        }

        Expression::ListLiteral { elements } => {
            let mut child_ids = Vec::new();
            for (i, elem) in elements.iter().enumerate() {
                let mut child_path = current_path.to_vec();
                child_path.push(i);
                let child_id = assign_ids_recursive(elem, &child_path, nodes, path_to_id, counter);
                child_ids.push(child_id);
            }
            nodes.push(NodeInfo {
                id: id.clone(),
                node_type: "literal".to_string(),
                label: format!("{{...{}}}", elements.len()),
                subtitle: "list literal".to_string(),
                children: child_ids,
                path: current_path.to_vec(),
                is_leaf: false,
            });
        }

        Expression::DictLiteral { entries } => {
            let mut child_ids = Vec::new();
            for (i, (key, value)) in entries.iter().enumerate() {
                let mut key_path = current_path.to_vec();
                key_path.push(i * 2);
                let key_id = assign_ids_recursive(key, &key_path, nodes, path_to_id, counter);
                child_ids.push(key_id);

                let mut val_path = current_path.to_vec();
                val_path.push(i * 2 + 1);
                let val_id = assign_ids_recursive(value, &val_path, nodes, path_to_id, counter);
                child_ids.push(val_id);
            }
            nodes.push(NodeInfo {
                id: id.clone(),
                node_type: "literal".to_string(),
                label: format!("{{...{}}}", entries.len()),
                subtitle: "dict literal".to_string(),
                children: child_ids,
                path: current_path.to_vec(),
                is_leaf: false,
            });
        }

        Expression::NamedRef { name } => {
            nodes.push(NodeInfo {
                id: id.clone(),
                node_type: "named_ref".to_string(),
                label: name.clone(),
                subtitle: "parameter".to_string(),
                children: vec![],
                path: current_path.to_vec(),
                is_leaf: true,
            });
        }
    }

    id
}

/// Short label for a child expression (used in subtitles).
fn short_child_label(expr: &Expression) -> String {
    match expr {
        Expression::Literal(val) => value_to_display(val),
        Expression::CellRef { sheet, col, row } => {
            if let Some(s) = sheet {
                format!("{}!{}{}", s, col, row)
            } else {
                format!("{}{}", col, row)
            }
        }
        Expression::FunctionCall { func, .. } => builtin_fn_name(func),
        Expression::Range { start, end, .. } => {
            format!("{}:{}", expr_to_short_label(start), expr_to_short_label(end))
        }
        Expression::ColumnRef { start_col, end_col, .. } => format!("{}:{}", start_col, end_col),
        Expression::RowRef { start_row, end_row, .. } => format!("{}:{}", start_row, end_row),
        Expression::BinaryOp { op, .. } => binary_op_str(op).to_string(),
        Expression::UnaryOp { op, .. } => unary_op_str(op).to_string(),
        Expression::TableRef { table_name, .. } => table_name.clone(),
        _ => "...".to_string(),
    }
}

/// Convert a BinaryOperator to its display string.
fn binary_op_str(op: &BinaryOperator) -> &'static str {
    match op {
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
    }
}

/// Convert a UnaryOperator to its display string.
fn unary_op_str(op: &engine::UnaryOperator) -> &'static str {
    match op {
        engine::UnaryOperator::Negate => "-",
    }
}

/// Very short label for range endpoints.
fn expr_to_short_label(expr: &Expression) -> String {
    match expr {
        Expression::CellRef { col, row, .. } => format!("{}{}", col, row),
        Expression::Literal(val) => value_to_display(val),
        _ => "?".to_string(),
    }
}

// ============================================================================
// Source Span Computation
// ============================================================================

/// Build the display string and record source spans for ALL nodes.
/// Returns (display_string, map of path -> (start, end)).
fn build_display_with_all_spans(
    ast: &Expression,
) -> (String, HashMap<Vec<usize>, (usize, usize)>) {
    let mut output = String::new();
    let mut spans: HashMap<Vec<usize>, (usize, usize)> = HashMap::new();
    build_spans_recursive(ast, &[], &mut output, &mut spans);
    (output, spans)
}

fn build_spans_recursive(
    expr: &Expression,
    current_path: &[usize],
    output: &mut String,
    spans: &mut HashMap<Vec<usize>, (usize, usize)>,
) {
    let start_pos = output.len();

    match expr {
        Expression::Literal(val) => {
            output.push_str(&value_to_display(val));
        }

        Expression::CellRef { sheet, col, row } => {
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
            build_spans_recursive(start, &child_path, output, spans);
            output.push(':');
            child_path.pop();
            child_path.push(1);
            build_spans_recursive(end, &child_path, output, spans);
        }

        Expression::ColumnRef { sheet, start_col, end_col } => {
            if let Some(sheet_name) = sheet {
                output.push_str(&format!("{}!", sheet_name));
            }
            output.push_str(start_col);
            output.push(':');
            output.push_str(end_col);
        }

        Expression::RowRef { sheet, start_row, end_row } => {
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
            build_spans_recursive(left, &child_path, output, spans);

            output.push_str(binary_op_str(op));

            child_path.pop();
            child_path.push(1);
            build_spans_recursive(right, &child_path, output, spans);
        }

        Expression::UnaryOp { op, operand } => {
            output.push_str(unary_op_str(op));

            let mut child_path = current_path.to_vec();
            child_path.push(0);
            build_spans_recursive(operand, &child_path, output, spans);
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
                build_spans_recursive(arg, &child_path, output, spans);
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
            if start_sheet.contains(' ') || end_sheet.contains(' ') {
                output.push_str(&format!("'{}:{}'!", start_sheet, end_sheet));
            } else {
                output.push_str(&format!("{}:{}!", start_sheet, end_sheet));
            }
            let mut child_path = current_path.to_vec();
            child_path.push(0);
            build_spans_recursive(reference, &child_path, output, spans);
        }

        Expression::IndexAccess { target, index } => {
            let mut child_path = current_path.to_vec();
            child_path.push(0);
            build_spans_recursive(target, &child_path, output, spans);
            output.push('[');
            let mut idx_path = current_path.to_vec();
            idx_path.push(1);
            build_spans_recursive(index, &idx_path, output, spans);
            output.push(']');
        }

        Expression::ListLiteral { elements } => {
            output.push('{');
            for (i, elem) in elements.iter().enumerate() {
                if i > 0 {
                    output.push_str(", ");
                }
                let mut child_path = current_path.to_vec();
                child_path.push(i);
                build_spans_recursive(elem, &child_path, output, spans);
            }
            output.push('}');
        }

        Expression::DictLiteral { entries } => {
            output.push('{');
            for (i, (key, value)) in entries.iter().enumerate() {
                if i > 0 {
                    output.push_str(", ");
                }
                let mut key_path = current_path.to_vec();
                key_path.push(i * 2);
                build_spans_recursive(key, &key_path, output, spans);
                output.push_str(": ");
                let mut val_path = current_path.to_vec();
                val_path.push(i * 2 + 1);
                build_spans_recursive(value, &val_path, output, spans);
            }
            output.push('}');
        }

        Expression::NamedRef { name } => {
            output.push_str(name);
        }
    }

    spans.insert(current_path.to_vec(), (start_pos, output.len()));
}

// ============================================================================
// Subtitle Rebuild with Step References
// ============================================================================

/// Snapshot of a child node's info for subtitle generation (avoids borrow issues).
struct ChildRefInfo {
    label: String,
    node_type: String,
    step_number: Option<usize>,
    value: String,
}

/// After eval order is determined, rebuild all four subtitle variants for operator and function nodes.
/// - `subtitle`:             Values + refs:  "452 (#2) + 452 (E2)"
/// - `subtitle_compact`:     Refs only:      "#2 + E2"
/// - `subtitle_values_only`: Values only:    "452 + 452"
/// - `subtitle_bare`:        No values/refs: original arg summary
fn rebuild_subtitles_with_step_refs(
    plan_nodes: &mut [EvalPlanNode],
    _id_to_idx: &HashMap<String, usize>,
) {
    // Build a snapshot of child info (to avoid borrow issues when mutating plan_nodes)
    let child_info: HashMap<String, ChildRefInfo> = plan_nodes
        .iter()
        .map(|n| {
            (
                n.id.clone(),
                ChildRefInfo {
                    label: n.label.clone(),
                    node_type: n.node_type.clone(),
                    step_number: n.step_number,
                    value: n.value.clone(),
                },
            )
        })
        .collect();

    for i in 0..plan_nodes.len() {
        let node_type = plan_nodes[i].node_type.clone();
        let children = plan_nodes[i].children.clone();
        let label = plan_nodes[i].label.clone();

        if children.is_empty() {
            continue;
        }

        // subtitle_bare keeps the original subtitle (set during assign_node_ids)
        // We only rebuild the other three variants.

        let (rich, compact, values_only) = match node_type.as_str() {
            "operator" => {
                if children.len() == 2 {
                    let (lr, lc, lv) = format_child_all(&children[0], &child_info);
                    let (rr, rc, rv) = format_child_all(&children[1], &child_info);
                    (
                        format!("{} {} {}", lr, label, rr),
                        format!("{} {} {}", lc, label, rc),
                        format!("{} {} {}", lv, label, rv),
                    )
                } else {
                    continue;
                }
            }
            "unary" => {
                if children.len() == 1 {
                    let (cr, cc, cv) = format_child_all(&children[0], &child_info);
                    (
                        format!("{}{}", label, cr),
                        format!("{}{}", label, cc),
                        format!("{}{}", label, cv),
                    )
                } else {
                    continue;
                }
            }
            "function" => {
                let mut args_rich = Vec::new();
                let mut args_compact = Vec::new();
                let mut args_values = Vec::new();
                for cid in &children {
                    let (r, c, v) = format_child_all(cid, &child_info);
                    args_rich.push(r);
                    args_compact.push(c);
                    args_values.push(v);
                }
                (
                    args_rich.join(", "),
                    args_compact.join(", "),
                    args_values.join(", "),
                )
            }
            _ => continue,
        };

        plan_nodes[i].subtitle = rich;
        plan_nodes[i].subtitle_compact = compact;
        plan_nodes[i].subtitle_values_only = values_only;
        // subtitle_bare is left as the original from assign_node_ids
    }
}

/// Returns (rich, compact, values_only) for a single child reference.
/// - rich:        "452 (E2)" / "115749 (#4)"  — values + refs
/// - compact:     "E2" / "#4"                  — refs only
/// - values_only: "452" / "115749"             — values only
fn format_child_all(
    child_id: &str,
    child_info: &HashMap<String, ChildRefInfo>,
) -> (String, String, String) {
    if let Some(info) = child_info.get(child_id) {
        match info.node_type.as_str() {
            "cell_ref" => {
                let val = if info.value.is_empty() { &info.label } else { &info.value };
                let rich = if info.value.is_empty() {
                    info.label.clone()
                } else {
                    format!("{} ({})", info.value, info.label)
                };
                (rich, info.label.clone(), val.clone())
            }
            "literal" | "range" => {
                (info.label.clone(), info.label.clone(), info.label.clone())
            }
            _ => {
                if let Some(step) = info.step_number {
                    let ref_str = format!("#{}", step);
                    let val_str = if info.value.is_empty() {
                        ref_str.clone()
                    } else {
                        info.value.clone()
                    };
                    let rich = if info.value.is_empty() {
                        ref_str.clone()
                    } else {
                        format!("{} (#{})", info.value, step)
                    };
                    (rich, ref_str, val_str)
                } else {
                    (info.label.clone(), info.label.clone(), info.label.clone())
                }
            }
        }
    } else {
        ("?".to_string(), "?".to_string(), "?".to_string())
    }
}

// ============================================================================
// Cost Estimation
// ============================================================================

/// Simple heuristic cost estimation for a node.
fn estimate_cost(expr: &Expression) -> f64 {
    match expr {
        Expression::Literal(_) => 0.0,
        Expression::CellRef { .. } => 1.0,
        Expression::Range { .. } | Expression::ColumnRef { .. } | Expression::RowRef { .. } => 5.0,
        Expression::BinaryOp { .. } => 2.0,
        Expression::UnaryOp { .. } => 1.0,
        Expression::FunctionCall { func, args } => {
            let base = match func {
                BuiltinFunction::XLookup | BuiltinFunction::XLookups |
                BuiltinFunction::Index | BuiltinFunction::Match |
                BuiltinFunction::Indirect | BuiltinFunction::Offset => 30.0,
                BuiltinFunction::SumIfs | BuiltinFunction::CountIfs |
                BuiltinFunction::AverageIfs | BuiltinFunction::MinIfs |
                BuiltinFunction::MaxIfs => 25.0,
                BuiltinFunction::SumIf | BuiltinFunction::CountIf |
                BuiltinFunction::AverageIf => 20.0,
                BuiltinFunction::Sum | BuiltinFunction::Average |
                BuiltinFunction::Count | BuiltinFunction::CountA |
                BuiltinFunction::Min | BuiltinFunction::Max => 15.0,
                BuiltinFunction::SumProduct => 25.0,
                BuiltinFunction::Filter | BuiltinFunction::Sort |
                BuiltinFunction::Unique => 20.0,
                _ => 5.0,
            };
            // Boost cost if there are range arguments
            let has_range = args.iter().any(|a| matches!(a,
                Expression::Range { .. } | Expression::ColumnRef { .. } | Expression::RowRef { .. }
            ));
            if has_range { base * 2.0 } else { base }
        }
        _ => 3.0,
    }
}

// ============================================================================
// Plan Builder
// ============================================================================

/// Build the complete evaluation plan for a formula AST.
fn build_eval_plan(
    ast: &Expression,
    grids: &[engine::Grid],
    sheet_names: &[String],
    sheet_index: usize,
) -> FormulaEvalPlan {
    // 1. Assign node IDs
    let (node_infos, path_to_id) = assign_node_ids(ast);

    // 2. Compute source spans from the initial display string
    let (formula_display, span_map) = build_display_with_all_spans(ast);

    // 3. Compute raw costs for normalization
    let mut raw_costs: HashMap<String, f64> = HashMap::new();
    for info in &node_infos {
        let cost = estimate_cost_by_path(ast, &info.path);
        raw_costs.insert(info.id.clone(), cost);
    }
    let max_cost = raw_costs.values().cloned().fold(0.0_f64, f64::max).max(1.0);

    // 4. Build initial EvalPlanNode list (without values/eval_order yet)
    let mut plan_nodes: Vec<EvalPlanNode> = node_infos
        .iter()
        .map(|info| {
            let (source_start, source_end) = span_map
                .get(&info.path)
                .copied()
                .unwrap_or((0, 0));
            let raw_cost = raw_costs.get(&info.id).copied().unwrap_or(0.0);
            EvalPlanNode {
                id: info.id.clone(),
                node_type: info.node_type.clone(),
                label: info.label.clone(),
                subtitle: info.subtitle.clone(),
                subtitle_compact: info.subtitle.clone(),
                subtitle_values_only: info.subtitle.clone(),
                subtitle_bare: info.subtitle.clone(),
                value: String::new(),
                raw_value: None,
                children: info.children.clone(),
                source_start,
                source_end,
                eval_order: 0,
                cost_pct: (raw_cost / max_cost) * 100.0,
                is_leaf: info.is_leaf,
                step_number: None,
            }
        })
        .collect();

    // 5. Determine evaluation order by repeatedly finding the next node
    let mut working_ast = ast.clone();
    let mut steps: Vec<EvalReductionStep> = Vec::new();
    let mut eval_order_counter = 0usize;

    // Map from node_id to index in plan_nodes for quick updates
    let id_to_idx: HashMap<String, usize> = plan_nodes
        .iter()
        .enumerate()
        .map(|(i, n)| (n.id.clone(), i))
        .collect();

    loop {
        let next = find_next_eval_node(&working_ast);
        match next {
            None => break,
            Some(next_node) => {
                // Map path to node ID
                let node_id = match path_to_id.get(&next_node.path) {
                    Some(id) => id.clone(),
                    None => break, // shouldn't happen
                };

                // Get formula display BEFORE evaluation
                let (formula_before, _, _) = build_display(&working_ast, &next_node.path);

                // Evaluate this node
                let node_expr = get_node_by_path(&working_ast, &next_node.path);
                let result_value = evaluate_single_node(node_expr, grids, sheet_names, sheet_index);
                let display_val = value_to_display(&result_value);
                let raw_val = match &result_value {
                    Value::Number(n) => Some(*n),
                    Value::Boolean(b) => Some(if *b { 1.0 } else { 0.0 }),
                    _ => None,
                };

                // Build description
                let node_label = if let Some(idx) = id_to_idx.get(&node_id) {
                    plan_nodes[*idx].label.clone()
                } else {
                    "?".to_string()
                };
                let description = format!("{} = {}", node_label, display_val);

                // Replace the node in the working AST with the literal value
                let target = get_node_mut(&mut working_ast, &next_node.path);
                *target = Expression::Literal(result_value);

                // Get formula display AFTER evaluation
                // Use an empty path for target to avoid highlighting
                let (formula_after, _, _) = build_display(&working_ast, &[999]);

                // Compute highlight region in formula_after
                let (highlight_start, highlight_end) = find_value_span_in_formula(
                    &formula_after, &formula_before, &next_node.path, &working_ast,
                );

                // Update the plan node
                if let Some(idx) = id_to_idx.get(&node_id) {
                    plan_nodes[*idx].value = display_val.clone();
                    plan_nodes[*idx].raw_value = raw_val;
                    plan_nodes[*idx].eval_order = eval_order_counter;
                    plan_nodes[*idx].step_number = Some(eval_order_counter + 1); // 1-based
                }

                steps.push(EvalReductionStep {
                    node_id: node_id.clone(),
                    description,
                    formula_before,
                    formula_after,
                    highlight_start,
                    highlight_end,
                });

                eval_order_counter += 1;
            }
        }
    }

    // Nodes that were never evaluated (e.g., ranges consumed by parent) keep eval_order = 0
    // Mark them with a high eval_order so frontend knows they weren't individually evaluated
    for node in &mut plan_nodes {
        if node.value.is_empty() && !node.is_leaf {
            node.eval_order = usize::MAX;
        }
    }

    // 6. Rebuild subtitles using step numbers (#N references)
    // For operator/function nodes, replace complex child references with #N
    rebuild_subtitles_with_step_refs(&mut plan_nodes, &id_to_idx);

    // Get root ID (the first node assigned, which is the root)
    let root_id = if let Some(first) = path_to_id.get(&vec![]) {
        first.clone()
    } else {
        "n0".to_string()
    };

    // Final result
    let result = if let Some(idx) = id_to_idx.get(&root_id) {
        plan_nodes[*idx].value.clone()
    } else {
        "?".to_string()
    };

    FormulaEvalPlan {
        formula: formula_display,
        nodes: plan_nodes,
        root_id,
        result,
        steps,
    }
}

/// Get a reference to a node in the AST by path (immutable version for evaluation).
fn get_node_by_path<'a>(ast: &'a Expression, path: &[usize]) -> &'a Expression {
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
            Expression::IndexAccess { target, index } => {
                if idx == 0 { target.as_ref() } else { index.as_ref() }
            }
            Expression::Sheet3DRef { reference, .. } => reference.as_ref(),
            Expression::ListLiteral { elements } => &elements[idx],
            Expression::DictLiteral { entries } => {
                let entry_idx = idx / 2;
                if idx % 2 == 0 { &entries[entry_idx].0 } else { &entries[entry_idx].1 }
            }
            _ => current,
        };
    }
    current
}

/// Estimate cost for a node at a given path in the AST.
fn estimate_cost_by_path(ast: &Expression, path: &[usize]) -> f64 {
    let node = get_node_by_path(ast, path);
    estimate_cost(node)
}

/// Find the span of the newly substituted value in formula_after.
/// We compute the span by getting the position of the evaluated node in the new AST display.
fn find_value_span_in_formula(
    formula_after: &str,
    _formula_before: &str,
    path: &[usize],
    working_ast: &Expression,
) -> (usize, usize) {
    // Build spans for the post-evaluation AST and find the span at the same path
    let (_, spans) = build_display_with_all_spans(working_ast);
    if let Some(&(start, end)) = spans.get(path) {
        (start, end)
    } else {
        (0, formula_after.len())
    }
}

// ============================================================================
// Tauri Command
// ============================================================================

/// Generate the complete formula evaluation plan for the selected cell.
/// Returns all nodes, evaluation order, intermediate values, and reduction steps.
#[tauri::command]
pub fn get_formula_eval_plan(
    state: State<AppState>,
    row: u32,
    col: u32,
) -> Result<FormulaEvalPlan, String> {
    let grids = state.grids.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();

    if active_sheet >= grids.len() {
        return Err("Invalid active sheet.".to_string());
    }

    // Get the cell's formula
    let formula = match grids[active_sheet].get_cell(row, col) {
        Some(cell) => match &cell.formula {
            Some(f) => f.clone(),
            None => return Err("Cell does not contain a formula.".to_string()),
        },
        None => return Err("Cell is empty.".to_string()),
    };

    // Parse the formula into an engine AST (with name and table ref resolution)
    let ast = match parse_formula(&formula) {
        Ok(parser_ast) => {
            // Resolve named references
            let resolved = if crate::ast_has_named_refs(&parser_ast) {
                let named_ranges_map = state.named_ranges.lock().unwrap();
                let mut visited = std::collections::HashSet::new();
                let r = crate::resolve_names_in_ast(
                    &parser_ast,
                    &named_ranges_map,
                    active_sheet,
                    &mut visited,
                );
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
        Err(e) => return Err(format!("Parse error: {}", e)),
    };

    let plan = build_eval_plan(&ast, &grids, &sheet_names, active_sheet);
    Ok(plan)
}
