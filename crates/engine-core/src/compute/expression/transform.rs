//! Expression transformations: variable substitution, binding inlining, scope resolution.

use super::*;

impl Expression {
    /// Substitute variable references (`ColumnRef(name)`) with their bound
    /// expressions. Used by `Block` (VAR/RETURN) to inline bindings before
    /// SQL generation.
    pub fn substitute_vars(
        &self,
        env: &std::collections::HashMap<String, Expression>,
    ) -> Expression {
        match self {
            Expression::ColumnRef(name) => {
                if let Some(replacement) = env.get(name) {
                    replacement.clone()
                } else {
                    self.clone()
                }
            }
            Expression::BinaryOp { left, op, right } => Expression::BinaryOp {
                left: Box::new(left.substitute_vars(env)),
                op: *op,
                right: Box::new(right.substitute_vars(env)),
            },
            Expression::Aggregate { operation, operand } => Expression::Aggregate {
                operation: *operation,
                operand: Box::new(operand.substitute_vars(env)),
            },
            Expression::SafeDivide {
                numerator,
                denominator,
                alternate,
            } => Expression::SafeDivide {
                numerator: Box::new(numerator.substitute_vars(env)),
                denominator: Box::new(denominator.substitute_vars(env)),
                alternate: alternate.as_ref().map(|a| Box::new(a.substitute_vars(env))),
            },
            Expression::ScalarFunc { function, args } => Expression::ScalarFunc {
                function: *function,
                args: args.iter().map(|a| a.substitute_vars(env)).collect(),
            },
            Expression::TextFunc { function, args } => Expression::TextFunc {
                function: *function,
                args: args.iter().map(|a| a.substitute_vars(env)).collect(),
            },
            Expression::DateTimeFunc { function, args } => Expression::DateTimeFunc {
                function: *function,
                args: args.iter().map(|a| a.substitute_vars(env)).collect(),
            },
            Expression::IfError { expr, alternate } => Expression::IfError {
                expr: Box::new(expr.substitute_vars(env)),
                alternate: Box::new(alternate.substitute_vars(env)),
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
                expr: Box::new(expr.substitute_vars(env)),
                table: table.clone(),
                except_columns: except_columns.clone(),
            },
            Expression::Iterate { table, expression } => Expression::Iterate {
                table: table.clone(),
                expression: Box::new(expression.substitute_vars(env)),
            },
            Expression::Percentile {
                operand,
                percentile,
            } => Expression::Percentile {
                operand: Box::new(operand.substitute_vars(env)),
                percentile: Box::new(percentile.substitute_vars(env)),
            },
            Expression::Coalesce(exprs) => {
                Expression::Coalesce(exprs.iter().map(|e| e.substitute_vars(env)).collect())
            }
            Expression::If {
                condition,
                then_expr,
                else_expr,
            } => Expression::If {
                condition: Box::new(condition.substitute_vars(env)),
                then_expr: Box::new(then_expr.substitute_vars(env)),
                else_expr: Box::new(else_expr.substitute_vars(env)),
            },
            Expression::IsBlank(inner) => Expression::IsBlank(Box::new(inner.substitute_vars(env))),
            Expression::Not(inner) => Expression::Not(Box::new(inner.substitute_vars(env))),
            Expression::Comparison { left, op, right } => Expression::Comparison {
                left: Box::new(left.substitute_vars(env)),
                op: *op,
                right: Box::new(right.substitute_vars(env)),
            },
            Expression::And(left, right) => Expression::And(
                Box::new(left.substitute_vars(env)),
                Box::new(right.substitute_vars(env)),
            ),
            Expression::Or(left, right) => Expression::Or(
                Box::new(left.substitute_vars(env)),
                Box::new(right.substitute_vars(env)),
            ),
            Expression::Xor(left, right) => Expression::Xor(
                Box::new(left.substitute_vars(env)),
                Box::new(right.substitute_vars(env)),
            ),
            Expression::Switch {
                expr,
                cases,
                default,
            } => Expression::Switch {
                expr: Box::new(expr.substitute_vars(env)),
                cases: cases
                    .iter()
                    .map(|(v, r)| (v.substitute_vars(env), r.substitute_vars(env)))
                    .collect(),
                default: default.as_ref().map(|d| Box::new(d.substitute_vars(env))),
            },
            Expression::Block { bindings, result } => {
                // Recursively inline inner blocks too.
                let mut inner_env = env.clone();
                let mut new_bindings = Vec::new();
                for (name, binding_expr) in bindings {
                    let resolved = binding_expr.substitute_vars(&inner_env);
                    inner_env.insert(name.clone(), resolved.clone());
                    new_bindings.push((name.clone(), resolved));
                }
                Expression::Block {
                    bindings: new_bindings,
                    result: Box::new(result.substitute_vars(&inner_env)),
                }
            }
            Expression::Query {
                aggregates,
                group_by,
            } => Expression::Query {
                aggregates: aggregates
                    .iter()
                    .map(|(e, alias)| (e.substitute_vars(env), alias.clone()))
                    .collect(),
                group_by: group_by.clone(),
            },
            Expression::HasOneValue { column } => Expression::HasOneValue {
                column: Box::new(column.substitute_vars(env)),
            },
            Expression::SelectedValue { column, alternate } => Expression::SelectedValue {
                column: Box::new(column.substitute_vars(env)),
                alternate: alternate.as_ref().map(|a| Box::new(a.substitute_vars(env))),
            },
            Expression::FirstValue { column, order_by } => Expression::FirstValue {
                column: Box::new(column.substitute_vars(env)),
                order_by: Box::new(order_by.substitute_vars(env)),
            },
            Expression::Window {
                inner,
                function,
                order_by,
                partition_by,
                frame,
            } => Expression::Window {
                inner: Box::new(inner.substitute_vars(env)),
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
                inner: Box::new(inner.substitute_vars(env)),
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
                inner: Box::new(inner.substitute_vars(env)),
                position: *position,
                order_by: order_by.clone(),
                partition_by: partition_by.clone(),
            },
            Expression::ToDate { expr, granularity } => Expression::ToDate {
                expr: Box::new(expr.substitute_vars(env)),
                granularity: *granularity,
            },
            Expression::PeriodShift {
                expr,
                offset,
                granularity,
            } => Expression::PeriodShift {
                expr: Box::new(expr.substitute_vars(env)),
                offset: *offset,
                granularity: *granularity,
            },
            Expression::DatesInPeriod {
                expr,
                intervals,
                granularity,
            } => Expression::DatesInPeriod {
                expr: Box::new(expr.substitute_vars(env)),
                intervals: *intervals,
                granularity: *granularity,
            },
            Expression::SemiAdditiveBalance { expr, opening } => {
                Expression::SemiAdditiveBalance {
                    expr: Box::new(expr.substitute_vars(env)),
                    opening: *opening,
                }
            }
            // Context operations: recurse into inner expression.
            Expression::Keep {
                expr,
                filters,
                variables,
                conditions,
                in_predicates,
            } => Expression::Keep {
                expr: Box::new(expr.substitute_vars(env)),
                filters: filters.clone(),
                variables: variables.clone(),
                conditions: conditions.iter().map(|c| c.substitute_vars(env)).collect(),
                in_predicates: in_predicates.clone(),
            },
            Expression::Clear { expr, targets } => Expression::Clear {
                expr: Box::new(expr.substitute_vars(env)),
                targets: targets.clone(),
            },
            Expression::Reset { expr } => Expression::Reset {
                expr: Box::new(expr.substitute_vars(env)),
            },
            Expression::ClearInner { expr, targets } => Expression::ClearInner {
                expr: Box::new(expr.substitute_vars(env)),
                targets: targets.clone(),
            },
            Expression::ClearOuter { expr, targets } => Expression::ClearOuter {
                expr: Box::new(expr.substitute_vars(env)),
                targets: targets.clone(),
            },
            Expression::ResetInner { expr } => Expression::ResetInner {
                expr: Box::new(expr.substitute_vars(env)),
            },
            Expression::ResetOuter { expr } => Expression::ResetOuter {
                expr: Box::new(expr.substitute_vars(env)),
            },
            Expression::Traverse { expr, path } => Expression::Traverse {
                expr: Box::new(expr.substitute_vars(env)),
                path: path.clone(),
            },
            Expression::Using { expr, context_name } => Expression::Using {
                expr: Box::new(expr.substitute_vars(env)),
                context_name: context_name.clone(),
            },
            Expression::UseRelationship {
                expr,
                relationship_name,
            } => Expression::UseRelationship {
                expr: Box::new(expr.substitute_vars(env)),
                relationship_name: relationship_name.clone(),
            },
            Expression::KeepIn { expr, predicates } => Expression::KeepIn {
                expr: Box::new(expr.substitute_vars(env)),
                predicates: predicates.clone(),
            },
            Expression::InList { expr, values } => Expression::InList {
                expr: Box::new(expr.substitute_vars(env)),
                values: values.iter().map(|v| v.substitute_vars(env)).collect(),
            },
            Expression::Greatest(args) => {
                Expression::Greatest(args.iter().map(|a| a.substitute_vars(env)).collect())
            }
            Expression::Least(args) => {
                Expression::Least(args.iter().map(|a| a.substitute_vars(env)).collect())
            }
            Expression::NullIf { expr, value } => Expression::NullIf {
                expr: Box::new(expr.substitute_vars(env)),
                value: Box::new(value.substitute_vars(env)),
            },
            Expression::CountIf { condition } => Expression::CountIf {
                condition: Box::new(condition.substitute_vars(env)),
            },
            Expression::ListAgg { column, delimiter } => Expression::ListAgg {
                column: Box::new(column.substitute_vars(env)),
                delimiter: Box::new(delimiter.substitute_vars(env)),
            },
            Expression::MaxBy { value, sort_by } => Expression::MaxBy {
                value: Box::new(value.substitute_vars(env)),
                sort_by: Box::new(sort_by.substitute_vars(env)),
            },
            Expression::MinBy { value, sort_by } => Expression::MinBy {
                value: Box::new(value.substitute_vars(env)),
                sort_by: Box::new(sort_by.substitute_vars(env)),
            },
            Expression::Call { name, args } => Expression::Call {
                name: name.clone(),
                args: args.iter().map(|a| a.substitute_vars(env)).collect(),
            },
            // Leaf expressions that don't contain ColumnRef — return as-is.
            _ => self.clone(),
        }
    }

    /// Replace every [`Expression::SelectedMeasure`] node in this tree with
    /// `replacement`, returning the rewritten clone.
    ///
    /// This is how a calculation item is applied to a target measure: the
    /// item's expression (e.g. `YTD(SELECTEDMEASURE())`) is rewritten with
    /// `replacement` set to the target measure's expression tree. **All**
    /// occurrences are replaced — an item may reference `SELECTEDMEASURE()`
    /// multiple times (e.g.
    /// `DIVIDE(SELECTEDMEASURE() - PRIORYEAR(SELECTEDMEASURE()), PRIORYEAR(SELECTEDMEASURE()))`).
    ///
    /// Modeled on [`Expression::substitute_vars`]: every compound node is
    /// rebuilt with its children substituted; leaf nodes other than
    /// `SelectedMeasure` are returned unchanged.
    pub fn substitute_selected_measure(&self, replacement: &Expression) -> Expression {
        match self {
            Expression::SelectedMeasure => replacement.clone(),
            Expression::BinaryOp { left, op, right } => Expression::BinaryOp {
                left: Box::new(left.substitute_selected_measure(replacement)),
                op: *op,
                right: Box::new(right.substitute_selected_measure(replacement)),
            },
            Expression::Aggregate { operation, operand } => Expression::Aggregate {
                operation: *operation,
                operand: Box::new(operand.substitute_selected_measure(replacement)),
            },
            Expression::SafeDivide {
                numerator,
                denominator,
                alternate,
            } => Expression::SafeDivide {
                numerator: Box::new(numerator.substitute_selected_measure(replacement)),
                denominator: Box::new(denominator.substitute_selected_measure(replacement)),
                alternate: alternate
                    .as_ref()
                    .map(|a| Box::new(a.substitute_selected_measure(replacement))),
            },
            Expression::ScalarFunc { function, args } => Expression::ScalarFunc {
                function: *function,
                args: args
                    .iter()
                    .map(|a| a.substitute_selected_measure(replacement))
                    .collect(),
            },
            Expression::TextFunc { function, args } => Expression::TextFunc {
                function: *function,
                args: args
                    .iter()
                    .map(|a| a.substitute_selected_measure(replacement))
                    .collect(),
            },
            Expression::DateTimeFunc { function, args } => Expression::DateTimeFunc {
                function: *function,
                args: args
                    .iter()
                    .map(|a| a.substitute_selected_measure(replacement))
                    .collect(),
            },
            Expression::IfError { expr, alternate } => Expression::IfError {
                expr: Box::new(expr.substitute_selected_measure(replacement)),
                alternate: Box::new(alternate.substitute_selected_measure(replacement)),
            },
            Expression::ClearExcept {
                expr,
                table,
                except_columns,
            } => Expression::ClearExcept {
                expr: Box::new(expr.substitute_selected_measure(replacement)),
                table: table.clone(),
                except_columns: except_columns.clone(),
            },
            Expression::Iterate { table, expression } => Expression::Iterate {
                table: table.clone(),
                expression: Box::new(expression.substitute_selected_measure(replacement)),
            },
            Expression::Percentile {
                operand,
                percentile,
            } => Expression::Percentile {
                operand: Box::new(operand.substitute_selected_measure(replacement)),
                percentile: Box::new(percentile.substitute_selected_measure(replacement)),
            },
            Expression::Coalesce(exprs) => Expression::Coalesce(
                exprs
                    .iter()
                    .map(|e| e.substitute_selected_measure(replacement))
                    .collect(),
            ),
            Expression::If {
                condition,
                then_expr,
                else_expr,
            } => Expression::If {
                condition: Box::new(condition.substitute_selected_measure(replacement)),
                then_expr: Box::new(then_expr.substitute_selected_measure(replacement)),
                else_expr: Box::new(else_expr.substitute_selected_measure(replacement)),
            },
            Expression::IsBlank(inner) => {
                Expression::IsBlank(Box::new(inner.substitute_selected_measure(replacement)))
            }
            Expression::Not(inner) => {
                Expression::Not(Box::new(inner.substitute_selected_measure(replacement)))
            }
            Expression::Comparison { left, op, right } => Expression::Comparison {
                left: Box::new(left.substitute_selected_measure(replacement)),
                op: *op,
                right: Box::new(right.substitute_selected_measure(replacement)),
            },
            Expression::And(left, right) => Expression::And(
                Box::new(left.substitute_selected_measure(replacement)),
                Box::new(right.substitute_selected_measure(replacement)),
            ),
            Expression::Or(left, right) => Expression::Or(
                Box::new(left.substitute_selected_measure(replacement)),
                Box::new(right.substitute_selected_measure(replacement)),
            ),
            Expression::Xor(left, right) => Expression::Xor(
                Box::new(left.substitute_selected_measure(replacement)),
                Box::new(right.substitute_selected_measure(replacement)),
            ),
            Expression::Switch {
                expr,
                cases,
                default,
            } => Expression::Switch {
                expr: Box::new(expr.substitute_selected_measure(replacement)),
                cases: cases
                    .iter()
                    .map(|(v, r)| {
                        (
                            v.substitute_selected_measure(replacement),
                            r.substitute_selected_measure(replacement),
                        )
                    })
                    .collect(),
                default: default
                    .as_ref()
                    .map(|d| Box::new(d.substitute_selected_measure(replacement))),
            },
            Expression::Block { bindings, result } => Expression::Block {
                bindings: bindings
                    .iter()
                    .map(|(name, e)| (name.clone(), e.substitute_selected_measure(replacement)))
                    .collect(),
                result: Box::new(result.substitute_selected_measure(replacement)),
            },
            Expression::Query {
                aggregates,
                group_by,
            } => Expression::Query {
                aggregates: aggregates
                    .iter()
                    .map(|(e, alias)| (e.substitute_selected_measure(replacement), alias.clone()))
                    .collect(),
                group_by: group_by.clone(),
            },
            Expression::HasOneValue { column } => Expression::HasOneValue {
                column: Box::new(column.substitute_selected_measure(replacement)),
            },
            Expression::SelectedValue { column, alternate } => Expression::SelectedValue {
                column: Box::new(column.substitute_selected_measure(replacement)),
                alternate: alternate
                    .as_ref()
                    .map(|a| Box::new(a.substitute_selected_measure(replacement))),
            },
            Expression::FirstValue { column, order_by } => Expression::FirstValue {
                column: Box::new(column.substitute_selected_measure(replacement)),
                order_by: Box::new(order_by.substitute_selected_measure(replacement)),
            },
            Expression::Window {
                inner,
                function,
                order_by,
                partition_by,
                frame,
            } => Expression::Window {
                inner: Box::new(inner.substitute_selected_measure(replacement)),
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
                inner: Box::new(inner.substitute_selected_measure(replacement)),
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
                inner: Box::new(inner.substitute_selected_measure(replacement)),
                position: *position,
                order_by: order_by.clone(),
                partition_by: partition_by.clone(),
            },
            Expression::ToDate { expr, granularity } => Expression::ToDate {
                expr: Box::new(expr.substitute_selected_measure(replacement)),
                granularity: *granularity,
            },
            Expression::PeriodShift {
                expr,
                offset,
                granularity,
            } => Expression::PeriodShift {
                expr: Box::new(expr.substitute_selected_measure(replacement)),
                offset: *offset,
                granularity: *granularity,
            },
            Expression::DatesInPeriod {
                expr,
                intervals,
                granularity,
            } => Expression::DatesInPeriod {
                expr: Box::new(expr.substitute_selected_measure(replacement)),
                intervals: *intervals,
                granularity: *granularity,
            },
            Expression::SemiAdditiveBalance { expr, opening } => {
                Expression::SemiAdditiveBalance {
                    expr: Box::new(expr.substitute_selected_measure(replacement)),
                    opening: *opening,
                }
            }
            Expression::Keep {
                expr,
                filters,
                variables,
                conditions,
                in_predicates,
            } => Expression::Keep {
                expr: Box::new(expr.substitute_selected_measure(replacement)),
                filters: filters.clone(),
                variables: variables.clone(),
                conditions: conditions
                    .iter()
                    .map(|c| c.substitute_selected_measure(replacement))
                    .collect(),
                in_predicates: in_predicates.clone(),
            },
            Expression::Clear { expr, targets } => Expression::Clear {
                expr: Box::new(expr.substitute_selected_measure(replacement)),
                targets: targets.clone(),
            },
            Expression::Reset { expr } => Expression::Reset {
                expr: Box::new(expr.substitute_selected_measure(replacement)),
            },
            Expression::ClearInner { expr, targets } => Expression::ClearInner {
                expr: Box::new(expr.substitute_selected_measure(replacement)),
                targets: targets.clone(),
            },
            Expression::ClearOuter { expr, targets } => Expression::ClearOuter {
                expr: Box::new(expr.substitute_selected_measure(replacement)),
                targets: targets.clone(),
            },
            Expression::ResetInner { expr } => Expression::ResetInner {
                expr: Box::new(expr.substitute_selected_measure(replacement)),
            },
            Expression::ResetOuter { expr } => Expression::ResetOuter {
                expr: Box::new(expr.substitute_selected_measure(replacement)),
            },
            Expression::Traverse { expr, path } => Expression::Traverse {
                expr: Box::new(expr.substitute_selected_measure(replacement)),
                path: path.clone(),
            },
            Expression::Using { expr, context_name } => Expression::Using {
                expr: Box::new(expr.substitute_selected_measure(replacement)),
                context_name: context_name.clone(),
            },
            Expression::UseRelationship {
                expr,
                relationship_name,
            } => Expression::UseRelationship {
                expr: Box::new(expr.substitute_selected_measure(replacement)),
                relationship_name: relationship_name.clone(),
            },
            Expression::KeepIn { expr, predicates } => Expression::KeepIn {
                expr: Box::new(expr.substitute_selected_measure(replacement)),
                predicates: predicates.clone(),
            },
            Expression::InList { expr, values } => Expression::InList {
                expr: Box::new(expr.substitute_selected_measure(replacement)),
                values: values
                    .iter()
                    .map(|v| v.substitute_selected_measure(replacement))
                    .collect(),
            },
            Expression::Greatest(args) => Expression::Greatest(
                args.iter()
                    .map(|a| a.substitute_selected_measure(replacement))
                    .collect(),
            ),
            Expression::Least(args) => Expression::Least(
                args.iter()
                    .map(|a| a.substitute_selected_measure(replacement))
                    .collect(),
            ),
            Expression::NullIf { expr, value } => Expression::NullIf {
                expr: Box::new(expr.substitute_selected_measure(replacement)),
                value: Box::new(value.substitute_selected_measure(replacement)),
            },
            Expression::CountIf { condition } => Expression::CountIf {
                condition: Box::new(condition.substitute_selected_measure(replacement)),
            },
            Expression::ListAgg { column, delimiter } => Expression::ListAgg {
                column: Box::new(column.substitute_selected_measure(replacement)),
                delimiter: Box::new(delimiter.substitute_selected_measure(replacement)),
            },
            Expression::MaxBy { value, sort_by } => Expression::MaxBy {
                value: Box::new(value.substitute_selected_measure(replacement)),
                sort_by: Box::new(sort_by.substitute_selected_measure(replacement)),
            },
            Expression::MinBy { value, sort_by } => Expression::MinBy {
                value: Box::new(value.substitute_selected_measure(replacement)),
                sort_by: Box::new(sort_by.substitute_selected_measure(replacement)),
            },
            Expression::Call { name, args } => Expression::Call {
                name: name.clone(),
                args: args
                    .iter()
                    .map(|a| a.substitute_selected_measure(replacement))
                    .collect(),
            },
            // Leaf expressions with no SelectedMeasure node — return as-is.
            Expression::ColumnRef(_)
            | Expression::QualifiedColumnRef { .. }
            | Expression::TableRef(_)
            | Expression::MeasureRef(_)
            | Expression::LiteralFloat(_)
            | Expression::LiteralInt(_)
            | Expression::LiteralString(_)
            | Expression::LiteralBool(_)
            | Expression::Blank
            | Expression::IsInScope { .. }
            | Expression::RankWindow { .. } => self.clone(),
        }
    }

    /// Inline all VAR bindings into the result expression of a Block,
    /// returning the fully expanded expression. Non-Block expressions
    /// are returned unchanged.
    ///
    /// Query bindings are skipped — they produce tables that must be
    /// materialized, not inlined as scalar expressions.
    pub fn inline_bindings(&self) -> Expression {
        match self {
            Expression::Block { bindings, result } => {
                let mut env = std::collections::HashMap::new();
                for (name, binding_expr) in bindings {
                    // Skip Query/Window/Offset/Index bindings (and the
                    // time-intelligence sugar that lowers to them) — they
                    // produce tables, not scalars.
                    if matches!(
                        binding_expr,
                        Expression::Query { .. }
                            | Expression::Window { .. }
                            | Expression::Offset { .. }
                            | Expression::Index { .. }
                            | Expression::ToDate { .. }
                            | Expression::PeriodShift { .. }
                            | Expression::DatesInPeriod { .. }
                            | Expression::SemiAdditiveBalance { .. }
                    ) {
                        continue;
                    }
                    let resolved = binding_expr.substitute_vars(&env);
                    env.insert(name.clone(), resolved);
                }
                result.substitute_vars(&env)
            }
            _ => self.clone(),
        }
    }
}

/// Resolve `IsInScope` nodes by replacing them with `LiteralBool` based on
/// whether the referenced column is in the provided group-by list.
pub fn resolve_is_in_scope(expr: &Expression, group_by: &[(String, String)]) -> Expression {
    match expr {
        Expression::IsInScope { table, column } => {
            let in_scope = group_by.iter().any(|(t, c)| t == table && c == column);
            Expression::LiteralBool(in_scope)
        }
        Expression::BinaryOp { left, op, right } => Expression::BinaryOp {
            left: Box::new(resolve_is_in_scope(left, group_by)),
            op: *op,
            right: Box::new(resolve_is_in_scope(right, group_by)),
        },
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => Expression::If {
            condition: Box::new(resolve_is_in_scope(condition, group_by)),
            then_expr: Box::new(resolve_is_in_scope(then_expr, group_by)),
            else_expr: Box::new(resolve_is_in_scope(else_expr, group_by)),
        },
        Expression::Switch {
            expr: e,
            cases,
            default,
        } => Expression::Switch {
            expr: Box::new(resolve_is_in_scope(e, group_by)),
            cases: cases
                .iter()
                .map(|(v, r)| {
                    (
                        resolve_is_in_scope(v, group_by),
                        resolve_is_in_scope(r, group_by),
                    )
                })
                .collect(),
            default: default
                .as_ref()
                .map(|d| Box::new(resolve_is_in_scope(d, group_by))),
        },
        Expression::And(l, r) => Expression::And(
            Box::new(resolve_is_in_scope(l, group_by)),
            Box::new(resolve_is_in_scope(r, group_by)),
        ),
        Expression::Or(l, r) => Expression::Or(
            Box::new(resolve_is_in_scope(l, group_by)),
            Box::new(resolve_is_in_scope(r, group_by)),
        ),
        Expression::Not(inner) => Expression::Not(Box::new(resolve_is_in_scope(inner, group_by))),
        Expression::Call { name, args } => Expression::Call {
            name: name.clone(),
            args: args
                .iter()
                .map(|a| resolve_is_in_scope(a, group_by))
                .collect(),
        },
        // All other nodes: return as-is (IsInScope is typically only in conditions)
        _ => expr.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Block / VAR inline substitution tests ---

    #[test]
    fn block_inline_simple() {
        // VAR total = SUM(amount) RETURN total * 2
        let expr = block(
            vec![("total".into(), agg(AggregateOp::Sum, col("amount")))],
            col("total").multiply(lit_int(2)),
        );
        let sql = expr.to_sql_string().unwrap();
        assert_eq!(sql, "(SUM(\"amount\") * 2)");
    }

    #[test]
    fn block_inline_chained() {
        // VAR a = SUM(x) VAR b = a * 2 RETURN b + 1
        let expr = block(
            vec![
                ("a".into(), agg(AggregateOp::Sum, col("x"))),
                ("b".into(), col("a").multiply(lit_int(2))),
            ],
            col("b").add(lit_int(1)),
        );
        let sql = expr.to_sql_string().unwrap();
        assert_eq!(sql, "((SUM(\"x\") * 2) + 1)");
    }

    #[test]
    fn block_inline_with_divide() {
        // VAR rev = SUM(amount) VAR cnt = COUNT(id) RETURN DIVIDE(rev, cnt)
        let expr = block(
            vec![
                ("rev".into(), agg(AggregateOp::Sum, col("amount"))),
                ("cnt".into(), agg(AggregateOp::Count, col("id"))),
            ],
            safe_divide(col("rev"), col("cnt"), None),
        );
        let sql = expr.to_sql_string().unwrap();
        assert_eq!(
            sql,
            "CASE WHEN COUNT(\"id\") = 0 THEN NULL ELSE (CAST(SUM(\"amount\") AS DOUBLE) / COUNT(\"id\")) END"
        );
    }

    #[test]
    fn block_inline_preserves_non_var_columns() {
        // VAR total = SUM(amount) RETURN total / real_column
        let expr = block(
            vec![("total".into(), agg(AggregateOp::Sum, col("amount")))],
            col("total").divide(col("real_column")),
        );
        let sql = expr.to_sql_string().unwrap();
        // "total" substituted, "real_column" preserved as column ref
        assert_eq!(sql, "(SUM(\"amount\") / \"real_column\")");
    }

    #[test]
    fn block_inline_substitutes_vars_inside_call_args() {
        // VAR total = SUM(amount) RETURN myfunc(total, 2)
        let expr = block(
            vec![("total".into(), agg(AggregateOp::Sum, col("amount")))],
            call("myfunc", vec![col("total"), lit_int(2)]),
        );
        let sql = expr.to_sql_string().unwrap();
        assert_eq!(sql, "myfunc(SUM(\"amount\"), 2)");
    }

    #[test]
    fn block_inline_case_when() {
        // VAR total = SUM(amount) RETURN total * 2
        let expr = block(
            vec![("total".into(), agg(AggregateOp::Sum, col("amount")))],
            col("total").multiply(lit_int(2)),
        );
        let sql = expr.to_case_when_sql("f.\"region\" = 'US'", "f").unwrap();
        // CASE WHEN should be applied to the aggregate inside the inlined expression.
        assert!(sql.contains("SUM(CASE WHEN"));
        assert!(sql.contains("* 2"));
    }
}
