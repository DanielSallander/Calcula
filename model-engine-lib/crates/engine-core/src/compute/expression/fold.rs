//! Constant folding for scalar expressions that reference no model data.
//!
//! The dynamic-format-string machinery evaluates a scalar expression once per
//! query. When that expression references model data (columns, measures,
//! aggregates) it must run as a real query — but after calc-group placeholder
//! substitution the common case is a pure literal tree (e.g.
//! `CONCATENATE("#,0", " K")`), which has no fact table to plan against.
//! [`const_fold_scalar`] evaluates that case directly, with SQL-consistent
//! semantics (BLANK behaves like SQL `NULL`: it propagates through
//! concatenation and arithmetic, and comparisons against it are false).

use super::*;
use crate::compute::expression::text::TextFunction;

/// Outcome of attempting to constant-fold a scalar expression.
#[derive(Debug, Clone, PartialEq)]
pub enum ConstFold {
    /// The expression is constant; this is its value.
    Value(FoldValue),
    /// The expression references model data (columns, measures, aggregates,
    /// context ops, …) — evaluate it as a query instead.
    NotConstant,
    /// The expression is constant but uses a construct the folder does not
    /// support (named for the error message).
    Unsupported(String),
}

/// A folded scalar value. `Blank` is SQL `NULL`.
#[derive(Debug, Clone, PartialEq)]
pub enum FoldValue {
    /// A string value.
    Str(String),
    /// An integer value.
    Int(i64),
    /// A floating-point value.
    Float(f64),
    /// A boolean value.
    Bool(bool),
    /// NULL / `BLANK()`.
    Blank,
}

impl FoldValue {
    fn as_f64(&self) -> Option<f64> {
        match self {
            FoldValue::Int(v) => Some(*v as f64),
            FoldValue::Float(v) => Some(*v),
            _ => None,
        }
    }

    /// Coerce to a string for text functions: numbers/booleans render
    /// naturally; `None` for Blank (the caller decides propagation).
    fn to_text(&self) -> Option<String> {
        match self {
            FoldValue::Str(s) => Some(s.clone()),
            FoldValue::Int(v) => Some(v.to_string()),
            FoldValue::Float(v) => Some(v.to_string()),
            FoldValue::Bool(b) => Some(if *b { "TRUE" } else { "FALSE" }.to_string()),
            FoldValue::Blank => None,
        }
    }

    /// SQL-style truthiness: booleans are themselves, BLANK is false,
    /// anything else is not a condition.
    fn truthy(&self) -> Option<bool> {
        match self {
            FoldValue::Bool(b) => Some(*b),
            FoldValue::Blank => Some(false),
            _ => None,
        }
    }

    /// Equality with numeric cross-type promotion; BLANK equals only BLANK
    /// (used by SWITCH case matching, where DAX matches blanks).
    fn switch_eq(&self, other: &FoldValue) -> bool {
        match (self, other) {
            (FoldValue::Blank, FoldValue::Blank) => true,
            (FoldValue::Str(a), FoldValue::Str(b)) => a == b,
            (FoldValue::Bool(a), FoldValue::Bool(b)) => a == b,
            _ => match (self.as_f64(), other.as_f64()) {
                (Some(a), Some(b)) => a == b,
                _ => false,
            },
        }
    }
}

/// Attempt to evaluate `expr` as a constant scalar.
///
/// Returns [`ConstFold::NotConstant`] when the tree references model data in
/// any form — the caller should evaluate it as a query. Returns
/// [`ConstFold::Unsupported`] when the tree is constant-only but contains a
/// construct outside the folding set (literals; `IF`/`SWITCH`/`COALESCE`/
/// `IFERROR`/`NULLIF`; comparisons; `AND`/`OR`/`NOT`/`XOR`/`ISBLANK`;
/// arithmetic and `DIVIDE`; and the text functions `CONCATENATE`,
/// `COMBINEVALUES`, `UPPER`, `LOWER`, `TRIM`, `LEFT`, `RIGHT`, `MID`, `LEN`,
/// `REPLACE`, `SUBSTITUTE`, `REPT`, `REVERSE`, `CONTAINS`, `STARTSWITH`,
/// `ENDSWITH`, `EXACT`, `FIND`, `SEARCH`).
pub fn const_fold_scalar(expr: &Expression) -> ConstFold {
    if references_model_data(expr) {
        return ConstFold::NotConstant;
    }
    match fold(expr) {
        Ok(v) => ConstFold::Value(v),
        Err(what) => ConstFold::Unsupported(what),
    }
}

/// Does this tree reference model data in any form that requires a query
/// (columns, measures, aggregates, context ops, windows, table constructs)?
///
/// Conservative on purpose: anything that is not a plainly foldable scalar
/// shape counts as data-referencing only if it names data; unfoldable
/// constant constructs (e.g. a literal-only `VAR` block) are reported as
/// [`ConstFold::Unsupported`] by the fold walk instead.
fn references_model_data(expr: &Expression) -> bool {
    if !expr.column_references().is_empty()
        || !expr.measure_references().is_empty()
        || expr.has_aggregate()
        || expr.has_context_ops()
    {
        return true;
    }
    // Structural nodes the reference walkers cannot see through as "data":
    // UDF calls, ranking windows, scope checks. All force the query path.
    fn structural(e: &Expression) -> bool {
        matches!(
            e,
            Expression::Call { .. }
                | Expression::RankWindow { .. }
                | Expression::IsInScope { .. }
                | Expression::IsFiltered { .. }
                | Expression::HasOneValue { .. }
                | Expression::SelectedValue { .. }
                | Expression::Query { .. }
        ) || child_expressions(e).into_iter().any(structural)
    }
    structural(expr)
}

/// Recursive folder. `Err(description)` = constant but unsupported.
fn fold(expr: &Expression) -> Result<FoldValue, String> {
    match expr {
        Expression::LiteralString(s) => Ok(FoldValue::Str(s.clone())),
        Expression::LiteralInt(v) => Ok(FoldValue::Int(*v)),
        Expression::LiteralFloat(v) => Ok(FoldValue::Float(*v)),
        Expression::LiteralBool(b) => Ok(FoldValue::Bool(*b)),
        Expression::Blank => Ok(FoldValue::Blank),
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => {
            let cond = fold(condition)?;
            let takes = cond
                .truthy()
                .ok_or_else(|| "a non-boolean IF condition".to_string())?;
            fold(if takes { then_expr } else { else_expr })
        }
        Expression::Switch {
            expr,
            cases,
            default,
        } => {
            let subject = fold(expr)?;
            for (case, result) in cases {
                if subject.switch_eq(&fold(case)?) {
                    return fold(result);
                }
            }
            match default {
                Some(d) => fold(d),
                None => Ok(FoldValue::Blank),
            }
        }
        Expression::Coalesce(exprs) => {
            for e in exprs {
                let v = fold(e)?;
                if v != FoldValue::Blank {
                    return Ok(v);
                }
            }
            Ok(FoldValue::Blank)
        }
        // IFERROR renders as COALESCE — same fold.
        Expression::IfError { expr, alternate } => {
            let v = fold(expr)?;
            if v == FoldValue::Blank {
                fold(alternate)
            } else {
                Ok(v)
            }
        }
        Expression::NullIf { expr, value } => {
            let a = fold(expr)?;
            let b = fold(value)?;
            if a != FoldValue::Blank && a.switch_eq(&b) {
                Ok(FoldValue::Blank)
            } else {
                Ok(a)
            }
        }
        Expression::IsBlank(inner) => Ok(FoldValue::Bool(fold(inner)? == FoldValue::Blank)),
        Expression::Not(inner) => {
            let v = fold(inner)?
                .truthy()
                .ok_or_else(|| "a non-boolean NOT operand".to_string())?;
            Ok(FoldValue::Bool(!v))
        }
        Expression::And(l, r) | Expression::Or(l, r) | Expression::Xor(l, r) => {
            let a = fold(l)?
                .truthy()
                .ok_or_else(|| "a non-boolean logical operand".to_string())?;
            let b = fold(r)?
                .truthy()
                .ok_or_else(|| "a non-boolean logical operand".to_string())?;
            Ok(FoldValue::Bool(match expr {
                Expression::And(..) => a && b,
                Expression::Or(..) => a || b,
                _ => a ^ b,
            }))
        }
        Expression::Comparison { left, op, right } => {
            let l = fold(left)?;
            let r = fold(right)?;
            // SQL semantics: a comparison involving NULL is not true.
            if l == FoldValue::Blank || r == FoldValue::Blank {
                return Ok(FoldValue::Bool(false));
            }
            let ordering = match (&l, &r) {
                (FoldValue::Str(a), FoldValue::Str(b)) => a.cmp(b),
                (FoldValue::Bool(a), FoldValue::Bool(b)) => a.cmp(b),
                _ => match (l.as_f64(), r.as_f64()) {
                    (Some(a), Some(b)) => a
                        .partial_cmp(&b)
                        .ok_or_else(|| "an incomparable number (NaN)".to_string())?,
                    _ => return Err("a mixed-type comparison".to_string()),
                },
            };
            Ok(FoldValue::Bool(match op {
                ComparisonOp::Equal => ordering.is_eq(),
                ComparisonOp::NotEqual => !ordering.is_eq(),
                ComparisonOp::GreaterThan => ordering.is_gt(),
                ComparisonOp::GreaterThanOrEqual => ordering.is_ge(),
                ComparisonOp::LessThan => ordering.is_lt(),
                ComparisonOp::LessThanOrEqual => ordering.is_le(),
            }))
        }
        Expression::BinaryOp { left, op, right } => {
            let l = fold(left)?;
            let r = fold(right)?;
            // NULL propagates through arithmetic (SQL semantics).
            if l == FoldValue::Blank || r == FoldValue::Blank {
                return Ok(FoldValue::Blank);
            }
            let (a, b) = match (l.as_f64(), r.as_f64()) {
                (Some(a), Some(b)) => (a, b),
                _ => return Err("non-numeric arithmetic".to_string()),
            };
            // Integer-preserving where exact; division always floats, and
            // division by zero folds to BLANK (the format-string caller
            // treats BLANK as "fall back").
            let float = |v: f64| -> FoldValue {
                match (&l, &r) {
                    (FoldValue::Int(_), FoldValue::Int(_)) if v.fract() == 0.0 => {
                        FoldValue::Int(v as i64)
                    }
                    _ => FoldValue::Float(v),
                }
            };
            Ok(match op {
                ArithmeticOp::Add => float(a + b),
                ArithmeticOp::Subtract => float(a - b),
                ArithmeticOp::Multiply => float(a * b),
                ArithmeticOp::Divide => {
                    if b == 0.0 {
                        FoldValue::Blank
                    } else {
                        FoldValue::Float(a / b)
                    }
                }
            })
        }
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => {
            let n = fold(numerator)?;
            let d = fold(denominator)?;
            let div_by_zero = d == FoldValue::Blank || d.as_f64() == Some(0.0);
            if div_by_zero {
                return match alternate {
                    Some(alt) => fold(alt),
                    None => Ok(FoldValue::Blank),
                };
            }
            match (n.as_f64(), d.as_f64()) {
                (Some(a), Some(b)) => Ok(FoldValue::Float(a / b)),
                _ => {
                    if n == FoldValue::Blank {
                        Ok(FoldValue::Blank)
                    } else {
                        Err("non-numeric DIVIDE".to_string())
                    }
                }
            }
        }
        Expression::Greatest(args) | Expression::Least(args) => {
            let mut acc: Option<f64> = None;
            for a in args {
                let v = fold(a)?;
                if v == FoldValue::Blank {
                    return Ok(FoldValue::Blank);
                }
                let x = v
                    .as_f64()
                    .ok_or_else(|| "a non-numeric GREATEST/LEAST argument".to_string())?;
                acc = Some(match acc {
                    None => x,
                    Some(prev) if matches!(expr, Expression::Greatest(_)) => prev.max(x),
                    Some(prev) => prev.min(x),
                });
            }
            Ok(acc.map(FoldValue::Float).unwrap_or(FoldValue::Blank))
        }
        Expression::TextFunc { function, args } => fold_text(*function, args),
        other => Err(format!("the {} construct", construct_name(other))),
    }
}

/// Fold the supported text functions.
fn fold_text(function: TextFunction, args: &[Expression]) -> Result<FoldValue, String> {
    let vals: Vec<FoldValue> = args.iter().map(fold).collect::<Result<_, _>>()?;
    // Text of the n-th argument; None = BLANK (NULL-propagating callers
    // return early on it).
    let text = |i: usize| -> Result<Option<String>, String> {
        Ok(vals
            .get(i)
            .ok_or_else(|| "a missing text-function argument".to_string())?
            .to_text())
    };
    let int = |i: usize| -> Result<Option<i64>, String> {
        match vals.get(i) {
            Some(FoldValue::Int(v)) => Ok(Some(*v)),
            Some(FoldValue::Float(v)) if v.fract() == 0.0 => Ok(Some(*v as i64)),
            Some(FoldValue::Blank) => Ok(None),
            _ => Err("a non-integer text-function argument".to_string()),
        }
    };
    // Character-based (not byte-based) helpers, mirroring SQL semantics.
    let chars = |s: &str| s.chars().collect::<Vec<_>>();
    match function {
        TextFunction::Concatenate => {
            let mut out = String::new();
            for v in &vals {
                match v.to_text() {
                    Some(s) => out.push_str(&s),
                    // SQL: 'a' || NULL is NULL.
                    None => return Ok(FoldValue::Blank),
                }
            }
            Ok(FoldValue::Str(out))
        }
        TextFunction::CombineValues => {
            // COMBINEVALUES(delimiter, v1, v2, ...) — blanks join as empty
            // strings (DAX semantics for this function).
            let Some(delim) = text(0)? else {
                return Ok(FoldValue::Blank);
            };
            let parts: Vec<String> = vals[1..]
                .iter()
                .map(|v| v.to_text().unwrap_or_default())
                .collect();
            Ok(FoldValue::Str(parts.join(&delim)))
        }
        TextFunction::Upper => Ok(match text(0)? {
            Some(s) => FoldValue::Str(s.to_uppercase()),
            None => FoldValue::Blank,
        }),
        TextFunction::Lower => Ok(match text(0)? {
            Some(s) => FoldValue::Str(s.to_lowercase()),
            None => FoldValue::Blank,
        }),
        TextFunction::Trim => Ok(match text(0)? {
            Some(s) => FoldValue::Str(s.trim().to_string()),
            None => FoldValue::Blank,
        }),
        TextFunction::Reverse => Ok(match text(0)? {
            Some(s) => FoldValue::Str(s.chars().rev().collect()),
            None => FoldValue::Blank,
        }),
        TextFunction::Len => Ok(match text(0)? {
            Some(s) => FoldValue::Int(s.chars().count() as i64),
            None => FoldValue::Blank,
        }),
        TextFunction::Left | TextFunction::Right => {
            let Some(s) = text(0)? else {
                return Ok(FoldValue::Blank);
            };
            let n = match args.len() {
                0 | 1 => 1,
                _ => match int(1)? {
                    Some(n) => n.max(0),
                    None => return Ok(FoldValue::Blank),
                },
            } as usize;
            let cs = chars(&s);
            let taken: String = if function == TextFunction::Left {
                cs.iter().take(n).collect()
            } else {
                cs.iter().skip(cs.len().saturating_sub(n)).collect()
            };
            Ok(FoldValue::Str(taken))
        }
        TextFunction::Mid => {
            let (Some(s), Some(start), Some(len)) = (text(0)?, int(1)?, int(2)?) else {
                return Ok(FoldValue::Blank);
            };
            let cs = chars(&s);
            let from = (start.max(1) - 1) as usize;
            let taken: String = cs.iter().skip(from).take(len.max(0) as usize).collect();
            Ok(FoldValue::Str(taken))
        }
        TextFunction::Rept => {
            let (Some(s), Some(n)) = (text(0)?, int(1)?) else {
                return Ok(FoldValue::Blank);
            };
            Ok(FoldValue::Str(s.repeat(n.max(0) as usize)))
        }
        TextFunction::Replace => {
            // DAX REPLACE(old_text, start_num, num_chars, new_text).
            let (Some(s), Some(start), Some(n), Some(new)) = (text(0)?, int(1)?, int(2)?, text(3)?)
            else {
                return Ok(FoldValue::Blank);
            };
            let cs = chars(&s);
            let from = (start.max(1) - 1) as usize;
            let to = (from + n.max(0) as usize).min(cs.len());
            let mut out: String = cs.iter().take(from).collect();
            out.push_str(&new);
            out.extend(cs.iter().skip(to));
            Ok(FoldValue::Str(out))
        }
        TextFunction::Substitute => {
            let (Some(s), Some(old), Some(new)) = (text(0)?, text(1)?, text(2)?) else {
                return Ok(FoldValue::Blank);
            };
            Ok(FoldValue::Str(if old.is_empty() {
                s
            } else {
                s.replace(&old, &new)
            }))
        }
        TextFunction::Contains => Ok(match (text(0)?, text(1)?) {
            (Some(s), Some(sub)) => FoldValue::Bool(s.contains(&sub)),
            _ => FoldValue::Blank,
        }),
        TextFunction::StartsWith => Ok(match (text(0)?, text(1)?) {
            (Some(s), Some(sub)) => FoldValue::Bool(s.starts_with(&sub)),
            _ => FoldValue::Blank,
        }),
        TextFunction::EndsWith => Ok(match (text(0)?, text(1)?) {
            (Some(s), Some(sub)) => FoldValue::Bool(s.ends_with(&sub)),
            _ => FoldValue::Blank,
        }),
        TextFunction::Exact => Ok(match (text(0)?, text(1)?) {
            (Some(a), Some(b)) => FoldValue::Bool(a == b),
            _ => FoldValue::Blank,
        }),
        TextFunction::Find | TextFunction::Search => {
            // FIND(substring, text) — 1-based; 0 when absent. SEARCH is the
            // case-insensitive form.
            let (Some(sub), Some(s)) = (text(0)?, text(1)?) else {
                return Ok(FoldValue::Blank);
            };
            let (hay, needle) = if function == TextFunction::Search {
                (s.to_lowercase(), sub.to_lowercase())
            } else {
                (s.clone(), sub.clone())
            };
            let pos = hay
                .find(&needle)
                .map(|byte| hay[..byte].chars().count() as i64 + 1)
                .unwrap_or(0);
            Ok(FoldValue::Int(pos))
        }
        other => Err(format!("the {other:?} text function")),
    }
}

/// A short human name for an unsupported construct, for error messages.
fn construct_name(expr: &Expression) -> &'static str {
    match expr {
        Expression::Block { .. } => "VAR/RETURN block",
        Expression::ScalarFunc { .. } => "scalar math function",
        Expression::DateTimeFunc { .. } => "date/time function",
        Expression::InList { .. } => "IN list",
        Expression::LiteralDate(_) => "date literal",
        _ => "non-constant",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute::aggregate::AggregateOp;
    use crate::compute::parser::parse_measure_expression;

    fn fold_text_expr(src: &str) -> ConstFold {
        const_fold_scalar(&parse_measure_expression(src).unwrap())
    }

    #[test]
    fn folds_literal_format_composition() {
        assert_eq!(
            fold_text_expr("CONCATENATE(\"#,0\", \" K\")"),
            ConstFold::Value(FoldValue::Str("#,0 K".to_string()))
        );
        assert_eq!(
            fold_text_expr("IF(ISBLANK(BLANK()), \"0.0\", \"x\")"),
            ConstFold::Value(FoldValue::Str("0.0".to_string()))
        );
        assert_eq!(
            fold_text_expr("IF(CONTAINS(\"0.0%\", \"%\"), \"pct\", \"abs\")"),
            ConstFold::Value(FoldValue::Str("pct".to_string()))
        );
        // SQL NULL propagation: concatenating a BLANK yields BLANK.
        assert_eq!(
            fold_text_expr("CONCATENATE(BLANK(), \" K\")"),
            ConstFold::Value(FoldValue::Blank)
        );
    }

    #[test]
    fn folds_switch_and_comparisons() {
        assert_eq!(
            fold_text_expr("SWITCH(\"b\", \"a\", 1, \"b\", 2, 0)"),
            ConstFold::Value(FoldValue::Int(2))
        );
        assert_eq!(
            fold_text_expr("IF(2 > 1, \"yes\", \"no\")"),
            ConstFold::Value(FoldValue::Str("yes".to_string()))
        );
        // Comparisons against BLANK are false (SQL semantics).
        assert_eq!(
            fold_text_expr("IF(BLANK() = BLANK(), \"t\", \"f\")"),
            ConstFold::Value(FoldValue::Str("f".to_string()))
        );
    }

    #[test]
    fn data_references_are_not_constant() {
        let expr = crate::compute::expression::agg(
            AggregateOp::Sum,
            crate::compute::expression::qualified_col("Sales", "amount"),
        );
        assert_eq!(const_fold_scalar(&expr), ConstFold::NotConstant);
        assert_eq!(
            fold_text_expr("IF(HASONEVALUE(Scale[unit]), \"K\", \"\")"),
            ConstFold::NotConstant
        );
    }

    #[test]
    fn constant_but_exotic_is_unsupported() {
        let r = fold_text_expr("ABS(-1)");
        assert!(
            matches!(r, ConstFold::Unsupported(ref w) if w.contains("scalar math")),
            "got {r:?}"
        );
    }

    #[test]
    fn text_helpers_fold() {
        assert_eq!(
            fold_text_expr("LEFT(\"#,0.00\", 3)"),
            ConstFold::Value(FoldValue::Str("#,0".to_string()))
        );
        assert_eq!(
            fold_text_expr("SUBSTITUTE(\"0.0%\", \"%\", \"\")"),
            ConstFold::Value(FoldValue::Str("0.0".to_string()))
        );
        assert_eq!(
            fold_text_expr("FIND(\"%\", \"0.0%\")"),
            ConstFold::Value(FoldValue::Int(4))
        );
        assert_eq!(
            fold_text_expr("FIND(\"x\", \"0.0%\")"),
            ConstFold::Value(FoldValue::Int(0))
        );
    }
}
