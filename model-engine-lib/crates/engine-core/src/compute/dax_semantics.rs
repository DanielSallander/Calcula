//! DAX BLANK semantics for the arithmetic operators and the counting
//! aggregates — the ONE place every SQL renderer takes them from.
//!
//! SQL and DAX disagree about a missing value. In SQL, `NULL + 5` is `NULL`,
//! `COUNT(*)` over no rows is `0`, and `1 / 0` is an error (integer) or an
//! error on PostgreSQL. DAX (Power BI, Analysis Services, Power Pivot) answers
//! differently, and the engine's measures are DAX measures, so every renderer
//! of a measure (the local DataFusion SQL, the hoisted CROSS JOIN totals, the
//! multi-group star queries, the boundary evaluator, the PostgreSQL pushdown)
//! renders an arithmetic node and a counting aggregate through this module.
//!
//! # The arithmetic table
//!
//! Microsoft, *Data types in Power BI* — "Blanks, empty strings, and zero
//! values" (<https://learn.microsoft.com/power-bi/transform-model/desktop-data-types>):
//!
//! | Expression    | DAX      |
//! |---------------|----------|
//! | BLANK + BLANK | BLANK    |
//! | BLANK + 5     | 5        |
//! | BLANK * 5     | BLANK    |
//! | 5 / BLANK     | Infinity |
//! | 0 / BLANK     | NaN      |
//! | BLANK / BLANK | BLANK    |
//!
//! Completed by *The Definitive Guide to DAX*, 2nd ed., ch. 2 (Ferrari/Russo,
//! Microsoft Press) — `BLANK() / 3 = BLANK()`, `BLANK() - 10 = -10`, and Table
//! 2-3: `10 / 0 = Infinity`, `0 / 0 = NaN` ("Infinity and NaN are not errors
//! but special values in DAX") — and by SQLBI, *Handling BLANK in DAX*
//! (<https://www.sqlbi.com/articles/blank-handling-in-dax/>):
//! `BLANK() - BLANK()` is BLANK, `BLANK() / 4` is BLANK. So:
//!
//! - **`+` and `-`**: BLANK is read as 0, unless EVERY term is BLANK, which
//!   answers BLANK. A chain `a + b - c` is one decision: it is BLANK only when
//!   `a`, `b` and `c` all are ([`additive_terms`] flattens it).
//! - **`*`**: BLANK if either side is BLANK — SQL's own `NULL` propagation.
//! - **`/`**: BLANK if the numerator is BLANK; otherwise a BLANK denominator is
//!   read as 0, and division by zero is IEEE: `x / 0` is `+/-Infinity`, `0 / 0`
//!   is `NaN` — never an error. `/` always answers a REAL (the division table
//!   of the same Microsoft page: INTEGER / INTEGER is REAL), so `3 / 2` is
//!   `1.5`, never SQL's integer `1`. (`BLANK / 0` is not in any of the three
//!   sources; it follows from `BLANK / BLANK = BLANK` with the BLANK
//!   denominator read as 0.)
//! - **Unary minus** keeps BLANK (`-BLANK` is BLANK): the parser renders it
//!   as `-1 * x`, which the `*` rule covers ("the unary operator - (negative)
//!   doesn't change the data type of the operand", same Microsoft page).
//!
//! # The counting aggregates
//!
//! `COUNTROWS`: "When the table argument contains no rows, the function
//! returns BLANK." `COUNT`: "When the function finds no rows to count, it
//! returns a blank." `DISTINCTCOUNT`: "When the function finds no rows to
//! count, it returns a BLANK." (`COUNTBLANK`: "COUNTBLANK never returns 0.")
//! — the Microsoft DAX reference pages for each function. A DAX count is
//! therefore never 0: [`blank_zero_count`] renders `NULLIF(count, 0)`. And
//! "The DISTINCTCOUNT function counts the BLANK value" (DISTINCTCOUNTNOBLANK
//! does not): [`distinct_count_counting_blank`] adds the BLANK value SQL's
//! `COUNT(DISTINCT x)` skips.
//!
//! `DIVIDE(n, d [, alt])`: "If an alternate result is not passed in, and the
//! denominator is zero or BLANK, the function returns BLANK. When an alternate
//! result is passed in, it's returned instead of BLANK." (Microsoft, *DIVIDE
//! function vs divide operator*) — but a BLANK numerator answers BLANK even
//! then ([LIVE] the Excel data model's DAX engine: `DIVIDE(BLANK(), 0, 7)` is
//! BLANK) — see [`safe_divide_sql`].

use crate::compute::aggregate::AggregateOp;
use crate::compute::expression::{ArithmeticOp, Expression};

/// Is `op` one of the DAX counting aggregates, which answer BLANK — never 0 —
/// when there is nothing to count (`COUNT`, `DISTINCTCOUNT`, `COUNTROWS`)?
pub fn is_counting(op: &AggregateOp) -> bool {
    matches!(
        op,
        AggregateOp::Count
            | AggregateOp::DistinctCount
            | AggregateOp::DistinctCountNoBlank
            | AggregateOp::CountRows
    )
}

/// DAX's `DISTINCTCOUNT` over a rendered `COUNT(DISTINCT x)`: BLANK counts as
/// one more distinct value. "The DISTINCTCOUNT function counts the BLANK
/// value. To skip the BLANK value, use the DISTINCTCOUNTNOBLANK function."
/// (Microsoft, DISTINCTCOUNT function (DAX)). SQL's `COUNT(DISTINCT x)` skips
/// NULL, so the BLANK value is added back as
/// `MAX(CASE WHEN x IS NULL THEN 1 ELSE 0 END)` -- 1 when some counted row is
/// BLANK. Over no rows that `MAX` is `NULL`, so the sum stays BLANK, as a DAX
/// count of nothing is. [LIVE] Excel 16's data model (the Power BI DAX
/// engine) answers `DISTINCTCOUNT(T[amount])` over `10, 0, BLANK, 7` with 4,
/// over a single BLANK row with 1, and over no rows with BLANK.
///
/// `condition` is the conditional-aggregation (`KEEP` as `CASE WHEN`)
/// condition when `count_distinct_sql` is `COUNT(DISTINCT CASE WHEN c THEN x
/// END)`: a row outside `c` renders `NULL` there too, so only a row INSIDE
/// `c` whose value is BLANK adds the BLANK value. `operand_sql` is the bare
/// operand (`x`), never the `CASE WHEN` wrapper.
pub fn distinct_count_counting_blank(
    count_distinct_sql: &str,
    operand_sql: &str,
    condition: Option<&str>,
) -> String {
    // The KEEP condition is a separate CASE arm, never `c AND x IS NULL`:
    // DataFusion's parser reads `(c) AND (x) IS NULL` as `(c AND x) IS NULL`,
    // which flags a row whose condition is NULL (a BLANK category) as a BLANK
    // value (found by `a_pushed_keep_answers_what_the_filter_answers`).
    let blank_flag = format!("CASE WHEN ({operand_sql}) IS NULL THEN 1 ELSE 0 END");
    let blank_flag = match condition {
        Some(c) => format!("CASE WHEN {c} THEN {blank_flag} ELSE 0 END"),
        None => blank_flag,
    };
    format!("({count_distinct_sql} + MAX({blank_flag}))")
}

/// A measure's simple aggregate in the engine's own (DataFusion) SQL, with
/// every DAX rule the aggregate carries: `DISTINCTCOUNT` counts BLANK as a
/// value ([`distinct_count_counting_blank`]) and a count of nothing is BLANK
/// ([`blank_zero_count`]). The local executor's hand-built measure SELECTs
/// render through this, so they answer as the [`crate::compute::expression`]
/// renderer does.
pub fn measure_aggregate_sql(op: &AggregateOp, operand_sql: &str) -> String {
    let sql = op.render_sql(operand_sql);
    let sql = if matches!(op, AggregateOp::DistinctCount) {
        distinct_count_counting_blank(&sql, operand_sql, None)
    } else {
        sql
    };
    blank_zero_count(op, sql)
}

/// Wrap a rendered counting aggregate so a count of 0 answers BLANK:
/// `NULLIF(count, 0)`. Any other aggregate is returned unchanged (`SUM`,
/// `MIN`, `AVG`, ... over no rows are already `NULL` in SQL).
///
/// For measures only: a relational transform (Power Query's Group By) keeps
/// SQL's own `COUNT`, so it renders with [`AggregateOp::render_sql`] directly.
pub fn blank_zero_count(op: &AggregateOp, aggregate_sql: String) -> String {
    if is_counting(op) {
        format!("NULLIF({aggregate_sql}, 0)")
    } else {
        aggregate_sql
    }
}

/// [`blank_zero_count`] for a conditional (`CASE WHEN`) aggregate. A
/// conditional `COUNTROWS` already renders as `SUM(CASE WHEN c THEN 1 END)`,
/// which is `NULL` — never 0 — when no row matches, so it is left alone; the
/// conditional `COUNT` / `DISTINCTCOUNT` are `COUNT(...)` and are wrapped.
pub fn blank_zero_count_case_when(op: &AggregateOp, aggregate_sql: String) -> String {
    if matches!(op, AggregateOp::CountRows) {
        aggregate_sql
    } else {
        blank_zero_count(op, aggregate_sql)
    }
}

/// One term of a flattened `+` / `-` chain: `negated` is true when the term
/// is subtracted.
#[derive(Debug, Clone, Copy)]
pub struct AdditiveTerm<'a> {
    /// The term is subtracted (`- term`).
    pub negated: bool,
    /// The term's expression (never itself an `Add` / `Subtract` node).
    pub expr: &'a Expression,
}

/// Flatten a `+` / `-` chain into its signed terms, left to right, so the
/// whole chain is rendered as ONE BLANK decision (BLANK only when every term
/// is BLANK) and every term is rendered a bounded number of times. Returns
/// `None` when `expr` is not an `Add` / `Subtract` node.
///
/// `a - (b - c)` flattens to `[+a, -b, +c]`: the BLANK rule is the same for
/// every grouping (all-BLANK is BLANK, otherwise BLANK reads as 0), so the
/// flattening is exact.
pub fn additive_terms(expr: &Expression) -> Option<Vec<AdditiveTerm<'_>>> {
    fn walk<'a>(expr: &'a Expression, negated: bool, out: &mut Vec<AdditiveTerm<'a>>) {
        match expr {
            Expression::BinaryOp {
                left,
                op: op @ (ArithmeticOp::Add | ArithmeticOp::Subtract),
                right,
            } => {
                walk(left, negated, out);
                let right_negated = if matches!(op, ArithmeticOp::Subtract) {
                    !negated
                } else {
                    negated
                };
                walk(right, right_negated, out);
            }
            other => out.push(AdditiveTerm {
                negated,
                expr: other,
            }),
        }
    }
    match expr {
        Expression::BinaryOp {
            op: ArithmeticOp::Add | ArithmeticOp::Subtract,
            ..
        } => {
            let mut out = Vec::new();
            walk(expr, false, &mut out);
            Some(out)
        }
        _ => None,
    }
}

/// Can `expr` never be BLANK? True for a non-BLANK literal, an `ISBLANK` test
/// and a `COALESCE` with such an argument. (Conservative: an expression this
/// cannot prove non-BLANK is rendered with the BLANK guard.)
pub fn never_blank(expr: &Expression) -> bool {
    match expr {
        Expression::LiteralInt(_)
        | Expression::LiteralFloat(_)
        | Expression::LiteralBool(_)
        | Expression::LiteralDate(_)
        | Expression::LiteralString(_)
        | Expression::IsBlank(_) => true,
        // TODAY() and NOW() always answer a date.
        Expression::DateTimeFunc {
            function:
                crate::compute::expression::DateTimeFunction::Today
                | crate::compute::expression::DateTimeFunction::Now,
            ..
        } => true,
        Expression::Coalesce(items) => items.iter().any(never_blank),
        _ => false,
    }
}

/// The kind of value an expression answers, as far as its SHAPE tells --
/// what DAX converts a BLANK to when it is compared with such a value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValueClass {
    /// A number (any numeric type).
    Number,
    /// Text.
    Text,
    /// A boolean.
    Boolean,
    /// A date or date-time.
    Date,
}

impl ValueClass {
    /// The SQL of what a BLANK compares as against a value of this kind: "All
    /// comparison operators except == treat BLANK as equal to number 0, empty
    /// string "", DATE(1899, 12, 30), or FALSE" (Microsoft, *DAX operators*).
    /// [LIVE] Excel 16's data model: a BLANK date is `< DATE(2020, 1, 1)`,
    /// `= DATE(1899, 12, 30)` and `> DATE(1899, 12, 29)`, at measure level
    /// (`MAX(t[d])` of no date) and at row level (`FILTER(T, T[d] =
    /// DATE(1899, 12, 30))` keeps the BLANK-date rows).
    pub fn blank_sql(self) -> &'static str {
        match self {
            ValueClass::Number => "0",
            ValueClass::Text => "''",
            ValueClass::Boolean => "FALSE",
            ValueClass::Date => "CAST('1899-12-30' AS DATE)",
        }
    }
}

/// The [`ValueClass`] `expr` answers, from its shape alone: a literal, an
/// arithmetic node, a numeric aggregate (`SUM`, `COUNT`, `AVERAGE`, ...), a
/// comparison or logical test, a text or date function. `MIN` / `MAX` /
/// `SELECTEDVALUE` ... of a COLUMN, a bare column and `BLANK()` are `None`:
/// without the model's column types a comparison whose two sides are both
/// unknown keeps SQL's rule -- [`value_class_in`] takes them.
pub fn value_class(expr: &Expression) -> Option<ValueClass> {
    value_class_in(expr, &no_column_classes)
}

/// The model's column kinds, for [`value_class_in`]: `(table, column)` ->
/// the kind of the column's values (`table` is `None` for a bare reference).
pub type ColumnClasses<'a> = &'a dyn Fn(Option<&str>, &str) -> Option<ValueClass>;

/// A [`ColumnClasses`] that knows no column (the model-free renderers).
pub fn no_column_classes(_table: Option<&str>, _column: &str) -> Option<ValueClass> {
    None
}

impl ValueClass {
    /// The kind of a model column of type `data_type`.
    pub fn of_data_type(data_type: &crate::types::DataType) -> Self {
        use crate::types::DataType as T;
        match data_type {
            T::Int32 | T::Int64 | T::Float64 | T::Decimal(_, _) => ValueClass::Number,
            T::String => ValueClass::Text,
            T::Boolean => ValueClass::Boolean,
            T::Date | T::Timestamp => ValueClass::Date,
        }
    }
}

/// [`value_class`] with the model's column kinds: a column reference (and so
/// `MIN` / `MAX` / `SELECTEDVALUE` ... of a column) answers its column's
/// kind. So `MAX(t[a]) > MIN(t[b])` over numeric columns reads a BLANK side
/// as 0, as DAX does ([LIVE] Excel 16's data model: `CALCULATE(MAX(T[a]) >
/// MIN(T[b]), T[k] = 2)` with `a` BLANK and `b` 3 is FALSE; wave 1 verifier
/// of BUG-0762). An additive chain with a DATE term (and no subtracted one)
/// answers a date: `TODAY() - 30`, `MIN(t[d]) + 1` (DAX date arithmetic is in
/// days); it was classed a number, so the comparison read its date side's
/// BLANK as 0 and the plan failed.
pub fn value_class_in(expr: &Expression, columns: ColumnClasses) -> Option<ValueClass> {
    use crate::compute::expression::{DateTimeFunction as D, TextFunction as T};
    use ValueClass::{Boolean, Date, Number, Text};
    let value_class = |e: &Expression| value_class_in(e, columns);
    fn agree(classes: impl IntoIterator<Item = Option<ValueClass>>) -> Option<ValueClass> {
        let mut found = None;
        for class in classes.into_iter().flatten() {
            match found {
                None => found = Some(class),
                Some(c) if c != class => return None,
                Some(_) => {}
            }
        }
        found
    }
    match expr {
        Expression::LiteralInt(_) | Expression::LiteralFloat(_) => Some(Number),
        Expression::LiteralString(_) => Some(Text),
        Expression::LiteralBool(_) => Some(Boolean),
        Expression::LiteralDate(_) => Some(Date),
        Expression::Aggregate { operation, operand } => match operation {
            AggregateOp::Min | AggregateOp::Max | AggregateOp::AnyValue | AggregateOp::Mode => {
                value_class(operand)
            }
            _ => Some(Number),
        },
        Expression::ColumnRef(column) => columns(None, column),
        Expression::QualifiedColumnRef {
            table_or_var,
            column,
        } => columns(Some(table_or_var), column),
        Expression::BinaryOp {
            op: ArithmeticOp::Add | ArithmeticOp::Subtract,
            ..
        } => {
            let terms = additive_terms(expr).unwrap_or_default();
            let dated = terms
                .iter()
                .any(|t| !t.negated && value_class(t.expr) == Some(Date));
            let date_subtracted = terms
                .iter()
                .any(|t| t.negated && value_class(t.expr) == Some(Date));
            if dated && !date_subtracted {
                Some(Date)
            } else {
                Some(Number)
            }
        }
        Expression::BinaryOp { .. }
        | Expression::SafeDivide { .. }
        | Expression::CountIf { .. }
        | Expression::Percentile { .. }
        | Expression::ScalarFunc { .. } => Some(Number),
        Expression::Comparison { .. }
        | Expression::And(..)
        | Expression::Or(..)
        | Expression::Not(_)
        | Expression::Xor(..)
        | Expression::IsBlank(_)
        | Expression::InList { .. }
        | Expression::HasOneValue { .. } => Some(Boolean),
        Expression::ListAgg { .. } => Some(Text),
        Expression::TextFunc { function, .. } => match function {
            T::Exact | T::Contains | T::StartsWith | T::EndsWith => Some(Boolean),
            T::Find | T::Len | T::Search | T::Unicode | T::Value | T::PathLength => Some(Number),
            T::Split => None,
            _ => Some(Text),
        },
        Expression::DateTimeFunc { function, .. } => match function {
            D::Date | D::Today | D::Now | D::DateAdd | D::DateTrunc | D::LastDay | D::EoMonth => {
                Some(Date)
            }
            D::DayName | D::MonthName => Some(Text),
            _ => Some(Number),
        },
        Expression::If {
            then_expr,
            else_expr,
            ..
        } => agree([value_class(then_expr), value_class(else_expr)]),
        Expression::Switch { cases, default, .. } => agree(
            cases
                .iter()
                .map(|(_, result)| value_class(result))
                .chain(default.iter().map(|d| value_class(d))),
        ),
        Expression::Coalesce(items) | Expression::Greatest(items) | Expression::Least(items) => {
            agree(items.iter().map(value_class))
        }
        Expression::IfError { expr, alternate } => {
            agree([value_class(expr), value_class(alternate)])
        }
        Expression::NullIf { expr, .. } => value_class(expr),
        Expression::Iterate { expression, .. } => value_class(expression),
        Expression::Block {
            bindings, result, ..
        } => match result.as_ref() {
            Expression::ColumnRef(name) => match bindings.iter().rev().find(|(n, _)| n == name) {
                Some((_, bound)) => value_class(bound),
                None => None,
            },
            other => value_class(other),
        },
        Expression::Keep { expr, .. }
        | Expression::Clear { expr, .. }
        | Expression::Reset { expr, .. }
        | Expression::ClearInner { expr, .. }
        | Expression::ClearOuter { expr, .. }
        | Expression::ResetInner { expr }
        | Expression::ResetOuter { expr, .. }
        | Expression::Traverse { expr, .. }
        | Expression::Using { expr, .. }
        | Expression::UseRelationship { expr, .. }
        | Expression::KeepIn { expr, .. }
        | Expression::ClearExcept { expr, .. } => value_class(expr),
        _ => None,
    }
}

/// The value a BLANK compares as against `literal` -- [`ValueClass::blank_sql`]
/// of a number, text, boolean or date literal; `None` for anything else.
pub fn blank_compares_as(literal: &Expression) -> Option<&'static str> {
    if matches!(literal, Expression::Blank) || !never_blank(literal) {
        return None;
    }
    value_class(literal).map(ValueClass::blank_sql)
}

/// Wrap a rendered comparison operand so a BLANK compares as DAX converts it:
/// "BLANK or a blank value is converted to 0, "", or False, depending on the
/// data type of the other compared value" (Microsoft, *Data types in Power
/// BI*) -- [`ValueClass::blank_sql`] of the OTHER side's [`value_class`], or
/// of this side's own when the other's is unknown (a valid DAX comparison
/// compares like with like). Unchanged when this side can never be BLANK, or
/// neither side's kind is known.
///
/// Every comparison renderer takes it: the plain and conditional renderers
/// (and so the KEEP-as-CASE-WHEN pushdown), the pipeline's compound-measure
/// route and the boundary evaluator.
///
/// - Against a LITERAL (the open-ledger rounds C and D), at measure level
///   (`IF(COUNTROWS(t) = 0, ...)` keeps answering as when the count was 0)
///   and at row level -- [LIVE] Excel 16's data model (the Power BI DAX
///   engine), over amounts `10, 0, BLANK, 7` and names `x, y, BLANK, x`:
///   `FILTER(T, T[amount] < 5)` keeps 2 rows (0 and BLANK), `= 0` 2, `>= 0`
///   4, `> 0` 2, `<> 10` 3, `<= 0` 2, `< -1` none; `T[name] = ""` 1, `<
///   "x"` 1, `<> "x"` 2, `> ""` 3, `>= ""` 4.
/// - Between two AGGREGATES or expressions (BUG-0762, ledger programme 2):
///   `SUM(t[a]) > SUM(t[b])` with one sum BLANK answered NULL. [LIVE] over
///   `a`, `b` of `(10, 5), (BLANK, 3), (7, BLANK), (BLANK, BLANK)` per row:
///   BLANK `>` 3 is FALSE and `<` 3 TRUE; 7 `>` BLANK is TRUE; BLANK `=`
///   BLANK TRUE, `<>` FALSE, `>=` TRUE, `<` FALSE; BLANK `<` BLANK + 1 TRUE;
///   `NOT(BLANK > 3)` TRUE; `SUM(a) = BLANK()` TRUE over BLANK and FALSE over
///   10; a BLANK `MAX(t[name])` is `<` "a" and `=` another BLANK text; a
///   BLANK `MAX(t[d])` is `< DATE(2020, 1, 1)`.
///
/// Two sides of unknown kind (`MAX(t[x]) > MIN(t[y])`, `t[a] > t[b]` in a row
/// context), which DAX also converts ([LIVE] `FILTER(T, T[a] > T[b])` keeps
/// the 7-vs-BLANK row), need the model's column types:
/// [`comparison_operand_in`], which the local pipeline's measure SQL takes
/// (wave 3); a model-free renderer keeps SQL's rule for them.
///
/// NOT covered: a KEEP's own column-vs-column CONDITION (rendered model-free
/// by the pipeline's condition SQL); `IN`, which is strict in DAX (`BLANK IN
/// {0}` is FALSE) and answers NULL here as a bare boolean; and a KEEP's simple
/// `table[column] op literal` predicate
/// ([`crate::compute::expression::FilterPredicate`]) -- BLANK stays strict
/// there. Row-level security shares that predicate type but is converted on
/// its own path (`engine_query::security_filter`) and never reaches this
/// module (owner decision BUG-0759, 2026-11-06: RLS stays strict on BLANK).
pub fn comparison_operand(sql: String, this: &Expression, other: &Expression) -> String {
    comparison_operand_in(sql, this, other, &no_column_classes)
}

/// [`comparison_operand`] with the model's column kinds ([`value_class_in`]):
/// the renderers that hold the model (the local pipeline's measure SQL) take
/// this, so a side whose kind only its column shows (`MAX(t[a])`,
/// `SELECTEDVALUE(t[x])`, a bare `t[a]` in a row context) reads its BLANK as
/// the zero of that kind too.
pub fn comparison_operand_in(
    sql: String,
    this: &Expression,
    other: &Expression,
    columns: ColumnClasses,
) -> String {
    if never_blank(this) {
        return sql;
    }
    match value_class_in(other, columns).or_else(|| value_class_in(this, columns)) {
        Some(class) => format!("COALESCE({sql}, {})", class.blank_sql()),
        None => sql,
    }
}

/// Render DAX `SWITCH(subject, value1, result1, ..., [else])` over rendered
/// parts: `(value, value_may_be_blank, result)` per case.
///
/// SWITCH matches with STRICT equality -- BLANK matches only BLANK, never 0
/// or "": [LIVE] Excel 16's data model answers `SWITCH(<BLANK sum>, 0,
/// "zero", "other")` with "other", `SWITCH(<BLANK sum>, <BLANK sum>, "match",
/// "no")` with "match" and `SWITCH(<BLANK sum>, <a sum of 0>, "match", "no")`
/// with "no". (The open-ledger round C had read BLANK as 0 here, as in `=`.)
/// A case value that can never be BLANK (a literal) renders the plain `CASE
/// subject WHEN value`, where a NULL subject matches nothing; when some case
/// value can be BLANK the CASE is searched with `IS NOT DISTINCT FROM`.
pub fn switch_sql(subject: &str, cases: &[(String, bool, String)], default: Option<&str>) -> String {
    let mut sql = if cases.iter().any(|(_, may_be_blank, _)| *may_be_blank) {
        let mut s = String::from("CASE");
        for (value, _, result) in cases {
            s.push_str(&format!(
                " WHEN ({subject}) IS NOT DISTINCT FROM ({value}) THEN {result}"
            ));
        }
        s
    } else {
        let mut s = format!("CASE {subject}");
        for (value, _, result) in cases {
            s.push_str(&format!(" WHEN {value} THEN {result}"));
        }
        s
    };
    if let Some(d) = default {
        sql.push_str(&format!(" ELSE {d}"));
    }
    sql.push_str(" END");
    sql
}

/// A rendered term of an additive chain (see [`additive_terms`]).
#[derive(Debug, Clone)]
pub struct RenderedTerm {
    /// The term is subtracted.
    pub negated: bool,
    /// The term's rendered SQL.
    pub sql: String,
    /// The term can never be BLANK ([`never_blank`]).
    pub never_blank: bool,
    /// The term answers a date ([`ValueClass::Date`]): the chain is DAX date
    /// arithmetic in days ([`additive_sql`]).
    pub is_date: bool,
}

/// Render a flattened `+` / `-` chain with DAX BLANK semantics: a BLANK term
/// reads as 0, and the chain is BLANK only when every term is BLANK.
///
/// `SUM(x) + 1` renders `(COALESCE(SUM(x), 0) + 1)` (a literal term is never
/// BLANK, so neither is the chain); `SUM(x) + SUM(y)` renders
/// `CASE WHEN SUM(x) IS NULL AND SUM(y) IS NULL THEN NULL ELSE
/// (COALESCE(SUM(x), 0) + COALESCE(SUM(y), 0)) END`.
pub fn additive_sql(terms: &[RenderedTerm]) -> String {
    // DAX date arithmetic: ONE added date term and number terms answer the
    // date that many days on (`TODAY() - 30`, `MIN(t[d]) + 1`). A BLANK date
    // reads as DATE(1899, 12, 30) ("BLANK ... DATE(1899, 12, 30)", Microsoft,
    // *DAX operators*), a BLANK number as 0, and the chain is BLANK only when
    // every term is. Rendered as `date + CAST('<n> days' AS INTERVAL)`:
    // DataFusion plans neither `date + n` nor `INTERVAL * <integer>`, and the
    // old `COALESCE(<date>, 0) - 30` failed to plan (whole days: a fraction
    // of a day is truncated).
    let dates: Vec<&RenderedTerm> = terms.iter().filter(|t| t.is_date).collect();
    if let [date] = dates.as_slice() {
        if !date.negated && terms.len() > 1 {
            let date_sql = if date.never_blank {
                date.sql.clone()
            } else {
                format!("COALESCE({}, {})", date.sql, ValueClass::Date.blank_sql())
            };
            let mut days = String::new();
            for term in terms.iter().filter(|t| !t.is_date) {
                let operand = if term.never_blank {
                    term.sql.clone()
                } else {
                    format!("COALESCE({}, 0)", term.sql)
                };
                let sign = if term.negated { "-" } else { "+" };
                days.push_str(&format!(" {sign} {operand}"));
            }
            let body = format!(
                "({date_sql} + CAST(CAST(CAST((0{days}) AS BIGINT) AS VARCHAR) || ' days' AS INTERVAL))"
            );
            if terms.iter().any(|t| t.never_blank) {
                return body;
            }
            let all_blank = terms
                .iter()
                .map(|t| format!("{} IS NULL", t.sql))
                .collect::<Vec<_>>()
                .join(" AND ");
            return format!("CASE WHEN {all_blank} THEN NULL ELSE {body} END");
        }
    }
    let mut body = String::from("(");
    for (i, term) in terms.iter().enumerate() {
        let operand = if term.never_blank {
            term.sql.clone()
        } else {
            format!("COALESCE({}, 0)", term.sql)
        };
        match (i, term.negated) {
            (0, false) => body.push_str(&operand),
            (0, true) => body.push_str(&format!("0 - {operand}")),
            (_, false) => body.push_str(&format!(" + {operand}")),
            (_, true) => body.push_str(&format!(" - {operand}")),
        }
    }
    body.push(')');
    if terms.iter().any(|t| t.never_blank) {
        return body;
    }
    let all_blank = terms
        .iter()
        .map(|t| format!("{} IS NULL", t.sql))
        .collect::<Vec<_>>()
        .join(" AND ");
    format!("CASE WHEN {all_blank} THEN NULL ELSE {body} END")
}

/// How a dialect spells IEEE division (`x / 0` is `+/-Infinity`, `0 / 0` is
/// `NaN`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DivideStyle {
    /// The engine's own DataFusion SQL: floating-point division already
    /// follows IEEE 754 (arrow's `div` kernel errors on division by zero for
    /// integers only, and both operands are cast to `DOUBLE`).
    Ieee,
    /// A source dialect whose floating-point division by zero is an ERROR
    /// (PostgreSQL's `float8div`): the zero denominator is answered explicitly
    /// as `SIGN(n) * Infinity` (`SIGN(0) * Infinity` is `NaN`), in the given
    /// floating-point cast target (`DOUBLE PRECISION`).
    Guarded {
        /// The floating-point cast target.
        cast: &'static str,
    },
}

/// Render the DAX `/` operator over two rendered operands.
///
/// BLANK numerator → BLANK (SQL `NULL` propagation); a BLANK denominator is
/// read as 0; division by zero is IEEE, never an error; the result is always
/// floating point.
pub fn divide_sql(numerator: &str, denominator: &str, style: DivideStyle) -> String {
    match style {
        DivideStyle::Ieee => {
            format!("(CAST({numerator} AS DOUBLE) / CAST(COALESCE({denominator}, 0) AS DOUBLE))")
        }
        DivideStyle::Guarded { cast } => format!(
            "CASE WHEN COALESCE({denominator}, 0) = 0 THEN CAST(SIGN({numerator}) AS {cast}) * \
             CAST('Infinity' AS {cast}) ELSE CAST({numerator} AS {cast}) / {denominator} END"
        ),
    }
}

/// Render a non-additive arithmetic node (`*` or `/`) over two rendered
/// operands. (`+` / `-` go through [`additive_terms`] + [`additive_sql`]; if
/// one is passed here anyway it is rendered as a two-term chain.)
pub fn binary_sql(
    left: &str,
    op: ArithmeticOp,
    right: &str,
    left_never_blank: bool,
    right_never_blank: bool,
    style: DivideStyle,
) -> String {
    match op {
        ArithmeticOp::Multiply => format!("({left} * {right})"),
        ArithmeticOp::Divide => divide_sql(left, right, style),
        ArithmeticOp::Add | ArithmeticOp::Subtract => additive_sql(&[
            RenderedTerm {
                negated: false,
                sql: left.to_string(),
                never_blank: left_never_blank,
                is_date: false,
            },
            RenderedTerm {
                negated: matches!(op, ArithmeticOp::Subtract),
                sql: right.to_string(),
                never_blank: right_never_blank,
                is_date: false,
            },
        ]),
    }
}

/// Render a `BinaryOp` node with DAX semantics through a synchronous operand
/// renderer: an additive chain is flattened and rendered once
/// ([`additive_sql`]); `*` / `/` render their two operands
/// ([`binary_sql`]). Anything that is not a `BinaryOp` is handed straight to
/// `render`.
///
/// # Errors
///
/// Whatever `render` returns for an operand.
pub fn render_binary<E>(
    expr: &Expression,
    style: DivideStyle,
    render: &mut dyn FnMut(&Expression) -> Result<String, E>,
) -> Result<String, E> {
    render_binary_in(expr, style, &no_column_classes, render)
}

/// [`render_binary`] with the model's column kinds, so a date COLUMN term
/// (`MIN(t[d]) + 1`) is date arithmetic too ([`value_class_in`]).
///
/// # Errors
///
/// Whatever `render` returns for an operand.
pub fn render_binary_in<E>(
    expr: &Expression,
    style: DivideStyle,
    columns: ColumnClasses,
    render: &mut dyn FnMut(&Expression) -> Result<String, E>,
) -> Result<String, E> {
    if let Some(terms) = additive_terms(expr) {
        let mut rendered = Vec::with_capacity(terms.len());
        for term in terms {
            rendered.push(RenderedTerm {
                negated: term.negated,
                sql: render(term.expr)?,
                never_blank: never_blank(term.expr),
                is_date: value_class_in(term.expr, columns) == Some(ValueClass::Date),
            });
        }
        return Ok(additive_sql(&rendered));
    }
    match expr {
        Expression::BinaryOp { left, op, right } => {
            let l = render(left)?;
            let r = render(right)?;
            Ok(binary_sql(
                &l,
                *op,
                &r,
                never_blank(left),
                never_blank(right),
                style,
            ))
        }
        other => render(other),
    }
}

/// Render DAX `DIVIDE(n, d [, alt])`: a BLANK numerator answers BLANK; a zero
/// OR BLANK denominator answers the alternate (BLANK when none is given,
/// rendered by the caller as `NULL`); otherwise floating-point division.
///
/// The BLANK numerator is decided FIRST, before the denominator: DAX answers
/// `DIVIDE(BLANK(), 0, 7)` and `DIVIDE(BLANK(), BLANK(), 7)` with BLANK, not
/// with the alternate, while `DIVIDE(0, 0, 7)` and `DIVIDE(0, BLANK(), 7)`
/// answer 7 ([LIVE] Excel 16's data model, the same VertiPaq/DAX engine as
/// Power BI, probed 2026-11-05 over CUBEVALUE; `CALCULATE(DIVIDE(SUM(t[x]),
/// 0, 7), <a row whose x is BLANK>)` is BLANK too). Microsoft's page states
/// only the denominator half ("If an alternate result is not passed in, and
/// the denominator is zero or BLANK, the function returns BLANK"). The
/// constant folder (`fold_const_scalar`, the `bi-engine` facade) answers the
/// same. Without an alternate the guard is not rendered: `NULL / d` is
/// already `NULL`, and the zero-denominator arm already answers `NULL`.
pub fn safe_divide_sql(numerator: &str, denominator: &str, alternate: &str, cast: &str) -> String {
    let blank_numerator = if alternate.trim().eq_ignore_ascii_case("NULL") {
        String::new()
    } else {
        format!("WHEN {numerator} IS NULL THEN NULL ")
    };
    format!(
        "CASE {blank_numerator}WHEN COALESCE({denominator}, 0) = 0 THEN {alternate} ELSE \
         (CAST({numerator} AS {cast}) / {denominator}) END"
    )
}

/// Evaluate one DAX arithmetic operator over two constant numbers, where
/// `None` is BLANK — the same table the SQL renderers implement, for the
/// constant folders (query-scoped `GVAR` bindings, format-string folding).
pub fn arithmetic_f64(left: Option<f64>, op: ArithmeticOp, right: Option<f64>) -> Option<f64> {
    match op {
        ArithmeticOp::Add | ArithmeticOp::Subtract => {
            if left.is_none() && right.is_none() {
                return None;
            }
            let (a, b) = (left.unwrap_or(0.0), right.unwrap_or(0.0));
            Some(if matches!(op, ArithmeticOp::Add) {
                a + b
            } else {
                a - b
            })
        }
        ArithmeticOp::Multiply => Some(left? * right?),
        ArithmeticOp::Divide => Some(left? / right.unwrap_or(0.0)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute::expression::{agg, col, lit_int};

    #[test]
    fn the_microsoft_blank_table_holds_for_constants() {
        // BLANK + BLANK = BLANK; BLANK + 5 = 5; BLANK * 5 = BLANK;
        // 5 / BLANK = Infinity; 0 / BLANK = NaN; BLANK / BLANK = BLANK.
        assert_eq!(arithmetic_f64(None, ArithmeticOp::Add, None), None);
        assert_eq!(
            arithmetic_f64(None, ArithmeticOp::Add, Some(5.0)),
            Some(5.0)
        );
        assert_eq!(
            arithmetic_f64(None, ArithmeticOp::Multiply, Some(5.0)),
            None
        );
        assert_eq!(
            arithmetic_f64(Some(5.0), ArithmeticOp::Divide, None),
            Some(f64::INFINITY)
        );
        assert!(arithmetic_f64(Some(0.0), ArithmeticOp::Divide, None)
            .unwrap()
            .is_nan());
        assert_eq!(arithmetic_f64(None, ArithmeticOp::Divide, None), None);
        // BLANK - 10 = -10; BLANK - BLANK = BLANK; BLANK / 3 = BLANK;
        // 10 / 0 = Infinity; -10 / 0 = -Infinity.
        assert_eq!(
            arithmetic_f64(None, ArithmeticOp::Subtract, Some(10.0)),
            Some(-10.0)
        );
        assert_eq!(arithmetic_f64(None, ArithmeticOp::Subtract, None), None);
        assert_eq!(arithmetic_f64(None, ArithmeticOp::Divide, Some(3.0)), None);
        assert_eq!(
            arithmetic_f64(Some(-10.0), ArithmeticOp::Divide, Some(0.0)),
            Some(f64::NEG_INFINITY)
        );
    }

    #[test]
    fn an_additive_chain_is_one_blank_decision() {
        let e = agg(AggregateOp::Sum, col("a"))
            .subtract(agg(AggregateOp::Sum, col("b")).subtract(agg(AggregateOp::Sum, col("c"))));
        let terms = additive_terms(&e).unwrap();
        assert_eq!(
            terms.iter().map(|t| t.negated).collect::<Vec<_>>(),
            vec![false, true, false],
            "a - (b - c) is a - b + c"
        );
        let sql = render_binary::<()>(&e, DivideStyle::Ieee, &mut |x| {
            Ok(x.to_sql_string().unwrap())
        })
        .unwrap();
        assert_eq!(
            sql,
            "CASE WHEN SUM(\"a\") IS NULL AND SUM(\"b\") IS NULL AND SUM(\"c\") IS NULL THEN NULL \
             ELSE (COALESCE(SUM(\"a\"), 0) - COALESCE(SUM(\"b\"), 0) + COALESCE(SUM(\"c\"), 0)) END"
        );
    }

    #[test]
    fn a_literal_term_makes_the_chain_never_blank() {
        let e = agg(AggregateOp::Sum, col("a")).add(lit_int(1));
        let sql = render_binary::<()>(&e, DivideStyle::Ieee, &mut |x| {
            Ok(x.to_sql_string().unwrap())
        })
        .unwrap();
        assert_eq!(sql, "(COALESCE(SUM(\"a\"), 0) + 1)");
    }

    #[test]
    fn division_is_ieee_and_real_in_each_style() {
        assert_eq!(
            divide_sql("n", "d", DivideStyle::Ieee),
            "(CAST(n AS DOUBLE) / CAST(COALESCE(d, 0) AS DOUBLE))"
        );
        assert_eq!(
            divide_sql(
                "n",
                "d",
                DivideStyle::Guarded {
                    cast: "DOUBLE PRECISION"
                }
            ),
            "CASE WHEN COALESCE(d, 0) = 0 THEN CAST(SIGN(n) AS DOUBLE PRECISION) * \
             CAST('Infinity' AS DOUBLE PRECISION) ELSE CAST(n AS DOUBLE PRECISION) / d END"
        );
    }

    #[test]
    fn a_row_level_comparison_against_a_literal_reads_blank_as_dax_does() {
        // NEW-dax-row-comparison: BLANK compares as 0 / "" / FALSE against a
        // literal of that type at ROW level too ([LIVE] FILTER(T, T[amount] <
        // 5) keeps the BLANK row). A comparison of two columns, or against a
        // date, keeps SQL's rule; a literal operand is never wrapped.
        use crate::compute::expression::{compare, lit_bool, lit_str, ComparisonOp};
        let render = |e: &Expression| e.to_sql_string().unwrap();
        assert_eq!(
            render(&compare(col("amount"), ComparisonOp::LessThan, lit_int(5))),
            "(COALESCE(\"amount\", 0) < 5)"
        );
        assert_eq!(
            render(&compare(col("name"), ComparisonOp::LessThan, lit_str("x"))),
            "(COALESCE(\"name\", '') < 'x')"
        );
        assert_eq!(
            render(&compare(col("flag"), ComparisonOp::Equal, lit_bool(false))),
            "(COALESCE(\"flag\", FALSE) = FALSE)"
        );
        assert_eq!(
            render(&compare(col("a"), ComparisonOp::LessThan, col("b"))),
            "(\"a\" < \"b\")"
        );
        // [LIVE] a BLANK date is `< DATE(2020, 1, 1)` and `= DATE(1899, 12,
        // 30)` (BUG-0762; it kept SQL's rule until then).
        assert_eq!(
            render(&compare(
                col("d"),
                ComparisonOp::LessThan,
                Expression::LiteralDate(19_000)
            )),
            "(COALESCE(\"d\", CAST('1899-12-30' AS DATE)) < CAST(19000 AS DATE))"
        );
        // A table transformation keeps SQL's comparison.
        assert_eq!(
            compare(col("amount"), ComparisonOp::LessThan, lit_int(5))
                .to_relational_sql_string()
                .unwrap(),
            "(\"amount\" < 5)"
        );
    }

    #[test]
    fn a_comparison_of_two_aggregates_reads_a_blank_side_as_the_others_zero() {
        // BUG-0762: `SUM(a) > SUM(b)` with one sum BLANK answered SQL's NULL.
        // [LIVE] DAX: BLANK > 3 is FALSE, BLANK = BLANK is TRUE.
        use crate::compute::expression::{compare, lit_str, qualified_col, ComparisonOp};
        let render = |e: &Expression| e.to_sql_string().unwrap();
        let sum = |c: &str| agg(AggregateOp::Sum, col(c));
        assert_eq!(
            render(&compare(sum("a"), ComparisonOp::GreaterThan, sum("b"))),
            "(COALESCE(SUM(\"a\"), 0) > COALESCE(SUM(\"b\"), 0))"
        );
        // Against an arithmetic expression, and `x = BLANK()` (TRUE when x is
        // BLANK or 0, as in DAX).
        assert_eq!(
            render(&compare(sum("a"), ComparisonOp::LessThan, sum("b").add(lit_int(1)))),
            "(COALESCE(SUM(\"a\"), 0) < COALESCE((COALESCE(SUM(\"b\"), 0) + 1), 0))"
        );
        assert_eq!(
            render(&compare(sum("a"), ComparisonOp::Equal, Expression::Blank)),
            "(COALESCE(SUM(\"a\"), 0) = COALESCE(NULL, 0))"
        );
        // A count is a number; MIN / MAX of a column take the other side's
        // kind; text and dates take theirs.
        let count = agg(AggregateOp::CountRows, Expression::TableRef("t".into()));
        let max_name = agg(AggregateOp::Max, qualified_col("t", "name"));
        assert_eq!(
            render(&compare(count, ComparisonOp::GreaterThan, max_name.clone())),
            "(COALESCE(NULLIF(COUNT(*), 0), 0) > COALESCE(MAX(\"name\"), 0))"
        );
        assert_eq!(
            render(&compare(max_name.clone(), ComparisonOp::LessThan, lit_str("a"))),
            "(COALESCE(MAX(\"name\"), '') < 'a')"
        );
        let concat = Expression::TextFunc {
            function: crate::compute::expression::TextFunction::Upper,
            args: vec![qualified_col("t", "other")],
        };
        assert_eq!(
            render(&compare(max_name.clone(), ComparisonOp::Equal, concat)),
            "(COALESCE(MAX(\"name\"), '') = COALESCE(UPPER(\"other\"), ''))"
        );
        // Two sides of unknown kind keep SQL's rule (no model types here).
        let min_other = agg(AggregateOp::Min, qualified_col("t", "other"));
        assert_eq!(
            render(&compare(max_name, ComparisonOp::GreaterThan, min_other)),
            "(MAX(\"name\") > MIN(\"other\"))"
        );
        assert_eq!(value_class(&sum("a")), Some(ValueClass::Number));
        assert_eq!(
            value_class(&agg(AggregateOp::Max, col("a").multiply(lit_int(2)))),
            Some(ValueClass::Number)
        );
        assert_eq!(value_class(&agg(AggregateOp::Max, col("d"))), None);
        assert_eq!(value_class(&Expression::LiteralDate(1)), Some(ValueClass::Date));
        assert_eq!(value_class(&Expression::Blank), None);
    }

    #[test]
    fn switch_matches_blank_only_with_blank() {
        // [LIVE] SWITCH(<BLANK>, 0, "zero", "other") is "other";
        // SWITCH(<BLANK>, <BLANK>, "match", "no") is "match".
        let literal_cases = vec![("0".to_string(), false, "'zero'".to_string())];
        assert_eq!(
            switch_sql("SUM(x)", &literal_cases, Some("'other'")),
            "CASE SUM(x) WHEN 0 THEN 'zero' ELSE 'other' END"
        );
        let blankable = vec![
            ("0".to_string(), false, "'zero'".to_string()),
            ("SUM(y)".to_string(), true, "'match'".to_string()),
        ];
        assert_eq!(
            switch_sql("SUM(x)", &blankable, None),
            "CASE WHEN (SUM(x)) IS NOT DISTINCT FROM (0) THEN 'zero' \
             WHEN (SUM(x)) IS NOT DISTINCT FROM (SUM(y)) THEN 'match' END"
        );
        let e = Expression::Switch {
            expr: Box::new(agg(AggregateOp::CountRows, Expression::TableRef("t".into()))),
            cases: vec![(lit_int(0), lit_int(10))],
            default: Some(Box::new(lit_int(20))),
        };
        assert_eq!(
            e.to_sql_string().unwrap(),
            "CASE NULLIF(COUNT(*), 0) WHEN 0 THEN 10 ELSE 20 END",
            "a BLANK count does not match 0"
        );
    }

    #[test]
    fn only_the_counting_aggregates_are_blanked_at_zero() {
        assert_eq!(
            blank_zero_count(&AggregateOp::CountRows, "COUNT(*)".into()),
            "NULLIF(COUNT(*), 0)"
        );
        assert_eq!(
            blank_zero_count(&AggregateOp::Sum, "SUM(x)".into()),
            "SUM(x)"
        );
        assert_eq!(
            blank_zero_count_case_when(
                &AggregateOp::CountRows,
                "SUM(CASE WHEN c THEN 1 END)".into()
            ),
            "SUM(CASE WHEN c THEN 1 END)"
        );
        assert_eq!(
            blank_zero_count_case_when(&AggregateOp::Count, "COUNT(CASE WHEN c THEN x END)".into()),
            "NULLIF(COUNT(CASE WHEN c THEN x END), 0)"
        );
    }

    /// With the model's column kinds, two sides only their columns type read
    /// a BLANK as DAX does, and date arithmetic is in days (wave 3, lane
    /// engfix: `MAX(t[a]) > MIN(t[b])` answered NULL; `TODAY() - 30` was
    /// classed a number and its date side COALESCEd to 0, which fails to plan).
    #[test]
    fn column_kinds_type_a_comparison_and_date_arithmetic_is_in_days() {
        use crate::compute::expression::{compare, qualified_col, ComparisonOp, DateTimeFunction};
        let classes = |_t: Option<&str>, c: &str| match c {
            "a" | "b" => Some(ValueClass::Number),
            "d" => Some(ValueClass::Date),
            _ => None,
        };
        let max_a = agg(AggregateOp::Max, qualified_col("t", "a"));
        let min_b = agg(AggregateOp::Min, qualified_col("t", "b"));
        let gt = compare(max_a, ComparisonOp::GreaterThan, min_b);
        assert_eq!(gt.to_sql_string().unwrap(), "(MAX(\"a\") > MIN(\"b\"))");
        assert_eq!(
            gt.to_sql_string_with_classes(&classes).unwrap(),
            "(COALESCE(MAX(\"a\"), 0) > COALESCE(MIN(\"b\"), 0))"
        );
        let today = Expression::DateTimeFunc {
            function: DateTimeFunction::Today,
            args: vec![],
        };
        let month_ago = Expression::BinaryOp {
            left: Box::new(today),
            op: ArithmeticOp::Subtract,
            right: Box::new(lit_int(30)),
        };
        assert_eq!(value_class(&month_ago), Some(ValueClass::Date));
        let min_d = agg(AggregateOp::Min, qualified_col("t", "d"));
        let day_after = Expression::BinaryOp {
            left: Box::new(min_d.clone()),
            op: ArithmeticOp::Add,
            right: Box::new(lit_int(1)),
        };
        assert_eq!(value_class(&day_after), Some(ValueClass::Number), "no model kinds");
        assert_eq!(value_class_in(&day_after, &classes), Some(ValueClass::Date));
        let max_d = agg(AggregateOp::Max, qualified_col("t", "d"));
        let cmp = compare(max_d, ComparisonOp::GreaterThan, month_ago);
        assert_eq!(
            cmp.to_sql_string().unwrap(),
            "(COALESCE(MAX(\"d\"), CAST('1899-12-30' AS DATE)) > COALESCE((CURRENT_DATE + CAST(CAST(CAST((0 - 30) AS BIGINT) AS VARCHAR) || ' days' AS INTERVAL)), CAST('1899-12-30' AS DATE)))"
        );
        assert_eq!(
            day_after.to_sql_string_with_classes(&classes).unwrap(),
            "(COALESCE(MIN(\"d\"), CAST('1899-12-30' AS DATE)) + CAST(CAST(CAST((0 + 1) AS BIGINT) AS VARCHAR) || ' days' AS INTERVAL))"
        );
    }
}
