//! Conditional-aggregation rendering: aggregate operands wrapped in
//! `CASE WHEN condition THEN operand END` and qualified with a fact table.
//!
//! This mode backs [`Expression::to_case_when_sql`]. The arm set and
//! fallback behavior intentionally mirror the pre-unification implementation
//! byte-for-byte: nodes without an explicit arm (notably comparisons and
//! logical AND/OR) fall back to plain rendering, so aggregates beneath them
//! are *not* CASE-WHEN-wrapped.

use crate::compute::aggregate::AggregateOp;
use crate::compute::expression::Expression;
use crate::compute::sql_util::quote_ident_double;
use crate::error::{EngineError, EngineResult};

use super::{Dialect, SqlRenderer};

impl<D: Dialect> SqlRenderer<'_, D> {
    pub(super) fn render_conditional(
        &self,
        expr: &Expression,
        condition: &str,
        fact_table: &str,
    ) -> EngineResult<String> {
        Ok(match expr {
            Expression::Aggregate { operation, operand } => match operation {
                AggregateOp::CountRows => {
                    // COUNT(*) with condition → SUM(CASE WHEN condition THEN 1 END).
                    // Handled before rendering the operand: COUNTROWS carries a
                    // bare table reference, which is not renderable as scalar SQL.
                    self.dialect
                        .render_aggregate_case_when(operation, condition, "")?
                }
                _ => {
                    let qualified = self.render_operand(operand, fact_table)?;
                    self.dialect
                        .render_aggregate_case_when(operation, condition, &qualified)?
                }
            },
            // Compound expressions: recurse into sub-expressions so CASE WHEN
            // is applied to each leaf aggregate independently.
            Expression::BinaryOp { left, op, right } => {
                let l = self.render_conditional(left, condition, fact_table)?;
                let r = self.render_conditional(right, condition, fact_table)?;
                format!("({l} {} {r})", op.as_sql())
            }
            Expression::SafeDivide {
                numerator,
                denominator,
                alternate,
            } => {
                let n = self.render_conditional(numerator, condition, fact_table)?;
                let d = self.render_conditional(denominator, condition, fact_table)?;
                let alt = match alternate {
                    Some(a) => self.render_conditional(a, condition, fact_table)?,
                    None => "NULL".to_string(),
                };
                let cast = self.dialect.divide_cast();
                format!("CASE WHEN {d} = 0 THEN {alt} ELSE CAST({n} AS {cast}) / {d} END")
            }
            Expression::ScalarFunc { function, args } => {
                let mapped = args
                    .iter()
                    .map(|a| self.render_conditional(a, condition, fact_table))
                    .collect::<EngineResult<Vec<String>>>()?;
                self.render_scalar_func(function, &mapped)?
            }
            Expression::TextFunc { function, args } => {
                let mapped = args
                    .iter()
                    .map(|a| self.render_conditional(a, condition, fact_table))
                    .collect::<EngineResult<Vec<String>>>()?;
                function.to_sql_strs(&mapped)
            }
            Expression::DateTimeFunc { function, args } => {
                let mapped = args
                    .iter()
                    .map(|a| self.render_conditional(a, condition, fact_table))
                    .collect::<EngineResult<Vec<String>>>()?;
                function.to_sql_strs(&mapped)
            }
            Expression::IfError { expr, alternate } => {
                let e = self.render_conditional(expr, condition, fact_table)?;
                let a = self.render_conditional(alternate, condition, fact_table)?;
                format!("COALESCE({e}, {a})")
            }
            Expression::ClearExcept { expr, .. } => {
                self.render_conditional(expr, condition, fact_table)?
            }
            Expression::Iterate { expression, .. } => {
                self.render_conditional(expression, condition, fact_table)?
            }
            Expression::Percentile {
                operand,
                percentile,
            } => {
                let qualified = self.render_operand(operand, fact_table)?;
                let case_expr = format!("CASE WHEN {condition} THEN {qualified} END");
                let p = self.render_plain(percentile)?;
                self.dialect.percentile(&p, &case_expr)?
            }
            Expression::Coalesce(exprs) => {
                let mapped = exprs
                    .iter()
                    .map(|e| self.render_conditional(e, condition, fact_table))
                    .collect::<EngineResult<Vec<String>>>()?;
                format!("COALESCE({})", mapped.join(", "))
            }
            Expression::If {
                condition: cond_expr,
                then_expr,
                else_expr,
            } => {
                let c = self.render_conditional(cond_expr, condition, fact_table)?;
                let t = self.render_conditional(then_expr, condition, fact_table)?;
                let e = self.render_conditional(else_expr, condition, fact_table)?;
                format!("CASE WHEN {c} THEN {t} ELSE {e} END")
            }
            Expression::IsBlank(inner) => {
                let i = self.render_conditional(inner, condition, fact_table)?;
                format!("({i} IS NULL)")
            }
            Expression::Not(inner) => {
                let i = self.render_conditional(inner, condition, fact_table)?;
                format!("(NOT {i})")
            }
            Expression::Xor(left, right) => {
                let l = self.render_conditional(left, condition, fact_table)?;
                let r = self.render_conditional(right, condition, fact_table)?;
                format!("(({l} AND NOT {r}) OR (NOT {l} AND {r}))")
            }
            Expression::Block { .. } => {
                self.render_conditional(&expr.inline_bindings(), condition, fact_table)?
            }
            Expression::HasOneValue { column } => {
                let qualified = self.qualify_if_bare(column, fact_table)?;
                let case_expr = format!("CASE WHEN {condition} THEN {qualified} END");
                format!("(COUNT(DISTINCT {case_expr}) = 1)")
            }
            Expression::SelectedValue { column, alternate } => {
                let qualified = self.qualify_if_bare(column, fact_table)?;
                let case_expr = format!("CASE WHEN {condition} THEN {qualified} END");
                let alt = match alternate {
                    Some(a) => self.render_conditional(a, condition, fact_table)?,
                    None => "NULL".to_string(),
                };
                format!(
                    "CASE WHEN COUNT(DISTINCT {case_expr}) = 1 THEN MIN({case_expr}) ELSE {alt} END"
                )
            }
            Expression::FirstValue { column, order_by } => {
                let qualified_col = self.qualify_if_bare(column, fact_table)?;
                let qualified_order = self.qualify_if_bare(order_by, fact_table)?;
                let case_col = format!("CASE WHEN {condition} THEN {qualified_col} END");
                let case_order = format!("CASE WHEN {condition} THEN {qualified_order} END");
                format!("FIRST_VALUE({case_col} ORDER BY {case_order})")
            }
            Expression::Window { .. } | Expression::Offset { .. } | Expression::Index { .. } => {
                "/* WINDOW: must be materialized */".to_string()
            }
            // Lowered before rendering — surviving here is an internal bug
            // (mirrors the plain renderer; fail closed).
            Expression::ToDate { .. }
            | Expression::PeriodShift { .. }
            | Expression::DatesInPeriod { .. } => {
                return Err(EngineError::InvalidExpression(
                    "time-intelligence expression (YTD/QTD/MTD/PRIORYEAR/PRIORPERIOD/\
                     DATESINPERIOD) must be lowered to a window expression before SQL \
                     generation; this is an internal error — the measure should have routed \
                     through the window execution path"
                        .to_string(),
                ));
            }
            Expression::Greatest(args) => {
                let a = args
                    .iter()
                    .map(|e| self.render_conditional(e, condition, fact_table))
                    .collect::<EngineResult<Vec<String>>>()?;
                format!("GREATEST({})", a.join(", "))
            }
            Expression::Least(args) => {
                let a = args
                    .iter()
                    .map(|e| self.render_conditional(e, condition, fact_table))
                    .collect::<EngineResult<Vec<String>>>()?;
                format!("LEAST({})", a.join(", "))
            }
            Expression::NullIf { expr, value } => {
                let e = self.render_conditional(expr, condition, fact_table)?;
                let v = self.render_conditional(value, condition, fact_table)?;
                format!("NULLIF({e}, {v})")
            }
            Expression::CountIf {
                condition: cond_expr,
            } => {
                let c = self.render_conditional(cond_expr, condition, fact_table)?;
                format!("SUM(CASE WHEN {c} THEN 1 ELSE 0 END)")
            }
            Expression::ListAgg { column, delimiter } => {
                let col = self.render_conditional(column, condition, fact_table)?;
                let delim = self.render_conditional(delimiter, condition, fact_table)?;
                format!("STRING_AGG({col}, {delim})")
            }
            Expression::MaxBy { value, sort_by } => {
                let v = self.render_conditional(value, condition, fact_table)?;
                let s = self.render_conditional(sort_by, condition, fact_table)?;
                format!("FIRST_VALUE({v} ORDER BY {s} DESC)")
            }
            Expression::MinBy { value, sort_by } => {
                let v = self.render_conditional(value, condition, fact_table)?;
                let s = self.render_conditional(sort_by, condition, fact_table)?;
                format!("FIRST_VALUE({v} ORDER BY {s} ASC)")
            }
            // UDF call: recurse into arguments so aggregates beneath them are
            // CASE-WHEN-wrapped (mirrors ScalarFunc). DataFusion dialect only —
            // the Postgres dialect fails closed in plain rendering.
            Expression::Call { name, args } => {
                crate::compute::expression::validate_call_name(name)?;
                let mapped = args
                    .iter()
                    .map(|a| self.render_conditional(a, condition, fact_table))
                    .collect::<EngineResult<Vec<String>>>()?;
                format!("{}({})", name.to_lowercase(), mapped.join(", "))
            }
            // For leaf expressions (literals, column refs, comparisons, ...),
            // fall back to plain rendering.
            _ => self.render_plain(expr)?,
        })
    }

    /// Qualify column references in an aggregate operand expression with the
    /// fact table name.
    ///
    /// For simple column references (`"col"`), prepends `fact_table."col"`.
    /// For compound expressions (e.g., `"price" * "qty"`), qualifies each leaf
    /// column reference individually so the result is
    /// `fact_table."price" * fact_table."qty"`. The arm set intentionally
    /// mirrors the pre-unification implementation: other node kinds fall back
    /// to plain rendering without fact-table qualification.
    fn render_operand(&self, operand: &Expression, fact_table: &str) -> EngineResult<String> {
        Ok(match operand {
            Expression::ColumnRef(name) => {
                format!("{fact_table}.{}", quote_ident_double(name))
            }
            Expression::QualifiedColumnRef {
                table_or_var,
                column,
            } => {
                let tbl = table_or_var.to_lowercase();
                format!("{tbl}.{}", quote_ident_double(column))
            }
            Expression::BinaryOp { left, op, right } => {
                let l = self.render_operand(left, fact_table)?;
                let r = self.render_operand(right, fact_table)?;
                format!("({l} {} {r})", op.as_sql())
            }
            Expression::ScalarFunc { function, args } => {
                let mapped = args
                    .iter()
                    .map(|a| self.render_operand(a, fact_table))
                    .collect::<EngineResult<Vec<String>>>()?;
                self.render_scalar_func(function, &mapped)?
            }
            // UDF call inside an aggregate operand: qualify each argument's
            // column references with the fact table (mirrors ScalarFunc).
            Expression::Call { name, args } => {
                crate::compute::expression::validate_call_name(name)?;
                let mapped = args
                    .iter()
                    .map(|a| self.render_operand(a, fact_table))
                    .collect::<EngineResult<Vec<String>>>()?;
                format!("{}({})", name.to_lowercase(), mapped.join(", "))
            }
            Expression::If {
                condition,
                then_expr,
                else_expr,
            } => {
                let c = self.render_operand(condition, fact_table)?;
                let t = self.render_operand(then_expr, fact_table)?;
                let e = self.render_operand(else_expr, fact_table)?;
                format!("CASE WHEN {c} THEN {t} ELSE {e} END")
            }
            // For literals and other leaf nodes, plain rendering (no
            // qualification needed).
            _ => self.render_plain(operand)?,
        })
    }

    /// Render a column expression and prefix it with the fact table when the
    /// rendered SQL carries no table qualification yet (string-level check,
    /// preserved from the pre-unification implementation).
    fn qualify_if_bare(&self, column: &Expression, fact_table: &str) -> EngineResult<String> {
        let col_sql = self.render_plain(column)?;
        Ok(if !col_sql.contains('.') {
            format!("{fact_table}.{col_sql}")
        } else {
            col_sql
        })
    }
}
