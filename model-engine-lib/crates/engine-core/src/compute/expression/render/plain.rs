//! Plain-mode rendering: the full Expression dispatch shared by every
//! SQL-generating entry point.

use crate::compute::aggregate::AggregateOp;
use crate::compute::dax_semantics;
use crate::compute::expression::{Expression, FilterPredicate, ScalarFunction};
use crate::compute::sql_util::{quote_ident_double, sql_quote_literal};
use crate::error::{EngineError, EngineResult};

use super::dialect::udf_call_unsupported;
use super::{Dialect, KeepRendering, Semantics, SqlRenderer};

impl<D: Dialect> SqlRenderer<'_, D> {
    pub(super) fn render_plain(&self, expr: &Expression) -> EngineResult<String> {
        Ok(match expr {
            Expression::ColumnRef(name) => self.qualifier.column(None, name)?,
            Expression::QualifiedColumnRef {
                table_or_var,
                column,
            } => self.qualifier.column(Some(table_or_var), column)?,
            Expression::TableRef(name) => {
                return Err(EngineError::InvalidExpression(format!(
                    "Table reference '{name}' cannot be rendered as scalar SQL; table \
                     references are only valid where the surrounding construct consumes \
                     them before rendering (e.g. COUNTROWS(table), context operations)"
                )));
            }
            Expression::MeasureRef(name) => {
                return Err(EngineError::InvalidExpression(format!(
                    "Measure reference '[{name}]' must be expanded to its underlying \
                     expression before SQL generation"
                )));
            }
            Expression::SelectedMeasure => {
                return Err(EngineError::InvalidExpression(
                    "SELECTEDMEASURE() must be substituted with the applied measure's \
                     expression before SQL generation; an unsubstituted SELECTEDMEASURE() \
                     node reached the renderer (internal error)"
                        .to_string(),
                ));
            }
            Expression::IsSelectedMeasure { .. }
            | Expression::SelectedMeasureName
            | Expression::SelectedMeasureFormatString => {
                return Err(EngineError::InvalidExpression(
                    "calc-group introspection (ISSELECTEDMEASURE / SELECTEDMEASURENAME / \
                     SELECTEDMEASUREFORMATSTRING) must be folded away when the calculation \
                     group is applied; an unsubstituted node reached the renderer \
                     (internal error)"
                        .to_string(),
                ));
            }
            // A DAX division by zero folds to +/-Infinity or NaN (a GVAR
            // `a / 0`), which `{v}` would spell as a bare `inf` identifier.
            Expression::LiteralFloat(v) if !v.is_finite() => self.dialect.non_finite_float(*v),
            Expression::LiteralFloat(v) => format!("{v}"),
            Expression::LiteralInt(v) => format!("{v}"),
            // Date32 day count → a date-typed literal. The spelling is
            // dialect-specific: DataFusion reinterprets an integer cast as
            // days-since-epoch, but PostgreSQL needs an explicit `DATE '…'`.
            Expression::LiteralDate(days) => self.dialect.date_literal(*days)?,
            Expression::LiteralBool(b) => {
                if *b {
                    "TRUE".to_string()
                } else {
                    "FALSE".to_string()
                }
            }
            Expression::LiteralString(s) => sql_quote_literal(s),
            Expression::Blank => "NULL".to_string(),
            // DAX BLANK arithmetic (`BLANK + 5 = 5`, `x / 0 = Infinity`, ...):
            // see `compute::dax_semantics`.
            Expression::BinaryOp { .. } => {
                self.render_arithmetic(expr, &mut |e| self.render_plain(e))?
            }
            // A DAX count of nothing is BLANK (`NULLIF(count, 0)`); DAX's
            // DISTINCTCOUNT counts BLANK as a value.
            Expression::Aggregate { operation, operand } => {
                self.render_aggregate_node(operation, operand)?
            }
            Expression::Keep { .. } => self.render_keep(expr)?,
            // In KEEP-as-CASE-WHEN mode (source pushdown) these context
            // operations cannot travel with the SQL: rendering the inner
            // expression would silently drop the CLEAR / RESET / ... The
            // pushdown planner keeps such measures local
            // (`has_unpushable_ops`); the connector renders a CLEAR it can
            // reach as a window before delegating here. Fail closed.
            Expression::Clear { .. }
            | Expression::Reset { .. }
            | Expression::ClearInner { .. }
            | Expression::ClearOuter { .. }
            | Expression::ResetInner { .. }
            | Expression::ResetOuter { .. }
            | Expression::Traverse { .. }
            | Expression::Using { .. }
            | Expression::UseRelationship { .. }
            | Expression::KeepIn { .. }
            | Expression::ClearExcept { .. }
                if self.keep == KeepRendering::CaseWhen =>
            {
                return Err(EngineError::InvalidExpression(format!(
                    "a context operation cannot be rendered inside source SQL here (it would be \
                     silently dropped); the measure must be evaluated locally: {expr:?}"
                )));
            }
            // Context manipulation nodes render as their inner expression's
            // SQL. Context operations are resolved by the ContextResolver
            // before local SQL generation.
            Expression::Clear { expr, .. }
            | Expression::Reset { expr, .. }
            | Expression::ClearInner { expr, .. }
            | Expression::ClearOuter { expr, .. }
            | Expression::ResetInner { expr }
            | Expression::ResetOuter { expr, .. }
            | Expression::Traverse { expr, .. }
            | Expression::Using { expr, .. }
            | Expression::UseRelationship { expr, .. }
            | Expression::KeepIn { expr, .. }
            | Expression::ClearExcept { expr, .. } => self.render_plain(expr)?,
            Expression::Iterate { expression, .. } => self.render_plain(expression)?,
            Expression::Block {
                query_scoped_bindings,
                ..
            } => {
                // Query-scoped (GVAR) bindings must be resolved to literals at
                // the Engine facade before rendering; a survivor here would be
                // silently dropped by inline_bindings, leaving a dangling column
                // reference. Fail closed (as with an unexpanded MeasureRef).
                if !query_scoped_bindings.is_empty() {
                    return Err(EngineError::InvalidExpression(
                        "internal: a query-scoped (GVAR) binding reached SQL rendering \
                         unresolved (it must be resolved at the Engine facade)"
                            .to_string(),
                    ));
                }
                self.render_plain(&expr.inline_bindings())?
            }
            Expression::IsBlank(inner) => {
                format!("({} IS NULL)", self.render_plain(inner)?)
            }
            Expression::Comparison { left, op, right } => {
                let (mut l, mut r) = (self.render_plain(left)?, self.render_plain(right)?);
                // DAX compares a BLANK as 0 / "" / FALSE against a literal of
                // that type (`COUNTROWS(t) = 0` is TRUE over an empty table).
                if self.semantics == Semantics::Dax {
                    l = dax_semantics::comparison_operand_in(l, left, right, self.column_classes());
                    r = dax_semantics::comparison_operand_in(r, right, left, self.column_classes());
                }
                format!("({l} {} {r})", op.as_sql())
            }
            Expression::And(left, right) => {
                format!(
                    "({} AND {})",
                    self.render_plain(left)?,
                    self.render_plain(right)?
                )
            }
            Expression::Or(left, right) => {
                format!(
                    "({} OR {})",
                    self.render_plain(left)?,
                    self.render_plain(right)?
                )
            }
            Expression::Not(inner) => {
                format!("(NOT {})", self.render_plain(inner)?)
            }
            Expression::Xor(left, right) => {
                let l = self.render_plain(left)?;
                let r = self.render_plain(right)?;
                format!("(({l} AND NOT {r}) OR (NOT {l} AND {r}))")
            }
            Expression::If {
                condition,
                then_expr,
                else_expr,
            } => {
                format!(
                    "CASE WHEN {} THEN {} ELSE {} END",
                    self.case_cond_of(condition, &self.render_plain(condition)?),
                    self.render_plain(then_expr)?,
                    self.render_plain(else_expr)?
                )
            }
            Expression::Switch {
                expr,
                cases,
                default,
            } => {
                // SWITCH matches with STRICT equality: BLANK matches only
                // BLANK, never 0 ([LIVE]; `dax_semantics::switch_sql`).
                let subject = self.render_plain(expr)?;
                let rendered = cases
                    .iter()
                    .map(|(val, result)| {
                        Ok((
                            self.render_plain(val)?,
                            self.switch_value_may_be_blank(val),
                            self.render_plain(result)?,
                        ))
                    })
                    .collect::<EngineResult<Vec<_>>>()?;
                let default = default.as_ref().map(|d| self.render_plain(d)).transpose()?;
                dax_semantics::switch_sql(&subject, &rendered, default.as_deref())
            }
            Expression::SafeDivide {
                numerator,
                denominator,
                alternate,
            } => {
                let n = self.render_plain(numerator)?;
                let d = self.render_plain(denominator)?;
                let alt = match alternate {
                    Some(a) => self.render_plain(a)?,
                    None => "NULL".to_string(),
                };
                self.dialect.safe_divide(&n, &d, &alt)?
            }
            Expression::Coalesce(exprs) => {
                let args = exprs
                    .iter()
                    .map(|e| self.render_plain(e))
                    .collect::<EngineResult<Vec<String>>>()?;
                format!("COALESCE({})", args.join(", "))
            }
            Expression::ScalarFunc { function, args } => {
                let mapped = args
                    .iter()
                    .map(|a| self.render_plain(a))
                    .collect::<EngineResult<Vec<String>>>()?;
                self.render_scalar_func(function, &mapped)?
            }
            Expression::TextFunc { function, args } => {
                let mapped = args
                    .iter()
                    .map(|a| self.render_plain(a))
                    .collect::<EngineResult<Vec<String>>>()?;
                function.to_sql_strs(&mapped)
            }
            Expression::DateTimeFunc { function, args } => {
                let mapped = args
                    .iter()
                    .map(|a| self.render_plain(a))
                    .collect::<EngineResult<Vec<String>>>()?;
                function.to_sql_strs(&mapped)
            }
            Expression::IfError { expr, alternate } => {
                format!(
                    "COALESCE({}, {})",
                    self.render_plain(expr)?,
                    self.render_plain(alternate)?
                )
            }
            // Should be resolved before SQL generation. Default to TRUE.
            Expression::IsInScope { .. } => "TRUE".to_string(),
            // Defensive fallback: the facade folds ISFILTERED to a literal
            // before planning; an unresolved marker means "no direct filter".
            Expression::IsFiltered { .. } => "FALSE".to_string(),
            // Anchor-row reference: valid only when the THISROW
            // materialization configured an anchor alias — fail closed
            // everywhere else (measures, pushdown, lookup resolution).
            Expression::ThisRow { column, .. } => match &self.thisrow_alias {
                Some(alias) => format!("{}.{}", alias, quote_ident_double(column)),
                None => {
                    return Err(EngineError::InvalidExpression(
                        "THISROW(...) is only valid inside an aggregate over                          ITERATE(...) in a calculated column"
                            .to_string(),
                    ))
                }
            },
            // LOOKUPVALUE is rewritten to a join during calculated-column
            // materialization; one reaching a renderer is a misuse.
            Expression::LookupValue { .. } => {
                return Err(EngineError::InvalidExpression(
                    "LOOKUPVALUE is only supported in calculated columns; it is resolved \
                     during calculated-column materialization and cannot be rendered here"
                        .to_string(),
                ));
            }
            Expression::Percentile {
                operand,
                percentile,
            } => {
                let op_sql = self.keep_scoped(self.render_plain(operand)?);
                let k_sql = self.render_plain(percentile)?;
                self.dialect.percentile(&k_sql, &op_sql)?
            }
            Expression::Query { .. } => {
                // Query expressions produce tables and must be materialized,
                // not rendered inline. This should not be reached in normal flow.
                self.dialect
                    .materialized_placeholder("/* QUERY: must be materialized */", expr)?
            }
            Expression::HasOneValue { column } => {
                let col_sql = self.keep_scoped(self.render_plain(column)?);
                format!("(COUNT(DISTINCT {col_sql}) = 1)")
            }
            Expression::SelectedValue { column, alternate } => {
                let col_sql = self.keep_scoped(self.render_plain(column)?);
                let alt = match alternate {
                    Some(a) => self.render_plain(a)?,
                    None => "NULL".to_string(),
                };
                format!(
                    "CASE WHEN COUNT(DISTINCT {col_sql}) = 1 THEN MIN({col_sql}) ELSE {alt} END"
                )
            }
            Expression::FirstValue { column, order_by } => {
                let column_sql = self.keep_scoped(self.render_plain(column)?);
                let order_sql = self.keep_scoped(self.render_plain(order_by)?);
                self.dialect.first_value(&column_sql, &order_sql)?
            }
            Expression::Window { .. } | Expression::Offset { .. } | Expression::Index { .. } => {
                // Window expressions produce tables and must be materialized,
                // not rendered inline. This should not be reached in normal flow.
                self.dialect
                    .materialized_placeholder("/* WINDOW: must be materialized */", expr)?
            }
            // Time-intelligence sugar is lowered onto Window/Offset before
            // any SQL is generated (see compute::time_intelligence). A node
            // surviving to rendering is an internal routing bug — fail
            // closed in every dialect rather than emit wrong SQL.
            Expression::ToDate { .. }
            | Expression::PeriodShift { .. }
            | Expression::DatesInPeriod { .. }
            | Expression::DatesBetween { .. }
            | Expression::SemiAdditiveBalance { .. } => {
                return Err(EngineError::InvalidExpression(
                    "time-intelligence expression (YTD/QTD/MTD/PRIORYEAR/PRIORPERIOD/\
                     DATESINPERIOD/DATESBETWEEN/CLOSINGBALANCE/OPENINGBALANCE) must be lowered \
                     to a window expression before SQL generation; this is an internal error — \
                     the measure should have routed through the window execution path"
                        .to_string(),
                ));
            }
            Expression::RankWindow { .. } => self
                .dialect
                .materialized_placeholder("/* RANK_WINDOW: must be materialized */", expr)?,
            Expression::InList {
                expr,
                values,
                negated,
            } => {
                let expr_sql = self.render_plain(expr)?;
                let vals = values
                    .iter()
                    .map(|v| self.render_plain(v))
                    .collect::<EngineResult<Vec<String>>>()?;
                let keyword = if *negated { "NOT IN" } else { "IN" };
                format!("{expr_sql} {keyword} ({})", vals.join(", "))
            }
            Expression::Greatest(args) => {
                let a = args
                    .iter()
                    .map(|e| self.render_plain(e))
                    .collect::<EngineResult<Vec<String>>>()?;
                format!("GREATEST({})", a.join(", "))
            }
            Expression::Least(args) => {
                let a = args
                    .iter()
                    .map(|e| self.render_plain(e))
                    .collect::<EngineResult<Vec<String>>>()?;
                format!("LEAST({})", a.join(", "))
            }
            Expression::NullIf { expr, value } => {
                format!(
                    "NULLIF({}, {})",
                    self.render_plain(expr)?,
                    self.render_plain(value)?
                )
            }
            Expression::CountIf { condition } => {
                let row = format!(
                    "CASE WHEN {} THEN 1 ELSE 0 END",
                    self.case_cond_of(condition, &self.render_plain(condition)?)
                );
                format!("SUM({})", self.keep_scoped(row))
            }
            Expression::ListAgg { column, delimiter } => {
                format!(
                    "STRING_AGG({}, {})",
                    self.keep_scoped(self.render_plain(column)?),
                    self.render_plain(delimiter)?
                )
            }
            Expression::MaxBy { value, sort_by } => {
                let v = self.keep_scoped(self.render_plain(value)?);
                let s = self.keep_scoped(self.render_plain(sort_by)?);
                self.dialect.max_by(&v, &s)?
            }
            Expression::MinBy { value, sort_by } => {
                let v = self.keep_scoped(self.render_plain(value)?);
                let s = self.keep_scoped(self.render_plain(sort_by)?);
                self.dialect.min_by(&v, &s)?
            }
            Expression::Call { name, args } => {
                // Host-registered UDFs exist only in the local DataFusion
                // session. A source dialect has no source-SQL equivalent and the
                // pushdown planner never pushes expressions containing Call (see
                // has_unpushable_ops), so this is unreachable in pushdown — fail
                // closed regardless, before rendering the arguments.
                if !self.dialect.supports_udf_call() {
                    return Err(udf_call_unsupported(name));
                }
                // The name is rendered lowercased (DataFusion normalizes unquoted
                // function identifiers before registry lookup) and re-validated
                // so a hostile model file that bypassed `Expression::validate`
                // still cannot inject SQL.
                let mapped = args
                    .iter()
                    .map(|a| self.render_plain(a))
                    .collect::<EngineResult<Vec<String>>>()?;
                super::dialect::render_udf_call(name, &mapped)?
            }
        })
    }

    /// Render an aggregate node: `COUNT(*)` ignores its operand (COUNTROWS
    /// carries a bare table reference, which is not renderable), a DAX
    /// `DISTINCTCOUNT` counts BLANK as a value, and a DAX count of nothing is
    /// BLANK. In KEEP-as-CASE-WHEN mode the enclosing KEEPs' condition is
    /// applied as conditional aggregation, and a KEEP nested directly in the
    /// operand (`COUNTROWS(KEEP(t, ...))`, `SUM(KEEP(x, ...))`) joins it.
    ///
    /// `COUNTROWS` under a KEEP renders `SUM(CASE WHEN c THEN 1 END)`: the
    /// count of the rows the KEEP keeps, `NULL` (BLANK, as DAX's COUNTROWS of
    /// no rows) when none is kept. It rendered a plain `COUNT(*)` here before
    /// the open-ledger round D, so a pushed filtered count counted EVERY row.
    fn render_aggregate_node(
        &self,
        operation: &AggregateOp,
        operand: &Expression,
    ) -> EngineResult<String> {
        if self.keep == KeepRendering::CaseWhen && matches!(operand, Expression::Keep { .. }) {
            return self.with_keep_scope(operand, &mut |inner| {
                self.render_aggregate_node(operation, inner)
            });
        }
        let operand_sql = if matches!(operation, AggregateOp::CountRows) {
            String::new()
        } else {
            self.render_plain(operand)?
        };
        match self.active_keep_condition() {
            Some(condition) => {
                let sql =
                    self.dialect
                        .render_aggregate_case_when(operation, &condition, &operand_sql)?;
                Ok(self.measure_aggregate_case_when(operation, sql, &condition, &operand_sql))
            }
            None => {
                let sql = self.dialect.render_aggregate(operation, &operand_sql)?;
                Ok(self.measure_aggregate(operation, sql, &operand_sql))
            }
        }
    }

    /// Render a bare `Keep` node according to the configured [`KeepRendering`].
    fn render_keep(&self, expr: &Expression) -> EngineResult<String> {
        let Expression::Keep { expr: inner, .. } = expr else {
            return Err(EngineError::InvalidExpression(
                "render_keep called on a non-Keep expression".to_string(),
            ));
        };
        match self.keep {
            KeepRendering::PassThrough => self.render_plain(inner),
            KeepRendering::CaseWhen => {
                self.with_keep_scope(expr, &mut |inner| self.render_plain(inner))
            }
        }
    }

    /// Render a KEEP's inner expression through `render` with the KEEP's
    /// condition added to the scope every aggregate beneath it takes
    /// ([`SqlRenderer::active_keep_condition`]).
    ///
    /// A KEEP with variables, expression conditions or IN predicates needs
    /// local context resolution and has no source-SQL form; the pushdown
    /// planner never pushes one (`has_unpushable_ops`). It is an `Err` here
    /// rather than its inner expression, which would answer the UNFILTERED
    /// value. A KEEP with no predicate at all keeps every row: no scope.
    fn with_keep_scope(
        &self,
        keep: &Expression,
        render: &mut dyn FnMut(&Expression) -> EngineResult<String>,
    ) -> EngineResult<String> {
        let Expression::Keep {
            expr: inner,
            filters,
            variables,
            conditions,
            in_predicates,
        } = keep
        else {
            return Err(EngineError::InvalidExpression(
                "with_keep_scope called on a non-Keep expression".to_string(),
            ));
        };
        if !variables.is_empty() || !conditions.is_empty() || !in_predicates.is_empty() {
            return Err(EngineError::InvalidExpression(
                "a KEEP with table variables, expression conditions or IN predicates cannot \
                 be rendered as source SQL (it needs local context resolution); the measure \
                 must be evaluated locally"
                    .to_string(),
            ));
        }
        if filters.is_empty() {
            return render(inner);
        }
        let condition = self.keep_condition(filters)?;
        self.keep_scope.borrow_mut().push(condition);
        let out = render(inner);
        self.keep_scope.borrow_mut().pop();
        out
    }

    /// Build the `CASE WHEN` condition for simple KEEP filter predicates:
    /// qualified column, comparison operator, quoted literal, joined with
    /// ` AND `.
    ///
    /// The literal is QUOTED whatever the column holds: this renderer has no
    /// model, and the mode serves the PostgreSQL pushdown, where a quoted
    /// literal is of unknown type and takes the COLUMN's (`amount > '9'`
    /// compares numbers, `code < '9'` text). The model-aware local renderers
    /// type it from the column instead
    /// ([`crate::compute::context::format_filter_value`], BUG-0758). BLANK
    /// stays strict (`NULL op x` is not TRUE): DAX's BLANK-as-0 rule for a
    /// KEEP's simple predicate is an open DAX-parity item. Row-level security
    /// shares the [`FilterPredicate`] type but never this renderer: it is
    /// converted by `engine_query::security_filter`, strict on BLANK by owner
    /// decision (BUG-0759, 2026-11-06).
    fn keep_condition(&self, filters: &[FilterPredicate]) -> EngineResult<String> {
        let parts = filters
            .iter()
            .map(|f| {
                Ok(format!(
                    "{} {} {}",
                    self.qualifier.column(Some(&f.table), &f.column)?,
                    f.operator.as_sql(),
                    sql_quote_literal(&f.value)
                ))
            })
            .collect::<EngineResult<Vec<String>>>()?;
        Ok(parts.join(" AND "))
    }

    /// Render a scalar function call with pre-rendered arguments, delegating the
    /// per-dialect spelling (e.g. PostgreSQL's `::NUMERIC` rewrites) to the
    /// configured [`Dialect`].
    pub(super) fn render_scalar_func(
        &self,
        function: &ScalarFunction,
        mapped: &[String],
    ) -> EngineResult<String> {
        self.dialect.scalar_func(function, mapped)
    }
}
