//! Plain-mode rendering: the full Expression dispatch shared by every
//! SQL-generating entry point.

use crate::compute::aggregate::AggregateOp;
use crate::compute::expression::{Expression, FilterPredicate, ScalarFunction};
use crate::compute::sql_util::sql_quote_literal;
use crate::error::{EngineError, EngineResult};

use super::{KeepRendering, SqlDialect, SqlRenderer};

impl SqlRenderer<'_> {
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
            Expression::Block { .. } => self.render_plain(&expr.inline_bindings())?,
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
                match self.dialect {
                    // DataFusion plain SQL parenthesizes the division.
                    SqlDialect::DataFusion => {
                        format!("CASE WHEN {d} = 0 THEN {alt} ELSE (CAST({n} AS DOUBLE) / {d}) END")
                    }
                    SqlDialect::Postgres => format!(
                        "CASE WHEN {d} = 0 THEN {alt} ELSE CAST({n} AS DOUBLE PRECISION) / {d} END"
                    ),
                }
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
                self.render_scalar_func(function, &mapped)
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
            Expression::Percentile {
                operand,
                percentile,
            } => {
                let op_sql = self.render_plain(operand)?;
                let k_sql = self.render_plain(percentile)?;
                match self.dialect {
                    SqlDialect::DataFusion => {
                        format!("approx_percentile_cont({op_sql}, {k_sql})")
                    }
                    SqlDialect::Postgres => {
                        format!("PERCENTILE_CONT({k_sql}) WITHIN GROUP (ORDER BY {op_sql})")
                    }
                }
            }
            Expression::Query { .. } => match self.dialect {
                // Query expressions produce tables and must be materialized,
                // not rendered inline. This should not be reached in normal flow.
                SqlDialect::DataFusion => "/* QUERY: must be materialized */".to_string(),
                SqlDialect::Postgres => return Err(unsupported(expr)),
            },
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
            Expression::FirstValue { column, order_by } => match self.dialect {
                SqlDialect::DataFusion => format!(
                    "FIRST_VALUE({} ORDER BY {})",
                    self.render_plain(column)?,
                    self.render_plain(order_by)?
                ),
                // PostgreSQL pushdown simplifies FIRST to MIN (no inline
                // ordered-set FIRST_VALUE aggregate).
                SqlDialect::Postgres => format!("MIN({})", self.render_plain(column)?),
            },
            Expression::Window { .. } | Expression::Offset { .. } | Expression::Index { .. } => {
                match self.dialect {
                    // Window expressions produce tables and must be materialized,
                    // not rendered inline. This should not be reached in normal flow.
                    SqlDialect::DataFusion => "/* WINDOW: must be materialized */".to_string(),
                    SqlDialect::Postgres => return Err(unsupported(expr)),
                }
            }
            // Time-intelligence sugar is lowered onto Window/Offset before
            // any SQL is generated (see compute::time_intelligence). A node
            // surviving to rendering is an internal routing bug — fail
            // closed in every dialect rather than emit wrong SQL.
            Expression::ToDate { .. } | Expression::PeriodShift { .. } => {
                return Err(EngineError::InvalidExpression(
                    "time-intelligence expression (YTD/QTD/MTD/PRIORYEAR/PRIORPERIOD) must \
                     be lowered to a window expression before SQL generation; this is an \
                     internal error — the measure should have routed through the window \
                     execution path"
                        .to_string(),
                ));
            }
            Expression::RankWindow { .. } => match self.dialect {
                SqlDialect::DataFusion => "/* RANK_WINDOW: must be materialized */".to_string(),
                SqlDialect::Postgres => return Err(unsupported(expr)),
            },
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
                match self.dialect {
                    // First value ordered by sort_by descending.
                    SqlDialect::DataFusion => format!("FIRST_VALUE({v} ORDER BY {s} DESC)"),
                    SqlDialect::Postgres => {
                        format!("(ARRAY_AGG({v} ORDER BY {s} DESC NULLS LAST))[1]")
                    }
                }
            }
            Expression::MinBy { value, sort_by } => {
                let v = self.render_plain(value)?;
                let s = self.render_plain(sort_by)?;
                match self.dialect {
                    // First value ordered by sort_by ascending.
                    SqlDialect::DataFusion => format!("FIRST_VALUE({v} ORDER BY {s} ASC)"),
                    SqlDialect::Postgres => {
                        format!("(ARRAY_AGG({v} ORDER BY {s} ASC NULLS LAST))[1]")
                    }
                }
            }
            Expression::Call { name, args } => match self.dialect {
                // Host-registered UDFs exist only in the local DataFusion
                // session. The name is rendered lowercased because DataFusion
                // normalizes unquoted SQL function identifiers to lowercase
                // before registry lookup (UdfRegistry enforces lowercase
                // registration, so the lookup always matches).
                //
                // The name is spliced unquoted — re-check the call-name rule
                // here so a hostile model file that bypassed
                // `Expression::validate` still cannot inject SQL.
                SqlDialect::DataFusion => {
                    crate::compute::expression::validate_call_name(name)?;
                    let mapped = args
                        .iter()
                        .map(|a| self.render_plain(a))
                        .collect::<EngineResult<Vec<String>>>()?;
                    format!("{}({})", name.to_lowercase(), mapped.join(", "))
                }
                // UDFs have no source-SQL equivalent. The pushdown planner
                // never pushes expressions containing Call (see
                // has_unpushable_ops), so this is unreachable in normal flow —
                // fail closed regardless.
                SqlDialect::Postgres => {
                    return Err(EngineError::InvalidExpression(format!(
                        "UDF call '{name}' cannot be rendered as source SQL; \
                         user-defined functions execute locally only"
                    )));
                }
            },
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
                        return Ok(self.dialect.render_aggregate(operation, ""));
                    }
                    let inner_sql = self.render_plain(inner)?;
                    let case_expr = format!("CASE WHEN {condition} THEN {inner_sql} END");
                    return Ok(self.dialect.render_aggregate(operation, &case_expr));
                }
            }
        }
        match operation {
            // COUNT(*) — handled before rendering the operand: COUNTROWS
            // carries a bare table reference, which is not renderable.
            AggregateOp::CountRows => Ok(self.dialect.render_aggregate(operation, "")),
            _ => Ok(self
                .dialect
                .render_aggregate(operation, &self.render_plain(operand)?)),
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
                    self.dialect.render_aggregate(operation, "")
                } else {
                    let inner_sql = self.render_plain(operand)?;
                    let case_expr = format!("CASE WHEN {condition} THEN {inner_sql} END");
                    self.dialect.render_aggregate(operation, &case_expr)
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

    /// Render a scalar function call with pre-rendered arguments, applying
    /// PostgreSQL-specific rewrites in the `Postgres` dialect.
    pub(super) fn render_scalar_func(
        &self,
        function: &ScalarFunction,
        mapped: &[String],
    ) -> String {
        match self.dialect {
            SqlDialect::DataFusion => function.to_sql_strs(mapped),
            SqlDialect::Postgres => match function {
                // PostgreSQL ROUND/TRUNC require numeric, not double precision.
                ScalarFunction::Round | ScalarFunction::RoundUp | ScalarFunction::RoundDown => {
                    let digits = mapped.get(1).map(|s| s.as_str()).unwrap_or("0");
                    let func = if matches!(function, ScalarFunction::RoundDown) {
                        "TRUNC"
                    } else {
                        "ROUND"
                    };
                    format!("{func}(({})::NUMERIC, {digits})", mapped[0])
                }
                ScalarFunction::Trunc => {
                    let digits = mapped.get(1).map(|s| s.as_str()).unwrap_or("0");
                    format!("TRUNC(({})::NUMERIC, {digits})", mapped[0])
                }
                // PostgreSQL uses LOG(base, value), not LOG10(value).
                ScalarFunction::Log10 => format!("LOG(10, ({})::NUMERIC)", mapped[0]),
                ScalarFunction::Sign => format!("SIGN({})", mapped[0]),
                ScalarFunction::Mod => format!("MOD({}, {})", mapped[0], mapped[1]),
                _ => function.to_sql_strs(mapped),
            },
        }
    }
}

/// Error for expression nodes that cannot be rendered in the target dialect.
fn unsupported(expr: &Expression) -> EngineError {
    EngineError::InvalidExpression(format!(
        "Expression not supported for source SQL rendering: {expr:?}"
    ))
}
