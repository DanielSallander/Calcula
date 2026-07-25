//! Calculated-table expansion (QUERY block merging).
//!
//! Model-level calculated tables (engine struct: `GlobalVariable`) are
//! QUERY-only: a measure referencing `name[column]` gets the calculated
//! table's QUERY expression injected as a VAR binding in an implicit `Block`.
//! Only DYNAMIC calculated tables expand here — a materialized one is a real
//! model table (synthesized at build, data produced at refresh), so its
//! references resolve through the normal table machinery untouched. (Scalar
//! globals were removed 2026-07-11 — a reusable scalar is a hidden measure;
//! see Calcula's docs/design/calculated-tables.md.)

use super::*;

pub fn expand_global_variables(
    expr: &Expression,
    model: &crate::model::schema::DataModel,
) -> Expression {
    // Collect all calculated-table names referenced via QualifiedColumnRef.
    let mut query_globals = std::collections::HashSet::new();
    collect_query_global_refs(expr, model, &mut query_globals);

    // If any were referenced, wrap in a Block with those bindings.
    if query_globals.is_empty() {
        expr.clone()
    } else {
        // If the expression is already a Block, merge QUERY bindings into it.
        match expr.clone() {
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
                // Materialized calculated tables are real model tables — the
                // reference resolves through the table machinery, not here.
                if gv.is_query() && gv.is_dynamic() {
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
        | Expression::SelectedMeasure
        | Expression::IsSelectedMeasure { .. }
        | Expression::SelectedMeasureName
        | Expression::SelectedMeasureFormatString => {}
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
        Expression::IsInScope { .. }
        | Expression::IsFiltered { .. }
        | Expression::ThisRow { .. } => {}
        Expression::LookupValue { search, .. } => {
            for (_, e) in search {
                collect_query_global_refs(e, model, found);
            }
        }
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
        Expression::InList { expr, values, .. } => {
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
        | Expression::DatesBetween { expr, .. }
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

#[cfg(test)]
mod tests {
    use super::*;

    // --- Calculated-table expansion tests ---

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

        // Calculated table: QUERY(SUM(fact_sales[linetotal]) AS Amount BY dim_customer[city])
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
                top: None,
            },
        );

        crate::model::schema::DataModel::builder()
            .add_table(fact)
            .add_table(dim)
            .add_global_variable(query_gv)
            .build()
            .unwrap()
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
