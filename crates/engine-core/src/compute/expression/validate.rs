//! Expression validation: identifier checks and interval allow-list enforcement.

use super::functions::validate_interval_keyword;
use super::*;

/// Maximum length (in bytes) of a UDF call name.
const MAX_CALL_NAME_LEN: usize = 64;

/// Returns `true` when `name` is a safe UDF call name:
/// `^[A-Za-z_][A-Za-z0-9_]{0,63}$`.
///
/// [`Expression::Call`] names are spliced into generated SQL **without
/// quoting** (DataFusion resolves them as plain function identifiers), so
/// this rule is the injection gate for UDF calls. It is enforced in three
/// places: the measure parser (before emitting a `Call` node),
/// [`Expression::validate`] (covering expressions deserialized from
/// untrusted model files), and the SQL renderer (fail closed even if the
/// earlier gates were bypassed).
pub fn is_valid_call_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == '_') {
        return false;
    }
    if name.len() > MAX_CALL_NAME_LEN {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Validate a UDF call name, returning a descriptive error when it violates
/// the [`is_valid_call_name`] rule.
pub(crate) fn validate_call_name(name: &str) -> EngineResult<()> {
    if is_valid_call_name(name) {
        Ok(())
    } else {
        Err(EngineError::InvalidIdentifier {
            name: name.to_string(),
            reason: format!(
                "UDF call name must match [A-Za-z_][A-Za-z0-9_]* and be at most \
                 {MAX_CALL_NAME_LEN} characters (it is rendered unquoted into SQL)"
            ),
        })
    }
}

impl Expression {
    /// Validate this expression tree for safe SQL rendering.
    ///
    /// Expressions normally come from the measure parser, which enforces
    /// allow-lists (e.g. the DATEDIFF/DATEADD/DATE_TRUNC/LAST_DAY interval
    /// keywords) before building the tree. Model files, however, can contain
    /// hand-written or tampered JSON that deserializes directly into an
    /// `Expression`, bypassing the parser entirely. This method re-checks
    /// every string field that the SQL renderers interpolate **without**
    /// routing through the quoting helpers in [`crate::compute::sql_util`]:
    ///
    /// - Date/time interval keywords must be literal strings from the same
    ///   allow-lists the parser enforces — [`DateTimeFunction::to_sql_strs`]
    ///   splices them into SQL raw.
    /// - Table names rendered as raw (unquoted, lowercased) SQL qualifiers:
    ///   `QualifiedColumnRef::table_or_var`, `TableRef`, `Query` group-by
    ///   tables, `Window`/`Offset`/`Index`/`RankWindow` ORDER BY /
    ///   PARTITION BY tables, filter-predicate tables, and table-variable
    ///   references.
    /// - `Block` binding names, which become registered table names that
    ///   appear raw in FROM clauses when a binding is a QUERY.
    /// - `Call` (UDF) names, which are rendered as unquoted SQL function
    ///   identifiers — they must match `[A-Za-z_][A-Za-z0-9_]{0,63}`
    ///   (see [`is_valid_call_name`]).
    ///
    /// Column names, literals, and output aliases are exempt: every renderer
    /// routes them through `quote_ident_double` / `sql_quote_literal`.
    ///
    /// Called for every model-level expression during
    /// `DataModelBuilder::build()`, which `DataModel::validate()` delegates
    /// to — so models deserialized from JSON are covered before any SQL is
    /// generated.
    pub fn validate(&self) -> EngineResult<()> {
        self.validate_inner(false)
    }

    /// Validate a **calculation-item** expression tree for safe SQL rendering.
    ///
    /// Identical to [`Expression::validate`] except that
    /// [`Expression::SelectedMeasure`] (`SELECTEDMEASURE()`) is **allowed**:
    /// it is the placeholder a calculation item uses for the measure it is
    /// applied to, substituted away (via
    /// [`Expression::substitute_selected_measure`]) before any SQL is
    /// generated. Ordinary measures and calculated columns must use
    /// [`Expression::validate`], which rejects the placeholder.
    pub fn validate_calc_item(&self) -> EngineResult<()> {
        self.validate_inner(true)
    }

    /// Shared validation walk. `allow_selected_measure` permits
    /// [`Expression::SelectedMeasure`] (only true for calculation items).
    fn validate_inner(&self, allow_selected_measure: bool) -> EngineResult<()> {
        match self {
            // Leaves that are either quoted at render time (ColumnRef via
            // quote_ident_double, LiteralString via sql_quote_literal),
            // rendered as plain literals, or resolved/expanded against the
            // model before any SQL is generated (MeasureRef, IsInScope).
            Expression::ColumnRef(_)
            | Expression::LiteralFloat(_)
            | Expression::LiteralInt(_)
            | Expression::LiteralDate(_)
            | Expression::LiteralString(_)
            | Expression::LiteralBool(_)
            | Expression::Blank
            | Expression::MeasureRef(_)
            | Expression::IsInScope { .. }
            | Expression::IsFiltered { .. } => Ok(()),
            // SELECTEDMEASURE() is only legal inside a calculation item. For
            // ordinary measures / calculated columns it must never appear: it
            // would reach the renderer unsubstituted (an internal error).
            Expression::SelectedMeasure => {
                if allow_selected_measure {
                    Ok(())
                } else {
                    Err(EngineError::InvalidExpression(
                        "SELECTEDMEASURE() is only valid inside a calculation item; \
                         it cannot be used in a regular measure or calculated column"
                            .to_string(),
                    ))
                }
            }
            // Table references are rendered as raw (unquoted) qualifiers.
            Expression::TableRef(name) => validate_identifier(name, "table reference"),
            Expression::QualifiedColumnRef { table_or_var, .. } => {
                validate_identifier(table_or_var, "table reference")
            }
            Expression::BinaryOp { left, right, .. }
            | Expression::Comparison { left, right, .. }
            | Expression::And(left, right)
            | Expression::Or(left, right)
            | Expression::Xor(left, right) => {
                left.validate_inner(allow_selected_measure)?;
                right.validate_inner(allow_selected_measure)
            }
            Expression::Aggregate { operand, .. } => operand.validate_inner(allow_selected_measure),
            Expression::Not(inner) | Expression::IsBlank(inner) => {
                inner.validate_inner(allow_selected_measure)
            }
            Expression::Keep {
                expr,
                filters,
                variables,
                conditions,
                in_predicates,
            } => {
                expr.validate_inner(allow_selected_measure)?;
                for f in filters {
                    f.validate()?;
                }
                for v in variables {
                    validate_identifier(v, "table variable reference")?;
                }
                for c in conditions {
                    c.validate_inner(allow_selected_measure)?;
                }
                for p in in_predicates {
                    p.validate()?;
                }
                Ok(())
            }
            Expression::KeepIn { expr, predicates } => {
                expr.validate_inner(allow_selected_measure)?;
                for p in predicates {
                    p.validate()?;
                }
                Ok(())
            }
            // Context operations whose extra fields are pure lookup keys
            // (clear targets, traversal paths, context/relationship names)
            // that are resolved against the model, never rendered raw.
            Expression::Clear { expr, .. }
            | Expression::Reset { expr }
            | Expression::ClearInner { expr, .. }
            | Expression::ClearOuter { expr, .. }
            | Expression::ResetInner { expr }
            | Expression::ResetOuter { expr }
            | Expression::Traverse { expr, .. }
            | Expression::Using { expr, .. }
            | Expression::UseRelationship { expr, .. }
            | Expression::ClearExcept { expr, .. } => expr.validate_inner(allow_selected_measure),
            Expression::Block {
                bindings,
                query_scoped_bindings,
                result,
            } => {
                // Names are unique across the combined VAR + GVAR namespace —
                // both are referenced as bare identifiers, so a collision is
                // ambiguous. (QUERY bindings are also materialized and
                // registered under the binding name, appearing raw in FROM
                // clauses of the second-stage SQL, so the name must be a safe
                // identifier.)
                let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
                for (name, _) in query_scoped_bindings.iter().chain(bindings.iter()) {
                    validate_identifier(name, "variable binding")?;
                    if !seen.insert(name.to_ascii_lowercase()) {
                        return Err(EngineError::InvalidExpression(format!(
                            "variable '{name}' is declared more than once in the same \
                             VAR/GVAR block"
                        )));
                    }
                }

                // Validate each GVAR (query-scoped) binding.
                //
                // A GVAR is a single scalar evaluated once per query context; it
                // may reference only *earlier* GVARs and physical columns —
                // never a per-row VAR, and never a later-or-self GVAR. A bare
                // reference is detected precisely by substituting the forbidden
                // names with a unique `MeasureRef` sentinel (`substitute_vars`
                // rewrites only a bare `ColumnRef`, never a qualified
                // `table[col]`), then inspecting `measure_references`.
                const VAR_SENTINEL: &str = "\u{0}__gvar_refs_var__";
                const FWD_SENTINEL: &str = "\u{0}__gvar_refs_forward__";
                let mut declared_gvars: std::collections::HashSet<&str> =
                    std::collections::HashSet::new();
                for (gname, gbinding) in query_scoped_bindings {
                    gbinding.validate_inner(allow_selected_measure)?;

                    // Scalar-only: reject window/RANK/time-intelligence (checked
                    // recursively by has_window) and a QUERY node anywhere in the
                    // binding (contains_query — a top-level is_query() would miss
                    // `SUM(x) + QUERY(...)`).
                    if gbinding.contains_query() || gbinding.has_window() {
                        return Err(EngineError::InvalidExpression(format!(
                            "query-scoped variable (GVAR) '{gname}' must be a scalar; QUERY, \
                             window (WINDOW/OFFSET/INDEX/RANK) and time-intelligence \
                             expressions are not allowed in a GVAR binding"
                        )));
                    }

                    let mut env: std::collections::HashMap<String, Expression> =
                        std::collections::HashMap::new();
                    for (n, _) in bindings {
                        env.insert(n.clone(), Expression::MeasureRef(VAR_SENTINEL.to_string()));
                    }
                    for (n, _) in query_scoped_bindings {
                        if !declared_gvars.contains(n.as_str()) {
                            env.insert(n.clone(), Expression::MeasureRef(FWD_SENTINEL.to_string()));
                        }
                    }
                    let refs = gbinding.substitute_vars(&env);
                    let mrefs = refs.measure_references();
                    if mrefs.contains(&VAR_SENTINEL) {
                        return Err(EngineError::InvalidExpression(format!(
                            "query-scoped variable (GVAR) '{gname}' references a per-row VAR; a \
                             GVAR is evaluated once per query context and cannot depend on a VAR \
                             binding"
                        )));
                    }
                    if mrefs.contains(&FWD_SENTINEL) {
                        return Err(EngineError::InvalidExpression(format!(
                            "query-scoped variable (GVAR) '{gname}' references a GVAR declared \
                             later (or itself); a GVAR may reference only earlier GVARs"
                        )));
                    }
                    declared_gvars.insert(gname.as_str());
                }

                for (_, binding_expr) in bindings {
                    binding_expr.validate_inner(allow_selected_measure)?;
                }
                result.validate_inner(allow_selected_measure)
            }
            Expression::If {
                condition,
                then_expr,
                else_expr,
            } => {
                condition.validate_inner(allow_selected_measure)?;
                then_expr.validate_inner(allow_selected_measure)?;
                else_expr.validate_inner(allow_selected_measure)
            }
            Expression::Switch {
                expr,
                cases,
                default,
            } => {
                expr.validate_inner(allow_selected_measure)?;
                for (val, result) in cases {
                    val.validate_inner(allow_selected_measure)?;
                    result.validate_inner(allow_selected_measure)?;
                }
                if let Some(d) = default {
                    d.validate_inner(allow_selected_measure)?;
                }
                Ok(())
            }
            Expression::SafeDivide {
                numerator,
                denominator,
                alternate,
            } => {
                numerator.validate_inner(allow_selected_measure)?;
                denominator.validate_inner(allow_selected_measure)?;
                if let Some(alt) = alternate {
                    alt.validate_inner(allow_selected_measure)?;
                }
                Ok(())
            }
            Expression::Coalesce(exprs)
            | Expression::Greatest(exprs)
            | Expression::Least(exprs) => {
                for e in exprs {
                    e.validate_inner(allow_selected_measure)?;
                }
                Ok(())
            }
            Expression::ScalarFunc { args, .. } | Expression::TextFunc { args, .. } => {
                for arg in args {
                    arg.validate_inner(allow_selected_measure)?;
                }
                Ok(())
            }
            Expression::DateTimeFunc { function, args } => {
                match function {
                    DateTimeFunction::DateDiff => {
                        validate_interval_keyword(*function, args, 2, &DATEDIFF_INTERVALS)?
                    }
                    DateTimeFunction::DateAdd => {
                        validate_interval_keyword(*function, args, 2, &DATEADD_INTERVALS)?
                    }
                    DateTimeFunction::DateTrunc => {
                        validate_interval_keyword(*function, args, 1, &DATE_TRUNC_INTERVALS)?
                    }
                    DateTimeFunction::LastDay => {
                        validate_interval_keyword(*function, args, 1, &LAST_DAY_INTERVALS)?
                    }
                    // The remaining date/time functions take only expression
                    // arguments, which render through the normal (escaped)
                    // renderers.
                    DateTimeFunction::Year
                    | DateTimeFunction::Month
                    | DateTimeFunction::Day
                    | DateTimeFunction::Quarter
                    | DateTimeFunction::Date
                    | DateTimeFunction::Today
                    | DateTimeFunction::Now
                    | DateTimeFunction::EoMonth
                    | DateTimeFunction::DayOfWeek
                    | DateTimeFunction::DayOfYear
                    | DateTimeFunction::WeekNum
                    | DateTimeFunction::DayName
                    | DateTimeFunction::MonthName
                    | DateTimeFunction::MonthsBetween => {}
                }
                for arg in args {
                    arg.validate_inner(allow_selected_measure)?;
                }
                Ok(())
            }
            Expression::IfError { expr, alternate } => {
                expr.validate_inner(allow_selected_measure)?;
                alternate.validate_inner(allow_selected_measure)
            }
            Expression::Iterate { expression, .. } => {
                expression.validate_inner(allow_selected_measure)
            }
            Expression::Percentile {
                operand,
                percentile,
            } => {
                operand.validate_inner(allow_selected_measure)?;
                percentile.validate_inner(allow_selected_measure)
            }
            Expression::Query {
                aggregates,
                group_by,
            } => {
                // An aggregate-less QUERY (the `QUERY(DISTINCT ...)` form) is
                // only executable as a MATERIALIZED calculated table — inside
                // a measure/VAR binding the two-stage pipeline needs at least
                // one aggregate to materialize. The materialized path never
                // routes through measure validation, so rejecting here is
                // safe and precise.
                if aggregates.is_empty() {
                    return Err(EngineError::InvalidExpression(
                        "QUERY(DISTINCT ...) is only supported as a materialized calculated \
                         table (Dynamic = no); inside a measure, use an aggregate QUERY \
                         (e.g. COUNTROWS(t) AS n BY ...) instead"
                            .to_string(),
                    ));
                }
                // Aggregate output aliases are quoted at render time;
                // group-by tables are rendered as raw qualifiers and JOIN
                // targets.
                for (agg_expr, _alias) in aggregates {
                    agg_expr.validate_inner(allow_selected_measure)?;
                }
                for (table, _column) in group_by {
                    validate_identifier(table, "group-by table")?;
                }
                Ok(())
            }
            Expression::HasOneValue { column } => column.validate_inner(allow_selected_measure),
            Expression::SelectedValue { column, alternate } => {
                column.validate_inner(allow_selected_measure)?;
                if let Some(alt) = alternate {
                    alt.validate_inner(allow_selected_measure)?;
                }
                Ok(())
            }
            Expression::FirstValue { column, order_by } => {
                column.validate_inner(allow_selected_measure)?;
                order_by.validate_inner(allow_selected_measure)
            }
            // Frame boundaries, deltas, and positions are numeric; ORDER BY
            // and PARTITION BY columns are quoted at render time, but their
            // tables are rendered as raw qualifiers during materialization.
            Expression::Window {
                inner,
                function,
                order_by,
                partition_by,
                ..
            } => {
                // Only SUM/AVERAGE/MIN/MAX/COUNT can be windowed (the parser
                // enforces this too, but a measure AST can be deserialized
                // straight from a shared model file, bypassing the parser).
                // Rejecting an unsupported window aggregate here — rather than
                // letting it reach the renderer — prevents a running
                // DISTINCTCOUNT from silently rendering a plain COUNT.
                use crate::compute::aggregate::AggregateOp;
                if !matches!(
                    function,
                    AggregateOp::Sum
                        | AggregateOp::Average
                        | AggregateOp::Min
                        | AggregateOp::Max
                        | AggregateOp::Count
                ) {
                    return Err(EngineError::InvalidExpression(format!(
                        "aggregate {function:?} cannot be used as a window/running \
                         calculation; only SUM, AVERAGE, MIN, MAX, and COUNT can be windowed"
                    )));
                }
                inner.validate_inner(allow_selected_measure)?;
                for (table, _column) in order_by.iter().chain(partition_by.iter()) {
                    validate_identifier(table, "window table")?;
                }
                Ok(())
            }
            Expression::Offset {
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
                inner.validate_inner(allow_selected_measure)?;
                for (table, _column) in order_by.iter().chain(partition_by.iter()) {
                    validate_identifier(table, "window table")?;
                }
                Ok(())
            }
            Expression::RankWindow {
                order_by,
                partition_by,
                ..
            } => {
                for (table, _column) in order_by.iter().chain(partition_by.iter()) {
                    validate_identifier(table, "window table")?;
                }
                Ok(())
            }
            // Granularity is a closed enum and the offset is numeric; only
            // the inner expression carries renderable content.
            Expression::ToDate { expr, .. }
            | Expression::PeriodShift { expr, .. }
            | Expression::DatesInPeriod { expr, .. }
            | Expression::SemiAdditiveBalance { expr, .. } => {
                expr.validate_inner(allow_selected_measure)
            }
            Expression::InList { expr, values } => {
                expr.validate_inner(allow_selected_measure)?;
                for v in values {
                    v.validate_inner(allow_selected_measure)?;
                }
                Ok(())
            }
            Expression::NullIf { expr, value } => {
                expr.validate_inner(allow_selected_measure)?;
                value.validate_inner(allow_selected_measure)
            }
            Expression::CountIf { condition } => condition.validate_inner(allow_selected_measure),
            Expression::ListAgg { column, delimiter } => {
                column.validate_inner(allow_selected_measure)?;
                delimiter.validate_inner(allow_selected_measure)
            }
            Expression::MaxBy { value, sort_by } | Expression::MinBy { value, sort_by } => {
                value.validate_inner(allow_selected_measure)?;
                sort_by.validate_inner(allow_selected_measure)
            }
            // UDF call names are rendered unquoted into SQL — enforce the
            // strict call-name rule (model files are untrusted input).
            Expression::Call { name, args } => {
                validate_call_name(name)?;
                for arg in args {
                    arg.validate_inner(allow_selected_measure)?;
                }
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- validate() tests ---

    #[test]
    fn validate_accepts_benign_measure_expression() {
        let e = agg(
            AggregateOp::Sum,
            qualified_col("Sales", "price").multiply(qualified_col("Sales", "quantity")),
        );
        assert!(e.validate().is_ok());
    }

    #[test]
    fn validate_rejects_unsupported_window_aggregate() {
        // A running SUM window is fine.
        let ok = window_expr(
            agg(AggregateOp::Sum, qualified_col("Sales", "amount")),
            AggregateOp::Sum,
            vec![("Date".into(), "day".into())],
            vec![],
            None,
        );
        assert!(ok.validate().is_ok());

        // A running DISTINCTCOUNT must be rejected — it would otherwise render
        // as a plain COUNT (silently dropping DISTINCT). Likewise statistical
        // aggregates, which have no window form.
        for bad in [AggregateOp::DistinctCount, AggregateOp::Mode] {
            let e = window_expr(
                agg(bad, qualified_col("Sales", "customer_id")),
                bad,
                vec![("Date".into(), "day".into())],
                vec![],
                None,
            );
            assert!(
                matches!(e.validate(), Err(EngineError::InvalidExpression(_))),
                "window of {bad:?} must be rejected, got {:?}",
                e.validate()
            );
        }
    }

    #[test]
    fn validate_accepts_benign_date_trunc_interval() {
        let e = datetime_fn(
            DateTimeFunction::DateTrunc,
            vec![col("sold_at"), lit_str("MONTH")],
        );
        assert!(e.validate().is_ok());
        // The renderer lowercases the interval; case must not matter.
        let e = datetime_fn(
            DateTimeFunction::DateTrunc,
            vec![col("sold_at"), lit_str("month")],
        );
        assert!(e.validate().is_ok());
    }

    #[test]
    fn validate_rejects_hostile_date_trunc_interval() {
        let e = datetime_fn(
            DateTimeFunction::DateTrunc,
            vec![col("sold_at"), lit_str("MONTH'); DROP TABLE x; --")],
        );
        let err = e.validate().unwrap_err().to_string();
        assert!(err.contains("invalid interval"), "got: {err}");
    }

    #[test]
    fn validate_rejects_hostile_dateadd_interval() {
        let e = datetime_fn(
            DateTimeFunction::DateAdd,
            vec![col("d"), lit_int(1), lit_str("DAY' * 1); DROP TABLE x; --")],
        );
        assert!(e.validate().is_err());
    }

    #[test]
    fn validate_rejects_hostile_datediff_interval() {
        let e = datetime_fn(
            DateTimeFunction::DateDiff,
            vec![col("a"), col("b"), lit_str("FORTNIGHT")],
        );
        assert!(e.validate().is_err());
    }

    #[test]
    fn validate_rejects_hostile_last_day_interval() {
        // SECOND is valid for DATE_TRUNC but not LAST_DAY — per-function lists.
        let e = datetime_fn(DateTimeFunction::LastDay, vec![col("d"), lit_str("SECOND")]);
        assert!(e.validate().is_err());
    }

    #[test]
    fn validate_rejects_non_literal_interval_argument() {
        // A column ref in the interval slot would be rendered raw after
        // quote-stripping — must be rejected.
        let e = datetime_fn(
            DateTimeFunction::DateTrunc,
            vec![col("sold_at"), col("evil' , x); --")],
        );
        let err = e.validate().unwrap_err().to_string();
        assert!(err.contains("literal keyword"), "got: {err}");
    }

    #[test]
    fn validate_accepts_missing_interval_argument() {
        // Renderers fall back to a safe built-in default keyword.
        let e = datetime_fn(DateTimeFunction::DateTrunc, vec![col("sold_at")]);
        assert!(e.validate().is_ok());
    }

    #[test]
    fn validate_rejects_hostile_interval_nested_in_expression() {
        // The walk must recurse into nested expressions.
        let e = agg(
            AggregateOp::Max,
            if_expr(
                lit_bool(true),
                datetime_fn(
                    DateTimeFunction::DateTrunc,
                    vec![col("d"), lit_str("MONTH'); DROP TABLE x; --")],
                ),
                blank(),
            ),
        );
        assert!(e.validate().is_err());
    }

    #[test]
    fn validate_rejects_hostile_qualified_table_reference() {
        let e = agg(
            AggregateOp::Sum,
            qualified_col("sales\"; DROP TABLE x; --", "amount"),
        );
        assert!(e.validate().is_err());
    }

    #[test]
    fn validate_rejects_hostile_query_group_by_table() {
        let e = Expression::Query {
            aggregates: vec![(agg(AggregateOp::Sum, col("amount")), "total".into())],
            group_by: vec![("dim; DROP TABLE x; --".into(), "city".into())],
        };
        assert!(e.validate().is_err());
    }

    #[test]
    fn validate_rejects_hostile_window_order_by_table() {
        let e = window_expr(
            agg(AggregateOp::Sum, qualified_col("fact", "amount")),
            AggregateOp::Sum,
            vec![("dim'; DROP TABLE x; --".into(), "month".into())],
            vec![],
            None,
        );
        assert!(e.validate().is_err());
    }

    #[test]
    fn validate_rejects_hostile_keep_filter_table() {
        let e = keep(
            agg(AggregateOp::Sum, qualified_col("Sales", "amount")),
            vec![FilterPredicate::new(
                "dim\" ON 1=1; --",
                "year",
                ComparisonOp::Equal,
                "2014",
            )],
        );
        assert!(e.validate().is_err());
    }

    // --- Call (UDF) name validation tests ---

    #[test]
    fn validate_accepts_good_call_names() {
        for name in ["double", "pct_of", "_private", "Fn2", "MYFUNC"] {
            let e = call(name, vec![col("x")]);
            assert!(e.validate().is_ok(), "expected '{name}' to be accepted");
        }
        // Exactly 64 characters is still valid.
        let max_name = "a".repeat(64);
        assert!(call(&max_name, vec![]).validate().is_ok());
    }

    #[test]
    fn validate_rejects_call_name_with_quote() {
        let e = call("evil\"name", vec![col("x")]);
        let err = e.validate().unwrap_err();
        assert!(matches!(err, EngineError::InvalidIdentifier { .. }));
    }

    #[test]
    fn validate_rejects_call_name_with_space() {
        assert!(call("name with space", vec![]).validate().is_err());
    }

    #[test]
    fn validate_rejects_call_name_too_long() {
        let name = "a".repeat(65);
        assert!(call(&name, vec![]).validate().is_err());
    }

    #[test]
    fn validate_rejects_call_name_starting_with_digit() {
        assert!(call("1func", vec![]).validate().is_err());
    }

    #[test]
    fn validate_rejects_empty_call_name() {
        assert!(call("", vec![]).validate().is_err());
    }

    #[test]
    fn validate_rejects_hostile_call_name_injection() {
        let e = agg(
            AggregateOp::Sum,
            call("f(); DROP TABLE x; --", vec![col("amount")]),
        );
        assert!(e.validate().is_err());
    }

    #[test]
    fn validate_recurses_into_call_args() {
        // A hostile interval keyword nested inside a Call argument must be caught.
        let e = call(
            "myfunc",
            vec![datetime_fn(
                DateTimeFunction::DateTrunc,
                vec![col("d"), lit_str("MONTH'); DROP TABLE x; --")],
            )],
        );
        assert!(e.validate().is_err());
    }

    #[test]
    fn is_valid_call_name_rejects_non_ascii() {
        assert!(!is_valid_call_name("fünc"));
        assert!(!is_valid_call_name("月関数"));
    }

    #[test]
    fn validate_accepts_keep_filter_with_quote_in_value() {
        // Values are escaped at render time via sql_quote_literal —
        // a quote in the value is data, not an injection.
        let e = keep(
            agg(AggregateOp::Sum, qualified_col("Sales", "amount")),
            vec![FilterPredicate::new(
                "Products",
                "name",
                ComparisonOp::Equal,
                "O'Brien'); DROP TABLE x; --",
            )],
        );
        assert!(e.validate().is_ok());
    }
}
