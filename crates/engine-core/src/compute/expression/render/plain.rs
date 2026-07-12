//! Plain-mode rendering: the full Expression dispatch shared by every
//! SQL-generating entry point.

use crate::compute::aggregate::AggregateOp;
use crate::compute::expression::{Expression, FilterPredicate, ScalarFunction};
use crate::compute::sql_util::{quote_ident_double, sql_quote_literal};
use crate::error::{EngineError, EngineResult};

use super::dialect::udf_call_unsupported;
use super::{Dialect, KeepRendering, SqlRenderer};

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
            Expression::BinaryOp { left, op, right } => {
                format!(
                    "({} {} {})",
                    self.render_plain(left)?,
                    op.as_sql(),
                    self.render_plain(right)?
                )
            }
            Expression::Aggregate { operation, operand } => {
                self.render_aggregate_node(operation, operand)?
            }
            Expression::Keep { .. } => self.render_keep(expr)?,
            // Context manipulation nodes render as their inner expression's
            // SQL. Context operations are resolved by the ContextResolver (or
            // excluded by the pushdown planner) before SQL generation.
            Expression::Clear { expr, .. }
            | Expression::Reset { expr }
            | Expression::ClearInner { expr, .. }
            | Expression::ClearOuter { expr, .. }
            | Expression::ResetInner { expr }
            | Expression::ResetOuter { expr }
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
                format!(
                    "({} {} {})",
                    self.render_plain(left)?,
                    op.as_sql(),
                    self.render_plain(right)?
                )
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
                    self.render_plain(condition)?,
                    self.render_plain(then_expr)?,
                    self.render_plain(else_expr)?
                )
            }
            Expression::Switch {
                expr,
                cases,
                default,
            } => {
                let mut sql = format!("CASE {}", self.render_plain(expr)?);
                for (val, result) in cases {
                    sql.push_str(&format!(
                        " WHEN {} THEN {}",
                        self.render_plain(val)?,
                        self.render_plain(result)?
                    ));
                }
                if let Some(d) = default {
                    sql.push_str(&format!(" ELSE {}", self.render_plain(d)?));
                }
                sql.push_str(" END");
                sql
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
                let op_sql = self.render_plain(operand)?;
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
                format!("(COUNT(DISTINCT {}) = 1)", self.render_plain(column)?)
            }
            Expression::SelectedValue { column, alternate } => {
                let col_sql = self.render_plain(column)?;
                let alt = match alternate {
                    Some(a) => self.render_plain(a)?,
                    None => "NULL".to_string(),
                };
                format!(
                    "CASE WHEN COUNT(DISTINCT {col_sql}) = 1 THEN MIN({col_sql}) ELSE {alt} END"
                )
            }
            Expression::FirstValue { column, order_by } => {
                let column_sql = self.render_plain(column)?;
                let order_sql = self.render_plain(order_by)?;
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
            Expression::InList { expr, values } => {
                let expr_sql = self.render_plain(expr)?;
                let vals = values
                    .iter()
                    .map(|v| self.render_plain(v))
                    .collect::<EngineResult<Vec<String>>>()?;
                format!("{expr_sql} IN ({})", vals.join(", "))
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
                format!(
                    "SUM(CASE WHEN {} THEN 1 ELSE 0 END)",
                    self.render_plain(condition)?
                )
            }
            Expression::ListAgg { column, delimiter } => {
                format!(
                    "STRING_AGG({}, {})",
                    self.render_plain(column)?,
                    self.render_plain(delimiter)?
                )
            }
            Expression::MaxBy { value, sort_by } => {
                let v = self.render_plain(value)?;
                let s = self.render_plain(sort_by)?;
                self.dialect.max_by(&v, &s)?
            }
            Expression::MinBy { value, sort_by } => {
                let v = self.render_plain(value)?;
                let s = self.render_plain(sort_by)?;
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

    /// Render an aggregate node, handling `COUNT(*)` (whose bare table
    /// reference operand is not renderable) and — in KEEP-as-CASE-WHEN mode —
    /// a KEEP nested directly in the aggregate operand.
    fn render_aggregate_node(
        &self,
        operation: &AggregateOp,
        operand: &Expression,
    ) -> EngineResult<String> {
        if self.keep == KeepRendering::CaseWhen {
            if let Expression::Keep {
                expr: inner,
                filters,
                variables,
                conditions,
                in_predicates,
            } = operand
            {
                if variables.is_empty() && conditions.is_empty() && in_predicates.is_empty() {
                    let condition = self.keep_condition(filters)?;
                    // COUNTROWS carries a bare table reference operand. The
                    // legacy PostgreSQL pushdown rendered it as a plain
                    // COUNT(*) (the CASE WHEN condition does not apply);
                    // preserved byte-for-byte for pushdown compatibility.
                    if matches!(operation, AggregateOp::CountRows) {
                        return self.dialect.render_aggregate(operation, "");
                    }
                    let inner_sql = self.render_plain(inner)?;
                    let case_expr = format!("CASE WHEN {condition} THEN {inner_sql} END");
                    return self.dialect.render_aggregate(operation, &case_expr);
                }
            }
        }
        match operation {
            // COUNT(*) — handled before rendering the operand: COUNTROWS
            // carries a bare table reference, which is not renderable.
            AggregateOp::CountRows => self.dialect.render_aggregate(operation, ""),
            _ => self
                .dialect
                .render_aggregate(operation, &self.render_plain(operand)?),
        }
    }

    /// Render a bare `Keep` node according to the configured [`KeepRendering`].
    fn render_keep(&self, expr: &Expression) -> EngineResult<String> {
        let Expression::Keep {
            expr: inner,
            filters,
            variables,
            conditions,
            in_predicates,
        } = expr
        else {
            return Err(EngineError::InvalidExpression(
                "render_keep called on a non-Keep expression".to_string(),
            ));
        };
        match self.keep {
            KeepRendering::PassThrough => self.render_plain(inner),
            KeepRendering::CaseWhen => {
                // KEEP with variables, expression conditions, or IN predicates
                // requires local context resolution; the pushdown planner
                // never pushes those, so render the inner expression.
                if !variables.is_empty() || !conditions.is_empty() || !in_predicates.is_empty() {
                    return self.render_plain(inner);
                }
                let condition = self.keep_condition(filters)?;
                self.render_keep_case_when(inner, &condition)
            }
        }
    }

    /// Build the `CASE WHEN` condition for simple KEEP filter predicates:
    /// qualified column, comparison operator, quoted literal, joined with
    /// ` AND `.
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

    /// Wrap the aggregates of a KEEP inner expression in `CASE WHEN`.
    ///
    /// Recurses through arithmetic and safe division so the condition is
    /// applied to each leaf aggregate independently; everything else falls
    /// back to plain rendering.
    fn render_keep_case_when(&self, expr: &Expression, condition: &str) -> EngineResult<String> {
        Ok(match expr {
            Expression::Aggregate { operation, operand } => {
                // See render_aggregate_node for the COUNTROWS rationale.
                if matches!(operation, AggregateOp::CountRows) {
                    self.dialect.render_aggregate(operation, "")?
                } else {
                    let inner_sql = self.render_plain(operand)?;
                    let case_expr = format!("CASE WHEN {condition} THEN {inner_sql} END");
                    self.dialect.render_aggregate(operation, &case_expr)?
                }
            }
            Expression::BinaryOp { left, op, right } => {
                let l = self.render_keep_case_when(left, condition)?;
                let r = self.render_keep_case_when(right, condition)?;
                format!("({l} {} {r})", op.as_sql())
            }
            Expression::SafeDivide {
                numerator,
                denominator,
                alternate,
            } => {
                let n = self.render_keep_case_when(numerator, condition)?;
                let d = self.render_keep_case_when(denominator, condition)?;
                let alt = match alternate {
                    Some(a) => self.render_plain(a)?,
                    None => "NULL".to_string(),
                };
                let cast = self.dialect.divide_cast();
                format!("CASE WHEN {d} = 0 THEN {alt} ELSE CAST({n} AS {cast}) / {d} END")
            }
            _ => self.render_plain(expr)?,
        })
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
