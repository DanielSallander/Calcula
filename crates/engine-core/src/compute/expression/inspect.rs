//! Structural inspection: aggregate, context-op, query, and window detection.

use super::*;

impl Expression {
    /// Returns `true` if this expression contains any `Aggregate` nodes.
    pub fn has_aggregate(&self) -> bool {
        match self {
            Expression::LookupValue { search, .. } => {
                search.iter().any(|(_, e)| e.has_aggregate())
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
            | Expression::Blank => false,
            Expression::BinaryOp { left, right, .. }
            | Expression::Comparison { left, right, .. }
            | Expression::And(left, right)
            | Expression::Or(left, right)
            | Expression::Xor(left, right) => left.has_aggregate() || right.has_aggregate(),
            Expression::Not(inner) | Expression::IsBlank(inner) => inner.has_aggregate(),
            Expression::Aggregate { .. } => true,
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
            | Expression::KeepIn { expr, .. } => expr.has_aggregate(),
            Expression::Block {
                bindings,
                query_scoped_bindings,
                result,
            } => {
                bindings
                    .iter()
                    .chain(query_scoped_bindings.iter())
                    .any(|(_, e)| e.has_aggregate())
                    || result.has_aggregate()
            }
            Expression::If {
                condition,
                then_expr,
                else_expr,
            } => {
                condition.has_aggregate() || then_expr.has_aggregate() || else_expr.has_aggregate()
            }
            Expression::Switch {
                expr,
                cases,
                default,
            } => {
                expr.has_aggregate()
                    || cases
                        .iter()
                        .any(|(v, r)| v.has_aggregate() || r.has_aggregate())
                    || default.as_ref().is_some_and(|d| d.has_aggregate())
            }
            Expression::SafeDivide {
                numerator,
                denominator,
                alternate,
            } => {
                numerator.has_aggregate()
                    || denominator.has_aggregate()
                    || alternate.as_ref().is_some_and(|a| a.has_aggregate())
            }
            Expression::Coalesce(exprs) => exprs.iter().any(|e| e.has_aggregate()),
            Expression::ScalarFunc { args, .. }
            | Expression::TextFunc { args, .. }
            | Expression::DateTimeFunc { args, .. } => args.iter().any(|a| a.has_aggregate()),
            Expression::IfError { expr, alternate } => {
                expr.has_aggregate() || alternate.has_aggregate()
            }
            Expression::IsInScope { .. } | Expression::IsFiltered { .. } => false,
            Expression::ClearExcept { expr, .. } => expr.has_aggregate(),
            Expression::Iterate { expression, .. } => expression.has_aggregate(),
            Expression::Percentile { .. } => true,
            Expression::Query { .. } => true,
            // These functions contain implicit aggregates.
            Expression::HasOneValue { .. }
            | Expression::SelectedValue { .. }
            | Expression::FirstValue { .. } => true,
            // Window functions contain implicit aggregates (two-stage).
            Expression::Window { .. } | Expression::Offset { .. } | Expression::Index { .. } => {
                true
            }
            // Time-intelligence sugar lowers to window functions (two-stage).
            Expression::ToDate { .. }
            | Expression::PeriodShift { .. }
            | Expression::DatesInPeriod { .. }
            | Expression::SemiAdditiveBalance { .. } => true,
            Expression::InList { expr, values } => {
                expr.has_aggregate() || values.iter().any(|v| v.has_aggregate())
            }
            Expression::Greatest(args) | Expression::Least(args) => {
                args.iter().any(|a| a.has_aggregate())
            }
            Expression::NullIf { expr, value } => expr.has_aggregate() || value.has_aggregate(),
            // CountIf, ListAgg, MaxBy, MinBy are implicit aggregates.
            Expression::CountIf { .. }
            | Expression::ListAgg { .. }
            | Expression::MaxBy { .. }
            | Expression::MinBy { .. } => true,
            Expression::RankWindow { .. } => true,
            // A UDF call is row-level, never an aggregate itself — but its
            // arguments may contain aggregates.
            Expression::Call { args, .. } => args.iter().any(|a| a.has_aggregate()),
        }
    }

    /// Returns `true` if this expression contains any context manipulation nodes
    /// (`Keep`, `Clear`, `Reset`, `Traverse`, `Using`, or `Block`).
    pub fn has_context_ops(&self) -> bool {
        match self {
            Expression::LookupValue { search, .. } => {
                search.iter().any(|(_, e)| e.has_context_ops())
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
            | Expression::Blank => false,
            Expression::BinaryOp { left, right, .. }
            | Expression::Comparison { left, right, .. }
            | Expression::And(left, right)
            | Expression::Or(left, right)
            | Expression::Xor(left, right) => left.has_context_ops() || right.has_context_ops(),
            Expression::Not(inner) | Expression::IsBlank(inner) => inner.has_context_ops(),
            Expression::Aggregate { operand, .. } => operand.has_context_ops(),
            Expression::Keep { .. }
            | Expression::Clear { .. }
            | Expression::Reset { .. }
            | Expression::ClearInner { .. }
            | Expression::ClearOuter { .. }
            | Expression::ResetInner { .. }
            | Expression::ResetOuter { .. }
            | Expression::Traverse { .. }
            | Expression::Using { .. }
            | Expression::UseRelationship { .. }
            | Expression::KeepIn { .. } => true,
            Expression::Block {
                bindings,
                query_scoped_bindings,
                result,
            } => {
                bindings
                    .iter()
                    .chain(query_scoped_bindings.iter())
                    .any(|(_, expr)| expr.has_context_ops())
                    || result.has_context_ops()
            }
            Expression::If {
                condition,
                then_expr,
                else_expr,
            } => {
                condition.has_context_ops()
                    || then_expr.has_context_ops()
                    || else_expr.has_context_ops()
            }
            Expression::Switch {
                expr,
                cases,
                default,
            } => {
                expr.has_context_ops()
                    || cases
                        .iter()
                        .any(|(v, r)| v.has_context_ops() || r.has_context_ops())
                    || default.as_ref().is_some_and(|d| d.has_context_ops())
            }
            Expression::SafeDivide {
                numerator,
                denominator,
                alternate,
            } => {
                numerator.has_context_ops()
                    || denominator.has_context_ops()
                    || alternate.as_ref().is_some_and(|a| a.has_context_ops())
            }
            Expression::Coalesce(exprs) => exprs.iter().any(|e| e.has_context_ops()),
            Expression::ScalarFunc { args, .. }
            | Expression::TextFunc { args, .. }
            | Expression::DateTimeFunc { args, .. } => args.iter().any(|a| a.has_context_ops()),
            Expression::IfError { expr, alternate } => {
                expr.has_context_ops() || alternate.has_context_ops()
            }
            Expression::IsInScope { .. } | Expression::IsFiltered { .. } => false,
            Expression::ClearExcept { .. } => true,
            Expression::Iterate { expression, .. } => expression.has_context_ops(),
            Expression::Percentile {
                operand,
                percentile,
            } => operand.has_context_ops() || percentile.has_context_ops(),
            Expression::Query { aggregates, .. } => {
                aggregates.iter().any(|(e, _)| e.has_context_ops())
            }
            Expression::HasOneValue { column } => column.has_context_ops(),
            Expression::SelectedValue { column, alternate } => {
                column.has_context_ops() || alternate.as_ref().is_some_and(|a| a.has_context_ops())
            }
            Expression::FirstValue { column, order_by } => {
                column.has_context_ops() || order_by.has_context_ops()
            }
            Expression::Window { inner, .. }
            | Expression::Offset { inner, .. }
            | Expression::Index { inner, .. } => inner.has_context_ops(),
            Expression::ToDate { expr, .. }
            | Expression::PeriodShift { expr, .. }
            | Expression::DatesInPeriod { expr, .. }
            | Expression::SemiAdditiveBalance { expr, .. } => expr.has_context_ops(),
            Expression::InList { expr, values } => {
                expr.has_context_ops() || values.iter().any(|v| v.has_context_ops())
            }
            Expression::Greatest(args) | Expression::Least(args) => {
                args.iter().any(|a| a.has_context_ops())
            }
            Expression::NullIf { expr, value } => expr.has_context_ops() || value.has_context_ops(),
            Expression::CountIf { condition } => condition.has_context_ops(),
            Expression::ListAgg { column, delimiter } => {
                column.has_context_ops() || delimiter.has_context_ops()
            }
            Expression::MaxBy { value, sort_by } | Expression::MinBy { value, sort_by } => {
                value.has_context_ops() || sort_by.has_context_ops()
            }
            Expression::RankWindow { .. } => false,
            Expression::Call { args, .. } => args.iter().any(|a| a.has_context_ops()),
        }
    }

    /// Returns `true` if this expression is a simple `AGG(column)` pattern.
    ///
    /// This is the pattern that can be pushed down to data sources.
    /// Matches both unqualified `ColumnRef` and qualified `QualifiedColumnRef`
    /// (e.g., from `parse_measure("SUM(table[col])")`).
    pub fn is_simple_aggregate(&self) -> bool {
        if let Expression::Aggregate { operation, operand } = self {
            if *operation == AggregateOp::CountRows {
                return true;
            }
            matches!(
                operand.as_ref(),
                Expression::ColumnRef(_) | Expression::QualifiedColumnRef { .. }
            )
        } else {
            false
        }
    }

    /// If this is a simple aggregate, returns `(operation, column_name)`.
    ///
    /// For `CountRows`, returns `("*")` as the column name since it has no column.
    pub fn as_simple_aggregate(&self) -> Option<(AggregateOp, &str)> {
        if let Expression::Aggregate { operation, operand } = self {
            if *operation == AggregateOp::CountRows {
                return Some((AggregateOp::CountRows, "*"));
            }
            match operand.as_ref() {
                Expression::ColumnRef(col) => return Some((*operation, col)),
                Expression::QualifiedColumnRef { column, .. } => return Some((*operation, column)),
                _ => {}
            }
        }
        None
    }

    /// Returns `true` if this is a `Query` expression.
    pub fn is_query(&self) -> bool {
        matches!(self, Expression::Query { .. })
    }

    /// Returns `true` if this is a `Block` with at least one `Query` binding.
    pub fn has_query_bindings(&self) -> bool {
        match self {
            Expression::Block { bindings, .. } => bindings.iter().any(|(_, e)| e.is_query()),
            _ => false,
        }
    }

    /// Returns `true` if this tree contains a `Block` carrying any query-scoped
    /// (`GVAR`) binding.
    ///
    /// Query-scoped bindings are resolved to literals at the facade before
    /// planning; any code path that would render or context-resolve an
    /// expression uses this to **fail closed** if one survived (a facade bypass
    /// or the lower-level `MeasureEngine` path, which cannot resolve them).
    pub fn has_query_scoped_bindings(&self) -> bool {
        matches!(
            self,
            Expression::Block { query_scoped_bindings, .. } if !query_scoped_bindings.is_empty()
        ) || super::child_expressions(self)
            .iter()
            .any(|c| c.has_query_scoped_bindings())
    }

    /// Returns `true` if this tree contains an `ISFILTERED(...)` marker
    /// ([`Expression::IsFiltered`]) anywhere. Drives the facade's pre-plan
    /// literal fold and the host's format-version stamping (v16).
    pub fn contains_is_filtered(&self) -> bool {
        matches!(self, Expression::IsFiltered { .. })
            || super::child_expressions(self)
                .iter()
                .any(|c| c.contains_is_filtered())
    }

    /// Returns `true` if this tree contains a `LOOKUPVALUE(...)` node
    /// ([`Expression::LookupValue`]). Drives validation (only plain
    /// calculated columns may carry lookups, and they must not nest) and the
    /// host's format-version stamping (v17).
    pub fn has_lookup_value(&self) -> bool {
        matches!(self, Expression::LookupValue { .. })
            || super::child_expressions(self)
                .iter()
                .any(|c| c.has_lookup_value())
    }

    /// Returns `true` if this tree contains a `PATHLENGTH(...)` or
    /// `PATHITEM(...)` call ([`TextFunction::PathLength`] /
    /// [`TextFunction::PathItem`]) anywhere. Drives the host's
    /// format-version stamping (v19) — a pre-v19 engine fails to
    /// deserialize these variants.
    ///
    /// [`TextFunction::PathLength`]: super::TextFunction::PathLength
    /// [`TextFunction::PathItem`]: super::TextFunction::PathItem
    pub fn contains_path_functions(&self) -> bool {
        matches!(
            self,
            Expression::TextFunc {
                function: super::TextFunction::PathLength | super::TextFunction::PathItem,
                ..
            }
        ) || super::child_expressions(self)
            .iter()
            .any(|c| c.contains_path_functions())
    }

    /// Returns `true` if this tree contains an [`Expression::Query`]
    /// (table-producing two-stage aggregation) node anywhere.
    ///
    /// Used to enforce that a query-scoped (`GVAR`) binding is a genuine
    /// scalar: a `QUERY` may be nested at any expression position, so the
    /// top-level [`is_query`](Self::is_query) check alone would miss
    /// `SUM(x) + QUERY(...)`.
    pub(crate) fn contains_query(&self) -> bool {
        self.is_query()
            || super::child_expressions(self)
                .iter()
                .any(|c| c.contains_query())
    }

    /// Names of the query-scoped (`GVAR`) bindings declared at the **root** of
    /// this expression (empty when the root is not a `Block` or declares none).
    ///
    /// Because `GVAR` is only ever produced at the top level of a measure (the
    /// parser enters the block only at the measure root, and
    /// [`validate_query_scoped_top_level`](Self::validate_query_scoped_top_level)
    /// rejects any nested occurrence), these are all the `GVAR` names a measure
    /// declares.
    pub fn root_query_scoped_names(&self) -> Vec<&str> {
        match self {
            Expression::Block {
                query_scoped_bindings,
                ..
            } => query_scoped_bindings
                .iter()
                .map(|(n, _)| n.as_str())
                .collect(),
            _ => Vec::new(),
        }
    }

    /// Enforces that query-scoped (`GVAR`) bindings appear **only** at the top
    /// level of a measure expression — never nested inside another `Block`,
    /// a context operation, an aggregate, etc.
    ///
    /// The parser guarantees this for authored measures (the VAR/GVAR block is
    /// parsed only at the measure root); this method is the fail-closed gate for
    /// hand-written or tampered model JSON, where a nested `query_scoped_bindings`
    /// could otherwise reach a code path that cannot resolve it.
    ///
    /// Returns [`EngineError::InvalidExpression`] on a nested occurrence.
    pub fn validate_query_scoped_top_level(&self) -> EngineResult<()> {
        // Only the root Block may carry query-scoped bindings; nothing beneath
        // it (including a root GVAR binding's own subtree) may. Starting the
        // check at the root's CHILDREN exempts exactly the root Block's own
        // list.
        if super::child_expressions(self)
            .iter()
            .any(|c| c.has_query_scoped_bindings())
        {
            Err(EngineError::InvalidExpression(
                "query-scoped (GVAR) variables are only allowed at the top level of a measure; \
                 they cannot be nested inside another VAR/RETURN block, a context operation, or \
                 any other expression"
                    .to_string(),
            ))
        } else {
            Ok(())
        }
    }

    /// Returns `true` if this expression is a `Window`, `Offset`, or `Index`
    /// expression — or time-intelligence sugar (`ToDate`/`PeriodShift`)
    /// that lowers to one.
    pub fn is_window(&self) -> bool {
        matches!(
            self,
            Expression::Window { .. }
                | Expression::Offset { .. }
                | Expression::Index { .. }
                | Expression::ToDate { .. }
                | Expression::PeriodShift { .. }
                | Expression::DatesInPeriod { .. }
                | Expression::SemiAdditiveBalance { .. }
        )
    }

    /// Returns `true` if this expression contains any window function nodes.
    ///
    /// Time-intelligence sugar (`ToDate`/`PeriodShift`) counts as a window
    /// node: it is lowered onto the Window/Offset machinery and must route
    /// through the same two-stage execution path.
    pub fn has_window(&self) -> bool {
        // RankWindow (RANK/ROW_NUMBER/DENSE_RANK) also routes through the
        // window two-stage path. Omitting it sent the node down the normal
        // SQL path, which emitted a `/* RANK_WINDOW … */` placeholder and
        // produced a broken statement; routing it here yields a clean typed
        // error until execution lands.
        //
        // Recursion goes through the generic `child_expressions` enumerator so
        // a window buried in ANY combinator (Switch, Greatest, MaxBy, InList,
        // SelectedValue, …) is found — a previous hand-written match with a
        // `_ => false` catch-all missed a dozen node kinds, which let e.g.
        // `SWITCH(1, 1, WINDOW(...), 0)` slip past the GVAR scalar-only guard
        // and the executor's window routing.
        matches!(
            self,
            Expression::Window { .. }
                | Expression::Offset { .. }
                | Expression::Index { .. }
                | Expression::RankWindow { .. }
                | Expression::ToDate { .. }
                | Expression::PeriodShift { .. }
                | Expression::DatesInPeriod { .. }
                | Expression::SemiAdditiveBalance { .. }
        ) || super::child_expressions(self)
            .iter()
            .any(|c| c.has_window())
    }

    /// Returns `true` if this expression contains a FILTER-CONTEXT
    /// time-intelligence node (`ToDate`/`PeriodShift`/`DatesInPeriod`/
    /// `SemiAdditiveBalance`) — at the top level or nested inside a compound
    /// combinator (`+ - * /`, `DIVIDE`, `IF`, `COALESCE`, `IFERROR`), the shapes
    /// a compound time-intelligence measure (e.g. YoY = `YTD − PRIORYEAR`) uses.
    ///
    /// Unlike [`has_window`](Self::has_window), this **excludes** the axis-only
    /// `Window`/`Offset`/`Index`/`RankWindow` nodes: it drives the off-axis
    /// date-table fetch and the date-filter handling for filter-context time
    /// intelligence (so a compound such as YoY pulls in the full calendar, not
    /// just the request's date-filtered slice). The recursion covers exactly the
    /// combinators a compound time-intelligence measure may use.
    pub fn contains_time_intelligence(&self) -> bool {
        match self {
            Expression::ToDate { .. }
            | Expression::PeriodShift { .. }
            | Expression::DatesInPeriod { .. }
            | Expression::SemiAdditiveBalance { .. } => true,
            Expression::BinaryOp { left, right, .. } => {
                left.contains_time_intelligence() || right.contains_time_intelligence()
            }
            Expression::SafeDivide {
                numerator,
                denominator,
                alternate,
            } => {
                numerator.contains_time_intelligence()
                    || denominator.contains_time_intelligence()
                    || alternate
                        .as_ref()
                        .is_some_and(|a| a.contains_time_intelligence())
            }
            Expression::If {
                condition,
                then_expr,
                else_expr,
            } => {
                condition.contains_time_intelligence()
                    || then_expr.contains_time_intelligence()
                    || else_expr.contains_time_intelligence()
            }
            Expression::Coalesce(exprs) => exprs.iter().any(|e| e.contains_time_intelligence()),
            Expression::IfError { expr, alternate } => {
                expr.contains_time_intelligence() || alternate.contains_time_intelligence()
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_window() -> Expression {
        window_expr(
            agg(AggregateOp::Sum, qualified_col("sales", "amount")),
            AggregateOp::Sum,
            vec![("dim_date".into(), "month".into())],
            vec![],
            None,
        )
    }

    #[test]
    fn has_window_finds_window_buried_in_any_combinator() {
        // Regression: the old hand-written match had a `_ => false` catch-all
        // that missed Switch/Greatest/Least/MaxBy/MinBy/InList/NullIf/CountIf/
        // ListAgg/SelectedValue/FirstValue/HasOneValue — letting e.g.
        // `SWITCH(1, 1, WINDOW(...), 0)` slip past the GVAR scalar-only guard.
        let w = sample_window();
        assert!(switch(lit_int(1), vec![(lit_int(1), w.clone())], Some(lit_int(0))).has_window());
        assert!(Expression::Greatest(vec![w.clone(), lit_int(0)]).has_window());
        assert!(Expression::Least(vec![w.clone(), lit_int(0)]).has_window());
        assert!(Expression::MaxBy {
            value: Box::new(w.clone()),
            sort_by: Box::new(col("x")),
        }
        .has_window());
        assert!(Expression::NullIf {
            expr: Box::new(w.clone()),
            value: Box::new(lit_int(0)),
        }
        .has_window());
        assert!(Expression::InList {
            expr: Box::new(w.clone()),
            values: vec![lit_int(1)],
        }
        .has_window());
        assert!(selected_value(w.clone(), None).has_window());
        // And plain shapes still behave.
        assert!(w.has_window());
        assert!(!agg(AggregateOp::Sum, col("x")).has_window());
        assert!(!switch(lit_int(1), vec![(lit_int(1), lit_int(2))], None).has_window());
    }

    #[test]
    fn has_query_scoped_bindings_finds_nested_blocks() {
        let gvar_block = block_with_globals(
            vec![("g".into(), agg(AggregateOp::Sum, col("x")))],
            vec![],
            col("g"),
        );
        // Direct.
        assert!(gvar_block.has_query_scoped_bindings());
        // Nested inside arithmetic.
        assert!(gvar_block
            .clone()
            .add(lit_int(1))
            .has_query_scoped_bindings());
        // Nested inside a Switch case result.
        assert!(
            switch(lit_int(1), vec![(lit_int(1), gvar_block)], None).has_query_scoped_bindings()
        );
        // Plain VAR block: no.
        assert!(!block(
            vec![("v".into(), agg(AggregateOp::Sum, col("x")))],
            col("v")
        )
        .has_query_scoped_bindings());
    }

    #[test]
    fn root_query_scoped_names_lists_only_root_gvars() {
        let e = block_with_globals(
            vec![
                ("a".into(), agg(AggregateOp::Sum, col("x"))),
                ("b".into(), lit_int(1)),
            ],
            vec![("v".into(), lit_int(2))],
            col("a"),
        );
        assert_eq!(e.root_query_scoped_names(), vec!["a", "b"]);
        assert!(col("x").root_query_scoped_names().is_empty());
        assert!(block(vec![("v".into(), lit_int(1))], col("v"))
            .root_query_scoped_names()
            .is_empty());
    }

    #[test]
    fn validate_query_scoped_top_level_rejects_nested_only() {
        // Root-level GVARs are fine.
        let root = block_with_globals(
            vec![("g".into(), agg(AggregateOp::Sum, col("x")))],
            vec![],
            col("g"),
        );
        assert!(root.validate_query_scoped_top_level().is_ok());

        // A GVAR block nested under arithmetic is rejected.
        let nested = root.clone().add(lit_int(1));
        assert!(nested.validate_query_scoped_top_level().is_err());

        // A GVAR block nested inside a root Block's VAR binding is rejected.
        let buried = block(vec![("v".into(), root)], col("v"));
        assert!(buried.validate_query_scoped_top_level().is_err());

        // Expressions without GVARs anywhere are fine.
        assert!(col("x").validate_query_scoped_top_level().is_ok());
    }

    #[test]
    fn has_aggregate_detection() {
        assert!(!col("x").has_aggregate());
        assert!(!lit(1.0).has_aggregate());
        assert!(!col("a").add(col("b")).has_aggregate());
        assert!(agg(AggregateOp::Sum, col("x")).has_aggregate());
        assert!(agg(AggregateOp::Sum, col("x"))
            .divide(agg(AggregateOp::Count, col("y")))
            .has_aggregate());
    }

    #[test]
    fn is_simple_aggregate_detection() {
        assert!(agg(AggregateOp::Sum, col("amount")).is_simple_aggregate());
        assert!(agg(AggregateOp::DistinctCount, col("id")).is_simple_aggregate());
        // QualifiedColumnRef is also simple
        assert!(agg(AggregateOp::Sum, qualified_col("sales", "amount")).is_simple_aggregate());
        assert!(
            agg(AggregateOp::DistinctCount, qualified_col("orders", "id")).is_simple_aggregate()
        );
        // Not simple: aggregate over expression
        assert!(!agg(AggregateOp::Sum, col("price").multiply(col("qty"))).is_simple_aggregate());
        // Not simple: ratio
        assert!(!agg(AggregateOp::Sum, col("a"))
            .divide(agg(AggregateOp::Count, col("b")))
            .is_simple_aggregate());
        // Not an aggregate at all
        assert!(!col("x").is_simple_aggregate());
        assert!(!qualified_col("t", "x").is_simple_aggregate());
    }

    #[test]
    fn as_simple_aggregate_extraction() {
        let expr = agg(AggregateOp::Sum, col("amount"));
        let (op, column) = expr.as_simple_aggregate().unwrap();
        assert_eq!(op, AggregateOp::Sum);
        assert_eq!(column, "amount");

        // QualifiedColumnRef extracts the column name
        let expr2 = agg(AggregateOp::Sum, qualified_col("sales", "price"));
        let (op2, col2) = expr2.as_simple_aggregate().unwrap();
        assert_eq!(op2, AggregateOp::Sum);
        assert_eq!(col2, "price");

        // Complex expression returns None
        let complex = agg(AggregateOp::Sum, col("a").add(col("b")));
        assert!(complex.as_simple_aggregate().is_none());
    }

    #[test]
    fn has_context_ops_detection() {
        assert!(!col("x").has_context_ops());
        assert!(!agg(AggregateOp::Sum, col("x")).has_context_ops());
        assert!(keep(col("x"), vec![]).has_context_ops());
        assert!(clear(col("x"), vec![]).has_context_ops());
        assert!(reset(col("x")).has_context_ops());
        assert!(using(col("x"), "ctx").has_context_ops());
        assert!(traverse(col("x"), RelationshipPath::new(vec!["A", "B"])).has_context_ops());
        // Nested inside aggregate
        assert!(agg(AggregateOp::Sum, keep(col("x"), vec![])).has_context_ops());
    }

    #[test]
    fn has_aggregate_through_context_ops() {
        let expr = keep(agg(AggregateOp::Sum, col("amount")), vec![]);
        assert!(expr.has_aggregate());

        let expr2 = reset(col("amount"));
        assert!(!expr2.has_aggregate());
    }

    #[test]
    fn nested_context_ops() {
        // keep(clear(expr, Region), Year = 2024) — the "override" pattern
        let expr = keep(
            clear(
                col("amount"),
                vec![ClearTarget::Column {
                    table: "Calendar".into(),
                    column: "Year".into(),
                }],
            ),
            vec![FilterPredicate::new(
                "Calendar",
                "Year",
                ComparisonOp::Equal,
                "2024",
            )],
        );
        assert!(expr.has_context_ops());
        assert!(!expr.has_aggregate());
        assert_eq!(expr.to_sql_string().unwrap(), "\"amount\"");
    }

    #[test]
    fn qualified_column_ref_no_context_ops() {
        assert!(!qualified_col("X", "y").has_context_ops());
        assert!(!table_ref("X").has_context_ops());
    }

    #[test]
    fn keep_in_has_context_ops() {
        let expr = keep_in(col("amount"), vec![InPredicate::new("S", "c", "v", "c2")]);
        assert!(expr.has_context_ops());
    }

    #[test]
    fn if_expr_has_aggregate() {
        let expr = if_expr(
            compare(
                agg(AggregateOp::Sum, col("a")),
                ComparisonOp::GreaterThan,
                lit_int(0),
            ),
            agg(AggregateOp::Sum, col("a")),
            lit_int(0),
        );
        assert!(expr.has_aggregate());
    }

    #[test]
    fn count_rows_as_simple_aggregate() {
        let expr = count_rows();
        let (op, col_name) = expr.as_simple_aggregate().unwrap();
        assert_eq!(op, AggregateOp::CountRows);
        assert_eq!(col_name, "*");
    }

    #[test]
    fn new_exprs_no_context_ops() {
        assert!(!if_expr(
            compare(col("x"), ComparisonOp::Equal, lit_int(1)),
            lit_int(1),
            lit_int(0),
        )
        .has_context_ops());
        assert!(!safe_divide(col("a"), col("b"), None).has_context_ops());
        assert!(!coalesce(vec![col("a"), lit_int(0)]).has_context_ops());
        assert!(!scalar_fn(ScalarFunction::Abs, vec![col("x")]).has_context_ops());
        assert!(!blank().has_context_ops());
        assert!(!is_blank(col("x")).has_context_ops());
    }

    #[test]
    fn block_without_context_ops_returns_false() {
        let expr = block(
            vec![("total".into(), agg(AggregateOp::Sum, col("amount")))],
            col("total"),
        );
        assert!(!expr.has_context_ops());
    }

    #[test]
    fn block_with_context_ops_returns_true() {
        use crate::model::ClearTarget;
        let clear_expr = Expression::Clear {
            expr: Box::new(agg(AggregateOp::Sum, col("amount"))),
            targets: vec![ClearTarget::Table("dim".to_string())],
        };
        let expr = block(vec![("total".into(), clear_expr)], col("total"));
        assert!(expr.has_context_ops());
    }

    #[test]
    fn has_one_value_has_aggregate() {
        let expr = has_one_value(col("region"));
        assert!(expr.has_aggregate());
    }

    #[test]
    fn selected_value_has_aggregate() {
        let expr = selected_value(col("region"), None);
        assert!(expr.has_aggregate());
    }

    #[test]
    fn first_value_has_aggregate() {
        let expr = first_value(col("name"), col("sort_order"));
        assert!(expr.has_aggregate());
    }

    #[test]
    fn literal_bool_no_aggregate() {
        assert!(!lit_bool(true).has_aggregate());
        assert!(!lit_bool(false).has_aggregate());
    }

    #[test]
    fn literal_bool_no_context_ops() {
        assert!(!lit_bool(true).has_context_ops());
    }

    #[test]
    fn xor_has_aggregate() {
        let expr = xor(
            agg(AggregateOp::Sum, col("a")),
            agg(AggregateOp::Count, col("b")),
        );
        assert!(expr.has_aggregate());
    }

    #[test]
    fn xor_no_context_ops() {
        assert!(!xor(col("a"), col("b")).has_context_ops());
    }

    #[test]
    fn text_func_no_aggregate() {
        assert!(!text_fn(TextFunction::Upper, vec![col("x")]).has_aggregate());
    }

    #[test]
    fn text_func_no_context_ops() {
        assert!(!text_fn(TextFunction::Lower, vec![col("x")]).has_context_ops());
    }

    #[test]
    fn window_has_aggregate() {
        let w = window_expr(
            agg(AggregateOp::Sum, qualified_col("fact", "amount")),
            AggregateOp::Sum,
            vec![("dim_date".into(), "month".into())],
            vec![],
            None,
        );
        assert!(w.has_aggregate());
        assert!(w.has_window());
        assert!(w.is_window());
    }

    #[test]
    fn window_not_simple_aggregate() {
        let w = window_expr(
            agg(AggregateOp::Sum, qualified_col("fact", "amount")),
            AggregateOp::Sum,
            vec![("dim_date".into(), "month".into())],
            vec![],
            None,
        );
        assert!(!w.is_simple_aggregate());
    }

    #[test]
    fn call_is_not_an_aggregate_itself() {
        let expr = call("double", vec![col("amount")]);
        assert!(!expr.has_aggregate());
        assert!(!expr.is_simple_aggregate());
        assert!(!expr.has_context_ops());
    }

    #[test]
    fn call_has_aggregate_recurses_into_args() {
        let expr = call("pct_of", vec![agg(AggregateOp::Sum, col("a")), col("b")]);
        assert!(expr.has_aggregate());
    }

    #[test]
    fn aggregate_over_call_is_not_simple() {
        let expr = agg(AggregateOp::Sum, call("double", vec![col("amount")]));
        assert!(expr.has_aggregate());
        assert!(!expr.is_simple_aggregate());
        assert!(expr.as_simple_aggregate().is_none());
    }

    #[test]
    fn call_has_context_ops_recurses_into_args() {
        let expr = call("double", vec![keep(col("x"), vec![])]);
        assert!(expr.has_context_ops());
    }

    #[test]
    fn offset_basic() {
        let o = offset_expr(
            agg(AggregateOp::Sum, qualified_col("fact", "amount")),
            -1,
            vec![("dim".into(), "month".into())],
            vec![],
        );
        assert!(o.has_aggregate());
        assert!(o.has_window());
        assert!(o.is_window());
        assert!(!o.is_simple_aggregate());
    }

    #[test]
    fn index_basic() {
        let i = index_expr(
            agg(AggregateOp::Sum, qualified_col("fact", "amount")),
            1,
            vec![("dim".into(), "month".into())],
            vec![],
        );
        assert!(i.has_aggregate());
        assert!(i.has_window());
        assert!(i.is_window());
    }
}
