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
            Expression::IsFiltered { table, column } => Expression::IsFiltered {
                table: table.clone(),
                column: column.clone(),
            },
            Expression::ThisRow { table, column } => Expression::ThisRow {
                table: table.clone(),
                column: column.clone(),
            },
            Expression::LookupValue {
                table,
                result_column,
                search,
            } => Expression::LookupValue {
                table: table.clone(),
                result_column: result_column.clone(),
                search: search
                    .iter()
                    .map(|(c, e)| (c.clone(), e.substitute_vars(env)))
                    .collect(),
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
            Expression::Block {
                bindings,
                query_scoped_bindings,
                result,
            } => {
                // Recursively inline inner blocks too. GVAR (query-scoped)
                // bindings are normally resolved to literals at the facade
                // before this runs; carry them through here — substituting the
                // incoming env and shadowing it with each binding in turn — so a
                // generic substitution pass never silently drops them. GVAR
                // names precede VAR names in scope (a VAR may reference a GVAR).
                let mut inner_env = env.clone();
                let mut new_query_scoped = Vec::new();
                for (name, binding_expr) in query_scoped_bindings {
                    let resolved = binding_expr.substitute_vars(&inner_env);
                    inner_env.insert(name.clone(), resolved.clone());
                    new_query_scoped.push((name.clone(), resolved));
                }
                let mut new_bindings = Vec::new();
                for (name, binding_expr) in bindings {
                    let resolved = binding_expr.substitute_vars(&inner_env);
                    inner_env.insert(name.clone(), resolved.clone());
                    new_bindings.push((name.clone(), resolved));
                }
                Expression::Block {
                    bindings: new_bindings,
                    query_scoped_bindings: new_query_scoped,
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
            Expression::DatesBetween { expr, start, end } => Expression::DatesBetween {
                expr: Box::new(expr.substitute_vars(env)),
                start: start.clone(),
                end: end.clone(),
            },
            Expression::SemiAdditiveBalance { expr, opening } => Expression::SemiAdditiveBalance {
                expr: Box::new(expr.substitute_vars(env)),
                opening: *opening,
            },
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

    /// Replace every [`Expression::MeasureRef`] node whose name is a key in
    /// `env` with the bound replacement expression, returning the rewritten
    /// clone. Measure references not present in `env` are left unchanged.
    ///
    /// This powers context-driven calculated columns: a measure reference such
    /// as `[AsOfDate]` is resolved to a single scalar per query and substituted
    /// here as a literal, after which the column is an ordinary row-level
    /// expression that can be rendered into a `GROUP BY` key.
    ///
    /// Recursion deliberately covers only the **row-level** node set (the
    /// nodes a valid context column may contain). It does **not** descend into
    /// aggregate, window, or context-operation nodes — a context column is
    /// validated to contain none of those outside a `MeasureRef`, and this same
    /// property makes the function a validation primitive: substituting every
    /// measure reference with a placeholder and then checking
    /// [`Expression::has_aggregate`]/[`Expression::has_context_ops`] rejects a
    /// bare aggregate (e.g. `SUM([m])`) because the surviving `Aggregate` node
    /// is never entered. If a `MeasureRef` ever survives substitution (an
    /// unexpected node held one), SQL rendering fails closed rather than
    /// producing a wrong value.
    pub fn substitute_measure_refs(
        &self,
        env: &std::collections::HashMap<String, Expression>,
    ) -> Expression {
        match self {
            Expression::MeasureRef(name) => env.get(name).cloned().unwrap_or_else(|| self.clone()),
            Expression::BinaryOp { left, op, right } => Expression::BinaryOp {
                left: Box::new(left.substitute_measure_refs(env)),
                op: *op,
                right: Box::new(right.substitute_measure_refs(env)),
            },
            Expression::ScalarFunc { function, args } => Expression::ScalarFunc {
                function: *function,
                args: args
                    .iter()
                    .map(|a| a.substitute_measure_refs(env))
                    .collect(),
            },
            Expression::TextFunc { function, args } => Expression::TextFunc {
                function: *function,
                args: args
                    .iter()
                    .map(|a| a.substitute_measure_refs(env))
                    .collect(),
            },
            Expression::DateTimeFunc { function, args } => Expression::DateTimeFunc {
                function: *function,
                args: args
                    .iter()
                    .map(|a| a.substitute_measure_refs(env))
                    .collect(),
            },
            Expression::Comparison { left, op, right } => Expression::Comparison {
                left: Box::new(left.substitute_measure_refs(env)),
                op: *op,
                right: Box::new(right.substitute_measure_refs(env)),
            },
            Expression::And(left, right) => Expression::And(
                Box::new(left.substitute_measure_refs(env)),
                Box::new(right.substitute_measure_refs(env)),
            ),
            Expression::Or(left, right) => Expression::Or(
                Box::new(left.substitute_measure_refs(env)),
                Box::new(right.substitute_measure_refs(env)),
            ),
            Expression::Xor(left, right) => Expression::Xor(
                Box::new(left.substitute_measure_refs(env)),
                Box::new(right.substitute_measure_refs(env)),
            ),
            Expression::Not(inner) => Expression::Not(Box::new(inner.substitute_measure_refs(env))),
            Expression::IsBlank(inner) => {
                Expression::IsBlank(Box::new(inner.substitute_measure_refs(env)))
            }
            Expression::If {
                condition,
                then_expr,
                else_expr,
            } => Expression::If {
                condition: Box::new(condition.substitute_measure_refs(env)),
                then_expr: Box::new(then_expr.substitute_measure_refs(env)),
                else_expr: Box::new(else_expr.substitute_measure_refs(env)),
            },
            Expression::Switch {
                expr,
                cases,
                default,
            } => Expression::Switch {
                expr: Box::new(expr.substitute_measure_refs(env)),
                cases: cases
                    .iter()
                    .map(|(v, r)| {
                        (
                            v.substitute_measure_refs(env),
                            r.substitute_measure_refs(env),
                        )
                    })
                    .collect(),
                default: default
                    .as_ref()
                    .map(|d| Box::new(d.substitute_measure_refs(env))),
            },
            Expression::Coalesce(exprs) => Expression::Coalesce(
                exprs
                    .iter()
                    .map(|e| e.substitute_measure_refs(env))
                    .collect(),
            ),
            Expression::NullIf { expr, value } => Expression::NullIf {
                expr: Box::new(expr.substitute_measure_refs(env)),
                value: Box::new(value.substitute_measure_refs(env)),
            },
            Expression::Greatest(args) => Expression::Greatest(
                args.iter()
                    .map(|a| a.substitute_measure_refs(env))
                    .collect(),
            ),
            Expression::Least(args) => Expression::Least(
                args.iter()
                    .map(|a| a.substitute_measure_refs(env))
                    .collect(),
            ),
            Expression::IfError { expr, alternate } => Expression::IfError {
                expr: Box::new(expr.substitute_measure_refs(env)),
                alternate: Box::new(alternate.substitute_measure_refs(env)),
            },
            Expression::InList { expr, values } => Expression::InList {
                expr: Box::new(expr.substitute_measure_refs(env)),
                values: values
                    .iter()
                    .map(|v| v.substitute_measure_refs(env))
                    .collect(),
            },
            Expression::SafeDivide {
                numerator,
                denominator,
                alternate,
            } => Expression::SafeDivide {
                numerator: Box::new(numerator.substitute_measure_refs(env)),
                denominator: Box::new(denominator.substitute_measure_refs(env)),
                alternate: alternate
                    .as_ref()
                    .map(|a| Box::new(a.substitute_measure_refs(env))),
            },
            Expression::Call { name, args } => Expression::Call {
                name: name.clone(),
                args: args
                    .iter()
                    .map(|a| a.substitute_measure_refs(env))
                    .collect(),
            },
            // Leaf nodes and any non-row-level node (aggregate / window /
            // context op): clone unchanged. A measure reference buried inside a
            // non-row-level node is intentionally NOT substituted — context
            // columns are validated to contain none of those, and a survivor
            // fails closed at SQL rendering.
            _ => self.clone(),
        }
    }

    /// Replace references to other context-driven calculated columns with their
    /// (already-resolved) expressions, returning the rewritten clone.
    ///
    /// A reference is a bare [`ColumnRef`](Expression::ColumnRef) whose name is
    /// a key in `env`, or a [`QualifiedColumnRef`](Expression::QualifiedColumnRef)
    /// **on `host`** whose column is a key in `env` (a qualified reference to a
    /// *different* table — a cross-table physical column that happens to share a
    /// name — is left alone). Keys in `env` are lowercased context-column names;
    /// they never collide with physical columns (validated at build), so a
    /// matching bare reference is unambiguously a context-column reference.
    ///
    /// This powers interdependent context columns: one column may reference
    /// another on the same table, and the dependency is inlined (in dependency
    /// order — the model build rejects cycles) before the scalar measures are
    /// resolved. Recursion mirrors [`substitute_measure_refs`](Self::substitute_measure_refs)
    /// over the row-level node set.
    pub fn substitute_context_column_refs(
        &self,
        host: &str,
        env: &std::collections::HashMap<String, Expression>,
    ) -> Expression {
        let sub = |e: &Expression| e.substitute_context_column_refs(host, env);
        match self {
            Expression::ColumnRef(name) => env
                .get(&name.to_lowercase())
                .cloned()
                .unwrap_or_else(|| self.clone()),
            Expression::QualifiedColumnRef {
                table_or_var,
                column,
            } if table_or_var.eq_ignore_ascii_case(host) => env
                .get(&column.to_lowercase())
                .cloned()
                .unwrap_or_else(|| self.clone()),
            Expression::BinaryOp { left, op, right } => Expression::BinaryOp {
                left: Box::new(sub(left)),
                op: *op,
                right: Box::new(sub(right)),
            },
            Expression::ScalarFunc { function, args } => Expression::ScalarFunc {
                function: *function,
                args: args.iter().map(sub).collect(),
            },
            Expression::TextFunc { function, args } => Expression::TextFunc {
                function: *function,
                args: args.iter().map(sub).collect(),
            },
            Expression::DateTimeFunc { function, args } => Expression::DateTimeFunc {
                function: *function,
                args: args.iter().map(sub).collect(),
            },
            Expression::Comparison { left, op, right } => Expression::Comparison {
                left: Box::new(sub(left)),
                op: *op,
                right: Box::new(sub(right)),
            },
            Expression::And(left, right) => {
                Expression::And(Box::new(sub(left)), Box::new(sub(right)))
            }
            Expression::Or(left, right) => {
                Expression::Or(Box::new(sub(left)), Box::new(sub(right)))
            }
            Expression::Xor(left, right) => {
                Expression::Xor(Box::new(sub(left)), Box::new(sub(right)))
            }
            Expression::Not(inner) => Expression::Not(Box::new(sub(inner))),
            Expression::IsBlank(inner) => Expression::IsBlank(Box::new(sub(inner))),
            Expression::If {
                condition,
                then_expr,
                else_expr,
            } => Expression::If {
                condition: Box::new(sub(condition)),
                then_expr: Box::new(sub(then_expr)),
                else_expr: Box::new(sub(else_expr)),
            },
            Expression::Switch {
                expr,
                cases,
                default,
            } => Expression::Switch {
                expr: Box::new(sub(expr)),
                cases: cases.iter().map(|(v, r)| (sub(v), sub(r))).collect(),
                default: default.as_ref().map(|d| Box::new(sub(d))),
            },
            Expression::Coalesce(exprs) => Expression::Coalesce(exprs.iter().map(sub).collect()),
            Expression::NullIf { expr, value } => Expression::NullIf {
                expr: Box::new(sub(expr)),
                value: Box::new(sub(value)),
            },
            Expression::Greatest(args) => Expression::Greatest(args.iter().map(sub).collect()),
            Expression::Least(args) => Expression::Least(args.iter().map(sub).collect()),
            Expression::IfError { expr, alternate } => Expression::IfError {
                expr: Box::new(sub(expr)),
                alternate: Box::new(sub(alternate)),
            },
            Expression::InList { expr, values } => Expression::InList {
                expr: Box::new(sub(expr)),
                values: values.iter().map(sub).collect(),
            },
            Expression::SafeDivide {
                numerator,
                denominator,
                alternate,
            } => Expression::SafeDivide {
                numerator: Box::new(sub(numerator)),
                denominator: Box::new(sub(denominator)),
                alternate: alternate.as_ref().map(|a| Box::new(sub(a))),
            },
            Expression::Call { name, args } => Expression::Call {
                name: name.clone(),
                args: args.iter().map(sub).collect(),
            },
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
            Expression::Block {
                bindings,
                query_scoped_bindings,
                result,
            } => Expression::Block {
                bindings: bindings
                    .iter()
                    .map(|(name, e)| (name.clone(), e.substitute_selected_measure(replacement)))
                    .collect(),
                query_scoped_bindings: query_scoped_bindings
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
            Expression::DatesBetween { expr, start, end } => Expression::DatesBetween {
                expr: Box::new(expr.substitute_selected_measure(replacement)),
                start: start.clone(),
                end: end.clone(),
            },
            Expression::SemiAdditiveBalance { expr, opening } => Expression::SemiAdditiveBalance {
                expr: Box::new(expr.substitute_selected_measure(replacement)),
                opening: *opening,
            },
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
            | Expression::LiteralDate(_)
            | Expression::LiteralString(_)
            | Expression::LiteralBool(_)
            | Expression::Blank
            | Expression::IsInScope { .. }
            | Expression::IsFiltered { .. }
            | Expression::ThisRow { .. }
            | Expression::RankWindow { .. } => self.clone(),
            Expression::LookupValue {
                table,
                result_column,
                search,
            } => Expression::LookupValue {
                table: table.clone(),
                result_column: result_column.clone(),
                search: search
                    .iter()
                    .map(|(c, e)| (c.clone(), e.substitute_selected_measure(replacement)))
                    .collect(),
            },
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
            Expression::Block {
                bindings,
                query_scoped_bindings,
                result,
            } => {
                // Query-scoped (GVAR) bindings must have been resolved to
                // literals and emptied by the facade before rendering/inlining.
                // A survivor here would drop the GVAR values and leave their
                // references dangling (a wrong number) — the expand-site guards
                // (engine-query) and the MeasureEngine guard fail closed in
                // release; this documents the invariant in debug.
                debug_assert!(
                    query_scoped_bindings.is_empty(),
                    "inline_bindings reached a Block with unresolved query-scoped (GVAR) bindings"
                );
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
                            | Expression::DatesBetween { .. }
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
/// One `LOOKUPVALUE` extracted from a calculated-column expression: the join
/// the materializer must emit, with the node itself replaced by a qualified
/// reference to `alias[result_column]`.
#[derive(Debug, Clone)]
pub struct LookupJoinSpec {
    /// The synthetic join alias (`__lk0`, `__lk1`, ...).
    pub alias: String,
    /// The lookup target table (model name, original casing).
    pub table: String,
    /// The column returned from the matched row.
    pub result_column: String,
    /// `(search column on the target, match expression over the host row)`.
    pub search: Vec<(String, Expression)>,
}

/// Replace every `LOOKUPVALUE` node with a `QualifiedColumnRef` to a
/// synthetic join alias, returning the rewritten expression plus one
/// [`LookupJoinSpec`] per extracted node. The calculated-column materializer
/// LEFT JOINs each spec (against a per-key-deduplicated subquery) and renders
/// the rewritten expression, so the lookup value arrives as an ordinary
/// column. Calculated-column expressions are row-level (validation bans
/// aggregates/blocks/context ops), so only the row-level node set recurses;
/// a `LOOKUPVALUE` in an unreachable position is impossible post-validation.
pub fn extract_lookup_joins(expr: &Expression, specs: &mut Vec<LookupJoinSpec>) -> Expression {
    match expr {
        Expression::LookupValue {
            table,
            result_column,
            search,
        } => {
            let alias = format!("__lk{}", specs.len());
            let spec = LookupJoinSpec {
                alias: alias.clone(),
                table: table.clone(),
                result_column: result_column.clone(),
                // Search expressions cannot nest LOOKUPVALUE (validation).
                search: search.clone(),
            };
            specs.push(spec);
            Expression::QualifiedColumnRef {
                table_or_var: alias,
                column: result_column.clone(),
            }
        }
        Expression::BinaryOp { left, op, right } => Expression::BinaryOp {
            left: Box::new(extract_lookup_joins(left, specs)),
            op: *op,
            right: Box::new(extract_lookup_joins(right, specs)),
        },
        Expression::Comparison { left, op, right } => Expression::Comparison {
            left: Box::new(extract_lookup_joins(left, specs)),
            op: *op,
            right: Box::new(extract_lookup_joins(right, specs)),
        },
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => Expression::If {
            condition: Box::new(extract_lookup_joins(condition, specs)),
            then_expr: Box::new(extract_lookup_joins(then_expr, specs)),
            else_expr: Box::new(extract_lookup_joins(else_expr, specs)),
        },
        Expression::Switch {
            expr: e,
            cases,
            default,
        } => Expression::Switch {
            expr: Box::new(extract_lookup_joins(e, specs)),
            cases: cases
                .iter()
                .map(|(v, r)| {
                    (
                        extract_lookup_joins(v, specs),
                        extract_lookup_joins(r, specs),
                    )
                })
                .collect(),
            default: default
                .as_ref()
                .map(|d| Box::new(extract_lookup_joins(d, specs))),
        },
        Expression::And(l, r) => Expression::And(
            Box::new(extract_lookup_joins(l, specs)),
            Box::new(extract_lookup_joins(r, specs)),
        ),
        Expression::Or(l, r) => Expression::Or(
            Box::new(extract_lookup_joins(l, specs)),
            Box::new(extract_lookup_joins(r, specs)),
        ),
        Expression::Xor(l, r) => Expression::Xor(
            Box::new(extract_lookup_joins(l, specs)),
            Box::new(extract_lookup_joins(r, specs)),
        ),
        Expression::Not(inner) => Expression::Not(Box::new(extract_lookup_joins(inner, specs))),
        Expression::IsBlank(inner) => {
            Expression::IsBlank(Box::new(extract_lookup_joins(inner, specs)))
        }
        Expression::ScalarFunc { function, args } => Expression::ScalarFunc {
            function: *function,
            args: args.iter().map(|a| extract_lookup_joins(a, specs)).collect(),
        },
        Expression::TextFunc { function, args } => Expression::TextFunc {
            function: *function,
            args: args.iter().map(|a| extract_lookup_joins(a, specs)).collect(),
        },
        Expression::DateTimeFunc { function, args } => Expression::DateTimeFunc {
            function: *function,
            args: args.iter().map(|a| extract_lookup_joins(a, specs)).collect(),
        },
        Expression::Call { name, args } => Expression::Call {
            name: name.clone(),
            args: args.iter().map(|a| extract_lookup_joins(a, specs)).collect(),
        },
        Expression::Coalesce(args) => {
            Expression::Coalesce(args.iter().map(|a| extract_lookup_joins(a, specs)).collect())
        }
        Expression::IfError { expr: e, alternate } => Expression::IfError {
            expr: Box::new(extract_lookup_joins(e, specs)),
            alternate: Box::new(extract_lookup_joins(alternate, specs)),
        },
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => Expression::SafeDivide {
            numerator: Box::new(extract_lookup_joins(numerator, specs)),
            denominator: Box::new(extract_lookup_joins(denominator, specs)),
            alternate: alternate
                .as_ref()
                .map(|a| Box::new(extract_lookup_joins(a, specs))),
        },
        Expression::InList { expr: e, values } => Expression::InList {
            expr: Box::new(extract_lookup_joins(e, specs)),
            values: values.iter().map(|a| extract_lookup_joins(a, specs)).collect(),
        },
        Expression::Greatest(args) => {
            Expression::Greatest(args.iter().map(|a| extract_lookup_joins(a, specs)).collect())
        }
        Expression::Least(args) => Expression::Least(args.iter().map(|a| extract_lookup_joins(a, specs)).collect()),
        Expression::NullIf { expr: e, value } => Expression::NullIf {
            expr: Box::new(extract_lookup_joins(e, specs)),
            value: Box::new(extract_lookup_joins(value, specs)),
        },
        // Leaves and anything non-row-level (impossible post-validation).
        _ => expr.clone(),
    }
}

/// Replace every plain `AGG(ITERATE(host, ...))` node in a THISROW
/// calculated-column expression with a bare placeholder column reference
/// (`__tr_agg_N`), collecting the replaced aggregate nodes in order. The
/// materializer renders each collected node into the anchor/scan self-join
/// sub-select and the placeholder resolves to the joined result column.
/// Shape is builder-validated ([`validate_thisrow_calculated_column`]), so
/// every `Aggregate` node here is over `ITERATE`.
pub fn extract_thisrow_aggregates(
    expr: &Expression,
    aggregates: &mut Vec<Expression>,
) -> Expression {
    match expr {
        Expression::Aggregate { .. } => {
            let placeholder = format!("__tr_agg_{}", aggregates.len());
            aggregates.push(expr.clone());
            Expression::ColumnRef(placeholder)
        }
        Expression::BinaryOp { left, op, right } => Expression::BinaryOp {
            left: Box::new(extract_thisrow_aggregates(left, aggregates)),
            op: *op,
            right: Box::new(extract_thisrow_aggregates(right, aggregates)),
        },
        Expression::Comparison { left, op, right } => Expression::Comparison {
            left: Box::new(extract_thisrow_aggregates(left, aggregates)),
            op: *op,
            right: Box::new(extract_thisrow_aggregates(right, aggregates)),
        },
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => Expression::If {
            condition: Box::new(extract_thisrow_aggregates(condition, aggregates)),
            then_expr: Box::new(extract_thisrow_aggregates(then_expr, aggregates)),
            else_expr: Box::new(extract_thisrow_aggregates(else_expr, aggregates)),
        },
        Expression::Switch {
            expr: e,
            cases,
            default,
        } => Expression::Switch {
            expr: Box::new(extract_thisrow_aggregates(e, aggregates)),
            cases: cases
                .iter()
                .map(|(v, r)| {
                    (
                        extract_thisrow_aggregates(v, aggregates),
                        extract_thisrow_aggregates(r, aggregates),
                    )
                })
                .collect(),
            default: default
                .as_ref()
                .map(|d| Box::new(extract_thisrow_aggregates(d, aggregates))),
        },
        Expression::And(l, r) => Expression::And(
            Box::new(extract_thisrow_aggregates(l, aggregates)),
            Box::new(extract_thisrow_aggregates(r, aggregates)),
        ),
        Expression::Or(l, r) => Expression::Or(
            Box::new(extract_thisrow_aggregates(l, aggregates)),
            Box::new(extract_thisrow_aggregates(r, aggregates)),
        ),
        Expression::Xor(l, r) => Expression::Xor(
            Box::new(extract_thisrow_aggregates(l, aggregates)),
            Box::new(extract_thisrow_aggregates(r, aggregates)),
        ),
        Expression::Not(inner) => {
            Expression::Not(Box::new(extract_thisrow_aggregates(inner, aggregates)))
        }
        Expression::IsBlank(inner) => {
            Expression::IsBlank(Box::new(extract_thisrow_aggregates(inner, aggregates)))
        }
        Expression::ScalarFunc { function, args } => Expression::ScalarFunc {
            function: *function,
            args: args
                .iter()
                .map(|a| extract_thisrow_aggregates(a, aggregates))
                .collect(),
        },
        Expression::TextFunc { function, args } => Expression::TextFunc {
            function: *function,
            args: args
                .iter()
                .map(|a| extract_thisrow_aggregates(a, aggregates))
                .collect(),
        },
        Expression::DateTimeFunc { function, args } => Expression::DateTimeFunc {
            function: *function,
            args: args
                .iter()
                .map(|a| extract_thisrow_aggregates(a, aggregates))
                .collect(),
        },
        Expression::Call { name, args } => Expression::Call {
            name: name.clone(),
            args: args
                .iter()
                .map(|a| extract_thisrow_aggregates(a, aggregates))
                .collect(),
        },
        Expression::Coalesce(args) => Expression::Coalesce(
            args.iter()
                .map(|a| extract_thisrow_aggregates(a, aggregates))
                .collect(),
        ),
        Expression::IfError { expr: e, alternate } => Expression::IfError {
            expr: Box::new(extract_thisrow_aggregates(e, aggregates)),
            alternate: Box::new(extract_thisrow_aggregates(alternate, aggregates)),
        },
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => Expression::SafeDivide {
            numerator: Box::new(extract_thisrow_aggregates(numerator, aggregates)),
            denominator: Box::new(extract_thisrow_aggregates(denominator, aggregates)),
            alternate: alternate
                .as_ref()
                .map(|a| Box::new(extract_thisrow_aggregates(a, aggregates))),
        },
        Expression::InList { expr: e, values } => Expression::InList {
            expr: Box::new(extract_thisrow_aggregates(e, aggregates)),
            values: values
                .iter()
                .map(|a| extract_thisrow_aggregates(a, aggregates))
                .collect(),
        },
        Expression::Greatest(args) => Expression::Greatest(
            args.iter()
                .map(|a| extract_thisrow_aggregates(a, aggregates))
                .collect(),
        ),
        Expression::Least(args) => Expression::Least(
            args.iter()
                .map(|a| extract_thisrow_aggregates(a, aggregates))
                .collect(),
        ),
        Expression::NullIf { expr: e, value } => Expression::NullIf {
            expr: Box::new(extract_thisrow_aggregates(e, aggregates)),
            value: Box::new(extract_thisrow_aggregates(value, aggregates)),
        },
        // Leaves and anything non-row-level (impossible post-validation).
        _ => expr.clone(),
    }
}

/// Validate the THISROW calculated-column shape for a column on `host`:
///
/// - every aggregate is a PLAIN aggregate directly over `ITERATE(host, ...)`
///   (no windows, time intelligence, QUERY, or implicit aggregates);
/// - the iterated expression contains no nested aggregates or iterations;
/// - `THISROW(t[c])` appears ONLY inside such an `ITERATE`, with `t == host`.
///
/// Returns a human-readable reason on violation (the builder wraps it into
/// `EngineError::InvalidCalculatedColumn`).
pub fn validate_thisrow_calculated_column(expr: &Expression, host: &str) -> Result<(), String> {
    fn walk(expr: &Expression, host: &str, in_iterate: bool) -> Result<(), String> {
        match expr {
            Expression::Aggregate { operand, .. } => match operand.as_ref() {
                Expression::Iterate { table, expression } => {
                    if !table.eq_ignore_ascii_case(host) {
                        return Err(format!(
                            "ITERATE over '{table}' -- a THISROW calculated column may only \
                             iterate its host table '{host}'"
                        ));
                    }
                    if expression.has_aggregate() {
                        return Err(
                            "nested aggregates inside ITERATE are not supported in \
                             calculated columns"
                                .to_string(),
                        );
                    }
                    walk(expression, host, true)
                }
                _ => Err(
                    "aggregates in calculated columns are only supported as \
                     AGG(ITERATE(host, ...)) together with THISROW(...)"
                        .to_string(),
                ),
            },
            Expression::ThisRow { table, .. } => {
                if !in_iterate {
                    return Err(
                        "THISROW(...) is only valid inside an aggregate over ITERATE(...)"
                            .to_string(),
                    );
                }
                if !table.eq_ignore_ascii_case(host) {
                    return Err(format!(
                        "THISROW references '{table}' but the calculated column lives on \
                         '{host}'"
                    ));
                }
                Ok(())
            }
            // Implicit / two-stage aggregates stay rejected in calculated columns.
            Expression::Percentile { .. }
            | Expression::Query { .. }
            | Expression::HasOneValue { .. }
            | Expression::SelectedValue { .. }
            | Expression::FirstValue { .. }
            | Expression::Window { .. }
            | Expression::Offset { .. }
            | Expression::Index { .. }
            | Expression::ToDate { .. }
            | Expression::PeriodShift { .. }
            | Expression::DatesInPeriod { .. }
            | Expression::DatesBetween { .. }
            | Expression::SemiAdditiveBalance { .. }
            | Expression::CountIf { .. }
            | Expression::ListAgg { .. }
            | Expression::MaxBy { .. }
            | Expression::MinBy { .. }
            | Expression::RankWindow { .. } => Err(
                "only plain aggregates over ITERATE(...) are supported in THISROW \
                 calculated columns (no windows, time intelligence, or QUERY)"
                    .to_string(),
            ),
            Expression::Iterate { .. } => Err(
                "ITERATE(...) in a calculated column must be wrapped directly in an \
                 aggregate (e.g. COUNT(ITERATE(...)))"
                    .to_string(),
            ),
            _ => {
                for child in super::child_expressions(expr) {
                    walk(child, host, in_iterate)?;
                }
                Ok(())
            }
        }
    }
    walk(expr, host, false)
}

/// Replace every `ISFILTERED(table[column])` marker with the literal answer
/// for one query: TRUE when the column is DIRECTLY filtered — on the
/// group-by axis, or named by a query filter / IN slicer / OR slicer
/// (`filtered_columns` carries those column names; query filters are not
/// table-qualified, so the match is by column name). Applied at the query
/// facade before planning, GVAR-style, so every execution path (pushed and
/// local) sees only the resolved literal.
///
/// Recurses through conditional wrappers AND the common measure shapes
/// (blocks/VAR bindings, aggregates and their context-op wrappers, DIVIDE,
/// IFERROR, COALESCE, comparisons) — an `ISFILTERED` in a spot this walk
/// does not reach renders as FALSE (the renderer's defensive fallback).
pub fn resolve_is_filtered(
    expr: &Expression,
    group_by: &[(String, String)],
    filtered_columns: &[String],
) -> Expression {
    let recurse = |e: &Expression| resolve_is_filtered(e, group_by, filtered_columns);
    match expr {
        Expression::IsFiltered { table, column } => {
            let filtered = group_by.iter().any(|(t, c)| t == table && c == column)
                || filtered_columns.iter().any(|c| c == column);
            Expression::LiteralBool(filtered)
        }
        Expression::BinaryOp { left, op, right } => Expression::BinaryOp {
            left: Box::new(recurse(left)),
            op: *op,
            right: Box::new(recurse(right)),
        },
        Expression::Comparison { left, op, right } => Expression::Comparison {
            left: Box::new(recurse(left)),
            op: *op,
            right: Box::new(recurse(right)),
        },
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => Expression::If {
            condition: Box::new(recurse(condition)),
            then_expr: Box::new(recurse(then_expr)),
            else_expr: Box::new(recurse(else_expr)),
        },
        Expression::Switch {
            expr: e,
            cases,
            default,
        } => Expression::Switch {
            expr: Box::new(recurse(e)),
            cases: cases.iter().map(|(v, r)| (recurse(v), recurse(r))).collect(),
            default: default.as_ref().map(|d| Box::new(recurse(d))),
        },
        Expression::And(l, r) => Expression::And(Box::new(recurse(l)), Box::new(recurse(r))),
        Expression::Or(l, r) => Expression::Or(Box::new(recurse(l)), Box::new(recurse(r))),
        Expression::Xor(l, r) => Expression::Xor(Box::new(recurse(l)), Box::new(recurse(r))),
        Expression::Not(inner) => Expression::Not(Box::new(recurse(inner))),
        Expression::IsBlank(inner) => Expression::IsBlank(Box::new(recurse(inner))),
        Expression::Call { name, args } => Expression::Call {
            name: name.clone(),
            args: args.iter().map(recurse).collect(),
        },
        Expression::Aggregate { operation, operand } => Expression::Aggregate {
            operation: *operation,
            operand: Box::new(recurse(operand)),
        },
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => Expression::SafeDivide {
            numerator: Box::new(recurse(numerator)),
            denominator: Box::new(recurse(denominator)),
            alternate: alternate.as_ref().map(|a| Box::new(recurse(a))),
        },
        Expression::IfError { expr: e, alternate } => Expression::IfError {
            expr: Box::new(recurse(e)),
            alternate: Box::new(recurse(alternate)),
        },
        Expression::Coalesce(args) => Expression::Coalesce(args.iter().map(recurse).collect()),
        Expression::Block {
            bindings,
            query_scoped_bindings,
            result,
        } => Expression::Block {
            bindings: bindings
                .iter()
                .map(|(n, e)| (n.clone(), recurse(e)))
                .collect(),
            query_scoped_bindings: query_scoped_bindings
                .iter()
                .map(|(n, e)| (n.clone(), recurse(e)))
                .collect(),
            result: Box::new(recurse(result)),
        },
        Expression::Keep {
            expr: e,
            filters,
            variables,
            conditions,
        in_predicates,
        } => Expression::Keep {
            expr: Box::new(recurse(e)),
            filters: filters.clone(),
            variables: variables.clone(),
            conditions: conditions.iter().map(recurse).collect(),
            in_predicates: in_predicates.clone(),
        },
        Expression::Clear { expr: e, targets } => Expression::Clear {
            expr: Box::new(recurse(e)),
            targets: targets.clone(),
        },
        Expression::ClearInner { expr: e, targets } => Expression::ClearInner {
            expr: Box::new(recurse(e)),
            targets: targets.clone(),
        },
        Expression::ClearOuter { expr: e, targets } => Expression::ClearOuter {
            expr: Box::new(recurse(e)),
            targets: targets.clone(),
        },
        Expression::Reset { expr: e } => Expression::Reset {
            expr: Box::new(recurse(e)),
        },
        Expression::ResetInner { expr: e } => Expression::ResetInner {
            expr: Box::new(recurse(e)),
        },
        Expression::ResetOuter { expr: e } => Expression::ResetOuter {
            expr: Box::new(recurse(e)),
        },
        // Everything else (literals, column/measure refs, windows, time
        // intelligence, ...) — returned as-is; ISFILTERED inside those is out
        // of the v1 contract.
        _ => expr.clone(),
    }
}

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

    // --- substitute_measure_refs (context-driven calculated columns) ---

    #[test]
    fn substitute_measure_refs_recurses_into_safe_divide_and_call() {
        // A MeasureRef buried in a SafeDivide and in a Call must be substituted,
        // not left to survive (which would fail closed at rendering).
        let mut env = std::collections::HashMap::new();
        env.insert("Threshold".to_string(), lit(0.5));
        let expr = if_expr(
            compare(
                safe_divide(col("paid"), col("total"), None),
                ComparisonOp::GreaterThanOrEqual,
                Expression::MeasureRef("Threshold".into()),
            ),
            call("classify", vec![Expression::MeasureRef("Threshold".into())]),
            lit_str("Low"),
        );
        // Before: the SafeDivide-side and Call-side references are present.
        assert_eq!(expr.measure_references(), vec!["Threshold"]);
        // After substitution: no MeasureRef survives anywhere in the tree.
        let out = expr.substitute_measure_refs(&env);
        assert!(out.measure_references().is_empty());
    }

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
