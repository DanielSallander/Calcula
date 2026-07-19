//! Measure reference expansion and fact-table inference.

use super::*;

/// Expand calculated-table references in an expression.
///
/// A `QualifiedColumnRef { table_or_var, .. }` matching a calculated table
/// (QUERY global variable) causes the entire expression to be wrapped in a
/// `Block` with the QUERY expression as a binding. Multiple distinct
/// calculated tables each get their own binding.
///
/// The function is idempotent: if no calculated-table references are found,
/// the expression is returned unchanged (cloned).
/// Returns `true` if the expression tree contains any `MeasureRef` nodes.
pub fn has_measure_ref(expr: &Expression) -> bool {
    match expr {
        Expression::MeasureRef(_) => true,
        Expression::BinaryOp { left, right, .. }
        | Expression::Comparison { left, right, .. }
        | Expression::And(left, right)
        | Expression::Or(left, right)
        | Expression::Xor(left, right) => has_measure_ref(left) || has_measure_ref(right),
        Expression::Not(inner) | Expression::IsBlank(inner) => has_measure_ref(inner),
        Expression::Aggregate { operand, .. } => has_measure_ref(operand),
        Expression::Keep { expr, .. }
        | Expression::Clear { expr, .. }
        | Expression::Reset { expr }
        | Expression::ClearInner { expr, .. }
        | Expression::ClearOuter { expr, .. }
        | Expression::ResetInner { expr }
        | Expression::ResetOuter { expr }
        | Expression::Traverse { expr, .. }
        | Expression::Using { expr, .. }
        | Expression::UseRelationship { expr, .. }
        | Expression::KeepIn { expr, .. } => has_measure_ref(expr),
        Expression::Block {
            bindings,
            query_scoped_bindings,
            result,
        } => {
            bindings
                .iter()
                .chain(query_scoped_bindings.iter())
                .any(|(_, e)| has_measure_ref(e))
                || has_measure_ref(result)
        }
        Expression::Window { inner, .. }
        | Expression::Offset { inner, .. }
        | Expression::Index { inner, .. } => has_measure_ref(inner),
        Expression::ToDate { expr, .. }
        | Expression::PeriodShift { expr, .. }
        | Expression::DatesInPeriod { expr, .. }
        | Expression::DatesBetween { expr, .. }
        | Expression::SemiAdditiveBalance { expr, .. } => has_measure_ref(expr),
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => {
            has_measure_ref(numerator)
                || has_measure_ref(denominator)
                || alternate.as_ref().is_some_and(|a| has_measure_ref(a))
        }
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => has_measure_ref(condition) || has_measure_ref(then_expr) || has_measure_ref(else_expr),
        Expression::Switch {
            expr,
            cases,
            default,
        } => {
            has_measure_ref(expr)
                || cases
                    .iter()
                    .any(|(v, r)| has_measure_ref(v) || has_measure_ref(r))
                || default.as_ref().is_some_and(|d| has_measure_ref(d))
        }
        Expression::Coalesce(exprs) => exprs.iter().any(has_measure_ref),
        Expression::ScalarFunc { args, .. }
        | Expression::TextFunc { args, .. }
        | Expression::DateTimeFunc { args, .. } => args.iter().any(has_measure_ref),
        Expression::IfError { expr, alternate } => {
            has_measure_ref(expr) || has_measure_ref(alternate)
        }
        Expression::ClearExcept { expr, .. }
        | Expression::Iterate {
            expression: expr, ..
        } => has_measure_ref(expr),
        Expression::Percentile {
            operand,
            percentile,
        } => has_measure_ref(operand) || has_measure_ref(percentile),
        Expression::InList { expr, values, .. } => {
            has_measure_ref(expr) || values.iter().any(has_measure_ref)
        }
        Expression::Query { aggregates, .. } => aggregates.iter().any(|(e, _)| has_measure_ref(e)),
        Expression::HasOneValue { column } | Expression::FirstValue { column, .. } => {
            has_measure_ref(column)
        }
        Expression::SelectedValue { column, alternate } => {
            has_measure_ref(column) || alternate.as_ref().is_some_and(|a| has_measure_ref(a))
        }
        Expression::Call { args, .. } => args.iter().any(has_measure_ref),
        // Variadic / multi-arg aggregates that can carry a measure ref in any
        // operand — omitting these let a cyclic/unknown ref buried inside
        // `GREATEST([A], 0)` / `MAX_BY([X], k)` slip past the build-time gate.
        Expression::Greatest(args) | Expression::Least(args) => args.iter().any(has_measure_ref),
        Expression::NullIf { expr, value } => has_measure_ref(expr) || has_measure_ref(value),
        Expression::CountIf { condition } => has_measure_ref(condition),
        Expression::ListAgg { column, delimiter } => {
            has_measure_ref(column) || has_measure_ref(delimiter)
        }
        Expression::MaxBy { value, sort_by } | Expression::MinBy { value, sort_by } => {
            has_measure_ref(value) || has_measure_ref(sort_by)
        }
        _ => false,
    }
}

/// Expand all `MeasureRef` nodes by inlining the referenced measure's expression.
///
/// Detects circular references (A -> B -> A) and returns an error with the
/// full chain in the message. Should be called BEFORE `expand_global_variables`.
pub fn expand_measure_refs(
    expr: &Expression,
    model: &crate::model::schema::DataModel,
) -> crate::error::EngineResult<Expression> {
    let mut visited = Vec::new();
    expand_measure_refs_inner(expr, model, &mut visited)
}

fn expand_measure_refs_inner(
    expr: &Expression,
    model: &crate::model::schema::DataModel,
    visited: &mut Vec<String>,
) -> crate::error::EngineResult<Expression> {
    match expr {
        Expression::MeasureRef(name) => {
            if visited.contains(name) {
                visited.push(name.clone());
                let chain = visited.join(" -> ");
                return Err(crate::error::EngineError::InvalidData(format!(
                    "circular measure reference: {chain}"
                )));
            }
            visited.push(name.clone());
            let measure = model.measure(name)?;
            let expanded = expand_measure_refs_inner(measure.expression(), model, visited)?;
            visited.pop();
            Ok(expanded)
        }
        // Context wrappers: recurse into inner expr.
        Expression::Keep {
            expr: inner,
            filters,
            variables,
            conditions,
            in_predicates,
        } => Ok(Expression::Keep {
            expr: Box::new(expand_measure_refs_inner(inner, model, visited)?),
            filters: filters.clone(),
            variables: variables.clone(),
            conditions: conditions
                .iter()
                .map(|c| expand_measure_refs_inner(c, model, visited))
                .collect::<crate::error::EngineResult<Vec<_>>>()?,
            in_predicates: in_predicates.clone(),
        }),
        Expression::Clear {
            expr: inner,
            targets,
        } => Ok(Expression::Clear {
            expr: Box::new(expand_measure_refs_inner(inner, model, visited)?),
            targets: targets.clone(),
        }),
        Expression::Reset { expr: inner } => Ok(Expression::Reset {
            expr: Box::new(expand_measure_refs_inner(inner, model, visited)?),
        }),
        Expression::Traverse { expr: inner, path } => Ok(Expression::Traverse {
            expr: Box::new(expand_measure_refs_inner(inner, model, visited)?),
            path: path.clone(),
        }),
        Expression::Using {
            expr: inner,
            context_name,
        } => Ok(Expression::Using {
            expr: Box::new(expand_measure_refs_inner(inner, model, visited)?),
            context_name: context_name.clone(),
        }),
        Expression::UseRelationship {
            expr: inner,
            relationship_name,
        } => Ok(Expression::UseRelationship {
            expr: Box::new(expand_measure_refs_inner(inner, model, visited)?),
            relationship_name: relationship_name.clone(),
        }),
        Expression::ClearInner {
            expr: inner,
            targets,
        } => Ok(Expression::ClearInner {
            expr: Box::new(expand_measure_refs_inner(inner, model, visited)?),
            targets: targets.clone(),
        }),
        Expression::ClearOuter {
            expr: inner,
            targets,
        } => Ok(Expression::ClearOuter {
            expr: Box::new(expand_measure_refs_inner(inner, model, visited)?),
            targets: targets.clone(),
        }),
        Expression::ResetInner { expr: inner } => Ok(Expression::ResetInner {
            expr: Box::new(expand_measure_refs_inner(inner, model, visited)?),
        }),
        Expression::ResetOuter { expr: inner } => Ok(Expression::ResetOuter {
            expr: Box::new(expand_measure_refs_inner(inner, model, visited)?),
        }),
        Expression::KeepIn {
            expr: inner,
            predicates,
        } => Ok(Expression::KeepIn {
            expr: Box::new(expand_measure_refs_inner(inner, model, visited)?),
            predicates: predicates.clone(),
        }),
        // Compound expressions: recurse into children.
        Expression::BinaryOp { left, op, right } => Ok(Expression::BinaryOp {
            left: Box::new(expand_measure_refs_inner(left, model, visited)?),
            op: *op,
            right: Box::new(expand_measure_refs_inner(right, model, visited)?),
        }),
        Expression::Aggregate { operation, operand } => Ok(Expression::Aggregate {
            operation: *operation,
            operand: Box::new(expand_measure_refs_inner(operand, model, visited)?),
        }),
        Expression::Block {
            bindings,
            query_scoped_bindings,
            result,
        } => {
            let expanded_bindings = bindings
                .iter()
                .map(|(name, e)| Ok((name.clone(), expand_measure_refs_inner(e, model, visited)?)))
                .collect::<crate::error::EngineResult<Vec<_>>>()?;
            let expanded_query_scoped = query_scoped_bindings
                .iter()
                .map(|(name, e)| Ok((name.clone(), expand_measure_refs_inner(e, model, visited)?)))
                .collect::<crate::error::EngineResult<Vec<_>>>()?;
            Ok(Expression::Block {
                bindings: expanded_bindings,
                query_scoped_bindings: expanded_query_scoped,
                result: Box::new(expand_measure_refs_inner(result, model, visited)?),
            })
        }
        Expression::Window {
            inner,
            function,
            order_by,
            partition_by,
            frame,
        } => Ok(Expression::Window {
            inner: Box::new(expand_measure_refs_inner(inner, model, visited)?),
            function: *function,
            order_by: order_by.clone(),
            partition_by: partition_by.clone(),
            frame: frame.clone(),
        }),
        Expression::Offset {
            inner,
            delta,
            order_by,
            partition_by,
        } => Ok(Expression::Offset {
            inner: Box::new(expand_measure_refs_inner(inner, model, visited)?),
            delta: *delta,
            order_by: order_by.clone(),
            partition_by: partition_by.clone(),
        }),
        Expression::Index {
            inner,
            position,
            order_by,
            partition_by,
        } => Ok(Expression::Index {
            inner: Box::new(expand_measure_refs_inner(inner, model, visited)?),
            position: *position,
            order_by: order_by.clone(),
            partition_by: partition_by.clone(),
        }),
        Expression::ToDate { expr, granularity } => Ok(Expression::ToDate {
            expr: Box::new(expand_measure_refs_inner(expr, model, visited)?),
            granularity: *granularity,
        }),
        Expression::PeriodShift {
            expr,
            offset,
            granularity,
        } => Ok(Expression::PeriodShift {
            expr: Box::new(expand_measure_refs_inner(expr, model, visited)?),
            offset: *offset,
            granularity: *granularity,
        }),
        Expression::DatesInPeriod {
            expr,
            intervals,
            granularity,
        } => Ok(Expression::DatesInPeriod {
            expr: Box::new(expand_measure_refs_inner(expr, model, visited)?),
            intervals: *intervals,
            granularity: *granularity,
        }),
        Expression::DatesBetween { expr, start, end } => Ok(Expression::DatesBetween {
            expr: Box::new(expand_measure_refs_inner(expr, model, visited)?),
            start: start.clone(),
            end: end.clone(),
        }),
        Expression::SemiAdditiveBalance {
            expr,
            opening,
            shift_days,
            non_blank,
        } => Ok(Expression::SemiAdditiveBalance {
            expr: Box::new(expand_measure_refs_inner(expr, model, visited)?),
            opening: *opening,
            shift_days: *shift_days,
            non_blank: *non_blank,
        }),
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => Ok(Expression::SafeDivide {
            numerator: Box::new(expand_measure_refs_inner(numerator, model, visited)?),
            denominator: Box::new(expand_measure_refs_inner(denominator, model, visited)?),
            alternate: alternate
                .as_ref()
                .map(|a| expand_measure_refs_inner(a, model, visited))
                .transpose()?
                .map(Box::new),
        }),
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => Ok(Expression::If {
            condition: Box::new(expand_measure_refs_inner(condition, model, visited)?),
            then_expr: Box::new(expand_measure_refs_inner(then_expr, model, visited)?),
            else_expr: Box::new(expand_measure_refs_inner(else_expr, model, visited)?),
        }),
        Expression::Switch {
            expr: switch_expr,
            cases,
            default,
        } => {
            let expanded_cases = cases
                .iter()
                .map(|(v, r)| {
                    Ok((
                        expand_measure_refs_inner(v, model, visited)?,
                        expand_measure_refs_inner(r, model, visited)?,
                    ))
                })
                .collect::<crate::error::EngineResult<Vec<_>>>()?;
            Ok(Expression::Switch {
                expr: Box::new(expand_measure_refs_inner(switch_expr, model, visited)?),
                cases: expanded_cases,
                default: default
                    .as_ref()
                    .map(|d| expand_measure_refs_inner(d, model, visited))
                    .transpose()?
                    .map(Box::new),
            })
        }
        Expression::Coalesce(exprs) => Ok(Expression::Coalesce(
            exprs
                .iter()
                .map(|e| expand_measure_refs_inner(e, model, visited))
                .collect::<crate::error::EngineResult<Vec<_>>>()?,
        )),
        Expression::ScalarFunc { function, args } => Ok(Expression::ScalarFunc {
            function: *function,
            args: args
                .iter()
                .map(|a| expand_measure_refs_inner(a, model, visited))
                .collect::<crate::error::EngineResult<Vec<_>>>()?,
        }),
        Expression::TextFunc { function, args } => Ok(Expression::TextFunc {
            function: *function,
            args: args
                .iter()
                .map(|a| expand_measure_refs_inner(a, model, visited))
                .collect::<crate::error::EngineResult<Vec<_>>>()?,
        }),
        Expression::DateTimeFunc { function, args } => Ok(Expression::DateTimeFunc {
            function: *function,
            args: args
                .iter()
                .map(|a| expand_measure_refs_inner(a, model, visited))
                .collect::<crate::error::EngineResult<Vec<_>>>()?,
        }),
        Expression::IfError { expr, alternate } => Ok(Expression::IfError {
            expr: Box::new(expand_measure_refs_inner(expr, model, visited)?),
            alternate: Box::new(expand_measure_refs_inner(alternate, model, visited)?),
        }),
        Expression::ClearExcept {
            expr,
            table,
            except_columns,
        } => Ok(Expression::ClearExcept {
            expr: Box::new(expand_measure_refs_inner(expr, model, visited)?),
            table: table.clone(),
            except_columns: except_columns.clone(),
        }),
        Expression::Iterate { table, expression } => Ok(Expression::Iterate {
            table: table.clone(),
            expression: Box::new(expand_measure_refs_inner(expression, model, visited)?),
        }),
        Expression::Percentile {
            operand,
            percentile,
        } => Ok(Expression::Percentile {
            operand: Box::new(expand_measure_refs_inner(operand, model, visited)?),
            percentile: Box::new(expand_measure_refs_inner(percentile, model, visited)?),
        }),
        Expression::Comparison { left, op, right } => Ok(Expression::Comparison {
            left: Box::new(expand_measure_refs_inner(left, model, visited)?),
            op: *op,
            right: Box::new(expand_measure_refs_inner(right, model, visited)?),
        }),
        Expression::And(left, right) => Ok(Expression::And(
            Box::new(expand_measure_refs_inner(left, model, visited)?),
            Box::new(expand_measure_refs_inner(right, model, visited)?),
        )),
        Expression::Or(left, right) => Ok(Expression::Or(
            Box::new(expand_measure_refs_inner(left, model, visited)?),
            Box::new(expand_measure_refs_inner(right, model, visited)?),
        )),
        Expression::Xor(left, right) => Ok(Expression::Xor(
            Box::new(expand_measure_refs_inner(left, model, visited)?),
            Box::new(expand_measure_refs_inner(right, model, visited)?),
        )),
        Expression::Not(inner) => Ok(Expression::Not(Box::new(expand_measure_refs_inner(
            inner, model, visited,
        )?))),
        Expression::IsBlank(inner) => Ok(Expression::IsBlank(Box::new(expand_measure_refs_inner(
            inner, model, visited,
        )?))),
        Expression::InList {
            expr: inner,
            values,
            negated,
        } => Ok(Expression::InList {
            expr: Box::new(expand_measure_refs_inner(inner, model, visited)?),
            values: values
                .iter()
                .map(|v| expand_measure_refs_inner(v, model, visited))
                .collect::<crate::error::EngineResult<Vec<_>>>()?,
            negated: *negated,
        }),
        Expression::Call { name, args } => Ok(Expression::Call {
            name: name.clone(),
            args: args
                .iter()
                .map(|a| expand_measure_refs_inner(a, model, visited))
                .collect::<crate::error::EngineResult<Vec<_>>>()?,
        }),
        // Variadic / multi-arg nodes that can carry a MeasureRef — must recurse
        // so a cyclic/unknown ref buried here is detected, not cloned verbatim.
        Expression::Greatest(args) => Ok(Expression::Greatest(
            args.iter()
                .map(|a| expand_measure_refs_inner(a, model, visited))
                .collect::<crate::error::EngineResult<Vec<_>>>()?,
        )),
        Expression::Least(args) => Ok(Expression::Least(
            args.iter()
                .map(|a| expand_measure_refs_inner(a, model, visited))
                .collect::<crate::error::EngineResult<Vec<_>>>()?,
        )),
        Expression::NullIf { expr, value } => Ok(Expression::NullIf {
            expr: Box::new(expand_measure_refs_inner(expr, model, visited)?),
            value: Box::new(expand_measure_refs_inner(value, model, visited)?),
        }),
        Expression::CountIf { condition } => Ok(Expression::CountIf {
            condition: Box::new(expand_measure_refs_inner(condition, model, visited)?),
        }),
        Expression::ListAgg { column, delimiter } => Ok(Expression::ListAgg {
            column: Box::new(expand_measure_refs_inner(column, model, visited)?),
            delimiter: Box::new(expand_measure_refs_inner(delimiter, model, visited)?),
        }),
        Expression::MaxBy { value, sort_by } => Ok(Expression::MaxBy {
            value: Box::new(expand_measure_refs_inner(value, model, visited)?),
            sort_by: Box::new(expand_measure_refs_inner(sort_by, model, visited)?),
        }),
        Expression::MinBy { value, sort_by } => Ok(Expression::MinBy {
            value: Box::new(expand_measure_refs_inner(value, model, visited)?),
            sort_by: Box::new(expand_measure_refs_inner(sort_by, model, visited)?),
        }),
        Expression::HasOneValue { column } => Ok(Expression::HasOneValue {
            column: Box::new(expand_measure_refs_inner(column, model, visited)?),
        }),
        Expression::SelectedValue { column, alternate } => Ok(Expression::SelectedValue {
            column: Box::new(expand_measure_refs_inner(column, model, visited)?),
            alternate: alternate
                .as_ref()
                .map(|a| expand_measure_refs_inner(a, model, visited))
                .transpose()?
                .map(Box::new),
        }),
        Expression::FirstValue { column, order_by } => Ok(Expression::FirstValue {
            column: Box::new(expand_measure_refs_inner(column, model, visited)?),
            order_by: Box::new(expand_measure_refs_inner(order_by, model, visited)?),
        }),
        Expression::Query {
            aggregates,
            group_by,
            top,
        } => Ok(Expression::Query {
            aggregates: aggregates
                .iter()
                .map(|(e, alias)| {
                    Ok((expand_measure_refs_inner(e, model, visited)?, alias.clone()))
                })
                .collect::<crate::error::EngineResult<Vec<_>>>()?,
            group_by: group_by.clone(),
            top: top.clone(),
        }),
        // Leaf nodes and anything without MeasureRef pass through unchanged.
        _ => Ok(expr.clone()),
    }
}

/// Walk the expression tree to find the first qualified column reference's table.
///
/// Returns `Some(table_name)` if a `QualifiedColumnRef` or `TableRef` is found
/// anywhere in the expression tree. Used by `Measure` to infer which fact table
/// the measure operates on, removing the need for a stored `table` field.
pub fn infer_fact_table(expr: &Expression) -> Option<String> {
    match expr {
        Expression::QualifiedColumnRef { table_or_var, .. } => Some(table_or_var.clone()),
        Expression::TableRef(name) => Some(name.clone()),
        Expression::Aggregate { operand, .. } => infer_fact_table(operand),
        Expression::BinaryOp { left, right, .. }
        | Expression::Comparison { left, right, .. }
        | Expression::And(left, right)
        | Expression::Or(left, right)
        | Expression::Xor(left, right) => {
            infer_fact_table(left).or_else(|| infer_fact_table(right))
        }
        Expression::Not(inner) | Expression::IsBlank(inner) => infer_fact_table(inner),
        Expression::Keep { expr, .. }
        | Expression::Clear { expr, .. }
        | Expression::Reset { expr }
        | Expression::ClearInner { expr, .. }
        | Expression::ClearOuter { expr, .. }
        | Expression::ResetInner { expr }
        | Expression::ResetOuter { expr }
        | Expression::Traverse { expr, .. }
        | Expression::Using { expr, .. }
        | Expression::UseRelationship { expr, .. }
        | Expression::KeepIn { expr, .. } => infer_fact_table(expr),
        Expression::Block {
            bindings,
            query_scoped_bindings,
            result,
        } => {
            // A fact may appear only inside a binding (VAR *or* GVAR), e.g.
            // `GVAR t = SUM(Fact[amt]) RETURN t/2`, so scan both binding lists
            // before the result.
            for (_, e) in bindings.iter().chain(query_scoped_bindings.iter()) {
                if let Some(t) = infer_fact_table(e) {
                    return Some(t);
                }
            }
            infer_fact_table(result)
        }
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => infer_fact_table(condition)
            .or_else(|| infer_fact_table(then_expr))
            .or_else(|| infer_fact_table(else_expr)),
        Expression::Switch {
            expr,
            cases,
            default,
        } => {
            if let Some(t) = infer_fact_table(expr) {
                return Some(t);
            }
            for (v, r) in cases {
                if let Some(t) = infer_fact_table(v).or_else(|| infer_fact_table(r)) {
                    return Some(t);
                }
            }
            default.as_ref().and_then(|d| infer_fact_table(d))
        }
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => infer_fact_table(numerator)
            .or_else(|| infer_fact_table(denominator))
            .or_else(|| alternate.as_ref().and_then(|a| infer_fact_table(a))),
        Expression::Coalesce(exprs) => exprs.iter().find_map(infer_fact_table),
        Expression::ScalarFunc { args, .. } | Expression::TextFunc { args, .. } => {
            args.iter().find_map(infer_fact_table)
        }
        Expression::Query {
            aggregates,
            group_by,
            ..
        } => aggregates
            .iter()
            .find_map(|(e, _)| infer_fact_table(e))
            .or_else(|| group_by.first().map(|(table, _)| table.clone())),
        Expression::HasOneValue { column } => infer_fact_table(column),
        Expression::SelectedValue { column, alternate } => infer_fact_table(column)
            .or_else(|| alternate.as_ref().and_then(|a| infer_fact_table(a))),
        Expression::FirstValue { column, order_by } => {
            infer_fact_table(column).or_else(|| infer_fact_table(order_by))
        }
        Expression::Window {
            inner, order_by, ..
        }
        | Expression::Offset {
            inner, order_by, ..
        }
        | Expression::Index {
            inner, order_by, ..
        } => infer_fact_table(inner).or_else(|| order_by.first().map(|(table, _)| table.clone())),
        Expression::ToDate { expr, .. }
        | Expression::PeriodShift { expr, .. }
        | Expression::DatesInPeriod { expr, .. }
        | Expression::DatesBetween { expr, .. }
        | Expression::SemiAdditiveBalance { expr, .. } => infer_fact_table(expr),
        Expression::InList { expr, values, .. } => {
            infer_fact_table(expr).or_else(|| values.iter().find_map(infer_fact_table))
        }
        Expression::Iterate { table, expression } => {
            Some(table.clone()).or_else(|| infer_fact_table(expression))
        }
        Expression::Percentile {
            operand,
            percentile,
        } => infer_fact_table(operand).or_else(|| infer_fact_table(percentile)),
        Expression::ClearExcept { expr, .. } => infer_fact_table(expr),
        Expression::IfError { expr, alternate } => {
            infer_fact_table(expr).or_else(|| infer_fact_table(alternate))
        }
        Expression::DateTimeFunc { args, .. } => args.iter().find_map(infer_fact_table),
        Expression::IsInScope { .. } | Expression::IsFiltered { .. } => None,
        Expression::Greatest(args) | Expression::Least(args) => {
            args.iter().find_map(infer_fact_table)
        }
        Expression::NullIf { expr, value } => {
            infer_fact_table(expr).or_else(|| infer_fact_table(value))
        }
        Expression::CountIf { condition } => infer_fact_table(condition),
        Expression::ListAgg { column, .. } => infer_fact_table(column),
        Expression::MaxBy { value, sort_by } | Expression::MinBy { value, sort_by } => {
            infer_fact_table(value).or_else(|| infer_fact_table(sort_by))
        }
        // Mirror Window/Offset/Index: the fact table is the order-by / partition
        // table. Returning None here cached an empty table name on the measure
        // and made the model fail to build with TableNotFound("").
        Expression::RankWindow {
            order_by,
            partition_by,
            ..
        } => order_by
            .first()
            .or_else(|| partition_by.first())
            .map(|(table, _)| table.clone()),
        Expression::Call { args, .. } => args.iter().find_map(infer_fact_table),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- MeasureRef expansion tests ---

    #[test]
    fn expand_measure_ref_simple() {
        use crate::compute::aggregate::AggregateOp;
        use crate::compute::measure::Measure;
        use crate::model::column::Column;
        use crate::model::schema::DataModel;
        use crate::model::table::Table;
        use crate::types::DataType;

        let table = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("amount", DataType::Float64),
            ],
        )
        .unwrap();

        let total = Measure::new(
            "TotalSales",
            agg(AggregateOp::Sum, qualified_col("Sales", "amount")),
        );

        let ref_measure = Measure::new("RefMeasure", Expression::MeasureRef("TotalSales".into()));

        let model = DataModel::builder()
            .add_table(table)
            .add_measure(total)
            .add_measure(ref_measure)
            .build()
            .unwrap();

        let expr = model.measure("RefMeasure").unwrap().expression();
        let expanded = expand_measure_refs(expr, &model).unwrap();
        assert!(matches!(expanded, Expression::Aggregate { .. }));
    }

    #[test]
    fn resolve_measure_home_tables_gives_measure_only_measure_a_table() {
        use crate::compute::aggregate::AggregateOp;
        use crate::compute::measure::Measure;
        use crate::model::column::Column;
        use crate::model::schema::DataModel;
        use crate::model::table::Table;
        use crate::types::DataType;

        let table = Table::new("Sales", vec![Column::new("amount", DataType::Float64)]).unwrap();
        let total = Measure::new(
            "TotalSales",
            agg(AggregateOp::Sum, qualified_col("Sales", "amount")),
        );
        // References only another measure — no column of its own, so no home table.
        let bonus = Measure::new("Bonus", Expression::MeasureRef("TotalSales".into()));
        assert_eq!(bonus.table(), "");

        let mut model = DataModel::builder()
            .add_table(table)
            .add_measure(total)
            .add_measure(bonus)
            .build()
            .unwrap();
        assert_eq!(model.measure("Bonus").unwrap().table(), "");
        model.resolve_measure_home_tables();
        // Resolved to the home table of the measure it references.
        assert_eq!(model.measure("Bonus").unwrap().table(), "Sales");
    }

    #[test]
    fn expand_measure_ref_with_context() {
        use crate::compute::aggregate::AggregateOp;
        use crate::compute::measure::Measure;
        use crate::model::column::Column;
        use crate::model::schema::DataModel;
        use crate::model::table::Table;
        use crate::types::DataType;

        let table = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("amount", DataType::Float64),
            ],
        )
        .unwrap();

        let total = Measure::new(
            "TotalSales",
            agg(AggregateOp::Sum, qualified_col("Sales", "amount")),
        );

        // [TotalSales](USERELATIONSHIP("some_rel")) → UseRelationship wrapping expanded expr
        let ref_expr = use_relationship(Expression::MeasureRef("TotalSales".into()), "some_rel");
        let ref_measure = Measure::new("ShipSales", ref_expr);

        let model = DataModel::builder()
            .add_table(table)
            .add_measure(total)
            .add_measure(ref_measure)
            .build()
            .unwrap();

        let expr = model.measure("ShipSales").unwrap().expression();
        let expanded = expand_measure_refs(expr, &model).unwrap();
        // Should be UseRelationship { expr: Aggregate { Sum, ... }, ... }
        assert!(matches!(expanded, Expression::UseRelationship { .. }));
        if let Expression::UseRelationship { expr: inner, .. } = &expanded {
            assert!(matches!(**inner, Expression::Aggregate { .. }));
        }
    }

    #[test]
    fn expand_measure_ref_circular_detected() {
        use crate::compute::measure::Measure;
        use crate::model::column::Column;
        use crate::model::schema::DataModel;
        use crate::model::table::Table;
        use crate::types::DataType;

        let table = Table::new("T", vec![Column::new("x", DataType::Int64)]).unwrap();
        let m_a = Measure::new("A", Expression::MeasureRef("B".into()));
        let m_b = Measure::new("B", Expression::MeasureRef("A".into()));

        let result = DataModel::builder()
            .add_table(table)
            .add_measure(m_a)
            .add_measure(m_b)
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("circular"));
    }

    #[test]
    fn expand_measure_ref_missing_target() {
        use crate::compute::measure::Measure;
        use crate::model::column::Column;
        use crate::model::schema::DataModel;
        use crate::model::table::Table;
        use crate::types::DataType;

        let table = Table::new("T", vec![Column::new("x", DataType::Int64)]).unwrap();
        let m = Measure::new("A", Expression::MeasureRef("NonExistent".into()));

        let result = DataModel::builder().add_table(table).add_measure(m).build();

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("NonExistent"));
    }

    #[test]
    fn expand_measure_ref_chained() {
        use crate::compute::aggregate::AggregateOp;
        use crate::compute::measure::Measure;
        use crate::model::column::Column;
        use crate::model::schema::DataModel;
        use crate::model::table::Table;
        use crate::types::DataType;

        let table = Table::new(
            "Sales",
            vec![
                Column::new("id", DataType::Int64),
                Column::new("amount", DataType::Float64),
            ],
        )
        .unwrap();

        let base = Measure::new(
            "Base",
            agg(AggregateOp::Sum, qualified_col("Sales", "amount")),
        );
        // Mid references Base
        let mid = Measure::new("Mid", Expression::MeasureRef("Base".into()));
        // Top references Mid
        let top = Measure::new("Top", Expression::MeasureRef("Mid".into()));

        let model = DataModel::builder()
            .add_table(table)
            .add_measure(base)
            .add_measure(mid)
            .add_measure(top)
            .build()
            .unwrap();

        let expanded =
            expand_measure_refs(model.measure("Top").unwrap().expression(), &model).unwrap();
        // Should fully expand to SUM(Sales.amount)
        assert!(matches!(expanded, Expression::Aggregate { .. }));
    }

    #[test]
    fn cyclic_or_unknown_measure_ref_buried_in_variadic_node_is_detected() {
        use crate::compute::measure::{sum_measure, Measure};
        use crate::model::column::Column;
        use crate::model::schema::DataModel;
        use crate::model::table::Table;
        use crate::types::DataType;

        let table = || {
            Table::new(
                "Sales",
                vec![
                    Column::new("amount", DataType::Float64),
                    Column::new("k", DataType::Int64),
                ],
            )
            .unwrap()
        };

        // A = GREATEST([A], 0): a self-cycle buried in GREATEST must be caught
        // at build time (previously slipped past the has_measure_ref gate).
        let cyclic = Measure::new(
            "A",
            Expression::Greatest(vec![
                Expression::MeasureRef("A".into()),
                Expression::LiteralFloat(0.0),
            ]),
        );
        let err = DataModel::builder()
            .add_table(table())
            .add_measure(cyclic)
            .build()
            .unwrap_err();
        assert!(err.to_string().contains("circular"), "got: {err}");

        // B = MAX_BY([DoesNotExist], Sales[k]): an unknown ref buried in MAX_BY.
        let unknown = Measure::new(
            "B",
            Expression::MaxBy {
                value: Box::new(Expression::MeasureRef("DoesNotExist".into())),
                sort_by: Box::new(qualified_col("Sales", "k")),
            },
        );
        let err = DataModel::builder()
            .add_table(table())
            .add_measure(sum_measure("Real", "Sales", "amount"))
            .add_measure(unknown)
            .build()
            .unwrap_err();
        assert!(err.to_string().contains("DoesNotExist"), "got: {err}");
    }

    #[test]
    fn window_infer_fact_table() {
        let w = window_expr(
            agg(AggregateOp::Sum, qualified_col("fact_sales", "amount")),
            AggregateOp::Sum,
            vec![("dim_date".into(), "month".into())],
            vec![],
            None,
        );
        assert_eq!(infer_fact_table(&w), Some("fact_sales".into()));
    }
}
