//! FILENAME: core/engine/src/volatility.rs
//! PURPOSE: Names the VOLATILE built-in functions, and answers "does this stored
//!          AST call one".
//! CONTEXT: Excel recalculates a volatile function on EVERY worksheet change,
//! not only on a full pass (F9). That is the whole definition of the term, and
//! it is the reason the recalculation drivers need a way to ask this question:
//! the dependency graph cannot reach these cells, so unless something SEEDS
//! them they are only ever re-evaluated by an explicit full recalculation.
//!
//! WHAT WENT WRONG WITHOUT THIS. No Calcula built-in was volatile. A `=NOW()`
//! cell sat FROZEN while the user typed around it — and froze showing a
//! plausible timestamp, not an error, so nothing on screen said the number was
//! stale. Same for `=RAND()` in a Monte Carlo column and for an `=OFFSET(...)`
//! window whose base moved. A wrong number that looks authoritative is the
//! failure mode this module exists to close.
//!
//! WHICH FUNCTIONS, AND WHY — the two reasons are NOT the same reason:
//!
//! 1. THE RESULT IS NOT A FUNCTION OF ANY CELL. `NOW`, `TODAY`, `RAND`,
//!    `RANDBETWEEN`, `RANDARRAY`. Their inputs are the clock and the RNG, so
//!    there is no precedent cell to register an edge from, and no edit anywhere
//!    can ever dirty them. Seeding is the ONLY mechanism that can refresh them.
//!
//! 2. THE TARGET CANNOT BE TRACKED STATICALLY. `OFFSET` and `INDIRECT` DO read
//!    cells — but WHICH cells is computed at evaluation time, from an offset or
//!    from a text address, so `extract_dependencies` (which walks the AST) sees
//!    a call whose arguments are numbers or a string and registers an edge to
//!    the wrong cells or to none at all. `=INDIRECT("A"&B1)` depends on B1 and
//!    on whatever row B1 names; only the first is visible in the tree. Excel
//!    marks them volatile because the alternative is a formula that silently
//!    lags the cells it actually reads.
//!
//! `CELL` is a third shading of reason 2: it reports PROPERTIES of a reference
//! (its format, width, protection, address), and those are not cell values, so
//! no value-graph edge can carry a change in them. Excel marks it volatile;
//! so do we.
//!
//! `INFO` is on Excel's volatile list and on the glossary's, and is
//! DELIBERATELY ABSENT here: Calcula has no INFO built-in, so `=INFO("release")`
//! parses as [`BuiltinFunction::Custom`]. Matching `Custom` by name here would
//! be wrong in a way that is worse than the omission — `Custom` is also how a
//! call to a JavaScript UDF is spelled, and UDF volatility is the script
//! author's own declaration, carried separately as `udf_volatile_cells`
//! (`app/src-tauri/src/scripting/udf.rs`). Wiring INFO in belongs with
//! implementing INFO.
//!
//! KNOWN LIMIT — LAMBDA. A stored call to a named LAMBDA is an
//! `__INVOKE__(name, ...)` node whose BODY lives in the name table, not in this
//! cell's AST, so a LAMBDA that calls `NOW()` is not detected by this walker.
//! Excel propagates volatility through a LAMBDA; Calcula does not yet. Closing
//! that needs the name table at the call site, which this module deliberately
//! does not take — it is a pure predicate over one tree.

use crate::dependency_extractor::{BuiltinFunction, Expression};

/// Is this built-in VOLATILE — must it be recalculated on every worksheet
/// change rather than only on a full pass?
///
/// The list is closed and everything not on it is non-volatile, which is the
/// right way round: a built-in added tomorrow is NON-volatile by default and
/// opts in here by name. The reverse default would quietly make every new
/// function pay the per-edit cost.
pub fn is_volatile_builtin(func: &BuiltinFunction) -> bool {
    matches!(
        func,
        // Reason 1: the value is the clock or the RNG, not a cell.
        BuiltinFunction::Now
            | BuiltinFunction::Today
            | BuiltinFunction::Rand
            | BuiltinFunction::RandBetween
            | BuiltinFunction::RandArray
            // Reason 2: the cells actually read are decided at evaluation time.
            | BuiltinFunction::Offset
            | BuiltinFunction::Indirect
            // Reason 2': reports properties of a reference, which are not values.
            | BuiltinFunction::CellFn
    )
}

/// Does this expression contain a call to a volatile built-in, at any depth and
/// in any position?
///
/// Nesting is the point: `=ROUND(NOW(), 5)` and `=IF(A1, TODAY(), 0)` are as
/// volatile as a bare `=NOW()`, and a walker that only looked at the root would
/// leave exactly those frozen.
///
/// The match is EXHAUSTIVE — no `_` arm — on purpose. A new [`Expression`]
/// variant that can hold sub-expressions must be handled here, and the compiler
/// saying so is far better than the alternative, which is a formula nested
/// inside the new variant quietly losing its volatility.
pub fn contains_volatile_call(expr: &Expression) -> bool {
    match expr {
        Expression::FunctionCall { func, args, .. } => {
            is_volatile_builtin(func) || args.iter().any(contains_volatile_call)
        }

        Expression::BinaryOp { left, right, .. } => {
            contains_volatile_call(left) || contains_volatile_call(right)
        }
        Expression::UnaryOp { operand, .. } => contains_volatile_call(operand),

        Expression::IndexAccess { target, index } => {
            contains_volatile_call(target) || contains_volatile_call(index)
        }
        Expression::ArrayLiteral { rows } => rows.iter().flatten().any(contains_volatile_call),
        Expression::ListLiteral { elements } => elements.iter().any(contains_volatile_call),
        Expression::DictLiteral { entries } => entries
            .iter()
            .any(|(k, v)| contains_volatile_call(k) || contains_volatile_call(v)),

        Expression::Sheet3DRef { reference, .. } => contains_volatile_call(reference),
        Expression::SpillRef { cell, .. } => contains_volatile_call(cell),
        Expression::ImplicitIntersection { operand } => contains_volatile_call(operand),

        // Leaves for this question. `Range` does hold two boxed expressions,
        // but they are the endpoints of a reference — the parser builds them
        // from `CellRef` and nothing else, and a range whose bounds are
        // COMPUTED is spelled as a call to OFFSET or INDIRECT, which is caught
        // above. A `NamedRef`'s definition lives in the name table, not here
        // (see the LAMBDA limit in the module header).
        Expression::Literal(_)
        | Expression::CellRef { .. }
        | Expression::Range { .. }
        | Expression::ColumnRef { .. }
        | Expression::RowRef { .. }
        | Expression::NamedRef { .. }
        | Expression::TableRef { .. } => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dependency_extractor::Value;

    fn parse(formula: &str) -> Expression {
        parser::parse(formula).unwrap_or_else(|e| panic!("{} did not parse: {:?}", formula, e))
    }

    fn volatile(formula: &str) -> bool {
        contains_volatile_call(&parse(formula))
    }

    #[test]
    fn the_predicate_names_exactly_excels_volatile_builtins() {
        for f in [
            BuiltinFunction::Now,
            BuiltinFunction::Today,
            BuiltinFunction::Rand,
            BuiltinFunction::RandBetween,
            BuiltinFunction::RandArray,
            BuiltinFunction::Offset,
            BuiltinFunction::Indirect,
            BuiltinFunction::CellFn,
        ] {
            assert!(is_volatile_builtin(&f), "{:?} must be volatile", f);
        }
        for f in [
            BuiltinFunction::Sum,
            BuiltinFunction::If,
            BuiltinFunction::Index,
            BuiltinFunction::Match,
            BuiltinFunction::Date,
            BuiltinFunction::Subtotal,
            BuiltinFunction::Aggregate,
            BuiltinFunction::Address,
            BuiltinFunction::FormulaText,
            BuiltinFunction::Sheet,
        ] {
            assert!(!is_volatile_builtin(&f), "{:?} must NOT be volatile", f);
        }
    }

    #[test]
    fn a_bare_volatile_call_is_volatile() {
        assert!(volatile("=NOW()"));
        assert!(volatile("=TODAY()"));
        assert!(volatile("=RAND()"));
        assert!(volatile("=RANDBETWEEN(1,10)"));
        assert!(volatile("=RANDARRAY(2,2)"));
        assert!(volatile("=OFFSET(A1,1,1)"));
        assert!(volatile(r#"=INDIRECT("A1")"#));
        assert!(volatile(r#"=CELL("width",A1)"#));
    }

    #[test]
    fn an_ordinary_formula_is_not_volatile() {
        assert!(!volatile("=SUM(A1:A10)"));
        assert!(!volatile("=A1+B1*2"));
        assert!(!volatile("=IF(A1>0,\"yes\",\"no\")"));
        // Near-misses that share a prefix or a family with a volatile name.
        assert!(!volatile("=DATE(2026,8,23)"));
        assert!(!volatile("=INDEX(A1:B9,2,1)"));
        assert!(!volatile("=ADDRESS(1,1)"));
        assert!(!volatile("=SUBTOTAL(109,A1:A9)"));
    }

    #[test]
    fn a_volatile_call_nested_at_any_depth_is_found() {
        // This is the case a root-only check would miss, and missing it leaves a
        // FROZEN NUMBER on screen rather than an error.
        assert!(volatile("=ROUND(NOW(),5)"));
        assert!(volatile("=IF(A1>0,TODAY(),0)"));
        assert!(volatile("=SUM(1,IF(A1,MAX(2,RAND())))"));
        assert!(volatile("=A1+RAND()"));
        assert!(volatile("=-RAND()"));
        assert!(volatile(r#"=SUM(INDIRECT("A1:A9"))"#));
    }

    #[test]
    fn the_literal_containers_are_walked_not_skipped() {
        // ArrayLiteral: Excel allows only literals here, but Calcula's parser
        // accepts any expression — the same reason extract_dependencies walks it.
        assert!(volatile("={1,RAND()}"));
        assert!(volatile(r#"={"k": RAND()}"#));
        assert!(volatile("=COLLECT(1,NOW())"));
        // ...and the same shapes stay NON-volatile when nothing volatile is in them.
        assert!(!volatile("={1,2}"));
        assert!(!volatile(r#"={"k": A1}"#));
        assert!(!volatile("=COLLECT(1,2)"));
    }

    #[test]
    fn the_wrapper_variants_are_walked_not_skipped() {
        // These four wrap a sub-expression that the parser will not put a call
        // inside from ordinary formula text (a `#` follows a reference, `@`
        // precedes one, and a populated ListLiteral is only ever rebuilt from a
        // stored cell), so they are built here directly. They still have to
        // recurse: a stored AST can hold any of them, and an unwalked wrapper
        // would hide the call rather than report it.
        let now = || Expression::FunctionCall {
            func: BuiltinFunction::Now,
            args: vec![],
            ref_site_id: Default::default(),
        };
        let a1 = || Expression::CellRef {
            sheet: None,
            col: "A".to_string(),
            row: 1,
            col_absolute: false,
            row_absolute: false,
            ref_site_id: Default::default(),
        };

        assert!(contains_volatile_call(&Expression::ListLiteral {
            elements: vec![Expression::Literal(Value::Number(1.0)), now()],
        }));
        assert!(contains_volatile_call(&Expression::SpillRef {
            cell: Box::new(now()),
            ref_site_id: Default::default(),
        }));
        assert!(contains_volatile_call(&Expression::ImplicitIntersection {
            operand: Box::new(now()),
        }));
        assert!(contains_volatile_call(&Expression::IndexAccess {
            target: Box::new(now()),
            index: Box::new(Expression::Literal(Value::Number(0.0))),
        }));
        assert!(contains_volatile_call(&Expression::Sheet3DRef {
            start_sheet: "Jan".to_string(),
            end_sheet: "Dec".to_string(),
            reference: Box::new(now()),
            ref_site_id: Default::default(),
        }));

        // Negative controls: the same wrappers around a plain reference.
        assert!(!contains_volatile_call(&Expression::ListLiteral {
            elements: vec![a1()],
        }));
        assert!(!contains_volatile_call(&Expression::SpillRef {
            cell: Box::new(a1()),
            ref_site_id: Default::default(),
        }));
        assert!(!contains_volatile_call(&Expression::ImplicitIntersection {
            operand: Box::new(a1()),
        }));
    }

    #[test]
    fn a_custom_function_name_is_never_volatile_here() {
        // INFO is on Excel's volatile list but is not a Calcula built-in, so it
        // parses as Custom("INFO"). Custom is ALSO how a JavaScript UDF call is
        // spelled, and a UDF's volatility is its author's declaration
        // (udf_volatile_cells), never a name match. Matching Custom here would
        // make every UDF whose name happened to be INFO volatile and would still
        // not implement INFO.
        let ast = parse(r#"=INFO("release")"#);
        assert!(matches!(
            &ast,
            Expression::FunctionCall { func: BuiltinFunction::Custom(name), .. }
                if name.as_str() == "INFO"
        ));
        assert!(!contains_volatile_call(&ast));
        assert!(!volatile("=MYUDF(A1)"));
    }
}
