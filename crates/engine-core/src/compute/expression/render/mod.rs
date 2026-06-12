//! Unified Expression → SQL renderer.
//!
//! All Expression-to-SQL string generation in the workspace flows through
//! [`SqlRenderer`], parameterized by two small abstractions:
//!
//! - [`SqlDialect`] — function spellings that differ between the local
//!   DataFusion execution engine and PostgreSQL source pushdown SQL
//!   (aggregate names, `CAST` target for safe division, scalar-function
//!   rewrites, percentile syntax, ...).
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
//! The generated SQL is byte-compatible with the four pre-unification
//! renderers; the pinned-SQL tests in each crate are the oracle.

mod conditional;
mod plain;
#[cfg(test)]
mod tests;

use crate::compute::aggregate::AggregateOp;
use crate::compute::sql_util::quote_ident_double;
use crate::error::EngineResult;

use super::Expression;

/// SQL dialect targeted by the renderer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SqlDialect {
    /// DataFusion-compatible SQL for local execution (the engine's internal
    /// query engine). Uses `CAST(x AS DOUBLE)`, `approx_percentile_cont`,
    /// `FIRST_VALUE(x ORDER BY y)`, and DataFusion aggregate spellings.
    DataFusion,
    /// PostgreSQL SQL for source pushdown. Uses `CAST(x AS DOUBLE PRECISION)`,
    /// `PERCENTILE_CONT(k) WITHIN GROUP (ORDER BY x)`, `::NUMERIC` casts for
    /// `ROUND`/`TRUNC`/`LOG`, and PostgreSQL aggregate spellings.
    Postgres,
}

impl SqlDialect {
    /// Render an aggregate over an already-rendered operand fragment.
    fn render_aggregate(&self, op: &AggregateOp, operand_sql: &str) -> String {
        match self {
            SqlDialect::DataFusion => op.render_sql(operand_sql),
            SqlDialect::Postgres => op.render_postgres_sql(operand_sql),
        }
    }

    /// Render an aggregate with a `CASE WHEN` condition applied to its operand.
    fn render_aggregate_case_when(
        &self,
        op: &AggregateOp,
        condition: &str,
        operand_sql: &str,
    ) -> String {
        match self {
            SqlDialect::DataFusion => op.render_case_when_sql(condition, operand_sql),
            SqlDialect::Postgres => op.render_postgres_case_when_sql(condition, operand_sql),
        }
    }

    /// The cast target used for safe division (`DIVIDE`).
    fn divide_cast(&self) -> &'static str {
        match self {
            SqlDialect::DataFusion => "DOUBLE",
            SqlDialect::Postgres => "DOUBLE PRECISION",
        }
    }
}

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

/// Unified recursive Expression → SQL renderer.
///
/// Construct with [`SqlRenderer::new`], optionally enable KEEP-to-CASE-WHEN
/// rendering with [`SqlRenderer::with_keep_case_when`], then call
/// [`SqlRenderer::render`] (plain scalar SQL) or
/// [`SqlRenderer::render_case_when`] (conditional aggregation over a fact
/// table).
pub struct SqlRenderer<'a> {
    dialect: SqlDialect,
    qualifier: &'a dyn ColumnQualifier,
    keep: KeepRendering,
}

impl<'a> SqlRenderer<'a> {
    /// Create a renderer for the given dialect and column qualifier.
    ///
    /// KEEP context operations pass through to their inner expression (the
    /// local-execution behavior, where context is resolved separately).
    pub fn new(dialect: SqlDialect, qualifier: &'a dyn ColumnQualifier) -> Self {
        Self {
            dialect,
            qualifier,
            keep: KeepRendering::PassThrough,
        }
    }

    /// Render simple KEEP filter predicates as conditional aggregation
    /// (`AGG(CASE WHEN predicates THEN operand END)`) instead of passing
    /// through. This is the source-pushdown behavior, where the KEEP
    /// condition must travel with the generated SQL.
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
