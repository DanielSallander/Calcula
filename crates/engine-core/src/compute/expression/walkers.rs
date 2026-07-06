//! Column-reference and context-filter-table collection walkers.

use super::*;

impl Expression {
    /// Returns all column names referenced by this expression.
    pub fn column_references(&self) -> Vec<&str> {
        let mut refs = Vec::new();
        self.collect_column_refs(&mut refs);
        refs.sort_unstable();
        refs.dedup();
        refs
    }

    fn collect_column_refs<'a>(&'a self, refs: &mut Vec<&'a str>) {
        match self {
            Expression::ColumnRef(name) => refs.push(name),
            Expression::QualifiedColumnRef { column, .. } => refs.push(column),
            Expression::TableRef(_)
            | Expression::MeasureRef(_)
            | Expression::SelectedMeasure
            | Expression::LiteralFloat(_)
            | Expression::LiteralInt(_)
            | Expression::LiteralDate(_)
            | Expression::LiteralString(_)
            | Expression::LiteralBool(_)
            | Expression::Blank => {}
            Expression::BinaryOp { left, right, .. }
            | Expression::Comparison { left, right, .. }
            | Expression::And(left, right)
            | Expression::Or(left, right)
            | Expression::Xor(left, right) => {
                left.collect_column_refs(refs);
                right.collect_column_refs(refs);
            }
            Expression::Aggregate { operand, .. } => {
                operand.collect_column_refs(refs);
            }
            Expression::Not(inner) | Expression::IsBlank(inner) => {
                inner.collect_column_refs(refs);
            }
            Expression::Keep { expr, .. }
            | Expression::Clear { expr, .. }
            | Expression::Reset { expr }
            | Expression::ClearInner { expr, .. }
            | Expression::ClearOuter { expr, .. }
            | Expression::ResetInner { expr }
            | Expression::ResetOuter { expr }
            | Expression::Traverse { expr, .. }
            | Expression::Using { expr, .. }
            | Expression::UseRelationship { expr, .. }
            | Expression::KeepIn { expr, .. } => {
                expr.collect_column_refs(refs);
            }
            Expression::Block {
                bindings,
                query_scoped_bindings,
                result,
            } => {
                // Collect refs from binding expressions and result, but exclude
                // VAR/GVAR binding names since those are local variables, not
                // real columns.
                let binding_names: Vec<&str> = bindings
                    .iter()
                    .chain(query_scoped_bindings.iter())
                    .map(|(name, _)| name.as_str())
                    .collect();

                // Collect column names produced by Query bindings (aliases +
                // group-by columns) — these are intermediate table columns,
                // not physical column references from the data model.
                let mut query_output_cols: Vec<&str> = Vec::new();
                for (_, binding_expr) in bindings {
                    if let Expression::Query {
                        aggregates,
                        group_by,
                    } = binding_expr
                    {
                        for (_, alias) in aggregates {
                            query_output_cols.push(alias.as_str());
                        }
                        for (_, col) in group_by {
                            query_output_cols.push(col.as_str());
                        }
                    }
                }

                for (_, binding_expr) in bindings.iter().chain(query_scoped_bindings.iter()) {
                    let mut binding_refs = Vec::new();
                    binding_expr.collect_column_refs(&mut binding_refs);
                    for r in binding_refs {
                        if !binding_names.contains(&r) && !query_output_cols.contains(&r) {
                            refs.push(r);
                        }
                    }
                }
                let mut result_refs = Vec::new();
                result.collect_column_refs(&mut result_refs);
                for r in result_refs {
                    if !binding_names.contains(&r) && !query_output_cols.contains(&r) {
                        refs.push(r);
                    }
                }
            }
            Expression::If {
                condition,
                then_expr,
                else_expr,
            } => {
                condition.collect_column_refs(refs);
                then_expr.collect_column_refs(refs);
                else_expr.collect_column_refs(refs);
            }
            Expression::Switch {
                expr,
                cases,
                default,
            } => {
                expr.collect_column_refs(refs);
                for (val, result) in cases {
                    val.collect_column_refs(refs);
                    result.collect_column_refs(refs);
                }
                if let Some(d) = default {
                    d.collect_column_refs(refs);
                }
            }
            Expression::SafeDivide {
                numerator,
                denominator,
                alternate,
            } => {
                numerator.collect_column_refs(refs);
                denominator.collect_column_refs(refs);
                if let Some(alt) = alternate {
                    alt.collect_column_refs(refs);
                }
            }
            Expression::Coalesce(exprs) => {
                for e in exprs {
                    e.collect_column_refs(refs);
                }
            }
            Expression::ScalarFunc { args, .. }
            | Expression::TextFunc { args, .. }
            | Expression::DateTimeFunc { args, .. } => {
                for arg in args {
                    arg.collect_column_refs(refs);
                }
            }
            Expression::IfError { expr, alternate } => {
                expr.collect_column_refs(refs);
                alternate.collect_column_refs(refs);
            }
            Expression::IsInScope { .. } => {}
            Expression::ClearExcept { expr, .. }
            | Expression::Iterate {
                expression: expr, ..
            } => {
                expr.collect_column_refs(refs);
            }
            Expression::Percentile {
                operand,
                percentile,
            } => {
                operand.collect_column_refs(refs);
                percentile.collect_column_refs(refs);
            }
            Expression::Query { aggregates, .. } => {
                // Only collect refs from aggregate expressions. Group-by
                // columns are structural (table, column) pairs referencing
                // other tables — they are not column refs of the fact table.
                for (expr, _) in aggregates {
                    expr.collect_column_refs(refs);
                }
            }
            Expression::HasOneValue { column } => column.collect_column_refs(refs),
            Expression::SelectedValue { column, alternate } => {
                column.collect_column_refs(refs);
                if let Some(alt) = alternate {
                    alt.collect_column_refs(refs);
                }
            }
            Expression::FirstValue { column, order_by } => {
                column.collect_column_refs(refs);
                order_by.collect_column_refs(refs);
            }
            Expression::Window { inner, .. }
            | Expression::Offset { inner, .. }
            | Expression::Index { inner, .. } => {
                // Only collect refs from the inner measure expression.
                // order_by/partition_by are structural (table, column) pairs,
                // not column refs of the fact table.
                inner.collect_column_refs(refs);
            }
            Expression::ToDate { expr, .. }
            | Expression::PeriodShift { expr, .. }
            | Expression::DatesInPeriod { expr, .. }
            | Expression::SemiAdditiveBalance { expr, .. } => {
                // The date axis comes from the query's group_by at lowering
                // time, not from the expression — only the inner measure
                // contributes column refs.
                expr.collect_column_refs(refs);
            }
            Expression::InList { expr, values } => {
                expr.collect_column_refs(refs);
                for v in values {
                    v.collect_column_refs(refs);
                }
            }
            Expression::Greatest(args) | Expression::Least(args) => {
                for a in args {
                    a.collect_column_refs(refs);
                }
            }
            Expression::NullIf { expr, value } => {
                expr.collect_column_refs(refs);
                value.collect_column_refs(refs);
            }
            Expression::CountIf { condition } => {
                condition.collect_column_refs(refs);
            }
            Expression::ListAgg { column, delimiter } => {
                column.collect_column_refs(refs);
                delimiter.collect_column_refs(refs);
            }
            Expression::MaxBy { value, sort_by } | Expression::MinBy { value, sort_by } => {
                value.collect_column_refs(refs);
                sort_by.collect_column_refs(refs);
            }
            Expression::RankWindow { .. } => {}
            Expression::Call { args, .. } => {
                for arg in args {
                    arg.collect_column_refs(refs);
                }
            }
        }
    }

    /// Returns all table names referenced by context operation filters (KEEP, KeepIn).
    ///
    /// This is used by the query planner to determine which tables need to
    /// be fetched for local aggregation when measures contain context ops.
    pub fn context_filter_tables(&self) -> Vec<&str> {
        let mut tables = Vec::new();
        self.collect_context_filter_tables(&mut tables);
        tables
    }

    fn collect_context_filter_tables<'a>(&'a self, tables: &mut Vec<&'a str>) {
        match self {
            Expression::ColumnRef(_)
            | Expression::QualifiedColumnRef { .. }
            | Expression::TableRef(_)
            | Expression::MeasureRef(_)
            | Expression::SelectedMeasure
            | Expression::LiteralFloat(_)
            | Expression::LiteralInt(_)
            | Expression::LiteralDate(_)
            | Expression::LiteralString(_)
            | Expression::LiteralBool(_)
            | Expression::Blank => {}
            Expression::BinaryOp { left, right, .. }
            | Expression::Comparison { left, right, .. }
            | Expression::And(left, right)
            | Expression::Or(left, right)
            | Expression::Xor(left, right) => {
                left.collect_context_filter_tables(tables);
                right.collect_context_filter_tables(tables);
            }
            Expression::Not(inner) | Expression::IsBlank(inner) => {
                inner.collect_context_filter_tables(tables);
            }
            Expression::Aggregate { operand, .. } => {
                operand.collect_context_filter_tables(tables);
            }
            Expression::Keep {
                expr,
                filters,
                variables,
                conditions,
                in_predicates,
            } => {
                for f in filters {
                    tables.push(&f.table);
                }
                // Variable tables are resolved at context-resolution time,
                // not tracked here — they add filters dynamically.
                let _ = variables;
                // Expression conditions may reference dimension tables via
                // QualifiedColumnRef — collect those too.
                for cond in conditions {
                    cond.collect_context_filter_tables(tables);
                }
                for p in in_predicates {
                    tables.push(&p.table);
                }
                expr.collect_context_filter_tables(tables);
            }
            Expression::KeepIn { expr, predicates } => {
                for p in predicates {
                    tables.push(&p.table);
                }
                expr.collect_context_filter_tables(tables);
            }
            Expression::Clear { expr, .. }
            | Expression::Reset { expr }
            | Expression::ClearInner { expr, .. }
            | Expression::ClearOuter { expr, .. }
            | Expression::ResetInner { expr }
            | Expression::ResetOuter { expr }
            | Expression::Traverse { expr, .. }
            | Expression::Using { expr, .. }
            | Expression::UseRelationship { expr, .. } => {
                expr.collect_context_filter_tables(tables);
            }
            Expression::Block {
                bindings,
                query_scoped_bindings,
                result,
            } => {
                for (_, binding_expr) in bindings.iter().chain(query_scoped_bindings.iter()) {
                    binding_expr.collect_context_filter_tables(tables);
                }
                result.collect_context_filter_tables(tables);
            }
            Expression::If {
                condition,
                then_expr,
                else_expr,
            } => {
                condition.collect_context_filter_tables(tables);
                then_expr.collect_context_filter_tables(tables);
                else_expr.collect_context_filter_tables(tables);
            }
            Expression::Switch {
                expr,
                cases,
                default,
            } => {
                expr.collect_context_filter_tables(tables);
                for (v, r) in cases {
                    v.collect_context_filter_tables(tables);
                    r.collect_context_filter_tables(tables);
                }
                if let Some(d) = default {
                    d.collect_context_filter_tables(tables);
                }
            }
            Expression::SafeDivide {
                numerator,
                denominator,
                alternate,
            } => {
                numerator.collect_context_filter_tables(tables);
                denominator.collect_context_filter_tables(tables);
                if let Some(alt) = alternate {
                    alt.collect_context_filter_tables(tables);
                }
            }
            Expression::Coalesce(exprs) => {
                for e in exprs {
                    e.collect_context_filter_tables(tables);
                }
            }
            Expression::ScalarFunc { args, .. }
            | Expression::TextFunc { args, .. }
            | Expression::DateTimeFunc { args, .. } => {
                for arg in args {
                    arg.collect_context_filter_tables(tables);
                }
            }
            Expression::IfError { expr, alternate } => {
                expr.collect_context_filter_tables(tables);
                alternate.collect_context_filter_tables(tables);
            }
            Expression::IsInScope { .. } => {}
            Expression::ClearExcept { expr, .. } => {
                expr.collect_context_filter_tables(tables);
            }
            Expression::Iterate { expression, .. } => {
                expression.collect_context_filter_tables(tables);
            }
            Expression::Percentile {
                operand,
                percentile,
            } => {
                operand.collect_context_filter_tables(tables);
                percentile.collect_context_filter_tables(tables);
            }
            Expression::Query {
                aggregates,
                group_by,
            } => {
                for (expr, _) in aggregates {
                    expr.collect_context_filter_tables(tables);
                }
                for (table, _) in group_by {
                    tables.push(table);
                }
            }
            Expression::HasOneValue { column } => column.collect_context_filter_tables(tables),
            Expression::SelectedValue { column, alternate } => {
                column.collect_context_filter_tables(tables);
                if let Some(alt) = alternate {
                    alt.collect_context_filter_tables(tables);
                }
            }
            Expression::FirstValue { column, order_by } => {
                column.collect_context_filter_tables(tables);
                order_by.collect_context_filter_tables(tables);
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
                inner.collect_context_filter_tables(tables);
                for (table, _) in order_by {
                    tables.push(table);
                }
                for (table, _) in partition_by {
                    tables.push(table);
                }
            }
            Expression::ToDate { expr, .. }
            | Expression::PeriodShift { expr, .. }
            | Expression::DatesInPeriod { expr, .. }
            | Expression::SemiAdditiveBalance { expr, .. } => {
                // The date-table axis is supplied by the query's group_by at
                // lowering time; no structural table references live here.
                expr.collect_context_filter_tables(tables);
            }
            Expression::InList { expr, values } => {
                expr.collect_context_filter_tables(tables);
                for v in values {
                    v.collect_context_filter_tables(tables);
                }
            }
            Expression::Greatest(args) | Expression::Least(args) => {
                for a in args {
                    a.collect_context_filter_tables(tables);
                }
            }
            Expression::NullIf { expr, value } => {
                expr.collect_context_filter_tables(tables);
                value.collect_context_filter_tables(tables);
            }
            Expression::CountIf { condition } => {
                condition.collect_context_filter_tables(tables);
            }
            Expression::ListAgg { column, delimiter } => {
                column.collect_context_filter_tables(tables);
                delimiter.collect_context_filter_tables(tables);
            }
            Expression::MaxBy { value, sort_by } | Expression::MinBy { value, sort_by } => {
                value.collect_context_filter_tables(tables);
                sort_by.collect_context_filter_tables(tables);
            }
            Expression::RankWindow {
                order_by,
                partition_by,
                ..
            } => {
                for (table, _) in order_by {
                    tables.push(table);
                }
                for (table, _) in partition_by {
                    tables.push(table);
                }
            }
            Expression::Call { args, .. } => {
                for arg in args {
                    arg.collect_context_filter_tables(tables);
                }
            }
        }
    }

    /// Returns the names of all measures referenced (via `[Measure]` /
    /// [`Expression::MeasureRef`]) anywhere in this expression tree
    /// (deduplicated, sorted).
    ///
    /// This is the **direct** dependency set of a measure — the measures it
    /// names, not their transitive closure. Hosts (notably Calcula Studio) use
    /// it for the measure-dependency view, safe-rename/refactor ("who
    /// references X before I rename it?"), impact analysis on delete, and
    /// lineage ordering. Pair with [`DataModel::measure_dependents`] for the
    /// reverse edge.
    ///
    /// [`DataModel::measure_dependents`]: crate::model::DataModel::measure_dependents
    pub fn measure_references(&self) -> Vec<&str> {
        let mut names = Vec::new();
        self.collect_measure_refs(&mut names);
        names.sort_unstable();
        names.dedup();
        names
    }

    fn collect_measure_refs<'a>(&'a self, names: &mut Vec<&'a str>) {
        match self {
            Expression::MeasureRef(name) => names.push(name),
            Expression::ColumnRef(_)
            | Expression::QualifiedColumnRef { .. }
            | Expression::TableRef(_)
            | Expression::SelectedMeasure
            | Expression::LiteralFloat(_)
            | Expression::LiteralInt(_)
            | Expression::LiteralDate(_)
            | Expression::LiteralString(_)
            | Expression::LiteralBool(_)
            | Expression::Blank
            | Expression::IsInScope { .. }
            | Expression::RankWindow { .. } => {}
            Expression::BinaryOp { left, right, .. }
            | Expression::Comparison { left, right, .. }
            | Expression::And(left, right)
            | Expression::Or(left, right)
            | Expression::Xor(left, right) => {
                left.collect_measure_refs(names);
                right.collect_measure_refs(names);
            }
            Expression::Not(inner) | Expression::IsBlank(inner) => {
                inner.collect_measure_refs(names);
            }
            Expression::Aggregate { operand, .. } => operand.collect_measure_refs(names),
            Expression::Keep {
                expr, conditions, ..
            } => {
                expr.collect_measure_refs(names);
                for c in conditions {
                    c.collect_measure_refs(names);
                }
            }
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
            | Expression::ClearExcept { expr, .. }
            | Expression::Iterate {
                expression: expr, ..
            } => expr.collect_measure_refs(names),
            Expression::Block {
                bindings,
                query_scoped_bindings,
                result,
            } => {
                for (_, binding_expr) in bindings.iter().chain(query_scoped_bindings.iter()) {
                    binding_expr.collect_measure_refs(names);
                }
                result.collect_measure_refs(names);
            }
            Expression::If {
                condition,
                then_expr,
                else_expr,
            } => {
                condition.collect_measure_refs(names);
                then_expr.collect_measure_refs(names);
                else_expr.collect_measure_refs(names);
            }
            Expression::Switch {
                expr,
                cases,
                default,
            } => {
                expr.collect_measure_refs(names);
                for (v, r) in cases {
                    v.collect_measure_refs(names);
                    r.collect_measure_refs(names);
                }
                if let Some(d) = default {
                    d.collect_measure_refs(names);
                }
            }
            Expression::SafeDivide {
                numerator,
                denominator,
                alternate,
            } => {
                numerator.collect_measure_refs(names);
                denominator.collect_measure_refs(names);
                if let Some(alt) = alternate {
                    alt.collect_measure_refs(names);
                }
            }
            Expression::Coalesce(exprs)
            | Expression::Greatest(exprs)
            | Expression::Least(exprs) => {
                for e in exprs {
                    e.collect_measure_refs(names);
                }
            }
            Expression::ScalarFunc { args, .. }
            | Expression::TextFunc { args, .. }
            | Expression::DateTimeFunc { args, .. }
            | Expression::Call { args, .. } => {
                for arg in args {
                    arg.collect_measure_refs(names);
                }
            }
            Expression::IfError { expr, alternate } => {
                expr.collect_measure_refs(names);
                alternate.collect_measure_refs(names);
            }
            Expression::Percentile {
                operand,
                percentile,
            } => {
                operand.collect_measure_refs(names);
                percentile.collect_measure_refs(names);
            }
            Expression::Query { aggregates, .. } => {
                for (e, _) in aggregates {
                    e.collect_measure_refs(names);
                }
            }
            Expression::HasOneValue { column } => column.collect_measure_refs(names),
            Expression::SelectedValue { column, alternate } => {
                column.collect_measure_refs(names);
                if let Some(alt) = alternate {
                    alt.collect_measure_refs(names);
                }
            }
            Expression::FirstValue { column, order_by } => {
                column.collect_measure_refs(names);
                order_by.collect_measure_refs(names);
            }
            Expression::Window { inner, .. }
            | Expression::Offset { inner, .. }
            | Expression::Index { inner, .. } => inner.collect_measure_refs(names),
            Expression::ToDate { expr, .. }
            | Expression::PeriodShift { expr, .. }
            | Expression::DatesInPeriod { expr, .. }
            | Expression::SemiAdditiveBalance { expr, .. } => expr.collect_measure_refs(names),
            Expression::InList { expr, values } => {
                expr.collect_measure_refs(names);
                for v in values {
                    v.collect_measure_refs(names);
                }
            }
            Expression::NullIf { expr, value } => {
                expr.collect_measure_refs(names);
                value.collect_measure_refs(names);
            }
            Expression::CountIf { condition } => condition.collect_measure_refs(names),
            Expression::ListAgg { column, delimiter } => {
                column.collect_measure_refs(names);
                delimiter.collect_measure_refs(names);
            }
            Expression::MaxBy { value, sort_by } | Expression::MinBy { value, sort_by } => {
                value.collect_measure_refs(names);
                sort_by.collect_measure_refs(names);
            }
        }
    }

    /// Returns all **qualified** `Table[Column]` references in this expression
    /// tree as `(table_or_var, column)` pairs (deduplicated, sorted).
    ///
    /// Unlike [`column_references`](Self::column_references), which returns bare
    /// column names a host cannot attribute to a table, this preserves the
    /// qualifier so a host can resolve each reference against the data model
    /// (lineage, reachability checks, impact analysis). The first element is
    /// the qualifier as written: usually a model table name, but it may be a
    /// `VAR`/`QUERY` binding name in a table-variable expression — resolve it
    /// against the model's tables to keep only physical columns.
    pub fn qualified_column_references(&self) -> Vec<(&str, &str)> {
        let mut refs = Vec::new();
        self.collect_qualified_column_refs(&mut refs);
        refs.sort_unstable();
        refs.dedup();
        refs
    }

    fn collect_qualified_column_refs<'a>(&'a self, refs: &mut Vec<(&'a str, &'a str)>) {
        // Reuse the same traversal shape as `measure_references`: every node
        // recurses into its sub-expressions; only the QualifiedColumnRef leaf
        // contributes a pair. Bare ColumnRef has no attributable table and is
        // intentionally ignored here (use `column_references` for those).
        match self {
            Expression::QualifiedColumnRef {
                table_or_var,
                column,
            } => refs.push((table_or_var, column)),
            Expression::ColumnRef(_)
            | Expression::MeasureRef(_)
            | Expression::TableRef(_)
            | Expression::SelectedMeasure
            | Expression::LiteralFloat(_)
            | Expression::LiteralInt(_)
            | Expression::LiteralDate(_)
            | Expression::LiteralString(_)
            | Expression::LiteralBool(_)
            | Expression::Blank
            | Expression::IsInScope { .. }
            | Expression::RankWindow { .. } => {}
            Expression::BinaryOp { left, right, .. }
            | Expression::Comparison { left, right, .. }
            | Expression::And(left, right)
            | Expression::Or(left, right)
            | Expression::Xor(left, right) => {
                left.collect_qualified_column_refs(refs);
                right.collect_qualified_column_refs(refs);
            }
            Expression::Not(inner) | Expression::IsBlank(inner) => {
                inner.collect_qualified_column_refs(refs);
            }
            Expression::Aggregate { operand, .. } => operand.collect_qualified_column_refs(refs),
            Expression::Keep {
                expr, conditions, ..
            } => {
                expr.collect_qualified_column_refs(refs);
                for c in conditions {
                    c.collect_qualified_column_refs(refs);
                }
            }
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
            | Expression::ClearExcept { expr, .. }
            | Expression::Iterate {
                expression: expr, ..
            } => expr.collect_qualified_column_refs(refs),
            Expression::Block {
                bindings,
                query_scoped_bindings,
                result,
            } => {
                for (_, binding_expr) in bindings.iter().chain(query_scoped_bindings.iter()) {
                    binding_expr.collect_qualified_column_refs(refs);
                }
                result.collect_qualified_column_refs(refs);
            }
            Expression::If {
                condition,
                then_expr,
                else_expr,
            } => {
                condition.collect_qualified_column_refs(refs);
                then_expr.collect_qualified_column_refs(refs);
                else_expr.collect_qualified_column_refs(refs);
            }
            Expression::Switch {
                expr,
                cases,
                default,
            } => {
                expr.collect_qualified_column_refs(refs);
                for (v, r) in cases {
                    v.collect_qualified_column_refs(refs);
                    r.collect_qualified_column_refs(refs);
                }
                if let Some(d) = default {
                    d.collect_qualified_column_refs(refs);
                }
            }
            Expression::SafeDivide {
                numerator,
                denominator,
                alternate,
            } => {
                numerator.collect_qualified_column_refs(refs);
                denominator.collect_qualified_column_refs(refs);
                if let Some(alt) = alternate {
                    alt.collect_qualified_column_refs(refs);
                }
            }
            Expression::Coalesce(exprs)
            | Expression::Greatest(exprs)
            | Expression::Least(exprs) => {
                for e in exprs {
                    e.collect_qualified_column_refs(refs);
                }
            }
            Expression::ScalarFunc { args, .. }
            | Expression::TextFunc { args, .. }
            | Expression::DateTimeFunc { args, .. }
            | Expression::Call { args, .. } => {
                for arg in args {
                    arg.collect_qualified_column_refs(refs);
                }
            }
            Expression::IfError { expr, alternate } => {
                expr.collect_qualified_column_refs(refs);
                alternate.collect_qualified_column_refs(refs);
            }
            Expression::Percentile {
                operand,
                percentile,
            } => {
                operand.collect_qualified_column_refs(refs);
                percentile.collect_qualified_column_refs(refs);
            }
            Expression::Query { aggregates, .. } => {
                for (e, _) in aggregates {
                    e.collect_qualified_column_refs(refs);
                }
            }
            Expression::HasOneValue { column } => column.collect_qualified_column_refs(refs),
            Expression::SelectedValue { column, alternate } => {
                column.collect_qualified_column_refs(refs);
                if let Some(alt) = alternate {
                    alt.collect_qualified_column_refs(refs);
                }
            }
            Expression::FirstValue { column, order_by } => {
                column.collect_qualified_column_refs(refs);
                order_by.collect_qualified_column_refs(refs);
            }
            Expression::Window { inner, .. }
            | Expression::Offset { inner, .. }
            | Expression::Index { inner, .. } => inner.collect_qualified_column_refs(refs),
            Expression::ToDate { expr, .. }
            | Expression::PeriodShift { expr, .. }
            | Expression::DatesInPeriod { expr, .. }
            | Expression::SemiAdditiveBalance { expr, .. } => {
                expr.collect_qualified_column_refs(refs)
            }
            Expression::InList { expr, values } => {
                expr.collect_qualified_column_refs(refs);
                for v in values {
                    v.collect_qualified_column_refs(refs);
                }
            }
            Expression::NullIf { expr, value } => {
                expr.collect_qualified_column_refs(refs);
                value.collect_qualified_column_refs(refs);
            }
            Expression::CountIf { condition } => condition.collect_qualified_column_refs(refs),
            Expression::ListAgg { column, delimiter } => {
                column.collect_qualified_column_refs(refs);
                delimiter.collect_qualified_column_refs(refs);
            }
            Expression::MaxBy { value, sort_by } | Expression::MinBy { value, sort_by } => {
                value.collect_qualified_column_refs(refs);
                sort_by.collect_qualified_column_refs(refs);
            }
        }
    }

    /// Returns the names of all UDF [`Expression::Call`] nodes in this
    /// expression tree (deduplicated, sorted).
    ///
    /// Used by the engine facade to verify — before planning — that every
    /// UDF referenced by a query's measures is registered, producing a clear
    /// error instead of a DataFusion "invalid function" failure mid-execution.
    pub fn call_names(&self) -> Vec<&str> {
        let mut names = Vec::new();
        self.collect_call_names(&mut names);
        names.sort_unstable();
        names.dedup();
        names
    }

    fn collect_call_names<'a>(&'a self, names: &mut Vec<&'a str>) {
        match self {
            Expression::Call { name, args } => {
                names.push(name);
                for arg in args {
                    arg.collect_call_names(names);
                }
            }
            Expression::ColumnRef(_)
            | Expression::QualifiedColumnRef { .. }
            | Expression::TableRef(_)
            | Expression::MeasureRef(_)
            | Expression::SelectedMeasure
            | Expression::LiteralFloat(_)
            | Expression::LiteralInt(_)
            | Expression::LiteralDate(_)
            | Expression::LiteralString(_)
            | Expression::LiteralBool(_)
            | Expression::Blank
            | Expression::IsInScope { .. }
            | Expression::RankWindow { .. } => {}
            Expression::BinaryOp { left, right, .. }
            | Expression::Comparison { left, right, .. }
            | Expression::And(left, right)
            | Expression::Or(left, right)
            | Expression::Xor(left, right) => {
                left.collect_call_names(names);
                right.collect_call_names(names);
            }
            Expression::Not(inner) | Expression::IsBlank(inner) => {
                inner.collect_call_names(names);
            }
            Expression::Aggregate { operand, .. } => operand.collect_call_names(names),
            Expression::Keep {
                expr, conditions, ..
            } => {
                expr.collect_call_names(names);
                for c in conditions {
                    c.collect_call_names(names);
                }
            }
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
            | Expression::ClearExcept { expr, .. }
            | Expression::Iterate {
                expression: expr, ..
            } => expr.collect_call_names(names),
            Expression::Block {
                bindings,
                query_scoped_bindings,
                result,
            } => {
                for (_, binding_expr) in bindings.iter().chain(query_scoped_bindings.iter()) {
                    binding_expr.collect_call_names(names);
                }
                result.collect_call_names(names);
            }
            Expression::If {
                condition,
                then_expr,
                else_expr,
            } => {
                condition.collect_call_names(names);
                then_expr.collect_call_names(names);
                else_expr.collect_call_names(names);
            }
            Expression::Switch {
                expr,
                cases,
                default,
            } => {
                expr.collect_call_names(names);
                for (v, r) in cases {
                    v.collect_call_names(names);
                    r.collect_call_names(names);
                }
                if let Some(d) = default {
                    d.collect_call_names(names);
                }
            }
            Expression::SafeDivide {
                numerator,
                denominator,
                alternate,
            } => {
                numerator.collect_call_names(names);
                denominator.collect_call_names(names);
                if let Some(alt) = alternate {
                    alt.collect_call_names(names);
                }
            }
            Expression::Coalesce(exprs)
            | Expression::Greatest(exprs)
            | Expression::Least(exprs) => {
                for e in exprs {
                    e.collect_call_names(names);
                }
            }
            Expression::ScalarFunc { args, .. }
            | Expression::TextFunc { args, .. }
            | Expression::DateTimeFunc { args, .. } => {
                for arg in args {
                    arg.collect_call_names(names);
                }
            }
            Expression::IfError { expr, alternate } => {
                expr.collect_call_names(names);
                alternate.collect_call_names(names);
            }
            Expression::Percentile {
                operand,
                percentile,
            } => {
                operand.collect_call_names(names);
                percentile.collect_call_names(names);
            }
            Expression::Query { aggregates, .. } => {
                for (e, _) in aggregates {
                    e.collect_call_names(names);
                }
            }
            Expression::HasOneValue { column } => column.collect_call_names(names),
            Expression::SelectedValue { column, alternate } => {
                column.collect_call_names(names);
                if let Some(alt) = alternate {
                    alt.collect_call_names(names);
                }
            }
            Expression::FirstValue { column, order_by } => {
                column.collect_call_names(names);
                order_by.collect_call_names(names);
            }
            Expression::Window { inner, .. }
            | Expression::Offset { inner, .. }
            | Expression::Index { inner, .. } => inner.collect_call_names(names),
            Expression::ToDate { expr, .. }
            | Expression::PeriodShift { expr, .. }
            | Expression::DatesInPeriod { expr, .. }
            | Expression::SemiAdditiveBalance { expr, .. } => expr.collect_call_names(names),
            Expression::InList { expr, values } => {
                expr.collect_call_names(names);
                for v in values {
                    v.collect_call_names(names);
                }
            }
            Expression::NullIf { expr, value } => {
                expr.collect_call_names(names);
                value.collect_call_names(names);
            }
            Expression::CountIf { condition } => condition.collect_call_names(names),
            Expression::ListAgg { column, delimiter } => {
                column.collect_call_names(names);
                delimiter.collect_call_names(names);
            }
            Expression::MaxBy { value, sort_by } | Expression::MinBy { value, sort_by } => {
                value.collect_call_names(names);
                sort_by.collect_call_names(names);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn column_references_simple() {
        let expr = col("amount");
        assert_eq!(expr.column_references(), vec!["amount"]);
    }

    #[test]
    fn column_references_binary() {
        let expr = col("price").multiply(col("quantity"));
        assert_eq!(expr.column_references(), vec!["price", "quantity"]);
    }

    #[test]
    fn column_references_nested() {
        let expr = agg(AggregateOp::Sum, col("revenue").subtract(col("cost")));
        assert_eq!(expr.column_references(), vec!["cost", "revenue"]);
    }

    #[test]
    fn column_references_deduplicated() {
        // SUM(amount) / COUNT(amount)
        let expr =
            agg(AggregateOp::Sum, col("amount")).divide(agg(AggregateOp::Count, col("amount")));
        assert_eq!(expr.column_references(), vec!["amount"]);
    }

    #[test]
    fn column_references_literal_only() {
        let expr = lit(100.0);
        assert!(expr.column_references().is_empty());
    }

    #[test]
    fn column_references_through_context_ops() {
        let expr = keep(
            col("amount"),
            vec![FilterPredicate::new(
                "Sales",
                "Region",
                ComparisonOp::Equal,
                "US",
            )],
        );
        assert_eq!(expr.column_references(), vec!["amount"]);
    }

    #[test]
    fn block_column_references() {
        let expr = block(
            vec![("x".into(), col("price").multiply(col("qty")))],
            col("x"),
        );
        let refs = expr.column_references();
        assert!(refs.contains(&"price"));
        assert!(refs.contains(&"qty"));
        // "x" is a VAR binding name, not a real column — it should be excluded.
        assert!(!refs.contains(&"x"));
    }

    #[test]
    fn qualified_column_ref_column_references() {
        let expr = qualified_col("premium", "category");
        assert_eq!(expr.column_references(), vec!["category"]);
    }

    #[test]
    fn table_ref_no_column_references() {
        let expr = table_ref("premium");
        assert!(expr.column_references().is_empty());
    }

    #[test]
    fn new_exprs_column_references() {
        let expr = if_expr(
            compare(col("status"), ComparisonOp::Equal, lit_int(1)),
            col("revenue"),
            col("cost"),
        );
        let refs = expr.column_references();
        assert!(refs.contains(&"status"));
        assert!(refs.contains(&"revenue"));
        assert!(refs.contains(&"cost"));
    }

    #[test]
    fn literal_bool_no_column_refs() {
        assert!(lit_bool(true).column_references().is_empty());
    }

    #[test]
    fn xor_column_references() {
        let expr = xor(col("a"), col("b"));
        let refs = expr.column_references();
        assert!(refs.contains(&"a"));
        assert!(refs.contains(&"b"));
    }

    #[test]
    fn text_func_column_refs() {
        let expr = text_fn(TextFunction::Concatenate, vec![col("a"), col("b")]);
        let refs = expr.column_references();
        assert!(refs.contains(&"a"));
        assert!(refs.contains(&"b"));
    }

    #[test]
    fn window_column_refs() {
        let w = window_expr(
            agg(AggregateOp::Sum, qualified_col("fact", "amount")),
            AggregateOp::Sum,
            vec![("dim_date".into(), "month".into())],
            vec![],
            None,
        );
        let refs = w.column_references();
        assert_eq!(refs, vec!["amount"]);
    }

    #[test]
    fn call_column_references_collected_from_args() {
        let expr = call("myfunc", vec![col("a"), col("b").multiply(col("c"))]);
        assert_eq!(expr.column_references(), vec!["a", "b", "c"]);
    }

    #[test]
    fn call_names_collected_recursively() {
        let expr = agg(
            AggregateOp::Sum,
            call("outer_fn", vec![call("inner_fn", vec![col("x")])]),
        );
        assert_eq!(expr.call_names(), vec!["inner_fn", "outer_fn"]);
    }

    #[test]
    fn call_names_empty_without_calls() {
        let expr = agg(AggregateOp::Sum, col("amount"));
        assert!(expr.call_names().is_empty());
    }

    #[test]
    fn measure_references_collected_deduped_and_sorted() {
        // ([Revenue] - [Cost]) / [Revenue] references Revenue twice + Cost.
        let expr = Expression::MeasureRef("Revenue".into())
            .subtract(Expression::MeasureRef("Cost".into()))
            .divide(Expression::MeasureRef("Revenue".into()));
        assert_eq!(expr.measure_references(), vec!["Cost", "Revenue"]);
    }

    #[test]
    fn measure_references_found_inside_nested_variadic_nodes() {
        // A MeasureRef buried in GREATEST(...) must still be found (a node the
        // old `has_measure_ref` walker missed via its `_ => false` arm).
        let expr = Expression::Greatest(vec![col("x"), Expression::MeasureRef("Buried".into())]);
        assert_eq!(expr.measure_references(), vec!["Buried"]);
    }

    #[test]
    fn measure_references_empty_without_refs() {
        let expr = agg(AggregateOp::Sum, qualified_col("Sales", "amount"));
        assert!(expr.measure_references().is_empty());
    }

    #[test]
    fn qualified_column_references_keep_table_qualifier() {
        // SUM(Sales[amount]) / SUM(Sales[cost]) → two attributable pairs.
        let expr = agg(AggregateOp::Sum, qualified_col("Sales", "amount"))
            .divide(agg(AggregateOp::Sum, qualified_col("Sales", "cost")));
        assert_eq!(
            expr.qualified_column_references(),
            vec![("Sales", "amount"), ("Sales", "cost")]
        );
    }

    #[test]
    fn qualified_column_references_ignore_bare_columns() {
        // A bare (unqualified) column has no attributable table.
        let expr = agg(AggregateOp::Sum, col("amount"));
        assert!(expr.qualified_column_references().is_empty());
    }

    #[test]
    fn window_context_filter_tables() {
        let w = window_expr(
            agg(AggregateOp::Sum, qualified_col("fact", "amount")),
            AggregateOp::Sum,
            vec![("dim_date".into(), "month".into())],
            vec![("dim_product".into(), "category".into())],
            None,
        );
        let tables = w.context_filter_tables();
        assert!(tables.contains(&"dim_date"));
        assert!(tables.contains(&"dim_product"));
    }
}
