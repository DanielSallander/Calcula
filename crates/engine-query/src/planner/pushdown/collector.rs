//! Per-table projection bookkeeping and the expression walker that collects
//! the source columns required by `LocalAggregation` fetches.

use engine_core::compute::expression::{Expression, InPredicate};
use engine_core::compute::parser::parse_measure_expression;
use engine_core::model::schema::apply_lookup_placeholder;
use engine_core::model::{DataModel, Relationship, Table};

use super::{LookupSpec, ProjectionDiagnostics};

/// Per-table column projections computed during planning.
///
/// Tables present in `fallbacks` (or all tables, when `global_fallback` is
/// set) are fetched without projection (`SELECT *`).
pub(super) struct TableProjections {
    /// Lowercased model table name → required source columns (sorted).
    columns: std::collections::HashMap<String, std::collections::BTreeSet<String>>,
    /// Lowercased model table name → (display name, reason projection skipped).
    fallbacks: std::collections::HashMap<String, (String, String)>,
    /// When set, projection is disabled for every table.
    global_fallback: Option<String>,
}

impl TableProjections {
    /// The projected columns for a fetched table. Empty means full fetch.
    pub(super) fn columns_for(&self, table_name: &str) -> Vec<String> {
        if self.global_fallback.is_some() {
            return Vec::new();
        }
        let key = table_name.to_lowercase();
        if self.fallbacks.contains_key(&key) {
            return Vec::new();
        }
        self.columns
            .get(&key)
            .map(|cols| cols.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Convert into reportable diagnostics for `plan_explained`.
    pub(super) fn into_diagnostics(self) -> ProjectionDiagnostics {
        if let Some(reason) = self.global_fallback {
            return ProjectionDiagnostics {
                fallbacks: vec![("*".to_string(), reason)],
            };
        }
        let mut fallbacks: Vec<(String, String)> = self.fallbacks.into_values().collect();
        fallbacks.sort();
        ProjectionDiagnostics { fallbacks }
    }
}

/// Walks measure expressions and request structures to compute, per fetched
/// table, the exact set of source columns required for local aggregation.
///
/// Conservative by design: any reference that cannot be attributed to a known
/// physical model column triggers a fallback to a full fetch — for the table
/// when it is known, otherwise for all tables.
pub(super) struct ProjectionCollector<'a> {
    model: &'a DataModel,
    /// Lowercased fetched table name → canonical model table name.
    fetched: std::collections::HashMap<String, String>,
    /// Lowercased fetched table name → required source columns.
    columns: std::collections::HashMap<String, std::collections::BTreeSet<String>>,
    /// Lowercased fetched table name → (display name, fallback reason).
    fallbacks: std::collections::HashMap<String, (String, String)>,
    /// When set, projection is disabled for every table.
    pub(super) global_fallback: Option<String>,
    /// Lowercased names of intermediate "tables" (QUERY/VAR binding names)
    /// that are materialized at runtime, not fetched from a source.
    intermediate_tables: std::collections::HashSet<String>,
    /// Lowercased names of intermediate output columns (QUERY aggregate
    /// aliases and QUERY group-by output names).
    intermediate_columns: std::collections::HashSet<String>,
}

impl<'a> ProjectionCollector<'a> {
    pub(super) fn new(model: &'a DataModel, fetch_tables: &[String]) -> Self {
        let mut fetched = std::collections::HashMap::new();
        for table_name in fetch_tables {
            let canonical = lookup_model_table(model, table_name)
                .map(|t| t.name().to_string())
                .unwrap_or_else(|| table_name.clone());
            fetched.insert(table_name.to_lowercase(), canonical);
        }
        Self {
            model,
            fetched,
            columns: std::collections::HashMap::new(),
            fallbacks: std::collections::HashMap::new(),
            global_fallback: None,
            intermediate_tables: std::collections::HashSet::new(),
            intermediate_columns: std::collections::HashSet::new(),
        }
    }

    /// Record that a table must be fetched without projection.
    pub(super) fn mark_fallback(&mut self, table: &str, reason: &str) {
        let key = table.to_lowercase();
        if !self.fetched.contains_key(&key) {
            return;
        }
        self.fallbacks
            .entry(key)
            .or_insert_with(|| (table.to_string(), reason.to_string()));
    }

    /// Disable projection for all tables (keeps the first reason).
    pub(super) fn set_global_fallback(&mut self, reason: String) {
        if self.global_fallback.is_none() {
            self.global_fallback = Some(reason);
        }
    }

    /// True if `column` names a calculated column on `table_name`.
    fn is_calculated_column(&self, table_name: &str, column: &str) -> bool {
        self.model
            .calculated_columns_for_table(table_name)
            .iter()
            .any(|cc| cc.name().eq_ignore_ascii_case(column))
    }

    /// Attribute a column requirement to a specific table.
    ///
    /// Unknown tables and tables outside the fetch set are ignored (they
    /// cannot affect any source fetch). Calculated columns are not added —
    /// they do not exist at the source; their inputs are collected by
    /// [`Self::add_calculated_inputs`]. A column that is neither physical nor
    /// calculated triggers a fallback for the table.
    pub(super) fn add(&mut self, table: &str, column: &str) {
        if self.global_fallback.is_some() {
            return;
        }
        let model = self.model;
        let Some(model_table) = lookup_model_table(model, table) else {
            return;
        };
        let canonical = model_table.name().to_string();
        let key = canonical.to_lowercase();
        if !self.fetched.contains_key(&key) || self.fallbacks.contains_key(&key) {
            return;
        }
        if let Some(physical) = resolve_physical_column(model_table, column) {
            let physical = physical.to_string();
            self.columns.entry(key).or_default().insert(physical);
        } else if self.is_calculated_column(&canonical, column) {
            // Calculated column: inputs are added via add_calculated_inputs.
        } else {
            self.mark_fallback(
                &canonical,
                &format!("column '{column}' not found in table '{canonical}'"),
            );
        }
    }

    /// Attribute an unqualified column reference.
    ///
    /// Local SQL resolves unqualified references against any registered
    /// table, so the column is added to every fetched table that has it.
    /// A name matching no fetched table (and no intermediate output column)
    /// cannot be attributed — projection is disabled entirely.
    fn add_unqualified(&mut self, column: &str) {
        if self.global_fallback.is_some() {
            return;
        }
        let model = self.model;
        let candidates: Vec<String> = self.fetched.values().cloned().collect();
        let mut found = false;
        for table_name in candidates {
            let Some(model_table) = lookup_model_table(model, &table_name) else {
                continue;
            };
            let has_column = resolve_physical_column(model_table, column).is_some()
                || self.is_calculated_column(model_table.name(), column);
            if has_column {
                self.add(&table_name, column);
                found = true;
            }
        }
        if !found && !self.intermediate_columns.contains(&column.to_lowercase()) {
            self.set_global_fallback(format!(
                "cannot attribute column reference '{column}' to any fetched table"
            ));
        }
    }

    /// Attribute a qualified reference (`table_or_var[column]`).
    fn add_qualified(&mut self, table_or_var: &str, column: &str) {
        if self.global_fallback.is_some() {
            return;
        }
        if self
            .intermediate_tables
            .contains(&table_or_var.to_lowercase())
        {
            return;
        }
        let model = self.model;
        if model.table_variable(table_or_var).is_ok() {
            self.add_variable_chain(table_or_var, Some(column));
        } else if lookup_model_table(model, table_or_var).is_some() {
            self.add(table_or_var, column);
        } else if model.global_variable(table_or_var).is_ok() {
            // Query-global reference: materialized at runtime, not a source column.
        } else {
            self.set_global_fallback(format!(
                "cannot resolve qualified reference '{table_or_var}[{column}]'"
            ));
        }
    }

    /// Follow a table variable's source chain: add all filter columns along
    /// the chain and, optionally, `final_column` on the base table.
    fn add_variable_chain(&mut self, var_name: &str, final_column: Option<&str>) {
        let model = self.model;
        let mut current = var_name.to_string();
        for _ in 0..64 {
            match model.table_variable(&current) {
                Ok(var) => {
                    for f in var.filters() {
                        self.add(&f.table, &f.column);
                    }
                    current = var.source().to_string();
                }
                Err(_) => {
                    if let Some(column) = final_column {
                        self.add(&current, column);
                    }
                    return;
                }
            }
        }
        self.set_global_fallback(format!(
            "table variable chain too deep starting at '{var_name}'"
        ));
    }

    /// Add the columns referenced by an IN-membership predicate.
    fn add_in_predicate(&mut self, predicate: &InPredicate) {
        self.add(&predicate.table, &predicate.column);
        let model = self.model;
        if model.table_variable(&predicate.var_name).is_ok() {
            self.add_variable_chain(&predicate.var_name, Some(&predicate.var_column));
        } else if lookup_model_table(model, &predicate.var_name).is_some() {
            self.add(&predicate.var_name, &predicate.var_column);
        } else {
            self.set_global_fallback(format!(
                "cannot resolve IN predicate source '{}'",
                predicate.var_name
            ));
        }
    }

    /// Add the columns referenced by a named context definition's operations,
    /// recursively following `Inherit`.
    fn add_context_columns(&mut self, context_name: &str, depth: usize) {
        use engine_core::model::context::ContextOp;
        use engine_core::model::ClearTarget;

        if depth > 16 {
            return;
        }
        let model = self.model;
        if let Ok(ctx) = model.context(context_name) {
            for op in ctx.operations() {
                match op {
                    ContextOp::Keep(filters) => {
                        for f in filters {
                            self.add(&f.table, &f.column);
                        }
                    }
                    ContextOp::KeepIn(predicates) => {
                        for p in predicates {
                            self.add_in_predicate(p);
                        }
                    }
                    ContextOp::Clear(targets)
                    | ContextOp::ClearInner(targets)
                    | ContextOp::ClearOuter(targets) => {
                        for target in targets {
                            if let ClearTarget::Column { table, column } = target {
                                self.add(table, column);
                            }
                        }
                    }
                    ContextOp::Inherit(parent) => self.add_context_columns(parent, depth + 1),
                    ContextOp::UseRelationship(name) => {
                        if let Ok(rel) = model.relationship(name) {
                            self.add_relationship_conditions(rel);
                        }
                    }
                    ContextOp::Reset | ContextOp::ResetInner | ContextOp::ResetOuter => {}
                }
            }
        }
    }

    /// Add both sides of every join condition of a relationship.
    pub(super) fn add_relationship_conditions(&mut self, rel: &Relationship) {
        for cond in rel.conditions() {
            self.add(rel.from_table(), cond.from_column());
            self.add(rel.to_table(), cond.to_column());
        }
    }

    /// Add the key columns of every relationship (active or inactive)
    /// between two tables.
    fn add_relationship_keys_between(&mut self, table_a: &str, table_b: &str) {
        let model = self.model;
        for rel in model.relationships() {
            let matches = (rel.from_table().eq_ignore_ascii_case(table_a)
                && rel.to_table().eq_ignore_ascii_case(table_b))
                || (rel.from_table().eq_ignore_ascii_case(table_b)
                    && rel.to_table().eq_ignore_ascii_case(table_a));
            if matches {
                self.add_relationship_conditions(rel);
            }
        }
    }

    /// Add window ORDER BY / PARTITION BY columns. ORDER BY columns also pull
    /// in their model-declared sort-by columns.
    fn add_window_columns(
        &mut self,
        order_by: &[(String, String)],
        partition_by: &[(String, String)],
    ) {
        let model = self.model;
        for (table, column) in order_by {
            self.add(table, column);
            if let Ok(model_table) = model.table(table) {
                if let Ok(sort_col) = model_table.sort_column_for(column) {
                    if sort_col != column {
                        let sort_col = sort_col.to_string();
                        self.add(table, &sort_col);
                    }
                }
            }
        }
        for (table, column) in partition_by {
            self.add(table, column);
        }
    }

    /// Add the physical inputs of every calculated column on a fetched table.
    ///
    /// The execution pipeline materializes calculated columns from fetched
    /// batches, so all physical inputs must be present in the fetch. The
    /// calculated column itself must never be requested from the source.
    pub(super) fn add_calculated_inputs(&mut self, table_name: &str) {
        let model = self.model;
        let Some(model_table) = lookup_model_table(model, table_name) else {
            return;
        };
        let canonical = model_table.name().to_string();
        for cc in model.calculated_columns_for_table(&canonical) {
            for input in cc.expression().column_references() {
                if resolve_physical_column(model_table, input).is_some() {
                    let input = input.to_string();
                    self.add(&canonical, &input);
                } else if self.is_calculated_column(&canonical, input) {
                    // Calc-on-calc reference: that column's own inputs are
                    // covered by this loop over all calculated columns.
                } else {
                    self.mark_fallback(
                        &canonical,
                        &format!(
                            "calculated column '{}' input '{input}' not found in table",
                            cc.name()
                        ),
                    );
                    return;
                }
            }
        }
    }

    /// Add the columns referenced by a lookup's resolution expression.
    ///
    /// Mirrors `resolve_lookups`: per-column expression → model default (with
    /// the `__column` placeholder applied) → built-in fallback (which only
    /// references the lookup column itself, added by the caller). All
    /// resolution references are rendered against the lookup table.
    pub(super) fn add_lookup_resolution_columns(&mut self, spec: &LookupSpec) {
        let model = self.model;
        let Some(model_table) = lookup_model_table(model, &spec.table) else {
            return;
        };
        let canonical = model_table.name().to_string();
        let Ok(column) = model_table.column(&spec.column) else {
            return;
        };

        let parsed = match column.lookup_resolution() {
            Some(text) => match parse_measure_expression(text) {
                Ok(parsed) => Some(parsed),
                Err(_) => {
                    self.mark_fallback(&canonical, "lookup resolution expression failed to parse");
                    return;
                }
            },
            None => match model.default_lookup_resolution() {
                Some(default_expr) => {
                    let rewritten = parse_measure_expression(default_expr)
                        .ok()
                        .and_then(|p| apply_lookup_placeholder(&p, &spec.column).ok());
                    match rewritten {
                        Some(expr) => Some(expr),
                        None => {
                            self.mark_fallback(
                                &canonical,
                                "default lookup resolution failed to parse",
                            );
                            return;
                        }
                    }
                }
                None => None,
            },
        };

        if let Some(expr) = parsed {
            for reference in expr.column_references() {
                if resolve_physical_column(model_table, reference).is_some() {
                    let reference = reference.to_string();
                    self.add(&canonical, &reference);
                } else if self.is_calculated_column(&canonical, reference) {
                    // Inputs covered by add_calculated_inputs.
                } else {
                    self.mark_fallback(
                        &canonical,
                        &format!("lookup resolution references unknown column '{reference}'"),
                    );
                    return;
                }
            }
        }
    }

    /// Recursively collect column requirements from an expression tree.
    ///
    /// The match is exhaustive on purpose: when a new `Expression` variant is
    /// added, this fails to compile, forcing an explicit decision on how the
    /// variant contributes to fetch projections.
    pub(super) fn walk(&mut self, expr: &Expression) {
        if self.global_fallback.is_some() {
            return;
        }
        match expr {
            Expression::ColumnRef(name) => self.add_unqualified(name),
            Expression::QualifiedColumnRef {
                table_or_var,
                column,
            } => self.add_qualified(table_or_var, column),
            Expression::LiteralFloat(_)
            | Expression::LiteralInt(_)
            | Expression::LiteralString(_)
            | Expression::LiteralBool(_)
            | Expression::Blank
            | Expression::TableRef(_) => {}
            Expression::MeasureRef(name) => {
                // Measure references are expanded before analysis; one
                // surviving here cannot be attributed statically.
                self.set_global_fallback(format!("unexpanded measure reference '[{name}]'"));
            }
            Expression::SelectedMeasure => {
                // The calculation-item placeholder is substituted with the
                // applied measure's expression before analysis; one surviving
                // here cannot be attributed statically.
                self.set_global_fallback("unsubstituted SELECTEDMEASURE() placeholder".to_string());
            }
            Expression::BinaryOp { left, right, .. }
            | Expression::Comparison { left, right, .. }
            | Expression::And(left, right)
            | Expression::Or(left, right)
            | Expression::Xor(left, right) => {
                self.walk(left);
                self.walk(right);
            }
            Expression::Aggregate { operand, .. } => self.walk(operand),
            Expression::Not(inner) | Expression::IsBlank(inner) => self.walk(inner),
            Expression::Keep {
                expr: inner,
                filters,
                variables,
                conditions,
                in_predicates,
            } => {
                self.walk(inner);
                for f in filters {
                    self.add(&f.table, &f.column);
                }
                for v in variables {
                    if self.model.table_variable(v).is_ok() {
                        self.add_variable_chain(v, None);
                    } else if self.model.context(v).is_ok() {
                        self.add_context_columns(v, 0);
                    } else if lookup_model_table(self.model, v).is_some() {
                        // Bare table reference — join keys are covered by the
                        // relationship pass.
                    } else {
                        self.set_global_fallback(format!("unknown KEEP target '{v}'"));
                    }
                }
                for c in conditions {
                    self.walk(c);
                }
                for p in in_predicates {
                    self.add_in_predicate(p);
                }
            }
            Expression::KeepIn {
                expr: inner,
                predicates,
            } => {
                self.walk(inner);
                for p in predicates {
                    self.add_in_predicate(p);
                }
            }
            Expression::Clear {
                expr: inner,
                targets,
            }
            | Expression::ClearInner {
                expr: inner,
                targets,
            }
            | Expression::ClearOuter {
                expr: inner,
                targets,
            } => {
                self.walk(inner);
                for target in targets {
                    if let engine_core::model::ClearTarget::Column { table, column } = target {
                        self.add(table, column);
                    }
                }
            }
            Expression::ClearExcept {
                expr: inner,
                table,
                except_columns,
            } => {
                self.walk(inner);
                for column in except_columns {
                    self.add(table, column);
                }
            }
            Expression::Reset { expr: inner }
            | Expression::ResetInner { expr: inner }
            | Expression::ResetOuter { expr: inner } => self.walk(inner),
            Expression::Traverse { expr: inner, path } => {
                self.walk(inner);
                for pair in path.hops.windows(2) {
                    self.add_relationship_keys_between(&pair[0], &pair[1]);
                }
            }
            Expression::Using {
                expr: inner,
                context_name,
            } => {
                self.walk(inner);
                if self.model.context(context_name).is_ok() {
                    self.add_context_columns(context_name, 0);
                } else {
                    self.set_global_fallback(format!("unknown context '{context_name}'"));
                }
            }
            Expression::UseRelationship {
                expr: inner,
                relationship_name,
            } => {
                self.walk(inner);
                let model = self.model;
                if let Ok(rel) = model.relationship(relationship_name) {
                    self.add_relationship_conditions(rel);
                }
            }
            Expression::Block { bindings, .. } => {
                // Register binding names FIRST so references to them in the
                // result (`monthly[revenue]`, `COUNTROWS(monthly)`) resolve
                // as intermediates instead of unknown tables. Table-producing
                // bindings (QUERY/window family) become intermediate tables;
                // scalar VAR names become intermediate columns.
                for (name, binding_expr) in bindings {
                    match binding_expr {
                        Expression::Query { .. }
                        | Expression::Window { .. }
                        | Expression::Offset { .. }
                        | Expression::Index { .. }
                        | Expression::ToDate { .. }
                        | Expression::PeriodShift { .. }
                        | Expression::DatesInPeriod { .. }
                        | Expression::SemiAdditiveBalance { .. } => {
                            self.intermediate_tables.insert(name.to_lowercase());
                        }
                        _ => {
                            self.intermediate_columns.insert(name.to_lowercase());
                        }
                    }
                }
                // Walk every binding's source columns (QUERY group-bys and
                // aggregates feed the two-stage materialization SQL, so their
                // columns MUST be fetched), then the result with scalar
                // bindings inlined — inline_bindings() strips the Block
                // wrapper and substitutes scalar VAR names away, so no bare
                // binding-name ColumnRef survives the walk.
                for (_, binding_expr) in bindings {
                    self.walk(binding_expr);
                }
                self.walk(&expr.inline_bindings());
            }
            Expression::Query {
                aggregates,
                group_by,
            } => {
                for (agg_expr, alias) in aggregates {
                    self.intermediate_columns.insert(alias.to_lowercase());
                    self.walk(agg_expr);
                }
                for (table, column) in group_by {
                    self.intermediate_columns.insert(column.to_lowercase());
                    self.add(table, column);
                }
            }
            Expression::If {
                condition,
                then_expr,
                else_expr,
            } => {
                self.walk(condition);
                self.walk(then_expr);
                self.walk(else_expr);
            }
            Expression::Switch {
                expr: inner,
                cases,
                default,
            } => {
                self.walk(inner);
                for (value, result) in cases {
                    self.walk(value);
                    self.walk(result);
                }
                if let Some(d) = default {
                    self.walk(d);
                }
            }
            Expression::SafeDivide {
                numerator,
                denominator,
                alternate,
            } => {
                self.walk(numerator);
                self.walk(denominator);
                if let Some(a) = alternate {
                    self.walk(a);
                }
            }
            Expression::Coalesce(exprs)
            | Expression::Greatest(exprs)
            | Expression::Least(exprs) => {
                for e in exprs {
                    self.walk(e);
                }
            }
            Expression::ScalarFunc { args, .. }
            | Expression::TextFunc { args, .. }
            | Expression::DateTimeFunc { args, .. } => {
                for a in args {
                    self.walk(a);
                }
            }
            Expression::IfError {
                expr: inner,
                alternate,
            } => {
                self.walk(inner);
                self.walk(alternate);
            }
            Expression::IsInScope { table, column } => self.add(table, column),
            Expression::Iterate { expression, .. } => self.walk(expression),
            Expression::Percentile {
                operand,
                percentile,
            } => {
                self.walk(operand);
                self.walk(percentile);
            }
            Expression::NullIf { expr: inner, value } => {
                self.walk(inner);
                self.walk(value);
            }
            Expression::CountIf { condition } => self.walk(condition),
            Expression::ListAgg { column, delimiter } => {
                self.walk(column);
                self.walk(delimiter);
            }
            Expression::MaxBy { value, sort_by } | Expression::MinBy { value, sort_by } => {
                self.walk(value);
                self.walk(sort_by);
            }
            Expression::HasOneValue { column } => self.walk(column),
            Expression::SelectedValue { column, alternate } => {
                self.walk(column);
                if let Some(a) = alternate {
                    self.walk(a);
                }
            }
            Expression::FirstValue { column, order_by } => {
                self.walk(column);
                self.walk(order_by);
            }
            Expression::InList {
                expr: inner,
                values,
            } => {
                self.walk(inner);
                for v in values {
                    self.walk(v);
                }
            }
            Expression::Window {
                inner,
                order_by,
                partition_by,
                ..
            }
            | Expression::Offset {
                inner,
                order_by,
                partition_by,
                ..
            }
            | Expression::Index {
                inner,
                order_by,
                partition_by,
                ..
            } => {
                self.walk(inner);
                self.add_window_columns(order_by, partition_by);
            }
            Expression::RankWindow {
                order_by,
                partition_by,
                ..
            } => self.add_window_columns(order_by, partition_by),
            // Time-intelligence sugar: the date axis comes from the query's
            // group_by (whose columns the planner always fetches), so only
            // the inner measure contributes column requirements.
            Expression::ToDate { expr: inner, .. }
            | Expression::PeriodShift { expr: inner, .. }
            | Expression::DatesInPeriod { expr: inner, .. }
            | Expression::SemiAdditiveBalance { expr: inner, .. } => self.walk(inner),
            // UDF call: the function body is opaque, but its arguments are
            // ordinary expressions whose column requirements must be fetched.
            Expression::Call { args, .. } => {
                for a in args {
                    self.walk(a);
                }
            }
        }
    }

    pub(super) fn finish(self) -> TableProjections {
        TableProjections {
            columns: self.columns,
            fallbacks: self.fallbacks,
            global_fallback: self.global_fallback,
        }
    }
}

/// Look up a model table by name, falling back to case-insensitive matching.
pub(super) fn lookup_model_table<'m>(model: &'m DataModel, name: &str) -> Option<&'m Table> {
    model
        .tables()
        .iter()
        .find(|t| t.name() == name)
        .or_else(|| {
            model
                .tables()
                .iter()
                .find(|t| t.name().eq_ignore_ascii_case(name))
        })
}

/// Resolve a column reference against a table's physical columns, returning
/// the canonical column name (exact match preferred, then case-insensitive).
pub(super) fn resolve_physical_column<'t>(table: &'t Table, name: &str) -> Option<&'t str> {
    table
        .columns()
        .iter()
        .find(|c| c.name() == name)
        .map(|c| c.name())
        .or_else(|| {
            table
                .columns()
                .iter()
                .find(|c| c.name().eq_ignore_ascii_case(name))
                .map(|c| c.name())
        })
}
