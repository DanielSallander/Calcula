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
        match self {
            // Leaves that are either quoted at render time (ColumnRef via
            // quote_ident_double, LiteralString via sql_quote_literal),
            // rendered as plain literals, or resolved/expanded against the
            // model before any SQL is generated (MeasureRef, IsInScope).
            Expression::ColumnRef(_)
            | Expression::LiteralFloat(_)
            | Expression::LiteralInt(_)
            | Expression::LiteralString(_)
            | Expression::LiteralBool(_)
            | Expression::Blank
            | Expression::MeasureRef(_)
            | Expression::IsInScope { .. } => Ok(()),
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
                left.validate()?;
                right.validate()
            }
            Expression::Aggregate { operand, .. } => operand.validate(),
            Expression::Not(inner) | Expression::IsBlank(inner) => inner.validate(),
            Expression::Keep {
                expr,
                filters,
                variables,
                conditions,
                in_predicates,
            } => {
                expr.validate()?;
                for f in filters {
                    f.validate()?;
                }
                for v in variables {
                    validate_identifier(v, "table variable reference")?;
                }
                for c in conditions {
                    c.validate()?;
                }
                for p in in_predicates {
                    p.validate()?;
                }
                Ok(())
            }
            Expression::KeepIn { expr, predicates } => {
                expr.validate()?;
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
            | Expression::ClearExcept { expr, .. } => expr.validate(),
            Expression::Block { bindings, result } => {
                for (name, binding_expr) in bindings {
                    // QUERY bindings are materialized and registered under
                    // the binding name, which then appears raw in FROM
                    // clauses of the second-stage SQL.
                    validate_identifier(name, "variable binding")?;
                    binding_expr.validate()?;
                }
                result.validate()
            }
            Expression::If {
                condition,
                then_expr,
                else_expr,
            } => {
                condition.validate()?;
                then_expr.validate()?;
                else_expr.validate()
            }
            Expression::Switch {
                expr,
                cases,
                default,
            } => {
                expr.validate()?;
                for (val, result) in cases {
                    val.validate()?;
                    result.validate()?;
                }
                if let Some(d) = default {
                    d.validate()?;
                }
                Ok(())
            }
            Expression::SafeDivide {
                numerator,
                denominator,
                alternate,
            } => {
                numerator.validate()?;
                denominator.validate()?;
                if let Some(alt) = alternate {
                    alt.validate()?;
                }
                Ok(())
            }
            Expression::Coalesce(exprs)
            | Expression::Greatest(exprs)
            | Expression::Least(exprs) => {
                for e in exprs {
                    e.validate()?;
                }
                Ok(())
            }
            Expression::ScalarFunc { args, .. } | Expression::TextFunc { args, .. } => {
                for arg in args {
                    arg.validate()?;
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
                    arg.validate()?;
                }
                Ok(())
            }
            Expression::IfError { expr, alternate } => {
                expr.validate()?;
                alternate.validate()
            }
            Expression::Iterate { expression, .. } => expression.validate(),
            Expression::Percentile {
                operand,
                percentile,
            } => {
                operand.validate()?;
                percentile.validate()
            }
            Expression::Query {
                aggregates,
                group_by,
            } => {
                // Aggregate output aliases are quoted at render time;
                // group-by tables are rendered as raw qualifiers and JOIN
                // targets.
                for (agg_expr, _alias) in aggregates {
                    agg_expr.validate()?;
                }
                for (table, _column) in group_by {
                    validate_identifier(table, "group-by table")?;
                }
                Ok(())
            }
            Expression::HasOneValue { column } => column.validate(),
            Expression::SelectedValue { column, alternate } => {
                column.validate()?;
                if let Some(alt) = alternate {
                    alt.validate()?;
                }
                Ok(())
            }
            Expression::FirstValue { column, order_by } => {
                column.validate()?;
                order_by.validate()
            }
            // Frame boundaries, deltas, and positions are numeric; ORDER BY
            // and PARTITION BY columns are quoted at render time, but their
            // tables are rendered as raw qualifiers during materialization.
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
                inner.validate()?;
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
            Expression::ToDate { expr, .. } | Expression::PeriodShift { expr, .. } => {
                expr.validate()
            }
            Expression::InList { expr, values } => {
                expr.validate()?;
                for v in values {
                    v.validate()?;
                }
                Ok(())
            }
            Expression::NullIf { expr, value } => {
                expr.validate()?;
                value.validate()
            }
            Expression::CountIf { condition } => condition.validate(),
            Expression::ListAgg { column, delimiter } => {
                column.validate()?;
                delimiter.validate()
            }
            Expression::MaxBy { value, sort_by } | Expression::MinBy { value, sort_by } => {
                value.validate()?;
                sort_by.validate()
            }
            // UDF call names are rendered unquoted into SQL — enforce the
            // strict call-name rule (model files are untrusted input).
            Expression::Call { name, args } => {
                validate_call_name(name)?;
                for arg in args {
                    arg.validate()?;
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
