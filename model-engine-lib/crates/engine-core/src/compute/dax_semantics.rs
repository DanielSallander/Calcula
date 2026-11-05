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

/// Can `expr` never be BLANK? True for a non-BLANK literal. (Conservative: an
/// expression this cannot prove non-BLANK is rendered with the BLANK guard.)
pub fn never_blank(expr: &Expression) -> bool {
    matches!(
        expr,
        Expression::LiteralInt(_)
            | Expression::LiteralFloat(_)
            | Expression::LiteralBool(_)
            | Expression::LiteralDate(_)
            | Expression::LiteralString(_)
    )
}

/// The value a BLANK compares as against `literal`: "BLANK or a blank value is
/// converted to 0, "", or False, depending on the data type of the other
/// compared value" (Microsoft, *Data types in Power BI*, Comparison
/// operators). `None` when `literal` is not a number, text or boolean literal
/// (a date, an expression): the comparison is rendered as SQL's.
pub fn blank_compares_as(literal: &Expression) -> Option<&'static str> {
    match literal {
        Expression::LiteralInt(_) | Expression::LiteralFloat(_) => Some("0"),
        Expression::LiteralString(_) => Some("''"),
        Expression::LiteralBool(_) => Some("FALSE"),
        _ => None,
    }
}

/// Wrap a rendered comparison operand so a BLANK compares as DAX's
/// conversion for the other side's literal ([`blank_compares_as`]):
/// `COALESCE(COUNTROWS(t), 0) = 0` is TRUE over an empty table, as
/// `COUNTROWS(t) = 0` is in DAX. Unchanged when the other side is not such a
/// literal, or this side can never be BLANK.
///
/// Applied to a measure-level operand (a count or sum of nothing is BLANK,
/// and `IF(COUNTROWS(t) = 0, ...)` must keep answering as it did when the
/// count was 0) AND, since the open-ledger round D, to a ROW-level one
/// (`t[amount] < 5` in a calculated column, an iterator's row expression, a
/// KEEP's expression condition): DAX keeps a BLANK row there too. [LIVE]
/// Excel 16's data model (the Power BI DAX engine), over amounts `10, 0,
/// BLANK, 7` and names `x, y, BLANK, x`: `FILTER(T, T[amount] < 5)` keeps 2
/// rows (0 and BLANK), `= 0` 2, `>= 0` 4, `> 0` 2, `<> 10` 3, `<= 0` 2,
/// `< -1` none; `T[name] = ""` 1, `< "x"` 1, `<> "x"` 2, `> ""` 3, `>= ""`
/// 4 -- every one the COALESCE rule's answer. `IN {0}` keeps only the 0 row
/// (strict), which `Expression::InList` already renders.
///
/// NOT covered: a KEEP's simple `table[column] op literal` predicate
/// ([`crate::compute::expression::FilterPredicate`]), which stores its
/// literal as text with its type lost, renders in two dozen places, and is
/// also the row-level-security predicate type -- it keeps SQL's comparison.
pub fn comparison_operand(sql: String, this: &Expression, other: &Expression) -> String {
    if never_blank(this) {
        return sql;
    }
    match blank_compares_as(other) {
        Some(zero) => format!("COALESCE({sql}, {zero})"),
        None => sql,
    }
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
}

/// Render a flattened `+` / `-` chain with DAX BLANK semantics: a BLANK term
/// reads as 0, and the chain is BLANK only when every term is BLANK.
///
/// `SUM(x) + 1` renders `(COALESCE(SUM(x), 0) + 1)` (a literal term is never
/// BLANK, so neither is the chain); `SUM(x) + SUM(y)` renders
/// `CASE WHEN SUM(x) IS NULL AND SUM(y) IS NULL THEN NULL ELSE
/// (COALESCE(SUM(x), 0) + COALESCE(SUM(y), 0)) END`.
pub fn additive_sql(terms: &[RenderedTerm]) -> String {
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
            },
            RenderedTerm {
                negated: matches!(op, ArithmeticOp::Subtract),
                sql: right.to_string(),
                never_blank: right_never_blank,
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
    if let Some(terms) = additive_terms(expr) {
        let mut rendered = Vec::with_capacity(terms.len());
        for term in terms {
            rendered.push(RenderedTerm {
                negated: term.negated,
                sql: render(term.expr)?,
                never_blank: never_blank(term.expr),
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
        assert_eq!(
            render(&compare(
                col("d"),
                ComparisonOp::LessThan,
                Expression::LiteralDate(19_000)
            )),
            "(\"d\" < CAST(19000 AS DATE))"
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
}
