//! Expression dependency extraction for lineage / impact analysis.
//!
//! Walks an [`Expression`] AST and collects everything it references in one
//! pass: measures, qualified `Table[Column]` references, `USING()` contexts,
//! table variables named in `KEEP(...)`, and global variables. Hosts (notably
//! Calcula Studio's Lineage panel) build their dependency graphs from this
//! plain data.
//!
//! Unlike the single-purpose walkers in [`walkers`](super::walkers)
//! (`measure_references`, `qualified_column_references`), this extraction is
//! **name-aware**: because a bare `ColumnRef("X")` is ambiguous in authored
//! formulas — it may be a column, a measure reference, or a global variable —
//! the caller supplies the known measure and global names and the walker
//! classifies each reference accordingly. `VAR` binding names in a `Block`
//! shadow all of these and are never reported.

use std::collections::HashSet;

use super::*;

/// All dependencies referenced by a single expression.
///
/// Each list is deduplicated, in first-occurrence (traversal) order.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExpressionDependencies {
    /// Measure names referenced — via [`Expression::MeasureRef`] or a bare
    /// [`Expression::ColumnRef`] matching a known measure name.
    pub measures: Vec<String>,
    /// Qualified column references as `(table, column)` pairs. Bare column
    /// refs without a table qualifier are not reported (ambiguous), and a
    /// qualifier that is a `VAR` binding or a global's output table is
    /// classified as that instead.
    pub columns: Vec<(String, String)>,
    /// Context names referenced via `USING(expr, context)`.
    pub contexts: Vec<String>,
    /// Table variable names referenced via `KEEP(...)` variables or
    /// IN-membership predicates (including the legacy `KeepIn` form).
    pub table_variables: Vec<String>,
    /// Global variable names referenced — a bare `ColumnRef` matching a known
    /// global, or a `QualifiedColumnRef` whose qualifier matches a global
    /// (a table/QUERY global's output table is named after the variable).
    pub globals: Vec<String>,
}

/// Walk an expression AST and collect every dependency it references.
///
/// `measure_names` and `global_names` disambiguate bare references: a
/// `ColumnRef("X")` is reported as a measure if `"X"` is in `measure_names`,
/// as a global if in `global_names`, and dropped otherwise (an unqualified
/// column is not attributable to a table). A `QualifiedColumnRef` whose
/// qualifier is in `global_names` is reported as a global reference (the
/// qualifier names a QUERY global's output table), not as a column.
pub fn extract_dependencies(
    expr: &Expression,
    measure_names: &HashSet<String>,
    global_names: &HashSet<String>,
) -> ExpressionDependencies {
    let mut deps = ExpressionDependencies::default();
    let block_vars = HashSet::new();
    walk(expr, measure_names, global_names, &block_vars, &mut deps);
    dedup_in_place(&mut deps.measures);
    dedup_pairs_in_place(&mut deps.columns);
    dedup_in_place(&mut deps.contexts);
    dedup_in_place(&mut deps.table_variables);
    dedup_in_place(&mut deps.globals);
    deps
}

/// Deduplicate a name list preserving first-occurrence order.
fn dedup_in_place(names: &mut Vec<String>) {
    let mut seen = HashSet::new();
    names.retain(|n| seen.insert(n.clone()));
}

/// Deduplicate a `(table, column)` list preserving first-occurrence order.
fn dedup_pairs_in_place(pairs: &mut Vec<(String, String)>) {
    let mut seen = HashSet::new();
    pairs.retain(|p| seen.insert(p.clone()));
}

/// Recursive worker: `block_vars` tracks locally-scoped `VAR` bindings, which
/// shadow measures/globals/columns and are never reported as dependencies.
fn walk(
    expr: &Expression,
    measure_names: &HashSet<String>,
    global_names: &HashSet<String>,
    block_vars: &HashSet<String>,
    deps: &mut ExpressionDependencies,
) {
    match expr {
        Expression::ColumnRef(name) => {
            if block_vars.contains(name) {
                // Local VAR binding, not a real reference.
            } else if measure_names.contains(name) {
                deps.measures.push(name.clone());
            } else if global_names.contains(name) {
                deps.globals.push(name.clone());
            }
            // Bare column refs without a table qualifier aren't useful for
            // dependency tracking (ambiguous).
        }
        Expression::MeasureRef(name) => {
            deps.measures.push(name.clone());
        }
        Expression::QualifiedColumnRef {
            table_or_var,
            column,
        } => {
            if global_names.contains(table_or_var) {
                // Reference to a global variable's QUERY output table.
                deps.globals.push(table_or_var.clone());
            } else if !block_vars.contains(table_or_var) {
                deps.columns.push((table_or_var.clone(), column.clone()));
            }
        }
        Expression::Using {
            expr: inner,
            context_name,
        } => {
            deps.contexts.push(context_name.clone());
            walk(inner, measure_names, global_names, block_vars, deps);
        }
        Expression::Keep {
            expr: inner,
            filters: _,
            variables,
            conditions,
            in_predicates,
        } => {
            for var_name in variables {
                deps.table_variables.push(var_name.clone());
            }
            for pred in in_predicates {
                deps.table_variables.push(pred.var_name.clone());
            }
            walk(inner, measure_names, global_names, block_vars, deps);
            for cond in conditions {
                walk(cond, measure_names, global_names, block_vars, deps);
            }
        }
        Expression::Block { bindings, result } => {
            // Process bindings — each binding's expression can reference
            // earlier bindings or external refs. The binding *names* are
            // local scope.
            let mut local_vars = block_vars.clone();
            for (name, binding_expr) in bindings {
                walk(binding_expr, measure_names, global_names, &local_vars, deps);
                local_vars.insert(name.clone());
            }
            walk(result, measure_names, global_names, &local_vars, deps);
        }
        // Recurse into sub-expressions for all other variants.
        Expression::BinaryOp { left, right, .. } => {
            walk(left, measure_names, global_names, block_vars, deps);
            walk(right, measure_names, global_names, block_vars, deps);
        }
        Expression::Aggregate { operand, .. } => {
            walk(operand, measure_names, global_names, block_vars, deps);
        }
        Expression::Clear { expr: inner, .. }
        | Expression::Reset { expr: inner }
        | Expression::ClearInner { expr: inner, .. }
        | Expression::ClearOuter { expr: inner, .. }
        | Expression::ResetInner { expr: inner }
        | Expression::ResetOuter { expr: inner }
        | Expression::Not(inner)
        | Expression::IsBlank(inner)
        | Expression::HasOneValue { column: inner } => {
            walk(inner, measure_names, global_names, block_vars, deps);
        }
        Expression::Traverse { expr: inner, .. } => {
            walk(inner, measure_names, global_names, block_vars, deps);
        }
        Expression::UseRelationship { expr: inner, .. } => {
            walk(inner, measure_names, global_names, block_vars, deps);
        }
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => {
            walk(condition, measure_names, global_names, block_vars, deps);
            walk(then_expr, measure_names, global_names, block_vars, deps);
            walk(else_expr, measure_names, global_names, block_vars, deps);
        }
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => {
            walk(numerator, measure_names, global_names, block_vars, deps);
            walk(denominator, measure_names, global_names, block_vars, deps);
            if let Some(a) = alternate {
                walk(a, measure_names, global_names, block_vars, deps);
            }
        }
        Expression::Comparison { left, right, .. } => {
            walk(left, measure_names, global_names, block_vars, deps);
            walk(right, measure_names, global_names, block_vars, deps);
        }
        Expression::And(left, right)
        | Expression::Or(left, right)
        | Expression::Xor(left, right) => {
            walk(left, measure_names, global_names, block_vars, deps);
            walk(right, measure_names, global_names, block_vars, deps);
        }
        Expression::Switch {
            expr: inner,
            cases,
            default,
        } => {
            walk(inner, measure_names, global_names, block_vars, deps);
            for (val, res) in cases {
                walk(val, measure_names, global_names, block_vars, deps);
                walk(res, measure_names, global_names, block_vars, deps);
            }
            if let Some(d) = default {
                walk(d, measure_names, global_names, block_vars, deps);
            }
        }
        Expression::Coalesce(exprs) => {
            for e in exprs {
                walk(e, measure_names, global_names, block_vars, deps);
            }
        }
        Expression::ScalarFunc { args, .. } | Expression::TextFunc { args, .. } => {
            for a in args {
                walk(a, measure_names, global_names, block_vars, deps);
            }
        }
        Expression::SelectedValue { column, alternate } => {
            walk(column, measure_names, global_names, block_vars, deps);
            if let Some(a) = alternate {
                walk(a, measure_names, global_names, block_vars, deps);
            }
        }
        Expression::FirstValue { column, order_by } => {
            walk(column, measure_names, global_names, block_vars, deps);
            walk(order_by, measure_names, global_names, block_vars, deps);
        }
        Expression::Query {
            aggregates,
            group_by: _,
        } => {
            for (agg_expr, _alias) in aggregates {
                walk(agg_expr, measure_names, global_names, block_vars, deps);
            }
            // group_by are (table, column) pairs — these are column refs
            // but from the expression's own table context, not external deps.
        }
        Expression::Window { inner, .. }
        | Expression::Offset { inner, .. }
        | Expression::Index { inner, .. } => {
            walk(inner, measure_names, global_names, block_vars, deps);
        }
        Expression::InList {
            expr: inner,
            values,
        } => {
            walk(inner, measure_names, global_names, block_vars, deps);
            for v in values {
                walk(v, measure_names, global_names, block_vars, deps);
            }
        }
        Expression::KeepIn {
            expr: inner,
            predicates,
        } => {
            for pred in predicates {
                deps.table_variables.push(pred.var_name.clone());
            }
            walk(inner, measure_names, global_names, block_vars, deps);
        }
        Expression::DateTimeFunc { args, .. } => {
            for a in args {
                walk(a, measure_names, global_names, block_vars, deps);
            }
        }
        Expression::IfError {
            expr: inner,
            alternate,
        } => {
            walk(inner, measure_names, global_names, block_vars, deps);
            walk(alternate, measure_names, global_names, block_vars, deps);
        }
        Expression::ClearExcept { expr: inner, .. } => {
            walk(inner, measure_names, global_names, block_vars, deps);
        }
        Expression::Iterate { expression, .. } => {
            walk(expression, measure_names, global_names, block_vars, deps);
        }
        Expression::Percentile {
            operand,
            percentile,
        } => {
            walk(operand, measure_names, global_names, block_vars, deps);
            walk(percentile, measure_names, global_names, block_vars, deps);
        }
        Expression::Greatest(args) | Expression::Least(args) => {
            for a in args {
                walk(a, measure_names, global_names, block_vars, deps);
            }
        }
        Expression::NullIf { expr: inner, value } => {
            walk(inner, measure_names, global_names, block_vars, deps);
            walk(value, measure_names, global_names, block_vars, deps);
        }
        Expression::CountIf { condition } => {
            walk(condition, measure_names, global_names, block_vars, deps);
        }
        Expression::ListAgg { column, delimiter } => {
            walk(column, measure_names, global_names, block_vars, deps);
            walk(delimiter, measure_names, global_names, block_vars, deps);
        }
        Expression::MaxBy { value, sort_by } | Expression::MinBy { value, sort_by } => {
            walk(value, measure_names, global_names, block_vars, deps);
            walk(sort_by, measure_names, global_names, block_vars, deps);
        }
        // Time-intelligence wrappers carry a single inner measure expression.
        Expression::ToDate { expr: inner, .. }
        | Expression::PeriodShift { expr: inner, .. }
        | Expression::DatesInPeriod { expr: inner, .. }
        | Expression::SemiAdditiveBalance { expr: inner, .. } => {
            walk(inner, measure_names, global_names, block_vars, deps);
        }
        // Host/script UDF call — recurse into argument expressions.
        Expression::Call { args, .. } => {
            for a in args {
                walk(a, measure_names, global_names, block_vars, deps);
            }
        }
        Expression::RankWindow { .. } => {
            // RankWindow has no inner expression sub-trees to recurse into,
            // only (table, column) pairs for order_by/partition_by.
        }
        // Leaves with no sub-expressions.
        Expression::IsInScope { .. }
        | Expression::LiteralFloat(_)
        | Expression::LiteralInt(_)
        | Expression::LiteralString(_)
        | Expression::LiteralBool(_)
        | Expression::LiteralDate(_)
        | Expression::Blank
        | Expression::SelectedMeasure
        | Expression::TableRef(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(items: &[&str]) -> HashSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn measure_ref_and_bare_measure_name_both_reported() {
        // [Total] + Margin — Margin arrives as a bare ColumnRef that matches
        // a known measure name (the ambiguity the name-aware walker resolves).
        let expr = Expression::MeasureRef("Total".into()).add(col("Margin"));
        let deps = extract_dependencies(&expr, &names(&["Total", "Margin"]), &HashSet::new());
        assert_eq!(deps.measures, vec!["Total".to_string(), "Margin".to_string()]);
        assert!(deps.columns.is_empty());
    }

    #[test]
    fn qualified_columns_collected_and_deduped() {
        let expr = agg(AggregateOp::Sum, qualified_col("Sales", "amount"))
            .add(agg(AggregateOp::Sum, qualified_col("Sales", "amount")))
            .add(qualified_col("Products", "price"));
        let deps = extract_dependencies(&expr, &HashSet::new(), &HashSet::new());
        assert_eq!(
            deps.columns,
            vec![
                ("Sales".to_string(), "amount".to_string()),
                ("Products".to_string(), "price".to_string()),
            ]
        );
    }

    #[test]
    fn bare_column_refs_dropped_as_ambiguous() {
        let expr = agg(AggregateOp::Sum, col("amount"));
        let deps = extract_dependencies(&expr, &HashSet::new(), &HashSet::new());
        assert!(deps.columns.is_empty());
        assert!(deps.measures.is_empty());
    }

    #[test]
    fn using_reports_context_name() {
        let expr = using(agg(AggregateOp::Sum, qualified_col("Sales", "amount")), "FY24");
        let deps = extract_dependencies(&expr, &HashSet::new(), &HashSet::new());
        assert_eq!(deps.contexts, vec!["FY24".to_string()]);
        assert_eq!(deps.columns, vec![("Sales".to_string(), "amount".to_string())]);
    }

    #[test]
    fn keep_reports_table_variables_from_vars_and_in_predicates() {
        let with_vars = keep_vars(
            agg(AggregateOp::Sum, qualified_col("Sales", "amount")),
            vec!["top_products".to_string()],
        );
        let deps = extract_dependencies(&with_vars, &HashSet::new(), &HashSet::new());
        assert_eq!(deps.table_variables, vec!["top_products".to_string()]);

        let with_in = keep_in(
            agg(AggregateOp::Sum, qualified_col("Sales", "amount")),
            vec![InPredicate::new("Sales", "product_id", "top_products", "id")],
        );
        let deps = extract_dependencies(&with_in, &HashSet::new(), &HashSet::new());
        assert_eq!(deps.table_variables, vec!["top_products".to_string()]);
    }

    #[test]
    fn globals_matched_bare_and_as_query_output_table() {
        // Bare ColumnRef matching a global, and a QualifiedColumnRef whose
        // qualifier is a QUERY global's output table.
        let expr = col("target_rate").add(qualified_col("monthly", "revenue"));
        let deps = extract_dependencies(
            &expr,
            &HashSet::new(),
            &names(&["target_rate", "monthly"]),
        );
        assert_eq!(
            deps.globals,
            vec!["target_rate".to_string(), "monthly".to_string()]
        );
        assert!(deps.columns.is_empty());
    }

    #[test]
    fn block_var_bindings_shadow_names() {
        // VAR x = SUM(Sales[amount]) RETURN x / [Total] — "x" is a local
        // binding, never a dependency, even if a measure "x" exists.
        let expr = block(
            vec![(
                "x".to_string(),
                agg(AggregateOp::Sum, qualified_col("Sales", "amount")),
            )],
            Expression::ColumnRef("x".to_string())
                .divide(Expression::MeasureRef("Total".into())),
        );
        let deps = extract_dependencies(&expr, &names(&["x", "Total"]), &HashSet::new());
        assert_eq!(deps.measures, vec!["Total".to_string()]);
        assert_eq!(deps.columns, vec![("Sales".to_string(), "amount".to_string())]);
    }

    #[test]
    fn measure_ref_buried_in_variadic_node_found() {
        let expr = Expression::Greatest(vec![
            lit_int(0),
            Expression::MeasureRef("Buried".into()),
        ]);
        let deps = extract_dependencies(&expr, &HashSet::new(), &HashSet::new());
        assert_eq!(deps.measures, vec!["Buried".to_string()]);
    }
}
