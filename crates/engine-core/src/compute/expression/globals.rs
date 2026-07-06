//! Global variable expansion (scalar inlining and QUERY block merging).

use super::*;

pub fn expand_global_variables(
    expr: &Expression,
    model: &crate::model::schema::DataModel,
) -> Expression {
    // First pass: collect all QUERY global names referenced via QualifiedColumnRef.
    let mut query_globals = std::collections::HashSet::new();
    collect_query_global_refs(expr, model, &mut query_globals);

    // Expand scalar globals recursively.
    let expanded = expand_scalar_globals(expr, model);

    // If any QUERY globals were referenced, wrap in a Block with those bindings.
    if query_globals.is_empty() {
        expanded
    } else {
        // If the expression is already a Block, merge QUERY bindings into it.
        match expanded {
            Expression::Block {
                bindings,
                query_scoped_bindings,
                result,
            } => {
                let mut all_bindings = Vec::new();
                for name in &query_globals {
                    // Only add if not already bound in the existing block.
                    if !bindings.iter().any(|(n, _)| n == name) {
                        let gv = model
                            .global_variable(name)
                            .expect("global variable must exist — was found in collect pass");
                        all_bindings.push((name.clone(), gv.expression().clone()));
                    }
                }
                all_bindings.extend(bindings);
                Expression::Block {
                    bindings: all_bindings,
                    query_scoped_bindings,
                    result,
                }
            }
            other => {
                let bindings: Vec<(String, Expression)> = query_globals
                    .iter()
                    .map(|name| {
                        let gv = model
                            .global_variable(name)
                            .expect("global variable must exist — was found in collect pass");
                        (name.clone(), gv.expression().clone())
                    })
                    .collect();
                Expression::Block {
                    bindings,
                    query_scoped_bindings: Vec::new(),
                    result: Box::new(other),
                }
            }
        }
    }
}

/// Recursively collect names of QUERY global variables referenced via QualifiedColumnRef.
fn collect_query_global_refs(
    expr: &Expression,
    model: &crate::model::schema::DataModel,
    found: &mut std::collections::HashSet<String>,
) {
    match expr {
        Expression::QualifiedColumnRef { table_or_var, .. } => {
            if let Ok(gv) = model.global_variable(table_or_var) {
                if gv.is_query() {
                    found.insert(table_or_var.clone());
                }
            }
        }
        Expression::ColumnRef(_)
        | Expression::LiteralFloat(_)
        | Expression::LiteralInt(_)
        | Expression::LiteralDate(_)
        | Expression::LiteralString(_)
        | Expression::LiteralBool(_)
        | Expression::Blank
        | Expression::TableRef(_)
        | Expression::MeasureRef(_)
        | Expression::SelectedMeasure => {}
        Expression::BinaryOp { left, right, .. }
        | Expression::Comparison { left, right, .. }
        | Expression::And(left, right)
        | Expression::Or(left, right)
        | Expression::Xor(left, right) => {
            collect_query_global_refs(left, model, found);
            collect_query_global_refs(right, model, found);
        }
        Expression::Aggregate { operand, .. } => {
            collect_query_global_refs(operand, model, found);
        }
        Expression::Not(inner)
        | Expression::IsBlank(inner)
        | Expression::HasOneValue { column: inner }
        | Expression::Reset { expr: inner }
        | Expression::ResetInner { expr: inner }
        | Expression::ResetOuter { expr: inner } => {
            collect_query_global_refs(inner, model, found);
        }
        Expression::Keep { expr, .. }
        | Expression::Clear { expr, .. }
        | Expression::Traverse { expr, .. }
        | Expression::Using { expr, .. }
        | Expression::UseRelationship { expr, .. }
        | Expression::ClearInner { expr, .. }
        | Expression::ClearOuter { expr, .. }
        | Expression::KeepIn { expr, .. } => {
            collect_query_global_refs(expr, model, found);
        }
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => {
            collect_query_global_refs(condition, model, found);
            collect_query_global_refs(then_expr, model, found);
            collect_query_global_refs(else_expr, model, found);
        }
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => {
            collect_query_global_refs(numerator, model, found);
            collect_query_global_refs(denominator, model, found);
            if let Some(alt) = alternate {
                collect_query_global_refs(alt, model, found);
            }
        }
        Expression::Switch {
            expr,
            cases,
            default,
        } => {
            collect_query_global_refs(expr, model, found);
            for (val, result) in cases {
                collect_query_global_refs(val, model, found);
                collect_query_global_refs(result, model, found);
            }
            if let Some(def) = default {
                collect_query_global_refs(def, model, found);
            }
        }
        Expression::Coalesce(exprs) => {
            for e in exprs {
                collect_query_global_refs(e, model, found);
            }
        }
        Expression::ScalarFunc { args, .. }
        | Expression::TextFunc { args, .. }
        | Expression::DateTimeFunc { args, .. } => {
            for arg in args {
                collect_query_global_refs(arg, model, found);
            }
        }
        Expression::IfError { expr, alternate } => {
            collect_query_global_refs(expr, model, found);
            collect_query_global_refs(alternate, model, found);
        }
        Expression::IsInScope { .. } => {}
        Expression::ClearExcept { expr, .. }
        | Expression::Iterate {
            expression: expr, ..
        } => {
            collect_query_global_refs(expr, model, found);
        }
        Expression::Percentile {
            operand,
            percentile,
        } => {
            collect_query_global_refs(operand, model, found);
            collect_query_global_refs(percentile, model, found);
        }
        Expression::Block {
            bindings,
            query_scoped_bindings,
            result,
        } => {
            for (_, binding_expr) in bindings.iter().chain(query_scoped_bindings.iter()) {
                collect_query_global_refs(binding_expr, model, found);
            }
            collect_query_global_refs(result, model, found);
        }
        Expression::Query { aggregates, .. } => {
            for (agg_expr, _) in aggregates {
                collect_query_global_refs(agg_expr, model, found);
            }
        }
        Expression::SelectedValue { column, alternate } => {
            collect_query_global_refs(column, model, found);
            if let Some(alt) = alternate {
                collect_query_global_refs(alt, model, found);
            }
        }
        Expression::FirstValue { column, order_by } => {
            collect_query_global_refs(column, model, found);
            collect_query_global_refs(order_by, model, found);
        }
        Expression::Window { inner, .. }
        | Expression::Offset { inner, .. }
        | Expression::Index { inner, .. } => {
            collect_query_global_refs(inner, model, found);
        }
        Expression::InList { expr, values } => {
            collect_query_global_refs(expr, model, found);
            for v in values {
                collect_query_global_refs(v, model, found);
            }
        }
        Expression::Greatest(args) | Expression::Least(args) => {
            for a in args {
                collect_query_global_refs(a, model, found);
            }
        }
        Expression::NullIf { expr, value } => {
            collect_query_global_refs(expr, model, found);
            collect_query_global_refs(value, model, found);
        }
        Expression::CountIf { condition } => {
            collect_query_global_refs(condition, model, found);
        }
        Expression::ListAgg { column, delimiter } => {
            collect_query_global_refs(column, model, found);
            collect_query_global_refs(delimiter, model, found);
        }
        Expression::MaxBy { value, sort_by } | Expression::MinBy { value, sort_by } => {
            collect_query_global_refs(value, model, found);
            collect_query_global_refs(sort_by, model, found);
        }
        Expression::RankWindow { .. } => {}
        Expression::ToDate { expr, .. }
        | Expression::PeriodShift { expr, .. }
        | Expression::DatesInPeriod { expr, .. }
        | Expression::SemiAdditiveBalance { expr, .. } => {
            collect_query_global_refs(expr, model, found);
        }
        Expression::Call { args, .. } => {
            for arg in args {
                collect_query_global_refs(arg, model, found);
            }
        }
    }
}

/// Recursively replace scalar global ColumnRef(name) with the global's expression.
fn expand_scalar_globals(expr: &Expression, model: &crate::model::schema::DataModel) -> Expression {
    match expr {
        Expression::ColumnRef(name) => {
            if let Ok(gv) = model.global_variable(name) {
                if !gv.is_query() {
                    return gv.expression().clone();
                }
            }
            expr.clone()
        }
        Expression::BinaryOp { left, op, right } => Expression::BinaryOp {
            left: Box::new(expand_scalar_globals(left, model)),
            op: *op,
            right: Box::new(expand_scalar_globals(right, model)),
        },
        Expression::Aggregate { operation, operand } => Expression::Aggregate {
            operation: *operation,
            operand: Box::new(expand_scalar_globals(operand, model)),
        },
        Expression::Keep {
            expr: inner,
            filters,
            variables,
            conditions,
            in_predicates,
        } => Expression::Keep {
            expr: Box::new(expand_scalar_globals(inner, model)),
            filters: filters.clone(),
            variables: variables.clone(),
            conditions: conditions
                .iter()
                .map(|c| expand_scalar_globals(c, model))
                .collect(),
            in_predicates: in_predicates.clone(),
        },
        Expression::Clear {
            expr: inner,
            targets,
        } => Expression::Clear {
            expr: Box::new(expand_scalar_globals(inner, model)),
            targets: targets.clone(),
        },
        Expression::Reset { expr: inner } => Expression::Reset {
            expr: Box::new(expand_scalar_globals(inner, model)),
        },
        Expression::Traverse { expr: inner, path } => Expression::Traverse {
            expr: Box::new(expand_scalar_globals(inner, model)),
            path: path.clone(),
        },
        Expression::Using {
            expr: inner,
            context_name,
        } => Expression::Using {
            expr: Box::new(expand_scalar_globals(inner, model)),
            context_name: context_name.clone(),
        },
        Expression::UseRelationship {
            expr: inner,
            relationship_name,
        } => Expression::UseRelationship {
            expr: Box::new(expand_scalar_globals(inner, model)),
            relationship_name: relationship_name.clone(),
        },
        Expression::ClearInner {
            expr: inner,
            targets,
        } => Expression::ClearInner {
            expr: Box::new(expand_scalar_globals(inner, model)),
            targets: targets.clone(),
        },
        Expression::ClearOuter {
            expr: inner,
            targets,
        } => Expression::ClearOuter {
            expr: Box::new(expand_scalar_globals(inner, model)),
            targets: targets.clone(),
        },
        Expression::ResetInner { expr: inner } => Expression::ResetInner {
            expr: Box::new(expand_scalar_globals(inner, model)),
        },
        Expression::ResetOuter { expr: inner } => Expression::ResetOuter {
            expr: Box::new(expand_scalar_globals(inner, model)),
        },
        Expression::KeepIn {
            expr: inner,
            predicates,
        } => Expression::KeepIn {
            expr: Box::new(expand_scalar_globals(inner, model)),
            predicates: predicates.clone(),
        },
        Expression::Block {
            bindings,
            query_scoped_bindings,
            result,
        } => {
            let expanded_bindings = bindings
                .iter()
                .map(|(name, binding_expr)| {
                    (name.clone(), expand_scalar_globals(binding_expr, model))
                })
                .collect();
            let expanded_query_scoped = query_scoped_bindings
                .iter()
                .map(|(name, binding_expr)| {
                    (name.clone(), expand_scalar_globals(binding_expr, model))
                })
                .collect();
            Expression::Block {
                bindings: expanded_bindings,
                query_scoped_bindings: expanded_query_scoped,
                result: Box::new(expand_scalar_globals(result, model)),
            }
        }
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => Expression::If {
            condition: Box::new(expand_scalar_globals(condition, model)),
            then_expr: Box::new(expand_scalar_globals(then_expr, model)),
            else_expr: Box::new(expand_scalar_globals(else_expr, model)),
        },
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => Expression::SafeDivide {
            numerator: Box::new(expand_scalar_globals(numerator, model)),
            denominator: Box::new(expand_scalar_globals(denominator, model)),
            alternate: alternate
                .as_ref()
                .map(|a| Box::new(expand_scalar_globals(a, model))),
        },
        Expression::Comparison { left, op, right } => Expression::Comparison {
            left: Box::new(expand_scalar_globals(left, model)),
            op: *op,
            right: Box::new(expand_scalar_globals(right, model)),
        },
        Expression::And(left, right) => Expression::And(
            Box::new(expand_scalar_globals(left, model)),
            Box::new(expand_scalar_globals(right, model)),
        ),
        Expression::Or(left, right) => Expression::Or(
            Box::new(expand_scalar_globals(left, model)),
            Box::new(expand_scalar_globals(right, model)),
        ),
        Expression::Not(inner) => Expression::Not(Box::new(expand_scalar_globals(inner, model))),
        Expression::Xor(left, right) => Expression::Xor(
            Box::new(expand_scalar_globals(left, model)),
            Box::new(expand_scalar_globals(right, model)),
        ),
        Expression::IsBlank(inner) => {
            Expression::IsBlank(Box::new(expand_scalar_globals(inner, model)))
        }
        Expression::Switch {
            expr: inner,
            cases,
            default,
        } => Expression::Switch {
            expr: Box::new(expand_scalar_globals(inner, model)),
            cases: cases
                .iter()
                .map(|(v, r)| {
                    (
                        expand_scalar_globals(v, model),
                        expand_scalar_globals(r, model),
                    )
                })
                .collect(),
            default: default
                .as_ref()
                .map(|d| Box::new(expand_scalar_globals(d, model))),
        },
        Expression::Coalesce(exprs) => Expression::Coalesce(
            exprs
                .iter()
                .map(|e| expand_scalar_globals(e, model))
                .collect(),
        ),
        Expression::ScalarFunc { function, args } => Expression::ScalarFunc {
            function: *function,
            args: args
                .iter()
                .map(|a| expand_scalar_globals(a, model))
                .collect(),
        },
        Expression::TextFunc { function, args } => Expression::TextFunc {
            function: *function,
            args: args
                .iter()
                .map(|a| expand_scalar_globals(a, model))
                .collect(),
        },
        Expression::DateTimeFunc { function, args } => Expression::DateTimeFunc {
            function: *function,
            args: args
                .iter()
                .map(|a| expand_scalar_globals(a, model))
                .collect(),
        },
        Expression::IfError { expr, alternate } => Expression::IfError {
            expr: Box::new(expand_scalar_globals(expr, model)),
            alternate: Box::new(expand_scalar_globals(alternate, model)),
        },
        Expression::IsInScope { table, column } => Expression::IsInScope {
            table: table.clone(),
            column: column.clone(),
        },
        Expression::ClearExcept {
            expr,
            table,
            except_columns,
        } => Expression::ClearExcept {
            expr: Box::new(expand_scalar_globals(expr, model)),
            table: table.clone(),
            except_columns: except_columns.clone(),
        },
        Expression::Iterate { table, expression } => Expression::Iterate {
            table: table.clone(),
            expression: Box::new(expand_scalar_globals(expression, model)),
        },
        Expression::Percentile {
            operand,
            percentile,
        } => Expression::Percentile {
            operand: Box::new(expand_scalar_globals(operand, model)),
            percentile: Box::new(expand_scalar_globals(percentile, model)),
        },
        Expression::HasOneValue { column } => Expression::HasOneValue {
            column: Box::new(expand_scalar_globals(column, model)),
        },
        Expression::SelectedValue { column, alternate } => Expression::SelectedValue {
            column: Box::new(expand_scalar_globals(column, model)),
            alternate: alternate
                .as_ref()
                .map(|a| Box::new(expand_scalar_globals(a, model))),
        },
        Expression::FirstValue { column, order_by } => Expression::FirstValue {
            column: Box::new(expand_scalar_globals(column, model)),
            order_by: Box::new(expand_scalar_globals(order_by, model)),
        },
        Expression::Window {
            inner,
            function,
            order_by,
            partition_by,
            frame,
        } => Expression::Window {
            inner: Box::new(expand_scalar_globals(inner, model)),
            function: *function,
            order_by: order_by.clone(),
            partition_by: partition_by.clone(),
            frame: frame.clone(),
        },
        Expression::Offset {
            inner,
            delta,
            order_by,
            partition_by,
        } => Expression::Offset {
            inner: Box::new(expand_scalar_globals(inner, model)),
            delta: *delta,
            order_by: order_by.clone(),
            partition_by: partition_by.clone(),
        },
        Expression::Index {
            inner,
            position,
            order_by,
            partition_by,
        } => Expression::Index {
            inner: Box::new(expand_scalar_globals(inner, model)),
            position: *position,
            order_by: order_by.clone(),
            partition_by: partition_by.clone(),
        },
        Expression::ToDate {
            expr: inner,
            granularity,
        } => Expression::ToDate {
            expr: Box::new(expand_scalar_globals(inner, model)),
            granularity: *granularity,
        },
        Expression::PeriodShift {
            expr: inner,
            offset,
            granularity,
        } => Expression::PeriodShift {
            expr: Box::new(expand_scalar_globals(inner, model)),
            offset: *offset,
            granularity: *granularity,
        },
        Expression::DatesInPeriod {
            expr: inner,
            intervals,
            granularity,
        } => Expression::DatesInPeriod {
            expr: Box::new(expand_scalar_globals(inner, model)),
            intervals: *intervals,
            granularity: *granularity,
        },
        Expression::SemiAdditiveBalance {
            expr: inner,
            opening,
        } => Expression::SemiAdditiveBalance {
            expr: Box::new(expand_scalar_globals(inner, model)),
            opening: *opening,
        },
        Expression::InList { expr, values } => Expression::InList {
            expr: Box::new(expand_scalar_globals(expr, model)),
            values: values
                .iter()
                .map(|v| expand_scalar_globals(v, model))
                .collect(),
        },
        Expression::Greatest(args) => Expression::Greatest(
            args.iter()
                .map(|a| expand_scalar_globals(a, model))
                .collect(),
        ),
        Expression::Least(args) => Expression::Least(
            args.iter()
                .map(|a| expand_scalar_globals(a, model))
                .collect(),
        ),
        Expression::NullIf { expr, value } => Expression::NullIf {
            expr: Box::new(expand_scalar_globals(expr, model)),
            value: Box::new(expand_scalar_globals(value, model)),
        },
        Expression::CountIf { condition } => Expression::CountIf {
            condition: Box::new(expand_scalar_globals(condition, model)),
        },
        Expression::ListAgg { column, delimiter } => Expression::ListAgg {
            column: Box::new(expand_scalar_globals(column, model)),
            delimiter: Box::new(expand_scalar_globals(delimiter, model)),
        },
        Expression::MaxBy { value, sort_by } => Expression::MaxBy {
            value: Box::new(expand_scalar_globals(value, model)),
            sort_by: Box::new(expand_scalar_globals(sort_by, model)),
        },
        Expression::MinBy { value, sort_by } => Expression::MinBy {
            value: Box::new(expand_scalar_globals(value, model)),
            sort_by: Box::new(expand_scalar_globals(sort_by, model)),
        },
        Expression::RankWindow { .. } => expr.clone(),
        Expression::Call { name, args } => Expression::Call {
            name: name.clone(),
            args: args
                .iter()
                .map(|a| expand_scalar_globals(a, model))
                .collect(),
        },
        // Leaves that don't contain sub-expressions or ColumnRef.
        Expression::LiteralFloat(_)
        | Expression::LiteralInt(_)
        | Expression::LiteralDate(_)
        | Expression::LiteralString(_)
        | Expression::LiteralBool(_)
        | Expression::Blank
        | Expression::TableRef(_)
        | Expression::MeasureRef(_)
        | Expression::SelectedMeasure
        | Expression::QualifiedColumnRef { .. }
        | Expression::Query { .. } => expr.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Global variable expansion tests ---

    fn make_model_with_globals() -> crate::model::schema::DataModel {
        use crate::compute::aggregate::AggregateOp;
        use crate::model::column::Column;
        use crate::model::global_variable::GlobalVariable;
        use crate::model::table::Table;
        use crate::types::DataType;

        let fact = Table::new(
            "fact_sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("linetotal", DataType::Float64),
                Column::new("customer_id", DataType::Int64),
            ],
        )
        .unwrap();

        let dim = Table::new(
            "dim_customer",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("city", DataType::String),
            ],
        )
        .unwrap();

        // Scalar global: SUM(fact_sales[linetotal])
        let scalar_gv = GlobalVariable::new(
            "total_revenue",
            "fact_sales",
            Expression::Aggregate {
                operation: AggregateOp::Sum,
                operand: Box::new(col("linetotal")),
            },
        );

        // Table global: QUERY(SUM(fact_sales[linetotal]) AS Amount BY dim_customer[city])
        let query_gv = GlobalVariable::new(
            "city_sales",
            "fact_sales",
            Expression::Query {
                aggregates: vec![(
                    Expression::Aggregate {
                        operation: AggregateOp::Sum,
                        operand: Box::new(col("linetotal")),
                    },
                    "Amount".into(),
                )],
                group_by: vec![("dim_customer".into(), "city".into())],
            },
        );

        crate::model::schema::DataModel::builder()
            .add_table(fact)
            .add_table(dim)
            .add_global_variable(scalar_gv)
            .add_global_variable(query_gv)
            .build()
            .unwrap()
    }

    #[test]
    fn expand_scalar_global_substitutes_inline() {
        let model = make_model_with_globals();
        // total_revenue should be replaced with SUM(linetotal)
        let expr = col("total_revenue");
        let expanded = expand_global_variables(&expr, &model);

        assert!(matches!(expanded, Expression::Aggregate { .. }));
        assert_eq!(expanded.to_sql_string().unwrap(), "SUM(\"linetotal\")");
    }

    #[test]
    fn expand_scalar_global_in_arithmetic() {
        let model = make_model_with_globals();
        // total_revenue / 100
        let expr = col("total_revenue").divide(lit(100.0));
        let expanded = expand_global_variables(&expr, &model);

        assert_eq!(
            expanded.to_sql_string().unwrap(),
            "(SUM(\"linetotal\") / 100)"
        );
    }

    #[test]
    fn expand_query_global_wraps_in_block() {
        use crate::compute::aggregate::AggregateOp;
        let model = make_model_with_globals();

        // AVG(city_sales[Amount]) — references QUERY global via QualifiedColumnRef
        let expr = Expression::Aggregate {
            operation: AggregateOp::Average,
            operand: Box::new(Expression::QualifiedColumnRef {
                table_or_var: "city_sales".into(),
                column: "Amount".into(),
            }),
        };
        let expanded = expand_global_variables(&expr, &model);

        // Should be wrapped in a Block with the QUERY binding.
        match &expanded {
            Expression::Block {
                bindings, result, ..
            } => {
                assert_eq!(bindings.len(), 1);
                assert_eq!(bindings[0].0, "city_sales");
                assert!(matches!(bindings[0].1, Expression::Query { .. }));
                assert!(matches!(result.as_ref(), Expression::Aggregate { .. }));
            }
            other => panic!("Expected Block, got {other:?}"),
        }
    }

    #[test]
    fn expand_no_globals_returns_unchanged() {
        let model = make_model_with_globals();
        // Expression with no global references.
        let expr = col("linetotal");
        let expanded = expand_global_variables(&expr, &model);
        assert_eq!(
            expanded.to_sql_string().unwrap(),
            expr.to_sql_string().unwrap()
        );
    }

    #[test]
    fn expand_noop_when_model_has_no_globals() {
        use crate::model::column::Column;
        use crate::model::table::Table;
        use crate::types::DataType;

        let model = crate::model::schema::DataModel::builder()
            .add_table(Table::new("T", vec![Column::new("x", DataType::Int64)]).unwrap())
            .build()
            .unwrap();

        let expr = col("x");
        let expanded = expand_global_variables(&expr, &model);
        assert_eq!(
            expanded.to_sql_string().unwrap(),
            expr.to_sql_string().unwrap()
        );
    }

    #[test]
    fn expand_existing_block_merges_query_bindings() {
        use crate::compute::aggregate::AggregateOp;
        let model = make_model_with_globals();

        // Existing block with a scalar VAR, referencing a QUERY global in result.
        let expr = Expression::Block {
            bindings: vec![("factor".into(), lit(2.0))],
            query_scoped_bindings: Vec::new(),
            result: Box::new(Expression::Aggregate {
                operation: AggregateOp::Average,
                operand: Box::new(Expression::QualifiedColumnRef {
                    table_or_var: "city_sales".into(),
                    column: "Amount".into(),
                }),
            }),
        };
        let expanded = expand_global_variables(&expr, &model);

        match &expanded {
            Expression::Block { bindings, .. } => {
                // Should have city_sales QUERY binding + original factor binding.
                assert_eq!(bindings.len(), 2);
                let names: Vec<&str> = bindings.iter().map(|(n, _)| n.as_str()).collect();
                assert!(names.contains(&"city_sales"));
                assert!(names.contains(&"factor"));
            }
            other => panic!("Expected Block, got {other:?}"),
        }
    }
}
