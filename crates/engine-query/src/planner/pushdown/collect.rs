//! Expression walkers that collect referenced names: table variables, named
//! contexts, USERELATIONSHIP relationships, and QUERY binding names.

use engine_core::compute::expression::Expression;
use engine_core::model::DataModel;

/// Check if an expression contains any `QualifiedColumnRef` that references
/// a table variable (rather than a real table). Such references require
/// context resolution and cannot be pushed down as simple aggregates.
pub(super) fn has_table_variable_refs(expr: &Expression, model: &DataModel) -> bool {
    match expr {
        Expression::QualifiedColumnRef { table_or_var, .. } => {
            model.table_variable(table_or_var).is_ok()
        }
        Expression::Aggregate { operand, .. } => has_table_variable_refs(operand, model),
        Expression::BinaryOp { left, right, .. }
        | Expression::Comparison { left, right, .. }
        | Expression::And(left, right)
        | Expression::Or(left, right)
        | Expression::Xor(left, right) => {
            has_table_variable_refs(left, model) || has_table_variable_refs(right, model)
        }
        Expression::Not(inner) | Expression::IsBlank(inner) => {
            has_table_variable_refs(inner, model)
        }
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => {
            has_table_variable_refs(condition, model)
                || has_table_variable_refs(then_expr, model)
                || has_table_variable_refs(else_expr, model)
        }
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => {
            has_table_variable_refs(numerator, model)
                || has_table_variable_refs(denominator, model)
                || alternate
                    .as_ref()
                    .is_some_and(|a| has_table_variable_refs(a, model))
        }
        Expression::Coalesce(exprs) => exprs.iter().any(|e| has_table_variable_refs(e, model)),
        Expression::ScalarFunc { args, .. } | Expression::TextFunc { args, .. } => {
            args.iter().any(|a| has_table_variable_refs(a, model))
        }
        Expression::Call { args, .. } => args.iter().any(|a| has_table_variable_refs(a, model)),
        _ => false,
    }
}

/// Collect all base tables referenced by table variables in an expression.
///
/// This walks the expression to find:
/// - `Keep { variables: [name, ...] }` — bare variable references
/// - `QualifiedColumnRef { table_or_var }` — variable-qualified column refs
/// - `Keep { expr: TableRef(name) }` — older-style variable refs
///
/// For each variable, follows the source chain to the base table and collects
/// all filter tables along the way. These tables must be fetched and registered
/// in DataFusion for the query to succeed.
pub(super) fn collect_variable_tables(expr: &Expression, model: &DataModel) -> Vec<String> {
    let mut var_names = Vec::new();
    collect_variable_names(expr, model, &mut var_names);

    let mut tables = Vec::new();
    for var_name in &var_names {
        resolve_variable_tables(var_name, model, &mut tables);
    }
    tables.sort();
    tables.dedup();
    tables
}

/// Recursively collect all variable names referenced in an expression.
fn collect_variable_names(expr: &Expression, model: &DataModel, names: &mut Vec<String>) {
    match expr {
        Expression::QualifiedColumnRef { table_or_var, .. } => {
            if model.table_variable(table_or_var).is_ok() {
                names.push(table_or_var.clone());
            }
        }
        Expression::Keep {
            expr: inner,
            variables,
            ..
        } => {
            for v in variables {
                // Only collect table variable names, not named context names.
                // Named contexts are resolved at context-resolution time and
                // don't reference additional tables directly.
                if model.table_variable(v).is_ok() {
                    names.push(v.clone());
                }
            }
            // Check for TableRef inside Keep (older pattern).
            if let Expression::TableRef(ref name) = **inner {
                if model.table_variable(name).is_ok() {
                    names.push(name.clone());
                }
            }
            collect_variable_names(inner, model, names);
        }
        Expression::Aggregate { operand, .. } => collect_variable_names(operand, model, names),
        Expression::BinaryOp { left, right, .. }
        | Expression::Comparison { left, right, .. }
        | Expression::And(left, right)
        | Expression::Or(left, right)
        | Expression::Xor(left, right) => {
            collect_variable_names(left, model, names);
            collect_variable_names(right, model, names);
        }
        Expression::Not(inner) | Expression::IsBlank(inner) => {
            collect_variable_names(inner, model, names);
        }
        Expression::Clear { expr: inner, .. }
        | Expression::Reset { expr: inner }
        | Expression::ClearInner { expr: inner, .. }
        | Expression::ClearOuter { expr: inner, .. }
        | Expression::ResetInner { expr: inner }
        | Expression::ResetOuter { expr: inner }
        | Expression::Traverse { expr: inner, .. }
        | Expression::Using { expr: inner, .. }
        | Expression::KeepIn { expr: inner, .. } => {
            collect_variable_names(inner, model, names);
        }
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => {
            collect_variable_names(condition, model, names);
            collect_variable_names(then_expr, model, names);
            collect_variable_names(else_expr, model, names);
        }
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => {
            collect_variable_names(numerator, model, names);
            collect_variable_names(denominator, model, names);
            if let Some(a) = alternate {
                collect_variable_names(a, model, names);
            }
        }
        Expression::Coalesce(exprs) => {
            for e in exprs {
                collect_variable_names(e, model, names);
            }
        }
        Expression::ScalarFunc { args, .. } | Expression::TextFunc { args, .. } => {
            for a in args {
                collect_variable_names(a, model, names);
            }
        }
        Expression::Block { bindings, result } => {
            for (_, e) in bindings {
                collect_variable_names(e, model, names);
            }
            collect_variable_names(result, model, names);
        }
        Expression::Query { aggregates, .. } => {
            for (agg_expr, _) in aggregates {
                collect_variable_names(agg_expr, model, names);
            }
        }
        Expression::Switch {
            expr: inner,
            cases,
            default,
        } => {
            collect_variable_names(inner, model, names);
            for (v, r) in cases {
                collect_variable_names(v, model, names);
                collect_variable_names(r, model, names);
            }
            if let Some(d) = default {
                collect_variable_names(d, model, names);
            }
        }
        Expression::Call { args, .. } => {
            for a in args {
                collect_variable_names(a, model, names);
            }
        }
        _ => {}
    }
}

/// Follow a variable's source chain and collect all referenced tables
/// (the base table + all filter tables along the chain).
fn resolve_variable_tables(var_name: &str, model: &DataModel, tables: &mut Vec<String>) {
    let mut current = var_name.to_string();
    loop {
        if let Ok(var) = model.table_variable(&current) {
            // Collect tables from the variable's filters.
            for f in var.filters() {
                tables.push(f.table.clone());
            }
            current = var.source().to_string();
        } else {
            // Reached a real table — add it.
            tables.push(current);
            break;
        }
    }
}

/// Collect all tables referenced by named context definitions in an expression.
///
/// When a measure uses a bare context name (e.g., `ctx_bikes`) in its Keep.variables,
/// the context definition's KEEP filters reference tables that need to be fetched.
/// This function walks the expression, finds named context references, and collects
/// all tables from their KEEP filter predicates (recursively following Inherit ops).
pub(super) fn collect_named_context_tables(expr: &Expression, model: &DataModel) -> Vec<String> {
    let mut context_names = Vec::new();
    collect_context_names_from_expr(expr, model, &mut context_names);

    let mut tables = Vec::new();
    for ctx_name in &context_names {
        collect_tables_from_context(ctx_name, model, &mut tables);
    }
    tables.sort();
    tables.dedup();
    tables
}

/// Recursively find bare names in Keep.variables that are named contexts (not table variables).
fn collect_context_names_from_expr(expr: &Expression, model: &DataModel, names: &mut Vec<String>) {
    match expr {
        Expression::Keep {
            expr: inner,
            variables,
            ..
        } => {
            for v in variables {
                if model.table_variable(v).is_err() && model.context(v).is_ok() {
                    names.push(v.clone());
                }
            }
            collect_context_names_from_expr(inner, model, names);
        }
        Expression::Aggregate { operand, .. } => {
            collect_context_names_from_expr(operand, model, names);
        }
        Expression::BinaryOp { left, right, .. }
        | Expression::Comparison { left, right, .. }
        | Expression::And(left, right)
        | Expression::Or(left, right)
        | Expression::Xor(left, right) => {
            collect_context_names_from_expr(left, model, names);
            collect_context_names_from_expr(right, model, names);
        }
        Expression::Not(inner) | Expression::IsBlank(inner) => {
            collect_context_names_from_expr(inner, model, names);
        }
        Expression::Clear { expr: inner, .. }
        | Expression::Reset { expr: inner }
        | Expression::ClearInner { expr: inner, .. }
        | Expression::ClearOuter { expr: inner, .. }
        | Expression::ResetInner { expr: inner }
        | Expression::ResetOuter { expr: inner }
        | Expression::Traverse { expr: inner, .. }
        | Expression::Using { expr: inner, .. }
        | Expression::KeepIn { expr: inner, .. } => {
            collect_context_names_from_expr(inner, model, names);
        }
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => {
            collect_context_names_from_expr(condition, model, names);
            collect_context_names_from_expr(then_expr, model, names);
            collect_context_names_from_expr(else_expr, model, names);
        }
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => {
            collect_context_names_from_expr(numerator, model, names);
            collect_context_names_from_expr(denominator, model, names);
            if let Some(a) = alternate {
                collect_context_names_from_expr(a, model, names);
            }
        }
        Expression::Coalesce(exprs) => {
            for e in exprs {
                collect_context_names_from_expr(e, model, names);
            }
        }
        Expression::ScalarFunc { args, .. } | Expression::TextFunc { args, .. } => {
            for a in args {
                collect_context_names_from_expr(a, model, names);
            }
        }
        Expression::Block { bindings, result } => {
            for (_, binding_expr) in bindings {
                collect_context_names_from_expr(binding_expr, model, names);
            }
            collect_context_names_from_expr(result, model, names);
        }
        Expression::Query { aggregates, .. } => {
            for (agg_expr, _) in aggregates {
                collect_context_names_from_expr(agg_expr, model, names);
            }
        }
        Expression::Switch {
            expr: inner,
            cases,
            default,
        } => {
            collect_context_names_from_expr(inner, model, names);
            for (v, r) in cases {
                collect_context_names_from_expr(v, model, names);
                collect_context_names_from_expr(r, model, names);
            }
            if let Some(d) = default {
                collect_context_names_from_expr(d, model, names);
            }
        }
        Expression::Call { args, .. } => {
            for a in args {
                collect_context_names_from_expr(a, model, names);
            }
        }
        _ => {}
    }
}

/// Collect tables from a named context's operations, recursively following Inherit.
fn collect_tables_from_context(ctx_name: &str, model: &DataModel, tables: &mut Vec<String>) {
    if let Ok(ctx) = model.context(ctx_name) {
        for op in ctx.operations() {
            match op {
                engine_core::model::context::ContextOp::Keep(filters) => {
                    for f in filters {
                        tables.push(f.table.clone());
                    }
                }
                engine_core::model::context::ContextOp::KeepIn(predicates) => {
                    for p in predicates {
                        tables.push(p.table.clone());
                    }
                }
                engine_core::model::context::ContextOp::Inherit(parent) => {
                    collect_tables_from_context(parent, model, tables);
                }
                _ => {}
            }
        }
    }
}

/// Collect all tables referenced by USERELATIONSHIP expressions.
///
/// When a measure uses `USERELATIONSHIP("rel_name")`, the relationship's
/// from_table and to_table must be fetched and registered in DataFusion so
/// the aliased JOIN can reference them.
pub(super) fn collect_userelationship_tables(expr: &Expression, model: &DataModel) -> Vec<String> {
    let mut rel_names = Vec::new();
    collect_userelationship_names(expr, &mut rel_names);

    let mut tables = Vec::new();
    for rel_name in &rel_names {
        if let Ok(rel) = model.relationship(rel_name) {
            tables.push(rel.from_table().to_string());
            tables.push(rel.to_table().to_string());
        }
    }
    tables.sort();
    tables.dedup();
    tables
}

/// Recursively collect all relationship names from UseRelationship expressions.
fn collect_userelationship_names(expr: &Expression, names: &mut Vec<String>) {
    match expr {
        Expression::UseRelationship {
            expr: inner,
            relationship_name,
        } => {
            names.push(relationship_name.clone());
            collect_userelationship_names(inner, names);
        }
        Expression::Aggregate { operand, .. } => {
            collect_userelationship_names(operand, names);
        }
        Expression::BinaryOp { left, right, .. }
        | Expression::Comparison { left, right, .. }
        | Expression::And(left, right)
        | Expression::Or(left, right)
        | Expression::Xor(left, right) => {
            collect_userelationship_names(left, names);
            collect_userelationship_names(right, names);
        }
        Expression::Not(inner) | Expression::IsBlank(inner) => {
            collect_userelationship_names(inner, names);
        }
        Expression::Keep { expr: inner, .. }
        | Expression::KeepIn { expr: inner, .. }
        | Expression::Clear { expr: inner, .. }
        | Expression::Reset { expr: inner }
        | Expression::ClearInner { expr: inner, .. }
        | Expression::ClearOuter { expr: inner, .. }
        | Expression::ResetInner { expr: inner }
        | Expression::ResetOuter { expr: inner }
        | Expression::Traverse { expr: inner, .. }
        | Expression::Using { expr: inner, .. } => {
            collect_userelationship_names(inner, names);
        }
        Expression::Block { bindings, result } => {
            for (_, binding_expr) in bindings {
                collect_userelationship_names(binding_expr, names);
            }
            collect_userelationship_names(result, names);
        }
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => {
            collect_userelationship_names(condition, names);
            collect_userelationship_names(then_expr, names);
            collect_userelationship_names(else_expr, names);
        }
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => {
            collect_userelationship_names(numerator, names);
            collect_userelationship_names(denominator, names);
            if let Some(a) = alternate {
                collect_userelationship_names(a, names);
            }
        }
        Expression::Coalesce(exprs) => {
            for e in exprs {
                collect_userelationship_names(e, names);
            }
        }
        Expression::ScalarFunc { args, .. } | Expression::TextFunc { args, .. } => {
            for a in args {
                collect_userelationship_names(a, names);
            }
        }
        Expression::Switch {
            expr: inner,
            cases,
            default,
        } => {
            collect_userelationship_names(inner, names);
            for (v, r) in cases {
                collect_userelationship_names(v, names);
                collect_userelationship_names(r, names);
            }
            if let Some(d) = default {
                collect_userelationship_names(d, names);
            }
        }
        Expression::Query { aggregates, .. } => {
            for (agg_expr, _) in aggregates {
                collect_userelationship_names(agg_expr, names);
            }
        }
        Expression::HasOneValue { column } => collect_userelationship_names(column, names),
        Expression::SelectedValue { column, alternate } => {
            collect_userelationship_names(column, names);
            if let Some(a) = alternate {
                collect_userelationship_names(a, names);
            }
        }
        Expression::FirstValue { column, order_by } => {
            collect_userelationship_names(column, names);
            collect_userelationship_names(order_by, names);
        }
        Expression::Call { args, .. } => {
            for a in args {
                collect_userelationship_names(a, names);
            }
        }
        _ => {}
    }
}

/// Collect QUERY binding names from Block expressions.
///
/// These are intermediate table names (e.g. "monthly", "by_year") that are
/// computed at runtime via `Expression::Query` bindings — they are NOT
/// registered data sources and must be excluded from source verification.
pub(super) fn collect_query_binding_names(expr: &Expression) -> Vec<String> {
    let mut names = Vec::new();
    collect_query_names_recursive(expr, &mut names);
    names
}

fn collect_query_names_recursive(expr: &Expression, names: &mut Vec<String>) {
    match expr {
        Expression::Block { bindings, result } => {
            for (name, binding_expr) in bindings {
                if matches!(binding_expr, Expression::Query { .. }) {
                    names.push(name.to_lowercase());
                }
                collect_query_names_recursive(binding_expr, names);
            }
            collect_query_names_recursive(result, names);
        }
        Expression::Aggregate { operand, .. } => {
            collect_query_names_recursive(operand, names);
        }
        Expression::BinaryOp { left, right, .. }
        | Expression::Comparison { left, right, .. }
        | Expression::And(left, right)
        | Expression::Or(left, right)
        | Expression::Xor(left, right) => {
            collect_query_names_recursive(left, names);
            collect_query_names_recursive(right, names);
        }
        Expression::Not(inner) | Expression::IsBlank(inner) => {
            collect_query_names_recursive(inner, names);
        }
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => {
            collect_query_names_recursive(condition, names);
            collect_query_names_recursive(then_expr, names);
            collect_query_names_recursive(else_expr, names);
        }
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => {
            collect_query_names_recursive(numerator, names);
            collect_query_names_recursive(denominator, names);
            if let Some(a) = alternate {
                collect_query_names_recursive(a, names);
            }
        }
        Expression::ScalarFunc { args, .. } | Expression::TextFunc { args, .. } => {
            for a in args {
                collect_query_names_recursive(a, names);
            }
        }
        Expression::Coalesce(exprs) => {
            for e in exprs {
                collect_query_names_recursive(e, names);
            }
        }
        Expression::Keep { expr: inner, .. }
        | Expression::Clear { expr: inner, .. }
        | Expression::Reset { expr: inner }
        | Expression::ClearInner { expr: inner, .. }
        | Expression::ClearOuter { expr: inner, .. }
        | Expression::ResetInner { expr: inner }
        | Expression::ResetOuter { expr: inner }
        | Expression::Traverse { expr: inner, .. }
        | Expression::Using { expr: inner, .. }
        | Expression::KeepIn { expr: inner, .. } => {
            collect_query_names_recursive(inner, names);
        }
        Expression::Call { args, .. } => {
            for a in args {
                collect_query_names_recursive(a, names);
            }
        }
        _ => {}
    }
}
