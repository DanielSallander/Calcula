//! Unified Expression → SQL renderer.
//!
//! All Expression-to-SQL string generation in the workspace flows through
//! [`SqlRenderer`], parameterized by two small abstractions:
//!
//! - [`Dialect`] — function spellings that differ between execution targets
//!   (aggregate names, `CAST` target for safe division, scalar-function
//!   rewrites, percentile syntax, ...). A trait, so a new database vendor adds
//!   one impl ([`DataFusionDialect`], [`PostgresDialect`], ...) to teach the
//!   renderer its pushdown SQL — without changing this module.
//! - [`ColumnQualifier`] — how column references are qualified for a
//!   particular execution environment (bare `"col"`, a fixed table alias,
//!   lowercased model-table prefixes, source-registry bindings, connector
//!   table maps, ...).
//!
//! The historical entry points are thin configuration wrappers over this
//! renderer:
//!
//! - [`Expression::to_sql_string`] — `DataFusion` dialect + [`BareQualifier`].
//! - [`Expression::to_case_when_sql`] — `DataFusion` dialect +
//!   [`BareQualifier`], via [`SqlRenderer::render_case_when`].
//! - The pushdown planner's source SQL (engine-query) — `Postgres` dialect +
//!   a source-registry qualifier + [`SqlRenderer::with_keep_case_when`].
//! - The PostgreSQL connector dialect (engine-connectors) — `Postgres`
//!   dialect + a table-map qualifier + [`SqlRenderer::with_keep_case_when`].
//! - The pipeline's condition rendering (engine-query) — `DataFusion`
//!   dialect + [`LowercaseTableQualifier`].
//!
//! The generated SQL was byte-compatible with the four pre-unification
//! renderers; the pinned-SQL tests in each crate are the oracle. Since the
//! open-ledger round C it renders arithmetic, counts and measure-level
//! comparisons with DAX's BLANK semantics ([`crate::compute::dax_semantics`];
//! the pins were re-taken deliberately), unless configured with
//! [`SqlRenderer::with_relational_semantics`] (table transformations). Since
//! round D every `CASE` condition goes through [`Dialect::case_condition`], so
//! a NULL condition is FALSE on DataFusion too (`COALESCE(c, FALSE)`).

mod conditional;
mod dialect;
mod plain;
#[cfg(test)]
mod tests;

pub use dialect::{DataFusionDialect, Dialect, PostgresDialect};

use crate::compute::sql_util::quote_ident_double;
use crate::error::EngineResult;

use super::Expression;

/// How `KEEP` context operations are rendered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeepRendering {
    /// Render only the inner expression. Used for local execution SQL, where
    /// context operations are resolved by the `ContextResolver` before SQL
    /// generation.
    PassThrough,
    /// Render simple KEEP filter predicates as conditional aggregation:
    /// `AGG(CASE WHEN predicates THEN operand END)`. Used for source
    /// pushdown SQL, where the KEEP condition travels with the expression.
    CaseWhen,
}

/// Whose rules a missing value follows in arithmetic and counting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Semantics {
    /// DAX (the default; measures and calculated columns): `BLANK + 5 = 5`,
    /// `x / 0 = Infinity`, a count of nothing is BLANK. See
    /// [`crate::compute::dax_semantics`].
    Dax,
    /// SQL / Power Query M (table transformations): `null + 5 = null`, a
    /// count of nothing is 0 — the arithmetic operators render as plain SQL.
    Relational,
}

/// Renders column references for a particular execution environment.
///
/// Implementations decide how a bare reference (`ColumnRef`) and a
/// table-qualified reference (`QualifiedColumnRef`) appear in SQL. This is
/// the extension point that lets engine-query qualify through its source
/// registry and the connectors qualify through their table maps without
/// engine-core depending on either crate.
pub trait ColumnQualifier {
    /// Render a column reference as SQL.
    ///
    /// `table_or_var` is `Some` for qualified references (`table[column]`)
    /// and `None` for bare references (`column`).
    ///
    /// # Errors
    ///
    /// Implementations may fail when the table cannot be resolved (for
    /// example, a missing source-registry binding).
    fn column(&self, table_or_var: Option<&str>, column: &str) -> EngineResult<String>;
}

/// Renders every column reference unqualified: `"col"`.
///
/// This is the qualifier behind [`Expression::to_sql_string`] — qualified
/// references drop their table prefix.
#[derive(Debug, Clone, Copy)]
pub struct BareQualifier;

impl ColumnQualifier for BareQualifier {
    fn column(&self, _table_or_var: Option<&str>, column: &str) -> EngineResult<String> {
        Ok(quote_ident_double(column))
    }
}

/// Qualifies every column reference with one fixed table alias:
/// `alias."col"`.
///
/// Used for lookup-resolution SQL, where all references belong to a single
/// dimension table regardless of how they were written.
#[derive(Debug, Clone, Copy)]
pub struct TableAliasQualifier<'a> {
    /// The table alias to prefix (rendered as-is, not quoted).
    pub alias: &'a str,
}

impl ColumnQualifier for TableAliasQualifier<'_> {
    fn column(&self, _table_or_var: Option<&str>, column: &str) -> EngineResult<String> {
        Ok(format!("{}.{}", self.alias, quote_ident_double(column)))
    }
}

/// Qualifies table-qualified references with the lowercased model table name
/// (`table."col"`) and leaves bare references unqualified.
///
/// Used for pipeline condition SQL, where model tables are registered in
/// DataFusion under their lowercased names.
#[derive(Debug, Clone, Copy)]
pub struct LowercaseTableQualifier;

impl ColumnQualifier for LowercaseTableQualifier {
    fn column(&self, table_or_var: Option<&str>, column: &str) -> EngineResult<String> {
        Ok(match table_or_var {
            Some(table) => format!("{}.{}", table.to_lowercase(), quote_ident_double(column)),
            None => quote_ident_double(column),
        })
    }
}

/// Qualifies a table-qualified reference with its own lowercased model table
/// name (`table."col"`) and a **bare** reference with a fixed default table
/// (`default."col"`).
///
/// Used to render a context-driven calculated column's row-level expression
/// into a multi-table `GROUP BY`: the column may reference its host table's
/// columns (written bare or qualified) and, across a fan-out-safe relationship,
/// a related table's columns (always qualified). Each reference is qualified to
/// the table it belongs to, so the SQL is unambiguous over the joined query.
#[derive(Debug, Clone, Copy)]
pub struct MultiTableQualifier<'a> {
    /// The default table for **bare** references (the host table), already
    /// lowercased by the caller.
    pub default_table: &'a str,
}

impl ColumnQualifier for MultiTableQualifier<'_> {
    fn column(&self, table_or_var: Option<&str>, column: &str) -> EngineResult<String> {
        Ok(match table_or_var {
            Some(table) => format!("{}.{}", table.to_lowercase(), quote_ident_double(column)),
            None => format!("{}.{}", self.default_table, quote_ident_double(column)),
        })
    }
}

/// Unified recursive Expression → SQL renderer.
///
/// Construct with [`SqlRenderer::new`], optionally enable KEEP-to-CASE-WHEN
/// rendering with [`SqlRenderer::with_keep_case_when`], then call
/// [`SqlRenderer::render`] (plain scalar SQL) or
/// [`SqlRenderer::render_case_when`] (conditional aggregation over a fact
/// table).
pub struct SqlRenderer<'a, D: Dialect> {
    dialect: D,
    qualifier: &'a dyn ColumnQualifier,
    keep: KeepRendering,
    /// Alias that `THISROW(t[col])` references render against
    /// (`alias."col"`). Only the calculated-column THISROW materialization
    /// sets this; everywhere else a `ThisRow` node fails rendering closed.
    thisrow_alias: Option<String>,
    /// DAX (default) or relational arithmetic / counting.
    semantics: Semantics,
    /// KEEP-as-CASE-WHEN mode: the conditions of the KEEPs enclosing the node
    /// being rendered, innermost last. Every aggregate rendered inside a KEEP
    /// takes them (`render_keep` pushes, renders the inner expression, pops),
    /// so the filter reaches EVERY aggregate under the KEEP -- through
    /// arithmetic, IF, a scalar function, a nested KEEP, COUNTROWS -- rather
    /// than only the shapes a fixed arm list knew.
    keep_scope: std::cell::RefCell<Vec<String>>,
    /// The model's column kinds, when the caller holds the model
    /// ([`SqlRenderer::with_column_classes`]): a comparison side whose kind
    /// only its column shows then reads its BLANK as DAX does
    /// ([`crate::compute::dax_semantics::comparison_operand_in`]), and a date
    /// column term is date arithmetic.
    column_classes: Option<crate::compute::dax_semantics::ColumnClasses<'a>>,
}

impl<'a, D: Dialect> SqlRenderer<'a, D> {
    /// Create a renderer for the given dialect and column qualifier.
    ///
    /// KEEP context operations pass through to their inner expression (the
    /// local-execution behavior, where context is resolved separately). The
    /// dialect is taken by value (the built-in dialects are zero-size unit
    /// structs); a new vendor passes its own [`Dialect`] impl.
    pub fn new(dialect: D, qualifier: &'a dyn ColumnQualifier) -> Self {
        Self {
            dialect,
            qualifier,
            keep: KeepRendering::PassThrough,
            thisrow_alias: None,
            semantics: Semantics::Dax,
            keep_scope: std::cell::RefCell::new(Vec::new()),
            column_classes: None,
        }
    }

    /// Give the renderer the model's column kinds (see the field).
    #[must_use]
    pub fn with_column_classes(
        mut self,
        columns: crate::compute::dax_semantics::ColumnClasses<'a>,
    ) -> Self {
        self.column_classes = Some(columns);
        self
    }

    /// The column kinds this renderer was given, or none.
    fn column_classes(&self) -> crate::compute::dax_semantics::ColumnClasses<'a> {
        self.column_classes
            .unwrap_or(&crate::compute::dax_semantics::no_column_classes)
    }

    /// Render arithmetic and counting with SQL's (Power Query M's) rules
    /// instead of DAX's: `null + 5` is `null`, a count of nothing is `0`.
    /// Table transformations use this; measures and calculated columns keep
    /// the DAX default ([`crate::compute::dax_semantics`]).
    #[must_use]
    pub fn with_relational_semantics(mut self) -> Self {
        self.semantics = Semantics::Relational;
        self
    }

    /// Render a `BinaryOp` node through `render` for its operands, under the
    /// configured [`Semantics`].
    fn render_arithmetic(
        &self,
        expr: &Expression,
        render: &mut dyn FnMut(&Expression) -> EngineResult<String>,
    ) -> EngineResult<String> {
        match (self.semantics, expr) {
            (Semantics::Relational, Expression::BinaryOp { left, op, right }) => {
                let l = render(left)?;
                let r = render(right)?;
                Ok(format!("({l} {} {r})", op.as_sql()))
            }
            _ => crate::compute::dax_semantics::render_binary_in(
                expr,
                self.dialect.divide_style(),
                self.column_classes(),
                render,
            ),
        }
    }

    /// A rendered aggregate under the configured [`Semantics`]: a DAX
    /// `DISTINCTCOUNT` counts BLANK as a value and a DAX count of nothing is
    /// BLANK (`NULLIF(count, 0)`). `operand_sql` is the aggregate's rendered
    /// operand (ignored by `COUNTROWS`).
    fn measure_aggregate(
        &self,
        op: &crate::compute::aggregate::AggregateOp,
        sql: String,
        operand_sql: &str,
    ) -> String {
        use crate::compute::aggregate::AggregateOp;
        use crate::compute::dax_semantics;
        match self.semantics {
            Semantics::Dax => {
                let sql = if matches!(op, AggregateOp::DistinctCount) {
                    dax_semantics::distinct_count_counting_blank(&sql, operand_sql, None)
                } else {
                    sql
                };
                dax_semantics::blank_zero_count(op, sql)
            }
            Semantics::Relational => sql,
        }
    }

    /// [`Self::measure_aggregate`] for a conditional (`CASE WHEN condition`)
    /// aggregate; `operand_sql` is the bare operand, not the `CASE WHEN`.
    fn measure_aggregate_case_when(
        &self,
        op: &crate::compute::aggregate::AggregateOp,
        sql: String,
        condition: &str,
        operand_sql: &str,
    ) -> String {
        use crate::compute::aggregate::AggregateOp;
        use crate::compute::dax_semantics;
        match self.semantics {
            Semantics::Dax => {
                let sql = if matches!(op, AggregateOp::DistinctCount) {
                    let condition = self.dialect.case_condition(condition, true);
                    dax_semantics::distinct_count_counting_blank(&sql, operand_sql, Some(&condition))
                } else {
                    sql
                };
                dax_semantics::blank_zero_count_case_when(op, sql)
            }
            Semantics::Relational => sql,
        }
    }

    /// The condition of every KEEP enclosing the node being rendered in
    /// KEEP-as-CASE-WHEN mode, `AND`-ed, or `None` outside any KEEP. See
    /// [`SqlRenderer::with_keep_case_when`].
    fn active_keep_condition(&self) -> Option<String> {
        let scope = self.keep_scope.borrow();
        match scope.len() {
            0 => None,
            1 => Some(scope[0].clone()),
            _ => Some(
                scope
                    .iter()
                    .map(|c| format!("({c})"))
                    .collect::<Vec<_>>()
                    .join(" AND "),
            ),
        }
    }

    /// `CASE WHEN keep THEN sql END` inside a KEEP scope, `sql` otherwise:
    /// the operand of an aggregate-like node (COUNTIF, HASONEVALUE,
    /// SELECTEDVALUE, FIRSTNONBLANK, LISTAGG, MAX_BY/MIN_BY, PERCENTILE) sees
    /// only the rows the enclosing KEEPs keep.
    fn keep_scoped(&self, sql: String) -> String {
        match self.active_keep_condition() {
            Some(condition) => format!("CASE WHEN {} THEN {sql} END", self.case_cond(&condition)),
            None => sql,
        }
    }

    /// Whether a `SWITCH` case value can be BLANK, so a BLANK subject must
    /// match it: DAX's SWITCH compares with STRICT equality, BLANK matching
    /// only BLANK ([`crate::compute::dax_semantics::switch_sql`]). Always false
    /// under relational semantics (table transformations keep SQL's `CASE x
    /// WHEN v`).
    fn switch_value_may_be_blank(&self, value: &Expression) -> bool {
        self.semantics == Semantics::Dax && !crate::compute::dax_semantics::never_blank(value)
    }

    /// A KEEP / filter predicate as the WHEN of a `CASE` in this dialect
    /// ([`Dialect::case_condition`]): DataFusion spells it so NULL is FALSE.
    fn case_cond(&self, predicate_sql: &str) -> String {
        self.dialect.case_condition(predicate_sql, true)
    }

    /// A model expression's rendered condition (`IF`, `COUNTIF`) as the WHEN
    /// of a `CASE` in this dialect; a non-predicate (a number used as a
    /// condition) is cast to BOOLEAN first in DataFusion.
    fn case_cond_of(&self, condition: &Expression, condition_sql: &str) -> String {
        self.dialect
            .case_condition(condition_sql, condition.is_boolean_predicate())
    }

    /// Render `THISROW(t[col])` references against the given anchor-row
    /// alias (`alias."col"`). Used by the calculated-column THISROW
    /// materialization; without this, a `ThisRow` node fails rendering.
    #[must_use]
    pub fn with_thisrow_alias(mut self, alias: impl Into<String>) -> Self {
        self.thisrow_alias = Some(alias.into());
        self
    }

    /// Render simple KEEP filter predicates as conditional aggregation
    /// (`AGG(CASE WHEN predicates THEN operand END)`) instead of passing
    /// through. This is the source-pushdown behavior, where the KEEP
    /// condition must travel with the generated SQL.
    ///
    /// The condition applies to EVERY aggregate beneath the KEEP, however it
    /// is nested (`COUNTROWS(t, KEEP(...))` renders `SUM(CASE WHEN c THEN 1
    /// END)`, a KEEP inside a KEEP `AND`s both conditions). A node this mode
    /// cannot render faithfully -- a KEEP with variables / expression
    /// conditions / IN predicates, a CLEAR / RESET / USING / TRAVERSE /
    /// USERELATIONSHIP reaching the plain renderer -- is an `Err`, never its
    /// inner expression with the context silently dropped (the pushdown
    /// planner keeps such measures local, so the error is a routing bug).
    #[must_use]
    pub fn with_keep_case_when(mut self) -> Self {
        self.keep = KeepRendering::CaseWhen;
        self
    }

    /// Render an expression as a scalar SQL fragment.
    ///
    /// # Errors
    ///
    /// Returns [`EngineError::InvalidExpression`](crate::error::EngineError::InvalidExpression)
    /// for nodes that cannot be rendered as scalar SQL (`MeasureRef`, bare
    /// `TableRef`, and — in the `Postgres` dialect — window/query nodes that
    /// require local materialization). Qualifier failures propagate.
    pub fn render(&self, expr: &Expression) -> EngineResult<String> {
        self.render_plain(expr)
    }

    /// Render an expression with aggregate operands wrapped in `CASE WHEN
    /// condition THEN operand END` and qualified with `fact_table`.
    ///
    /// Used when a measure has per-measure context filters (KEEP) that must
    /// be scoped to the aggregate rather than applied as a global WHERE
    /// clause. See [`Expression::to_case_when_sql`] for details.
    ///
    /// # Errors
    ///
    /// Same conditions as [`SqlRenderer::render`].
    pub fn render_case_when(
        &self,
        expr: &Expression,
        condition: &str,
        fact_table: &str,
    ) -> EngineResult<String> {
        self.render_conditional(expr, condition, fact_table)
    }
}
