//! Context resolution engine.
//!
//! Resolves context manipulation expressions (`keep`, `clear`, `reset`,
//! `traverse`, `using`) into a flat [`EvaluationContext`] that can be
//! translated into SQL WHERE and JOIN clauses.

use std::collections::{HashMap, HashSet};

use crate::compute::expression::{ComparisonOp, Expression, FilterPredicate, RelationshipPath};
use crate::compute::sql_util::{quote_ident_double, sql_quote_literal};
use crate::error::{EngineError, EngineResult};
use crate::model::context::{ClearTarget, ContextOp};
use crate::model::relationship::Relationship;
use crate::model::schema::DataModel;

/// Identifies where a filter originated.
///
/// Used by source-specific `clear_inner`/`clear_outer`/`reset_inner`/`reset_outer`
/// operations to selectively remove filters from one source without affecting the other.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FilterSource {
    /// Query-level filter (slicer, page/report filter) from `QueryRequest.filters`.
    #[default]
    Query,
    /// Group-by context filter from `QueryRequest.group_by` (matrix row/column headers).
    GroupBy,
}

/// Filter level of the group-by axis (pivot row/column context).
pub const LEVEL_AXIS: u8 = 0;
/// Default filter level of report slicers / query-level filters.
pub const LEVEL_SLICER: u8 = 1;
/// Highest assignable filter level.
pub const LEVEL_MAX: u8 = 9;

/// A contiguous range of filter levels affected by a clear/reset operation.
///
/// Level 0 is the group-by axis; level 1 is ordinary report slicers; levels
/// 2..=[`LEVEL_MAX`] are pinned filters. Each clear op denotes a range:
/// `CLEAR_INNER` is `[0,0]`, `CLEAR` is `[0,1]` (or `[0,n]` with `LEVEL n`),
/// `CLEAR_OUTER` is `[1,1]` (or `[1,n]`). Floors are always 0 or 1, so the
/// union of any two ranges is itself a contiguous range and [`Self::union`]
/// is exact — it never over-clears.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LevelRange {
    /// Lowest level cleared (0 = axis included, 1 = axis kept).
    pub floor: u8,
    /// Highest level cleared.
    pub ceiling: u8,
}

impl LevelRange {
    /// The axis-only range `[0,0]` (`CLEAR_INNER` / `RESET_INNER`).
    pub const fn axis_only() -> Self {
        Self {
            floor: LEVEL_AXIS,
            ceiling: LEVEL_AXIS,
        }
    }

    /// The range `[0,ceiling]` (`CLEAR` / `RESET`, default ceiling 1).
    pub const fn through(ceiling: u8) -> Self {
        Self {
            floor: LEVEL_AXIS,
            ceiling,
        }
    }

    /// The axis-keeping range `[1,ceiling]` (`CLEAR_OUTER` / `RESET_OUTER`).
    pub const fn outer(ceiling: u8) -> Self {
        Self {
            floor: LEVEL_SLICER,
            ceiling,
        }
    }

    /// Whether `level` falls inside this range.
    pub const fn contains(&self, level: u8) -> bool {
        self.floor <= level && level <= self.ceiling
    }

    /// The union of two ranges (min floor, max ceiling). Exact for the ranges
    /// this module produces: floors are 0 or 1, so the set union is contiguous.
    pub fn union(self, other: Self) -> Self {
        Self {
            floor: self.floor.min(other.floor),
            ceiling: self.ceiling.max(other.ceiling),
        }
    }
}

/// A resolved filter condition ready for SQL generation.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedFilter {
    /// Table name.
    pub table: String,
    /// Column name.
    pub column: String,
    /// Comparison operator.
    pub operator: ComparisonOp,
    /// Value (string representation).
    pub value: String,
    /// Where this filter originated.
    pub source: FilterSource,
    /// Filter level for [`FilterSource::Query`] filters — [`LEVEL_SLICER`]
    /// for ordinary slicers, 2..=[`LEVEL_MAX`] for pinned filters. Ignored
    /// for [`FilterSource::GroupBy`] (the axis is level 0 by definition; see
    /// [`Self::effective_level`]).
    pub level: u8,
}

impl ResolvedFilter {
    /// Create a new resolved filter with the default [`FilterSource::Query`]
    /// source at [`LEVEL_SLICER`].
    pub fn new(
        table: impl Into<String>,
        column: impl Into<String>,
        operator: ComparisonOp,
        value: impl Into<String>,
    ) -> Self {
        Self {
            table: table.into(),
            column: column.into(),
            operator,
            value: value.into(),
            source: FilterSource::Query,
            level: LEVEL_SLICER,
        }
    }

    /// Create from a [`FilterPredicate`].
    ///
    /// Defaults to [`FilterSource::Query`] at [`LEVEL_SLICER`]. Callers
    /// should set `source` explicitly when constructing filters from
    /// group-by context.
    pub fn from_predicate(predicate: &FilterPredicate) -> Self {
        Self {
            table: predicate.table.clone(),
            column: predicate.column.clone(),
            operator: predicate.operator,
            value: predicate.value.clone(),
            source: FilterSource::Query,
            level: LEVEL_SLICER,
        }
    }

    /// Return a copy with the given filter source.
    pub fn with_source(mut self, source: FilterSource) -> Self {
        self.source = source;
        self
    }

    /// Return a copy with the given filter level (pinned filters are ≥ 2).
    pub fn with_level(mut self, level: u8) -> Self {
        self.level = level;
        self
    }

    /// The filter level this filter occupies for clear/reset purposes:
    /// group-by (axis) filters sit at [`LEVEL_AXIS`] regardless of their
    /// `level` field; query-level filters sit at their assigned level
    /// ([`LEVEL_SLICER`] by default, higher when pinned).
    pub fn effective_level(&self) -> u8 {
        match self.source {
            FilterSource::GroupBy => LEVEL_AXIS,
            FilterSource::Query => self.level,
        }
    }

    /// Render this filter as a SQL condition: `table_alias."column" op value`.
    ///
    /// Uses `model` to look up the target column's data type and decide whether
    /// the value should be quoted. Numeric and boolean values are rendered bare;
    /// string, date, and timestamp values are single-quoted. If the column type
    /// cannot be determined (e.g. missing table), falls back to quoting.
    pub fn to_sql_condition(&self, table_alias: &str, model: &DataModel) -> String {
        let op = self.operator.as_sql();
        let val = format_filter_value(&self.table, &self.column, &self.value, model);
        format!(
            "{table_alias}.{} {op} {val}",
            quote_ident_double(&self.column)
        )
    }
}

/// Format a filter value for SQL based on the target column's data type.
///
/// Looks up the column type in the model. Numeric/boolean values are bare;
/// string/date/timestamp values are single-quoted. Falls back to quoting if
/// the column type cannot be determined.
pub fn format_filter_value(table: &str, column: &str, value: &str, model: &DataModel) -> String {
    let needs_quoting = model
        .table(table)
        .ok()
        .and_then(|t| t.column(column).ok())
        .map(|c| c.data_type().needs_sql_quoting())
        .unwrap_or(true);

    if needs_quoting {
        sql_quote_literal(value)
    } else {
        value.to_string()
    }
}

/// A resolved IN-membership filter.
///
/// Represents a condition like `fact.column IN (SELECT var_col FROM var_base_table WHERE ...)`.
/// The variable's filters have been resolved to their base table.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedInFilter {
    /// Fact table name.
    pub table: String,
    /// Column in the fact table to test.
    pub column: String,
    /// Base table name (resolved from the table variable).
    pub var_base_table: String,
    /// Column in the variable's base table defining the set values.
    pub var_column: String,
    /// Filters to apply to the variable's base table (resolved from the variable chain).
    pub var_filters: Vec<ResolvedFilter>,
    /// `true` = anti-membership (`NOT IN`): keep rows whose value is NOT in
    /// the set. An empty set then keeps every row; a BLANK tested value
    /// satisfies neither form (SQL `<>` semantics).
    pub negated: bool,
}

/// A resolved evaluation context: the result of walking context operations
/// inside-out on an expression.
#[derive(Debug, Clone, Default)]
pub struct EvaluationContext {
    /// Active filter conditions (all AND'd together).
    pub filters: Vec<ResolvedFilter>,
    /// Per-column clears — each key maps to the [`LevelRange`] it clears.
    /// `CLEAR(t[c])` records `[0,1]`, `CLEAR_INNER(t[c])` `[0,0]`,
    /// `CLEAR_OUTER(t[c])` `[1,1]`; repeated clears union their ranges.
    pub cleared_columns: HashMap<(String, String), LevelRange>,
    /// Whole-table clears — each table maps to the [`LevelRange`] it clears.
    pub cleared_tables: HashMap<String, LevelRange>,
    /// Reset state: the [`LevelRange`] cleared across ALL tables, if any.
    /// `RESET()` records `[0,1]`, `RESET_INNER()` `[0,0]`, `RESET_OUTER()`
    /// `[1,1]`; repeated resets union their ranges.
    pub reset: Option<LevelRange>,
    /// Explicit relationship traversal paths (overrides model defaults).
    pub traversals: Vec<RelationshipPath>,
    /// IN-membership filters (resolved from `keep_in()` expressions).
    pub in_filters: Vec<ResolvedInFilter>,
    /// Relationship overrides from `USERELATIONSHIP()` expressions.
    ///
    /// Each entry is a relationship name. When resolving which relationship to
    /// use between two tables, these are checked in reverse order (innermost
    /// scope wins) before falling back to the model's active relationship.
    pub relationship_overrides: Vec<String>,
    /// Expression-based filter conditions (boolean expressions from KEEP).
    ///
    /// These are arbitrary boolean expressions like `dim[price] > dim[cost] * 1.5`
    /// that are AND'd with the simple filters.
    pub conditions: Vec<Expression>,
    /// Tables with CLEAREXCEPT — maps table name to set of preserved column names.
    ///
    /// When a table appears here, all filters on the table are cleared EXCEPT
    /// for filters on columns in the preserved set.
    #[allow(clippy::zero_sized_map_values)]
    pub clear_except: HashMap<String, HashSet<String>>,
}

impl EvaluationContext {
    /// Create an empty context.
    pub fn new() -> Self {
        Self::default()
    }

    /// Resolve which relationship to use between two tables, respecting overrides.
    ///
    /// Checks `relationship_overrides` in reverse order (innermost scope wins).
    /// If an override names a relationship that connects the given table pair,
    /// that relationship is returned. Otherwise falls back to the model's
    /// active relationship.
    pub fn resolve_relationship<'a>(
        &self,
        model: &'a DataModel,
        table_a: &str,
        table_b: &str,
    ) -> EngineResult<&'a Relationship> {
        for rel_name in self.relationship_overrides.iter().rev() {
            if let Ok(rel) = model.relationship(rel_name) {
                if (rel.from_table() == table_a && rel.to_table() == table_b)
                    || (rel.from_table() == table_b && rel.to_table() == table_a)
                {
                    return Ok(rel);
                }
            }
        }
        model.find_relationship(table_a, table_b)
    }

    /// Record a clear of `targets` over `range`, unioning with prior clears
    /// of the same target.
    pub fn record_clear(&mut self, targets: &[ClearTarget], range: LevelRange) {
        for target in targets {
            match target {
                ClearTarget::Column { table, column } => {
                    self.cleared_columns
                        .entry((table.clone(), column.clone()))
                        .and_modify(|r| *r = r.union(range))
                        .or_insert(range);
                }
                ClearTarget::Table(table) => {
                    self.cleared_tables
                        .entry(table.clone())
                        .and_modify(|r| *r = r.union(range))
                        .or_insert(range);
                }
            }
        }
    }

    /// Record a reset over `range`, unioning with any prior reset.
    pub fn record_reset(&mut self, range: LevelRange) {
        self.reset = Some(match self.reset {
            Some(existing) => existing.union(range),
            None => range,
        });
    }

    /// Whether the reset state (if any) covers `level`.
    pub fn reset_at(&self, level: u8) -> bool {
        self.reset.is_some_and(|r| r.contains(level))
    }

    /// True when any clear/reset/clear-except state is present, from any source.
    pub fn has_clear_or_reset(&self) -> bool {
        self.reset.is_some()
            || !self.cleared_tables.is_empty()
            || !self.cleared_columns.is_empty()
            || !self.clear_except.is_empty()
    }

    /// Case-insensitive: does some whole-table clear on `table_lc` cover `level`?
    pub fn table_cleared_at_ci(&self, table_lc: &str, level: u8) -> bool {
        self.cleared_tables
            .iter()
            .any(|(t, r)| t.eq_ignore_ascii_case(table_lc) && r.contains(level))
    }

    /// Case-insensitive: does some per-column clear on `(table_lc, column_lc)`
    /// cover `level`?
    pub fn column_cleared_at_ci(&self, table_lc: &str, column_lc: &str, level: u8) -> bool {
        self.cleared_columns.iter().any(|((t, c), r)| {
            t.eq_ignore_ascii_case(table_lc)
                && c.eq_ignore_ascii_case(column_lc)
                && r.contains(level)
        })
    }

    /// Case-insensitive: does a CLEAREXCEPT on `table_lc` clear `column_lc`
    /// (i.e. the table has an entry and the column is not preserved)?
    /// CLEAREXCEPT clears levels 0..=[`LEVEL_SLICER`] of non-preserved columns.
    pub fn clear_except_clears_ci(&self, table_lc: &str, column_lc: &str) -> bool {
        self.clear_except.iter().any(|(et, preserved)| {
            et.eq_ignore_ascii_case(table_lc)
                && !preserved.iter().any(|p| p.eq_ignore_ascii_case(column_lc))
        })
    }

    /// Case-insensitive: does this context remove a query-level filter on
    /// `(table, column)` sitting at `level`? Combines reset, whole-table and
    /// per-column clears, and CLEAREXCEPT (which reaches levels 0..=1 only).
    /// This is the single predicate deciding whether a measure evaluates
    /// without a given request filter.
    pub fn clears_query_filter_ci(&self, table: &str, column: &str, level: u8) -> bool {
        self.reset_at(level)
            || self.table_cleared_at_ci(table, level)
            || self.column_cleared_at_ci(table, column, level)
            || (level <= LEVEL_SLICER && self.clear_except_clears_ci(table, column))
    }

    /// Apply outer filters, respecting clear/reset operations and filter levels.
    ///
    /// Returns a new list of effective filters combining the inner context
    /// modifications with the provided outer filters. Each outer filter is
    /// dropped when a reset, a whole-table clear, a per-column clear, or a
    /// CLEAREXCEPT covers its [`ResolvedFilter::effective_level`]; level-based
    /// ops (`clear_inner`/`clear_outer`/…) thereby only affect filters from
    /// the matching source.
    pub fn effective_filters(&self, outer_filters: &[ResolvedFilter]) -> Vec<ResolvedFilter> {
        let mut result = Vec::new();

        for f in outer_filters {
            let level = f.effective_level();

            if self.reset_at(level) {
                continue;
            }

            let key = (f.table.clone(), f.column.clone());
            if self
                .cleared_columns
                .get(&key)
                .is_some_and(|r| r.contains(level))
            {
                continue;
            }
            if self
                .cleared_tables
                .get(&f.table)
                .is_some_and(|r| r.contains(level))
            {
                continue;
            }

            // CLEAREXCEPT: clear all filters on the table (levels 0..=1)
            // except preserved columns.
            if level <= LEVEL_SLICER {
                if let Some(preserved) = self.clear_except.get(&f.table) {
                    if !preserved.contains(&f.column) {
                        continue; // not preserved → cleared
                    }
                }
            }

            result.push(f.clone());
        }

        // Add all keep() filters (expression-level — these always apply)
        result.extend(self.filters.iter().cloned());

        result
    }
}

/// Resolve an optional clear-level ceiling: None ≡ [`LEVEL_SLICER`]. Values
/// above [`LEVEL_MAX`] are refused — the parser never produces them, but a
/// hand-edited model JSON could carry any u8 (fail closed).
fn clear_ceiling(level: Option<u8>) -> EngineResult<u8> {
    match level {
        None => Ok(LEVEL_SLICER),
        Some(n) if n <= LEVEL_MAX => Ok(n),
        Some(n) => Err(EngineError::InvalidData(format!(
            "clear level {n} exceeds the maximum filter level {LEVEL_MAX}"
        ))),
    }
}

/// Resolve an optional ceiling for the outer (`floor` 1) clear variants:
/// level 0 is the axis, which CLEAR_OUTER/RESET_OUTER keep by definition.
fn outer_ceiling(level: Option<u8>) -> EngineResult<u8> {
    let ceiling = clear_ceiling(level)?;
    if ceiling < LEVEL_SLICER {
        return Err(EngineError::InvalidData(
            "CLEAR_OUTER/RESET_OUTER keep the axis (level 0); their level must be at least 1"
                .into(),
        ));
    }
    Ok(ceiling)
}

/// Resolves context operations in an expression tree into a flat [`EvaluationContext`].
pub struct ContextResolver<'a> {
    model: &'a DataModel,
}

impl<'a> ContextResolver<'a> {
    /// Create a resolver for the given data model.
    pub fn new(model: &'a DataModel) -> Self {
        Self { model }
    }

    /// Resolve all context operations in the given expression.
    ///
    /// Walks the expression inside-out, collecting `keep`, `clear`, `reset`,
    /// `traverse`, and `using` operations into an [`EvaluationContext`].
    ///
    /// Returns `(stripped_expression, context)` where `stripped_expression` is
    /// the expression with context nodes removed (just the data/aggregate part).
    pub fn resolve(&self, expr: &Expression) -> EngineResult<(Expression, EvaluationContext)> {
        let mut ctx = EvaluationContext::new();
        let stripped = self.walk(expr, &mut ctx)?;
        Ok((stripped, ctx))
    }

    fn walk(&self, expr: &Expression, ctx: &mut EvaluationContext) -> EngineResult<Expression> {
        match expr {
            // Leaf nodes pass through. The calc-group placeholders
            // (SelectedMeasure and its introspection family) are always
            // substituted away before context resolution, but pass them
            // through unchanged (like MeasureRef) rather than failing here.
            Expression::ColumnRef(_)
            | Expression::LiteralFloat(_)
            | Expression::LiteralInt(_)
            | Expression::LiteralDate(_)
            | Expression::LiteralBool(_)
            | Expression::TableRef(_)
            | Expression::MeasureRef(_)
            | Expression::SelectedMeasure
            | Expression::IsSelectedMeasure { .. }
            | Expression::SelectedMeasureName
            | Expression::SelectedMeasureFormatString => Ok(expr.clone()),

            // Qualified column ref: if table_or_var is a table variable, resolve it
            Expression::QualifiedColumnRef {
                table_or_var,
                column,
            } => {
                if self.model.table_variable(table_or_var).is_ok() {
                    let (_base_table, var_filters) = self.resolve_table_variable(table_or_var)?;
                    ctx.filters.extend(var_filters);
                    // Strip to plain column ref — base table context is added via filters
                    Ok(Expression::ColumnRef(column.clone()))
                } else {
                    // Regular table — just pass through as column ref
                    Ok(Expression::ColumnRef(column.clone()))
                }
            }

            // Binary ops recurse into both sides
            Expression::BinaryOp { left, op, right } => {
                let left = self.walk(left, ctx)?;
                let right = self.walk(right, ctx)?;
                Ok(Expression::BinaryOp {
                    left: Box::new(left),
                    op: *op,
                    right: Box::new(right),
                })
            }

            // Aggregates recurse into operand
            Expression::Aggregate { operation, operand } => {
                let operand = self.walk(operand, ctx)?;
                Ok(Expression::Aggregate {
                    operation: *operation,
                    operand: Box::new(operand),
                })
            }

            // Context operations modify ctx and recurse
            Expression::Keep {
                expr,
                filters,
                variables,
                conditions,
                in_predicates,
            } => {
                // If the inner expression is a TableRef referencing a variable,
                // resolve the variable's filters into the context.
                if let Expression::TableRef(ref name) = **expr {
                    if self.model.table_variable(name).is_ok() {
                        let (_base_table, var_filters) = self.resolve_table_variable(name)?;
                        ctx.filters.extend(var_filters);
                    }
                }
                // Resolve references from the `variables` field.
                // Each name is tried as a table variable first, then as a named context.
                for var_name in variables {
                    if self.model.table_variable(var_name).is_ok() {
                        let (_base_table, var_filters) = self.resolve_table_variable(var_name)?;
                        ctx.filters.extend(var_filters);
                    } else if self.model.context(var_name).is_ok() {
                        self.expand_context(var_name, ctx, &mut HashSet::new())?;
                    } else {
                        return Err(EngineError::InvalidData(format!(
                            "'{var_name}' is not a table variable or named context"
                        )));
                    }
                }
                let inner = self.walk(expr, ctx)?;
                for filter in filters {
                    ctx.filters.push(ResolvedFilter::from_predicate(filter));
                }
                // Collect expression-based conditions into the context.
                ctx.conditions.extend(conditions.clone());
                // Resolve IN-membership predicates (merged from KEEPIN).
                for pred in in_predicates {
                    let (base_table, var_filters) = self.resolve_table_variable(&pred.var_name)?;
                    ctx.in_filters.push(ResolvedInFilter {
                        table: pred.table.clone(),
                        column: pred.column.clone(),
                        var_base_table: base_table,
                        var_column: pred.var_column.clone(),
                        var_filters,
                        negated: pred.negated,
                    });
                }
                Ok(inner)
            }

            Expression::Clear {
                expr,
                targets,
                level,
            } => {
                let inner = self.walk(expr, ctx)?;
                ctx.record_clear(targets, LevelRange::through(clear_ceiling(*level)?));
                Ok(inner)
            }

            Expression::Reset { expr, level } => {
                let inner = self.walk(expr, ctx)?;
                ctx.record_reset(LevelRange::through(clear_ceiling(*level)?));
                Ok(inner)
            }

            Expression::ClearInner { expr, targets } => {
                let inner = self.walk(expr, ctx)?;
                ctx.record_clear(targets, LevelRange::axis_only());
                Ok(inner)
            }

            Expression::ClearOuter {
                expr,
                targets,
                level,
            } => {
                let inner = self.walk(expr, ctx)?;
                ctx.record_clear(targets, LevelRange::outer(outer_ceiling(*level)?));
                Ok(inner)
            }

            Expression::ResetInner { expr } => {
                let inner = self.walk(expr, ctx)?;
                ctx.record_reset(LevelRange::axis_only());
                Ok(inner)
            }

            Expression::ResetOuter { expr, level } => {
                let inner = self.walk(expr, ctx)?;
                ctx.record_reset(LevelRange::outer(outer_ceiling(*level)?));
                Ok(inner)
            }

            Expression::Traverse { expr, path } => {
                let inner = self.walk(expr, ctx)?;
                // Validate that each hop in the path corresponds to a real relationship
                self.validate_traversal_path(path)?;
                ctx.traversals.push(path.clone());
                Ok(inner)
            }

            Expression::Using { expr, context_name } => {
                let inner = self.walk(expr, ctx)?;
                // Expand the named context
                self.expand_context(context_name, ctx, &mut HashSet::new())?;
                Ok(inner)
            }

            Expression::UseRelationship {
                expr,
                relationship_name,
            } => {
                let inner = self.walk(expr, ctx)?;
                // Validate the relationship exists (active or inactive)
                self.model.relationship(relationship_name)?;
                ctx.relationship_overrides.push(relationship_name.clone());
                Ok(inner)
            }

            Expression::KeepIn { expr, predicates } => {
                let inner = self.walk(expr, ctx)?;
                for pred in predicates {
                    let (base_table, var_filters) = self.resolve_table_variable(&pred.var_name)?;
                    ctx.in_filters.push(ResolvedInFilter {
                        table: pred.table.clone(),
                        column: pred.column.clone(),
                        var_base_table: base_table,
                        var_column: pred.var_column.clone(),
                        var_filters,
                        negated: pred.negated,
                    });
                }
                Ok(inner)
            }

            Expression::Block {
                bindings,
                query_scoped_bindings,
                result,
            } => {
                // Walk binding expressions to strip context ops from scalar
                // bindings, but leave Query bindings untouched — their
                // aggregate expressions carry context ops that must be
                // resolved during QUERY materialization (not here).
                //
                // Query-scoped (GVAR) bindings are normally resolved to literals
                // and emptied by the facade before context resolution runs;
                // strip and preserve them the same way so a survivor is never
                // silently dropped.
                let strip_binding = |slf: &Self,
                                     name: &str,
                                     binding_expr: &Expression|
                 -> EngineResult<(String, Expression)> {
                    if matches!(binding_expr, Expression::Query { .. }) {
                        // Keep Query bindings as-is; context is resolved
                        // during materialize_query / materialize_query_in_pipeline.
                        Ok((name.to_string(), binding_expr.clone()))
                    } else {
                        let mut binding_ctx = EvaluationContext::new();
                        let stripped = slf.walk(binding_expr, &mut binding_ctx)?;
                        Ok((name.to_string(), stripped))
                    }
                };
                let mut stripped_bindings = Vec::new();
                for (name, binding_expr) in bindings {
                    stripped_bindings.push(strip_binding(self, name, binding_expr)?);
                }
                let mut stripped_query_scoped = Vec::new();
                for (name, binding_expr) in query_scoped_bindings {
                    stripped_query_scoped.push(strip_binding(self, name, binding_expr)?);
                }
                let stripped_result = self.walk(result, ctx)?;
                Ok(Expression::Block {
                    bindings: stripped_bindings,
                    query_scoped_bindings: stripped_query_scoped,
                    result: Box::new(stripped_result),
                })
            }

            // New expression types — no context modification, just recurse.
            Expression::LiteralString(_) | Expression::Blank => Ok(expr.clone()),

            Expression::Comparison { left, op, right } => {
                let left = self.walk(left, ctx)?;
                let right = self.walk(right, ctx)?;
                Ok(Expression::Comparison {
                    left: Box::new(left),
                    op: *op,
                    right: Box::new(right),
                })
            }

            Expression::And(left, right) => {
                let left = self.walk(left, ctx)?;
                let right = self.walk(right, ctx)?;
                Ok(Expression::And(Box::new(left), Box::new(right)))
            }

            Expression::Or(left, right) => {
                let left = self.walk(left, ctx)?;
                let right = self.walk(right, ctx)?;
                Ok(Expression::Or(Box::new(left), Box::new(right)))
            }

            Expression::Not(inner) => {
                let inner = self.walk(inner, ctx)?;
                Ok(Expression::Not(Box::new(inner)))
            }

            Expression::Xor(left, right) => {
                let left = self.walk(left, ctx)?;
                let right = self.walk(right, ctx)?;
                Ok(Expression::Xor(Box::new(left), Box::new(right)))
            }

            Expression::IsBlank(inner) => {
                let inner = self.walk(inner, ctx)?;
                Ok(Expression::IsBlank(Box::new(inner)))
            }

            Expression::If {
                condition,
                then_expr,
                else_expr,
            } => {
                let condition = self.walk(condition, ctx)?;
                let then_expr = self.walk(then_expr, ctx)?;
                let else_expr = self.walk(else_expr, ctx)?;
                Ok(Expression::If {
                    condition: Box::new(condition),
                    then_expr: Box::new(then_expr),
                    else_expr: Box::new(else_expr),
                })
            }

            Expression::Switch {
                expr: switch_expr,
                cases,
                default,
            } => {
                let switch_expr = self.walk(switch_expr, ctx)?;
                let mut walked_cases = Vec::new();
                for (val, result) in cases {
                    let val = self.walk(val, ctx)?;
                    let result = self.walk(result, ctx)?;
                    walked_cases.push((val, result));
                }
                let default = default.as_ref().map(|d| self.walk(d, ctx)).transpose()?;
                Ok(Expression::Switch {
                    expr: Box::new(switch_expr),
                    cases: walked_cases,
                    default: default.map(Box::new),
                })
            }

            Expression::SafeDivide {
                numerator,
                denominator,
                alternate,
            } => {
                let numerator = self.walk(numerator, ctx)?;
                let denominator = self.walk(denominator, ctx)?;
                let alternate = alternate.as_ref().map(|a| self.walk(a, ctx)).transpose()?;
                Ok(Expression::SafeDivide {
                    numerator: Box::new(numerator),
                    denominator: Box::new(denominator),
                    alternate: alternate.map(Box::new),
                })
            }

            Expression::Coalesce(exprs) => {
                let walked: Vec<Expression> = exprs
                    .iter()
                    .map(|e| self.walk(e, ctx))
                    .collect::<EngineResult<_>>()?;
                Ok(Expression::Coalesce(walked))
            }

            Expression::ScalarFunc { function, args } => {
                let walked: Vec<Expression> = args
                    .iter()
                    .map(|e| self.walk(e, ctx))
                    .collect::<EngineResult<_>>()?;
                Ok(Expression::ScalarFunc {
                    function: *function,
                    args: walked,
                })
            }

            Expression::TextFunc { function, args } => {
                let walked: Vec<Expression> = args
                    .iter()
                    .map(|e| self.walk(e, ctx))
                    .collect::<EngineResult<_>>()?;
                Ok(Expression::TextFunc {
                    function: *function,
                    args: walked,
                })
            }

            Expression::Query {
                aggregates,
                group_by,
                top,
            } => {
                // Walk aggregate expressions to resolve any context ops within them.
                let walked_aggs: Vec<(Expression, String)> = aggregates
                    .iter()
                    .map(|(e, alias)| {
                        let walked = self.walk(e, ctx)?;
                        Ok((walked, alias.clone()))
                    })
                    .collect::<EngineResult<_>>()?;
                Ok(Expression::Query {
                    aggregates: walked_aggs,
                    group_by: group_by.clone(),
                    top: top.clone(),
                })
            }

            Expression::HasOneValue { column } => {
                let column = self.walk(column, ctx)?;
                Ok(Expression::HasOneValue {
                    column: Box::new(column),
                })
            }

            Expression::SelectedValue { column, alternate } => {
                let column = self.walk(column, ctx)?;
                let alternate = alternate.as_ref().map(|a| self.walk(a, ctx)).transpose()?;
                Ok(Expression::SelectedValue {
                    column: Box::new(column),
                    alternate: alternate.map(Box::new),
                })
            }

            Expression::FirstValue { column, order_by } => {
                let column = self.walk(column, ctx)?;
                let order_by = self.walk(order_by, ctx)?;
                Ok(Expression::FirstValue {
                    column: Box::new(column),
                    order_by: Box::new(order_by),
                })
            }

            // Window functions: recurse into inner expression only.
            // order_by/partition_by are structural, not context-sensitive.
            Expression::Window {
                inner,
                function,
                order_by,
                partition_by,
                frame,
            } => {
                let inner = self.walk(inner, ctx)?;
                Ok(Expression::Window {
                    inner: Box::new(inner),
                    function: *function,
                    order_by: order_by.clone(),
                    partition_by: partition_by.clone(),
                    frame: frame.clone(),
                })
            }
            Expression::Offset {
                inner,
                delta,
                order_by,
                partition_by,
            } => {
                let inner = self.walk(inner, ctx)?;
                Ok(Expression::Offset {
                    inner: Box::new(inner),
                    delta: *delta,
                    order_by: order_by.clone(),
                    partition_by: partition_by.clone(),
                })
            }
            Expression::Index {
                inner,
                position,
                order_by,
                partition_by,
            } => {
                let inner = self.walk(inner, ctx)?;
                Ok(Expression::Index {
                    inner: Box::new(inner),
                    position: *position,
                    order_by: order_by.clone(),
                    partition_by: partition_by.clone(),
                })
            }

            // Time-intelligence sugar: recurse into the inner measure only.
            // The granularity is structural; the date axis is resolved from
            // the query's group_by when the node is lowered to Window/Offset.
            Expression::ToDate {
                expr: inner,
                granularity,
            } => {
                let inner = self.walk(inner, ctx)?;
                Ok(Expression::ToDate {
                    expr: Box::new(inner),
                    granularity: *granularity,
                })
            }
            Expression::PeriodShift {
                expr: inner,
                offset,
                granularity,
            } => {
                let inner = self.walk(inner, ctx)?;
                Ok(Expression::PeriodShift {
                    expr: Box::new(inner),
                    offset: *offset,
                    granularity: *granularity,
                })
            }
            Expression::DatesInPeriod {
                expr: inner,
                intervals,
                granularity,
            } => {
                let inner = self.walk(inner, ctx)?;
                Ok(Expression::DatesInPeriod {
                    expr: Box::new(inner),
                    intervals: *intervals,
                    granularity: *granularity,
                })
            }
            Expression::DatesBetween {
                expr: inner,
                start,
                end,
            } => {
                let inner = self.walk(inner, ctx)?;
                Ok(Expression::DatesBetween {
                    expr: Box::new(inner),
                    start: start.clone(),
                    end: end.clone(),
                })
            }
            Expression::SemiAdditiveBalance {
                expr: inner,
                opening,
                shift_days,
                non_blank,
            } => {
                let inner = self.walk(inner, ctx)?;
                Ok(Expression::SemiAdditiveBalance {
                    expr: Box::new(inner),
                    opening: *opening,
                    shift_days: *shift_days,
                    non_blank: *non_blank,
                })
            }

            Expression::InList {
                expr,
                values,
                negated,
            } => {
                let expr = self.walk(expr, ctx)?;
                let walked: Vec<Expression> = values
                    .iter()
                    .map(|v| self.walk(v, ctx))
                    .collect::<EngineResult<_>>()?;
                Ok(Expression::InList {
                    expr: Box::new(expr),
                    values: walked,
                    negated: *negated,
                })
            }

            // Date/time functions: recurse into args.
            Expression::DateTimeFunc { function, args } => {
                let walked: Vec<Expression> = args
                    .iter()
                    .map(|e| self.walk(e, ctx))
                    .collect::<EngineResult<_>>()?;
                Ok(Expression::DateTimeFunc {
                    function: *function,
                    args: walked,
                })
            }

            // IFERROR: recurse into both sub-expressions.
            Expression::IfError { expr, alternate } => {
                let expr = self.walk(expr, ctx)?;
                let alternate = self.walk(alternate, ctx)?;
                Ok(Expression::IfError {
                    expr: Box::new(expr),
                    alternate: Box::new(alternate),
                })
            }

            // ISINSCOPE: leaf node, no context modification.
            Expression::IsInScope { .. }
            | Expression::IsFiltered { .. }
            | Expression::ThisRow { .. }
            // Row-level by validation (no context ops inside): nothing to
            // resolve here; materialization handles the lookup join.
            | Expression::LookupValue { .. } => Ok(expr.clone()),

            // CLEAREXCEPT: context operation — clears table but preserves specified columns.
            Expression::ClearExcept {
                expr: inner,
                table,
                except_columns,
            } => {
                let inner = self.walk(inner, ctx)?;
                ctx.clear_except
                    .entry(table.clone())
                    .or_default()
                    .extend(except_columns.iter().cloned());
                Ok(inner)
            }

            // ITERATE: transparent — just recurse into expression.
            Expression::Iterate { table, expression } => {
                let expression = self.walk(expression, ctx)?;
                Ok(Expression::Iterate {
                    table: table.clone(),
                    expression: Box::new(expression),
                })
            }

            // PERCENTILE: implicit aggregate, recurse into operand.
            Expression::Percentile {
                operand,
                percentile,
            } => {
                let operand = self.walk(operand, ctx)?;
                let percentile = self.walk(percentile, ctx)?;
                Ok(Expression::Percentile {
                    operand: Box::new(operand),
                    percentile: Box::new(percentile),
                })
            }

            // GREATEST / LEAST: recurse into all args.
            Expression::Greatest(args) => {
                let args = args
                    .iter()
                    .map(|a| self.walk(a, ctx))
                    .collect::<EngineResult<Vec<_>>>()?;
                Ok(Expression::Greatest(args))
            }
            Expression::Least(args) => {
                let args = args
                    .iter()
                    .map(|a| self.walk(a, ctx))
                    .collect::<EngineResult<Vec<_>>>()?;
                Ok(Expression::Least(args))
            }
            // NULLIF: recurse into both.
            Expression::NullIf { expr, value } => {
                let expr = self.walk(expr, ctx)?;
                let value = self.walk(value, ctx)?;
                Ok(Expression::NullIf {
                    expr: Box::new(expr),
                    value: Box::new(value),
                })
            }
            // COUNTIF: implicit aggregate, recurse into condition.
            Expression::CountIf { condition } => {
                let condition = self.walk(condition, ctx)?;
                Ok(Expression::CountIf {
                    condition: Box::new(condition),
                })
            }
            // LISTAGG: implicit aggregate, recurse into both.
            Expression::ListAgg { column, delimiter } => {
                let column = self.walk(column, ctx)?;
                let delimiter = self.walk(delimiter, ctx)?;
                Ok(Expression::ListAgg {
                    column: Box::new(column),
                    delimiter: Box::new(delimiter),
                })
            }
            // MAX_BY / MIN_BY: implicit aggregate, recurse into both.
            Expression::MaxBy { value, sort_by } => {
                let value = self.walk(value, ctx)?;
                let sort_by = self.walk(sort_by, ctx)?;
                Ok(Expression::MaxBy {
                    value: Box::new(value),
                    sort_by: Box::new(sort_by),
                })
            }
            Expression::MinBy { value, sort_by } => {
                let value = self.walk(value, ctx)?;
                let sort_by = self.walk(sort_by, ctx)?;
                Ok(Expression::MinBy {
                    value: Box::new(value),
                    sort_by: Box::new(sort_by),
                })
            }
            // RankWindow: no inner expression to recurse into.
            Expression::RankWindow { .. } => Ok(expr.clone()),
            // UDF call: row-level function, recurse into arguments.
            Expression::Call { name, args } => {
                let walked: Vec<Expression> = args
                    .iter()
                    .map(|e| self.walk(e, ctx))
                    .collect::<EngineResult<_>>()?;
                Ok(Expression::Call {
                    name: name.clone(),
                    args: walked,
                })
            }
        }
    }

    /// Expand a named context definition into the evaluation context.
    fn expand_context(
        &self,
        name: &str,
        ctx: &mut EvaluationContext,
        visited: &mut HashSet<String>,
    ) -> EngineResult<()> {
        if !visited.insert(name.to_string()) {
            return Err(EngineError::InvalidContext {
                name: name.to_string(),
                reason: "circular context reference".into(),
            });
        }

        let context_def = self.model.context(name)?;
        for op in context_def.operations() {
            match op {
                ContextOp::Keep(filters) => {
                    for filter in filters {
                        ctx.filters.push(ResolvedFilter::from_predicate(filter));
                    }
                }
                ContextOp::Clear { targets, level } => {
                    ctx.record_clear(targets, LevelRange::through(clear_ceiling(*level)?));
                }
                ContextOp::Reset { level } => {
                    ctx.record_reset(LevelRange::through(clear_ceiling(*level)?));
                }
                ContextOp::ClearInner(targets) => {
                    ctx.record_clear(targets, LevelRange::axis_only());
                }
                ContextOp::ClearOuter { targets, level } => {
                    ctx.record_clear(targets, LevelRange::outer(outer_ceiling(*level)?));
                }
                ContextOp::ResetInner => {
                    ctx.record_reset(LevelRange::axis_only());
                }
                ContextOp::ResetOuter { level } => {
                    ctx.record_reset(LevelRange::outer(outer_ceiling(*level)?));
                }
                ContextOp::KeepIn(predicates) => {
                    for pred in predicates {
                        let (base_table, var_filters) =
                            self.resolve_table_variable(&pred.var_name)?;
                        ctx.in_filters.push(ResolvedInFilter {
                            table: pred.table.clone(),
                            column: pred.column.clone(),
                            var_base_table: base_table,
                            var_column: pred.var_column.clone(),
                            var_filters,
                            negated: pred.negated,
                        });
                    }
                }
                ContextOp::Inherit(parent_name) => {
                    self.expand_context(parent_name, ctx, visited)?;
                }
                ContextOp::UseRelationship(rel_name) => {
                    // Validate the relationship exists
                    self.model.relationship(rel_name)?;
                    ctx.relationship_overrides.push(rel_name.clone());
                }
            }
        }
        Ok(())
    }

    /// Validate that a traversal path consists of valid relationship hops.
    fn validate_traversal_path(&self, path: &RelationshipPath) -> EngineResult<()> {
        if path.hops.len() < 2 {
            return Err(EngineError::InvalidContext {
                name: "traverse".into(),
                reason: "traversal path must contain at least two tables".into(),
            });
        }
        for window in path.hops.windows(2) {
            let from = &window[0];
            let to = &window[1];
            self.model.find_relationship(from, to)?;
        }
        Ok(())
    }

    /// Resolve a table variable to its base table and accumulated filters.
    ///
    /// Walks the variable chain until a base table is reached, collecting
    /// filters from each variable in the chain. Returns `(base_table_name, filters)`.
    fn resolve_table_variable(&self, name: &str) -> EngineResult<(String, Vec<ResolvedFilter>)> {
        let mut filters = Vec::new();
        let mut current = name.to_string();
        let mut visited = HashSet::new();

        loop {
            if !visited.insert(current.clone()) {
                return Err(EngineError::InvalidTableVariable {
                    name: name.to_string(),
                    reason: format!("circular reference involving '{current}'"),
                });
            }

            let var = match self.model.table_variable(&current) {
                Ok(var) => var,
                // Raw MODEL TABLE as the set provider (the TREATAS form:
                // `target IN (SELECT col FROM source_table)`, no filters of
                // its own — the query's own filters on the source apply at
                // fetch time).
                Err(_) if self.model.table(&current).is_ok() => {
                    return Ok((current, filters));
                }
                Err(e) => return Err(e),
            };
            // Add this variable's filters
            for filter in var.filters() {
                filters.push(ResolvedFilter::from_predicate(filter));
            }

            // Check if the source is another variable or a base table
            if self.model.table_variable(var.source()).is_ok() {
                current = var.source().to_string();
            } else {
                // Source is a base table
                return Ok((var.source().to_string(), filters));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute::aggregate::AggregateOp;
    use crate::compute::expression::{self as expr, ComparisonOp};
    use crate::model::column::Column;
    use crate::model::context::{ContextDefinition, ContextOp};
    use crate::model::relationship::Relationship;
    use crate::model::table::Table;
    use crate::model::table_variable::TableVariable;
    use crate::model::Cardinality;
    use crate::types::DataType;

    fn test_model() -> DataModel {
        DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("amount", DataType::Float64),
                        Column::new("product_id", DataType::Int64),
                        Column::new("region", DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "Products",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("category", DataType::String),
                        Column::new("color", DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "Calendar",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("year", DataType::Int32),
                    ],
                )
                .unwrap(),
            )
            .add_relationship(Relationship::many_to_one(
                "Sales_Products",
                "Sales",
                "product_id",
                "Products",
                "id",
            ))
            .build()
            .unwrap()
    }

    #[test]
    fn format_filter_value_escapes_injection_payload() {
        let model = test_model();
        let rendered = format_filter_value("Sales", "region", "x'); DROP TABLE t; --", &model);
        assert_eq!(rendered, "'x''); DROP TABLE t; --'");
        assert!(rendered.contains("''"));
        assert!(!rendered.contains("x');"));
    }

    #[test]
    fn format_filter_value_leaves_numeric_values_bare() {
        let model = test_model();
        let rendered = format_filter_value("Sales", "amount", "42.5", &model);
        assert_eq!(rendered, "42.5");
    }

    #[test]
    fn to_sql_condition_escapes_embedded_identifier_quote() {
        let model = test_model();
        let filter = ResolvedFilter {
            table: "Sales".into(),
            column: "evil\"name".into(),
            operator: ComparisonOp::Equal,
            value: "US".into(),
            source: FilterSource::Query,
            level: 1,
        };
        let sql = filter.to_sql_condition("t", &model);
        assert_eq!(sql, "t.\"evil\"\"name\" = 'US'");
    }

    fn test_model_with_contexts() -> DataModel {
        DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("amount", DataType::Float64),
                        Column::new("region", DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "Products",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("category", DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_context(ContextDefinition::new(
                "ctx_us",
                vec![ContextOp::Keep(vec![FilterPredicate::new(
                    "Sales",
                    "region",
                    ComparisonOp::Equal,
                    "US",
                )])],
            ))
            .add_context(ContextDefinition::new(
                "ctx_us_bikes",
                vec![
                    ContextOp::Inherit("ctx_us".into()),
                    ContextOp::Keep(vec![FilterPredicate::new(
                        "Products",
                        "category",
                        ComparisonOp::Equal,
                        "Bikes",
                    )]),
                ],
            ))
            .add_context(ContextDefinition::new(
                "ctx_no_region",
                vec![ContextOp::Clear {
                    targets: vec![ClearTarget::Column {
                        table: "Sales".into(),
                        column: "region".into(),
                    }],
                    level: None,
                }],
            ))
            .add_context(ContextDefinition::new(
                "ctx_reset",
                vec![ContextOp::Reset { level: None }],
            ))
            .build()
            .unwrap()
    }

    #[test]
    fn resolve_plain_expression() {
        let model = test_model();
        let resolver = ContextResolver::new(&model);
        let expr = expr::agg(AggregateOp::Sum, expr::col("amount"));
        let (stripped, ctx) = resolver.resolve(&expr).unwrap();

        assert_eq!(stripped.to_sql_string().unwrap(), "SUM(\"amount\")");
        assert!(ctx.filters.is_empty());
        assert!(ctx.reset.is_none());
    }

    #[test]
    fn resolve_keep_extracts_filters() {
        let model = test_model();
        let resolver = ContextResolver::new(&model);
        let expression = expr::agg(
            AggregateOp::Sum,
            expr::keep(
                expr::col("amount"),
                vec![FilterPredicate::new(
                    "Sales",
                    "region",
                    ComparisonOp::Equal,
                    "US",
                )],
            ),
        );
        let (stripped, ctx) = resolver.resolve(&expression).unwrap();

        assert_eq!(stripped.to_sql_string().unwrap(), "SUM(\"amount\")");
        assert_eq!(ctx.filters.len(), 1);
        assert_eq!(ctx.filters[0].table, "Sales");
        assert_eq!(ctx.filters[0].column, "region");
        assert_eq!(ctx.filters[0].value, "US");
    }

    #[test]
    fn resolve_multiple_keeps() {
        let model = test_model();
        let resolver = ContextResolver::new(&model);
        let expression = expr::agg(
            AggregateOp::Sum,
            expr::keep(
                expr::keep(
                    expr::col("amount"),
                    vec![FilterPredicate::new(
                        "Sales",
                        "region",
                        ComparisonOp::Equal,
                        "US",
                    )],
                ),
                vec![FilterPredicate::new(
                    "Products",
                    "category",
                    ComparisonOp::Equal,
                    "Bikes",
                )],
            ),
        );
        let (stripped, ctx) = resolver.resolve(&expression).unwrap();

        assert_eq!(stripped.to_sql_string().unwrap(), "SUM(\"amount\")");
        assert_eq!(ctx.filters.len(), 2);
    }

    #[test]
    fn resolve_clear_records_targets() {
        let model = test_model();
        let resolver = ContextResolver::new(&model);
        let expression = expr::agg(
            AggregateOp::Sum,
            expr::clear(
                expr::col("amount"),
                vec![ClearTarget::Column {
                    table: "Sales".into(),
                    column: "region".into(),
                }],
            ),
        );
        let (_, ctx) = resolver.resolve(&expression).unwrap();

        assert_eq!(
            ctx.cleared_columns.get(&("Sales".into(), "region".into())),
            Some(&LevelRange::through(LEVEL_SLICER))
        );
    }

    #[test]
    fn resolve_reset_sets_flag() {
        let model = test_model();
        let resolver = ContextResolver::new(&model);
        let expression = expr::agg(AggregateOp::Sum, expr::reset(expr::col("amount")));
        let (_, ctx) = resolver.resolve(&expression).unwrap();

        assert_eq!(ctx.reset, Some(LevelRange::through(LEVEL_SLICER)));
    }

    #[test]
    fn effective_filters_with_keep() {
        let outer = vec![ResolvedFilter::new(
            "Sales",
            "region",
            ComparisonOp::Equal,
            "EU",
        )];

        let mut ctx = EvaluationContext::new();
        ctx.filters.push(ResolvedFilter::new(
            "Calendar",
            "year",
            ComparisonOp::Equal,
            "2024",
        ));

        let effective = ctx.effective_filters(&outer);
        // Both outer (region=EU) and inner (year=2024)
        assert_eq!(effective.len(), 2);
    }

    #[test]
    fn effective_filters_with_clear() {
        let outer = vec![
            ResolvedFilter::new("Sales", "region", ComparisonOp::Equal, "EU"),
            ResolvedFilter::new("Calendar", "year", ComparisonOp::Equal, "2024"),
        ];

        let mut ctx = EvaluationContext::new();
        ctx.cleared_columns.insert(
            ("Sales".into(), "region".into()),
            LevelRange::through(LEVEL_SLICER),
        );

        let effective = ctx.effective_filters(&outer);
        // Only year=2024 passes through (region was cleared)
        assert_eq!(effective.len(), 1);
        assert_eq!(effective[0].column, "year");
    }

    #[test]
    fn effective_filters_with_reset() {
        let outer = vec![ResolvedFilter::new(
            "Sales",
            "region",
            ComparisonOp::Equal,
            "EU",
        )];

        let mut ctx = EvaluationContext::new();
        ctx.record_reset(LevelRange::through(LEVEL_SLICER));

        let effective = ctx.effective_filters(&outer);
        assert!(effective.is_empty());
    }

    #[test]
    fn effective_filters_override_pattern() {
        // clear(Year) + keep(Year = 2024) → replaces outer Year filter
        let outer = vec![ResolvedFilter::new(
            "Calendar",
            "year",
            ComparisonOp::Equal,
            "2023",
        )];

        let mut ctx = EvaluationContext::new();
        ctx.cleared_columns.insert(
            ("Calendar".into(), "year".into()),
            LevelRange::through(LEVEL_SLICER),
        );
        ctx.filters.push(ResolvedFilter::new(
            "Calendar",
            "year",
            ComparisonOp::Equal,
            "2024",
        ));

        let effective = ctx.effective_filters(&outer);
        assert_eq!(effective.len(), 1);
        assert_eq!(effective[0].value, "2024"); // Replaced, not 2023
    }

    #[test]
    fn resolve_using_expands_context() {
        let model = test_model_with_contexts();
        let resolver = ContextResolver::new(&model);
        let expression = expr::agg(AggregateOp::Sum, expr::using(expr::col("amount"), "ctx_us"));
        let (stripped, ctx) = resolver.resolve(&expression).unwrap();

        assert_eq!(stripped.to_sql_string().unwrap(), "SUM(\"amount\")");
        assert_eq!(ctx.filters.len(), 1);
        assert_eq!(ctx.filters[0].table, "Sales");
        assert_eq!(ctx.filters[0].column, "region");
        assert_eq!(ctx.filters[0].value, "US");
    }

    #[test]
    fn resolve_using_with_inheritance() {
        let model = test_model_with_contexts();
        let resolver = ContextResolver::new(&model);
        let expression = expr::agg(
            AggregateOp::Sum,
            expr::using(expr::col("amount"), "ctx_us_bikes"),
        );
        let (_, ctx) = resolver.resolve(&expression).unwrap();

        // ctx_us_bikes inherits ctx_us (region=US) and adds category=Bikes
        assert_eq!(ctx.filters.len(), 2);
    }

    #[test]
    fn resolve_using_with_clear() {
        let model = test_model_with_contexts();
        let resolver = ContextResolver::new(&model);
        let expression = expr::agg(
            AggregateOp::Sum,
            expr::using(expr::col("amount"), "ctx_no_region"),
        );
        let (_, ctx) = resolver.resolve(&expression).unwrap();

        assert_eq!(
            ctx.cleared_columns.get(&("Sales".into(), "region".into())),
            Some(&LevelRange::through(LEVEL_SLICER))
        );
    }

    #[test]
    fn resolve_using_with_reset() {
        let model = test_model_with_contexts();
        let resolver = ContextResolver::new(&model);
        let expression = expr::agg(
            AggregateOp::Sum,
            expr::using(expr::col("amount"), "ctx_reset"),
        );
        let (_, ctx) = resolver.resolve(&expression).unwrap();

        assert_eq!(ctx.reset, Some(LevelRange::through(LEVEL_SLICER)));
    }

    #[test]
    fn resolve_using_unknown_context_errors() {
        let model = test_model_with_contexts();
        let resolver = ContextResolver::new(&model);
        let expression = expr::using(expr::col("amount"), "nonexistent");
        let result = resolver.resolve(&expression);
        assert!(result.is_err());
    }

    #[test]
    fn resolve_traverse_validates_path() {
        let model = test_model();
        let resolver = ContextResolver::new(&model);

        // Valid path
        let expression = expr::traverse(
            expr::col("amount"),
            RelationshipPath::new(vec!["Sales", "Products"]),
        );
        let (_, ctx) = resolver.resolve(&expression).unwrap();
        assert_eq!(ctx.traversals.len(), 1);

        // Invalid path (no relationship)
        let bad_expr = expr::traverse(
            expr::col("amount"),
            RelationshipPath::new(vec!["Sales", "Calendar"]),
        );
        assert!(resolver.resolve(&bad_expr).is_err());
    }

    #[test]
    fn resolve_traverse_rejects_single_hop() {
        let model = test_model();
        let resolver = ContextResolver::new(&model);
        let expression = expr::traverse(expr::col("amount"), RelationshipPath::new(vec!["Sales"]));
        assert!(resolver.resolve(&expression).is_err());
    }

    #[test]
    fn resolve_nested_keep_clear_pattern() {
        // keep(clear(amount, Year), Year = 2024) — the "override" pattern
        let model = test_model();
        let resolver = ContextResolver::new(&model);
        let expression = expr::agg(
            AggregateOp::Sum,
            expr::keep(
                expr::clear(
                    expr::col("amount"),
                    vec![ClearTarget::Column {
                        table: "Calendar".into(),
                        column: "year".into(),
                    }],
                ),
                vec![FilterPredicate::new(
                    "Calendar",
                    "year",
                    ComparisonOp::Equal,
                    "2024",
                )],
            ),
        );
        let (stripped, ctx) = resolver.resolve(&expression).unwrap();

        assert_eq!(stripped.to_sql_string().unwrap(), "SUM(\"amount\")");
        assert!(ctx
            .cleared_columns
            .contains_key(&("Calendar".into(), "year".into())));
        assert_eq!(ctx.filters.len(), 1);
        assert_eq!(ctx.filters[0].value, "2024");

        // Test effective_filters: outer Year=2023 should be replaced by inner Year=2024
        let outer = vec![ResolvedFilter::new(
            "Calendar",
            "year",
            ComparisonOp::Equal,
            "2023",
        )];
        let effective = ctx.effective_filters(&outer);
        assert_eq!(effective.len(), 1);
        assert_eq!(effective[0].value, "2024");
    }

    #[test]
    fn resolve_clear_table() {
        let model = test_model();
        let resolver = ContextResolver::new(&model);
        let expression = expr::clear(
            expr::col("amount"),
            vec![ClearTarget::Table("Sales".into())],
        );
        let (_, ctx) = resolver.resolve(&expression).unwrap();

        assert_eq!(
            ctx.cleared_tables.get("Sales"),
            Some(&LevelRange::through(LEVEL_SLICER))
        );

        // All Sales filters should be cleared
        let outer = vec![
            ResolvedFilter::new("Sales", "region", ComparisonOp::Equal, "US"),
            ResolvedFilter::new("Products", "color", ComparisonOp::Equal, "Red"),
        ];
        let effective = ctx.effective_filters(&outer);
        assert_eq!(effective.len(), 1);
        assert_eq!(effective[0].table, "Products");
    }

    // --- Source-specific filter tests ---

    #[test]
    fn clear_inner_only_clears_groupby_filters() {
        let outer = vec![
            ResolvedFilter::new("Sales", "region", ComparisonOp::Equal, "US")
                .with_source(FilterSource::GroupBy),
            ResolvedFilter::new("Calendar", "year", ComparisonOp::Equal, "2024")
                .with_source(FilterSource::Query),
        ];

        let mut ctx = EvaluationContext::new();
        ctx.cleared_columns.insert(
            ("Sales".into(), "region".into()),
            LevelRange::axis_only(),
        );

        let effective = ctx.effective_filters(&outer);
        // GroupBy region filter cleared, Query year filter kept
        assert_eq!(effective.len(), 1);
        assert_eq!(effective[0].column, "year");
    }

    #[test]
    fn clear_outer_only_clears_query_filters() {
        let outer = vec![
            ResolvedFilter::new("Sales", "region", ComparisonOp::Equal, "US")
                .with_source(FilterSource::GroupBy),
            ResolvedFilter::new("Calendar", "year", ComparisonOp::Equal, "2024")
                .with_source(FilterSource::Query),
        ];

        let mut ctx = EvaluationContext::new();
        ctx.cleared_columns.insert(
            ("Calendar".into(), "year".into()),
            LevelRange::outer(LEVEL_SLICER),
        );

        let effective = ctx.effective_filters(&outer);
        // Query year filter cleared, GroupBy region filter kept
        assert_eq!(effective.len(), 1);
        assert_eq!(effective[0].column, "region");
    }

    #[test]
    fn reset_inner_only_resets_groupby_filters() {
        let outer = vec![
            ResolvedFilter::new("Sales", "region", ComparisonOp::Equal, "US")
                .with_source(FilterSource::GroupBy),
            ResolvedFilter::new("Calendar", "year", ComparisonOp::Equal, "2024")
                .with_source(FilterSource::Query),
        ];

        let mut ctx = EvaluationContext::new();
        ctx.record_reset(LevelRange::axis_only());

        let effective = ctx.effective_filters(&outer);
        // All GroupBy filters removed, Query filters kept
        assert_eq!(effective.len(), 1);
        assert_eq!(effective[0].column, "year");
        assert_eq!(effective[0].source, FilterSource::Query);
    }

    #[test]
    fn reset_outer_only_resets_query_filters() {
        let outer = vec![
            ResolvedFilter::new("Sales", "region", ComparisonOp::Equal, "US")
                .with_source(FilterSource::GroupBy),
            ResolvedFilter::new("Calendar", "year", ComparisonOp::Equal, "2024")
                .with_source(FilterSource::Query),
        ];

        let mut ctx = EvaluationContext::new();
        ctx.record_reset(LevelRange::outer(LEVEL_SLICER));

        let effective = ctx.effective_filters(&outer);
        // All Query filters removed, GroupBy filters kept
        assert_eq!(effective.len(), 1);
        assert_eq!(effective[0].column, "region");
        assert_eq!(effective[0].source, FilterSource::GroupBy);
    }

    #[test]
    fn clear_both_still_clears_all_sources() {
        let outer = vec![
            ResolvedFilter::new("Sales", "region", ComparisonOp::Equal, "US")
                .with_source(FilterSource::GroupBy),
            ResolvedFilter::new("Sales", "region", ComparisonOp::Equal, "EU")
                .with_source(FilterSource::Query),
        ];

        let mut ctx = EvaluationContext::new();
        ctx.cleared_columns.insert(
            ("Sales".into(), "region".into()),
            LevelRange::through(LEVEL_SLICER),
        );

        let effective = ctx.effective_filters(&outer);
        // Both sources cleared
        assert!(effective.is_empty());
    }

    #[test]
    fn resolve_clear_inner_expression() {
        let model = test_model();
        let resolver = ContextResolver::new(&model);
        let expression = expr::agg(
            AggregateOp::Sum,
            expr::clear_inner(
                expr::col("amount"),
                vec![ClearTarget::Column {
                    table: "Sales".into(),
                    column: "region".into(),
                }],
            ),
        );
        let (stripped, ctx) = resolver.resolve(&expression).unwrap();

        assert_eq!(stripped.to_sql_string().unwrap(), "SUM(\"amount\")");
        // Axis-only range: the slicer level is NOT covered.
        assert_eq!(
            ctx.cleared_columns.get(&("Sales".into(), "region".into())),
            Some(&LevelRange::axis_only())
        );
    }

    #[test]
    fn resolve_clear_outer_expression() {
        let model = test_model();
        let resolver = ContextResolver::new(&model);
        let expression = expr::agg(
            AggregateOp::Sum,
            expr::clear_outer(
                expr::col("amount"),
                vec![ClearTarget::Table("Calendar".into())],
            ),
        );
        let (_, ctx) = resolver.resolve(&expression).unwrap();

        // Outer range: the axis level is NOT covered.
        assert_eq!(
            ctx.cleared_tables.get("Calendar"),
            Some(&LevelRange::outer(LEVEL_SLICER))
        );
    }

    #[test]
    fn resolve_reset_inner_expression() {
        let model = test_model();
        let resolver = ContextResolver::new(&model);
        let expression = expr::agg(AggregateOp::Sum, expr::reset_inner(expr::col("amount")));
        let (_, ctx) = resolver.resolve(&expression).unwrap();

        assert_eq!(ctx.reset, Some(LevelRange::axis_only()));
    }

    #[test]
    fn resolve_reset_outer_expression() {
        let model = test_model();
        let resolver = ContextResolver::new(&model);
        let expression = expr::agg(AggregateOp::Sum, expr::reset_outer(expr::col("amount")));
        let (_, ctx) = resolver.resolve(&expression).unwrap();

        assert_eq!(ctx.reset, Some(LevelRange::outer(LEVEL_SLICER)));
    }

    #[test]
    fn resolve_clear_with_level_records_range() {
        let model = test_model();
        let resolver = ContextResolver::new(&model);
        let expression = expr::agg(
            AggregateOp::Sum,
            expr::clear_at(
                expr::col("amount"),
                vec![ClearTarget::Table("Products".into())],
                Some(2),
            ),
        );
        let (_, ctx) = resolver.resolve(&expression).unwrap();
        assert_eq!(
            ctx.cleared_tables.get("Products"),
            Some(&LevelRange::through(2))
        );

        let expression = expr::agg(AggregateOp::Sum, expr::reset_at(expr::col("amount"), Some(3)));
        let (_, ctx) = resolver.resolve(&expression).unwrap();
        assert_eq!(ctx.reset, Some(LevelRange::through(3)));
    }

    #[test]
    fn resolve_rejects_out_of_range_levels_fail_closed() {
        // The parser never produces these, but a hand-edited model JSON could.
        let model = test_model();
        let resolver = ContextResolver::new(&model);

        let too_high = expr::agg(
            AggregateOp::Sum,
            expr::clear_at(
                expr::col("amount"),
                vec![ClearTarget::Table("Products".into())],
                Some(200),
            ),
        );
        assert!(resolver.resolve(&too_high).is_err());

        // Outer variants cannot express level 0 (the axis is kept).
        let outer_zero = expr::agg(
            AggregateOp::Sum,
            expr::clear_outer_at(
                expr::col("amount"),
                vec![ClearTarget::Table("Products".into())],
                Some(0),
            ),
        );
        assert!(resolver.resolve(&outer_zero).is_err());
    }

    #[test]
    fn level_range_union_is_exact() {
        // Floors are only ever 0 or 1, so min/max union equals set union.
        let axis = LevelRange::axis_only();
        let outer2 = LevelRange::outer(2);
        let both = axis.union(outer2);
        assert_eq!(both, LevelRange { floor: 0, ceiling: 2 });
        for level in 0..=9u8 {
            assert_eq!(
                both.contains(level),
                axis.contains(level) || outer2.contains(level)
            );
        }
    }

    #[test]
    fn pinned_filter_survives_bare_clear_but_not_leveled_clear() {
        // A level-2 (pinned) filter: bare CLEAR ([0,1]) leaves it in place;
        // CLEAR(…, LEVEL 2) ([0,2]) strips it.
        let mut pinned = ResolvedFilter::new("Sales", "region", ComparisonOp::Equal, "US");
        pinned.level = 2;
        let outer = vec![pinned];

        let mut bare = EvaluationContext::new();
        bare.record_clear(
            &[ClearTarget::Table("Sales".into())],
            LevelRange::through(LEVEL_SLICER),
        );
        assert_eq!(bare.effective_filters(&outer).len(), 1);

        let mut leveled = EvaluationContext::new();
        leveled.record_clear(&[ClearTarget::Table("Sales".into())], LevelRange::through(2));
        assert!(leveled.effective_filters(&outer).is_empty());

        // RESET behaves the same way across all tables.
        let mut bare_reset = EvaluationContext::new();
        bare_reset.record_reset(LevelRange::through(LEVEL_SLICER));
        assert_eq!(bare_reset.effective_filters(&outer).len(), 1);

        let mut leveled_reset = EvaluationContext::new();
        leveled_reset.record_reset(LevelRange::through(2));
        assert!(leveled_reset.effective_filters(&outer).is_empty());
    }

    // --- Table variable resolution tests ---

    fn model_with_variables() -> DataModel {
        use crate::compute::expression::FilterPredicate;
        use crate::model::table_variable::TableVariable;

        DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("amount", DataType::Float64),
                        Column::new("product_id", DataType::Int64),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "Products",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("category", DataType::String),
                        Column::new("name", DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_table_variable(TableVariable::new(
                "premium",
                "Products",
                vec![FilterPredicate::new(
                    "Products",
                    "category",
                    ComparisonOp::Equal,
                    "Premium",
                )],
            ))
            .add_table_variable(TableVariable::new(
                "named_premium",
                "premium",
                vec![FilterPredicate::new(
                    "Products",
                    "name",
                    ComparisonOp::NotEqual,
                    "",
                )],
            ))
            .build()
            .unwrap()
    }

    #[test]
    fn resolve_qualified_column_ref_with_variable() {
        let model = model_with_variables();
        let resolver = ContextResolver::new(&model);

        // premium.category should resolve to ColumnRef("category") + variable filters
        let expression = expr::qualified_col("premium", "category");
        let (stripped, ctx) = resolver.resolve(&expression).unwrap();

        // Stripped to plain column ref
        assert!(matches!(stripped, Expression::ColumnRef(ref c) if c == "category"));

        // Variable filters added to context
        assert_eq!(ctx.filters.len(), 1);
        assert_eq!(ctx.filters[0].table, "Products");
        assert_eq!(ctx.filters[0].column, "category");
        assert_eq!(ctx.filters[0].value, "Premium");
    }

    #[test]
    fn resolve_composed_variable_accumulates_filters() {
        let model = model_with_variables();
        let resolver = ContextResolver::new(&model);

        // named_premium.name should resolve both variable chains
        let expression = expr::qualified_col("named_premium", "name");
        let (stripped, ctx) = resolver.resolve(&expression).unwrap();

        assert!(matches!(stripped, Expression::ColumnRef(ref c) if c == "name"));

        // Should have 2 filters: one from named_premium, one from premium
        assert_eq!(ctx.filters.len(), 2);
    }

    #[test]
    fn resolve_qualified_col_regular_table_no_filters() {
        let model = model_with_variables();
        let resolver = ContextResolver::new(&model);

        // Products.category (regular table, not variable) — no filters added
        let expression = expr::qualified_col("Products", "category");
        let (stripped, ctx) = resolver.resolve(&expression).unwrap();

        assert!(matches!(stripped, Expression::ColumnRef(ref c) if c == "category"));
        assert!(ctx.filters.is_empty());
    }

    #[test]
    fn resolve_keep_in_creates_resolved_in_filter() {
        use crate::compute::expression::InPredicate;

        let model = model_with_variables();
        let resolver = ContextResolver::new(&model);

        let expression = expr::agg(
            AggregateOp::Sum,
            expr::keep_in(
                expr::col("amount"),
                vec![InPredicate::new("Sales", "product_id", "premium", "id")],
            ),
        );
        let (_, ctx) = resolver.resolve(&expression).unwrap();

        assert_eq!(ctx.in_filters.len(), 1);
        assert_eq!(ctx.in_filters[0].table, "Sales");
        assert_eq!(ctx.in_filters[0].column, "product_id");
        assert_eq!(ctx.in_filters[0].var_base_table, "Products");
        assert_eq!(ctx.in_filters[0].var_column, "id");
        assert_eq!(ctx.in_filters[0].var_filters.len(), 1);
        assert_eq!(ctx.in_filters[0].var_filters[0].column, "category");
    }

    #[test]
    fn resolve_in_filter_with_composed_variable() {
        use crate::compute::expression::InPredicate;

        let model = model_with_variables();
        let resolver = ContextResolver::new(&model);

        let expression = expr::keep_in(
            expr::col("amount"),
            vec![InPredicate::new(
                "Sales",
                "product_id",
                "named_premium",
                "id",
            )],
        );
        let (_, ctx) = resolver.resolve(&expression).unwrap();

        assert_eq!(ctx.in_filters.len(), 1);
        assert_eq!(ctx.in_filters[0].var_base_table, "Products");
        // named_premium inherits from premium — should have 2 filters
        assert_eq!(ctx.in_filters[0].var_filters.len(), 2);
    }

    #[test]
    fn resolve_keep_with_table_ref_variable() {
        let model = model_with_variables();
        let resolver = ContextResolver::new(&model);

        // keep(table_ref("premium"), [additional_filter])
        let expression = expr::keep(
            expr::table_ref("premium"),
            vec![expr::FilterPredicate::new(
                "Products",
                "name",
                ComparisonOp::Equal,
                "Widget",
            )],
        );
        let (_, ctx) = resolver.resolve(&expression).unwrap();

        // Should have variable filter + keep filter = 2 filters
        assert_eq!(ctx.filters.len(), 2);
        assert!(ctx.filters.iter().any(|f| f.value == "Premium"));
        assert!(ctx.filters.iter().any(|f| f.value == "Widget"));
    }

    #[test]
    fn resolve_keep_with_variables_field() {
        let model = model_with_variables();
        let resolver = ContextResolver::new(&model);

        // keep_vars(aggregate, ["premium"]) — bare variable reference via Keep.variables
        let expression = expr::keep_vars(
            expr::agg(AggregateOp::Sum, expr::col("amount")),
            vec!["premium".to_string()],
        );
        let (stripped, ctx) = resolver.resolve(&expression).unwrap();

        // Should have 1 filter from the "premium" variable.
        assert_eq!(ctx.filters.len(), 1);
        assert!(ctx.filters.iter().any(|f| f.value == "Premium"));
        // Stripped expression should be the aggregate.
        assert!(stripped.has_aggregate());
    }

    #[test]
    fn resolve_keep_with_multiple_variables() {
        // Build a model with two table variables.
        let model = DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("amount", DataType::Decimal(38, 6)),
                        Column::new("productid", DataType::Int32),
                        Column::new("dateid", DataType::Int32),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "Products",
                    vec![
                        Column::new("productid", DataType::Int32),
                        Column::new("category", DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "Calendar",
                    vec![
                        Column::new("dateid", DataType::Int32),
                        Column::new("year", DataType::Int32),
                    ],
                )
                .unwrap(),
            )
            .add_relationship(Relationship::new(
                "sales_products",
                "Sales",
                "productid",
                "Products",
                "productid",
                Cardinality::ManyToOne,
            ))
            .add_relationship(Relationship::new(
                "sales_calendar",
                "Sales",
                "dateid",
                "Calendar",
                "dateid",
                Cardinality::ManyToOne,
            ))
            .add_table_variable(TableVariable::new(
                "bikes",
                "Products",
                vec![FilterPredicate::new(
                    "Products",
                    "category",
                    ComparisonOp::Equal,
                    "Bikes",
                )],
            ))
            .add_table_variable(TableVariable::new(
                "year_2024",
                "Calendar",
                vec![FilterPredicate::new(
                    "Calendar",
                    "year",
                    ComparisonOp::Equal,
                    "2024",
                )],
            ))
            .build()
            .unwrap();

        let resolver = ContextResolver::new(&model);

        // Nested: keep_vars(keep_vars(agg, ["bikes"]), ["year_2024"])
        let inner = expr::keep_vars(
            expr::agg(AggregateOp::Sum, expr::col("amount")),
            vec!["bikes".to_string()],
        );
        let outer = expr::keep_vars(inner, vec!["year_2024".to_string()]);

        let (stripped, ctx) = resolver.resolve(&outer).unwrap();
        let effective = ctx.effective_filters(&[]);

        // Should have 2 filters — one from each variable.
        assert_eq!(effective.len(), 2);
        assert!(effective.iter().any(|f| f.value == "Bikes"));
        assert!(effective.iter().any(|f| f.value == "2024"));
        assert!(stripped.has_aggregate());
    }

    // --- format_filter_value tests ---

    #[test]
    fn format_filter_value_quotes_string_columns() {
        let model = test_model();
        let result = format_filter_value("Sales", "region", "US", &model);
        assert_eq!(result, "'US'");
    }

    #[test]
    fn format_filter_value_bare_numeric_columns() {
        let model = test_model();
        let result = format_filter_value("Sales", "amount", "100.5", &model);
        assert_eq!(result, "100.5");
    }

    #[test]
    fn format_filter_value_bare_int_columns() {
        let model = test_model();
        let result = format_filter_value("Sales", "id", "42", &model);
        assert_eq!(result, "42");
    }

    #[test]
    fn format_filter_value_falls_back_to_quoting_for_unknown_table() {
        let model = test_model();
        let result = format_filter_value("Unknown", "col", "val", &model);
        assert_eq!(result, "'val'");
    }

    #[test]
    fn resolved_filter_to_sql_condition_string_column() {
        let model = test_model();
        let filter = ResolvedFilter::new("Sales", "region", ComparisonOp::Equal, "US");
        let sql = filter.to_sql_condition("sales", &model);
        assert_eq!(sql, "sales.\"region\" = 'US'");
    }

    #[test]
    fn resolved_filter_to_sql_condition_numeric_column() {
        let model = test_model();
        let filter = ResolvedFilter::new("Sales", "amount", ComparisonOp::GreaterThan, "100");
        let sql = filter.to_sql_condition("sales", &model);
        assert_eq!(sql, "sales.\"amount\" > 100");
    }

    // --- Bare context name resolution tests ---

    fn model_with_contexts_and_variables() -> DataModel {
        DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("amount", DataType::Float64),
                        Column::new("product_id", DataType::Int64),
                        Column::new("region", DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "Products",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("category", DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_relationship(Relationship::many_to_one(
                "Sales_Products",
                "Sales",
                "product_id",
                "Products",
                "id",
            ))
            .add_table_variable(TableVariable::new(
                "bikes_var",
                "Products",
                vec![FilterPredicate::new(
                    "Products",
                    "category",
                    ComparisonOp::Equal,
                    "Bikes",
                )],
            ))
            .add_context(ContextDefinition::new(
                "ctx_us",
                vec![ContextOp::Keep(vec![FilterPredicate::new(
                    "Sales",
                    "region",
                    ComparisonOp::Equal,
                    "US",
                )])],
            ))
            .add_context(ContextDefinition::new(
                "ctx_us_bikes",
                vec![
                    ContextOp::Inherit("ctx_us".into()),
                    ContextOp::Keep(vec![FilterPredicate::new(
                        "Products",
                        "category",
                        ComparisonOp::Equal,
                        "Bikes",
                    )]),
                ],
            ))
            .add_context(ContextDefinition::new(
                "ctx_clear_region",
                vec![ContextOp::Clear {
                    targets: vec![ClearTarget::Column {
                        table: "Sales".into(),
                        column: "region".into(),
                    }],
                    level: None,
                }],
            ))
            .add_context(ContextDefinition::new(
                "ctx_reset_all",
                vec![ContextOp::Reset { level: None }],
            ))
            .build()
            .unwrap()
    }

    #[test]
    fn bare_context_name_expands_keep_filters() {
        let model = model_with_contexts_and_variables();
        let resolver = ContextResolver::new(&model);

        // SUM(amount, ctx_us) — bare context name as variable in Keep
        let expression = expr::keep_vars(
            expr::agg(AggregateOp::Sum, expr::col("amount")),
            vec!["ctx_us".to_string()],
        );
        let (stripped, ctx) = resolver.resolve(&expression).unwrap();

        assert!(stripped.has_aggregate());
        assert_eq!(ctx.filters.len(), 1);
        assert_eq!(ctx.filters[0].table, "Sales");
        assert_eq!(ctx.filters[0].column, "region");
        assert_eq!(ctx.filters[0].value, "US");
    }

    #[test]
    fn bare_context_name_with_inheritance() {
        let model = model_with_contexts_and_variables();
        let resolver = ContextResolver::new(&model);

        // SUM(amount, ctx_us_bikes) — context inherits from ctx_us
        let expression = expr::keep_vars(
            expr::agg(AggregateOp::Sum, expr::col("amount")),
            vec!["ctx_us_bikes".to_string()],
        );
        let (_, ctx) = resolver.resolve(&expression).unwrap();

        // Should have 2 filters: region=US (inherited) + category=Bikes
        assert_eq!(ctx.filters.len(), 2);
        assert!(ctx.filters.iter().any(|f| f.value == "US"));
        assert!(ctx.filters.iter().any(|f| f.value == "Bikes"));
    }

    #[test]
    fn bare_context_name_with_clear() {
        let model = model_with_contexts_and_variables();
        let resolver = ContextResolver::new(&model);

        // SUM(amount, ctx_clear_region)
        let expression = expr::keep_vars(
            expr::agg(AggregateOp::Sum, expr::col("amount")),
            vec!["ctx_clear_region".to_string()],
        );
        let (_, ctx) = resolver.resolve(&expression).unwrap();

        assert_eq!(
            ctx.cleared_columns.get(&("Sales".into(), "region".into())),
            Some(&LevelRange::through(LEVEL_SLICER))
        );
    }

    #[test]
    fn bare_context_name_with_reset() {
        let model = model_with_contexts_and_variables();
        let resolver = ContextResolver::new(&model);

        // SUM(amount, ctx_reset_all)
        let expression = expr::keep_vars(
            expr::agg(AggregateOp::Sum, expr::col("amount")),
            vec!["ctx_reset_all".to_string()],
        );
        let (_, ctx) = resolver.resolve(&expression).unwrap();

        assert_eq!(ctx.reset, Some(LevelRange::through(LEVEL_SLICER)));
    }

    #[test]
    fn bare_variable_name_still_works_alongside_contexts() {
        let model = model_with_contexts_and_variables();
        let resolver = ContextResolver::new(&model);

        // SUM(amount, bikes_var) — table variable, not context
        let expression = expr::keep_vars(
            expr::agg(AggregateOp::Sum, expr::col("amount")),
            vec!["bikes_var".to_string()],
        );
        let (_, ctx) = resolver.resolve(&expression).unwrap();

        assert_eq!(ctx.filters.len(), 1);
        assert_eq!(ctx.filters[0].table, "Products");
        assert_eq!(ctx.filters[0].column, "category");
        assert_eq!(ctx.filters[0].value, "Bikes");
    }

    #[test]
    fn bare_unknown_name_errors() {
        let model = model_with_contexts_and_variables();
        let resolver = ContextResolver::new(&model);

        // SUM(amount, nonexistent) — should error
        let expression = expr::keep_vars(
            expr::agg(AggregateOp::Sum, expr::col("amount")),
            vec!["nonexistent".to_string()],
        );
        let result = resolver.resolve(&expression);
        assert!(result.is_err());
    }

    #[test]
    fn bare_context_and_variable_combined() {
        let model = model_with_contexts_and_variables();
        let resolver = ContextResolver::new(&model);

        // Two keep_vars: one table variable, one context
        let inner = expr::keep_vars(
            expr::agg(AggregateOp::Sum, expr::col("amount")),
            vec!["bikes_var".to_string()],
        );
        let outer = expr::keep_vars(inner, vec!["ctx_us".to_string()]);
        let (_, ctx) = resolver.resolve(&outer).unwrap();

        // Should have variable filter (category=Bikes) + context filter (region=US)
        assert_eq!(ctx.filters.len(), 2);
        assert!(ctx.filters.iter().any(|f| f.value == "Bikes"));
        assert!(ctx.filters.iter().any(|f| f.value == "US"));
    }
}
